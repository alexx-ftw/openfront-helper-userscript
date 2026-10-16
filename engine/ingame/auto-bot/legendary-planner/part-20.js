    (left, right) =>
      left.futureUse - right.futureUse ||
      left.fireTick - right.fireTick ||
      left.interceptTick - right.interceptTick ||
      left.availableAt - right.availableAt ||
      left.samIndex - right.samIndex ||
      left.slotIndex - right.slotIndex,
  );
}

function applyLegendarySamAssignment(slots, fireTicks, assignment) {
  slots[assignment.samIndex][assignment.slotIndex] =
    assignment.fireTick + assignment.cooldownTicks;
  slots[assignment.samIndex].sort((left, right) => left - right);
  fireTicks[assignment.samIndex] = assignment.fireTick + assignment.fireIntervalTicks;
}

function legendaryScheduledMissile(route, assignment) {
  if (!assignment) {
    return { ...route, intercepted: false, interceptTick: null, marginTicks: 0, samIndex: null };
  }
  return {
    ...route,
    intercepted: true,
    interceptTick: assignment.interceptTick,
    samFireTick: assignment.fireTick,
    marginTicks: Math.max(0, route.impactTick - assignment.interceptTick),
    samIndex: assignment.samIndex,
    claimScore: assignment.claimScore,
  };
}

function runLegendaryGreedySchedule(context) {
  const slots = context.profiles.map((profile) => profile.availableTicks.slice());
  const fireTicks = context.profiles.map(() => 0);
  return context.routes.map((route, index) => {
    const assignment = collectLegendaryFeasibleAssignments(context, index, slots, fireTicks)[0];
    if (assignment) applyLegendarySamAssignment(slots, fireTicks, assignment);
    return legendaryScheduledMissile(route, assignment);
  });
}

function legendaryScheduleStateKey(routeIndex, slots, fireTicks) {
  return `${routeIndex}|${slots
    .map((profileSlots) => profileSlots.join(","))
    .join(";")}|${fireTicks.join(",")}`;
}

function searchLegendaryExactSchedule(state, routeIndex, slots, fireTicks) {
  state.nodes++;
  if (state.nodes > LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT) {
    state.exhausted = true;
    return null;
  }
  if (routeIndex >= state.context.routes.length) return state.chosen.slice();
  const key = legendaryScheduleStateKey(routeIndex, slots, fireTicks);
  if (state.memo.has(key)) return null;
  const feasible = collectLegendaryFeasibleAssignments(state.context, routeIndex, slots, fireTicks);
  for (const candidate of feasible) {
    // Only the selected SAM changes. Copying every profile for every branch
    // made the bounded fallback scale with the whole friendly SAM roster.
    const nextSlots = slots.slice();
    nextSlots[candidate.samIndex] = slots[candidate.samIndex].slice();
    const nextFireTicks = fireTicks.slice();
    applyLegendarySamAssignment(nextSlots, nextFireTicks, candidate);
    state.chosen[routeIndex] = candidate;
    const result = searchLegendaryExactSchedule(state, routeIndex + 1, nextSlots, nextFireTicks);
    if (result) return result;
  }
  state.memo.add(key);
  return null;
}

function runLegendaryExactSchedule(context) {
  const state = {
    context,
    nodes: 0,
    exhausted: false,
    memo: new Set(),
    chosen: new Array(context.routes.length),
  };
  const assignments = searchLegendaryExactSchedule(
    state,
    0,
    context.profiles.map((profile) => profile.availableTicks.slice()),
    context.profiles.map(() => 0),
  );
  return { assignments, nodes: state.nodes, exhausted: state.exhausted };
}

function legendaryCompetingClaimDisplacesRoute(
  context,
  missiles,
  routeIndex,
  otherIndex,
) {
  if (otherIndex === routeIndex) return false;
  const assigned = missiles[routeIndex];
  const otherAssigned = missiles[otherIndex];
  if (!otherAssigned.intercepted || otherAssigned.samIndex === assigned.samIndex) return false;
  if (assigned.samIndex >= otherAssigned.samIndex) return false;
  const otherRoute = context.routes[otherIndex];
  const option = otherRoute.samOptions.find(
    (candidate) => candidate.samIndex === assigned.samIndex,
  );
  if (!option || !Number.isFinite(option.claimScore)) return false;
  const opportunity = firstLegendaryInterceptOpportunity(
    option,
    assigned.samFireTick,
    otherRoute.impactTick,
  );
  return Boolean(
    opportunity &&
    opportunity.fireTick <= assigned.samFireTick + 1 &&
    option.claimScore >= assigned.claimScore,
  );
}

function legendaryRouteHasEngineClaimConflict(context, missiles, routeIndex) {
  const assigned = missiles[routeIndex];
  if (!assigned.intercepted || !Number.isFinite(assigned.claimScore)) return false;
  return context.routes.some((_, otherIndex) =>
    legendaryCompetingClaimDisplacesRoute(
      context,
      missiles,
      routeIndex,
      otherIndex,
    ));
}

function legendaryEngineClaimConflictIndex(context, missiles) {
  return missiles.findIndex((_, routeIndex) =>
    legendaryRouteHasEngineClaimConflict(context, missiles, routeIndex));
}

// Mirror the engine's launcher-order claim semantics for an exact matching.
// SAMs do not receive an explicit missile assignment: launchers run in stable
// execution order and each claims its highest-priority still-unclaimed route.
// An exact matching is safe to emit only when replaying that order reproduces
// every selected SAM.  Unknown claim scores remain fail-closed.
function legendaryExactScheduleMatchesEngineOrder(context, assignments) {
  if (!Array.isArray(assignments)) return false;
  const claimed = new Set();
  for (let samIndex = 0; samIndex < context.profiles.length; samIndex++) {
    const owned = assignments
      .map((assignment, routeIndex) => ({ assignment, routeIndex }))
      .filter(({ assignment }) => assignment?.samIndex === samIndex)
      .sort(
        (left, right) =>
          left.assignment.fireTick - right.assignment.fireTick ||
          left.routeIndex - right.routeIndex,
      );
    for (const { assignment, routeIndex } of owned) {
      const route = context.routes[routeIndex];
      const selectedOption = route?.samOptions.find((option) => option.samIndex === samIndex);
      if (!selectedOption || !Number.isFinite(selectedOption.claimScore)) return false;
      const selected = firstLegendaryInterceptOpportunity(
        selectedOption,
        assignment.fireTick,
        route.impactTick,
      );
