import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
// Only this repository's classic script is evaluated in an isolated test realm.
/* eslint-disable sonarjs/code-eval */

const file = new URL("../engine/ingame/auto-bot/hybridCombat.js", import.meta.url);
const store = new Map();
const sandbox = {
  window: {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
  },
  state: { settings: { winFixes: true } },
  PlayerType: { Bot: "BOT", Nation: "NATION", Human: "HUMAN" },
};
vm.createContext(sandbox);
vm.runInContext(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", sandbox);
assert.equal(
  typeof sandbox.window.__OFH_hybridCombat,
  "object",
  "hybrid learning API is available",
);
const api = sandbox.window.__OFH_hybridCombat;
assert.equal(api.diagnostics().mode, "shadow");
assert.throws(() => api.configure({ mode: "unknown" }));
assert.throws(() => api.importModel({ schema: 1, models: {} }));
const Policy = vm.runInContext("HybridCombatPolicy", sandbox);
const brokenSaved = new Policy({ storage: { getItem: () => "{invalid", setItem() {} } });
assert.equal(brokenSaved.diagnostics().mode, "shadow");
assert.ok(brokenSaved.diagnostics().error, "corrupt stored data remains visible in diagnostics");
const deniedStorage = new Policy({
  storage: {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  },
});
deniedStorage.configure({ mode: "baseline" });
assert.equal(deniedStorage.diagnostics().error, "quota");
const learner = new Policy({ storage: null });
const x = [1, 0.5, 0.1, 0, 0.2, 0.2, 0.1, 0.1, 0];
for (let i = 0; i < 20; i++) learner.learn("target", x, 0.25);
assert.ok(learner.predict("target", x) > 0.2, "observed positive outcomes change predictions");
const model = learner.exportModel();
const frozen = new Policy({ storage: null });
frozen.importModel(model);
assert.equal(frozen.predict("target", x), learner.predict("target", x));
model.models.target.weights[0] = Infinity;
assert.throws(
  () => frozen.importModel(model),
  "nonfinite weights are rejected before replacing a model",
);
assert.equal(frozen.predict("target", x), learner.predict("target", x));
assert.throws(() =>
  learner.learn(
    "target",
    x.map(() => NaN),
    1,
  ),
);
assert.throws(() => learner.learn("target", x, NaN));
frozen.configure({ mode: "learned", learning: false });
const before = JSON.stringify(frozen.exportModel());
frozen.learn("target", x, -1);
assert.equal(JSON.stringify(frozen.exportModel()), before, "evaluation freezes training");
const corrupt = learner.exportModel();
corrupt.models.target.inverse[0][0] = -1;
assert.throws(() => frozen.importModel(corrupt), "invalid covariance is rejected");
const extra = learner.exportModel();
extra.models.extra = null;
assert.throws(() => frozen.importModel(extra), "unknown model keys cannot poison readiness");
assert.equal(JSON.stringify(frozen.exportModel()), before);
const asymmetric = learner.exportModel();
asymmetric.models.wait.inverse = Array.from({ length: 4 }, (_, i) =>
  Array.from({ length: 4 }, (_, j) => (i === j ? 1e-20 : 0)),
);
asymmetric.models.wait.inverse[0][1] = -1e-15;
assert.throws(
  () => frozen.importModel(asymmetric),
  "symmetry validation scales with the covariance itself",
);
const hugeAsymmetric = learner.exportModel();
hugeAsymmetric.models.wait.inverse = Array.from({ length: 4 }, (_, i) =>
  Array.from({ length: 4 }, (_, j) => (i === j ? 1e200 : 0)),
);
hugeAsymmetric.models.wait.inverse[0][1] = 1e200;
assert.throws(() => frozen.importModel(hugeAsymmetric), "large diagonals cannot bypass symmetry");

let tick = 10;
let tiles = 10;
let commitments = [];
let emitted = 0;
let transports = [];
const enemy = (sid, owned = 20) => ({
  smallID: () => sid,
  type: () => "NATION",
  numTilesOwned: () => owned,
  troops: () => 20,
  isAlive: () => true,
  isPlayer: () => true,
});
const a = enemy(2);
const b = enemy(3, 30);
const behavior = {
  player: {
    troops: () => 100,
    numTilesOwned: () => tiles,
    sharesBorderWith: () => true,
    isFriendly: () => false,
  },
  game: { config: () => ({ maxTroops: () => 200 }), numLandTiles: () => 100 },
  currentAttackDecisionTick: () => tick,
  incomingHostileAttackPressure: () => 0,
  getEarlyGameSpendableTroops: () => 50,
  getPlayerAttackPreferredTroopFloor: () => 40,
  getCommittedOutboundAttackTroopsForTarget: (target) =>
    commitments.some((entry) => entry.target === target) ? 40 : 0,
  getLiveOutboundAttackTroopsForTarget: (target) =>
    commitments.some((entry) => entry.target === target && !entry.pending) ? 40 : 0,
  outboundPlayerAttackCommitments: () => ({
    targetsByKey: new Map(commitments.map((entry) => [entry.targetKey, entry.target])),
    committedByKey: new Map(commitments.map((entry) => [entry.targetKey, 40])),
  }),
  getOutboundTargetCommitmentSnapshot: () => commitments,
  getOutboundAttackSnapshot: () =>
    commitments
      .filter((entry) => !entry.pending)
      .map((entry) => ({ ...entry, id: "land-1", troops: 40 })),
  getOutboundTransportSnapshot: () => transports,
  outboundTransportTargets: new Map(),
  botAttackPendingIntentCommitments: [],
  botPendingDonationIntentCommitments: [],
  getEarlyGameLiveReserveTroops: () => 50,
  getOutboundAttackTargetKey: (target) => String(target.smallID()),
  canAttackPlayerNow: () => true,
  sendAttack: async () => {
    emitted++;
    return true;
  },
};
const shadow = new Policy({ storage: null });
assert.equal(await shadow.decide(behavior, [a, b]), false);
assert.equal(emitted, 0, "shadow never emits or suppresses the original pipeline");
const observation = shadow.actionObservation(behavior, a);
shadow.recordAction(behavior, a, observation);
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
tick++;
tiles = 20;
shadow.observe(behavior);
assert.equal(
  shadow.diagnostics().samples.act,
  0,
  "an active commitment has no completed outcome yet",
);
commitments = [];
shadow.observe(behavior);
assert.equal(shadow.diagnostics().samples.act, 1);
assert.ok(
  shadow.predict("act", observation.gate) > 0,
  "land growth is attributed to the accepted action",
);
shadow.observe(behavior);
assert.equal(shadow.diagnostics().samples.act, 1, "outcome is consumed once");
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
assert.equal(
  shadow.actionObservation(behavior, a),
  null,
  "an old attack cannot confirm a new land intent",
);
commitments = [];
behavior.outboundTransportTargets.set("boat-1", a);
transports = [{ id: "boat-1", troops: 40, targetTile: 99 }];
assert.equal(
  shadow.actionObservation(behavior, a),
  null,
  "a transport to the same target makes the new receipt ambiguous",
);
transports = [];
const staleObservation = shadow.actionObservation(behavior, a);
shadow.configure({ mode: "shadow" });
shadow.recordAction(behavior, a, staleObservation);
assert.equal(shadow.pending, null, "configuration changes invalidate in-flight observations");
const staleSession = shadow.actionObservation(behavior, a);
shadow.beginSession();
shadow.recordAction(behavior, a, staleSession);
assert.equal(shadow.pending, null, "match reset invalidates in-flight observations");
shadow.recordAction(behavior, b);
tick++;
shadow.observe(behavior);
assert.equal(
  shadow.diagnostics().samples.act,
  1,
  "unconfirmed intent cannot become a successful training example",
);
assert.equal(shadow.diagnostics().unconfirmed, 1);
shadow.recordAction(behavior, a);
shadow.beginSession();
tick++;
shadow.observe(behavior);
assert.equal(shadow.diagnostics().samples.act, 1, "a new match discards unfinished observations");
const controlled = new Policy({ storage: null });
const gate = controlled.gateFeatures(behavior);
for (let i = 0; i < 20; i++) {
  controlled.learn("wait", gate, 0);
  controlled.learn("act", gate, 0.2);
  controlled.learn("target", controlled.targetFeatures(behavior, a, gate), 0.1);
  controlled.learn("target", controlled.targetFeatures(behavior, b, gate), 0.3);
}
controlled.configure({ mode: "learned", learning: false });
await controlled.decide(behavior, [a, b]);
const preferred = controlled.diagnostics().proposal.target;
await controlled.decide(behavior, [b, a]);
assert.equal(
  controlled.diagnostics().proposal.target,
  preferred,
  "candidate order does not change identity-based ranking",
);
const interrupted = new Policy({ storage: null });
interrupted.importModel(controlled.exportModel());
interrupted.configure({ mode: "learned", learning: false });
const sentAfterReset = [];
await interrupted.decide(
  {
    ...behavior,
    sendAttack: async (target) => {
      sentAfterReset.push(target.smallID());
      interrupted.configure({ mode: "baseline" });
      return false;
    },
  },
  [a, b],
);
assert.equal(sentAfterReset.length, 1, "a changed configuration aborts the old ranked loop");
const reinforcement = new Policy({ storage: null });
await reinforcement.decide(behavior, [a]);
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
assert.equal(reinforcement.actionObservation(behavior, a), null);
reinforcement.recordAcceptedAction(behavior, a, null, reinforcement.generation);
tick++;
reinforcement.observe(behavior);
assert.equal(
  reinforcement.diagnostics().samples.wait,
  0,
  "unlabeled reinforcement cannot teach waiting",
);
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
assert.equal(
  controlled.allowsAttack(behavior, b),
  false,
  "active strategic commitments block a second ordinary war",
);
commitments[0].pending = true;
behavior.botAttackPendingIntentCommitments = [{ ...commitments[0], troops: 40 }];
assert.equal(
  controlled.allowsAttack(behavior, b),
  false,
  "accepted pending intents reserve the war before AttackView appears",
);
assert.equal(
  controlled.allowsAttack(behavior, a),
  true,
  "the active target can receive reinforcement",
);
commitments = [];
behavior.botAttackPendingIntentCommitments = [];
assert.equal(
  controlled.allowsAttack(behavior, b),
  true,
  "completed commitment releases the war target",
);
controlled.configure({ mode: "baseline" });
await controlled.decide(behavior, [a]);
assert.equal(controlled.diagnostics().mode, "baseline");
const tribeOnly = new Policy({ storage: null });
const tribe = { ...enemy(99), type: () => "BOT" };
await tribeOnly.decide(behavior, [tribe]);
assert.equal(
  tribeOnly.diagnostics().decisions,
  0,
  "native BOT enum is excluded from strategic learned combat",
);
assert.equal(tribeOnly.actionObservation(behavior, tribe), null);
controlled.configure({ mode: "learned", learning: false });
const waitModel = controlled.exportModel();
waitModel.models.wait.weights = [1, 0, 0, 0];
waitModel.models.act.weights = [0, 0, 0, 0];
controlled.importModel(waitModel);
const emittedBeforeWait = emitted;
assert.equal(
  await controlled.decide(
    behavior,
    Array.from({ length: 32 }, (_, i) => enemy(i + 10)),
  ),
  true,
);
assert.equal(
  emitted,
  emittedBeforeWait,
  "wait stays outside the candidate list even with more than sixteen rivals",
);
assert.equal(
  await controlled.decide(behavior, []),
  false,
  "no legal strategic target preserves Legendary's remaining lanes",
);
const faithful = sandbox.state.settings.winFixes;
sandbox.state.settings.winFixes = false;
assert.equal(
  await controlled.decide(behavior, [a]),
  false,
  "the faithful port disables hybrid decisions",
);
sandbox.state.settings.winFixes = faithful;
process.stdout.write("hybrid combat learning tests passed\n");
