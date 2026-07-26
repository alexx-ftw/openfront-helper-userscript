import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
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
  `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read("engine/ingame/auto-bot/structureBehavior.js")}\nglobalThis.__StructureBehavior = StructureBehavior;`,
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

behavior.player = { units: (type) => (type === UNIT.Factory ? [] : []) };
assert.equal(
  behavior.onlyDuplicateFactoryTradeCandidates([{ t: 20 }]),
  false,
  "the first Factory remains legal when no Factory exists yet",
);
