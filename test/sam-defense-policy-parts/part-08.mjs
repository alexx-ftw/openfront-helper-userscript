strategicBorderBehavior.defensePostThreat(Difficulty.Impossible);
strategicBorderBehavior.defensePostThreat(Difficulty.Impossible);
assert.equal(
  strategicBorderPlayersReads,
  1,
  "the preemptive authorization reuses one strategic border snapshot per game tick",
);

let preemptivePriorityThreat = null;
strategicBorderBehavior.tryBuildDefensePost = async (threat) => {
  preemptivePriorityThreat = threat;
  return true;
};
strategicBorderTick++;
assert.equal(
  await strategicBorderBehavior.handleDefensePostPriority(false),
  true,
  "the quiet strategic frontier takes construction priority for its preemptive Post",
);
assert.equal(preemptivePriorityThreat?.strategicBorder, true);
strongBorderNation.troops = () => 40_000;
strategicBorderTick++;
let weakQuietBorderBuildAttempted = false;
strategicBorderBehavior.tryBuildDefensePost = async () => {
  weakQuietBorderBuildAttempted = true;
  return true;
};
assert.equal(
  await strategicBorderBehavior.handleDefensePostPriority(false),
  null,
  "a weaker quiet border leaves ordinary construction in charge",
);
assert.equal(
  weakQuietBorderBuildAttempted,
  false,
  "no Defense Post placement is probed for a weaker quiet border",
);
strongBorderNation.troops = originalStrongNationTroops;

strategicBorderBehavior.isLandAttack = () => true;
strategicBorderMe.incomingAttacks = () => [
  {
    troops: () => 120_000,
    target: () => strategicBorderMe,
    attacker: () => strongBorderNation,
  },
];
strategicBorderTick++;
const liveAttackThreat = strategicBorderBehavior.defensePostThreat(Difficulty.Impossible);
assert.equal(
  liveAttackThreat?.strategicBorder,
  undefined,
  "a live attack keeps the original authorization shape",
);
assert.equal(
  liveAttackThreat?.allowed,
  3,
  "a 1.2x live land push keeps its ratio-derived three-Post budget unclamped by the preemptive cap",
);
assert.equal(
  liveAttackThreat?.frontTiles,
  undefined,
  "live-attack placement still derives its front from the attackers, not the strong neighbor",
);
assert.equal(liveAttackThreat?.landAttacks.length, 1);
strategicBorderMe.incomingAttacks = () => [];
delete strategicBorderBehavior.isLandAttack;

const defensePostLivenessBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let defensePostLivenessTick = 100;
defensePostLivenessBehavior.handleHostileSiloSamMaximumPriority = async () => null;
defensePostLivenessBehavior.prioritizeMaritimeInvasionDefense = async () => false;
defensePostLivenessBehavior.maybeUpgradeMissileDefenseSam = async () => false;
defensePostLivenessBehavior.hasPriorStructureForDefensePost = () => true;
defensePostLivenessBehavior.game = {
  ticks: () => defensePostLivenessTick,
  config: () => ({ isUnitDisabled: () => false }),
};
defensePostLivenessBehavior.defensePostThreat = () => ({
  allowed: 1,
  ratio: 0.5,
  landAttacks: [{}],
});
defensePostLivenessBehavior.tryBuildDefensePost = async () => false;
defensePostLivenessBehavior.defensePostNeeded = () => true;
defensePostLivenessBehavior.maybeEnsureHydrogenStructureCoverage = async () => false;
defensePostLivenessBehavior.maybeUpgradeHydrogenProtectionSam = async () => false;
defensePostLivenessBehavior.maybeUpgradeSiloForNukeDemand = async () => false;
defensePostLivenessBehavior.maybeSpawnHostileSiloSam = async () => false;
defensePostLivenessBehavior.maybeUpgradeSamForSiloParity = async () => false;
defensePostLivenessBehavior.samLevelParityGap = () => 0;
defensePostLivenessBehavior.isInPostSaveUpBlockedPhase = () => false;
defensePostLivenessBehavior.placementsCount = 0;
let productiveConstructionCalls = 0;
defensePostLivenessBehavior.doHandleStructures = async () => {
  productiveConstructionCalls++;
  return true;
};
defensePostLivenessBehavior.canAffordDefensePost = () => true;
assert.equal(
  await defensePostLivenessBehavior.handleStructures(),
  true,
  "An affordable Defense Post with no legal tile cannot starve productive construction",
);
assert.equal(
  productiveConstructionCalls,
  1,
  "The ordinary construction planner runs after an affordable Defense Post placement failure",
);
defensePostLivenessBehavior.defensePostThreat = () => ({
  allowed: 4,
  ratio: 1.25,
  landAttacks: [{ attacker: () => ({ type: () => sandbox.PlayerType.Nation }) }],
});
assert.equal(
  await defensePostLivenessBehavior.handleStructures(),
  false,
  "an affordable failed Post keeps its hard reserve during an army-sized strategic invasion",
);
assert.equal(
  productiveConstructionCalls,
  1,
  "an unrelated Port or economy build cannot consume the overwhelming-invasion reserve",
);
const overwhelmingPlacementAttempts = [];
assert.equal(
  await defensePostLivenessBehavior.handleDefensePostPriority(true),
  false,
  "a prospective nuclear emergency cannot release an overwhelming land-invasion reserve to offensive construction",
);
defensePostLivenessBehavior.legendaryDefenseEmergencies = () => ({
  missileEmergency: true,
  defenseEmergency: true,
});
assert.equal(await defensePostLivenessBehavior.handleStructures(), false);
assert.equal(productiveConstructionCalls, 1);
defensePostLivenessBehavior.handleActiveMissileSamMaximumPriority = async () => true;
assert.equal(
  await defensePostLivenessBehavior.handleStructures(),
  true,
  "an active-missile SAM still acts before the land-invasion reserve",
);
assert.equal(productiveConstructionCalls, 1);
delete defensePostLivenessBehavior.handleActiveMissileSamMaximumPriority;
delete defensePostLivenessBehavior.legendaryDefenseEmergencies;
defensePostLivenessBehavior.tryBuildDefensePost = async () => {
  overwhelmingPlacementAttempts.push(defensePostLivenessTick);
  return false;
};
for (defensePostLivenessTick = 101; defensePostLivenessTick <= 120; defensePostLivenessTick++) {
  assert.equal(await defensePostLivenessBehavior.handleStructures(), false);
}
assert.deepEqual(
  overwhelmingPlacementAttempts,
  [110, 120],
  "a hard reserve stays live every tick while the expensive placement probe retries once per second",
);
defensePostLivenessBehavior.canAffordDefensePost = () => false;
assert.equal(
  await defensePostLivenessBehavior.handleStructures(),
  false,
  "An unaffordable urgent Defense Post still reserves its construction slot",
);
assert.equal(
  productiveConstructionCalls,
  1,
  "The bot does not spend the Defense Post savings on a lower-priority structure",
);

const defensePostFallbackBehavior = Object.create(sandbox.__StructureBehavior.prototype);
defensePostFallbackBehavior.player = {
  gold: () => 2_000_000n,
  units: () => [],
};
defensePostFallbackBehavior.game = {
  config: () => ({
    isUnitDisabled: () => false,
    defensePostRange: () => 30,
  }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
defensePostFallbackBehavior.defensePostThreat = () => ({
  allowed: 1,
  landAttacks: [{}],
});
defensePostFallbackBehavior.getAttackFrontTiles = () => [10];
defensePostFallbackBehavior.countDefensePostsNearFront = () => 0;
defensePostFallbackBehavior.cost = () => 50_000n;
defensePostFallbackBehavior.sampleTilesNearFront = () => [11];
defensePostFallbackBehavior.rankStructureTilesBySamProtection = (tiles) => tiles;
