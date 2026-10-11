import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

const UNIT = { City: "City", Port: "Port", Factory: "Factory", SAMLauncher: "SAM Launcher" };
const sandbox = {
  UNIT,
  Difficulty: { Impossible: "Impossible", Legendary: "Legendary" },
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true, buildStructures: {} }, stats: { builds: 0 } },
  currentDifficulty: () => "Impossible",
  isLegendaryDifficulty: () => false,
  isAtLeastHardDifficulty: () => true,
  getBuildMenu: () => null,
  sendAutoBotBuildOrUpgrade: () => false,
  autoBotBuildAllowed: () => true,
  randTerritoryTileArray: () => [],
  setLastAction: () => {},
  tr: (value) => value,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/legendaryPlanner.js")}\n${readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js")}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "factory-placement-policy.vm.js" },
);

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
const factory = (tile) => ({ tile: () => tile });
behavior.game = {
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  config: () => ({ trainStationMinRange: () => 15, trainStationMaxRange: () => 110 }),
};
behavior.player = { units: (type) => (type === UNIT.Factory ? [factory(0)] : []) };
behavior.getOrBuildFactoryTradeDestinations = () => [
  { tile: 60, cluster: null, weight: 1 },
  { tile: 250, cluster: null, weight: 1 },
];

assert.deepEqual(
  behavior.novelFactoryTradeCandidates([{ t: 20 }, { t: 160 }]).map(({ t }) => t),
  [160],
  "when a safe Factory candidate opens a new paid City/Port route, duplicate nearby Factory candidates are excluded",
);

behavior.getOrBuildFactoryTradeDestinations = () => [{ tile: 60, cluster: null, weight: 1 }];
assert.deepEqual(
  behavior.novelFactoryTradeCandidates([{ t: 20 }, { t: 100 }]).map(({ t }) => t),
  [],
  "when every candidate would duplicate the only paid route, report no novel route",
);
assert.equal(
  behavior.onlyDuplicateFactoryTradeCandidates([{ t: 20 }, { t: 100 }]),
  true,
  "when every safe Factory candidate duplicates existing paid routes, decline Factory construction so City/Port can be considered",
);

behavior.player = { units: () => [] };
assert.equal(
  behavior.onlyDuplicateFactoryTradeCandidates([{ t: 20 }]),
  false,
  "the first Factory remains legal when no Factory exists yet",
);

behavior.getOrBuildFactoryTradeDestinations = () => [];
behavior.isDangerousStructureTile = () => false;
assert.equal(
  behavior.rankStructureSpawnTiles(UNIT.Factory, {}, [20], () => 1, null).safeScored.length,
  1,
  "non-Legendary tiers retain Factory placement when no paid stop is reachable",
);
sandbox.isLegendaryDifficulty = () => true;
assert.equal(
  behavior.rankStructureSpawnTiles(UNIT.Factory, {}, [20], () => 1, null).safeScored.length,
  0,
  "Legendary suppresses an idle Factory with no paid stop",
);

let spawnProbeCalled = false;
behavior.structureSpawnTile = async () => {
  spawnProbeCalled = true;
  return { canBuild: 20 };
};
sandbox.isLegendaryDifficulty = () => false;
assert.deepEqual(
  await behavior.structureSpawnBuildable(UNIT.Factory, [], false, {}),
  { canBuild: 20 },
  "non-Legendary Factory construction keeps its existing placement probe",
);
assert.equal(spawnProbeCalled, true);
spawnProbeCalled = false;
sandbox.isLegendaryDifficulty = () => true;
assert.equal(
  await behavior.structureSpawnBuildable(UNIT.Factory, [], false, {}),
  false,
  "Legendary skips Factory placement probes when no paid stop exists",
);
assert.equal(spawnProbeCalled, false);

const selfCity = { id: () => 1, tile: () => 40, hasTrainStation: () => false };
const alliedPort = { id: () => 2, tile: () => 80, hasTrainStation: () => false };
const hostileCity = { id: () => 3, tile: () => 120, hasTrainStation: () => false };
const alliedPlayer = { units: () => [alliedPort] };
const hostilePlayer = { units: () => [hostileCity] };
behavior.player = {
  units: () => [selfCity],
  nearby: () => [alliedPlayer, hostilePlayer],
  isAlliedWith: (player) => player === alliedPlayer,
  isOnSameTeam: () => false,
};
behavior.isTradeableStationNeighbor = (player) => player === alliedPlayer;
behavior.trainGoldBase = (relation) => ({ self: 10_000, ally: 35_000 })[relation] ?? 25_000;
assert.deepEqual(
  Array.from(behavior.collectFactoryTradeDestinations(), ({ tile, weight }) => ({
    tile: Number(tile),
    weight: Number(weight),
  })),
  [
    { tile: 40, weight: 10_000 / 35_000 },
    { tile: 80, weight: 1 },
  ],
  "Factory scoring includes unstationed own and allied City/Port destinations that the new Factory will promote",
);
