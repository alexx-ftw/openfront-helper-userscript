        structures, bounds, fingerprint,
      })) return null;
      return {
        game,
        width,
        height,
        mySid,
        valueFunction,
        borderTiles,
        structures,
        bounds,
        fingerprint,
        minDistSquared: structureMinDist * structureMinDist,
      };
    }

    economicPlacementScanState(type, options) {
      if (!(this._economicPlacementScans instanceof Map)) {
        this._economicPlacementScans = new Map();
      }
      const key = String(type);
      const existing = this._economicPlacementScans.get(key);
      if (existing) {
        if (this.economicPlacementFingerprint(type) === existing.context.fingerprint) {
          return existing;
        }
        this.clearEconomicPlacementScan(type);
      }
      const context = this.economicPlacementScanContext(type, options);
      if (context === null) return null;
      const scan = {
        context,
        x: context.bounds.minX,
        y: context.bounds.minY,
        index: 0,
        hasGeometricSpace: false,
        bestTile: null,
        bestValue: -Infinity,
        snappedSites: new Set(),
        candidates: [],
        probeFailures: new Map(),
      };
      this._economicPlacementScans.set(key, scan);
      return scan;
    }

    hasPendingEconomicPlacementScan(type) {
      const scan = this._economicPlacementScans?.get(String(type));
      if (scan === undefined) return false;
      if (this.economicPlacementFingerprint(type) === scan.context.fingerprint) {
        return true;
      }
      this.clearEconomicPlacementScan(type);
      return false;
    }

    clearEconomicPlacementScan(type) {
      this._economicPlacementScans?.delete(String(type));
    }

    hasEconomicPlacementScanApi(type, game) {
      if (!ECONOMIC_STRUCTURE_TYPES.includes(type) || !game) return false;
      const methods = [
        "width", "height", "ref", "ownerID", "isValidCoord",
        "x", "y", "units", "euclideanDistSquared",
      ];
      return (
        methods.every((method) => typeof game[method] === "function") &&
        typeof this.player?.borderTiles === "function"
      );
    }

    economicPlacementContextIsValid(values) {
      return Boolean(
        Number.isInteger(values.width) &&
          values.width > 0 &&
          Number.isInteger(values.height) &&
          values.height > 0 &&
          values.mySid !== null &&
          values.mySid !== undefined &&
          typeof values.valueFunction === "function" &&
          Number.isFinite(values.structureMinDist) &&
          values.structureMinDist >= 0 &&
          Array.isArray(values.structures) &&
          values.bounds !== null &&
          values.fingerprint !== null,
      );
    }

    economicPlacementBounds(game, borderTiles, width, height) {
      if (!Array.isArray(borderTiles) || borderTiles.length === 0) return null;
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      for (const tile of borderTiles) {
        const x = Number(game.x(tile));
        const y = Number(game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      return {
        minX: Math.max(0, Math.floor(minX)),
        maxX: Math.min(width - 1, Math.ceil(maxX)),
        minY: Math.max(0, Math.floor(minY)),
        maxY: Math.min(height - 1, Math.ceil(maxY)),
      };
    }

    cachedEconomicPlacementFingerprint(type) {
      const tick = safeStructureGameTick(this.game);
      if (!Number.isFinite(tick)) return undefined;
      if (this._economicPlacementFingerprintTick !== tick) {
        this._economicPlacementFingerprintTick = tick;
        this._economicPlacementFingerprints = new Map();
      }
      return this._economicPlacementFingerprints?.get(String(type));
    }

    rememberEconomicPlacementFingerprint(type, fingerprint, topology) {
      if (!Number.isFinite(safeStructureGameTick(this.game))) return;
      this._economicPlacementFingerprints.set(String(type), {
        fingerprint,
        topology,
      });
    }

    hasEconomicPlacementFingerprintApi(game) {
      return Boolean(
        game &&
        typeof game.units === "function" &&
        typeof game.config === "function" &&
        typeof this.player?.borderTiles === "function",
      );
    }

    buildEconomicPlacementFingerprint(type, game) {
      const borderTiles = this.player.borderTiles();
      const borderTileCount = Number(
        borderTiles?.size ?? borderTiles?.length ?? 0,
      );
      const structures = structuresOfAllTypes(game);
      if (!Array.isArray(structures)) return null;
      const topology = this.economicPlacementTopology(type, borderTiles);
      const fingerprint = JSON.stringify({
        type,
        sid: this.player?.smallID?.(),
        tiles: Number(this.player?.numTilesOwned?.()),
        minDist: Number(game.config()?.structureMinDist?.()),
        borderTileCount,
        structureCount: structures.length,
        topology,
      });
      return fingerprint;
    }

    economicPlacementFingerprint(type) {
