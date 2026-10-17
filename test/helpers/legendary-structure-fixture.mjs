import { executeClassicScript } from "./repository-fixture.mjs";
import { readLegendaryPlannerSource } from "./legendary-planner-source.mjs";
import { readStructureBehaviorSource } from "./structure-behavior-source.mjs";

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
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    readLegendaryPlannerSource() +
      "\n" +
      readStructureBehaviorSource() +
      "\nglobalThis.__StructureBehavior = StructureBehavior;",
    sandbox,
    { filename: vmFilename },
  );
  return sandbox;
}

/** Pause a partner Port quote while the latest shared-water seed state can change. */
export function createPortSeedQuoteFixture(
  sandbox,
  { cost, config, horizonTicks, arrivalGold, distance },
) {
  let finishQuote;
  let startQuote;
  let eligible = true;
  const quoteStarted = new Promise((resolve) => {
    startQuote = resolve;
  });
  const quote = new Promise((resolve) => {
    finishQuote = resolve;
  });
  const emissions = [];
  const { UNIT } = sandbox;
  const route = { weight: 1, distance, teamGoldPerArrival: arrivalGold };
  const sources = ["own", "partner"].map((portSeedStream, index) => ({
    level: 1,
    portSeedStream,
    placementTile: 10 + index,
    portSeedWaterComponent: -1,
    routes: [route],
  }));
  const partner = {
    smallID: () => 2,
    buildables: () => {
      startQuote();
      return quote;
    },
  };
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  Object.assign(behavior, {
    player: { units: () => [], smallID: () => 1 },
    game: { config: () => config },
    structureSpawnEligible: () => true,
    economicStructureSpawnPending: () => false,
    constructionCostForOptions: () => cost,
    availableGoldAfterReserve: () => cost * 4n,
    structureSpawnBuildable: async () => ({ type: UNIT.Port, canBuild: 10, cost }),
    hasAnyShoreBorderTile: () => true,
    legendaryPortSeedWindowOpen: () => eligible,
    legendaryPortSeedPartner: () => (eligible ? partner : null),
    legendaryConstructionState: () => ({
      economyHorizonTicks: horizonTicks,
      economyInputs: {
        hasCompletedTradePartner: false,
        portSeedWindowOpen: eligible,
        tradeShipCount: 0,
        portSeedSources: eligible ? sources : [],
        portCandidateProfiles: [],
      },
    }),
    isUsableStructureBuildable: () => true,
  });
  sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable) => {
    emissions.push(buildable);
    return true;
  };
  return {
    behavior,
    emissions,
    quoteStarted,
    invalidateRoute: () => {
      eligible = false;
    },
    resolveQuote: () => finishQuote([{ type: UNIT.Port, canBuild: 11, cost }]),
  };
}

/** Supply a profitable rail/water snapshot for the isolated build-dispatch fixture. */
export function installLegalEconomyDispatchFixture(behavior, placementTile) {
  const config = {
    unitInfo: () => ({ constructionDuration: 0 }),
    trainSpawnRate: () => 1,
    tradeShipSpawnRate: () => 1,
  };
  const profile = {
    clusterId: "rail#dispatch",
    factorySourceCount: 0,
    paidStops: 1,
    teamGoldPerSpawn: 1_000,
    trainSources: [{ factoryCount: 1, productiveFactoryLevels: [1], teamGoldPerStop: 1_000 }],
  };
  const inputs = {
    factoryStationEntries: [{ tile: 0 }],
    factoryRailState: new Uint8Array(1),
    factoryRouteProfiles: [profile],
    cityRouteProfiles: [profile],
    hasCompletedTradePartner: true,
    portCandidateProfiles: [
      {
        placementTile,
        waterComponents: [-1],
        routes: [{ weight: 1, distance: 1, teamGoldPerArrival: 1_000 }],
      },
    ],
  };
  Object.assign(behavior, {
    game: {
      config: () => config,
      width: () => 1,
      height: () => 1,
      sharedWaterComponents: () => new Set([-1]),
    },
    legendaryConstructionState: () => ({ economyHorizonTicks: 1_000, economyInputs: inputs }),
    hasAnyShoreBorderTile: () => true,
    structureCandidateTiles: () => [placementTile],
    assignRailClusters: (entries) => entries.map(() => profile.clusterId),
    portWaterComponents: () => new Set(),
  });
}
