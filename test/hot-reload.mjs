import assert from "node:assert/strict";
import { HOT_RELOAD_BRIDGE } from "../scripts/build/assemble.mjs";
import { publishBuildArtifacts } from "../scripts/build/assets.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/lifecycle.js"),
  "utf8",
);
const autoBotBuildSource = fs.readFileSync(
  path.join(repoRoot, "openfront-helper.autobot.js"),
  "utf8",
);

async function captureRejection(promise) {
  return promise.then(
    () => {
      throw new Error("expected hot reload to reject");
    },
    (error) => error,
  );
}

function makeHotReloadBridgeHarness({
  candidateActivation = () => true,
  candidateCleanup = () => true,
  candidateSet = null,
  previousEnabled = true,
  previousActivation = () => true,
} = {}) {
  const events = [];
  const counts = {
    previousDisposals: 0,
    previousActivations: 0,
    candidateActivations: 0,
    candidateDisposals: 0,
  };
  const snapshots = {};
  let cleanupOptions = null;
  const previousAtomDisposer = () => {};
  const previous = {
    get: () => ({ enabled: previousEnabled }),
    disposeForHotReload: async () => {
      counts.previousDisposals += 1;
      events.push("previous:dispose");
      return true;
    },
    activateForHotReload: async (options) => {
      counts.previousActivations += 1;
      events.push("previous:activate");
      snapshots.previousActivationOptions = options;
      snapshots.previousActivation = {
        runtime: sandbox.window.__OFH_autobot,
        buildId: sandbox.window.__OFH_LOCAL_BUILD_ID__,
        atomDisposer: sandbox.window.__OFH_disposeAtomMacroForHotReload,
        activationPending: sandbox.window.__openfrontAutoBotActivationPending,
        staging: sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__,
        candidateAtomMacro: sandbox.window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__,
      };
      return previousActivation(options);
    },
  };
  const candidate = {
    disposeForHotReload: async (options) => {
      counts.candidateDisposals += 1;
      events.push("candidate:cleanup");
      cleanupOptions = options;
      return candidateCleanup();
    },
    activateForHotReload: async (options) => {
      counts.candidateActivations += 1;
      events.push("candidate:activate");
      snapshots.candidateActivationOptions = options;
      return candidateActivation(options);
    },
  };
  if (typeof candidateSet === "function") {
    candidate.set = (patch) => {
      events.push("candidate:set");
      candidateSet(patch);
    };
  }
  const sandbox = {
    window: {
      __OFH_autobot: previous,
      __OFH_LOCAL_BUILD_ID__: "previous-build",
      __OFH_disposeAtomMacroForHotReload: previousAtomDisposer,
      __openfrontAutoBotActivationPending: "previous-pending",
      __testCandidateRuntime: candidate,
    },
  };
  vm.createContext(sandbox);
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(HOT_RELOAD_BRIDGE, sandbox);

  return {
    candidate,
    counts,
    events,
    previous,
    previousAtomDisposer,
    reload() {
      return sandbox.window.__OFH_HOT_RELOAD_AUTOBOT__(
        "window.__OFH_autobot = window.__testCandidateRuntime;\n" +
          "window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__ = { staged: true };",
        "candidate-build",
      );
    },
    sandbox,
    snapshots,
    get cleanupOptions() {
      return cleanupOptions;
    },
  };
}

function assertRestoredTerminalState(harness) {
  assert.equal(harness.sandbox.window.__OFH_autobot, harness.previous);
  assert.equal(harness.sandbox.window.__OFH_LOCAL_BUILD_ID__, "previous-build");
  assert.equal(
    harness.sandbox.window.__OFH_disposeAtomMacroForHotReload,
    harness.previousAtomDisposer,
  );
  assert.equal(harness.sandbox.window.__openfrontAutoBotActivationPending, "previous-pending");
  assert.equal(harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__, false);
  assert.equal(harness.sandbox.window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__, undefined);
}

