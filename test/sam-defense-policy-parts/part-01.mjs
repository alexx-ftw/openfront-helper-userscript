import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "#test/helpers/structure-behavior-source.mjs";
import { installLegalEconomyDispatchFixture } from "#test/helpers/legendary-structure-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "#test/helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";
import { readLegendaryPlannerSource } from "#test/helpers/legendary-planner-source.mjs";

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
let testDifficulty = Difficulty.Impossible;
const sandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation", Tribe: "Tribe" },
  state,
  currentDifficulty: () => testDifficulty,
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
const geometrySandbox = {};
executeClassicScript(
  `${read("engine/ingame/auto-bot/portutil.js")}\nglobalThis.closestTile = closestTile;`,
  geometrySandbox,
  { filename: "sam-defense-geometry.vm.js" },
);
sandbox.closestTile = geometrySandbox.closestTile;
const structureBehaviorSource = readStructureBehaviorSource();

executeClassicScript(
  `${read("engine/ingame/shared-utils.js")}
${readLegendaryPlannerSource()}
${structureBehaviorSource}
globalThis.__StructureBehavior = StructureBehavior;
globalThis.__isHostileActiveMissile = isHostileActiveMissile;`,
  sandbox,
  { filename: "sam-defense-policy.vm.js" },
);

const commercialRailBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const commercialRailState = new Uint8Array(10_000);
commercialRailState[1_012] = 1;
let commercialRailStateReads = 0;
commercialRailBehavior.game = {
  x: (tile) => tile % 100,
  y: (tile) => Math.floor(tile / 100),
  ref: (x, y) => y * 100 + x,
  isValidCoord: (x, y) => x >= 0 && x < 100 && y >= 0 && y < 100,
  magnitude: () => 0,
  railroadState: () => {
    commercialRailStateReads++;
    return commercialRailState;
  },
  euclideanDistSquared: (left, right) => {
    const dx = (left % 100) - (right % 100);
    const dy = Math.floor(left / 100) - Math.floor(right / 100);
    return dx * dx + dy * dy;
  },
  config: () => ({
    trainStationMinRange: () => 1,
    trainStationMaxRange: () => 100,
    nukeMagnitudes: () => ({ outer: 50 }),
  }),
};
commercialRailBehavior.player = {
  borderTiles: () => [],
  units: () => [],
};
commercialRailBehavior.spacingConstants = () => ({
  borderSpacing: 0,
  structureSpacing: 100,
});
commercialRailBehavior.nearestTileDistanceScorer = () => () => 0;
commercialRailBehavior.random = { nextInt: () => 0 };
commercialRailBehavior.getOrBuildReachableStations = () => [
  { tile: 1_000, cluster: "existing-commercial-line", weight: 1 },
];
commercialRailBehavior.getOrBuildFactoryTradeDestinations = () => [
  { tile: 1_000, cluster: "existing-commercial-line", weight: 1 },
];
testDifficulty = Difficulty.Easy;
const cityCommercialValue = commercialRailBehavior.cityValue();
const portCommercialValue = commercialRailBehavior.portValue();
const factoryCommercialValue = commercialRailBehavior.factoryValue();
assert.ok(
  cityCommercialValue(1_010) > cityCommercialValue(5_000),
  "Cities prefer a legal placement that snaps to a real existing commercial railroad even on Easy",
);
assert.ok(
  portCommercialValue(1_010) > portCommercialValue(5_000),
  "Ports prefer a legal placement that snaps to a real existing commercial railroad",
);
{
  const firstPortBehavior = Object.create(commercialRailBehavior);
  firstPortBehavior.game = {
    ...commercialRailBehavior.game,
    railroadState: () => commercialRailState,
  };
  firstPortBehavior.nearestTileDistanceScorer =
    sandbox.__StructureBehavior.prototype.nearestTileDistanceScorer;
  const firstPortValue = firstPortBehavior.portValue();
  assert.ok(
    Number.isFinite(firstPortValue(1_010)) && Number.isFinite(firstPortValue(5_000)),
    "first-Port scores remain finite when no other Port exists",
  );
  assert.ok(
    firstPortValue(1_010) > firstPortValue(5_000),
    "real empty-Port geometry preserves commercial placement preferences",
  );
}
{
  // Foreign open-ocean route distance: candidates on the same column differ
  // only by their distance to the foreign port, so the score gap isolates the
  // new term. tradeShipShortRangeDebuff caps it at 300.
  const makePlayer = (id, ports, embargoed) => ({
    id: () => id,
    smallID: () => id,
    isPlayer: () => true,
    hasEmbargoAgainst: () => Boolean(embargoed),
    units: (type) => (type === UNIT.Port ? ports : []),
  });
  const oceanPort = (tile, level = 1) => ({
    tile: () => tile,
    level: () => level,
    isUnderConstruction: () => false,
  });
  const buildingPort = (tile) => ({
    tile: () => tile,
    isUnderConstruction: () => true,
  });
  const foreignGame = {
    ...commercialRailBehavior.game,
    players: () => [],
    isOceanShore: (tile) => tile === 3_000 || tile === 9_900,
    railroadState: () => commercialRailState,
    config: () => ({
      ...commercialRailBehavior.game.config(),
      tradeShipShortRangeDebuff: () => 300,
    }),
  };
  const makeForeignBehavior = (owners) => {
