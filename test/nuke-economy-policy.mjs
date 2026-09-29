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
const sharedUtilsSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/shared-utils.js"),
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
let testDifficulty = "Impossible";
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
  currentDifficulty: () => testDifficulty,
  isLegendaryDifficulty: (difficulty) =>
    difficulty === "Legendary" || difficulty === "Impossible",
  isAtLeastHardDifficulty: () => true,
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(sharedUtilsSource, sandbox, {
  filename: "shared-utils.vm.js",
});
executeClassicScript(
  `${source}\nglobalThis.__NukeBehavior = NukeBehavior; globalThis.__UniversalPathFinding = UniversalPathFinding;`,
  sandbox,
  {
    filename: "nuke-economy-policy.vm.js",
  },
);

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

const legendaryHydroSpecialist = Object.create(sandbox.__NukeBehavior.prototype);
legendaryHydroSpecialist.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
legendaryHydroSpecialist.player = { gold: () => 1_000_000n };
legendaryHydroSpecialist.isHydroNation = true;
legendaryHydroSpecialist.isUnderHeavyAttack = () => false;
legendaryHydroSpecialist.getPerceivedNukeCost = async (type) =>
  type === UNIT.HydrogenBomb ? 5_000_000n : 750_000n;
testDifficulty = sandbox.Difficulty.Legendary;
const legendaryFallbackNuke = await legendaryHydroSpecialist.selectAffordableNuke();
assert.equal(legendaryFallbackNuke?.type, UNIT.AtomBomb);
assert.equal(
  legendaryFallbackNuke?.cost,
  750_000n,
  "Legendary uses an affordable Atom instead of leaving a ready Silo idle while saving for Hydrogen",
);
testDifficulty = sandbox.Difficulty.Impossible;
// Merged semantics: the atom fallback is now LEGENDARY-ONLY, so the
// Impossible hydro specialist (unaffordable Hydro, no Atom allowed)
// declines to fire rather than leaving a ready Silo idle.
const impossibleFallbackNuke = await legendaryHydroSpecialist.selectAffordableNuke();
assert.equal(impossibleFallbackNuke, null);

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
  allRelationsSorted: () => [{ relation: "Hostile", player: weakerHostileNation }],
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

testDifficulty = sandbox.Difficulty.Impossible;
const coveredNukeSam = {
  isActive: () => true,
  isUnderConstruction: () => false,
};
const defenseFundedNuke = Object.create(sandbox.__NukeBehavior.prototype);
defenseFundedNuke.player = {
  gold: () => 1_000_000n,
  units: (type) => (type === UNIT.SAMLauncher ? [coveredNukeSam] : []),
};
defenseFundedNuke.isHydroNation = false;
defenseFundedNuke.structureBehavior = {
  isBuiltActiveSam: (sam) => !sam.isUnderConstruction() && sam.isActive(),
  hasActiveMaritimeInvasion: () => false,
  offensiveNukeDefenseReserve: () => 250_000n,
  shouldDeferOffensiveNuke: () => true,
};
defenseFundedNuke.isUnderHeavyAttack = () => false;
defenseFundedNuke.isRetaliationNukeTarget = () => false;
assert.equal(
  defenseFundedNuke.shouldDeferNukeForEconomy(target, 750_000n),
  false,
  "a normalized Legendary may spend the economic reserve while keeping the defense reserve funded",
);
defenseFundedNuke.player.gold = () => 999_999n;
assert.equal(
  defenseFundedNuke.shouldDeferNukeForEconomy(target, 750_000n),
  true,
  "the nuke remains deferred when post-launch gold would fall below the defense reserve",
);
defenseFundedNuke.player.gold = () => 1_000_000n;
defenseFundedNuke.player.units = (type) =>
  type === UNIT.SAMLauncher
    ? [{ isActive: () => true, isUnderConstruction: () => true }]
    : [];
assert.equal(
  defenseFundedNuke.shouldDeferNukeForEconomy(target, 750_000n),
  true,
  "the release still requires a completed active SAM",
);
defenseFundedNuke.player.units = (type) =>
  type === UNIT.SAMLauncher ? [coveredNukeSam] : [];
