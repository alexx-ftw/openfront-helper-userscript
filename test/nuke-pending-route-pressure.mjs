import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const UNIT = { MissileSilo: "MissileSilo", AtomBomb: "AtomBomb" };
const state = { settings: { winFixes: true }, stats: { builds: 0 } };
const targetPlayer = { smallID: () => 2 };
const silo = {
  id: () => 1,
  level: () => 1,
  isUnderConstruction: () => false,
  missileTimerQueue: () => [5],
  tile: () => 100,
  type: () => UNIT.MissileSilo,
};
let routeChecks = 0;
let upgradeProbes = 0;
const behavior = executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js") +
    "\nObject.create(StructureBehavior.prototype);",
  {
    UNIT,
    Difficulty: { LEGENDARY: "LEGENDARY" },
    state,
    console,
    tr: (key) => key,
    getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
    sendAutoBotBuildOrUpgrade: () => true,
    isLegendaryDifficulty: () => true,
    playersArePermanentTeammates: () => false,
    autoBotBuildAllowed: () => true,
    withTimeout: async (_promise, _timeout, fallback) => fallback,
  },
);
behavior.game = {
  ticks: () => 1,
  config: () => ({ isUnitDisabled: () => false }),
};
behavior.player = { units: () => [silo] };
behavior.nukeBehavior = {
  _pendingNukeLaunches: [
    {
      dueTick: 0,
      tile: 900,
      nukeType: UNIT.AtomBomb,
      targetPlayer,
      salvo: null,
    },
  ],
  isValidNukeTarget: (player) => player.smallID() === 2,
  isValidNukeDestination: () => true,
  isTrajectoryInterceptableBySam: () => {
    routeChecks++;
    return true;
  },
};
behavior.legendaryReadyShotTotal = () => 0;
behavior.findBestStructureToUpgrade = async (silos) => {
  upgradeProbes++;
  return { structure: silos[0], bu: {} };
};
behavior.genericStructureUpgradeAllowed = () => true;
behavior.emitNuclearSlotPressureUpgrade = () => true;

assert.equal(
  await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
  false,
  "a queued launch behind an intercepting SAM must not trigger a Silo upgrade",
);
assert.equal(routeChecks > 0, true, "the queued target route is checked");
assert.equal(upgradeProbes, 0, "an intercepted route never reaches the upgrade probe");

routeChecks = 0;
upgradeProbes = 0;
behavior.nukeBehavior.isTrajectoryInterceptableBySam = () => {
  routeChecks++;
  return false;
};
assert.equal(
  await behavior.maybeUpgradeSiloForNuclearSlotPressure(),
  true,
  "a queued launch with a clear route can still trigger a Silo upgrade",
);
assert.equal(routeChecks > 0, true, "the clear route is checked too");
assert.equal(upgradeProbes, 1, "the eligible Silo reaches the upgrade probe");

const blockedSpawnTile = 101;
const clearSpawnTile = 102;
let rankedSpawnTiles = null;
behavior.nukeBehavior.isTrajectoryInterceptableBySam = (spawnTile) =>
  spawnTile === blockedSpawnTile;
behavior.structureProbeOptions = () => ({ candidateLimit: 2 });
behavior.structureCandidateTiles = () => [blockedSpawnTile, clearSpawnTile];
behavior.structureTileValueFunction = () => () => 0;
behavior.structurePlacementCompactnessRanker = () => () => 0;
behavior.structureMissileEmergency = () => null;
behavior.rankStructureSpawnTiles = (_type, _options, tiles) => {
  rankedSpawnTiles = tiles;
  return { scored: [], safeScored: [] };
};
behavior.probeRankedStructureTiles = () => null;
await behavior.structureSpawnTile(UNIT.MissileSilo, { nukePendingLaunchRoute: true });
assert.deepEqual(
  rankedSpawnTiles,
  [clearSpawnTile],
  "a new Silo is ranked only if its route to a queued target is clear",
);
