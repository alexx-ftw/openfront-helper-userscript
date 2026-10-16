      // candidates by the same weighted core score instead. This puts the
      // first actual build probe in the centre of the costly clump rather than
      // repeatedly probing an occupied City/Factory and falling back to a
      // random peripheral tile.
      return tiles
        .map((tile, index) => ({
          tile,
          index,
          score: this.samCriticalCoverageScoreForEntries(
            tile,
            rangeSquared,
            entries,
          ),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, candidateLimit)
        .map((entry) => entry.tile);
    }

    prependCriticalSamClusterAnchors(tiles, candidateLimit) {
      const config = this.game?.config?.();
      const range = Number(config?.defaultSamRange?.());
      if (!Number.isFinite(range) || range <= 0) return tiles;
      const entries = this.samCriticalStructureEntries();
      if (entries.length === 0) return tiles;
      const rangeSquared = range * range;
      const anchorLimit = Math.min(3, candidateLimit);
      const anchors = entries
        .map((entry, index) => ({
          tile: entry.tile,
          index,
          score: this.samCriticalCoverageScoreForEntries(
            entry.tile,
            rangeSquared,
            entries,
          ),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, anchorLimit)
        .map((entry) => entry.tile);
      const seen = new Set();
      return anchors.concat(tiles).filter((tile) => {
        if (seen.has(tile)) return false;
        seen.add(tile);
        return true;
      }).slice(0, candidateLimit);
    }

    prependActiveMissileRouteTiles(tiles, candidateLimit, context) {
      const routeLimit = Math.max(1, Math.floor(candidateLimit / 2));
      const routeTiles = this.activeMirvCandidateTiles(context).slice(
        0,
        routeLimit,
      );
      const seen = new Set();
      for (const tile of routeTiles) seen.add(tile);
      for (const path of this.activeMissileRoutePaths(context)) {
        this.appendActiveMissilePathTiles(
          routeTiles,
          seen,
          path,
          routeLimit,
        );
        if (routeTiles.length >= routeLimit) break;
      }
      return routeTiles.concat(tiles).slice(0, candidateLimit);
    }

    activeMirvCandidateTiles(context) {
      if (
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function" ||
        typeof this.game.ref !== "function" ||
        typeof this.game.isValidCoord !== "function"
      ) return [];
      const candidates = [];
      const offsets = [
        [40, 0],
        [-40, 0],
        [0, 40],
        [0, -40],
        [28, 20],
        [-28, 20],
        [28, -20],
        [-28, -20],
      ];
      for (const demand of this.uncoveredActiveMirvDemands(context)) {
        const x = this.game.x(demand.targetTile);
        const y = this.game.y(demand.targetTile);
        for (const [dx, dy] of offsets) {
          if (!this.game.isValidCoord(x + dx, y + dy)) continue;
          const tile = this.game.ref(x + dx, y + dy);
          if (this.activeMissileRouteTileUsable(tile)) candidates.push(tile);
        }
      }
      return candidates;
    }

    activeMissileRoutePaths(context) {
      return (context?.threats || [])
        .filter((threat) => threat?.inFlight === true)
        .flatMap((threat) => threat.salvoPlan?.routes || [])
        .map((route) => route?.path)
        .filter(Array.isArray);
    }

    appendActiveMissilePathTiles(routeTiles, seen, path, candidateLimit) {
      for (let index = path.length - 1; index >= 0; index--) {
        const tile = path[index];
        if (tile === null || tile === undefined || seen.has(tile)) continue;
        if (!this.activeMissileRouteTileUsable(tile)) continue;
        seen.add(tile);
        routeTiles.push(tile);
        if (routeTiles.length >= candidateLimit) return;
      }
    }

    activeMissileRouteTileUsable(tile) {
      const mySid = this.readPlayerSmallId(this.player);
      if (
        mySid !== null &&
        typeof this.game.ownerID === "function" &&
        this.game.ownerID(tile) !== mySid
      ) {
        return false;
      }
      return !this.isDangerousStructureTile(tile, UNIT.SAMLauncher);
    }

    uniqueOwnedStructureTiles(tiles) {
      const mySid = this.readPlayerSmallId(this.player);
      const seen = new Set();
      return tiles.filter((tile) => {
        if (tile === null || tile === undefined || seen.has(tile)) return false;
        if (mySid !== null && typeof this.game.ownerID === "function") {
          {
            if (this.game.ownerID(tile) !== mySid) return false;
          }
        }
        seen.add(tile);
        return true;
      });
    }

    prependSamCoveredTiles(tiles, candidateLimit) {
      {
        const samTiles = this.tilesNearFriendlySams(candidateLimit);
        if (samTiles.length === 0) return tiles;
        const merged = [];
        const seen = new Set();
        for (const tile of samTiles.concat(tiles)) {
          if (merged.length >= candidateLimit) break;
          if (seen.has(tile)) continue;
          seen.add(tile);
          merged.push(tile);
        }
        return merged;
      }
    }

