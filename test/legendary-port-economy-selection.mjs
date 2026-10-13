import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({
  randTerritoryTiles: [30],
  vmFilename: "legendary-port-economy-selection.vm.js",
});
const { UNIT } = sandbox;

const PORT_CONSTRUCTION_TICKS = 50;
const PORT_COST_LADDER = 125_000;
const PORT_COST_CAP = 1_000_000;
const OCEAN = -1;

// Prefix integration must exactly match per-tick payout, including fractional
// route edges and the midpoint rule at an alliance-expiry boundary.
{
  const routeRate = (tick) => 0.25 + ((tick * 17) % 13) / 7;
  const prefix = new Float64Array(65);
  for (let tick = 0; tick < prefix.length - 1; tick++) {
    prefix[tick + 1] = prefix[tick] + routeRate(tick);
  }
  const rangeSum = (start, end) => prefix[end] - prefix[start];
  const cases = [
    {
      route: {
        weight: 2,
        postAllianceWeight: 3,
        distance: 0.4,
        teamGoldPerArrival: 19,
        postAllianceGoldPerArrival: 11,
        allianceTicksRemaining: 4.5,
      },
      totalWeight: 5,
      postTotalWeight: 7,
      startDelay: 1.25,
      horizon: 18.75,
    },
    {
      route: {
        weight: 1,
        postAllianceWeight: 2,
        distance: 1.2,
        teamGoldPerArrival: 23,
        postAllianceGoldPerArrival: 8,
        allianceTicksRemaining: 0,
      },
      totalWeight: 3,
      postTotalWeight: 4,
      startDelay: 2.3,
      horizon: 14.2,
    },
    {
      route: {
        weight: 4,
        postAllianceWeight: 1,
        distance: 0,
        teamGoldPerArrival: 17,
        postAllianceGoldPerArrival: 31,
        allianceTicksRemaining: Number.NaN,
      },
      totalWeight: 6,
      postTotalWeight: 3,
      startDelay: 2,
      horizon: 2.4,
    },
    {
      route: {
        weight: 1,
        postAllianceWeight: 5,
        distance: 3.75,
        teamGoldPerArrival: 29,
        postAllianceGoldPerArrival: 13,
        allianceTicksRemaining: 9.5,
      },
      totalWeight: 4,
      postTotalWeight: 8,
      startDelay: 0.2,
      horizon: 20.6,
    },
  ];
  for (const scenario of cases) {
    const { route, totalWeight, postTotalWeight, startDelay, horizon } = scenario;
    const start = Math.max(0, startDelay + Math.max(0, Number(route.distance) || 0));
    const routeTicks = Math.max(0, horizon - startDelay - Math.max(0, Number(route.distance) || 0));
    const end = Math.min(horizon, start + routeTicks);
    const activeTicks = Math.min(
      routeTicks,
      Math.max(
        0,
        Number(route.allianceTicksRemaining ?? Infinity) -
          startDelay -
          Math.max(0, Number(route.distance) || 0),
      ),
    );
    const activeWeight = Math.max(0, Number(route.weight) || 0) / totalWeight;
    const postWeight =
      Math.max(0, Number(route.postAllianceWeight ?? route.weight) || 0) / postTotalWeight;
    const activeValue = activeWeight * Math.max(0, Number(route.teamGoldPerArrival ?? 0));
    const postValue =
      postWeight *
      Math.max(0, Number(route.postAllianceGoldPerArrival ?? route.teamGoldPerArrival ?? 0));
    let expected = 0;
    for (let tick = Math.floor(start); tick < end; tick++) {
      const overlap = Math.max(0, Math.min(end, tick + 1) - Math.max(start, tick));
      const active = tick + overlap / 2 < start + activeTicks;
      expected += overlap * routeRate(tick) * (active ? activeValue : postValue);
    }
    let partialRateCalls = 0;
    const actual = sandbox.legendaryPortRouteGold(
      route,
      (tick) => {
        partialRateCalls++;
        return routeRate(tick);
      },
      totalWeight,
      postTotalWeight,
      startDelay,
      horizon,
      rangeSum,
    );
    assert.ok(
      Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
      "prefix payout integration preserves exact fractional/alliance economics",
    );
    assert.ok(partialRateCalls <= 2, "full route ticks use the cached prefix range sum");
  }
  assert.deepEqual(
    Array.from(
      sandbox.legendaryNormalizedTradeRoutes([
        { weight: 2, distance: 1.1 },
        { weight: 3, distance: 0 },
        { weight: 0, distance: 8 },
        { weight: 1, distance: -1 },
      ]),
      ({ travelTicks, weight }) => ({ travelTicks, weight }),
    ),
    [
      { travelTicks: 2, weight: 0.4 },
      { travelTicks: 1, weight: 0.6 },
    ],
    "trade route weights and travel ticks are normalized once without changing their shares",
  );
  const upgradeDelta = sandbox.legendaryTradeRateDeltaPrefix([1, 1, 1], [0, 0, 0], 2, 1, {
    fallback: 0,
    config: {
      tradeShipSpawnRate: (_rejections, ships) => (ships > 0 ? 1_000_000 : 1),
    },
    rateCache: new Map(),
    deltaPrefixCache: new WeakMap(),
  });
  assert.deepEqual(
    Array.from(upgradeDelta),
    [0, 0, 0],
    "upgrade throughput deltas clamp each saturated tick before prefix summing",
  );
  const variableConfig = {
    tradeShipSpawnRate: (rejections, ships) =>
      Math.max(1, Math.floor(100 / (rejections + 1) / (1 + ships / 100))),
  };
  const afterPath = [0, 0.25, 1.5, 4.75, 20.5];
  const beforePath = [0, 0.5, 2, 8, 40];
  const afterRateCache = new Map();
  const afterPrefix = sandbox.legendaryTradeRatePrefix(afterPath, 2, {
    fallback: 0,
    config: variableConfig,
    rateCache: afterRateCache,
    prefixCache: new WeakMap(),
  });
  const deltaPrefix = sandbox.legendaryTradeRateDeltaPrefix(afterPath, beforePath, 2, 1, {
    fallback: 0,
    config: variableConfig,
    rateCache: new Map(),
    deltaPrefixCache: new WeakMap(),
  });
  for (let tick = 0; tick < afterPath.length - 1; tick++) {
    const afterRate = sandbox.legendaryExpectedTradeRateAtFleet(
      2,
      afterPath[tick],
      variableConfig,
      afterRateCache,
    );
    const beforeRate = sandbox.legendaryExpectedTradeRateAtFleet(
      1,
      beforePath[tick],
      variableConfig,
      new Map(),
    );
    assert.ok(
      Math.abs(afterPrefix[tick + 1] - afterPrefix[tick] - afterRate) < 1e-12,
      `production rate prefix preserves fractional fleet interpolation at tick ${tick}`,
    );
    assert.ok(
      Math.abs(deltaPrefix[tick + 1] - deltaPrefix[tick] - Math.max(0, afterRate - beforeRate)) <
        1e-12,
      `production upgrade prefix clamps the fractional fleet delta at tick ${tick}`,
    );
  }
}

