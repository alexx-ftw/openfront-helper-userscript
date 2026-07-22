import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/enemy-intent-intel.js"), "utf8");

let incomingAttacks = [];
let tickListener = null;
let now = 1000;
let playerLookups = 0;
const attacker = {
  smallID: () => 2,
  clientID: () => 999,
  displayName: () => "Nemesis",
};
const me = {
  incomingAttacks: () => incomingAttacks,
  isFriendly: () => false,
};
const game = {
  myPlayer: () => me,
  playerBySmallID: (id) => {
    playerLookups++;
    return resolvedPlayers.get(id) ?? null;
  },
};
const resolvedPlayers = new Map([[2, attacker]]);
const sandbox = {
  runtimeState: { enemyIntentEnabled: false },
  performance: { now: () => now },
  getOpenFrontGameContext: () => ({ game }),
  getCachedPlayerViews: () => [],
  getPlayerSmallId: (player, fallback) => player?.smallID?.() ?? fallback,
  getPlayerDisplayName: (player) => player.displayName(),
  registerHelperTickListener: (listener) => {
    tickListener = listener;
  },
  unregisterHelperTickListener: () => {},
  runtimeDebugLog: () => {},
};

executeClassicScript(SOURCE, sandbox, { filename: "enemy-intent-intel.js" });
sandbox.setEnemyIntentEnabled(true);
assert.equal(typeof tickListener, "function");

incomingAttacks = [
  { attackerID: 2, troops: 300, retreating: false },
  { attackerID: 2, troops: 200, retreating: false },
];
playerLookups = 0;
tickListener();
assert.equal(sandbox.getEnemyIntentWarnings().length, 1);
assert.equal(
  sandbox.getEnemyIntentWarnings()[0].attackerName,
  "Nemesis",
  "AttackUpdate attackerID resolves through player smallID, not unrelated clientID",
);
assert.equal(
  sandbox.getEnemyIntentWarnings()[0].troops,
  500,
  "simultaneous active waves from one attacker are summed",
);
assert.equal(
  playerLookups,
  2,
  "simultaneous waves reuse one diplomacy lookup before resolving the warning label",
);

incomingAttacks = [{ attackerID: 2, troops: 75, retreating: false }];
now += 250;
tickListener();
assert.equal(
  sandbox.getEnemyIntentWarnings()[0].troops,
  75,
  "the warning follows the live remaining force instead of retaining its historical maximum",
);

incomingAttacks = [{ attackerID: 2, troops: 500, retreating: true }];
now += 250;
tickListener();
assert.equal(
  sandbox.getEnemyIntentWarnings().length,
  0,
  "a withdrawn attack clears its warning immediately instead of waiting 15 seconds",
);

incomingAttacks = [{ attackerID: 2, troops: 400, retreating: () => false }];
now += 250;
tickListener();
assert.equal(
  sandbox.getEnemyIntentWarnings().length,
  1,
  "method-based normalized attacks remain visible while active",
);

incomingAttacks = [];
now += 250;
tickListener();
assert.equal(
  sandbox.getEnemyIntentWarnings().length,
  0,
  "a resolved attack disappears on the first authoritative empty poll",
);

incomingAttacks = [{ attackerID: 5, troops: 250, retreating: false }];
now += 250;
tickListener();
assert.equal(sandbox.getEnemyIntentWarnings()[0].attackerName, "p5");

resolvedPlayers.set(5, {
  smallID: () => 5,
  displayName: () => "Late Enemy",
});
now += 250;
tickListener();
assert.equal(
  sandbox.getEnemyIntentWarnings()[0].attackerName,
  "Late Enemy",
  "a fallback attacker label refreshes when the player view becomes available",
);

process.stdout.write("enemy intent intelligence tests passed\n");
