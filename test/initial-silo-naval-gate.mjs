import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "engine/ingame/auto-bot/structureBehavior.js");
const sandbox = {
  BigInt,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  Map,
  Math,
  Number,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Set,
  UNIT: {
    AtomBomb: "Atom Bomb",
    City: "City",
    HydrogenBomb: "Hydrogen Bomb",
    MIRV: "MIRV",
    MissileSilo: "Missile Silo",
    Port: "Port",
    SAMLauncher: "SAM Launcher",
    Warship: "Warship",
  },
  state: { settings: { features: { warship: true }, warshipAutoSpawn: true } },
  currentDifficulty: () => "Impossible",
  isLegendaryDifficulty: () => false,
  isAtLeastHardDifficulty: () => true,
  autoBotBuildAllowed: () => true,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: () => true,
  setLastAction() {},
  tr: (value) => value,
  console,
  globalThis: null,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${fs.readFileSync(sourcePath, "utf8")}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  { filename: sourcePath },
);

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
let ports = [];
let warships = [];
behavior.game = { config: () => ({ isUnitDisabled: () => false }) };
behavior.player = {
  units(type) {
    if (type === sandbox.UNIT.Port) return ports;
    if (type === sandbox.UNIT.Warship) return warships;
    return [];
  },
};
behavior.hasOceanPortTiles = () => true;
behavior.hasObservedHostileMissileLaunch = () => false;
behavior.hasBuiltHostileSiloThreat = () => false;

assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  true,
  "a coastal opening keeps silo gold for the first Port",
);
ports = [{ isUnderConstruction: () => true }];
assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  true,
  "a pending Port keeps the first naval unit funded",
);
ports = [{ isUnderConstruction: () => false }];
assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  true,
  "a completed Port keeps the first Warship funded",
);
warships = [{ isUnderConstruction: () => true }];
assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  false,
  "a queued Warship releases the speculative first-silo gate",
);
sandbox.state.settings.warshipAutoSpawn = false;
warships = [];
assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  false,
  "a disabled naval automation never blocks the nuclear opening",
);
sandbox.state.settings.warshipAutoSpawn = true;
behavior.hasBuiltHostileSiloThreat = () => true;
assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  false,
  "a visible hostile silo keeps the nuclear-response path unblocked",
);
behavior.hasBuiltHostileSiloThreat = () => false;
behavior.hasObservedHostileMissileLaunch = () => true;
assert.equal(
  behavior.shouldDeferInitialSiloForNavalOpening(),
  false,
  "an active hostile missile keeps the nuclear-response path unblocked",
);

sandbox.state.settings.winFixes = true;
sandbox.isLegendaryDifficulty = () => false;
behavior.maritimeDefenseConstructionEnabled = () => true;
behavior.ownedLevels = (type) => (type === sandbox.UNIT.City ? 1 : 0);
behavior.getConstructionCost = () => 1n;
behavior.spendableConstructionGold = () => 2n;
behavior.game = {
  config: () => ({
    isUnitDisabled: () => false,
    spawnImmunityDuration: () => 0,
  }),
  ticks: () => 3000,
};
behavior.hasObservedHostileMissileLaunch = () => false;
behavior.hasBuiltHostileSiloThreat = () => false;
behavior.game.ticks = () => 2999;
const coastalSiloAttempts = [];
behavior.maybeSpawnStructure = async (type) => {
  coastalSiloAttempts.push(type);
  return true;
};
assert.equal(
  await behavior.handleInitialMissileSilo(false),
  false,
  "the actual first-Silo handler keeps coastal gold for the naval opening",
);
assert.deepEqual(coastalSiloAttempts, [], "a deferred coastal opening makes no Silo attempt");