function assertAggregateFailure(error, primaryError, secondaryError) {
  assert.equal(error.name, "AggregateError");
  assert.equal(error.cause, primaryError, "candidate activation remains the causal error");
  assert.deepEqual(Array.from(error.errors), [primaryError, secondaryError]);
}

async function testInvalidEvalKeepsPreviousRuntime() {
  let disposed = 0;
  const previous = {
    disposeForHotReload: async () => {
      disposed += 1;
    },
  };
  const sandbox = {
    window: {
      __OFH_autobot: previous,
      __OFH_LOCAL_BUILD_ID__: "a".repeat(64),
    },
  };
  vm.createContext(sandbox);
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(HOT_RELOAD_BRIDGE, sandbox);

  await assert.rejects(
    sandbox.window.__OFH_HOT_RELOAD_AUTOBOT__(
      "throw new Error('invalid candidate');",
      "b".repeat(64),
    ),
    /invalid candidate/u,
  );
  assert.equal(disposed, 0, "invalid code must not dispose the running runtime");
  assert.equal(sandbox.window.__OFH_autobot, previous);
  assert.equal(sandbox.window.__OFH_LOCAL_BUILD_ID__, "a".repeat(64));

  let atomDisposed = 0;
  sandbox.window.__OFH_disposeAtomMacroForHotReload = () => {
    atomDisposed += 1;
  };
  await assert.rejects(
    sandbox.window.__OFH_HOT_RELOAD_AUTOBOT__(
      "window.__OFH_autobot = { disposeForHotReload() {} }; throw new Error('runtime eval failed');",
      "c".repeat(64),
    ),
    /runtime eval failed/u,
  );
  assert.equal(atomDisposed, 0, "a staged candidate must not clean up the live Atom Macro");
  assert.equal(sandbox.window.__OFH_autobot, previous);

  await assert.doesNotReject(
    sandbox.window.__OFH_HOT_RELOAD_AUTOBOT__(
      "if (!window.__OFH_HOT_RELOAD_IN_PROGRESS__) throw new Error('candidate ran live');\n" +
        "window.__OFH_autobot = { disposeForHotReload() {}, activateForHotReload: async () => !window.__OFH_HOT_RELOAD_IN_PROGRESS__ };",
      "d".repeat(64),
    ),
  );
  assert.equal(disposed, 1, "the old runtime is disposed only after candidate evaluation succeeds");
  assert.equal(sandbox.window.__OFH_LOCAL_BUILD_ID__, "d".repeat(64));
}

async function testActivationFailureRollsBackInOrderExactlyOnce() {
  const activationError = new Error("candidate activation failed");
  const harness = makeHotReloadBridgeHarness({
    candidateActivation: () => {
      throw activationError;
    },
  });

  const error = await captureRejection(harness.reload());

  assert.equal(error, activationError);
  assert.deepEqual(harness.events, [
    "previous:dispose",
    "candidate:activate",
    "candidate:cleanup",
    "previous:activate",
  ]);
  assert.deepEqual(harness.counts, {
    previousDisposals: 1,
    previousActivations: 1,
    candidateActivations: 1,
    candidateDisposals: 1,
  });
  assert.equal(harness.cleanupOptions.skipAtomMacroCleanup, true);
  assertRestoredTerminalState(harness);
  assert.deepEqual(harness.snapshots.previousActivation, {
    runtime: harness.previous,
    buildId: "previous-build",
    atomDisposer: harness.previousAtomDisposer,
    activationPending: "previous-pending",
    staging: false,
    candidateAtomMacro: undefined,
  });
}

async function testRejectedCandidateCleanupRestoresWithoutReactivation() {
  const activationError = new Error("candidate activation failed");
  const cleanupError = new Error("candidate cleanup rejected");
  const harness = makeHotReloadBridgeHarness({
    candidateActivation: () => {
      throw activationError;
    },
    candidateCleanup: () => {
      throw cleanupError;
    },
  });

  const error = await captureRejection(harness.reload());

  assertAggregateFailure(error, activationError, cleanupError);
  assert.deepEqual(harness.events, ["previous:dispose", "candidate:activate", "candidate:cleanup"]);
  assert.equal(harness.counts.previousActivations, 0);
  assertRestoredTerminalState(harness);
}

