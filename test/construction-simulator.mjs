import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import {
  createConstructionSimulator,
  expectedRailIncomePerTick,
  simulateRailTransitRevenue,
} from "./helpers/construction-simulator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const structureSource = fs.readFileSync(
  path.join(ROOT, "engine/ingame/auto-bot/structureBehavior.js"),
  "utf8",
);
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

process.stdout.write("construction simulator tests passed\n");
