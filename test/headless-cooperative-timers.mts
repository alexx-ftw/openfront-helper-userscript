import assert from "node:assert/strict";
import { createBundledOpponentHarness } from "../scripts/headless/opponent-adapter.js";

const harness = createBundledOpponentHarness();
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
