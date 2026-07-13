import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const UNIT = {
  City: "City",
  DefensePost: "Defense Post",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  Port: "Port",
  Factory: "Factory",
};
let boatIntent = null;
const sandbox = {
  UNIT,
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  currentDifficulty: () => Difficulty.Impossible,
  state: {
    settings: { winFixes: true, features: { boat: true } },
    earlyGame: {},
    stats: {},
  },
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: (value) => Promise.resolve(value),
  closestTwoTiles: () => ({ x: 1, y: 2 }),
  getEventBus: () => null,
  discoverCtors: () => ({ boat: {} }),
  emitIntent: (_ctor, ...args) => {
    boatIntent = args;
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
};
vm.runInNewContext(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});

assert.equal(typeof sandbox.calculateDefensePostAttackProfile, "function");
assert.equal(typeof sandbox.AttackBehavior, "function");

const overlapping = sandbox.calculateDefensePostAttackProfile({
  frontTiles: [0, 10, 30, 31],
  defensePosts: [{ tile: 0 }, { tile: 0 }],
  distanceSquared: (left, right) => (left - right) ** 2,
});
assert.equal(overlapping.operationalPostCount, 2);
assert.equal(overlapping.coveredFrontTileCount, 3);
assert.equal(overlapping.coverageRatio, 0.75);
assert.equal(overlapping.defenseMultiplier, 4);
assert.equal(overlapping.speedMultiplier, 2.5);
assert.equal(
  overlapping.attackCostMultiplier,
  overlapping.defenseMultiplier,
  "the troop cost follows magnitude, while speed remains a separate exposure effect",
);

const fullCoverage = sandbox.calculateDefensePostAttackProfile({
  frontTiles: [5],
  defensePosts: [{ tile: 5 }, { tile: 5 }, { tile: 5 }],
  distanceSquared: () => 0,
});
assert.equal(fullCoverage.coveredFrontTileCount, 1);
assert.equal(fullCoverage.defenseMultiplier, 5);
assert.equal(fullCoverage.speedMultiplier, 3);

let tick = 10;
let unitsCalls = 0;
const me = {
  smallID: () => 1,
  borderTiles: () => new Set([1]),
};
const enemyPosts = [
  {
    tile: () => 2,
    isActive: () => true,
    isUnderConstruction: () => false,
  },
  {
    tile: () => 2,
    isActive: () => true,
    isUnderConstruction: () => true,
  },
  {
    tile: () => 2,
    isActive: () => false,
    isUnderConstruction: () => false,
  },
];
const enemy = {
  isPlayer: () => true,
  smallID: () => 2,
  troops: () => 100,
  units: () => {
    unitsCalls++;
    return enemyPosts;
  },
};
const openEnemy = {
  isPlayer: () => true,
  smallID: () => 3,
  troops: () => 100,
  units: () => [],
};
const game = {
  ticks: () => tick,
  config: () => ({
    defensePostRange: () => 30,
    defensePostDefenseBonus: () => 5,
    defensePostSpeedBonus: () => 3,
  }),
  ownerID: (tile) => (tile === 2 ? 2 : tile === 3 ? 3 : 1),
  neighbors: (tile) => (tile === 1 ? [2, 3] : []),
  isLand: () => true,
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
const behavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});

behavior.cacheEnemyDefensePostFrontTiles([2, 3]);
const cachedProfile = behavior.getEnemyDefensePostAttackProfile(enemy);
assert.equal(cachedProfile.operationalPostCount, 1);
assert.equal(cachedProfile.coveredFrontTileCount, 1);
assert.equal(cachedProfile.defenseMultiplier, 5);
assert.equal(unitsCalls, 1);
assert.deepEqual(
  behavior.getEnemyDefensePostAttackProfile(enemy),
  cachedProfile,
  "the profile is reused within one game tick",
);
assert.equal(unitsCalls, 1);

assert.deepEqual(
  behavior.rankAttackTargets([enemy, openEnemy]).map((target) => target.smallID()),
  [3, 2],
  "an equally sized open target is preferred over a fully covered target",
);

assert.equal(behavior.attackIsTooWeakForDefensePosts(enemy, 999, cachedProfile), true);
assert.equal(behavior.attackIsTooWeakForDefensePosts(enemy, 1000, cachedProfile), false);
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 500, cachedProfile),
  0,
  "a bot attack below the Defense Post-aware floor is skipped",
);
behavior.botAttackTroopsSent = 0;
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 1500, cachedProfile),
  1500,
  "a sufficiently funded attack commits the available troops",
);
behavior.botAttackTroopsSent = 0;
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 500, null),
  400,
  "without coverage, the existing 4x bot attack rule is unchanged",
);

const boatConfig = {
  isUnitDisabled: () => false,
  maxTroops: () => 10000,
  boatMaxNumber: () => 10,
};
const boatGame = {
  ticks: () => 1,
  numLandTiles: () => 1000,
  config: () => boatConfig,
  ensureBorderTiles: () => Promise.resolve(),
  neighbors: () => [],
  ownerID: () => 1,
  isLand: () => true,
  isShore: () => true,
};
const boatPlayer = {
  isPlayer: () => true,
  type: () => "Human",
  smallID: () => 1,
  troops: () => 10000,
  numTilesOwned: () => 1,
  borderTiles: () => new Set([1]),
  bestTransportShipSpawn: () => Promise.resolve(true),
};
const boatTribe = {
  isPlayer: () => true,
  type: () => "Bot",
  smallID: () => 2,
  id: () => "tribe-2",
  troops: () => 1000,
  units: () => [],
  borderTiles: () => new Set([2]),
};
const boatBehavior = new sandbox.AttackBehavior(
  {},
  boatGame,
  boatPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(await boatBehavior.sendBoatAttack(boatTribe), true);
assert.deepEqual(
  boatIntent,
  [2, 4000],
  "a win-fix boat attack against a tribe must fund the full capture, not a 1% probe",
);

tick++;
behavior.getEnemyDefensePostAttackProfile(enemy);
assert.equal(unitsCalls, 2, "the cache is invalidated on the next game tick");

console.log("attack defense-post tests passed");
