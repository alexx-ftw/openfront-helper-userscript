        typeof game.neighbors !== "function"
      ) {
        return false;
      }
      if (!game.isShore(tile)) return false;
      for (const neighbor of game.neighbors(tile) || []) {
        if (game.isWater(neighbor)) return true;
      }
      return false;
    }

    legendaryPortCapable(hasOceanPortTiles, hasCoastalTiles) {
      return (
        hasOceanPortTiles === true ||
        hasCoastalTiles === true ||
        this.hasAnyShoreBorderTile()
      );
    }

    structureTypeAvailable(structureType, context) {
      if (context.config.isUnitDisabled(structureType)) return false;
      // Shared-water lakes carry the same trade economy as oceans — Baikal
      // ports pay and attract exactly the same trade traffic.
      if (
        structureType === UNIT.Port &&
        !this.legendaryPortCapable(context.hasOceanPortTiles, context.hasCoastalTiles)
      ) {
        return false;
      }
      const missileDefenseType =
        structureType === UNIT.MissileSilo || structureType === UNIT.SAMLauncher;
      if (!context.nukesEnabled && missileDefenseType) return false;
      return !(
        !context.missileSilosEnabled && structureType === UNIT.SAMLauncher
      );
    }

    async maybePrioritizeEconomicGrowth({
      config,
      citiesDisabled,
      cityCount,
      hasCoastalTiles,
      hasOceanPortTiles,
      prioritizeCityForBorderThreat = false,
    }, profile = null) {
      // Troop-cap pressure is the strongest City-first signal: production has
      // stalled at the maxTroops ceiling and only a City (or City level)
      // restarts it, so the cap-relief City leads the economic order.
      const capPressure = this.troopCapPressure();
      const buildOrder = prioritizeCityForBorderThreat || capPressure
        ? CITY_FIRST_ECONOMIC_STRUCTURE_TYPES
        : ECONOMIC_STRUCTURE_TYPES;
      for (const structureType of buildOrder) {
        if (!this.economicStructureTypeEligible(structureType, {
          config,
          citiesDisabled,
          cityCount,
          hasCoastalTiles,
          hasOceanPortTiles,
          capPressure,
        })) {
          continue;
        }
        if (
          await profileStructureAsync(profile, `structures-economy-${structureType}`, () =>
            this.maybeSpawnStructure(structureType))
        ) {
          return true;
        }
      }
      return false;
    }

    economicStructureTypeEligible(
      structureType,
      {
        config,
        citiesDisabled,
        cityCount,
        hasCoastalTiles,
        hasOceanPortTiles,
        capPressure,
      },
    ) {
      if (config.isUnitDisabled(structureType)) return false;
      if (structureType === UNIT.Port && !hasOceanPortTiles) return false;

      // A first city is the baseline economic action even though the normal
      // ratio target is zero until cityCount has been established.
      const firstCity =
        structureType === UNIT.City && !citiesDisabled && cityCount === 0;
      // Under cap pressure an additional City is the productive action even
      // though City has no ratio entry at all.
      const capReliefCity =
        structureType === UNIT.City && !citiesDisabled && capPressure;
      if (firstCity || capReliefCity) return true;
      return this.shouldBuildStructure(structureType, cityCount, hasCoastalTiles);
    }

    /**
     * Economy ratios may say "wait" even though an economic structure is
     * affordable. Keep the normal defensive/offensive priorities, but always
     * reopen economic construction when a concrete affordable action exists.
     */
    async maybePrioritizeHighGoldEconomicConstruction({
      config,
      hasOceanPortTiles,
    }) {
      if (!state.settings.winFixes) return false;

      const availableGold = this.spendableConstructionGold();
      // A generic City → Factory → Port fallback can starve the first Port:
      // every failed economic placement consumes from the one bounded probe
      // budget for this decision, leaving no coastal probe by the time Port is
      // reached.  Once the foundational first City exists, give a viable first
      // ocean Port its probe before generic economy sites.  This redistributes
      // the fixed budget rather than increasing it, so it preserves the
      // anti-stutter bound while enabling the naval economy and warship paths.
      const openingOceanPort =
        hasOceanPortTiles === true &&
        this.ownedLevels(UNIT.City) > 0 &&
        this.ownedLevels(UNIT.Port) === 0 &&
        !config.isUnitDisabled(UNIT.Port);
      const hasFoundationalCity = this.ownedLevels(UNIT.City) > 0;
      let buildOrder;
      if (openingOceanPort) {
        buildOrder = [UNIT.Port, UNIT.Factory, UNIT.City];
      } else if (hasFoundationalCity) {
        buildOrder = [UNIT.Factory, UNIT.Port, UNIT.City];
      } else {
        buildOrder = [UNIT.City, UNIT.Factory, UNIT.Port];
      }
      for (const structureType of buildOrder) {
        if (config.isUnitDisabled(structureType)) continue;
        if (structureType === UNIT.Port && !hasOceanPortTiles) continue;
        if (availableGold < this.getConstructionCost(structureType)) continue;
        if (await this.maybeSpawnStructure(structureType)) return true;
      }
      return false;
    }

    async maybeSpawnHostileSiloSam() {
      if (!this.shouldBuildSiloTriggeredSam()) return false;
      const attemptTick = this.hostileSiloSamCurrentTick();
      if (this.hostileSiloSamRetryActive(attemptTick)) return false;
      if (this.hasOwnSamUnderConstruction()) return false;
      if (
        attemptTick !== null &&
        this._hostileSiloSamAttemptTick === attemptTick
      ) {
        return false;
      }
      if (attemptTick !== null) this._hostileSiloSamAttemptTick = attemptTick;
      const built = await this.maybeSpawnStructure(
        UNIT.SAMLauncher,
        this.hostileSiloSamPlacementOptions(),
      );
      if (built) {
        this._hostileSiloSamRetryNotBeforeTick = null;
      } else if (attemptTick !== null) {