// The coastal deferral is bounded by the same 3000-tick backstop as the
// landlocked Arsenal: a completed Port with no Warship releases the first
// Silo instead of holding the nuclear lane forever.
behavior.game.ticks = () => 3000;
assert.equal(
  await behavior.handleInitialMissileSilo(false),
  true,
  "the coastal backstop releases the first Silo after tick 3000",
);
assert.deepEqual(
  coastalSiloAttempts,
  [sandbox.UNIT.MissileSilo],
  "the backstop release reaches the real first-Silo placement call",
);
coastalSiloAttempts.length = 0;
behavior.hasBuiltHostileSiloThreat = () => true;
assert.equal(
  await behavior.handleInitialMissileSilo(false),
  true,
  "an actual hostile-Silo threat bypasses the coastal opening deferral",
);
assert.deepEqual(
  coastalSiloAttempts,
  [sandbox.UNIT.MissileSilo],
  "the threat bypass reaches the real first-Silo placement call",
);
behavior.hasBuiltHostileSiloThreat = () => false;
sandbox.state.settings.winFixes = false;

// Landlocked arsenal backstop: a spawn with no ocean port tiles must open
// the first-silo lane once the 3000-tick backstop expires (the same
// backstop the big-start deferral already uses). Luna interior seeds went
// the whole match without a silo because this lane never opened.
behavior.hasOceanPortTiles = () => false;
behavior.game = {
  config: () => ({ isUnitDisabled: () => false, spawnImmunityDuration: () => 0 }),
  ticks: () => 2999,
};
behavior.legendarySamBaselineChestActive = () => false;
behavior.legendaryMissileDefenseUrgent = () => false;
behavior.safeConstructionCost = () => 1n;
behavior.spendableConstructionGold = () => 2n;
const arsenalSpawns = [];
behavior.maybeSpawnStructure = async (type) => {
  arsenalSpawns.push(type);
  return true;
};
const landlockedArsenal = {
  config: { isUnitDisabled: () => false },
  cityCount: 1,
  hasOceanPortTiles: false,
  missileSilosEnabled: true,
  nukesEnabled: true,
};
assert.equal(
  await behavior.maybeOpenLegendaryArsenal(landlockedArsenal),
  false,
  "before the backstop a landlocked spawn keeps waiting for a coast",
);
behavior.game.ticks = () => 3000;
assert.equal(
  await behavior.maybeOpenLegendaryArsenal(landlockedArsenal),
  true,
  "after the backstop a one-City landlocked spawn opens the arsenal lane",
);
assert.deepEqual(
  arsenalSpawns,
  [sandbox.UNIT.MissileSilo],
  "the opened lane attempts the speculative first silo",
);
arsenalSpawns.length = 0;
assert.equal(
  await behavior.maybeOpenLegendaryArsenal({
    ...landlockedArsenal,
    cityCount: 1,
    hasOceanPortTiles: true,
  }),
  false,
  "the backstop keeps the two-City requirement on coastal spawns",
);
assert.deepEqual(arsenalSpawns, [], "a coastal one-City spawn does not attempt an early silo");
assert.equal(
  await behavior.maybeOpenLegendaryArsenal({
    ...landlockedArsenal,
    cityCount: 0,
  }),
  false,
  "the landlocked backstop still requires a City",
);
assert.deepEqual(arsenalSpawns, [], "a landlocked spawn without a City does not attempt a silo");

// The ordinary dispatcher must let an inland Legendary spawn reach that
// backstop after it becomes eligible. Testing the inner Arsenal method alone
// misses a coast gate in doHandleStructures.
sandbox.profileStructureSync = (_profile, _name, run) => run();
sandbox.profileStructureAsync = async (_profile, _name, run) => run();
sandbox.isLegendaryDifficulty = (difficulty) => difficulty === "Legendary";
const inlandDispatch = Object.create(sandbox.__StructureBehavior.prototype);
inlandDispatch.legendaryBigStartGame = () => {};
inlandDispatch.structureBuildContext = () => ({
  difficulty: "Legendary",
  cityCount: 1,
  hasOceanPortTiles: false,
  hasCoastalTiles: false,
  missileSilosEnabled: true,
  nukesEnabled: true,
  economyGrowthPriority: false,
});
inlandDispatch.handleOpeningStructurePriorities = async () => false;
inlandDispatch.hasAnyShoreBorderTile = () => false;
inlandDispatch.maybeOpenLegendaryNavalEconomy = async () => false;
inlandDispatch.game = {
  ticks: () => 3000,
  config: () => ({ isUnitDisabled: () => false, spawnImmunityDuration: () => 0 }),
};
inlandDispatch.player = { units: () => [] };
inlandDispatch.legendarySamBaselineChestActive = () => false;
inlandDispatch.legendaryMissileDefenseUrgent = () => false;
inlandDispatch.legendaryBigStartSiloDeferred = () => false;
inlandDispatch.safeConstructionCost = () => 1n;
inlandDispatch.spendableConstructionGold = () => 2n;
const inlandSiloSpawns = [];
inlandDispatch.maybeSpawnStructure = async (type) => {
  inlandSiloSpawns.push(type);
  return true;
};
inlandDispatch.handleMissileSiloParity = async () => false;
inlandDispatch.handleOrdinaryStructurePriorities = async () => false;
assert.equal(
  await inlandDispatch.doHandleStructures(),
  true,
  "the inland Legendary dispatcher reaches the landlocked Silo backstop",
);
assert.deepEqual(
  inlandSiloSpawns,
  [sandbox.UNIT.MissileSilo],
  "the real dispatcher reaches the first-Silo attempt after tick 3000",
);
inlandSiloSpawns.length = 0;
const existingInlandSilo = { isUnderConstruction: () => false };
inlandDispatch.player.units = (type) =>
  type === sandbox.UNIT.MissileSilo ? [existingInlandSilo] : [];
