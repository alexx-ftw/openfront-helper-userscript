import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expectedRailIncomePerTick } from "./helpers/construction-simulator.mjs";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plannerSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/legendaryPlanner.js"),
  "utf8",
);
const plannerSandbox = {};
executeClassicScript(plannerSource, plannerSandbox, {
  filename: "legendaryPlanner.js",
});

const rankEconomicInvestmentCandidates = plannerSandbox.rankEconomicInvestmentCandidates;
assert.equal(
  typeof rankEconomicInvestmentCandidates,
  "function",
  "the Legendary planner exposes its marginal investment ranker",
);

// This fixed rail graph has three candidate sites. A City and a Port would
// create completed trade endpoints for their own Factory; a new Factory can
// reach either an allied or team Port. The incomplete Port deliberately stays
// out of the completed-station snapshot.
const rail = new Map([
  ["factory-city", ["city-site"]],
  ["city-site", ["factory-city"]],
  ["factory-port", ["port-site"]],
  ["port-site", ["factory-port"]],
  ["factory-ally", ["ally-port", "new-ally-factory"]],
  ["ally-port", ["factory-ally", "new-ally-factory"]],
  ["new-ally-factory", ["ally-port", "factory-ally"]],
  ["factory-team", ["team-port", "new-team-factory"]],
  ["team-port", ["factory-team", "new-team-factory"]],
  ["new-team-factory", ["team-port", "factory-team"]],
  ["factory-unserved", ["unfinished-port"]],
  ["unfinished-port", ["factory-unserved"]],
  ["unserved-new-factory", ["unfinished-port"]],
]);

const stationSnapshot = [
  { id: "factory-city", type: "Factory", relation: "self", level: 1, complete: true },
  { id: "factory-port", type: "Factory", relation: "self", level: 1, complete: true },
  { id: "factory-ally", type: "Factory", relation: "self", level: 1, complete: true },
  { id: "factory-team", type: "Factory", relation: "self", level: 1, complete: true },
  { id: "factory-unserved", type: "Factory", relation: "self", level: 1, complete: true },
  { id: "ally-port", type: "Port", relation: "ally", complete: true },
  { id: "team-port", type: "Port", relation: "team", complete: true },
  { id: "unfinished-port", type: "Port", relation: "ally", complete: false },
];

function completedTradeSnapshot(stations) {
  const completed = stations.filter((station) => station.complete);
  return {
    stationTypes: new Map(completed.map(({ id, type }) => [id, type])),
    stationOwners: new Map(completed.map(({ id, relation }) => [id, relation])),
    factoryLevels: new Map(
      completed.filter(({ type }) => type === "Factory").map(({ id, level }) => [id, level]),
    ),
  };
}

const currentTrade = completedTradeSnapshot(stationSnapshot);
const baselineIncome = expectedRailIncomePerTick({
  adjacency: rail,
  ...currentTrade,
}).totalIncomePerTick;

function marginalIncome(candidate, overrides = {}) {
  const projected = expectedRailIncomePerTick({
    adjacency: rail,
    ...currentTrade,
    ...overrides,
    candidate,
  }).totalIncomePerTick;
  return Math.max(0, projected - baselineIncome);
}

const cityIncome = marginalIncome({
  id: "city-site",
  type: "City",
  owner: "self",
  level: 1,
});
const portIncome = marginalIncome({
  id: "port-site",
  type: "Port",
  owner: "self",
  level: 1,
});
const allyFactoryIncome = marginalIncome({
  id: "new-ally-factory",
  type: "Factory",
  owner: "self",
  level: 1,
});
const teamFactoryIncome = marginalIncome(
  {
    id: "new-team-factory",
    type: "Factory",
    owner: "self",
    level: 1,
  },
  {
    stationOwners: new Map([...currentTrade.stationOwners, ["ally-port", "team"]]),
  },
);
const unservedFactoryIncome = marginalIncome({
  id: "unserved-new-factory",
  type: "Factory",
  owner: "self",
  level: 1,
});

assert.ok(cityIncome > 0, "a City that becomes a completed rail destination adds trade income");
assert.ok(portIncome > 0, "a Port that becomes a completed rail destination adds trade income");
assert.ok(
  allyFactoryIncome > teamFactoryIncome,
  "a Factory serving a nearby allied endpoint is worth more than the same route to a teammate",
);
assert.equal(
  unservedFactoryIncome,
  0,
  "a Factory with no completed City or Port endpoint adds no trade income",
);

const upgradeIncome =
  expectedRailIncomePerTick({
    adjacency: rail,
    ...currentTrade,
    factoryLevels: new Map([...currentTrade.factoryLevels, ["factory-ally", 2]]),
  }).totalIncomePerTick - baselineIncome;
const newFactoryIncome = allyFactoryIncome;
assert.ok(upgradeIncome > 0, "a Factory level upgrade adds marginal throughput");

