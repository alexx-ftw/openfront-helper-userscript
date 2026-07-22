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

  function getNukeImpactGeometry(context) {
    var coordinateEntries = context.entries
      .map((entry) => getNukeImpactCoordinates(context, entry?.tile))
      .filter(Boolean)
      .sort(
        (left, right) =>
          nukeImpactDistanceSquared(context, left.tile, context.primaryTile) -
          nukeImpactDistanceSquared(context, right.tile, context.primaryTile),
      );
    return {
      coordinateEntries,
      geometryEntries: coordinateEntries.slice(0, MAX_NUKE_BUILDING_IMPACT_GEOMETRY_ENTRIES),
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

  function buildNukeImpactBuckets(context, coordinateEntries) {
    var buckets = new Map();
    var coordinateTileKeys = new Set();
    for (var entry of coordinateEntries) {
      var key = `${Math.floor(entry.x / context.numericRadius)}:${Math.floor(entry.y / context.numericRadius)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry);
      coordinateTileKeys.add(nukeImpactTileKey(entry.tile));
    }
    return {
      buckets,
      fallbackEntries: context.entries.filter(
        (entry) => !coordinateTileKeys.has(nukeImpactTileKey(entry?.tile)),
      ),
    };
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
        var nearby = bucketData.buckets.get(`${bucketX}:${bucketY}`) || [];
        for (var entry of nearby) {
          if (nukeImpactDistanceSquared(context, candidate, entry.tile) <= context.radiusSquared) hits++;
        }
      }
    }
    for (var fallback of bucketData.fallbackEntries) {
      if (nukeImpactDistanceSquared(context, candidate, fallback?.tile) <= context.radiusSquared) hits++;
    }
    return hits;
  }

  function countNukeImpactHits(context, candidate, bucketData) {
    var bucketHits = countNukeImpactBucketHits(context, candidate, bucketData);
    if (bucketHits !== null) return bucketHits;
    return context.entries.reduce(
      (hits, entry) =>
        hits + Number(nukeImpactDistanceSquared(context, candidate, entry?.tile) <= context.radiusSquared),
      0,
    );
  }

  function chooseBestNukeImpactCandidate(context, bucketData) {
    var best = { tile: context.primaryTile, hits: -1 };
    for (var candidate of context.candidates) {
      if (nukeImpactDistanceSquared(context, candidate, context.primaryTile) > context.radiusSquared) continue;
      var hits = countNukeImpactHits(context, candidate, bucketData);
      if (hits > best.hits) best = { tile: candidate, hits };
    }
    return best.tile;
  }

  function chooseMaxNukeBuildingImpactTile(
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
    for (var entry of entries) {
      if (nukeImpactDistanceSquared(context, entry?.tile, primaryTile) <= context.radiusSquared) {
        addNukeImpactCandidate(context, entry?.tile);
      }
    }
    var geometry = getNukeImpactGeometry(context);
    addNukeImpactLocalCandidates(context, geometry.geometryEntries);
    addNukeImpactPairCandidates(context, geometry.geometryEntries);
    return chooseBestNukeImpactCandidate(
      context,
      buildNukeImpactBuckets(context, geometry.coordinateEntries),
    );
  }
