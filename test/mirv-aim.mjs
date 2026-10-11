// MIRV aim selection checks. The carrier's warhead field is huge, so the aim
// point should sit on the target's structure core (silos/cities weighted
// heaviest) instead of the territory's geometric centre, and must fall back
// to the original bounding-box behaviour when nothing is observable.

import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

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
  PlayerType: { Bot: "Bot" },
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
  `${readRepositoryFile("engine/ingame/auto-bot/mirvBehavior.js")}\nglobalThis.__MirvBehavior = MirvBehavior;`,
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

const ownPlayer = { smallID: () => 7 };
const hostilePlayer = { smallID: () => 99 };
const samTile = behavior.game.ref(200, 200);
const hostileSam = {
  tile: () => samTile,
  owner: () => hostilePlayer,
  level: () => 1,
};
const samGame = {
  ...behavior.game,
  euclideanDistSquared: (a, b) => {
    const dx = behavior.game.x(a) - behavior.game.x(b);
    const dy = behavior.game.y(a) - behavior.game.y(b);
    return dx * dx + dy * dy;
  },
  config: () => ({ maxSamRange: () => 100, samRange: () => 30 }),
  nearbyUnits: (tile, maxRange, type) => {
    assert.equal(type, UNIT.SAMLauncher);
    const maxRangeSquared = maxRange * maxRange;
    return [hostileSam]
      .map((unit) => ({
        unit,
        distSquared: samGame.euclideanDistSquared(tile, unit.tile()),
      }))
      .filter((sam) => sam.distSquared <= maxRangeSquared);
  },
};
const samBehavior = Object.create(sandbox.__MirvBehavior.prototype);
samBehavior.game = samGame;
samBehavior.player = ownPlayer;

// 3. With winFixes on, a covered weighted core falls back to the next uncovered
// structure cluster in descending structure weight.
assert.equal(
  await samBehavior.calculateTerritoryCenter(coreTarget),
  behavior.game.ref(240, 200),
  "a covered silo core falls back to the uncovered city cluster",
);

// 4. If every structure cluster is covered, keep the existing border-center fallback.
const noFreeStructureTarget = makeTarget({
  [UNIT.MissileSilo]: [{ tile: () => behavior.game.ref(200, 200) }],
  [UNIT.City]: [{ tile: () => behavior.game.ref(220, 200) }],
});
const coveringSamGame = {
  ...samGame,
  config: () => ({ maxSamRange: () => 100, samRange: () => 60 }),
};
const coveringSamBehavior = Object.create(sandbox.__MirvBehavior.prototype);
coveringSamBehavior.game = coveringSamGame;
coveringSamBehavior.player = ownPlayer;
assert.equal(
  await coveringSamBehavior.calculateTerritoryCenter(noFreeStructureTarget),
  behavior.game.ref(400, 400),
  "when every structure cluster is covered, the existing border-center fallback is preserved",
);

// 5. winFixes off retains the original weighted-core aim even under SAM coverage.
sandbox.state.settings.winFixes = false;
assert.equal(
  await samBehavior.calculateTerritoryCenter(coreTarget),
  behavior.game.ref(216, 200),
  "SAM avoidance is gated by winFixes",
);
sandbox.state.settings.winFixes = true;

// 6. The core is clamped inside the territory bounds.
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

// 7. Unowned core tile falls back to the closest border tile toward the core.
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

// 8. Shared-tube cohesion: pending nuke intents are not in the live silo
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
assert.equal(behavior.hasReadyMIRVSlot(), true, "a free projected tube admits the MIRV lane");
behavior.player.__projection = null;
delete sandbox.autoBotBuildNukeSlots;

// 9. A stub without units() keeps the original path.
const stubTarget = {
  smallID: () => 42,
  borderTilesAsync: async () => borderTiles,
};
assert.equal(
  await behavior.calculateTerritoryCenter(stubTarget),
  behavior.game.ref(400, 400),
  "targets without a units accessor fall back to the geometric centre",
);

let targetAlive = true;
let currentDispatchTarget;
let dispatches = 0;
const dispatchTarget = {
  smallID: () => 99,
  isPlayer: () => true,
  isAlive: () => targetAlive,
  type: () => "Human",
};
const previousBuildSender = sandbox.sendAutoBotBuildOrUpgrade;
sandbox.sendAutoBotBuildOrUpgrade = () => {
  dispatches++;
  return true;
};
const emitAfterBuildables = async (afterBuildables) => {
  const dispatchBehavior = Object.create(sandbox.__MirvBehavior.prototype);
  dispatchBehavior.player = {
    smallID: () => 7,
    isFriendly: () => false,
    gold: () => 10n,
    buildables: async () => {
      afterBuildables();
      return [{ type: UNIT.MIRV, canBuild: true, cost: 1n }];
    },
  };
  dispatchBehavior.game = {
    playerBySmallID: (sid) => (sid === 99 ? currentDispatchTarget : null),
  };
  return dispatchBehavior.emitMIRVBuildIntent(dispatchTarget, 1);
};

currentDispatchTarget = dispatchTarget;
assert.equal(
  await emitAfterBuildables(() => {}),
  true,
  "a live hostile remains eligible after the async buildables probe",
);
assert.equal(dispatches, 1, "the live hostile's MIRV intent is dispatched");

targetAlive = true;
currentDispatchTarget = dispatchTarget;
assert.equal(
  await emitAfterBuildables(() => {
    targetAlive = false;
  }),
  false,
  "a target that dies during the async buildables probe cancels dispatch",
);
assert.equal(dispatches, 1, "a dead target does not dispatch a MIRV");

targetAlive = true;
currentDispatchTarget = dispatchTarget;
assert.equal(
  await emitAfterBuildables(() => {
    currentDispatchTarget = null;
  }),
  false,
  "a target removed during the async buildables probe cancels dispatch",
);
assert.equal(dispatches, 1, "a removed target does not dispatch a MIRV");
sandbox.sendAutoBotBuildOrUpgrade = previousBuildSender;

process.stdout.write("mirv aim tests passed\n");
