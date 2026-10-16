          const anchorRangeSquared = anchor.currentRange * anchor.currentRange;
          const upgradedRangeSquared = anchor.upgradedRange * anchor.upgradedRange;
          let anchorProtectsAsset = false;
          const uncoveredStructureTiles = [];
          for (const structureTile of protectedTiles) {
            const anchorDistance = this.game.euclideanDistSquared(
              anchor.tile,
              structureTile,
            );
            if (anchorDistance <= upgradedRangeSquared) {
              anchorProtectsAsset = true;
            }
            if (anchorDistance > anchorRangeSquared) {
              uncoveredStructureTiles.push(structureTile);
            }
          }
          if (!anchorProtectsAsset || uncoveredStructureTiles.length === 0) {
            return null;
          }
          return {
            ...anchor,
            anchorRangeSquared,
            upgradedRangeSquared,
            uncoveredStructureTiles,
          };
        })
        .filter((anchor) => anchor !== null);
      if (anchorProfiles.length === 0) return () => 0;

      return (tile) => {
        let best = 0;
        for (const anchor of anchorProfiles) {
          const anchorDistanceSquared = this.game.euclideanDistSquared(
            tile,
            anchor.tile,
          );
          if (anchorDistanceSquared > anchor.upgradedRangeSquared) continue;

          let candidateAddsCoverage = false;
          for (const structureTile of anchor.uncoveredStructureTiles) {
            if (this.game.euclideanDistSquared(tile, structureTile) <= candidateRangeSquared) {
              candidateAddsCoverage = true;
              break;
            }
          }
          if (!candidateAddsCoverage) continue;
          const proximity = Math.max(
            0,
            1 - Math.sqrt(anchorDistanceSquared) / anchor.upgradedRange,
          );
          best = Math.max(best, structureSpacing * proximity);
        }
        return best;
      };
    }

    existingSamStructureCoverage(protectEntries) {
      const game = this.game;
      const coverageByTile = new Map();
      const existingSams = this.player.units(UNIT.SAMLauncher);
      for (const entry of protectEntries) {
        let coverageScore = 0;
        for (const sam of existingSams) {
          const samRange = this.legendarySamRange(sam.level());
          const distanceSquared = game.euclideanDistSquared(
            entry.tile,
            sam.tile(),
          );
          if (distanceSquared <= samRange * samRange) coverageScore += sam.level();
        }
        coverageByTile.set(entry.tile, coverageScore);
      }
      return coverageByTile;
    }

    // spacingConstants — NationStructureBehavior.ts:1323.
    spacingConstants() {
      const config = this.game.config();
      if (
        config === this._spacingConstantsConfig &&
        this._spacingConstantsCache !== undefined
      ) {
        return this._spacingConstantsCache;
      }
      const borderSpacing = config.nukeMagnitudes(UNIT.AtomBomb).outer;
      const spacing = { borderSpacing, structureSpacing: borderSpacing * 2 };
      this._spacingConstantsConfig = config;
      this._spacingConstantsCache = spacing;
      return spacing;
    }

    initialSiloNavalConstructionEnabled() {
      const config = this.game?.config?.();
      return Boolean(config && this.maritimeDefenseConstructionEnabled(config));
    }

    structureConfigDisablesType(config, type) {
      return config?.isUnitDisabled?.(type) === true;
    }

    hostileNuclearThreatPlayers() {
      const mySid = this.player.smallID();
      const players = [];
      for (const other of this.game.players()) {
        if (!this.hostileNuclearThreatPlayerEligible(other, mySid)) continue;
        const id = this.readPlayerSmallId(other);
        if (id === null || id === undefined) continue;
        players.push({
          id,
          gold: Number(other.gold?.() || 0),
          siloCount: this.playerUnitCapacitySummary(other, UNIT.MissileSilo)?.count ?? 0,
        });
      }
      return players;
    }

    hostileNuclearThreatPlayerEligible(other, mySid) {
      if (!other?.isPlayer?.() || other.smallID() === mySid) return false;
      if (!other.isAlive?.()) return false;
      return this.player.isFriendly?.(other) !== true;
    }

    legendaryConstructionCandidateBlocked(context, type) {
      return context.config.isUnitDisabled(type) || !autoBotBuildAllowed(type) ||
        this.legendarySamChestBlocksType(type) || this.samCandidateLaunchGate(type);
    }

    legendaryBigStartSiloCandidateBlocked(type) {
      return type === UNIT.MissileSilo &&
        state.bigStartGold?.decided === true &&
        state.bigStartGold?.value === true &&
        state.bigStartGold?.openingGold >= 10_000_000n &&
        this.legendaryBigStartSiloDeferred(true);
    }

    nuclearSlotPressureUnitsDisabled(config) {
      return config.isUnitDisabled(UNIT.MissileSilo) ||
        (config.isUnitDisabled(UNIT.AtomBomb) &&
          config.isUnitDisabled(UNIT.HydrogenBomb) &&
          config.isUnitDisabled(UNIT.MIRV));
    }

    maybeSpawnUnqueuedNuclearSlotPressureSilo() {
      const allSilos = this.player?.units?.(UNIT.MissileSilo) || [];
      if (allSilos.some((silo) => silo.isUnderConstruction?.() === true)) {
        return false;
      }
      return this.maybeSpawnNuclearSlotPressureSilo();
    }

    emitNuclearSlotPressureUpgrade(result) {
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, result.bu, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(
