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
console.warn("initial silo naval gate tests passed");
