import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  Warship: "Warship",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

const state = {
  settings: { winFixes: true, buildStructures: {} },
  stats: { builds: 0 },
};
const sentBuilds = [];
const sandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team" },
  state,
  currentDifficulty: () => Difficulty.Impossible,
  isLegendaryDifficulty: (difficulty = Difficulty.Impossible) =>
    difficulty === Difficulty.Legendary,
  isAtLeastHardDifficulty: (difficulty) =>
    difficulty === Difficulty.Hard ||
    difficulty === Difficulty.Impossible ||
    difficulty === Difficulty.Legendary,
  getBuildMenu: () => ({
    sendBuildOrUpgrade: (buildable) => sentBuilds.push(buildable),
  }),
  autoBotBuildAllowed: () => true,
  randTerritoryTileArray: (_random, _game, _player, count) =>
    Array.from({ length: count }, (_, index) => 10_000 + index),
  setLastAction: () => {},
  tr: (value) => value,
  console,
};
sandbox.globalThis = sandbox;

vm.runInNewContext(
  `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read(
    "engine/ingame/auto-bot/structureBehavior.js",
  )}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: "sam-defense-policy.vm.js" },
);

assert.equal(
  typeof sandbox.legendaryMaxEnemySamCapacity,
  "function",
  "Planner exposes the hostile SAM-capacity parity helper",
);
assert.equal(
  sandbox.legendaryMaxEnemySamCapacity([[3, 1], [2, 2, 2], []]),
  6,
  "Parity uses the largest per-enemy sum of SAM levels, not the global sum",
);
assert.equal(
  sandbox.legendaryMaxEnemySamCapacity([[{ level: 4 }, { level: 1 }], [2]]),
  5,
  "Parity accepts level records as well as numeric level snapshots",
);

const makeUnit = (id, level, { underConstruction = false } = {}) => ({
  id: () => id,
  level: () => level,
  tile: () => id,
  isUnderConstruction: () => underConstruction,
  isActive: () => true,
});

const own = {
  smallID: () => 1,
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  isOnSameTeam: (other) => other?.smallID?.() === 5,
  gold: () => 5_000_000n,
  silos: [makeUnit(101, 2)],
  sams: [],
};
const enemyA = {
  smallID: () => 2,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 999_999n,
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(201, 3), makeUnit(202, 1)] : []),
};
const enemyB = {
  smallID: () => 3,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 900_000n,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(301, 2), makeUnit(302, 2), makeUnit(303, 2)] : [],
};
const enemyC = {
  smallID: () => 4,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 900_000n,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(401, 9, { underConstruction: true })] : [],
};
let enemyTeamSamLevel = 12;
const enemyTeam = {
  smallID: () => 5,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 5_000_000n,
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(501, enemyTeamSamLevel)] : []),
};
const enemySilos = {
  smallID: () => 6,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 800_000n,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(601, 4), makeUnit(602, 2)] : []),
};
const enemySiloUnderConstruction = {
  smallID: () => 7,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 700_000n,
  units: (type) =>
    type === UNIT.MissileSilo ? [makeUnit(701, 99, { underConstruction: true })] : [],
};
const enemySingleLevelOneSilo = {
  smallID: () => 8,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(801, 1)] : []),
};
const enemyTwoLevelOneSilos = {
  smallID: () => 9,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(901, 1), makeUnit(902, 1)] : []),
};
own.units = (type) => {
  if (type === UNIT.MissileSilo) return own.silos;
  if (type === UNIT.SAMLauncher) return own.sams;
  return [];
};
let samDisabled = false;

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
behavior.player = own;
behavior.game = {
  players: () => [own, enemyA, enemyB, enemyC, enemyTeam, enemySilos, enemySiloUnderConstruction],
  config: () => ({
    isUnitDisabled: (type) => type === UNIT.SAMLauncher && samDisabled,
    gameConfig: () => ({ gameMode: "FFA" }),
    samRange: (level) => 50 * Number(level || 1),
  }),
};

assert.equal(
  typeof behavior.enemySamCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile SAM parity target",
);
assert.equal(
  typeof behavior.hasHostileReachedSiloGoldThreshold,
  "function",
  "Structure behavior exposes the hostile silo-gold threshold check",
);
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "All hostile players below 1M gold keep the economy priority active",
);
assert.equal(
  behavior.shouldPrioritizeEconomicGrowth(),
  true,
  "Economic growth is prioritized while no hostile can afford a silo",
);
assert.equal(
  behavior.economicConstructionPressure()?.type,
  UNIT.Factory,
  "The next affordable productive structure remains visible to the policy",
);
const originalOwnGoldForPressure = own.gold;
own.gold = () => 1_000n;
assert.equal(
  behavior.economicConstructionPressure(),
  null,
  "The economy pressure clears when no productive structure is affordable",
);
own.gold = originalOwnGoldForPressure;
assert.equal(
  typeof behavior.hasHostileSiloThreat,
  "function",
  "Structure behavior exposes the hostile silo threat check",
);
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "A built hostile silo triggers the mandatory SAM response",
);
const originalPlayersForSiloLevelSum = behavior.game.players;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
assert.equal(
  behavior.hostileSiloLevelSumAtLeast(),
  false,
  "One level-1 hostile Silo contributes one to the H-bomb trigger, not two",
);
behavior.game.players = () => [own, enemyTwoLevelOneSilos];
assert.equal(
  behavior.hostileSiloLevelSumAtLeast(),
  true,
  "Two hostile level-1 Silos reach the level-sum trigger",
);
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
const originalEnemySilosUnits = enemySilos.units;
enemySilos.units = () => [];
enemyB.gold = () => 1_500_000n;
assert.equal(
  behavior.hasHostileSiloThreat(),
  true,
  "The mandatory SAM trigger opens at exactly 1.5M hostile gold",
);
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
behavior._hostileSiloCapacitySnapshotTick = null;
behavior._hostileSiloCapacitySnapshot = null;
enemyB.gold = () => 1_499_999n;
assert.equal(
  behavior.hasHostileSiloThreat(),
  false,
  "Gold below 1.5M does not trigger the mandatory SAM without a built silo",
);
enemySilos.units = originalEnemySilosUnits;
enemyB.gold = () => 999_999n;
const originalOwnIsFriendly = own.isFriendly;
const originalEnemySilosGold = enemySilos.gold;
own.isFriendly = (other) => other === enemySilos;
enemySilos.gold = () => 2_000_000n;
assert.equal(
  behavior.hasHostileReachedSiloGoldThreshold(),
  false,
  "A friendly player with 2M gold does not open the hostile silo-gold gate",
);
own.isFriendly = originalOwnIsFriendly;
enemySilos.gold = originalEnemySilosGold;
const originalShouldBuildStructure = behavior.shouldBuildStructure;
const originalMaybeSpawnStructure = behavior.maybeSpawnStructure;
const economicAttemptOrder = [];
behavior.shouldBuildStructure = (type) => type === UNIT.Port || type === UNIT.Factory;
behavior.maybeSpawnStructure = async (type) => {
  economicAttemptOrder.push(type);
  return type === UNIT.Factory;
};
assert.equal(
  await behavior.maybePrioritizeEconomicGrowth({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
  }),
  true,
  "Economic priority builds when an eligible economic structure is available",
);
assert.deepEqual(
  economicAttemptOrder,
  [UNIT.Port, UNIT.Factory],
  "Economic priority attempts port and factory before falling through",
);
behavior.shouldBuildStructure = originalShouldBuildStructure;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const originalPerceivedCost = behavior.getPerceivedCost;
const originalOwnGold = own.gold;
const highGoldEconomicCalls = [];
behavior.getPerceivedCost = () => 1_000_000n;
own.gold = () => 9_000_000n;
behavior.maybeSpawnStructure = async (type) => {
  highGoldEconomicCalls.push(type);
  return type === UNIT.City;
};
assert.equal(
  await behavior.maybePrioritizeHighGoldEconomicConstruction({
    config: { isUnitDisabled: () => false },
    hasOceanPortTiles: true,
  }),
  true,
  "High-gold pressure requests an affordable economic structure after defensive priorities",
);
assert.deepEqual(
  highGoldEconomicCalls,
  [UNIT.City],
  "High-gold economic construction tries the city first and stops after a successful build",
);
behavior.getPerceivedCost = originalPerceivedCost;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
own.gold = originalOwnGold;

let hostileAttemptTick = 1000;
behavior.game.ticks = () => hostileAttemptTick;
const hostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  hostileSamCalls.push(args);
  return true;
};
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A hostile silo threat requests one dedicated SAM",
);
assert.equal(
  hostileSamCalls.length,
  1,
  "A successful threat SAM request crosses the placement path once",
);
assert.deepEqual(
  hostileSamCalls.map(([type, options]) => [
    type,
    {
      forceNewStructure: options.forceNewStructure,
      prioritizeStructureCoverage: options.prioritizeStructureCoverage,
      probeLimit: options.probeLimit,
      probeTimeoutMs: options.probeTimeoutMs,
      parallelProbeCount: options.parallelProbeCount,
    },
  ]),
  [
    [
      UNIT.SAMLauncher,
      {
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        probeLimit: 6,
        probeTimeoutMs: 750,
        parallelProbeCount: 6,
      },
    ],
  ],
  "The dedicated SAM request forces a bounded coverage-ranked placement",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "The dedicated threat SAM is not repeated within the same game tick",
);
hostileAttemptTick++;
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  true,
  "A remaining hostile Silo site gap allows another SAM on a later tick",
);
assert.equal(
  hostileSamCalls.length,
  2,
  "SAM construction is not permanently disabled after the first successful build",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamAttemptTick = null;
const failedHostileSamCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  failedHostileSamCalls.push(args);
  return false;
};
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A failed dedicated SAM request returns without claiming that the SAM was built",
);
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A failed dedicated SAM request is not repeated within the same game tick",
);
assert.equal(
  failedHostileSamCalls.length,
  1,
  "A failed dedicated SAM request crosses the placement path only once per tick",
);
hostileAttemptTick++;
await behavior.maybeSpawnHostileSiloSam();
assert.equal(
  failedHostileSamCalls.length,
  1,
  "A failed dedicated SAM request is not retried during its short placement backoff",
);
hostileAttemptTick += 9;
await behavior.maybeSpawnHostileSiloSam();
assert.equal(
  failedHostileSamCalls.length,
  2,
  "A failed dedicated SAM request is retried after the placement backoff expires",
);
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;

const constructionBlockedCalls = [];
behavior.maybeSpawnStructure = async (...args) => {
  constructionBlockedCalls.push(args);
  return true;
};
own.sams = [makeUnit(999, 1, { underConstruction: true })];
assert.equal(
  await behavior.maybeSpawnHostileSiloSam(),
  false,
  "A pending SAM construction blocks another dedicated hostile-Silo placement",
);
assert.equal(
  constructionBlockedCalls.length,
  0,
  "A pending SAM construction avoids a second expensive placement probe",
);
own.sams = [];
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;

const originalReactiveUpgrade = behavior.maybeUpgradeMissileDefenseSam;
const originalParityUpgrade = behavior.maybeUpgradeSamForSiloParity;
const originalSamGap = behavior.samLevelParityGap;
const originalShouldBuildHostileSam = behavior.shouldBuildHostileSiloSam;
const originalTryBuildDefensePost = behavior.tryBuildDefensePost;
const originalIsInPostSaveUpBlockedPhase = behavior.isInPostSaveUpBlockedPhase;
const originalDoHandleStructures = behavior.doHandleStructures;
const originalGameConfigForFallback = behavior.game.config;
const originalGameTicksForFallback = behavior.game.ticks;
let fullPathPlacementCalls = 0;
let fullPathTick = 2_000;
behavior.game.ticks = () => fullPathTick;
behavior.game.config = () => ({ isUnitDisabled: () => true });
behavior.maybeUpgradeMissileDefenseSam = async () => false;
behavior.maybeUpgradeSamForSiloParity = async () => false;
behavior.samLevelParityGap = () => 1;
behavior.shouldBuildHostileSiloSam = () => true;
behavior.maybeSpawnStructure = async () => {
  fullPathPlacementCalls++;
  fullPathTick += 2;
  return false;
};
behavior.tryBuildDefensePost = async () => false;
behavior.isInPostSaveUpBlockedPhase = () => false;
behavior.doHandleStructures = async () => false;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;
assert.equal(
  await behavior.handleStructures(),
  false,
  "A failed hostile-Silo placement falls through without building another SAM in the same decision",
);
assert.equal(
  fullPathPlacementCalls,
  1,
  "A failed async hostile-Silo placement cannot be duplicated when the game tick advances during probing",
);
behavior.maybeUpgradeMissileDefenseSam = originalReactiveUpgrade;
behavior.maybeUpgradeSamForSiloParity = originalParityUpgrade;
behavior.samLevelParityGap = originalSamGap;
behavior.shouldBuildHostileSiloSam = originalShouldBuildHostileSam;
behavior.maybeSpawnStructure = originalMaybeSpawnStructure;
behavior.tryBuildDefensePost = originalTryBuildDefensePost;
behavior.isInPostSaveUpBlockedPhase = originalIsInPostSaveUpBlockedPhase;
behavior.doHandleStructures = originalDoHandleStructures;
behavior.game.config = originalGameConfigForFallback;
behavior.game.ticks = originalGameTicksForFallback;
behavior._hostileSiloSamAttemptTick = null;
behavior._hostileSiloSamRetryNotBeforeTick = null;
behavior._hostilePlayersSnapshotTick = null;
behavior._hostilePlayersSnapshot = null;
behavior._hostileThreatSnapshotTick = null;
behavior._hostileThreatSnapshot = null;
const originalOwnUnits = own.units;
const originalGameConfig = behavior.game.config;
const originalEuclideanDistSquared = behavior.game.euclideanDistSquared;
const protectedStructures = [
  { type: () => UNIT.City, tile: () => 10 },
  { type: () => UNIT.Factory, tile: () => 20 },
];
own.units = (...types) => {
  if (types.includes(UNIT.SAMLauncher)) return [];
  if (types.some((type) => protectedStructures.some((unit) => unit.type() === type))) {
    return protectedStructures;
  }
  return [];
};
behavior.game.config = () => ({
  defaultSamRange: () => 5,
  samRange: () => 5,
});
behavior.game.euclideanDistSquared = (left, right) => (Number(left) - Number(right)) ** 2;
const threatSamValue = behavior.threatSamLauncherValue();
assert.equal(
  threatSamValue(15) > threatSamValue(10),
  true,
  "Threat SAM placement prefers the tile covering more structures",
);

const coverageProbeStructures = Array.from({ length: 500 }, (_, index) => ({
  tile: () => index * 100,
}));
const coverageProbe = Object.create(sandbox.__StructureBehavior.prototype);
coverageProbe.random = {};
coverageProbe.player = {
  units: (...types) => (types.includes(UNIT.SAMLauncher) ? [] : coverageProbeStructures),
};
coverageProbe.game = {
  neighbors: (tile) => [tile + 1, tile + 2, tile + 3],
  config: () => ({
    defaultSamRange: () => 10,
    samRange: () => 10,
  }),
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
let coverageProbeCount = 0;
coverageProbe.buildableFor = async () => {
  coverageProbeCount++;
  return null;
};
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
  }),
  null,
  "Coverage-priority SAM placement returns null when all probes are unavailable",
);
assert.equal(
  coverageProbeCount,
  25,
  "Coverage-priority SAM placement keeps ranking and async probes bounded to the normal candidate budget",
);
coverageProbeCount = 0;
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
    probeLimit: 6,
    probeTimeoutMs: 20,
    parallelProbeCount: 6,
  }),
  null,
  "High-gold coverage-priority SAM placement returns null when its bounded probes are unavailable",
);
assert.equal(
  coverageProbeCount,
  6,
  "High-gold coverage-priority SAM placement probes only six candidates",
);
const originalTilesNearFriendlySams = coverageProbe.tilesNearFriendlySams;
const originalMissileSiloValue = coverageProbe.missileSiloValue;
coverageProbe.tilesNearFriendlySams = () =>
  Array.from({ length: 25 }, (_, index) => 20_000 + index);
coverageProbe.missileSiloValue = () => () => 0;
coverageProbeCount = 0;
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.MissileSilo),
  null,
  "SAM-covered silo placement returns null when all merged probes are unavailable",
);
assert.equal(
  coverageProbeCount,
  25,
  "SAM-covered silo placement keeps the merged candidate set bounded to 25 probes",
);
coverageProbe.tilesNearFriendlySams = originalTilesNearFriendlySams;
coverageProbe.missileSiloValue = originalMissileSiloValue;
own.units = originalOwnUnits;
behavior.game.config = originalGameConfig;
behavior.game.euclideanDistSquared = originalEuclideanDistSquared;

const hydrogenProtectionBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const hydrogenSam = makeUnit(1101, 1);
hydrogenProtectionBehavior.player = {
  smallID: () => 1,
  gold: () => 5_000_000n,
  borderTiles: () => new Set([0, 10]),
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [hydrogenSam];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    return [];
  },
};
hydrogenProtectionBehavior.game = {
  ticks: () => 1,
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
hydrogenProtectionBehavior.liveHostilePlayers = () => [enemyTwoLevelOneSilos];
hydrogenProtectionBehavior.legendaryReserveGold = () => 0n;
hydrogenProtectionBehavior.cost = () => 1n;
hydrogenProtectionBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1n },
];
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  2,
  "H-bomb SAM parity targets the largest hostile built-Silo level sum",
);
sentBuilds.length = 0;
assert.equal(
  await hydrogenProtectionBehavior.maybeUpgradeHydrogenProtectionSam(),
  true,
  "H-bomb coverage emits the required SAM upgrade",
);
assert.equal(sentBuilds.length, 1, "H-bomb coverage emits one SAM upgrade action");
hydrogenProtectionBehavior.liveHostilePlayers = () => [enemySingleLevelOneSilo];
hydrogenProtectionBehavior._hydrogenSamProtectionTick = null;
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan(),
  null,
  "A single level-1 hostile Silo does not activate H-bomb SAM protection",
);

const firstSiloCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
firstSiloCoverageBehavior.player = {
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    if (type === UNIT.MissileSilo) return [makeUnit(1150, 1)];
    return [];
  },
};
firstSiloCoverageBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    gameConfig: () => ({ gameMode: "FFA" }),
    samRange: (level) => level * 6,
  }),
};
firstSiloCoverageBehavior.liveHostilePlayers = () => [enemySingleLevelOneSilo];
firstSiloCoverageBehavior.legendaryReserveGold = () => 0n;
assert.equal(
  firstSiloCoverageBehavior.hydrogenStructureCoveragePlan()?.needsNewSam,
  true,
  "The first built hostile level-1 Silo requests a SAM covering our structures",
);
assert.equal(
  firstSiloCoverageBehavior.defensiveConstructionPressure()?.type,
  UNIT.SAMLauncher,
  "The first hostile Silo creates a defensive SAM reserve before offense",
);

let coverageSamLevel = 1;
const structureCoverageSam = {
  id: () => 1201,
  level: () => coverageSamLevel,
  tile: () => 0,
  isUnderConstruction: () => false,
  isActive: () => true,
};
const structureCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
structureCoverageBehavior.player = {
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [structureCoverageSam];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    if (type === UNIT.Factory) return [{ tile: () => 10 }];
    return [];
  },
};
structureCoverageBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
structureCoverageBehavior.liveHostilePlayers = () => [enemyTwoLevelOneSilos];
structureCoverageBehavior.cost = () => 1n;
structureCoverageBehavior.legendaryReserveGold = () => 0n;
structureCoverageBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1n },
];
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan().targetLevel,
  2,
  "Structure protection chooses the minimum SAM level covering every structure",
);
sentBuilds.length = 0;
assert.equal(
  await structureCoverageBehavior.maybeEnsureHydrogenStructureCoverage(),
  true,
  "Structure protection emits the required SAM upgrade",
);
assert.equal(sentBuilds.length, 1, "Structure protection emits one upgrade action");
coverageSamLevel = 2;
assert.equal(
  structureCoverageBehavior.hydrogenStructureCoveragePlan(),
  null,
  "A SAM at the planned level covers all own structures",
);

const originalGetPerceivedCost = behavior.getPerceivedCost;
const originalStructureSpawnTile = behavior.structureSpawnTile;
const originalGetTotalStructureDensity = behavior.getTotalStructureDensity;
behavior.structureSpawnTile = async () => ({ canBuild: true });
behavior.getTotalStructureDensity = () => 0;
const buildsBeforeSiloGate = sentBuilds.length;
const originalOwnGoldForDirectSilo = own.gold;
own.gold = () => 100_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  false,
  "The direct silo spawn path preserves the economy reserve when surplus is insufficient",
);
hostileAttemptTick++;
enemyB.gold = () => 1_000_000n;
own.gold = () => 5_000_000n;
assert.equal(
  await behavior.maybeSpawnStructure(UNIT.MissileSilo),
  true,
  "The direct silo spawn path reopens when surplus covers the economy reserve",
);
assert.equal(
  sentBuilds.length,
  buildsBeforeSiloGate + 1,
  "Only the threshold-opened direct silo attempt reaches the build menu",
);
enemyB.gold = () => 999_999n;
own.gold = originalOwnGoldForDirectSilo;
behavior.getPerceivedCost = originalGetPerceivedCost;
behavior.structureSpawnTile = originalStructureSpawnTile;
behavior.getTotalStructureDensity = originalGetTotalStructureDensity;
own.silos = [makeUnit(101, 6)];
assert.equal(
  behavior.missileSiloParityGap(),
  0,
  "A level sum equal to the strongest enemy SAM stack closes the parity gap",
);
assert.equal(
  behavior.shouldBuildStructure(UNIT.MissileSilo, 0, false),
  false,
  "Silo parity stops requesting more capacity once the target is reached",
);
assert.equal(
  typeof behavior.enemyMissileSiloCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile Silo-capacity parity target",
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
  0,
  "SAM parity checks affordability before issuing per-SAM async probes",
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

const originalEnemySilosGoldForCapacityTest = enemySilos.gold;
enemySilos.gold = () => 1_500_000n;
forecastTick = 300;
forecastCalls = 0;
behavior.getMissileDefenseContext();
forecastTick = 301;
enemySilos.gold = () => 1_500_001n;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  1,
  "Small hostile gold changes do not invalidate the short forecast bucket",
);
forecastTick = 302;
enemySilos.gold = () => 3_000_000n;
behavior.getMissileDefenseContext();
assert.equal(
  forecastCalls,
  2,
  "A hostile gold change that adds an affordable missile refreshes the forecast",
);
enemySilos.gold = originalEnemySilosGoldForCapacityTest;

behavior.game.units = () => [];
behavior._missileDefenseSignalTick = null;
const originalReactiveSignalBuildableFor = behavior.buildableFor;
let reactiveSignalProbeCalls = 0;
behavior.buildableFor = async () => {
  reactiveSignalProbeCalls++;
  return { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1_500_000n };
};
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A built hostile silo without an active missile does not trigger reactive SAM upgrade work",
);
assert.equal(
  reactiveSignalProbeCalls,
  0,
  "A built hostile silo without an active missile avoids per-SAM async probes",
);
behavior.buildableFor = originalReactiveSignalBuildableFor;
const activeHostileMissile = {
  isActive: () => true,
  owner: () => enemySilos,
};
behavior.game.units = () => [activeHostileMissile];
behavior._missileDefenseSignalTick = null;

let forecastTickSeen = null;
const originalBuildableFor = behavior.buildableFor;
behavior.legendaryMissilePlacementContext = () => {
  forecastCalls++;
  forecastTickSeen = forecastTick;
  return { threats: [{ targetTile: 999 }] };
};
behavior.buildableFor = async () => {
  forecastTick++;
  return {
    type: UNIT.SAMLauncher,
    canUpgrade: true,
    cost: 1_500_000n,
  };
};
forecastTick = 200;
forecastCalls = 0;
await behavior.maybeUpgradeMissileDefenseSam();
assert.equal(
  forecastTickSeen,
  201,
  "Reactive SAM defense forecasts after async buildable probes finish",
);
behavior.buildableFor = originalBuildableFor;
sentBuilds.length = 0;

let evaluationCalls = 0;
behavior._missileDefenseEvaluationTick = null;
behavior._missileDefenseEvaluationContext = null;
behavior._missileDefenseEvaluationCache = null;
const rawDefenseEvaluation = behavior.legendaryDefenseEvaluation;
behavior.legendaryDefenseEvaluation = (context, options = {}) => {
  if (Object.keys(options).length === 0) evaluationCalls++;
  return rawDefenseEvaluation(context, options);
};
const cachedContext = behavior.getMissileDefenseContext();
behavior.getMissileDefenseEvaluation(cachedContext);
behavior.getMissileDefenseEvaluation(cachedContext);
assert.equal(
  evaluationCalls,
  1,
  "Base missile defense evaluation is reused for the cached context",
);

let rebuiltRoutePath = null;
const cachedRoute = {
  id: "cached-route",
  weapon: UNIT.AtomBomb,
  fromTile: 1,
  targetTile: 9,
  impactTick: 20,
  launchOffset: 0,
  path: [1, 2, 3, 9],
};
behavior.legendaryBuildMissileRoute = (...args) => {
  rebuiltRoutePath = args[7];
  return { id: args[6], path: args[7], samOptions: [] };
};
const rebuiltRoutes = behavior.legendaryRebuildMissileRoutes([cachedRoute], []);
assert.equal(rebuiltRoutes.length, 1, "Cached missile routes can be rebuilt for a new SAM profile");
assert.strictEqual(
  rebuiltRoutePath,
  cachedRoute.path,
  "SAM upgrade evaluation reuses the cached flight path instead of pathfinding again",
);

let pathfinderCalls = 0;
sandbox.UniversalPathFinding = {
  Parabola: () => {
    pathfinderCalls++;
    return { findPath: () => [1, 2, 3, 9] };
  },
};
const pathBehavior = Object.create(sandbox.__StructureBehavior.prototype);
pathBehavior.game = {
  config: () => ({ defaultNukeSpeed: () => 1 }),
};
assert.deepEqual(
  pathBehavior.legendaryNukeFlightPath(1, 9),
  [1, 2, 3, 9],
  "Missile pathfinding returns the planner trajectory",
);
assert.deepEqual(
  pathBehavior.legendaryNukeFlightPath(1, 9),
  [1, 2, 3, 9],
  "Repeated requests return the same missile trajectory",
);
assert.equal(
  pathfinderCalls,
  1,
  "Repeated missile path requests do not rerun the parabola pathfinder",
);

const metricBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const metricSilos = [makeUnit(701, 1), makeUnit(702, 1)];
let metricFlightCalls = 0;
let metricCapacityCalls = 0;
metricBehavior.legendaryFriendlySamProfiles = () => [];
metricBehavior.legendarySiloSlotAvailability = () => [0];
metricBehavior.legendarySiloCooldownTicks = () => 90;
metricBehavior.legendaryNukeFlightTime = () => {
  metricFlightCalls++;
  return 10;
};
metricBehavior.legendaryEnemyMissileLaunchPlan = (silos) =>
  silos.map((silo, index) => ({
    silo,
    launchTick: index,
    flightTicks: 10 + index,
    impactTick: 10 + index,
  }));
metricBehavior.legendaryNukeFlightPath = () => [1, 2, 3];
metricBehavior.legendaryBuildMissileRoute = (
  fromTile,
  targetTile,
  impactTick,
  _samProfiles,
  launchOffset,
  weapon,
  id,
  path,
) => ({
  id,
  weapon,
  fromTile,
  targetTile,
  impactTick,
  launchOffset,
  path,
  samOptions: [],
});
metricBehavior.legendarySamInterceptionCapacity = () => {
  metricCapacityCalls++;
  return 1;
};
const metricPlan = metricBehavior.legendaryMissileSalvoPlan(metricSilos, 1n, 9, 1n, 0n);
assert.equal(
  metricPlan.sourceMetrics.length,
  metricSilos.length,
  "Missile salvo plans expose one source metric per enemy silo",
);
assert.equal(
  metricCapacityCalls,
  metricSilos.length,
  "Each silo interception capacity is calculated once while building a salvo",
);
assert.equal(
  metricFlightCalls,
  0,
  "Salvo source metrics reuse launch-plan flight times instead of pathfinding again",
);

let placementSalvoCalls = 0;
const placementBehavior = Object.create(sandbox.__StructureBehavior.prototype);
placementBehavior.game = {
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
placementBehavior.legendaryCriticalStructureValue = () => 1;
placementBehavior.legendaryEnemyMissileLaunchPlan = () => [
  { silo: metricSilos[0], launchTick: 0, flightTicks: 10, impactTick: 10 },
  { silo: metricSilos[1], launchTick: 1, flightTicks: 11, impactTick: 12 },
];
placementBehavior.legendarySamInterceptionCapacity = () => 1;
placementBehavior.legendarySamCooldownTicks = () => 90;
placementBehavior.legendaryMissileSalvoPlan = () => {
  placementSalvoCalls++;
  throw new Error("placement scoring must not build a full salvo plan");
};
const placementRisk = placementBehavior.legendaryMissilePlacementRisk(5, UNIT.Factory, {
  atomCost: 1n,
  hydrogenCost: 0n,
  atomRadius: 10,
  hydrogenRadius: 20,
  totalValue: 10,
  structures: [makeUnit(1, 1)],
  activeMissiles: [],
  threats: [
    {
      inFlight: false,
      targetTile: 20,
      weapon: UNIT.AtomBomb,
      enemySilos: metricSilos,
      enemyGold: 2n,
      salvoPlan: {
        routes: [{ impactTick: 10 }, { impactTick: 12 }],
        readyShots: 2,
      },
    },
  ],
});
assert.ok(Number.isFinite(placementRisk), "Placement risk remains a finite score");
assert.equal(
  placementSalvoCalls,
  0,
  "Placement ranking uses the lightweight threat proxy instead of rebuilding a salvo scheduler",
);

assert.equal(
  typeof behavior.maybeUpgradeSamForSiloParity,
  "function",
  "Structure behavior exposes the proactive SAM-vs-Silo level upgrade path",
);
assert.equal(
  behavior.ownMaximumSamLevel(),
  1,
  "Only built own SAM levels count toward immediate parity",
);
own.sams = [makeUnit(403, 3), makeUnit(404, 3)];
assert.equal(
  behavior.samLevelParityGap(),
  0,
  "SAM parity uses total own interceptor capacity instead of only the highest SAM",
);
own.sams = [makeUnit(403, 3), makeUnit(404, 2)];
assert.equal(
  behavior.samLevelParityGap(),
  1,
  "SAM parity reports the remaining capacity gap against the strongest hostile network",
);
own.sams = [reactiveSam];
assert.equal(behavior.samLevelParityGap(), 5, "SAM parity reports the missing capacity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "A SAM is upgraded when the strongest hostile Silo network exceeds our own capacity",
);
assert.equal(sentBuilds.length, 1, "Proactive SAM parity emits one upgrade");
own.sams = [makeUnit(402, 6)];
assert.equal(behavior.samLevelParityGap(), 0, "A single SAM at the target level closes SAM parity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not repeat an upgrade once one SAM reaches the target",
);
const originalPlayersForSingleSiloParity = behavior.game.players;
const originalOwnSamsForSingleSiloParity = own.sams;
behavior.game.players = () => [own, enemySingleLevelOneSilo];
own.sams = [makeUnit(408, 1)];
sentBuilds.length = 0;
assert.equal(
  behavior.samLevelParityTarget(),
  1,
  "A single level-1 hostile Silo creates only a level-1 SAM parity target",
);
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "A matching level-1 SAM is not upgraded merely because an enemy owns a Silo",
);
assert.equal(
  sentBuilds.length,
  0,
  "A matching level-1 hostile-Silo parity check emits no upgrade",
);
behavior.game.players = originalPlayersForSingleSiloParity;
own.sams = originalOwnSamsForSingleSiloParity;
own.sams = [makeUnit(405, 3), makeUnit(406, 2), makeUnit(407, 2)];
assert.equal(
  behavior.shouldBuildHostileSiloSam(),
  false,
  "The hostile Silo site floor stops requesting new SAMs once every silo has a defensive site",
);
own.sams = [reactiveSam];
sentBuilds.length = 0;

assert.equal(
  typeof behavior.maybeUpgradeMissileDefenseSam,
  "function",
  "Structure behavior exposes the non-Legendary reactive SAM upgrade path",
);
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  true,
  "A SAM is upgraded when one level turns an unresolved incoming threat into a defended route",
);
assert.equal(sentBuilds.length, 1, "Reactive defense emits exactly one SAM upgrade");
state.settings.buildStructures[UNIT.SAMLauncher] = false;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A user-disabled SAM type is never upgraded by the reactive path",
);
delete state.settings.buildStructures[UNIT.SAMLauncher];
samDisabled = true;
assert.equal(
  await behavior.maybeUpgradeMissileDefenseSam(),
  false,
  "A SAM type disabled by game configuration is never upgraded",
);
samDisabled = false;

// The dedicated hostile-silo SAM path is covered above; the wiring tests can
// now exercise the proactive parity branch before ordinary construction.
const originalMaybeSpawnHostileSiloSam = behavior.maybeSpawnHostileSiloSam;
const originalHydrogenStructureCoverage = behavior.maybeEnsureHydrogenStructureCoverage;
const originalHydrogenSiloUpgrade = behavior.maybeUpgradeHydrogenProtectionSam;
behavior.maybeSpawnHostileSiloSam = async () => false;
let wiredStructureCoverageCalls = 0;
behavior.maybeEnsureHydrogenStructureCoverage = async () => {
  wiredStructureCoverageCalls++;
  return true;
};
behavior.maybeUpgradeHydrogenProtectionSam = async () => false;
let wiredParityCalls = 0;
behavior.maybeUpgradeMissileDefenseSam = async () => false;
behavior.maybeUpgradeSamForSiloParity = async () => {
  wiredParityCalls++;
  return true;
};
behavior.placementsCount = 0;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks proactive SAM/Silo level parity",
);
assert.equal(
  wiredStructureCoverageCalls,
  1,
  "Full structure H-bomb coverage is checked before SAM/Silo parity",
);
assert.equal(wiredParityCalls, 0, "Higher-priority structure coverage stops lower priorities");

behavior.maybeEnsureHydrogenStructureCoverage = async () => false;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks proactive SAM/Silo level parity",
);
assert.equal(wiredParityCalls, 1, "The proactive SAM parity path is wired into handleStructures");

let wiredUpgradeCalls = 0;
behavior.maybeUpgradeMissileDefenseSam = async () => {
  wiredUpgradeCalls++;
  return true;
};
behavior.placementsCount = 0;
assert.equal(
  await behavior.handleStructures(),
  true,
  "Non-Legendary structure handling checks reactive SAM upgrades before ordinary construction",
);
assert.equal(wiredUpgradeCalls, 1, "The reactive SAM path is wired into handleStructures");
behavior.maybeSpawnHostileSiloSam = originalMaybeSpawnHostileSiloSam;
behavior.maybeEnsureHydrogenStructureCoverage = originalHydrogenStructureCoverage;
behavior.maybeUpgradeHydrogenProtectionSam = originalHydrogenSiloUpgrade;

console.log("SAM DEFENSE POLICY TESTS OK");