// Cohorting Ports from different owners preserves every projected fleet tick.
{
  const horizon = 12;
  const owners = [
    {
      ports: [
        {
          level: 1,
          readyAtTicks: 0,
          routes: [
            { weight: 1, distance: 0 },
            { weight: 3, distance: 2.1 },
          ],
        },
        {
          level: 1,
          readyAtTicks: 0,
          routes: [{ weight: 2, distance: 1 }],
        },
      ],
    },
    {
      ports: [
        {
          level: 1,
          readyAtTicks: 0,
          routes: [
            { weight: 1, distance: 0 },
            { weight: 3, distance: 2.1 },
          ],
        },
        {
          level: 2,
          readyAtTicks: 3,
          routes: [
            { weight: 0.25, distance: 4 },
            { weight: 0.75, distance: 7 },
          ],
        },
      ],
    },
  ];
  const config = { tradeShipSpawnRate: () => 1 };
  const projection = sandbox.legendaryProjectEconomyFleets(
    {
      trainCount: 0,
      tradeShipCount: 5,
      fleetProducerSupply: { portOwners: owners, trainOwners: [] },
    },
    config,
    horizon,
    null,
  );
  const expected = new Array(horizon + 1);
  const arrivals = new Float64Array(horizon + 1);
  let ships = 5;
  for (let tick = 0; tick <= horizon; tick++) {
    if (tick > 0) ships = Math.max(0, ships - arrivals[tick]);
    expected[tick] = ships;
    if (tick === horizon) break;
    for (const owner of owners) {
      for (const port of owner.ports) {
        if (tick < port.readyAtTicks) continue;
        const totalWeight = port.routes.reduce((sum, route) => sum + route.weight, 0);
        for (const route of port.routes) {
          const arrivalTick = tick + Math.max(1, Math.ceil(route.distance));
          if (arrivalTick <= horizon) {
            arrivals[arrivalTick] += (0.1 * route.weight) / totalWeight;
          }
        }
        ships += 0.1;
      }
    }
  }
  assert.equal(projection.before.tradeShipCounts.length, expected.length);
  for (let tick = 0; tick < expected.length; tick++) {
    assert.ok(
      Math.abs(projection.before.tradeShipCounts[tick] - expected[tick]) < 1e-12,
      `cross-owner port cohort matches the original per-port fleet projection at tick ${tick}`,
    );
  }
}

// A match-length projection over many owners collapses equivalent Port work.
{
  const horizon = 102_000;
  const ownerCount = 32;
  const ports = Array.from({ length: ownerCount }, () => ({
    level: 1,
    readyAtTicks: 0,
    routes: [{ weight: 1, distance: 1 }],
  }));
  const owners = ports.map((port) => ({ ports: [port] }));
  const cohorts = sandbox.legendaryTradePortCohorts(
    owners.map((owner) => ({
      ports: owner.ports.map((port) => ({
        ...port,
        routes: [{ travelTicks: 1, weight: 1 }],
        count: 1,
      })),
    })),
  );
  assert.equal(cohorts.length, 1, "same-level ready Ports share one fleet-simulation cohort");
  assert.equal(cohorts[0].count, ownerCount);
  const projection = sandbox.legendaryProjectEconomyFleets(
    {
      trainCount: 0,
      tradeShipCount: 0,
      fleetProducerSupply: { portOwners: owners, trainOwners: [] },
    },
    { tradeShipSpawnRate: () => 1 },
    horizon,
    null,
  );
  assert.equal(projection.before.tradeShipCounts.length, horizon + 1);
  assert.equal(projection.before.tradeShipCounts[horizon], 0);
}

// A candidate destination can activate an existing source Port; include both
// new producers in the candidate's saturation and travel-delay projection.
{
  const horizon = 16;
  const config = {
    tradeShipSpawnRate: (_rejections, ships) => (ships < 1 ? 1 : 10),
  };
  const candidate = {
    portReadyAt: 0,
    portRoutes: [{ weight: 1, distance: 3 }],
    portInboundSources: [
      {
        level: 1,
        readyAtTicks: 0,
        routes: [{ weight: 1, distance: 3 }],
      },
    ],
  };
  const projection = sandbox.legendaryProjectEconomyFleets(
    {
      tradeShipCount: 0,
      fleetProducerSupply: { portOwners: [], trainOwners: [] },
    },
    config,
    horizon,
    candidate,
  );
  const expected = new Array(horizon + 1);
  const arrivals = new Float64Array(horizon + 1);
  const rateCache = new Map();
  let ships = 0;
  for (let tick = 0; tick <= horizon; tick++) {
    if (tick > 0) ships = Math.max(0, ships - arrivals[tick]);
    expected[tick] = ships;
    if (tick === horizon) break;
    const births = 2 * sandbox.legendaryExpectedTradeRateAtFleet(1, ships, config, rateCache);
    const arrivalTick = tick + 3;
    if (arrivalTick <= horizon) arrivals[arrivalTick] += births;
    ships += births;
  }
  assert.equal(
    projection.before.tradeShipCounts[horizon],
    0,
    "a hypothetical Port link leaves the baseline fleet unchanged",
  );
  for (let tick = 0; tick <= horizon; tick++) {
    assert.ok(
      Math.abs(projection.after.tradeShipCounts[tick] - expected[tick]) < 1e-12,
      `candidate and newly routed teammate Ports both affect saturation at tick ${tick}`,
    );
  }
}

