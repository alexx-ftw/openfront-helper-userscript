// ── Upstream 34a8fe723 delta 2: enemyLandBlastCoverage grid math ────────────
{
  const tileOf = (x, y) => y * 100 + x;
  const own = { smallID: () => 1, isPlayer: () => true };
  const enemy = { smallID: () => 7, isPlayer: () => true };
  const terrain = {};
  const covBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  covBehavior.game = {
    x: (tile) => tile % 100,
    y: (tile) => Math.floor(tile / 100),
    isValidCoord: (x, y) => x >= 0 && x < 100 && y >= 0 && y < 100,
    ref: (x, y) => tileOf(x, y),
    owner: (tile) => (tile in terrain ? terrain[tile] : enemy),
    config: () => ({ nukeMagnitudes: () => ({ inner: 1, outer: 2 }) }),
  };
  covBehavior.player = { smallID: () => 1, isFriendly: (o) => o === own };
  const center = tileOf(50, 50);
  // Disk totals (inner 1, outer 2): 18 sampled weight; inner tiles count double.
  terrain[center] = own;
  assert.equal(
    covBehavior.enemyLandBlastCoverage(center, UNIT.AtomBomb),
    16 / 18,
    "own land at the blast center is wasted weight",
  );
  terrain[tileOf(50, 49)] = null;
  terrain[tileOf(50, 51)] = null;
  const innerWaste = covBehavior.enemyLandBlastCoverage(center, UNIT.AtomBomb);
  delete terrain[tileOf(50, 49)];
  delete terrain[tileOf(50, 51)];
  terrain[tileOf(52, 50)] = null;
  terrain[tileOf(48, 50)] = null;
  const outerWaste = covBehavior.enemyLandBlastCoverage(center, UNIT.AtomBomb);
  assert.equal(innerWaste, 12 / 18, "two wasted inner tiles lose double weight");
  assert.equal(outerWaste, 14 / 18, "two wasted outer tiles lose single weight");
  assert.ok(innerWaste < outerWaste, "inner-radius coverage counts double versus the outer ring");
}

