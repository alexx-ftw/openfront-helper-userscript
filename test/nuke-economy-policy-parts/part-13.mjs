  // Engine Player.allies() deliberately omits permanent teammates.
  allies: () => [],
  targets: () => [],
};
behavior.player = me;
behavior.game = { players: () => [me, deadTeammate, teammate] };
assert.equal(
  behavior.findAllyNukeTarget(),
  teammateTarget,
  "nuclear targeting supports a permanent teammate's marked enemy",
);

const breakableAllyTarget = { smallID: () => 75 };
const breakableAlly = {
  smallID: () => 4,
  team: () => null,
  isAlive: () => true,
  targets: () => [breakableAllyTarget],
};
behavior.game = { players: () => [me, breakableAlly, teammate] };
assert.equal(
  behavior.findAllyNukeTarget(),
  teammateTarget,
  "a breakable diplomatic ally is not treated as a permanent nuclear ally",
);

const diplomaticNukeOwner = {
  smallID: () => 2,
  team: () => null,
};
const teamNukeOwner = {
  smallID: () => 3,
  team: () => "blue",
};
behavior.player = {
  smallID: () => 1,
  isFriendly: () => true,
  team: () => null,
};
behavior.game = {
  units: () => [
    {
      owner: () => diplomaticNukeOwner,
      targetTile: () => 0,
      type: () => UNIT.AtomBomb,
    },
  ],
  config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "a diplomatic ally's nuke suppresses our overlapping launch (upstream 34a8fe723)",
);
behavior.player.team = () => "blue";
behavior.game.units = () => [
  {
    owner: () => teamNukeOwner,
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "a permanent teammate's nuke prevents a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 1 }),
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "our own in-flight nuke suppresses a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 9 }),
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "an enemy nuke in FFA suppresses a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 9 }),
    targetTile: () => 0,
    type: () => UNIT.MIRVWarhead,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  true,
  "an in-flight MIRV warhead suppresses a duplicate overlapping launch",
);
behavior.game.units = () => [
  {
    owner: () => ({ smallID: () => 9 }),
    targetTile: () => null,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isNukeAlreadyLandingNear(0, UNIT.AtomBomb),
  false,
  "a warhead without a target tile does not suppress",
);

