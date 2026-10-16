assert.equal(
  threatObserver.findBestNukeTarget(),
  ordinaryNukeTarget,
  "an incoming nuke without a live attacker silo leaves the ordinary target selected",
);
assert.equal(
  threatObserver._hostileNukeThreats.get(3)?.observedAt,
  8205,
  "the bot remembers the owner of a hostile nuke aimed at its territory",
);
assert.equal(
  threatObserver._hostileNukeThreats.has(4),
  false,
  "a nuke aimed at a different opponent does not create a counterforce threat",
);
assert.equal(
  threatObserver._hostileNukeThreats.get(5)?.observedAt,
  8205,
  "a hostile nuke centered on neutral land is remembered when its blast reaches a permanent teammate structure",
);
const replacementSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
};
nuclearAttacker.units = (type) => (type === UNIT.MissileSilo ? [replacementSilo] : []);
activeHostileMissiles = [];
observedTick = 8871;
assert.equal(
  threatObserver.findBestNukeTarget(),
  ordinaryNukeTarget,
  "the remembered attacker does not override normal target selection when its replacement silo appears",
);
observedTick = 9106;
threatObserver.observeHostileNukeThreats();
assert.equal(
  threatObserver._hostileNukeThreats.has(3),
  false,
  "counterforce reserve expires 901 ticks after the last observed missile",
);

let counterforceGold = 1_160_315n;
let siloTargets = [];
let emittedNukes = 0;
const counterforceTarget = {
  ...makeArmyPlayer(3, 900_000),
  units: (type) => (type === UNIT.MissileSilo ? siloTargets : []),
};
const counterforceSender = Object.create(sandbox.__NukeBehavior.prototype);
counterforceSender.player = {
  ...observedSelf,
  gold: () => counterforceGold,
  buildables: async () => [{ type: UNIT.AtomBomb, canBuild: true, cost: 750_000n }],
};
counterforceSender.game = {
  ticks: () => 8859,
  units: () => [],
  owner: () => null,
  euclideanDistSquared: (first, second) => (first - second) ** 2,
  config: () => ({ nukeMagnitudes: () => ({ outer: 100 }) }),
};
counterforceSender.attackBehavior = {
  findIncomingAttackPlayer: () => null,
  shouldAttack: () => true,
};
counterforceSender._hostileNukeThreats = new Map([
  [3, { observedAt: 8205, sourceSiloIds: new Set() }],
]);
counterforceSender._pendingNukeLaunches = [];
counterforceSender.isValidNukeTarget = () => true;
counterforceSender.isValidNukeDestination = () => true;
counterforceSender.nukeSpawn = () => 1;
counterforceSender.isTrajectoryInterceptableBySam = () => false;
counterforceSender.isUnderHeavyAttack = () => false;
counterforceSender.isRetaliationNukeTarget = () => false;
counterforceSender.getPerceivedNukeCost = async () => 750_000n;
counterforceSender.rememberSuccessfulNukeLaunch = async () => {};
const originalNukeEmitter = sandbox.sendAutoBotBuildOrUpgrade;
sandbox.sendAutoBotBuildOrUpgrade = () => {
  emittedNukes++;
  return true;
};
assert.equal(
  await counterforceSender.shouldHoldCounterforceNuke(
    1000,
    UNIT.AtomBomb,
    counterforceTarget,
    750_000n,
  ),
  true,
  "the shared launch policy reserves a second Atom cost after a hostile nuclear attack",
);
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  false,
  "an ordinary city shot cannot spend the last Atom held for the nuclear attacker",
);
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget, 20),
  false,
  "a delayed city shot is not queued when it would spend the reserved Atom",
);
assert.equal(counterforceSender._pendingNukeLaunches.length, 0);
siloTargets = [{ tile: () => 1010, isActive: () => true }];
assert.equal(
  await counterforceSender.sendNuke(1005, UNIT.AtomBomb, counterforceTarget),
  true,
  "the reserved Atom can launch when its blast covers the remembered attacker's silo",
);
assert.equal(emittedNukes, 1);
siloTargets = [];
const unrelatedCounterforceTarget = {
  ...makeArmyPlayer(4, 900_000),
  units: (type) => (type === UNIT.MissileSilo ? [{ tile: () => 1010 }] : []),
};
assert.equal(
  await counterforceSender.sendNuke(1005, UNIT.AtomBomb, unrelatedCounterforceTarget),
  false,
  "a different owner's silo cannot consume the remembered attacker's reserve",
);
assert.equal(
  await counterforceSender.firePendingNukeLaunch(
    {
      tile: 1000,
      nukeType: UNIT.AtomBomb,
      targetPlayer: counterforceTarget,
      salvo: null,
    },
    0,
    false,
  ),
  "drop",
  "a queued city shot is dropped if a new threat makes it consume the reserved Atom",
);
counterforceGold = 1_500_000n;
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  true,
  "surplus gold may fund an ordinary shot while leaving one Atom cost in reserve",
);
counterforceGold = 1_160_315n;
counterforceSender.isUnderHeavyAttack = () => true;
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  true,
  "the existing heavy-attack emergency may spend the counterforce reserve",
);
const originalWinFixes = sandbox.state.settings.winFixes;
sandbox.state.settings.winFixes = false;
assert.equal(
  await counterforceSender.sendNuke(1000, UNIT.AtomBomb, counterforceTarget),
  true,
  "disabling winFixes restores ordinary nuke launches",
);
sandbox.state.settings.winFixes = originalWinFixes;
sandbox.sendAutoBotBuildOrUpgrade = originalNukeEmitter;

testDifficulty = sandbox.Difficulty.Impossible;

assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  true,
  "An ordinary offensive nuke yields to the shared economy/defense reserve",
);

testDifficulty = sandbox.Difficulty.Legendary;
const valueGuard = Object.create(sandbox.__NukeBehavior.prototype);
valueGuard.player = { gold: () => 10_000_000n };
valueGuard.game = {
  euclideanDistSquared: () => 0,
  config: () => ({
    nukeMagnitudes: () => ({ outer: 100 }),
  }),
};
valueGuard.isUnderHeavyAttack = () => false;
valueGuard.isRetaliationNukeTarget = () => false;
const cheapTarget = {
  smallID: () => 2,
  team: () => null,
  isAlive: () => true,
  units: () => [{ type: () => UNIT.City, level: () => 1, tile: () => 20 }],
};
valueGuard.nukeStructureValue = () => 25_000;
valueGuard.findEnemySamsCoveringTile = () => [];
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [{ isUnderConstruction: () => false, level: () => 1 }],
  ),
  false,
  "Legendary skips an ordinary nuke whose vulnerable value is below its launch cost",
);
