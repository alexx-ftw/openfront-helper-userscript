import assert from "node:assert/strict";
import { executeClassicScript } from "../classic-script.mjs";
import { enginePath, readEngineSource } from "./context.mjs";

export function checkRuntimeSchedulerCadence() {
  const runtimePath = enginePath("engine/ingame/runtime.js");
  const runtimeSource = readEngineSource("engine/ingame/runtime.js");
  const schedulerStart = runtimeSource.indexOf("const HELPER_TICK_INTERVAL_MS");
  const schedulerEnd = runtimeSource.indexOf("// Sync a panel's visibility state", schedulerStart);
  assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, "helper scheduler source exists");
  let schedulerNow = 0;
  let schedulerCallback = null;
  const schedulerSandbox = {
    window: {
      setInterval: (callback, delay) => {
        assert.equal(delay, 250, "the scheduler keeps one responsive base timer");
        schedulerCallback = callback;
        return 1;
      },
      clearInterval: () => {},
    },
    performance: { now: () => schedulerNow },
    Date,
    Number,
    Map,
    console,
    globalThis: null,
  };
  schedulerSandbox.globalThis = schedulerSandbox;
  executeClassicScript(
    `${runtimeSource.slice(schedulerStart, schedulerEnd)}\nglobalThis.__scheduler = { registerHelperTickListener, unregisterHelperTickListener };`,
    schedulerSandbox,
    { filename: runtimePath },
  );
  let fastTicks = 0;
  let slowTicks = 0;
  const fastListener = () => {
    fastTicks += 1;
  };
  const slowListener = () => {
    slowTicks += 1;
  };
  schedulerSandbox.__scheduler.registerHelperTickListener(fastListener);
  schedulerSandbox.__scheduler.registerHelperTickListener(slowListener, 1000);
  assert.deepEqual([fastTicks, slowTicks], [1, 1], "listeners run once when registered");
  schedulerSandbox.__scheduler.registerHelperTickListener(slowListener, 1000);
  assert.equal(slowTicks, 1, "duplicate registration must not repeat initial work");
  for (schedulerNow = 250; schedulerNow <= 750; schedulerNow += 250) {
    schedulerCallback();
  }
  assert.deepEqual([fastTicks, slowTicks], [4, 1], "slow listeners skip unnecessary base ticks");
  schedulerNow = 1000;
  schedulerCallback();
  assert.deepEqual([fastTicks, slowTicks], [5, 2], "slow listeners run when their cadence is due");
}

export function checkEngineTimerRetune() {
  const intervalEvents = [];
  let nextTimerId = 1;
  const engineSandbox = {
    state: {
      settings: { enabled: true, tickMs: 200 },
      speed: { factor: 1 },
      tickTimer: null,
      tickIntervalMs: 0,
      tickInFlight: false,
      tickGeneration: 0,
    },
    window: {
      setInterval: (_callback, delay) => {
        const id = nextTimerId++;
        intervalEvents.push({ type: "set", id, delay });
        return id;
      },
      clearInterval: (id) => intervalEvents.push({ type: "clear", id }),
    },
    performance: { now: () => 0 },
    getGame: () => null,
    setStatus: () => {},
    tr: (value) => value,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    globalThis: null,
  };
  engineSandbox.globalThis = engineSandbox;
  executeClassicScript(
    `${readEngineSource("engine/ingame/auto-bot/engine.js")}\nglobalThis.__engine = { startEngine, retuneEngine, stopEngine };`,
    engineSandbox,
    { filename: enginePath("engine/ingame/auto-bot/engine.js") },
  );

  engineSandbox.__engine.startEngine();
  assert.deepEqual(
    intervalEvents,
    [{ type: "set", id: 1, delay: 200 }],
    "the configured tick interval is used when the engine starts",
  );
  engineSandbox.state.settings.tickMs = 250;
  engineSandbox.__engine.retuneEngine();
  assert.deepEqual(
    intervalEvents,
    [
      { type: "set", id: 1, delay: 200 },
      { type: "clear", id: 1 },
      { type: "set", id: 2, delay: 250 },
    ],
    "a 50 ms setting change must replace the active timer",
  );
  engineSandbox.__engine.stopEngine();
  engineSandbox.state.tickInFlight = true;
  engineSandbox.__engine.stopEngine();
  assert.equal(
    engineSandbox.state.tickInFlight,
    true,
    "stopping the engine must not release a still-running tick lock",
  );
}
