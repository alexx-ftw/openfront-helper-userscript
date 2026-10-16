// A post-salvo Hydrogen finisher must pass the same hard friendly-land veto
// as every other launch, even when enemy structure value covers replacement.
{
  const finisher = Object.create(sandbox.__NukeBehavior.prototype);
  const pending = { targetSmallID: 9, targetTile: 100, dueTick: 1, salvoId: 900 };
  const enemy = { smallID: () => 9 };
  let emitted = 0;
  finisher._pendingNukeLaunches = [];
  sandbox.state.postSalvoHydrogen = pending;
  finisher.game = {
    ticks: () => 10,
    config: () => ({ isUnitDisabled: () => false }),
  };
  finisher.player = {
    gold: () => 1_000_000n,
    units: (type) => (type === UNIT.MissileSilo ? [{ isUnderConstruction: () => false }] : []),
  };
  finisher.postSalvoHydrogenTarget = () => enemy;
  finisher.extendFinisherForLiveAtoms = () => 0;
  finisher.getPerceivedNukeCost = async () => 1n;
  finisher.findEnemySamsCoveringTile = () => [];
  finisher.postSalvoHydrogenHasValue = () => true;
  finisher.observeHostileNukeThreats = () => {};
  finisher.isEligibleNukeTarget = () => true;
  finisher.isValidNukeDestination = () => true;
  finisher.probeNukeBuildable = async () => ({ cost: 1n });
  finisher.nukeBuildableCanLaunch = () => true;
  finisher.shouldHoldCounterforceNuke = async () => false;
  finisher.blastHitsFriendlyLand = () => true;
  finisher.nukeLaunchRouteViable = () => true;
  finisher.emitNukeWithSalvoFlight = () => {
    emitted++;
    return true;
  };
  finisher.rememberSuccessfulNukeLaunch = async () => {};

  assert.equal(await finisher.maybeFirePostSalvoHydrogen(), false);
  assert.equal(emitted, 0, "no Hydrogen launch is emitted into friendly land");
  assert.equal(
    sandbox.state.postSalvoHydrogen,
    pending,
    "the finisher remains pending so it can retry after friendly land is clear",
  );
}

process.stdout.write("nuke economy policy tests passed\n");
