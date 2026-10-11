import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
  Warship: "Warship",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

const state = { settings: { winFixes: true, buildStructures: {} }, stats: { builds: 0 } };
let testDifficulty = Difficulty.Legendary;
const sandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation", Tribe: "Tribe" },
  state,
  currentDifficulty: () => testDifficulty,
  isLegendaryDifficulty: (difficulty = Difficulty.Impossible) =>
    difficulty === Difficulty.Legendary,
  isAtLeastHardDifficulty: (difficulty) =>
    difficulty === Difficulty.Hard ||
    difficulty === Difficulty.Impossible ||
    difficulty === Difficulty.Legendary,
  getBuildMenu: () => ({ sendBuildOrUpgrade: () => {} }),
  sendAutoBotBuildOrUpgrade: () => true,
  autoBotBuildAllowed: () => true,
  randTerritoryTileArray: (_random, _game, _player, count) =>
    Array.from({ length: count }, (_, index) => 10_000 + index),
  setLastAction: () => {},
  tr: (value) => value,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
};
sandbox.globalThis = sandbox;
const geometrySandbox = {};
executeClassicScript(
  `${read("engine/ingame/auto-bot/portutil.js")}\nglobalThis.closestTile = closestTile;`,
  geometrySandbox,
  { filename: "post-budget-geometry.vm.js" },
);
sandbox.closestTile = geometrySandbox.closestTile;
executeClassicScript(
  `${read("engine/ingame/shared-utils.js")}
${read("engine/ingame/auto-bot/legendaryPlanner.js")}
${read("engine/ingame/auto-bot/structureBehavior.js")}
globalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "post-budget.vm.js" },
);

const makeBehavior = ({ frontTiles, strongestTroops = 1_500_000, surplusGold = true }) => {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.player = { troops: () => 1_000_000 };
  behavior.hasBuiltCityForPreemptiveDefense = () => true;
  behavior.legendaryQuietPostGoldAboveEconomyRung = () => surplusGold;
  behavior.strongestQuietStrategicBorderOpponent = () => ({
    opponentSid: 3,
    troops: strongestTroops,
  });
  behavior.getOpponentFrontTiles = () => Array.from({ length: frontTiles }, (_, i) => i);
  return behavior;
};

const budgetCases = [
  { difficulty: Difficulty.Medium, frontTiles: 5000, expected: 1 },
  { difficulty: Difficulty.Legendary, frontTiles: 300, expected: 2 },
  { difficulty: Difficulty.Legendary, frontTiles: 1100, expected: 3 },
  { difficulty: Difficulty.Legendary, frontTiles: 1800, expected: 4 },
  { difficulty: Difficulty.Legendary, frontTiles: 10000, expected: 6 },
];
for (const budgetCase of budgetCases) {
  testDifficulty = budgetCase.difficulty;
  const threat = makeBehavior({
    frontTiles: budgetCase.frontTiles,
  }).computeStrategicBorderDefensePostThreat(budgetCase.difficulty);
  assert.equal(
    threat && threat.allowed,
    budgetCase.expected,
    `front ${budgetCase.frontTiles} on ${budgetCase.difficulty} must authorize ${budgetCase.expected} posts`,
  );
  assert.equal(threat.strategicBorder, true);
}

testDifficulty = Difficulty.Legendary;
assert.equal(
  makeBehavior({ frontTiles: 10000, surplusGold: false }).computeStrategicBorderDefensePostThreat(
    Difficulty.Legendary,
  ),
  null,
  "quiet-border posts stay gated behind the Legendary surplus gold rule",
);
assert.equal(
  makeBehavior({
    frontTiles: 10000,
    strongestTroops: 500_000,
  }).computeStrategicBorderDefensePostThreat(Difficulty.Legendary),
  null,
  "a border opponent below 1x own troops must not authorize quiet-border posts",
);

process.stdout.write("strategic-defense-post-budget fixture: OK\n");
