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

process.stdout.write("construction simulator tests passed\n");