// The engine's Factory spawn denominator sums completed Factory levels per
// source owner. Foreign endpoint owners receive a separate copy of each paid
// stop, while totalIncomePerTick keeps its historical meaning: source-owner
// income summed across all train owners.
const ownerRail = new Map([
  ["owner-a-factory", ["owner-a-city"]],
  ["owner-a-city", ["owner-a-factory"]],
  ["owner-b-factory", ["owner-b-port"]],
  ["owner-b-port", ["owner-b-factory"]],
]);
const ownerStationTypes = new Map([
  ["owner-a-factory", "Factory"],
  ["owner-a-city", "City"],
  ["owner-b-factory", "Factory"],
  ["owner-b-port", "Port"],
]);
const ownerStationRelations = new Map([
  ["owner-a-city", "self"],
  ["owner-b-port", "ally"],
]);
const ownerFactoryLevels = new Map([
  ["owner-a-factory", 2],
  ["owner-b-factory", 1],
]);
const ownerFactoryIds = new Map([
  ["owner-a-factory", "owner-a"],
  ["owner-b-factory", "owner-b"],
]);
const ownerEndpointIds = new Map([
  ["owner-a-city", "owner-a"],
  ["owner-b-port", "owner-destination"],
]);
const constantTradeGold = () => 100;
const expectedSourceSpawnProbability = (ownerFactoryLevels, sourceLevel) => {
  const rate = (ownerFactoryLevels + 10) * 15;
  const attempt = 1 - (1 - 1 / rate) ** sourceLevel;
  return attempt / (1 + 9 * attempt);
};
const ownerLevelIncome = expectedRailIncomePerTick({
  adjacency: ownerRail,
  stationTypes: ownerStationTypes,
  stationOwners: ownerStationRelations,
  factoryLevels: ownerFactoryLevels,
  factoryOwnerIds: ownerFactoryIds,
  stationOwnerIds: ownerEndpointIds,
  goldForTradeStop: constantTradeGold,
});
const ownerAIncome = expectedSourceSpawnProbability(2, 2) * 100;
const ownerBIncome = expectedSourceSpawnProbability(1, 1) * 100;
assert.ok(Math.abs(ownerLevelIncome.sourceIncomeByOwner.get("owner-a") - ownerAIncome) < 1e-12);
assert.ok(Math.abs(ownerLevelIncome.sourceIncomeByOwner.get("owner-b") - ownerBIncome) < 1e-12);
assert.ok(Math.abs(ownerLevelIncome.totalIncomePerTick - ownerAIncome - ownerBIncome) < 1e-12);
assert.ok(
  Math.abs(ownerLevelIncome.endpointIncomeByOwner.get("owner-destination") - ownerBIncome) < 1e-12,
  "a foreign endpoint owner receives its own ledger entry without changing source income",
);
assert.equal(ownerLevelIncome.endpointIncomeByOwner.has("owner-a"), false);
assert.ok(Math.abs(ownerLevelIncome.totalEndpointIncomePerTick - ownerBIncome) < 1e-12);
assert.notEqual(
  ownerLevelIncome.totalIncomePerTick,
  ownerLevelIncome.totalIncomePerTick + ownerLevelIncome.totalEndpointIncomePerTick,
  "foreign endpoint payouts remain separate from the legacy source-income total",
);

const thirdOwnerIncome = expectedRailIncomePerTick({
  adjacency: new Map([
    ...ownerRail,
    ["owner-c-factory", ["owner-c-city"]],
    ["owner-c-city", ["owner-c-factory"]],
  ]),
  stationTypes: new Map([
    ...ownerStationTypes,
    ["owner-c-factory", "Factory"],
    ["owner-c-city", "City"],
  ]),
  stationOwners: new Map([...ownerStationRelations, ["owner-c-city", "self"]]),
  factoryLevels: new Map([...ownerFactoryLevels, ["owner-c-factory", 20]]),
  factoryOwnerIds: new Map([...ownerFactoryIds, ["owner-c-factory", "owner-c"]]),
  stationOwnerIds: new Map([...ownerEndpointIds, ["owner-c-city", "owner-c"]]),
  goldForTradeStop: constantTradeGold,
});
assert.equal(thirdOwnerIncome.sourceIncomeByOwner.get("owner-a"), ownerAIncome);
assert.equal(thirdOwnerIncome.sourceIncomeByOwner.get("owner-b"), ownerBIncome);

const asPositiveCost = (income, ticks) => BigInt(Math.max(1, Math.ceil(income * ticks)));

// The short horizon pays back the early City but ends before the delayed
// Factory completes. Over the long horizon, the higher-throughput Factory
// repays its cost and becomes the better investment.
const horizonCandidates = [
  {
    type: "City",
    action: "build",
    cost: asPositiveCost(cityIncome, 50),
    completionTicks: 0,
    shortIncomePerTick: cityIncome,
    longIncomePerTick: cityIncome,
  },
  {
    type: "Factory",
    action: "build",
    cost: asPositiveCost(newFactoryIncome, 30),
    completionTicks: 80,
    shortIncomePerTick: newFactoryIncome,
    longIncomePerTick: newFactoryIncome,
  },
];
const shortPortfolio = rankEconomicInvestmentCandidates(horizonCandidates, {
  gold: 1_000_000_000n,
  shortHorizonTicks: 100,
  longHorizonTicks: 100,
});
const longPortfolio = rankEconomicInvestmentCandidates(horizonCandidates, {
  gold: 1_000_000_000n,
  shortHorizonTicks: 500,
  longHorizonTicks: 500,
});
assert.equal(shortPortfolio[0].type, "City");
assert.equal(longPortfolio[0].type, "Factory");
assert.ok(
  longPortfolio[0].longNet > shortPortfolio[0].longNet,
  "additional time after Factory completion makes the long-horizon investment pay",
);

