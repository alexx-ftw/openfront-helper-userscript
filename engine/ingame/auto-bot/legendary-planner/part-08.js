      `${Number(source?.level)}:${Number(source?.readyAtTicks)}:` +
      (source?.routes ?? []).map((route) =>
        `${Number(route?.weight)}:${Number(route?.distance)}`,
      ).join(",") +
      `|${(source?.beforeRoutes ?? []).map((route) =>
        `${Number(route?.weight)}:${Number(route?.distance)}`,
      ).join(",")}`,
    ).join(";");
    const candidateKey = [
      baselineKey,
      candidate.factoryReadyAt,
      candidate.factoryCountReadyAt,
      candidate.factoryUpgradeLevel,
      candidate.builderFactoryCount,
      candidate.portReadyAt,
      candidate.portUpgradeLevel,
      routeKey,
      inboundRouteKey,
    ].join(":");
    after = rateCaches.candidates.get(candidateKey);
    if (!after) {
      if (candidate.factoryReadyAt !== undefined && candidate.portReadyAt === undefined) {
        after = {
          trainCounts: (yield* project(true, "train")).trainCounts,
          tradeShipCounts: before.tradeShipCounts,
        };
      } else if (candidate.portReadyAt !== undefined && candidate.factoryReadyAt === undefined) {
        after = {
          trainCounts: before.trainCounts,
          tradeShipCounts: (yield* project(true, "trade")).tradeShipCounts,
        };
      } else {
        after = yield* project(true);
      }
      rateCaches.candidates.set(candidateKey, after);
    }
  }
  return {
    before,
    after,
    tradeRateCache,
    trainRateCache,
    tradeRatePrefixes: rateCaches.tradePrefixes,
    tradeRateDeltaPrefixes: rateCaches.tradeDeltaPrefixes,
  };
}

function legendaryProjectedCountAt(path, tick, fallback) {
  if (!Array.isArray(path) || path.length === 0) return Math.max(0, Number(fallback) || 0);
  const bounded = Math.max(0, Math.min(path.length - 1, Number(tick) || 0));
  const lower = Math.floor(bounded);
  const upper = Math.min(path.length - 1, lower + 1);
  const fraction = bounded - lower;
  return path[lower] + fraction * (path[upper] - path[lower]);
}

function legendaryIntegrateProjectedPayout(
  source,
  key,
  startAt,
  endAt,
  fallbackRates,
  rateAtTick,
) {
  const start = Math.max(0, Number(startAt) || 0);
  const end = Math.max(start, Number(endAt) || 0);
  let total = 0;
  for (let tick = Math.floor(start); tick < end; tick++) {
    const overlap = Math.max(0, Math.min(end, tick + 1) - Math.max(start, tick));
    if (overlap <= 0) continue;
    total += overlap * rateAtTick(tick) * legendaryPayoutTimelineValue(
      source,
      key,
      tick,
      Array.isArray(source?.payoutTimeline) ? source.payoutTimeline : [],
      fallbackRates,
    );
  }
  return total;
}

function legendaryPortFallbackRoute(profile, fallbackDistance) {
  const activeGold = profile?.teamGoldPerArrival ?? profile?.portTradeGoldPerArrival ?? 0;
  return {
    weight: 1,
    postAllianceWeight: profile?.postAllianceWeight ?? 1,
    distance:
      profile?.routeDelayTicks ?? profile?.portRouteDelayTicks ?? fallbackDistance,
    teamGoldPerArrival: activeGold,
    postAllianceGoldPerArrival:
      profile?.postAllianceGoldPerArrival ??
      profile?.portPostAllianceGoldPerArrival ??
      activeGold,
    allianceTicksRemaining: profile?.allianceTicksRemaining ?? Infinity,
  };
}

// A seed pair already spending gold on construction must never lose its slot
// to a higher-value uncommitted pair on another water component.
function legendarySeedCandidateBeats(candidate, bestSeed) {
  if (bestSeed === null) return true;
  const commitRank = (seed) =>
    (seed.committed === true ? 2 : 0) + (seed.ownInProgress === true ? 1 : 0);
  if (commitRank(candidate) !== commitRank(bestSeed)) {
    return commitRank(candidate) > commitRank(bestSeed);
  }
  const useNetTeamGold =
    Number.isFinite(candidate.expectedNetTeamGold) &&
    Number.isFinite(bestSeed.expectedNetTeamGold);
  const candidateValue = useNetTeamGold ? candidate.expectedNetTeamGold : candidate.value;
  const bestValue = useNetTeamGold ? bestSeed.expectedNetTeamGold : bestSeed.value;
  if (candidateValue !== bestValue) {
    return candidateValue > bestValue;
  }
  return candidate.routeDelay < bestSeed.routeDelay;
}

function legendaryPortRoutes(profile, fallbackDistance) {
  const routes = profile?.routes ?? profile?.portRoutes;
  return Array.isArray(routes) && routes.length > 0
    ? routes
    : [legendaryPortFallbackRoute(profile, fallbackDistance)];
}

function legendaryPortCandidateProjectionSignature(profile) {
  const routeSignature = (routes) => legendaryNormalizedTradeRoutes(routes)
    .map((route) => `${route.travelTicks}:${route.weight}`)
    .join(",");
  const inboundSignatures = (profile?.inboundSources ?? [])
    .map((source) =>
      `${Number(source.level) || 1}:${Number(source.constructionDelayTicks) || 0}:` +
      routeSignature(source.afterProfile?.routes) +
      ":" + routeSignature(source.beforeProfile?.routes),
    )
    .sort();
  return `${routeSignature(profile?.routes ?? profile?.portRoutes)}|${inboundSignatures.join(";")}`;
}

function legendaryPortCandidateInboundSources(inboundSources) {
  return (inboundSources ?? [])
    .map((source) => ({
      ownerId: source.ownerId,
      level: source.level,
      readyAtTicks: source.constructionDelayTicks,
      routes: source.afterProfile?.routes ?? [],
      ...(Array.isArray(source.beforeProfile?.routes) &&
          source.beforeProfile.routes.length > 0
        ? { beforeRoutes: source.beforeProfile.routes }
        : {}),
    }))
    .filter((source) => Array.isArray(source.routes) && source.routes.length > 0);
}

function legendaryPortRate(level, upgrade, tradeShipCount, config) {
  const currentRate = legendaryExpectedTradeShipRatePerTick(
    level,
    tradeShipCount,
    config,
  );
  return upgrade
