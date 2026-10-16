    }

    legendaryCityBuildStillWorthIt(buildable, options) {
      const currentState = this.legendaryConstructionState({
        cityCount: (this.player?.units?.(UNIT.City) ?? []).length,
        hasCoastalTiles: this.hasAnyShoreBorderTile(),
      });
      if (
        options.legendaryEconomyCityCapRelief === true &&
        this.computeTroopCapPressure(false)
      ) {
        return true;
      }
      return this.legendaryCityRouteStillWorthIt(
        buildable,
        options,
        currentState,
      );
    }

    legendaryCityRouteStillWorthIt(buildable, options, currentState) {
      const tile = options.legendaryEconomyCityTile;
      if (tile === null || tile === undefined) return false;
      const inputs = currentState?.economyInputs;
      const config = this.game?.config?.();
      if (!inputs || !config) return false;
      const cost = this.buildableCostOrFallback(
        buildable,
        this.constructionCostForOptions(UNIT.City, options),
      );
      const tileByCluster = this.legendaryCityRailClusterTiles(inputs);
      if (!tileByCluster) return false;
      const best = this.legendaryBestCityRoute(
        { strategicState: currentState, config },
        { cost },
        inputs,
        inputs.cityRouteProfiles,
        tileByCluster,
      );
      return (
        best !== null &&
        best.placementTile === tile &&
        best.netTeamGold > 0
      );
    }

    legendaryPortBuildSnapshot(buildable, options) {
      const currentState = this.legendaryConstructionState({
        cityCount: (this.player?.units?.(UNIT.City) ?? []).length,
        hasCoastalTiles: this.hasAnyShoreBorderTile(),
      });
      const inputs = currentState?.economyInputs;
      const config = this.game?.config?.();
      if (!inputs || !config) return null;
      const cost = this.buildableCostOrFallback(
        buildable,
        this.constructionCostForOptions(UNIT.Port, options),
      );
      const evaluationFor = (portInputs, totalCost = Number(cost)) => legendaryEconomyNetGold(UNIT.Port, {
        cost: totalCost,
        horizonTicks: currentState.economyHorizonTicks,
        inputs: portInputs,
        config,
      });
      return { inputs, cost, evaluationFor };
    }

    async legendaryPortBuildStillWorthIt(buildable, options) {
      const snapshot = this.legendaryPortBuildSnapshot(buildable, options);
      if (!snapshot) return false;
      const { inputs, evaluationFor } = snapshot;
      const tile = options.legendaryEconomyPortTile;
      const selectedOwnSeed = inputs.portSeedSources?.find(
        (source) => source.portSeedStream === "own" && source.placementTile === tile,
      );
      if (inputs.portSeedWindowOpen === true && selectedOwnSeed) {
        const partnerSeed = inputs.portSeedSources?.find(
          (source) => source.portSeedStream === "partner",
        );
        const quotedPartner = this.legendaryPortSeedPartner(partnerSeed?.portSeedWaterComponent);
        const partnerCost = inputs.portSeedPartnerCommitted === true
          ? 0n
          : await this.legendaryPortSeedPartnerBuildCostQuote(partnerSeed);
        // Worker pricing can outlive the selected network or remaining horizon.
        const fresh = this.legendaryPortBuildSnapshot(buildable, options);
        if (typeof partnerCost !== "bigint" || !fresh) return false;
        if (!this.legendaryPortSeedQuoteStillValid(partnerSeed, quotedPartner, fresh.inputs)) return false;
        return this.legendaryPortSeedBuildStillWorthIt(
          tile, fresh.inputs, fresh.evaluationFor, Number(fresh.cost + partnerCost),
        );
      }
      const profiles = this.legendaryNovelPortCandidateProfiles(inputs).filter(
        (profile) => profile.placementTile === tile,
      );
      if (profiles.length === 0) return false;
      const evaluation = evaluationFor({ ...inputs, portCandidateProfiles: profiles });
      return (
        evaluation !== null &&
        evaluation.refused !== true &&
        evaluation.netTeamGold > 0 &&
        evaluation.portPlacementTile === tile
      );
    }

    legendaryPortSeedQuoteStillValid(partnerSeed, quotedPartner, inputs) {
      if (inputs.portSeedWindowOpen !== true) return false;
      const freshSeed = inputs.portSeedSources?.find(
        (source) => source.portSeedStream === "partner",
      );
      if (!freshSeed) return false;
      if (freshSeed.placementTile !== partnerSeed?.placementTile) return false;
      if (freshSeed.portSeedWaterComponent !== partnerSeed?.portSeedWaterComponent) return false;
      if (!this.legendaryPortSeedWindowOpen(freshSeed.portSeedWaterComponent)) return false;
      const freshPartner = this.legendaryPortSeedPartner(freshSeed.portSeedWaterComponent);
      return Boolean(quotedPartner && freshPartner && quotedPartner.smallID() === freshPartner.smallID());
    }

    legendaryPortSeedBuildStillWorthIt(tile, inputs, evaluationFor, totalCost) {
      const ownSeed = inputs.portSeedSources?.find(
        (source) => source.portSeedStream === "own",
      );
      const partnerSeed = inputs.portSeedSources?.find(
        (source) => source.portSeedStream === "partner",
      );
      if (
        ownSeed?.placementTile !== tile ||
        partnerSeed?.portSeedWaterComponent !== ownSeed.portSeedWaterComponent
      ) return false;
      const evaluation = evaluationFor(
        { ...inputs, portSeedPartnerCommitted: true },
        totalCost,
      );
      return (
        evaluation !== null &&
        evaluation.refused !== true &&
        evaluation.netTeamGold > 0 &&
        evaluation.portPlacementTile === tile
      );
    }

    async legendaryPortSeedPartnerBuildCostQuote(partnerSeed) {
      const partner = this.legendaryPortSeedPartner(
        partnerSeed?.portSeedWaterComponent,
      );
      if (typeof partner?.buildables !== "function") return null;
      const partnerTile = partnerSeed?.placementTile;
      if (partnerTile === null || partnerTile === undefined) return null;
      try {
        const quotes = await withTimeout(
          partner.buildables(partnerTile, [UNIT.Port]),
          STRUCTURE_PROBE_TIMEOUT_MS,
          null,
        );
        const buildable = Array.isArray(quotes)
          ? quotes.find(
              (entry) =>
                entry?.type === UNIT.Port && entry.canBuild === partnerTile,
            )
          : null;
        return buildable?.canBuild === partnerTile &&
          typeof buildable.cost === "bigint"
          ? buildable.cost
          : null;
      } catch {
        return null;
      }
    }

    // maybeSpawnStructure — NationStructureBehavior.ts:585 (now async).
    async maybeSpawnStructure(type, options = {}) {
      const siloStage = (lane) => {
        if (type === UNIT.MissileSilo) this.debugStructureLaneCount(lane);
      };
      const finishSiloStage = (result) => {
        siloStage("laneSiloStageResult");
