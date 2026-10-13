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
vm.runInContext(
  fs.readFileSync(
    new URL("../engine/ingame/auto-bot/hybridModelContract.js", import.meta.url),
    "utf8",
  ),
  sandbox,
);
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
  canFundLandAttack: () => true,
  sendAttack: async () => {
    emitted++;
    return true;
  },
};
const fundedPolicy = new Policy({ storage: null });
const fundedBehavior = { ...behavior, canFundLandAttack: (target) => target.smallID() === 3 };
assert.deepEqual(
  Array.from(fundedPolicy.legalCandidates(fundedBehavior, [a, b], [1, 0.5, 0.1, 0]), ({ target }) =>
    target.smallID(),
  ),
  [3],
  "unfunded targets never compete with affordable attacks or teach forced waiting",
);
assert.equal(
  fundedPolicy.legalCandidates({ ...behavior, canFundLandAttack: undefined }, [a], [1, 0.5, 0.1, 0])
    .length,
  0,
  "unknown funding cannot authorize a learned candidate",
);
{
  const policy = new Policy({ storage: null });
  let attacks = [{ target: a, targetKey: "2", id: "old-attack", troops: 40 }];
  let ships = [];
  const reinforcementBehavior = {
    ...behavior,
    getOutboundAttackSnapshot: () => attacks,
    getOutboundTransportSnapshot: () => ships,
    outboundTransportTargets: new Map(),
    botAttackPendingIntentCommitments: [],
  };
  const observation = policy.actionObservation(reinforcementBehavior, a);
  assert.ok(observation, "a visible prior attack does not hide an observable reinforcement");
  assert.deepEqual(Array.from(observation.attackIds), ["old-attack"]);
  assert.equal(observation.preexistingCommitmentTroops, 40);
  policy.recordAcceptedAction(reinforcementBehavior, a, observation, policy.generation);
  tick++;
  policy.observe(reinforcementBehavior);
  assert.equal(
    Boolean(policy.pending.confirmed),
    false,
    "the existing ID is excluded from confirmation",
  );
  assert.equal(
    policy.diagnostics().lastOutcome,
    null,
    "the old receipt cannot confirm the new intent",
  );
  attacks = [{ target: a, targetKey: "2", id: "replacement-attack", troops: 60 }];
  tick++;
  policy.observe(reinforcementBehavior);
  assert.equal(policy.pending.receiptID, "replacement-attack");
  assert.equal(
    policy.diagnostics().samples.act,
    0,
    "a live remaining commitment has no outcome yet",
  );
  attacks = [];
  tick++;
  tiles = 12;
  policy.observe(reinforcementBehavior);
  assert.equal(policy.diagnostics().lastOutcome.receiptID, "replacement-attack");
  assert.equal(policy.diagnostics().lastOutcome.preexistingCommitmentTroops, 40);
  assert.equal(policy.diagnostics().lastOutcome.commitmentScope, "remaining-target-commitment");
  assert.equal(policy.diagnostics().lastOutcome.reward, 12 / 100 - 10 / 100);
  assert.equal(policy.diagnostics().samples.act, 1);
  assert.equal(policy.diagnostics().samples.target, 1);

  attacks = [{ target: a, targetKey: "2", id: "old-attack", troops: 40 }];
  reinforcementBehavior.botAttackPendingIntentCommitments = [
    { target: a, targetKey: "2", troops: 20 },
  ];
  assert.equal(
    policy.actionObservation(reinforcementBehavior, a),
    null,
    "pending troops remain unattributed",
  );
  reinforcementBehavior.botAttackPendingIntentCommitments = [];
  ships = [{ id: "boat", troops: 20 }];
  reinforcementBehavior.outboundTransportTargets.set("boat", a);
  assert.equal(
    policy.actionObservation(reinforcementBehavior, a),
    null,
    "in-flight boats remain unattributed",
  );
  ships = [];
  attacks = [{ target: a, targetKey: "2", troops: 40 }];
  assert.equal(
    policy.actionObservation(reinforcementBehavior, a),
    null,
    "an ID-less commitment is not a receipt",
  );
  attacks = [{ target: a, targetKey: "2", id: {}, troops: 40 }];
  assert.equal(
    policy.actionObservation(reinforcementBehavior, a),
    null,
    "an object coerced to a string is not a native attack ID",
  );
  attacks = [
    { target: a, targetKey: "2", id: "duplicate", troops: 20 },
    { target: a, targetKey: "2", id: "duplicate", troops: 20 },
  ];
  assert.equal(
    policy.actionObservation(reinforcementBehavior, a),
    null,
    "duplicate receipt IDs cannot establish coverage",
  );
  tick = 10;
  tiles = 10;
}
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
const reinforcementObservation = shadow.actionObservation(behavior, a);
assert.ok(reinforcementObservation);
shadow.recordAcceptedAction(behavior, a, reinforcementObservation, shadow.generation);
tick++;
shadow.observe(behavior);
assert.equal(
  Boolean(shadow.pending.confirmed),
  false,
  "an old attack cannot confirm a new land intent",
);
commitments = [];
shadow.observe(behavior);
assert.equal(shadow.diagnostics().lastOutcome.confirmed, false);
assert.equal(
  shadow.diagnostics().samples.act,
  1,
  "an unconfirmed reinforcement cannot train an action",
);
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
behavior.botAttackPendingIntentCommitments = [{ ...commitments[0], troops: 40 }];
assert.equal(reinforcement.actionObservation(behavior, a), null);
reinforcement.recordAcceptedAction(behavior, a, null, reinforcement.generation);
tick++;
reinforcement.observe(behavior);
assert.equal(
  reinforcement.diagnostics().samples.wait,
  0,
  "unlabeled reinforcement cannot teach waiting",
);
behavior.botAttackPendingIntentCommitments = [];
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
// Task 1: an explicit neural schema must coexist with unchanged Ridge v1.
assert.equal(
  typeof api.resetEpisode,
  "function",
  "public episode reset is part of the runtime contract",
);
assert.equal(typeof api.createCompactModel, "function", "neural initialization is explicit");
const Contract = vm.runInContext("HybridCombatContract", sandbox);
const neural = new Policy({ storage: null, ledgerCapacity: 3 });
const ridgeBytes = JSON.stringify(neural.exportModel());
const compact = api.createCompactModel();
assert.equal(compact.schema, "ofh-combat-compact-tanh-v2");
assert.equal(compact.models.target.hidden.length, 13);
neural.importModel(compact);
assert.equal(neural.diagnostics().backend, "compact-tanh-v1");
assert.equal(neural.diagnostics().ready, false);
neural.configure({ mode: "learned" });
assert.equal(neural.diagnostics().eligible, false, "cold models are not eligible for control");
assert.equal(await neural.decide(behavior, [a]), false);
assert.equal(neural.diagnostics().control.fallbacks, 1);
const neuralBehavior = {
  ...behavior,
  hybridCombatGeometry: (target) => ({
    targetSmallID: target.smallID(),
    tick,
    source: "native-border-centroid-v1",
    own: { x: 0, y: 0 },
    target: { x: 60, y: 80 },
    width: 100,
    height: 100,
  }),
};
const neuralGate = neural.gateFeatures(neuralBehavior);
const neuralTarget = neural.targetFeatures(neuralBehavior, a, neuralGate);
assert.equal(neuralTarget.length, 13);
assert.equal(neuralTarget[9], 0.6);
assert.equal(
  neural.targetFeatures(behavior, a, neuralGate),
  null,
  "absent native geometry abstains",
);
assert.equal(
  neural.targetFeatures(
    {
      ...neuralBehavior,
      hybridCombatGeometry: () => ({
        targetSmallID: b.smallID(),
        tick,
        source: "native-border-centroid-v1",
        own: { x: 0, y: 0 },
        target: { x: 1, y: 1 },
        width: 100,
        height: 100,
      }),
    },
    a,
    neuralGate,
  ),
  null,
  "geometry cannot alias a different exact target ID",
);
assert.equal(
  Contract.geometry(
    {
      targetSmallID: 2,
      tick,
      source: "native-border-centroid-v1",
      own: { x: NaN, y: 0 },
      target: { x: 1, y: 1 },
      width: 100,
      height: 100,
    },
    2,
    tick,
  ),
  null,
);
const unseenInput = [1, 0.7, 0.2, 0.1];
const predictionBefore = neural.predict("act", neuralGate);
for (let i = 0; i < 30; i++) {
  neural.learn("wait", neuralGate, -0.2);
  neural.learn("act", neuralGate, 0.4);
  neural.learn("target", neuralTarget, 0.3);
}
assert.ok(
  neural.predict("act", neuralGate) > predictionBefore,
  "actual neural inference learns outcomes",
);
assert.ok(
  neural.predict("act", unseenInput) > 0,
  "trained network runs inference on another input",
);
assert.ok(
  neural
    .exportModel()
    .models.act.hidden.some((row, i) => row.some((value, j) => value !== Number(i === j))),
  "hidden weights actually train",
);
assert.equal(neural.diagnostics().ready, true);
neural.configure({ mode: "learned", learning: false });
assert.equal(neural.diagnostics().eligible, true);
const neuralFrozen = JSON.stringify(neural.exportModel());
neural.learn("act", neuralGate, -0.8);
assert.equal(
  JSON.stringify(neural.exportModel()),
  neuralFrozen,
  "weights, normalizer and provenance freeze together",
);
const changedContract = neural.exportModel();
changedContract.architecture.initialStep = "arbitrary";
const generationBeforeReject = neural.generation;
assert.throws(() => neural.importModel(changedContract), /contract/);
assert.equal(JSON.stringify(neural.exportModel()), neuralFrozen);
assert.equal(neural.generation, generationBeforeReject);
const invalidNormalizer = neural.exportModel();
invalidNormalizer.normalizer.target.scale[0] = 0;
assert.throws(() => neural.importModel(invalidNormalizer), /normalizer/);
const invalidHead = neural.exportModel();
invalidHead.models.act.output[0] = Infinity;
assert.throws(() => neural.importModel(invalidHead), /neural head/);
assert.equal(JSON.stringify(neural.exportModel()), neuralFrozen);
const beforeMacro = neural.scoreMacro(neuralGate);
assert.equal(typeof beforeMacro.wait, "number");
assert.deepEqual(
  JSON.stringify(neural.scoreMacro(neuralGate)),
  JSON.stringify(beforeMacro),
  "WAIT has no dependency on target list size",
);
const manyTargets = Array.from({ length: 128 }, (_, i) => enemy(100 + i));
const micro = manyTargets.map((target) => ({
  target,
  features: neural.targetFeatures(neuralBehavior, target, neuralGate),
}));
assert.equal(neural.scoreMicro(micro).length, 128, "target ranking has no fixed opponent slots");
assert.equal(
  neural.scoreMicro([...micro].reverse())[0].target.smallID(),
  neural.scoreMicro(micro)[0].target.smallID(),
);
assert.deepEqual(JSON.stringify(neural.scoreMacro(neuralGate)), JSON.stringify(beforeMacro));
const episodeBefore = neural.diagnostics().episodeId;
neural.resetEpisode();
assert.equal(neural.diagnostics().episodeId, episodeBefore + 1);
assert.equal(JSON.stringify(neural.exportModel()), neuralFrozen);
assert.equal(neural.exportLedger().entries.length, 0);
assert.equal(neural.diagnostics().control.confirmedLearnedAttacks, 0);
await neural.decide(neuralBehavior, [a]);
const proposal = neural.diagnostics().proposal;
assert.equal(proposal.episodeId, neural.diagnostics().episodeId);
assert.equal(proposal.generation, neural.generation);
assert.equal(proposal.tick, tick);
assert.equal(proposal.targetSmallID, 2);
// Accepted callback, not a model proposal, owns the acceptance counter.
const accepted = new Policy({ storage: null, ledgerCapacity: 3 });
accepted.importModel(neural.exportModel());
accepted.configure({ mode: "learned", learning: false });
const callbackBehavior = {
  ...neuralBehavior,
  sendAttack: async (target) => {
    const captured = accepted.actionObservation(callbackBehavior, target);
    accepted.recordAcceptedAction(callbackBehavior, target, captured, accepted.generation);
    return true;
  },
};
accepted.resetEpisode();
await accepted.decide(callbackBehavior, [a]);
assert.equal(accepted.diagnostics().control.acceptedLearnedAttacks, 1);
assert.equal(accepted.diagnostics().control.confirmedLearnedAttacks, 0);
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
tick++;
accepted.observe(callbackBehavior);
accepted.observe(callbackBehavior);
assert.equal(
  accepted.diagnostics().control.confirmedLearnedAttacks,
  1,
  "only a new observed ID confirms, exactly once",
);
commitments = [];
accepted.observe(callbackBehavior);
assert.equal(accepted.exportLedger().entries.at(-1).kind, "outcome");
assert.equal(accepted.exportLedger().entries.at(-1).confirmed, true);
assert.ok(accepted.exportLedger().dropped > 0, "bounded ledger reports dropped raw events");
assert.equal(accepted.exportLedger().entries.length, 3);
assert.equal(
  accepted.exportLedger().complete,
  false,
  "bounded memory is never advertised as a full dataset",
);
const retired = accepted.actionObservation(callbackBehavior, a);
const retiredGeneration = accepted.generation;
accepted.resetEpisode();
accepted.recordAcceptedAction(callbackBehavior, a, retired, retiredGeneration);
assert.equal(accepted.pending, null);
assert.equal(accepted.diagnostics().control.acceptedLearnedAttacks, 0);
// Legacy schema and storage survive explicit backend selection and roundtrip.
const preserved = new Map();
const storagePolicy = new Policy({
  storage: {
    getItem: (key) => preserved.get(key) ?? null,
    setItem: (key, value) => preserved.set(key, value),
  },
});
storagePolicy.configure({ mode: "shadow" });
const storedV1 = preserved.get("openfront-helper-hybrid-combat-v1");
storagePolicy.importModel(compact);
assert.equal(preserved.get("openfront-helper-hybrid-combat-v1"), storedV1);
assert.ok(preserved.get("openfront-helper-hybrid-combat-v2"));
storagePolicy.importModel(JSON.parse(ridgeBytes));
assert.equal(JSON.stringify(storagePolicy.exportModel()), ridgeBytes);
assert.equal(storagePolicy.diagnostics().backend, "ridge-v1");
// Offline raw patient anchors and PBRS are opt-in, versioned and censored safely.
const transition = {
  raw: neuralGate,
  nextRaw: neuralGate,
  reward: 0.1,
  gammaTick: 0.9,
  actionTick: 0,
  outcomeTick: 1,
  potential: 0.2,
  nextPotential: 0.3,
  advantage: 0.4,
  action: "wait",
  ablation: { version: "patient-potential-v1", patientAnchors: false, potentialShaping: false },
};
const offline = Contract.offlineTransition(transition);
assert.equal(offline.anchor, false);
assert.equal(offline.shaped, 0.1);
const arm = {
  ...transition,
  ablation: { ...transition.ablation, patientAnchors: true, potentialShaping: true },
};
assert.equal(Contract.offlineTransition(arm).anchor, true);
assert.ok(Math.abs(Contract.offlineTransition(arm).shaped - 0.17) < 1e-12);
assert.equal(Contract.offlineTransition({ ...arm, advantage: 0 }).anchor, false);
assert.equal(Contract.offlineTransition({ ...arm, terminal: true }).nextPotential, 0);
assert.equal(Contract.offlineTransition({ ...arm, truncated: true }), null);
assert.throws(() => Contract.offlineTransition({ ...arm, gammaTick: NaN }), /temporal/);
assert.equal(
  JSON.stringify(neural.exportModel()),
  neuralFrozen,
  "offline ablations do not change live policy",
);
// Standalone evaluators keep Ridge v1 working without loading the neural helper.
const standalone = {
  window: { localStorage: null },
  state: sandbox.state,
  PlayerType: sandbox.PlayerType,
};
vm.createContext(standalone);
vm.runInContext(fs.readFileSync(file, "utf8"), standalone);
standalone.window.__OFH_hybridCombat.importModel(JSON.parse(ridgeBytes));
assert.equal(JSON.stringify(standalone.window.__OFH_hybridCombat.exportModel()), ridgeBytes);
assert.throws(
  () => standalone.window.__OFH_hybridCombat.importModel(compact),
  /helper is not loaded/,
);
assert.equal(JSON.stringify(standalone.window.__OFH_hybridCombat.exportModel()), ridgeBytes);
// tanh must not conceal infinite preactivation, including normalized inputs.
const unsafeAffine = api.createCompactModel();
unsafeAffine.normalizer.kind = "fixed-affine";
unsafeAffine.normalizer.gate.scale[0] = 1e-308;
unsafeAffine.models.act.hidden[0][0] = 10;
assert.throws(() => neural.importModel(unsafeAffine), /Unsafe normalized neural weights/);
assert.equal(JSON.stringify(neural.exportModel()), neuralFrozen);
const overflowHead = api.createCompactModel().models.act;
overflowHead.hidden[0][0] = 10;
assert.equal(Contract.forward(overflowHead, [1e308, 0, 0, 0]), null);
assert.equal(Contract.update(overflowHead, [1e308, 0, 0, 0], 0.5), null);
const cancellingHead = api.createCompactModel().models.act;
cancellingHead.hidden[0] = [1e308, -1e308, 0, 0];
assert.equal(
  Contract.forward(cancellingHead, [10, 10, 0, 0]),
  null,
  "overflow cancellation is still nonfinite arithmetic",
);
assert.ok(Object.isFrozen(neural.compactContract.normalizer));
assert.ok(Object.isFrozen(neural.compactContract.provenance));
const affine = api.createCompactModel();
affine.normalizer.kind = "fixed-affine";
affine.normalizer.gate.offset[1] = 0.5;
affine.normalizer.gate.scale[1] = 0.5;
const affinePolicy = new Policy({ storage: null });
affinePolicy.importModel(affine);
assert.equal(Contract.normalize([1, 0.25, 0, 0], "act", affine.normalizer)[1], -0.5);
assert.equal(
  affinePolicy.gateFeatures({ ...behavior, incomingHostileAttackPressure: () => NaN }),
  null,
);
assert.equal(
  affinePolicy.targetFeatures(
    {
      ...neuralBehavior,
      hybridCombatGeometry: (target) => ({
        ...neuralBehavior.hybridCombatGeometry(target),
        tick: tick - 1,
      }),
    },
    a,
    neuralGate,
  ),
  null,
  "native geometry cannot be carried over from an older tick",
);
// Counter rows represent real control, with no probability/entropy claims.
accepted.resetEpisode();
const positiveWait = accepted.exportModel();
positiveWait.models.wait.outputBias = 1;
positiveWait.models.act.outputBias = -1;
accepted.importModel(positiveWait);
const emitBeforeControlledWait = emitted;
assert.equal(await accepted.decide(callbackBehavior, manyTargets), true);
assert.equal(accepted.diagnostics().control.controlledWaits, 1);
assert.equal(accepted.diagnostics().control.acceptedLearnedAttacks, 0);
assert.equal(emitted, emitBeforeControlledWait);
const decision = accepted.exportLedger().entries.at(-1);
assert.equal(decision.kind, "decision");
assert.equal(decision.controlledAction, "wait");
assert.equal(decision.candidateCount, 128);
assert.equal(
  decision.candidates.length,
  128,
  "the scored native candidate set is recorded without slot truncation",
);
assert.equal(decision.candidateCoverage.complete, true);
assert.equal(decision.candidateCoverage.truncated, false);
assert.equal(new Set(decision.candidates.map((row) => row.targetSmallID)).size, 128);
assert.ok(decision.candidates.every((row) => row.features.length === 13 && row.geometry !== null));
assert.equal(decision.behaviorProbability, null);
assert.equal(decision.logProbability, null);
assert.equal(accepted.pending.decisionStep, decision.step);
assert.equal(decision.reserveRatio, 0.5);
assert.ok(decision.utilityMargin < 0);
assert.equal(decision.fallback, false);
assert.equal(decision.step, 0);
const decisionCopy = accepted.diagnostics().proposal;
decisionCopy.targetSmallID = 999;
assert.equal(
  accepted.diagnostics().proposal.targetSmallID,
  null,
  "diagnostics cannot rewrite proposal identity",
);
assert.equal(await accepted.decide(callbackBehavior, []), false);
assert.equal(
  accepted.diagnostics().control.controlledWaits,
  1,
  "forced waiting does not count as learned waiting",
);
assert.equal(accepted.diagnostics().control.fallbacks, 1);
assert.equal(accepted.exportLedger().entries.at(-1).controlledAction, null);
// Pure fit is connected to raw ledger-shaped records and returns a separate model.
const offlineBase = api.createCompactModel();
const replayContext = {
  engineRevision: "a".repeat(40),
  experimentID: "task1-fixture",
  generation: 7,
  episodeId: 2,
  maxRecords: 2,
  normalizer: offlineBase.normalizer,
  ablation: { version: "patient-potential-v1", patientAnchors: true, potentialShaping: false },
};
const rawReplay = {
  featureVersion: offlineBase.schema,
  generation: 7,
  episodeId: 2,
  engineRevision: replayContext.engineRevision,
  experimentID: replayContext.experimentID,
  normalizer: offlineBase.normalizer,
  modelIdentity: JSON.stringify(offlineBase),
  gate: neuralGate,
  nextGate: neuralGate,
  action: "wait",
  targetSmallID: null,
  reward: 0.2,
  confirmed: true,
  terminal: false,
  truncated: false,
  actionTick: tick,
  outcomeTick: tick + 1,
};
const untouchedOffline = JSON.stringify(offlineBase);
const fit = Contract.fitOffline(
  offlineBase,
  [rawReplay, { ...rawReplay, reward: -0.2 }, rawReplay],
  replayContext,
);
assert.equal(fit.summary.fitted, 2);
assert.equal(
  fit.summary.anchors,
  1,
  "anchors require positive advantage against frozen prediction",
);
assert.equal(fit.summary.dropped, 1);
assert.equal(fit.summary.performanceClaim, false);
assert.equal(
  fit.model.models.wait.samples,
  3,
  "positive WAIT anchor adds one explicit replay pass",
);
assert.equal(
  JSON.stringify(offlineBase),
  untouchedOffline,
  "offline fit is atomic and never mutates the source model",
);
assert.throws(
  () => Contract.fitOffline(offlineBase, [{ ...rawReplay, generation: 8 }], replayContext),
  /replay record/,
);
assert.throws(
  () =>
    Contract.fitOffline(
      offlineBase,
      [{ ...rawReplay, modelIdentity: "other-model" }],
      replayContext,
    ),
  /replay record/,
);
assert.throws(
  () =>
    Contract.fitOffline(offlineBase, [rawReplay], {
      ...replayContext,
      normalizer: affine.normalizer,
    }),
  /context/,
);
const censoredFit = Contract.fitOffline(
  offlineBase,
  [{ ...rawReplay, truncated: true }],
  replayContext,
);
assert.equal(censoredFit.summary.fitted, 0);
assert.equal(censoredFit.summary.censored, 1);
const shapedFit = Contract.fitOffline(
  offlineBase,
  [{ ...rawReplay, potential: 0.1, nextPotential: 0.2 }],
  {
    ...replayContext,
    gammaTick: 0.9,
    potentialID: "own-land-share-potential-v1",
    ablation: { ...replayContext.ablation, potentialShaping: true },
  },
);
assert.equal(shapedFit.model.reward, "potential-shaped-land-delta-ticks-v2");
const shapedPolicy = new Policy({ storage: null });
shapedPolicy.importModel(shapedFit.model);
assert.equal(shapedPolicy.diagnostics().learning, false);
assert.throws(() => shapedPolicy.configure({ learning: true }), /Offline reward model/);
assert.equal(JSON.stringify(shapedPolicy.exportModel()), JSON.stringify(shapedFit.model));
// A two-head update may not publish the first head if the second rejects.
const joint = new Policy({
  storage: {
    getItem: () => null,
    setItem: () => {
      jointWrites++;
    },
  },
});
let jointWrites = 0;
const jointModel = joint.exportModel();
jointModel.models.target.inverse[0][0] = 1e20;
joint.importModel(jointModel);
const beforeJoint = JSON.stringify(joint.exportModel());
const writesBeforeJoint = jointWrites;
joint.learnOutcome({ target: a, gate: [1, 0, 0, 0], features: [1, 0, 0, 0, 0, 0, 0, 0, 0] }, 0.5);
assert.equal(JSON.stringify(joint.exportModel()), beforeJoint);
assert.equal(jointWrites, writesBeforeJoint);
assert.match(joint.diagnostics().error, /covariance/);
const inflatedSamples = api.createCompactModel();
for (const head of Object.values(inflatedSamples.models)) head.samples = 1000;
const neverTrained = new Policy({ storage: null });
neverTrained.importModel(inflatedSamples);
neverTrained.configure({ mode: "learned", learning: false });
assert.equal(
  neverTrained.diagnostics().ready,
  false,
  "sample counts alone cannot activate an initialized network",
);
assert.equal(neverTrained.diagnostics().eligible, false);
assert.equal(typeof api.rawReplay, "function");
assert.equal(typeof api.replayFit, "function");
assert.equal(api.rawReplay().fullDataset, false);
assert.equal(api.replayFit(offlineBase, [rawReplay], replayContext).summary.anchors, 1);
const fallbackRank = new Policy({ storage: null });
fallbackRank.importModel(neural.exportModel());
fallbackRank.configure({ mode: "learned", learning: false });
let rankAttempt = 0;
const rankTargets = [];
assert.equal(
  await fallbackRank.decide(
    {
      ...neuralBehavior,
      sendAttack: async (target) => {
        rankTargets.push(target.smallID());
        return ++rankAttempt === 2;
      },
    },
    [a, b],
  ),
  true,
);
assert.equal(
  fallbackRank.diagnostics().proposal.targetSmallID,
  rankTargets[1],
  "actual control row identifies the accepted fallback-ranked target",
);
assert.equal(fallbackRank.diagnostics().proposal.controlledAction, "attack");
assert.equal(fallbackRank.diagnostics().control.candidateDecisions, 1);
assert.equal(fallbackRank.diagnostics().control.acceptedLearnedAttacks, 1);
assert.equal(fallbackRank.diagnostics().control.confirmedLearnedAttacks, 0);
commitments = [{ target: a, targetKey: "2", targetIsPlayer: true }];
assert.equal(
  fallbackRank.allowsAttack(behavior, b),
  true,
  "missing neural geometry also releases coordination to the native fallback",
);
commitments = [];
// Fix round 1: preserve v1 availability and validate historical/offline seams.
const zeroRidge = new Policy({ storage: null });
const zeroRidgeModel = zeroRidge.exportModel();
for (const head of Object.values(zeroRidgeModel.models)) head.samples = head.weights.length;
zeroRidge.importModel(zeroRidgeModel);
assert.equal(
  zeroRidge.diagnostics().ready,
  true,
  "v1 coverage semantics allow valid zero-coefficient fits",
);
const tickTransition = { ...arm, reward: 0, gammaTick: 0.9, actionTick: 5, outcomeTick: 15 };
delete tickTransition.gamma;
const elapsedShaped = Contract.offlineTransition(tickTransition);
assert.ok(
  Math.abs(elapsedShaped.shaped - -0.09539646796999998) < 1e-12,
  "PBRS uses actual elapsed ticks",
);
assert.equal(elapsedShaped.deltaTicks, 10);
assert.equal(elapsedShaped.discount, 0.9 ** 10);
assert.equal(
  accepted.exportLedger().entries.at(-1).eligible,
  false,
  "no candidates were historically ineligible",
);
const eligibleRejected = new Policy({ storage: null });
eligibleRejected.importModel(neural.exportModel());
eligibleRejected.configure({ mode: "learned", learning: false });
assert.equal(
  await eligibleRejected.decide({ ...neuralBehavior, sendAttack: async () => false }, [a]),
  false,
);
const rejectedRow = eligibleRejected.exportLedger().entries.at(-1);
assert.equal(
  rejectedRow.eligible,
  true,
  "an eligible attempt remains in the denominator when its sends fail",
);
assert.equal(rejectedRow.controlledAction, null);
assert.equal(rejectedRow.fallback, true);
assert.equal(eligibleRejected.diagnostics().control.candidateDecisions, 0);
const attackReplay = {
  ...rawReplay,
  action: "attack",
  targetSmallID: a.smallID(),
  actionTick: tick,
  outcomeTick: tick + 1,
  features: neuralTarget,
  receiptID: "actual-unit-receipt",
  geometry: neuralBehavior.hybridCombatGeometry(a),
};
assert.equal(Contract.fitOffline(offlineBase, [attackReplay], replayContext).summary.fitted, 1);
assert.throws(
  () => Contract.fitOffline(offlineBase, [{ ...attackReplay, receiptID: null }], replayContext),
  /receipt/,
);
assert.throws(
  () => Contract.fitOffline(offlineBase, [{ ...attackReplay, geometry: null }], replayContext),
  /geometry/,
);
// Variable-duration PBRS and its model provenance are explicit and atomic.
for (const [actionTick, outcomeTick] of [
  [undefined, 15],
  [5, undefined],
  [5, 4],
  [5, 5.5],
  [NaN, 15],
  [0, Infinity],
]) {
  assert.throws(
    () => Contract.offlineTransition({ ...tickTransition, actionTick, outcomeTick }),
    /timing/,
  );
}
const terminalTickTransition = Contract.offlineTransition({ ...tickTransition, terminal: true });
assert.equal(terminalTickTransition.nextPotential, 0);
assert.equal(terminalTickTransition.shaped, -0.2);
assert.equal(Contract.offlineTransition({ ...tickTransition, truncated: true }), null);
assert.equal(tickTransition.reward, 0, "raw reward is never rewritten as a shaped label");
const durationContext = {
  ...replayContext,
  gammaTick: 0.9,
  potentialID: "own-land-share-potential-v1",
  ablation: { ...replayContext.ablation, patientAnchors: false, potentialShaping: true },
};
const durationRecord = {
  ...rawReplay,
  reward: 0,
  potential: 0.2,
  nextPotential: 0.3,
  actionTick: 5,
  outcomeTick: 6,
};
const oneTickFit = Contract.fitOffline(offlineBase, [durationRecord], durationContext);
const tenTickFit = Contract.fitOffline(
  offlineBase,
  [{ ...durationRecord, outcomeTick: 15 }],
  durationContext,
);
assert.ok(oneTickFit.model.models.wait.outputBias > 0);
assert.ok(
  tenTickFit.model.models.wait.outputBias < 0,
  "different actual durations train different signs",
);
assert.equal(tenTickFit.model.offline.discountContract, "elapsed-action-outcome-ticks-v1");
assert.equal(tenTickFit.model.offline.gammaTick, 0.9);
assert.equal(tenTickFit.model.offline.version, "offline-fit-ticks-v2");
assert.throws(
  () =>
    Contract.fitOffline(
      offlineBase,
      [{ ...durationRecord, outcomeTick: undefined }],
      durationContext,
    ),
  /timing/,
);
assert.throws(
  () =>
    Contract.fitOffline(offlineBase, [durationRecord], {
      ...durationContext,
      gammaTick: undefined,
      gamma: 0.9,
    }),
  /gammaTick/,
);
const beforeTemporalImport = JSON.stringify(shapedPolicy.exportModel());
const generationBeforeTemporalImport = shapedPolicy.generation;
for (const [key, value] of [
  ["discountContract", "fixed-transition"],
  ["discountContract", undefined],
  ["gammaTick", Infinity],
  ["gammaTick", undefined],
  ["potentialID", ""],
  ["version", "offline-fit-v1"],
]) {
  const forged = structuredClone(shapedFit.model);
  forged.offline[key] = value;
  assert.throws(() => shapedPolicy.importModel(forged), /offline|provenance|context/);
  assert.equal(JSON.stringify(shapedPolicy.exportModel()), beforeTemporalImport);
  assert.equal(shapedPolicy.generation, generationBeforeTemporalImport);
}
// Historical eligibility distinguishes all eligible attempts from actual control.
assert.equal(decision.eligible, true);
const historyPolicy = new Policy({ storage: null });
historyPolicy.importModel(neural.exportModel());
historyPolicy.configure({ mode: "learned", learning: false });
assert.equal(await historyPolicy.decide(behavior, [a]), false);
assert.equal(
  historyPolicy.exportLedger().entries.at(-1).eligible,
  false,
  "missing geometry is not an eligible learned attempt",
);
assert.equal(
  await historyPolicy.decide({ ...neuralBehavior, canAttackPlayerNow: () => false }, [a]),
  false,
);
assert.equal(
  historyPolicy.exportLedger().entries.at(-1).eligible,
  false,
  "forced cooldown is not eligible WAIT",
);
const coldHistory = new Policy({ storage: null });
coldHistory.importModel(offlineBase);
coldHistory.configure({ mode: "learned" });
await coldHistory.decide(neuralBehavior, [a]);
assert.equal(coldHistory.exportLedger().entries.at(-1).eligible, false);
await assert.rejects(
  () =>
    historyPolicy.decide(
      {
        ...neuralBehavior,
        incomingHostileAttackPressure: () => {
          throw new Error("unexpected gate fault");
        },
      },
      [a],
    ),
  /unexpected gate fault/,
);
assert.equal(
  historyPolicy.diagnostics().proposal.eligible,
  null,
  "eligibility remains unknown when validation never completed",
);
const cancelledHistory = new Policy({ storage: null });
cancelledHistory.importModel(neural.exportModel());
cancelledHistory.configure({ mode: "learned", learning: false });
const cancelledGeneration = cancelledHistory.generation;
const cancelledEpisode = cancelledHistory.episodeId;
const lateRows = [];
const previousRoundLog = sandbox.roundLogRecord;
sandbox.roundLogRecord = (_type, row) => lateRows.push(row);
let cancelledSends = 0;
try {
  assert.equal(
    await cancelledHistory.decide(
      {
        ...neuralBehavior,
        sendAttack: async () => {
          cancelledSends++;
          cancelledHistory.resetEpisode();
          return false;
        },
      },
      [a, b],
    ),
    false,
  );
} finally {
  if (previousRoundLog === undefined) delete sandbox.roundLogRecord;
  else sandbox.roundLogRecord = previousRoundLog;
}
assert.equal(cancelledSends, 1, "stale generation aborts remaining ranked sends");
assert.equal(
  cancelledHistory.exportLedger().entries.length,
  0,
  "late rows do not enter a new episode's bounded history",
);
const cancelledRow = lateRows.find((row) => row.kind === "hybrid-combat-decision");
assert.equal(cancelledRow.eligible, true);
assert.equal(cancelledRow.cancelled, true);
assert.equal(cancelledRow.generation, cancelledGeneration);
assert.equal(cancelledRow.episodeId, cancelledEpisode);
assert.equal(cancelledRow.controlledAction, null);
assert.equal(cancelledHistory.diagnostics().control.candidateDecisions, 0);
// Attack receipt evidence includes matching current geometry and raw feature order.
for (const receiptID of ["", " ", false, 123]) {
  assert.throws(
    () => Contract.fitOffline(offlineBase, [{ ...attackReplay, receiptID }], replayContext),
    /receipt/,
  );
}
assert.throws(
  () =>
    Contract.fitOffline(
      offlineBase,
      [
        {
          ...attackReplay,
          geometry: {
            ...attackReplay.geometry,
            targetSmallID: b.smallID(),
          },
        },
      ],
      replayContext,
    ),
  /geometry/,
);
assert.throws(
  () =>
    Contract.fitOffline(
      offlineBase,
      [
        {
          ...attackReplay,
          geometry: {
            ...attackReplay.geometry,
            tick: attackReplay.actionTick - 1,
          },
        },
      ],
      replayContext,
    ),
  /geometry/,
);
const mismatchedGeometryFeatures = [...attackReplay.features];
mismatchedGeometryFeatures[9] = 0;
assert.throws(
  () =>
    Contract.fitOffline(
      offlineBase,
      [{ ...attackReplay, features: mismatchedGeometryFeatures }],
      replayContext,
    ),
  /disagree/,
);
const mismatchedGateFeatures = [...attackReplay.features];
mismatchedGateFeatures[1] = 0;
assert.throws(
  () =>
    Contract.fitOffline(
      offlineBase,
      [{ ...attackReplay, features: mismatchedGateFeatures }],
      replayContext,
    ),
  /disagree/,
);
assert.equal(JSON.stringify(offlineBase), untouchedOffline);
for (const suite of [
  "hybrid-combat-funnel",
  "hybrid-combat-frontier",
  "hybrid-frontier-contract",
  "hybrid-model-selection",
  "hybrid-training-workflow",
  "hybrid-window-observations",
  "hybrid-cancelled-outcome",
])
  await import(`./${suite}.mjs`);
const trajectory = await import("./hybrid-trajectory-contract.mjs");
trajectory.trajectoryChecks();
await trajectory.producerChecks();
await import("./hybrid-return-training.mjs");
process.stdout.write("hybrid combat learning tests passed\n");
