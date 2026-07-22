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
  // Exploration boats must stay local enough to be useful. Keep this as a hard
  // policy cap: at the normal 10 ticks/s rate, two minutes is 1,200 movement
  // ticks. The route estimator may return a longer exact route, but callers
  // must reject it rather than silently treating it as merely reachable.
  const BOAT_EXPLORATION_MAX_ROUTE_TICKS = 1200;
  // A local water graph can branch heavily. Keep the synchronous compatibility
  // helper and the yielding estimator from exploring an unbounded map region.
  const WATER_ROUTE_MAX_VISITED = 1280;
  // Keep each live fallback-search slice below a frame budget on slower CPUs.
  // The route helpers call into wrapped GameView methods for every expansion,
  // so a smaller batch is safer than assuming each graph lookup is trivial.
  const WATER_ROUTE_YIELD_EVERY = 64;
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

  function isBoatExplorationEta(etaTicks) {
    if (etaTicks == null) return false;
    const numericEta = Number(etaTicks);
    return (
      Number.isFinite(numericEta) &&
      numericEta >= 0 &&
      numericEta <= BOAT_EXPLORATION_MAX_ROUTE_TICKS
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
    maxVisited = WATER_ROUTE_MAX_VISITED,
  } = {}) {
    if (!validWaterRouteSearch(start, goal, neighbors, isWater)) return null;
    if (start === goal) return 0;

    const queue = [start];
    const distances = new Map([[start, 0]]);
    for (let head = 0; head < queue.length; head++) {
      if (distances.size > maxVisited) return null;
      const current = queue[head];
      const currentDistance = distances.get(current);
      if (currentDistance == null || currentDistance >= maxTicks) continue;

      const nextDistance = currentDistance + 1;
      const found = expandWaterRouteNode({
        current,
        start,
        goal,
        nextDistance,
        neighbors,
        isWater,
        distances,
        queue,
      });
      if (found) return nextDistance;
    }
    return null;
  }

  function validWaterRouteSearch(start, goal, neighbors, isWater) {
    return (
      start != null &&
      goal != null &&
      typeof neighbors === "function" &&
      typeof isWater === "function"
    );
  }

  function yieldWaterRouteSearch() {
    return new Promise((resolve) => {
      if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
        window.setTimeout(resolve, 0);
      } else if (typeof setTimeout === "function") {
        setTimeout(resolve, 0);
      } else {
        resolve();
      }
    });
  }

  function waterRouteDeadlineNow() {
    if (
      typeof window !== "undefined" &&
      typeof window.__OFH_deadlineNow === "function"
    ) {
      return Number(window.__OFH_deadlineNow());
    }
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  function waterRouteDeadlineExpired(deadlineMs, startedAt) {
    return deadlineMs > 0 && waterRouteDeadlineNow() - startedAt >= deadlineMs;
  }

  function shouldYieldWaterRouteSearch(head, batchSize) {
    return head > 0 && head % batchSize === 0;
  }

  function normalizeWaterRouteBatchSize(yieldEvery) {
    const requested = Number(yieldEvery);
    const value = Number.isFinite(requested) ? requested : WATER_ROUTE_YIELD_EVERY;
    return Math.max(1, Math.floor(value));
  }

  function canExpandWaterRouteNode(distance, maxTicks) {
    return distance != null && distance < maxTicks;
  }

  function expandWaterRouteNode({
    current,
    start,
    goal,
    nextDistance,
    neighbors,
    isWater,
    distances,
    queue,
  }) {
    for (const next of neighbors(current) || []) {
      if (next !== goal && next !== start && !isWater(next)) continue;
      if (distances.has(next)) continue;
      if (next === goal) return true;
      distances.set(next, nextDistance);
      queue.push(next);
    }
    return false;
  }

  // Async counterpart used by the live GameApi fallback. The old route search
  // ran synchronously before withTimeout could install its timer, so a wide
  // water graph could monopolize the main thread even though callers awaited
  // the returned Promise. Yield between bounded BFS batches to keep rendering
  // and input responsive while preserving the same shortest-path result.
  async function findWaterRouteTicksAsync({
    start,
    goal,
    neighbors,
    isWater,
    maxTicks = EARLY_GAME_MAX_BOAT_TICKS,
    maxVisited = WATER_ROUTE_MAX_VISITED,
    yieldEvery = WATER_ROUTE_YIELD_EVERY,
    deadlineMs = 0,
  } = {}) {
    if (!validWaterRouteSearch(start, goal, neighbors, isWater)) return null;
    if (start === goal) return 0;

    const batchSize = normalizeWaterRouteBatchSize(yieldEvery);
    const searchStartedAt = waterRouteDeadlineNow();
    const searchDeadlineMs = Math.max(0, Number(deadlineMs) || 0);
    const queue = [start];
    const distances = new Map([[start, 0]]);
    for (let head = 0; head < queue.length; head++) {
      if (distances.size > maxVisited) return null;
      // Promise.race timeouts cannot cancel work that is already running. Stop
      // the search itself so repeated candidate probes cannot accumulate stale
      // BFS jobs and saturate the game renderer after callers time out.
      if (waterRouteDeadlineExpired(searchDeadlineMs, searchStartedAt)) {
        return null;
      }
      if (shouldYieldWaterRouteSearch(head, batchSize)) {
        await yieldWaterRouteSearch();
      }

      const current = queue[head];
      const currentDistance = distances.get(current);
      if (!canExpandWaterRouteNode(currentDistance, maxTicks)) continue;

      const nextDistance = currentDistance + 1;
      const found = expandWaterRouteNode({
        current,
        start,
        goal,
        nextDistance,
        neighbors,
        isWater,
        distances,
        queue,
      });
      if (found) return nextDistance;
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
  function seedMaritimeCoastSearch(starts, isLand) {
    const queue = [];
    const distances = new Map();
    for (const tile of Array.from(starts)) {
      if (tile == null || distances.has(tile) || !isLand(tile)) continue;
      distances.set(tile, 0);
      queue.push(tile);
    }
    return { queue, distances };
  }

  function expandMaritimeCoastNode(current, distance, neighbors, isLand, search) {
    for (const next of neighbors(current) || []) {
      if (search.distances.has(next) || !isLand(next)) continue;
      search.distances.set(next, distance + 1);
      search.queue.push(next);
    }
  }

  function findNearestMaritimeCoastDistance({
    starts,
    neighbors,
    isLand,
    isMaritimeShore,
    maxDistance = EARLY_GAME_MAX_MARITIME_DISTANCE,
    maxVisited = 5000,
  } = {}) {
    if (!validMaritimeDistanceSearch(starts, neighbors, isLand, isMaritimeShore)) return Infinity;

    const search = seedMaritimeCoastSearch(starts, isLand);

    for (let head = 0; head < search.queue.length; head++) {
      if (search.distances.size > maxVisited) return Infinity;
      const current = search.queue[head];
      const distance = search.distances.get(current);
      if (isMaritimeShore(current)) return distance;
      if (distance >= maxDistance) continue;
      expandMaritimeCoastNode(current, distance, neighbors, isLand, search);
    }
    return Infinity;
  }

  function validMaritimeDistanceSearch(starts, neighbors, isLand, isMaritimeShore) {
    return (
      starts != null &&
      typeof neighbors === "function" &&
      typeof isLand === "function" &&
      typeof isMaritimeShore === "function"
    );
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
  function validMaritimeDistanceIndexOptions(options) {
    return (
      Number.isInteger(options.width) &&
      Number.isInteger(options.height) &&
      options.width > 0 &&
      options.height > 0 &&
      Number.isSafeInteger(options.total) &&
      Number.isInteger(options.distanceLimit) &&
      options.distanceLimit >= 0 &&
      (typeof options.forEachNeighbor === "function" ||
        typeof options.neighbors === "function") &&
      typeof options.isLand === "function" &&
      typeof options.isMaritimeShore === "function"
    );
  }

  function createMaritimeDistanceBuffer(total, distanceLimit) {
    const maximumEncodedDistance = distanceLimit + 1;
    if (maximumEncodedDistance <= 0xff) return new Uint8Array(total);
    if (maximumEncodedDistance <= 0xffff) return new Uint16Array(total);
    return new Uint32Array(total);
  }

  function createMaritimeDistanceIndexBuilder({
    width,
    height,
    neighbors,
    forEachNeighbor,
    isLand,
    isMaritimeShore,
    maxDistance = EARLY_GAME_MAX_MARITIME_DISTANCE,
  } = {}) {
    const mapWidth = Number(width);
    const mapHeight = Number(height);
    const total = mapWidth * mapHeight;
    const distanceLimit = Number(maxDistance);
    if (
      !validMaritimeDistanceIndexOptions({
        width: mapWidth,
        height: mapHeight,
        total,
        distanceLimit,
        neighbors,
        forEachNeighbor,
        isLand,
        isMaritimeShore,
      })
    ) {
      return null;
    }
    // Zero is the native unvisited sentinel; reachable distances are stored as
    // distance+1. This avoids synchronously filling a map-sized array before
    // the cooperative builder gets its first chance to yield.
    const distances = createMaritimeDistanceBuffer(total, distanceLimit);
    return {
      width: mapWidth,
      height: mapHeight,
      total,
      distanceLimit,
      neighbors,
      forEachNeighbor,
      isLand,
      isMaritimeShore,
      distances,
      queue: new Int32Array(Math.min(total, 1024)),
      seedCursor: 0,
      head: 0,
      tail: 0,
      phase: "seed",
      done: false,
      index: null,
    };
  }

  function ensureMaritimeDistanceQueueCapacity(builder, requiredLength) {
    if (requiredLength <= builder.queue.length) return;
    let nextLength = Math.max(1, builder.queue.length);
    while (nextLength < requiredLength) {
      nextLength = Math.min(builder.total, nextLength * 2);
    }
    const expanded = new Int32Array(nextLength);
    expanded.set(builder.queue.subarray(0, builder.tail));
    builder.queue = expanded;
  }

  function seedMaritimeDistanceIndexStep(builder) {
    const tile = builder.seedCursor;
    const maritime = builder.isLand(tile)
      ? builder.isMaritimeShore(tile)
      : false;
    if (maritime === null) return false;
    builder.seedCursor++;
    if (maritime) {
      builder.distances[tile] = 1;
      ensureMaritimeDistanceQueueCapacity(builder, builder.tail + 1);
      builder.queue[builder.tail++] = tile;
    }
    if (builder.seedCursor >= builder.total) builder.phase = "expand";
    return true;
  }

  function addMaritimeBuilderNeighbor(builder, next, nextDistance) {
    if (
      !Number.isInteger(next) ||
      next < 0 ||
      next >= builder.total ||
      !builder.isLand(next) ||
      builder.distances[next] !== 0
    ) {
      return;
    }
    builder.distances[next] = nextDistance + 1;
    ensureMaritimeDistanceQueueCapacity(builder, builder.tail + 1);
    builder.queue[builder.tail++] = next;
  }

  function expandMaritimeDistanceIndexStep(builder) {
    if (builder.head >= builder.tail) {
      builder.done = true;
      builder.index = {
        distances: builder.distances,
        width: builder.width,
        height: builder.height,
      };
      return;
    }
    const current = builder.queue[builder.head++];
    const currentDistance = builder.distances[current] - 1;
    if (currentDistance >= builder.distanceLimit) return;
    const nextDistance = currentDistance + 1;
    if (typeof builder.forEachNeighbor === "function") {
      builder.forEachNeighbor(current, (next) =>
        addMaritimeBuilderNeighbor(builder, next, nextDistance));
      return;
    }
    for (const next of builder.neighbors(current) || []) {
      addMaritimeBuilderNeighbor(builder, next, nextDistance);
    }
  }

  function advanceMaritimeDistanceIndexStep(builder) {
    if (builder.phase === "seed") {
      return seedMaritimeDistanceIndexStep(builder);
    }
    expandMaritimeDistanceIndexStep(builder);
    return true;
  }

  function maritimeDistanceSliceShouldYield(
    steps,
    checkInterval,
    shouldYield,
  ) {
    return (
      typeof shouldYield === "function" &&
      steps % checkInterval === 0 &&
      shouldYield()
    );
  }

  function advanceMaritimeDistanceIndexBuilder(
    builder,
    { maxSteps = Infinity, shouldYield = null, yieldCheckInterval = 256 } = {},
  ) {
    if (!builder) return null;
    if (builder.done) return builder.index;
    const stepLimit = Number.isFinite(maxSteps)
      ? Math.max(1, Math.floor(maxSteps))
      : Infinity;
    const checkInterval = Math.max(1, Math.floor(yieldCheckInterval));
    let steps = 0;
    while (!builder.done && steps < stepLimit) {
      const progressed = advanceMaritimeDistanceIndexStep(builder);
      if (progressed) steps++;
      if (maritimeDistanceSliceShouldYield(steps, checkInterval, shouldYield)) break;
      if (!progressed && typeof shouldYield !== "function") {
        throw new Error("Synchronous maritime classification cannot remain pending");
      }
      if (!progressed) break;
    }
    return builder.index;
  }

  function buildMaritimeDistanceIndex({
    width,
    height,
    neighbors,
    forEachNeighbor,
    isLand,
    isMaritimeShore,
    maxDistance = EARLY_GAME_MAX_MARITIME_DISTANCE,
  } = {}) {
    const builder = createMaritimeDistanceIndexBuilder({
      width,
      height,
      neighbors,
      forEachNeighbor,
      isLand,
      isMaritimeShore,
      maxDistance,
    });
    if (!builder) return null;
    return advanceMaritimeDistanceIndexBuilder(builder);
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
      const encoded = index.distances[tile];
      if (encoded === 0) continue;
      const distance = encoded - 1;
      if (distance < best) best = distance;
    }
    return best;
  }

  function finiteEarlyGameSignal(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  }

  function nonnegativeAllianceForce(value) {
    return Math.max(0, Number(value) || 0);
  }

  function hasAllianceForceAdvantage(ownForce, otherForce, ratio) {
    return ownForce > 0 && ownForce >= Math.max(1, otherForce) * ratio;
  }

  function isMuchWeakerAllianceTarget({
    ownTroops = 0,
    ownOutgoingTroops = 0,
    otherTroops = 0,
    otherOutgoingTroops = 0,
    advantageRatio = 4,
    immediateAdvantageRatio = 6,
  } = {}) {
    const ownImmediate = nonnegativeAllianceForce(ownTroops);
    const otherImmediate = nonnegativeAllianceForce(otherTroops);
    const ownTotal =
      ownImmediate + nonnegativeAllianceForce(ownOutgoingTroops);
    const otherTotal =
      otherImmediate + nonnegativeAllianceForce(otherOutgoingTroops);
    const ratio = Math.max(1, Number(advantageRatio) || 4);
    const immediateRatio = Math.max(
      ratio,
      Number(immediateAdvantageRatio) || 6,
    );
    const dominatesTotal = hasAllianceForceAdvantage(
      ownTotal,
      otherTotal,
      ratio,
    );
    const dominatesExposedFront = hasAllianceForceAdvantage(
      ownImmediate,
      otherImmediate,
      immediateRatio,
    );
    return dominatesTotal || dominatesExposedFront;
  }

  // Group tribes by transitive reachability: A may lead to B, which leads to C,
  // even when A and C are farther apart than the local chain radius. This is the
  // strategic shape of a large edible cluster, not merely local point density.
  function calculateConnectedTribeClusterSizes(
    candidates,
    distanceBetween,
    linkRadius,
  ) {
    const nodes = Array.isArray(candidates) ? candidates : [];
    const radius = Math.max(0, Number(linkRadius) || 0);
    const sizes = new Map();
    const remaining = new Set(nodes.map((_node, index) => index));
    while (remaining.size > 0) {
      const first = remaining.values().next().value;
      remaining.delete(first);
      const component = [first];
      for (let head = 0; head < component.length; head++) {
        const current = nodes[component[head]];
        for (const index of [...remaining]) {
          const distance = Number(distanceBetween(current, nodes[index]));
          if (!Number.isFinite(distance) || distance > radius) continue;
          remaining.delete(index);
          component.push(index);
        }
      }
      for (const index of component) {
        sizes.set(nodes[index].id, component.length);
      }
    }
    return sizes;
  }

  // Calculate connected edible components from real shared-border edges. This
  // is invariant to rotation, scale, winding corridors, and territory shape.
  function calculateTribeAdjacencyClusterSizes(candidates, adjacentIdsById) {
    const nodes = Array.isArray(candidates) ? candidates : [];
    const ids = new Set(nodes.map((node) => node.id));
    const sizes = new Map();
    const remaining = new Set(ids);
    while (remaining.size > 0) {
      const first = remaining.values().next().value;
      remaining.delete(first);
      const component = [first];
      for (let head = 0; head < component.length; head++) {
        for (const neighbor of adjacentIdsById?.get(component[head]) || []) {
          if (!ids.has(neighbor) || !remaining.has(neighbor)) continue;
          remaining.delete(neighbor);
          component.push(neighbor);
        }
      }
      for (const id of component) sizes.set(id, component.length);
    }
    return sizes;
  }

  function getTribeAdjacencyComponentIds(startId, adjacentIdsById) {
    if (startId == null) return new Set();
    const seen = new Set([startId]);
    const queue = [startId];
    for (let head = 0; head < queue.length; head++) {
      for (const neighbor of adjacentIdsById?.get(queue[head]) || []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    return seen;
  }

  // Estimate how much of a tribe component will still be edible when we reach
  // it. Each adjacency hop represents one prior conquest. Rival capture risk
  // therefore compounds with route depth: a directly contested next tribe is
  // excluded, while weak/noisy pressure only removes sufficiently remote food.
  // Excluded nodes are not traversed because an enemy-owned corridor cannot
  // unlock tribes beyond it for our land expansion.
  function calculateReachableTribeClusterOpportunity(
    startId,
    candidates,
    adjacentIdsById,
  ) {
    const nodesById = new Map(
      (Array.isArray(candidates) ? candidates : []).map((node) => [node.id, node]),
    );
    if (!nodesById.has(startId)) {
      return { score: 0, memberIds: new Set() };
    }
    const memberIds = new Set([startId]);
    const queue = [{ id: startId, hops: 0 }];
    let score = 1;
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const neighborId of adjacentIdsById?.get(current.id) || []) {
        if (memberIds.has(neighborId) || !nodesById.has(neighborId)) continue;
        const hops = current.hops + 1;
        const risk = finiteEarlyGameSignal(nodesById.get(neighborId)?.captureRisk);
        const availability = Math.max(0, 1 - risk * hops);
        if (availability <= 0) continue;
        memberIds.add(neighborId);
        queue.push({ id: neighborId, hops });
        score += availability;
      }
    }
    return { score, memberIds };
  }

  function calculateReachableTribeClusterOpportunities(
    candidates,
    adjacentIdsById,
    startIds = null,
  ) {
    const allowedStarts = startIds === null ? null : new Set(startIds);
    return new Map(
      (Array.isArray(candidates) ? candidates : [])
        .filter(
          (candidate) =>
            allowedStarts === null || allowedStarts.has(candidate.id),
        )
        .map((candidate) => [
          candidate.id,
          calculateReachableTribeClusterOpportunity(
            candidate.id,
            candidates,
            adjacentIdsById,
          ),
        ]),
    );
  }

  function chooseTribeClusterMarkerCenter(centers) {
    const valid = (Array.isArray(centers) ? centers : []).filter(
      (center) =>
        Number.isFinite(Number(center?.x)) &&
        Number.isFinite(Number(center?.y)),
    );
    if (valid.length === 0) return null;
    const centroid = {
      x:
        valid.reduce((sum, center) => sum + Number(center.x), 0) /
        valid.length,
      y:
        valid.reduce((sum, center) => sum + Number(center.y), 0) /
        valid.length,
    };
    return valid.reduce((best, center) => {
      const bestDistance =
        (Number(best.x) - centroid.x) ** 2 +
        (Number(best.y) - centroid.y) ** 2;
      const distance =
        (Number(center.x) - centroid.x) ** 2 +
        (Number(center.y) - centroid.y) ** 2;
      return distance < bestDistance ? center : best;
    });
  }

  // A tribe is more valuable when taking it opens a short chain of other tribes.
  // `futureFoodAccess` is supplied by AttackBehavior when it has geometry; the
  // count/distance fallback keeps this helper useful for deterministic tests and
  // older adapters that only expose aggregate signals.
  function calculateEarlyGameContinuationValue(candidate = {}) {
    const clusterAccess = finiteEarlyGameSignal(candidate.tribeClusterAccess);
    const explicit = Number(candidate.futureFoodAccess);
    if (candidate.futureFoodAccess != null && Number.isFinite(explicit)) {
      return Math.max(finiteEarlyGameSignal(explicit), clusterAccess);
    }

    const count = Number(candidate.futureFoodCount);
    const total = Number(candidate.futureFoodTotal);
    let countScore = 0;
    if (Number.isFinite(total) && total > 0) {
      countScore = finiteEarlyGameSignal(count / total);
    } else if (Number.isFinite(count) && count > 0) {
      countScore = 1;
    }
    const distance = Number(candidate.meanFutureFoodDistance);
    const radius = Number(candidate.futureFoodChainRadius || 120);
    const proximityScore =
      Number.isFinite(distance) && Number.isFinite(radius) && radius > 0
        ? finiteEarlyGameSignal(1 - distance / radius)
        : 0;
    return Math.max(
      finiteEarlyGameSignal(countScore * proximityScore),
      clusterAccess,
    );
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
    const coastalSignal = finiteEarlyGameSignal(
      1 - distance / EARLY_GAME_MAX_MARITIME_DISTANCE,
    );
    // Reaching the coast is strategic only until we already own an open-ocean
    // shore. Afterwards another coastal tribe is redundant and should yield to
    // inland expansion or a gateway into a larger tribe cluster.
    return candidate.hasOpenOceanAccess === true
      ? -coastalSignal
      : coastalSignal;
  }

  // Strategic dimensions use the same [0, 1] scale. Continuation receives two
  // shares because opening a large tribe chain is the primary expansion goal;
  // hard feasibility remains separate so an invalid route can never compensate.
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
      finiteEarlyGameSignal(candidate.alliedCutoffPressure),
      finiteEarlyGameSignal(candidate.oceanGatewayUrgency),
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
      continuation * 2 +
      maritimeOpportunity
    ) / 7;
  }

  // Preserve irreversible/race urgency first, then choose the direction with
  // the largest connected tribe cluster. Utility decides among equivalent
  // cluster opportunities. Keeping cluster value only inside the averaged
  // utility allowed several attractive local signals to overwhelm the actual
  // opening objective: reaching the largest chain of edible tribes.
  function earlyGameTribeSortKey(candidate = {}) {
    const distance = Number(candidate.distance);
    const urgentGatewayOrRace = Math.max(
      finiteEarlyGameSignal(candidate.alliedCutoffPressure),
      finiteEarlyGameSignal(candidate.oceanGatewayUrgency),
      Number(candidate.directAttackers) > 0 ||
        Number(candidate.incomingAttackers) > 0
        ? 1
        : 0,
    );
    return [
      urgentGatewayOrRace,
      finiteEarlyGameSignal(candidate.tribeClusterAccess),
      calculateEarlyGameContinuationValue(candidate),
      calculateEarlyGameTribeUtility(candidate),
      finiteEarlyGameSignal(candidate.captureEfficiency),
      calculateEarlyGameRouteEfficiency(candidate),
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

  function keepLargestTribeClusterCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    const maxClusterAccess = candidates.reduce(
      (best, candidate) =>
        Math.max(best, finiteEarlyGameSignal(candidate.tribeClusterAccess)),
      0,
    );
    if (maxClusterAccess <= 0) return candidates.slice();
    const firstOceanGateways = candidates.filter(
      (candidate) =>
        finiteEarlyGameSignal(candidate.oceanGatewayUrgency) > 0,
    );
    const soleFirstOceanGateway =
      firstOceanGateways.length === 1 ? firstOceanGateways[0] : null;
    return candidates.filter(
      (candidate) => {
        const belongsToLargestCluster =
          Math.abs(
          finiteEarlyGameSignal(candidate.tribeClusterAccess) -
            maxClusterAccess,
          ) <= 1e-9;
        return (
          belongsToLargestCluster || candidate === soleFirstOceanGateway
        );
      },
    );
  }

  // Select which tribes deserve the bounded, expensive border/route snapshot.
  // Cluster size is deliberately the first key: otherwise eight locally cheap
  // decoys can remove the only gateway toward a much larger food chain before
  // the full strategic ranker gets a chance to evaluate it.
  function compareEarlyGameTribeSamplingEntries(left, right) {
    const clusterDifference =
      (Number(right.candidate.clusterSize) || 1) -
      (Number(left.candidate.clusterSize) || 1);
    if (clusterDifference !== 0) return clusterDifference;
    const opportunityDifference =
      (Number(right.candidate.opportunity) || 0) -
      (Number(left.candidate.opportunity) || 0);
    if (opportunityDifference !== 0) return opportunityDifference;
    const idDifference =
      (Number(left.candidate.id) || 0) -
      (Number(right.candidate.id) || 0);
    return idDifference || left.index - right.index;
  }

  function rankEarlyGameTribeSamplingCandidates(candidates, limit = Infinity) {
    if (!Array.isArray(candidates)) return [];
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : Infinity;
    if (boundedLimit === 0) return [];
    if (boundedLimit === Infinity) {
      return candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort(compareEarlyGameTribeSamplingEntries)
        .map(({ candidate }) => candidate);
    }
    const ranked = [];
    for (let index = 0; index < candidates.length; index++) {
      const entry = { candidate: candidates[index], index };
      let insertionIndex = ranked.length;
      while (
        insertionIndex > 0 &&
        compareEarlyGameTribeSamplingEntries(entry, ranked[insertionIndex - 1]) < 0
      ) {
        insertionIndex -= 1;
      }
      if (insertionIndex >= boundedLimit) continue;
      ranked.splice(insertionIndex, 0, entry);
      if (ranked.length > boundedLimit) ranked.pop();
    }
    return ranked.map(({ candidate }) => candidate);
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
