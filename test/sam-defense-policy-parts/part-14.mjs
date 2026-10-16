await behavior.maybeSpawnHostileSiloSam();
assert.equal(
  failedHostileSamCalls.length,
  2,
  "A failed dedicated SAM request is retried after the placement backoff expires",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;

const originalReservedSlotMaybeUpgradeLegendarySam = behavior.maybeUpgradeLegendarySam;
const originalReservedSlotMaybeUpgradeHydrogenProtectionSam =
  behavior.maybeUpgradeHydrogenProtectionSam;
const originalReservedSlotMaybeOpenLegendaryArsenal = behavior.maybeOpenLegendaryArsenal;
const originalReservedSlotMaybeSpawnHostileSiloSam = behavior.maybeSpawnHostileSiloSam;
const originalReservedSlotOwnSamCapacity = behavior.ownSamCapacity;
const originalReservedSlotOwnProjectedSamCapacity = behavior.ownProjectedSamCapacity;
const originalReservedSlotShouldBuildHostileSiloSam = behavior.shouldBuildHostileSiloSam;
const originalReservedSlotHostileSiloSamActionBlocked = behavior.hostileSiloSamActionBlocked;
const originalReservedSlotMaybeOpenLegendaryFirstSilo = behavior.maybeOpenLegendaryFirstSilo;
const originalReservedSlotMaybeArmFreezeStrikeSilo = behavior.maybeArmFreezeStrikeSilo;
const originalReservedSlotMaybeUpgradeSiloForNuclearSlotPressure =
  behavior.maybeUpgradeSiloForNuclearSlotPressure;
const originalReservedSlotMaybeUpgradeSiloFromSurplus = behavior.maybeUpgradeSiloFromSurplus;
const originalReservedSlotMaybeUpgradeSamForSiloParity = behavior.maybeUpgradeSamForSiloParity;
const originalReservedSlotLegendaryMissileDefenseUrgent = behavior.legendaryMissileDefenseUrgent;
const originalReservedSlotLegendaryConstructionCandidates =
  behavior.legendaryConstructionCandidates;
const legendaryPostSamAttempts = [];
behavior.maybeUpgradeLegendarySam = async () => false;
behavior.maybeUpgradeHydrogenProtectionSam = async () => false;
behavior.maybeOpenLegendaryArsenal = async () => false;
behavior.maybeSpawnHostileSiloSam = async () => false;
behavior.ownSamCapacity = () => 1;
behavior.ownProjectedSamCapacity = () => 1;
behavior.shouldBuildHostileSiloSam = () => true;
behavior.hostileSiloSamActionBlocked = () => true;
behavior.legendaryMissileDefenseUrgent = () => false;
behavior.maybeOpenLegendaryFirstSilo = async () => false;
behavior.maybeArmFreezeStrikeSilo = async () => false;
behavior.maybeUpgradeSiloForNuclearSlotPressure = async () => false;
behavior.maybeUpgradeSiloFromSurplus = async () => false;
behavior.legendaryConstructionCandidates = () => [{ type: UNIT.City, cost: 0n, score: 1 }];
behavior.maybeUpgradeSamForSiloParity = async () => {
  legendaryPostSamAttempts.push("upgrade");
  return false;
};
behavior.maybeSpawnStructure = async (type) => {
  legendaryPostSamAttempts.push(type);
  return true;
};
assert.equal(
  await behavior.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: true,
  }),
  true,
  "Legendary continues productive construction while the mandatory hostile-Silo SAM is backed off",
);
assert.deepEqual(
  legendaryPostSamAttempts,
  [UNIT.City],
  "Legendary sends ordinary construction through the shared ranked selector after a SAM retry",
);
behavior.maybeUpgradeLegendarySam = originalReservedSlotMaybeUpgradeLegendarySam;
behavior.maybeUpgradeHydrogenProtectionSam = originalReservedSlotMaybeUpgradeHydrogenProtectionSam;
behavior.maybeOpenLegendaryArsenal = originalReservedSlotMaybeOpenLegendaryArsenal;
behavior.maybeSpawnHostileSiloSam = originalReservedSlotMaybeSpawnHostileSiloSam;
behavior.ownSamCapacity = originalReservedSlotOwnSamCapacity;
behavior.ownProjectedSamCapacity = originalReservedSlotOwnProjectedSamCapacity;
behavior.shouldBuildHostileSiloSam = originalReservedSlotShouldBuildHostileSiloSam;
behavior.hostileSiloSamActionBlocked = originalReservedSlotHostileSiloSamActionBlocked;
behavior.maybeOpenLegendaryFirstSilo = originalReservedSlotMaybeOpenLegendaryFirstSilo;
behavior.maybeArmFreezeStrikeSilo = originalReservedSlotMaybeArmFreezeStrikeSilo;
behavior.maybeUpgradeSiloForNuclearSlotPressure =
  originalReservedSlotMaybeUpgradeSiloForNuclearSlotPressure;
