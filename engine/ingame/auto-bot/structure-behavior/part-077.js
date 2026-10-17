        this.player.buildables(undefined, ECONOMIC_STRUCTURE_TYPES),
        STRUCTURE_PROBE_TIMEOUT_MS,
        null,
      );
      for (const buildable of Array.isArray(buildables) ? buildables : []) {
        if (
          ECONOMIC_STRUCTURE_TYPES.includes(buildable?.type) &&
          typeof buildable.cost === "bigint"
        ) {
          economyCostQuotes.set(buildable.type, buildable.cost);
        }
      }
      const portSeedInputs = strategicState.economyInputs;
      if (
        portSeedInputs?.portSeedWindowOpen === true &&
        portSeedInputs.portSeedPartnerCommitted !== true
      ) {
        const partnerSeed = portSeedInputs.portSeedSources?.find(
          (source) => source.portSeedStream === "partner",
        );
        strategicState.economyInputs = {
          ...portSeedInputs,
          portSeedPartnerCost:
            await this.legendaryPortSeedPartnerBuildCostQuote(partnerSeed),
        };
      }
      const typeOrder = {
        [UNIT.City]: 0,
        [UNIT.Port]: 1,
        [UNIT.Factory]: 2,
        [UNIT.SAMLauncher]: 3,
        [UNIT.MissileSilo]: 4,
      };
      const candidates = [];
      const candidateContext = {
        candidates,
        config,
        hasCoastalTiles,
        hasOceanPortTiles,
        missileSilosEnabled,
        nukesEnabled,
        economyCostQuotes,
        strategicState,
        typeOrder,
      };
      // Troops at the cap lose every further troop-second of production. A
      // City build or upgrade is the only ranked action that raises maxTroops,
      // so it carries the `capacity` priority while the pressure holds.
      const capPressure = this.computeTroopCapPressure(false);

      await this.addLegendaryCityCandidates(candidateContext, {
        citiesDisabled,
        cityCount,
        capPressure,
        strategicState,
      });
      await this.addLegendaryCityRouteCandidates(candidateContext);
      for (const upgrade of throughputUpgrades) {
        await this.addLegendaryConstructionCandidate(candidateContext, upgrade.type, upgrade);
      }

      const ratios = getStructureRatios(Difficulty.Legendary);
      const ratioContext = {
        ...candidateContext,
        cityCount,
        hasCoastalTiles,
        ratios,
      };

      await this.addLegendaryPortRouteCandidates(ratioContext);
      await this.addLegendaryFactoryRouteCandidates(ratioContext);
      await this.addLegendaryRatioCandidate(ratioContext, UNIT.SAMLauncher, {
        mandatory:
          (strategicState.missileThreat.critical ? 1 : 0) +
          (strategicState.samLevelParityGap > 0 ? 1 : 0),
        safety: this.legendarySamCandidateSafety(strategicState),
        strategic: strategicState.missileThreat.score > 0 ? 2 : 0,
      });
      await this.addLegendaryRatioCandidate(ratioContext, UNIT.MissileSilo, {
        strategic: strategicState.targetPressure > 0.75 ? 1 : 0,
      });

      return candidates;
    }

    legendaryFactorySeedPaidStopEndpoints(ghostRailPaths, placementTile, stopTiles) {
      const paidStops = new Set((stopTiles ?? []).map(String));
      const linkedStops = new Set();
      for (const path of Array.isArray(ghostRailPaths) ? ghostRailPaths : []) {
        if (!Array.isArray(path) || path.length < 2) continue;
        const first = String(path[0]);
        const last = String(path[path.length - 1]);
        const placement = String(placementTile);
        const stopTile = first === placement
          ? last
          : last === placement
            ? first
            : null;
        if (stopTile !== null && paidStops.has(stopTile)) linkedStops.add(stopTile);
      }
      return linkedStops;
    }

    legendaryFactorySeedRouteIsolated(
      placementTile,
      ghostRailPaths,
      stationEntries,
      railState,
      config,
    ) {
      const stations = Array.isArray(stationEntries) ? stationEntries : [];
      const paths = Array.isArray(ghostRailPaths) ? ghostRailPaths : [];
      const stationTiles = new Set(stations.map((entry) => String(entry.tile)));
      const crossesStation = paths.some(
        (path) =>
          Array.isArray(path) &&
          path.some((tile) => stationTiles.has(String(tile))),
      );
      return (
        !crossesStation &&
        this.legendaryFactorySeedPlacementIsolated(
          placementTile,
          stations,
          railState,
          config,
        ) &&
        this.legendaryFactorySeedPathAvoidsRails(paths, railState)
      );
    }

    legendaryFactoryRailStateAvailable(railState) {
      const arrayLike = Array.isArray(railState) ||
        (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(railState));
      const expectedLength =
        Number(this.game?.width?.()) * Number(this.game?.height?.());
      return (
        arrayLike &&
        Number.isSafeInteger(expectedLength) &&
        expectedLength > 0 &&
        Number.isInteger(railState.length) &&
        railState.length === expectedLength
      );
    }

    legendaryFactorySeedPlacementIsolated(placementTile, stations, railState, config) {
      if (stations.length === 0) return true;
      if (!this.legendaryFactoryRailStateAvailable(railState)) return false;
      const maxRange = Math.max(
        0,
        Number(config?.trainStationMaxRange?.()) || 0,
      );
      const maxRangeSquared = maxRange * maxRange;
      if (
        stations.some(
          (entry) =>
            this.game.euclideanDistSquared(placementTile, entry.tile) <=
            maxRangeSquared,
        )
      ) {
        return false;
