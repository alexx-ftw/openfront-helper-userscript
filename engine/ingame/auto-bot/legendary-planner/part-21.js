      if (!selected || selected.fireTick !== assignment.fireTick) return false;
      for (let candidateIndex = 0; candidateIndex < context.routes.length; candidateIndex++) {
        if (claimed.has(candidateIndex) || candidateIndex === routeIndex) continue;
        const candidateRoute = context.routes[candidateIndex];
        const candidateOption = candidateRoute?.samOptions.find(
          (option) => option.samIndex === samIndex,
        );
        if (!candidateOption || !Number.isFinite(candidateOption.claimScore)) continue;
        const opportunity = firstLegendaryInterceptOpportunity(
          candidateOption,
          assignment.fireTick,
          candidateRoute.impactTick,
        );
        if (
          opportunity &&
          (candidateOption.claimScore > selectedOption.claimScore ||
            (candidateOption.claimScore === selectedOption.claimScore &&
              (candidateRoute.impactTick < route.impactTick ||
                (candidateRoute.impactTick === route.impactTick && candidateIndex < routeIndex))))
        ) {
          return false;
        }
      }
      claimed.add(routeIndex);
    }
  }
  return claimed.size === assignments.length;
}

function resolveLegendaryMissileSchedule(context, greedyMissiles) {
  const fullyDefended = greedyMissiles.every((missile) => missile.intercepted);
  if (fullyDefended) {
    const conflictIndex = legendaryEngineClaimConflictIndex(context, greedyMissiles);
    if (conflictIndex >= 0) {
      const missiles = greedyMissiles.slice();
      missiles[conflictIndex] = legendaryScheduledMissile(
        context.routes[conflictIndex],
        null,
      );
      return {
        missiles,
        fullyDefended: false,
        method: "engine-order-conflict",
        nodes: 0,
      };
    }
    return { missiles: greedyMissiles, fullyDefended: true, method: "greedy", nodes: 0 };
  }
  if (context.routes.length === 0 || context.routes.length > LEGENDARY_EXACT_SCHEDULE_ROUTE_LIMIT) {
    return { missiles: greedyMissiles, fullyDefended: false, method: "inconclusive", nodes: 0 };
  }
  const exact = runLegendaryExactSchedule(context);
  if (exact.assignments) {
    if (legendaryExactScheduleMatchesEngineOrder(context, exact.assignments)) {
      return {
        missiles: exact.assignments.map((assignment, routeIndex) =>
          legendaryScheduledMissile(context.routes[routeIndex], assignment),
        ),
        fullyDefended: true,
        method: "engine-order-exact",
        nodes: exact.nodes,
      };
    }
    // A theoretical reassignment that the autonomous launcher order would not
    // reproduce is unsafe. Keep the observable greedy schedule and fail closed.
    return {
      missiles: greedyMissiles,
      fullyDefended: false,
      method: "engine-order-inconclusive",
      nodes: exact.nodes,
    };
  }
  const method = exact.exhausted ? "inconclusive" : "exact-impossible";
  return { missiles: greedyMissiles, fullyDefended: false, method, nodes: exact.nodes };
}

function legendaryMissileDefenseSchedule({
  routes = [],
  samProfiles = [],
  samCooldownTicks = 90,
  marginTicks = 5,
  completionTick = 0,
} = {}) {
  const cooldown = Math.max(1, legendaryScoreValue(samCooldownTicks));
  const margin = Math.max(0, legendaryScoreValue(marginTicks));
  const rawCompletion = Number(completionTick);
  const completion = Number.isFinite(rawCompletion) ? Math.max(0, rawCompletion) : Infinity;
  const profiles = normalizeLegendarySamProfiles(samProfiles, cooldown);
  const normalizedRoutes = normalizeLegendaryMissileRoutes(routes, profiles.length);
  const context = {
    profiles,
    routes: normalizedRoutes,
    futureUse: buildLegendaryFutureSamUse(normalizedRoutes, profiles.length),
  };
  const resolved = resolveLegendaryMissileSchedule(context, runLegendaryGreedySchedule(context));
  const firstImpactTick = normalizedRoutes[0]?.impactTick ?? Infinity;
  const completionMarginTicks = Number.isFinite(firstImpactTick)
    ? Math.max(0, firstImpactTick - completion)
    : Infinity;
  const margins = resolved.missiles.map((missile) => missile.marginTicks);
  return {
    fullyDefended: resolved.fullyDefended,
    completionMarginSatisfied: Number.isFinite(firstImpactTick) && completionMarginTicks >= margin,
    firstImpactTick,
    completionTick: completion,
    completionMarginTicks,
    minimumInterceptMarginTicks: margins.length ? Math.min(...margins) : Infinity,
    interceptedCount: resolved.missiles.filter((missile) => missile.intercepted).length,
    uninterceptedCount: resolved.missiles.filter((missile) => !missile.intercepted).length,
    missiles: resolved.missiles,
    samProfiles: profiles,
    scheduleMethod: resolved.method,
    exactSearchNodes: resolved.nodes,
  };
}

// An emergency defense action is useful before it solves the whole salvo. The
// schedule metrics must still improve, otherwise a capacity increase that does
// not affect any active missile only burns the economy reserve.
function legendaryFiniteValueImproves(currentValue, nextValue) {
  const current = Number(currentValue);
  const next = Number(nextValue);
  return Number.isFinite(next) && (!Number.isFinite(current) || next > current);
}

function legendaryFiniteValueDecreases(currentValue, nextValue) {
  const current = Number(currentValue);
  const next = Number(nextValue);
  return Number.isFinite(current) && Number.isFinite(next) && next < current;
}

function legendaryDefenseActionImproves(
  currentEvaluation = {},
  nextEvaluation = {},
  currentCapacity = 0,
  nextCapacity = 0,
) {
  if (!currentEvaluation || !nextEvaluation) return false;
  if (nextEvaluation.hasThreats === false) return false;
  if (nextEvaluation.fullyDefended && !currentEvaluation.fullyDefended) {
    return true;
  }

  if (legendaryFiniteValueDecreases(
    currentEvaluation.uninterceptedCount,
    nextEvaluation.uninterceptedCount,
  )) {
    return true;
  }

  return legendaryFiniteValueImproves(
    currentEvaluation.minimumInterceptMarginTicks,
    nextEvaluation.minimumInterceptMarginTicks,
  );
}

function legendaryObjectiveBalance(candidate) {
  return Math.min(
