import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";
import {
  createConstructionSimulator,
  expectedRailIncomePerTick,
  simulateRailTransitRevenue,
} from "./helpers/construction-simulator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const structureSource = readStructureBehaviorSource();
const sandbox = {
  Difficulty: { Impossible: "Impossible" },
  GameMode: { Team: "Team" },
  UNIT: { City: "City", Port: "Port", Factory: "Factory", SAMLauncher: "SAM Launcher" },
  currentDifficulty: () => "Impossible",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => false,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${structureSource}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "structureBehavior.js" },
);

const simulator = createConstructionSimulator({
  width: 16,
  height: 8,
  ownerId: 7,
  ownedTiles: [20, 35, 50, 65, 4, 5],
  railTiles: [20, 35, 50, 65],
  randomTiles: [4, 5],
});
const behavior = Object.create(sandbox.__StructureBehavior.prototype);
behavior.game = simulator.game;
behavior.player = simulator.player;
behavior.prependSamCoveredTiles = (tiles) => tiles;
sandbox.randTerritoryTileArray = simulator.randomTerritoryTiles;

assert.deepEqual(
  Array.from(behavior.structureCandidateTiles(sandbox.UNIT.City, {}, 2)),
  [20, 50],
  "City evaluation contains rail anchors rather than random territory while owned rail exists",
);
behavior._commercialRailCityAnchorOffset = 0;

const builtCities = [];
for (let attempt = 0; attempt < 4; attempt++) {
  const candidates = behavior.structureCandidateTiles(sandbox.UNIT.City, {}, 2);
  builtCities.push(simulator.attemptCity(candidates));
}
assert.deepEqual(
  builtCities,
  [20, 35, 50, 65],
  "successive City attempts cover every owned railroad anchor before random territory",
);

const topologySimulator = createConstructionSimulator({
  width: 8,
  height: 8,
  ownerId: 7,
  // A horizontal line branches down at 19.  The significant City anchors are
  // its two ends, the junction, and the end of the branch; 18, 20 and 27 are
  // merely straight-through rail tiles.
  ownedTiles: [17, 18, 19, 20, 21, 27, 35, 4, 5],
  railTiles: [17, 18, 19, 20, 21, 27, 35],
  randomTiles: [4, 5],
});
const topologyBehavior = Object.create(sandbox.__StructureBehavior.prototype);
topologyBehavior.game = topologySimulator.game;
topologyBehavior.player = topologySimulator.player;
topologyBehavior.prependSamCoveredTiles = (tiles) => tiles;
sandbox.randTerritoryTileArray = topologySimulator.randomTerritoryTiles;

const topologyCities = [];
for (let attempt = 0; attempt < 4; attempt++) {
  const candidates = topologyBehavior.structureCandidateTiles(sandbox.UNIT.City, {}, 2);
  topologyCities.push(topologySimulator.attemptCity(candidates));
}
assert.deepEqual(
  topologyCities,
  [19, 17, 21, 35],
  "City attempts select the railway junction before endpoints, straight rail, or random territory",
);

const curveSimulator = createConstructionSimulator({
  width: 8,
  height: 8,
  ownerId: 7,
  // 17--18--19 turns down to 27--35.  Tile 18 is a direct segment and 19 is
  // a curve: neither should displace either endpoint, and the direct segment
  // should be selected before the curve.
  ownedTiles: [17, 18, 19, 27, 35, 4, 5],
  railTiles: [17, 18, 19, 27, 35],
  randomTiles: [4, 5],
});
const curveBehavior = Object.create(sandbox.__StructureBehavior.prototype);
curveBehavior.game = curveSimulator.game;
curveBehavior.player = curveSimulator.player;
curveBehavior.prependSamCoveredTiles = (tiles) => tiles;
sandbox.randTerritoryTileArray = curveSimulator.randomTerritoryTiles;

const curveCities = [];
for (let attempt = 0; attempt < 5; attempt++) {
  const candidates = curveBehavior.structureCandidateTiles(sandbox.UNIT.City, {}, 2);
  curveCities.push(curveSimulator.attemptCity(candidates));
}
assert.deepEqual(
  curveCities,
  [17, 35, 18, 27, 19],
  "City attempts select endpoints and direct rail segments before a rail curve",
);

