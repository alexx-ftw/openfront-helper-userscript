import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { createConstructionSimulator } from "./helpers/construction-simulator.mjs";

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

process.stdout.write("construction simulator tests passed\n");
