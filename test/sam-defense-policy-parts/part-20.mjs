assert.equal(
  await pendingCoverageSamBehavior.maybeEnsureHydrogenStructureCoverage(),
  false,
  "a pending SAM blocks a duplicate preemptive coverage launcher",
);
assert.equal(
  pendingCoveragePlanCalls,
  0,
  "coverage geometry is reassessed only after the pending SAM materializes",
);

const failedCoverageSamBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let failedCoverageSpawnCalls = 0;
failedCoverageSamBehavior.hasOwnSamUnderConstruction = () => false;
failedCoverageSamBehavior.activeMissileDefenseContext = () => ({ threats: [] });
failedCoverageSamBehavior.hydrogenStructureCoveragePlan = () => ({ needsNewSam: true });
failedCoverageSamBehavior.hostileSiloSamPlacementOptions = () => ({ useActualCost: true });
failedCoverageSamBehavior.maybeSpawnStructure = async () => {
  failedCoverageSpawnCalls++;
  return false;
};
assert.equal(
  await failedCoverageSamBehavior.maybeEnsureHydrogenStructureCoverage(),
  true,
  "a failed uncovered-SAM placement reserves the construction lane for retry",
);
assert.equal(failedCoverageSpawnCalls, 1);

const preventiveCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
preventiveCoverageBehavior.hasOwnSamUnderConstruction = () => false;
preventiveCoverageBehavior.hydrogenStructureCoveragePlan = () => ({ needsNewSam: true });
let liveCoverageThreats = [];
preventiveCoverageBehavior.activeMissileDefenseContext = () => ({ threats: liveCoverageThreats });
preventiveCoverageBehavior.getMissileDefenseContext = () => ({ threats: [{}] });
preventiveCoverageBehavior.getMissileDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: false,
});
preventiveCoverageBehavior.legendaryDefenseEvaluation = (context) => ({
  hasThreats: context.threats.length > 0,
  fullyDefended: false,
});
preventiveCoverageBehavior.uncoveredActiveMirvDemands = () => [];
const coverageDeadlineDecisions = [];
preventiveCoverageBehavior.maybeSpawnStructure = async (_type, options) => {
  coverageDeadlineDecisions.push(
    preventiveCoverageBehavior.structureMissileEmergencyState(options).active,
  );
  return true;
};
await preventiveCoverageBehavior.maybeEnsureHydrogenStructureCoverage();
liveCoverageThreats = [{}];
await preventiveCoverageBehavior.maybeEnsureHydrogenStructureCoverage();
assert.deepEqual(
  coverageDeadlineDecisions,
  [false, true],
  "preventive coverage ignores hypothetical launch deadlines but retains live missile deadlines",
);

const coveragePressureBehavior = Object.create(sandbox.__StructureBehavior.prototype);
coveragePressureBehavior.hydrogenCoverageNeedsSam = () => true;
coveragePressureBehavior.hasObservedHostileMissileLaunch = () => false;
coveragePressureBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
coveragePressureBehavior.hasDefensiveSamPressure = () => true;
coveragePressureBehavior.safeConstructionCost = () => 1_500_000n;
const coveragePressure = coveragePressureBehavior.defensiveConstructionPressure();
assert.equal(coveragePressure?.type, UNIT.SAMLauncher);
assert.equal(coveragePressure?.cost, 1_500_000n);

const nukeSamLiquidityBehavior = Object.create(sandbox.__StructureBehavior.prototype);
nukeSamLiquidityBehavior.player = {
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(1160, 1)] : []),
};
nukeSamLiquidityBehavior.hasPlacedSiloOnMap = () => true;
nukeSamLiquidityBehavior.hasBuiltHostileSiloThreat = () => true;
nukeSamLiquidityBehavior.safeConstructionCost = () => 1_500_000n;
assert.equal(
  nukeSamLiquidityBehavior.singleSamHostileSiloReplacementReserve(),
  1_500_000n,
  "a sole SAM retains the actual replacement cost while another player has a Silo",
);
nukeSamLiquidityBehavior.player.units = () => [makeUnit(1160, 1), makeUnit(1161, 1)];
assert.equal(
  nukeSamLiquidityBehavior.singleSamHostileSiloReplacementReserve(),
  0n,
  "redundant SAM coverage does not reserve a second replacement launcher",
);
nukeSamLiquidityBehavior.player.units = (type) =>
  type === UNIT.SAMLauncher ? [makeUnit(1160, 1)] : [];
