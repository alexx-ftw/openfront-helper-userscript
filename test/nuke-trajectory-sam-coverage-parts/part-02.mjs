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
