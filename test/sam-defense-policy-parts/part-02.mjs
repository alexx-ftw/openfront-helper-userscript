    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    behavior.game = {
      ...foreignGame,
      players: () => owners,
    };
    behavior.player = {
      units: () => [],
      smallID: () => 1,
      id: () => 1,
      hasEmbargoAgainst: () => false,
    };
    behavior.getOrBuildReachableStations = () => [];
    behavior.getOrBuildFactoryTradeDestinations = () => [];
    return behavior;
  };
  const nearCandidate = 3_500; // manhattan distance 5 from the ocean port at (0,30)
  const farCandidate = 9_900; // manhattan distance 69 from the ocean port
  const tradingValue = makeForeignBehavior([
    makePlayer(2, [
      oceanPort(3_000),
      buildingPort(5_005),
      oceanPort(6_060), // excluded below by the lake predicate
    ]),
  ]).portValue();
  assert.ok(
    tradingValue(farCandidate) > tradingValue(nearCandidate),
    "Ports prefer coastal sites far from tradeable foreign open-ocean ports",
  );
  const levelWeightedScore = (farPortLevel) =>
    makeForeignBehavior([
      makePlayer(2, [oceanPort(3_000), oceanPort(9_900, farPortLevel)]),
    ]).portValue()(5_005);
  assert.ok(
    levelWeightedScore(10) > levelWeightedScore(1),
    "a high-level far Port contributes more route value when the nearest Port is unchanged",
  );
  const unreachableOnly = makeForeignBehavior([
    makePlayer(2, [buildingPort(3_000), oceanPort(6_060)]),
    makePlayer(3, [oceanPort(3_000)], true),
  ]).portValue();
  const noForeign = makeForeignBehavior([]).portValue();
  assert.equal(
    unreachableOnly(farCandidate),
    noForeign(farCandidate),
    "under-construction, lake, and embargoed foreign ports do not shift Port placement",
  );
}
assert.ok(
  factoryCommercialValue(1_050) > factoryCommercialValue(9_999),
  "Factories always prefer a reachable commercial destination, including on Easy",
);
assert.equal(
  commercialRailBehavior.existingRailSnapDistance(5_000),
  null,
  "a distant tile does not receive a fabricated rail-line preference",
);
assert.equal(
  commercialRailStateReads,
  4,
  "each economic scorer snapshots railroad state once instead of rereading it for every candidate",
);

const factoryDestinationBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const station = (tile, id) => ({ hasTrainStation: () => true, tile: () => tile, id: () => id });
factoryDestinationBehavior.player = {
  units: (...types) => {
    const units = [];
    if (types.includes(sandbox.UNIT.City)) units.push(station(100, "city"));
    if (types.includes(sandbox.UNIT.Factory)) units.push(station(101, "factory"));
    return units;
  },
  nearby: () => [],
};
factoryDestinationBehavior.trainGoldBase = (relation) => (relation === "ally" ? 35_000 : 10_000);
assert.deepEqual(
  Array.from(
    factoryDestinationBehavior
      .collectReachableStations([sandbox.UNIT.City, sandbox.UNIT.Port])
      .map((entry) => entry.tile),
  ),
  [100],
  "Factory trade scoring excludes other Factories because they do not pay train gold",
);

const alliedDestinationBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const alliedStation = station(200, "ally-city");
const alliedTradeOwner = {
  isPlayer: () => true,
  type: () => "Human",
  id: () => 2,
  hasEmbargoAgainst: () => false,
  units: (...types) => (types.includes(sandbox.UNIT.City) ? [alliedStation] : []),
};
alliedDestinationBehavior.player = {
  id: () => 1,
  hasEmbargoAgainst: () => false,
  isAlliedWith: () => true,
  isOnSameTeam: () => false,
  units: (...types) => (types.includes(sandbox.UNIT.City) ? [station(100, "self-city")] : []),
  nearby: () => [alliedTradeOwner],
};
alliedDestinationBehavior.trainGoldBase = (relation) => (relation === "ally" ? 35_000 : 10_000);
const alliedDestinations = Array.from(
  alliedDestinationBehavior.collectReachableStations([sandbox.UNIT.City, sandbox.UNIT.Port]),
);
assert.equal(alliedDestinations.length, 2);
assert.ok(
  alliedDestinations.find((entry) => entry.tile === 200).weight >
    alliedDestinations.find((entry) => entry.tile === 100).weight,
  "a tradeable allied City is the higher-value Factory destination",
);

const sparseRailBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const sparseRailState = new Uint8Array(2_000_000);
for (const tile of [100, 101, 102, 1_000_000]) sparseRailState[tile] = 1;
sparseRailBehavior.game = {
  width: () => 2000,
  height: () => 1000,
  neighbors: (tile) => {
    if (tile === 100) return [101];
    if (tile === 101) return [100, 102];
    if (tile === 102) return [101];
    return [];
  },
};
assert.deepEqual(
  Array.from(
    sparseRailBehavior.assignRailClusters(
      [{ tile: 100 }, { tile: 102 }, { tile: 1_000_000 }, { tile: 1_500_000 }],
      sparseRailState,
    ),
  ),
  ["rail#0", "rail#0", "rail#1", null],
  "sparse rail labels preserve connected, disconnected, and isolated station clusters",
);
assert.doesNotMatch(
  readStructureBehaviorSource(),
  /new Int32Array\(total\)\.fill\(-1\)/,
  "rail scoring must not clear a map-sized label array on every Auto-build decision",
);

const teamInteriorBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let teamInteriorTick = 100;
const teamInteriorNeighbors = new Map([
  [10, [11]],
  [20, [21]],
  [30, [31, 32]],
]);
const teamInteriorOwners = new Map([
  [10, 1],
  [11, 2],
  [20, 1],
  [21, 3],
  [30, 1],
  [31, 2],
]);
const teamInteriorFriendlyOwner = { smallID: () => 2 };
const teamInteriorHostileOwner = { smallID: () => 3 };
teamInteriorBehavior.game = {
  ticks: () => teamInteriorTick,
  neighbors: (tile) => teamInteriorNeighbors.get(tile) ?? [],
  hasOwner: (tile) => teamInteriorOwners.has(tile),
  ownerID: (tile) => teamInteriorOwners.get(tile),
  playerBySmallID: (sid) => (sid === 2 ? teamInteriorFriendlyOwner : teamInteriorHostileOwner),
  magnitude: () => 0,
  config: () => ({
    trainStationMinRange: () => 1,
    trainStationMaxRange: () => 100,
  }),
};
teamInteriorBehavior.player = {
  smallID: () => 1,
  borderTiles: () => new Set([10, 20, 30]),
  isFriendly: (owner) => owner === teamInteriorFriendlyOwner,
  isOnSameTeam: () => false,
  units: () => [],
};
teamInteriorBehavior._economicExposureBorderTick = null;
teamInteriorBehavior._economicExposureBorderTiles = null;
teamInteriorBehavior.spacingConstants = () => ({
  borderSpacing: 50,
  structureSpacing: 100,
});
teamInteriorBehavior.getOrBuildReachableStations = () => [];
teamInteriorBehavior.getOrBuildFactoryTradeDestinations = () => [];
teamInteriorBehavior.shouldUseConnectivityScore = () => false;
teamInteriorBehavior.commercialRailPlacementScore = () => 0;

assert.deepEqual(
  [...teamInteriorBehavior.economicExposureBorderTiles()],
