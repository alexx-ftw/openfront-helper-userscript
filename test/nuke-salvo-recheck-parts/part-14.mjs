  assert.equal(await behavior.processPendingNukeLaunches(), false);
  assert.equal(
    behavior._pendingNukeLaunches[0].salvo.flightTicks,
    20,
    "a rejected quote retains the queued forecast until an actual dispatch",
  );
  assert.equal(sandbox.state.postSalvoHydrogen.dueTick, 850);
  player.buildables = buildables;
  world.tick++;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(
    sandbox.state.postSalvoHydrogen.dueTick,
    872,
    "a delayed shot propagates its refreshed flight through the pending finisher",
  );
}
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 1] });
  sandbox.state.nukeWantSlots = null;
  await behavior.fireSamSalvo(
    {
      targetTile: 20,
      totalBombs: 2,
      siloEntries: [],
      launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }],
    },
    nukeTarget,
    1n,
  );
  assert.equal(sandbox.state.postSalvoHydrogen.dueTick, 826);
  world.tick = 830;
  const finisher = sandbox.state.postSalvoHydrogen;
  const config = behavior.game.config();
  behavior.game.config = () => ({ ...config, isUnitDisabled: () => false });
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "an overdue finisher waits while its saturating salvo still has queued bombs",
  );
  assert.equal(sandbox.state.postSalvoHydrogen, finisher);
  const buildables = behavior.player.buildables;
  behavior.player.buildables = async () => [];
  assert.equal(await behavior.processPendingNukeLaunches(), false);
  assert.equal(finisher.dueTick, 826, "a rejected probe is not an actual launch");
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(sandbox.state.postSalvoHydrogen, finisher);
  behavior.player.buildables = buildables;
  world.tick = 831;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(
    finisher.dueTick,
    856,
    "the final arrival is measured from the actual late launch tick",
  );
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "the finisher cannot run while the late atom is still in flight",
  );
  sandbox.state.postSalvoHydrogen = null;
}

launchSink = null;

// ════════════════════════════════════════════════════════════════════════════
// 6.5. Per-tick salvo pacing: same-tick due bombs spread across ticks so the
// shared intent window cannot clip a salvo's tail
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  launchSink = launches;
  world.covering.push({ unit: world.sam("pacing-sam", 1), distSquared: 0 });
  const salvo = {
    salvoId: 99,
    plannedCoveringLevel: 1,
    targetTile: 20,
    targetSamId: "pacing-sam",
  };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, salvo),
      true,
      "the same-tick due bomb is queued",
    );
  }
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 800;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the paced pass still reports a launch",
  );
  assert.equal(launches.length, 3, "at most three due bombs launch on one tick");
  assert.equal(
    behavior._pendingNukeLaunches.length,
    2,
    "the overflow bombs are re-queued for the next tick",
  );
  assert.ok(
    behavior._pendingNukeLaunches.every((pending) => pending.dueTick === world.tick + 1),
    "each overflow bomb retries exactly one tick later",
  );
  world.tick = 801;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the next tick fires the remaining bombs",
  );
  assert.equal(launches.length, 5, "all five bombs eventually launch");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "the paced salvo drains completely");
}

launchSink = null;

// ════════════════════════════════════════════════════════════════════════════
// 7/6. Counterforce: an enemy silo whose owner can already afford a MIRV is
// the priority target, not just another 50k structure
// ════════════════════════════════════════════════════════════════════════════
{
  const tileOf = (x, y) => y * 1000 + x;
  const me = { smallID: () => 1, team: () => "blue" };
  const scoreGame = {
    ticks: () => 200,
    players: () => [me],
    x: (tile) => Number(tile) % 1000,
    y: (tile) => Math.floor(Number(tile) / 1000),
    euclideanDistSquared: (left, right) => {
      const dx = (Number(left) % 1000) - (Number(right) % 1000);
      const dy = Math.floor(Number(left) / 1000) - Math.floor(Number(right) / 1000);
      return dx * dx + dy * dy;
    },
    config: () => ({
      nukeMagnitudes: (type) =>
        type === UNIT.HydrogenBomb ? { inner: 80, outer: 100 } : { inner: 12, outer: 30 },
    }),
  };
  const scorer = new sandbox.__NukeBehavior(
    { chance: () => false },
    scoreGame,
    me,
    { shouldAttack: () => true },
    {},
  );
  const poorOwner = { smallID: () => 7, gold: () => 1_000_000n };
  const mirvRichOwner = { smallID: () => 8, gold: () => 30_000_000n };
  const poorSilo = {
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => tileOf(300, 300),
    owner: () => poorOwner,
  };
  const richSilo = {
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => tileOf(700, 300),
    owner: () => mirvRichOwner,
  };
  const silos = [{ tile: () => tileOf(300, 300) }];

  const poorScore = scorer.nukeTileScore(tileOf(300, 300), silos, [poorSilo], UNIT.AtomBomb);
  const richScore = scorer.nukeTileScore(
    tileOf(700, 300),
    [{ tile: () => tileOf(700, 300) }],
    [richSilo],
    UNIT.AtomBomb,
  );
  assert.equal(
    poorScore,
    50_000,
    "a silo owned below the MIRV price keeps its classic counterforce value",
  );
  assert.equal(
    richScore,
    150_000,
    "a silo whose owner can already pay for a MIRV scores as three ordinary silos",
  );
  assert.equal(
    scorer.mirvCapableSiloPriority({
      type: () => UNIT.MissileSilo,
      owner: () => null,
    }),
    1,
    "a silo without an owner view stays at the baseline priority",
  );
}

// ════════════════════════════════════════════════════════════════════════════
