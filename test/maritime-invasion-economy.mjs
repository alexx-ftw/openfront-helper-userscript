import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

assert.match(
  read("engine/ingame/auto-bot/warshipBehavior.js"),
  /random\.chance\(2\)/,
  "the normal first-Warship roll uses the Random chance denominator for 50%, not 2%",
);

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  TransportShip: "Transport",
  TradeShip: "Trade",
  Warship: "Warship",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
};

const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

function makeStructureSandbox() {
  const state = {
    settings: {
      winFixes: true,
      features: { warship: true },
      warshipAutoSpawn: true,
      buildStructures: { [UNIT.Port]: true },
    },
    stats: { builds: 0 },
  };
  const sandbox = {
    UNIT,
    Difficulty,
    GameMode: { Team: "Team", FFA: "FFA" },
    PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
    state,
    currentDifficulty: () => Difficulty.Impossible,
    isLegendaryDifficulty: (difficulty = Difficulty.Impossible) =>
      difficulty === Difficulty.Legendary,
    isAtLeastHardDifficulty: (difficulty) =>
      difficulty === Difficulty.Hard ||
      difficulty === Difficulty.Impossible ||
      difficulty === Difficulty.Legendary,
    getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
    sendAutoBotBuildOrUpgrade: (menu, buildable, tile) => {
      menu.sendBuildOrUpgrade(buildable, tile);
      return true;
    },
    setLastAction() {},
    tr: (value) => value,
    console,
    window: {},
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    `${readLegendaryPlannerSource()}\n${readStructureBehaviorSource()}\nglobalThis.__StructureBehavior = StructureBehavior;`,
    sandbox,
    { filename: "maritime-invasion-economy-structure.vm.js" },
  );
  return { sandbox, state };
}

const { sandbox: structureSandbox } = makeStructureSandbox();
let invasionSignal = { active: true, troops: 1200 };
structureSandbox.window.__OFH_getIncomingMaritimeTransport = () => invasionSignal;
structureSandbox.window.__OFH_getIncomingMaritimeInvasion = () => ({
  active: true,
  reason: "incoming-attack",
});

const structureBehavior = Object.create(structureSandbox.__StructureBehavior.prototype);
let disabledStructureType = null;
structureBehavior.game = {
  config: () => ({ isUnitDisabled: (type) => type === disabledStructureType }),
};
structureBehavior.hasOceanPortTiles = () => true;
structureBehavior.spendableConstructionGold = () => 2_000_000n;
structureBehavior.getConstructionCost = () => 1_000_000n;
const structureBuildCalls = [];
structureBehavior.maybeSpawnStructure = async (...args) => {
  structureBuildCalls.push(args);
  return true;
};

structureBehavior.player = {
  units: () => [],
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  true,
  "an active maritime invasion consumes the structure decision",
);
assert.equal(structureBuildCalls.length, 1, "the emergency structure emits one build");
assert.equal(structureBuildCalls[0][0], UNIT.Port, "the emergency build is a Port");
assert.equal(
  structureBuildCalls[0][1].forceNewStructure,
  true,
  "the emergency Port build bypasses ordinary structure pacing",
);

structureBuildCalls.length = 0;
structureBehavior.player = {
  units: (type) => (type === UNIT.Port ? [{ isUnderConstruction: () => true }] : []),
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  true,
  "an unfinished Port keeps the emergency construction reservation",
);
assert.equal(
  structureBuildCalls.length,
  0,
  "an existing Port under construction is not duplicated",
);

structureBehavior.player = {
  units: (type) => (type === UNIT.Port ? [{ isUnderConstruction: () => false }] : []),
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  true,
  "a completed Port reserves one construction slot until the first Warship starts",
);
assert.equal(structureBuildCalls.length, 0, "a completed Port does not trigger a second Port");

structureBehavior.player = {
  units: (type) => {
    if (type === UNIT.Port) return [{ isUnderConstruction: () => false }];
    if (type === UNIT.Warship) return [{ isUnderConstruction: () => true }];
    return [];
  },
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "ordinary construction resumes once the first Warship is already being built",
);

structureBehavior.player = {
  units: (type) => {
    if (type === UNIT.Port) return [{ isUnderConstruction: () => true }];
    if (type === UNIT.Warship) return [{ isUnderConstruction: () => false }];
    return [];
  },
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "an existing Warship outranks an additional Port still under construction",
);

