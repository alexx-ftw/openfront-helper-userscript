import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RATE_LIMIT_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/intent-rate-limit.js"),
  "utf8",
);
const CONTEXT_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/auto-bot/context.js"),
  "utf8",
);
const WS_HOOK_SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/ws-hook.js"), "utf8");
const BUILD_SOURCE = fs.readFileSync(path.join(ROOT, "build.mjs"), "utf8");

function createSandbox() {
  let now = 0;
  const emitted = [];
  const eventBus = { emit: (event) => emitted.push(event) };
  const buildMenu = { eventBus };
  const sandbox = {
    Date: { now: () => now },
    Math,
    Number,
    Object,
    String,
    console,
    document: {
      querySelector: (selector) => (selector === "build-menu" ? buildMenu : null),
    },
    window: {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    `${RATE_LIMIT_SOURCE}\n${CONTEXT_SOURCE}\nglobalThis.__intentTest = { emitIntent, getIntentRateLimitSnapshot, hasIntentRateLimitCapacity };`,
    sandbox,
    { filename: path.join(ROOT, "engine/ingame/intent-rate-limit.js") },
  );
  return {
    api: sandbox.__intentTest,
    emitted,
    setNow: (value) => {
      now = value;
    },
  };
}

class TestIntent {
  constructor(...args) {
    this.args = args;
  }
}

const perSecond = createSandbox();
for (let i = 0; i < 10; i += 1) {
  assert.equal(
    perSecond.api.emitIntent(TestIntent, i),
    true,
    "the first ten intents in a burst should be emitted locally",
  );
}
assert.equal(
  perSecond.api.emitIntent(TestIntent, 10),
  false,
  "the eleventh immediate intent must be held locally",
);
assert.equal(perSecond.emitted.length, 10);
perSecond.setNow(99);
assert.equal(
  perSecond.api.emitIntent(TestIntent, 11),
  false,
  "less than one tenth of a second must not refill a full token",
);
perSecond.setNow(100);
assert.equal(
  perSecond.api.emitIntent(TestIntent, 12),
  true,
  "one tenth of a second should refill one per-second token",
);

const perMinute = createSandbox();
let accepted = 0;
for (let i = 0; i < 300; i += 1) {
  perMinute.setNow(i * 200);
  if (perMinute.api.emitIntent(TestIntent, i)) accepted += 1;
}
assert.equal(accepted, 299, "the 150/minute bucket must apply after the initial burst and refill");
assert.equal(
  perMinute.api.emitIntent(TestIntent, 300),
  false,
  "the minute bucket must reject before one token refills",
);
assert.equal(
  perMinute.api.hasIntentRateLimitCapacity(),
  false,
  "a depleted bucket must be observable without consuming another rejection",
);
perMinute.setNow(60000);
assert.equal(
  perMinute.api.emitIntent(TestIntent, 301),
  true,
  "the minute bucket should refill continuously rather than impose a fixed cooldown",
);
assert.equal(
  perMinute.api.hasIntentRateLimitCapacity(),
  false,
  "one refilled token is consumed by the next emitted intent",
);

const snapshot = perMinute.api.getIntentRateLimitSnapshot();
assert.equal(snapshot.intentsPerSecond, 10);
assert.equal(snapshot.intentsPerMinute, 150);
assert.ok(snapshot.rejected >= 1, "local backpressure should be observable");

assert.match(
  WS_HOOK_SOURCE,
  /tryAcquireIntentRateLimit\(\)/,
  "direct WebSocket intent fallback must use the shared budget",
);
assert.match(
  BUILD_SOURCE,
  /"intent-rate-limit\.js"/,
  "the shared budget must be included before the WebSocket bridge in builds",
);

process.stdout.write("INTENT RATE LIMIT OK — 10/s and 150/min client budget enforced\n");
