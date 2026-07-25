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
