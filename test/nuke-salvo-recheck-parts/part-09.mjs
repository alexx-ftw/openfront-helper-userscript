      (await behavior.collectNukeCandidates(nukeTarget, UNIT.AtomBomb, [], "Legendary")).length,
      0,
      "active invasion rejects atom coverage below 0.15",
    );
    behavior.attackBehavior.findIncomingAttackPlayer = () => null;
    behavior.isUnderHeavyAttack = () => false;
    coverage = 0.2;
    assert.equal(
      (await behavior.collectNukeCandidates(nukeTarget, UNIT.AtomBomb, [], "Legendary")).length,
      0,
      "unrelated targets retain the standard 0.25 atom-coverage floor",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    sandbox.state.settings.winFixes = previousWinFixes;
    if (previousRandomTiles === undefined) delete sandbox.randTerritoryTileArray;
    else sandbox.randTerritoryTileArray = previousRandomTiles;
    if (previousBoundingBoxTiles === undefined) delete sandbox.boundingBoxTiles;
    else sandbox.boundingBoxTiles = previousBoundingBoxTiles;
  }
}

{
  const { nukeTarget, behavior, player } = makeSalvoWorld();
  const invasionTarget = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  const request = { need: 4, targetSamId: "other-rival-sam", targetTile: 20 };
  sandbox.state.nukeWantSlots = request;
  const previousDifficulty = sandbox.currentDifficulty;
  const previousWinFixes = sandbox.state.settings.winFixes;
  sandbox.currentDifficulty = () => "Legendary";
  sandbox.state.settings.winFixes = true;
  behavior.attackBehavior.findIncomingAttackPlayer = () => invasionTarget;
  behavior.isUnderHeavyAttack = () => true;
  behavior.isEligibleNukeTarget = () => true;
  behavior.samDemandStrikeTarget = () => nukeTarget;
  behavior.hasPendingNukeLaunches = () => false;
  behavior.freezeGiantStrikeTarget = () => null;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 100n });
  let collectionCount = 0;
  player.gold = () => 100_099n;
  behavior.collectNukeCandidates = async (target) => {
    assert.strictEqual(target, invasionTarget);
    collectionCount++;
    return [{ tile: 30, value: 1 }];
  };
  behavior.partitionCandidatesBySamCoverage = () => ({
    clear: [{ tile: 30, value: 1 }],
    covered: [],
    routeBlockedTile: null,
  });
  behavior.selectBuildableNukeCandidate = async (candidates) => candidates[0];
  let firedTarget = null;
  behavior.sendNuke = async (_tile, _type, target) => {
    firedTarget = target;
    return true;
  };
  behavior.maybeDestroyEnemySam = async () => false;
  try {
    await behavior.maybeFreezeGiantStrike([], "Legendary");
    assert.strictEqual(
      firedTarget,
      null,
      "cost plus 99,999 gold does not pass the survival buffer",
    );
    assert.equal(collectionCount, 0, "the below-buffer check exits before collecting targets");
    player.gold = () => 100_100n;
    await behavior.maybeFreezeGiantStrike([], "Legendary");
    assert.strictEqual(
      firedTarget,
      invasionTarget,
      "active invasion survival outranks a pending SAM demand against another rival",
    );
    assert.equal(collectionCount, 1, "cost plus the 100,000 gold buffer reaches target collection");
    assert.strictEqual(
      sandbox.state.nukeWantSlots,
      request,
      "the survival strike leaves the unrelated SAM demand intact",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    sandbox.state.settings.winFixes = previousWinFixes;
    sandbox.state.nukeWantSlots = null;
  }
}

{
  const { game, nukeTarget, behavior, world, player } = makeSalvoWorld();
  player.units = () => [];
  const pinnedSam = world.sam("freeze-same-target-sam", 1);
  nukeTarget.units = (type) => (type === UNIT.SAMLauncher ? [pinnedSam] : []);
  game.players = () => [nukeTarget];
  const request = {
    need: 4,
    targetSamId: pinnedSam.id(),
    targetTile: 20,
    unblockedSiloIds: [],
  };
  sandbox.state.nukeWantSlots = request;
  behavior.freezeGiantStrikeTarget = () => nukeTarget;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.collectNukeCandidates = async () => [];
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [] });
  behavior.selectBuildableNukeCandidate = async () => null;
  const samCleanupTargets = [];
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  behavior.maybeDestroyEnemySam = async (target) => {
    samCleanupTargets.push(target);
    return maybeDestroyEnemySam(target);
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.deepEqual(
    samCleanupTargets,
    [nukeTarget],
    "a freeze strike may service a SAM demand pinned to its own target",
  );
  sandbox.state.nukeWantSlots = null;
}

{
  const { nukeTarget, behavior, player } = makeSalvoWorld();
  player.units = () => [];
  sandbox.state.nukeWantSlots = null;
  behavior.freezeGiantStrikeTarget = () => nukeTarget;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.collectNukeCandidates = async () => [];
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [] });
  behavior.selectBuildableNukeCandidate = async () => null;
  const samCleanupTargets = [];
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  behavior.maybeDestroyEnemySam = async (target) => {
    samCleanupTargets.push(target);
    return maybeDestroyEnemySam(target);
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.deepEqual(
    samCleanupTargets,
    [nukeTarget],
    "without a pinned SAM demand the freeze fallback still checks the selected giant",
  );
  sandbox.state.nukeWantSlots = null;
}

{
  const { nukeTarget, behavior, player } = makeSalvoWorld();
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  const silo = { isUnderConstruction: () => false };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  const previousDifficulty = sandbox.currentDifficulty;
  const previousHardGate = sandbox.isAtLeastHardDifficulty;
  sandbox.currentDifficulty = () => "Easy";
  sandbox.isAtLeastHardDifficulty = () => false;
  behavior.canConsiderNukes = () => true;
  behavior.findBestNukeTarget = () => nukeTarget;
  behavior.isValidNukeTarget = () => true;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.collectCandidatesWithRetry = async () => ({
    list: [{ tile: 30, value: 100 }],
    retargeted: null,
  });
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [{ tile: 30, value: 100 }] });
  behavior.selectBuildableNukeCandidate = async () => ({ tile: 30, value: 100 });
  behavior.nukeHasPositiveExpectedValue = async () => true;
  behavior.sendNuke = async () => true;
  behavior.maybeDestroyEnemySam = async () => false;
  behavior.maybeFirePostSalvoHydrogen = async () => false;
  let freezeCalls = 0;
  behavior.maybeFreezeGiantStrike = async () => {
    freezeCalls += 1;
  };
  try {
    await behavior.maybeSendNuke();
    assert.equal(
      freezeCalls,
      0,
      "the freeze lane is skipped after the ordinary lane successfully fires",
    );
    behavior.selectBuildableNukeCandidate = async () => null;
    await behavior.maybeSendNuke();
    assert.equal(
      freezeCalls,
      1,
      "the freeze lane remains available when the ordinary lane has no shot",
    );
