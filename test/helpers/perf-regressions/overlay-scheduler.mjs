import assert from "node:assert/strict";
import { executeClassicScript } from "../classic-script.mjs";
import { enginePath, readEngineSource } from "./context.mjs";

export function setupOverlayScheduler() {
  const overlaySchedulerSource = readEngineSource("engine/ingame/map-overlay-scheduler.js");
  const state = {
    now: 1001,
    cameraX: 0,
    removedCanvases: 0,
    draws: 0,
    scans: 0,
    enabled: true,
    animated: false,
  };
  let nextOverlayHandle = 1;
  const overlayAnimationFrames = new Map();
  const overlayWakeTimers = new Map();
  const overlayContext = { setTransform() {}, clearRect() {} };
  const overlayCanvas = {
    id: "",
    isConnected: false,
    style: {},
    setAttribute() {},
    getContext: () => overlayContext,
    remove() {
      this.isConnected = false;
      state.removedCanvases += 1;
    },
  };
  const overlayGame = {};
  const overlayTransform = {
    scale: 1,
    worldToScreenCoordinates(point) {
      return { x: point.x + state.cameraX, y: point.y };
    },
  };
  const overlaySandbox = {
    document: {
      body: {
        appendChild(canvas) {
          canvas.isConnected = true;
        },
      },
      documentElement: null,
      getElementById() {
        return overlayCanvas.isConnected ? overlayCanvas : null;
      },
      createElement() {
        return overlayCanvas;
      },
    },
    localStorage: { getItem: () => null },
    performance: { now: () => state.now },
    window: { innerWidth: 1280, innerHeight: 720 },
    requestAnimationFrame(callback) {
      const handle = nextOverlayHandle++;
      overlayAnimationFrames.set(handle, callback);
      return handle;
    },
    setTimeout(callback, delay) {
      const handle = nextOverlayHandle++;
      overlayWakeTimers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle) {
      overlayWakeTimers.delete(handle);
    },
    getOpenFrontGameContext: () => ({ game: overlayGame, transform: overlayTransform }),
    globalThis: null,
  };
  overlaySandbox.globalThis = overlaySandbox;
  executeClassicScript(
    `${overlaySchedulerSource}
globalThis.__overlayScheduler = {
  registerMapOverlayLayer,
  markMapOverlayDirty,
  requestMapOverlayLoop,
};`,
    overlaySandbox,
    { filename: enginePath("engine/ingame/map-overlay-scheduler.js") },
  );
  const staticOverlayLayer = {
    id: "observable-static-layer",
    scanIntervalMs: 1000,
    isEnabled: () => state.enabled,
    scan() {
      state.scans += 1;
    },
    draw() {
      state.draws += 1;
    },
    animated: () => state.animated,
  };
  overlaySandbox.__overlayScheduler.registerMapOverlayLayer(staticOverlayLayer);
  overlaySandbox.__overlayScheduler.requestMapOverlayLoop();
  assert.equal(
    overlayAnimationFrames.size,
    1,
    "an enabled layer must start with one animation frame",
  );
  return { state, overlayAnimationFrames, overlayWakeTimers, overlaySandbox };
}

export function checkOverlaySchedulerLifecycle(scheduler) {
  const { state, overlayAnimationFrames, overlayWakeTimers, overlaySandbox } = scheduler;
  const runNextOverlayFrame = () => {
    const [handle, callback] = overlayAnimationFrames.entries().next().value;
    overlayAnimationFrames.delete(handle);
    callback();
  };
  const runNextOverlayWake = () => {
    const [handle, timer] = overlayWakeTimers.entries().next().value;
    overlayWakeTimers.delete(handle);
    timer.callback();
  };
  runNextOverlayFrame();
  assert.equal(state.draws, 1, "the first frame must draw the enabled layer");
  assert.equal(state.scans, 1, "the first frame must perform the layer scan");
  assert.equal(
    overlayAnimationFrames.size,
    0,
    "a clean static layer must stop requesting animation frames",
  );
  assert.equal(
    overlayWakeTimers.size,
    1,
    "a clean static layer must retain a camera/update wake timer",
  );
  state.now = 1251;
  state.cameraX = 17;
  runNextOverlayWake();
  assert.equal(overlayAnimationFrames.size, 1, "a camera poll must wake one render frame");
  runNextOverlayFrame();
  assert.equal(state.draws, 2, "a camera change must redraw the static layer");
  assert.equal(
    overlayAnimationFrames.size,
    0,
    "the layer must sleep again after the camera redraw",
  );
  assert.equal(overlayWakeTimers.size, 1, "camera redraw must preserve future update detection");
  state.now = 2251;
  runNextOverlayWake();
  runNextOverlayFrame();
  assert.equal(state.scans, 2, "a sleeping layer must still receive its throttled data update");
  assert.equal(state.draws, 3, "a throttled data update must redraw the layer");
  state.now = 2300;
  overlaySandbox.__overlayScheduler.markMapOverlayDirty();
  assert.equal(overlayWakeTimers.size, 0, "an update must cancel the sleeping wake timer");
  assert.equal(overlayAnimationFrames.size, 1, "an update must wake the scheduler immediately");
  runNextOverlayFrame();
  assert.equal(state.draws, 4, "an update must redraw without waiting for the poll");
  state.animated = true;
  runNextOverlayWake();
  runNextOverlayFrame();
  assert.equal(
    overlayAnimationFrames.size,
    1,
    "an animated layer must keep the animation frame loop active",
  );
  state.animated = false;
  runNextOverlayFrame();
  assert.equal(
    overlayAnimationFrames.size,
    0,
    "an animation becoming idle must allow the loop to sleep",
  );
  assert.equal(
    overlayWakeTimers.size,
    1,
    "an idle animation must restore the camera/update wake timer",
  );
  state.enabled = false;
  overlaySandbox.__overlayScheduler.requestMapOverlayLoop();
  assert.equal(overlayWakeTimers.size, 0, "disabling the last layer must cancel its wake timer");
  assert.equal(
    state.removedCanvases,
    1,
    "disabling the last layer must tear down the canvas while asleep",
  );
  state.enabled = true;
  overlaySandbox.__overlayScheduler.requestMapOverlayLoop();
  assert.equal(overlayAnimationFrames.size, 1, "re-enabling a layer must restart the scheduler");
  runNextOverlayFrame();
  assert.equal(state.draws, 6, "a restarted layer must draw again");
}
