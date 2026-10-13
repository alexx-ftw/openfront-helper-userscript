import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({
  randTerritoryTiles: [5, 9, 10],
  vmFilename: "legendary-economy-selection.vm.js",
});
const { UNIT } = sandbox;

const railState = Array(12).fill(0);
railState[2] = 1;
railState[3] = 1;
railState[4] = 1;
railState[7] = 1;
railState[8] = 1;
const routeProfile = (clusterId, factorySourceCount, goldPerSpawn) => ({
  clusterId,
  factorySourceCount,
  paidStops: 1,
  teamGoldPerSpawn: goldPerSpawn,
  postTeamGoldPerSpawn: goldPerSpawn,
  teamGoldAfterPendingPerSpawn: goldPerSpawn,
  postTeamGoldAfterPendingPerSpawn: goldPerSpawn,
  payoutTimeline: [],
  pendingStopDelayTicks: 0,
  eligibleTicks: Infinity,
});
const economyInputs = (factorySourceCount = 0) => ({
  trainCount: 0,
  factoryPaidStops: 1,
  factoryTeamGoldPerTrain: 50_000,
  ownFactoryCount: 3,
  ownProductiveFactoryLevels: [1, 1, 1],
  ownPendingFactoryLevels: [],
  ownPendingFactoryDelayTicks: 0,
  routeDelayTicks: 0,
  ownerFactoryClusters: [
    {
      clusterId: "rail#other",
      productiveFactoryLevels: [1, 1, 1],
      pendingFactoryLevels: [],
      teamGoldPerSpawn: 30_000,
      postTeamGoldPerSpawn: 30_000,
      teamGoldAfterPendingPerSpawn: 30_000,
      postTeamGoldAfterPendingPerSpawn: 30_000,
      factoryConstructionDelayTicks: 0,
      pendingStopDelayTicks: 0,
      eligibleTicks: Infinity,
    },
  ],
  factoryRouteProfiles: [
    routeProfile("rail#0", factorySourceCount, 50_000),
    routeProfile("rail#1", factorySourceCount, 120_000),
  ],
  factoryStationEntries: [
    { tile: 2, cluster: "rail#0", weight: 1 },
    { tile: 7, cluster: "rail#1", weight: 1 },
  ],
  factoryRailState: railState,
});
const strategicState = (factorySourceCount = 0) => ({
  railNeed: 0.25,
  tradeNeed: 0.25,
  connectedCities: 1,
  cityRailConnection: 1,
  missileThreat: { critical: false, score: 0 },
  samLevelParityGap: 0,
  siloParityGap: 0,
  siloParityTarget: 0,
  targetPressure: 0,
  defenseGap: 0,
  economyHorizonTicks: 1_000,
  economyInputs: economyInputs(factorySourceCount),
});

const config = {
  isUnitDisabled: (type) => type === UNIT.Port,
  unitInfo: () => ({ constructionDuration: 20 }),
  trainSpawnRate: (_factories, trains) => 100 + trains * 1_000,
  trainStationMinRange: () => 1,
  trainStationMaxRange: () => 10,
};
const factoryUnit = (tile, id = String(tile)) => ({
  id: () => id,
  tile: () => tile,
  level: () => 1,
  isUnderConstruction: () => false,
});
const ownedFactories = [factoryUnit(0, "factory-a"), factoryUnit(11, "factory-b")];
const behavior = Object.create(sandbox.__StructureBehavior.prototype);
behavior.game = {
  config: () => config,
  railroadState: () => railState,
  width: () => railState.length,
  height: () => 1,
  neighbors: (tile) =>
    [tile - 1, tile + 1].filter((neighbor) => neighbor >= 0 && neighbor < railState.length),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  ticks: () => 1,
};
behavior.player = {
  gold: () => 10_000_000n,
  units: (type) => (type === UNIT.Factory ? ownedFactories : []),
  buildables: async (tile, types) =>
    Array.from(types, (type) => ({
      type,
      canBuild: tile,
      canUpgrade: false,
      cost: 10_000n,
    })),
};
behavior.legendaryConstructionState = ({ cityCount }) => ({
  ...strategicState(0),
  cityCount,
});
behavior.probeLegendaryThroughputUpgradeCandidates = async () => [];
behavior.computeTroopCapPressure = () => false;
behavior.legendaryConstructionCandidateBlocked = () => false;
behavior.legendaryBigStartSiloCandidateBlocked = () => false;
behavior.legendaryPortCapable = () => false;
behavior.legendaryNavalFrontLoadSuppressed = () => false;
behavior.ownedLevels = (type) =>
  ({
    [UNIT.City]: 4,
    [UNIT.Factory]: 3,
  })[type] ?? 0;
behavior.cost = () => 10_000n;
behavior.legendaryCostFactor = () => 1;
behavior.availableGoldAfterReserve = () => 10_000_000n;

