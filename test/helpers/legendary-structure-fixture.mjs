import { executeClassicScript, readRepositoryFile } from "./repository-fixture.mjs";

// Shared VM harness for the Legendary structure-behavior unit tests. The
// engine files are classic scripts sharing one lexical scope, so every test
// needs the same sandbox plus the concatenated planner/behavior source.
export function createLegendaryStructureSandbox({ randTerritoryTiles = [], vmFilename }) {
  const UNIT = {
    AtomBomb: "AtomBomb",
    City: "City",
    DefensePost: "DefensePost",
    Factory: "Factory",
    HydrogenBomb: "HydrogenBomb",
    MIRV: "MIRV",
    MIRVWarhead: "MIRVWarhead",
    MissileSilo: "MissileSilo",
    Port: "Port",
    SAMLauncher: "SAMLauncher",
    TradeShip: "TradeShip",
    Train: "Train",
    Warship: "Warship",
  };
  const Difficulty = {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  };
  const sandbox = {
    UNIT,
    Difficulty,
    GameMode: { Team: "Team", FFA: "Free For All" },
    PlayerType: { Bot: "Bot", Nation: "Nation", Human: "Human" },
    state: { settings: { winFixes: false }, stats: { builds: 0 } },
    currentDifficulty: () => Difficulty.Legendary,
    isLegendaryDifficulty: () => true,
    isAtLeastHardDifficulty: () => true,
    getBuildMenu: () => ({ sendBuildOrUpgrade: () => true }),
    sendAutoBotBuildOrUpgrade: () => false,
    autoBotBuildAllowed: () => true,
    randTerritoryTileArray: () => randTerritoryTiles,
    withTimeout: (promise) => promise,
    WORKER_TIMEOUT_MS: 50,
    setLastAction: () => {},
    tr: (value) => value,
    captureRuntimeException: () => {},
    runtimeDebugLog: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    readRepositoryFile("engine/ingame/auto-bot/legendaryPlanner.js") +
      "\n" +
      readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js") +
      "\nglobalThis.__StructureBehavior = StructureBehavior;",
    sandbox,
    { filename: vmFilename },
  );
  return sandbox;
}
