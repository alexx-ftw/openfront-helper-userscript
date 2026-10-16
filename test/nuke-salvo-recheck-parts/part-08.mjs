      behavior.selectAffordableNuke = async () => selected;
      const collectNukeCandidates = behavior.collectNukeCandidates.bind(behavior);
      let collectedCandidates = null;
      behavior.collectNukeCandidates = async (...args) => {
        collectedCandidates = await collectNukeCandidates(...args);
        return collectedCandidates;
      };
      const partitionCandidates = behavior.partitionCandidatesBySamCoverage.bind(behavior);
      let partitionedCandidates = null;
      behavior.partitionCandidatesBySamCoverage = (...args) => {
        partitionedCandidates = partitionCandidates(...args);
        return partitionedCandidates;
      };
      await behavior.maybeFreezeGiantStrike([silo], "Legendary");
      assert.equal(emitted.length, 0, "freeze: 850k does not meet the ordinary 3x reserve");
      assert.equal(
        collectedCandidates,
        null,
        "freeze: the ordinary reserve holds before candidate collection",
      );
      behavior.attackBehavior.findIncomingAttackPlayer = () => nukeTarget;
      behavior.isUnderHeavyAttack = () => true;
      await behavior.maybeFreezeGiantStrike([silo], "Legendary");
      assert.equal(collectedCandidates.length, 1, "freeze: real scoring retains the invasion tile");
      assert.equal(
        collectedCandidates[0].value,
        1,
        "freeze: positive survival coverage floors zero value to one",
      );
      assert.equal(
        partitionedCandidates.clear.length,
        0,
        "freeze: SAM coverage excludes the clear-shot lane",
      );
      assert.equal(
        partitionedCandidates.covered.length,
        1,
        "freeze: SAM coverage requires the full salvo lane",
      );
    }
    assert.equal(emitted.length, 1, `${lane}: launch the first atom now`);
    assert.equal(
      behavior._pendingNukeLaunches.length,
      1,
      `${lane}: queue the second atom required to overcome one SAM charge`,
    );
    const queuedAtom = behavior._pendingNukeLaunches[0];
    assert.equal(queuedAtom.salvo.plannedCoveringLevel, 1);
    assert.equal(queuedAtom.salvo.totalBombs, 2, `${lane}: the plan requires two Atom shots`);
    assert.equal(queuedAtom.nukeType, UNIT.AtomBomb);
    assert.ok(queuedAtom.dueTick > world.tick, `${lane}: the second Atom is delayed`);
    assert.equal(firedAtomTicks.length, 1, `${lane}: the first Atom occupies one of two slots`);

    if (lane === "ordinary") {
      player.gold = () => 100_000_000n;
      const mirv = new sandbox.__MirvBehavior({ chance: () => false }, game, player, {
        maybeSendAttackEmoji() {},
        sendEmoji() {},
      });
      mirv.cost = async () => 1n;
      mirv.teamHasWon = () => false;
      mirv.selectWinFixMirvTarget = () => nukeTarget;
      mirv.wasRecentlyMirved = () => false;
      let mirvLaunches = 0;
      mirv.maybeSendMIRV = async () => {
        mirvLaunches++;
        return true;
      };
      assert.equal(
        [...sharedNukeLedger.slots(game, player, null, true).values()].reduce(
          (total, count) => total + count,
          0,
        ),
        0,
        "the shared projection reserves the queued Atom after acknowledging the first launch",
      );
      assert.equal(mirv.hasReadyMIRVSlot(), false, "the queued Atom uses the final projected slot");
      assert.equal(
        await mirv.considerMIRV(),
        false,
        "a delayed salvo Atom reserves the Silo's last slot against an otherwise eligible MIRV",
      );
      assert.equal(mirvLaunches, 0, "MIRV eligibility rejects before attempting a launch");
      behavior.rearmAbortedSamDemand = () => {};
      behavior.finishPendingNukePass(new Set([queuedAtom.salvo.salvoId]), [queuedAtom], []);
      assert.equal(
        [...sharedNukeLedger.slots(game, player, null, true).values()].reduce(
          (total, count) => total + count,
          0,
        ),
        1,
        "aborting a queued salvo releases its claim and returns the still-free Silo slot",
      );
      assert.equal(mirv.hasReadyMIRVSlot(), true, "MIRV can use the slot after the salvo aborts");
    }
  } finally {
    launchSink = null;
    buildMenu = previousBuildMenu;
    if (previousRandomTiles === undefined) delete sandbox.randTerritoryTileArray;
    else sandbox.randTerritoryTileArray = previousRandomTiles;
    if (previousBoundingBoxTiles === undefined) delete sandbox.boundingBoxTiles;
    else sandbox.boundingBoxTiles = previousBoundingBoxTiles;
    sandbox.sendAutoBotBuildOrUpgrade = stubBuildSender;
    sandbox.autoBotBuildClaimNukeLaunches = undefined;
    sandbox.autoBotBuildReleaseNukeLaunchClaim = undefined;
    sandbox.autoBotBuildNukeSlots = undefined;
  }
}
sandbox.currentDifficulty = previousSalvoDifficulty;

