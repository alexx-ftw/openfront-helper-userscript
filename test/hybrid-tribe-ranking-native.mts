import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game.ts";
import { Config } from "../openfront-engine/src/core/configuration/Config.ts";
import { createGame as createGameImpl } from "../openfront-engine/src/core/game/GameImpl.ts";
import { createGame, L } from "../openfront-engine/tests/core/pathfinding/_fixtures.ts";
import { GameRunner } from "../openfront-engine/src/core/GameRunner.ts";
import { SpawnExecution } from "../openfront-engine/src/core/execution/SpawnExecution.ts";
import { TribeExecution } from "../openfront-engine/src/core/execution/TribeExecution.ts";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager.ts";
import {
  BundledOpponentBot,
  createBundledOpponentHarness,
  createBuildMenu,
} from "../scripts/headless/opponent-adapter.js";

// Parent freezes/builds/reviews before serial execution. This is bounded ingress
// and actual online SGD evidence, not full-match strength or server admission.
const bundlePath = process.env.OFH_BUNDLE_PATH;
assert.ok(bundlePath, "OFH_BUNDLE_PATH must explicitly identify the parent frozen bundle");
assert.ok(fs.statSync(bundlePath).isFile());
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const bundleSHA = sha(fs.readFileSync(bundlePath));
const sourceSHA = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-tribe-native-"));
const retained = process.env.OFH_NATIVE_PROOF_OUT;
const bounds = { immunity: 2000, attempts: 400, observe: 160 };
const setup = {
  width: 32,
  height: 16,
  config: "current production Config; fixture Setup supplies terrain only",
  registeredSpawns: true,
  territoryOverride:
    "relinquish spawn tiles; actor rectangle x=1..30,y=1..14; tribes on row y=0; cold passive Nation at (20,0)",
  troopOverride:
    "after native immunity, add 100000 actor troops; each passive tribe and cold Nation reduced to 1",
  passiveTribes:
    "official removeExecution(TribeExecution) immediately after registered spawn; PlayerExecution production retained",
  passiveNation: "cold collection only; sole strategic WAIT candidate",
  freeLandOrder:
    "existing forceSendAttack before WAIT; fraction=(8*ceil(native minimum frontier capture loss)+1)/live troops; eight loss budgets cover four alternating collector opportunities; sender reserves and opening ceiling unchanged",
  observationDriver:
    "beginTick + refreshBehaviorPlayerReferences + native observeHybridCombat; no automatic tactical decisions during collection",
};

