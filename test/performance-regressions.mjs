import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/shared-utils.js");

const sandbox = {
  Array,
  Map,
  Math,
  Number,
  String,
  document: {},
  CSS: { escape: (value) => String(value) },
  globalThis: null,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });

let tick = 10;
let unitsCalls = 0;
const game = {
  ticks: () => tick,
  units: (...types) => {
    unitsCalls += 1;
    return [{ types }];
  },
};

const first = sandbox.getCachedGameUnits(game, "Warship");
const second = sandbox.getCachedGameUnits(game, "Warship");
assert.strictEqual(second, first, "same unit family should reuse the per-tick snapshot");
assert.equal(unitsCalls, 1, "same unit family should call GameView.units once per tick");

sandbox.getCachedGameUnits(game, "Missile Silo", "SAM Launcher");
assert.equal(unitsCalls, 2, "different unit families keep independent cached snapshots");

tick += 1;
const nextTick = sandbox.getCachedGameUnits(game, "Warship");
assert.notStrictEqual(nextTick, first, "a new game tick must invalidate unit snapshots");
assert.equal(unitsCalls, 3, "a new game tick should refresh the requested family once");

const ENGINE_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/engine.js");
const intervalEvents = [];
let nextTimerId = 1;
const engineSandbox = {
  state: {
    settings: { enabled: true, tickMs: 200 },
    speed: { factor: 1 },
    tickTimer: null,
    tickIntervalMs: 0,
    tickInFlight: false,
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
vm.runInNewContext(
  `${fs.readFileSync(ENGINE_SOURCE, "utf8")}\nglobalThis.__engine = { startEngine, retuneEngine, stopEngine };`,
  engineSandbox,
  { filename: ENGINE_SOURCE },
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

console.log("performance regression tests passed");
