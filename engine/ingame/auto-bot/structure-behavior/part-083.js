        safety,
        strategic,
        deficit,
        efficiency: Number(values.efficiency || 0) || 1,
      };
    }

    legendaryRatioCandidateNeeded(context, type) {
      const state = context.strategicState;
      if (type === UNIT.SAMLauncher) {
        return state.missileThreat.score > 0 || state.samLevelParityGap > 0;
      }
      if (type === UNIT.MissileSilo) {
        return state.targetPressure > 0.75 || state.siloParityGap > 0;
      }
      return true;
    }

    legendaryAdjustedStructureRatio(context, type, owned, baseRatio) {
      let ratio = baseRatio;
      if (
        type === UNIT.Factory &&
        context.hasCoastalTiles &&
        !context.config.isUnitDisabled(UNIT.Port) &&
        !this._dominant
      ) {
        ratio *= FACTORY_COASTAL_RATIO_MULTIPLIER;
      }
      if (this.legendaryNavalFrontLoadSuppressed(context, type, owned)) {
        return null;
      }
      if (
        type === UNIT.MissileSilo &&
        this.missileSiloPhysicalCapReached()
      ) return null;
      if (type === UNIT.MissileSilo && owned === 0) return FIRST_MISSILE_SILO_RATIO;
      return ratio;
    }

    // Naval front-loading runs only when missile defense is satisfied (no
    // visible hostile nuclear threat, or the first interceptor exists):
    //  - Ports and Factories share one 2^n price ladder, so every Factory
    //    bought before the second Port doubles the cost of funding the
    //    naval economy. Hold the Factory candidate back until two Ports
    //    exist while they still cost 125-250k.
    //  - Symmetrically, Ports beyond the opening floor are a fleet luxury;
    //    while a hostile silo or live missile exists with no interceptor,
    //    the next water structure must wait for the SAM baseline instead
    //    of doubling its own ladder (four nuked buildings on Baikal
    //    otherwise).
    legendaryNavalFrontLoadSuppressed(context, type, owned) {
      if (context.config.isUnitDisabled(UNIT.Port)) return false;
      if (type === UNIT.Factory) {
        return (
          this.ownedLevels(UNIT.Port) < LEGENDARY_MIN_OPEN_PORTS &&
          this.legendaryPortCapable(
            context.hasOceanPortTiles,
            context.hasCoastalTiles,
          ) &&
          this.legendaryMissileDefenseSatisfiedForNavalEconomy()
        );
      }
      if (type === UNIT.Port) {
        return (
          owned >= LEGENDARY_MIN_OPEN_PORTS &&
          !this.legendaryMissileDefenseSatisfiedForNavalEconomy()
        );
      }
      return false;
    }

    // True when no hostile nuclear threat is visible, or when the first
    // interceptor already exists. Naval front-loading (Factory hold-back
    // and Ports beyond the opening floor) may run only under this state.
    legendaryMissileDefenseSatisfiedForNavalEconomy() {
      const threat =
        this.hasObservedHostileMissileLaunch() || this.hasBuiltHostileSiloThreat();
      if (!threat) return true;
      return this.ownSamCapacity() > 0;
    }

    // hasHighStartingGold — NationStructureBehavior.ts:521.
    // src: config().startingGold(this.player.info()) >= threshold.
    // DIVERGENCE: the client PlayerView has no info() method (it carries only a
    // `static` with playerType/isLobbyCreator). config().startingGold only reads
    // `playerInfo.playerType` (Bot → 0n) and `playerInfo.isLobbyCreator`, so we
    // synthesize a minimal PlayerInfo-shaped object from the client player's
    // type() + isLobbyCreator() (read off __src, which exposes isLobbyCreator()).
    hasHighStartingGold() {
      if (this._hasHighStartingGold === null) {
        const src = this.player.__src ?? this.player;
        const playerInfo = {
          playerType: this.player.type(),
          isLobbyCreator:
            typeof src.isLobbyCreator === "function"
              ? src.isLobbyCreator()
              : false,
        };
        this._hasHighStartingGold =
          this.game.config().startingGold(playerInfo) >=
          HIGH_STARTING_GOLD_THRESHOLD;
      }
      return this._hasHighStartingGold;
    }

    // isHighNationDensity — NationStructureBehavior.ts:528.
    isHighNationDensity() {
      const landTiles = this.game.numLandTiles();
      if (landTiles <= 0) return false;
      return (
        this.game.nations().length / landTiles > HIGH_NATION_DENSITY_THRESHOLD
      );
    }

    // dominanceShare — fraction of the LIVE map (numLandTiles − fallout) held by OUR
    // side: the whole team in Team mode, just us in FFA. Returns a number in [0,1], or
    // null when unknowable (no player, denom ≤ 0, mode read failed). Drives the
    // post-dominance economy switch (build factories→rail instead of suppressing them).
    // NOTE we compare this against factoryRailShare (default 0.75), NOT the 0.95 win
    // line: the game ENDS at 95% team share, so factories built then never run trains.
    dominanceShare() {
      if (this.player === null) return null;
      let isTeam;
      {
        isTeam = String(this.game.config().gameConfig().gameMode) === "Team";
      }
      const fallout =
        typeof this.game.numTilesWithFallout === "function"
          ? this.game.numTilesWithFallout()
          : 0;
      const denom = (this.game.numLandTiles() || 0) - fallout;
      if (denom <= 0) return null;

      let ownedTiles = 0;
      if (isTeam) {
        for (const p of this.game.players()) {
          {
            if (p.isPlayer() && this.player.isOnSameTeam(p)) {
              ownedTiles += p.numTilesOwned();
            }
          }
        }
      } else {
        ownedTiles = this.player.numTilesOwned();
      }
      return ownedTiles / denom;
    }

    // shouldBuildStructure — NationStructureBehavior.ts:540.
    thinDensityBlocksStructure(type) {
      return (
        this.troopCapPressure() &&
        type !== UNIT.City &&
        type !== UNIT.DefensePost
      );
    }

    shouldBuildStructure(type, cityCount, hasCoastalTiles) {
      return this.shouldBuildStructureAfterDensity(
        type,
