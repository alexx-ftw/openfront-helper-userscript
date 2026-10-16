import assert from "node:assert/strict";
import { executeClassicScript } from "../classic-script.mjs";
import { enginePath, readEngineSource } from "./context.mjs";

export function checkRoundLoggerLifecycle() {
  const roundLoggerListeners = new Set();
  const roundLoggerIntervals = [];
  const roundLoggerStorage = new Map();
  let roundLoggerGameTick = 0;
  const roundLoggerSandbox = {
    runtimeState: { roundLoggerEnabled: false },
    window: {
      setInterval: (_callback, delay) => {
        roundLoggerIntervals.push({ type: "set", delay });
        return roundLoggerIntervals.length;
      },
      clearInterval: (id) => roundLoggerIntervals.push({ type: "clear", id }),
    },
    localStorage: {
      setItem: (key, value) => roundLoggerStorage.set(key, value),
      getItem: (key) => roundLoggerStorage.get(key) ?? null,
    },
    getOpenFrontGameContext: () => ({ game: { ticks: () => roundLoggerGameTick } }),
    getCachedPlayerViews: () => [],
    registerHelperTickListener: (listener) => roundLoggerListeners.add(listener),
    unregisterHelperTickListener: (listener) => roundLoggerListeners.delete(listener),
    globalThis: null,
  };
  roundLoggerSandbox.globalThis = roundLoggerSandbox;
  executeClassicScript(
    `${readEngineSource("engine/ingame/round-logger.js")}\nglobalThis.__roundLogger = { setRoundLoggerEnabled, getRoundLogSnapshot };`,
    roundLoggerSandbox,
    { filename: enginePath("engine/ingame/round-logger.js") },
  );
  roundLoggerSandbox.__roundLogger.setRoundLoggerEnabled(true);
  roundLoggerSandbox.__roundLogger.setRoundLoggerEnabled(true);
  assert.equal(
    roundLoggerListeners.size,
    1,
    "re-enabling the round logger must not accumulate helper tick listeners",
  );
  const roundLoggerListener = [...roundLoggerListeners][0];
  roundLoggerGameTick = 100;
  roundLoggerListener();
  roundLoggerGameTick = 2;
  roundLoggerListener();
  assert.equal(
    roundLoggerSandbox.__roundLogger.getRoundLogSnapshot(10, 5).history.length,
    1,
    "a game tick reset must archive the prior match and resume logging",
  );
  roundLoggerSandbox.__roundLogger.setRoundLoggerEnabled(false);
  assert.equal(
    roundLoggerListeners.size,
    0,
    "disabling the round logger must unregister its helper tick listener",
  );
}

export function checkHeatmapLifecycle() {
  const heatmapFiles = [
    "engine/ingame/heatmaps/state.js",
    "engine/ingame/heatmaps/dom.js",
    "engine/ingame/heatmaps/trade-sources.js",
    "engine/ingame/heatmaps/projection.js",
    "engine/ingame/heatmaps/webgl.js",
    "engine/ingame/heatmaps/canvas.js",
    "engine/ingame/heatmaps/draw.js",
    "engine/ingame/heatmaps/export-partner.js",
    "engine/ingame/heatmaps/lifecycle.js",
  ];
  const heatmapSource = heatmapFiles.map((file) => readEngineSource(file)).join("\n");
  const heatmapSandbox = {
    Float32Array,
    Map,
    Math,
    Number,
    Set,
    WeakMap,
    globalThis: null,
  };
  heatmapSandbox.globalThis = heatmapSandbox;
  executeClassicScript(
    `${heatmapSource}
globalThis.__heatmapLifecycle = {
  releaseHeatmapWebGlRenderer,
  seed(canvas, renderer) {
    heatmapWebGlRenderers.set(canvas, renderer);
    heatmapVertexBuffers.set(canvas, new Float32Array(16));
  },
  has(canvas) {
    return heatmapWebGlRenderers.has(canvas) || heatmapVertexBuffers.has(canvas);
  },
};`,
    heatmapSandbox,
    { filename: enginePath("engine/ingame/heatmaps") },
  );
  let lostHeatmapContexts = 0;
  const heatmapCanvas = {};
  heatmapSandbox.__heatmapLifecycle.seed(heatmapCanvas, {
    gl: {
      getExtension(name) {
        assert.equal(name, "WEBGL_lose_context");
        return { loseContext: () => (lostHeatmapContexts += 1) };
      },
    },
  });
  heatmapSandbox.__heatmapLifecycle.releaseHeatmapWebGlRenderer(heatmapCanvas);
  assert.equal(
    lostHeatmapContexts,
    1,
    "removing a heatmap must release its WebGL context instead of risking eviction of the game map",
  );
  assert.equal(
    heatmapSandbox.__heatmapLifecycle.has(heatmapCanvas),
    false,
    "released heatmap canvases must leave no renderer or vertex-buffer cache entry",
  );
}
