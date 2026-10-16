  assert.equal(launches.length, 1, "the bomb fires against the surviving SAM");
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Plain waitTicks launches (no plan metadata) keep firing unchanged even in
// a world state that would abort a salvo — and an aborted salvo never drops an
// unrelated pending launch
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5),
    true,
    "the plain delayed launch is queued",
  );
  assert.equal(
    behavior._pendingNukeLaunches[0].salvo,
    null,
    "plain delayed launches carry no salvo metadata",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 805;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "non-salvo delayed launches fire without any SAM re-validation",
  );
  assert.equal(launches.length, 1, "the plain delayed bomb fires on its due tick");
  assert.equal(behavior._pendingNukeLaunches.length, 0);

  // An aborted salvo alongside an ordinary delayed launch: only the salvo
  // entries are dropped, the not-yet-due ordinary launch survives, and the
  // reservation persists because another pending launch remains.
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 1,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "destroyed-sam",
    }),
    true,
  );
  assert.equal(
    behavior.queueDelayedNukeLaunch(34, UNIT.AtomBomb, nukeTarget, 10),
    true,
    "an unrelated plain delayed launch is queued too",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 810;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "the aborted salvo fires nothing this pass",
  );
  assert.deepEqual(
    launches.map((launch) => launch.tile),
    [20],
    "no bomb fired while the salvo aborted and the plain launch was not yet due",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 1, "the aborted salvo entry is gone");
  assert.equal(
    behavior._pendingNukeLaunches[0].tile,
    34,
    "the ordinary launch survives the salvo abort",
  );
  assert.notEqual(
    sandbox.state.nukeWantSlots,
    null,
    "the reservation persists while the ordinary pending launch remains",
  );
  world.tick = 815;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the surviving ordinary launch fires on its own due tick",
  );
  assert.deepEqual(
    launches.map((launch) => launch.tile),
    [20, 34],
    "only the ordinary bomb fired after the abort",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 0);
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "the final pending launch clears the reservation",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 5/6. nukeTileScore penalizes friendly fire: a friendly MissileSilo inside
// the inner or outer radius flips the tile negative; the exact boundary survives
// ════════════════════════════════════════════════════════════════════════════
{
  const tileOf = (x, y) => y * 1000 + x;
  let scoreTick = 100;
  let ownStructures = [];
  let teammateStructures = [];
  let ownUnitsCalls = 0;
  const me = {
    smallID: () => 1,
    team: () => "blue",
    units: (type) => {
      ownUnitsCalls++;
      // Real players filter by type; the snapshot sweep asks per type.
      return type === UNIT.MissileSilo ? ownStructures : [];
    },
  };
  const teammate = {
    smallID: () => 2,
    team: () => "blue",
    isAlive: () => true,
    units: (type) => (type === UNIT.City ? teammateStructures : []),
  };
  const scoreGame = {
    ticks: () => scoreTick,
    players: () => [me, teammate],
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
  const candidate = tileOf(500, 500);
  const silos = [{ tile: () => candidate }];
  // A level-2 enemy City on the candidate tile: 50_000 of classic enemy value.
  const enemyStructures = [{ type: () => UNIT.City, level: () => 2, tile: () => candidate }];

  const enemyOnlyScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    enemyOnlyScore,
    50_000,
    "a tile hitting only enemy structures keeps its positive structure value",
  );

  // The friendly-structure snapshot is taken once per decision tick, not once
  // per candidate tile.
  const callsAfterFirstSweep = ownUnitsCalls;
  scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    ownUnitsCalls,
    callsAfterFirstSweep,
    "a same-tick second scoring pass reuses the friendly-structure snapshot",
  );
  scoreTick++;
  scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    ownUnitsCalls > callsAfterFirstSweep,
    true,
    "the friendly-structure snapshot refreshes on the next decision tick",
  );

  // Our own MissileSilo 5 tiles out — inside the atom's 12-tile inner radius.
  ownStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => tileOf(505, 500), owner: () => me },
  ];
  scoreTick++;
  const innerScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.ok(
    innerScore < 0,
    "a friendly MissileSilo inside the inner radius flips the tile negative",
  );
  assert.equal(
    innerScore,
    50_000 - 3 * 50_000,
    "the inner-radius penalty is the friendly silo value times the heavy multiplier",
  );

  // Same silo at 29 tiles — outside the inner radius, inside the 30-tile
  // outer radius: the engine destroys it just as completely as an inner hit.
  ownStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => tileOf(529, 500), owner: () => me },
  ];
  scoreTick++;
  const outerScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
