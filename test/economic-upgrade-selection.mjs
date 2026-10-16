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
  TradeShip: "Trade Ship",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const state = { settings: { winFixes: true, buildStructures: {} }, stats: { builds: 0 } };
let testDifficulty = Difficulty.Impossible;
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
  getBuildMenu: () => null,
  sendAutoBotBuildOrUpgrade: () => false,
  autoBotBuildAllowed: () => true,
  setLastAction: () => {},
  tr: (value) => value,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${read("engine/ingame/shared-utils.js")}
${read("engine/ingame/auto-bot/legendaryPlanner.js")}
${read("engine/ingame/auto-bot/structureBehavior.js")}
globalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "economic-upgrade-selection.vm.js" },
);

function makeUnit(type, id, level = 1) {
  return {
    type: () => type,
    id: () => id,
    level: () => level,
    isUnderConstruction: () => false,
    tile: () => id,
  };
}

function makeBehavior({
  factoryUnits = [],
  gold = 1_000_000n,
  tradeShipCount = 0,
  cachedTradeShipCount = tradeShipCount,
  protectionById = new Map(),
  costsById = new Map(),
  cityTroopIncrease = 250_000,
} = {}) {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  let authoritativeProbeCalls = 0;
  let workerProbeCalls = 0;
  let cachedUnitCountCalls = 0;
  behavior.player = {
    units(type) {
      if (type === UNIT.Factory) return factoryUnits;
      return [];
    },
  };
  behavior.game = {
    config: () => ({
      cityTroopIncrease: () => cityTroopIncrease,
      trainSpawnRate: (factoryLevels) => (factoryLevels + 10) * 15,
      tradeShipSpawnRate: (_rejections, ships) => 100 + ships,
    }),
    unitCount: () => {
      throw new Error("economic upgrade ranking must not materialize global units");
    },
    cachedUnitCount(type) {
      cachedUnitCountCalls++;
      return type === UNIT.TradeShip ? cachedTradeShipCount : null;
    },
  };
  behavior.availableGoldAfterReserve = () => gold;
  behavior.structureSamProtectionScore = (unit) => protectionById.get(unit.id()) ?? 0;
  behavior.buildableFor = async () => {
    workerProbeCalls++;
    throw new Error("economic upgrade ranking must reuse the authoritative probe");
  };
  behavior.probeUpgradableStructures = async (candidates) => {
    authoritativeProbeCalls++;
    return {
      upgradable: candidates,
      buByUnitId: new Map(
        candidates.map((unit) => [unit.id(), { canUpgrade: true, cost: costsById.get(unit.id()) }]),
      ),
    };
  };
  behavior.random = {
    nextInt: () => {
      throw new Error("win-fixes economic upgrade selection must not consume RNG");
    },
    randElement: () => {
      throw new Error("win-fixes economic upgrade selection must not consume RNG");
    },
    chance: () => {
      throw new Error("win-fixes economic upgrade selection must not consume RNG");
    },
  };
  return {
    behavior,
    probeCounts: () => ({ authoritativeProbeCalls, workerProbeCalls }),
    cachedUnitCountCalls: () => cachedUnitCountCalls,
  };
}

function trainSpawnRate(level, totalFactoryLevels) {
  const baseRate = (totalFactoryLevels + 10) * 15;
  const attempt = 1 - Math.pow(1 - 1 / baseRate, level);
  return attempt / (1 + 9 * attempt);
}

function portfolioFactoryMarginal(levels, targetId) {
  const currentTotal = levels.reduce((sum, entry) => sum + entry.level, 0);
  const current = levels.reduce((sum, entry) => sum + trainSpawnRate(entry.level, currentTotal), 0);
  const next = levels.reduce(
    (sum, entry) =>
      sum + trainSpawnRate(entry.level + (entry.id === targetId ? 1 : 0), currentTotal + 1),
    0,
  );
  return next - current;
}

