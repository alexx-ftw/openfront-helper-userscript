// Mid-flight SAM-salvo re-validation and the friendly-fire blast penalty in
// NukeBehavior. Each block drives the real methods (fireSamSalvo,
// processPendingNukeLaunches, nukeTileScore) against synthetic game/player
// stubs and asserts the observable decision — fire vs abort, positive vs
// negative tile score — matches the documented intent of the enhancement.

import assert from "node:assert/strict";
import { readNukeBehaviorSource } from "#test/helpers/nuke-behavior-source.mjs";
import { readStructureBehaviorSource } from "#test/helpers/structure-behavior-source.mjs";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "#test/helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";
import { readLegendaryPlannerSource } from "#test/helpers/legendary-planner-source.mjs";

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
  `${readLegendaryPlannerSource()}\n${readStructureBehaviorSource()}\n${read("engine/ingame/auto-bot/mirvBehavior.js")}\n${readNukeBehaviorSource()}\nglobalThis.__NukeBehavior = NukeBehavior; globalThis.__StructureBehavior = StructureBehavior; globalThis.__MirvBehavior = MirvBehavior;`,
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
