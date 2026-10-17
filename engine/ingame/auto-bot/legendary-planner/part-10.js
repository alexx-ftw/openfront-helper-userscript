function legendaryPortExpectedGold(profile, options) {
  const horizon = Number(options.horizon);
  const startDelay = Number(options.startDelayTicks ?? 0);
  if (!Number.isFinite(horizon) || horizon <= 0 || !Number.isFinite(startDelay)) return 0;
  const routes = legendaryPortRoutes(profile, options.fallbackDistance);
  const rate = typeof options.rateAtTick === "function"
    ? options.rateAtTick
    : legendaryPortRate(
        options.level,
        options.upgrade,
        options.tradeShipCount,
        options.config,
      );
  if (routes.length === 1) {
    const route = routes[0];
    const before = Math.max(0, Number(route.weight) || 0);
    const after = Math.max(0, Number(route.postAllianceWeight ?? route.weight) || 0);
    if (Number.isFinite(before + after) && before > 0 && after > 0) {
      return legendaryPortRouteGold(
        route, rate, before, after, startDelay,
        options.horizon, options.rateRangeSum,
      );
    }
  }
  // All routes share one destination denominator. Sweep its expiry changes
  // together with weighted-payout arrivals instead of scanning every route at
  // every expiry. At most two events per route keep prefix work O(R log R).
  const events = new Map();
  const addEvent = (at, weight, payout) => {
    if (!(at >= 0 && at < horizon)) return;
    const event = events.get(at) ?? { weight: 0, payout: 0 };
    event.weight += weight;
    event.payout += payout;
    events.set(at, event);
  };
  let totalWeight = 0;
  for (const route of routes) {
    const before = Math.max(0, Number(route.weight) || 0);
    const after = Math.max(0, Number(route.postAllianceWeight ?? route.weight) || 0);
    const gold = Math.max(0, Number(route.teamGoldPerArrival ?? 0));
    const postGold = Math.max(0, Number(route.postAllianceGoldPerArrival ?? gold));
    const start = Math.max(0, startDelay +
      Math.max(0, Number(route.distance) || 0));
    const rawExpiry = Number(route.allianceTicksRemaining ?? Infinity);
    const expiry = Number.isNaN(rawExpiry) ? 0 : Math.max(0, rawExpiry);
    // Invalid profile arithmetic must not poison an otherwise finite sweep.
    if (![before, after, gold, postGold, start].every(Number.isFinite)) return 0;
    const beforePayout = before * gold;
    const afterPayout = after * postGold;
    if (!Number.isFinite(beforePayout + afterPayout)) return 0;
    totalWeight += expiry === 0 ? after : before;
    addEvent(start, 0, start < expiry ? beforePayout : afterPayout);
    if (expiry > 0) {
      addEvent(expiry, after - before, start < expiry ? afterPayout - beforePayout : 0);
    }
  }
  const boundaries = [...new Set([0, ...events.keys(), horizon])].sort((a, b) => a - b);
  let weightedPayout = 0;
  let total = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const event = events.get(start);
    totalWeight += event?.weight ?? 0;
    weightedPayout += event?.payout ?? 0;
    if (!(totalWeight > 0 && weightedPayout > 0)) continue;
    const payout = weightedPayout / totalWeight;
    if (typeof rate !== "function") {
      total += rate * (end - start) * payout;
    } else if (typeof options.rateRangeSum === "function") {
      total += legendaryPortRouteGoldWithPrefix(
        rate, options.rateRangeSum, start, end, Infinity, payout, payout,
      );
    } else {
      for (let tick = Math.floor(start); tick < end; tick++) {
        const overlap = Math.min(end, tick + 1) - Math.max(start, tick);
        total += overlap * rate(tick) * payout;
      }
    }
  }
  return total;
}

function legendaryPayoutTimelineValue(source, key, tick, timeline, fallbackRates) {
  let value;
  for (const point of timeline) {
    if (Math.max(0, Number(point?.atTicks) || 0) > tick) break;
    if (point?.[key] !== undefined) value = Number(point[key]);
  }
  if (Number.isFinite(value)) return Math.max(0, value);
  const expiresAt = Math.max(0, Number(source?.eligibleTicks ?? Infinity));
  const fallbackRate = tick < expiresAt ? fallbackRates.current : fallbackRates.post;
  return Math.max(0, Number(fallbackRate) || 0);
}

