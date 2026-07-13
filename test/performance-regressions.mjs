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

console.log("performance regression tests passed");