testDifficulty = Difficulty.Impossible;
const lowFactory = makeUnit(UNIT.Factory, "factory-low", 1);
const highFactory = makeUnit(UNIT.Factory, "factory-high", 4);
const otherFactory = makeUnit(UNIT.Factory, "factory-other", 2);
const factoryLevels = [
  { id: "factory-low", level: 1 },
  { id: "factory-high", level: 4 },
  { id: "factory-other", level: 2 },
];
const factorySetup = makeBehavior({
  structures: [lowFactory, highFactory],
  factoryUnits: [lowFactory, highFactory, otherFactory],
  costsById: new Map([
    ["factory-low", 900n],
    ["factory-high", 1_000n],
  ]),
});
const factoryUpgrade = await factorySetup.behavior.findBestStructureToUpgrade([
  lowFactory,
  highFactory,
]);
assert.ok(
  portfolioFactoryMarginal(factoryLevels, "factory-low") / 900 >
    portfolioFactoryMarginal(factoryLevels, "factory-high") / 1_000,
  "factory level and unequal authoritative costs produce a higher per-gold marginal rate",
);
assert.equal(
  factoryUpgrade?.structure,
  lowFactory,
  "Factory upgrade value uses the exact portfolio spawn-rate change, including level sum and 10-tick cooldown",
);
assert.deepEqual(
  factorySetup.probeCounts(),
  { authoritativeProbeCalls: 1, workerProbeCalls: 0 },
  "ranking reuses one bounded authoritative upgrade probe and performs no extra worker probes",
);

const protectedFactory = makeUnit(UNIT.Factory, "protected", 4);
const unprotectedFactory = makeUnit(UNIT.Factory, "unprotected", 1);
const protectionSetup = makeBehavior({
  structures: [unprotectedFactory, protectedFactory],
  factoryUnits: [unprotectedFactory, protectedFactory],
  costsById: new Map([
    ["protected", 1_000n],
    ["unprotected", 100n],
  ]),
  protectionById: new Map([
    ["protected", 20],
    ["unprotected", 0],
  ]),
});
const protectedUpgrade = await protectionSetup.behavior.findBestStructureToUpgrade([
  unprotectedFactory,
  protectedFactory,
]);
assert.equal(
  protectedUpgrade?.structure,
  protectedFactory,
  "the highest existing SAM-protection tier takes priority over a cheaper upgrade",
);

const cheapCity = makeUnit(UNIT.City, "city-cheap", 1);
const expensiveCity = makeUnit(UNIT.City, "city-expensive", 2);
const citySetup = makeBehavior({
  structures: [expensiveCity, cheapCity],
  costsById: new Map([
    ["city-cheap", 400n],
    ["city-expensive", 800n],
  ]),
});
const cityUpgrade = await citySetup.behavior.findBestStructureToUpgrade([expensiveCity, cheapCity]);
assert.equal(
  cityUpgrade?.structure,
  cheapCity,
  "City upgrades share the same cap gain, so the lower authoritative cost has the better marginal value",
);
const tiedCityZ = makeUnit(UNIT.City, "z-city", 1);
const tiedCityA = makeUnit(UNIT.City, "a-city", 1);
const tiedCitySetup = makeBehavior({
  costsById: new Map([
    ["z-city", 500n],
    ["a-city", 500n],
  ]),
});
assert.equal(
  (await tiedCitySetup.behavior.findBestStructureToUpgrade([tiedCityZ, tiedCityA]))?.structure,
  tiedCityA,
  "equal protection, gain, and cost use a stable structure-ID tie-break",
);

const lowPort = makeUnit(UNIT.Port, "port-low", 1);
const highPort = makeUnit(UNIT.Port, "port-high", 3);
const portSetup = makeBehavior({
  structures: [lowPort, highPort],
  tradeShipCount: 5,
  costsById: new Map([
    ["port-low", 1_000n],
    ["port-high", 100n],
  ]),
});
const portUpgrade = await portSetup.behavior.findBestStructureToUpgrade([lowPort, highPort]);
assert.equal(
  portUpgrade?.structure,
  highPort,
  "Port upgrades rank the configured base-rate chance increase per ten-tick check against authoritative cost",
);
assert.equal(
  portSetup.cachedUnitCountCalls(),
  1,
  "Port upgrade ranking reads the same-tick cached TradeShip count once",
);

