        profile,
        "structures-context-ocean-port",
        () => this.hasOceanPortTiles(),
      );
      const hasCoastalTiles = hasOceanPortTiles || profileStructureSync(
        profile,
        "structures-context-shared-water",
        () => shimHasSharedWater(this.game, this.player),
      );
      this._hasCoastalTiles = hasCoastalTiles;
      this._hasOceanPortTiles = hasOceanPortTiles;
      profileStructureSync(profile, "structures-context-dominance", () =>
        this.updateConstructionDominance());

      const missileSilosEnabled = !config.isUnitDisabled(UNIT.MissileSilo);
      const difficulty = currentDifficulty();
      const prioritizeCityForBorderThreat = profileStructureSync(
        profile,
        "structures-context-border-threat",
        () =>
          state.settings.winFixes &&
          this.hasBorderingHostileMaxTroopAdvantage(),
      );
      const economyGrowthPriority = profileStructureSync(
        profile,
        "structures-context-economy-growth",
        () => this.shouldPrioritizeEconomicGrowth(prioritizeCityForBorderThreat),
      );
      const nukesEnabled =
        !config.isUnitDisabled(UNIT.AtomBomb) ||
        !config.isUnitDisabled(UNIT.HydrogenBomb) ||
        !config.isUnitDisabled(UNIT.MIRV);
      return {
        config,
        citiesDisabled,
        cityCount,
        difficulty,
        economyGrowthPriority,
        hasCoastalTiles,
        hasOceanPortTiles,
        missileSilosEnabled,
        nukesEnabled,
        prioritizeCityForBorderThreat,
      };
    }

    updateConstructionDominance() {
      // Once OUR side is DOMINANT (default >75% of the live map — well BELOW the 95%
      // win line at which the game would END), stop suppressing coastal factories (see
      // shouldBuildStructure) so the bot fills in factories → train stations → rail
      // linking our ports and cities. Computed ONCE per build-tick (it scans all
      // players) and read by shouldBuildStructure. Gated by winFixes.
      this._dominant = false;
      if (state.settings.winFixes) {
        const share = this.dominanceShare();
        const trigger = Number.isFinite(state.settings.factoryRailShare)
          ? state.settings.factoryRailShare
          : 0.75;
        this._dominant = share !== null && share > trigger;
        {
          const t = this.game.ticks();
          if (t - (state._buildDomDiagTick || -999) >= 80) {
            state._buildDomDiagTick = t;
            runtimeDebugLog("[Build] dominance gate", {
              share: share === null ? null : Number(share.toFixed(3)),
              trigger,
              dominant: this._dominant,
            });
          }
        }
      }
      // Publish the dominance flag so OTHER behaviors share one source of truth (e.g.
      // allianceBehavior stops reaching out for far trade-allies once we're dominant,
      // letting betray/conquer close the game). Updated every build-tick.
      state.dominant = this._dominant;
    }

    async handleOpeningStructurePriorities(context) {
      // High-starting-gold Hard/Impossible nations build a SAM first. Legendary
      // lets the adaptive planner decide; defense is a guardrail there, not the
      // default opening investment.
      if (
        this.shouldOpenWithSam(context) &&
        (await this.maybeSpawnStructure(UNIT.SAMLauncher))
      ) {
        return true;
      }

      // On crowded maps the first structure is a port (or factory if landlocked).
      const crowdedOpening = this.crowdedOpeningStructure(context);
      if (crowdedOpening === null) return false;
      return this.maybeSpawnStructure(crowdedOpening);
    }

    shouldOpenWithSam(context) {
      // Big-start boards (5MM/25MM): mirror the engine nations — their SAM is
      // structure #1 unconditionally (NationStructureBehavior.ts:449-460) so
      // every later structure is born covered (measured first strikes
      // 1150-1990; the 300-tick SAM built first is ready long before).
      const bigStartOpening =
        isLegendaryDifficulty(context.difficulty) && this.legendaryBigStartGame();
      return (
        this.placementsCount === 0 &&
        (bigStartOpening ||
          (isAtLeastHardDifficulty(context.difficulty) &&
            !isLegendaryDifficulty(context.difficulty))) &&
        !context.config.isUnitDisabled(UNIT.AtomBomb) &&
        context.missileSilosEnabled &&
        !context.config.isUnitDisabled(UNIT.SAMLauncher) &&
        this.hasHighStartingGold() &&
        !context.economyGrowthPriority
      );
    }

    crowdedOpeningStructure(context) {
      // The adaptive Legendary tier opens Port-first too when coastal and
      // crowded: its whole naval economy (trade income, warship spawns,
      // captures) hangs off that first Port.
      if (isLegendaryDifficulty(context.difficulty) && !state.settings.winFixes) {
        return null;
      }
      if (context.citiesDisabled) return null;
      const cityPriorityAvailable =
        context.prioritizeCityForBorderThreat &&
        !context.config.isUnitDisabled(UNIT.City);
      if (cityPriorityAvailable || this.ownedLevels(UNIT.City) !== 0) return null;
      if (!this.isHighNationDensity()) return null;
      const preferred =
        context.hasOceanPortTiles && !context.config.isUnitDisabled(UNIT.Port)
          ? UNIT.Port
          : UNIT.Factory;
      return context.config.isUnitDisabled(preferred) ? null : preferred;
    }

    async handleMissileSiloParity(context) {
      const {
        difficulty,
        economyGrowthPriority,
        missileSilosEnabled,
        nukesEnabled,
      } = context;
      // WIN-FIX: a hostile SAM network defines the silo capacity we need to
      // saturate it. Prefer a silo build/upgrade until our sum of silo levels
      // reaches the largest hostile player's sum of SAM levels.
      return (
        state.settings.winFixes &&
        !isLegendaryDifficulty(difficulty) &&
        !economyGrowthPriority &&
        missileSilosEnabled &&
        nukesEnabled &&
        !this.hasStructureUnderConstruction(this.player.units(UNIT.MissileSilo)) &&
        this.missileSiloParityGap() > 0 &&
        (await this.maybeSpawnStructure(UNIT.MissileSilo))
      );
    }

    async handleInitialMissileSilo(legendaryDifficulty = isLegendaryDifficulty()) {
      // A first launcher is the prerequisite for every offensive nuclear path.
      // The parity policy below deliberately reacts to an established enemy SAM
      // network, but cannot create that first launcher when no such network is
