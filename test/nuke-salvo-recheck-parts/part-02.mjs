  behavior.isRetaliationNukeTarget = () => false;
  behavior.blastHitsFriendlyLand = () => false;
  const construction = Object.create(sandbox.__StructureBehavior.prototype);
  Object.assign(construction, { game, player });
  construction.hasActiveMaritimeInvasion = () => false;
  construction.economicConstructionPressure = () => null;
  construction.legendaryAtomWarChest = () => 0n;
  construction.offensiveNukeDefenseReserve = () => 60n;
  behavior.structureBehavior = construction;
  assert.equal(
    await behavior.canStartSamSalvo(
      { targetTile: 30 },
      nukeTarget,
      { bombsToFire: 2, claimIds: ownClaims },
      20n,
    ),
    canStart,
    `an unrelated ${otherClaimCost}-gold queued claim remains reserved`,
  );
  for (const claimId of [...otherClaims, ...ownClaims]) {
    sharedNukeLedger.release(game, player, claimId);
  }
}
sandbox.autoBotBuildNukeSlots = undefined;

{
  const { game, nukeTarget, behavior } = makeSalvoWorld();
  const samTile = { x: 5, y: 5 };
  const unsafeAim = { x: 7, y: 5 };
  const safeAim = { x: 5, y: 7 };
  const structures = [{ tile: () => ({ x: 9, y: 5 }) }, { tile: () => ({ x: 5, y: 9 }) }];
  const targetSam = {
    id: () => "aim-sam",
    tile: () => samTile,
    owner: () => nukeTarget,
  };
  nukeTarget.units = (type) => (type === UNIT.City ? structures : []);
  Object.assign(game, {
    config: () => ({ nukeMagnitudes: () => ({ outer: 5 }) }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    isValidCoord: () => true,
    ref: (x, y) => ({ x, y }),
    euclideanDistSquared: (left, right) => (left.x - right.x) ** 2 + (left.y - right.y) ** 2,
  });
  behavior.blastHitsFriendlyLand = (tile) =>
    (tile.x === samTile.x && tile.y === samTile.y) ||
    (tile.x === unsafeAim.x && tile.y === unsafeAim.y);
  behavior.blastStructureValue = (tile) => {
    if (tile.x === unsafeAim.x && tile.y === unsafeAim.y) return 100;
    if (tile.x === safeAim.x && tile.y === safeAim.y) return 50;
    return 10;
  };
  behavior.friendlyFirePenalty = () => 0;
  assert.deepEqual(
    behavior.samSalvoAimTile(targetSam),
    safeAim,
    "an unsafe highest-value aim falls back to the best safe aim that still covers the SAM",
  );
}

{
  const { world, game, nukeTarget, behavior } = makeSalvoWorld();
  const buildingSam = world.sam("building-sam", 2);
  buildingSam.isUnderConstruction = () => true;
  world.targetSams.push(buildingSam);
  world.covering.push({ unit: buildingSam, distSquared: 0 });
  game.config = () => ({
    maxSamRange: () => 100,
    samRange: () => 100,
    SAMCooldown: () => 100,
  });
  game.nearbyUnits = (_tile, _range, type, _predicate, includeUnderConstruction) =>
    type === UNIT.SAMLauncher && (includeUnderConstruction || !buildingSam.isUnderConstruction())
      ? [{ unit: buildingSam, distSquared: 0 }]
      : [];
  behavior.samSalvoAimTile = () => 20;
  behavior.getAvailableSiloEntries = () =>
    [10, 20, 30].map((flightTicks) => ({
      flightTicks,
      interceptable: false,
    }));
  behavior.createSamLaunchSequence = (entries) => entries;
  const plan = behavior.createSamOverwhelmPlan(buildingSam, [{}]);
  assert.equal(
    plan.coveringSamLevels,
    2,
    "capacity planning includes a hostile SAM that can finish construction before impact",
  );
  assert.equal(plan.totalBombs, 3);

  behavior.samSalvoCapacityAtArrival = () => 2;
  behavior.samSalvoLiveCapacitySpend = () => 0;
  assert.equal(
    behavior.samSalvoStillViable(
      { targetPlayer: nukeTarget, salvo: { targetTile: 20, targetSamId: buildingSam.id() } },
      1,
      30,
    ),
    false,
    "in-flight salvo rechecks account for SAMs under construction",
  );

  world.covering = [];
  const stalePlan = {
    targetTile: 20,
    targetSamId: buildingSam.id(),
    coveringSamIds: new Set(),
    totalBombs: 1,
  };
  const launchMetadata = behavior.nextSamSalvoPlan(stalePlan);
  world.covering.push({ unit: buildingSam, distSquared: 0 });
  assert.equal(
    behavior.samSalvoLaunchStillViable(20, nukeTarget, launchMetadata),
    false,
    "a SAM started during the async probe aborts an undersized first launch",
  );
}

{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  const plannedSam = world.sam("upgraded-planned-sam", 1);
  world.covering.push({ unit: plannedSam, distSquared: 0 });
  world.targetSams.push(plannedSam);
  const pending = {
    tile: 20,
    targetPlayer: nukeTarget,
    salvo: {
      salvoId: 1,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "upgraded-planned-sam",
      coveringSamIds: ["upgraded-planned-sam"],
    },
  };
  assert.equal(behavior.samSalvoStillViable(pending, 2, 820), true);
  plannedSam.level = () => 2;
  assert.equal(
    behavior.samSalvoStillViable(pending, 2, 820),
    false,
    "a level increase on an already planned SAM invalidates the stale salvo",
  );
}

{
  const { behavior } = makeSalvoWorld();
  const sam = { id: () => "pinned-sam", level: () => 1, tile: () => 30 };
  const inspectedTiles = [];
  const previousDemand = sandbox.state.nukeWantSlots;
  sandbox.state.nukeWantSlots = {
    targetSamId: "pinned-sam",
    targetTile: 20,
  };
  behavior.game.config = () => ({ SAMCooldown: () => 100 });
  behavior.samSalvoAimTile = () => 30;
  behavior.findEnemySamsCoveringTile = (tile) => {
    inspectedTiles.push(tile);
    return [sam];
  };
  behavior.getAvailableSiloEntries = (_silos, tile) => {
    inspectedTiles.push(tile);
    return [];
  };
  behavior.createSamLaunchSequence = () => [];
  behavior.findSamArrivalWindow = () => [];
  try {
    const plan = behavior.createSamOverwhelmPlan(sam, []);
    assert.equal(plan.targetTile, 20);
    assert.deepEqual(inspectedTiles, [20, 20], "capacity and routes share the pinned demand tile");
  } finally {
    sandbox.state.nukeWantSlots = previousDemand;
  }
}

// Receipt barriers preserve a valid prefix without inventing SAM capacity.
for (const release of ["expiry", "alliance"]) {
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("receipt-target", 1);
  world.covering.push({ unit: sam, distSquared: 0 });
  world.targetSams.push(sam);
  const emitted = [];
  launchSink = emitted;
  let awaiting = true;
  sandbox.autoBotBuildPendingNukes = () => (awaiting ? [{ salvoId: 7 }] : []);
  try {
    behavior._pendingNukeLaunches = [
      {
        dueTick: world.tick,
        tile: 20,
        nukeType: UNIT.AtomBomb,
