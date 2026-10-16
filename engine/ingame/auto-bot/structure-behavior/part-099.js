        emergency?.recoverySam === true &&
        safeScored.length > scored.length
      );
    }

    shouldUseSafeSamReconstructionFallback(type, options, scored) {
      return (
        type === UNIT.SAMLauncher &&
        options.prioritizeStructureCoverage === true &&
        scored.length === 0 &&
        this.activeHostileMissileImpactZones().length > 0
      );
    }

    samProtectableStructureTiles() {
      // Use the same player snapshot as samCriticalStructureEntries and the
      // placement probes.  `game.players()` can expose a different wrapper
      // generation from `this.player` during a client update; mixing them made
      // the coverage filter demand a stale clump that candidate anchoring could
      // not see, rejecting every otherwise-safe tile. Friendly SAMs still
      // influence economic placement elsewhere, but our launcher protects our
      // own expensive core.
      if (typeof this.player?.units !== "function") return null;
      return new Set(this.samPlayerProtectableStructureTiles(this.player));
    }

    samPlayerProtectableStructureTiles(owner) {
      const protectedTiles = [];
      for (const type of SAM_PROTECTABLE_STRUCTURE_TYPES) {
        for (const structure of owner.units(type) || []) {
          const tile = structure?.tile?.();
          if (tile !== null && tile !== undefined) protectedTiles.push(tile);
        }
      }
      return protectedTiles;
    }

    samPlacementProtectsStructure(tile, protectedTiles) {
      if (protectedTiles === null) return true;
      // A first SAM must still be placeable after an economy has been wiped
      // out.  There is no expensive clump to centre on in that state, but an
      // external Silo is still an immediate strategic threat; let the normal
      // ranked legal-tile probe establish the defensive foothold instead of
      // filtering every candidate out.
      if (protectedTiles.size === 0) return true;
      const config = this.game.config();
      const range = Math.max(
        0,
        Number(config.samRange?.(1) ?? config.defaultSamRange?.() ?? 0),
      );
      if (range <= 0) return false;
      const rangeSquared = range * range;
      for (const structureTile of protectedTiles) {
        if (this.game.euclideanDistSquared(tile, structureTile) <= rangeSquared) {
          return true;
        }
      }
      return false;
    }

    /**
     * A bounded random placement miss cannot authorize an economic upgrade.
     * Enumerate the complete map incrementally and inspect every owned tile
     * with the same local spacing primitives used by the authoritative
     * placement reconstruction. One planner decision performs at most the
     * upstream 25-candidate placement budget; later decisions resume the same
     * snapshot. Only zero geometrically legal sites across a completed,
     * unchanged scan proves that space is exhausted. Any missing API,
     * unsafe-only site, or failed authoritative probe remains indeterminate.
     */
    async findEconomicPlacementOrExhaustion(type, options = {}) {
      const scan = this.economicPlacementScanState(type, options);
      if (scan === null) return { status: "indeterminate" };
      const scanLimit = this.economicPlacementBudgetLimit(
        STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
      );
      if (scanLimit < 1) return { status: "indeterminate" };

      const scanResult =
        type === UNIT.Port
          ? this.scanAllEconomicPortSpace(type, scan, scanLimit)
          : this.scanAllLandEconomicSpace(type, scan, scanLimit);
      this.consumeEconomicPlacementBudget(scanResult.visited || 0);
      if (scanResult.status === "pending") return { status: "indeterminate" };
      if (scanResult.status !== "candidate") {
        if (
          scanResult.status === "no-space" &&
          this.economicPlacementFingerprint(type) === scan.context.fingerprint
        ) {
          this.clearEconomicPlacementScan(type);
          return scanResult;
        }
        if (scanResult.retainScan === true) return { status: "indeterminate" };
        this.clearEconomicPlacementScan(type);
        return { status: "indeterminate" };
      }
      const buildable = await this.buildableFor(
        type,
        scanResult.tile,
        this.structureProbeOptions(options).probeTimeoutMs,
      );
      if (!this.isUsableStructureBuildable(buildable, scanResult.tile, type)) {
        this.recordEconomicPlacementProbeFailure(scan, scanResult.tile);
        return { status: "indeterminate" };
      }
      this.clearEconomicPlacementScan(type);
      return { status: "buildable", buildable };
    }

  scanAllLandEconomicSpace(
    type,
    scan,
    limit = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
  ) {
      const { context } = scan;
      let visited = 0;
      while (
        scan.y <= context.bounds.maxY &&
        visited < limit
      ) {
        const x = scan.x;
        const y = scan.y;
        this.advanceEconomicLandScan(scan);
        visited++;
        const candidate = this.economicLandTileCandidate(type, context, x, y);
        if (candidate === null) continue;
        scan.hasGeometricSpace = true;
        this.rememberEconomicPlacementCandidate(scan, candidate);
      }

      if (scan.y <= context.bounds.maxY) return { status: "pending", visited };
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

    rememberEconomicPlacementCandidate(scan, candidate) {
      if (!Number.isFinite(Number(candidate?.value))) return;
      if (this.economicPlacementProbeBackoffFor(scan, candidate.tile)) return;
      if (!(scan.candidates instanceof Array)) scan.candidates = [];
      if (scan.candidates.some((entry) => entry.tile === candidate.tile)) return;
      scan.candidates.push({ tile: candidate.tile, value: Number(candidate.value) });
      scan.candidates.sort((left, right) => right.value - left.value);
      if (scan.candidates.length > STRUCTURE_PLACEMENT_CANDIDATE_LIMIT) {
        scan.candidates.length = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      }
      scan.bestTile = scan.candidates[0]?.tile ?? null;
      scan.bestValue = scan.candidates[0]?.value ?? -Infinity;
    }

    nextEconomicPlacementCandidate(scan) {
