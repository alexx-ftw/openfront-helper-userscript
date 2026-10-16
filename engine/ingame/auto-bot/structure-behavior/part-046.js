          now <= startTick
            ? 0
            : Math.floor((now - startTick) / ticksPerStep);
        const index = Math.max(
          0,
          Math.min(plan.path.length - 1, rawIndex),
        );
        // GameView stores Uint32Array paths; route consumers require an Array.
        const path = Array.from(plan.path.slice(index));
        const launchOffset = Math.max(0, startTick - now);
        const impactTick = launchOffset + Math.max(1, path.length);
        // Motion plans omit the detonation step; SAM routes reserve their last
        // element for it, so retain the final in-flight interception window.
        const targetTile = nuke.targetTile?.();
        if (targetTile !== null && targetTile !== undefined) path.push(targetTile);
        const motion = {
          fromTile: plan.path[0] ?? fromTile,
          path,
          launchOffset,
          impactTick,
        };
        this.legendaryActiveMissileMotionCache(nuke)?.set(nuke, {
          plan,
          path: plan.path,
          tick: now,
          fromTile,
          motion,
        });
        return motion;
      }
    }

    legendaryActiveMotionPlan(nuke) {
      const id = typeof nuke?.id === "function" ? nuke.id() : null;
      if (id === null) return null;
      const plans = this.game.motionPlans?.();
      return plans ? plans.get(id) : null;
    }

    legendaryThreatDefensePlan(
      threat,
      {
        levelOverrides = null,
        extraSam = null,
        completionTick = 0,
        samProfilesOverride = null,
      } = {},
    ) {
      if (!threat) return null;
      const samProfiles =
        samProfilesOverride ||
        this.legendaryFriendlySamProfiles(levelOverrides, extraSam);
      if (threat.inFlight) {
        return this.legendaryInFlightDefensePlan(threat, samProfiles);
      }
      return this.legendaryProspectiveDefensePlan(threat, samProfiles, {
        levelOverrides,
        extraSam,
        completionTick,
      });
    }

    legendaryInFlightDefensePlan(threat, samProfiles) {
      const fromTile =
        threat.nuke && typeof threat.nuke.tile === "function"
          ? threat.nuke.tile()
          : null;
      const targetTile = threat.targetTile;
      if (fromTile === null || targetTile === null || targetTile === undefined) {
        return null;
      }
      const motion = this.legendaryActiveMissileMotion(threat.nuke, fromTile);
      const impactTick =
        motion?.impactTick ?? this.legendaryNukeFlightTime(fromTile, targetTile);
      const route = this.legendaryBuildMissileRoute(
        {
          fromTile: motion?.fromTile ?? fromTile,
          targetTile,
          impactTick,
          launchOffset: motion?.launchOffset ?? 0,
          weapon: threat.weapon,
          id: `active:${String(threat.weapon)}:${String(impactTick)}`,
          path: motion?.path ?? null,
        },
        samProfiles,
      );
      return {
        routes: route ? [route] : [],
        samProfiles,
        forecastComplete: true,
      };
    }

    legendaryProspectiveDefensePlan(threat, samProfiles, options) {
      const rebuiltRoutes = this.legendaryRebuildMissileRoutes(
        threat.salvoPlan?.routes,
        samProfiles,
      );
      if (rebuiltRoutes !== null) {
        return {
          routes: rebuiltRoutes,
          samProfiles,
          forecastComplete: threat.salvoPlan.forecastComplete !== false,
        };
      }
      const plan = this.legendaryMissileSalvoPlan(
        {
          enemySilos: threat.enemySilos || [],
          enemyGold: threat.enemyGold ?? 0n,
          targetTile: threat.targetTile,
          atomCost: threat.atomCost ?? this.cost(UNIT.AtomBomb),
          hydrogenCost:
            threat.hydrogenCost ?? this.cost(UNIT.HydrogenBomb),
        },
        {
          levelOverrides: options.levelOverrides,
          extraSam: options.extraSam,
          actionCompletionTick: options.completionTick,
          samProfilesOverride: samProfiles,
        },
      );
      return {
        routes: plan.routes || [],
        samProfiles: plan.samProfiles || samProfiles,
        forecastComplete: plan.forecastComplete !== false,
      };
    }

    legendaryThreatDefenseSchedule(
      threat,
      {
        levelOverrides = null,
        extraSam = null,
        completionTick = 0,
      } = {},
    ) {
      if (!threat) return null;
      const hasLevelOverrides = this.hasLegendaryLevelOverrides(levelOverrides);
      if (
        !hasLevelOverrides &&
        !extraSam &&
        Number(completionTick) === 0 &&
        threat.salvoPlan &&
        threat.salvoPlan.schedule &&
        Array.isArray(threat.salvoPlan.schedule.missiles)
      ) {
        return threat.salvoPlan.schedule;
      }
      const plan = this.legendaryThreatDefensePlan(threat, {
        levelOverrides,
        extraSam,
        completionTick,
      });
      if (!plan) return null;

      const schedule = legendaryMissileDefenseSchedule({
        routes: plan.routes,
        samProfiles: plan.samProfiles,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
