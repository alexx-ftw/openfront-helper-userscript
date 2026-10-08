// Mid-flight SAM-salvo re-validation and the friendly-fire blast penalty in
// NukeBehavior. Each block drives the real methods (fireSamSalvo,
// processPendingNukeLaunches, nukeTileScore) against synthetic game/player
// stubs and asserts the observable decision — fire vs abort, positive vs
// negative tile score — matches the documented intent of the enhancement.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  SAMLauncher: "SAM Launcher",
  SAMMissile: "SAMMissile",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
  Warship: "Warship",
};
const launches = [];
let launchSink = null;
let buildMenu = { sendBuildOrUpgrade() {} };
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
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Relation: { Hostile: "Hostile" },
  state: { settings: { winFixes: true }, stats: { nukes: 0, builds: 0 } },
  currentDifficulty: () => "Impossible",
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: (d) => d === "Legendary",
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => buildMenu,
  sendAutoBotBuildOrUpgrade: (menu, buildable, tile) => {
    menu.sendBuildOrUpgrade(buildable, tile);
    if (launchSink) launchSink.push({ type: buildable.type, tile });
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
  EMOJI_NUKE: [],
  closestTwoTiles: (gm, x, y) => ({ x: x[0], y: y[0] }),
  within: (value, min, max) => Math.max(min, Math.min(max, value)),
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(read("engine/ingame/shared-utils.js"), sandbox, {
  filename: "shared-utils.vm.js",
});
executeClassicScript(
  `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read("engine/ingame/auto-bot/structureBehavior.js")}\n${read("engine/ingame/auto-bot/nukeBehavior.js")}\nglobalThis.__NukeBehavior = NukeBehavior; globalThis.__StructureBehavior = StructureBehavior;`,
  sandbox,
  {
    filename: "nuke-salvo-recheck.vm.js",
  },
);

// ── Synthetic salvo world ────────────────────────────────────────────────────
// One hostile player owns the SAMs; `covering` is what game.nearbyUnits reports
// around the plan tile and `targetSams` is the hostile roster the salvo target
// exposes. Both are mutated mid-flight to simulate builds and destruction.
function makeSalvoWorld() {
  const world = { tick: 800, covering: [], targetSams: [] };
  const nukeTarget = {
    smallID: () => 2,
    team: () => null,
    isAlive: () => true,
    units: (type) => (type === UNIT.SAMLauncher ? world.targetSams : []),
  };
  const game = {
    ticks: () => world.tick,
    players: () => [nukeTarget],
    config: () => ({ maxSamRange: () => 150, samRange: () => 150 }),
    nearbyUnits: (_tile, _radius, type) => (type === UNIT.SAMLauncher ? world.covering : []),
  };
  const player = {
    smallID: () => 1,
    team: () => null,
    gold: () => 1_000_000n,
    buildables: async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }],
  };
  const behavior = new sandbox.__NukeBehavior(
    { chance: () => false },
    game,
    player,
    { shouldAttack: () => true },
    { maybeSendEmoji() {} },
  );
  behavior.cost = async () => 1n;
  world.sam = (id, level) => ({
    id: () => id,
    level: () => level,
    tile: () => 20,
    owner: () => nukeTarget,
  });
  return { world, game, player, nukeTarget, behavior };
}

// A worker price probe can outlive the silo snapshot captured before it.
for (const invalidation of ["unchanged", "destroyed", "upgrading"]) {
  const { behavior, player, game, world, nukeTarget } = makeSalvoWorld();
  let active = true;
  let constructing = false;
  const silo = {
    isActive: () => active,
    isUnderConstruction: () => constructing,
    level: () => 3,
    missileTimerQueue: () => [],
    tile: () => 5,
  };
  player.units = (type) => type === UNIT.MissileSilo && active ? [silo] : [];
  world.targetSams = [world.sam(1, 1)];
  game.config = () => ({ defaultNukeSpeed: () => 1, isUnitDisabled: () => false });
  Object.assign(game, {
    x: (tile) => tile,
    y: () => 50,
    height: () => 100,
    ref: (x) => x,
    manhattanDist: (a, b) => Math.abs(a - b),
  });
  behavior.isTrajectoryInterceptableBySam = () => true;
  behavior.cost = async () => {
    if (invalidation === "destroyed") active = false;
    else if (invalidation === "upgrading") constructing = true;
    return 1n;
  };
  behavior.createSamOverwhelmPlan = (_sam, silos) => ({
    capacityMissing: behavior.getAvailableSiloEntries(silos, 20, []).length === 0,
  });
  behavior.rememberFailedSamTarget = (plan) => plan;
  behavior.maybeUpgradeHelpfulSilo = async () => {};
  let salvos = 0;
  behavior.fireSamSalvo = async () => { salvos++; return true; };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(salvos, invalidation === "unchanged" ? 1 : 0,
    `${invalidation} silo eligibility after price await`);
}

