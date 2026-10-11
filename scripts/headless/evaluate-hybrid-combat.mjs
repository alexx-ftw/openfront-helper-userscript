// Collect: node scripts/headless/evaluate-hybrid-combat.mjs --collect --seeds train-01,train-02 --timeout-ms 60000
// Holdout: node scripts/headless/evaluate-hybrid-combat.mjs --model /path/trained-model.json --seeds holdout-01,holdout-02 --timeout-ms 60000
// OFH_* match settings are shared by every mode. Tick caps are censored, never losses.
import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { foreignGitEnvironment } from "../git-environment.mjs";
import {
  canonical,
  digest as hash,
  resolveCohorts,
  matchesCohort,
  pairedUncertainty,
  summarizeTelemetry,
  summarizeDecisionRows,
  validateTransitions,
  assessCandidatePromotion,
  selectReplayGroup,
  fingerprintSources,
} from "./hybrid-evaluation-contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modes = ["baseline", "shadow", "learned"];
export const format = "ofh-hybrid-combat-evaluation-v2";
const extendedKeys = [
  "harnessHash",
  "evaluationContractHash",
  "featureHash",
  "modelHash",
  "normalizerHash",
  "rewardHash",
  "configurationHash",
];
const jsonValue = (value, key) =>
  value && typeof value.toJSON === "function" ? value.toJSON(key) : value;

function jsonEntries(value, array) {
  const entries = array ? Array.from(value, (item, index) => [index, item]) : Object.entries(value);
  return entries
    .map(([key, item]) => [key, jsonValue(item, String(key))])
    .filter(([, item]) => array || !["undefined", "function", "symbol"].includes(typeof item));
}

function* jsonChunks(value, depth = 0, ancestors = new Set()) {
  if (depth === 0) value = jsonValue(value, "");
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value) ?? "null";
    return;
  }
  assert.ok(!ancestors.has(value), "Circular JSON value");
  ancestors.add(value);
  const array = Array.isArray(value);
  const entries = jsonEntries(value, array);
  yield array ? "[" : "{";
  for (const [index, [key, item]] of entries.entries()) {
    yield `${index ? "," : ""}\n${"  ".repeat(depth + 1)}`;
    if (!array) yield `${JSON.stringify(key)}: `;
    yield* jsonChunks(item, depth + 1, ancestors);
  }
  if (entries.length) yield `\n${"  ".repeat(depth)}`;
  yield array ? "]" : "}";
  ancestors.delete(value);
}

export function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    let pending = "";
    for (const chunk of jsonChunks(value)) {
      pending += chunk;
      if (pending.length >= 64 * 1024) {
        fs.writeFileSync(descriptor, pending);
        pending = "";
      }
    }
    fs.writeFileSync(descriptor, `${pending}\n`);
    fs.fsyncSync(descriptor);
    // Exclusive publication preserves the existing save contract without exposing partial JSON.
    fs.linkSync(temporary, file);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(temporary);
  }
}

export function validateProvenance(saved, current, strict = false) {
  const keys = [
    "bundleHash",
    "sourceHash",
    "engineRevision",
    "engineDiffHash",
    ...(strict ? extendedKeys : []),
  ];
  for (const key of keys) {
    assert.ok(
      typeof saved[key] === "string" && typeof current[key] === "string",
      `Missing model provenance: ${key}`,
    );
    assert.equal(saved[key], current[key], `Model provenance mismatch: ${key}`);
  }
}

export function parseArgs(argv) {
  const options = { collect: false, policy: "ridge" };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (["--collect", "--anchors", "--frozen-replay"].includes(name))
      options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
    else if (
      [
        "--seeds",
        "--model",
        "--out",
        "--timeout-ms",
        "--policy",
        "--feature-profile",
        "--cohorts",
        "--requirements",
        "--replay",
        "--selection",
        "--potential-shaping",
      ].includes(name)
    ) {
      assert.ok(argv[i + 1] && !argv[i + 1].startsWith("--"), `Missing value for ${name}`);
      options[name.slice(2)] = argv[++i];
    } else throw new Error(`Unknown argument ${name}`);
  }
  options.seeds = (options.seeds ?? "").split(",").map((seed) => seed.trim());
  assert.ok(options.seeds.every(Boolean), "--seeds is required");
  assert.equal(new Set(options.seeds).size, options.seeds.length, "Seeds must be unique");
  options.timeoutMs = Number(options["timeout-ms"]);
  assert.ok(
    Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0,
    "--timeout-ms must be a positive integer",
  );
  assert.ok(options.collect || options.model, "--model is required for frozen holdout evaluation");
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  options.policy ??= "ridge";
  assert.ok(["ridge", "compact-neural"].includes(options.policy), "Unsupported selected policy");
  if (options["feature-profile"] !== undefined) {
    assert.equal(options["feature-profile"], "frontier-v1", "Unsupported feature profile");
    assert.equal(options.policy, "compact-neural", "Feature profile requires compact-neural");
  }
  assert.ok(!options.frozenReplay || options.collect, "--frozen-replay requires --collect");
  assert.ok(
    !options.replay ||
      (options.collect && options.selection && options.policy === "compact-neural"),
    "Offline replay requires --collect, --selection and --policy compact-neural",
  );
  assert.ok(!options.anchors || options.replay, "--anchors requires explicit offline replay");
  assert.ok(
    !options["potential-shaping"] || options.replay,
    "Potential shaping requires explicit offline replay",
  );
}

function executeTrustedScript(source, sandbox) {
  // Trusted repository classic scripts only; seed names and model JSON remain data.
  // eslint-disable-next-line sonarjs/code-eval
  return vm.runInNewContext(source, sandbox, { timeout: 1000 });
}

export function validateSeedIdentities(seeds, trainingSeeds) {
  const source = fs.readFileSync(
    path.join(projectRoot, "engine/ingame/auto-bot/portutil.js"),
    "utf8",
  );
  // Observe the actual house constructor's normalized initial state, rather than
  // duplicating its zero-to-one normalization or comparing hashes alone.
  const seam = "this._next01 = function () {";
  assert.equal(source.split(seam).length, 2, "House PRNG state observation seam changed");
  const observedSource = source.replace(seam, "this.seedIdentity = s;\n" + seam);
  const values = Array.from(
    executeTrustedScript(
      observedSource + "\nseeds.map(seed => new PseudoRandom(simpleHash(seed)).seedIdentity);",
      {
        seeds: [...trainingSeeds, ...seeds],
      },
    ),
  );
  const trainingValues = new Set(values.slice(0, trainingSeeds.length));
  const requestedValues = values.slice(trainingSeeds.length);
  assert.equal(
    trainingValues.size,
    trainingSeeds.length,
    "Training seeds must be unique in effective engine PRNG values",
  );
  assert.equal(
    new Set(requestedValues).size,
    seeds.length,
    "Seeds must be unique in effective engine PRNG values",
  );
  assert.ok(
    requestedValues.every((value) => !trainingValues.has(value)),
    "Requested seeds overlap training seeds in effective engine PRNG values",
  );
}