async function testFalseCandidateCleanupWithholdsPreviousReactivation() {
  const activationError = new Error("candidate activation failed");
  const harness = makeHotReloadBridgeHarness({
    candidateActivation: () => {
      throw activationError;
    },
    candidateCleanup: () => false,
  });

  const error = await captureRejection(harness.reload());

  assert.equal(error.name, "AggregateError");
  assert.equal(error.cause, activationError);
  assert.equal(Array.from(error.errors)[0], activationError);
  assert.match(Array.from(error.errors)[1].message, /candidato.*cerrarse limpiamente/u);
  assert.deepEqual(harness.events, ["previous:dispose", "candidate:activate", "candidate:cleanup"]);
  assert.equal(harness.counts.previousActivations, 0);
  assertRestoredTerminalState(harness);
}

async function testRejectedPreviousReactivationPreservesActivationFailure() {
  const activationError = new Error("candidate activation failed");
  const rollbackError = new Error("previous reactivation rejected");
  const harness = makeHotReloadBridgeHarness({
    candidateActivation: () => {
      throw activationError;
    },
    previousActivation: () => {
      throw rollbackError;
    },
  });

  const error = await captureRejection(harness.reload());

  assertAggregateFailure(error, activationError, rollbackError);
  assert.deepEqual(harness.events, [
    "previous:dispose",
    "candidate:activate",
    "candidate:cleanup",
    "previous:activate",
  ]);
  assert.deepEqual(harness.counts, {
    previousDisposals: 1,
    previousActivations: 1,
    candidateActivations: 1,
    candidateDisposals: 1,
  });
  assertRestoredTerminalState(harness);
}

async function testFalsePreviousReactivationPreservesActivationFailure() {
  const activationError = new Error("candidate activation failed");
  const harness = makeHotReloadBridgeHarness({
    candidateActivation: () => {
      throw activationError;
    },
    previousActivation: () => false,
  });

  const error = await captureRejection(harness.reload());

  assert.equal(error.name, "AggregateError");
  assert.equal(error.cause, activationError);
  assert.equal(Array.from(error.errors)[0], activationError);
  assert.match(Array.from(error.errors)[1].message, /runtime anterior.*reactivarse/u);
  assert.deepEqual(harness.events, [
    "previous:dispose",
    "candidate:activate",
    "candidate:cleanup",
    "previous:activate",
  ]);
  assert.equal(harness.counts.previousActivations, 1);
  assertRestoredTerminalState(harness);
}

async function testSuccessfulActivationHasNoCleanupOrRollback() {
  const harness = makeHotReloadBridgeHarness();

  assert.equal(await harness.reload(), true);

  assert.deepEqual(harness.events, ["previous:dispose", "candidate:activate"]);
  assert.deepEqual(harness.counts, {
    previousDisposals: 1,
    previousActivations: 0,
    candidateActivations: 1,
    candidateDisposals: 0,
  });
  assert.equal(harness.sandbox.window.__OFH_autobot, harness.candidate);
  assert.equal(harness.sandbox.window.__OFH_LOCAL_BUILD_ID__, "candidate-build");
  assert.equal(harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__, false);
  assert.equal(harness.sandbox.window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__, undefined);
  assert.equal(
    harness.snapshots.candidateActivationOptions?.enabled,
    true,
    "the replacement runtime inherits the live enabled state",
  );
}

async function testSuccessfulActivationPreservesDisabledState() {
  const harness = makeHotReloadBridgeHarness({ previousEnabled: false });

  assert.equal(await harness.reload(), true);
  assert.equal(
    harness.snapshots.candidateActivationOptions?.enabled,
    false,
    "hot reload must not enable a bot that was disabled",
  );
}

