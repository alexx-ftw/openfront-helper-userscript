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
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(201, 3), makeUnit(202, 1)] : []),
};
const enemyB = {
  smallID: () => 3,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(301, 2), makeUnit(302, 2), makeUnit(303, 2)] : [],
};
const enemyC = {
  smallID: () => 4,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(401, 9, { underConstruction: true })] : [],
};
const enemyTeam = {
  smallID: () => 5,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(501, 12)] : []),
};
const enemySilos = {
  smallID: () => 6,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(601, 4), makeUnit(602, 2)] : []),
};
const enemySiloUnderConstruction = {
  smallID: () => 7,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) =>
    type === UNIT.MissileSilo ? [makeUnit(701, 99, { underConstruction: true })] : [],
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
  }),
};

assert.equal(
  typeof behavior.enemySamCapacityParityTarget,
  "function",
  "Structure behavior exposes the hostile SAM parity target",
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
assert.equal(behavior.samLevelParityGap(), 5, "SAM parity reports the missing level gap");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  true,
  "A SAM is upgraded when the strongest hostile Silo level sum exceeds our highest SAM",
);
assert.equal(sentBuilds.length, 1, "Proactive SAM parity emits one upgrade");
own.sams = [makeUnit(402, 6)];
assert.equal(behavior.samLevelParityGap(), 0, "A single SAM at the target level closes SAM parity");
assert.equal(
  await behavior.maybeUpgradeSamForSiloParity(),
  false,
  "SAM parity does not repeat an upgrade once one SAM reaches the target",
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

console.log("SAM DEFENSE POLICY TESTS OK");