function nativeApi(source) {
  const window = {};
  executeTrustedScript(source, {
    window,
    console,
    performance,
    state: { settings: { winFixes: true } },
  });
  const api = window.__OFH_hybridCombat;
  assert.ok(api?.importModel && api?.diagnostics, "Native hybrid combat API unavailable");
  return api;
}

export function validateModel(model, source, requireReady = true) {
  const api = nativeApi(source);
  assert.notEqual(api.importModel(model), false, "Unsupported native model snapshot");
  api.configure({ mode: "learned", learning: false });
  const diagnostics = api.diagnostics();
  assert.ok(
    !requireReady || diagnostics.ready === true || diagnostics.modelReady === true,
    "Cold or unsupported snapshot: native diagnostics must report ready/modelReady=true",
  );
  return api.exportModel();
}

export function houseIntentBudgetOracle(events) {
  const source = fs.readFileSync(
    path.join(projectRoot, "engine/ingame/intent-rate-limit.js"),
    "utf8",
  );
  let now = 0;
  const api = executeTrustedScript(
    source + "\n({ acquire: tryAcquireIntentRateLimit, snapshot: getIntentRateLimitSnapshot });",
    { Date: { now: () => now } },
  );
  const results = events.map((event) => {
    assert.ok(
      Number.isFinite(event.atMs) && event.atMs >= now,
      "Rate oracle arrival times must be ordered",
    );
    now = event.atMs;
    return { ...event, accepted: api.acquire(event.type ?? "intent") };
  });
  return {
    results,
    snapshot: api.snapshot(),
    scope: "house-client-intent-gate",
    serverReceiptClaim: false,
  };
}

export function readRecords(text) {
  const records = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"phase":"')) continue;
    const record = JSON.parse(trimmed);
    if (record.phase === "start" || record.phase === "result") {
      assert.equal(records[record.phase], undefined, `Duplicate ${record.phase} record`);
      records[record.phase] = record;
    }
  }
  return records;
}

function runFailed(run) {
  return Boolean(
    run.error || run.signal || run.timedOut || ![0, 2].includes(run.code) || !run.result,
  );
}

function policyConfigurationMatches(hybrid, mode, learning) {
  if (!hybrid?.diagnostics) return false;
  return (
    hybrid.mode === mode &&
    hybrid.learning === learning &&
    hybrid.diagnostics.mode === mode &&
    hybrid.diagnostics.learning === learning
  );
}

function frozenModelMatches(hybrid, mode, modelHash) {
  if (!policyConfigurationMatches(hybrid, mode, false)) return false;
  return (
    hybrid.model != null &&
    hybrid.modelImported === true &&
    hybrid.diagnostics.ready === true &&
    hash(canonical(hybrid.model)) === modelHash
  );
}

function terminalResult(result) {
  if (!result) return false;
  if (result.stopReason === "winner")
    return result.winner != null && typeof result.won === "boolean";
  return result.stopReason === "bot_dead" && result.alive === false && result.won === false;
}

function verifiedRun(run, seed, configMatches, modelHash) {
  if (runFailed(run) || !configMatches || run.provenanceMatches === false) return false;
  return (
    run.result.seed === seed &&
    run.result.intentBudgetViolated !== true &&
    frozenModelMatches(run.result.hybridCombat, run.mode, modelHash)
  );
}

function runTelemetry(run, cell) {
  const rows = run.result?.hybridEvaluation?.decisionRows;
  if (rows !== undefined) {
    const runID = run.launch?.runID;
    assert.ok(
      typeof runID === "string" &&
        runID.trim() &&
        Array.isArray(rows) &&
        rows.every((row) => row?.runIdentity === runID),
      "Decision rows do not match the launch run identity",
    );
  }
  return summarizeTelemetry(run.result ?? {}, cell);
}

function runOutcome(run, seed, configMatches, modelHash) {
  const result = run.result ?? {};
  const verified = verifiedRun(run, seed, configMatches, modelHash);
  const completed = verified && terminalResult(result);
  return {
    verified,
    completed,
    won: completed ? result.won : null,
    stopReason: result.stopReason ?? null,
    ticks: result.ticks ?? null,
    tiles: result.finalBotState?.tiles ?? null,
    runtimeMs: result.runtimeMs ?? null,
    emittedIntents: result.emittedIntents ?? null,
    diagnostics: result.hybridCombat?.diagnostics ?? null,
    telemetry: runTelemetry(run),
    code: run.code,
    timedOut: run.timedOut ?? false,
    error: run.error ?? null,
    signal: run.signal ?? null,
    logPath: run.logPath,
  };
}