nukeSamLiquidityBehavior.economicConstructionPressure = () => null;
nukeSamLiquidityBehavior.defensiveConstructionReserve = () => 0n;
nukeSamLiquidityBehavior.spendableConstructionGold = () => 1_700_000n;
assert.equal(
  nukeSamLiquidityBehavior.shouldDeferOffensiveWarship(250_000n),
  true,
  "an offensive Warship cannot consume the sole-SAM replacement reserve",
);
nukeSamLiquidityBehavior.spendableConstructionGold = () => 1_750_000n;
assert.equal(
  nukeSamLiquidityBehavior.shouldDeferOffensiveWarship(250_000n),
  false,
  "a Warship remains available once its cost and the SAM replacement reserve are covered",
);

nukeSamLiquidityBehavior.player.units = () => [];
nukeSamLiquidityBehavior.spendableConstructionGold = () => 1_061_290n;
assert.equal(
  nukeSamLiquidityBehavior.shouldDeferWarshipForFirstSam(500_000n),
  true,
  "a completed hostile Silo reserves the complete first-SAM cost from an emergency Warship",
);
nukeSamLiquidityBehavior.spendableConstructionGold = () => 2_000_000n;
assert.equal(
  nukeSamLiquidityBehavior.shouldDeferWarshipForFirstSam(500_000n),
  false,
  "the emergency Warship is affordable once both it and the first SAM are funded",
);
nukeSamLiquidityBehavior.player.units = (type) =>
  type === UNIT.SAMLauncher ? [makeUnit(1162, 1, { underConstruction: true })] : [];
assert.equal(
  nukeSamLiquidityBehavior.shouldDeferWarshipForFirstSam(500_000n),
  false,
  "a first SAM already under construction releases the maritime emergency path",
);
nukeSamLiquidityBehavior.player.units = () => [];
nukeSamLiquidityBehavior.hasBuiltHostileSiloThreat = () => false;
nukeSamLiquidityBehavior.spendableConstructionGold = () => 1_061_290n;
assert.equal(
  nukeSamLiquidityBehavior.singleSamHostileSiloReplacementReserve(),
  0n,
  "an enemy Silo still under construction creates no hard replacement reserve",
);
assert.equal(
  nukeSamLiquidityBehavior.shouldDeferWarshipForFirstSam(500_000n),
  false,
  "an enemy Silo still under construction permits anticipatory SAM planning without blocking an emergency Warship",
);

let coverageSamLevel = 1;
const structureCoverageSam = {
  id: () => 1201,
  level: () => coverageSamLevel,
  tile: () => 0,
  isUnderConstruction: () => false,
  isActive: () => true,
};
const structureCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
structureCoverageBehavior._hostileMissileLaunchObserved = false;
let structureCoverageTick = 1;
let structureCoverageDistanceCalls = 0;
structureCoverageBehavior.player = {
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [structureCoverageSam];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    if (type === UNIT.Factory) return [{ tile: () => 10 }];
    return [];
  },
};
structureCoverageBehavior.game = {
  ticks: () => structureCoverageTick,
  euclideanDistSquared: (left, right) => {
    structureCoverageDistanceCalls++;
    return (Number(left) - Number(right)) ** 2;
  },
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
structureCoverageBehavior.liveNuclearHostilePlayers = () => [enemyTwoLevelOneSilos];
structureCoverageBehavior.cost = () => 1n;
structureCoverageBehavior.safeConstructionCost = () => 1n;
structureCoverageBehavior.legendaryMissileDefenseUrgent = () => false;
structureCoverageBehavior.legendaryReserveGold = () => 0n;
structureCoverageBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1n },
];
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan().targetLevel,
  2,
  "Structure protection chooses the minimum SAM level covering every structure",
);
const firstCoverageDistanceCalls = structureCoverageDistanceCalls;
sentBuilds.length = 0;
assert.equal(
  await structureCoverageBehavior.maybeEnsureHydrogenStructureCoverage(),
  true,
