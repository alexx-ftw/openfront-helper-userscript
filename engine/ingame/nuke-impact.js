// Shared nuke impact placement helpers.
//
// Candidates are deliberately restricted to existing building tiles. This
// keeps the optimization legal on the map while preserving the original
// target inside the same blast radius.

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
    var candidateKeys = {};

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

    addCandidate(primaryTile);
    for (var index = 0; index < entries.length; index++) {
      addCandidate(entries[index]?.tile);
    }

    var bestTile = primaryTile;
    var bestHits = -1;
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      var candidate = candidates[candidateIndex];
      if (!(distanceSquared(candidate, primaryTile) < radiusSquared)) {
        continue;
      }

      var hits = 0;
      for (var buildingIndex = 0; buildingIndex < entries.length; buildingIndex++) {
        var buildingTile = entries[buildingIndex]?.tile;
        if (distanceSquared(candidate, buildingTile) < radiusSquared) {
          hits++;
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
