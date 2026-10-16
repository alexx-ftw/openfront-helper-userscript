        (best, profile) => Math.max(
          best,
          Number(profile.teamGoldPerSpawn) || 0,
          Number(profile.postTeamGoldPerSpawn) || 0,
          Number(profile.teamGoldAfterPendingPerSpawn) || 0,
          Number(profile.postTeamGoldAfterPendingPerSpawn) || 0,
          ...(profile.payoutTimeline ?? []).flatMap((point) => [
            Number(point.teamGoldPerSpawn) || 0,
            Number(point.teamGoldAfterPendingPerSpawn) || 0,
          ]),
        ),
        0,
      );
      const routeDelayTicks = Math.max(
        Number(inputs.routeDelayTicks) || 0,
        Math.ceil((Number(context.config?.trainStationMaxRange?.()) || 0) / 2),
      );
      const evaluation = legendaryEconomyNetGold(UNIT.Factory, {
        cost: Number(cost),
        horizonTicks: context.strategicState?.economyHorizonTicks,
        inputs: {
          ...inputs,
          factoryPaidStops,
          factoryTeamGoldPerTrain,
          factoryRouteProfiles: candidateProfiles,
          routeDelayTicks,
        },
        config: context.config,
      });
      if (
        !evaluation ||
        evaluation.refused === true ||
        evaluation.netTeamGold <= 0 ||
        evaluation.factoryPlacementTile === null ||
        evaluation.factoryPlacementTile === undefined
      ) {
        return;
      }
      const selectedProfile = candidateProfiles.find(
        (profile) =>
          String(profile.placementTile) === String(evaluation.factoryPlacementTile),
      );
      if (!selectedProfile) return;
      this.addLegendaryConstructionCandidate(context, UNIT.Factory, {
        netTeamGold: BigInt(Math.round(evaluation.netTeamGold)),
        factoryPlacementTile: evaluation.factoryPlacementTile,
        ...(Array.isArray(selectedProfile.factorySeedStopTiles)
          ? { factorySeedStopTiles: selectedProfile.factorySeedStopTiles }
          : {}),
        ...(Array.isArray(selectedProfile.factorySeedStops)
          ? { factorySeedStops: selectedProfile.factorySeedStops }
          : {}),
        mandatory: 0,
        safety: 0,
        capacity: 0,
        strategic: context.strategicState.railNeed > 1.25 ? 1 : 0,
        deficit: 1,
        efficiency: 1,
      });
    }

    legendaryNovelPortCandidateProfiles(inputs) {
      const profiles = inputs?.portCandidateProfiles ?? [];
      const sharedWater = this.game?.sharedWaterComponents?.(this.player);
      if (profiles.length === 0 || !sharedWater?.size) return [];
      const servedComponents = this.legendaryServedPortWaterComponents();
      return profiles.filter((profile) =>
        this.legendaryPortCandidateIsNovel(profile, sharedWater, servedComponents),
      );
    }

    legendaryServedPortWaterComponents() {
      const servedComponents = new Set();
      for (const port of this.player?.units?.(UNIT.Port) ?? []) {
        if (this.portIsUsable(port)) {
          for (const component of this.portWaterComponents(port?.tile?.())) {
            servedComponents.add(component);
          }
        }
      }
      return servedComponents;
    }

    legendaryPortCandidateIsNovel(profile, sharedWater, servedComponents) {
      if (
        profile?.placementTile === null ||
        profile?.placementTile === undefined ||
        !Array.isArray(profile.routes) ||
        profile.routes.length === 0
      ) {
        return false;
      }
      const components = Array.isArray(profile.waterComponents)
        ? profile.waterComponents
        : this.portWaterComponents(profile.placementTile);
      return [...components].some(
        (component) =>
          sharedWater.has(component) && !servedComponents.has(component),
      );
    }

    addLegendaryPortRouteCandidates(context) {
      const inputs = context.strategicState?.economyInputs;
      if (
        inputs?.portSeedWindowOpen === true &&
        inputs?.hasCompletedTradePartner !== true
      ) {
        const ownCost = context.economyCostQuotes?.get(UNIT.Port);
        const partnerCost = inputs.portSeedPartnerCommitted === true
          ? 0n
          : inputs.portSeedPartnerCost;
        const seedSources = inputs.portSeedSources;
        if (
          typeof ownCost !== "bigint" ||
          typeof partnerCost !== "bigint" ||
          !Array.isArray(seedSources) ||
          seedSources.length !== 2
        ) return;
        const evaluation = legendaryEconomyNetGold(UNIT.Port, {
          cost: Number(ownCost + partnerCost),
          horizonTicks: context.strategicState?.economyHorizonTicks,
          inputs: { ...inputs, portSeedPartnerCommitted: true },
          config: context.config,
        });
        if (
          evaluation === null ||
          evaluation.refused === true ||
          !(evaluation.netTeamGold > 0) ||
          evaluation.portPlacementTile === null ||
          evaluation.portPlacementTile === undefined
        ) return;
        this.addLegendaryConstructionCandidate(context, UNIT.Port, {
          netTeamGold: BigInt(Math.round(evaluation.netTeamGold)),
          portPlacementTile: evaluation.portPlacementTile,
          seedPair: true,
          mandatory: 0,
          safety: 0,
          capacity: 0,
          strategic: context.strategicState.tradeNeed > 1.25 ? 1 : 0,
          deficit: 1,
          efficiency: 1,
        });
        return;
      }

      const novelProfiles = this.legendaryNovelPortCandidateProfiles(inputs);
      if (novelProfiles.length === 0) return;

      const cost = context.economyCostQuotes?.get(UNIT.Port) ??
        this.cost(UNIT.Port);
      const evaluation = legendaryEconomyNetGold(UNIT.Port, {
        cost: Number(cost),
        horizonTicks: context.strategicState?.economyHorizonTicks,
        inputs: { ...inputs, portCandidateProfiles: novelProfiles },
        config: context.config,
      });
      const usableEvaluation = evaluation !== null &&
        evaluation.refused !== true &&
        evaluation.portPlacementTile !== null &&
        evaluation.portPlacementTile !== undefined;
