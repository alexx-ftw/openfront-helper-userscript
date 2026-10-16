import assert from "node:assert/strict";
import { executeClassicScript } from "../classic-script.mjs";
import { enginePath, readEngineSource } from "./context.mjs";

export async function checkHelperWithTimeout() {
  let helperTimerCallback = null;
  const helperTimerEvents = [];
  const helperSandbox = {
    window: {
      setTimeout: (callback, delay) => {
        helperTimerCallback = callback;
        helperTimerEvents.push({ type: "set", delay });
        return 1;
      },
      clearTimeout: (id) => helperTimerEvents.push({ type: "clear", id }),
    },
    globalThis: null,
  };
  helperSandbox.globalThis = helperSandbox;
  executeClassicScript(
    `${readEngineSource("engine/ingame/auto-bot/helpers.js")}\nglobalThis.__helpers = { withTimeout };`,
    helperSandbox,
    { filename: enginePath("engine/ingame/auto-bot/helpers.js") },
  );
  let resolveFastWorker;
  const fastWorker = new Promise((resolve) => {
    resolveFastWorker = resolve;
  });
  const fastResult = helperSandbox.__helpers.withTimeout(fastWorker, 2500, "fallback");
  resolveFastWorker("ok");
  assert.equal(await fastResult, "ok", "a worker result should win the timeout race");
  assert.deepEqual(
    helperTimerEvents,
    [
      { type: "set", delay: 2500 },
      { type: "clear", id: 1 },
    ],
    "a completed worker query must clear its pending timeout",
  );
  helperTimerEvents.length = 0;
  const slowResult = helperSandbox.__helpers.withTimeout(new Promise(() => {}), 750, "fallback");
  helperTimerCallback();
  assert.equal(await slowResult, "fallback", "a timeout should return its fallback");
  assert.deepEqual(
    helperTimerEvents,
    [
      { type: "set", delay: 750 },
      { type: "clear", id: 1 },
    ],
    "a fired timeout should also release its timer handle",
  );
}

export function checkPerformanceProfiling() {
  let profileNow = 0;
  const profileSandbox = {
    state: {
      settings: { performanceProfiling: false, tickMs: 200 },
      tickIntervalMs: 200,
    },
    performance: {
      now: () => {
        profileNow += 5;
        return profileNow;
      },
    },
    saveSettings: () => {},
    renderStatus: () => {},
    console: { table: () => {} },
    globalThis: null,
  };
  profileSandbox.globalThis = profileSandbox;
  executeClassicScript(
    `${readEngineSource("engine/ingame/auto-bot/performance.js")}
globalThis.__profile = { beginAutoBotProfileTick, finishAutoBotProfileTick, autoBotProfileStartPhase, autoBotProfileEndPhase, getAutoBotProfileSnapshot };`,
    profileSandbox,
    { filename: enginePath("engine/ingame/auto-bot/performance.js") },
  );
  assert.equal(
    profileSandbox.__profile.beginAutoBotProfileTick(),
    null,
    "disabled profiling must not create a tick context",
  );
  assert.equal(profileNow, 0, "disabled profiling must not call performance.now()");
  profileSandbox.state.settings.performanceProfiling = true;
  const profile = profileSandbox.__profile.beginAutoBotProfileTick();
  const phaseStart = profileSandbox.__profile.autoBotProfileStartPhase(profile);
  profileSandbox.__profile.autoBotProfileEndPhase(profile, "structures", phaseStart);
  profileSandbox.__profile.finishAutoBotProfileTick(profile);
  const profileSnapshot = profileSandbox.__profile.getAutoBotProfileSnapshot();
  assert.equal(profileSnapshot.sampledTicks, 1, "enabled profiling must record a tick");
  assert.equal(profileSnapshot.phases[0].name, "structures");
  assert.ok(profileSnapshot.p95TickMs > 0, "profiling must expose a tick percentile");
}
