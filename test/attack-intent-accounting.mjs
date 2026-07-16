import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const earlyGamePath = path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js");
const earlyGameSource = fs.readFileSync(earlyGamePath, "utf8");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const UNIT = { TransportShip: "Transport" };
const troopEmissions = [];
const attackRecipients = [];
const sandbox = {
  UNIT,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  currentDifficulty: () => "Impossible",
  EARLY_EXPAND_COMMIT: 0.6,
  EARLY_EXPAND_FOLLOWUP_COMMIT: 0.01,
  performance: { now: () => 10000 },
  discoverCtors: () => ({
    attack: "attack",
    boat: "boat",
    donateTroops: "donateTroops",
  }),
  getEventBus: () => null,
  emitIntent: (_ctor, recipient, troops) => {
    attackRecipients.push(recipient);
    troopEmissions.push(troops);
    return true;
  },
  setLastAction: () => {},
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  calculateBoundingBoxCenter: () => ({ x: 0, y: 0 }),
  tr: (value) => value,
  state: {
    settings: { winFixes: true, features: { donate: true, boat: true } },
    stats: {},
  },
};

executeClassicScript(earlyGameSource, sandbox, { filename: earlyGamePath });
executeClassicScript(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});

let tick = 0;
let ownTroops = 100000;
const outgoing = [];
const me = {
  troops: () => ownTroops,
  smallID: () => 1,
  numTilesOwned: () => 100,
  type: () => "Human",
  units: () => [],
  borderTiles: () => new Set([1]),
  outgoingAttacks: () => outgoing,
};
const game = {
  ticks: () => tick,
  numLandTiles: () => 1000,
  numTilesWithFallout: () => 0,
  config: () => ({ maxTroops: () => 100000 }),
};
const target = {
  isPlayer: () => true,
  smallID: () => 2,
  id: () => "tribe-2",
};

const behavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});

behavior.botAttackPendingIntentCommitments = [
  { targetIsPlayer: true, targetKey: "2", troops: 1000 },
];
assert.equal(
  behavior.hasPendingOutboundAttackForTarget(target),
  true,
  "a pending attack blocks a duplicate intent against the same target",
);
assert.equal(
  behavior.hasPendingOutboundAttackForTarget({
    isPlayer: () => true,
    smallID: () => 3,
  }),
  false,
  "a pending tribe intent does not globally block another hostile border",
);
behavior.botAttackPendingIntentCommitments = [];

assert.equal(
  behavior.getEarlyGameLiveReserveTroops(),
  9995,
  "reserve is the troop level where production acceleration peaks",
);
assert.equal(
  behavior.getEarlyGameProbeTroops(),
  1000,
  "a probe is 1% of the current army without an absolute troop floor",
);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  90005,
  "the acceleration peak is protected before any outgoing troop intent",
);

behavior.recordOutboundAttackIntent(target, 8000, { attackType: "land" });
assert.equal(behavior.getPendingOutboundAttackTroops(), 8000);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  82005,
  "a stale troop snapshot cannot spend the same 8000 twice",
);

outgoing.push({
  id: () => "attack-1",
  retreating: () => false,
  target: () => target,
  troops: () => 8000,
});
tick = 1;
assert.equal(
  behavior.getPendingOutboundAttackTroops(),
  0,
  "the local intent is released once the matching outgoing attack is visible",
);

outgoing.length = 0;
behavior.recordOutboundAttackIntent(target, 7000, { attackType: "land" });
behavior.recordOutboundAttackIntent(target, 2000, { attackType: "land" });
assert.equal(behavior.getPendingOutboundAttackTroops(), 9000);

outgoing.push({
  id: () => "attack-2",
  retreating: () => false,
  target: () => target,
  troops: () => 7000,
});
tick = 2;
assert.equal(
  behavior.getPendingOutboundAttackTroops(),
  2000,
  "one visible attack only settles one of two stale intents",
);

tick = 9;
assert.equal(
  behavior.getPendingOutboundTroopCommitments(),
  0,
  "expired attack intents no longer reserve troops forever",
);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  90005,
  "the protected reserve remains after attack intents expire",
);

behavior.recordOutboundDonationIntent(10000);
assert.equal(behavior.getPendingOutboundDonationTroops(), 10000);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  80005,
  "a pending donation is deducted before another attack or donation",
);

