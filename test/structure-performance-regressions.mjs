import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const source = readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js");
const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
};
const sandbox = {
  Difficulty: { Impossible: "Impossible" },
  GameMode: { Team: "Team" },
  UNIT,
  currentDifficulty: () => "Impossible",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => false,
  legendaryPlacementProximityScore: (distance, radius) =>
    Math.max(0, 1 - distance / Math.max(1, radius)),
  legendaryMissileDefenseSchedule: () => ({
    fullyDefended: true,
    forecastComplete: true,
    missiles: [],
  }),
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
sandbox.globalThis = sandbox;
executeClassicScript(`${source}\nglobalThis.StructureBehavior = StructureBehavior;`, sandbox, {
  filename: "structureBehavior.js",
});

const factoryBehavior = Object.create(sandbox.StructureBehavior.prototype);
factoryBehavior.factoryTradeDestinationsCache = null;
let destinationCollections = 0;
let destinationClusterings = 0;
factoryBehavior.collectFactoryTradeDestinations = () => {
  destinationCollections++;
  return [{ tile: 1, weight: 1, key: "city" }];
};
factoryBehavior.proximityStationClusters = (_game, destinations) => {
  destinationClusterings++;
  return destinations;
};
const factoryCacheStartedAt = performance.now();
for (let candidate = 0; candidate < 256; candidate++) {
  factoryBehavior.getOrBuildFactoryTradeDestinations();
}
const factoryCacheDurationMs = performance.now() - factoryCacheStartedAt;
assert.equal(
  destinationCollections,
  1,
  "all Factory candidates in one construction decision reuse one destination snapshot",
);
assert.equal(destinationClusterings, 1);

let tick = 100;
let globalStructureReads = 0;
let structureRecordReads = 0;
const structures = Array.from({ length: 12000 }, (_, index) => ({
  type: () => {
    structureRecordReads++;
    return index % 2 === 0 ? UNIT.City : UNIT.Factory;
  },
  id: () => {
    structureRecordReads++;
    return index;
  },
  tile: () => {
    structureRecordReads++;
    return index + 1;
  },
  level: () => {
    structureRecordReads++;
    return 1;
  },
  isUnderConstruction: () => {
    structureRecordReads++;
    return false;
  },
}));
const fingerprintBehavior = Object.create(sandbox.StructureBehavior.prototype);
let borderIterations = 0;
const borderSnapshot = {
  size: 4,
  [Symbol.iterator]: () => {
    borderIterations++;
    return [4, 3, 2, 1][Symbol.iterator]();
  },
};
fingerprintBehavior.game = {
  ticks: () => tick,
  config: () => ({ structureMinDist: () => 12 }),
  units: () => {
    globalStructureReads++;
    return structures;
  },
};
fingerprintBehavior.player = {
  smallID: () => 1,
  numTilesOwned: () => 50000,
  borderTiles: () => borderSnapshot,
};
const fingerprintStartedAt = performance.now();
for (let call = 0; call < 64; call++) {
  fingerprintBehavior.economicPlacementFingerprint(UNIT.Factory);
}
const fingerprintDurationMs = performance.now() - fingerprintStartedAt;
assert.equal(
  globalStructureReads,
  1,
  "same-tick economic scan validation sorts the global structure snapshot once",
);
assert.equal(
  structureRecordReads,
  0,
  "economic scan validation uses the aggregate structure count instead of serializing every structure",
);
assert.equal(
  borderIterations,
  0,
  "economic scan validation reads the border cardinality without sorting every border tile",
);
assert.ok(
  fingerprintDurationMs < 50,
  `64 late-game fingerprint checks took ${fingerprintDurationMs.toFixed(1)}ms`,
);
tick++;
fingerprintBehavior.economicPlacementFingerprint(UNIT.Factory);
assert.equal(
  globalStructureReads,
  2,
  "a new game tick refreshes the economic placement fingerprint",
);

let coverageDistanceReads = 0;
let coverageValueReads = 0;
let coverageSamRangeReads = 0;
const coverageStructures = Array.from({ length: 5000 }, () => ({
  tile: () => 0,
}));
const coverageSams = Array.from({ length: 128 }, (_, index) => ({
  tile: () => 0,
  level: () => (index % 2) + 1,
}));
const coverageBehavior = Object.create(sandbox.StructureBehavior.prototype);
coverageBehavior.game = {
  config: () => ({
    defaultSamRange: () => 10,
    samRange: () => {
      coverageSamRangeReads++;
      return 10;
    },
  }),
  euclideanDistSquared: () => {
    coverageDistanceReads++;
    return 0;
  },
};
coverageBehavior.player = { units: () => coverageStructures };
coverageBehavior.legendaryFriendlySamUnits = () => coverageSams;
coverageBehavior.spacingConstants = () => ({ structureSpacing: 1 });
coverageBehavior.legendaryCriticalStructureValue = () => {
  coverageValueReads++;
  return 1;
};
coverageBehavior.legendarySamImpactMarginScore = () => 0;
coverageBehavior.structureSpawnTileValue = () => () => 0;
coverageBehavior.getMissileDefenseContext = () => ({ critical: false });
coverageBehavior.legendaryMissilePlacementRisk = () => 0;
coverageBehavior.legendaryAllyPlacementContext = () => null;
coverageBehavior.legendaryTeamCenterPlacementContext = () => null;
const coverageStructureMap = coverageStructures.map;
let coverageStructureMapCalls = 0;
coverageStructures.map = (...args) => {
  coverageStructureMapCalls++;
  return coverageStructureMap.apply(coverageStructures, args);
};
const coverageSamMap = coverageSams.map;
let coverageSamMapCalls = 0;
coverageSams.map = (...args) => {
  coverageSamMapCalls++;
  return coverageSamMap.apply(coverageSams, args);
};
let coverageContextBuilds = 0;
let coverageContext = null;
const buildCoverageContext =
  coverageBehavior.legendarySamCoveragePlacementContext.bind(coverageBehavior);
coverageBehavior.legendarySamCoveragePlacementContext = () => {
  coverageContextBuilds++;
  coverageContext = buildCoverageContext();
  return coverageContext;
};
const samPlacementValue = coverageBehavior.legendaryStructureSpawnTileValue(UNIT.SAMLauncher);
const coverageStartedAt = performance.now();
for (let candidate = 0; candidate < 64; candidate++) {
  samPlacementValue(candidate);
}
delete coverageStructures.map;
delete coverageSams.map;
const coverageDurationMs = performance.now() - coverageStartedAt;
assert.equal(
  coverageContext.uncoveredStructures.length,
  0,
  "the placement context removes structures already covered by existing SAMs",
);
assert.equal(
  coverageDistanceReads,
  coverageStructures.length,
  "repeated SAM candidates reuse the existing-SAM coverage snapshot",
);
assert.equal(
  coverageSamRangeReads,
  2,
  "SAM coverage contexts resolve each configured SAM range once per level",
);
assert.equal(
  coverageStructureMapCalls,
  0,
  "SAM coverage contexts snapshot structures without a mapped copy",
);
assert.equal(
  coverageSamMapCalls,
  0,
  "SAM coverage contexts snapshot existing SAMs without a mapped copy",
);
assert.equal(
  coverageValueReads,
  0,
  "covered structures do not trigger repeated critical-value reads",
);
assert.equal(
  coverageContextBuilds,
  1,
  "the real SAM placement scorer builds one coverage context for all candidates",
);
assert.ok(
  coverageDurationMs < 50,
  `64 SAM coverage candidates took ${coverageDurationMs.toFixed(1)}ms`,
);

let routeTargetableRangeReads = 0;
const routePath = Array.from({ length: 96 }, (_, index) => ({
  kind: "path",
  index,
}));
const routeProfiles = Array.from({ length: 8 }, (_, index) => ({
  id: `sam-${index}`,
  tile: { kind: "sam", index },
  level: 1,
}));
const routeBehavior = Object.create(sandbox.StructureBehavior.prototype);
routeBehavior.game = {
  config: () => ({
    defaultNukeTargetableRange: () => {
      routeTargetableRangeReads++;
      return 10;
    },
  }),
  euclideanDistSquared: () => 0,
};
routeBehavior.legendarySamRange = () => 10;
const builtRoute = routeBehavior.legendaryBuildMissileRoute(
  {
    fromTile: { kind: "source" },
    targetTile: { kind: "target" },
    impactTick: 120,
    path: routePath,
  },
  routeProfiles,
);
assert.equal(
  routeTargetableRangeReads,
  1,
  "missile route construction resolves targetability once per route path",
);
assert.equal(builtRoute.samOptions.length, routeProfiles.length);

let launchTileReads = 0;
let launchIdReads = 0;
const launchSilos = Array.from({ length: 32 }, (_, index) => ({
  isUnderConstruction: () => false,
  tile: () => {
    launchTileReads++;
    return index;
  },
  id: () => {
    launchIdReads++;
    return index;
  },
}));
const launchBehavior = Object.create(sandbox.StructureBehavior.prototype);
launchBehavior.game = {
  manhattanDist: () => 1,
};
const launchSiloFilter = launchSilos.filter;
let launchSiloFilterCalls = 0;
launchSilos.filter = (...args) => {
  launchSiloFilterCalls++;
  return launchSiloFilter.apply(launchSilos, args);
};
let launchFlightTimeReads = 0;
launchBehavior.legendaryNukeFlightTime = () => {
  launchFlightTimeReads++;
  return 10;
};
launchBehavior.legendarySiloSlotAvailability = () => [0, 90, 180];
launchBehavior.legendarySiloCooldownTicks = () => 90;
const launchStartedAt = performance.now();
const launches = launchBehavior.legendaryEnemyMissileLaunchPlan(launchSilos, 0, 96);
const launchDurationMs = performance.now() - launchStartedAt;
assert.equal(launches.length, 96, "the optimized planner retains all launch opportunities");
assert.equal(
  launchTileReads,
  launchSilos.length,
  "launch planning reads each silo tile once before assigning the salvo",
);
assert.equal(
  launchIdReads,
  launchSilos.length,
  "launch planning reads each silo ID once before assigning the salvo",
);
assert.equal(
  launchSiloFilterCalls,
  0,
  "launch planning builds valid silo entries without an intermediate filter",
);
assert.ok(launchDurationMs < 50, `96 launch assignments took ${launchDurationMs.toFixed(1)}ms`);
launchFlightTimeReads = 0;
launchBehavior.legendaryEnemyMissileLaunchPlan(launchSilos, 0, 1);
assert.equal(
  launchFlightTimeReads,
  1,
  "a one-shot salvo computes flight time only for its selected silo",
);
delete launchSilos.filter;

launchTileReads = 0;
launchIdReads = 0;
const salvoRouteBehavior = Object.create(sandbox.StructureBehavior.prototype);
salvoRouteBehavior.legendaryNukeFlightPath = (fromTile, targetTile) => [fromTile, targetTile];
salvoRouteBehavior.legendaryBuildMissileRoute = (route) => route;
const salvoRoutes = salvoRouteBehavior.legendarySalvoRoutes({
  launches,
  targetTile: 0,
  canHydrogen: false,
  atomCount: launches.length,
  samProfiles: [],
});
assert.equal(salvoRoutes.routes.length, launches.length);
assert.equal(
  launchTileReads,
  0,
  "salvo route construction reuses launch source tiles instead of rereading each silo per shot",
);
assert.equal(
  launchIdReads,
  0,
  "salvo route construction reuses launch silo IDs instead of rereading each silo per shot",
);

let metadataSlotReads = 0;
const metadataBehavior = Object.create(sandbox.StructureBehavior.prototype);
metadataBehavior.game = { manhattanDist: () => 1 };
metadataBehavior.legendarySiloSlotAvailability = () => {
  metadataSlotReads++;
  return [0, 90, 180];
};
metadataBehavior.legendarySiloCooldownTicks = () => 90;
metadataBehavior.legendaryNukeFlightTime = () => 10;
metadataBehavior.legendaryMissileSalvoBudget = () => ({
  canHydrogen: false,
  atomCount: 1,
  forecastComplete: true,
});
metadataBehavior.legendarySalvoRoutes = () => ({
  atomArrivalTicks: [10],
  hydrogenArrivalTick: null,
  routes: [],
});
metadataBehavior.legendarySalvoSourceMetrics = () => [];
metadataBehavior.legendarySamCooldownTicks = () => 90;
metadataBehavior.finalizeLegendarySalvoRisk = () => ({});
const siloMetadataCache = new Map();
metadataBehavior.legendaryMissileSalvoPlan(
  {
    enemySilos: launchSilos,
    enemyGold: 1n,
    targetTile: 0,
    atomCost: 1n,
    hydrogenCost: 2n,
  },
  {
    samProfilesOverride: [],
    siloMetadataCache,
  },
);
assert.equal(
  metadataSlotReads,
  launchSilos.length,
  "salvo planning reuses the per-context silo slot snapshot for ready-shot counts",
);
assert.equal(
  siloMetadataCache.get(launchSilos[0]).readyShots,
  1,
  "silo metadata snapshots retain the ready-shot count",
);
let readySlotFilterReads = 0;
const cachedReadySlots = [0, 90, 180];
const cachedReadyFilter = cachedReadySlots.filter;
cachedReadySlots.filter = (...args) => {
  readySlotFilterReads++;
  return cachedReadyFilter.apply(cachedReadySlots, args);
};
const readyShotCache = new Map([[launchSilos[0], { slots: cachedReadySlots, readyShots: 1 }]]);
assert.equal(metadataBehavior.legendarySiloReadyShotCount(launchSilos[0], readyShotCache), 1);
assert.equal(
  readySlotFilterReads,
  0,
  "ready-shot reads reuse the cached count instead of filtering cached slots",
);

let siloQueueMapReads = 0;
const siloQueue = [0, 90, 180];
const siloQueueMap = siloQueue.map;
siloQueue.map = (...args) => {
  siloQueueMapReads++;
  return siloQueueMap.apply(siloQueue, args);
};
const siloAvailabilityBehavior = Object.create(sandbox.StructureBehavior.prototype);
siloAvailabilityBehavior.game = { ticks: () => 0 };
siloAvailabilityBehavior.structureMissileQueue = () => siloQueue;
siloAvailabilityBehavior.legendarySiloCooldownTicks = () => 90;
const siloAvailability = siloAvailabilityBehavior.legendarySiloSlotAvailability({
  isUnderConstruction: () => false,
  level: () => 3,
});
assert.equal(siloAvailability.length, 3);
assert.equal(
  siloQueueMapReads,
  0,
  "Silo slot availability converts queue entries in place without a mapped copy",
);

let sourceTileReads = 0;
const sourceSilos = Array.from({ length: 32 }, (_, index) => ({
  tile: () => {
    sourceTileReads++;
    return index;
  },
}));
const sourceMetadataCache = new Map(
  sourceSilos.map((silo, index) => [silo, { tile: index, id: index, slots: [0] }]),
);
const sourceMetricsBehavior = Object.create(sandbox.StructureBehavior.prototype);
sourceMetricsBehavior.legendarySalvoRouteInterceptionCapacity = () => null;
sourceMetricsBehavior.legendaryNukeFlightTime = () => 10;
sourceMetricsBehavior.legendarySamInterceptionCapacity = () => 1;
const sourceSilosMap = sourceSilos.map;
let sourceMetricsMapCalls = 0;
sourceSilos.map = (...args) => {
  sourceMetricsMapCalls++;
  return sourceSilosMap.apply(sourceSilos, args);
};
const sourceMetrics = sourceMetricsBehavior.legendarySalvoSourceMetrics({
  enemySilos: sourceSilos,
  targetTile: 0,
  launchFlightTimes: new Map(),
  routes: null,
  samProfiles: [],
  siloMetadataCache: sourceMetadataCache,
});
assert.equal(sourceMetrics.length, sourceSilos.length);
assert.equal(
  sourceTileReads,
  0,
  "salvo source metrics reuse cached silo tiles across target candidates",
);
delete sourceSilos.map;
assert.equal(
  sourceMetricsMapCalls,
  0,
  "salvo source metrics fill per-silo metrics without a mapped copy",
);

sandbox.legendaryMissileThreatScore = () => ({ score: 1, critical: false });
sandbox.legendaryMissileSalvoRisk = () => ({ score: 0, fullyDefended: true });
const prospectiveSilos = [{}, {}];
const prospectiveSiloReduce = prospectiveSilos.reduce;
let prospectiveSiloReduceCalls = 0;
prospectiveSilos.reduce = (...args) => {
  prospectiveSiloReduceCalls++;
  return prospectiveSiloReduce.apply(prospectiveSilos, args);
};
const prospectiveBehavior = Object.create(sandbox.StructureBehavior.prototype);
prospectiveBehavior.legendaryCandidateMissileExposure = () => ({
  ratio: 1,
  count: 1,
});
prospectiveBehavior.legendaryCandidateShotPlan = () => ({
  atomArrivalTicks: [10],
  hydrogenArrivalTick: null,
  nearestFlightTime: 10,
  sourcePlan: { readyShots: 1 },
});
prospectiveBehavior.legendaryCachedSamInterceptionCapacity = () => 1;
prospectiveBehavior.legendarySamCooldownTicks = () => 90;
prospectiveBehavior.legendaryProspectivePlacementRisk(
  0,
  1,
  {
    enemySilos: prospectiveSilos,
    enemySiloLevels: [{ level: 1 }, { level: 2 }],
    enemyGold: 100,
    weapon: UNIT.AtomBomb,
  },
  {
    atomCost: 1n,
    hydrogenCost: 1n,
    atomRadius: 10,
    hydrogenRadius: 20,
  },
);
delete prospectiveSilos.reduce;
assert.equal(
  prospectiveSiloReduceCalls,
  0,
  "prospective missile risk sums cached SAM capacity without reducing every silo",
);
const targetSilos = Array.from({ length: 8 }, (_, index) => ({
  tile: () => index,
  level: () => index + 1,
}));
const targetSiloLevels = Array.from({ length: targetSilos.length }, () => ({
  level: 1,
}));
const targetSiloMap = targetSilos.map;
let targetSiloMapCalls = 0;
targetSilos.map = (...args) => {
  targetSiloMapCalls++;
  return targetSiloMap.apply(targetSilos, args);
};
const targetSourceMetrics = [];
const targetSourceMetricsMap = targetSourceMetrics.map;
let targetSourceMetricsMapCalls = 0;
targetSourceMetrics.map = (...args) => {
  targetSourceMetricsMapCalls++;
  return targetSourceMetricsMap.apply(targetSourceMetrics, args);
};
let targetReadyShotsOverride;
const targetScoreBehavior = Object.create(sandbox.StructureBehavior.prototype);
targetScoreBehavior.legendaryMissileSalvoPlan = (_input, options = {}) => {
  targetReadyShotsOverride = options.readyShotsOverride;
  return {
    sourceMetrics: targetSourceMetrics,
    readyShots: 1,
    risk: { score: 0 },
    schedule: { fullyDefended: true },
  };
};
targetScoreBehavior.legendaryNukeFlightTime = () => 10;
targetScoreBehavior.legendarySamInterceptionCapacity = () => 1;
const scoredTarget = targetScoreBehavior.legendaryScoredEnemyMissileTarget({
  enemy: {},
  enemyGold: 100n,
  enemySilos: targetSilos,
  enemySiloLevels: targetSiloLevels,
  enemyReadyShots: 7,
  weapon: UNIT.AtomBomb,
  target: { tile: 0, exposure: 1, exposedStructures: 1 },
  base: {
    atomCost: 1n,
    hydrogenCost: 1n,
    atomRadius: 10,
    hydrogenRadius: 20,
    launchMetadataCache: new Map(),
  },
  samProfiles: [],
});
assert.equal(scoredTarget.enemySiloLevels, targetSiloLevels);
assert.equal(
  targetSiloMapCalls,
  0,
  "enemy missile target scoring reuses silo levels across candidate targets",
);
assert.equal(
  targetSourceMetricsMapCalls,
  0,
  "enemy missile target scoring reuses ordered source metrics without mapping them",
);
assert.equal(
  targetReadyShotsOverride,
  7,
  "enemy missile target scoring passes the cached ready-shot total to salvo planning",
);
delete targetSilos.map;
delete targetSourceMetrics.map;

const readyOverrideSilos = [{}, {}];
const readyOverrideReduce = readyOverrideSilos.reduce;
let readyOverrideReduceCalls = 0;
readyOverrideSilos.reduce = (...args) => {
  readyOverrideReduceCalls++;
  return readyOverrideReduce.apply(readyOverrideSilos, args);
};
const readyOverrideBehavior = Object.create(sandbox.StructureBehavior.prototype);
readyOverrideBehavior.legendaryEnemyMissileLaunchPlan = () => [
  { silo: readyOverrideSilos[0], flightTicks: 10, impactTick: 10 },
];
readyOverrideBehavior.legendarySalvoRoutes = () => ({
  atomArrivalTicks: [],
  hydrogenArrivalTick: null,
  routes: [],
});
readyOverrideBehavior.legendarySalvoSourceMetrics = () => [];
readyOverrideBehavior.legendarySamCooldownTicks = () => 90;
readyOverrideBehavior.finalizeLegendarySalvoRisk = () => ({ fullyDefended: true });
const readyOverridePlan = readyOverrideBehavior.legendaryMissileSalvoPlan(
  {
    enemySilos: readyOverrideSilos,
    enemyGold: 1n,
    targetTile: 0,
    atomCost: 1n,
    hydrogenCost: 0n,
  },
  { samProfilesOverride: [], readyShotsOverride: 2 },
);
delete readyOverrideSilos.reduce;
assert.equal(readyOverridePlan.readyShots, 2);
assert.equal(
  readyOverrideReduceCalls,
  0,
  "salvo planning reuses a ready-shot override without reducing every silo",
);

const resourceSilos = Array.from({ length: 16 }, (_, index) => ({
  isUnderConstruction: () => index === 3,
  isActive: index === 5 ? () => false : undefined,
  level: () => index + 1,
}));
const resourceSiloFilter = resourceSilos.filter;
let resourceSiloFilterCalls = 0;
resourceSilos.filter = (...args) => {
  resourceSiloFilterCalls++;
  return resourceSiloFilter.apply(resourceSilos, args);
};
const resourceBehavior = Object.create(sandbox.StructureBehavior.prototype);
const resources = resourceBehavior.legendaryEnemyMissileResources({
  gold: () => 100,
  units: () => resourceSilos,
});
delete resourceSilos.filter;
assert.equal(resources.enemySilos.length, 14);
assert.equal(resources.enemySiloLevels.length, 14);
assert.equal(
  resourceSiloFilterCalls,
  0,
  "enemy missile resources filter silos and snapshot levels in one pass",
);

let samReadyFilterReads = 0;
const samAvailableTicks = [0, 0, 90];
const samReadyFilter = samAvailableTicks.filter;
samAvailableTicks.filter = (...args) => {
  samReadyFilterReads++;
  return samReadyFilter.apply(samAvailableTicks, args);
};
const samCapacityBehavior = Object.create(sandbox.StructureBehavior.prototype);
const samRoute = { samOptions: [{ samIndex: 0 }] };
const samCapacity = samCapacityBehavior.legendarySalvoRouteInterceptionCapacity(samRoute, [
  { availableTicks: samAvailableTicks, readySlots: 2 },
]);
assert.equal(samCapacity, 2);
assert.equal(
  samReadyFilterReads,
  0,
  "salvo route capacity reuses cached ready SAM slots instead of filtering each route",
);

let nearestSiloTileReads = 0;
const nearestBehavior = Object.create(sandbox.StructureBehavior.prototype);
nearestBehavior.game = { manhattanDist: (left, right) => Math.abs(left - right) };
const nearestSilo = {
  tile: () => {
    nearestSiloTileReads++;
    return 0;
  },
};
const nearestEntries = Array.from({ length: 256 }, (_, index) => ({
  tile: index + 1,
}));
const nearestEntry = nearestBehavior.nearestLegendaryMissileTarget(nearestSilo, nearestEntries);
assert.equal(nearestEntry.tile, 1);
assert.equal(
  nearestSiloTileReads,
  1,
  "nearest missile target selection snapshots the silo tile once per search",
);

let mirvSlotReads = 0;
const mirvBehavior = Object.create(sandbox.StructureBehavior.prototype);
const mirvSam = { tile: () => 7 };
mirvBehavior.legendaryFriendlySamUnits = () => [mirvSam];
mirvBehavior.legendarySamSlotAvailability = () => {
  mirvSlotReads++;
  return [0];
};
mirvBehavior.samTileCoversMirvDemand = (tile) => tile === 7;
const mirvContext = {
  samProfiles: [{ tile: 7, availableTicks: [0], readySlots: 1 }],
  mirvDemands: [{ targetTile: 7, deadlineTick: 10 }],
};
assert.equal(mirvBehavior.uncoveredActiveMirvDemands(mirvContext).length, 0);
assert.equal(
  mirvSlotReads,
  0,
  "active MIRV demand checks reuse SAM profiles from the defense snapshot",
);

let directSamFilterReads = 0;
const directSamBehavior = Object.create(sandbox.StructureBehavior.prototype);
const directSam = {
  isUnderConstruction: () => false,
};
const directSamSlots = [0, 90];
const directSamFilter = directSamSlots.filter;
directSamSlots.filter = (...args) => {
  directSamFilterReads++;
  return directSamFilter.apply(directSamSlots, args);
};
directSamBehavior.legendarySamSlotAvailability = () => directSamSlots;
assert.equal(directSamBehavior.legendarySamReadySlots(directSam), 1);
assert.equal(
  directSamFilterReads,
  0,
  "SAM ready-slot fallback counts availability without allocating a filtered array",
);

let targetableRangeReads = 0;
const targetableBehavior = Object.create(sandbox.StructureBehavior.prototype);
targetableBehavior.game = {
  config: () => ({
    defaultNukeTargetableRange: () => {
      targetableRangeReads++;
      return 1;
    },
  }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
const targetablePath = Array.from({ length: 256 }, (_, index) => index);
const targetableIndexes = targetableBehavior.legendaryTrajectoryTargetableIndexes(
  targetablePath,
  0,
  255,
);
assert.deepEqual(Array.from(targetableIndexes), [0, 1, 254, 255]);
assert.equal(
  targetableRangeReads,
  1,
  "trajectory targetability reads the configured nuke range once per path scan",
);

const activeMotionBehavior = Object.create(sandbox.StructureBehavior.prototype);
const activePlanPath = [0, 1, 2, 3];
const activePathSlice = [2, 3];
activePlanPath.slice = () => activePathSlice;
activeMotionBehavior.game = {
  ticks: () => 2,
  motionPlans: () => new Map([["nuke-1", { path: activePlanPath, startTick: 0, ticksPerStep: 1 }]]),
};
const activeMotion = activeMotionBehavior.legendaryActiveMissileMotion({ id: () => "nuke-1" }, 0);
assert.equal(activeMotion.path, activePathSlice);
assert.equal(activeMotion.impactTick, 2);

let groupArrayMethodReads = 0;
const groupedMissiles = [
  { id: "r1", impactTick: 10, marginTicks: 5, intercepted: true },
  { id: "r2", impactTick: 20, marginTicks: 7, intercepted: false },
];
const selectedGroupedMissiles = groupedMissiles.slice();
const selectedMap = selectedGroupedMissiles.map;
const selectedFilter = selectedGroupedMissiles.filter;
selectedGroupedMissiles.map = (...args) => {
  groupArrayMethodReads++;
  return selectedMap.apply(selectedGroupedMissiles, args);
};
selectedGroupedMissiles.filter = (...args) => {
  groupArrayMethodReads++;
  return selectedFilter.apply(selectedGroupedMissiles, args);
};
groupedMissiles.filter = () => {
  groupArrayMethodReads++;
  return selectedGroupedMissiles;
};
const groupScheduleBehavior = Object.create(sandbox.StructureBehavior.prototype);
const groupSchedule = groupScheduleBehavior.legendaryGroupDefenseSchedule(
  {
    routeIds: new Set(["r1", "r2"]),
    forecastComplete: true,
    threat: {},
  },
  {
    completionTick: 0,
    missiles: groupedMissiles,
  },
);
assert.equal(groupSchedule.firstImpactTick, 10);
assert.equal(groupSchedule.minimumInterceptMarginTicks, 5);
assert.equal(groupSchedule.interceptedCount, 1);
assert.equal(groupSchedule.uninterceptedCount, 1);
assert.equal(groupSchedule.fullyDefended, false);
assert.equal(
  groupArrayMethodReads,
  0,
  "group defense summaries aggregate missile counters in one pass",
);

const impactContext = { completionTick: 10, routesByThreat: new Map() };
const coverageProfile = { rangeSquared: 100 };
const impactStructure = {};
let receivedImpactContext;
let receivedCoverageProfile;
const impactScoreBehavior = Object.create(sandbox.StructureBehavior.prototype);
impactScoreBehavior.legendarySamImpactMarginContext = () => impactContext;
impactScoreBehavior.legendarySamCoverageProfile = () => coverageProfile;
impactScoreBehavior.legendaryCandidateProtectsStructure = (
  _tile,
  _level,
  _structure,
  _threats,
  receivedContext,
) => {
  receivedImpactContext = receivedContext;
  receivedCoverageProfile = receivedContext.coverageProfile;
  return false;
};
impactScoreBehavior.spacingConstants = () => ({ structureSpacing: 1 });
const impactScore = impactScoreBehavior.legendarySamImpactMarginScore(0, {
  threats: [{}],
  structures: [impactStructure],
  priorityStructures: [impactStructure],
  totalValue: 1,
  structureValues: new Map([[impactStructure, 1]]),
});
assert.equal(impactScore, 0);
assert.equal(
  receivedImpactContext,
  impactContext,
  "SAM impact scoring reuses the prepared impact context without cloning it",
);
assert.equal(
  receivedCoverageProfile,
  coverageProfile,
  "SAM impact scoring exposes the candidate coverage profile through the shared context",
);
assert.equal(
  impactContext.coverageProfile,
  undefined,
  "SAM impact scoring restores the shared context after each candidate",
);

let routeCoverageArrayCalls = 0;
const capacityRouteBehavior = Object.create(sandbox.StructureBehavior.prototype);
capacityRouteBehavior.game = {
  euclideanDistSquared: (left, right) => Math.abs(left - right),
};
capacityRouteBehavior.legendaryNukeFlightPath = () => [0, 1, 2];
capacityRouteBehavior.legendaryTrajectoryTargetableIndexes = () => [0, 1, 2];
capacityRouteBehavior.legendarySamPathCoverageIndicesForRoute = () => {
  routeCoverageArrayCalls++;
  return [1];
};
const routeCapacity = capacityRouteBehavior.legendarySamInterceptionCapacity(0, 2, null, [
  { tile: 0, range: 10, availableTicks: [0], readySlots: 1 },
]);
assert.equal(routeCapacity, 1);
assert.equal(
  routeCoverageArrayCalls,
  0,
  "SAM capacity checks route coverage without allocating all coverage indexes",
);

let contextValueReads = 0;
const contextBehavior = Object.create(sandbox.StructureBehavior.prototype);
contextBehavior.game = {
  config: () => ({
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ outer: 10 }),
  }),
};
contextBehavior.player = { units: () => coverageStructures };
contextBehavior.cost = () => 1n;
coverageStructures[0].priority = 3;
coverageStructures[1].priority = 9;
coverageStructures[2].priority = 6;
contextBehavior.legendaryCriticalStructureValue = (unit) => {
  contextValueReads++;
  return unit.priority ?? 1;
};
let contextStructureMapCalls = 0;
coverageStructures.map = (...args) => {
  contextStructureMapCalls++;
  return Array.prototype.map.apply(coverageStructures, args);
};
const placementBaseContext = contextBehavior.legendaryMissilePlacementBaseContext();
delete coverageStructures.map;
assert.equal(
  placementBaseContext.priorityStructures.length,
  Math.min(16, coverageStructures.length),
);
assert.equal(
  contextValueReads,
  coverageStructures.length,
  "missile context values each structure once before total and priority ranking",
);
assert.equal(
  contextStructureMapCalls,
  0,
  "missile placement base context fills structure indexes without map allocations",
);
assert.equal(
  source.includes("valuedStructures.sort("),
  false,
  "missile placement base context selects priorities without sorting every structure",
);
assert.equal(placementBaseContext.priorityStructures[0], coverageStructures[1]);
assert.equal(placementBaseContext.priorityStructures[1], coverageStructures[2]);
assert.equal(placementBaseContext.priorityStructures[2], coverageStructures[0]);

const targetSelectionBehavior = Object.create(sandbox.StructureBehavior.prototype);
const exposureTarget = { target: "exposure" };
const valueTarget = { target: "value" };
const nearestTarget = { target: "nearest" };
targetSelectionBehavior.nearestLegendaryMissileTarget = (silo) =>
  silo.nearest ? nearestTarget : null;
const selectionSilos = [{ nearest: true }, { nearest: false }];
let selectionMapCalls = 0;
let selectionFilterCalls = 0;
selectionSilos.map = (...args) => {
  selectionMapCalls++;
  const mapped = Array.prototype.map.apply(selectionSilos, args);
  const originalFilter = mapped.filter;
  mapped.filter = (...filterArgs) => {
    selectionFilterCalls++;
    return originalFilter.apply(mapped, filterArgs);
  };
  return mapped;
};
const selectedTargets = targetSelectionBehavior.legendarySelectMissileTargets(
  [exposureTarget, valueTarget],
  [exposureTarget],
  [valueTarget],
  selectionSilos,
  3,
);
delete selectionSilos.map;
assert.equal(selectionMapCalls, 0);
assert.equal(selectionFilterCalls, 0);
assert.equal(selectedTargets[0], exposureTarget);
assert.equal(selectedTargets[1], valueTarget);
assert.equal(selectedTargets[2], nearestTarget);

const supportBehavior = Object.create(sandbox.StructureBehavior.prototype);
const supportAllies = Array.from({ length: 4000 }, () => ({}));
supportBehavior.spacingConstants = () => ({ structureSpacing: 1 });
supportBehavior.safeGameConfig = () => ({ samRange: () => 10 });
supportBehavior.legendarySingleAllySupportScore = () => 1;
const supportStartedAt = performance.now();
let supportScore = 0;
for (let candidate = 0; candidate < 64; candidate++) {
  supportScore = supportBehavior.legendaryAllySupportPlacementScore(candidate, UNIT.City, {
    allies: supportAllies,
    supportRadius: 10,
  });
}
const supportDurationMs = performance.now() - supportStartedAt;
assert.equal(
  supportScore,
  1.35,
  "linear ally support selection retains the strongest-two support formula",
);
assert.ok(
  supportDurationMs < 50,
  `64 ally-support candidate scores took ${supportDurationMs.toFixed(1)}ms`,
);

let networkDistanceReads = 0;
const networkBehavior = Object.create(sandbox.StructureBehavior.prototype);
networkBehavior.game = {
  config: () => ({ samRange: (level) => Number(level) * 10 }),
  euclideanDistSquared: (left, right) => {
    networkDistanceReads++;
    if ([1000, 2000].includes(left) && [10, 20, 30].includes(right)) {
      return 200;
    }
    return 0;
  },
};
networkBehavior.legendaryFriendlySamUnits = () => [
  { tile: () => 1000, level: () => 1 },
  { tile: () => 2000, level: () => 1 },
];
const networkScore = networkBehavior.friendlyUsefulSamPlacementScore(new Set([10, 20, 30]), 8);
for (let candidate = 0; candidate < 64; candidate++) {
  networkScore(candidate);
}
assert.equal(
  networkDistanceReads,
  262,
  "friendly SAM placement precomputes SAM-to-structure distances once per anchor",
);

let spacingMagnitudeReads = 0;
const spacingConfig = {
  nukeMagnitudes: () => {
    spacingMagnitudeReads++;
    return { outer: 7 };
  },
};
let activeSpacingConfig = spacingConfig;
const spacingBehavior = Object.create(sandbox.StructureBehavior.prototype);
spacingBehavior.game = { config: () => activeSpacingConfig };
for (let call = 0; call < 64; call++) {
  const spacing = spacingBehavior.spacingConstants();
  assert.equal(spacing.borderSpacing, 7);
  assert.equal(spacing.structureSpacing, 14);
}
assert.equal(
  spacingMagnitudeReads,
  1,
  "Legendary candidate scorers reuse spacing constants within one game config",
);
activeSpacingConfig = {
  nukeMagnitudes: () => {
    spacingMagnitudeReads++;
    return { outer: 9 };
  },
};
const replacementSpacing = spacingBehavior.spacingConstants();
assert.equal(replacementSpacing.borderSpacing, 9);
assert.equal(replacementSpacing.structureSpacing, 18);
assert.equal(
  spacingMagnitudeReads,
  2,
  "replacing the game config invalidates the spacing constants cache",
);

let teamRangeReads = 0;
const teamBehavior = Object.create(sandbox.StructureBehavior.prototype);
teamBehavior.spacingConstants = () => ({ structureSpacing: 8 });
teamBehavior.game = {
  x: (tile) => tile,
  y: () => 0,
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  config: () => ({
    trainStationMaxRange: () => {
      teamRangeReads++;
      return 10;
    },
  }),
};
const teamCenterContext = {
  x: 0,
  y: 0,
  nearestBorder: 0,
  radius: 10,
};
for (let candidate = 0; candidate < 64; candidate++) {
  teamBehavior.legendaryTeamCenterPlacementScore(candidate, teamCenterContext);
}
assert.equal(
  teamRangeReads,
  0,
  "team-center candidate scoring reuses the radius stored in its context",
);

let stationMinReads = 0;
let stationMaxReads = 0;
const stationConfig = {
  trainStationMinRange: () => {
    stationMinReads++;
    return 2;
  },
  trainStationMaxRange: () => {
    stationMaxReads++;
    return 10;
  },
};
let activeStationConfig = stationConfig;
const railBehavior = Object.create(sandbox.StructureBehavior.prototype);
railBehavior.game = { config: () => activeStationConfig };
railBehavior.spacingConstants = () => ({ structureSpacing: 2 });
railBehavior.getOrBuildReachableStations = () => [{ tile: 1, cluster: null, weight: 1 }];
railBehavior.computeConnectivityScore = () => 1;
for (let candidate = 0; candidate < 64; candidate++) {
  assert.equal(railBehavior.legendaryRailConnectivityPlacementScore(candidate), 2);
}
assert.equal(stationMinReads, 1);
assert.equal(stationMaxReads, 1);
activeStationConfig = {
  trainStationMinRange: () => {
    stationMinReads++;
    return 3;
  },
  trainStationMaxRange: () => {
    stationMaxReads++;
    return 12;
  },
};
railBehavior.legendaryRailConnectivityPlacementScore(0);
assert.equal(stationMinReads, 2);
assert.equal(stationMaxReads, 2);

let threatCoverageDistanceReads = 0;
const threatStructures = Array.from({ length: 32 }, (_, index) => ({
  tile: () => ({ kind: "structure", index }),
  type: () => UNIT.City,
  level: () => 1,
}));
const threatSams = Array.from({ length: 2 }, (_, index) => ({
  tile: () => ({ kind: "sam", index }),
  level: () => 1,
  isUnderConstruction: () => false,
}));
const threatBehavior = Object.create(sandbox.StructureBehavior.prototype);
threatBehavior.game = {
  config: () => ({
    defaultSamRange: () => 100,
    samRange: () => 10,
  }),
  euclideanDistSquared: (left, right) => {
    threatCoverageDistanceReads++;
    if (left?.kind === "structure" && right?.kind === "sam") return 10000;
    return 0;
  },
};
threatBehavior.player = {
  units: (...types) => (types.includes(UNIT.SAMLauncher) ? threatSams : threatStructures),
};
threatBehavior.samCriticalStructureWeight = () => 1;
const threatScore = threatBehavior.threatSamLauncherValue();
for (let candidate = 0; candidate < 64; candidate++) {
  threatScore(candidate);
}
assert.equal(
  threatCoverageDistanceReads,
  2112,
  "SAM threat scoring precomputes existing coverage before evaluating candidates",
);

process.stdout.write(
  `structure performance regression tests passed (Factory cache ${factoryCacheDurationMs.toFixed(1)}ms; fingerprints ${fingerprintDurationMs.toFixed(1)}ms; SAM coverage ${coverageDurationMs.toFixed(1)}ms; launches ${launchDurationMs.toFixed(1)}ms; ally support ${supportDurationMs.toFixed(1)}ms)\n`,
);
