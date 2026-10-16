// A neighbour's SAM can cover a different player. Include the selected nuke
// target's structure value when choosing an aim that also destroys that SAM.
{
  const aimBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  const neighborSam = {
    type: () => UNIT.SAMLauncher,
    level: () => 1,
    tile: () => ({ x: 0, y: 0 }),
  };
  const neighborCity = {
    type: () => UNIT.City,
    level: () => 3,
    tile: () => ({ x: 0, y: 8 }),
  };
  const protectedSilo = {
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => ({ x: 8, y: 0 }),
  };
  const neighbor = {
    smallID: () => 2,
    units: (type) => [neighborSam, neighborCity].filter((unit) => unit.type() === type),
  };
  const protectedTarget = {
    smallID: () => 3,
    units: (type) => (type === UNIT.MissileSilo ? [protectedSilo] : []),
  };
  neighborSam.owner = () => neighbor;
  aimBehavior.game = {
    ticks: () => 1,
    players: () => [],
    config: () => ({ nukeMagnitudes: () => ({ outer: 5 }) }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    ref: (x, y) => ({ x, y }),
    isValidCoord: () => true,
    ownerID: () => 0,
    euclideanDistSquared: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2,
  };
  const ownPlayer = { smallID: () => 1, units: () => [], isFriendly: () => false };
  aimBehavior.player = ownPlayer;
  aimBehavior.game.players = () => [ownPlayer];
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(neighborSam, protectedTarget),
    { x: 4, y: 0 },
    "aim toward the selected target's protected Silo rather than the neighbor SAM owner's City decoy",
  );
}

