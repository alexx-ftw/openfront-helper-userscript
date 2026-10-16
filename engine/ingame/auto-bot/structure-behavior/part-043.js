            pathTile,
            fromTile,
            targetTile,
            targetableRange,
          )
        ) {
          continue;
        }
        if (
          this.game.euclideanDistSquared(pathTile, samTile) <= rangeSquared
        ) {
          indexes.push(index);
        }
      }
      return indexes;
    }

    legendarySamCoverageProfile(samOrTile, levelOverride, rangeOverride = null) {
      if (samOrTile === null || samOrTile === undefined) return null;
      const samTile =
        typeof samOrTile.tile === "function"
          ? samOrTile.tile()
          : samOrTile.tile ?? samOrTile;
      if (samTile === null || samTile === undefined) return null;
      let rawLevel = samOrTile.level ?? 1;
      if (typeof samOrTile.level === "function") rawLevel = samOrTile.level();
      const level = Math.max(1, Number(levelOverride ?? rawLevel));
      {
        const range = this.legendarySamProfileRange(
          samOrTile,
          rawLevel,
          level,
          rangeOverride,
        );
        return range > 0 ? { samTile, range } : null;
      }
    }

    legendarySamProfileRange(samOrTile, rawLevel, level, rangeOverride) {
      if (rangeOverride !== null) return Number(rangeOverride);
      const cachedRange = Number(samOrTile.range);
      if (
        typeof samOrTile.level !== "function" &&
        Number.isFinite(cachedRange) &&
        level === Math.max(1, Number(rawLevel))
      ) {
        return cachedRange;
      }
      return this.legendarySamRange(level);
    }

    legendarySamPathInterceptTicks(samOrTile, route, levelOverride = null) {
      return this.legendaryInterceptTicksFromIndexes(
        this.legendarySamPathCoverageIndices(
          samOrTile,
          route.path,
          route.fromTile,
          route.targetTile,
          levelOverride,
        ),
        route.launchOffset,
      );
    }

    legendaryInterceptTicksFromIndexes(indexes, launchOffset) {
      const offset = Math.max(0, Number(launchOffset) || 0);
      const ticks = new Array(indexes.length);
      for (let index = 0; index < indexes.length; index++) {
        if (index in indexes) ticks[index] = offset + indexes[index];
      }
      return ticks;
    }

    legendarySamMissileSpeed() {
      const speed = Number(this.game.config().defaultSamMissileSpeed?.());
      return Number.isFinite(speed) && speed > 0 ? speed : 2;
    }

    legendarySamInterceptionOpportunities(profile, coverageIndexes, state) {
      const fireTicks = [];
      const interceptionTicks = [];
      const seenFireTicks = new Set();
      const launchOffset = Math.max(0, Number(state.launchOffset) || 0);
      const speed = this.legendarySamMissileSpeed();
      const lastInterceptableIndex = state.path.length - 2;
      const addOpportunity = (index) => {
        if (index < 0 || index > lastInterceptableIndex) return;
        const interceptionTick = launchOffset + index;
        const distance =
          typeof this.game.manhattanDist === "function"
            ? this.game.manhattanDist(profile.tile, state.path[index])
            : Math.sqrt(
                this.game.euclideanDistSquared(
                  profile.tile,
                  state.path[index],
                ),
              );
        const travelTicks = Math.ceil(
          distance / speed,
        );
        const fireTick = interceptionTick - travelTicks;
        if (fireTick < launchOffset || seenFireTicks.has(fireTick)) return;
        seenFireTicks.add(fireTick);
        fireTicks.push(fireTick);
        interceptionTicks.push(interceptionTick);
      };
      for (const index of coverageIndexes) {
        addOpportunity(index);
      }

      // SAMLauncherExecution cannot intercept on the detonation tick. When
      // the terminal explosion tile itself is targetable and in SAM range,
      // the engine makes one final attempt against the preceding in-flight
      // tile, even when that tile is outside the SAM's geometric range.
      const finalIndex = state.path.length - 1;
      const penultimateIndex = finalIndex - 1;
      const targetableIndexes =
        state.targetableIndexes ??
        state.coverageRoute?.targetableIndexes ??
        state.targetableIndexesOverride;
      if (
        coverageIndexes.includes(finalIndex) &&
        Array.isArray(targetableIndexes) &&
        targetableIndexes.includes(penultimateIndex)
      ) {
        addOpportunity(penultimateIndex);
      }
      return { fireTicks, interceptionTicks };
    }

    legendarySamPathCoverageIndicesForRoute(
      samOrTile,
      route,
      levelOverride = null,
      coverageProfile = null,
    ) {
      if (!Array.isArray(route?.targetableIndexes)) {
        return this.legendarySamPathCoverageIndices(
          samOrTile,
          route?.path,
          route?.fromTile,
          route?.targetTile,
          levelOverride,
        );
      }
      const profile =
        coverageProfile ??
        this.legendarySamCoverageProfile(samOrTile, levelOverride);
      if (profile === null) return [];
      const { samTile, range } = profile;
      if (range <= 0) return [];
      const rangeSquared = range * range;
      const indexes = [];
      for (const index of route.targetableIndexes) {
        if (
          this.game.euclideanDistSquared(route.path[index], samTile) <=
          rangeSquared
        ) {
          indexes.push(index);
        }
