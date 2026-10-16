// ── Decision record: the raw-equality Legendary saturation divergence is
// PINNED DEAD. Activating it (isLegendaryDifficulty union) was probed on
// 2026-10-13 and rejected on paired SAM-regime evidence — seed A turned a
// 25000-tick draw into a 15571 conquest loss (936k -> 295k tiles alive) and
// seed B died at 5108 instead of 8491; baikal stayed neutral. Same family as
// the 2026-10-09 starvation-release closure. Do not "fix" this comparison
// without a new pre-declared lever that pairs the scoring change with its own
// state scoping and passes both SAM seeds plus baikal no-harm.
{
  sandbox.boundingBoxTiles = (gm, center) => [center];
  const sat = Object.create(sandbox.__NukeBehavior.prototype);
  sat.game = {
    owner: () => null,
    config: () => ({ gameConfig: () => ({ gameMode: "Free For All" }) }),
  };
  sat.player = { smallID: () => 1, isFriendly: () => false };
  sat.nukeSpawn = () => 7;
  sat.isNukeAlreadyLandingNear = () => false;
  sat.isTrajectoryInterceptableBySam = () => true;
  sat.enemyLandBlastCoverage = () => 0.5;
  const ctx = (difficulty) => ({
    range: 2,
    target: { smallID: () => 42 },
    type: UNIT.AtomBomb,
    difficulty,
  });
  assert.equal(
    sat.isScorableNukeTile(5, ctx(sandbox.Difficulty.Impossible)),
    -1,
    "the saturation divergence stays intentionally dead on the Legendary tier",
  );
  assert.equal(
    sat.isScorableNukeTile(5, ctx(sandbox.Difficulty.Hard)),
    -1,
    "Hard still vetoes SAM-interceptable tiles at collection",
  );
}

