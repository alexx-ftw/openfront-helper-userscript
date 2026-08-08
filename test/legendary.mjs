import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const plannerSandbox = {};
executeClassicScript(read("engine/ingame/auto-bot/legendaryPlanner.js"), plannerSandbox, {
  filename: "legendaryPlanner.js",
});

assert.equal(
  typeof plannerSandbox.rankLegendaryConstructionCandidates,
  "function",
  "Legendary planner exposes its candidate ranking function",
);
assert.equal(
  typeof plannerSandbox.rankLegendaryConstructionActions,
  "function",
  "Legendary planner exposes build and wait actions through one portfolio rank",
);
assert.equal(
  typeof plannerSandbox.legendaryAllyPowerScore,
  "function",
  "Legendary exposes the ally-power normalizer used by placement",
);
assert.equal(
  typeof plannerSandbox.legendaryPlacementProximityScore,
  "function",
  "Legendary exposes the distance normalizer used by placement",
);

const weakAllyPower = plannerSandbox.legendaryAllyPowerScore({
  allyTroops: 1_000,
  allyGold: 1_000n,
  allyProduction: 2,
  ownTroops: 10_000,
  ownGold: 10_000n,
  ownProduction: 10,
});
const strongAllyPower = plannerSandbox.legendaryAllyPowerScore({
  allyTroops: 50_000,
  allyGold: 50_000n,
  allyProduction: 30,
  ownTroops: 10_000,
  ownGold: 10_000n,
  ownProduction: 10,
});
assert.ok(
  strongAllyPower > weakAllyPower,
  "Legendary ranks allies by their strongest relative troop, gold, or gold-production axis",
);
assert.ok(
  plannerSandbox.legendaryPlacementProximityScore(2, 10) >
    plannerSandbox.legendaryPlacementProximityScore(20, 10),
  "Legendary gives closer allies more placement support",
);

const ranked = plannerSandbox.rankLegendaryConstructionCandidates(
  [
    {
      type: "City",
      mandatory: 0,
      safety: 0,
      strategic: 0,
      gold: 6,
      troops: 6,
      defense: 0,
      deficit: 2,
      efficiency: 1,
      cost: 500n,
    },
    {
      type: "SAM Launcher",
      mandatory: 1,
      safety: 2,
      gold: 1,
      troops: 1,
      defense: 10,
      strategic: 0,
      deficit: 1,
      efficiency: 1,
      cost: 500n,
    },
    {
      type: "Port",
      mandatory: 0,
      safety: 0,
      gold: 4,
      troops: 2,
      defense: 1,
      strategic: 0,
      deficit: 2,
      efficiency: 1,
      cost: 300n,
    },
    {
      type: "Gold Factory",
      mandatory: 0,
      safety: 0,
      gold: 10,
      troops: 0,
      defense: 0,
      strategic: 0,
      deficit: 2,
      efficiency: 1,
      cost: 300n,
    },
    {
      type: "Factory",
      mandatory: 0,
      safety: 0,
      gold: 2,
      troops: 2,
      defense: 1,
      strategic: 2,
      deficit: 1,
      efficiency: 1,
      cost: 900n,
    },
    { type: "Illegal", legal: false, cost: 1n },
  ],
  { gold: 1_000n, reserve: 200n },
);

assert.deepEqual(
  ranked.map((candidate) => candidate.type),
  ["SAM Launcher", "City", "Port", "Gold Factory"],
  "Legendary balances gold and troops first; missile defense is secondary",
);

const waitForDominatingCity = plannerSandbox.rankLegendaryConstructionActions(
  [
    { type: "Factory", cost: 500n, gold: 1, troops: 1, defense: 1 },
    { type: "City", cost: 1_000n, gold: 3, troops: 5, defense: 1 },
  ],
  { gold: 800n },
);
assert.equal(waitForDominatingCity[0].action, "wait");
assert.equal(waitForDominatingCity[0].targetType, "City");
assert.equal(waitForDominatingCity[0].shortfall, 200n);

const buildWithoutMaterialDelay = plannerSandbox.rankLegendaryConstructionActions(
  [
    { type: "Factory", cost: 100n, gold: 1, troops: 1, defense: 1 },
    { type: "City", cost: 1_000n, gold: 3, troops: 5, defense: 1 },
  ],
  { gold: 800n },
);
assert.equal(
  buildWithoutMaterialDelay[0].type,
  "Factory",
  "an immediate asset remains preferred when its whole cost is smaller than the funding gap",
);

const waitWhenNothingIsAffordable = plannerSandbox.rankLegendaryConstructionActions(
  [{ type: "City", cost: 1_000n, gold: 3, troops: 5, defense: 1 }],
  { gold: 800n },
);
assert.equal(waitWhenNothingIsAffordable[0].action, "wait");

