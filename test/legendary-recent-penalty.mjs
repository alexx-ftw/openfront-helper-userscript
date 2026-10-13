// Focused pin for the 250k Legendary recent-strike penalty
// (docs/legendary-metric-ceilings.md, 2026-10-06 re-arm): nukeTileScore's raw
// equality against Difficulty.Legendary never fired because currentDifficulty()
// maps Legendary to Impossible. The score must apply 250k per recent strike
// through the isLegendaryDifficulty bridge (Impossible == Legendary policy
// tier) and keep the faithful 1M on Hard.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const UNIT = {
  City: "City",
  SAMLauncher: "SAM Launcher",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
};
let difficulty = "Impossible";
const sandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Relation: { Hostile: "Hostile" },
  state: { settings: { winFixes: true }, stats: { nukes: 0, builds: 0 } },
  currentDifficulty: () => difficulty,
  isAtLeastHardDifficulty: (value) => {
    const d = value ?? difficulty;
    return d === "Hard" || d === "Impossible" || d === "Legendary";
  },
  isLegendaryDifficulty: (value) => {
    const d = value ?? difficulty;
    return d === "Legendary" || d === "Impossible";
  },
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: () => true,
  setLastAction: () => {},
  tr: (value) => value,
  EMOJI_NUKE: [],
  closestTwoTiles: (_gm, a, b) => ({ x: a[0], y: b[0] }),
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(read("engine/ingame/shared-utils.js"), sandbox, {
  filename: "shared-utils.vm.js",
});
executeClassicScript(
  `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read("engine/ingame/auto-bot/structureBehavior.js")}\n${read("engine/ingame/auto-bot/nukeBehavior.js")}\nglobalThis.__NukeBehavior = NukeBehavior;`,
  sandbox,
  { filename: "legendary-recent-penalty.vm.js" },
);

function makeBehavior() {
  const game = {
    ticks: () => 1000,
    config: () => ({ nukeMagnitudes: () => ({ inner: 10, outer: 30 }) }),
    euclideanDistSquared: (a, b) => (a - b) * (a - b),
    nearbyUnits: () => [],
  };
  const behavior = new sandbox.__NukeBehavior(
    { chance: () => false },
    game,
    { smallID: () => 1, team: () => null },
    { shouldAttack: () => true },
    { maybeSendEmoji() {} },
  );
  behavior.friendlyFirePenalty = () => 0;
  return behavior;
}

function scoreWithRecentStrikes(recentlySentNukes, survival = false) {
  const behavior = makeBehavior();
  behavior.recentlySentNukes = recentlySentNukes;
  const target = { type: () => UNIT.City, level: () => 1, tile: () => 10 };
  const silo = { tile: () => 10 };
  return behavior.nukeTileScore(10, [silo], [target], UNIT.AtomBomb, survival);
}

// One recent strike inside the inner radius: city value 25k. The bridge
// exposes the Legendary policy tier via the Impossible raw value -> 250k.
difficulty = "Impossible";
assert.equal(
  scoreWithRecentStrikes([[0, 10, UNIT.AtomBomb]]),
  25_000 - 250_000,
  "Legendary policy tier (Impossible raw) applies the light 250k penalty",
);

// Two recent strikes stack the light penalty per strike.
assert.equal(
  scoreWithRecentStrikes([
    [0, 10, UNIT.AtomBomb],
    [0, 10, UNIT.AtomBomb],
  ]),
  25_000 - 500_000,
  "the 250k penalty stacks per recent strike in the Legendary tier",
);

// Hard keeps the faithful 1M penalty.
difficulty = "Hard";
assert.equal(
  scoreWithRecentStrikes([[0, 10, UNIT.AtomBomb]]),
  25_000 - 1_000_000,
  "Hard keeps the faithful 1M recent-strike penalty",
);

difficulty = "Impossible";
assert.equal(
  scoreWithRecentStrikes([[0, 10, UNIT.AtomBomb]], true),
  25_000,
  "active invasion survival can re-strike cratered enemy land without the recent-strike penalty",
);