const unknownPort = makeUnit(UNIT.Port, "port-unknown", 1);
const unknownPortSetup = makeBehavior({
  cachedTradeShipCount: null,
  costsById: new Map([["port-unknown", 1n]]),
});
assert.equal(
  await unknownPortSetup.behavior.findBestStructureToUpgrade([unknownPort]),
  null,
  "an unknown cached TradeShip count is not mistaken for zero when valuing a Port upgrade",
);
assert.equal(unknownPortSetup.cachedUnitCountCalls(), 1);

const missingCachePort = makeUnit(UNIT.Port, "port-no-cache", 1);
const missingCacheSetup = makeBehavior({
  costsById: new Map([["port-no-cache", 1n]]),
});
let uncachedUnitCountCalls = 0;
missingCacheSetup.behavior.game.cachedUnitCount = undefined;
missingCacheSetup.behavior.game.unitCount = () => {
  uncachedUnitCountCalls++;
  return 0;
};
assert.equal(
  await missingCacheSetup.behavior.findBestStructureToUpgrade([missingCachePort]),
  null,
  "a missing cached count disables Port marginal ranking instead of falling back to a full global scan",
);
assert.equal(uncachedUnitCountCalls, 0);

const affordableCity = makeUnit(UNIT.City, "affordable", 1);
const unaffordableCity = makeUnit(UNIT.City, "unaffordable", 1);
const affordabilitySetup = makeBehavior({
  structures: [unaffordableCity, affordableCity],
  gold: 100n,
  costsById: new Map([
    ["affordable", 100n],
    ["unaffordable", 101n],
  ]),
});
assert.equal(
  (await affordabilitySetup.behavior.findBestStructureToUpgrade([unaffordableCity, affordableCity]))
    ?.structure,
  affordableCity,
  "an upgrade at the exact spendable-gold boundary is affordable",
);
affordabilitySetup.behavior.availableGoldAfterReserve = () => 99n;
assert.equal(
  await affordabilitySetup.behavior.findBestStructureToUpgrade([affordableCity]),
  null,
  "a win-fix economic upgrade is not returned when its authoritative cost exceeds the reserved budget",
);
const unpricedCity = makeUnit(UNIT.City, "unpriced", 1);
const unpricedSetup = makeBehavior({ gold: 1_000n });
assert.equal(
  await unpricedSetup.behavior.findBestStructureToUpgrade([unpricedCity]),
  null,
  "an economic upgrade without an authoritative price is not selected",
);

state.settings.winFixes = false;
testDifficulty = Difficulty.Legendary;
const legacyCityA = makeUnit(UNIT.City, "legacy-a", 1);
const legacyCityB = makeUnit(UNIT.City, "legacy-b", 1);
const legacySetup = makeBehavior({
  structures: [legacyCityA, legacyCityB],
  costsById: new Map([
    ["legacy-a", 1n],
    ["legacy-b", 1n],
  ]),
  protectionById: new Map([
    ["legacy-a", 0],
    ["legacy-b", 5],
  ]),
});
const legacyCalls = [];
legacySetup.behavior.random = {
  nextInt(minimum, maximum) {
    legacyCalls.push([minimum, maximum]);
    return 0;
  },
  randElement() {
    throw new Error("Legendary legacy path does not use random selection here");
  },
  chance() {
    throw new Error("Legendary legacy path remains deterministic after its established RNG draws");
  },
};
const legacyUpgrade = await legacySetup.behavior.findBestStructureToUpgrade([
  legacyCityA,
  legacyCityB,
]);
assert.equal(legacyUpgrade?.structure, legacyCityB);
assert.deepEqual(
  legacyCalls,
  [
    [0, 100],
    [0, 5],
    [0, 5],
  ],
  "winFixes=false retains the legacy random draw sequence exactly",
);

state.settings.winFixes = true;
process.stdout.write("economic upgrade selection tests passed\n");
