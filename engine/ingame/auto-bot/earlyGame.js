// Auto-Bot — Early Game policy helpers.
//
// The source Nation AI has no separate Early Game controller. These helpers keep
// the improvement as a small policy layer around the existing attack order:
// prefer an open-ocean route and a cheap/contested tribe, then use a boat only
// when an exact route ETA proves it is inside the 30-second opening window.

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

  // Measure the shortest LAND distance from any tile on a tribe's border to an
  // open-ocean coast. `isOceanShore` is intentionally used instead of the more
  // general `isShore`: closed lakes must not make an inland tribe look like a
  // port-access route. A bounded search keeps a malformed or very large map from
  // turning one attack decision into an unbounded scan.
  function findNearestOceanCoastDistance({
    starts,
    neighbors,
    isLand,
    isOceanShore,
    maxDistance = 80,
    maxVisited = 5000,
  } = {}) {
    if (
      starts == null ||
      typeof neighbors !== "function" ||
      typeof isLand !== "function" ||
      typeof isOceanShore !== "function"
    ) {
      return Infinity;
    }

    const queue = [];
    const distances = new Map();
    for (const tile of Array.from(starts)) {
      if (tile == null || distances.has(tile) || !isLand(tile)) continue;
      distances.set(tile, 0);
      queue.push(tile);
    }

    for (let head = 0; head < queue.length; head++) {
      if (distances.size > maxVisited) return Infinity;
      const current = queue[head];
      const distance = distances.get(current);
      if (isOceanShore(current)) return distance;
      if (distance >= maxDistance) continue;

      for (const next of neighbors(current) || []) {
        if (distances.has(next) || !isLand(next)) continue;
        distances.set(next, distance + 1);
        queue.push(next);
      }
    }
    return Infinity;
  }

  function finiteEarlyGameSignal(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  }

  // Early-Game tribe order is deliberately lexicographic. First choose tribes
  // that can lead to open ocean, and among those choose the nearest coast. Only
  // then do we prefer a cheap capture that closes a perimeter or blocks another
  // player's route. This keeps the strategy understandable and prevents a cheap
  // inland tribe from hiding the nearest useful port position.
  function earlyGameTribeSortKey(candidate = {}) {
    const oceanDistance = Number(candidate.oceanDistance);
    const hasOpenOcean = Number.isFinite(oceanDistance);
    const distance = Number(candidate.distance);
    return [
      hasOpenOcean ? 1 : 0,
      hasOpenOcean ? -oceanDistance : 0,
      finiteEarlyGameSignal(candidate.encirclement),
      finiteEarlyGameSignal(candidate.blockValue),
      finiteEarlyGameSignal(candidate.cheapCapture),
      candidate.landBorder === true ? 1 : 0,
      Number.isFinite(distance) ? -distance : -Infinity,
    ];
  }

  function compareEarlyGameTribes(a, b) {
    const aKey = earlyGameTribeSortKey(a);
    const bKey = earlyGameTribeSortKey(b);
    for (let i = 0; i < aKey.length; i++) {
      if (aKey[i] === bKey[i]) continue;
      return bKey[i] - aKey[i];
    }
    return 0;
  }

  function rankEarlyGameTribeCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => compareEarlyGameTribes(a.candidate, b.candidate) || a.index - b.index)
      .map(({ candidate }) => candidate);
  }

  function isEarlyGameTribeTarget(target) {
    if (!target || target.alive === false || target.friendly === true) return false;
    // `boatCandidate` means the player is in the bounded nearby() transport
    // sample. The final bestTransportShipSpawn + <=300-tick gate still decides
    // whether the bot can actually act on it.
    return (
      target.landBorder === true ||
      target.boatCandidate === true ||
      isEarlyGameBoatEta(target.boatEtaTicks)
    );
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