// A candidate that reroutes an already-productive source replaces its old
// fleet schedule instead of stacking a second schedule on top of it.
{
  const horizon = 8;
  const config = {
    tradeShipSpawnRate: (_rejections, ships) => (ships < 1 ? 1 : 10),
  };
  const rerouteCandidate = {
    portReadyAt: 0,
    portRoutes: [{ weight: 1, distance: 100 }],
    portInboundSources: [
      {
        level: 1,
        readyAtTicks: 0,
        routes: [{ weight: 1, distance: 100 }],
        beforeRoutes: [{ weight: 1, distance: 1 }],
      },
    ],
  };
  const projection = sandbox.legendaryProjectEconomyFleets(
    {
      tradeShipCount: 0,
      fleetProducerSupply: {
        portOwners: [
          {
            ports: [{ level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 1 }] }],
          },
        ],
        trainOwners: [],
      },
    },
    config,
    horizon,
    rerouteCandidate,
  );
  const expected = new Array(horizon + 1);
  const rateCache = new Map();
  let ships = 0;
  for (let tick = 0; tick <= horizon; tick++) {
    expected[tick] = ships;
    if (tick === horizon) break;
    ships += 2 * sandbox.legendaryExpectedTradeRateAtFleet(1, ships, config, rateCache);
  }
  for (let tick = 0; tick <= horizon; tick++) {
    assert.ok(
      Math.abs(projection.after.tradeShipCounts[tick] - expected[tick]) < 1e-12,
      `rerouted source replacement matches its own fleet path at tick ${tick}`,
    );
  }
  assert.ok(
    projection.before.tradeShipCounts[horizon] < expected[horizon],
    "the baseline keeps the short route's turnover, so replacement changes the projection",
  );
}

// A rerouted member of a merged multi-port cohort sheds exactly its own slot:
// the remaining same-owner ports keep the old schedule instead of the whole
// cohort keeping the rerouted port's old schedule on top of its new one.
{
  const horizon = 8;
  const config = {
    tradeShipSpawnRate: (_rejections, ships) => (ships < 1 ? 1 : 10),
  };
  const rerouteCandidate = {
    portReadyAt: 0,
    portRoutes: [{ weight: 1, distance: 100 }],
    portInboundSources: [
      {
        level: 1,
        readyAtTicks: 0,
        routes: [{ weight: 1, distance: 100 }],
        beforeRoutes: [{ weight: 1, distance: 1 }],
      },
    ],
  };
  const projection = sandbox.legendaryProjectEconomyFleets(
    {
      tradeShipCount: 0,
      fleetProducerSupply: {
        portOwners: [
          {
            ports: [
              { level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 1 }] },
              { level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 1 }] },
            ],
          },
        ],
        trainOwners: [],
      },
    },
    config,
    horizon,
    rerouteCandidate,
  );
  const expected = new Array(horizon + 1);
  const arrivals = new Float64Array(horizon + 1);
  const rateCache = new Map();
  let ships = 0;
  for (let tick = 0; tick <= horizon; tick++) {
    if (tick > 0) ships = Math.max(0, ships - arrivals[tick]);
    expected[tick] = ships;
    if (tick === horizon) break;
    const rate = sandbox.legendaryExpectedTradeRateAtFleet(1, ships, config, rateCache);
    arrivals[tick + 1] += rate;
    ships += 3 * rate;
  }
  for (let tick = 0; tick <= horizon; tick++) {
    assert.ok(
      Math.abs(projection.after.tradeShipCounts[tick] - expected[tick]) < 1e-12,
      `merged cohort sheds only the rerouted member at tick ${tick}`,
    );
  }
}

// Substitution is owner-scoped: rerouting one owner's source port must not
// consume a different owner's identical cohort.
{
  const horizon = 8;
  const config = {
    tradeShipSpawnRate: (_rejections, ships) => (ships < 1 ? 1 : 10),
  };
  const rerouteCandidate = {
    portReadyAt: 0,
    portRoutes: [{ weight: 1, distance: 100 }],
    portInboundSources: [
      {
        ownerId: "1",
        level: 1,
        readyAtTicks: 0,
        routes: [{ weight: 1, distance: 100 }],
        beforeRoutes: [{ weight: 1, distance: 1 }],
      },
    ],
  };
  const projection = sandbox.legendaryProjectEconomyFleets(
    {
      tradeShipCount: 0,
      fleetProducerSupply: {
        portOwners: [
          {
            ownerId: "1",
            ports: [{ level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 1 }] }],
          },
          {
            ownerId: "2",
            ports: [{ level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 1 }] }],
          },
        ],
        trainOwners: [],
      },
    },
    config,
    horizon,
    rerouteCandidate,
  );
  const expected = new Array(horizon + 1);
  const arrivals = new Float64Array(horizon + 1);
  const rateCache = new Map();
  let ships = 0;
  for (let tick = 0; tick <= horizon; tick++) {
    if (tick > 0) ships = Math.max(0, ships - arrivals[tick]);
    expected[tick] = ships;
    if (tick === horizon) break;
    const rate = sandbox.legendaryExpectedTradeRateAtFleet(1, ships, config, rateCache);
    arrivals[tick + 1] += rate;
    ships += 3 * rate;
  }
  for (let tick = 0; tick <= horizon; tick++) {
    assert.ok(
      Math.abs(projection.after.tradeShipCounts[tick] - expected[tick]) < 1e-12,
      `cross-owner substitution keeps the untouched owner's cohort at tick ${tick}`,
    );
  }
  assert.ok(
    projection.before.tradeShipCounts[horizon] !== expected[horizon],
    "the two short-route baselines differ from the substituted fleet path",
  );
}

// Live trade economy formulas (openfront-engine Config.ts):
// tradeShipGold = 75k/(1+exp(-0.03*(dist-300))) + 50*dist,
// saturation and spawn-rate (pity timer included) follow the same source.
const SHORT_RANGE_DEBUFF = 300;
const MATCH_HORIZON_TICKS = (170 * 60 * 1_000) / 100;
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const tradeShipGold = (distance) =>
  75_000 * sigmoid(0.03 * (Number(distance) - SHORT_RANGE_DEBUFF)) + 50 * Number(distance);