function legendaryPayoutTimelineBoundaries(source, start, end, timeline) {
  const boundaries = new Set([start, end]);
  const fallbackExpiry = Number(source?.eligibleTicks ?? Infinity);
  if (Number.isFinite(fallbackExpiry) && fallbackExpiry > start && fallbackExpiry < end) {
    boundaries.add(fallbackExpiry);
  }
  for (const point of timeline) {
    const atTicks = Number(point?.atTicks);
    if (Number.isFinite(atTicks) && atTicks > start && atTicks < end) {
      boundaries.add(atTicks);
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

function legendaryIntegratePayoutTimeline(source, key, startAt, endAt, fallbackRates) {
  const start = Math.max(0, Number(startAt) || 0);
  const end = Math.max(start, Number(endAt) || 0);
  if (end <= start) return 0;
  const timeline = Array.isArray(source?.payoutTimeline)
    ? source.payoutTimeline
    : [];
  const ordered = legendaryPayoutTimelineBoundaries(source, start, end, timeline);
  let total = 0;
  for (let index = 0; index < ordered.length - 1; index++) {
    const segmentStart = ordered[index];
    total +=
      legendaryPayoutTimelineValue(
        source,
        key,
        segmentStart,
        timeline,
        fallbackRates,
      ) *
      (ordered[index + 1] - segmentStart);
  }
  return total;
}

function* legendaryEconomyNetGoldSteps(
  type,
  { cost = 0, horizonTicks = 0, inputs, config } = {},
) {
  const costNumber = Number(cost);
  const horizon = Number(horizonTicks);
  const live = inputs && typeof inputs === "object";
  if (!live || !Number.isFinite(costNumber) || costNumber <= 0) return null;
  if (!Number.isFinite(horizon) || horizon <= 0) return { refused: true };
  // Construction delay comes from live unit info (instant build reads as 0);
  // the candidate earns nothing until the structure completes.
  const unitInfo = config?.unitInfo?.(type);
  if (inputs.upgradeAction !== true && !Number.isFinite(Number(unitInfo?.constructionDuration))) {
    return null;
  }
  const constructionDelayTicks = inputs.upgradeAction === true
    ? 0
    : Math.max(0, Math.floor(Number(unitInfo.constructionDuration)));
  const portHasRouteProfiles =
    type === "Port" &&
    (Array.isArray(inputs.portRoutes) && inputs.portRoutes.length > 0 ||
      (Array.isArray(inputs.portUpgradeProfile?.routes) &&
        inputs.portUpgradeProfile.routes.length > 0) ||
      Object.values(inputs.portUpgradeProfiles ?? {}).some(
        (profile) => Array.isArray(profile?.routes) && profile.routes.length > 0,
      ));
  const routeDelayTicks = Math.max(
    0,
    Number(type === "Port"
      ? portHasRouteProfiles ? 0 : inputs.portRouteDelayTicks
      : inputs.routeDelayTicks) || 0,
  );
  if (
    type === "Port" &&
    inputs.hasCompletedTradePartner !== true
  ) {
    if (
      inputs.portSeedWindowOpen !== true &&
      !(inputs.hasPendingTradePartner === true && portHasRouteProfiles)
    ) {
      return { refused: true };
    }
    // DIVERGENCE: seed-pair ROI starts only after both selected Ports complete.
  }
  const productiveTicks = type === "Port"
    ? horizon
    : Math.max(
        0,
        horizon - constructionDelayTicks - routeDelayTicks,
      );
  if (productiveTicks <= 0) return { refused: true };

  const actionReadyTicks = constructionDelayTicks + routeDelayTicks;
  let candidateFleetSupply;
  let portProjectionProfile;
  if (type === "Factory" && Number(inputs.factoryPaidStops ?? 0) > 0) {
    const upgrade = inputs.upgradeAction === true ? inputs.factoryUpgrade : null;
    const upgradeLevels = Array.isArray(upgrade?.productiveFactoryLevels)
      ? upgrade.productiveFactoryLevels
      : [];
    const upgradeIndex = Math.floor(Number(upgrade?.upgradeFactoryIndex));
    candidateFleetSupply = {
      // Construction adds a level to unitCount immediately; route travel only
      // delays its payouts, while production starts when construction ends.
      factoryCountReadyAt: 0,
      factoryReadyAt: upgrade ? 0 : constructionDelayTicks,
      factoryUpgradeLevel: upgrade && upgradeIndex >= 0 && upgradeIndex < upgradeLevels.length
        ? Math.max(1, Number(upgradeLevels[upgradeIndex]) || 1)
        : undefined,
      builderFactoryCount: inputs.ownFactoryCount,
    };
  } else if (type === "Port") {
