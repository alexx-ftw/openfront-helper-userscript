    maxSamRange: () => 40,
    samRange: () => 20,
  }),
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
const compactRanker = compactPlacementBehavior.structurePlacementCompactnessRanker(UNIT.Factory);
assert.equal(
  compactRanker(15).sharedSamCoverage,
  1,
  "Economic placement recognizes structures that one future SAM can cover together",
);
assert.equal(
  compactRanker(50).sharedSamCoverage,
  0,
  "Economic placement rejects a spread-out tile from the shared SAM cluster",
);
assert.equal(
  compactRanker(25).existingSamCoverage,
  1,
  "Economic placement recognizes current coverage from an allied SAM",
);
assert.equal(
  compactRanker(15).upgradeSamCoverage,
  1,
  "Economic placement recognizes allied SAM coverage reachable after leveling",
);
assert.equal(
  compactRanker(0).upgradeSamCoverage,
  1,
  "The eventual coverage tier includes tiles within the SAM maximum range",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 1, compactness: compactRanker(15) },
    { v: 10_000, compactness: compactRanker(50) },
  ) > 0,
  true,
  "Current allied SAM coverage outranks merely prospective compact coverage",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 1, compactness: compactRanker(80) },
    { v: 10_000, compactness: compactRanker(15) },
  ) < 0,
  true,
  "Existing SAM coverage outranks merely prospective compact coverage",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 10_000, compactness: compactRanker(25) },
    { v: 1, compactness: compactRanker(50) },
  ) > 0,
  true,
  "Within the current-coverage tier, the tile closer to a friendly SAM wins",
);
assert.equal(
  compactPlacementBehavior.compareStructurePlacementScores(
    { v: 10_000, compactness: compactRanker(0) },
    { v: 1, compactness: compactRanker(15) },
  ) > 0,
  true,
  "Within future upgraded coverage, the tile closer to a friendly SAM wins",
);
const compactSnapshotBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let compactSnapshotTileReads = 0;
let compactSnapshotConfigReads = 0;
const compactSnapshotSams = [
  {
    tile: () => {
      compactSnapshotTileReads++;
      return 10;
    },
    level: () => 1,
  },
  {
    tile: () => {
      compactSnapshotTileReads++;
      return 40;
    },
    level: () => 1,
  },
];
compactSnapshotBehavior.player = {
  units: () => [
    {
      tile: () => {
        compactSnapshotTileReads++;
        return 20;
      },
    },
  ],
};
compactSnapshotBehavior.legendaryFriendlySamUnits = () => compactSnapshotSams;
compactSnapshotBehavior.game = {
  config: () => {
    compactSnapshotConfigReads++;
    return {
      defaultSamRange: () => 20,
      maxSamRange: () => 40,
      samRange: () => 20,
    };
  },
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
const compactSnapshotRanker = compactSnapshotBehavior.structurePlacementCompactnessRanker(
  UNIT.Factory,
);
const compactSnapshotReadsAfterSetup = {
  tiles: compactSnapshotTileReads,
  config: compactSnapshotConfigReads,
};
compactSnapshotRanker(15);
compactSnapshotRanker(25);
assert.deepEqual(
  {
    tiles: compactSnapshotTileReads,
    config: compactSnapshotConfigReads,
  },
  compactSnapshotReadsAfterSetup,
  "Economic compactness snapshots SAM and structure geometry once per decision, not once per candidate",
);
assert.deepEqual(
  Array.from(
    compactPlacementBehavior.rankStructureTilesBySamProtection([0, 15, 25], UNIT.DefensePost),
  ),
  [25, 15, 0],
  "Defense Posts preserve their valid front sample but rank it by current and future SAM protection",
);

const samCandidateBehavior = Object.create(sandbox.__StructureBehavior.prototype);
samCandidateBehavior.player = compactPlacementBehavior.player;
samCandidateBehavior.game = {
  ...compactPlacementBehavior.game,
  x: (tile) => Number(tile),
  y: () => 0,
  ref: (x) => x,
  isValidCoord: () => true,
  isLand: () => true,
  ownerID: () => 1,
};
const protectedCandidates = samCandidateBehavior.tilesNearFriendlySams(6);
assert.equal(protectedCandidates.length <= 6, true);
assert.equal(
  protectedCandidates.includes(80),
  true,
  "The bounded candidate set starts near an existing own SAM",
);
assert.equal(
  protectedCandidates.includes(40),
  true,
  "The bounded candidate set fairly includes an allied SAM instead of being filled by the first launcher",
);

const coverageProbeStructures = Array.from({ length: 500 }, (_, index) => ({
  tile: () => index * 100,
}));
const originalCoverageRandTerritoryTileArray = sandbox.randTerritoryTileArray;
let coverageRequestedSampleCount = 0;
sandbox.randTerritoryTileArray = (_random, _game, _player, count) => {
  coverageRequestedSampleCount = count;
  return Array.from({ length: count }, (_, index) => (index < 2 ? 10_000 : 9_999 + index));
};
const coverageProbe = Object.create(sandbox.__StructureBehavior.prototype);
coverageProbe.random = {};
coverageProbe.player = {
  smallID: () => 1,
  units: (...types) =>
    types.length === 1 && types[0] === UNIT.SAMLauncher ? [] : coverageProbeStructures,
};
coverageProbe.game = {
  neighbors: (tile) => [tile + 1, tile + 2, tile + 3],
  ownerID: (tile) => (tile === 10_001 ? 2 : 1),
  config: () => ({
    defaultSamRange: () => 10,
    samRange: () => 10,
    structureMinDist: () => 2,
  }),
  nearbyUnits: () => [],
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
};
let coverageProbeCount = 0;
const coverageProbeTiles = [];
coverageProbe.buildableFor = async (_type, tile) => {
  coverageProbeCount++;
  coverageProbeTiles.push(tile);
  return null;
};
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