const tradeShipSaturation = (ships) => {
  const boost = 1 + 0.45 * Math.exp(-ships / 120);
  const damping = 1 - sigmoid((Math.LN2 / 50) * (ships - 330));
  const plateau = 0.25 * (1 - sigmoid((Math.LN2 / 100) * (ships - 800)));
  return boost * Math.max(damping, plateau);
};
const tradeShipSpawnRate = (rejections, ships) =>
  Math.max(1, Math.floor(100 / (rejections + 1) / tradeShipSaturation(ships)));
const portCost = (ownedCount) =>
  BigInt(Math.min(PORT_COST_CAP, PORT_COST_LADDER * 2 ** ownedCount));
const port = (tile, level = 1, underConstruction = false) => ({
  id: () => `port-${tile}`,
  tile: () => tile,
  level: () => level,
  isUnderConstruction: () => underConstruction,
  isMarkedForDeletion: () => false,
  isActive: () => true,
});
const waterOwner = (smallId, { teamId = null, ports = [] } = {}) => ({
  __src: { isLobbyCreator: () => false, ownerId: smallId },
  id: () => smallId,
  smallID: () => smallId,
  teamId,
  isPlayer: () => true,
  isAlive: () => true,
  hasEmbargoAgainst: () => false,
  isOnSameTeam: (other) => teamId !== null && other?.teamId === teamId,
  isAlliedWith: () => false,
  isFriendly: (other) => teamId !== null && other?.teamId === teamId,
  gold: () => 10_000_000n,
  buildables: async (tile, types) =>
    Array.from(types ?? [], (type) => ({
      type,
      cost: portCost(ports.length),
      canBuild: tile ?? true,
    })),
  units: (type) => (type === UNIT.Port ? ports : []),
  borderTiles: () => [10 * smallId],
  oceanShoreBorderTiles: () => [10 * smallId],
});
const waterGame = (player, others, shared = new Set([OCEAN])) => ({
  players: () => [player, ...others],
  sharedWaterComponents: () => shared,
  config: () => liveConfig,
});
const liveConfig = {
  isUnitDisabled: () => false,
  unitInfo: (type) => ({
    constructionDuration: type === UNIT.Port ? PORT_CONSTRUCTION_TICKS : 20,
  }),
  tradeShipGold,
  tradeShipShortRangeDebuff: () => SHORT_RANGE_DEBUFF,
  tradeShipSpawnRate,
  trainStationMinRange: () => 15,
  trainStationMaxRange: () => 110,
  trainSpawnRate: (_factories, trains) => 100 + trains * 1_000,
};
// Water routing uses tiny tile distances so live trade-ship gold dominates cost.
const wireWater = (behavior, ownTile, foreignTile) => {
  behavior.portWaterComponents = () => new Set([OCEAN]);
  behavior.legendaryWaterDistancesFrom = (_sourceTile) =>
    new Map([
      [ownTile, PORT_CONSTRUCTION_TICKS - 1],
      [foreignTile, 2],
    ]);
  behavior.game.neighbors = (tile) => [tile === foreignTile ? ownTile : foreignTile];
  behavior.game.isWater = () => true;
  behavior.game.manhattanDist = (left, right) => Math.abs(Number(left) - Number(right));
  behavior.isShoreBorderTile = () => true;
  behavior.portTileHasOpenWaterAccess = () => true;
};
// The actor has no rail network in every Port scenario; only water routes price.
const behaviorBase = (player, others, shared) => {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.game = waterGame(player, others, shared);
  behavior.player = player;
  behavior.buildReachableStations = () => [];
  behavior.trainGoldBase = () => 50_000;
  behavior.legendaryAllianceTicksRemaining = () => Infinity;
  behavior.ownedLevels = (type) =>
    type === UNIT.Port
      ? player
          .units(UNIT.Port)
          .reduce((total, unit) => total + (unit.isUnderConstruction() ? 0 : unit.level()), 0)
      : 0;
  behavior.cost = (type) => portCost(behavior.ownedLevels(type));
  // The ranked planner now collects live buildable quotes up front.
  player.buildables = async (_tile, types) =>
    Array.from(types ?? [], (type) => ({
      type,
      cost: behavior.cost(type),
      canBuild: true,
      canUpgrade: false,
    }));
  behavior.legendaryCostFactor = () => 1;
  behavior.availableGoldAfterReserve = () => 10_000_000n;
  behavior.probeLegendaryThroughputUpgradeCandidates = async () => [];
  behavior.computeTroopCapPressure = () => false;
  behavior.legendaryConstructionCandidateBlocked = () => false;
  behavior.legendaryBigStartSiloCandidateBlocked = () => false;
  behavior.legendaryPortCapable = () => true;
  behavior.legendaryNavalFrontLoadSuppressed = () => false;
  return behavior;
};
// Fresh per-scenario behavior so caches cannot leak across cases.
const portScenario = ({
  ships = 0,
  trains = 0,
  ownPorts = [],
  others = [],
  shared = new Set([OCEAN]),
  horizonTicks = MATCH_HORIZON_TICKS,
}) => {
  const player = waterOwner(1, { teamId: 7, ports: ownPorts });
  const behavior = behaviorBase(player, others, shared);
  wireWater(behavior, 10, 20);
  behavior.legendaryConstructionState = ({ cityCount }) => ({
    cityCount,
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 0.25,
    tradeNeed: 1.3,
    missileThreat: { critical: false, score: 0 },
    samLevelParityGap: 0,
    siloParityGap: 0,
    siloParityTarget: 0,
    targetPressure: 0,
    defenseGap: 0,
    destroyerNeed: 1,
    portSurvivability: 1,
    hasTradePartner: others.some((other) => other.units(UNIT.Port).length > 0),
    economyHorizonTicks: horizonTicks,
    economyInputs: behavior.legendaryEconomyInputs({
      trainCount: trains,
      tradeShipCount: ships,
      hasTradePartner: others.some((other) => other.units(UNIT.Port).length > 0),
      hasCompletedTradePartner: others.some((other) =>
        other.units(UNIT.Port).some((unit) => !unit.isUnderConstruction()),
      ),
      connectedStops: 1,
      horizonTicks,
    }),
  });
  return { player, behavior };
};
const portCandidates = async (behavior) =>
  (
    await behavior.legendaryConstructionCandidates({
      config: liveConfig,
      citiesDisabled: false,
      cityCount: 4,
      hasCoastalTiles: true,
      hasOceanPortTiles: true,
      missileSilosEnabled: false,
      nukesEnabled: false,
    })
  ).filter((candidate) => candidate.type === UNIT.Port);

