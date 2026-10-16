        cityCount,
        hasCoastalTiles,
      );
    }

    shouldBuildStructureAfterDensity(type, cityCount, hasCoastalTiles) {
      if (this.shouldReserveEconomicGrowthForOffense(type)) {
        return false;
      }
      const gameConfig = this.game.config();
      const difficulty = currentDifficulty();
      const ratios = getStructureRatios(difficulty);
      const config = ratios[type];
      if (config === undefined) {
        return false;
      }

      let ratio = config.ratioPerCity;

      // Heavily reduce factory spawning if we have coastal tiles — EXCEPT once we're
      // DOMINANT: then we WANT factories (for rail linking ports↔cities), so the
      // coastal suppression (which keeps a coastal nation at ~0-2 factories) is lifted
      // and the factory target rises to its full ratioPerCity. (winFixes-gated via
      // this._dominant, set in doHandleStructures.)
      if (
        type === UNIT.Factory &&
        hasCoastalTiles &&
        !gameConfig.isUnitDisabled(UNIT.Port) &&
        !this._dominant
      ) {
        ratio *= FACTORY_COASTAL_RATIO_MULTIPLIER;
      }

      const owned = this.ownedLevels(type);
      const siloParityTarget =
        type === UNIT.MissileSilo && state.settings.winFixes
          ? this.missileSiloParityTarget()
          : 0;

      // Hard cap counts physical silos, except while custom SAM parity needs more levels.
      if (type === UNIT.MissileSilo && this.missileSiloPhysicalCapReached()) {
        return false;
      }

      // First missile silo uses a higher ratio so nations can start nuking earlier
      if (type === UNIT.MissileSilo && owned === 0) {
        ratio = FIRST_MISSILE_SILO_RATIO;
      }

      const ratioTarget = Math.floor(cityCount * ratio);
      const targetCount =
        type === UNIT.MissileSilo
          ? Math.max(ratioTarget, siloParityTarget)
          : ratioTarget;

      return owned < targetCount;
    }

    // cost — NationStructureBehavior.ts:581.
    // src: this.game.unitInfo(type).cost(this.game, this.player).
    // Legendary construction ranking passes authoritative BuildableUnit.cost
    // quotes when available; these formulas remain the fallback for other callers.
    // DIVERGENCE: reproduced from the Config.ts cost formulas as BigInt (the
    // passthrough cost fn would mis-compute numUnits from the client's
    // count/boolean unitsOwned/unitsConstructed). numUnits is the level sum:
    // the costWrapper min(unitsOwned, unitsConstructed) collapses to the level
    // sum because recordUnitConstructed fires per build AND per upgrade
    // (PlayerImpl.ts:1414,1496-1501), so constructed == level for every live
    // unit the client can see. Captured units differ when no live quote is
    // available (the engine price is lower). Port/Factory combine
    // BOTH types per the costWrapper arglist (Config.ts:597-606/670-690).
    // MIRV uses the base price only (numMirvsLaunched is core-only) — see
    // getSaveUpTarget DIVERGENCE.
    cost(type, economyCostQuotes = null) {
      if (
        ECONOMIC_STRUCTURE_TYPES.includes(type) &&
        economyCostQuotes?.has(type)
      ) {
        return economyCostQuotes.get(type);
      }
      switch (type) {
        case UNIT.Port: {
          const n = this.ownedLevels(UNIT.Port) + this.ownedLevels(UNIT.Factory);
          return BigInt(Math.min(1_000_000, Math.pow(2, n) * 125_000));
        }
        case UNIT.Factory: {
          const n = this.ownedLevels(UNIT.Factory) + this.ownedLevels(UNIT.Port);
          return BigInt(Math.min(1_000_000, Math.pow(2, n) * 125_000));
        }
        case UNIT.City: {
          const n = this.ownedLevels(UNIT.City);
          return BigInt(Math.min(1_000_000, Math.pow(2, n) * 125_000));
        }
        case UNIT.SAMLauncher: {
          const n = this.ownedLevels(UNIT.SAMLauncher);
          return BigInt(Math.min(3_000_000, (n + 1) * 1_500_000));
        }
        case UNIT.MissileSilo:
          return 1_000_000n;
        case UNIT.DefensePost: {
          const n = this.ownedLevels(UNIT.DefensePost);
          return BigInt(Math.min(250_000, (n + 1) * 50_000));
        }
        case UNIT.AtomBomb:
          return 750_000n;
        case UNIT.HydrogenBomb:
          return 5_000_000n;
        case UNIT.MIRV: {
          // DIVERGENCE: src = 25M + numMirvsLaunched()*15M; numMirvsLaunched
          // is core-only (game.stats() is not on the client GameView) and the
          // counter is GLOBAL — every player's launch raises the price. We
          // approximate it by counting MIRV units we have OBSERVED in flight
          // (a launch is only invisible if the whole flight happened between
          // our worker snapshots), so the save-up target tracks the escalation
          // instead of assuming a permanently fresh 25M market. The
          // mirvBehavior probe still pays the authoritative live price at
          // actuation.
          const observed = this.observedGlobalMirvLaunchCount();
          return 25_000_000n + BigInt(observed) * 15_000_000n;
        }
        case UNIT.Warship: {
          const n = this.ownedLevels(UNIT.Warship);
          return BigInt(Math.min(1_000_000, (n + 1) * 250_000));
        }
        default:
          return 0n;
      }
    }

    legendaryFactorySeedSelectionStillValid(buildable, options, inputs, config) {
      const stopTiles = options.legendaryEconomyFactorySeedStopTiles;
      const selectedStops = options.legendaryEconomyFactorySeedStops;
      if (!Array.isArray(stopTiles) || !Array.isArray(selectedStops)) return false;
      const tileIds = stopTiles.map(String);
      const selectedTileIds = new Set(tileIds);
      const selectedByTile = new Map(
        selectedStops.map((stop) => [String(stop?.tile), stop]),
      );
      if (
        tileIds.length === 0 ||
        selectedTileIds.size !== tileIds.length ||
        selectedByTile.size !== selectedTileIds.size
      ) {
        return false;
      }
      const currentStopsByTile = new Map(
        (inputs?.factorySeedStops ?? []).map((stop) => [String(stop.tile), stop]),
      );
      const selectedStopsRemainEligible = [...selectedTileIds].every((tile) => {
        const expected = selectedByTile.get(tile);
        const current = currentStopsByTile.get(tile);
        const expectedPayout = Number(expected?.teamGoldPerSpawn);
        return (
          current &&
          current.pending !== true &&
          Number.isFinite(expectedPayout) &&
          expectedPayout > 0 &&
          Number(current.teamGoldPerSpawn) >= expectedPayout
        );
      });
