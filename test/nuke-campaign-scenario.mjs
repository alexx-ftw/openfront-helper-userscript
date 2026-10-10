// Simulated multi-phase nuke campaign against one persistent synthetic world.
// Unlike the phase-isolated suites, this scenario runs the REAL flows in
// sequence on shared state — demand → salvo → mid-probe abort → re-arm →
// pinned strike → overlap suppression → coverage gate → friendly-land filter —
// and asserts the observable decisions at each phase, so interaction bugs
// between the PD32/PD33 enhancements surface as campaign failures.

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
const currentDifficulty = "Legendary";
const buildMenu = { sendBuildOrUpgrade() {} };
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
  EMOJI_NUKE: [],
  state: { settings: { winFixes: true }, stats: { nukes: 0, builds: 0 } },
  currentDifficulty: () => currentDifficulty,
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: (d) => d === "Legendary",
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => buildMenu,
  closestTwoTiles: (gm, x, y) => ({ x: x[0], y: y[0] }),
  within: (value, min, max) => Math.max(min, Math.min(max, value)),
  sendAutoBotBuildOrUpgrade: (menu, buildable, tile) => {
    menu.sendBuildOrUpgrade(buildable, tile);
    if (launchSink) launchSink.push({ type: buildable.type, tile });
    return true;
  },
  setLastAction: () => {},
  tr: (value) => value,
  console,
};
sandbox.globalThis = sandbox;

executeClassicScript(read("engine/ingame/shared-utils.js"), sandbox, {
  filename: "nuke-campaign-shared-utils.vm.js",
});
executeClassicScript(
  read("engine/ingame/auto-bot/nukeBehavior.js") + "\nglobalThis.__NukeBehavior = NukeBehavior;",
  sandbox,
  { filename: "nuke-campaign.vm.js" },
);

// The prod bundle resolves boundingBoxTiles from portutil.js, which this
// sandbox does not load; a perimeter ring of just the center keeps bounds
// checks focused on the scored tile.
sandbox.boundingBoxTiles = (gm, center) => [center];

// ── Persistent campaign world ────────────────────────────────────────────────
const tileOf = (x, y) => y * 100 + x;
const world = { tick: 900, covering: [], targetSams: [], warheads: [], terrain: {} };
const ownP = { smallID: () => 1 };
const nukeTarget = {
  smallID: () => 2,
  team: () => null,
  isAlive: () => true,
  isPlayer: () => true,
  units: (type) => (type === UNIT.SAMLauncher ? world.targetSams : []),
};
const defaultEnemy = { smallID: () => 2, isPlayer: () => true };
const player = {
  smallID: () => 1,
  team: () => null,
  gold: () => 1_000_000n,
  buildables: async () => [{ type: UNIT.AtomBomb, cost: 1n, canBuild: true }],
  units: (type) =>
    type === UNIT.MissileSilo
      ? [
          {
            id: () => 1,
            level: () => 1,
            tile: () => 5,
            isUnderConstruction: () => false,
            missileTimerQueue: () => [],
          },
        ]
      : [],
  // Mirrors PlayerImpl.isFriendly(other, treatAFKFriendly): only self is
  // friendly in this world, and only unconditionally for self.
  isFriendly: (o) => o === ownP,
};
const game = {
  ticks: () => world.tick,
  players: () => [ownP, nukeTarget],
  config: () => ({
    maxSamRange: () => 150,
    samRange: () => 150,
    SAMCooldown: () => 100,
    defaultNukeSpeed: () => 1,
    isUnitDisabled: () => false,
    nukeMagnitudes: () => ({ inner: 2, outer: 2 }),
  }),
  nearbyUnits: (_tile, _radius, type) => (type === UNIT.SAMLauncher ? world.covering : []),
  units: () => world.warheads,
  x: (tile) => tile % 100,
  y: (tile) => Math.floor(tile / 100),
  width: () => 100,
  height: () => 100,
  isValidCoord: (x, y) => x >= 0 && x < 100 && y >= 0 && y < 100,
  ref: (x, y) => tileOf(x, y),
  owner: (tile) => (tile in world.terrain ? world.terrain[tile] : defaultEnemy),
  ownerID: (tile) => {
    const owner = tile in world.terrain ? world.terrain[tile] : defaultEnemy;
    return owner ? owner.smallID() : 0;
  },
  euclideanDistSquared: (a, b) => {
    const dx = (a % 100) - (b % 100);
    const dy = Math.floor(a / 100) - Math.floor(b / 100);
    return dx * dx + dy * dy;
  },
};
const samUnit = (id, level) => ({
  id: () => id,
  level: () => level,
  tile: () => 20,
  owner: () => nukeTarget,
  type: () => UNIT.SAMLauncher,
});
const behavior = new sandbox.__NukeBehavior(
  { chance: () => false },
  game,
  player,
  { shouldAttack: () => true },
  { maybeSendEmoji() {} },
);
behavior.cost = async () => 1n;
behavior.nukeSpawn = () => 5;
behavior.isTrajectoryInterceptableBySam = () => false;
// Real plans carry the planned covering set (fireSamSalvo attaches it); the
// stub keeps that contract so exemption semantics stay production-shaped.
behavior.createSamOverwhelmPlan = (sam) => ({
  targetTile: 20,
  targetSamId: sam.id(),
  coveringSamIds: new Set(world.covering.map((entry) => entry.unit.id())),
  totalBombs: world.covering.reduce((sum, e) => sum + e.unit.level(), 0) + 1,
  siloEntries: [],
});

