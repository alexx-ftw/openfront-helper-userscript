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

assert.match(
  source,
  /EARLY_GAME_MARITIME_SLICE_INTERVAL_TICKS\s*=\s*4/,
  "maritime index preparation is explicitly throttled between attack-relevant ticks",
);
assert.match(
  source,
  /tick - lastSliceTick < EARLY_GAME_MARITIME_SLICE_INTERVAL_TICKS/,
  "the maritime slice throttle guards the expensive cooperative advance",
);

const UNIT = {
  TransportShip: "Transport",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRVWarhead: "MIRV Warhead",
  City: "City",
  DefensePost: "Defense Post",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  Port: "Port",
  Factory: "Factory",
};
const troopEmissions = [];
const attackRecipients = [];
const cancelledAttackIds = [];
class CancelAttackIntent {
  constructor(attackID) {
    this.attackID = attackID;
  }
}
const eventBus = {
  emit: (event) => cancelledAttackIds.push(event.attackID),
};
const sandbox = {
  UNIT,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Relation: { Friendly: 1 },
  EMOJI_ASSIST_ACCEPT: "assist-accept",
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  currentDifficulty: () => "Impossible",
  EARLY_EXPAND_COMMIT: 0.1,
  EARLY_EXPAND_OPENING_LIMIT: 0.4,
  EARLY_EXPAND_FOLLOWUP_COMMIT: 0.1,
  EARLY_EXPAND_MINIMUM_MARGIN: 1.25,
  EARLY_EXPAND_OPENING_REBASE_RATIO: 1.25,
  WORKER_TIMEOUT_MS: 100,
  performance: { now: () => 10000 },
  discoverCtors: () => ({
    attack: "attack",
    boat: "boat",
    donateTroops: "donateTroops",
    cancelAttack: CancelAttackIntent,
  }),
  getEventBus: () => eventBus,
  emitIntent: (_ctor, recipient, troops) => {
    attackRecipients.push(recipient);
    troopEmissions.push(troops);
    return true;
  },
  setLastAction: () => {},
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  withTimeout: async (promise) => promise,
  closestTwoTiles: () => ({ x: 1, y: 101 }),
  calculateBoundingBoxCenter: () => ({ x: 0, y: 0 }),
  tr: (value) => value,
  state: {
    settings: { winFixes: true, features: { donate: true, boat: true } },
    stats: {},
    earlyGame: {},
  },
  __OFHSpawnObjective: {
    getPlayerClanTag: (player) => player.clanTag?.() ?? null,
    sameClanTag: (left, right) =>
      typeof left === "string" &&
      typeof right === "string" &&
      left.toUpperCase() === right.toUpperCase(),
  },
};

executeClassicScript(earlyGameSource, sandbox, { filename: earlyGamePath });
executeClassicScript(
  `${source}\nglobalThis.AttackBehavior = AttackBehavior;\nglobalThis.BOT_OUTBOUND_INTENT_GRACE_TICKS = BOT_OUTBOUND_INTENT_GRACE_TICKS;`,
  sandbox,
  { filename: sourcePath },
);

let tick = 0;
let ownTroops = 100000;
const outgoing = [];
let transports = [];
const me = {
  troops: () => ownTroops,
  smallID: () => 1,
  numTilesOwned: () => 100,
  type: () => "Human",
  units: (type) => (type === UNIT.TransportShip ? transports : []),
  borderTiles: () => new Set([1]),
  outgoingAttacks: () => outgoing,
};
const game = {
  ticks: () => tick,
  ownerID: () => 0,
  x: (tile) => Number(tile) % 100,
  y: (tile) => Math.floor(Number(tile) / 100),
  numLandTiles: () => 1000,
  numTilesWithFallout: () => 0,
  config: () => ({ maxTroops: () => 100000 }),
};
const opportunisticRandomBoatBehavior = Object.create(sandbox.AttackBehavior.prototype);
const invadedBoatBudget = Object.create(sandbox.AttackBehavior.prototype);
invadedBoatBudget.player = { troops: () => 2_940_485 };
invadedBoatBudget.getPendingOutboundTroopCommitments = () => 586_098;
invadedBoatBudget.getEarlyGameLiveReserveTroops = () => 1_000_000;
invadedBoatBudget.getEarlyGameTargetReserveTroops = () => 1_000_000;
let boatIncomingTroops = 2_782_124;
invadedBoatBudget.incomingHostileAttacks = () => [{ troops: () => boatIncomingTroops }];
assert.equal(
  invadedBoatBudget.resolveBoatTroops(735_121, null, false),
  0,
  "a transport cannot drain defenders while a counterattack is pending against an army-sized invasion",
);
boatIncomingTroops = 2_000_000;
assert.equal(invadedBoatBudget.resolveBoatTroops(735_121, {}, false), 354_387);
assert.equal(invadedBoatBudget.resolveBoatTroops(735_121, {}, true), 0);
boatIncomingTroops = 0;
assert.equal(invadedBoatBudget.resolveBoatTroops(735_121, null, false), 735_121);
const opportunisticRandomBoatCalls = [];
opportunisticRandomBoatBehavior.random = { randElement: () => "shore" };
opportunisticRandomBoatBehavior.findRandomBoatTarget = async (...args) => {
  opportunisticRandomBoatCalls.push(args);
  return "destination";
};
opportunisticRandomBoatBehavior.boatTargetTaken = () => false;
opportunisticRandomBoatBehavior.game = { hasOwner: () => false };
const opportunisticRandomBoatTarget =
  await opportunisticRandomBoatBehavior.randomOpportunisticBoatTarget(["shore"], true);
assert.equal(
  opportunisticRandomBoatTarget?.dst,
  "destination",
  "opportunistic random boats retain a valid discovered destination",
);
assert.equal(opportunisticRandomBoatTarget?.dstOwned, false);
assert.equal(opportunisticRandomBoatTarget?.dstFallout, false);
assert.equal(opportunisticRandomBoatTarget?.lowFillOk, false);
assert.equal(opportunisticRandomBoatCalls.length, 1);
assert.equal(opportunisticRandomBoatCalls[0][0], "shore");
assert.equal(opportunisticRandomBoatCalls[0][1].length, 0);
assert.equal(opportunisticRandomBoatCalls[0][2], true);
assert.equal(opportunisticRandomBoatCalls[0][3], true);
assert.equal(opportunisticRandomBoatCalls[0][4].maxProbes, 1);
assert.equal(
  opportunisticRandomBoatCalls[0][4].timeoutMs,
  75,
  "the low-priority opportunistic random stage limits itself to one short route probe",
);
const routeTimeoutBehavior = Object.create(sandbox.AttackBehavior.prototype);
let routeTimeout = null;
routeTimeoutBehavior.getBoatRouteEta = async (_tile, timeoutMs) => {
  routeTimeout = timeoutMs;
  return 1;
};
assert.equal(
  await routeTimeoutBehavior.allowBoatExplorationRoute("destination", 75),
  true,
  "the route gate accepts an in-budget exploratory route",
);
assert.equal(
  routeTimeout,
  75,
  "the route gate forwards the bounded worker timeout to ETA estimation",
);

const incrementalNearbyBoatBehavior = Object.create(sandbox.AttackBehavior.prototype);
let nearbyScanTick = 500;
let nearbyScanCalls = 0;
incrementalNearbyBoatBehavior.random = { randElement: (values) => values[0] };
incrementalNearbyBoatBehavior.player = {
  smallID: () => 1,
  troops: () => 100_000,
};
incrementalNearbyBoatBehavior.game = {
  ticks: () => nearbyScanTick,
  x: (tile) => Number(tile),
  y: () => 0,
  isValidCoord: () => true,
  ref: (x) => x,
  isLand: () => {
    nearbyScanCalls++;
    return false;
  },
};
sandbox.state.settings = {
  ...sandbox.state.settings,
  islandScanRadius: 40,
  islandScanStep: 1,
  islandScanSamples: 1,
  islandProbeMax: 4,
};
const firstNearbySlice = await incrementalNearbyBoatBehavior.scanNearbyTargets([0]);
assert.equal(firstNearbySlice.pending, true);
assert.equal(
  nearbyScanCalls,
  128,
  "nearby boat discovery processes only its fixed cursor budget in one decision",
);
const secondNearbySlice = await incrementalNearbyBoatBehavior.scanNearbyTargets([0]);
assert.equal(secondNearbySlice.pending, true);
assert.equal(
  nearbyScanCalls,
  256,
  "the next decision resumes the same nearby scan cursor instead of restarting the search",
);
nearbyScanTick += 301;
await incrementalNearbyBoatBehavior.scanNearbyTargets([0]);
assert.equal(
  nearbyScanCalls,
  384,
  "an expired nearby scan session restarts with a bounded fresh slice",
);
const pendingNearbyStageBehavior = Object.create(sandbox.AttackBehavior.prototype);
pendingNearbyStageBehavior.opportunisticBoatSearchStageName = "nearby";
pendingNearbyStageBehavior.nearbyOpportunisticBoatTarget = async () => ({
  dst: null,
  scanCandidates: 0,
  pending: true,
});
assert.equal(
  (await pendingNearbyStageBehavior.findOpportunisticBoatTarget([], null)).pending,
  true,
  "a pending nearby cursor does not advance the opportunistic boat ladder before its ranking is complete",
);
const target = {
  isPlayer: () => true,
  smallID: () => 2,
  id: () => "tribe-2",
  tribeClusterSize: 1,
  tribeClusterAccess: 1,
};

const behavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});

const makeBorderWrapper = (smallID, troops) => ({
  isPlayer: () => true,
  smallID: () => smallID,
  troops: () => troops,
});
const borderingIdentityBehavior = Object.create(sandbox.AttackBehavior.prototype);
borderingIdentityBehavior.game = {
  ownerID: (tile) => (tile === 3 ? 8 : 7),
  playerBySmallID: (smallID) =>
    smallID === 7 ? makeBorderWrapper(7, 2_000) : makeBorderWrapper(8, 1_000),
};
borderingIdentityBehavior.player = {
  sharesBorderWith: () => true,
};
const borderingWrappers = borderingIdentityBehavior.borderingPlayersFrom(
  [1, 2, 3],
  [makeBorderWrapper(7, 2_000), makeBorderWrapper(9, 500)],
);
assert.deepEqual(
  Array.from(borderingWrappers, (player) => Number(player.smallID())),
  [9, 8, 7],
  "border target discovery deduplicates fresh player wrappers by smallID",
);

// A Nation-only lobby has no tribe target.  The early tribe planner must
// return before building a whole-map competitor/topology snapshot.
const nationOnly = {
  isPlayer: () => true,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Nation,
  smallID: () => 99,
};
me.isFriendly = () => false;
game.players = () => [me, nationOnly];
let nationOnlyCompetitorProfiles = 0;
behavior.getEarlyGameCompetitorProfiles = async () => {
  nationOnlyCompetitorProfiles++;
  return [];
};
behavior.publishPreferredEarlyGameCluster = () => {};
assert.equal(
  (await behavior.getEarlyGameTribeCandidates()).length,
  0,
  "a Nation-only lobby has no early tribe candidates",
);
assert.equal(
  nationOnlyCompetitorProfiles,
  0,
  "a Nation-only lobby bypasses expensive competitor and topology work",
);

// Candidate enrichment runs cooperatively.  The combat tick must use its
// last completed snapshot instead of awaiting the next refresh.
const asyncCandidateBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
let resolveCandidateRefresh;
let candidateRefreshStarts = 0;
asyncCandidateBehavior.getEarlyGameTribeCandidates = () => {
  candidateRefreshStarts++;
  return new Promise((resolve) => {
    resolveCandidateRefresh = resolve;
  });
};
assert.equal(
  (await asyncCandidateBehavior.getReadyEarlyGameTribeCandidates()).length,
  0,
  "the first cooperative tribe refresh cannot stall the combat tick",
);
resolveCandidateRefresh([target]);
await Promise.resolve();
assert.equal(
  (await asyncCandidateBehavior.getReadyEarlyGameTribeCandidates())[0],
  target,
  "the next decision receives the completed tribe snapshot",
);
assert.equal(
  candidateRefreshStarts,
  1,
  "a non-empty scored tribe snapshot is reused instead of relaunching the planner every decision",
);

let plannerCacheTick = 200;
const tribeA = {
  isAlive: () => true,
  isPlayer: () => true,
  smallID: () => 20,
  type: () => sandbox.PlayerType.Bot,
};
const tribeB = {
  isAlive: () => true,
  isPlayer: () => true,
  smallID: () => 21,
  type: () => sandbox.PlayerType.Bot,
};
let livePlannerTribes = [tribeA];
const plannerCacheBehavior = new sandbox.AttackBehavior(
  {},
  {
    players: () => livePlannerTribes,
    ticks: () => plannerCacheTick,
  },
  { isFriendly: () => false },
  0.5,
  0.3,
  0.1,
  {},
  {},
);
let plannerCacheRefreshStarts = 0;
const scoredTribeA = {
  player: tribeA,
  tribeClusterAccess: 1,
  tribeClusterSize: 1,
};
plannerCacheBehavior.getEarlyGameTribeCandidates = async () => {
  plannerCacheRefreshStarts++;
  return [scoredTribeA];
};
assert.equal((await plannerCacheBehavior.getReadyEarlyGameTribeCandidates()).length, 0);
await Promise.resolve();
assert.equal((await plannerCacheBehavior.getReadyEarlyGameTribeCandidates())[0], scoredTribeA);
assert.equal(plannerCacheRefreshStarts, 1);
livePlannerTribes = [tribeA, tribeB];
await plannerCacheBehavior.getReadyEarlyGameTribeCandidates();
assert.equal(
  plannerCacheRefreshStarts,
  2,
  "a changed live hostile-tribe signature invalidates the scored planner snapshot immediately",
);
await Promise.resolve();
plannerCacheTick += 41;
await plannerCacheBehavior.getReadyEarlyGameTribeCandidates();
assert.equal(
  plannerCacheRefreshStarts,
  3,
  "the scored planner snapshot refreshes after the bounded risk window expires",
);

