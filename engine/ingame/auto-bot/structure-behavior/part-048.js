        };
      }
      return this.legendaryThreatDefensePlan(threat, {
        ...options,
        samProfilesOverride: samProfiles,
      });
    }

    legendaryGroupDefenseSchedule(group, globalSchedule) {
      const missiles = [];
      let firstImpactTick = Infinity;
      let minimumInterceptMarginTicks = Infinity;
      let interceptedCount = 0;
      let uninterceptedCount = 0;
      for (const missile of globalSchedule.missiles) {
        if (!group.routeIds.has(String(missile.id))) continue;
        missiles.push(missile);
        firstImpactTick = Math.min(firstImpactTick, missile.impactTick);
        minimumInterceptMarginTicks = Math.min(
          minimumInterceptMarginTicks,
          missile.marginTicks,
        );
        if (missile.intercepted) interceptedCount++;
        else uninterceptedCount++;
      }
      const completionTick = globalSchedule.completionTick;
      const completionMarginTicks = Number.isFinite(firstImpactTick)
        ? Math.max(0, firstImpactTick - completionTick)
        : Infinity;
      return {
        ...globalSchedule,
        missiles,
        firstImpactTick,
        completionMarginTicks,
        completionMarginSatisfied:
          Number.isFinite(firstImpactTick) &&
          completionMarginTicks >= LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        fullyDefended: group.forecastComplete && uninterceptedCount === 0,
        interceptedCount,
        uninterceptedCount,
        minimumInterceptMarginTicks: missiles.length
          ? minimumInterceptMarginTicks
          : Infinity,
        threat: group.threat,
      };
    }

    legendaryMissileDefenseNeedsAction(context) {
      const evaluation = this.getMissileDefenseEvaluation(context);
      return Boolean(
        evaluation.hasThreats &&
          !evaluation.fullyDefended,
      );
    }

    legendarySamConstructionSafeForTile(tile, context, level = 1) {
      if (tile === null || tile === undefined) return false;
      const completionTick = this.legendaryConstructionDuration(
        UNIT.SAMLauncher,
      );
      const evaluation = this.legendaryDefenseEvaluation(context, {
        extraSam: {
          id: "legendary-candidate-sam",
          tile,
          level,
          completionTick,
          availableTicks: Array(Math.max(1, Number(level))).fill(
            completionTick,
          ),
        },
        completionTick,
      });
      return Boolean(
        evaluation.hasThreats &&
          evaluation.fullyDefended &&
          evaluation.completionMarginTicks >=
            LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
      );
    }

    activeMissileSamConstructionImproves(tile, context, currentEvaluation) {
      if (tile === null || tile === undefined) return false;
      const completionTick = this.legendaryConstructionDuration(
        UNIT.SAMLauncher,
      );
      if (
        this.uncoveredActiveMirvDemands(context).some((demand) =>
          this.samTileCoversMirvDemand(tile, demand, completionTick),
        )
      ) return true;
      if (!currentEvaluation?.hasThreats) return false;
      const nextEvaluation = this.legendaryDefenseEvaluation(context, {
        extraSam: {
          id: "active-missile-candidate-sam",
          tile,
          level: 1,
          completionTick,
          availableTicks: [completionTick],
        },
        completionTick,
      });
      return legendaryDefenseActionImproves(
        currentEvaluation,
        nextEvaluation,
        0,
        0,
      );
    }

    legendaryTileInsideUninterceptedBlast(
      tile,
      context,
      evaluationOverride = null,
    ) {
      if (tile === null || tile === undefined || !context) return false;
      // Use the global evaluation so two enemy salvos cannot each reuse the
      // same SAM slot while this placement filter decides whether a productive
      // tile is still inside an actually un-interceptable blast.
      const evaluation =
        evaluationOverride || this.getMissileDefenseEvaluation(context);
      for (const schedule of evaluation.schedules || []) {
        if (this.legendaryScheduleBlastContainsTile(schedule, tile, context)) {
          return true;
        }
      }
      return false;
    }

    legendaryScheduleBlastContainsTile(schedule, tile, context) {
      if (!schedule || schedule.fullyDefended || !schedule.threat) return false;
      const targetTile = schedule.threat.targetTile;
      if (targetTile === null || targetTile === undefined) return false;
      const radius =
        schedule.threat.weapon === UNIT.HydrogenBomb
          ? Number(context.hydrogenRadius || 0)
          : Number(context.atomRadius || 0);
      return (
        radius > 0 &&
        this.game.euclideanDistSquared(tile, targetTile) <= radius * radius
      );
    }

    legendarySamInterceptionCapacity(
      fromTile,
      targetTile,
      levelOverrides = null,
      samProfilesOverride = null,
    ) {
      const path = this.legendaryNukeFlightPath(fromTile, targetTile);
      const targetableIndexes = this.legendaryCachedTrajectoryTargetableIndexes(
        path,
        fromTile,
        targetTile,
      );
      const route = { path, targetableIndexes };
      const preparedProfiles =
        levelOverrides === null && Array.isArray(samProfilesOverride)
          ? samProfilesOverride
          : null;
      const sams = preparedProfiles || this.legendaryFriendlySamUnits();
