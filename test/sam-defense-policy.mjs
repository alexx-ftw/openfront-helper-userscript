import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
  Warship: "Warship",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

const state = {
  settings: { winFixes: true, buildStructures: {} },
  stats: { builds: 0 },
};
const sentBuilds = [];
const sandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation", Tribe: "Tribe" },
  state,
  currentDifficulty: () => Difficulty.Impossible,
  isLegendaryDifficulty: (difficulty = Difficulty.Impossible) =>
    difficulty === Difficulty.Legendary,
  isAtLeastHardDifficulty: (difficulty) =>
    difficulty === Difficulty.Hard ||
    difficulty === Difficulty.Impossible ||
    difficulty === Difficulty.Legendary,
  getBuildMenu: () => ({
    sendBuildOrUpgrade: (buildable) => sentBuilds.push(buildable),
  }),
  sendAutoBotBuildOrUpgrade: (menu, buildable, tile) => {
    menu.sendBuildOrUpgrade(buildable, tile);
    return true;
  },
  autoBotBuildAllowed: () => true,
  randTerritoryTileArray: (_random, _game, _player, count) =>
    Array.from({ length: count }, (_, index) => 10_000 + index),
  setLastAction: () => {},
  tr: (value) => value,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(
  `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read(
    "engine/ingame/auto-bot/structureBehavior.js",
  )}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "sam-defense-policy.vm.js" },
);

assert.equal(
  typeof sandbox.legendaryMaxEnemySamCapacity,
  "function",
  "Planner exposes the hostile SAM-capacity parity helper",
);
const activeMissileCapacityFallbackBehavior = Object.create(sandbox.__StructureBehavior.prototype);
activeMissileCapacityFallbackBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
activeMissileCapacityFallbackBehavior.missileDefenseSignalSnapshot = () => ({
  hasActiveHostileMissile: true,
});
activeMissileCapacityFallbackBehavior.activeMissileDefenseContext = () => ({});
activeMissileCapacityFallbackBehavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: false,
});
activeMissileCapacityFallbackBehavior.uncoveredActiveMirvDemands = () => [];
activeMissileCapacityFallbackBehavior.maybeUpgradeMissileDefenseSam = async () => false;
activeMissileCapacityFallbackBehavior.activeMissilePendingSamImproves = () => false;
activeMissileCapacityFallbackBehavior.maybeSpawnStructure = async () => false;
activeMissileCapacityFallbackBehavior.hydrogenSamProtectionPlan = () => ({
  currentLevel: 2,
  targetLevel: 5,
});
let activeMissileCapacityUpgradeAttempts = 0;
activeMissileCapacityFallbackBehavior.maybeUpgradePlannedSam = async (plan) => {
  activeMissileCapacityUpgradeAttempts++;
  return plan.targetLevel === 5;
};
assert.equal(
  await activeMissileCapacityFallbackBehavior.handleActiveMissileSamMaximumPriority(),
  true,
  "an unsolved active missile falls through to the level-five external-Silo SAM upgrade",
);
assert.equal(
  activeMissileCapacityUpgradeAttempts,
  1,
  "active-missile handling attempts the capacity upgrade exactly once",
);
const emergencyTileCacheBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let emergencyTileEvaluationCalls = 0;
emergencyTileCacheBehavior.activeMissileSamConstructionImproves = () => {
  emergencyTileEvaluationCalls++;
  return true;
};
emergencyTileCacheBehavior.legendaryTileInsideUninterceptedBlast = () => false;
const emergencyTileSnapshot = {
  samDefense: true,
  incrementalSamDefense: true,
  context: {},
  evaluation: {},
  active: true,
};
assert.equal(
  emergencyTileCacheBehavior.structureEmergencyTileAllowed(
    42,
    UNIT.SAMLauncher,
    emergencyTileSnapshot,
  ),
  true,
);
assert.equal(
  emergencyTileCacheBehavior.structureEmergencyTileAllowed(
    42,
    UNIT.SAMLauncher,
    emergencyTileSnapshot,
  ),
  true,
  "revisiting an emergency SAM tile keeps its prior feasibility result",
);
assert.equal(
  emergencyTileEvaluationCalls,
  1,
  "one immutable emergency snapshot evaluates each SAM tile once",
);
assert.equal(
  sandbox.legendaryMaxEnemySamCapacity([[3, 1], [2, 2, 2], []]),
  6,
  "Parity uses the largest per-enemy sum of SAM levels, not the global sum",
);
assert.equal(
  sandbox.legendaryMaxEnemySamCapacity([[{ level: 4 }, { level: 1 }], [2]]),
  5,
  "Parity accepts level records as well as numeric level snapshots",
);

const makeUnit = (id, level, { underConstruction = false } = {}) => ({
  id: () => id,
  level: () => level,
  tile: () => id,
  isUnderConstruction: () => underConstruction,
  isActive: () => true,
});

const own = {
  smallID: () => 1,
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  isOnSameTeam: (other) => other?.smallID?.() === 5,
  gold: () => 5_000_000n,
  troops: () => 100_000,
  incomingAttacks: () => [],
  silos: [makeUnit(101, 2)],
  sams: [],
};
const enemyA = {
  smallID: () => 2,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 999_999n,
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(201, 3), makeUnit(202, 1)] : []),
};
const enemyB = {
  smallID: () => 3,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 900_000n,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(301, 2), makeUnit(302, 2), makeUnit(303, 2)] : [],
};
const enemyC = {
  smallID: () => 4,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 900_000n,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(401, 9, { underConstruction: true })] : [],
};
let enemyTeamSamLevel = 12;
const enemyTeam = {
  smallID: () => 5,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [makeUnit(501, enemyTeamSamLevel)];
    if (type === UNIT.MissileSilo) return [makeUnit(502, 1)];
    return [];
  },
};
const enemySilos = {
  smallID: () => 6,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 800_000n,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(601, 4), makeUnit(602, 2)] : []),
};
const enemySiloUnderConstruction = {
  smallID: () => 7,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 700_000n,
  units: (type) =>
    type === UNIT.MissileSilo ? [makeUnit(701, 99, { underConstruction: true })] : [],
};
const enemySingleLevelOneSilo = {
  smallID: () => 8,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(801, 1)] : []),
};
const enemySingleLevelTwoSilo = {
  smallID: () => 81,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(811, 2)] : []),
};
const enemyTwoLevelOneSilos = {
  smallID: () => 9,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(901, 1), makeUnit(902, 1)] : []),
};
own.units = (type) => {
  if (type === UNIT.MissileSilo) return own.silos;
  if (type === UNIT.SAMLauncher) return own.sams;
  return [];
};
let samDisabled = false;

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
behavior.player = own;
// Most of this file exercises the post-launch defensive planner. Dedicated
// launch-gate coverage below starts from the real locked state.
behavior._hostileMissileLaunchObserved = true;
behavior.game = {
  players: () => [own, enemyA, enemyB, enemyC, enemyTeam, enemySilos, enemySiloUnderConstruction],
  config: () => ({
    isUnitDisabled: (type) => type === UNIT.SAMLauncher && samDisabled,
    gameConfig: () => ({ gameMode: "FFA" }),
    samRange: (level) => 50 * Number(level || 1),
  }),
};

const initialSiloBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let initialSiloSpawnType = null;
let initialSiloSpawnOptions = null;
initialSiloBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
initialSiloBehavior.ownedLevels = (type) => (type === UNIT.City ? 1 : 0);
initialSiloBehavior.getConstructionCost = () => 1_000_000n;
initialSiloBehavior.spendableConstructionGold = () => 5_000_000n;
initialSiloBehavior.maybeSpawnStructure = async (type, options) => {
  initialSiloSpawnType = type;
  initialSiloSpawnOptions = options;
  return true;
};
assert.equal(
  await initialSiloBehavior.handleInitialMissileSilo(false),
  true,
  "an affordable first Silo is built without waiting for an enemy SAM network",
);
assert.equal(
  initialSiloSpawnType,
  UNIT.MissileSilo,
  "the initial nuclear policy emits a Missile Silo rather than another economic structure",
);
assert.equal(
  initialSiloSpawnOptions?.ignoreEconomicReserve,
  true,
  "the initial Silo bypasses only the ongoing economic reserve that would otherwise make its first-launch policy unreachable",
);
initialSiloSpawnType = null;
initialSiloBehavior.ownedLevels = () => 0;
assert.equal(
  await initialSiloBehavior.handleInitialMissileSilo(false),
  false,
  "the initial Silo waits until the basic City economy exists",
);
assert.equal(initialSiloSpawnType, null);

behavior.placementsCount = 0;
assert.equal(
  behavior.hasPriorStructureForDefensePost(),
  true,
  "an emergency-built Silo satisfies the prior-structure Defense Post gate even when the ordinary placement counter is zero",
);
const priorSilosForDefensePostGate = own.silos;
own.silos = [];
assert.equal(
  behavior.hasPriorStructureForDefensePost(),
  false,
  "Defense Posts remain unavailable as the literal first structure",
);
own.silos = priorSilosForDefensePostGate;

const originalDifficultyForDefensePost = sandbox.currentDifficulty;
const originalOwnTroopsForDefensePost = own.troops;
const originalOwnIncomingForDefensePost = own.incomingAttacks;
sandbox.currentDifficulty = () => Difficulty.Legendary;
own.troops = () => 1000;
own.incomingAttacks = () => [{ troops: () => 400 }];
behavior.isLandAttack = () => true;
assert.equal(
  behavior.defensePostNeeded(),
  true,
  "Legendary treats a meaningful 40% land assault as requiring a Defense Post",
);
own.incomingAttacks = () => [{ troops: () => 300 }];
assert.equal(
  behavior.defensePostNeeded(),
  false,
  "a sub-35% probe does not trigger Defense Post construction",
);
own.incomingAttacks = () => [
  {
    troops: () => 150,
    attacker: () => ({ type: () => sandbox.PlayerType.Nation }),
  },
];
assert.equal(
  behavior.defensePostNeeded(),
  true,
  "a 15% Nation land push starts the first Defense Post before it becomes a siege",
);
sandbox.currentDifficulty = originalDifficultyForDefensePost;
own.troops = originalOwnTroopsForDefensePost;
own.incomingAttacks = originalOwnIncomingForDefensePost;
delete behavior.isLandAttack;

const preemptiveDefensePostBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let preemptiveIncomingAttacks = [
  {
    troops: () => 150,
    attacker: () => ({ type: () => sandbox.PlayerType.Nation }),
  },
];
preemptiveDefensePostBehavior.player = {
  troops: () => 1000,
  incomingAttacks: () => preemptiveIncomingAttacks,
};
preemptiveDefensePostBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
preemptiveDefensePostBehavior.hasPriorStructureForDefensePost = () => true;
preemptiveDefensePostBehavior.isLandAttack = () => true;
preemptiveDefensePostBehavior.getConstructionCost = () => 50_000n;
preemptiveDefensePostBehavior.defensiveConstructionPressure = () => null;
const preemptivePostPressure = preemptiveDefensePostBehavior.preemptiveDefensePostPressure();
assert.equal(
  preemptivePostPressure?.type,
  UNIT.DefensePost,
  "a 15% Nation land attack reserves the next Defense Post before it becomes an active siege",
);
assert.equal(preemptivePostPressure?.cost, 50_000n);
assert.equal(
  preemptiveDefensePostBehavior.defensiveConstructionReserve(),
  50_000n,
  "the early post reserve is added to offensive-defense budgeting",
);
preemptiveDefensePostBehavior.economicConstructionPressure = () => null;
preemptiveDefensePostBehavior.spendableConstructionGold = () => 1_000_000n;
preemptiveDefensePostBehavior.getConstructionCost = () => 1_000_000n;
assert.equal(
  preemptiveDefensePostBehavior.shouldReserveEconomicGrowthForOffense(UNIT.MissileSilo),
  true,
  "a Silo cannot spend the margin needed for the imminent Defense Post",
);
assert.equal(
  preemptiveDefensePostBehavior.shouldReserveEconomicGrowthForOffense(UNIT.City),
  false,
  "the preemptive Defense Post reserve never blocks productive City construction",
);
preemptiveIncomingAttacks = [
  {
    troops: () => 300,
    attacker: () => ({ type: () => sandbox.PlayerType.Tribe }),
  },
];
assert.equal(
  preemptiveDefensePostBehavior.preemptiveDefensePostPressure(),
  null,
  "a much larger Tribe attack cannot freeze the opening economy's offensive budget",
);

const defensePostLivenessBehavior = Object.create(sandbox.__StructureBehavior.prototype);
defensePostLivenessBehavior.handleHostileSiloSamMaximumPriority = async () => null;
defensePostLivenessBehavior.prioritizeMaritimeInvasionDefense = async () => false;
defensePostLivenessBehavior.maybeUpgradeMissileDefenseSam = async () => false;
defensePostLivenessBehavior.hasPriorStructureForDefensePost = () => true;
defensePostLivenessBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
defensePostLivenessBehavior.tryBuildDefensePost = async () => false;
defensePostLivenessBehavior.defensePostNeeded = () => true;
defensePostLivenessBehavior.maybeEnsureHydrogenStructureCoverage = async () => false;
defensePostLivenessBehavior.maybeUpgradeHydrogenProtectionSam = async () => false;
defensePostLivenessBehavior.maybeUpgradeSiloForNukeDemand = async () => false;
defensePostLivenessBehavior.maybeSpawnHostileSiloSam = async () => false;
defensePostLivenessBehavior.maybeUpgradeSamForSiloParity = async () => false;
defensePostLivenessBehavior.samLevelParityGap = () => 0;
defensePostLivenessBehavior.isInPostSaveUpBlockedPhase = () => false;
defensePostLivenessBehavior.placementsCount = 0;
let productiveConstructionCalls = 0;
defensePostLivenessBehavior.doHandleStructures = async () => {
  productiveConstructionCalls++;
  return true;
};
defensePostLivenessBehavior.canAffordDefensePost = () => true;
assert.equal(
  await defensePostLivenessBehavior.handleStructures(),
  true,
  "An affordable Defense Post with no legal tile cannot starve productive construction",
);
assert.equal(
  productiveConstructionCalls,
  1,
  "The ordinary construction planner runs after an affordable Defense Post placement failure",
);
defensePostLivenessBehavior.canAffordDefensePost = () => false;
assert.equal(
  await defensePostLivenessBehavior.handleStructures(),
  false,
  "An unaffordable urgent Defense Post still reserves its construction slot",
);
assert.equal(
  productiveConstructionCalls,
  1,
  "The bot does not spend the Defense Post savings on a lower-priority structure",
);

const hostileSiloMaximumPriorityBehavior = Object.create(sandbox.__StructureBehavior.prototype);
hostileSiloMaximumPriorityBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
hostileSiloMaximumPriorityBehavior.hasPlacedSiloOnMap = () => true;
hostileSiloMaximumPriorityBehavior.shouldBuildSiloTriggeredSam = () => true;
hostileSiloMaximumPriorityBehavior.shouldReserveHostileSiloSamBudget = () => true;
let maximumPrioritySamResult = false;
let maximumPrioritySamAttempts = 0;
let lowerPriorityConstructionCalls = 0;
hostileSiloMaximumPriorityBehavior.maybeSpawnHostileSiloSam = async () => {
  maximumPrioritySamAttempts++;
  return maximumPrioritySamResult;
};
hostileSiloMaximumPriorityBehavior.handleImmediateStructureDefense = async () => {
  lowerPriorityConstructionCalls++;
  return true;
};
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  false,
  "A failed hostile-Silo SAM placement reserves the entire construction slot",
);
assert.equal(maximumPrioritySamAttempts, 1);
assert.equal(
  lowerPriorityConstructionCalls,
  0,
  "No economy, naval, Defense Post, or offensive construction runs before the required SAM",
);
maximumPrioritySamResult = true;
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  true,
  "A successful maximum-priority SAM placement consumes the construction slot",
);
assert.equal(maximumPrioritySamAttempts, 2);
assert.equal(lowerPriorityConstructionCalls, 0);

const preemptiveHostileGoldBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let preemptiveHostileGoldSamCalls = 0;
preemptiveHostileGoldBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
preemptiveHostileGoldBehavior.hasPlacedSiloOnMap = () => false;
preemptiveHostileGoldBehavior.shouldBuildHostileSiloSam = () => true;
preemptiveHostileGoldBehavior.shouldBuildSiloTriggeredSam = () => false;
preemptiveHostileGoldBehavior.maybeSpawnHostileSiloSam = async () => {
  preemptiveHostileGoldSamCalls++;
  return true;
};
assert.equal(
  await preemptiveHostileGoldBehavior.handleHostileSiloSamMaximumPriority(),
  true,
  "hostile silo funding starts our first SAM before the enemy launcher appears",
);
assert.equal(preemptiveHostileGoldSamCalls, 1);

const preemptiveSamReserveBehavior = Object.create(sandbox.__StructureBehavior.prototype);
preemptiveSamReserveBehavior.safeConstructionCost = () => 1_500_000n;
preemptiveSamReserveBehavior.spendableConstructionGold = () => 374_999n;
assert.equal(
  preemptiveSamReserveBehavior.shouldReserveHostileSiloSamBudget(),
  false,
  "A poor nation keeps productive construction available while it is far from its first SAM",
);
preemptiveSamReserveBehavior.spendableConstructionGold = () => 375_000n;
assert.equal(
  preemptiveSamReserveBehavior.shouldReserveHostileSiloSamBudget(),
  true,
  "Once 25% of the first SAM is saved, hostile-Silo defense reserves the remaining budget",
);

const poorPreemptiveHostileGoldBehavior = Object.create(sandbox.__StructureBehavior.prototype);
poorPreemptiveHostileGoldBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
poorPreemptiveHostileGoldBehavior.hasPlacedSiloOnMap = () => false;
poorPreemptiveHostileGoldBehavior.shouldBuildHostileSiloSam = () => true;
poorPreemptiveHostileGoldBehavior.shouldBuildSiloTriggeredSam = () => false;
poorPreemptiveHostileGoldBehavior.maybeSpawnHostileSiloSam = async () => false;
poorPreemptiveHostileGoldBehavior.shouldReserveHostileSiloSamBudget = () => false;
assert.equal(
  await poorPreemptiveHostileGoldBehavior.handleHostileSiloSamMaximumPriority(),
  null,
  "An unaffordable SAM threat does not starve an early economy before the reserve threshold",
);
hostileSiloMaximumPriorityBehavior.shouldBuildSiloTriggeredSam = () => false;
hostileSiloMaximumPriorityBehavior.hydrogenSamProtectionPlan = () => ({
  currentLevel: 1,
  targetLevel: 2,
});
let maximumPrioritySamUpgradeAttempts = 0;
hostileSiloMaximumPriorityBehavior.maybeUpgradePlannedSam = async () => {
  maximumPrioritySamUpgradeAttempts++;
  return true;
};
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  true,
  "A level-1 SAM upgrade for H-bomb defense remains above all lower-priority construction",
);
assert.equal(maximumPrioritySamUpgradeAttempts, 1);
assert.equal(lowerPriorityConstructionCalls, 0);
hostileSiloMaximumPriorityBehavior.hasPlacedSiloOnMap = () => false;
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleHostileSiloSamMaximumPriority(),
  null,
  "Enemy gold without a placed hostile Silo does not hard-reserve construction",
);
assert.equal(maximumPrioritySamAttempts, 2);

assert.equal(
  typeof behavior.enemySamCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile SAM parity target",
);
assert.equal(
  typeof behavior.hasHostileReachedSiloGoldThreshold,
  "function",
  "Structure behavior exposes the hostile silo-gold threshold check",
);
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "All hostile players below 1M gold keep the economy priority active",
);
assert.equal(
  behavior.shouldPrioritizeEconomicGrowth(),
  true,
  "Economic growth is prioritized while no hostile can afford a silo",
);
assert.equal(
  behavior.economicConstructionPressure()?.type,
  UNIT.Factory,
  "The next affordable productive structure remains visible to the policy",
);
const originalOwnGoldForPressure = own.gold;
own.gold = () => 1_000n;
assert.equal(
  behavior.economicConstructionPressure(),
  null,
  "The economy pressure clears when no productive structure is affordable",
);
own.gold = originalOwnGoldForPressure;
assert.equal(
  typeof behavior.hasHostileSiloThreat,
  "function",
  "Structure behavior exposes the hostile silo threat check",
);
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "A built hostile silo triggers the mandatory SAM response",
);
assert.equal(
  behavior.hasBuiltHostileSiloThreat(),
  true,
  "The hard SAM priority recognizes a completed hostile Silo",
);
const originalPlayersForSiloLevelSum = behavior.game.players;
behavior.game.players = () => [own, enemySiloUnderConstruction];
assert.equal(
  behavior.hasBuiltHostileSiloThreat(),
  false,
  "An uncompleted hostile Silo has no usable missile capacity yet",
);
assert.equal(
  behavior.hasPlacedSiloOnMap(),
  true,
  "The first hostile Silo construction immediately activates SAM priority",
);
behavior.game.players = () => [own, enemyTeam];
assert.equal(
  behavior.hasPlacedSiloOnMap(),
  true,
  "The first allied Silo also immediately activates our SAM priority",
);
assert.equal(
  behavior.shouldBuildSiloTriggeredSam(),
  true,
  "An allied Silo makes an otherwise SAM-less bot request its first interceptor immediately",
);
const originalEnemyTeamUnitsForExternalSilo = enemyTeam.units;
enemyTeam.units = (type) => (type === UNIT.MissileSilo ? [makeUnit(503, 2)] : []);
assert.equal(
  behavior.externalSiloLevelSumTarget(),
  2,
  "An allied level-2 Silo contributes its real capacity to our SAM target",
);
assert.equal(
  behavior.hasBuiltExternalSiloThreat(),
  true,
  "A completed allied Silo permits the mandatory defensive upgrade path",
);
enemyTeam.units = originalEnemyTeamUnitsForExternalSilo;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
assert.equal(
  behavior.hostileSiloLevelSumAtLeast(),
  true,
  "One completed level-1 hostile Silo is enough to enable H-bomb SAM protection",
);
behavior.game.players = () => [own, enemyTwoLevelOneSilos];
assert.equal(
  behavior.hostileSiloLevelSumAtLeast(),
  true,
  "Two hostile level-1 Silos remain inside the H-bomb protection policy",
);
behavior.game.players = () => [own, enemySilos, enemyTwoLevelOneSilos];
assert.equal(
  behavior.hostileSiloLevelSumTarget(),
  6,
  "The SAM target uses the greatest single enemy Silo-level-sum",
);
behavior.game.players = originalPlayersForSiloLevelSum;
const originalOwnGoldForSiloReserve = own.gold;
own.gold = () => 3_000_000n;
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 10, false),
  false,
  "Silo construction leaves room for the next economy and SAM actions",
);
own.gold = originalOwnGoldForSiloReserve;
enemyB.gold = () => 1_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  true,
  "The silo-gold gate opens at exactly 1M hostile gold",
);
assert.equal(
  behavior.shouldPrioritizeEconomicGrowth(),
  true,
  "Economic growth remains active after the hostile silo threshold when it is affordable",
);

const borderTroopEnemy = {
  smallID: () => 21,
  isPlayer: () => true,
  isAlive: () => true,
};
const remoteTroopEnemy = {
  smallID: () => 22,
  isPlayer: () => true,
  isAlive: () => true,
};
const friendlyBorderTroopPlayer = {
  smallID: () => 23,
  isPlayer: () => true,
  isAlive: () => true,
};
const borderTroopOwner = {
  smallID: () => 20,
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  isOnSameTeam: () => false,
  sharesBorderWith: (other) => other === borderTroopEnemy || other === friendlyBorderTroopPlayer,
};
let borderTroopTick = 1;
let borderTroopPlayers = [borderTroopOwner, borderTroopEnemy, remoteTroopEnemy];
const borderTroopMax = new Map([
  [borderTroopOwner, 1_000],
  [borderTroopEnemy, 1_200],
  [remoteTroopEnemy, 5_000],
  [friendlyBorderTroopPlayer, 5_000],
]);
const borderTroopBehavior = Object.create(sandbox.__StructureBehavior.prototype);
borderTroopBehavior.player = borderTroopOwner;
borderTroopBehavior.game = {
  ticks: () => borderTroopTick,
  players: () => borderTroopPlayers,
  config: () => ({
    maxTroops: (player) => borderTroopMax.get(player) ?? 0,
  }),
};
assert.equal(
  borderTroopBehavior.hasBorderingHostileMaxTroopAdvantage(),
  true,
  "A hostile bordering player with a larger max army activates the economic threat signal",
);
let fastBorderNeighborScans = 0;
const fastBorderOwner = {
  ...borderTroopOwner,
  borderTiles: () => new Set([1, 2]),
  sharesBorderWith: () => {
    throw new Error("the indexed border-owner path must avoid pairwise border scans");
  },
};
const fastBorderBehavior = Object.create(sandbox.__StructureBehavior.prototype);
fastBorderBehavior.player = fastBorderOwner;
const fastBorderMaxTroops = (player) => {
  if (player === fastBorderOwner) return 1_000;
  return borderTroopMax.get(player) ?? 0;
};
fastBorderBehavior.game = {
  ticks: () => 1,
  players: () => [fastBorderOwner, borderTroopEnemy, remoteTroopEnemy],
  config: () => ({
    maxTroops: fastBorderMaxTroops,
  }),
  neighbors: (tile) => {
    fastBorderNeighborScans++;
    return tile === 1 ? [10, 11] : [12];
  },
  isLand: () => true,
  ownerID: (tile) => {
    if (tile === 10) return 21;
    if (tile === 12) return 22;
    return null;
  },
};
assert.equal(
  fastBorderBehavior.hasBorderingHostileMaxTroopAdvantage(),
  true,
  "one border-owner scan preserves the stronger-hostile economic threat signal",
);
assert.equal(
  fastBorderNeighborScans,
  2,
  "the fast path scans each owned border tile once instead of once per hostile",
);
assert.equal(
  borderTroopBehavior.shouldPrioritizeEconomicGrowth(),
  true,
  "The bordering max-army signal prioritizes economic growth",
);
borderTroopMax.set(borderTroopEnemy, 900);
borderTroopTick = 2;
assert.equal(
  borderTroopBehavior.hasBorderingHostileMaxTroopAdvantage(),
  false,
  "A stronger non-border enemy does not activate the city priority",
);
borderTroopPlayers = [borderTroopOwner, friendlyBorderTroopPlayer];
borderTroopOwner.isFriendly = (other) => other === friendlyBorderTroopPlayer;
borderTroopTick = 3;
assert.equal(
  borderTroopBehavior.hasBorderingHostileMaxTroopAdvantage(),
  false,
  "A stronger allied border player is not treated as an enemy for city priority",
);
const borderCityAttemptOrder = [];
borderTroopBehavior.shouldBuildStructure = (type) => type === UNIT.City || type === UNIT.Factory;
borderTroopBehavior.maybeSpawnStructure = async (type) => {
  borderCityAttemptOrder.push(type);
  return type === UNIT.City;
};
assert.equal(
  await borderTroopBehavior.maybePrioritizeEconomicGrowth({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    prioritizeCityForBorderThreat: true,
  }),
  true,
  "Border max-army pressure builds an economic structure",
);
assert.deepEqual(
  borderCityAttemptOrder,
  [UNIT.City],
  "Border max-army pressure attempts a City before other economic structures",
);
assert.equal(
  behavior.enemySamCapacityParityTarget(),
  6,
  "Structure behavior selects the strongest hostile SAM stack",
);
assert.equal(behavior.missileSiloParityGap(), 4, "Silo parity reports the missing sum of levels");
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 0, false),
  true,
  "Silo construction remains eligible beyond the ordinary three-silo cap when parity is missing",
);
enemyB.gold = () => 999_999n;
enemyA.isAlive = () => false;
enemyA.gold = () => 2_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "Dead hostile players do not open the silo-gold gate",
);
enemyA.isAlive = () => true;
enemyA.gold = () => 999_999n;
const originalPlayersForSiloGoldThreshold = behavior.game.players;
behavior.game.players = () => [own, enemyA, enemyB];
const originalEnemySilosUnits = enemySilos.units;
enemySilos.units = () => [];
enemyB.gold = () => 500_000n;
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "The mandatory SAM trigger opens while a hostile is still saving for a Silo",
);
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
behavior._hostileSiloCapacitySnapshotTick = null;
behavior._hostileSiloCapacitySnapshot = null;
enemyB.gold = () => 499_999n;
enemyA.gold = () => 499_999n;
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
assert.equal(
  behavior.hasHostileSiloThreat(),
  false,
  "Gold below the preemptive Silo-funding threshold does not trigger the mandatory SAM without a built silo",
);
behavior.game.players = originalPlayersForSiloGoldThreshold;
enemySilos.units = originalEnemySilosUnits;
enemyB.gold = () => 999_999n;
const originalOwnIsFriendly = own.isFriendly;
const originalEnemySilosGold = enemySilos.gold;
own.isFriendly = (other) => other === enemySilos;
enemySilos.gold = () => 2_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "A friendly player with 2M gold does not open the hostile silo-gold gate",
);
own.isFriendly = originalOwnIsFriendly;
enemySilos.gold = originalEnemySilosGold;
const originalShouldBuildStructure = behavior.shouldBuildStructure;
const originalMaybeSpawnStructure = behavior.maybeSpawnStructure;
const economicAttemptOrder = [];
behavior.shouldBuildStructure = (type) => type === UNIT.Port || type === UNIT.Factory;
behavior.maybeSpawnStructure = async (type) => {
  economicAttemptOrder.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await behavior.maybePrioritizeEconomicGrowth({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
  }),
  true,
  "Economic priority builds when an eligible economic structure is available",
);
assert.deepEqual(
  economicAttemptOrder,
  [UNIT.Port, UNIT.Factory],
  "Economic priority attempts port and factory before falling through",
);
behavior.shouldBuildStructure = originalShouldBuildStructure;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const originalPerceivedCost = behavior.getPerceivedCost;
const originalOwnGold = own.gold;
const highGoldEconomicCalls = [];
behavior.getPerceivedCost = () => 1_000_000n;
own.gold = () => 9_000_000n;
behavior.maybeSpawnStructure = async (type) => {
  highGoldEconomicCalls.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "High-gold pressure requests an affordable economic structure after defensive priorities",
);
assert.deepEqual(
  highGoldEconomicCalls,
  [UNIT.City],
  "High-gold economic construction tries the city first and stops after a successful build",
);
behavior.getPerceivedCost = originalPerceivedCost;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
own.gold = originalOwnGold;

const originalConstructionCostForLowGold = behavior.getConstructionCost;
const lowGoldEconomicCalls = [];
behavior.getConstructionCost = (type) => (type === UNIT.City ? 4_000_000n : 1_000_000n);
own.gold = () => 1_500_000n;
behavior.maybeSpawnStructure = async (type) => {
  lowGoldEconomicCalls.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "Economic fallback does not wait for 3M before using an affordable structure",
);
assert.deepEqual(
  lowGoldEconomicCalls,
  [UNIT.Factory],
  "Economic fallback skips an unaffordable City and chooses the affordable Factory",
);
behavior.getConstructionCost = originalConstructionCostForLowGold;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
own.gold = originalOwnGold;

own.gold = () => 4_000_000n;
assert.equal(
  behavior.getPerceivedCost(UNIT.City),
  behavior.cost(UNIT.City),
  "winFixes does not inflate City cost while waiting for a global weapon target",
);
assert.equal(
  behavior.getConstructionCost(UNIT.Factory),
  behavior.cost(UNIT.Factory),
  "winFixes does not inflate Factory cost while waiting for a global weapon target",
);
assert.equal(
  behavior.isInPostSaveUpBlockedPhase(),
  false,
  "winFixes never blocks all construction behind the faithful save-up phase",
);
own.gold = originalOwnGold;

const originalReserveForBudget = behavior.legendaryReserveGold;
const reserveBudgetCalls = [];
behavior.legendaryReserveGold = () => 25_000_000n;
own.gold = () => 20_000_000n;
assert.equal(
  behavior.spendableConstructionGold(),
  20_000_000n,
  "A MIRV reserve does not reduce the ordinary construction budget",
);
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.City),
  20_000_000n,
  "A MIRV reserve does not block a City",
);
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.SAMLauncher),
  20_000_000n,
  "A MIRV reserve does not block a SAM",
);
const existingSilosForReserve = own.silos;
own.silos = [];
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.MissileSilo),
  20_000_000n,
  "A nuclear war chest cannot block the first Silo needed to launch it",
);
own.silos = existingSilosForReserve;
assert.equal(
  behavior.availableGoldAfterReserve(UNIT.MissileSilo),
  0n,
  "A MIRV reserve still applies after a Silo already exists",
);
behavior.getPerceivedCost = () => 1_000_000n;
behavior.maybeSpawnStructure = async (type) => {
  reserveBudgetCalls.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "High-gold economic construction remains active while a MIRV reserve is set",
);
assert.deepEqual(
  reserveBudgetCalls,
  [UNIT.City],
  "The City path remains first under a MIRV reserve",
);
behavior.getPerceivedCost = originalPerceivedCost;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior.legendaryReserveGold = originalReserveForBudget;
own.gold = originalOwnGold;

let hostileAttemptTick = 1000;
behavior.game.ticks = () => hostileAttemptTick;
const hostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  hostileSamCalls.push(args);
  return true;
};
const preemptiveOwnSams = own.sams;
const preemptiveLaunchObserved = behavior._hostileMissileLaunchObserved;
own.sams = [];
behavior._hostileMissileLaunchObserved = false;
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  true,
  "A confirmed hostile Silo threat authorizes the first SAM before a missile launches",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A hostile silo threat requests one dedicated SAM",
);
assert.equal(
  hostileSamCalls.length,
  1,
  "A successful threat SAM request crosses the placement path once",
);
assert.deepEqual(
  hostileSamCalls.map(([type, options]) => [
    type,
    {
      allowPreemptiveSam: options.allowPreemptiveSam,
      useActualCost: options.useActualCost,
      forceNewStructure: options.forceNewStructure,
      prioritizeStructureCoverage: options.prioritizeStructureCoverage,
      probeLimit: options.probeLimit,
      probeTimeoutMs: options.probeTimeoutMs,
      parallelProbeCount: options.parallelProbeCount,
    },
  ]),
  [
    [
      UNIT.SAMLauncher,
      {
        allowPreemptiveSam: true,
        useActualCost: true,
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        probeLimit: 25,
        probeTimeoutMs: 2500,
        parallelProbeCount: 6,
      },
    ],
  ],
  "The dedicated SAM request forces a bounded coverage-ranked placement",
);
own.sams = preemptiveOwnSams;
behavior._hostileMissileLaunchObserved = preemptiveLaunchObserved;
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "The dedicated threat SAM is not repeated within the same game tick",
);
hostileAttemptTick++;
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A remaining hostile Silo site gap allows another SAM on a later tick",
);
assert.equal(
  hostileSamCalls.length,
  2,
  "SAM construction is not permanently disabled after the first successful build",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamAttemptTick = null;
const failedHostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  failedHostileSamCalls.push(args);
  return false;
};
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A failed dedicated SAM request returns without claiming that the SAM was built",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A failed dedicated SAM request is not repeated within the same game tick",
);
assert.equal(
  failedHostileSamCalls.length,
  1,
  "A failed dedicated SAM request crosses the placement path only once per tick",
);
hostileAttemptTick++;
await behavior.maybeSpawnHostileSiloSam();
assert.equal(
  failedHostileSamCalls.length,
  1,
  "A failed dedicated SAM request is not retried during its short placement backoff",
);
hostileAttemptTick += 9;
await behavior.maybeSpawnHostileSiloSam();
assert.equal(
  failedHostileSamCalls.length,
  2,
  "A failed dedicated SAM request is retried after the placement backoff expires",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;

const originalReservedSlotMaybeUpgradeLegendarySam = behavior.maybeUpgradeLegendarySam;
const originalReservedSlotMaybeUpgradeHydrogenProtectionSam =
  behavior.maybeUpgradeHydrogenProtectionSam;
const originalReservedSlotMaybeSpawnHostileSiloSam = behavior.maybeSpawnHostileSiloSam;
const originalReservedSlotShouldBuildHostileSiloSam = behavior.shouldBuildHostileSiloSam;
const originalReservedSlotHostileSiloSamActionBlocked = behavior.hostileSiloSamActionBlocked;
const originalReservedSlotMaybeUpgradeSamForSiloParity = behavior.maybeUpgradeSamForSiloParity;
const originalReservedSlotLegendaryMissileDefenseUrgent = behavior.legendaryMissileDefenseUrgent;
const originalReservedSlotLegendaryConstructionCandidates =
  behavior.legendaryConstructionCandidates;
const legendaryPostSamAttempts = [];
behavior.maybeUpgradeLegendarySam = async () => false;
behavior.maybeUpgradeHydrogenProtectionSam = async () => false;
behavior.maybeSpawnHostileSiloSam = async () => false;
behavior.shouldBuildHostileSiloSam = () => true;
behavior.hostileSiloSamActionBlocked = () => true;
behavior.legendaryMissileDefenseUrgent = () => false;
behavior.legendaryConstructionCandidates = () => [{ type: UNIT.City, cost: 0n, score: 1 }];
behavior.maybeUpgradeSamForSiloParity = async () => {
  legendaryPostSamAttempts.push("upgrade");
  return false;
};
behavior.maybeSpawnStructure = async (type) => {
  legendaryPostSamAttempts.push(type);
  return true;
};
assert.equal(
  await behavior.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: true,
  }),
  true,
  "Legendary continues productive construction while the mandatory hostile-Silo SAM is backed off",
);
assert.deepEqual(
  legendaryPostSamAttempts,
  [UNIT.City],
  "Legendary lets productive construction proceed between bounded hostile-Silo SAM retries",
);
behavior.maybeUpgradeLegendarySam = originalReservedSlotMaybeUpgradeLegendarySam;
behavior.maybeUpgradeHydrogenProtectionSam = originalReservedSlotMaybeUpgradeHydrogenProtectionSam;
behavior.maybeSpawnHostileSiloSam = originalReservedSlotMaybeSpawnHostileSiloSam;
behavior.shouldBuildHostileSiloSam = originalReservedSlotShouldBuildHostileSiloSam;
behavior.hostileSiloSamActionBlocked = originalReservedSlotHostileSiloSamActionBlocked;
behavior.maybeUpgradeSamForSiloParity = originalReservedSlotMaybeUpgradeSamForSiloParity;
behavior.legendaryMissileDefenseUrgent = originalReservedSlotLegendaryMissileDefenseUrgent;
behavior.legendaryConstructionCandidates = originalReservedSlotLegendaryConstructionCandidates;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

assert.equal(
  behavior.hasStructureUnderConstruction([makeUnit(950, 5, { underConstruction: false })]),
  false,
  "a completed or max-level structure cannot masquerade as pending construction",
);
assert.equal(
  behavior.hasStructureUnderConstruction([makeUnit(951, 1, { underConstruction: true })]),
  true,
  "a real same-type construction still blocks duplicate placement",
);

const originalDemandDrivenUpgradeLegendarySam = behavior.maybeUpgradeLegendarySam;
const originalDemandDrivenUpgradeHydrogenSam = behavior.maybeUpgradeHydrogenProtectionSam;
const originalDemandDrivenSpawnHostileSam = behavior.maybeSpawnHostileSiloSam;
const originalDemandDrivenShouldBuildHostileSam = behavior.shouldBuildHostileSiloSam;
const originalDemandDrivenOwnSamCapacity = behavior.ownSamCapacity;
const originalDemandDrivenParityUpgrade = behavior.maybeUpgradeSamForSiloParity;
const originalDemandDrivenUrgent = behavior.legendaryMissileDefenseUrgent;
const originalDemandDrivenCandidates = behavior.legendaryConstructionCandidates;
const demandDrivenActions = [];
behavior.maybeUpgradeLegendarySam = async () => false;
behavior.maybeUpgradeHydrogenProtectionSam = async () => {
  demandDrivenActions.push("hydrogen-upgrade");
  return true;
};
behavior.maybeSpawnHostileSiloSam = async () => {
  demandDrivenActions.push("second-sam");
  return true;
};
behavior.shouldBuildHostileSiloSam = () => true;
behavior.ownSamCapacity = () => 1;
behavior.maybeUpgradeSamForSiloParity = async () => {
  demandDrivenActions.push("parity-upgrade");
  return true;
};
behavior.legendaryMissileDefenseUrgent = () => false;
behavior.legendaryConstructionCandidates = () => [
  { type: UNIT.City, cost: 1n, legal: true, gold: 1, troops: 1 },
];
behavior.maybeSpawnStructure = async (type) => {
  demandDrivenActions.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 1,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  }),
  true,
  "Legendary keeps constructing after its first SAM when no missile is incoming",
);
assert.deepEqual(
  demandDrivenActions,
  [UNIT.City],
  "Passive hydrogen and silo parity do not repeatedly level the first Legendary SAM",
);
behavior.maybeUpgradeLegendarySam = originalDemandDrivenUpgradeLegendarySam;
behavior.maybeUpgradeHydrogenProtectionSam = originalDemandDrivenUpgradeHydrogenSam;
behavior.maybeSpawnHostileSiloSam = originalDemandDrivenSpawnHostileSam;
behavior.shouldBuildHostileSiloSam = originalDemandDrivenShouldBuildHostileSam;
behavior.ownSamCapacity = originalDemandDrivenOwnSamCapacity;
behavior.maybeUpgradeSamForSiloParity = originalDemandDrivenParityUpgrade;
behavior.legendaryMissileDefenseUrgent = originalDemandDrivenUrgent;
behavior.legendaryConstructionCandidates = originalDemandDrivenCandidates;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const constructionBlockedCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  constructionBlockedCalls.push(args);
  return true;
};
own.sams = [makeUnit(999, 1, { underConstruction: true })];
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A pending SAM construction blocks another dedicated hostile-Silo placement",
);
assert.equal(
  constructionBlockedCalls.length,
  0,
  "A pending SAM construction avoids a second expensive placement probe",
);
own.sams = [];
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const originalReactiveUpgrade = behavior.maybeUpgradeMissileDefenseSam;
const originalParityUpgrade = behavior.maybeUpgradeSamForSiloParity;
const originalSamGap = behavior.samLevelParityGap;
const originalShouldBuildHostileSam = behavior.shouldBuildHostileSiloSam;
const originalTryBuildDefensePost = behavior.tryBuildDefensePost;
const originalIsInPostSaveUpBlockedPhase = behavior.isInPostSaveUpBlockedPhase;
const originalDoHandleStructures = behavior.doHandleStructures;
const originalGameConfigForFallback = behavior.game.config;
const originalGameTicksForFallback = behavior.game.ticks;
let fullPathPlacementCalls = 0;
let fullPathTick = 2_000;
behavior.game.ticks = () => fullPathTick;
behavior.game.config = () => ({ isUnitDisabled: () => true });
behavior.maybeUpgradeMissileDefenseSam = async () => false;
behavior.maybeUpgradeSamForSiloParity = async () => false;
behavior.samLevelParityGap = () => 1;
behavior.shouldBuildHostileSiloSam = () => true;
behavior.maybeSpawnStructure = async () => {
  fullPathPlacementCalls++;
  fullPathTick += 2;
  return false;
};
behavior.tryBuildDefensePost = async () => false;
behavior.isInPostSaveUpBlockedPhase = () => false;
behavior.doHandleStructures = async () => false;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;
assert.equal(
  await behavior.handleStructures(),
  false,
  "A failed hostile-Silo placement falls through without building another SAM in the same decision",
);
assert.equal(
  fullPathPlacementCalls,
  1,
  "A failed async hostile-Silo placement cannot be duplicated when the game tick advances during probing",
);
behavior.maybeUpgradeMissileDefenseSam = originalReactiveUpgrade;
behavior.maybeUpgradeSamForSiloParity = originalParityUpgrade;
behavior.samLevelParityGap = originalSamGap;
behavior.shouldBuildHostileSiloSam = originalShouldBuildHostileSam;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior.tryBuildDefensePost = originalTryBuildDefensePost;
behavior.isInPostSaveUpBlockedPhase = originalIsInPostSaveUpBlockedPhase;
behavior.doHandleStructures = originalDoHandleStructures;
behavior.game.config = originalGameConfigForFallback;
behavior.game.ticks = originalGameTicksForFallback;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;
behavior._hostilePlayersSnapshotTick = null;
behavior._hostilePlayersSnapshot = null;
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
const originalOwnUnits = own.units;
const originalGameConfig = behavior.game.config;
const originalEuclideanDistSquared = behavior.game.euclideanDistSquared;
const protectedStructures = [
  {
    type: () => UNIT.City,
    tile: () => 10,
    level: () => 1,
    isUnderConstruction: () => false,
  },
  {
    type: () => UNIT.Factory,
    tile: () => 20,
    level: () => 1,
    isUnderConstruction: () => false,
  },
];
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [];
  if (types.some((type) => protectedStructures.some((unit) => unit.type() === type))) {
    return protectedStructures;
  }
  return [];
};
behavior.game.config = () => ({
  defaultSamRange: () => 5,
  samRange: () => 5,
});
behavior.game.euclideanDistSquared = (left, right) => (Number(left) - Number(right)) ** 2;
const threatSamValue = behavior.threatSamLauncherValue();
assert.equal(
  threatSamValue(15) > threatSamValue(10),
  true,
  "Threat SAM placement prefers the tile covering more structures",
);

const originalThreatCost = behavior.cost;
const expensiveCluster = [
  { type: () => UNIT.MissileSilo, tile: () => 100, level: () => 1 },
  { type: () => UNIT.City, tile: () => 110, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 200, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 205, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 210, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 215, level: () => 1 },
];
behavior.cost = (type) => {
  if (type === UNIT.MissileSilo) return 3_000_000n;
  if (type === UNIT.City) return 1_000_000n;
  return 100_000n;
};
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [];
  return expensiveCluster.filter((unit) => types.includes(unit.type()));
};
behavior.game.config = () => ({
  defaultSamRange: () => 15,
  samRange: () => 15,
});
const expensiveClusterValue = behavior.threatSamLauncherValue();
assert.ok(
  expensiveClusterValue(105) > expensiveClusterValue(207),
  "a threat SAM centers on the most expensive own building cluster over a larger cheap cluster",
);
behavior.cost = originalThreatCost;

const existingCoverageSam = {
  tile: () => 0,
  level: () => 1,
  isUnderConstruction: () => false,
};
const uncoveredStructure = {
  type: () => UNIT.City,
  tile: () => 40,
  level: () => 1,
  isUnderConstruction: () => false,
};
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [existingCoverageSam];
  return types.includes(UNIT.City) ? [uncoveredStructure] : [];
};
behavior.game.config = () => ({
  defaultSamRange: () => 25,
  samRange: () => 25,
});
const uncoveredThreatSamValue = behavior.threatSamLauncherValue();
assert.equal(
  uncoveredThreatSamValue(20) > 3,
  true,
  "Threat SAM placement keeps the existing-coverage distinction while favoring the cluster center",
);

const legendaryCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
legendaryCoverageBehavior.player = {
  units: (...types) => (types.includes(UNIT.City) ? [uncoveredStructure] : []),
};
legendaryCoverageBehavior.game = behavior.game;
legendaryCoverageBehavior.legendaryFriendlySamUnits = () => [existingCoverageSam];
legendaryCoverageBehavior.spacingConstants = () => ({ structureSpacing: 10 });
legendaryCoverageBehavior.legendaryCriticalStructureValue = () => 1;
legendaryCoverageBehavior.legendarySamImpactMarginScore = () => 0;
assert.equal(
  legendaryCoverageBehavior.legendarySamCoveragePlacementScore(20, {}),
  10,
  "Legendary SAM placement counts a structure outside the existing SAM range as uncovered",
);

const compactPlacementBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const compactStructures = [{ tile: () => 10 }];
const compactOwnOwner = { smallID: () => 1 };
const compactAllyOwner = { smallID: () => 2 };
const compactSams = [
  {
    id: () => "own-sam",
    tile: () => 80,
    level: () => 1,
    owner: () => compactOwnOwner,
    isUnderConstruction: () => false,
  },
  {
    id: () => "ally-sam",
    tile: () => 40,
    level: () => 1,
    owner: () => compactAllyOwner,
    isUnderConstruction: () => false,
  },
];
compactPlacementBehavior.player = {
  smallID: () => 1,
  isFriendly: (owner) => owner === compactAllyOwner,
  isOnSameTeam: () => false,
  units: (...types) => {
    if (types.length === 1 && types[0] === UNIT.SAMLauncher) {
      return [compactSams[0]];
    }
    return compactStructures;
  },
};
compactPlacementBehavior.game = {
  units: (type) => (type === UNIT.SAMLauncher ? compactSams : []),
  config: () => ({
    defaultSamRange: () => 20,
    maxSamRange: () => 40,
    samRange: () => 20,
  }),
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
const compactRanker = compactPlacementBehavior.structurePlacementCompactnessRanker(UNIT.Factory);
assert.equal(
  compactRanker(15).sharedSamCoverage,
  1,
  "Economic placement recognizes structures that one future SAM can cover together",
);
assert.equal(
  compactRanker(50).sharedSamCoverage,
  0,
  "Economic placement rejects a spread-out tile from the shared SAM cluster",
);
assert.equal(
  compactRanker(25).existingSamCoverage,
  1,
  "Economic placement recognizes current coverage from an allied SAM",
);
assert.equal(
  compactRanker(15).upgradeSamCoverage,
  1,
  "Economic placement recognizes allied SAM coverage reachable after leveling",
);
assert.equal(
  compactRanker(0).upgradeSamCoverage,
  1,
  "The eventual coverage tier includes tiles within the SAM maximum range",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 1, compactness: compactRanker(15) },
    { v: 10_000, compactness: compactRanker(50) },
  ) > 0,
  true,
  "Current allied SAM coverage outranks merely prospective compact coverage",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 1, compactness: compactRanker(80) },
    { v: 10_000, compactness: compactRanker(15) },
  ) < 0,
  true,
  "Existing SAM coverage outranks merely prospective compact coverage",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 10_000, compactness: compactRanker(25) },
    { v: 1, compactness: compactRanker(50) },
  ) > 0,
  true,
  "Within the current-coverage tier, the tile closer to a friendly SAM wins",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 10_000, compactness: compactRanker(0) },
    { v: 1, compactness: compactRanker(15) },
  ) > 0,
  true,
  "Within future upgraded coverage, the tile closer to a friendly SAM wins",
);
const compactSnapshotBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let compactSnapshotTileReads = 0;
let compactSnapshotConfigReads = 0;
const compactSnapshotSams = [
  {
    tile: () => {
      compactSnapshotTileReads++;
      return 10;
    },
    level: () => 1,
  },
  {
    tile: () => {
      compactSnapshotTileReads++;
      return 40;
    },
    level: () => 1,
  },
];
compactSnapshotBehavior.player = {
  units: () => [
    {
      tile: () => {
        compactSnapshotTileReads++;
        return 20;
      },
    },
  ],
};
compactSnapshotBehavior.legendaryFriendlySamUnits = () => compactSnapshotSams;
compactSnapshotBehavior.game = {
  config: () => {
    compactSnapshotConfigReads++;
    return {
      defaultSamRange: () => 20,
      maxSamRange: () => 40,
      samRange: () => 20,
    };
  },
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
const compactSnapshotRanker = compactSnapshotBehavior.structurePlacementCompactnessRanker(
  UNIT.Factory,
);
const compactSnapshotReadsAfterSetup = {
  tiles: compactSnapshotTileReads,
  config: compactSnapshotConfigReads,
};
compactSnapshotRanker(15);
compactSnapshotRanker(25);
assert.deepEqual(
  {
    tiles: compactSnapshotTileReads,
    config: compactSnapshotConfigReads,
  },
  compactSnapshotReadsAfterSetup,
  "Economic compactness snapshots SAM and structure geometry once per decision, not once per candidate",
);
assert.deepEqual(
  Array.from(
    compactPlacementBehavior.rankStructureTilesBySamProtection([0, 15, 25], UNIT.DefensePost),
  ),
  [25, 15, 0],
  "Defense Posts preserve their valid front sample but rank it by current and future SAM protection",
);

const samCandidateBehavior = Object.create(sandbox.__StructureBehavior.prototype);
samCandidateBehavior.player = compactPlacementBehavior.player;
samCandidateBehavior.game = {
  ...compactPlacementBehavior.game,
  x: (tile) => Number(tile),
  y: () => 0,
  ref: (x) => x,
  isValidCoord: () => true,
  isLand: () => true,
  ownerID: () => 1,
};
const protectedCandidates = samCandidateBehavior.tilesNearFriendlySams(6);
assert.equal(protectedCandidates.length <= 6, true);
assert.equal(
  protectedCandidates.includes(80),
  true,
  "The bounded candidate set starts near an existing own SAM",
);
assert.equal(
  protectedCandidates.includes(40),
  true,
  "The bounded candidate set fairly includes an allied SAM instead of being filled by the first launcher",
);

const coverageProbeStructures = Array.from({ length: 500 }, (_, index) => ({
  tile: () => index * 100,
}));
const originalCoverageRandTerritoryTileArray = sandbox.randTerritoryTileArray;
let coverageRequestedSampleCount = 0;
sandbox.randTerritoryTileArray = (_random, _game, _player, count) => {
  coverageRequestedSampleCount = count;
  return Array.from({ length: count }, (_, index) => (index < 2 ? 10_000 : 9_999 + index));
};
const coverageProbe = Object.create(sandbox.__StructureBehavior.prototype);
coverageProbe.random = {};
coverageProbe.player = {
  smallID: () => 1,
  units: (...types) =>
    types.length === 1 && types[0] === UNIT.SAMLauncher ? [] : coverageProbeStructures,
};
coverageProbe.game = {
  neighbors: (tile) => [tile + 1, tile + 2, tile + 3],
  ownerID: (tile) => (tile === 10_001 ? 2 : 1),
  config: () => ({
    defaultSamRange: () => 10,
    samRange: () => 10,
    structureMinDist: () => 2,
  }),
  nearbyUnits: () => [],
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
let coverageProbeCount = 0;
const coverageProbeTiles = [];
coverageProbe.buildableFor = async (_type, tile) => {
  coverageProbeCount++;
  coverageProbeTiles.push(tile);
  return null;
};
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
  }),
  null,
  "Coverage-priority SAM placement returns null when all probes are unavailable",
);
assert.equal(
  coverageProbeCount,
  3,
  "Coverage-priority SAM placement bounds authoritative snapshot-drift fallbacks",
);
assert.equal(
  coverageRequestedSampleCount,
  25,
  "Coverage-priority SAM placement preserves the upstream Nation sample budget",
);
assert.equal(
  new Set(coverageProbeTiles).size,
  coverageProbeTiles.length,
  "Coverage-priority SAM placement removes duplicate candidates before worker probes",
);
assert.equal(
  coverageProbeTiles.includes(10_001),
  false,
  "Coverage-priority SAM placement removes foreign-owned tiles before worker probes",
);
coverageProbeCount = 0;
let validCoverageProbe = null;
coverageProbe.buildableFor = async () => {
  coverageProbeCount++;
  validCoverageProbe = { canBuild: true, canUpgrade: false, tile: 321 };
  return validCoverageProbe;
};
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
    probeLimit: 25,
    probeTimeoutMs: 20,
    parallelProbeCount: 1,
  }),
  validCoverageProbe,
  "Hostile-silo SAM placement validates the best locally legal candidate",
);
assert.equal(
  coverageProbeCount,
  1,
  "Hostile-silo SAM placement normally crosses the worker boundary exactly once",
);
coverageProbe.buildableFor = async () => {
  coverageProbeCount++;
  return null;
};
sandbox.randTerritoryTileArray = originalCoverageRandTerritoryTileArray;

const localLegalityProbe = Object.create(sandbox.__StructureBehavior.prototype);
localLegalityProbe.player = { smallID: () => 1 };
localLegalityProbe.game = {
  ownerID: (tile) => (tile >= 0 && tile <= 30 ? 1 : 2),
  neighbors: (tile) => [tile - 1, tile + 1],
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  nearbyUnits: () => [{ unit: { tile: () => 10 } }],
  config: () => ({ structureMinDist: () => 2 }),
};
const locallySnappedTile = localLegalityProbe.localLandStructureSpawnTile(10);
assert.equal(
  locallySnappedTile === 8 || locallySnappedTile === 12,
  true,
  "Local structure legality mirrors the engine spacing rule and snaps beyond occupied tiles",
);
assert.equal(
  localLegalityProbe.localLandStructureSpawnTile(31),
  false,
  "Local structure legality rejects candidates outside the player's territory",
);

const hostileOwner = { isPlayer: () => true };
const alliedOwner = { isPlayer: () => true };
const placementSafetyProbe = Object.create(sandbox.__StructureBehavior.prototype);
placementSafetyProbe.player = {
  smallID: () => 1,
  isFriendly: (player) => player === alliedOwner,
  isOnSameTeam: (player) => player === alliedOwner,
};
placementSafetyProbe.game = {
  neighbors: (tile) => [tile + 1],
  ownerID: (tile) => {
    if (tile === 11) return 2;
    if (tile === 21) return 3;
    return 1;
  },
  playerBySmallID: (sid) => {
    if (sid === 2) return hostileOwner;
    if (sid === 3) return alliedOwner;
    return null;
  },
};
assert.equal(
  placementSafetyProbe.isDangerousStructureTile(10, UNIT.Factory),
  true,
  "Ordinary structures reject tiles directly exposed to hostile territory",
);
assert.equal(
  placementSafetyProbe.isDangerousStructureTile(20, UNIT.Factory),
  false,
  "Allied territory does not make a construction tile dangerous",
);
assert.equal(
  placementSafetyProbe.isDangerousStructureTile(10, UNIT.DefensePost),
  false,
  "Defense posts may still fortify an active hostile frontier",
);
assert.equal(
  placementSafetyProbe.isSafeBuildablePlacement({ canBuild: 10 }, 20, UNIT.City),
  false,
  "The authoritative worker destination is safety-checked after snapping",
);

let impactTick = 100;
let placementMissileActive = true;
let impactProbeCalls = 0;
const missileOwner = { smallID: () => 2 };
const ownMissileOwner = { smallID: () => 1 };
const alliedMissileOwner = { smallID: () => 3 };
let missileImpactOwner = missileOwner;
const hostileAtom = {
  owner: () => missileImpactOwner,
  isActive: () => placementMissileActive,
  targetTile: () => 100,
  type: () => UNIT.AtomBomb,
};
const missileImpactProbe = Object.create(sandbox.__StructureBehavior.prototype);
missileImpactProbe.player = {
  smallID: () => 1,
  isFriendly: (owner) => owner === alliedMissileOwner,
  isOnSameTeam: (owner) => owner === alliedMissileOwner,
};
missileImpactProbe.game = {
  ticks: () => impactTick,
  units: () => [hostileAtom],
  config: () => ({
    nukeMagnitudes: () => ({ outer: 10 }),
  }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  neighbors: () => [],
  ownerID: () => 1,
  playerBySmallID: () => null,
};
missileImpactProbe.buildableFor = async (_type, tile) => {
  impactProbeCalls++;
  return { canUpgrade: true, tile };
};
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  true,
  "Every structure rejects a tile inside an active hostile missile blast",
);
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.DefensePost),
  true,
  "The frontier exemption does not let a Defense Post enter a missile blast",
);
assert.equal(
  missileImpactProbe.isDangerousStructureTile(111, UNIT.Factory),
  false,
  "A tile beyond the configured outer blast radius remains buildable",
);
const impactUpgradeResults = await missileImpactProbe.buildableForUnits(
  [makeUnit(105, 1), makeUnit(120, 1)],
  UNIT.SAMLauncher,
  { concurrency: 2 },
);
assert.equal(
  impactUpgradeResults[0],
  null,
  "An upgrade inside an imminent hostile impact is not probed or purchased",
);
assert.equal(impactUpgradeResults[1]?.canUpgrade, true);
assert.equal(impactProbeCalls, 1, "Only the missile-safe upgrade candidate is probed");
placementMissileActive = false;
impactTick++;
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  false,
  "Missile impact safety invalidates with the game tick after the threat ends",
);
placementMissileActive = true;
missileImpactOwner = ownMissileOwner;
impactTick++;
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  false,
  "Our own in-flight missile does not suppress construction",
);
missileImpactOwner = alliedMissileOwner;
impactTick++;
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  false,
  "An allied in-flight missile does not suppress construction",
);
missileImpactOwner = missileOwner;
impactProbeCalls = 0;
sentBuilds.length = 0;
missileImpactProbe.buildableFor = async (_type, tile) => {
  impactProbeCalls++;
  return { canBuild: tile, canUpgrade: false, tile };
};
impactTick++;
assert.equal(
  await missileImpactProbe.buildFirstDefensePost([105, 120]),
  true,
  "The direct Defense Post path skips an unsafe raw tile and builds the safe candidate",
);
assert.equal(sentBuilds.at(-1)?.tile, 120);
assert.equal(impactProbeCalls, 1, "The unsafe Defense Post tile is never probed");
missileImpactProbe.buildableFor = async () => ({ canBuild: 105, canUpgrade: false });
sentBuilds.length = 0;
impactTick++;
assert.equal(
  await missileImpactProbe.buildFirstDefensePost([120]),
  false,
  "The direct Defense Post path rejects an authoritative snap into the blast",
);
assert.equal(sentBuilds.length, 0);

const originalTilesNearFriendlySams = coverageProbe.tilesNearFriendlySams;
const originalMissileSiloValue = coverageProbe.missileSiloValue;
coverageProbe.tilesNearFriendlySams = () =>
  Array.from({ length: 25 }, (_, index) => 20_000 + index);
coverageProbe.missileSiloValue = () => () => 0;
coverageProbeCount = 0;
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.MissileSilo),
  null,
  "SAM-covered silo placement returns null when all merged probes are unavailable",
);
assert.equal(
  coverageProbeCount,
  25,
  "SAM-covered silo placement keeps the merged candidate set bounded to 25 probes",
);
const protectedFactoryCandidates = coverageProbe.structureCandidateTiles(UNIT.Factory, {}, 25);
assert.deepEqual(
  Array.from(protectedFactoryCandidates),
  Array.from({ length: 25 }, (_, index) => 20_000 + index),
  "SAM-protected candidate generation applies to ordinary structures, not only silos",
);
coverageProbe.tilesNearFriendlySams = originalTilesNearFriendlySams;
coverageProbe.missileSiloValue = originalMissileSiloValue;
own.units = originalOwnUnits;
behavior.game.config = originalGameConfig;
behavior.game.euclideanDistSquared = originalEuclideanDistSquared;

const hydrogenProtectionBehavior = Object.create(sandbox.__StructureBehavior.prototype);
hydrogenProtectionBehavior._hostileMissileLaunchObserved = true;
const hydrogenSam = makeUnit(1101, 1);
let hydrogenProtectionGold = 5_000_000n;
let hydrogenThreatPlayers = [enemyTwoLevelOneSilos];
hydrogenProtectionBehavior.player = {
  smallID: () => 1,
  gold: () => hydrogenProtectionGold,
  borderTiles: () => new Set([0, 10]),
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [hydrogenSam];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    return [];
  },
};
hydrogenProtectionBehavior.game = {
  ticks: () => 1,
  players: () => [hydrogenProtectionBehavior.player, ...hydrogenThreatPlayers],
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
hydrogenProtectionBehavior.liveHostilePlayers = () => [enemyTwoLevelOneSilos];
hydrogenProtectionBehavior.legendaryReserveGold = () => 0n;
hydrogenProtectionBehavior.cost = () => 1n;
hydrogenProtectionBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1n },
];
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "Two Silo slots on one hostile player force the maximum SAM level",
);
const originalEnemyTeamUnitsForHydrogenPlan = enemyTeam.units;
enemyTeam.units = (type) => (type === UNIT.MissileSilo ? [makeUnit(504, 2)] : []);
hydrogenThreatPlayers = [enemyTeam];
hydrogenProtectionBehavior.liveHostilePlayers = () => [];
hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "An allied level-2 Silo also forces our SAM toward level five",
);
enemyTeam.units = originalEnemyTeamUnitsForHydrogenPlan;
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradeHydrogenProtectionSam(),
  true,
  "H-bomb coverage emits the required SAM upgrade",
);
assert.equal(sentBuilds.length, 1, "H-bomb coverage emits one SAM upgrade action");
hydrogenProtectionGold = 1_000_000n;
hydrogenProtectionBehavior.cost = () => 3_000_000n;
hydrogenProtectionBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 500_000n },
];
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradePlannedSam({
    sam: hydrogenSam,
    currentLevel: 1,
    targetLevel: 2,
  }),
  true,
  "An affordable authoritative SAM upgrade is not rejected by the higher new-site price",
);
assert.equal(sentBuilds.length, 1);
hydrogenProtectionGold = 5_000_000n;
hydrogenProtectionBehavior.cost = () => 1n;
hydrogenProtectionBehavior.liveHostilePlayers = () => [enemySingleLevelOneSilo];
hydrogenThreatPlayers = [enemySingleLevelOneSilo];
hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "A single completed external Silo immediately drives the first protective SAM to level five",
);
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradeHydrogenProtectionSam(),
  true,
  "The H-bomb policy upgrades a level-1 SAM before the hostile player can spend 5M on a launch",
);
assert.equal(sentBuilds.length, 1, "The single-Silo H-bomb policy sends exactly one SAM upgrade");
hydrogenProtectionBehavior.liveHostilePlayers = () => [enemySingleLevelTwoSilo];
hydrogenThreatPlayers = [enemySingleLevelTwoSilo];
hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "One level-2 hostile Silo also forces the maximum SAM level",
);

const firstSiloCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
firstSiloCoverageBehavior._hostileMissileLaunchObserved = true;
firstSiloCoverageBehavior.player = {
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    if (type === UNIT.MissileSilo) return [makeUnit(1150, 1)];
    return [];
  },
};
firstSiloCoverageBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    gameConfig: () => ({ gameMode: "FFA" }),
    samRange: (level) => level * 6,
  }),
};
firstSiloCoverageBehavior.liveHostilePlayers = () => [enemySingleLevelOneSilo];
firstSiloCoverageBehavior.legendaryReserveGold = () => 0n;
assert.equal(
  firstSiloCoverageBehavior.hydrogenStructureCoveragePlan()?.needsNewSam,
  true,
  "The first built hostile level-1 Silo requests a SAM covering our structures",
);
assert.equal(
  firstSiloCoverageBehavior.defensiveConstructionPressure()?.type,
  UNIT.SAMLauncher,
  "The first hostile Silo creates a defensive SAM reserve before offense",
);
const firstSiloCoverageSpawns = [];
firstSiloCoverageBehavior._hostileMissileLaunchObserved = false;
firstSiloCoverageBehavior.maybeSpawnStructure = async (...args) => {
  firstSiloCoverageSpawns.push(args);
  return true;
};
assert.equal(
  await firstSiloCoverageBehavior.maybeEnsureHydrogenStructureCoverage(),
  true,
  "A first hostile Silo authorizes the required coverage SAM before a missile launches",
);
assert.deepEqual(
  firstSiloCoverageSpawns.map(([type, options]) => [type, options.useActualCost]),
  [[UNIT.SAMLauncher, true]],
  "Pre-launch coverage SAMs use the literal affordable cost instead of a save-up multiplier",
);

let coverageSamLevel = 1;
const structureCoverageSam = {
  id: () => 1201,
  level: () => coverageSamLevel,
  tile: () => 0,
  isUnderConstruction: () => false,
  isActive: () => true,
};
const structureCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
structureCoverageBehavior._hostileMissileLaunchObserved = false;
let structureCoverageTick = 1;
let structureCoverageDistanceCalls = 0;
structureCoverageBehavior.player = {
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [structureCoverageSam];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    if (type === UNIT.Factory) return [{ tile: () => 10 }];
    return [];
  },
};
structureCoverageBehavior.game = {
  ticks: () => structureCoverageTick,
  euclideanDistSquared: (left, right) => {
    structureCoverageDistanceCalls++;
    return (Number(left) - Number(right)) ** 2;
  },
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
structureCoverageBehavior.liveHostilePlayers = () => [enemyTwoLevelOneSilos];
structureCoverageBehavior.cost = () => 1n;
structureCoverageBehavior.legendaryReserveGold = () => 0n;
structureCoverageBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1n },
];
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan().targetLevel,
  2,
  "Structure protection chooses the minimum SAM level covering every structure",
);
const firstCoverageDistanceCalls = structureCoverageDistanceCalls;
sentBuilds.length = 0;
assert.equal(
  await structureCoverageBehavior.maybeEnsureHydrogenStructureCoverage(),
  true,
  "A built hostile Silo emits the required SAM upgrade before its first missile",
);
assert.equal(sentBuilds.length, 1, "Structure protection emits one upgrade action");
const literalCostSamBehavior = Object.create(sandbox.__StructureBehavior.prototype);
literalCostSamBehavior.structureSpawnEligible = () => true;
literalCostSamBehavior.cost = () => 3_000_000n;
literalCostSamBehavior.getConstructionCost = () => {
  throw new Error("Emergency SAM must bypass perceived-cost gating");
};
literalCostSamBehavior.availableGoldAfterReserve = () => 3_000_000n;
literalCostSamBehavior.player = { units: () => [] };
literalCostSamBehavior.structureUpgradeBeforeSpawn = async () => null;
const literalCostSamBuildable = { type: UNIT.SAMLauncher, canBuild: 77, canUpgrade: false };
literalCostSamBehavior.structureSpawnTile = async () => literalCostSamBuildable;
const literalCostSamBuildCount = sentBuilds.length;
assert.equal(
  await literalCostSamBehavior.maybeSpawnStructure(UNIT.SAMLauncher, {
    allowPreemptiveSam: true,
    forceNewStructure: true,
    useActualCost: true,
  }),
  true,
  "A hostile-Silo SAM builds when literal gold covers its authoritative cost",
);
assert.equal(sentBuilds.length, literalCostSamBuildCount + 1);
assert.equal(sentBuilds.at(-1), literalCostSamBuildable);
assert.equal(
  structureCoverageDistanceCalls,
  firstCoverageDistanceCalls,
  "Repeated coverage consumers reuse one SAM-versus-structure geometry plan per tick",
);
structureCoverageTick++;
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan().targetLevel,
  2,
  "Unchanged SAM and structure geometry preserves the coverage plan across ticks",
);
assert.equal(
  structureCoverageDistanceCalls,
  firstCoverageDistanceCalls,
  "Unchanged geometry is not recomputed merely because the game tick advanced",
);
coverageSamLevel = 2;
structureCoverageTick++;
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan(),
  null,
  "A SAM at the planned level covers all own structures",
);

const jointCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
jointCoverageBehavior.player = {
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [makeUnit(0, 1), makeUnit(100, 1)];
    if (type === UNIT.City) return [{ tile: () => 0 }, { tile: () => 100 }];
    return [];
  },
};
jointCoverageBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
jointCoverageBehavior.liveHostilePlayers = () => [enemyTwoLevelOneSilos];
assert.equal(
  jointCoverageBehavior.computeHydrogenStructureCoveragePlan(),
  null,
  "Joint coverage by existing SAMs does not request another physical site",
);

const originalGetPerceivedCost = behavior.getPerceivedCost;
const originalStructureSpawnTile = behavior.structureSpawnTile;
const originalGetTotalStructureDensity = behavior.getTotalStructureDensity;
behavior.structureSpawnTile = async () => ({ canBuild: true, canUpgrade: false });
behavior.getTotalStructureDensity = () => 0;
const buildsBeforeSiloGate = sentBuilds.length;
const originalOwnGoldForDirectSilo = own.gold;
own.gold = () => 100_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  false,
  "The direct silo spawn path preserves the economy reserve when surplus is insufficient",
);
hostileAttemptTick++;
enemyB.gold = () => 1_000_000n;
own.gold = () => 5_000_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  true,
  "The direct silo spawn path reopens when surplus covers the economy reserve",
);
assert.equal(
  sentBuilds.length,
  buildsBeforeSiloGate + 1,
  "Only the threshold-opened direct silo attempt reaches the build menu",
);
enemyB.gold = () => 999_999n;
own.gold = originalOwnGoldForDirectSilo;
behavior.getPerceivedCost = originalGetPerceivedCost;
behavior.structureSpawnTile = originalStructureSpawnTile;
behavior.getTotalStructureDensity = originalGetTotalStructureDensity;
own.silos = [makeUnit(101, 6)];
assert.equal(
  behavior.missileSiloParityGap(),
  0,
  "A level sum equal to the strongest enemy SAM stack closes the parity gap",
);
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 0, false),
  false,
  "Silo parity stops requesting more capacity once the target is reached",
);
assert.equal(
  typeof behavior.enemyMissileSiloCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile Silo-capacity parity target",
);
assert.equal(
  behavior.enemyMissileSiloCapacityParityTarget(),
  6,
  "Silo parity selects the strongest hostile Silo level sum and treats construction as one projected level",
);
assert.equal(
  behavior.enemyMissileSiloCapacityTarget(),
  7,
  "SAM defense sums every hostile Silo level, including one projected construction slot",
);
assert.equal(
  behavior.samLevelParityTarget(),
  6,
  "SAM upgrade parity uses the strongest hostile Silo network instead of global hostile capacity",
);
state.settings.winFixes = false;
assert.equal(
  behavior.missileSiloParityTarget(),
  0,
  "Disabling winFixes disables the custom SAM-to-silo parity target",
);
state.settings.winFixes = true;

own.silos = [];
const reactiveSam = makeUnit(401, 1);
own.sams = [reactiveSam];
behavior.legendaryMissilePlacementContext = () => ({ threats: [{ targetTile: 999 }] });
behavior.legendaryDefenseEvaluation = (_context, options = {}) =>
  options.levelOverrides
    ? {
        hasThreats: true,
        fullyDefended: true,
        completionMarginTicks: 10,
        uninterceptedCount: 0,
      }
    : {
        hasThreats: true,
        fullyDefended: false,
        completionMarginTicks: 0,
        uninterceptedCount: 1,
      };
behavior.legendaryMinimumSamInterceptionCapacity = (_context, overrides) => (overrides ? 2 : 1);
behavior.legendaryReserveGold = () => 0n;
behavior.cost = () => 1_500_000n;
behavior.buildableFor = async () => ({
  type: UNIT.SAMLauncher,
  canUpgrade: true,
  cost: 1_500_000n,
});

let forecastCalls = 0;
let forecastTick = 100;
behavior.game.ticks = () => forecastTick;
behavior.legendaryMissilePlacementContext = () => {
  forecastCalls++;
  return { threats: [{ targetTile: 999 }] };
};
own.sams = [];
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "Reactive SAM defense does not forecast when there is no SAM to upgrade",
);
assert.equal(
  forecastCalls,
  0,
  "Reactive SAM defense avoids the expensive forecast when no SAM exists",
);

own.sams = [reactiveSam];
own.gold = () => 1_000_000n;
forecastCalls = 0;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "Reactive SAM defense does not forecast when the next upgrade is unaffordable",
);
assert.equal(
  forecastCalls,
  0,
  "Reactive SAM defense avoids the expensive forecast below the upgrade cost",
);
let parityProbeCalls = 0;
const parityBuildableFor = behavior.buildableFor;
const parityCost = behavior.cost;
behavior.cost = () => 3_000_000n;
behavior.buildableFor = async () => {
  parityProbeCalls++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 3_000_000n,
  };
};
own.gold = () => 1_500_000n;
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not attempt an upgrade when the next level costs more than the available 1.5M gold",
);
assert.equal(
  parityProbeCalls,
  1,
  "SAM parity probes the authoritative upgrade cost instead of assuming the new-SAM price",
);
const parityBuildCountBeforeAffordableUpgrade = sentBuilds.length;
behavior.buildableFor = async () => {
  parityProbeCalls++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 1_000_000n,
  };
};
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "SAM parity upgrades when the authoritative upgrade price is affordable even if a new SAM is not",
);
assert.equal(
  sentBuilds.length,
  parityBuildCountBeforeAffordableUpgrade + 1,
  "Affordable authoritative SAM parity upgrades emit one build action",
);
behavior.buildableFor = parityBuildableFor;
behavior.cost = parityCost;
own.gold = () => 5_000_000n;
behavior.getMissileDefenseContext();
behavior.getMissileDefenseContext();
assert.equal(forecastCalls, 1, "Missile defense context is reused within one game tick");
forecastTick++;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  1,
  "Missile defense context is reused inside its short conservative tick bucket",
);
forecastTick += 2;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  2,
  "Missile defense context refreshes when the conservative tick bucket advances",
);
own.sams = [makeUnit(402, 1)];
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  3,
  "Missile defense context refreshes when a SAM changes inside one tick bucket",
);
own.sams = [reactiveSam];
enemyTeamSamLevel = 13;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  4,
  "Missile defense context refreshes when an allied SAM changes inside one tick bucket",
);
enemyTeamSamLevel = 12;

const originalGamePlayersForSignalTest = behavior.game.players;
const originalGameUnitsForSignalTest = behavior.game.units;
const originalEmptyMissileContext = behavior.legendaryEmptyMissileDefenseContext;
const originalEnemyBGoldForSignalTest = enemyB.gold;
behavior.game.players = () => [own, enemyB];
behavior.game.units = () => [];
behavior._hostilePlayersSnapshotTick = null;
behavior._missileDefenseSignalTick = null;
behavior._activeHostileMissileTick = null;
behavior._activeHostileMissileCache = null;
enemyB.gold = () => 1_500_000n;
behavior.legendaryEmptyMissileDefenseContext = () => ({ threats: [] });
forecastCalls = 0;
assert.equal(
  behavior.hasMissileDefenseSignal(),
  false,
  "Gold alone does not count as an active missile-defense forecast signal",
);
behavior.getMissileDefenseContext();
assert.equal(forecastCalls, 0, "Gold alone avoids the expensive missile trajectory forecast");
behavior.game.players = originalGamePlayersForSignalTest;
behavior.game.units = originalGameUnitsForSignalTest;
behavior._hostilePlayersSnapshotTick = null;
behavior._missileDefenseSignalTick = null;
behavior.legendaryEmptyMissileDefenseContext = originalEmptyMissileContext;
enemyB.gold = originalEnemyBGoldForSignalTest;

const launchGateBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let hostileMissileActive = false;
launchGateBehavior._hostileMissileLaunchObserved = false;
launchGateBehavior.activeHostileMissileSnapshot = () => hostileMissileActive;
assert.equal(
  launchGateBehavior.hasObservedHostileMissileLaunch(),
  false,
  "A hostile Silo alone does not unlock SAM construction",
);
assert.equal(
  await launchGateBehavior.maybeSpawnStructure(UNIT.SAMLauncher),
  false,
  "An ordinary SAM cannot be constructed before the first hostile missile launch",
);
launchGateBehavior.shouldReserveEconomicGrowthForOffense = () => false;
launchGateBehavior.getConstructionCost = () => 1_500_000n;
launchGateBehavior.availableGoldAfterReserve = () => 2_000_000n;
launchGateBehavior.player = { units: () => [] };
launchGateBehavior.structureUpgradeBeforeSpawn = async () => null;
const preemptiveSamBuildable = { canBuild: 123, canUpgrade: false };
launchGateBehavior.structureSpawnTile = async () => preemptiveSamBuildable;
const preemptiveBuildCount = sentBuilds.length;
assert.equal(
  await launchGateBehavior.maybeSpawnStructure(UNIT.SAMLauncher, {
    allowPreemptiveSam: true,
    forceNewStructure: true,
  }),
  true,
  "A threat-authorized SAM can be built with 2M gold before the first launch",
);
assert.equal(sentBuilds.length, preemptiveBuildCount + 1);
assert.equal(sentBuilds.at(-1), preemptiveSamBuildable);

const economicBuildFirstBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const existingEconomicStructure = { isUnderConstruction: () => false };
let economicUpgradeCalls = 0;
const newCityBuildable = { canBuild: 456, canUpgrade: false };
economicBuildFirstBehavior.structureSpawnEligible = () => true;
economicBuildFirstBehavior.getConstructionCost = () => 1n;
economicBuildFirstBehavior.availableGoldAfterReserve = () => 10n;
economicBuildFirstBehavior.player = { units: () => [existingEconomicStructure] };
economicBuildFirstBehavior.hasStructureUnderConstruction = () => false;
economicBuildFirstBehavior.structureSpawnTile = async () => newCityBuildable;
economicBuildFirstBehavior.structureUpgradeBeforeSpawn = async () => {
  economicUpgradeCalls++;
  return true;
};
economicBuildFirstBehavior.maybeUpgradeStructure = async () => {
  economicUpgradeCalls++;
  return true;
};
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.City),
  true,
  "An economic structure uses a legal new site before considering an upgrade",
);
assert.equal(economicUpgradeCalls, 0, "A legal new City site performs no upgrade probe");
assert.equal(sentBuilds.at(-1), newCityBuildable);

const hybridCityBuildable = { canBuild: 789, canUpgrade: 1234 };
assert.equal(
  economicBuildFirstBehavior.isUsableStructureBuildable(hybridCityBuildable, 789, UNIT.City),
  false,
  "A build probe that also targets an existing City cannot be used for a new City",
);
const hybridBuildCount = sentBuilds.length;
economicBuildFirstBehavior.structureSpawnTile = async () => hybridCityBuildable;
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.City),
  false,
  "A hybrid City descriptor cannot silently emit an upgrade through the new-build path",
);
assert.equal(
  sentBuilds.length,
  hybridBuildCount,
  "The construction actuation boundary emits no event for a hybrid descriptor",
);

economicBuildFirstBehavior.structureSpawnTile = async () => null;
economicBuildFirstBehavior.findEconomicPlacementOrExhaustion = async () => ({
  status: "indeterminate",
});
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.Factory),
  false,
  "An indeterminate bounded placement miss cannot authorize an economic upgrade",
);
assert.equal(economicUpgradeCalls, 0);
economicBuildFirstBehavior.findEconomicPlacementOrExhaustion = async () => ({
  status: "no-space",
});
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.Port),
  true,
  "A complete no-space result upgrades the requested economic structure",
);
assert.equal(economicUpgradeCalls, 1);

const directEconomicUpgradeGuard = Object.create(sandbox.__StructureBehavior.prototype);
const guardedEconomicStructure = { type: () => UNIT.City };
let directEconomicUpgradeProbeCalls = 0;
directEconomicUpgradeGuard.getTotalStructureDensity = () => 1;
directEconomicUpgradeGuard.findBestStructureToUpgrade = async () => {
  directEconomicUpgradeProbeCalls++;
  return null;
};
assert.equal(
  await directEconomicUpgradeGuard.maybeUpgradeStructure([guardedEconomicStructure]),
  false,
  "A direct economic upgrade request is rejected without a completed no-space proof",
);
assert.equal(
  directEconomicUpgradeProbeCalls,
  0,
  "The economic no-space guard runs before any upgrade selection work",
);

const foundationalCityBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const foundationalCityAttempts = [];
foundationalCityBehavior.maybeSpawnStructure = async (type) => {
  foundationalCityAttempts.push(type);
  return type === UNIT.City;
};
assert.equal(
  await foundationalCityBehavior.handleOrdinaryStructurePriorities({
    citiesDisabled: false,
    cityCount: 0,
    config: { isUnitDisabled: () => false },
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
  }),
  true,
  "The first ordinary economic action builds a City before any coastal Port",
);
assert.deepEqual(
  foundationalCityAttempts,
  [UNIT.City],
  "A zero-City opening never reaches Port/Factory priority before its City attempt",
);

const exhaustiveEconomyBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const exhaustiveStructures = [{ tile: () => 0 }];
exhaustiveEconomyBehavior.player = {
  smallID: () => 1,
  numTilesOwned: () => 4,
  borderTiles: () => new Set([0, 3]),
};
exhaustiveEconomyBehavior.structureTileValueFunction = () => (tile) => tile;
exhaustiveEconomyBehavior.structureProbeOptions = () => ({ probeTimeoutMs: 2500 });
exhaustiveEconomyBehavior.isDangerousStructureTile = () => false;
exhaustiveEconomyBehavior.buildableFor = async (type, tile) => ({
  type,
  canBuild: tile,
});
exhaustiveEconomyBehavior.isUsableStructureBuildable = (buildable) => buildable !== null;
exhaustiveEconomyBehavior.game = {
  width: () => 4,
  height: () => 1,
  ref: (x) => x,
  x: (tile) => tile,
  y: () => 0,
  isValidCoord: (x, y) => x >= 0 && x < 4 && y === 0,
  ownerID: () => 1,
  units: () => exhaustiveStructures,
  nearbyUnits: () => exhaustiveStructures,
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  config: () => ({ structureMinDist: () => 2 }),
};
const exhaustiveCityPlacement = await exhaustiveEconomyBehavior.findEconomicPlacementOrExhaustion(
  UNIT.City,
);
assert.equal(exhaustiveCityPlacement.status, "buildable");
assert.equal(exhaustiveCityPlacement.buildable.type, UNIT.City);
assert.equal(
  exhaustiveCityPlacement.buildable.canBuild,
  3,
  "The exhaustive fallback finds a legal new economic site missed by the bounded sample",
);
exhaustiveEconomyBehavior.game.width = () => 2;
assert.equal(
  (await exhaustiveEconomyBehavior.findEconomicPlacementOrExhaustion(UNIT.Factory)).status,
  "no-space",
  "Only a complete territory scan with no geometrically legal tile authorizes an upgrade",
);

const portSpaceBehavior = Object.create(sandbox.__StructureBehavior.prototype);
portSpaceBehavior.isOceanPortTile = (tile) => tile === "ocean-shore";
portSpaceBehavior.localLandStructureSpawnTile = (tile) =>
  tile === "ocean-shore" ? "snapped-port" : false;
portSpaceBehavior.isDangerousStructureTile = () => false;
const portScanContext = {
  borderTiles: ["lake-shore", "ocean-shore"],
  valueFunction: (tile) => (tile === "ocean-shore" ? 10 : 0),
};
const portScanState = () => ({
  context: portScanContext,
  index: 0,
  hasGeometricSpace: false,
  snappedSites: new Set(),
});
const portSpaceResult = portSpaceBehavior.scanAllEconomicPortSpace(UNIT.Port, portScanState());
assert.equal(portSpaceResult.status, "candidate");
assert.equal(
  portSpaceResult.tile,
  "ocean-shore",
  "An open-ocean Port site proves that new-build space remains",
);
portSpaceBehavior.isOceanPortTile = () => false;
assert.equal(
  portSpaceBehavior.scanAllEconomicPortSpace(UNIT.Port, portScanState()).status,
  "no-space",
  "Lake-only shores do not prevent a Port upgrade after open-ocean space is exhausted",
);

const changingSnapshotBehavior = Object.create(sandbox.__StructureBehavior.prototype);
changingSnapshotBehavior.economicPlacementScanState = () => ({
  context: { fingerprint: "before" },
});
changingSnapshotBehavior.scanAllLandEconomicSpace = () => ({
  status: "no-space",
});
changingSnapshotBehavior.clearEconomicPlacementScan = () => {};
changingSnapshotBehavior.economicPlacementFingerprint = () => "after";
assert.equal(
  (await changingSnapshotBehavior.findEconomicPlacementOrExhaustion(UNIT.City)).status,
  "indeterminate",
  "A territory or structure snapshot change invalidates a completed no-space proof",
);

const boundedEconomyScanBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let boundedOwnerChecks = 0;
const boundedEconomyContext = {
  bounds: { minX: 0, maxX: 99_999, minY: 0, maxY: 0 },
  game: {
    isValidCoord: () => true,
    ref: (x) => x,
    ownerID: () => {
      boundedOwnerChecks++;
      return 2;
    },
  },
  mySid: 1,
  structures: [],
  minDistSquared: 0,
  valueFunction: () => 0,
};
const boundedEconomyScan = {
  context: boundedEconomyContext,
  x: 0,
  y: 0,
  hasGeometricSpace: false,
};
assert.equal(
  boundedEconomyScanBehavior.scanAllLandEconomicSpace(UNIT.City, boundedEconomyScan).status,
  "pending",
  "A map-wide no-space proof pauses after one normal placement budget",
);
assert.equal(
  boundedOwnerChecks,
  25,
  "A single construction decision examines at most 25 exhaustive-scan coordinates",
);
assert.equal(boundedEconomyScan.x, 25, "The next decision resumes the saved scan cursor");
assert.equal(
  await launchGateBehavior.maybeUpgradePlannedSam({
    currentLevel: 1,
    targetLevel: 2,
  }),
  false,
  "No SAM upgrade can spend gold before the first hostile missile launch",
);
hostileMissileActive = true;
assert.equal(
  launchGateBehavior.hasObservedHostileMissileLaunch(),
  true,
  "An active hostile missile unlocks SAM construction",
);
hostileMissileActive = false;
assert.equal(
  launchGateBehavior.hasObservedHostileMissileLaunch(),
  true,
  "The first hostile launch remains remembered after its missile resolves",
);
const observerScanBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let observerMissileUnitScans = 0;
observerScanBehavior._hostileMissileLaunchObserved = false;
observerScanBehavior.player = own;
observerScanBehavior.game = {
  ticks: () => 700,
  units: () => {
    observerMissileUnitScans++;
    return [];
  },
};
observerScanBehavior.liveHostilePlayers = () => {
  throw new Error("launch observation must not scan hostile players or buildings");
};
assert.equal(observerScanBehavior.observeHostileMissileLaunch(), false);
assert.equal(observerScanBehavior.observeHostileMissileLaunch(), false);
assert.equal(
  observerMissileUnitScans,
  1,
  "Launch observation scans only the active missile family once per game tick",
);
const thirdPartyMirvBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const hostileMirvOwner = { smallID: () => 2 };
let observedMissileTypes = [];
thirdPartyMirvBehavior._hostileMissileLaunchObserved = false;
thirdPartyMirvBehavior.player = {
  smallID: () => 1,
  isFriendly: () => false,
  isOnSameTeam: () => false,
};
thirdPartyMirvBehavior.game = {
  ticks: () => 701,
  units: (...types) => {
    observedMissileTypes = types;
    return [
      {
        isActive: () => true,
        owner: () => hostileMirvOwner,
        // Deliberately aimed at another player: launch detection is based on
        // the hostile owner, not on whether our own territory is targeted.
        targetTile: () => 99_999,
      },
    ];
  },
};
assert.equal(
  thirdPartyMirvBehavior.observeHostileMissileLaunch(),
  true,
  "A hostile MIRV aimed at a third party unlocks SAM construction",
);
assert.deepEqual(
  observedMissileTypes,
  [UNIT.AtomBomb, UNIT.HydrogenBomb, UNIT.MIRV, UNIT.MIRVWarhead],
  "Launch observation covers every missile family that SAMs can intercept",
);
const nationExecutionSource = read("engine/ingame/auto-bot/nationExecution.js");
const tickSource =
  nationExecutionSource.match(
    /async tick\(ticks, profile, tickGeneration\) \{([\s\S]*?)\n {4}\}/,
  )?.[1] ?? "";
const launchObserverIndex = tickSource.indexOf(
  "this.structureBehavior.observeHostileMissileLaunch?.();",
);
const cadenceGateIndex = tickSource.indexOf("this.getTickCrossings(ticks)");
const launchObserverCallCount =
  nationExecutionSource.split("this.structureBehavior.observeHostileMissileLaunch?.();").length - 1;
assert.ok(
  launchObserverIndex >= 0 && launchObserverIndex < cadenceGateIndex,
  "Hostile launches are observed every authoritative tick before slower behavior cadence gates",
);
assert.equal(
  launchObserverCallCount,
  2,
  "The launch observer also runs immediately when behaviors initialize",
);

const originalEnemySilosGoldForCapacityTest = enemySilos.gold;
enemySilos.gold = () => 1_500_000n;
forecastTick = 300;
forecastCalls = 0;
behavior.getMissileDefenseContext();
forecastTick = 301;
enemySilos.gold = () => 1_500_001n;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  1,
  "Small hostile gold changes do not invalidate the short forecast bucket",
);
forecastTick = 302;
enemySilos.gold = () => 3_000_000n;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  2,
  "A hostile gold change that adds an affordable missile refreshes the forecast",
);
enemySilos.gold = originalEnemySilosGoldForCapacityTest;

behavior.game.units = () => [];
behavior._missileDefenseSignalTick = null;
behavior._activeHostileMissileTick = null;
behavior._activeHostileMissileCache = null;
const originalReactiveSignalBuildableFor = behavior.buildableFor;
let reactiveSignalProbeCalls = 0;
behavior.buildableFor = async () => {
  reactiveSignalProbeCalls++;
  return { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1_500_000n };
};
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A built hostile silo without an active missile does not trigger reactive SAM upgrade work",
);
assert.equal(
  reactiveSignalProbeCalls,
  0,
  "A built hostile silo without an active missile avoids per-SAM async probes",
);
behavior.buildableFor = originalReactiveSignalBuildableFor;
const activeHostileMissile = {
  isActive: () => true,
  owner: () => enemySilos,
};
behavior.game.units = () => [activeHostileMissile];
behavior._missileDefenseSignalTick = null;
behavior._activeHostileMissileTick = null;
behavior._activeHostileMissileCache = null;

const originalEmergencyUpgradeGold = own.gold;
const originalEmergencyUpgradeCost = behavior.cost;
const originalEmergencyUpgradeBuildableFor = behavior.buildableFor;
reactiveSam.level = () => 4;
own.gold = () => 3_000_000n;
behavior.cost = () => 5_000_000n;
behavior.buildableFor = async () => ({
  type: UNIT.SAMLauncher,
  canUpgrade: true,
  cost: 3_000_000n,
});
sentBuilds.length = 0;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  true,
  "An incoming H-bomb upgrades a level-4 SAM at the authoritative 3M price even when the planner formula says 5M",
);
assert.equal(
  sentBuilds.length,
  1,
  "The affordable level-5 emergency upgrade is sent before Legendary can spend on a Factory",
);
reactiveSam.level = () => 1;
own.gold = originalEmergencyUpgradeGold;
behavior.cost = originalEmergencyUpgradeCost;
behavior.buildableFor = originalEmergencyUpgradeBuildableFor;
behavior._missileDefenseSignalTick = null;

let forecastTickSeen = null;
const originalBuildableFor = behavior.buildableFor;
behavior.legendaryMissilePlacementContext = () => {
  forecastCalls++;
  forecastTickSeen = forecastTick;
  return { threats: [{ targetTile: 999 }] };
};
behavior.buildableFor = async () => {
  forecastTick++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 1_500_000n,
  };
};
forecastTick = 200;
forecastCalls = 0;
await behavior.maybeUpgradeMissileDefenseSam();
assert.equal(
  forecastTickSeen,
  201,
  "Reactive SAM defense forecasts after async buildable probes finish",
);
behavior.buildableFor = originalBuildableFor;
sentBuilds.length = 0;

let evaluationCalls = 0;
behavior._missileDefenseEvaluationTick = null;
behavior._missileDefenseEvaluationContext = null;
behavior._missileDefenseEvaluationCache = null;
const rawDefenseEvaluation = behavior.legendaryDefenseEvaluation;
behavior.legendaryDefenseEvaluation = (context, options = {}) => {
  if (Object.keys(options).length === 0) evaluationCalls++;
  return rawDefenseEvaluation(context, options);
};
const cachedContext = behavior.getMissileDefenseContext();
behavior.getMissileDefenseEvaluation(cachedContext);
behavior.getMissileDefenseEvaluation(cachedContext);
assert.equal(
  evaluationCalls,
  1,
  "Base missile defense evaluation is reused for the cached context",
);

let rebuiltRoutePath = null;
const cachedRoute = {
  id: "cached-route",
  weapon: UNIT.AtomBomb,
  fromTile: 1,
  targetTile: 9,
  impactTick: 20,
  launchOffset: 0,
  path: [1, 2, 3, 9],
};
behavior.legendaryBuildMissileRoute = (...args) => {
  const [route] = args;
  rebuiltRoutePath = route.path;
  return { id: route.id, path: route.path, samOptions: [] };
};
const rebuiltRoutes = behavior.legendaryRebuildMissileRoutes([cachedRoute], []);
assert.equal(rebuiltRoutes.length, 1, "Cached missile routes can be rebuilt for a new SAM profile");
assert.strictEqual(
  rebuiltRoutePath,
  cachedRoute.path,
  "SAM upgrade evaluation reuses the cached flight path instead of pathfinding again",
);

let pathfinderCalls = 0;
sandbox.UniversalPathFinding = {
  Parabola: () => {
    pathfinderCalls++;
    return { findPath: () => [1, 2, 3, 9] };
  },
};
const pathBehavior = Object.create(sandbox.__StructureBehavior.prototype);
pathBehavior.game = {
  config: () => ({ defaultNukeSpeed: () => 1 }),
};
assert.deepEqual(
  pathBehavior.legendaryNukeFlightPath(1, 9),
  [1, 2, 3, 9],
  "Missile pathfinding returns the planner trajectory",
);
assert.deepEqual(
  pathBehavior.legendaryNukeFlightPath(1, 9),
  [1, 2, 3, 9],
  "Repeated requests return the same missile trajectory",
);
assert.equal(
  pathfinderCalls,
  1,
  "Repeated missile path requests do not rerun the parabola pathfinder",
);

const metricBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const metricSilos = [makeUnit(701, 1), makeUnit(702, 1)];
let metricFlightCalls = 0;
let metricCapacityCalls = 0;
metricBehavior.legendaryFriendlySamProfiles = () => [];
metricBehavior.legendarySiloSlotAvailability = () => [0];
metricBehavior.legendarySiloCooldownTicks = () => 90;
metricBehavior.legendarySamCooldownTicks = () => 90;
metricBehavior.legendaryNukeFlightTime = () => {
  metricFlightCalls++;
  return 10;
};
metricBehavior.legendaryEnemyMissileLaunchPlan = (silos) =>
  silos.map((silo, index) => ({
    silo,
    launchTick: index,
    flightTicks: 10 + index,
    impactTick: 10 + index,
  }));
metricBehavior.legendaryNukeFlightPath = () => [1, 2, 3];
metricBehavior.legendaryBuildMissileRoute = (...routeArgs) => {
  const [fromTile, targetTile, impactTick, , launchOffset, weapon, id, path] = routeArgs;
  return {
    id,
    weapon,
    fromTile,
    targetTile,
    impactTick,
    launchOffset,
    path,
    samOptions: [],
  };
};
metricBehavior.legendarySamInterceptionCapacity = () => {
  metricCapacityCalls++;
  return 1;
};
const metricPlan = metricBehavior.legendaryMissileSalvoPlan({
  enemySilos: metricSilos,
  enemyGold: 1n,
  targetTile: 9,
  atomCost: 1n,
  hydrogenCost: 0n,
});
assert.equal(
  metricPlan.sourceMetrics.length,
  metricSilos.length,
  "Missile salvo plans expose one source metric per enemy silo",
);
assert.equal(
  metricCapacityCalls,
  metricSilos.length,
  "Each silo interception capacity is calculated once while building a salvo",
);
assert.equal(
  metricFlightCalls,
  0,
  "Salvo source metrics reuse launch-plan flight times instead of pathfinding again",
);

let placementSalvoCalls = 0;
const placementBehavior = Object.create(sandbox.__StructureBehavior.prototype);
placementBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
placementBehavior.legendaryCriticalStructureValue = () => 1;
placementBehavior.legendaryEnemyMissileLaunchPlan = () => [
  { silo: metricSilos[0], launchTick: 0, flightTicks: 10, impactTick: 10 },
  { silo: metricSilos[1], launchTick: 1, flightTicks: 11, impactTick: 12 },
];
placementBehavior.legendarySamInterceptionCapacity = () => 1;
placementBehavior.legendarySamCooldownTicks = () => 90;
placementBehavior.legendaryMissileSalvoPlan = () => {
  placementSalvoCalls++;
  throw new Error("placement scoring must not build a full salvo plan");
};
const placementRisk = placementBehavior.legendaryMissilePlacementRisk(5, UNIT.Factory, {
  atomCost: 1n,
  hydrogenCost: 0n,
  atomRadius: 10,
  hydrogenRadius: 20,
  totalValue: 10,
  structures: [makeUnit(1, 1)],
  activeMissiles: [],
  threats: [
    {
      inFlight: false,
      targetTile: 20,
      weapon: UNIT.AtomBomb,
      enemySilos: metricSilos,
      enemyGold: 2n,
      salvoPlan: {
        routes: [{ impactTick: 10 }, { impactTick: 12 }],
        readyShots: 2,
      },
    },
  ],
});
assert.ok(Number.isFinite(placementRisk), "Placement risk remains a finite score");
assert.equal(
  placementSalvoCalls,
  0,
  "Placement ranking uses the lightweight threat proxy instead of rebuilding a salvo scheduler",
);

assert.equal(
  typeof behavior.maybeUpgradeSamForSiloParity,
  "function",
  "Structure behavior exposes the proactive SAM-vs-Silo level upgrade path",
);
assert.equal(
  behavior.ownMaximumSamLevel(),
  1,
  "Only built own SAM levels count toward immediate parity",
);
own.sams = [makeUnit(403, 3), makeUnit(404, 3)];
assert.equal(
  behavior.samLevelParityGap(),
  0,
  "SAM parity uses total own interceptor capacity instead of only the highest SAM",
);
own.sams = [makeUnit(403, 3), makeUnit(404, 2)];
assert.equal(
  behavior.samLevelParityGap(),
  1,
  "SAM parity reports the remaining capacity gap against the strongest hostile network",
);
own.sams = [reactiveSam];
assert.equal(behavior.samLevelParityGap(), 5, "SAM parity reports the missing capacity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "A SAM is upgraded when the strongest hostile Silo network exceeds our own capacity",
);
assert.equal(sentBuilds.length, 1, "Proactive SAM parity emits one upgrade");
own.sams = [makeUnit(402, 6)];
assert.equal(behavior.samLevelParityGap(), 0, "A single SAM at the target level closes SAM parity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not repeat an upgrade once one SAM reaches the target",
);
const originalPlayersForSingleSiloParity = behavior.game.players;
const originalOwnSamsForSingleSiloParity = own.sams;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
own.sams = [makeUnit(408, 1)];
sentBuilds.length = 0;
assert.equal(
  behavior.samLevelParityTarget(),
  1,
  "A single level-1 hostile Silo creates only a level-1 SAM parity target",
);
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "A matching level-1 SAM is not upgraded merely because an enemy owns a Silo",
);
assert.equal(sentBuilds.length, 0, "A matching level-1 hostile-Silo parity check emits no upgrade");
behavior.game.players = originalPlayersForSingleSiloParity;
own.sams = originalOwnSamsForSingleSiloParity;
own.sams = [makeUnit(405, 3), makeUnit(406, 2), makeUnit(407, 2)];
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  false,
  "An existing SAM prevents hostile Silo count from multiplying defensive sites",
);
own.sams = [makeUnit(405, 1)];
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  false,
  "Multiple hostile Silos create upgrade pressure instead of one new SAM per Silo",
);
own.sams = [reactiveSam];
sentBuilds.length = 0;
const originalReactiveReserve = behavior.legendaryReserveGold;
const originalReactiveGold = own.gold;
behavior.legendaryReserveGold = () => 25_000_000n;
own.gold = () => 20_000_000n;

assert.equal(
  typeof behavior.maybeUpgradeMissileDefenseSam,
  "function",
  "Structure behavior exposes the non-Legendary reactive SAM upgrade path",
);
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  true,
  "A SAM is upgraded when one level turns an unresolved incoming threat into a defended route",
);
assert.equal(sentBuilds.length, 1, "Reactive defense emits exactly one SAM upgrade");
state.settings.buildStructures[UNIT.SAMLauncher] = false;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A user-disabled SAM type is never upgraded by the reactive path",
);
delete state.settings.buildStructures[UNIT.SAMLauncher];
samDisabled = true;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A SAM type disabled by game configuration is never upgraded",
);
samDisabled = false;
behavior.legendaryReserveGold = originalReactiveReserve;
own.gold = originalReactiveGold;

const originalActiveMissileSignal = behavior.missileDefenseSignalSnapshot;
const originalActiveMissileContext = behavior.activeMissileDefenseContext;
const originalDefenseEvaluation = behavior.legendaryDefenseEvaluation;
const originalMaybeUpgradeMissileDefenseSam = behavior.maybeUpgradeMissileDefenseSam;
const originalActiveMissileMaybeSpawnStructure = behavior.maybeSpawnStructure;
const originalActiveMissileHydrogenPlan = behavior.hydrogenSamProtectionPlan;
behavior.missileDefenseSignalSnapshot = () => ({ hasActiveHostileMissile: true });
behavior.activeMissileDefenseContext = () => ({
  threats: [{ inFlight: true }],
});
behavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: false,
});
let activeMissileUpgradeContext = null;
behavior.maybeUpgradeMissileDefenseSam = async (context) => {
  activeMissileUpgradeContext = context;
  return false;
};
behavior.hydrogenSamProtectionPlan = () => null;
let activeMissileSpawnOptions = null;
behavior.maybeSpawnStructure = async (type, options) => {
  assert.equal(type, UNIT.SAMLauncher, "Active missile defense only requests a SAM");
  activeMissileSpawnOptions = options;
  return false;
};
own.sams = [reactiveSam];
assert.equal(
  await behavior.handleActiveMissileSamMaximumPriority(),
  false,
  "An unresolved airborne missile reserves the construction slot when placement is not yet possible",
);
assert.equal(
  activeMissileUpgradeContext,
  activeMissileSpawnOptions.missileDefenseContext,
  "Upgrade and placement score the same active-missile-only trajectory context",
);
assert.equal(
  activeMissileSpawnOptions.forceNewStructure,
  true,
  "A geometrically useless existing SAM permits a new defensive site",
);
assert.equal(
  activeMissileSpawnOptions.activeMissileDefense,
  true,
  "Active missile placement enables trajectory candidate selection",
);

let prospectiveThreatCalls = 0;
const originalActiveMissileBaseContext = behavior.legendaryMissilePlacementBaseContext;
const originalActiveMissileThreats = behavior.legendaryActiveMissileThreats;
const originalProspectiveMissileThreat = behavior.legendaryEnemyMissileThreat;
const originalActiveMissileSamProfiles = behavior.legendaryFriendlySamProfiles;
behavior.legendaryMissilePlacementBaseContext = () => ({
  atomCost: 1n,
  hydrogenCost: 2n,
  atomRadius: 10,
  hydrogenRadius: 20,
  structures: [],
  totalValue: 0,
  priorityStructures: [],
});
behavior.legendaryActiveMissileThreats = () => [
  {
    inFlight: true,
    score: 4,
    targetTile: 321,
  },
];
behavior.legendaryFriendlySamProfiles = () => [];
behavior.legendaryEnemyMissileThreat = () => {
  prospectiveThreatCalls++;
  return null;
};
const activeOnlyContext = originalActiveMissileContext.call(behavior);
assert.deepEqual(
  activeOnlyContext.threats.map((threat) => threat.targetTile),
  [321],
  "Active missile defense preserves the observed in-flight threat",
);
assert.equal(
  prospectiveThreatCalls,
  0,
  "Active missile defense does not construct irrelevant hostile-silo forecasts",
);
behavior.legendaryMissilePlacementBaseContext = originalActiveMissileBaseContext;
behavior.legendaryActiveMissileThreats = originalActiveMissileThreats;
behavior.legendaryEnemyMissileThreat = originalProspectiveMissileThreat;
behavior.legendaryFriendlySamProfiles = originalActiveMissileSamProfiles;

behavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: true,
});
activeMissileSpawnOptions = null;
assert.equal(
  await behavior.handleActiveMissileSamMaximumPriority(),
  null,
  "A fully defended airborne missile does not multiply SAM sites",
);
assert.equal(activeMissileSpawnOptions, null, "No redundant SAM placement is attempted");

const originalThreatOwnerId = behavior.game.ownerID;
behavior.game.ownerID = () => own.smallID();
const activeRouteTiles = behavior.prependActiveMissileRouteTiles([99, 100], 6, {
  threats: [
    {
      inFlight: true,
      salvoPlan: { routes: [{ path: [10, 20, 30] }] },
    },
  ],
});
assert.deepEqual(
  Array.from(activeRouteTiles),
  [30, 20, 10, 99, 100],
  "Active missile placement searches from impact backward while preserving fallback capacity",
);

const originalScoredActiveMissileThreat = behavior.legendaryScoredActiveMissileThreat;
behavior.game.ownerID = (tile) => (tile === 777 ? own.smallID() : 0);
behavior.legendaryScoredActiveMissileThreat = (input) => input;
const territoryOnlyThreat = behavior.legendaryActiveMissileThreat(
  {
    isActive: () => true,
    owner: () => ({ smallID: () => 1234 }),
    targetTile: () => 777,
    tile: () => 700,
    type: () => UNIT.AtomBomb,
  },
  own.smallID(),
  {
    atomRadius: 10,
    hydrogenRadius: 20,
    structures: [],
    totalValue: 0,
  },
  [],
);
assert.equal(
  territoryOnlyThreat.exposure.targetsOwnedTerritory,
  true,
  "A hostile nuclear strike on owned territory remains a threat without exposed structures",
);
assert.equal(
  territoryOnlyThreat.exposure.value,
  1,
  "Territorial connectivity receives non-zero defensive value",
);
behavior.game.ownerID = originalThreatOwnerId;
behavior.legendaryScoredActiveMissileThreat = originalScoredActiveMissileThreat;

const originalThreatGameUnits = behavior.game.units;
let enumeratedActiveMissileTypes = [];
behavior.game.units = (...types) => {
  enumeratedActiveMissileTypes = types;
  return [];
};
behavior.legendaryActiveMissileThreats({ samProfiles: [] });
assert.deepEqual(
  Array.from(enumeratedActiveMissileTypes),
  [UNIT.AtomBomb, UNIT.HydrogenBomb],
  "Generic trajectory interception enumerates only Atom and Hydrogen bombs",
);
behavior.activeMirvDefenseDemands();
assert.deepEqual(
  Array.from(enumeratedActiveMissileTypes),
  [UNIT.MIRV, UNIT.MIRVWarhead],
  "MIRV carriers and warheads use the dedicated destination-geometry model",
);
let requestedMirvBlastType = null;
const mirvImpactZone = behavior.hostileMissileImpactZone(
  {
    isActive: () => true,
    owner: () => ({ smallID: () => 1234 }),
    targetTile: () => 777,
    type: () => UNIT.MIRV,
  },
  {
    nukeMagnitudes: (type) => {
      requestedMirvBlastType = type;
      return { outer: 18 };
    },
  },
  own.smallID(),
);
assert.equal(
  requestedMirvBlastType,
  null,
  "A MIRV carrier never requests an unsupported direct-blast magnitude",
);
assert.equal(mirvImpactZone, null, "Only separated MIRV warheads create exact impact zones");
const originalMirvPlayerUnits = own.units;
const originalMirvDistance = behavior.game.euclideanDistSquared;
own.units = (...types) =>
  types.includes(UNIT.City)
    ? [makeUnit(120, 1), makeUnit(5000, 1)]
    : originalMirvPlayerUnits(...types);
behavior.game.euclideanDistSquared = (left, right) => (left - right) ** 2;
const carrierSiteDemands = [];
behavior.appendMirvCarrierSiteDemands(carrierSiteDemands, { id: () => 9000 }, 100, 200);
assert.deepEqual(
  carrierSiteDemands.map((demand) => demand.targetTile),
  [120],
  "A MIRV carrier creates preparation demand for each exposed strategic site, not one false central target",
);
assert.equal(
  carrierSiteDemands[0].carrierPreparation,
  true,
  "Carrier preparation remains distinct from exact separated-warhead destinations",
);
const originalMirvManhattanDistance = behavior.game.manhattanDist;
behavior.game.manhattanDist = () => 49;
const mirvDeadlineBoundary = { targetTile: 120, deadlineTick: 100 };
assert.equal(
  behavior.samTileCoversMirvDemand(100, mirvDeadlineBoundary, 95),
  true,
  "A MIRV SAM slot ready exactly at the five-tick safety boundary is usable",
);
assert.equal(
  behavior.samTileCoversMirvDemand(100, mirvDeadlineBoundary, 96),
  false,
  "A MIRV SAM slot ready one tick inside the safety boundary is not coverage",
);
behavior.game.manhattanDist = originalMirvManhattanDistance;
own.units = originalMirvPlayerUnits;
behavior.game.euclideanDistSquared = originalMirvDistance;
behavior.game.units = originalThreatGameUnits;

const originalConstructionDuration = behavior.legendaryConstructionDuration;
const originalPendingEvaluation = behavior.legendaryDefenseEvaluation;
const originalPendingGameTicks = behavior.game.ticks;
behavior.legendaryConstructionDuration = () => 5;
behavior.legendaryDefenseEvaluation = (_context, options) => ({
  hasThreats: true,
  fullyDefended: false,
  uninterceptedCount: options.extraSam.tile === 2222 ? 1 : 2,
  minimumInterceptMarginTicks: 0,
});
const pendingCurrentEvaluation = {
  hasThreats: true,
  fullyDefended: false,
  uninterceptedCount: 2,
  minimumInterceptMarginTicks: 0,
};
behavior.legendaryConstructionDuration = () => 100;
behavior.game.ticks = () => 150;
const nearlyBuiltSam = makeUnit(3333, 1, { underConstruction: true });
nearlyBuiltSam.__src = { state: { constructionStartTick: 75 } };
assert.equal(
  behavior.pendingSamRemainingConstructionTicks(nearlyBuiltSam),
  25,
  "Pending defense uses remaining construction time instead of restarting the full duration",
);
behavior.legendaryConstructionDuration = () => 5;
own.sams = [makeUnit(1111, 1, { underConstruction: true })];
assert.equal(
  behavior.activeMissilePendingSamImproves({}, pendingCurrentEvaluation),
  false,
  "An unrelated SAM under construction does not block a useful defensive site",
);
own.sams = [makeUnit(2222, 1, { underConstruction: true })];
assert.equal(
  behavior.activeMissilePendingSamImproves({}, pendingCurrentEvaluation),
  true,
  "A pending SAM that reduces uncovered missiles suppresses redundant placement",
);
behavior.legendaryConstructionDuration = originalConstructionDuration;
behavior.legendaryDefenseEvaluation = originalPendingEvaluation;
behavior.game.ticks = originalPendingGameTicks;

const originalIncrementalSamImprovement = behavior.activeMissileSamConstructionImproves;
const originalUncoveredMirvDemands = behavior.uncoveredActiveMirvDemands;
const originalMirvEmergencyEvaluation = behavior.legendaryDefenseEvaluation;
behavior.uncoveredActiveMirvDemands = () => [{ targetTile: 777 }];
behavior.legendaryDefenseEvaluation = () => ({
  hasThreats: false,
  fullyDefended: true,
});
const mirvOnlyEmergency = behavior.structureMissileEmergency(UNIT.SAMLauncher, {
  activeMissileDefense: true,
  missileDefenseContext: { threats: [] },
});
assert.equal(mirvOnlyEmergency.samDefense, true, "A MIRV-only demand activates SAM safety gating");
assert.equal(
  mirvOnlyEmergency.incrementalSamDefense,
  true,
  "Every MIRV-only candidate must prove destination coverage",
);
behavior.uncoveredActiveMirvDemands = originalUncoveredMirvDemands;
behavior.legendaryDefenseEvaluation = originalMirvEmergencyEvaluation;
behavior.activeMissileSamConstructionImproves = (tile) => tile === 42;
const incrementalEmergency = {
  active: true,
  samDefense: true,
  incrementalSamDefense: true,
  context: {},
  evaluation: {},
};
assert.equal(
  behavior.structureEmergencyTileAllowed(41, UNIT.SAMLauncher, incrementalEmergency),
  false,
  "An active-missile SAM candidate that improves no trajectory is rejected",
);
assert.equal(
  behavior.structureEmergencyTileAllowed(42, UNIT.SAMLauncher, incrementalEmergency),
  true,
  "A SAM candidate may make one measurable step across simultaneous trajectories",
);
behavior.activeMissileSamConstructionImproves = originalIncrementalSamImprovement;
own.sams = [reactiveSam];

behavior.missileDefenseSignalSnapshot = originalActiveMissileSignal;
behavior.activeMissileDefenseContext = originalActiveMissileContext;
behavior.legendaryDefenseEvaluation = originalDefenseEvaluation;
behavior.maybeUpgradeMissileDefenseSam = originalMaybeUpgradeMissileDefenseSam;
behavior.maybeSpawnStructure = originalActiveMissileMaybeSpawnStructure;
behavior.hydrogenSamProtectionPlan = originalActiveMissileHydrogenPlan;

// The dedicated hostile-silo SAM path is covered above; the wiring tests can
// now exercise the proactive parity branch before ordinary construction.
const originalActiveMissileMaximumPriority = behavior.handleActiveMissileSamMaximumPriority;
const originalMaybeSpawnHostileSiloSam = behavior.maybeSpawnHostileSiloSam;
const originalHostileSiloSamMaximumPriority = behavior.handleHostileSiloSamMaximumPriority;
const originalHydrogenStructureCoverage = behavior.maybeEnsureHydrogenStructureCoverage;
const originalHydrogenSiloUpgrade = behavior.maybeUpgradeHydrogenProtectionSam;
behavior.maybeSpawnHostileSiloSam = async () => false;
behavior.handleActiveMissileSamMaximumPriority = async () => null;
behavior.handleHostileSiloSamMaximumPriority = async () => null;
let wiredStructureCoverageCalls = 0;
behavior.maybeEnsureHydrogenStructureCoverage = async () => {
  wiredStructureCoverageCalls++;
  return true;
};
behavior.maybeUpgradeHydrogenProtectionSam = async () => false;
let wiredParityCalls = 0;
behavior.maybeUpgradeMissileDefenseSam = async () => false;
behavior.maybeUpgradeSamForSiloParity = async () => {
  wiredParityCalls++;
  return true;
};
behavior.placementsCount = 0;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks proactive SAM/Silo level parity",
);
assert.equal(
  wiredStructureCoverageCalls,
  1,
  "Full structure H-bomb coverage is checked before SAM/Silo parity",
);
assert.equal(wiredParityCalls, 0, "Higher-priority structure coverage stops lower priorities");

behavior.maybeEnsureHydrogenStructureCoverage = async () => false;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks proactive SAM/Silo level parity",
);
assert.equal(wiredParityCalls, 1, "The proactive SAM parity path is wired into handleStructures");

let wiredUpgradeCalls = 0;
behavior.maybeUpgradeMissileDefenseSam = async () => {
  wiredUpgradeCalls++;
  return true;
};
behavior.placementsCount = 0;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks reactive SAM upgrades before ordinary construction",
);
assert.equal(wiredUpgradeCalls, 1, "The reactive SAM path is wired into handleStructures");
behavior.maybeSpawnHostileSiloSam = originalMaybeSpawnHostileSiloSam;
behavior.handleActiveMissileSamMaximumPriority = originalActiveMissileMaximumPriority;
behavior.handleHostileSiloSamMaximumPriority = originalHostileSiloSamMaximumPriority;
behavior.maybeEnsureHydrogenStructureCoverage = originalHydrogenStructureCoverage;
behavior.maybeUpgradeHydrogenProtectionSam = originalHydrogenSiloUpgrade;

const economicBudgetBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const economicCandidateLimits = [];
economicBudgetBehavior._economicPlacementDecisionBudget = 25;
economicBudgetBehavior.structureProbeOptions = () => ({
  candidateLimit: 25,
  probeLimit: 25,
  probeTimeoutMs: 1,
  parallelProbeCount: 1,
});
economicBudgetBehavior.structureCandidateTiles = (_type, _options, limit) => {
  economicCandidateLimits.push(limit);
  return Array.from({ length: limit }, (_, index) => index);
};
economicBudgetBehavior.structureTileValueFunction = () => () => 0;
economicBudgetBehavior.structurePlacementCompactnessRanker = () => null;
economicBudgetBehavior.structureMissileEmergency = () => null;
economicBudgetBehavior.isDangerousStructureTile = () => false;
economicBudgetBehavior.probeRankedStructureTiles = async () => null;
assert.equal(await economicBudgetBehavior.structureSpawnTile(UNIT.Factory), null);
assert.equal(
  await economicBudgetBehavior.structureSpawnTile(UNIT.City),
  null,
  "the same construction decision does not grant a second economic placement budget",
);
assert.deepEqual(
  economicCandidateLimits,
  [25],
  "all economic placement attempts share the normal 25-candidate decision budget",
);

const samCoverageGuardBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const ownProtectedStructure = { tile: () => 20 };
const alliedProtectedStructure = { tile: () => 30 };
const enemyProtectedStructure = { tile: () => 40 };
const guardedPlayer = {
  isPlayer: () => true,
  smallID: () => 1,
  isFriendly: (other) => other.smallID() === 2,
  units: (type) => (type === UNIT.City ? [ownProtectedStructure] : []),
};
const alliedPlayer = {
  isPlayer: () => true,
  smallID: () => 2,
  units: (type) => (type === UNIT.Factory ? [alliedProtectedStructure] : []),
};
const enemyPlayer = {
  isPlayer: () => true,
  smallID: () => 3,
  units: (type) => (type === UNIT.Port ? [enemyProtectedStructure] : []),
};
samCoverageGuardBehavior.player = guardedPlayer;
samCoverageGuardBehavior.game = {
  players: () => [guardedPlayer, alliedPlayer, enemyPlayer],
  config: () => ({ samRange: () => 5, defaultSamRange: () => 5 }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
assert.deepEqual(
  Array.from(samCoverageGuardBehavior.samProtectableStructureTiles()).sort((a, b) => a - b),
  [20, 30],
  "a preventive SAM protects own and allied productive structures, never enemy structures",
);
assert.equal(
  samCoverageGuardBehavior.samPlacementProtectsStructure(25, new Set([20, 30])),
  true,
  "a SAM site that covers an own structure remains eligible",
);
assert.equal(
  samCoverageGuardBehavior.samPlacementProtectsStructure(100, new Set([20, 30])),
  false,
  "a SAM site with no protected structure in range is rejected",
);
const guardedSamCandidates = [];
samCoverageGuardBehavior.structureProbeOptions = () => ({
  candidateLimit: 2,
  probeLimit: 2,
  probeTimeoutMs: 1,
  parallelProbeCount: 1,
});
samCoverageGuardBehavior.structureCandidateTiles = () => [100, 25];
samCoverageGuardBehavior.structureTileValueFunction = () => (tile) => tile;
samCoverageGuardBehavior.structurePlacementCompactnessRanker = () => null;
samCoverageGuardBehavior.structureMissileEmergency = () => null;
samCoverageGuardBehavior.isDangerousStructureTile = () => false;
samCoverageGuardBehavior.probeRankedStructureTiles = async (scored) => {
  guardedSamCandidates.push(scored.map(({ t }) => t));
  return null;
};
assert.equal(await samCoverageGuardBehavior.structureSpawnTile(UNIT.SAMLauncher), null);
assert.deepEqual(
  guardedSamCandidates.pop(),
  [25],
  "ordinary and hostile-silo SAM routes cannot select an empty coastal site",
);
assert.equal(
  await samCoverageGuardBehavior.structureSpawnTile(UNIT.SAMLauncher, {
    activeMissileDefense: true,
  }),
  null,
);
assert.deepEqual(
  guardedSamCandidates.pop(),
  [100, 25],
  "a live-missile emergency retains its trajectory-specific placement candidates",
);

const samNetworkBehavior = Object.create(sandbox.__StructureBehavior.prototype);
samNetworkBehavior.game = {
  config: () => ({ samRange: (level) => Number(level) * 10 }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
samNetworkBehavior.legendaryFriendlySamUnits = () => [{ tile: () => 0, level: () => 1 }];
const samNetworkScore = samNetworkBehavior.friendlyUsefulSamPlacementScore(new Set([10, 20]), 8);
assert.ok(
  samNetworkScore(15) > 0,
  "a new SAM prefers a site near a friendly umbrella when it adds coverage to an asset the umbrella reaches after an upgrade",
);
assert.equal(
  samNetworkScore(5),
  0,
  "a new SAM does not clump inside a friendly umbrella when it adds no coverage",
);
assert.equal(samNetworkScore(30), 0, "a distant SAM receives no friendly-network preference");

process.stdout.write("SAM DEFENSE POLICY TESTS OK\n");