inlandDispatch.hasObservedHostileMissileLaunch = () => false;
inlandDispatch.hasBuiltHostileSiloThreat = () => true;
inlandDispatch.legendaryPeaceWindowSamChestDue = () => false;
assert.equal(
  await inlandDispatch.doHandleStructures(),
  true,
  "the landlocked Arsenal backstop reaches baseline defense when a Silo exists",
);
assert.deepEqual(
  inlandSiloSpawns,
  [sandbox.UNIT.SAMLauncher],
  "a hostile Silo threat makes the real dispatcher attempt a baseline SAM",
);

// First-Silo gold reserve: before any Silo exists (Legendary/winFixes),
// Defense Post budgeting must preserve the silo's construction cost; City
// and Port stay exempt, and the reserve releases once a Silo is live.
sandbox.state.settings.winFixes = true;
sandbox.currentDifficulty = () => "Legendary";
const reserveBot = Object.create(sandbox.__StructureBehavior.prototype);
reserveBot.player = { units: () => [] };
reserveBot.game = { ticks: () => 3000 };
reserveBot.ownedLevels = () => 0;
reserveBot.hasBuiltHostileSiloThreat = () => false;
reserveBot.shouldDeferInitialSiloForNavalOpening = () => false;
reserveBot.safeConstructionCost = (type) =>
  type === sandbox.UNIT.MissileSilo ? 1_000_000n : 50_000n;
reserveBot.spendableConstructionGold = () => 600_000n;
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.DefensePost),
  0n,
  "a Defense Post cannot spend the first Silo's missing gold",
);
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.City),
  600_000n,
  "economic City growth keeps its ordinary budget",
);
let reserveUrgencyChecks = 0;
reserveBot.legendaryMissileDefenseUrgent = () => {
  reserveUrgencyChecks++;
  return false;
};
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.SAMLauncher, {
    includeSam: true,
  }),
  600_000n,
  "the first SAM keeps its ordinary budget",
);
reserveBot.player.units = (type) => (type === sandbox.UNIT.SAMLauncher ? [{}] : []);
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.SAMLauncher),
  600_000n,
  "a SAM upgrade keeps its ordinary budget",
);
reserveBot.economicConstructionPressureForSamUpgrade = () => null;
reserveBot.legendaryPortIncomeFundsSamUpgrades = () => true;
assert.equal(
  reserveBot.samUpgradeEconomyCanAbsorb(50_000n),
  false,
  "a nonurgent SAM upgrade preserves the first Silo's cost even with port income",
);
assert.equal(
  reserveUrgencyChecks,
  0,
  "the speculative SAM-upgrade reserve does not trigger missile trajectory forecasting",
);
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.SAMLauncher, {
    includeSam: true,
  }),
  0n,
  "a nonurgent new SAM preserves the first Silo's cost",
);
reserveBot.legendaryMissileDefenseUrgent = () => true;
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.SAMLauncher, {
    includeSam: true,
  }),
  600_000n,
  "an urgent SAM bypasses the first-Silo reserve",
);
assert.equal(
  reserveBot.samUpgradeEconomyCanAbsorb(50_000n, true),
  true,
  "an urgent SAM upgrade bypasses the first-Silo reserve",
);
reserveBot.player.units = (type) =>
  type === sandbox.UNIT.MissileSilo ? [{ isUnderConstruction: () => false }] : [];
