assert.deepEqual(
  failedCandidateProbes,
  [1, 0],
  "A failed best candidate is excluded while the next candidate is probed",
);
assert.equal(
  await failedBestCandidateBehavior.maybeSpawnStructure(UNIT.City),
  false,
  "Backoff keeps failed candidates from being reprobed in the same decision window",
);
assert.deepEqual(
  failedCandidateProbes,
  [1, 0],
  "Backoff bounds authoritative retries after every candidate is indeterminate",
);
assert.equal(
  failedCandidateUpgradeCalls,
  0,
  "A failed authoritative probe never authorizes an economic upgrade",
);

const boundedEconomyScanBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let boundedOwnerChecks = 0;
const boundedEconomyContext = {
  bounds: { minX: 0, maxX: 99_999, minY: 0, maxY: 0 },
  game: {
    isValidCoord: () => true,
    ref: (x) => x,
    ownerID: () => {
      boundedOwnerChecks++;
      return 2;
    },
  },
  mySid: 1,
  structures: [],
  minDistSquared: 0,
  valueFunction: () => 0,
};
const boundedEconomyScan = {
  context: boundedEconomyContext,
  x: 0,
  y: 0,
  hasGeometricSpace: false,
};
assert.equal(
  boundedEconomyScanBehavior.scanAllLandEconomicSpace(UNIT.City, boundedEconomyScan).status,
  "pending",
  "A map-wide no-space proof pauses after one normal placement budget",
);
assert.equal(
  boundedOwnerChecks,
  25,
  "A single construction decision examines at most 25 exhaustive-scan coordinates",
);
assert.equal(boundedEconomyScan.x, 25, "The next decision resumes the saved scan cursor");
assert.equal(
  await launchGateBehavior.maybeUpgradePlannedSam({
    currentLevel: 1,
    targetLevel: 2,
  }),
  false,
  "No SAM upgrade can spend gold before the first hostile missile launch",
);
hostileMissileActive = true;
assert.equal(
  launchGateBehavior.hasObservedHostileMissileLaunch(),
  true,
  "An active hostile missile unlocks SAM construction",
);
hostileMissileActive = false;
assert.equal(
  launchGateBehavior.hasObservedHostileMissileLaunch(),
  true,
  "The first hostile launch remains remembered after its missile resolves",
);
const observerScanBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let observerMissileUnitScans = 0;
observerScanBehavior._hostileMissileLaunchObserved = false;
observerScanBehavior.player = own;
observerScanBehavior.game = {
  ticks: () => 700,
  units: () => {
    observerMissileUnitScans++;
    return [];
  },
};
observerScanBehavior.liveHostilePlayers = () => {
  throw new Error("launch observation must not scan hostile players or buildings");
};
assert.equal(observerScanBehavior.observeHostileMissileLaunch(), false);
assert.equal(observerScanBehavior.observeHostileMissileLaunch(), false);
assert.equal(
  observerMissileUnitScans,
  1,
  "Launch observation scans only the active missile family once per game tick",
);
const thirdPartyMirvBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const hostileMirvOwner = { smallID: () => 2 };
let observedMissileTypes = [];
thirdPartyMirvBehavior._hostileMissileLaunchObserved = false;
thirdPartyMirvBehavior.player = {
  smallID: () => 1,
  isFriendly: () => false,
  isOnSameTeam: () => false,
};
thirdPartyMirvBehavior.game = {
  ticks: () => 701,
  units: (...types) => {
    observedMissileTypes = types;
    return [
      {
        isActive: () => true,
        owner: () => hostileMirvOwner,
        // Deliberately aimed at another player: launch detection is based on
        // the hostile owner, not on whether our own territory is targeted.
        targetTile: () => 99_999,
      },
    ];
  },
};
assert.equal(
  thirdPartyMirvBehavior.observeHostileMissileLaunch(),
  true,
  "A hostile MIRV aimed at a third party unlocks SAM construction",
);
assert.deepEqual(
  observedMissileTypes,
  [UNIT.AtomBomb, UNIT.HydrogenBomb, UNIT.MIRV, UNIT.MIRVWarhead],
  "Launch observation covers every missile family that SAMs can intercept",
);
const nationExecutionSource = read("engine/ingame/auto-bot/nationExecution.js");
const tickSource =
  nationExecutionSource.match(
    /async tick\(ticks, profile, tickGeneration\) \{([\s\S]*?)\n {4}\}/,
  )?.[1] ?? "";
const launchObserverIndex = tickSource.indexOf("this.prepareInitializedTickState(me, profile);");
const cadenceGateIndex = tickSource.indexOf("this.getTickCrossings(ticks)");
const launchObserverCallCount =
  nationExecutionSource.split("this.structureBehavior.observeHostileMissileLaunch?.();").length - 1;
assert.ok(
  launchObserverIndex >= 0 && launchObserverIndex < cadenceGateIndex,
  "Hostile launches are observed every authoritative tick before slower behavior cadence gates",
);
assert.match(
  nationExecutionSource,
  /prepareInitializedTickState\(me, profile\)[\s\S]{0,260}this\.structureBehavior\.observeHostileMissileLaunch\?\.\(\);/,
  "the bounded per-tick preparation helper retains hostile missile observation",
);
assert.equal(
  launchObserverCallCount,
  2,
  "The launch observer also runs immediately when behaviors initialize",
);

const originalEnemySilosGoldForCapacityTest = enemySilos.gold;
enemySilos.gold = () => 1_500_000n;
forecastTick = 300;
forecastCalls = 0;
behavior.getMissileDefenseContext();
forecastTick = 301;
enemySilos.gold = () => 1_500_001n;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  1,
  "Small hostile gold changes do not invalidate the short forecast bucket",
);
forecastTick = 302;
enemySilos.gold = () => 3_000_000n;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  2,
  "A hostile gold change that adds an affordable missile refreshes the forecast",
);
enemySilos.gold = originalEnemySilosGoldForCapacityTest;

behavior.game.units = () => [];
// The missile-family reads ride the shared per-tick unit snapshot: bumping the
// tick alongside the stub swap keeps the snapshot read fresh (same game +
// same tick must observe one unit list).
forecastTick += 1;
behavior._missileDefenseSignalTick = null;
behavior._activeHostileMissileTick = null;
behavior._activeHostileMissileCache = null;
const originalReactiveSignalBuildableFor = behavior.buildableFor;
let reactiveSignalProbeCalls = 0;
behavior.buildableFor = async () => {
  reactiveSignalProbeCalls++;
  return { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1_500_000n };
