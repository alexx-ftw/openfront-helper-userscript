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
  // Config.trainGold("self", citiesVisited): the first ten paying stops have
  // no distance penalty, then each additional stop costs 5k down to 5k.
  goldForTradeStop = (stopIndex) => Math.max(5_000, 10_000 - Math.max(0, stopIndex - 9) * 5_000),
}) {
  const types = new Map(stationTypes);
  if (candidateId !== null && candidateId !== undefined) types.set(candidateId, "City");
  const revenueByStation = new Map();
  let totalRevenue = 0;
  for (const factory of factoryIds) {
    for (const destination of destinationIds) {
      const path = shortestStationPath(adjacency, factory, destination);
      if (path === null) continue;
      let tradeStopsVisited = 0;
      for (const station of path.slice(1)) {
        const type = types.get(station);
        if (type !== "City" && type !== "Port") continue;
        const revenue = goldForTradeStop(tradeStopsVisited);
        totalRevenue += revenue;
        revenueByStation.set(station, (revenueByStation.get(station) ?? 0) + revenue);
        tradeStopsVisited += 1;
      }
    }
  }
  return { totalRevenue, revenueByStation };
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
