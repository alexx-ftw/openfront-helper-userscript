        }
        return {
          existingSamCoverage: 0,
          upgradeSamCoverage: 0,
          currentSamDistanceSquared: Number.POSITIVE_INFINITY,
          samDistanceSquared: Number.POSITIVE_INFINITY,
          sharedSamCoverage: 0,
          samIncrementalCoverage,
          samDuplicateCoverage,
          missileBlastColocationPenalty:
            blastColocation === null ? 0 : blastColocation(tile),
        };
      };
    }

    // A hydrogen blast's inner radius (80 tiles by default) erases every
    // missile structure clustered inside it. Once a hostile has actually
    // launched, prefer sites where one leaking warhead cannot take out two of
    // our expensive silo/SAM tiles. The penalty fades linearly to zero at the
    // blast edge, so "inside the SAM umbrella but outside one blast footprint"
    // still beats both a clustered tile and an undefended far corner. Returns
    // null when the threat is inactive or no profile can be built, leaving
    // placement identical to the pre-threat ordering.
    // A hydrogen blast destroys every STRUCTURE inside its outer radius (100
    // tiles by default — engine NukeExecution deletes units strictly within
    // `outer`, the inner radius only bounds terrain fallout), so two missile
    // structures closer than that can be erased by one leaking warhead. Once a
    // hostile has actually launched, prefer sites where a single hit cannot
    // take out both of our expensive silo/SAM tiles. The penalty fades
    // linearly to zero at the blast edge, so "inside the SAM umbrella but
    // outside one blast footprint" (a level-5 SAM reaches ~102 tiles, just
    // past the hydrogen outer radius) still beats both a clustered tile and an
    // undefended far corner. Returns null when the threat is inactive or no
    // profile can be built, leaving placement identical to the pre-threat
    // ordering.
    missileBlastColocationProfile(type) {
      if (type !== UNIT.MissileSilo && type !== UNIT.SAMLauncher) return null;
      if (!this.hasObservedHostileMissileLaunch()) return null;
      const blastRadius = this.hydrogenBlastRadiusOrNull();
      if (blastRadius === null) return null;
      const existingTiles = this.ownMissileStructureTiles();
      if (existingTiles.length === 0) return null;
      return this.nearestMissileBlastPenaltyScorer(existingTiles, blastRadius);
    }

    hydrogenBlastRadiusOrNull() {
      const config = this.game.config?.();
      if (!config || typeof config.nukeMagnitudes !== "function") return null;
      const magnitude = config.nukeMagnitudes(UNIT.HydrogenBomb);
      const outerRadius = Number(magnitude?.outer);
      return Number.isFinite(outerRadius) && outerRadius > 0 ? outerRadius : null;
    }

    ownMissileStructureTiles() {
      const tiles = [];
      for (const unitType of [UNIT.MissileSilo, UNIT.SAMLauncher]) {
        for (const structure of this.player.units(unitType) || []) {
          if (structure?.isUnderConstruction?.()) continue;
          const tile = structure?.tile?.();
          if (tile !== null && tile !== undefined) tiles.push(tile);
        }
      }
      return tiles;
    }

    nearestMissileBlastPenaltyScorer(existingTiles, innerRadius) {
      const innerRadiusSquared = innerRadius * innerRadius;
      return (tile) => {
        let nearestSquared = Number.POSITIVE_INFINITY;
        for (const existingTile of existingTiles) {
          const distanceSquared = this.game.euclideanDistSquared(
            tile,
            existingTile,
          );
          if (distanceSquared < nearestSquared) nearestSquared = distanceSquared;
        }
        if (nearestSquared > innerRadiusSquared) return 0;
        return 1 - Math.sqrt(nearestSquared) / innerRadius;
      };
    }

    economicPlacementBudgetLimit(requested) {
      const remaining = Number(this._economicPlacementDecisionBudget);
      if (!Number.isFinite(remaining)) return requested;
      return Math.max(0, Math.min(requested, remaining));
    }

    consumeEconomicPlacementBudget(count) {
      if (!Number.isFinite(Number(this._economicPlacementDecisionBudget))) return;
      this._economicPlacementDecisionBudget = Math.max(
        0,
        this._economicPlacementDecisionBudget - Math.max(0, Number(count) || 0),
      );
    }

    structureProbeOptions(options) {
      const requestedCandidateLimit = Number(options.candidateLimit);
      const candidateLimit = Number.isInteger(requestedCandidateLimit)
        ? Math.max(
            1,
            Math.min(STRUCTURE_PLACEMENT_CANDIDATE_LIMIT, requestedCandidateLimit),
          )
        : STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const requestedProbeLimit = Number(options.probeLimit);
      const probeLimit = Number.isInteger(requestedProbeLimit)
        ? Math.max(1, Math.min(candidateLimit, requestedProbeLimit))
        : candidateLimit;
      const requestedProbeTimeout = Number(options.probeTimeoutMs);
      const probeTimeoutMs = Number.isFinite(requestedProbeTimeout)
        ? Math.max(1, requestedProbeTimeout)
        : STRUCTURE_PROBE_TIMEOUT_MS;
      const requestedParallel = Number(options.parallelProbeCount);
      const parallelProbeCount = Number.isInteger(requestedParallel)
        ? Math.max(1, Math.min(probeLimit, requestedParallel))
        : STRUCTURE_PROBE_CONCURRENCY;
      return { candidateLimit, probeLimit, probeTimeoutMs, parallelProbeCount };
    }

    structureCandidateTiles(type, options, candidateLimit) {
      const profiledLegendaryPort =
        type === UNIT.Port &&
        options.legendaryEconomyPortTile !== null &&
        options.legendaryEconomyPortTile !== undefined;
      const profiledLegendaryFactory =
        type === UNIT.Factory &&
        isLegendaryDifficulty() &&
        options.legendaryEconomyFactoryTile !== null &&
        options.legendaryEconomyFactoryTile !== undefined;
      const profiledLegendaryCity =
        type === UNIT.City &&
        isLegendaryDifficulty() &&
        options.legendaryEconomyCityTile != null;
      if (profiledLegendaryCity) return [options.legendaryEconomyCityTile];
      let tiles;
      if (type === UNIT.Port) {
        tiles = profiledLegendaryPort
          ? [options.legendaryEconomyPortTile]
          : this.portCandidateTiles(candidateLimit);
        tiles = tiles.filter((tile) =>
          this.portTileHasOpenWaterAccess(tile) &&
          (!isLegendaryDifficulty() || this.portCandidateHasTradeRoute(tile)),
        );
      } else if (profiledLegendaryFactory) {
        tiles = [options.legendaryEconomyFactoryTile];
      } else {
        tiles = randTerritoryTileArray(
              this.random,
              this.game,
              this.player,
              candidateLimit,
        );
      }
      if (type === UNIT.City) {
        tiles = this.prependCommercialRailCityTiles(tiles, candidateLimit);
      }
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        return this.prioritizeStructureCoverageTiles(tiles, candidateLimit, options);
      }
      if (
        state.settings.winFixes &&
