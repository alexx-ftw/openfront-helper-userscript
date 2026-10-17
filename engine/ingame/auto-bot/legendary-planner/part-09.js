    ? Math.max(
        0,
        legendaryExpectedTradeShipRatePerTick(level + 1, tradeShipCount, config) -
          currentRate,
      )
    : currentRate;
}

function legendaryPortPartialTickGold(
  rate,
  tick,
  start,
  end,
  activeEnd,
  activeRate,
  postAllianceRate,
) {
  const overlap = Math.max(0, Math.min(end, tick + 1) - Math.max(start, tick));
  if (overlap <= 0) return 0;
  const active = Math.max(start, tick) + overlap / 2 < activeEnd;
  return overlap * rate(tick) * (active ? activeRate : postAllianceRate);
}

function legendaryPortPrefixGold(
  rateRangeSum,
  startTick,
  endTick,
  activeEnd,
  activeRate,
  postAllianceRate,
) {
  if (!(endTick > startTick)) return 0;
  const activeEndTick = Number.isNaN(activeEnd)
    ? startTick
    : activeEnd === Infinity
    ? endTick
    : activeEnd === -Infinity
    ? startTick
    : Math.ceil(activeEnd - 0.5);
  const split = Math.max(startTick, Math.min(endTick, activeEndTick));
  return rateRangeSum(startTick, split) * activeRate +
    rateRangeSum(split, endTick) * postAllianceRate;
}

function legendaryPortRouteGoldWithPrefix(
  rate,
  rateRangeSum,
  start,
  end,
  activeEnd,
  activeRate,
  postAllianceRate,
) {
  const firstTick = Math.floor(start);
  const lastTick = Math.floor(end);
  if (firstTick === lastTick) {
    return legendaryPortPartialTickGold(
      rate,
      firstTick,
      start,
      end,
      activeEnd,
      activeRate,
      postAllianceRate,
    );
  }
  let total = 0;
  const fullStart = start > firstTick ? firstTick + 1 : firstTick;
  if (start > firstTick) {
    total += legendaryPortPartialTickGold(
      rate,
      firstTick,
      start,
      end,
      activeEnd,
      activeRate,
      postAllianceRate,
    );
  }
  total += legendaryPortPrefixGold(
    rateRangeSum,
    fullStart,
    lastTick,
    activeEnd,
    activeRate,
    postAllianceRate,
  );
  if (end > lastTick) {
    total += legendaryPortPartialTickGold(
      rate,
      lastTick,
      start,
      end,
      activeEnd,
      activeRate,
      postAllianceRate,
    );
  }
  return total;
}

function legendaryPortRouteGold(
  route,
  rate,
  totalWeight,
  postAllianceTotalWeight,
  startDelayTicks,
  horizon,
  rateRangeSum,
) {
  const weight = Math.max(0, Number(route.weight) || 0) / totalWeight;
  const postAllianceWeight = Math.max(
    0,
    Number(route.postAllianceWeight ?? route.weight) || 0,
  ) / postAllianceTotalWeight;
  const delay = Math.max(0, Number(route.distance) || 0);
  const routeTicks = Math.max(0, horizon - startDelayTicks - delay);
  const allianceTicks = Math.max(
    0,
    Number(route.allianceTicksRemaining ?? Infinity) - startDelayTicks - delay,
  );
  const activeTicks = Math.min(routeTicks, allianceTicks);
  const activeGold = Math.max(0, Number(route.teamGoldPerArrival ?? 0));
  const postGold = Math.max(
    0,
    Number(route.postAllianceGoldPerArrival ?? activeGold),
  );
  if (typeof rate === "function") {
    let total = 0;
    const start = Math.max(0, startDelayTicks + delay);
    const end = Math.min(horizon, start + routeTicks);
    const activeEnd = start + activeTicks;
    const activeRate = weight * activeGold;
    const postAllianceRate = postAllianceWeight * postGold;
    if (typeof rateRangeSum === "function") {
      return legendaryPortRouteGoldWithPrefix(
        rate,
        rateRangeSum,
        start,
        end,
        activeEnd,
        activeRate,
        postAllianceRate,
      );
    }
    for (let tick = Math.floor(start); tick < end; tick++) {
      const overlap = Math.max(0, Math.min(end, tick + 1) - Math.max(start, tick));
      if (overlap <= 0) continue;
      const active = Math.max(start, tick) + overlap / 2 < activeEnd;
      total += overlap * rate(tick) * (active ? activeRate : postAllianceRate);
    }
    return total;
  }
  return rate * (
    weight * activeGold * activeTicks +
      postAllianceWeight * postGold * (routeTicks - activeTicks)
  );
}