const railJunction = new Map([
  ["factory-west", ["junction"]],
  ["factory-south", ["junction"]],
  ["junction", ["factory-west", "factory-south", "city-east", "city-north"]],
  ["city-east", ["junction"]],
  ["city-north", ["junction"]],
]);
const railBranch = new Map([
  ["factory-west", ["branch"]],
  ["factory-south", ["junction"]],
  ["branch", ["factory-west", "junction"]],
  ["junction", ["factory-south", "branch", "city-east", "city-north"]],
  ["city-east", ["junction"]],
  ["city-north", ["junction"]],
]);
const stationTypes = new Map([
  ["factory-west", "Factory"],
  ["factory-south", "Factory"],
  ["city-east", "City"],
  ["city-north", "City"],
]);
const duplicateFactoryAtJunction = simulateRailTransitRevenue({
  adjacency: railJunction,
  stationTypes: new Map([...stationTypes, ["junction", "Factory"]]),
  factoryIds: ["factory-west", "factory-south"],
  destinationIds: ["city-east", "city-north"],
  candidateId: null,
});
const junctionRevenue = simulateRailTransitRevenue({
  adjacency: railJunction,
  stationTypes,
  factoryIds: ["factory-west", "factory-south"],
  destinationIds: ["city-east", "city-north"],
  candidateId: "junction",
});
const branchRevenue = simulateRailTransitRevenue({
  adjacency: railBranch,
  stationTypes,
  factoryIds: ["factory-west", "factory-south"],
  destinationIds: ["city-east", "city-north"],
  candidateId: "branch",
});
assert.ok(
  junctionRevenue.revenueByStation.get("junction") > branchRevenue.revenueByStation.get("branch"),
  "a City at a transit junction earns from more Factory-to-destination routes than a branch City",
);
assert.ok(
  junctionRevenue.totalRevenue > duplicateFactoryAtJunction.totalRevenue,
  "a City at a rail junction adds paid transit stops whereas a duplicate Factory there adds none",
);

const alliedTradeLine = new Map([
  ["factory", ["self-city", "ally-port"]],
  ["self-city", ["factory"]],
  ["ally-port", ["factory"]],
]);
const selfTradeRevenue = simulateRailTransitRevenue({
  adjacency: alliedTradeLine,
  stationTypes: new Map([
    ["factory", "Factory"],
    ["self-city", "City"],
  ]),
  factoryIds: ["factory"],
  destinationIds: ["self-city"],
  candidateId: null,
});
const teamTradeRevenue = simulateRailTransitRevenue({
  adjacency: alliedTradeLine,
  stationTypes: new Map([
    ["factory", "Factory"],
    ["ally-port", "Port"],
  ]),
  factoryIds: ["factory"],
  destinationIds: ["ally-port"],
  candidateId: null,
  stationRelations: new Map([["ally-port", "team"]]),
});
const alliedTradeRevenue = simulateRailTransitRevenue({
  adjacency: alliedTradeLine,
  stationTypes: new Map([
    ["factory", "Factory"],
    ["ally-port", "Port"],
  ]),
  factoryIds: ["factory"],
  destinationIds: ["ally-port"],
  candidateId: null,
  stationRelations: new Map([["ally-port", "ally"]]),
});
assert.equal(selfTradeRevenue.totalRevenue, 10_000);
assert.equal(teamTradeRevenue.totalRevenue, 25_000);
assert.equal(alliedTradeRevenue.totalRevenue, 35_000);
assert.ok(
  alliedTradeRevenue.totalRevenue > teamTradeRevenue.totalRevenue &&
    teamTradeRevenue.totalRevenue > selfTradeRevenue.totalRevenue,
  "an allied commercial destination is more valuable than team and self destinations",
);