// A pending trade endpoint must not turn an isolated Factory into an apparent
// investment. Once the allied Port is complete, the same Factory has measured
// marginal income and can be ranked.
const incompleteOnly = completedTradeSnapshot([
  { id: "factory-unserved", type: "Factory", relation: "self", level: 1, complete: true },
  { id: "unfinished-port", type: "Port", relation: "ally", complete: false },
]);
const noCompletedEndpoint = expectedRailIncomePerTick({
  adjacency: rail,
  ...incompleteOnly,
  candidate: {
    id: "unserved-new-factory",
    type: "Factory",
    owner: "self",
    level: 1,
  },
}).totalIncomePerTick;
assert.equal(noCompletedEndpoint, 0);
const noEndpointPortfolio = rankEconomicInvestmentCandidates(
  [
    {
      type: "Factory",
      action: "build",
      cost: 100n,
      marginalGoldPerTick: noCompletedEndpoint,
    },
  ],
  { gold: 1_000n, shortHorizonTicks: 500, longHorizonTicks: 500 },
);
assert.equal(noEndpointPortfolio[0].action, "wait");

// Upgrades are priced against their incremental output, not the entire output
// of the level-two Factory. The cheaper upgrade wins this isolated portfolio.
const upgradePortfolio = rankEconomicInvestmentCandidates(
  [
    {
      type: "Factory",
      action: "upgrade",
      structureId: "factory-ally",
      cost: asPositiveCost(upgradeIncome, 10),
      marginalGoldPerTick: upgradeIncome,
    },
    {
      type: "Factory",
      action: "build",
      structureId: "new-factory",
      cost: asPositiveCost(newFactoryIncome, 100),
      marginalGoldPerTick: newFactoryIncome,
    },
  ],
  { gold: 1_000_000_000n, shortHorizonTicks: 500, longHorizonTicks: 500 },
);
assert.equal(upgradePortfolio[0].action, "upgrade");
assert.equal(upgradePortfolio[0].structureId, "factory-ally");

// A project that completes after the whole available horizon is an explicit
// wait, while a delayed project with positive long-horizon payback remains in
// the portfolio even though it produces nothing in the short window.
const afterHorizon = rankEconomicInvestmentCandidates(
  [{ type: "Port", action: "build", cost: 100n, completionTicks: 101, marginalGoldPerTick: 10 }],
  { gold: 1_000n, shortHorizonTicks: 100, longHorizonTicks: 100 },
);
assert.equal(afterHorizon[0].action, "wait");
const delayedInvestment = rankEconomicInvestmentCandidates(
  [{ type: "Port", action: "build", cost: 100n, completionTicks: 100, marginalGoldPerTick: 2 }],
  { gold: 1_000n, shortHorizonTicks: 50, longHorizonTicks: 200 },
);
assert.equal(delayedInvestment[0].action, "build");
assert.equal(delayedInvestment[0].shortPayoff, 0);
assert.equal(delayedInvestment[0].shortNet, -100);
assert.equal(delayedInvestment[0].longNet, 100);

const horizonOnlyReturn = [
  {
    type: "Factory",
    action: "build",
    cost: 100n,
    shortIncomePerTick: 0,
    longIncomePerTick: 2,
  },
];
const shortWeightedWait = rankEconomicInvestmentCandidates(horizonOnlyReturn, {
  gold: 1_000n,
  shortHorizonTicks: 50,
  longHorizonTicks: 200,
  shortWeight: 1,
});
assert.equal(shortWeightedWait[0].action, "wait");
const longWeightedBuild = rankEconomicInvestmentCandidates(horizonOnlyReturn, {
  gold: 1_000n,
  shortHorizonTicks: 50,
  longHorizonTicks: 200,
  shortWeight: 0,
});
assert.equal(longWeightedBuild[0].action, "build");
assert.ok(longWeightedBuild[0].longNet > 0);

const invalidInputsWait = rankEconomicInvestmentCandidates(
  [
    { type: "City", cost: 1n, marginalGoldPerTick: 100 },
    { type: "Port", cost: 1n, completionTicks: Infinity, marginalGoldPerTick: 100 },
    { type: "Factory", cost: -1n, marginalGoldPerTick: 100 },
  ],
  { gold: 1_000n, reserve: -1n, shortHorizonTicks: 100, longHorizonTicks: 100 },
);
assert.equal(
  invalidInputsWait[0].action,
  "wait",
  "invalid reserve or candidate cost/completion data fails closed",
);
const missingCostWait = rankEconomicInvestmentCandidates(
  [{ type: "City", marginalGoldPerTick: 100 }],
  { gold: 1_000n, shortHorizonTicks: 100, longHorizonTicks: 100 },
);
assert.equal(missingCostWait[0].action, "wait");

const tiedInvestments = [
  {
    type: "Factory",
    action: "build",
    structureId: "zeta",
    tile: 70,
    cost: 100n,
    marginalGoldPerTick: 2,
  },
  {
    type: "Factory",
    action: "build",
    structureId: "alpha",
    tile: 20,
    cost: 100n,
    marginalGoldPerTick: 2,
  },
];
const tieOptions = {
  gold: 1_000n,
  shortHorizonTicks: 100,
  longHorizonTicks: 100,
};
const tiedForward = rankEconomicInvestmentCandidates(tiedInvestments, tieOptions);
const tiedReverse = rankEconomicInvestmentCandidates(tiedInvestments.slice().reverse(), tieOptions);
assert.deepEqual(
  Array.from(tiedForward, ({ structureId, tile }) => [structureId, tile]),
  Array.from(tiedReverse, ({ structureId, tile }) => [structureId, tile]),
  "equal-score actions keep a stable canonical order regardless of input order",
);
assert.deepEqual(
  Array.from(tiedForward, ({ structureId }) => structureId),
  ["alpha", "zeta"],
);

