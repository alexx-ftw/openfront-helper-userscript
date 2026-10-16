  "A built hostile Silo emits the required SAM upgrade before its first missile",
);
assert.equal(sentBuilds.length, 1, "Structure protection emits one upgrade action");
const literalCostSamBehavior = Object.create(sandbox.__StructureBehavior.prototype);
literalCostSamBehavior.structureSpawnEligible = () => true;
literalCostSamBehavior.cost = () => 3_000_000n;
literalCostSamBehavior.getConstructionCost = () => {
  throw new Error("Emergency SAM must bypass perceived-cost gating");
};
literalCostSamBehavior.availableGoldAfterReserve = () => 3_000_000n;
literalCostSamBehavior.player = { units: () => [] };
literalCostSamBehavior.structureUpgradeBeforeSpawn = async () => null;
const literalCostSamBuildable = { type: UNIT.SAMLauncher, canBuild: 77, canUpgrade: false };
literalCostSamBehavior.structureSpawnTile = async () => literalCostSamBuildable;
const literalCostSamBuildCount = sentBuilds.length;
assert.equal(
  await literalCostSamBehavior.maybeSpawnStructure(UNIT.SAMLauncher, {
    allowPreemptiveSam: true,
    forceNewStructure: true,
    useActualCost: true,
  }),
  true,
  "A hostile-Silo SAM builds when literal gold covers its authoritative cost",
);
assert.equal(sentBuilds.length, literalCostSamBuildCount + 1);
assert.equal(sentBuilds.at(-1), literalCostSamBuildable);
assert.equal(
  structureCoverageDistanceCalls,
  firstCoverageDistanceCalls,
  "Repeated coverage consumers reuse one SAM-versus-structure geometry plan per tick",
);
structureCoverageTick++;
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan().targetLevel,
  2,
  "Unchanged SAM and structure geometry preserves the coverage plan across ticks",
);
assert.equal(
  structureCoverageDistanceCalls,
  firstCoverageDistanceCalls,
  "Unchanged geometry is not recomputed merely because the game tick advanced",
);
coverageSamLevel = 2;
structureCoverageTick++;
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan(),
  null,
  "A SAM at the planned level covers all own structures",
);

const jointCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
jointCoverageBehavior.player = {
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [makeUnit(0, 1), makeUnit(100, 1)];
    if (type === UNIT.City) return [{ tile: () => 0 }, { tile: () => 100 }];
    return [];
  },
};
jointCoverageBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
jointCoverageBehavior.liveNuclearHostilePlayers = () => [enemyTwoLevelOneSilos];
assert.equal(
  jointCoverageBehavior.computeHydrogenStructureCoveragePlan(),
  null,
  "Joint coverage by existing SAMs does not request another physical site",
);

const criticalSamClusterBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const criticalClusterSam = (tile, level) => ({
  tile: () => tile,
  level: () => level,
  isUnderConstruction: () => false,
  isActive: () => true,
});
const criticalClusterStructure = (type, tile, level = 1) => ({
  type: () => type,
  tile: () => tile,
  level: () => level,
});
const expensiveClusterStructures = [
  criticalClusterStructure(UNIT.City, 100, 3),
  criticalClusterStructure(UNIT.Factory, 104, 3),
  criticalClusterStructure(UNIT.Port, 108, 2),
];
const isolatedStructure = criticalClusterStructure(UNIT.City, 900, 1);
const isolatedSam = criticalClusterSam(900, 4);
const centralClusterSam = criticalClusterSam(104, 1);
criticalSamClusterBehavior.player = {
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [isolatedSam, centralClusterSam];
    if (type === UNIT.City) return [expensiveClusterStructures[0], isolatedStructure];
    if (type === UNIT.Factory) return [expensiveClusterStructures[1]];
    if (type === UNIT.Port) return [expensiveClusterStructures[2]];
    return [];
  },
};
criticalSamClusterBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    defaultSamRange: () => 20,
    samRange: (level) => Number(level) * 20,
  }),
};
criticalSamClusterBehavior.safeStructureCost = (type) => {
  if (type === UNIT.Factory) return 2_000_000n;
  if (type === UNIT.Port) return 1_000_000n;
  return 750_000n;
};
assert.deepEqual(
  Array.from(criticalSamClusterBehavior.prependCriticalSamClusterTiles([900, 106, 500], 4)),
  [106, 900, 500],
  "a coverage-priority SAM probes the legal candidate nearest the weighted centre of the expensive building cluster first",
);
assert.deepEqual(
  Array.from(criticalSamClusterBehavior.prependCriticalSamClusterAnchors([900, 500], 4)),
  [104, 100, 108, 900],
  "a coverage-priority SAM deterministically seeds legal probes at the expensive cluster centre instead of depending on a random territory sample",
);
criticalSamClusterBehavior.shouldPrioritizeHydrogenSamProtection = () => true;
criticalSamClusterBehavior.externalSiloLevelSumTarget = () => 1;
let criticalStructureSnapshotReads = 0;
const readCriticalStructureEntries = criticalSamClusterBehavior.samCriticalStructureEntries.bind(
  criticalSamClusterBehavior,
);
criticalSamClusterBehavior.samCriticalStructureEntries = () => {
  criticalStructureSnapshotReads++;
  return readCriticalStructureEntries();
};
assert.strictEqual(
  criticalSamClusterBehavior.hydrogenSamProtectionPlan().sam,
  centralClusterSam,
  "level-five escalation upgrades the SAM covering the expensive core before an isolated higher-level launcher",
);
assert.equal(
  criticalStructureSnapshotReads,
  1,
  "level-five SAM ranking snapshots critical structures once instead of once per sort comparison",
);

const originalGetPerceivedCost = behavior.getPerceivedCost;
const originalStructureSpawnTile = behavior.structureSpawnTile;
const originalGetTotalStructureDensity = behavior.getTotalStructureDensity;
behavior.structureSpawnTile = async () => ({ canBuild: true, canUpgrade: false });
behavior.getTotalStructureDensity = () => 0;
const buildsBeforeSiloGate = sentBuilds.length;
const originalOwnGoldForDirectSilo = own.gold;
own.gold = () => 100_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  false,
  "The direct silo spawn path preserves the economy reserve when surplus is insufficient",
);
hostileAttemptTick++;
enemyB.gold = () => 1_000_000n;
own.gold = () => 5_000_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  true,
  "The direct silo spawn path reopens when surplus covers the economy reserve",
);
assert.equal(
  sentBuilds.length,
  buildsBeforeSiloGate + 1,
  "Only the threshold-opened direct silo attempt reaches the build menu",
);
enemyB.gold = () => 999_999n;
own.gold = originalOwnGoldForDirectSilo;
behavior.getPerceivedCost = originalGetPerceivedCost;
behavior.structureSpawnTile = originalStructureSpawnTile;
behavior.getTotalStructureDensity = originalGetTotalStructureDensity;
own.silos = [makeUnit(101, 6)];
assert.equal(
  behavior.missileSiloParityGap(),
  0,
  "A level sum equal to the strongest enemy SAM stack closes the parity gap",
);
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 0, false),
  false,
  "Silo parity stops requesting more capacity once the target is reached",
);
assert.equal(
  typeof behavior.enemyMissileSiloCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile Silo-capacity parity target",