export function scorePairedRuns(runs, seeds, modelHash, cohortDeclaration) {
  const cohorts = resolveCohorts(cohortDeclaration, seeds);
  const pairs = seeds.map((seed) => {
    const selected = modes.map((mode) => {
      const entries = runs.filter((run) => run.seed === seed && run.mode === mode);
      assert.equal(entries.length, 1, `Expected one ${mode} run for ${seed}`);
      return entries[0];
    });
    const configuration = selected[0].start;
    const cell = cohorts.cells.find((entry) => entry.seeds.includes(seed));
    const configMatches =
      Boolean(configuration?.engineFingerprint && configuration?.mapFingerprint) &&
      matchesCohort(configuration, cell) &&
      selected.every((run) => canonical(run.start) === canonical(configuration));
    const outcomes = Object.fromEntries(
      selected.map((run) => [run.mode, runOutcome(run, seed, configMatches, modelHash)]),
    );
    for (const run of selected) outcomes[run.mode].telemetry = runTelemetry(run, cell);
    return { seed, cell: cell.name, configMatches, configuration, outcomes };
  });
  const completedPairs = pairs.filter((pair) =>
    modes.every((mode) => pair.outcomes[mode].completed),
  );
  const summary = Object.fromEntries(
    modes.map((mode) => {
      const outcomes = completedPairs.map((pair) => pair.outcomes[mode]);
      const wins = outcomes.filter((outcome) => outcome.won).length;
      const average = (field) =>
        outcomes.length && outcomes.every((outcome) => Number.isFinite(outcome[field]))
          ? outcomes.reduce((sum, outcome) => sum + outcome[field], 0) / outcomes.length
          : null;
      return [
        mode,
        {
          wins,
          winRate: outcomes.length ? wins / outcomes.length : null,
          averageTicks: average("ticks"),
          averageTiles: average("tiles"),
          averageRuntimeMs: average("runtimeMs"),
          averageEmittedIntents: average("emittedIntents"),
        },
      ];
    }),
  );
  return {
    requestedPairs: seeds.length,
    modelHash,
    counts: {
      success: pairs
        .flatMap((pair) => Object.values(pair.outcomes))
        .filter((outcome) => outcome.completed).length,
      errors: runs.filter(runFailed).length,
      horizonExclusions: runs.filter((run) => run.result?.stopReason === "max_ticks").length,
      unverified: pairs
        .flatMap((pair) => Object.values(pair.outcomes))
        .filter((outcome) => !outcome.verified).length,
    },
    completedPairs: completedPairs.length,
    candidateDecisionPairs: completedPairs.filter(
      (pair) =>
        pair.outcomes.shadow.diagnostics.decisions > 0 &&
        pair.outcomes.learned.diagnostics.decisions > 0,
    ).length,
    excludedPairs: seeds.length - completedPairs.length,
    summary,
    uncertainty: uncertaintyFor(completedPairs, cohorts.uncertainty),
    coverage: cohortCoverage(cohorts, pairs),
    frozenVerified: runs.every((run) => run.frozenVerified === true),
    learnedMinusBaselineWins: completedPairs.length
      ? summary.learned.wins - summary.baseline.wins
      : null,
    pairs,
    evidence:
      "Real-engine headless holdout only. Win rates use terminal, verified, fully paired outcomes; tick caps, failures and mode/model mismatches are excluded. Candidate decision pairs count diagnostics.decisions in shadow and learned, not accepted orders or learned control. Diagnostics and raw logs show inference/fallback activity. No external model integration, live-browser performance, or statistical superiority is established.",
  };
}

function uncertaintyFor(pairs, options) {
  return pairedUncertainty(
    pairs.map((pair) => ({
      baselineWin: pair.outcomes.baseline.won,
      learnedWin: pair.outcomes.learned.won,
    })),
    options,
  );
}

function cohortCoverage(cohorts, pairs) {
  return {
    declared: cohorts.declared,
    cells: cohorts.cells.map((cell) => {
      const selected = pairs.filter((pair) => cell.seeds.includes(pair.seed));
      const completed = selected.filter((pair) =>
        modes.every((mode) => pair.outcomes[mode].completed),
      );
      return {
        name: cell.name,
        expected: cell.expected,
        seeds: cell.seeds,
        requested: selected.length,
        completed: completed.length,
        excluded: selected.length - completed.length,
        errors: selected
          .flatMap((pair) => Object.values(pair.outcomes))
          .filter((outcome) => outcome.error || ![0, 2].includes(outcome.code)).length,
        horizons: selected
          .flatMap((pair) => Object.values(pair.outcomes))
          .filter((outcome) => outcome.stopReason === "max_ticks").length,
        uncertainty: uncertaintyFor(completed, cohorts.uncertainty),
        telemetry: selected.map((pair) => pair.outcomes.learned.telemetry),
      };
    }),
  };
}

// Bound unique encoded payload and individual lines; repeated exact identities are interned.
export const nativeEventLimit = 256 * 1024 * 1024;

function* nativeLines(descriptor, size) {
  const buffer = Buffer.alloc(64 * 1024);
  let parts = [];
  let lineBytes = 0;
  let bytes = 0;
  let count;
  while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
    bytes += count;
    assert.ok(bytes <= size, "Native event file drift");
    let start = 0;
    while (start < count) {
      const newline = buffer.indexOf(10, start);
      const end = newline >= 0 && newline < count ? newline + 1 : count;
      const part = Buffer.from(buffer.subarray(start, end));
      parts.push(part);
      lineBytes += part.length;
      assert.ok(lineBytes <= nativeEventLimit, "Native event line exceeds bounded reader");
      if (end <= count && buffer[end - 1] === 10) {
        yield Buffer.concat(parts, lineBytes);
        parts = [];
        lineBytes = 0;
      }
      start = end;
    }
  }
  assert.equal(lineBytes, 0, "Incomplete native event line");
  assert.equal(bytes, size, "Native event file drift");
}

function readNativeEvents(file, outDir, evidence) {
  assert.equal(fs.realpathSync(outDir), path.dirname(file), "Native event path escape");
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink(), "Native event symlink/type");
  const incremental = evidence.ledger.incrementalFile;
  const transitionCount =
    incremental.transitionEvents ?? evidence.transitionRows.length + evidence.dropped.transitions;
  assert.ok(
    Number.isSafeInteger(incremental.policyEvents) &&
      incremental.policyEvents >= 0 &&
      Number.isSafeInteger(transitionCount) &&
      transitionCount >= 0 &&
      Number.isSafeInteger(incremental.policyEvents + transitionCount),
    "Native event count missing",
  );
  const rowLimit = incremental.policyEvents + transitionCount;
  const identities = new Map();
  let duplicateBytes = 0;
  let decodedBytes = 0;
  const intern = (key, value) => {
    if (key !== "modelIdentity" || typeof value !== "string") return value;
    if (!identities.has(value)) {
      identities.set(value, value);
      return value;
    }
    // Credit only canonical escaped content bytes, never keys, quotes, padding or other fields.
    duplicateBytes += Buffer.byteLength(JSON.stringify(value)) - 2;
    return identities.get(value);
  };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const rows = [];
  try {
    const opened = fs.fstatSync(fd);
    assert.equal(opened.ino, before.ino, "Native event file drift");
    assert.equal(opened.dev, before.dev, "Native event file drift");
    for (const line of nativeLines(fd, before.size)) {
      assert.ok(isUtf8(line), "Invalid native event UTF-8");
      assert.ok(rows.length < rowLimit, "Native event count exceeds declared coverage");
      rows.push(JSON.parse(line.toString("utf8"), intern));
      decodedBytes += line.length;
      assert.ok(
        decodedBytes - duplicateBytes <= nativeEventLimit,
        "Native unique event payload exceeds bounded reader",
      );
    }
    assert.equal(rows.length, rowLimit, "Native event count differs from declared coverage");
    for (const after of [fs.fstatSync(fd), fs.lstatSync(file)])
      for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
        assert.equal(after[key], before[key], "Native event file drift");
  } finally {
    fs.closeSync(fd);
  }
  return rows;
}

function validateNativeIdentities(entries) {
  const identities = new Set();
  for (const row of entries.filter((item) =>
    ["hybrid-combat-decision", "hybrid-combat-outcome"].includes(item.kind),
  )) {
    assert.ok(
      [row.episodeId, row.generation, row.step].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ),
      "Invalid native event identity",
    );
    const key = canonical([row.kind, row.episodeId, row.generation, row.step]);
    assert.ok(!identities.has(key), "Duplicate/conflicting native event identity");
    identities.add(key);
  }
}

