import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
const source = fs.readFileSync(sourcePath, "utf8");

const UNIT = { TransportShip: "Transport" };
const troopEmissions = [];
const sandbox = {
  UNIT,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  currentDifficulty: () => "Impossible",
  performance: { now: () => 10000 },
  discoverCtors: () => ({
    attack: "attack",
    donateTroops: "donateTroops",
  }),
  getEventBus: () => null,
  emitIntent: (_ctor, _recipient, troops) => {
    troopEmissions.push(troops);
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
  state: {
    settings: { winFixes: true, features: { donate: true } },
    stats: {},
  },
};

vm.runInNewContext(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
  filename: sourcePath,
});

let tick = 0;
let ownTroops = 100000;
const outgoing = [];
const me = {
  troops: () => ownTroops,
  smallID: () => 1,
  type: () => "Human",
  units: () => [],
  outgoingAttacks: () => outgoing,
};
const game = {
  ticks: () => tick,
  config: () => ({ maxTroops: () => 100000 }),
};
const target = {
  isPlayer: () => true,
  smallID: () => 2,
  id: () => "tribe-2",
};

const behavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});

assert.equal(
  behavior.getEarlyGameLiveReserveTroops(),
  9995,
  "reserve is the troop level where production acceleration peaks",
);
assert.equal(
  behavior.getEarlyGameProbeTroops(),
  1000,
  "a probe is 1% of the current army without an absolute troop floor",
);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  90005,
  "the acceleration peak is protected before any outgoing troop intent",
);

behavior.recordOutboundAttackIntent(target, 8000, { attackType: "land" });
assert.equal(behavior.getPendingOutboundAttackTroops(), 8000);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  82005,
  "a stale troop snapshot cannot spend the same 8000 twice",
);

outgoing.push({
  id: () => "attack-1",
  retreating: () => false,
  target: () => target,
  troops: () => 8000,
});
tick = 1;
assert.equal(
  behavior.getPendingOutboundAttackTroops(),
  0,
  "the local intent is released once the matching outgoing attack is visible",
);

outgoing.length = 0;
behavior.recordOutboundAttackIntent(target, 7000, { attackType: "land" });
behavior.recordOutboundAttackIntent(target, 2000, { attackType: "land" });
assert.equal(behavior.getPendingOutboundAttackTroops(), 9000);

outgoing.push({
  id: () => "attack-2",
  retreating: () => false,
  target: () => target,
  troops: () => 7000,
});
tick = 2;
assert.equal(
  behavior.getPendingOutboundAttackTroops(),
  2000,
  "one visible attack only settles one of two stale intents",
);

tick = 9;
assert.equal(
  behavior.getPendingOutboundTroopCommitments(),
  0,
  "expired attack intents no longer reserve troops forever",
);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  90005,
  "the protected reserve remains after attack intents expire",
);

behavior.recordOutboundDonationIntent(10000);
assert.equal(behavior.getPendingOutboundDonationTroops(), 10000);
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  80005,
  "a pending donation is deducted before another attack or donation",
);

// A high maxTroops value must not make the attack strategy wait forever. The
// hard reserve is still protected, but the old reserve/trigger ratio gates would
// stop this 40% army before the strategy pipeline was even evaluated.
const lowRatioBehavior = new sandbox.AttackBehavior(
  { chance: () => false },
  game,
  me,
  0.55,
  0.6,
  0.1,
  {},
  {},
);
let strategyEvaluated = false;
lowRatioBehavior.hasNeighboringBotWithStructures = () => false;
lowRatioBehavior.getAttackStrategies = () => [
  async () => {
    strategyEvaluated = true;
    return false;
  },
];
ownTroops = 40000;
await lowRatioBehavior.attackBestTarget([], [{}]);
assert.equal(
  strategyEvaluated,
  true,
  "available troops must reach the attack/donation strategy pipeline below the old ratio gates",
);
ownTroops = 100000;

// Land attacks use the same calculated hard reserve. They must not inherit the
// old percentage-of-capacity reserve after structures increase maxTroops.
const attackBudgetBehavior = new sandbox.AttackBehavior({}, game, me, 0.5, 0.3, 0.1, {}, {});
attackBudgetBehavior.getEnemyDefensePostAttackProfile = () => ({});
attackBudgetBehavior.attackIsTooWeakForDefensePosts = () => false;
attackBudgetBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
const humanTarget = {
  isPlayer: () => true,
  type: () => "Human",
  id: () => "human-target",
};
ownTroops = 40000;
assert.equal(attackBudgetBehavior.sendLandAttack(humanTarget), true);
assert.equal(
  troopEmissions.at(-1),
  30005,
  "a land attack may use the surplus above the calculated acceleration reserve",
);
ownTroops = 100000;

// A teammate donation must use the same hard reserve, not the obsolete 45%
// maxTroops keep line or the obsolete 20% chunk gate.
const donor = {
  troops: () => 35000,
  smallID: () => 11,
  isAlive: () => true,
  isOnSameTeam: () => true,
};
const needyTeammate = {
  troops: () => 8000,
  smallID: () => 12,
  isAlive: () => true,
  incomingAttacks: () => [],
  outgoingAttacks: () => [],
};
const donationGame = {
  ticks: () => tick,
  players: () => [donor, needyTeammate],
  getWinner: () => null,
  config: () => ({
    maxTroops: () => 100000,
    gameConfig: () => ({ gameMode: "Team" }),
    donateTroops: () => true,
  }),
};
const donorBehavior = new sandbox.AttackBehavior(
  { chance: () => true },
  donationGame,
  donor,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(donorBehavior.donateTroops(), true);
assert.equal(
  troopEmissions.at(-1),
  25005,
  "donations may release the surplus above the calculated acceleration reserve",
);

sandbox.state.settings.winFixes = false;
assert.equal(
  behavior.getEarlyGameSpendableTroops(),
  80005,
  "the hard reserve and pending donation guard is independent of winFixes",
);

console.log("attack intent accounting tests passed");
