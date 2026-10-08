// MIRV aim selection checks. The carrier's warhead field is huge, so the aim
// point should sit on the target's structure core (silos/cities weighted
// heaviest) instead of the territory's geometric centre, and must fall back
// to the original bounding-box behaviour when nothing is observable.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const UNIT = {
  City: "City",
  Factory: "Factory",
  Port: "Port",
  MissileSilo: "MissileSilo",
  SAMLauncher: "SAMLauncher",
  Warship: "Warship",
  AtomBomb: "AtomBomb",
  HydrogenBomb: "HydrogenBomb",
  MIRV: "MIRV",
  TransportShip: "TransportShip",
  TradeShip: "TradeShip",
};
const sandbox = {
  UNIT,
  state: { settings: { winFixes: true } },
  WORKER_TIMEOUT_MS: 100,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: () => true,
  setLastAction() {},
  tr: (value) => value,
  playersArePermanentTeammates: () => false,
  respondToMIRV() {},
  AllPlayers: { id: "all" },
  EMOJI_NUKE: "nuke",
  console,
  Math,
  Number,
  Array,
  Object,
  Map,
  Set,
  Infinity,
  NaN,
  undefined,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${read("engine/ingame/auto-bot/mirvBehavior.js")}\nglobalThis.__MirvBehavior = MirvBehavior;`,
  sandbox,
  { filename: "mirv-aim.vm.js" },
);

const behavior = Object.create(sandbox.__MirvBehavior.prototype);
const W = 1000;
behavior.game = {
  x: (tile) => Number(tile) % W,
  y: (tile) => Math.floor(Number(tile) / W),
  ref: (x, y) => Math.floor(y) * W + Math.floor(x),
  hasOwner: () => true,
  ownerID: () => 42,
  manhattanDist: (a, b) =>
    Math.abs((Number(a) % W) - (Number(b) % W)) +
    Math.abs(Math.floor(Number(a) / W) - Math.floor(Number(b) / W)),
};

// Territory spanning (100,100) to (700,700); the geometric centre is (400,400)
// but every structure sits in the south-west corner.
const borderTiles = [];
for (let x = 100; x <= 700; x += 50) {
  borderTiles.push(behavior.game.ref(x, 100));
  borderTiles.push(behavior.game.ref(x, 700));
}
for (let y = 150; y <= 650; y += 50) {
  borderTiles.push(behavior.game.ref(100, y));
  borderTiles.push(behavior.game.ref(700, y));
}
const makeTarget = (structuresByType) => ({
  smallID: () => 42,
  borderTilesAsync: async () => borderTiles,
  units: (type) => structuresByType[type] ?? [],
});

// 1. No observable structures: aim stays at the geometric centre.
const emptyTarget = makeTarget({});
assert.equal(
  await behavior.calculateTerritoryCenter(emptyTarget),
  behavior.game.ref(400, 400),
  "without observable structures the aim remains the geometric centre",
);

// 2. A structure core pulls the aim onto it.
const coreTarget = makeTarget({
  [UNIT.MissileSilo]: [{ tile: () => behavior.game.ref(200, 200) }],
  [UNIT.City]: [{ tile: () => behavior.game.ref(240, 200) }],
});
assert.equal(
  await behavior.calculateTerritoryCenter(coreTarget),
  behavior.game.ref(216, 200),
  "the aim moves onto the weighted structure core (silo 3 : city 2)",
);

// 3. The core is clamped inside the territory bounds.
const clampTarget = makeTarget({
  [UNIT.City]: [
    { tile: () => behavior.game.ref(120, 120) },
    { tile: () => behavior.game.ref(140, 120) },
  ],
});
assert.equal(
  await behavior.calculateTerritoryCenter(clampTarget),
  behavior.game.ref(130, 120),
  "the weighted core is used verbatim when it lies inside the border bounds",
);

// 4. Unowned core tile falls back to the closest border tile toward the core.
const denyGame = {
  ...behavior.game,
  hasOwner: (tile) => Number(tile) !== behavior.game.ref(216, 200),
};
const denyBehavior = Object.create(sandbox.__MirvBehavior.prototype);
denyBehavior.game = denyGame;
assert.equal(
  await denyBehavior.calculateTerritoryCenter(coreTarget),
  behavior.game.ref(200, 100),
  "an unowned core tile snaps to the border tile nearest the core",
);

// 5. Shared-tube cohesion: pending nuke intents are not in the live silo
// queues yet, so the MIRV lane must defer to the nuke lane's projection.
behavior.player = {};
sandbox.autoBotBuildNukeSlots = (_game, player) => player.__projection ?? null;
behavior.player.__projection = new Map([["1", 0]]);
assert.equal(
  behavior.hasReadyMIRVSlot(),
  false,
  "pending nukes exhausting every projected tube block the MIRV lane",
);
behavior.player.__projection = new Map([["1", 2]]);
assert.equal(
  behavior.hasReadyMIRVSlot(),
  true,
  "a free projected tube admits the MIRV lane",
);
behavior.player.__projection = null;
delete sandbox.autoBotBuildNukeSlots;

// 5. A stub without units() keeps the original path.
const stubTarget = {
  smallID: () => 42,
  borderTilesAsync: async () => borderTiles,
};
assert.equal(
  await behavior.calculateTerritoryCenter(stubTarget),
  behavior.game.ref(400, 400),
  "targets without a units accessor fall back to the geometric centre",
);

process.stdout.write("mirv aim tests passed\n");
