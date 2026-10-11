import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PlayerInfo, PlayerType } from "../openfront-engine/src/core/game/Game.ts";
import { Config } from "../openfront-engine/src/core/configuration/Config.ts";
import { createGame as createGameImpl } from "../openfront-engine/src/core/game/GameImpl.ts";
import { createGame, L } from "../openfront-engine/tests/core/pathfinding/_fixtures.ts";
import { GameRunner } from "../openfront-engine/src/core/GameRunner.ts";
import { AttackExecution } from "../openfront-engine/src/core/execution/AttackExecution.ts";
import { DonateTroopsExecution } from "../openfront-engine/src/core/execution/DonateTroopExecution.ts";
import { RetreatExecution } from "../openfront-engine/src/core/execution/RetreatExecution.ts";
import { EmojiExecution } from "../openfront-engine/src/core/execution/EmojiExecution.ts";
import { WinCheckExecution } from "../openfront-engine/src/core/execution/WinCheckExecution.ts";
import { SpawnExecution } from "../openfront-engine/src/core/execution/SpawnExecution.ts";
import { Executor } from "../openfront-engine/src/core/execution/ExecutionManager.ts";
import {
  BundledOpponentBot,
  createBundledOpponentHarness,
  createBuildMenu,
} from "../scripts/headless/opponent-adapter.js";
import { evaluate } from "../scripts/headless/evaluate-hybrid-combat.mjs";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";

// Finite official GameImpl/Executor/GameRunner worlds; all labels come from
// native observed attacks. No coefficient or readiness counter mutation.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-native-hybrid-"));
const retained = process.env.OFH_NATIVE_PROOF_OUT;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const engineRoot = path.resolve("openfront-engine");
const fingerprint = {
  revision: execFileSync("git", ["-C", engineRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: foreignGitEnvironment(),
  }).trim(),
  diffHash: digest(
    execFileSync("git", ["-C", engineRoot, "diff", "HEAD", "--binary"], {
      env: foreignGitEnvironment(),
    }),
  ),
};
function productionWorld(width = 32, height = 16, donateTroops = false) {
  const terrain = createGame(
    { width, height, grid: Array(width * height).fill(L) },
    { instantBuild: true },
  );
  return createGameImpl(
    [],
    [],
    terrain.map(),
    terrain.miniMap(),
    new Config({ ...terrain.config().gameConfig(), donateTroops }, null, false, false),
  );
}
function spawnRegisteredActor(game, seed, info, tile) {
  const actor = game.addPlayer(info);
  const spawn = new SpawnExecution(seed, info, tile);
  spawn.init(game, game.ticks());
  spawn.tick(game.ticks());
  assert.equal(actor.hasSpawned(), true, "native SpawnExecution registers spawn state");
  for (const owned of [...actor.tiles()]) actor.relinquish(owned);
  return actor;
}

