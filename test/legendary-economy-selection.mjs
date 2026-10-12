import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

const UNIT = {
  AtomBomb: "AtomBomb",
  City: "City",
  DefensePost: "DefensePost",
  Factory: "Factory",
  HydrogenBomb: "HydrogenBomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRVWarhead",
  MissileSilo: "MissileSilo",
  Port: "Port",
  SAMLauncher: "SAMLauncher",
  TradeShip: "TradeShip",
  Train: "Train",
  Warship: "Warship",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const sandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team", FFA: "Free For All" },
  PlayerType: { Bot: "Bot", Nation: "Nation", Human: "Human" },
  state: { settings: { winFixes: false }, stats: { builds: 0 } },
  currentDifficulty: () => Difficulty.Legendary,
  isLegendaryDifficulty: () => true,
  isAtLeastHardDifficulty: () => true,
  getBuildMenu: () => ({ sendBuildOrUpgrade: () => true }),
  sendAutoBotBuildOrUpgrade: () => false,
  autoBotBuildAllowed: () => true,
  randTerritoryTileArray: () => [5, 9, 10],
  withTimeout: (promise) => promise,
  WORKER_TIMEOUT_MS: 50,
  setLastAction: () => {},
  tr: (value) => value,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/legendaryPlanner.js") +
    "\n" +
    readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js") +
    "\nglobalThis.__StructureBehavior = StructureBehavior;",
  sandbox,
  { filename: "legendary-economy-selection.vm.js" },
);

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
  buildables: async (tile, types) => [
    {
      type: types[0],
      canBuild: tile,
      canUpgrade: false,
      cost: 10_000n,
    },
  ],
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
