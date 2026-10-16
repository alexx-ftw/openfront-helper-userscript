  [20, 30],
  "economic placement excludes an exclusively friendly team seam but keeps hostile and mixed/unowned borders exposed",
);

teamInteriorOwners.set(21, 2);
assert.deepEqual(
  [...teamInteriorBehavior.economicExposureBorderTiles()],
  [20, 30],
  "the economic exposure classification is reused within the same game tick",
);
teamInteriorTick++;
assert.deepEqual(
  [...teamInteriorBehavior.economicExposureBorderTiles()],
  [30],
  "the economic exposure classification refreshes on the next game tick",
);

const economicPlacementBorders = [];
teamInteriorBehavior.nearestTileDistanceScorer = (tiles) => {
  economicPlacementBorders.push([...tiles]);
  return () => 0;
};
teamInteriorBehavior.factoryValue();
teamInteriorBehavior.cityValue();
assert.deepEqual(
  economicPlacementBorders[0],
  [30],
  "Factory placement measures safety from the exposed perimeter rather than the friendly seam",
);
assert.deepEqual(
  economicPlacementBorders[3],
  [30],
  "City placement measures safety from the exposed perimeter rather than the friendly seam",
);

const factoryRatioBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let factoryLevels = 2;
factoryRatioBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
factoryRatioBehavior.shouldReserveEconomicGrowthForOffense = () => false;
factoryRatioBehavior.ownedLevels = (type) => (type === UNIT.Factory ? factoryLevels : 0);
factoryRatioBehavior.missileSiloParityTarget = () => 0;
factoryRatioBehavior._dominant = false;

assert.equal(
  factoryRatioBehavior.shouldBuildStructure(UNIT.Factory, 4, false),
  true,
  "the late-game economy fills the third Factory level at four City levels",
);
factoryLevels = 3;
assert.equal(
  factoryRatioBehavior.shouldBuildStructure(UNIT.Factory, 4, false),
  false,
  "the late-game economy stops at the upstream 4:3 City-to-Factory level ratio",
);
factoryLevels = 1;
assert.equal(
  factoryRatioBehavior.shouldBuildStructure(UNIT.Factory, 12, true),
  true,
  "a coastal economy retains the upstream Port-first Factory suppression before dominance",
);
factoryLevels = 2;
assert.equal(
  factoryRatioBehavior.shouldBuildStructure(UNIT.Factory, 12, true),
  false,
  "coastal Factory suppression does not overbuild before the rail payoff can matter",
);
factoryRatioBehavior._dominant = true;
assert.equal(
  factoryRatioBehavior.shouldBuildStructure(UNIT.Factory, 12, true),
  true,
  "a dominant coastal economy restores the full 4:3 ratio while trains can still pay back",
);
testDifficulty = Difficulty.Impossible;

for (const type of [UNIT.MIRV, UNIT.MIRVWarhead]) {
  let targetTile = 200;
  const missile = {
    id: () => 700,
    type: () => type,
    owner: () => ({ smallID: () => 2 }),
    tile: () => 100,
    targetTile: () => targetTile,
    isActive: () => true,
  };
  const fingerprintBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  fingerprintBehavior.cost = () => 1n;
  fingerprintBehavior.player = {
    smallID: () => 1,
    units: () => [],
    isFriendly: () => false,
    isOnSameTeam: () => false,
  };
  fingerprintBehavior.game = {
    players: () => [fingerprintBehavior.player],
    units: (...types) => (types.includes(type) ? [missile] : []),
  };
  const before = fingerprintBehavior.missileDefenseStateFingerprint();
  targetTile = 201;
  assert.notEqual(
    fingerprintBehavior.missileDefenseStateFingerprint(),
    before,
    `${type} trajectory changes invalidate the missile-defense fingerprint`,
  );
}

