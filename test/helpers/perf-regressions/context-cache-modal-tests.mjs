import assert from "node:assert/strict";
import { createContextCacheSandbox } from "./context-cache-sandbox.mjs";

export function checkContextModalCache() {
  checkModalCacheExpiryDuringBackoff();
  checkCheapStartSignalsSkipModalLookup();
}

function checkModalCacheExpiryDuringBackoff() {
  const { state, sandbox } = createContextCacheSandbox();
  const getContext = sandbox.getOpenFrontGameContext;
  for (const now of [1000, 1250, 1500, 1750, 2000]) {
    state.now = now;
    getContext();
  }
  assert.equal(state.scanCount, 4, "idle backoff is active before modal appears");
  state.modal = { isVisible: true, isConnected: true, classList: { contains: () => false } };
  state.now = 2010;
  getContext();
  assert.equal(state.scanCount, 4, "cached negative modal lookup avoids an early scan");
  state.now = 2250;
  getContext();
  assert.equal(state.scanCount, 5, "modal refresh bypasses the longer idle backoff");
  assert.equal(state.modalQueryCount, 6, "modal lookup refreshes at its 250ms boundary");
}

function checkCheapStartSignalsSkipModalLookup() {
  const { state, sandbox } = createContextCacheSandbox();
  state.now = 1000;
  state.bodyInGame = true;
  sandbox.getOpenFrontGameContext();
  assert.equal(state.modalQueryCount, 0, "body signal avoids modal selector work");
  state.bodyInGame = false;
  state.location = { pathname: "/w2/game/id", search: "?live" };
  state.now = 2000;
  sandbox.getOpenFrontGameContext();
  assert.equal(state.modalQueryCount, 0, "live route avoids modal selector work");
}
