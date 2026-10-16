      : [];
  const ordinaryTarget = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  game.players = () => [nukeTarget, ordinaryTarget];
  behavior.isValidNukeTarget = () => true;
  behavior.isValidNukeDestination = () => true;
  behavior.canConsiderNukes = () => true;
  behavior.findBestNukeTarget = () => ordinaryTarget;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.collectCandidatesWithRetry = async (target) => ({
    list: [{ tile: 40, value: 100 }],
    retargeted: target,
  });
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [{ tile: 40, value: 100 }] });
  const clearShotTargets = [];
  behavior.fireLegendaryClearFallthrough = async (_clear, target) => {
    clearShotTargets.push(target);
    return true;
  };
  const salvoTargets = [];
  behavior.maybeDestroyEnemySam = async (target) => {
    salvoTargets.push(target);
    return true;
  };
  behavior.rememberFailedSamTarget({
    targetSamId: requestedSam.id(),
    targetTile: 20,
    totalBombs: 2,
    coveringSamIds: new Set([requestedSam.id()]),
    siloEntries: [{ silo: { id: () => "silo-1" }, interceptable: false }],
  });
  behavior.structureBehavior = { samOverwhelmPlanStillMissing: () => false };
  // The structure phase closes its shared request once the salvo fits.
  sandbox.state.nukeWantSlots = null;
  await behavior.maybeSendNuke();
  assert.deepEqual(
    salvoTargets,
    [nukeTarget],
    "a capacity-ready SAM demand survives structure-phase closure and is serviced first",
  );
  assert.deepEqual(
    clearShotTargets,
    [],
    "a clear Legendary shot at another player cannot bypass a ready SAM salvo",
  );
  sandbox.currentDifficulty = previousDifficulty;
  sandbox.state.nukeWantSlots = null;
}

{
  const { game, player, behavior } = makeSalvoWorld();
  const tribe = {
    smallID: () => 2,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    type: () => sandbox.PlayerType.Bot,
  };
  const human = { ...tribe, smallID: () => 3, type: () => sandbox.PlayerType.Human };
  const nation = { ...tribe, smallID: () => 4, type: () => sandbox.PlayerType.Nation };
  assert.equal(behavior.isValidNukeTarget(tribe), true, "generic Bot ownership remains valid");
  assert.equal(behavior.isEligibleNukeTarget(tribe), false, "tribes are not nuclear recipients");
  assert.equal(behavior.isEligibleNukeTarget(human), true, "human targets remain eligible");
  assert.equal(behavior.isEligibleNukeTarget(nation), true, "nation targets remain eligible");
  const tribeSam = {
    id: () => "tribe-sam",
    isAlive: () => true,
    owner: () => tribe,
  };
  tribe.units = (type) => (type === UNIT.SAMLauncher ? [tribeSam] : []);
  assert.equal(
    behavior.samDemandOwner(tribe, "tribe-sam").owner,
    undefined,
    "a Bot-owned SAM does not create a Silo-capacity demand for an illegal recipient",
  );
  game.owner = () => tribe;
  assert.equal(
    behavior.isValidNukeDestination(20, false),
    true,
    "tribe-owned territory remains a valid destination when the recipient is different",
  );

  const relations = [
    { relation: sandbox.Relation.Hostile, player: tribe },
    { relation: sandbox.Relation.Hostile, player: human },
    { relation: sandbox.Relation.Hostile, player: nation },
  ];
  player.allRelationsSorted = () => relations;
  assert.equal(
    behavior.findHostileNukeTarget(true),
    human,
    "production hostile selection skips an illegal Bot recipient and continues to a Human",
  );
  behavior.findDominantCrownNukeTarget = () => null;
  behavior.findAllyNukeTarget = () => null;
  behavior.findFFACrownTarget = () => null;
  behavior.findStrongestTeamTarget = () => null;
  behavior.findLegendaryStructureTarget = () => null;
  assert.equal(
    behavior.findNukeRelationTarget(sandbox.Difficulty.Hard),
    human,
    "the production target ladder continues after an illegal Bot hostile",
  );

  game.players = () => [player, tribe, human, nation];
  tribe.units = () => [{ value: 100 }];
  human.units = () => [{ value: 50 }];
  nation.units = () => [{ value: 75 }];
  behavior.nukeStructureValue = (structure) => structure.value;
  assert.equal(
    behavior.findHighestValueNukeTarget(null),
    nation,
    "highest-value selection skips a richer Bot recipient and continues to a Nation",
  );

  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Hard";
  game.players = () => [player, tribe];
  try {
    assert.equal(behavior.findBestNukeTarget(), null, "the selector never returns a Bot tribe");
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

{
  const { game, player, behavior } = makeSalvoWorld();
  const target = {
    smallID: () => 2,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    type: () => sandbox.PlayerType.Human,
  };
  game.owner = () => target;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Easy";
  behavior.nukeLaunchRouteViable = () => true;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  let policyChecks = 0;
  behavior.attackBehavior.shouldAttack = () => ++policyChecks === 1;
  player.buildables = async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  launches.length = 0;
  launchSink = launches;
  try {
    assert.equal(
      behavior.isEligibleNukeTarget(target),
      true,
      "target selection accepts its one policy result",
    );
    assert.equal(await behavior.sendNuke(20, UNIT.AtomBomb, target), true);
    assert.equal(policyChecks, 1, "launch revalidation does not reroll Easy attack policy");
    assert.equal(launches.length, 1);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Human;
  game.owner = () => nukeTarget;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Easy";
  behavior.nukeLaunchRouteViable = () => true;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    nukeTarget.type = () => sandbox.PlayerType.Bot;
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  launches.length = 0;
  launchSink = launches;
  try {
    assert.equal(await behavior.sendNuke(20, UNIT.AtomBomb, nukeTarget), false);
    assert.equal(launches.length, 0, "a target that becomes a tribe during the probe is rejected");
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
