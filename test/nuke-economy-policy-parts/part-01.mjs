import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nukeBehavior.js"),
  "utf8",
);
const mirvSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/mirvBehavior.js"),
  "utf8",
);
const sharedUtilsSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/shared-utils.js"),
  "utf8",
);
const gameApiSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/gameApi.js"),
  "utf8",
);

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
  TransportShip: "Transport Ship",
  TradeShip: "Trade Ship",
  Warship: "Warship",
};
let testDifficulty = "Impossible";
const sandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { FFA: "FFA", Team: "Team" },
  Relation: { Hostile: "Hostile" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true }, stats: { nukes: 0 }, recentMirvHits: [] },
  currentDifficulty: () => testDifficulty,
  // Production (portutil.js) treats both spellings as the Legendary tier:
  // the engine enum only has Impossible, the userscript UI says Legendary.
  isLegendaryDifficulty: (difficulty) => difficulty === "Legendary" || difficulty === "Impossible",
  isAtLeastHardDifficulty: () => true,
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(sharedUtilsSource, sandbox, {
  filename: "shared-utils.vm.js",
});
executeClassicScript(
  `${source}\nglobalThis.__NukeBehavior = NukeBehavior; globalThis.__UniversalPathFinding = UniversalPathFinding;`,
  sandbox,
  {
    filename: "nuke-economy-policy.vm.js",
  },
);

let mirvBuildTile = null;
Object.assign(sandbox, {
  AllPlayers: {},
  EMOJI_NUKE: [],
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: (_menu, _buildable, tile) => {
    mirvBuildTile = tile;
    return true;
  },
  setLastAction() {},
  tr: (value) => value,
  respondToMIRV() {},
});
executeClassicScript(`${mirvSource}\nglobalThis.__MirvBehavior = MirvBehavior;`, sandbox, {
  filename: "mirv-economy-policy.vm.js",
});

const behavior = Object.create(sandbox.__NukeBehavior.prototype);
const target = { smallID: () => 42 };

const gameApiSandbox = {};
executeClassicScript(
  `${gameApiSource}\nglobalThis.__createGameApi = createGameApi;`,
  gameApiSandbox,
  { filename: "nuke-economy-game-api.vm.js" },
);
const wrappedGame = gameApiSandbox.__createGameApi({}).game;