const candidatesAtLocalFactoryRatio = await behavior.legendaryConstructionCandidates({
  config,
  citiesDisabled: false,
  cityCount: 4,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
const uniqueRouteFactory = candidatesAtLocalFactoryRatio.find(
  (candidate) => candidate.type === UNIT.Factory && candidate.action !== "upgrade",
);
assert.ok(
  uniqueRouteFactory,
  "a profitable unique Factory route must enter production ranking after the local Factory ratio is met",
);
assert.ok(
  uniqueRouteFactory.netTeamGold > 0n,
  "the newly connected Factory candidate carries positive value from the production ROI evaluator",
);
assert.equal(
  uniqueRouteFactory.factoryPlacementTile,
  9,
  "the evaluator selects the higher-value route profile and retains its exact sampled tile",
);
const nonbindingCity = candidatesAtLocalFactoryRatio.find(
  (candidate) => candidate.type === UNIT.City,
);
assert.ok(nonbindingCity, "the production portfolio contains a feasible nonbinding City candidate");
assert.equal(nonbindingCity.capacity, 0, "a City adds no troop-cap value below pressure");
assert.equal(
  behavior.legendaryConstructionActionGroups(candidatesAtLocalFactoryRatio, true)[0]?.[0]?.type,
  UNIT.Factory,
  "the production portfolio selects the profitable paid-stop Factory over the nonbinding City",
);

const noPaidStopState = strategicState(0);
noPaidStopState.economyInputs.factoryRouteProfiles =
  noPaidStopState.economyInputs.factoryRouteProfiles.map((profile) => ({
    ...profile,
    paidStops: 0,
  }));
behavior.legendaryConstructionState = ({ cityCount }) => ({
  ...noPaidStopState,
  cityCount,
});
const candidatesWithoutPaidStop = await behavior.legendaryConstructionCandidates({
  config,
  citiesDisabled: false,
  cityCount: 4,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
assert.equal(
  candidatesWithoutPaidStop.some((candidate) => candidate.type === UNIT.Factory),
  false,
  "removing every paid stop removes the Factory from production candidates",
);

// A first Factory can create the first TrainStation cluster around an
// unstated City/Port. The seed is priced from its station range and live rates.
const seedStop = {
  tile: 2,
  teamGoldPerSpawn: 100_000,
  teamGoldAfterPendingPerSpawn: 100_000,
  pending: false,
  constructionDelayTicks: 0,
  isTeam: true,
  allianceTicksRemaining: Infinity,
};
const seedInputs = {
  ...economyInputs(0),
  ownFactoryCount: 0,
  ownProductiveFactoryLevels: [],
  ownPendingFactoryLevels: [],
  ownerFactoryClusters: [],
  factoryPaidStops: 0,
  factoryTeamGoldPerTrain: 0,
  factoryRouteProfiles: [],
  factoryStationEntries: [],
  factoryRailState: new Uint8Array(128),
  factorySeedStops: [seedStop],
  routeDelayTicks: 10,
};
const seedBehavior = Object.create(sandbox.__StructureBehavior.prototype);
// ghostRailPaths is the placement-time rail proof the seed gate requires; the
// fixture supplies one for every probed tile so range filtering stays visible.
let seedGhostRailByTile = { 5: [[5, 2]], 15: [[15, 2]] };
let seedCandidateTiles = [5, 15];
let seedCandidate5Cluster = null;
let seedCandidate15Cluster = "rail#factoryless";
Object.assign(seedBehavior, {
  game: {
    config: () => config,
    width: () => 128,
    height: () => 1,
    euclideanDistSquared: (left, right) => (left - right) ** 2,
    ticks: () => 1,
  },
  player: {
    gold: () => 10_000_000n,
    units: () => [],
    buildables: async (tile, types) =>
      Array.from(types, (type) => ({
        type,
        canBuild: tile,
        canUpgrade: false,
        cost: 10_000n,
        ghostRailPaths: seedGhostRailByTile[tile] ?? [],
      })),
  },
  assignRailClusters: (entries) =>
    entries.map(({ tile }) => {
      const value = Number(tile);
      if (value === 99) return "rail#unrelated";
      if (value === 98) return "rail#factoryless";
      if (value === 100) return "rail#unrelated";
      if (value === 4) return "rail#0";
      if (value === 5) return seedCandidate5Cluster;
      if (value === 15) return seedCandidate15Cluster;
      if (value === 10) return "rail#nearby";
      return null;
    }),
  legendaryConstructionState: ({ cityCount }) => ({
    ...strategicState(0),
    cityCount,
    economyHorizonTicks: 1_000,
    economyInputs: seedInputs,
  }),
  probeLegendaryThroughputUpgradeCandidates: async () => [],
  structureCandidateTiles: (type) => (type === UNIT.Factory ? seedCandidateTiles : []),
  computeTroopCapPressure: () => false,
  legendaryConstructionCandidateBlocked: () => false,
  legendaryBigStartSiloCandidateBlocked: () => false,
  legendaryPortCapable: () => false,
  legendaryNavalFrontLoadSuppressed: () => false,
  ownedLevels: () => 0,
  cost: () => 10_000n,
  legendaryCostFactor: () => 1,
  availableGoldAfterReserve: () => 10_000_000n,
});
assert.equal(
  seedBehavior.legendaryFactorySeedPathAvoidsRails([], null),
  false,
  "a seed route fails closed when the live rail map is unavailable",
);
assert.equal(
  seedBehavior.legendaryFactorySeedPathAvoidsRails([], new Uint8Array(0)),
  false,
  "an empty railroad buffer fails closed instead of masquerading as an empty map",
);
assert.equal(
  seedBehavior.legendaryFactorySeedPathAvoidsRails([], new Uint8Array(128)),
  true,
  "a full-sized all-zero rail map proves there are no rails to cross",
);
assert.equal(
  seedBehavior.legendaryFactorySeedPathAvoidsRails([], new Uint8Array(127)),
  false,
  "a truncated railroad buffer fails closed",
);
const typedRailState = new Uint8Array(128);
typedRailState[100] = 1;
assert.equal(
  seedBehavior.legendaryFactorySeedPathAvoidsRails([[5, 100]], typedRailState),
  false,
  "a typed live railroad buffer still rejects a seed path crossing an existing rail",
);
assert.equal(
  seedBehavior.legendaryFactorySeedPlacementIsolated(
    5,
    [{ tile: 99 }],
    new Uint8Array(128),
    config,
  ),
  true,
  "a typed live railroad buffer can prove a Factory seed is isolated from other stations",
);
const seedCandidateInput = {
  config,
  citiesDisabled: false,
  cityCount: 4,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
};
const seedCandidates = await seedBehavior.legendaryConstructionCandidates(seedCandidateInput);
const seedFactory = seedCandidates.find(
  (candidate) => candidate.type === UNIT.Factory && candidate.action !== "upgrade",
);
assert.ok(
  seedFactory?.netTeamGold > 0n,
  "a first Factory can price an unstated paid City in its hypothetical seed cluster",
);
assert.equal(
  seedFactory.factoryPlacementTile,
  5,
  "seed ROI keeps the in-range Factory tile and rejects the out-of-range site",
);

seedInputs.factoryStationEntries = [{ tile: 99, cluster: "rail#unrelated" }];
seedInputs.factoryRailState = new Uint8Array(128);
seedInputs.factoryRailState[99] = 1;
seedInputs.factoryRouteProfiles = [
  {
    clusterId: "rail#unrelated",
    factorySourceCount: 1,
    paidStops: 1,
    teamGoldPerSpawn: 100_000,
  },
];
assert.ok(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  "a stationless teammate stop can seed a profitable Factory beside an unrelated active rail network",
);
seedInputs.factoryStationEntries = [
  { tile: 99, cluster: "rail#unrelated" },
  { tile: 98, cluster: "rail#factoryless" },
];
seedInputs.factoryRouteProfiles = [
  {
    clusterId: "rail#unrelated",
    factorySourceCount: 1,
    paidStops: 1,
    teamGoldPerSpawn: 100_000,
  },
  {
    clusterId: "rail#factoryless",
    factorySourceCount: 0,
    paidStops: 1,
    teamGoldPerSpawn: 1_000,
    postTeamGoldPerSpawn: 1_000,
    teamGoldAfterPendingPerSpawn: 1_000,
    postTeamGoldAfterPendingPerSpawn: 1_000,
  },
];
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).find(
    (candidate) => candidate.type === UNIT.Factory && candidate.action !== "upgrade",
  )?.factoryPlacementTile,
  5,
  "a more profitable isolated seed competes with and beats a lower-value empty cluster",
);
seedInputs.factoryStationEntries = [{ tile: 99, cluster: "rail#unrelated" }];
seedInputs.factoryRouteProfiles = [
  {
    clusterId: "rail#unrelated",
    factorySourceCount: 1,
    paidStops: 1,
    teamGoldPerSpawn: 100_000,
  },
];
seedCandidateTiles = [15];
seedCandidate15Cluster = "rail#unrelated";
seedGhostRailByTile = { 15: [[15, 2]] };
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a seed candidate mapped onto an active rail cluster is not priced as isolated",
);
seedCandidateTiles = [5, 15];
seedCandidate15Cluster = "rail#factoryless";
seedGhostRailByTile = { 5: [[5, 99, 2]], 15: [] };
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a seed ghost path crossing a known station is rejected",
);
seedGhostRailByTile = { 5: [[5, 100, 2]], 15: [] };
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a seed ghost path crossing existing rail is rejected even without a station tile",
);
seedInputs.factoryStationEntries = [
  { tile: 99, cluster: "rail#unrelated" },
  { tile: 98, cluster: "rail#factoryless" },
];
seedInputs.factoryRouteProfiles = [
  {
    clusterId: "rail#unrelated",
    factorySourceCount: 1,
    paidStops: 1,
    teamGoldPerSpawn: 100_000,
  },
  {
    clusterId: "rail#factoryless",
    factorySourceCount: 0,
    paidStops: 1,
    teamGoldPerSpawn: 1_000,
    postTeamGoldPerSpawn: 1_000,
    teamGoldAfterPendingPerSpawn: 1_000,
    postTeamGoldAfterPendingPerSpawn: 1_000,
  },
];
seedGhostRailByTile = { 5: [[5, 2]], 15: [[15, 2]] };
seedInputs.factoryStationEntries = [{ tile: 10, cluster: "rail#nearby" }];
seedInputs.factoryRouteProfiles = [
  {
    clusterId: "rail#nearby",
    factorySourceCount: 1,
    paidStops: 1,
    teamGoldPerSpawn: 100_000,
  },
];
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a seed candidate within an existing station's range is not priced as an isolated rail cluster",
);
seedInputs.factoryStationEntries = [];
seedInputs.factoryRailState = null;
seedInputs.factoryRouteProfiles = [];

