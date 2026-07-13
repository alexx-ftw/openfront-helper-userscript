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
  // Team donations should not consume the opening expansion force while a nearby
  // land or sea tribe can be reached within the requested 30 game ticks.
  const AUTO_DONATE_EXPANSION_MAX_TICKS = 30;
  // Keep maritime targeting local to the opening frontier. This is the same
  // bounded radius used by the former open-ocean search; a distant coast must
  // not outrank an urgent nearby attack merely because it is finite.
  const EARLY_GAME_MAX_MARITIME_DISTANCE = 80;
  // The troop curve used by Config.troopIncreaseRate peaks at roughly 42% of
  // maxTroops. The opening policy uses that point as a target, but it does not
  // wait for a large absolute maxTroops reserve while the empire is still tiny:
  // expansion raises the cap and is the reason to spend the surplus now.
  const EARLY_GAME_OPTIMAL_GENERATION_RATIO = 0.42;
  const EARLY_GAME_MAX_RECOVERY_TICKS = 600;
  const EARLY_GAME_MIN_DECISION_TICKS = 2;
  const EARLY_GAME_MAX_DECISION_TICKS = 30;
  const EARLY_GAME_TRIBE_CAPTURE_TILE_THRESHOLD = 99;
  const EARLY_GAME_CAPTURE_SEARCH_STEPS = 24;

  function requiredTribeCaptureTiles(
    targetTiles = 0,
    expectedTiles = 1,
    captureTiles = null,
  ) {
    const explicitTiles = Number(captureTiles);
    if (Number.isFinite(explicitTiles) && explicitTiles > 0) {
      return Math.max(1, Math.ceil(explicitTiles));
    }
    const ownedTiles = Number(targetTiles);
    if (Number.isFinite(ownedTiles) && ownedTiles > 0) {
      return Math.max(
        1,
        Math.ceil(ownedTiles) - EARLY_GAME_TRIBE_CAPTURE_TILE_THRESHOLD,
      );
    }
    return Math.max(1, Math.ceil(Number(expectedTiles) || 1));
  }

  // Find the smallest attack force that survives a supplied sequence of
  // attackLogic results. The live adapter supplies Config.attackLogic, so the
  // caller can use the same terrain, fallout, Defense Post, traitor, and target
  // size rules as AttackExecution instead of guessing with a troop multiplier.
  // The fallback is intentionally caller-provided for older adapters that do not
  // expose the engine formula.
  function estimateTribeCaptureTroops({
    targetTiles = 0,
    expectedTiles = 1,
    captureTiles = null,
    simulateAttack = null,
    fallbackTroops = 0,
  } = {}) {
    const tilesToCapture = requiredTribeCaptureTiles(
      targetTiles,
      expectedTiles,
      captureTiles,
    );
    if (typeof simulateAttack === "function") {
      let high = 1;
      let canCapture = false;
      for (let step = 0; step < EARLY_GAME_CAPTURE_SEARCH_STEPS; step += 1) {
        if (simulateAttack(high, tilesToCapture) === true) {
          canCapture = true;
          break;
        }
        high *= 2;
      }
      if (canCapture) {
        let low = 0;
        for (let step = 0; step < EARLY_GAME_CAPTURE_SEARCH_STEPS; step += 1) {
          const midpoint = (low + high) / 2;
          if (simulateAttack(midpoint, tilesToCapture) === true) {
            high = midpoint;
          } else {
            low = midpoint;
          }
        }
        return Math.max(1, Math.ceil(high));
      }

      // A live attack-loss simulation is authoritative. If no force survives
      // every required tile, do not fail open with a one-troop fallback: that
      // creates an attack which can only leave a remnant and drain the reserve.
      return Number.POSITIVE_INFINITY;
    }

    const fallback = Number(fallbackTroops);
    return Math.max(1, Number.isFinite(fallback) ? Math.ceil(fallback) : 1);
  }

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

  function normalizeTransportMovement(options = {}) {
    const speed = Number(options.speed);
    if (Number.isFinite(speed) && speed > 0) {
      return { speed };
    }
    const ticksPerMove = Number(options.ticksPerMove);
    if (Number.isFinite(ticksPerMove) && ticksPerMove > 0) {
      return { ticksPerMove };
    }
    // Current OpenFront TransportShipExecution advances one path node per tick.
    return { ticksPerMove: 1 };
  }

  function transportPathStepsToTicks(steps, movement = {}) {
    const safeSteps = Math.max(0, Number(steps) || 0);
    const normalized = normalizeTransportMovement(movement);
    if (Number.isFinite(normalized.speed)) {
      return Math.ceil(safeSteps / normalized.speed);
    }
    return Math.ceil(safeSteps * normalized.ticksPerMove);
  }

  function maxTransportPathSteps(maxTicks, movement = {}) {
    const limit = Math.max(0, Number(maxTicks) || 0);
    const normalized = normalizeTransportMovement(movement);
    if (Number.isFinite(normalized.speed)) {
      return Math.floor(limit * normalized.speed);
    }
    return Math.floor(limit / normalized.ticksPerMove);
  }

  // Bounded shortest-path search over the full-resolution water graph exposed by
  // GameView. The source and destination are shore tiles; only water tiles may be
  // traversed between them. The returned value is movement ticks, not raw water
  // edges, so the caller can account for the transport's speed/ticks-per-move.
  // Returning null is deliberately conservative when the route exceeds the
  // requested window or the search budget.
  function findWaterRouteTicks({
    start,
    goal,
    neighbors,
    isWater,
    maxTicks = EARLY_GAME_MAX_BOAT_TICKS,
    maxVisited = 100000,
    speed,
    ticksPerMove,
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

    const limit = Number.isFinite(Number(maxTicks))
      ? Math.max(0, Number(maxTicks))
      : EARLY_GAME_MAX_BOAT_TICKS;
    const movement = normalizeTransportMovement({ speed, ticksPerMove });
    const maxPathSteps = maxTransportPathSteps(limit, movement);
    const queue = [start];
    const distances = new Map([[start, 0]]);
    for (let head = 0; head < queue.length; head++) {
      if (distances.size > maxVisited) return null;
      const current = queue[head];
      const currentDistance = distances.get(current);
      if (currentDistance == null || currentDistance >= maxPathSteps) continue;

      const nextDistance = currentDistance + 1;
      for (const next of neighbors(current) || []) {
        if (next !== goal && next !== start && !isWater(next)) continue;
        if (distances.has(next)) continue;
        if (next === goal) {
          const ticks = transportPathStepsToTicks(nextDistance, movement);
          return ticks <= limit ? ticks : null;
        }
        distances.set(next, nextDistance);
        queue.push(next);
      }
    }
    return null;
  }

  // Transport motion plans include their source tile, therefore movement time is
  // the number of edges, not the number of path entries.
  function transportRouteTicks(path, movement = {}) {
    const route = path && path.fullPath ? path.fullPath : path;
    if (route == null || typeof route.length !== "number" || route.length === 0) {
      return null;
    }
    const length = Number(route.length);
    return Number.isFinite(length)
      ? transportPathStepsToTicks(Math.max(0, length - 1), movement)
      : null;
  }

  // Measure the shortest LAND distance from any tile on a tribe's border to a
  // navigable maritime coast. The predicate is supplied by the caller:
  // The caller supplies the largest connected navigable-water component as the
  // maritime predicate. Smaller isolated lakes/seas must not satisfy this
  // objective, even when they are close or touch the map edge.
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

  // Mirrors Config.troopIncreaseRate for the Human-controlled custom bot. The
  // caller may pass a multiplier for adapters/difficulties that apply a known
  // modifier; the default is the live human curve (no Bot 0.5 modifier).
  function calculateTroopGenerationRate({
    troops = 0,
    maxTroops = 1,
    multiplier = 1,
  } = {}) {
    const maximum = Math.max(1, Number(maxTroops) || 0);
    const current = Math.max(0, Math.min(maximum, Number(troops) || 0));
    const safeMultiplier = Math.max(0, Number(multiplier) || 0);
    const base = 10 + Math.pow(current, 0.73) / 4;
    return Math.max(0, base * (1 - current / maximum) * safeMultiplier);
  }

  // A small deterministic scan is more robust than hard-coding 0.42 when a
  // future upstream exponent changes. It is called once per early-game decision,
  // not from a map-wide scoring loop.
  function findOptimalGenerationRatio({
    exponent = 0.73,
    steps = 100,
  } = {}) {
    const safeExponent = Number.isFinite(Number(exponent))
      ? Math.max(0.1, Number(exponent))
      : 0.73;
    const safeSteps = Math.max(20, Math.min(400, Math.floor(Number(steps) || 100)));
    let bestRatio = EARLY_GAME_OPTIMAL_GENERATION_RATIO;
    let bestRate = -Infinity;
    for (let index = 0; index <= safeSteps; index += 1) {
      const ratio = index / safeSteps;
      const troops = Math.max(1, ratio * 100000);
      const rate = (10 + Math.pow(troops, safeExponent) / 4) * (1 - ratio);
      if (rate > bestRate) {
        bestRate = rate;
        bestRatio = ratio;
      }
    }
    return bestRatio;
  }

  function estimateTroopRecoveryTicks({
    troops = 0,
    maxTroops = 1,
    targetTroops = 0,
    multiplier = 1,
    maxTicks = EARLY_GAME_MAX_RECOVERY_TICKS,
  } = {}) {
    const maximum = Math.max(1, Number(maxTroops) || 0);
    let current = Math.max(0, Math.min(maximum, Number(troops) || 0));
    const target = Math.max(0, Math.min(maximum, Number(targetTroops) || 0));
    if (current >= target) return 0;
    const limit = Math.max(1, Math.min(5000, Math.floor(Number(maxTicks) || 0)));
    for (let tick = 1; tick <= limit; tick += 1) {
      current = Math.min(
        maximum,
        current + calculateTroopGenerationRate({
          troops: current,
          maxTroops: maximum,
          multiplier,
        }),
      );
      if (current >= target) return tick;
    }
    return limit + 1;
  }

  // Config.attackLogic's terrain magnitudes are 80/100/120 for plains,
  // highland, and mountain. Map magnitudes are 0..31, so preserve the same
  // thresholds used by the spawn index and the upstream attack code.
  function terrainAttackMagnitudeFromMapMagnitude(magnitude) {
    const value = Number(magnitude);
    if (!Number.isFinite(value)) return 100;
    if (value < 10) return 80;
    if (value < 20) return 100;
    return 120;
  }

  function calculateEarlyGameExpansionPlan({
    ownTroops = 0,
    maxTroops = 1,
    generationMultiplier = 1,
    targetType = "land",
    targetTroops = 0,
    captureTroops = null,
    targetDefenseMultiplier = 1,
    terrainMagnitude = 100,
    expectedTiles = 6,
    baseReserveRatio = 0.3,
    activeAttackTroops = 0,
    urgent = false,
    opportunityUrgency = 0,
    contestPressure = 0,
    competitorTroops = 0,
    initialBurst = false,
  } = {}) {
    const maximum = Math.max(1, Number(maxTroops) || 0);
    const own = Math.max(0, Math.min(maximum, Number(ownTroops) || 0));
    const currentRatio = own / maximum;
    const optimalRatio = findOptimalGenerationRatio();
    const safeBaseReserve = Math.max(
      0.12,
      Math.min(0.8, Number(baseReserveRatio) || 0.3),
    );
    const generationRate = calculateTroopGenerationRate({
      troops: own,
      maxTroops: maximum,
      multiplier: generationMultiplier,
    });
    const generationCeiling = 10 + Math.pow(maximum, 0.73) / 4;
    const generationEfficiency = finiteEarlyGameSignal(
      generationRate / Math.max(1, generationCeiling),
    );
    const target = targetType === "tribe" ? "tribe" : "land";
    const safeOpportunityUrgency = Math.max(
      finiteEarlyGameSignal(opportunityUrgency),
      urgent ? 1 : 0,
    );
    const defenseMultiplier = Math.max(
      1,
      Number(targetDefenseMultiplier) || 1,
    );
    const mapMagnitude = terrainAttackMagnitudeFromMapMagnitude(terrainMagnitude);
    const terrainLossPerTile = (mapMagnitude / 5) * defenseMultiplier;
    const tiles = Math.max(1, Number(expectedTiles) || 1);
    const safeContestPressure = finiteEarlyGameSignal(contestPressure);
    const rivalTroops = Math.max(0, Number(competitorTroops) || 0);
    const exactCaptureTroops = Number(captureTroops);

    const targetGenerationTroops = maximum * optimalRatio;
    const belowGenerationTarget = own < targetGenerationTroops;
    // When the empire is below its theoretical peak, holding maxTroops*0.42
    // would freeze the opening for a long time. Keep a small live reserve and
    // use the conquest itself to grow the cap; once the curve is reached, the
    // normal generation target becomes the reserve floor.
    const adaptiveReserveFraction = safeOpportunityUrgency >= 0.45
      ? 0.12
      : target === "tribe"
        ? 0.24
        : 0.18;
    const reserveTroops = initialBurst
      ? 0
      : belowGenerationTarget
        ? own * adaptiveReserveFraction
        : Math.max(own * safeBaseReserve, targetGenerationTroops);
    const active = Math.max(0, Number(activeAttackTroops) || 0);
    const availableTroops = Math.max(0, own - reserveTroops - active);

    let requiredTroops = terrainLossPerTile * tiles * 1.35;
    if (target === "tribe") {
      if (Number.isFinite(exactCaptureTroops) && exactCaptureTroops > 0) {
        requiredTroops = exactCaptureTroops;
      } else {
        // A tribe is an all-or-nothing target. Without an exact capture
        // requirement, the planner has no safe basis for sending a partial
        // force, so it must wait for the live attack simulation.
        requiredTroops = Number.POSITIVE_INFINITY;
      }
      if (safeContestPressure > 0) {
        const tribeTroops = Math.max(1, Number(targetTroops) || 0);
        requiredTroops = Math.max(
          requiredTroops,
          tribeTroops + rivalTroops * (1.15 + safeContestPressure * 0.35),
        );
      }
    }
    requiredTroops = Math.max(1, requiredTroops);
    const remainingRequiredTroops =
      target === "tribe"
        ? Number.isFinite(requiredTroops)
          ? Math.max(0, requiredTroops - active)
          : Number.POSITIVE_INFINITY
        : requiredTroops;

    const maxCommitFraction = initialBurst
      ? 0.6
      : target === "tribe"
        ? safeOpportunityUrgency >= 0.45 || safeContestPressure >= 0.45
          ? 0.78
          : 0.68
        : urgent
          ? 0.75
          : safeOpportunityUrgency >= 0.45
            ? 0.72
          : 0.6;
    const plannedCommitCeiling = own * maxCommitFraction;
    const minimumCommit =
      target === "tribe" ? remainingRequiredTroops : plannedCommitCeiling;
    let commitTroops = 0;
    if (target === "tribe") {
      if (initialBurst) {
        // The opening burst is a single slot. Never add another burst while
        // its troops are already in flight.
        commitTroops = active > 0 ? 0 : Math.min(own, plannedCommitCeiling);
      } else if (Number.isFinite(minimumCommit) && minimumCommit > 0) {
        // For tribes the calculated requirement is the commitment. Do not
        // replace it with a large percentage of the army; only top up what is
        // missing from active attacks.
        commitTroops = Math.min(availableTroops, minimumCommit);
      }
    } else {
      commitTroops = initialBurst
        ? Math.min(own, plannedCommitCeiling)
        : Math.min(availableTroops, Math.max(plannedCommitCeiling, minimumCommit));
    }
    const hasFullTribeCommit =
      target !== "tribe" ||
      (Number.isFinite(requiredTroops) &&
        active + commitTroops >= requiredTroops);
    const hasRequiredCommit =
      target === "tribe" ? hasFullTribeCommit : commitTroops >= requiredTroops;
    const shouldAttackNow =
      own >= 1 &&
      (target === "tribe" || initialBurst || active <= 0) &&
      (target !== "tribe" || remainingRequiredTroops > 0) &&
      hasRequiredCommit;

    const afterCommit = Math.max(0, own - commitTroops);
    const recoveryTarget = Math.min(
      maximum,
      Math.max(
        reserveTroops,
        Math.min(
          targetGenerationTroops,
          afterCommit + Math.max(requiredTroops * 0.25, afterCommit * 0.08),
        ),
      ),
    );
    const recoveryTicks = estimateTroopRecoveryTicks({
      troops: own,
      maxTroops: maximum,
      targetTroops: reserveTroops,
      multiplier: generationMultiplier,
    });
    const postCommitRecoveryTicks = estimateTroopRecoveryTicks({
      troops: afterCommit,
      maxTroops: maximum,
      targetTroops: recoveryTarget,
      multiplier: generationMultiplier,
    });
    const nextDecisionTicks = shouldAttackNow
      ? Math.max(
          EARLY_GAME_MIN_DECISION_TICKS,
          Math.min(
            EARLY_GAME_MAX_DECISION_TICKS,
            Math.round(8 - generationEfficiency * 5) +
              (safeOpportunityUrgency >= 0.45 ? 0 : 1),
          ),
        )
      : Math.max(
          EARLY_GAME_MIN_DECISION_TICKS,
          Math.min(
            EARLY_GAME_MAX_DECISION_TICKS,
            Math.max(4, recoveryTicks || postCommitRecoveryTicks || 4),
          ),
        );

    return {
      ownTroops: own,
      maxTroops: maximum,
      generationRate,
      generationRatio: currentRatio,
      generationEfficiency,
      optimalGenerationRatio: optimalRatio,
      targetGenerationTroops,
      targetType: target,
      targetTroops: Math.max(0, Number(targetTroops) || 0),
      captureTroops:
        Number.isFinite(exactCaptureTroops) && exactCaptureTroops > 0
          ? Math.ceil(exactCaptureTroops)
          : null,
      defenseMultiplier,
      terrainMagnitude: mapMagnitude,
      terrainLossPerTile,
      expectedTiles: tiles,
      requiredTroops,
      remainingRequiredTroops,
      reserveTroops,
      availableTroops,
      activeAttackTroops: active,
      activeAttack: active > 0,
      maxCommitFraction,
      commitTroops,
      commitFraction: own > 0 ? commitTroops / own : 0,
      shouldAttackNow,
      recoveryTicks,
      postCommitRecoveryTicks,
      nextDecisionTicks,
      urgent: Boolean(
        safeOpportunityUrgency >= 0.45 || safeContestPressure >= 0.45,
      ),
      opportunityUrgency: safeOpportunityUrgency,
      irreversibleOpportunity: safeOpportunityUrgency >= 0.45,
    };
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
  // that can lead to a navigable river, open sea, or ocean. A direct/incoming
  // rival attack is an immediate
  // race and stays urgent; otherwise close an encirclement or block a passage
  // before taking the central shortcut with the largest future-food count. The
  // progressing-vector race signal still participates after those structural
  // opportunities, so it is considered without making the bot cut through a
  // winnable ring of tribes. The closure score uses the stronger of encirclement
  // and blocking rather than requiring both at once.
  function earlyGameTribeSortKey(candidate = {}) {
    const maritimeDistance =
      candidate.maritimeDistance == null
        ? Infinity
        : Number(candidate.maritimeDistance);
    const oceanDistance =
      candidate.oceanDistance == null ? Infinity : Number(candidate.oceanDistance);
    const nearestMaritimeDistance =
      Number.isInteger(maritimeDistance) &&
      maritimeDistance >= 0 &&
      maritimeDistance <= EARLY_GAME_MAX_MARITIME_DISTANCE
        ? maritimeDistance
        : Number.isInteger(oceanDistance) &&
            oceanDistance >= 0 &&
            oceanDistance <= EARLY_GAME_MAX_MARITIME_DISTANCE
          ? oceanDistance
          : Infinity;
    const hasMaritimeAccess = Number.isFinite(nearestMaritimeDistance);
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
    const expansionPlan = candidate.expansionPlan;
    const captureReady = expansionPlan?.shouldAttackNow === true ? 1 : 0;
    const opportunityUrgency = finiteEarlyGameSignal(
      expansionPlan?.opportunityUrgency,
    );
    const captureEfficiency = expansionPlan
      ? finiteEarlyGameSignal(
          Number(expansionPlan.commitTroops) /
            Math.max(1, Number(expansionPlan.requiredTroops)),
        )
      : 0;
    return [
      hasMaritimeAccess ? 1 : 0,
      hasMaritimeAccess ? -nearestMaritimeDistance : 0,
      hasImmediateRace ? 1 : 0,
      captureReady,
      opportunityUrgency,
      closureValue,
      finiteEarlyGameSignal(candidate.encirclement),
      finiteEarlyGameSignal(candidate.blockValue),
      calculateEarlyGameContinuationValue(candidate),
      foodRaceValue,
      captureEfficiency,
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
