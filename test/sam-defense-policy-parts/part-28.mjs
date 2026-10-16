assert.deepEqual(
  Array.from(simultaneousSiloBehavior.legendarySamSlotAvailability(twoExpiredCooldownSlotsSam)),
  [0, 1],
  "a level-2 SAM reloads only one expired queue-front missile per engine tick",
);

simultaneousSiloBehavior.legendaryTrajectoryTargetableRange = () => 5;
simultaneousSiloBehavior.game.euclideanDistSquared = () => 25;
assert.equal(
  simultaneousSiloBehavior.legendaryTrajectoryTileTargetable(2, 1, 3),
  false,
  "the exact targetable-radius boundary remains untargetable like NukeExecution",
);

simultaneousSiloBehavior.game.config = () => ({
  SiloCooldown: () => 90,
  defaultSamMissileSpeed: () => 2,
});
simultaneousSiloBehavior.game.euclideanDistSquared = () => 0;
simultaneousSiloBehavior.game.manhattanDist = () => 4;
const flightAwareOptions = simultaneousSiloBehavior.legendaryMissileRouteSamOptions(
  [{ tile: 0, range: 100, level: 1, availableTicks: [0] }],
  {
    path: [1, 2, 3, 4],
    fromTile: 1,
    targetTile: 4,
    launchOffset: 10,
    targetableIndexesOverride: [2],
    coverageIndexCache: new Map(),
  },
);
assert.deepEqual(Array.from(flightAwareOptions.samOptions[0].interceptTicks), [10]);
assert.deepEqual(
  Array.from(flightAwareOptions.samOptions[0].interceptionTicks),
  [12],
  "SAM defense subtracts interceptor flight time from the nuke collision opportunity",
);

const metricBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const metricSilos = [makeUnit(701, 1), makeUnit(702, 1)];
let metricFlightCalls = 0;
let metricCapacityCalls = 0;
metricBehavior.legendaryFriendlySamProfiles = () => [];
metricBehavior.legendarySiloSlotAvailability = () => [0];
metricBehavior.legendarySiloCooldownTicks = () => 90;
metricBehavior.legendarySamCooldownTicks = () => 90;
metricBehavior.legendaryNukeFlightTime = () => {
  metricFlightCalls++;
  return 10;
};
metricBehavior.legendaryEnemyMissileLaunchPlan = (silos) =>
  silos.map((silo, index) => ({
    silo,
    launchTick: index,
    flightTicks: 10 + index,
    impactTick: 10 + index,
  }));
metricBehavior.legendaryNukeFlightPath = () => [1, 2, 3];
metricBehavior.legendaryBuildMissileRoute = (...routeArgs) => {
  const [fromTile, targetTile, impactTick, , launchOffset, weapon, id, path] = routeArgs;
  return {
    id,
    weapon,
    fromTile,
    targetTile,
    impactTick,
    launchOffset,
    path,
    samOptions: [],
  };
};
metricBehavior.legendarySamInterceptionCapacity = () => {
  metricCapacityCalls++;
  return 1;
};
const metricPlan = metricBehavior.legendaryMissileSalvoPlan({
  enemySilos: metricSilos,
  enemyGold: 1n,
  targetTile: 9,
  atomCost: 1n,
  hydrogenCost: 0n,
});
assert.equal(
  metricPlan.sourceMetrics.length,
  metricSilos.length,
  "Missile salvo plans expose one source metric per enemy silo",
);
assert.equal(
  metricCapacityCalls,
  metricSilos.length,
  "Each silo interception capacity is calculated once while building a salvo",
);
assert.equal(
  metricFlightCalls,
  0,
  "Salvo source metrics reuse launch-plan flight times instead of pathfinding again",
);

let placementSalvoCalls = 0;
const placementBehavior = Object.create(sandbox.__StructureBehavior.prototype);
placementBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
placementBehavior.legendaryCriticalStructureValue = () => 1;
placementBehavior.legendaryEnemyMissileLaunchPlan = () => [
  { silo: metricSilos[0], launchTick: 0, flightTicks: 10, impactTick: 10 },
  { silo: metricSilos[1], launchTick: 1, flightTicks: 11, impactTick: 12 },
];
placementBehavior.legendarySamInterceptionCapacity = () => 1;
placementBehavior.legendarySamCooldownTicks = () => 90;
placementBehavior.legendaryMissileSalvoPlan = () => {
  placementSalvoCalls++;
  throw new Error("placement scoring must not build a full salvo plan");
};
const placementRisk = placementBehavior.legendaryMissilePlacementRisk(5, UNIT.Factory, {
  atomCost: 1n,
  hydrogenCost: 0n,
  atomRadius: 10,
  hydrogenRadius: 20,
  totalValue: 10,
  structures: [makeUnit(1, 1)],
  activeMissiles: [],
  threats: [
    {
      inFlight: false,
      targetTile: 20,
      weapon: UNIT.AtomBomb,
      enemySilos: metricSilos,
      enemyGold: 2n,
      salvoPlan: {
        routes: [{ impactTick: 10 }, { impactTick: 12 }],
        readyShots: 2,
      },
    },
  ],
});
assert.ok(Number.isFinite(placementRisk), "Placement risk remains a finite score");
assert.equal(
  placementSalvoCalls,
  0,
  "Placement ranking uses the lightweight threat proxy instead of rebuilding a salvo scheduler",
);

assert.equal(
  typeof behavior.maybeUpgradeSamForSiloParity,
  "function",
  "Structure behavior exposes the proactive SAM-vs-Silo level upgrade path",
);
const originalPlayersForPendingSamParity = behavior.game.players;
const originalOwnSamsForPendingSamParity = own.sams;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
own.sams = [makeUnit(409, 1, { underConstruction: true })];
assert.equal(
  behavior.playerUnitCapacitySummary(own, UNIT.SAMLauncher).capacity,
  1,
  "a pending SAM remains part of projected capacity",
);
assert.equal(behavior.ownSamCapacity(), 0, "a pending SAM contributes no built active capacity");
assert.equal(behavior.ownProjectedSamCapacity(), 1, "planning retains pending SAM capacity");
assert.equal(behavior.samLevelParityGap(), 1, "a pending SAM cannot close immediate SAM parity");
assert.equal(
  behavior.legendaryMissileDefenseSatisfiedForNavalEconomy(),
  false,
  "a pending SAM is not ready missile defense for naval economy",
);
own.sams = [makeUnit(409, 1)];
assert.equal(behavior.samLevelParityGap(), 0, "built active SAM capacity closes immediate parity");
assert.equal(
  behavior.legendaryMissileDefenseSatisfiedForNavalEconomy(),
  true,
  "a built active SAM satisfies ready missile defense",
);
behavior.game.players = originalPlayersForPendingSamParity;
own.sams = originalOwnSamsForPendingSamParity;
assert.equal(
  behavior.ownMaximumSamLevel(),
  1,
  "Only built own SAM levels count toward immediate parity",
);
own.sams = [makeUnit(403, 3), makeUnit(404, 3)];
assert.equal(
  behavior.samLevelParityGap(),
  0,
  "SAM parity uses total own interceptor capacity instead of only the highest SAM",
);
own.sams = [makeUnit(403, 3), makeUnit(404, 2)];
assert.equal(
  behavior.samLevelParityGap(),
  1,
  "SAM parity reports the remaining capacity gap against the strongest hostile network",
