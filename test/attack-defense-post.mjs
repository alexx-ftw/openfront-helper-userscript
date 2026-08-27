import assert from "node:assert/strict";
import { createAttackBehaviorSandbox, Difficulty } from "./helpers/attack-behavior-sandbox.mjs";

const UNIT = {
  City: "City",
  DefensePost: "Defense Post",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  Port: "Port",
  Factory: "Factory",
};
const sandbox = createAttackBehaviorSandbox({ unit: UNIT, difficulty: Difficulty.Impossible });

assert.equal(typeof sandbox.calculateDefensePostAttackProfile, "function");
assert.equal(typeof sandbox.AttackBehavior, "function");

const hostileAttackPressureBehavior = Object.create(sandbox.AttackBehavior.prototype);
const pressureDefender = { smallID: () => 1 };
const pressureAttack = (troops, retreating = false) => ({
  attacker: () => ({ isAlive: () => true }),
  target: () => pressureDefender,
  troops: () => troops,
  retreating: () => retreating,
});
hostileAttackPressureBehavior.player = {
  smallID: () => pressureDefender.smallID(),
  troops: () => 500_000,
  isFriendly: () => false,
  incomingAttacks: () => [pressureAttack(1_200_000), pressureAttack(1_300_000)],
};
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  5,
  "coordinated hostile attacks are aggregated for siege-defense escalation",
);
hostileAttackPressureBehavior.player.incomingAttacks = () => [
  pressureAttack(100_000),
  pressureAttack(900_000, true),
];
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  0.2,
  "a cancelled retreating wave cannot keep the bot in an artificial overwhelming siege",
);
hostileAttackPressureBehavior.player.incomingAttacks = () => [];
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  0,
  "no hostile attacks means no defensive-escalation pressure",
);
hostileAttackPressureBehavior.player.troops = () => 500_000;
hostileAttackPressureBehavior.player.incomingAttacks = () => [pressureAttack(500_000)];
assert.equal(
  hostileAttackPressureBehavior.hasOverwhelmingIncomingAttack(),
  true,
  "aggregate incoming troops at parity reserve the whole defense budget instead of counterattacking",
);
hostileAttackPressureBehavior.player.incomingAttacks = () => [pressureAttack(499_999)];
assert.equal(
  hostileAttackPressureBehavior.hasOverwhelmingIncomingAttack(),
  false,
  "an incoming force below parity still permits a responsive counterattack",
);
hostileAttackPressureBehavior.player.troops = () => 0;
hostileAttackPressureBehavior.player.incomingAttacks = () => [pressureAttack(1)];
assert.equal(
  hostileAttackPressureBehavior.incomingHostileAttackPressure(),
  Number.POSITIVE_INFINITY,
  "an exhausted force reports maximum siege pressure instead of hiding the invasion",
);
assert.equal(
  hostileAttackPressureBehavior.hasOverwhelmingIncomingAttack(),
  true,
  "an active invasion against zero defenders keeps the whole remaining budget reserved",
);

const cachedIncomingBehavior = Object.create(sandbox.AttackBehavior.prototype);
let cachedIncomingReads = 0;
const cachedAttacker = { id: () => 7, type: () => sandbox.PlayerType.Bot };
const cachedDefender = { smallID: () => 9 };
cachedIncomingBehavior.game = { ticks: () => 451 };
cachedIncomingBehavior.player = {
  smallID: () => cachedDefender.smallID(),
  troops: () => 500,
  isFriendly: () => false,
  type: () => sandbox.PlayerType.Bot,
  incomingAttacks: () => {
    cachedIncomingReads++;
    return [
      {
        attacker: () => cachedAttacker,
        target: () => cachedDefender,
        troops: () => 300,
        retreating: () => false,
      },
      {
        attacker: () => cachedAttacker,
        target: () => cachedDefender,
        troops: () => 100,
        retreating: () => false,
      },
    ];
  },
};
cachedIncomingBehavior.getOutboundAttackTargetKey = (player) => player.id();
cachedIncomingBehavior.getIncomingCounterattackReserveTroops = () => 0;
cachedIncomingBehavior.getEarlyGameSpendableTroops = () => 1_000;
let cachedCounterattackTarget = null;
cachedIncomingBehavior.sendAttack = async (target) => {
  cachedCounterattackTarget = target;
  return true;
};
sandbox.state.earlyGame = {};
assert.equal(
  await cachedIncomingBehavior.respondToIncomingAttack(),
  true,
  "a cached hostile-attack snapshot preserves the defensive counterattack",
);
assert.equal(cachedCounterattackTarget, cachedAttacker);
assert.equal(
  cachedIncomingReads,
  1,
  "target selection, pressure, and counterattack sizing share one hostile-attack snapshot per tick",
);
cachedIncomingBehavior.game.ticks = () => 452;
cachedIncomingBehavior.incomingHostileAttacks();
assert.equal(cachedIncomingReads, 2, "the next tick refreshes the hostile-attack snapshot");