// Construction consumes demand before the nuclear decision chain gets to clear it.
for (const change of ["unchanged", "destroyed", "friendly", "during-probe", "replaced-request", "pending-launches"]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  let friendly = false;
  world.covering = [sam];
  world.targetSams = [sam];
  game.config = () => ({ isUnitDisabled: () => false });
  game.units = () => world.covering;
  player.isFriendly = () => friendly;
  player.units = (type) => type === UNIT.AtomBomb ? [{}] : [];
  behavior.rememberFailedSamTarget({
    targetSamId: 77, targetTile: 20, totalBombs: 4, siloEntries: [],
    coveringSamIds: new Set([77]),
  });
  if (change === "destroyed") world.covering = world.targetSams = [];
  if (change === "friendly") friendly = true;
  await behavior.maybeDestroyEnemySam(nukeTarget);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeDemandScopedSilos = () => [{ level: () => 1 }];
  structures.availableGoldAfterReserve = () => 100n;
  structures.safeStructureCost = () => 1n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async () => {
    if (change === "during-probe") world.covering = world.targetSams = [];
    if (change === "replaced-request") sandbox.state.nukeWantSlots = { ...sandbox.state.nukeWantSlots, targetSamId: 88 };
    if (change === "pending-launches") sandbox.state.nukeWantSlots.pendingLaunches = true;
    return [];
  };
  structures.rankNukeDemandSiloUpgrades = () => [{}];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => { upgrades++; return true; };
  await structures.maybeUpgradeSiloForNukeDemand();
  assert.equal(upgrades, change === "unchanged" ? 1 : 0,
    `${change} SAM cannot retain obsolete capacity demand`);
  if (change === "pending-launches") assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
  if (change === "replaced-request") assert.equal(sandbox.state.nukeWantSlots.targetSamId, 88);
  sandbox.state.nukeWantSlots = null;
}

for (const capture of ["hostile", "own-before-due", "own-during-probe", "teammate", "protected", "unowned"]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  player.team = () => "blue";
  const teammate = { isPlayer: () => true, smallID: () => 3, team: () => "blue", isAlive: () => true };
  const protectedPlayer = { isPlayer: () => true, smallID: () => 4, team: () => null, isAlive: () => true };
  const unowned = { isPlayer: () => false };
  let owner = nukeTarget;
  game.owner = () => owner;
  behavior.attackBehavior.shouldAttack = (target) => target.smallID() !== 4;
  assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5), true);
  if (capture === "own-before-due") owner = player;
  const originalProbe = player.buildables;
  player.buildables = async (...args) => {
    if (capture === "own-during-probe") owner = player;
    if (capture === "teammate") owner = teammate;
    if (capture === "protected") owner = protectedPlayer;
    if (capture === "unowned") owner = unowned;
    return originalProbe(...args);
  };
  const emitted = [];
  launchSink = emitted;
  world.tick += 5;
  await behavior.processPendingNukeLaunches();
  const allowed = capture === "hostile" || capture === "unowned";
  assert.equal(emitted.length, allowed ? 1 : 0, `${capture} destination checked at emission`);
  assert.equal(behavior.hasPendingNukeLaunches(), false, `${capture} launch resolved without stale retries`);
  if (!allowed) assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5), false);
  launchSink = null;
}