// A new Factory is not automatically the best next economic spend.  Two
// existing sources travelling through a City-sized rail intersection to two
// destinations create four paid transit opportunities.  That can exceed a
// Factory which only opens one isolated allied route, even though that route
// has the higher per-stop ally value.
const transitNetwork = new Map([
  ["factory-west", ["junction"]],
  ["factory-south", ["junction"]],
  ["junction", ["factory-west", "factory-south", "city-east", "port-north"]],
  ["city-east", ["junction"]],
  ["port-north", ["junction"]],
]);
const transitBaseline = simulateRailTransitRevenue({
  adjacency: transitNetwork,
  stationTypes: new Map([
    ["factory-west", "Factory"],
    ["factory-south", "Factory"],
    ["city-east", "City"],
    ["port-north", "Port"],
  ]),
  factoryIds: ["factory-west", "factory-south"],
  destinationIds: ["city-east", "port-north"],
});
const transitCity = simulateRailTransitRevenue({
  adjacency: transitNetwork,
  stationTypes: new Map([
    ["factory-west", "Factory"],
    ["factory-south", "Factory"],
    ["city-east", "City"],
    ["port-north", "Port"],
  ]),
  factoryIds: ["factory-west", "factory-south"],
  destinationIds: ["city-east", "port-north"],
  candidateId: "junction",
});
const isolatedFactory = simulateRailTransitRevenue({
  adjacency: new Map([
    ["factory-candidate", ["ally-port"]],
    ["ally-port", ["factory-candidate"]],
  ]),
  stationTypes: new Map([
    ["factory-candidate", "Factory"],
    ["ally-port", "Port"],
  ]),
  factoryIds: ["factory-candidate"],
  destinationIds: ["ally-port"],
  stationRelations: new Map([["ally-port", "ally"]]),
});
assert.ok(
  transitCity.totalRevenue - transitBaseline.totalRevenue > isolatedFactory.totalRevenue,
  "a City that becomes the transit intersection for several existing trains outranks a Factory that opens only one allied route",
);

const servedFactoryIncome = expectedRailIncomePerTick({
  adjacency: new Map([
    ["factory", ["city"]],
    ["city", ["factory"]],
  ]),
  stationTypes: new Map([
    ["factory", "Factory"],
    ["city", "City"],
  ]),
  factoryLevels: new Map([["factory", 1]]),
});
const idleFactoryIncome = expectedRailIncomePerTick({
  adjacency: new Map([
    ["factory", ["unused-factory"]],
    ["unused-factory", ["factory"]],
    ["disconnected-city", []],
  ]),
  stationTypes: new Map([
    ["factory", "Factory"],
    ["unused-factory", "Factory"],
    ["disconnected-city", "City"],
  ]),
  factoryLevels: new Map([
    ["factory", 1],
    ["unused-factory", 1],
  ]),
});
assert.ok(servedFactoryIncome.totalIncomePerTick > 0);
assert.equal(
  idleFactoryIncome.totalIncomePerTick,
  0,
  "a Factory without a reachable City or Port is an idle source",
);

const expectedTransitIncome = expectedRailIncomePerTick({
  adjacency: transitNetwork,
  stationTypes: new Map([
    ["factory-west", "Factory"],
    ["factory-south", "Factory"],
    ["city-east", "City"],
    ["port-north", "Port"],
  ]),
  stationOwners: new Map([
    ["factory-west", "self"],
    ["factory-south", "self"],
    ["city-east", "self"],
    ["port-north", "ally"],
  ]),
  factoryLevels: new Map([
    ["factory-west", 1],
    ["factory-south", 1],
  ]),
  candidate: { id: "junction", type: "City", owner: "self", level: 1 },
});
assert.ok(
  Math.abs(
    expectedTransitIncome.revenueByStation.get("junction") -
      expectedTransitIncome.totalSpawnProbability * 10_000,
  ) < 1e-9,
  "expected-income simulation prices a junction City on every train route",
);
assert.ok(
  expectedTransitIncome.revenueByStation.get("port-north") >
    expectedTransitIncome.revenueByStation.get("city-east"),
  "expected-income simulation preserves the higher allied stop payout",
);

