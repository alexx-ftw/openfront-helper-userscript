// Anti-SAM aim scoring must move the blast center with each candidate.
{
  const aimBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  const structures = [];
  const sam = {
    tile: () => ({ x: 0, y: 0 }),
    type: () => UNIT.SAMLauncher,
    level: () => 1,
    owner: () => ({ units: () => structures }),
  };
  structures.push(sam, {
    tile: () => ({ x: 8, y: 0 }),
    type: () => UNIT.MissileSilo,
    level: () => 1,
  });
  aimBehavior.game = {
    ticks: () => 1,
    players: () => [],
    config: () => ({ nukeMagnitudes: () => ({ outer: 5 }) }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    ref: (x, y) => ({ x, y }),
    isValidCoord: () => true,
    euclideanDistSquared: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2,
  };
  let friendlyStructures = [];
  aimBehavior.player = { smallID: () => 1, units: () => friendlyStructures };
  const ownPlayer = aimBehavior.player;
  ownPlayer.isFriendly = (other) => other.smallID?.() === ownPlayer.smallID();
  aimBehavior.game.players = () => [ownPlayer];
  aimBehavior.game.ownerID = (tile) =>
    friendlyStructures.some((unit) => {
      const unitTile = unit.tile();
      return unitTile.x === tile.x && unitTile.y === tile.y;
    })
      ? ownPlayer.smallID()
      : 0;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 4, y: 0 },
    "aim between the SAM and silo to destroy both, instead of scoring every blast at the SAM",
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 8, y: 1 }) },
  ];
  aimBehavior.game.ticks = () => 2;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "replacement-value aim scoring must not trade our silo for an equally priced enemy silo",
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 5, tile: () => ({ x: 8, y: 1 }) },
    { type: () => UNIT.SAMLauncher, level: () => 5, tile: () => ({ x: 8, y: 2 }) },
  ];
  aimBehavior.game.ticks = () => 3;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "a salvo prefers destroying the SAM alone over the extra enemy silo plus a more valuable friendly defense cluster",
  );
  structures.splice(
    1,
    structures.length - 1,
    ...Array.from({ length: 12 }, () => ({
      tile: () => ({ x: 8, y: 0 }),
      type: () => UNIT.MissileSilo,
      level: () => 1,
    })),
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 7, y: 0 }) },
  ];
  aimBehavior.game.ticks = () => 4;
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "a high-value enemy cluster cannot make the salvo aim inside friendly land",
  );
  friendlyStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 0, y: 4 }) },
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => ({ x: 4, y: 3 }) },
  ];
  aimBehavior.game.ticks = () => 5;
  assert.equal(
    aimBehavior.samSalvoAimTile(sam),
    null,
    "no aim is returned when every candidate blast reaches friendly land",
  );
  friendlyStructures = [];
  aimBehavior.game.ticks = () => 6;
  aimBehavior.game.config = () => ({ nukeMagnitudes: () => ({ outer: 4 }) });
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "the SAM must be strictly inside the blast, not on its indestructible outer boundary",
  );
  structures[1].tile = () => ({ x: 8, y: 8 });
  aimBehavior.game.config = () => ({ nukeMagnitudes: () => ({ outer: 6 }) });
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 4, y: 4 },
    "diagonal aim points use the engine's circular blast rather than Manhattan distance",
  );
}