defenseFundedNuke.structureBehavior.hasActiveMaritimeInvasion = () => true;
assert.equal(
  defenseFundedNuke.shouldDeferNukeForEconomy(target, 750_000n),
  true,
  "active maritime pressure keeps the hard defer",
);

testDifficulty = sandbox.Difficulty.Legendary;
const valueGuard = Object.create(sandbox.__NukeBehavior.prototype);
valueGuard.player = { gold: () => 10_000_000n };
valueGuard.game = {
  euclideanDistSquared: () => 0,
  config: () => ({
    nukeMagnitudes: () => ({ outer: 100 }),
  }),
};
valueGuard.isUnderHeavyAttack = () => false;
valueGuard.isRetaliationNukeTarget = () => false;
const cheapTarget = {
  units: () => [{ type: () => UNIT.City, level: () => 1, tile: () => 20 }],
};
valueGuard.nukeStructureValue = () => 25_000;
valueGuard.findEnemySamsCoveringTile = () => [];
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [{ isUnderConstruction: () => false, level: () => 1 }],
  ),
  false,
  "Legendary skips an ordinary nuke whose vulnerable value is below its launch cost",
);
valueGuard.isUnderHeavyAttack = () => true;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  true,
  "heavy defense keeps the emergency nuke path available despite negative value",
);
valueGuard.isUnderHeavyAttack = () => false;
valueGuard.isRetaliationNukeTarget = () => true;
assert.equal(
  await valueGuard.nukeHasPositiveExpectedValue(
    { tile: 10, coveringSamLevels: 0 },
    cheapTarget,
    { type: UNIT.HydrogenBomb, cost: 5_000_000n },
    [],
  ),
  false,
  "plain retaliation no longer bypasses the expected-value guard",
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
  team: () => "blue",
  isAlive: () => true,
  targets: () => [teammateTarget],
};
const deadTeammate = {
  smallID: () => 3,
  team: () => "blue",
  isAlive: () => false,
  targets: () => [{ smallID: () => 74 }],
};
const me = {
  smallID: () => 1,
  team: () => "blue",
  isFriendly: (other) => other?.smallID?.() === 2 || other?.smallID?.() === 4,
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

const breakableAllyTarget = { smallID: () => 75 };
const breakableAlly = {
  smallID: () => 4,
  team: () => null,
  isAlive: () => true,
  targets: () => [breakableAllyTarget],
};
behavior.game = { players: () => [me, breakableAlly, teammate] };
assert.equal(
  behavior.findAllyNukeTarget(),
  teammateTarget,
  "a breakable diplomatic ally is not treated as a permanent nuclear ally",
);

const diplomaticNukeOwner = {
  smallID: () => 2,
  team: () => null,
};
const teamNukeOwner = {
  smallID: () => 3,
  team: () => "blue",
};
behavior.player = {
  smallID: () => 1,
  isFriendly: () => true,
  team: () => null,
};
behavior.game = {
  units: () => [
    {
      owner: () => diplomaticNukeOwner,
      targetTile: () => 0,
      type: () => UNIT.AtomBomb,
    },
  ],
  config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
assert.equal(
  behavior.isTeammateAlreadyNukingThisSpot(0, UNIT.AtomBomb),
  false,
  "a diplomatic ally's nuke does not suppress our overlapping launch",
);
behavior.player.team = () => "blue";
behavior.game.units = () => [
  {
    owner: () => teamNukeOwner,
    targetTile: () => 0,
    type: () => UNIT.AtomBomb,
  },
];
assert.equal(
  behavior.isTeammateAlreadyNukingThisSpot(0, UNIT.AtomBomb),
  true,
  "a permanent teammate's nuke prevents a duplicate overlapping launch",
);

const breakableSamOwner = {
  smallID: () => 4,
  team: () => null,
};
const permanentSamOwner = {
  smallID: () => 5,
  team: () => "blue",
};
const samUnit = (owner, id) => ({
  owner: () => owner,
  id: () => id,
  level: () => 1,
});
const breakableSam = samUnit(breakableSamOwner, "breakable-sam");
const permanentSam = samUnit(permanentSamOwner, "team-sam");
const samRangeGame = {
  config: () => ({
    samRange: () => 10,
    maxSamRange: () => 10,
  }),
  nearbyUnits: () => [{ unit: breakableSam, distSquared: 1 }],
};
behavior.player = me;
behavior.game = samRangeGame;
assert.equal(
  behavior.isHostileSamIntercept({ unit: breakableSam, distSquared: 1 }, new Set()),
  true,
  "a breakable diplomatic ally's SAM can intercept a nuclear trajectory",
);
assert.deepEqual(
  Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  ["breakable-sam"],
  "hostile-SAM search includes a breakable diplomatic ally's SAM",
);
behavior.game = {
  ...samRangeGame,
  nearbyUnits: () => [{ unit: permanentSam, distSquared: 1 }],
};
assert.equal(
  behavior.isHostileSamIntercept({ unit: permanentSam, distSquared: 1 }, new Set()),
  false,
  "a permanent teammate's SAM cannot intercept our nuclear trajectory",
);
assert.deepEqual(
  Array.from(behavior.findEnemySamsCoveringTile(0), (sam) => sam.id()),
  [],
  "hostile-SAM search excludes a permanent teammate's SAM",
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
  units: () => [
    {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileTimerQueue: () => [],
    },
  ],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvBehavior = new sandbox.__MirvBehavior(
  {},
  {
    ticks: () => 123,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  mirvPlayer,
  {
    maybeSendAttackEmoji() {},
    sendEmoji() {},
  },
);
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
  units: () => [
    {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileTimerQueue: () => [],
    },
  ],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const staleMirvBehavior = new sandbox.__MirvBehavior(
  {},
  {
    ticks: () => 124,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  staleMirvPlayer,
  {
    maybeSendAttackEmoji() {},
    sendEmoji() {},
  },
);
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

const timingAwareSam = {
  id: () => "timing-sam",
  level: () => 1,
  tile: () => 10,
  owner: () => ({ smallID: () => 2 }),
};
const timingTrajectory = [0, 6, 7];
let timingSamSpeed = 2;
sandbox.__UniversalPathFinding.Parabola = () => ({
  findPath: () => timingTrajectory,
});
behavior.player = { smallID: () => 1 };
behavior.game = {
  config: () => ({
    defaultNukeSpeed: () => 10,
    defaultNukeTargetableRange: () => 100,
    defaultSamMissileSpeed: () => timingSamSpeed,
    maxSamRange: () => 5,
    samRange: () => 5,
  }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  manhattanDist: (left, right) => Math.abs(left - right),
  nearbyUnits: (tile) => {
    const distSquared = (tile - timingAwareSam.tile()) ** 2;
    return distSquared <= 25 ? [{ unit: timingAwareSam, distSquared }] : [];
  },
};
assert.equal(
  behavior.isTrajectoryInterceptableBySam(0, 7),
  false,
  "a SAM in geometric range cannot intercept when its missile arrives after the final in-flight tick",
);
timingSamSpeed = 4;
assert.equal(
  behavior.isTrajectoryInterceptableBySam(0, 7),
  true,
  "a SAM remains able to intercept when its missile reaches the in-flight tile on the exact same tick",
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

let scheduledTick = 600;
const scheduledBuilds = [];
sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
  scheduledBuilds.push({ tick: scheduledTick, type: buildable.type, tile });
  return true;
};
const scheduledPlayer = {
  smallID: () => 1,
  isOnSameTeam: () => false,
  buildables: async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true, canUpgrade: false }],
  gold: () => 10n,
};
const scheduledTarget = {
  smallID: () => 2,
  isAlive: () => true,
};
const scheduledSalvoBehavior = new sandbox.__NukeBehavior(
  { chance: () => false },
  { ticks: () => scheduledTick },
  scheduledPlayer,
  { shouldAttack: () => true },
  { maybeSendEmoji() {} },
);
scheduledSalvoBehavior.cost = async () => 1n;
scheduledSalvoBehavior.getSamSalvo = () => ({
  bombsToFire: 2,
  waits: [0, 7],
});
const scheduledPlan = {
  targetTile: 20,
  totalBombs: 2,
  coveringSamIds: new Set(["enemy-sam"]),
  siloEntries: [{ silo: { id: () => "silo-1" }, interceptable: false }],
};
sandbox.state.nukeWantSlots = null;
assert.equal(
  await scheduledSalvoBehavior.fireSamSalvo(scheduledPlan, scheduledTarget, 1n),
  true,
  "a valid staggered salvo is accepted as one pending launch plan",
);
assert.deepEqual(
  scheduledBuilds,
  [{ tick: 600, type: UNIT.AtomBomb, tile: 20 }],
  "only the zero-wait bomb launches on the planning tick",
);
assert.equal(
  sandbox.state.nukeWantSlots?.pendingLaunches,
  true,
  "the silo reservation remains active until every delayed bomb is emitted",
);
scheduledTick = 607;
assert.equal(
  await scheduledSalvoBehavior.processPendingNukeLaunches(),
  true,
  "the delayed salvo bomb launches when its exact game tick becomes due",
);
assert.deepEqual(scheduledBuilds, [
  { tick: 600, type: UNIT.AtomBomb, tile: 20 },
  { tick: 607, type: UNIT.AtomBomb, tile: 20 },
]);
assert.equal(sandbox.state.nukeWantSlots, null);

const mirvStateReserve = 987n;
const readyMirvSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
  level: () => 1,
  missileTimerQueue: () => [],
};
const exhaustedMirvSilo = {
  isActive: () => true,
  isUnderConstruction: () => false,
  level: () => 1,
  missileTimerQueue: () => [123],
};
const mirvActuationTarget = {
  id: () => "mirv-actuation-target",
  smallID: () => 9,
  isPlayer: () => true,
  type: () => "Human",
};
const mirvActuationPlayer = {
  smallID: () => 1,
  isFriendly: () => false,
  units: () => [readyMirvSilo],
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvActuationBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 700,
    units: () => [],
    config: () => ({ nukeMagnitudes: () => ({ inner: 10 }) }),
  },
  mirvActuationPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
mirvActuationBehavior.calculateTerritoryCenter = async () => 11;
assert.equal(
  await mirvActuationBehavior.maybeSendMIRV(mirvActuationTarget),
  true,
  "a successful MIRV build intent reports success",
);

const exhaustedMirvPlayer = {
  ...mirvActuationPlayer,
  units: () => [exhaustedMirvSilo],
};
const exhaustedMirvBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 701,
    units: () => [],
    config: () => ({
      isUnitDisabled: () => false,
      nukeMagnitudes: () => ({ inner: 10 }),
    }),
  },
  exhaustedMirvPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await exhaustedMirvBehavior.considerMIRV(),
  false,
  "an exhausted Silo does not claim that MIRV consideration succeeded",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "an exhausted Silo preserves the MIRV reserve state",
);

exhaustedMirvBehavior.teamHasWon = () => true;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await exhaustedMirvBehavior.considerWinFixMIRV(1n),
  false,
  "a secured team victory does not need a ready MIRV slot",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  0n,
  "a secured team victory releases the MIRV reserve even while every Silo reloads",
);