async function testSuccessfulActivationReassertsTransferredEnabledState() {
  let replacementEnabled = false;
  const harness = makeHotReloadBridgeHarness({
    candidateSet: (patch) => {
      replacementEnabled = Boolean(patch.enabled);
    },
  });

  assert.equal(await harness.reload(), true);
  assert.equal(
    replacementEnabled,
    true,
    "the bridge restarts the replacement through its public API before reporting success",
  );
  assert.deepEqual(harness.events, ["previous:dispose", "candidate:activate", "candidate:set"]);
}

function makeLifecycleSandbox() {
  const listeners = new Map();
  const timers = new Set();
  let now = 0;
  let timeoutCallback = null;
  const elements = new Map();
  const document = {
    body: {},
    activeElement: null,
    addEventListener(type, listener) {
      listeners.set(`document:${type}`, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(`document:${type}`) === listener) listeners.delete(`document:${type}`);
    },
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return {
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        remove() {},
        setAttribute() {},
        addEventListener() {},
        querySelector() {
          return null;
        },
      };
    },
  };
  const window = {
    document,
    addEventListener(type, listener) {
      listeners.set(`window:${type}`, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(`window:${type}`) === listener) listeners.delete(`window:${type}`);
    },
    setInterval(callback) {
      const timer = { callback };
      timers.add(timer);
      return timer;
    },
    clearInterval(timer) {
      timers.delete(timer);
    },
    setTimeout(callback) {
      timeoutCallback = callback;
      return { callback };
    },
    clearTimeout() {},
    dispatchEvent() {},
    __openfrontAutoBotWatcherTimer: null,
    __openfrontAutoBotLoaded: false,
  };
  const state = {
    settings: { enabled: true },
    tickTimer: null,
    tickInFlight: true,
    tickGeneration: 0,
    status: "",
  };
  const sandbox = {
    window,
    document,
    globalThis: window,
    performance: { now: () => now },
    console: { warn() {}, info() {}, error() {} },
    state,
    PANEL_ID: "openfront-helper-auto-bot-panel",
    STYLE_ID: "openfront-helper-auto-bot-styles",
    buildPanel() {},
    refreshRuntimeStatus() {},
    setStatus() {},
    tr: (value) => value,
    renderStatus() {},
    getGame: () => null,
    refreshLiveUiFromGame() {},
    retuneEngine() {},
    setEnabled() {},
    saveSettings() {},
    runtimeDebugLog() {},
    startEngine() {
      if (state.tickTimer !== null) return;
      state.tickTimer = window.setInterval(() => {}, 200);
    },
    stopEngine() {
      if (state.tickTimer !== null) window.clearInterval(state.tickTimer);
      state.tickTimer = null;
      state.tickGeneration += 1;
    },
    atomBuildableDescriptors: async () => ({ atom: null }),
    computeNukeRemainingTicks: () => null,
    UniversalPathFinding: {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    PointerEvent: class {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  window.localStorage = sandbox.localStorage;
  window.innerWidth = 1280;
  window.innerHeight = 800;

  return {
    sandbox,
    state,
    listeners,
    timers,
    advanceToTimeout() {
      now = 8001;
      timeoutCallback?.();
    },
    elements,
  };
}

async function testLifecycleDisposesAtomMacroAndClosesInFlightTick() {
  const harness = makeLifecycleSandbox();
  executeClassicScript(lifecycleSource, harness.sandbox, {
    filename: "auto-bot-lifecycle-hot-reload.js",
  });

  const runtime = harness.sandbox.window.__OFH_autobot;
  assert.equal(typeof runtime?.disposeForHotReload, "function");
  assert.equal(harness.sandbox.window.__ofhAtomMacroInstalled, true);
  assert.ok(harness.listeners.has("window:keydown"), "Atom Macro listeners are installed");

  const disposing = runtime.disposeForHotReload();
  harness.advanceToTimeout();
  const result = await disposing;

  assert.equal(
    result,
    true,
    "a stale-generation tick cannot prevent the replacement runtime from activating",
  );
  assert.equal(
    harness.state.tickGeneration,
    1,
    "teardown invalidates the in-flight tick before allowing replacement activation",
  );
  assert.equal(
    harness.state.settings.enabled,
    true,
    "hot reload teardown preserves the user's enabled preference",
  );
  assert.equal(harness.sandbox.window.__ofhAtomMacroInstalled, false);
  assert.equal(harness.sandbox.window.__OFH_atomBatch, undefined);
  assert.equal(harness.listeners.size, 0, "Atom Macro listeners are removed transactionally");
  assert.equal(harness.timers.size, 0, "the lifecycle watcher is stopped");
}

async function testLifecycleStagesAndActivatesAtomMacroOnce() {
  const harness = makeLifecycleSandbox();
  harness.state.settings.enabled = false;
  harness.state.tickInFlight = false;
  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = true;
  executeClassicScript(lifecycleSource, harness.sandbox, {
    filename: "auto-bot-lifecycle-staged-hot-reload.js",
  });

  const runtime = harness.sandbox.window.__OFH_autobot;
  assert.equal(harness.sandbox.window.__ofhAtomMacroInstalled, undefined);
  assert.equal(typeof harness.sandbox.window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__, "object");
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);

  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
  assert.equal(runtime.activateForHotReload(), true);

  assert.equal(harness.sandbox.window.__ofhAtomMacroInstalled, true);
  assert.equal(harness.sandbox.window.__OFH_HOT_RELOAD_CANDIDATE_ATOM_MACRO__, undefined);
  assert.equal(typeof harness.sandbox.window.__OFH_disposeAtomMacroForHotReload, "function");
  assert.ok(harness.listeners.has("window:keydown"));
  assert.equal(harness.timers.size, 1, "the lifecycle watcher starts once");

  assert.equal(await runtime.disposeForHotReload(), true);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.timers.size, 0);
}