const affordableUpgradeDespiteExpensiveNewBuildBehavior = Object.create(
  sandbox.__StructureBehavior.prototype,
);
const affordableSamUpgrade = {
  id: () => 1_201,
  type: () => UNIT.SAMLauncher,
  tile: () => 1_201,
  level: () => 1,
  isUnderConstruction: () => false,
};
const authoritativeSamUpgrade = {
  canBuild: false,
  canUpgrade: true,
  cost: 500_000n,
};
let expensiveNewBuildProbes = 0;
affordableUpgradeDespiteExpensiveNewBuildBehavior.structureSpawnEligible = () => true;
affordableUpgradeDespiteExpensiveNewBuildBehavior.getConstructionCost = () => 3_000_000n;
affordableUpgradeDespiteExpensiveNewBuildBehavior.availableGoldAfterReserve = () => 500_000n;
affordableUpgradeDespiteExpensiveNewBuildBehavior.spendableConstructionGold = () => 500_000n;
affordableUpgradeDespiteExpensiveNewBuildBehavior.economicConstructionPressureForSamUpgrade = () =>
  null;
affordableUpgradeDespiteExpensiveNewBuildBehavior.player = {
  units: () => [affordableSamUpgrade],
};
affordableUpgradeDespiteExpensiveNewBuildBehavior.game = {
  config: () => ({
    unitInfo: () => ({ upgradable: true }),
  }),
};
affordableUpgradeDespiteExpensiveNewBuildBehavior.getTotalStructureDensity = () => 1;
affordableUpgradeDespiteExpensiveNewBuildBehavior.findBestStructureToUpgrade = async () => ({
  structure: affordableSamUpgrade,
  bu: authoritativeSamUpgrade,
});
affordableUpgradeDespiteExpensiveNewBuildBehavior.tileInsideActiveHostileMissileImpact = () =>
  false;
affordableUpgradeDespiteExpensiveNewBuildBehavior.structureSpawnTile = async () => {
  expensiveNewBuildProbes++;
  return { canBuild: 1_202, canUpgrade: false };
};
sentBuilds.length = 0;
assert.equal(
  await affordableUpgradeDespiteExpensiveNewBuildBehavior.maybeSpawnStructure(UNIT.SAMLauncher),
  true,
  "an affordable authoritative upgrade is not rejected by an unaffordable new-SAM cost",
);
assert.equal(expensiveNewBuildProbes, 0, "the successful upgrade does not probe a new site");
assert.equal(sentBuilds.at(-1), authoritativeSamUpgrade);

assert.equal(
  typeof sandbox.legendaryMaxEnemySamCapacity,
  "function",
  "Planner exposes the hostile SAM-capacity parity helper",
);
const activeMissileCapacityFallbackBehavior = Object.create(sandbox.__StructureBehavior.prototype);
activeMissileCapacityFallbackBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
activeMissileCapacityFallbackBehavior.missileDefenseSignalSnapshot = () => ({
  hasActiveHostileMissile: true,
});
activeMissileCapacityFallbackBehavior.activeMissileDefenseContext = () => ({});
activeMissileCapacityFallbackBehavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: false,
});
activeMissileCapacityFallbackBehavior.uncoveredActiveMirvDemands = () => [];
activeMissileCapacityFallbackBehavior.maybeUpgradeMissileDefenseSam = async () => false;
activeMissileCapacityFallbackBehavior.activeMissilePendingSamImproves = () => false;
activeMissileCapacityFallbackBehavior.maybeSpawnStructure = async () => false;
activeMissileCapacityFallbackBehavior.hydrogenSamProtectionPlan = () => ({
  currentLevel: 2,
  targetLevel: 5,
});
let activeMissileCapacityUpgradeAttempts = 0;
activeMissileCapacityFallbackBehavior.maybeUpgradePlannedSam = async (plan) => {
  activeMissileCapacityUpgradeAttempts++;
  return plan.targetLevel === 5;
};
assert.equal(
  await activeMissileCapacityFallbackBehavior.handleActiveMissileSamMaximumPriority(),
  true,