// A high maxTroops value must not make the attack strategy wait forever. The
// hard reserve is still protected, but the old reserve/trigger ratio gates would
// stop this 40% army before the strategy pipeline was even evaluated.
const lowRatioBehavior = new sandbox.AttackBehavior(
  { chance: () => false },
  game,
  me,
  0.55,
  0.6,
  0.1,
  {},
  {},
);
let strategyEvaluated = false;
lowRatioBehavior.hasNeighboringBotWithStructures = () => false;
lowRatioBehavior.getAttackStrategies = () => [
  async () => {
    strategyEvaluated = true;
    return false;
  },
];
ownTroops = 40000;
await lowRatioBehavior.attackBestTarget([], [{}]);
assert.equal(
  strategyEvaluated,
  true,
  "available troops must reach the attack/donation strategy pipeline below the old ratio gates",
);
ownTroops = 100000;

// Land attacks use the same calculated hard reserve. They must not inherit the
// old percentage-of-capacity reserve after structures increase maxTroops.
const attackBudgetBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
attackBudgetBehavior.getEnemyDefensePostAttackProfile = () => ({});
attackBudgetBehavior.attackIsTooWeakForDefensePosts = () => false;
attackBudgetBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
const humanTarget = {
  isPlayer: () => true,
  type: () => "Human",
  id: () => "human-target",
};
ownTroops = 80000;
assert.equal(attackBudgetBehavior.sendLandAttack(humanTarget), true);
const productionPeakReserve = attackBudgetBehavior.getEarlyGameProductionReserveTroops();
assert.equal(
  productionPeakReserve,
  41788,
  "the Nation/Human reserve is the calculated production-rate peak for maxTroops=100000",
);
assert.equal(
  troopEmissions.at(-1),
  ownTroops - productionPeakReserve,
  "a Nation/Human land attack preserves the production-rate peak reserve",
);