async function testLifecycleAppliesTransferredEnabledStateBeforeStarting() {
  const harness = makeLifecycleSandbox();
  harness.state.settings.enabled = false;
  harness.state.tickInFlight = false;
  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = true;
  executeClassicScript(lifecycleSource, harness.sandbox, {
    filename: "auto-bot-lifecycle-enabled-transfer.js",
  });

  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
  const runtime = harness.sandbox.window.__OFH_autobot;
  assert.equal(runtime.activateForHotReload({ enabled: true }), true);
  assert.equal(
    harness.state.settings.enabled,
    true,
    "the candidate applies the live master-toggle value instead of stale storage",
  );
}

async function testLifecycleRecoversEnabledStateFromAStaleBridge() {
  const harness = makeLifecycleSandbox();
  harness.state.settings.enabled = false;
  harness.state.tickInFlight = false;
  harness.sandbox.window.__OFH_autobot = {
    get: () => ({ enabled: true }),
  };
  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = true;
  executeClassicScript(lifecycleSource, harness.sandbox, {
    filename: "auto-bot-lifecycle-stale-bridge.js",
  });

  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
  const runtime = harness.sandbox.window.__OFH_autobot;
  assert.equal(runtime.activateForHotReload(), true);
  assert.equal(
    harness.state.settings.enabled,
    true,
    "a candidate recovers the live toggle when an already-loaded bridge passes no options",
  );
  assert.notEqual(
    harness.state.tickTimer,
    null,
    "the replacement engine is actually running after the compatibility handoff",
  );
}

async function testLifecycleRestartsEnabledEngineBehindStaleLoadedFlag() {
  const harness = makeLifecycleSandbox();
  harness.state.settings.enabled = false;
  harness.state.tickInFlight = false;
  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = true;
  executeClassicScript(lifecycleSource, harness.sandbox, {
    filename: "auto-bot-lifecycle-stale-loaded-flag.js",
  });

  harness.sandbox.window.__OFH_HOT_RELOAD_IN_PROGRESS__ = false;
  harness.sandbox.window.__openfrontAutoBotLoaded = true;
  const runtime = harness.sandbox.window.__OFH_autobot;
  assert.equal(runtime.activateForHotReload({ enabled: true }), true);
  assert.notEqual(
    harness.state.tickTimer,
    null,
    "a successful enabled activation must leave the replacement engine running",
  );
}

