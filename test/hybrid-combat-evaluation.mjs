import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
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
assert.equal(
  parseArgs(["--collect", "--policy", "compact-neural", "--seeds", "a", "--timeout-ms", "100"])
    .policy,
  "compact-neural",
);
assert.throws(
  () => parseArgs(["--collect", "--policy", "ppo", "--seeds", "a", "--timeout-ms", "100"]),
  /policy/,
);

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
assert.equal(datasetLines[0].metadata.recordCount, 40);
const originalRow = datasetLines[1];
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
    collect: false,
    policy: "compact-neural",
    model: path.join(anchored.outDir, "trained-model.json"),
    seeds: ["neural-holdout"],
    timeoutMs: 100,
    out: path.join(temporary, "neural-holdout"),
  },
  fixtureEnvironment,
  nativeWorkflowRunner,
);
assert.equal(neuralHoldout.report.completedPairs, 1);
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
