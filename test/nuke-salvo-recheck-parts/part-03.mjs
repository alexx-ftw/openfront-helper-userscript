        targetPlayer: nukeTarget,
        salvo: { salvoId: 7, targetTile: 20, targetSamId: sam.id(), flightTicks: 20 },
      },
      {
        dueTick: world.tick,
        tile: 20,
        nukeType: UNIT.AtomBomb,
        targetPlayer: nukeTarget,
        salvo: null,
      },
    ];
    assert.equal(
      behavior.salvoAwaitingNativeReceipts({ salvoId: 8 }),
      false,
      "an unrelated salvo cannot inherit the prefix's receipt barrier",
    );
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      true,
      "an ordinary launch still progresses while a saturation tail waits",
    );
    assert.equal(emitted.length, 1);
    assert.equal(behavior._pendingNukeLaunches.length, 1);
    assert.equal(behavior._pendingNukeLaunches[0].salvo.salvoId, 7);
    world.tick++;
    if (release === "alliance") {
      player.team = () => "Blue";
      nukeTarget.team = () => "Blue";
    } else awaiting = false;
    assert.equal(await behavior.processPendingNukeLaunches(), false);
    assert.equal(
      behavior.hasPendingNukeLaunches(),
      false,
      `${release}: invalid diplomacy or an unsupported expired prefix cannot preserve the tail`,
    );
    assert.equal(emitted.length, 1, "the receipt barrier never grants fictitious SAM capacity");
  } finally {
    delete sandbox.autoBotBuildPendingNukes;
  }
}

// A validated batch can fill the send cap before its own new receipts block the next pass.
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("batch-target", 3);
  world.covering.push({ unit: sam, distSquared: 0 });
  world.targetSams.push(sam);
  const emitted = [];
  launchSink = emitted;
  sandbox.autoBotBuildPendingNukes = () => (emitted.length ? [{ salvoId: 70 }] : []);
  try {
    behavior._pendingNukeLaunches = Array.from({ length: 4 }, () => ({
      dueTick: world.tick,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
      salvo: { salvoId: 70, targetTile: 20, targetSamId: sam.id(), flightTicks: 20 },
    }));
    assert.equal(await behavior.processPendingNukeLaunches(), true);
    assert.equal(emitted.length, 3, "a validated batch uses but never exceeds the three-shot cap");
    assert.equal(behavior._pendingNukeLaunches.length, 1);
    world.tick++;
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      "the next pass still waits for the earlier emitted prefix",
    );
    assert.equal(emitted.length, 3);
    assert.equal(behavior._pendingNukeLaunches.length, 1);
  } finally {
    delete sandbox.autoBotBuildPendingNukes;
  }
}

// The ordinary construction budget must preserve every pending saturation Atom.
{
  const { behavior, player, game, world, nukeTarget } = makeSalvoWorld();
  game.config = () => ({ isUnitDisabled: () => false, maxSamRange: () => 150 });
  player.gold = () => 2_000_000n;
  player.units = () => [{ isUnderConstruction: () => false }];
  const budget = new sandbox.__StructureBehavior({}, game, player);
  budget.nukeBehavior = behavior;
  budget.ownSamCapacity = () => 1;
  budget.legendaryNukeStructureTargetExists = () => true;
  budget.safeConstructionCost = () => 750_000n;
  budget.firstSamConstructionReserve = () => 0n;
  const originalDifficultyCheck = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = () => true;
  try {
    for (const delay of [5, 10]) {
      assert.equal(
        behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, delay, {
          salvoId: 1,
          targetTile: 20,
          targetSamId: null,
        }),
        true,
      );
    }
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      500_000n,
      "a 600k City cannot consume the 1.5M still needed for two queued Atoms",
    );
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.Port),
      2_000_000n,
      "the existing trade-economy exemption remains available",
    );
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.SAMLauncher),
      2_000_000n,
      "actual missile defense retains priority over offensive funding",
    );
    sandbox.autoBotBuildReservedGold = () => 750_000n;
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      0n,
      "an already-emitted purchase plus the unsent tail cannot be spent again on a stale gold snapshot",
    );
    delete sandbox.autoBotBuildReservedGold;
    behavior.getAbortedSalvoIds = () => new Set();
    behavior.firePendingNukeLaunch = async () => "fired";
    world.tick += 5;
    assert.equal(await behavior.processPendingNukeLaunches(), true);
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      1_250_000n,
      "draining one entry shrinks the queue's construction reserve",
    );
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 10);
    nukeTarget.isAlive = () => false;
    await behavior.processPendingNukeLaunches();
    assert.equal(behavior.hasPendingNukeLaunches(), false);
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      1_250_000n,
      "cancelling the salvo releases its additional bank and retains the ordinary one-Atom reserve",
    );
  } finally {
    delete sandbox.autoBotBuildReservedGold;
    sandbox.isLegendaryDifficulty = originalDifficultyCheck;
  }
}

// A worker price probe can outlive the silo snapshot captured before it.
for (const invalidation of ["unchanged", "destroyed", "upgrading"]) {
  const { behavior, player, game, world, nukeTarget } = makeSalvoWorld();
  let active = true;
  let constructing = false;
  const silo = {
    isActive: () => active,
    isUnderConstruction: () => constructing,
    level: () => 3,
    missileTimerQueue: () => [],
    tile: () => 5,
  };
  player.units = (type) => (type === UNIT.MissileSilo && active ? [silo] : []);
  world.targetSams = [world.sam(1, 1)];
  game.config = () => ({ defaultNukeSpeed: () => 1, isUnitDisabled: () => false });
  Object.assign(game, {
    x: (tile) => tile,
    y: () => 50,
    height: () => 100,
    ref: (x) => x,
    manhattanDist: (a, b) => Math.abs(a - b),
  });
  behavior.isTrajectoryInterceptableBySam = () => true;
  behavior.cost = async () => {
    if (invalidation === "destroyed") active = false;
    else if (invalidation === "upgrading") constructing = true;
    return 1n;
  };
  behavior.createSamOverwhelmPlan = (_sam, silos) => ({
    capacityMissing: behavior.getAvailableSiloEntries(silos, 20, []).length === 0,
  });
  behavior.rememberFailedSamTarget = (plan) => plan;
  behavior.maybeUpgradeHelpfulSilo = async () => {};
  let salvos = 0;
  behavior.fireSamSalvo = async () => {
    salvos++;
    return true;
  };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(
    salvos,
    invalidation === "unchanged" ? 1 : 0,
    `${invalidation} silo eligibility after price await`,
  );
}
