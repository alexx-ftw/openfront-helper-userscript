import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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
  setLastAction: () => {},
  tr: (value) => value,
  console,
};
sandbox.globalThis = sandbox;

vm.runInNewContext(
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
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(501, enemyTeamSamLevel)] : []),
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
own.units = (type) => {
  if (type === UNIT.MissileSilo) return own.silos;
  if (type === UNIT.SAMLauncher) return own.sams;
  return [];
};
let samDisabled = false;

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
behavior.player = own;
behavior.game = {
  players: () => [own, enemyA, enemyB, enemyC, enemyTeam, enemySilos, enemySiloUnderConstruction],
  config: () => ({
    isUnitDisabled: (type) => type === UNIT.SAMLauncher && samDisabled,
  }),
};

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
  behavior.shouldBuildStructure(UNIT.MissileSilo, 10, false),
  false,
  "New silo construction is deferred below the hostile 1M-gold threshold",
);
enemyB.gold = () => 1_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  true,
  "The silo-gold gate opens at exactly 1M hostile gold",
);
assert.equal(
  behavior.shouldPrioritizeEconomicGrowth(),
  false,
  "Economic priority ends once a hostile reaches the silo threshold",
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
const originalEnemySilosUnits = enemySilos.units;
enemySilos.units = () => [];
enemyB.gold = () => 1_500_000n;
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "The mandatory SAM trigger opens at exactly 1.5M hostile gold",
);
enemyB.gold = () => 1_499_999n;
assert.equal(
  behavior.hasHostileSiloThreat(),
  false,
  "Gold below 1.5M does not trigger the mandatory SAM without a built silo",
);
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
behavior._hostileSiloSamBuilt = false;
const hostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  hostileSamCalls.push(args);
  return true;
};
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A hostile silo threat requests one dedicated SAM",
);
assert.equal(
  behavior._hostileSiloSamBuilt,
  true,
  "A successful threat SAM request is not repeated every tick",
);
assert.deepEqual(
  hostileSamCalls.map(([type, options]) => [
    type,
    {
      forceNewStructure: options.forceNewStructure,
      prioritizeStructureCoverage: options.prioritizeStructureCoverage,
    },
  ]),
  [[UNIT.SAMLauncher, { forceNewStructure: true, prioritizeStructureCoverage: true }]],
  "The dedicated SAM request forces a new structure and coverage ranking",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "The dedicated threat SAM is built only once per behavior instance",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamBuilt = false;
const originalOwnUnits = own.units;
const originalGameConfig = behavior.game.config;
const originalEuclideanDistSquared = behavior.game.euclideanDistSquared;
const protectedStructures = [
  { type: () => UNIT.City, tile: () => 10 },
  { type: () => UNIT.Factory, tile: () => 20 },
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
own.units = originalOwnUnits;
behavior.game.config = originalGameConfig;
behavior.game.euclideanDistSquared = originalEuclideanDistSquared;
const originalGetPerceivedCost = behavior.getPerceivedCost;
const originalStructureSpawnTile = behavior.structureSpawnTile;
const originalGetTotalStructureDensity = behavior.getTotalStructureDensity;
behavior.getPerceivedCost = () => 0n;
behavior.structureSpawnTile = async () => ({ canBuild: true });
behavior.getTotalStructureDensity = () => 0;
const buildsBeforeSiloGate = sentBuilds.length;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  false,
  "The direct silo spawn path is blocked below the hostile 1M-gold threshold",
);
enemyB.gold = () => 1_000_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  true,
  "The direct silo spawn path reopens at the hostile 1M-gold threshold",
);
assert.equal(
  sentBuilds.length,
  buildsBeforeSiloGate + 1,
  "Only the threshold-opened direct silo attempt reaches the build menu",
);
enemyB.gold = () => 999_999n;
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
own.gold = () => 5_000_000n;
behavior.getMissileDefenseContext();
behavior.getMissileDefenseContext();
assert.equal(forecastCalls, 1, "Missile defense context is reused within one game tick");
forecastTick++;
behavior.getMissileDefenseContext();
assert.equal(forecastCalls, 2, "Missile defense context refreshes when the game tick advances");
own.sams = [makeUnit(402, 1)];
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  3,
  "Missile defense context refreshes when a SAM changes within one game tick",
);
own.sams = [reactiveSam];
enemyTeamSamLevel = 13;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  4,
  "Missile defense context refreshes when an allied SAM changes within one game tick",
);
enemyTeamSamLevel = 12;

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
  rebuiltRoutePath = args[7];
  return { id: args[6], path: args[7], samOptions: [] };
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
metricBehavior.legendaryBuildMissileRoute = (
  fromTile,
  targetTile,
  impactTick,
  _samProfiles,
  launchOffset,
  weapon,
  id,
  path,
) => ({
  id,
  weapon,
  fromTile,
  targetTile,
  impactTick,
  launchOffset,
  path,
  samOptions: [],
});
metricBehavior.legendarySamInterceptionCapacity = () => {
  metricCapacityCalls++;
  return 1;
};
const metricPlan = metricBehavior.legendaryMissileSalvoPlan(metricSilos, 1n, 9, 1n, 0n);
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
assert.equal(behavior.samLevelParityGap(), 5, "SAM parity reports the missing level gap");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "A SAM is upgraded when the strongest hostile Silo level sum exceeds our highest SAM",
);
assert.equal(sentBuilds.length, 1, "Proactive SAM parity emits one upgrade");
own.sams = [makeUnit(402, 6)];
assert.equal(behavior.samLevelParityGap(), 0, "A single SAM at the target level closes SAM parity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not repeat an upgrade once one SAM reaches the target",
);
own.sams = [reactiveSam];
sentBuilds.length = 0;

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

// The dedicated hostile-silo SAM path is covered above; suppress its one-shot
// action here so the wiring tests can exercise the existing parity branches.
behavior._hostileSiloSamBuilt = true;
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

console.log("SAM DEFENSE POLICY TESTS OK");
