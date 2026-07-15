import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const earlyGamePath = path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js");
const earlyGameSource = fs.readFileSync(earlyGamePath, "utf8");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const UNIT = { TransportShip: "Transport" };
const troopEmissions = [];
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
  performance: { now: () => 10000 },
  discoverCtors: () => ({
    attack: "attack",
    boat: "boat",
    donateTroops: "donateTroops",
  }),
  getEventBus: () => null,
  emitIntent: (_ctor, _recipient, troops) => {
    troopEmissions.push(troops);
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
  state: {
    settings: { winFixes: true, features: { donate: true, boat: true } },
    stats: {},
  },
};

vm.runInNewContext(earlyGameSource, sandbox, { filename: earlyGamePath });
vm.runInNewContext(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});

let tick = 0;
let ownTroops = 100000;
const outgoing = [];
const me = {
  troops: () => ownTroops,
  smallID: () => 1,
  type: () => "Human",
  units: () => [],
  borderTiles: () => new Set([1]),
  outgoingAttacks: () => outgoing,
};
const game = {
  ticks: () => tick,
  config: () => ({ maxTroops: () => 100000 }),
};
const target = {
  isPlayer: () => true,
  smallID: () => 2,
  id: () => "tribe-2",
};

const behavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});

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

// TerraNullius is free land: a capacity increase must not move the opening
// reserve beyond the current army and make expansion wait for its own growth.
// Keep the acceleration reserve while it is affordable, use the calculated
// one-tile attackLogic loss for normal land attacks, and allow only the first
// opening burst to commit the configured fraction of the live army.
const terraNullius = { isPlayer: () => false, id: () => "TerraNullius" };
const expandingGame = {
  ticks: () => tick,
  neighbors: () => [2],
  isLand: () => true,
  hasOwner: () => false,
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
  "TerraNullius uses a soft reserve ceiling derived from the safe opening commit",
);
const terraNulliusEmissionCount = troopEmissions.length;
assert.equal(
  expandingBehavior.sendLandAttack(terraNullius),
  true,
  "free land remains actionable after maxTroops increases",
);
assert.equal(troopEmissions.length, terraNulliusEmissionCount + 1);
assert.equal(
  troopEmissions.at(-1),
  2,
  "the opening TerraNullius land commit uses only the calculated one-tile cost",
);

const openingBehavior = new sandbox.AttackBehavior({}, expandingGame, me, 0.5, 0.3, 0.1, {}, {});
const openingEmissionCount = troopEmissions.length;
assert.equal(
  await openingBehavior.forceSendAttack(terraNullius),
  true,
  "the first TerraNullius opening burst is not blocked by the capacity-derived reserve",
);
assert.equal(troopEmissions.length, openingEmissionCount + 1);
assert.equal(troopEmissions.at(-1), 15000);

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

// Tribe attacks must be all-or-nothing: if the available force cannot meet the
// combat policy's minimum, do not emit a partial attack that merely weakens the
// tribe and leaves it blocking expansion.
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
  false,
  "an underfunded tribe assault is deferred rather than sent short",
);
assert.equal(
  troopEmissions.length,
  underfundedEmissionCount,
  "deferring an underfunded tribe assault emits no partial attack",
);
sandbox.currentDifficulty = () => "Impossible";

// Different tribes may be launched in the same decision. The ordinary intent
// guard still blocks a second unqualified attack, while the explicit parallel
// tribal path reuses the pending intent as the next attack's budget.
const parallelMe = {
  ...me,
  sharesBorderWith: () => true,
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
  false,
  "the ordinary intent guard still blocks unrelated attacks",
);
assert.equal(
  await parallelBehavior.sendAttack(parallelTribeB, false, null, null, false, true),
  true,
  "the explicit parallel tribal path launches a second tribe",
);
assert.equal(
  troopEmissions.length,
  parallelEmissionCount + 2,
  "two different tribe assaults are emitted in one decision",
);
assert.equal(
  parallelBehavior.getPendingOutboundAttackTroops(),
  8000,
  "parallel tribal intents are both reserved exactly once",
);
assert.deepEqual(
  [...parallelBehavior.getActiveTribeAttackTargetKeys()].sort(),
  ["21", "22"],
  "active tribal targets are tracked independently",
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
outgoing.length = 0;
tick = 21;
const botParallelEmissionCount = troopEmissions.length;
assert.equal(await botParallelBehavior.attackBots(), true);
assert.equal(
  troopEmissions.length,
  botParallelEmissionCount + 2,
  "the general tribe attack pass also emits multiple captures",
);

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
tick = 9;
ownTroops = 100000;

// A teammate donation must use the same hard reserve, not the obsolete 45%
// maxTroops keep line or the obsolete 20% chunk gate.
let donorTroops = 35000;
let donorBorderTiles = new Set();
const donor = {
  troops: () => donorTroops,
  smallID: () => 11,
  isAlive: () => true,
  isOnSameTeam: (player) => [11, 12, 14].includes(player?.smallID?.()),
  borderTiles: () => donorBorderTiles,
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
  25005,
  "donations may release the surplus above the calculated acceleration reserve",
);

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

console.log("attack intent accounting tests passed");
