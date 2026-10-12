import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
import {
  runMatch,
  validateSeedIdentities,
  parseArgs,
  readRecords,
  scorePairedRuns,
  validateModel,
  validateProvenance,
  evaluate,
  nativeEventLimit,
  validateNativeEvidence,
  save,
} from "../scripts/headless/evaluate-hybrid-combat.mjs";

assert.throws(() => parseArgs([]), /seeds/);
assert.throws(() => parseArgs(["--seeds", "a,a", "--timeout-ms", "100", "--collect"]), /unique/);
assert.throws(() => parseArgs(["--seeds", "a", "--timeout-ms", "0", "--collect"]), /positive/);
assert.throws(() => parseArgs(["--seeds", "a", "--timeout-ms", "100"]), /model/);
assert.throws(() => parseArgs(["--seeds"]), /Missing value/);
assert.throws(() => parseArgs(["--typo"]), /Unknown argument/);
assert.deepEqual(parseArgs(["--collect", "--seeds", "a, b", "--timeout-ms", "100"]).seeds, [
  "a",
  "b",
]);
assert.equal(
  parseArgs(["--collect", "--policy", "compact-neural", "--seeds", "a", "--timeout-ms", "100"])
    .policy,
  "compact-neural",
);
assert.throws(
  () => parseArgs(["--collect", "--policy", "ppo", "--seeds", "a", "--timeout-ms", "100"]),
  /policy/,
);

assert.equal(
  parseArgs([
    "--collect",
    "--policy",
    "compact-neural",
    "--feature-profile",
    "frontier-v1",
    "--seeds",
    "profile",
    "--timeout-ms",
    "100",
  ])["feature-profile"],
  "frontier-v1",
);
assert.throws(
  () =>
    parseArgs([
      "--collect",
      "--policy",
      "compact-neural",
      "--feature-profile",
      "unknown",
      "--seeds",
      "profile",
      "--timeout-ms",
      "100",
    ]),
  /Unsupported feature profile/,
);
assert.throws(
  () =>
    parseArgs([
      "--collect",
      "--feature-profile",
      "frontier-v1",
      "--seeds",
      "profile",
      "--timeout-ms",
      "100",
    ]),
  /requires compact-neural/,
);
assert.throws(() => validateSeedIdentities(["Aa", "BB"], []), /effective engine PRNG/);
// Distinct printable hashes 0/1 enter the same actual house PRNG stream.
const zeroSeed = "ASD[IWW";
const oneSeed = "ASD[IWX";
const seedStreams = executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/portutil.js") +
    "\nseeds.map(seed => { const random = new PseudoRandom(simpleHash(seed)); return { hash: simpleHash(seed), draws: Array.from({ length: 8 }, () => random.next()) }; });",
  { seeds: [zeroSeed, oneSeed] },
);
assert.deepEqual(
  Array.from(seedStreams, (item) => item.hash),
  [0, 1],
);
assert.deepEqual(Array.from(seedStreams[0].draws), Array.from(seedStreams[1].draws));
assert.throws(() => validateSeedIdentities([zeroSeed, oneSeed], []), /effective engine PRNG/);
assert.throws(() => validateSeedIdentities([oneSeed], [zeroSeed]), /effective engine PRNG/);
assert.throws(() => validateSeedIdentities([], [zeroSeed, oneSeed]), /effective engine PRNG/);
// This fixture tests evaluator plumbing, never combat quality or engine execution.
const source = `window.__OFH_hybridCombat = {
  configure() {},
  importModel(model) { this.model = model; return model.kind === 'native'; },
  exportModel() { return this.model; },
  diagnostics() { return { ready: this.model.samples > 0 }; }
};`;
assert.throws(() => validateModel({ kind: "external", samples: 3 }, source), /Unsupported/);
assert.throws(() => validateModel({ kind: "native", samples: 0 }, source), /Cold/);
assert.equal(validateModel({ kind: "native", samples: 3 }, source).samples, 3);
assert.throws(() => validateModel({}, ""), /unavailable/);

const nativeSource = ["hybridModelContract.js", "hybridCombat.js"]
  .map((file) =>
    fs.readFileSync(new URL(`../engine/ingame/auto-bot/${file}`, import.meta.url), "utf8"),
  )
  .join("\n");
const nativeWindow = {};
// Executes only the audited local module in an isolated fixture realm, never model data.
// eslint-disable-next-line sonarjs/code-eval
vm.runInNewContext(nativeSource, { window: nativeWindow });
const nativeModel = JSON.parse(JSON.stringify(nativeWindow.__OFH_hybridCombat.exportModel()));
assert.throws(() => validateModel(nativeModel, nativeSource), /Cold/);
assert.equal(validateModel(nativeModel, nativeSource, false).models.wait.samples, 0);
assert.throws(
  () => validateModel({ ...nativeModel, schema: "external-ppo" }, nativeSource),
  /Incompatible/,
);
// Artificial sample counts exercise the native admission threshold, not training.
for (const native of Object.values(nativeModel.models)) native.samples = native.weights.length;
assert.deepEqual(JSON.parse(JSON.stringify(validateModel(nativeModel, nativeSource))), nativeModel);

const model = { samples: 3 };
const modelHash = createHash("sha256").update(JSON.stringify(model)).digest("hex");
function run(seed, mode, won) {
  return {
    seed,
    mode,
    code: won ? 0 : 2,
    signal: null,
    start: {
      phase: "start",
      seed,
      map: "Alps",
      mode: "Free for All",
      engineFingerprint: { revision: "fixture", diffHash: "fixture" },
      mapFingerprint: "fixture",
    },
    result: {
      phase: "result",
      seed,
      won,
      winner: won ? "us" : "them",
      alive: won,
      stopReason: "winner",
      ticks: 1200,
      runtimeMs: 100,
      finalBotState: { tiles: 10 },
      hybridCombat: {
        mode,
        learning: false,
        modelImported: true,
        diagnostics: { mode, learning: false, ready: true, decisions: mode === "baseline" ? 0 : 1 },
        model,
      },
    },
  };
}
const modes = ["baseline", "shadow", "learned"];
const runs = ["a", "b"].flatMap((seed) => modes.map((mode) => run(seed, mode, mode === "learned")));
const rowBoundRuns = structuredClone(runs.slice(0, 3));
for (const entry of rowBoundRuns) {
  const runID = `fixture-${entry.mode}`;
  entry.launch = { runID };
  entry.result.hybridEvaluation = {
    decisionRows: [
      {
        runIdentity: runID,
        episodeId: 0,
        generation: 0,
        step: 0,
        tick: 0,
        eligible: true,
        controlledAction: "wait",
      },
      {
        runIdentity: runID,
        episodeId: 0,
        generation: 0,
        step: 1,
        tick: 1,
        eligible: true,
        controlledAction: null,
      },
      {
        runIdentity: runID,
        episodeId: 0,
        generation: 0,
        step: 0,
        tick: 0,
        eligible: true,
        controlledAction: "wait",
      },
    ],
  };
}
const rowBoundScore = scorePairedRuns(rowBoundRuns, ["a"], modelHash);
assert.equal(rowBoundScore.pairs[0].outcomes.learned.telemetry.conditionalWait.frequency, 0.5);
rowBoundRuns[2].result.hybridEvaluation.decisionRows[0].runIdentity = "other-run";
assert.throws(() => scorePairedRuns(rowBoundRuns, ["a"], modelHash), /launch run identity/);

