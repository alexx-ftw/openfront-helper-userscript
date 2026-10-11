import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
// Only repository classic scripts run in isolated fixture realms.
/* eslint-disable sonarjs/code-eval */

const rows = [];
const sandbox = {
  window: {},
  state: { settings: { winFixes: true } },
  PlayerType: { Bot: "BOT", Nation: "NATION" },
  roundLogRecord: (_kind, row) => rows.push(row),
  performance: { now: () => 0 },
};
vm.createContext(sandbox);
for (const name of ["hybridModelContract", "hybridCombat"])
  vm.runInContext(
    fs.readFileSync(new URL(`../engine/ingame/auto-bot/${name}.js`, import.meta.url), "utf8"),
    sandbox,
  );
const Policy = vm.runInContext("HybridCombatPolicy", sandbox);
const target = (sid, type = "NATION") => ({
  smallID: () => sid,
  type: () => type,
  isPlayer: () => true,
  isAlive: () => true,
  troops: () => 20,
  numTilesOwned: () => 10,
});
const a = target(2),
  b = target(3),
  tribe = target(4, "BOT");
let tick = 10,
  attacks = [],
  sends = 0;
const behavior = {
  player: {
    smallID: () => 1,
    troops: () => 100,
    numTilesOwned: () => 20,
    sharesBorderWith: () => true,
    isFriendly: () => false,
  },
  game: { config: () => ({ maxTroops: () => 200 }), numLandTiles: () => 100 },
  currentAttackDecisionTick: () => tick,
  incomingHostileAttackPressure: () => 0,
  getEarlyGameLiveReserveTroops: () => 50,
  getPlayerAttackPreferredTroopFloor: () => 20,
  getOutboundAttackSnapshot: () => attacks,
  getOutboundTransportSnapshot: () => [],
  getOutboundAttackTargetKey: (enemy) => String(enemy.smallID()),
  canAttackPlayerNow: (enemy) => enemy.smallID() !== 3,
  canFundLandAttack: () => true,
  sendAttack: async () => {
    sends++;
    return false;
  },
};
function ready(policy) {
  const model = policy.exportModel();
  for (const head of Object.values(model.models)) head.samples = head.weights.length;
  model.models.act.weights[0] = 1;
  policy.importModel(model);
  policy.configure({ mode: "learned", learning: false });
}
const p = new Policy({ storage: null });
assert.equal(p.diagnostics().readiness.target.sampleDeficit, 9);
ready(p);
assert.equal(await p.decide(behavior, [a, b, tribe]), false);
assert.equal(p.diagnostics().funnel.suppliedTargets, 3);
assert.equal(p.diagnostics().funnel.nativeEligibleTargets, 1);
assert.equal(p.diagnostics().funnel.featureValidTargets, 1);
assert.equal(p.diagnostics().funnel.scoredTargets, 1);
assert.equal(p.diagnostics().funnel.dispatchAttempts, 1);
assert.equal(p.exportLedger().entries.at(-1).reason, "send-rejected-unknown");
assert.equal(sends, 1);
await p.decide(behavior, []);
assert.equal(p.exportLedger().entries.at(-1).reason, "no-native-eligible-target");
assert.equal(p.exportLedger().entries.at(-1).actorSmallID, 1);
assert.equal(p.exportLedger().entries.at(-1).modelIdentity, JSON.stringify(p.exportModel()));
await p.decide({ ...behavior, player: { ...behavior.player, troops: () => NaN } }, [a]);
assert.equal(p.exportLedger().entries.at(-1).reason, "gate-features-unavailable");
assert.equal(p.exportLedger().entries.at(-1).actorSmallID, 1);
assert.equal(p.exportLedger().entries.at(-1).modelIdentity, JSON.stringify(p.exportModel()));
assert.equal(p.diagnostics().control.controlledWaits, 0);
const invalid = { ...behavior, getPlayerAttackPreferredTroopFloor: () => NaN };
await p.decide(invalid, [a]);
assert.equal(p.exportLedger().entries.at(-1).reason, "target-features-unavailable");
assert.equal(p.diagnostics().funnel.featureValidTargets, 1);
p.resetEpisode();
assert.equal(p.diagnostics().funnel.suppliedTargets, 0);
assert.equal(p.diagnostics().observations.calls, 0);
const unfunded = new Policy({ storage: null });
ready(unfunded);
const unfundedModel = JSON.stringify(unfunded.exportModel());
const sendsBeforeUnfunded = sends;
assert.equal(await unfunded.decide({ ...behavior, canFundLandAttack: () => false }, [a]), false);
assert.equal(unfunded.exportLedger().entries.at(-1).reason, "no-funded-native-target");
assert.equal(unfunded.diagnostics().funnel.nativeEligibleTargets, 1);
assert.equal(unfunded.diagnostics().funnel.fundedTargets, 0);
assert.equal(unfunded.diagnostics().funnel.scoredTargets, 0);
assert.equal(unfunded.pending, null, "unfundable choices do not start WAIT observations");
assert.equal(JSON.stringify(unfunded.exportModel()), unfundedModel);
assert.equal(sends, sendsBeforeUnfunded);

