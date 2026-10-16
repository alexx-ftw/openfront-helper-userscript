// Production-shape targeting cohesion: the normalized Impossible tier must
// partition SAM-covered candidates into the salvo lane, price blast-covered
// SAMs, and keep the structure-density fallback alive.
{
  const previousDifficulty = testDifficulty;
  const previousUnion = sandbox.isLegendaryDifficulty;
  const previousClosest = sandbox.closestTwoTiles;
  sandbox.isLegendaryDifficulty = (difficulty) =>
    difficulty === "Legendary" || difficulty === "Impossible";
  testDifficulty = sandbox.Difficulty.Impossible;
  const partitionBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  partitionBehavior.nukeSpawn = () => 5;
  partitionBehavior.isTrajectoryInterceptableBySam = (_spawn, tile, excluded) =>
    tile === 20 && !excluded?.has("sam1");
  partitionBehavior.findEnemySamsCoveringTile = () => [{ id: () => "sam1", level: () => 1 }];
  const partitioned = partitionBehavior.partitionCandidatesBySamCoverage(
    [
      { tile: 20, value: 1 },
      { tile: 30, value: 2 },
    ],
    UNIT.AtomBomb,
    sandbox.Difficulty.Impossible,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(partitioned.covered)),
    [{ tile: 20, value: 1, coveringSamLevels: 1 }],
    "the normalized tier routes SAM-covered candidates to the salvo lane",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(partitioned.clear)),
    [{ tile: 30, value: 2, coveringSamLevels: 0 }],
    "clear trajectories stay directly fireable under the normalized tier",
  );

  const scoreBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  scoreBehavior.game = {
    config: () => ({ nukeMagnitudes: () => ({ inner: 2, outer: 3 }) }),
    euclideanDistSquared: (tile, unitTile) => (unitTile === tile ? 0 : 10_000),
    nearbyUnits: () => [],
  };
  scoreBehavior.recentlySentNukes = [];
  scoreBehavior.friendlyFirePenalty = () => 0;
  sandbox.closestTwoTiles = (_game, siloTiles, targetTiles) => ({
    x: siloTiles[0],
    y: targetTiles[0],
  });
  const samBlastScore = scoreBehavior.nukeTileScore(
    100,
    [{ tile: () => 100 }],
    [{ type: () => UNIT.SAMLauncher, level: () => 1, tile: () => 100 }],
    UNIT.AtomBomb,
  );
  assert.equal(
    samBlastScore,
    100_000,
    "a blast covering a SAM prices the counterforce value instead of scoring zero",
  );

  const boundaryScoreBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  boundaryScoreBehavior.game = {
    config: () => ({ nukeMagnitudes: () => ({ inner: 2, outer: 3 }) }),
    euclideanDistSquared: (a, b) => (a - b) ** 2,
    nearbyUnits: () => [],
  };
  boundaryScoreBehavior.recentlySentNukes = [];
  boundaryScoreBehavior.friendlyFirePenalty = () => 0;
  boundaryScoreBehavior.rankableSiloTiles = () => [100];
  const cityAt = (tile) => ({ type: () => UNIT.City, level: () => 4, tile: () => tile });
  assert.equal(
    boundaryScoreBehavior.nukeTileScore(100, [], [cityAt(104)], UNIT.AtomBomb),
    0,
    "a structure strictly past the blast edge receives no score because the game leaves it alive",
  );
  assert.equal(
    boundaryScoreBehavior.nukeTileScore(100, [], [cityAt(103)], UNIT.AtomBomb),
    0,
    "a structure exactly on the blast edge survives because native deletion is strict",
  );
  assert.equal(
    boundaryScoreBehavior.nukeTileScore(100, [], [cityAt(102)], UNIT.AtomBomb),
    100_000,
    "a structure strictly inside the blast is destroyed and contributes its replacement value",
  );