assert.equal(
  plannerSandbox.chooseLegendaryConstructionCandidate(
    [{ type: "Factory", cost: 900n, mandatory: 1 }],
    { gold: 1_000n, reserve: 200n },
  ),
  null,
  "Legendary holds the strategic reserve instead of spending through it",
);

const connectedCity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 0,
  cityRailConnection: 1,
});
const saturatedCity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 4,
  cityRailConnection: 1,
});
assert.ok(
  connectedCity.gold > saturatedCity.gold,
  "City gold contribution has diminishing returns on a connected rail network",
);
const silo = plannerSandbox.legendaryConstructionObjectiveVector("Missile Silo", {
  targetPressure: 2,
});
const sam = plannerSandbox.legendaryConstructionObjectiveVector("SAM Launcher", {
  defenseGap: 2,
});
const port = plannerSandbox.legendaryConstructionObjectiveVector("Port", {
  tradeNeed: 2,
  destroyerNeed: 2,
});
assert.ok("gold" in connectedCity && "troops" in connectedCity, "City exposes a production vector");
assert.ok(silo.gold > 0 && silo.troops > 0, "Silo remains costed in the production model");
assert.ok(sam.defense > sam.gold, "SAM is a defensive guardrail, not a production axis");
assert.ok(
  port.gold > 0 && port.troops > 0 && port.defense > 0,
  "Port contributes to trading while carrying a defensive risk",
);

const safeMissileThreat = plannerSandbox.legendaryMissileThreatScore({
  enemySilos: [{ level: 1 }],
  enemyGold: 500_000n,
  atomCost: 750_000n,
  hydrogenCost: 3_000_000n,
  flightTimeTicks: 120,
  vulnerableStructures: 1,
  vulnerableBlastArea: 1,
  hydrogenBlastArea: 100,
});
const criticalMissileThreat = plannerSandbox.legendaryMissileThreatScore({
  enemySilos: [{ level: 3 }, { level: 5 }],
  enemyGold: 30_000_000n,
  atomCost: 750_000n,
  hydrogenCost: 3_000_000n,
  flightTimeTicks: 5,
  vulnerableStructures: 12,
  vulnerableBlastArea: 100,
  hydrogenBlastArea: 100,
});
assert.ok(
  criticalMissileThreat.score > safeMissileThreat.score && criticalMissileThreat.critical,
  "Missile defense accounts for silo levels, enemy gold, flight time, and blast exposure",
);

