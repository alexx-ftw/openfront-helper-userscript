      return entries;
    }

    samCriticalCoverageScoreForEntries(tile, rangeSquared, entries) {
      let score = 0;
      for (const structure of entries) {
        const distanceSquared = this.game.euclideanDistSquared(tile, structure.tile);
        if (distanceSquared > rangeSquared) continue;
        // Weight plus centred closeness keeps the upgrade on the heart of
        // the valuable group, not merely its outer edge.
        score += structure.weight * (2 - distanceSquared / rangeSquared);
      }
      return score;
    }

    samRangeSquared(config, level) {
      {
        const range = Number(config.samRange(level));
        return Number.isFinite(range) && range > 0 ? range * range : 0;
      }
    }

    samCoveredStructureCount(sam, level, structures, config) {
      let samTile;
      {
        samTile = sam.tile();
      }
      const rangeSquared = this.samRangeSquared(config, level);
      return structures.filter((structureTile) => {
        {
          return (
            this.game.euclideanDistSquared(samTile, structureTile) <= rangeSquared
          );
        }
      }).length;
    }

    hydrogenCoveredStructureCount(
      sams,
      structures,
      config,
      upgradedSam = null,
      upgradedLevel = null,
    ) {
      let covered = 0;
      for (const structureTile of structures) {
        const protectedByAny = sams.some((sam) => {
          const level =
            sam === upgradedSam
              ? upgradedLevel
              : sam.level;
          return (
            this.game.euclideanDistSquared(sam.tile, structureTile) <=
            this.samRangeSquared(config, level)
          );
        });
        if (protectedByAny) covered++;
      }
      return covered;
    }

    bestHydrogenCoverageUpgrade(sams, structures, config) {
      const currentCovered = this.hydrogenCoveredStructureCount(
        sams,
        structures,
        config,
      );
      let bestPlan = null;
      for (const sam of sams) {
        const currentLevel = sam.level;
        if (
          !Number.isFinite(currentLevel) ||
          currentLevel >= HYDROGEN_SAM_MAX_UPGRADE_LEVEL
        ) {
          continue;
        }
        for (
          let targetLevel = currentLevel + 1;
          targetLevel <= HYDROGEN_SAM_MAX_UPGRADE_LEVEL;
          targetLevel++
        ) {
          const covered = this.hydrogenCoveredStructureCount(
            sams,
            structures,
            config,
            sam,
            targetLevel,
          );
          if (covered <= currentCovered) continue;
          const candidate = {
            sam: sam.sam,
            currentLevel,
            targetLevel,
            coveredPoints: covered,
            totalPoints: structures.length,
            complete: covered === structures.length,
          };
          if (this.isBetterHydrogenCoveragePlan(candidate, bestPlan)) {
            bestPlan = candidate;
          }
          if (candidate.complete) break;
        }
      }
      return bestPlan;
    }

    isBetterHydrogenCoveragePlan(candidate, current) {
      if (current === null) return true;
      if (candidate.complete !== current.complete) return candidate.complete;
      if (candidate.coveredPoints !== current.coveredPoints) {
        return candidate.coveredPoints > current.coveredPoints;
      }
      return candidate.targetLevel < current.targetLevel;
    }

    legendaryRailMetrics(cities, ports, factories) {
      let reachableStations = [];
      {
        reachableStations = this.getOrBuildReachableStations();
      }

      let connectedCities;
      let connectedPorts;
      {
        const config = this.game.config();
        const minRangeSquared = config.trainStationMinRange() ** 2;
        const maxRangeSquared = config.trainStationMaxRange() ** 2;
        const isConnected = (unit) =>
          typeof unit.hasTrainStation === "function" &&
          unit.hasTrainStation() &&
          this.computeConnectivityScore(
            unit.tile(),
            reachableStations,
            minRangeSquared,
            maxRangeSquared,
          ) > 0;
        connectedCities = cities.filter(isConnected).length;
        connectedPorts = ports.filter(isConnected).length;
      }

      const stationDemand = cities.length + ports.length;
      const railNeed = Math.min(
        2.5,
        Math.max(0.25, (stationDemand + 1) / (factories.length + 1)),
      );
      const connectedStations = connectedCities + connectedPorts;
      let cityRailConnection = 0.25;
      if (factories.length > 0) cityRailConnection = 0.75;
      if (connectedStations > 0) cityRailConnection = 1;
      const tradeNeed = Math.min(
        2.5,
        Math.max(0.25, (reachableStations.length + 1) / (ports.length + 1)),
      );

      return {
        connectedCities,
        cityRailConnection,
        railNeed,
        tradeNeed,
      };
