import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const unsafeScores = learner.exportModel();
unsafeScores.models.wait.weights = Array(4).fill(Number.MAX_VALUE);
const importGeneration = frozen.generation;
assert.throws(
  () => frozen.importModel(unsafeScores),
  /Unsafe hybrid combat weights/,
  "finite imported weights must not overflow bounded predictions",
);
assert.equal(JSON.stringify(frozen.exportModel()), before, "unsafe import is atomic");
assert.equal(
  frozen.generation,
  importGeneration,
  "rejected import keeps the observation generation",
);
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
const unstable = new Policy({ storage: null });
const unstableModel = unstable.exportModel();
for (const entry of Object.values(unstableModel.models)) entry.samples = entry.weights.length;
unstableModel.models.wait.weights[0] = 1e308;
unstableModel.models.wait.inverse[0][0] = 1e-20;
unstableModel.models.wait.inverse[1][1] = 1e20;
unstable.importModel(unstableModel);
const stableSnapshot = JSON.stringify(unstable.exportModel());
unstable.learn("wait", [1, 1e-10, 0, 0], 0);
assert.equal(
  JSON.stringify(unstable.exportModel()),
  stableSnapshot,
  "a nonfinite update preserves weights, covariance and sample counts atomically",
);
assert.match(unstable.diagnostics().error, /Nonfinite hybrid combat update/);
unstable.configure({ mode: "learned", learning: false });
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
assert.equal(
  unstable.allowsAttack(behavior, b),
  true,
  "numeric fallback releases learned coordination",
);
commitments = [];
const emittedBeforeFault = emitted;
assert.equal(
  await unstable.decide(behavior, [a, b]),
  false,
  "numeric failure returns control to Legendary",
);
assert.equal(emitted, emittedBeforeFault, "numeric fallback emits no learned action");
assert.match(
  unstable.diagnostics().error,
  /Nonfinite/,
  "persistence cannot hide the numerical fault",
);
unstable.importModel(learner.exportModel());
assert.equal(unstable.diagnostics().error, null, "a valid replacement clears the numerical fault");
let covarianceWrites = 0;
const singular = new Policy({
  storage: {
    getItem: () => null,
    setItem() {
      covarianceWrites++;
    },
  },
});
const singularModel = singular.exportModel();
for (const entry of Object.values(singularModel.models)) entry.samples = entry.weights.length;
singularModel.models.wait.inverse[0][0] = 1e20;
singular.importModel(singularModel);
const beforeSingularUpdate = JSON.stringify(singular.exportModel());
const beforeSingularWrites = covarianceWrites;
singular.learn("wait", [1, 0, 0, 0], 0.5);
assert.equal(
  JSON.stringify(singular.exportModel()),
  beforeSingularUpdate,
  "finite cancellation to singular covariance must preserve the entire model",
);
assert.equal(
  covarianceWrites,
  beforeSingularWrites,
  "invalid covariance must not reach persistence",
);
assert.match(singular.diagnostics().error, /Invalid hybrid combat covariance/);
singular.configure({ mode: "learned", learning: false });
assert.equal(
  await singular.decide(behavior, [a]),
  false,
  "singular covariance exposes Legendary fallback",
);
const covarianceValidator = vm.runInContext("validateHybridCombatCovariance", sandbox);
const unexpectedCovariance = new Policy({ storage: null });
const beforeUnexpectedCovariance = JSON.stringify(unexpectedCovariance.exportModel());
vm.runInContext(
  "validateHybridCombatCovariance = () => { throw new Error('unexpected covariance fault'); };",
  sandbox,
);
try {
  assert.throws(
    () => unexpectedCovariance.learn("wait", [1, 0, 0, 0], 0.5),
    /unexpected covariance fault/,
    "only the expected covariance validation error is caught",
  );
  assert.equal(JSON.stringify(unexpectedCovariance.exportModel()), beforeUnexpectedCovariance);
  assert.equal(unexpectedCovariance.diagnostics().error, null);
} finally {
  sandbox.restoreCovarianceValidator = covarianceValidator;
  vm.runInContext("validateHybridCombatCovariance = restoreCovarianceValidator;", sandbox);
  delete sandbox.restoreCovarianceValidator;
}
const predictionFault = new Policy({ storage: null });
predictionFault.models.wait.weights = Array(4).fill(Number.MAX_VALUE);
assert.equal(predictionFault.predict("wait", [1, 0.5, 0.2, 0]), null);
assert.match(predictionFault.diagnostics().error, /Nonfinite hybrid combat prediction/);
assert.throws(() => predictionFault.predict("missing", [1]), /Invalid hybrid combat features/);
const unexpected = new Policy({ storage: null });
await assert.rejects(
  unexpected.decide(
    {
      ...behavior,
      canAttackPlayerNow() {
        throw new Error("unexpected adapter fault");
      },
    },
    [a],
  ),
  /unexpected adapter fault/,
  "fallback must not intercept unrelated runtime errors",
);
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
// Import the real adapter method without constructing a bundled bot or running a match.
const root = fileURLToPath(new URL("../", import.meta.url));
const bridge = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
  import assert from 'node:assert/strict';
  const { BundledOpponentBot } = await import('./scripts/headless/opponent-adapter.js');
  const method = BundledOpponentBot.prototype.finalizeHybridCombatObservation;
  assert.equal(typeof method, 'function', 'the harness needs an observation-only terminal bridge');
  process.stdout.write(method.toString());
