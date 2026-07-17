import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js");
const source = fs.readFileSync(sourcePath, "utf8");

let callsSinceYield = 0;
let maxCallsBetweenYields = 0;
let yieldCount = 0;
let deadlineNow = 0;
const sandbox = {
  Date: { now: () => 0 },
  window: {
    __OFH_deadlineNow: () => deadlineNow,
    setTimeout(callback, delay) {
      assert.equal(delay, 0, "route-search yields must resume on the next task");
      maxCallsBetweenYields = Math.max(maxCallsBetweenYields, callsSinceYield);
      callsSinceYield = 0;
      yieldCount += 1;
      deadlineNow += 1;
      callback();
      return yieldCount;
    },
  },
};
executeClassicScript(source, sandbox, { filename: sourcePath });

const goal = 4096;
const result = await sandbox.findWaterRouteTicksAsync({
  start: 0,
  goal,
  neighbors(tile) {
    callsSinceYield += 1;
    return tile < goal ? [tile + 1] : [];
  },
  isWater: () => true,
  maxTicks: goal,
  maxVisited: goal + 1,
  deadlineMs: 10_000,
});
maxCallsBetweenYields = Math.max(maxCallsBetweenYields, callsSinceYield);

assert.equal(result, goal, "yielding must preserve the shortest route");
assert.ok(yieldCount >= 31, "a wide search must yield repeatedly");
assert.ok(
  maxCallsBetweenYields <= 64,
  `route search performed ${maxCallsBetweenYields} expansions without yielding`,
);

console.warn("frame-stall regression tests passed");
