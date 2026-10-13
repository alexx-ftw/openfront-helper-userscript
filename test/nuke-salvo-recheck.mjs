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
  document: {
    querySelector: (selector) => (selector === "build-menu" ? buildMenu : null),
  },
  window: {},
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
const stubBuildSender = sandbox.sendAutoBotBuildOrUpgrade;
executeClassicScript(read("engine/ingame/auto-bot/context.js"), sandbox, {
  filename: "context.vm.js",
});
const sharedNukeLedger = {
  claim: sandbox.autoBotBuildClaimNukeLaunches,
  release: sandbox.autoBotBuildReleaseNukeLaunchClaim,
  slots: sandbox.autoBotBuildNukeSlots,
  send: sandbox.sendAutoBotBuildOrUpgrade,
};
sandbox.getBuildMenu = () => buildMenu;
sandbox.sendAutoBotBuildOrUpgrade = stubBuildSender;
sandbox.autoBotBuildClaimNukeLaunches = undefined;
sandbox.autoBotBuildReleaseNukeLaunchClaim = undefined;
sandbox.autoBotBuildNukeSlots = undefined;
executeClassicScript(
  `${read("engine/ingame/auto-bot/legendaryPlanner.js")}\n${read("engine/ingame/auto-bot/structureBehavior.js")}\n${read("engine/ingame/auto-bot/mirvBehavior.js")}\n${read("engine/ingame/auto-bot/nukeBehavior.js")}\nglobalThis.__NukeBehavior = NukeBehavior; globalThis.__StructureBehavior = StructureBehavior; globalThis.__MirvBehavior = MirvBehavior;`,
  sandbox,
  {
    filename: "nuke-salvo-recheck.vm.js",
  },
);

// Fixture stub: harness players lack the real team helpers behind
// legendaryMissileDefenseUrgent; blocks that test urgency override per instance.
sandbox.__StructureBehavior.prototype.legendaryMissileDefenseUrgent = () => false;

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
    config: () => ({
      maxSamRange: () => 150,
      samRange: () => 150,
      isUnitDisabled: () => false,
    }),
    nearbyUnits: (_tile, _radius, type, _from, includeUnderConstruction) =>
      type === UNIT.SAMLauncher
        ? world.covering.filter(
            (entry) => includeUnderConstruction || entry.unit.isUnderConstruction?.() !== true,
          )
        : [],
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
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = () => false;
  world.sam = (id, level) => ({
    id: () => id,
    level: () => level,
    tile: () => 20,
    owner: () => nukeTarget,
    type: () => UNIT.SAMLauncher,
  });
  return { world, game, player, nukeTarget, behavior };
}

sandbox.autoBotBuildNukeSlots = sharedNukeLedger.slots;
// The salvo excludes only its own queued claims from the gold-policy check.
for (const [otherClaimCost, canStart] of [
  [10n, true],
  [11n, false],
]) {
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  const silo = {
    id: () => 7,
    level: () => 3,
    tile: () => 10,
    missileTimerQueue: () => [],
    isUnderConstruction: () => false,
  };
  player.gold = () => 110n;
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  game.manhattanDist = (from, to) => Math.abs(from - to);
  const otherClaims = sharedNukeLedger.claim(game, player, {
    nukeType: UNIT.MIRV,
    targetTile: 20,
    cost: otherClaimCost,
    count: 1,
    salvoId: "other-salvo",
  });
  const ownClaims = sharedNukeLedger.claim(game, player, {
    nukeType: UNIT.AtomBomb,
    targetTile: 30,
    cost: 20n,
    count: 2,
    salvoId: "current-salvo",
  });
  assert.ok(otherClaims);
  assert.ok(ownClaims);
  behavior.hasActiveMaritimeInvasion = () => false;
  behavior.isUnderHeavyAttack = () => false;
  behavior.isRetaliationNukeTarget = () => false;
  behavior.blastHitsFriendlyLand = () => false;
  const construction = Object.create(sandbox.__StructureBehavior.prototype);
  Object.assign(construction, { game, player });
  construction.hasActiveMaritimeInvasion = () => false;
  construction.economicConstructionPressure = () => null;
  construction.legendaryAtomWarChest = () => 0n;
  construction.offensiveNukeDefenseReserve = () => 60n;
  behavior.structureBehavior = construction;
  assert.equal(
    await behavior.canStartSamSalvo(
      { targetTile: 30 },
      nukeTarget,
      { bombsToFire: 2, claimIds: ownClaims },
      20n,
    ),
    canStart,
    `an unrelated ${otherClaimCost}-gold queued claim remains reserved`,
  );
  for (const claimId of [...otherClaims, ...ownClaims]) {
    sharedNukeLedger.release(game, player, claimId);
  }
}
sandbox.autoBotBuildNukeSlots = undefined;

{
  const { game, nukeTarget, behavior } = makeSalvoWorld();
  const samTile = { x: 5, y: 5 };
  const unsafeAim = { x: 7, y: 5 };
  const safeAim = { x: 5, y: 7 };
  const structures = [{ tile: () => ({ x: 9, y: 5 }) }, { tile: () => ({ x: 5, y: 9 }) }];
  const targetSam = {
    id: () => "aim-sam",
    tile: () => samTile,
    owner: () => nukeTarget,
  };
  nukeTarget.units = (type) => (type === UNIT.City ? structures : []);
  Object.assign(game, {
    config: () => ({ nukeMagnitudes: () => ({ outer: 5 }) }),
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    isValidCoord: () => true,
    ref: (x, y) => ({ x, y }),
    euclideanDistSquared: (left, right) => (left.x - right.x) ** 2 + (left.y - right.y) ** 2,
  });
  behavior.blastHitsFriendlyLand = (tile) =>
    (tile.x === samTile.x && tile.y === samTile.y) ||
    (tile.x === unsafeAim.x && tile.y === unsafeAim.y);
  behavior.blastStructureValue = (tile) => {
    if (tile.x === unsafeAim.x && tile.y === unsafeAim.y) return 100;
    if (tile.x === safeAim.x && tile.y === safeAim.y) return 50;
    return 10;
  };
  behavior.friendlyFirePenalty = () => 0;
  assert.deepEqual(
    behavior.samSalvoAimTile(targetSam),
    safeAim,
    "an unsafe highest-value aim falls back to the best safe aim that still covers the SAM",
  );
}

{
  const { world, game, nukeTarget, behavior } = makeSalvoWorld();
  const buildingSam = world.sam("building-sam", 2);
  buildingSam.isUnderConstruction = () => true;
  world.targetSams.push(buildingSam);
  world.covering.push({ unit: buildingSam, distSquared: 0 });
  game.config = () => ({
    maxSamRange: () => 100,
    samRange: () => 100,
    SAMCooldown: () => 100,
  });
  game.nearbyUnits = (_tile, _range, type, _predicate, includeUnderConstruction) =>
    type === UNIT.SAMLauncher && (includeUnderConstruction || !buildingSam.isUnderConstruction())
      ? [{ unit: buildingSam, distSquared: 0 }]
      : [];
  behavior.samSalvoAimTile = () => 20;
  behavior.getAvailableSiloEntries = () =>
    [10, 20, 30].map((flightTicks) => ({
      flightTicks,
      interceptable: false,
    }));
  behavior.createSamLaunchSequence = (entries) => entries;
  const plan = behavior.createSamOverwhelmPlan(buildingSam, [{}]);
  assert.equal(
    plan.coveringSamLevels,
    2,
    "capacity planning includes a hostile SAM that can finish construction before impact",
  );
  assert.equal(plan.totalBombs, 3);

  behavior.samSalvoCapacityAtArrival = () => 2;
  behavior.samSalvoLiveCapacitySpend = () => 0;
  assert.equal(
    behavior.samSalvoStillViable(
      { targetPlayer: nukeTarget, salvo: { targetTile: 20, targetSamId: buildingSam.id() } },
      1,
      30,
    ),
    false,
    "in-flight salvo rechecks account for SAMs under construction",
  );

  world.covering = [];
  const stalePlan = {
    targetTile: 20,
    targetSamId: buildingSam.id(),
    coveringSamIds: new Set(),
    totalBombs: 1,
  };
  const launchMetadata = behavior.nextSamSalvoPlan(stalePlan);
  world.covering.push({ unit: buildingSam, distSquared: 0 });
  assert.equal(
    behavior.samSalvoLaunchStillViable(20, nukeTarget, launchMetadata),
    false,
    "a SAM started during the async probe aborts an undersized first launch",
  );
}

{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  const plannedSam = world.sam("upgraded-planned-sam", 1);
  world.covering.push({ unit: plannedSam, distSquared: 0 });
  world.targetSams.push(plannedSam);
  const pending = {
    tile: 20,
    targetPlayer: nukeTarget,
    salvo: {
      salvoId: 1,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "upgraded-planned-sam",
      coveringSamIds: ["upgraded-planned-sam"],
    },
  };
  assert.equal(behavior.samSalvoStillViable(pending, 2, 820), true);
  plannedSam.level = () => 2;
  assert.equal(
    behavior.samSalvoStillViable(pending, 2, 820),
    false,
    "a level increase on an already planned SAM invalidates the stale salvo",
  );
}

{
  const { behavior } = makeSalvoWorld();
  const sam = { id: () => "pinned-sam", level: () => 1, tile: () => 30 };
  const inspectedTiles = [];
  const previousDemand = sandbox.state.nukeWantSlots;
  sandbox.state.nukeWantSlots = {
    targetSamId: "pinned-sam",
    targetTile: 20,
  };
  behavior.game.config = () => ({ SAMCooldown: () => 100 });
  behavior.samSalvoAimTile = () => 30;
  behavior.findEnemySamsCoveringTile = (tile) => {
    inspectedTiles.push(tile);
    return [sam];
  };
  behavior.getAvailableSiloEntries = (_silos, tile) => {
    inspectedTiles.push(tile);
    return [];
  };
  behavior.createSamLaunchSequence = () => [];
  behavior.findSamArrivalWindow = () => [];
  try {
    const plan = behavior.createSamOverwhelmPlan(sam, []);
    assert.equal(plan.targetTile, 20);
    assert.deepEqual(inspectedTiles, [20, 20], "capacity and routes share the pinned demand tile");
  } finally {
    sandbox.state.nukeWantSlots = previousDemand;
  }
}

// Receipt barriers preserve a valid prefix without inventing SAM capacity.
for (const release of ["expiry", "alliance"]) {
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("receipt-target", 1);
  world.covering.push({ unit: sam, distSquared: 0 });
  world.targetSams.push(sam);
  const emitted = [];
  launchSink = emitted;
  let awaiting = true;
  sandbox.autoBotBuildPendingNukes = () => (awaiting ? [{ salvoId: 7 }] : []);
  try {
    behavior._pendingNukeLaunches = [
      {
        dueTick: world.tick,
        tile: 20,
        nukeType: UNIT.AtomBomb,
        targetPlayer: nukeTarget,
        salvo: { salvoId: 7, targetTile: 20, targetSamId: sam.id(), flightTicks: 20 },
      },
      {
        dueTick: world.tick,
        tile: 20,
        nukeType: UNIT.AtomBomb,
        targetPlayer: nukeTarget,
        salvo: null,
      },
    ];
    assert.equal(
      behavior.salvoAwaitingNativeReceipts({ salvoId: 8 }),
      false,
      "an unrelated salvo cannot inherit the prefix's receipt barrier",
    );
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      true,
      "an ordinary launch still progresses while a saturation tail waits",
    );
    assert.equal(emitted.length, 1);
    assert.equal(behavior._pendingNukeLaunches.length, 1);
    assert.equal(behavior._pendingNukeLaunches[0].salvo.salvoId, 7);
    world.tick++;
    if (release === "alliance") {
      player.team = () => "Blue";
      nukeTarget.team = () => "Blue";
    } else awaiting = false;
    assert.equal(await behavior.processPendingNukeLaunches(), false);
    assert.equal(
      behavior.hasPendingNukeLaunches(),
      false,
      `${release}: invalid diplomacy or an unsupported expired prefix cannot preserve the tail`,
    );
    assert.equal(emitted.length, 1, "the receipt barrier never grants fictitious SAM capacity");
  } finally {
    delete sandbox.autoBotBuildPendingNukes;
  }
}

