        if (requireBorderDepth && !this.hasDefensePostBorderDepth(tile, context)) {
          continue;
        }
        result.push(tile);
      }
      return result;
    }

    randomOwnedFrontTile(context) {
      const anchor = this.random.randElement(context.anchors);
      const ax = this.game.x(anchor);
      const ay = this.game.y(anchor);
      const radius = context.searchRadius;
      const x = this.random.nextInt(ax - radius, ax + radius + 1);
      const y = this.random.nextInt(ay - radius, ay + radius + 1);
      if (!this.game.isValidCoord(x, y)) return null;
      const tile = this.game.ref(x, y);
      return this.game.ownerID(tile) === context.mySid ? tile : null;
    }

    hasDefensePostBorderDepth(tile, context) {
      if (context === undefined) {
        const { borderSpacing } = this.spacingConstants();
        context = {
          borderTiles: this.player.borderTiles(),
          minBorderDist: Math.ceil(borderSpacing * 0.75),
          maxBorderDist: Math.ceil(borderSpacing * 1.5),
        };
      }
      const [, borderDist] = closestTile(this.game, context.borderTiles, tile);
      return (
        borderDist >= context.minBorderDist &&
        borderDist <= context.maxBorderDist
      );
    }

    // isInPostSaveUpBlockedPhase — NationStructureBehavior.ts:398.
    isInPostSaveUpBlockedPhase() {
      // winFixes uses explicit offensive/economy reserves instead of the
      // faithful global save-up gate. Never freeze ordinary construction while
      // waiting for a MIRV or HydrogenBomb target.
      if (state.settings.winFixes) return false;
      if (this.game.config().isUnitDisabled(UNIT.MissileSilo)) {
        return false;
      }
      const saveUpTarget = this.getSaveUpTarget();
      if (this._postSaveUpStartTick === null) {
        if (this.player.gold() < saveUpTarget) {
          return false;
        }
        this._postSaveUpStartTick = this.game.ticks();
      }
      const elapsed = this.game.ticks() - this._postSaveUpStartTick;
      return (
        elapsed % (TEAM_POST_SAVE_UP_PHASE_TICKS * 2) >=
        TEAM_POST_SAVE_UP_PHASE_TICKS
      );
    }

    async handleInitialSiloPriority(profile, legendaryDifficulty) {
      if (this.player === null || this.player === undefined) return false;
      return profileStructureAsync(profile, "structures-initial-silo", () =>
        this.handleInitialMissileSilo(legendaryDifficulty));
    }

    async maybeOpenLandlockedLegendaryArsenal(context, profile, hasWaterAccess) {
      if (
        !isLegendaryDifficulty(context.difficulty) ||
        hasWaterAccess ||
        context.cityCount < 1
      ) {
        return false;
      }
      const tick =
        typeof this.game?.ticks === "function" ? this.game.ticks() : 0;
      if (tick < LEGENDARY_LANDLOCKED_ARSENAL_BACKSTOP_TICK) return false;
      if (this.leadGuardDefensePostThreat(context.difficulty) !== null) return false;
      return profileStructureAsync(profile, "structures-ordinary-landlocked-arsenal", () =>
        this.maybeOpenLegendaryArsenal(context));
    }

    legendaryDefenseEmergencies(legendaryDifficulty) {
      const missileEmergency =
        legendaryDifficulty && this.legendaryMissileDefenseUrgent();
      const defenseEmergency =
        missileEmergency ||
        (legendaryDifficulty &&
          state.settings.winFixes &&
          this.hasObservedHostileMissileLaunch() &&
          this.samLevelParityGap() > 0);
      return { missileEmergency, defenseEmergency };
    }

    // doHandleStructures — NationStructureBehavior.ts:416 (now async).
    async doHandleStructures(profile = null) {
      // Snapshot the big-start signature from the unspent opening treasury
      // before ANY structure branch can spend it (the opening-priorities path
      // buys the City/SAM/silo line before the Legendary chain ever runs —
      // see legendaryBigStartGame).
      this.legendaryBigStartGame();
      const context = profileStructureSync(
        profile,
        "structures-ordinary-context",
        () => this.structureBuildContext(profile),
      );
      if (
        await profileStructureAsync(profile, "structures-ordinary-opening", () =>
          this.handleOpeningStructurePriorities(context))
      ) {
        return true;
      }
      const legendaryDifficulty = isLegendaryDifficulty(context.difficulty);
      const hasWaterAccess = legendaryDifficulty &&
        (context.hasOceanPortTiles ||
          context.hasCoastalTiles ||
          this.hasAnyShoreBorderTile());
      if (await this.maybeOpenLandlockedLegendaryArsenal(
        context, profile, hasWaterAccess,
      )) return true;
      if (legendaryDifficulty) {
        // Shared-water lakes (Baikal) enable naval candidates like oceans.
        // The adaptive economy ladder also runs on landlocked maps; without a
        // legal shared-water route, it simply admits no Port build candidate.
        return profileStructureAsync(profile, "structures-ordinary-legendary", () =>
          this.doHandleLegendaryStructures(context));
      }
      if (
        context.economyGrowthPriority &&
        (await profileStructureAsync(profile, "structures-ordinary-economy", () =>
          this.maybePrioritizeEconomicGrowth(context, profile)))
      ) {
        return true;
      }
      if (
        await profileStructureAsync(profile, "structures-ordinary-silo-parity", () =>
          this.handleMissileSiloParity(context))
      ) {
        return true;
      }
      return profileStructureAsync(profile, "structures-ordinary-policy", () =>
        this.handleOrdinaryStructurePriorities(context));
    }

    structureBuildContext(profile = null) {
      this.reachableStationsCache = null;
      this.factoryTradeDestinationsCache = null;
      const config = this.game.config();
      const citiesDisabled = config.isUnitDisabled(UNIT.City);
      const cityCount = citiesDisabled
        ? Math.max(
            1,
            Math.floor(this.player.numTilesOwned() / TILES_PER_CITY_EQUIVALENT),
          )
        : this.ownedLevels(UNIT.City);
      // Ocean access is answered from our cached border. An open-ocean port
      // tile is also, by definition, shared water, so read that cheap cached
      // result first. Calling hasSharedWater before it walks the complete live
      // border a second time on every Auto-build decision. The exact
      // shared-water reconstruction remains the fallback for inland lakes.
      const hasOceanPortTiles = profileStructureSync(