structureBehavior.player = { units: () => [] };
structureBehavior.maybeSpawnStructure = async (...args) => {
  structureBuildCalls.push(args);
  return false;
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "an affordable Port placement failure falls through to ordinary construction",
);

structureBehavior.spendableConstructionGold = () => 500_000n;
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  true,
  "an unaffordable emergency Port reserves its gold instead of spending it elsewhere",
);
structureBehavior.spendableConstructionGold = () => 2_000_000n;

structureSandbox.state.settings.features.warship = false;
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "a disabled Warship automation cannot reserve every ordinary construction slot",
);

const fullStructureLivenessBehavior = Object.create(structureSandbox.__StructureBehavior.prototype);
fullStructureLivenessBehavior.player = {
  gold: () => 2_000_000n,
  units: () => [],
};
fullStructureLivenessBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
fullStructureLivenessBehavior.maybeUpgradeMissileDefenseSam = async () => false;
fullStructureLivenessBehavior.hasPriorStructureForDefensePost = () => false;
fullStructureLivenessBehavior.maybeEnsureHydrogenStructureCoverage = async () => false;
fullStructureLivenessBehavior.maybeUpgradeHydrogenProtectionSam = async () => false;
fullStructureLivenessBehavior.maybeUpgradeSiloForNukeDemand = async () => false;
fullStructureLivenessBehavior.maybeSpawnHostileSiloSam = async () => false;
fullStructureLivenessBehavior.maybeUpgradeSamForSiloParity = async () => false;
fullStructureLivenessBehavior.samLevelParityGap = () => 0;
fullStructureLivenessBehavior.isInPostSaveUpBlockedPhase = () => false;
fullStructureLivenessBehavior.placementsCount = 0;
let ordinaryStructurePlannerCalls = 0;
fullStructureLivenessBehavior.doHandleStructures = async () => {
  ordinaryStructurePlannerCalls++;
  return true;
};
assert.equal(
  await fullStructureLivenessBehavior.handleStructures(),
  true,
  "2MM gold with no SAM or Silo still reaches productive construction during an unusable maritime signal",
);
assert.equal(
  ordinaryStructurePlannerCalls,
  1,
  "the maritime signal cannot starve the ordinary structure planner",
);
structureSandbox.state.settings.features.warship = true;

structureSandbox.state.settings.warshipAutoSpawn = false;
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "disabled Warship auto-spawn cannot reserve ordinary construction",
);
structureSandbox.state.settings.warshipAutoSpawn = true;

disabledStructureType = UNIT.Warship;
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "a game-disabled Warship cannot reserve ordinary construction",
);
disabledStructureType = null;

invasionSignal = { active: false, troops: 0 };
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  false,
  "ordinary construction resumes after the maritime threat clears",
);

