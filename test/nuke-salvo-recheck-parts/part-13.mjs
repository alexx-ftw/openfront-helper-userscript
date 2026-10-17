    outerScore,
    innerScore,
    "both positions destroy the same silo and incur the same replacement penalty",
  );
  assert.ok(
    outerScore < enemyOnlyScore,
    "an outer-radius clip is still penalized against a clean enemy tile",
  );
  ownStructures[0].tile = () => tileOf(531, 500);
  scoreTick++;
  assert.equal(
    scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb),
    enemyOnlyScore,
    "a structure just past the outer boundary carries no loss penalty",
  );
  ownStructures[0].tile = () => tileOf(530, 500);
  scoreTick++;
  assert.equal(
    scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb),
    enemyOnlyScore,
    "a structure exactly on the outer boundary survives native unit deletion and carries no loss penalty",
  );

  // A permanent teammate's City cluster inside the inner radius counts as
  // friendly fire too.
  ownStructures = [];
  teammateStructures = [
    { type: () => UNIT.City, level: () => 1, tile: () => tileOf(500, 501), owner: () => teammate },
    { type: () => UNIT.City, level: () => 1, tile: () => tileOf(500, 502), owner: () => teammate },
  ];
  scoreTick++;
  const teammateScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.ok(
    teammateScore < 0,
    "a permanent teammate's City cluster inside the inner radius flips the tile negative",
  );
  assert.equal(
    teammateScore,
    50_000 - 3 * 2 * 25_000,
    "teammate structures use the same weighted friendly-fire penalty",
  );
}

// A temporary buildability failure must retain the complete salvo, including
// bombs after the failed send, and release the reservation when it drains.
for (const failedProbe of [1, 2]) {
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const emitted = [];
  launchSink = emitted;
  const buildables = player.buildables;
  let probes = 0;
  player.buildables = (...args) => (++probes === failedProbe ? [] : buildables(...args));
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 0, 5] });
  sandbox.state.nukeWantSlots = null;
  sandbox.state.postSalvoHydrogen = null;
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 3,
        siloEntries: [],
        launchSequence: Array.from({ length: 3 }, () => ({ flightTicks: 20 })),
      },
      nukeTarget,
      1n,
    ),
    true,
    "a temporary probe failure queues the full salvo",
  );
  assert.equal(emitted.length, failedProbe - 1, "no later bomb overtakes a failed immediate probe");
  assert.equal(behavior._pendingNukeLaunches.length, 4 - failedProbe);
  assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
  world.tick = 801;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(emitted.length, 2, "the failed immediate bomb retries once");
  world.tick = 805;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(emitted.length, 3, "the tail was not discarded or duplicated");
  assert.equal(behavior.hasPendingNukeLaunches(), false);
  assert.equal(sandbox.state.nukeWantSlots, null);
  sandbox.state.postSalvoHydrogen = null;
}

// A retrying queue head must retain its native silo slot before its tail fires.
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const emitted = [];
  launchSink = emitted;
  const buildables = player.buildables;
  let probes = 0;
  player.buildables = (...args) => (++probes === 1 ? [] : buildables(...args));
  behavior._pendingNukeLaunches = [20, 21].map((flightTicks) => ({
    dueTick: world.tick,
    tile: 20,
    nukeType: UNIT.AtomBomb,
    targetPlayer: nukeTarget,
    salvo: { salvoId: 123, flightTicks },
  }));
  behavior.getAbortedSalvoIds = () => new Set();
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "the tail cannot claim the retrying head's silo slot",
  );
  assert.equal(probes, 1);
  assert.equal(emitted.length, 0);
  world.tick++;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(emitted.length, 2);
  assert.equal(behavior.hasPendingNukeLaunches(), false);
}

{
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  player.buildables = async () => {
    nukeTarget.isAlive = () => false;
    return [];
  };
  behavior.getSamSalvo = () => ({ bombsToFire: 1, waits: [0] });
  sandbox.state.nukeWantSlots = null;
  assert.equal(await behavior.fireSamSalvo({ targetTile: 20 }, nukeTarget, 1n), false);
  assert.equal(behavior.hasPendingNukeLaunches(), false, "invalid targets cannot enter retry");
  assert.equal(sandbox.state.nukeWantSlots, null);
}

// Unexpected probe exceptions still propagate, but cannot leave a false
// capacity demand or an unmarked partial queue behind.
for (const delayedFirst of [false, true]) {
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const failure = new Error("worker probe failed");
  player.buildables = () => {
    throw failure;
  };
  const waits = delayedFirst ? [5, 0] : [0];
  behavior.getSamSalvo = () => ({ bombsToFire: waits.length, waits });
  sandbox.state.nukeWantSlots = null;
  const startSalvo = () =>
    behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: waits.length,
        siloEntries: [],
        launchSequence: waits.map(() => ({ flightTicks: 20 })),
      },
      nukeTarget,
      1n,
    );
  if (delayedFirst) {
    assert.equal(await startSalvo(), true, "a delayed head also queues the immediate tail");
    world.tick = 805;
    await assert.rejects(behavior.processPendingNukeLaunches(), (error) => error === failure);
    assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
    nukeTarget.isAlive = () => false;
    world.tick = 801;
    assert.equal(await behavior.processPendingNukeLaunches(), false);
    assert.equal(behavior.hasPendingNukeLaunches(), false);
  } else {
    await assert.rejects(startSalvo(), (error) => error === failure);
  }
  assert.equal(sandbox.state.nukeWantSlots, null, "no stale capacity reservation survives");
}

// The finisher must follow actual launches, not the original schedule when
// processing stalls or a launch is retried.
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  let liveFlight = 45;
  player.units = () => [{}];
  behavior.getAvailableSiloEntries = () => [{ flightTicks: liveFlight }];
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
  assert.equal(
    sandbox.state.postSalvoHydrogen.dueTick,
    850,
    "an immediate shot updates the finisher from its emission-time source flight",
  );
  world.tick++;
  liveFlight = 65;
  const buildables = player.buildables;
  player.buildables = async () => [];
