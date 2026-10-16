                    ? this.legendaryConstructionRemainingTicks(
                        UNIT.Port,
                        partnerTarget.unit,
                      )
                    : portConstructionTicks,
                },
              ];
              const seedEvaluation = legendaryEconomyNetGold(UNIT.Port, {
                cost: Number(this.cost(UNIT.Port)),
                horizonTicks: portSeedHorizonTicks,
                inputs: {
                  tradeShipCount,
                  hasCompletedTradePartner: false,
                  hasPendingTradePartner: true,
                  portSeedWindowOpen: true,
                  portSeedPartnerCommitted: true,
                  portSeedSources: sources,
                },
                config,
              });
              const candidate = {
                sources,
                committed: inProgress.length > 0,
                ownInProgress:
                  this.portOwnerStateOnWater(ownPlayer, component).inProgress ===
                  true,
                value:
                  ownProfile.teamGoldPerArrival +
                  partnerProfile.teamGoldPerArrival,
                expectedNetTeamGold:
                  seedEvaluation !== null && seedEvaluation.refused !== true
                    ? seedEvaluation.netTeamGold
                    : null,
                routeDelay:
                  ownProfile.routeDelayTicks + partnerProfile.routeDelayTicks,
              };
              if (legendarySeedCandidateBeats(candidate, bestSeed)) {
                bestSeed = candidate;
              }
            }
          }
        }
        if (bestSeed) {
          portSeedSources = bestSeed.sources;
          seedPartnerCommitted = bestSeed.committed === true;
        }
      }
      const completedFactoryLevels = (this.player?.units?.(UNIT.Factory) ?? [])
        .reduce(
          (total, factory) =>
            factory?.isUnderConstruction?.() === true
              ? total
              : total + levelOf(factory),
          0,
        );
      return {
        ownFactoryCount,
        ownProductiveFactoryLevels: bestOwnProductiveLevels,
        ownPendingFactoryLevels: bestOwnPendingLevels,
        ownPendingFactoryDelayTicks: bestOwnPendingDelayTicks,
        clusterFactoryLevels: completedFactoryLevels,
        ownCityStops: ownCityUnits.length,
        ownPorts,
        ownCompletedPorts: ownPortUnits.filter(
          (port) => port?.isUnderConstruction?.() !== true,
        ).length,
        portInProgress: ownPortUnits.some(
          (port) => port?.isUnderConstruction?.() === true,
        ) ? 1 : 0,
        teamFactoryLevels,
        teamCityStops,
        allyFactoryLevels,
        allyCityStops,
        hasTeamOrAllyEconomy:
          teamFactoryLevels + teamCityStops + allyFactoryLevels + allyCityStops > 0,
        connectedStops,
        trainCount: globalTrainCount,
        tradeShipCount,
        fleetProducerSupply,
        ownPortProducerSources,
        hasTradePartner,
        hasCompletedTradePartner,
        hasPendingTradePartner: hasTradePartner && !hasCompletedTradePartner,
        portSeedWindowOpen,
        pendingPartnerConstructionTicks,
        portSeedSources,
        portSeedPartnerCommitted: seedPartnerCommitted,
        routeDelayTicks: Math.max(
          bestRouteDelayTicks,
          Math.ceil(Number(config?.trainStationMaxRange?.() ?? 0) / 2),
          bestPendingStopDelayTicks,
        ),
        portRouteDelayTicks: portTradeProfile?.routeDelayTicks ?? 0,
        portTradeGoldPerArrival: portTradeProfile?.teamGoldPerArrival ?? 0,
        portPostAllianceGoldPerArrival:
          portTradeProfile?.postAllianceGoldPerArrival ?? 0,
        portRoutes: portTradeProfile?.routes ?? [],
        portProjectionProfile: portTradeProfile,
        portCandidateProfiles,
        factoryPaidStops: bestPaidStops,
        factoryTeamGoldPerTrain: bestFactoryGold,
        trainSources: bestTrainSources,
        cityRouteProfiles,
        otherFactoryStreams,
        factorySeedStops,
        ownerFactoryClusters: ownFactoryClusterEntries,
        factoryRouteProfiles,
        factoryStationEntries: clusterEntries,
        factoryRailState: railState,
        factoryUpgradeTargets,
        portUpgradeTargetIds,
        portUpgradeProfiles,
      };
    }

    legendaryAllianceTicksRemainingOrNull(owner, otherOwner) {
      const source = owner?.__src ?? owner;
      const otherId = String(otherOwner?.smallID?.() ?? "");
      const tick = safeStructureGameTick(this.game) ?? 0;
      for (const alliance of source?.alliances?.() ?? []) {
        const other = typeof alliance?.other === "function"
          ? alliance.other(source)?.smallID?.()
          : alliance?.other;
        if (String(other ?? "") !== otherId) continue;
        const expiresAt = typeof alliance?.expiresAt === "function"
          ? alliance.expiresAt()
          : alliance?.expiresAt;
        if (Number.isFinite(Number(expiresAt))) {
          return Math.max(0, Number(expiresAt) - tick);
        }
      }
      return null;
    }

    legendaryAllianceTicksRemaining(owner, otherOwner) {
      const ticks = this.legendaryAllianceTicksRemainingOrNull(owner, otherOwner);
      return ticks === null
        ? Number(this.game?.config?.()?.allianceDuration?.() ?? 0)
        : ticks;
    }

    legendaryAlliancePairTicks(left, right) {
      const direct = this.legendaryAllianceTicksRemainingOrNull(left, right);
      if (direct !== null) return direct;
      const reverse = this.legendaryAllianceTicksRemainingOrNull(right, left);
      if (reverse !== null) return reverse;
      // The client reliably sees only its own alliance list; when the route
      // source's record is invisible, read the same alliance from the other
      // endpoint before falling back to the config duration.
      return Number(this.game?.config?.()?.allianceDuration?.() ?? 0);
    }

    // shortcut: client exposes the water raster, not TradeShipExecution's pathfinder;
    // bounded shortest-water BFS estimates distance until a shared route hook exists.
    legendaryWaterDistancesFrom(sourceTile) {
      const tick = safeStructureGameTick(this.game);
      if (this._legendaryWaterRouteTick !== tick) {
        this._legendaryWaterRouteTick = tick;
        this._legendaryWaterRouteCache = new Map();
      }
