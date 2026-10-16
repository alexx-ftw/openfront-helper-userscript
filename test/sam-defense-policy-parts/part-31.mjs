  behavior.samTileCoversMirvDemand(100, mirvDeadlineBoundary, 95),
  true,
  "A MIRV SAM slot ready exactly at the five-tick safety boundary is usable",
);
assert.equal(
  behavior.samTileCoversMirvDemand(100, mirvDeadlineBoundary, 96),
  false,
  "A MIRV SAM slot ready one tick inside the safety boundary is not coverage",
);
behavior.game.manhattanDist = originalMirvManhattanDistance;

const mirvTimingBehavior = Object.create(sandbox.__StructureBehavior.prototype);
mirvTimingBehavior.game = { manhattanDist: () => 49 };
mirvTimingBehavior.legendarySamCooldownTicks = () => 90;
mirvTimingBehavior.legendaryMirvDemandRoute = (_demand, _profiles, routeId) => ({
  id: routeId,
  impactTick: 5,
  samOptions: [{ samIndex: 0, interceptTicks: [] }],
});
const flightLimitedMirvDemand = { missile: {}, targetTile: 999, deadlineTick: 5 };
const flightLimitedMirvProfiles = [
  {
    tile: 20,
    range: 50,
    availableTicks: [0],
    cooldownTicks: 90,
  },
];
assert.equal(
  mirvTimingBehavior.activeMirvDemandCovered(flightLimitedMirvDemand, flightLimitedMirvProfiles),
  false,
  "MIRV defense rejects nearby geometry when no interceptor can reach the trajectory in time",
);
const secondFlightLimitedMirvDemand = {
  missile: {},
  targetTile: 1000,
  deadlineTick: 5,
};
mirvTimingBehavior.legendaryMirvDemandRoute = (demand, _profiles, routeId) => ({
  id: routeId,
  demand,
  impactTick: 5,
  samOptions: [{ samIndex: 0, interceptTicks: [1] }],
});
const sharedSlotMirvContext = {
  samProfiles: flightLimitedMirvProfiles,
  mirvDemands: [flightLimitedMirvDemand, secondFlightLimitedMirvDemand],
};
assert.equal(
  mirvTimingBehavior.uncoveredActiveMirvDemands(sharedSlotMirvContext).length,
  1,
  "two MIRV threats cannot both consume the same single ready SAM slot",
);
own.units = originalMirvPlayerUnits;
behavior.game.euclideanDistSquared = originalMirvDistance;
behavior.game.units = originalThreatGameUnits;
behavior.game.ticks = originalThreatGameTicks;

const originalConstructionDuration = behavior.legendaryConstructionDuration;
const originalPendingEvaluation = behavior.legendaryDefenseEvaluation;
const originalPendingGameTicks = behavior.game.ticks;
behavior.legendaryConstructionDuration = () => 5;
behavior.legendaryDefenseEvaluation = (_context, options) => ({
  hasThreats: true,
  fullyDefended: false,
  uninterceptedCount: options.extraSam.tile === 2222 ? 1 : 2,
  minimumInterceptMarginTicks: 0,
});
const pendingCurrentEvaluation = {
  hasThreats: true,
  fullyDefended: false,
  uninterceptedCount: 2,
  minimumInterceptMarginTicks: 0,
};
behavior.legendaryConstructionDuration = () => 100;
behavior.game.ticks = () => 150;
const nearlyBuiltSam = makeUnit(3333, 1, { underConstruction: true });
nearlyBuiltSam.__src = { state: { constructionStartTick: 75 } };
assert.equal(
  behavior.pendingSamRemainingConstructionTicks(nearlyBuiltSam),
  25,
  "Pending defense uses remaining construction time instead of restarting the full duration",
);
behavior.legendaryConstructionDuration = () => 5;
own.sams = [makeUnit(1111, 1, { underConstruction: true })];
assert.equal(
  behavior.activeMissilePendingSamImproves({}, pendingCurrentEvaluation),
  false,
  "An unrelated SAM under construction does not block a useful defensive site",
);
own.sams = [makeUnit(2222, 1, { underConstruction: true })];
assert.equal(
  behavior.activeMissilePendingSamImproves({}, pendingCurrentEvaluation),
  true,
  "A pending SAM that reduces uncovered missiles suppresses redundant placement",
);
behavior.legendaryConstructionDuration = originalConstructionDuration;
behavior.legendaryDefenseEvaluation = originalPendingEvaluation;
behavior.game.ticks = originalPendingGameTicks;