const SAM_A = samUnit("samA", 2);
launchSink = launches;

// ── Phase 1 — sized salvo launches its immediate atom and queues the tail ───
{
  world.covering.push({ unit: SAM_A, distSquared: 0 });
  world.targetSams.push(SAM_A);
  world.terrain[tileOf(20, 0)] = nukeTarget;
  sandbox.state.nukeWantSlots = null;
  behavior.getSamSalvo = () => ({ bombsToFire: 3, waits: [0, 1, 2] });
  const plan = {
    targetTile: 20,
    targetSamId: "samA",
    coveringSamIds: new Set(["samA"]),
    coveringSamLevels: 2,
    totalBombs: 3,
    siloEntries: [],
    launchSequence: [{ flightTicks: 20 }, { flightTicks: 20 }, { flightTicks: 20 }],
  };
  assert.equal(
    await behavior.fireSamSalvo(plan, nukeTarget, 1n),
    true,
    "P1: the sized salvo launches",
  );
  assert.equal(launches.length, 1, "P1: exactly the wait-0 atom launches immediately");
  assert.equal(behavior._pendingNukeLaunches.length, 2, "P1: the staggered tail is queued");
  assert.equal(sandbox.state.nukeWantSlots.need, 3, "P1: the salvo records its demand");
  assert.equal(sandbox.state.nukeWantSlots.pendingLaunches, true, "P1: demand marked in flight");
}

// ── Phase 2 — enemy builds a SAM during the probe: abort + re-arm ───────────
{
  launches.length = 0;
  const originalProbe = behavior.probeNukeBuildable.bind(behavior);
  behavior.probeNukeBuildable = async (tile, type) => {
    if (world.covering.every((entry) => entry.unit.id() !== "lateSam")) {
      const lateSam = samUnit("lateSam", 3);
      world.covering.push({ unit: lateSam, distSquared: 30 });
      world.targetSams.push(lateSam);
    }
    return originalProbe(tile, type);
  };
  world.tick = 905;
  assert.equal(
    await behavior.processPendingNukeLaunches(),
    false,
    "P2: the outgunned salvo aborts without firing",
  );
  assert.equal(launches.length, 0, "P2: no atom launches through the new defense");
  assert.equal(behavior._pendingNukeLaunches.length, 0, "P2: aborted entries are dropped");
  assert.equal(
    sandbox.state.nukeWantSlots?.targetSamId,
    "samA",
    "P2: the abort re-arms the demand against the live layout",
  );
  assert.equal(sandbox.state.nukeWantSlots?.need, 6, "P2: need repriced to covering levels 2+3+1");
  assert.equal(
    sandbox.state.nukeWantSlots?.pendingLaunches,
    undefined,
    "P2: the re-armed demand is serviceable again",
  );
}

