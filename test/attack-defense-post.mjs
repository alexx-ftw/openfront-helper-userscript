import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");
const earlyGameSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js"),
  "utf8",
);

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
  TransportShip: "Transport Ship",
};
let boatIntent = null;
let emitAllowed = true;
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
  discoverCtors: () => ({ boat: {}, attack: {} }),
  emitIntent: (_ctor, ...args) => {
    if (!emitAllowed) return false;
    boatIntent = args;
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
};
vm.runInNewContext(
  `${earlyGameSource}\n${source}\nglobalThis.AttackBehavior = AttackBehavior;`,
  sandbox,
  {
    filename: sourcePath,
  },
);

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
  type: () => "Bot",
  smallID: () => 2,
  troops: () => 100,
  numTilesOwned: () => 10,
  borderTiles: () => new Set([2]),
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
    attackLogic: () => ({
      attackerTroopLoss: 100,
      defenderTroopLoss: 0,
      tilesPerTickUsed: 1,
    }),
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
  101,
  "a bot attack uses the simulated loss floor instead of a Defense Post troop multiplier",
);
behavior.botAttackTroopsSent = 0;
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 1500, cachedProfile),
  101,
  "a sufficiently funded attack commits only the troops required by the simulation",
);
behavior.botAttackTroopsSent = 0;
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 500, null),
  101,
  "the calculated requirement does not change into an arbitrary multiplier without coverage",
);
behavior.botAttackTroopsSent = 77;
assert.equal(
  behavior.calculateBotAttackTroops(enemy, 500, null, 50),
  51,
  "an existing attack is subtracted from the required capture force",
);
assert.equal(
  behavior.botAttackTroopsSent,
  77,
  "troop accounting changes only after an intent is emitted",
);

const largeTribe = {
  ...enemy,
  smallID: () => 4,
  troops: () => 5000,
  numTilesOwned: () => 120,
  units: () => [],
};
assert.equal(
  behavior.getBotCaptureTroopsFloor(largeTribe),
  2101,
  "a tribe above the conquer threshold must be simulated across all required tiles",
);
assert.equal(
  behavior.getBotCaptureTroopsFloor({ ...largeTribe, numTilesOwned: () => 700 }),
  Infinity,
  "very large tribes are deferred when an exact bounded capture estimate is unavailable",
);

