// Nuke trajectory vs enemy SAM coverage (goal requirement: consider the
// missile trajectory and the enemy SAM coverage area, including the
// "vertical" dimension). Exercises the real untargetable-window math (the
// height-based immunity band) and the interception loop's honoring of it,
// plus the salvo partition's trajectory gate.

import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const sourcePath = repositoryFilePath("engine/ingame/auto-bot/nukeBehavior.js");
const source = readRepositoryFile("engine/ingame/auto-bot/nukeBehavior.js");

const UNIT = {
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const sandbox = {
  UNIT,
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  GameMode: { FFA: "FFA", Team: "Team" },
  state: { settings: { winFixes: true }, stats: {} },
  currentDifficulty: () => Difficulty.Legendary,
  isAtLeastHardDifficulty: (d) =>
    d === Difficulty.Hard || d === Difficulty.Impossible || d === Difficulty.Legendary,
  isLegendaryDifficulty: (d) => d === Difficulty.Legendary,
  withTimeout: async (p) => p,
  WORKER_TIMEOUT_MS: 100,
  randTerritoryTileArray: () => [],
  performance: { now: () => 0 },
  discoverCtors: () => ({}),
  getEventBus: () => ({}),
  emitIntent: () => true,
  setLastAction: () => {},
  runtimeDebugLog: () => {},
  tr: (v) => v,
  safeName: () => "x",
  within: (value, min, max) => Math.min(max, Math.max(min, value)),
  playersArePermanentTeammates: () => false,
};
executeClassicScript(
  `${source}
globalThis.__NukeBehavior = NukeBehavior;
globalThis.__UniversalPathFinding = UniversalPathFinding;`,
  sandbox,
  {
    filename: sourcePath,
  },
);
assert.equal(typeof sandbox.__NukeBehavior, "function");

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const makeGame = ({ targetableRange }) => ({
  ticks: () => 1000,
  config: () => ({
    defaultNukeSpeed: () => 10,
    defaultNukeTargetableRange: () => targetableRange,
    maxSamRange: () => 50,
    isUnitDisabled: () => false,
  }),
  units: () => [],
  euclideanDistSquared: dist2,
  nearbyUnits: () => [],
  isValidCoord: () => true,
  // Map surface for the real Parabola path finder: tiles are plain {x,y}.
  x: (tile) => tile.x,
  y: (tile) => tile.y,
  ref: (tile) => tile,
  height: () => 0,
  manhattanDist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y),
});

// A straight-line 1-tile-per-step trajectory on y=0 from x=0 to x=99.
const lineTrajectory = (length) => Array.from({ length }, (_, i) => ({ x: i, y: 0 }));

const behavior = Object.create(sandbox.__NukeBehavior.prototype);
behavior.player = { smallID: () => 1, units: () => [] };

// 1. Untargetable window ("vertical" immunity band): a missile is
// interceptable near the spawn and near the target only; the mid-flight
// high-arc band between the two targetable radii is immune.
{
  behavior.game = makeGame({ targetableRange: 10 });
  const spawn = { x: 0, y: 0 };
  const target = { x: 99, y: 0 };
  const trajectory = lineTrajectory(100);
  const { start, end } = behavior.findUntargetableTrajectoryRange(trajectory, spawn, target);
  // Outside spawn radius (>10) at index 11; inside target radius (<10) at 90.
  assert.equal(
    start,
    11,
    "the immunity band opens once the missile leaves the spawn targetable radius",
  );
  assert.equal(end, 90, "the immunity band closes entering the target's targetable radius");
  assert.equal(end - start > 50, true, "the mid-flight high-arc band dominates a long-range shot");
}

