  let currentTick = 10;
  let acceptedEmitter = false;
  let emissions = 0;
  const feeds = new Map();
  const ownAttacks = [];
  const actor = (sid) => ({
    smallID: () => sid,
    id: () => `p${sid}`,
    isPlayer: () => true,
    type: () => "HUMAN",
    isAlive: () => true,
    isFriendly: (peer) => peer.smallID() !== 3,
    sharesBorderWith: () => true,
    canAttackPlayer: () => true,
    troops: () => 1000,
    units: () => [],
    outgoingEmojis: () => feeds.get(sid) ?? [],
    outgoingAttacks: () => (sid === 1 ? [anchor] : ownAttacks),
  });
  const leader = actor(1);
  const me = actor(2);
  const enemy = actor(3);
  const anchor = {
    id: () => "leader-anchor",
    attacker: () => leader,
    target: () => enemy,
    retreating: () => false,
  };
  const world = {
    ticks: () => currentTick,
    players: () => [leader, me, enemy],
    config: () => ({ emojiMessageDuration: () => 50 }),
  };
  const strategy = realm.window.__OFH_hybridStrategy;
  strategy.configure({ enabled: true });
  strategy.observeDuo({ game: world, player: me });
  feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 10 }]);
  strategy.observeDuo({ game: world, player: me });
  currentTick++;
  feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 11 }]);
  realm.companionJointPlan = (nativeGame, player) =>
    strategy.getJointPlan({ game: nativeGame, player }, 1);
  realm.discoverCtors = () => ({ attack: class Attack {} });
  realm.getEventBus = () => ({});
  realm.hasAttackIntentRateCapacity = () => true;
  realm.emitIntent = () => {
    if (acceptedEmitter) emissions++;
    return acceptedEmitter;
  };
  realm.setLastAction = () => {};
  realm.tr = (value) => value;
  const behavior = Object.create(realm.AttackBehavior.prototype);
  Object.assign(behavior, {
    game: world,
    player: me,
    botAttackPendingIntentCommitments: [],
    incomingHostileAttackPressure: () => 0,
    shouldAttack: () => true,
    sendAttackTargetIsAuthorized: () => true,
    captureSameClanNukeTerrain: () => {},
    createLandAttackContext: (target) => ({
      target,
      finalSpendableTroops: 1000,
      force: false,
      requiredTribeAttackTroops: null,
    }),
    calculateLandAttackTroops: () => 100,
    adjustLandAttackTroops: (_context, value) => value,
    landAttackTroopsAreSafe: () => true,
  });
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "failed emitter does not consume consent",
  );
  assert.ok(strategy.getJointPlan({ game: world, player: me }, 1));
  acceptedEmitter = true;
  assert.equal(await behavior.tryHybridJointAttack(), true);
  assert.equal(await behavior.tryHybridJointAttack(), false);
  ownAttacks.push({
    id: () => "own-receipt",
    target: () => enemy,
    troops: () => 100,
    retreating: () => false,
  });
  currentTick++;
  behavior.reconcileOutboundAttackIntentCommitments();
  assert.equal(behavior.botAttackPendingIntentCommitments.length, 0);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "same consumed REQUEST/ACK stays blocked after own receipt",
  );
  assert.equal(emissions, 1);
  currentTick++;
  feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 13 }]);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "new request still needs its own native ACK",
  );
  currentTick++;
  feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 14 }]);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    true,
    "legitimate newer exchange remains dispatchable",
  );
  assert.equal(emissions, 2);
}

{
  const funding = Object.create(sandbox.AttackBehavior.prototype);
  let available = 39;
  let multiplier = 1;
  let appetite = false;
  let emissions = 0;
  let defenderTroops = 20;
  const defender = { isPlayer: () => true, troops: () => defenderTroops };
  Object.assign(funding, {
    player: { troops: () => 100 },
    botAttackTroopsSent: 7,
    hybridSafetyAttempt: null,
    createLandAttackContext: () => ({
      target: defender,
      targetTroops: 100 - available,
      targetSpendableTroops: available,
      finalSpendableTroops: available,
      defenseProfile: { attackCostMultiplier: multiplier },
      isTribeTarget: false,
      force: false,
      attackBlocked: false,
      requiredTribeAttackTroops: null,
      reinforcementPlan: null,
    }),
    getLiveOutboundAttackTroopsForTarget: () => 0,
    proactiveWarExceedsAppetite: () => appetite,
    proactiveWarPrefersBlitz: () => false,
    attackIsTooWeakForDefensePosts: () => false,
    captureSameClanNukeTerrain: () => {},
    reconcileOutboundAttackIntentCommitments: () => {},
    emitLandAttackIntent: () => {
      emissions++;
      return true;
    },
  });
  assert.equal(funding.canFundLandAttack(defender), false, "below native capture floor");
  assert.equal(funding.inspectLandAttackFunding(defender).reason, "capture-reserve-insufficient");
  available = 40;
  assert.equal(funding.canFundLandAttack(defender), true, "exact floor remains eligible");
  multiplier = 2;
  assert.equal(funding.canFundLandAttack(defender), false, "Defense Post floor retained");
  available = 80;
  assert.equal(funding.canFundLandAttack(defender), true);
  appetite = true;
  assert.equal(funding.canFundLandAttack(defender), false, "war appetite retained");
  assert.equal(funding.inspectLandAttackFunding(defender).reason, "war-appetite-exceeded");
  appetite = false;
  multiplier = 1;
  defenderTroops = 0;
  assert.equal(funding.canFundLandAttack(defender), true, "undefended target retained");
  assert.equal(funding.botAttackTroopsSent, 7, "preflight never reserves ordinary attack troops");
  assert.equal(funding.hybridSafetyAttempt, null, "preflight creates no safety attempt");
  assert.equal(emissions, 0, "preflight emits nothing");
  defenderTroops = 20;
  available = 39;
  assert.equal(funding.sendLandAttack(defender), false, "sender rechecks changed budget");
  assert.equal(emissions, 0);
  defenderTroops = 0;
  available = 0;
  funding.hybridSafetyAttempt = {};
  assert.equal(funding.sendLandAttack(defender), false);
  assert.equal(funding.hybridSafetyAttempt.reason, "no-spendable-troops");
  assert.equal(funding.landAttackPayloadRejection(Number.POSITIVE_INFINITY), "nonfinite-payload");
  assert.equal(
    funding.landAttackTroopsAreSafe({ requiredTribeAttackTroops: null }, Number.POSITIVE_INFINITY),
    false,
  );
}

{
  const ledger = Object.create(sandbox.AttackBehavior.prototype);
  const recipient = { isPlayer: () => true, smallID: () => 2 };
  let receipts = [
    { id: "receipt-1", attack: {}, targetIsPlayer: true, targetKey: "2", troops: 40 },
  ];
  Object.assign(ledger, {
    player: { troops: () => 100 },
    currentAttackDecisionTick: () => 10,
    getOutboundAttackSnapshot: () => receipts,