const originalIncrementalSamImprovement = behavior.activeMissileSamConstructionImproves;
const originalUncoveredMirvDemands = behavior.uncoveredActiveMirvDemands;
const originalMirvEmergencyEvaluation = behavior.legendaryDefenseEvaluation;
behavior.uncoveredActiveMirvDemands = () => [{ targetTile: 777 }];
behavior.legendaryDefenseEvaluation = () => ({
  hasThreats: false,
  fullyDefended: true,
});
const mirvOnlyEmergency = behavior.structureMissileEmergency(UNIT.SAMLauncher, {
  activeMissileDefense: true,
  missileDefenseContext: { threats: [] },
});
assert.equal(mirvOnlyEmergency.samDefense, true, "A MIRV-only demand activates SAM safety gating");
assert.equal(
  mirvOnlyEmergency.incrementalSamDefense,
  true,
  "Every MIRV-only candidate must prove destination coverage",
);
behavior.uncoveredActiveMirvDemands = originalUncoveredMirvDemands;
behavior.legendaryDefenseEvaluation = originalMirvEmergencyEvaluation;
behavior.activeMissileSamConstructionImproves = (tile) => tile === 42;
const incrementalEmergency = {
  active: true,
  samDefense: true,
  incrementalSamDefense: true,
  context: {},
  evaluation: {},
};
assert.equal(
  behavior.structureEmergencyTileAllowed(41, UNIT.SAMLauncher, incrementalEmergency),
  false,
  "An active-missile SAM candidate that improves no trajectory is rejected",
);
assert.equal(
  behavior.structureEmergencyTileAllowed(42, UNIT.SAMLauncher, incrementalEmergency),
  true,
  "A SAM candidate may make one measurable step across simultaneous trajectories",
);
behavior.activeMissileSamConstructionImproves = originalIncrementalSamImprovement;
own.sams = [reactiveSam];

behavior.missileDefenseSignalSnapshot = originalActiveMissileSignal;
behavior.activeMissileDefenseContext = originalActiveMissileContext;
behavior.legendaryDefenseEvaluation = originalDefenseEvaluation;
behavior.maybeUpgradeMissileDefenseSam = originalMaybeUpgradeMissileDefenseSam;
behavior.maybeSpawnStructure = originalActiveMissileMaybeSpawnStructure;
behavior.hydrogenSamProtectionPlan = originalActiveMissileHydrogenPlan;

// The dedicated hostile-silo SAM path is covered above; the wiring tests can
// now exercise the proactive parity branch before ordinary construction.
const originalActiveMissileMaximumPriority = behavior.handleActiveMissileSamMaximumPriority;
const originalMaybeSpawnHostileSiloSam = behavior.maybeSpawnHostileSiloSam;
const originalHostileSiloSamMaximumPriority = behavior.handleHostileSiloSamMaximumPriority;
const originalHydrogenStructureCoverage = behavior.maybeEnsureHydrogenStructureCoverage;
const originalHydrogenSiloUpgrade = behavior.maybeUpgradeHydrogenProtectionSam;
behavior.maybeSpawnHostileSiloSam = async () => false;
behavior.handleActiveMissileSamMaximumPriority = async () => null;
behavior.handleHostileSiloSamMaximumPriority = async () => null;
let wiredStructureCoverageCalls = 0;
behavior.maybeEnsureHydrogenStructureCoverage = async () => {
  wiredStructureCoverageCalls++;
  return true;
};
behavior.maybeUpgradeHydrogenProtectionSam = async () => false;
let wiredParityCalls = 0;
behavior.maybeUpgradeMissileDefenseSam = async () => false;
behavior.maybeUpgradeSamForSiloParity = async () => {
  wiredParityCalls++;
  return true;
};
behavior.placementsCount = 0;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks proactive SAM/Silo level parity",
);
assert.equal(
  wiredStructureCoverageCalls,
  1,
  "Full structure H-bomb coverage is checked before SAM/Silo parity",
);
assert.equal(wiredParityCalls, 0, "Higher-priority structure coverage stops lower priorities");

behavior.maybeEnsureHydrogenStructureCoverage = async () => false;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks proactive SAM/Silo level parity",
);
assert.equal(wiredParityCalls, 1, "The proactive SAM parity path is wired into handleStructures");