// ── Falsifiable coverage bound to the live engine Config ────────────────────
// The engine sources are TypeScript, so they load through tsx (a devDependency)
// with the engine tsconfig that maps the engine's resource imports.
const { register: registerTsxLoader } = await import("tsx/esm/api");
const unregisterTsxLoader = registerTsxLoader({
  tsconfig: path.resolve(ROOT, "openfront-engine/tsconfig.json"),
});
const { Config: LiveEngineConfig } =
  await import("../openfront-engine/src/core/configuration/Config.ts");
const { UnitType: LiveUnitType, PlayerType: LivePlayerType } =
  await import("../openfront-engine/src/core/game/Game.ts");
unregisterTsxLoader();

const liveConfig = new LiveEngineConfig({}, null, false);
const liveGoldForTradeStop = (stopIndex, relation) =>
  Number(
    liveConfig.trainGold(relation, stopIndex, {
      isLobbyCreator: () => false,
    }),
  );
const livePlayerFactoryUnits = (units) => ({
  type: () => LivePlayerType.Human,
  unitsOwned: () => units,
  unitsConstructed: () => units,
});

// Saturation: the per-tick spawn probability for one level-one Factory with a
// single destination must equal 1 / (liveRate + 9) — the live rate under the
// ten-tick spawn cooldown — at every point of the saturation curve.
const singleFactoryRoute = {
  adjacency: new Map([
    ["factory", ["city"]],
    ["city", ["factory"]],
  ]),
  stationTypes: new Map([
    ["factory", "Factory"],
    ["city", "City"],
  ]),
  stationOwners: new Map([["city", "self"]]),
  factoryLevels: new Map([["factory", 1]]),
};
let previousSpawnProbability = Infinity;
for (const trainCount of [0, 35, 300, 560, 900, 1200]) {
  const expected = expectedRailIncomePerTick({
    ...singleFactoryRoute,
    trainCount,
    trainSpawnRate: (factoryUnits, trains) => liveConfig.trainSpawnRate(factoryUnits, trains),
  });
  const liveRate = liveConfig.trainSpawnRate(1, trainCount);
  assert.ok(
    Math.abs(expected.totalSpawnProbability - 1 / (liveRate + 9)) < 1e-12,
    `spawn probability follows live Config.trainSpawnRate under the cooldown at ${trainCount} train units`,
  );
  assert.ok(
    expected.totalIncomePerTick > 0,
    `a served Factory still earns at ${trainCount} train units`,
  );
  assert.ok(
    expected.totalSpawnProbability < previousSpawnProbability,
    `global train saturation monotonically lowers spawn probability at ${trainCount} train units`,
  );
  previousSpawnProbability = expected.totalSpawnProbability;
}
// The helper's built-in default must track the live formula on its own, not
// only when the test injects the live rate.
for (const trainCount of [0, 900]) {
  const defaultMirrored = expectedRailIncomePerTick({
    ...singleFactoryRoute,
    trainCount,
  });
  const defaultLiveRate = liveConfig.trainSpawnRate(1, trainCount);
  assert.ok(
    Math.abs(defaultMirrored.totalSpawnProbability - 1 / (defaultLiveRate + 9)) < 1e-9,
    `the simulator's default spawn rate mirrors live Config.trainSpawnRate at ${trainCount} train units`,
  );
}

// The cooldown never lets one Factory exceed a train every ten ticks.
const cappedSpawn = expectedRailIncomePerTick({
  ...singleFactoryRoute,
  trainSpawnRate: () => 1,
});
assert.equal(
  cappedSpawn.totalSpawnProbability,
  0.1,
  "the ten-tick spawn cooldown caps one Factory at 0.1 trains per tick",
);

