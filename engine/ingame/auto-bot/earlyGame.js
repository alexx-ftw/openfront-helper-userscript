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
    return finiteEarlyGameSignal(countScore * 0.75 + proximityScore * 0.25);
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
    return finiteEarlyGameSignal(
      directSignal * 0.55 + momentumSignal * 0.25 + strengthSignal * 0.2,
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
    maxCommitFraction = 0.75,
  } = {}) {
    const own = Math.max(0, Number(ownTroops) || 0);
    const reserve = Math.max(0, Number(reserveTroops) || 0);
    const available = Math.max(0, own - reserve);
    const base = Math.min(available, Math.max(0, Number(baseTroops) || 0));
    const pressure = finiteEarlyGameSignal(contestPressure);
    if (available <= 0 || pressure <= 0) return base;

    const target = Math.max(0, Number(targetTroops) || 0);
    const rivalTroops = Math.max(0, Number(competitorTroops) || 0);
    const overtakeAmount = Math.max(target * 4, target + rivalTroops * 1.15);
    const capFraction = finiteEarlyGameSignal(maxCommitFraction) || 0.75;
    const urgencyFraction = Math.min(
      capFraction,
      0.18 + pressure * 0.55,
    );
    return Math.min(
      available,
      Math.max(base, overtakeAmount, own * urgencyFraction),
    );
  }

  // Early-Game tribe order is deliberately lexicographic. First choose tribes
  // that can lead to open ocean. A direct/incoming rival attack is an immediate
  // race and stays urgent; otherwise close an encirclement or block a passage
  // before taking the central shortcut with the largest future-food count. The
  // progressing-vector race signal still participates after those structural
  // opportunities, so it is considered without making the bot cut through a
  // winnable ring of tribes. The closure score uses the stronger of encirclement
  // and blocking rather than requiring both at once.
  function earlyGameTribeSortKey(candidate = {}) {
    const oceanDistance = Number(candidate.oceanDistance);
    const hasOpenOcean = Number.isFinite(oceanDistance);
    const distance = Number(candidate.distance);
    const foodRaceValue = Math.max(
      finiteEarlyGameSignal(candidate.foodRaceValue),
      finiteEarlyGameSignal(candidate.contestPressure),
    );
    const hasImmediateRace =
      Number(candidate.directAttackers) > 0 ||
      Number(candidate.incomingAttackers) > 0;
    const closureValue = Math.max(
      finiteEarlyGameSignal(candidate.encirclement),
      finiteEarlyGameSignal(candidate.blockValue),
    );
    return [
      hasOpenOcean ? 1 : 0,
      hasOpenOcean ? -oceanDistance : 0,
      hasImmediateRace ? 1 : 0,
      closureValue,
      finiteEarlyGameSignal(candidate.encirclement),
      finiteEarlyGameSignal(candidate.blockValue),
      calculateEarlyGameContinuationValue(candidate),
      foodRaceValue,
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
