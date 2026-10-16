// ── Upstream 34a8fe723 delta 2: per-tile value gate + coverage ranking ──────
{
  const col = Object.create(sandbox.__NukeBehavior.prototype);
  col.game = {
    ensureBorderTiles: async () => {},
    ticks: () => 100,
    config: () => ({ nukeMagnitudes: () => ({ outer: 2 }) }),
  };
  col.recentlySentNukes = [];
  col.isScorableNukeTile = (tile) => (tile === 1 ? 0.9 : 0.2);
  col.nukeTileScore = () => 0;
  const colTarget = { smallID: () => 42, units: () => [] };
  const previousDifficulty = testDifficulty;
  testDifficulty = sandbox.Difficulty.Hard;
  const hardList = await col.collectNukeCandidates(
    colTarget,
    UNIT.AtomBomb,
    [],
    sandbox.Difficulty.Hard,
  );
  assert.deepEqual(
    Array.from(hardList, (cand) => cand.tile),
    [1, 2],
    "Hard keeps value-0 tiles and ranks coverage-boosted score first",
  );
  assert.equal(hardList[0].value, 0, "the kept Hard candidate keeps its pure value");
  testDifficulty = sandbox.Difficulty.Impossible;
  const impossibleList = await col.collectNukeCandidates(
    colTarget,
    UNIT.AtomBomb,
    [],
    sandbox.Difficulty.Impossible,
  );
  assert.equal(
    impossibleList.length,
    0,
    "Impossible rejects every value-0 tile regardless of coverage",
  );
  testDifficulty = previousDifficulty;
}