// Capacity changes from newly built structures must invalidate the production
// reserve cache instead of retaining the old maxTroops calculation.
let dynamicMaximum = 100000;
const dynamicGame = {
  ticks: () => tick,
  config: () => ({ maxTroops: () => dynamicMaximum }),
};
const dynamicReserveBehavior = new sandbox.AttackBehavior(
  {},
  dynamicGame,
  me,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
ownTroops = 80000;
assert.equal(dynamicReserveBehavior.getEarlyGameProductionReserveTroops(), 41788);
dynamicMaximum = 200000;
assert.equal(
  dynamicReserveBehavior.getEarlyGameProductionReserveTroops(),
  83899,
  "a maxTroops increase recomputes the production peak reserve",
);

// TerraNullius is the opening expansion lane. Commit decisively while retaining
// the hostile-border safety reserve.
const terraNullius = { isPlayer: () => false, id: () => "TerraNullius" };
const strongAlly = {
  smallID: () => 7,
  isAlive: () => true,
  troops: () => 50000,
};
const alliedBorderMe = {
  ...me,
  isFriendly: (player) => player === strongAlly,
};
const alliedBorderGame = {
  ticks: () => tick,
  neighbors: () => [2],
  isLand: () => true,
  hasOwner: () => true,
  ownerID: () => 7,
  players: () => [alliedBorderMe, strongAlly],
  config: () => ({ maxTroops: () => 100000 }),
};
const alliedBorderBehavior = new sandbox.AttackBehavior(
  {},
  alliedBorderGame,
  alliedBorderMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
ownTroops = 25000;
assert.equal(
  alliedBorderBehavior.getStrongestBorderOpponentTroops(),
  0,
  "a stronger bordering ally does not consume the TerraNullius attack budget",
);
const expandingGame = {
  ticks: () => tick,
  players: () => [me],
  neighbors: () => [2],
  isLand: () => true,
  hasOwner: () => false,
  ownerID: () => null,
  magnitude: () => 8,
  hasFallout: () => false,
  config: () => ({
    maxTroops: () => 500000,
    attackLogic: () => ({ attackerTroopLoss: 2 }),
  }),
};
const expandingBehavior = new sandbox.AttackBehavior({}, expandingGame, me, 0.5, 0.3, 0.1, {}, {});
expandingBehavior.getEnemyDefensePostAttackProfile = () => ({});
expandingBehavior.attackIsTooWeakForDefensePosts = () => false;
expandingBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
ownTroops = 25000;
assert.ok(
  expandingBehavior.getEarlyGameLiveReserveTroops() > ownTroops * 0.4,
  "the capacity-derived acceleration reserve is high enough to reproduce the opening wait",
);
assert.equal(
  expandingBehavior.getEarlyGameTerraNulliusReserveTroops(),
  ownTroops * 0.4,
  "TerraNullius retains the configured 40% opening safety reserve",
);
const terraNulliusEmissionCount = troopEmissions.length;
assert.equal(
  expandingBehavior.sendLandAttack(terraNullius),
  true,
  "free land remains actionable after maxTroops increases",
);
assert.equal(troopEmissions.length, terraNulliusEmissionCount + 1);
assert.equal(
  attackRecipients.at(-1),
  null,
  "a free-land attack uses the client protocol's explicit null target",
);
assert.equal(
  troopEmissions.at(-1),
  15000,
  "direct TerraNullius land expansion commits the configured opening share",
);

expandingBehavior.botAttackPendingIntentCommitments = [];
ownTroops = 10000;
assert.equal(
  expandingBehavior.getTerraNulliusAttackTroops(terraNullius),
  100,
  "the first 1% follow-up is affordable immediately after the 60% opening burst",
);
ownTroops = 25000;
assert.equal(
  expandingBehavior.getTerraNulliusAttackTroops(terraNullius),
  250,
  "an exhausted opening allowance continues adjacent TerraNullius expansion at 1%",
);
const continuedTerraNulliusEmissionCount = troopEmissions.length;
assert.equal(
  expandingBehavior.sendLandAttack(terraNullius),
  true,
  "the live land emitter uses the TerraNullius liveness budget",
);
assert.equal(troopEmissions.length, continuedTerraNulliusEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  250,
  "the continued TerraNullius intent emits 1% when it exceeds the one-tile cost",
);

expandingBehavior.botAttackPendingIntentCommitments = [
  {
    targetIsPlayer: true,
    targetKey: "tribe-pending",
    attackType: "land",
    troops: 2,
    createdTick: tick,
    baselineTroops: ownTroops,
    baselineTargetTroops: 0,
    baselineAttackIDs: new Set(),
    baselineTransportIDs: new Set(),
  },
];
expandingBehavior.outboundIntentReconciledTick = null;
const pendingTribeTerraNulliusEmissionCount = troopEmissions.length;
assert.equal(
  await expandingBehavior.sendAttack(terraNullius),
  true,
  "a pending tribe intent cannot starve higher-priority adjacent TerraNullius",
);
assert.equal(troopEmissions.length, pendingTribeTerraNulliusEmissionCount + 1);
expandingBehavior.botAttackPendingIntentCommitments = [];

ownTroops = 10000;
assert.equal(
  expandingBehavior.getEarlyGameTerraNulliusReserveTroops(),
  10000,
  "TerraNullius keeps the original safety floor after the opening army shrinks",
);
const drainedExpansionEmissionCount = troopEmissions.length;
assert.equal(
  expandingBehavior.sendLandAttack(terraNullius),
  true,
  "chained TerraNullius expansion keeps the derived 1% liveness allowance at the opening floor",
);
assert.equal(troopEmissions.length, drainedExpansionEmissionCount + 1);
assert.equal(troopEmissions.at(-1), 100);
ownTroops = 25000;

const openingBehavior = new sandbox.AttackBehavior({}, expandingGame, me, 0.5, 0.3, 0.1, {}, {});
const openingEmissionCount = troopEmissions.length;
assert.equal(
  await openingBehavior.forceSendAttack(terraNullius),
  true,
  "the first TerraNullius opening burst is not blocked by the capacity-derived reserve",
);
assert.equal(troopEmissions.length, openingEmissionCount + 1);
assert.equal(troopEmissions.at(-1), 15000);

const scheduledBehavior = new sandbox.AttackBehavior({}, expandingGame, me, 0.5, 0.3, 0.1, {}, {});
ownTroops = 25000;
tick = 20;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 15000);
tick = 120;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 15000);
tick = 320;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 15000);
tick = 520;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 15000);
tick = 521;
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  Number.POSITIVE_INFINITY,
  "after opening tick 500, the adaptive production/threat reserve takes over",
);
tick = 9;

// emitBoat is the final synchronous boundary after the route/launch await. It
// must reapply the same target-specific reserve instead of falling back to the
// lower acceleration reserve when the troop snapshot changed during the await.
const boatBudgetBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
ownTroops = 80000;
assert.equal(
  boatBudgetBehavior.emitBoat("boat-destination", 50000, "⛵ test boat", humanTarget),
  true,
);
assert.equal(
  troopEmissions.at(-1),
  ownTroops - productionPeakReserve,
  "the final boat boundary preserves the Nation/Human production peak",
);
ownTroops = 100000;

