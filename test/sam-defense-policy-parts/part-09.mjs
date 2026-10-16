const defensePostProbeRounds = [];
defensePostFallbackBehavior.buildFirstDefensePost = async (tiles) => {
  defensePostProbeRounds.push([...tiles]);
  return false;
};
assert.equal(
  await defensePostFallbackBehavior.tryBuildDefensePost(),
  false,
  "an unbuildable depth-safe sample does not fall back onto the exposed border",
);
assert.deepEqual(
  defensePostProbeRounds,
  [[11]],
  "the Defense Post probes only the bounded depth-safe sample",
);

const defensePostDepthRankBehavior = Object.create(sandbox.__StructureBehavior.prototype);
defensePostDepthRankBehavior.game = {
  config: () => ({ defensePostRange: () => 30 }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
defensePostDepthRankBehavior.rankStructureTilesBySamProtection = (tiles) => [...tiles];
assert.deepEqual(
  defensePostDepthRankBehavior.rankDefensePostTiles([11, 20], [0]),
  [20, 11],
  "equal-coverage Defense Post candidates prefer the deeper survivable tile",
);

const hostileSiloMaximumPriorityBehavior = Object.create(sandbox.__StructureBehavior.prototype);
hostileSiloMaximumPriorityBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
hostileSiloMaximumPriorityBehavior.hasPlacedSiloOnMap = () => true;
hostileSiloMaximumPriorityBehavior.hasBuiltHostileSiloThreat = () => true;
hostileSiloMaximumPriorityBehavior.shouldBuildSiloTriggeredSam = () => true;
hostileSiloMaximumPriorityBehavior.shouldReserveHostileSiloSamBudget = () => true;
let maximumPrioritySamResult = false;
let maximumPrioritySamAttempts = 0;
let lowerPriorityConstructionCalls = 0;
hostileSiloMaximumPriorityBehavior.maybeSpawnHostileSiloSam = async () => {
  maximumPrioritySamAttempts++;
  return maximumPrioritySamResult;
};
hostileSiloMaximumPriorityBehavior.handleImmediateStructureDefense = async () => {
  lowerPriorityConstructionCalls++;
  return true;
};
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  false,
  "A failed hostile-Silo SAM placement reserves the entire construction slot",
);
assert.equal(maximumPrioritySamAttempts, 1);
assert.equal(
  lowerPriorityConstructionCalls,
  0,
  "No economy, naval, Defense Post, or offensive construction runs before the required SAM",
);
maximumPrioritySamResult = true;
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  true,
  "A successful maximum-priority SAM placement consumes the construction slot",
);
assert.equal(maximumPrioritySamAttempts, 2);
assert.equal(lowerPriorityConstructionCalls, 0);

maximumPrioritySamResult = false;
hostileSiloMaximumPriorityBehavior.hydrogenSamProtectionPlan = () => ({
  currentLevel: 1,
  targetLevel: 5,
});
let triggeredSamUpgradeAttempts = 0;
hostileSiloMaximumPriorityBehavior.maybeUpgradePlannedSam = async (plan) => {
  triggeredSamUpgradeAttempts++;
  return plan.targetLevel === 5;
};
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  true,
  "a completed external Silo upgrades an existing SAM before the placement-reserve branch can strand it at level one",
);
assert.equal(triggeredSamUpgradeAttempts, 1);
assert.equal(lowerPriorityConstructionCalls, 0);

hostileSiloMaximumPriorityBehavior.hydrogenSamProtectionPlan = () => null;
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleHostileSiloSamMaximumPriority(),
  false,
  "a visible external Silo keeps the first-SAM fund reserved even during simultaneous land pressure",
);

hostileSiloMaximumPriorityBehavior.shouldBuildSiloTriggeredSam = () => false;
hostileSiloMaximumPriorityBehavior.hydrogenSamProtectionPlan = () => ({
  currentLevel: 1,
  targetLevel: 5,
});
hostileSiloMaximumPriorityBehavior.maybeUpgradePlannedSam = async () => false;
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleBuiltHostileSiloSamUpgrade(),
  false,
  "an unaffordable level-five SAM upgrade reserves the construction slot instead of funding economy",
);
assert.equal(lowerPriorityConstructionCalls, 0);

const preemptiveHostileGoldBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let preemptiveHostileGoldSamCalls = 0;
preemptiveHostileGoldBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
preemptiveHostileGoldBehavior.hasPlacedSiloOnMap = () => false;
preemptiveHostileGoldBehavior.shouldBuildHostileSiloSam = () => true;
preemptiveHostileGoldBehavior.shouldBuildSiloTriggeredSam = () => false;
preemptiveHostileGoldBehavior.maybeSpawnHostileSiloSam = async () => {
  preemptiveHostileGoldSamCalls++;
  return true;
};
assert.equal(
  await preemptiveHostileGoldBehavior.handleHostileSiloSamMaximumPriority(),
  true,
  "hostile silo funding starts our first SAM before the enemy launcher appears",
);
assert.equal(preemptiveHostileGoldSamCalls, 1);

const preemptiveSamReserveBehavior = Object.create(sandbox.__StructureBehavior.prototype);
preemptiveSamReserveBehavior.ownedLevels = () => 0;
assert.equal(
  preemptiveSamReserveBehavior.shouldReserveHostileSiloSamBudget(),
  false,
  "a zero-income opening keeps construction available so it can establish its first income site",
);
preemptiveSamReserveBehavior.ownedLevels = () => 1;
assert.equal(
  preemptiveSamReserveBehavior.shouldReserveHostileSiloSamBudget(),
  true,
  "an established economy reserves every partial fund for the first SAM after an external Silo",
);

const poorPreemptiveHostileGoldBehavior = Object.create(sandbox.__StructureBehavior.prototype);
poorPreemptiveHostileGoldBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
poorPreemptiveHostileGoldBehavior.hasPlacedSiloOnMap = () => false;
poorPreemptiveHostileGoldBehavior.shouldBuildHostileSiloSam = () => true;
poorPreemptiveHostileGoldBehavior.shouldBuildSiloTriggeredSam = () => false;
poorPreemptiveHostileGoldBehavior.maybeSpawnHostileSiloSam = async () => false;
poorPreemptiveHostileGoldBehavior.shouldReserveHostileSiloSamBudget = () => true;
assert.equal(
  await poorPreemptiveHostileGoldBehavior.handleHostileSiloSamMaximumPriority(),
  null,
  "an unaffordable preemptive SAM forecast does not starve an opening economy before a Silo exists",
);

const ffaPreemptiveReserveBehavior = Object.create(sandbox.__StructureBehavior.prototype);
ffaPreemptiveReserveBehavior.game = {
  config: () => ({
    isUnitDisabled: () => false,
    gameConfig: () => ({ gameMode: "Free For All" }),
  }),
};
ffaPreemptiveReserveBehavior.hasPlacedSiloOnMap = () => false;
ffaPreemptiveReserveBehavior.hasBuiltHostileSiloThreat = () => false;
ffaPreemptiveReserveBehavior.shouldBuildHostileSiloSam = () => true;
ffaPreemptiveReserveBehavior.shouldBuildSiloTriggeredSam = () => false;
ffaPreemptiveReserveBehavior.maybeSpawnHostileSiloSam = async () => false;
ffaPreemptiveReserveBehavior.shouldReserveHostileSiloSamBudget = () => true;
assert.equal(
  await ffaPreemptiveReserveBehavior.handleHostileSiloSamMaximumPriority(),
  false,
  "an explicit FFA forecast reserves the first-SAM fund during the hostile silo saving window",
);

const pendingSiloPriorityBehavior = Object.create(sandbox.__StructureBehavior.prototype);
pendingSiloPriorityBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
pendingSiloPriorityBehavior.hasPlacedSiloOnMap = () => true;
pendingSiloPriorityBehavior.hasBuiltHostileSiloThreat = () => false;
pendingSiloPriorityBehavior.shouldBuildHostileSiloSam = () => false;
pendingSiloPriorityBehavior.shouldBuildSiloTriggeredSam = () => true;
pendingSiloPriorityBehavior.maybeSpawnHostileSiloSam = async () => false;
pendingSiloPriorityBehavior.hydrogenSamProtectionPlan = () => null;
pendingSiloPriorityBehavior.shouldReserveHostileSiloSamBudget = () => true;
assert.equal(
  await pendingSiloPriorityBehavior.handleHostileSiloSamMaximumPriority(),
  null,
  "an enemy Silo under construction permits anticipatory SAM attempts without hard-reserving the whole economy",
);
hostileSiloMaximumPriorityBehavior.shouldBuildSiloTriggeredSam = () => false;
hostileSiloMaximumPriorityBehavior.hydrogenSamProtectionPlan = () => ({