// ── Phase 3 — the live demand pins the next strike to the SAM's owner ───────
{
  assert.equal(
    behavior.samDemandStrikeTarget(),
    nukeTarget,
    "P3: the re-armed demand pins the ordinary strike lane to the SAM owner",
  );
}

// ── Phase 4 — overlap suppression while a warhead is in flight ──────────────
{
  const context = {
    range: 2,
    target: nukeTarget,
    type: UNIT.AtomBomb,
    difficulty: sandbox.Difficulty.Hard,
  };
  world.warheads.push({
    targetTile: () => 20,
    type: () => UNIT.AtomBomb,
    owner: () => nukeTarget,
  });
  assert.equal(
    behavior.isNukeAlreadyLandingNear(20, UNIT.AtomBomb),
    true,
    "P4: the in-flight enemy warhead overlaps the aim tile",
  );
  assert.equal(
    behavior.isScorableNukeTile(20, context),
    -1,
    "P4: an overlapping aim tile is not scorable",
  );
  world.warheads.length = 0;
  assert.equal(
    behavior.isNukeAlreadyLandingNear(20, UNIT.AtomBomb),
    false,
    "P4: once the warhead lands, the aim tile stops being suppressed",
  );
}

// ── Phase 5 — enemy-land coverage gates the tile both ways ──────────────────
{
  const context = {
    range: 2,
    target: nukeTarget,
    type: UNIT.AtomBomb,
    difficulty: sandbox.Difficulty.Hard,
  };
  // Valid sampled tiles around (20,0): x 18..22 on row 0, the (±1,+1)
  // diagonal on row 1, plus (20,2) — 9 tiles at weight 2 inside a 26-weight
  // sampled disk (out-of-bounds rows still count as wasted, like water).
  for (let x = 15; x <= 25; x++) world.terrain[tileOf(x, 0)] = null;
  for (let x = 15; x <= 25; x++) world.terrain[tileOf(x, 1)] = null;
  world.terrain[tileOf(20, 2)] = null;
  assert.equal(
    behavior.isScorableNukeTile(20, context),
    -1,
    "P5: a blast landing mostly on water/unowned land is not scorable",
  );
  delete world.terrain[tileOf(19, 0)];
  delete world.terrain[tileOf(21, 0)];
  delete world.terrain[tileOf(22, 0)];
  world.terrain[tileOf(20, 0)] = nukeTarget;
  const coverage = behavior.isScorableNukeTile(20, context);
  assert.ok(
    Math.abs(coverage - 8 / 26) < 1e-9,
    `P5: with 4 of 6 valid tiles on enemy land the tile scores its coverage (got ${coverage})`,
  );
}

// ── Phase 6 — the winner filter refuses a blast over our own enclave ────────
{
  world.terrain[tileOf(31, 0)] = ownP;
  const probed = [];
  behavior.probeCanBuildNuke = async (tile) => {
    probed.push(tile);
    return true;
  };
  const picked = await behavior.selectBuildableNukeCandidate(
    [
      { tile: tileOf(30, 0), value: 10 },
      { tile: tileOf(40, 0), value: 5 },
    ],
    UNIT.AtomBomb,
  );
  assert.equal(picked.tile, tileOf(40, 0), "P6: the walk skips the friendly-blast candidate");
  assert.deepEqual(probed, [tileOf(40, 0)], "P6: the friendly-blast tile is never probed");
  world.terrain[tileOf(31, 0)] = undefined;
  delete world.terrain[tileOf(31, 0)];
}

process.stdout.write("nuke campaign scenario passed\n");
