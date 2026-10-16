// assigned a trajectory opportunity at tick 80.
//
// The 5-tick constant is deliberately applied to `completionMarginTicks`:
// `firstImpactTick - actionCompletionTick`. It is not a vague urgency bonus and
// it is not incorrectly added to every interception. A new SAM is therefore a
// valid emergency investment only when it completes at least five ticks before
// the first landing AND the individual ready/reloading slots can stop every
// missile. Existing SAMs and instant upgrades use actionCompletionTick = 0.
function normalizeLegendarySamProfiles(samProfiles, cooldown) {
  return (Array.isArray(samProfiles) ? samProfiles : []).map((profile, index) => {
    const rawAvailability = Array.isArray(profile?.availableTicks)
      ? profile.availableTicks
      : Array(Math.max(0, Math.floor(legendaryScoreValue(profile?.readyShots)))).fill(0);
    return {
      id: profile?.id ?? index,
      availableTicks: rawAvailability
        .map(Number)
        .filter((tick) => Number.isFinite(tick) && tick >= 0)
        .sort((a, b) => a - b),
      cooldownTicks: Math.max(1, legendaryScoreValue(profile?.cooldownTicks ?? cooldown)),
      fireIntervalTicks: Math.max(0, legendaryScoreValue(profile?.fireIntervalTicks ?? 0)),
    };
  });
}

function normalizeLegendarySamOption(option, impactTick, profileCount) {
  const samIndex = Math.floor(Number(option?.samIndex));
  if (!Number.isFinite(samIndex) || samIndex < 0 || samIndex >= profileCount) return null;
  const rawTicks = Array.isArray(option?.interceptTicks)
    ? option.interceptTicks
    : [option?.interceptTick];
  const rawInterceptionTicks = Array.isArray(option?.interceptionTicks)
    ? option.interceptionTicks
    : rawTicks;
  const opportunities = rawTicks
    .map((tick, index) => ({
      fireTick: legendaryScoreValue(tick),
      interceptTick: legendaryScoreValue(rawInterceptionTicks[index] ?? tick),
    }))
    .filter(
      ({ fireTick, interceptTick }) =>
        Number.isFinite(fireTick) &&
        fireTick >= 0 &&
        Number.isFinite(interceptTick) &&
        interceptTick >= fireTick &&
        interceptTick < impactTick,
    )
    .sort(
      (left, right) =>
        left.fireTick - right.fireTick || left.interceptTick - right.interceptTick,
    );
  return opportunities.length
    ? {
        samIndex,
        interceptTicks: opportunities.map(({ fireTick }) => fireTick),
        interceptionTicks: opportunities.map(({ interceptTick }) => interceptTick),
        claimScore: Number.isFinite(Number(option?.claimScore))
          ? Number(option.claimScore)
          : null,
      }
    : null;
}

function normalizeLegendaryMissileRoute(route, routeIndex, profileCount) {
  const impactTick = Number(route?.impactTick);
  if (!Number.isFinite(impactTick) || impactTick < 0) return null;
  let rawOptions = route?.samOptions;
  if (!Array.isArray(rawOptions)) {
    const candidates = Array.isArray(route?.samCandidates) ? route.samCandidates : [];
    const defaultTick = Number.isFinite(Number(route?.interceptTick))
      ? Number(route.interceptTick)
      : Math.max(0, impactTick);
    rawOptions = candidates.map((samIndex) => ({ samIndex, interceptTicks: [defaultTick] }));
  }
  return {
    ...route,
    id: route?.id ?? routeIndex,
    impactTick,
    samOptions: rawOptions
      .map((option) => normalizeLegendarySamOption(option, impactTick, profileCount))
      .filter(Boolean),
  };
}

function normalizeLegendaryMissileRoutes(routes, profileCount) {
  return (Array.isArray(routes) ? routes : [])
    .map((route, index) => normalizeLegendaryMissileRoute(route, index, profileCount))
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.impactTick - right.impactTick ||
        left.samOptions.length - right.samOptions.length ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function buildLegendaryFutureSamUse(routes, profileCount) {
  const futureUseByRoute = routes.map(() => Array(profileCount).fill(0));
  const counts = Array(profileCount).fill(0);
  for (let index = routes.length - 1; index >= 0; index--) {
    futureUseByRoute[index] = counts.slice();
    const used = new Set(routes[index].samOptions.map((option) => option.samIndex));
    for (const samIndex of used) counts[samIndex]++;
  }
  return futureUseByRoute;
}

function firstLegendaryInterceptOpportunity(option, minimumTick, maximumTick) {
  const interceptTicks = option.interceptTicks;
  let low = 0;
  let high = interceptTicks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (interceptTicks[middle] < minimumTick) low = middle + 1;
    else high = middle;
  }
  const fireTick = interceptTicks[low];
  if (fireTick === undefined || fireTick > maximumTick) return undefined;
  return {
    fireTick,
    interceptTick: option.interceptionTicks[low] ?? fireTick,
  };
}

function collectLegendaryFeasibleAssignments(context, routeIndex, slots, fireTicks) {
  const route = context.routes[routeIndex];
  const feasible = [];
  const equivalentAssignments = new Set();
  for (const option of route.samOptions) {
    const profile = context.profiles[option.samIndex];
    for (let slotIndex = 0; slotIndex < slots[option.samIndex].length; slotIndex++) {
      const availableAt = slots[option.samIndex][slotIndex];
      const launcherAvailableAt = Math.max(availableAt, fireTicks[option.samIndex] ?? 0);
      const opportunity = firstLegendaryInterceptOpportunity(
        option,
        launcherAvailableAt,
        route.impactTick,
      );
      if (opportunity === undefined) continue;
      // Slots with the same availability produce the same next state. Keep
      // one representative so a levelled SAM with several ready slots does
      // not make exact search revisit equivalent branches.
      const equivalentKey = `${option.samIndex}|${availableAt}|${opportunity.fireTick}`;
      if (equivalentAssignments.has(equivalentKey)) continue;
      equivalentAssignments.add(equivalentKey);
      feasible.push({
        samIndex: option.samIndex,
        slotIndex,
        availableAt,
        fireTick: opportunity.fireTick,
        interceptTick: opportunity.interceptTick,
        futureUse: context.futureUse[routeIndex][option.samIndex] ?? 0,
        cooldownTicks: profile.cooldownTicks,
        fireIntervalTicks: profile.fireIntervalTicks,
        claimScore: option.claimScore,
      });
    }
  }
  return feasible.sort(
