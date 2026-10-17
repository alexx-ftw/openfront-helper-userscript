    return 0;
  }
  if (!context.prefix) {
    context.prefix = context.upgrade
      ? legendaryTradeRateDeltaPrefix(
        context.path,
        context.beforePath,
        context.level + 1,
        context.level,
        context,
      )
      : legendaryTradeRatePrefix(context.path, context.level, context);
  }
  return legendaryRatePrefixRangeSum(context.prefix, startTick, endTick);
}

// Keep the synchronous API for existing diagnostics and offline arithmetic tests.
function legendaryDrainEconomySteps(iterator) {
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

function legendaryProjectEconomyFleets(inputs, config, horizon, candidate) {
  return legendaryDrainEconomySteps(
    legendaryProjectEconomyFleetsSteps(inputs, config, horizon, candidate),
  );
}

// The generator owns partial arrays until a complete projection publishes them.
// Closing it on cancellation releases suspended local references immediately.
async function legendaryRunEconomyStepsAsync(iterator, {
  isCurrent = () => true,
  sliceMs = 8,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const budget = Number.isFinite(Number(sliceMs)) && Number(sliceMs) >= 0
    ? Number(sliceMs)
    : 8;
  let completed = false;
  let sliceStarted = now();
  try {
    while (true) {
      if (!isCurrent()) return null;
      const step = iterator.next();
      if (!isCurrent()) return null;
      if (step.done) {
        completed = true;
        return step.value;
      }
      if (now() - sliceStarted >= budget) {
        const timerHost = typeof window !== "undefined" &&
            typeof window.setTimeout === "function"
          ? window
          : globalThis;
        await new Promise((resolve) => timerHost.setTimeout(resolve, 0));
        if (!isCurrent()) return null;
        sliceStarted = now();
      }
    }
  } finally {
    if (!completed) iterator.return();
  }
}

// One native game tick per step. Integer Config inputs are linearly mixed at
// fractional expected fleet sizes; this mean-field projection is deterministic
// and avoids assuming a fixed future spawn rate or a guessed ROI constant.
function* legendaryProjectEconomyFleetsSteps(inputs, config, horizon, candidate) {
  const supply = inputs?.fleetProducerSupply;
  if (!supply || typeof supply !== "object") return null;
  const ticks = Math.max(0, Math.ceil(horizon));
  const rateCaches = legendaryEconomyRateCaches(supply, config);
  const tradeRateCache = rateCaches.trade;
  const trainRateCache = rateCaches.train;
  // A consist is two engines plus five cars, and all seven count as Train
  // units for Config.trainSpawnRate and disappear when the consist arrives.
  const configuredLifetime = inputs.trainLifetimeTicks ?? supply.trainLifetimeTicks ??
    (typeof config?.trainStationMaxRange === "function"
      ? Math.ceil(Number(config.trainStationMaxRange()) / 2)
      : 0);
  // shortcut: max station span divided by TrainExecution speed underestimates
  // curved rail routes; upgrade when the client exposes route paths and train ages.
  const trainLifetime = Math.max(0, Math.ceil(Number(configuredLifetime) || 0));
  const trainOwners = (supply.trainOwners ?? []).map((owner) => {
    const groups = new Map();
    for (const factory of owner.factories ?? []) {
      const level = Number(factory.level) || 0;
      const readyAtTicks = Math.max(0, Number(factory.readyAtTicks) || 0);
      const key = `${level}:${readyAtTicks}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { level, readyAtTicks, count: 1 });
    }
    return { ...owner, factories: [...groups.values()] };
  });
  const trainProducerGroups = new Map();
  for (const owner of trainOwners) {
    const factoryCount = Math.max(0, Number(owner.factoryCount) || 0);
    for (const factory of owner.factories) {
      const key = `${Number(owner.isBuilder === true)}:${factoryCount}:` +
        `${factory.level}:${factory.readyAtTicks}`;
      const group = trainProducerGroups.get(key);
      if (group) group.count += factory.count;
      else trainProducerGroups.set(key, {
        factoryCount,
        isBuilder: owner.isBuilder === true,
        ...factory,
      });
    }
  }
  const trainProducers = [...trainProducerGroups.values()];
  const builderTrainOwner = trainOwners.find((owner) => owner.isBuilder === true);
  const hasBuilderTrainOwner = Boolean(builderTrainOwner);
  const trainRateContextsByFactoryCount = new Map();
  const addTrainRateLevel = (factoryCount, level, base = false) => {
    const count = Math.max(0, Number(factoryCount) || 0);
    let context = trainRateContextsByFactoryCount.get(count);
    if (!context) {
      context = { factoryCount: count, levels: new Set(), baseLevels: new Set() };
      trainRateContextsByFactoryCount.set(count, context);
    }
    const normalizedLevel = Math.max(0, Math.floor(Number(level) || 0));
    context.levels.add(normalizedLevel);
    if (base) context.baseLevels.add(normalizedLevel);
  };
  for (const factory of trainProducers) {
    factory.level = Math.max(0, Math.floor(Number(factory.level) || 0));
    addTrainRateLevel(factory.factoryCount, factory.level, true);
    if (factory.isBuilder && candidate?.factoryCountReadyAt !== undefined) {
      addTrainRateLevel(factory.factoryCount + 1, factory.level);
    }
  }
  const candidateBuilderFactoryCount = hasBuilderTrainOwner
    ? Math.max(0, Number(builderTrainOwner.factoryCount) || 0)
    : Math.max(0, Number(candidate?.builderFactoryCount) || 0);
  const candidateUpgradeLevel = Number(candidate?.factoryUpgradeLevel);
  const candidateTrainLevels = Number.isFinite(candidateUpgradeLevel) && candidateUpgradeLevel > 0
    ? [Math.floor(candidateUpgradeLevel), Math.floor(candidateUpgradeLevel + 1)]
    : [1];
  if (candidate?.factoryReadyAt !== undefined) {
    for (const level of candidateTrainLevels) {
      addTrainRateLevel(candidateBuilderFactoryCount, level);
      if (candidate.factoryCountReadyAt !== undefined) {
        addTrainRateLevel(candidateBuilderFactoryCount + 1, level);
      }
    }
  }
  const trainRateContexts = [...trainRateContextsByFactoryCount.values()].map((context) => ({
    ...context,
    levels: [...context.levels],
    baseLevels: [...context.baseLevels],
  }));
  let trainRateStride = 1;
  for (const context of trainRateContexts) {
    for (const level of context.levels) trainRateStride = Math.max(trainRateStride, level + 1);
  }
  const trainRateContextIndexByFactoryCount = new Map(
    trainRateContexts.map((context, index) => [context.factoryCount, index]),
  );
  for (const factory of trainProducers) {
    const baseContext = trainRateContextIndexByFactoryCount.get(factory.factoryCount);
    const addedContext = factory.isBuilder && candidate?.factoryCountReadyAt !== undefined
      ? trainRateContextIndexByFactoryCount.get(factory.factoryCount + 1)
      : baseContext;
    factory.baseRateIndex = baseContext * trainRateStride + factory.level;
    factory.addedRateIndex = addedContext * trainRateStride + factory.level;
  }
  const candidateFactoryBaseContext = trainRateContextIndexByFactoryCount.get(
    candidateBuilderFactoryCount,
  );
  const candidateFactoryAddedContext = candidate?.factoryCountReadyAt !== undefined
    ? trainRateContextIndexByFactoryCount.get(candidateBuilderFactoryCount + 1)
    : candidateFactoryBaseContext;
  const candidateFactoryRateIndices = {
    base: candidateFactoryBaseContext * trainRateStride,
    added: candidateFactoryAddedContext * trainRateStride,
  };
  const candidateUpgradeRateIndices = Number.isFinite(candidateUpgradeLevel) &&
      candidateUpgradeLevel > 0
    ? {
        before: candidateFactoryRateIndices.base + Math.floor(candidateUpgradeLevel),
        after: candidateFactoryRateIndices.base + Math.floor(candidateUpgradeLevel + 1),
        addedBefore: candidateFactoryRateIndices.added + Math.floor(candidateUpgradeLevel),
        addedAfter: candidateFactoryRateIndices.added + Math.floor(candidateUpgradeLevel + 1),
      }
    : null;
  const candidateFactoryRateIndex = candidateFactoryRateIndices.base + 1;
  const candidateAddedFactoryRateIndex = candidateFactoryRateIndices.added + 1;
  const portOwners = (supply.portOwners ?? []).map((owner) => {
    const groups = new Map();
    for (const port of owner.ports ?? []) {
      const level = Number(port.level) || 0;
      const readyAtTicks = Math.max(0, Number(port.readyAtTicks) || 0);
      const sourceRoutes = Array.isArray(port.routes) ? port.routes : [];
      const routes = legendaryNormalizedTradeRoutes(sourceRoutes);
      const routeKey = sourceRoutes.map((route) =>
        `${Number(route?.weight)}:${Number(route?.distance)}`,
      ).join(",");
      const key = `${level}:${readyAtTicks}:${routeKey}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { level, readyAtTicks, routes, count: 1 });
    }
    return { ...owner, ports: [...groups.values()] };
  });
  const tradePortCohorts = legendaryTradePortCohorts(portOwners);
