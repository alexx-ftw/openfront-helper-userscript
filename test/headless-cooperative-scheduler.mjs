import assert from "node:assert/strict";
import { createBundledOpponentHarness } from "../scripts/headless/opponent-adapter.js";

const { window } = createBundledOpponentHarness();
const work = [];
const slice = () => {
  work.push(work.length + 1);
  if (work.length < 10) window.setTimeout(slice, 0);
};
let cancelled = false;
const cancelledSlice = window.setTimeout(() => {
  cancelled = true;
}, 0);
window.clearTimeout(cancelledSlice);
window.setTimeout(slice, 0);

for (let tick = 1; tick <= 10; tick++) {
  // The runner uses this same boundary. Host timer granularity and elapsed
  // CPU time must not move a cooperative slice to a different game tick.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(work.length, tick, "one cooperative slice advances per queued tick boundary");
}
assert.equal(cancelled, false, "a cancelled cooperative slice never executes");

let expired = false;
const deadline = window.setTimeout(() => {
  expired = true;
}, 10);
window.clearTimeout(deadline);
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
assert.equal(expired, false, "real worker deadlines remain cancellable");
window.close();
console.warn("headless cooperative scheduler tests passed");