function validateNativeSafety(safetyRows, evidence) {
  const safety = {
    reserveChecks: 0,
    reserveViolations: 0,
    legalityChecks: 0,
    illegalEmissions: 0,
  };
  const coverage = { knownAttempts: 0, unknownAttempts: 0, emissionsWithoutChecks: 0 };
  for (const [field, check, failure] of [
    ["reservePassed", "reserveChecks", "reserveViolations"],
    ["legalityPassed", "legalityChecks", "illegalEmissions"],
  ]) {
    const checked = safetyRows.filter((row) => typeof row[field] === "boolean");
    safety[check] = checked.length;
    safety[failure] = checked.filter(
      (row) => !row[field] && (field === "reservePassed" || row.emitted),
    ).length;
  }
  const knownSafety = (row) =>
    typeof row.reservePassed === "boolean" && typeof row.legalityPassed === "boolean";
  const known = safetyRows.filter(knownSafety);
  coverage.knownAttempts = known.length;
  coverage.unknownAttempts = safetyRows.length - known.length;
  coverage.emissionsWithoutChecks = safetyRows.filter(
    (row) => row.emitted && !knownSafety(row),
  ).length;
  assert.equal(
    canonical(safety),
    canonical(evidence.safety),
    "Native safety counters missing/mismatch",
  );
  assert.equal(
    canonical(coverage),
    canonical(evidence.coverage),
    "Native coverage counters missing/mismatch",
  );
}

function validateNativeTransitionRows(transitions, outcomes, runID) {
  assert.equal(transitions.length, outcomes.length, "Native transition count mismatch");
  validateTransitions(
    transitions.map((row) => ({ ...row, episodeId: canonical([row.episodeId, row.generation]) })),
  );
  for (const [index, row] of transitions.entries()) {
    const event = outcomes[index];
    const expected = {
      runIdentity: runID,
      episodeId: event.episodeId,
      generation: event.generation,
      step: event.step,
      tick: event.actionTick,
      nextTick: event.outcomeTick,
      first: event.step === 0,
      terminated: event.terminal === true,
      truncated: event.truncated === true,
      envError: event.envError === true,
      reason: event.reason ?? null,
      potentialID: "observed-own-land-share-v1",
      potentialSource: "policy-gate-ownLandShare",
      potential: event.gate?.[2] ?? null,
      nextPotential: event.nextGate?.[2] ?? null,
      baseReward: event.reward,
      confirmed: event.confirmed === true,
      kind: "hybrid-transition",
    };
    assert.equal(canonical(row), canonical(expected), "Native transition content mismatch");
  }
}

function validateNativeRetention(
  evidence,
  { entries, decisions, latency, safetyRows, transitions },
) {
  for (const [key, values, retained] of [
    ["entries", entries, evidence.entries],
    ["decisionRows", decisions, evidence.retainedDecisionRows],
    ["latencyMs", latency, evidence.retainedLatencyMs],
    ["safetyRows", safetyRows.map(({ kind: _kind, ...row }) => row), evidence.safetyRows],
    ["transitions", transitions.map(({ kind: _kind, ...row }) => row), evidence.transitionRows],
  ]) {
    assert.ok(
      Number.isSafeInteger(evidence.dropped?.[key]) && evidence.dropped[key] >= 0,
      "Native retention counters missing",
    );
    assert.ok(Array.isArray(retained), "Native retained rows missing");
    assert.equal(
      values.length,
      retained.length + evidence.dropped[key],
      "Native retention count mismatch",
    );
    for (const [index, row] of retained.entries())
      assert.equal(
        canonical(row),
        canonical(values[values.length - retained.length + index]),
        "Native retained content mismatch",
      );
  }
  assert.equal(
    evidence.ledger.dropped,
    evidence.dropped.entries,
    "Native ledger retention mismatch",
  );
  assert.equal(
    evidence.ledger.entries.length,
    evidence.entries.length,
    "Native ledger retained content mismatch",
  );
  for (const [index, row] of evidence.entries.entries())
    assert.equal(
      canonical(row),
      canonical(evidence.ledger.entries[index]),
      "Native ledger retained content mismatch",
    );
}

export function validateNativeEvidence(run, file, outDir, runID) {
  const evidence = run.result.hybridEvaluation;
  assert.equal(run.result.seed, run.seed, "Native result seed mismatch");
  assert.ok(
    terminalResult(run.result) || run.result.stopReason === "max_ticks",
    "Native run closure is not a completed/censored game",
  );
  assert.equal(evidence.eventFile, file, "Native event path mismatch");
  const incremental = evidence.ledger?.incrementalFile;
  assert.equal(incremental?.path, file, "Native incremental path mismatch");
  assert.equal(incremental.fullDataset, true, "Native incremental coverage unknown");
  const rows = readNativeEvents(file, outDir, evidence);
  assert.ok(
    rows.every((row) => row.runIdentity === runID),
    "Native event run identity mismatch",
  );
  const entries = rows.filter((row) => row.kind !== "hybrid-transition");
  assert.equal(entries.length, incremental.policyEvents, "Native policy event count mismatch");
  const closure = entries.at(-1);
  assert.equal(closure?.kind, "hybrid-episode-close", "Native final closure missing");
  assert.equal(canonical(closure), canonical(evidence.latestClosure), "Native closure mismatch");
  assert.equal(closure.reason, run.result.stopReason, "Native closure reason mismatch");
  assert.equal(closure.terminated, terminalResult(run.result), "Native closure terminal mismatch");
  assert.equal(
    closure.truncated,
    !closure.terminated && closure.reason !== "env_error",
    "Native closure truncation mismatch",
  );
  assert.equal(closure.envError, closure.reason === "env_error", "Native closure error mismatch");
  const decisions = entries.filter((row) => row.kind === "hybrid-combat-decision");
  const latency = entries
    .filter((row) => row.kind === "hybrid-latency")
    .map((row) => row.durationMs);
  assert.ok(
    latency.every((value) => Number.isFinite(value) && value >= 0),
    "Invalid native latency",
  );
  validateNativeIdentities(entries);
  summarizeDecisionRows(decisions);
  const safetyRows = entries.filter((row) => row.kind === "hybrid-safety");
  validateNativeSafety(safetyRows, evidence);
  const transitions = rows.filter((row) => row.kind === "hybrid-transition");
  const outcomes = entries.filter((row) => row.kind === "hybrid-combat-outcome");
  validateNativeTransitionRows(transitions, outcomes, runID);
  const lastGroup = transitions.at(-1);
  const currentTransitions = transitions.filter(
    (row) => row.episodeId === lastGroup?.episodeId && row.generation === lastGroup?.generation,
  );
  validateNativeRetention(evidence, { entries, decisions, latency, safetyRows, transitions });
  return {
    decisionRows: decisions,
    latencyMs: latency,
    latencyScope: "hybrid-decision-wall-ms",
    transitions:
      currentTransitions.length === transitions.length
        ? currentTransitions.map(({ kind: _kind, ...row }) => row)
        : undefined,
    decisionCoverage: { available: true, dropped: 0 },
    latencyCoverage: { available: true, dropped: 0 },
    transitionCoverage: {
      available: currentTransitions.length === transitions.length,
      dropped: transitions.length - currentTransitions.length,
    },
    ledger: { ...evidence.ledger, entries, fullDataset: true, dropped: 0 },
    replay: { records: outcomes, fullDataset: true, dropped: 0 },
  };
}

