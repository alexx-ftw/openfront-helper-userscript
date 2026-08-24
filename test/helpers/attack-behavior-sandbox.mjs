import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./classic-script.mjs";

export const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

export function createAttackBehaviorSandbox({
  unit = {},
  difficulty = Difficulty.Legendary,
  gameMode,
} = {}) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const sandbox = {
    UNIT: unit,
    Difficulty,
    PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
    currentDifficulty: () => difficulty,
    state: { settings: { winFixes: true }, stats: {} },
    ...(gameMode ? { GameMode: gameMode } : {}),
  };
  executeClassicScript(`${source}\nglobalThis.AttackBehavior = AttackBehavior;`, sandbox, {
    filename: sourcePath,
  });
  return sandbox;
}