const rejectedProbePlayer = {
  ...mirvActuationPlayer,
  buildables: async () => [{ type: UNIT.MIRV, cost: 1n, canBuild: false }],
};
const rejectedProbeBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 702,
    units: () => [],
    config: () => ({ gameConfig: () => ({ gameMode: "FFA" }) }),
  },
  rejectedProbePlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
rejectedProbeBehavior.calculateTerritoryCenter = async () => 12;
rejectedProbeBehavior.selectWinFixMirvTarget = () => mirvActuationTarget;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await rejectedProbeBehavior.considerWinFixMIRV(1n),
  false,
  "a rejected MIRV probe does not claim that the win-fix launch succeeded",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "a rejected MIRV probe preserves the win-fix MIRV reserve state",
);

const firstEligibleRejectedBehavior = new sandbox.__MirvBehavior(
  { chance: () => false },
  {
    ticks: () => 703,
    units: () => [],
    config: () => ({ gameConfig: () => ({ gameMode: "FFA" }) }),
  },
  rejectedProbePlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
firstEligibleRejectedBehavior.calculateTerritoryCenter = async () => 13;
firstEligibleRejectedBehavior.selectCounterMirvTarget = () => mirvActuationTarget;
firstEligibleRejectedBehavior.selectVictoryDenialTarget = () => null;
firstEligibleRejectedBehavior.selectSteamrollStopTarget = () => null;
sandbox.state.nukeReserveGold = mirvStateReserve;
assert.equal(
  await firstEligibleRejectedBehavior.sendFirstEligibleMIRV(),
  false,
  "the first eligible MIRV path reports false when its probe is rejected",
);
assert.equal(
  sandbox.state.nukeReserveGold,
  mirvStateReserve,
  "a rejected first-eligible MIRV probe preserves decision state",
);

// ── Freeze-giant strike gates (FFA endgame survival lane) ──────────────────
{
  const giant = {
    isPlayer: () => true,
    isAlive: () => true,
    troops: () => 6_000_000,
  };
  const mk = ({ mode = "FFA", tiles = 120_000, troops = 3_000_000, max = 3_200_000, winFixes = true, difficulty = "Legendary" }) => {
    const behavior = Object.create(sandbox.__NukeBehavior.prototype);
    behavior.game = { config: () => ({ gameConfig: () => ({ gameMode: mode }) }), players: () => [giant] };
    behavior.player = {
      numTilesOwned: () => tiles,
      troops: () => troops,
      maxTroops: () => max,
      isFriendly: (o) => o === behavior.player,
    };
    sandbox.state.settings.winFixes = winFixes;
    testDifficulty = difficulty;
    return behavior;
  };
  const fullSignature = mk({});
  assert.equal(fullSignature.freezeGiantStrikeTarget(), giant,
    "the full freeze signature nominates the strongest enemy");
  assert.equal(mk({ tiles: 49_000 }).freezeGiantStrikeTarget(), null,
    "below endgame scale the lane stays dormant");
  assert.equal(mk({ troops: 2_000_000, max: 3_200_000 }).freezeGiantStrikeTarget(), null,
    "an army with growth room keeps its options");
  assert.equal(mk({ troops: 4_500_000 }).freezeGiantStrikeTarget(), null,
    "a non-outmuscling board never strikes first");
  assert.equal(mk({ mode: "Team" }).freezeGiantStrikeTarget(), null,
    "team games keep their coordinated win clock");
  assert.equal(mk({ winFixes: false }).freezeGiantStrikeTarget(), null,
    "the lane is win-fixes gated");
  assert.equal(mk({ difficulty: "Impossible" }).freezeGiantStrikeTarget(), null,
    "the strike is Legendary-only");
  sandbox.state.settings.winFixes = true;
  testDifficulty = "Impossible";
}

// Anti-SAM aim scoring must move the blast center with each candidate.
{
  const aimBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  const structures = [];
  const sam = {
    tile: () => ({ x: 0, y: 0 }),
    type: () => UNIT.SAMLauncher,
    level: () => 1,
    owner: () => ({ units: () => structures }),
  };
  structures.push(sam, {
    tile: () => ({ x: 8, y: 0 }),
    type: () => UNIT.MissileSilo,
    level: () => 1,
  });
  aimBehavior.game = {
    config: () => ({ nukeMagnitudes: () => ({ outer: 5 }) }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    ref: (x, y) => ({ x, y }),
    isValidCoord: () => true,
    euclideanDistSquared: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2,
  };
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 4, y: 0 },
    "aim between the SAM and silo to destroy both, instead of scoring every blast at the SAM",
  );
  aimBehavior.game.config = () => ({ nukeMagnitudes: () => ({ outer: 4 }) });
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 0, y: 0 },
    "the SAM must be strictly inside the blast, not on its indestructible outer boundary",
  );
  structures[1].tile = () => ({ x: 8, y: 8 });
  aimBehavior.game.config = () => ({ nukeMagnitudes: () => ({ outer: 6 }) });
  assert.deepEqual(
    aimBehavior.samSalvoAimTile(sam),
    { x: 4, y: 4 },
    "diagonal aim points use the engine's circular blast rather than Manhattan distance",
  );
}

process.stdout.write("nuke economy policy tests passed\n");