function invalidateNativeEvidence(evidence) {
  if (evidence.ledger) {
    evidence.ledger.fullDataset = false;
    if (evidence.ledger.incrementalFile) evidence.ledger.incrementalFile.fullDataset = false;
  }
  if (evidence.replay) evidence.replay.fullDataset = false;
  delete evidence.decisionRows;
  delete evidence.latencyMs;
  delete evidence.transitions;
}

function restoreNativeEvidence(run, file, outDir, runID) {
  const evidence = run.result?.hybridEvaluation;
  if (!evidence) return;
  if (runFailed(run) || run.interrupted) {
    invalidateNativeEvidence(evidence);
    return;
  }
  try {
    Object.assign(evidence, validateNativeEvidence(run, file, outDir, runID));
    // Untrusted native files remain reportable failures, never complete evidence.
    // eslint-disable-next-line no-restricted-syntax
  } catch (error) {
    run.nativeEventError = error.message;
    invalidateNativeEvidence(evidence);
  }
}

export function runMatch({
  seed,
  mode,
  learning,
  modelPath,
  bundlePath,
  outDir,
  timeoutMs,
  environment,
  runID,
  experimentID,
  spawnProcess = spawn,
}) {
  assert.ok(typeof runID === "string" && runID.trim(), "Native launch run identity required");
  outDir = fs.realpathSync(outDir);
  const launchName = `${hash(runID).slice(0, 16)}-${randomUUID()}`;
  const eventPath = path.join(outDir, `${launchName}.events.jsonl`);
  const logPath = path.join(outDir, `${launchName}.log`);
  const descriptor = fs.openSync(logPath, "wx");
  return new Promise((resolve) => {
    const child = spawnProcess(
      path.join(projectRoot, "node_modules/.bin/tsx"),
      [
        "--tsconfig",
        path.join(projectRoot, "openfront-engine/tsconfig.json"),
        path.join(projectRoot, "scripts/headless/run-match.mts"),
      ],
      {
        cwd: projectRoot,
        env: {
          ...environment,
          GAME_ENV: "dev",
          OFH_BUNDLE_PATH: bundlePath,
          OFH_MATCH_SEED: seed,
          OFH_HYBRID_COMBAT_MODE: mode,
          OFH_HYBRID_COMBAT_LEARNING: learning ? "1" : "0",
          OFH_HYBRID_COMBAT_MODEL: modelPath ?? "",
          OFH_HYBRID_RUN_ID: runID,
          OFH_HYBRID_EVENT_LOG: eventPath,
          OFH_HYBRID_EXPERIMENT_ID: experimentID,
        },
        stdio: ["ignore", descriptor, descriptor],
      },
    );
    let timedOut = false;
    let interrupted = false;
    let error;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const interrupt = () => {
      interrupted = true;
      child.kill("SIGKILL");
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.once("error", (failure) => {
      error = failure.message;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      fs.closeSync(descriptor);
      let records;
      try {
        records = readRecords(fs.readFileSync(logPath, "utf8"));
        // Preserve malformed child output as a failed run in the report.
        // eslint-disable-next-line no-restricted-syntax
      } catch (failure) {
        error = failure.message;
      }
      const run = {
        seed,
        mode,
        code,
        signal,
        timedOut,
        interrupted,
        error,
        logPath,
        eventPath,
        ...records,
      };
      restoreNativeEvidence(run, eventPath, outDir, runID);
      resolve(run);
    });
  });
}

function evaluationInputs(environment, cohorts) {
  const sourcePaths = [
    "engine/ingame/auto-bot/hybridModelContract.js",
    "engine/ingame/auto-bot/hybridCombat.js",
  ];
  const source = sourcePaths
    .map((file) => `// ${file}\n${fs.readFileSync(path.join(projectRoot, file), "utf8")}`)
    .join("\n");
  const externalManifest = Object.assign(
    {},
    ...["package.json", "openfront-engine/package.json"].map((file) => {
      const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, file), "utf8"));
      return { ...metadata.dependencies, ...metadata.devDependencies };
    }),
  );
  const harness = fingerprintSources(
    projectRoot,
    [
      "scripts/headless/evaluate-hybrid-combat.mjs",
      "scripts/headless/hybrid-evaluation-contract.mjs",
      "scripts/headless/run-match.mts",
      "scripts/headless/opponent-adapter.js",
      "engine/ingame/auto-bot/portutil.js",
      "engine/ingame/intent-rate-limit.js",
      "package.json",
      "package-lock.json",
      "openfront-engine/package.json",
      "openfront-engine/package-lock.json",
      "openfront-engine/tsconfig.json",
    ],
    externalManifest,
  );
  const engineRoot = path.join(projectRoot, "openfront-engine");
  const bundleInput = path.resolve(
    environment.OFH_BUNDLE_PATH ?? path.join(projectRoot, "openfront-helper.user.js"),
  );
  const provenance = {
    bundleHash: hash(fs.readFileSync(bundleInput)),
    sourceHash: hash(source),
    harnessHash: harness.hash,
    evaluationContractHash: hash(
      fs.readFileSync(path.join(projectRoot, "scripts/headless/hybrid-evaluation-contract.mjs")),
    ),
    configurationHash: hash(
      canonical({
        environment: evaluationEnvironment(environment),
        cells: cohorts.cells.map((cell) => ({
          expected: cell.expected,
          environment: cell.environment ?? {},
        })),
      }),
    ),
    engineRevision: execFileSync("/usr/bin/git", ["-C", engineRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: foreignGitEnvironment(),
    }).trim(),
    engineDiffHash: hash(
      execFileSync("/usr/bin/git", ["-C", engineRoot, "diff", "HEAD", "--binary"], {
        env: foreignGitEnvironment(),
      }),
    ),
  };
  return { source, sourcePaths, harness, bundleInput, provenance };
}

function evaluationEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.startsWith("OFH_") || key === "GAME_ENV"),
  );
}

export function modelProvenance(model, sourceHash) {
  return {
    modelHash: hash(canonical(model)),
    featureHash: hash(
      canonical({ schema: model.schema, features: model.features, actions: model.actions }),
    ),
    normalizerHash: hash(
      canonical(
        model.normalizer ?? { kind: "fixed-native-ratios", features: model.features, sourceHash },
      ),
    ),
    rewardHash: hash(canonical({ reward: model.reward, offline: model.offline })),
  };
}

function assertPolicy(model, policy, featureProfile) {
  const schemas =
    policy === "compact-neural"
      ? ["ofh-combat-compact-tanh-v2", "ofh-combat-compact-tanh-v3"]
      : ["ofh-combat-ridge-v1"];
  assert.ok(schemas.includes(model.schema), "Selected policy/model kind mismatch");
  if (featureProfile !== undefined)
    assert.equal(model.featureProfile, featureProfile, "Selected model feature profile mismatch");
}

function initialModel(options, { source, provenance }) {
  const api = nativeApi(source);
  let model;
  let trainingSeeds = [];
  let collectionCounts = { success: 0, errors: 0, horizonRuns: 0 };
  if (options.model) {
    const saved = JSON.parse(fs.readFileSync(options.model, "utf8"));
    assert.equal(
      saved.format,
      format,
      "Use the native trained-model.json exported by --collect (includes training provenance)",
    );
    assertPolicy(saved.model, options.policy, options["feature-profile"]);
    validateProvenance(
      saved,
      { ...provenance, ...modelProvenance(saved.model, provenance.sourceHash) },
      true,
    );
    if (saved.collectionCounts) {
      for (const key of Object.keys(collectionCounts)) {
        assert.ok(
          Number.isSafeInteger(saved.collectionCounts[key]) && saved.collectionCounts[key] >= 0,
          "Invalid collection counters",
        );
      }
      collectionCounts = saved.collectionCounts;
    }
    assert.ok(
      Array.isArray(saved.trainingSeeds) &&
        saved.trainingSeeds.every((seed) => typeof seed === "string"),
      "Missing training seed provenance",
    );
    trainingSeeds = saved.trainingSeeds;
    validateSeedIdentities(options.seeds, trainingSeeds);
    model = validateModel(saved.model, source, !options.collect);
  } else {
    validateSeedIdentities(options.seeds, trainingSeeds);
    const compactOptions =
      options["feature-profile"] === undefined
        ? undefined
        : { featureProfile: options["feature-profile"] };
    model =
      options.policy === "compact-neural"
        ? api.createCompactModel(compactOptions)
        : api.exportModel();
    model = validateModel(model, source, false);
  }
  assertPolicy(model, options.policy, options["feature-profile"]);
  return { model, trainingSeeds, collectionCounts };
}

function prepareOutput(
  options,
  environment,
  { bundleInput, provenance, harness, sourcePaths },
  { model, trainingSeeds },
) {
  const outDir = options.out
    ? path.resolve(options.out)
    : fs.mkdtempSync(path.join(tmpdir(), "ofh-hybrid-evaluation-"));
  fs.mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, "frozen.user.js");
  fs.copyFileSync(bundleInput, bundlePath, fs.constants.COPYFILE_EXCL);
  const bundleHash = hash(fs.readFileSync(bundlePath));
  assert.equal(bundleHash, provenance.bundleHash, "Bundle changed during snapshot creation");
  let modelPath;
  if (model) {
    modelPath = path.join(outDir, "input-model.json");
    save(modelPath, model);
  }
  const experimentID = randomUUID();
  const collectionArm = options.collect ? "shadow-collection" : "frozen-holdout";
  save(path.join(outDir, "manifest.json"), {
    format,
    experimentID,
    requirementsHash: options.requirementsBinding?.hash ?? null,
    requirementsFrozenBeforeLaunch: Boolean(options.requirementsBinding),
    requirements: options.requirements,
    cohortDeclarationHash: options.cohortBinding?.hash ?? null,
    seeds: options.seeds,
    trainingSeeds,
    collect: options.collect,
    timeoutMs: options.timeoutMs,
    policy: options.policy,
    frozenReplay: options.frozenReplay === true,
    arm: options.replay ? "offline-frozen-group-fit" : collectionArm,
    cohortDeclaration: options.cohorts,
    harness,
    sourcePaths,
    ...provenance,
    ...modelProvenance(model, provenance.sourceHash),
    environment: evaluationEnvironment(environment),
  });
  return {
    outDir,
    bundlePath,
    modelPath,
    frozenBundleHash: hash(fs.readFileSync(bundlePath)),
    experimentID,
    frozenManifestHash: hash(fs.readFileSync(path.join(outDir, "manifest.json"))),
    requirementsBinding: options.requirementsBinding,
    requirements: options.requirements,
    cohortBinding: options.cohortBinding,
    cohortDeclaration: options.cohorts,
  };
}

function acceptsCollection(run, seed, learning) {
  if (runFailed(run) || !run.provenanceMatches || run.result.seed !== seed) return false;
  return (
    policyConfigurationMatches(run.result.hybridCombat, "shadow", learning) &&
    run.result.hybridCombat.model != null
  );
}

async function evaluationRuns(options, environment, runner, context, state) {
  const { source, provenance, outDir, bundlePath } = context;
  let { modelPath } = context;
  const runs = [];
  for (const seed of options.seeds) {
    for (const mode of options.collect ? ["shadow"] : modes) {
      const cell = context.cohorts.cells.find((entry) => entry.seeds.includes(seed));
      const learning = options.collect === true && !options.frozenReplay;
      const modelFileHash = hash(fs.readFileSync(modelPath));
      assert.equal(
        modelFileHash,
        hash(`${JSON.stringify(state.model, null, 2)}\n`),
        "Frozen model file mismatch before launch",
      );
      checkFrozenInputs(context, environment, modelPath, modelFileHash);
      const runID = hash(canonical([context.experimentID, seed, mode]));
      const launch = {
        runID,
        experimentID: context.experimentID,
        seed,
        mode,
        learning,
        ...provenance,
        ...modelProvenance(state.model, provenance.sourceHash),
        trainingSeeds: state.trainingSeeds,
      };
      process.stdout.write(`[hybrid] ${mode} ${seed}\n`);
      const run = await runner({
        seed,
        mode,
        learning,
        modelPath,
        bundlePath,
        outDir,
        timeoutMs: options.timeoutMs,
        environment: { ...environment, ...cell.environment },
        runID,
        experimentID: context.experimentID,
      });
      run.launch = { ...launch, mapFingerprint: run.start?.mapFingerprint ?? null };
      run.provenanceMatches =
        run.start?.engineFingerprint?.revision === provenance.engineRevision &&
        run.start?.engineFingerprint?.diffHash === provenance.engineDiffHash;
      if (options.collect)
        run.collectionAccepted =
          acceptsCollection(run, seed, learning) && matchesCohort(run.start, cell);
      runs.push(run);
      checkFrozenInputs(context, environment, modelPath, modelFileHash);
      run.frozenVerified = true;
      save(path.join(outDir, `${mode}-${hash(seed).slice(0, 16)}.json`), run);
      assert.ok(
        !run.interrupted,
        "Evaluation interrupted; child stopped and raw evidence retained",
      );
      modelPath = collectRunModel(options, run, state, { launch, source, modelPath, outDir });
    }
  }
  return runs;
}