// Exact BigInt affordability keeps a one-gold shortfall unaffordable above
// Number.MAX_SAFE_INTEGER, even when Number() would round both values alike.
const exactAffordable = rankEconomicInvestmentCandidates(
  [
    {
      type: "Factory",
      structureId: "one-gold-too-expensive",
      cost: 9_007_199_254_740_993n,
      marginalGoldPerTick: 1e16,
    },
    {
      type: "City",
      structureId: "fits-reserve",
      cost: 9_007_199_254_740_992n,
      marginalGoldPerTick: 1e16,
    },
  ],
  {
    gold: 9_007_199_254_740_994n,
    reserve: 2n,
    shortHorizonTicks: 10,
    longHorizonTicks: 10,
  },
);
assert.deepEqual(
  Array.from(exactAffordable, ({ structureId }) => structureId),
  ["fits-reserve"],
  "gold and reserve are compared as exact BigInts before ranking",
);

const safeAndExposed = rankEconomicInvestmentCandidates(
  [
    {
      type: "Port",
      structureId: "exposed",
      cost: 100n,
      marginalGoldPerTick: 2,
      survivalFactor: 0.1,
      capacityValue: 0,
    },
    {
      type: "City",
      structureId: "safe",
      cost: 100n,
      marginalGoldPerTick: 2,
      survivalFactor: 1,
    },
  ],
  { gold: 1_000n, shortHorizonTicks: 100, longHorizonTicks: 100 },
);
assert.equal(safeAndExposed[0].structureId, "safe");
assert.ok(
  !safeAndExposed.some(({ structureId }) => structureId === "exposed"),
  "a threatened structure whose survival-adjusted payoff misses payback is excluded",
);
const threatenedCapacityDoesNotEscapeRisk = rankEconomicInvestmentCandidates(
  [
    {
      type: "City",
      cost: 100n,
      marginalGoldPerTick: 0,
      survivalFactor: 0,
      capacityValue: 1_000_000,
    },
  ],
  { gold: 1_000n, shortHorizonTicks: 100, longHorizonTicks: 100 },
);
assert.equal(
  threatenedCapacityDoesNotEscapeRisk[0].action,
  "wait",
  "a fully exposed asset cannot escape the risk gate through cap-value credit",
);

const mutableCandidates = [{ type: "Port", action: "build", cost: 1n, marginalGoldPerTick: 1 }];
const mutableCandidatesBefore = mutableCandidates.map((candidate) => ({ ...candidate }));
const immutableResult = rankEconomicInvestmentCandidates(mutableCandidates, {
  gold: 10n,
  shortHorizonTicks: 20,
  longHorizonTicks: 20,
});
assert.deepEqual(mutableCandidates, mutableCandidatesBefore);
assert.notStrictEqual(immutableResult[0], mutableCandidates[0]);

