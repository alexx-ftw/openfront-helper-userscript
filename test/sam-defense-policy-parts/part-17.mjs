  }),
  null,
  "Coverage-priority SAM placement returns null when all probes are unavailable",
);
assert.equal(
  coverageProbeCount > 3 && coverageProbeCount <= 25,
  true,
  "Coverage-priority SAM placement falls through to remaining authoritative probes without reprobes",
);
assert.equal(
  coverageRequestedSampleCount,
  25,
  "Coverage-priority SAM placement preserves the upstream Nation sample budget",
);
assert.equal(
  new Set(coverageProbeTiles).size,
  coverageProbeTiles.length,
  "Coverage-priority SAM placement removes duplicate candidates before worker probes",
);
assert.equal(
  coverageProbeTiles.includes(10_001),
  false,
  "Coverage-priority SAM placement removes foreign-owned tiles before worker probes",
);
coverageProbeCount = 0;
let validCoverageProbe = null;
coverageProbe.buildableFor = async () => {
  coverageProbeCount++;
  validCoverageProbe = { canBuild: true, canUpgrade: false, tile: 321 };
  return validCoverageProbe;
};
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
    probeLimit: 25,
    probeTimeoutMs: 20,
    parallelProbeCount: 1,
  }),
  validCoverageProbe,
  "Hostile-silo SAM placement validates the best locally legal candidate",
);
assert.equal(
  coverageProbeCount,
  1,
  "Hostile-silo SAM placement normally crosses the worker boundary exactly once",
);
coverageProbe.buildableFor = async () => {
  coverageProbeCount++;
  return null;
};
sandbox.randTerritoryTileArray = originalCoverageRandTerritoryTileArray;

const localLegalityProbe = Object.create(sandbox.__StructureBehavior.prototype);
localLegalityProbe.player = { smallID: () => 1 };
localLegalityProbe.game = {
  ownerID: (tile) => (tile >= 0 && tile <= 30 ? 1 : 2),
  neighbors: (tile) => [tile - 1, tile + 1],
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  nearbyUnits: () => [{ unit: { tile: () => 10 } }],
  config: () => ({ structureMinDist: () => 2 }),
};
const locallySnappedTile = localLegalityProbe.localLandStructureSpawnTile(10);
assert.equal(
  locallySnappedTile === 8 || locallySnappedTile === 12,
  true,
  "Local structure legality mirrors the engine spacing rule and snaps beyond occupied tiles",
);
assert.equal(
  localLegalityProbe.localLandStructureSpawnTile(31),
  false,
  "Local structure legality rejects candidates outside the player's territory",
);

const hostileOwner = { isPlayer: () => true };
const alliedOwner = { isPlayer: () => true };
const placementSafetyProbe = Object.create(sandbox.__StructureBehavior.prototype);
placementSafetyProbe.player = {
  smallID: () => 1,
  isFriendly: (player) => player === alliedOwner,
  isOnSameTeam: (player) => player === alliedOwner,
};
placementSafetyProbe.game = {
  neighbors: (tile) => [tile + 1],
  ownerID: (tile) => {
    if (tile === 11) return 2;
    if (tile === 21) return 3;
    return 1;
  },
  playerBySmallID: (sid) => {
    if (sid === 2) return hostileOwner;
    if (sid === 3) return alliedOwner;
    return null;
  },
};
assert.equal(
  placementSafetyProbe.isDangerousStructureTile(10, UNIT.Factory),
  true,
  "Ordinary structures reject tiles directly exposed to hostile territory",
);
assert.equal(
  placementSafetyProbe.isDangerousStructureTile(20, UNIT.Factory),
  false,
  "Allied territory does not make a construction tile dangerous",
);
assert.equal(
  placementSafetyProbe.isDangerousStructureTile(10, UNIT.DefensePost),
  false,
  "Defense posts may still fortify an active hostile frontier",
);
assert.equal(
  placementSafetyProbe.isSafeBuildablePlacement({ canBuild: 10 }, 20, UNIT.City),
  false,
  "The authoritative worker destination is safety-checked after snapping",
);

let impactTick = 100;
let placementMissileActive = true;
let impactProbeCalls = 0;
const missileOwner = { smallID: () => 2 };
const ownMissileOwner = { smallID: () => 1 };
const alliedMissileOwner = { smallID: () => 3 };
let missileImpactOwner = missileOwner;
const hostileAtom = {
  owner: () => missileImpactOwner,
  isActive: () => placementMissileActive,
  targetTile: () => 100,
  type: () => UNIT.AtomBomb,
};
const missileImpactProbe = Object.create(sandbox.__StructureBehavior.prototype);
missileImpactProbe.player = {
  smallID: () => 1,
  isFriendly: (owner) => owner === alliedMissileOwner,
  isOnSameTeam: () => false,
};
assert.equal(
  sandbox.__isHostileActiveMissile(
    missileImpactProbe.player,
    { owner: () => alliedMissileOwner, isActive: () => true },
    1,
  ),
  true,
  "a diplomatic ally's active missile remains a hostile defense threat",
);
const teamMissileOwner = { smallID: () => 4, team: () => "blue" };
assert.equal(
  sandbox.__isHostileActiveMissile(
    { smallID: () => 1, team: () => "blue" },
    { owner: () => teamMissileOwner, isActive: () => true },
    1,
  ),
  false,
  "a permanent teammate's active missile is not a hostile defense threat",
);
missileImpactProbe.game = {
  ticks: () => impactTick,
  units: () => [hostileAtom],
  config: () => ({
    nukeMagnitudes: () => ({ outer: 10 }),
  }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  neighbors: () => [],
  ownerID: () => 1,
  playerBySmallID: () => null,
};
missileImpactProbe.buildableFor = async (_type, tile) => {
  impactProbeCalls++;
  return { canUpgrade: true, tile };
};
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  true,
  "Every structure rejects a tile inside an active hostile missile blast",
);
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.DefensePost),
  true,
  "The frontier exemption does not let a Defense Post enter a missile blast",
);
assert.equal(
  missileImpactProbe.isDangerousStructureTile(111, UNIT.Factory),
  false,
  "A tile beyond the configured outer blast radius remains buildable",
);
const impactUpgradeResults = await missileImpactProbe.buildableForUnits(
  [makeUnit(105, 1), makeUnit(120, 1)],
  UNIT.SAMLauncher,
  { concurrency: 2 },
);
assert.equal(
  impactUpgradeResults[0],
