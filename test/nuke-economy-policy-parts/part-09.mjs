const boundaryValueGuard = Object.create(sandbox.__NukeBehavior.prototype);
boundaryValueGuard.game = {
  euclideanDistSquared: (a, b) => (a - b) ** 2,
  config: () => ({ nukeMagnitudes: () => ({ outer: 30 }) }),
};
boundaryValueGuard.isUnderHeavyAttack = () => false;
boundaryValueGuard.findStrategicBorderArmyTarget = () => null;
boundaryValueGuard.readySiloShotCapacity = () => 1;
boundaryValueGuard.nukeStructureValue = () => 1_000_000;
const boundaryValueTarget = (tile) => ({
  smallID: () => 2,
  units: (type) =>
    type === UNIT.City ? [{ type: () => UNIT.City, level: () => 4, tile: () => tile }] : [],
});
assert.equal(
  await boundaryValueGuard.nukeHasPositiveExpectedValue(
    { tile: 0, coveringSamLevels: 0 },
    boundaryValueTarget(31),
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
  ),
  false,
  "a City strictly past the blast edge cannot make an otherwise sub-value nuke appear profitable",
);
assert.equal(
  await boundaryValueGuard.nukeHasPositiveExpectedValue(
    { tile: 0, coveringSamLevels: 0 },
    boundaryValueTarget(30),
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
  ),
  false,
  "a City exactly on the blast edge survives and cannot justify the launch cost",
);
assert.equal(
  await boundaryValueGuard.nukeHasPositiveExpectedValue(
    { tile: 0, coveringSamLevels: 0 },
    boundaryValueTarget(29),
    { type: UNIT.AtomBomb, cost: 750_000n },
    [],
  ),
  true,
  "a City strictly inside the blast is destroyed and justifies the launch cost",
);
const counterforceValueGuard = Object.create(sandbox.__NukeBehavior.prototype);
const counterforcePlayer = makeArmyPlayer(1, 1_000_000);
counterforceValueGuard.player = {
  ...counterforcePlayer,
  gold: () => 10_000_000n,
};
counterforceValueGuard.game = {
  ticks: () => 2083,
  players: () => [counterforceValueGuard.player, cheapTarget],
  euclideanDistSquared: () => 0,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
counterforceValueGuard.attackBehavior = { shouldAttack: () => true };
counterforceValueGuard.structureBehavior = {
  strongestQuietStrategicBorderOpponent: () => ({
    opponentSid: 2,
    troops: 1_000_000,
  }),
};
counterforceValueGuard.isUnderHeavyAttack = () => false;
counterforceValueGuard.isRetaliationNukeTarget = () => false;
counterforceValueGuard.nukeStructureValue = () => 25_000;
assert.equal(
  await counterforceValueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "the selected parity-level strategic border force is a Legendary counterforce payoff even below structure replacement value",
);
const unrelatedTarget = { ...cheapTarget, smallID: () => 4 };
assert.equal(
  await counterforceValueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    unrelatedTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  false,
  "the counterforce expected-value bypass does not leak to an unrelated target",
);
const previousSurvivalWinFixes = sandbox.state.settings.winFixes;
sandbox.state.settings.winFixes = true;
valueGuard.attackBehavior = { findIncomingAttackPlayer: () => cheapTarget };
valueGuard.isUnderHeavyAttack = () => true;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "active-invader survival keeps the emergency nuke path available despite negative value",
);
const unrelatedHeavyAttackTarget = { ...cheapTarget, smallID: () => 4 };
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    unrelatedHeavyAttackTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  false,
  "the active-invasion survival bypass does not spend a bomb on an unrelated target",
);
sandbox.state.settings.winFixes = previousSurvivalWinFixes;
valueGuard.isUnderHeavyAttack = () => false;
valueGuard.attackBehavior = null;
valueGuard.isRetaliationNukeTarget = () => true;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  false,
  "plain retaliation no longer bypasses the expected-value guard",
);