let seedFactoryActionOptions = null;
const originalSeedMaybeSpawnStructure = seedBehavior.maybeSpawnStructure;
seedBehavior.maybeSpawnStructure = async (_type, options) => {
  seedFactoryActionOptions = options;
  return true;
};
assert.equal(
  await seedBehavior.legendaryConstructionActionGroupResult([seedFactory], [], 0),
  "built",
  "a profitable Factory seed reaches the construction action",
);
assert.deepEqual(
  seedFactoryActionOptions.legendaryEconomyFactorySeedStopTiles,
  seedFactory.factorySeedStopTiles,
  "the selected paid-stop proof is carried to the final build probe",
);
assert.deepEqual(
  seedFactoryActionOptions.legendaryEconomyFactorySeedStops,
  seedFactory.factorySeedStops,
  "the selected paid-stop payouts are carried to the final build probe",
);
seedBehavior.maybeSpawnStructure = originalSeedMaybeSpawnStructure;

const finalFactoryStopTiles = [seedFactory.factorySeedStopTiles[0], 3];
const finalFactorySeedStops = finalFactoryStopTiles.map((tile) => ({
  tile,
  teamGoldPerSpawn: seedStop.teamGoldPerSpawn,
}));
const finalFactoryBuildable = {
  canBuild: seedFactory.factoryPlacementTile,
  cost: 10_000n,
  ghostRailPaths: finalFactoryStopTiles.map((tile) => [seedFactory.factoryPlacementTile, tile]),
};
let finalFactoryEmissions = 0;
let liveFinalFactoryStops = finalFactorySeedStops.map((stop) => ({
  ...stop,
  pending: false,
}));
let liveFinalFactoryRouteProfiles = [];
let finalFactoryHorizonTicks = 1_000;
let finalFactoryTrainCount = 0;
let finalFactoryTrainCountAfterBuildable = null;
let finalFactoryCostAfterBuildable = null;
let finalFactoryStationEntries = [];
let finalFactoryRailState = new Uint8Array(128);
Object.assign(seedBehavior, {
  structureSpawnEligible: () => true,
  economicStructureSpawnPending: () => false,
  constructionCostForOptions: () => 10_000n,
  availableGoldAfterReserve: () => 10_000_000n,
  hasAnyShoreBorderTile: () => false,
  legendaryConstructionState: () => ({
    ...strategicState(0),
    economyHorizonTicks: finalFactoryHorizonTicks,
    economyInputs: {
      ...economyInputs(0),
      trainCount: finalFactoryTrainCount,
      factoryPaidStops: 2,
      factoryTeamGoldPerTrain: 100_000,
      ownFactoryCount: 0,
      ownProductiveFactoryLevels: [],
      ownPendingFactoryLevels: [],
      ownerFactoryClusters: [],
      factoryRouteProfiles: liveFinalFactoryRouteProfiles,
      factorySeedStops: liveFinalFactoryStops,
      factoryStationEntries: finalFactoryStationEntries,
      factoryRailState: finalFactoryRailState,
      routeDelayTicks: 10,
    },
  }),
  structureSpawnBuildable: async () => {
    if (finalFactoryTrainCountAfterBuildable !== null) {
      finalFactoryTrainCount = finalFactoryTrainCountAfterBuildable;
      finalFactoryTrainCountAfterBuildable = null;
    }
    if (finalFactoryCostAfterBuildable !== null) {
      finalFactoryBuildable.cost = finalFactoryCostAfterBuildable;
      finalFactoryCostAfterBuildable = null;
    }
    return finalFactoryBuildable;
  },
  emitStructureBuildable: () => {
    finalFactoryEmissions++;
    return true;
  },
});
const finalFactoryOptions = {
  legendaryEconomyCostQuote: seedFactory.cost,
  legendaryEconomyFactoryTile: seedFactory.factoryPlacementTile,
  legendaryEconomyFactorySeedStopTiles: finalFactoryStopTiles,
  legendaryEconomyFactorySeedStops: finalFactorySeedStops,
};
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  true,
  "the final buildable still reaches the paid stop selected during scoring",
);
finalFactoryStationEntries = [{ tile: 99, cluster: "rail#unrelated" }];
finalFactoryRailState = new Uint8Array(128);
finalFactoryRailState[99] = 1;
seedCandidate5Cluster = "rail#unrelated";
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "the final buildable is rejected if the site joins an existing rail cluster",
);
seedCandidate5Cluster = null;
finalFactoryBuildable.ghostRailPaths = [
  [seedFactory.factoryPlacementTile, 100, finalFactoryStopTiles[0]],
  [seedFactory.factoryPlacementTile, finalFactoryStopTiles[1]],
];
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "the final buildable is rejected if a fresh path joins existing rail",
);
finalFactoryStationEntries = [];
finalFactoryRailState = new Uint8Array(128);
finalFactoryRailState[100] = 1;
finalFactoryBuildable.ghostRailPaths = finalFactoryStopTiles.map((tile) => [
  seedFactory.factoryPlacementTile,
  tile,
]);
finalFactoryBuildable.ghostRailPaths = [
  [seedFactory.factoryPlacementTile, finalFactoryStopTiles[0]],
];
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "the final buildable is rejected when a selected stop endpoint is missing",
);
finalFactoryBuildable.ghostRailPaths = finalFactoryStopTiles.map((tile) => [
  seedFactory.factoryPlacementTile,
  tile,
]);
liveFinalFactoryStops = [liveFinalFactoryStops[0]];
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "the final buildable is rejected when a selected stop gains a station",
);
liveFinalFactoryStops = finalFactorySeedStops.map((stop) => ({
  ...stop,
  pending: false,
}));
liveFinalFactoryStops[1].teamGoldPerSpawn -= 1;
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "the final buildable is rejected when a selected stop's team payout falls",
);
liveFinalFactoryStops = finalFactorySeedStops.map((stop) => ({
  ...stop,
  pending: false,
}));
finalFactoryBuildable.ghostRailPaths = [[seedFactory.factoryPlacementTile, 3]];
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "the final buildable is rejected when no fresh path reaches the selected stops",
);
finalFactoryBuildable.ghostRailPaths = finalFactoryStopTiles.map((tile) => [
  seedFactory.factoryPlacementTile,
  tile,
]);
liveFinalFactoryStops = finalFactorySeedStops.map((stop) => ({
  ...stop,
  pending: false,
  isTeam: false,
  allianceTicksRemaining: 1,
}));
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "a seed build is rejected when the allied stop expires before it can repay cost",
);
liveFinalFactoryStops = finalFactorySeedStops.map((stop) => ({
  ...stop,
  pending: false,
  isTeam: true,
  allianceTicksRemaining: Infinity,
}));
finalFactoryHorizonTicks = 0;
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "a seed build is rejected when the refreshed horizon no longer repays it",
);
finalFactoryHorizonTicks = 1_000;
finalFactoryTrainCount = 1_000_000;
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, finalFactoryOptions),
  false,
  "a seed build is rejected when current train saturation makes its value nonpositive",
);
finalFactoryTrainCount = 0;
assert.equal(finalFactoryEmissions, 1, "a stale seed route never emits a Factory");

