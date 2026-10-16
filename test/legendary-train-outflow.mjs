// Finite-lifetime train outflow for the Legendary mean-field fleet
// projection: despawns mirror trade-ship completions through one delay-line
// arrival queue (applied at tick start), keep the exact birth-only projection
// when no lifetime data exists, and bound the live-Config call count.
import assert from "node:assert/strict";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

const plannerSandbox = {};
executeClassicScript(readLegendaryPlannerSource(), plannerSandbox, {
  filename: "legendaryPlanner.js",
});
const { legendaryProjectEconomyFleets: projectFleets } = plannerSandbox;

// Rate grows with the stock so a birth-only projection accumulates without
// bound and any missing despawn term is visible immediately.
const linearTrainSpawnRate = (factories, trains) => 100 + 10 * factories + trains;
const constantTrainSpawnRate = () => 130;

const fleetSupply = (factoryCount = 2, extra = {}) => ({
  trainOwners: [
    {
      isBuilder: false,
      factoryCount,
      factories: [{ level: 1, readyAtTicks: 0 }],
    },
  ],
  portOwners: [],
  ...extra,
});

const project = (horizon, inputs, config) => projectFleets(inputs, config, horizon, {});

const LIFETIME = 7;
const HORIZON = 40;
const lifetimeInputs = (trainCount = 0) => ({
  trainCount,
  fleetProducerSupply: fleetSupply(2, { trainLifetimeTicks: LIFETIME }),
});
const birthOnlyInputs = (trainCount = 0) => ({
  trainCount,
  fleetProducerSupply: fleetSupply(),
});

const birthOnly = project(HORIZON, birthOnlyInputs(), { trainSpawnRate: constantTrainSpawnRate });
assert.ok(
  Math.abs(
    birthOnly.after.trainCounts[1] - 7 * plannerSandbox.legendaryExpectedTrainRatePerTick(1, 130),
  ) < 1e-12,
  "each train spawn adds the seven Train units counted by the live game",
);

let integerTrainRateCalls = 0;
plannerSandbox.legendaryExpectedTrainRateAtFleet(1, 2, 4, {
  trainSpawnRate: () => {
    integerTrainRateCalls++;
    return 130;
  },
}, new Map());
assert.equal(integerTrainRateCalls, 1, "integer train stocks need only one live-rate lookup");

const queriedShipStocks = new Set();
plannerSandbox.legendaryExpectedTradeRateAtFleet(1, 4, {
  tradeShipSpawnRate: (_rejections, ships) => {
    queriedShipStocks.add(ships);
    return 100;
  },
}, new Map());
assert.deepEqual([...queriedShipStocks], [4], "integer trade-ship stocks avoid the next-stock rate");

// ── Causality: zero outflow before the first lifetime elapses. ──
const causal = project(20, lifetimeInputs(), { trainSpawnRate: linearTrainSpawnRate });
const causalBirthOnly = project(20, birthOnlyInputs(), { trainSpawnRate: linearTrainSpawnRate });
assert.deepEqual(
  causal.after.trainCounts.slice(0, LIFETIME),
  causalBirthOnly.after.trainCounts.slice(0, LIFETIME),
  "no train despawns before the first lifetime elapses",
);
assert.ok(
  causal.after.trainCounts[LIFETIME] < causalBirthOnly.after.trainCounts[LIFETIME],
  "the first delayed arrival is removed at the lifetime boundary",
);

// ── Delay-line identity: outflow equals births shifted by exactly one
// lifetime, so stock(t) = stock(t-1) + births(t-1) - births(t-lifetime). ──
const withOutflow = project(HORIZON, lifetimeInputs(), { trainSpawnRate: constantTrainSpawnRate });
const births = [];
for (let tick = 0; tick < HORIZON; tick++) {
  births.push(birthOnly.after.trainCounts[tick + 1] - birthOnly.after.trainCounts[tick]);
}
let stock = 0;
for (let tick = 0; tick <= HORIZON; tick++) {
  if (tick > 0) {
    if (tick - LIFETIME >= 0) stock -= births[tick - LIFETIME];
    stock += births[tick - 1];
  }
  assert.ok(
    Math.abs(withOutflow.after.trainCounts[tick] - stock) < 1e-12,
    `outflow equals births delayed by one lifetime at tick ${tick}`,
  );
}

// ── Bounded counts past the lifetime. ──
assert.ok(
  withOutflow.after.trainCounts[HORIZON] < birthOnly.after.trainCounts[HORIZON],
  "a finite lifetime bounds the projected train stock below the birth-only accumulation",
);
const windowBirths = births
  .slice(HORIZON - LIFETIME, HORIZON)
  .reduce((total, rate) => total + rate, 0);
assert.ok(
  withOutflow.after.trainCounts[HORIZON] <= windowBirths + 1e-9,
  "the steady-state stock never exceeds one lifetime of births",
);

