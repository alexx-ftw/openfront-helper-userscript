  assert.equal(admissions[0].payloadTroops, 30);
  assert.equal(sender.hybridSafetyAttempt, null);
  assert.equal(sender.attackAdmissionAttempt, undefined);
  sender.sendAuthorizedAttack = () => {
    sender.recordAttackEmission(30, "land");
    return true;
  };
  sandbox.window.__OFH_attackAdmission = () => {
    throw new Error("write failure fixture");
  };
  await assert.rejects(sender.sendAttack({ smallID: () => 2 }), /write failure fixture/);
  assert.equal(safety.length, 2, "safety published even if diagnostic writing fails");
  assert.equal(sender.hybridSafetyAttempt, null);
  assert.equal(sender.attackAdmissionAttempt, undefined);
  const originalFailure = new Error("original dispatch failure");
  sender.sendAuthorizedAttack = () => {
    throw originalFailure;
  };
  await assert.rejects(
    sender.sendAttack({ smallID: () => 2 }),
    (error) => error === originalFailure,
  );
  sender.sendForcedAttack = () => {
    throw originalFailure;
  };
  await assert.rejects(
    sender.forceSendAttack({ smallID: () => 2 }),
    (error) => error === originalFailure,
  );
  sender.game = {};
  sender.emitAuthorizedBoat = () => {
    throw originalFailure;
  };
  assert.throws(
    () => sender.emitBoat(7, 30, "boat fixture"),
    (error) => error === originalFailure,
  );
  delete sandbox.window.__OFH_attackAdmission;
  delete sandbox.window.__OFH_hybridSafety;
}
for (const collectorControl of [false, true]) {
  const fixture = createAttackBehaviorSandbox();
  fixture.window = {};
  const rows = [];
  fixture.roundLogRecord = (_kind, row) => rows.push(row);
  const policy = executeClassicScript(
    readRepositoryFile("engine/ingame/auto-bot/hybridModelContract.js") +
      "\n" +
      readRepositoryFile("engine/ingame/auto-bot/hybridCombat.js") +
      "\nhybridCombatPolicy",
    fixture,
  );
  policy.configure({ mode: "shadow", learning: true, collectionPolicy: "coverage-wait-v1" });
  const sender = Object.create(fixture.AttackBehavior.prototype);
  const enemy = { smallID: () => 2, id: () => "enemy", isPlayer: () => true };
  sender.player = { smallID: () => 1 };
  sender.game = { owner: () => enemy };
  sender.currentAttackDecisionTick = () => 10;
  sender.captureSameClanNukeTerrain = () => {};
  sender.reconcileOutboundAttackIntentCommitments = () => {};
  sender.getForceAttackTroops = () => 30;
  sender.canEmitBoatToDestination = () => true;
  sender.boatLaunchWarshipDanger = () => false;
  sender.boatDestinationReserved = () => false;
  sender.resolveBoatTroops = (troops) => troops;
  sender.recordOutboundAttackIntent = () => {};
  sender.recordBoatDestinationIntent = () => {};
  let constructorAvailable = true;
  let rateCapacity = true;
  fixture.discoverCtors = () => ({
    attack: constructorAvailable ? () => {} : null,
    boat: () => {},
  });
  fixture.getEventBus = () => ({});
  fixture.hasAttackIntentRateCapacity = () => rateCapacity;
  let emitted = false;
  fixture.emitIntent = () => emitted;
  fixture.setLastAction = () => {};
  fixture.tr = (value) => value;
  const wait = () => {
    policy.pending = {
      target: null,
      tick: 10,
      gate: [1, 0.5, 0.2, 0],
      share: 0.2,
      episodeId: policy.episodeId,
      generation: policy.generation,
      actorSmallID: 1,
      decisionStep: 0,
      decisionSequence: 0,
      modelIdentity: JSON.stringify(policy.exportModel()),
      controlledAction: "wait",
      collectorControl,
      learned: !collectorControl,
      behaviorPolicy: collectorControl
        ? "coverage-driven-safe-wait-collection-v1"
        : "deterministic-wait-act-ranked-target",
    };
    return policy.pending;
  };
  const modelBefore = JSON.stringify(policy.exportModel());
  const original = wait();
  assert.equal(await sender.forceSendAttack(enemy), false);
  assert.equal(
    policy.pending,
    original,
    "rejected forced emission preserves real WAIT observation",
  );
  emitted = true;
  constructorAvailable = false;
  assert.equal(await sender.forceSendAttack(enemy), false);
  assert.equal(policy.pending, original, "missing constructor must not censor WAIT");
  constructorAvailable = true;
  rateCapacity = false;
  assert.equal(await sender.forceSendAttack(enemy), false);
  assert.equal(policy.pending, original, "rate rejection must not censor WAIT");
  rateCapacity = true;
  assert.equal(rows.filter((row) => row.phase === "emission").length, 0);
  assert.equal(await sender.forceSendAttack(enemy), true);
  assert.equal(policy.pending, null, "actual forced emission cancels collector WAIT");
  wait();
  assert.equal(sender.emitBoat(7, 30, "boat fixture"), true);
  assert.equal(policy.pending, null, "actual boat emission cancels collector WAIT");
  const failure = new Error("post-emission bookkeeping");
  sender.recordOutboundAttackIntent = () => {
    throw failure;
  };
  wait();
  await assert.rejects(sender.forceSendAttack(enemy), (error) => error === failure);
  assert.equal(policy.pending, null, "emitted-then-throw cannot survive as WAIT");
  const outcomes = rows.filter((row) => row.kind === "hybrid-combat-outcome");
  assert.equal(outcomes.length, 3);
  for (const outcome of outcomes) {
    assert.equal(outcome.collectorControl === true, collectorControl);
    assert.equal(outcome.reward, null);
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.reason, "competing-attack-emission");
    assert.equal(
      outcome.behaviorPolicy,
      collectorControl
        ? "coverage-driven-safe-wait-collection-v1"
        : "deterministic-wait-act-ranked-target",
    );
    assert.ok(Number.isSafeInteger(outcome.emissionSequence));
  }
  assert.equal(
    JSON.stringify(policy.exportModel()),
    modelBefore,
    "cancellations never update weights/counts",
  );
  assert.equal(policy.collection.completedWaits, 0);
}
process.stdout.write("hybrid runtime caller tests passed\n");