const proofs = [];
let turn = 0;
const nativeRunner = async ({ seed, mode, learning, modelPath, bundlePath, runID }) => {
  learning = learning === true;
  const game = productionWorld();
  const spawnActor = (info, tile) => spawnRegisteredActor(game, seed, info, tile);
  const me = spawnActor(
    new PlayerInfo("actor", PlayerType.Human, "actor001", "actor001"),
    game.ref(16, 8),
  );
  const targets = Array.from({ length: 17 }, (_, i) => {
    const target = spawnActor(
      new PlayerInfo(`nation${i}`, PlayerType.Nation, null, `nation${i}`),
      game.ref(i + 2, 0),
    );
    target.conquer(game.ref(i + 2, 0));
    target.removeTroops(target.troops() - 1);
    return target;
  });
  // Controlled adjacent micro state after real registered spawns; all players
  // retain native production. No strategic Nation AI or efficacy claim.
  for (let y = 1; y < 15; y++) for (let x = 1; x < 31; x++) me.conquer(game.ref(x, y));
  const eventFile = path.join(scratch, `${runID}.jsonl`);
  const harness = createBundledOpponentHarness({
    bundlePath,
    runIdentity: runID,
    eventFile,
    evidenceCapacity: 1024,
    hybrid: { mode, learning, modelPath },
  });
  assert.equal(
    typeof harness.window.__OFH_hybridCombat.createCompactModel,
    "function",
    "actual bundle loads the compact contract",
  );
  let failure;
  const nativeOrders = [];
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
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.initializeBehaviors();
  harness.current.buildMenu = createBuildMenu(bot);
  assert.equal(
    typeof harness.internals.hybridNativeKnowledgeMarkup,
    "function",
    "actual bundled panel consumer is exposed for native fixture proof",
  );
  const nativePanel = harness.internals.hybridNativeKnowledgeMarkup();
  assert.ok(
    nativePanel.includes(game.config().unitInfo("Atom Bomb").cost(game, me).toString()),
    "panel displays exact production Config quote decimal",
  );
  const behavior = bot.nationBot.attackBehavior;
  const policy = harness.internals.hybridCombatPolicy;
  const frozen = JSON.stringify(policy.exportModel());
  const advance = async () => {
    const intents = bot.intentBuffer.splice(0);
    nativeOrders.push(...intents.map((intent) => ({ tick: game.ticks(), ...intent })));
    runner.addTurn({
      turnNumber: turn++,
      intents: intents.map((intent) => ({ ...intent, clientID: "actor001" })),
    });
    assert.equal(runner.executeNextTick(), true);
    assert.equal(failure, undefined);
    await bot.decide();
    harness.current.buildMenu = createBuildMenu(bot);
  };
  for (let i = 0; game.isNationSpawnImmunityActive() && i < 2000; i++) await advance();
  assert.equal(
    game.isNationSpawnImmunityActive(),
    false,
    "native immunity elapsed within finite fixture bound",
  );
  me.addTroops(100000);
  for (const target of targets) target.removeTroops(target.troops() - 1);
  // Existing non-strategic expansion can progress while the strategic target
  // gate waits. Native capture gives the WAIT observation its actual outcome.
  assert.equal(await behavior.forceSendAttack(bot.api.game.terraNullius(), 0.00001), true);
  for (let i = 0; i < 4; i++) {
    await behavior.decideHybridCombat(
      targets.map((target) => bot.api.game.playerBySmallID(target.smallID())),
    );
    if (i === 0 && mode !== "baseline")
      assert.equal(
        policy.proposal.candidateCount,
        17,
        "native geometry/action inference sees every candidate beyond sixteen slots",
      );
    await advance();
  }
  for (const target of targets) {
    const observed = bot.api.game.playerBySmallID(target.smallID());
    await behavior.prepareHybridCombatGeometry([observed]);
    if (mode !== "learned") {
      let sent = false;
      for (let attempt = 0; !sent && attempt < 400; attempt++) {
        await behavior.prepareHybridCombatGeometry([observed]);
        sent = await behavior.sendAttack(observed);
        if (!sent) await advance();
      }
      assert.equal(sent, true, "ordinary native strategic send accepted within fixture bound");
    } else await behavior.decideHybridCombat([observed]);
    for (let i = 0; i < 160 && (i < 2 || policy.pending); i++) await advance();
  }
  const events = harness.evidence.snapshot().replay.records;
  const attacks = events.filter(
    (row) => row.action === "attack" && row.confirmed && row.reward !== null,
  );
  if (mode === "shadow")
    assert.ok(attacks.length >= 13, "native receipts complete sufficient micro observations");
  assert.ok(
    attacks.every((row) => typeof row.receiptID === "string" && row.receiptID && row.geometry),
  );
  if (!learning)
    assert.equal(
      JSON.stringify(policy.exportModel()),
      frozen,
      "frozen native workflow cannot mutate weights",
    );
  if (learning)
    assert.ok(
      policy.exportModel().models.target.samples >= 13,
      "native outcomes update the actual model",
    );
  bot.finalizeHybridCombatObservation("max_ticks");
  const evidence = bot.getHybridEvaluationSnapshot();
  assert.equal(
    evidence.latestClosure.reason,
    "max_ticks",
    "actual cap fact closes an episode even after the last observation completed",
  );
  assert.equal(evidence.latestClosure.truncated, true);
  assert.equal(evidence.latestClosure.terminated, false);
  proofs.push({
    seed,
    mode,
    learning,
    receipts: attacks.length,
    ticks: game.ticks(),
    samples: policy.diagnostics().samples,
    latencySamples: evidence.latencyMs.length,
    maxCandidateCount: Math.max(0, ...evidence.decisionRows.map((row) => row.candidateCount)),
    control: policy.diagnostics().control,
    decisionLatencyMaxMs: Math.max(0, ...evidence.latencyMs),
    processRssBytes: process.memoryUsage().rss,
    registeredSpawns: [me, ...targets].every((player) => player.hasSpawned()),
    nativeOrders,
    finalNativeState: { tick: game.ticks(), tiles: me.numTilesOwned(), troops: me.troops() },
    safety: evidence.safety,
    eventFile,
    frozenUnchanged: !learning,
  });
  const result = {
    seed,
    stopReason: "max_ticks",
    won: false,
    winner: null,
    alive: me.isAlive(),
    ticks: game.ticks(),
    hybridCombat: bot.getHybridCombatSnapshot(),
    hybridEvaluation: evidence,
    intentBudget: bot.getIntentBudgetSnapshot(),
    finalBotState: { tiles: me.numTilesOwned() },
  };
  harness.window.close();
  return {
    code: 0,
    seed,
    mode,
    start: { map: "native-tiny-grid", engineFingerprint: fingerprint },
    result,
  };
};
async function jointIngressProof(bundlePath) {
  const game = productionWorld(128, 64, true);
  const seed = "joint-native-seed";
  const me = spawnRegisteredActor(
    game,
    seed,
    new PlayerInfo("actor", PlayerType.Human, "actor001", "actor001"),
    game.ref(16, 8),
  );
  const leader = spawnRegisteredActor(
    game,
    seed,
    new PlayerInfo("leader", PlayerType.Human, "leader01", "leader01"),
    game.ref(10, 0),
  );
  const enemy = spawnRegisteredActor(
    game,
    seed,
    new PlayerInfo("enemy", PlayerType.Nation, null, "enemy001"),
    game.ref(12, 0),
  );
  const nextEnemy = spawnRegisteredActor(
    game,
    seed,
    new PlayerInfo("next enemy", PlayerType.Nation, null, "enemy002"),
    game.ref(2, 0),
  );
  for (let y = 0; y < 32; y++) for (let x = 1; x < 10; x++) nextEnemy.conquer(game.ref(x, y));
  nextEnemy.removeTroops(nextEnemy.troops() - 1);
  for (let y = 32; y < 64; y++) for (let x = 1; x < 127; x++) me.conquer(game.ref(x, y));
  for (let y = 0; y < 32; y++) leader.conquer(game.ref(10, y));
  for (let y = 0; y < 32; y++) for (let x = 11; x < 127; x++) enemy.conquer(game.ref(x, y));
  game.createAllianceRequest(leader, me).accept();
  for (let i = 0; game.isNationSpawnImmunityActive() && i < 2000; i++) game.executeNextTick();
  me.addTroops(300000);
  leader.addTroops(300000);
  enemy.addTroops(10000);
  const harness = createBundledOpponentHarness({
    bundlePath,
    runIdentity: "joint-launch",
    eventFile: path.join(scratch, "joint.jsonl"),
    hybrid: { mode: "baseline", learning: false },
  });
  const runner = new GameRunner(game, new Executor(game, seed, "actor001"), () => {});
  const bot = new BundledOpponentBot({ harness, winFixes: true });
  bot.attach({ runner, clientID: "actor001", gameID: seed });
  harness.window.__OFH_realOpponentClock.now = game.ticks() * 100;
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.initializeBehaviors();
  harness.current.buildMenu = createBuildMenu(bot);
  harness.window.__OFH_companion.set({
    enabled: true,
    mode: "active",
    bossName: "leader",
    autoSpawn: false,
    autoAlliance: false,
    autoTroops: false,
    autoFactory: false,
  });
  const behavior = bot.nationBot.attackBehavior;
  const strategy = harness.window.__OFH_hybridStrategy;
  const context = { game: bot.api.game.__src, player: behavior.player };
  game.addExecution(new AttackExecution(20000, leader, enemy.id()));
  game.executeNextTick();
  game.executeNextTick();
  const anchor = leader.outgoingAttacks()[0];
  assert.ok(anchor, "real ally native attack anchors the joint request");
  strategy.observeDuo(context);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "no directed native ACK means no support send",
  );
  game.addExecution(new EmojiExecution(leader, me.id(), 17));
  game.executeNextTick();
  game.executeNextTick();
  strategy.observeDuo(context);
  assert.equal(await behavior.tryHybridJointAttack(), false, "REQUEST alone cannot emit support");
  game.addExecution(new EmojiExecution(me, leader.id(), 29));
  game.executeNextTick();
  game.executeNextTick();
  harness.window.__OFH_realOpponentClock.now = game.ticks() * 100;
  await bot.api.beginTick(bot.pageGame.myPlayer());
  const plan = strategy.getJointPlan(context, leader.smallID());
  assert.ok(plan, "actual directed native ACK confirms a live native anchor");
  assert.equal(plan.attackId, anchor.id());
  assert.equal(
    await behavior.tryHybridJointAttack(),
    true,
    "real ACK enters the sole guarded Attack sender",
  );
  assert.equal(bot.intentBuffer.length, 1, "Companion adds no second support emitter");
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "same-tick pending duplicate is blocked",
  );
  const intents = bot.intentBuffer.splice(0);
  runner.addTurn({
    turnNumber: 0,
    intents: intents.map((intent) => ({ ...intent, clientID: "actor001" })),
  });
  runner.executeNextTick();
  runner.addTurn({ turnNumber: 1, intents: [] });
  runner.executeNextTick();
  const receipt = me
    .outgoingAttacks()
    .find((attack) => attack.target().smallID() === enemy.smallID());
  assert.ok(receipt, "support order has an actual new native own attack ID");
  // Eight real ticks let the ongoing native attack progress; a genuine ally
  // donation then restores spendable troops without changing any attack guard.
  for (let i = 0; i < 8; i++) game.executeNextTick();
  assert.equal(leader.canDonateTroops(me), true, "native ally donation is admissible");
  game.addExecution(new DonateTroopsExecution(leader, me.id(), 250000));
  game.executeNextTick();
  game.executeNextTick();
  harness.window.__OFH_realOpponentClock.now = game.ticks() * 100;
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.refreshBehaviorPlayerReferences();
  behavior.reconcileOutboundAttackIntentCommitments();
  assert.equal(
    behavior.botAttackPendingIntentCommitments.length,
    0,
    "actual own native receipt clears the temporary pending ledger",
  );
  assert.ok(
    leader.outgoingAttacks().some((attack) => attack.id() === anchor.id()),
    "native ally anchor remains live after our receipt",
  );
  assert.ok(game.ticks() < plan.expiresTick, "same directed consent has not expired");
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "consumed native REQUEST/ACK cannot emit again after receipt reconciliation",
  );
  assert.equal(bot.intentBuffer.length, 0);

  // A distinct later REQUEST/ACK is admissible after the native emoji cooldown.
  // Retreat the old ally anchor through the official execution, then observe
  // a new attack before asking consent for the other adjacent native Nation.
  game.addExecution(new RetreatExecution(leader, anchor.id()));
  for (let i = 0; (!leader.canSendEmoji(me) || !me.canSendEmoji(leader)) && i < 100; i++)
    game.executeNextTick();
  assert.ok(leader.canSendEmoji(me) && me.canSendEmoji(leader));
  game.addExecution(new AttackExecution(1000, leader, nextEnemy.id()));
  game.executeNextTick();
  game.executeNextTick();
  harness.window.__OFH_realOpponentClock.now = game.ticks() * 100;
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.refreshBehaviorPlayerReferences();
  strategy.observeDuo({ game: bot.api.game.__src, player: behavior.player });
  game.addExecution(new EmojiExecution(leader, me.id(), 17));
  game.executeNextTick();
  game.executeNextTick();
  strategy.observeDuo({ game: bot.api.game.__src, player: behavior.player });
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "fresh REQUEST alone needs its own ACK",
  );
  game.addExecution(new EmojiExecution(me, leader.id(), 29));
  game.executeNextTick();
  game.executeNextTick();
  harness.window.__OFH_realOpponentClock.now = game.ticks() * 100;
  await bot.api.beginTick(bot.pageGame.myPlayer());
  bot.nationBot.player = bot.api.game.myPlayer();
  bot.nationBot.refreshBehaviorPlayerReferences();
  const freshPlan = strategy.getJointPlan(
    { game: bot.api.game.__src, player: behavior.player },
    leader.smallID(),
  );
  assert.ok(
    freshPlan && freshPlan.requestTick > plan.requestTick && freshPlan.ackTick > plan.ackTick,
  );
  assert.equal(freshPlan.targetSid, nextEnemy.smallID());
  assert.equal(
    await behavior.tryHybridJointAttack(),
    true,
    "new directed native REQUEST/ACK admits one guarded support order",
  );
  assert.equal(bot.intentBuffer.length, 1);
  runner.addTurn({
    turnNumber: 2,
    intents: bot.intentBuffer.splice(0).map((intent) => ({ ...intent, clientID: "actor001" })),
  });
  runner.executeNextTick();
  runner.addTurn({ turnNumber: 3, intents: [] });
  runner.executeNextTick();
  const freshReceipt = me
    .outgoingAttacks()
    .find((attack) => attack.target().smallID() === nextEnemy.smallID());
  assert.ok(freshReceipt, "fresh consent creates a distinct actual native receipt");
  const proof = {
    anchorID: anchor.id(),
    receiptID: receipt.id(),
    ackTick: plan.ackTick,
    source: "official-attack-and-directed-emoji-executions",
    singleEmitter: true,
    duplicateBlocked: true,
    postReceiptConsentBlocked: true,
    freshRequestAccepted: true,
    freshReceiptID: freshReceipt.id(),
  };
  harness.window.close();
  return proof;
}