for (const rejection of ["captured-first", "captured-all", "none"]) {
  const { behavior, game, player, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  const captured = new Set();
  game.owner = (tile) => captured.has(tile) ? player : nukeTarget;
  const probes = new Map();
  player.buildables = async (tile) => {
    probes.set(tile, (probes.get(tile) ?? 0) + 1);
    if (probes.get(tile) === 2 && (rejection === "captured-all" ||
        (rejection === "captured-first" && tile === 20))) captured.add(tile);
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  behavior.nukeHasPositiveExpectedValue = async () => true;
  const emitted = [];
  launchSink = emitted;
  const fired = await behavior.fireLegendaryClearFallthrough(
    [{ tile: 20, value: 100 }, { tile: 30, value: 50 }],
    nukeTarget, { type: UNIT.AtomBomb, cost: 1n }, [],
  );
  assert.equal(fired, rejection !== "captured-all", `${rejection} reports actual dispatch`);
  assert.deepEqual(emitted.map((shot) => shot.tile),
    rejection === "captured-all" ? [] : [rejection === "captured-first" ? 30 : 20],
    `${rejection} preserves the first valid ranked destination`);
  launchSink = null;
}

for (const capture of ["before-due", "poor", "price", "price-poor", "buildable"]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  let owner = capture === "before-due" || capture === "poor" ? player : nukeTarget;
  game.owner = () => owner;
  game.players = () => [nukeTarget];
  game.config = () => ({ isUnitDisabled: () => false });
  player.gold = () => capture === "poor" || capture === "price-poor" ? 0n : 10_000_000n;
  player.units = () => [{ isUnderConstruction: () => false }];
  behavior.findEnemySamsCoveringTile = () => [];
  behavior.getPerceivedNukeCost = async () => {
    if (capture === "price" || capture === "price-poor") owner = player;
    return 5_000_000n;
  };
  const originalProbe = player.buildables;
  player.buildables = async (...args) => {
    if (capture === "buildable") owner = player;
    return originalProbe(...args);
  };
  sandbox.state.postSalvoHydrogen = {
    targetTile: 20,
    dueTick: world.tick + (capture === "before-due" ? 10 : 0),
    targetSmallID: nukeTarget.smallID(),
  };
  const emitted = [];
  launchSink = emitted;
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(emitted.length, 0, `${capture} captured finisher cannot launch`);
  assert.equal(sandbox.state.postSalvoHydrogen, null, `${capture} captured finisher cancelled`);
  launchSink = null;
}

for (const type of [UNIT.AtomBomb, UNIT.HydrogenBomb]) {
  for (const throws of [false, true]) {
    const { behavior } = makeSalvoWorld();
    const emitted = [];
    const failure = new Error("build dispatch failed");
    buildMenu = {
      uiState: { rocketDirectionUp: false },
      sendBuildOrUpgrade(buildable, tile) {
        emitted.push({
          type: buildable.type,
          tile,
          rocketDirectionUp: this.uiState.rocketDirectionUp,
        });
        if (throws) throw failure;
      },
    };
    if (throws) {
      assert.throws(
        () => behavior.emitNukeBuildable({ type }, 20),
        (error) => error === failure,
      );
    } else {
      assert.equal(behavior.emitNukeBuildable({ type }, 20), true);
    }
    assert.deepEqual(
      emitted,
      [{ type, tile: 20, rocketDirectionUp: true }],
      "bot launches must use the same upward arc as their trajectory planner",
    );
    assert.equal(
      buildMenu.uiState.rocketDirectionUp,
      false,
      "bot dispatch must preserve the player's manual trajectory selection even on failure",
    );
  }
}
buildMenu = { sendBuildOrUpgrade() {} };

// A covered candidate requires an actual salvo, not merely enough silo levels.
for (const lane of ["ordinary", "freeze"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("covered-target", 1);
  world.targetSams.push(sam);
  world.covering.push({ unit: sam, distSquared: 0 });
  const silo = { id: () => 7, level: () => 2, isUnderConstruction: () => false };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  game.config = () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    SAMCooldown: () => 300,
    isUnitDisabled: () => false,
  });
  behavior.nukeSpawn = () => 5;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excluded) => !excluded?.has(sam.id());
  behavior.probeCanBuildNuke = async () => true;
  behavior.samSalvoAimTile = () => 20;
  behavior.getAvailableSiloEntries = () => [
    { silo, slots: 2, flightTicks: 20, interceptable: false },
  ];
  const candidates = [{ tile: 20, value: 100 }];
  const selected = { type: UNIT.AtomBomb, cost: 1n };
  const emitted = [];
  launchSink = emitted;
  sandbox.state.nukeWantSlots = null;
  if (lane === "ordinary") {
    await behavior.fireNukeFromCandidates(candidates, nukeTarget, selected, [silo], "Legendary");
  } else {
    behavior.freezeGiantStrikeTarget = () => nukeTarget;
    behavior.selectAffordableNuke = async () => selected;
    behavior.collectCandidatesWithRetry = async () => ({ list: candidates });
    await behavior.maybeFreezeGiantStrike([silo], "Legendary");
  }
  assert.equal(emitted.length, 1, `${lane}: launch the first atom now`);
  assert.equal(
    behavior._pendingNukeLaunches.length,
    1,
    `${lane}: queue the second atom required to overcome one SAM charge`,
  );
  assert.equal(behavior._pendingNukeLaunches[0].salvo.plannedCoveringLevel, 1);
  launchSink = null;
}

const reservation = () => ({
  need: 3,
  at: 800,
  targetTile: 20,
  unblockedSiloIds: [],
  pendingLaunches: true,
});

