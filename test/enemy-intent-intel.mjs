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
const attacker = { smallID: () => 2 };
const me = {
  incomingAttacks: () => incomingAttacks,
  isFriendly: () => false,
};
const game = {
  myPlayer: () => me,
  playerBySmallID: (id) => (id === 2 ? attacker : null),
};
const sandbox = {
  runtimeState: { enemyIntentEnabled: false },
  performance: { now: () => now },
  getOpenFrontGameContext: () => ({ game }),
  getCachedPlayerViews: () => [],
  registerHelperTickListener: (listener) => {
    tickListener = listener;
  },
  unregisterHelperTickListener: () => {},
  runtimeDebugLog: () => {},
};

executeClassicScript(SOURCE, sandbox, { filename: "enemy-intent-intel.js" });
sandbox.setEnemyIntentEnabled(true);
assert.equal(typeof tickListener, "function");

incomingAttacks = [{ attackerID: 2, troops: 500, retreating: false }];
tickListener();
assert.equal(sandbox.getEnemyIntentWarnings().length, 1);

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

process.stdout.write("enemy intent intelligence tests passed\n");