// The engine saturation curve consumes summed Factory levels; the userscript
// adapter's unitCount is only the number of UnitViews.
{
  const factory = {
    level: () => 3,
    isUnderConstruction: () => false,
    isMarkedForDeletion: () => false,
    isActive: () => true,
  };
  const owner = waterOwner(44);
  owner.units = (type) => (type === UNIT.Factory ? [factory] : []);
  owner.unitCount = (type) => (type === UNIT.Factory ? 1 : 0);
  const { behavior } = portScenario({});
  behavior.player = owner;
  behavior.game = waterGame(owner, [], new Set());
  const inputs = behavior.legendaryEconomyInputs({
    trainCount: 0,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 0,
  });
  assert.equal(
    inputs.fleetProducerSupply.trainOwners[0]?.factoryCount,
    3,
    "global train saturation counts all three levels even when unitCount reports one UnitView",
  );
}

// (1) No eligible shared-water partner: trade-need only, no economic Port.
{
  const { behavior } = portScenario({});
  const state = behavior.legendaryConstructionState({ cityCount: 4 });
  const economyInputs = {
    ...state.economyInputs,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    hasPendingTradePartner: false,
    portSeedWindowOpen: false,
    portCandidateProfiles: [{ placementTile: 10, routes: [{}], waterComponents: [OCEAN] }],
  };
  behavior.legendaryConstructionState = () => ({ ...state, economyInputs });
  const candidates = await portCandidates(behavior);
  const noPartnerPort = candidates.find((candidate) => candidate.type === UNIT.Port);
  assert.ok(
    noPartnerPort,
    "the no-partner route profile must present a Port candidate to the selector",
  );
  assert.equal(
    noPartnerPort.netTeamGold,
    0n,
    "without a partner Port, the route profile has no economic value",
  );
  assert.ok(
    candidates.every((candidate) => candidate.action !== "build" || candidate.netTeamGold <= 0n),
    "without a shared-water partner Port, a new Port carries no positive economic value",
  );
  assert.equal(
    behavior
      .legendaryConstructionActionGroups(candidates, true)
      .flat()
      .some((candidate) => candidate.type === UNIT.Port),
    false,
    "the selector excludes a no-partner Port from economy actions",
  );
}

// A concrete teammate Port is the only completed paid stop in this rail
// cluster, so a new Factory must earn value from that Port.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({ others: [partner], trains: 10_000 });
  behavior.buildReachableStations = () => [{ tile: 20, cluster: "rail#0" }];
  behavior.game.railroadState = () => Array(31).fill(0);
  behavior.game.width = () => 31;
  behavior.game.height = () => 1;
  behavior.structureCandidateTiles = (type) => (type === UNIT.Factory ? [10] : []);
  behavior.assignRailClusters = (entries) => entries.map(() => "rail#0");
  const economyInputs = behavior.legendaryEconomyInputs({
    trainCount: 10_000,
    tradeShipCount: 0,
    hasTradePartner: true,
    hasCompletedTradePartner: true,
    connectedStops: 1,
  });
  const portStopRoute = economyInputs.factoryRouteProfiles.find(
    (profile) => profile.clusterId === "rail#0",
  );
  assert.ok(
    portStopRoute && portStopRoute.paidStops === 1 && portStopRoute.teamGoldPerSpawn > 0,
    "the real teammate Port appears as one completed, team-paid Factory stop",
  );
  behavior.legendaryConstructionState = ({ cityCount }) => ({
    cityCount,
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 0.25,
    tradeNeed: 0.25,
    missileThreat: { critical: false, score: 0 },
    samLevelParityGap: 0,
    siloParityGap: 0,
    siloParityTarget: 0,
    targetPressure: 0,
    defenseGap: 0,
    economyHorizonTicks: MATCH_HORIZON_TICKS,
    economyInputs,
  });
  const candidates = await behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  const factory = candidates.find((candidate) => candidate.type === UNIT.Factory);
  const portCandidate = candidates.find((candidate) => candidate.type === UNIT.Port);
  assert.ok(
    portCandidate && portCandidate.netTeamGold > 0n,
    "the teammate Port creates a positive Port route on shared water",
  );
  assert.ok(
    !factory || factory.netTeamGold < portCandidate.netTeamGold,
    "high global train saturation removes or lowers the Factory below the Port route",
  );
  assert.equal(
    behavior.legendaryConstructionActionGroups(candidates, true)[0]?.[0]?.type,
    UNIT.Port,
    "the selector prefers the Port when global train saturation lowers Factory value",
  );
}

// (2) Two-owner seed pair: only the selected pair is the no-route exception,
// and the pair stays a single non-duplicated commitment after one side builds.
{
  const partner = waterOwner(2, { teamId: 7 });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const inputs = behavior.legendaryConstructionState({ cityCount: 4 });
  assert.equal(
    inputs.economyInputs.portSeedWindowOpen,
    true,
    "the deterministic two-owner selection opens the seed window for the actor",
  );
  const seedOwn = inputs.economyInputs.portSeedSources.find(
    (source) => source.portSeedStream === "own",
  );
  assert.ok(
    seedOwn && seedOwn.placementTile === 10,
    "the actor's seed placement tile comes from its own shared-water border",
  );
  behavior.hasAnyShoreBorderTile = () => true;
  behavior.constructionCostForOptions = () => portCost(0);
  behavior.buildableCostOrFallback = (buildable, fallback) => buildable.cost ?? fallback;
  assert.equal(
    await behavior.legendaryPortBuildStillWorthIt(
      { cost: portCost(0) },
      { legendaryEconomyPortTile: seedOwn.placementTile },
    ),
    true,
    "the still-selected owner may finish its uncommitted deterministic seed half",
  );
  const shortHorizon = portScenario({
    others: [partner],
    horizonTicks: PORT_CONSTRUCTION_TICKS,
  });
  const unprofitableSeedCandidates = await portCandidates(shortHorizon.behavior);
  assert.equal(
    unprofitableSeedCandidates.some((candidate) => candidate.seedPair === true),
    false,
    "the seed pair is rejected when both live Port costs cannot pay back in the horizon",
  );
  const committedPartner = waterOwner(2, {
    teamId: 7,
    ports: [port(20, 1, true)],
  });
  const { behavior: committedBehavior } = portScenario({
    others: [committedPartner],
  });
  wireWater(committedBehavior, 10, 20);
  const committed = await portCandidates(committedBehavior);
  assert.equal(
    committed.length,
    1,
    "after the partner commits its seed Port, the actor still prices exactly one Port",
  );
  assert.equal(
    committed[0].portPlacementTile,
    10,
    "the committed seed candidate keeps the deterministic actor-side tile",
  );
  committedBehavior.hasAnyShoreBorderTile = () => true;
  committedBehavior.constructionCostForOptions = () => portCost(0);
  committedBehavior.buildableCostOrFallback = (buildable, fallback) => buildable.cost ?? fallback;
  assert.equal(
    await committedBehavior.legendaryPortBuildStillWorthIt(
      { cost: portCost(0) },
      { legendaryEconomyPortTile: committed[0].portPlacementTile },
    ),
    true,
    "the committed seed pair stays valid when its current payback remains positive",
  );
}

