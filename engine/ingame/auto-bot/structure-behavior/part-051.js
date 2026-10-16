      ) {
        return this.emptyLegendaryMissileSalvoPlan(
          actionCompletionTick,
          samProfilesOverride,
        );
      }

      const samProfiles =
        samProfilesOverride ||
        this.legendaryFriendlySamProfiles(levelOverrides, extraSam);
      // Gold is necessary but not sufficient: an enemy can only launch as many
      // atoms in the opening salvo window as their silos have ready/reloadable
      // slots. Without this ceiling, one rich enemy with a single level-1 silo
      // is modeled as a hundred-missile chain and forces a chronic SAM
      // over-build. Sum the live silo levels (max simultaneous slots) and the
      // ready-shot count, then let the larger bound the salvo size.
      const siloCapacityCeiling = this.legendaryEnemySiloSalvoCeiling(
        enemySilos,
        siloMetadataCache,
      );
      const budget = this.legendaryMissileSalvoBudget(
        enemyGold,
        atomCost,
        hydrogenCost,
        { siloCapacityCeiling },
      );
      const { canHydrogen, atomCount, forecastComplete } = budget;
      const desiredShotCount = atomCount + (canHydrogen ? 1 : 0);
      const launches = this.legendaryEnemyMissileLaunchPlan(
        enemySilos,
        targetTile,
        desiredShotCount,
        { siloMetadataCache },
      );
      const readyShots = this.legendaryReadyShotTotal(
        enemySilos,
        siloMetadataCache,
        readyShotsOverride,
      );
      const routePlan = this.legendarySalvoRoutes({
        launches,
        targetTile,
        canHydrogen,
        atomCount,
        samProfiles,
      });
      const { atomArrivalTicks, hydrogenArrivalTick, routes } = routePlan;
      const launchFlightTimes = new Map();
      for (const launch of launches) {
        if (!launchFlightTimes.has(launch.silo)) {
          launchFlightTimes.set(launch.silo, launch.flightTicks);
        }
      }
      const sourceMetrics = this.legendarySalvoSourceMetrics({
        enemySilos,
        targetTile,
        launchFlightTimes,
        routes,
        samProfiles,
        siloMetadataCache,
      });
      const interceptionCapacity =
        this.legendarySalvoSourceInterceptionCapacity(sourceMetrics);
      const samCooldownTicks = this.legendarySamCooldownTicks();
      const schedule = legendaryMissileDefenseSchedule({
        routes,
        samProfiles,
        samCooldownTicks,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        completionTick: actionCompletionTick,
      });
      schedule.forecastComplete =
        forecastComplete && launches.length >= desiredShotCount;
      const risk = this.finalizeLegendarySalvoRisk(schedule, {
        atomArrivalTicks,
        hydrogenArrivalTick,
        interceptionCapacity,
        samCooldownTicks,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        routes,
        samProfiles,
        scheduleOverride: schedule,
        completionTick: actionCompletionTick,
      });
      return {
        atomArrivalTicks,
        hydrogenArrivalTick,
        interceptionCapacity,
        readyShots,
        forecastComplete: schedule.forecastComplete,
        risk,
        schedule,
        routes,
        sourceMetrics,
        samProfiles,
      };
    }

    legendarySalvoSourceInterceptionCapacity(sourceMetrics) {
      let interceptionCapacity = 0;
      for (const source of sourceMetrics) {
        interceptionCapacity += source.interceptionCapacity;
      }
      return interceptionCapacity;
    }

    finalizeLegendarySalvoRisk(schedule, riskInput) {
      if (schedule.forecastComplete) return legendaryMissileSalvoRisk(riskInput);
      // An incomplete explicit forecast cannot claim a complete defense.
      schedule.fullyDefended = false;
      schedule.inconclusive = true;
      const risk = legendaryMissileSalvoRisk(riskInput);
      Object.assign(risk, {
        fullyDefended: false,
        inconclusive: true,
        forecastComplete: false,
        risk: 1,
        critical: true,
      });
      return risk;
    }

    emptyLegendaryMissileSalvoPlan(completionTick, samProfiles) {
      return {
        atomArrivalTicks: [],
        hydrogenArrivalTick: null,
        interceptionCapacity: 0,
        readyShots: 0,
        forecastComplete: true,
        risk: legendaryMissileSalvoRisk(),
        schedule: legendaryMissileDefenseSchedule({
          routes: [],
          samProfiles: [],
          marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
          completionTick,
        }),
        routes: [],
        sourceMetrics: [],
        samProfiles: samProfiles || [],
      };
    }

    legendaryMissileSalvoBudget(
      enemyGold,
      atomCost,
      hydrogenCost,
      { siloCapacityCeiling = null } = {},
    ) {
      const canHydrogen = hydrogenCost > 0n && enemyGold >= hydrogenCost;
      const atomBudgetGold = canHydrogen ? enemyGold - hydrogenCost : enemyGold;
      const affordable = Number(atomCost > 0n ? atomBudgetGold / atomCost : 0n);
      // A silo can only hold one queued launch per level slot, and each slot
      // reloads on a fixed cooldown. An enemy with a single level-1 silo
      // therefore cannot empty a million-gold treasury into one opening salvo,
      // regardless of how much they could afford in principle. Bound the atom
      // count by the live silo capacity so the defense model neither over-builds
      // SAMs against an impossible phalanx nor under-defends a genuine multi-silo
      // strike. The ceiling is advisory: when unknown (null/undefined), gold
      // still governs. Note Number(null) === 0, so the explicit null/undefined
      // guard is required to avoid treating "unknown" as "zero capacity".
