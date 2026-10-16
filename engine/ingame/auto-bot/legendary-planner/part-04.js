  return validRoutes.map((route) => ({
    travelTicks: Math.max(1, Math.ceil(Number(distanceFor(route)))),
    weight: Number(route.weight) / totalWeight,
  }));
}

function legendaryTradeCohortOwnerId(ownerId) {
  return ownerId === null || ownerId === undefined ? "" : String(ownerId);
}

function legendaryTradeReplacementKey(ownerId, level, readyAtTicks, routes) {
  return `${legendaryTradeCohortOwnerId(ownerId)}|${Math.max(1, Number(level) || 1)}:` +
    `${Math.max(0, Number(readyAtTicks) || 0)}:` +
    legendaryNormalizedTradeRoutes(routes)
      .map((route) => `${route.travelTicks}:${Number(route.weight.toPrecision(15))}`).join(",");
}

function legendarySubstitutedTradePortCohorts(portOwners, replacements) {
  return legendaryTradePortCohorts(portOwners.map((owner) => {
    const ownerId = legendaryTradeCohortOwnerId(owner.ownerId);
    const ports = (owner.ports ?? []).flatMap((group) => {
      const key = legendaryTradeReplacementKey(
        ownerId,
        group.level,
        group.readyAtTicks,
        group.routes,
      );
      const replaced = replacements.reduce(
        (total, replacement) => replacement.ownerId === ownerId &&
            replacement.beforeKey === key
          ? total + 1
          : total,
        0,
      );
      const count = Math.max(0, (Number(group.count) || 0) - replaced);
      return count > 0 ? [{ ...group, count }] : [];
    });
    return ports.length > 0 ? { ...owner, ports } : null;
  }).filter(Boolean));
}

function legendaryTradePortCohorts(portOwners) {
  const cohorts = new Map();
  for (const owner of portOwners) {
    for (const port of owner.ports) {
      const key = `${port.level}:${port.readyAtTicks}`;
      let cohort = cohorts.get(key);
      if (!cohort) {
        cohort = {
          level: port.level,
          readyAtTicks: port.readyAtTicks,
          count: 0,
          routes: new Map(),
        };
        cohorts.set(key, cohort);
      }
      cohort.count += port.count;
      for (const route of port.routes) {
        cohort.routes.set(
          route.travelTicks,
          (cohort.routes.get(route.travelTicks) ?? 0) + route.weight * port.count,
        );
      }
    }
  }
  return [...cohorts.values()].map((cohort) => ({
    level: cohort.level,
    readyAtTicks: cohort.readyAtTicks,
    count: cohort.count,
    routes: [...cohort.routes].map(([travelTicks, weight]) => ({ travelTicks, weight })),
  }));
}

function legendaryCachedRatePrefix(cache, path, key, rateAtTick) {
  if (!Array.isArray(path) || path.length === 0) return null;
  let byKey = cache.get(path);
  if (!byKey) {
    byKey = new Map();
    cache.set(path, byKey);
  }
  let prefix = byKey.get(key);
  if (prefix) return prefix;
  prefix = new Float64Array(path.length);
  for (let tick = 0; tick < path.length - 1; tick++) {
    prefix[tick + 1] = prefix[tick] + Math.max(0, Number(rateAtTick(tick)) || 0);
  }
  byKey.set(key, prefix);
  return prefix;
}

function legendaryTradeRatePrefix(path, level, options) {
  const { fallback, config, rateCache, prefixCache } = options;
  return legendaryCachedRatePrefix(prefixCache, path, level, (tick) =>
    legendaryExpectedTradeRateAtFleet(
      level,
      path[tick] ?? fallback,
      config,
      rateCache,
    ),
  );
}

function legendaryTradeRateDeltaPrefix(
  afterPath,
  beforePath,
  afterLevel,
  beforeLevel,
  options,
) {
  const { fallback, config, rateCache, deltaPrefixCache } = options;
  if (!Array.isArray(afterPath) || !Array.isArray(beforePath)) return null;
  let byBeforePath = deltaPrefixCache.get(afterPath);
  if (!byBeforePath) {
    byBeforePath = new WeakMap();
    deltaPrefixCache.set(afterPath, byBeforePath);
  }
  let byLevel = byBeforePath.get(beforePath);
  if (!byLevel) {
    byLevel = new Map();
    byBeforePath.set(beforePath, byLevel);
  }
  const key = `${afterLevel}:${beforeLevel}`;
  let prefix = byLevel.get(key);
  if (prefix) return prefix;
  prefix = new Float64Array(afterPath.length);
  for (let tick = 0; tick < afterPath.length - 1; tick++) {
    const afterRate = legendaryExpectedTradeRateAtFleet(
      afterLevel,
      afterPath[tick] ?? fallback,
      config,
      rateCache,
    );
    const beforeRate = legendaryExpectedTradeRateAtFleet(
      beforeLevel,
      beforePath[tick] ?? fallback,
      config,
      rateCache,
    );
    prefix[tick + 1] = prefix[tick] + Math.max(0, afterRate - beforeRate);
  }
  byLevel.set(key, prefix);
  return prefix;
}

function legendaryRatePrefixRangeSum(prefix, startTick, endTick) {
  if (
    !prefix || !Number.isFinite(startTick) || !Number.isFinite(endTick) ||
    endTick <= startTick
  ) {
    return 0;
  }
  const last = prefix.length - 1;
  const start = Math.max(0, Math.min(last, Math.floor(startTick)));
  const end = Math.max(start, Math.min(last, Math.floor(endTick)));
  return prefix[end] - prefix[start];
}

function legendaryProjectedTradeRateRangeSum(context, startTick, endTick) {
  if (!Number.isFinite(startTick) || !Number.isFinite(endTick) || endTick <= startTick) {