// (3) An existing same-water actor Port suppresses a duplicate build; the
// productive upgrade remains rankable and wins.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({
    ownPorts: [port(10)],
    others: [partner],
  });
  wireWater(behavior, 10, 20);
  behavior.player.borderTiles = () => [10, 30];
  behavior.player.oceanShoreBorderTiles = () => [10, 30];
  const inputs = behavior.legendaryConstructionState({ cityCount: 4 });
  assert.equal(
    inputs.economyInputs.ownPortProducerSources.length,
    1,
    "the live network scan retains the builder's productive Port payout profile",
  );
  assert.deepEqual(
    [...inputs.economyInputs.portCandidateProfiles.map((entry) => entry.placementTile)],
    [10, 30],
    "both shared-water tiles still carry route profiles before the served-water suppression",
  );
  assert.deepEqual(
    Object.keys(inputs.economyInputs.portUpgradeProfiles),
    ["port-10"],
    "the completed same-water Port prices a productive upgrade instead of a duplicate",
  );
  const suppressed = await portCandidates(behavior);
  assert.equal(
    suppressed.length,
    0,
    "the completed same-water Port suppresses every duplicate build on that water",
  );
  const upgradeEvaluation = sandbox.legendaryEconomyNetGold(UNIT.Port, {
    cost: Number(portCost(1)),
    horizonTicks: inputs.economyHorizonTicks,
    inputs: {
      ...inputs.economyInputs,
      upgradeAction: true,
      upgradeStructureId: "port-10",
      portUpgradeLevel: 1,
      portUpgradeProfile: inputs.economyInputs.portUpgradeProfiles["port-10"],
    },
    config: liveConfig,
  });
  assert.ok(
    upgradeEvaluation && upgradeEvaluation.refused !== true && upgradeEvaluation.netTeamGold > 0,
    "the productive same-water upgrade prices positive net value and can win",
  );
}

// (4) A novel eligible shared-water route beats the lower-value City.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const candidates = await behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  const portCandidate = candidates.find((candidate) => candidate.type === UNIT.Port);
  const cityCandidate = candidates.find((candidate) => candidate.type === UNIT.City);
  assert.ok(portCandidate && portCandidate.netTeamGold > 0n);
  assert.ok(cityCandidate && cityCandidate.netTeamGold === 0n);
  assert.equal(
    behavior.legendaryConstructionActionGroups(candidates, true)[0][0].type,
    UNIT.Port,
    "the positive net shared-water Port outranks the nonbinding City",
  );
}

// (4b) A newly routed teammate Port must also enter candidate saturation.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const state = behavior.legendaryConstructionState({ cityCount: 4 });
  const profile = state.economyInputs.portCandidateProfiles[0];
  const source = profile.inboundSources[0];
  assert.ok(
    source && !source.beforeProfile && source.afterProfile,
    "the candidate creates a route for the existing teammate's idle source Port",
  );
  const originalProject = sandbox.legendaryProjectEconomyFleets;
  const candidateProjections = [];
  sandbox.legendaryProjectEconomyFleets = (...args) => {
    if (args[3]?.portReadyAt !== undefined) candidateProjections.push(args[3]);
    return originalProject(...args);
  };
  try {
    sandbox.legendaryEconomyNetGold(UNIT.Port, {
      cost: Number(portCost(0)),
      horizonTicks: state.economyHorizonTicks,
      inputs: {
        ...state.economyInputs,
        portCandidateProfiles: [profile],
        portProjectionProfile: profile,
      },
      config: liveConfig,
    });
  } finally {
    sandbox.legendaryProjectEconomyFleets = originalProject;
  }
  assert.ok(
    candidateProjections.some((candidate) =>
      candidate.portInboundSources?.some(
        (entry) => entry.level === source.level && entry.routes === source.afterProfile.routes,
      ),
    ),
    "Port evaluation passes the newly routed teammate producer into saturation projection",
  );
}

