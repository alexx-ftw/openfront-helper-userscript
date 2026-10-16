// Deterministic artificial worlds drive production planners together. This is
// not a replay or a substitute for a browser/worker integration test.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const UNIT = Object.fromEntries(
  [
    "City",
    "Port",
    "Factory",
    "SAMLauncher",
    "MissileSilo",
    "DefensePost",
    "AtomBomb",
    "HydrogenBomb",
    "MIRV",
    "MIRVWarhead",
    "Warship",
  ].map((key) => [key, key]),
);
const emitted = [];
const sandbox = {
  UNIT,
  Difficulty: { Impossible: "Impossible", Legendary: "Legendary" },
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  Relation: { Hostile: 0 },
  state: { settings: { winFixes: true }, stats: { nukes: 0, builds: 0 } },
  currentDifficulty: () => "Impossible",
  autoBotBuildAllowed: () => true,
  WORKER_TIMEOUT_MS: 1000,
  withTimeout: async (promise) => promise,
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  sendAutoBotBuildOrUpgrade: (_menu, buildable, tile) => {
    emitted.push({ upgrade: buildable.canUpgrade, tile });
    return true;
  },
  setLastAction() {},
  tr: (key) => key,
  EMOJI_NUKE: [],
  console,
};
sandbox.globalThis = sandbox;
executeClassicScript(readRepositoryFile("engine/ingame/shared-utils.js"), sandbox);
executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/nukeBehavior.js")}\n` +
    `${readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js")}\n` +
    "globalThis.NuclearSimulation = { NukeBehavior, StructureBehavior };",
  sandbox,
);
const { NukeBehavior, StructureBehavior } = sandbox.NuclearSimulation;
let tick = 100;
let hostile = true;
const target = { smallID: () => 2, isAlive: () => true };
const silo = (id, level, building = false) => ({
  id: () => id,
  level: () => level,
  tile: () => Number(id),
  isUnderConstruction: () => building,
  missileTimerQueue: () => [tick + 20],
});
let silos = [silo("1", 1), silo("2", 4), silo("3", 1, true)];
const player = {
  smallID: () => 1,
  gold: () => 100n,
  units: (type) => (type === UNIT.MissileSilo ? silos : []),
};
const game = { ticks: () => tick, config: () => ({ isUnitDisabled: () => false }) };
const nuke = new NukeBehavior(
  { chance: () => false },
  game,
  player,
  { shouldAttack: () => hostile },
  {},
);
const structure = Object.create(StructureBehavior.prototype);
Object.assign(structure, { game, player });
// Worker quotes and economic context are deterministic boundaries; selection,
// ranking, demand scoping, validation and actuation remain production methods.
structure.availableGoldAfterReserve = () => 100n;
structure.safeStructureCost = () => 10n;
structure.economicConstructionPressure = () => ({ cost: 20n });
structure.defensiveConstructionReserve = () => 30n;
structure.buildableForUnits = async (units) =>
  units.map((unit) => ({
    type: UNIT.MissileSilo,
    canBuild: false,
    canUpgrade: unit.id(),
    cost: 10n,
  }));
const failed = nuke.rememberFailedSamTarget({
  targetTile: 90,
  coveringSamIds: new Set(["sam"]),
  totalBombs: 2,
  siloEntries: [
    { silo: silos[0], interceptable: false },
    { silo: silos[1], interceptable: true },
  ],
});
assert.deepEqual(Array.from(failed.unblockedSiloIds), ["1"]);
assert.equal(await structure.maybeUpgradeSiloForNukeDemand(), true);
assert.deepEqual(
  emitted,
  [{ upgrade: "1", tile: undefined }],
  "capacity on a blocked route cannot suppress the useful route's upgrade",
);
silos = [silo("1", 2), silos[1], silos[2]];
assert.equal(await structure.maybeUpgradeSiloForNukeDemand(), false);
assert.equal(
  sandbox.state.nukeWantSlots,
  null,
  "cooldown is temporary: adequate installed capacity releases the upgrade request",
);
assert.equal(emitted.length, 1, "cooldown cannot trigger an unnecessary upgrade");
assert.equal(structure.nukeSiloUpgradeBudgetAvailable(59n, 10n), false);
assert.equal(
  structure.nukeSiloUpgradeBudgetAvailable(60n, 10n),
  true,
  "the exact gold boundary preserves both economic and defense reserves",
);
sandbox.state.nukeWantSlots = { need: 9, pendingLaunches: true };
assert.equal(
  structure.validNukeSiloUpgradeRequest(),
  null,
  "a launch plan retains ownership of its reservation during execution",
);

