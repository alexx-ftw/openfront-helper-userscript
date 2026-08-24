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

const distractedAssignmentState = {
  invasionAssignments: new Map([["warship-1", retained]]),
};
const distractedShip = {
  ...ship,
  targetUnit: () => ({
    id: () => "different-transport",
    type: () => UNIT.TransportShip,
  }),
};
assert.deepEqual(
  [
    ...behavior.reconcileNavalInterceptorAssignments(
      [distractedShip],
      new Set(["invasion-1", "different-transport"]),
      distractedAssignmentState,
    ),
  ],
  [],
  "a planner reservation is released when the engine is targeting another transport",
);
assert.equal(
  distractedAssignmentState.invasionAssignments.size,
  0,
  "a false coverage claim cannot survive the authoritative engine target",
);

const targetPoolBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
const hostileOwner = { smallID: () => 2 };
const friendlyOwner = { smallID: () => 3 };
const transport = (id, owner, overrides = {}) => ({
  id: () => id,
  owner: () => owner,
  isActive: () => true,
  isUnderConstruction: () => false,
  ...overrides,
});
const passingHostileTransport = transport("passing-hostile", hostileOwner);
targetPoolBehavior.player = {
  smallID: () => 1,
  canAttackPlayer: (owner) => owner === hostileOwner,
};
targetPoolBehavior.game = {
  units: () => [
    passingHostileTransport,
    transport("friendly", friendlyOwner),
    transport("inactive", hostileOwner, { isActive: () => false }),
    transport("building", hostileOwner, { isUnderConstruction: () => true }),
  ],
};
assert.deepEqual(
  targetPoolBehavior.engineTargetableTransports().map((candidate) => candidate.id()),
  ["passing-hostile"],
  "the predictor includes attackable enemy transports even when they are not incoming invasions",
);

const motionPlanBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let fallbackRouteCalls = 0;
motionPlanBehavior.isHostileIncomingTransport = () => true;
motionPlanBehavior.game = {
  ticks: () => 0,
  motionPlans: () =>
    new Map([
      [
        "transport-coastal",
        {
          startTick: 0,
          ticksPerStep: 1,
          path: [10, 11, 99],
        },
      ],
    ]),
  isWater: (tile) => tile !== 99,
  neighbors: (tile) => (tile === 99 ? [98] : []),
};
motionPlanBehavior.incrementalTransportRoute = () => {
  fallbackRouteCalls++;
  return [10, 98];
};
const coastalTransport = {
  id: () => "transport-coastal",
  tile: () => 10,
  targetTile: () => 99,
};
const coastalInvasion = motionPlanBehavior.createIncomingNavalInvasion(
  coastalTransport,
  { invasionRouteCache: new Map(), invasionRouteBuilders: new Map() },
  new Map(),
  1,
);
assert.deepEqual(
  Array.from(coastalInvasion.path),
  [10, 11, 99],
  "the transport motion plan is used when it reaches the coastal target tile",
);
assert.equal(
  fallbackRouteCalls,
  0,
  "coastal motion-plan interception does not invoke the water fallback",
);

const trackedThreatBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let landingOwner = 1;
let transportFriendly = false;
trackedThreatBehavior.player = {
  smallID: () => 1,
  isFriendly: () => transportFriendly,
};
trackedThreatBehavior.game = { ownerID: () => landingOwner };
trackedThreatBehavior.trackedIncomingTransportShips = new Set(["transport-1"]);
trackedThreatBehavior.dealtWithTransportShip = new Set(["transport-1"]);
const trackedTransport = {
  isActive: () => true,
  targetTile: () => 99,
  transportShipState: () => ({ isRetreating: false }),
  owner: () => ({
    smallID: () => 2,
    // Deliberately false: a permanent teammate is friendly without being a
    // breakable alliance partner.
    isAlliedWith: () => false,
  }),
};
assert.equal(
  trackedThreatBehavior.isIncomingHostileTransport(trackedTransport),
  true,
  "an active hostile transport aimed at our current tile is tracked",
);
transportFriendly = true;
assert.equal(
  trackedThreatBehavior.processTrackedIncomingTransport("transport-1", trackedTransport),
  false,
  "a teammate transport cannot actuate a stale interception",
);
assert.equal(
  trackedThreatBehavior.trackedIncomingTransportShips.size,
  0,
  "a teammate transport is released from the tracked threat set",
);
transportFriendly = false;
landingOwner = 2;
trackedThreatBehavior.trackedIncomingTransportShips.add("transport-1");
trackedThreatBehavior.dealtWithTransportShip.add("transport-1");
trackedThreatBehavior.processTrackedIncomingTransport("transport-1", trackedTransport);
assert.equal(
  trackedThreatBehavior.trackedIncomingTransportShips.size,
  0,
  "a landing whose target is no longer ours is released immediately",
);

const unknownTransportLossBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let inventedDestructorRetaliations = 0;
unknownTransportLossBehavior.player = { units: () => [] };
unknownTransportLossBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
  units: () => [
    {
      id: () => "transport-without-attribution",
      isActive: () => false,
    },
  ],
};
unknownTransportLossBehavior.trackedTransportShips = new Set(["transport-without-attribution"]);
unknownTransportLossBehavior.maybeRetaliateWithWarship = () => {
  inventedDestructorRetaliations++;
};
unknownTransportLossBehavior.trackTransportShipsAndRetaliate();
assert.equal(
  inventedDestructorRetaliations,
  0,
  "an inactive transport without engine destruction attribution cannot invent a destructor",
);

const friendlyCaptor = { smallID: () => 2 };
const friendlyRetaliationBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let retaliationScheduled = 0;
friendlyRetaliationBehavior.player = {
  smallID: () => 1,
  isFriendly: () => true,
};
friendlyRetaliationBehavior._retaliateBuildAsync = () => {
  retaliationScheduled++;
};
friendlyRetaliationBehavior.maybeRetaliateWithWarship(77, friendlyCaptor, "trade");
assert.equal(
  retaliationScheduled,
  0,
  "a stale trade capture cannot schedule retaliation against a teammate or ally",
);

const deferredRetaliationBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let captorIsFriendly = false;
let resolveBuildProbe;
const buildProbeGate = new Promise((resolve) => {
  resolveBuildProbe = resolve;
});
let retaliationBuilds = 0;
deferredRetaliationBehavior.player = {
  isFriendly: () => captorIsFriendly,
};
deferredRetaliationBehavior.hasPendingWarshipBuild = () => false;
deferredRetaliationBehavior.shouldDeferWarshipBuild = () => false;
deferredRetaliationBehavior.buildableWarship = async () => {
  await buildProbeGate;
  return { canBuild: true };
};
deferredRetaliationBehavior.tryEmitWarshipBuild = () => {
  retaliationBuilds++;
  return true;
};
const pendingRetaliation = deferredRetaliationBehavior._retaliateBuildAsync(
  77,
  friendlyCaptor,
  "trade",
);
captorIsFriendly = true;
resolveBuildProbe();
await pendingRetaliation;
assert.equal(
  retaliationBuilds,
  0,
  "retaliation revalidates diplomacy after its asynchronous buildability probe",
);

const concurrentBuildBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
concurrentBuildBehavior.game = { ticks: () => 200 };
const builtForInvasions = [];
concurrentBuildBehavior.buildInterceptorForInvasion = async (invasion) => {
  builtForInvasions.push(invasion.id);
  return true;
};
const concurrentBuildState = {
  pendingInvasionBuilds: new Set(["urgent-pending"]),
  invasionBuildAttemptAt: new Map([["recently-tried", 990]]),
  lastInvasionBuildTick: -1,
};
await concurrentBuildBehavior.buildUncoveredInterceptor(
  {
    uncoveredIds: ["urgent-pending", "recently-tried", "next-eligible"],
  },
  [
    { id: "urgent-pending", path: [0, 1] },
    { id: "recently-tried", path: [0, 1, 2] },
    { id: "next-eligible", path: [0, 1, 2, 3] },
  ],
  concurrentBuildState,
  { now: 1000, throttle: 20, boatSpeed: 1, warshipSpeed: 1, attackRange: 1 },
);
assert.deepEqual(
  builtForInvasions,
  ["next-eligible"],
  "a pending or throttled invasion cannot block the next uncovered eligible target",
);
assert.equal(
  concurrentBuildState.lastInvasionBuildTick,
  200,
  "the fallback eligible interceptor records the shared build tick",
);

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
assert.equal(
  assignmentState.invasionAssignments.get("warship-1").absoluteLandingTick,
  undefined,
  "a patrol-anchor order cannot claim a guaranteed landing-time interception before engine target confirmation",
);
assert.equal(assignmentState.invasionAssignments.get("warship-1").plannedAbsoluteLandingTick, 120);
const confirmingShip = {
  ...ship,
  targetUnit: () => ({ id: () => "invasion-2", type: () => UNIT.TransportShip }),
};
behavior.reconcileNavalInterceptorAssignments(
  [confirmingShip],
  new Set(["invasion-2"]),
  assignmentState,
);
assert.equal(assignmentState.invasionAssignments.get("warship-1").confirmed, true);
assert.equal(assignmentState.invasionAssignments.get("warship-1").absoluteLandingTick, 120);