// 2. The interception loop honors the band: a SAM sitting under the
// mid-flight band cannot intercept; the same geometry near the descent
// can. The Parabola dependency is fixed by stubbing the two geometry
// helpers it feeds (the loop under test is the real code). Indexes are
// POSITION-RELATIVE because the real Parabola steps by nuke speed.
{
  behavior.game = makeGame({ targetableRange: 10 });
  const spawn = { x: 0, y: 0 };
  const target = { x: 99, y: 0 };
  let band = { start: 0, end: 0 };
  behavior.findUntargetableTrajectoryRange = () => band;
  let samRule = (_index) => false;
  let samInterceptIndexes = [];
  behavior.hasReachableSamAtTrajectoryIndex = (tile, _trajectory, index) => {
    samInterceptIndexes.push(index);
    return samRule(index);
  };
  const interceptable = () => behavior.isTrajectoryInterceptableBySam(spawn, target);

  // Establish the real trajectory's length first (mid-band = interior).
  const probeIndexes = [];
  samRule = (index) => {
    probeIndexes.push(index);
    return false;
  };
  band = { start: -1, end: -1 };
  interceptable();
  const len = Math.max(...probeIndexes) + 2; // loop stops at len-2

  // Mid-flight band covering the interior; SAM only under the band. The
  // band is half-open [start, end): with end = len-2, indexes 2..len-3 are
  // immune and only 0,1 and len-2 remain targetable.
  band = { start: 2, end: len - 2 };
  samRule = (index) => index >= 2 && index <= len - 3;
  samInterceptIndexes = [];
  assert.equal(
    interceptable(),
    false,
    "a SAM under the high-arc mid-flight band cannot intercept (vertical immunity)",
  );
  assert.equal(
    samInterceptIndexes.every((i) => i < 2 || i > len - 3),
    true,
    "the loop never probes the mid-flight immunity band",
  );

  // SAM covering the descent instead.
  band = { start: 2, end: len - 2 };
  samRule = (index) => index === len - 2;
  assert.equal(interceptable(), true, "a SAM covering the descent path intercepts the shot");
}

// 3. The salvo partition: coverage REQUIRES an interceptable trajectory —
// the level sum then measures the SAMs actually defending it.
{
  const route = lineTrajectory(10);
  delete behavior.hasReachableSamAtTrajectoryIndex;
  behavior.game = makeGame({ targetableRange: 50 });
  behavior.game.config = () => ({
    defaultSamMissileSpeed: () => 10,
    maxSamRange: () => 50,
    samRange: () => 50,
  });
  const routeSamA = {
    id: () => 12,
    level: () => 2,
    tile: () => ({ x: 0, y: 0 }),
    owner: () => ({ smallID: () => 2 }),
  };
  const routeSamB = { ...routeSamA, id: () => 13 };
  behavior.game.nearbyUnits = () => [
    { unit: routeSamA, distSquared: 0 },
    { unit: routeSamB, distSquared: 0 },
  ];
  const interceptors = new Set();
  assert.equal(
    behavior.hasReachableSamAtTrajectoryIndex({ x: 0, y: 0 }, route, 0, undefined, {
      interceptingSams: interceptors,
    }),
    true,
    "the real reachability probe reports overlapping SAM coverage",
  );
  assert.deepEqual(
    [...interceptors],
    [routeSamA, routeSamB],
    "the collector returns every SAM that can reach the route",
  );
}

