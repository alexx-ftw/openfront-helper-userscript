      const ownerClusters = Array.isArray(inputs.ownerFactoryClusters) &&
          inputs.ownerFactoryClusters.length > 0
        ? inputs.ownerFactoryClusters
        : [{
          productiveFactoryLevels: upgrade
            ? upgrade.productiveFactoryLevels
            : productiveLevels,
          pendingFactoryLevels: upgrade
            ? upgrade.pendingFactoryLevels
            : ownPendingLevels,
          teamGoldPerSpawn: upgrade ? upgrade.teamGoldPerTrain : goldPerTrain,
          postTeamGoldPerSpawn: upgrade
            ? upgrade.teamGoldPerTrain
            : goldPerTrain,
          teamGoldAfterPendingPerSpawn:
            upgrade?.teamGoldAfterPendingPerTrain ??
              (upgrade ? upgrade.teamGoldPerTrain : goldPerTrain),
          postTeamGoldAfterPendingPerSpawn:
            upgrade?.postTeamGoldAfterPendingPerTrain ??
              (upgrade ? upgrade.teamGoldPerTrain : goldPerTrain),
          factoryConstructionDelayTicks:
            upgrade?.factoryConstructionDelayTicks ??
              inputs.ownPendingFactoryDelayTicks ??
              0,
          pendingStopDelayTicks: upgrade?.pendingStopDelayTicks ?? 0,
          eligibleTicks: Infinity,
          isTarget: true,
        }];
      const beforeDenominator = denominatorFor(ownerFactoryCount);
      const afterDenominator = denominatorFor(ownerFactoryCount + 1);
      if (fleetProjection) {
        const factoryCountReadyAt = candidateFleetSupply?.factoryCountReadyAt ?? Infinity;
        const afterFactoryCountAt = (tick) => ownerFactoryCount +
          Number(tick >= factoryCountReadyAt);
        const beforeRateAt = (level, tick) => projectedTrainRate(
          level,
          ownerFactoryCount,
          fleetProjection.before.trainCounts,
          tick,
        );
        const afterRateAt = (level, tick) => projectedTrainRate(
          level,
          afterFactoryCountAt(tick),
          fleetProjection.after.trainCounts,
          tick,
        );
        const upgradeLevels = upgrade && Array.isArray(upgrade.productiveFactoryLevels)
          ? upgrade.productiveFactoryLevels
          : [];
        const upgradeIndex = upgrade
          ? Math.floor(Number(upgrade.upgradeFactoryIndex))
          : -1;
        if (upgrade && (upgradeIndex < 0 || upgradeIndex >= upgradeLevels.length)) {
          return { refused: true };
        }
        const targetCluster = upgrade
          ? upgrade.clusterId === undefined
            ? ownerClusters.find((cluster) => cluster.isTarget) ?? ownerClusters[0]
            : ownerClusters.find(
                (cluster) => String(cluster.clusterId) === String(upgrade.clusterId),
              )
          : null;
        if (upgrade && !targetCluster) return { refused: true };
        const structureReadyAt = candidateFleetSupply?.factoryCountReadyAt ?? 0;
        const deltaForLevels = (cluster, target, levels, tick) => levels.reduce(
          (sum, level, index) => {
            const beforeLevel = Math.max(1, Number(level) || 1);
            const afterLevel = target && index === upgradeIndex &&
                tick >= actionReadyTicks
              ? beforeLevel + 1
              : beforeLevel;
            return sum + afterRateAt(afterLevel, tick) - beforeRateAt(beforeLevel, tick);
          },
          0,
        );
        incomePerTick = ownerClusters.reduce((total, cluster) => {
          const target = cluster === targetCluster;
          const levels = target
            ? upgradeLevels
            : Array.isArray(cluster.productiveFactoryLevels)
              ? cluster.productiveFactoryLevels
              : [];
          const pending = target
            ? Array.isArray(upgrade.pendingFactoryLevels)
              ? upgrade.pendingFactoryLevels
              : ownPendingLevels
            : Array.isArray(cluster.pendingFactoryLevels)
              ? cluster.pendingFactoryLevels
              : [];
          const completedDelta = (tick) => deltaForLevels(cluster, target, levels, tick);
          const pendingDelta = (tick) => deltaForLevels(cluster, false, pending, tick);
          const pendingStart = Math.max(
            structureReadyAt,
            Math.max(0, Number(
              cluster.factoryConstructionDelayTicks ??
                inputs.ownPendingFactoryDelayTicks ??
                0,
            ) || 0),
          );
          return total +
            factoryGoldForTicks(cluster, completedDelta, structureReadyAt) +
            factoryGoldForTicks(cluster, pendingDelta, pendingStart);
        }, 0);
        if (fleetProjection) {
          incomePerTick += (inputs.otherFactoryStreams ?? []).reduce(
            (total, stream) => {
              const factoryCount = Math.max(
                0,
                Math.floor(Number(stream.factoryCount) || 0),
              );
              const routeReadyAt = Math.max(
                0,
                Number(stream.routeReadyTicks) || 0,
              );
              const deltaForLevels = (levels, readyAt) =>
                (Array.isArray(levels) ? levels : []).reduce(
                  (gold, level) => gold + factoryGoldForTicks(
                    stream,
                    (tick) => projectedTrainRate(
                      level,
                      factoryCount,
                      fleetProjection.after.trainCounts,
                      tick,
                    ) - projectedTrainRate(
                      level,
                      factoryCount,
                      fleetProjection.before.trainCounts,
                      tick,
                    ),
                    Math.max(routeReadyAt, readyAt),
                  ),
                  0,
                );
              return total + deltaForLevels(
                stream.productiveFactoryLevels,
                0,
              ) + deltaForLevels(
                stream.pendingFactoryLevels,
                Math.max(0, Number(stream.factoryConstructionDelayTicks) || 0),
              );
            },
            0,
          );
        }
        if (!upgrade) {
          const factoryRouteProfiles = Array.isArray(inputs.factoryRouteProfiles)
            ? inputs.factoryRouteProfiles
            : [];
          const fallbackProfile = {
            teamGoldPerSpawn: goldPerTrain,
            postTeamGoldPerSpawn: goldPerTrain,
            teamGoldAfterPendingPerSpawn: goldPerTrain,
            postTeamGoldAfterPendingPerSpawn: goldPerTrain,
          };
          let selectedRoute = null;
          for (const profile of factoryRouteProfiles.length > 0
            ? factoryRouteProfiles
            : [fallbackProfile]) {