// Tribe attacks must be all-or-nothing: if visible and pending commitments plus
// the available force cannot meet the combat policy's minimum, do not emit a
// partial attack that merely weakens the tribe and leaves it blocking expansion.
const tribeTarget = {
  isPlayer: () => true,
  type: () => "Bot",
  id: () => "tribe-target",
  smallID: () => 3,
  troops: () => 10000,
  units: () => [],
};
const tribeBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
tribeBehavior.getEnemyDefensePostAttackProfile = () => ({});
tribeBehavior.attackIsTooWeakForDefensePosts = () => false;
tribeBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
ownTroops = 30000;
const tribeEmissionCount = troopEmissions.length;
assert.equal(tribeBehavior.sendLandAttack(tribeTarget), true);
assert.equal(
  troopEmissions.length,
  tribeEmissionCount + 1,
  "a sufficiently funded tribe assault is emitted",
);
assert.ok(
  troopEmissions.at(-1) >= tribeTarget.troops() * 2,
  "a tribe assault meets the calculated minimum instead of weakening the tribe",
);
assert.ok(
  ownTroops - troopEmissions.at(-1) >= tribeBehavior.getEarlyGameLiveReserveTroops(),
  "a completed tribe assault still respects the acceleration reserve",
);

const underfundedTribeBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
underfundedTribeBehavior.getEnemyDefensePostAttackProfile = () => ({});
underfundedTribeBehavior.attackIsTooWeakForDefensePosts = () => false;
underfundedTribeBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
ownTroops = 40000;
underfundedTribeBehavior.recordOutboundAttackIntent(tribeTarget, 15000, {
  attackType: "land",
});
const underfundedEmissionCount = troopEmissions.length;
sandbox.currentDifficulty = () => "Easy";
assert.equal(
  underfundedTribeBehavior.sendLandAttack(tribeTarget),
  true,
  "an underfunded pending tribe assault receives the still-missing top-up",
);
assert.equal(
  troopEmissions.length,
  underfundedEmissionCount + 1,
  "the pending intent is not mistaken for a complete capture force",
);
assert.equal(troopEmissions.at(-1), 5000);
sandbox.currentDifficulty = () => "Impossible";

// Different hostile targets may be launched in the same decision. Pending
// intent accounting reserves the first payload without globally locking the
// second target.
const parallelMe = {
  ...me,
  sharesBorderWith: () => true,
  isFriendly: () => false,
};
const parallelTribeA = {
  ...tribeTarget,
  id: () => "tribe-parallel-a",
  smallID: () => 21,
  troops: () => 1000,
};
const parallelTribeB = {
  ...tribeTarget,
  id: () => "tribe-parallel-b",
  smallID: () => 22,
  troops: () => 1000,
};
const parallelBehavior = new sandbox.AttackBehavior({}, game, parallelMe, 0.5, 0.3, 0.1, {}, {});
parallelBehavior.getEnemyDefensePostAttackProfile = () => ({});
parallelBehavior.attackIsTooWeakForDefensePosts = () => false;
parallelBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
outgoing.length = 0;
ownTroops = 100000;
tick = 20;
const parallelEmissionCount = troopEmissions.length;
assert.equal(await parallelBehavior.sendAttack(parallelTribeA), true);
assert.equal(
  await parallelBehavior.sendAttack(parallelTribeB),
  true,
  "a pending intent against one tribe does not block another hostile target",
);
assert.equal(
  troopEmissions.length,
  parallelEmissionCount + 2,
  "two different tribe assaults are emitted in one decision",
);
assert.equal(
  parallelBehavior.getPendingOutboundAttackTroops(),
  4000,
  "parallel tribal intents reserve only each tribe's minimum capture force",
);
assert.deepEqual(
  [...parallelBehavior.getActiveTribeAttackTargetKeys()].sort(),
  ["21", "22"],
  "active tribal targets are tracked independently",
);

outgoing.push({
  id: () => "growing-tribe-attack",
  retreating: () => false,
  target: () => parallelTribeA,
  troops: () => 3000,
});
parallelTribeA.troops = () => 2000;
assert.equal(parallelBehavior.getLiveOutboundAttackTroopsForTarget(parallelTribeA), 3000);
parallelBehavior.botAttackTroopsSent = 0;
assert.equal(
  parallelBehavior.calculateBotAttackTroops(parallelTribeA, 10000, {}, 3000),
  1000,
  "a growing tribe receives only the missing top-up to the live 2x capture floor",
);

