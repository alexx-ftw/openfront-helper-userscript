import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nukeBehavior.js"),
  "utf8",
);

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
  MIRVWarhead: "MIRV Warhead",
  TransportShip: "Transport Ship",
  TradeShip: "Trade Ship",
  Warship: "Warship",
};
const sandbox = {
  UNIT,
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true } },
  currentDifficulty: () => "Impossible",
  isAtLeastHardDifficulty: () => true,
  console,
};
sandbox.globalThis = sandbox;

vm.runInNewContext(`${source}\nglobalThis.__NukeBehavior = NukeBehavior;`, sandbox, {
  filename: "nuke-economy-policy.vm.js",
});

const behavior = Object.create(sandbox.__NukeBehavior.prototype);
const target = { smallID: () => 42 };
const policyCalls = [];
behavior.structureBehavior = {
  shouldDeferOffensiveNuke: (cost) => {
    policyCalls.push(cost);
    return true;
  },
};
behavior.attackBehavior = { findIncomingAttackPlayer: () => null };
behavior.isUnderHeavyAttack = () => false;

assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  true,
  "An ordinary offensive nuke yields to the shared economy/defense reserve",
);
assert.deepEqual(
  policyCalls,
  [5_000_000n],
  "The nuke policy receives the selected nuke's actual perceived cost",
);

behavior.isUnderHeavyAttack = () => true;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "A heavy assault keeps the emergency nuke path available",
);

behavior.isUnderHeavyAttack = () => false;
behavior.attackBehavior.findIncomingAttackPlayer = () => ({ smallID: () => 42 });
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "A direct retaliation keeps the nuke path available",
);

behavior.attackBehavior.findIncomingAttackPlayer = () => null;
behavior.structureBehavior.shouldDeferOffensiveNuke = () => false;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "Offensive fire is allowed when the policy reports enough surplus",
);

behavior.structureBehavior = null;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "The nuke behavior remains compatible when no structure policy is wired",
);

console.log("nuke economy policy tests passed");