const warshipSandbox = {
  UNIT,
  Difficulty,
  GameMode: { Team: "Team", FFA: "FFA" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  state: {
    settings: { winFixes: true, warshipAutoSpawn: true },
    stats: { builds: 0 },
  },
  WORKER_TIMEOUT_MS: 100,
  withTimeout: async (promise) => promise,
  getBuildMenu: null,
  sendAutoBotBuildOrUpgrade: (menu, buildable, tile) => {
    menu.sendBuildOrUpgrade(buildable, tile);
    return true;
  },
  setLastAction() {},
  tr: (value) => value,
  console,
  window: {
    __OFH_getIncomingMaritimeTransport: () => ({ active: true, troops: 1200 }),
    __OFH_getIncomingMaritimeInvasion: () => ({ active: true, troops: 1200 }),
  },
};
warshipSandbox.globalThis = warshipSandbox;
const warshipBuilds = [];
warshipSandbox.getBuildMenu = () => ({
  sendBuildOrUpgrade: (...args) => warshipBuilds.push(args),
});
executeClassicScript(
  `${read("engine/ingame/auto-bot/naval-interception.js")}\n${read(
    "engine/ingame/auto-bot/warshipBehavior.js",
  )}\nglobalThis.__WarshipBehavior = WarshipBehavior;`,
  warshipSandbox,
  { filename: "maritime-invasion-economy-warship.vm.js" },
);

let randomChanceCalls = 0;
const lateInterceptor = Object.create(warshipSandbox.__WarshipBehavior.prototype);
lateInterceptor.buildableWarship = async () => ({ type: UNIT.Warship, canBuild: 100 });
lateInterceptor.waterDistance = (from, to) => Math.abs(from - to);
lateInterceptor.interceptionRoute = (from, to) =>
  Array.from(
    { length: Math.abs(from - to) + 1 },
    (_, index) => from + Math.sign(to - from) * index,
  );
const lateFallback = await lateInterceptor.evaluateInterceptorBuild(
  100,
  { id: 1, path: [0, 1, 2] },
  {
    boatSpeed: 1,
    warshipSpeed: 1,
    attackRange: 1,
  },
);
assert.ok(lateFallback, "the planner-unassigned hull stays emergency-eligible as a fallback");
assert.equal(lateFallback.score[0], 0, "the unassigned fallback scores below a planner assignment");
assert.equal(lateFallback.score[2], -1, "the unassigned fallback scores by spawn distance");
let warshipTick = 7;
warshipSandbox.performance = { now: () => warshipTick * 1000 };
let visibleWarships = [];
const warshipBehavior = Object.create(warshipSandbox.__WarshipBehavior.prototype);
warshipBehavior.random = {
  chance: () => {
    randomChanceCalls++;
    return false;
  },
  randElement: (items) => items[0],
};
warshipBehavior.game = {
  ticks: () => warshipTick,
  config: () => ({ isUnitDisabled: () => false }),
};
warshipBehavior.player = {
  units: (type) => {
    if (type === UNIT.Port) return [{ isUnderConstruction: () => false, tile: () => 10 }];
    if (type === UNIT.Warship) return visibleWarships;
    return [];
  },
  unitsOwned: () => 0,
  gold: () => 250000n,
};
warshipBehavior.cost = () => 250000n;
warshipBehavior.dealtWithTransportShip = new Set();
warshipBehavior.incomingNavalTransports = () => [{ id: () => "incoming" }];
warshipBehavior.engineTargetableTransports = () => [];
warshipBehavior.incomingNavalInvasions = () => [
  {
    id: "incoming",
    path: Array.from({ length: 20 }, (_, i) => 55 - i),
  },
];
warshipBehavior.interceptionBuildCandidates = () => [55];
warshipBehavior.movementSpeed = () => 1;
warshipBehavior.warshipAttackRange = () => 1;
warshipBehavior.interceptionRoute = lateInterceptor.interceptionRoute;
warshipBehavior.waterDistance = lateInterceptor.waterDistance;
warshipBehavior.warshipSpawnTile = () => 55;
warshipBehavior.buildableWarship = async () => ({
  type: UNIT.Warship,
  canBuild: 44,
});
let firstSamReserveActive = true;
let offensiveReserveActive = true;
warshipBehavior.structureBehavior = {
  shouldDeferWarshipForFirstSam: () => firstSamReserveActive,
  shouldDeferOffensiveWarship: () => offensiveReserveActive,
};

const richAutoBot = Object.create(warshipSandbox.__WarshipBehavior.prototype);
const richAutoBotPlayer = {
  id: () => "auto-bot",
  type: () => warshipSandbox.PlayerType.Human,
  team: () => 7,
  gold: () => 900000n,
};
richAutoBot.player = richAutoBotPlayer;
richAutoBot.game = {
  players: () => [
    richAutoBotPlayer,
    {
      id: () => "human-teammate",
      type: () => warshipSandbox.PlayerType.Human,
      team: () => 7,
      gold: () => 1000000n,
    },
    {
      id: () => "nation-teammate",
      type: () => warshipSandbox.PlayerType.Nation,
      team: () => 7,
      gold: () => 100000n,
    },
  ],
};
assert.equal(
  richAutoBot.isRichPlayer(true),
  true,
  "the automated client remains eligible for rich-player naval defense while other Humans stay excluded",
);

assert.equal(
  await warshipBehavior.maybeSpawnWarship(),
  false,
  "a maritime emergency cannot spend the hard reserve for the first SAM",
);
assert.equal(randomChanceCalls, 0, "the nuclear reserve stops the Warship before its random roll");
assert.equal(warshipBuilds.length, 0, "the reserved SAM gold is not exported into a Warship");
assert.equal(
  warshipBehavior.tryEmitWarshipBuild(
    { type: UNIT.Warship, canBuild: 44 },
    55,
    "counter",
    "counter",
  ),
  false,
  "the common emitter blocks counter, retaliation, and interceptor paths while the first SAM reserve is active",
);
assert.equal(warshipBuilds.length, 0, "no direct Warship path can bypass the first-SAM reserve");

firstSamReserveActive = false;
await warshipBehavior._retaliateBuildAsync(56, {}, "trade");
assert.equal(
  warshipBuilds.length,
  0,
  "routine retaliation cannot consume gold reserved for the construction portfolio",
);
offensiveReserveActive = false;
const catchableInvasions = warshipBehavior.incomingNavalInvasions;
warshipTick += 2;
assert.equal(
  await warshipBehavior.maybeSpawnWarship(),
  true,
  "an inbound invasion forces the first destroyer build",
);
assert.equal(randomChanceCalls, 0, "the emergency path bypasses the random spawn roll");
assert.equal(warshipBuilds.length, 1, "the emergency path emits one destroyer build");
assert.equal(warshipBuilds[0][0].type, UNIT.Warship, "the buildable is a Warship");
assert.equal(warshipBuilds[0][0].canBuild, 44, "the Warship keeps its port spawn tile");
assert.equal(warshipBuilds[0][1], 55, "the build menu receives the water target tile");

warshipBehavior.incomingNavalInvasions = catchableInvasions;

warshipTick++;
await warshipBehavior._retaliateBuildAsync(56, {}, "trade");
await warshipBehavior.buildCounterWarship({ warship: { tile: () => 57 } });
assert.equal(
  await warshipBehavior.buildInterceptorForInvasion({}, 1, 1, 1),
  false,
  "interception builds share the pending Warship reservation",
);
assert.equal(
  warshipBuilds.length,
  1,
  "retaliation, counter, and interception paths cannot race the pending build",
);
assert.equal(
  await warshipBehavior.maybeSpawnWarship(),
  false,
  "a lagging unit snapshot cannot emit a duplicate Warship on the next tick",
);
assert.equal(warshipBuilds.length, 1, "the pending Warship intent owns the build slot");
assert.equal(warshipSandbox.state.stats.builds, 1, "a duplicate attempt does not inflate stats");

warshipTick += 6;
assert.equal(
  await warshipBehavior.maybeSpawnWarship(),
  true,
  "a build that never materializes is retried after the six-tick grace",
);
assert.equal(warshipBuilds.length, 2, "the failed build intent releases exactly once");

visibleWarships = [{ id: () => 91, isUnderConstruction: () => true }];
warshipTick++;
assert.equal(
  await warshipBehavior.maybeSpawnWarship(),
  false,
  "an under-construction Warship reconciles the pending build as accepted",
);
assert.equal(warshipBuilds.length, 2, "a visible pending Warship prevents another build");
assert.equal(
  warshipBehavior.tryEmitWarshipBuild(
    { type: UNIT.Warship, canBuild: 45 },
    58,
    "intercept another invasion",
    "interception",
  ),
  true,
  "a distinct uncovered invasion may build after the first Warship materializes",
);
assert.equal(warshipBuilds.length, 3, "accepted construction releases the shared reservation");

// A fresh invasion the planner cannot assign still spawns the distance-scored
// fallback destroyer: refusing every unassigned hull left invasions unopposed
// (measured team-basket regression, 2026-09-11).
warshipBehavior.incomingNavalInvasions = () => [{ id: "incoming-late", path: [0, 1, 2] }];
warshipTick += 3;
warshipBehavior.ensureSmartState().pendingInvasionBuilds.clear();
warshipBehavior.ensureSmartState().pendingWarshipBuild = null;
warshipBehavior.ensureSmartState().lastInvasionBuildTick = -1;
assert.equal(
  await warshipBehavior.buildInterceptorForInvasion(
    { id: "incoming-late", path: [0, 1, 2] },
    1,
    1,
    1,
  ),
  true,
  "the fallback interceptor is emitted for a planner-unassigned invasion",
);

process.stdout.write("maritime invasion economy tests passed\n");
