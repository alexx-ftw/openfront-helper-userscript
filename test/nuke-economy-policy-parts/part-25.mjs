// Idle-lane realism: with every tube cooling, maybeSendNuke must skip the
// full target ladder and candidate sweep instead of probing into a refusal.
{
  const idleBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  idleBehavior.player = { gold: () => 10_000_000n, units: () => [] };
  idleBehavior.hasPendingNukeLaunches = () => false;
  idleBehavior.canConsiderNukes = () => true;
  idleBehavior.findBestNukeTarget = () => {
    throw new Error("target ladder must not run with zero ready silo slots");
  };
  const emptyTubeBehavior = Object.create(idleBehavior);
  emptyTubeBehavior.readySiloShotCapacity = () => 0;
  await emptyTubeBehavior.maybeSendNuke();
  assert.equal(
    emptyTubeBehavior.decisionTelemetry.tubesEmpty,
    1,
    "an all-tubes-cooling decision records tubesEmpty and skips the ladder",
  );
  assert.equal(
    emptyTubeBehavior.decisionTelemetry.runs,
    1,
    "the idle decision still counts as a run for the durable harness counters",
  );
  const readyBehavior = Object.create(idleBehavior);
  readyBehavior.readySiloShotCapacity = () => 2;
  await assert.rejects(
    () => readyBehavior.maybeSendNuke(),
    /target ladder must not run/,
    "ready tubes still reach the target ladder",
  );

  const demandObserved = [];
  const demandTarget = { smallID: () => 45 };
  const samDemandBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  samDemandBehavior.player = { gold: () => 10_000_000n, units: () => [] };
  samDemandBehavior.hasPendingNukeLaunches = () => false;
  samDemandBehavior.nukeLaneBlockedByCapacity = () => false;
  samDemandBehavior.samDemandStrikeTarget = () => demandTarget;
  samDemandBehavior.priorityNukeTarget = () => ({ target: demandTarget, incoming: false });
  samDemandBehavior.observeHostileNukeThreats = () => demandObserved.push("observe");
  samDemandBehavior.isEligibleNukeTarget = () => true;
  samDemandBehavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  samDemandBehavior.shouldDeferNukeForEconomy = () => false;
  samDemandBehavior.collectCandidatesWithRetry = async () => {
    demandObserved.push("rank");
    return { list: [{ tile: 10 }], retargeted: null };
  };
  samDemandBehavior.fireNukeFromCandidates = async () => true;
  await samDemandBehavior.maybeSendNuke();
  assert.deepEqual(
    demandObserved,
    ["observe", "rank"],
    "hostile missiles are observed before ranking even when an active SAM demand is the priority",
  );
}

