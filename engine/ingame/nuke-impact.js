// Shared nuke impact placement helpers.
//
// Keep the geometry search bounded: this helper is called for several scored
// nuke candidates, so an unbounded pairwise/grid search would reintroduce the
// frame stalls seen in large games.
var MAX_NUKE_BUILDING_IMPACT_GEOMETRY_ENTRIES = 12;
var MAX_NUKE_BUILDING_IMPACT_GENERATED_CANDIDATES = 128;
var NUKE_BUILDING_IMPACT_LOCAL_STEPS = [1, 2, 4];

  function chooseMaxNukeBuildingImpactTile(
    game,
    primaryTile,
    buildings,
    radius,
    includePrimaryBuilding = false,
  ) {
    if (primaryTile === null || primaryTile === void 0) {
      return primaryTile;
    }

    var numericRadius = Number(radius);
    if (!Number.isFinite(numericRadius) || numericRadius <= 0) {
      return primaryTile;
    }
    var radiusSquared = numericRadius * numericRadius;
    var entries = Array.isArray(buildings) ? buildings.slice() : [];
    if (includePrimaryBuilding && !entries.some((entry) => entry?.tile === primaryTile)) {
      entries.unshift({ tile: primaryTile });
    }
    var candidates = [];
    var candidateKeys = Object.create(null);
    var generatedCandidateCount = 0;

    function tileKey(tile) {
      return String(tile);
    }

    function addCandidate(tile) {
      if (tile === null || tile === void 0) {
        return;
      }
      var key = tileKey(tile);
      if (candidateKeys[key]) {
        return;
      }
      candidateKeys[key] = true;
      candidates.push(tile);
      return true;
    }

    function distanceSquared(tileA, tileB) {
      try {
        if (typeof game?.euclideanDistSquared === "function") {
          var directDistance = Number(game.euclideanDistSquared(tileA, tileB));
          return Number.isFinite(directDistance) ? directDistance : Infinity;
        }
        var ax = Number(game.x(tileA));
        var ay = Number(game.y(tileA));
        var bx = Number(game.x(tileB));
        var by = Number(game.y(tileB));
        if (![ax, ay, bx, by].every(Number.isFinite)) {
          return Infinity;
        }
        var dx = ax - bx;
        var dy = ay - by;
        return dx * dx + dy * dy;
      } catch (_error) {
        return Infinity;
      }
    }

    function getTileCoordinates(tile) {
      try {
        if (typeof game?.x !== "function" || typeof game?.y !== "function") {
          return null;
        }
        var x = Number(game.x(tile));
        var y = Number(game.y(tile));
        return Number.isFinite(x) && Number.isFinite(y) ? { tile, x, y } : null;
      } catch (_error) {
        return null;
      }
    }

    function addGeneratedCoordinateCandidate(x, y) {
      if (
        generatedCandidateCount >= MAX_NUKE_BUILDING_IMPACT_GENERATED_CANDIDATES ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        typeof game?.ref !== "function"
      ) {
        return;
      }

      var roundedX = Math.round(x);
      var roundedY = Math.round(y);
      try {
        if (
          typeof game?.isValidCoord === "function" &&
          !game.isValidCoord(roundedX, roundedY)
        ) {
          return;
        }
        if (addCandidate(game.ref(roundedX, roundedY))) {
          generatedCandidateCount++;
        }
      } catch (_error) {
        // Some map implementations throw for coordinates outside the map.
      }
    }

    function addMidpointCandidates(first, second) {
      var midpointX = (first.x + second.x) / 2;
      var midpointY = (first.y + second.y) / 2;
      var xOptions = [Math.floor(midpointX), Math.ceil(midpointX)];
      var yOptions = [Math.floor(midpointY), Math.ceil(midpointY)];
      for (var xIndex = 0; xIndex < xOptions.length; xIndex++) {
        for (var yIndex = 0; yIndex < yOptions.length; yIndex++) {
          addGeneratedCoordinateCandidate(xOptions[xIndex], yOptions[yIndex]);
        }
      }
    }

    addCandidate(primaryTile);
    for (var index = 0; index < entries.length; index++) {
      var buildingTileCandidate = entries[index]?.tile;
      if (distanceSquared(buildingTileCandidate, primaryTile) < radiusSquared) {
        addCandidate(buildingTileCandidate);
      }
    }

    // Existing building tiles preserve the old behavior. The additional
    // geometry points let the blast center move into the middle of a cluster,
    // where it can hit more structures than any single building tile.
    var coordinateEntries = [];
    for (var coordinateIndex = 0; coordinateIndex < entries.length; coordinateIndex++) {
      var coordinateEntry = getTileCoordinates(entries[coordinateIndex]?.tile);
      if (coordinateEntry) {
        coordinateEntries.push(coordinateEntry);
      }
    }
    coordinateEntries.sort(
      (left, right) =>
        distanceSquared(left.tile, primaryTile) - distanceSquared(right.tile, primaryTile),
    );
    var geometryEntries = coordinateEntries.slice(0, MAX_NUKE_BUILDING_IMPACT_GEOMETRY_ENTRIES);
    var centroid = null;
    if (geometryEntries.length > 0) {
      var totalX = 0;
      var totalY = 0;
      for (var centroidIndex = 0; centroidIndex < geometryEntries.length; centroidIndex++) {
        totalX += geometryEntries[centroidIndex].x;
        totalY += geometryEntries[centroidIndex].y;
      }
      centroid = {
        x: totalX / geometryEntries.length,
        y: totalY / geometryEntries.length,
      };
      addGeneratedCoordinateCandidate(centroid.x, centroid.y);
    }

    var localAnchors = [];
    var primaryCoordinates = getTileCoordinates(primaryTile);
    if (primaryCoordinates) {
      localAnchors.push(primaryCoordinates);
    }
    if (centroid) {
      localAnchors.push(centroid);
    }
    var localDirections = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
    for (var anchorIndex = 0; anchorIndex < localAnchors.length; anchorIndex++) {
      var anchor = localAnchors[anchorIndex];
      for (var stepIndex = 0; stepIndex < NUKE_BUILDING_IMPACT_LOCAL_STEPS.length; stepIndex++) {
        var step = NUKE_BUILDING_IMPACT_LOCAL_STEPS[stepIndex];
        for (var directionIndex = 0; directionIndex < localDirections.length; directionIndex++) {
          var direction = localDirections[directionIndex];
          addGeneratedCoordinateCandidate(
            anchor.x + direction[0] * step,
            anchor.y + direction[1] * step,
          );
        }
      }
    }

    for (var firstIndex = 0; firstIndex < geometryEntries.length; firstIndex++) {
      for (var secondIndex = firstIndex + 1; secondIndex < geometryEntries.length; secondIndex++) {
        addMidpointCandidates(geometryEntries[firstIndex], geometryEntries[secondIndex]);
      }
    }

    // Use x/y only as a broad phase, then preserve the game's exact distance
    // function for the final hit test. This avoids scanning every building for
    // every candidate when the target has a large, sparse structure list.
    var buildingBuckets = new Map();
    var bucketSize = numericRadius;
    var coordinateTileKeys = new Set();
    for (var bucketIndex = 0; bucketIndex < coordinateEntries.length; bucketIndex++) {
      var bucketEntry = coordinateEntries[bucketIndex];
      var bucketX = Math.floor(bucketEntry.x / bucketSize);
      var bucketY = Math.floor(bucketEntry.y / bucketSize);
      var bucketKey = `${bucketX}:${bucketY}`;
      var bucket = buildingBuckets.get(bucketKey);
      if (!bucket) {
        bucket = [];
        buildingBuckets.set(bucketKey, bucket);
      }
      bucket.push(bucketEntry);
      coordinateTileKeys.add(tileKey(bucketEntry.tile));
    }
    var fallbackBuildingEntries = entries.filter(
      (entry) => !coordinateTileKeys.has(tileKey(entry?.tile)),
    );

    function countBuildingHits(candidate) {
      var candidateCoordinates = getTileCoordinates(candidate);
      if (!candidateCoordinates || buildingBuckets.size === 0) {
        return null;
      }

      var hits = 0;
      var minBucketX = Math.floor((candidateCoordinates.x - numericRadius) / bucketSize);
      var maxBucketX = Math.floor((candidateCoordinates.x + numericRadius) / bucketSize);
      var minBucketY = Math.floor((candidateCoordinates.y - numericRadius) / bucketSize);
      var maxBucketY = Math.floor((candidateCoordinates.y + numericRadius) / bucketSize);
      for (var currentBucketX = minBucketX; currentBucketX <= maxBucketX; currentBucketX++) {
        for (var currentBucketY = minBucketY; currentBucketY <= maxBucketY; currentBucketY++) {
          var nearby = buildingBuckets.get(`${currentBucketX}:${currentBucketY}`);
          if (!nearby) continue;
          for (var nearbyIndex = 0; nearbyIndex < nearby.length; nearbyIndex++) {
            if (distanceSquared(candidate, nearby[nearbyIndex].tile) < radiusSquared) {
              hits++;
            }
          }
        }
      }
      for (var fallbackIndex = 0; fallbackIndex < fallbackBuildingEntries.length; fallbackIndex++) {
        if (
          distanceSquared(candidate, fallbackBuildingEntries[fallbackIndex]?.tile) <
          radiusSquared
        ) {
          hits++;
        }
      }
      return hits;
    }

    var bestTile = primaryTile;
    var bestHits = -1;
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      var candidate = candidates[candidateIndex];
      if (!(distanceSquared(candidate, primaryTile) < radiusSquared)) {
        continue;
      }

      var hits = countBuildingHits(candidate);
      if (hits === null) {
        hits = 0;
        for (var buildingIndex = 0; buildingIndex < entries.length; buildingIndex++) {
          var buildingTile = entries[buildingIndex]?.tile;
          if (distanceSquared(candidate, buildingTile) < radiusSquared) {
            hits++;
          }
        }
      }

      // The primary tile is first, so equal scores keep the original target.
      if (hits > bestHits) {
        bestHits = hits;
        bestTile = candidate;
      }
    }

    return bestTile;
  }