// A validated batch can fill the send cap before its own new receipts block the next pass.
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("batch-target", 3);
  world.covering.push({ unit: sam, distSquared: 0 });
  world.targetSams.push(sam);
  const emitted = [];
  launchSink = emitted;
  sandbox.autoBotBuildPendingNukes = () => (emitted.length ? [{ salvoId: 70 }] : []);
  try {
    behavior._pendingNukeLaunches = Array.from({ length: 4 }, () => ({
      dueTick: world.tick,
      tile: 20,
      nukeType: UNIT.AtomBomb,
      targetPlayer: nukeTarget,
      salvo: { salvoId: 70, targetTile: 20, targetSamId: sam.id(), flightTicks: 20 },
    }));
    assert.equal(await behavior.processPendingNukeLaunches(), true);
    assert.equal(emitted.length, 3, "a validated batch uses but never exceeds the three-shot cap");
    assert.equal(behavior._pendingNukeLaunches.length, 1);
    world.tick++;
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      "the next pass still waits for the earlier emitted prefix",
    );
    assert.equal(emitted.length, 3);
    assert.equal(behavior._pendingNukeLaunches.length, 1);
  } finally {
    delete sandbox.autoBotBuildPendingNukes;
  }
}

// The ordinary construction budget must preserve every pending saturation Atom.
{
  const { behavior, player, game, world, nukeTarget } = makeSalvoWorld();
  game.config = () => ({ isUnitDisabled: () => false, maxSamRange: () => 150 });
  player.gold = () => 2_000_000n;
  player.units = () => [{ isUnderConstruction: () => false }];
  const budget = new sandbox.__StructureBehavior({}, game, player);
  budget.nukeBehavior = behavior;
  budget.ownSamCapacity = () => 1;
  budget.legendaryNukeStructureTargetExists = () => true;
  budget.safeConstructionCost = () => 750_000n;
  budget.firstSamConstructionReserve = () => 0n;
  const originalDifficultyCheck = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = () => true;
  try {
    for (const delay of [5, 10]) {
      assert.equal(
        behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, delay, {
          salvoId: 1,
          targetTile: 20,
          targetSamId: null,
        }),
        true,
      );
    }
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      500_000n,
      "a 600k City cannot consume the 1.5M still needed for two queued Atoms",
    );
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.Port),
      2_000_000n,
      "the existing trade-economy exemption remains available",
    );
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.SAMLauncher),
      2_000_000n,
      "actual missile defense retains priority over offensive funding",
    );
    sandbox.autoBotBuildReservedGold = () => 750_000n;
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      0n,
      "an already-emitted purchase plus the unsent tail cannot be spent again on a stale gold snapshot",
    );
    delete sandbox.autoBotBuildReservedGold;
    behavior.getAbortedSalvoIds = () => new Set();
    behavior.firePendingNukeLaunch = async () => "fired";
    world.tick += 5;
    assert.equal(await behavior.processPendingNukeLaunches(), true);
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      1_250_000n,
      "draining one entry shrinks the queue's construction reserve",
    );
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 10);
    nukeTarget.isAlive = () => false;
    await behavior.processPendingNukeLaunches();
    assert.equal(behavior.hasPendingNukeLaunches(), false);
    assert.equal(
      budget.availableGoldAfterReserve(UNIT.City),
      1_250_000n,
      "cancelling the salvo releases its additional bank and retains the ordinary one-Atom reserve",
    );
  } finally {
    delete sandbox.autoBotBuildReservedGold;
    sandbox.isLegendaryDifficulty = originalDifficultyCheck;
  }
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
  player.units = (type) => (type === UNIT.MissileSilo && active ? [silo] : []);
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
  behavior.fireSamSalvo = async () => {
    salvos++;
    return true;
  };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(
    salvos,
    invalidation === "unchanged" ? 1 : 0,
    `${invalidation} silo eligibility after price await`,
  );
}

// Pre-registered anti-SAM starvation release: held atoms keep the native
// guard unless the caller signals zero clear candidates this tick.
{
  const { behavior, player, game, world, nukeTarget } = makeSalvoWorld();
  const silo = {
    isActive: () => true,
    isUnderConstruction: () => false,
    level: () => 3,
    missileTimerQueue: () => [],
    tile: () => 5,
  };
  player.units = (type) => {
    if (type === UNIT.MissileSilo) return [silo];
    if (type === UNIT.AtomBomb) return [{}, {}];
    return [];
  };
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
  behavior.cost = async () => 1n;
  behavior.createSamOverwhelmPlan = (_sam, silos) => ({
    capacityMissing: behavior.getAvailableSiloEntries(silos, 20, []).length === 0,
  });
  behavior.rememberFailedSamTarget = (plan) => plan;
  behavior.maybeUpgradeHelpfulSilo = async () => {};
  let salvos = 0;
  behavior.fireSamSalvo = async () => {
    salvos += 1;
    return true;
  };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(salvos, 0, "held atoms keep the native guard without the starvation flag");
  await behavior.maybeDestroyEnemySam(nukeTarget, true);
  assert.equal(salvos, 1, "the starvation release lets held atoms fund the salvo");
}

// Construction consumes demand before the nuclear decision chain gets to clear it.
for (const change of [
  "unchanged",
  "destroyed",
  "friendly",
  "during-probe",
  "replaced-request",
  "pending-launches",
]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  let friendly = false;
  world.covering = [sam];
  world.targetSams = [sam];
  game.config = () => ({ isUnitDisabled: () => false, maxSamRange: () => 150 });
  game.units = () => world.covering;
  player.isFriendly = () => friendly;
  player.units = (type) => (type === UNIT.AtomBomb ? [{}] : []);
  behavior.rememberFailedSamTarget({
    targetSamId: 77,
    targetTile: 20,
    totalBombs: 4,
    siloEntries: [],
    coveringSamIds: new Set([77]),
  });
  if (change === "destroyed") world.covering = world.targetSams = [];
  if (change === "friendly") friendly = true;
  await behavior.maybeDestroyEnemySam(nukeTarget);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  const demandSilo = { id: () => 77, level: () => 1 };
  structures.nukeDemandScopedSilos = () => [demandSilo];
  structures.availableGoldAfterReserve = () => 100n;
  structures.safeStructureCost = () => 1n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async () => {
    if (change === "during-probe") world.covering = world.targetSams = [];
    if (change === "replaced-request")
      sandbox.state.nukeWantSlots = { ...sandbox.state.nukeWantSlots, targetSamId: 88 };
    if (change === "pending-launches") sandbox.state.nukeWantSlots.pendingLaunches = true;
    return [];
  };
  structures.rankNukeDemandSiloUpgrades = () => [{ silo: demandSilo }];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => {
    upgrades++;
    return true;
  };
  await structures.maybeUpgradeSiloForNukeDemand();
  assert.equal(
    upgrades,
    change === "unchanged" ? 1 : 0,
    `${change} SAM cannot retain obsolete capacity demand`,
  );
  if (change === "pending-launches")
    assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
  if (change === "replaced-request") assert.equal(sandbox.state.nukeWantSlots.targetSamId, 88);
  sandbox.state.nukeWantSlots = null;
}

