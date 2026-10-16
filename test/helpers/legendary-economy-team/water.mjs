import { productionFixture } from "./production.mjs";

/** Supply two separate artificial water corridors; route BFS and seed policy stay real. */
export function waterFixture(h, partnerUnits = {}, options = {}) {
  const f = productionFixture(h, partnerUnits, options);
  const { behavior: b, actor, partner, controls, input } = f;
  // First corridor is ocean (-1); the second is a separate shared lake (2).
  const coast = new Map([
    [10, 1000],
    [20, 1100],
    [12, 1400],
    [22, 1900],
  ]);
  const component = (node) => (node < 1300 ? -1 : 2);
  controls.water = new Set([-1, 2]);
  controls.tiles = [10];
  Object.assign(b.game, {
    width: () => 2000,
    height: () => 1,
    railroadState: () => new Uint8Array(2000),
    sharedWaterComponents: () => controls.water,
    isWater: (tile) => tile >= 1000 && tile < 2000,
    isOcean: (tile) => tile >= 1000 && tile < 1300,
    getWaterComponent: (tile) => component(tile),
    manhattanDist: (a, z) => Math.abs(coast.get(a) - coast.get(z)),
    neighbors: (tile) =>
      coast.has(tile)
        ? [coast.get(tile)]
        : [tile - 1, tile + 1].filter(
            (n) => n >= 1000 && n < 2000 && component(n) === component(tile),
          ),
  });
  b.game.forEachNeighbor = (tile, visit) => b.game.neighbors(tile).forEach(visit);
  for (const [owner, tile] of [
    [actor, 10],
    [partner, 20],
  ]) {
    owner.oceanShoreBorderTiles = () => [tile];
    owner.borderTiles = () => new Set([tile]);
    owner.isFriendly = (other) => owner.isOnSameTeam(other);
    owner.__src.isLobbyCreator = () => false;
  }
  partner.buildables = async (_tile, types) =>
    Array.from(types, (type) => ({
      type,
      cost: BigInt(h.liveCostOf(type)),
      canBuild: 20,
      canUpgrade: false,
    }));
  // Only shoreline enumeration/open-water placement is artificial.
  Object.assign(b, {
    oceanPortBorderTiles: () => controls.tiles,
    isShoreBorderTile: (tile) => coast.has(tile),
    portTileHasOpenWaterAccess: (tile) => coast.has(tile),
    hasAnyShoreBorderTile: () => true,
  });
  delete b.portWaterComponents;
  delete b.legendaryPortSeedWindowOpen;
  delete b.legendaryPortCandidateTilesForEconomy;
  const state = b.legendaryConstructionState;
  b.legendaryConstructionState = () => {
    const snapshot = state();
    snapshot.economyInputs = b.legendaryEconomyInputs({
      trainCount: controls.trains,
      tradeShipCount: controls.ships,
      hasTradePartner: b.hasTradeablePortOnSharedWater(),
      hasCompletedTradePartner: b.hasTradeablePortOnSharedWater({ includeInProgress: false }),
      connectedStops: 0,
      horizonTicks: snapshot.economyHorizonTicks,
    });
    return snapshot;
  };
  input.hasCoastalTiles = true;
  input.hasOceanPortTiles = true;
  return f;
}
