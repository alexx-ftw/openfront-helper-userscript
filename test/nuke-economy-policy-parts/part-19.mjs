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
  ticks: () => 124,
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
let staleNukeTargetAlive = true;
const staleNukeTarget = {
  smallID: () => 8,
  type: () => "Human",
  isAlive: () => staleNukeTargetAlive,
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
  shouldAttack: () => true,
};
sandbox.sendAutoBotBuildOrUpgrade = () => {
  nukeBuilds += 1;
  return true;
};
assert.equal(staleNukeBehavior.isEligibleNukeTarget(staleNukeTarget), true);
const pendingStaleNuke = staleNukeBehavior.sendNuke(12, UNIT.AtomBomb, staleNukeTarget);
staleNukeTargetAlive = false;
resolveNukeProbe([{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }]);
await pendingStaleNuke;
assert.equal(nukeBuilds, 0, "a target that becomes invalid during the worker probe is not nuked");

let scheduledTick = 600;
const scheduledBuilds = [];
sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
  scheduledBuilds.push({ tick: scheduledTick, type: buildable.type, tile });
  return true;
};
const scheduledSilo = {
  id: () => "silo-1",
  tile: () => 0,
  level: () => 1,
  isActive: () => true,
  isUnderConstruction: () => false,
  ticksLeftInCooldown: () => 0,
  missileTimerQueue: () => [],
};
const scheduledPlayer = {
  smallID: () => 1,
  isOnSameTeam: () => false,
  buildables: async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true, canUpgrade: false }],
  gold: () => 10n,
  units: (type) => (type === UNIT.MissileSilo ? [scheduledSilo] : []),
};
const scheduledTarget = {
  smallID: () => 2,
  isAlive: () => true,
};
const scheduledSalvoBehavior = new sandbox.__NukeBehavior(
  { chance: () => false },
  { ticks: () => scheduledTick, manhattanDist: () => 1 },
  scheduledPlayer,
  { shouldAttack: () => true },
  { maybeSendEmoji() {} },
);
scheduledSalvoBehavior.cost = async () => 1n;
scheduledSalvoBehavior.isTrajectoryInterceptableBySam = () => false;
