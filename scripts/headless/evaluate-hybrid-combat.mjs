// Collect: node scripts/headless/evaluate-hybrid-combat.mjs --collect --seeds train-01,train-02 --timeout-ms 60000
// Holdout: node scripts/headless/evaluate-hybrid-combat.mjs --model /path/trained-model.json --seeds holdout-01,holdout-02 --timeout-ms 60000
// OFH_* match settings are shared by every mode. Tick caps are censored, never losses.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { foreignGitEnvironment } from "../git-environment.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modes = ["baseline", "shadow", "learned"];
const format = "ofh-hybrid-combat-evaluation-v1";
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const save = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

export function validateProvenance(saved, current) {
  for (const key of ["bundleHash", "sourceHash", "engineRevision", "engineDiffHash"]) {
    assert.equal(saved[key], current[key], `Model provenance mismatch: ${key}`);
  }
}

export function parseArgs(argv) {
  const options = { collect: false };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === "--collect") options.collect = true;
    else if (["--seeds", "--model", "--out", "--timeout-ms"].includes(name)) {
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
  return options;
}

function executeTrustedScript(source, sandbox) {
  // Trusted repository classic scripts only; seed names and model JSON remain data.
  // eslint-disable-next-line sonarjs/code-eval
  return vm.runInNewContext(source, sandbox, { timeout: 1000 });
}

function validateSeedIdentities(seeds, trainingSeeds) {
  const source = fs.readFileSync(
    path.join(projectRoot, "engine/ingame/auto-bot/portutil.js"),
    "utf8",
  );
  const values = Array.from(
    executeTrustedScript(source + "\nseeds.map(simpleHash);", {
      seeds: [...trainingSeeds, ...seeds],
    }),
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

export function validateModel(model, source, requireReady = true) {
  const window = {};
  executeTrustedScript(source, { window, console, performance });
  const api = window.__OFH_hybridCombat;
  assert.ok(api?.importModel && api?.diagnostics, "Native hybrid combat API unavailable");
  assert.notEqual(api.importModel(model), false, "Unsupported native model snapshot");
  api.configure({ mode: "learned", learning: false });
  const diagnostics = api.diagnostics();
  assert.ok(
    !requireReady || diagnostics.ready === true || diagnostics.modelReady === true,
    "Cold or unsupported snapshot: native diagnostics must report ready/modelReady=true",
  );
  return api.exportModel();
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
    code: run.code,
    timedOut: run.timedOut ?? false,
    error: run.error ?? null,
    signal: run.signal ?? null,
    logPath: run.logPath,
  };
}

export function scorePairedRuns(runs, seeds, modelHash) {
  const pairs = seeds.map((seed) => {
    const selected = modes.map((mode) => {
      const entries = runs.filter((run) => run.seed === seed && run.mode === mode);
      assert.equal(entries.length, 1, `Expected one ${mode} run for ${seed}`);
      return entries[0];
    });
    const configuration = selected[0].start;
    const configMatches =
      Boolean(configuration?.engineFingerprint && configuration?.mapFingerprint) &&
      selected.every((run) => canonical(run.start) === canonical(configuration));
    const outcomes = Object.fromEntries(
      selected.map((run) => [run.mode, runOutcome(run, seed, configMatches, modelHash)]),
    );
    return { seed, configMatches, configuration, outcomes };
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
    learnedMinusBaselineWins: completedPairs.length
      ? summary.learned.wins - summary.baseline.wins
      : null,
    pairs,
    evidence:
      "Real-engine headless holdout only. Win rates use terminal, verified, fully paired outcomes; tick caps, failures and mode/model mismatches are excluded. Candidate decision pairs count diagnostics.decisions in shadow and learned, not accepted orders or learned control. Diagnostics and raw logs show inference/fallback activity. No external model integration, live-browser performance, or statistical superiority is established.",
  };
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
}) {
  const logPath = path.join(outDir, `${mode}-${hash(seed).slice(0, 16)}.log`);
  const descriptor = fs.openSync(logPath, "wx");
  return new Promise((resolve) => {
    const child = spawn(
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
      resolve({
        seed,
        mode,
        code,
        signal,
        timedOut,
        interrupted,
        error,
        logPath,
        ...readRecords(fs.readFileSync(logPath, "utf8")),
      });
    });
  });
}

