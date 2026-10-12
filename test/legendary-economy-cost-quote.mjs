import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

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
  randTerritoryTileArray: () => [],
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
  { filename: "legendary-economy-cost-quote.vm.js" },
);

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
const availableGold = 200_000n;
const quoteCalls = [];
behavior.player = {
  gold: () => availableGold,
  buildables: async (tile, types) => {
    quoteCalls.push({ tile, types: Array.from(types) });
    return Array.from(types, (type) => ({
      type,
      // Captured Cities raise ownedLevels without raising core's constructed count.
      cost: type === UNIT.City ? 125_000n : 250_000n,
      canBuild: false,
      canUpgrade: false,
    }));
  },
};
behavior.game = { config: () => ({}) };
behavior.ownedLevels = (type) => (type === UNIT.City ? 2 : 0);
behavior.legendaryCostFactor = () => 1;
behavior.availableGoldAfterReserve = () => availableGold;
behavior.legendaryConstructionState = () => ({
  missileThreat: { critical: false, score: 0 },
  samLevelParityGap: 0,
  defenseGap: 0,
  targetPressure: 0,
  siloParityGap: 0,
  railNeed: 1,
  tradeNeed: 1,
  economyInputs: {},
});
behavior.probeLegendaryThroughputUpgradeCandidates = async () => [];
behavior.computeTroopCapPressure = () => false;
behavior.legendaryConstructionCandidateBlocked = () => false;
behavior.legendaryBigStartSiloCandidateBlocked = () => false;
behavior.addLegendaryCityCandidates = function (context) {
  this.addLegendaryConstructionCandidate(context, UNIT.City, {
    deficit: 1,
    efficiency: 1,
    netTeamGold: 1n,
  });
};
behavior.addLegendaryCityRouteCandidates = () => {};
behavior.addLegendaryPortRouteCandidates = () => {};
behavior.addLegendaryFactoryRouteCandidates = () => {};
behavior.addLegendaryRatioCandidate = () => {};

const localEstimate = behavior.cost(UNIT.City);
assert.equal(localEstimate, 500_000n, "the owned-level estimate includes the two captured Cities");

const candidates = await behavior.legendaryConstructionCandidates({
  config: {},
  citiesDisabled: false,
  cityCount: 2,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});

assert.equal(quoteCalls.length, 1, "all productive structure prices use one batched quote request");
assert.equal(quoteCalls[0].tile, undefined, "the price-only request does not claim placement legality");
assert.deepEqual(quoteCalls[0].types, [UNIT.Factory, UNIT.Port, UNIT.City]);
assert.equal(candidates[0].cost, 125_000n, "candidate pricing uses the live BuildableUnit quote");
assert.equal(
  behavior.constructionCostForOptions(UNIT.City, {
    useActualCost: true,
    legendaryEconomyCostQuote: candidates[0].cost,
  }),
  125_000n,
  "the selected quote also clears the pre-probe affordability gate",
);

const ranked = behavior.legendaryConstructionActionGroups(candidates, true)[0];
assert.equal(ranked[0].type, UNIT.City, "the quoted price makes the City affordable and rankable now");
assert.notEqual(ranked[0].action, "wait");

const estimatedCandidate = {
  ...candidates[0],
  cost: localEstimate,
  affordable: localEstimate <= availableGold,
};
assert.deepEqual(
  Array.from(
    behavior.legendaryConstructionActionGroups([estimatedCandidate], true)[0],
    (candidate) => candidate.type,
  ),
  ["Wait"],
  "the stale owned-level estimate would defer the same City build",
);

behavior.player.buildables = async () => {
  throw new Error("worker unavailable");
};
const fallbackCandidates = await behavior.legendaryConstructionCandidates({
  config: {},
  citiesDisabled: false,
  cityCount: 2,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
assert.equal(fallbackCandidates[0].cost, localEstimate, "a failed quote retains the estimate");
assert.equal(
  behavior.legendaryConstructionActionGroups(fallbackCandidates, true)[0][0].type,
  "Wait",
  "a failed quote does not make the captured City appear affordable",
);

process.stdout.write("legendary economy live-cost quote test passed\n");