reserveBot.ownedLevels = (type) => (type === sandbox.UNIT.MissileSilo ? 1 : 0);
assert.equal(
  reserveBot.availableGoldAfterReserve(sandbox.UNIT.DefensePost),
  600_000n,
  "the Defense Post gate releases once a Silo is live",
);

// The urgent SAM gets the first probe; if no SAM is built, the guarded Silo
// fallback may proceed instead of freezing the nuclear lane indefinitely.
const urgentAttempts = [];
const urgentPreemptedLanes = [];
const urgentPriority = Object.create(sandbox.__StructureBehavior.prototype);
urgentPriority.debugStructureLaneCount = () => {};
urgentPriority.maybeOpenLegendaryNavalEconomy = async () => {
  urgentPreemptedLanes.push("naval");
  return false;
};
urgentPriority.maybeOpenLegendaryArsenal = async () => {
  urgentPreemptedLanes.push("arsenal");
  return false;
};
urgentPriority.ownSamCapacity = () => 1;
urgentPriority.player = {
  units: (type) => (type === sandbox.UNIT.SAMLauncher ? [{}] : []),
};
urgentPriority.ownedLevels = () => 0;
urgentPriority.maybeSpawnStructure = async (type) => {
  urgentAttempts.push(type);
  return false;
};
urgentPriority.maybeUpgradeLegendarySam = async () => false;
urgentPriority.legendaryMissileDefenseUrgent = () => true;
urgentPriority.maybeOpenLegendaryFirstSilo = async () => {
  urgentAttempts.push(sandbox.UNIT.MissileSilo);
  return false;
};
urgentPriority.maybeArmFreezeStrikeSilo = async () => false;
urgentPriority.maybeUpgradeSiloForNuclearSlotPressure = async () => false;
urgentPriority.maybeUpgradeSiloFromSurplus = async () => false;
urgentPriority.troopCapPressure = () => false;
urgentPriority.legendaryConstructionCandidates = () => [];
urgentPriority.runLegendaryConstructionGroups = async () => false;
assert.equal(
  await urgentPriority.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  }),
  false,
  "a blocked emergency SAM does not let the first-Silo lane consume the slot",
);
assert.deepEqual(
  urgentAttempts,
  [sandbox.UNIT.SAMLauncher, sandbox.UNIT.MissileSilo],
  "the urgent SAM is attempted before the guarded first-Silo fallback",
);
assert.deepEqual(
  urgentPreemptedLanes,
  [],
  "an active missile prevents naval or Arsenal openings from consuming the action",
);

const urgentBaselineAttempts = [];
const urgentBaseline = Object.create(sandbox.__StructureBehavior.prototype);
urgentBaseline.debugStructureLaneCount = () => {};
urgentBaseline.maybeOpenLegendaryNavalEconomy = async () => {
  urgentBaselineAttempts.push("naval");
  return false;
};
urgentBaseline.maybeOpenLegendaryArsenal = async () => {
  urgentBaselineAttempts.push("arsenal");
  return false;
};
urgentBaseline.ownSamCapacity = () => 0;
urgentBaseline.player = { units: () => [] };
urgentBaseline.maybeSpawnHostileSiloSam = async () => {
  urgentBaselineAttempts.push("baseline-SAM");
  return false;
};
urgentBaseline.hostileSiloSamActionBlocked = () => true;
urgentBaseline.maybeUpgradeLegendarySam = async () => false;
urgentBaseline.legendaryMissileDefenseUrgent = () => true;
urgentBaseline.maybeSpawnStructure = async (type) => {
  urgentBaselineAttempts.push(type);
  return false;
};
urgentBaseline.ownedLevels = () => 0;
urgentBaseline.maybeOpenLegendaryFirstSilo = async () => false;
assert.equal(
  await urgentBaseline.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    cityCount: 2,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
  }),
  false,
);
assert.deepEqual(
  urgentBaselineAttempts,
  ["baseline-SAM"],
  "a failed hostile-Silo SAM placement is not probed again in the same decision",
);

