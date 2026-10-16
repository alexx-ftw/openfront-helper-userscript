// Config.trainGold("self", citiesVisited): the first ten paying stops have
// no distance penalty, then each additional stop costs 5k down to 5k.
const defaultGoldForTradeStop = (stopIndex, relation = "self") => {
  const baseGold = { self: 10_000, team: 25_000, other: 25_000, ally: 35_000 }[relation] ?? 25_000;
  return Math.max(5_000, baseGold - Math.max(0, stopIndex - 9) * 5_000);
};

export function createConstructionSimulator({
  width,
  height,
  ownerId,
  ownedTiles,
  railTiles,
  randomTiles = [],
}) {
  const owned = new Set(ownedTiles);
  const occupied = new Set();
  const railroadState = new Uint8Array(width * height);
  for (const tile of railTiles) railroadState[tile] = 1;

  return {
    game: {
      width: () => width,
      height: () => height,
      x: (tile) => tile % width,
      y: (tile) => Math.floor(tile / width),
      ref: (x, y) => y * width + x,
      isValidCoord: (x, y) => x >= 0 && x < width && y >= 0 && y < height,
      ownerID: (tile) => (owned.has(tile) ? ownerId : 0),
      railroadState: () => railroadState,
    },
    player: { smallID: () => ownerId },
    randomTerritoryTiles: () => randomTiles.slice(),
    attemptCity(candidates) {
      const tile = candidates.find((candidate) => owned.has(candidate) && !occupied.has(candidate));
      if (tile === undefined) return null;
      occupied.add(tile);
      return tile;
    },
  };
}

// Small deterministic model of the engine's TrainExecution economics: a train
// follows a station path and pays at every City/Port it reaches after the
// Factory source. It is intentionally a fixed-demand simulator; destination
// sampling and map generation remain the headless game's responsibility.
export function simulateRailTransitRevenue({
  adjacency,
  stationTypes,
  factoryIds,
  destinationIds,
  candidateId,
  stationRelations = new Map(),
  goldForTradeStop = defaultGoldForTradeStop,
}) {
  const types = new Map(stationTypes);
  if (candidateId !== null && candidateId !== undefined) types.set(candidateId, "City");
  const revenueByStation = new Map();
  let totalRevenue = 0;
  for (const factory of factoryIds) {
    for (const destination of destinationIds) {
      const path = shortestStationPath(adjacency, factory, destination);
      if (path === null) continue;
      totalRevenue += collectRouteTransitRevenue(path, types, goldForTradeStop, {
        stationRelations,
        revenueByStation,
      });
    }
  }
  return { totalRevenue, revenueByStation };
}

// Deterministic expected-value model of the live TrainStationExecution loop.
// Each Factory independently attempts to spawn a train, observes the ten-tick
// post-spawn cooldown, and chooses uniformly among tradeable Cities and Ports
// in its connected rail cluster.
export function expectedRailIncomePerTick({
  adjacency,
  stationTypes,
  stationOwners = new Map(),
  factoryLevels = new Map(),
  factoryOwnerIds = new Map(),
  stationOwnerIds = new Map(),
  candidate = null,
  goldForTradeStop = defaultGoldForTradeStop,
}) {
  const scenario = normalizeRailIncomeScenario({
    stationTypes,
    stationOwners,
    factoryLevels,
    factoryOwnerIds,
    stationOwnerIds,
    candidate,
  });
  const { types, relations, levels, sourceOwners, endpointOwners } = scenario;
  const factoryLevelsByOwner = sumFactoryLevelsByOwner(types, levels, sourceOwners);

  const revenueByStation = new Map();
  const sourceIncomeByOwner = new Map();
  const endpointIncomeByOwner = new Map();
  let totalIncomePerTick = 0;
  let totalSpawnProbability = 0;

  for (const [factory, level] of levels) {
    if (!isEligibleFactory(types, factory, level)) continue;
    const sourceOwnerId = sourceOwners.get(factory) ?? "self";
    const sourceFactoryLevels = factoryLevelsByOwner.get(sourceOwnerId) ?? 0;
    if (sourceFactoryLevels <= 0) continue;
    const destinations = reachableTradeDestinations(adjacency, types, factory);
    if (destinations.length === 0) continue;

    const spawnProbability = expectedFactorySpawnProbability(level, sourceFactoryLevels);
    totalSpawnProbability += spawnProbability;
    const destinationProbability = spawnProbability / destinations.length;
    totalIncomePerTick += expectedFactoryRouteIncome({
      factory,
      destinations,
      adjacency,
      types,
      relations,
      endpointOwners,
      sourceOwnerId,
      destinationProbability,
      goldForTradeStop,
      revenueByStation,
      sourceIncomeByOwner,
      endpointIncomeByOwner,
    });
  }
  const totalEndpointIncomePerTick = sumValues(endpointIncomeByOwner);
  return {
    totalIncomePerTick,
    totalSpawnProbability,
    revenueByStation,
    sourceIncomeByOwner,
    endpointIncomeByOwner,
    totalEndpointIncomePerTick,
  };
}