for (const restriction of [
  "budget",
  "budget-during-probe",
  "upgrade-cost",
  "destroyed",
  "during-probe",
  "blocked-route",
  "impossible-capacity",
  "permitted",
]) {
  const { behavior, game, player, world } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  let targetSams = restriction === "destroyed" ? [] : [sam];
  game.units = () => targetSams;
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
  });
  player.units = () => [];
  const failedTarget = behavior.rememberFailedSamTarget({
    targetSamId: 77,
    targetTile: 20,
    totalBombs: 4,
    siloEntries: [],
    coveringSamIds: new Set([77]),
  });
  const silo = { id: () => 1, level: () => 1 };
  behavior.getRouteEligibleSilos = () => (restriction === "blocked-route" ? [] : [silo]);
  behavior.hasUsefulSiloUpgradeCapacity = () => restriction !== "impossible-capacity";
  behavior.getPreferredHelpfulSilos = (silos) => silos;
  behavior.findBestProtectedSilo = () => silo;
  let upgrades = 0;
  behavior.actuateSiloUpgrade = async () => {
    upgrades++;
    return true;
  };
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  behavior.structureBehavior = structures;
  structures.nukeDemandScopedSilos = (_request, routeEligibleSilos = null) =>
    routeEligibleSilos ?? [silo];
  let demandSiloBuildRequested = false;
  structures.maybeSpawnStructure = async (type, options) => {
    if (restriction !== "impossible-capacity") return false;
    demandSiloBuildRequested =
      type === UNIT.MissileSilo &&
      options.forceNewStructure === true &&
      options.nukeDemandRequest === sandbox.state.nukeWantSlots;
    return demandSiloBuildRequested;
  };
  let availableGold = restriction === "budget" ? 50n : 200n;
  structures.availableGoldAfterReserve = () => availableGold;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 100n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => {
    if (restriction === "during-probe") targetSams = [];
    if (restriction === "budget-during-probe") availableGold = 50n;
    return restriction === "upgrade-cost" || restriction === "permitted"
      ? [{ cost: restriction === "upgrade-cost" ? 150n : 20n, canUpgrade: true }]
      : [];
  };
  if (restriction !== "upgrade-cost" && restriction !== "permitted")
    structures.rankNukeDemandSiloUpgrades = () => [{}];
  structures.executeStructureUpgradeCandidate = async (candidate) => {
    if (!candidate) return false;
    upgrades++;
    return true;
  };
  const upgraded = await behavior.maybeUpgradeHelpfulSilo(failedTarget);
  assert.equal(
    demandSiloBuildRequested,
    restriction === "impossible-capacity",
    `${restriction} only starts a new Silo when existing upgrade capacity is exhausted`,
  );
  assert.equal(
    upgrades,
    restriction === "permitted" ? 1 : 0,
    `${restriction} immediate nuke demand respects shared construction gates`,
  );
  assert.equal(upgraded, restriction === "permitted" || restriction === "impossible-capacity");
  sandbox.state.nukeWantSlots = null;
}
{
  // Legendary missile-defense urgency defers silo capacity work while a
  // hostile missile is live; the structure lane already owns the SAM-vs-silo
  // affordability tradeoff, so no second probe may re-order it.
  const { behavior, game, player, world } = makeSalvoWorld();
  const sam = world.sam(77, 3);
  game.units = () => [sam];
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
  });
  player.units = () => [];
  const failedTarget = behavior.rememberFailedSamTarget({
    targetSamId: 77,
    targetTile: 20,
    totalBombs: 4,
    siloEntries: [],
    coveringSamIds: new Set([77]),
  });
  const storedRequest = sandbox.state.nukeWantSlots;
  const silo = { id: () => 1, level: () => 1 };
  behavior.getRouteEligibleSilos = () => [silo];
  behavior.hasUsefulSiloUpgradeCapacity = () => true;
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  behavior.structureBehavior = structures;
  structures.nukeDemandScopedSilos = (_request, routeEligibleSilos = null) =>
    routeEligibleSilos ?? [silo];
  structures.availableGoldAfterReserve = () => 550n;
  structures.safeStructureCost = () => 150n;
  structures.economicConstructionPressure = () => ({ cost: 0n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => [{ cost: 150n, canUpgrade: true }];
  structures.rankNukeDemandSiloUpgrades = () => [{ silo }];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => {
    upgrades++;
    return true;
  };
  structures.legendaryMissileDefenseUrgent = () => true;
  assert.equal(
    await behavior.maybeUpgradeHelpfulSilo(failedTarget),
    false,
    "an affordable timely SAM defers the silo capacity upgrade",
  );
  assert.equal(upgrades, 0, "the urgent-defense guard emits no silo upgrade");
  assert.equal(
    sandbox.state.nukeWantSlots,
    storedRequest,
    "the guard defers without consuming the capacity demand",
  );
  sandbox.state.nukeWantSlots = storedRequest;
  structures.legendaryMissileDefenseUrgent = () => false;
  assert.equal(
    await behavior.maybeUpgradeHelpfulSilo(failedTarget),
    true,
    "with no missile emergency the demand lane may upgrade",
  );
  assert.equal(upgrades, 1, "the deferred upgrade executes once the emergency clears");
  sandbox.state.nukeWantSlots = null;
}

for (const preferredIds of [[], [99], [2]]) {
  const { behavior, game, player, world } = makeSalvoWorld();
  game.units = () => [world.sam(77, 3)];
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  const good = { id: () => 1, level: () => 1, isUnderConstruction: () => false };
  const blocked = { id: () => 2, level: () => 1, isUnderConstruction: () => false };
  player.units = (type) => (type === UNIT.MissileSilo ? [good, blocked] : []);
  sandbox.state.nukeWantSlots = { targetSamId: 77, need: 4, unblockedSiloIds: preferredIds };
  behavior.getRouteEligibleSilos = () => [good];
  behavior.hasUsefulSiloUpgradeCapacity = () => true;
  const structures = new sandbox.__StructureBehavior({}, game, player);
  behavior.structureBehavior = structures;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async (silos) =>
    silos.map(() => ({ cost: 20n, canUpgrade: true }));
  structures.siloSamProtectionScore = (silo) => (silo.id() === blocked.id() ? 100 : 0);
  const upgradedIds = [];
  structures.executeStructureUpgradeCandidate = async (candidate) => {
    if (!candidate) return false;
    upgradedIds.push(candidate.silo.id());
    return true;
  };
  assert.equal(await behavior.maybeUpgradeHelpfulSilo({}), true);
  assert.deepEqual(upgradedIds, [good.id()], "scope fallback cannot upgrade a route-blocked silo");
  sandbox.state.nukeWantSlots = null;
}

for (const route of [
  "no-route",
  "blocked-during-probe",
  "insufficient-capacity",
  "capacity-loss",
  "partly-cooling",
  "cooling",
]) {
  const { behavior, game, player, world } = makeSalvoWorld();
  const targetSam = world.sam(77, 3);
  game.units = () => [targetSam];
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  const silo = {
    id: () => 1,
    tile: () => 10,
    level: () => 1,
    isUnderConstruction: () => false,
    missileTimerQueue: () => [world.tick - 1],
  };
  const secondSilo = { ...silo, id: () => 2, tile: () => 11 };
  player.units = (type) => {
    if (type !== UNIT.MissileSilo) return [];
    if (route === "capacity-loss" || route === "partly-cooling") {
      return [silo, secondSilo];
    }
    return [silo];
  };
  let blocked = route === "no-route";
  behavior.findEnemySamsCoveringTile = () => [targetSam];
  behavior.isTrajectoryInterceptableBySam = (spawn, _target, exclusions) =>
    (blocked && (route !== "capacity-loss" || spawn === secondSilo.tile())) ||
    !exclusions?.has(targetSam.id());
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.maybeSpawnStructure = async () => false;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 100n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async (silos) => {
    if (route === "blocked-during-probe" || route === "capacity-loss") blocked = true;
    return silos.map(() => ({ cost: 20n, canUpgrade: true }));
  };
  const upgraded = [];
  structures.executeStructureUpgradeCandidate = async (candidate) => {
    if (!candidate) return false;
    upgraded.push(candidate.silo.id());
    return true;
  };
  sandbox.state.nukeWantSlots = {
    targetSamId: 77,
    targetTile: 20,
    need:
      route === "insufficient-capacity" || route === "capacity-loss" || route === "partly-cooling"
        ? 6
        : 4,
    unblockedSiloIds: route === "partly-cooling" ? [secondSilo.id()] : [],
  };
  const sent = await structures.maybeUpgradeSiloForNukeDemand();
  assert.equal(
    sent,
    route !== "no-route" && route !== "blocked-during-probe",
    `${route} construction demand needs a live useful route`,
  );
  assert.deepEqual(
    upgraded,
    (() => {
      if (route === "partly-cooling") return [secondSilo.id()];
      if (route === "no-route" || route === "blocked-during-probe") return [];
      return [silo.id()];
    })(),
  );
  sandbox.state.nukeWantSlots = null;
}

for (const change of [
  "protected-target",
  "own-aim",
  "aim-during-probe",
  "target-during-probe",
  "hostile",
  "unowned",
]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  let owner = nukeTarget;
  if (change === "own-aim") owner = player;
  if (change === "unowned") owner = { isPlayer: () => false };
  let protectedTarget = change === "protected-target";
  game.owner = () => owner;
  game.units = () => [world.sam(77, 3)];
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  behavior.attackBehavior.shouldAttack = () => !protectedTarget;
  const silo = { id: () => 1, level: () => 1 };
  behavior.getRouteEligibleSilos = () => [silo];
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.nukeDemandScopedSilos = () => [silo];
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.nukeSiloUpgradeBudgetAvailable = () => true;
  structures.buildableForUnits = async () => {
    if (change === "aim-during-probe") owner = player;
    if (change === "target-during-probe") protectedTarget = true;
    return [];
  };
  structures.rankNukeDemandSiloUpgrades = () => [{ silo }];
  let upgrades = 0;
  structures.executeStructureUpgradeCandidate = async () => {
    upgrades++;
    return true;
  };
  sandbox.state.nukeWantSlots = { targetSamId: 77, targetTile: 20, need: 4, unblockedSiloIds: [] };
  const allowed = change === "hostile" || change === "unowned";
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    allowed,
    `${change} capacity demand obeys nuclear policy`,
  );
  assert.equal(upgrades, allowed ? 1 : 0);
  if (!allowed) assert.equal(sandbox.state.nukeWantSlots, null);
  sandbox.state.nukeWantSlots = null;
}

for (const capture of [
  "hostile",
  "own-before-due",
  "own-during-probe",
  "teammate",
  "protected",
  "unowned",
]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  player.team = () => "blue";
  const teammate = {
    isPlayer: () => true,
    smallID: () => 3,
    team: () => "blue",
    isAlive: () => true,
  };
  const protectedPlayer = {
    isPlayer: () => true,
    smallID: () => 4,
    team: () => null,
    isAlive: () => true,
  };
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
  assert.equal(
    behavior.hasPendingNukeLaunches(),
    false,
    `${capture} launch resolved without stale retries`,
  );
  if (!allowed)
    assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5), false);
  launchSink = null;
}

