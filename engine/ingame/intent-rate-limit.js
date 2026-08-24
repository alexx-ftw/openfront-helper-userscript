// Client-side intent budget. This mirrors the server's
// ClientMsgRateLimiter: 10 intents per second and 150 intents per minute per
// client. Keeping the gate here lets both EventBus and direct WebSocket paths
// share the same budget.
//
// The server limiter (npm limiter@3) is a token bucket PLUS a per-interval
// spend cap: at most `tokensPerInterval` removals inside each anchored
// interval window, regardless of how many tokens the continuous drip has
// restored mid-window. A drip-only mirror is therefore too permissive in
// bursts — the client happily spends mid-window dripped tokens that the
// server's window accounting rejects, and the server silently drops them.
// This mirror replicates BOTH axes. Because the server's window anchors at
// its first observed message (unknowable client-side), the effective caps
// stay one notch below the true limits so a boundary straddle between the
// two window phases cannot overflow the server window.

"use strict";

const OFH_INTENTS_PER_SECOND = 10;
const OFH_INTENTS_PER_MINUTE = 150;
const OFH_SECOND_MS = 1000;
const OFH_MINUTE_MS = 60000;
// Effective per-window spend caps (see the header): one burst token below
// the server's per-second cap and ten below the per-minute cap absorb the
// client/server window-anchor misalignment and the user's own clicks.
const OFH_SECOND_WINDOW_SPEND_CAP = 9;
const OFH_MINUTE_WINDOW_SPEND_CAP = 140;

// Shared through globalThis so a hot-reloaded Auto-Bot layer continues the
// same budget instead of resetting it (two overlapping instances would
// otherwise each carry a fresh 10/150 allowance).
const _intentRateLimitState = (globalThis.__OFH_intentRateLimitState ??= {
  secondTokens: OFH_INTENTS_PER_SECOND,
  minuteTokens: OFH_INTENTS_PER_MINUTE,
  secondWindowStartMs: Number.NEGATIVE_INFINITY,
  secondWindowSpent: 0,
  minuteWindowStartMs: Number.NEGATIVE_INFINITY,
  minuteWindowSpent: 0,
  lastRefillMs: Date.now(),
  accepted: 0,
  rejected: 0,
  lastDropLogMs: Number.NEGATIVE_INFINITY,
});

function _rollIntentRateLimitWindows(currentMs) {
  if (currentMs - _intentRateLimitState.secondWindowStartMs >= OFH_SECOND_MS) {
    _intentRateLimitState.secondWindowStartMs = currentMs;
    _intentRateLimitState.secondWindowSpent = 0;
  }
  if (currentMs - _intentRateLimitState.minuteWindowStartMs >= OFH_MINUTE_MS) {
    _intentRateLimitState.minuteWindowStartMs = currentMs;
    _intentRateLimitState.minuteWindowSpent = 0;
  }
}

function _refillIntentRateLimit(now) {
  const currentMs = Number.isFinite(now) ? now : Date.now();
  const elapsedMs = Math.max(0, currentMs - _intentRateLimitState.lastRefillMs);
  if (elapsedMs > 0) {
    _intentRateLimitState.secondTokens = Math.min(
      OFH_INTENTS_PER_SECOND,
      _intentRateLimitState.secondTokens +
        (elapsedMs / OFH_SECOND_MS) * OFH_INTENTS_PER_SECOND,
    );
    _intentRateLimitState.minuteTokens = Math.min(
      OFH_INTENTS_PER_MINUTE,
      _intentRateLimitState.minuteTokens +
        (elapsedMs / OFH_MINUTE_MS) * OFH_INTENTS_PER_MINUTE,
    );
    _intentRateLimitState.lastRefillMs = currentMs;
  }
  _rollIntentRateLimitWindows(currentMs);
}

function _intentRateLimitWindowBlocked() {
  return (
    _intentRateLimitState.secondWindowSpent >= OFH_SECOND_WINDOW_SPEND_CAP ||
    _intentRateLimitState.minuteWindowSpent >= OFH_MINUTE_WINDOW_SPEND_CAP
  );
}

// Surface drops where a live player can see them: without this the local
// gate fails invisibly and the only symptom is the server dropping work.
// Throttled so a saturated producer cannot spam the console.
function _logIntentRateLimitDrop(currentMs) {
  if (currentMs - _intentRateLimitState.lastDropLogMs < 2000) return;
  _intentRateLimitState.lastDropLogMs = currentMs;
  if (typeof runtimeDebugLog === "function") {
    runtimeDebugLog(
      "[IntentRateLimit] intent dropped: shared budget exhausted",
      {
        accepted: _intentRateLimitState.accepted,
        rejected: _intentRateLimitState.rejected,
      },
    );
  }
}

// Returns true only when the local client budget has reserved one intent.
// Callers must not emit/send after receiving false.
function tryAcquireIntentRateLimit() {
  const currentMs = Date.now();
  _refillIntentRateLimit(currentMs);
  if (
    _intentRateLimitState.secondTokens < 1 ||
    _intentRateLimitState.minuteTokens < 1 ||
    _intentRateLimitWindowBlocked()
  ) {
    _intentRateLimitState.rejected += 1;
    _logIntentRateLimitDrop(currentMs);
    return false;
  }

  _intentRateLimitState.secondTokens -= 1;
  _intentRateLimitState.minuteTokens -= 1;
  _intentRateLimitState.secondWindowSpent += 1;
  _intentRateLimitState.minuteWindowSpent += 1;
  _intentRateLimitState.accepted += 1;
  return true;
}

// Batch producers use this non-consuming check to stop before attempting an
// intent that would only be rejected by the consuming gate. The final emit must
// still call tryAcquireIntentRateLimit() because other producers share the
// same budget.
function hasIntentRateLimitCapacity() {
  _refillIntentRateLimit(Date.now());
  return (
    _intentRateLimitState.secondTokens >= 1 &&
    _intentRateLimitState.minuteTokens >= 1 &&
    !_intentRateLimitWindowBlocked()
  );
}

function getIntentRateLimitSnapshot() {
  _refillIntentRateLimit(Date.now());
  return {
    intentsPerSecond: OFH_INTENTS_PER_SECOND,
    intentsPerMinute: OFH_INTENTS_PER_MINUTE,
    secondTokens: Math.max(0, _intentRateLimitState.secondTokens),
    minuteTokens: Math.max(0, _intentRateLimitState.minuteTokens),
    secondWindowSpent: _intentRateLimitState.secondWindowSpent,
    minuteWindowSpent: _intentRateLimitState.minuteWindowSpent,
    accepted: _intentRateLimitState.accepted,
    rejected: _intentRateLimitState.rejected,
  };
}