finalFactoryStationEntries = [{ tile: 4, cluster: "rail#0" }];
finalFactoryRailState = new Uint8Array(128);
liveFinalFactoryStops = [];
liveFinalFactoryRouteProfiles = [routeProfile("rail#0", 0, 100_000)];
seedCandidateTiles = [5];
seedCandidate5Cluster = "rail#0";
const ordinaryFactoryCandidate = (
  await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)
).find((candidate) => candidate.type === UNIT.Factory && candidate.action !== "upgrade");
assert.ok(
  ordinaryFactoryCandidate?.netTeamGold > 0n,
  "a productive existing rail route scores a positive ordinary Factory candidate",
);
const ordinaryStationTypes = [UNIT.City, UNIT.Port, UNIT.Factory];
let ordinaryStations = [];
const ordinaryStationBehavior = Object.create(sandbox.__StructureBehavior.prototype);
Object.assign(ordinaryStationBehavior, seedBehavior, {
  game: {
    ...seedBehavior.game,
    railroadState: () => finalFactoryRailState,
  },
  player: {
    ...seedBehavior.player,
    units: (...types) => ordinaryStations.filter((unit) => types.includes(unit.type)),
  },
});
const ordinaryStation = (type, active, markedForDeletion) => ({
  type,
  id: () => `${type}-station`,
  tile: () => 4,
  hasTrainStation: () => true,
  isActive: () => active,
  isMarkedForDeletion: () => markedForDeletion,
});
const ordinaryRouteFactoryAvailable = async () => {
  finalFactoryStationEntries = ordinaryStationBehavior.buildReachableStations(ordinaryStationTypes);
  return (await ordinaryStationBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) =>
      candidate.type === UNIT.Factory &&
      candidate.action !== "upgrade" &&
      candidate.netTeamGold > 0n,
  );
};
ordinaryStations = [ordinaryStation(UNIT.City, true, false)];
assert.equal(
  await ordinaryRouteFactoryAvailable(),
  true,
  "an active City station enables the ordinary profitable rail-cluster Factory route",
);
const invalidStationFactoryAvailability = [];
for (const [type, active, markedForDeletion] of [
  [UNIT.City, false, false],
  [UNIT.Port, true, true],
]) {
  ordinaryStations = [ordinaryStation(type, active, markedForDeletion)];
  invalidStationFactoryAvailability.push(await ordinaryRouteFactoryAvailable());
}
assert.deepEqual(
  invalidStationFactoryAvailability,
  [false, false],
  "inactive City and deletion-marked Port stations cannot enable an ordinary rail-cluster Factory",
);

