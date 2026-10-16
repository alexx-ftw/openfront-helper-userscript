    invalidateLegendaryMissilePlacementBaseContext() {
      this._legendaryMissilePlacementBaseContextTick = null;
      this._legendaryMissilePlacementBaseContextGame = null;
      this._legendaryMissilePlacementBaseContextConfig = null;
      this._legendaryMissilePlacementBaseContextCache = null;
    }

    legendaryMissileTargetCandidates(
      structures,
      enemySilos,
      radius,
      totalValue,
      {
        structureValues = null,
        structureTiles = null,
        entryCache = null,
        orderingCache = null,
      } = {},
    ) {
      const radiusSquared = Math.max(0, Number(radius) || 0) ** 2;
      const valueOf = (unit) =>
        structureValues?.get(unit) ?? this.legendaryCriticalStructureValue(unit);
      let entries = entryCache?.get(radiusSquared);
      if (entries === undefined) {
        entries = this.legendaryMissileTargetEntries(
          structures,
          radiusSquared,
          totalValue,
          valueOf,
          structureTiles,
        );
        entryCache?.set(radiusSquared, entries);
      }

      const limit = Math.min(LEGENDARY_MAX_MISSILE_TARGETS, entries.length);
      if (entries.length <= limit) return entries;

      let orderings = orderingCache?.get(radiusSquared);
      if (orderings === undefined) {
        const byExposure = this.legendaryTopMissileTargets(
          entries,
          limit,
          (left, right) =>
            right.exposedValue - left.exposedValue ||
            right.exposedStructures - left.exposedStructures,
        );
        const byValue = this.legendaryTopMissileTargets(
          entries,
          limit,
          (left, right) =>
            valueOf(right.target) - valueOf(left.target) ||
            right.exposedValue - left.exposedValue,
        );
        orderings = { byExposure, byValue };
        orderingCache?.set(radiusSquared, orderings);
      }
      return this.legendarySelectMissileTargets(
        entries,
        orderings.byExposure,
        orderings.byValue,
        enemySilos,
        limit,
      );
    }

    legendaryTopMissileTargets(entries, limit, compare) {
      if (limit <= 0) return [];
      const top = [];
      for (const entry of entries) {
        let insertionIndex = 0;
        while (
          insertionIndex < top.length &&
          compare(top[insertionIndex], entry) <= 0
        ) {
          insertionIndex++;
        }
        if (insertionIndex >= limit) continue;
        top.splice(insertionIndex, 0, entry);
        if (top.length > limit) top.pop();
      }
      return top;
    }

    legendaryMissileTargetEntries(
      structures,
      radiusSquared,
      totalValue,
      valueOf,
      structureTiles,
    ) {
      const structureList = structures || [];
      const entries = Array.isArray(structureList)
        ? structureList.slice(0, 0)
        : [];
      const spatialIndex = this.legendaryMissileTargetSpatialIndex(
        structureList,
        structureTiles,
        radiusSquared,
      );
      for (const target of structureList) {
        let spatialCandidates = null;
        if (spatialIndex) {
          const targetTile =
            structureTiles?.get(target) ?? target?.tile?.();
          spatialCandidates =
            targetTile === null || targetTile === undefined
              ? []
              : this.legendaryMissileTargetSpatialCandidates(
                  spatialIndex,
                  targetTile,
                );
        }
        const entry = this.legendaryMissileTargetEntry(
          target,
          structures,
          radiusSquared,
          totalValue,
          { valueOf, structureTiles, spatialCandidates },
        );
        if (entry !== null) entries.push(entry);
      }
      return entries;
    }

    legendaryMissileTargetSpatialIndex(
      structures,
      structureTiles,
      radiusSquared,
    ) {
      const game = this.game;
      if (
        typeof game?.x !== "function" ||
        typeof game?.y !== "function"
      ) {
        return null;
      }
      const radius = Math.sqrt(radiusSquared);
      if (!Number.isFinite(radius)) return null;
      const cellSize = Math.max(1, radius);
      const buckets = new Map();
      const index = { buckets, cellSize };
      for (const unit of structures) {
        if (
          !this.legendaryAddMissileTargetSpatialUnit(
            index,
            unit,
            structureTiles,
          )
        ) {
          return null;
        }
      }
      return index;
    }

    legendaryAddMissileTargetSpatialUnit(index, unit, structureTiles) {
      const tile = structureTiles?.get(unit) ?? unit?.tile?.();
      if (tile === null || tile === undefined) return false;
      const x = Number(this.game.x(tile));
      const y = Number(this.game.y(tile));
