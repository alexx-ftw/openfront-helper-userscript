      return (
        selectedStopsRemainEligible &&
        this.legendaryFactorySeedRouteIsolated(
          buildable.canBuild,
          buildable.ghostRailPaths,
          inputs.factoryStationEntries,
          inputs.factoryRailState,
          config,
        ) &&
        this.legendaryFactorySeedPaidStopEndpoints(
          buildable.ghostRailPaths,
          buildable.canBuild,
          [...selectedTileIds],
        ).size === selectedTileIds.size
      );
    }

    legendaryFactorySeedNetPositive(buildable, options, currentState, config) {
      const inputs = currentState.economyInputs;
      const provenStops = new Map([
        [String(buildable.canBuild), new Set(
          options.legendaryEconomyFactorySeedStopTiles.map(String),
        )],
      ]);
      const profiles = this.legendaryFactorySeedRouteProfiles(
        inputs,
        [buildable.canBuild],
        config,
        provenStops,
      );
      return this.legendaryFactoryProfilesNetPositive(
        buildable,
        options,
        currentState,
        config,
        profiles,
      );
    }

    legendaryFactoryProfilesNetPositive(
      buildable,
      options,
      currentState,
      config,
      profiles,
    ) {
      if (profiles.length === 0) return false;
      const inputs = currentState.economyInputs;
      const factoryPaidStops = Math.max(
        0,
        ...profiles.map((profile) => Number(profile.paidStops) || 0),
      );
      const factoryTeamGoldPerTrain = profiles.reduce(
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
        Math.ceil((Number(config?.trainStationMaxRange?.()) || 0) / 2),
      );
      const cost = this.buildableCostOrFallback(
        buildable,
        this.constructionCostForOptions(UNIT.Factory, options),
      );
      const evaluation = legendaryEconomyNetGold(UNIT.Factory, {
        cost: Number(cost),
        horizonTicks: currentState.economyHorizonTicks,
        inputs: {
          ...inputs,
          factoryPaidStops,
          factoryTeamGoldPerTrain,
          factoryRouteProfiles: profiles,
          routeDelayTicks,
        },
        config,
      });
      return (
        evaluation !== null &&
        evaluation.refused !== true &&
        Number.isFinite(Number(evaluation.netTeamGold)) &&
        Number(evaluation.netTeamGold) > 0
      );
    }

    legendaryFactoryRouteNetPositive(buildable, options, currentState, config) {
      const inputs = currentState.economyInputs;
      const stationEntries = Array.isArray(inputs.factoryStationEntries)
        ? inputs.factoryStationEntries
        : [];
      const railState = inputs.factoryRailState;
      if (
        stationEntries.length === 0 ||
        !this.legendaryFactoryRailStateAvailable(railState) ||
        railState.length === 0
      ) {
        return false;
      }
      const clusters = this.assignRailClusters(
        stationEntries.concat([{ tile: buildable.canBuild }]),
        railState,
      );
      if (!Array.isArray(clusters) || clusters.length !== stationEntries.length + 1) {
        return false;
      }
      const clusterId = clusters.at(-1);
      if (clusterId === null || clusterId === undefined) return false;
      const profile = (inputs.factoryRouteProfiles ?? []).find(
        (candidate) =>
          String(candidate?.clusterId) === String(clusterId) &&
          Number(candidate?.factorySourceCount) === 0 &&
          Number(candidate?.paidStops) > 0,
      );
      if (!profile) return false;
      return this.legendaryFactoryProfilesNetPositive(
        buildable,
        options,
        currentState,
        config,
        [{ ...profile, placementTile: buildable.canBuild }],
      );
    }

    legendaryFactoryBuildStillWorthIt(buildable, options) {
      const currentState = this.legendaryConstructionState({
        cityCount: (this.player?.units?.(UNIT.City) ?? []).length,
        hasCoastalTiles: this.hasAnyShoreBorderTile(),
      });
      const config = this.game?.config?.();
      if (!currentState?.economyInputs) return false;
      const selectedSeed = Array.isArray(
        options.legendaryEconomyFactorySeedStopTiles,
      ) && options.legendaryEconomyFactorySeedStopTiles.length > 0;
      return selectedSeed
        ? this.legendaryFactorySeedSelectionStillValid(
            buildable,
            options,
            currentState.economyInputs,
            config,
          ) && this.legendaryFactorySeedNetPositive(
            buildable,
            options,
            currentState,
            config,
          )
        : this.legendaryFactoryRouteNetPositive(
            buildable,
            options,
            currentState,
            config,
          );
