      }
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(
        tr("⬆️ Upgrade {type}", { type: UNIT.SAMLauncher }),
        "build",
      );
      return true;
    }

    plannedSamUpgradeCostCacheKey(plan) {
      const samID = plan?.sam?.id?.() ?? "unknown";
      return `${samID}:${Number(plan?.currentLevel ?? 0)}:${this.ownedLevels(UNIT.SAMLauncher)}`;
    }

    rememberPlannedSamUpgradeCost(cacheKey, cost) {
      if (!(this._plannedSamUpgradeCostCache instanceof Map)) {
        this._plannedSamUpgradeCostCache = new Map();
      }
      // A nation owns very few SAMs. Bound the cache anyway so a long match
      // with repeatedly destroyed/rebuilt launchers never accumulates history.
      if (this._plannedSamUpgradeCostCache.size >= 32) {
        this._plannedSamUpgradeCostCache.clear();
      }
      this._plannedSamUpgradeCostCache.set(cacheKey, cost);
    }

    /**
     * Highest priority: keep at least one built SAM's range over every own
     * structure so a Hydrogen Bomb aimed at any of them has an interceptor.
     */
    async maybeSpawnPeaceWindowSam() {
      if (!this.legendaryPeaceWindowSamChestDue()) return false;
      if ((this.player?.units?.(UNIT.SAMLauncher) || []).length > 0) return false;
      if (this.game.config().isUnitDisabled?.(UNIT.SAMLauncher) === true) return false;
      await this.maybeSpawnStructure(UNIT.SAMLauncher, {
        allowPreemptiveSam: true,
        useActualCost: true,
        prioritizeStructureCoverage: true,
      });
      return true;
    }

    // Gold-to-City conversion on a tile plateau (the FFA freeze, measured on
    // the 123-run telemetry corpus): long FFA runs freeze from ~tick 2500 —
    // tiles pinned, army pinned AT the maxTroops cap, gold hoarded (2.9M on 3
    // Cities for 8500 ticks) — because every attack lane requires a weaker
    // neighbor. The freeze then ends to a dogpile wave LARGER than our whole
    // cap. Cities raise maxTroops, the only variable that survives that end.
    // Plateau tracking is cheap and resets the moment tiles actually grow.
    tilesPlateaued() {
      const tick = this.game.ticks();
      const tiles = this.player.numTilesOwned();
      if (tiles <= 0) return false;
      const s = state;
      if (
        s.plateauTiles !== undefined &&
        tiles > s.plateauTiles * 1.02
      ) {
        s.plateauTiles = tiles;
        s.plateauSinceTick = tick;
        return false;
      }
      if (s.plateauTiles === undefined || tick - (s.plateauSinceTick ?? tick) < 900) {
        s.plateauTiles = tiles;
        s.plateauSinceTick ??= tick;
        return false;
      }
      return true;
    }

    plateauCityConversionDue() {
      if (!this.tilesPlateaued()) return false;
      const tiles = this.player.numTilesOwned();
      const cities = this.ownedLevels(UNIT.City);
      if (tiles < 8_000 || cities < 1) return false;
      if (cities >= Math.floor(tiles / 8_000)) return false;
      const cityUnits = this.player.units(UNIT.City) || [];
      if (cityUnits.some((unit) => this.unitUnderConstruction(unit))) return false;
      const cost = this.safeConstructionCost(UNIT.City);
      if (cost === null) return false;
      // AFFORDABILITY ONLY, no reserve multiplier: City costs escalate
      // exponentially (min(1M, 2^owned x 125k)), so at 3+ Cities the next one
      // already costs 1M — a 2x reserve demanded 2M the freeze never holds
      // (measured on the frozen surr-4 row: gold cycles 0.5-1.1M while the
      // lane returned false for 8500 straight ticks). The density gate above
      // and one-City-at-a-time construction still bound the conversion.
      const gold = legendaryBigInt(this.player?.gold?.() || 0n);
      return gold >= cost;
    }

    async maybeSpawnPlateauCity() {
      if (!isLegendaryDifficulty()) return false;
      // FFA-only: the freeze pathology is FFA-specific (every attack lane
      // needs a weaker neighbor, so parity freezes growth forever). In Team
      // the win clock is allied-driven and an extra plateau City perturbed
      // the structure cadence enough to flip the Labyrinth anchor from a win
      // at 19951 to death@8121 (measured) — team keeps its exact baseline.
      // BUG (2026-08-24): the engine's GameMode.FFA value is the string
      // "Free For All", so the historical !== "FFA" comparison never matched
      // and this lane was DEAD CODE in every game — the exact freeze it was
      // built for (n2-basket-02: 477k tiles, 18M gold hoarded, 1 City, zero
      // attacks for 2000+ ticks before the endgame wave) went unanswered.
      const gameMode = String(
        this.game.config()?.gameConfig?.()?.gameMode ?? "",
      );
      if (gameMode !== "Free For All" && gameMode !== "FFA") return false;
      if (this.game.config().isUnitDisabled?.(UNIT.City) === true) return false;
      if (!this.plateauCityConversionDue()) return false;
      const spawned = await this.maybeSpawnStructure(UNIT.City, {
        useActualCost: true,
      });
      return spawned === true;
    }

    async maybeEnsureHydrogenStructureCoverage() {
      // Coverage is recomputed from completed geometry. An in-flight SAM still
      // owns the construction lane; reserve the lane until it completes rather
      // than letting a City/Port consume the retry while the footprint remains
      // uncovered. If placement is temporarily illegal/unaffordable, return
      // true as a held safety decision so ordinary economy cannot leapfrog it.
      if (this.hasOwnSamUnderConstruction()) return false;
      const plan = this.hydrogenStructureCoveragePlan();
      if (!plan) return false;
      if (plan.needsNewSam) {
        await this.maybeSpawnStructure(
          UNIT.SAMLauncher,
          {
            ...this.hostileSiloSamPlacementOptions(),
            // Coverage prepares for future launches. Only missiles already
            // flying impose a construction deadline; hypothetical immediate
            // launches otherwise forbid ever building the required coverage.
            missileDefenseContext: this.activeMissileDefenseContext(),
          },
        );
        return true;
      }
      return this.maybeUpgradePlannedSam(plan);
    }

    /**
     * Second SAM priority: our highest SAM level must reach the largest
     * hostile built-Silo level sum. The action is one upgrade at a time and
     * repeats until the numeric target is met.
     */
    async maybeUpgradeHydrogenProtectionSam() {
      return this.maybeUpgradePlannedSam(this.hydrogenSamProtectionPlan());
    }

    /**
     * Hook A: demand satisfaction follows the salvo planner, not the static
     * level sum. false = demand serviced or its aim is unsafe; true =
     * capacity/window still missing (keep building); null = planner
     * unavailable or probe failed (fall back to level sum).
