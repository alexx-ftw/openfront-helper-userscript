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

  function planNavalInterceptions(options = {}) {
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
    const route = typeof options.route === "function" ? options.route : () => null;
    const distance = typeof options.distance === "function" ? options.distance : () => Infinity;
    const boatSpeed = positiveNavalNumber(
      options.boatSpeed,
      NAVAL_INTERCEPTION_DEFAULT_SPEED,
    );
    const warshipSpeed = positiveNavalNumber(
      options.warshipSpeed,
      NAVAL_INTERCEPTION_DEFAULT_SPEED,
    );
    const attackRange = nonNegativeNavalNumber(
      options.attackRange,
      NAVAL_INTERCEPTION_DEFAULT_RANGE,
    );
    const searchBudget = Math.max(
      1,
      Math.floor(
        positiveNavalNumber(
          options.searchBudget,
          NAVAL_INTERCEPTION_DEFAULT_SEARCH_BUDGET,
        ),
      ),
    );

    const routeCache = new Map();
    const routeKey = (from, to) => `${String(from)}>${String(to)}`;
    const cachedRoute = (from, to) => {
      const key = routeKey(from, to);
      if (routeCache.has(key)) return routeCache.get(key);
      let result = null;
      try {
        const candidate = route(from, to);
        result = Array.isArray(candidate) && candidate.length > 0 ? candidate : null;
      } catch (_e) {
        result = null;
      }
      routeCache.set(key, result);
      return result;
    };

    const landingTick = (invasion) =>
      Math.ceil((invasion.path.length - 1) / boatSpeed);
    const positionAt = (invasion, tick) => {
      const index = Math.min(
        invasion.path.length - 1,
        Math.max(0, Math.floor(tick * boatSpeed)),
      );
      return invasion.path[index];
    };

    // Find the first future tick at which a ship can reach any tile on its
    // shortest water route that lies within firing range of the invasion boat.
    // The final boat tick is excluded: after that tick the transport has
    // already reached its landing tile.
    const findCandidate = (ship, invasion) => {
      const startTick = Math.max(0, Math.floor(ship.time || 0));
      const arrival = landingTick(invasion);
      if (startTick >= arrival) return null;

      for (let tick = startTick; tick < arrival; tick++) {
        const boatTile = positionAt(invasion, tick);
        const waterRoute = cachedRoute(ship.tile, boatTile);
        if (waterRoute === null) continue;

        const maxReachableIndex = Math.min(
          waterRoute.length - 1,
          Math.floor((tick - startTick) * warshipSpeed),
        );
        for (let index = maxReachableIndex; index >= 0; index--) {
          let inRange = false;
          try {
            inRange = Number(distance(waterRoute[index], boatTile)) <= attackRange;
          } catch (_e) {
            inRange = false;
          }
          if (!inRange) continue;
          return {
            shipId: ship.id,
            invasionId: invasion.id,
            interceptTick: tick,
            interceptTile: waterRoute[index],
            landingTick: arrival,
            marginTicks: arrival - tick,
          };
        }
      }
      return null;
    };

    const initialStates = ships.map((ship) => ({
      id: ship.id,
      tile: ship.tile,
      time: 0,
    }));

    const compareCandidates = (a, b) =>
      a.marginTicks - b.marginTicks ||
      a.interceptTick - b.interceptTick ||
      String(a.invasionId).localeCompare(String(b.invasionId)) ||
      String(a.shipId).localeCompare(String(b.shipId));

    const compareSolutions = (a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      const marginA = a.reduce((sum, item) => sum + item.marginTicks, 0);
      const marginB = b.reduce((sum, item) => sum + item.marginTicks, 0);
      if (marginA !== marginB) return marginB - marginA;
      const lastA = a.reduce(
        (max, item) => Math.max(max, item.interceptTick),
        0,
      );
      const lastB = b.reduce(
        (max, item) => Math.max(max, item.interceptTick),
        0,
      );
      return lastB - lastA;
    };

    const candidatesFor = (states, remaining) => {
      const candidates = [];
      for (const ship of states) {
        for (const invasion of remaining) {
          const candidate = findCandidate(ship, invasion);
          if (candidate !== null) candidates.push(candidate);
        }
      }
      return candidates.sort(compareCandidates);
    };

    let assignments = [];
    const canSearchExactly =
      invasions.length <= NAVAL_INTERCEPTION_EXACT_INVASION_LIMIT &&
      ships.length <= NAVAL_INTERCEPTION_EXACT_SHIP_LIMIT;

    if (canSearchExactly) {
      let visited = 0;
      const search = (states, remaining, current) => {
        visited++;
        if (visited > searchBudget) return;
        if (compareSolutions(current, assignments) > 0) assignments = current;
        if (remaining.length === 0) return;
        if (current.length + remaining.length < assignments.length) return;

        for (const candidate of candidatesFor(states, remaining)) {
          const nextStates = states.map((ship) =>
            ship.id === candidate.shipId
              ? {
                  ...ship,
                  tile: candidate.interceptTile,
                  time: candidate.interceptTick + 1,
                }
              : ship,
          );
          const nextRemaining = remaining.filter(
            (invasion) => invasion.id !== candidate.invasionId,
          );
          search(nextStates, nextRemaining, [...current, candidate]);
        }
      };
      search(
        initialStates,
        invasions,
        [],
      );
    } else {
      const states = initialStates.map((ship) => ({ ...ship }));
      let remaining = [...invasions];
      while (remaining.length > 0) {
        const candidates = candidatesFor(states, remaining);
        if (candidates.length === 0) break;
        const candidate = candidates[0];
        assignments.push(candidate);
        const ship = states.find((item) => item.id === candidate.shipId);
        if (ship) {
          ship.tile = candidate.interceptTile;
          ship.time = candidate.interceptTick + 1;
        }
        remaining = remaining.filter((invasion) => invasion.id !== candidate.invasionId);
      }
    }

    assignments.sort(
      (a, b) =>
        a.interceptTick - b.interceptTick ||
        String(a.shipId).localeCompare(String(b.shipId)),
    );
    const covered = new Set(assignments.map((assignment) => assignment.invasionId));
    const shipPlans = ships.map((ship) => ({
      shipId: ship.id,
      assignments: assignments.filter((assignment) => assignment.shipId === ship.id),
    }));

    return {
      assignments,
      shipPlans,
      coveredIds: invasions
        .filter((invasion) => covered.has(invasion.id))
        .map((invasion) => invasion.id),
      uncoveredIds: invasions
        .filter((invasion) => !covered.has(invasion.id))
        .map((invasion) => invasion.id),
    };
  }