for (const rejection of ["captured-first", "captured-all", "none"]) {
  const { behavior, game, player, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  const captured = new Set();
  game.owner = (tile) => (captured.has(tile) ? player : nukeTarget);
  const probes = new Map();
  player.buildables = async (tile) => {
    probes.set(tile, (probes.get(tile) ?? 0) + 1);
    if (
      probes.get(tile) === 2 &&
      (rejection === "captured-all" || (rejection === "captured-first" && tile === 20))
    )
      captured.add(tile);
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  behavior.nukeHasPositiveExpectedValue = async () => true;
  const emitted = [];
  launchSink = emitted;
  const fired = await behavior.fireLegendaryClearFallthrough(
    [
      { tile: 20, value: 100 },
      { tile: 30, value: 50 },
    ],
    nukeTarget,
    { type: UNIT.AtomBomb, cost: 1n },
    [],
  );
  assert.equal(fired, rejection !== "captured-all", `${rejection} reports actual dispatch`);
  assert.deepEqual(
    emitted.map((shot) => shot.tile),
    rejection === "captured-all" ? [] : [rejection === "captured-first" ? 30 : 20],
    `${rejection} preserves the first valid ranked destination`,
  );
  launchSink = null;
}

for (const capture of ["before-due", "poor", "price", "price-poor", "buildable"]) {
  const { behavior, game, player, world, nukeTarget } = makeSalvoWorld();
  player.isPlayer = nukeTarget.isPlayer = () => true;
  let owner = capture === "before-due" || capture === "poor" ? player : nukeTarget;
  game.owner = () => owner;
  game.players = () => [nukeTarget];
  game.config = () => ({
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ inner: 80, outer: 100 }),
  });
  game.euclideanDistSquared = (a, b) => (a - b) * (a - b);
  // The finisher's enemy-value gate needs a priced structure at the target
  // and no friendly structure inside its blast, so the capture rejections
  // under test are reached instead of the gate holding first.
  world.targetSams.push(world.sam("capture-target-sam", 1));
  player.gold = () => (capture === "poor" || capture === "price-poor" ? 0n : 10_000_000n);
  player.units = () => [
    {
      isUnderConstruction: () => false,
      tile: () => 500,
      level: () => 1,
      type: () => UNIT.MissileSilo,
    },
  ];
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
const previousSalvoDifficulty = sandbox.currentDifficulty;
sandbox.currentDifficulty = () => "Legendary";
for (const lane of ["ordinary", "freeze"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  const sam = world.sam("covered-target", 1);
  world.targetSams.push(sam);
  world.covering.push({ unit: sam, distSquared: 0 });
  const firedAtomTicks = [];
  const firedAtoms = [];
  let nextAtomId = 0;
  const silo = {
    id: () => 7,
    level: () => 2,
    tile: () => 10,
    missileTimerQueue: () => firedAtomTicks,
    isUnderConstruction: () => false,
  };
  player.units = (type) => {
    if (type === UNIT.MissileSilo) return [silo];
    if (type === UNIT.AtomBomb) return firedAtoms;
    return [];
  };
  game.manhattanDist = (from, to) => Math.abs(from - to);
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
  const atomCost = lane === "ordinary" ? 20n : 1n;
  const selected = { type: UNIT.AtomBomb, cost: atomCost };
  const emitted = [];
  const previousBuildMenu = buildMenu;
  buildMenu = {
    sendBuildOrUpgrade(buildable, tile) {
      if (buildable.type === UNIT.AtomBomb) {
        firedAtomTicks.push(world.tick);
        firedAtoms.push({ id: () => `atom-${++nextAtomId}`, targetTile: () => tile });
      }
    },
  };
  launchSink = emitted;
  sandbox.state.nukeWantSlots = null;
  sandbox.autoBotBuildClaimNukeLaunches = sharedNukeLedger.claim;
  sandbox.autoBotBuildReleaseNukeLaunchClaim = sharedNukeLedger.release;
  sandbox.autoBotBuildNukeSlots = sharedNukeLedger.slots;
  sandbox.sendAutoBotBuildOrUpgrade = (menu, buildable, tile, ...context) => {
    const sent = sharedNukeLedger.send(menu, buildable, tile, ...context);
    if (sent && launchSink) launchSink.push({ type: buildable.type, tile });
    return sent;
  };
  if (lane === "ordinary") {
    player.gold = () => 100n;
    behavior.cost = async () => atomCost;
    behavior.hasActiveMaritimeInvasion = () => false;
    behavior.isUnderHeavyAttack = () => false;
    behavior.isRetaliationNukeTarget = () => false;
    const construction = Object.create(sandbox.__StructureBehavior.prototype);
    Object.assign(construction, { game, player });
    construction.hasActiveMaritimeInvasion = () => false;
    construction.economicConstructionPressure = () => null;
    construction.legendaryAtomWarChest = () => 0n;
    construction.offensiveNukeDefenseReserve = () => 60n;
    behavior.structureBehavior = construction;
  }
  try {
    if (lane === "ordinary") {
      await behavior.fireNukeFromCandidates(candidates, nukeTarget, selected, [silo], "Legendary");
    } else {
      behavior.freezeGiantStrikeTarget = () => nukeTarget;
      behavior.selectAffordableNuke = async () => selected;
      behavior.collectNukeCandidates = async () => candidates;
      await behavior.maybeFreezeGiantStrike([silo], "Legendary");
    }
    assert.equal(emitted.length, 1, `${lane}: launch the first atom now`);
    assert.equal(
      behavior._pendingNukeLaunches.length,
      1,
      `${lane}: queue the second atom required to overcome one SAM charge`,
    );
    const queuedAtom = behavior._pendingNukeLaunches[0];
    assert.equal(queuedAtom.salvo.plannedCoveringLevel, 1);
    assert.equal(queuedAtom.salvo.totalBombs, 2, `${lane}: the plan requires two Atom shots`);
    assert.equal(queuedAtom.nukeType, UNIT.AtomBomb);
    assert.ok(queuedAtom.dueTick > world.tick, `${lane}: the second Atom is delayed`);
    assert.equal(firedAtomTicks.length, 1, `${lane}: the first Atom occupies one of two slots`);

    if (lane === "ordinary") {
      player.gold = () => 100_000_000n;
      const mirv = new sandbox.__MirvBehavior({ chance: () => false }, game, player, {
        maybeSendAttackEmoji() {},
        sendEmoji() {},
      });
      mirv.cost = async () => 1n;
      mirv.teamHasWon = () => false;
      mirv.selectWinFixMirvTarget = () => nukeTarget;
      mirv.wasRecentlyMirved = () => false;
      let mirvLaunches = 0;
      mirv.maybeSendMIRV = async () => {
        mirvLaunches++;
        return true;
      };
      assert.equal(
        [...sharedNukeLedger.slots(game, player, null, true).values()].reduce(
          (total, count) => total + count,
          0,
        ),
        0,
        "the shared projection reserves the queued Atom after acknowledging the first launch",
      );
      assert.equal(mirv.hasReadyMIRVSlot(), false, "the queued Atom uses the final projected slot");
      assert.equal(
        await mirv.considerMIRV(),
        false,
        "a delayed salvo Atom reserves the Silo's last slot against an otherwise eligible MIRV",
      );
      assert.equal(mirvLaunches, 0, "MIRV eligibility rejects before attempting a launch");
      behavior.rearmAbortedSamDemand = () => {};
      behavior.finishPendingNukePass(new Set([queuedAtom.salvo.salvoId]), [queuedAtom], []);
      assert.equal(
        [...sharedNukeLedger.slots(game, player, null, true).values()].reduce(
          (total, count) => total + count,
          0,
        ),
        1,
        "aborting a queued salvo releases its claim and returns the still-free Silo slot",
      );
      assert.equal(mirv.hasReadyMIRVSlot(), true, "MIRV can use the slot after the salvo aborts");
    }
  } finally {
    launchSink = null;
    buildMenu = previousBuildMenu;
    sandbox.sendAutoBotBuildOrUpgrade = stubBuildSender;
    sandbox.autoBotBuildClaimNukeLaunches = undefined;
    sandbox.autoBotBuildReleaseNukeLaunchClaim = undefined;
    sandbox.autoBotBuildNukeSlots = undefined;
  }
}
sandbox.currentDifficulty = previousSalvoDifficulty;

{
  const { game, nukeTarget, behavior, world, player } = makeSalvoWorld();
  player.units = () => [];
  const pinnedSam = world.sam("freeze-demand-sam", 1);
  nukeTarget.units = (type) => (type === UNIT.SAMLauncher ? [pinnedSam] : []);
  const giant = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  game.players = () => [nukeTarget, giant];
  const request = {
    need: 4,
    targetSamId: pinnedSam.id(),
    targetTile: 20,
    unblockedSiloIds: [],
  };
  sandbox.state.nukeWantSlots = request;
  let frozenTarget = null;
  behavior.freezeGiantStrikeTarget = () => giant;
  behavior.collectNukeCandidates = async () => {
    throw new Error("a demand pinned to another player must stop the freeze lane");
  };
  behavior.sendNuke = async (_tile, _type, target) => {
    frozenTarget = target;
  };
  behavior.coveringSamsForSamFreeTarget = () => [];
  const samCleanupTargets = [];
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  behavior.maybeDestroyEnemySam = async (target) => {
    samCleanupTargets.push(target);
    return maybeDestroyEnemySam(target);
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.strictEqual(frozenTarget, null, "a pinned SAM demand prevents the giant fallback shot");
  assert.deepEqual(
    samCleanupTargets,
    [],
    "a SAM demand pinned to another player suppresses giant SAM cleanup",
  );
  assert.strictEqual(
    sandbox.state.nukeWantSlots,
    request,
    "a freeze-giant fallback cannot clear a live SAM demand pinned to another target",
  );
  sandbox.state.nukeWantSlots = null;
}

{
  const { game, nukeTarget, behavior, world, player } = makeSalvoWorld();
  player.units = () => [];
  const pinnedSam = world.sam("freeze-same-target-sam", 1);
  nukeTarget.units = (type) => (type === UNIT.SAMLauncher ? [pinnedSam] : []);
  game.players = () => [nukeTarget];
  const request = {
    need: 4,
    targetSamId: pinnedSam.id(),
    targetTile: 20,
    unblockedSiloIds: [],
  };
  sandbox.state.nukeWantSlots = request;
  behavior.freezeGiantStrikeTarget = () => nukeTarget;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.collectNukeCandidates = async () => [];
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [] });
  behavior.selectBuildableNukeCandidate = async () => null;
  const samCleanupTargets = [];
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  behavior.maybeDestroyEnemySam = async (target) => {
    samCleanupTargets.push(target);
    return maybeDestroyEnemySam(target);
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.deepEqual(
    samCleanupTargets,
    [nukeTarget],
    "a freeze strike may service a SAM demand pinned to its own target",
  );
  sandbox.state.nukeWantSlots = null;
}

{
  const { nukeTarget, behavior, player } = makeSalvoWorld();
  player.units = () => [];
  sandbox.state.nukeWantSlots = null;
  behavior.freezeGiantStrikeTarget = () => nukeTarget;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.collectNukeCandidates = async () => [];
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [] });
  behavior.selectBuildableNukeCandidate = async () => null;
  const samCleanupTargets = [];
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  behavior.maybeDestroyEnemySam = async (target) => {
    samCleanupTargets.push(target);
    return maybeDestroyEnemySam(target);
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.deepEqual(
    samCleanupTargets,
    [nukeTarget],
    "without a pinned SAM demand the freeze fallback still checks the selected giant",
  );
  sandbox.state.nukeWantSlots = null;
}

{
  const { nukeTarget, behavior, player } = makeSalvoWorld();
  const maybeDestroyEnemySam = behavior.maybeDestroyEnemySam.bind(behavior);
  const silo = { isUnderConstruction: () => false };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  const previousDifficulty = sandbox.currentDifficulty;
  const previousHardGate = sandbox.isAtLeastHardDifficulty;
  sandbox.currentDifficulty = () => "Easy";
  sandbox.isAtLeastHardDifficulty = () => false;
  behavior.canConsiderNukes = () => true;
  behavior.findBestNukeTarget = () => nukeTarget;
  behavior.isValidNukeTarget = () => true;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.collectCandidatesWithRetry = async () => ({
    list: [{ tile: 30, value: 100 }],
    retargeted: null,
  });
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [{ tile: 30, value: 100 }] });
  behavior.selectBuildableNukeCandidate = async () => ({ tile: 30, value: 100 });
  behavior.nukeHasPositiveExpectedValue = async () => true;
  behavior.sendNuke = async () => true;
  behavior.maybeDestroyEnemySam = async () => false;
  behavior.maybeFirePostSalvoHydrogen = async () => false;
  let freezeCalls = 0;
  behavior.maybeFreezeGiantStrike = async () => {
    freezeCalls += 1;
  };
  try {
    await behavior.maybeSendNuke();
    assert.equal(
      freezeCalls,
      0,
      "the freeze lane is skipped after the ordinary lane successfully fires",
    );
    behavior.selectBuildableNukeCandidate = async () => null;
    await behavior.maybeSendNuke();
    assert.equal(
      freezeCalls,
      1,
      "the freeze lane remains available when the ordinary lane has no shot",
    );
    sandbox.currentDifficulty = () => "Hard";
    sandbox.isAtLeastHardDifficulty = () => true;
    const targetSam = { id: () => 91, level: () => 1, isUnderConstruction: () => false };
    nukeTarget.units = (type) => (type === UNIT.SAMLauncher ? [targetSam] : []);
    behavior.createSamOverwhelmPlan = () => ({ capacityMissing: true });
    behavior.rememberFailedSamTarget = () => ({ targetSamId: targetSam.id() });
    behavior.maybeUpgradeHelpfulSilo = async () => true;
    behavior.maybeDestroyEnemySam = maybeDestroyEnemySam;
    freezeCalls = 0;
    await behavior.maybeSendNuke();
    assert.equal(
      freezeCalls,
      0,
      "a targeted Silo upgrade prevents the freeze lane from spending its capacity",
    );

    const partialPlan = {
      targetTile: 20,
      targetSamId: targetSam.id(),
      totalBombs: 2,
      coveringSamLevels: 1,
      coveringSamIds: [],
      siloEntries: [],
      window: [],
      launchSequence: [],
    };
    behavior.createSamOverwhelmPlan = () => partialPlan;
    behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 0] });
    behavior.hasPendingNukeLaunches = () => false;
    let partialSends = 0;
    behavior.sendNuke = async () => ++partialSends === 1;
    behavior.queueDelayedNukeLaunch = () => false;
    sandbox.state.nukeWantSlots = null;
    freezeCalls = 0;
    await behavior.maybeSendNuke();
    assert.equal(partialSends, 2, "the ordinary lane attempts both bombs in the partial salvo");
    assert.equal(
      freezeCalls,
      0,
      "a partially sent SAM salvo suppresses the same-tick freeze fallback",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    sandbox.isAtLeastHardDifficulty = previousHardGate;
    sandbox.state.nukeWantSlots = null;
  }
}

