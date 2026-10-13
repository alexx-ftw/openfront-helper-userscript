import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createAttackBehaviorSandbox } from "./helpers/attack-behavior-sandbox.mjs";
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
const ridgeBeforeProfile = JSON.stringify(p.exportModel());
assert.throws(
  () => p.importModel({ ...p.exportModel(), controlProfile: "target-value-v1" }),
  /Incompatible hybrid combat feature\/action schema/,
  "A compact-only control profile cannot be silently discarded by Ridge import",
);
assert.equal(JSON.stringify(p.exportModel()), ridgeBeforeProfile);
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
assert.equal(p.exportLedger().entries.at(-1).targetChecks.length, 1);
assert.equal(p.exportLedger().entries.at(-1).targetChecks[0].stage, "unevaluated");
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
const duplicate = new Policy({ storage: null });
ready(duplicate);
const beforeDuplicate = sends;
assert.equal(
  await duplicate.decide({ ...behavior, sendAttackIsPendingDuplicate: () => true }, [a]),
  false,
);
assert.equal(sends, beforeDuplicate);
assert.equal(duplicate.exportLedger().entries.at(-1).targetChecks[0].reason, "pending-duplicate");
assert.equal(duplicate.diagnostics().funnel.fundedTargets, 0);
const quoted = new Policy({ storage: null });
ready(quoted);
await quoted.decide(
  {
    ...behavior,
    inspectLandAttackFunding: () => ({
      allowed: false,
      reason: "capture-reserve-insufficient",
      spendableTroops: 39,
      payloadTroops: 0,
    }),
  },
  [a],
);
assert.equal(
  quoted.exportLedger().entries.at(-1).targetChecks[0].reason,
  "capture-reserve-insufficient",
);
assert.equal(quoted.exportLedger().entries.at(-1).targetChecks[0].funding.spendableTroops, 39);

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
assert.equal(
  compact.gateFeatures({ ...geometryBehavior, incomingHostileAttackPressure: () => null }),
  null,
  "Unknown pressure cannot become a compact-model known-zero feature",
);
assert.equal(p.gateFeatures({ ...behavior, incomingHostileAttackPressure: () => null })[3], 1);
assert.equal(p.gateFeatures({ ...behavior, incomingHostileAttackPressure: () => 0 })[3], 0);
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
const knownReinforcement = accepted.actionObservation(callback, a);
assert.ok(knownReinforcement);
assert.deepEqual(Array.from(knownReinforcement.attackIds), ["receipt"]);
callback.botAttackPendingIntentCommitments = [{ target: a, targetKey: "2", troops: 10 }];
assert.equal(accepted.actionObservation(callback, a), null);
assert.equal(accepted.exportLedger().entries.at(-1).reason, "ambiguous-commitment");
callback.botAttackPendingIntentCommitments = [];
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
  observeAttackLeadTrajectory: () => ingressTrace.push("lead"),
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
{
  let collectorTick = 1000,
    land = 20,
    collectorSends = 0;
  const collectorBehavior = {
    ...behavior,
    player: { ...behavior.player, numTilesOwned: () => land, incomingAttacks: () => [] },
    currentAttackDecisionTick: () => collectorTick,
    getOutboundAttackSnapshot: () => [],
    getOutboundTransportSnapshot: () => [],
    sendAttack: async () => {
      collectorSends++;
      return true;
    },
  };
  const createCollector = (options = {}) => {
    const policy = new Policy({ storage: null });
    policy.configure({
      mode: "shadow",
      learning: true,
      collectionPolicy: "coverage-wait-v1",
      ...options,
    });
    return policy;
  };
  const collector = createCollector();
  assert.equal(collector.ready(), false);
  assert.equal(await collector.decide(collectorBehavior, [a]), true);
  const firstProposal = collector.exportLedger().entries.find((row) => row.kind === "proposal");
  const firstDecision = collector.exportLedger().entries.at(-1);
  assert.equal(firstProposal.action, "wait");
  assert.equal(firstProposal.targetSmallID, null);
  assert.equal(firstProposal.collectorControl, true);
  assert.equal(firstDecision.controlledAction, "wait");
  assert.equal(firstDecision.behaviorPolicy, "coverage-driven-safe-wait-collection-v1");
  assert.equal(collector.pending.learned, false);
  assert.equal(collector.diagnostics().collection.completedWaits, 0, "proposal is not coverage");
  assert.equal(
    await collector.decide(collectorBehavior, [a]),
    false,
    "same-tick pending slot is not reused",
  );
  assert.equal(collector.collection.opportunities, 1);
  for (let completed = 1; completed <= 4; completed++) {
    collectorTick++;
    land++;
    collector.observe(collectorBehavior);
    assert.equal(collector.collection.completedWaits, completed);
    const outcome = collector.exportLedger().entries.at(-1);
    assert.equal(outcome.kind, "outcome");
    assert.equal(outcome.collectorControl, true);
    assert.equal(outcome.learned, false);
    assert.equal(outcome.controlledAction, "wait");
    assert.equal(
      outcome.outcomeTick - outcome.actionTick,
      1,
      "collector keeps the native WAIT window",
    );
    assert.equal(outcome.behaviorPolicy, "coverage-driven-safe-wait-collection-v1");
    assert.ok(Number.isInteger(outcome.decisionStep));
    assert.ok(Number.isInteger(outcome.decisionSequence));
    if (completed === 1) {
      assert.equal(outcome.decisionStep, firstDecision.step);
      assert.equal(outcome.decisionSequence, firstProposal.sequence);
    }
    assert.equal(
      await collector.decide(collectorBehavior, [a]),
      false,
      "alternate delegates to Legendary",
    );
    if (completed < 4) {
      collectorTick++;
      assert.equal(await collector.decide(collectorBehavior, [a]), true);
    }
  }
  collectorTick++;
  assert.equal(
    await collector.decide(collectorBehavior, [a]),
    false,
    "coverage plus native signal ends collection",
  );
  assert.equal(collector.collection.controlledWaits, 4);
  assert.equal(collector.collection.completedWaits, 4);
  assert.equal(collector.readiness().wait.signalPresent, true);
  assert.equal(collector.ready(), false, "cold ACT/target readiness is never bypassed");
  assert.equal(collectorSends, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(collector.diagnostics().control)), {
    candidateDecisions: 0,
    controlledWaits: 0,
    acceptedLearnedAttacks: 0,
    confirmedLearnedAttacks: 0,
    fallbacks: 0,
  });
  collector.resetEpisode();
  assert.equal(
    collector.collection.completedWaits,
    4,
    "genuine coverage survives an episode boundary",
  );
  collector.importModel(collector.exportModel());
  assert.equal(collector.collection.completedWaits, 0, "imports cannot supply collector coverage");
  assert.equal(
    collector.collectionPolicy,
    null,
    "import requires explicit collector configuration",
  );
  collector.configure({ collectionPolicy: "coverage-wait-v1" });
  assert.equal(
    await collector.decide(collectorBehavior, [a]),
    true,
    "imported signal alone does not stop collection",
  );

  for (const pressure of [undefined, null, NaN, Infinity, -1, 1]) {
    const blocked = createCollector();
    assert.equal(
      await blocked.decide(
        { ...collectorBehavior, incomingHostileAttackPressure: () => pressure },
        [a],
      ),
      false,
    );
    assert.equal(blocked.collection.opportunities, 0);
  }
  const unreadable = createCollector();
  assert.equal(
    await unreadable.decide({ ...collectorBehavior, incomingHostileAttackPressure: undefined }, [
      a,
    ]),
    false,
  );
  for (const incomingPlayer of [
    { incomingAttacks: undefined },
    { incomingAttacks: 0 },
    { incomingAttacks: () => undefined },
    { incomingAttacks: () => [{ troops: 0 }] },
    { incomingAttacks: () => [{ troops: 30 }] },
    { incomingAttacks: () => [{}] },
    { incomingAttacks: () => [null] },
    { incomingAttacks: () => [{ troops: () => NaN }] },
    { incomingAttacks: () => [{ troops: () => -1 }] },
    { __src: {}, incomingAttacks: () => [] },
  ]) {
    const blocked = createCollector();
    assert.equal(
      await blocked.decide(
        { ...collectorBehavior, player: { ...collectorBehavior.player, ...incomingPlayer } },
        [a],
      ),
      false,
      "a zero pressure fallback without readable native attacks is not safe",
    );
    assert.equal(blocked.collection.opportunities, 0);
  }
  for (const badBehavior of [
    { ...collectorBehavior, canFundLandAttack: () => false },
    { ...collectorBehavior, sendAttackIsPendingDuplicate: () => true },
    { ...collectorBehavior, getPlayerAttackPreferredTroopFloor: () => NaN },
  ]) {
    const blocked = createCollector();
    assert.equal(await blocked.decide(badBehavior, [a]), false);
    assert.equal(blocked.collection.opportunities, 0);
  }
  const occupied = createCollector();
  occupied.pending = {
    target: a,
    targetSmallID: 2,
    tick: collectorTick,
    attackIds: [],
    gate: [1, 0.5, 0.2, 0],
  };
  const originalPending = occupied.pending;
  assert.equal(await occupied.decide(collectorBehavior, [a]), false);
  assert.equal(occupied.pending, originalPending);
  assert.equal(occupied.collection.opportunities, 0);
  const cancelled = createCollector();
  assert.equal(await cancelled.decide(collectorBehavior, [a]), true);
  cancelled.resetEpisode();
  collectorTick++;
  cancelled.observe(collectorBehavior);
  assert.equal(cancelled.collection.completedWaits, 0);
  const sameTickTerminal = createCollector();
  assert.equal(await sameTickTerminal.decide(collectorBehavior, [a]), true);
  const sameTickModel = JSON.stringify(sameTickTerminal.exportModel());
  sameTickTerminal.observe(collectorBehavior, true);
  assert.equal(
    sameTickTerminal.collection.completedWaits,
    0,
    "zero-duration terminal is not coverage",
  );
  assert.equal(
    JSON.stringify(sameTickTerminal.exportModel()),
    sameTickModel,
    "censor precedes all model updates",
  );
  assert.equal(sameTickTerminal.pending, null);
  assert.equal(sameTickTerminal.lastOutcome.reason, "zero-duration-collector-wait");
  assert.equal(sameTickTerminal.lastOutcome.truncated, true);
  assert.equal(sameTickTerminal.lastOutcome.reward, null);
  assert.equal(sameTickTerminal.lastOutcome.collectorControl, true);
  const ordinaryTerminal = new Policy({ storage: null });
  await ordinaryTerminal.decide(collectorBehavior, [a]);
  ordinaryTerminal.observe(collectorBehavior, true);
  assert.equal(
    ordinaryTerminal.models.wait.samples,
    1,
    "ordinary zero-duration behavior is unchanged",
  );

  const competing = createCollector();
  assert.equal(await competing.decide(collectorBehavior, [a]), true);
  const waitReference = { ...competing.pending };
  const competingModel = JSON.stringify(competing.exportModel());
  collectorTick++;
  assert.equal(competing.cancelCollectorWait(collectorBehavior), true);
  const cancelledWait = competing.exportLedger().entries.at(-1);
  assert.equal(cancelledWait.reason, "competing-attack-emission");
  assert.equal(cancelledWait.kind, "outcome");
  assert.equal(cancelledWait.cancelled, true);
  assert.equal(cancelledWait.truncated, true);
  assert.equal(cancelledWait.reward, null);
  assert.equal(cancelledWait.action, "wait");
  assert.equal(cancelledWait.outcomeTick, collectorTick);
  for (const key of [
    "actionTick",
    "decisionStep",
    "decisionSequence",
    "actorSmallID",
    "modelIdentity",
    "collectorControl",
    "behaviorPolicy",
    "controlledAction",
  ]) {
    assert.equal(
      cancelledWait[key],
      key === "actionTick" ? waitReference.tick : waitReference[key],
    );
  }
  assert.equal(competing.pending, null);
  competing.observe(collectorBehavior);
  assert.equal(JSON.stringify(competing.exportModel()), competingModel);
  assert.equal(competing.collection.completedWaits, 0);
  assert.equal(
    competing.cancelCollectorWait(collectorBehavior),
    false,
    "repeated cancellation is a no-op",
  );
  for (const pending of [
    { target: a, controlledAction: "attack", collectorControl: true },
    { target: null, controlledAction: "wait" },
    { target: null, controlledAction: "wait", learned: true },
  ]) {
    competing.pending = pending;
    const ledgerCount = competing.exportLedger().entries.length;
    assert.equal(competing.cancelCollectorWait(collectorBehavior), false);
    assert.equal(competing.pending, pending);
    assert.equal(competing.exportLedger().entries.length, ledgerCount);
  }
  const writerFailure = createCollector();
  assert.equal(await writerFailure.decide(collectorBehavior, [a]), true);
  const writerModel = JSON.stringify(writerFailure.exportModel());
  const originalWriter = sandbox.roundLogRecord;
  sandbox.roundLogRecord = () => {
    throw new Error("censor writer failure");
  };
  try {
    assert.throws(
      () => writerFailure.cancelCollectorWait(collectorBehavior),
      /censor writer failure/,
    );
  } finally {
    sandbox.roundLogRecord = originalWriter;
  }
  assert.equal(writerFailure.pending, null, "collector invalidates before evidence publication");
  assert.equal(JSON.stringify(writerFailure.exportModel()), writerModel);
  assert.equal(writerFailure.lastOutcome.truncated, true);
  assert.equal(writerFailure.lastOutcome.reward, null);

  const AttackBehavior = createAttackBehaviorSandbox().AttackBehavior;
  for (const shape of [
    "unknown",
    "friendly",
    "hostile",
    "numeric",
    "missing-troops",
    "nonfinite",
  ]) {
    const actual = Object.create(AttackBehavior.prototype);
    const attacker = { smallID: () => 99, isAlive: () => true };
    const own = {
      ...collectorBehavior.player,
      isFriendly: (other) => shape === "friendly" && other === attacker,
    };
    let incoming;
    if (shape === "numeric") incoming = { troops: 30 };
    else if (shape === "missing-troops") incoming = {};
    else if (shape === "nonfinite") incoming = { troops: () => NaN };
    else incoming = { troops: () => 30 };
    if (["friendly", "hostile"].includes(shape))
      Object.assign(incoming, {
        attacker: () => attacker,
        target: () => own,
        retreating: () => false,
      });
    own.incomingAttacks = () => [incoming];
    Object.assign(actual, collectorBehavior, {
      player: own,
      game: { ...collectorBehavior.game, ticks: () => collectorTick },
      botAttackPendingIntentCommitments: [],
      inspectLandAttackFunding: () => ({ allowed: true, reason: "funded" }),
    });
    delete actual.incomingHostileAttackPressure;
    assert.equal(
      actual.incomingHostileAttackPressure(),
      shape === "hostile" ? 0.3 : 0,
      "real native pressure filters ambiguous or friendly identities to zero",
    );
    const blocked = createCollector();
    assert.equal(
      await blocked.decide(actual, [a]),
      false,
      "any positive or unreadable raw attack prevents collector WAIT",
    );
    assert.equal(blocked.collection.opportunities, 0);
  }
  const invalidOutcome = createCollector();
  assert.equal(await invalidOutcome.decide(collectorBehavior, [a]), true);
  collectorTick++;
  invalidOutcome.observe({
    ...collectorBehavior,
    player: { ...collectorBehavior.player, troops: () => NaN },
  });
  assert.equal(invalidOutcome.collection.completedWaits, 0);
  assert.equal(invalidOutcome.lastOutcome.collectorControl, true);
  assert.equal(invalidOutcome.lastOutcome.reward, null);

  const noSignal = createCollector();
  for (let i = 0; i < 4; i++) {
    assert.equal(await noSignal.decide(collectorBehavior, [a]), true);
    collectorTick++;
    noSignal.observe(collectorBehavior);
    assert.equal(await noSignal.decide(collectorBehavior, [a]), false);
    collectorTick++;
  }
  assert.equal(noSignal.collection.completedWaits, 4);
  assert.equal(noSignal.readiness().wait.signalPresent, false);
  assert.equal(
    await noSignal.decide(collectorBehavior, [a]),
    true,
    "coverage without signal must keep collecting",
  );
  for (const options of [
    { mode: "baseline" },
    { mode: "learned" },
    { learning: false },
    { collectionPolicy: null },
  ]) {
    const blocked = createCollector(options);
    assert.equal(await blocked.decide(collectorBehavior, [a]), false);
    assert.equal(blocked.collection.controlledWaits, 0);
  }
  const defaultShadow = new Policy({ storage: null });
  assert.equal(await defaultShadow.decide(collectorBehavior, [a]), false);
  assert.equal(defaultShadow.pending.collectorControl, undefined);
  assert.equal(defaultShadow.exportLedger().entries.at(-1).collectorControl, undefined);
  collectorTick++;
  defaultShadow.observe(collectorBehavior);
  assert.equal(
    defaultShadow.lastOutcome.collectorControl,
    undefined,
    "old shadow waits stay unclassified",
  );
  assert.throws(() => defaultShadow.configure({ collectionPolicy: "unknown" }), /configuration/);
  assert.equal(defaultShadow.collectionPolicy, null);
  const omitted = createCollector();
  omitted.configure({ mode: "shadow", learning: true });
  assert.equal(omitted.collectionPolicy, null, "omitted option clears old headless collector");
  assert.equal(await omitted.decide(collectorBehavior, [a]), false);
  const saved = new Map();
  const storage = {
    getItem: (key) => saved.get(key),
    setItem: (key, value) => saved.set(key, value),
  };
  const persistent = new Policy({ storage });
  persistent.configure({ mode: "shadow", learning: true, collectionPolicy: "coverage-wait-v1" });
  assert.equal(await persistent.decide(collectorBehavior, [a]), true);
  collectorTick++;
  land++;
  persistent.observe(collectorBehavior);
  const serialized = JSON.parse([...saved.values()][0]);
  assert.deepEqual(serialized.config, { mode: "shadow", learning: true });
  assert.equal(serialized.model.collection, undefined);
  assert.equal(serialized.model.collectionPolicy, undefined);
  serialized.config.collectionPolicy = "coverage-wait-v1";
  saved.set("openfront-helper-hybrid-combat-v1", JSON.stringify(serialized));
  const reloaded = new Policy({ storage });
  assert.equal(reloaded.collectionPolicy, null, "browser reload cannot rehydrate headless control");
  assert.equal(reloaded.collection.completedWaits, 0);
  assert.equal(await reloaded.decide(collectorBehavior, [a]), false);
  const compactCollector = createCollector();
  compactCollector.importModel(compactCollector.createCompactModel());
  compactCollector.configure({
    mode: "shadow",
    learning: true,
    collectionPolicy: "coverage-wait-v1",
  });
  assert.equal(
    await compactCollector.decide(
      {
        ...geometryBehavior,
        ...collectorBehavior,
        hybridCombatGeometry: (enemy) => ({
          targetSmallID: enemy.smallID(),
          tick: collectorTick,
          source: "native-border-centroid-v1",
          own: { x: 0, y: 0 },
          target: { x: 5, y: 5 },
          width: 100,
          height: 100,
        }),
      },
      [a],
    ),
    true,
  );
  assert.equal(compactCollector.pending.collectorControl, true);
  assert.equal(compactCollector.readiness().wait.requiredSamples, 4);
}
// Synthetic constant predictors isolate inference semantics; these are not training models.
for (const controlProfile of [undefined, "target-value-v1"]) {
  for (const scenario of [
    { act: 0.5, targetValue: -0.8, legacyChoice: "attack", targetChoice: "wait" },
    { act: -0.5, targetValue: 0.8, legacyChoice: "wait", targetChoice: "attack" },
  ]) {
    const conditional = new Policy({ storage: null });
    const model = conditional.createCompactModel({ controlProfile });
    model.provenance.datasetID = "fixture-inference-only";
    for (const head of Object.values(model.models)) head.samples = head.hidden.length;
    model.models.act.outputBias = Math.atanh(scenario.act);
    model.models.target.outputBias = Math.atanh(scenario.targetValue);
    conditional.importModel(model);
    conditional.configure({ mode: "learned", learning: false });
    let conditionalSends = 0;
    await conditional.decide(
      {
        ...geometryBehavior,
        sendAttack: async () => {
          conditionalSends++;
          return true;
        },
      },
      [a],
    );
    const choice = controlProfile ? scenario.targetChoice : scenario.legacyChoice;
    assert.equal(conditional.proposal.greedyChoice, choice);
    assert.equal(conditionalSends, choice === "attack" ? 1 : 0);
    assert.equal(conditional.exportModel().controlProfile, controlProfile);
  }
}
for (const controlProfile of [undefined, "target-value-v1"]) {
  const retry = new Policy({ storage: null });
  const model = retry.createCompactModel({ controlProfile });
  model.provenance.datasetID = "fixture-inference-only";
  for (const head of Object.values(model.models)) head.samples = head.hidden.length;
  model.models.wait.outputBias = Math.atanh(0.5);
  model.models.act.outputBias = Math.atanh(0.8);
  model.models.target.outputBias = 2;
  model.models.target.output[4] = -10;
  retry.importModel(model);
  retry.configure({ mode: "learned", learning: false });
  const attempts = [];
  await retry.decide(
    {
      ...geometryBehavior,
      canAttackPlayerNow: () => true,
      sendAttack: async (enemy) => {
        attempts.push(enemy.smallID());
        return false;
      },
    },
    [a, { ...b, numTilesOwned: () => 20 }],
  );
  assert.deepEqual(
    attempts,
    controlProfile ? [2] : [2, 3],
    "Target-value control must not retry an inferior-to-WAIT target after rejection",
  );
}
process.stdout.write("hybrid combat funnel tests passed\n");

// Repeating WAIT in the same tick keeps the first pending identity, not a second label.
{
  const busy = new Policy({ storage: null });
  ready(busy);
  busy.models.wait.weights[0] = 2;
  await busy.decide(behavior, [a]);
  const firstStep = busy.pending.decisionStep;
  const firstSequence = busy.pending.decisionSequence;
  await busy.decide(behavior, [a]);
  assert.equal(busy.pending.decisionStep, firstStep, "busy WAIT must retain original step");
  assert.equal(
    busy.pending.decisionSequence,
    firstSequence,
    "busy WAIT must retain original proposal",
  );
  assert.equal(busy.control.controlledWaits, 2, "both WAIT decisions still control");
  const proof = busy.exportLedger().entries.find((entry) => entry.phase === "controlled-wait-busy");
  assert.equal(proof.owner.decisionStep, firstStep);
  assert.equal(busy.proposal.observationOmissionSequence, proof.sequence);
  assert.equal(busy.exportLedger().entries.filter((entry) => entry.kind === "outcome").length, 0);
}
