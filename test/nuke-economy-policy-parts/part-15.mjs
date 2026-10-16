// ── Upstream 34a8fe723 delta 2: coverage thresholds gate isScorableNukeTile ─
{
  sandbox.boundingBoxTiles = (gm, center) => [center];
  sandbox.randTerritoryTileArray = () => [1, 2];
  const gate = Object.create(sandbox.__NukeBehavior.prototype);
  gate.game = {
    owner: () => null,
    config: () => ({ gameConfig: () => ({ gameMode: "Free For All" }) }),
  };
  gate.player = { smallID: () => 1, isFriendly: () => false };
  gate.nukeSpawn = () => 7;
  gate.isNukeAlreadyLandingNear = () => false;
  gate.isTrajectoryInterceptableBySam = () => false;
  const ctx = (type) => ({
    range: 2,
    target: { smallID: () => 42 },
    type,
    difficulty: sandbox.Difficulty.Hard,
  });
  gate.enemyLandBlastCoverage = () => 0.2;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.AtomBomb)),
    -1,
    "an atom below 0.25 enemy-land coverage is not scorable",
  );
  gate.enemyLandBlastCoverage = () => 0.3;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.AtomBomb)),
    0.3,
    "an atom at 0.3 enemy-land coverage is scorable",
  );
  gate.enemyLandBlastCoverage = () => 0.3;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.HydrogenBomb)),
    -1,
    "a hydrogen below 0.4 enemy-land coverage is not scorable",
  );
  gate.enemyLandBlastCoverage = () => 0.5;
  assert.equal(
    gate.isScorableNukeTile(5, ctx(UNIT.HydrogenBomb)),
    0.5,
    "a hydrogen at 0.5 enemy-land coverage is scorable",
  );
}