const score = scorePairedRuns(runs, ["a", "b"], modelHash);
assert.equal(score.completedPairs, 2);
assert.equal(score.counts.success, 6);
assert.equal(score.counts.errors, 0);
const provenanceFixture = {
  bundleHash: "bundle",
  sourceHash: "source",
  engineRevision: "engine",
  engineDiffHash: "diff",
};
validateProvenance(provenanceFixture, provenanceFixture);
for (const key of Object.keys(provenanceFixture)) {
  assert.throws(
    () => validateProvenance({ ...provenanceFixture, [key]: "changed" }, provenanceFixture),
    /provenance mismatch/,
  );
}
const capped = structuredClone(runs.slice(0, 3));
capped[2].result.stopReason = "max_ticks";
assert.equal(scorePairedRuns(capped, ["a"], modelHash).counts.horizonExclusions, 1);
assert.equal(scorePairedRuns(capped, ["a"], modelHash).counts.errors, 0);
assert.equal(score.candidateDecisionPairs, 2);
assert.equal(Object.hasOwn(score, "combatExercisedPairs"), false);
// A candidate decision may be a rejected proposal followed by Legendary fallback.
// Existing diagnostics do not establish that learned control was exercised.
const proposalFallback = structuredClone(runs.slice(0, 3));
proposalFallback[2].result.hybridCombat.diagnostics.proposal = { action: "attack" };
assert.equal(scorePairedRuns(proposalFallback, ["a"], modelHash).candidateDecisionPairs, 1);
assert.equal(score.summary.baseline.winRate, 0, "exit 2 is a completed loss");
assert.equal(score.summary.learned.winRate, 1);
assert.equal(score.learnedMinusBaselineWins, 2);
assert.equal(score.summary.baseline.averageEmittedIntents, null, "missing metrics are not zero");

for (const mutate of [
  (entry) => {
    entry.result.stopReason = "max_ticks";
    entry.result.won = false;
  },
  (entry) => {
    entry.result.stopReason = "spawn_failed";
  },
  (entry) => {
    entry.result.stopReason = "engine_stop";
  },
  (entry) => {
    entry.start.map = "Europe";
  },
  (entry) => {
    entry.start.mapFingerprint = "different-map";
  },
  (entry) => {
    entry.start.engineFingerprint.revision = "different-engine";
  },
  (entry) => {
    entry.provenanceMatches = false;
  },
  (entry) => {
    entry.result.seed = "wrong";
  },
  (entry) => {
    entry.result.hybridCombat.mode = "shadow";
  },
  (entry) => {
    entry.result.hybridCombat.diagnostics.mode = "shadow";
  },
  (entry) => {
    entry.result.hybridCombat.learning = true;
  },
  (entry) => {
    entry.result.hybridCombat.model.samples += 1;
  },
  (entry) => {
    entry.result.hybridCombat.modelImported = false;
  },
  (entry) => {
    delete entry.result.hybridCombat.model;
  },
  (entry) => {
    entry.result.hybridCombat.diagnostics.ready = false;
  },
  (entry) => {
    entry.result.intentBudgetViolated = true;
  },
  (entry) => {
    entry.timedOut = true;
  },
  (entry) => {
    entry.code = 1;
  },
  (entry) => {
    entry.result = null;
  },
]) {
  const invalid = structuredClone(runs.slice(0, 3));
  mutate(invalid[2]);
  const excluded = scorePairedRuns(invalid, ["a"], modelHash);
  assert.equal(excluded.completedPairs, 0);
  assert.equal(excluded.summary.learned.winRate, null);
  assert.equal(excluded.learnedMinusBaselineWins, null);
}
const dead = structuredClone(runs.slice(0, 3));
dead[0].result.stopReason = "bot_dead";
dead[0].result.winner = null;
assert.equal(scorePairedRuns(dead, ["a"], modelHash).completedPairs, 1);
assert.throws(() => scorePairedRuns(runs.slice(1, 3), ["a"], modelHash), /Expected one/);
assert.throws(() => scorePairedRuns([...runs, runs[0]], ["a", "b"], modelHash), /Expected one/);
assert.deepEqual(
  readRecords('noise\n{"phase":"start","seed":"a"}\n{"phase":"result","won":false}').result,
  { phase: "result", won: false },
);
assert.throws(() => readRecords('{"phase":"result"}\n{"phase":"result"}'), /Duplicate/);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-hybrid-api-test-"));
// Native launch lifecycle fixture: no engine process or game is started.
function nativeLedgerFixture(runID) {
  const rows = Array.from({ length: 300 }, (_, tick) => ({
    kind: "hybrid-combat-decision",
    runIdentity: runID,
    tick,
    episodeId: 1,
    generation: 1,
    step: tick,
    eligible: null,
    controlledAction: null,
    modelIdentity: `original-${tick}`,
  }));
  rows.push(
    ...Array.from({ length: 300 }, (_, tick) => ({
      kind: "hybrid-latency",
      runIdentity: runID,
      durationMs: tick + 1,
    })),
  );
  const transitions = [];
  for (let step = 0; step < 300; step++) {
    const terminal = step === 299;
    const event = {
      kind: "hybrid-combat-outcome",
      runIdentity: runID,
      episodeId: 1,
      generation: 1,
      step,
      actionTick: step,
      outcomeTick: step + 1,
      reward: 2,
      gate: [0, 0, 0.2],
      nextGate: [0, 0, 0.3],
      terminal,
      confirmed: true,
      modelIdentity: `original-outcome-model-${step}`,
    };
    const transition = {
      runIdentity: runID,
      episodeId: 1,
      generation: 1,
      step,
      tick: step,
      nextTick: step + 1,
      first: step === 0,
      terminated: terminal,
      truncated: false,
      envError: false,
      reason: null,
      potentialID: "observed-own-land-share-v1",
      potentialSource: "policy-gate-ownLandShare",
      potential: 0.2,
      nextPotential: 0.3,
      baseReward: 2,
      confirmed: true,
    };
    transitions.push(transition);
    rows.push(event, { ...transition, kind: "hybrid-transition" });
  }
  const safetyRows = [
    {
      kind: "hybrid-safety",
      runIdentity: runID,
      reservePassed: true,
      legalityPassed: true,
      emitted: true,
    },
    {
      kind: "hybrid-safety",
      runIdentity: runID,
      reservePassed: null,
      legalityPassed: null,
      emitted: true,
    },
  ];
  rows.push(...safetyRows);
  const closure = {
    kind: "hybrid-episode-close",
    runIdentity: runID,
    episodeId: 1,
    generation: 1,
    tick: 300,
    reason: "winner",
    terminated: true,
    truncated: false,
    envError: false,
  };
  rows.push(closure);
  const entries = rows.filter((row) => row.kind !== "hybrid-transition");
  const result = {
    phase: "result",
    seed: "../seed",
    stopReason: "winner",
    winner: 1,
    won: true,
    hybridEvaluation: {
      entries: entries.slice(-256),
      retainedDecisionRows: rows.slice(44, 300),
      retainedLatencyMs: Array.from({ length: 256 }, (_, index) => index + 45),
      transitionRows: transitions.slice(-256),
      safetyRows: safetyRows.map(({ kind: _kind, ...row }) => row),
      dropped: {
        entries: entries.length - 256,
        decisionRows: 44,
        latencyMs: 44,
        transitions: 44,
        safetyRows: 0,
      },
      latestClosure: closure,
      safety: { reserveChecks: 1, reserveViolations: 0, legalityChecks: 1, illegalEmissions: 0 },
      coverage: { knownAttempts: 1, unknownAttempts: 1, emissionsWithoutChecks: 1 },
    },
  };
  return { rows, result, entries };
}

