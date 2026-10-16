for (const invalidation of ["dead", "teammate"]) {
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  behavior._pendingNukeLaunches = [
    {
      dueTick: 900,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
    },
  ];
  sandbox.state.nukeWantSlots = reservation();
  if (invalidation === "dead") {
    nukeTarget.isAlive = () => false;
  } else {
    player.team = () => "Blue";
    nukeTarget.team = () => "Blue";
  }
  assert.equal(await behavior.processPendingNukeLaunches(), false);
  assert.equal(
    behavior.hasPendingNukeLaunches(),
    false,
    "a future launch against an invalid target must not block new nuclear decisions",
  );
  assert.equal(sandbox.state.nukeWantSlots, null, "cancelled future launches release reservations");
}

// ════════════════════════════════════════════════════════════════════════════
// A spent SAM charge cannot intercept a finisher before its reload deadline.
for (const [flightTicks, dueTick, expectedLaunch] of [
  [10, 805, true],
  [295, 805, false],
  [295, 790, false],
]) {
  const { world, game, nukeTarget, behavior } = makeSalvoWorld();
  world.tick = 805;
  game.config = () => ({ maxSamRange: () => 150, samRange: () => 150, SAMCooldown: () => 300 });
  const sam = world.sam("cooling-sam", 1);
  sam.missileTimerQueue = () => [800];
  world.covering.push({ unit: sam, distSquared: 0 });
  world.targetSams.push(sam);
  behavior._pendingNukeLaunches = [
    {
      dueTick,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
      salvo: { salvoId: 99, targetTile: 20, targetSamId: "cooling-sam", flightTicks },
    },
  ];
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    expectedLaunch,
    "SAM reload timing, not its full level, determines whether the finisher can penetrate",
  );
}

// 1/3. A live salvo carries plan metadata, continues while re-validation
// passes, and aborts when a new covering SAM outruns the remaining atoms
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launchSink = launches;
  const targetSam = world.sam("enemy-sam-1", 1);
  world.covering.push({ unit: targetSam, distSquared: 0 });
  world.targetSams.push(targetSam);
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 5, 10] });
  sandbox.state.nukeWantSlots = null;
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 3,
        coveringSamLevels: 1,
        targetSamId: "enemy-sam-1",
        siloEntries: [],
        launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }, { flightTicks: 20 }],
      },
      nukeTarget,
      1n,
    ),
    true,
    "a valid staggered SAM-overwhelm salvo is accepted",
  );
  assert.deepEqual(
    launches,
    [{ type: UNIT.AtomBomb, tile: 20 }],
    "only the zero-wait bomb launches on the planning tick",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 2, "the delayed bombs stay queued");
  const salvoIds = new Set(behavior._pendingNukeLaunches.map((pending) => pending.salvo?.salvoId));
  assert.equal(salvoIds.size, 1, "both delayed entries share a single salvo id");
  for (const pending of behavior._pendingNukeLaunches) {
    assert.ok(pending.salvo, "each delayed salvo entry carries plan metadata");
    assert.equal(pending.salvo.targetTile, 20);
    assert.equal(pending.salvo.targetSamId, "enemy-sam-1");
    assert.equal(pending.salvo.plannedCoveringLevel, 1);
    assert.equal(pending.salvo.flightTicks, 20, "queued launches retain their planned flight time");
  }

  // The level-1 SAM is still beatable by the 2 remaining bombs: the salvo
  // continues through its first delayed bomb.
  world.tick = 805;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the salvo continues when mid-flight re-validation still passes",
  );
  assert.equal(launches.length, 2, "the tick-805 bomb fires after re-validation");
  assert.equal(behavior._pendingNukeLaunches.length, 1, "the tick-810 bomb stays queued");
  assert.notEqual(
    sandbox.state.nukeWantSlots,
    null,
    "the silo reservation survives while the salvo is still in flight",
  );

  // The enemy finishes a NEW covering SAM mid-flight: the level sum is now 4,
  // so penetrating needs 5 bombs, but only the single tick-810 atom remains.
  world.covering.push({ unit: world.sam("enemy-sam-2", 3), distSquared: 0 });
  world.tick = 810;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "a salvo that can no longer penetrate reports no launch",
  );
  assert.equal(
    launches.length,
    2,
    "the remaining atom is dropped instead of being wasted on certain interception",
  );
  assert.equal(
    behavior._pendingNukeLaunches.length,
    0,
    "the aborted salvo's last entry is removed",
  );
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "aborting the final pending launch releases the silo reservation",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. A salvo whose target SAM is already destroyed (with no remaining enemy
// coverage at the tile) aborts as overkill — unless the SAM still exists
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 1,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "destroyed-sam",
    }),
    true,
    "the remaining salvo bomb is queued",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 805;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "a salvo over a destroyed target SAM reports no launch",
  );
  assert.equal(launches.length, 0, "no further atom lands on the zero-value rubble tile");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "the overkill entry is dropped");
  assert.equal(sandbox.state.nukeWantSlots, null, "the dropped salvo releases the reservation");

  // The target SAM still exists on the hostile roster (only its coverage
  // snapshot is stale): the salvo keeps firing rather than aborting.
  const survivingSam = world.sam("surviving-sam", 1);
  world.targetSams.push(survivingSam);
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 2,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "surviving-sam",
    }),
    true,
    "the follow-up salvo bomb is queued",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 810;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "a target SAM that still exists does not abort the salvo",
  );
