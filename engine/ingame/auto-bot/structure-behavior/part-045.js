      );
      state.coverageIndexCache?.set(samIndex, coverageIndexes);
      return coverageIndexes;
    }

    legendarySamTargetClaimScore(profile, state) {
      const distance = this.game.manhattanDist(profile.tile, state.targetTile);
      const typeBonus = state.weapon === UNIT.HydrogenBomb ? 70_001 : 0;
      const distanceBonus = Math.max(0, 200_000 - distance * 1_000);
      const timeToExplode = Math.max(
        1,
        Number(state.impactTick) - Number(state.launchOffset || 0),
      );
      const urgencyBonus = Math.max(0, 10_000 - timeToExplode * 100);
      return typeBonus + distanceBonus + urgencyBonus;
    }

    legendaryMissileRouteSamOptions(samProfiles, state) {
      state.coverageRoute = null;
      const samOptions = [];
      for (let samIndex = 0; samIndex < samProfiles.length; samIndex++) {
        const profile = samProfiles[samIndex];
        const coverageIndexes = this.legendaryMissileRouteCoverageIndexes(
          profile,
          samIndex,
          state,
        );
        const opportunities = this.legendarySamInterceptionOpportunities(
          profile,
          coverageIndexes,
          state,
        );
        if (opportunities.fireTicks.length > 0) {
          samOptions.push({
            samIndex,
            interceptTicks: opportunities.fireTicks,
            interceptionTicks: opportunities.interceptionTicks,
            claimScore: this.legendarySamTargetClaimScore(profile, state),
          });
        }
      }
      return {
        samOptions,
        targetableIndexes:
          state.coverageRoute?.targetableIndexes ?? state.targetableIndexesOverride,
      };
    }

    legendaryBuildMissileRoute(route, samProfiles, coverageIndexCache = null) {
      const {
        fromTile,
        targetTile,
        impactTick,
        launchOffset = 0,
        weapon = null,
        id = null,
        path: pathOverride = null,
        targetableIndexes: targetableIndexesOverride = null,
      } = route;
      const path =
        Array.isArray(pathOverride) && pathOverride.length > 0
          ? pathOverride
          : this.legendaryNukeFlightPath(fromTile, targetTile);
      const routeOptions = this.legendaryMissileRouteSamOptions(
        samProfiles,
        {
          path,
          fromTile,
          targetTile,
          launchOffset,
          weapon,
          impactTick,
          targetableIndexesOverride,
          coverageIndexCache,
        },
      );
      return {
        id: id ?? `${String(weapon ?? "missile")}:${String(impactTick)}`,
        weapon,
        fromTile,
        targetTile,
        impactTick: Number(impactTick),
        launchOffset,
        // Keep the already computed trajectory with the route. SAM upgrade
        // evaluations change only interceptor profiles; they must not run the
        // parabola pathfinder again for every candidate SAM.
        path,
        targetableIndexes: routeOptions.targetableIndexes,
        samOptions: routeOptions.samOptions,
      };
    }

    legendaryRebuildMissileRoutes(routes, samProfiles) {
      if (!Array.isArray(routes)) return null;
      const rebuilt = [];
      const coverageCacheByPath = new Map();
      for (const route of routes) {
        if (!route || !Array.isArray(route.path) || route.path.length === 0) {
          return null;
        }
        let coverageIndexCache = coverageCacheByPath.get(route.path);
        if (!coverageIndexCache) {
          coverageIndexCache = new Map();
          coverageCacheByPath.set(route.path, coverageIndexCache);
        }
        rebuilt.push(
          this.legendaryBuildMissileRoute(route, samProfiles, coverageIndexCache),
        );
      }
      return rebuilt;
    }

    legendaryActiveMissileMotionCache(nuke) {
      if (
        !(
          (typeof nuke === "object" && nuke !== null) ||
          typeof nuke === "function"
        )
      ) {
        return null;
      }
      if (!(this._legendaryActiveMissileMotionCache instanceof WeakMap)) {
        this._legendaryActiveMissileMotionCache = new WeakMap();
      }
      return this._legendaryActiveMissileMotionCache;
    }

    legendaryActiveMissileMotionCacheHit(nuke, plan, now, fromTile) {
      const cache = this.legendaryActiveMissileMotionCache(nuke);
      const cached = cache?.get(nuke);
      if (
        cached?.plan !== plan ||
        cached.path !== plan.path ||
        cached.tick !== now ||
        cached.fromTile !== fromTile
      ) {
        return null;
      }
      return cached.motion;
    }

    // The client keeps exact server motion plans for active nukes. Prefer that
    // path over rebuilding a new parabola from the nuke's current tile: the
    // latter loses the original launch arc and can move a near-impact window
    // across the five-tick safety boundary.
    legendaryActiveMissileMotion(nuke, fromTile) {
      {
        const plan = this.legendaryActiveMotionPlan(nuke);
        if (!plan || !plan.path || plan.path.length === 0) return null;
        const now = Number(this.game.ticks?.() ?? 0);
        const cachedMotion = this.legendaryActiveMissileMotionCacheHit(
          nuke,
          plan,
          now,
          fromTile,
        );
        if (cachedMotion !== null) return cachedMotion;
        const startTick = Number(plan.startTick ?? now);
        const ticksPerStep = Math.max(1, Number(plan.ticksPerStep ?? 1));
        const rawIndex =