async function nativeLedgerLaunch(
  change = () => {},
  code = 0,
  timeout = false,
  runID = "bound-native-run",
) {
  const outDir = fs.mkdtempSync(path.join(temporary, "native-ledger-"));
  const { rows, result, entries } = nativeLedgerFixture(runID);
  const launch = await runMatch({
    seed: "../seed",
    mode: "shadow",
    learning: false,
    outDir,
    timeoutMs: timeout ? 1 : 1000,
    environment: {},
    runID,
    spawnProcess(command, args, options) {
      assert.equal(command, process.execPath, "Launch the installed Node without a shell shim");
      assert.equal(args[0], path.resolve("node_modules/tsx/dist/cli.mjs"));
      assert.equal(args[1], "--tsconfig");
      assert.equal(options.env.OFH_HYBRID_RUN_ID, runID);
      const file = options.env.OFH_HYBRID_EVENT_LOG;
      assert.equal(path.dirname(file), fs.realpathSync(outDir));
      result.hybridEvaluation.eventFile = file;
      result.hybridEvaluation.ledger = {
        entries: entries.slice(-256),
        dropped: entries.length - 256,
        fullDataset: false,
        incrementalFile: { path: file, fullDataset: true, policyEvents: entries.length },
      };
      const onRead = change(rows, result, file);
      if (!fs.existsSync(file))
        fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n", { flag: "wx" });
      fs.writeSync(options.stdio[1], JSON.stringify(result) + "\n");
      const child = new EventEmitter();
      child.kill = () => child.emit("close", null, "SIGKILL");
      if (!timeout)
        setImmediate(() => {
          const readSync = fs.readSync;
          let changed = false;
          if (typeof onRead === "function")
            fs.readSync = (...args) => {
              const count = readSync(...args);
              if (!changed && Buffer.isBuffer(args[1]) && args[1].length === 64 * 1024) {
                changed = true;
                onRead();
              }
              return count;
            };
          try {
            child.emit("close", code, null);
          } finally {
            fs.readSync = readSync;
          }
        });
      return child;
    },
  });
  return launch;
}
function repeatedIdentityHistoryChecks() {
  const runID = "repeated-identity-native";
  const { rows, result, entries } = nativeLedgerFixture(runID);
  const identity = 'exact-"\\\\-identity-' + "x".repeat(512 * 1024);
  for (const row of rows) if (typeof row.modelIdentity === "string") row.modelIdentity = identity;
  const outDir = fs.mkdtempSync(path.join(temporary, "repeated-identity-"));
  const file = path.join(outDir, "native.jsonl");
  const descriptor = fs.openSync(file, "wx");
  for (const row of rows) fs.writeSync(descriptor, JSON.stringify(row) + "\n");
  fs.closeSync(descriptor);
  result.hybridEvaluation.eventFile = file;
  result.hybridEvaluation.ledger = {
    entries: entries.slice(-256),
    dropped: entries.length - 256,
    fullDataset: false,
    incrementalFile: { path: file, fullDataset: true, policyEvents: entries.length },
  };
  assert.ok(fs.statSync(file).size > nativeEventLimit);
  const restored = validateNativeEvidence({ seed: "../seed", result }, file, outDir, runID);
  assert.equal(restored.ledger.fullDataset, true);
  assert.equal(restored.decisionRows.length, 300);
  assert.ok(restored.decisionRows.every((row) => row.modelIdentity === identity));
  for (const extra of ["unique", "padding"]) {
    const invalidFile = path.join(outDir, `${extra}.jsonl`);
    const fd = fs.openSync(invalidFile, "wx");
    for (const [index, row] of rows.entries()) {
      const changed = { ...row };
      if (typeof changed.modelIdentity === "string") {
        if (extra === "unique") changed.modelIdentity += index;
        else changed.padding = " ".repeat(512 * 1024);
      }
      fs.writeSync(fd, JSON.stringify(changed) + "\n");
    }
    fs.closeSync(fd);
    result.hybridEvaluation.eventFile = invalidFile;
    result.hybridEvaluation.ledger.incrementalFile.path = invalidFile;
    assert.throws(
      () => validateNativeEvidence({ seed: "../seed", result }, invalidFile, outDir, runID),
      /unique event payload/,
    );
  }
  const largeOutput = path.join(outDir, "large-report.json");
  save(largeOutput, { records: Array(1025).fill(identity) });
  assert.ok(fs.statSync(largeOutput).size > 512 * 1024 * 1024);
  const tail = Buffer.alloc(8);
  const fd = fs.openSync(largeOutput, "r");
  fs.readSync(fd, tail, 0, tail.length, fs.statSync(largeOutput).size - tail.length);
  fs.closeSync(fd);
  assert.equal(tail.toString().endsWith("\n  ]\n}\n"), true);
  const output = path.join(outDir, "report.json");
  save(output, {
    values: [undefined, null, false, 1, identity],
    nested: { omitted: undefined, value: 2 },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
    values: [null, null, false, 1, identity],
    nested: { value: 2 },
  });
  const compatible = {
    date: new Date("2026-10-11T00:00:00Z"),
    bytes: Buffer.from([1, 2]),
    omitted: {
      toJSON() {
        return undefined;
      },
    },
    keyed: {
      toJSON(key) {
        return key;
      },
    },
  };
  const compatibilityOutput = path.join(outDir, "compatible.json");
  save(compatibilityOutput, compatible);
  assert.equal(
    fs.readFileSync(compatibilityOutput, "utf8"),
    JSON.stringify(compatible, null, 2) + "\n",
  );
  assert.throws(() => save(output, {}), /EEXIST/);
  const cyclic = {};
  cyclic.self = cyclic;
  const failed = path.join(outDir, "failed.json");
  assert.throws(() => save(failed, cyclic));
  assert.equal(fs.existsSync(failed), false);
  assert.ok(!fs.readdirSync(outDir).some((name) => name.endsWith(".tmp")));
}
repeatedIdentityHistoryChecks();

