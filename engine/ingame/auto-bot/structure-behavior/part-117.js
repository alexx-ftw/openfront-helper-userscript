      const x = Number(this.game.x(tile));
      const y = Number(this.game.y(tile));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      let nearestSquared = Infinity;
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > 9 || distanceSquared >= nearestSquared) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.game.isValidCoord(nx, ny)) continue;
          const railTile = this.game.ref(nx, ny);
          if (railState[railTile] !== 0) nearestSquared = distanceSquared;
        }
      }
      return Number.isFinite(nearestSquared) ? Math.sqrt(nearestSquared) : null;
    }

    // shouldUseConnectivityScore — NationStructureBehavior.ts:1018.
    shouldUseConnectivityScore(difficulty) {
      let randomChance;
      switch (difficulty) {
        case Difficulty.Easy:
          randomChance = 0;
          break;
        case Difficulty.Medium:
          randomChance = 60;
          break;
        case Difficulty.Hard:
          randomChance = 75;
          break;
        case Difficulty.Impossible:
          randomChance = 100;
          break;
        case Difficulty.Legendary:
          randomChance = 100;
          break;
        default:
          randomChance = 100;
      }

      return this.random.nextInt(0, 100) < randomChance;
    }

    // getOrBuildReachableStations — NationStructureBehavior.ts:1040.
    getOrBuildReachableStations() {
      if (this.reachableStationsCache === null) {
        this.reachableStationsCache = this.buildReachableStations();
      }
      return this.reachableStationsCache;
    }

    // A Factory supplies trains; only a City or Port can be the paying end of
    // that train. Keep other factories in the spacing penalty, but never let a
    // nearby factory masquerade as a new commercial destination.
    getOrBuildFactoryTradeDestinations() {
      if (this.factoryTradeDestinationsCache === null) {
        const destinations = this.collectFactoryTradeDestinations();
        this.factoryTradeDestinationsCache = this.proximityStationClusters(
          this.game,
          destinations,
        );
      }
      return this.factoryTradeDestinationsCache;
    }

    collectFactoryTradeDestinations() {
      const player = this.player;
      if (typeof player?.units !== "function") return [];
      const maxTradeGold = Math.max(Number(this.trainGoldBase("ally", 0)), 1);
      const destinations = [];
      const append = (owner, weight) => {
        for (const unit of owner.units(UNIT.City, UNIT.Port)) {
          destinations.push({ tile: unit.tile(), weight, key: unit.id() });
        }
      };
      append(player, Number(this.trainGoldBase("self", 0)) / maxTradeGold);
      for (const neighbor of player.nearby()) {
        if (!this.isTradeableStationNeighbor(neighbor)) continue;
        let relation = "other";
        if (player.isAlliedWith(neighbor)) relation = "ally";
        if (player.isOnSameTeam(neighbor)) relation = "team";
        append(neighbor, Number(this.trainGoldBase(relation, 0)) / maxTradeGold);
      }
      return destinations;
    }

    novelFactoryTradeCandidates(candidates) {
      if (typeof this.player?.units !== "function") return [];
      const destinations = this.getOrBuildFactoryTradeDestinations();
      if (destinations.length === 0) return [];
      const minRangeSquared = this.game.config().trainStationMinRange() ** 2;
      const stationRangeSquared = this.game.config().trainStationMaxRange() ** 2;
      const reachesPaidStop = (tile, destination) => {
        const distance = this.game.euclideanDistSquared(tile, destination.tile);
        return distance > minRangeSquared && distance <= stationRangeSquared;
      };
      const reachableCandidates = candidates.filter(({ t }) =>
        destinations.some((destination) => reachesPaidStop(t, destination)),
      );
      if (reachableCandidates.length === 0) return [];
      const factories = this.player.units(UNIT.Factory);
      if (factories.length === 0) return reachableCandidates;
      return reachableCandidates.filter(({ t }) =>
        destinations.some(({ tile }) => {
          if (!reachesPaidStop(t, { tile })) return false;
          return !factories.some((factory) =>
            reachesPaidStop(factory.tile(), { tile }),
          );
        }),
      );
    }

    onlyDuplicateFactoryTradeCandidates(candidates) {
      if (candidates.length === 0 || typeof this.player?.units !== "function") {
        return false;
      }
      const destinations = this.getOrBuildFactoryTradeDestinations();
      const factories = this.player.units(UNIT.Factory);
      return (
        destinations.length > 0 &&
        factories.length > 0 &&
        this.novelFactoryTradeCandidates(candidates).length === 0
      );
    }

    // trainGoldBase — the game's Config.trainGold value WITHOUT its final
    // goldMultiplierFor(player) factor. We deliberately drop that factor:
    //   1) it is IDENTICAL for every relation, so it CANCELS OUT in the normalized
    //      station weights below (everything is divided by the "ally" gold), and
    //   2) on hosts that enable the `goldMultiplier` host-cheat (common on private /
    //      self-hosted servers), the game's goldMultiplierFor() calls
    //      player.isLobbyCreator() — which our wrapped player object does NOT expose →
    //      a TypeError that was crashing the ENTIRE bot tick. Replicating the base here
    //      avoids passing our player into the game's gold path at all.
    //   Mirrors Config.ts:trainGold exactly: baseGold by relation, −5k per city past
    //   the first 10, floored at 5k.
    trainGoldBase(rel, citiesVisited) {
      const config = this.game?.config?.();
      const player = this.player?.__src ?? this.player;
      if (
        typeof config?.trainGold === "function" &&
        typeof player?.isLobbyCreator === "function"
      ) {
        return Number(config.trainGold(rel, citiesVisited, player));
      }

      const visited = Math.max(0, (citiesVisited || 0) - 9);
      let baseGold;
      switch (rel) {
        case "ally":
          baseGold = 35000;
          break;
        case "self":
          baseGold = 10000;
          break;
        case "team":
        case "other":
        default:
