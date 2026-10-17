      if (type === UNIT.SAMLauncher && !context.missileSilosEnabled) return;
      if (
        ECONOMIC_STRUCTURE_TYPES.includes(type) &&
        values.upgradeCost === undefined &&
        context.economyCostQuotes instanceof Map &&
        !context.economyCostQuotes.has(type)
      ) return;
      // An upgrade candidate carries the authoritative probe cost: upgrading an
      // existing City must never be pre-rejected (or pre-priced) with the
      // count-scaled formula for constructing another new structure.
      // Productive candidates use the live structure price, not the perceived
      // save-up price: the
      // perceived-cost save-up multiplier priced a second Port at 1M after
      // one Port + two Factories, so the planner's Wait action dominated at
      // every post-Atom-drain treasury level and the fleet economy never
      // got funded (measured on Baikal: candidates present, groups all Wait).
      let cost;
      if (values.upgradeCost !== undefined) {
        cost = legendaryBigInt(values.upgradeCost);
      } else if (ECONOMIC_STRUCTURE_TYPES.includes(type)) {
        cost = this.cost(type, context.economyCostQuotes);
      } else {
        cost = this.getConstructionCost(type);
      }
      const objective = legendaryConstructionObjectiveVector(type, {
        ...context.strategicState,
        costFactor: this.legendaryCostFactor(cost),
      });
      const valuesWithPolicy = { ...values };
      if (ECONOMIC_STRUCTURE_TYPES.includes(type)) {
        const evaluation = values.netTeamGold === undefined
          ? await this.legendaryEconomyEvaluation(type, {
              cost: Number(cost),
              horizonTicks: context.strategicState?.economyHorizonTicks,
              inputs: context.strategicState?.economyInputs,
              config: context.config,
            })
          : null;
        if (values.netTeamGold !== undefined) {
          valuesWithPolicy.netTeamGold = legendaryBigInt(values.netTeamGold);
        } else if (evaluation?.refused === true) {
          // Net value negative by policy; only active troop-cap relief carries
          // a separate City value.
          valuesWithPolicy.netTeamGold = 0n;
        } else if (evaluation) {
          valuesWithPolicy.netTeamGold = BigInt(
            Math.round(evaluation.netTeamGold),
          );
        } else {
          valuesWithPolicy.netTeamGold = 0n;
        }
        if (type === UNIT.Port && values.action !== "upgrade") {
          const seedTile = context.strategicState?.economyInputs?.portSeedSources?.find(
            (source) => source.portSeedStream === "own",
          )?.placementTile;
          const placementTile = values.portPlacementTile !== undefined
            ? values.portPlacementTile
            : evaluation?.portPlacementTile ?? seedTile;
          if (placementTile !== null && placementTile !== undefined) {
            valuesWithPolicy.portPlacementTile = placementTile;
          }
        }
      }
      if (ECONOMIC_STRUCTURE_TYPES.includes(type)) {
        valuesWithPolicy.affordable =
          cost <= this.availableGoldAfterReserve(type, { includeSam: true });
      }
      if (
        type === UNIT.Port &&
        values.seedPair === undefined &&
        context.strategicState?.economyInputs?.portSeedWindowOpen === true &&
        context.strategicState.economyInputs.hasCompletedTradePartner !== true &&
        context.strategicState.economyInputs.portSeedPartnerCommitted !== true
      ) {
        // The deterministic two-owner seed window is the one no-route
        // exception: commit our half even though neither stream pays yet.
        valuesWithPolicy.seedPair = true;
      }
      context.candidates.push({
        type,
        cost,
        typeOrder: context.typeOrder[type],
        ...objective,
        ...valuesWithPolicy,
      });
    }

    samCandidateLaunchGate(type) {
      return (
        type === UNIT.SAMLauncher &&
        !this.hasObservedHostileMissileLaunch() &&
        !this.hydrogenCoverageNeedsSam() &&
        // Big-start doctrine: the city-ratio SAM lane is live on rich boards
        // (engine nations run 0.3/city passively — see the ratio override in
        // addLegendaryRatioCandidate).
        !this.legendaryBigStartGame()
      );
    }

    async addLegendaryRatioCandidate(context, type, values = {}) {
      if (!this.legendaryRatioCandidateNeeded(context, type)) return;
      const ratioConfig = context.ratios[type];
      if (ratioConfig === undefined) return;
      const owned = this.ownedLevels(type);
      // Big-start doctrine (engine NationStructureBehavior: Impossible runs
      // SAM_RATIO 0.3/city): passively reach 4-6 sites by 15-20 cities
      // instead of the reactive single-site scaler alone.
      const ratioPerCity =
        type === UNIT.SAMLauncher && this.legendaryBigStartGame()
          ? 0.3
          : ratioConfig.ratioPerCity;
      const ratio = this.legendaryAdjustedStructureRatio(
        context,
        type,
        owned,
        ratioPerCity,
      );
      if (ratio === null) return;
      const candidateValues = this.legendaryRatioCandidateValues(
        context,
        type,
        values,
        owned,
        ratio,
      );
      if (candidateValues === null) return;
      await this.addLegendaryConstructionCandidate(context, type, candidateValues);
    }

    legendaryRatioCandidateValues(context, type, values, owned, ratio) {
      const ratioTarget = Math.floor(context.cityCount * ratio);
      const state = context.strategicState;
      let target =
        type === UNIT.MissileSilo
          ? Math.max(ratioTarget, state.siloParityTarget)
          : ratioTarget;
      // floor() neutralizes FIRST_MISSILE_SILO_RATIO below 5 cities (0.2/city
      // floors to 0), so the organic first silo sat at deficit:0 and lost
      // every group decision to economy builds on measured Baikal organic
      // runs (15 hostile warheads landed, 0 own silos). A nuclear-capable
      // hostile keeps a real first-silo deficit on the board.
      if (
        type === UNIT.MissileSilo &&
        owned === 0 &&
        context.nukesEnabled === true &&
        state.targetPressure > 0.75
      ) {
        target = Math.max(1, target);
      }
      const deficit = Math.max(0, target - owned);
      const parityGap = type === UNIT.MissileSilo ? state.siloParityGap : 0;
      const strategic = Number(values.strategic || 0) + Math.min(3, parityGap);
      const mandatory =
        Number(values.mandatory || 0) + (parityGap > 0 ? 1 : 0);
      const safety = Number(values.safety || 0);
      if (deficit <= 0 && strategic <= 0 && mandatory <= 0 && safety <= 0) {
        return null;
      }
      return {
        mandatory,
