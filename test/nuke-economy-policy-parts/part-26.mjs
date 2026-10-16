// A live launch trajectory identifies the exact hostile Silo to counterstrike;
// a decoy Silo must not release the held shot or outrank ordinary value.
{
  const launchSilo = {
    id: () => 11,
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => 100,
    isActive: () => true,
  };
  const decoySilo = {
    id: () => 12,
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => 200,
    isActive: () => true,
  };
  let launchSiloIsLive = true;
  const sourceOwner = {
    isPlayer: () => true,
    smallID: () => 3,
    id: () => 3,
    units: (type) =>
      type === UNIT.MissileSilo ? [...(launchSiloIsLive ? [launchSilo] : []), decoySilo] : [],
  };
  const wrappedMissile = wrappedGame._wrapUnit({
    owner: () => sourceOwner,
    targetTile: () => 20,
    type: () => UNIT.AtomBomb,
    nukeState: () => ({ trajectory: [{ tile: 100 }, { tile: 20 }] }),
  });
  assert.equal(
    wrappedMissile.trajectory()[0]?.tile,
    100,
    "the game API wrapper forwards the UnitView nuke trajectory",
  );
  assert.equal(
    wrappedGame._wrapUnit({ trajectory: () => [{ tile: 101 }] }).trajectory()[0]?.tile,
    101,
    "the game API wrapper preserves the core Unit trajectory",
  );

  const sourceTracker = Object.create(sandbox.__NukeBehavior.prototype);
  sourceTracker.player = observedSelf;
  sourceTracker.game = {
    ticks: () => 9200,
    units: () => [wrappedMissile],
    owner: (tile) => (tile === 20 ? observedSelf : null),
    config: () => ({ nukeMagnitudes: () => ({ outer: 15 }) }),
    euclideanDistSquared: (from, to) => (from - to) ** 2,
  };
  sourceTracker.missileThreatensFriendlyTarget = () => true;
  sourceTracker._hostileNukeThreats = new Map();
  sourceTracker.observeHostileNukeThreats();
  const sourceThreat = sourceTracker._hostileNukeThreats.get(3);
  const wrappedOwner = wrappedMissile.owner();
  assert.ok(sourceThreat.sourceSiloIds.has("11"));
  assert.equal(
    sourceTracker.isCounterforceSiloTarget(100, UNIT.AtomBomb, wrappedOwner),
    true,
    "a blast covering the actual launch Silo is a valid counterforce shot",
  );
  assert.equal(
    sourceTracker.isCounterforceSiloTarget(200, UNIT.AtomBomb, wrappedOwner),
    false,
    "a blast covering only the attacker's decoy Silo cannot release the reserve",
  );
  launchSiloIsLive = false;
  assert.equal(
    sourceTracker.isCounterforceSiloTarget(200, UNIT.AtomBomb, wrappedOwner),
    false,
    "a decoy Silo is not promoted after the recorded launch Silo is destroyed",
  );
  const previousDifficulty = testDifficulty;
  testDifficulty = sandbox.Difficulty.Legendary;
  sourceTracker.game.players = () => [wrappedOwner];
  sourceTracker.player = { gold: () => 1n };
  sourceTracker.isUnderHeavyAttack = () => false;
  sourceTracker.isRetaliationNukeTarget = () => false;
  sourceTracker.getPerceivedNukeCost = async () => 750_000n;
  assert.equal(
    await sourceTracker.shouldHoldCounterforceNuke(500, UNIT.AtomBomb, wrappedOwner, 750_000n),
    false,
    "the counterforce reserve is released when every recorded launch Silo is gone",
  );
  testDifficulty = previousDifficulty;
  launchSiloIsLive = true;

  const priorityBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  priorityBehavior.game = {
    ...sourceTracker.game,
    ensureBorderTiles: async () => {},
  };
  priorityBehavior.random = {};
  priorityBehavior._hostileNukeThreats = sourceTracker._hostileNukeThreats;
  priorityBehavior.attackBehavior = { findIncomingAttackPlayer: () => null };
  priorityBehavior.isEligibleNukeTarget = () => true;
  const demandTarget = { smallID: () => 4 };
  const incomingAttacker = { smallID: () => 5 };
  assert.equal(
    priorityBehavior.priorityNukeTarget(demandTarget).target,
    wrappedOwner,
    "a live hostile-nuke source owner outranks an unrelated SAM-demand target",
  );
  priorityBehavior.attackBehavior.findIncomingAttackPlayer = () => incomingAttacker;
  const incomingPriority = priorityBehavior.priorityNukeTarget(demandTarget);
  assert.equal(
    incomingPriority.target,
    incomingAttacker,
    "an immediate troop attacker remains the selected target",
  );
  assert.equal(
    incomingPriority.incoming,
    true,
    "an immediate troop attacker still outranks counterforce retaliation",
  );
  priorityBehavior.attackBehavior.findIncomingAttackPlayer = () => null;
  launchSiloIsLive = false;
  assert.equal(
    priorityBehavior.priorityNukeTarget(demandTarget).target,
    demandTarget,
    "a destroyed recorded launch Silo no longer diverts target priority",
  );
  launchSiloIsLive = true;
  let counterforceRetargetAllowed;
  let counterforceFireTarget;
  priorityBehavior.player = { units: () => [] };
  priorityBehavior.hasPendingNukeLaunches = () => false;
  priorityBehavior.nukeLaneBlockedByCapacity = () => false;
  priorityBehavior.observeHostileNukeThreats = () => {};
  priorityBehavior.samDemandStrikeTarget = () => demandTarget;
  priorityBehavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  priorityBehavior.shouldDeferNukeForEconomy = () => false;
  priorityBehavior.collectCandidatesWithRetry = async (...args) => {
    counterforceRetargetAllowed = args[4];
    return { list: [{ tile: 100 }], retargeted: demandTarget };
  };
  priorityBehavior.fireNukeFromCandidates = async (_candidates, target) => {
    counterforceFireTarget = target;
    return true;
  };
  await priorityBehavior.maybeSendNuke();
  assert.equal(
    counterforceRetargetAllowed,
    false,
    "a counterforce target cannot be replaced during candidate retry",
  );
  assert.equal(
    counterforceFireTarget,
    wrappedOwner,
    "the launch-owner target survives SAM-demand selection through the firing call",
  );
  priorityBehavior.removeOldNukeEvents = () => {};
  priorityBehavior.isScorableNukeTile = () => 1;
  priorityBehavior.nukeTileScore = (tile) => (tile === 100 ? 10 : 1000);
  const previousRandomTiles = sandbox.randTerritoryTileArray;
  sandbox.randTerritoryTileArray = () => [];
  const candidates = await priorityBehavior.collectNukeCandidates(
    wrappedOwner,
    UNIT.AtomBomb,
    [],
    sandbox.Difficulty.Legendary,
  );
  sandbox.randTerritoryTileArray = previousRandomTiles;
  assert.equal(
    candidates[0]?.tile,
    100,
    "the observed launch Silo ranks before a higher-value decoy target",
  );
}