const compact = new Policy({ storage: null });
compact.importModel(compact.createCompactModel());
compact.configure({ mode: "learned", learning: false });
await compact.decide(behavior, [a]);
assert.equal(compact.exportLedger().entries.at(-1).reason, "target-features-unavailable");
assert.equal(compact.diagnostics().funnel.featureFailures["geometry-unavailable"], 1);
assert.equal(compact.diagnostics().readiness.target.sampleDeficit, 13);
assert.equal(compact.diagnostics().readiness.target.signalPresent, false);
assert.equal(compact.diagnostics().readiness.wait.sampleDeficit, 4);
const geometryBehavior = {
  ...behavior,
  hybridCombatGeometry: (enemy) => ({
    targetSmallID: enemy.smallID(),
    tick,
    source: "native-border-centroid-v1",
    own: { x: 0, y: 0 },
    target: { x: 5, y: 5 },
    width: 100,
    height: 100,
  }),
};
await compact.decide(geometryBehavior, [a]);
assert.equal(compact.exportLedger().entries.at(-1).reason, "model-not-ready");
assert.equal(compact.actionObservation(behavior, a), null);
assert.equal(compact.exportLedger().entries.at(-1).reason, "geometry-unavailable");
assert.equal(compact.actionObservation(behavior, tribe), null);
assert.equal(compact.actionObservation(behavior, a, { force: true }), null);
assert.equal(compact.diagnostics().observations.reasons["tribe-target"], 1);
assert.equal(compact.diagnostics().observations.reasons["forced-action"], 1);
assert.equal(compact.pending?.target ?? null, null);

