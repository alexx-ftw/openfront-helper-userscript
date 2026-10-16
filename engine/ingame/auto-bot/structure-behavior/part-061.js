      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const key = `${Math.floor(x / index.cellSize)},${Math.floor(
        y / index.cellSize,
      )}`;
      let bucket = index.buckets.get(key);
      if (!bucket) {
        bucket = [];
        index.buckets.set(key, bucket);
      }
      bucket.push(unit);
      return true;
    }

    legendaryMissileTargetSpatialCandidates(index, tile) {
      const x = Number(this.game.x(tile));
      const y = Number(this.game.y(tile));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      const cellX = Math.floor(x / index.cellSize);
      const cellY = Math.floor(y / index.cellSize);
      const candidates = [];
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          const bucket = index.buckets.get(
            `${cellX + offsetX},${cellY + offsetY}`,
          );
          if (!bucket) continue;
          candidates.push(...bucket);
        }
      }
      return candidates;
    }

    legendaryMissileTargetEntry(
      target,
      structures,
      radiusSquared,
      totalValue,
      {
        valueOf = (unit) => this.legendaryCriticalStructureValue(unit),
        structureTiles = null,
        spatialCandidates = null,
      } = {},
    ) {
      const tileOf = (unit) => structureTiles?.get(unit) ?? unit?.tile?.();
      const targetTile = tileOf(target);
      if (targetTile === null || targetTile === undefined) return null;
      let exposedValue = valueOf(target);
      let exposedStructures = 1;
      const candidates = spatialCandidates ?? structures ?? [];
      for (const other of candidates) {
        if (other === target) continue;
        {
          const otherTile = tileOf(other);
          if (
            this.game.euclideanDistSquared(targetTile, otherTile) <=
            radiusSquared
          ) {
            exposedValue += valueOf(other);
            exposedStructures++;
          }
        }
      }
      return {
        target,
        tile: targetTile,
        exposedValue,
        exposedStructures,
        exposure: totalValue > 0 ? Math.min(1, exposedValue / totalValue) : 0,
      };
    }

    legendarySelectMissileTargets(
      entries,
      byExposure,
      byValue,
      enemySilos,
      limit,
    ) {
      const selected = [];
      const selectedEntries = new Set();
      const exposureCount = Math.max(8, Math.ceil(limit * 0.6));
      const valueCount = Math.max(4, Math.floor(limit * 0.25));
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        byExposure,
        limit,
        exposureCount,
      );
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        byValue,
        limit,
        valueCount,
      );
      const nearest = [];
      for (const silo of enemySilos || []) {
        const entry = this.nearestLegendaryMissileTarget(silo, entries);
        if (entry !== null) nearest.push(entry);
      }
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        nearest,
        limit,
      );
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        byExposure,
        limit,
      );
      return selected;
    }

    appendUniqueMissileTargets(
      selected,
      seen,
      candidates,
      limit,
      candidateLimit = candidates.length,
    ) {
      const count = Math.min(candidates.length, candidateLimit);
      for (let index = 0; index < count; index++) {
        const entry = candidates[index];
        if (selected.length >= limit) return;
        if (seen.has(entry)) continue;
        seen.add(entry);
        selected.push(entry);
      }
    }

    nearestLegendaryMissileTarget(silo, entries) {
      let nearest = null;
      let nearestDistance = Infinity;
      const siloTile = silo.tile();
      for (const entry of entries) {
        {
          const distance = this.game.manhattanDist(siloTile, entry.tile);
          if (distance >= nearestDistance) continue;
          nearest = entry;
          nearestDistance = distance;
        }
      }
      return nearest;
    }

    legendaryMissilePlacementContext() {
      const base = this.legendaryMissilePlacementBaseContext();
      const {
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        structures,
        structureValues,
        structureTiles,
        launchMetadataCache,
        totalValue,
