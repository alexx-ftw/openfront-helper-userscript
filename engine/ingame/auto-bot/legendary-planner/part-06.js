  const candidatePortRoutes = legendaryNormalizedTradeRoutes(candidate?.portRoutes);
  const candidateInboundPortCohorts = (candidate?.portInboundSources ?? []).length > 0
    ? legendaryTradePortCohorts([{
        ports: candidate.portInboundSources.flatMap((source) => {
          const routes = legendaryNormalizedTradeRoutes(source.routes).map(
            ({ travelTicks, weight }) => ({ travelTicks, weight }),
          );
          return routes.length > 0
            ? [{
                level: Math.max(1, Number(source.level) || 1),
                readyAtTicks: Math.max(0, Number(source.readyAtTicks) || 0),
                routes,
                count: 1,
              }]
            : [];
        }),
      }])
    : [];
  const candidateTradeReplacements = (candidate?.portInboundSources ?? [])
    .map((source) => {
      const routes = legendaryNormalizedTradeRoutes(source.routes);
      const beforeRoutes = legendaryNormalizedTradeRoutes(source.beforeRoutes);
      if (routes.length === 0 || beforeRoutes.length === 0) return null;
      const level = Math.max(1, Number(source.level) || 1);
      const readyAtTicks = Math.max(0, Number(source.readyAtTicks) || 0);
      return {
        routes,
      ownerId: legendaryTradeCohortOwnerId(source.ownerId),
      beforeKey: legendaryTradeReplacementKey(
        source.ownerId,
        level,
        readyAtTicks,
        source.beforeRoutes,
      ),
      };
    })
    .filter(Boolean);
  const project = (includeCandidate, only = null) => {
    const includeTrains = only !== "trade";
    const includeTradeShips = only !== "train";
    // Replace each rerouted source's per-owner cohort exactly: single-port
    // cohorts vanish, merged cohorts shed only the replaced member counts.
    const activeTradePortCohorts = !includeCandidate ||
        candidateTradeReplacements.length === 0
      ? tradePortCohorts
      : legendarySubstitutedTradePortCohorts(portOwners, candidateTradeReplacements);
    const activeTradeProducerCohorts = includeCandidate
      ? activeTradePortCohorts.concat(candidateInboundPortCohorts)
      : activeTradePortCohorts;
    // Cohorts are fresh local records and cannot change during this synchronous
    // projection. Normalize once, preserving their iteration and summation order,
    // rather than repeating numeric coercions for every cohort on every tick.
    const normalizedTradeProducerCohorts = activeTradeProducerCohorts.map((port) => ({
      ...port,
      readyAtTicks: Math.max(0, Number(port.readyAtTicks) || 0),
      level: Math.max(0, Math.floor(Number(port.level) || 0)),
    }));
    const tradeRateLevels = new Set();
    for (const port of activeTradeProducerCohorts) {
      tradeRateLevels.add(Math.max(0, Math.floor(Number(port.level) || 0)));
    }
    const candidateUpgradeLevel = Number(candidate?.portUpgradeLevel);
    if (includeCandidate && candidate?.portReadyAt !== undefined) {
      if (Number.isFinite(candidateUpgradeLevel) && candidateUpgradeLevel > 0) {
        tradeRateLevels.add(Math.floor(candidateUpgradeLevel));
        tradeRateLevels.add(Math.floor(candidateUpgradeLevel + 1));
      } else {
        tradeRateLevels.add(1);
      }
    }
    let tradeRateStride = 1;
    for (const level of tradeRateLevels) {
      tradeRateStride = Math.max(tradeRateStride, level + 1);
    }
    const tradeRateLower = includeTradeShips
      ? new Float64Array(tradeRateStride)
      : null;
    const tradeRateUpper = includeTradeShips
      ? new Float64Array(tradeRateStride)
      : null;
    const tradeRateAtLevel = includeTradeShips
      ? new Float64Array(tradeRateStride)
      : null;
    const tradeRatePrefixes = includeTradeShips
      ? new Map([...tradeRateLevels].map((level) => [level, new Float64Array(ticks + 1)]))
      : null;
    let cachedTradeShipStockFloor = -1;
    const refreshTradeRates = (stock) => {
      const lower = Math.floor(Math.max(0, Number(stock) || 0));
      if (lower === cachedTradeShipStockFloor) return;
      for (const level of tradeRateLevels) {
        tradeRateLower[level] = legendaryExpectedTradeRateAtFleet(
          level,
          lower,
          config,
          tradeRateCache,
        );
        tradeRateUpper[level] = legendaryExpectedTradeRateAtFleet(
          level,
          lower + 1,
          config,
          tradeRateCache,
        );
      }
      cachedTradeShipStockFloor = lower;
    };
    const trainCounts = includeTrains ? new Array(ticks + 1) : null;
    const tradeShipCounts = includeTradeShips ? new Array(ticks + 1) : null;
    const trainArrivals = includeTrains && trainLifetime > 0
      ? new Float64Array(ticks + 1)
      : null;
    const tradeShipArrivals = includeTradeShips ? new Float64Array(ticks + 1) : null;
    if (tradeShipArrivals !== null) {
      for (const remaining of supply.initialTradeShipRemainingTicks ?? []) {
        const delay = Number(remaining);
        if (!Number.isFinite(delay)) continue;
        const arrivalTick = Math.max(1, Math.ceil(delay));
        if (arrivalTick <= ticks) tradeShipArrivals[arrivalTick]++;
      }
    }
    const trainRateLower = includeTrains
      ? new Float64Array(trainRateContexts.length * trainRateStride)
      : null;
    const trainRateUpper = includeTrains
      ? new Float64Array(trainRateContexts.length * trainRateStride)
      : null;
    let cachedTrainStockFloor = -1;
    const refreshTrainRates = (stock) => {
      const lower = Math.floor(Math.max(0, Number(stock) || 0));
      if (lower === cachedTrainStockFloor) return;
      for (let contextIndex = 0; contextIndex < trainRateContexts.length; contextIndex++) {
        const context = trainRateContexts[contextIndex];
        const offset = contextIndex * trainRateStride;
        const levels = includeCandidate ? context.levels : context.baseLevels;
        for (const level of levels) {
          trainRateLower[offset + level] = legendaryExpectedTrainRateAtFleet(
            level,
            context.factoryCount,
            lower,
            config,
            trainRateCache,
          );
          trainRateUpper[offset + level] = legendaryExpectedTrainRateAtFleet(
            level,
            context.factoryCount,
            lower + 1,
            config,
            trainRateCache,
          );
        }
      }
      cachedTrainStockFloor = lower;
    };
    const scheduleTradeShipArrivals = (births, routes, tick) => {
      if (!(births > 0) || routes.length === 0) return;
      for (const route of routes) {
        const arrivalTick = tick + route.travelTicks;
        if (arrivalTick <= ticks) {
          tradeShipArrivals[arrivalTick] += births * route.weight;
        }
      }
    };
    // Starting Train ages are hidden by GameView; retain those units conservatively.
    let trains = Math.max(0, Number(inputs.trainCount) || 0);
    let tradeShips = Math.max(0, Number(inputs.tradeShipCount) || 0);
    for (let tick = 0; tick <= ticks; tick++) {
      if (trainArrivals !== null && tick > 0) {
