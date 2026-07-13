import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUKE_SUGGESTIONS_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/nuke-suggestions.js"),
  "utf8",
);

const sandbox = {
  console,
  document: {},
  window: { setTimeout, clearTimeout },
  performance: { now: () => 0 },
  toFiniteNumber: (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback,
  getPlayerSmallId: () => NaN,
  getUnitLevel: (unit) => Number(unit?.level?.() || 1),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  UniversalPathFinding: {
    Parabola: () => ({
      findPath: () => [0, 1, 2, 3, 4],
    }),
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(NUKE_SUGGESTIONS_SOURCE, sandbox, {
  filename: "nuke-suggestions.js",
});

const game = {
  ticks: () => 0,
  config: () => ({
    defaultNukeSpeed: () => 1,
    defaultNukeTargetableRange: () => 100,
    defaultSamMissileSpeed: () => 1,
    maxSamRange: () => 100,
    samRange: () => 0.1,
    SAMCooldown: () => 90,
  }),
  x: (tile) => tile,
  y: () => 0,
  ref: (x) => x,
  isValidCoord: () => true,
  euclideanDistSquared: (a, b) => (a - b) ** 2,
  manhattanDist: (a, b) => Math.abs(a - b),
};

function pendingSam(id) {
  return {
    id: () => id,
    tile: () => 2,
    level: () => 1,
    missileTimerQueue: () => [],
    isActive: () => true,
    isUnderConstruction: () => true,
  };
}

const readyAtPass = pendingSam("ready-at-pass");
const readyAtPassResult = sandbox.findInterceptingSams(
  game,
  0,
  4,
  [],
  true,
  [readyAtPass],
  new Map([["ready-at-pass", 2]]),
);
assert.deepEqual(
  Array.from(readyAtPassResult, (sam) => sam.id()),
  ["ready-at-pass"],
  "a SAM that completes when the missile reaches its influence area must be predicted",
);
const directionPlan = sandbox.chooseBestNukeRocketDirection(
  game,
  0,
  4,
  [],
  [readyAtPass],
  new Map([["ready-at-pass", 2]]),
);
assert.equal(
  directionPlan.interceptingSams.length,
  1,
  "rocket-direction selection must use the pending-SAM trajectory result",
);

const readyTooLate = pendingSam("ready-too-late");
const readyTooLateResult = sandbox.findInterceptingSams(
  game,
  0,
  4,
  [],
  true,
  [readyTooLate],
  new Map([["ready-too-late", 3]]),
);
assert.deepEqual(
  readyTooLateResult.length,
  0,
  "a SAM that completes after the missile passes its influence area must not be predicted",
);

const stateReadySam = pendingSam("state-ready");
stateReadySam.state = { constructionStartTick: 98 };
const stateReadyGame = {
  ...game,
  ticks: () => 100,
  config: () => ({
    ...game.config(),
    unitInfo: () => ({ constructionDuration: 2 }),
  }),
};
const stateReadyResult = sandbox.findInterceptingSams(stateReadyGame, 0, 4, [], true, [
  stateReadySam,
]);
assert.deepEqual(
  Array.from(stateReadyResult, (sam) => sam.id()),
  ["state-ready"],
  "the predictor must use an exposed construction start tick when available",
);

console.log("nuke suggestion construction tests passed");
