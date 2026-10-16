);
assert.equal(
  behavior.enemyMissileSiloCapacityParityTarget(),
  6,
  "Silo parity selects the strongest hostile Silo level sum and treats construction as one projected level",
);
assert.equal(
  behavior.enemyMissileSiloCapacityTarget(),
  7,
  "SAM defense sums every hostile Silo level, including one projected construction slot",
);
assert.equal(
  behavior.samLevelParityTarget(),
  6,
  "SAM upgrade parity uses the strongest hostile Silo network instead of global hostile capacity",
);
state.settings.winFixes = false;
assert.equal(
  behavior.missileSiloParityTarget(),
  0,
  "Disabling winFixes disables the custom SAM-to-silo parity target",
);
state.settings.winFixes = true;

own.silos = [];
const reactiveSam = makeUnit(401, 1);
own.sams = [reactiveSam];
behavior.legendaryMissilePlacementContext = () => ({ threats: [{ targetTile: 999 }] });
behavior.legendaryDefenseEvaluation = (_context, options = {}) =>
  options.levelOverrides
    ? {
        hasThreats: true,
        fullyDefended: true,
        completionMarginTicks: 10,
        uninterceptedCount: 0,
      }
    : {
        hasThreats: true,
        fullyDefended: false,
        completionMarginTicks: 0,
        uninterceptedCount: 1,
      };
behavior.legendaryMinimumSamInterceptionCapacity = (_context, overrides) => (overrides ? 2 : 1);
behavior.legendaryReserveGold = () => 0n;
behavior.cost = () => 1_500_000n;
behavior.buildableFor = async () => ({
  type: UNIT.SAMLauncher,
  canUpgrade: true,
  cost: 1_500_000n,
});

let forecastCalls = 0;
let forecastTick = 100;
behavior.game.ticks = () => forecastTick;
behavior.legendaryMissilePlacementContext = () => {
  forecastCalls++;
  return { threats: [{ targetTile: 999 }] };
};
own.sams = [];
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "Reactive SAM defense does not forecast when there is no SAM to upgrade",
);
assert.equal(
  forecastCalls,
  0,
  "Reactive SAM defense avoids the expensive forecast when no SAM exists",
);

own.sams = [reactiveSam];
own.gold = () => 1_000_000n;
forecastCalls = 0;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "Reactive SAM defense does not forecast when the next upgrade is unaffordable",
);
assert.equal(
  forecastCalls,
  0,
  "Reactive SAM defense avoids the expensive forecast below the upgrade cost",
);
let parityProbeCalls = 0;
const parityBuildableFor = behavior.buildableFor;
const parityCost = behavior.cost;
behavior.cost = () => 3_000_000n;
behavior.buildableFor = async () => {
  parityProbeCalls++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 3_000_000n,
  };
};
own.gold = () => 1_500_000n;
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not attempt an upgrade when the next level costs more than the available 1.5M gold",
);
assert.equal(
  parityProbeCalls,
  1,
  "SAM parity probes the authoritative upgrade cost instead of assuming the new-SAM price",
);
const parityBuildCountBeforeAffordableUpgrade = sentBuilds.length;
behavior.buildableFor = async () => {
  parityProbeCalls++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 1_000_000n,
  };
};
const parityEconomicReserve = behavior.economicConstructionPressureForSamUpgrade()?.cost ?? 0n;
own.gold = () => 1_000_000n + parityEconomicReserve;
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "SAM parity upgrades only when the authoritative price and next economic action are both funded",
);
assert.equal(
  sentBuilds.length,
  parityBuildCountBeforeAffordableUpgrade + 1,
  "Affordable authoritative SAM parity upgrades emit one build action",
);
behavior.buildableFor = parityBuildableFor;
behavior.cost = parityCost;
own.gold = () => 5_000_000n;
behavior.getMissileDefenseContext();
behavior.getMissileDefenseContext();
assert.equal(forecastCalls, 1, "Missile defense context is reused within one game tick");
forecastTick++;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  1,
  "Missile defense context is reused inside its short conservative tick bucket",
);
forecastTick += 2;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  2,
  "Missile defense context refreshes when the conservative tick bucket advances",
);
own.sams = [makeUnit(402, 1)];
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  3,
  "Missile defense context refreshes when a SAM changes inside one tick bucket",
);
own.sams = [reactiveSam];
enemyTeamSamLevel = 13;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  4,
  "Missile defense context refreshes when an allied SAM changes inside one tick bucket",
);
enemyTeamSamLevel = 12;

const originalGamePlayersForSignalTest = behavior.game.players;
const originalGameUnitsForSignalTest = behavior.game.units;
const originalEmptyMissileContext = behavior.legendaryEmptyMissileDefenseContext;
const originalEnemyBGoldForSignalTest = enemyB.gold;
behavior.game.players = () => [own, enemyB];
behavior.game.units = () => [];
behavior._hostilePlayersSnapshotTick = null;
behavior._missileDefenseSignalTick = null;
behavior._activeHostileMissileTick = null;
behavior._activeHostileMissileCache = null;
enemyB.gold = () => 1_500_000n;
behavior.legendaryEmptyMissileDefenseContext = () => ({ threats: [] });
forecastCalls = 0;
assert.equal(
  behavior.hasMissileDefenseSignal(),
  false,
  "Gold alone does not count as an active missile-defense forecast signal",
);
behavior.getMissileDefenseContext();
assert.equal(forecastCalls, 0, "Gold alone avoids the expensive missile trajectory forecast");
behavior.game.players = originalGamePlayersForSignalTest;
behavior.game.units = originalGameUnitsForSignalTest;
behavior._hostilePlayersSnapshotTick = null;
behavior._missileDefenseSignalTick = null;
behavior.legendaryEmptyMissileDefenseContext = originalEmptyMissileContext;
enemyB.gold = originalEnemyBGoldForSignalTest;
