      // visible. Keep active-missile, hostile-silo and immediate-defense paths
      // above this one, then establish one affordable silo independently of the
      // ongoing economy-growth signal.
      if (
        !state.settings.winFixes ||
        legendaryDifficulty ||
        this.game.config().isUnitDisabled(UNIT.MissileSilo) ||
        this.ownedLevels(UNIT.MissileSilo) > 0
      ) {
        return false;
      }
      const nukesEnabled =
        !this.game.config().isUnitDisabled(UNIT.AtomBomb) ||
        !this.game.config().isUnitDisabled(UNIT.HydrogenBomb) ||
        !this.game.config().isUnitDisabled(UNIT.MIRV);
      if (!nukesEnabled) return false;
      if (
        !this.game.config().isUnitDisabled(UNIT.City) &&
        this.ownedLevels(UNIT.City) === 0
      ) {
        return false;
      }
      // On an open-ocean start, spending the entire opening bank on a peaceful
      // first silo leaves neither the Port nor its first Warship affordable.
      // Nuclear emergencies already returned from higher-priority paths; this
      // applies only to the speculative offensive launcher.
      if (
        this.shouldDeferInitialSiloForNavalOpening() &&
        !this.legendaryArsenalNavalOpeningReady()
      ) {
        return false;
      }
      const siloCost = this.getConstructionCost(UNIT.MissileSilo);
      if (this.spendableConstructionGold() < siloCost) return false;
      // The first silo establishes the offensive capability itself.  The
      // normal reserve gate intentionally defers additional offensive silos
      // behind the next economic/SAM spend, but applying it here makes this
      // policy unreachable whenever the economy has any pending demand.
      return this.maybeSpawnStructure(UNIT.MissileSilo, {
        ignoreEconomicReserve: true,
      });
    }

    legendaryArsenalNavalOpeningReady() {
      if (!isLegendaryDifficulty()) return false;
      const ports = this.player?.units?.(UNIT.Port) || [];
      const hasCompletedPort = ports.some(
        (port) => port?.isUnderConstruction?.() === false,
      );
      if (!hasCompletedPort) return false;
      return this.ownedLevels(UNIT.City) >= 2;
    }

    shouldDeferInitialSiloForNavalOpening() {
      if (!this.initialSiloNavalConstructionEnabled()) return false;
      if (this.hasObservedHostileMissileLaunch() || this.hasBuiltHostileSiloThreat()) {
        return false;
      }
      if (!this.hasOceanPortTiles()) return false;
      if (!this.navalOpeningHasCompletedPort()) return true;
      const warships = this.player?.units?.(UNIT.Warship) || [];
      if (warships.length > 0) return false;
      // A coastal opening must not hold the nuclear lane hostage forever: if
      // the first Warship never becomes affordable, the same 3000-tick
      // backstop the landlocked Arsenal uses releases the first Silo.
      // Measured Baikal Nuke Wars run (2026-10-10): the Warship never queued,
      // so the deferred Silo never reached its lane before bot_dead at 5212.
      const tick = this.game?.ticks?.();
      return !(
        Number.isFinite(tick) && tick >= LEGENDARY_LANDLOCKED_ARSENAL_BACKSTOP_TICK
      );
    }

    async handleOrdinaryStructurePriorities(context) {
      const {
        citiesDisabled,
        cityCount,
        config,
        hasCoastalTiles,
        hasOceanPortTiles,
      } = context;
      // A coastal opening must not spend its first economic windows on Ports.
      // Without a City, Ports and their Warship follow-up add little durable
      // troop/economic capacity and can starve the foundational growth needed
      // to survive a fast Nation opening. Urgent missile and land-defense
      // paths run before this ordinary phase; here the first two Cities are absolute.
      if (
        !citiesDisabled &&
        cityCount < 2 &&
        (await this.maybeSpawnStructure(UNIT.City))
      ) {
        return true;
      }
      // Troop-cap pressure stalls all further production growth: only a City
      // raises the maxTroops ceiling. Give that build its probe before the
      // ratio-driven Port/Factory/SAM/Silo order can spend the same gold. The
      // urgent missile and land-defense paths have already returned earlier in
      // handleStructures, so this cannot delay an active-defense response.
      if (
        !citiesDisabled &&
        this.troopCapPressure() &&
        (await this.maybeSpawnStructure(UNIT.City))
      ) {
        return true;
      }
      // Build order for non-city structures (priority order)
      const buildOrder = [
        UNIT.Port,
        UNIT.Factory,
        UNIT.SAMLauncher,
        UNIT.MissileSilo,
      ];

      for (const structureType of buildOrder) {
        if (!this.structureTypeAvailable(structureType, context)) continue;
        if (!this.shouldBuildStructure(structureType, cityCount, hasCoastalTiles)) {
          continue;
        }
        if (await this.maybeSpawnStructure(structureType)) return true;
      }

      if (!citiesDisabled && (await this.maybeSpawnStructure(UNIT.City))) {
        return true;
      }

      // All ratio-driven and defensive construction has had first chance. If
      // the economy is still idle, make one affordable economic attempt even
      // when the growth signal is already active but its ratio targets are met.
      if (
        (await this.maybePrioritizeHighGoldEconomicConstruction({
          config,
          hasOceanPortTiles,
        }))
      ) {
        return true;
      }

      return false;
    }

    // A shore border tile with any water neighbor can host a Port — the
    // engine only needs coast, and the ocean/shared-water classifications
    // are helper policy that misclassifies enclosed lakes like Baikal.
    // Legendary uses the raw shore fact so lake maps run the full trade
    // economy; faithful tiers keep their classification.
    hasAnyShoreBorderTile() {
      const borderTiles = this.player?.borderTiles?.();
      if (!borderTiles) return false;
      for (const tile of borderTiles) {
        if (this.isShoreBorderTile(tile)) return true;
      }
      return false;
    }

    isShoreBorderTile(tile) {
      const game = this.game;
      if (
        game == null ||
        typeof game.isShore !== "function" ||
        typeof game.isWater !== "function" ||
