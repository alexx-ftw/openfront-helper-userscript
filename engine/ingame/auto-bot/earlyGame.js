// Auto-Bot — Early Game policy helpers.
//
// The source Nation AI has no separate Early Game controller. These helpers keep
// the improvement as a small policy layer around the existing attack order:
// prefer a navigable river/open-sea/ocean route and a cheap/contested tribe,
// then use a boat only when an exact route ETA proves it is inside the
// 30-second opening window.

"use strict";

  // OpenFront advances one game tick every 100 ms, so 30 seconds is 300 ticks.
  const EARLY_GAME_MAX_BOAT_TICKS = 300;
  // Keep the opening expansion force available when a local land opportunity or
  // a quickly reachable tribe is still actionable.
  const AUTO_DONATE_EXPANSION_MAX_TICKS = 30;
  // Keep maritime targeting local to the opening frontier. This is the same
  // bounded radius used by the former open-ocean search; a distant coast must
  // not outrank an urgent nearby attack merely because it is finite.
  const EARLY_GAME_MAX_MARITIME_DISTANCE = 80;

  function isEarlyGameBoatEta(etaTicks) {
    return (
      Number.isFinite(etaTicks) &&
      etaTicks >= 0 &&
      etaTicks <= EARLY_GAME_MAX_BOAT_TICKS
    );
  }

  // Return the current reason the Auto-Bot troop donation should be paused.
  // Land tribes are already in the local frontier. A sea tribe only qualifies
  // when the transport pathfinder supplied an ETA in actual movement ticks;
  // nearby/boat-candidate flags alone are not enough because water distance and
  // transport movement speed can differ between adapters.
  function getAutoDonateExpansionStatus(
    earlyGame = {},
    maxTicks = AUTO_DONATE_EXPANSION_MAX_TICKS,
  ) {
    const limit = Number.isFinite(Number(maxTicks))
      ? Math.max(0, Number(maxTicks))
      : AUTO_DONATE_EXPANSION_MAX_TICKS;
    const inactive = { active: false, reason: null, maxTicks: limit };
    if (!earlyGame || earlyGame.active !== true) return inactive;

    if (earlyGame.hasFreeLand === true) {
      return { active: true, reason: "free-land", maxTicks: limit };
    }

    const tribes = Array.isArray(earlyGame.actionableTribes)
      ? earlyGame.actionableTribes
      : [];
    if (tribes.some((tribe) => tribe && tribe.landBorder === true)) {
      return { active: true, reason: "land-tribe", maxTicks: limit };
    }

    const hasNearbySeaTribe = tribes.some((tribe) => {
      if (!tribe || tribe.landBorder === true) return false;
      const eta = Number(tribe.boatEtaTicks);
      return Number.isFinite(eta) && eta >= 0 && eta <= limit;
    });
    if (hasNearbySeaTribe) {
      return { active: true, reason: "sea-tribe", maxTicks: limit };
    }

    return inactive;
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

  // Measure the shortest LAND distance from any tile on a tribe's border to a
  // navigable maritime coast. The predicate is supplied by the caller:
  // `isOceanShore` covers open ocean and ocean-connected rivers, while the custom
  // attack policy can also recognise a river that exits through the map edge.
  // Closed inland lakes must not satisfy this objective.
  function findNearestMaritimeCoastDistance({
    starts,
    neighbors,
    isLand,
    isMaritimeShore,
    maxDistance = EARLY_GAME_MAX_MARITIME_DISTANCE,
    maxVisited = 5000,
  } = {}) {
    if (
      starts == null ||
      typeof neighbors !== "function" ||
      typeof isLand !== "function" ||
      typeof isMaritimeShore !== "function"
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
      if (isMaritimeShore(current)) return distance;
      if (distance >= maxDistance) continue;

      for (const next of neighbors(current) || []) {
        if (distances.has(next) || !isLand(next)) continue;
        distances.set(next, distance + 1);
        queue.push(next);
      }
    }
    return Infinity;
  }

  // Backwards-compatible helper name used by existing diagnostics/tests.
  function findNearestOceanCoastDistance({
    starts,
    neighbors,
    isLand,
    isOceanShore,
    maxDistance = EARLY_GAME_MAX_MARITIME_DISTANCE,
    maxVisited = 5000,
  } = {}) {
    return findNearestMaritimeCoastDistance({
      starts,
      neighbors,
      isLand,
      isMaritimeShore: isOceanShore,
      maxDistance,
      maxVisited,
    });
  }

  // A reverse multi-source distance field avoids repeating the same BFS for
  // every tribe on every attack tick. Terrain is static for a match, so the
  // caller can build this once and look up all candidate borders cheaply.
  function buildMaritimeDistanceIndex({
    width,
    height,
    neighbors,
    isLand,
    isMaritimeShore,
    maxDistance = EARLY_GAME_MAX_MARITIME_DISTANCE,
  } = {}) {
    const mapWidth = Number(width);
    const mapHeight = Number(height);
    const total = mapWidth * mapHeight;
    const distanceLimit = Number(maxDistance);
    if (
      !Number.isInteger(mapWidth) ||
      !Number.isInteger(mapHeight) ||
      mapWidth <= 0 ||
      mapHeight <= 0 ||
      !Number.isSafeInteger(total) ||
      !Number.isInteger(distanceLimit) ||
      distanceLimit < 0 ||
      typeof neighbors !== "function" ||
      typeof isLand !== "function" ||
      typeof isMaritimeShore !== "function"
    ) {
      return null;
    }

    const distances = new Int32Array(total);
    distances.fill(-1);
    const queue = new Int32Array(total);
    let tail = 0;
    for (let tile = 0; tile < total; tile++) {
      if (!isLand(tile) || !isMaritimeShore(tile)) continue;
      distances[tile] = 0;
      queue[tail++] = tile;
    }

    for (let head = 0; head < tail; head++) {
      const current = queue[head];
      if (distances[current] >= distanceLimit) continue;
      const nextDistance = distances[current] + 1;
      for (const next of neighbors(current) || []) {
        if (
          !Number.isInteger(next) ||
          next < 0 ||
          next >= total ||
          !isLand(next) ||
          distances[next] !== -1
        ) {
          continue;
        }
        distances[next] = nextDistance;
        queue[tail++] = next;
      }
    }

    return { distances, width: mapWidth, height: mapHeight };
  }

  function lookupMaritimeDistanceIndex(index, starts) {
    if (!index || !index.distances || starts == null) return Infinity;
    let best = Infinity;
    for (const tile of Array.from(starts)) {
      if (
        !Number.isInteger(tile) ||
        tile < 0 ||
        tile >= index.distances.length
      ) {
        continue;
      }
      const distance = index.distances[tile];
      if (distance >= 0 && distance < best) best = distance;
    }
    return best;
  }

  function finiteEarlyGameSignal(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  }

  // A tribe is more valuable when taking it opens a short chain of other tribes.
  // `futureFoodAccess` is supplied by AttackBehavior when it has geometry; the
  // count/distance fallback keeps this helper useful for deterministic tests and
  // older adapters that only expose aggregate signals.
  function calculateEarlyGameContinuationValue(candidate = {}) {
    const explicit = Number(candidate.futureFoodAccess);
    if (candidate.futureFoodAccess != null && Number.isFinite(explicit)) {
      return finiteEarlyGameSignal(explicit);
    }

    const count = Number(candidate.futureFoodCount);
    const total = Number(candidate.futureFoodTotal);
    const countScore =
      Number.isFinite(total) && total > 0
        ? finiteEarlyGameSignal(count / total)
        : Number.isFinite(count) && count > 0
          ? 1
          : 0;
    const distance = Number(candidate.meanFutureFoodDistance);
    const radius = Number(candidate.futureFoodChainRadius || 120);
    const proximityScore =
      Number.isFinite(distance) && Number.isFinite(radius) && radius > 0
        ? finiteEarlyGameSignal(1 - distance / radius)
        : 0;
    return finiteEarlyGameSignal(countScore * proximityScore);
  }

  // Combine direct attacks, incoming attack snapshots, and the observed growth
  // vector of other players into one urgency signal. A direct attack is enough to
  // make a tribe an immediate race; movement/progress still matters when the
  // other player has not yet emitted an attack at this exact tick.
  function calculateEarlyGameFoodRaceValue({
    directAttackers = 0,
    incomingAttackers = 0,
    competitorProgress = 0,
    competitorVector = 0,
    competitorTroops = 0,
    targetTroops = 0,
  } = {}) {
    const directSignal = finiteEarlyGameSignal(
      Math.max(Number(directAttackers) || 0, Number(incomingAttackers) || 0),
    );
    const momentumSignal = Math.max(
      finiteEarlyGameSignal(competitorProgress),
      finiteEarlyGameSignal(competitorVector),
    );
    const target = Math.max(1, Number(targetTroops) || 0);
    const strengthSignal = finiteEarlyGameSignal(
      (Number(competitorTroops) || 0) / (target * 4),
    );
    // Treat the three inputs as independent evidence. Their probabilistic union
    // grows with every signal and makes a direct/incoming attack fully urgent
    // without inventing per-signal weights.
    return finiteEarlyGameSignal(
      1 -
        (1 - directSignal) *
          (1 - momentumSignal) *
          (1 - strengthSignal),
    );
  }

  // Race a contested tribe with more troops, but never spend the reserve that
  // keeps the bot alive. The base amount is preserved when no meaningful rival
  // signal exists; pressure can raise it up to the bounded commit fraction.
  function calculateEarlyGameRaceTroops({
    ownTroops = 0,
    baseTroops = 0,
    reserveTroops = 0,
    targetTroops = 0,
    competitorTroops = 0,
    contestPressure = 0,
  } = {}) {
    const own = Math.max(0, Number(ownTroops) || 0);
    const reserve = Math.max(0, Number(reserveTroops) || 0);
    const available = Math.max(0, own - reserve);
    const base = Math.min(available, Math.max(0, Number(baseTroops) || 0));
    const pressure = finiteEarlyGameSignal(contestPressure);
    if (available <= 0 || pressure <= 0) return base;

    const target = Math.max(0, Number(targetTroops) || 0);
    const rivalTroops = Math.max(0, Number(competitorTroops) || 0);
    const raceRequired = Math.max(base, target * 4, base + rivalTroops);
    return Math.min(
      available,
      base + (raceRequired - base) * pressure,
    );
  }

  function isEarlyGameTribeActionable(candidate = {}) {
    return (
      candidate.landBorder === true ||
      isEarlyGameBoatEta(candidate.boatEtaTicks)
    );
  }

  function calculateEarlyGameRouteEfficiency(candidate = {}) {
    if (candidate.landBorder === true) return 1;
    const eta = candidate.boatEtaTicks;
    return isEarlyGameBoatEta(eta)
      ? finiteEarlyGameSignal(1 - eta / EARLY_GAME_MAX_BOAT_TICKS)
      : 0;
  }

  function calculateEarlyGameMaritimeOpportunity(candidate = {}) {
    const distances = [candidate.maritimeDistance, candidate.oceanDistance]
      .map(Number)
      .filter((distance) => Number.isFinite(distance) && distance >= 0);
    if (distances.length === 0) return 0;
    const distance = Math.min(...distances);
    return finiteEarlyGameSignal(
      1 - distance / EARLY_GAME_MAX_MARITIME_DISTANCE,
    );
  }

  // All six strategic dimensions use the same [0, 1] scale and equal weight.
  // Hard feasibility is handled separately so an unknown sea route cannot win
  // by compensating with unrelated strategic signals.
  function calculateEarlyGameTribeUtility(candidate = {}) {
    if (!isEarlyGameTribeActionable(candidate)) return -Infinity;
    const routeEfficiency = calculateEarlyGameRouteEfficiency(candidate);
    const captureEfficiency = finiteEarlyGameSignal(
      candidate.captureEfficiency == null
        ? candidate.cheapCapture
        : candidate.captureEfficiency,
    );
    const raceUrgency = Math.max(
      finiteEarlyGameSignal(candidate.foodRaceValue),
      finiteEarlyGameSignal(candidate.contestPressure),
      Number(candidate.directAttackers) > 0 ||
        Number(candidate.incomingAttackers) > 0
        ? 1
        : 0,
    );
    const territorialControl = Math.max(
      finiteEarlyGameSignal(candidate.encirclement),
      finiteEarlyGameSignal(candidate.blockValue),
    );
    const continuation = calculateEarlyGameContinuationValue(candidate);
    const maritimeOpportunity =
      calculateEarlyGameMaritimeOpportunity(candidate);
    return (
      routeEfficiency +
      captureEfficiency +
      raceUrgency +
      territorialControl +
      continuation +
      maritimeOpportunity
    ) / 6;
  }

  // Utility decides the target; the remaining fields only make equal results
  // deterministic and safer to execute.
  function earlyGameTribeSortKey(candidate = {}) {
    const distance = Number(candidate.distance);
    return [
      calculateEarlyGameTribeUtility(candidate),
      finiteEarlyGameSignal(candidate.captureEfficiency),
      calculateEarlyGameRouteEfficiency(candidate),
      calculateEarlyGameContinuationValue(candidate),
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
      .filter(isEarlyGameTribeActionable)
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => compareEarlyGameTribes(a.candidate, b.candidate) || a.index - b.index)
      .map(({ candidate }) => candidate);
  }

  function isEarlyGameTribeTarget(target) {
    if (!target || target.alive === false || target.friendly === true) return false;
    return isEarlyGameTribeActionable(target);
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