for (const scenario of [
  "live",
  "destroyed",
  "claimed",
  "other-target",
  "unknown-path",
  "reload",
  "outside-sam",
  "construction",
  "remote-construction",
  "route-construction",
  "insufficient",
]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  world.tick = 805;
  game.config = () => ({
    maxSamRange: () => 5,
    samRange: () => 5,
    SAMCooldown: () => (scenario === "reload" ? 5 : 300),
    defaultNukeTargetableRange: () => 150,
    defaultSamMissileSpeed: () => 2,
  });
  game.manhattanDist = (a, b) => Math.abs(a - b);
  game.euclideanDistSquared = (a, b) => (a - b) ** 2;
  const sam = world.sam("cover", scenario === "insufficient" ? 2 : 1);
  sam.isActive = () => true;
  sam.isUnderConstruction = () => scenario === "construction";
  sam.missileTimerQueue = () => [];
  world.covering = [{ unit: sam, distSquared: 0 }];
  world.targetSams = [sam];
  const missile = {
    id: () => "launched",
    type: () => UNIT.AtomBomb,
    tile: () => 12,
    targetTile: () => (scenario === "other-target" ? 30 : 20),
    isActive: () => scenario !== "destroyed",
    owner: () => player,
  };
  player.units = (type) => (type === UNIT.AtomBomb ? [missile] : []);
  const outsideSam = { ...sam, id: () => "outside", tile: () => 12 };
  const hostileSams = scenario === "outside-sam" ? [outsideSam, sam] : [sam];
  if (scenario === "remote-construction" || scenario === "route-construction") {
    hostileSams.push({
      ...sam,
      id: () => "unfinished",
      tile: () => (scenario === "remote-construction" ? 1000 : 12),
      isUnderConstruction: () => true,
    });
  }
  const interceptors =
    scenario === "claimed" ? [{ isActive: () => true, targetUnit: () => missile }] : [];
  game.units = (type) => {
    if (type === UNIT.SAMLauncher) return hostileSams;
    if (type === UNIT.SAMMissile) return interceptors;
    return [];
  };
  game.motionPlans = () =>
    new Map(
      scenario === "unknown-path"
        ? []
        : [
            [
              "launched",
              {
                startTick: 805,
                ticksPerStep: 1,
                path: new Uint32Array([12, 13, 14, 15, 16, 17, 18, 19]),
              },
            ],
          ],
    );
  behavior.structureBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.structureBehavior.game = game;
  behavior._pendingNukeLaunches = [
    {
      dueTick: 805,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
      salvo: { salvoId: 42, targetTile: 20, targetSamId: "cover", flightTicks: 10 },
    },
  ];
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    scenario === "live" || scenario === "remote-construction",
    `${scenario}: only an unclaimed live missile that consumes covering capacity supports the finisher`,
  );
}

for (const invalidation of ["dead", "teammate"]) {
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  behavior._pendingNukeLaunches = [
    {
      dueTick: 900,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
    },
  ];
  sandbox.state.nukeWantSlots = reservation();
  if (invalidation === "dead") {
    nukeTarget.isAlive = () => false;
  } else {
    player.team = () => "Blue";
    nukeTarget.team = () => "Blue";
  }
  assert.equal(await behavior.processPendingNukeLaunches(), false);
  assert.equal(
    behavior.hasPendingNukeLaunches(),
    false,
    "a future launch against an invalid target must not block new nuclear decisions",
  );
  assert.equal(sandbox.state.nukeWantSlots, null, "cancelled future launches release reservations");
}

// ════════════════════════════════════════════════════════════════════════════
// A spent SAM charge cannot intercept a finisher before its reload deadline.
for (const [flightTicks, dueTick, expectedLaunch] of [
  [10, 805, true],
  [295, 805, false],
  [295, 790, false],
]) {
  const { world, game, nukeTarget, behavior } = makeSalvoWorld();
  world.tick = 805;
  game.config = () => ({ maxSamRange: () => 150, samRange: () => 150, SAMCooldown: () => 300 });
  const sam = world.sam("cooling-sam", 1);
  sam.missileTimerQueue = () => [800];
  world.covering.push({ unit: sam, distSquared: 0 });
  world.targetSams.push(sam);
  behavior._pendingNukeLaunches = [
    {
      dueTick,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
      salvo: { salvoId: 99, targetTile: 20, targetSamId: "cooling-sam", flightTicks },
    },
  ];
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    expectedLaunch,
    "SAM reload timing, not its full level, determines whether the finisher can penetrate",
  );
}