const nativeLedger = await nativeLedgerLaunch();
assert.equal(nativeLedger.nativeEventError, undefined);
assert.equal(nativeLedger.result.hybridEvaluation.decisionRows.length, 300);
assert.equal(nativeLedger.result.hybridEvaluation.decisionRows[0].modelIdentity, "original-0");
assert.equal(nativeLedger.result.hybridEvaluation.ledger.fullDataset, true);
assert.equal(nativeLedger.eventPath, nativeLedger.result.hybridEvaluation.eventFile);
assert.equal(nativeLedger.result.hybridEvaluation.latencyMs.length, 300);
assert.equal(nativeLedger.result.hybridEvaluation.latencyMs[0], 1);
assert.equal(nativeLedger.result.hybridEvaluation.transitions.length, 300);
assert.equal(nativeLedger.result.hybridEvaluation.transitions[0].baseReward, 2);
assert.equal(nativeLedger.result.hybridEvaluation.replay.records.length, 300);
assert.equal(
  nativeLedger.result.hybridEvaluation.replay.records[0].modelIdentity,
  "original-outcome-model-0",
);
assert.equal(nativeLedger.result.hybridEvaluation.coverage.unknownAttempts, 1);
const fullMatchSizeLedger = await nativeLedgerLaunch((rows, _result, file) => {
  const padding = " ".repeat(Math.ceil((64 * 1024 * 1024) / rows.length));
  fs.writeFileSync(file, rows.map((row) => `${padding}${JSON.stringify(row)}\n`).join(""), {
    flag: "wx",
  });
});
assert.equal(fullMatchSizeLedger.nativeEventError, undefined);
assert.equal(fullMatchSizeLedger.result.hybridEvaluation.ledger.fullDataset, true);
assert.equal(fullMatchSizeLedger.result.hybridEvaluation.decisionRows.length, 300);
assert.equal(nativeLedger.result.hybridEvaluation.safety.reserveChecks, 1);
const retainedSafetyTail = await nativeLedgerLaunch((_rows, result) => {
  result.hybridEvaluation.safetyRows.shift();
  result.hybridEvaluation.dropped.safetyRows = 1;
});
assert.equal(retainedSafetyTail.nativeEventError, undefined);
assert.equal(retainedSafetyTail.result.hybridEvaluation.ledger.fullDataset, true);
assert.equal(retainedSafetyTail.result.hybridEvaluation.safety.reserveChecks, 1);
assert.equal(retainedSafetyTail.result.hybridEvaluation.coverage.unknownAttempts, 1);
const repeatedLaunch = await nativeLedgerLaunch();
const traversalIdentity = await nativeLedgerLaunch(() => {}, 2, false, "../../bound-run");
assert.equal(traversalIdentity.result.hybridEvaluation.ledger.fullDataset, true);
assert.equal(
  path.dirname(traversalIdentity.result.hybridEvaluation.eventFile),
  path.dirname(traversalIdentity.logPath),
);
assert.ok(!path.basename(traversalIdentity.logPath).includes("bound-run"));
assert.notEqual(repeatedLaunch.logPath, nativeLedger.logPath);
assert.notEqual(
  repeatedLaunch.result.hybridEvaluation.eventFile,
  nativeLedger.result.hybridEvaluation.eventFile,
);
for (const mutate of [
  (rows) => {
    rows[0].runIdentity = "wrong-run";
  },
  (_rows, result) => {
    result.hybridEvaluation.ledger.incrementalFile.policyEvents++;
  },
  (_rows, result) => {
    result.hybridEvaluation.ledger.incrementalFile.transitionEvents = 301;
  },
  (rows) => {
    rows.pop();
  },
  (rows) => {
    rows[1] = { ...rows[0] };
  },
  (_rows, result) => {
    delete result.hybridEvaluation.safety;
  },
  (_rows, result) => {
    result.hybridEvaluation.eventFile = path.join(temporary, "foreign-ledger");
  },
  (rows) => {
    rows.find((row) => row.kind === "hybrid-transition").baseReward++;
  },
  (_rows, result) => {
    result.hybridEvaluation.retainedLatencyMs[0]++;
  },
  (_rows, result) => {
    result.hybridEvaluation.safetyRows[0].emitted = false;
  },
  (_rows, result) => {
    result.hybridEvaluation.safetyRows[0].runIdentity = "tampered";
  },
  (_rows, result) => {
    result.hybridEvaluation.dropped.safetyRows++;
  },
  (rows) => {
    rows.find((row) => row.kind === "hybrid-latency").durationMs = -1;
  },
  (_rows, result) => {
    delete result.hybridEvaluation.dropped;
  },
  (_rows, result) => {
    result.hybridEvaluation.ledger.incrementalFile.fullDataset = false;
  },
  (rows, _result, file) => {
    fs.writeFileSync(file, rows.map(JSON.stringify).join("\n"), { flag: "wx" });
  },
  (_rows, _result, file) => {
    const fd = fs.openSync(file, "wx");
    fs.ftruncateSync(fd, nativeEventLimit + 1);
    fs.closeSync(fd);
  },
  (rows, _result, file) => {
    const bytes = Buffer.from(rows.map(JSON.stringify).join("\n") + "\n");
    bytes[bytes.indexOf("original-0")] = 255;
    fs.writeFileSync(file, bytes, { flag: "wx" });
  },
  (_rows, _result, file) => () => fs.appendFileSync(file, " "),
  (rows, _result, file) => {
    const target = path.join(temporary, "symlink-target.jsonl");
    fs.writeFileSync(target, rows.map(JSON.stringify).join("\n") + "\n");
    fs.symlinkSync(target, file);
  },
]) {
  const invalid = await nativeLedgerLaunch(mutate);
  assert.equal(invalid.result.hybridEvaluation.ledger.fullDataset, false);
  assert.equal(invalid.result.hybridEvaluation.decisionRows, undefined);
  assert.equal(invalid.result.hybridEvaluation.ledger.incrementalFile.fullDataset, false);
  assert.ok(invalid.nativeEventError);
}
for (const failed of [
  await nativeLedgerLaunch(() => {}, 1),
  await nativeLedgerLaunch(() => {}, 0, true),
]) {
  assert.notEqual(failed.result.hybridEvaluation.ledger.fullDataset, true);
  assert.equal(failed.result.hybridEvaluation.decisionRows, undefined);
  assert.equal(failed.result.hybridEvaluation.ledger.incrementalFile.fullDataset, false);
}
const modelPath = path.join(temporary, "model.json");
fs.writeFileSync(modelPath, JSON.stringify(nativeModel));
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureBundle = path.join(temporary, "fixture.user.js");
fs.copyFileSync(path.join(root, "openfront-helper.user.js"), fixtureBundle);
const fixtureEnvironment = { OFH_BUNDLE_PATH: fixtureBundle };
const bridge = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
  const { createBundledOpponentHarness } = await import('./scripts/headless/opponent-adapter.js');
  const snapshots = [];
  for (const mode of ['baseline', 'shadow', 'learned']) {
    process.env.OFH_HYBRID_COMBAT_MODE = mode;
    const harness = createBundledOpponentHarness();
    snapshots.push({ ...harness.window.__OFH_hybridCombatRun,
      diagnostics: harness.window.__OFH_hybridCombat.diagnostics(),
      model: harness.window.__OFH_hybridCombat.exportModel() });
  }
  process.stdout.write(JSON.stringify(snapshots), () => process.exit(0));
