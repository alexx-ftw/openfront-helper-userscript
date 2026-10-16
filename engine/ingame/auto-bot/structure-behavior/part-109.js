    localNearbyStructures(game, tile) {
      {
        return game.nearbyUnits(
          tile,
          LOCAL_STRUCTURE_SEARCH_RADIUS * 2,
          STRUCTURES_TYPES,
          undefined,
          true,
        );
      }
    }

    localOwnedStructureTiles(game, tile, mySid) {
      const radiusSquared = LOCAL_STRUCTURE_SEARCH_RADIUS ** 2;
      const queue = [tile];
      const seen = new Set([tile]);
      const ownedNearbyTiles = [];
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        let insideRadius;
        {
          insideRadius =
            game.euclideanDistSquared(tile, current) < radiusSquared &&
            game.ownerID(current) === mySid;
        }
        if (!insideRadius) continue;
        ownedNearbyTiles.push(current);
        let neighbors;
        {
          neighbors = game.neighbors(current) || [];
        }
        for (const neighbor of neighbors) {
          if (seen.has(neighbor)) continue;
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
      return ownedNearbyTiles;
    }

    isLocallyStructureSpaced(game, candidate, nearbyUnits, minDistSquared) {
      for (const entry of nearbyUnits) {
        const unitTile = (entry?.unit ?? entry)?.tile?.();
        if (unitTile === null || unitTile === undefined) continue;
        {
          if (game.euclideanDistSquared(unitTile, candidate) < minDistSquared) {
            return false;
          }
        }
      }
      return true;
    }

    // Probe a stable unit list with bounded concurrency. Defensive upgrade
    // paths can have many SAMs once hostile silos appear; awaiting every worker
    // request serially turns a slow buildables worker into a visible game hang.
    // Results retain full input alignment; unprobed candidates stay null so
    // callers can index safely against the original unit list.
    async buildableForUnits(units, type, options = {}) {
      const rawCandidates = Array.isArray(units) ? units : [];
      const requestedMaxProbes = Number(options.maxProbes);
      const maxProbes = Number.isInteger(requestedMaxProbes)
        ? Math.max(
            1,
            Math.min(STRUCTURE_PLACEMENT_CANDIDATE_LIMIT, requestedMaxProbes),
          )
        : STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const candidates = rawCandidates.slice(0, maxProbes);
      if (candidates.length === 0) return [];
      const requestedConcurrency = Number(options.concurrency);
      const concurrency = Number.isInteger(requestedConcurrency)
        ? Math.max(1, Math.min(candidates.length, requestedConcurrency))
        : 1;
      const results = new Array(rawCandidates.length).fill(null);
      let nextIndex = 0;
      const probe = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= candidates.length) return;
          const unit = candidates[index];
          {
            const tile = unit?.tile?.();
            if (tile === null || tile === undefined) continue;
            if (this.tileInsideActiveHostileMissileImpact(tile)) continue;
            results[index] = await this.buildableFor(
              type,
              tile,
              options.timeoutMs,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: concurrency }, () => probe()),
      );
      return results;
    }

    // buildableFor — probe a single tile for one unit type. Returns the matching
    // BuildableUnit ({type, canBuild, canUpgrade, cost}) or null. Worker call is
    // wrapped in withTimeout. (Shared by build + upgrade + defense-post probes.)
    async buildableFor(type, tile, timeoutMs = null) {
      const defaultWorkerTimeoutMs = STRUCTURE_PROBE_TIMEOUT_MS;
      const timeout = Number.isFinite(Number(timeoutMs))
        ? Math.max(1, Number(timeoutMs))
        : defaultWorkerTimeoutMs;
      const buildables = await withTimeout(
        this.player.buildables(tile, [type]),
        timeout,
        null,
      );
      return Array.isArray(buildables)
        ? buildables.find((b) => b.type === type) ?? null
        : null;
    }

    // Port policy: unlike the broader shared-water predicate used by economic
    // planning, a port may only be placed on a shore bordering the canonical
    // open-ocean component. game.isOcean is supplied by the game and identifies
    // the largest connected navigable water surface; isolated lakes and smaller
    // closed seas therefore cannot produce port candidates.
    isOceanPortTile(tile) {
      const game = this.game;
      if (
        game == null ||
        typeof game.isShore !== "function" ||
        typeof game.isWater !== "function" ||
        typeof game.isOcean !== "function" ||
        typeof game.neighbors !== "function"
      ) {
        return false;
      }
      {
        if (!game.isShore(tile)) return false;
        for (const neighbor of game.neighbors(tile) || []) {
          if (game.isWater(neighbor) && game.isOcean(neighbor)) return true;
        }
      }
      return false;
    }

    oceanPortBorderTiles() {
      // gameApi derives this exact open-ocean subset once per cached border
      // snapshot and shares it with the naval planner. Reclassifying every
      // border tile here repeats terrain/neighbor reads whenever Auto-build
      // runs, which becomes expensive on mature frontiers. Keep the local
      // fallback for older page bundles that do not expose the cached adapter.
      if (typeof this.player?.oceanShoreBorderTiles === "function") {
        const oceanPortTiles = this.player.oceanShoreBorderTiles();
        if (Array.isArray(oceanPortTiles)) return oceanPortTiles;
      }
      if (typeof this.player?.borderTiles !== "function") return [];
      const borderTiles = this.player.borderTiles();
      if (this._oceanPortBorderSnapshot === borderTiles) {
        return this._oceanPortBorderTiles || [];
      }
      const oceanPortTiles = [];
      for (const tile of borderTiles) {
        if (this.isOceanPortTile(tile)) oceanPortTiles.push(tile);
      }
