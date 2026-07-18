import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
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
const sandbox = {
  UNIT,
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  currentDifficulty: () => Difficulty.Impossible,
  state: { settings: { winFixes: true }, stats: {} },
};
executeClassicScript(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});

assert.equal(typeof sandbox.calculateDefensePostAttackProfile, "function");
assert.equal(typeof sandbox.AttackBehavior, "function");

const hostileAttackPressureBehavior = Object.create(sandbox.AttackBehavior.prototype);
hostileAttackPressureBehavior.player = {
  troops: () => 500_000,
  isFriendly: () => false,
  incomingAttacks: () => [
    { attacker: () => ({}), troops: () => 1_200_000 },
    { attacker: () => ({}), troops: () => 1_300_000 },
  ],
};
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  5,
  "coordinated hostile attacks are aggregated for siege-defense escalation",
);
hostileAttackPressureBehavior.player.incomingAttacks = () => [];
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  0,
  "no hostile attacks means no defensive-escalation pressure",
);
hostileAttackPressureBehavior.player.troops = () => 0;
hostileAttackPressureBehavior.player.incomingAttacks = () => [
  { attacker: () => ({}), troops: () => 1 },
];
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  0,
  "an exhausted force keeps the established fallback instead of applying a siege ratio",
);

const siegeHoldBehavior = Object.create(sandbox.AttackBehavior.prototype);
let siegeCounterattacks = 0;
sandbox.state.earlyGame = {};
siegeHoldBehavior.findIncomingAttackPlayer = () => ({ smallID: () => 9 });
siegeHoldBehavior.hasOverwhelmingIncomingAttack = () => true;
siegeHoldBehavior.sendAttack = async () => {
  siegeCounterattacks++;
  return true;
};
assert.equal(
  await siegeHoldBehavior.respondToIncomingAttack(),
  false,
  "an overwhelming siege holds troops instead of emitting a futile counterattack",
);
assert.equal(siegeCounterattacks, 0);
assert.equal(sandbox.state.earlyGame.action, "defense-hold");
siegeHoldBehavior.hasOverwhelmingIncomingAttack = () => false;
assert.equal(
  await siegeHoldBehavior.respondToIncomingAttack(),
  true,
  "ordinary incoming attacks preserve the responsive counterattack",
);
assert.equal(siegeCounterattacks, 1);

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
  ownerID: (tile) => {
    if (tile === 2) return 2;
    if (tile === 3) return 3;
    return 1;
  },
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
  behavior.calculateBotAttackTroops(enemy, 2500, cachedProfile),
  2000,
  "a sufficiently funded attack commits the robust Defense Post-aware conquest force",
);
behavior.botAttackTroopsSent = 0;
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 500, null),
  400,
  "without coverage, a bot attack commits the robust 4x conquest floor",
);

tick++;
behavior.getEnemyDefensePostAttackProfile(enemy);
assert.equal(unitsCalls, 2, "the cache is invalidated on the next game tick");

process.stdout.write("attack defense-post tests passed\n");