const accepted = new Policy({ storage: null });
ready(accepted);
const callback = {
  ...behavior,
  sendAttack: async (enemy) => {
    const observation = accepted.actionObservation(callback, enemy);
    accepted.recordAcceptedAction(callback, enemy, observation, accepted.generation);
    accepted.recordAcceptedAction(callback, enemy, observation, accepted.generation);
    return true;
  },
};
await accepted.decide(callback, [a]);
assert.equal(accepted.diagnostics().funnel.acceptedDispatches, 1);
assert.equal(accepted.diagnostics().control.acceptedLearnedAttacks, 1);
const proposal = accepted.exportLedger().entries.find((row) => row.kind === "proposal");
const acceptance = accepted.exportLedger().entries.find((row) => row.kind === "accepted");
assert.equal(proposal.candidateCoverage.complete, true);
assert.equal(proposal.candidateCoverage.truncated, false);
assert.equal(proposal.candidates.length, 1);
assert.equal(proposal.candidates[0].targetSmallID, 2);
assert.equal(proposal.candidates[0].features.length, 9);
assert.equal(proposal.candidates[0].geometry, null, "ridge has no invented geometry");
assert.equal(proposal.behaviorProbability, null);
assert.equal(proposal.logProbability, null);
assert.equal(acceptance.decisionStep, proposal.step);
assert.equal(acceptance.decisionSequence, proposal.sequence);
assert.equal(acceptance.controlledAction, "attack");
assert.equal(acceptance.modelIdentity, proposal.modelIdentity);
assert.equal(acceptance.behaviorProbability, null);
assert.equal(accepted.diagnostics().observations.acceptanceOmissions["observation-pending"], 1);
attacks = [{ target: a, targetKey: "2", troops: 10, id: "receipt" }];
tick++;
accepted.observe(callback);
accepted.observe(callback);
assert.equal(accepted.diagnostics().funnel.confirmedDispatches, 1);
assert.equal(accepted.diagnostics().control.confirmedLearnedAttacks, 1);
const receipt = accepted.exportLedger().entries.find((row) => row.kind === "receipt");
assert.equal(receipt.decisionStep, proposal.step);
assert.equal(receipt.decisionSequence, proposal.sequence);
assert.equal(receipt.acceptedSequence, acceptance.sequence);
assert.equal(accepted.actionObservation(callback, a), null);
assert.equal(accepted.exportLedger().entries.at(-1).reason, "ambiguous-commitment");
attacks = [];
tick++;
accepted.observe(callback);
const outcome = accepted.exportLedger().entries.find((row) => row.kind === "outcome");
assert.equal(outcome.decisionStep, proposal.step);
assert.equal(outcome.decisionSequence, proposal.sequence);
assert.equal(outcome.controlledAction, "attack");
assert.equal(outcome.acceptedSequence, acceptance.sequence);
assert.equal(outcome.receiptID, "receipt");
assert.equal(outcome.modelIdentity, proposal.modelIdentity);
assert.equal(outcome.logProbability, null);
const staleObservation = accepted.actionObservation(callback, a);
accepted.resetEpisode();
accepted.recordAcceptedAction(callback, a, staleObservation, staleObservation.generation);
assert.equal(accepted.exportLedger().entries.length, 0);
assert.ok(
  rows.some(
    (row) => row.kind === "hybrid-combat-observation-omitted" && row.reason === "observation-stale",
  ),
);
const wait = new Policy({ storage: null });
ready(wait);
wait.models.wait.weights[0] = 2;
await wait.decide(behavior, [a]);
assert.equal(wait.pending.decisionStep, wait.proposal.step);
assert.equal(wait.proposal.reason, "controlled-wait");
tick++;
wait.observe(behavior);
assert.equal(wait.lastOutcome.decisionStep, 0);
assert.equal(wait.lastOutcome.controlledAction, "wait");
assert.equal(wait.lastOutcome.learned, true);
assert.equal(
  wait.lastOutcome.decisionSequence,
  wait.exportLedger().entries.find((row) => row.kind === "proposal").sequence,
);
assert.equal(wait.lastOutcome.acceptedSequence, null);
const shadowWait = new Policy({ storage: null });
await shadowWait.decide(behavior, [a]);
assert.equal(
  shadowWait.pending.decisionStep ?? null,
  null,
  "a fallback observation is not a controlled WAIT",
);

const cancelled = new Policy({ storage: null });
ready(cancelled);
const oldGeneration = cancelled.generation;
const cancelledModel = JSON.stringify(cancelled.exportModel());
await cancelled.decide(
  {
    ...behavior,
    sendAttack: async () => {
      cancelled.resetEpisode();
      return false;
    },
  },
  [a],
);
assert.equal(cancelled.exportLedger().entries.length, 0);
assert.equal(cancelled.diagnostics().funnel.dispatchAttempts, 0);
assert.ok(
  rows.some(
    (row) =>
      row.cancelled && row.generation === oldGeneration && row.reason === "cancelled-generation",
  ),
);
const cancelledRow = rows.findLast((row) => row.cancelled && row.generation === oldGeneration);
assert.equal(cancelledRow.modelIdentity, cancelledModel);
assert.equal(cancelledRow.actorSmallID, 1);
assert.equal(cancelledRow.step, 0);
assert.equal(cancelledRow.decisionSequence, 0);
assert.equal(
  cancelledRow.sequence,
  null,
  "historical cancellation cannot allocate in a reset episode",
);
assert.equal(cancelledRow.ingressSequence, 0);

