// Bounded native plumbing fixture; injected tiny world, no efficacy or promotion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game.ts";
import type { Intent } from "../openfront-engine/src/core/Schemas.ts";
import { Config } from "../openfront-engine/src/core/configuration/Config.ts";
import { createGame as createGameImpl } from "../openfront-engine/src/core/game/GameImpl.ts";
import { createGame, L } from "../openfront-engine/tests/core/pathfinding/_fixtures.ts";
import { GameRunner } from "../openfront-engine/src/core/GameRunner.ts";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager.ts";
import { SpawnExecution } from "../openfront-engine/src/core/execution/SpawnExecution.ts";
import { WinCheckExecution } from "../openfront-engine/src/core/execution/WinCheckExecution.ts";
import {
  BundledOpponentBot,
  createBundledOpponentHarness,
  createBuildMenu,
} from "../scripts/headless/opponent-adapter.js";
import { evaluate } from "../scripts/headless/evaluate-hybrid-combat.mjs";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";
import {
  canonical,
  hash,
  readLedger,
  validateTrajectory,
} from "../scripts/headless/hybrid-trajectory-contract.mjs";
import { fitTrajectory, loadNativeContract } from "../scripts/headless/train-hybrid-returns.mjs";

assert.equal(
  process.env.OFH_NATIVE_TRAJECTORY_RELEASE,
  "1",
  "Parent must explicitly release native execution",
);
assert.ok(process.env.OFH_NATIVE_TRAJECTORY_OUT, "Declare a new retained evidence directory");
const out = path.resolve(process.env.OFH_NATIVE_TRAJECTORY_OUT);
fs.mkdirSync(out); // Existing evidence is never overwritten.
const fixtureFile = fileURLToPath(import.meta.url);
const bundle = path.resolve(process.env.OFH_BUNDLE_PATH ?? "openfront-helper.user.js");
const features = Object.fromEntries(
  ["spawn", "expand", "build", "boat", "nuke", "warship", "alliance", "donate", "betray"].map(
    (name) => [name, false],
  ),
);
// These are the finite limits already exercised by hybrid-runtime-native.mts.
const limits = { immunityTicks: 2000, sendAttempts: 400, observationTicks: 160, winnerTicks: 20 };
const declaration = {
  version: "native-tiny-trajectory-fixture-v1",
  width: 32,
  height: 16,
  terrain: "all-land",
  instantBuild: true,
  maxTimerValue: 1,
  actor: "Human",
  targets: 17,
  targetType: "Nation",
  targetTroops: 1,
  ownTroopsAdded: 100000,
  actorRectangle: { xMin: 1, xMax: 30, yMin: 1, yMax: 14 },
  features,
  limits,
  winnerSchedule: "install-native-WinCheck-after-observations; one-minute-native-timer",
  bootstrap: "four-shadow-WAIT-outcomes-and-seventeen-native-strategic-attacks",
  proving: "one-frozen-learned-decision; observation-only-advancement",
  evidence: "injected-native-fixture-not-official-fullmatch",
  performanceClaim: false,
};
const environment = {
  ...process.env,
  OFH_BUNDLE_PATH: bundle,
  OFH_NATIVE_TRAJECTORY_FIXTURE_HASH: hash(fs.readFileSync(fixtureFile)),
  OFH_NATIVE_TRAJECTORY_CONFIGURATION: canonical(declaration),
};
function readEngineFingerprint() {
  return {
    revision: execFileSync("/usr/bin/git", ["-C", "openfront-engine", "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: foreignGitEnvironment(),
    }).trim(),
    diffHash: hash(
      execFileSync("/usr/bin/git", ["-C", "openfront-engine", "diff", "HEAD", "--binary"], {
        env: foreignGitEnvironment(),
      }),
    ),
  };
}
const fingerprint = readEngineFingerprint();
const write = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
write("fixture.json", {
  ...declaration,
  fixtureHash: environment.OFH_NATIVE_TRAJECTORY_FIXTURE_HASH,
  bundleHash: hash(fs.readFileSync(bundle)),
  fingerprint,
});