const factoryReserve = 5_000n;
let factoryBuilderGold = 17_001n;
let ownFundsFactoryEmissions = 0;
const factoryBuilder = {
  ...seedBehavior.player,
  gold: () => factoryBuilderGold,
};
const wealthyTeammate = { gold: () => 1_000_000_000n };
const teamConfig = {
  ...config,
  gameConfig: () => ({ gameMode: sandbox.GameMode.Team }),
};
const ownFundsBehavior = Object.create(sandbox.__StructureBehavior.prototype);
Object.assign(ownFundsBehavior, seedBehavior, {
  game: {
    ...seedBehavior.game,
    config: () => teamConfig,
    players: () => [factoryBuilder, wealthyTeammate],
  },
  player: factoryBuilder,
  firstSamConstructionReserve: () => 0n,
  firstSiloConstructionReserve: () => 0n,
  legendaryAtomWarChest: () => factoryReserve,
  structureSpawnBuildable: async () => {
    factoryBuilderGold = 16_999n;
    return {
      canBuild: ordinaryFactoryCandidate.factoryPlacementTile,
      cost: 12_000n,
      ghostRailPaths: finalFactoryBuildable.ghostRailPaths,
    };
  },
  emitStructureBuildable: () => {
    ownFundsFactoryEmissions++;
    return true;
  },
});
delete ownFundsBehavior.availableGoldAfterReserve;
assert.equal(
  ownFundsBehavior.availableGoldAfterReserve(UNIT.Factory),
  12_001n,
  "the builder starts with enough own spendable gold for the authoritative Factory cost plus reserve",
);
assert.equal(
  await ownFundsBehavior.maybeSpawnStructure(UNIT.Factory, {
    legendaryEconomyCostQuote: ordinaryFactoryCandidate.cost,
    legendaryEconomyFactoryTile: ordinaryFactoryCandidate.factoryPlacementTile,
  }),
  false,
  "the async authoritative Factory cost is rejected when the builder falls below cost plus reserve despite a wealthy teammate",
);
assert.equal(factoryBuilderGold, 16_999n);
assert.equal(
  ownFundsBehavior.availableGoldAfterReserve(UNIT.Factory),
  11_999n,
  "the builder's post-probe own spendable gold is below the returned cost after reserve",
);
assert.equal(ownFundsFactoryEmissions, 0, "an unaffordable Factory is never emitted");