parallelBehavior.botAttackPendingIntentCommitments = [
  {
    targetIsPlayer: true,
    targetKey: "21",
    attackType: "land",
    troops: 500,
    createdTick: tick,
    baselineTroops: ownTroops,
    baselineTargetTroops: 3000,
    baselineAttackIDs: new Set(["growing-tribe-attack"]),
    baselineTransportIDs: new Set(),
  },
];
parallelBehavior.outboundIntentReconciledTick = tick;
parallelTribeA.troops = () => 2500;
parallelBehavior.botAttackTroopsSent = 0;
assert.equal(
  parallelBehavior.calculateBotAttackTroops(parallelTribeA, 10000, {}, 3000),
  1500,
  "tribe reinforcement includes a pending top-up but still fills a newly grown capture floor",
);
outgoing.length = 0;
parallelTribeA.troops = () => 1000;
parallelBehavior.botAttackPendingIntentCommitments = [];

const growingNation = {
  isPlayer: () => true,
  smallID: () => 31,
  id: () => "nation-31",
  type: () => sandbox.PlayerType.Nation,
  troops: () => 2000,
  units: () => [],
};
outgoing.push({
  id: () => "growing-nation-attack",
  retreating: () => false,
  target: () => growingNation,
  troops: () => 3000,
});
parallelBehavior.botAttackPendingIntentCommitments = [];
parallelBehavior.outboundIntentReconciledTick = null;
const nationReinforcementEmissionCount = troopEmissions.length;
assert.equal(
  await parallelBehavior.reinforceIncompleteOutboundPlayerAttack(),
  true,
  "an active attack against a growing Nation is rediscovered and reinforced",
);
assert.equal(troopEmissions.length, nationReinforcementEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  5000,
  "the Nation reinforcement sends only the missing live 4x strength",
);
outgoing.length = 0;

