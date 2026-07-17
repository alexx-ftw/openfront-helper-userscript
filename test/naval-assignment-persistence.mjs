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

process.stdout.write("naval assignment persistence tests passed\n");