const chainedSalvo = plannerSandbox.legendaryMissileSalvoRisk({
  atomArrivalTicks: [20, 21, 22],
  hydrogenArrivalTick: 23,
  interceptionCapacity: 2,
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  chainedSalvo.hydrogenGetsThrough,
  true,
  "Legendary models cheap atom bombs exhausting SAM capacity before hydrogen",
);
assert.equal(
  chainedSalvo.marginSatisfied,
  false,
  "Legendary preserves a five-tick (0.5s) impact margin",
);

const scheduledChain = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 21, samOptions: [{ samIndex: 0, interceptTicks: [11] }] },
    { weapon: "HydrogenBomb", impactTick: 22, samOptions: [{ samIndex: 0, interceptTicks: [12] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0, 0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
  completionTick: 0,
});
assert.equal(
  scheduledChain.uninterceptedCount,
  1,
  "Per-missile scheduling catches the hydrogen finisher after two ready SAM shots",
);
assert.equal(
  scheduledChain.fullyDefended,
  false,
  "A chained salvo is unsafe when any incoming missile has no assigned interceptor",
);

const actualWeaponLabels = plannerSandbox.legendaryMissileSalvoRisk({
  routes: [
    { weapon: "Atom Bomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "Atom Bomb", impactTick: 21, samOptions: [{ samIndex: 0, interceptTicks: [11] }] },
    {
      weapon: "Hydrogen Bomb",
      impactTick: 22,
      samOptions: [{ samIndex: 0, interceptTicks: [12] }],
    },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0, 0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  actualWeaponLabels.atomIntercepted,
  2,
  "Production weapon labels with spaces are normalized as atom bombs",
);
assert.equal(
  actualWeaponLabels.hydrogenGetsThrough,
  true,
  "Production hydrogen label is recognized as the finisher",
);

const sameTickOverload = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0, 0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  sameTickOverload.uninterceptedCount,
  1,
  "A single SAM cannot launch two interceptor missiles in the same engine tick",
);

const reloadTooSlow = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 100, samOptions: [{ samIndex: 0, interceptTicks: [90] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  reloadTooSlow.uninterceptedCount,
  1,
  "A SAM cannot fire again before its reload completes",
);

const reloadReady = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 110, samOptions: [{ samIndex: 0, interceptTicks: [100] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  reloadReady.fullyDefended,
  true,
  "A later missile can be defended once the SAM reload window has elapsed",
);

assert.equal(
  typeof plannerSandbox.legendaryDefenseActionImproves,
  "function",
  "Legendary exposes the incremental defense-action policy",
);
const lowLevelSalvoRoutes = [
  { weapon: "AtomBomb", impactTick: 120, samOptions: [{ samIndex: 0, interceptTicks: [100] }] },
  { weapon: "AtomBomb", impactTick: 121, samOptions: [{ samIndex: 0, interceptTicks: [101] }] },
  { weapon: "HydrogenBomb", impactTick: 122, samOptions: [{ samIndex: 0, interceptTicks: [102] }] },
];
const lowLevelDefense = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: lowLevelSalvoRoutes,
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
const oneLevelHigherDefense = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: lowLevelSalvoRoutes,
  samProfiles: [{ id: "sam-a", availableTicks: [0, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
const twoLevelsHigherDefense = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: lowLevelSalvoRoutes,
  samProfiles: [{ id: "sam-a", availableTicks: [0, 90, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(lowLevelDefense.fullyDefended, false);
assert.equal(oneLevelHigherDefense.fullyDefended, false);
assert.ok(
  oneLevelHigherDefense.uninterceptedCount < lowLevelDefense.uninterceptedCount,
  "a higher SAM level must reduce the unresolved part of a salvo even before full defense is reached",
);
assert.equal(
  twoLevelsHigherDefense.fullyDefended,
  true,
  "the next staged SAM upgrade must eventually cover the atom chain and Hydrogen finisher",
);
assert.equal(
  plannerSandbox.legendaryDefenseActionImproves(lowLevelDefense, oneLevelHigherDefense, 1, 1),
  true,
  "Legendary must accept a SAM upgrade that materially improves an unresolved salvo",
);
assert.equal(
  plannerSandbox.legendaryDefenseActionImproves(oneLevelHigherDefense, oneLevelHigherDefense, 2, 2),
  false,
  "Legendary must not repeat a SAM upgrade that adds no defensive value",
);

const upgradedSlotStillReloading = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "HydrogenBomb", impactTick: 80, samOptions: [{ samIndex: 0, interceptTicks: [70] }] },
  ],
  // The level-2 range is already available, but the added slot is still
  // reloading after a hypothetical instant upgrade.
  samProfiles: [{ id: "upgraded-sam", availableTicks: [0, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  upgradedSlotStillReloading.uninterceptedCount,
  1,
  "An upgraded SAM's added slot is not available before SAMCooldown elapses",
);

const upgradedSlotReloaded = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    {
      weapon: "HydrogenBomb",
      impactTick: 120,
      samOptions: [{ samIndex: 0, interceptTicks: [100] }],
    },
  ],
  samProfiles: [{ id: "upgraded-sam", availableTicks: [0, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  upgradedSlotReloaded.fullyDefended,
  true,
  "An upgraded SAM can use its new range and added slot after its reload",
);

const alternateAssignment = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      weapon: "AtomBomb",
      impactTick: 10,
      samOptions: [
        { samIndex: 0, interceptTicks: [0] },
        { samIndex: 1, interceptTicks: [0] },
      ],
    },
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 110, samOptions: [{ samIndex: 1, interceptTicks: [100] }] },
  ],
  samProfiles: [
    { id: "sam-a", availableTicks: [0] },
    { id: "sam-b", availableTicks: [0] },
  ],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  alternateAssignment.fullyDefended,
  true,
  "The planner backtracks when the first valid SAM assignment would consume a constrained slot",
);
assert.equal(
  alternateAssignment.scheduleMethod,
  "backtracking",
  "The exact fallback is observable in the schedule result",
);

const equivalentReadySlotRoutes = [
  {
    impactTick: 10,
    samOptions: [
      { samIndex: 0, interceptTicks: [0] },
      { samIndex: 1, interceptTicks: [0] },
    ],
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    impactTick: 20 + index * 10,
    samOptions: [{ samIndex: 1, interceptTicks: [10 + index * 10] }],
  })),
];
const equivalentReadySlotSchedule = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: equivalentReadySlotRoutes,
  samProfiles: [
    { id: "sam-a", availableTicks: [0] },
    { id: "sam-b", availableTicks: [0, 0, 0] },
  ],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  equivalentReadySlotSchedule.scheduleMethod,
  "exact-impossible",
  "Legendary preserves an explicit proof that an overloaded schedule is impossible",
);
assert.ok(
  equivalentReadySlotSchedule.exactSearchNodes < 10,
  "exact search collapses equivalent ready-slot branches instead of revisiting them",
);

const constructionTooLate = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 304, samOptions: [{ samIndex: 0, interceptTicks: [300] }] },
  ],
  samProfiles: [{ id: "new-sam", availableTicks: [300] }],
  samCooldownTicks: 90,
  marginTicks: 5,
  completionTick: 300,
});
assert.equal(
  constructionTooLate.fullyDefended,
  true,
  "A just-completed SAM can technically intercept a missile on its covered path",
);
assert.equal(
  constructionTooLate.completionMarginSatisfied,
  false,
  "A construction that finishes only four ticks before impact is rejected by the five-tick rule",
);

const constructionOnTime = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 305, samOptions: [{ samIndex: 0, interceptTicks: [300] }] },
  ],
  samProfiles: [{ id: "new-sam", availableTicks: [300] }],
  samCooldownTicks: 90,
  marginTicks: 5,
  completionTick: 300,
});
assert.equal(
  constructionOnTime.completionMarginSatisfied,
  true,
  "A new SAM is eligible only when completion leaves at least five ticks before impact",
);

