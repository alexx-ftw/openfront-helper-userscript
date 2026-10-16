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
