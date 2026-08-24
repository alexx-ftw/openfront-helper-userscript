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
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: (_menu, buildable, tile) => {
    if (launchSink) launchSink.push({ type: buildable.type, tile });
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
  EMOJI_NUKE: [],
  closestTwoTiles: (gm, x, y) => ({ x: x[0], y: y[0] }),
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(read("engine/ingame/shared-utils.js"), sandbox, {
  filename: "shared-utils.vm.js",
});
executeClassicScript(
  `${read("engine/ingame/auto-bot/nukeBehavior.js")}\nglobalThis.__NukeBehavior = NukeBehavior;`,
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

const reservation = () => ({
  need: 3,
  at: 800,
  targetTile: 20,
  unblockedSiloIds: [],
  pendingLaunches: true,
});

// ════════════════════════════════════════════════════════════════════════════
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
