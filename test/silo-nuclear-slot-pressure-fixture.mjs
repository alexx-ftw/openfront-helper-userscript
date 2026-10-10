import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

// Plain-node fixture: the sandbox supplies the UNIT/Difficulty enums, exactly
// like nuke-salvo-recheck.mjs, so no engine TS import is needed.
const UNIT = {
  MissileSilo: "MissileSilo",
  AtomBomb: "AtomBomb",
  HydrogenBomb: "HydrogenBomb",
  MIRV: "MIRV",
  City: "City",
  SAMLauncher: "SAMLauncher",
};
const Difficulty = { LEGENDARY: "LEGENDARY" };

// Generic silo slot pressure handles queued launches only. An open
// nukeWantSlots request stays with its target-specific route and reserve
// checks, so this lane cannot upgrade a route-irrelevant silo after that
// request declines. Any ready shot, absent pressure, disabled units, or
// winFixes off leaves the decision to the ordinary ladder.

const script = readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js");

function makeWorld({ pending, queue, level, winFixes = true, siloDisabled = false }) {
  const emitted = [];
  const silo = {
    id: () => 1,
    level: () => level,
    isUnderConstruction: () => false,
    missileTimerQueue: () => queue,
    tile: () => 100,
    type: () => UNIT.MissileSilo,
  };
  const state = { settings: { winFixes }, stats: { builds: 0 }, lastAction: null };
  if (pending === undefined) state.nukeWantSlots = { need: 2 };
  const game = {
    ticks: () => 0,
    config: () => ({
      isUnitDisabled: (type) => siloDisabled && type === UNIT.MissileSilo,
      SiloCooldown: () => 500,
      SAMCooldown: () => 500,
    }),
  };
  const player = {
    units: (type) => (type === UNIT.MissileSilo ? [silo] : []),
  };
  const sandbox = {
    UNIT: UNIT,
    Difficulty,
    state,
    console,
    tr: (key) => key,
    setLastAction: (text, cat) => {
      state.lastAction = { text, cat };
    },
    getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
    sendAutoBotBuildOrUpgrade: (menu, bu) => {
      emitted.push(bu);
      return true;
    },
    isLegendaryDifficulty: () => true,
    playersArePermanentTeammates: () => false,
    autoBotBuildAllowed: () => true,
  };
  const behavior = executeClassicScript(
    script + "\nObject.create(StructureBehavior.prototype);",
    sandbox,
  );
  behavior.game = game;
  behavior.player = player;
  behavior.nukeBehavior = {
    _pendingNukeLaunches: pending === undefined ? [] : pending,
  };
  behavior.findBestStructureToUpgrade = async (structures) => {
    behavior.upgradeProbeCalls = (behavior.upgradeProbeCalls ?? 0) + 1;
    return structures.length > 0 ? { structure: structures[0], bu: {} } : null;
  };
  return { behavior, emitted, state };
}

// An open SAM-overwhelm request is owned by the target-specific demand lane.
{
  const { behavior, emitted } = makeWorld({
    queue: [5],
    level: 1,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "a generic upgrade cannot bypass target-specific route and reserve checks",
  );
  assert.equal(emitted.length, 0, "the request remains with the target-specific lane");
  assert.equal(behavior.upgradeProbeCalls ?? 0, 0, "the generic lane performs no silo probe");
}

// The same request with a ready shot stays with the ordinary ladder.
{
  const { behavior, emitted } = makeWorld({
    queue: [5],
    level: 2,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "a ready shot serves the requested salvo",
  );
  assert.equal(emitted.length, 0, "no upgrade while the request is served");
}

// Slot-starved queue releases the silo upgrade.
{
  const { behavior, emitted, state } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5],
    level: 1,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    true,
    "a queued launch with zero ready shots upgrades the silo",
  );
  assert.equal(emitted.length, 1, "the upgrade reaches the build menu");
  assert.equal(state.stats.builds, 1, "the upgrade is accounted as a build");
}

// No queued launches: the ordinary ladder keeps the surplus.
{
  const { behavior, emitted } = makeWorld({ pending: [], queue: [5], level: 1 });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "without a queued launch the ordinary ladder decides",
  );
  assert.equal(emitted.length, 0, "no upgrade without nuclear pressure");
}

// A ready shot drains the queue without new construction.
{
  const { behavior, emitted } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5],
    level: 2,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "a ready silo shot serves the queue without an upgrade",
  );
  assert.equal(emitted.length, 0, "no upgrade while a shot is ready");
}

