
      const owned = this.ownedLevels(type);

      let increasePerOwned;
      if (type === UNIT.City) {
        increasePerOwned = CITY_PERCEIVED_COST_INCREASE_PER_OWNED;
      } else {
        const difficulty = currentDifficulty();
        const ratios = getStructureRatios(difficulty);
        const config = ratios[type];
        increasePerOwned =
          config && config.perceivedCostIncreasePerOwned !== undefined
            ? config.perceivedCostIncreasePerOwned
            : 0.1;
      }

      // realCost * (1 + increasePerOwned * owned)
      const multiplier = 1 + increasePerOwned * owned;
      return BigInt(Math.ceil(Number(realCost) * multiplier));
    }

    // getSaveUpTarget — NationStructureBehavior.ts:657.
    getSaveUpTarget() {
      const config = this.game.config();

      // Just save up for SAMs if missile silos are disabled
      if (config.isUnitDisabled(UNIT.MissileSilo)) {
        return this.cost(UNIT.SAMLauncher);
      }

      // Save up a limited amount in team games (src reads gameConfig().gameMode).
      if (this.game.config().gameConfig().gameMode === GameMode.Team) {
        return this.cost(UNIT.HydrogenBomb);
      }

      const mirvEnabled = !config.isUnitDisabled(UNIT.MIRV);
      const hydroEnabled = !config.isUnitDisabled(UNIT.HydrogenBomb);
      const atomEnabled = !config.isUnitDisabled(UNIT.AtomBomb);

      if (mirvEnabled) {
        // Save up for MIRV + Hydrogen Bomb
        return this.cost(UNIT.MIRV) + this.cost(UNIT.HydrogenBomb);
      }
      if (hydroEnabled) {
        // Save up for 5 hydrogen bombs
        return this.cost(UNIT.HydrogenBomb) * 5n;
      }
      if (atomEnabled) {
        // Save up for 20 atom bombs
        return this.cost(UNIT.AtomBomb) * 20n;
      }
      // No nukes enabled, just save up for SAMs
      return this.cost(UNIT.SAMLauncher);
    }

    // maybeUpgradeStructure — NationStructureBehavior.ts:696 (now async).
    genericStructureUpgradeAllowed(result, type) {
      if (type !== UNIT.SAMLauncher) {
        // Fail open when the probe omits a cost: the engine rejects truly
        // unaffordable upgrades itself, and treating a missing price as a
        // permanent block froze every generic upgrade on probe failures.
        if (result.bu?.cost == null) return true;
        return BigInt(result.bu.cost) <= this.availableGoldAfterReserve(type);
      }
      if (
        this.tileInsideActiveHostileMissileImpact(result.structure.tile?.())
      ) {
        return false;
      }
      const cost = this.buildableCostOrFallback(
        result.bu,
        this.safeStructureCost(UNIT.SAMLauncher),
      );
      return this.samUpgradeEconomyCanAbsorb(cost);
    }

    async maybeUpgradeStructure(structures, options = {}) {
      const type = structures?.[0]?.type?.();
      // Legendary economic upgrades are strictly an exhaustion fallback. Keep that
      // proof at the actuation boundary as well as in maybeSpawnStructure so
      // no direct or future caller can trade a legal new City/Factory/Port
      // site for an upgrade.
      if (
        isLegendaryDifficulty() &&
        ECONOMIC_STRUCTURE_TYPES.includes(type) &&
        options.economicSpaceExhausted !== true
      ) {
        return false;
      }
      if (this.getTotalStructureDensity() <= UPGRADE_DENSITY_THRESHOLD) {
        return false;
      }
      if (structures.length === 0) {
        return false;
      }
      let upgradeStructures = structures;
      if (type === UNIT.Factory && isLegendaryDifficulty()) {
        const destinations = this.getOrBuildFactoryTradeDestinations();
        const minimum = this.game.config().trainStationMinRange() ** 2;
        const maximum = this.game.config().trainStationMaxRange() ** 2;
        upgradeStructures = structures.filter((factory) =>
          destinations.some(({ tile }) => {
            const distance = this.game.euclideanDistSquared(factory.tile(), tile);
            return distance >= minimum && distance <= maximum;
          }),
        );
        if (upgradeStructures.length === 0) return false;
      }
      let legendaryUpgradeState = null;
      if (isLegendaryDifficulty() && ECONOMIC_STRUCTURE_TYPES.includes(type)) {
        if (type === UNIT.City) {
          if (!this.computeTroopCapPressure(false)) return false;
        } else {
          legendaryUpgradeState = this.legendaryConstructionState({
            cityCount: (this.player?.units?.(UNIT.City) ?? []).length,
            hasCoastalTiles: this.hasAnyShoreBorderTile(),
          });
          const inputs = legendaryUpgradeState.economyInputs;
          const eligibleIds = new Set(
            type === UNIT.Factory
              ? (inputs?.factoryUpgradeTargets ?? []).map((entry) =>
                  String(entry.structureId),
                )
              : (inputs?.portUpgradeTargetIds ?? []).map(String),
          );
          upgradeStructures = upgradeStructures.filter((unit) =>
            eligibleIds.has(String(unit?.id?.() ?? "")),
          );
          if (upgradeStructures.length === 0) return false;
        }
      }
      const result = await this.findBestStructureToUpgrade(upgradeStructures);
      if (result !== null) {
        if (
          legendaryUpgradeState &&
          (type === UNIT.Factory || type === UNIT.Port)
        ) {
          if (result.bu?.cost === undefined || result.bu?.cost === null) return false;
          const structureId = result.structure?.id?.();
          const inputs = {
            ...legendaryUpgradeState.economyInputs,
            upgradeAction: true,
            upgradeStructureId: structureId,
          };
          if (type === UNIT.Factory) {
            inputs.factoryUpgrade = inputs.factoryUpgradeTargets?.find(
              (entry) => String(entry.structureId) === String(structureId),
            );
          } else {
            inputs.portUpgradeLevel = Math.max(
              1,
              Math.floor(Number(result.structure?.level?.() ?? 1)),
            );
            inputs.portUpgradeProfile =
              inputs.portUpgradeProfiles?.[String(structureId)];
          }
          const evaluation = legendaryEconomyNetGold(type, {
            cost: Number(result.bu.cost),
            horizonTicks: legendaryUpgradeState.economyHorizonTicks,
            inputs,
