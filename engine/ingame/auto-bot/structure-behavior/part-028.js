    economicConstructionPressure(portfolio = null) {
      if (!state.settings.winFixes) return null;

      const config = this.game.config();
      const citiesDisabled = config.isUnitDisabled(UNIT.City);
      const cityUnits = portfolio?.get(UNIT.City);
      let cityCount;
      if (citiesDisabled) {
        cityCount = Math.max(
          1,
          Math.floor(this.player.numTilesOwned() / TILES_PER_CITY_EQUIVALENT),
        );
      } else if (cityUnits === undefined) {
        cityCount = this.ownedLevels(UNIT.City);
      } else {
        cityCount = this.economicStructureLevelTotal(cityUnits);
      }
      const hasCoastalTiles = this._hasCoastalTiles === true;
      const hasOceanPortTiles = this._hasOceanPortTiles === true;
      const candidates = [UNIT.Port, UNIT.Factory, UNIT.City];

      for (const type of candidates) {
        if (config.isUnitDisabled(type) || !autoBotBuildAllowed(type)) continue;
        const units = portfolio?.get(type) ?? this.player.units(type) ?? [];
        if (units.some((unit) => this.unitUnderConstruction(unit))) continue;
        if (
          !this.economicCandidateEligible(type, units, {
            cityCount,
            hasCoastalTiles,
            hasOceanPortTiles,
          })
        ) continue;
        const cost = this.safeConstructionCost(type);
        if (cost === null) continue;
        // Saving toward an eligible economic structure is itself productive
        // pressure. Requiring it to be affordable first would let a 3M SAM
        // level consume the exact gold that was accumulating for it.
        return { type, cost };
      }
      return null;
    }

    unitUnderConstruction(unit) {
      return Boolean(
        unit &&
          typeof unit.isUnderConstruction === "function" &&
          unit.isUnderConstruction(),
      );
    }

    economicCandidateEligible(type, units, context) {
      // The normal Nation order always gives City a final build/upgrade chance.
      if (type === UNIT.City) return true;
      if (type === UNIT.Port && !context.hasOceanPortTiles) return false;
      return (
        units.length === 0 ||
        this.shouldBuildStructure(
          type,
          context.cityCount,
          context.hasCoastalTiles,
        )
      );
    }

    safeConstructionCost(type) {
      {
        return this.getConstructionCost(type);
      }
    }

    /**
     * Return whether an offensive structure must leave room for the next
     * productive and defensive actions. This prevents the first silo or a
     * requested silo upgrade from crowding out the economy/SAM response, while
     * still allowing it when the surplus covers all three spends.
     */
    shouldReserveEconomicGrowthForOffense(type) {
      if (type !== UNIT.MissileSilo || !state.settings.winFixes) return false;

      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.defensiveConstructionReserve();
      if (reserve === 0n) return false;

      let offensiveCost;
      {
        offensiveCost = this.getConstructionCost(type);
      }
      return this.spendableConstructionGold() < reserve + offensiveCost;
    }

    /**
     * Return the next SAM spend required by a live missile threat. The
     * trajectory forecast remains in the active-missile path; this cheap
     * pressure signal only reserves the next SAM site/level before a nuke is
     * allowed to consume the same surplus.
     */
    defensiveConstructionPressure() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return null;
      }
      // A hostile-silo coverage gap is itself an anticipatory SAM pressure:
      // the 300-tick construction race must reserve the next site before the
      // first launch, while other missile/SAM parity pressure still waits for
      // an observed launch.
      const coverageGap = this.hydrogenCoverageNeedsSam();
      if (!coverageGap && !this.hasObservedHostileMissileLaunch()) return null;

      {
        const config = this.game.config();
        if (
          typeof config.isUnitDisabled === "function" &&
          config.isUnitDisabled(UNIT.SAMLauncher)
        ) {
          return null;
        }
      }
      if (!this.hasDefensiveSamPressure()) return null;
      const cost = this.safeConstructionCost(UNIT.SAMLauncher);
      return cost === null ? null : { type: UNIT.SAMLauncher, cost };
    }

    /**
     * Reserve one Defense Post early enough for its construction time, but only
     * against a meaningful land attack by a strategic player. This reserve is
     * consumed exclusively by offensive Silo/nuke budget checks; productive
     * buildings and SAMs retain access to the same gold.
     */
    preemptiveDefensePostPressure() {
      if (
        !state.settings.winFixes ||
        !autoBotBuildAllowed(UNIT.DefensePost) ||
        currentDifficulty() === Difficulty.Easy ||
        !this.hasPriorStructureForDefensePost()
      ) {
        return null;
      }
      if (this.game.config().isUnitDisabled(UNIT.DefensePost)) return null;

      const ourTroops = Number(this.player.troops() || 0);
      if (ourTroops <= 0) return null;
      const strategicLandAttacks = this.player
        .incomingAttacks()
        .filter((attack) => {
          if (!this.isActiveIncomingAttack(attack)) return false;
          if (!this.isLandAttack(attack)) return false;
          return this.isStrategicLandAttack(attack);
        });
      const incomingTroops = strategicLandAttacks.reduce(
        (sum, attack) => sum + Math.max(0, Number(attack.troops?.() || 0)),
        0,
      );
      if (
        incomingTroops / ourTroops < PREEMPTIVE_DEFENSE_POST_THREAT_RATIO
      ) {
        return null;
      }
      const cost = this.safeConstructionCost(UNIT.DefensePost);
      return cost === null ? null : { type: UNIT.DefensePost, cost };
    }