// 1/3. A live salvo carries plan metadata, continues while re-validation
// passes, and aborts when a new covering SAM outruns the remaining atoms
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launchSink = launches;
  const targetSam = world.sam("enemy-sam-1", 1);
  world.covering.push({ unit: targetSam, distSquared: 0 });
  world.targetSams.push(targetSam);
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 5, 10] });
  sandbox.state.nukeWantSlots = null;
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 3,
        coveringSamLevels: 1,
        targetSamId: "enemy-sam-1",
        siloEntries: [],
        launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }, { flightTicks: 20 }],
      },
      nukeTarget,
      1n,
    ),
    true,
    "a valid staggered SAM-overwhelm salvo is accepted",
  );
  assert.deepEqual(
    launches,
    [{ type: UNIT.AtomBomb, tile: 20 }],
    "only the zero-wait bomb launches on the planning tick",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 2, "the delayed bombs stay queued");
  const salvoIds = new Set(behavior._pendingNukeLaunches.map((pending) => pending.salvo?.salvoId));
  assert.equal(salvoIds.size, 1, "both delayed entries share a single salvo id");
  for (const pending of behavior._pendingNukeLaunches) {
    assert.ok(pending.salvo, "each delayed salvo entry carries plan metadata");
    assert.equal(pending.salvo.targetTile, 20);
    assert.equal(pending.salvo.targetSamId, "enemy-sam-1");
    assert.equal(pending.salvo.plannedCoveringLevel, 1);
    assert.equal(pending.salvo.flightTicks, 20, "queued launches retain their planned flight time");
  }

  // The level-1 SAM is still beatable by the 2 remaining bombs: the salvo
  // continues through its first delayed bomb.
  world.tick = 805;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the salvo continues when mid-flight re-validation still passes",
  );
  assert.equal(launches.length, 2, "the tick-805 bomb fires after re-validation");
  assert.equal(behavior._pendingNukeLaunches.length, 1, "the tick-810 bomb stays queued");
  assert.notEqual(
    sandbox.state.nukeWantSlots,
    null,
    "the silo reservation survives while the salvo is still in flight",
  );

  // The enemy finishes a NEW covering SAM mid-flight: the level sum is now 4,
  // so penetrating needs 5 bombs, but only the single tick-810 atom remains.
  world.covering.push({ unit: world.sam("enemy-sam-2", 3), distSquared: 0 });
  world.tick = 810;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "a salvo that can no longer penetrate reports no launch",
  );
  assert.equal(
    launches.length,
    2,
    "the remaining atom is dropped instead of being wasted on certain interception",
  );
  assert.equal(
    behavior._pendingNukeLaunches.length,
    0,
    "the aborted salvo's last entry is removed",
  );
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "aborting the final pending launch releases the silo reservation",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. A salvo whose target SAM is already destroyed (with no remaining enemy
// coverage at the tile) aborts as overkill — unless the SAM still exists
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 1,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "destroyed-sam",
    }),
    true,
    "the remaining salvo bomb is queued",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 805;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "a salvo over a destroyed target SAM reports no launch",
  );
  assert.equal(launches.length, 0, "no further atom lands on the zero-value rubble tile");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "the overkill entry is dropped");
  assert.equal(sandbox.state.nukeWantSlots, null, "the dropped salvo releases the reservation");

  // The target SAM still exists on the hostile roster (only its coverage
  // snapshot is stale): the salvo keeps firing rather than aborting.
  const survivingSam = world.sam("surviving-sam", 1);
  world.targetSams.push(survivingSam);
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 2,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "surviving-sam",
    }),
    true,
    "the follow-up salvo bomb is queued",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 810;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "a target SAM that still exists does not abort the salvo",
  );
  assert.equal(launches.length, 1, "the bomb fires against the surviving SAM");
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Plain waitTicks launches (no plan metadata) keep firing unchanged even in
// a world state that would abort a salvo — and an aborted salvo never drops an
// unrelated pending launch
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5),
    true,
    "the plain delayed launch is queued",
  );
  assert.equal(
    behavior._pendingNukeLaunches[0].salvo,
    null,
    "plain delayed launches carry no salvo metadata",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 805;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "non-salvo delayed launches fire without any SAM re-validation",
  );
  assert.equal(launches.length, 1, "the plain delayed bomb fires on its due tick");
  assert.equal(behavior._pendingNukeLaunches.length, 0);

  // An aborted salvo alongside an ordinary delayed launch: only the salvo
  // entries are dropped, the not-yet-due ordinary launch survives, and the
  // reservation persists because another pending launch remains.
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 1,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "destroyed-sam",
    }),
    true,
  );
  assert.equal(
    behavior.queueDelayedNukeLaunch(34, UNIT.AtomBomb, nukeTarget, 10),
    true,
    "an unrelated plain delayed launch is queued too",
  );
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 810;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "the aborted salvo fires nothing this pass",
  );
  assert.deepEqual(
    launches.map((launch) => launch.tile),
    [20],
    "no bomb fired while the salvo aborted and the plain launch was not yet due",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 1, "the aborted salvo entry is gone");
  assert.equal(
    behavior._pendingNukeLaunches[0].tile,
    34,
    "the ordinary launch survives the salvo abort",
  );
  assert.notEqual(
    sandbox.state.nukeWantSlots,
    null,
    "the reservation persists while the ordinary pending launch remains",
  );
  world.tick = 815;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the surviving ordinary launch fires on its own due tick",
  );
  assert.deepEqual(
    launches.map((launch) => launch.tile),
    [20, 34],
    "only the ordinary bomb fired after the abort",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 0);
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "the final pending launch clears the reservation",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 5/6. nukeTileScore penalizes friendly fire: a friendly MissileSilo inside
// the inner radius flips the tile negative; an outer-radius clip is milder
// ════════════════════════════════════════════════════════════════════════════
{
  const tileOf = (x, y) => y * 1000 + x;
  let scoreTick = 100;
  let ownStructures = [];
  let teammateStructures = [];
  let ownUnitsCalls = 0;
  const me = {
    smallID: () => 1,
    team: () => "blue",
    units: () => {
      ownUnitsCalls++;
      return ownStructures;
    },
  };
  const teammate = {
    smallID: () => 2,
    team: () => "blue",
    isAlive: () => true,
    units: () => teammateStructures,
  };
  const scoreGame = {
    ticks: () => scoreTick,
    players: () => [me, teammate],
    x: (tile) => Number(tile) % 1000,
    y: (tile) => Math.floor(Number(tile) / 1000),
    euclideanDistSquared: (left, right) => {
      const dx = (Number(left) % 1000) - (Number(right) % 1000);
      const dy = Math.floor(Number(left) / 1000) - Math.floor(Number(right) / 1000);
      return dx * dx + dy * dy;
    },
    config: () => ({
      nukeMagnitudes: (type) =>
        type === UNIT.HydrogenBomb ? { inner: 80, outer: 100 } : { inner: 12, outer: 30 },
    }),
  };
  const scorer = new sandbox.__NukeBehavior(
    { chance: () => false },
    scoreGame,
    me,
    { shouldAttack: () => true },
    {},
  );
  const candidate = tileOf(500, 500);
  const silos = [{ tile: () => candidate }];
  // A level-2 enemy City on the candidate tile: 50_000 of classic enemy value.
  const enemyStructures = [{ type: () => UNIT.City, level: () => 2, tile: () => candidate }];

  const enemyOnlyScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    enemyOnlyScore,
    50_000,
    "a tile hitting only enemy structures keeps its positive structure value",
  );

  // The friendly-structure snapshot is taken once per decision tick, not once
  // per candidate tile.
  const callsAfterFirstSweep = ownUnitsCalls;
  scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    ownUnitsCalls,
    callsAfterFirstSweep,
    "a same-tick second scoring pass reuses the friendly-structure snapshot",
  );
  scoreTick++;
  scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    ownUnitsCalls,
    callsAfterFirstSweep + 1,
    "the friendly-structure snapshot refreshes on the next decision tick",
  );

  // Our own MissileSilo 5 tiles out — inside the atom's 12-tile inner radius.
  ownStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => tileOf(505, 500), owner: () => me },
  ];
  scoreTick++;
  const innerScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.ok(
    innerScore < 0,
    "a friendly MissileSilo inside the inner radius flips the tile negative",
  );
  assert.equal(
    innerScore,
    50_000 - 3 * 50_000,
    "the inner-radius penalty is the friendly silo value times the heavy multiplier",
  );

  // Same silo at 29 tiles — outside the inner radius, inside the 30-tile
  // outer radius: still penalized, but mildly.
  ownStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => tileOf(529, 500), owner: () => me },
  ];
  scoreTick++;
  const outerScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(outerScore, 0, "the outer-radius clip applies the mild penalty multiplier");
  assert.ok(
    outerScore > innerScore,
    "an outer-radius clip is penalized more mildly than an inner-radius hit",
  );
  assert.ok(
    outerScore < enemyOnlyScore,
    "an outer-radius clip is still penalized against a clean enemy tile",
  );

  // A permanent teammate's City cluster inside the inner radius counts as
  // friendly fire too.
  ownStructures = [];
  teammateStructures = [
    { type: () => UNIT.City, level: () => 1, tile: () => tileOf(500, 501), owner: () => teammate },
    { type: () => UNIT.City, level: () => 1, tile: () => tileOf(500, 502), owner: () => teammate },
  ];
  scoreTick++;
  const teammateScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.ok(
    teammateScore < 0,
    "a permanent teammate's City cluster inside the inner radius flips the tile negative",
  );
  assert.equal(
    teammateScore,
    50_000 - 3 * 2 * 25_000,
    "teammate structures use the same weighted friendly-fire penalty",
  );
}

