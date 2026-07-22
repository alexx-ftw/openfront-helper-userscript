import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
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

executeClassicScript(`${source}\nglobalThis.__NukeBehavior = NukeBehavior;`, sandbox, {
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

behavior.structureBehavior = {
  hasActiveMaritimeInvasion: () => true,
  shouldDeferOffensiveNuke: () => false,
};
behavior.isUnderHeavyAttack = () => true;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  true,
  "a maritime invasion reserves gold even when the ordinary nuke path is urgent",
);

behavior.structureBehavior = null;
assert.equal(
  behavior.shouldDeferNukeForEconomy(target, 5_000_000n),
  false,
  "The nuke behavior remains compatible when no structure policy is wired",
);

delete behavior.isUnderHeavyAttack;
behavior.player = {
  troops: () => 100,
  incomingAttacks: () => [
    { troops: () => 80, retreating: () => false },
    { troops: () => 900, retreating: () => true },
    { troops: () => 700, retreating: true },
  ],
};
assert.equal(
  behavior.isUnderHeavyAttack(),
  false,
  "cancelled method and boolean waves cannot trigger emergency nuke spending",
);
behavior.player.incomingAttacks = () => [
  { troops: () => 60, retreating: () => false },
  { troops: () => 40, retreating: false },
];
assert.equal(
  behavior.isUnderHeavyAttack(),
  true,
  "simultaneous live waves still aggregate into genuine heavy pressure",
);

const teammateTarget = { smallID: () => 73 };
const teammate = {
  smallID: () => 2,
  isAlive: () => true,
  targets: () => [teammateTarget],
};
const deadTeammate = {
  smallID: () => 3,
  isAlive: () => false,
  targets: () => [{ smallID: () => 74 }],
};
const me = {
  smallID: () => 1,
  isFriendly: (other) => other === teammate,
  // Engine Player.allies() deliberately omits permanent teammates.
  allies: () => [],
  targets: () => [],
};
behavior.player = me;
behavior.game = { players: () => [me, deadTeammate, teammate] };
assert.equal(
  behavior.findAllyNukeTarget(),
  teammateTarget,
  "nuclear targeting supports a permanent teammate's marked enemy",
);

let distanceChecks = 0;
behavior.game = {
  config: () => ({ defaultNukeTargetableRange: () => 2 }),
  euclideanDistSquared: (left, right) => {
    distanceChecks += 1;
    return (left - right) ** 2;
  },
};
assert.deepEqual(
  { ...behavior.findUntargetableTrajectoryRange([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0, 10) },
  { start: 3, end: 9 },
  "The trajectory scan finds the bounded mid-air untargetable segment",
);
assert.ok(
  distanceChecks <= 22,
  "The trajectory scan terminates after a bounded number of distance checks",
);

process.stdout.write("nuke economy policy tests passed\n");