// winFixes off restores the faithful behavior (no nuclear reservation).
{
  const { behavior, emitted } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5],
    level: 1,
    winFixes: false,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "winFixes off keeps the faithful ladder",
  );
  assert.equal(emitted.length, 0, "no upgrade without winFixes");
}

// Every silo maxed: the upgrade probe returns null and a NEW silo is the
// only remaining slot source for the waiting queue.
{
  const { behavior, emitted, state } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5, 5, 5],
    level: 3,
  });
  behavior.findBestStructureToUpgrade = async () => null;
  behavior.safeConstructionCost = () => 1000000n;
  behavior.spendableConstructionGold = () => 2000000n;
  const spawns = [];
  behavior.maybeSpawnStructure = async (type, options) => {
    spawns.push({ type, options });
    return true;
  };
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    true,
    "a queued launch with every silo maxed builds a new launcher",
  );
  assert.equal(spawns.length, 1, "the new-silo fallback reaches placement");
  assert.equal(spawns[0].type, UNIT.MissileSilo, "the fallback builds a silo");
  assert.equal(spawns[0].options.useActualCost, true, "the fallback pays the actual silo cost");
  assert.equal(emitted.length, 0, "no upgrade intent is emitted");
  assert.equal(state.stats.builds, 0, "the upgrade counter stays untouched");
}

// Maxed silos without the gold for a new launcher keep the ladder.
{
  const { behavior, emitted } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5, 5, 5],
    level: 3,
  });
  behavior.findBestStructureToUpgrade = async () => null;
  behavior.safeConstructionCost = () => 1000000n;
  behavior.spendableConstructionGold = () => 500000n;
  behavior.maybeSpawnStructure = async () => {
    throw new Error("placement must not run without the gold");
  };
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "a maxed network without surplus gold waits",
  );
  assert.equal(emitted.length, 0, "no construction without the gold");
}

// An upgradeable silo keeps the upgrade path ahead of new construction.
{
  const { behavior, emitted } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5],
    level: 1,
  });
  const spawns = [];
  behavior.safeConstructionCost = () => 1000000n;
  behavior.spendableConstructionGold = () => 2000000n;
  behavior.maybeSpawnStructure = async (type) => {
    spawns.push(type);
    return true;
  };
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    true,
    "an upgradeable silo upgrades instead of spawning a new one",
  );
  assert.equal(spawns.length, 0, "no new silo while an upgrade exists");
  assert.equal(emitted.length, 1, "the upgrade reaches the build menu");
}

// Synchronization: a launcher already under construction blocks stacking
// another one, even though the filtered probe list cannot see it.
{
  const { behavior } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5, 5, 5],
    level: 3,
  });
  behavior.findBestStructureToUpgrade = async () => null;
  behavior.safeConstructionCost = () => 1000000n;
  behavior.spendableConstructionGold = () => 2000000n;
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo
      ? [
          { isUnderConstruction: () => false, level: () => 3, missileTimerQueue: () => [5, 5, 5] },
          { isUnderConstruction: () => true },
        ]
      : [];
  const spawns = [];
  behavior.maybeSpawnStructure = async (type) => {
    spawns.push(type);
    return true;
  };
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "a pending launcher blocks stacking another construction",
  );
  assert.equal(spawns.length, 0, "no duplicate silo while one is pending");
}

// A network whose ONLY silo is still under construction is not upgradeable
// and not complete: no decision fires either way.
{
  const { behavior, emitted } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5, 5, 5],
    level: 3,
  });
  behavior.player.units = (type) =>
    type === UNIT.MissileSilo ? [{ isUnderConstruction: () => true }] : [];
  behavior.findBestStructureToUpgrade = async () => null;
  behavior.safeConstructionCost = () => 1000000n;
  behavior.spendableConstructionGold = () => 2000000n;
  behavior.maybeSpawnStructure = async (_type) => {
    throw new Error("placement must not run for an incomplete network");
  };
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "an incomplete-only network waits for its launcher",
  );
  assert.equal(emitted.length, 0, "no construction for an incomplete network");
}

// Silos disabled never emit the upgrade.
{
  const { behavior, emitted } = makeWorld({
    pending: [{ nukeType: UNIT.AtomBomb }],
    queue: [5],
    level: 1,
    siloDisabled: true,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    false,
    "disabled silos keep the ladder",
  );
  assert.equal(emitted.length, 0, "no upgrade for disabled silos");
}

process.stdout.write("silo nuclear slot pressure tests passed\n");