function normalizeRailIncomeScenario({
  stationTypes,
  stationOwners,
  factoryLevels,
  factoryOwnerIds,
  stationOwnerIds,
  candidate,
}) {
  const scenario = {
    types: new Map(stationTypes),
    relations: new Map(stationOwners),
    levels: new Map(factoryLevels),
    sourceOwners: new Map(factoryOwnerIds),
    endpointOwners: new Map(stationOwnerIds),
  };
  if (!candidate) return scenario;

  scenario.types.set(candidate.id, candidate.type);
  const ownerId = candidate.ownerId ?? candidate.owner ?? "self";
  if (candidate.type === "Factory") {
    scenario.levels.set(candidate.id, candidate.level ?? 1);
    scenario.sourceOwners.set(candidate.id, ownerId);
  } else {
    scenario.relations.set(candidate.id, candidate.relation ?? candidate.owner ?? "self");
    scenario.endpointOwners.set(candidate.id, ownerId);
  }
  return scenario;
}

function sumFactoryLevelsByOwner(types, levels, sourceOwners) {
  const totals = new Map();
  for (const [factory, level] of levels) {
    if (!isEligibleFactory(types, factory, level)) continue;
    const ownerId = sourceOwners.get(factory) ?? "self";
    totals.set(ownerId, (totals.get(ownerId) ?? 0) + level);
  }
  return totals;
}

function isEligibleFactory(types, factory, level) {
  return types.get(factory) === "Factory" && Number.isFinite(level) && level > 0;
}

function reachableTradeDestinations(adjacency, types, factory) {
  return Array.from(reachableStations(adjacency, factory)).filter((station) => {
    const type = types.get(station);
    return station !== factory && (type === "City" || type === "Port");
  });
}

function expectedFactorySpawnProbability(level, ownerFactoryLevels) {
  const spawnRate = (ownerFactoryLevels + 10) * 15;
  const attemptProbability = 1 - (1 - 1 / spawnRate) ** level;
  return attemptProbability / (1 + 9 * attemptProbability);
}

function expectedFactoryRouteIncome({
  factory,
  destinations,
  adjacency,
  types,
  relations,
  endpointOwners,
  sourceOwnerId,
  destinationProbability,
  goldForTradeStop,
  revenueByStation,
  sourceIncomeByOwner,
  endpointIncomeByOwner,
}) {
  let total = 0;
  for (const destination of destinations) {
    const path = shortestStationPath(adjacency, factory, destination);
    if (path === null) continue;
    total += collectRouteTransitRevenue(path, types, goldForTradeStop, {
      stationRelations: relations,
      revenueByStation,
      routeProbability: destinationProbability,
      sourceOwnerId,
      stationOwnerIds: endpointOwners,
      sourceIncomeByOwner,
      endpointIncomeByOwner,
    });
  }
  return total;
}

function sumValues(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function reachableStations(adjacency, source) {
  const reachable = new Set([source]);
  const queue = [source];
  for (let index = 0; index < queue.length; index += 1) {
    for (const neighbor of adjacency.get(queue[index]) ?? []) {
      if (reachable.has(neighbor)) continue;
      reachable.add(neighbor);
      queue.push(neighbor);
    }
  }
  return reachable;
}

function collectRouteTransitRevenue(
  path,
  stationTypes,
  goldForTradeStop,
  {
    stationRelations,
    revenueByStation,
    routeProbability = 1,
    sourceOwnerId = null,
    stationOwnerIds = null,
    sourceIncomeByOwner = null,
    endpointIncomeByOwner = null,
  },
) {
  let totalRevenue = 0;
  let tradeStopsVisited = 0;
  for (const station of path.slice(1)) {
    if (!isTradeStation(stationTypes, station)) continue;
    const revenue =
      goldForTradeStop(tradeStopsVisited, stationRelations.get(station) ?? "self") *
      routeProbability;
    totalRevenue += revenue;
    revenueByStation.set(station, (revenueByStation.get(station) ?? 0) + revenue);
    recordSourceIncome(sourceIncomeByOwner, sourceOwnerId, revenue);
    recordEndpointIncome({
      endpointIncomeByOwner,
      stationOwnerIds,
      stationRelations,
      station,
      sourceOwnerId,
      revenue,
    });
    tradeStopsVisited += 1;
  }
  return totalRevenue;
}

function isTradeStation(stationTypes, station) {
  const type = stationTypes.get(station);
  return type === "City" || type === "Port";
}

function recordSourceIncome(sourceIncomeByOwner, ownerId, revenue) {
  if (sourceIncomeByOwner === null || ownerId === null) return;
  sourceIncomeByOwner.set(ownerId, (sourceIncomeByOwner.get(ownerId) ?? 0) + revenue);
}

function recordEndpointIncome({
  endpointIncomeByOwner,
  stationOwnerIds,
  stationRelations,
  station,
  sourceOwnerId,
  revenue,
}) {
  if (endpointIncomeByOwner === null || stationOwnerIds === null) return;
  const relation = stationRelations.get(station) ?? "self";
  const endpointOwnerId =
    stationOwnerIds.get(station) ?? (relation === "self" ? sourceOwnerId : station);
  if (endpointOwnerId === sourceOwnerId) return;
  endpointIncomeByOwner.set(
    endpointOwnerId,
    (endpointIncomeByOwner.get(endpointOwnerId) ?? 0) + revenue,
  );
}

function shortestStationPath(adjacency, source, destination) {
  const queue = [[source]];
  const visited = new Set([source]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    const current = path.at(-1);
    if (current === destination) return path;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(path.concat(neighbor));
    }
  }
  return null;
}