// Two existing SAMs do not cap defense: try a third only when its placement
// can improve the active schedule, then allow the guarded first-Silo fallback.
const coveredUrgentAttempts = [];
const coveredUrgentPriority = Object.create(sandbox.__StructureBehavior.prototype);
coveredUrgentPriority.debugStructureLaneCount = () => {};
coveredUrgentPriority.maybeOpenLegendaryNavalEconomy = async () => false;
coveredUrgentPriority.maybeOpenLegendaryArsenal = async () => false;
coveredUrgentPriority.ownSamCapacity = () => 2;
coveredUrgentPriority.player = {
  units: (type) => (type === sandbox.UNIT.SAMLauncher ? [{}, {}] : []),
};
coveredUrgentPriority.ownedLevels = () => 0;
coveredUrgentPriority.maybeSpawnStructure = async (type) => {
  coveredUrgentAttempts.push(type);
  return false;
};
coveredUrgentPriority.maybeUpgradeLegendarySam = async () => false;
coveredUrgentPriority.legendaryMissileDefenseUrgent = () => true;
coveredUrgentPriority.maybeOpenLegendaryFirstSilo = async () => {
  coveredUrgentAttempts.push(sandbox.UNIT.MissileSilo);
  return true;
};
assert.equal(
  await coveredUrgentPriority.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  }),
  true,
  "the first Silo opens after a third SAM has no timely buildable placement",
);
assert.deepEqual(
  coveredUrgentAttempts,
  [sandbox.UNIT.SAMLauncher, sandbox.UNIT.MissileSilo],
  "a third-SAM probe precedes the first-Silo fallback even with two SAMs",
);

const timelyThirdSamAttempts = [];
const timelyThirdSam = Object.create(sandbox.__StructureBehavior.prototype);
timelyThirdSam.debugStructureLaneCount = () => {};
timelyThirdSam.maybeOpenLegendaryNavalEconomy = async () => false;
timelyThirdSam.maybeOpenLegendaryArsenal = async () => false;
timelyThirdSam.ownSamCapacity = () => 2;
timelyThirdSam.player = {
  units: (type) => (type === sandbox.UNIT.SAMLauncher ? [{}, {}] : []),
};
timelyThirdSam.ownedLevels = () => 0;
timelyThirdSam.maybeSpawnStructure = async (type, options) => {
  timelyThirdSamAttempts.push(type);
  timelyThirdSam.options = options;
  return type === sandbox.UNIT.SAMLauncher;
};
timelyThirdSam.maybeUpgradeLegendarySam = async () => false;
timelyThirdSam.legendaryMissileDefenseUrgent = () => true;
assert.equal(
  await timelyThirdSam.doHandleLegendaryStructures({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  }),
  true,
  "a third SAM that can improve the live interception schedule takes priority",
);
assert.deepEqual(timelyThirdSamAttempts, [sandbox.UNIT.SAMLauncher]);
assert.equal(timelyThirdSam.options?.activeMissileDefense, true);
assert.equal(timelyThirdSam.options?.prioritizeStructureCoverage, true);

const guardedArsenal = Object.create(sandbox.__StructureBehavior.prototype);
let guardedArsenalOpenedSilo = false;
guardedArsenal.game = { ticks: () => 0 };
guardedArsenal.player = { units: () => [] };
guardedArsenal.structureConfigDisablesType = () => false;
guardedArsenal.legendaryMissileDefenseUrgent = () => true;
guardedArsenal.maybeOpenLegendaryFirstSilo = async () => {
  guardedArsenalOpenedSilo = true;
  return true;
};
assert.equal(
  await guardedArsenal.maybeOpenLegendaryArsenal({
    config: { isUnitDisabled: () => false },
    cityCount: 2,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
  }),
  false,
  "the Arsenal does not open a first Silo ahead of an urgent interception check",
);
assert.equal(guardedArsenalOpenedSilo, false);

console.warn("first-Silo Defense Post reserve tests passed");
console.warn("initial silo naval gate tests passed");