assert.match(read("engine/ingame/auto-bot/portutil.js"), /Legendary: "Legendary"/);
assert.match(read("engine/ingame/auto-bot/core.js"), /difficulty: "Impossible"/);
assert.match(read("engine/ingame/auto-bot/panel.js"), /"Legendary"/);
assert.match(read("src/shell/popup/panel.ts"), /DIFFICULTIES/);
assert.match(read("locales/en/common.json"), /"Legendary"/);
assert.match(read("build.mjs"), /auto-bot\/legendaryPlanner\.js/);
assert.match(
  read("engine/ingame/auto-bot/legendaryPlanner.js"),
  /LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT/,
);
const structureSource = read("engine/ingame/auto-bot/structureBehavior.js");
assert.match(structureSource, /rankLegendaryConstructionActions/);
assert.match(structureSource, /legendaryAllySupportPlacementScore/);
assert.match(structureSource, /legendaryTeamCenterPlacementScore/);
assert.match(structureSource, /LEGENDARY_SAM_IMPACT_MARGIN_TICKS/);
assert.match(structureSource, /maybeUpgradeLegendarySam/);
assert.match(structureSource, /legendaryMissileDefenseUrgent/);
assert.match(structureSource, /legendaryMinimumSamImpactMargin/);
assert.match(structureSource, /missileTimerQueue/);
assert.match(structureSource, /legendaryMissileDefenseSchedule/);
assert.match(structureSource, /legendaryDefenseActionImproves/);
assert.match(structureSource, /legendarySamConstructionSafeForTile/);
assert.match(structureSource, /legendaryConstructionDuration/);
assert.match(structureSource, /legendaryTileInsideUninterceptedBlast/);
assert.match(structureSource, /legendarySamCoveragePlacementContext/);
assert.match(structureSource, /structureValues/);
assert.match(structureSource, /structureTiles/);
assert.match(structureSource, /launchMetadataCache/);
assert.match(structureSource, /enemySiloLevels/);
assert.match(structureSource, /samImpactMarginContext/);
assert.match(structureSource, /targetableIndexes/);
assert.match(structureSource, /coverageProfile/);
assert.match(structureSource, /legendarySamRouteHasIntercept/);
assert.match(structureSource, /legendarySamRouteHasTemporalOverlap/);
assert.match(structureSource, /targetableBounds/);
assert.match(structureSource, /missileTargetEntriesCache/);
assert.match(structureSource, /missileTargetOrderingCache/);
assert.match(structureSource, /increaseLevel\(\)/);
assert.match(structureSource, /targetLevel/);
assert.match(structureSource, /SiloCooldown/);
assert.match(structureSource, /legendaryEnemyMissileLaunchPlan/);
assert.match(structureSource, /forecastComplete/);
assert.match(structureSource, /legendaryThreatDefensePlan/);
assert.match(read("engine/ingame/auto-bot/gameApi.js"), /motionPlans/);