behavior.maybeUpgradeSiloFromSurplus = originalReservedSlotMaybeUpgradeSiloFromSurplus;
behavior.maybeUpgradeSamForSiloParity = originalReservedSlotMaybeUpgradeSamForSiloParity;
behavior.legendaryMissileDefenseUrgent = originalReservedSlotLegendaryMissileDefenseUrgent;
behavior.legendaryConstructionCandidates = originalReservedSlotLegendaryConstructionCandidates;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

assert.equal(
  behavior.hasStructureUnderConstruction([makeUnit(950, 5, { underConstruction: false })]),
  false,
  "a completed or max-level structure cannot masquerade as pending construction",
);
assert.equal(
  behavior.hasStructureUnderConstruction([makeUnit(951, 1, { underConstruction: true })]),
  true,
  "a real same-type construction still blocks duplicate placement",
);

const originalDemandDrivenUpgradeLegendarySam = behavior.maybeUpgradeLegendarySam;
const originalDemandDrivenUpgradeHydrogenSam = behavior.maybeUpgradeHydrogenProtectionSam;
const originalDemandDrivenSpawnHostileSam = behavior.maybeSpawnHostileSiloSam;
const originalDemandDrivenShouldBuildHostileSam = behavior.shouldBuildHostileSiloSam;
const originalDemandDrivenOwnSamCapacity = behavior.ownSamCapacity;
const originalDemandDrivenOwnProjectedSamCapacity = behavior.ownProjectedSamCapacity;
const originalDemandDrivenParityUpgrade = behavior.maybeUpgradeSamForSiloParity;
const originalDemandDrivenUrgent = behavior.legendaryMissileDefenseUrgent;
const originalDemandDrivenCandidates = behavior.legendaryConstructionCandidates;
const demandDrivenActions = [];
behavior.maybeUpgradeLegendarySam = async () => false;
behavior.maybeUpgradeHydrogenProtectionSam = async () => {
  demandDrivenActions.push("hydrogen-upgrade");
  return true;
};
behavior.maybeSpawnHostileSiloSam = async () => {
  demandDrivenActions.push("second-sam");
  return true;
};
behavior.shouldBuildHostileSiloSam = () => true;
behavior.ownSamCapacity = () => 1;
behavior.ownProjectedSamCapacity = () => 1;
behavior.maybeUpgradeSamForSiloParity = async () => {
  demandDrivenActions.push("parity-upgrade");
  return true;
};
behavior.legendaryMissileDefenseUrgent = () => false;
behavior.legendaryConstructionCandidates = () => [
  { type: UNIT.City, cost: 1n, legal: true, gold: 1, troops: 1 },
];
behavior.maybeUpgradeSiloFromSurplus = async () => false;
behavior.maybeSpawnStructure = async (type) => {
  demandDrivenActions.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 1,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  }),
  true,
  "Legendary keeps constructing after its first SAM when no missile is incoming",
);
assert.deepEqual(
  demandDrivenActions,
  [UNIT.City],
  "Passive hydrogen and silo parity do not repeatedly level the first Legendary SAM",
);
behavior.maybeUpgradeLegendarySam = originalDemandDrivenUpgradeLegendarySam;
behavior.maybeUpgradeHydrogenProtectionSam = originalDemandDrivenUpgradeHydrogenSam;
behavior.maybeSpawnHostileSiloSam = originalDemandDrivenSpawnHostileSam;
behavior.shouldBuildHostileSiloSam = originalDemandDrivenShouldBuildHostileSam;
behavior.ownSamCapacity = originalDemandDrivenOwnSamCapacity;
behavior.ownProjectedSamCapacity = originalDemandDrivenOwnProjectedSamCapacity;
behavior.maybeUpgradeSamForSiloParity = originalDemandDrivenParityUpgrade;
behavior.legendaryMissileDefenseUrgent = originalDemandDrivenUrgent;
behavior.legendaryConstructionCandidates = originalDemandDrivenCandidates;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const constructionBlockedCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  constructionBlockedCalls.push(args);
  return true;
};
own.sams = [makeUnit(999, 1, { underConstruction: true })];
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A pending SAM construction blocks another dedicated hostile-Silo placement",
);
assert.equal(
  constructionBlockedCalls.length,
  0,
  "A pending SAM construction avoids a second expensive placement probe",
);
own.sams = [];
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const originalReactiveUpgrade = behavior.maybeUpgradeMissileDefenseSam;
const originalSiloDemandUpgrade = behavior.maybeUpgradeSiloForNukeDemand;
const originalParityUpgrade = behavior.maybeUpgradeSamForSiloParity;
const originalSamGap = behavior.samLevelParityGap;
const originalShouldBuildHostileSam = behavior.shouldBuildHostileSiloSam;
const originalTryBuildDefensePost = behavior.tryBuildDefensePost;
const originalIsInPostSaveUpBlockedPhase = behavior.isInPostSaveUpBlockedPhase;