finalFactoryTrainCountAfterBuildable = 1_000_000;
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, {
    legendaryEconomyCostQuote: ordinaryFactoryCandidate.cost,
    legendaryEconomyFactoryTile: ordinaryFactoryCandidate.factoryPlacementTile,
  }),
  false,
  "an ordinary Factory route is rejected when train saturation turns its fresh ROI negative during the build probe",
);
assert.equal(finalFactoryEmissions, 1, "a stale ordinary route never emits a Factory");
finalFactoryTrainCount = 0;
finalFactoryCostAfterBuildable = 2_000_000n;
assert.equal(
  await seedBehavior.maybeSpawnStructure(UNIT.Factory, {
    legendaryEconomyCostQuote: ordinaryFactoryCandidate.cost,
    legendaryEconomyFactoryTile: ordinaryFactoryCandidate.factoryPlacementTile,
  }),
  false,
  "an ordinary Factory route is rejected when its post-probe buildable quote makes ROI negative",
);
assert.equal(finalFactoryEmissions, 1, "a stale quoted-cost route never emits a Factory");
finalFactoryBuildable.cost = 10_000n;
seedCandidateTiles = [5, 15];
seedCandidate5Cluster = null;

seedBehavior.legendaryConstructionState = ({ cityCount }) => ({
  ...strategicState(0),
  cityCount,
  economyHorizonTicks: 1_000,
  economyInputs: seedInputs,
});
seedInputs.factoryRailState = new Uint8Array(128);
seedInputs.factorySeedStops = [{ ...seedStop, tile: 7 }];
seedGhostRailByTile = { 5: [[7, 5]], 15: [] };
assert.ok(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  "a paid-stop endpoint at either end of the engine path proves the seed route",
);