function collectRunModel(options, run, state, { launch, source, modelPath, outDir }) {
  if (!options.collect || !run.collectionAccepted) return modelPath;
  if (options.frozenReplay)
    assert.equal(
      hash(canonical(run.result.hybridCombat.model)),
      launch.modelHash,
      "Frozen replay model mutated",
    );
  const model = validateModel(run.result.hybridCombat.model, source, false);
  assertPolicy(model, options.policy, options["feature-profile"]);
  Object.assign(state, { model });
  const nextPath = path.join(outDir, `collected-${hash(run.seed).slice(0, 16)}.json`);
  save(nextPath, model);
  return nextPath;
}

function checkFrozenInputs(context, environment, modelPath, modelFileHash) {
  checkRequirements(context);
  checkBinding(context.cohortBinding, context.cohortDeclaration, "cohort declaration");
  assert.equal(
    hash(fs.readFileSync(path.join(context.outDir, "manifest.json"))),
    context.frozenManifestHash,
    "Frozen manifest drift",
  );
  const current = evaluationInputs(environment, context.cohorts);
  validateProvenance(context.provenance, current.provenance);
  for (const key of ["harnessHash", "evaluationContractHash", "configurationHash"]) {
    assert.equal(current.provenance[key], context.provenance[key], `Frozen ${key} drift`);
  }
  assert.equal(
    hash(fs.readFileSync(context.bundlePath)),
    context.frozenBundleHash,
    "Frozen bundle drift",
  );
  assert.equal(hash(fs.readFileSync(modelPath)), modelFileHash, "Frozen model file drift");
}

function checkRequirements(context) {
  checkBinding(context.requirementsBinding, context.requirements, "requirements");
}

function checkBinding(binding, value, label) {
  if (!binding) return;
  assert.equal(hash(canonical(value)), binding.hash, `Frozen ${label} object drift`);
  if (binding.file)
    assert.equal(
      hash(fs.readFileSync(binding.file)),
      binding.fileHash,
      `Frozen ${label} file drift`,
    );
}

function jsonOption(value) {
  return typeof value === "string" ? JSON.parse(fs.readFileSync(value, "utf8")) : value;
}

function bindOption(value) {
  const file = typeof value === "string" ? path.resolve(value) : null;
  const parsed = jsonOption(value);
  return {
    value: parsed,
    binding: parsed
      ? { hash: hash(canonical(parsed)), file, fileHash: file ? hash(fs.readFileSync(file)) : null }
      : null,
  };
}

function replayExportSource(evidence) {
  const ledger = evidence?.ledger;
  const replay = evidence?.replay;
  const fullDataset = (ledger ?? replay)?.fullDataset === true;
  if (fullDataset && ledger) {
    return {
      events: ledger.entries.filter(
        (event) => event.kind === "outcome" || event.kind.startsWith("hybrid-combat-"),
      ),
      fullDataset,
      dropped: ledger.dropped ?? null,
    };
  }
  return {
    events: replay?.records,
    fullDataset,
    dropped: replay?.dropped ?? ledger?.dropped ?? null,
  };
}