{
  const { game, nukeTarget, behavior, world, player } = makeSalvoWorld();
  player.units = () => [];
  const pinnedSam = world.sam("freeze-demand-sam", 1);
  nukeTarget.units = (type) => (type === UNIT.SAMLauncher ? [pinnedSam] : []);
  const giant = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  game.players = () => [nukeTarget, giant];
  const request = {
    need: 4,
    targetSamId: pinnedSam.id(),
    targetTile: 20,
    unblockedSiloIds: [],
  };
  sandbox.state.nukeWantSlots = request;
  let frozenTarget = null;
  behavior.freezeGiantStrikeTarget = () => giant;
  behavior.collectNukeCandidates = async () => {
    throw new Error("a demand pinned to another player must stop the freeze lane");
  };
  behavior.sendNuke = async (_tile, _type, target) => {
    frozenTarget = target;
  };
  behavior.coveringSamsForSamFreeTarget = () => [];
  const samCleanupTargets = [];
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  behavior.maybeDestroyEnemySam = async (target) => {
    samCleanupTargets.push(target);
    return maybeDestroyEnemySam(target);
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.strictEqual(frozenTarget, null, "a pinned SAM demand prevents the giant fallback shot");
  assert.deepEqual(
    samCleanupTargets,
    [],
    "a SAM demand pinned to another player suppresses giant SAM cleanup",
  );
  assert.strictEqual(
    sandbox.state.nukeWantSlots,
    request,
    "a freeze-giant fallback cannot clear a live SAM demand pinned to another target",
  );
  sandbox.state.nukeWantSlots = null;
}

{
  const { game, nukeTarget, behavior } = makeSalvoWorld();
  const previousDifficulty = sandbox.currentDifficulty;
  const previousWinFixes = sandbox.state.settings.winFixes;
  const previousRandomTiles = sandbox.randTerritoryTileArray;
  const previousBoundingBoxTiles = sandbox.boundingBoxTiles;
  let coverage = 0.15;
  sandbox.currentDifficulty = () => "Legendary";
  sandbox.state.settings.winFixes = true;
  sandbox.randTerritoryTileArray = () => [20];
  sandbox.boundingBoxTiles = () => [20];
  game.ensureBorderTiles = async () => {};
  game.config = () => ({ nukeMagnitudes: () => ({ outer: 10 }) });
  behavior.isValidNukeTile = () => true;
  behavior.isNukeAlreadyLandingNear = () => false;
  behavior.nukeSpawn = () => 5;
  behavior.enemyLandBlastCoverage = () => coverage;
  behavior.isTrajectoryInterceptableBySam = () => false;
  behavior.isCounterforceSiloTarget = () => false;
  behavior.nukeTileScore = () => 0;
  behavior.attackBehavior.findIncomingAttackPlayer = () => nukeTarget;
  behavior.isUnderHeavyAttack = () => true;
  try {
    assert.equal(
      (await behavior.collectNukeCandidates(nukeTarget, UNIT.AtomBomb, [], "Legendary")).length,
      1,
      "active invasion accepts the exact 0.15 atom-coverage floor",
    );
    coverage = 0.149;
    assert.equal(
