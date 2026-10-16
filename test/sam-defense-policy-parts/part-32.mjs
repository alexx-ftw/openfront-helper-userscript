
let wiredUpgradeCalls = 0;
behavior.maybeUpgradeMissileDefenseSam = async () => {
  wiredUpgradeCalls++;
  return true;
};
behavior.placementsCount = 0;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks reactive SAM upgrades before ordinary construction",
);
assert.equal(wiredUpgradeCalls, 1, "The reactive SAM path is wired into handleStructures");
behavior.maybeSpawnHostileSiloSam = originalMaybeSpawnHostileSiloSam;
behavior.handleActiveMissileSamMaximumPriority = originalActiveMissileMaximumPriority;
behavior.handleHostileSiloSamMaximumPriority = originalHostileSiloSamMaximumPriority;
behavior.maybeEnsureHydrogenStructureCoverage = originalHydrogenStructureCoverage;
behavior.maybeUpgradeHydrogenProtectionSam = originalHydrogenSiloUpgrade;

const economicBudgetBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const economicCandidateLimits = [];
economicBudgetBehavior._economicPlacementDecisionBudget = 25;
economicBudgetBehavior.structureProbeOptions = () => ({
  candidateLimit: 25,
  probeLimit: 25,
  probeTimeoutMs: 1,
  parallelProbeCount: 1,
});
economicBudgetBehavior.structureCandidateTiles = (_type, _options, limit) => {
  economicCandidateLimits.push(limit);
  return Array.from({ length: limit }, (_, index) => index);
};
economicBudgetBehavior.structureTileValueFunction = () => () => 0;
economicBudgetBehavior.structurePlacementCompactnessRanker = () => null;
economicBudgetBehavior.structureMissileEmergency = () => null;
economicBudgetBehavior.isDangerousStructureTile = () => false;
economicBudgetBehavior.probeRankedStructureTiles = async () => null;
assert.equal(await economicBudgetBehavior.structureSpawnTile(UNIT.Factory), null);
assert.equal(
  await economicBudgetBehavior.structureSpawnTile(UNIT.City),
  null,
  "the same construction decision does not grant a second economic placement budget",
);
assert.deepEqual(
  economicCandidateLimits,
  [12, 12],
  "economic placement keeps the normal shared budget while capping each initial worker sample",
);

const samCoverageGuardBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const ownProtectedStructure = { tile: () => 20 };
const alliedProtectedStructure = { tile: () => 30 };
const enemyProtectedStructure = { tile: () => 40 };
const guardedPlayer = {
  isPlayer: () => true,
  smallID: () => 1,
  isFriendly: (other) => other.smallID() === 2,
  units: (type) => (type === UNIT.City ? [ownProtectedStructure] : []),
};
const alliedPlayer = {
  isPlayer: () => true,
  smallID: () => 2,
  units: (type) => (type === UNIT.Factory ? [alliedProtectedStructure] : []),
};
const enemyPlayer = {
  isPlayer: () => true,
  smallID: () => 3,
  units: (type) => (type === UNIT.Port ? [enemyProtectedStructure] : []),
};
samCoverageGuardBehavior.player = guardedPlayer;
samCoverageGuardBehavior.game = {
  players: () => [guardedPlayer, alliedPlayer, enemyPlayer],
  config: () => ({ samRange: () => 5, defaultSamRange: () => 5 }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
assert.deepEqual(
  Array.from(samCoverageGuardBehavior.samProtectableStructureTiles()).sort((a, b) => a - b),
  [20],
  "a preventive SAM centres on our productive structures instead of distant allied buildings",
);
assert.equal(
  samCoverageGuardBehavior.samPlacementProtectsStructure(25, new Set([20, 30])),
  true,
  "a SAM site that covers an own structure remains eligible",
);
assert.equal(
  samCoverageGuardBehavior.samPlacementProtectsStructure(100, new Set([20, 30])),
  false,
  "a SAM site with no protected structure in range is rejected",
);
const guardedSamCandidates = [];
samCoverageGuardBehavior.structureProbeOptions = () => ({
  candidateLimit: 2,
  probeLimit: 2,
  probeTimeoutMs: 1,
  parallelProbeCount: 1,
});
samCoverageGuardBehavior.structureCandidateTiles = () => [100, 25];
samCoverageGuardBehavior.structureTileValueFunction = () => (tile) => tile;
samCoverageGuardBehavior.structurePlacementCompactnessRanker = () => null;
samCoverageGuardBehavior.structureMissileEmergency = () => null;
samCoverageGuardBehavior.isDangerousStructureTile = () => false;
samCoverageGuardBehavior.probeRankedStructureTiles = async (scored) => {
  guardedSamCandidates.push(scored.map(({ t }) => t));
  return null;
};
assert.equal(await samCoverageGuardBehavior.structureSpawnTile(UNIT.SAMLauncher), null);
assert.deepEqual(
  guardedSamCandidates.pop(),
  [25],
  "ordinary and hostile-silo SAM routes cannot select an empty coastal site",
);
assert.equal(
  await samCoverageGuardBehavior.structureSpawnTile(UNIT.SAMLauncher, {
    activeMissileDefense: true,
  }),
  null,
);
assert.deepEqual(
  guardedSamCandidates.pop(),
  [100, 25],
  "a live-missile emergency retains its trajectory-specific placement candidates",
);

const samNetworkBehavior = Object.create(sandbox.__StructureBehavior.prototype);
samNetworkBehavior.game = {
  config: () => ({ samRange: (level) => Number(level) * 10 }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
samNetworkBehavior.legendaryFriendlySamUnits = () => [{ tile: () => 0, level: () => 1 }];
const samNetworkScore = samNetworkBehavior.friendlyUsefulSamPlacementScore(new Set([10, 20]), 8);
assert.ok(
  samNetworkScore(15) > 0,
  "a new SAM prefers a site near a friendly umbrella when it adds coverage to an asset the umbrella reaches after an upgrade",
);
assert.equal(
  samNetworkScore(5),
  0,
  "a new SAM does not clump inside a friendly umbrella when it adds no coverage",
);
assert.equal(samNetworkScore(30), 0, "a distant SAM receives no friendly-network preference");

const recoverySamEmergency = Object.create(sandbox.__StructureBehavior.prototype);
recoverySamEmergency.tileInsideActiveHostileMissileImpact = (tile) => tile === 9;
recoverySamEmergency.activeMissileSamConstructionImproves = () => true;
recoverySamEmergency.missileDefenseSnapshotIsCurrent = () => false;
assert.equal(
  recoverySamEmergency.structureEmergencySamTileAllowed(8, { recoverySam: true }),
  true,
  "a missing first SAM may rebuild outside a current blast even when the current salvo cannot be fully defended",
);
assert.equal(
  recoverySamEmergency.structureEmergencySamTileAllowed(9, { recoverySam: true }),
  false,
  "first-SAM recovery still refuses the active hostile impact zone",
);
assert.equal(
  recoverySamEmergency.structureEmergencySamTileAllowed(9, {
    incrementalSamDefense: true,
    context: {},
    evaluation: {},
  }),
  false,
  "an incremental SAM is never approved inside the active blast even when it improves interception",
);
assert.equal(
  recoverySamEmergency.structureEmergencySnapshotCurrent({ recoverySam: true }),
  true,
  "a changing unrelated missile fingerprint does not cancel safe first-SAM reconstruction",
);

const blastUpgradeBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const blastSam = { id: () => 9, tile: () => 9, level: () => 1 };
blastUpgradeBehavior.plannedSamUpgradeEligible = () => true;
blastUpgradeBehavior.spendableConstructionGold = () => 10n;
blastUpgradeBehavior.plannedSamUpgradeCostCacheKey = () => "blast-sam";
blastUpgradeBehavior._plannedSamUpgradeCostCache = new Map();
blastUpgradeBehavior.plannedSamUpgradeBuildable = async () => ({
  canUpgrade: true,
  cost: 1n,
});
blastUpgradeBehavior.plannedSamUpgradeCost = () => 1n;
blastUpgradeBehavior.samUpgradeEconomyCanAbsorb = () => true;
blastUpgradeBehavior.tileInsideActiveHostileMissileImpact = (tile) => tile === 9;
blastUpgradeBehavior.game = {};
blastUpgradeBehavior.player = {};
sentBuilds.length = 0;
assert.equal(
  await blastUpgradeBehavior.maybeUpgradePlannedSam({
    sam: blastSam,