seedInputs.factorySeedStops = [];
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "removing the seed paid stop vetoes the Factory candidate",
);
seedInputs.factorySeedStops = [{ ...seedStop, tile: 100 }];
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a paid stop outside live station range cannot seed a Factory",
);
seedInputs.factorySeedStops = [seedStop];
const ordinaryTrainSpawnRate = config.trainSpawnRate;
config.trainSpawnRate = () => 100_000;
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "global train saturation can make the first Factory seed unprofitable",
);
config.trainSpawnRate = ordinaryTrainSpawnRate;

seedGhostRailByTile = {};
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a seed site without a ghost rail path proof is rejected",
);
seedGhostRailByTile = { 5: [[5, 2]], 15: [[15, 2]] };

const routedCityScore = (
  await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)
).find((candidate) => candidate.type === UNIT.Factory)?.netTeamGold;
seedInputs.factorySeedStops = [seedStop, { ...seedStop, tile: 7, teamGoldPerSpawn: 900_000 }];
seedGhostRailByTile = { 5: [[5, 2]], 15: [[15, 3]] };
const blockedCityScore = (
  await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)
).find((candidate) => candidate.type === UNIT.Factory)?.netTeamGold;
assert.equal(
  blockedCityScore,
  routedCityScore,
  "a nearby paid City without an A* endpoint cannot inflate the Factory seed value",
);

seedInputs.factorySeedStops = [seedStop];
seedGhostRailByTile = { 5: [[5, 3]], 15: [[15, 3]] };
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a ghost path ending only at a non-paying Factory cannot prove a paid-stop route",
);

seedInputs.factorySeedStops = [{ ...seedStop, pending: true }];
seedGhostRailByTile = { 5: [[5, 2]], 15: [[15, 2]] };
assert.equal(
  (await seedBehavior.legendaryConstructionCandidates(seedCandidateInput)).some(
    (candidate) => candidate.type === UNIT.Factory && candidate.netTeamGold > 0n,
  ),
  false,
  "a pending paid City is excluded until construction completes and its route is repriced",
);
seedInputs.factorySeedStops = [seedStop];

// A City without a paid train route has no economic value, even when it would
// be the first landlocked City; only a real route or binding cap can justify it.
for (const { cityCount, expected, why } of [
  { cityCount: 0, expected: 0n, why: "the first landlocked City has no paid route or cap value" },
  {
    cityCount: 1,
    expected: 0n,
    why: "a later landlocked City also needs evaluated ROI or cap relief",
  },
]) {
  const candidates = await seedBehavior.legendaryConstructionCandidates({
    ...seedCandidateInput,
    cityCount,
  });
  const city = candidates.find(
    (candidate) => candidate.type === UNIT.City && candidate.action !== "upgrade",
  );
  assert.equal(city?.netTeamGold, expected, why);
  if (cityCount === 0) {
    assert.equal(
      seedBehavior
        .legendaryConstructionActionGroups(candidates, true)
        .flat()
        .some((candidate) => candidate.type === UNIT.City),
      false,
      "a zero-value founding City is filtered from the actionable economy group",
    );
  }
}

