import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildSource = fs.readFileSync(path.join(repoRoot, "build.mjs"), "utf8");
const lifecycleSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/lifecycle.js"),
  "utf8",
);

function extractHotReloadBridge(source) {
  const match = source.match(/const HOT_RELOAD_BRIDGE = `([\s\S]*?)`;/u);
  assert.ok(match, "build must contain an extractable hot-reload bridge");
  return match[1];
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
  vm.runInContext(extractHotReloadBridge(buildSource), sandbox);

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
    tickStartedAt: 0,
    tickGeneration: 0,
    runtimePausedAfterSlowTick: false,
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
    refreshGateBanner() {},
    setStatus() {},
    tr: (value) => value,
    renderStatus() {},
    getGame: () => null,
    refreshLiveUiFromGame() {},
    retuneEngine() {},
    setEnabled() {},
    saveSettings() {},
    runtimeDebugLog() {},
    stopEngine() {
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

async function testLifecycleDisposesAtomMacroAndClosesStalledTick() {
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

  assert.equal(result, false, "a tick beyond the timeout closes the old runtime");
  assert.equal(harness.state.runtimePausedAfterSlowTick, true);
  assert.equal(harness.state.settings.enabled, false);
  assert.equal(harness.sandbox.window.__ofhAtomMacroInstalled, false);
  assert.equal(harness.sandbox.window.__OFH_atomBatch, undefined);
  assert.equal(harness.listeners.size, 0, "Atom Macro listeners are removed transactionally");
  assert.equal(harness.timers.size, 0, "the lifecycle watcher is stopped");
}

async function testBuildPublishesThreeArtifactsAtomically() {
  assert.match(buildSource, /export async function publishBuildArtifacts/u);
  const { publishBuildArtifacts } = await import("../build.mjs");
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

await testInvalidEvalKeepsPreviousRuntime();
await testLifecycleDisposesAtomMacroAndClosesStalledTick();
await testBuildPublishesThreeArtifactsAtomically();
process.stdout.write("hot-reload transactional tests passed\n");
