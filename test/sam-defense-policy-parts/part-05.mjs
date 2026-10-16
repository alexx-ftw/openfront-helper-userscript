};
const enemyA = {
  smallID: () => 2,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 999_999n,
  units: (type) => (type === UNIT.SAMLauncher ? [makeUnit(201, 3), makeUnit(202, 1)] : []),
};
const enemyB = {
  smallID: () => 3,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 900_000n,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(301, 2), makeUnit(302, 2), makeUnit(303, 2)] : [],
};
const enemyC = {
  smallID: () => 4,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 900_000n,
  units: (type) =>
    type === UNIT.SAMLauncher ? [makeUnit(401, 9, { underConstruction: true })] : [],
};
let enemyTeamSamLevel = 12;
const enemyTeam = {
  smallID: () => 5,
  team: () => "blue",
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 5_000_000n,
  units: (type) => {
    if (type === UNIT.SAMLauncher) {
      const sam = makeUnit(501, enemyTeamSamLevel);
      sam.owner = () => enemyTeam;
      return [sam];
    }
    if (type === UNIT.MissileSilo) return [makeUnit(502, 1)];
    return [];
  },
};
const enemySilos = {
  smallID: () => 6,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 800_000n,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(601, 4), makeUnit(602, 2)] : []),
};
const enemySiloUnderConstruction = {
  smallID: () => 7,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 700_000n,
  units: (type) =>
    type === UNIT.MissileSilo ? [makeUnit(701, 99, { underConstruction: true })] : [],
};
const enemySingleLevelOneSilo = {
  smallID: () => 8,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(801, 1)] : []),
};
const enemySingleLevelTwoSilo = {
  smallID: () => 81,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(811, 2)] : []),
};
const enemyTwoLevelOneSilos = {
  smallID: () => 9,
  isPlayer: () => true,
  isAlive: () => true,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(901, 1), makeUnit(902, 1)] : []),
};
own.units = (type) => {
  if (type === UNIT.MissileSilo) return own.silos;
  if (type === UNIT.SAMLauncher) return own.sams;
  return [];
};
let samDisabled = false;

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
behavior.player = own;
// Most of this file exercises the post-launch defensive planner. Dedicated
// launch-gate coverage below starts from the real locked state.
behavior._hostileMissileLaunchObserved = true;
behavior.game = {
  players: () => [own, enemyA, enemyB, enemyC, enemyTeam, enemySilos, enemySiloUnderConstruction],
  config: () => ({
    isUnitDisabled: (type) => type === UNIT.SAMLauncher && samDisabled,
    gameConfig: () => ({ gameMode: "FFA" }),
    samRange: (level) => 50 * Number(level || 1),
  }),
};

const breakableAlly = {
  smallID: () => 10,
  team: () => null,
  isPlayer: () => true,
  isAlive: () => true,
  gold: () => 5_000_000n,
  units: (type) => (type === UNIT.MissileSilo ? [makeUnit(1_001, 1)] : []),
};
const diplomaticNuclearThreatBehavior = Object.create(sandbox.__StructureBehavior.prototype);
diplomaticNuclearThreatBehavior.player = {
  ...own,
  team: () => null,
  isFriendly: (other) => other === breakableAlly,
  isOnSameTeam: () => false,
};
diplomaticNuclearThreatBehavior.game = {
  players: () => [diplomaticNuclearThreatBehavior.player, breakableAlly],
};
assert.deepEqual(
  Array.from(diplomaticNuclearThreatBehavior.legendaryNuclearHostilePlayers()),
  [breakableAlly],
  "a breakable diplomatic ally remains hostile to Legendary nuclear planning",
);
assert.equal(
  diplomaticNuclearThreatBehavior.hasPlacedSiloOnMap(),
  true,
  "a breakable diplomatic ally's Silo remains a nuclear-defense trigger",
);

const initialSiloBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let initialSiloSpawnType = null;
let initialSiloSpawnOptions = null;
initialSiloBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
initialSiloBehavior.ownedLevels = (type) => (type === UNIT.City ? 1 : 0);
initialSiloBehavior.getConstructionCost = () => 1_000_000n;
initialSiloBehavior.spendableConstructionGold = () => 5_000_000n;
initialSiloBehavior.maybeSpawnStructure = async (type, options) => {
  initialSiloSpawnType = type;
  initialSiloSpawnOptions = options;
  return true;
};
assert.equal(
  await initialSiloBehavior.handleInitialMissileSilo(false),
  true,
  "an affordable first Silo is built without waiting for an enemy SAM network",
);
assert.equal(
  initialSiloSpawnType,
  UNIT.MissileSilo,
  "the initial nuclear policy emits a Missile Silo rather than another economic structure",
);
assert.equal(
  initialSiloSpawnOptions?.ignoreEconomicReserve,
  true,
  "the initial Silo bypasses only the ongoing economic reserve that would otherwise make its first-launch policy unreachable",
);
initialSiloSpawnType = null;
initialSiloBehavior.ownedLevels = () => 0;
assert.equal(
  await initialSiloBehavior.handleInitialMissileSilo(false),
  false,
  "the initial Silo waits until the basic City economy exists",
);
assert.equal(initialSiloSpawnType, null);

behavior.placementsCount = 0;
assert.equal(
  behavior.hasPriorStructureForDefensePost(),
  true,
  "an emergency-built Silo satisfies the prior-structure Defense Post gate even when the ordinary placement counter is zero",
);
const priorSilosForDefensePostGate = own.silos;
own.silos = [];
assert.equal(
  behavior.hasPriorStructureForDefensePost(),
  false,
  "ordinary openings do not treat a Defense Post as their literal first structure",
);
own.silos = priorSilosForDefensePostGate;

const defenseCoverageBehavior = Object.create(sandbox.__StructureBehavior.prototype);
defenseCoverageBehavior.game = {
  config: () => ({ defensePostRange: () => 30 }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
defenseCoverageBehavior.player = {
  units: (type) => (type === UNIT.DefensePost ? [{ tile: () => 0 }] : []),
};
defenseCoverageBehavior.rankStructureTilesBySamProtection = (tiles) => [...tiles];
defenseCoverageBehavior.spacingConstants = () => ({ borderSpacing: 30 });
assert.deepEqual(
  defenseCoverageBehavior.defensePostFrontDemand({ allowed: 1, landAttacks: [] }, [40]),
  [40],