// The live trainGold ladder: helper route revenue equals the Config payouts
// exactly, including the post-ten-stop decay to the 5k floor.
const decayChain = (stops, relation) => {
  const names = ["factory", ...Array.from({ length: stops }, (_, i) => `stop${i}`)];
  const adjacency = new Map(
    names.map((name, i) => [name, i + 1 < names.length ? [names[i + 1]] : [names[i - 1]]]),
  );
  const stationTypes = new Map(names.map((name, i) => [name, i === 0 ? "Factory" : "City"]));
  const stationRelations = new Map(names.slice(1).map((name) => [name, relation]));
  return simulateRailTransitRevenue({
    adjacency,
    stationTypes,
    factoryIds: ["factory"],
    destinationIds: [names.at(-1)],
    stationRelations,
  }).totalRevenue;
};
for (const [relation, stops] of [
  ["self", 12],
  ["team", 12],
  ["ally", 11],
]) {
  const expectedTotal = Array.from({ length: stops }, (_, stop) =>
    liveGoldForTradeStop(stop, relation),
  ).reduce((a, b) => a + b, 0);
  assert.equal(
    decayChain(stops, relation),
    expectedTotal,
    `route revenue equals the live ${relation} trainGold ladder across ${stops} paying stops`,
  );
}
assert.equal(decayChain(12, "self"), 110_000, "self decay floors at 5k after ten full-value stops");
assert.equal(decayChain(11, "ally"), 380_000, "ally decay prices the eleventh stop at 30k");

// Route connectivity: a City candidate on the shared bridge of an existing
// route earns a stop on every uniform-destination route and pushes the route
// endpoint into its decayed second-stop payout.
const bridgeNetwork = new Map([
  ["factory", ["bridge"]],
  ["bridge", ["factory", "city"]],
  ["city", ["bridge"]],
]);
const bridgeTypes = new Map([
  ["factory", "Factory"],
  ["city", "City"],
]);
const bridgeBaseline = expectedRailIncomePerTick({
  adjacency: bridgeNetwork,
  stationTypes: bridgeTypes,
  factoryLevels: new Map([["factory", 1]]),
});
const bridgedCity = expectedRailIncomePerTick({
  adjacency: bridgeNetwork,
  stationTypes: bridgeTypes,
  factoryLevels: new Map([["factory", 1]]),
  candidate: { id: "bridge", type: "City", owner: "self" },
});
const bridgeSpawnProbability = bridgedCity.totalSpawnProbability;
assert.ok(
  Math.abs(bridgeBaseline.totalIncomePerTick - bridgeBaseline.totalSpawnProbability * 10_000) <
    1e-9,
  "before the bridge candidate the route pays only the endpoint City",
);
assert.ok(
  Math.abs(bridgedCity.totalIncomePerTick - bridgeSpawnProbability * 15_000) < 1e-9 &&
    Math.abs(bridgedCity.revenueByStation.get("bridge") - bridgeSpawnProbability * 10_000) < 1e-9 &&
    Math.abs(bridgedCity.revenueByStation.get("city") - bridgeSpawnProbability * 5_000) < 1e-9,
  "a bridging City earns on every route and decays the endpoint to its second-stop payout",
);

// Horizon/cost: payback uses the live City cost ladder and construction time.
const cityUnitInfo = liveConfig.unitInfo(LiveUnitType.City);
const liveCityCostAt = (owned) => Number(cityUnitInfo.cost({}, livePlayerFactoryUnits(owned)));
assert.deepEqual(
  [0, 1, 2, 3, 4].map(liveCityCostAt),
  [125_000, 250_000, 500_000, 1_000_000, 1_000_000],
  "live City cost doubles per owned unit and caps at 1M",
);
const cityConstructionTicks = cityUnitInfo.constructionDuration;
const projectedRailGold = (incomePerTick, travelHops, horizonTicks) =>
  incomePerTick * Math.max(0, horizonTicks - cityConstructionTicks - travelHops);