`,
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: path.join(root, "openfront-engine/tsconfig.json"),
      OFH_HYBRID_COMBAT_MODEL: modelPath,
      OFH_HYBRID_COMBAT_LEARNING: "0",
    },
  },
);
assert.equal(bridge.status, 0, bridge.stderr);
for (const snapshot of JSON.parse(bridge.stdout)) {
  assert.equal(snapshot.diagnostics.mode, snapshot.mode);
  assert.equal(snapshot.learning, false);
  assert.equal(snapshot.diagnostics.learning, false);
  assert.equal(snapshot.diagnostics.ready, true);
  assert.equal(snapshot.modelImported, true);
  assert.deepEqual(snapshot.model, nativeModel);
}
// The injected runner tests accumulation/resume only, with fabricated samples.
const incomingSamples = [];
const collectionRunner = async ({ seed, mode, modelPath: inputPath }) => {
  const snapshot = inputPath
    ? JSON.parse(fs.readFileSync(inputPath, "utf8"))
    : JSON.parse(JSON.stringify(nativeWindow.__OFH_hybridCombat.exportModel()));
  incomingSamples.push(snapshot.models.wait.samples);
  for (const native of Object.values(snapshot.models)) native.samples++;
  return {
    seed,
    mode,
    code: 2,
    signal: null,
    start: {
      engineFingerprint: {
        revision: execFileSync(
          // eslint-disable-next-line sonarjs/no-os-command-from-path -- exercise the same installed Git as the portable native harness
          "git",
          ["-C", path.join(root, "openfront-engine"), "rev-parse", "HEAD"],
          { encoding: "utf8", env: foreignGitEnvironment() },
        ).trim(),
        diffHash: createHash("sha256")
          .update(
            execFileSync(
              // eslint-disable-next-line sonarjs/no-os-command-from-path -- exercise the same installed Git as the portable native harness
              "git",
              ["-C", path.join(root, "openfront-engine"), "diff", "HEAD", "--binary"],
              { env: foreignGitEnvironment() },
            ),
          )
          .digest("hex"),
      },
      mapFingerprint: "fixture",
    },
    result: {
      seed,
      stopReason: "max_ticks",
      hybridCombat: {
        mode,
        learning: true,
        diagnostics: { mode, learning: true },
        model: snapshot,
      },
    },
  };
};
const first = await evaluate(
  {
    collect: true,
    seeds: ["train-a", "train-b"],
    timeoutMs: 100,
    out: path.join(temporary, "first"),
  },
  fixtureEnvironment,
  collectionRunner,
);
const exportedPath = path.join(first.outDir, "trained-model.json");
const resumed = await evaluate(
  {
    collect: true,
    model: exportedPath,
    seeds: ["train-c"],
    timeoutMs: 100,
    out: path.join(temporary, "resumed"),
  },
  fixtureEnvironment,
  collectionRunner,
);
assert.deepEqual(incomingSamples, [0, 1, 2]);
assert.equal(resumed.report.counts.success, 1);
assert.deepEqual(resumed.report.cumulativeCounts, { success: 3, errors: 0, horizonRuns: 3 });
assert.equal(first.report.counts.horizonRuns, 2);
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(resumed.outDir, "trained-model.json"), "utf8"))
    .trainingSeeds,
  ["train-a", "train-b", "train-c"],
);
const paritySeeds = [
  "Aa",
  "BB",
  "zzzzzz",
  "BLCNFN]",
  "",
  "polygenelubricants",
  "😀",
  "é",
  ...Array.from({ length: 256 }, (_, i) => `seed-parity-${i}`),
];
const nativeHashes = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { simpleHash } from './openfront-engine/src/core/Util.ts'; " +
        "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(simpleHash)));",
      JSON.stringify(paritySeeds),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "openfront-engine/tsconfig.json") },
    },
  ),
);
const portHashes = executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/portutil.js") + "\nparitySeeds.map(simpleHash);",
  { paritySeeds },
  { timeout: 1000 },
);
assert.deepEqual(
  Array.from(portHashes),
  nativeHashes,
  "ported seed identities match the real engine",
);
assert.deepEqual(nativeHashes.slice(0, 4), [2112, 2112, 685785664, 685785664]);
const savedCollection = JSON.parse(fs.readFileSync(exportedPath, "utf8"));
const collisionCases = [
  { collect: true, seeds: [zeroSeed, oneSeed] },
  { collect: false, seeds: [oneSeed], trainingSeeds: [zeroSeed] },
  { collect: true, seeds: [zeroSeed], trainingSeeds: [oneSeed] },
  { collect: true, seeds: ["Aa", "BB"] },
  { collect: true, seeds: ["zzzzzz", "BLCNFN]"] },
  { collect: false, seeds: ["Aa", "BB"], trainingSeeds: ["train-a"] },
  { collect: false, seeds: ["BB"], trainingSeeds: ["Aa"] },
  { collect: true, seeds: ["BB"], trainingSeeds: ["Aa"] },
  { collect: false, seeds: ["BLCNFN]"], trainingSeeds: ["zzzzzz"] },
  { collect: false, seeds: ["holdout"], trainingSeeds: ["Aa", "BB"] },
  { collect: true, seeds: ["Aa"], trainingSeeds: ["Aa"] },
];
const collisionResults = [];
for (const [i, { trainingSeeds, ...options }] of collisionCases.entries()) {
  if (trainingSeeds) {
    options.model = path.join(temporary, `collision-model-${i}.json`);
    fs.writeFileSync(
      options.model,
      JSON.stringify({
        ...savedCollection,
        trainingSeeds,
      }),
    );
  }
  const [result] = await Promise.allSettled([
    evaluate(
      { ...options, timeoutMs: 100, out: path.join(temporary, `collision-${i}`) },
      fixtureEnvironment,
      () => assert.fail("effective seed collisions must be rejected before any runner call"),
    ),
  ]);
  collisionResults.push(result);
}
for (const result of collisionResults) {
  assert.equal(result.status, "rejected");
  assert.match(
    result.reason.message,
    /effective engine PRNG/,
    "reject the alias itself, before running",
  );
}
await assert.rejects(
  evaluate(
    { collect: false, model: exportedPath, seeds: ["holdout"], timeoutMs: 100 },
    fixtureEnvironment,
    collectionRunner,
  ),
  /Cold/,
);
// Connected CLI workflow uses native recorded outcome APIs, never hand-written
// neural weights or readiness counters. Match state/receipts below are fixtures;
// Task4 owns the real-engine producer integration and actual safety measurement.
const workflowRealm = {
  window: {},
  state: { settings: { winFixes: true } },
  PlayerType: { Bot: "BOT" },
};
const NativePolicy = executeClassicScript(`${nativeSource}\nHybridCombatPolicy;`, workflowRealm);
const fingerprint = first.report.runs[0].start.engineFingerprint;
const nativeWorkflowRunner = async ({ seed, mode, learning, modelPath }) => {
  const fullEvents = [];
  workflowRealm.roundLogRecord = (_kind, event) =>
    fullEvents.push(JSON.parse(JSON.stringify(event)));
  const policy = new NativePolicy({ storage: null, ledgerCapacity: 512 });
  policy.importModel(JSON.parse(fs.readFileSync(modelPath, "utf8")));
  policy.configure({ mode, learning });
  let tick = 1;
  let tiles = 100;
  let attacks = [];
  const target = {
    smallID: () => 2,
    type: () => "NATION",
    isPlayer: () => true,
    isAlive: () => true,
    numTilesOwned: () => 100,
    troops: () => 20,
  };
  const behavior = {
    player: {
      troops: () => 100,
      numTilesOwned: () => tiles,
      sharesBorderWith: () => true,
      isFriendly: () => false,
    },
    game: { config: () => ({ maxTroops: () => 200 }), numLandTiles: () => 10000 },
    currentAttackDecisionTick: () => tick,
    incomingHostileAttackPressure: () => 0,
    getEarlyGameSpendableTroops: () => 50,
    getPlayerAttackPreferredTroopFloor: () => 40,
    getEarlyGameLiveReserveTroops: () => 50,
    getCommittedOutboundAttackTroopsForTarget: () => 0,
    getLiveOutboundAttackTroopsForTarget: () => 0,
    outboundPlayerAttackCommitments: () => ({ targetsByKey: new Map(), committedByKey: new Map() }),
    getOutboundTargetCommitmentSnapshot: () => [],
    getOutboundAttackSnapshot: () => attacks,
    getOutboundTransportSnapshot: () => [],
    outboundTransportTargets: new Map(),
    botAttackPendingIntentCommitments: [],
    botPendingDonationIntentCommitments: [],
    getOutboundAttackTargetKey: () => "2",
    canAttackPlayerNow: () => true,
    canFundLandAttack: () => true,
    hybridCombatGeometry: () => ({
      targetSmallID: 2,
      tick,
      source: "native-border-centroid-v1",
      own: { x: 0, y: 0 },
      target: { x: 60, y: 80 },
      width: 100,
      height: 100,
    }),
    sendAttack: async () => false,
  };
  if (mode === "shadow") {
    for (let i = 0; i < 20; i++) {
      await policy.decide(behavior, [target]);
      tick++;
      tiles += learning ? -1 : 1;
      policy.observe(behavior);
      const captured = policy.actionObservation(behavior, target);
      policy.recordAcceptedAction(behavior, target, captured, policy.generation);
      tick++;
      attacks = [{ id: `native-fixture-receipt-${i}`, target, targetKey: "2", troops: 1 }];
      policy.observe(behavior);
      attacks = [];
      tiles += 2;
      tick += 10;
      policy.observe(behavior);
    }
  }
  const diagnostics = JSON.parse(JSON.stringify(policy.diagnostics()));
  return {
    ...run(seed, mode, mode === "learned"),
    start: { ...run(seed, mode, false).start, engineFingerprint: fingerprint },
    result: {
      ...run(seed, mode, mode === "learned").result,
      hybridCombat: {
        mode,
        learning,
        modelImported: true,
        diagnostics,
        model: JSON.parse(JSON.stringify(policy.exportModel())),
      },
      hybridEvaluation: {
        replay: JSON.parse(JSON.stringify(policy.rawReplay())),
        ledger: { entries: fullEvents, fullDataset: true, dropped: 0 },
      },
    },
  };
};
const frontierCollection = await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    "feature-profile": "frontier-v1",
    seeds: ["frontier-train"],
    timeoutMs: 100,
    out: path.join(temporary, "frontier-collect"),
  },
  fixtureEnvironment,
  async (input) => {
    const snapshot = JSON.parse(fs.readFileSync(input.modelPath, "utf8"));
    assert.equal(snapshot.schema, "ofh-combat-compact-tanh-v3");
    assert.equal(snapshot.featureProfile, "frontier-v1");
    const match = run(input.seed, input.mode, false);
    return {
      ...match,
      start: { ...match.start, engineFingerprint: fingerprint },
      result: {
        ...match.result,
        hybridCombat: {
          mode: input.mode,
          learning: input.learning,
          diagnostics: { mode: input.mode, learning: input.learning },
          model: snapshot,
        },
      },
    };
  },
);
const frontierFile = path.join(frontierCollection.outDir, "trained-model.json");
await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    "feature-profile": "frontier-v1",
    model: frontierFile,
    seeds: ["frontier-resume"],
    timeoutMs: 100,
    out: path.join(temporary, "frontier-resume"),
  },
  fixtureEnvironment,
  async (input) => {
    const snapshot = JSON.parse(fs.readFileSync(input.modelPath, "utf8"));
    assert.equal(snapshot.schema, "ofh-combat-compact-tanh-v3");
    const match = run(input.seed, input.mode, false);
    return {
      ...match,
      start: { ...match.start, engineFingerprint: fingerprint },
      result: {
        ...match.result,
        hybridCombat: {
          mode: input.mode,
          learning: input.learning,
          diagnostics: { mode: input.mode, learning: input.learning },
          model: snapshot,
        },
      },
    };
  },
);
const nativeExport = await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    seeds: ["native-ledger-export"],
    timeoutMs: 100,
    out: path.join(temporary, "native-ledger-export"),
  },
  fixtureEnvironment,
  async (input) => {
    const match = await nativeWorkflowRunner(input);
    const native = await nativeLedgerLaunch(() => {}, 0, false, input.runID);
    match.result.hybridEvaluation = native.result.hybridEvaluation;
    return match;
  },
);
const nativeExportRows = fs
  .readFileSync(nativeExport.report.ledgerDataset.path, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(nativeExportRows[0].metadata.recordCount, 600);
assert.equal(nativeExportRows[0].metadata.eventScope, "policy-events-only");
assert.equal(
  nativeExportRows.filter((row) => row.event?.kind === "hybrid-combat-decision").length,
  300,
);
assert.equal(nativeExportRows[0].metadata.coverage[0].fullDataset, true);
assert.equal(nativeExportRows[0].metadata.coverage[0].dropped, 0);
assert.equal(nativeExportRows[1].event.modelIdentity, "original-0");
assert.equal(
  nativeExportRows.find((row) => row.event?.kind === "hybrid-combat-outcome").event.modelIdentity,
  "original-outcome-model-0",
);
assert.equal(nativeExportRows.at(-1).event.modelIdentity, "original-outcome-model-299");
assert.equal(nativeExportRows[1].event.runIdentity, nativeExportRows[1].manifest.runID);
const savedNativeRun = JSON.parse(
  fs.readFileSync(
    path.join(
      nativeExport.outDir,
      `shadow-${createHash("sha256").update("native-ledger-export").digest("hex").slice(0, 16)}.json`,
    ),
    "utf8",
  ),
);
assert.equal(savedNativeRun.frozenVerified, true);
assert.deepEqual(savedNativeRun.launch, nativeExportRows[1].manifest);
assert.deepEqual(savedNativeRun.result, nativeExport.report.runs[0].result);

const neuralCollection = await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    seeds: ["neural-train"],
    timeoutMs: 100,
    out: path.join(temporary, "neural-collect"),
  },
  fixtureEnvironment,
  nativeWorkflowRunner,
);
const neuralFile = path.join(neuralCollection.outDir, "trained-model.json");
await assert.rejects(
  evaluate(
    {
      collect: true,
      policy: "compact-neural",
      "feature-profile": "frontier-v1",
      model: neuralFile,
      seeds: ["profile-mismatch"],
      timeoutMs: 100,
      out: path.join(temporary, "profile-mismatch"),
    },
    fixtureEnvironment,
    () => assert.fail("profile mismatch must fail before launch"),
  ),
  /feature profile mismatch/,
);
const neuralSaved = JSON.parse(fs.readFileSync(neuralFile, "utf8"));
assert.equal(neuralSaved.model.schema, "ofh-combat-compact-tanh-v2");
assert.ok(
  neuralSaved.model.models.target.samples >= 13,
  "recorded receipts actually train the target head",
);
assert.equal(neuralCollection.report.counts.success, 1);
const neuralFrozen = await evaluate(
  {
    collect: true,
    frozenReplay: true,
    policy: "compact-neural",
    model: neuralFile,
    seeds: ["neural-frozen"],
    timeoutMs: 100,
    out: path.join(temporary, "neural-frozen"),
  },
  fixtureEnvironment,
  nativeWorkflowRunner,
);
const datasetLines = fs
  .readFileSync(neuralFrozen.report.ledgerDataset.path, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(datasetLines[0].metadata.recordCount, datasetLines.length - 1);
assert.equal(datasetLines.filter((row) => row.event?.kind === "hybrid-combat-outcome").length, 40);
assert.ok(datasetLines.some((row) => row.event?.kind === "hybrid-combat-decision"));
const originalRow = datasetLines.find((row) => row.event?.kind === "hybrid-combat-outcome");
assert.equal(originalRow.event.modelIdentity, JSON.stringify(neuralSaved.model));
const selectionFile = path.join(temporary, "selection.json");
fs.writeFileSync(
  selectionFile,
  JSON.stringify({
    manifest: originalRow.manifest,
    episodeId: originalRow.event.episodeId,
    generation: originalRow.event.generation,
    modelIdentity: originalRow.event.modelIdentity,
  }),
);
for (const coverage of [
  [{ ...datasetLines[0].metadata.coverage[0], fullDataset: false, dropped: 39 }],
  [{ ...datasetLines[0].metadata.coverage[0], fullDataset: true, dropped: 39 }],
  [],
]) {
  const partial = path.join(
    temporary,
    `partial-${coverage.length}-${coverage[0]?.fullDataset}.jsonl`,
  );
  const metadata = { ...datasetLines[0].metadata, coverage, recordCount: 1 };
  fs.writeFileSync(partial, `${JSON.stringify({ metadata })}\n${JSON.stringify(originalRow)}\n`);
  await assert.rejects(
    () =>
      evaluate(
        {
          collect: true,
          policy: "compact-neural",
          seeds: ["neural-frozen"],
          replay: partial,
          selection: selectionFile,
          timeoutMs: 100,
          out: path.join(temporary, "partial-fit"),
        },
        fixtureEnvironment,
      ),
    /Incomplete selected replay coverage/,
    "imported retained subset cannot become a complete fit",
  );
}
const anchored = await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    seeds: ["neural-frozen"],
    anchors: true,
    replay: neuralFrozen.report.ledgerDataset.path,
    selection: selectionFile,
    timeoutMs: 100,
    out: path.join(temporary, "neural-anchors"),
  },
  fixtureEnvironment,
);
assert.equal(anchored.report.summary.fitted, 40);
assert.ok(anchored.report.summary.anchors > 0);
assert.equal(anchored.report.exclusions.length, 0);
const shaped = await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    seeds: ["neural-frozen"],
    replay: neuralFrozen.report.ledgerDataset.path,
    selection: selectionFile,
    "potential-shaping": { gammaTick: 0.9, potentialID: "observed-own-land-share-v1" },
    timeoutMs: 100,
    out: path.join(temporary, "neural-shaped"),
  },
  fixtureEnvironment,
);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(shaped.outDir, "trained-model.json"), "utf8")).model.reward,
  "potential-shaped-land-delta-ticks-v2",
);
const neuralHoldout = await evaluate(
  {
    // Programmatic callers may omit collect; frozen learning must still be false.
    policy: "compact-neural",
    model: path.join(anchored.outDir, "trained-model.json"),
    seeds: ["neural-holdout"],
    timeoutMs: 100,
    out: path.join(temporary, "neural-holdout"),
  },
  fixtureEnvironment,
  (input) => {
    assert.equal(input.learning, false, "omitted collect must launch frozen learning as a boolean");
    return nativeWorkflowRunner(input);
  },
);
// Round-trip the producer's actual saved launches and ledger header, rather
// than filling in learning on consumer fixtures or restamping native evidence.
for (const [evaluation, expectedLearning] of [
  [neuralCollection, true],
  [neuralFrozen, false],
  [neuralHoldout, false],
]) {
  const header = JSON.parse(
    fs.readFileSync(evaluation.report.ledgerDataset.path, "utf8").split("\n")[0],
  ).metadata;
  const savedReport = JSON.parse(
    fs.readFileSync(path.join(evaluation.outDir, "evaluation.json"), "utf8"),
  );
  for (const run of evaluation.report.runs) {
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(
          evaluation.outDir,
          `${run.launch.mode}-${createHash("sha256").update(run.launch.seed).digest("hex").slice(0, 16)}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(saved.launch.learning, expectedLearning);
    assert.equal(saved.result.hybridCombat.learning, expectedLearning);
    assert.equal(saved.result.hybridCombat.diagnostics.learning, expectedLearning);
    assert.deepEqual(saved.launch, run.launch);
    assert.deepEqual(
      header.manifests.find((manifest) => manifest.runID === run.launch.runID),
      saved.launch,
    );
    assert.deepEqual(
      savedReport.runs.find((item) => item.launch.runID === run.launch.runID).launch,
      saved.launch,
    );
  }
}
// Simulate changed evaluator bytes on read only; never mutate shared sources.
const frozenSourceRead = fs.readFileSync;
let sourceReadDrift = false;
const sourceDriftOut = path.join(temporary, "learning-source-drift");
fs.readFileSync = function (file, ...args) {
  const bytes = frozenSourceRead.call(this, file, ...args);
  if (sourceReadDrift && file === path.join(root, "scripts/headless/evaluate-hybrid-combat.mjs")) {
    return typeof bytes === "string" ? bytes + "\n" : Buffer.concat([bytes, Buffer.from("\n")]);
  }
  return bytes;
};
try {
  await assert.rejects(
    evaluate(
      {
        policy: "compact-neural",
        model: neuralFile,
        seeds: ["learning-source-drift"],
        timeoutMs: 100,
        out: sourceDriftOut,
      },
      fixtureEnvironment,
      async (input) => {
        assert.equal(input.learning, false);
        const result = await nativeWorkflowRunner(input);
        sourceReadDrift = true;
        return result;
      },
    ),
    /Frozen harnessHash drift/,
  );
} finally {
  fs.readFileSync = frozenSourceRead;
}
assert.equal(fs.existsSync(path.join(sourceDriftOut, "evaluation.json")), false);
assert.equal(neuralHoldout.report.completedPairs, 1);
assert.equal(neuralHoldout.report.runs.length, 3);
assert.equal(neuralHoldout.report.runs[0].result.phase, "result");
assert.deepEqual(
  neuralHoldout.report.runs[0].result.hybridCombat.model,
  JSON.parse(fs.readFileSync(path.join(anchored.outDir, "trained-model.json"), "utf8")).model,
);
await assert.rejects(
  evaluate(
    { collect: true, policy: "ridge", model: neuralFile, seeds: ["kind-mismatch"], timeoutMs: 100 },
    fixtureEnvironment,
    () => assert.fail("kind mismatch must fail before launch"),
  ),
  /kind mismatch/,
);
const obsoleteFile = path.join(temporary, "obsolete.json");
const obsolete = structuredClone(neuralSaved);
delete obsolete.normalizerHash;
fs.writeFileSync(obsoleteFile, JSON.stringify(obsolete));
await assert.rejects(
  evaluate(
    {
      collect: false,
      policy: "compact-neural",
      model: obsoleteFile,
      seeds: ["old-provenance"],
      timeoutMs: 100,
    },
    fixtureEnvironment,
    () => assert.fail("old provenance must fail before launch"),
  ),
  /normalizerHash/,
);
await assert.rejects(
  evaluate(
    {
      collect: true,
      policy: "compact-neural",
      seeds: ["drift"],
      timeoutMs: 100,
      out: path.join(temporary, "model-drift"),
    },
    fixtureEnvironment,
    async (input) => {
      const result = await nativeWorkflowRunner(input);
      fs.appendFileSync(input.modelPath, " ");
      return result;
    },
  ),
  /Frozen model file drift/,
);
const requirements = {
  version: 1,
  cells: ["alps"],
  minimumPairsPerCell: 1,
  minimumWinDifference: 0,
  maximumSignTestP: 1,
  noCellRegression: true,
  minimumControlledDecisions: 1,
  minimumReserveChecks: 1,
  minimumLegalityChecks: 1,
  maximumReserveViolations: 0,
  maximumIllegalEmissions: 0,
  maximumLatencyMs: 5,
  minimumLatencySamples: 1,
  maximumBudgetRejections: 0,
  safetyScope: "learned-attack-gate",
  requireKnownSafetyCoverage: true,
};
const requirementsFile = path.join(temporary, "requirements.json");
fs.writeFileSync(requirementsFile, JSON.stringify(requirements));
const requirementsHash = createHash("sha256")
  .update(JSON.stringify(requirements, Object.keys(requirements).sort()))
  .digest("hex");