// A temporary buildability failure must retain the complete salvo, including
// bombs after the failed send, and release the reservation when it drains.
for (const failedProbe of [1, 2]) {
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const emitted = [];
  launchSink = emitted;
  const buildables = player.buildables;
  let probes = 0;
  player.buildables = (...args) => (++probes === failedProbe ? [] : buildables(...args));
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 0, 5] });
  sandbox.state.nukeWantSlots = null;
  sandbox.state.postSalvoHydrogen = null;
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 3,
        siloEntries: [],
        launchSequence: Array.from({ length: 3 }, () => ({ flightTicks: 20 })),
      },
      nukeTarget,
      1n,
    ),
    true,
    "a temporary probe failure queues the full salvo",
  );
  assert.equal(emitted.length, 1, "only the accepted immediate bomb is emitted");
  assert.equal(behavior._pendingNukeLaunches.length, 2);
  assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
  world.tick = 801;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(emitted.length, 2, "the failed immediate bomb retries once");
  world.tick = 805;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(emitted.length, 3, "the tail was not discarded or duplicated");
  assert.equal(behavior.hasPendingNukeLaunches(), false);
  assert.equal(sandbox.state.nukeWantSlots, null);
  sandbox.state.postSalvoHydrogen = null;
}

{
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  player.buildables = async () => {
    nukeTarget.isAlive = () => false;
    return [];
  };
  behavior.getSamSalvo = () => ({ bombsToFire: 1, waits: [0] });
  sandbox.state.nukeWantSlots = null;
  assert.equal(await behavior.fireSamSalvo({ targetTile: 20 }, nukeTarget, 1n), false);
  assert.equal(behavior.hasPendingNukeLaunches(), false, "invalid targets cannot enter retry");
  assert.equal(sandbox.state.nukeWantSlots, null);
}

