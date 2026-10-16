        );
      }
      const targetableRange = this.legendaryTrajectoryTargetableRange();
      const cache = this.legendaryTrajectoryTargetableIndexesCache();
      const cached = cache?.get(path);
      if (
        cached?.fromTile === fromTile &&
        cached?.targetTile === targetTile &&
        cached.targetableRange === targetableRange
      ) {
        return cached.indexes;
      }
      const indexes = this.legendaryTrajectoryTargetableIndexes(
        path,
        fromTile,
        targetTile,
        targetableRange,
      );
      cache?.set(path, {
        fromTile,
        targetTile,
        targetableRange,
        indexes,
      });
      return indexes;
    }

    legendaryTrajectoryTileTargetable(
      pathTile,
      fromTile,
      targetTile,
      targetableRange = null,
    ) {
      const range = targetableRange ?? this.legendaryTrajectoryTargetableRange();
      if (range <= 0) return true;
      const rangeSquared = range * range;
      return (
        this.game.euclideanDistSquared(pathTile, fromTile) < rangeSquared ||
        this.game.euclideanDistSquared(pathTile, targetTile) < rangeSquared
      );
    }

    legendaryTrajectoryTargetableIndexes(
      path,
      fromTile,
      targetTile,
      targetableRangeOverride = null,
    ) {
      const targetableRange =
        targetableRangeOverride ?? this.legendaryTrajectoryTargetableRange();
      const indexes = [];
      for (let index = 0; index < path.length; index++) {
        if (
          this.legendaryTrajectoryTileTargetable(
            path[index],
            fromTile,
            targetTile,
            targetableRange,
          )
        ) {
          indexes.push(index);
        }
      }
      return indexes;
    }

    legendaryTrajectoryTargetableBounds(path, targetableIndexes) {
      if (
        !Array.isArray(targetableIndexes) ||
        targetableIndexes.length === 0 ||
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return null;
      }
      const bounds = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      };
      for (const index of targetableIndexes) {
        const tile = path[index];
        const x = Number(this.game.x(tile));
        const y = Number(this.game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
      return bounds;
    }

    legendarySamPathCoverageIndex(
      samOrTile,
      path,
      fromTile,
      targetTile,
      levelOverride = null,
    ) {
      if (
        samOrTile === null ||
        samOrTile === undefined ||
        !Array.isArray(path) ||
        path.length === 0
      ) {
        return -1;
      }
      const samTile =
        typeof samOrTile.tile === "function" ? samOrTile.tile() : samOrTile;
      if (samTile === null || samTile === undefined) return -1;
      const level = Math.max(
        1,
        Number(
          levelOverride ??
            (typeof samOrTile.level === "function" ? samOrTile.level() : 1),
        ),
      );
      let readySlots = level;
      if (typeof samOrTile.tile === "function") {
        readySlots = this.legendarySamReadySlots(samOrTile, levelOverride);
      }
      if (readySlots <= 0) return -1;
      return (
        this.legendarySamPathCoverageIndices(
          samOrTile,
          path,
          fromTile,
          targetTile,
          levelOverride,
        )[0] ?? -1
      );
    }

    // Geometry-only coverage. Unlike legendarySamPathCoverageIndex this keeps
    // a SAM whose missiles are reloading in the route, because the schedule
    // must decide whether it becomes ready before a later incoming missile.
    legendarySamPathCoverageIndices(
      samOrTile,
      path,
      fromTile,
      targetTile,
      levelOverride = null,
    ) {
      if (!Array.isArray(path) || path.length === 0) return [];
      const profile = this.legendarySamCoverageProfile(
        samOrTile,
        levelOverride,
      );
      if (profile === null) return [];
      const { samTile, range } = profile;
      if (range <= 0) return [];
      const rangeSquared = range * range;
      const targetableRange = this.legendaryTrajectoryTargetableRange();
      const indexes = [];
      for (let index = 0; index < path.length; index++) {
        const pathTile = path[index];
        if (
          !this.legendaryTrajectoryTileTargetable(