// Exercise the production snapshot and candidate-generation methods against a
// bounded synthetic player state. This fixture verifies that completed
// tradeable endpoints and own Factory levels reach the ranker as measured
// inputs, rather than supplying hand-written candidate payoffs.
const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  Warship: "Warship",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
  TransportShip: "Transport Ship",
  TradeShip: "Trade Ship",
};
const structureSandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { FFA: "FFA", Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  state: { settings: { winFixes: true, buildStructures: {} }, stats: { builds: 0 } },
  currentDifficulty: () => "Legendary",
  isLegendaryDifficulty: () => true,
  isAtLeastHardDifficulty: () => true,
  autoBotBuildAllowed: () => true,
  getBuildMenu: () => null,
  sendAutoBotBuildOrUpgrade: () => false,
  setLastAction: () => {},
  tr: (value) => value,
  profileStructureSync: (_profile, _name, callback) => callback(),
  profileStructureAsync: async (_profile, _name, callback) => callback(),
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
  captureRuntimeException: () => {},
  runtimeDebugLog: () => {},
  BigInt,
  Math,
  Number,
  isFinite,
  isNaN,
  Array,
  Object,
  Map,
  Set,
  Date,
  JSON,
  Error,
  Reflect,
  Symbol,
  Promise,
  performance: { now: () => 0 },
  console,
  Infinity,
  NaN,
  undefined,
};
structureSandbox.globalThis = structureSandbox;
structureSandbox.window = structureSandbox;
const structureSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/structureBehavior.js"),
  "utf8",
);
executeClassicScript(
  `${plannerSource}\n${structureSource}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  structureSandbox,
  { filename: "economy-investment-policy.vm.js" },
);

let nextTile = 1;
function makeTradeUnit(type, { complete = true, level = 1, tile = nextTile++ } = {}) {
  return {
    type: () => type,
    level: () => level,
    tile: () => tile,
    isUnderConstruction: () => !complete,
  };
}

let nextPlayerId = 1;
function makeNeighbor(relation, units, { tradeable = true } = {}) {
  const id = nextPlayerId++;
  return {
    smallID: () => id,
    id: () => id,
    relation,
    tradeable,
    hasEmbargoAgainst: () => false,
    isPlayer: () => true,
    type: () => "Human",
    units(...types) {
      return units.filter((unit) => types.includes(unit.type()));
    },
  };
}

function makeInvestmentBehavior({ ownUnits = [], nearby = [], tick = 100 } = {}) {
  let currentTick = tick;
  let nearbyReads = 0;
  let unitReads = 0;
  const playerId = nextPlayerId++;
  const player = {
    smallID: () => playerId,
    id: () => playerId,
    hasEmbargoAgainst: () => false,
    units(...types) {
      unitReads++;
      return ownUnits.filter((unit) => types.includes(unit.type()));
    },
    nearby() {
      nearbyReads++;
      return nearby;
    },
    isAlliedWith: (owner) => owner.relation === "ally",
    isOnSameTeam: (owner) => owner.relation === "team",
  };
  const behavior = Object.create(structureSandbox.__StructureBehavior.prototype);
  behavior.game = {
    ticks: () => currentTick,
    euclideanDistSquared: (left, right) => (left - right) ** 2,
    config: () => ({ trainStationMaxRange: () => 110 }),
  };
  behavior.player = player;
  behavior._economicInvestmentSummaryTick = null;
  behavior._economicInvestmentSummary = null;
  behavior._economicInvestmentWaitTick = null;
  behavior.isTradeableStationNeighbor = (owner) => owner.tradeable === true;
  behavior.getConstructionCost = (type) =>
    ({ [UNIT.Factory]: 100n, [UNIT.City]: 100n, [UNIT.Port]: 100n })[type] ?? 100n;
  behavior.availableGoldAfterReserve = () => 1_000_000n;
  behavior.spendableConstructionGold = () => 1_000_000n;
  behavior.legendaryConstructionDuration = () => 0;
  return {
    behavior,
    player,
    readCounts: () => ({ nearbyReads, unitReads }),
    setTick(value) {
      currentTick = value;
    },
  };
}

function makePortInvestmentDecisionFixture(partnerRelation, { cachedShipCount = 0 } = {}) {
  const ownCities = Array.from({ length: 5 }, (_, index) =>
    makeTradeUnit(UNIT.City, { tile: index }),
  );
  const partner = makeNeighbor(partnerRelation, [makeTradeUnit(UNIT.Port, { tile: 1_000 })]);
  const fixture = makeInvestmentBehavior({ ownUnits: ownCities, nearby: [partner] });
  const { behavior, player } = fixture;
  let globalUnitReads = 0;
  const config = {
    isUnitDisabled: () => false,
    unitInfo: (type) => ({ constructionDuration: type === UNIT.Port ? 50 : 20 }),
    trainStationMaxRange: () => 110,
    tradeShipSpawnRate: () => 100,
    tradeShipShortRangeDebuff: () => 200,
  };
  behavior.game = {
    ticks: () => 100,
    config: () => config,
    players: () => [player, partner],
    cachedUnitCount: () => cachedShipCount,
    units: () => {
      globalUnitReads++;
      return [];
    },
    manhattanDist: (left, right) => Math.abs(left - right),
    euclideanDistSquared: (left, right) => (left - right) ** 2,
  };
  behavior.isOceanPortTile = (tile) => tile === 0 || tile === 1_000;
  behavior.troopCapPressure = () => false;
  behavior.getConstructionCost = (type) =>
    ({ [UNIT.Factory]: 125_000n, [UNIT.Port]: 125_000n, [UNIT.City]: 1_000_000n })[type] ??
    125_000n;
  behavior.availableGoldAfterReserve = () => 125_000n;
  behavior.spendableConstructionGold = () => 125_000n;
  const built = [];
  behavior.maybeSpawnStructure = async (type) => {
    built.push(type);
    return true;
  };
  return { behavior, partner, built, config, globalUnitReads: () => globalUnitReads };
}

const snapshotFixture = makeInvestmentBehavior({
  ownUnits: [
    makeTradeUnit(UNIT.Factory),
    makeTradeUnit(UNIT.Factory, { complete: false, level: 3 }),
    makeTradeUnit(UNIT.City),
    makeTradeUnit(UNIT.Port, { complete: false }),
  ],
  nearby: [
    makeNeighbor("ally", [makeTradeUnit(UNIT.Port), makeTradeUnit(UNIT.City, { complete: false })]),
    makeNeighbor("team", [makeTradeUnit(UNIT.Port)]),
    makeNeighbor("other", [makeTradeUnit(UNIT.City)]),
    makeNeighbor("hostile", [makeTradeUnit(UNIT.City)], { tradeable: false }),
  ],
});
const summary = snapshotFixture.behavior.getEconomicInvestmentSummary();
assert.equal(summary.tick, 100);
assert.equal(summary.factoryCount, 1, "unfinished Factories do not inflate completed output");
assert.equal(
  summary.factoryLevels,
  1,
  "only completed Factory levels enter the production snapshot",
);
assert.equal(summary.completedDestinationCount, 4);
assert.equal(summary.maxDestinationGold, 35_000);
assert.equal(summary.maxRivalSpilloverGold, 25_000);
const initialReadCounts = snapshotFixture.readCounts();
assert.strictEqual(
  snapshotFixture.behavior.getEconomicInvestmentSummary(),
  summary,
  "the economic summary is reused throughout one game tick",
);
assert.deepEqual(snapshotFixture.readCounts(), initialReadCounts);
snapshotFixture.setTick(101);
assert.equal(snapshotFixture.behavior.getEconomicInvestmentSummary().tick, 101);
assert.equal(
  snapshotFixture.readCounts().nearbyReads,
  initialReadCounts.nearbyReads + 1,
  "a new tick refreshes the nearby station snapshot once",
);

const integratedContext = {
  config: { isUnitDisabled: () => false },
  citiesDisabled: false,
  cityCount: 2,
  hasCoastalTiles: true,
  hasOceanPortTiles: true,
};
const eligibleFixture = makeInvestmentBehavior({
  ownUnits: [makeTradeUnit(UNIT.Factory), makeTradeUnit(UNIT.City)],
  nearby: [
    makeNeighbor("ally", [makeTradeUnit(UNIT.Port)]),
    makeNeighbor("team", [makeTradeUnit(UNIT.Port)]),
    makeNeighbor("other", [makeTradeUnit(UNIT.City)]),
  ],
});
const eligibleSummary = eligibleFixture.behavior.getEconomicInvestmentSummary();
const integratedCandidates = eligibleFixture.behavior.economicInvestmentCandidates(
  integratedContext,
  { types: [UNIT.Factory, UNIT.Port, UNIT.City, UNIT.Factory], summary: eligibleSummary },
);
assert.equal(integratedCandidates.length, 3, "only Factory, Port, and City are evaluated");
assert.ok(
  integratedCandidates.every((candidate) => candidate.sourceSummaryTick === eligibleSummary.tick),
);
assert.ok(
  integratedCandidates.find(({ type }) => type === UNIT.Factory).longIncomePerTick > 0,
  "nearby completed trade endpoints create a positive Factory estimate",
);
const integratedRanked = eligibleFixture.behavior.rankEconomicInvestments(integratedContext, {
  types: [UNIT.Factory, UNIT.Port, UNIT.City],
  shortHorizonTicks: 1_000,
  longHorizonTicks: 1_000,
});
assert.ok(integratedRanked.some(({ type }) => type === UNIT.Factory));

function factoryInvestmentForSnapshot({ ownUnits, nearby = [] }) {
  const fixture = makeInvestmentBehavior({ ownUnits, nearby });
  const behavior = fixture.behavior;
  const summary = behavior.getEconomicInvestmentSummary();
  const candidate = behavior.economicInvestmentCandidates(
    {},
    { types: [UNIT.Factory], summary },
  )[0];
  return { summary, candidate };
}

const ownEndpoint = factoryInvestmentForSnapshot({
  ownUnits: [makeTradeUnit(UNIT.Factory), makeTradeUnit(UNIT.City)],
});
const teamEndpoint = factoryInvestmentForSnapshot({
  ownUnits: [makeTradeUnit(UNIT.Factory)],
  nearby: [makeNeighbor("team", [makeTradeUnit(UNIT.Port)])],
});
const allyEndpoint = factoryInvestmentForSnapshot({
  ownUnits: [makeTradeUnit(UNIT.Factory)],
  nearby: [makeNeighbor("ally", [makeTradeUnit(UNIT.Port)])],
});
assert.ok(
  teamEndpoint.candidate.longIncomePerTick > allyEndpoint.candidate.longIncomePerTick &&
    allyEndpoint.candidate.longIncomePerTick > ownEndpoint.candidate.longIncomePerTick,
  "the production snapshot prices self, allied, and team receipts at their distinct values",
);
const teamMarginalFactor =
  teamEndpoint.summary.marginalFactoryOutputPerTick * teamEndpoint.summary.routeConfidence;
assert.equal(teamEndpoint.candidate.ownIncomePerTick, 25_000 * teamMarginalFactor);
assert.equal(teamEndpoint.candidate.teamIncomePerTick, 25_000 * teamMarginalFactor);
assert.equal(
  teamEndpoint.candidate.longIncomePerTick,
  teamEndpoint.candidate.ownIncomePerTick + teamEndpoint.candidate.teamIncomePerTick,
  "team-side payout adds a matching teammate receipt while keeping own income separately measured",
);

const farAllyEndpoint = factoryInvestmentForSnapshot({
  ownUnits: [makeTradeUnit(UNIT.Factory, { tile: 1 })],
  nearby: [makeNeighbor("ally", [makeTradeUnit(UNIT.Port, { tile: 10_000 })])],
});
assert.equal(farAllyEndpoint.summary.completedDestinationCount, 1);
assert.equal(farAllyEndpoint.summary.localDestinationCount, 0);
assert.equal(
  farAllyEndpoint.candidate.longIncomePerTick,
  0,
  "a distant tradeable endpoint contributes no local route forecast",
);

const noTradeFixture = makeInvestmentBehavior({
  ownUnits: [makeTradeUnit(UNIT.Factory), makeTradeUnit(UNIT.City, { complete: false })],
});
const noTradeSummary = noTradeFixture.behavior.getEconomicInvestmentSummary();
assert.equal(noTradeSummary.completedDestinationCount, 0);
const noTradeRanked = noTradeFixture.behavior.rankEconomicInvestments(
  {},
  {
    types: [UNIT.Factory, UNIT.Port, UNIT.City],
    shortHorizonTicks: 500,
    longHorizonTicks: 500,
  },
);
assert.equal(
  noTradeRanked[0].action,
  "wait",
  "incomplete endpoints do not authorize a Factory investment without return",
);
const noForecastBuilds = [];
noTradeFixture.behavior.troopCapPressure = () => false;
noTradeFixture.behavior.economicStructureTypeEligible = () => true;
noTradeFixture.behavior.maybeSpawnStructure = async (type) => {
  noForecastBuilds.push(type);
  return true;
};
assert.equal(await noTradeFixture.behavior.maybePrioritizeEconomicGrowth(integratedContext), true);
assert.equal(
  noForecastBuilds[0],
  UNIT.Factory,
  "an unproductive forecast leaves the ordinary economic build order available",
);

const boundedFixture = makeInvestmentBehavior({
  ownUnits: [
    makeTradeUnit(UNIT.Factory),
    ...Array.from({ length: 70 }, () => makeTradeUnit(UNIT.City)),
  ],
  nearby: [
    makeNeighbor(
      "ally",
      Array.from({ length: 70 }, () => makeTradeUnit(UNIT.City)),
    ),
  ],
});
const boundedSummary = boundedFixture.behavior.getEconomicInvestmentSummary();
assert.equal(boundedSummary.sampledDestinationCount, 64);
assert.ok(boundedSummary.localDestinationCount <= 64);
assert.equal(
  boundedFixture.behavior.economicInvestmentCandidates(
    {},
    { types: [UNIT.Factory, UNIT.Port, UNIT.City, UNIT.Factory] },
  ).length,
  3,
  "candidate generation evaluates at most the three distinct economic types",
);

// Keep the original non-ranked order for winFixes:false, and let border threat
// or troop-cap pressure keep the City-first safety lane ahead of investments.
const fallbackBehavior = Object.create(structureSandbox.__StructureBehavior.prototype);
fallbackBehavior.troopCapPressure = () => false;
fallbackBehavior.economicStructureTypeEligible = () => true;
fallbackBehavior.rankEconomicInvestments = () => {
  throw new Error("the disabled ranking lane must not be called");
};
const fallbackBuilds = [];
fallbackBehavior.maybeSpawnStructure = async (type) => {
  fallbackBuilds.push(type);
  return true;
};
structureSandbox.state.settings.winFixes = false;
assert.equal(await fallbackBehavior.maybePrioritizeEconomicGrowth(integratedContext), true);
assert.equal(
  fallbackBuilds[0],
  UNIT.Factory,
  "winFixes:false preserves the existing Factory-first order",
);

structureSandbox.state.settings.winFixes = true;
fallbackBuilds.length = 0;
fallbackBehavior.troopCapPressure = () => false;
fallbackBehavior.economicStructureTypeEligible = () => true;
assert.equal(
  await fallbackBehavior.maybePrioritizeEconomicGrowth({
    ...integratedContext,
    prioritizeCityForBorderThreat: true,
  }),
  true,
);
assert.equal(
  fallbackBuilds[0],
  UNIT.City,
  "a hostile-border priority stays ahead of ranked economy",
);
fallbackBuilds.length = 0;
fallbackBehavior.troopCapPressure = () => true;
assert.equal(await fallbackBehavior.maybePrioritizeEconomicGrowth(integratedContext), true);
assert.equal(
  fallbackBuilds[0],
  UNIT.City,
  "troop-cap pressure keeps City cap relief ahead of ranked economy",
);

// Full live decision fixture: five Cities, no Factory/Port, exactly enough
// gold for either candidate, and a distant foreign Port that is excluded from
// the local rail proxy but still informs the bounded ocean-trade estimate.
const decisionContext = (config) => ({
  config,
  citiesDisabled: false,
  cityCount: 5,
  hasCoastalTiles: false,
  hasOceanPortTiles: true,
});
structureSandbox.state.settings.winFixes = true;
const teamPortFixture = makePortInvestmentDecisionFixture("team");
const teamPortContext = decisionContext(teamPortFixture.config);
const teamPortSummary = teamPortFixture.behavior.getEconomicInvestmentSummary();
assert.equal(teamPortSummary.localDestinationCount, 5);
assert.equal(teamPortSummary.portTradePartnerLevels, 1);
assert.ok(Math.abs(teamPortSummary.portTradeIncomePerTick - 62.5) < 1e-6);
assert.ok(Math.abs(teamPortSummary.portTeamIncomePerTick - 62.5) < 1e-6);
const teamPortCandidates = teamPortFixture.behavior.economicInvestmentCandidates(teamPortContext, {
  types: [UNIT.Factory, UNIT.Port],
  summary: teamPortSummary,
});
const teamPortCandidate = teamPortCandidates.find(({ type }) => type === UNIT.Port);
const teamFactoryCandidate = teamPortCandidates.find(({ type }) => type === UNIT.Factory);
assert.ok(Math.abs(teamFactoryCandidate.longIncomePerTick - 28.75) < 0.1);
assert.equal(teamPortCandidate.completionTicks, 1_050);
assert.ok(Math.abs(teamPortCandidate.ownIncomePerTick - 62.5) < 1e-6);
assert.ok(Math.abs(teamPortCandidate.teamIncomePerTick - 62.5) < 1e-6);
assert.ok(Math.abs(teamPortCandidate.longIncomePerTick - 125) < 1e-6);
assert.equal(
  teamPortFixture.behavior.economicGrowthBuildOrder(teamPortContext, false)[0],
  UNIT.Port,
  "a team's matching payout makes a delayed Port the top 6,000-tick investment",
);
assert.equal(await teamPortFixture.behavior.maybePrioritizeEconomicGrowth(teamPortContext), true);
assert.equal(teamPortFixture.built[0], UNIT.Port);

const rivalPortFixture = makePortInvestmentDecisionFixture("other");
const rivalPortContext = decisionContext(rivalPortFixture.config);
const rivalPortSummary = rivalPortFixture.behavior.getEconomicInvestmentSummary();
const rivalPortCandidate = rivalPortFixture.behavior
  .economicInvestmentCandidates(rivalPortContext, {
    types: [UNIT.Factory, UNIT.Port],
    summary: rivalPortSummary,
  })
  .find(({ type }) => type === UNIT.Port);
assert.ok(Math.abs(rivalPortSummary.portTradeIncomePerTick - 62.5) < 1e-6);
assert.ok(Math.abs(rivalPortSummary.portRivalSpilloverPerTick - 62.5) < 1e-6);
assert.ok(Math.abs(rivalPortCandidate.ownIncomePerTick - 62.5) < 1e-6);
assert.ok(Math.abs(rivalPortCandidate.rivalIncomePerTick - 62.5) < 1e-6);
assert.ok(Math.abs(rivalPortCandidate.longIncomePerTick - 31.25) < 1e-6);
const rivalPortOnlyRank = rankEconomicInvestmentCandidates([rivalPortCandidate], {
  gold: 125_000n,
  shortHorizonTicks: 300,
  longHorizonTicks: 6_000,
  shortWeight: 0.4,
});
assert.equal(rivalPortOnlyRank[0].action, "wait");
const rivalPortLongOnlyRank = rankEconomicInvestmentCandidates([rivalPortCandidate], {
  gold: 125_000n,
  shortHorizonTicks: 300,
  longHorizonTicks: 6_000,
  shortWeight: 0,
});
assert.equal(rivalPortLongOnlyRank[0].action, "build");
assert.ok(rivalPortLongOnlyRank[0].longNet > 0);
assert.equal(
  rivalPortFixture.behavior.economicGrowthBuildOrder(rivalPortContext, false)[0],
  UNIT.Factory,
  "the rival payout discount makes the delayed Port miss weighted payback and restores Factory-first fallback",
);
assert.equal(await rivalPortFixture.behavior.maybePrioritizeEconomicGrowth(rivalPortContext), true);
assert.equal(rivalPortFixture.built[0], UNIT.Factory);

const unknownShipCacheFixture = makePortInvestmentDecisionFixture("team", {
  cachedShipCount: null,
});
const unknownShipCacheContext = decisionContext(unknownShipCacheFixture.config);
const unknownShipCacheSummary = unknownShipCacheFixture.behavior.getEconomicInvestmentSummary();
assert.equal(unknownShipCacheSummary.portTradePartnerLevels, 0);
assert.equal(unknownShipCacheSummary.portTradeIncomePerTick, 0);
assert.equal(
  unknownShipCacheFixture.globalUnitReads(),
  0,
  "unknown ship-count cache does not trigger a global unit-family scan",
);
assert.equal(
  unknownShipCacheFixture.behavior.economicGrowthBuildOrder(unknownShipCacheContext, false)[0],
  UNIT.Factory,
  "unknown congestion keeps the ordinary Factory-first construction order",
);
assert.equal(
  await unknownShipCacheFixture.behavior.maybePrioritizeEconomicGrowth(unknownShipCacheContext),
  true,
);
assert.equal(unknownShipCacheFixture.built[0], UNIT.Factory);
assert.equal(unknownShipCacheFixture.globalUnitReads(), 0);

const cityPriorityBehavior = Object.create(structureSandbox.__StructureBehavior.prototype);
cityPriorityBehavior.addLegendaryConstructionCandidate = (context, type, values) => {
  context.candidates.push({ type, ...values });
};
const cityCandidates = { candidates: [] };
cityPriorityBehavior.addLegendaryCityCandidates(cityCandidates, {
  citiesDisabled: false,
  cityCount: 1,
  capPressure: false,
  strategicState: { railNeed: 1 },
});
assert.equal(cityCandidates.candidates[0].type, UNIT.City);
assert.equal(
  cityCandidates.candidates[0].mandatory,
  1,
  "the required second City remains mandatory in Legendary construction",
);
cityPriorityBehavior.legendaryCityUpgradeCandidateInfo = () => ({
  structureId: "cap-city",
  cost: 2n,
});
const capUpgradeCandidates = { candidates: [] };
cityPriorityBehavior.addLegendaryCityCandidates(capUpgradeCandidates, {
  citiesDisabled: false,
  cityCount: 2,
  capPressure: true,
  strategicState: { railNeed: 0 },
});
assert.equal(capUpgradeCandidates.candidates.length, 2);
assert.equal(capUpgradeCandidates.candidates[1].action, "upgrade");
assert.equal(
  capUpgradeCandidates.candidates[1].upgradeStructureId,
  "cap-city",
  "the cap-pressure City upgrade remains an explicit Legendary candidate",
);

process.stdout.write("economy investment policy tests passed\n");