`,
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, TSX_TSCONFIG_PATH: `${root}openfront-engine/tsconfig.json` },
  },
);
assert.equal(bridge.status, 0, bridge.stderr);
const finalize = vm.runInContext(`({ ${bridge.stdout} }).finalizeHybridCombatObservation`, sandbox);
vm.runInContext(
  fs.readFileSync(new URL("../engine/ingame/auto-bot/nationExecution.js", import.meta.url), "utf8"),
  sandbox,
);
const nation = vm.runInContext("Object.create(NationBot.prototype)", sandbox);
const terminalPolicy = vm.runInContext("hybridCombatPolicy", sandbox);
const emptyModel = new Policy({ storage: null }).exportModel();
const originalPlayer = behavior.player;
let alive = true;
let winner = null;
behavior.player = { ...originalPlayer, isAlive: () => alive };
nation.attackBehavior = behavior;
nation.behaviorsInitialized = true;
nation.mg = { getWinner: () => winner };
const terminalBot = {
  nationBot: nation,
  game: nation.mg,
  pageGame: { myPlayer: () => behavior.player },
  decide() {
    throw new Error("finalization must not emit actions");
  },
};
for (const testCase of [
  { reason: "winner", winner: "our-team", alive: true, confirmed: true, learning: true },
  { reason: "bot_dead", winner: null, alive: false, confirmed: true, learning: true },
  { reason: "winner", winner: "our-team", alive: true, confirmed: false, learning: true },
  { reason: "winner", winner: "our-team", alive: true, confirmed: true, learning: false },
  { reason: "max_ticks", winner: null, alive: true, confirmed: true, learning: true },
]) {
  terminalPolicy.importModel(emptyModel);
  terminalPolicy.configure({ mode: "shadow", learning: testCase.learning });
  terminalPolicy.beginSession();
  commitments = [];
  alive = true;
  tiles = 20;
  tick++;
  terminalPolicy.recordAction(behavior, a);
  if (testCase.confirmed) {
    commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
    tick++;
    terminalPolicy.observe(behavior);
  }
  winner = testCase.winner;
  alive = testCase.alive;
  tiles = alive ? 30 : 0;
  tick++;
  const modelBeforeFinal = JSON.stringify(terminalPolicy.exportModel());
  const emittedBeforeFinal = emitted;
  finalize.call(terminalBot, testCase.reason);
  const terminal = testCase.reason !== "max_ticks";
  assert.equal(
    terminalPolicy.diagnostics().samples.act,
    Number(terminal && testCase.confirmed && testCase.learning),
  );
  assert.equal(
    terminalPolicy.diagnostics().samples.target,
    Number(terminal && testCase.confirmed && testCase.learning),
  );
  assert.equal(terminalPolicy.diagnostics().unconfirmed, Number(terminal && !testCase.confirmed));
  assert.equal(Boolean(terminalPolicy.pending), !terminal, "horizons leave open attacks censored");
  assert.equal(emitted, emittedBeforeFinal);
  if (!testCase.learning || !terminal) {
    assert.equal(JSON.stringify(terminalPolicy.exportModel()), modelBeforeFinal);
  }
  const afterFinal = JSON.stringify(terminalPolicy.exportModel());
  finalize.call(terminalBot, testCase.reason);
  assert.equal(
    JSON.stringify(terminalPolicy.exportModel()),
    afterFinal,
    "terminal outcome is consumed once",
  );
}
terminalPolicy.importModel(emptyModel);
terminalPolicy.configure({ mode: "shadow", learning: true });
terminalPolicy.beginSession();
commitments = [];
alive = true;
winner = null;
tiles = 20;
tick++;
assert.equal(await terminalPolicy.decide(behavior, [a]), false);
const emittedBeforeWaitFinal = emitted;
winner = "our-team";
tiles = 30;
tick++;
finalize.call(terminalBot, "winner");
assert.equal(
  terminalPolicy.diagnostics().samples.wait,
  1,
  "terminal waits reuse the existing reward",
);
assert.equal(terminalPolicy.diagnostics().samples.act, 0);
assert.equal(terminalPolicy.pending, null);
assert.equal(emitted, emittedBeforeWaitFinal);
behavior.player = originalPlayer;
commitments = [];
const runnerSource = fs.readFileSync(
  new URL("../scripts/headless/run-match.mts", import.meta.url),
  "utf8",
);
const finalizationIndex = runnerSource.indexOf("bot.finalizeHybridCombatObservation(stopReason);");
assert.ok(
  finalizationIndex >= 0 && finalizationIndex < runnerSource.indexOf("const finalResult ="),
  "terminal finalization must run before the harness result snapshot",
);
process.stdout.write("hybrid combat learning tests passed\n");
