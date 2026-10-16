    },
  ],
});
assert.deepEqual(
  Array.from(activeRouteTiles),
  [30, 20, 10, 99, 100],
  "Active missile placement searches from impact backward while preserving fallback capacity",
);

const originalScoredActiveMissileThreat = behavior.legendaryScoredActiveMissileThreat;
behavior.game.ownerID = (tile) => (tile === 777 ? own.smallID() : 0);
behavior.legendaryScoredActiveMissileThreat = (input) => input;
const territoryOnlyThreat = behavior.legendaryActiveMissileThreat(
  {
    isActive: () => true,
    owner: () => ({ smallID: () => 1234 }),
    targetTile: () => 777,
    tile: () => 700,
    type: () => UNIT.AtomBomb,
  },
  own.smallID(),
  {
    atomRadius: 10,
    hydrogenRadius: 20,
    structures: [],
    totalValue: 0,
  },
  [],
);
assert.equal(
  territoryOnlyThreat.exposure.targetsOwnedTerritory,
  true,
  "A hostile nuclear strike on owned territory remains a threat without exposed structures",
);
assert.equal(
  territoryOnlyThreat.exposure.value,
  1,
  "Territorial connectivity receives non-zero defensive value",
);
behavior.game.ownerID = originalThreatOwnerId;
behavior.legendaryScoredActiveMissileThreat = originalScoredActiveMissileThreat;

const originalThreatGameUnits = behavior.game.units;
const originalThreatGameTicks = behavior.game.ticks;
let enumeratedActiveMissileTypes = [];
// The missile-family reads ride the shared per-tick unit snapshot: same game
// object + same tick must observe the same unit list. Swapping the units stub
// mid-tick therefore advances the tick so each enumeration below is a fresh
// (recordable) snapshot read instead of a stale cache hit.
let threatGameUnitsTick = 9_001;
behavior.game.ticks = () => threatGameUnitsTick;
behavior.game.units = (...types) => {
  enumeratedActiveMissileTypes = types;
  return [];
};
threatGameUnitsTick += 1;
behavior.legendaryActiveMissileThreats({ samProfiles: [] });
assert.deepEqual(
  Array.from(enumeratedActiveMissileTypes),
  [UNIT.AtomBomb, UNIT.HydrogenBomb],
  "Generic trajectory interception enumerates only Atom and Hydrogen bombs",
);
threatGameUnitsTick += 1;
behavior.activeMirvDefenseDemands();
assert.deepEqual(
  Array.from(enumeratedActiveMissileTypes),
  [UNIT.MIRV, UNIT.MIRVWarhead],
  "MIRV carriers and warheads use the dedicated destination-geometry model",
);
let requestedMirvBlastType = null;
const mirvImpactZone = behavior.hostileMissileImpactZone(
  {
    isActive: () => true,
    owner: () => ({ smallID: () => 1234 }),
    targetTile: () => 777,
    type: () => UNIT.MIRV,
  },
  {
    nukeMagnitudes: (type) => {
      requestedMirvBlastType = type;
      return { outer: 18 };
    },
  },
  own.smallID(),
);
assert.equal(
  requestedMirvBlastType,
  UNIT.MIRVWarhead,
  "A MIRV carrier derives construction safety from the supported warhead magnitude",
);
assert.deepEqual(
  { ...mirvImpactZone },
  {
    targetTile: 777,
    radiusSquared: (1500 + 18) ** 2,
  },
  "An active MIRV reserves its full potential warhead field from doomed construction",
);
const originalMirvPlayerUnits = own.units;
const originalMirvDistance = behavior.game.euclideanDistSquared;
own.units = (...types) =>
  types.includes(UNIT.City)
    ? [makeUnit(120, 1), makeUnit(5000, 1)]
    : originalMirvPlayerUnits(...types);
behavior.game.euclideanDistSquared = (left, right) => (left - right) ** 2;
const carrierSiteDemands = [];
behavior.appendMirvCarrierSiteDemands(carrierSiteDemands, { id: () => 9000 }, 100, 200);
assert.deepEqual(
  carrierSiteDemands.map((demand) => demand.targetTile),
  [120],
  "A MIRV carrier creates preparation demand for each exposed strategic site, not one false central target",
);
assert.equal(
  carrierSiteDemands[0].carrierPreparation,
  true,
  "Carrier preparation remains distinct from exact separated-warhead destinations",
);

const territoryOnlyMirvBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const territoryOnlyMirvOwner = { smallID: () => 2 };
territoryOnlyMirvBehavior.player = {
  smallID: () => 1,
  isFriendly: () => false,
  isOnSameTeam: () => false,
  units: () => [],
};
territoryOnlyMirvBehavior.game = {
  units: () => [
    {
      isActive: () => true,
      owner: () => territoryOnlyMirvOwner,
      type: () => UNIT.MIRV,
      tile: () => 700,
      targetTile: () => 777,
    },
  ],
  ownerID: () => 1,
};
territoryOnlyMirvBehavior.activeMirvDeadlineTick = () => 20;
const territoryOnlyMirvDemands = territoryOnlyMirvBehavior.activeMirvDefenseDemands();
assert.equal(
  territoryOnlyMirvDemands.length,
  1,
  "an active hostile MIRV aimed at owned territory creates a defense demand without economic structures",
);
assert.equal(
  territoryOnlyMirvDemands[0].targetTile,
  777,
  "the structure-free MIRV demand uses the owned territorial destination",
);

const sameTickSiloSignalBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const sameTickEnemySilos = [];
const sameTickEnemy = {
  isPlayer: () => true,
  isAlive: () => true,
  smallID: () => 2,
  isFriendly: () => false,
  isOnSameTeam: () => false,
  units: (type) => (type === UNIT.MissileSilo ? sameTickEnemySilos : []),
};
sameTickSiloSignalBehavior.player = {
  smallID: () => 1,
  isFriendly: () => false,
  isOnSameTeam: () => false,
};
sameTickSiloSignalBehavior.game = {
  ticks: () => 900,
  players: () => [sameTickSiloSignalBehavior.player, sameTickEnemy],
  units: () => [],
};
assert.equal(
  sameTickSiloSignalBehavior.missileDefenseSignalSnapshot()?.hasBuiltHostileSilo,
  false,
  "a hostile Silo absent at the first same-tick read does not signal yet",
);
sameTickEnemySilos.push({
  isUnderConstruction: () => false,
  isActive: () => true,
  level: () => 1,
});
assert.equal(
  sameTickSiloSignalBehavior.missileDefenseSignalSnapshot()?.hasBuiltHostileSilo,
  true,
  "a hostile Silo built later in the same tick is visible to the signal snapshot",
);
const originalMirvManhattanDistance = behavior.game.manhattanDist;
behavior.game.manhattanDist = () => 49;
const mirvDeadlineBoundary = { targetTile: 120, deadlineTick: 100 };
assert.equal(
