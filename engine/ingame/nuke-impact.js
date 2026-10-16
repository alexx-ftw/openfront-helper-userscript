// Shared nuke impact placement helpers.
//
// Keep the geometry search bounded: this helper is called for several scored
// nuke candidates, so an unbounded pairwise/grid search would reintroduce the
// frame stalls seen in large games.
var MAX_NUKE_BUILDING_IMPACT_GEOMETRY_ENTRIES = 12;
var MAX_NUKE_BUILDING_IMPACT_GENERATED_CANDIDATES = 128;
var NUKE_BUILDING_IMPACT_LOCAL_STEPS = [1, 2, 4];

  function nukeImpactTileKey(tile) {
    return String(tile);
  }

  function nukeImpactDistanceSquared(context, tileA, tileB) {
    {
      if (typeof context.game?.euclideanDistSquared === "function") {
        var directDistance = Number(context.game.euclideanDistSquared(tileA, tileB));
        return Number.isFinite(directDistance) ? directDistance : Infinity;
      }
      var coordinates = [
        Number(context.game.x(tileA)),
        Number(context.game.y(tileA)),
        Number(context.game.x(tileB)),
        Number(context.game.y(tileB)),
      ];
      if (!coordinates.every(Number.isFinite)) return Infinity;
      var dx = coordinates[0] - coordinates[2];
      var dy = coordinates[1] - coordinates[3];
      return dx * dx + dy * dy;
    }
  }

  function getNukeImpactCoordinates(context, tile) {
    {
      if (typeof context.game?.x !== "function" || typeof context.game?.y !== "function") return null;
      var x = Number(context.game.x(tile));
      var y = Number(context.game.y(tile));
      return Number.isFinite(x) && Number.isFinite(y) ? { tile, x, y } : null;
    }
  }

  function addNukeImpactCandidate(context, tile) {
    if (tile === null || tile === void 0) return false;
    var key = nukeImpactTileKey(tile);
    if (context.candidateKeys[key]) return false;
    context.candidateKeys[key] = true;
    context.candidates.push(tile);
    return true;
  }

  function addGeneratedNukeImpactCandidate(context, x, y) {
    if (
      context.generatedCandidateCount >= MAX_NUKE_BUILDING_IMPACT_GENERATED_CANDIDATES ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      typeof context.game?.ref !== "function"
    ) return;
    var roundedX = Math.round(x);
    var roundedY = Math.round(y);
    {
      if (typeof context.game?.isValidCoord === "function" && !context.game.isValidCoord(roundedX, roundedY)) return;
      if (addNukeImpactCandidate(context, context.game.ref(roundedX, roundedY))) {
        context.generatedCandidateCount++;
      }
    }
  }

  function addNukeImpactMidpoints(context, first, second) {
    var midpointX = (first.x + second.x) / 2;
    var midpointY = (first.y + second.y) / 2;
    for (var x of [Math.floor(midpointX), Math.ceil(midpointX)]) {
      for (var y of [Math.floor(midpointY), Math.ceil(midpointY)]) {
        addGeneratedNukeImpactCandidate(context, x, y);
      }
    }
  }

  function drainNukeImpactIterator(iterator) {
    var result = iterator.next();
    while (!result.done) result = iterator.next();
    return result.value;
  }

  function getNukeImpactGeometry(context) {
    return drainNukeImpactIterator(iterateNukeImpactGeometry(context));
  }

  function* iterateNukeImpactGeometry(context) {
    var coordinateEntries = [];
    var nearest = [];
    // Only twelve structures seed geometry. Keep a stable bounded selection
    // instead of sorting the complete board and recomputing distances in every
    // comparator; the complete coordinates still populate the hit-count index.
    var processed = 0;
    for (var entry of context.entries) {
      if (++processed % 128 === 0) yield;
      var coordinates = getNukeImpactCoordinates(context, entry?.tile);
      if (!coordinates) continue;
      coordinateEntries.push(coordinates);
      var distance = nukeImpactDistanceSquared(context, coordinates.tile, context.primaryTile);
      var insertion = nearest.length;
      while (insertion > 0 && distance < nearest[insertion - 1].distance) insertion--;
      if (insertion >= MAX_NUKE_BUILDING_IMPACT_GEOMETRY_ENTRIES) continue;
      nearest.splice(insertion, 0, { coordinates, distance });
      if (nearest.length > MAX_NUKE_BUILDING_IMPACT_GEOMETRY_ENTRIES) nearest.pop();
    }
    return {
      coordinateEntries,
      geometryEntries: nearest.map((entry) => entry.coordinates),
    };
  }

  function addNukeImpactLocalCandidates(context, geometryEntries) {
    var centroid = null;
    if (geometryEntries.length > 0) {
      var totals = geometryEntries.reduce(
        (sum, entry) => ({ x: sum.x + entry.x, y: sum.y + entry.y }),
        { x: 0, y: 0 },
      );
      centroid = { x: totals.x / geometryEntries.length, y: totals.y / geometryEntries.length };
      addGeneratedNukeImpactCandidate(context, centroid.x, centroid.y);
    }
    var anchors = [getNukeImpactCoordinates(context, context.primaryTile), centroid].filter(Boolean);
    var directions = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (var anchor of anchors) {
      for (var step of NUKE_BUILDING_IMPACT_LOCAL_STEPS) {
        for (var direction of directions) {
          addGeneratedNukeImpactCandidate(
            context,
            anchor.x + direction[0] * step,
            anchor.y + direction[1] * step,
          );
        }
      }
    }
  }

  function addNukeImpactPairCandidates(context, geometryEntries) {
    for (var firstIndex = 0; firstIndex < geometryEntries.length; firstIndex++) {
      for (var secondIndex = firstIndex + 1; secondIndex < geometryEntries.length; secondIndex++) {
        addNukeImpactMidpoints(context, geometryEntries[firstIndex], geometryEntries[secondIndex]);
      }
    }
  }

  function* iterateNukeImpactTree(entries, depth = 0) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var processed = 0;
    for (var entry of entries) {
      if (++processed % 128 === 0) yield;
      minX = Math.min(minX, entry.x); maxX = Math.max(maxX, entry.x);
      minY = Math.min(minY, entry.y); maxY = Math.max(maxY, entry.y);
    }
    var node = { minX, maxX, minY, maxY, count: entries.length };
    if (entries.length <= 16 || depth >= 32 || (minX === maxX && minY === maxY)) {
      node.entries = entries;
      return node;
    }
    var axis = maxX - minX >= maxY - minY ? "x" : "y";
    var midpoint = axis === "x" ? (minX + maxX) / 2 : (minY + maxY) / 2;
    var lower = [], upper = [];
    for (var splitEntry of entries) {
      if (++processed % 128 === 0) yield;
      (splitEntry[axis] <= midpoint ? lower : upper).push(splitEntry);
    }
    // Degenerate coordinates remain an exact leaf rather than recursing forever.
    if (!lower.length || !upper.length) { node.entries = entries; return node; }
    node.children = [yield* iterateNukeImpactTree(lower, depth + 1), yield* iterateNukeImpactTree(upper, depth + 1)];
    return node;
  }

  function nukeImpactNearAxis(value, minimum, maximum) {
    if (value < minimum) return minimum - value;
    if (value > maximum) return value - maximum;
    return 0;
  }

  function countNukeImpactTreeHits(context, candidate, coordinates, node) {
    var nearX = nukeImpactNearAxis(coordinates.x, node.minX, node.maxX);
    var nearY = nukeImpactNearAxis(coordinates.y, node.minY, node.maxY);
    if (nearX * nearX + nearY * nearY >= context.radiusSquared) return 0;
    var farX = coordinates.x - node.minX > node.maxX - coordinates.x ? coordinates.x - node.minX : node.maxX - coordinates.x;
    var farY = coordinates.y - node.minY > node.maxY - coordinates.y ? coordinates.y - node.minY : node.maxY - coordinates.y;
    if (farX * farX + farY * farY < context.radiusSquared) return node.count;
    if (node.children) {
      return countNukeImpactTreeHits(context, candidate, coordinates, node.children[0]) +
        countNukeImpactTreeHits(context, candidate, coordinates, node.children[1]);
    }
    var hits = 0;
    for (var entry of node.entries) {
      if (nukeImpactDistanceSquared(context, candidate, entry.tile) < context.radiusSquared) hits++;
    }
    return hits;
  }

  function* iterateNukeImpactBuckets(context, coordinateEntries) {
    var buckets = new Map();
    var coordinateTileKeys = new Set();
    var processed = 0;
    for (var entry of coordinateEntries) {
      if (++processed % 128 === 0) yield;
      var key = `${Math.floor(entry.x / context.numericRadius)}:${Math.floor(entry.y / context.numericRadius)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry);
      coordinateTileKeys.add(nukeImpactTileKey(entry.tile));
    }
    // Dense buckets aggregate exact subtree geometry; keep tiny buckets cheap.
    var trees = new Map();
    for (var [bucketKey, bucketEntries] of buckets) {
      if (++processed % 128 === 0) yield;
      trees.set(bucketKey, bucketEntries.length > 64 ? yield* iterateNukeImpactTree(bucketEntries) : null);
    }
    var fallbackEntries = [];
    for (var fallback of context.entries) {
      if (++processed % 128 === 0) yield;
      if (!coordinateTileKeys.has(nukeImpactTileKey(fallback?.tile))) fallbackEntries.push(fallback);
    }
    return { buckets, trees, fallbackEntries };
  }

  function countNukeImpactSingleBucket(context, candidate, coordinates, bucketData, key) {
    var tree = bucketData.trees.get(key);
    if (tree) return countNukeImpactTreeHits(context, candidate, coordinates, tree);
    var hits = 0;
    for (var entry of bucketData.buckets.get(key) || []) {
      if (nukeImpactDistanceSquared(context, candidate, entry.tile) < context.radiusSquared) hits++;
    }
    return hits;
  }

  function countNukeImpactBucketHits(context, candidate, bucketData) {
    var coordinates = getNukeImpactCoordinates(context, candidate);
    if (!coordinates || bucketData.buckets.size === 0) return null;
    var minX = Math.floor((coordinates.x - context.numericRadius) / context.numericRadius);
    var maxX = Math.floor((coordinates.x + context.numericRadius) / context.numericRadius);
    var minY = Math.floor((coordinates.y - context.numericRadius) / context.numericRadius);
    var maxY = Math.floor((coordinates.y + context.numericRadius) / context.numericRadius);
    var hits = 0;
    for (var bucketX = minX; bucketX <= maxX; bucketX++) {
      for (var bucketY = minY; bucketY <= maxY; bucketY++) {
        hits += countNukeImpactSingleBucket(context, candidate, coordinates, bucketData, `${bucketX}:${bucketY}`);
      }
    }
    for (var fallback of bucketData.fallbackEntries) {
      if (nukeImpactDistanceSquared(context, candidate, fallback?.tile) < context.radiusSquared) hits++;
    }
    return hits;
  }

  function countNukeImpactHits(context, candidate, bucketData) {
    var bucketHits = countNukeImpactBucketHits(context, candidate, bucketData);
    if (bucketHits !== null) return bucketHits;
    return context.entries.reduce(
      (hits, entry) =>
        hits + Number(nukeImpactDistanceSquared(context, candidate, entry?.tile) < context.radiusSquared),
      0,
    );
  }

  function* iterateBestNukeImpactCandidate(context, bucketData) {
    var best = { tile: context.primaryTile, hits: -1 };
    for (var candidate of context.candidates) {
      yield;
      if (nukeImpactDistanceSquared(context, candidate, context.primaryTile) >= context.radiusSquared) continue;
      var hits = countNukeImpactHits(context, candidate, bucketData);
      if (hits > best.hits) best = { tile: candidate, hits };
      // No later candidate can improve on all entries; preserving the first
      // maximum also preserves the existing stable tie policy.
      if (hits === context.entries.length) break;
    }
    return best.tile;
  }

  function* iterateMaxNukeBuildingImpactTile(
    game,
    primaryTile,
    buildings,
    radius,
    includePrimaryBuilding = false,
  ) {
    if (primaryTile === null || primaryTile === void 0) return primaryTile;
    var numericRadius = Number(radius);
    if (!Number.isFinite(numericRadius) || numericRadius <= 0) return primaryTile;
    var entries = Array.isArray(buildings) ? buildings.slice() : [];
    if (includePrimaryBuilding && !entries.some((entry) => entry?.tile === primaryTile)) {
      entries.unshift({ tile: primaryTile });
    }
    var context = {
      game,
      primaryTile,
      numericRadius,
      radiusSquared: numericRadius * numericRadius,
      entries,
      candidates: [],
      candidateKeys: Object.create(null),
      generatedCandidateCount: 0,
    };
    addNukeImpactCandidate(context, primaryTile);
    var processed = 0;
    for (var entry of entries) {
      if (++processed % 128 === 0) yield;
      if (nukeImpactDistanceSquared(context, entry?.tile, primaryTile) < context.radiusSquared) {
        addNukeImpactCandidate(context, entry?.tile);
      }
    }
    var geometry = yield* iterateNukeImpactGeometry(context);
    addNukeImpactLocalCandidates(context, geometry.geometryEntries);
    addNukeImpactPairCandidates(context, geometry.geometryEntries);
    var bucketData = yield* iterateNukeImpactBuckets(context, geometry.coordinateEntries);
    return yield* iterateBestNukeImpactCandidate(context, bucketData);
  }

  function chooseMaxNukeBuildingImpactTile(game, primaryTile, buildings, radius, includePrimaryBuilding = false) {
    return drainNukeImpactIterator(iterateMaxNukeBuildingImpactTile(game, primaryTile, buildings, radius, includePrimaryBuilding));
  }
