import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

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
    setLastAction() {},
    tr: (value) => value,
    console,
    window: {},
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(
    `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read(
      "engine/ingame/auto-bot/structureBehavior.js",
    )}\nglobalThis.__StructureBehavior = StructureBehavior;`,
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
structureBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
structureBehavior.hasOceanPortTiles = () => true;
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
  units: () => [{ isUnderConstruction: () => true }],
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
  units: () => [{ isUnderConstruction: () => false }],
};
assert.equal(
  await structureBehavior.prioritizeMaritimeInvasionDefense(),
  true,
  "a completed Port keeps other structure spending suppressed",
);
assert.equal(structureBuildCalls.length, 0, "a completed Port does not trigger a second Port");

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
let warshipTick = 7;
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
warshipBehavior.warshipSpawnTile = () => 55;
warshipBehavior.buildableWarship = async () => ({
  type: UNIT.Warship,
  canBuild: 44,
});

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

process.stdout.write("maritime invasion economy tests passed\n");
