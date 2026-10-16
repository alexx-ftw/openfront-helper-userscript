  const { nukeTarget, behavior } = makeSalvoWorld();
  let friendlyLand = false;
  behavior.observeHostileNukeThreats = () => {};
  behavior.isEligibleNukeTarget = () => true;
  behavior.isValidNukeDestination = () => true;
  behavior.probeNukeBuildable = async () => {
    friendlyLand = true;
    return { type: UNIT.AtomBomb, cost: 1n };
  };
  behavior.nukeBuildableCanLaunch = () => true;
  behavior.shouldHoldCounterforceNuke = async () => false;
  behavior.blastHitsFriendlyLand = () => friendlyLand;
  behavior.nukeLaunchRouteViable = () => true;
  let emitted = 0;
  behavior.emitNukeWithSalvoFlight = () => {
    emitted++;
    return true;
  };
  assert.equal(
    await behavior.sendNuke(20, UNIT.AtomBomb, nukeTarget),
    false,
    "ordinary launch rechecks friendly blast ownership after the async probe",
  );
  assert.equal(emitted, 0, "an ordinary nuke does not launch through friendly land");
}

for (const difficulty of ["Hard", "Legendary"]) {
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Nation;
  game.owner = () => nukeTarget;
  let samAppeared = false;
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = () => samAppeared;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    samAppeared = true;
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => difficulty;
  launches.length = 0;
  launchSink = launches;
  try {
    assert.equal(
      behavior.nukeLaunchRouteViable(20, UNIT.AtomBomb, nukeTarget, null),
      true,
      `${difficulty} initially permits the clear route`,
    );
    assert.equal(await behavior.sendNuke(20, UNIT.AtomBomb, nukeTarget), false);
    assert.equal(launches.length, 0, `${difficulty} rejects a route blocked during the probe`);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  sandbox.state.nukeWantSlots = null;
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 5, 10] });
  let reservedCost = null;
  let sendAttempts = 0;
  behavior.shouldDeferNukeForEconomy = (_target, cost) => {
    reservedCost = cost;
    return cost > 1n;
  };
  behavior.sendNuke = async () => {
    sendAttempts++;
    return true;
  };
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 3,
        siloEntries: [],
        launchSequence: [{ flightTicks: 10 }, { flightTicks: 10 }, { flightTicks: 10 }],
      },
      nukeTarget,
      1n,
    ),
    false,
    "a salvo that would consume the protected gold reserve is deferred as a whole",
  );
  assert.equal(reservedCost, 3n, "the reserve policy sees every atom in the salvo");
  assert.equal(sendAttempts, 0, "a deferred salvo emits no partial strike");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "a deferred salvo leaves no queued tail");
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  sandbox.state.nukeWantSlots = null;
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 5] });
  behavior.blastHitsFriendlyLand = () => true;
  let sendAttempts = 0;
  behavior.sendNuke = async () => {
    sendAttempts++;
    return false;
  };
  assert.equal(
    await behavior.fireSamSalvo({ targetTile: 20, totalBombs: 2 }, nukeTarget, 1n),
    false,
    "a salvo whose aim is already unsafe is rejected before launch or queueing",
  );
  assert.equal(sendAttempts, 0);
  assert.equal(behavior._pendingNukeLaunches.length, 0);
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  let friendlyLand = false;
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 5] });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.blastHitsFriendlyLand = () => friendlyLand;
  behavior.sendNuke = async () => {
    friendlyLand = true;
    return false;
  };
  assert.equal(
    await behavior.fireSamSalvo({ targetTile: 20, totalBombs: 2 }, nukeTarget, 1n),
    false,
    "a newly allied blast is not enqueued as a retry after the async launch check",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 0);
}

for (const difficulty of ["Hard", "Impossible", "Legendary"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Nation;
  game.owner = () => nukeTarget;
  const plannedSamId = `${difficulty}-planned-sam`;
  const newSamId = `${difficulty}-new-sam`;
  const newSamUnderConstruction = difficulty === "Legendary";
  const routeSamIds = new Set([plannedSamId]);
  let blockDuringProbe = true;
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excludedSamIds, options = {}) =>
    [...routeSamIds].some(
      (samId) =>
        !excludedSamIds?.has(samId) &&
        (samId !== newSamId ||
          !newSamUnderConstruction ||
          options.includeUnderConstruction === true),
    );
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    if (blockDuringProbe) routeSamIds.add(newSamId);
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => difficulty;
  const emitted = [];
  launchSink = emitted;
  const salvo = {
    salvoId: difficulty,
    targetTile: 20,
    flightTicks: 20,
    coveringSamIds: [plannedSamId],
  };
  try {
    assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, salvo), true);
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 10, salvo),
      true,
      `${difficulty} has a future tail behind the due launch`,
    );
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      `${difficulty} keeps a queued salvo from launching through a route-only SAM`,
    );
    assert.equal(
      emitted.length,
      0,
      `${difficulty} has no destination SAM to hide the route blocker`,
    );
    assert.equal(
      behavior._pendingNukeLaunches.length,
      0,
      "a route blocker appearing during the probe drops the full salvo including its future tail",
    );
    routeSamIds.delete(newSamId);
    blockDuringProbe = false;
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
        ...salvo,
        salvoId: `${difficulty}-clear`,
      }),