assert.equal(
  projectedRailGold(1_000, 2, cityConstructionTicks + 1),
  0,
  "a horizon shorter than construction plus travel yields no rail gold",
);
const junctionHorizonIncome = expectedRailIncomePerTick({
  adjacency: transitNetwork,
  stationTypes: new Map([
    ["factory-west", "Factory"],
    ["factory-south", "Factory"],
    ["city-east", "City"],
    ["port-north", "Port"],
  ]),
  factoryLevels: new Map([["factory-west", 1]]),
  candidate: { id: "junction", type: "City", owner: "self" },
});
const endpointHorizonIncome = expectedRailIncomePerTick({
  adjacency: new Map([
    ["factory-west", ["far-end"]],
    ["far-end", ["factory-west", "dead-end"]],
    ["dead-end", ["far-end"]],
  ]),
  stationTypes: new Map([
    ["factory-west", "Factory"],
    ["dead-end", "City"],
  ]),
  factoryLevels: new Map([["factory-west", 1]]),
  candidate: { id: "dead-end", type: "City", owner: "self" },
});
assert.ok(
  junctionHorizonIncome.totalIncomePerTick > endpointHorizonIncome.totalIncomePerTick,
  "at equal build/travel delay the transit junction City earns more per tick than a dead-end City",
);
const cityCost = liveCityCostAt(2);
assert.ok(
  cityCost / junctionHorizonIncome.totalIncomePerTick <
    cityCost / endpointHorizonIncome.totalIncomePerTick,
  "the transit junction City pays back the live 500k cost sooner than the dead-end City",
);

// City cap pressure: each live City level is exactly one cityTroopIncrease of
// cap, so two level-one cities equal one level-two city.
const cityUnit = (level) => ({ level: () => level, isUnderConstruction: () => false });
const liveMaxTroopsWith = (cities) =>
  liveConfig.maxTroops({
    type: () => LivePlayerType.Human,
    numTilesOwned: () => 10_000,
    units: () => cities,
  });
assert.equal(liveConfig.cityTroopIncrease(), 250_000, "live City cap growth is 250k per level");
assert.equal(
  liveMaxTroopsWith([cityUnit(2)]) - liveMaxTroopsWith([cityUnit(1)]),
  250_000,
  "one City upgrade raises the live maxTroops cap by exactly one cityTroopIncrease",
);
assert.equal(
  liveMaxTroopsWith([cityUnit(1), cityUnit(1)]),
  liveMaxTroopsWith([cityUnit(2)]),
  "the cap reads summed City levels, so a new City and an upgrade trade evenly for cap",
);

// Upgrade-versus-new-route: a capacity-flagged City upgrade outranks a
// new-route Factory, while the same unflagged City only wins through its
// troop objective. Detection itself lives in computeTroopCapPressure tests.
const planningSandbox = {
  Difficulty: { Impossible: "Impossible", Legendary: "Legendary" },
  GameMode: { Team: "Team" },
  UNIT: { City: "City", Port: "Port", Factory: "Factory", SAMLauncher: "SAM Launcher" },
  currentDifficulty: () => "Legendary",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => true,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
planningSandbox.globalThis = planningSandbox;
executeClassicScript(
  `${readLegendaryPlannerSource()}\n` +
    `${structureSource}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  planningSandbox,
  { filename: "construction-simulator-planner.js" },
);
const planningBehavior = Object.create(planningSandbox.__StructureBehavior.prototype);
planningBehavior.player = { gold: () => 600_000n };
const newRouteFactory = {
  type: "Factory",
  cost: 500_000n,
  gold: 4,
  troops: 1,
  defense: 1,
  strategic: 1,
};
const capUpgradeFirst = planningBehavior.legendaryConstructionActionGroups(
  [
    newRouteFactory,
    {
      type: "City",
      action: "upgrade",
      upgradeCost: 250_000n,
      cost: 250_000n,
      gold: 3,
      troops: 5,
      defense: 1,
      capacity: 1,
    },
  ],
  true,
);
assert.equal(
  `${capUpgradeFirst[0][0].type}:${capUpgradeFirst[0][0].action ?? "build"}`,
  "City:upgrade",
  "the Legendary planner sends a capacity-flagged City upgrade before a new-route Factory",
);
const cityBuildFirst = planningBehavior.legendaryConstructionActionGroups(
  [newRouteFactory, { type: "City", cost: 250_000n, gold: 3, troops: 5, defense: 1 }],
  true,
);
assert.equal(
  `${cityBuildFirst[0][0].type}:${cityBuildFirst[0][0].action ?? "build"}`,
  "City:build",
  "without cap pressure the troop-heavy City objective outranks the new-route Factory",
);

process.stdout.write("construction simulator tests passed\n");
