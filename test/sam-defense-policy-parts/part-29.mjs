);
own.sams = [reactiveSam];
assert.equal(behavior.samLevelParityGap(), 5, "SAM parity reports the missing capacity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "A SAM is upgraded when the strongest hostile Silo network exceeds our own capacity",
);
assert.equal(sentBuilds.length, 1, "Proactive SAM parity emits one upgrade");
own.sams = [makeUnit(402, 6)];
assert.equal(behavior.samLevelParityGap(), 0, "A single SAM at the target level closes SAM parity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not repeat an upgrade once one SAM reaches the target",
);
const originalPlayersForSingleSiloParity = behavior.game.players;
const originalOwnSamsForSingleSiloParity = own.sams;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
own.sams = [makeUnit(408, 1)];
sentBuilds.length = 0;
assert.equal(
  behavior.samLevelParityTarget(),
  1,
  "A single level-1 hostile Silo creates only a level-1 SAM parity target",
);
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "A matching level-1 SAM is not upgraded merely because an enemy owns a Silo",
);
assert.equal(sentBuilds.length, 0, "A matching level-1 hostile-Silo parity check emits no upgrade");
behavior.game.players = originalPlayersForSingleSiloParity;
own.sams = originalOwnSamsForSingleSiloParity;
own.sams = [makeUnit(405, 3), makeUnit(406, 2), makeUnit(407, 2)];
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  false,
  "The scaled hostile-Silo defense stops once the required SAM site count is met",
);
own.sams = [makeUnit(405, 1)];
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  true,
  "A massed hostile Silo network adds SAM sites until the scaled coverage target is met",
);
own.sams = [reactiveSam];
sentBuilds.length = 0;
const originalReactiveReserve = behavior.legendaryReserveGold;
const originalReactiveGold = own.gold;
behavior.legendaryReserveGold = () => 25_000_000n;
own.gold = () => 20_000_000n;

assert.equal(
  typeof behavior.maybeUpgradeMissileDefenseSam,
  "function",
  "Structure behavior exposes the non-Legendary reactive SAM upgrade path",
);
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  true,
  "A SAM is upgraded when one level turns an unresolved incoming threat into a defended route",
);
assert.equal(sentBuilds.length, 1, "Reactive defense emits exactly one SAM upgrade");
state.settings.buildStructures[UNIT.SAMLauncher] = false;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A user-disabled SAM type is never upgraded by the reactive path",
);
delete state.settings.buildStructures[UNIT.SAMLauncher];
samDisabled = true;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A SAM type disabled by game configuration is never upgraded",
);
samDisabled = false;
behavior.legendaryReserveGold = originalReactiveReserve;
own.gold = originalReactiveGold;

const originalActiveMissileSignal = behavior.missileDefenseSignalSnapshot;
const originalActiveMissileContext = behavior.activeMissileDefenseContext;
const originalDefenseEvaluation = behavior.legendaryDefenseEvaluation;
const originalMaybeUpgradeMissileDefenseSam = behavior.maybeUpgradeMissileDefenseSam;
const originalActiveMissileMaybeSpawnStructure = behavior.maybeSpawnStructure;
const originalActiveMissileHydrogenPlan = behavior.hydrogenSamProtectionPlan;
behavior.missileDefenseSignalSnapshot = () => ({ hasActiveHostileMissile: true });
behavior.activeMissileDefenseContext = () => ({
  threats: [{ inFlight: true }],
});
behavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: false,
});
let activeMissileUpgradeContext = null;
behavior.maybeUpgradeMissileDefenseSam = async (context) => {
  activeMissileUpgradeContext = context;
  return false;
};
behavior.hydrogenSamProtectionPlan = () => null;
let activeMissileSpawnOptions = null;
behavior.maybeSpawnStructure = async (type, options) => {
  assert.equal(type, UNIT.SAMLauncher, "Active missile defense only requests a SAM");
  activeMissileSpawnOptions = options;
  return false;
};
own.sams = [reactiveSam];
assert.equal(
  await behavior.handleActiveMissileSamMaximumPriority(),
  false,
  "An unresolved airborne missile reserves the construction slot when placement is not yet possible",
);
assert.equal(
  activeMissileUpgradeContext,
  activeMissileSpawnOptions.missileDefenseContext,
  "Upgrade and placement score the same active-missile-only trajectory context",
);
assert.equal(
  activeMissileSpawnOptions.forceNewStructure,
  true,
  "A geometrically useless existing SAM permits a new defensive site",
);
assert.equal(
  activeMissileSpawnOptions.activeMissileDefense,
  true,
  "Active missile placement enables trajectory candidate selection",
);

let prospectiveThreatCalls = 0;
const originalActiveMissileBaseContext = behavior.legendaryMissilePlacementBaseContext;
const originalActiveMissileThreats = behavior.legendaryActiveMissileThreats;
const originalProspectiveMissileThreat = behavior.legendaryEnemyMissileThreat;
const originalActiveMissileSamProfiles = behavior.legendaryFriendlySamProfiles;
behavior.legendaryMissilePlacementBaseContext = () => ({
  atomCost: 1n,
  hydrogenCost: 2n,
  atomRadius: 10,
  hydrogenRadius: 20,
  structures: [],
  totalValue: 0,
  priorityStructures: [],
});
behavior.legendaryActiveMissileThreats = () => [
  {
    inFlight: true,
    score: 4,
    targetTile: 321,
  },
];
behavior.legendaryFriendlySamProfiles = () => [];
behavior.legendaryEnemyMissileThreat = () => {
  prospectiveThreatCalls++;
  return null;
};
const activeOnlyContext = originalActiveMissileContext.call(behavior);
assert.deepEqual(
  activeOnlyContext.threats.map((threat) => threat.targetTile),
  [321],
  "Active missile defense preserves the observed in-flight threat",
);
assert.equal(
  prospectiveThreatCalls,
  0,
  "Active missile defense does not construct irrelevant hostile-silo forecasts",
);
behavior.legendaryMissilePlacementBaseContext = originalActiveMissileBaseContext;
behavior.legendaryActiveMissileThreats = originalActiveMissileThreats;
behavior.legendaryEnemyMissileThreat = originalProspectiveMissileThreat;
behavior.legendaryFriendlySamProfiles = originalActiveMissileSamProfiles;

behavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: true,
});
activeMissileSpawnOptions = null;
assert.equal(
  await behavior.handleActiveMissileSamMaximumPriority(),
  null,
  "A fully defended airborne missile does not multiply SAM sites",
);
assert.equal(activeMissileSpawnOptions, null, "No redundant SAM placement is attempted");

const originalThreatOwnerId = behavior.game.ownerID;
behavior.game.ownerID = () => own.smallID();
const activeRouteTiles = behavior.prependActiveMissileRouteTiles([99, 100], 6, {
  threats: [
    {
      inFlight: true,
      salvoPlan: { routes: [{ path: [10, 20, 30] }] },