type NativeRun = {
  seed: string;
  mode: string;
  learning: boolean;
  modelPath: string;
  bundlePath: string;
  runID: string;
};
function createWorld(seed: string) {
  const terrain = createGame(
    {
      width: declaration.width,
      height: declaration.height,
      grid: Array(declaration.width * declaration.height).fill(L),
    },
    { instantBuild: true },
  );
  const config = new Config(
    { ...terrain.config().gameConfig(), maxTimerValue: declaration.maxTimerValue },
    null,
    false,
    false,
  );
  const game = createGameImpl([], [], terrain.map(), terrain.miniMap(), config);
  const spawn = (info: PlayerInfo, tile: number) => {
    const player = game.addPlayer(info);
    const execution = new SpawnExecution(seed, info, tile);
    execution.init(game, game.ticks());
    execution.tick(game.ticks());
    assert.equal(player.hasSpawned(), true);
    for (const owned of [...player.tiles()]) player.relinquish(owned);
    return player;
  };
  const me = spawn(
    new PlayerInfo("actor", PlayerType.Human, "actor001", "actor001"),
    game.ref(16, 8),
  );
  const targets = Array.from({ length: declaration.targets }, (_, i) => {
    const target = spawn(
      new PlayerInfo(`nation${i}`, PlayerType.Nation, null, `nation${i}`),
      game.ref(i + 2, 0),
    );
    target.conquer(game.ref(i + 2, 0));
    return target;
  });
  for (let y = declaration.actorRectangle.yMin; y <= declaration.actorRectangle.yMax; y++)
    for (let x = declaration.actorRectangle.xMin; x <= declaration.actorRectangle.xMax; x++)
      me.conquer(game.ref(x, y));
  // Suppress no observations: immunity precedes harness attachment and group start.
  for (let i = 0; game.isNationSpawnImmunityActive() && i < limits.immunityTicks; i++)
    game.executeNextTick();
  assert.equal(game.isNationSpawnImmunityActive(), false, "Native immunity exceeded fixture bound");
  me.addTroops(declaration.ownTroopsAdded);
  for (const target of targets) target.removeTroops(target.troops() - declaration.targetTroops);
  return { game, config, me, targets };
}

async function bootstrapNative(behavior, targets, bot, advance, drain) {
  for (let i = 0; i < 4; i++) {
    await behavior.decideHybridCombat(
      targets.map((target) => bot.api.game.playerBySmallID(target.smallID())),
    );
    await drain();
  }
  for (const target of targets) {
    const observed = bot.api.game.playerBySmallID(target.smallID());
    let sent = false;
    for (let attempt = 0; !sent && attempt < limits.sendAttempts; attempt++) {
      await behavior.prepareHybridCombatGeometry([observed]);
      sent = await behavior.sendAttack(observed);
      if (!sent) await advance();
    }
    assert.equal(sent, true, "Native shadow bootstrap send exhausted bound");
    await drain();
  }
  assert.equal(
    bot.harness.window.__OFH_hybridCombat.diagnostics().ready,
    true,
    "Observed bootstrap must produce readiness; never patch counts/weights",
  );
}

async function proveNative(behavior, targets, bot, policy, drain) {
  assert.equal(bot.harness.window.__OFH_hybridCombat.diagnostics().ready, true);
  await behavior.decideHybridCombat(
    targets.map((target) => bot.api.game.playerBySmallID(target.smallID())),
  );
  assert.equal(
    policy.proposal.controlledAction,
    "attack",
    "Actual fitted model must choose an accepted ACT; WAIT is not relabelled",
  );
  await drain();
  assert.ok(
    policy.diagnostics().control.confirmedLearnedAttacks >= 1,
    "Native learned receipt required",
  );
  const outcome = bot.harness.evidence
    .snapshot()
    .replay.records.find(
      (row: { action: string; learned: boolean; confirmed: boolean }) =>
        row.action === "attack" && row.learned === true && row.confirmed === true,
    );
  assert.ok(
    outcome?.receiptID && outcome.geometry?.frontier,
    "Native controlled frontier outcome required",
  );
}

