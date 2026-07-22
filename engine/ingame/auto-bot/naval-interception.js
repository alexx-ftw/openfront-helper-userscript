// Auto-Bot — deterministic naval interception planner.
//
// The game moves transport ships and warships one pathfinder step per tick in
// the current engine. The planner keeps the speeds configurable so a future
// client contract can provide another value without changing the scheduling
// algorithm. It is deliberately independent from the game wrappers: callers
// supply water routes and the distance metric.

"use strict";

  const NAVAL_INTERCEPTION_DEFAULT_SPEED = 1;
  const NAVAL_INTERCEPTION_DEFAULT_RANGE = 130;
  const NAVAL_INTERCEPTION_EXACT_INVASION_LIMIT = 6;
  const NAVAL_INTERCEPTION_EXACT_SHIP_LIMIT = 3;
  const NAVAL_INTERCEPTION_DEFAULT_SEARCH_BUDGET = 4096;

  function positiveNavalNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function nonNegativeNavalNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function createNavalInterceptionContext(options) {
    const ships = Array.isArray(options.ships)
      ? options.ships.filter((ship) => ship && ship.id !== undefined && ship.tile !== undefined)
      : [];
    const invasions = Array.isArray(options.invasions)
      ? options.invasions.filter(
          (invasion) =>
            invasion &&
            invasion.id !== undefined &&
            Array.isArray(invasion.path) &&
            invasion.path.length > 1,
        )
      : [];
    return {
      ships,
      invasions,
      route: typeof options.route === "function" ? options.route : () => null,
      distance: typeof options.distance === "function" ? options.distance : () => Infinity,
      boatSpeed: positiveNavalNumber(options.boatSpeed, NAVAL_INTERCEPTION_DEFAULT_SPEED),
      warshipSpeed: positiveNavalNumber(options.warshipSpeed, NAVAL_INTERCEPTION_DEFAULT_SPEED),
      attackRange: nonNegativeNavalNumber(options.attackRange, NAVAL_INTERCEPTION_DEFAULT_RANGE),
      searchBudget: Math.max(
        1,
        Math.floor(
          positiveNavalNumber(options.searchBudget, NAVAL_INTERCEPTION_DEFAULT_SEARCH_BUDGET),
        ),
      ),
      routeCache: new Map(),
      candidateCache: new Map(),
    };
  }

  function getCachedNavalRoute(context, from, to) {
    const key = `${String(from)}>${String(to)}`;
    if (context.routeCache.has(key)) return context.routeCache.get(key);
    let result = null;
    {
      const candidate = context.route(from, to);
      if (Array.isArray(candidate) && candidate.length > 0) result = candidate;
    }
    context.routeCache.set(key, result);
    return result;
  }

  function navalInterceptionAtTick(context, ship, invasion, tick, timing) {
    const pathIndex = Math.min(
      invasion.path.length - 1,
      Math.max(0, Math.floor(tick * context.boatSpeed)),
    );
    const boatTile = invasion.path[pathIndex];
    const maxTravelSteps = Math.floor(
      (tick - timing.startTick) * context.warshipSpeed,
    );
    // Exact lower bound: even on an unobstructed straight route, a Warship
    // cannot get within firing range when the direct distance exceeds its
    // travel budget plus attack range. Reject those binary-search probes before
    // paying for full-resolution water A*; feasible probes still use the exact
    // route below, so the selected intercept tick and tile remain unchanged.
    if (
      context.distance(ship.tile, boatTile) >
      maxTravelSteps + context.attackRange
    ) {
      return null;
    }
    const waterRoute = getCachedNavalRoute(context, ship.tile, boatTile);
    if (!waterRoute) return null;
    const maxReachableIndex = Math.min(
      waterRoute.length - 1,
      maxTravelSteps,
    );
    for (let index = maxReachableIndex; index >= 0; index--) {
      const inRange =
        Number(context.distance(waterRoute[index], boatTile)) <= context.attackRange;
      if (!inRange) continue;
      return {
        shipId: ship.id,
        invasionId: invasion.id,
        interceptTick: tick,
        interceptTile: waterRoute[index],
        landingTick: timing.arrival,
        marginTicks: timing.arrival - tick,
      };
    }
    return null;
  }

  function searchFirstNavalInterception(context, ship, invasion, startTick, arrival) {
    const timing = { startTick, arrival };
    // Feasibility is monotonic only while the interceptor gains at least as
    // much route budget per tick as the invasion advances. Preserve the exact
    // scan for any future ruleset with a slower warship.
    if (context.warshipSpeed < context.boatSpeed) {
      for (let tick = startTick; tick < arrival; tick++) {
        const candidate = navalInterceptionAtTick(
          context,
          ship,
          invasion,
          tick,
          timing,
        );
        if (candidate !== null) return candidate;
      }
      return null;
    }
    let first = startTick;
    let last = arrival - 1;
    let best = null;
    while (first <= last) {
      const tick = Math.floor((first + last) / 2);
      const candidate = navalInterceptionAtTick(
        context,
        ship,
        invasion,
        tick,
        timing,
      );
      if (candidate === null) {
        first = tick + 1;
      } else {
        best = candidate;
        last = tick - 1;
      }
    }
    return best;
  }

  function findNavalInterceptionCandidate(context, ship, invasion) {
    const cacheKey = `${String(ship.id)}:${String(ship.tile)}:${Math.floor(
      ship.time || 0,
    )}>${String(invasion.id)}`;
    if (context.candidateCache.has(cacheKey)) {
      return context.candidateCache.get(cacheKey);
    }
    const startTick = Math.max(0, Math.floor(ship.time || 0));
    const arrival = Math.ceil((invasion.path.length - 1) / context.boatSpeed);
    const candidate =
      startTick >= arrival
        ? null
        : searchFirstNavalInterception(context, ship, invasion, startTick, arrival);
    context.candidateCache.set(cacheKey, candidate);
    return candidate;
  }

  function compareNavalCandidates(a, b) {
    return (
      a.landingTick - b.landingTick ||
      b.marginTicks - a.marginTicks ||
      a.interceptTick - b.interceptTick ||
      String(a.invasionId).localeCompare(String(b.invasionId)) ||
      String(a.shipId).localeCompare(String(b.shipId))
    );
  }

  function compareNavalSolutions(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    const marginA = a.reduce((sum, item) => sum + item.marginTicks, 0);
    const marginB = b.reduce((sum, item) => sum + item.marginTicks, 0);
    if (marginA !== marginB) return marginA - marginB;
    const lastA = a.reduce((max, item) => Math.max(max, item.interceptTick), 0);
    const lastB = b.reduce((max, item) => Math.max(max, item.interceptTick), 0);
    return lastB - lastA;
  }

  function getNavalCandidates(context, states, remaining) {
    const candidates = [];
    for (const ship of states) {
      for (const invasion of remaining) {
        const candidate = findNavalInterceptionCandidate(context, ship, invasion);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates.sort(compareNavalCandidates);
  }

  function advanceNavalShipStates(states, candidate) {
    return states.map((ship) =>
      ship.id === candidate.shipId
        ? { ...ship, tile: candidate.interceptTile, time: candidate.interceptTick + 1 }
        : ship,
    );
  }

  function findExactNavalAssignments(context, initialStates) {
    let assignments = [];
    let visited = 0;
    function search(states, remaining, current) {
      visited++;
      if (visited > context.searchBudget) return;
      if (compareNavalSolutions(current, assignments) > 0) assignments = current;
      if (remaining.length === 0) return;
      if (current.length + remaining.length < assignments.length) return;
      for (const candidate of getNavalCandidates(context, states, remaining)) {
        const nextRemaining = remaining.filter(
          (invasion) => invasion.id !== candidate.invasionId,
        );
        search(advanceNavalShipStates(states, candidate), nextRemaining, [...current, candidate]);
      }
    }
    search(initialStates, context.invasions, []);
    return assignments;
  }

  function findGreedyNavalAssignments(context, initialStates) {
    let states = initialStates.map((ship) => ({ ...ship }));
    let remaining = [...context.invasions];
    const assignments = [];
    while (remaining.length > 0) {
      const candidate = getNavalCandidates(context, states, remaining)[0];
      if (!candidate) break;
      assignments.push(candidate);
      states = advanceNavalShipStates(states, candidate);
      remaining = remaining.filter((invasion) => invasion.id !== candidate.invasionId);
    }
    return assignments;
  }

  function planNavalInterceptions(options = {}) {
    const context = createNavalInterceptionContext(options);
    const initialStates = context.ships.map((ship) => ({ id: ship.id, tile: ship.tile, time: 0 }));
    const canSearchExactly =
      context.invasions.length <= NAVAL_INTERCEPTION_EXACT_INVASION_LIMIT &&
      context.ships.length <= NAVAL_INTERCEPTION_EXACT_SHIP_LIMIT;
    const assignments = canSearchExactly
      ? findExactNavalAssignments(context, initialStates)
      : findGreedyNavalAssignments(context, initialStates);

    assignments.sort(
      (a, b) =>
        a.interceptTick - b.interceptTick ||
        String(a.shipId).localeCompare(String(b.shipId)),
    );
    const covered = new Set(assignments.map((assignment) => assignment.invasionId));
    const shipPlans = context.ships.map((ship) => ({
      shipId: ship.id,
      assignments: assignments.filter((assignment) => assignment.shipId === ship.id),
    }));

    return {
      assignments,
      shipPlans,
      coveredIds: context.invasions
        .filter((invasion) => covered.has(invasion.id))
        .map((invasion) => invasion.id),
      uncoveredIds: context.invasions
        .filter((invasion) => !covered.has(invasion.id))
        .map((invasion) => invasion.id),
    };
  }
