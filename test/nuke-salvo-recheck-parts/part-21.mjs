for (const fallbackKind of ["sam-demand", "higher-value"]) {
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const test = makeIncomingNukePriorityCase(fallbackKind === "sam-demand");
  const fallbackTarget = fallbackKind === "sam-demand" ? test.nukeTarget : test.richerTarget;
  test.behavior.fireNukeFromCandidates = async (candidates, target) => {
    test.fireAttempts.push({ target, tile: candidates[0]?.tile });
    return target === fallbackTarget;
  };
  try {
    await test.behavior.maybeSendNuke();
    assert.deepEqual(test.collectedTargets, [test.incomingTarget, fallbackTarget]);
    assert.deepEqual(
      test.fireAttempts,
      [
        { target: test.incomingTarget, tile: "attacker-tile" },
        {
          target: fallbackTarget,
          tile: fallbackKind === "sam-demand" ? "demand-tile" : "richer-rival-tile",
        },
      ],
      `${fallbackKind} fallback fires its own collected target and tile after attacker rejection`,
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

{
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const test = makeIncomingNukePriorityCase(true);
  test.behavior.fireNukeFromCandidates = async (candidates, target) => {
    test.fireAttempts.push({ target, tile: candidates[0]?.tile });
    return target === test.richerTarget;
  };
  try {
    await test.behavior.maybeSendNuke();
    assert.deepEqual(
      test.collectedTargets,
      [test.incomingTarget, test.nukeTarget, test.richerTarget],
      "Legendary tries its higher-value target after the SAM-demand fallback cannot fire",
    );
    assert.deepEqual(
      test.fireAttempts.map(({ target }) => target),
      [test.incomingTarget, test.nukeTarget, test.richerTarget],
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

{
  const { game, behavior } = makeSalvoWorld();
  let includedUnderConstruction = false;
  game.nearbyUnits = (_tile, _radius, _type, _predicate, include) => {
    includedUnderConstruction = include;
    return [];
  };
  behavior.hasReachableSamAtTrajectoryIndex(20, [], 0, undefined, {
    includeUnderConstruction: true,
  });
  assert.equal(
    includedUnderConstruction,
    true,
    "route interception queries request SAMs under construction during salvo revalidation",
  );
}

{
  const { behavior, world } = makeSalvoWorld();
  const wipSam = world.sam("aborted-route-sam-wip", 1);
  wipSam.isUnderConstruction = () => true;
  world.covering.push({ unit: wipSam, distSquared: 0 });
  behavior.isValidNukeTarget = () => true;
  const covering = behavior.abortedSamCoverage({ tile: 20 });
  assert.equal(
    covering[0]?.id(),
    wipSam.id(),
    "aborted capacity demand keeps projected SAM coverage alive for re-arming",
  );
}

{
  // Demand serviced first — but only when it coincides with the lane objective.
  const { behavior } = makeSalvoWorld();
  const demandTarget = { smallID: () => 7, isAlive: () => true };
  behavior.samDemandStrikeTarget = () => demandTarget;
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [], routeBlockedTile: null });
  const demandCalls = [];
  behavior.maybeDestroyEnemySam = async (...args) => {
    demandCalls.push(args);
    return true;
  };
  let clearCalls = 0;
  behavior.fireLegendaryClearFallthrough = async () => {
    clearCalls++;
    return false;
  };
  assert.equal(
    await behavior.fireNukeFromCandidates(
      [],
      demandTarget,
      { type: UNIT.AtomBomb, cost: 1n },
      [],
      "Legendary",
    ),
    true,
    "a matching demand is serviced before any clear-shot lane",
  );
  assert.deepEqual(demandCalls, [[demandTarget, false, null]]);
  assert.equal(clearCalls, 0, "a serviced demand consumes the lane before the clear fallthrough");
}

{
  // The demand lane declining yields the silo to the lane objective.
  const { behavior } = makeSalvoWorld();
  const demandTarget = { smallID: () => 7, isAlive: () => true };
  behavior.samDemandStrikeTarget = () => demandTarget;
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [], routeBlockedTile: null });
  const demandCalls = [];
  behavior.maybeDestroyEnemySam = async (...args) => {
    demandCalls.push(args);
    return false;
  };
  const clearTargets = [];
  behavior.fireLegendaryClearFallthrough = async (_clear, target) => {
    clearTargets.push(target);
    return true;
  };
  assert.equal(
    await behavior.fireNukeFromCandidates(
      [],
      demandTarget,
      { type: UNIT.AtomBomb, cost: 1n },
      [],
      "Legendary",
    ),
    true,
    "a declined demand yields the silo to the lane objective",
  );
  assert.deepEqual(demandCalls, [[demandTarget, false, null]]);
  assert.deepEqual(clearTargets, [demandTarget]);
}

{
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  const silo = {
    id: () => 9,
    level: () => 3,
    tile: () => 10,
    missileTimerQueue: () => [],
    isUnderConstruction: () => false,
  };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  game.manhattanDist = (from, to) => Math.abs(from - to);
  sandbox.autoBotBuildClaimNukeLaunches = sharedNukeLedger.claim;
  sandbox.autoBotBuildReleaseNukeLaunchClaim = sharedNukeLedger.release;
  sandbox.autoBotBuildNukeSlots = sharedNukeLedger.slots;
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 0] });
  behavior.hasPendingNukeLaunches = () => false;
  behavior.blastHitsFriendlyLand = () => true;
  sandbox.state.nukeWantSlots = null;
  const ledgerCapacity = () =>
    [...sharedNukeLedger.slots(game, player, null, true).values()].reduce(
      (total, count) => total + count,
      0,
    );
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 2,
        siloEntries: [],
        launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }],
      },
      nukeTarget,
      20n,
    ),
    false,
    "a salvo whose start check rejects after claiming cannot fire",
  );
  assert.equal(
    ledgerCapacity(),
    3,
    "a start-check rejection releases every unqueued claim back to the ledger",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 0);
  assert.equal(sandbox.state.nukeWantSlots, null);
  sandbox.autoBotBuildClaimNukeLaunches = undefined;
