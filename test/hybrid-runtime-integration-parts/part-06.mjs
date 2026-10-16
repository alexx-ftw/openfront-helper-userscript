    getOutboundTransportSnapshot: () => [],
    botAttackPendingIntentCommitments: [0, 1].map(() => ({
      target: recipient,
      targetIsPlayer: true,
      targetKey: "2",
      attackType: "land",
      troops: 40,
      createdTick: 10,
      baselineTroops: 100,
      baselineTargetTroops: 0,
      baselineAttackIDs: new Set(),
      baselineTransportIDs: new Set(),
    })),
  });
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(ledger.botAttackPendingIntentCommitments.length, 1);
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(
    ledger.botAttackPendingIntentCommitments.length,
    1,
    "one receipt cannot release two pending debits",
  );
  receipts = [...receipts, { ...receipts[0], id: "receipt-2", attack: {} }];
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(
    ledger.botAttackPendingIntentCommitments.length,
    0,
    "distinct receipt still releases the second debit",
  );
  for (const { forced, freeLand, withReceipt, ownTroops } of [
    { forced: true, freeLand: false, withReceipt: true, ownTroops: 60 },
    { forced: false, freeLand: true, withReceipt: false, ownTroops: 60 },
    { forced: true, freeLand: false, withReceipt: false, ownTroops: 80 },
  ]) {
    ledger.botAcknowledgedOutboundIntents = [];
    ledger.player.troops = () => ownTroops;
    receipts = withReceipt
      ? [{ id: "only-receipt", attack: {}, targetIsPlayer: true, targetKey: "2", troops: 40 }]
      : [];
    ledger.botAttackPendingIntentCommitments = [0, 1].map(() => ({
      target: recipient,
      targetIsPlayer: !freeLand,
      targetKey: "2",
      attackType: "land",
      forcedCounterattack: forced,
      troops: 40,
      createdTick: 10,
      baselineTroops: 100,
      baselineTargetTroops: 0,
      baselineAttackIDs: new Set(),
      baselineTransportIDs: new Set(),
    }));
    ledger.reconcileOutboundAttackIntentCommitments(10, true);
    assert.equal(
      ledger.botAttackPendingIntentCommitments.length,
      1,
      "receipt and debit are the same evidence",
    );
    ledger.reconcileOutboundAttackIntentCommitments(10, true);
    assert.equal(
      ledger.botAttackPendingIntentCommitments.length,
      1,
      "snapshot debit cannot be reused across reads",
    );
  }
  let transports = [{ id: "ship-1", unit: {}, targetTile: 8, troops: 40 }];
  ledger.botAcknowledgedOutboundIntents = [];
  receipts = [];
  ledger.getOutboundTransportSnapshot = () => transports;
  ledger.botAttackPendingIntentCommitments = [0, 1].map(() => ({
    target: recipient,
    targetIsPlayer: true,
    targetKey: "2",
    attackType: "boat",
    destination: 8,
    troops: 40,
    createdTick: 10,
    baselineTroops: 100,
    baselineTargetTroops: 0,
    baselineDestinationTroops: 0,
    baselineAttackIDs: new Set(),
    baselineTransportIDs: new Set(),
  }));
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(ledger.botAttackPendingIntentCommitments.length, 1, "one ship is one receipt");
  transports = [...transports, { ...transports[0], id: "ship-2", unit: {} }];
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(ledger.botAttackPendingIntentCommitments.length, 0);
  for (const receiptFirst of [true, false]) {
    let home = receiptFirst ? 100 : 60;
    ledger.player.troops = () => home;
    ledger.getOutboundTransportSnapshot = () => [];
    ledger.botAcknowledgedOutboundIntents = [];
    receipts = receiptFirst
      ? [{ id: "delayed-receipt", attack: {}, targetIsPlayer: true, targetKey: "2", troops: 40 }]
      : [];
    ledger.botAttackPendingIntentCommitments = [0, 1].map(() => ({
      target: recipient,
      targetIsPlayer: true,
      targetKey: "2",
      attackType: "land",
      forcedCounterattack: true,
      troops: 40,
      createdTick: 10,
      baselineTroops: 100,
      baselineTargetTroops: 0,
      baselineAttackIDs: new Set(),
      baselineTransportIDs: new Set(),
    }));
    ledger.reconcileOutboundAttackIntentCommitments(10, true);
    assert.equal(ledger.botAttackPendingIntentCommitments.length, 1);
    home = 60;
    receipts = [
      { id: "delayed-receipt", attack: {}, targetIsPlayer: true, targetKey: "2", troops: 40 },
    ];
    ledger.reconcileOutboundAttackIntentCommitments(10, true);
    ledger.reconcileOutboundAttackIntentCommitments(10, true);
    assert.equal(
      ledger.botAttackPendingIntentCommitments.length,
      1,
      "staggered receipt/debit acknowledge the same intent",
    );
    receipts = [...receipts, { ...receipts[0], id: "genuine-second-receipt", attack: {} }];
    ledger.reconcileOutboundAttackIntentCommitments(10, true);
    assert.equal(ledger.botAttackPendingIntentCommitments.length, 0);
  }
  let partialHome = 90;
  ledger.player.troops = () => partialHome;
  ledger.botAcknowledgedOutboundIntents = [];
  receipts = [
    { id: "partial-first", attack: {}, targetIsPlayer: true, targetKey: "2", troops: 40 },
  ];
  ledger.botAttackPendingIntentCommitments = [40, 20].map((troops) => ({
    target: recipient,
    targetIsPlayer: true,
    targetKey: "2",
    attackType: "land",
    forcedCounterattack: true,
    troops,
    createdTick: 10,
    baselineTroops: 100,
    baselineTargetTroops: 0,
    baselineAttackIDs: new Set(),
    baselineTransportIDs: new Set(),
  }));
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(
    ledger.botAttackPendingIntentCommitments.length,
    1,
    "partial first debit cannot confirm the second intent",
  );
  partialHome = 60;
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(ledger.botAttackPendingIntentCommitments.length, 1);
  partialHome = 40;
  ledger.reconcileOutboundAttackIntentCommitments(10, true);
  assert.equal(
    ledger.botAttackPendingIntentCommitments.length,
    0,
    "later genuine second debit remains usable",
  );
  ledger.reconcileOutboundAttackIntentCommitments(16, true);
  assert.equal(
    ledger.botAcknowledgedOutboundIntents.length,
    0,
    "empty pending ledger still expires acknowledged metadata",
  );
}

{
  const sender = Object.create(sandbox.AttackBehavior.prototype);
  sender.player = { smallID: () => 1 };
  sender.currentAttackDecisionTick = () => 10;
  sender.beginHybridSafetyAttempt = () => {
    const attempt = { emitted: false };
    sender.hybridSafetyAttempt = attempt;
    return attempt;
  };
  const admissions = [],
    safety = [];
  sandbox.window.__OFH_attackAdmission = (row) => admissions.push({ ...row });
  sandbox.window.__OFH_hybridSafety = (row) => safety.push({ ...row });
  sender.sendAuthorizedAttack = () => {
    sender.recordAttackEmission(30, "land");
    throw new Error("post-emission failure fixture");
  };
  await assert.rejects(sender.sendAttack({ smallID: () => 2 }), /post-emission failure fixture/);
  assert.equal(admissions[0].emitted, true, "actual emission remains visible after exception");
  assert.equal(admissions[0].reason, "dispatch-exception");