// A cached topology snapshot can outlive a tribe that another player captured.
// It must disappear immediately from both the attack candidates and the visual
// opening state while the replacement snapshot is prepared.
const staleCandidateBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
staleCandidateBehavior.getEarlyGameTribeCandidates = () => new Promise(() => {});
staleCandidateBehavior.earlyGameTribeCandidatesCache = [
  {
    player: {
      isAlive: () => false,
      type: () => sandbox.PlayerType.Bot,
      smallID: () => 44,
    },
    tribeClusterSize: 5,
    tribeClusterAccess: 1,
  },
];
sandbox.state.earlyGame = {
  active: true,
  hasFreeLand: false,
  hasTribeTarget: true,
  actionableTribes: [{ id: 44 }],
  tribeTarget: { id: 44 },
};
assert.deepEqual(
  await staleCandidateBehavior.getReadyEarlyGameTribeCandidates(),
  [],
  "a captured tribe is not reused from the stale scored snapshot",
);
assert.equal(
  sandbox.state.earlyGame.hasTribeTarget,
  false,
  "removing the last stale tribe clears the actionable opening target",
);
assert.equal(
  sandbox.state.earlyGame.tribeTarget,
  null,
  "the cluster overlay cannot keep pointing at a captured tribe",
);
assert.deepEqual(sandbox.state.earlyGame.actionableTribes, []);

// A completed empty scan must not delay a newly reachable tribe until an
// artificial retry window expires. In-flight planner work still coalesces.
const emptyCandidateBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
let emptyRefreshStarts = 0;
let resolveEmptyRefresh;
emptyCandidateBehavior.getEarlyGameTribeCandidates = () => {
  emptyRefreshStarts++;
  return new Promise((resolve) => {
    resolveEmptyRefresh = resolve;
  });
};
tick = 100;
sandbox.state.earlyGame = { hasTribeTarget: false };
assert.equal(
  (await emptyCandidateBehavior.getReadyEarlyGameTribeCandidates()).length,
  0,
  "the first empty planner refresh remains asynchronous",
);
resolveEmptyRefresh([]);
await Promise.resolve();
tick = 101;
assert.equal(
  (await emptyCandidateBehavior.getReadyEarlyGameTribeCandidates()).length,
  0,
  "an empty result immediately starts the next planner refresh",
);
assert.equal(
  emptyRefreshStarts,
  2,
  "an empty planner result cannot impose an artificial retry delay",
);
sandbox.state.earlyGame = { hasTribeTarget: true };
assert.equal(
  (await emptyCandidateBehavior.getReadyEarlyGameTribeCandidates()).length,
  0,
  "an in-flight refresh remains coalesced when a tribe becomes actionable",
);
assert.equal(
  emptyCandidateBehavior.earlyGameTribeRefreshStartCount,
  2,
  "planner telemetry counts each launched refresh independently",
);
resolveEmptyRefresh([target]);
await Promise.resolve();
sandbox.state.earlyGame = {};

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
  behavior.getPendingTerraNulliusAttackTroops(),
  0,
  "a pending player attack does not block the TerraNullius opening lane",
);
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
tick += sandbox.BOT_OUTBOUND_INTENT_GRACE_TICKS;
assert.equal(
  behavior.getPendingOutboundDonationTroops(),
  0,
  "a donation reservation expires on the exact grace boundary",
);
tick -= sandbox.BOT_OUTBOUND_INTENT_GRACE_TICKS;
behavior.recordOutboundDonationIntent(10000);

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

// The decision context already owns the exact nearby() snapshot used to rank
// border targets. Reuse it through the later ordinary/fallback policies rather
// than reconstructing the same neighbourhood several times in one tick.
const decisionNearby = [{ id: "decision-nearby" }];
let structureScanNearby = null;
let strategyNearby = null;
lowRatioBehavior.hasNeighboringBotWithStructures = (nearby) => {
  structureScanNearby = nearby;
  return false;
};
lowRatioBehavior.getAttackStrategies = (_friends, _enemies, nearby) => {
  strategyNearby = nearby;
  return [async () => false];
};
await lowRatioBehavior.attackBestTarget([], [{}], decisionNearby);
assert.equal(
  structureScanNearby,
  decisionNearby,
  "ordinary attack policies reuse the decision nearby snapshot for structure checks",
);
assert.equal(
  strategyNearby,
  decisionNearby,
  "ordinary strategies reuse the decision nearby snapshot for tribe/boat targeting",
);

const fallbackBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
fallbackBehavior.isBorderingNukedTerritory = () => false;
let fallbackNearby = null;
fallbackBehavior.attackBots = async (nearby) => {
  fallbackNearby = nearby;
  return false;
};
await fallbackBehavior.tryAttackFallbacks({
  expandOn: true,
  hasAccessibleFreeLand: true,
  hasNonNukedTerraNullius: false,
  borderingEnemies: [
    {
      isPlayer: () => true,
      type: () => sandbox.PlayerType.Bot,
    },
  ],
  nearby: decisionNearby,
});
assert.equal(
  fallbackNearby,
  decisionNearby,
  "fallback tribe attacks reuse the decision nearby snapshot",
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
const clanMate = {
  smallID: () => 2,
  clanTag: () => "ESP",
};
const outsider = {
  smallID: () => 3,
  clanTag: () => "ABC",
};
const clanMe = {
  ...me,
  clanTag: () => "esp",
};
const clanNuke = {
  id: () => "clan-crater-nuke",
  type: () => UNIT.AtomBomb,
  targetTile: () => 101,
};
const clanNukeGame = {
  ticks: () => tick,
  width: () => 4,
  height: () => 4,
  x: (tile) => Number(tile) % 100,
  y: (tile) => Math.floor(Number(tile) / 100),
  ref: (x, y) => y * 100 + x,
  isValidCoord: (x, y) => x >= 0 && x < 4 && y >= 0 && y < 4,
  players: () => [clanMe, clanMate, outsider],
  units: () => [clanNuke],
  ownerID: (tile) => {
    if (tile === 102) return 2;
    if (tile === 201) return 3;
    return null;
  },
  neighbors: () => [201],
  isLand: () => true,
  hasOwner: () => false,
  hasFallout: (tile) => tile === 102 || tile === 201,
  magnitude: () => 8,
  config: () => ({
    maxTroops: () => 100000,
    nukeMagnitudes: () => ({ outer: 2 }),
    attackLogic: () => ({ attackerTroopLoss: 2 }),
  }),
};
const clanNukeBehavior = new sandbox.AttackBehavior(
  {},
  clanNukeGame,
  clanMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
clanNukeBehavior.getEnemyDefensePostAttackProfile = () => ({});
clanNukeBehavior.attackIsTooWeakForDefensePosts = () => false;
clanNukeBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
clanNukeBehavior.captureSameClanNukeTerrain();
assert.equal(
  clanNukeBehavior.terraNulliusTileIsEligible(102, true),
  false,
  "fallout that belonged to a same-clan player is excluded from expansion",
);
assert.equal(
  clanNukeBehavior.terraNulliusTileIsEligible(201, true),
  false,
  "a mixed crater is quarantined because expansion can cross into clan terrain",
);
const protectedClanEmissionCount = troopEmissions.length;
assert.equal(
  clanNukeBehavior.sendLandAttack(terraNullius),
  false,
  "a generic TerraNullius attack is withheld even when protected clan fallout is not yet on the frontier",
);
assert.equal(troopEmissions.length, protectedClanEmissionCount);
assert.equal(
  clanNukeBehavior.emitBoat(102, 1000, "protected clan crater"),
  false,
  "boats cannot land on protected same-clan fallout",
);
assert.equal(troopEmissions.length, protectedClanEmissionCount);
outgoing.push({
  id: () => "active-terra-nullius-attack",
  target: () => terraNullius,
  retreating: () => false,
});
clanNukeBehavior.enforceSameClanNukeTerrainSafety();
assert.deepEqual(
  cancelledAttackIds,
  ["active-terra-nullius-attack"],
  "an already-active TerraNullius attack is cancelled before it can enter protected clan fallout",
);
outgoing.length = 0;

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
const hostileStrategicBorder = {
  smallID: () => 8,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Nation,
  troops: () => 70000,
};
const hostileTribeBorder = {
  smallID: () => 9,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Bot,
  troops: () => 90000,
};
const strategicBorderMe = {
  ...me,
  isFriendly: () => false,
};
const strategicBorderGame = {
  ticks: () => tick,
  neighbors: () => [2, 3],
  isLand: () => true,
  hasOwner: () => true,
  ownerID: (tile) => (tile === 2 ? 8 : 9),
  players: () => [strategicBorderMe, hostileStrategicBorder, hostileTribeBorder],
  config: () => ({ maxTroops: () => 100000 }),
};
const strategicBorderBehavior = new sandbox.AttackBehavior(
  {},
  strategicBorderGame,
  strategicBorderMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
ownTroops = 100000;
assert.equal(
  strategicBorderBehavior.getStrongestStrategicBorderOpponentTroops(),
  70000,
  "only a bordering Nation/Human raises the proactive strategic defense reserve",
);
assert.equal(
  strategicBorderBehavior.getEarlyGameTargetReserveTroops({
    isPlayer: () => true,
    type: () => sandbox.PlayerType.Bot,
  }),
  35000,
  "tribe captures hold the fractioned border-Nation share, never the full force",
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
  ownTroops * 0.6,
  "TerraNullius retains the configured 60% opening safety reserve",
);
assert.equal(
  expandingBehavior.getTerraNulliusAvailableTroops(ownTroops, true),
  ownTroops * 0.4,
  "a radioactive/free-land caller cannot replace the TerraNullius reserve with a full-army budget",
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
  expandingBehavior.hasRecentTerraNulliusAttackIntent(),
  true,
  "the opening ledger bridges the intent-to-visible-attack snapshot gap",
);
tick += sandbox.BOT_OUTBOUND_INTENT_GRACE_TICKS;
assert.equal(
  expandingBehavior.hasRecentTerraNulliusAttackIntent(),
  false,
  "the recent free-land marker expires on the exact grace boundary",
);
tick -= sandbox.BOT_OUTBOUND_INTENT_GRACE_TICKS;
assert.equal(
  troopEmissions.at(-1),
  2500,
  "direct TerraNullius expansion sends the adaptive 10% opening payload",
);
const getTerraNulliusOpeningCommitLimit =
  expandingBehavior.getTerraNulliusOpeningCommitLimit.bind(expandingBehavior);
expandingBehavior.getTerraNulliusOpeningCommitLimit = () => 10000;
const finalOpeningTail = expandingBehavior.getTerraNulliusFollowUpBudget(1222.7, 120, null);
assert.equal(
  finalOpeningTail?.available,
  1222.7,
  "a finite opening remainder above the exact tile cost remains actionable",
);
assert.equal(
  finalOpeningTail?.livenessFollowUp,
  false,
  "the final opening tail stays inside the aggregate opening allowance",
);
assert.equal(
  expandingBehavior.getTerraNulliusFollowUpBudget(119, 120, null),
  0,
  "an opening remainder below the exact tile cost cannot emit an invalid attack",
);
const openingActionabilityBehavior = Object.create(sandbox.AttackBehavior.prototype);
openingActionabilityBehavior.getRemainingTerraNulliusOpeningCommitment = () => 119;
openingActionabilityBehavior.getTerraNulliusMinimumTroops = () => 120;
openingActionabilityBehavior.getTerraNulliusAvailableTroops = () => 119;
assert.equal(
  openingActionabilityBehavior.getActionableRemainingTerraNulliusOpeningCommitment(),
  0,
  "a positive remainder below the exact tile cost is not actionable opening budget",
);
openingActionabilityBehavior.getRemainingTerraNulliusOpeningCommitment = () => 1222.7;
openingActionabilityBehavior.getTerraNulliusAvailableTroops = () => 1222.7;
assert.equal(
  openingActionabilityBehavior.getActionableRemainingTerraNulliusOpeningCommitment(),
  1222.7,
  "a reserve-safe final tail remains actionable opening budget",
);
openingActionabilityBehavior.getTerraNulliusAvailableTroops = () => 100;
assert.equal(
  openingActionabilityBehavior.getActionableRemainingTerraNulliusOpeningCommitment(),
  0,
  "a temporarily reserve-blocked remainder yields to the full planner",
);
expandingBehavior.getTerraNulliusOpeningCommitLimit = getTerraNulliusOpeningCommitLimit;

expandingBehavior.botAttackPendingIntentCommitments = [];
ownTroops = 10000;
assert.equal(
  expandingBehavior.getTerraNulliusAttackTroops(terraNullius),
  1000,
  "after an army drawdown the liveness lane keeps its 10% slice instead of freezing forever (the clamped high-water floor caps at 90% of the live army)",
);
expandingBehavior.terraNulliusSafetyTroopHighWater = ownTroops * 10;
assert.equal(
  expandingBehavior.getTerraNulliusAttackTroops(terraNullius),
  1000,
  "even a pathological all-time peak cannot push the reserve floor past the live army's liveness slice",
);
ownTroops = 25000;
expandingBehavior.terraNulliusOpeningCommittedTroops = ownTroops * 0.4;
expandingBehavior.getLiveTerraNulliusAttackTroops = () => 2500;
assert.equal(
  expandingBehavior.getTerraNulliusAttackTroops(terraNullius),
  0,
  "an exhausted opening allowance cannot reopen through liveness during the opening window",
);
const continuedTerraNulliusEmissionCount = troopEmissions.length;
assert.equal(
  expandingBehavior.sendLandAttack(terraNullius),
  false,
  "the live land emitter keeps the aggregate opening cap authoritative",
);
assert.equal(troopEmissions.length, continuedTerraNulliusEmissionCount);
tick = 510;
assert.equal(
  expandingBehavior.getTerraNulliusAttackTroops(terraNullius),
  2500,
  "after the bounded opening window, TerraNullius resumes with the safe 10% adaptive payload",
);
tick = 9;

const repeatedExpansionBehavior = new sandbox.AttackBehavior(
  {},
  expandingGame,
  me,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
repeatedExpansionBehavior.getEnemyDefensePostAttackProfile = () => ({});
repeatedExpansionBehavior.attackIsTooWeakForDefensePosts = () => false;
repeatedExpansionBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
const repeatedExpansionEmissionCount = troopEmissions.length;
assert.equal(
  repeatedExpansionBehavior.sendLandAttack(terraNullius),
  true,
  "the first adaptive TerraNullius intent is emitted",
);
assert.equal(
  await repeatedExpansionBehavior.sendAttack(terraNullius),
  true,
  "the opening burst may emit another reserve-bounded TerraNullius command before the first troop debit is visible",
);
tick += 7;
assert.equal(
  await repeatedExpansionBehavior.sendAttack(terraNullius),
  true,
  "pending commands do not double-count against the remaining reserve-bounded opening allowance",
);
assert.equal(
  troopEmissions.length,
  repeatedExpansionEmissionCount + 3,
  "the reserve-bounded opening burst can commit a third frontier capture",
);
tick -= 7;

const unresolvedExpansionBehavior = new sandbox.AttackBehavior(
  {},
  expandingGame,
  me,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
unresolvedExpansionBehavior.getEnemyDefensePostAttackProfile = () => ({});
unresolvedExpansionBehavior.attackIsTooWeakForDefensePosts = () => false;
unresolvedExpansionBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
ownTroops = 25000;
const unresolvedExpansionEmissionCount = troopEmissions.length;
for (let attempt = 0; attempt < 12; attempt += 1) {
  await unresolvedExpansionBehavior.sendAttack(terraNullius);
  tick += 7;
}
const unresolvedExpansionTroops = troopEmissions
  .slice(unresolvedExpansionEmissionCount)
  .reduce((total, troops) => total + troops, 0);
assert.ok(
  unresolvedExpansionTroops <= 10000,
  `unconfirmed TerraNullius intents remain reserved, so repeated decisions cannot spend beyond the 40% opening budget (emitted ${unresolvedExpansionTroops})`,
);
assert.ok(
  unresolvedExpansionTroops >= 5000,
  "the opening burst can reserve multiple 10% frontier captures without crossing its aggregate cap",
);
tick -= 84;

const radioactiveExpansionBehavior = new sandbox.AttackBehavior(
  {},
  { ...expandingGame, hasFallout: () => true },
  me,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
radioactiveExpansionBehavior.getEnemyDefensePostAttackProfile = () => ({});
radioactiveExpansionBehavior.attackIsTooWeakForDefensePosts = () => false;
radioactiveExpansionBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
const radioactiveExpansionEmissionCount = troopEmissions.length;
for (let attempt = 0; attempt < 12; attempt += 1) {
  radioactiveExpansionBehavior.sendLandAttack(terraNullius, {
    radioactiveTerraNullius: true,
  });
  tick += 7;
}
const radioactiveExpansionTroops = troopEmissions
  .slice(radioactiveExpansionEmissionCount)
  .reduce((total, troops) => total + troops, 0);
assert.ok(
  radioactiveExpansionTroops <= 2500,
  `radioactive TerraNullius cannot bypass the 10% opening cap (emitted ${radioactiveExpansionTroops})`,
);
tick -= 84;

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
  false,
  "a pending tribe intent cannot reopen an exhausted aggregate TerraNullius opening budget",
);
assert.equal(troopEmissions.length, pendingTribeTerraNulliusEmissionCount);
expandingBehavior.botAttackPendingIntentCommitments = [];

ownTroops = 10000;
assert.ok(
  expandingBehavior.getEarlyGameTerraNulliusReserveTroops() >= ownTroops,
  "TerraNullius keeps the protected opening reserve after the army shrinks",
);
const drainedExpansionEmissionCount = troopEmissions.length;
assert.equal(
  expandingBehavior.sendLandAttack(terraNullius),
  false,
  "chained TerraNullius expansion cannot bypass the protected opening reserve",
);
assert.equal(troopEmissions.length, drainedExpansionEmissionCount);
ownTroops = 25000;

const openingBehavior = new sandbox.AttackBehavior({}, expandingGame, me, 0.5, 0.3, 0.1, {}, {});
const openingEmissionCount = troopEmissions.length;
assert.equal(
  await openingBehavior.forceSendAttack(terraNullius),
  true,
  "the first TerraNullius opening burst is not blocked by the capacity-derived reserve",
);
assert.equal(troopEmissions.length, openingEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  2500,
  "faithful tiers keep the 10% opening payload; only the adaptive tier scales it",
);

const openingHardCapBehavior = new sandbox.AttackBehavior(
  {},
  expandingGame,
  me,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
openingHardCapBehavior.getTerraNulliusAttackTroops = () => ownTroops;
const openingHardCapEmissionCount = troopEmissions.length;
assert.equal(
  await openingHardCapBehavior.forceSendAttack(terraNullius, 0.1),
  true,
  "the opening emitter remains available when its terrain calculator is aggressive",
);
assert.equal(troopEmissions.length, openingHardCapEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  ownTroops * 0.1,
  "the opening emitter hard-caps a malformed 100% TerraNullius payload at the protected budget",
);

const nationAttackFloorBehavior = Object.create(sandbox.AttackBehavior.prototype);
nationAttackFloorBehavior.player = { troops: () => 100_000 };
nationAttackFloorBehavior.getLiveOutboundAttackTroopsForTarget = () => 0;
const nationAttackFloorTarget = {
  isPlayer: () => true,
  troops: () => 40_000,
};
const nationAttackFloorContext = {
  target: nationAttackFloorTarget,
  isTribeTarget: false,
  isTerraNullius: false,
  targetTroops: 20_000,
  targetSpendableTroops: 70_000,
  defenseProfile: { attackCostMultiplier: 1 },
  force: false,
  attackBlocked: false,
};
assert.equal(
  nationAttackFloorBehavior.calculateRegularLandAttackTroops(nationAttackFloorContext),
  0,
  "a normal Nation attack below its 2x capture floor emits no retaliatory probe",
);
assert.equal(nationAttackFloorContext.attackBlocked, true);
nationAttackFloorContext.targetSpendableTroops = 80_000;
nationAttackFloorContext.attackBlocked = false;
assert.equal(
  nationAttackFloorBehavior.calculateRegularLandAttackTroops(nationAttackFloorContext),
  80_000,
  "an affordable Nation opening commits exactly the 2x capture floor",
);
nationAttackFloorContext.force = true;
nationAttackFloorContext.targetSpendableTroops = 1;
nationAttackFloorContext.finalSpendableTroops = 70_000;
nationAttackFloorContext.incomingCounterattackTroops = 30_000;
assert.equal(
  nationAttackFloorBehavior.calculateLandAttackTroops(nationAttackFloorContext),
  30_000,
  "a forced defensive counterattack is capped to the matching incoming force",
);

const incomingNation = { type: () => "Nation", smallID: () => 8 };
const openingDefenseBehavior = Object.create(sandbox.AttackBehavior.prototype);
openingDefenseBehavior.reconcileOutboundAttackIntentCommitments = () => {};
openingDefenseBehavior.findIncomingAttackPlayer = () => incomingNation;
openingDefenseBehavior.canFundIncomingCounterattack = () => true;
openingDefenseBehavior.hasOverwhelmingIncomingAttack = () => true;
let openingDefenseTarget = null;
openingDefenseBehavior.sendAttack = async (candidate, force) => {
  openingDefenseTarget = { candidate, force };
  return true;
};
openingDefenseBehavior.reinforceIncompleteOutboundPlayerAttack = async () => {
  throw new Error("an overwhelming opening defense must precede conquest reinforcement");
};
openingDefenseBehavior.hasLandBorderWithTerraNullius = () => {
  throw new Error("an overwhelming opening defense must precede TerraNullius expansion");
};
assert.equal(
  await openingDefenseBehavior.continueOpeningExpansion(),
  false,
  "an overwhelming incoming attack terminates the opening expansion fast lane",
);
assert.equal(
  openingDefenseTarget,
  null,
  "an overwhelming siege holds every troop instead of mirroring the wave",
);

// A mirrorable peer siege is answered first, then the bounded growth lanes
// keep running: freezing every expansion behind a winnable defense is how a
// boxed-in bot donates the map on its other borders.
openingDefenseBehavior.hasOverwhelmingIncomingAttack = () => false;
let peerSiegeReinforcements = 0;
openingDefenseBehavior.reinforceIncompleteOutboundPlayerAttack = async () => {
  peerSiegeReinforcements += 1;
  return true;
};
openingDefenseBehavior.hasLandBorderWithTerraNullius = () => false;
openingDefenseBehavior.forceSendAttack = () => false;
assert.equal(
  await openingDefenseBehavior.continueOpeningExpansion(),
  true,
  "a mirrorable peer siege still runs its bounded conquest lanes after the defense response",
);
assert.equal(peerSiegeReinforcements, 1);
openingDefenseBehavior.sendAttack = async () => false;
openingDefenseBehavior.reinforceIncompleteOutboundPlayerAttack = async () => false;
assert.equal(
  await openingDefenseBehavior.continueOpeningExpansion(),
  false,
  "failed defense with no expansion frontier still spends nothing offensive",
);

const incomingTribe = { type: () => "Bot", smallID: () => 9 };
const incomingTribeBehavior = Object.create(sandbox.AttackBehavior.prototype);
incomingTribeBehavior.player = {
  smallID: () => 10,
  type: () => "Human",
  isFriendly: () => false,
  incomingAttacks: () => [
    {
      attacker: () => incomingTribe,
      target: () => incomingTribeBehavior.player,
      troops: () => 4000,
    },
  ],
};
assert.equal(
  incomingTribeBehavior.findIncomingAttackPlayer(),
  incomingTribe,
  "win-fix defense includes incoming tribe attacks against controlled Humans/Nations",
);

const coordinatedAttacker = {
  isPlayer: () => true,
  smallID: () => 72,
};
const singleWaveAttacker = {
  isPlayer: () => true,
  smallID: () => 73,
};
const coordinatedDefenseBehavior = Object.create(sandbox.AttackBehavior.prototype);
coordinatedDefenseBehavior.player = { type: () => sandbox.PlayerType.Human };
coordinatedDefenseBehavior.incomingHostileAttacks = () => [
  { attacker: () => coordinatedAttacker, troops: () => 60_000 },
  { attacker: () => singleWaveAttacker, troops: () => 100_000 },
  { attacker: () => coordinatedAttacker, troops: () => 60_000 },
];
assert.strictEqual(
  coordinatedDefenseBehavior.findIncomingAttackPlayer(),
  coordinatedAttacker,
  "defense counters the largest aggregate attacker instead of the largest individual wave",
);

const decisionDefenseBehavior = Object.create(sandbox.AttackBehavior.prototype);
decisionDefenseBehavior.player = {};
decisionDefenseBehavior.allianceBehavior = {};
decisionDefenseBehavior.reconcileOutboundAttackIntentCommitments = () => {};
decisionDefenseBehavior.createAttackDecisionContext = () => ({ expandOn: false });
decisionDefenseBehavior.findIncomingAttackPlayer = () => incomingNation;
decisionDefenseBehavior.canFundIncomingCounterattack = () => false;
decisionDefenseBehavior.hasOverwhelmingIncomingAttack = () => true;
decisionDefenseBehavior.sendAttack = async () => false;
decisionDefenseBehavior.tryImmediateAttackPriorities = async () => {
  throw new Error("failed defense under an overwhelming siege must block offensive priorities");
};
await decisionDefenseBehavior.maybeAttack();
assert.equal(sandbox.state.earlyGame.action, "defense-hold");

const donationAfterPriorityBehavior = Object.create(sandbox.AttackBehavior.prototype);
let donationPolicyRuns = 0;
const donationPriorityOrder = [];
donationAfterPriorityBehavior.player = {};
donationAfterPriorityBehavior.allianceBehavior = {};
donationAfterPriorityBehavior.reconcileOutboundAttackIntentCommitments = () => {};
donationAfterPriorityBehavior.createAttackDecisionContext = () => ({ expandOn: true });
donationAfterPriorityBehavior.updateExpansionBreakoutState = () => {};
donationAfterPriorityBehavior.respondToIncomingAttack = async () => null;
donationAfterPriorityBehavior.tryImmediateAttackPriorities = async () => {
  donationPriorityOrder.push("attack");
  return true;
};
donationAfterPriorityBehavior.tryEarlyAttackPolicies = async () => false;
donationAfterPriorityBehavior.runDonationPolicy = () => {
  donationPolicyRuns++;
  donationPriorityOrder.push("donate");
};
await donationAfterPriorityBehavior.maybeAttack();
assert.equal(
  donationPolicyRuns,
  1,
  "a priority attack does not skip the independent Auto-Bot donation evaluation",
);
assert.deepEqual(
  donationPriorityOrder,
  ["donate", "attack"],
  "a safe donation reserves an intent before aggressive expansion can exhaust the shared budget",
);

const counterattackBudgetBehavior = Object.create(sandbox.AttackBehavior.prototype);
counterattackBudgetBehavior.incomingHostileAttacks = () => [
  { attacker: () => incomingNation, troops: () => 80_000 },
  { attacker: () => incomingNation, troops: () => 40_000 },
];
counterattackBudgetBehavior.getIncomingCounterattackReserveTroops = () => 0;
counterattackBudgetBehavior.getEarlyGameSpendableTroops = () => 119_999;
assert.equal(
  counterattackBudgetBehavior.canFundIncomingCounterattack(incomingNation),
  true,
  "a safe partial counterattack interdicts the same portion of the attacker’s in-flight force",
);
counterattackBudgetBehavior.getEarlyGameSpendableTroops = () => 120_000;
assert.equal(
  counterattackBudgetBehavior.canFundIncomingCounterattack(incomingNation),
  true,
  "a full safe counterattack remains eligible against the attacker’s in-flight force",
);

const thirdPartyReserveBehavior = Object.create(sandbox.AttackBehavior.prototype);
thirdPartyReserveBehavior.getEarlyGameProductionReserveTroops = () => 82_863;
thirdPartyReserveBehavior.getStrongestStrategicBorderOpponentTroopsExcluding = () => 938_816;
thirdPartyReserveBehavior.incomingHostileTroopsFrom = () => 120_000;
thirdPartyReserveBehavior.getEarlyGameSpendableTroops = (reserve) => Math.max(0, 487_420 - reserve);
assert.equal(
  thirdPartyReserveBehavior.getEarlyGameTargetReserveTroops(incomingNation),
  938_816,
  "ordinary offense still respects the strongest OTHER strategic border opponent",
);
assert.equal(
  thirdPartyReserveBehavior.canFundIncomingCounterattack(incomingNation),
  true,
  "an unrelated stronger neighbour cannot suppress a safe partial interdiction",
);

const tribeInterdictionContext = {
  force: true,
  isTribeTarget: true,
  finalSpendableTroops: 45_000,
  incomingCounterattackTroops: 70_000,
};
assert.equal(
  thirdPartyReserveBehavior.calculateLandAttackTroops(tribeInterdictionContext),
  45_000,
  "tribe retaliation uses the same safe-surplus cap instead of a conquest payload",
);

const expensiveTileBehavior = new sandbox.AttackBehavior(
  {},
  expandingGame,
  me,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
expensiveTileBehavior.getTerraNulliusMinimumTroops = () => 600;
assert.equal(
  expensiveTileBehavior.getTerraNulliusAttackTroops(
    terraNullius,
    null,
    null,
    sandbox.EARLY_EXPAND_COMMIT,
  ),
  2500,
  "an expensive opening tile preserves the 10% minimum liveness allowance",
);

const scheduledBehavior = new sandbox.AttackBehavior({}, expandingGame, me, 0.5, 0.3, 0.1, {}, {});
ownTroops = 25000;
tick = 20;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 10000);
tick = 120;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 10000);
tick = 320;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 10000);
tick = 520;
assert.equal(scheduledBehavior.getTerraNulliusOpeningCommitLimit(), 10000);
// A snowballing opening re-bases the snapshot: when the field army grows past
// the EARLY_EXPAND_OPENING_REBASE_RATIO threshold, the cumulative ceiling
// tracks the new larger army instead of throttling to the spawn-time value.
// Below the threshold the cap is unchanged.
ownTroops = 30000;
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  10000,
  "army growth below the rebase ratio keeps the original opening cap",
);
ownTroops = 32000;
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  32000 * sandbox.EARLY_EXPAND_OPENING_LIMIT,
  "army growth past the rebase ratio lifts the opening cap with the snowball",
);
// Drop back near the rebased snapshot: no churn from noise-scale changes.
ownTroops = 32100;
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  32000 * sandbox.EARLY_EXPAND_OPENING_LIMIT,
  "small army changes after a rebase do not churn the cap",
);
// Restore the original army for the subsequent completed-wave assertions.
ownTroops = 25000;
tick = 20;
scheduledBehavior.terraNulliusOpeningCommittedTroops = 8777;
scheduledBehavior.getPendingTerraNulliusAttackTroops = () => 0;
scheduledBehavior.getLiveTerraNulliusAttackTroops = () => 0;
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  Number.POSITIVE_INFINITY,
  "a completed opening wave immediately unlocks the opening liveness reserve",
);
ownTroops = 74364;
scheduledBehavior.getEarlyGameLiveReserveTroops = () => 18047;
scheduledBehavior.getEarlyGameProductionReserveTroops = () => 73900;
scheduledBehavior.getKnownBorderOpponentTroops = () => 0;
scheduledBehavior.getStrongestStrategicBorderOpponentTroops = () => 0;
assert.equal(
  scheduledBehavior.getEarlyGameTerraNulliusReserveTroops(),
  18047,
  "the cleared opening wave uses the live reserve instead of waiting for future troop capacity",
);
assert.equal(
  scheduledBehavior.getTerraNulliusAttackTroops(terraNullius),
  7437,
  "the opening liveness window can immediately emit another 10% free-land capture",
);
scheduledBehavior.getLiveTerraNulliusAttackTroops = () => 1200;
// The opening cap rebases when the field army snowballs (a 25% growth
// triggers a rebase to the new army size), so a much larger army lifts the
// cumulative ceiling instead of throttling expansion to the spawn-time
// snapshot. The cap stays finite and authoritative — it just grows with the
// army. 74364 troops rebased the snapshot, so the cap is 74364 * 0.4.
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  74364 * sandbox.EARLY_EXPAND_OPENING_LIMIT,
  "a visible opening attack keeps the aggregate opening cap authoritative",
);
tick = 521;
assert.equal(
  scheduledBehavior.getTerraNulliusOpeningCommitLimit(),
  Number.POSITIVE_INFINITY,
  "after opening tick 500, the adaptive production/threat reserve takes over",
);
assert.equal(
  scheduledBehavior.getEarlyGameTerraNulliusReserveTroops(),
  73900,
  "after the bounded opening window TerraNullius returns to the production reserve",
);
ownTroops = 25000;
tick = 9;