// ── Conservation: despawned mass never exceeds recorded births and the stock
// never goes negative. ──
assert.ok(
  withOutflow.after.trainCounts.every((count) => count >= 0),
  "outflow never drives the projected train stock negative",
);
const totalBirths = births.reduce((total, rate) => total + rate, 0);
const totalOutflow = births.reduce(
  (total, rate, tick) => (tick + LIFETIME <= HORIZON ? total + rate : total),
  0,
);
assert.ok(totalOutflow <= totalBirths, "despawned train mass never exceeds recorded births");

// ── Back-compat: inputs and Config without any lifetime data produce the exact
// birth-only projection (same bytes). ──
const legacyWithQuietConfig = project(HORIZON, birthOnlyInputs(), {
  trainSpawnRate: constantTrainSpawnRate,
});
assert.deepEqual(
  legacyWithQuietConfig.after.trainCounts,
  birthOnly.after.trainCounts,
  "inputs without lifetime data keep the exact birth-only projection",
);
assert.deepEqual(
  legacyWithQuietConfig.before.trainCounts,
  birthOnly.before.trainCounts,
  "the before-projection stays birth-only without lifetime data",
);

// The range proxy is converted to ticks using TrainExecution's two-tile speed.
const proxyProjection = project(HORIZON, birthOnlyInputs(), {
  trainSpawnRate: constantTrainSpawnRate,
  trainStationMaxRange: () => 2 * LIFETIME,
});
assert.deepEqual(
  proxyProjection.after.trainCounts,
  withOutflow.after.trainCounts,
  "station range divided by TrainExecution speed supplies the default lifetime proxy",
);

// ── Mass enqueued beyond the horizon is dropped, not applied. ──
const shortRun = project(LIFETIME - 1, lifetimeInputs(), {
  trainSpawnRate: constantTrainSpawnRate,
});
const shortBirthOnly = project(LIFETIME - 1, birthOnlyInputs(), {
  trainSpawnRate: constantTrainSpawnRate,
});
assert.deepEqual(
  shortRun.after.trainCounts,
  shortBirthOnly.after.trainCounts,
  "births enqueued beyond the horizon never despawn inside it",
);

// ── Determinism. ──
const repeat = project(HORIZON, lifetimeInputs(), { trainSpawnRate: constantTrainSpawnRate });
assert.deepEqual(
  repeat.after.trainCounts,
  withOutflow.after.trainCounts,
  "the finite-lifetime projection is deterministic across calls",
);

// ── Trade ships leave the global fleet after completing a weighted water
// route. With no route data the old birth-only stock remains unchanged. ──
const tradeRoutes = [
  { weight: 1, distance: 3 },
  { weight: 3, distance: 7 },
];
const tradeConfig = { tradeShipSpawnRate: () => 100 };
const tradeInputs = (routes) => ({
  tradeShipCount: 0,
  fleetProducerSupply: {
    trainOwners: [],
    portOwners: [
      {
        isBuilder: false,
        ports: [{ level: 1, readyAtTicks: 0, ...(routes ? { routes } : {}) }],
      },
    ],
  },
});
const tradeBirthOnly = project(HORIZON, tradeInputs(), tradeConfig);
const weightedTrade = project(HORIZON, tradeInputs(tradeRoutes), tradeConfig);
for (let tick = 0; tick <= HORIZON; tick++) {
  let expectedStock = 0;
  for (let birthTick = 0; birthTick < tick; birthTick++) {
    const births =
      tradeBirthOnly.after.tradeShipCounts[birthTick + 1] -
      tradeBirthOnly.after.tradeShipCounts[birthTick];
    const activeWeight =
      tradeRoutes.reduce(
        (total, route) =>
          birthTick + Math.max(1, Math.ceil(route.distance)) > tick ? total + route.weight : total,
        0,
      ) / tradeRoutes.reduce((total, route) => total + route.weight, 0);
    expectedStock += births * activeWeight;
  }
  assert.ok(
    Math.abs(weightedTrade.after.tradeShipCounts[tick] - expectedStock) < 1e-12,
    `weighted water-route arrivals conserve expected ship stock at tick ${tick}`,
  );
}
assert.deepEqual(
  tradeBirthOnly.after.tradeShipCounts,
  project(HORIZON, tradeInputs(), tradeConfig).after.tradeShipCounts,
  "no route data preserves the birth-only trade-ship projection",
);

const initialTradeFleet = project(12, {
  tradeShipCount: 2,
  fleetProducerSupply: {
    trainOwners: [],
    portOwners: [],
    initialTradeShipRemainingTicks: [3, 8, 20],
  },
}, tradeConfig);
assert.deepEqual(
  [0, 2, 3, 7, 8, 12].map((tick) => initialTradeFleet.after.tradeShipCounts[tick]),
  [2, 2, 1, 1, 0, 0],
  "known in-flight ships leave the global fleet at their projected arrival ticks",
);
const unknownInitialTradeFleet = project(12, {
  tradeShipCount: 2,
  fleetProducerSupply: { trainOwners: [], portOwners: [] },
}, tradeConfig);
assert.ok(
  unknownInitialTradeFleet.after.tradeShipCounts.every((count) => count === 2),
  "initial ships without a motion plan remain in the global fleet conservatively",
);

