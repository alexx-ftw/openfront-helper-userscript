// 4/4. Hydrogen finisher: scheduled by the saturating salvo, fires only once
// due AND the covering SAMs are actually gone; live coverage aborts it.
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launchSink = launches;
  behavior.game.players = () => [nukeTarget];
  behavior.game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    samRange: () => 150,
    nukeMagnitudes: () => ({ inner: 80, outer: 100 }),
  });
  behavior.game.euclideanDistSquared = (a, b) => (a - b) * (a - b);
  // The finisher's enemy-value gate needs a priced structure at the target.
  world.targetSams.push(world.sam("finisher-target-sam", 1));
  launches.length = 0;
  behavior.player.gold = () => 10_000_000n;
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo
      ? [
          {
            isUnderConstruction: () => false,
            tile: () => 500,
            level: () => 1,
            type: () => UNIT.MissileSilo,
          },
        ]
      : [];
  behavior.player.buildables = async () => [
    { type: UNIT.HydrogenBomb, cost: 5_000_000n, canBuild: true },
  ];
  const totalNukesBefore = sandbox.state.stats.nukes;
  sandbox.state.postSalvoHydrogen = {
    targetTile: 20,
    dueTick: world.tick + 10,
    targetSmallID: nukeTarget.smallID(),
  };
  world.covering.push({ unit: world.sam("enemy-sam-1", 2), distSquared: 0 });
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "live covering SAMs abort the Hydrogen finisher",
  );
  assert.deepEqual(launches, [], "nothing launched into coverage");
  world.covering.length = 0;
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "a finisher before its due tick stays queued",
  );
  assert.ok(
    sandbox.state.postSalvoHydrogen !== null,
    "the pending finisher survives an early check",
  );
  world.tick = 10_000;
  sandbox.state.postSalvoHydrogen.dueTick = 9_999;
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    true,
    "a due finisher over cleared coverage fires the Hydrogen bomb",
  );
  assert.deepEqual(
    launches,
    [{ type: UNIT.HydrogenBomb, tile: 20 }],
    "the finisher is a Hydrogen bomb at the salvo's target tile",
  );
  assert.equal(behavior.hydrogenBombsLaunched, 1, "the finisher counts as a Hydrogen launch");
  assert.equal(
    sandbox.state.stats.nukes,
    totalNukesBefore + 1,
    "one dispatched finisher is one total nuke",
  );
  assert.equal(sandbox.state.postSalvoHydrogen, null, "a fired finisher clears the schedule");
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(
    behavior.hydrogenBombsLaunched,
    1,
    "a repeated check cannot count the finisher again",
  );
}

{
  // Projected coverage: a SAM still under construction completes before any
  // in-flight bomb lands, so it must block the finisher like an armed one.
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  behavior.player.gold = () => 10_000_000n;
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo
      ? [
          {
            isUnderConstruction: () => false,
            tile: () => 500,
            level: () => 1,
            type: () => UNIT.MissileSilo,
          },
        ]
      : [];
  behavior.player.buildables = async () => [
    { type: UNIT.HydrogenBomb, cost: 5_000_000n, canBuild: true },
  ];
  const wipSam = world.sam("enemy-sam-wip", 2);
  wipSam.isUnderConstruction = () => true;
  world.covering.push({ unit: wipSam, distSquared: 0 });
  sandbox.state.postSalvoHydrogen = {
    targetTile: 20,
    dueTick: world.tick,
    targetSmallID: nukeTarget.smallID(),
  };
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "a SAM under construction already blocks the Hydrogen finisher",
  );
  assert.deepEqual(launches, [], "nothing launched into projected coverage");
  sandbox.state.postSalvoHydrogen = null;
}

launchSink = null;

// ════════════════════════════════════════════════════════════════════════════
// 5. A live capacity demand pins the strike to its remembered SAM and re-arms
// after a mid-flight abort; satisfaction follows the planner gate
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior, player } = makeSalvoWorld();
  const decoy = world.sam("decoy-sam", 1);
  const priority = world.sam("priority-sam", 3);
  world.targetSams.push(decoy, priority);
  player.units = (type) =>
    type === UNIT.MissileSilo ? [{ isUnderConstruction: () => false }] : [];
  sandbox.state.nukeWantSlots = {
    need: 5,
    targetSamId: "priority-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  behavior.createSamOverwhelmPlan = (sam) => ({ planFor: sam.id() });
  const firedPlans = [];
  behavior.fireSamSalvo = async (plan) => {
    firedPlans.push(plan.planFor);
    return true;
  };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.deepEqual(
    firedPlans,
    ["priority-sam"],
    "a live capacity demand pins the strike to its remembered SAM",
  );
  sandbox.state.nukeWantSlots = null;
}
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  world.targetSams.push(world.sam("pinned-sam", 3));
  sandbox.state.nukeWantSlots = {
    need: 5,
    targetSamId: "pinned-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  assert.equal(
    behavior.samDemandStrikeTarget(),
    nukeTarget,
    "a live demand pins the maybeSendNuke strike target",
  );
  sandbox.state.nukeWantSlots = {
    ...sandbox.state.nukeWantSlots,
    pendingLaunches: true,
  };
  assert.equal(
    behavior.samDemandStrikeTarget(),
    null,
    "an in-flight salvo does not re-pin the ordinary lane",
  );
  sandbox.state.nukeWantSlots = null;
  assert.equal(behavior.samDemandStrikeTarget(), null);
}
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  world.targetSams.push(world.sam("retry-pinned-sam", 3));
  sandbox.state.nukeWantSlots = {
    need: 5,
    targetSamId: "retry-pinned-sam",
    at: 800,
    targetTile: 20,
