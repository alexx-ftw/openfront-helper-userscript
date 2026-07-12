// Auto-Bot — Early Game policy helpers.
//
// The source Nation AI has no separate Early Game controller. These helpers keep
// the improvement as a small policy layer around the existing attack order:
// claim safe land first, eat reachable tribes next, and only use a boat when an
// exact route ETA proves it is inside the 30-second opening window.

"use strict";

  // OpenFront advances one game tick every 100 ms, so 30 seconds is 300 ticks.
  const EARLY_GAME_MAX_BOAT_TICKS = 300;

  function isEarlyGameBoatEta(etaTicks) {
    return (
      Number.isFinite(etaTicks) &&
      etaTicks >= 0 &&
      etaTicks <= EARLY_GAME_MAX_BOAT_TICKS
    );
  }

  // Bounded shortest-path search over the full-resolution water graph exposed by
  // GameView. The source and destination are shore tiles; only water tiles may be
  // traversed between them. Returning null is deliberately conservative when the
  // route exceeds the opening window or the search budget.
  function findWaterRouteTicks({
    start,
    goal,
    neighbors,
    isWater,
    maxTicks = EARLY_GAME_MAX_BOAT_TICKS,
    maxVisited = 100000,
  } = {}) {
    if (
      start == null ||
      goal == null ||
      typeof neighbors !== "function" ||
      typeof isWater !== "function"
    ) {
      return null;
    }
    if (start === goal) return 0;

    const queue = [start];
    const distances = new Map([[start, 0]]);
    for (let head = 0; head < queue.length; head++) {
      if (distances.size > maxVisited) return null;
      const current = queue[head];
      const currentDistance = distances.get(current);
      if (currentDistance == null || currentDistance >= maxTicks) continue;

      const nextDistance = currentDistance + 1;
      for (const next of neighbors(current) || []) {
        if (next !== goal && next !== start && !isWater(next)) continue;
        if (distances.has(next)) continue;
        if (next === goal) return nextDistance;
        distances.set(next, nextDistance);
        queue.push(next);
      }
    }
    return null;
  }

  // Transport motion plans include their source tile, therefore movement time is
  // the number of edges, not the number of path entries.
  function transportRouteTicks(path) {
    const route = path && path.fullPath ? path.fullPath : path;
    if (route == null || typeof route.length !== "number" || route.length === 0) {
      return null;
    }
    const length = Number(route.length);
    return Number.isFinite(length) ? Math.max(0, length - 1) : null;
  }

  function isEarlyGameTribeTarget(target) {
    if (!target || target.alive === false || target.friendly === true) return false;
    return target.landBorder === true || isEarlyGameBoatEta(target.boatEtaTicks);
  }

  function createEarlyGameSnapshot(input = {}) {
    const tribes = Array.isArray(input.tribes) ? input.tribes : [];
    const actionableTribes = tribes.filter(isEarlyGameTribeTarget);
    const hasFreeLand = input.hasFreeLand === true;
    const hasTribeTarget = actionableTribes.length > 0;
    const postSpawn = input.postSpawn === true;

    return {
      active: postSpawn && (hasFreeLand || hasTribeTarget),
      postSpawn,
      hasFreeLand,
      hasTribeTarget,
      actionableTribes,
      boatRouteAvailable: input.boatRouteAvailable === true,
    };
  }

  function chooseEarlyGameAction({ landTarget = false, tribeTarget = false, boatTarget = false } = {}) {
    if (landTarget) return "land";
    if (tribeTarget) return "tribe";
    if (boatTarget) return "boat";
    return null;
  }