{
  const { game, nukeTarget, behavior, player } = makeSalvoWorld();
  player.units = () => [];
  const giant = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  game.players = () => [nukeTarget, giant];
  behavior.freezeGiantStrikeTarget = () => giant;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  let candidateOwner = null;
  behavior.collectNukeCandidates = async (target) => {
    candidateOwner = target;
    return [{}];
  };
  behavior.collectCandidatesWithRetry = async () => {
    throw new Error("the freeze fallback must not use value-directed retargeting");
  };
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [{}] });
  behavior.selectBuildableNukeCandidate = async () => ({ tile: 30 });
  let strikeTarget = null;
  let cleanupTarget = null;
  behavior.sendNuke = async (_tile, _type, target) => {
    strikeTarget = target;
    return true;
  };
  behavior.maybeDestroyEnemySam = async (target) => {
    cleanupTarget = target;
  };
  await behavior.maybeFreezeGiantStrike([], "Legendary");
  assert.strictEqual(candidateOwner, giant, "the freeze fallback scores only the selected giant");
  assert.strictEqual(strikeTarget, giant, "the freeze fallback strikes the selected giant");
  assert.strictEqual(cleanupTarget, giant, "SAM cleanup remains aligned with the selected giant");
  sandbox.state.nukeWantSlots = null;
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
// the inner or outer radius flips the tile negative; the exact boundary survives
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
    units: (type) => {
      ownUnitsCalls++;
      // Real players filter by type; the snapshot sweep asks per type.
      return type === UNIT.MissileSilo ? ownStructures : [];
    },
  };
  const teammate = {
    smallID: () => 2,
    team: () => "blue",
    isAlive: () => true,
    units: (type) => (type === UNIT.City ? teammateStructures : []),
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
    ownUnitsCalls > callsAfterFirstSweep,
    true,
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
  // outer radius: the engine destroys it just as completely as an inner hit.
  ownStructures = [
    { type: () => UNIT.MissileSilo, level: () => 1, tile: () => tileOf(529, 500), owner: () => me },
  ];
  scoreTick++;
  const outerScore = scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb);
  assert.equal(
    outerScore,
    innerScore,
    "both positions destroy the same silo and incur the same replacement penalty",
  );
  assert.ok(
    outerScore < enemyOnlyScore,
    "an outer-radius clip is still penalized against a clean enemy tile",
  );
  ownStructures[0].tile = () => tileOf(531, 500);
  scoreTick++;
  assert.equal(
    scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb),
    enemyOnlyScore,
    "a structure just past the outer boundary carries no loss penalty",
  );
  ownStructures[0].tile = () => tileOf(530, 500);
  scoreTick++;
  assert.equal(
    scorer.nukeTileScore(candidate, silos, enemyStructures, UNIT.AtomBomb),
    innerScore,
    "a structure exactly on the outer boundary is destroyed too and carries the same penalty",
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
  assert.equal(emitted.length, failedProbe - 1, "no later bomb overtakes a failed immediate probe");
  assert.equal(behavior._pendingNukeLaunches.length, 4 - failedProbe);
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

// A retrying queue head must retain its native silo slot before its tail fires.
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  const emitted = [];
  launchSink = emitted;
  const buildables = player.buildables;
  let probes = 0;
  player.buildables = (...args) => (++probes === 1 ? [] : buildables(...args));
  behavior._pendingNukeLaunches = [20, 21].map((flightTicks) => ({
    dueTick: world.tick,
    tile: 20,
    nukeType: UNIT.AtomBomb,
    targetPlayer: nukeTarget,
    salvo: { salvoId: 123, flightTicks },
  }));
  behavior.getAbortedSalvoIds = () => new Set();
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "the tail cannot claim the retrying head's silo slot",
  );
  assert.equal(probes, 1);
  assert.equal(emitted.length, 0);
  world.tick++;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(emitted.length, 2);
  assert.equal(behavior.hasPendingNukeLaunches(), false);
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
  const startSalvo = () =>
    behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: waits.length,
        siloEntries: [],
        launchSequence: waits.map(() => ({ flightTicks: 20 })),
      },
      nukeTarget,
      1n,
    );
  if (delayedFirst) {
    assert.equal(await startSalvo(), true, "a delayed head also queues the immediate tail");
    world.tick = 805;
    await assert.rejects(behavior.processPendingNukeLaunches(), (error) => error === failure);
    assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true);
    nukeTarget.isAlive = () => false;
    world.tick = 801;
    assert.equal(await behavior.processPendingNukeLaunches(), false);
    assert.equal(behavior.hasPendingNukeLaunches(), false);
  } else {
    await assert.rejects(startSalvo(), (error) => error === failure);
  }
  assert.equal(sandbox.state.nukeWantSlots, null, "no stale capacity reservation survives");
}

// The finisher must follow actual launches, not the original schedule when
// processing stalls or a launch is retried.
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  let liveFlight = 45;
  player.units = () => [{}];
  behavior.getAvailableSiloEntries = () => [{ flightTicks: liveFlight }];
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
  assert.equal(
    sandbox.state.postSalvoHydrogen.dueTick,
    850,
    "an immediate shot updates the finisher from its emission-time source flight",
  );
  world.tick++;
  liveFlight = 65;
  const buildables = player.buildables;
  player.buildables = async () => [];
  assert.equal(await behavior.processPendingNukeLaunches(), false);
  assert.equal(
    behavior._pendingNukeLaunches[0].salvo.flightTicks,
    20,
    "a rejected quote retains the queued forecast until an actual dispatch",
  );
  assert.equal(sandbox.state.postSalvoHydrogen.dueTick, 850);
  player.buildables = buildables;
  world.tick++;
  assert.equal(await behavior.processPendingNukeLaunches(), true);
  assert.equal(
    sandbox.state.postSalvoHydrogen.dueTick,
    872,
    "a delayed shot propagates its refreshed flight through the pending finisher",
  );
}
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
    nukeMagnitudes: () => ({ inner: 80, outer: 100 }),
  });
  behavior.game.euclideanDistSquared = (a, b) => (a - b) * (a - b);
  // The finisher's enemy-value gate needs a priced structure at the target.
  world.targetSams.push(world.sam("finisher-target-sam", 1));
  launches.length = 0;
  behavior.player.gold = () => 10_000_000n;
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo
      ? [
          {
            isUnderConstruction: () => false,
            tile: () => 500,
            level: () => 1,
            type: () => UNIT.MissileSilo,
          },
        ]
      : [];
  behavior.player.buildables = async () => [
    { type: UNIT.HydrogenBomb, cost: 5_000_000n, canBuild: true },
  ];
  const totalNukesBefore = sandbox.state.stats.nukes;
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
  assert.equal(
    sandbox.state.stats.nukes,
    totalNukesBefore + 1,
    "one dispatched finisher is one total nuke",
  );
  assert.equal(sandbox.state.postSalvoHydrogen, null, "a fired finisher clears the schedule");
  assert.equal(await behavior.maybeFirePostSalvoHydrogen(), false);
  assert.equal(
    behavior.hydrogenBombsLaunched,
    1,
    "a repeated check cannot count the finisher again",
  );
}

{
  // Projected coverage: a SAM still under construction completes before any
  // in-flight bomb lands, so it must block the finisher like an armed one.
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  behavior.player.gold = () => 10_000_000n;
  behavior.getPerceivedNukeCost = async () => 5_000_000n;
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo
      ? [
          {
            isUnderConstruction: () => false,
            tile: () => 500,
            level: () => 1,
            type: () => UNIT.MissileSilo,
          },
        ]
      : [];
  behavior.player.buildables = async () => [
    { type: UNIT.HydrogenBomb, cost: 5_000_000n, canBuild: true },
  ];
  const wipSam = world.sam("enemy-sam-wip", 2);
  wipSam.isUnderConstruction = () => true;
  world.covering.push({ unit: wipSam, distSquared: 0 });
  sandbox.state.postSalvoHydrogen = {
    targetTile: 20,
    dueTick: world.tick,
    targetSmallID: nukeTarget.smallID(),
  };
  assert.equal(
    await behavior.maybeFirePostSalvoHydrogen(),
    false,
    "a SAM under construction already blocks the Hydrogen finisher",
  );
  assert.deepEqual(launches, [], "nothing launched into projected coverage");
  sandbox.state.postSalvoHydrogen = null;
}

launchSink = null;

