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
  candidate = null,
  goldForTradeStop = defaultGoldForTradeStop,
}) {
  const types = new Map(stationTypes);
  const owners = new Map(stationOwners);
  const levels = new Map(factoryLevels);
  if (candidate) {
    types.set(candidate.id, candidate.type);
    owners.set(candidate.id, candidate.owner ?? "self");
    if (candidate.type === "Factory") levels.set(candidate.id, candidate.level ?? 1);
  }

  const revenueByStation = new Map();
  let totalIncomePerTick = 0;
  let totalSpawnProbability = 0;
  const factoryCount = Array.from(types.values()).filter((type) => type === "Factory").length;
  const spawnRate = (factoryCount + 10) * 15;

  for (const [factory, level] of levels) {
    if (types.get(factory) !== "Factory" || level <= 0) continue;
    const reachable = reachableStations(adjacency, factory);
    const destinations = Array.from(reachable).filter((station) => {
      const type = types.get(station);
      return station !== factory && (type === "City" || type === "Port");
    });
    if (destinations.length === 0) continue;

    const attemptProbability = 1 - (1 - 1 / spawnRate) ** level;
    const spawnProbability = attemptProbability / (1 + 9 * attemptProbability);
    totalSpawnProbability += spawnProbability;
    const destinationProbability = spawnProbability / destinations.length;
    for (const destination of destinations) {
      const path = shortestStationPath(adjacency, factory, destination);
      if (path === null) continue;
      const routeRevenue = collectRouteTransitRevenue(path, types, goldForTradeStop, {
        stationRelations: owners,
        revenueByStation,
        routeProbability: destinationProbability,
      });
      totalIncomePerTick += routeRevenue;
    }
  }
  return { totalIncomePerTick, totalSpawnProbability, revenueByStation };
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
  { stationRelations, revenueByStation, routeProbability = 1 },
) {
  let totalRevenue = 0;
  let tradeStopsVisited = 0;
  for (const station of path.slice(1)) {
    const type = stationTypes.get(station);
    if (type !== "City" && type !== "Port") continue;
    const revenue =
      goldForTradeStop(tradeStopsVisited, stationRelations.get(station) ?? "self") *
      routeProbability;
    totalRevenue += revenue;
    revenueByStation.set(station, (revenueByStation.get(station) ?? 0) + revenue);
    tradeStopsVisited += 1;
  }
  return totalRevenue;
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
