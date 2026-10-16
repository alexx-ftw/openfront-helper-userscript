        type !== UNIT.SAMLauncher &&
        type !== UNIT.Port &&
        !profiledLegendaryFactory
      ) {
        tiles = this.prependSamCoveredTiles(tiles, candidateLimit);
      }
      return tiles;
    }

    prioritizeStructureCoverageTiles(tiles, candidateLimit, options) {
      if (options.activeMissileDefense === true) {
        tiles = this.prependActiveMissileRouteTiles(
          tiles,
          candidateLimit,
          options.missileDefenseContext,
        );
      }
      // Anchor the first SAM at the most valuable compact group before random fallback.
      tiles = this.prependCriticalSamClusterAnchors(tiles, candidateLimit);
      tiles = this.prependCriticalSamClusterTiles(tiles, candidateLimit);
      return this.uniqueOwnedStructureTiles(tiles);
    }

    // A City placed within three tiles of a live railway becomes a station and
    // splits that route. Random territory samples can miss every such site on
    // a large nation, even when the map visibly contains several rail hubs.
    // Visit junctions first, then endpoints, direct routes, and turns. This
    // gives the strongest commercial links first while still rotating through
    // every owned rail tile so long direct routes receive stations too.
    // Buildability remains the final authority over the exact tile. Keep the
    // original random draw before this enrichment so its deterministic stream
    // is unchanged.
    prependCommercialRailCityTiles(tiles, candidateLimit) {
      const railState = this.readRailroadState(this.game);
      const mySid = this.player?.smallID?.();
      if (
        !railState ||
        railState.length === 0 ||
        !Number.isFinite(Number(mySid)) ||
        typeof this.game?.ownerID !== "function"
      ) {
        return tiles;
      }
      const prioritizedRailTiles = this.commercialRailCityAnchorTilesForTick(railState, mySid);
      if (prioritizedRailTiles.length === 0) return tiles;

      // Do not let a generic territory sample compete with a known railway
      // anchor. The City scorer may legitimately choose between *rail* sites,
      // but when enough anchors exist every evaluated candidate must be one.
      const seedCount = Math.min(candidateLimit, prioritizedRailTiles.length);
      const offset =
        Number(this._commercialRailCityAnchorOffset ?? 0) % prioritizedRailTiles.length;
      const stride = Math.max(1, Math.floor(prioritizedRailTiles.length / seedCount));
      const railAnchors = [];
      for (let index = 0; index < seedCount; index++) {
        railAnchors.push(
          prioritizedRailTiles[(offset + index * stride) % prioritizedRailTiles.length],
        );
      }
      this._commercialRailCityAnchorOffset = (offset + 1) % prioritizedRailTiles.length;
      return Array.from(new Set(railAnchors.concat(tiles))).slice(0, candidateLimit);
    }

    commercialRailCityAnchorTilesForTick(railState, mySid) {
      const tick =
        typeof this.game?.ticks === "function" ? Number(this.game.ticks()) : Number.NaN;
      const cache = this._commercialRailCityAnchorCache;
      if (
        Number.isFinite(tick) &&
        cache?.tick === tick &&
        cache.railState === railState &&
        cache.mySid === mySid
      ) {
        return cache.tiles;
      }

      const railTiles = [];
      for (let tile = 0; tile < railState.length; tile++) {
        if (railState[tile] === 0 || this.game.ownerID(tile) !== mySid) continue;
        railTiles.push(tile);
      }
      const prioritizedRailTiles =
        railTiles.length === 0 ? [] : this.commercialRailCityAnchorTiles(railTiles, railState);
      if (Number.isFinite(tick)) {
        this._commercialRailCityAnchorCache = {
          tick,
          railState,
          mySid,
          tiles: prioritizedRailTiles,
        };
      }
      return prioritizedRailTiles;
    }

    commercialRailCityAnchorTiles(railTiles, railState) {
      const game = this.game;
      if (
        typeof game?.width !== "function" ||
        typeof game?.height !== "function" ||
        typeof game?.x !== "function" ||
        typeof game?.y !== "function" ||
        typeof game?.ref !== "function" ||
        typeof game?.isValidCoord !== "function"
      ) {
        return railTiles;
      }
      const prioritizedRailTiles = [];
      for (const tile of railTiles) {
        const shape = this.commercialRailTileConnectionShape(tile, railState);
        prioritizedRailTiles.push({
          tile,
          priority: this.commercialRailCityAnchorPriority(shape),
        });
      }
      prioritizedRailTiles.sort(
        (left, right) => left.priority - right.priority || left.tile - right.tile,
      );
      return prioritizedRailTiles.map(({ tile }) => tile);
    }

    commercialRailTileConnectionShape(tile, railState) {
      const game = this.game;
      const x = game.x(tile);
      const y = game.y(tile);
      const shape = { degree: 0, horizontal: 0, vertical: 0 };
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const neighborX = x + dx;
        const neighborY = y + dy;
        if (!game.isValidCoord(neighborX, neighborY)) continue;
        const neighbor = game.ref(neighborX, neighborY);
        if (railState[neighbor] === 0) continue;
        shape.degree += 1;
        if (dx !== 0) shape.horizontal += 1;
        else shape.vertical += 1;
      }
      return shape;
    }

    commercialRailCityAnchorPriority({ degree, horizontal, vertical }) {
      if (degree >= 3) return 0;
      if (degree === 1) return 1;
      if (degree === 2 && (horizontal === 2 || vertical === 2)) return 2;
      if (degree === 2 && horizontal === 1 && vertical === 1) return 3;
      return 4;
    }

    prependCriticalSamClusterTiles(tiles, candidateLimit) {
      const config = this.game?.config?.();
      const range = Number(config?.defaultSamRange?.());
      if (!Number.isFinite(range) || range <= 0) return tiles;
      const entries = this.samCriticalStructureEntries();
      if (entries.length === 0) return tiles;
      const rangeSquared = range * range;
      // Building tiles are useful geometric anchors but are normally occupied,
      // so they cannot themselves be a SAM site. Rank the legal placement
