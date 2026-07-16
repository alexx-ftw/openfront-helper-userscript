// Client-side intent budget. This mirrors the server's
// ClientMsgRateLimiter: 10 intents per second and 150 intents per minute per
// client. Keeping the gate here lets both EventBus and direct WebSocket paths
// share the same budget.

"use strict";

const OFH_INTENTS_PER_SECOND = 10;
const OFH_INTENTS_PER_MINUTE = 150;
const OFH_SECOND_MS = 1000;
const OFH_MINUTE_MS = 60000;

const _intentRateLimitState = {
  secondTokens: OFH_INTENTS_PER_SECOND,
  minuteTokens: OFH_INTENTS_PER_MINUTE,
  lastRefillMs: Date.now(),
  accepted: 0,
  rejected: 0,
};

function _refillIntentRateLimit(now) {
  const currentMs = Number.isFinite(now) ? now : Date.now();
  const elapsedMs = Math.max(0, currentMs - _intentRateLimitState.lastRefillMs);
  if (elapsedMs <= 0) return;

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

// Returns true only when the local client budget has reserved one intent.
// Callers must not emit/send after receiving false.
function tryAcquireIntentRateLimit() {
  _refillIntentRateLimit(Date.now());
  if (
    _intentRateLimitState.secondTokens < 1 ||
    _intentRateLimitState.minuteTokens < 1
  ) {
    _intentRateLimitState.rejected += 1;
    return false;
  }

  _intentRateLimitState.secondTokens -= 1;
  _intentRateLimitState.minuteTokens -= 1;
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
    _intentRateLimitState.minuteTokens >= 1
  );
}

function getIntentRateLimitSnapshot() {
  _refillIntentRateLimit(Date.now());
  return {
    intentsPerSecond: OFH_INTENTS_PER_SECOND,
    intentsPerMinute: OFH_INTENTS_PER_MINUTE,
    secondTokens: Math.max(0, _intentRateLimitState.secondTokens),
    minuteTokens: Math.max(0, _intentRateLimitState.minuteTokens),
    accepted: _intentRateLimitState.accepted,
    rejected: _intentRateLimitState.rejected,
  };
}