const expiredReservationState = {
  invasionAssignments: new Map([
    [
      "warship-1",
      {
        confirmed: false,
        invasionId: "invasion-2",
        absoluteInterceptTick: 105,
        plannedAbsoluteLandingTick: 120,
      },
    ],
  ]),
};
const expirationBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
expirationBehavior.game = { ticks: () => 109 };
expirationBehavior.reconcileNavalInterceptorAssignments(
  [ship],
  new Set(["invasion-2"]),
  expiredReservationState,
);
assert.equal(
  expiredReservationState.invasionAssignments.size,
  0,
  "an unconfirmed patrol reservation expires after the planned intercept grace window",
);

const candidateBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
const candidatePorts = Array.from({ length: 500 }, (_, index) => ({
  tile: () => `port-${index}`,
}));
candidateBehavior.player = { units: () => candidatePorts };
candidateBehavior.game = {
  manhattanDist: (left, right) => (left === right ? 0 : 1),
};
candidateBehavior.warshipSpawnTile = (portTile) => {
  const index = Number(String(portTile).slice("port-".length));
  return index % 2 === 0 ? `spawn-${index / 2}` : `spawn-${Math.floor(index / 2)}`;
};
const boundedBuildCandidates = candidateBehavior.interceptionBuildCandidates({
  path: ["landing", "early", "midpoint", "before-landing"],
});
assert.ok(
  boundedBuildCandidates.length <= 12,
  "a large port roster must not create an unbounded serial interception probe set",
);
assert.equal(
  boundedBuildCandidates.length,
  new Set(boundedBuildCandidates).size,
  "interception build candidates must be deduplicated before probing",
);
assert.deepEqual(
  Array.from(boundedBuildCandidates).slice(0, 3),
  ["landing", "early", "midpoint"],
  "interception candidates retain the invasion timing anchors",
);
assert.ok(
  boundedBuildCandidates.includes("spawn-0") &&
    boundedBuildCandidates.some((candidate) => candidate.startsWith("spawn-")),
  "interception candidates retain nearest and geographically diverse port spawns",
);

const routeBuilderLifecycleBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
routeBuilderLifecycleBehavior.isHostileIncomingTransport = () => true;
routeBuilderLifecycleBehavior.waterTargetTile = (target) => target;
routeBuilderLifecycleBehavior.createIncomingNavalInvasion = (transport, state, nextCache) => {
  const key = `${transport.id()}:${transport.targetTile()}`;
  nextCache.set(key, [transport.tile(), transport.targetTile()]);
  return { id: transport.id(), path: [transport.tile(), transport.targetTile()] };
};
const routeBuilderState = {
  invasionRouteBuilders: new Map([
    ["transport-live:20", { transportId: "transport-live", goal: 20 }],
    ["transport-gone:40", { transportId: "transport-gone", goal: 40 }],
    ["transport-live:30", { transportId: "transport-live", goal: 30 }],
  ]),
  invasionRouteCache: new Map(),
};
const retargetedTransport = {
  id: () => "transport-live",
  tile: () => 10,
  targetTile: () => 30,
};
routeBuilderLifecycleBehavior.player = { smallID: () => 1 };
const liveInvasions = routeBuilderLifecycleBehavior.incomingNavalInvasions(routeBuilderState, [
  retargetedTransport,
]);
assert.equal(liveInvasions.length, 1);
assert.equal(liveInvasions[0].id, "transport-live");
assert.deepEqual(
  [...routeBuilderState.invasionRouteBuilders.keys()],
  ["transport-live:30"],
  "route builders are pruned when a transport disappears or changes destination",
);

