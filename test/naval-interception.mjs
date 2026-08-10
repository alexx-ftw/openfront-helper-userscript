import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/naval-interception.js"),
  "utf8",
);
const gameApiSource = fs.readFileSync(path.join(root, "engine/ingame/auto-bot/gameApi.js"), "utf8");
const warshipSource = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/warshipBehavior.js"),
  "utf8",
);
assert.match(
  gameApiSource,
  /forEachNeighbor:\s*\(tile, callback\).*src\.neighbors\(tile\)/s,
  "the client-shaped game API must expose the core neighbor callback used by warships",
);
assert.match(
  gameApiSource,
  /isFriendly:\s*\(other\)\s*=>\s*wrapPlayer\(u\.owner\(\)\)\?\.isFriendly\(other\)/,
  "wrapped units must expose owner-relative friendliness for warship targeting",
);
assert.match(
  warshipSource,
  /buildUncoveredInterceptor\(plan, invasions, smartState, timing\)[\s\S]*state\.settings\.warshipAutoSpawn/,
  "naval interceptor state must not shadow the global settings state",
);
const sandbox = {};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${source}\nglobalThis.planNavalInterceptions = planNavalInterceptions;`,
  sandbox,
  {
    filename: "naval-interception.js",
  },
);

const planNavalInterceptions = sandbox.planNavalInterceptions;
assert.equal(typeof planNavalInterceptions, "function");

const tile = (x, y) => `${x},${y}`;
const coords = (value) => value.split(",").map(Number);
const distance = (a, b) => {
  const [ax, ay] = coords(a);
  const [bx, by] = coords(b);
  return Math.hypot(ax - bx, ay - by);
};

function route(from, to) {
  const [fx, fy] = coords(from);
  const [tx, ty] = coords(to);
  const result = [from];
  let x = fx;
  let y = fy;
  while (x !== tx) {
    x += Math.sign(tx - x);
    result.push(tile(x, y));
  }
  while (y !== ty) {
    y += Math.sign(ty - y);
    result.push(tile(x, y));
  }
  return result;
}

const speedSensitive = planNavalInterceptions({
  ships: [{ id: "destroyer-1", tile: tile(0, 0) }],
  invasions: [
    {
      id: "invasion-1",
      path: [tile(4, 0), tile(5, 0), tile(6, 0), tile(7, 0)],
    },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 2,
  attackRange: 2,
});
assert.equal(speedSensitive.assignments[0].interceptTick, 2);
assert.equal(speedSensitive.assignments[0].marginTicks, 1);

let lowerBoundRouteCalls = 0;
const lowerBoundRejected = planNavalInterceptions({
  ships: [{ id: "lower-bound-destroyer", tile: tile(0, 0) }],
  invasions: [
    {
      id: "unreachable-before-landing",
      path: [tile(100, 0), tile(101, 0), tile(102, 0), tile(103, 0)],
    },
  ],
  route: (from, to) => {
    lowerBoundRouteCalls++;
    return route(from, to);
  },
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.equal(lowerBoundRejected.assignments.length, 0);
assert.equal(lowerBoundRouteCalls, 0, "direct-distance impossibility skips full water routes");

let longRouteCalls = 0;
const longInvasionPath = Array.from({ length: 8192 }, (_, index) => tile(4096 + index, 0));
const longInterception = planNavalInterceptions({
  ships: [{ id: "long-range-destroyer", tile: tile(0, 0) }],
  invasions: [{ id: "long-invasion", path: longInvasionPath }],
  route: (from, to) => {
    longRouteCalls += 1;
    return route(from, to);
  },
  distance,
  boatSpeed: 1,
  warshipSpeed: 2,
  attackRange: 0,
});
assert.equal(longInterception.assignments[0].interceptTick, 4096);
assert.ok(
  longRouteCalls <= Math.ceil(Math.log2(longInvasionPath.length)) + 1,
  `long interception performed ${longRouteCalls} routes instead of a logarithmic search`,
);

function linearFirstIntercept({ shipTile, invasionPath, boatSpeed, warshipSpeed, attackRange }) {
  const arrival = Math.ceil((invasionPath.length - 1) / boatSpeed);
  for (let tick = 0; tick < arrival; tick++) {
    const pathIndex = Math.min(invasionPath.length - 1, Math.floor(tick * boatSpeed));
    const boatTile = invasionPath[pathIndex];
    const waterRoute = route(shipTile, boatTile);
    const maxReachableIndex = Math.min(waterRoute.length - 1, Math.floor(tick * warshipSpeed));
    for (let index = maxReachableIndex; index >= 0; index--) {
      if (distance(waterRoute[index], boatTile) <= attackRange) return tick;
    }
  }
  return null;
}

const equivalencePaths = [
  [tile(2, 0), tile(3, 0), tile(4, 0), tile(5, 0), tile(6, 0)],
  [tile(5, 0), tile(4, 0), tile(3, 0), tile(2, 0), tile(1, 0)],
  [tile(3, 2), tile(3, 1), tile(3, 0), tile(4, 0), tile(5, 0)],
];
for (const invasionPath of equivalencePaths) {
  for (const boatSpeed of [0.5, 1, 2]) {
    for (const warshipSpeed of [0.5, 1, 2]) {
      for (const attackRange of [0, 1, 2]) {
        const expectedTick = linearFirstIntercept({
          shipTile: tile(0, 0),
          invasionPath,
          boatSpeed,
          warshipSpeed,
          attackRange,
        });
        const planned = planNavalInterceptions({
          ships: [{ id: "equivalence-destroyer", tile: tile(0, 0) }],
          invasions: [{ id: "equivalence-invasion", path: invasionPath }],
          route,
          distance,
          boatSpeed,
          warshipSpeed,
          attackRange,
        });
        assert.equal(
          planned.assignments[0]?.interceptTick ?? null,
          expectedTick,
          `optimized interception differs from the linear oracle at boat=${boatSpeed}, warship=${warshipSpeed}, range=${attackRange}`,
        );
      }
    }
  }
}

const oneShipTwoInvasions = planNavalInterceptions({
  ships: [{ id: "destroyer-1", tile: tile(0, 0) }],
  invasions: [
    {
      id: "invasion-a",
      path: [tile(1, 0), tile(2, 0), tile(3, 0), tile(4, 0), tile(5, 0), tile(6, 0), tile(7, 0)],
    },
    {
      id: "invasion-b",
      path: [tile(7, 0), tile(6, 0), tile(5, 0), tile(4, 0), tile(3, 0), tile(2, 0), tile(1, 0)],
    },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.equal(oneShipTwoInvasions.coveredIds.length, 2);
assert.equal(oneShipTwoInvasions.assignments.length, 2);

const oneShipLimit = planNavalInterceptions({
  ships: [{ id: "destroyer-1", tile: tile(0, 0) }],
  invasions: [
    { id: "left", path: [tile(1, 0), tile(2, 0), tile(3, 0), tile(4, 0)] },
    { id: "right", path: [tile(7, 0), tile(6, 0), tile(5, 0), tile(4, 0)] },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.equal(oneShipLimit.coveredIds.length, 1);
assert.equal(oneShipLimit.uncoveredIds.length, 1);

const twoShips = planNavalInterceptions({
  ships: [
    { id: "destroyer-left", tile: tile(0, 0) },
    { id: "destroyer-right", tile: tile(8, 0) },
  ],
  invasions: [
    { id: "left", path: [tile(1, 0), tile(2, 0), tile(3, 0), tile(4, 0)] },
    { id: "right", path: [tile(7, 0), tile(6, 0), tile(5, 0), tile(4, 0)] },
  ],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 1,
});
assert.deepEqual(twoShips.uncoveredIds, []);
assert.equal(twoShips.assignments.length, 2);
assert.equal(
  JSON.stringify(
    twoShips.shipPlans.map((plan) => ({
      shipId: plan.shipId,
      invasionIds: plan.assignments.map((assignment) => assignment.invasionId),
    })),
  ),
  JSON.stringify([
    { shipId: "destroyer-left", invasionIds: ["left"] },
    { shipId: "destroyer-right", invasionIds: ["right"] },
  ]),
  "the linear assignment index preserves per-ship plan order and ownership",
);

const engineTargetConflict = planNavalInterceptions({
  ships: [
    { id: "engine-selector-left", tile: tile(0, 0) },
    { id: "engine-selector-right", tile: tile(50, 0) },
  ],
  invasions: [
    {
      id: "near-transport",
      path: [tile(60, 0), tile(61, 0), tile(62, 0)],
    },
    {
      id: "far-transport",
      path: [tile(130, 0), tile(131, 0), tile(132, 0)],
    },
  ],
  route,
  distance,
  targetDistanceSquared: (from, to) => distance(from, to) ** 2,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 130,
});
assert.deepEqual(
  engineTargetConflict.coveredIds,
  ["near-transport"],
  "the planner only covers a transport the engine would actually select from the intercept tile",
);
assert.deepEqual(
  engineTargetConflict.uncoveredIds,
  ["far-transport"],
  "a duplicate nearest-target conflict remains uncovered for the build/retry path",
);
const ambiguousEngineTie = planNavalInterceptions({
  ships: [{ id: "tie-interceptor", tile: tile(50, 0) }],
  invasions: [
    { id: "tie-left", path: [tile(40, 0), tile(39, 0)] },
    { id: "tie-right", path: [tile(60, 0), tile(61, 0)] },
  ],
  route,
  distance,
  targetDistanceSquared: (from, to) => distance(from, to) ** 2,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 130,
});
assert.deepEqual(
  ambiguousEngineTie.coveredIds,
  [],
  "an encounter-order tie is not claimed as covered without authoritative grid order",
);
assert.deepEqual(ambiguousEngineTie.uncoveredIds, ["tie-left", "tie-right"]);
const singlePassingDistractor = planNavalInterceptions({
  ships: [{ id: "distracted-interceptor", tile: tile(0, 0) }],
  invasions: [{ id: "incoming-far", path: [tile(80, 0), tile(81, 0)] }],
  targetInvasions: [{ id: "passing-near", path: [tile(20, 0), tile(19, 0)] }],
  route,
  distance,
  targetDistanceSquared: (from, to) => distance(from, to) ** 2,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 130,
});
assert.deepEqual(
  singlePassingDistractor.coveredIds,
  [],
  "a single non-incoming transport can invalidate an otherwise feasible interception",
);
assert.deepEqual(singlePassingDistractor.uncoveredIds, ["incoming-far"]);
assert.doesNotMatch(
  source,
  /assignments:\s*assignments\.filter/,
  "ship plans must not rescan every assignment once per ship",
);

const marginPath = Array.from({ length: 13 }, (_, index) => tile(index + 1, 0));
const safestExactAssignment = planNavalInterceptions({
  ships: [
    { id: "early-interceptor", tile: tile(4, 0) },
    { id: "late-interceptor", tile: tile(8, 0) },
  ],
  invasions: [{ id: "margin-invasion", path: marginPath }],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 0,
});
assert.equal(
  safestExactAssignment.assignments[0].shipId,
  "early-interceptor",
  "the exact planner chooses the interceptor with the largest safety margin",
);
assert.equal(safestExactAssignment.assignments[0].marginTicks, 10);

const safestGreedyAssignment = planNavalInterceptions({
  ships: [4, 6, 8, 10].map((x, index) => ({
    id: `greedy-interceptor-${index}`,
    tile: tile(x, 0),
  })),
  invasions: [{ id: "greedy-margin-invasion", path: marginPath }],
  route,
  distance,
  boatSpeed: 1,
  warshipSpeed: 1,
  attackRange: 0,
});
assert.equal(
  safestGreedyAssignment.assignments[0].shipId,
  "greedy-interceptor-0",
  "the large-fleet planner handles the earliest landing first with its safest interceptor",
);
assert.equal(safestGreedyAssignment.assignments[0].marginTicks, 10);

process.stdout.write("naval interception tests passed\n");
