import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";
import {
  parseArgs,
  readRecords,
  scorePairedRuns,
  validateModel,
  validateProvenance,
  evaluate,
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

const nativeSource = fs.readFileSync(
  new URL("../engine/ingame/auto-bot/hybridCombat.js", import.meta.url),
  "utf8",
);
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
assert.equal(score.combatExercisedPairs, 2);
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
const modelPath = path.join(temporary, "model.json");
fs.writeFileSync(modelPath, JSON.stringify(nativeModel));
const root = fileURLToPath(new URL("../", import.meta.url));
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
          "/usr/bin/git",
          ["-C", path.join(root, "openfront-engine"), "rev-parse", "HEAD"],
          { encoding: "utf8", env: foreignGitEnvironment() },
        ).trim(),
        diffHash: createHash("sha256")
          .update(
            execFileSync(
              "/usr/bin/git",
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
  {},
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
  {},
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
await assert.rejects(
  evaluate(
    { collect: false, model: exportedPath, seeds: ["holdout"], timeoutMs: 100 },
    {},
    collectionRunner,
  ),
  /Cold/,
);
fs.rmSync(temporary, { recursive: true });
process.stdout.write(
  "hybrid combat evaluation tests passed (plumbing only; no simulation or combat-quality claim)\n",
);
