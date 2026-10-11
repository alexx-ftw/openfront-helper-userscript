import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const SOURCE = repositoryFilePath("engine/ingame/runtime-diagnostics.js");
const PERFORMANCE_SOURCE = repositoryFilePath("engine/ingame/auto-bot/performance.js");
let longTaskObserver = null;
const sandbox = {
  window: { __OFH_ASSETS: { version: "test" }, location: { href: "https://openfront.io/game" } },
  document: { title: "OpenFront", visibilityState: "visible" },
  performance: { now: () => 250, timeOrigin: 1000, memory: null },
  PerformanceObserver: class {
    constructor(callback) {
      this.callback = callback;
      longTaskObserver = this;
    }
    observe() {}
  },
  _helperTickListeners: new Map([[() => {}, {}]]),
  _wsConnectionState: true,
  _networkLogEntries: [{ type: "xhr" }],
  runtimeState: { networkLoggerEnabled: true },
  __OFH_RUNTIME_EXCEPTIONS__: [
    { at: 123, source: "test.js:1", name: "Error", message: "boom", stack: null },
  ],
  __OFH_RUNTIME_EVENTS__: [{ at: 124, values: ["test-event"] }],
  state: { log: [{ cat: "build", text: "City" }] },
  isSocketConnected: () => true,
  getLastKnownTile: () => 42,
  getOpenFrontGameContext: () => ({ game: null, myPlayer: null }),
  getCachedPlayerViews: () => [],
  diagnose: (options) => ({ silent: options.silent }),
  getAutoBotProfileSnapshot: () => ({ enabled: true, p95TickMs: 8 }),
  getRoundLogSnapshot: (events, matches) => ({ events, matches }),
  setAutoBotProfiling: () => {},
  setRoundLoggerEnabled: () => {},
  setNetworkLoggerEnabled: () => {},
  Date,
  Number,
  Object,
  Array,
  Math,
  WeakSet,
  console,
  globalThis: null,
};
sandbox.globalThis = sandbox;
executeClassicScript(readRepositoryFile("engine/ingame/runtime-diagnostics.js"), sandbox, {
  filename: SOURCE,
});

longTaskObserver.callback({
  getEntries: () => [{ startTime: 300, duration: 3250.25 }],
});

const snapshot = sandbox.__OFH_RUNTIME_DIAGNOSTICS__.snapshot({
  logLimit: 10,
  eventLimit: 25,
  matchLimit: 3,
});
assert.equal(snapshot.helper.loaded, true);
assert.equal(snapshot.helper.version, "test");
assert.equal(snapshot.connection.websocketConnected, true);
assert.equal(snapshot.autoBot.diagnostic.silent, true);
assert.equal(snapshot.autoBot.performance.p95TickMs, 8);
assert.equal(snapshot.autoBot.logs.length, 1);
assert.equal(snapshot.roundLog.events, 25);
assert.equal(snapshot.roundLog.matches, 3);
assert.equal(snapshot.networkLog.entries.length, 1);
assert.equal(snapshot.runtimeExceptions[0].source, "test.js:1");
assert.equal(snapshot.runtimeEvents[0].values[0], "test-event");
assert.equal(snapshot.browserPerformance.longTaskCount, 1);
assert.equal(snapshot.browserPerformance.maxRecentLongTaskMs, 3250.3);
assert.doesNotThrow(() => JSON.stringify(snapshot), "CDP snapshots must be serializable by value");

let profileNow = 0;
const profileSandbox = {
  state: { settings: { performanceProfiling: true } },
  window: { __OFH_profileNow: () => profileNow },
  performance: { now: () => profileNow },
  Math,
  Number,
  Object,
  Promise,
  globalThis: null,
};
profileSandbox.globalThis = profileSandbox;
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/performance.js"), profileSandbox, {
  filename: PERFORMANCE_SOURCE,
});
const profile = profileSandbox.beginAutoBotProfileTick();
await profileSandbox.autoBotProfileAsyncPhase(profile, "worker-probe", () => {
  profileNow += 3;
  return Promise.resolve().then(() => {
    profileNow += 7;
  });
});
assert.equal(profile.phases["worker-probe-sync"], 3);
assert.equal(profile.phases["worker-probe-await"], 7);
assert.equal(profile.phases["worker-probe"], 10);

process.stdout.write("runtime diagnostics tests passed\n");
