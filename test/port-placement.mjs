import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_API_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/auto-bot/gameApi.js"),
  "utf8",
);
const STRUCTURE_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/auto-bot/structureBehavior.js"),
  "utf8",
);

const UNIT = {
  City: "City",
  DefensePost: "Defense Post",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  Port: "Port",
  Factory: "Factory",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  Warship: "Warship",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const structureSandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team" },
  state: { settings: { winFixes: true, buildStructures: {} } },
  currentDifficulty: () => Difficulty.Impossible,
  isLegendaryDifficulty: (difficulty = Difficulty.Impossible) =>
    difficulty === Difficulty.Legendary,
  isAtLeastHardDifficulty: (difficulty) =>
    difficulty === Difficulty.Hard ||
    difficulty === Difficulty.Impossible ||
    difficulty === Difficulty.Legendary,
  getBuildMenu: () => ({ sendBuildOrUpgrade: () => {} }),
  setLastAction: () => {},
  tr: (value) => value,
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1000,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
};
structureSandbox.globalThis = structureSandbox;
executeClassicScript(
  `${STRUCTURE_SOURCE}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  structureSandbox,
  { filename: "structureBehavior.js" },
);

function makeScenario({
  ocean = false,
  allied = false,
  otherAlive = true,
  zeroAllocationNeighbors = false,
  width = 9,
  height = 9,
} = {}) {
  const lake = new Set();
  for (let y = 3; y <= 5; y += 1) {
    for (let x = 3; x <= 5; x += 1) lake.add(y * width + x);
  }
  const cardinalNeighbors = (tile) => {
    const x = tile % width;
    const y = Math.floor(tile / width);
    const out = [];
    if (x > 0) out.push(tile - 1);
    if (x < width - 1) out.push(tile + 1);
    if (y > 0) out.push(tile - width);
    if (y < height - 1) out.push(tile + width);
    return out;
  };
  let neighborArrayCalls = 0;
  const neighbors = (tile) => {
    neighborArrayCalls++;
    return cardinalNeighbors(tile);
  };
  const land = new Set();
  for (let tile = 0; tile < width * height; tile += 1) {
    if (!lake.has(tile)) land.add(tile);
  }
  const meCoast = new Set([3 * width + 2, 4 * width + 2, 5 * width + 2]);
  const otherCoast = new Set([3 * width + 6, 4 * width + 6, 5 * width + 6]);
  const ownerByTile = new Map([
    ...Array.from(meCoast, (tile) => [tile, 1]),
    ...Array.from(otherCoast, (tile) => [tile, 2]),
  ]);

  const makePlayer = (smallID, coast) => ({
    isPlayer: () => true,
    smallID: () => smallID,
    id: () => `player-${smallID}`,
    type: () => "NATION",
    isAlive: () => smallID === 1 || otherAlive,
    borderTiles: () => new Set(coast),
    profile: () => ({ relations: {} }),
    units: () => [],
    hasEmbargoAgainst: () => false,
    isAlliedWith: () => allied,
    isFriendly: () => allied,
    isOnSameTeam: () => allied,
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    targets: () => [],
    allies: () => [],
    transitiveTargets: () => [],
    alliances: () => [],
    name: () => `player-${smallID}`,
    nameLocation: () => ({ x: 0, y: 0 }),
    numTilesOwned: () => coast.size,
    troops: () => 0,
    gold: () => 0n,
  });
  const me = makePlayer(1, meCoast);
  const other = makePlayer(2, otherCoast);
  const players = [me, other];
  let landNeighborChecks = 0;
  let waterChecks = 0;
  let shoreChecks = 0;

  const src = {
    width: () => width,
    height: () => height,
    ticks: () => 1,
    inSpawnPhase: () => false,
    isLand: (tile) => {
      landNeighborChecks++;
      return land.has(tile);
    },
    isWater: (tile) => {
      waterChecks++;
      return !land.has(tile);
    },
    isOcean: (tile) => ocean && tile >= width * 3 && tile < width * 4,
    isShore: (tile) => {
      shoreChecks++;
      return land.has(tile) && cardinalNeighbors(tile).some((neighbor) => !land.has(neighbor));
    },
    isOceanShore: (tile) =>
      land.has(tile) &&
      cardinalNeighbors(tile).some(
        (neighbor) => !land.has(neighbor) && ocean && neighbor >= width * 3 && neighbor < width * 4,
      ),
    neighbors,
    x: (tile) => tile % width,
    y: (tile) => Math.floor(tile / width),
    ref: (x, y) => y * width + x,
    isValidCoord: (x, y) => x >= 0 && x < width && y >= 0 && y < height,
    ownerID: (tile) => ownerByTile.get(tile) ?? 0,
    hasOwner: (tile) => ownerByTile.has(tile),
    hasFallout: () => false,
    players: () => players,
    playerBySmallID: (smallID) => players.find((p) => p.smallID() === smallID) ?? null,
    owner: () => me,
    numLandTiles: () => land.size,
    config: () => ({
      maxTroops: () => 0,
      isUnitDisabled: () => false,
      samRange: () => 0,
      defaultSamRange: () => 0,
    }),
    isSpawnImmunityActive: () => false,
    units: () => [],
    numTilesWithFallout: () => 0,
  };
  if (zeroAllocationNeighbors) {
    src.forEachNeighbor = (tile, visit) => {
      for (const neighbor of cardinalNeighbors(tile)) visit(neighbor);
    };
  }

  const sandbox = {
    PlayerType: { Bot: "BOT" },
    withTimeout: async (promise) => promise,
    WORKER_TIMEOUT_MS: 1000,
    captureRuntimeException: () => {},
    runtimeDebugLog: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(GAME_API_SOURCE, sandbox, { filename: "gameApi.js" });
  return {
    handle: sandbox.createGameApi(src),
    me,
    other,
    neighborArrayCalls: () => neighborArrayCalls,
    landNeighborChecks: () => landNeighborChecks,
    waterChecks: () => waterChecks,
    shoreChecks: () => shoreChecks,
  };
}

async function sharedWater({ ocean, allied, otherAlive }) {
  const scenario = makeScenario({ ocean, allied, otherAlive });
  const wrappedMe = await scenario.handle.beginTick(scenario.me);
  const shared = scenario.handle.game.sharedWaterComponents(wrappedMe);
  return shared ? [...shared].sort((a, b) => a - b) : null;
}

async function nearbyPlayers() {
  const scenario = makeScenario({ ocean: false, allied: true });
  const wrappedMe = await scenario.handle.beginTick(scenario.me);
  return wrappedMe.nearby();
}

const shoreCacheScenario = makeScenario({ ocean: false, allied: true });
const shoreCacheMe = await shoreCacheScenario.handle.beginTick(shoreCacheScenario.me);
const firstShoreScan = shoreCacheMe.shoreBorderTiles();
const checksAfterFirstShoreScan = shoreCacheScenario.shoreChecks();
assert.strictEqual(
  shoreCacheMe.shoreBorderTiles(),
  firstShoreScan,
  "shore-border callers share one array for the current border snapshot",
);
assert.equal(
  shoreCacheScenario.shoreChecks(),
  checksAfterFirstShoreScan,
  "reusing shore-border tiles performs no repeated terrain classification",
);

const zeroAllocationScenario = makeScenario({
  ocean: false,
  allied: true,
  zeroAllocationNeighbors: true,
});
const zeroAllocationMe = await zeroAllocationScenario.handle.beginTick(zeroAllocationScenario.me);
assert.deepEqual(
  [...zeroAllocationScenario.handle.game.sharedWaterComponents(zeroAllocationMe)],
  [0],
);
assert.equal(
  zeroAllocationScenario.neighborArrayCalls(),
  0,
  "shared-water labeling and coast scans prefer zero-allocation neighbor iteration",
);
const oceanCoastScenario = makeScenario({ ocean: true });
const oceanCoastMe = await oceanCoastScenario.handle.beginTick(oceanCoastScenario.me);
assert.deepEqual([...oceanCoastScenario.handle.game.sharedWaterComponents(oceanCoastMe)], [-1]);
assert.equal(
  oceanCoastScenario.landNeighborChecks(),
  0,
  "an ocean component does not collect a coastline that will be discarded",
);

const fastOceanScenario = makeScenario({
  ocean: true,
  zeroAllocationNeighbors: true,
  width: 300,
  height: 300,
});
const fastOceanMe = await fastOceanScenario.handle.beginTick(fastOceanScenario.me);
assert.equal(
  fastOceanScenario.handle.game.hasSharedWater(fastOceanMe),
  true,
  "ocean access satisfies the boolean shared-water query",
);
assert.ok(
  fastOceanScenario.waterChecks() < 20,
  "the ocean boolean fast path inspects only the small live border",
);
assert.equal(
  fastOceanScenario.neighborArrayCalls(),
  0,
  "the ocean boolean fast path keeps allocation-free neighbor iteration",
);

const deferredLakeScenario = makeScenario({
  ocean: false,
  allied: true,
  width: 300,
  height: 300,
});
const deferredLakeMe = await deferredLakeScenario.handle.beginTick(deferredLakeScenario.me);
assert.equal(
  deferredLakeScenario.handle.game.hasSharedWater(deferredLakeMe),
  false,
  "an inland-water decision defers until its component index is ready",
);
assert.ok(
  deferredLakeScenario.waterChecks() < 5_000,
  "a large inland-water index advances in one bounded tick slice instead of a full-map stall",
);
let deferredLakeResolved = false;
for (let slice = 0; slice < 50; slice++) {
  const player = await deferredLakeScenario.handle.beginTick(deferredLakeScenario.me);
  if (deferredLakeScenario.handle.game.hasSharedWater(player)) {
    deferredLakeResolved = true;
    break;
  }
}
assert.equal(
  deferredLakeResolved,
  true,
  "the completed cooperative index restores the exact shared-lake policy",
);

const sharedLakeScenario = makeScenario({ ocean: false, allied: true });
const sharedLakeMe = await sharedLakeScenario.handle.beginTick(sharedLakeScenario.me);
assert.equal(
  sharedLakeScenario.handle.game.hasSharedWater(sharedLakeMe),
  true,
  "a trusted shared inland lake remains coastal for economy policy",
);
const isolatedLakeScenario = makeScenario({ ocean: false, allied: false });
const isolatedLakeMe = await isolatedLakeScenario.handle.beginTick(isolatedLakeScenario.me);
assert.equal(
  isolatedLakeScenario.handle.game.hasSharedWater(isolatedLakeMe),
  false,
  "an isolated inland lake remains unavailable",
);

let sharedWaterBooleanCalls = 0;
let exactSharedWaterCalls = 0;
const contextBehavior = Object.create(structureSandbox.__StructureBehavior.prototype);
contextBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
  hasSharedWater: () => {
    sharedWaterBooleanCalls++;
    return true;
  },
  sharedWaterComponents: () => {
    exactSharedWaterCalls++;
    return new Set([-1]);
  },
};
contextBehavior.player = { numTilesOwned: () => 1, units: () => [] };
contextBehavior.hasOceanPortTiles = () => true;
contextBehavior.updateConstructionDominance = () => {};
contextBehavior.hasBorderingHostileMaxTroopAdvantage = () => false;
contextBehavior.shouldPrioritizeEconomicGrowth = () => false;
const fastStructureContext = contextBehavior.structureBuildContext();
assert.equal(fastStructureContext.hasCoastalTiles, true);
assert.equal(fastStructureContext.hasOceanPortTiles, true);
assert.equal(
  exactSharedWaterCalls,
  0,
  "structure context uses the boolean water contract instead of exact global labels",
);
assert.equal(
  sharedWaterBooleanCalls,
  0,
  "an already cached ocean coast avoids rescanning the live border for shared water",
);

assert.ok(
  Array.isArray(await nearbyPlayers()),
  "the real Set border snapshot is accepted by the nearby-player adapter",
);

async function portTiles({ ocean, allied = true } = {}) {
  const scenario = makeScenario({ ocean, allied });
  const wrappedMe = await scenario.handle.beginTick(scenario.me);
  const behavior = Object.create(structureSandbox.__StructureBehavior.prototype);
  behavior.game = scenario.handle.game;
  behavior.player = wrappedMe;
  behavior.random = {
    nextInt: (min) => min,
  };
  // A shared lake is deliberately present here to prove that the port filter
  // does not fall back to the broader shared-water predicate.
  behavior._sharedWaterComponents = new Set([0]);
  return behavior;
}

assert.equal(
  await sharedWater({ ocean: false, allied: false }),
  null,
  "a closed lake without an allied partner is not shared water",
);
assert.deepEqual(
  await sharedWater({ ocean: false, allied: true }),
  [0],
  "a closed lake shared with an ally remains available to non-port planning",
);
assert.equal(
  await sharedWater({ ocean: false, allied: true, otherAlive: false }),
  null,
  "a closed lake shared only with a dead ally is not shared water",
);
assert.deepEqual(
  await sharedWater({ ocean: true, allied: false }),
  [-1],
  "open ocean remains shared without an alliance",
);

const lakeBehavior = await portTiles({ ocean: false });
assert.equal(
  lakeBehavior.hasOceanPortTiles(),
  false,
  "a closed lake must not make an ocean port site available",
);
assert.deepEqual(
  Array.from(lakeBehavior.randCoastalTileArray(25)),
  [],
  "port candidate selection rejects a shared closed lake",
);
const lakeEconomicAttemptOrder = [];
lakeBehavior.shouldBuildStructure = (type) => type === UNIT.Port || type === UNIT.Factory;
lakeBehavior.maybeSpawnStructure = async (type) => {
  lakeEconomicAttemptOrder.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await lakeBehavior.maybePrioritizeEconomicGrowth({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 1,
    hasCoastalTiles: true,
    hasOceanPortTiles: false,
  }),
  true,
  "economic planning falls through to a factory when only a shared lake is available",
);
assert.deepEqual(
  lakeEconomicAttemptOrder,
  [UNIT.Factory],
  "economic planning never attempts a port on a shared closed lake",
);

const oceanBehavior = await portTiles({ ocean: true, allied: false });
assert.equal(
  oceanBehavior.hasOceanPortTiles(),
  true,
  "a shore bordering the canonical ocean remains a valid port site",
);
assert.deepEqual(
  Array.from(oceanBehavior.randCoastalTileArray(25)),
  [29],
  "port candidate selection keeps the ocean shore",
);

const largeCoastBehavior = Object.create(structureSandbox.__StructureBehavior.prototype);
let largeCoastRandomCalls = 0;
largeCoastBehavior.random = {
  nextInt: (_min, max) => {
    largeCoastRandomCalls++;
    return max - 1;
  },
};
const largeCoastSample = Array.from(
  largeCoastBehavior.arraySampler(
    Array.from({ length: 10_000 }, (_, index) => index),
    25,
  ),
);
assert.equal(largeCoastSample.length, 25);
assert.equal(new Set(largeCoastSample).size, 25, "coastal samples never repeat a tile");
assert.equal(
  largeCoastRandomCalls,
  25,
  "large coastal sampling makes one bounded random draw per candidate",
);

const cachedOceanPortTiles = [29];
let cachedOceanPortReads = 0;
const uncachedOceanPortClassifier = oceanBehavior.isOceanPortTile;
oceanBehavior.player = {
  ...oceanBehavior.player,
  oceanShoreBorderTiles: () => {
    cachedOceanPortReads++;
    return cachedOceanPortTiles;
  },
};
oceanBehavior.isOceanPortTile = () => {
  throw new Error("Auto-build must reuse the cached open-ocean border subset");
};
assert.strictEqual(
  oceanBehavior.oceanPortBorderTiles(),
  cachedOceanPortTiles,
  "Auto-build reuses the exact cached open-ocean border subset",
);
assert.equal(oceanBehavior.hasOceanPortTiles(), true);
assert.deepEqual(
  Array.from(oceanBehavior.randCoastalTileArray(25)),
  [29],
  "Port candidate selection consumes the shared cached open-ocean subset",
);
assert.equal(cachedOceanPortReads, 3, "all port queries delegate to the cached border adapter");
oceanBehavior.isOceanPortTile = uncachedOceanPortClassifier;

let oceanBorderSnapshot = new Set([29]);
let oceanTileClassificationCalls = 0;
const originalOceanPortTile = oceanBehavior.isOceanPortTile.bind(oceanBehavior);
oceanBehavior.player = {
  ...oceanBehavior.player,
  borderTiles: () => oceanBorderSnapshot,
  oceanShoreBorderTiles: () => null,
};
oceanBehavior.isOceanPortTile = (tile) => {
  oceanTileClassificationCalls++;
  return originalOceanPortTile(tile);
};
assert.equal(oceanBehavior.hasOceanPortTiles(), true);
assert.deepEqual(
  Array.from(oceanBehavior.randCoastalTileArray(25)),
  [29],
  "sampling reuses the exact filtered ocean-border snapshot",
);
assert.equal(
  oceanTileClassificationCalls,
  1,
  "one stable border snapshot is classified only once across port checks and sampling",
);
oceanBorderSnapshot = new Set();
assert.equal(oceanBehavior.hasOceanPortTiles(), false);
assert.equal(
  oceanTileClassificationCalls,
  1,
  "a replacement border snapshot invalidates the cache without rescanning removed tiles",
);

process.stdout.write("port placement tests passed\n");