// (5) The exact selected tile reaches the async probe and the build emission.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const [candidate] = await portCandidates(behavior);
  const placementCalls = [];
  sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
    placementCalls.push({ buildableTile: buildable.canBuild, tile });
    return true;
  };
  behavior.structureSpawnEligible = () => true;
  behavior.structureTileValueFunction = () => () => 1;
  behavior.structurePlacementCompactnessRanker = () => null;
  behavior.structureMissileEmergency = () => ({ active: false });
  behavior.isDangerousStructureTile = () => false;
  behavior.isSafeBuildablePlacement = () => true;
  behavior.getOrBuildFactoryTradeDestinations = () => [];
  behavior.economicPlacementBudgetLimit = (limit) => limit;
  behavior.consumeEconomicPlacementBudget = () => {};
  behavior.buildableCostOrFallback = (buildable, fallback) => buildable.cost ?? fallback;
  const probedTiles = [];
  behavior.player.buildables = async (tile, types) => {
    probedTiles.push(tile);
    return [
      {
        type: types[0],
        canBuild: tile,
        canUpgrade: false,
        cost: portCost(0),
      },
    ];
  };
  assert.equal(await behavior.legendaryConstructionActionGroupResult([candidate], [], 0), "built");
  assert.deepEqual(
    probedTiles,
    [candidate.portPlacementTile],
    "the selected exact Port tile reaches the real async buildability probe",
  );
  assert.deepEqual(
    placementCalls,
    [{ buildableTile: candidate.portPlacementTile, tile: candidate.portPlacementTile }],
    "the same exact Port tile is emitted after buildability succeeds",
  );

  // The trade economy can change during the async probe. Re-price the exact
  // selected route with the fresh global saturation and authoritative quote.
  const pricedState = behavior.legendaryConstructionState({ cityCount: 4 });
  let probeStarted = false;
  let probedCost = portCost(0);
  behavior.legendaryConstructionState = () => ({
    ...pricedState,
    economyInputs: {
      ...pricedState.economyInputs,
      tradeShipCount: probeStarted ? 100_000 : 0,
    },
  });
  behavior.player.buildables = async (tile, types) => {
    probeStarted = true;
    return [{ type: types[0], canBuild: tile, canUpgrade: false, cost: probedCost }];
  };
  assert.equal(
    await behavior.maybeSpawnStructure(UNIT.Port, {
      useActualCost: true,
      legendaryEconomyCostQuote: candidate.cost,
      legendaryEconomyPortTile: candidate.portPlacementTile,
    }),
    false,
    "a Port that loses positive value to live trade-ship saturation during probing is vetoed",
  );
  assert.equal(placementCalls.length, 1, "the saturated Port is never emitted");

  probeStarted = false;
  probedCost = 10_000_000n;
  behavior.availableGoldAfterReserve = () => 10_000_000n;
  assert.equal(
    await behavior.maybeSpawnStructure(UNIT.Port, {
      useActualCost: true,
      legendaryEconomyCostQuote: candidate.cost,
      legendaryEconomyPortTile: candidate.portPlacementTile,
    }),
    false,
    "a higher authoritative Port quote is included in the fresh net-value check",
  );
  assert.equal(placementCalls.length, 1, "the overpriced Port is never emitted");
}

// (6) Live trade-ship saturation removes the negative route candidate and
// skips the whole economy group.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const saturated = portScenario({ ships: 100_000, others: [partner] });
  wireWater(saturated.behavior, 10, 20);
  const candidates = await saturated.behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  assert.equal(
    candidates.some((candidate) => candidate.type === UNIT.Port),
    true,
    "the saturated Port lane still surfaces its candidate for ranking",
  );
  assert.ok(
    candidates
      .filter((candidate) => candidate.type === UNIT.Port)
      .every((candidate) => candidate.netTeamGold <= 0n),
    "at saturated live trade cadence no Port candidate carries positive net value",
  );
  const groups = saturated.behavior.legendaryConstructionActionGroups(candidates, true);
  assert.equal(
    groups.flat().length,
    0,
    "with no other economy candidate, saturated trade skips the economy group",
  );
}

// (7) Non-team finite alliance route discount vs permanent teammate route.
{
  const buildPair = (ally, allianceTicks) => {
    const partner = waterOwner(2, {
      teamId: ally ? null : 7,
      ports: [port(20)],
    });
    const { behavior } = portScenario({ others: [partner] });
    if (ally) {
      behavior.player.isAlliedWith = (other) => other === partner;
      partner.isAlliedWith = (other) => other === behavior.player;
      behavior.player.isFriendly = (other) =>
        other === partner || behavior.player.teamId === other?.teamId;
      partner.isFriendly = (other) => other === behavior.player;
      behavior.legendaryAlliancePairTicks = () => allianceTicks;
    }
    wireWater(behavior, 10, 20);
    behavior.game.manhattanDist = () => 310;
    const inputs = behavior.legendaryConstructionState({ cityCount: 4 });
    return {
      inputs,
      net: sandbox.legendaryEconomyNetGold(UNIT.Port, {
        cost: Number(portCost(0)),
        horizonTicks: inputs.economyHorizonTicks,
        inputs: {
          ...inputs.economyInputs,
          portCandidateProfiles: inputs.economyInputs.portCandidateProfiles,
        },
        config: behavior.game.config(),
      }),
    };
  };
  const teammate = buildPair(false, Infinity);
  const allied = buildPair(true, 400);
  assert.ok(
    allied.net.netTeamGold < teammate.net.netTeamGold,
    "the finite ally route earns less than the identical permanent teammate route",
  );
  const allyRoute = allied.inputs.economyInputs.portCandidateProfiles[0].routes[0];
  assert.ok(
    allyRoute.allianceTicksRemaining === 400 && allyRoute.postAllianceWeight < allyRoute.weight,
    "the finite ally expiry reaches Port pricing and removes its friendly route weight",
  );
  const teamRoute = teammate.inputs.economyInputs.portCandidateProfiles[0].routes[0];
  assert.equal(
    teamRoute.postAllianceWeight,
    teamRoute.weight,
    "the permanent teammate route keeps full weight for the whole horizon",
  );
}

// (8) Landlocked Legendary: the real ladder body runs with no water access
// and admits no Port candidate at all.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const player = waterOwner(1, { teamId: 7 });
  player.borderTiles = () => [10];
  player.oceanShoreBorderTiles = () => [];
  const behavior = behaviorBase(player, [partner], new Set());
  behavior.isShoreBorderTile = () => false;
  behavior.legendaryConstructionState = ({ cityCount }) => ({
    cityCount,
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 0.25,
    tradeNeed: 1.3,
    missileThreat: { critical: false, score: 0 },
    samLevelParityGap: 0,
    siloParityGap: 0,
    siloParityTarget: 0,
    targetPressure: 0,
    defenseGap: 0,
    destroyerNeed: 1,
    portSurvivability: 1,
    hasTradePartner: true,
    economyHorizonTicks: MATCH_HORIZON_TICKS,
    economyInputs: behavior.legendaryEconomyInputs({
      trainCount: 0,
      tradeShipCount: 0,
      hasTradePartner: true,
      hasCompletedTradePartner: true,
      connectedStops: 1,
    }),
  });
  const candidates = await behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  assert.equal(
    candidates.filter(
      (candidate) =>
        candidate.type === UNIT.Port && candidate.action === "build" && candidate.netTeamGold > 0n,
    ).length,
    0,
    "the landlocked ladder body admits no positive Port build candidate",
  );
  assert.equal(
    behavior
      .legendaryConstructionActionGroups(candidates, true)
      .flat()
      .some((candidate) => candidate.type === UNIT.Port),
    false,
    "the landlocked economy group never selects a Port",
  );
}

