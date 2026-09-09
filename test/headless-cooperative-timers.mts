import assert from "node:assert/strict";
import {
  createBuildMenu,
  createBundledOpponentHarness,
} from "../scripts/headless/opponent-adapter.js";

const harness = createBundledOpponentHarness();
const bot = { harness, game: {}, clientID: "build-fixture", intentBuffer: [] };
const menu = createBuildMenu(bot);
const buildCtor = harness.internals.discoverCtors(menu.eventBus).buildUnit;
assert.equal(typeof buildCtor, "function", "headless exposes the native build event constructor");
menu.eventBus.emit(new buildCtor("City", 0, false));
assert.deepEqual(
  bot.intentBuffer,
  [{ type: "build_unit", unit: "City", tile: 0, rocketDirectionUp: false }],
  "a direct zero-tile build must not be misclassified as a spawn intent",
);
for (let tick = 0; tick < 10; tick++) {
  let resumed = false;
  harness.window.setTimeout(() => {
    resumed = true;
  }, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumed, true, "a cooperative slice must resume before the next engine tick");
}
let cancelledRan = false;
const cancelled = harness.window.setTimeout(() => {
  cancelledRan = true;
}, 0);
harness.window.clearTimeout(cancelled);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(cancelledRan, false, "cancelled cooperative callbacks must not execute");
harness.window.close();
console.log("headless cooperative timer checks passed");
