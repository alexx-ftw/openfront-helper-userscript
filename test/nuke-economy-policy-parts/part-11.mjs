// Production shape (cycle 14): currentDifficulty() maps the Legendary user
// setting to the Impossible raw value, so the policy-tier bridge — not raw
// equality — is what arms the expected-value guard in real runs.
sandbox.isLegendaryDifficulty = (difficulty) =>
  difficulty === "Legendary" || difficulty === "Impossible";
testDifficulty = sandbox.Difficulty.Impossible;
const prodShapeGuard = Object.create(sandbox.__NukeBehavior.prototype);
prodShapeGuard.player = { gold: () => 10_000_000n };
prodShapeGuard.game = {
  euclideanDistSquared: () => 0,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
prodShapeGuard.isUnderHeavyAttack = () => false;
prodShapeGuard.isRetaliationNukeTarget = () => false;
prodShapeGuard.nukeStructureValue = () => 25_000;
const prodTarget = {
  smallID: () => 2,
  team: () => null,
  isAlive: () => true,
  units: () => [{ type: () => UNIT.City, level: () => 1, tile: () => 20 }],
};
assert.equal(
  await prodShapeGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    prodTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [{ isUnderConstruction: () => false, level: () => 1 }],
  ),
  false,
  "the Legendary policy tier evaluates the expected-value guard through the production Impossible alias",
);
const prodCounterforce = Object.create(sandbox.__NukeBehavior.prototype);
prodCounterforce.player = { gold: () => 10_000_000n };
prodCounterforce.game = {
  euclideanDistSquared: () => 0,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
prodCounterforce.isUnderHeavyAttack = () => false;
prodCounterforce.isRetaliationNukeTarget = () => false;
prodCounterforce.nukeStructureValue = () => 25_000;
prodCounterforce.findStrategicBorderArmyTarget = () => ({ smallID: () => 2 });
assert.equal(
  await prodCounterforce.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    prodTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "the strategic-border counterforce bypass survives the production-shape bridge",
);
testDifficulty = sandbox.Difficulty.Hard;
assert.equal(
  await prodShapeGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    prodTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "Hard stays a pass-through tier under the production-shape bridge",
);
assert.deepEqual(
  policyCalls,
  [5_000_000n],
  "The nuke policy receives the selected nuke's actual perceived cost",
);

