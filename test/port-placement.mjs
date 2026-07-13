import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_API_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/auto-bot/gameApi.js"),
  "utf8",
);

function makeScenario({ ocean = false, allied = false, otherAlive = true } = {}) {
  const width = 9;
  const height = 9;
  const lake = new Set();
  for (let y = 3; y <= 5; y += 1) {
    for (let x = 3; x <= 5; x += 1) lake.add(y * width + x);
  }
  const neighbors = (tile) => {
    const x = tile % width;
    const y = Math.floor(tile / width);
    const out = [];
    if (x > 0) out.push(tile - 1);
    if (x < width - 1) out.push(tile + 1);
    if (y > 0) out.push(tile - width);
    if (y < height - 1) out.push(tile + width);
    return out;
  };
  const land = new Set();
  for (let tile = 0; tile < width * height; tile += 1) {
    if (!lake.has(tile)) land.add(tile);
  }
  const meCoast = new Set([29, 38, 47]);
  const otherCoast = new Set([33, 42, 51]);
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

  const src = {
    width: () => width,
    height: () => height,
    ticks: () => 1,
    inSpawnPhase: () => false,
    isLand: (tile) => land.has(tile),
    isWater: (tile) => !land.has(tile),
    isOcean: (tile) => ocean && tile >= width * 3 && tile < width * 4,
    isShore: (tile) => land.has(tile) && neighbors(tile).some((neighbor) => !land.has(neighbor)),
    isOceanShore: () => false,
    neighbors,
    x: (tile) => tile % width,
    y: (tile) => Math.floor(tile / width),
    ref: (x, y) => y * width + x,
    isValidCoord: (x, y) => x >= 0 && x < width && y >= 0 && y < height,
    ownerID: (tile) => ownerByTile.get(tile) ?? 0,
    hasOwner: (tile) => ownerByTile.has(tile),
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

  const sandbox = {
    PlayerType: { Bot: "BOT" },
    withTimeout: async (promise) => promise,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(GAME_API_SOURCE, sandbox, { filename: "gameApi.js" });
  return { handle: sandbox.createGameApi(src), me, other };
}

async function sharedWater({ ocean, allied, otherAlive }) {
  const scenario = makeScenario({ ocean, allied, otherAlive });
  const wrappedMe = await scenario.handle.beginTick(scenario.me);
  const shared = scenario.handle.game.sharedWaterComponents(wrappedMe);
  return shared ? [...shared].sort((a, b) => a - b) : null;
}

assert.equal(
  await sharedWater({ ocean: false, allied: false }),
  null,
  "a closed lake without an allied partner must not make a port eligible",
);
assert.deepEqual(
  await sharedWater({ ocean: false, allied: true }),
  [0],
  "a closed lake shared with an ally remains eligible",
);
assert.equal(
  await sharedWater({ ocean: false, allied: true, otherAlive: false }),
  null,
  "a closed lake shared only with a dead ally must not make a port eligible",
);
assert.deepEqual(
  await sharedWater({ ocean: true, allied: false }),
  [-1],
  "open ocean remains eligible without an alliance",
);

console.log("port placement tests passed");
