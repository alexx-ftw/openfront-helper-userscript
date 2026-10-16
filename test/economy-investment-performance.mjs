import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const plannerSource = readRepositoryFile("engine/ingame/auto-bot/legendaryPlanner.js");
const structureSource = readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js");
const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  TradeShip: "TradeShip",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
};
const sandbox = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  UNIT,
  currentDifficulty: () => "Legendary",
  isLegendaryDifficulty: () => true,
  isAtLeastHardDifficulty: () => true,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
  globalThis: null,
  rankEconomicInvestmentCandidateInputs: [],
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${plannerSource}
const originalRankEconomicInvestmentCandidates = rankEconomicInvestmentCandidates;
rankEconomicInvestmentCandidates = function (candidates, options) {
  globalThis.rankEconomicInvestmentCandidateInputs.push(candidates.length);
  return originalRankEconomicInvestmentCandidates(candidates, options);
};
${structureSource}
globalThis.StructureBehavior = StructureBehavior;
globalThis.rankEconomicInvestmentCandidates = rankEconomicInvestmentCandidates;`,
  sandbox,
  { filename: "economy-investment-performance.js" },
);

// The runtime should call this ranker with only the three productive type
// candidates (City, Port and Factory). Make those candidates large enough to
// exercise payback fields without adding any spatial or worker-backed inputs.
const candidates = [
  {
    type: UNIT.City,
    cost: 200_000n,
    completionTicks: 20,
    shortIncomePerTick: 200,
    longIncomePerTick: 250,
    capacityValue: 0,
  },
  {
    type: UNIT.Port,
    cost: 250_000n,
    completionTicks: 50,
    shortIncomePerTick: 300,
    longIncomePerTick: 300,
    capacityValue: 0,
  },
  {
    type: UNIT.Factory,
    cost: 250_000n,
    completionTicks: 20,
    shortIncomePerTick: 500,
    longIncomePerTick: 350,
    capacityValue: 0,
  },
];
const ranked = sandbox.rankEconomicInvestmentCandidates(candidates, {
  gold: 1_000_000n,
  reserve: 100_000n,
  shortHorizonTicks: 300,
  longHorizonTicks: 1_800,
});
assert.equal(ranked.length, 3, "the three productive candidate types remain rankable");
assert.equal(ranked[0].type, UNIT.Factory, "the highest marginal payoff ranks first");
assert.ok(
  ranked.every((candidate) => Number.isFinite(candidate.investmentScore)),
  "ranked candidates carry finite scores without needing map or worker state",
);

function countedArray(length, makeValue) {
  const result = { reads: 0 };
  result.value = new Proxy(
    { length },
    {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          result.reads++;
          return makeValue(Number(property));
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  return result;
}

let gameTick = 400;
let tradeOwnerChecks = 0;
let unitUnderConstructionChecks = 0;
let stationUnitCalls = 0;
let workerProbeCalls = 0;
let railOrMapProbeCalls = 0;
let configObjectReads = 0;
const nearbyOwners = countedArray(10000, () => ({ tradeable: false }));
const ownedFactories = countedArray(10000, () => ({ level: () => 1 }));
const incompleteStations = countedArray(10000, () => ({ incomplete: true }));
const player = {
  gold: () => 1_000_000n,
  units(...types) {
    if (types.length === 1 && types[0] === UNIT.Factory) return ownedFactories.value;
    stationUnitCalls++;
    return incompleteStations.value;
  },
  nearby: () => nearbyOwners.value,
  isAlliedWith: () => false,
  isOnSameTeam: () => false,
};
const game = {
  ticks: () => gameTick,
  railroadState: () => {
    railOrMapProbeCalls++;
    return null;
  },
  euclideanDistSquared: () => 0,
  config: () => {
    configObjectReads++;
    return {
      trainStationMaxRange: () => 110,
      tradeShipSpawnRate: () => 100,
      tradeShipShortRangeDebuff: () => 200,
    };
  },
};
const behavior = new sandbox.StructureBehavior(() => 0, game, player);
behavior.isTradeableStationNeighbor = (owner) => {
  tradeOwnerChecks++;
  return owner.tradeable;
};
behavior.unitUnderConstruction = (unit) => {
  unitUnderConstructionChecks++;
  return Boolean(unit.incomplete);
};
behavior.trainGoldBase = () => 100;
behavior.getConstructionCost = () => 100n;
behavior.availableGoldAfterReserve = () => 1_000_000n;
behavior.legendaryConstructionDuration = () => 1;
behavior.spendableConstructionGold = () => 1_000_000n;
behavior.getOrBuildReachableStations = () => {
  workerProbeCalls++;
  return [];
};
behavior.commercialRailCityAnchorTilesForTick = () => {
  railOrMapProbeCalls++;
  return [];
};
behavior.getOrBuildFactoryTradeDestinations = () => {
  railOrMapProbeCalls++;
  return [];
};
behavior.proximityStationClusters = () => {
  railOrMapProbeCalls++;
  return [];
};
behavior.buildableFor = () => {
  workerProbeCalls++;
  return [];
};
behavior.buildableForUnits = () => {
  workerProbeCalls++;
  return [];
};
behavior.economicInvestmentTypeAllowed = () => true;

const summary = behavior.getEconomicInvestmentSummary();
const firstTickReads = {
  owners: nearbyOwners.reads,
  factories: ownedFactories.reads,
  stations: incompleteStations.reads,
};
assert.equal(
  behavior.getEconomicInvestmentSummary(),
  summary,
  "the economic snapshot is reused for repeated ranking decisions in one tick",
);
assert.equal(configObjectReads, 1, "the same-tick snapshot reuses its config lookup");
assert.deepEqual(
  {
    owners: nearbyOwners.reads,
    factories: ownedFactories.reads,
    stations: incompleteStations.reads,
  },
  firstTickReads,
  "the same-tick cache avoids repeating owner, factory, or station scans",
);
assert.ok(
  tradeOwnerChecks <= 64,
  `nearby-owner inspection is bounded even when every owner is ineligible (read ${tradeOwnerChecks})`,
);
assert.ok(
  ownedFactories.reads <= 64,
  `factory inspection is capped at 64 records (read ${ownedFactories.reads})`,
);
assert.ok(
  incompleteStations.reads <= 256,
  `station inspection is globally capped even when records are incomplete (read ${incompleteStations.reads})`,
);
assert.ok(
  unitUnderConstructionChecks <= 64 + 256,
  "incomplete units cannot force an unbounded scan",
);
assert.equal(
  stationUnitCalls,
  1,
  "non-tradeable nearby owners do not trigger destination unit scans",
);

gameTick++;
const nextSummary = behavior.getEconomicInvestmentSummary();
assert.notEqual(nextSummary, summary, "a new game tick refreshes the income snapshot");
assert.equal(configObjectReads, 2, "a new tick performs one constant-time config lookup");
assert.equal(
  nearbyOwners.reads,
  firstTickReads.owners * 2,
  "the bounded owner sample is rebuilt exactly once for a new tick",
);
assert.equal(workerProbeCalls, 0, "economic ranking issues no buildability worker probes");
assert.equal(railOrMapProbeCalls, 0, "economic ranking performs no rail or map probes");

const oversizedTypeList = [
  UNIT.Factory,
  UNIT.Port,
  UNIT.City,
  ...Array.from({ length: 10000 }, () => UNIT.Factory),
];
const rankedByRuntime = behavior.rankEconomicInvestments(
  {},
  {
    types: oversizedTypeList,
    summary: {
      tick: gameTick,
      factoryCount: 10,
      completedDestinationCount: 1,
      averageOwnDestinationGold: 35_000,
      averageTeamDestinationGold: 0,
      averageRivalDestinationGold: 0,
      marginalFactoryOutputPerTick: 1,
      factoryOutputPerTick: 10,
      localDestinationCount: 1,
      routeConfidence: 1,
      portTradeIncomePerTick: 10_000,
    },
  },
);
assert.equal(
  sandbox.rankEconomicInvestmentCandidateInputs.at(-1),
  3,
  "production ranking forwards at most the City, Port, and Factory candidates",
);
assert.ok(
  rankedByRuntime.length <= 3,
  "an oversized caller type list cannot expand the ranking work",
);
assert.ok(rankedByRuntime.length > 0, "a positive-ROI stress fixture yields a real rank");
assert.equal(workerProbeCalls, 0, "candidate ranking remains worker-free");
assert.equal(railOrMapProbeCalls, 0, "candidate ranking remains map-scan-free");

const unknownPortBehavior = Object.create(sandbox.StructureBehavior.prototype);
let unknownPortUnitListCalls = 0;
unknownPortBehavior.game = {
  cachedUnitCount: () => null,
  units: () => {
    unknownPortUnitListCalls++;
    throw new Error("unknown cached ship count must not materialize global units");
  },
};
const emptyPortForecast = {
  partnerLevels: 0,
  incomePerTick: 0,
  teamIncomePerTick: 0,
  rivalSpilloverPerTick: 0,
};
const unknownPortForecast = unknownPortBehavior.economicPortIncomeSummary(
  [{ level: 1, distance: 500, gold: 1000, teamGold: 0, rivalGold: 0 }],
  { tradeShipSpawnRate: () => 1 },
  emptyPortForecast,
);
assert.equal(
  unknownPortForecast,
  emptyPortForecast,
  "unknown ship congestion preserves an empty Port forecast",
);
assert.equal(unknownPortUnitListCalls, 0, "unknown congestion never scans global units");

// The production Port partner collector supplies at most 64 entries. Keep the
// public summary helper bounded too, even when a synthetic caller provides a
// much larger array. The first 64 entries mix team, allied, and rival Ports at
// four distance bands so weighting and the resulting Port completion delay
// are covered without adding any geometry or worker work.
const expectedWeightedPortEntries = Array.from({ length: 64 }, (_, index) => {
  const level = (index % 4) + 1;
  const group = Math.floor(index / 16);
  const gold = 1_000 + index * 10;
  return {
    level,
    distance: [20, 40, 100, 200][group],
    gold,
    teamGold: group === 0 ? gold : 0,
    rivalGold: group === 2 ? gold : 0,
  };
});
const oversizedPortSentinel = {
  level: 1_000,
  distance: 1_000_000,
  gold: 1_000_000_000,
  teamGold: 1_000_000_000,
  rivalGold: 1_000_000_000,
};
let oversizedPortEntryReads = 0;
const oversizedPortEntryIndices = new Set();
const oversizedPortEntries = new Proxy(
  Array.from({ length: 10_000 }, (_, index) =>
    index < expectedWeightedPortEntries.length
      ? expectedWeightedPortEntries[index]
      : oversizedPortSentinel,
  ),
  {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        oversizedPortEntryReads++;
        oversizedPortEntryIndices.add(Number(property));
      }
      return Reflect.get(target, property, receiver);
    },
  },
);
let weightedPortCountReads = 0;
let weightedPortRateReads = 0;
let weightedPortForbiddenCalls = 0;
const weightedPortBehavior = Object.create(sandbox.StructureBehavior.prototype);
weightedPortBehavior.game = {
  cachedUnitCount: (type) => {
    weightedPortCountReads++;
    assert.equal(type, UNIT.TradeShip);
    return 0;
  },
  units: () => {
    weightedPortForbiddenCalls++;
    throw new Error("Port weighting must not materialize global unit arrays");
  },
  manhattanDist: () => {
    weightedPortForbiddenCalls++;
    throw new Error("Port summary weighting must not perform new geometry scans");
  },
  players: () => {
    weightedPortForbiddenCalls++;
    throw new Error("direct Port summary weighting must not enumerate players");
  },
};
const weightedPortConfig = {
  tradeShipSpawnRate: (_ownerId, shipCount) => {
    weightedPortRateReads++;
    assert.equal(shipCount, 0);
    return 20;
  },
};
const weightedPortForecast = weightedPortBehavior.economicPortIncomeSummary(
  oversizedPortEntries,
  weightedPortConfig,
  emptyPortForecast,
);
const expectedPortLevelTotal = expectedWeightedPortEntries.reduce(
  (sum, entry) => sum + entry.level,
  0,
);
const expectedWeightedAverage = (field) =>
  expectedWeightedPortEntries.reduce((sum, entry) => sum + entry[field] * entry.level, 0) /
  expectedPortLevelTotal;
const expectedPortIncomeScale = 0.5 / (10 * 20);
assert.equal(weightedPortForecast.partnerLevels, expectedPortLevelTotal);
assert.equal(weightedPortForecast.partnerWeight, expectedPortLevelTotal);
assert.equal(weightedPortForecast.partnerPortCount, 64);
assert.equal(weightedPortForecast.truncatedPortScan, true);
assert.equal(
  weightedPortForecast.arrivalTicks,
  90,
  "weighted partner distance controls the Port arrival delay",
);
assert.equal(
  weightedPortForecast.incomePerTick,
  expectedWeightedAverage("gold") * expectedPortIncomeScale,
);
assert.equal(
  weightedPortForecast.teamIncomePerTick,
  expectedWeightedAverage("teamGold") * expectedPortIncomeScale,
  "team spillover uses level-weighted team receipts",
);
assert.equal(
  weightedPortForecast.rivalSpilloverPerTick,
  expectedWeightedAverage("rivalGold") * expectedPortIncomeScale,
  "rival spillover uses level-weighted rival receipts",
);
assert.equal(
  oversizedPortEntryIndices.size,
  64,
  "only 64 entries are inspected from oversized input",
);
assert.ok(
  oversizedPortEntryReads <= 64 * 3,
  `capped entry aggregation remains linear in at most 64 records (read ${oversizedPortEntryReads})`,
);
assert.equal(weightedPortCountReads, 1, "weighting reuses one cached ship count");
assert.equal(weightedPortRateReads, 1, "weighting reads one scalar spawn-rate estimate");
assert.equal(weightedPortForbiddenCalls, 0, "weighting adds no unit, owner, or distance scans");

weightedPortBehavior.economicInvestmentTypeAllowed = () => true;
weightedPortBehavior.getConstructionCost = () => 100n;
weightedPortBehavior.availableGoldAfterReserve = () => 1_000_000n;
weightedPortBehavior.economicInvestmentDuration = () => 50;
const weightedPortCandidate = weightedPortBehavior.economicInvestmentCandidates(
  {},
  {
    types: [UNIT.Port],
    summary: {
      tick: 1,
      routeConfidence: 1,
      averageOwnDestinationGold: 0,
      averageTeamDestinationGold: 0,
      averageRivalDestinationGold: 0,
      marginalFactoryOutputPerTick: 0,
      portTradeIncomePerTick: weightedPortForecast.incomePerTick,
      portTeamIncomePerTick: weightedPortForecast.teamIncomePerTick,
      portRivalSpilloverPerTick: weightedPortForecast.rivalSpilloverPerTick,
      portArrivalTicks: weightedPortForecast.arrivalTicks,
    },
  },
)[0];
assert.equal(
  weightedPortCandidate.completionTicks,
  140,
  "Port completion includes the distance-weighted expected arrival delay",
);
assert.equal(
  weightedPortCandidate.shortIncomePerTick,
  weightedPortForecast.incomePerTick +
    weightedPortForecast.teamIncomePerTick -
    weightedPortForecast.rivalSpilloverPerTick * 0.5,
  "the candidate credits team receipts and discounts rival spillover without changing scan work",
);

const legacyEconomicOrder = [UNIT.Factory, UNIT.Port, UNIT.City];
assert.deepEqual(
  [...unknownPortBehavior.economicAdvisoryTypeOrder(legacyEconomicOrder, [{ action: "wait" }])],
  legacyEconomicOrder,
  "an unproven Port estimate falls through to the legacy economic order",
);

function makeEconomicUnit(id, tile, level = 1) {
  return {
    id: () => id,
    tile: () => tile,
    level: () => level,
    isActive: () => true,
    isUnderConstruction: () => false,
  };
}

let distanceTick = 900;
let distanceEuclideanCalls = 0;
let distanceManhattanCalls = 0;
let distanceConfigReads = 0;
let distanceConfigScalarReads = 0;
let distanceRailOrMapCalls = 0;
let distanceWorkerCalls = 0;
let distancePlayerUnitCalls = 0;
let distanceGameUnitCalls = 0;
let distanceCachedUnitCountCalls = 0;
const distanceCachedUnitTypes = [];
let distancePortClassifierCalls = 0;
let distanceConstructionChecks = 0;
let distanceFriendlyChecks = 0;
const distanceFactoryUnits = countedArray(64, (index) =>
  makeEconomicUnit(`factory-${index}`, 200_000 + index),
);
const ownDestinationUnits = Array.from({ length: 32 }, (_, index) =>
  makeEconomicUnit(`self-station-${index}`, 1_000 + index),
);
const neighborDestinationUnits = Array.from({ length: 32 }, (_, index) =>
  makeEconomicUnit(`neighbor-station-${index}`, 3_000 + index),
);
const partnerOwners = Array.from({ length: 32 }, (_, ownerIndex) => {
  const ports = Array.from({ length: 2 }, (_, portIndex) =>
    makeEconomicUnit(
      `partner-${ownerIndex}-port-${portIndex}`,
      50_000 + ownerIndex * 10 + portIndex,
    ),
  );
  return {
    id: () => ownerIndex + 10,
    smallID: () => ownerIndex + 10,
    isAlive: () => true,
    isPlayer: () => true,
    hasEmbargoAgainst: () => false,
    units(...types) {
      if (types.length === 1 && types[0] === UNIT.Port) return ports;
      if (ownerIndex === 0) return neighborDestinationUnits;
      if (ownerIndex === 1) return neighborDestinationUnits;
      return [];
    },
  };
});
const nearbyDistanceOwners = [partnerOwners[0], partnerOwners[1]];
const distanceNearby = countedArray(10000, (index) => nearbyDistanceOwners[index]);
const distanceGameOwners = countedArray(10000, (index) => partnerOwners[index]);
const ownCoastTiles = countedArray(10000, (index) => 4_000 + index);
const distancePlayer = {
  id: () => 1,
  smallID: () => 1,
  hasEmbargoAgainst: () => false,
  units(...types) {
    distancePlayerUnitCalls++;
    if (types.length === 1 && types[0] === UNIT.Factory) return distanceFactoryUnits.value;
    if (types.length === 1 && types[0] === UNIT.Port) return [];
    return ownDestinationUnits;
  },
  nearby: () => distanceNearby.value,
  oceanShoreBorderTiles: () => ownCoastTiles.value,
  borderTiles: () => {
    distanceRailOrMapCalls++;
    return [];
  },
  isOnSameTeam: (owner) => owner.smallID() === 10,
  isAlliedWith: (owner) => owner.smallID() === 11,
  isFriendly: (owner) => {
    distanceFriendlyChecks++;
    return owner.smallID() === 10 || owner.smallID() === 11;
  },
};
const distanceGameTarget = {
  ticks: () => distanceTick,
  config: () => {
    distanceConfigReads++;
    return {
      trainStationMaxRange: () => {
        distanceConfigScalarReads++;
        return 110;
      },
      tradeShipSpawnRate: () => {
        distanceConfigScalarReads++;
        return 100;
      },
      tradeShipShortRangeDebuff: () => {
        distanceConfigScalarReads++;
        return 200;
      },
    };
  },
  players: () => distanceGameOwners.value,
  units: () => {
    distanceGameUnitCalls++;
    throw new Error("Port ranking must use the existing cached ship count");
  },
  cachedUnitCount: (type) => {
    distanceCachedUnitCountCalls++;
    distanceCachedUnitTypes.push(type);
    return 0;
  },
  euclideanDistSquared: (left, right) => {
    distanceEuclideanCalls++;
    return left === 200_000 && right === 1_000 ? 0 : 20_000;
  },
  manhattanDist: (left, right) => {
    distanceManhattanCalls++;
    const sourceIndex = left - 4_000;
    const portOffset = right - 50_000;
    const ownerIndex = Math.floor(portOffset / 10);
    const portIndex = portOffset % 10;
    const partnerOrdinal = ownerIndex * 2 + portIndex;
    const isNear = (sourceIndex === 0) === partnerOrdinal < 32;
    return isNear ? 300 : 3_000;
  },
  railroadState: () => {
    distanceRailOrMapCalls++;
    return null;
  },
  ref: () => {
    distanceRailOrMapCalls++;
    return 0;
  },
  ownerID: () => {
    distanceRailOrMapCalls++;
    return 0;
  },
  isValidCoord: () => {
    distanceRailOrMapCalls++;
    return false;
  },
  isLand: () => {
    distanceRailOrMapCalls++;
    return false;
  },
  neighbors: () => {
    distanceRailOrMapCalls++;
    return [];
  },
};
const distanceGame = new Proxy(distanceGameTarget, {
  get(target, property, receiver) {
    if (property === "width" || property === "height" || property === "railNetwork") {
      distanceRailOrMapCalls++;
      return () => 0;
    }
    return Reflect.get(target, property, receiver);
  },
});
const distanceBehavior = new sandbox.StructureBehavior(() => 0, distanceGame, distancePlayer);
distanceBehavior._hasOceanPortTiles = true;
let observedDistancePortSummary = null;
const originalCollectEconomicPortPartnerSummary =
  distanceBehavior.collectEconomicPortPartnerSummary.bind(distanceBehavior);
distanceBehavior.collectEconomicPortPartnerSummary = (destinations) => {
  observedDistancePortSummary = originalCollectEconomicPortPartnerSummary(destinations);
  return observedDistancePortSummary;
};
distanceBehavior.isTradeableStationNeighbor = () => true;
distanceBehavior.economicInvestmentTypeAllowed = () => true;
distanceBehavior.unitUnderConstruction = (unit) => {
  distanceConstructionChecks++;
  return Boolean(unit?.isUnderConstruction?.());
};
distanceBehavior.trainGoldBase = (relation) => (relation === "self" ? 10_000 : 25_000);
distanceBehavior.isOceanPortTile = (tile) => {
  distancePortClassifierCalls++;
  return tile >= 50_000;
};
distanceBehavior.getOrBuildReachableStations = () => {
  distanceWorkerCalls++;
  return [];
};
distanceBehavior.commercialRailCityAnchorTilesForTick = () => {
  distanceRailOrMapCalls++;
  return [];
};
distanceBehavior.getOrBuildFactoryTradeDestinations = () => {
  distanceRailOrMapCalls++;
  return [];
};
distanceBehavior.proximityStationClusters = () => {
  distanceRailOrMapCalls++;
  return [];
};
distanceBehavior.buildableFor = () => {
  distanceWorkerCalls++;
  return [];
};
distanceBehavior.buildableForUnits = () => {
  distanceWorkerCalls++;
  return [];
};

const distanceSummary = distanceBehavior.getEconomicInvestmentSummary();
const firstDistanceWork = {
  euclidean: distanceEuclideanCalls,
  manhattan: distanceManhattanCalls,
  config: distanceConfigReads,
  scalarConfig: distanceConfigScalarReads,
  cachedUnitCountCalls: distanceCachedUnitCountCalls,
  cachedUnitTypes: [...distanceCachedUnitTypes],
  friendlyChecks: distanceFriendlyChecks,
  constructionChecks: distanceConstructionChecks,
  playerUnitCalls: distancePlayerUnitCalls,
  gameUnitCalls: distanceGameUnitCalls,
  portClassifiers: distancePortClassifierCalls,
  factoryUnits: distanceFactoryUnits.reads,
  coastTiles: ownCoastTiles.reads,
  stationOwners: distanceNearby.reads,
  partnerOwners: distanceGameOwners.reads,
};
assert.equal(distanceSummary.sampledDestinationCount, 64);
assert.equal(distanceSummary.localDestinationCount, 1);
assert.equal(
  distanceSummary.portTradePartnerLevels,
  64,
  "raw partner levels stay separate from proximity and friendly weights",
);
assert.equal(
  observedDistancePortSummary.partnerWeight,
  64 + Math.ceil(64 / 3) + 4,
  "the closest Ports and four friendly Ports get bounded weights without changing raw levels",
);
assert.equal(observedDistancePortSummary.inspectedPortCount, 64);
assert.equal(observedDistancePortSummary.sampledSourceCount, 8);
assert.equal(
  distanceSummary.portArrivalTicks,
  1_365,
  "Port arrival averages each sampled source before combining them instead of choosing a hybrid nearest source",
);
assert.ok(
  distanceSummary.portTeamIncomePerTick > 0,
  "team Port weighting remains visible in income",
);
assert.ok(
  distanceSummary.portRivalSpilloverPerTick > 0,
  "rival Port weighting remains visible in income",
);
assert.ok(
  distanceSummary.portTradeIncomePerTick > 0,
  "a cached zero-ship count still produces a bounded Port trade forecast",
);
assert.equal(distanceFactoryUnits.reads, 64, "Factory output sampling is capped at 64 units");
assert.equal(ownCoastTiles.reads, 8, "only eight already-classified own coast tiles are sampled");
assert.equal(
  distanceManhattanCalls,
  64 * 8,
  "Port distances inspect at most eight own coast tiles each",
);
assert.ok(
  distanceEuclideanCalls <= 64 * 16,
  `local destination checks stay within 64×16 anchor comparisons (read ${distanceEuclideanCalls})`,
);
assert.ok(
  distanceEuclideanCalls > 64 * 15,
  "the fixture drives nearly the full local destination comparison budget",
);
assert.ok(
  distanceConfigReads <= 4,
  `config object reads stay constant per tick, separate from station distance work (read ${distanceConfigReads})`,
);
assert.ok(distanceConfigScalarReads <= 4, "config scalar reads stay constant per tick");
assert.equal(
  distancePortClassifierCalls,
  32 + 64,
  "only sampled destinations and Ports are classified",
);
assert.equal(distancePlayerUnitCalls, 2, "only own Factory and station snapshots are requested");
assert.equal(distanceGameUnitCalls, 0, "Port ranking never materializes global ship units");
assert.equal(distanceCachedUnitCountCalls, 1, "Port forecast reads one cached ship count");
assert.deepEqual(distanceCachedUnitTypes, [UNIT.TradeShip]);
assert.equal(
  distanceFriendlyChecks,
  64,
  "friendly weighting checks only the already-bounded Port candidates",
);
assert.equal(
  distanceConstructionChecks,
  64 + 64 + 64,
  "the summary checks only its 64 factories, 64 destinations, and 64 partner Ports",
);
assert.equal(distanceNearby.reads, 64, "nearby inspection has a hard 64-owner scan ceiling");
assert.equal(distanceGameOwners.reads, 32, "partner owner visits are capped at 32 records");
assert.equal(distanceWorkerCalls, 0, "the full economic summary uses no placement worker probes");
assert.equal(distanceRailOrMapCalls, 0, "the summary avoids rail and whole-map helpers");

assert.equal(
  distanceBehavior.getEconomicInvestmentSummary(),
  distanceSummary,
  "the costly spatial snapshot is reused during the same game tick",
);
assert.deepEqual(
  {
    euclidean: distanceEuclideanCalls,
    manhattan: distanceManhattanCalls,
    config: distanceConfigReads,
    scalarConfig: distanceConfigScalarReads,
    cachedUnitCountCalls: distanceCachedUnitCountCalls,
    cachedUnitTypes: [...distanceCachedUnitTypes],
    friendlyChecks: distanceFriendlyChecks,
    constructionChecks: distanceConstructionChecks,
    playerUnitCalls: distancePlayerUnitCalls,
    gameUnitCalls: distanceGameUnitCalls,
    portClassifiers: distancePortClassifierCalls,
    factoryUnits: distanceFactoryUnits.reads,
    coastTiles: ownCoastTiles.reads,
    stationOwners: distanceNearby.reads,
    partnerOwners: distanceGameOwners.reads,
  },
  firstDistanceWork,
  "same-tick reuse avoids every bounded unit, distance, and config scan",
);
distanceTick++;
distanceBehavior.getEconomicInvestmentSummary();
assert.equal(distanceEuclideanCalls, firstDistanceWork.euclidean * 2);
assert.equal(distanceManhattanCalls, firstDistanceWork.manhattan * 2);
assert.equal(distanceConfigReads, firstDistanceWork.config * 2);
assert.equal(distanceCachedUnitCountCalls, firstDistanceWork.cachedUnitCountCalls * 2);
assert.equal(distanceFriendlyChecks, firstDistanceWork.friendlyChecks * 2);
assert.equal(distanceConstructionChecks, firstDistanceWork.constructionChecks * 2);
assert.equal(distancePlayerUnitCalls, firstDistanceWork.playerUnitCalls * 2);
assert.equal(distanceGameUnitCalls, 0);
assert.equal(distancePortClassifierCalls, firstDistanceWork.portClassifiers * 2);
assert.equal(distanceRailOrMapCalls, 0, "a cache refresh remains free of full map and rail scans");
assert.equal(distanceWorkerCalls, 0, "a cache refresh remains free of worker probes");