// ── Deterministic Config-call budget: one shared trade-rate cache per
// projection (before and after) and one memoized train-rate cache. ──
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const trainSaturation = (trains) => {
  const decay = (value, rate, midpoint) => 1 / (1 + Math.exp(-rate * (value - midpoint)));
  return (
    (1 + 0.5 * Math.exp(-trains / 30)) *
    Math.max(
      1 - decay(trains, Math.LN2 / 100, 560),
      0.25 * (1 - decay(trains, Math.LN2 / 150, 900)),
    )
  );
};
const tradeShipSaturation = (ships) =>
  (1 + 0.45 * Math.exp(-ships / 120)) *
  Math.max(
    1 - sigmoid((Math.LN2 / 50) * (ships - 330)),
    0.25 * (1 - sigmoid((Math.LN2 / 100) * (ships - 800))),
  );
let trainSpawnRateCalls = 0;
let tradeShipSpawnRateCalls = 0;
const liveMirrorConfig = {
  unitInfo: (type) => ({ constructionDuration: type === "Port" ? 50 : 20 }),
  trainSpawnRate: (factories, trains) => {
    trainSpawnRateCalls++;
    return Math.max(1, Math.floor(((factories + 10) * 15) / trainSaturation(trains)));
  },
  tradeShipSpawnRate: (rejections, ships) => {
    tradeShipSpawnRateCalls++;
    return Math.max(1, Math.floor(100 / (rejections + 1) / tradeShipSaturation(ships)));
  },
};

// One Factory candidate with the full live workload: 20 Factories + 20 Ports,
// 40 trains, 20 ships, 6,000 ticks.
const hotInputs = {
  trainCount: 40,
  tradeShipCount: 20,
  factoryPaidStops: 1,
  factoryTeamGoldPerTrain: 50_000,
  routeDelayTicks: 10,
  fleetProducerSupply: {
    trainLifetimeTicks: 600,
    trainOwners: [
      {
        isBuilder: false,
        factoryCount: 20,
        factories: Array.from({ length: 20 }, () => ({ level: 1, readyAtTicks: 0 })),
      },
    ],
    portOwners: [
      {
        isBuilder: false,
        ports: Array.from({ length: 20 }, () => ({
          level: 1,
          readyAtTicks: 0,
          routes: [{ weight: 1, distance: 600 }],
        })),
      },
    ],
  },
};
trainSpawnRateCalls = 0;
tradeShipSpawnRateCalls = 0;
const priced = plannerSandbox.legendaryEconomyNetGold("Factory", {
  cost: 40_000,
  horizonTicks: 6_000,
  inputs: hotInputs,
  config: liveMirrorConfig,
});
assert.ok(
  priced && priced.refused !== true && priced.netTeamGold > 0,
  "the long-horizon Factory stays investable under the counting config",
);
assert.ok(
  trainSpawnRateCalls <= 200_000,
  `train rate Config calls stay bounded (saw ${trainSpawnRateCalls})`,
);
assert.ok(
  tradeShipSpawnRateCalls <= 200_000,
  `trade rate Config calls stay bounded (saw ${tradeShipSpawnRateCalls})`,
);

// Sharing gate for the trade-rate cache inside one projection call: each
// distinct integer ship count costs at most one 512-step survival sweep per
// level across the before AND after runs.
let sharedTradeCalls = 0;
const singlePortConfig = {
  ...liveMirrorConfig,
  tradeShipSpawnRate: (rejections, ships) => {
    sharedTradeCalls++;
    return Math.max(1, Math.floor(100 / (rejections + 1) / tradeShipSaturation(ships)));
  },
  trainSpawnRate: () => 1_000,
};
sharedTradeCalls = 0;
const portProjection = projectFleets(
  {
    tradeShipCount: 0,
    fleetProducerSupply: {
      trainOwners: [],
      portOwners: [{ isBuilder: false, ports: [{ level: 1, readyAtTicks: 0 }] }],
    },
  },
  singlePortConfig,
  300,
  {},
);
const maxShips = Math.ceil(
  portProjection.after.tradeShipCounts[portProjection.after.tradeShipCounts.length - 1],
);
assert.ok(
  sharedTradeCalls <= 512 * (maxShips + 2),
  `the trade-rate cache is shared across before and after (saw ${sharedTradeCalls})`,
);

// eslint-disable-next-line no-console -- scenario evidence output
console.log(
  `train-outflow OK (trainSpawnRate calls: ${trainSpawnRateCalls}, tradeShipSpawnRate calls: ${tradeShipSpawnRateCalls})`,
);