// ════════════════════════════════════════════════════════════════════════════
// 5. A live capacity demand pins the strike to its remembered SAM and re-arms
// after a mid-flight abort; satisfaction follows the planner gate
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, nukeTarget, behavior, player } = makeSalvoWorld();
  const decoy = world.sam("decoy-sam", 1);
  const priority = world.sam("priority-sam", 3);
  world.targetSams.push(decoy, priority);
  player.units = (type) =>
    type === UNIT.MissileSilo ? [{ isUnderConstruction: () => false }] : [];
  sandbox.state.nukeWantSlots = {
    need: 5,
    targetSamId: "priority-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  behavior.createSamOverwhelmPlan = (sam) => ({ planFor: sam.id() });
  const firedPlans = [];
  behavior.fireSamSalvo = async (plan) => {
    firedPlans.push(plan.planFor);
    return true;
  };
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.deepEqual(
    firedPlans,
    ["priority-sam"],
    "a live capacity demand pins the strike to its remembered SAM",
  );
  sandbox.state.nukeWantSlots = null;
}
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  world.targetSams.push(world.sam("pinned-sam", 3));
  sandbox.state.nukeWantSlots = {
    need: 5,
    targetSamId: "pinned-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  assert.equal(
    behavior.samDemandStrikeTarget(),
    nukeTarget,
    "a live demand pins the maybeSendNuke strike target",
  );
  sandbox.state.nukeWantSlots = {
    ...sandbox.state.nukeWantSlots,
    pendingLaunches: true,
  };
  assert.equal(
    behavior.samDemandStrikeTarget(),
    null,
    "an in-flight salvo does not re-pin the ordinary lane",
  );
  sandbox.state.nukeWantSlots = null;
  assert.equal(behavior.samDemandStrikeTarget(), null);
}
{
  const { world, nukeTarget, behavior } = makeSalvoWorld();
  world.targetSams.push(world.sam("retry-pinned-sam", 3));
  sandbox.state.nukeWantSlots = {
    need: 5,
    targetSamId: "retry-pinned-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  const candidates = [{ tile: 20, value: 1, score: 1 }];
  let retries = 0;
  behavior.collectNukeCandidates = async () => candidates;
  behavior.retryWithHigherValueTarget = async () => {
    retries++;
    return { target: { smallID: () => 3 }, candidates: [] };
  };
  const result = await behavior.collectCandidatesWithRetry(
    nukeTarget,
    { type: UNIT.AtomBomb, cost: 1n },
    [],
    "Legendary",
  );
  assert.equal(result.list, candidates, "the pinned target keeps its own candidate list");
  assert.equal(result.retargeted, null, "a live SAM demand is not redirected to another rival");
  assert.equal(retries, 0, "higher-value retry cannot replace the SAM demand target");
  sandbox.state.nukeWantSlots = null;
}
{
  const { world, game, player, behavior } = makeSalvoWorld();
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
  });
  game.units = () => [world.sam("demand-sam", 2)];
  const silo = {
    id: () => 1,
    level: () => 2,
    tile: () => 5,
    isUnderConstruction: () => false,
  };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 0n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => [{ cost: 20n, canUpgrade: true }];
  structures.rankNukeDemandSiloUpgrades = () => [{ silo }];
  structures.executeStructureUpgradeCandidate = async () => true;
  sandbox.state.nukeWantSlots = {
    need: 3,
    targetSamId: "demand-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  behavior.createSamOverwhelmPlan = () => ({ capacityMissing: false });
  behavior.isTrajectoryInterceptableBySam = () => false;
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    false,
    "a closing plan releases the demand even below the static level sum",
  );
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "satisfaction follows the planner gate, not the level sum",
  );
  sandbox.state.nukeWantSlots = {
    need: 2,
    targetSamId: "demand-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  behavior.createSamOverwhelmPlan = () => ({ capacityMissing: true });
  structures.maybeSpawnStructure = async () => false;
  await structures.maybeUpgradeSiloForNukeDemand();
  assert.notEqual(
    sandbox.state.nukeWantSlots,
    null,
    "reload/window gaps keep the demand alive despite the level sum",
  );
  sandbox.state.nukeWantSlots = null;
}
{
  // Unsatisfiable-demand release: with every silo at its level cap and the
  // nation silo budget exhausted, no upgrade or spawn can close the request.
  // The demand must release instead of pinning the surplus lane and the nuke
  // lanes to this SAM owner forever.
  const { world, game, player, behavior } = makeSalvoWorld();
  game.units = () => [world.sam("demand-sam", 2)];
  const maxedSilos = [1, 2, 3].map((id) => ({
    id: () => id,
    level: () => 5,
    tile: () => 5 + id,
    isUnderConstruction: () => false,
  }));
  player.units = (type) => (type === UNIT.MissileSilo ? maxedSilos : []);
  const structures = new sandbox.__StructureBehavior({}, game, player);
  structures.nukeBehavior = behavior;
  structures.availableGoldAfterReserve = () => 200n;
  structures.safeStructureCost = () => 20n;
  structures.economicConstructionPressure = () => ({ cost: 0n });
  structures.defensiveConstructionReserve = () => 0n;
  structures.buildableForUnits = async () => [];
  structures.rankNukeDemandSiloUpgrades = () => [];
  structures.maybeSpawnStructure = async () => {
    throw new Error("spawn must not run for an unsatisfiable demand");
  };
  behavior.createSamOverwhelmPlan = () => ({ capacityMissing: true });
  behavior.isTrajectoryInterceptableBySam = () => false;
  sandbox.state.nukeWantSlots = {
    need: 12,
    targetSamId: "demand-sam",
    at: 800,
    targetTile: 20,
    unblockedSiloIds: [],
  };
  assert.equal(
    await structures.maybeUpgradeSiloForNukeDemand(),
    false,
    "an unsatisfiable demand declines instead of spawning",
  );
  assert.equal(
    sandbox.state.nukeWantSlots,
    null,
    "a demand no upgrade or spawn can ever satisfy is released",
  );
}
{
  // Counterforce ordering: the anti-SAM lane must strip the umbrella that
  // actually shields target value (cost per shielded value), not merely the
  // cheapest launcher. A level-1 SAM covering nothing must not monopolize
  // atoms while a level-2 SAM over the City cluster stays unpinned.
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  const cheapSam = { id: () => "cheap", level: () => 1, tile: () => 900 };
  const umbrellaSam = { id: () => "umbrella", level: () => 2, tile: () => 20 };
  const city = { type: () => UNIT.City, level: () => 3, tile: () => 20 };
  nukeTarget.units = (type) => {
    if (type === UNIT.SAMLauncher) return [cheapSam, umbrellaSam];
    if (type === UNIT.City) return [city];
    return [];
  };
  game.euclideanDistSquared = (a, b) => (a === b ? 0 : 999_999);
  game.config = () => ({
    isUnitDisabled: () => false,
    maxSamRange: () => 150,
    samRange: () => 150,
    defaultNukeSpeed: () => 1,
  });
  const silo = {
    id: () => 1,
    level: () => 2,
    tile: () => 5,
    isUnderConstruction: () => false,
  };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  behavior.createSamOverwhelmPlan = (sam) => ({
    capacityMissing: true,
    targetSamId: sam.id(),
    targetTile: sam.tile(),
    coveringSamIds: new Set([sam.id()]),
    totalBombs: sam.level() + 1,
    siloEntries: [],
  });
  behavior.maybeUpgradeHelpfulSilo = async () => {};
  await behavior.maybeDestroyEnemySam(nukeTarget);
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "umbrella",
    "the salvo demand pins the SAM that shields the target's value, not the cheapest one",
  );
  sandbox.state.nukeWantSlots = null;
  behavior._samDemandRequest = null;
}
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  const replacement = world.sam("replacement", 3);
  world.covering.push({ unit: replacement, distSquared: 0 });
  world.targetSams.push(replacement);
  behavior.samSalvoStillViable = () => false;
  player.units = (type) =>
    type === UNIT.MissileSilo
      ? [{ id: () => 1, level: () => 1, tile: () => 5, isUnderConstruction: () => false }]
      : [];
  behavior.createSamOverwhelmPlan = (sam) => ({
    targetTile: 20,
    targetSamId: sam.id(),
    coveringSamIds: new Set([sam.id()]),
    totalBombs: 5,
    siloEntries: [],
  });
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 5, {
      salvoId: 7,
      plannedCoveringLevel: 1,
      targetTile: 20,
      targetSamId: "original",
      flightTicks: 20,
    }),
    true,
  );
  sandbox.state.nukeWantSlots = { ...reservation(), targetSamId: "original" };
  world.tick = 805;
  await behavior.processPendingNukeLaunches();
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "replacement",
    "a mid-flight abort re-arms the demand against the live layout",
  );
  assert.equal(
    sandbox.state.nukeWantSlots?.need,
    5,
    "the re-armed demand prices the live covering SAM",
  );
  assert.equal(
    sandbox.state.nukeWantSlots?.pendingLaunches,
    undefined,
    "the re-armed demand can be serviced by the structure lane",
  );
  sandbox.state.nukeWantSlots = null;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Per-launch salvo revalidation on Legendary: a SAM spawned during the
// awaited probe drops the entry; the planned covering set stays exempt
// ════════════════════════════════════════════════════════════════════════════
{
  const { world, player, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  player.units = (type) =>
    type === UNIT.MissileSilo
      ? [{ id: () => 1, level: () => 1, tile: () => 5, isUnderConstruction: () => false }]
      : [];
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excluded) =>
    !(excluded && excluded.has("sam-A")) &&
    world.covering.some((sam) => sam.unit.id() === "late-sam");
  for (let index = 0; index < 2; index++) {
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
        salvoId: 91,
        targetTile: 20,
        targetSamId: "sam-A",
        plannedCoveringLevel: 1,
        flightTicks: 20,
        coveringSamIds: ["sam-A"],
      }),
      true,
    );
  }
  world.covering.push({ unit: world.sam("sam-A", 1), distSquared: 0 });
  world.targetSams.push(world.sam("sam-A", 1));
  sandbox.state.nukeWantSlots = { ...reservation(), targetSamId: "sam-A" };
  const originalProbe = behavior.probeNukeBuildable.bind(behavior);
  behavior.probeNukeBuildable = async (tile, type) => {
    world.covering.push({ unit: world.sam("late-sam", 3), distSquared: 30 });
    return originalProbe(tile, type);
  };
  behavior.createSamOverwhelmPlan = (sam) => ({
    targetTile: 20,
    targetSamId: sam.id(),
    coveringSamIds: new Set(),
    totalBombs: 9,
    siloEntries: [],
  });
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "a SAM spawned mid-probe aborts the salvo pass",
  );
  assert.equal(launches.length, 0, "no atom launches through the new interception");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "aborted entries are dropped, not retried");
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "sam-A",
    "the aborted salvo re-arms its demand instead of stranding the prefix",
  );
  assert.equal(sandbox.state.nukeWantSlots?.need, 9);
  sandbox.currentDifficulty = previousDifficulty;
  sandbox.state.nukeWantSlots = null;
}
{
  const { world, game, nukeTarget, behavior } = makeSalvoWorld();
  launches.length = 0;
  launchSink = launches;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  game.config = () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    isUnitDisabled: () => false,
    SAMCooldown: () => 100,
  });
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excluded) =>
    !(excluded && excluded.has("sam-A"));
  const samA = world.sam("sam-A", 1);
  samA.missileTimerQueue = () => [805];
  world.covering.push({ unit: samA, distSquared: 0 });
  world.targetSams.push(world.sam("sam-A", 1));
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
      salvoId: 93,
      targetTile: 20,
      targetSamId: "sam-A",
      plannedCoveringLevel: 1,
      flightTicks: 20,
      coveringSamIds: ["sam-A"],
    }),
    true,
  );
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    true,
    "the covering SAM the salvo overwhelms must not abort its own salvo",
  );
  assert.equal(launches.length, 1);
  launches.length = 0;
  assert.equal(
    behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
      salvoId: 94,
      targetTile: 20,
      targetSamId: "sam-A",
      plannedCoveringLevel: 1,
      flightTicks: 20,
      coveringSamIds: [],
    }),
    true,
  );
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "an empty exemption set cannot launch through the covering SAM",
  );
  assert.equal(launches.length, 0);
  assert.equal(behavior._pendingNukeLaunches.length, 0);
  sandbox.currentDifficulty = previousDifficulty;
  sandbox.state.nukeWantSlots = null;
  launchSink = null;
}

{
  const { behavior, nukeTarget } = makeSalvoWorld();
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 0] });
  behavior.hasPendingNukeLaunches = () => false;
  let sends = 0;
  behavior.sendNuke = async () => ++sends === 1;
  behavior.queueDelayedNukeLaunch = () => false;
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        targetSamId: 2,
        totalBombs: 2,
        coveringSamLevels: 1,
        coveringSamIds: [],
        siloEntries: [],
        window: [],
        launchSequence: [],
      },
      nukeTarget,
      1n,
    ),
    true,
    "a partially sent ordinary salvo still suppresses a second freeze strike this tick",
  );
  assert.equal(sends, 2, "the salvo reports the first send after the second send and queue fail");
}

{
  const { game, nukeTarget, behavior, world, player } = makeSalvoWorld();
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const requestedSam = world.sam("ready-demand-sam", 1);
  world.targetSams.push(requestedSam);
  player.units = (type) =>
    type === UNIT.MissileSilo
      ? [{ id: () => "silo-1", level: () => 2, isUnderConstruction: () => false }]
      : [];
  const ordinaryTarget = {
    smallID: () => 3,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    units: () => [],
  };
  game.players = () => [nukeTarget, ordinaryTarget];
  behavior.isValidNukeTarget = () => true;
  behavior.isValidNukeDestination = () => true;
  behavior.canConsiderNukes = () => true;
  behavior.findBestNukeTarget = () => ordinaryTarget;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.collectCandidatesWithRetry = async (target) => ({
    list: [{ tile: 40, value: 100 }],
    retargeted: target,
  });
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [{ tile: 40, value: 100 }] });
  const clearShotTargets = [];
  behavior.fireLegendaryClearFallthrough = async (_clear, target) => {
    clearShotTargets.push(target);
    return true;
  };
  const salvoTargets = [];
  behavior.maybeDestroyEnemySam = async (target) => {
    salvoTargets.push(target);
    return true;
  };
  behavior.rememberFailedSamTarget({
    targetSamId: requestedSam.id(),
    targetTile: 20,
    totalBombs: 2,
    coveringSamIds: new Set([requestedSam.id()]),
    siloEntries: [{ silo: { id: () => "silo-1" }, interceptable: false }],
  });
  behavior.structureBehavior = { samOverwhelmPlanStillMissing: () => false };
  // The structure phase closes its shared request once the salvo fits.
  sandbox.state.nukeWantSlots = null;
  await behavior.maybeSendNuke();
  assert.deepEqual(
    salvoTargets,
    [nukeTarget],
    "a capacity-ready SAM demand survives structure-phase closure and is serviced first",
  );
  assert.deepEqual(
    clearShotTargets,
    [],
    "a clear Legendary shot at another player cannot bypass a ready SAM salvo",
  );
  sandbox.currentDifficulty = previousDifficulty;
  sandbox.state.nukeWantSlots = null;
}

