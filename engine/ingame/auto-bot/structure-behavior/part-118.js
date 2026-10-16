          baseGold = 25000;
      }
      return Math.max(5000, baseGold - visited * 5000);
    }

    // buildReachableStations — NationStructureBehavior.ts:1055.
    // src reads railNetwork().stationManager().getAll() to map each stationed unit
    // to its rail Cluster. We reproduce the SAME entry shape src does
    // ({ tile, cluster (stable cluster-key | null), weight }) and the SAME trade-gold
    // WEIGHTS — via trainGoldBase (the trainGold base SANS the host-cheat multiplier,
    // which cancels in normalization, so the weights are still exact); only HOW clusters
    // are determined differs by environment (see the StationUnionFind header):
    //   - EXTENSION: real rail tiles from game.railroadState() → flood-filled rail
    //     components; each station's cluster is the rail component at/adjacent to
    //     its tile (null when no rail touches it → isolated). EXACT.
    //   - HARNESS: railroadState() null → proximity union-find. APPROXIMATE.
    buildReachableStations(types = [UNIT.City, UNIT.Port, UNIT.Factory], owners) {
      const game = this.game;
      const stationed = this.collectReachableStations(types, owners);

      if (stationed.length === 0) return [];

      const railState = this.readRailroadState(game);
      if (railState) {
        const railComp = this.assignRailClusters(stationed, railState);
        if (railComp !== null) return this.stationClusterEntries(stationed, railComp);
      }
      return this.proximityStationClusters(game, stationed);
    }

    collectReachableStations(types = [UNIT.City, UNIT.Port, UNIT.Factory], owners) {
      const player = this.player;
      const maxTradeGold = Math.max(Number(this.trainGoldBase("ally", 0)), 1);
      const stationed = [];
      const append = (owner) => {
        let relation = "self";
        if (owner !== player) {
          relation = "other";
          if (player.isAlliedWith(owner)) relation = "ally";
          if (player.isOnSameTeam(owner)) relation = "team";
        }
        const weight = Number(this.trainGoldBase(relation, 0)) / maxTradeGold;
        for (const unit of owner.units(...types)) {
          if (unit.isMarkedForDeletion?.() === true || unit.isActive?.() === false) continue;
          if (unit.hasTrainStation()) {
            stationed.push({ tile: unit.tile(), weight, key: unit.id() });
          }
        }
      };
      append(player);
      const networkOwners = Array.isArray(owners)
        ? owners
        : (player.nearby?.() ?? []).filter((owner) =>
            this.isTradeableStationNeighbor(owner),
          );
      for (const owner of networkOwners) {
        if (owner === player || !shimCanTrade(player, owner)) continue;
        append(owner);
      }
      return stationed;
    }

    isTradeableStationNeighbor(neighbor) {
      return (
        neighbor.isPlayer?.() === true &&
        neighbor.type() !== PlayerType.Bot &&
        shimCanTrade(this.player, neighbor)
      );
    }

    readRailroadState(game) {
      {
        return typeof game.railroadState === "function"
          ? game.railroadState()
          : null;
      }
    }

    stationClusterEntries(stationed, clusters) {
      return stationed.map((station, index) => ({
        tile: station.tile,
        cluster: clusters[index],
        weight: station.weight,
      }));
    }

    proximityStationClusters(game, stationed) {
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      const uf = new StationUnionFind();
      for (const s of stationed) uf.add(s.key);
      for (let i = 0; i < stationed.length; i++) {
        for (let j = i + 1; j < stationed.length; j++) {
          const d = game.euclideanDistSquared(stationed[i].tile, stationed[j].tile);
          if (d <= stationRangeSquared) {
            uf.union(stationed[i].key, stationed[j].key);
          }
        }
      }
      return stationed.map((station) => ({
        tile: station.tile,
        cluster: uf.find(station.key),
        weight: station.weight,
      }));
    }

    // assignRailClusters — EXTENSION-only. Flood-fill the REAL rail tiles
    // (railState[tile] !== 0) into connected components, then map each stationed
    // unit to the rail component that touches its tile (the station tile itself or
    // any cardinal/diagonal neighbor — a station's rail may begin one tile away).
    // Returns a parallel array of cluster keys (a "rail#<id>" string per station,
    // or null if no rail touches the station → isolated, matching core's singleton
    // for scoring). Returns null only on an unexpected failure so the caller can
    // fall back to proximity. Bounded: flood-fill visits each rail tile once.
    assignRailClusters(stationed, railState) {
      {
        const game = this.game;
        const width = game.width();
        const height = game.height();
        const total = width * height;
        // Lazily flood-fill only rail components touched by reachable stations.
        // A full-map Int32Array fill here ran on every construction decision and
        // produced visible pauses on large maps even when the railway itself was
        // tiny. Sparse labels keep the same O(visited rail tiles) traversal while
        // removing the O(map tiles) allocation/fill from Auto-build's hot path.
        const railLabel = new Map();
        let nextRailId = 0;

        const labelFrom = (seed) => {
          // seed is a rail tile with no label yet; BFS its component.
          const id = nextRailId++;
          const queue = [seed];
          railLabel.set(seed, id);
          let head = 0;
          while (head < queue.length) {
            const cur = queue[head++];
            for (const n of game.neighbors(cur)) {
              if (
                n >= 0 &&
                n < total &&
                railState[n] !== 0 &&
                !railLabel.has(n)
              ) {
                railLabel.set(n, id);
                queue.push(n);
              }
            }
          }
          return id;
        };

        // Resolve the rail component id touching a station tile: the tile itself
        // if it is a rail tile, else any neighbor that is a rail tile.
        const railIdAt = (tile) => {
          if (tile < 0 || tile >= total) return null;
          if (railState[tile] !== 0) {
            if (!railLabel.has(tile)) labelFrom(tile);
            return railLabel.get(tile);
          }
          for (const n of game.neighbors(tile)) {
