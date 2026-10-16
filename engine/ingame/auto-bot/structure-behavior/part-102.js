      const cached = this.cachedEconomicPlacementFingerprint(type);
      if (cached !== undefined) {
        const topology = this.economicPlacementTopology(
          type,
          this.player?.borderTiles?.(),
        );
        if (
          topology !== null &&
          cached.topology !== null &&
          topology.border === cached.topology.border &&
          topology.ocean === cached.topology.ocean
        ) {
          return cached.fingerprint;
        }
      }
      const game = this.game;
      if (!this.hasEconomicPlacementFingerprintApi(game)) return null;
      const fingerprint = this.buildEconomicPlacementFingerprint(type, game);
      if (fingerprint === null) return null;
      this.rememberEconomicPlacementFingerprint(
        type,
        fingerprint,
        this.economicPlacementTopology(type, this.player.borderTiles()),
      );
      return fingerprint;
    }

    economicPlacementTopology(type, borderTiles) {
      if (!Number.isFinite(safeStructureGameTick(this.game))) return null;
      const border = this.economicPlacementSnapshotId(borderTiles);
      if (border === null) return null;
      let ocean = null;
      if (
        type === UNIT.Port &&
        typeof this.player?.oceanShoreBorderTiles === "function"
      ) {
        ocean = this.economicPlacementSnapshotId(
          this.player.oceanShoreBorderTiles(),
        );
      }
      return { border, ocean };
    }

    economicPlacementSnapshotId(snapshot) {
      if (snapshot === null || snapshot === undefined) return null;
      const kind = typeof snapshot;
      if (kind !== "object" && kind !== "function") return `${kind}:${snapshot}`;
      let id = ECONOMIC_PLACEMENT_SNAPSHOT_IDS.get(snapshot);
      if (id === undefined) {
        id = nextEconomicPlacementSnapshotId++;
        ECONOMIC_PLACEMENT_SNAPSHOT_IDS.set(snapshot, id);
      }
      const geometry = this.economicPlacementSnapshotGeometry(snapshot);
      return geometry === null ? id : `${id}:${geometry}`;
    }

    economicPlacementSnapshotGeometry(snapshot) {
      if (snapshot === null || snapshot === undefined) return null;
      const kind = typeof snapshot;
      if (kind !== "object" && kind !== "function") return null;

      const tick = safeStructureGameTick(this.game);
      let geometryCache = this._economicPlacementSnapshotGeometryCache;
      if (
        !geometryCache ||
        typeof geometryCache.get !== "function" ||
        typeof geometryCache.set !== "function"
      ) {
        geometryCache = new WeakMap();
        this._economicPlacementSnapshotGeometryCache = geometryCache;
      }
      const cached = geometryCache.get(snapshot);
      if (cached?.tick === tick) return cached.fingerprint;

      const tag = Object.prototype.toString.call(snapshot);
      if (tag !== "[object Set]" && !Array.isArray(snapshot)) return null;

      let hash = 2166136261;
      let count = 0;
      for (const tile of snapshot) {
        count++;
        const encoded = String(tile);
        for (let index = 0; index < encoded.length; index++) {
          hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619);
        }
        hash = Math.imul(hash ^ 0xff, 16777619);
      }
      const fingerprint = `${count}:${hash >>> 0}`;
      if (Number.isFinite(tick)) {
        geometryCache.set(snapshot, {
          tick,
          fingerprint,
        });
      }
      return fingerprint;
    }

    compareStructurePlacementScores(left, right) {
      if (left.compactness !== null && right.compactness !== null) {
        // Blast separation outranks umbrella clustering for the missile
        // structures: shared SAM coverage is worthless when one hydrogen
        // connects on both tiles at once. Other types never set the field.
        const blastDifference =
          (left.compactness.missileBlastColocationPenalty ?? 0) -
          (right.compactness.missileBlastColocationPenalty ?? 0);
        if (blastDifference !== 0) return blastDifference;
        const samCoverageDifference = this.compareSamCoverageExpansion(
          left.compactness,
          right.compactness,
        );
        if (samCoverageDifference !== 0) return samCoverageDifference;
        const samProtectionDifference = this.compareSamProtectionScores(
          left.compactness,
          right.compactness,
        );
        if (samProtectionDifference !== 0) return samProtectionDifference;
        const sharedCoverageDifference =
          right.compactness.sharedSamCoverage -
          left.compactness.sharedSamCoverage;
        if (sharedCoverageDifference !== 0) return sharedCoverageDifference;
      }
      return right.v - left.v;
    }

    // SAM placement compares the incremental umbrella before the shared
    // economic-protection axes; other types never set these fields.
    compareSamCoverageExpansion(left, right) {
      if (
        left.samIncrementalCoverage === undefined &&
        right.samIncrementalCoverage === undefined
      ) {
        return 0;
      }
      const incrementalDifference =
        (right.samIncrementalCoverage ?? 0) -
        (left.samIncrementalCoverage ?? 0);
      if (incrementalDifference !== 0) return incrementalDifference;
      return (left.samDuplicateCoverage ?? 0) - (right.samDuplicateCoverage ?? 0);
    }

    compareSamProtectionScores(left, right) {
      const coverageDifference =
        right.existingSamCoverage - left.existingSamCoverage;
      if (coverageDifference !== 0) return coverageDifference;
      if (left.existingSamCoverage > 0 && right.existingSamCoverage > 0) {
        const currentDistanceDifference =
          left.currentSamDistanceSquared - right.currentSamDistanceSquared;
        if (currentDistanceDifference !== 0) return currentDistanceDifference;
      }
      const upgradeCoverageDifference =
        right.upgradeSamCoverage - left.upgradeSamCoverage;
      if (upgradeCoverageDifference !== 0) return upgradeCoverageDifference;
      if (left.upgradeSamCoverage <= 0 || right.upgradeSamCoverage <= 0) return 0;
      return left.samDistanceSquared - right.samDistanceSquared;
    }

    rankStructureTilesBySamProtection(tiles, type) {
      const compactness = this.structurePlacementCompactnessRanker(type);
      if (compactness === null) return tiles;
      return tiles