function evaluationInputs(environment) {
  const source = fs.readFileSync(
    path.join(projectRoot, "engine/ingame/auto-bot/hybridCombat.js"),
    "utf8",
  );
  const engineRoot = path.join(projectRoot, "openfront-engine");
  const bundleInput = path.resolve(
    environment.OFH_BUNDLE_PATH ?? path.join(projectRoot, "openfront-helper.user.js"),
  );
  const provenance = {
    bundleHash: hash(fs.readFileSync(bundleInput)),
    sourceHash: hash(source),
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
  return { source, bundleInput, provenance };
}

function initialModel(options, { source, provenance }) {
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
    validateProvenance(saved, provenance);
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
  } else validateSeedIdentities(options.seeds, trainingSeeds);
  return { model, trainingSeeds, collectionCounts };
}

function prepareOutput(
  options,
  environment,
  { bundleInput, provenance },
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
  save(path.join(outDir, "manifest.json"), {
    format,
    seeds: options.seeds,
    trainingSeeds,
    collect: options.collect,
    timeoutMs: options.timeoutMs,
    ...provenance,
    environment: Object.fromEntries(
      Object.entries(environment).filter(([key]) => key.startsWith("OFH_") || key === "GAME_ENV"),
    ),
  });
  return { outDir, bundlePath, modelPath };
}

function acceptsCollection(run, seed) {
  if (runFailed(run) || !run.provenanceMatches || run.result.seed !== seed) return false;
  return (
    policyConfigurationMatches(run.result.hybridCombat, "shadow", true) &&
    run.result.hybridCombat.model != null
  );
}

async function evaluationRuns(options, environment, runner, context, state) {
  const { source, provenance, outDir, bundlePath } = context;
  let { modelPath } = context;
  const runs = [];
  for (const seed of options.seeds) {
    for (const mode of options.collect ? ["shadow"] : modes) {
      process.stdout.write(`[hybrid] ${mode} ${seed}\n`);
      const run = await runner({
        seed,
        mode,
        learning: options.collect,
        modelPath,
        bundlePath,
        outDir,
        timeoutMs: options.timeoutMs,
        environment,
      });
      run.provenanceMatches =
        run.start?.engineFingerprint?.revision === provenance.engineRevision &&
        run.start?.engineFingerprint?.diffHash === provenance.engineDiffHash;
      if (options.collect) run.collectionAccepted = acceptsCollection(run, seed);
      runs.push(run);
      save(path.join(outDir, `${mode}-${hash(seed).slice(0, 16)}.json`), run);
      assert.ok(
        !run.interrupted,
        "Evaluation interrupted; child stopped and raw evidence retained",
      );
      if (options.collect && run.collectionAccepted) {
        state.model = validateModel(run.result.hybridCombat.model, source, false);
        modelPath = path.join(outDir, `collected-${hash(seed).slice(0, 16)}.json`);
        save(modelPath, state.model);
      }
    }
  }
  return runs;
}

export async function evaluate(options, environment = process.env, runner = runMatch) {
  const inputs = evaluationInputs(environment);
  const state = initialModel(options, inputs);
  const { trainingSeeds, collectionCounts } = state;
  const output = prepareOutput(options, environment, inputs, state);
  const runs = await evaluationRuns(options, environment, runner, { ...inputs, ...output }, state);
  const { outDir } = output;
  const report = options.collect
    ? {
        collection: true,
        seeds: runs.filter((run) => run.collectionAccepted).map((run) => run.seed),
        counts: {
          success: runs.filter((run) => run.collectionAccepted).length,
          errors: runs.filter((run) => !run.collectionAccepted).length,
          horizonRuns: runs.filter((run) => run.result?.stopReason === "max_ticks").length,
        },
        runs,
        evidence:
          "Online shadow observation only; exported samples are not evidence of improved combat or completed wins.",
      }
    : scorePairedRuns(runs, options.seeds, hash(canonical(state.model)));
  if (options.collect)
    report.cumulativeCounts = Object.fromEntries(
      Object.keys(collectionCounts).map((key) => [key, collectionCounts[key] + report.counts[key]]),
    );
  if (options.collect && state.model)
    save(path.join(outDir, "trained-model.json"), {
      format,
      trainingSeeds: [...new Set([...trainingSeeds, ...report.seeds])],
      model: state.model,
      ...inputs.provenance,
      collectionCounts: report.cumulativeCounts,
    });
  save(path.join(outDir, "evaluation.json"), report);
  return { outDir, report };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  const { outDir, report } = await evaluate(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ outDir, ...report }, null, 2)}\n`);
  process.exitCode = report.collection
    ? Number(report.counts.errors > 0)
    : Number(report.completedPairs !== report.requestedPairs);
}
