      this._oceanPortBorderSnapshot = borderTiles;
      this._oceanPortBorderTiles = oceanPortTiles;
      return oceanPortTiles;
    }

    hasOceanPortTiles() {
      return this.oceanPortBorderTiles().length > 0;
    }

    // Port placement sampler: ocean-classified shore tiles when they exist,
    // otherwise any shore border tile. Enclosed lakes (Baikal) have zero
    // ocean tiles under the client classification, which capped lake maps
    // at a single emergency Port regardless of candidate gating.
    portCandidateTiles(candidateLimit) {
      const oceanTiles = this.randCoastalTileArray(candidateLimit);
      if (oceanTiles.length > 0) return oceanTiles;
      return this.shoreBorderTileArray(candidateLimit);
    }

    // Goal requirement: never build a Port whose water body has no access to
    // open sea/ocean. A pond-locked shore tile wastes the slot (warships and
    // trade cannot operate) — openness is measured by the connected water
    // body's size (bounded flood fill, cached per water component), so large
    // enclosed lakes (Baikal) still qualify while tiny ponds never do.
    portTileHasOpenWaterAccess(tile) {
      if (this._portWaterOpennessCache === undefined) {
        this._portWaterOpennessCache = new Map();
      }
      // Key on the ADJACENT WATER component, not the land tile itself —
      // getWaterComponent returns null for land, so a land key would
      // re-flood for every distinct shore candidate instead of once per
      // water body.
      const waterTile = this.firstAdjacentWaterTile(tile);
      if (waterTile === null) return false;
      const component = this.game.getWaterComponent?.(waterTile) ?? waterTile;
      const cacheKey = String(component);
      const cached = this._portWaterOpennessCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const open = this.portAdjacentWaterIsOpen(tile);
      this._portWaterOpennessCache.set(cacheKey, open);
      return open;
    }

    firstAdjacentWaterTile(tile) {
      let waterTile = null;
      this.game.forEachNeighbor(tile, (neighbor) => {
        if (waterTile === null && this.game.isWater(neighbor)) {
          waterTile = neighbor;
        }
      });
      return waterTile;
    }

    portAdjacentWaterIsOpen(tile) {
      let waterTile = null;
      this.game.forEachNeighbor(tile, (neighbor) => {
        if (waterTile === null && this.game.isWater(neighbor)) {
          waterTile = neighbor;
        }
      });
      if (waterTile === null) return false;
      const visited = new Set([waterTile]);
      const queue = [waterTile];
      const maxTiles = 800;
      const openThreshold = 400;
      while (queue.length > 0 && visited.size < maxTiles) {
        const current = queue.shift();
        this.game.forEachNeighbor(current, (neighbor) => {
          if (visited.has(neighbor)) return;
          if (!this.game.isWater(neighbor)) return;
          visited.add(neighbor);
          if (visited.size < maxTiles) queue.push(neighbor);
        });
      }
      return visited.size >= openThreshold;
    }

    shoreBorderTileArray(limit) {
      const borderTiles = this.player?.borderTiles?.();
      if (!borderTiles) return [];
      const shoreTiles = [];
      for (const tile of borderTiles) {
        if (this.isShoreBorderTile(tile)) {
          shoreTiles.push(tile);
          if (shoreTiles.length >= limit * 4) break;
        }
      }
      return this.arraySample(shoreTiles, limit);
    }

    arraySample(source, limit) {
      if (source.length <= limit) return source;
      const sampled = [];
      const used = new Set();
      while (sampled.length < limit) {
        const index = this.random.nextInt(0, source.length);
        if (used.has(index)) continue;
        used.add(index);
        sampled.push(source[index]);
      }
      return sampled;
    }

    randCoastalTileArray(numTiles) {
      return Array.from(this.arraySampler(this.oceanPortBorderTiles(), numTiles));
    }

    // arraySampler — NationStructureBehavior.ts:854 (generator).
    *arraySampler(a, sampleSize) {
      if (a.length <= sampleSize) {
        // Return all elements
        yield* a;
      } else {
        // Sample uniformly without replacement.  The previous Set-based port
        // path copied every ocean-border tile, then randFromSet walked that
        // whole Set for each of the 25 picks. Mature coastlines consequently
        // made a Port decision synchronously O(border × candidates). A lazy
        // partial Fisher-Yates permutation is the same distribution while it
        // stores only the sampled indices: O(candidates) time and memory.
        const moved = new Map();
        for (let index = 0; index < sampleSize; index++) {
          const selectedIndex = this.random.nextInt(index, a.length);
          const selected = moved.get(selectedIndex) ?? selectedIndex;
          const replacement = moved.get(index) ?? index;
          moved.set(selectedIndex, replacement);
          yield a[selected];
        }
      }
    }

    // structureSpawnTileValue — NationStructureBehavior.ts:869.
    structureSpawnTileValue(type) {
      switch (type) {
        case UNIT.City:
          return this.cityValue();
        case UNIT.MissileSilo:
          return this.missileSiloValue();
        case UNIT.Factory:
          return this.factoryValue();
        case UNIT.Port:
          return this.portValue();
        case UNIT.SAMLauncher:
          return this.samLauncherValue();
        default:
          throw new Error(`Value function not implemented for ${type}`);
      }
    }

    legendaryStructureSpawnTileValue(type) {
      const baseValue = this.structureSpawnTileValue(type);
      const missileContext = this.getMissileDefenseContext();
      const spacing = this.spacingConstants().structureSpacing;
      const allyPlacementContext = this.legendaryAllyPlacementContext();
      const teamCenterContext = this.legendaryTeamCenterPlacementContext();
      const samCoverageContext =
        type === UNIT.SAMLauncher
          ? this.legendarySamCoveragePlacementContext()
          : null;
      // The hostile-center snapshot is reused across every candidate tile so
      // the offensive-reach term does not rescan the player roster per tile.
