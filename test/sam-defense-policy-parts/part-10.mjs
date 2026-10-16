  currentLevel: 1,
  targetLevel: 2,
});
let maximumPrioritySamUpgradeAttempts = 0;
hostileSiloMaximumPriorityBehavior.maybeUpgradePlannedSam = async () => {
  maximumPrioritySamUpgradeAttempts++;
  return true;
};
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleStructures(),
  true,
  "A level-1 SAM upgrade for H-bomb defense remains above all lower-priority construction",
);
assert.equal(maximumPrioritySamUpgradeAttempts, 1);
assert.equal(lowerPriorityConstructionCalls, 0);
hostileSiloMaximumPriorityBehavior.hasPlacedSiloOnMap = () => false;
assert.equal(
  await hostileSiloMaximumPriorityBehavior.handleHostileSiloSamMaximumPriority(),
  null,
  "Enemy gold without a placed hostile Silo does not hard-reserve construction",
);
assert.equal(maximumPrioritySamAttempts, 4);

assert.equal(
  typeof behavior.enemySamCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile SAM parity target",
);
assert.equal(
  typeof behavior.hasHostileReachedSiloGoldThreshold,
  "function",
  "Structure behavior exposes the hostile silo-gold threshold check",
);
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "All hostile players below 1M gold keep the economy priority active",
);
assert.equal(
  behavior.shouldPrioritizeEconomicGrowth(),
  true,
  "Economic growth is prioritized while no hostile can afford a silo",
);
assert.equal(
  behavior.economicConstructionPressure()?.type,
  UNIT.Factory,
  "The next affordable productive structure remains visible to the policy",
);
const productiveSpend = behavior.economicConstructionPressure();
assert.ok(productiveSpend?.cost > 0n);
const originalSamEconomicPressure = behavior.economicConstructionPressureForSamUpgrade;
behavior.economicConstructionPressureForSamUpgrade = () => productiveSpend;
const originalOwnGoldForSamSurplus = own.gold;
own.gold = () => 3_000_000n + productiveSpend.cost - 1n;
assert.equal(
  behavior.samUpgradeEconomyCanAbsorb(3_000_000n),
  false,
  "A routine 3M SAM level cannot consume gold needed by the next productive build",
);
own.gold = () => 3_000_000n + productiveSpend.cost;
assert.equal(
  behavior.samUpgradeEconomyCanAbsorb(3_000_000n),
  true,
  "A routine SAM level becomes eligible once true surplus pays for it and economic growth",
);
own.gold = () => 2_999_999n;
assert.equal(
  behavior.samUpgradeEconomyCanAbsorb(3_000_000n),
  false,
  "Missile urgency cannot relabel the economy's 3M principal as SAM-upgrade surplus",
);
own.gold = originalOwnGoldForSamSurplus;
behavior.economicConstructionPressureForSamUpgrade = originalSamEconomicPressure;
const deterministicLegendaryUpgrade = Object.create(sandbox.__StructureBehavior.prototype);
deterministicLegendaryUpgrade.random = {
  chance: () => true,
  nextInt: () => 2,
};
testDifficulty = Difficulty.Legendary;
assert.equal(
  deterministicLegendaryUpgrade.selectScoredStructureUpgrade([
    { structure: "best", score: 20 },
    { structure: "second", score: 10 },
    { structure: "third", score: 5 },
  ]),
  "best",
  "Legendary never discards a proven best upgrade for random variety",
);
testDifficulty = Difficulty.Impossible;
assert.equal(
  deterministicLegendaryUpgrade.selectScoredStructureUpgrade([
    { structure: "best", score: 20 },
    { structure: "second", score: 10 },
    { structure: "third", score: 5 },
  ]),
  "third",
  "faithful Easy-Impossible modes preserve Nation upgrade variety",
);

const genericSamUpgradeBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const genericSamStructure = { type: () => UNIT.SAMLauncher };
genericSamUpgradeBehavior.getTotalStructureDensity = () => 1;
genericSamUpgradeBehavior.findBestStructureToUpgrade = async () => ({
  structure: genericSamStructure,
  bu: { canUpgrade: true, cost: 3_000_000n },
});
genericSamUpgradeBehavior.buildableCostOrFallback = (buildable) => BigInt(buildable.cost);
genericSamUpgradeBehavior.safeStructureCost = () => 3_000_000n;
genericSamUpgradeBehavior.samUpgradeEconomyCanAbsorb = () => false;
assert.equal(
  await genericSamUpgradeBehavior.maybeUpgradeStructure([genericSamStructure]),
  false,
  "The generic density-upgrade path cannot bypass the SAM economic-surplus gate",
);
const originalOwnGoldForPressure = own.gold;
own.gold = () => 1_000n;
assert.equal(
  behavior.economicConstructionPressure()?.type,
  UNIT.Factory,
  "Saving toward the next productive structure remains economic pressure before it is affordable",
);
own.gold = originalOwnGoldForPressure;
assert.equal(
  typeof behavior.hasHostileSiloThreat,
  "function",
  "Structure behavior exposes the hostile silo threat check",
);
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "A built hostile silo triggers the mandatory SAM response",
);
assert.equal(
  behavior.hasBuiltHostileSiloThreat(),
  true,
  "The hard SAM priority recognizes a completed hostile Silo",
);
const originalPlayersForSiloLevelSum = behavior.game.players;
behavior.game.players = () => [own, enemySiloUnderConstruction];
assert.equal(
  behavior.hasBuiltHostileSiloThreat(),
  false,
  "An uncompleted hostile Silo has no usable missile capacity yet",
);
assert.equal(
  behavior.hasPlacedSiloOnMap(),
  true,
  "The first hostile Silo construction immediately activates SAM priority",
);
assert.equal(
  behavior.externalSiloLevelSumTarget(),
  1,
  "A hostile Silo under construction immediately contributes preventive SAM capacity",
);
behavior.game.players = () => [own, enemyTeam];
assert.equal(
  behavior.hasPlacedSiloOnMap(),
  false,
  "A permanent teammate's Silo does not activate our SAM priority",
);
assert.equal(
  behavior.shouldBuildSiloTriggeredSam(),
  false,
  "A permanent teammate's Silo does not request an unnecessary interceptor",
);
const originalEnemyTeamUnitsForExternalSilo = enemyTeam.units;
enemyTeam.units = (type) => (type === UNIT.MissileSilo ? [makeUnit(503, 2)] : []);
assert.equal(
  behavior.externalSiloLevelSumTarget(),
  0,
  "A permanent teammate's level-2 Silo contributes no hostile SAM target capacity",
);
assert.equal(
  behavior.hasBuiltExternalSiloThreat(),
  false,
  "A completed permanent-teammate Silo does not permit the hostile upgrade path",
);
enemyTeam.units = originalEnemyTeamUnitsForExternalSilo;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
assert.equal(
  behavior.hostileSiloLevelSumAtLeast(),
  true,
  "One completed level-1 hostile Silo is enough to enable H-bomb SAM protection",
);
behavior.game.players = () => [own, enemyTwoLevelOneSilos];
assert.equal(
  behavior.hostileSiloLevelSumAtLeast(),
  true,
  "Two hostile level-1 Silos remain inside the H-bomb protection policy",
);
