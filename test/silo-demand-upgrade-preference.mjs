import assert from "node:assert/strict";
import { createStructureUpgradeFixture } from "./helpers/structure-upgrade-fixture.mjs";

// A live SAM-overwhelm demand must fund the route-eligible silo upgrade
// instead of spending the same gold on another level-one silo. A new silo
// stays correct only when no useful upgrade candidate exists (all capped or
// route-blocked).

const UNIT = {
  MissileSilo: "MissileSilo",
  SAMLauncher: "SAMLauncher",
};
const Difficulty = { LEGENDARY: "LEGENDARY" };

function makeWorld({ gold, upgradeCost, routes, canUpgrade = true, stubSpawn = true }) {
  let spawnCalls = 0;
  const silo = {
    id: () => 1,
    level: () => 1,
    isUnderConstruction: () => false,
    tile: () => 100,
  };
  const owner = { smallID: () => 2 };
  const targetSam = { id: () => "sam1", owner: () => owner, isActive: () => true };
  const state = {
    settings: { winFixes: true },
    stats: { builds: 0 },
    lastAction: null,
    nukeWantSlots: {
      need: 6,
      targetSamId: "sam1",
      at: 0,
      targetTile: 7,
      unblockedSiloIds: [1],
    },
  };
  const { behavior, emitted } = createStructureUpgradeFixture({
    UNIT,
    Difficulty,
    state,
  });
  behavior.game = {
    units: (type) => (type === UNIT.SAMLauncher ? [targetSam] : []),
    config: () => ({ isUnitDisabled: () => false }),
  };
  behavior.player = {
    units: (type) => (type === UNIT.MissileSilo ? [silo] : []),
    smallID: () => 1,
    isFriendly: () => false,
    isOnSameTeam: () => false,
  };
  behavior.nukeBehavior = {
    isValidNukeTarget: () => true,
    isValidNukeDestination: () => true,
    hasUsefulSiloUpgradeCapacity: () => true,
  };
  behavior.samOverwhelmPlanStillMissing = () => true;
  behavior.legendaryMissileDefenseUrgent = () => false;
  behavior.routeEligibleSilosForDemand = () => routes;
  behavior.availableGoldAfterReserve = () => gold;
  behavior.safeStructureCost = () => 1000n;
  behavior.buildableForUnits = async () => [{ canUpgrade, cost: upgradeCost }];
  behavior.economicConstructionPressure = () => null;
  behavior.defensiveConstructionReserve = () => 0n;
  behavior.siloSamProtectionScore = () => 0;
  behavior.tileInsideActiveHostileMissileImpact = () => false;
  if (stubSpawn) {
    behavior.maybeSpawnNukeDemandSilo = () => {
      spawnCalls++;
      return false;
    };
  }
  return { behavior, state, emitted, spawn: () => spawnCalls };
}

// A stale player-unit snapshot must not turn one accepted build intent into
// two Silos on the next pass for the same demand.
{
  const { behavior, emitted, state } = makeWorld({
    gold: 5000n,
    upgradeCost: 4000n,
    routes: [],
    stubSpawn: false,
  });
  behavior.game.ticks = () => 0;
  behavior.validNukeSiloUpgradeRequest = () => state.nukeWantSlots;
  behavior.missileSiloPhysicalCapReached = () => false;
  behavior.structureSpawnEligible = () => true;
  behavior.cost = () => 1000n;
  behavior.structureSpawnBuildable = async () => ({
    type: UNIT.MissileSilo,
    canBuild: 42,
    cost: 1000n,
  });
  behavior.nukeDemandSiloRouteClear = () => true;
  behavior.isUsableStructureBuildable = () => true;
  behavior.nukeSiloUpgradeBudgetAvailable = () => true;

  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), true);
  assert.equal(emitted.length, 1, "the first target-demand Silo intent is accepted");
  assert.equal(behavior.player.units(UNIT.MissileSilo).length, 1, "the unit snapshot is stale");
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), false);
  assert.equal(emitted.length, 1, "a stale unit snapshot cannot emit a duplicate Silo");
}

// Gold buys a new level-one silo but not the demanded upgrade: hold, spawn nothing.
{
  const { behavior, emitted, spawn } = makeWorld({
    gold: 1000n,
    upgradeCost: 4000n,
    routes: [{ id: () => 1 }],
  });
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), false);
  assert.equal(spawn(), 0, "the demand must not spend the upgrade budget on a new silo");
  assert.equal(emitted.length, 0);
}

// Gold covers the upgrade: level the useful silo.
{
  const { behavior, emitted, spawn } = makeWorld({
    gold: 5000n,
    upgradeCost: 4000n,
    routes: [{ id: () => 1 }],
  });
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), true);
  assert.equal(emitted.length, 1, "the demanded silo upgrade is emitted");
  assert.equal(spawn(), 0);
}

// One in-flight upgrade must reserve the silo until its updated level is
// visible; repeated passes against the stale snapshot must not upgrade twice.
{
  const { behavior, emitted } = makeWorld({
    gold: 5000n,
    upgradeCost: 4000n,
    routes: [{ id: () => 1 }],
  });
  behavior.game.ticks = () => 0;
  let resolveFirstProbe;
  let probeCount = 0;
  behavior.buildableForUnits = () => {
    probeCount++;
    return new Promise((resolve) => {
      if (probeCount === 1) resolveFirstProbe = resolve;
      else resolve([{ canUpgrade: true, cost: 4000n }]);
    });
  };

  const first = behavior.maybeUpgradeSiloForNukeDemand();
  const concurrent = behavior.maybeUpgradeSiloForNukeDemand();
  assert.equal(await concurrent, false, "a duplicate pass exits while the probe is in flight");
  resolveFirstProbe([{ canUpgrade: true, cost: 4000n }]);
  assert.equal(await first, true);
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), false);
  assert.equal(probeCount, 1, "the stale snapshot does not trigger another probe");
  assert.equal(emitted.length, 1, "the stale snapshot does not emit a duplicate upgrade");
}

// Every silo is route-blocked: the route-clear new silo remains the fallback.
{
  const { behavior, emitted, spawn } = makeWorld({ gold: 5000n, upgradeCost: 4000n, routes: [] });
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), false);
  assert.equal(spawn(), 1, "route-blocked demand still opens a route-clear silo");
  assert.equal(emitted.length, 0);
}

// An authoritative probe that rejects upgrading also keeps the spawn fallback.
{
  const { behavior, emitted, spawn } = makeWorld({
    gold: 5000n,
    upgradeCost: 4000n,
    routes: [{ id: () => 1 }],
    canUpgrade: false,
  });
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), false);
  assert.equal(spawn(), 1, "an un-upgradeable silo does not strand the demand");
  assert.equal(emitted.length, 0);
}

// Recheck the live SAM plan after the async buildability probe. A covering SAM
// can disappear during that probe, making the old request unnecessary.
{
  const { behavior, state, emitted, spawn } = makeWorld({
    gold: 5000n,
    upgradeCost: 4000n,
    routes: [{ id: () => 1 }],
  });
  let plannerChecks = 0;
  behavior.samOverwhelmPlanStillMissing = () => ++plannerChecks === 1;
  assert.equal(await behavior.maybeUpgradeSiloForNukeDemand(), false);
  assert.equal(plannerChecks, 2, "recheck planner demand after awaiting buildability");
  assert.equal(state.nukeWantSlots, null, "a closed demand releases its reservation");
  assert.equal(emitted.length, 0, "a stale SAM request does not upgrade a silo");
  assert.equal(spawn(), 0, "a stale SAM request does not build another silo");
}
