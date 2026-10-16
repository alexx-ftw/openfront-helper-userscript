      true,
    );
    world.tick++;
    assert.equal(await behavior.processPendingNukeLaunches(), true, "the clear route can retry");
    assert.equal(emitted.length, 1);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

for (const difficulty of ["Hard", "Impossible"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Nation;
  const center = { x: 5, y: 5 };
  let friendlyLand = false;
  let markFriendlyDuringProbe = true;
  game.owner = (tile) => (tile.x === center.x && tile.y === center.y ? nukeTarget : null);
  game.players = () => [player, nukeTarget];
  player.isFriendly = (other) => other.smallID?.() === player.smallID();
  game.config = () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ outer: 1 }),
  });
  Object.assign(game, {
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    ref: (x, y) => ({ x, y }),
    isValidCoord: () => true,
    ownerID: (tile) => (friendlyLand && tile.x === 6 && tile.y === 5 ? 1 : 0),
  });
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = () => false;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    if (markFriendlyDuringProbe) friendlyLand = true;
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => difficulty;
  sandbox.state.nukeWantSlots = null;
  const emitted = [];
  launchSink = emitted;
  try {
    assert.equal(
      behavior.queueDelayedNukeLaunch(center, UNIT.AtomBomb, nukeTarget, 0, {
        salvoId: `friendly-land-${difficulty}`,
        targetTile: center,
        flightTicks: 20,
        coveringSamIds: [],
      }),
      true,
    );
    assert.equal(
      behavior.queueDelayedNukeLaunch(center, UNIT.AtomBomb, nukeTarget, 20, {
        salvoId: `friendly-land-${difficulty}`,
        targetTile: center,
        flightTicks: 20,
        coveringSamIds: [],
      }),
      true,
    );
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      `${difficulty} rechecks blast ownership after the queued launch probe`,
    );
    assert.equal(emitted.length, 0, "no queued salvo launches through current friendly land");
    assert.equal(
      behavior._pendingNukeLaunches.length,
      0,
      "a newly unsafe blast is dropped instead of retrying and blocking the nuclear lane",
    );
    friendlyLand = false;
    markFriendlyDuringProbe = false;
    world.tick++;
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      "the dropped salvo is not retried",
    );
    assert.equal(emitted.length, 0);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  const incomingTarget = { smallID: () => 3, isAlive: () => true };
  player.units = () => [];
  behavior.nukeLaneBlockedByCapacity = () => false;
  behavior.samDemandStrikeTarget = () => nukeTarget;
  behavior.attackBehavior.findIncomingAttackPlayer = () => incomingTarget;
  behavior.isEligibleNukeTarget = (target) => target !== null;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  let selectedTarget = null;
  behavior.collectCandidatesWithRetry = async (target) => {
    selectedTarget = target;
    return { list: [], retargeted: null };
  };
  behavior.fireNukeFromCandidates = async () => true;
  await behavior.maybeSendNuke();
  assert.equal(
    selectedTarget,
    incomingTarget,
    "immediate retaliation keeps survival priority over a pending Silo-capacity demand",
  );
  let fireTarget = null;
  behavior.fireNukeFromCandidates = async (_candidates, target) => {
    fireTarget = target;
    return true;
  };
  behavior.collectCandidatesWithRetry = async (target) => {
    selectedTarget = target;
    return { list: [], retargeted: { smallID: () => 4, isAlive: () => true } };
  };
  await behavior.maybeSendNuke();
  assert.equal(
    fireTarget,
    incomingTarget,
    "the dispatch preserves the survival target over both the demand and candidate retarget",
  );
}

function makeIncomingNukePriorityCase(hasDemand = false) {
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  const incomingTarget = { smallID: () => 3, isAlive: () => true };
  const richerTarget = { smallID: () => 4, isAlive: () => true };
  const collectedTargets = [];
  const fireAttempts = [];
  player.units = () => [];
  behavior.nukeLaneBlockedByCapacity = () => false;
  behavior.samDemandStrikeTarget = () => (hasDemand ? nukeTarget : null);
  behavior.attackBehavior.findIncomingAttackPlayer = () => incomingTarget;
  behavior.isEligibleNukeTarget = (target) => target !== null;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.findHighestValueNukeTarget = () => richerTarget;
  behavior.findValueRankedNukeTargets = () => [{ target: richerTarget, value: 5_000_000 }];
  behavior.playerStructureValue = (target) => (target === richerTarget ? 5_000_000 : 1_000_000);
  behavior.collectNukeCandidates = async (target) => {
    collectedTargets.push(target);
    let tile = "demand-tile";
    if (target === incomingTarget) {
      tile = "attacker-tile";
    } else if (target === richerTarget) {
      tile = "richer-rival-tile";
    }
    return [
      {
        tile,
        value: 100,
        score: target === richerTarget ? 200 : 100,
      },
    ];
  };
  behavior.fireNukeFromCandidates = async (candidates, target) => {
    fireAttempts.push({ target, tile: candidates[0]?.tile });
    return false;
  };
  return { behavior, incomingTarget, richerTarget, nukeTarget, collectedTargets, fireAttempts };
}

{
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const test = makeIncomingNukePriorityCase(true);
  test.behavior.fireNukeFromCandidates = async (candidates, target) => {
    test.fireAttempts.push({ target, tile: candidates[0]?.tile });
    return true;
  };
  try {
    await test.behavior.maybeSendNuke();
    assert.deepEqual(test.collectedTargets, [test.incomingTarget]);
    assert.deepEqual(
      test.fireAttempts,
      [{ target: test.incomingTarget, tile: "attacker-tile" }],
      "a fireable attacker candidate keeps its own target and tile without pivoting",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

