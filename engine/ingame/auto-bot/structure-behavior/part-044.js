      }
      return indexes;
    }

    legendarySamPathHasCoverageForRoute(
      samOrTile,
      route,
      levelOverride = null,
      coverageProfile = null,
    ) {
      if (!Array.isArray(route?.targetableIndexes)) {
        return (
          this.legendarySamPathCoverageIndicesForRoute(
            samOrTile,
            route,
            levelOverride,
            coverageProfile,
          ).length > 0
        );
      }
      const profile =
        coverageProfile ??
        this.legendarySamCoverageProfile(samOrTile, levelOverride);
      if (profile === null) return false;
      const { samTile, range } = profile;
      if (range <= 0) return false;
      const rangeSquared = range * range;
      for (const index of route.targetableIndexes) {
        if (
          this.game.euclideanDistSquared(route.path[index], samTile) <=
          rangeSquared
        ) {
          return true;
        }
      }
      return false;
    }

    legendarySamPathInterceptTicksForRoute(
      samOrTile,
      route,
      levelOverride = null,
      coverageProfile = null,
    ) {
      return this.legendaryInterceptTicksFromIndexes(
        this.legendarySamPathCoverageIndicesForRoute(
          samOrTile,
          route,
          levelOverride,
          coverageProfile,
        ),
        route.launchOffset,
      );
    }

    legendarySamRouteHasTemporalOverlap(route, completionTick) {
      const targetableIndexes = route?.targetableIndexes;
      if (!Array.isArray(targetableIndexes) || targetableIndexes.length === 0) {
        return false;
      }
      const launchOffset = Math.max(0, Number(route.launchOffset) || 0);
      return (
        launchOffset + targetableIndexes.at(-1) >= completionTick &&
        launchOffset + targetableIndexes[0] <= route.impactTick
      );
    }

    legendarySamRouteOutsideTargetableBounds(route, samTile, range) {
      const bounds = route?.targetableBounds;
      if (
        !bounds ||
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return false;
      }
      const samX = Number(this.game.x(samTile));
      const samY = Number(this.game.y(samTile));
      if (!Number.isFinite(samX) || !Number.isFinite(samY)) return false;
      return (
        samX < bounds.minX - range ||
        samX > bounds.maxX + range ||
        samY < bounds.minY - range ||
        samY > bounds.maxY + range
      );
    }

    legendarySamRouteHasIntercept(
      samOrTile,
      levelOverride,
      route,
      completionTick,
      coverageProfile = null,
    ) {
      if (!Array.isArray(route?.path) || route.path.length < 2) return false;
      const profile =
        coverageProfile ??
        this.legendarySamCoverageProfile(samOrTile, levelOverride);
      if (profile === null) return false;
      const { samTile, range } = profile;
      if (range <= 0) return false;
      if (this.legendarySamRouteOutsideTargetableBounds(route, samTile, range)) {
        return false;
      }
      const coverageIndexes = this.legendarySamPathCoverageIndicesForRoute(
        samOrTile,
        route,
        levelOverride,
        profile,
      );
      const opportunities = this.legendarySamInterceptionOpportunities(
        { tile: samTile },
        coverageIndexes,
        route,
      );
      const earliestFireTick = Math.max(0, Number(completionTick) || 0);
      return opportunities.fireTicks.some(
        (fireTick) =>
          fireTick >= earliestFireTick && fireTick <= route.impactTick,
      );
    }

    legendaryMissileRouteCoverageRoute(
      path,
      fromTile,
      targetTile,
      launchOffset,
      targetableIndexesOverride,
    ) {
      return {
        path,
        fromTile,
        targetTile,
        launchOffset,
        targetableIndexes: Array.isArray(targetableIndexesOverride)
          ? targetableIndexesOverride
          : this.legendaryCachedTrajectoryTargetableIndexes(
              path,
              fromTile,
              targetTile,
            ),
      };
    }

    legendaryMissileRouteCoverageIndexes(profile, samIndex, state) {
      let coverageIndexes = state.coverageIndexCache?.get(samIndex);
      if (coverageIndexes) return coverageIndexes;
      if (state.coverageRoute === null) {
        state.coverageRoute = this.legendaryMissileRouteCoverageRoute(
          state.path,
          state.fromTile,
          state.targetTile,
          state.launchOffset,
          state.targetableIndexesOverride,
        );
      }
      coverageIndexes = this.legendarySamPathCoverageIndicesForRoute(
        profile,
        state.coverageRoute,
        profile.level,