// Unexpected probe exceptions still propagate, but cannot leave a false
// capacity demand or an unmarked partial queue behind.
for (const delayedFirst of [false, true]) {
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const failure = new Error("worker probe failed");
  player.buildables = () => {
    throw failure;
  };
  const waits = delayedFirst ? [5, 0] : [0];
  behavior.getSamSalvo = () => ({ bombsToFire: waits.length, waits });
  sandbox.state.nukeWantSlots = null;
  await assert.rejects(
    behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: waits.length,
        siloEntries: [],
        launchSequence: waits.map(() => ({ flightTicks: 20 })),
      },
      nukeTarget,
      1n,
    ),
    (error) => error === failure,
  );
  if (delayedFirst) {
    assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
    nukeTarget.isAlive = () => false;
    world.tick = 801;
    assert.equal(await behavior.processPendingNukeLaunches(), false);
    assert.equal(behavior.hasPendingNukeLaunches(), false);
  }
  assert.equal(sandbox.state.nukeWantSlots, null, "no stale capacity reservation survives");
}

// The finisher must follow actual launches, not the original schedule when
// processing stalls or a launch is retried.
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 1] });
  sandbox.state.nukeWantSlots = null;
  await behavior.fireSamSalvo(
    {
      targetTile: 20,
      totalBombs: 2,
      siloEntries: [],
      launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }],
    },
    nukeTarget,
    1n,
  );
  assert.equal(sandbox.state.postSalvoHydrogen.dueTick, 826);
  world.tick = 830;
  const finisher = sandbox.state.postSalvoHydrogen;
  const config = behavior.game.config();
  behavior.game.config = () => ({ ...config, isUnitDisabled: () => false });
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "an overdue finisher waits while its saturating salvo still has queued bombs",
  );
  assert.equal(sandbox.state.postSalvoHydrogen, finisher);
  const buildables = behavior.player.buildables;
  behavior.player.buildables = async () => [];
  assert.equal(await behavior.processPendingNukeLaunches(), false);
  assert.equal(finisher.dueTick, 826, "a rejected probe is not an actual launch");
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(sandbox.state.postSalvoHydrogen, finisher);
  behavior.player.buildables = buildables;
  world.tick = 831;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(
    finisher.dueTick,
    856,
    "the final arrival is measured from the actual late launch tick",
  );
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "the finisher cannot run while the late atom is still in flight",
  );
  sandbox.state.postSalvoHydrogen = null;
}

launchSink = null;

// ════════════════════════════════════════════════════════════════════════════
// 6.5. Per-tick salvo pacing: same-tick due bombs spread across ticks so the
// shared intent window cannot clip a salvo's tail
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  launchSink = launches;
  world.covering.push({ unit: world.sam("pacing-sam", 1), distSquared: 0 });
  const salvo = {
    salvoId: 99,
    plannedCoveringLevel: 1,
    targetTile: 20,
    targetSamId: "pacing-sam",
  };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, salvo),
      true,
      "the same-tick due bomb is queued",
    );
  }
  sandbox.state.nukeWantSlots = reservation();
  world.tick = 800;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the paced pass still reports a launch",
  );
  assert.equal(launches.length, 3, "at most three due bombs launch on one tick");
  assert.equal(
    behavior._pendingNukeLaunches.length,
    2,
    "the overflow bombs are re-queued for the next tick",
  );
  assert.ok(
    behavior._pendingNukeLaunches.every((pending) => pending.dueTick === world.tick + 1),
    "each overflow bomb retries exactly one tick later",
  );
  world.tick = 801;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the next tick fires the remaining bombs",
  );
  assert.equal(launches.length, 5, "all five bombs eventually launch");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "the paced salvo drains completely");
}