{
  const { game, player, behavior } = makeSalvoWorld();
  const tribe = {
    smallID: () => 2,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    type: () => sandbox.PlayerType.Bot,
  };
  const human = { ...tribe, smallID: () => 3, type: () => sandbox.PlayerType.Human };
  const nation = { ...tribe, smallID: () => 4, type: () => sandbox.PlayerType.Nation };
  assert.equal(behavior.isValidNukeTarget(tribe), true, "generic Bot ownership remains valid");
  assert.equal(behavior.isEligibleNukeTarget(tribe), false, "tribes are not nuclear recipients");
  assert.equal(behavior.isEligibleNukeTarget(human), true, "human targets remain eligible");
  assert.equal(behavior.isEligibleNukeTarget(nation), true, "nation targets remain eligible");
  const tribeSam = {
    id: () => "tribe-sam",
    isAlive: () => true,
    owner: () => tribe,
  };
  tribe.units = (type) => (type === UNIT.SAMLauncher ? [tribeSam] : []);
  assert.equal(
    behavior.samDemandOwner(tribe, "tribe-sam").owner,
    undefined,
    "a Bot-owned SAM does not create a Silo-capacity demand for an illegal recipient",
  );
  game.owner = () => tribe;
  assert.equal(
    behavior.isValidNukeDestination(20, false),
    true,
    "tribe-owned territory remains a valid destination when the recipient is different",
  );

  const relations = [
    { relation: sandbox.Relation.Hostile, player: tribe },
    { relation: sandbox.Relation.Hostile, player: human },
    { relation: sandbox.Relation.Hostile, player: nation },
  ];
  player.allRelationsSorted = () => relations;
  assert.equal(
    behavior.findHostileNukeTarget(true),
    human,
    "production hostile selection skips an illegal Bot recipient and continues to a Human",
  );
  behavior.findDominantCrownNukeTarget = () => null;
  behavior.findAllyNukeTarget = () => null;
  behavior.findFFACrownTarget = () => null;
  behavior.findStrongestTeamTarget = () => null;
  behavior.findLegendaryStructureTarget = () => null;
  assert.equal(
    behavior.findNukeRelationTarget(sandbox.Difficulty.Hard),
    human,
    "the production target ladder continues after an illegal Bot hostile",
  );

  game.players = () => [player, tribe, human, nation];
  tribe.units = () => [{ value: 100 }];
  human.units = () => [{ value: 50 }];
  nation.units = () => [{ value: 75 }];
  behavior.nukeStructureValue = (structure) => structure.value;
  assert.equal(
    behavior.findHighestValueNukeTarget(null),
    nation,
    "highest-value selection skips a richer Bot recipient and continues to a Nation",
  );

  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Hard";
  game.players = () => [player, tribe];
  try {
    assert.equal(behavior.findBestNukeTarget(), null, "the selector never returns a Bot tribe");
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

{
  const { game, player, behavior } = makeSalvoWorld();
  const target = {
    smallID: () => 2,
    team: () => null,
    isAlive: () => true,
    isPlayer: () => true,
    type: () => sandbox.PlayerType.Human,
  };
  game.owner = () => target;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Easy";
  behavior.nukeLaunchRouteViable = () => true;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  let policyChecks = 0;
  behavior.attackBehavior.shouldAttack = () => ++policyChecks === 1;
  player.buildables = async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  launches.length = 0;
  launchSink = launches;
  try {
    assert.equal(
      behavior.isEligibleNukeTarget(target),
      true,
      "target selection accepts its one policy result",
    );
    assert.equal(await behavior.sendNuke(20, UNIT.AtomBomb, target), true);
    assert.equal(policyChecks, 1, "launch revalidation does not reroll Easy attack policy");
    assert.equal(launches.length, 1);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Human;
  game.owner = () => nukeTarget;
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Easy";
  behavior.nukeLaunchRouteViable = () => true;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    nukeTarget.type = () => sandbox.PlayerType.Bot;
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  launches.length = 0;
  launchSink = launches;
  try {
    assert.equal(await behavior.sendNuke(20, UNIT.AtomBomb, nukeTarget), false);
    assert.equal(launches.length, 0, "a target that becomes a tribe during the probe is rejected");
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  let friendlyLand = false;
  behavior.observeHostileNukeThreats = () => {};
  behavior.isEligibleNukeTarget = () => true;
  behavior.isValidNukeDestination = () => true;
  behavior.probeNukeBuildable = async () => {
    friendlyLand = true;
    return { type: UNIT.AtomBomb, cost: 1n };
  };
  behavior.nukeBuildableCanLaunch = () => true;
  behavior.shouldHoldCounterforceNuke = async () => false;
  behavior.blastHitsFriendlyLand = () => friendlyLand;
  behavior.nukeLaunchRouteViable = () => true;
  let emitted = 0;
  behavior.emitNukeWithSalvoFlight = () => {
    emitted++;
    return true;
  };
  assert.equal(
    await behavior.sendNuke(20, UNIT.AtomBomb, nukeTarget),
    false,
    "ordinary launch rechecks friendly blast ownership after the async probe",
  );
  assert.equal(emitted, 0, "an ordinary nuke does not launch through friendly land");
}

for (const difficulty of ["Hard", "Legendary"]) {
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Nation;
  game.owner = () => nukeTarget;
  let samAppeared = false;
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = () => samAppeared;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    samAppeared = true;
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => difficulty;
  launches.length = 0;
  launchSink = launches;
  try {
    assert.equal(
      behavior.nukeLaunchRouteViable(20, UNIT.AtomBomb, nukeTarget, null),
      true,
      `${difficulty} initially permits the clear route`,
    );
    assert.equal(await behavior.sendNuke(20, UNIT.AtomBomb, nukeTarget), false);
    assert.equal(launches.length, 0, `${difficulty} rejects a route blocked during the probe`);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  sandbox.state.nukeWantSlots = null;
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 5, 10] });
  let reservedCost = null;
  let sendAttempts = 0;
  behavior.shouldDeferNukeForEconomy = (_target, cost) => {
    reservedCost = cost;
    return cost > 1n;
  };
  behavior.sendNuke = async () => {
    sendAttempts++;
    return true;
  };
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 3,
        siloEntries: [],
        launchSequence: [{ flightTicks: 10 }, { flightTicks: 10 }, { flightTicks: 10 }],
      },
      nukeTarget,
      1n,
    ),
    false,
    "a salvo that would consume the protected gold reserve is deferred as a whole",
  );
  assert.equal(reservedCost, 3n, "the reserve policy sees every atom in the salvo");
  assert.equal(sendAttempts, 0, "a deferred salvo emits no partial strike");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "a deferred salvo leaves no queued tail");
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  sandbox.state.nukeWantSlots = null;
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 5] });
  behavior.blastHitsFriendlyLand = () => true;
  let sendAttempts = 0;
  behavior.sendNuke = async () => {
    sendAttempts++;
    return false;
  };
  assert.equal(
    await behavior.fireSamSalvo({ targetTile: 20, totalBombs: 2 }, nukeTarget, 1n),
    false,
    "a salvo whose aim is already unsafe is rejected before launch or queueing",
  );
  assert.equal(sendAttempts, 0);
  assert.equal(behavior._pendingNukeLaunches.length, 0);
}

{
  const { nukeTarget, behavior } = makeSalvoWorld();
  let friendlyLand = false;
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 5] });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.blastHitsFriendlyLand = () => friendlyLand;
  behavior.sendNuke = async () => {
    friendlyLand = true;
    return false;
  };
  assert.equal(
    await behavior.fireSamSalvo({ targetTile: 20, totalBombs: 2 }, nukeTarget, 1n),
    false,
    "a newly allied blast is not enqueued as a retry after the async launch check",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 0);
}

for (const difficulty of ["Hard", "Impossible", "Legendary"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Nation;
  game.owner = () => nukeTarget;
  const plannedSamId = `${difficulty}-planned-sam`;
  const newSamId = `${difficulty}-new-sam`;
  const newSamUnderConstruction = difficulty === "Legendary";
  const routeSamIds = new Set([plannedSamId]);
  let blockDuringProbe = true;
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = (_spawn, _tile, excludedSamIds, options = {}) =>
    [...routeSamIds].some(
      (samId) =>
        !excludedSamIds?.has(samId) &&
        (samId !== newSamId ||
          !newSamUnderConstruction ||
          options.includeUnderConstruction === true),
    );
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    if (blockDuringProbe) routeSamIds.add(newSamId);
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => difficulty;
  const emitted = [];
  launchSink = emitted;
  const salvo = {
    salvoId: difficulty,
    targetTile: 20,
    flightTicks: 20,
    coveringSamIds: [plannedSamId],
  };
  try {
    assert.equal(behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, salvo), true);
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 10, salvo),
      true,
      `${difficulty} has a future tail behind the due launch`,
    );
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      `${difficulty} keeps a queued salvo from launching through a route-only SAM`,
    );
    assert.equal(
      emitted.length,
      0,
      `${difficulty} has no destination SAM to hide the route blocker`,
    );
    assert.equal(
      behavior._pendingNukeLaunches.length,
      0,
      "a route blocker appearing during the probe drops the full salvo including its future tail",
    );
    routeSamIds.delete(newSamId);
    blockDuringProbe = false;
    assert.equal(
      behavior.queueDelayedNukeLaunch(20, UNIT.AtomBomb, nukeTarget, 0, {
        ...salvo,
        salvoId: `${difficulty}-clear`,
      }),
      true,
    );
    world.tick++;
    assert.equal(await behavior.processPendingNukeLaunches(), true, "the clear route can retry");
    assert.equal(emitted.length, 1);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

for (const difficulty of ["Hard", "Impossible"]) {
  const { world, game, player, nukeTarget, behavior } = makeSalvoWorld();
  nukeTarget.isPlayer = () => true;
  nukeTarget.type = () => sandbox.PlayerType.Nation;
  const center = { x: 5, y: 5 };
  let friendlyLand = false;
  let markFriendlyDuringProbe = true;
  game.owner = (tile) => (tile.x === center.x && tile.y === center.y ? nukeTarget : null);
  game.players = () => [player, nukeTarget];
  player.isFriendly = (other) => other.smallID?.() === player.smallID();
  game.config = () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ outer: 1 }),
  });
  Object.assign(game, {
    x: (tile) => tile.x,
    y: (tile) => tile.y,
    ref: (x, y) => ({ x, y }),
    isValidCoord: () => true,
    ownerID: (tile) => (friendlyLand && tile.x === 6 && tile.y === 5 ? 1 : 0),
  });
  behavior.nukeSpawn = () => 11;
  behavior.isTrajectoryInterceptableBySam = () => false;
  behavior.rememberSuccessfulNukeLaunch = async () => {};
  player.buildables = async () => {
    if (markFriendlyDuringProbe) friendlyLand = true;
    return [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }];
  };
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => difficulty;
  sandbox.state.nukeWantSlots = null;
  const emitted = [];
  launchSink = emitted;
  try {
    assert.equal(
      behavior.queueDelayedNukeLaunch(center, UNIT.AtomBomb, nukeTarget, 0, {
        salvoId: `friendly-land-${difficulty}`,
        targetTile: center,
        flightTicks: 20,
        coveringSamIds: [],
      }),
      true,
    );
    assert.equal(
      behavior.queueDelayedNukeLaunch(center, UNIT.AtomBomb, nukeTarget, 20, {
        salvoId: `friendly-land-${difficulty}`,
        targetTile: center,
        flightTicks: 20,
        coveringSamIds: [],
      }),
      true,
    );
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      `${difficulty} rechecks blast ownership after the queued launch probe`,
    );
    assert.equal(emitted.length, 0, "no queued salvo launches through current friendly land");
    assert.equal(
      behavior._pendingNukeLaunches.length,
      0,
      "a newly unsafe blast is dropped instead of retrying and blocking the nuclear lane",
    );
    friendlyLand = false;
    markFriendlyDuringProbe = false;
    world.tick++;
    assert.equal(
      await behavior.processPendingNukeLaunches(),
      false,
      "the dropped salvo is not retried",
    );
    assert.equal(emitted.length, 0);
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
    launchSink = null;
  }
}

