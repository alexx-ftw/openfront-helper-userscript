            const routeGold = factoryGoldForTicks(
              profile,
              (tick) => afterRateAt(1, tick),
              actionReadyTicks,
            );
            if (selectedRoute === null || routeGold > selectedRoute.gold) {
              selectedRoute = { profile, gold: routeGold };
            }
          }
          incomePerTick += selectedRoute?.gold ?? 0;
          factoryPlacementTile = selectedRoute?.profile?.placementTile;
        }
        incomePerTick /= productiveTicks;
      } else if (upgrade) {
        const levels = Array.isArray(upgrade.productiveFactoryLevels)
          ? upgrade.productiveFactoryLevels
          : [];
        const pendingLevels = Array.isArray(upgrade.pendingFactoryLevels)
          ? upgrade.pendingFactoryLevels
          : ownPendingLevels;
        const targetIndex = Math.floor(Number(upgrade.upgradeFactoryIndex));
        if (targetIndex < 0 || targetIndex >= levels.length) return { refused: true };
        const upgradeReadyTicks = actionReadyTicks;
        const targetCluster = upgrade.clusterId === undefined
          ? ownerClusters.find((cluster) => cluster.isTarget) ?? ownerClusters[0]
          : ownerClusters.find(
              (cluster) => String(cluster.clusterId) === String(upgrade.clusterId),
            );
        if (!targetCluster) return { refused: true };
        incomePerTick = ownerClusters.reduce((total, cluster) => {
          const isTarget = cluster === targetCluster;
          const clusterLevels = isTarget
            ? levels
            : Array.isArray(cluster.productiveFactoryLevels)
              ? cluster.productiveFactoryLevels
              : [];
          const clusterPending = isTarget
            ? pendingLevels
            : Array.isArray(cluster.pendingFactoryLevels)
              ? cluster.pendingFactoryLevels
              : [];
          const completedDelta = clusterLevels.reduce(
            (sum, level, index) =>
              sum + legendaryExpectedTrainRatePerTick(
                level + (isTarget && index === targetIndex ? 1 : 0),
                afterDenominator,
              ) - legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const pendingDelta = clusterPending.reduce(
            (sum, level) =>
              sum + legendaryExpectedTrainRatePerTick(level, afterDenominator) -
                legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const rollGold = isTarget
            ? legendaryExpectedTrainRatePerTick(
                Number(levels[targetIndex] ?? 1) + 1,
                afterDenominator,
              ) -
                legendaryExpectedTrainRatePerTick(
                  Number(levels[targetIndex] ?? 1),
                  afterDenominator,
                )
            : 0;
          const pendingStart = Math.max(
            0,
            Number(
              cluster.factoryConstructionDelayTicks ??
                inputs.ownPendingFactoryDelayTicks ??
                0,
            ) || 0,
          );
          return total +
            factoryGoldForTicks(cluster, completedDelta - rollGold) +
            factoryGoldForTicks(cluster, rollGold, upgradeReadyTicks) +
            factoryGoldForTicks(cluster, pendingDelta, pendingStart);
        }, 0) / productiveTicks;
      } else {
        const newFactoryRate = legendaryExpectedTrainRatePerTick(1, afterDenominator);
        const existingFactoryGold = ownerClusters.reduce((total, cluster) => {
          const clusterLevels = Array.isArray(cluster.productiveFactoryLevels)
            ? cluster.productiveFactoryLevels
            : [];
          const clusterPending = Array.isArray(cluster.pendingFactoryLevels)
            ? cluster.pendingFactoryLevels
            : [];
          const completedDelta = clusterLevels.reduce(
            (sum, level) =>
              sum + legendaryExpectedTrainRatePerTick(level, afterDenominator) -
                legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const pendingDelta = clusterPending.reduce(
            (sum, level) =>
              sum + legendaryExpectedTrainRatePerTick(level, afterDenominator) -
                legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const pendingStart = Math.max(
            0,
            Number(
              cluster.factoryConstructionDelayTicks ??
                inputs.ownPendingFactoryDelayTicks ??
                0,
            ) || 0,
          );
          return total +
            factoryGoldForTicks(cluster, completedDelta) +
            factoryGoldForTicks(cluster, pendingDelta, pendingStart);
        }, 0);
        const factoryRouteProfiles = Array.isArray(inputs.factoryRouteProfiles)
          ? inputs.factoryRouteProfiles
          : [];
        let newFactoryGold;
        if (factoryRouteProfiles.length > 0) {
          let selectedRoute = null;
          for (const profile of factoryRouteProfiles) {
            const routeGold = factoryGoldForTicks(
              profile,
              newFactoryRate,
              actionReadyTicks,
            );
            if (selectedRoute === null || routeGold > selectedRoute.gold) {
              selectedRoute = { profile, gold: routeGold };
            }
          }
          newFactoryGold = selectedRoute?.gold ?? 0;
          factoryPlacementTile = selectedRoute?.profile?.placementTile;
        } else {
          newFactoryGold = newFactoryRate * goldPerTrain * productiveTicks;
        }
        incomePerTick = (existingFactoryGold + newFactoryGold) / productiveTicks;
      }
    } else {
      if (sources.length === 0) return { refused: true };
        // TrainStationExecution samples the destination uniformly from the
        // cluster's tradeable stops, so a City's marginal value is the change
        // in total team payout (new share minus displaced shares), not the
        // new stop's share alone.
        incomePerTick = sources.reduce((total, source) => {
        const levels = Array.isArray(source.productiveFactoryLevels)
          ? source.productiveFactoryLevels
          : [];
        const pendingLevels = Array.isArray(source.pendingFactoryLevels)
          ? source.pendingFactoryLevels
          : [];
        const factoryCount = Math.max(
          0,
          Math.floor(Number(source.factoryCount ?? 0)),
        );
        if (fleetProjection) {
          const stopShare = (value) => {
            const destinations = Math.max(
              1,
              Math.floor(Number(source.paidStopsAfterBuild ?? 1)),
            );
            return Math.max(0, Number(value) || 0) * (destinations - 1) / destinations;
          };
