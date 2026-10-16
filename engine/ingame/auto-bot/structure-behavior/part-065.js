        ) continue;
        value +=
          structureValues?.get(structure) ??
          this.legendaryCriticalStructureValue(structure);
        count++;
      }
      const totalValue = context.totalValue + candidateValue;
      return { value, count, ratio: Math.min(1, value / Math.max(1, totalValue)) };
    }

    legendaryCachedCandidateShotPlan(tile, threat, context) {
      const cache = context?.candidateShotPlanCache;
      if (!cache || typeof cache.get !== "function") {
        return { hit: false, plan: null };
      }
      const byTarget = cache.get(threat);
      if (!byTarget || !byTarget.has(tile)) {
        return { hit: false, plan: null };
      }
      return { hit: true, plan: byTarget.get(tile) };
    }

    rememberLegendaryCandidateShotPlan(tile, threat, context, plan) {
      const cache = context?.candidateShotPlanCache;
      if (
        !cache ||
        typeof cache.get !== "function" ||
        typeof cache.set !== "function"
      ) {
        return;
      }
      let byTarget = cache.get(threat);
      if (!byTarget) {
        byTarget = new Map();
        cache.set(threat, byTarget);
      }
      byTarget.set(tile, plan);
    }

    legendaryCandidateShotPlan(tile, threat, context = null) {
      const cached = this.legendaryCachedCandidateShotPlan(
        tile,
        threat,
        context,
      );
      if (cached.hit) return cached.plan;
      const sourcePlan = threat.salvoPlan || {};
      const atomCount = Array.isArray(sourcePlan.atomArrivalTicks)
        ? sourcePlan.atomArrivalTicks.length
        : 0;
      const hydrogenCount =
        sourcePlan.hydrogenArrivalTick === null ||
        sourcePlan.hydrogenArrivalTick === undefined
          ? 0
          : 1;
      const routeCount = Array.isArray(sourcePlan.routes)
        ? sourcePlan.routes.length
        : 0;
      const launches = this.legendaryEnemyMissileLaunchPlan(
        threat.enemySilos || [],
        tile,
        Math.max(1, atomCount + hydrogenCount, routeCount),
        {
          siloMetadataCache: context?.launchMetadataCache || null,
        },
      );
      if (launches.length === 0) {
        this.rememberLegendaryCandidateShotPlan(tile, threat, context, null);
        return null;
      }
      const hasHydrogen =
        threat.weapon === UNIT.HydrogenBomb || hydrogenCount > 0;
      const launchTiming = this.legendaryCandidateLaunchTimingSummary(
        launches,
        hasHydrogen,
      );
      const shotPlan = {
        sourcePlan,
        ...launchTiming,
      };
      this.rememberLegendaryCandidateShotPlan(tile, threat, context, shotPlan);
      return shotPlan;
    }

    legendaryCandidateLaunchTimingSummary(launches, hasHydrogen) {
      const atomArrivalTicks = [];
      let nearestFlightTime = Infinity;
      for (let index = 0; index < launches.length; index++) {
        const launch = launches[index];
        const flightTime = launch.flightTicks ?? launch.impactTick;
        nearestFlightTime = Math.min(nearestFlightTime, flightTime);
        if (!hasHydrogen || index < launches.length - 1) {
          atomArrivalTicks.push(launch.impactTick);
        }
      }
      return {
        atomArrivalTicks,
        hydrogenArrivalTick: hasHydrogen
          ? launches.at(-1).impactTick
          : null,
        nearestFlightTime,
      };
    }

    legendaryConstructionState({ cityCount, hasCoastalTiles }) {
      const cities = this.player.units(UNIT.City);
      const ports = this.player.units(UNIT.Port);
      const factories = this.player.units(UNIT.Factory);
      const enemySilos = this.enemyMissileSiloPressure();
      const missileThreat = this.getMissileDefenseContext();
      const rail = this.legendaryRailMetrics(cities, ports, factories);
      const hostile = this.legendaryHostilePlayers();
      const hasTradePartner = this.hasTradeablePortOnSharedWater();
      const hasCompletedTradePartner = this.hasTradeablePortOnSharedWater({
        includeInProgress: false,
      });
      const factoryUnitCount = typeof this.player?.unitCount === "function"
        ? this.player.unitCount(UNIT.Factory)
        : factories.reduce(
            (total, factory) =>
              total + Math.max(1, Math.floor(Number(factory?.level?.() ?? 1))),
            0,
          );
      const spawnMultipliers = legendaryEconomySpawnMultipliers(
        this.game?.config?.(),
        factoryUnitCount,
        this.game?.units?.(UNIT.Train)?.length ?? 0,
        this.game?.units?.(UNIT.TradeShip)?.length ?? 0,
      );
      const economyHorizonTicks = legendaryStructureHorizonTicks(
        this.game,
        safeStructureGameTick(this.game),
        this.player,
      );
      const economyInputs = this.legendaryEconomyInputs({
        trainCount: this.game?.units?.(UNIT.Train)?.length ?? 0,
        tradeShipCount: this.game?.units?.(UNIT.TradeShip)?.length ?? 0,
        hasTradePartner,
        hasCompletedTradePartner,
        connectedStops: rail.connectedCities + ports.length,
        horizonTicks: economyHorizonTicks,
      });
      const ownSiloLevels = this.ownedLevels(UNIT.MissileSilo);
      const siloParityTarget = this.missileSiloParityTarget();
      const siloParityGap = Math.max(0, siloParityTarget - ownSiloLevels);
      const samLevelParityTarget = this.samLevelParityTarget();
      const samLevelParityGap = this.samLevelParityGap();
      let enemyWarships = 0;
      for (const enemy of hostile) {
        {
          enemyWarships += enemy.units(UNIT.Warship).length;
        }
      }

      const protectableStructures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