async function terminalBridgeProof(bundlePath) {
  const cases = [];
  for (const reason of ["max_ticks", "bot_dead", "winner", "reset", "beginSession", "env_error"]) {
    const game = productionWorld();
    const seed = "terminal-native-seed";
    const ownTile = game.ref(2, 2),
      enemyTile = game.ref(3, 2);
    const me = spawnRegisteredActor(
      game,
      seed,
      new PlayerInfo("actor", PlayerType.Human, "actor001", "actor001"),
      ownTile,
    );
    const enemy = spawnRegisteredActor(
      game,
      seed,
      new PlayerInfo("enemy", PlayerType.Nation, null, "enemy001"),
      enemyTile,
    );
    me.conquer(ownTile);
    enemy.conquer(enemyTile);
    for (let i = 0; game.isNationSpawnImmunityActive() && i < 2000; i++) game.executeNextTick();
    assert.equal(game.isNationSpawnImmunityActive(), false);
    me.addTroops(100000);
    const harness = createBundledOpponentHarness({
      bundlePath,
      runIdentity: `terminal-${reason}-launch`,
      eventFile: path.join(scratch, `terminal-${reason}.jsonl`),
      hybrid: { mode: "shadow", learning: false },
    });
    const api = harness.window.__OFH_hybridCombat;
    api.importModel(api.createCompactModel());
    const runner = new GameRunner(game, new Executor(game, seed, "actor001"), () => {});
    const bot = new BundledOpponentBot({
      harness,
      winFixes: true,
      features: Object.fromEntries(
        ["spawn", "expand", "build", "boat", "nuke", "warship", "alliance", "donate", "betray"].map(
          (key) => [key, false],
        ),
      ),
    });
    bot.attach({ runner, clientID: "actor001", gameID: seed });
    await bot.api.beginTick(bot.pageGame.myPlayer());
    bot.nationBot.player = bot.api.game.myPlayer();
    bot.nationBot.initializeBehaviors();
    harness.current.buildMenu = createBuildMenu(bot);
    const behavior = bot.nationBot.attackBehavior;
    await behavior.decideHybridCombat([bot.api.game.playerBySmallID(enemy.smallID())]);
    const policy = harness.internals.hybridCombatPolicy;
    assert.ok(policy.pending, "real cold native WAIT observation is pending");
    const before = JSON.stringify(api.exportModel());
    const emissions = bot.intentBuffer.length;
    if (reason === "bot_dead") enemy.conquer(ownTile);
    if (reason === "winner") {
      for (let tile = 0; tile < 512; tile++) if (tile !== enemyTile) me.conquer(tile);
      game.addExecution(new WinCheckExecution());
      for (let i = 0; !game.getWinner() && i < 20; i++) game.executeNextTick();
      assert.ok(game.getWinner(), "official WinCheckExecution supplies the stop fact");
    }
    if (reason === "beginSession") {
      const nextGame = productionWorld();
      bot.attach({
        runner: new GameRunner(nextGame, new Executor(nextGame, seed, "actor001"), () => {}),
        clientID: "actor001",
        gameID: seed,
      });
    } else if (reason === "reset") api.configure({ mode: "shadow", learning: false });
    else if (reason === "env_error") {
      bot.nationBot.tick = async () => {
        throw new Error("injected unexpected native tick failure");
      };
      await assert.rejects(bot.decide(), /injected unexpected native tick failure/);
    } else bot.finalizeHybridCombatObservation(reason);
    assert.equal(policy.pending, null);
    assert.equal(bot.intentBuffer.length, emissions, "finalization never emits an action");
    assert.equal(
      JSON.stringify(api.exportModel()),
      before,
      "frozen terminal/reset/error observations never learn",
    );
    const outcome = harness.evidence.snapshot().replay.records.at(-1);
    assert.equal(outcome.terminal, ["winner", "bot_dead"].includes(reason));
    assert.equal(outcome.truncated, ["max_ticks", "reset", "beginSession"].includes(reason));
    assert.equal(outcome.envError === true, reason === "env_error");
    assert.equal(outcome.modelIdentity, before);
    assert.ok(
      outcome.outcomeTick >= outcome.actionTick,
      "old session never receives the new match tick zero",
    );
    cases.push({
      reason,
      terminal: outcome.terminal,
      truncated: outcome.truncated,
      envError: outcome.envError === true,
      actionTick: outcome.actionTick,
      outcomeTick: outcome.outcomeTick,
      noEmission: true,
      frozenUnchanged: true,
    });
    harness.window.close();
  }
  return cases;
}

