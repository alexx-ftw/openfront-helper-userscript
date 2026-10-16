import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({
  vmFilename: "legendary-alliance-expiry-policy.vm.js",
});
const { UNIT } = sandbox;
const currentTick = 100;
const payoutByRelation = { team: 50_000, ally: 100_000, other: 1_000 };

function valueForNetwork(relation, expiresAt = Infinity) {
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
  sandbox.legendaryPortExpectedGold({ routes: portRoutes }, {
    rateAtTick: () => 1,
    startDelayTicks,
    horizon,
  });
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

process.stdout.write(
  `legendary alliance expiry policy passed: expiring=${expiringAlly.netTeamGold}, ` +
    `indefinite=${indefiniteAlly.netTeamGold}\n`,
);
