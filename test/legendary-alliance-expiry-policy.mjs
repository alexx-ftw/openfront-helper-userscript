import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({
  vmFilename: "legendary-alliance-expiry-policy.vm.js",
});
const { UNIT } = sandbox;
const currentTick = 100;
const payoutByRelation = { team: 50_000, ally: 100_000, other: 1_000 };

function valueForNetwork(relation, expiresAt = Infinity, motionPlans = undefined) {
  const makeOwner = (id) => {
    const units = new Map();
    return {
      id: () => id,
      smallID: () => id,
      units: (type) => units.get(type) ?? [],
      setUnits: (type, value) => units.set(type, value),
      isAlive: () => true,
      isLobbyCreator: () => false,
      hasEmbargoAgainst: () => false,
      isOnSameTeam: () => false,
      isAlliedWith: () => false,
      alliances: () => [],
    };
  };
  const own = makeOwner("own");
  const network = makeOwner("network");
  const teammate = relation === "team";
  const ally = relation === "ally";
  own.isOnSameTeam = (owner) => teammate && owner === network;
  network.isOnSameTeam = (owner) => teammate && owner === own;
  own.isAlliedWith = (owner) => ally && owner === network;
  network.isAlliedWith = (owner) => ally && owner === own;
  if (ally) {
    own.alliances = () => [{ other: "network", expiresAt }];
    network.alliances = () => [{ other: "own", expiresAt }];
  }

  const factory = {
    id: () => "own-factory",
    tile: () => 1,
    level: () => 1,
    isUnderConstruction: () => false,
    isMarkedForDeletion: () => false,
    isActive: () => true,
  };
  const city = {
    id: () => "network-city",
    tile: () => 2,
    level: () => 1,
    isUnderConstruction: () => false,
    hasTrainStation: () => false,
    isMarkedForDeletion: () => false,
    isActive: () => true,
  };
  own.setUnits(UNIT.Factory, [factory]);
  network.setUnits(UNIT.City, [city]);

  const config = {
    allianceDuration: () => Infinity,
    trainGold: (playerRelation) => payoutByRelation[playerRelation] ?? 0,
    trainSpawnRate: () => 10,
    trainStationMaxRange: () => 0,
    unitInfo: () => ({ constructionDuration: 0 }),
  };
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.player = own;
  behavior.game = {
    config: () => config,
    players: () => [own, network],
    units: () => [],
    ticks: () => currentTick,
    sharedWaterComponents: () => null,
    motionPlans,
  };
  behavior.buildReachableStations = () => [
    { tile: 1, cluster: "rail" },
    { tile: 2, cluster: "rail" },
  ];
  behavior.readRailroadState = () => null;

  const inputs = behavior.legendaryEconomyInputs({
    trainCount: 0,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 1,
    horizonTicks: 100,
  });
  const value = sandbox.legendaryEconomyNetGold("Factory", {
    cost: 10_000,
    horizonTicks: 100,
    inputs,
    config,
  });
  assert.ok(value && !value.refused, "the same paid Factory route is evaluable in each fixture");
  return { inputs, netTeamGold: value.netTeamGold };
}

const motionFailure = new Error("unexpected motion-plan failure");
assert.throws(
  () =>
    valueForNetwork("team", Infinity, () => {
      throw motionFailure;
    }),
  (error) => error === motionFailure,
  "missing optional motion data is allowed, but unexpected query failures propagate",
);

const teammate = valueForNetwork("team");
const indefiniteAlly = valueForNetwork("ally");
const expiringAlly = valueForNetwork("ally", currentTick + 20);
const payoutTimeline = expiringAlly.inputs.factoryRouteProfiles[0].payoutTimeline;

