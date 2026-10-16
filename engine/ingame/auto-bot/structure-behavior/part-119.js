            if (n >= 0 && n < total && railState[n] !== 0) {
              if (!railLabel.has(n)) labelFrom(n);
              return railLabel.get(n);
            }
          }
          return null;
        };

        const out = new Array(stationed.length);
        for (let i = 0; i < stationed.length; i++) {
          const id = railIdAt(stationed[i].tile);
          // null cluster = isolated station (no rail) — core treats a singleton
          // station's cluster as effectively its own; using null routes it through
          // computeConnectivityScore's isolatedWeight path (individual weight).
          out[i] = id === null ? null : "rail#" + id;
        }
        return out;
      }
    }

    // computeConnectivityScore — NationStructureBehavior.ts:1133. Reproduced
    // verbatim: per cluster the MAX weight of any in-range station is taken;
    // isolated (null-cluster) stations contribute their individual weights.
    computeConnectivityScore(
      tile,
      reachableStations,
      minRangeSquared,
      stationRangeSquared,
    ) {
      const clustersInRange = new Map();
      let isolatedWeight = 0;
      for (const { tile: stationTile, cluster, weight } of reachableStations) {
        const dist = this.game.euclideanDistSquared(tile, stationTile);
        if (dist < minRangeSquared || dist > stationRangeSquared) continue;
        if (cluster !== null) {
          clustersInRange.set(
            cluster,
            Math.max(clustersInRange.get(cluster) ?? 0, weight),
          );
        } else {
          isolatedWeight += weight;
        }
      }
      let score = isolatedWeight;
      for (const cw of clustersInRange.values()) score += cw;
      return score;
    }

    // cityValue — NationStructureBehavior.ts:1168.
    cityValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = this.economicExposureBorderTiles();
      const otherTiles = new Set(player.units(UNIT.City).map((u) => u.tile()));
      const { borderSpacing, structureSpacing } = this.spacingConstants();
      const nearestBorder = this.nearestTileDistanceScorer(borderTiles);
      const nearestOther = this.nearestTileDistanceScorer(otherTiles);
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      // City placement is an economic decision, not a difficulty-dependent
      // coin flip. Always value the commercial routes the new station can
      // join; the normal placement and safety gates still decide legality.
      const reachableStations = this.getOrBuildReachableStations();
      const railState = this.readRailroadState(game);
      const minRangeSquared = game.config().trainStationMinRange() ** 2;

      // Cross-type spacing: prefer to be away from factories.
      const factoryTiles = new Set(
        player.units(UNIT.Factory).map((u) => u.tile()),
      );
      const nearestFactory = this.nearestTileDistanceScorer(factoryTiles);

      return (tile) => {
        let w = 0;

        w += game.magnitude(tile);

        const closestBorderDist = nearestBorder(tile);
        w += Math.min(closestBorderDist, borderSpacing);

        const closestOtherDist = nearestOther(tile);
        if (Number.isFinite(closestOtherDist)) {
          w += Math.min(closestOtherDist, structureSpacing);
        }

        // Prefer to be away from factories (cross-type spacing)
        const closestFactoryDist = nearestFactory(tile);
        if (Number.isFinite(closestFactoryDist)) {
          w += Math.min(closestFactoryDist, structureSpacing);
        }

        w += this.commercialRailPlacementScore(
          tile,
          reachableStations,
          minRangeSquared,
          stationRangeSquared,
          { structureSpacing, railState },
        );

        return w;
      };
    }

    samCriticalStructureWeight(structure) {
      const type = structure?.type?.();
      const level = Math.max(1, Math.floor(Number(structure?.level?.() ?? 1)));
      if (!type || !Number.isFinite(level)) return 1;
      const cost = this.safeStructureCost(type);
      const costWeight = typeof cost === "bigint"
        ? Number(cost / 250_000n)
        : Math.floor(Number(cost) / 250_000);
      return level * Math.max(1, Math.min(20, Number.isFinite(costWeight) ? costWeight : 1));
    }

    // Mandatory hostile-silo response: protect the highest-value *cluster*,
    // not merely the largest count of cheap buildings. Weighted coverage is
    // dominant; weighted closeness breaks ties toward the cluster's center so
    // the same SAM retains useful coverage as its range rises through level 5.
    threatSamLauncherValue() {
      const game = this.game;
      const player = this.player;
      let structures;
      let existingSams;
      let config;
      let range;
      {
        structures = player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.MissileSilo,
          UNIT.Port,
        );
        existingSams = player.units(UNIT.SAMLauncher);
        config = game.config();
        range = Number(config.defaultSamRange());
      }
      if (!Array.isArray(structures) || !Number.isFinite(range) || range <= 0) {
        return () => 0;
      }

      const rangeSquared = range * range;
      const structureEntries = [];
      for (const structure of structures) {
        if (!structure || typeof structure.tile !== "function") continue;
        {
          const tile = structure.tile();
          if (tile !== null && tile !== undefined) {
            structureEntries.push({
              tile,
              weight: this.samCriticalStructureWeight(structure),
            });
          }
        }
      }
      const totalWeight = structureEntries.reduce((sum, entry) => sum + entry.weight, 0);
      const existingSamProfiles = (existingSams || [])
        .filter((sam) => {
        {
          return !(
            typeof sam.isUnderConstruction === "function" &&
