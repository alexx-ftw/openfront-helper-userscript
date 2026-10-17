// ── Upstream 34a8fe723 delta 4: allied-land eligibility + winner filter ─────
{
  testDifficulty = sandbox.Difficulty.Hard;
  const d4 = Object.create(sandbox.__NukeBehavior.prototype);
  const thirdParty = { smallID: () => 9, isPlayer: () => true };
  const afkAlly = { smallID: () => 8, isPlayer: () => true };
  const d4Target = { smallID: () => 42 };
  d4.player = {
    smallID: () => 1,
    // Honors treatAFKFriendly like the engine's PlayerImpl.isFriendly(other, n).
    isFriendly: (o, n) => o === afkAlly && n === true,
  };
  let gameMode = sandbox.GameMode.FFA;
  d4.game = {
    owner: (t) => {
      if (t === 3) return thirdParty;
      if (t === 4) return afkAlly;
      return null;
    },
    config: () => ({ gameConfig: () => ({ gameMode }) }),
  };
  assert.equal(
    d4.isValidNukeTile(3, d4Target),
    false,
    "a Hard FFA tile owned by a non-allied third player is rejected",
  );
  assert.equal(d4.isValidNukeTile(4, d4Target), false, "an AFK ally's tile is protected on Hard");
  gameMode = sandbox.GameMode.Team;
  assert.equal(
    d4.isValidNukeTile(3, d4Target),
    true,
    "a Hard Team tile owned by a non-friendly third player is eligible",
  );
  const tileOf = (x, y) => y * 100 + x;
  const own = { smallID: () => 1 };
  const grid = {};
  const d4b = Object.create(sandbox.__NukeBehavior.prototype);
  d4b.player = { smallID: () => 1, isFriendly: () => true };
  d4b.game = {
    players: () => [own],
    x: (tile) => tile % 100,
    y: (tile) => Math.floor(tile / 100),
    isValidCoord: (x, y) => x >= 0 && x < 100 && y >= 0 && y < 100,
    ref: (x, y) => tileOf(x, y),
    ownerID: (tile) => grid[tile] ?? 999,
    config: () => ({ nukeMagnitudes: () => ({ outer: 2 }) }),
  };
  assert.equal(
    d4b.blastHitsFriendlyLand(tileOf(50, 50), UNIT.AtomBomb),
    false,
    "a blast over pure enemy land hits nothing friendly",
  );
  grid[tileOf(52, 50)] = 1;
  assert.equal(
    d4b.blastHitsFriendlyLand(tileOf(50, 50), UNIT.AtomBomb),
    true,
    "an own enclave at the inclusive land-fallout edge trips the friendly-land filter",
  );
  grid[tileOf(52, 50)] = 999;
  grid[tileOf(51, 50)] = 1;
  assert.equal(
    d4b.blastHitsFriendlyLand(tileOf(50, 50), UNIT.AtomBomb),
    true,
    "an own enclave inside the blast trips the friendly-land filter",
  );
  const walk = Object.create(sandbox.__NukeBehavior.prototype);
  walk.blastHitsFriendlyLand = (tile) => tile === 1;
  const probed = [];
  walk.probeCanBuildNuke = async (tile) => {
    probed.push(tile);
    return true;
  };
  const picked = await walk.selectBuildableNukeCandidate(
    [
      { tile: 1, value: 10 },
      { tile: 2, value: 5 },
    ],
    UNIT.AtomBomb,
  );
  assert.equal(picked.tile, 2, "the async probe walk skips a friendly-blast candidate");
  assert.deepEqual(probed, [2], "the friendly-blast candidate is never probed");
}

const breakableSamOwner = {
  smallID: () => 4,
  team: () => null,
};
const permanentSamOwner = {
  smallID: () => 5,
  team: () => "blue",
};
const samUnit = (owner, id) => ({
  owner: () => owner,
  id: () => id,
  level: () => 1,
});
const breakableSam = samUnit(breakableSamOwner, "breakable-sam");
const permanentSam = samUnit(permanentSamOwner, "team-sam");
const samRangeGame = {
  config: () => ({
    samRange: () => 10,
    maxSamRange: () => 10,
  }),
  nearbyUnits: () => [{ unit: breakableSam, distSquared: 1 }],
};
behavior.player = me;
behavior.game = samRangeGame;
assert.equal(
  behavior.isHostileSamIntercept({ unit: breakableSam, distSquared: 1 }, new Set()),
  false,
  "a breakable diplomatic ally's SAM cannot intercept a nuclear trajectory",
);
assert.deepEqual(
  Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  [],
  "hostile-SAM search excludes a breakable diplomatic ally's SAM",
);
behavior.game = {
  ...samRangeGame,
  nearbyUnits: () => [{ unit: permanentSam, distSquared: 1 }],
};
assert.equal(
  behavior.isHostileSamIntercept({ unit: permanentSam, distSquared: 1 }, new Set()),
  false,
  "a permanent teammate's SAM cannot intercept our nuclear trajectory",
);
assert.deepEqual(
  Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  [],
  "hostile-SAM search excludes a permanent teammate's SAM",
);

const mirvEnemy = {
  id: () => "enemy-2",
  smallID: () => 2,
  isPlayer: () => true,
  type: () => "Human",
};
const mirvPlayer = {
  smallID: () => 1,
  isFriendly: () => false,
  units: () => [
    {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileTimerQueue: () => [],
    },
  ],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvBehavior = new sandbox.__MirvBehavior(
  {},
  {
    ticks: () => 123,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  mirvPlayer,
  {
    maybeSendAttackEmoji() {},
    sendEmoji() {},
  },
);
mirvBehavior.calculateTerritoryCenter = async () => 0;
await mirvBehavior.maybeSendMIRV(mirvEnemy);
assert.equal(mirvBuildTile, 0, "a valid territory centre at tile zero still launches the MIRV");
assert.equal(
  sandbox.state.recentMirvHits.at(-1)?.tile,
  0,
  "the tile-zero MIRV impact is retained for the follow-up invasion",
);

mirvPlayer.smallID = () => 1;
const inboundTileZero = new sandbox.__MirvBehavior(
  {},
  {
    hasOwner: () => true,
    owner: () => ({ isPlayer: () => true, smallID: () => 1 }),
  },
  mirvPlayer,
  {},
);
assert.equal(
  inboundTileZero.isInboundMIRVFrom({
    units: () => [{ targetTile: () => 0 }],
  }),
  true,
  "an inbound MIRV aimed at owned tile zero is recognized as a threat",
);

const alliedMirvTarget = {
  smallID: () => 2,
