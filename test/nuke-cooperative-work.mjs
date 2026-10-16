import assert from "node:assert/strict";
import fs from "node:fs";
import { executeClassicScript } from "./helpers/classic-script.mjs";
let clock = 0;
let scheduled = 0;
let active = true;
const sandbox = {
  performance: { now: () => ++clock },
  window: {
    setTimeout: (callback) => {
      scheduled++;
      setTimeout(callback, 0);
    },
  },
};
executeClassicScript(
  fs.readFileSync(new URL("../engine/ingame/nuke-suggestions.js", import.meta.url), "utf8"),
  sandbox,
);
executeClassicScript(
  "globalThis.api = { drainNukeSuggestionWork, runNukeSuggestionWork };",
  sandbox,
);
function* work() {
  let sum = 0;
  for (let i = 0; i < 100; i++) {
    sum += i;
    yield;
  }
  return sum;
}
assert.equal(
  await sandbox.api.runNukeSuggestionWork(work()),
  sandbox.api.drainNukeSuggestionWork(work()),
  "cooperative work preserves exact deterministic result",
);
assert.ok(scheduled > 1, "long work yields repeatedly to browser tasks");
let finalized = false;
function* canceledWork() {
  try {
    for (let i = 0; i < 100; i++) {
      yield;
    }
    return "must not publish";
  } finally {
    finalized = true;
  }
}
const canceled = sandbox.api.runNukeSuggestionWork(canceledWork(), () => active);
active = false;
assert.equal(await canceled, null, "canceled work never exposes a partial result");
assert.equal(finalized, true, "canceled generator releases its suspended state");
console.warn("nuke cooperative work tests passed");
executeClassicScript(
  fs.readFileSync(new URL("../engine/ingame/nuke-impact.js", import.meta.url), "utf8"),
  sandbox,
);
executeClassicScript(
  "globalThis.real = { optimizeNukeSuggestionCandidateForBuildingImpact, iterateOptimizeNukeSuggestionCandidateForBuildingImpact };",
  sandbox,
);
sandbox.scoreNukeSuggestionTile = (_game, _context, tile) => ({ tile, totalScore: tile + 100 });
const game = { x: (tile) => tile, y: () => 0, euclideanDistSquared: (a, b) => (a - b) ** 2 };
const context = {
  scoreMode: "economic",
  magnitude: { outer: 30 },
  structures: Array.from({ length: 1000 }, (_, i) => ({ tile: i % 200 })),
};
const candidate = { tile: 0, totalScore: 1 };
const expected = sandbox.real.optimizeNukeSuggestionCandidateForBuildingImpact(
  game,
  context,
  candidate,
);
const actual = await sandbox.api.runNukeSuggestionWork(
  sandbox.real.iterateOptimizeNukeSuggestionCandidateForBuildingImpact(game, context, candidate),
);
assert.deepEqual(
  actual,
  expected,
  "actual building optimizer returns identical ranking/coordinate through cooperative caller",
);
executeClassicScript("globalThis.publishWork = publishNukeSuggestionWork;", sandbox);
sandbox.runtimeState = {
  currentNukeSuggestionResults: ["previous"],
  lastNukeSuggestionSignature: "previous",
};
sandbox.iterateComputeNukeSuggestions = function* () {
  yield;
  return ["new"];
};
sandbox.isEnemyNukeSuggestionTarget = () => true;
sandbox.getNukeSuggestionSignature = () => "changed";
await sandbox.publishWork({}, {}, { signature: "old" }, () => true);
assert.deepEqual(
  sandbox.runtimeState.currentNukeSuggestionResults,
  ["previous"],
  "a changed world signature cannot publish stale computed results",
);
sandbox.getNukeSuggestionSignature = () => "old";
await sandbox.publishWork({}, {}, { signature: "old" }, () => false);
assert.deepEqual(
  sandbox.runtimeState.currentNukeSuggestionResults,
  ["previous"],
  "an inactive overlay cannot replace the last complete results",
);
executeClassicScript("globalThis.executeAction = executeAutoNuke;", sandbox);
let validTarget = true;
let poolComputations = 0;
let launches = 0;
let resolvePool;
sandbox.isAutoNukeRadialItemDisabled = () => false;
sandbox.canContinueAutoNukeSecondPass = () => validTarget;
sandbox.getAutoNukeTierPlanOptions = () => null;
sandbox.getAutoNukeActionPlan = () => ({ shots: [], score: 0 });
sandbox.computeAutoNukeCandidatePoolAsync = () => {
  poolComputations++;
  return new Promise((resolve) => {
    resolvePool = resolve;
  });
};
sandbox.launchAutoNukeCandidate = async () => {
  launches++;
  return true;
};
const actionPool = {
  baseContext: {},
  candidates: [{ tile: 4, spec: { scoreMode: "population" } }],
};
clock = 2000;
const firstAction = sandbox.executeAction({}, "population");
assert.equal(poolComputations, 1, "direct action awaits a cooperative pool");
assert.equal(launches, 0);
resolvePool(actionPool);
await firstAction;
assert.equal(launches, 1);
assert.equal(
  poolComputations,
  1,
  "fallback reuses the existing pool instead of running another synchronous scan",
);
clock = 4000;
const staleAction = sandbox.executeAction({}, "population");
validTarget = false;
resolvePool(actionPool);
await staleAction;
assert.equal(
  launches,
  1,
  "target becoming invalid during cooperative planning prevents the direct fallback launch",
);