// emitBoat is the final synchronous boundary after the route/launch await. It
// must reapply the same target-specific reserve instead of falling back to the
// lower acceleration reserve when the troop snapshot changed during the await.
const boatBudgetBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
const breakoutBehavior = Object.create(sandbox.AttackBehavior.prototype);
breakoutBehavior.earlyGameTribeCandidatesCache = [];
breakoutBehavior.getEarlyGameOwnShores = () => [1];
breakoutBehavior.player = {
  troops: () => 800000,
  isFriendly: () => false,
  borderTiles: () => new Set([1]),
  shoreBorderTiles: () => [1],
};
breakoutBehavior.getEarlyGameSpendableTroops = () => 300000;
breakoutBehavior.getEarlyGameTargetReserveTroops = () => 400000;
sandbox.state.earlyGame = {
  active: true,
  postSpawn: true,
  hasFreeLand: false,
  actionableTribes: [],
};
assert.equal(
  breakoutBehavior.updateExpansionBreakoutState({ borderingEnemies: [] }),
  false,
  "one empty planner decision does not mistake a refresh handoff for encirclement",
);
assert.equal(
  breakoutBehavior.updateExpansionBreakoutState({ borderingEnemies: [] }),
  true,
  "two completed empty planner decisions activate maritime breakout",
);
const falseBreakoutBehavior = Object.create(sandbox.AttackBehavior.prototype);
falseBreakoutBehavior.earlyGameTribeCandidatesCache = [];
falseBreakoutBehavior.getEarlyGameOwnShores = () => [];
falseBreakoutBehavior.player = {
  borderTiles: () => new Set([1]),
};
sandbox.state.earlyGame = {
  active: false,
  postSpawn: true,
  hasFreeLand: false,
  actionableTribes: [],
  openingElapsedTicks: 31,
};
assert.equal(
  falseBreakoutBehavior.updateExpansionBreakoutState({ borderingEnemies: [{}] }),
  false,
  "a land-border enemy without a coast is not a maritime breakout",
);
assert.equal(
  falseBreakoutBehavior.updateExpansionBreakoutState({ borderingEnemies: [{}] }),
  false,
  "a false breakout cannot become a permanent donation veto",
);
const expiredBreakoutBehavior = Object.create(sandbox.AttackBehavior.prototype);
expiredBreakoutBehavior.earlyGameTribeCandidatesCache = [];
expiredBreakoutBehavior.getEarlyGameOwnShores = () => [1];
expiredBreakoutBehavior.player = {
  borderTiles: () => new Set([1]),
  shoreBorderTiles: () => [1],
};
sandbox.state.earlyGame = {
  active: false,
  postSpawn: true,
  hasFreeLand: false,
  actionableTribes: [],
  openingElapsedTicks: 301,
};
assert.equal(
  expiredBreakoutBehavior.updateExpansionBreakoutState({ borderingEnemies: [] }),
  false,
  "the maritime breakout reserve expires with the opening phase",
);
assert.equal(
  expiredBreakoutBehavior.updateExpansionBreakoutState({ borderingEnemies: [] }),
  false,
  "an expired breakout cannot become a permanent donation veto",
);
breakoutBehavior.expansionBreakoutActive = true;
breakoutBehavior.getEarlyGameSpendableTroops = (reserve) => (reserve === 150000 ? 650000 : 300000);
breakoutBehavior.getTerraNulliusLivenessReserveTroops = () => 150000;
assert.equal(
  breakoutBehavior.getLandAttackSpendableTroops({ isPlayer: () => true }, 500000, false),
  650000,
  "a landed breakout may spend surplus down to the live reserve",
);
sandbox.state.earlyGame = {};
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
const boatEmissionCount = troopEmissions.length;
assert.equal(
  boatBudgetBehavior.emitBoat("boat-destination", 1, "⛵ duplicate boat", humanTarget),
  false,
  "one decision never emits two transport ships to the same destination",
);
assert.equal(troopEmissions.length, boatEmissionCount);
tick += 1;
assert.equal(
  boatBudgetBehavior.emitBoat("boat-destination", 1, "⛵ pending boat", humanTarget),
  false,
  "a pending transport intent reserves its destination across game ticks",
);
transports = [
  {
    id: () => "transport-1",
    isActive: () => true,
    targetTile: () => "boat-destination",
    troops: () => 50000,
    transportShipState: () => ({ isRetreating: false }),
  },
];
tick += 1;
assert.equal(
  boatBudgetBehavior.emitBoat("boat-destination", 1, "⛵ in-flight boat", humanTarget),
  false,
  "a live transport keeps its exact destination reserved after intent reconciliation",
);
transports = [];
tick += 1;
assert.equal(
  boatBudgetBehavior.emitBoat("boat-destination", 1, "⛵ landed boat", humanTarget),
  true,
  "the destination becomes eligible after the transport is no longer active",
);
const failedBoatBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
tick = 30;
assert.equal(
  failedBoatBehavior.emitBoat("failed-destination", 1, "⛵ failed boat", humanTarget),
  true,
);
tick += sandbox.BOT_OUTBOUND_INTENT_GRACE_TICKS;
assert.equal(
  failedBoatBehavior.emitBoat("failed-destination", 1, "⛵ retried boat", humanTarget),
  true,
  "an intent that never creates a transport releases its destination on the grace boundary",
);
ownTroops = 100000;
const parallelBoatBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
assert.equal(parallelBoatBehavior.emitBoat("parallel-a", 1000, "⛵ parallel A"), true);
assert.equal(
  parallelBoatBehavior.emitBoat("parallel-b", 1000, "⛵ parallel B"),
  true,
  "a reserved destination does not block a parallel transport elsewhere",
);
const spatialBoatBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
tick = 50;
assert.equal(spatialBoatBehavior.emitBoat(1000, 10000, "⛵ priority conquest"), true);
assert.equal(
  spatialBoatBehavior.emitBoat(1002, 1000, "⛵ overlapping probe"),
  false,
  "the higher-priority transport reserves nearby tiles in the same beach opportunity",
);
assert.equal(
  spatialBoatBehavior.emitBoat(5000, 1000, "⛵ distant parallel boat"),
  true,
  "the configured spread radius still permits genuinely separate opportunities",
);
tick += 1;
assert.equal(
  spatialBoatBehavior.emitBoat(1005, 1000, "⛵ pending nearby probe"),
  false,
  "a pending transport reserves nearby tiles across game ticks",
);
transports = [
  {
    id: () => "transport-spatial",
    isActive: () => true,
    targetTile: () => 2000,
    troops: () => 1000,
    transportShipState: () => ({ isRetreating: false }),
  },
];
const liveSpatialBoatBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
assert.equal(
  liveSpatialBoatBehavior.emitBoat(2020, 1000, "⛵ nearby live boat"),
  false,
  "a live transport reserves the surrounding beach even when its target tile was adjusted",
);
transports = [];
tick += 1;
assert.equal(
  liveSpatialBoatBehavior.emitBoat(2020, 1000, "⛵ cleared nearby boat"),
  true,
  "a nearby opportunity becomes eligible immediately after the live transport clears",
);

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
ownTroops = 60000;
const tribeEmissionCount = troopEmissions.length;
assert.equal(tribeBehavior.sendLandAttack(tribeTarget), true);
assert.equal(
  troopEmissions.length,
  tribeEmissionCount + 1,
  "a sufficiently funded tribe assault is emitted",
);
assert.ok(
  troopEmissions.at(-1) >= Math.ceil(tribeTarget.troops() * 4),
  "a tribe assault meets the four-times whole-troop conquest floor",
);
assert.ok(
  ownTroops - troopEmissions.at(-1) >= tribeBehavior.getEarlyGameLiveReserveTroops(),
  "a completed tribe assault still respects the acceleration reserve",
);
assert.equal(
  tribeBehavior.getTribeCaptureTroopFloor(tribeTarget),
  40000,
  "a live tribe capture requires four times the current tribe strength",
);
assert.equal(
  tribeBehavior.getTribeCaptureTroopFloor(tribeTarget, {
    attackCostMultiplier: 1.5,
  }),
  60000,
  "the tribe floor includes the target-specific Defense Post attack cost",
);

