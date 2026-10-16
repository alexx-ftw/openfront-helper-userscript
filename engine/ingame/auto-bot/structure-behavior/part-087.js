        return result;
      };
      if (!this.structureSpawnEligible(type, options)) {
        siloStage("laneSiloStageEligibleBlocked");
        return finishSiloStage(false);
      }
      siloStage("laneSiloStageEligible");
      if (type === UNIT.MissileSilo && this.missileSiloPhysicalCapReached()) {
        return finishSiloStage(false);
      }
      if (
        options.nukeDemandRequest &&
        !this.nukeDemandSiloSpawnAllowed(options.nukeDemandRequest)
      ) {
        return finishSiloStage(false);
      }

      const structures = this.player.units(type);
      const economicType = ECONOMIC_STRUCTURE_TYPES.includes(type);
      // Productive structures are expansion first. A failed bounded placement
      // probe is not proof that the map has no room: it can also mean a worker
      // timeout, an unavailable descriptor, or an unlucky candidate sample.
      // Therefore it must never be converted into an upgrade. The planner may
      // upgrade an economic structure only when a future exhaustive placement
      // result explicitly supplies economicSpaceExhausted=true.
      const profiledLegendaryPort =
        type === UNIT.Port &&
        options.legendaryEconomyPortTile !== null &&
        options.legendaryEconomyPortTile !== undefined;
      const profiledLegendaryFactory =
        type === UNIT.Factory &&
        isLegendaryDifficulty() &&
        options.legendaryEconomyFactoryTile !== null &&
        options.legendaryEconomyFactoryTile !== undefined;
      const profiledLegendaryCity =
        type === UNIT.City &&
        isLegendaryDifficulty() &&
        (options.legendaryEconomyCityTile != null ||
          options.legendaryEconomyCityCapRelief === true);
      if (
        this.economicStructureSpawnPending(economicType, structures) &&
        !profiledLegendaryPort
      ) {
        return false;
      }

      // An authoritative upgrade can cost less than a new structure of the
      // same type. Give that decision its chance before applying the new-build
      // affordability gate.
      if (!economicType || !isLegendaryDifficulty()) {
        const upgradeDecision = await this.structureUpgradeBeforeSpawn(
          type,
          structures,
          options,
        );
        siloStage("laneSiloStageUpgrade");
        if (upgradeDecision !== null) return finishSiloStage(upgradeDecision);
      }

      const perceivedCost = this.constructionCostForOptions(type, options);
      // SAM construction preserves the first-Silo cost unless the response is
      // urgent; economic growth keeps its ordinary budget.
      const availableGold = this.availableGoldAfterReserve(type, {
        includeSam: true,
      });
      if (availableGold < perceivedCost) {
        siloStage("laneSiloStageGoldBlocked");
        return finishSiloStage(false);
      }
      siloStage("laneSiloStageGold");

      const buildable = await this.structureSpawnBuildable(
        type,
        structures,
        economicType,
        options,
      );
      siloStage("laneSiloStageBuildable");
      if (buildable === null) return finishSiloStage(false);
      if (typeof buildable === "boolean") return finishSiloStage(buildable);
      if (
        profiledLegendaryPort &&
        buildable.canBuild !== options.legendaryEconomyPortTile
      ) {
        return finishSiloStage(false);
      }
      if (
        profiledLegendaryPort &&
        !(await this.legendaryPortBuildStillWorthIt(buildable, options))
      ) {
        return finishSiloStage(false);
      }
      if (
        profiledLegendaryFactory &&
        buildable.canBuild !== options.legendaryEconomyFactoryTile
      ) {
        return finishSiloStage(false);
      }
      if (
        profiledLegendaryFactory &&
        !this.legendaryFactoryBuildStillWorthIt(buildable, options)
      ) {
        return finishSiloStage(false);
      }
      if (
        profiledLegendaryCity &&
        options.legendaryEconomyCityTile != null &&
        buildable.canBuild !== options.legendaryEconomyCityTile
      ) {
        return finishSiloStage(false);
      }
      if (
        profiledLegendaryCity &&
        !this.legendaryCityBuildStillWorthIt(buildable, options)
      ) {
        return finishSiloStage(false);
      }
      if (
        economicType &&
        this.buildableCostOrFallback(buildable, perceivedCost) >
          this.availableGoldAfterReserve(type, { includeSam: true })
      ) {
        return finishSiloStage(false);
      }
      if (
        options.nukeDemandRequest &&
        !this.nukeDemandSiloSpawnAllowed(
          options.nukeDemandRequest,
          buildable.canBuild,
        )
      ) {
        return finishSiloStage(false);
      }
      if (
        options.nukePendingLaunchRoute === true &&
        (!this.nuclearSlotPressureQueueEligible() ||
          this.nuclearSlotPressureReadyShotTotal() > 0 ||
          !this.nukePendingLaunchRouteAllowed(buildable.canBuild))
      ) {
        return finishSiloStage(false);
      }
      return finishSiloStage(this.emitStructureBuildable(type, buildable, options));
    }

    async structureSpawnBuildable(type, structures, economicType, options) {
      const profiledLegendaryPort =
        type === UNIT.Port &&
        options.legendaryEconomyPortTile !== null &&
        options.legendaryEconomyPortTile !== undefined;
      const profiledLegendaryFactory =
        type === UNIT.Factory &&
        isLegendaryDifficulty() &&
        options.legendaryEconomyFactoryTile !== null &&
        options.legendaryEconomyFactoryTile !== undefined;
      const profiledLegendaryCity =
        type === UNIT.City &&
        isLegendaryDifficulty() &&
        options.legendaryEconomyCityTile !== null &&
        options.legendaryEconomyCityTile !== undefined;
      // RANK-THEN-PROBE: structureSpawnTile now returns the snapped BuildableUnit
