import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

const SOURCE = readRepositoryFile("engine/ingame/sos-defense.js");

const attacker = {
  id: () => "attacker-id",
  smallID: () => 2,
  isAlive: () => true,
};
const ally = {
  id: () => "ally-id",
  smallID: () => 3,
  isAlive: () => true,
};
const secondAttacker = {
  id: () => "attacker-2-id",
  smallID: () => 4,
  isAlive: () => true,
};
let incomingAttacks = [];
const me = {
  smallID: () => 1,
  isAlive: () => true,
  isFriendly: (player) => player === ally,
  incomingAttacks: () => incomingAttacks,
};
const game = { myPlayer: () => me };
const players = [me, attacker, secondAttacker, ally];
const signals = [];
let tickListener = null;
let now = 1000;
let playerViewReads = 0;
const sandbox = {
  performance: { now: () => now },
  getOpenFrontGameContext: () => ({ game }),
  getCachedPlayerViews: () => {
    playerViewReads++;
    return players;
  },
  getPlayerSmallId: (player, fallback) => player?.smallID?.() ?? fallback,
  isNationBotPlayer: () => false,
  emojiId: () => 7,
  enqueueSignal: (...args) => signals.push(args),
  registerHelperTickListener: (listener) => {
    tickListener = listener;
  },
  unregisterHelperTickListener: () => {},
};

executeClassicScript(SOURCE, sandbox, { filename: "sos-defense.js" });
sandbox.setSosDefenseEnabled(true);
assert.equal(typeof tickListener, "function");

incomingAttacks = [
  { attackerID: 2, retreating: false },
  { attackerID: 2, retreating: false },
];
playerViewReads = 0;
tickListener();
assert.equal(
  signals.filter(([kind]) => kind === "emoji").length,
  1,
  "the first SOS salvo is sent immediately even during the first 12 seconds",
);
assert.equal(
  signals.filter(([kind]) => kind === "target").length,
  1,
  "multiple waves from one attacker produce one target signal",
);
assert.equal(
  playerViewReads,
  1,
  "one SOS pass shares its player snapshot between attacker lookup and ally alerts",
);

sandbox.setSosDefenseEnabled(false);
sandbox.setSosDefenseEnabled(true);
signals.length = 0;
now += 250;
incomingAttacks = [
  { attackerID: 2, retreating: false },
  { attackerID: 4, retreating: false },
];
tickListener();
assert.equal(
  signals.filter(([kind]) => kind === "target").length,
  2,
  "multiple attackers are each marked from the shared participant index",
);

sandbox.setSosDefenseEnabled(false);
sandbox.setSosDefenseEnabled(true);
signals.length = 0;
now += 250;
incomingAttacks = [{ attackerID: 2, retreating: () => true }];
tickListener();
assert.equal(signals.length, 0, "a withdrawing attack does not summon allies or mark the attacker");

sandbox.setSosDefenseEnabled(false);
sandbox.setSosDefenseEnabled(true);
signals.length = 0;
incomingAttacks = [{ attackerID: 2, retreating: false }];
players.length = 0;
players.push(me, attacker);
tickListener();
assert.equal(
  signals.filter(([kind]) => kind === "emoji").length,
  0,
  "an SOS with no recipient emits no emoji",
);

now += 250;
players.push(ally);
tickListener();
assert.equal(
  signals.filter(([kind]) => kind === "emoji").length,
  1,
  "a newly available ally receives SOS immediately because an empty salvo consumes no cooldown",
);

process.stdout.write("SOS defense tests passed\n");