async function episode(seed: string, count: number, modelPath?: string) {
  const terrain = createGame({ width: 32, height: 16, grid: Array(512).fill(L) });
  const game = createGameImpl(
    [],
    [],
    terrain.map(),
    terrain.miniMap(),
    new Config({ ...terrain.config().gameConfig() }, null, false, false),
  );
  const spawn = (info: PlayerInfo, tile: number) => {
    const player = game.addPlayer(info);
    const execution = new SpawnExecution(seed, info, tile);
    execution.init(game, game.ticks());
    execution.tick(game.ticks());
    assert.equal(player.hasSpawned(), true);
    // Spawn installs tribe AI as well as native production; passivity must
    // remove only the official AI execution before immunity ticks run.
    for (const installed of game.executions())
      if (installed instanceof TribeExecution) game.removeExecution(installed);
    assert.ok(!game.executions().some((installed) => installed instanceof TribeExecution));
    for (const owned of [...player.tiles()]) player.relinquish(owned);
    return player;
  };
  const me = spawn(
    new PlayerInfo("actor", PlayerType.Human, "actor001", "actor001"),
    game.ref(16, 8),
  );
  const targets = Array.from({ length: count }, (_, index) => {
    const target = spawn(
      new PlayerInfo(`tribe${index}`, PlayerType.Bot, null, `tribe${index}`),
      game.ref(index + 2, 0),
    );
    target.conquer(game.ref(index + 2, 0));
    return target;
  });
  const waitNation = modelPath
    ? null
    : spawn(new PlayerInfo("wait nation", PlayerType.Nation, null, "waitnation"), game.ref(20, 0));
  if (waitNation) waitNation.conquer(game.ref(20, 0));
  for (let y = 1; y < 15; y++) for (let x = 1; x < 31; x++) me.conquer(game.ref(x, y));
  // Registered PlayerExecution remains; spawned TribeExecution was removed.
  for (let i = 0; game.isNationSpawnImmunityActive() && i < bounds.immunity; i++)
    game.executeNextTick();
  assert.equal(game.isNationSpawnImmunityActive(), false, "immunity bound exhausted");
  me.addTroops(100000);
  for (const target of [...targets, ...(waitNation ? [waitNation] : [])])
    target.removeTroops(target.troops() - 1);
  const harness = createBundledOpponentHarness({
    bundlePath,
    runIdentity: seed,
    eventFile: path.join(scratch, `${seed}.jsonl`),
    evidenceCapacity: 8192,
    hybrid: {
      mode: modelPath ? "learned" : "shadow",
      learning: !modelPath,
      collectionPolicy: modelPath ? null : "coverage-wait-v1",
      modelPath,
    },
  });
  let failure: unknown;
  const runner = new GameRunner(game, new Executor(game, seed, "actor001"), (update) => {
    if ("errMsg" in update) failure = update.errMsg;
  });
  const bot = new BundledOpponentBot({
    harness,
    winFixes: true,
    features: Object.fromEntries(
      ["spawn", "expand", "build", "boat", "nuke", "warship", "alliance", "donate", "betray"].map(
        (key) => [key, false],
      ),
    ),
    buildStructures: {},
  });
  bot.attach({ runner, clientID: "actor001", gameID: seed });
  const refresh = async () => {
    harness.window.__OFH_realOpponentClock.now = game.ticks() * 100;
    await bot.api.beginTick(bot.pageGame.myPlayer());
    bot.nationBot.player = bot.api.game.myPlayer();
    bot.nationBot.refreshBehaviorPlayerReferences();
    harness.current.buildMenu = createBuildMenu(bot);
  };
  await refresh();
  bot.nationBot.initializeBehaviors();
  const behavior = bot.nationBot.attackBehavior;
  const policy = harness.internals.hybridCombatPolicy;
  assert.equal(
    typeof behavior.prepareHybridTribePlan,
    "function",
    "parent caller absent from frozen bundle",
  );
  assert.equal(typeof policy.rankTribeChoice, "function");
  assert.equal(typeof policy.sendTribeChoice, "function");
  let turn = 0;
  const orders: unknown[] = [];
  const advance = async () => {
    const intents = bot.intentBuffer.splice(0);
    orders.push(...intents.map((intent) => ({ tick: game.ticks(), ...intent })));
    runner.addTurn({
      turnNumber: turn++,
      intents: intents.map((intent) => ({ ...intent, clientID: "actor001" })),
    });
    assert.equal(runner.executeNextTick(), true);
    assert.equal(failure, undefined);
    await refresh();
    bot.nationBot.observeHybridCombat(bot.api.game.myPlayer());
    assert.ok(!policy.diagnostics().error, "native numerical/diagnostic failure");
  };
  const readyTribes = async () => {
    const fixedTick = game.ticks();
    const cached = await behavior.getReadyEarlyGameTribeCandidates();
    const work = behavior.earlyGameTribeCandidatesRefresh;
    if (!work) return cached;
    // Native refresh yields through the house adapter's setImmediate queue.
    // Await its real promise without advancing the world or forging caches.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `native tribe refresh timeout: ${JSON.stringify({
                    tick: fixedTick,
                    stage: behavior.earlyGameTribeRefreshStage,
                    starts: behavior.earlyGameTribeRefreshStartCount,
                  })}`,
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal(game.ticks(), fixedTick, "topology completion must not advance native production");
    assert.equal(
      behavior.earlyGameTribeCandidatesRefresh,
      null,
      "native refresh completion not published",
    );
    if (behavior.earlyGameTribeRefreshFailure) throw behavior.earlyGameTribeRefreshFailure.error;
    const candidates = behavior.liveEarlyGameTribeSnapshot(behavior.earlyGameTribeCandidatesCache);
    assert.ok(
      behavior.earlyGameTribeSnapshotIsScored(candidates),
      "native completed cluster scores required",
    );
    return candidates;
  };
  const settle = async () => {
    for (let i = 0; i < bounds.observe && (i < 2 || policy.pending); i++) await advance();
    assert.equal(policy.pending, null, "observation bound exhausted");
  };
  return {
    game,
    me,
    targets,
    waitNation,
    harness,
    bot,
    behavior,
    policy,
    advance,
    settle,
    readyTribes,
    orders,
  };
}

const open: ReturnType<typeof createBundledOpponentHarness>[] = [];
try {
  const cold = await episode("tribe-cold", 17);
  open.push(cold.harness);
  const { behavior, policy, bot, targets } = cold;
  assert.ok(cold.waitNation, "cold collection requires a separate native Nation");
  assert.equal(cold.waitNation.type(), PlayerType.Nation);
  assert.ok(targets.every((target) => target.type() === PlayerType.Bot));
  assert.ok(!targets.some((target) => target.smallID() === cold.waitNation.smallID()));
  const api = cold.harness.window.__OFH_hybridCombat;
  policy.importModel(
    api.createCompactModel({ featureProfile: "frontier-v1", controlProfile: "tribe-ranking-v1" }),
  );
  // Compact import clears collector configuration; mirror the house adapter's
  // import-then-configure order before any native order or observation.
  const importedColdModel = JSON.stringify(policy.exportModel());
  api.configure({ mode: "shadow", learning: true, collectionPolicy: "coverage-wait-v1" });
  assert.equal(
    JSON.stringify(policy.exportModel()),
    importedColdModel,
    "collector configuration must preserve cold parameters and head counts",
  );
  assert.equal(policy.diagnostics().collectionPolicy, "coverage-wait-v1");
  assert.equal(policy.diagnostics().mode, "shadow");
  assert.equal(policy.diagnostics().learning, true);
  const initialModel = JSON.stringify(policy.exportModel());
  assert.ok(
    Object.values(policy.diagnostics().samples).every((samples) => samples === 0),
    "cold means no supplied head counts",
  );
  const rows = () => cold.harness.evidence.snapshot().replay.records;
  const waits = () =>
    rows().filter(
      (row) =>
        row.action === "wait" &&
        row.collectorControl === true &&
        row.confirmed &&
        Number.isFinite(row.reward) &&
        row.outcomeTick > row.actionTick,
    );
  const waitSnapshots = [];
  const snapshotWait = (attempt: number) => {
    const snapshot = {
      attempt,
      tick: cold.game.ticks(),
      tiles: cold.me.numTilesOwned(),
      troops: cold.me.troops(),
      gold: cold.me.gold().toString(),
      freeFrontier: behavior.getTerraNulliusFrontierSnapshot().attackableFrontier.length,
      outgoing: cold.me.outgoingAttacks().map((attack) => ({
        id: attack.id(),
        target: attack.target().smallID(),
        troops: attack.troops(),
      })),
      diagnostics: {
        ready: policy.diagnostics().ready,
        samples: policy.diagnostics().samples,
        readiness: policy.diagnostics().readiness,
        collection: policy.diagnostics().collection,
        error: policy.diagnostics().error,
      },
      outcomeCount: rows().length,
      collectorWaitCount: waits().length,
      positiveCollectorWaitCount: waits().filter((row) => row.reward > 0).length,
      lastOutcome: policy.diagnostics().lastOutcome,
    };
    waitSnapshots.push(snapshot);
    process.stderr.write(JSON.stringify({ kind: "native-wait-snapshot", ...snapshot }) + "\n");
    return snapshot;
  };
  snapshotWait(-1);
  const freeLand = bot.api.game.terraNullius();
  const minimum = behavior.getTerraNulliusMinimumTroops(freeLand, null);
  const liveTroops = Number(behavior.player.troops());
  assert.ok(Number.isFinite(minimum) && minimum >= 1, "native terrain loss quote unavailable");
  assert.ok(Number.isFinite(liveTroops) && liveTroops > 0, "native live army unavailable");
  // Collector admits alternating opportunities: fund eight native capture
  // losses plus one survivor, keeping the sender's reserve/cap authoritative.
  const fraction = (8 * Math.ceil(minimum) + 1) / liveTroops;
  assert.ok(fraction > 0 && fraction <= 1, "WAIT capture request exceeds actual army");
  assert.ok(
    behavior.hasLandBorderWithTerraNullius(),
    "initial native free-land frontier unavailable",
  );
  assert.equal(
    await behavior.forceSendAttack(freeLand, fraction),
    true,
    `native free-land order rejected: ${JSON.stringify(cold.harness.evidence.snapshot().attackAdmissions)}`,
  );
  for (let attempt = 0; waits().length < 4 && attempt < bounds.attempts; attempt++) {
    assert.equal(policy.pending, null, "previous one-tick WAIT observation must complete");
    assert.equal(policy.diagnostics().collectionPolicy, "coverage-wait-v1");
    // One order, then short sequential native observations, as in the house
    // fixture. No second emission can cancel or relabel a collector WAIT.
    await behavior.decideHybridCombat([bot.api.game.playerBySmallID(cold.waitNation.smallID())]);
    assert.ok(policy.proposal?.candidateCount >= 1, "native Nation must reach strategic scoring");
    assert.ok(policy.pending && policy.pending.target === null, "actual pending WAIT required");
    await cold.advance();
    assert.equal(policy.pending, null, "one-tick native WAIT observation did not close");
    snapshotWait(attempt);
    if (waits().length < 4)
      assert.ok(
        behavior.hasLandBorderWithTerraNullius(),
        "native free-land frontier exhausted before four finite confirmed collector outcomes; see snapshots",
      );
  }
  assert.ok(
    waits().length >= 4,
    `four genuine finite confirmed coverage WAIT outcomes required within ${bounds.attempts} attempts; native admissions: ${JSON.stringify(cold.harness.evidence.snapshot().attackAdmissions)}`,
  );
  assert.ok(
    waits().some((row) => row.reward > 0),
    "native collector coverage must include a genuine positive land reward",
  );
  assert.equal(policy.diagnostics().readiness.wait.sampleDeficit, 0);
  assert.equal(
    policy.diagnostics().readiness.wait.signalPresent,
    true,
    "four finite observations must produce an actual learned WAIT signal",
  );
  for (const target of targets) {
    let sent = false;
    let lastPreflight;
    for (let attempt = 0; !sent && attempt < bounds.attempts; attempt++) {
      const observed = bot.api.game.playerBySmallID(target.smallID());
      const candidates = await cold.readyTribes();
      const candidate = candidates.find(
        (candidate) => candidate.player.smallID() === target.smallID(),
      );
      await behavior.prepareHybridCombatGeometry([observed]);
      const options = {
        parallelTribeAttack: true,
        earlyGameCandidate: candidate,
        reinforcementPlan: null,
      };
      lastPreflight = {
        attempt,
        tick: cold.game.ticks(),
        targetSmallID: target.smallID(),
        targetType: target.type(),
        targetAlive: target.isAlive(),
        targetTiles: target.numTilesOwned(),
        targetTroops: target.troops(),
        actorTroops: cold.me.troops(),
        sharesBorder: cold.me.sharesBorderWith(target),
        candidateAvailable: Boolean(candidate),
        refreshStage: behavior.earlyGameTribeRefreshStage,
        refreshStarts: behavior.earlyGameTribeRefreshStartCount,
        refreshPending: Boolean(behavior.earlyGameTribeCandidatesRefresh),
        candidateCount: candidates.length,
        candidateScored: behavior.earlyGameTribeCandidateIsLiveAndScored(candidate, observed),
        nativeLegal: behavior.canAttackPlayerNow(observed),
        funding: behavior.inspectLandAttackFunding(observed, options),
        geometry: behavior.hybridCombatGeometry(observed),
      };
      if (candidate)
        sent = await behavior.sendAttack(observed, false, null, candidate, false, true, null);
      const admission = cold.harness.evidence.snapshot().attackAdmissions;
      if (attempt === 0 || sent || attempt === bounds.attempts - 1)
        process.stderr.write(
          JSON.stringify({ kind: "native-bot-send", ...lastPreflight, sent, admission }) + "\n",
        );
      if (!sent) await cold.advance();
    }
    assert.equal(
      sent,
      true,
      `guarded Bot land send exhausted attempt bound: ${JSON.stringify({ lastPreflight, admission: cold.harness.evidence.snapshot().attackAdmissions })}`,
    );
    await cold.settle();
  }
  const attacks = rows().filter(
    (row) =>
      row.action === "attack" &&
      targets.some((target) => target.smallID() === row.targetSmallID) &&
      row.confirmed &&
      Number.isFinite(row.reward) &&
      row.geometry &&
      typeof row.receiptID === "string" &&
      row.receiptID.length > 0,
  );
  assert.ok(attacks.length >= 17);
  assert.equal(
    new Set(attacks.map((row) => row.receiptID)).size,
    attacks.length,
    "fresh native receipts required",
  );
  assert.equal(
    new Set(attacks.map((row) => row.targetSmallID)).size,
    17,
    "all seventeen actual Bot targets observed",
  );
  const diagnostics = policy.diagnostics();
  assert.equal(diagnostics.ready, true, "native coverage readiness gate");
  assert.ok(diagnostics.readiness.target.signalPresent);
  assert.ok(diagnostics.readiness.wait.signalPresent || diagnostics.readiness.act.signalPresent);
  for (const head of Object.values(diagnostics.readiness) as { sampleDeficit: number }[])
    assert.equal(head.sampleDeficit, 0);
  const frozen = JSON.stringify(policy.exportModel());
  assert.notEqual(frozen, initialModel, "actual learnOutcome SGD must change cold parameters");
  const modelPath = path.join(scratch, "trained-model.json");
  fs.writeFileSync(modelPath, frozen);
  const replay = await episode("tribe-frozen", 2, modelPath);
  open.push(replay.harness);
  assert.equal(replay.policy.diagnostics().learning, false);
  assert.equal(JSON.stringify(replay.policy.exportModel()), frozen);
  // Use the scored native candidate producer and its ordinary guarded caller;
  // attackBots without earlyGameCandidate cannot authorize a new tribe conquest.
  const passes = [];
  for (
    let attempt = 0;
    replay.policy.diagnostics().control.confirmedLearnedAttacks < 1 && attempt < bounds.attempts;
    attempt++
  ) {
    const before = replay.policy.diagnostics().control.acceptedLearnedAttacks;
    await replay.readyTribes();
    await replay.behavior.attackEarlyGameTribe();
    const delta = replay.policy.diagnostics().control.acceptedLearnedAttacks - before;
    assert.ok(delta >= 0 && delta <= 1, "at most one controlled first choice per native pass");
    passes.push({ tick: replay.game.ticks(), acceptedLearnedChoices: delta });
    await replay.settle();
  }
  const controlled = replay.harness.evidence
    .snapshot()
    .replay.records.filter(
      (row) =>
        row.action === "attack" &&
        row.learned === true &&
        row.confirmed &&
        row.behaviorPolicy === "deterministic-native-tribe-choice-v1" &&
        Number.isFinite(row.reward) &&
        row.geometry &&
        row.receiptID,
    );
  assert.ok(replay.policy.diagnostics().control.acceptedLearnedAttacks >= 1);
  assert.ok(replay.policy.diagnostics().control.confirmedLearnedAttacks >= 1);
  assert.ok(controlled.length >= 1, "outcome-only or accepted-only proof is insufficient");
  assert.equal(
    JSON.stringify(replay.policy.exportModel()),
    frozen,
    "fresh episode leaves frozen parameters and head counts unchanged",
  );
  assert.equal(
    sha(fs.readFileSync(bundlePath)),
    bundleSHA,
    "parent bundle changed during serial execution",
  );
  const proof = {
    sourceSHA,
    bundleSHA,
    setup,
    bounds,
    diagnostics,
    waits: waits(),
    attacks,
    frozenDiagnostics: replay.policy.diagnostics(),
    controlled,
    passes,
    waitSnapshots,
    collectionOrders: cold.orders,
    replayOrders: replay.orders,
    performanceClaim: false,
    nativeServerClaim: false,
  };
  if (retained) fs.writeFileSync(retained, JSON.stringify(proof, null, 2));
  process.stdout.write(
    JSON.stringify({
      sourceSHA,
      bundleSHA,
      waits: waits().length,
      attacks: attacks.length,
      learnedChoices: controlled.length,
      performanceClaim: false,
    }) + "\n",
  );
} finally {
  for (const harness of open) harness.window.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
