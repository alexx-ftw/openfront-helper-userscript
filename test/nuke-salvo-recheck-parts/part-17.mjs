  });
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 7,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "original",
      flightTicks: 20,
    }),
    true,
  );
  sandbox.state.nukeWantSlots = { ...reservation(), targetSamId: "original" };
  world.tick = 805;
  await behavior.processPendingNukeLaunches();
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "replacement",
    "a mid-flight abort re-arms the demand against the live layout",
  );
  assert.equal(
    sandbox.state.nukeWantSlots?.need,
    5,
    "the re-armed demand prices the live covering SAM",
  );
  assert.equal(
    sandbox.state.nukeWantSlots?.pendingLaunches,
    undefined,
    "the re-armed demand can be serviced by the structure lane",
  );
  sandbox.state.nukeWantSlots = null;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Per-launch salvo revalidation on Legendary: a SAM spawned during the
// awaited probe drops the entry; the planned covering set stays exempt
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  player.units = (type) =>
    type === UNIT.MissileSilo
      ? [{ id: () => 1, level: () => 1, tile: () => 5, isUnderConstruction: () => false }]
      : [];
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excluded) =>
    !(excluded && excluded.has("sam-A")) &&
    world.covering.some((sam) => sam.unit.id() === "late-sam");
  for (let index = 0; index < 2; index++) {
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
        salvoId: 91,
        targetTile: 20,
        targetSamId: "sam-A",
        plannedCoveringLevel: 1,
        flightTicks: 20,
        coveringSamIds: ["sam-A"],
      }),
      true,
    );
  }
  world.covering.push({ unit: world.sam("sam-A", 1), distSquared: 0 });
  world.targetSams.push(world.sam("sam-A", 1));
  sandbox.state.nukeWantSlots = { ...reservation(), targetSamId: "sam-A" };
  const originalProbe = behavior.probeNukeBuildable.bind(behavior);
  behavior.probeNukeBuildable = async (tile, type) => {
    world.covering.push({ unit: world.sam("late-sam", 3), distSquared: 30 });
    return originalProbe(tile, type);
  };
  behavior.createSamOverwhelmPlan = (sam) => ({
    targetTile: 20,
    targetSamId: sam.id(),
    coveringSamIds: new Set(),
    totalBombs: 9,
    siloEntries: [],
  });
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "a SAM spawned mid-probe aborts the salvo pass",
  );
  assert.equal(launches.length, 0, "no atom launches through the new interception");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "aborted entries are dropped, not retried");
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "sam-A",
    "the aborted salvo re-arms its demand instead of stranding the prefix",
  );
  assert.equal(sandbox.state.nukeWantSlots?.need, 9);
  sandbox.currentDifficulty = previousDifficulty;
  sandbox.state.nukeWantSlots = null;
}
{
  const { world, game, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  launchSink = launches;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  game.config = () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    isUnitDisabled: () => false,
    SAMCooldown: () => 100,
  });
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excluded) =>
    !(excluded && excluded.has("sam-A"));
  const samA = world.sam("sam-A", 1);
  samA.missileTimerQueue = () => [805];
  world.covering.push({ unit: samA, distSquared: 0 });
  world.targetSams.push(world.sam("sam-A", 1));
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
      salvoId: 93,
      targetTile: 20,
      targetSamId: "sam-A",
      plannedCoveringLevel: 1,
      flightTicks: 20,
      coveringSamIds: ["sam-A"],
    }),
    true,
  );
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the covering SAM the salvo overwhelms must not abort its own salvo",
  );
  assert.equal(launches.length, 1);
  launches.length = 0;
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
      salvoId: 94,
      targetTile: 20,
      targetSamId: "sam-A",
      plannedCoveringLevel: 1,
      flightTicks: 20,
      coveringSamIds: [],
    }),
    true,
  );
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "an empty exemption set cannot launch through the covering SAM",
  );
  assert.equal(launches.length, 0);
  assert.equal(behavior._pendingNukeLaunches.length, 0);
  sandbox.currentDifficulty = previousDifficulty;
  sandbox.state.nukeWantSlots = null;
  launchSink = null;
}

{
  const { behavior, nukeTarget } = makeSalvoWorld();
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 0] });
  behavior.hasPendingNukeLaunches = () => false;
  let sends = 0;
  behavior.sendNuke = async () => ++sends === 1;
  behavior.queueDelayedNukeLaunch = () => false;
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        targetSamId: 2,
        totalBombs: 2,
        coveringSamLevels: 1,
        coveringSamIds: [],
        siloEntries: [],
        window: [],
        launchSequence: [],
      },
      nukeTarget,
      1n,
    ),
    true,
    "a partially sent ordinary salvo still suppresses a second freeze strike this tick",
  );
  assert.equal(sends, 2, "the salvo reports the first send after the second send and queue fail");
}

{
  const { game, nukeTarget, behavior, world, player } = makeSalvoWorld();
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const requestedSam = world.sam("ready-demand-sam", 1);
  world.targetSams.push(requestedSam);
  player.units = (type) =>
    type === UNIT.MissileSilo
      ? [{ id: () => "silo-1", level: () => 2, isUnderConstruction: () => false }]