try {
  const environment = {
    OFH_BUNDLE_PATH: process.env.OFH_BUNDLE_PATH ?? path.resolve("openfront-helper.user.js"),
  };
  const online = await evaluate(
    {
      collect: true,
      policy: "compact-neural",
      seeds: ["native-online"],
      timeoutMs: 10000,
      out: path.join(scratch, "online"),
    },
    environment,
    nativeRunner,
  );
  const modelFile = path.join(scratch, "online/trained-model.json");
  assert.equal(online.report.counts.success, 1);
  const replay = await evaluate(
    {
      collect: true,
      frozenReplay: true,
      policy: "compact-neural",
      model: modelFile,
      seeds: ["native-replay"],
      timeoutMs: 10000,
      out: path.join(scratch, "replay"),
    },
    environment,
    nativeRunner,
  );
  const dataset = fs
    .readFileSync(replay.report.ledgerDataset.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const first = dataset.find((row) => row.event?.kind === "hybrid-combat-outcome");
  assert.ok(first, "actual incremental outcomes reach evaluator ledger export");
  const selection = {
    manifest: first.manifest,
    episodeId: first.event.episodeId,
    generation: first.event.generation,
    modelIdentity: first.event.modelIdentity,
  };
  const selectionFile = path.join(scratch, "selection.json");
  fs.writeFileSync(selectionFile, JSON.stringify(selection));
  const options = {
    collect: true,
    policy: "compact-neural",
    replay: replay.report.ledgerDataset.path,
    selection: selectionFile,
    seeds: ["native-replay"],
    timeoutMs: 10000,
  };
  const anchors = await evaluate(
    { ...options, anchors: true, out: path.join(scratch, "anchors") },
    environment,
    nativeRunner,
  );
  const shapingFile = path.join(scratch, "shaping.json");
  fs.writeFileSync(
    shapingFile,
    JSON.stringify({ gammaTick: 0.9, potentialID: "observed-own-land-share-v1" }),
  );
  const shaping = await evaluate(
    { ...options, "potential-shaping": shapingFile, out: path.join(scratch, "shaping") },
    environment,
    nativeRunner,
  );
  assert.ok(anchors.report.summary.fitted > 0);
  assert.ok(
    anchors.report.summary.anchors > 0,
    "actual native positive WAIT outcome exercises patient anchor fit",
  );
  assert.ok(shaping.report.summary.fitted > 0);
  const holdout = await evaluate(
    {
      policy: "compact-neural",
      model: path.join(scratch, "anchors/trained-model.json"),
      seeds: ["native-holdout"],
      timeoutMs: 10000,
      out: path.join(scratch, "holdout"),
    },
    environment,
    nativeRunner,
  );
  assert.equal(
    holdout.report.completedPairs,
    0,
    "truncation plumbing proves no completed-game efficacy",
  );
  const baselineProof = proofs.find(
    (proof) => proof.seed === "native-holdout" && proof.mode === "baseline",
  );
  const shadowProof = proofs.find(
    (proof) => proof.seed === "native-holdout" && proof.mode === "shadow",
  );
  assert.deepEqual(
    baselineProof.nativeOrders,
    shadowProof.nativeOrders,
    "frozen shadow preserves actual ordinary native intents",
  );
  assert.deepEqual(
    baselineProof.finalNativeState,
    shadowProof.finalNativeState,
    "frozen shadow preserves native bookkeeping and state",
  );
  const terminalCases = await terminalBridgeProof(environment.OFH_BUNDLE_PATH);
  const jointIngress = await jointIngressProof(environment.OFH_BUNDLE_PATH);
  if (retained)
    fs.writeFileSync(
      retained,
      JSON.stringify(
        {
          officialEngine: fingerprint,
          terminalCases,
          jointIngress,
          proofs,
          anchors: anchors.report.summary,
          shaping: shaping.report.summary,
          completedPairs: 0,
          performanceClaim: false,
        },
        null,
        2,
      ),
    );
  process.stdout.write("official native hybrid workflow passed (truncation plumbing only)\n");
} finally {
  if (!retained) fs.rmSync(scratch, { recursive: true, force: true });
}