const terrainHeavyTribe = {
  isPlayer: () => true,
  type: () => "Bot",
  id: () => "terrain-heavy-tribe",
  smallID: () => 4,
  troops: () => 100,
  numTilesOwned: () => 100,
};
const terrainCaptureBehavior = Object.create(sandbox.AttackBehavior.prototype);
terrainCaptureBehavior.player = me;
let terrainAttackLogicCalls = 0;
terrainCaptureBehavior.game = {
  config: () => ({
    attackLogic: () => {
      terrainAttackLogicCalls++;
      return { attackerTroopLoss: 25 };
    },
  }),
  ticks: () => 1,
};
terrainCaptureBehavior.getEnemyDefensePostFrontTiles = () => [101, 102];
assert.equal(
  terrainCaptureBehavior.getTribeCaptureTroopFloor(terrainHeavyTribe),
  2500,
  "a large terrain-expensive tribe is funded for per-tile engine losses",
);
assert.equal(terrainCaptureBehavior.getTribeCaptureTroopFloor(terrainHeavyTribe), 2500);
assert.equal(
  terrainAttackLogicCalls,
  2,
  "same-tick tribe floor checks reuse the bounded engine-loss scan",
);

const cachedTerritoryTribe = {
  isPlayer: () => true,
  type: () => sandbox.PlayerType.Bot,
  id: () => "cached-territory-tribe",
  smallID: () => 5,
  troops: () => 1,
  numTilesOwned: () => 4,
};
const cachedTerritoryBehavior = Object.create(sandbox.AttackBehavior.prototype);
cachedTerritoryBehavior.player = me;
let cachedTerritoryNeighborCalls = 0;
const cachedTerritoryAdjacency = new Map([
  [201, [202]],
  [202, [201, 203]],
  [203, [202, 204]],
  [204, [203]],
]);
cachedTerritoryBehavior.game = {
  config: () => ({
    attackLogic: () => ({ attackerTroopLoss: 25 }),
  }),
  ticks: () => 3,
  ownerID: (tile) => (cachedTerritoryAdjacency.has(tile) ? 5 : 0),
  neighbors: (tile) => {
    cachedTerritoryNeighborCalls++;
    return cachedTerritoryAdjacency.get(tile) ?? [];
  },
};
cachedTerritoryBehavior.getEnemyDefensePostFrontTiles = () => [201];
assert.equal(cachedTerritoryBehavior.getTribeCaptureTroopFloor(cachedTerritoryTribe), 100);
assert.equal(cachedTerritoryBehavior.getTribeCaptureTroopFloor(cachedTerritoryTribe), 100);
assert.equal(
  cachedTerritoryNeighborCalls,
  3,
  "same-tick tribe floor checks traverse the target territory only once",
);

const mixedTerrainCaptureBehavior = Object.create(sandbox.AttackBehavior.prototype);
mixedTerrainCaptureBehavior.player = me;
const mixedTribeAdjacency = new Map([
  [101, [102]],
  [102, [101]],
]);
mixedTerrainCaptureBehavior.game = {
  config: () => ({
    attackLogic: (_game, _troops, _attacker, _target, tile) => ({
      attackerTroopLoss: tile === 102 ? 25 : 1,
    }),
  }),
  ticks: () => 2,
  ownerID: (tile) => ([101, 102].includes(tile) ? 4 : 0),
  neighbors: (tile) => mixedTribeAdjacency.get(tile) ?? [],
};
mixedTerrainCaptureBehavior.getEnemyDefensePostFrontTiles = () => [101];
assert.equal(
  mixedTerrainCaptureBehavior.getTribeCaptureTroopFloor(terrainHeavyTribe),
  2500,
  "a cheap frontier cannot hide expensive terrain inside the same tribe",
);

const botControlledTribeBehavior = new sandbox.AttackBehavior(
  {},
  game,
  { ...me, type: () => sandbox.PlayerType.Bot },
  0.5,
  0.3,
  0.1,
  {},
  {},
);
botControlledTribeBehavior.getEnemyDefensePostAttackProfile = () => ({});
botControlledTribeBehavior.attackIsTooWeakForDefensePosts = () => false;
botControlledTribeBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
const botControlledEmissionCount = troopEmissions.length;
assert.equal(
  botControlledTribeBehavior.sendLandAttack(tribeTarget),
  true,
  "a Bot-controlled client still uses the tribe capture floor",
);
assert.equal(troopEmissions.length, botControlledEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  40000,
  "controller type cannot bypass the 4x tribe conquest floor",
);

const fractionalTribeTarget = {
  ...tribeTarget,
  troops: () => 10000.125,
};
assert.equal(
  tribeBehavior.getTribeCaptureTroopFloor(fractionalTribeTarget),
  40001,
  "a fractional 4x tribe requirement rounds up to the minimum whole-troop conquest force",
);

const underfundedTribeBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
underfundedTribeBehavior.getEnemyDefensePostAttackProfile = () => ({});
underfundedTribeBehavior.attackIsTooWeakForDefensePosts = () => false;
underfundedTribeBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
ownTroops = 50000;
underfundedTribeBehavior.recordOutboundAttackIntent(tribeTarget, 1000, {
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
assert.equal(troopEmissions.at(-1), 39000);
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
const scoredParallelCandidate = (player) => ({
  player,
  tribeClusterSize: 2,
  tribeClusterAccess: 1,
});
assert.equal(
  await parallelBehavior.sendAttack(
    parallelTribeA,
    false,
    null,
    scoredParallelCandidate(parallelTribeA),
    false,
    true,
  ),
  true,
);
assert.equal(
  await parallelBehavior.sendAttack(
    parallelTribeB,
    false,
    null,
    scoredParallelCandidate(parallelTribeB),
    false,
    true,
  ),
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
  8000,
  "parallel tribal intents reserve each tribe's fully funded conquest force",
);
assert.equal(
  parallelBehavior.getPendingTerraNulliusAttackTroops(),
  0,
  "parallel tribal intents stay independent from TerraNullius liveness",
);
assert.deepEqual(
  [...parallelBehavior.getActiveTribeAttackTargetKeys()].sort(),
  ["21", "22"],
  "active tribal targets are tracked independently",
);

const immuneHumanTarget = {
  ...tribeTarget,
  id: () => "immune-human-target",
  smallID: () => 60,
  type: () => sandbox.PlayerType.Human,
  troops: () => 1000,
};
const immunityChecks = [];
const immuneHumanBehavior = new sandbox.AttackBehavior(
  {},
  game,
  {
    ...parallelMe,
    canAttackPlayer: (target, treatAFKFriendly) => {
      immunityChecks.push({ target, treatAFKFriendly });
      return false;
    },
  },
  0.5,
  0.3,
  0.1,
  {},
  {},
);
immuneHumanBehavior.getEnemyDefensePostAttackProfile = () => ({});
immuneHumanBehavior.attackIsTooWeakForDefensePosts = () => false;
immuneHumanBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
outgoing.length = 0;
ownTroops = 100000;
tick = 35;
const immuneHumanEmissionCount = troopEmissions.length;
assert.equal(
  await immuneHumanBehavior.sendAttack(immuneHumanTarget, true),
  false,
  "even a forced attack is rejected while the engine reports human spawn immunity",
);
assert.deepEqual(immunityChecks, [{ target: immuneHumanTarget, treatAFKFriendly: false }]);
assert.equal(
  troopEmissions.length,
  immuneHumanEmissionCount,
  "a spawn-immune target consumes no troops or attack intent capacity",
);
assert.equal(immuneHumanBehavior.getPendingOutboundAttackTroops(), 0);

const targetScopedDebitBehavior = new sandbox.AttackBehavior(
  {},
  game,
  parallelMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
outgoing.length = 0;
ownTroops = 100000;
tick = 30;
targetScopedDebitBehavior.recordOutboundAttackIntent(parallelTribeA, 4000);
targetScopedDebitBehavior.recordOutboundAttackIntent(parallelTribeB, 6000);
outgoing.push({
  id: () => "materialized-tribe-b",
  retreating: () => false,
  target: () => parallelTribeB,
  troops: () => 6000,
});
ownTroops = 94000;
tick = 31;
assert.equal(
  targetScopedDebitBehavior.getPendingOutboundAttackTroops(),
  4000,
  "a troop debit materialized for one target cannot release another target's reservation",
);

// An accepted player attack can remain absent from outgoingAttacks during the
// local intent grace window. Its pending commitment must still identify the
// target so a later target-strength increase receives only the missing force.
let pendingPlayerTargetTroops = 1000;
const pendingPlayerTarget = {
  ...tribeTarget,
  id: () => "pending-player-target",
  smallID: () => 61,
  type: () => sandbox.PlayerType.Human,
  troops: () => pendingPlayerTargetTroops,
};
const pendingPlayerBehavior = new sandbox.AttackBehavior(
  {},
  game,
  parallelMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
pendingPlayerBehavior.getEnemyDefensePostAttackProfile = () => ({});
pendingPlayerBehavior.attackIsTooWeakForDefensePosts = () => false;
pendingPlayerBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
pendingPlayerBehavior.shouldAttack = () => true;
// This block verifies pending-intent bookkeeping, not war-appetite policy;
// take the dominance ceiling out of the arithmetic.
pendingPlayerBehavior.proactiveWarArmyCommitmentCap = () => null;
outgoing.length = 0;
ownTroops = 100000;
tick = 40;
const pendingPlayerCandidate = {
  player: pendingPlayerTarget,
  tribeClusterSize: 1,
  tribeClusterAccess: 1,
};
assert.equal(
  await pendingPlayerBehavior.sendAttack(
    pendingPlayerTarget,
    false,
    null,
    pendingPlayerCandidate,
    false,
    true,
  ),
  true,
  "an accepted player attack is recorded before the engine exposes it",
);
assert.equal(outgoing.length, 0, "the regression keeps the engine snapshot empty");
assert.strictEqual(
  pendingPlayerBehavior.outboundPlayerAttackCommitments().targetsByKey.get("61"),
  pendingPlayerTarget,
  "a pending player intent still identifies its target",
);
pendingPlayerTargetTroops = 2000;
tick = 41;
const pendingPlayerReinforcementCount = troopEmissions.length;
assert.equal(
  await pendingPlayerBehavior.reinforceIncompleteOutboundPlayerAttack(),
  true,
  "a target-specific reinforcement is emitted while the original attack is not visible",
);
assert.equal(troopEmissions.length, pendingPlayerReinforcementCount + 1);
assert.equal(
  troopEmissions.at(-1),
  4000,
  "after the snack blitz already committed the preferred force, the reinforcement tops up only the remainder toward the new preferred total",
);
outgoing.push({
  id: () => "pending-player-attack-1",
  retreating: () => false,
  target: () => pendingPlayerTarget,
  troops: () => 4000,
});
tick = 42;
assert.equal(
  pendingPlayerBehavior.getPendingOutboundAttackTroops(),
  4000,
  "the visible first attack does not release the still-unseen reinforcement intent",
);
outgoing.push({
  id: () => "pending-player-attack-2",
  retreating: () => false,
  target: () => pendingPlayerTarget,
  troops: () => 6000,
});
tick = 43;
assert.equal(
  pendingPlayerBehavior.getPendingOutboundAttackTroops(),
  0,
  "matching engine attacks settle each accepted intent exactly once",
);
assert.equal(
  pendingPlayerBehavior.outboundPlayerAttackCommitments().committedByKey.get("61"),
  10000,
  "visible attack troops are not double-counted with settled local intents",
);

// Engine cancellation consumes a forced counterattack's troops before deleting
// the new execution when the incoming wave is larger. No outgoing attack is
// visible, but the observed own-army debit is authoritative and must release
// the local reservation immediately instead of waiting six ticks.
const forcedDebitBehavior = new sandbox.AttackBehavior({}, game, parallelMe, 0.5, 0.3, 0.1, {}, {});
let forcedOwnTroops = 100000;
forcedDebitBehavior.player = {
  ...parallelMe,
  troops: () => forcedOwnTroops,
};
forcedDebitBehavior.currentAttackDecisionTick = () => tick;
forcedDebitBehavior.getOutboundAttackSnapshot = () => [];
tick = 50;
forcedDebitBehavior.recordOutboundAttackIntent(parallelTribeA, 20000, {
  forcedCounterattack: true,
});
forcedOwnTroops = 79000;
tick = 51;
assert.equal(
  forcedDebitBehavior.getPendingOutboundAttackTroops(),
  0,
  "a forced counterattack canceled in-flight releases its stale pending reservation after the troop debit",
);

const forcedNoDebitBehavior = new sandbox.AttackBehavior(
  {},
  game,
  parallelMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
forcedNoDebitBehavior.player = {
  ...parallelMe,
  troops: () => 100000,
};
forcedNoDebitBehavior.currentAttackDecisionTick = () => tick;
forcedNoDebitBehavior.getOutboundAttackSnapshot = () => [];
tick = 60;
forcedNoDebitBehavior.recordOutboundAttackIntent(parallelTribeA, 20000, {
  forcedCounterattack: true,
});
tick = 61;
assert.equal(
  forcedNoDebitBehavior.getPendingOutboundAttackTroops(),
  20000,
  "a forced intent without an observed debit keeps the grace reservation",
);

pendingPlayerBehavior.botAttackPendingIntentCommitments = [
  {
    targetIsPlayer: true,
    targetKey: "62",
    troops: 1000,
    target: {
      isPlayer: () => true,
      isAlive: () => false,
      smallID: () => 62,
    },
  },
  { targetIsPlayer: true, targetKey: "63", troops: 1000, target: {} },
];
pendingPlayerBehavior.outboundIntentReconciledTick = null;
assert.equal(
  pendingPlayerBehavior.outboundPlayerAttackCommitments().targetsByKey.has("62"),
  false,
  "a stale target cannot re-enter reinforcement planning",
);
assert.equal(
  pendingPlayerBehavior.outboundPlayerAttackCommitments().targetsByKey.has("63"),
  false,
  "an invalid target reference cannot create a reinforcement plan",
);

outgoing.length = 0;
ownTroops = 100000;
tick = 20;

outgoing.push({
  id: () => "growing-tribe-attack",
  retreating: () => false,
  target: () => parallelTribeA,
  troops: () => 3000,
});
parallelTribeA.troops = () => 4000;
assert.equal(parallelBehavior.getLiveOutboundAttackTroopsForTarget(parallelTribeA), 3000);
assert.equal(
  parallelBehavior.activeTribeReinforcementPlan(parallelTribeA),
  null,
  "land-border tribes stay on the normal reserve-aware attack path instead of the maritime reinforcement override",
);
parallelBehavior.botAttackTroopsSent = 0;
assert.equal(
  parallelBehavior.calculateBotAttackTroops(parallelTribeA, 20000, {}, 3000),
  13000,
  "a growing tribe receives only the missing top-up to the live 4x conquest floor",
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
parallelTribeA.troops = () => 4500;
parallelBehavior.botAttackTroopsSent = 0;
assert.equal(
  parallelBehavior.calculateBotAttackTroops(parallelTribeA, 20000, {}, 3000),
  14500,
  "tribe reinforcement includes a pending top-up but still fills a newly grown 4x capture floor",
);

const fractionalPendingTribeTarget = {
  ...parallelTribeA,
  troops: () => 53914.5,
};
const fractionalPendingTribeBehavior = new sandbox.AttackBehavior(
  {},
  game,
  parallelMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
fractionalPendingTribeBehavior.getLiveOutboundAttackTroopsForTarget = () => 0;
fractionalPendingTribeBehavior.getPendingOutboundAttackTroopsForTarget = () => 945.408;
assert.equal(
  fractionalPendingTribeBehavior.calculateBotAttackTroops(fractionalPendingTribeTarget, 214713),
  214713,
  "a fractional pending force rounds the remaining whole-troop conquest payload up",
);
assert.equal(
  fractionalPendingTribeBehavior.calculateBotAttackTroops(fractionalPendingTribeTarget, 214712),
  0,
  "a tribe capture is deferred rather than emitting one troop below its conquest floor",
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

const maritimeReinforcementBehavior = Object.create(sandbox.AttackBehavior.prototype);
const maritimeIncompleteTribe = {
  isAlive: () => true,
  isPlayer: () => true,
  type: () => sandbox.PlayerType.Bot,
  troops: () => 500,
};
let maritimeReinforcementArgs = null;
maritimeReinforcementBehavior.getActiveOutboundPlayerTargets = () => [maritimeIncompleteTribe];
maritimeReinforcementBehavior.player = {
  isFriendly: () => false,
  sharesBorderWith: () => false,
};
maritimeReinforcementBehavior.outboundPlayerAttackCommitments = () => ({
  targetsByKey: new Map([["maritime", maritimeIncompleteTribe]]),
  committedByKey: new Map([["maritime", 100]]),
});
maritimeReinforcementBehavior.getEnemyDefensePostAttackProfile = () => ({});
maritimeReinforcementBehavior.getPlayerAttackPreferredTroopFloor = () => 1000;
maritimeReinforcementBehavior.sendAttack = async (...args) => {
  maritimeReinforcementArgs = args;
  return true;
};
assert.equal(
  await maritimeReinforcementBehavior.reinforceIncompleteOutboundPlayerAttack(),
  true,
  "an incomplete maritime Tribe attack is reinforced instead of being abandoned for lacking a land border",
);
assert.equal(maritimeReinforcementArgs?.[0], maritimeIncompleteTribe);
assert.equal(
  maritimeReinforcementArgs?.[5],
  true,
  "Tribe reinforcements retain the parallel-Tribe route so sendAttack can choose a transport",
);

// A maritime reinforcement must carry the plan's exact missing force through
// sendAttack.  The generic boat path intentionally emits a cheap probe, which
// is wrong once an active conquest has a target-specific capture floor.
const maritimeActiveTargetTroops = 5_000;
const maritimeActiveTarget = {
  isAlive: () => true,
  isPlayer: () => true,
  type: () => sandbox.PlayerType.Bot,
  smallID: () => 64,
  id: () => "maritime-active-target",
  troops: () => maritimeActiveTargetTroops,
  borderTiles: () => new Set([101]),
  units: () => [],
};
const maritimePlayer = {
  ...parallelMe,
  borderTiles: () => new Set([1]),
  units: () => [],
  unitCount: () => 0,
  sharesBorderWith: () => false,
  bestTransportShipSpawn: async () => "spawn",
};
const maritimeGame = {
  ...game,
  owner: () => maritimeActiveTarget,
  ownerID: () => maritimeActiveTarget.smallID(),
  playerBySmallID: (smallID) =>
    smallID === maritimeActiveTarget.smallID() ? maritimeActiveTarget : null,
  isShore: (tile) => tile === 1 || tile === 101,
  ensureBorderTiles: async () => {},
  config: () => ({
    maxTroops: () => 100_000,
    isUnitDisabled: () => false,
    boatMaxNumber: () => 10,
  }),
};
const maritimeExactBehavior = new sandbox.AttackBehavior(
  {},
  maritimeGame,
  maritimePlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
maritimeExactBehavior.getEnemyDefensePostAttackProfile = () => ({
  attackCostMultiplier: 1,
});
maritimeExactBehavior.attackIsTooWeakForDefensePosts = () => false;
maritimeExactBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
maritimeExactBehavior.allowEarlyGameBoat = async () => true;
outgoing.length = 0;
outgoing.push({
  id: () => "maritime-active-attack",
  retreating: () => false,
  target: () => maritimeActiveTarget,
  troops: () => 8_000,
});
ownTroops = 100_000;
tick = 60;
const maritimeExactEmissionCount = troopEmissions.length;
assert.equal(
  await maritimeExactBehavior.reinforceIncompleteOutboundPlayerAttack(),
  true,
  "an active maritime conquest emits its target-specific reinforcement",
);
assert.equal(troopEmissions.length, maritimeExactEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  12_000,
  "the transport carries exactly the missing amount to reach the grown 4x floor",
);
assert.ok(
  ownTroops - troopEmissions.at(-1) >= maritimeExactBehavior.getEarlyGameLiveReserveTroops(),
  "the exact maritime reinforcement remains above the live reserve",
);
const maritimeNoDuplicateEmissionCount = troopEmissions.length;
tick += 1;
assert.equal(
  await maritimeExactBehavior.reinforceIncompleteOutboundPlayerAttack(),
  false,
  "a completed maritime reinforcement is not emitted again",
);
assert.equal(troopEmissions.length, maritimeNoDuplicateEmissionCount);

const prioritizedReinforcementBehavior = Object.create(sandbox.AttackBehavior.prototype);
const distantFromCapture = {
  isAlive: () => true,
  isPlayer: () => true,
  type: () => sandbox.PlayerType.Bot,
};
const nearlyCaptured = {
  isAlive: () => true,
  isPlayer: () => true,
  type: () => sandbox.PlayerType.Bot,
};
prioritizedReinforcementBehavior.player = { isFriendly: () => false };
prioritizedReinforcementBehavior.outboundPlayerAttackCommitments = () => ({
  targetsByKey: new Map([
    ["distant", distantFromCapture],
    ["near", nearlyCaptured],
  ]),
  committedByKey: new Map([
    ["distant", 100],
    ["near", 900],
  ]),
});
prioritizedReinforcementBehavior.getEnemyDefensePostAttackProfile = () => ({});
prioritizedReinforcementBehavior.getPlayerAttackPreferredTroopFloor = () => 1000;
let prioritizedReinforcementTarget = null;
prioritizedReinforcementBehavior.sendAttack = async (target) => {
  prioritizedReinforcementTarget = target;
  return true;
};
assert.equal(
  await prioritizedReinforcementBehavior.reinforceIncompleteOutboundPlayerAttack(),
  true,
);
assert.strictEqual(
  prioritizedReinforcementTarget,
  nearlyCaptured,
  "reinforcement closes the conquest nearest its capture floor before funding a distant front",
);

const commitmentSnapshotBehavior = Object.create(sandbox.AttackBehavior.prototype);
let commitmentOutgoingReads = 0;
let commitmentReconciliations = 0;
const commitmentTribeA = {
  id: () => "commitment-a",
  smallID: () => 51,
  isPlayer: () => true,
};
const commitmentTribeB = {
  id: () => "commitment-b",
  smallID: () => 52,
  isPlayer: () => true,
};
commitmentSnapshotBehavior.player = {
  isFriendly: () => false,
  outgoingAttacks: () => {
    commitmentOutgoingReads++;
    return [
      { retreating: () => false, target: () => commitmentTribeA, troops: () => 100 },
      { retreating: () => false, target: () => commitmentTribeB, troops: () => 900 },
    ];
  },
};
commitmentSnapshotBehavior.game = { ticks: () => 80 };
commitmentSnapshotBehavior.botAttackPendingIntentCommitments = [
  { targetIsPlayer: true, targetKey: "51", troops: 200 },
];
commitmentSnapshotBehavior.reconcileOutboundAttackIntentCommitments = () => {
  commitmentReconciliations++;
};
commitmentSnapshotBehavior.getEnemyDefensePostAttackProfile = () => ({});
commitmentSnapshotBehavior.getPlayerAttackPreferredTroopFloor = () => 1000;
const commitmentPlans = commitmentSnapshotBehavior.incompleteOutboundPlayerAttackPlans();
assert.deepEqual(
  Array.from(commitmentPlans, (plan) => plan.target.smallID()),
  [52, 51],
  "one commitment snapshot preserves nearest-to-capture reinforcement priority",
);
assert.equal(
  commitmentOutgoingReads,
  1,
  "all incomplete targets share one outgoing-attack snapshot",
);
assert.equal(
  commitmentReconciliations,
  1,
  "all incomplete targets share one pending-intent reconciliation",
);

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
botParallelBehavior.earlyGameTribeCandidatesRefresh = undefined;
botParallelBehavior.earlyGameTribeCandidatesCache = [
  { id: "parallel-a", tribeClusterSize: 1, tribeClusterAccess: 1 },
  { id: "parallel-b", tribeClusterSize: 1, tribeClusterAccess: 1 },
];
outgoing.length = 0;
tick = 21;
const botParallelEmissionCount = troopEmissions.length;
assert.equal(await botParallelBehavior.attackBots(), false);
assert.equal(
  troopEmissions.length,
  botParallelEmissionCount,
  "the generic tribe pass cannot start captures without scored cluster candidates",
);

botParallelBehavior.botAttackPendingIntentCommitments = [];
botParallelBehavior.outboundIntentReconciledTick = null;
botParallelBehavior.earlyGamePreferredClusterTargetKeys = new Set(["21"]);
botParallelTargets[0].troops = () => 4000;
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
  13000,
  "an incomplete tribe attack receives only the missing reinforcement",
);

botParallelBehavior.botAttackPendingIntentCommitments = [];
botParallelBehavior.outboundIntentReconciledTick = null;
outgoing[0].troops = () => 16000;
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

botParallelBehavior.earlyGamePreferredClusterTargetKeys = null;
botParallelBehavior.earlyGameTribeCandidatesRefresh = null;
botParallelBehavior.earlyGameTribeCandidatesCache = [
  { id: "stale-unscored-tribe", player: parallelTribeA },
];
clusterFilteredCalls.length = 0;
assert.equal(
  await botParallelBehavior.attackBots(),
  false,
  "the generic tribe fallback waits for a scored cluster cache instead of consuming an arbitrary stale tribe",
);
assert.equal(clusterFilteredCalls.length, 0);
botParallelBehavior.earlyGameTribeCandidatesCache = null;

const makeEarlyTribeCandidate = (id, player) => ({
  id,
  player,
  maritimeDistance: 0,
  oceanDistance: 0,
  futureFoodCount: 1,
  futureFoodAccess: 0.5,
  tribeClusterSize: 1,
  tribeClusterAccess: 1,
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

const staleTribeCandidate = makeEarlyTribeCandidate("stale", {
  ...parallelTribeA,
  isAlive: () => false,
});
earlyTribeCalls.length = 0;
assert.equal(
  await earlyTribeBatch.launchEarlyGameTribeCandidate(staleTribeCandidate, new Set()),
  false,
  "a tribe that died after the cooperative snapshot cannot receive an attack intent",
);
assert.equal(earlyTribeCalls.length, 0);

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
throttledParallelBehavior.earlyGameTribeCandidatesRefresh = undefined;
throttledParallelBehavior.earlyGameTribeCandidatesCache = [
  { id: "throttled-a", tribeClusterSize: 1, tribeClusterAccess: 1 },
  { id: "throttled-b", tribeClusterSize: 1, tribeClusterAccess: 1 },
];
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
  canDonateTroops: () => true,
  isFriendly: () => false,
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
    maxTroops: (player) => {
      if (player?.smallID?.() === 14) return 130000;
      if (player?.smallID?.() === 15) return 30000;
      return 100000;
    },
    gameConfig: () => ({ gameMode: "Team" }),
    donateTroops: () => true,
    donateCooldown: () => 100,
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

const capacityLimitedTeammate = {
  troops: () => 8000,
  smallID: () => 15,
};
assert.equal(
  donorBehavior.donationAmount(capacityLimitedTeammate),
  22000,
  "the requested and locally reserved donation cannot exceed the recipient's authoritative troop headroom",
);

assert.equal(donorBehavior.donateTroops(), true);
assert.equal(
  troopEmissions.at(-1),
  38212,
  "donations release only the surplus above the calculated production peak",
);

const emissionsAfterFirstDonation = troopEmissions.length;
const secondNeedyTeammate = {
  troops: () => 1,
  smallID: () => 14,
  id: () => "player-14",
  isAlive: () => true,
  incomingAttacks: () => [],
  outgoingAttacks: () => [],
};
donationPlayers = [donor, secondNeedyTeammate];
assert.equal(
  donorBehavior.donateTroops(),
  false,
  "one decision tick cannot donate twice to different allies through separate strategy paths",
);
assert.equal(troopEmissions.length, emissionsAfterFirstDonation);
donationPlayers = [donor, needyTeammate];
assert.equal(
  donorBehavior.donateTroops(),
  false,
  "a recipient remains ineligible for the authoritative donation cooldown",
);
assert.equal(troopEmissions.length, emissionsAfterFirstDonation);
tick += 100;
assert.equal(
  donorBehavior.donateTroops(),
  true,
  "the recipient becomes eligible when the authoritative cooldown expires",
);
tick -= 100;

donor.canDonateTroops = () => false;
const emissionsBeforeIneligibleDonation = troopEmissions.length;
assert.equal(
  new sandbox.AttackBehavior(
    { chance: () => true },
    donationGame,
    donor,
    0.5,
    0.3,
    0.1,
    {},
    {},
  ).donateTroops(),
  true,
  "lobby donation capability does not suppress the bot's troop intent",
);
assert.equal(troopEmissions.length, emissionsBeforeIneligibleDonation + 1);
donor.canDonateTroops = () => true;

const emissionsBeforeAttackedDonation = troopEmissions.length;
donorIncomingAttacks = [{ troops: () => 1 }];
assert.equal(
  donorBehavior.donateTroops(),
  false,
  "being under attack is an absolute donation veto",
);
assert.equal(troopEmissions.length, emissionsBeforeAttackedDonation);
donorIncomingAttacks = [{ troops: () => 1, retreating: () => true }];
assert.equal(
  donorBehavior.donationHasIncomingAttack(),
  false,
  "a retreating attack no longer vetoes donations after the threat is cancelled",
);
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
const retiredCombatCandidate = urgentDonationBehavior.donationCandidate(
  {
    teammate: {
      ...attackedTeammate,
      smallID: () => 18,
      id: () => "player-18",
      incomingAttacks: () => [{ retreating: () => true }],
      outgoingAttacks: () => [{ retreating: () => true }],
    },
    troopPercentage: 0.5,
  },
  0.8,
);
assert.equal(retiredCombatCandidate.underAttack, false);
assert.equal(
  retiredCombatCandidate.frontline,
  false,
  "cancelled incoming and outgoing waves remain eligible behind live frontline allies",
);
const attackingCombatCandidate = urgentDonationBehavior.donationCandidate(
  {
    teammate: {
      ...attackedTeammate,
      smallID: () => 19,
      id: () => "player-19",
      incomingAttacks: () => [],
      outgoingAttacks: () => [{ troops: () => 20000 }],
    },
    troopPercentage: 0.5,
  },
  0.8,
);
assert.equal(
  attackingCombatCandidate.underAttack,
  false,
  "an offensive ally is not mislabeled as being under attack",
);
assert.equal(
  attackingCombatCandidate.frontline,
  true,
  "an ally with a live outgoing attack receives combat donation urgency over rear allies",
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

const matchingStrategicBorderOpponent = {
  ...makeBorderOpponent(17, 100000),
  type: () => sandbox.PlayerType.Nation,
};
donationOwnerByTile.clear();
donationOwnerByTile.set(2, matchingStrategicBorderOpponent.smallID());
donationPlayers = [donor, needyTeammate, matchingStrategicBorderOpponent];
const strategicBorderDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const emissionsBeforeStrategicBorderDonation = troopEmissions.length;
assert.equal(
  strategicBorderDonationBehavior.donateTroops(),
  false,
  "a Nation/Human border army matching our force vetoes troop donations",
);
assert.equal(troopEmissions.length, emissionsBeforeStrategicBorderDonation);

// Regression from a headless match: being barely stronger than a bordering
// Nation must cap the donation at the exact surplus, not preserve only half of
// the Nation and export the rest of the defensive army.
donorTroops = 1367642;
const nearMatchingStrategicBorderOpponent = {
  ...makeBorderOpponent(18, 1365189),
  type: () => sandbox.PlayerType.Nation,
};
donationOwnerByTile.clear();
donationOwnerByTile.set(2, nearMatchingStrategicBorderOpponent.smallID());
donationPlayers = [donor, needyTeammate, nearMatchingStrategicBorderOpponent];
const nearMatchingStrategicDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const emissionsBeforeNearMatchingDonation = troopEmissions.length;
assert.equal(
  nearMatchingStrategicDonationBehavior.donateTroops(),
  false,
  "a negligible safe surplus is not large enough to justify a donation",
);
assert.equal(
  troopEmissions.length,
  emissionsBeforeNearMatchingDonation,
  "the donation that would expose the frontier is not emitted",
);

donorTroops = 1229612;
const closeStrategicBorderOpponent = {
  ...makeBorderOpponent(19, 1174271),
  type: () => sandbox.PlayerType.Nation,
};
donationOwnerByTile.clear();
donationOwnerByTile.set(2, closeStrategicBorderOpponent.smallID());
donationPlayers = [donor, needyTeammate, closeStrategicBorderOpponent];
const closeStrategicDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(closeStrategicDonationBehavior.donateTroops(), true);
assert.equal(
  troopEmissions.at(-1),
  55341,
  "the donation is capped at the exact surplus over the strategic border army",
);
assert.equal(
  donorTroops - troopEmissions.at(-1),
  closeStrategicBorderOpponent.troops(),
  "the complete strategic border army remains available after donating",
);

donorTroops = 100000;
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

// The fallback donation strategy is a separate Legendary entry point from the
// proactive policy. It must still honor the same real-time throttle after the
// proactive path has already sent a donation in this window.
sandbox.state.settings.donateThrottleMs = 1200;
sandbox.state.lastDonateMs = 0;
sandbox.performance.now = () => 20000;
sandbox.state.earlyGame = {};
const throttledDonationTeammate = {
  troops: () => 8000,
  smallID: () => 42,
  id: () => "player-42",
  isAlive: () => true,
  incomingAttacks: () => [],
  outgoingAttacks: () => [],
};
donor.isOnSameTeam = (player) => [11, 42].includes(player?.smallID?.());
donationPlayers = [
  donor,
  throttledDonationTeammate,
  weakBorderOpponent,
  strongBorderOpponent,
  alliedBorderOpponent,
  remoteOpponent,
];
const throttledDonationGame = {
  ...donationGame,
  config: () => ({
    ...donationGame.config(),
    donateCooldown: () => 0,
  }),
};
const throttledDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  throttledDonationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const emissionsBeforeProactiveDonation = troopEmissions.length;
assert.equal(
  throttledDonationBehavior.runDonationPolicy(),
  undefined,
  "the proactive donation policy evaluates without exposing an async result",
);
const emissionsAfterProactiveDonation = troopEmissions.length;
assert.equal(
  emissionsAfterProactiveDonation,
  emissionsBeforeProactiveDonation + 1,
  "the proactive path emits before the fallback throttle is exercised",
);
assert.equal(
  sandbox.state.lastDonateMs,
  20000,
  "a successful proactive donation records the shared throttle timestamp",
);
tick += 1;
const fallbackDonationStrategy = throttledDonationBehavior.getAttackStrategies([], [], []).at(-1);
assert.equal(
  await fallbackDonationStrategy(),
  false,
  "the Legendary fallback donation entry point honors the global donation throttle",
);
assert.equal(troopEmissions.length, emissionsAfterProactiveDonation);
sandbox.state.settings.donateThrottleMs = undefined;

// The ordinary active-Tribe fallback must carry the same exact reinforcement
// plan as the dedicated reconciliation lane. Without it, a maritime target
// with an existing capture intent regresses to the ordinary 1% boat probe.
const activeMaritimeFallbackBehavior = new sandbox.AttackBehavior(
  {},
  maritimeGame,
  maritimePlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
activeMaritimeFallbackBehavior.getEnemyDefensePostAttackProfile = () => ({
  attackCostMultiplier: 1,
});
activeMaritimeFallbackBehavior.attackIsTooWeakForDefensePosts = () => false;
activeMaritimeFallbackBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
activeMaritimeFallbackBehavior.allowEarlyGameBoat = async () => true;
activeMaritimeFallbackBehavior.earlyGameTribeCandidatesRefresh = undefined;
activeMaritimeFallbackBehavior.getBotsNeedingAttackReinforcement = () => [maritimeActiveTarget];
outgoing.length = 0;
outgoing.push({
  id: () => "maritime-active-fallback-attack",
  retreating: () => false,
  target: () => maritimeActiveTarget,
  troops: () => 8_000,
});
tick += 1;
const activeMaritimeFallbackEmissionCount = troopEmissions.length;
assert.equal(
  await activeMaritimeFallbackBehavior.attackBots(),
  true,
  "the ordinary Tribe fallback revisits an active maritime capture",
);
assert.equal(troopEmissions.length, activeMaritimeFallbackEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  12_000,
  "the active maritime Tribe fallback emits the exact missing capture force instead of a 1% probe",
);

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
sandbox.state.settings.pauseDonateDuringExpansion = false;
const breakoutDonationBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
breakoutDonationBehavior.expansionBreakoutActive = true;
assert.equal(
  breakoutDonationBehavior.donateTroops(),
  false,
  "maritime breakout reserves troops instead of donating the beachhead budget",
);
sandbox.state.earlyGame = { active: false, hasFreeLand: false, actionableTribes: [] };
sandbox.state.settings.pauseDonateDuringExpansion = false;

const maritimeDonationGateBehavior = Object.create(sandbox.AttackBehavior.prototype);
maritimeDonationGateBehavior.game = donationGame;
maritimeDonationGateBehavior.player = donor;
sandbox.window = {
  __OFH_getIncomingMaritimeInvasion: () => null,
};
assert.equal(
  maritimeDonationGateBehavior.donationHasMaritimeInvasion(),
  false,
  "no maritime invasion signal does not permanently veto donations",
);
sandbox.window.__OFH_getIncomingMaritimeInvasion = () => ({ active: true });
assert.equal(
  maritimeDonationGateBehavior.donationHasMaritimeInvasion(),
  true,
  "an active maritime invasion still vetoes donations",
);
delete sandbox.window;

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

const originalIslandScanRadius = sandbox.state.settings.islandScanRadius;
const originalIslandScanStep = sandbox.state.settings.islandScanStep;
const originalIslandScanSamples = sandbox.state.settings.islandScanSamples;
sandbox.state.settings.islandScanRadius = 2;
sandbox.state.settings.islandScanStep = 1;
sandbox.state.settings.islandScanSamples = 2;
let oceanOwnerChecks = 0;
let oceanLandChecks = 0;
const overlappingOceanScan = Object.create(sandbox.AttackBehavior.prototype);
overlappingOceanScan.player = { smallID: () => 1 };
overlappingOceanScan.game = {
  x: (tile) => tile % 100,
  y: (tile) => Math.floor(tile / 100),
  isValidCoord: (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8,
  ref: (x, y) => y * 100 + x,
  isLand: () => {
    oceanLandChecks += 1;
    return true;
  },
  hasOwner: () => {
    oceanOwnerChecks += 1;
    return true;
  },
  hasFallout: () => false,
  isOceanShore: () => true,
  neighbors: () => [],
  ownerID: () => null,
};
assert.equal(overlappingOceanScan.scanEarlyOceanTargets([202, 203]).length, 0);
assert.equal(
  oceanOwnerChecks,
  30,
  "overlapping early-ocean samples inspect each rejected tile once per synchronous scan",
);
assert.equal(oceanLandChecks, 30);
let oceanWaterChecks = 0;
overlappingOceanScan.game.isLand = () => {
  oceanWaterChecks += 1;
  return false;
};
assert.equal(overlappingOceanScan.scanEarlyOceanTargets([202, 203]).length, 0);
assert.equal(
  oceanWaterChecks,
  30,
  "overlapping early-ocean samples also inspect each rejected water tile once per synchronous scan",
);
sandbox.state.settings.islandScanRadius = originalIslandScanRadius;
sandbox.state.settings.islandScanStep = originalIslandScanStep;
sandbox.state.settings.islandScanSamples = originalIslandScanSamples;

const boatEtaBudgetBehavior = Object.create(sandbox.AttackBehavior.prototype);
let boatEtaBudgetTick = 1;
const boatEtaRouteCalls = [];
let concurrentBoatEtaCandidateGroups = 0;
let maximumConcurrentBoatEtaCandidateGroups = 0;
const boatEtaOwnShores = [1];
boatEtaBudgetBehavior.currentAttackDecisionTick = () => boatEtaBudgetTick;
boatEtaBudgetBehavior.getEarlyGameOwnShores = () => boatEtaOwnShores;
boatEtaBudgetBehavior.estimateEarlyGameTribeBoatEta = async (_border, candidate) => {
  concurrentBoatEtaCandidateGroups++;
  maximumConcurrentBoatEtaCandidateGroups = Math.max(
    maximumConcurrentBoatEtaCandidateGroups,
    concurrentBoatEtaCandidateGroups,
  );
  await Promise.resolve();
  concurrentBoatEtaCandidateGroups--;
  boatEtaRouteCalls.push(candidate.id);
  candidate.boatTargetTile = Number(candidate.id.slice(-1));
  return 12;
};
const boatEtaBudgetPlayers = Array.from({ length: 6 }, (_unused, index) => ({
  id: `sea-${index + 1}`,
}));
const makeBoatEtaBudgetCandidates = () =>
  boatEtaBudgetPlayers.map((player, index) => ({
    id: `sea-${index + 1}`,
    player,
    landBorder: false,
  }));
const boatEtaBudgetBorders = new Map(
  boatEtaBudgetPlayers.map((player, index) => [player, new Set([100 + index])]),
);
const firstBoatEtaBudgetCandidates = makeBoatEtaBudgetCandidates();
await boatEtaBudgetBehavior.enrichEarlyGameTribeBoatEtas(
  firstBoatEtaBudgetCandidates,
  boatEtaBudgetBorders,
);
assert.deepEqual(
  boatEtaRouteCalls,
  ["sea-1", "sea-2", "sea-3", "sea-4"],
  "one opening decision probes only the prioritized maritime ETA batch",
);
assert.equal(
  maximumConcurrentBoatEtaCandidateGroups,
  1,
  "each cold tribe's bounded route-probe group settles before the next begins",
);
assert.equal(
  firstBoatEtaBudgetCandidates[4].boatEtaTicks,
  undefined,
  "uncached lower-priority sea tribes wait for a later decision instead of extending the frame",
);
const secondBoatEtaBudgetCandidates = makeBoatEtaBudgetCandidates();
boatEtaBudgetTick += 1;
await boatEtaBudgetBehavior.enrichEarlyGameTribeBoatEtas(
  secondBoatEtaBudgetCandidates,
  boatEtaBudgetBorders,
);
assert.deepEqual(
  boatEtaRouteCalls,
  ["sea-1", "sea-2", "sea-3", "sea-4", "sea-5", "sea-6"],
  "cached priorities let the next decision advance to every remaining sea gateway",
);

const cachedTopologyBorderBehavior = Object.create(sandbox.AttackBehavior.prototype);
let cachedTopologyWorkerCalls = 0;
const retainedTopologyBorder = new Set([31, 32]);
const cachedTopologyPlayer = { borderTiles: () => retainedTopologyBorder };
cachedTopologyBorderBehavior.game = {
  ensureBorderTiles: async () => {
    cachedTopologyWorkerCalls++;
    return new Set([99]);
  },
};
assert.strictEqual(
  await cachedTopologyBorderBehavior.fetchEarlyGameTribeBorder(cachedTopologyPlayer),
  retainedTopologyBorder,
  "a surviving tribe reuses its retained border snapshot when topology membership changes",
);
assert.equal(
  cachedTopologyWorkerCalls,
  0,
  "a known surviving tribe does not add another worker border request",
);
cachedTopologyPlayer.borderTiles = () => new Set();
assert.deepEqual(
  Array.from(await cachedTopologyBorderBehavior.fetchEarlyGameTribeBorder(cachedTopologyPlayer)),
  [99],
  "a tribe without a cached border still refreshes through the authoritative worker path",
);
assert.equal(cachedTopologyWorkerCalls, 1);

const cachedTerraFrontierBehavior = Object.create(sandbox.AttackBehavior.prototype);
let terraFrontierTick = 40;
let terraFrontierNeighborReads = 0;
let terraFrontierBorder = [1, 2];
cachedTerraFrontierBehavior.player = { borderTiles: () => terraFrontierBorder };
cachedTerraFrontierBehavior.game = {
  ticks: () => terraFrontierTick,
  neighbors: (tile) => {
    terraFrontierNeighborReads++;
    return [tile + 100];
  },
  isLand: () => true,
  hasOwner: () => false,
  isImpassable: () => false,
};
assert.equal(cachedTerraFrontierBehavior.hasLandBorderWithTerraNullius(), true);
assert.deepEqual(
  Array.from(cachedTerraFrontierBehavior.getTerraNulliusFrontierTiles()),
  [101, 102],
  "the exact frontier remains available for the following troop-floor calculation",
);
assert.equal(
  terraFrontierNeighborReads,
  2,
  "the opening presence check and troop-floor read share one frontier scan per decision snapshot",
);
terraFrontierTick++;
cachedTerraFrontierBehavior.getTerraNulliusFrontierTiles();
assert.equal(terraFrontierNeighborReads, 4, "a later decision rebuilds its frontier");
terraFrontierBorder = [1, 2];
cachedTerraFrontierBehavior.getTerraNulliusFrontierTiles();
assert.equal(
  terraFrontierNeighborReads,
  6,
  "a new border snapshot rebuilds its frontier immediately",
);

const impassableTerraBehavior = Object.create(sandbox.AttackBehavior.prototype);
const impassableTerraGame = {
  neighbors: () => [2],
  isLand: () => true,
  hasOwner: () => false,
  isImpassable: () => true,
  hasFallout: () => true,
};
impassableTerraBehavior.player = { borderTiles: () => [1] };
impassableTerraBehavior.game = impassableTerraGame;
assert.equal(
  impassableTerraBehavior.hasLandBorderWithTerraNullius(),
  false,
  "impassable free-looking land must not schedule a Terra Nullius attack the engine will retire",
);
assert.equal(
  impassableTerraBehavior.isBorderingNukedTerritory(),
  false,
  "impassable fallout cannot reactivate the radioactive Terra Nullius lane",
);
impassableTerraGame.isImpassable = () => false;
assert.equal(
  impassableTerraBehavior.hasLandBorderWithTerraNullius(),
  true,
  "a passable unowned land neighbor remains an eligible Terra Nullius target",
);
assert.equal(
  impassableTerraBehavior.isBorderingNukedTerritory(),
  true,
  "a passable fallout neighbor remains eligible for the radioactive expansion policy",
);

const terraNulliusBoatProbeTile = 500;
const terraNulliusBoatProbeState = {
  land: true,
  owner: false,
  water: false,
  valid: true,
};
const terraNulliusBoatProbeGame = {
  isLand: (tile) => tile === terraNulliusBoatProbeTile && terraNulliusBoatProbeState.land,
  hasOwner: (tile) => tile === terraNulliusBoatProbeTile && terraNulliusBoatProbeState.owner,
  isWater: (tile) => tile === terraNulliusBoatProbeTile && terraNulliusBoatProbeState.water,
  isValidRef: (tile) => tile === terraNulliusBoatProbeTile && terraNulliusBoatProbeState.valid,
};
const terraNulliusBoatProbeBehavior = Object.create(sandbox.AttackBehavior.prototype);
terraNulliusBoatProbeBehavior.game = terraNulliusBoatProbeGame;
terraNulliusBoatProbeBehavior.canSendNearbyTerraNulliusBoat = () => true;
terraNulliusBoatProbeBehavior.nearbyTerraNulliusBoatCandidates = () => [terraNulliusBoatProbeTile];
terraNulliusBoatProbeBehavior.player = {
  bestTransportShipSpawn: async () => "reachable-source",
};
terraNulliusBoatProbeBehavior.allowEarlyGameBoat = async () => true;
terraNulliusBoatProbeBehavior.nearbyTerraNulliusBoatTroops = () => 100;
const terraNulliusBoatEmissions = [];
terraNulliusBoatProbeBehavior.emitNearbyTerraNulliusBoat = (tile, troops) => {
  terraNulliusBoatEmissions.push({ tile, troops });
  return true;
};
assert.equal(
  await terraNulliusBoatProbeBehavior.sendBoatAttackToNearbyTerraNullius(),
  true,
  "an unowned impassable Terra Nullius tile remains a valid boat probe after the route await",
);
assert.deepEqual(terraNulliusBoatEmissions, [{ tile: terraNulliusBoatProbeTile, troops: 100 }]);

for (const staleState of [
  { name: "owned", owner: true, water: false, land: true, valid: true },
  { name: "water", owner: false, water: true, land: false, valid: true },
  { name: "invalid", owner: false, water: false, land: true, valid: false },
]) {
  terraNulliusBoatProbeState.owner = false;
  terraNulliusBoatProbeState.water = false;
  terraNulliusBoatProbeState.land = true;
  terraNulliusBoatProbeState.valid = true;
  terraNulliusBoatEmissions.length = 0;
  terraNulliusBoatProbeBehavior.player.bestTransportShipSpawn = async () => {
    terraNulliusBoatProbeState.owner = staleState.owner;
    terraNulliusBoatProbeState.water = staleState.water;
    terraNulliusBoatProbeState.land = staleState.land;
    terraNulliusBoatProbeState.valid = staleState.valid;
    return "reachable-source";
  };
  assert.equal(
    await terraNulliusBoatProbeBehavior.sendBoatAttackToNearbyTerraNullius(),
    false,
    `a Terra Nullius boat probe does not emit when the selected ${staleState.name} tile becomes stale after await`,
  );
  assert.deepEqual(terraNulliusBoatEmissions, []);
}

assert.match(
  fs.readFileSync(path.join(repoRoot, "engine/ingame/auto-bot/gameApi.js"), "utf8"),
  /isImpassable:/,
  "the behavior receives the engine's impassability predicate through GameView",
);

const futureFoodScoreBehavior = Object.create(sandbox.AttackBehavior.prototype);
let futureFoodDistanceCalls = 0;
futureFoodScoreBehavior.earlyGameCenterDistance = (left, right) => {
  futureFoodDistanceCalls++;
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
};
const futureFoodCandidates = [
  { id: "near", center: { x: 2, y: 0 } },
  { id: "far", center: { x: 1000, y: 0 } },
  { id: "other", center: { x: 4, y: 0 } },
];
const futureFoodScoreCandidates = [
  { id: "near", center: { x: 0, y: 0 }, landBorder: true },
  { id: "other", center: { x: 3, y: 0 }, landBorder: true },
  { id: "inactive", center: { x: 1, y: 0 }, landBorder: false },
];
futureFoodScoreBehavior.enrichEarlyGameFutureFoodScores(
  futureFoodScoreCandidates,
  futureFoodCandidates,
  new Map([
    ["near", { memberIds: new Set(["near", "other", "far"]), score: 3 }],
    ["other", { memberIds: new Set(["near", "other"]), score: 2 }],
  ]),
);
assert.equal(
  futureFoodScoreCandidates[0].futureFoodCount,
  1,
  "future-food scoring ignores the candidate itself and out-of-chain members",
);
assert.equal(futureFoodScoreCandidates[0].meanFutureFoodDistance, 4);
assert.equal(
  futureFoodScoreCandidates[0].futureFoodAccess,
  (1 - 4 / 120) / 2,
  "the allocation-free scoring pass retains the prior weighted-access result",
);
assert.equal(futureFoodScoreCandidates[0].tribeClusterAccess, 1);
assert.equal(futureFoodScoreCandidates[1].tribeClusterAccess, 0.5);
assert.equal(futureFoodScoreCandidates[2].futureFoodAccess, 0);
assert.equal(futureFoodScoreCandidates[2].tribeClusterAccess, 0);
assert.equal(
  futureFoodDistanceCalls,
  2,
  "future-food scoring reuses symmetric tribe distances within one cluster pass",
);

const tribeRankingBehavior = Object.create(sandbox.AttackBehavior.prototype);
const tribeStructureReads = new Map();
const tribeProfileReads = new Map();
tribeRankingBehavior.getEnemyDefensePostAttackProfile = (bot) => {
  tribeProfileReads.set(bot.rankKey, (tribeProfileReads.get(bot.rankKey) || 0) + 1);
  return { attackCostMultiplier: 1, speedMultiplier: 1 };
};
const rankedTribes = Array.from({ length: 64 }, (_, index) => ({
  rankKey: index,
  troops: () => 1000 - index,
  numTilesOwned: () => index + 1,
  units: () => {
    tribeStructureReads.set(index, (tribeStructureReads.get(index) || 0) + 1);
    return index % 3 === 0 ? [{ type: () => "City" }] : [];
  },
}));
const rankedTribeKeys = Array.from(tribeRankingBehavior.rankBotsForAttack(rankedTribes)).map(
  (bot) => bot.rankKey,
);
const expectedTribeKeys = rankedTribes
  .slice()
  .sort((left, right) => {
    const leftHasStructures = left.rankKey % 3 === 0;
    const rightHasStructures = right.rankKey % 3 === 0;
    if (leftHasStructures !== rightHasStructures) return leftHasStructures ? -1 : 1;
    return (
      left.troops() / left.numTilesOwned() - right.troops() / right.numTilesOwned() ||
      left.rankKey - right.rankKey
    );
  })
  .map((bot) => bot.rankKey);
assert.deepEqual(
  rankedTribeKeys,
  expectedTribeKeys,
  "tribe ranking preserves structure-first and effective-difficulty order",
);
assert.equal(
  [...tribeStructureReads.values()].reduce((sum, count) => sum + count, 0),
  rankedTribes.length,
  "tribe ranking reads each candidate structure roster once instead of from sort comparisons",
);
assert.equal(
  [...tribeProfileReads.values()].reduce((sum, count) => sum + count, 0),
  rankedTribes.length,
  "tribe ranking computes each defense profile once instead of from sort comparisons",
);

const teammateAssistBehavior = Object.create(sandbox.AttackBehavior.prototype);
const teammateAssistTarget = {
  isPlayer: () => true,
  smallID: () => 3,
};
const teammate = {
  smallID: () => 2,
  isAlive: () => true,
  targets: () => [teammateAssistTarget],
};
const teammateAssistMe = {
  smallID: () => 1,
  isFriendly: (other) => other === teammate,
  isOnSameTeam: (other) => other === teammate,
  relation: () => -100,
  updateRelation: () => {},
};
const assistedTargets = [];
teammateAssistBehavior.player = teammateAssistMe;
teammateAssistBehavior.game = {
  config: () => ({ disableAlliances: () => true }),
  players: () => [teammateAssistMe, teammate],
};
teammateAssistBehavior.emojiBehavior = { sendEmoji: () => {} };
teammateAssistBehavior.sendAttack = async (target) => {
  assistedTargets.push(target);
  return true;
};
assert.equal(
  await teammateAssistBehavior.assistAllies(),
  true,
  "a permanent teammate's marked enemy is assisted even when alliances are disabled",
);
assert.deepEqual(assistedTargets, [teammateAssistTarget]);

process.stdout.write("attack intent accounting tests passed\n");
