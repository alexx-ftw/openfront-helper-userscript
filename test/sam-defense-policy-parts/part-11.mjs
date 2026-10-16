behavior.game.players = () => [own, enemySilos, enemyTwoLevelOneSilos];
assert.equal(
  behavior.hostileSiloLevelSumTarget(),
  6,
  "The SAM target uses the greatest single enemy Silo-level-sum",
);
behavior.game.players = originalPlayersForSiloLevelSum;
const originalOwnGoldForSiloReserve = own.gold;
own.gold = () => 3_000_000n;
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 10, false),
  false,
  "Silo construction leaves room for the next economy and SAM actions",
);
own.gold = originalOwnGoldForSiloReserve;
enemyB.gold = () => 1_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  true,
  "The silo-gold gate opens at exactly 1M hostile gold",
);
assert.equal(
  behavior.shouldPrioritizeEconomicGrowth(),
  true,
  "Economic growth remains active after the hostile silo threshold when it is affordable",
);

const borderTroopEnemy = {
  smallID: () => 21,
  isPlayer: () => true,
  isAlive: () => true,
};
const remoteTroopEnemy = {
  smallID: () => 22,
  isPlayer: () => true,
  isAlive: () => true,
};
const friendlyBorderTroopPlayer = {
  smallID: () => 23,
  isPlayer: () => true,
  isAlive: () => true,
};
const borderTroopOwner = {
  smallID: () => 20,
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  isOnSameTeam: () => false,
  sharesBorderWith: (other) => other === borderTroopEnemy || other === friendlyBorderTroopPlayer,
};
let borderTroopTick = 1;
let borderTroopPlayers = [borderTroopOwner, borderTroopEnemy, remoteTroopEnemy];
const borderTroopMax = new Map([
  [borderTroopOwner, 1_000],
  [borderTroopEnemy, 1_200],
  [remoteTroopEnemy, 5_000],
  [friendlyBorderTroopPlayer, 5_000],
]);
const borderTroopBehavior = Object.create(sandbox.__StructureBehavior.prototype);
borderTroopBehavior.player = borderTroopOwner;
borderTroopBehavior.game = {
  ticks: () => borderTroopTick,
  players: () => borderTroopPlayers,
  config: () => ({
    maxTroops: (player) => borderTroopMax.get(player) ?? 0,
  }),
};
assert.equal(
  borderTroopBehavior.hasBorderingHostileMaxTroopAdvantage(),
  true,
  "A hostile bordering player with a larger max army activates the economic threat signal",
);
let fastBorderNeighborScans = 0;
const fastBorderOwner = {
  ...borderTroopOwner,
  borderTiles: () => new Set([1, 2]),
  sharesBorderWith: () => {
    throw new Error("the indexed border-owner path must avoid pairwise border scans");
  },
};
const fastBorderBehavior = Object.create(sandbox.__StructureBehavior.prototype);
fastBorderBehavior.player = fastBorderOwner;
const fastBorderMaxTroops = (player) => {
  if (player === fastBorderOwner) return 1_000;
  return borderTroopMax.get(player) ?? 0;
};
fastBorderBehavior.game = {
  ticks: () => 1,
  players: () => [fastBorderOwner, borderTroopEnemy, remoteTroopEnemy],
  config: () => ({
    maxTroops: fastBorderMaxTroops,
  }),
  neighbors: (tile) => {
    fastBorderNeighborScans++;
    return tile === 1 ? [10, 11] : [12];
  },
  isLand: () => true,
  ownerID: (tile) => {
    if (tile === 10) return 21;
    if (tile === 12) return 22;
    return null;
  },
};
assert.equal(
  fastBorderBehavior.hasBorderingHostileMaxTroopAdvantage(),
  true,
  "one border-owner scan preserves the stronger-hostile economic threat signal",
);
assert.equal(
  fastBorderNeighborScans,
  2,
  "the fast path scans each owned border tile once instead of once per hostile",
);
assert.equal(
  borderTroopBehavior.shouldPrioritizeEconomicGrowth(),
  true,
  "The bordering max-army signal prioritizes economic growth",
);
borderTroopMax.set(borderTroopEnemy, 900);
borderTroopTick = 2;
assert.equal(
  borderTroopBehavior.hasBorderingHostileMaxTroopAdvantage(),
  false,
  "A stronger non-border enemy does not activate the city priority",
);
borderTroopPlayers = [borderTroopOwner, friendlyBorderTroopPlayer];
borderTroopOwner.isFriendly = (other) => other === friendlyBorderTroopPlayer;
borderTroopTick = 3;
assert.equal(
  borderTroopBehavior.hasBorderingHostileMaxTroopAdvantage(),
  false,
  "A stronger allied border player is not treated as an enemy for city priority",
);
const borderCityAttemptOrder = [];
borderTroopBehavior.shouldBuildStructure = (type) => type === UNIT.City || type === UNIT.Factory;
borderTroopBehavior.maybeSpawnStructure = async (type) => {
  borderCityAttemptOrder.push(type);
  return type === UNIT.City;
};
assert.equal(
  await borderTroopBehavior.maybePrioritizeEconomicGrowth({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    prioritizeCityForBorderThreat: true,
  }),
  true,
  "Border max-army pressure builds an economic structure",
);
assert.deepEqual(
  borderCityAttemptOrder,
  [UNIT.City],
  "Border max-army pressure attempts a City before other economic structures",
);
assert.equal(
  behavior.enemySamCapacityParityTarget(),
  6,
  "Structure behavior selects the strongest hostile SAM stack",
);
assert.equal(behavior.missileSiloParityGap(), 4, "Silo parity reports the missing sum of levels");
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 0, false),
  true,
  "Silo construction remains eligible beyond the ordinary three-silo cap when parity is missing",
);
enemyB.gold = () => 999_999n;
enemyA.isAlive = () => false;
enemyA.gold = () => 2_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "Dead hostile players do not open the silo-gold gate",
);
enemyA.isAlive = () => true;
enemyA.gold = () => 999_999n;
const originalPlayersForSiloGoldThreshold = behavior.game.players;
behavior.game.players = () => [own, enemyA, enemyB];
const originalEnemySilosUnits = enemySilos.units;
enemySilos.units = () => [];
enemyB.gold = () => 500_000n;
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "The mandatory SAM trigger opens while a hostile is still saving for a Silo",
);
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
behavior._hostileSiloCapacitySnapshotTick = null;
