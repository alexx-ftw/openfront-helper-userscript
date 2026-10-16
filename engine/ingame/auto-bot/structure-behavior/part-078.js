      }
      if (railState.length === 0) return true;
      const clusters = this.assignRailClusters(
        stations.concat([{ tile: placementTile }]),
        railState,
      );
      return (
        Array.isArray(clusters) &&
        clusters.length === stations.length + 1 &&
        (clusters.at(-1) === null || clusters.at(-1) === undefined)
      );
    }

    legendaryFactorySeedPathAvoidsRails(paths, railState) {
      if (!this.legendaryFactoryRailStateAvailable(railState)) return false;
      if (railState.length === 0) return true;
      const pathTilesById = new Map();
      paths
        .filter(Array.isArray)
        .forEach((path) =>
          path.forEach((tile) => pathTilesById.set(String(tile), tile)),
        );
      const pathTiles = [...pathTilesById.values()];
      const pathClusters = this.assignRailClusters(
        pathTiles.map((tile) => ({ tile })),
        railState,
      );
      return (
        Array.isArray(pathClusters) &&
        pathClusters.length === pathTiles.length &&
        pathClusters.every((cluster) => cluster === null || cluster === undefined)
      );
    }

    // ghostRailPaths is the client-visible placement-time Factory rail proof.
    async legendaryFactorySeedGhostRailStops(
      candidateTiles,
      stops,
      stationEntries,
      railState,
      config,
    ) {
      const seedStops = Array.isArray(stops) ? stops : [];
      const paidStopTiles = seedStops
        .filter(
          (stop) =>
            stop?.pending !== true &&
            Number(stop?.teamGoldPerSpawn) > 0,
        )
        .map((stop) => String(stop.tile));
      const proven = new Map();
      const tiles = Array.isArray(candidateTiles) ? candidateTiles : [];
      if (tiles.length === 0 || paidStopTiles.length === 0) return proven;
      const results = new Array(tiles.length).fill(null);
      let nextIndex = 0;
      const probe = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= tiles.length) return;
          // Missing quotes cannot prove that a seed route stays isolated.
          const [result] = await Promise.allSettled([
            this.buildableFor(
              UNIT.Factory,
              tiles[index],
              STRUCTURE_PROBE_TIMEOUT_MS,
            ),
          ]);
          results[index] = result.status === "fulfilled" ? result.value : null;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(STRUCTURE_PROBE_CONCURRENCY, tiles.length) },
          () => probe(),
        ),
      );
      for (let index = 0; index < tiles.length; index++) {
        const quote = results[index];
        if (!quote || quote.canBuild !== tiles[index]) continue;
        if (
          !this.legendaryFactorySeedRouteIsolated(
            tiles[index],
            quote.ghostRailPaths,
            stationEntries,
            railState,
            config,
          )
        ) {
          continue;
        }
        const stopTiles = this.legendaryFactorySeedPaidStopEndpoints(
          quote.ghostRailPaths,
          tiles[index],
          paidStopTiles,
        );
        if (stopTiles.size > 0) proven.set(String(tiles[index]), stopTiles);
      }
      return proven;
    }

    legendaryFactorySeedRouteProfiles(inputs, candidateTiles, config, provenStops) {
      const stops = Array.isArray(inputs?.factorySeedStops)
        ? inputs.factorySeedStops
        : [];
      const minRange = Number(config?.trainStationMinRange?.());
      const maxRange = Number(config?.trainStationMaxRange?.());
      if (
        stops.length === 0 ||
        typeof this.game?.euclideanDistSquared !== "function" ||
        !Number.isFinite(minRange) ||
        !Number.isFinite(maxRange) ||
        minRange < 0 ||
        maxRange <= minRange
      ) {
        return [];
      }
      const minRangeSquared = minRange ** 2;
      const maxRangeSquared = maxRange ** 2;
      const averageGold = (pool) =>
        pool.length === 0
          ? 0
          : pool.reduce(
              (total, stop) =>
                total + Math.max(0, Number(stop?.teamGoldPerSpawn) || 0),
              0,
            ) / pool.length;
      return candidateTiles.flatMap((placementTile, index) => {
        const provenStopTiles = provenStops?.get(String(placementTile));
        if (!provenStopTiles) return [];
        const completedStops = stops.filter((stop) => {
          if (stop.pending === true || !provenStopTiles.has(String(stop.tile))) {
            return false;
          }
          const distance = this.game.euclideanDistSquared(placementTile, stop.tile);
          return distance > minRangeSquared && distance <= maxRangeSquared;
        });
        if (completedStops.length === 0) return [];
        const permanentStops = completedStops.filter(
          (stop) =>
            stop.isTeam === true ||
            !Number.isFinite(Number(stop.allianceTicksRemaining)),
        );
        const allianceTicks = [...new Set(
          completedStops
            .map((stop) => Number(stop.allianceTicksRemaining))
            .filter((ticks) => Number.isFinite(ticks) && ticks >= 0),
        )].sort((left, right) => left - right);
        const payoutTimeline = [0, ...allianceTicks].map((atTicks) => {
          const activeAt = (stop) =>
            stop.isTeam === true ||
            !Number.isFinite(Number(stop.allianceTicksRemaining)) ||
            Number(stop.allianceTicksRemaining) > atTicks;
          return {
            atTicks,
            teamGoldPerSpawn: averageGold(
              completedStops.filter(activeAt),
            ),
            teamGoldAfterPendingPerSpawn: averageGold(completedStops.filter(activeAt)),
          };
        });
