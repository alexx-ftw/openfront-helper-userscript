behavior._hostileSiloCapacitySnapshot = null;
enemyB.gold = () => 499_999n;
enemyA.gold = () => 499_999n;
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
assert.equal(
  behavior.hasHostileSiloThreat(),
  false,
  "Gold below the preemptive Silo-funding threshold does not trigger the mandatory SAM without a built silo",
);
behavior.game.players = originalPlayersForSiloGoldThreshold;
enemySilos.units = originalEnemySilosUnits;
enemyB.gold = () => 999_999n;
const originalOwnIsFriendly = own.isFriendly;
const originalEnemySilosGold = enemySilos.gold;
own.isFriendly = (other) => other === enemySilos;
enemySilos.gold = () => 2_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  true,
  "A breakable diplomatic ally with 2M gold remains a nuclear Silo threat",
);
own.isFriendly = originalOwnIsFriendly;
enemySilos.gold = originalEnemySilosGold;
behavior.game.players = () => [own, enemyTeam];
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "A permanent teammate's gold does not open the hostile Silo gate",
);
behavior.game.players = originalPlayersForSiloGoldThreshold;
const originalShouldBuildStructure = behavior.shouldBuildStructure;
const originalMaybeSpawnStructure = behavior.maybeSpawnStructure;
const economicAttemptOrder = [];
behavior.shouldBuildStructure = (type) => type === UNIT.Port || type === UNIT.Factory;
behavior.maybeSpawnStructure = async (type) => {
  economicAttemptOrder.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await behavior.maybePrioritizeEconomicGrowth({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
  }),
  true,
  "Economic priority builds when an eligible economic structure is available",
);
assert.deepEqual(
  economicAttemptOrder,
  [UNIT.Factory],
  "Economic priority attempts the train-producing Factory before a Port",
);
behavior.shouldBuildStructure = originalShouldBuildStructure;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const originalPerceivedCost = behavior.getPerceivedCost;
const originalOwnGold = own.gold;
const highGoldEconomicCalls = [];
behavior.getPerceivedCost = () => 1_000_000n;
own.gold = () => 9_000_000n;
behavior.maybeSpawnStructure = async (type) => {
  highGoldEconomicCalls.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "High-gold pressure requests an affordable economic structure after defensive priorities",
);
assert.deepEqual(
  highGoldEconomicCalls,
  [UNIT.City],
  "High-gold economic construction tries the city first and stops after a successful build",
);
const originalOwnedLevelsForOpeningPort = behavior.ownedLevels;
const openingPortCalls = [];
behavior.ownedLevels = (type) => (type === UNIT.City ? 1 : 0);
behavior.maybeSpawnStructure = async (type) => {
  openingPortCalls.push(type);
  return type === UNIT.Port;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "A coastal nation with its first City gives the first Port the bounded placement probe",
);
assert.deepEqual(
  openingPortCalls,
  [UNIT.Port],
  "The first ocean Port is attempted before City or Factory so their failed probes cannot starve it",
);
behavior.ownedLevels = () => 1;
const establishedEconomyCalls = [];
behavior.maybeSpawnStructure = async (type) => {
  establishedEconomyCalls.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "An established economy opens the next train-producing Factory first",
);
assert.deepEqual(
  establishedEconomyCalls,
  [UNIT.Factory],
  "High-gold fallback prioritizes Factory before surplus Port or City",
);
behavior.ownedLevels = originalOwnedLevelsForOpeningPort;
behavior.getPerceivedCost = originalPerceivedCost;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
own.gold = originalOwnGold;

const originalConstructionCostForLowGold = behavior.getConstructionCost;
const lowGoldEconomicCalls = [];
behavior.getConstructionCost = (type) => (type === UNIT.City ? 4_000_000n : 1_000_000n);
own.gold = () => 1_500_000n;
behavior.maybeSpawnStructure = async (type) => {
  lowGoldEconomicCalls.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "Economic fallback does not wait for 3M before using an affordable structure",
);
assert.deepEqual(
  lowGoldEconomicCalls,
  [UNIT.Factory],
  "Economic fallback skips an unaffordable City and chooses the affordable Factory",
);
behavior.getConstructionCost = originalConstructionCostForLowGold;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
own.gold = originalOwnGold;

own.gold = () => 4_000_000n;
assert.equal(
  behavior.getPerceivedCost(UNIT.City),
  behavior.cost(UNIT.City),
  "winFixes does not inflate City cost while waiting for a global weapon target",
);
assert.equal(
  behavior.getConstructionCost(UNIT.Factory),
  behavior.cost(UNIT.Factory),
  "winFixes does not inflate Factory cost while waiting for a global weapon target",
);
assert.equal(
  behavior.isInPostSaveUpBlockedPhase(),
  false,
  "winFixes never blocks all construction behind the faithful save-up phase",
);
own.gold = originalOwnGold;

const originalReserveForBudget = behavior.legendaryReserveGold;
{
  const budget = Object.create(sandbox.__StructureBehavior.prototype);
  let gold = 1_000_000n;
  let builtThreat = true;
  let income = true;
  let sams = [];
  budget.game = { config: () => ({}) };
  budget.player = { gold: () => gold, units: () => sams };
  budget.ownedLevels = (type) => (type === UNIT.City && income ? 1 : 0);
  budget.hasBuiltHostileSiloThreat = () => builtThreat;
  budget.safeConstructionCost = () => 1_500_000n;
  budget.legendaryAtomWarChest = () => 0n;
  budget.legendaryReserveGold = () => 0n;
  for (const type of [UNIT.City, UNIT.Factory, UNIT.MissileSilo]) {
    assert.equal(
      budget.availableGoldAfterReserve(type),
      0n,
      "ordinary and plateau construction cannot drain the first-SAM fund",
    );
  }
  assert.equal(
    budget.availableGoldAfterReserve(UNIT.Port),
