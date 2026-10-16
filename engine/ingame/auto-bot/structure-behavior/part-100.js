      if (!(scan.candidates instanceof Array)) return null;
      for (const candidate of scan.candidates) {
        if (!this.economicPlacementProbeBackoffFor(scan, candidate.tile)) {
          scan.bestTile = candidate.tile;
          scan.bestValue = candidate.value;
          return candidate;
        }
      }
      return null;
    }

    recordEconomicPlacementProbeFailure(scan, tile) {
      if (!(scan.probeFailures instanceof Map)) scan.probeFailures = new Map();
      const previous = scan.probeFailures.get(tile);
      const tick = safeStructureGameTick(this.game);
      scan.probeFailures.set(tile, {
        attempts: (previous?.attempts ?? 0) + 1,
        retryNotBeforeTick: Number.isFinite(tick)
          ? tick + ECONOMIC_PLACEMENT_PROBE_RETRY_TICKS
          : null,
      });
      if (scan.candidates instanceof Array) {
        scan.candidates = scan.candidates.filter((candidate) => candidate.tile !== tile);
      }
      scan.bestTile = scan.candidates?.[0]?.tile ?? null;
      scan.bestValue = scan.candidates?.[0]?.value ?? -Infinity;
    }

    economicPlacementProbeBackoffFor(scan, tile) {
      const failure = scan.probeFailures?.get(tile);
      const tick = safeStructureGameTick(this.game);
      return Boolean(
        failure &&
          Number.isFinite(tick) &&
          Number.isFinite(failure.retryNotBeforeTick) &&
          tick < failure.retryNotBeforeTick,
      );
    }

    economicPlacementProbeBackoffActive(scan) {
      if (!(scan.probeFailures instanceof Map)) return false;
      for (const tile of scan.probeFailures.keys()) {
        if (this.economicPlacementProbeBackoffFor(scan, tile)) return true;
      }
      return false;
    }

    resetEconomicPlacementScanCursor(scan) {
      scan.x = scan.context.bounds.minX;
      scan.y = scan.context.bounds.minY;
      scan.index = 0;
      scan.candidates = [];
      scan.bestTile = null;
      scan.bestValue = -Infinity;
      scan.snappedSites = new Set();
    }

    advanceEconomicLandScan(scan) {
      scan.x++;
      if (scan.x <= scan.context.bounds.maxX) return;
      scan.x = scan.context.bounds.minX;
      scan.y++;
    }

    economicLandTileCandidate(type, context, x, y) {
      if (!context.game.isValidCoord(x, y)) return null;
      const tile = context.game.ref(x, y);
      if (context.game.ownerID(tile) !== context.mySid) return null;
      if (
        !this.isLocallyStructureSpaced(
          context.game,
          tile,
          context.structures,
          context.minDistSquared,
        )
      ) {
        return null;
      }
      if (this.isDangerousStructureTile(tile, type)) {
        return { tile, value: -Infinity };
      }
      const value = Number(context.valueFunction(tile));
      return { tile, value: Number.isFinite(value) ? value : -Infinity };
    }

  scanAllEconomicPortSpace(
    type,
    scan,
    limit = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
  ) {
      const { context } = scan;
      let visited = 0;
      while (
        scan.index < context.borderTiles.length &&
        visited < limit
      ) {
        const anchor = context.borderTiles[scan.index++];
        visited++;
        const candidate = this.economicPortAnchorCandidate(
          type,
          context,
          anchor,
          scan.snappedSites,
        );
        if (candidate.status === "indeterminate") return { ...candidate, visited };
        if (candidate.status !== "candidate") continue;
        scan.hasGeometricSpace = true;
        this.rememberEconomicPlacementCandidate(scan, {
          tile: anchor,
          value: candidate.value,
        });
      }
      if (scan.index < context.borderTiles.length) return { status: "pending", visited };
      const candidate = this.nextEconomicPlacementCandidate(scan);
      if (candidate !== null) return { status: "candidate", tile: candidate.tile, visited };
      if (scan.hasGeometricSpace) {
        if (this.economicPlacementProbeBackoffActive(scan)) {
          return { status: "indeterminate", retainScan: true, visited };
        }
        this.resetEconomicPlacementScanCursor(scan);
        return { status: "indeterminate", retainScan: true, visited };
      }
      return scan.hasGeometricSpace
        ? { status: "indeterminate", visited }
        : { status: "no-space", visited };
    }

    economicPortAnchorCandidate(type, context, anchor, snappedSites) {
      if (!this.isOceanPortTile(anchor)) return { status: "skip" };
      const snapped = this.localLandStructureSpawnTile(anchor);
      if (snapped === null) return { status: "indeterminate" };
      if (snapped === false || snappedSites.has(snapped)) {
        return { status: "skip" };
      }
      snappedSites.add(snapped);
      if (this.isDangerousStructureTile(snapped, type)) {
        return { status: "candidate", value: -Infinity };
      }
      const value = Number(context.valueFunction(anchor));
      return {
        status: "candidate",
        value: Number.isFinite(value) ? value : -Infinity,
      };
    }

    economicPlacementScanContext(type, options) {
      const game = this.game;
      if (!this.hasEconomicPlacementScanApi(type, game)) return null;
      const width = Number(game.width());
      const height = Number(game.height());
      const mySid = this.player?.smallID?.();
      const valueFunction = this.structureTileValueFunction(type, options);
      const config = game.config?.();
      const structureMinDist = Number(config?.structureMinDist?.());
      const borderTiles = Array.from(this.player.borderTiles());
      const structures = structuresOfAllTypes(game);
      const bounds = this.economicPlacementBounds(game, borderTiles, width, height);
      const fingerprint = this.economicPlacementFingerprint(type);
      if (!this.economicPlacementContextIsValid({
        width, height, mySid, valueFunction, structureMinDist,
