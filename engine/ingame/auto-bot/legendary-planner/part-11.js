    let portReadyAt;
    if (inputs.upgradeAction === true && portHasRouteProfiles) {
      portReadyAt = actionReadyTicks;
    } else if (inputs.hasCompletedTradePartner === true || portHasRouteProfiles) {
      portReadyAt = constructionDelayTicks;
    } else if (
      inputs.portSeedPartnerCommitted === true &&
      Array.isArray(inputs.portSeedSources) && inputs.portSeedSources.length > 0
    ) {
      portReadyAt = Math.max(
        constructionDelayTicks,
        ...inputs.portSeedSources.map((source) =>
          Math.max(0, Number(source.constructionDelayTicks ?? constructionDelayTicks) || 0),
        ),
      );
    }
    if (portReadyAt !== undefined) {
      const upgradeId = String(inputs.upgradeStructureId ?? "");
      const upgradeProfile = inputs.portUpgradeProfile ??
        inputs.portUpgradeProfiles?.[upgradeId];
      portProjectionProfile = inputs.upgradeAction === true
        ? upgradeProfile
        : inputs.portProjectionProfile ?? inputs.portCandidateProfiles?.[0];
      const ownSeedRoutes = Array.isArray(inputs.portSeedSources)
        ? inputs.portSeedSources.find((source) => source.portSeedStream === "own")?.routes
        : undefined;
      const inboundPortSources = legendaryPortCandidateInboundSources(
        portProjectionProfile?.inboundSources,
      );
      if (inputs.portSeedPartnerCommitted === true) {
        const pairReadyTicks = Math.max(
          portReadyAt,
          ...(inputs.portSeedSources ?? []).map((source) =>
            Math.max(0, Number(source.constructionDelayTicks ?? 0) || 0),
          ),
        );
        for (const source of inputs.portSeedSources ?? []) {
          if (source.portSeedStream !== "partner") continue;
          inboundPortSources.push({
            level: source.level,
            readyAtTicks: pairReadyTicks,
            routes: source.routes,
          });
        }
      }
      candidateFleetSupply = {
        portReadyAt,
        portRoutes: portProjectionProfile?.routes ?? inputs.portRoutes ?? ownSeedRoutes,
        portInboundSources: inboundPortSources,
        portUpgradeLevel: inputs.upgradeAction === true
          ? Math.max(1, Math.floor(Number(inputs.portUpgradeLevel) || 1))
          : undefined,
      };
    }
  }
  let fleetProjection = legendaryProjectEconomyFleets(
    inputs,
    config,
    horizon,
    type === "Port" && inputs.upgradeAction !== true ? null : candidateFleetSupply,
  );
  const projectedTrainRate = (level, factoryCount, path, tick) =>
    legendaryExpectedTrainRateAtFleet(
      level,
      factoryCount,
      legendaryProjectedCountAt(path, tick, inputs.trainCount),
      config,
      fleetProjection?.trainRateCache,
    );

  let incomePerTick;
  let portPlacementTile;
  let factoryPlacementTile;
  if (type === "Factory" || type === "City") {
    if (typeof config?.trainSpawnRate !== "function") return null;
    const trainCount = Math.max(0, Math.floor(Number(inputs.trainCount ?? 0)));
    const sources = Array.isArray(inputs.trainSources) ? inputs.trainSources : [];
    const actionReadyTicks = constructionDelayTicks + routeDelayTicks;
    if (type === "Factory") {
      const destinations = Math.max(
        0,
        Math.floor(Number(inputs.factoryPaidStops ?? 0)),
      );
      const goldPerTrain = Math.max(
        0,
        Number(inputs.factoryTeamGoldPerTrain ?? 0),
      );
      if (destinations <= 0) return { refused: true };
      if (goldPerTrain <= 0) return null;
      const ownerFactoryCount = Math.max(
        0,
        Math.floor(Number(inputs.ownFactoryCount ?? 0)),
      );
      const productiveLevels = Array.isArray(inputs.ownProductiveFactoryLevels)
        ? inputs.ownProductiveFactoryLevels
        : [];
      const ownPendingLevels = Array.isArray(inputs.ownPendingFactoryLevels)
        ? inputs.ownPendingFactoryLevels
        : [];
      const factoryGoldForTicks = (cluster, productionDelta, startAt = 0) => {
        const start = Math.max(0, Number(startAt) || 0);
        const stopsReady = Math.max(
          0,
          Number(cluster.pendingStopDelayTicks ?? 0) || 0,
        );
        const before = Math.max(0, Number(cluster.teamGoldPerSpawn ?? goldPerTrain) || 0);
        const beforePost = Math.max(
          0,
          Number(cluster.postTeamGoldPerSpawn ?? before) || 0,
        );
        const after = Math.max(
          0,
          Number(cluster.teamGoldAfterPendingPerSpawn ?? before) || 0,
        );
        const afterPost = Math.max(
          0,
          Number(
            cluster.postTeamGoldAfterPendingPerSpawn ??
              cluster.postTeamGoldPerSpawn ??
              after,
          ) || 0,
        );
        const integrate = (key, from, to, rates) => typeof productionDelta === "function"
          ? legendaryIntegrateProjectedPayout(
              cluster,
              key,
              from,
              to,
              rates,
              productionDelta,
            )
          : productionDelta * legendaryIntegratePayoutTimeline(
              cluster,
              key,
              from,
              to,
              rates,
            );
        const beforeStopGold = integrate(
          "teamGoldPerSpawn",
          start,
          Math.min(horizon, stopsReady),
          { current: before, post: beforePost },
        );
        const afterStopGold = integrate(
          "teamGoldAfterPendingPerSpawn",
          Math.max(start, stopsReady),
          horizon,
          { current: after, post: afterPost },
        );
        return beforeStopGold + afterStopGold;
      };
      const denominatorFor = (factoryCount) =>
        Math.max(1, Number(config.trainSpawnRate(factoryCount, trainCount)) || 1);
      const upgrade = inputs.upgradeAction === true ? inputs.factoryUpgrade : null;
      // The engine reads the owner's global Factory count for every spawn
      // roll, so a build/upgrade also slows productive Factories in other
      // rail clusters. Score every cluster's rate change with its own route
      // payout instead of only the target cluster.
