import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const UNIT = {
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
  TransportShip: "Transport",
  City: "City",
  DefensePost: "Defense Post",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  Port: "Port",
  Factory: "Factory",
};
const cancelledAttackIds = [];
class CancelAttackIntent {
  constructor(attackID) {
    this.attackID = attackID;
  }
}
const eventBus = {
  emit: (event) => cancelledAttackIds.push(event.attackID),
};
const sandbox = {
  UNIT,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Relation: { Friendly: 1 },
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  currentDifficulty: () => "Impossible",
  EARLY_EXPAND_COMMIT: 0.1,
  EARLY_EXPAND_OPENING_LIMIT: 0.4,
  EARLY_EXPAND_FOLLOWUP_COMMIT: 0.1,
  EARLY_EXPAND_MINIMUM_MARGIN: 1.25,
  WORKER_TIMEOUT_MS: 100,
  performance,
  getEventBus: () => eventBus,
  discoverCtors: () => ({ cancelAttack: CancelAttackIntent }),
  state: {
    settings: { winFixes: true, features: { boat: true } },
    stats: {},
    earlyGame: {},
  },
};

executeClassicScript(readRepositoryFile("engine/ingame/spawn-objective.js"), sandbox, {
  filename: "spawn-objective.js",
});
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/earlyGame.js"), sandbox, {
  filename: "earlyGame.js",
});
executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/attackBehavior.js")}
globalThis.AttackBehavior = AttackBehavior;`,
  sandbox,
  { filename: "attackBehavior.js" },
);

const tile = (x, y) => y * 1000 + x;
const center = tile(10, 10);
const clanTile = tile(11, 10);
const outsiderTile = tile(10, 11);
const freeTile = tile(9, 10);
const me = {
  smallID: () => 1,
  displayName: () => "[ESP] Me",
  borderTiles: () => new Set([tile(8, 10)]),
  outgoingAttacks: () => [],
  troops: () => 100000,
};
const clanMate = {
  smallID: () => 2,
  displayName: () => "[esp] Mate",
};
const outsider = {
  smallID: () => 3,
  displayName: () => "[ABC] Other",
};
const noClan = {
  ...me,
  displayName: () => "No clan",
};
const owners = new Map();
const fallout = new Set();
let activeNukes = [];
const frontier = [outsiderTile, freeTile];
let tick = 1;
const game = {
  ticks: () => tick,
  players: () => [me, clanMate, outsider],
  units: (...types) => activeNukes.filter((unit) => types.includes(unit.type())),
  x: (ref) => ref % 1000,
  y: (ref) => Math.floor(ref / 1000),
  ref: tile,
  isValidCoord: (x, y) => x >= 0 && x < 40 && y >= 0 && y < 40,
  ownerID: (ref) => owners.get(ref) ?? 0,
  hasOwner: (ref) => (owners.get(ref) ?? 0) !== 0,
  hasFallout: (ref) => fallout.has(ref),
  isLand: () => true,
  isImpassable: () => false,
  magnitude: () => 8,
  neighbors: () => frontier,
  config: () => ({
    maxTroops: () => 100000,
    nukeMagnitudes: () => ({ outer: 3 }),
  }),
};
const makeNuke = (id, type = UNIT.AtomBomb, targetTile = center) => ({
  id: () => id,
  type: () => type,
  targetTile: () => targetTile,
});
const makeBehavior = (player = me) =>
  new sandbox.AttackBehavior({}, game, player, 0.5, 0.3, 0.1, {}, {});
const terraNullius = { isPlayer: () => false, id: () => null };
const playerTarget = { isPlayer: () => true, id: () => "player" };

// Before impact: ownership is captured and all generic land expansion is frozen,
// even when the protected tile is behind an unprotected frontier tile.
owners.set(clanTile, 2);
owners.set(outsiderTile, 3);
activeNukes = [makeNuke("atom")];
const behavior = makeBehavior();
behavior.captureSameClanNukeTerrain();
assert.equal(behavior.hasSameClanNukeTerrainHazard(), true);
assert.equal(behavior.sendLandAttack(terraNullius), false);
assert.equal(behavior.canForceAttackTarget(terraNullius), false);
assert.equal(behavior.canForceAttackTarget(playerTarget), true);
assert.equal(behavior.canEmitBoatToDestination(clanTile), true);

// A one-update gap between missile removal and fallout application must not
// briefly reopen Terra Nullius attacks or discard the captured blast.
const delayedImpactBehavior = makeBehavior();
delayedImpactBehavior.captureSameClanNukeTerrain();
activeNukes = [];
owners.clear();
tick++;
delayedImpactBehavior.captureSameClanNukeTerrain();
assert.equal(
  delayedImpactBehavior.hasSameClanNukeTerrainHazard(),
  true,
  "missile-to-fallout update gaps retain a conservative landing grace",
);

// Impact: owner information disappears. The entire mixed crater is quarantined
// because a generic attack can traverse from outsider fallout into clan fallout.
fallout.add(clanTile);
fallout.add(outsiderTile);
tick++;
behavior.captureSameClanNukeTerrain();
assert.equal(behavior.hasSameClanNukeTerrainHazard(), true);
assert.equal(behavior.isProtectedSameClanNukedTerrain(clanTile), true);
assert.equal(behavior.isProtectedSameClanNukedTerrain(outsiderTile), true);
assert.equal(behavior.terraNulliusTileIsEligible(clanTile, true), false);
assert.equal(behavior.terraNulliusTileIsEligible(outsiderTile, true), false);
assert.equal(behavior.canEmitBoatToDestination(clanTile), false);
assert.equal(behavior.canEmitBoatToDestination(outsiderTile), false);

// An active generic land attack is cancelled, while a player-targeted attack
// and an already-retreating attack are left untouched. Cancellation is deduped.
me.outgoingAttacks = () => [
  {
    id: () => "tn-active",
    target: () => terraNullius,
    retreating: () => false,
  },
  {
    id: () => "player-active",
    target: () => playerTarget,
    retreating: () => false,
  },
  {
    id: () => "tn-retreating",
    target: () => terraNullius,
    retreating: () => true,
  },
];
behavior.enforceSameClanNukeTerrainSafety();
behavior.enforceSameClanNukeTerrainSafety();
assert.deepEqual(cancelledAttackIds, ["tn-active"]);
me.outgoingAttacks = () => [];
tick++;
behavior.enforceSameClanNukeTerrainSafety();
me.outgoingAttacks = () => [
  {
    id: () => "tn-active",
    target: () => terraNullius,
    retreating: () => false,
  },
];
tick++;
behavior.enforceSameClanNukeTerrainSafety();
assert.deepEqual(
  cancelledAttackIds,
  ["tn-active", "tn-active"],
  "an attack ID can be cancelled again after it disappeared from the live snapshot",
);

// Once fallout clears and no threatening missile remains, expansion is restored.
fallout.clear();
tick += 3;
behavior.captureSameClanNukeTerrain();
assert.equal(behavior.hasSameClanNukeTerrainHazard(), false);
assert.equal(behavior.canForceAttackTarget(terraNullius), true);

// No clan tag means no accidental grouping and no freeze.
activeNukes = [makeNuke("no-clan")];
owners.set(clanTile, 2);
const noClanBehavior = makeBehavior(noClan);
noClanBehavior.captureSameClanNukeTerrain();
assert.equal(noClanBehavior.hasSameClanNukeTerrainHazard(), false);

// Own terrain is not treated as a teammate's protected terrain.
owners.clear();
owners.set(clanTile, 1);
const ownTerrainBehavior = makeBehavior();
ownTerrainBehavior.captureSameClanNukeTerrain();
assert.equal(ownTerrainBehavior.hasSameClanNukeTerrainHazard(), false);

// The MIRV carrier does not create fallout; only its warheads are blast threats.
owners.set(clanTile, 2);
activeNukes = [makeNuke("mirv-carrier", UNIT.MIRV)];
const mirvCarrierBehavior = makeBehavior();
mirvCarrierBehavior.captureSameClanNukeTerrain();
assert.equal(mirvCarrierBehavior.hasSameClanNukeTerrainHazard(), false);

// Different nuclear types and multiple simultaneous missiles are covered.
activeNukes = [makeNuke("hydrogen", UNIT.HydrogenBomb), makeNuke("mirv-warhead", UNIT.MIRVWarhead)];
const multiNukeBehavior = makeBehavior();
multiNukeBehavior.captureSameClanNukeTerrain();
assert.equal(multiNukeBehavior.threateningSameClanNukes.size, 2);
activeNukes = [activeNukes[1]];
tick++;
multiNukeBehavior.captureSameClanNukeTerrain();
assert.equal(multiNukeBehavior.threateningSameClanNukes.size, 1);

// A clanmate can acquire a tile after the missile was first observed. The
// in-flight capture must notice that ownership change before impact.
owners.clear();
activeNukes = [makeNuke("moving-front")];
const movingFrontBehavior = makeBehavior();
movingFrontBehavior.captureSameClanNukeTerrain();
assert.equal(movingFrontBehavior.hasSameClanNukeTerrainHazard(), false);
owners.set(clanTile, 2);
tick++;
movingFrontBehavior.captureSameClanNukeTerrain();
assert.equal(
  movingFrontBehavior.hasSameClanNukeTerrainHazard(),
  true,
  "ownership changes inside an active blast are re-evaluated",
);

// A full hydrogen-radius ownership scan remains a bounded one-off operation.
const largeCenter = 500 * 2000 + 500;
const largeOwners = new Map([[largeCenter, 2]]);
let largeOwnerReads = 0;
const largeGame = {
  ...game,
  x: (ref) => ref % 2000,
  y: (ref) => Math.floor(ref / 2000),
  ref: (x, y) => y * 2000 + x,
  isValidCoord: (x, y) => x >= 0 && x < 1000 && y >= 0 && y < 1000,
  ownerID: (ref) => {
    largeOwnerReads++;
    return largeOwners.get(ref) ?? 0;
  },
  units: () => [makeNuke("large-hydrogen", UNIT.HydrogenBomb, largeCenter)],
  config: () => ({
    maxTroops: () => 100000,
    nukeMagnitudes: () => ({ outer: 160 }),
  }),
};
const largeBehavior = new sandbox.AttackBehavior({}, largeGame, me, 0.5, 0.3, 0.1, {}, {});
const scanStartedAt = performance.now();
largeBehavior.captureSameClanNukeTerrain();
const scanDurationMs = performance.now() - scanStartedAt;
assert.equal(largeBehavior.hasSameClanNukeTerrainHazard(), true);
assert.ok(
  largeBehavior.sameClanNukedTerrain.size >= 80000 &&
    largeBehavior.sameClanNukedTerrain.size <= 81000,
  "the complete circular outer blast radius is quarantined",
);
const readsAfterFirstScan = largeOwnerReads;
largeBehavior.captureSameClanNukeTerrain();
assert.equal(
  largeOwnerReads,
  readsAfterFirstScan,
  "the same hydrogen blast is scanned at most once per game tick",
);
assert.ok(scanDurationMs < 250, `hydrogen ownership scan took ${scanDurationMs.toFixed(1)}ms`);

process.stdout.write(
  `same-clan nuke terrain safety tests passed (hydrogen scan ${scanDurationMs.toFixed(1)}ms)\n`,
);
