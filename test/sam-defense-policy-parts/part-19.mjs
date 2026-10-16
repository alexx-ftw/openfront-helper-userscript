hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan(),
  null,
  "A permanent teammate's level-2 Silo does not force a hostile SAM plan",
);
enemyTeam.units = originalEnemyTeamUnitsForHydrogenPlan;
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradeHydrogenProtectionSam(),
  false,
  "Permanent-teammate Silos do not emit an unnecessary SAM upgrade",
);
assert.equal(sentBuilds.length, 0, "Permanent-teammate Silos emit no SAM action");
hydrogenProtectionGold = 1_000_000n;
hydrogenProtectionBehavior.cost = () => 3_000_000n;
hydrogenProtectionBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 500_000n },
];
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradePlannedSam({
    sam: hydrogenSam,
    currentLevel: 1,
    targetLevel: 2,
  }),
  true,
  "An affordable authoritative SAM upgrade is not rejected by the higher new-site price",
);
assert.equal(sentBuilds.length, 1);
hydrogenProtectionBehavior.economicConstructionPressureForSamUpgrade = () => ({
  type: UNIT.City,
  cost: 1_000_000n,
});
hydrogenProtectionGold = 500_000n;
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradePlannedSam(
    { sam: hydrogenSam, currentLevel: 1, targetLevel: 5 },
    { maximumNuclearPriority: true },
  ),
  true,
  "a maximum-priority external-Silo upgrade spends affordable gold without preserving an unrelated economy purchase",
);
assert.equal(sentBuilds.length, 1);
delete hydrogenProtectionBehavior.economicConstructionPressureForSamUpgrade;
let unaffordableCachedUpgradeProbes = 0;
hydrogenProtectionGold = 499_999n;
hydrogenProtectionBehavior.buildableForUnits = async () => {
  unaffordableCachedUpgradeProbes++;
  return [{ type: UNIT.SAMLauncher, canUpgrade: true, cost: 500_000n }];
};
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradePlannedSam({
    sam: hydrogenSam,
    currentLevel: 1,
    targetLevel: 2,
  }),
  false,
  "a known unaffordable authoritative SAM upgrade waits without another worker probe",
);
assert.equal(
  unaffordableCachedUpgradeProbes,
  0,
  "the exact cached upgrade cost prevents repeated unaffordable SAM probes",
);
hydrogenProtectionGold = 5_000_000n;
// The native worker returns the exact cost even when insufficient gold makes
// canUpgrade false. Cache that first failed probe, not only successful ones.
hydrogenProtectionBehavior._plannedSamUpgradeCostCache = new Map();
hydrogenProtectionGold = 499_999n;
let rejectedUpgradeCostProbes = 0;
const priorUpgradeBuildables = hydrogenProtectionBehavior.buildableForUnits;
hydrogenProtectionBehavior.buildableForUnits = async () => {
  rejectedUpgradeCostProbes++;
  return [{ type: UNIT.SAMLauncher, canUpgrade: false, cost: 500_000n }];
};
const rejectedCostPlan = { sam: hydrogenSam, currentLevel: 1, targetLevel: 2 };
assert.equal(await hydrogenProtectionBehavior.maybeUpgradePlannedSam(rejectedCostPlan), false);
assert.equal(await hydrogenProtectionBehavior.maybeUpgradePlannedSam(rejectedCostPlan), false);
assert.equal(
  rejectedUpgradeCostProbes,
  1,
  "an unaffordable native descriptor caches its cost despite canUpgrade=false",
);
hydrogenProtectionGold = 500_000n;
assert.equal(await hydrogenProtectionBehavior.maybeUpgradePlannedSam(rejectedCostPlan), false);
assert.equal(
  rejectedUpgradeCostProbes,
  2,
  "reaching the cached cost rechecks legality rather than assuming upgrade permission",
);
hydrogenProtectionGold = 5_000_000n;
hydrogenProtectionBehavior.buildableForUnits = priorUpgradeBuildables;
hydrogenProtectionBehavior.cost = () => 1n;
hydrogenProtectionBehavior.liveNuclearHostilePlayers = () => [enemySingleLevelOneSilo];
hydrogenThreatPlayers = [enemySingleLevelOneSilo];
hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "A single completed external Silo immediately drives the first protective SAM to level five",
);
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradeHydrogenProtectionSam(),
  true,
  "The H-bomb policy upgrades a level-1 SAM before the hostile player can spend 5M on a launch",
);
assert.equal(sentBuilds.length, 1, "The single-Silo H-bomb policy sends exactly one SAM upgrade");
hydrogenProtectionBehavior.liveNuclearHostilePlayers = () => [enemySingleLevelTwoSilo];
hydrogenThreatPlayers = [enemySingleLevelTwoSilo];
hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "One level-2 hostile Silo also forces the maximum SAM level",
);
hydrogenProtectionBehavior._hostileMissileLaunchObserved = false;
hydrogenProtectionBehavior.liveNuclearHostilePlayers = () => [];
hydrogenThreatPlayers = [enemySiloUnderConstruction];
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "A newly placed external Silo starts the level-five SAM plan before the Silo completes",
);
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradeHydrogenProtectionSam(),
  true,
  "A placed external Silo authorizes the preventive SAM upgrade while both build timers still run",
);
assert.equal(sentBuilds.length, 1);

const firstSiloCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
firstSiloCoverageBehavior._hostileMissileLaunchObserved = true;
firstSiloCoverageBehavior.player = {
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    if (type === UNIT.MissileSilo) return [makeUnit(1150, 1)];
    return [];
  },
};
firstSiloCoverageBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    gameConfig: () => ({ gameMode: "FFA" }),
    samRange: (level) => level * 6,
  }),
};
firstSiloCoverageBehavior.liveNuclearHostilePlayers = () => [enemySingleLevelOneSilo];
firstSiloCoverageBehavior.legendaryReserveGold = () => 0n;
assert.equal(
  firstSiloCoverageBehavior.hydrogenStructureCoveragePlan()?.needsNewSam,
  true,
  "The first built hostile level-1 Silo requests a SAM covering our structures",
);
assert.equal(
  firstSiloCoverageBehavior.defensiveConstructionPressure()?.type,
  UNIT.SAMLauncher,
  "The first hostile Silo creates a defensive SAM reserve before offense",
);
const firstSiloCoverageSpawns = [];
firstSiloCoverageBehavior.activeMissileDefenseContext = () => ({ threats: [] });
firstSiloCoverageBehavior._hostileMissileLaunchObserved = false;
firstSiloCoverageBehavior.maybeSpawnStructure = async (...args) => {
  firstSiloCoverageSpawns.push(args);
  return true;
};
assert.equal(
  await firstSiloCoverageBehavior.maybeEnsureHydrogenStructureCoverage(),
  true,
  "A first hostile Silo authorizes the required coverage SAM before a missile launches",
);
assert.deepEqual(
  firstSiloCoverageSpawns.map(([type, options]) => [type, options.useActualCost]),
  [[UNIT.SAMLauncher, true]],
  "Pre-launch coverage SAMs use the literal affordable cost instead of a save-up multiplier",
);

const pendingCoverageSamBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let pendingCoveragePlanCalls = 0;
pendingCoverageSamBehavior.hasOwnSamUnderConstruction = () => true;
pendingCoverageSamBehavior.hydrogenStructureCoveragePlan = () => {
  pendingCoveragePlanCalls++;
  return { needsNewSam: true };
};