// Exercise real caller/sender methods with mocks, without loading an adapter or engine.
const source = fs.readFileSync(
  new URL("../engine/ingame/auto-bot/attackBehavior.js", import.meta.url),
  "utf8",
);
function method(name, next) {
  const start = source.indexOf(`    async ${name}(`);
  const end = source.indexOf(`    ${next}`, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInContext(`({${source.slice(start, end)}}).${name}`, sandbox);
}
const caller = method("decideHybridCombat", "resetBoatRouteEtaCache");
const policy = vm.runInContext("hybridCombatPolicy", sandbox);
policy.importModel(policy.createCompactModel());
policy.configure({ mode: "shadow" });
policy.resetEpisode();
const callerBehavior = {
  player: behavior.player,
  currentAttackDecisionTick: () => tick,
  prepareHybridCombatGeometry: async () => {
    tick++;
  },
};
await caller.call(callerBehavior, [a]);
assert.equal(policy.exportLedger().entries.at(-1).reason, "stale-geometry-tick");
assert.equal(policy.diagnostics().funnel.suppliedTargets, 1);
assert.equal(policy.exportLedger().entries.at(-1).actorSmallID, 1);
assert.equal(
  policy.exportLedger().entries.at(-1).modelIdentity,
  JSON.stringify(policy.exportModel()),
);
policy.resetEpisode();
const callerIdentity = policy.decisionIdentity(callerBehavior);
await caller.call(
  { ...callerBehavior, prepareHybridCombatGeometry: async () => policy.resetEpisode() },
  [a],
);
assert.equal(policy.exportLedger().entries.length, 0);
const cancelledCallerRow = rows.findLast((row) => row.cancelled);
assert.equal(cancelledCallerRow.modelIdentity, callerIdentity.modelIdentity);
assert.equal(cancelledCallerRow.actorSmallID, callerIdentity.actorSmallID);
assert.equal(cancelledCallerRow.tick, callerIdentity.tick);
assert.equal(cancelledCallerRow.step, callerIdentity.step);
assert.equal(cancelledCallerRow.sequence, null);
assert.equal(cancelledCallerRow.ingressSequence, callerIdentity.ingressSequence);
assert.equal(cancelledCallerRow.decisionSequence, null);
policy.configure({ mode: "shadow", learning: false });
const originalModel = JSON.stringify(policy.exportModel());
await caller.call(
  {
    ...behavior,
    prepareHybridCombatGeometry: async () => {
      policy.models.wait.samples += 1;
    },
  },
  [],
);
assert.equal(
  policy.exportLedger().entries.at(-1).modelIdentity,
  originalModel,
  "caller captures original model before asynchronous geometry and preserves fallback identity",
);

const sender = method("sendAuthorizedAttack", "rejectHybridAttack");
const rejectionStart = source.indexOf("    rejectHybridAttack(");
const rejectionEnd = source.indexOf("    async tryHybridJointAttack", rejectionStart);
const rejectHybridAttack = vm.runInContext(
  `({${source.slice(rejectionStart, rejectionEnd)}}).rejectHybridAttack`,
  sandbox,
);
const observationSender = method(
  "sendAttackWithHybridObservation",
  "// hasLandBorderWithTerraNullius",
);
const ordered = [];
const senderBehavior = {
  rejectHybridAttack,
  canAttackPlayerNow: () => {
    ordered.push("native");
    return true;
  },
  shouldAttack: () => {
    ordered.push("should");
    return true;
  },
  sendAttackTargetIsAuthorized: () => {
    ordered.push("authorization");
    return true;
  },
  hybridAllowsAttack: () => {
    ordered.push("coordination");
    return true;
  },
  attachActiveTribeReinforcementPlan: () => ordered.push("reinforcement"),
  sendAttackIsPendingDuplicate: () => {
    ordered.push("duplicate");
    return false;
  },
  sendAttackWithHybridObservation: async () => {
    ordered.push("emit");
    return true;
  },
};
assert.equal(await sender.call(senderBehavior, { target: a, force: false }), true);
assert.deepEqual(ordered, [
  "native",
  "should",
  "authorization",
  "coordination",
  "reinforcement",
  "duplicate",
  "emit",
]);
const rejected = {
  ...senderBehavior,
  canAttackPlayerNow: () => false,
  hybridSafetyAttempt: { generation: policy.generation, targetSmallID: 2 },
};
assert.equal(await sender.call(rejected, { target: a, force: false }), false);
assert.equal(rejected.hybridSafetyAttempt.reason, "native-legality-rejected");
for (const [guard, reason] of [
  ["shouldAttack", "should-attack-rejected"],
  ["sendAttackTargetIsAuthorized", "target-authorization-rejected"],
  ["hybridAllowsAttack", "commitment-veto"],
  ["sendAttackIsPendingDuplicate", "pending-duplicate"],
]) {
  const current = {
    ...senderBehavior,
    [guard]: () => guard === "sendAttackIsPendingDuplicate",
    hybridSafetyAttempt: {},
  };
  assert.equal(await sender.call(current, { target: a, force: false }), false);
  assert.equal(current.hybridSafetyAttempt.reason, reason);
}
policy.resetEpisode();
const emits = [];
const observationBehavior = {
  ...behavior,
  sendAttackAgainstPlayer: async ({ target: enemy }) => {
    emits.push(enemy.smallID());
    return true;
  },
};
for (const mode of ["baseline", "shadow"]) {
  policy.configure({ mode });
  for (const [enemy, force] of [
    [a, false],
    [tribe, false],
    [a, true],
  ])
    assert.equal(await observationSender.call(observationBehavior, { target: enemy, force }), true);
}
assert.deepEqual(
  emits,
  [2, 4, 2, 2, 4, 2],
  "shadow preserves baseline sender intents including forced and tribe lanes",
);
assert.equal(policy.diagnostics().observations.reasons["forced-action"], 1);
assert.equal(policy.diagnostics().observations.reasons["tribe-target"], 1);
policy.importModel(p.exportModel());
policy.configure({ mode: "shadow", learning: false });
for (const [enemy, force] of [
  [a, true],
  [tribe, false],
]) {
  await policy.decide(behavior, [a]);
  assert.ok(policy.pending && !policy.pending.target);
  assert.equal(
    await observationSender.call(
      { ...observationBehavior, sendAttackAgainstPlayer: async () => false },
      { target: enemy, force },
    ),
    false,
  );
  assert.ok(policy.pending, "rejected forced/tribe send does not invent an intervening action");
  assert.equal(await observationSender.call(observationBehavior, { target: enemy, force }), true);
  assert.equal(
    policy.pending,
    null,
    "actual forced/tribe emission prevents a fake strategic WAIT outcome",
  );
}

const wrapperStart = source.indexOf("    async sendAttack(...args)");
const wrapperEnd = source.indexOf("    async tryHybridJointAttack", wrapperStart);
const SenderFixture = vm.runInContext(
  `(class {${source.slice(wrapperStart, wrapperEnd)}})`,
  sandbox,
);
const wrapped = new SenderFixture();
Object.assign(wrapped, behavior, senderBehavior, {
  normalizeSendAttackArgs: (args) => ({ target: args[0], force: false }),
  sendAttackWithHybridObservation: async () => false,
});
delete wrapped.sendAttack;
policy.importModel(p.exportModel());
policy.configure({ mode: "learned", learning: false });
policy.resetEpisode();
wrapped.shouldAttack = () => false;
await policy.decide(wrapped, [a]);
assert.equal(
  policy.exportLedger().entries.at(-1).reason,
  "should-attack-rejected",
  "real sender guard reason crosses dispatch boundary",
);
wrapped.shouldAttack = () => true;
await policy.decide(wrapped, [a]);
assert.equal(
  policy.exportLedger().entries.at(-1).reason,
  "send-rejected-unknown",
  "boolean-only lower sender supplies no speculative cause",
);
assert.equal(policy.diagnostics().funnel.dispatchAttempts, 2);
assert.equal(policy.diagnostics().funnel.acceptedDispatches, 0);
assert.equal(wrapped.hybridSafetyAttempt, null);
vm.runInContext("class StructureBehavior {}", sandbox);
vm.runInContext(
  fs.readFileSync(new URL("../engine/ingame/auto-bot/hybridStrategy.js", import.meta.url), "utf8"),
  sandbox,
);
const strategy = sandbox.window.__OFH_hybridStrategy;
strategy.configure({ enabled: true });
const ingress = method("maybeAttack", "async continueOpeningExpansion");
const duoStart = source.indexOf("    observeHybridStrategyDuo(");
const duoEnd = source.indexOf("    // maybeAttack", duoStart);
assert.ok(duoStart >= 0 && duoEnd > duoStart);
const observeHybridStrategyDuo = vm.runInContext(
  `({${source.slice(duoStart, duoEnd)}}).observeHybridStrategyDuo`,
  sandbox,
);
const ingressTrace = [];
sandbox.profileAttackSync = (_profile, label, callback) => {
  ingressTrace.push(label);
  return callback();
};
sandbox.profileAttackAsync = async (_profile, label, callback) => {
  ingressTrace.push(label);
  return callback();
};
sandbox.companionJointPlan = () => {
  throw new Error("disabled Companion must not be needed for observations");
};
sandbox.state.settings.companionEnabled = false;
let windowTroops = 100;
const windowEnemy = { ...a, troops: () => windowTroops, outgoingAttacks: () => [] };
const windowPlayer = {
  smallID: () => 1,
  type: () => "HUMAN",
  isAlive: () => true,
  isFriendly: () => false,
  outgoingAttacks: () => [],
  outgoingEmojis: () => [],
};
const nativeGame = { ticks: () => tick, players: () => [windowPlayer, windowEnemy] };
const ingressBehavior = {
  observeHybridStrategyDuo,
  game: { __src: nativeGame },
  player: windowPlayer,
  allianceBehavior: {},
  enforceSameClanNukeTerrainSafety: () => ingressTrace.push("safety"),
  reconcileOutboundAttackIntentCommitments: () => ingressTrace.push("reconcile"),
  createAttackDecisionContext: () => ({}),
  updateExpansionBreakoutState: () => ingressTrace.push("expansion"),
  updateCapPressureStrikeState: () => ingressTrace.push("cap"),
  respondToIncomingAttack: async () => {
    ingressTrace.push("defense");
    return true;
  },
  siegePermitsGrowthLanes: () => false,
};
delete sandbox.window.__OFH_hybridStrategy;
await ingress.call(ingressBehavior);
const originalTrace = [...ingressTrace];
sandbox.window.__OFH_hybridStrategy = strategy;
ingressTrace.length = 0;
await ingress.call(ingressBehavior);
tick++;
windowTroops = 60;
await ingress.call(ingressBehavior);
assert.deepEqual(
  ingressTrace,
  [...originalTrace, ...originalTrace],
  "observation ingress preserves priority and emits no extra action",
);
assert.equal(
  strategy.describeStrikeWindow({ game: nativeGame, player: windowPlayer }, 2).observations
    .troopDropObserved,
  true,
  "two attack-ingress ticks observe real drops without Companion or boss access",
);
process.stdout.write("hybrid combat funnel tests passed\n");