const nativeRunner = async ({ seed, mode, learning, modelPath, bundlePath, runID }: NativeRun) => {
  const actualFingerprint = readEngineFingerprint();
  assert.equal(
    canonical(actualFingerprint),
    canonical(fingerprint),
    "Engine changed since fixture freeze",
  );
  const { game, config, me, targets } = createWorld(seed);
  const actualConfiguration = JSON.parse(
    canonical({ fixture: declaration, gameConfig: config.gameConfig() }),
  );
  const harness = createBundledOpponentHarness({
    bundlePath,
    runIdentity: runID,
    eventFile: path.join(out, `${runID}.events.jsonl`),
    evidenceCapacity: 1024,
    hybrid: { mode, learning, modelPath },
  });
  let failure: unknown;
  const runner = new GameRunner(game, new Executor(game, seed, "actor001"), (update) => {
    if ("errMsg" in update) failure = update.errMsg;
  });
  const bot = new BundledOpponentBot({ harness, winFixes: true, features, buildStructures: {} });
  try {
    bot.attach({ runner, clientID: "actor001", gameID: seed });
    await bot.api.beginTick(bot.pageGame.myPlayer());
    bot.nationBot.player = bot.api.game.myPlayer();
    bot.nationBot.initializeBehaviors();
    const current = harness.current;
    current.buildMenu = createBuildMenu(bot);
    const behavior = bot.nationBot.attackBehavior;
    const policy = harness.internals.hybridCombatPolicy;
    const api = harness.window.__OFH_hybridCombat;
    const originalIdentity = JSON.stringify(api.exportModel());
    assert.equal(api.exportModel().featureProfile, "frontier-v1");
    const orders: unknown[] = [];
    let turn = 0;
    const advance = async () => {
      const intents = bot.intentBuffer.splice(0);
      orders.push(...intents.map((intent: unknown) => ({ tick: game.ticks(), intent })));
      runner.addTurn({
        turnNumber: turn++,
        intents: intents.map((intent: Intent) => ({ ...intent, clientID: "actor001" })),
      });
      assert.equal(runner.executeNextTick(), true);
      assert.equal(failure, undefined);
      await bot.decide(); // Existing NationExecution observation path; feature flags disable decisions.
      current.buildMenu = createBuildMenu(bot);
    };
    const drain = async () => {
      for (let i = 0; i < limits.observationTicks && (i < 2 || policy.pending); i++)
        await advance();
      assert.equal(policy.pending, null, "Native receipt/outcome exceeded fixture bound");
    };
    if (learning) {
      assert.equal(mode, "shadow");
      await bootstrapNative(behavior, targets, bot, advance, drain);
    } else if (mode === "learned") await proveNative(behavior, targets, bot, policy, drain);
    // Declared fixture schedule: official timer/winner check, no direct setWinner.
    game.addExecution(new WinCheckExecution());
    for (let i = 0; !game.getWinner() && i < limits.winnerTicks; i++) await advance();
    const winner = game.getWinner();
    assert.ok(winner, "Native WinCheck did not terminate within fixture bound");
    assert.equal(typeof winner, "object", "Fixture expects native FFA player winner");
    assert.equal(winner, me, "Fixture's native timer winner must be the actor");
    bot.finalizeHybridCombatObservation("winner");
    if (!learning)
      assert.equal(
        JSON.stringify(api.exportModel()),
        originalIdentity,
        "Frozen original model changed",
      );
    const evidence = bot.getHybridEvaluationSnapshot();
    assert.equal(evidence.ledger.fullDataset, true);
    assert.equal(evidence.ledger.dropped, 0);
    const lines = fs
      .readFileSync(evidence.eventFile, "utf8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    assert.equal(
      canonical(lines.filter((event: { kind: string }) => event.kind !== "hybrid-transition")),
      canonical(evidence.ledger.entries),
      "Mc full ledger must equal actual incremental producer file",
    );
    const result = {
      phase: "result",
      seed,
      stopReason: "winner",
      won: true,
      winner: me.name(),
      alive: me.isAlive(),
      ticks: game.ticks(),
      hybridCombat: bot.getHybridCombatSnapshot(),
      hybridEvaluation: evidence,
      intentBudget: bot.getIntentBudgetSnapshot(),
      fixture: declaration,
    };
    write(`${runID}.fixture-proof.json`, {
      mode,
      learning,
      orders,
      actualConfiguration,
      engineFingerprint: actualFingerprint,
      result,
    });
    assert.equal(
      canonical(readEngineFingerprint()),
      canonical(actualFingerprint),
      "Engine drift during native run",
    );
    return {
      code: 0,
      interrupted: false,
      timedOut: false,
      signal: null,
      error: null,
      // Evaluator computes provenanceMatches against its frozen launch from this actual start fingerprint.
      seed,
      mode,
      start: {
        phase: "start",
        seed,
        map: "native-tiny-trajectory",
        engineFingerprint: actualFingerprint,
        actualConfiguration,
        configurationFingerprint: hash(canonical(actualConfiguration)),
        mapFingerprint: hash(
          canonical({
            width: declaration.width,
            height: declaration.height,
            terrain: declaration.terrain,
          }),
        ),
      },
      result,
    };
  } finally {
    harness.window.close();
  }
};

