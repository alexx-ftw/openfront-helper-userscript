import assert from "node:assert/strict";
import {
  createContextCacheSandbox,
  NEGATIVE_SIGNAL_CASES,
  resetSignals,
  seedContextElement,
  START_SIGNAL_CASES,
} from "./context-cache-sandbox.mjs";
import { checkContextModalCache } from "./context-cache-modal-tests.mjs";

function checkEmptyDomNegativeCache() {
  const { state, sandbox } = createContextCacheSandbox();
  state.now = 1000;
  assert.equal(sandbox.getOpenFrontGameContext(), null, "empty menu DOM yields no context");
  assert.equal(state.scanCount, 1, "first contextless getter call must scan exactly once");
  for (let step = 1; step <= 10; step += 1) {
    state.now = 1000 + step * 10;
    assert.equal(sandbox.getOpenFrontGameContext(), null, `menu call ${step} stays null`);
  }
  assert.equal(state.scanCount, 1, "250ms window must not repeat the profile scan");
  assert.equal(state.modalQueryCount, 1, "negative modal lookup is cached for the miss window");
}

function checkNonSlidingWindow() {
  const { state, sandbox } = createContextCacheSandbox();
  state.now = 2000;
  sandbox.getOpenFrontGameContext();
  assert.equal(state.scanCount, 1, "arming the miss window must scan once");
  for (const now of [2050, 2100, 2150, 2200, 2249]) {
    state.now = now;
    sandbox.getOpenFrontGameContext();
  }
  assert.equal(state.scanCount, 1, "hits inside the window must not extend it or rescan");
  state.now = 2250;
  sandbox.getOpenFrontGameContext();
  assert.equal(state.scanCount, 2, "at 250ms expiry exactly one fresh scan must run");
  for (const now of [2260, 2300]) {
    state.now = now;
    sandbox.getOpenFrontGameContext();
  }
  assert.equal(state.scanCount, 2, "re-armed window must suppress repeat scans again");
}

function checkIdleMenuBackoff() {
  const { state, sandbox } = createContextCacheSandbox();
  const getContext = sandbox.getOpenFrontGameContext;
  const schedule = [
    [1000, 1],
    [1250, 2],
    [1500, 3],
    [1750, 4],
    [2000, 4],
    [2749, 4],
    [2750, 5],
    [3000, 5],
    [3749, 5],
    [3750, 6],
  ];
  for (const [now, expected] of schedule) {
    state.now = now;
    getContext();
    assert.equal(state.scanCount, expected, `idle-menu scan budget at ${now}ms`);
  }
  state.bodyInGame = true;
  state.now = 3760;
  getContext();
  assert.equal(state.scanCount, 7, "start signal bypasses the backoff window");
  state.bodyInGame = false;
  state.now = 3770;
  getContext();
  assert.equal(state.scanCount, 8, "post-signal miss re-arms immediately");
  state.now = 4020;
  getContext();
  assert.equal(state.scanCount, 9, "fast 250ms window is restored after reset");
}

function checkContextAppearsAtExpiry() {
  const { state, sandbox } = createContextCacheSandbox();
  state.now = 3000;
  assert.equal(sandbox.getOpenFrontGameContext(), null, "no context before seeding");
  assert.equal(state.scanCount, 1, "first contextless call must scan once");
  const element = seedContextElement();
  state.elements.push(element);
  state.now = 3250;
  const context = sandbox.getOpenFrontGameContext();
  assert.equal(state.scanCount, 2, "expired window must allow the discovery scan");
  assert.equal(context?.game, element.game, "getter returns discovered game identity");
  assert.equal(context?.transform, element.transformHandler, "getter returns the transform");
  assert.equal(sandbox.runtimeState.lastOpenFrontGameContext, context, "discovery is kept");
}

function checkStartSignalBypass() {
  const { state, sandbox } = createContextCacheSandbox();
  const getContext = sandbox.getOpenFrontGameContext;
  let now = 1000;
  state.now = now;
  getContext();
  assert.equal(state.scanCount, 1, "arming call must scan once before bypass checks");
  for (const signal of START_SIGNAL_CASES) {
    signal.activate(state);
    // The modal element lookup is throttled to the 250ms miss-window cadence,
    // so its case must cross the lookup TTL while staying inside the window.
    now += signal.label === "visible starting modal" ? 170 : 10;
    state.now = now;
    const before = state.scanCount;
    getContext();
    assert.equal(state.scanCount, before + 1, `${signal.label} bypasses the miss window`);
    if (signal.label === "visible starting modal") {
      assert.ok(state.modalQueryCount >= 2, "expired modal lookup cache re-queries the DOM");
    }
    resetSignals(state);
    now += 10;
    state.now = now;
    getContext();
    assert.equal(state.scanCount, before + 2, `${signal.label} resets the miss timestamp`);
    now += 10;
    state.now = now;
    getContext();
    assert.equal(state.scanCount, before + 2, `${signal.label} leaves re-armed suppression`);
  }
}

function checkNegativeControlsKeepSuppressing() {
  const { state, sandbox } = createContextCacheSandbox();
  const getContext = sandbox.getOpenFrontGameContext;
  let now = 3000;
  state.now = now;
  getContext();
  assert.equal(state.scanCount, 1, "arming call must scan once before negative controls");
  for (const signal of NEGATIVE_SIGNAL_CASES) {
    signal.activate(state);
    now += 10;
    state.now = now;
    getContext();
    assert.equal(state.scanCount, 1, `${signal.label} must not bypass the miss window`);
  }
}

function checkPositiveCacheSemantics() {
  const { state, sandbox } = createContextCacheSandbox();
  const { runtimeState } = sandbox;
  const element = seedContextElement();
  state.elements.push(element);
  state.now = 0;
  const context = sandbox.getOpenFrontGameContext();
  assert.equal(state.scanCount, 1, "first call must scan exactly once");
  assert.equal(context?.game, element.game, "getter returns the discovered game");
  assert.equal(context?.transform, element.transformHandler, "getter finds the transform");
  assert.equal(runtimeState.lastOpenFrontGameContext, context, "discovery must be remembered");
  state.now = 999;
  assert.equal(sandbox.getOpenFrontGameContext(), context, "+999ms returns the same object");
  assert.equal(state.scanCount, 1, "cached window must not rescan");
  state.now = 1000;
  const fresh = sandbox.getOpenFrontGameContext();
  assert.equal(state.scanCount, 2, "expiry must run exactly one rediscovery scan");
  assert.equal(fresh?.game, element.game, "rediscovery carries the game identity");
  assert.equal(fresh?.transform, element.transformHandler, "rediscovery finds the transform");
  assert.equal(runtimeState.lastOpenFrontGameContext, fresh, "rediscovery must be remembered");
}

export function checkContextMissCache() {
  checkEmptyDomNegativeCache();
  checkNonSlidingWindow();
  checkIdleMenuBackoff();
  checkContextModalCache();
  checkContextAppearsAtExpiry();
  checkStartSignalBypass();
  checkNegativeControlsKeepSuppressing();
  checkPositiveCacheSemantics();
}
