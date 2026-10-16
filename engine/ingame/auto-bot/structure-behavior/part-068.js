        portOwners,
        initialTradeShipRemainingTicks,
      };
      const ownPortUnits = this.player?.units?.(UNIT.Port) ?? [];
      const ownCityUnits = this.player?.units?.(UNIT.City) ?? [];
      const ownPorts = ownPortUnits.reduce(
        (total, port) => this.portIsUsable(port)
          ? total + (port?.isUnderConstruction?.() === true
            ? 1
            : Math.max(1, Math.floor(Number(port?.level?.() ?? 1))))
          : total,
        0,
      );
      const factorySeedStops = this.legendaryFactorySeedStops(ownerContext);

      const clusterEntries = this.buildReachableStations(
        [UNIT.City, UNIT.Port, UNIT.Factory],
        owners,
      ) ?? [];
      const clusterByTile = new Map(
        clusterEntries.map((entry) => [String(entry.tile), entry.cluster]),
      );
      const stationByTile = new Map();
      const clusterData = new Map();
      const clusterFor = (tile) => {
        const cluster = clusterByTile.get(String(tile));
        return cluster === null || cluster === undefined
          ? "isolated:" + String(tile)
          : String(cluster);
      };
      for (const owner of owners) {
        for (const type of [UNIT.Factory, UNIT.City, UNIT.Port]) {
          for (const unit of owner?.units?.(type) ?? []) {
            const tile = unit?.tile?.();
            if (tile !== null && tile !== undefined) {
              stationByTile.set(String(tile), { owner, type, unit });
            }
          }
        }
      }
      for (const entry of clusterEntries) {
        const station = stationByTile.get(String(entry.tile));
        if (!station) continue;
        const cluster = clusterFor(entry.tile);
        let data = clusterData.get(cluster);
        if (!data) {
          data = { factories: new Map(), destinations: [] };
          clusterData.set(cluster, data);
        }
        const { owner, type, unit } = station;
        if (type === UNIT.Factory) {
          let source = data.factories.get(idOf(owner));
          if (!source) {
            source = {
              owner,
              factoryCount: levelSum(owner?.units?.(UNIT.Factory)),
              productiveFactoryLevels: [],
              productiveFactoryUnits: [],
              pendingFactoryLevels: [],
              factoryConstructionDelayTicks: Number(
                config?.unitInfo?.(UNIT.Factory)?.constructionDuration ?? 0,
              ),
            };
            data.factories.set(idOf(owner), source);
          }
          if (unit?.isUnderConstruction?.() === true) {
            source.pendingFactoryLevels.push(levelOf(unit));
          } else {
            source.productiveFactoryLevels.push(levelOf(unit));
            source.productiveFactoryUnits.push(unit);
          }
        } else {
          data.destinations.push({ owner, type, unit });
        }
      }
      const stationRangeSquared =
        Number(config?.trainStationMaxRange?.() ?? 0) ** 2;
      const pendingFactories = owners.flatMap((owner) =>
        (owner?.units?.(UNIT.Factory) ?? [])
          .filter((unit) => unit?.isUnderConstruction?.() === true)
          .map((unit) => ({ owner, unit, tile: unit?.tile?.() }))
          .filter(({ tile }) => tile !== null && tile !== undefined),
      );
      const railState = this.readRailroadState(this.game);
      const pendingFactoryClusters = railState
        ? this.assignRailClusters(
            pendingFactories.map(({ tile }) => ({ tile })),
            railState,
          )
        : null;
      for (let index = 0; index < pendingFactories.length; index++) {
        const { owner, unit, tile } = pendingFactories[index];
        if (clusterByTile.has(String(tile))) continue;
        let cluster = pendingFactoryClusters?.[index] ?? null;
        if (cluster !== null) cluster = String(cluster);
        if (cluster === null) {
          let nearest = null;
          let nearestDistance = Infinity;
          for (const entry of clusterEntries) {
            const distance = this.game.euclideanDistSquared(tile, entry.tile);
            if (distance > stationRangeSquared || distance >= nearestDistance) continue;
            nearest = clusterFor(entry.tile);
            nearestDistance = distance;
          }
          cluster = nearest;
        }
        const data = cluster === null ? null : clusterData.get(cluster);
        if (!data) continue;
        let source = data.factories.get(idOf(owner));
        if (!source) {
          source = {
            owner,
            factoryCount: levelSum(owner?.units?.(UNIT.Factory)),
            productiveFactoryLevels: [],
            productiveFactoryUnits: [],
            pendingFactoryLevels: [],
            factoryConstructionDelayTicks: Number(
              config?.unitInfo?.(UNIT.Factory)?.constructionDuration ?? 0,
            ),
          };
          data.factories.set(idOf(owner), source);
        }
        source.pendingFactoryLevels.push(levelOf(unit));
      }
      // Include pending City/Port supply when it lies within station range of
      // a completed Factory station; it is not yet treated as a paying stop.
      const factoryStations = clusterEntries.filter(
        (entry) => stationByTile.get(String(entry.tile))?.type === UNIT.Factory,
      );
      for (const owner of owners) {
        for (const type of [UNIT.City, UNIT.Port]) {
          for (const unit of owner?.units?.(type) ?? []) {
            if (unit?.isUnderConstruction?.() !== true) continue;
            if (unit?.hasTrainStation?.() === true) continue;
            const tile = unit?.tile?.();
            if (tile === null || tile === undefined || stationRangeSquared <= 0) continue;
            let nearest = null;
            let distanceSquared = Infinity;
            for (const entry of factoryStations) {
              const distance = this.game.euclideanDistSquared(tile, entry.tile);
              if (distance > stationRangeSquared || distance >= distanceSquared) continue;
              nearest = clusterFor(entry.tile);
              distanceSquared = distance;
            }
            const data = nearest ? clusterData.get(nearest) : null;
            if (data) data.destinations.push({ owner, type, unit, pending: true });
          }
        }
      }

      let bestTrainSources = [];
      let bestTrainValue = 0;
      let bestFactoryGold = 0;
      let bestPaidStops = 0;
      let bestOwnProductiveLevels = [];
      let bestOwnPendingLevels = [];
      let bestOwnPendingDelayTicks = 0;
      let bestRouteDelayTicks = 0;
      let bestPendingStopDelayTicks = 0;
      const ownFactoryClusterEntries = [];