launchSink = null;

// ════════════════════════════════════════════════════════════════════════════
// 7/6. Counterforce: an enemy silo whose owner can already afford a MIRV is
// the priority target, not just another 50k structure
// ════════════════════════════════════════════════════════════════════════════
{
  const tileOf = (x, y) => y * 1000 + x;
  const me = { smallID: () => 1, team: () => "blue" };
  const scoreGame = {
    ticks: () => 200,
    players: () => [me],
    x: (tile) => Number(tile) % 1000,
    y: (tile) => Math.floor(Number(tile) / 1000),
    euclideanDistSquared: (left, right) => {
      const dx = (Number(left) % 1000) - (Number(right) % 1000);
      const dy = Math.floor(Number(left) / 1000) - Math.floor(Number(right) / 1000);
      return dx * dx + dy * dy;
    },
    config: () => ({
      nukeMagnitudes: (type) =>
        type === UNIT.HydrogenBomb ? { inner: 80, outer: 100 } : { inner: 12, outer: 30 },
    }),
  };
  const scorer = new sandbox.__NukeBehavior(
    { chance: () => false },
    scoreGame,
    me,
    { shouldAttack: () => true },
    {},
  );
  const poorOwner = { smallID: () => 7, gold: () => 1_000_000n };
  const mirvRichOwner = { smallID: () => 8, gold: () => 30_000_000n };
  const poorSilo = {
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => tileOf(300, 300),
    owner: () => poorOwner,
  };
  const richSilo = {
    type: () => UNIT.MissileSilo,
    level: () => 1,
    tile: () => tileOf(700, 300),
    owner: () => mirvRichOwner,
  };
  const silos = [{ tile: () => tileOf(300, 300) }];

  const poorScore = scorer.nukeTileScore(tileOf(300, 300), silos, [poorSilo], UNIT.AtomBomb);
  const richScore = scorer.nukeTileScore(
    tileOf(700, 300),
    [{ tile: () => tileOf(700, 300) }],
    [richSilo],
    UNIT.AtomBomb,
  );
  assert.equal(
    poorScore,
    50_000,
    "a silo owned below the MIRV price keeps its classic counterforce value",
  );
  assert.equal(
    richScore,
    150_000,
    "a silo whose owner can already pay for a MIRV scores as three ordinary silos",
  );
  assert.equal(
    scorer.mirvCapableSiloPriority({
      type: () => UNIT.MissileSilo,
      owner: () => null,
    }),
    1,
    "a silo without an owner view stays at the baseline priority",
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 4/4. Hydrogen finisher: scheduled by the saturating salvo, fires only once
// due AND the covering SAMs are actually gone; live coverage aborts it.
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launchSink = launches;
  behavior.game.players = () => [nukeTarget];
  behavior.game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    samRange: () => 150,
  });
  launches.length = 0;
  behavior.player.gold = () => 10_000_000n;
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo ? [{ isUnderConstruction: () => false }] : [];
  behavior.sendNuke = async (tile, type) => {
    launches.push({ type, tile });
    return true;
  };
  sandbox.state.postSalvoHydrogen = {
    targetTile: 20,
    dueTick: world.tick + 10,
    targetSmallID: nukeTarget.smallID(),
  };
  world.covering.push({ unit: world.sam("enemy-sam-1", 2), distSquared: 0 });
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "live covering SAMs abort the Hydrogen finisher",
  );
  assert.deepEqual(launches, [], "nothing launched into coverage");
  world.covering.length = 0;
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "a finisher before its due tick stays queued",
  );
  assert.ok(
    sandbox.state.postSalvoHydrogen !== null,
    "the pending finisher survives an early check",
  );
  world.tick = 10_000;
  sandbox.state.postSalvoHydrogen.dueTick = 9_999;
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    true,
    "a due finisher over cleared coverage fires the Hydrogen bomb",
  );
  assert.deepEqual(
    launches,
    [{ type: UNIT.HydrogenBomb, tile: 20 }],
    "the finisher is a Hydrogen bomb at the salvo's target tile",
  );
  assert.equal(behavior.hydrogenBombsLaunched, 1, "the finisher counts as a Hydrogen launch");
  assert.equal(sandbox.state.postSalvoHydrogen, null, "a fired finisher clears the schedule");
}

launchSink = null;
process.stdout.write("nuke salvo recheck tests passed\n");
