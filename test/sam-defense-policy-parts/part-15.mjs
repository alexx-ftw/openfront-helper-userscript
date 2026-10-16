const originalDoHandleStructures = behavior.doHandleStructures;
const originalGameConfigForFallback = behavior.game.config;
const originalGameTicksForFallback = behavior.game.ticks;
let fullPathPlacementCalls = 0;
let fullPathTick = 2_000;
behavior.game.ticks = () => fullPathTick;
behavior.game.config = () => ({ isUnitDisabled: () => true });
behavior.maybeUpgradeMissileDefenseSam = async () => false;
behavior.maybeUpgradeSiloForNukeDemand = async () => false;
behavior.maybeUpgradeSamForSiloParity = async () => false;
behavior.samLevelParityGap = () => 1;
behavior.shouldBuildHostileSiloSam = () => true;
behavior.maybeSpawnStructure = async () => {
  fullPathPlacementCalls++;
  fullPathTick += 2;
  return false;
};
behavior.tryBuildDefensePost = async () => false;
behavior.isInPostSaveUpBlockedPhase = () => false;
behavior.doHandleStructures = async () => false;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;
assert.equal(
  await behavior.handleStructures(),
  false,
  "A failed hostile-Silo placement falls through without building another SAM in the same decision",
);
assert.equal(
  fullPathPlacementCalls,
  1,
  "A failed async hostile-Silo placement cannot be duplicated when the game tick advances during probing",
);
behavior.maybeUpgradeMissileDefenseSam = originalReactiveUpgrade;
behavior.maybeUpgradeSiloForNukeDemand = originalSiloDemandUpgrade;
behavior.maybeUpgradeSamForSiloParity = originalParityUpgrade;
behavior.samLevelParityGap = originalSamGap;
behavior.shouldBuildHostileSiloSam = originalShouldBuildHostileSam;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior.tryBuildDefensePost = originalTryBuildDefensePost;
behavior.isInPostSaveUpBlockedPhase = originalIsInPostSaveUpBlockedPhase;
behavior.doHandleStructures = originalDoHandleStructures;
behavior.game.config = originalGameConfigForFallback;
behavior.game.ticks = originalGameTicksForFallback;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;
behavior._hostilePlayersSnapshotTick = null;
behavior._hostilePlayersSnapshot = null;
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
const originalOwnUnits = own.units;
const originalGameConfig = behavior.game.config;
const originalEuclideanDistSquared = behavior.game.euclideanDistSquared;
const protectedStructures = [
  {
    type: () => UNIT.City,
    tile: () => 10,
    level: () => 1,
    isUnderConstruction: () => false,
  },
  {
    type: () => UNIT.Factory,
    tile: () => 20,
    level: () => 1,
    isUnderConstruction: () => false,
  },
];
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [];
  if (types.some((type) => protectedStructures.some((unit) => unit.type() === type))) {
    return protectedStructures;
  }
  return [];
};
behavior.game.config = () => ({
  defaultSamRange: () => 5,
  samRange: () => 5,
});
behavior.game.euclideanDistSquared = (left, right) => (Number(left) - Number(right)) ** 2;
const threatSamValue = behavior.threatSamLauncherValue();
assert.equal(
  threatSamValue(15) > threatSamValue(10),
  true,
  "Threat SAM placement prefers the tile covering more structures",
);

const originalThreatCost = behavior.cost;
const expensiveCluster = [
  { type: () => UNIT.MissileSilo, tile: () => 100, level: () => 1 },
  { type: () => UNIT.City, tile: () => 110, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 200, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 205, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 210, level: () => 1 },
  { type: () => UNIT.Factory, tile: () => 215, level: () => 1 },
];
behavior.cost = (type) => {
  if (type === UNIT.MissileSilo) return 3_000_000n;
  if (type === UNIT.City) return 1_000_000n;
  return 100_000n;
};
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [];
  return expensiveCluster.filter((unit) => types.includes(unit.type()));
};
behavior.game.config = () => ({
  defaultSamRange: () => 15,
  samRange: () => 15,
});
const expensiveClusterValue = behavior.threatSamLauncherValue();
assert.ok(
  expensiveClusterValue(105) > expensiveClusterValue(207),
  "a threat SAM centers on the most expensive own building cluster over a larger cheap cluster",
);
behavior.cost = originalThreatCost;

const existingCoverageSam = {
  tile: () => 0,
  level: () => 1,
  isUnderConstruction: () => false,
};
const uncoveredStructure = {
  type: () => UNIT.City,
  tile: () => 40,
  level: () => 1,
  isUnderConstruction: () => false,
};
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [existingCoverageSam];
  return types.includes(UNIT.City) ? [uncoveredStructure] : [];
};
behavior.game.config = () => ({
  defaultSamRange: () => 25,
  samRange: () => 25,
});
const uncoveredThreatSamValue = behavior.threatSamLauncherValue();
assert.equal(
  uncoveredThreatSamValue(20) > 3,
  true,
  "Threat SAM placement keeps the existing-coverage distinction while favoring the cluster center",
);

const legendaryCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
legendaryCoverageBehavior.player = {
  units: (...types) => (types.includes(UNIT.City) ? [uncoveredStructure] : []),
};
legendaryCoverageBehavior.game = behavior.game;
legendaryCoverageBehavior.legendaryFriendlySamUnits = () => [existingCoverageSam];
legendaryCoverageBehavior.spacingConstants = () => ({ structureSpacing: 10 });
legendaryCoverageBehavior.legendaryCriticalStructureValue = () => 1;
legendaryCoverageBehavior.legendarySamImpactMarginScore = () => 0;
assert.equal(
  legendaryCoverageBehavior.legendarySamCoveragePlacementScore(20, {}),
  10,
  "Legendary SAM placement counts a structure outside the existing SAM range as uncovered",
);

const compactPlacementBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const compactStructures = [{ tile: () => 10 }];
const compactOwnOwner = { smallID: () => 1 };
const compactAllyOwner = { smallID: () => 2 };
const compactSams = [
  {
    id: () => "own-sam",
    tile: () => 80,
    level: () => 1,
    owner: () => compactOwnOwner,
    isUnderConstruction: () => false,
  },
  {
    id: () => "ally-sam",
    tile: () => 40,
    level: () => 1,
    owner: () => compactAllyOwner,
    isUnderConstruction: () => false,
  },
];
compactPlacementBehavior.player = {
  smallID: () => 1,
  isFriendly: (owner) => owner === compactAllyOwner,
  isOnSameTeam: () => false,
  units: (...types) => {
    if (types.length === 1 && types[0] === UNIT.SAMLauncher) {
      return [compactSams[0]];
    }
    return compactStructures;
  },
};
compactPlacementBehavior.game = {
  units: (type) => (type === UNIT.SAMLauncher ? compactSams : []),
  config: () => ({
    defaultSamRange: () => 20,