const currentDefender = { smallID: () => 41 };
const unrelatedTarget = { smallID: () => 99 };
const validIncomingAttacker = {
  isPlayer: () => true,
  isAlive: () => true,
  smallID: () => 7,
  type: () => sandbox.PlayerType.Nation,
};
const validIncomingAttack = {
  attacker: () => validIncomingAttacker,
  target: () => currentDefender,
  troops: () => 25,
};
const malformedIncomingBehavior = Object.create(sandbox.AttackBehavior.prototype);
malformedIncomingBehavior.game = { ticks: () => 700 };
malformedIncomingBehavior.player = {
  smallID: () => currentDefender.smallID(),
  type: () => sandbox.PlayerType.Bot,
  isFriendly: () => false,
  incomingAttacks: () => [
    { attacker: () => null, target: () => currentDefender, troops: () => 900 },
    { attacker: () => validIncomingAttacker, target: () => null, troops: () => 850 },
    { attacker: () => validIncomingAttacker, target: () => unrelatedTarget, troops: () => 800 },
    validIncomingAttack,
  ],
};
assert.deepEqual(
  malformedIncomingBehavior.incomingHostileAttacks(),
  [validIncomingAttack],
  "missing participants and attacks aimed at another player are rejected fail-closed",
);
assert.strictEqual(
  malformedIncomingBehavior.findIncomingAttackPlayer(),
  validIncomingAttacker,
  "a valid incoming attack remains correctly directed after malformed waves are discarded",
);
assert.equal(
  malformedIncomingBehavior.incomingHostileTroopsFrom({
    isPlayer: () => true,
    smallID: () => 7,
  }),
  25,
  "defensive troop accounting follows the attacker id across refreshed wrappers",
);

const staleZeroForceAttack = {
  attacker: () => validIncomingAttacker,
  target: () => currentDefender,
  troops: () => 0,
  retreating: () => false,
};
const staleNegativeForceAttack = {
  attacker: () => validIncomingAttacker,
  target: () => currentDefender,
  troops: () => -50,
  retreating: () => false,
};
const staleForceBehavior = Object.create(sandbox.AttackBehavior.prototype);
staleForceBehavior.game = { ticks: () => 701 };
staleForceBehavior.player = {
  smallID: () => currentDefender.smallID(),
  type: () => sandbox.PlayerType.Bot,
  isFriendly: () => false,
  incomingAttacks: () => [staleZeroForceAttack, staleNegativeForceAttack],
};
assert.deepEqual(
  staleForceBehavior.incomingHostileAttacks(),
  [],
  "zero- and negative-force incoming snapshots are discarded before they can reserve defense",
);
assert.equal(
  staleForceBehavior.findIncomingAttackPlayer(),
  null,
  "stale zero-force attacks cannot suppress offensive or donation decisions",
);

const staleDonationAttackSnapshots = [
  { troops: () => 0, retreating: () => false },
  { troops: () => -50, retreating: () => false },
];
const staleDonationBehavior = Object.create(sandbox.AttackBehavior.prototype);
staleDonationBehavior.player = {
  smallID: () => currentDefender.smallID(),
  canDonateTroops: () => true,
  incomingAttacks: () => staleDonationAttackSnapshots,
};
staleDonationBehavior.botDonationNextEligibleTickByRecipient = new Map();
staleDonationBehavior.currentAttackDecisionTick = () => 701;
staleDonationBehavior.teamDonationDistance = () => 1;
assert.equal(
  staleDonationBehavior.donationHasIncomingAttack(),
  false,
  "zero- and negative-force incoming donation snapshots do not block the donor",
);
const staleDonationRecipient = {
  id: () => "player-42",
  smallID: () => 42,
  isAlive: () => true,
  incomingAttacks: () => staleDonationAttackSnapshots,
  outgoingAttacks: () => staleDonationAttackSnapshots,
};
const staleDonationCandidate = staleDonationBehavior.donationCandidate(
  { teammate: staleDonationRecipient, troopPercentage: 0.1 },
  1,
);
assert.notEqual(
  staleDonationCandidate,
  null,
  "zero- and negative-force incoming/outgoing snapshots leave the recipient donation-eligible",
);
assert.equal(staleDonationCandidate.underAttack, false);
assert.equal(staleDonationCandidate.frontline, false);

const siegeHoldBehavior = Object.create(sandbox.AttackBehavior.prototype);
let siegeCounterattacks = 0;
sandbox.state.earlyGame = {};
siegeHoldBehavior.findIncomingAttackPlayer = () => ({ smallID: () => 9 });
siegeHoldBehavior.hasOverwhelmingIncomingAttack = () => true;
siegeHoldBehavior.sendAttack = async () => {
  siegeCounterattacks++;
  return false;
};
assert.equal(
  await siegeHoldBehavior.respondToIncomingAttack(),
  false,
  "an overwhelming siege still reaches the reserve-aware counterattack planner",
);
assert.equal(siegeCounterattacks, 1);
assert.equal(sandbox.state.earlyGame.action, "defense-hold");
siegeHoldBehavior.hasOverwhelmingIncomingAttack = () => false;
siegeHoldBehavior.canFundIncomingCounterattack = () => true;
siegeHoldBehavior.sendAttack = async () => {
  siegeCounterattacks++;
  return true;
};
assert.equal(
  await siegeHoldBehavior.respondToIncomingAttack(),
  true,
  "ordinary incoming attacks preserve the responsive counterattack",
);
assert.equal(siegeCounterattacks, 2);

const partialInterdictionBehavior = Object.create(sandbox.AttackBehavior.prototype);
partialInterdictionBehavior.player = {
  isFriendly: () => false,
  incomingAttacks: () => [{ attacker: () => "Italy", troops: () => 481_214 }],
};
partialInterdictionBehavior.incomingHostileTroopsFrom = () => 481_214;
partialInterdictionBehavior.getIncomingCounterattackReserveTroops = () => 82_863;
partialInterdictionBehavior.getEarlyGameSpendableTroops = () => 117_127;
assert.equal(
  partialInterdictionBehavior.canFundIncomingCounterattack("Italy"),
  true,
  "a safe partial land counterattack interdicts the same portion of an in-flight invasion",
);
partialInterdictionBehavior.getEarlyGameSpendableTroops = () => 0;
assert.equal(
  partialInterdictionBehavior.canFundIncomingCounterattack("Italy"),
  false,
  "the bot never spends into its protected reserve merely to counterattack",
);

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
