    assert.deepEqual(
      emitted.map((shot) => shot.tile),
      [30],
      "the launch probe rejects the cleared structure and preserves the next valuable target",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

for (const capture of ["before-due", "poor", "price", "price-poor", "buildable"]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  let owner = capture === "before-due" || capture === "poor" ? player : nukeTarget;
  game.owner = () => owner;
  game.players = () => [nukeTarget];
  game.config = () => ({
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ inner: 80, outer: 100 }),
  });
  game.euclideanDistSquared = (a, b) => (a - b) * (a - b);
  // The finisher's enemy-value gate needs a priced structure at the target
  // and no friendly structure inside its blast, so the capture rejections
  // under test are reached instead of the gate holding first.
  world.targetSams.push(world.sam("capture-target-sam", 1));
  player.gold = () => (capture === "poor" || capture === "price-poor" ? 0n : 10_000_000n);
  player.units = () => [
    {
      isUnderConstruction: () => false,
      tile: () => 500,
      level: () => 1,
      type: () => UNIT.MissileSilo,
    },
  ];
  behavior.findEnemySamsCoveringTile = () => [];
  behavior.getPerceivedNukeCost = async () => {
    if (capture === "price" || capture === "price-poor") owner = player;
    return 5_000_000n;
  };
  const originalProbe = player.buildables;
  player.buildables = async (...args) => {
    if (capture === "buildable") owner = player;
    return originalProbe(...args);
  };
  sandbox.state.postSalvoHydrogen = {
    targetTile: 20,
    dueTick: world.tick + (capture === "before-due" ? 10 : 0),
    targetSmallID: nukeTarget.smallID(),
  };
  const emitted = [];
  launchSink = emitted;
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(emitted.length, 0, `${capture} captured finisher cannot launch`);
  assert.equal(sandbox.state.postSalvoHydrogen, null, `${capture} captured finisher cancelled`);
  launchSink = null;
}

for (const type of [UNIT.AtomBomb, UNIT.HydrogenBomb]) {
  for (const throws of [false, true]) {
    const { behavior } = makeSalvoWorld();
    const emitted = [];
    const failure = new Error("build dispatch failed");
    buildMenu = {
      uiState: { rocketDirectionUp: false },
      sendBuildOrUpgrade(buildable, tile) {
        emitted.push({
          type: buildable.type,
          tile,
          rocketDirectionUp: this.uiState.rocketDirectionUp,
        });
        if (throws) throw failure;
      },
    };
    if (throws) {
      assert.throws(
        () => behavior.emitNukeBuildable({ type }, 20),
        (error) => error === failure,
      );
    } else {
      assert.equal(behavior.emitNukeBuildable({ type }, 20), true);
    }
    assert.deepEqual(
      emitted,
      [{ type, tile: 20, rocketDirectionUp: true }],
      "bot launches must use the same upward arc as their trajectory planner",
    );
    assert.equal(
      buildMenu.uiState.rocketDirectionUp,
      false,
      "bot dispatch must preserve the player's manual trajectory selection even on failure",
    );
  }
}
buildMenu = { sendBuildOrUpgrade() {} };

// A covered candidate requires an actual salvo, not merely enough silo levels.
const previousSalvoDifficulty = sandbox.currentDifficulty;
sandbox.currentDifficulty = () => "Legendary";
for (const lane of ["ordinary", "freeze"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("covered-target", 1);
  world.targetSams.push(sam);
  world.covering.push({ unit: sam, distSquared: 0 });
  const firedAtomTicks = [];
  const firedAtoms = [];
  let nextAtomId = 0;
  const silo = {
    id: () => 7,
    level: () => 2,
    tile: () => 10,
    missileTimerQueue: () => firedAtomTicks,
    isUnderConstruction: () => false,
  };
  player.units = (type) => {
    if (type === UNIT.MissileSilo) return [silo];
    if (type === UNIT.AtomBomb) return firedAtoms;
    return [];
  };
  game.manhattanDist = (from, to) => Math.abs(from - to);
  game.config = () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    SAMCooldown: () => 300,
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ inner: 5, outer: 10 }),
  });
  behavior.nukeSpawn = () => 5;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excluded) => !excluded?.has(sam.id());
  behavior.probeCanBuildNuke = async () => true;
  behavior.samSalvoAimTile = () => 20;
  behavior.getAvailableSiloEntries = () => [
    { silo, slots: 2, flightTicks: 20, interceptable: false },
  ];
  const candidates = [{ tile: 20, value: 100 }];
  const atomCost = lane === "ordinary" ? 20n : 400_000n;
  const selected = { type: UNIT.AtomBomb, cost: atomCost };
  const emitted = [];
  const previousRandomTiles = sandbox.randTerritoryTileArray;
  const previousBoundingBoxTiles = sandbox.boundingBoxTiles;
  const previousBuildMenu = buildMenu;
  buildMenu = {
    sendBuildOrUpgrade(buildable, tile) {
      if (buildable.type === UNIT.AtomBomb) {
        firedAtomTicks.push(world.tick);
        firedAtoms.push({ id: () => `atom-${++nextAtomId}`, targetTile: () => tile });
      }
    },
  };
  launchSink = emitted;
  sandbox.state.nukeWantSlots = null;
  sandbox.autoBotBuildClaimNukeLaunches = sharedNukeLedger.claim;
  sandbox.autoBotBuildReleaseNukeLaunchClaim = sharedNukeLedger.release;
  sandbox.autoBotBuildNukeSlots = sharedNukeLedger.slots;
  sandbox.sendAutoBotBuildOrUpgrade = (menu, buildable, tile, ...context) => {
    const sent = sharedNukeLedger.send(menu, buildable, tile, ...context);
    if (sent && launchSink) launchSink.push({ type: buildable.type, tile });
    return sent;
  };
  if (lane === "ordinary") {
    player.gold = () => 100n;
    behavior.cost = async () => atomCost;
    behavior.hasActiveMaritimeInvasion = () => false;
    behavior.isUnderHeavyAttack = () => false;
    behavior.isRetaliationNukeTarget = () => false;
    const construction = Object.create(sandbox.__StructureBehavior.prototype);
    Object.assign(construction, { game, player });
    construction.hasActiveMaritimeInvasion = () => false;
    construction.economicConstructionPressure = () => null;
    construction.legendaryAtomWarChest = () => 0n;
    construction.offensiveNukeDefenseReserve = () => 60n;
    behavior.structureBehavior = construction;
  } else {
    player.gold = () => 850_000n;
    behavior.cost = async () => atomCost;
    behavior.game.ensureBorderTiles = async () => {};
    behavior.isValidNukeTile = () => true;
    behavior.isNukeAlreadyLandingNear = () => false;
    behavior.enemyLandBlastCoverage = () => 0.2;
    behavior.nukeTileScore = () => 0;
    behavior.attackBehavior.findIncomingAttackPlayer = () => null;
    behavior.isUnderHeavyAttack = () => false;
    sandbox.randTerritoryTileArray = () => [20];
    sandbox.boundingBoxTiles = (_game, tile) => [tile];
  }
  try {
    if (lane === "ordinary") {
      await behavior.fireNukeFromCandidates(candidates, nukeTarget, selected, [silo], "Legendary");
    } else {
      behavior.freezeGiantStrikeTarget = () => nukeTarget;