// (9) A higher per-arrival payout does not beat a shorter route when the
// horizon leaves too little time to recover the trip delay.
{
  const partner = waterOwner(2, { teamId: 7 });
  const { behavior } = portScenario({ others: [partner], horizonTicks: 300 });
  behavior.player.buildables = async (tile, types) =>
    Array.from(types ?? [], (type) => ({
      type,
      cost: 1n,
      canBuild: tile ?? true,
    }));
  partner.buildables = async (tile, types) =>
    Array.from(types ?? [], (type) => ({ type, cost: 1n, canBuild: tile }));
  wireWater(behavior, 10, 20);
  behavior.oceanPortBorderTiles = () => [10, 30];
  behavior.portTileHasOpenWaterAccess = () => true;
  behavior.portCandidateHasTradeRoute = () => true;
  behavior.legendaryPortRouteProfile = (sourceTile, _owner, destinations) => {
    const longRoute = sourceTile === 10 || destinations.some((entry) => entry.tile === 10);
    const value = longRoute ? 600 : 550;
    const distance = longRoute ? 200 : 20;
    return {
      routes: [
        {
          weight: 1,
          postAllianceWeight: 1,
          distance,
          teamGoldPerArrival: value,
          postAllianceGoldPerArrival: value,
          allianceTicksRemaining: Infinity,
        },
      ],
      waterComponents: [OCEAN],
      teamGoldPerArrival: value,
      postAllianceGoldPerArrival: value,
      routeDelayTicks: distance,
    };
  };
  const [candidate] = await portCandidates(behavior);
  assert.equal(
    candidate?.portPlacementTile,
    30,
    "the seed selector chooses the shorter route's greater projected team value, not the larger gross arrival",
  );
}

// Site order cannot change which route wins; each finalist gets its own fleet path.
{
  const evaluateOrder = async (tiles) => {
    const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
    const { behavior } = portScenario({ others: [partner], horizonTicks: 300 });
    behavior.player.buildables = async (tile, types) =>
      Array.from(types ?? [], (type) => ({ type, cost: 1n, canBuild: tile ?? true }));
    partner.buildables = async (tile, types) =>
      Array.from(types ?? [], (type) => ({ type, cost: 1n, canBuild: tile }));
    wireWater(behavior, 10, 20);
    behavior.oceanPortBorderTiles = () => tiles;
    behavior.portTileHasOpenWaterAccess = () => true;
    behavior.portCandidateHasTradeRoute = () => true;
    behavior.legendaryPortRouteProfile = (sourceTile, _owner, destinations) => {
      const longRoute = sourceTile === 10 || destinations.some((entry) => entry.tile === 10);
      const value = longRoute ? 600 : 550;
      const distance = longRoute ? 200 : 20;
      return {
        routes: [
          {
            weight: 1,
            postAllianceWeight: 1,
            distance,
            teamGoldPerArrival: value,
            postAllianceGoldPerArrival: value,
            allianceTicksRemaining: Infinity,
          },
        ],
        waterComponents: [OCEAN],
        teamGoldPerArrival: value,
        postAllianceGoldPerArrival: value,
        routeDelayTicks: distance,
      };
    };
    const projectionSignatures = [];
    const project = sandbox.legendaryProjectEconomyFleets;
    sandbox.legendaryProjectEconomyFleets = (inputs, config, horizon, candidate) => {
      if (candidate?.portReadyAt !== undefined) {
        projectionSignatures.push(
          `${candidate.portRoutes?.[0]?.distance}:` +
            `${candidate.portInboundSources?.[0]?.routes?.[0]?.distance ?? "none"}`,
        );
      }
      return project(inputs, config, horizon, candidate);
    };
    try {
      const [candidate] = await portCandidates(behavior);
      return { candidate, projectionSignatures };
    } finally {
      sandbox.legendaryProjectEconomyFleets = project;
    }
  };
  const forward = await evaluateOrder([10, 30]);
  const reverse = await evaluateOrder([30, 10]);
  assert.equal(forward.candidate?.portPlacementTile, 30);
  assert.equal(reverse.candidate?.portPlacementTile, 30);
  assert.equal(
    forward.candidate?.netTeamGold,
    reverse.candidate?.netTeamGold,
    "reversing legal candidate enumeration preserves the selected route value",
  );
  assert.deepEqual(
    [...new Set(forward.projectionSignatures)].sort(),
    [...new Set(reverse.projectionSignatures)].sort(),
    "the same route-specific fleet scenarios are projected in either enumeration order",
  );
}

// A 25-site, match-length decision projects no more than two route signatures.
{
  const profiles = Array.from({ length: 25 }, (_, index) => ({
    placementTile: index + 100,
    routes: [
      {
        weight: 1,
        distance: index + 1,
        teamGoldPerArrival: index + 1,
        postAllianceGoldPerArrival: index + 1,
      },
    ],
    teamGoldPerArrival: index + 1,
    postAllianceGoldPerArrival: index + 1,
  }));
  const inputs = {
    tradeShipCount: 0,
    hasCompletedTradePartner: true,
    fleetProducerSupply: { portOwners: [], trainOwners: [] },
    portCandidateProfiles: profiles,
    portProjectionProfile: profiles[0],
  };
  const config = {
    unitInfo: () => ({ constructionDuration: 1 }),
    tradeShipSpawnRate: () => 1_000_000,
  };
  let candidateProjectionCount = 0;
  const project = sandbox.legendaryProjectEconomyFleets;
  sandbox.legendaryProjectEconomyFleets = (fleetInputs, liveConfig, horizon, candidate) => {
    if (candidate?.portReadyAt !== undefined) candidateProjectionCount++;
    return project(fleetInputs, liveConfig, horizon, candidate);
  };
  try {
    sandbox.legendaryEconomyNetGold(UNIT.Port, {
      cost: 1,
      horizonTicks: 102_000,
      inputs,
      config,
    });
  } finally {
    sandbox.legendaryProjectEconomyFleets = project;
  }
  assert.ok(
    candidateProjectionCount <= 2,
    `25 distinct placement profiles stay within two full fleet projections (got ${candidateProjectionCount})`,
  );
}

process.stdout.write("legendary port economy selection tests passed\n");