{
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  const incomingTarget = { smallID: () => 3, isAlive: () => true };
  player.units = () => [];
  behavior.nukeLaneBlockedByCapacity = () => false;
  behavior.samDemandStrikeTarget = () => nukeTarget;
  behavior.attackBehavior.findIncomingAttackPlayer = () => incomingTarget;
  behavior.isEligibleNukeTarget = (target) => target !== null;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  let selectedTarget = null;
  behavior.collectCandidatesWithRetry = async (target) => {
    selectedTarget = target;
    return { list: [], retargeted: null };
  };
  behavior.fireNukeFromCandidates = async () => true;
  await behavior.maybeSendNuke();
  assert.equal(
    selectedTarget,
    incomingTarget,
    "immediate retaliation keeps survival priority over a pending Silo-capacity demand",
  );
  let fireTarget = null;
  behavior.fireNukeFromCandidates = async (_candidates, target) => {
    fireTarget = target;
    return true;
  };
  behavior.collectCandidatesWithRetry = async (target) => {
    selectedTarget = target;
    return { list: [], retargeted: { smallID: () => 4, isAlive: () => true } };
  };
  await behavior.maybeSendNuke();
  assert.equal(
    fireTarget,
    incomingTarget,
    "the dispatch preserves the survival target over both the demand and candidate retarget",
  );
}

function makeIncomingNukePriorityCase(hasDemand = false) {
  const { player, nukeTarget, behavior } = makeSalvoWorld();
  const incomingTarget = { smallID: () => 3, isAlive: () => true };
  const richerTarget = { smallID: () => 4, isAlive: () => true };
  const collectedTargets = [];
  const fireAttempts = [];
  player.units = () => [];
  behavior.nukeLaneBlockedByCapacity = () => false;
  behavior.samDemandStrikeTarget = () => (hasDemand ? nukeTarget : null);
  behavior.attackBehavior.findIncomingAttackPlayer = () => incomingTarget;
  behavior.isEligibleNukeTarget = (target) => target !== null;
  behavior.selectAffordableNuke = async () => ({ type: UNIT.AtomBomb, cost: 1n });
  behavior.shouldDeferNukeForEconomy = () => false;
  behavior.findHighestValueNukeTarget = () => richerTarget;
  behavior.playerStructureValue = (target) => (target === richerTarget ? 5_000_000 : 1_000_000);
  behavior.collectNukeCandidates = async (target) => {
    collectedTargets.push(target);
    let tile = "demand-tile";
    if (target === incomingTarget) {
      tile = "attacker-tile";
    } else if (target === richerTarget) {
      tile = "richer-rival-tile";
    }
    return [
      {
        tile,
        value: 100,
        score: target === richerTarget ? 200 : 100,
      },
    ];
  };
  behavior.fireNukeFromCandidates = async (candidates, target) => {
    fireAttempts.push({ target, tile: candidates[0]?.tile });
    return false;
  };
  return { behavior, incomingTarget, richerTarget, nukeTarget, collectedTargets, fireAttempts };
}

{
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const test = makeIncomingNukePriorityCase(true);
  test.behavior.fireNukeFromCandidates = async (candidates, target) => {
    test.fireAttempts.push({ target, tile: candidates[0]?.tile });
    return true;
  };
  try {
    await test.behavior.maybeSendNuke();
    assert.deepEqual(test.collectedTargets, [test.incomingTarget]);
    assert.deepEqual(
      test.fireAttempts,
      [{ target: test.incomingTarget, tile: "attacker-tile" }],
      "a fireable attacker candidate keeps its own target and tile without pivoting",
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

for (const fallbackKind of ["sam-demand", "higher-value"]) {
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const test = makeIncomingNukePriorityCase(fallbackKind === "sam-demand");
  const fallbackTarget = fallbackKind === "sam-demand" ? test.nukeTarget : test.richerTarget;
  test.behavior.fireNukeFromCandidates = async (candidates, target) => {
    test.fireAttempts.push({ target, tile: candidates[0]?.tile });
    return target === fallbackTarget;
  };
  try {
    await test.behavior.maybeSendNuke();
    assert.deepEqual(test.collectedTargets, [test.incomingTarget, fallbackTarget]);
    assert.deepEqual(
      test.fireAttempts,
      [
        { target: test.incomingTarget, tile: "attacker-tile" },
        {
          target: fallbackTarget,
          tile: fallbackKind === "sam-demand" ? "demand-tile" : "richer-rival-tile",
        },
      ],
      `${fallbackKind} fallback fires its own collected target and tile after attacker rejection`,
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

{
  const previousDifficulty = sandbox.currentDifficulty;
  sandbox.currentDifficulty = () => "Legendary";
  const test = makeIncomingNukePriorityCase(true);
  test.behavior.fireNukeFromCandidates = async (candidates, target) => {
    test.fireAttempts.push({ target, tile: candidates[0]?.tile });
    return target === test.richerTarget;
  };
  try {
    await test.behavior.maybeSendNuke();
    assert.deepEqual(
      test.collectedTargets,
      [test.incomingTarget, test.nukeTarget, test.richerTarget],
      "Legendary tries its higher-value target after the SAM-demand fallback cannot fire",
    );
    assert.deepEqual(
      test.fireAttempts.map(({ target }) => target),
      [test.incomingTarget, test.nukeTarget, test.richerTarget],
    );
  } finally {
    sandbox.currentDifficulty = previousDifficulty;
  }
}

{
  const { game, behavior } = makeSalvoWorld();
  let includedUnderConstruction = false;
  game.nearbyUnits = (_tile, _radius, _type, _predicate, include) => {
    includedUnderConstruction = include;
    return [];
  };
  behavior.hasReachableSamAtTrajectoryIndex(20, [], 0, undefined, {
    includeUnderConstruction: true,
  });
  assert.equal(
    includedUnderConstruction,
    true,
    "route interception queries request SAMs under construction during salvo revalidation",
  );
}

{
  const { behavior, world } = makeSalvoWorld();
  const wipSam = world.sam("aborted-route-sam-wip", 1);
  wipSam.isUnderConstruction = () => true;
  world.covering.push({ unit: wipSam, distSquared: 0 });
  behavior.isValidNukeTarget = () => true;
  const covering = behavior.abortedSamCoverage({ tile: 20 });
  assert.equal(
    covering[0]?.id(),
    wipSam.id(),
    "aborted capacity demand keeps projected SAM coverage alive for re-arming",
  );
}

{
  // Demand serviced first — but only when it coincides with the lane objective.
  const { behavior } = makeSalvoWorld();
  const demandTarget = { smallID: () => 7, isAlive: () => true };
  behavior.samDemandStrikeTarget = () => demandTarget;
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [], routeBlockedTile: null });
  const demandCalls = [];
  behavior.maybeDestroyEnemySam = async (...args) => {
    demandCalls.push(args);
    return true;
  };
  let clearCalls = 0;
  behavior.fireLegendaryClearFallthrough = async () => {
    clearCalls++;
    return false;
  };
  assert.equal(
    await behavior.fireNukeFromCandidates(
      [],
      demandTarget,
      { type: UNIT.AtomBomb, cost: 1n },
      [],
      "Legendary",
    ),
    true,
    "a matching demand is serviced before any clear-shot lane",
  );
  assert.deepEqual(demandCalls, [[demandTarget, false, null]]);
  assert.equal(clearCalls, 0, "a serviced demand consumes the lane before the clear fallthrough");
}

{
  // The demand lane declining yields the silo to the lane objective.
  const { behavior } = makeSalvoWorld();
  const demandTarget = { smallID: () => 7, isAlive: () => true };
  behavior.samDemandStrikeTarget = () => demandTarget;
  behavior.partitionCandidatesBySamCoverage = () => ({ clear: [], routeBlockedTile: null });
  const demandCalls = [];
  behavior.maybeDestroyEnemySam = async (...args) => {
    demandCalls.push(args);
    return false;
  };
  const clearTargets = [];
  behavior.fireLegendaryClearFallthrough = async (_clear, target) => {
    clearTargets.push(target);
    return true;
  };
  assert.equal(
    await behavior.fireNukeFromCandidates(
      [],
      demandTarget,
      { type: UNIT.AtomBomb, cost: 1n },
      [],
      "Legendary",
    ),
    true,
    "a declined demand yields the silo to the lane objective",
  );
  assert.deepEqual(demandCalls, [[demandTarget, false, null]]);
  assert.deepEqual(clearTargets, [demandTarget]);
}

{
  const { game, player, nukeTarget, behavior } = makeSalvoWorld();
  const silo = {
    id: () => 9,
    level: () => 3,
    tile: () => 10,
    missileTimerQueue: () => [],
    isUnderConstruction: () => false,
  };
  player.units = (type) => (type === UNIT.MissileSilo ? [silo] : []);
  game.manhattanDist = (from, to) => Math.abs(from - to);
  sandbox.autoBotBuildClaimNukeLaunches = sharedNukeLedger.claim;
  sandbox.autoBotBuildReleaseNukeLaunchClaim = sharedNukeLedger.release;
  sandbox.autoBotBuildNukeSlots = sharedNukeLedger.slots;
  behavior.getSamSalvo = () => ({ bombsToFire: 2, waits: [0, 0] });
  behavior.hasPendingNukeLaunches = () => false;
  behavior.blastHitsFriendlyLand = () => true;
  sandbox.state.nukeWantSlots = null;
  const ledgerCapacity = () =>
    [...sharedNukeLedger.slots(game, player, null, true).values()].reduce(
      (total, count) => total + count,
      0,
    );
  assert.equal(
    await behavior.fireSamSalvo(
      {
        targetTile: 20,
        totalBombs: 2,
        siloEntries: [],
        launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }],
      },
      nukeTarget,
      20n,
    ),
    false,
    "a salvo whose start check rejects after claiming cannot fire",
  );
  assert.equal(
    ledgerCapacity(),
    3,
    "a start-check rejection releases every unqueued claim back to the ledger",
  );
  assert.equal(behavior._pendingNukeLaunches.length, 0);
  assert.equal(sandbox.state.nukeWantSlots, null);
  sandbox.autoBotBuildClaimNukeLaunches = undefined;
  sandbox.autoBotBuildReleaseNukeLaunchClaim = undefined;
  sandbox.autoBotBuildNukeSlots = undefined;
}

await import("./nuke-campaign-scenario.mjs");
process.stdout.write("nuke salvo recheck tests passed\n");