const botParallelTargets = [parallelTribeA, parallelTribeB].map((target) => ({
  ...target,
  numTilesOwned: () => 1,
}));
const botParallelPlayer = {
  ...parallelMe,
  nearby: () => botParallelTargets,
  isFriendly: () => false,
};
const botParallelBehavior = new sandbox.AttackBehavior(
  {},
  game,
  botParallelPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
botParallelBehavior.getEnemyDefensePostAttackProfile = () => ({});
botParallelBehavior.attackIsTooWeakForDefensePosts = () => false;
botParallelBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
outgoing.length = 0;
tick = 21;
const botParallelEmissionCount = troopEmissions.length;
assert.equal(await botParallelBehavior.attackBots(), true);
assert.equal(
  troopEmissions.length,
  botParallelEmissionCount + 2,
  "the general tribe attack pass also emits multiple captures",
);

botParallelBehavior.botAttackPendingIntentCommitments = [];
botParallelBehavior.outboundIntentReconciledTick = null;
botParallelBehavior.earlyGamePreferredClusterTargetKeys = new Set(["21"]);
botParallelTargets[0].troops = () => 2000;
botParallelPlayer.nearby = () => [botParallelTargets[1]];
outgoing.push({
  id: () => "incomplete-general-tribe-attack",
  retreating: () => false,
  target: () => botParallelTargets[0],
  troops: () => 3000,
});
tick = 22;
const reinforcementEmissionCount = troopEmissions.length;
assert.equal(
  await botParallelBehavior.attackBots(),
  true,
  "the general tribe pass revisits an active attack below its live capture floor",
);
assert.equal(troopEmissions.length, reinforcementEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  1000,
  "an incomplete tribe attack receives only the missing reinforcement",
);

botParallelBehavior.botAttackPendingIntentCommitments = [];
botParallelBehavior.outboundIntentReconciledTick = null;
outgoing[0].troops = () => 4000;
tick = 23;
assert.equal(
  await botParallelBehavior.attackBots(),
  false,
  "a tribe attack already at the capture floor is not reinforced again",
);
outgoing.length = 0;
botParallelPlayer.nearby = () => botParallelTargets;
const clusterFilteredCalls = [];
botParallelBehavior.botAttackPendingIntentCommitments = [];
botParallelBehavior.outboundIntentReconciledTick = null;
botParallelBehavior.earlyGamePreferredClusterTargetKeys = new Set(["21"]);
botParallelBehavior.sendAttack = async (...args) => {
  clusterFilteredCalls.push(args);
  return true;
};
assert.equal(await botParallelBehavior.attackBots(), true);
assert.equal(
  clusterFilteredCalls.length,
  1,
  "the generic tribe fallback cannot leak troops outside the preferred cluster",
);
assert.equal(clusterFilteredCalls[0][0].smallID(), parallelTribeA.smallID());

const makeEarlyTribeCandidate = (id, player) => ({
  id,
  player,
  maritimeDistance: 0,
  oceanDistance: 0,
  futureFoodCount: 1,
  futureFoodAccess: 0.5,
  foodRaceValue: 0.1,
  encirclement: 0,
  blockValue: 0,
  cheapCapture: 0.1,
  landBorder: true,
  boatEtaTicks: null,
});
const earlyTribeCalls = [];
const earlyTribeBatch = Object.create(sandbox.AttackBehavior.prototype);
earlyTribeBatch.player = { troops: () => 100000 };
earlyTribeBatch.getEarlyGameTribeCandidates = async () => [
  makeEarlyTribeCandidate("early-a", parallelTribeA),
  makeEarlyTribeCandidate("early-b", parallelTribeB),
];
earlyTribeBatch.getActiveTribeAttackTargetKeys = () => new Set();
earlyTribeBatch.getBotAttackMaxParallelism = () => 2;
earlyTribeBatch.sendAttack = async (...args) => {
  earlyTribeCalls.push(args);
  return true;
};
sandbox.state.earlyGame = {};
assert.equal(await earlyTribeBatch.attackEarlyGameTribe(), true);
assert.equal(
  earlyTribeCalls.length,
  2,
  "the early-game tribe planner attempts multiple ranked captures",
);
assert.ok(
  earlyTribeCalls.every((args) => args[5] === true),
  "each early-game tribe capture opts into the bounded parallel path",
);

earlyTribeCalls.length = 0;
earlyTribeBatch.getEarlyGameTribeCandidates = async () => [
  {
    ...makeEarlyTribeCandidate("largest-cluster", parallelTribeA),
    tribeClusterAccess: 1,
  },
  {
    ...makeEarlyTribeCandidate("smaller-cluster", parallelTribeB),
    tribeClusterAccess: 0.25,
  },
];
assert.equal(await earlyTribeBatch.attackEarlyGameTribe(), true);
assert.equal(
  earlyTribeCalls.length,
  1,
  "parallel expansion does not spend troops outside the largest tribe cluster",
);
assert.equal(earlyTribeCalls[0][0], parallelTribeA);

// A crowded Impossible batch must stop at the local intent budget instead of
// calling sendAttack for every one of the 100 possible parallel targets.
let remainingIntentCapacity = 2;
sandbox.hasIntentRateLimitCapacity = () => remainingIntentCapacity > 0;
const throttledTargets = Array.from({ length: 12 }, (_, index) => ({
  ...parallelTribeA,
  id: () => `throttled-${index}`,
  smallID: () => 100 + index,
  numTilesOwned: () => 1,
}));
const throttledParallelPlayer = {
  ...parallelMe,
  nearby: () => throttledTargets,
  isFriendly: () => false,
};
const throttledParallelCalls = [];
const throttledParallelBehavior = new sandbox.AttackBehavior(
  {},
  game,
  throttledParallelPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
throttledParallelBehavior.getEnemyDefensePostAttackProfile = () => ({});
throttledParallelBehavior.sendAttack = async (...args) => {
  throttledParallelCalls.push(args);
  remainingIntentCapacity -= 1;
  return true;
};
assert.equal(await throttledParallelBehavior.attackBots(), true);
assert.equal(
  throttledParallelCalls.length,
  2,
  "a parallel batch stops when the local intent budget is empty",
);
assert.equal(
  remainingIntentCapacity,
  0,
  "the batch consumes only the available local intent capacity",
);

remainingIntentCapacity = 1;
const throttledEarlyTribeCalls = [];
const throttledEarlyTribeBatch = Object.create(sandbox.AttackBehavior.prototype);
throttledEarlyTribeBatch.player = { troops: () => 100000 };
throttledEarlyTribeBatch.getEarlyGameTribeCandidates = async () =>
  throttledTargets.map((target, index) =>
    makeEarlyTribeCandidate(`early-throttled-${index}`, target),
  );
throttledEarlyTribeBatch.getActiveTribeAttackTargetKeys = () => new Set();
throttledEarlyTribeBatch.getBotAttackMaxParallelism = () => 100;
throttledEarlyTribeBatch.sendAttack = async (...args) => {
  throttledEarlyTribeCalls.push(args);
  remainingIntentCapacity -= 1;
  return true;
};
assert.equal(await throttledEarlyTribeBatch.attackEarlyGameTribe(), true);
assert.equal(
  throttledEarlyTribeCalls.length,
  1,
  "the early-game parallel tribe batch also stops at the local budget",
);
sandbox.hasIntentRateLimitCapacity = undefined;
tick = 9;
ownTroops = 100000;

// A peaceful teammate donation may release only the surplus above the
// calculated ~42% troop-production peak.
let donorTroops = 80000;
let donorBorderTiles = new Set();
let donorIncomingAttacks = [];
const donor = {
  troops: () => donorTroops,
  smallID: () => 11,
  isAlive: () => true,
  isOnSameTeam: (player) => [11, 12, 14].includes(player?.smallID?.()),
  borderTiles: () => donorBorderTiles,
  incomingAttacks: () => donorIncomingAttacks,
};
const needyTeammate = {
  troops: () => 8000,
  smallID: () => 12,
  id: () => "player-12",
  isAlive: () => true,
  incomingAttacks: () => [],
  outgoingAttacks: () => [],
};
let donationPlayers = [donor, needyTeammate];
const donationOwnerByTile = new Map();
const donationGame = {
  ticks: () => tick,
  players: () => donationPlayers,
  neighbors: (tile) => (tile === 1 ? [...donationOwnerByTile.keys()] : []),
  isLand: () => true,
  hasOwner: (tile) => donationOwnerByTile.has(tile),
  ownerID: (tile) => donationOwnerByTile.get(tile),
  getWinner: () => null,
  config: () => ({
    maxTroops: (player) => (player?.smallID?.() === 14 ? 130000 : 100000),
    gameConfig: () => ({ gameMode: "Team" }),
    donateTroops: () => true,
  }),
};
const donorBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);

// A needy teammate does not have to share our border. The outer attack-strategy
// gate must still reach donation when our army is below the unrelated attack
// trigger ratio but has troops available above the donation reserve.
const donorSpendableTroops = donorBehavior.getEarlyGameSpendableTroops.bind(donorBehavior);
donorBehavior.getEarlyGameSpendableTroops = () => 1;
donorBehavior.hasTriggerRatioTroops = () => false;
donorBehavior.hasNeighboringBotWithStructures = () => false;
let remoteDonationStrategyReached = false;
donorBehavior.getAttackStrategies = () => [
  async () => {
    remoteDonationStrategyReached = true;
    return true;
  },
];
await donorBehavior.attackBestTarget([], []);
assert.equal(
  remoteDonationStrategyReached,
  true,
  "a remote needy teammate keeps the donation strategy reachable",
);
donorBehavior.getEarlyGameSpendableTroops = donorSpendableTroops;

assert.equal(donorBehavior.donateTroops(), true);
assert.equal(
  troopEmissions.at(-1),
  38212,
  "donations release only the surplus above the calculated production peak",
);

const emissionsBeforeAttackedDonation = troopEmissions.length;
donorIncomingAttacks = [{ troops: () => 1 }];
assert.equal(
  donorBehavior.donateTroops(),
  false,
  "being under attack is an absolute donation veto",
);
assert.equal(troopEmissions.length, emissionsBeforeAttackedDonation);
donorIncomingAttacks = [];

// An actively attacked ally outranks a needier rear ally. Immediate danger is
// more important than clan affinity or raw troop percentage.
const attackedTeammate = {
  troops: () => 50000,
  smallID: () => 17,
  id: () => "player-17",
  isAlive: () => true,
  incomingAttacks: () => [{ troops: () => 20000 }],
  outgoingAttacks: () => [],
};
donor.isOnSameTeam = (player) => [11, 12, 14, 17].includes(player?.smallID?.());
donationPlayers = [donor, needyTeammate, attackedTeammate];
const donationRecipients = [];
const originalEmitIntent = sandbox.emitIntent;
sandbox.emitIntent = (_ctor, recipient, troops) => {
  donationRecipients.push(recipient);
  troopEmissions.push(troops);
  return true;
};
const urgentDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(urgentDonationBehavior.donateTroops(), true);
assert.equal(
  donationRecipients.at(-1),
  attackedTeammate,
  "an actively attacked ally receives peaceful surplus before a needier rear ally",
);
sandbox.emitIntent = originalEmitIntent;

// The reserve must use the strongest army among every live player sharing our
// border. A remote 200k army is irrelevant, while the allied 130k border army
// is still a valid safety constraint, so a 100k donor may release only 35k.
const makeBorderOpponent = (id, troops, onSameTeam = false) => ({
  troops: () => troops,
  smallID: () => id,
  isAlive: () => true,
  isOnSameTeam: () => onSameTeam,
});
const weakBorderOpponent = makeBorderOpponent(13, 80000);
const strongBorderOpponent = makeBorderOpponent(15, 120000);
const alliedBorderOpponent = makeBorderOpponent(14, 130000, true);
const remoteOpponent = makeBorderOpponent(16, 200000);
donorTroops = 100000;
donorBorderTiles = new Set([1]);
donationOwnerByTile.clear();
donationOwnerByTile.set(2, weakBorderOpponent.smallID());
donationOwnerByTile.set(3, strongBorderOpponent.smallID());
donationOwnerByTile.set(4, alliedBorderOpponent.smallID());
donationPlayers = [
  donor,
  needyTeammate,
  weakBorderOpponent,
  strongBorderOpponent,
  alliedBorderOpponent,
  remoteOpponent,
];
const borderDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(borderDonationBehavior.donateTroops(), true);
assert.equal(
  troopEmissions.at(-1),
  35000,
  "the strongest allied border army controls the donation cap; remote armies do not",
);

// If the client does not expose SendDonateTroopsIntentEvent, the wire fallback
// must preserve the same recipient id and donation amount instead of dropping a
// valid teammate donation.
const fallbackPackets = [];
sandbox.discoverCtors = () => ({ donateTroops: null });
sandbox.sendGamePacket = (packet) => {
  fallbackPackets.push(packet);
  return true;
};
const fallbackDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(fallbackDonationBehavior.donateTroops(), true);
assert.equal(fallbackPackets.at(-1)?.type, "donate_troops");
assert.equal(fallbackPackets.at(-1)?.recipient, "player-12");
assert.equal(
  fallbackPackets.at(-1)?.troops,
  35000,
  "donations fall back to the rate-limited direct intent packet",
);
sandbox.discoverCtors = () => ({
  attack: "attack",
  boat: "boat",
  donateTroops: "donateTroops",
});
delete sandbox.sendGamePacket;

const assertDonationPausedDuringExpansion = (earlyGame, message) => {
  sandbox.state.settings.pauseDonateDuringExpansion = true;
  sandbox.state.earlyGame = earlyGame;
  const pausedBehavior = new sandbox.AttackBehavior(
    { chance: () => true },
    donationGame,
    donor,
    0.5,
    0.3,
    0.1,
    {},
    {},
  );
  assert.equal(pausedBehavior.donateTroops(), false, message);
};

assertDonationPausedDuringExpansion(
  { active: true, hasFreeLand: true, actionableTribes: [] },
  "free land pauses the complete donation path",
);
assertDonationPausedDuringExpansion(
  {
    active: true,
    hasFreeLand: false,
    actionableTribes: [{ landBorder: true }],
  },
  "a land-border tribe pauses the complete donation path",
);
assertDonationPausedDuringExpansion(
  {
    active: true,
    hasFreeLand: false,
    actionableTribes: [{ landBorder: false, boatEtaTicks: 30 }],
  },
  "a reachable sea tribe pauses the complete donation path",
);
sandbox.state.earlyGame = { active: false, hasFreeLand: false, actionableTribes: [] };
sandbox.state.settings.pauseDonateDuringExpansion = false;

sandbox.state.settings.winFixes = false;
const nonWinFixHumanBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
nonWinFixHumanBehavior.getEnemyDefensePostAttackProfile = () => ({});
nonWinFixHumanBehavior.attackIsTooWeakForDefensePosts = () => false;
nonWinFixHumanBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
ownTroops = 80000;
assert.equal(nonWinFixHumanBehavior.sendLandAttack(humanTarget), true);
assert.equal(
  troopEmissions.at(-1),
  ownTroops - nonWinFixHumanBehavior.getEarlyGameProductionReserveTroops(),
  "the production-rate reserve remains hard even when winFixes is disabled",
);
ownTroops = 100000;
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  80005,
  "the hard reserve and pending donation guard is independent of winFixes",
);

process.stdout.write("attack intent accounting tests passed\n");
