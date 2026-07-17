import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const UNIT = { TransportShip: "Transport", TradeShip: "Trade", Warship: "Warship", Port: "Port" };
const sandbox = {
  UNIT,
  state: {
    settings: { winFixes: true, warshipAutoSpawn: true, warshipPatrolThrottleMs: 1 },
    stats: { builds: 0 },
  },
  WORKER_TIMEOUT_MS: 100,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  setLastAction() {},
  tr: (value) => value,
  console,
  window: {},
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${read("engine/ingame/auto-bot/naval-interception.js")}\n${read(
    "engine/ingame/auto-bot/warshipBehavior.js",
  )}\nglobalThis.__WarshipBehavior = WarshipBehavior;`,
  sandbox,
  { filename: "naval-assignment-persistence.vm.js" },
);

const behavior = Object.create(sandbox.__WarshipBehavior.prototype);
behavior.game = { ticks: () => 100, config: () => ({ isUnitDisabled: () => false }) };
const ship = { id: () => "warship-1", tile: () => 10 };
const retained = { shipId: "warship-1", invasionId: "invasion-1", interceptTile: 20 };
const assignmentState = { invasionAssignments: new Map([["warship-1", retained]]) };
let dispatches = 0;
behavior.dispatchInterceptor = () => {
  dispatches++;
  return true;
};
assert.deepEqual(
  [
    ...behavior.reconcileNavalInterceptorAssignments(
      [ship],
      new Set(["invasion-1"]),
      assignmentState,
    ),
  ],
  ["invasion-1"],
);
assert.deepEqual(
  [
    ...behavior.assignNavalInterceptors(
      { assignments: [{ ...retained, interceptTile: 30 }] },
      [ship],
      assignmentState,
    ),
  ],
  [],
  "a live same-invasion assignment is retained",
);
assert.equal(dispatches, 0, "a retained interception emits no duplicate move");

behavior.reconcileNavalInterceptorAssignments([ship], new Set(["invasion-2"]), assignmentState);
assert.equal(assignmentState.invasionAssignments.size, 0, "a vanished invasion releases its ship");
const sequentialPlan = {
  assignments: [
    {
      shipId: "warship-1",
      invasionId: "invasion-2",
      interceptTile: 40,
      interceptTick: 5,
      landingTick: 20,
    },
    {
      shipId: "warship-1",
      invasionId: "invasion-3",
      interceptTile: 50,
      interceptTick: 10,
      landingTick: 25,
    },
  ],
};
assert.deepEqual(
  [...behavior.assignNavalInterceptors(sequentialPlan, [ship], assignmentState)],
  ["invasion-2"],
  "one planning pass dispatches only the first assignment per warship",
);
assert.equal(dispatches, 1);
assert.equal(assignmentState.invasionAssignments.get("warship-1").absoluteInterceptTick, 105);
assert.equal(assignmentState.invasionAssignments.get("warship-1").absoluteLandingTick, 120);

const stableBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
stableBehavior.game = behavior.game;
stableBehavior.player = { smallID: () => 1 };
stableBehavior.dealtWithTransportShip = new Set();
stableBehavior.smartState = {
  cooldown: new Map(),
  lastInvasionPlanMs: -Infinity,
  invasionPlan: null,
  invasionAssignments: new Map([["warship-1", retained]]),
};
stableBehavior.incomingNavalTransports = () => [{ id: () => "invasion-1" }];
stableBehavior.activeWarships = () => [ship];
let routePlanningCalls = 0;
stableBehavior.incomingNavalInvasions = () => {
  routePlanningCalls++;
  return [];
};
await stableBehavior.protectAgainstNavalInvasions();
assert.equal(routePlanningCalls, 0, "a covered invasion skips A* and replanning");

const routeBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let zeroAllocationNeighborCalls = 0;
routeBehavior.game = {
  width: () => 5,
  height: () => 1,
  isWater: (tile) => tile >= 0 && tile <= 4,
  manhattanDist: (left, right) => Math.abs(left - right),
  forEachNeighbor: (tile, visit) => {
    zeroAllocationNeighborCalls++;
    if (tile > 0) visit(tile - 1);
    if (tile < 4) visit(tile + 1);
  },
  neighbors: () => {
    throw new Error("water A* should prefer zero-allocation neighbor iteration");
  },
};
assert.equal([...routeBehavior.waterRoute(0, 4)].join(","), "0,1,2,3,4");
assert.ok(zeroAllocationNeighborCalls > 0);
const firstDenseScratch = routeBehavior._denseWaterRouteScratch;
assert.equal([...routeBehavior.waterRoute(4, 0)].join(","), "4,3,2,1,0");
assert.strictEqual(
  routeBehavior._denseWaterRouteScratch,
  firstDenseScratch,
  "successive A* probes reuse the same dense route buffers",
);
assert.equal(firstDenseScratch.generation, 2);

const fallbackRouteBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
fallbackRouteBehavior.game = {
  isWater: () => true,
  manhattanDist: (left, right) => Math.abs(left - right),
  neighbors: (tile) => (tile === "start" ? ["goal"] : []),
};
assert.equal([...fallbackRouteBehavior.waterRoute("start", "goal")].join(","), "start,goal");

const slicedRouteBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
slicedRouteBehavior.game = {
  isWater: () => true,
  manhattanDist: (left, right) => Math.abs(left - right),
  neighbors: (tile) => (tile < 8 ? [tile + 1] : []),
};
const slicedRouteState = slicedRouteBehavior.createWaterRouteState(0, 8, true);
slicedRouteState.open.push({ tile: 0, priority: 8 });
const pausedSlicedRoute = slicedRouteBehavior.advanceWaterRoute(slicedRouteState, 8, 2);
assert.equal(
  pausedSlicedRoute.complete,
  false,
  "a long fallback route yields after its bounded naval planning slice",
);
assert.equal(pausedSlicedRoute.path, null);
const completedSlicedRoute = slicedRouteBehavior.advanceWaterRoute(slicedRouteState, 8, 32);
assert.equal(completedSlicedRoute.complete, true);
assert.deepEqual([...completedSlicedRoute.path], [0, 1, 2, 3, 4, 5, 6, 7, 8]);

const longRouteBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
longRouteBehavior.game = {
  isWater: () => true,
  manhattanDist: (left, right) => Math.abs(left - right),
  neighbors: (tile) => (tile < 1025 ? [tile + 1] : []),
};
const longRouteState = { invasionRouteBuilders: new Map() };
const longTransport = { id: () => "long-transport" };
assert.equal(
  longRouteBehavior.incrementalTransportRoute(longTransport, 0, 1025, longRouteState),
  null,
  "a distant incoming transport keeps its unfinished route builder for the next naval pass",
);
assert.equal(longRouteState.invasionRouteBuilders.size, 1);
const resumedTransportRoute = longRouteBehavior.incrementalTransportRoute(
  longTransport,
  5,
  1025,
  longRouteState,
);
assert.equal(resumedTransportRoute.length, 1021);
assert.equal(resumedTransportRoute[0], 5);
assert.equal(resumedTransportRoute.at(-1), 1025);
assert.equal(
  longRouteState.invasionRouteBuilders.size,
  0,
  "a completed fallback transport route releases its incremental builder",
);

process.stdout.write("naval assignment persistence tests passed\n");