behavior.legendaryConstructionState = ({ cityCount }) => ({
  ...strategicState(0),
  cityCount,
  economyInputs: { ...economyInputs(0), trainCount: 1_000 },
});
const highSaturationCandidates = await behavior.legendaryConstructionCandidates({
  config,
  citiesDisabled: false,
  cityCount: 4,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
assert.equal(
  highSaturationCandidates.some((candidate) => candidate.type === UNIT.Factory),
  false,
  "live train saturation removes a Factory whose marginal value falls below cost",
);
assert.equal(
  behavior.legendaryConstructionActionGroups(highSaturationCandidates, true).flat().length,
  0,
  "with saturation and no binding cap, the production portfolio skips investment",
);
behavior.computeTroopCapPressure = () => true;
const pressuredSaturationCandidates = await behavior.legendaryConstructionCandidates({
  config,
  citiesDisabled: false,
  cityCount: 4,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
assert.equal(
  behavior.legendaryConstructionActionGroups(pressuredSaturationCandidates, true)[0]?.[0]?.type,
  UNIT.City,
  "under the same saturation, binding troop-cap pressure makes City the selected action",
);
behavior.computeTroopCapPressure = () => false;
behavior.legendaryConstructionState = ({ cityCount }) => ({
  ...strategicState(0),
  cityCount,
});

const rawComparison = behavior.legendaryConstructionActionGroups(
  [
    {
      type: UNIT.Factory,
      action: "build",
      cost: 1n,
      netTeamGold: 3_449_906n,
    },
    {
      type: UNIT.Factory,
      action: "upgrade",
      cost: 1n,
      netTeamGold: 2_961_802n,
    },
  ],
  true,
)[0];
assert.equal(
  rawComparison[0].action,
  "build",
  "the literal scenario comparison reproduces the duplicate-build ranking bug",
);

behavior.legendaryConstructionState = ({ cityCount }) => ({
  ...strategicState(1),
  cityCount,
});
behavior.probeLegendaryThroughputUpgradeCandidates = async () => [
  {
    type: UNIT.Factory,
    action: "upgrade",
    upgradeStructureId: "factory-a",
    upgradeCost: 1_000n,
    netTeamGold: 2_961_802n,
    mandatory: 0,
    safety: 0,
    capacity: 0,
    strategic: 0,
    deficit: 0,
    efficiency: 1,
  },
];
const sameClusterCandidates = await behavior.legendaryConstructionCandidates({
  config,
  citiesDisabled: false,
  cityCount: 8,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
assert.equal(
  sameClusterCandidates.some(
    (candidate) => candidate.type === UNIT.Factory && candidate.action !== "upgrade",
  ),
  false,
  "a same-cluster Factory build is suppressed when it adds no paid stop or route, even below the local ratio target",
);
assert.equal(
  behavior.legendaryConstructionActionGroups(sameClusterCandidates, true)[0][0]?.action,
  "upgrade",
  "the productive-network Factory upgrade wins once the duplicate build is removed",
);

const placementCalls = [];
sandbox.state.settings.winFixes = true;
sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
  placementCalls.push({ buildableTile: buildable.canBuild, tile });
  return true;
};
behavior.structureSpawnEligible = () => true;
behavior.structureTileValueFunction = () => () => 1;
behavior.structurePlacementCompactnessRanker = () => null;
behavior.structureMissileEmergency = () => ({ active: false });
behavior.isDangerousStructureTile = () => false;
behavior.isSafeBuildablePlacement = () => true;
behavior.getOrBuildFactoryTradeDestinations = () => [{ tile: 2, cluster: "rail#0" }];
behavior.economicPlacementBudgetLimit = (limit) => limit;
behavior.consumeEconomicPlacementBudget = () => {};
behavior.buildableCostOrFallback = (buildable, fallback) => buildable.cost ?? fallback;
behavior.isSafeBuildablePlacement = () => true;
behavior.legendaryConstructionState = ({ cityCount }) => ({
  ...strategicState(0),
  cityCount,
});
const probedFactoryTiles = [];
const originalBuildables = behavior.player.buildables;
behavior.player.buildables = async (tile, types) => {
  probedFactoryTiles.push(tile);
  return originalBuildables(tile, types);
};
const actionResult = await behavior.legendaryConstructionActionGroupResult(
  [uniqueRouteFactory],
  [],
  0,
);
assert.equal(actionResult, "built");
assert.deepEqual(
  probedFactoryTiles,
  [9],
  "the chosen Factory route tile reaches the real async buildability probe unchanged",
);
assert.deepEqual(
  placementCalls,
  [{ buildableTile: 9, tile: 9 }],
  "the same exact tile is emitted after buildability succeeds",
);

const emittedBeforeBlockedProbe = placementCalls.length;
const mismatched = Object.create(sandbox.__StructureBehavior.prototype);
Object.assign(mismatched, behavior);
let economicFallbacks = 0;
const failedProbeTiles = [];
mismatched.player = {
  ...behavior.player,
  buildables: async (tile) => {
    failedProbeTiles.push(tile);
    return [];
  },
};
mismatched.findEconomicPlacementOrExhaustion = async () => {
  economicFallbacks++;
  return { status: "buildable", buildable: { canBuild: 10 } };
};
assert.equal(
  await mismatched.maybeSpawnStructure(UNIT.Factory, {
    useActualCost: true,
    legendaryEconomyFactoryTile: 5,
  }),
  false,
  "an unbuildable ROI tile is declined without switching to an unprofiled site",
);
assert.deepEqual(failedProbeTiles, [5]);
assert.equal(economicFallbacks, 0);
assert.equal(placementCalls.length, emittedBeforeBlockedProbe);

mismatched.player.buildables = async (tile, types) => {
  failedProbeTiles.push(tile);
  return [
    {
      type: types[0],
      canBuild: 10,
      canUpgrade: false,
      cost: 10_000n,
    },
  ];
};
assert.equal(
  await mismatched.maybeSpawnStructure(UNIT.Factory, {
    useActualCost: true,
    legendaryEconomyFactoryTile: 5,
  }),
  false,
  "a profiled Factory cannot fall back to a different snapped tile",
);
assert.deepEqual(failedProbeTiles, [5, 5]);
assert.equal(economicFallbacks, 0);
assert.equal(placementCalls.length, emittedBeforeBlockedProbe);

process.stdout.write("legendary economy selection tests passed\n");
