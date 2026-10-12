import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const plannerSandbox = {};
executeClassicScript(read("engine/ingame/auto-bot/legendaryPlanner.js"), plannerSandbox, {
  filename: "legendaryPlanner.js",
});

const structureSandbox = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  UNIT: { City: "City", Factory: "Factory", Port: "Port" },
  currentDifficulty: () => "Impossible",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => false,
  legendaryPlacementProximityScore: (distance, radius) =>
    Math.max(0, 1 - distance / Math.max(1, radius)),
  UniversalPathFinding: null,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
Object.assign(structureSandbox, plannerSandbox);
structureSandbox.globalThis = structureSandbox;
executeClassicScript(
  `${read("engine/ingame/auto-bot/structureBehavior.js")}\nglobalThis.StructureBehavior = StructureBehavior;`,
  structureSandbox,
  { filename: "structureBehavior.js" },
);

const oceanComponent = -1;
const lakeComponent = 7;
const oceanShore = "ocean-shore";
const lakeShore = "lake-shore";
const existingOceanPortShore = "existing-ocean-port-shore";
const neighbors = new Map();
const waterComponentByTile = new Map();
const oceanTiles = new Set();
const shoreTiles = new Set([oceanShore, lakeShore, existingOceanPortShore]);

// The production open-water check accepts a connected component of 400 tiles.
const waterTilesForComponent = (firstTile, component, isOcean) => {
  const tiles = Array.from({ length: 400 }, (_, index) => firstTile + index);
  for (let index = 0; index < tiles.length; index++) {
    const adjacent = [];
    if (index > 0) adjacent.push(tiles[index - 1]);
    if (index + 1 < tiles.length) adjacent.push(tiles[index + 1]);
    neighbors.set(tiles[index], adjacent);
    waterComponentByTile.set(tiles[index], component);
    if (isOcean) oceanTiles.add(tiles[index]);
  }
  return tiles;
};

const oceanWater = waterTilesForComponent(1_000, oceanComponent, true);
const lakeWater = waterTilesForComponent(2_000, lakeComponent, false);
neighbors.set(oceanShore, [oceanWater[0]]);
neighbors.set(lakeShore, [lakeWater[0]]);
neighbors.set(existingOceanPortShore, [oceanWater[0]]);

const makePort = (tile, inProgress = false) => ({
  tile: () => tile,
  isUnderConstruction: () => inProgress,
  isMarkedForDeletion: () => false,
  isActive: () => true,
});
const actorPorts = [];
const makePlayer = (id, ports = []) => ({
  id: () => id,
  smallID: () => id,
  teamId: 5,
  isPlayer: () => true,
  isAlive: () => true,
  isOnSameTeam: (other) => other?.teamId === 5,
  isAlliedWith: () => false,
  hasEmbargoAgainst: () => false,
  units: (type) => (type === "Port" ? ports : []),
});
const actor = makePlayer(1, actorPorts);
const deterministicPartner = makePlayer(2);
const thirdTeammate = makePlayer(3);
const sharedComponents = new Map([
  [1, new Set([oceanComponent])],
  [2, new Set([oceanComponent])],
  [3, new Set([oceanComponent])],
]);

const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
Object.assign(behavior, {
  player: actor,
  game: {
    players: () => [thirdTeammate, actor, deterministicPartner],
    sharedWaterComponents: (owner) => sharedComponents.get(owner?.smallID?.()) ?? null,
    neighbors: (tile) => neighbors.get(tile) ?? [],
    forEachNeighbor: (tile, callback) => {
      for (const neighbor of neighbors.get(tile) ?? []) callback(neighbor);
    },
    isShore: (tile) => shoreTiles.has(tile),
    isWater: (tile) => waterComponentByTile.has(tile),
    isOcean: (tile) => oceanTiles.has(tile),
    getWaterComponent: (tile) => waterComponentByTile.get(tile),
  },
});
actor.borderTiles = () => [oceanShore, lakeShore];

assert.equal(behavior.portOwnerStateOnWater(actor, oceanComponent).completed, false);
assert.equal(behavior.portOwnerStateOnWater(actor, lakeComponent).completed, false);
assert.equal(behavior.legendaryPortSeedWindowOpen(), true);
assert.deepEqual(
  Array.from(behavior.legendaryPortSeedOwnerIds(oceanComponent)),
  ["1", "2"],
  "the ocean seed owner pair is chosen by stable ID even when players() lists the third teammate first",
);
assert.equal(
  behavior.legendaryPortSeedPartner(),
  deterministicPartner,
  "the deterministic second ocean owner is selected as partner",
);

const candidateTiles = Array.from(behavior.legendaryPortCandidateTilesForEconomy());
assert.deepEqual(candidateTiles, [oceanShore]);
assert.ok(!candidateTiles.includes(lakeShore), "shared inland lakes are not Port sites");

actorPorts.push(makePort(existingOceanPortShore, true));
assert.equal(behavior.portOwnerStateOnWater(actor, oceanComponent).inProgress, true);
assert.equal(
  behavior.legendaryPortSeedWindowOpen(),
  false,
  "starting the actor's Port on the canonical ocean closes the seed window",
);
assert.equal(behavior.legendaryPortSeedPartner(), null);
assert.deepEqual(
  Array.from(behavior.legendaryPortCandidateTilesForEconomy()),
  [],
  "an in-progress ocean Port prevents duplicate seed candidates",
);

process.stdout.write(
  "PASS Legendary Port seeding and candidate placement stay on the shared open ocean\n",
);