async function testBridgeFaultInjectionRegressions() {
  const cases = [
    ["partial previous disposal", testPartialPreviousDisposalRestoresRuntime],
    ["normal rollback ordering", testActivationFailureRollsBackInOrderExactlyOnce],
    ["rejected candidate cleanup", testRejectedCandidateCleanupRestoresWithoutReactivation],
    ["false candidate cleanup", testFalseCandidateCleanupWithholdsPreviousReactivation],
    ["rejected previous reactivation", testRejectedPreviousReactivationPreservesActivationFailure],
    ["false previous reactivation", testFalsePreviousReactivationPreservesActivationFailure],
    ["successful activation counters", testSuccessfulActivationHasNoCleanupOrRollback],
    ["successful disabled-state transfer", testSuccessfulActivationPreservesDisabledState],
    [
      "successful enabled-state reassertion",
      testSuccessfulActivationReassertsTransferredEnabledState,
    ],
  ];
  const results = await Promise.allSettled(cases.map(([, run]) => run()));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [new Error(cases[index][0], { cause: result.reason })] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "hot-reload bridge regression cases failed");
  }
}

async function testPartialPreviousDisposalRestoresRuntime() {
  let engineRunning = true;
  let panelPresent = true;
  const failure = new Error("Atom cleanup failed after teardown");
  const harness = makeHotReloadBridgeHarness({
    previousActivation() {
      engineRunning = true;
      panelPresent = true;
      return true;
    },
  });
  harness.previous.disposeForHotReload = async () => {
    engineRunning = false;
    panelPresent = false;
    throw failure;
  };
  assert.equal(await captureRejection(harness.reload()), failure);
  assert.equal(engineRunning, true, "failed disposal must recover the running engine");
  assert.equal(panelPresent, true, "failed disposal must recover the panel");
  assert.equal(harness.counts.previousActivations, 1);
  assert.equal(harness.counts.candidateActivations, 0);
  assertRestoredTerminalState(harness);
}

async function testBuildPublishesThreeArtifactsAtomically() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-hot-reload-"));
  const artifacts = {
    full: "full-v2",
    autoBot: "autobot-v2",
    buildId: "id-v2",
  };
  const artifactKeys = {
    "openfront-helper.user.js": "full",
    "openfront-helper.autobot.js": "autoBot",
    "openfront-helper.build-id.js": "buildId",
  };
  for (const [name, key] of Object.entries(artifactKeys)) {
    fs.writeFileSync(path.join(outputDir, name), `${artifacts[key]}-v1`, "utf8");
  }

  await publishBuildArtifacts(outputDir, artifacts);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(artifactKeys).map((name) => [
        name,
        fs.readFileSync(path.join(outputDir, name), "utf8"),
      ]),
    ),
    Object.fromEntries(Object.entries(artifactKeys).map(([name, key]) => [name, artifacts[key]])),
  );
  assert.deepEqual(
    fs.readdirSync(outputDir).filter((name) => name.startsWith(".ofh-build-")),
    [],
    "publication removes its staging directory",
  );
  fs.rmSync(outputDir, { recursive: true, force: true });
}

function testAutoBotArtifactRefreshesTheHotReloadBridge() {
  assert.match(
    autoBotBuildSource,
    /__OFH_HOT_RELOAD_AUTOBOT__/u,
    "the hot-reloaded artifact must upgrade the page bridge without a tab reload",
  );
}

await testInvalidEvalKeepsPreviousRuntime();
await testBridgeFaultInjectionRegressions();
await testLifecycleDisposesAtomMacroAndClosesInFlightTick();
await testLifecycleStagesAndActivatesAtomMacroOnce();
await testLifecycleAppliesTransferredEnabledStateBeforeStarting();
await testLifecycleRecoversEnabledStateFromAStaleBridge();
await testLifecycleRestartsEnabledEngineBehindStaleLoadedFlag();
testAutoBotArtifactRefreshesTheHotReloadBridge();
await testBuildPublishesThreeArtifactsAtomically();
process.stdout.write("hot-reload transactional tests passed\n");