// 4. The salvo partition: coverage REQUIRES an interceptable trajectory —
// the level sum then measures the SAMs actually defending it.
{
  behavior.game = makeGame({ targetableRange: 10 });
  behavior.nukeSpawn = () => ({ x: 0, y: 0 });
  behavior.isTrajectoryInterceptableBySam = (spawn, tile, excluded) =>
    tile.x === 99 && !excluded?.has(12);
  behavior.findEnemySamsCoveringTile = (tile) =>
    tile.x === 99 ? [{ id: () => 12, level: () => 2 }] : [];
  const { clear, covered } = behavior.partitionCandidatesBySamCoverage(
    [
      { tile: { x: 40, y: 0 }, value: 5 },
      { tile: { x: 99, y: 0 }, value: 7 },
    ],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.equal(clear.length, 1, "a trajectory-clear tile stays clear");
  assert.equal(
    covered.length,
    1,
    "an interceptable trajectory with defending SAMs is partitioned as covered",
  );
  assert.equal(
    covered[0].coveringSamLevels,
    2,
    "covering levels sum the defending SAM levels for saturation math",
  );
  // A SAM along the launch/descent route can intercept without covering
  // the destination. It is not a clear shot or a destination-only salvo.
  behavior.isTrajectoryInterceptableBySam = () => true;
  behavior.findEnemySamsCoveringTile = () => [];
  const routeCandidate = { tile: { x: 77, y: 0 }, value: 8 };
  const part2 = behavior.partitionCandidatesBySamCoverage(
    [routeCandidate],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.equal(
    part2.covered.length === 0 && part2.clear.length === 0,
    true,
    "route-only interception must not authorize an unprotected single shot",
  );
  assert.strictEqual(
    part2.routeBlockedTile,
    routeCandidate.tile,
    "the planner retains a route-blocked candidate for counterforce targeting",
  );

  behavior.findEnemySamsCoveringTile = () => [{ id: () => 12, level: () => 2 }];
  const part3 = behavior.partitionCandidatesBySamCoverage(
    [{ tile: { x: 99, y: 0 }, value: 7 }],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.equal(
    part3.covered.length + part3.clear.length,
    0,
    "saturating destination SAMs cannot pay for an additional route interceptor",
  );
}

// 5. A route-only interceptor on a candidate territory tile must reach the
// anti-SAM planner even when the target owns no valuable structure on that
// route.
{
  delete behavior.maybeDestroyEnemySam;
  behavior.game = makeGame({ targetableRange: 10 });
  const routeSam = {
    id: () => 12,
    level: () => 2,
    tile: () => 20,
    owner: () => ({ smallID: () => 2 }),
    type: () => UNIT.SAMLauncher,
  };
  const overlappingRouteSam = {
    ...routeSam,
    id: () => 13,
    tile: () => 21,
  };
  const routeSams = [routeSam, overlappingRouteSam];
  behavior.game.units = (type) => (type === UNIT.SAMLauncher ? routeSams : []);
  behavior.findEnemySamsCoveringTile = () => [];
  behavior.nukeStructureValue = () => 7;
  let targetSams = [];
  const valueStructure = { tile: () => ({ x: 99, y: 0 }) };
  const nukeTarget = {
    smallID: () => 2,
    units: (type) => {
      if (type === UNIT.SAMLauncher) return targetSams;
      if (type === UNIT.City) return [valueStructure];
      return [];
    },
  };
  behavior.player = {
    smallID: () => 1,
    units: (type) => (type === UNIT.MissileSilo ? [{ isUnderConstruction: () => false }] : []),
  };
  const routeCandidate = { tile: { x: 77, y: 0 }, value: 8 };
  behavior.nukeSpawn = (_type, tile) => (tile.x === 77 ? { x: 0, y: 0 } : false);
  behavior.isTrajectoryInterceptableBySam = (_spawn, tile, _excluded, options = {}) => {
    if (tile.x !== 77) return false;
    for (const sam of routeSams) options.interceptingSams?.add(sam);
    return true;
  };
  const partition = behavior.partitionCandidatesBySamCoverage(
    [routeCandidate],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.strictEqual(partition.routeBlockedTile, routeCandidate.tile);
  assert.equal(
    behavior
      .samSalvoTargetsFor(nukeTarget, partition.routeBlockedTile)
      .map((sam) => sam.id())
      .join(","),
    "12,13",
    "the candidate route resolves to every overlapping hostile SAM",
  );
  behavior.cost = async () => 1n;
  let plannedSamIds = [];
  behavior.orderCounterforceSams = (sams) => {
    plannedSamIds = sams.map((sam) => sam.id());
    return sams;
  };
  behavior.pinDemandSam = () => {};
  behavior.createSamOverwhelmPlan = () => ({
    capacityMissing: true,
    targetSamId: 12,
    targetTile: { x: 20, y: 0 },
    totalBombs: 3,
    coveringSamIds: new Set([12]),
    siloEntries: [],
  });
  behavior.maybeUpgradeHelpfulSilo = async () => false;
  behavior.samDemandMatchesTarget = () => false;
  behavior.fireLegendaryClearFallthrough = async () => false;
  behavior.maybeFirePostSalvoHydrogen = async () => false;
  assert.equal(
    await behavior.fireNukeFromCandidates(
      [routeCandidate],
      nukeTarget,
      { type: UNIT.AtomBomb },
      [],
      Difficulty.Legendary,
    ),
    false,
  );
  assert.equal(
    plannedSamIds.join(","),
    "12,13",
    "the real firing and counterforce path selects every overlapping SAM on the blocked candidate route",
  );
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    12,
    "a route-only interceptor arms the silo-capacity demand",
  );
  assert.equal(sandbox.state.nukeWantSlots?.need, 3);
  targetSams = [{ ...routeSam, id: () => 11 }];
  await behavior.fireNukeFromCandidates(
    [routeCandidate],
    nukeTarget,
    { type: UNIT.AtomBomb },
    [],
    Difficulty.Legendary,
  );
  assert.equal(
    plannedSamIds.join(","),
    "11,12,13",
    "target-owned SAMs do not hide overlapping SAMs blocking the candidate route",
  );
  targetSams = [];
  behavior.isTrajectoryInterceptableBySam = () => false;
  assert.equal(await behavior.maybeDestroyEnemySam(nukeTarget), false);
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "a dead route releases the demand instead of pinning it",
  );
}

// Route geometry is reused only for the current game tick; live SAM state is
// still checked on every interception query.
{
  let tick = 1000;
  let geometryBuilds = 0;
  let samChecks = 0;
  let samCanIntercept = false;
  const cacheBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  cacheBehavior.game = makeGame({ targetableRange: 10 });
  cacheBehavior.game.ticks = () => tick;
  cacheBehavior.findUntargetableTrajectoryRange = () => ({ start: -1, end: -1 });
  cacheBehavior.hasReachableSamAtTrajectoryIndex = () => {
    samChecks++;
    return samCanIntercept;
  };
  cacheBehavior.hasFinalExplosionSamInterception = () => false;
  const pathfinder = sandbox.__UniversalPathFinding.Parabola;
  sandbox.__UniversalPathFinding.Parabola = () => {
    geometryBuilds++;
    return { findPath: () => lineTrajectory(5) };
  };
  try {
    const spawn = { x: 0, y: 0 };
    const target = { x: 99, y: 0 };
    assert.equal(cacheBehavior.isTrajectoryInterceptableBySam(spawn, target), false);
    samCanIntercept = true;
    assert.equal(cacheBehavior.isTrajectoryInterceptableBySam(spawn, target), true);
    assert.equal(geometryBuilds, 1, "same-tick route queries reuse the parabola geometry");
    assert.ok(samChecks > 4, "same-tick route queries still recheck live SAM interception");
    tick++;
    samCanIntercept = false;
    assert.equal(cacheBehavior.isTrajectoryInterceptableBySam(spawn, target), false);
    assert.equal(geometryBuilds, 2, "the route cache resets when the game tick advances");
  } finally {
    sandbox.__UniversalPathFinding.Parabola = pathfinder;
  }
}

// Coarse spatial-index probes gather a conservative candidate superset; exact
// per-sample distance and missile-reach checks still run against live SAMs.
{
  const route = lineTrajectory(500);
  const routeBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  routeBehavior.player = { smallID: () => 1 };
  routeBehavior.getNukeTrajectory = () => route;
  routeBehavior.findUntargetableTrajectoryRange = () => ({ start: -1, end: -1 });
  const game = makeGame({ targetableRange: 10 });
  game.config = () => ({
    defaultNukeSpeed: () => 10,
    defaultNukeTargetableRange: () => 10,
    defaultSamMissileSpeed: () => 10,
    maxSamRange: () => 50,
    samRange: () => 50,
    isUnitDisabled: () => false,
  });
  routeBehavior.game = game;
  const enemy = { smallID: () => 2 };
  const firstSam = {
    id: () => 12,
    level: () => 2,
    tile: () => ({ x: 200, y: 0 }),
    owner: () => enemy,
  };
  const secondSam = {
    id: () => 13,
    level: () => 1,
    tile: () => ({ x: 350, y: 10 }),
    owner: () => enemy,
  };
  const underConstructionSam = {
    id: () => 14,
    level: () => 1,
    tile: () => ({ x: 100, y: 0 }),
    owner: () => enemy,
    isUnderConstruction: () => true,
  };
  let sams = [firstSam, secondSam, underConstructionSam];
  let nearbyQueries = 0;
  game.nearbyUnits = (tile, radius, _type, _predicate, includeUnderConstruction = false) => {
    nearbyQueries++;
    return sams
      .filter((sam) => includeUnderConstruction || !sam.isUnderConstruction?.())
      .map((unit) => ({ unit, distSquared: dist2(tile, unit.tile()) }))
      .filter((sam) => sam.distSquared <= radius * radius);
  };

  const optimizedInterceptors = new Set();
  const optimized = routeBehavior.isTrajectoryInterceptableBySam(
    route[0],
    route.at(-1),
    undefined,
    { interceptingSams: optimizedInterceptors },
  );
  const optimizedQueries = nearbyQueries;
  assert.equal(optimized, true);
  assert.deepEqual(
    [...optimizedInterceptors].map((sam) => sam.id()),
    [12, 13],
    "coarse probes retain every reachable live SAM and exclude unfinished SAMs by default",
  );
  assert.ok(
    optimizedQueries <= Math.ceil(route.length / 8) + 1,
    "a 500-sample route uses at most one spatial lookup per eight samples",
  );

  nearbyQueries = 0;
  const referenceInterceptors = new Set();
  let reference = false;
  for (let index = 0; index <= route.length - 2; index++) {
    if (
      routeBehavior.hasReachableSamAtTrajectoryIndex(route[index], route, index, undefined, {
        interceptingSams: referenceInterceptors,
      })
    )
      reference = true;
  }
  if (
    routeBehavior.hasFinalExplosionSamInterception(route, { start: -1, end: -1 }, undefined, {
      interceptingSams: referenceInterceptors,
    })
  )
    reference = true;
  const referenceQueries = nearbyQueries;
  assert.equal(reference, optimized, "coarse probing matches the exact per-tile reference");
  assert.deepEqual(
    [...optimizedInterceptors].map((sam) => sam.id()),
    [...referenceInterceptors].map((sam) => sam.id()),
    "coarse probing collects the same intercepting SAM set as per-tile queries",
  );
  assert.ok(
    referenceQueries > optimizedQueries * 4,
    "the optimized route uses fewer index queries",
  );

  assert.equal(
    routeBehavior.isTrajectoryInterceptableBySam(route[0], route.at(-1), new Set([12, 13])),
    false,
    "the batched candidate set still honors excluded SAM identities",
  );

  nearbyQueries = 0;
  sams = [];
  assert.equal(
    routeBehavior.isTrajectoryInterceptableBySam(route[0], route.at(-1)),
    false,
    "same-tick route checks observe SAM removal instead of caching live state",
  );
  sams = [underConstructionSam];
  assert.equal(
    routeBehavior.isTrajectoryInterceptableBySam(route[0], route.at(-1), undefined, {
      includeUnderConstruction: true,
    }),
    true,
    "the coarse collector preserves the caller's under-construction policy",
  );
}

process.stdout.write("nuke trajectory SAM coverage tests passed\n");
