        const profile = {
          clusterId: `seed#${index}`,
          factorySourceCount: 0,
          paidStops: completedStops.length,
          teamGoldPerSpawn: averageGold(completedStops),
          postTeamGoldPerSpawn: averageGold(
            completedStops.filter((stop) => permanentStops.includes(stop)),
          ),
          teamGoldAfterPendingPerSpawn: averageGold(completedStops),
          postTeamGoldAfterPendingPerSpawn: averageGold(permanentStops),
          payoutTimeline,
          pendingStopDelayTicks: 0,
          eligibleTicks: Infinity,
          placementTile,
          factorySeedStopTiles: completedStops.map((stop) => stop.tile),
          factorySeedStops: completedStops.map((stop) => ({
            tile: stop.tile,
            teamGoldPerSpawn: stop.teamGoldPerSpawn,
          })),
        };
        const payoutPotential = payoutTimeline.reduce(
          (best, point) => Math.max(
            best,
            point.teamGoldPerSpawn,
            point.teamGoldAfterPendingPerSpawn,
          ),
          0,
        );
        return payoutPotential > 0 ? [profile] : [];
      });
    }

    async legendaryFactorySeedCandidateProfiles({
      inputs,
      candidateTiles,
      stationEntries,
      candidateClusters,
      railState,
      config,
    }) {
      let seedCandidateTiles = candidateTiles;
      if (stationEntries.length > 0) {
        if (candidateClusters === null) return [];
        const maxRange = Math.max(
          0,
          Number(config?.trainStationMaxRange?.()) || 0,
        );
        const maxRangeSquared = maxRange * maxRange;
        seedCandidateTiles = candidateTiles.filter((tile, index) =>
          (candidateClusters[stationEntries.length + index] === null ||
            candidateClusters[stationEntries.length + index] === undefined) &&
          stationEntries.every(
            (entry) =>
              this.game.euclideanDistSquared(tile, entry.tile) > maxRangeSquared,
          ),
        );
      }
      const provenStops = await this.legendaryFactorySeedGhostRailStops(
        seedCandidateTiles,
        inputs.factorySeedStops,
        stationEntries,
        railState,
        config,
      );
      return this.legendaryFactorySeedRouteProfiles(
        inputs,
        seedCandidateTiles.filter((tile) => provenStops.has(String(tile))),
        config,
        provenStops,
      );
    }

    async addLegendaryFactoryRouteCandidates(context) {
      const inputs = context.strategicState?.economyInputs;
      if (!inputs) return;
      const profiles = Array.isArray(inputs.factoryRouteProfiles)
        ? inputs.factoryRouteProfiles
        : [];
      const stationEntries = Array.isArray(inputs.factoryStationEntries)
        ? inputs.factoryStationEntries
        : [];
      const railState = inputs.factoryRailState;
      const routeProfiles = profiles.filter((profile) =>
        typeof profile?.clusterId === "string" &&
        profile.clusterId.startsWith("rail#") &&
        Number.isFinite(Number(profile.factorySourceCount)) &&
        Number(profile.factorySourceCount) === 0 &&
        Number(profile.paidStops) > 0,
      );
      let candidateProfiles = [];
      const seedStops = Array.isArray(inputs.factorySeedStops)
        ? inputs.factorySeedStops
        : [];
      const hasSeedStops = seedStops.some(
        (stop) =>
          stop?.pending !== true &&
          Number(stop?.teamGoldPerSpawn) > 0,
      );
      const canMapRailRoutes =
        stationEntries.length > 0 &&
        this.legendaryFactoryRailStateAvailable(railState) &&
        railState.length > 0;
      const candidateTiles =
        (routeProfiles.length > 0 && canMapRailRoutes) || hasSeedStops
          ? this.structureCandidateTiles(
              UNIT.Factory,
              {},
              ECONOMIC_INITIAL_PLACEMENT_CANDIDATE_LIMIT,
            )
          : [];
      let candidateClusters = null;
      if (canMapRailRoutes && candidateTiles.length > 0) {
        const clusters = this.assignRailClusters(
          stationEntries.concat(candidateTiles.map((tile) => ({ tile }))),
          railState,
        );
        if (
          Array.isArray(clusters) &&
          clusters.length === stationEntries.length + candidateTiles.length
        ) {
          candidateClusters = clusters;
        }
      }
      if (routeProfiles.length > 0 && candidateClusters !== null) {
        // Reuse exact live rail components to attach an existing paid-stop route.
        const tileByCluster = new Map();
        for (let index = 0; index < candidateTiles.length; index++) {
          const cluster = candidateClusters[stationEntries.length + index];
          if (cluster === null || cluster === undefined) continue;
          const key = String(cluster);
          if (!tileByCluster.has(key)) tileByCluster.set(key, candidateTiles[index]);
        }
        candidateProfiles = routeProfiles.flatMap((profile) => {
          const placementTile = tileByCluster.get(profile.clusterId);
          return placementTile === undefined
            ? []
            : [{ ...profile, placementTile }];
        });
      }
      if (hasSeedStops && candidateTiles.length > 0) {
        candidateProfiles.push(...await this.legendaryFactorySeedCandidateProfiles(
          {
            inputs,
            candidateTiles,
            stationEntries,
            candidateClusters,
            railState,
            config: context.config,
          },
        ));
      }
      if (candidateProfiles.length === 0) return;

      const cost = context.economyCostQuotes?.get(UNIT.Factory) ??
        this.cost(UNIT.Factory);
      const factoryPaidStops = Math.max(
        0,
        ...candidateProfiles.map((profile) => Number(profile.paidStops) || 0),
      );
      const factoryTeamGoldPerTrain = candidateProfiles.reduce(
