
const launchGateBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let hostileMissileActive = false;
launchGateBehavior._hostileMissileLaunchObserved = false;
launchGateBehavior.activeHostileMissileSnapshot = () => hostileMissileActive;
assert.equal(
  launchGateBehavior.hasObservedHostileMissileLaunch(),
  false,
  "A hostile Silo alone does not unlock SAM construction",
);
assert.equal(
  await launchGateBehavior.maybeSpawnStructure(UNIT.SAMLauncher),
  false,
  "An ordinary SAM cannot be constructed before the first hostile missile launch",
);
launchGateBehavior.shouldReserveEconomicGrowthForOffense = () => false;
launchGateBehavior.getConstructionCost = () => 1_500_000n;
launchGateBehavior.availableGoldAfterReserve = () => 2_000_000n;
launchGateBehavior.player = { units: () => [] };
launchGateBehavior.structureUpgradeBeforeSpawn = async () => null;
const preemptiveSamBuildable = { canBuild: 123, canUpgrade: false };
launchGateBehavior.structureSpawnTile = async () => preemptiveSamBuildable;
const preemptiveBuildCount = sentBuilds.length;
assert.equal(
  await launchGateBehavior.maybeSpawnStructure(UNIT.SAMLauncher, {
    allowPreemptiveSam: true,
    forceNewStructure: true,
  }),
  true,
  "A threat-authorized SAM can be built with 2M gold before the first launch",
);
assert.equal(sentBuilds.length, preemptiveBuildCount + 1);
assert.equal(sentBuilds.at(-1), preemptiveSamBuildable);

const originalEconomicBuildDifficulty = testDifficulty;
const originalEconomicBuildLegendaryCheck = sandbox.isLegendaryDifficulty;
testDifficulty = Difficulty.Legendary;
sandbox.isLegendaryDifficulty = () => true;
const economicBuildFirstBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const existingEconomicStructure = { isUnderConstruction: () => false, level: () => 1 };
let economicUpgradeCalls = 0;
const newCityBuildable = { canBuild: 456, canUpgrade: false };
economicBuildFirstBehavior.structureSpawnEligible = () => true;
economicBuildFirstBehavior.getConstructionCost = () => 1n;
economicBuildFirstBehavior.availableGoldAfterReserve = () => 10n;
economicBuildFirstBehavior.player = { units: () => [existingEconomicStructure] };
economicBuildFirstBehavior.getOrBuildFactoryTradeDestinations = () => [{ tile: 1 }];
economicBuildFirstBehavior.hasStructureUnderConstruction = () => false;
economicBuildFirstBehavior.structureSpawnTile = async () => newCityBuildable;
economicBuildFirstBehavior.structureUpgradeBeforeSpawn = async () => {
  economicUpgradeCalls++;
  return true;
};
economicBuildFirstBehavior.maybeUpgradeStructure = async () => {
  economicUpgradeCalls++;
  return true;
};
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.City),
  true,
  "An economic structure uses a legal new site before considering an upgrade",
);
assert.equal(economicUpgradeCalls, 0, "A legal new City site performs no upgrade probe");
assert.equal(sentBuilds.at(-1), newCityBuildable);

for (const type of [UNIT.Factory, UNIT.Port]) {
  const legalNewBuildBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  let upgradeProbeCount = 0;
  const legalBuildable = { canBuild: `${type}-new-site`, canUpgrade: false };
  legalNewBuildBehavior.structureSpawnEligible = () => true;
  legalNewBuildBehavior.getConstructionCost = () => 1n;
  legalNewBuildBehavior.availableGoldAfterReserve = () => 10n;
  legalNewBuildBehavior.player = {
    units: () => [existingEconomicStructure],
  };
  legalNewBuildBehavior.getOrBuildFactoryTradeDestinations = () => [{ tile: 1 }];
  legalNewBuildBehavior.hasStructureUnderConstruction = () => false;
  legalNewBuildBehavior.structureSpawnTile = async () => legalBuildable;
  legalNewBuildBehavior.structureUpgradeBeforeSpawn = async () => {
    upgradeProbeCount++;
    return true;
  };
  legalNewBuildBehavior.maybeUpgradeStructure = async () => {
    upgradeProbeCount++;
    return true;
  };
  assert.equal(
    await legalNewBuildBehavior.maybeSpawnStructure(type),
    true,
    `${type} uses a legal new site before considering an upgrade`,
  );
  assert.equal(upgradeProbeCount, 0, `A legal new ${type} site performs no upgrade probe`);
  assert.equal(sentBuilds.at(-1), legalBuildable);
}

