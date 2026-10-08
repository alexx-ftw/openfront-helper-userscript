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

// Nuclear slot pressure must synchronize the structures planner with the
// nuke lane: a queued nuclear launch or a planned salvo slot request
// (nukeWantSlots) with zero ready silo shots upgrades a silo (a level is
// a reload slot) instead of leaving the surplus to the ordinary economy
// ladder. Any ready shot, absent pressure, disabled units, or winFixes
// off leaves the decision to the ordinary ladder.

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

// A planned salvo's slot request is slot pressure too.
{
  const { behavior, emitted } = makeWorld({
    queue: [5],
    level: 1,
  });
  assert.equal(
    await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
    true,
    "a planned salvo slot request upgrades the silo",
  );
  assert.equal(emitted.length, 1, "the slot-request upgrade reaches the menu");
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

console.log("silo nuclear slot pressure tests passed");
