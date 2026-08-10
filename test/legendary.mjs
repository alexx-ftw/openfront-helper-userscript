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
  0,
  "A levelled SAM can spend multiple ready missile slots in the same engine tick",
);
assert.equal(sameTickOverload.fullyDefended, true);

const impactTickIsTooLate = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [20] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  impactTickIsTooLate.uninterceptedCount,
  1,
  "an interceptor cannot destroy a nuke on its final impact tick",
);

const flightAwareInterception = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      weapon: "AtomBomb",
      impactTick: 20,
      samOptions: [{ samIndex: 0, interceptTicks: [5], interceptionTicks: [10] }],
    },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [5] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(flightAwareInterception.missiles[0].samFireTick, 5);
assert.equal(
  flightAwareInterception.missiles[0].interceptTick,
  10,
  "the schedule distinguishes SAM launch time from the later missile collision",
);
assert.equal(flightAwareInterception.missiles[0].marginTicks, 10);

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
const capacityOnlyCurrent = {
  hasThreats: true,
  fullyDefended: false,
  uninterceptedCount: 1,
  minimumInterceptMarginTicks: 0,
};
const capacityOnlyNext = { ...capacityOnlyCurrent };
assert.equal(
  plannerSandbox.legendaryDefenseActionImproves(capacityOnlyCurrent, capacityOnlyNext, 1, 2),
  false,
  "Legendary must not buy capacity that leaves the active missile schedule unchanged",
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
  false,
  "A theoretical alternate SAM matching cannot prove defense under the engine's autonomous claim order",
);
assert.equal(
  alternateAssignment.scheduleMethod,
  "engine-order-inconclusive",
  "The planner exposes when only an unenforceable alternate assignment covers the salvo",
);
assert.equal(
  alternateAssignment.uninterceptedCount,
  1,
  "The observable greedy schedule retains the missile that may penetrate in the real engine",
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
  UniversalPathFinding: null,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
const nukePathSandbox = {
  UNIT: {},
  within: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
  globalThis: null,
};
nukePathSandbox.globalThis = nukePathSandbox;
executeClassicScript(
  `${read("engine/ingame/auto-bot/nukeBehavior.js")}\nglobalThis.__UniversalPathFinding = UniversalPathFinding;`,
  nukePathSandbox,
  { filename: "nukeBehavior-pathfinder.js" },
);
structureSandbox.UniversalPathFinding = nukePathSandbox.__UniversalPathFinding;
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
  height: () => 1_000,
  ref: (x) => Math.floor(x),
  config: () => ({
    defaultSamMissileSpeed: () => 2,
    defaultNukeTargetableRange: () => 5,
    defaultNukeSpeed: () => 10,
  }),
  manhattanDist: (left, right) => Math.abs(left - right),
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
const terminalFallbackRoute = {
  path: [0, 10, 20],
  targetableIndexes: [1, 2],
  launchOffset: 0,
  impactTick: 2,
};
assert.deepEqual(
  Array.from(
    routeBehavior.legendarySamInterceptionOpportunities({ tile: 10 }, [2], terminalFallbackRoute)
      .fireTicks,
  ),
  [1],
  "a SAM in range of a targetable terminal explosion can fire at the penultimate route tile",
);
const flightLimitedPath = [0, 1, 2, 3, 4, 5];
const flightLimitedRoute = {
  path: flightLimitedPath,
  targetableIndexes: [4],
  targetableBounds: routeBehavior.legendaryTrajectoryTargetableBounds(flightLimitedPath, [4]),
  launchOffset: 0,
  impactTick: 5,
};
assert.equal(
  routeBehavior.legendarySamRouteHasIntercept(20, 1, flightLimitedRoute, 0, {
    samTile: 20,
    range: 17,
  }),
  false,
  "route protection rejects geometric coverage when the interceptor cannot arrive in time",
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
const targetStructureMap = targetStructures.map;
let targetStructureMapCalls = 0;
let targetEntryFilterCalls = 0;
targetStructures.map = (...args) => {
  targetStructureMapCalls++;
  const mapped = targetStructureMap.apply(targetStructures, args);
  const originalFilter = mapped.filter;
  mapped.filter = (...filterArgs) => {
    targetEntryFilterCalls++;
    return originalFilter.apply(mapped, filterArgs);
  };
  return mapped;
};
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
delete targetStructures.map;
assert.equal(targetStructureMapCalls, 0);
assert.equal(targetEntryFilterCalls, 0);
const orderingEntries = Array.from({ length: 20 }, (_, index) => ({
  target: { id: index },
  tile: index,
  exposedValue: index,
  exposedStructures: 1,
  exposure: 1,
}));
const orderingValues = new Map(orderingEntries.map(({ target }, index) => [target, 19 - index]));
const orderingEntrySlice = orderingEntries.slice;
const orderingEntrySort = orderingEntries.sort;
let orderingEntrySliceCalls = 0;
let orderingEntrySortCalls = 0;
orderingEntries.slice = (...args) => {
  orderingEntrySliceCalls++;
  return orderingEntrySlice.apply(orderingEntries, args);
};
orderingEntries.sort = (...args) => {
  orderingEntrySortCalls++;
  return orderingEntrySort.apply(orderingEntries, args);
};
const orderingCache = new Map();
routeBehavior.legendaryMissileTargetCandidates([], [], 10, 1, {
  structureValues: orderingValues,
  entryCache: new Map([[100, orderingEntries]]),
  orderingCache,
});
assert.deepEqual(
  [...orderingCache.get(100).byExposure.map(({ target }) => target.id)],
  Array.from({ length: 16 }, (_, index) => 19 - index),
);
assert.deepEqual(
  [...orderingCache.get(100).byValue.map(({ target }) => target.id)],
  Array.from({ length: 16 }, (_, index) => index),
);
const orderedByExposure = orderingCache.get(100).byExposure;
const orderedByValue = orderingCache.get(100).byValue;
const orderedByExposureSlice = orderedByExposure.slice;
const orderedByValueSlice = orderedByValue.slice;
let orderingSelectionSliceCalls = 0;
orderedByExposure.slice = (...args) => {
  orderingSelectionSliceCalls++;
  return orderedByExposureSlice.apply(orderedByExposure, args);
};
orderedByValue.slice = (...args) => {
  orderingSelectionSliceCalls++;
  return orderedByValueSlice.apply(orderedByValue, args);
};
assert.equal(
  routeBehavior.legendarySelectMissileTargets(
    orderingEntries,
    orderedByExposure,
    orderedByValue,
    [],
    16,
  ).length,
  16,
);
assert.equal(orderingSelectionSliceCalls, 0);
delete orderedByExposure.slice;
delete orderedByValue.slice;
assert.equal(orderingEntrySliceCalls, 0);
assert.equal(orderingEntrySortCalls, 0);
delete orderingEntries.slice;
delete orderingEntries.sort;
let targetableIndexBuilds = 0;
let interceptionCoverageChecks = 0;
routeBehavior.legendaryNukeFlightPath = () => routePath;
routeBehavior.legendaryTrajectoryTargetableIndexes = () => {
  targetableIndexBuilds++;
  return routeTargetableIndexes;
};
routeBehavior.legendaryFriendlySamUnits = () => [{ id: () => "sam" }];
routeBehavior.legendarySamReadySlots = () => 1;
routeBehavior.legendarySamPathHasCoverageForRoute = () => {
  interceptionCoverageChecks++;
  return true;
};
assert.equal(
  routeBehavior.legendarySamInterceptionCapacity(0, 9),
  1,
  "SAM capacity still counts one ready interceptor on a covered route",
);
assert.equal(targetableIndexBuilds, 1);
assert.equal(interceptionCoverageChecks, 1);

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
const sourceMetrics = routeBehavior.legendarySalvoSourceMetrics({
  enemySilos: [sourceSilo, fallbackSilo],
  targetTile: 9,
  launchFlightTimes: new Map([
    [sourceSilo, 10],
    [fallbackSilo, 11],
  ]),
  routes: [sourceRoute],
  samProfiles: sourceProfiles,
});
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
const candidateLaunches = [
  { flightTicks: 10, impactTick: 10 },
  { flightTicks: 20, impactTick: 20 },
];
let candidateLaunchSliceCalls = 0;
let candidateLaunchMapCalls = 0;
const candidateLaunchSlice = candidateLaunches.slice;
const candidateLaunchMap = candidateLaunches.map;
candidateLaunches.map = (...args) => {
  candidateLaunchMapCalls++;
  return candidateLaunchMap.apply(candidateLaunches, args);
};
candidateLaunches.slice = (...args) => {
  candidateLaunchSliceCalls++;
  const sliced = candidateLaunchSlice.apply(candidateLaunches, args);
  const slicedMap = sliced.map;
  sliced.map = (...mapArgs) => {
    candidateLaunchMapCalls++;
    return slicedMap.apply(sliced, mapArgs);
  };
  return sliced;
};
routeBehavior.legendaryEnemyMissileLaunchPlan = () => {
  candidatePlanBuilds++;
  return candidateLaunches;
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
assert.deepEqual([...firstCandidatePlan.atomArrivalTicks], [10, 20]);
assert.equal(firstCandidatePlan.nearestFlightTime, 10);
assert.equal(
  candidatePlanBuilds,
  1,
  "candidate launch plans are reused for repeated placement scoring",
);
assert.equal(candidateLaunchSliceCalls, 0);
assert.equal(candidateLaunchMapCalls, 0);
const hydrogenCandidatePlan = routeBehavior.legendaryCandidateShotPlan(
  8,
  {
    enemySilos: [sourceSilo],
    salvoPlan: {
      atomArrivalTicks: [],
      hydrogenArrivalTick: 20,
      routes: [],
    },
    weapon: "HydrogenBomb",
  },
  {
    launchMetadataCache: new Map(),
    candidateShotPlanCache: new Map(),
    interceptionCapacityCache: new Map(),
  },
);
assert.deepEqual([...hydrogenCandidatePlan.atomArrivalTicks], [10]);
assert.equal(hydrogenCandidatePlan.hydrogenArrivalTick, 20);
assert.equal(candidateLaunchSliceCalls, 0);
assert.equal(candidateLaunchMapCalls, 0);
delete candidateLaunches.map;
delete candidateLaunches.slice;
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
const flightSpeedBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let flightSpeedReads = 0;
const flightSpeedConfig = {
  defaultNukeSpeed: () => {
    flightSpeedReads++;
    return 10;
  },
};
flightSpeedBehavior.game = {
  config: () => flightSpeedConfig,
  euclideanDistSquared: () => 1,
  x: (tile) => tile,
  y: () => 0,
  height: () => 1_000,
  isValidCoord: () => true,
  ref: (x) => x,
};
flightSpeedBehavior.legendaryNukeFlightPath(0, 1);
flightSpeedBehavior.legendaryNukeFlightPath(0, 1);
flightSpeedBehavior.legendaryNukeFlightTime(0, 1);
assert.equal(flightSpeedReads, 1, "cached missile trajectories reuse the configured nuke speed");
const pinnedFlightPathFinder = structureSandbox.UniversalPathFinding.Parabola(
  flightSpeedBehavior.game,
  { increment: 10, distanceBasedHeight: true, directionUp: true },
);
const pinnedMotionPlan = [];
let pinnedFlightTicks = 0;
while (true) {
  const result = pinnedFlightPathFinder.next(0, 500, 10);
  pinnedFlightTicks++;
  if (result.status === "Complete") break;
  pinnedMotionPlan.push(result.node);
}
const sampledFlightPath = flightSpeedBehavior.legendaryNukeFlightPath(0, 500);
assert.ok(
  pinnedMotionPlan.length > 0 && sampledFlightPath.length > 0,
  "the Legendary regression route has both a sampled trajectory and an authoritative motion plan",
);
assert.ok(
  pinnedFlightTicks > sampledFlightPath.length,
  "the pinned motion plan needs multiple ticks across at least one sampled trajectory segment",
);
assert.equal(
  flightSpeedBehavior.legendaryNukeFlightTime(0, 500),
  pinnedFlightTicks,
  "Legendary prospective flight ticks match the pinned NukeExecution motion plan",
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

const mirvDedupSandbox = {
  UNIT: {
    MissileSilo: "Missile Silo",
    MIRV: "MIRV",
    MIRVWarhead: "MIRV Warhead",
  },
  Difficulty: { Impossible: "Impossible" },
  PlayerType: { Bot: "Bot" },
  AllPlayers: {},
  EMOJI_NUKE: [],
  WORKER_TIMEOUT_MS: 1,
  currentDifficulty: () => "Impossible",
  state: { settings: { winFixes: false }, stats: { nukes: 0 } },
  withTimeout: async (promise) => promise,
  setLastAction() {},
  tr: (value) => value,
  respondToMIRV() {},
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
};
mirvDedupSandbox.globalThis = mirvDedupSandbox;
executeClassicScript(read("engine/ingame/shared-utils.js"), mirvDedupSandbox, {
  filename: "shared-utils-mirv-dedup.js",
});
executeClassicScript(
  `${read("engine/ingame/auto-bot/mirvBehavior.js")}\nglobalThis.__MirvBehavior = MirvBehavior;`,
  mirvDedupSandbox,
  { filename: "mirv-dedup.js" },
);

const mirvDedupUnit = (owner, type, targetTile) => ({
  isActive: () => true,
  owner: () => owner,
  type: () => type,
  targetTile: () => targetTile,
});
const permanentMirvTeammate = {
  smallID: () => 2,
  team: () => "blue",
};
const breakableMirvAlly = {
  smallID: () => 3,
  team: () => null,
};
const mirvTarget = {
  id: () => "mirv-target",
  smallID: () => 4,
  isPlayer: () => true,
  type: () => "Human",
  team: () => null,
};
let activeMirvUnits = [];
let emittedMirvBuilds = 0;
const mirvDedupPlayer = {
  smallID: () => 1,
  team: () => "blue",
  isFriendly: (other) => other === breakableMirvAlly,
  units: (type) =>
    type === mirvDedupSandbox.UNIT.MissileSilo
      ? [
          {
            isActive: () => true,
            isUnderConstruction: () => false,
            level: () => 1,
            missileTimerQueue: () => [],
          },
        ]
      : [],
  buildables: async () => [{ type: mirvDedupSandbox.UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvDedupGame = {
  ticks: () => 100,
  players: () => [mirvDedupPlayer, permanentMirvTeammate, breakableMirvAlly, mirvTarget],
  units: (...types) => activeMirvUnits.filter((unit) => types.includes(unit.type())),
  config: () => ({ nukeMagnitudes: () => ({ inner: 12 }) }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
mirvDedupSandbox.sendAutoBotBuildOrUpgrade = () => {
  emittedMirvBuilds++;
  return true;
};
const mirvDedupBehavior = new mirvDedupSandbox.__MirvBehavior(
  { chance: () => false },
  mirvDedupGame,
  mirvDedupPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
mirvDedupBehavior.calculateTerritoryCenter = async () => 100;

for (const activeType of [mirvDedupSandbox.UNIT.MIRV, mirvDedupSandbox.UNIT.MIRVWarhead]) {
  activeMirvUnits = [mirvDedupUnit(permanentMirvTeammate, activeType, 108)];
  emittedMirvBuilds = 0;
  assert.equal(
    await mirvDedupBehavior.maybeSendMIRV(mirvTarget),
    false,
    `a permanent teammate's active ${activeType} suppresses an overlapping MIRV launch`,
  );
  assert.equal(emittedMirvBuilds, 0);
}

activeMirvUnits = [mirvDedupUnit(breakableMirvAlly, mirvDedupSandbox.UNIT.MIRV, 108)];
emittedMirvBuilds = 0;
assert.equal(
  await mirvDedupBehavior.maybeSendMIRV(mirvTarget),
  true,
  "a breakable ally's active MIRV does not suppress an overlapping launch",
);
assert.equal(emittedMirvBuilds, 1);

process.stdout.write("LEGENDARY TESTS OK\n");