function exportLedgerDataset(outDir, runs) {
  const manifests = runs.map((run) => run.launch);
  const records = [];
  const coverage = [];
  for (const run of runs) {
    const { events, fullDataset, dropped } = replayExportSource(run.result?.hybridEvaluation);
    coverage.push({
      runID: run.launch.runID,
      available: Array.isArray(events),
      fullDataset,
      dropped,
      frozenVerified: run.frozenVerified === true,
    });
    if (Array.isArray(events))
      for (const event of events) records.push({ manifest: run.launch, event });
  }
  const header = {
    version: "ofh-hybrid-ledger-v1",
    eventScope: "policy-events-only",
    manifests,
    coverage,
    recordCount: records.length,
  };
  const file = path.join(outDir, "ledger.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ metadata: header })}\n`, { flag: "wx" });
  for (const record of records) fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return { path: file, hash: hash(fs.readFileSync(file)), ...header };
}

function readLedger(file) {
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const [first, ...records] = lines;
  assert.ok(first.metadata?.recordCount === records.length, "Ledger record count mismatch");
  return { ...first.metadata, records };
}

function potentialRecords(records, shaping) {
  if (!shaping) return records;
  assert.equal(
    shaping.potentialID,
    "observed-own-land-share-v1",
    "Unsupported observed potential contract",
  );
  assert.ok(
    Number.isFinite(shaping.gammaTick) && shaping.gammaTick >= 0 && shaping.gammaTick <= 1,
    "Invalid gammaTick",
  );
  return records.map((record) => {
    assert.ok(
      Number.isFinite(record.gate?.[2]) && Number.isFinite(record.nextGate?.[2]),
      "Missing observed potential",
    );
    return { ...record, potential: record.gate[2], nextPotential: record.nextGate[2] };
  });
}

function offlineReplay(options, inputs, cohorts, environment) {
  const replayHash = hash(fs.readFileSync(options.replay));
  const dataset = readLedger(options.replay);
  const selectedInput = bindOption(options.selection);
  const selection = selectedInput.value;
  selectReplayGroup(dataset, selection);
  const group = selectReplayGroup(
    {
      ...dataset,
      records: dataset.records.filter((row) =>
        ["outcome", "hybrid-combat-outcome"].includes(row.event.kind),
      ),
    },
    selection,
  );
  const coverage = dataset.coverage?.filter((row) => row.runID === group.manifest.runID);
  assert.ok(
    coverage?.length === 1 &&
      coverage[0].available === true &&
      coverage[0].fullDataset === true &&
      coverage[0].dropped === 0,
    "Incomplete selected replay coverage",
  );
  const model = validateModel(group.snapshot, inputs.source, false);
  assertPolicy(model, options.policy, options["feature-profile"]);
  validateProvenance(
    group.manifest,
    { ...inputs.provenance, ...modelProvenance(model, inputs.provenance.sourceHash) },
    true,
  );
  validateSeedIdentities(options.seeds, group.manifest.trainingSeeds ?? []);
  assert.deepEqual(
    options.seeds,
    [group.manifest.seed],
    "Offline replay must explicitly select its real training seed",
  );
  const shaping = jsonOption(options["potential-shaping"]);
  assert.ok(
    selection.maxRecords === undefined || selection.maxRecords === group.records.length,
    "Offline replay must fit the full explicitly selected group; no silent subset",
  );
  const context = {
    engineRevision: group.manifest.engineRevision,
    experimentID: group.manifest.experimentID,
    episodeId: selection.episodeId,
    generation: selection.generation,
    normalizer: model.normalizer,
    maxRecords: group.records.length,
    ablation: {
      version: "patient-potential-v1",
      patientAnchors: options.anchors === true,
      potentialShaping: Boolean(shaping),
    },
    gammaTick: shaping?.gammaTick,
    potentialID: shaping?.potentialID,
  };
  const fitted = nativeApi(inputs.source).replayFit(
    group.snapshot,
    potentialRecords(group.records, shaping),
    context,
  );
  const state = {
    model: fitted.model,
    trainingSeeds: [...(group.manifest.trainingSeeds ?? []), group.manifest.seed],
  };
  const output = prepareOutput(options, environment, inputs, state);
  const report = {
    collection: true,
    offlineReplay: true,
    policy: options.policy,
    selected: selection,
    exclusions: group.excluded,
    summary: fitted.summary,
    datasetHash: hash(fs.readFileSync(options.replay)),
    counts: { success: fitted.summary.fitted, errors: 0, horizonRuns: fitted.summary.censored },
    cumulativeCounts: {
      success: fitted.summary.fitted,
      errors: 0,
      horizonRuns: fitted.summary.censored,
    },
    evidence:
      "Native explicit frozen-group fit only; anchor/PBRS ablation is not a combat-strength or promotion claim.",
  };
  checkFrozenInputs(
    { ...inputs, ...output, cohorts },
    environment,
    output.modelPath,
    hash(fs.readFileSync(output.modelPath)),
  );
  assert.equal(hash(fs.readFileSync(options.replay)), replayHash, "Offline dataset drift");
  checkBinding(selectedInput.binding, selection, "replay selection");
  report.frozenVerified = true;
  saveTrainedModel(output.outDir, state, inputs, report);
  save(path.join(output.outDir, "evaluation.json"), report);
  return { outDir: output.outDir, report };
}

function saveTrainedModel(outDir, state, inputs, report) {
  save(path.join(outDir, "trained-model.json"), {
    format,
    policy: report.policy,
    trainingSeeds: [...new Set([...state.trainingSeeds, ...(report.seeds ?? [])])],
    model: state.model,
    ...inputs.provenance,
    ...modelProvenance(state.model, inputs.provenance.sourceHash),
    collectionCounts: report.cumulativeCounts,
  });
}

function labelRunner(report, runner) {
  report.runner =
    runner === runMatch
      ? "official-gameimpl-bundled-harness"
      : "injected-runner-fixture-or-unverified";
  if (runner !== runMatch)
    report.evidence =
      "Injected runner fixture or unverified integration; not official-engine execution or combat-strength evidence.";
}

export async function evaluate(options, environment = process.env, runner = runMatch) {
  options = { ...options };
  environment = { ...environment };
  validateOptions(options);
  const cohortsInput = bindOption(options.cohorts);
  const requirementsInput = bindOption(options.requirements);
  Object.assign(options, {
    cohorts: cohortsInput.value,
    cohortBinding: cohortsInput.binding,
    requirements: requirementsInput.value,
    requirementsBinding: requirementsInput.binding,
  });
  const cohorts = resolveCohorts(options.cohorts, options.seeds);
  if (options.requirements) {
    assessCandidatePromotion({}, options.requirements);
    if (options.requirements.uncertainty)
      assert.equal(
        canonical(cohorts.uncertainty),
        canonical(options.requirements.uncertainty),
        "Preregistered uncertainty must match declared cohort parameters",
      );
  }
  const inputs = evaluationInputs(environment, cohorts);
  if (options.replay) return offlineReplay(options, inputs, cohorts, environment);
  const state = initialModel(options, inputs);
  const { collectionCounts } = state;
  const output = prepareOutput(options, environment, inputs, state);
  const runs = await evaluationRuns(
    options,
    environment,
    runner,
    { ...inputs, ...output, cohorts },
    state,
  );
  const { outDir } = output;
  const report = options.collect
    ? {
        collection: true,
        policy: options.policy,
        frozenReplay: options.frozenReplay === true,
        seeds: runs.filter((run) => run.collectionAccepted).map((run) => run.seed),
        counts: {
          success: runs.filter((run) => run.collectionAccepted).length,
          errors: runs.filter((run) => !run.collectionAccepted).length,
          horizonRuns: runs.filter((run) => run.result?.stopReason === "max_ticks").length,
        },
        runs,
        evidence: options.frozenReplay
          ? "Frozen shadow replay collection; original per-action identities retained. No training or combat-strength claim."
          : "Online shadow observation only; exported samples are not evidence of improved combat or completed wins.",
      }
    : scorePairedRuns(runs, options.seeds, hash(canonical(state.model)), options.cohorts);
  report.runs = runs;
  report.ledgerDataset = exportLedgerDataset(outDir, runs);
  labelRunner(report, runner);
  report.requirementsHash = options.requirementsBinding?.hash ?? null;
  report.requirementsFrozenBeforeLaunch = Boolean(options.requirementsBinding);
  if (options.requirements)
    report.eligibility = assessCandidatePromotion(report, options.requirements);
  if (options.collect)
    report.cumulativeCounts = Object.fromEntries(
      Object.keys(collectionCounts).map((key) => [key, collectionCounts[key] + report.counts[key]]),
    );
  if (options.collect && state.model) saveTrainedModel(outDir, state, inputs, report);
  save(path.join(outDir, "evaluation.json"), report);
  return { outDir, report };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  const { outDir, report } = await evaluate(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify(
      {
        outDir,
        resultPath: path.join(outDir, "evaluation.json"),
        collection: report.collection === true,
        counts: report.counts,
        completedPairs: report.completedPairs,
        requestedPairs: report.requestedPairs,
        summary: report.summary,
        eligibility: report.eligibility,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = report.collection
    ? Number(report.counts.errors > 0)
    : Number(report.completedPairs !== report.requestedPairs);
}
