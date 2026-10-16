import { makeRailNetwork } from "../../legendary-economy-team-scenario-helpers.mjs";

/** Install artificial map/worker boundaries around real economy selection and dispatch. */
export function productionFixture(h, partnerUnits = {}, options = {}) {
  const { behavior: b, actor, partner } = makeRailNetwork(h, partnerUnits, options);
  const { UNIT, sandbox, liveConfig } = h;
  const controls = {
    cash: 100_000_000n,
    troops: 0,
    tick: 0,
    trains: 0,
    ships: 0,
    tiles: [20],
    afterQuote: () => {},
    ...options.controls,
  };
  const emissions = [];
  const quotes = [];
  const rails = new Uint8Array(1000);
  rails.fill(1, 10, 51);
  rails.fill(1, 700, 751);
  // The map is two disjoint straight rail components. Clustering itself is production BFS.
  Object.assign(b.game, {
    config: () => liveConfig,
    width: () => rails.length,
    height: () => 1,
    railroadState: () => rails,
    neighbors: (tile) => [tile - 1, tile + 1].filter((n) => n >= 0 && n < rails.length),
    ticks: () => controls.tick,
    ticksSinceStart: () => controls.tick,
    units: (type) =>
      Array.from(
        { length: { [UNIT.Train]: controls.trains, [UNIT.TradeShip]: controls.ships }[type] ?? 0 },
        () => ({}),
      ),
  });
  b.initializeStructureCaches();
  partner.type = () => h.LivePlayerType.Human;
  delete b.buildReachableStations;
  delete b.ownedLevels;
  Object.assign(actor, {
    gold: () => controls.cash,
    troops: () => controls.troops,
    nearby: () => [partner],
    numTilesOwned: () => 1000,
    type: () => h.LivePlayerType.Human,
    isLobbyCreator: () => false,
    unitsOwned: (type) => b.ownedLevels(type),
    unitsConstructed: (type) => b.ownedLevels(type),
  });
  const quote = (tile, type, upgrade = false) => {
    const cost = liveConfig.unitInfo(type).cost({}, actor);
    quotes.push({ tile, type, cost, upgrade });
    return {
      type,
      cost,
      canBuild: upgrade ? false : tile,
      canUpgrade: upgrade
        ? actor
            .units(type)
            .find((u) => u.tile() === tile)
            ?.id()
        : false,
    };
  };
  actor.buildables = async (tile, types) => Array.from(types, (type) => quote(tile, type));
  // Military strategy is outside these economy scenarios. No economy candidate,
  // ranking, upgrade discovery, revalidation or dispatch method is replaced.
  Object.assign(b, {
    legendaryConstructionCandidateBlocked: () => false,
    legendaryBigStartSiloCandidateBlocked: () => false,
    shouldReserveEconomicGrowthForOffense: () => false,
    firstSamConstructionReserve: () => 0n,
    firstSiloConstructionReserve: () => 0n,
    legendaryAtomWarChest: () => 0n,
    legendaryThinDensityPressure: () => false,
    tileInsideActiveHostileMissileImpact: () => false,
    hasAnyShoreBorderTile: () => false,
    structureCandidateTiles: () => controls.tiles,
    buildableForUnits: async (units, type) => units.map((u) => quote(u.tile(), type, true)),
    // Placement is an explicit worker boundary; the selected tile is retained.
    structureSpawnTile: async (type, opts) => {
      const tile =
        opts.legendaryEconomyFactoryTile ??
        opts.legendaryEconomyPortTile ??
        opts.legendaryEconomyCityTile ??
        controls.tiles[0];
      const result = quote(tile, type);
      controls.afterQuote();
      return result;
    },
  });
  // Narrow strategic-state seam: economic inputs and the timer horizon remain production.
  b.legendaryConstructionState = () => {
    const horizon = sandbox.legendaryStructureHorizonTicks(b.game, controls.tick, actor);
    return {
      cityCount: actor.units(UNIT.City).length,
      railNeed: 1,
      tradeNeed: 1,
      missileThreat: { score: 0, critical: false },
      samLevelParityGap: 0,
      defenseGap: 0,
      targetPressure: 0,
      siloParityGap: 0,
      siloParityTarget: 0,
      economyHorizonTicks: horizon,
      economyInputs: b.legendaryEconomyInputs({
        trainCount: controls.trains,
        tradeShipCount: controls.ships,
        hasTradePartner: false,
        hasCompletedTradePartner: false,
        connectedStops: 1,
        horizonTicks: horizon,
      }),
    };
  };
  sandbox.state.settings.winFixes = true;
  sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
    emissions.push({
      type: buildable.type,
      tile,
      upgrade: buildable.canUpgrade,
      cost: buildable.cost,
    });
    return true;
  };
  const input = {
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 3,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  };
  return { behavior: b, actor, partner, controls, emissions, quotes, input };
}

/** Generate and rank real candidates, optionally running the real action group. */
export async function productionDecision(fixture, dispatch = true) {
  const { behavior: b, input, emissions } = fixture;
  const candidates = await b.legendaryConstructionCandidates(input);
  const groups = b.legendaryConstructionActionGroups(candidates, true);
  const built = dispatch
    ? await b.runLegendaryConstructionGroups(input.cityCount, candidates, true, false)
    : false;
  return { candidates, groups, selected: groups.flat()[0], built, emissions };
}