assert.equal(
  teammate.inputs.factoryRouteProfiles[0].teamGoldPerSpawn,
  indefiniteAlly.inputs.factoryRouteProfiles[0].teamGoldPerSpawn,
  "the teammate and indefinitely eligible ally start at the same team payout",
);
assert.equal(
  expiringAlly.inputs.factoryRouteProfiles[0].teamGoldPerSpawn,
  indefiniteAlly.inputs.factoryRouteProfiles[0].teamGoldPerSpawn,
  "the expiring ally network has the same payout before expiry",
);
assert.equal(payoutTimeline.length, 2, "the ally payout schedule includes its expiry boundary");
assert.equal(payoutTimeline[1].atTicks, 20, "expiry is measured from the current game tick");
assert.equal(
  payoutTimeline[1].teamGoldPerSpawn,
  payoutByRelation.other,
  "the non-team ally stops receiving the eligible ally payout after expiry",
);
assert.equal(
  teammate.netTeamGold,
  indefiniteAlly.netTeamGold,
  "the equal-payout teammate and indefinite ally networks have equal marginal value",
);
assert.ok(
  expiringAlly.netTeamGold < indefiniteAlly.netTeamGold,
  `expiry discounts marginal team value (${expiringAlly.netTeamGold} < ${indefiniteAlly.netTeamGold})`,
);

const portRoutes = [10, Infinity].map((allianceTicksRemaining, index) => ({
  weight: index === 0 ? 3 : 2,
  postAllianceWeight: 2,
  distance: 0,
  teamGoldPerArrival: 100,
  allianceTicksRemaining,
}));
const portProjection = (startDelayTicks, horizon) =>
  sandbox.legendaryPortExpectedGold(
    { routes: portRoutes },
    {
      rateAtTick: () => 1,
      startDelayTicks,
      horizon,
    },
  );
assert.equal(
  portProjection(0, 10),
  1_000,
  "active route probabilities conserve departures before alliance expiry",
);
assert.equal(
  portProjection(10, 20),
  1_000,
  "post-expiry route probabilities conserve departures after alliance expiry",
);
assert.equal(
  portProjection(0, 20),
  2_000,
  "partial alliance expiry conserves all departures across equal-payout Port routes",
);

// Staggered expiries must share one live destination denominator, including
// destinations whose own weight never changes. Compare optimized prefix and
// numeric-rate projections with an independent interval integral.
const staggeredRoutes = [
  {
    weight: 3,
    postAllianceWeight: 2,
    distance: 1.25,
    teamGoldPerArrival: 100,
    allianceTicksRemaining: 5.25,
  },
  {
    weight: 3,
    postAllianceWeight: 2,
    distance: 2.5,
    teamGoldPerArrival: 200,
    allianceTicksRemaining: 9.75,
  },
  {
    weight: 2,
    postAllianceWeight: 2,
    distance: 0,
    teamGoldPerArrival: 300,
    allianceTicksRemaining: Infinity,
  },
];
const rate = (tick) => 1 + tick / 10;
const horizon = 15.5;
const startDelayTicks = 0.5;
const reference = (rateAtTick) => {
  const boundaries = [
    ...new Set([
      0,
      horizon,
      5.25,
      9.75,
      ...staggeredRoutes.map((route) => route.distance + startDelayTicks),
      ...Array.from({ length: Math.ceil(horizon) }, (_, tick) => tick),
    ]),
  ]
    .filter((tick) => tick <= horizon)
    .sort((a, b) => a - b);
  let total = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const weightAt = (route) =>
      start < route.allianceTicksRemaining ? route.weight : route.postAllianceWeight;
    const denominator = staggeredRoutes.reduce((sum, route) => sum + weightAt(route), 0);
    for (const route of staggeredRoutes) {
      if (start < startDelayTicks + route.distance) continue;
      total +=
        (((end - start) * rateAtTick(Math.floor(start)) * weightAt(route)) / denominator) *
        route.teamGoldPerArrival;
    }
  }
  return total;
};
const assertClose = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);
const projectionOptions = { startDelayTicks, horizon, rateAtTick: rate };
assertClose(
  sandbox.legendaryPortExpectedGold({ routes: staggeredRoutes }, projectionOptions),
  reference(rate),
  "staggered expiry integrates current destination probabilities",
);
let prefixCalls = 0;
let pointCalls = 0;
assertClose(
  sandbox.legendaryPortExpectedGold(
    { routes: staggeredRoutes },
    {
      ...projectionOptions,
      rateAtTick: (tick) => {
        pointCalls++;
        return rate(tick);
      },
      rateRangeSum: (start, end) => {
        prefixCalls++;
        return end - start + ((end - start) * (start + end - 1)) / 20;
      },
    },
  ),
  reference(rate),
  "prefix integration agrees across fractional expiries and travel",
);
assert.ok(prefixCalls > 0 && pointCalls <= 18, "prefix projection only probes event-edge ticks");
const constantRate = sandbox.legendaryPortRate(1, false, 0, {
  tradeShipSpawnRate: () => 10,
});
assertClose(
  sandbox.legendaryPortExpectedGold(
    { routes: staggeredRoutes },
    {
      startDelayTicks,
      horizon,
      level: 1,
      upgrade: false,
      tradeShipCount: 0,
      config: { tradeShipSpawnRate: () => 10 },
    },
  ),
  reference(() => constantRate),
  "numeric rate shares the same expiry denominator",
);