const cohorts = (seed: string) => ({
  version: 1,
  cells: [
    { name: "declared-native-tiny", seeds: [seed], expected: { map: "native-tiny-trajectory" } },
  ],
});
const online = await evaluate(
  {
    collect: true,
    policy: "compact-neural",
    "feature-profile": "frontier-v1",
    seeds: ["trajectory-native-bootstrap"],
    cohorts: cohorts("trajectory-native-bootstrap"),
    timeoutMs: 60000,
    out: path.join(out, "bootstrap"),
  },
  environment,
  nativeRunner,
);
assert.equal(online.report.counts.success, 1);
const collected = path.join(out, "bootstrap", "trained-model.json");
const evaluated = await evaluate(
  {
    collect: false,
    policy: "compact-neural",
    "feature-profile": "frontier-v1",
    model: collected,
    seeds: ["trajectory-native-frozen"],
    cohorts: cohorts("trajectory-native-frozen"),
    timeoutMs: 60000,
    out: path.join(out, "frozen"),
  },
  environment,
  nativeRunner,
);
const nativeRun = evaluated.report.runs.find((run: { mode: string }) => run.mode === "learned");
assert.ok(nativeRun?.frozenVerified, "Original native run freeze verification required");
assert.equal(nativeRun.code, 0, "Successful native fixture return code required");
assert.equal(
  nativeRun.launch.learning,
  false,
  "Frozen launch must explicitly declare learning OFF",
);
assert.equal(nativeRun.result.hybridCombat.learning, false);
assert.equal(nativeRun.result.hybridCombat.diagnostics.learning, false);
assert.equal(nativeRun.interrupted, false);
assert.equal(
  nativeRun.provenanceMatches,
  true,
  "Evaluator must verify actual engine against frozen launch",
);
assert.equal(nativeRun.start.engineFingerprint.revision, nativeRun.launch.engineRevision);
assert.equal(nativeRun.start.engineFingerprint.diffHash, nativeRun.launch.engineDiffHash);
assert.equal(nativeRun.start.phase, "start");
assert.equal(nativeRun.start.seed, nativeRun.launch.seed);
assert.equal(nativeRun.start.mapFingerprint, nativeRun.launch.mapFingerprint);
const dataset = readLedger(evaluated.report.ledgerDataset.path);
const first = dataset.records.find(
  (row: { manifest: { runID: string }; event: { kind: string } }) =>
    row.manifest.runID === nativeRun.launch.runID && row.event.kind === "hybrid-combat-decision",
);
assert.ok(first, "Actual learned group unavailable");
const selection = {
  manifest: first.manifest,
  episodeId: first.event.episodeId,
  generation: first.event.generation,
  modelIdentity: first.event.modelIdentity,
};
const contract = loadNativeContract();
const validationOptions = { gammaTick: 0.9, requireStochastic: false };
const trajectory = validateTrajectory(dataset, selection, nativeRun, validationOptions);
const trainingRecords: Array<{ action: string; actionTick: number }> = trajectory.records;
assert.equal(trajectory.trainable, true);
assert.ok(trajectory.records.some((row: { action: string }) => row.action === "attack"));
const before = canonical(trajectory.snapshot);
const fitted = fitTrajectory(trajectory, contract);
assert.equal(canonical(trajectory.snapshot), before);
assert.equal(contract.learningAllowed(fitted.model), false);
assert.equal(fitted.model.offline.originModelIdentity, selection.modelIdentity);
assert.equal(
  fitted.summary.updates,
  trainingRecords.reduce(
    (sum: number, row: { action: string }) => sum + (row.action === "attack" ? 2 : 1),
    0,
  ),
);
for (const [index, record] of trajectory.records.entries()) {
  assert.equal(
    trajectory.returns[index]?.return,
    (nativeRun.result.won ? 1 : -1) * 0.9 ** (nativeRun.result.ticks - record.actionTick),
  );
}
const capped = structuredClone(nativeRun);
capped.result.stopReason = "max_ticks";
capped.result.winner = null;
assert.throws(
  () => validateTrajectory(dataset, selection, capped, validationOptions),
  "Contradictory cap cannot become defeat",
);
const missing = structuredClone(dataset);
missing.records = missing.records.filter(
  (row: { manifest: { runID: string }; event: { kind: string } }) =>
    !(row.manifest.runID === nativeRun.launch.runID && row.event.kind === "hybrid-combat-receipt"),
);
assert.throws(
  () => validateTrajectory(missing, selection, nativeRun, validationOptions),
  "Missing original receipt is not trainable",
);
write("selection.json", selection);
write("trajectory.json", trajectory);
write("return-model.json", fitted.model);
write("summary.json", {
  version: "native-trajectory-plumbing-v1",
  limits,
  bootstrap: online.report.counts,
  actualControl: nativeRun.result.hybridCombat.diagnostics.control,
  fit: fitted.summary,
  originalModelUnchanged: true,
  learningAllowed: false,
  automaticActivation: false,
  performanceClaim: false,
  evidence: declaration.evidence,
  ledgerHash: evaluated.report.ledgerDataset.hash,
});
process.stdout.write(`Native trajectory fixture passed; evidence ${out}; no efficacy claim\n`);
