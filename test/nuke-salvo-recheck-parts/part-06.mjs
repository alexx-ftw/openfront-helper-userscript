  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  behavior.attackBehavior.shouldAttack = () => !protectedTarget;
  const silo = { id: () => 1, level: () => 1 };
  behavior.getRouteEligibleSilos = () => [silo];
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.nukeDemandScopedSilos = () => [silo];
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async () => {
    if (change === "aim-during-probe") owner = player;
    if (change === "target-during-probe") protectedTarget = true;
    return [];
  };
  structures.rankNukeDemandSiloUpgrades = () => [{ silo }];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => {
    upgrades++;
    return true;
  };
  sandbox.state.nukeWantSlots = { targetSamId: 77, targetTile: 20, need: 4, unblockedSiloIds: [] };
  const allowed = change === "hostile" || change === "unowned";
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    allowed,
    `${change} capacity demand obeys nuclear policy`,
  );
  assert.equal(upgrades, allowed ? 1 : 0);
  if (!allowed) assert.equal(sandbox.state.nukeWantSlots, null);
  sandbox.state.nukeWantSlots = null;
}

for (const capture of [
  "hostile",
  "own-before-due",
  "own-during-probe",
  "teammate",
  "protected",
  "unowned",
]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  player.team = () => "blue";
  const teammate = {
    isPlayer: () => true,
    smallID: () => 3,
    team: () => "blue",
    isAlive: () => true,
  };
  const protectedPlayer = {
    isPlayer: () => true,
    smallID: () => 4,
    team: () => null,
    isAlive: () => true,
  };
  const unowned = { isPlayer: () => false };
  let owner = nukeTarget;
  game.owner = () => owner;
  behavior.attackBehavior.shouldAttack = (target) => target.smallID() !== 4;
  assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5), true);
  if (capture === "own-before-due") owner = player;
  const originalProbe = player.buildables;
  player.buildables = async (...args) => {
    if (capture === "own-during-probe") owner = player;
    if (capture === "teammate") owner = teammate;
    if (capture === "protected") owner = protectedPlayer;
    if (capture === "unowned") owner = unowned;
    return originalProbe(...args);
  };
  const emitted = [];
  launchSink = emitted;
  world.tick += 5;
  await behavior.processPendingNukeLaunches();
  const allowed = capture === "hostile" || capture === "unowned";
  assert.equal(emitted.length, allowed ? 1 : 0, `${capture} destination checked at emission`);
  assert.equal(
    behavior.hasPendingNukeLaunches(),
    false,
    `${capture} launch resolved without stale retries`,
  );
  if (!allowed)
    assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5), false);
  launchSink = null;
}

for (const rejection of ["captured-first", "captured-all", "none"]) {
  const { behavior, game, player, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  const captured = new Set();
  game.owner = (tile) => (captured.has(tile) ? player : nukeTarget);
  const probes = new Map();
  player.buildables = async (tile) => {
    probes.set(tile, (probes.get(tile) ?? 0) + 1);
    if (
      probes.get(tile) === 2 &&
      (rejection === "captured-all" || (rejection === "captured-first" && tile === 20))
    )
      captured.add(tile);
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  behavior.nukeHasPositiveExpectedValue = async () => true;
  const emitted = [];
  launchSink = emitted;
  const fired = await behavior.fireLegendaryClearFallthrough(
    [
      { tile: 20, value: 100 },
      { tile: 30, value: 50 },
    ],
    nukeTarget,
    { type: UNIT.AtomBomb, cost: 1n },
    [],
  );
  assert.equal(fired, rejection !== "captured-all", `${rejection} reports actual dispatch`);
  assert.deepEqual(
    emitted.map((shot) => shot.tile),
    rejection === "captured-all" ? [] : [rejection === "captured-first" ? 30 : 20],
    `${rejection} preserves the first valid ranked destination`,
  );
  launchSink = null;
}

{
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const firstCity = {
    tile: () => 20,
    level: () => 1,
    type: () => UNIT.City,
  };
  const secondCity = {
    tile: () => 30,
    level: () => 1,
    type: () => UNIT.City,
  };
  let cities = [firstCity, secondCity];
  nukeTarget.units = (type) => (type === UNIT.City ? cities : []);
  game.config = () => ({
    nukeMagnitudes: () => ({ inner: 1, outer: 2 }),
    isUnitDisabled: () => false,
  });
  game.euclideanDistSquared = (from, to) => (from - to) ** 2;
  behavior.observeHostileNukeThreats = () => {};
  behavior.isEligibleNukeTarget = () => true;
  behavior.isValidNukeDestination = () => true;
  behavior.blastHitsFriendlyLand = () => false;
  behavior.isUnderHeavyAttack = () => false;
  behavior.findStrategicBorderArmyTarget = () => null;
  behavior.probeCanBuildNuke = async () => true;
  behavior.shouldHoldCounterforceNuke = async () => false;
  behavior.nukeLaunchRouteViable = () => true;
  behavior.nukeStructureValue = () => 1_000_000;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.gold = () => 2_000_000n;
  assert.equal(
    await behavior.nukeHasPositiveExpectedValue(
      { tile: 20, coveringSamLevels: 0 },
      nukeTarget,
      { type: UNIT.AtomBomb, cost: 750_000n },
      [],
    ),
    true,
    "the fixture starts with enough live structure value to justify the first shot",
  );
  player.buildables = async () => {
    cities = cities.filter((city) => city !== firstCity);
    return [{ type: UNIT.AtomBomb, cost: 750_000n, canBuild: true }];
  };
  const emitted = [];
  launchSink = emitted;
  try {
    assert.equal(
      await behavior.fireLegendaryClearFallthrough(
        [
          { tile: 20, value: 100 },
          { tile: 30, value: 50 },
        ],
        nukeTarget,
        { type: UNIT.AtomBomb, cost: 750_000n },
        [],
      ),
      true,
      "an EV-stale first shot falls through to the next candidate",
    );
