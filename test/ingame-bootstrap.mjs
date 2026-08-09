import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lobbyCoreSource = fs.readFileSync(path.resolve(__dirname, "../engine/lobby/core.js"), "utf8");
const lifecycleSource = fs.readFileSync(
  path.resolve(__dirname, "../engine/ingame/auto-bot/lifecycle.js"),
  "utf8",
);
const bootstrapSource = lifecycleSource.split(
  "// ============================================================================\n// Atom-bomb batch macro",
)[0];

assert.match(
  lobbyCoreSource,
  /function syncCompanionHelper\(\)[\s\S]*?lobbyState\.settings\.showCompanionPanel[\s\S]*?lobbyState\.settings\.companionEnabled/,
  "the lobby bridge must forward Companion settings through initialized lobbyState.settings",
);

let domReadyListener = null;
let intervalCallback = null;
let panelBuilds = 0;
let engineStarts = 0;
const sandbox = {
  console,
  performance: { now: () => 0 },
  document: {
    body: null,
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") domReadyListener = listener;
    },
  },
  state: {
    settings: { enabled: true },
    tickInFlight: false,
    tickStartedAt: 0,
    status: "",
  },
  buildPanel() {
    panelBuilds += 1;
  },
  refreshRuntimeStatus() {},
  setStatus() {},
  tr: (value) => value,
  renderStatus() {},
  getGame: () => null,
  retuneEngine() {},
  setEnabled() {
    engineStarts += 1;
  },
  runtimeDebugLog() {},
  captureRuntimeException(error) {
    throw error;
  },
};
sandbox.window = sandbox;
sandbox.window.setInterval = (callback) => {
  intervalCallback = callback;
  return 1;
};

assert.doesNotThrow(() =>
  executeClassicScript(bootstrapSource, sandbox, {
    filename: "auto-bot-lifecycle-document-start.js",
  }),
);
assert.equal(panelBuilds, 0, "document-start must not build UI before body exists");
assert.equal(engineStarts, 0, "document-start must not start the engine before DOM ready");
assert.equal(
  sandbox.window.__openfrontAutoBotLoaded,
  undefined,
  "the loaded guard is not poisoned by a premature bootstrap",
);
assert.equal(typeof domReadyListener, "function", "bootstrap waits for DOMContentLoaded");

sandbox.document.body = {};
domReadyListener();
assert.equal(panelBuilds, 1, "the panel builds when body becomes available");
assert.equal(engineStarts, 1, "persisted enabled state starts the engine after DOM ready");
assert.equal(sandbox.window.__openfrontAutoBotLoaded, true);
assert.equal(typeof intervalCallback, "function", "the lifecycle watcher is scheduled");

domReadyListener();
assert.equal(panelBuilds, 1, "the lifecycle guard prevents duplicate bootstrap");
assert.equal(engineStarts, 1, "the engine is not started twice");

process.stdout.write("in-game document-start bootstrap tests passed\n");
