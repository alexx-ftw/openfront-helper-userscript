
      // DIVERGENCE: only this builder's usable Ports suppress a shared-water route; teammate Ports may seed its new owner-pair route.
      await this.addLegendaryConstructionCandidate(context, UNIT.Port, {
        netTeamGold: usableEvaluation
          ? BigInt(Math.round(evaluation.netTeamGold))
          : 0n,
        ...(usableEvaluation
          ? { portPlacementTile: evaluation.portPlacementTile }
          : {}),
        mandatory: 0,
        safety: 0,
        capacity: 0,
        strategic: context.strategicState.tradeNeed > 1.25 ? 1 : 0,
        deficit: 1,
        efficiency: 1,
      });
    }

    async addLegendaryCityCandidates(
      candidateContext,
      { citiesDisabled, cityCount, capPressure, strategicState },
    ) {
      if (citiesDisabled) return;
      await this.addLegendaryConstructionCandidate(candidateContext, UNIT.City, {
        mandatory: cityCount < 2 ? 1 : 0,
        safety: 0,
        capacity: capPressure ? 1 : 0,
        strategic: strategicState.railNeed > 1.25 ? 1 : 0,
        deficit: Math.max(0, Math.ceil(strategicState.railNeed - 1)),
        efficiency: 1,
      });
      const cityUpgrade = capPressure
        ? this.legendaryCityUpgradeCandidateInfo()
        : null;
      if (cityUpgrade === null) return;
      await this.addLegendaryConstructionCandidate(candidateContext, UNIT.City, {
        action: "upgrade",
        upgradeStructureId: cityUpgrade.structureId,
        upgradeCost: cityUpgrade.cost,
        netTeamGold: -legendaryBigInt(cityUpgrade.cost),
        mandatory: 0,
        safety: 0,
        capacity: 1,
        strategic: 0,
        deficit: 1,
        efficiency: 1,
      });
    }

    legendaryCityRailClusterTiles(inputs) {
      const stationEntries = inputs?.factoryStationEntries;
      const railState = inputs?.factoryRailState;
      if (
        !Array.isArray(stationEntries) ||
        stationEntries.length === 0 ||
        !railState ||
        railState.length === 0
      ) {
        return null;
      }
      const tiles = this.structureCandidateTiles(
        UNIT.City,
        {},
        ECONOMIC_INITIAL_PLACEMENT_CANDIDATE_LIMIT,
      );
      if (tiles.length === 0) return null;
      const clusters = this.assignRailClusters(
        stationEntries.concat(tiles.map((tile) => ({ tile }))),
        railState,
      );
      if (
        !Array.isArray(clusters) ||
        clusters.length !== stationEntries.length + tiles.length
      ) {
        return null;
      }
      const tileByCluster = new Map();
      for (let index = 0; index < tiles.length; index++) {
        const cluster = clusters[stationEntries.length + index];
        if (cluster === null || cluster === undefined) continue;
        const key = String(cluster);
        if (!tileByCluster.has(key)) tileByCluster.set(key, tiles[index]);
      }
      return tileByCluster;
    }

    async legendaryBestCityRoute(context, candidate, inputs, profiles, tileByCluster) {
      let best = null;
      for (const profile of profiles) {
        const clusterId = String(profile.clusterId ?? "");
        if (!clusterId.startsWith("rail#")) continue;
        const placementTile = tileByCluster.get(clusterId);
        if (placementTile === undefined) continue;
        const evaluation = await this.legendaryEconomyEvaluation(UNIT.City, {
          cost: Number(candidate.cost),
          horizonTicks: context.strategicState?.economyHorizonTicks,
          inputs: { ...inputs, trainSources: profile.trainSources },
          config: context.config,
        });
        if (
          !evaluation ||
          evaluation.refused === true ||
          evaluation.netTeamGold <= 0
        ) {
          continue;
        }
        if (best === null || evaluation.netTeamGold > best.netTeamGold) {
          best = { netTeamGold: evaluation.netTeamGold, placementTile };
        }
      }
      return best;
    }

    async addLegendaryCityRouteCandidates(context) {
      const candidate = context.candidates.find(
        (entry) => entry.type === UNIT.City && entry.action !== "upgrade",
      );
      if (!candidate) return;
      const inputs = context.strategicState?.economyInputs;
      const profiles = inputs?.cityRouteProfiles;
      if (!Array.isArray(profiles) || profiles.length === 0) return;
      candidate.netTeamGold = 0n;
      const tileByCluster = this.legendaryCityRailClusterTiles(inputs);
      if (!tileByCluster) return;
      const best = await this.legendaryBestCityRoute(
        context,
        candidate,
        inputs,
        profiles,
        tileByCluster,
      );
      if (best === null) return;
      candidate.netTeamGold = BigInt(Math.round(best.netTeamGold));
      candidate.cityPlacementTile = best.placementTile;
    }

    legendarySamCandidateSafety(strategicState) {
      const missileSafety = strategicState.missileThreat.critical
        ? Math.max(strategicState.defenseGap, strategicState.missileThreat.score)
        : strategicState.missileThreat.score;
      return Math.max(strategicState.samLevelParityGap, missileSafety);
    }

    async addLegendaryConstructionCandidate(context, type, values = {}) {
      if (this.legendaryConstructionCandidateBlocked(context, type)) return;
      // Huge-start burst window (25MM): the planner's parity-driven silo
      // candidate outranked the port burst at tick ~758 on measured rows (a
      // third silo path around the arsenal deferral) — drop silo candidates
      // until the burst lands (see legendaryBigStartSiloDeferred). 5MM keeps
      // its silo timing: the suppression cost 5MM its nuclear deterrence and
      // naval economy (trades 73->41) while only 25MM benefited.
      if (this.legendaryBigStartSiloCandidateBlocked(type)) return;
      if (
        type === UNIT.Port &&
        !this.legendaryPortCapable(context.hasOceanPortTiles, context.hasCoastalTiles)
      ) {
        return;
      }
      const missileType = type === UNIT.SAMLauncher || type === UNIT.MissileSilo;
      if (!context.nukesEnabled && missileType) return;