const urgentLegendarySamCostBehavior = Object.create(sandbox.__StructureBehavior.prototype);
urgentLegendarySamCostBehavior.maybeUpgradeLegendarySam = async () => false;
urgentLegendarySamCostBehavior.ownSamCapacity = () => 1;
urgentLegendarySamCostBehavior.ownProjectedSamCapacity = () => 1;
urgentLegendarySamCostBehavior.legendaryMissileDefenseUrgent = () => true;
let urgentLegendarySamOptions = null;
urgentLegendarySamCostBehavior.maybeSpawnStructure = async (type, options) => {
  assert.equal(type, UNIT.SAMLauncher);
  urgentLegendarySamOptions = options;
  return true;
};
assert.equal(
  await urgentLegendarySamCostBehavior.doHandleLegendaryStructures({}),
  true,
  "Legendary handles an urgent missile-defense construction before ordinary candidates",
);
assert.equal(
  urgentLegendarySamOptions?.useActualCost,
  true,
  "Legendary urgent SAM construction uses the authoritative engine cost",
);
assert.equal(
  urgentLegendarySamOptions?.prioritizeStructureCoverage,
  true,
  "Legendary urgent SAM construction ranks placements by added defensive coverage",
);
assert.equal(
  urgentLegendarySamOptions?.activeMissileDefense,
  true,
  "Legendary urgent SAM placements must improve the active interception schedule",
);

const originalLegalBuildLegendaryCheck = sandbox.isLegendaryDifficulty;
sandbox.isLegendaryDifficulty = () => true;
for (const type of [UNIT.City, UNIT.Factory, UNIT.Port]) {
  const legendaryLegalBuildBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  let upgradeProbeCount = 0;
  const candidate = { type };
  if (type === UNIT.Port) candidate.portPlacementTile = 1;
  else if (type === UNIT.Factory) {
    candidate.factoryPlacementTile = `${type}-legendary-site`;
  } else {
    candidate.cityPlacementTile = `${type}-legendary-site`;
  }
  const legalBuildable = {
    type,
    canBuild: type === UNIT.Port ? 1 : `${type}-legendary-site`,
    canUpgrade: false,
  };
  installLegalEconomyDispatchFixture(legendaryLegalBuildBehavior, legalBuildable.canBuild);
  legendaryLegalBuildBehavior.player = {
    gold: () => 10n,
    units: (unitType) =>
      [UNIT.City, UNIT.Factory, UNIT.Port].includes(unitType) ? [existingEconomicStructure] : [],
  };
  legendaryLegalBuildBehavior.getOrBuildFactoryTradeDestinations = () => [{ tile: 1 }];
  legendaryLegalBuildBehavior.maybeUpgradeLegendarySam = async () => false;
  legendaryLegalBuildBehavior.maybeOpenLegendaryArsenal = async () => false;
  legendaryLegalBuildBehavior.maybeOpenLegendaryFirstSilo = async () => false;
  legendaryLegalBuildBehavior.maybeArmFreezeStrikeSilo = async () => false;
  legendaryLegalBuildBehavior.maybeUpgradeSiloForNuclearSlotPressure = async () => false;
  legendaryLegalBuildBehavior.maybeUpgradeSiloFromSurplus = async () => false;
  legendaryLegalBuildBehavior.ownSamCapacity = () => 1;
  legendaryLegalBuildBehavior.ownProjectedSamCapacity = () => 1;
  legendaryLegalBuildBehavior.legendaryMissileDefenseUrgent = () => false;
  legendaryLegalBuildBehavior.legendaryConstructionCandidates = () => [candidate];
  legendaryLegalBuildBehavior.legendaryConstructionActionGroups = () => [[candidate]];
  legendaryLegalBuildBehavior.structureSpawnEligible = () => true;
  legendaryLegalBuildBehavior.cost = () => 1n;
  legendaryLegalBuildBehavior.getConstructionCost = () => 1n;
  legendaryLegalBuildBehavior.availableGoldAfterReserve = () => 10n;
  legendaryLegalBuildBehavior.hasStructureUnderConstruction = () => false;
  legendaryLegalBuildBehavior.structureSpawnTile = async () => legalBuildable;
  legendaryLegalBuildBehavior.isSafeBuildablePlacement = () => true;
  legendaryLegalBuildBehavior.structureUpgradeBeforeSpawn = async () => {
    upgradeProbeCount++;
    return true;
  };
  legendaryLegalBuildBehavior.maybeUpgradeStructure = async () => {
    upgradeProbeCount++;
    return true;
  };
  assert.equal(
    await legendaryLegalBuildBehavior.doHandleLegendaryStructures({
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
    `Legendary dispatches a legal new ${type} site`,