const boatConfig = {
  isUnitDisabled: () => false,
  maxTroops: () => 10000,
  boatMaxNumber: () => 10,
  attackLogic: () => ({
    attackerTroopLoss: 100,
    defenderTroopLoss: 0,
    tilesPerTickUsed: 1,
  }),
};
const boatGame = {
  ticks: () => tick,
  numLandTiles: () => 1000,
  config: () => boatConfig,
  ensureBorderTiles: () => Promise.resolve(),
  owner: () => boatTribe,
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
  sharesBorderWith: () => true,
};
const boatTribe = {
  isPlayer: () => true,
  type: () => "Bot",
  smallID: () => 2,
  id: () => "tribe-2",
  troops: () => 1000,
  numTilesOwned: () => 10,
  units: () => [],
  borderTiles: () => new Set([2]),
};
let activeBotAttack = false;
let transportActive = false;
const transportUnit = {
  isActive: () => true,
  id: () => 77,
  targetTile: () => 2,
  troops: () => 101,
  transportShipState: () => ({ isRetreating: false }),
};
boatPlayer.units = () => (transportActive ? [transportUnit] : []);
const activeBotAttackSnapshot = {
  retreating: () => false,
  target: () => boatTribe,
  troops: () => 50,
  id: () => "active-attack",
};
boatPlayer.outgoingAttacks = () => (activeBotAttack ? [activeBotAttackSnapshot] : []);
const boatBehavior = new sandbox.AttackBehavior({}, boatGame, boatPlayer, 0.5, 0.3, 0.1, {}, {});
assert.equal(
  boatBehavior.getEarlyGameProbeTroops(0.01),
  100,
  "a boat probe must use the interface minimum of 1% without an absolute troop floor",
);
const lowTroopPlayer = { ...boatPlayer, troops: () => 5000 };
const lowTroopBehavior = new sandbox.AttackBehavior(
  {},
  boatGame,
  lowTroopPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
boatIntent = null;
assert.equal(
  lowTroopBehavior.emitBoat(2, lowTroopBehavior.getEarlyGameProbeTroops(0.01), "test probe"),
  true,
);
assert.deepEqual(
  boatIntent,
  [2, 50],
  "a small early army must send 1% instead of being forced to 8000 troops",
);
assert.equal(await boatBehavior.sendBoatAttack(boatTribe, null, 50), true);
assert.deepEqual(
  boatIntent,
  [2, 101],
  "an undersized planned boat attack must be raised to the simulated tribe-capture force",
);

tick++;
activeBotAttack = false;
transportActive = true;
boatIntent = null;
assert.equal(
  await boatBehavior.sendBoatAttack(boatTribe),
  false,
  "a complete boat invasion in transit must block a duplicate boat",
);
transportActive = false;

tick++;
boatIntent = null;
const reserveBoatBehavior = new sandbox.AttackBehavior(
  {},
  boatGame,
  boatPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(await reserveBoatBehavior.sendBoatAttack(boatTribe, null, 9000), true);
assert.deepEqual(
  boatIntent,
  [2, 8800],
  "a planned boat attack must preserve the early-game live reserve",
);

tick++;
boatIntent = null;
activeBotAttack = true;
const landBehavior = new sandbox.AttackBehavior({}, boatGame, boatPlayer, 0.5, 0.3, 0.1, {}, {});
assert.equal(await landBehavior.sendLandAttack(boatTribe, null, null, 50), true);
assert.deepEqual(
  boatIntent,
  ["tribe-2", 51],
  "an active land attack must be topped up only by its missing capture force",
);
assert.deepEqual(
  [...landBehavior.getActiveBotAttackTargetKeys()],
  ["smallID:2"],
  "an active tribal attack locks its target for the next decision",
);
activeBotAttack = false;

const botA = {
  isPlayer: () => true,
  type: () => "Bot",
  smallID: () => 3,
  troops: () => 100,
  numTilesOwned: () => 10,
  units: () => [],
};
const botB = {
  ...botA,
  smallID: () => 4,
};
let botCaptureActive = false;
const botPlayer = {
  ...boatPlayer,
  nearby: () => [],
  isFriendly: () => false,
  units: () => [],
  outgoingAttacks: () =>
    botCaptureActive
      ? [
          {
            retreating: () => false,
            target: () => botA,
            troops: () => 100,
          },
        ]
      : [],
};
const botBehavior = new sandbox.AttackBehavior({}, boatGame, botPlayer, 0.5, 0.3, 0.1, {}, {});
botBehavior.getEnemyDefensePostAttackProfile = () => ({
  attackCostMultiplier: 1,
  speedMultiplier: 1,
});
const attemptedBots = [];
botBehavior.sendAttack = async (target) => {
  attemptedBots.push(target.smallID());
  return true;
};
assert.equal(await botBehavior.attackBots([botA, botB]), true);
assert.deepEqual(attemptedBots, [3], "one decision must commit at most one new tribal capture");

botCaptureActive = true;
attemptedBots.length = 0;
botBehavior.sendAttack = async (target) => {
  attemptedBots.push(target.smallID());
  return false;
};
assert.equal(await botBehavior.attackBots([botA, botB]), false);
assert.deepEqual(
  attemptedBots,
  [3],
  "an active tribal capture must be topped up before another tribe is considered",
);

const incomingAttack = {
  retreating: () => false,
  attacker: () => boatTribe,
  troops: () => 20,
};
const incomingPlayer = {
  ...boatPlayer,
  incomingAttacks: () => [incomingAttack],
  outgoingAttacks: () => [activeBotAttackSnapshot],
};
const incomingBehavior = new sandbox.AttackBehavior(
  {},
  boatGame,
  incomingPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const incomingRequirement = incomingBehavior.getBotAttackRequirement(boatTribe, null, null, "land");
assert.equal(
  incomingRequirement.remaining,
  71,
  "a new land attack must include the tribe's incoming counterattack force",
);

const failedEmitBehavior = new sandbox.AttackBehavior(
  {},
  boatGame,
  boatPlayer,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
tick++;
emitAllowed = false;
boatIntent = null;
assert.equal(
  await failedEmitBehavior.sendBoatAttack(boatTribe, null, 50),
  false,
  "a rejected intent must not count as an emitted tribal attack",
);
assert.equal(failedEmitBehavior.botAttackTroopsSent, 0);
emitAllowed = true;

tick++;
behavior.getEnemyDefensePostAttackProfile(enemy);
assert.equal(unitsCalls, 2, "the cache is invalidated on the next game tick");

console.log("attack defense-post tests passed");
