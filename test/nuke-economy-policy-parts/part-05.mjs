  // Target-distance ranking must use ready silo origins. A cooling near silo
  // cannot make a remote tile look like an easy delivery for a distant ready
  // tube; when every tube is cooling, preserve the prior fallback ordering.
  const siloDistanceInputs = [];
  sandbox.autoBotBuildNukeSlots = (_game, player) => player.projectedSlots;
  sandbox.closestTwoTiles = (_game, siloTiles, targetTiles) => {
    siloDistanceInputs.push(siloTiles);
    return { x: siloTiles[0], y: targetTiles[0] };
  };
  scoreBehavior.player = {
    projectedSlots: new Map([
      ["ready", 1],
      ["cooling", 0],
    ]),
  };
  const readySilo = { id: () => "ready", tile: () => 300 };
  const coolingSilo = { id: () => "cooling", tile: () => 100 };
  scoreBehavior.nukeTileScore(100, [coolingSilo, readySilo], [], UNIT.AtomBomb);
  assert.deepEqual(
    siloDistanceInputs.at(-1),
    [300],
    "target proximity is measured from the ready silo, not the closer cooling silo",
  );
  scoreBehavior.player.projectedSlots = new Map([
    ["ready", 0],
    ["cooling", 0],
  ]);
  scoreBehavior.nukeTileScore(100, [coolingSilo, readySilo], [], UNIT.AtomBomb);
  assert.deepEqual(
    siloDistanceInputs.at(-1),
    [100, 300],
    "when no silo has a ready slot, the ranking retains the live-silo fallback",
  );

  const ladderBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  ladderBehavior.random = { chance: () => false };
  ladderBehavior.attackBehavior = {
    findIncomingAttackPlayer: () => null,
    shouldAttack: () => true,
  };
  ladderBehavior.findTwoPlayerNukeTarget = () => null;
  ladderBehavior.findStrategicBorderArmyTarget = () => null;
  ladderBehavior.findDominantCrownNukeTarget = () => null;
  ladderBehavior.findAllyNukeTarget = () => null;
  ladderBehavior.findHostileNukeTarget = () => null;
  ladderBehavior.findFFACrownTarget = () => null;
  ladderBehavior.findStrongestTeamTarget = () => null;
  ladderBehavior.player = {
    smallID: () => 1,
    gold: () => 100_000_000n,
  };
  const denseOwner = {
    smallID: () => 2,
    type: () => "Human",
    isAlive: () => true,
    numTilesOwned: () => 10,
    units: () => [
      { type: () => UNIT.City, level: () => 3 },
      { type: () => UNIT.City, level: () => 2 },
    ],
  };
  const sparseOwner = {
    smallID: () => 3,
    type: () => "Human",
    isAlive: () => true,
    numTilesOwned: () => 20,
    units: () => [{ type: () => UNIT.City, level: () => 1 }],
  };
  ladderBehavior.game = { players: () => [denseOwner, sparseOwner] };
  assert.equal(
    ladderBehavior.findBestNukeTarget(),
    denseOwner,
    "the structure-density fallback stays alive under the normalized tier",
  );
  const manySmallCities = Array.from({ length: 6 }, () => ({
    type: () => UNIT.City,
    level: () => 1,
  }));
  const lowTotalValueOwner = {
    smallID: () => 4,
    isAlive: () => true,
    numTilesOwned: () => 10,
    units: (type) => (type === UNIT.City ? manySmallCities : []),
  };
  const highTotalValueOwner = {
    smallID: () => 5,
    isAlive: () => true,
    numTilesOwned: () => 10,
    units: (type) => (type === UNIT.City ? [{ type: () => UNIT.City, level: () => 5 }] : []),
  };
  ladderBehavior.game = {
    players: () => [lowTotalValueOwner, highTotalValueOwner],
  };
  assert.equal(
    ladderBehavior.findLegendaryStructureTarget(),
    highTotalValueOwner,
    "the Legendary structure fallback ranks replacement value per tile, not raw levels",
  );
  sandbox.isLegendaryDifficulty = previousUnion;
  sandbox.closestTwoTiles = previousClosest;
  testDifficulty = previousDifficulty;
}