// Mature boards must not multiply every destination by every owner expiry.
const manyRoutes = Array.from({ length: 256 }, (_, index) => ({
  weight: 3,
  postAllianceWeight: 2,
  distance: index / 4,
  teamGoldPerArrival: 100,
  allianceTicksRemaining: 100 + index * 300,
}));
let manyPrefixCalls = 0;
let manyPointCalls = 0;
const manyProjection = sandbox.legendaryPortExpectedGold(
  { routes: manyRoutes },
  {
    startDelayTicks: 0,
    horizon: 100_000,
    rateAtTick: () => {
      manyPointCalls++;
      return 1;
    },
    rateRangeSum: (start, end) => {
      manyPrefixCalls++;
      return end - start;
    },
  },
);
assert.ok(Number.isFinite(manyProjection) && manyProjection > 0);
assert.ok(
  manyPrefixCalls < 4 * manyRoutes.length,
  "prefix operations grow with arrivals and expiries, not their cross product",
);
assert.ok(
  manyPointCalls < 4 * manyRoutes.length,
  "fractional edge probes remain linear in destination count",
);
const disappearingRoutes = [
  {
    weight: 1,
    postAllianceWeight: 0,
    distance: 0,
    teamGoldPerArrival: 100,
    allianceTicksRemaining: 5,
  },
  {
    weight: 1,
    postAllianceWeight: 0,
    distance: 6,
    teamGoldPerArrival: 300,
    allianceTicksRemaining: 4,
  },
];
assert.equal(
  sandbox.legendaryPortExpectedGold(
    { routes: disappearingRoutes },
    {
      startDelayTicks: 0,
      horizon: 10,
      rateAtTick: () => 1,
      rateRangeSum: (start, end) => end - start,
    },
  ),
  300,
  "expiry before arrival adds no payout; removing all weights ends income",
);

for (const invalid of [
  { startDelayTicks: 0, horizon: Infinity },
  { startDelayTicks: NaN, horizon: 100 },
]) {
  assert.equal(
    sandbox.legendaryPortExpectedGold(
      { routes: manyRoutes },
      {
        ...invalid,
        rateAtTick: () => {
          throw new Error("invalid interval must not probe rates");
        },
      },
    ),
    0,
    "unbounded or unreadable projection intervals fail closed",
  );
}

process.stdout.write(
  `legendary alliance expiry policy passed: expiring=${expiringAlly.netTeamGold}, ` +
    `indefinite=${indefiniteAlly.netTeamGold}\n`,
);
