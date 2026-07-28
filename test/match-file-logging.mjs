import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "engine/ingame/round-logger.js"), "utf8");
let tick = 100;
const listeners = new Set();
const windowListeners = new Map();
const sandbox = {
  runtimeState: { roundLoggerEnabled: false },
  window: {
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    setTimeout() {},
  },
  getOpenFrontGameContext: () => ({ game: { ticks: () => tick } }),
  getCachedPlayerViews: () => [],
  registerHelperTickListener: (listener) => listeners.add(listener),
  unregisterHelperTickListener: (listener) => listeners.delete(listener),
  Date,
  Map,
  Math,
  Number,
  Object,
  String,
  JSON,
  globalThis: null,
};
sandbox.globalThis = sandbox;

// The test executes the repository-owned logger source in a sealed fixture sandbox.
// eslint-disable-next-line sonarjs/code-eval
vm.runInNewContext(
  `${source}\nglobalThis.__matchLog = { setRoundLoggerEnabled, getRoundLogSnapshot };`,
  sandbox,
  { filename: "round-logger.js" },
);
sandbox.__matchLog.setRoundLoggerEnabled(true);
assert.equal(listeners.size, 1, "the enabled logger registers one match observer");
const observe = [...listeners][0];
observe();
tick = 2;
observe();
const rejection = new Error("trajectory fixture failed");
windowListeners.get("unhandledrejection")({ reason: rejection });
const snapshot = sandbox.__matchLog.getRoundLogSnapshot(100, 2);
assert.equal(snapshot.history.length, 1, "a completed match remains available in memory");
assert.equal(snapshot.current.events[0].cat, "match_start", "the next match starts a fresh file");
const rejectionEvent = snapshot.current.events.find((event) => event.cat === "unhandled_rejection");
assert.equal(rejectionEvent.reason.name, "Error", "rejection logs preserve the error type");
assert.equal(rejectionEvent.reason.message, rejection.message, "rejection logs preserve the error message");
assert.match(rejectionEvent.reason.stack, /trajectory fixture failed/, "rejection logs preserve the stack");
assert.doesNotMatch(
  source,
  /localStorage\.(?:getItem|setItem)/,
  "match data never uses localStorage",
);

process.stdout.write("per-match file logging tests passed\n");