const structureSandbox = {
  Difficulty: { Impossible: "Impossible" },
  GameMode: { Team: "Team" },
  UNIT: {},
  currentDifficulty: () => "Impossible",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => false,
  legendaryPlacementProximityScore: (distance, radius) =>
    Math.max(0, 1 - distance / Math.max(1, radius)),
  legendaryMissileDefenseSchedule: plannerSandbox.legendaryMissileDefenseSchedule,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
structureSandbox.globalThis = structureSandbox;
executeClassicScript(
  `${structureSource}\nglobalThis.StructureBehavior = StructureBehavior;`,
  structureSandbox,
  { filename: "structureBehavior.js" },
);
const routeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let routeDistanceReads = 0;
routeBehavior.game = {
  x: (tile) => tile,
  y: () => 0,
  euclideanDistSquared: (left, right) => {
    routeDistanceReads++;
    return (left - right) ** 2;
  },
};
const routePath = Array.from({ length: 10 }, (_, index) => index);
const routeTargetableIndexes = routePath.map((_, index) => index);
const routeBounds = routeBehavior.legendaryTrajectoryTargetableBounds(
  routePath,
  routeTargetableIndexes,
);
assert.deepEqual({ ...routeBounds }, { minX: 0, maxX: 9, minY: 0, maxY: 0 });
const route = {
  path: routePath,
  targetableIndexes: routeTargetableIndexes,
  targetableBounds: routeBounds,
  launchOffset: 0,
  impactTick: 9,
};
assert.equal(
  routeBehavior.legendarySamRouteHasIntercept(1000, 1, route, 0, { samTile: 1000, range: 5 }),
  false,
);
assert.equal(routeDistanceReads, 0, "SAM bounding boxes skip distance reads for remote routes");
assert.equal(
  routeBehavior.legendarySamRouteHasIntercept(5, 1, route, 0, { samTile: 5, range: 1 }),
  true,
  "SAM route short-circuit still accepts a reachable intercept",
);
let targetEntryBuilds = 0;
routeBehavior.legendaryMissileTargetEntry = (target) => {
  targetEntryBuilds++;
  return {
    target,
    tile: target,
    exposedValue: 1,
    exposedStructures: 1,
    exposure: 1,
  };
};
const targetEntryCache = new Map();
const targetStructures = [1, 2, 3];
const firstTargetEntries = routeBehavior.legendaryMissileTargetCandidates(
  targetStructures,
  [],
  10,
  3,
  { entryCache: targetEntryCache },
);
const secondTargetEntries = routeBehavior.legendaryMissileTargetCandidates(
  targetStructures,
  [],
  10,
  3,
  { entryCache: targetEntryCache },
);
assert.equal(targetEntryBuilds, targetStructures.length);
assert.equal(
  firstTargetEntries,
  secondTargetEntries,
  "missile target geometry is reused for repeated threats with the same radius",
);
let targetableIndexBuilds = 0;
let interceptionCoverageCalls = 0;
routeBehavior.legendaryNukeFlightPath = () => routePath;
routeBehavior.legendaryTrajectoryTargetableIndexes = () => {
  targetableIndexBuilds++;
  return routeTargetableIndexes;
};
routeBehavior.legendaryFriendlySamUnits = () => [{ id: () => "sam" }];
routeBehavior.legendarySamReadySlots = () => 1;
routeBehavior.legendarySamPathCoverageIndicesForRoute = () => {
  interceptionCoverageCalls++;
  return [0];
};
assert.equal(
  routeBehavior.legendarySamInterceptionCapacity(0, 9),
  1,
  "SAM capacity still counts one ready interceptor on a covered route",
);
assert.equal(targetableIndexBuilds, 1);
assert.equal(interceptionCoverageCalls, 1);

const sourceSilo = { tile: () => 11 };
const fallbackSilo = { tile: () => 12 };
const sourceProfiles = [{ availableTicks: [0, 90] }, { availableTicks: [0] }];
const sourceRoute = {
  silo: sourceSilo,
  samOptions: [
    { samIndex: 0, interceptTicks: [1] },
    { samIndex: 1, interceptTicks: [2] },
  ],
};
assert.equal(
  routeBehavior.legendarySalvoRouteInterceptionCapacity(sourceRoute, sourceProfiles),
  2,
  "salvo routes reuse ready SAM slots already represented by their options",
);
let sourceFallbackCalls = 0;
let sourceFallbackProfiles;
routeBehavior.legendarySamInterceptionCapacity = (...args) => {
  sourceFallbackCalls++;
  sourceFallbackProfiles = args[3];
  return 99;
};
const sourceMetrics = routeBehavior.legendarySalvoSourceMetrics(
  [sourceSilo, fallbackSilo],
  9,
  new Map([
    [sourceSilo, 10],
    [fallbackSilo, 11],
  ]),
  [sourceRoute],
  sourceProfiles,
);
assert.deepEqual(
  sourceMetrics.map(({ interceptionCapacity }) => interceptionCapacity),
  [2, 99],
  "source metrics reuse route capacity and retain the geometry fallback",
);
assert.equal(sourceFallbackCalls, 1);
assert.equal(
  sourceFallbackProfiles,
  sourceProfiles,
  "source metrics pass prepared SAM profiles to the geometry fallback",
);

let candidatePlanBuilds = 0;
routeBehavior.legendaryEnemyMissileLaunchPlan = () => {
  candidatePlanBuilds++;
  return [{ flightTicks: 10, impactTick: 10 }];
};
const candidateThreat = {
  enemySilos: [sourceSilo],
  salvoPlan: { atomArrivalTicks: [10], hydrogenArrivalTick: null, routes: [] },
  weapon: "AtomBomb",
};
const candidateContext = {
  launchMetadataCache: new Map(),
  candidateShotPlanCache: new Map(),
  interceptionCapacityCache: new Map(),
};
const firstCandidatePlan = routeBehavior.legendaryCandidateShotPlan(
  7,
  candidateThreat,
  candidateContext,
);
const secondCandidatePlan = routeBehavior.legendaryCandidateShotPlan(
  7,
  candidateThreat,
  candidateContext,
);
assert.equal(firstCandidatePlan, secondCandidatePlan);
assert.equal(
  candidatePlanBuilds,
  1,
  "candidate launch plans are reused for repeated placement scoring",
);
let candidateCapacityBuilds = 0;
routeBehavior.legendarySamInterceptionCapacity = () => {
  candidateCapacityBuilds++;
  return 3;
};
assert.equal(
  routeBehavior.legendaryCachedSamInterceptionCapacity(sourceSilo, 7, candidateContext),
  3,
);
assert.equal(
  routeBehavior.legendaryCachedSamInterceptionCapacity(sourceSilo, 7, candidateContext),
  3,
);
assert.equal(
  candidateCapacityBuilds,
  1,
  "candidate SAM capacity is reused for repeated placement scoring",
);

let allySamRangeReads = 0;
const allySamProfiles = routeBehavior.legendaryAllySupportSamProfiles(
  [
    { level: () => 2, tile: () => 4 },
    { level: () => 2, tile: () => 5 },
  ],
  {
    samRange: () => {
      allySamRangeReads++;
      return 10;
    },
  },
);
assert.equal(allySamRangeReads, 1);
const allySupport = routeBehavior.legendaryAllySamSupport(
  5,
  { samProfiles: allySamProfiles },
  {
    samRange: () => {
      throw new Error("precomputed SAM profiles should be reused");
    },
  },
);
assert.ok(allySupport > 0, "precomputed ally SAM profiles still provide support");
assert.equal(allySamRangeReads, 1);

const defenseGapRangeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let defenseGapRangeReads = 0;
const defenseGapRangeConfig = {
  samRange: () => {
    defenseGapRangeReads++;
    return 10;
  },
};
defenseGapRangeBehavior.game = {
  config: () => defenseGapRangeConfig,
  euclideanDistSquared: () => 0,
};
defenseGapRangeBehavior.legendaryFriendlySamUnits = () => [
  { level: () => 1, tile: () => 1 },
  { level: () => 1, tile: () => 2 },
];
assert.equal(
  defenseGapRangeBehavior.legendaryDefenseGap([{ tile: () => 3 }, { tile: () => 4 }], 0),
  0.5,
);
assert.equal(defenseGapRangeReads, 1, "defense-gap scoring reuses the range for equal SAM levels");
defenseGapRangeBehavior.player = { units: () => [] };
assert.equal(
  defenseGapRangeBehavior.legendaryPortSurvivability([{ tile: () => 5 }, { tile: () => 6 }], 0),
  1,
);
assert.equal(defenseGapRangeReads, 1, "port survivability reuses the range for equal SAM levels");

const repeatedSamRangeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let repeatedSamRangeReads = 0;
const repeatedSamRangeConfig = {
  samRange: () => {
    repeatedSamRangeReads++;
    return 10;
  },
};
const repeatedSamUnits = [
  { level: () => 1, tile: () => 1 },
  { level: () => 1, tile: () => 2 },
];
repeatedSamRangeBehavior.game = {
  config: () => repeatedSamRangeConfig,
  euclideanDistSquared: () => 0,
};
repeatedSamRangeBehavior.player = { units: () => repeatedSamUnits };
const repeatedSamCoverage = repeatedSamRangeBehavior.existingSamStructureCoverage([
  { tile: 3 },
  { tile: 4 },
]);
assert.equal(repeatedSamCoverage.get(3), 2);
assert.equal(
  repeatedSamRangeBehavior.siloSamProtectionScore({ tile: () => 5 }, repeatedSamUnits),
  2,
);
assert.equal(
  repeatedSamRangeBehavior.structureSamProtectionScore({ tile: () => 6 }, repeatedSamUnits),
  20,
);
assert.equal(
  repeatedSamRangeReads,
  1,
  "coverage scoring reuses the range across structure and SAM loops",
);

const placementContextBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const placementContextConfig = {
  trainStationMaxRange: () => 10,
  samRange: () => 10,
};
let placementMetricReads = 0;
let placementAllyReads = 0;
placementContextBehavior.game = { ticks: () => 12 };
placementContextBehavior.player = {};
placementContextBehavior.safeGameConfig = () => placementContextConfig;
placementContextBehavior.legendaryProductionMetrics = () => {
  placementMetricReads++;
  return { troops: 0, gold: 0n, goldProduction: 0, tiles: [], samUnits: [] };
};
placementContextBehavior.legendaryFriendlyPlayers = () => {
  placementAllyReads++;
  return [];
};
const firstPlacementContext = placementContextBehavior.legendaryAllyPlacementContext();
const secondPlacementContext = placementContextBehavior.legendaryAllyPlacementContext();
assert.equal(firstPlacementContext, secondPlacementContext);
assert.equal(placementMetricReads, 1, "ally placement context is reused within a tick");
assert.equal(placementAllyReads, 1);

const teamContextBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let teamParticipantReads = 0;
teamContextBehavior.game = { ticks: () => 12 };
teamContextBehavior.player = {};
teamContextBehavior.legendaryFriendlyPlayers = () => [];
teamContextBehavior.legendaryParticipantCenterPoints = () => {
  teamParticipantReads++;
  return [];
};
const firstTeamContext = teamContextBehavior.legendaryTeamCenterPlacementContext();
const secondTeamContext = teamContextBehavior.legendaryTeamCenterPlacementContext();
assert.equal(firstTeamContext, secondTeamContext);
assert.equal(teamParticipantReads, 1, "team center context is reused within a tick");

const defenseProfileBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const cachedDefenseProfiles = [{ id: "cached-sam" }];
let defenseProfileBuilds = 0;
defenseProfileBehavior.legendaryFriendlySamProfiles = () => {
  defenseProfileBuilds++;
  return [{ id: "fresh-sam" }];
};
assert.equal(
  defenseProfileBehavior.legendaryDefenseSamProfiles({ samProfiles: cachedDefenseProfiles }, {}),
  cachedDefenseProfiles,
  "normal defense evaluations reuse profiles from the missile snapshot",
);
assert.equal(defenseProfileBuilds, 0);
assert.equal(
  defenseProfileBehavior.legendaryDefenseSamProfiles(
    { samProfiles: cachedDefenseProfiles },
    { levelOverrides: new Map([["sam", 2]]) },
  )[0].id,
  "fresh-sam",
  "hypothetical SAM levels rebuild profiles instead of reusing the snapshot",
);
assert.equal(defenseProfileBuilds, 1);

const defenseEvaluationBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
defenseEvaluationBehavior.game = { config: () => ({ SAMCooldown: () => 90 }) };
const defenseSnapshot = { threats: [], samProfiles: [] };
const firstDefenseEvaluation =
  defenseEvaluationBehavior.legendaryDefenseEvaluation(defenseSnapshot);
const secondDefenseEvaluation =
  defenseEvaluationBehavior.legendaryDefenseEvaluation(defenseSnapshot);
assert.equal(
  secondDefenseEvaluation,
  firstDefenseEvaluation,
  "normal defense evaluations are reused for the same missile snapshot",
);

const samRangeCacheBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let candidateSamRangeReads = 0;
const samRangeCacheConfig = {
  defaultSamRange: () => 10,
  samRange: () => {
    candidateSamRangeReads++;
    return 10;
  },
};
samRangeCacheBehavior.game = {
  config: () => samRangeCacheConfig,
  euclideanDistSquared: () => 0,
};
samRangeCacheBehavior.player = { units: () => [] };
samRangeCacheBehavior.legendaryFriendlySamUnits = () => [];
samRangeCacheBehavior.spacingConstants = () => ({ structureSpacing: 1 });
samRangeCacheBehavior.legendarySamImpactMarginContext = () => ({
  completionTick: 0,
  routesByThreat: new Map(),
});
samRangeCacheBehavior.legendaryCandidateProtectsStructure = () => false;
const samCoverageSnapshot = samRangeCacheBehavior.legendarySamCoveragePlacementContext();
const samMissileSnapshot = {
  threats: [{}],
  structures: [{ tile: () => 1 }],
  totalValue: 1,
  structureValues: new Map(),
};
samRangeCacheBehavior.legendarySamCoveragePlacementScore(
  1,
  samMissileSnapshot,
  samCoverageSnapshot,
);
samRangeCacheBehavior.legendarySamCoveragePlacementScore(
  2,
  samMissileSnapshot,
  samCoverageSnapshot,
);
assert.equal(
  candidateSamRangeReads,
  1,
  "SAM candidate scoring reuses the level-one range from its placement context",
);

const profileRangeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let profileRangeReads = 0;
profileRangeBehavior.game = {
  config: () => ({
    samRange: () => {
      profileRangeReads++;
      return 99;
    },
  }),
};
const cachedProfileRange = profileRangeBehavior.legendarySamCoverageProfile(
  { tile: 7, level: 2, range: 10 },
  2,
);
assert.equal(cachedProfileRange.samTile, 7);
assert.equal(cachedProfileRange.range, 10, "SAM route profiles retain their precomputed range");
assert.equal(profileRangeReads, 0, "precomputed SAM ranges avoid config reads");

const activeThreatCapacityBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const activeThreatSamProfiles = [{ id: "active-sam", availableTicks: [0] }];
let activeThreatCapacityArgs;
activeThreatCapacityBehavior.legendaryActiveMissileMotion = () => ({
  impactTick: 12,
  fromTile: 0,
  path: [0, 1],
});
activeThreatCapacityBehavior.legendarySamInterceptionCapacity = (...args) => {
  activeThreatCapacityArgs = args;
  return 1;
};
activeThreatCapacityBehavior.legendaryBuildMissileRoute = (route, profiles) => {
  assert.equal(profiles, activeThreatSamProfiles);
  return route;
};
activeThreatCapacityBehavior.legendaryActiveMissileThreatResult = ({ interceptionCapacity }) => ({
  interceptionCapacity,
});
structureSandbox.legendaryMissileSalvoRisk = () => ({});
activeThreatCapacityBehavior.legendaryScoredActiveMissileThreat({
  nuke: { id: () => "active-nuke" },
  fromTile: 0,
  targetTile: 1,
  type: "AtomBomb",
  exposure: { value: 1, count: 1, radiusSquared: 1 },
  context: {},
  samProfiles: activeThreatSamProfiles,
});
assert.equal(
  activeThreatCapacityArgs[3],
  activeThreatSamProfiles,
  "active missile scoring passes prepared SAM profiles to capacity ranking",
);

const samCooldownBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let samCooldownReads = 0;
let samRangeReads = 0;
const samCooldownConfig = {
  SAMCooldown: () => {
    samCooldownReads++;
    return 90;
  },
  samRange: () => {
    samRangeReads++;
    return 10;
  },
};
samCooldownBehavior.game = { config: () => samCooldownConfig };
samCooldownBehavior.legendaryFriendlySamUnits = () => [
  { id: () => "sam-a", tile: () => 1, level: () => 1 },
  { id: () => "sam-b", tile: () => 2, level: () => 1 },
];
samCooldownBehavior.legendarySamSlotAvailability = () => [0];
const samCooldownProfiles = samCooldownBehavior.legendaryFriendlySamProfiles();
assert.equal(samCooldownProfiles.length, 2);
assert.equal(
  samCooldownReads,
  1,
  "SAM profile construction reuses the cooldown from the same game configuration",
);
assert.equal(samRangeReads, 1, "SAM profile construction reuses the range for equal SAM levels");
const replacementSamConfig = {
  SAMCooldown: () => 90,
  samRange: () => {
    samRangeReads++;
    return 20;
  },
};
samCooldownBehavior.game = { config: () => replacementSamConfig };
assert.equal(samCooldownBehavior.legendarySamRange(1), 20);
assert.equal(samRangeReads, 2, "a new game configuration invalidates the SAM range cache");

const siloCooldownBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let siloCooldownReads = 0;
const siloCooldownConfig = {
  SiloCooldown: () => {
    siloCooldownReads++;
    return 90;
  },
};
siloCooldownBehavior.game = { config: () => siloCooldownConfig };
assert.equal(siloCooldownBehavior.legendarySiloCooldownTicks(), 90);
assert.equal(siloCooldownBehavior.legendarySiloCooldownTicks(), 90);
assert.equal(
  siloCooldownReads,
  1,
  "silo availability reuses the cooldown from the same game configuration",
);
const replacementSiloConfig = {
  SiloCooldown: () => {
    siloCooldownReads++;
    return 45;
  },
};
siloCooldownBehavior.game = { config: () => replacementSiloConfig };
assert.equal(siloCooldownBehavior.legendarySiloCooldownTicks(), 45);
assert.equal(siloCooldownReads, 2, "a new game configuration invalidates the silo cache");

const profileCapacityBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let rawSamReads = 0;
profileCapacityBehavior.game = { euclideanDistSquared: (left, right) => (left - right) ** 2 };
profileCapacityBehavior.legendaryNukeFlightPath = () => [0, 1, 2];
profileCapacityBehavior.legendaryTrajectoryTargetableIndexes = () => [0, 1, 2];
profileCapacityBehavior.legendaryFriendlySamUnits = () => {
  rawSamReads++;
  return [];
};
profileCapacityBehavior.legendarySamPathCoverageIndicesForRoute = (profile) =>
  profile.range === 10 ? [0] : [];
assert.equal(
  profileCapacityBehavior.legendarySamInterceptionCapacity(0, 2, null, [
    { tile: 0, level: 1, range: 10, availableTicks: [0] },
  ]),
  1,
  "SAM capacity can use the prepared profile snapshot",
);
assert.equal(rawSamReads, 0, "prepared SAM capacity avoids rereading raw units");
let minimumCapacityProfiles;
profileCapacityBehavior.legendarySamInterceptionCapacity = (...args) => {
  minimumCapacityProfiles = args[3];
  return 1;
};
const minimumCapacitySnapshot = {
  threats: [{ targetTile: 2, enemySilos: [0] }],
  samProfiles: [{ tile: 0, level: 1, range: 10, availableTicks: [0] }],
};
assert.equal(
  profileCapacityBehavior.legendaryMinimumSamInterceptionCapacity(minimumCapacitySnapshot),
  1,
  "minimum SAM capacity reuses the missile snapshot profiles",
);
assert.equal(minimumCapacityProfiles, minimumCapacitySnapshot.samProfiles);

process.stdout.write("LEGENDARY TESTS OK\n");
