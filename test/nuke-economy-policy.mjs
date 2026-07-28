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
const mirvSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/mirvBehavior.js"),
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
  Relation: { Hostile: "Hostile" },
  PlayerType: { Bot: "Bot" },
  state: { settings: { winFixes: true }, stats: { nukes: 0 }, recentMirvHits: [] },
  currentDifficulty: () => "Impossible",
  isAtLeastHardDifficulty: () => true,
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(`${source}\nglobalThis.__NukeBehavior = NukeBehavior;`, sandbox, {
  filename: "nuke-economy-policy.vm.js",
});

let mirvBuildTile = null;
Object.assign(sandbox, {
  AllPlayers: {},
  EMOJI_NUKE: [],
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: (_menu, _buildable, tile) => {
    mirvBuildTile = tile;
    return true;
  },
  setLastAction() {},
  tr: (value) => value,
  respondToMIRV() {},
});
executeClassicScript(`${mirvSource}\nglobalThis.__MirvBehavior = MirvBehavior;`, sandbox, {
  filename: "mirv-economy-policy.vm.js",
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

const nukeSelf = {
  smallID: () => 1,
  isOnSameTeam: () => false,
  isFriendly: () => false,
  allRelationsSorted: () => [],
};
const weakerHostileNation = {
  smallID: () => 2,
  isAlive: () => true,
  type: () => sandbox.PlayerType.Bot,
};
const hostileTargetBehavior = Object.create(sandbox.__NukeBehavior.prototype);
hostileTargetBehavior.player = {
  ...nukeSelf,
  allRelationsSorted: () => [
    { relation: "Hostile", player: weakerHostileNation },
  ],
};
hostileTargetBehavior.game = {
  config: () => ({ maxTroops: (player) => (player === nukeSelf ? 200 : 50) }),
};
hostileTargetBehavior.attackBehavior = { shouldAttack: () => true };
assert.equal(
  hostileTargetBehavior.findHostileNukeTarget(),
  weakerHostileNation,
  "a weaker hostile nation remains a valid automatic nuclear target",
);
assert.equal(
  hostileTargetBehavior.isValidNukeTarget(weakerHostileNation),
  true,
  "a hostile Bot-type opponent is eligible when the normal attack policy allows it",
);

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

behavior.player = {
  smallID: () => 1,
  isFriendly: () => true,
};
behavior.game = {
  units: () => [
    {
      owner: () => ({ smallID: () => 2 }),
      targetTile: () => 0,
      type: () => UNIT.AtomBomb,
    },
  ],
  config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
assert.equal(
  behavior.isTeammateAlreadyNukingThisSpot(0, UNIT.AtomBomb),
  true,
  "an allied nuke aimed at valid tile zero prevents a duplicate overlapping launch",
);

const mirvEnemy = {
  id: () => "enemy-2",
  smallID: () => 2,
  isPlayer: () => true,
  type: () => "Human",
};
const mirvPlayer = {
  smallID: () => 1,
  isFriendly: () => false,
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvBehavior = new sandbox.__MirvBehavior({}, { ticks: () => 123 }, mirvPlayer, {
  maybeSendAttackEmoji() {},
  sendEmoji() {},
});
mirvBehavior.calculateTerritoryCenter = async () => 0;
await mirvBehavior.maybeSendMIRV(mirvEnemy);
assert.equal(mirvBuildTile, 0, "a valid territory centre at tile zero still launches the MIRV");
assert.equal(
  sandbox.state.recentMirvHits.at(-1)?.tile,
  0,
  "the tile-zero MIRV impact is retained for the follow-up invasion",
);

mirvPlayer.smallID = () => 1;
const inboundTileZero = new sandbox.__MirvBehavior(
  {},
  {
    hasOwner: () => true,
    owner: () => ({ isPlayer: () => true, smallID: () => 1 }),
  },
  mirvPlayer,
  {},
);
assert.equal(
  inboundTileZero.isInboundMIRVFrom({
    units: () => [{ targetTile: () => 0 }],
  }),
  true,
  "an inbound MIRV aimed at owned tile zero is recognized as a threat",
);

const alliedMirvTarget = {
  smallID: () => 2,
  isPlayer: () => true,
  type: () => "Human",
};
const hostileMirvTarget = {
  smallID: () => 3,
  isPlayer: () => true,
  type: () => "Human",
};
const relationAwareMirvPlayer = {
  smallID: () => 1,
  isFriendly: (player) => player === alliedMirvTarget,
};
const relationAwareMirv = new sandbox.__MirvBehavior(
  {},
  { players: () => [relationAwareMirvPlayer, alliedMirvTarget, hostileMirvTarget] },
  relationAwareMirvPlayer,
  {},
);
assert.deepEqual(
  relationAwareMirv.getValidMirvTargetPlayers(),
  [hostileMirvTarget],
  "MIRV strategy excludes active allies as well as permanent teammates",
);

let mirvTargetFriendly = false;
const staleMirvTarget = {
  id: () => "stale-mirv-target",
  smallID: () => 4,
  isPlayer: () => true,
  type: () => "Human",
};
const staleMirvPlayer = {
  smallID: () => 1,
  isFriendly: () => mirvTargetFriendly,
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const staleMirvBehavior = new sandbox.__MirvBehavior({}, { ticks: () => 124 }, staleMirvPlayer, {
  maybeSendAttackEmoji() {},
  sendEmoji() {},
});
staleMirvBehavior.calculateTerritoryCenter = async () => 7;
mirvBuildTile = null;
const pendingStaleMirv = staleMirvBehavior.maybeSendMIRV(staleMirvTarget);
mirvTargetFriendly = true;
await pendingStaleMirv;
assert.equal(
  mirvBuildTile,
  null,
  "a MIRV target that becomes friendly during async planning is not launched upon",
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

let resolveNukeProbe;
let nukeBuilds = 0;
let nukeTargetStillAttackable = true;
const staleNukeTarget = {
  smallID: () => 8,
  type: () => "Human",
};
const staleNukePlayer = {
  buildables: () =>
    new Promise((resolve) => {
      resolveNukeProbe = resolve;
    }),
  gold: () => 10n,
  isOnSameTeam: () => false,
};
const staleNukeBehavior = Object.create(sandbox.__NukeBehavior.prototype);
staleNukeBehavior.game = { ticks: () => 500 };
staleNukeBehavior.player = staleNukePlayer;
staleNukeBehavior.attackBehavior = {
  shouldAttack: () => nukeTargetStillAttackable,
};
sandbox.sendAutoBotBuildOrUpgrade = () => {
  nukeBuilds += 1;
  return true;
};
const pendingStaleNuke = staleNukeBehavior.sendNuke(12, UNIT.AtomBomb, staleNukeTarget);
nukeTargetStillAttackable = false;
resolveNukeProbe([{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }]);
await pendingStaleNuke;
assert.equal(nukeBuilds, 0, "a target that becomes invalid during the worker probe is not nuked");

process.stdout.write("nuke economy policy tests passed\n");