// Simulated ticks, never real sleeps: 17 simultaneous orders must drain with a
// bounded number of worker probes per tick, then release the shared reservation.
let sends = 0;
nuke.sendNuke = async () => {
  sends += 1;
  return true;
};
for (let index = 0; index < 17; index += 1) {
  assert.equal(nuke.queueDelayedNukeLaunch(index, UNIT.AtomBomb, target, 0), true);
}
for (let step = 0; step < 6; step += 1) {
  const previous = sends;
  await nuke.processPendingNukeLaunches();
  assert.ok(sends - previous <= 3, "launch work stays within the per-pass intent budget");
  tick += 1;
}
assert.equal(sends, 17);
assert.equal(nuke.hasPendingNukeLaunches(), false);
assert.equal(sandbox.state.nukeWantSlots, null);
assert.equal(nuke.queueDelayedNukeLaunch(0, UNIT.AtomBomb, target, 1), true);
hostile = false;
tick += 1;
assert.equal(await nuke.processPendingNukeLaunches(), false);
assert.equal(
  nuke.hasPendingNukeLaunches(),
  false,
  "diplomacy invalidation drains queued work instead of retrying forever",
);
assert.equal(sends, 17);

// Independent brute-force oracle checks the maximum arrival-window cardinality.
// A fixed LCG supplies duplicate, shuffled and separated arrival times.
let seed = 0x5eed;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (let scenario = 0; scenario < 200; scenario += 1) {
  const bombs = Array.from({ length: random() % 35 }, () => ({ flightTicks: random() % 70 }));
  const spread = random() % 20;
  const expected = Math.max(
    0,
    ...bombs.map(
      (start) =>
        bombs.filter(
          (bomb) =>
            bomb.flightTicks >= start.flightTicks && bomb.flightTicks <= start.flightTicks + spread,
        ).length,
    ),
  );
  const original = bombs.map((bomb) => bomb.flightTicks);
  const result = nuke.findSamArrivalWindow(bombs, spread);
  assert.equal(result.length, expected, `arrival oracle scenario ${scenario}`);
  assert.deepEqual(
    bombs.map((bomb) => bomb.flightTicks),
    original,
    "planner does not mutate inputs",
  );
  if (result.length) assert.ok(result.at(-1).flightTicks - result[0].flightTicks <= spread);
}

// Timing is diagnostic, not a flaky shared-host pass/fail threshold. The oracle
// above remains the correctness assertion. A wide window exposes quadratic scans.
const bombs = Array.from({ length: 20_000 }, (_, index) => ({ flightTicks: index }));
const timings = [];
for (let run = 0; run < 7; run += 1) {
  const start = performance.now();
  assert.equal(nuke.findSamArrivalWindow(bombs, 20_000).length, bombs.length);
  timings.push(performance.now() - start);
}
timings.sort((left, right) => left - right);
process.stdout.write(
  JSON.stringify({
    suite: "nuclear-coordination-simulation",
    oracleScenarios: 200,
    queuedLaunches: sends,
    benchmarkCandidates: bombs.length,
    benchmarkMs: { median: Number(timings[3].toFixed(3)), max: Number(timings.at(-1).toFixed(3)) },
  }) + "\n",
);