const preregOptions = {
  collect: false,
  policy: "compact-neural",
  model: neuralFile,
  seeds: ["prereg-holdout"],
  cohorts: { version: 1, cells: [{ name: "alps", seeds: ["prereg-holdout"], expected: {} }] },
  requirements: requirementsFile,
  timeoutMs: 100,
  out: path.join(temporary, "preregistered"),
};
const preregistered = await evaluate(preregOptions, fixtureEnvironment, async (input) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(input.outDir, "manifest.json"), "utf8"));
  assert.equal(
    manifest.requirementsHash,
    requirementsHash,
    "requirements binding must exist before every launch",
  );
  assert.equal(manifest.requirementsFrozenBeforeLaunch, true);
  preregOptions.cohorts = {
    version: 1,
    cells: [{ name: "posthoc", seeds: ["prereg-holdout"], expected: {} }],
  };
  return nativeWorkflowRunner(input);
});
assert.deepEqual(
  preregistered.report.coverage.cells.map((cell) => cell.name),
  ["alps"],
  "caller field replacement cannot change predeclared cell selection after results",
);
assert.equal(preregistered.report.requirementsHash, requirementsHash);
assert.equal(preregistered.report.eligibility.registration, "preregistered-report-bound");
assert.equal(
  preregistered.report.eligibility.eligible,
  false,
  "missing actual safety/latency must block even preregistered fixtures",
);
await assert.rejects(
  evaluate(
    {
      collect: true,
      policy: "compact-neural",
      seeds: ["requirements-drift"],
      requirements: requirementsFile,
      timeoutMs: 100,
      out: path.join(temporary, "requirements-drift"),
    },
    fixtureEnvironment,
    async (input) => {
      const result = await nativeWorkflowRunner(input);
      fs.appendFileSync(requirementsFile, " ");
      return result;
    },
  ),
  /Frozen requirements file drift/,
);
// Authoritative native server predicate is exercised in a bounded separate realm.
// House rejects are never delivered to the native bucket (subset, not equality).
const rateParity = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
  import assert from 'node:assert/strict';
  import { ClientMsgRateLimiter } from './openfront-engine/src/server/ClientMsgRateLimiter.ts';
  import { houseIntentBudgetOracle } from './scripts/headless/evaluate-hybrid-combat.mjs';
  let now = 0;
  globalThis.performance = { now: () => now };
  const events = Array.from({ length: 610 }, (_, i) => ({ atMs: Math.floor(i / 10) * 1000 }));
  const house = houseIntentBudgetOracle(events);
  const native = new ClientMsgRateLimiter();
  for (const event of house.results) {
    now = event.atMs;
    if (event.accepted) assert.equal(native.check('PROBE001', 'intent', 1), 'ok');
  }
  assert.equal(house.snapshot.accepted, 149);
  assert.equal(house.serverReceiptClaim, false);
  process.stdout.write('native server/house rate subset passed\\n');
`,
  ],
  { cwd: root, encoding: "utf8", timeout: 15000 },
);
assert.equal(rateParity.status, 0, rateParity.stderr || rateParity.error?.message);
assert.match(rateParity.stdout, /rate subset passed/);
fs.rmSync(temporary, { recursive: true });
process.stdout.write(
  "hybrid combat evaluation tests passed (plumbing only; no simulation or combat-quality claim)\n",
);
