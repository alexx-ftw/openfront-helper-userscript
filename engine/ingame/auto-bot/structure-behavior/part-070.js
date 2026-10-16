            factoryCount: source.factoryCount,
            productiveFactoryLevels: source.productiveFactoryLevels,
            pendingFactoryLevels: source.pendingFactoryLevels,
            factoryConstructionDelayTicks: source.factoryConstructionDelayTicks,
            routeReadyTicks: source.routeReadyTicks,
            pendingStopDelayTicks: source.pendingStopDelayTicks,
            teamGoldPerSpawn: source.beforeTeamGoldPerSpawn,
            postTeamGoldPerSpawn: source.beforePostAllianceTeamGoldPerSpawn,
            teamGoldAfterPendingPerSpawn:
              source.beforeTeamGoldAfterPendingPerSpawn,
            postTeamGoldAfterPendingPerSpawn:
              source.beforePostAllianceTeamGoldAfterPendingPerSpawn,
            payoutTimeline: source.payoutTimeline.map((point) => ({
              atTicks: point.atTicks,
              teamGoldPerSpawn: point.beforeTeamGoldPerSpawn,
              teamGoldAfterPendingPerSpawn:
                point.beforeTeamGoldAfterPendingPerSpawn,
            })),
          });
        }
        if (sources.length > 0) {
          cityRouteProfiles.push({ clusterId: cluster, trainSources: sources });
        }
        if (data.factories.has(idOf(ownPlayer))) {
          const ownSource = data.factories.get(idOf(ownPlayer));
          ownFactoryClusterEntries.push({
            clusterId: cluster,
            productiveFactoryLevels: ownSource.productiveFactoryLevels,
            pendingFactoryLevels: ownSource.pendingFactoryLevels,
            factoryConstructionDelayTicks: ownSource.factoryConstructionDelayTicks,
            pendingStopDelayTicks,
            teamGoldPerSpawn: poolMean(ownPlayer, false, false),
            postTeamGoldPerSpawn: poolMean(ownPlayer, false, true),
            teamGoldAfterPendingPerSpawn:
              poolMean(ownPlayer, false, false, true),
            postTeamGoldAfterPendingPerSpawn:
              poolMean(ownPlayer, false, true, true),
            payoutTimeline: sourcePayoutTimeline(ownPlayer).map((point) => ({
              atTicks: point.atTicks,
              teamGoldPerSpawn: point.beforeTeamGoldPerSpawn,
              teamGoldAfterPendingPerSpawn:
                point.beforeTeamGoldAfterPendingPerSpawn,
            })),
            eligibleTicks: eligibleTicksFor(ownPlayer, futureDestinations),
            isTarget: false,
          });
        }
        const estimate = sources.reduce((total, source) => {
          const denominator = Math.max(
            1,
            Number(config?.trainSpawnRate?.(source.factoryCount, globalTrainCount) ?? 1),
          );
          const spawns = source.productiveFactoryLevels.reduce(
            (sum, level) => sum + legendaryExpectedTrainRatePerTick(level, denominator),
            0,
          ) + source.pendingFactoryLevels.reduce(
            (sum, level) => sum + legendaryExpectedTrainRatePerTick(level, denominator),
            0,
          );
          return total + spawns * source.teamGoldPerStop;
        }, 0);
        if (estimate > bestTrainValue) {
          bestTrainValue = estimate;
          bestTrainSources = sources;
          for (const entry of ownFactoryClusterEntries) entry.isTarget = false;
          const targetCluster = ownFactoryClusterEntries.find(
            (entry) => entry.clusterId === cluster,
          );
          if (targetCluster) targetCluster.isTarget = true;
          bestOwnProductiveLevels =
            data.factories.get(idOf(ownPlayer))?.productiveFactoryLevels ?? [];
          const ownFactorySource = data.factories.get(idOf(ownPlayer));
          bestOwnPendingLevels = ownFactorySource?.pendingFactoryLevels ?? [];
          bestOwnPendingDelayTicks = ownFactorySource?.factoryConstructionDelayTicks ?? 0;
          bestRouteDelayTicks = Math.ceil(
            Number(config?.trainStationMaxRange?.() ?? 0) / 2,
          );
          bestPendingStopDelayTicks = Math.max(
            0,
            ...pendingDestinations.map(({ type }) =>
              Number(config?.unitInfo?.(type)?.constructionDuration ?? 0),
            ),
          );
        }
        if (futureDestinations.length > 0) {
          const eligibleDestinations = futureDestinations.filter(({ owner }) =>
            sameOwner(ownPlayer, owner) || shimCanTrade(ownPlayer, owner),
          );
          const routeProfile = {
            clusterId: cluster,
            factorySourceCount: [...data.factories.values()].reduce(
              (total, source) =>
                total +
                source.productiveFactoryUnits.length +
                source.pendingFactoryLevels.length,
              0,
            ),
            paidStops: eligibleDestinations.length,
            teamGoldPerSpawn: poolMean(ownPlayer, false, false),
            postTeamGoldPerSpawn: poolMean(ownPlayer, false, true),
            teamGoldAfterPendingPerSpawn:
              poolMean(ownPlayer, false, false, true),
            postTeamGoldAfterPendingPerSpawn:
              poolMean(ownPlayer, false, true, true),
            payoutTimeline: sourcePayoutTimeline(ownPlayer).map((point) => ({
              atTicks: point.atTicks,
              teamGoldPerSpawn: point.beforeTeamGoldPerSpawn,
              teamGoldAfterPendingPerSpawn:
                point.beforeTeamGoldAfterPendingPerSpawn,
            })),
            pendingStopDelayTicks,
            eligibleTicks: eligibleTicksFor(ownPlayer, eligibleDestinations),
          };
          if (eligibleDestinations.length > 0) factoryRouteProfiles.push(routeProfile);
          const routePotential = Math.max(
            routeProfile.teamGoldPerSpawn,
            routeProfile.postTeamGoldPerSpawn,
            routeProfile.teamGoldAfterPendingPerSpawn,
            routeProfile.postTeamGoldAfterPendingPerSpawn,
          );
          if (routePotential > bestFactoryGold) {
            bestFactoryGold = routePotential;
            bestPaidStops = eligibleDestinations.length;
          }
          const ownFactorySource = data.factories.get(idOf(ownPlayer));
          if (ownFactorySource) {
            for (let index = 0; index < ownFactorySource.productiveFactoryUnits.length; index++) {
              const unit = ownFactorySource.productiveFactoryUnits[index];
              if (typeof unit?.id !== "function") continue;
              factoryUpgradeTargets.push({
                structureId: unit.id(),
                clusterId: cluster,
                factoryCount: ownFactorySource.factoryCount,
                productiveFactoryLevels: ownFactorySource.productiveFactoryLevels,
                pendingFactoryLevels: ownFactorySource.pendingFactoryLevels,
                factoryConstructionDelayTicks:
                  ownFactorySource.factoryConstructionDelayTicks,
                upgradeFactoryIndex: index,
                pendingStopDelayTicks,
                teamGoldPerTrain: routePotential,
              });
            }
          }
        }
      }

      const ownFactoryCount = levelSum(ownPlayer?.units?.(UNIT.Factory));
      const sharedWater = this.game?.sharedWaterComponents?.(ownPlayer);
      let teamFactoryLevels = 0;
      let teamCityStops = 0;
      let allyFactoryLevels = 0;
      let allyCityStops = 0;
      let pendingPartnerConstructionTicks = 0;
      const portConstructionTicks = Number(
        config?.unitInfo?.(UNIT.Port)?.constructionDuration ?? 0,
      );
      const portSeedHorizonTicks = Number.isFinite(Number(horizonTicks))
        ? Math.max(0, Number(horizonTicks))
        : legendaryStructureHorizonTicks(
            this.game,