let combatTick = 100;
let combatMoves = 0;
const combatBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
combatBehavior.game = {
  ticks: () => combatTick,
  manhattanDist: (a, b) => Math.abs(Number(a) - Number(b)),
  forEachNeighbor: (tile, visit) => {
    visit(Number(tile) + 1);
  },
  isWater: () => true,
};
combatBehavior.moveWarship = () => {
  combatMoves++;
  return true;
};
const combatShip = {
  id: () => "warship-combat",
  tile: () => 10,
  health: () => 10,
  maxHealth: () => 100,
  warshipState: () => ({ patrolTile: 10 }),
};
const combatState = {
  invasionAssignments: new Map([
    [
      "warship-combat",
      { confirmed: true, landingTick: 20, absoluteLandingTick: 120, assignedAtTick: 80 },
    ],
  ]),
  cooldown: new Map(),
};
const combatContext = {
  smartState: combatState,
  friendlyPorts: [{ tile: () => 20, isActive: () => true, isUnderConstruction: () => false }],
  enemyWarships: [],
  myWarships: [combatShip],
  enemyTradeShips: [],
  maxHp: 100,
  retreatPct: 0.5,
  huntTrade: false,
};
combatBehavior.handleWarshipCombat(combatShip, combatContext);
assert.equal(combatMoves, 0, "combat retains an interception until its absolute landing tick");
combatTick = 120;
combatBehavior.handleWarshipCombat(combatShip, combatContext);
assert.equal(combatMoves, 1, "combat resumes when the absolute landing tick is reached");

let sameTickOrders = 0;
const sameTickBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
sameTickBehavior.game = { ticks: () => 300 };
sameTickBehavior.moveWarship = () => {
  sameTickOrders++;
  return true;
};
const sameTickShip = {
  id: () => "warship-same-tick",
  tile: () => 10,
  health: () => 10,
  maxHealth: () => 100,
  warshipState: () => ({ patrolTile: undefined }),
};
const sameTickState = {
  invasionAssignments: new Map(),
  cooldown: new Map(),
};
sameTickBehavior.assignNavalInterceptors(
  {
    assignments: [
      {
        shipId: "warship-same-tick",
        invasionId: "invasion-same-tick",
        interceptTile: 20,
        interceptTick: 5,
        landingTick: 0,
      },
    ],
  },
  [sameTickShip],
  sameTickState,
);
assert.equal(sameTickOrders, 1, "the interception assignment emits one movement order");

sandbox.discoverCtors = () => ({ moveWarship: {} });
sandbox.getEventBus = () => ({});
sandbox.emitIntent = () => {
  sameTickOrders++;
};
sameTickBehavior.findNukeEscapeTile = () => ({ tile: 30, eta: 10 });
sameTickBehavior.game.x = () => 0;
sameTickBehavior.game.y = () => 0;
sameTickBehavior.dodgeWarshipFromNukes(
  sameTickShip,
  [{ tx: 0, ty: 0, r2: 1 }],
  () => 0,
  sameTickState,
  300,
);
assert.equal(
  sameTickOrders,
  1,
  "nuke dodge cannot issue a second movement order in the assignment tick",
);

sameTickState.cooldown.clear();
sameTickBehavior.handleWarshipCombat(sameTickShip, {
  ...combatContext,
  smartState: sameTickState,
  myWarships: [sameTickShip],
});
assert.equal(
  sameTickOrders,
  1,
  "combat cannot issue a second movement order in the assignment tick",
);

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

const largeMapRouteBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
largeMapRouteBehavior.game = {
  width: () => 2_000_000,
  height: () => 1,
  isWater: () => true,
  manhattanDist: (left, right) => Math.abs(left - right),
  forEachNeighbor: (tile, visit) => {
    if (tile === 0) visit(1);
  },
};
assert.equal(
  [...largeMapRouteBehavior.waterRoute(0, 1)].join(","),
  "0,1",
  "large-map sparse A* must preserve the exact water route",
);
assert.equal(
  largeMapRouteBehavior._denseWaterRouteScratch,
  undefined,
  "large-map water routing must not synchronously reserve three map-sized buffers",
);

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

const boundedInterceptionBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let boundedNeighborCalls = 0;
boundedInterceptionBehavior.game = {
  width: () => 1000,
  height: () => 1,
  isWater: () => true,
  manhattanDist: (left, right) => Math.abs(left - right),
  forEachNeighbor: (tile, visit) => {
    boundedNeighborCalls++;
    if (tile < 999) visit(tile + 1);
  },
};
assert.equal(
  boundedInterceptionBehavior.interceptionRoute(0, 999),
  null,
  "a long interceptor route must yield instead of running an unbounded A*",
);
assert.ok(boundedNeighborCalls <= 256, "interceptor route expansion stays within its budget");
assert.deepEqual(
  [...boundedInterceptionBehavior.interceptionRoute(0, 4)],
  [0, 1, 2, 3, 4],
  "short interceptor routes remain exact",
);

const patrolSelectionBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let patrolDistanceCalls = 0;
const patrolShips = Array.from({ length: 64 }, (_, index) => ({
  id: () => `patrol-${index}`,
  tile: () => index * 3,
  warshipState: () => ({ patrolTile: index * 3 }),
}));
patrolSelectionBehavior.player = { units: () => patrolShips };
patrolSelectionBehavior.game = {
  manhattanDist: (left, right) => {
    patrolDistanceCalls++;
    return Math.abs(left - right);
  },
};
const closestPatrol = patrolSelectionBehavior.selectClosestIdleWarship(
  100,
  { invasionAssignments: new Map(), cooldown: new Map() },
  500,
  60,
);
assert.equal(closestPatrol.warship.id(), "patrol-33");
assert.equal(closestPatrol.distance, 1);
assert.equal(
  patrolDistanceCalls,
  patrolShips.length * 2,
  "patrol selection computes one voyage and one target distance per ship without sorting",
);
patrolDistanceCalls = 0;
const retaliationPatrol = patrolSelectionBehavior.selectClosestIdleWarship(100, null, 0, 0);
assert.equal(retaliationPatrol.warship.id(), "patrol-33");
assert.equal(
  patrolDistanceCalls,
  patrolShips.length * 2,
  "retaliation selection reuses the same linear nearest-idle scan without assignment state",
);
assert.match(
  read("engine/ingame/auto-bot/warshipBehavior.js"),
  /maybeMoveWarship\(tile\)[\s\S]{0,300}selectClosestIdleWarship\(tile, null, 0, 0\)/,
  "warship retaliation must use the bounded linear selector instead of sorting the fleet",
);

const interceptionPortBehavior = Object.create(sandbox.__WarshipBehavior.prototype);
let interceptionPortDistanceCalls = 0;
const interceptionPorts = Array.from({ length: 64 }, (_, index) => ({
  id: () => `port-${index}`,
  tile: () => index * 3,
}));
interceptionPortBehavior.player = { units: () => interceptionPorts };
interceptionPortBehavior.game = {
  manhattanDist: (left, right) => {
    interceptionPortDistanceCalls++;
    return Math.abs(left - right);
  },
};
interceptionPortBehavior.warshipSpawnTile = (tile) => tile + 1_000;
const interceptionCandidates = interceptionPortBehavior.interceptionBuildCandidates({
  path: [100, 140, 180, 220],
});
assert.deepEqual(
  Array.from(interceptionCandidates).slice(0, 3),
  [100, 140, 180],
  "interception candidates preserve path points before port candidates",
);
assert.equal(interceptionCandidates.length, 12);
assert.equal(
  interceptionCandidates.length,
  new Set(interceptionCandidates).size,
  "interception candidates remain unique after port sampling",
);
assert.ok(
  interceptionCandidates.includes(1_099) && interceptionCandidates.includes(1_000),
  "interception candidates retain the nearest port and a distant port sample",
);
assert.equal(
  interceptionPortDistanceCalls,
  interceptionPorts.length,
  "interception port ranking computes each distance once instead of during sort comparisons",
);

assert.doesNotMatch(
  read("engine/ingame/auto-bot/warshipBehavior.js"),
  /planNavalInterceptions\(\{[\s\S]{0,500}route: \(from, to\) => this\.waterRoute\(from, to\)/,
  "interception planner must not invoke unbounded waterRoute directly",
);

process.stdout.write("naval assignment persistence tests passed\n");
