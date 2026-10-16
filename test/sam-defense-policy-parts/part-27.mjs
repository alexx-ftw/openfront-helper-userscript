};
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A built hostile silo without an active missile does not trigger reactive SAM upgrade work",
);
assert.equal(
  reactiveSignalProbeCalls,
  0,
  "A built hostile silo without an active missile avoids per-SAM async probes",
);
behavior.buildableFor = originalReactiveSignalBuildableFor;
const activeHostileMissile = {
  isActive: () => true,
  owner: () => enemySilos,
};
behavior.game.units = () => [activeHostileMissile];
forecastTick += 1;
behavior._missileDefenseSignalTick = null;
behavior._activeHostileMissileTick = null;
behavior._activeHostileMissileCache = null;

const originalEmergencyUpgradeGold = own.gold;
const originalEmergencyUpgradeCost = behavior.cost;
const originalEmergencyUpgradeBuildableFor = behavior.buildableFor;
const originalEmergencyEconomicPressure = behavior.economicConstructionPressureForSamUpgrade;
reactiveSam.level = () => 4;
own.gold = () => 2_999_999n;
behavior.economicConstructionPressureForSamUpgrade = () => ({
  type: UNIT.Factory,
  cost: 1_000_000n,
});
behavior.cost = () => 5_000_000n;
behavior.buildableFor = async () => ({
  type: UNIT.SAMLauncher,
  canUpgrade: true,
  cost: 3_000_000n,
});
sentBuilds.length = 0;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "An incoming H-bomb cannot spend beyond the authoritative 3M upgrade cost",
);
assert.equal(sentBuilds.length, 0);
own.gold = () => 3_000_000n;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  true,
  "An incoming H-bomb upgrades at the authoritative 3M price even when an economic reserve is pending",
);
assert.equal(
  sentBuilds.length,
  1,
  "The affordable level-5 emergency upgrade is sent before Legendary can spend on a Factory",
);
reactiveSam.level = () => 1;
own.gold = originalEmergencyUpgradeGold;
behavior.cost = originalEmergencyUpgradeCost;
behavior.buildableFor = originalEmergencyUpgradeBuildableFor;
behavior.economicConstructionPressureForSamUpgrade = originalEmergencyEconomicPressure;
behavior._missileDefenseSignalTick = null;

let forecastTickSeen = null;
const originalBuildableFor = behavior.buildableFor;
behavior.legendaryMissilePlacementContext = () => {
  forecastCalls++;
  forecastTickSeen = forecastTick;
  return { threats: [{ targetTile: 999 }] };
};
behavior.buildableFor = async () => {
  forecastTick++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 1_500_000n,
  };
};
forecastTick = 200;
forecastCalls = 0;
await behavior.maybeUpgradeMissileDefenseSam();
assert.equal(
  forecastTickSeen,
  201,
  "Reactive SAM defense forecasts after async buildable probes finish",
);
behavior.buildableFor = originalBuildableFor;
sentBuilds.length = 0;

let evaluationCalls = 0;
behavior._missileDefenseEvaluationTick = null;
behavior._missileDefenseEvaluationContext = null;
behavior._missileDefenseEvaluationCache = null;
const rawDefenseEvaluation = behavior.legendaryDefenseEvaluation;
behavior.legendaryDefenseEvaluation = (context, options = {}) => {
  if (Object.keys(options).length === 0) evaluationCalls++;
  return rawDefenseEvaluation(context, options);
};
const cachedContext = behavior.getMissileDefenseContext();
behavior.getMissileDefenseEvaluation(cachedContext);
behavior.getMissileDefenseEvaluation(cachedContext);
assert.equal(
  evaluationCalls,
  1,
  "Base missile defense evaluation is reused for the cached context",
);

let rebuiltRoutePath = null;
const cachedRoute = {
  id: "cached-route",
  weapon: UNIT.AtomBomb,
  fromTile: 1,
  targetTile: 9,
  impactTick: 20,
  launchOffset: 0,
  path: [1, 2, 3, 9],
};
behavior.legendaryBuildMissileRoute = (...args) => {
  const [route] = args;
  rebuiltRoutePath = route.path;
  return { id: route.id, path: route.path, samOptions: [] };
};
const rebuiltRoutes = behavior.legendaryRebuildMissileRoutes([cachedRoute], []);
assert.equal(rebuiltRoutes.length, 1, "Cached missile routes can be rebuilt for a new SAM profile");
assert.strictEqual(
  rebuiltRoutePath,
  cachedRoute.path,
  "SAM upgrade evaluation reuses the cached flight path instead of pathfinding again",
);

let pathfinderCalls = 0;
sandbox.UniversalPathFinding = {
  Parabola: () => {
    pathfinderCalls++;
    return { findPath: () => [1, 2, 3, 9] };
  },
};
const pathBehavior = Object.create(sandbox.__StructureBehavior.prototype);
pathBehavior.game = {
  config: () => ({ defaultNukeSpeed: () => 1 }),
};
assert.deepEqual(
  pathBehavior.legendaryNukeFlightPath(1, 9),
  [1, 2, 3, 9],
  "Missile pathfinding returns the planner trajectory",
);
assert.deepEqual(
  pathBehavior.legendaryNukeFlightPath(1, 9),
  [1, 2, 3, 9],
  "Repeated requests return the same missile trajectory",
);
assert.equal(
  pathfinderCalls,
  1,
  "Repeated missile path requests do not rerun the parabola pathfinder",
);

const simultaneousSiloBehavior = Object.create(sandbox.__StructureBehavior.prototype);
simultaneousSiloBehavior.game = {
  ticks: () => 100,
  manhattanDist: (left, right) => Math.abs(Number(left) - Number(right)),
  config: () => ({ SiloCooldown: () => 90 }),
};
simultaneousSiloBehavior.legendaryNukeFlightTime = () => 10;
const simultaneousLaunches = simultaneousSiloBehavior.legendaryEnemyMissileLaunchPlan(
  [makeUnit(1, 1), makeUnit(2, 1)],
  9,
  2,
);
assert.deepEqual(
  Array.from(simultaneousLaunches, (launch) => launch.launchTick),
  [0, 0],
  "independent ready Silos can launch on the same tick",
);

const cooldownBoundarySam = {
  ...makeUnit(3, 1),
  missileTimerQueue: () => [10],
};
simultaneousSiloBehavior.legendarySamCooldownTicks = () => 90;
assert.deepEqual(
  Array.from(simultaneousSiloBehavior.legendarySamSlotAvailability(cooldownBoundarySam)),
  [0],
  "a SAM slot is ready on the exact tick its cooldown expires",
);

const twoExpiredCooldownSlotsSam = {
  ...makeUnit(4, 2),
  missileTimerQueue: () => [10, 10],
};
