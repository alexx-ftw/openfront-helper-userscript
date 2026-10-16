  "an unsolved active missile falls through to the level-five external-Silo SAM upgrade",
);
assert.equal(
  activeMissileCapacityUpgradeAttempts,
  1,
  "active-missile handling attempts the capacity upgrade exactly once",
);
const pendingSamFirstSiloBehavior = Object.create(sandbox.__StructureBehavior.prototype);
pendingSamFirstSiloBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
pendingSamFirstSiloBehavior.missileDefenseSignalSnapshot = () => ({
  hasActiveHostileMissile: true,
});
pendingSamFirstSiloBehavior.activeMissileDefenseContext = () => ({
  threats: [{ inFlight: true }],
});
pendingSamFirstSiloBehavior.legendaryDefenseEvaluation = () => ({
  hasThreats: true,
  fullyDefended: false,
});
pendingSamFirstSiloBehavior.uncoveredActiveMirvDemands = () => [];
pendingSamFirstSiloBehavior.maybeUpgradeMissileDefenseSam = async () => false;
pendingSamFirstSiloBehavior.activeMissilePendingSamImproves = () => false;
pendingSamFirstSiloBehavior.ownedLevels = () => 0;
pendingSamFirstSiloBehavior.safeConstructionCost = () => 1_000_000n;
pendingSamFirstSiloBehavior.availableGoldAfterReserve = () => 1_000_000n;
pendingSamFirstSiloBehavior.player = {
  units: (type) => (type === UNIT.SAMLauncher ? [{ isUnderConstruction: () => true }] : []),
};
pendingSamFirstSiloBehavior.hasOwnSamUnderConstruction = () => true;
let pendingSamSiloOptions = null;
const pendingSamBuildOrder = [];
pendingSamFirstSiloBehavior.maybeSpawnStructure = async (type, options) => {
  pendingSamBuildOrder.push(type);
  if (type === UNIT.SAMLauncher) return false;
  assert.equal(type, UNIT.MissileSilo);
  pendingSamSiloOptions = options;
  return true;
};
assert.equal(
  await pendingSamFirstSiloBehavior.handleActiveMissileSamMaximumPriority(),
  true,
  "a first Silo starts alongside a funded SAM after no additional interception action can be placed",
);
assert.deepEqual(
  pendingSamBuildOrder,
  [UNIT.SAMLauncher, UNIT.MissileSilo],
  "the active SAM fallback keeps first priority before the paired Silo",
);
assert.equal(
  pendingSamSiloOptions?.ignoreEconomicReserve,
  true,
  "the paired first-Silo lane uses only its protected nuclear opening budget",
);
const emergencyTileCacheBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let emergencyTileEvaluationCalls = 0;
emergencyTileCacheBehavior.activeMissileSamConstructionImproves = () => {
  emergencyTileEvaluationCalls++;
  return true;
};
emergencyTileCacheBehavior.legendaryTileInsideUninterceptedBlast = () => false;
const emergencyTileSnapshot = {
  samDefense: true,
  incrementalSamDefense: true,
  context: {},
  evaluation: {},
  active: true,
};
assert.equal(
  emergencyTileCacheBehavior.structureEmergencyTileAllowed(
    42,
    UNIT.SAMLauncher,
    emergencyTileSnapshot,
  ),
  true,
);
assert.equal(
  emergencyTileCacheBehavior.structureEmergencyTileAllowed(
    42,
    UNIT.SAMLauncher,
    emergencyTileSnapshot,
  ),
  true,
  "revisiting an emergency SAM tile keeps its prior feasibility result",
);
assert.equal(
  emergencyTileEvaluationCalls,
  1,
  "one immutable emergency snapshot evaluates each SAM tile once",
);
const coverageFallbackBehavior = Object.create(sandbox.__StructureBehavior.prototype);
coverageFallbackBehavior.localLandStructureSpawnTile = () => false;
const coverageFallback = await coverageFallbackBehavior.probeCoveragePrioritySamTiles(
  [{ t: 41 }, { t: 42 }, { t: 43 }],
  UNIT.SAMLauncher,
  20,
  {},
);
assert.equal(
  coverageFallback.handled,
  false,
  "failed central-cluster probes fall back to authoritative SAM placement probes",
);
const emptyClusterProtectionBehavior = Object.create(sandbox.__StructureBehavior.prototype);
assert.equal(
  emptyClusterProtectionBehavior.samPlacementProtectsStructure(42, new Set()),
  true,
  "an empty current structure cluster does not suppress an urgent first SAM",
);
const emergencySamFallbackBehavior = Object.create(sandbox.__StructureBehavior.prototype);
emergencySamFallbackBehavior.structureProbeOptions = () => ({
  candidateLimit: 2,
  probeLimit: 2,
  probeTimeoutMs: 10,
  parallelProbeCount: 1,
});
emergencySamFallbackBehavior.structureCandidateTiles = () => [1, 2];
emergencySamFallbackBehavior.structureTileValueFunction = () => () => 0;
emergencySamFallbackBehavior.structurePlacementCompactnessRanker = () => null;
emergencySamFallbackBehavior.structureMissileEmergency = () => ({ active: false });
emergencySamFallbackBehavior.isDangerousStructureTile = (tile) => tile === 1;
emergencySamFallbackBehavior.samProtectableStructureTiles = () => new Set([1]);
emergencySamFallbackBehavior.samPlacementProtectsStructure = (tile) => tile === 1;
emergencySamFallbackBehavior.activeHostileMissileImpactZones = () => [{ targetTile: 1 }];
let emergencyFallbackTiles = [];
emergencySamFallbackBehavior.probeCoveragePrioritySamTiles = async (scored) => {
  emergencyFallbackTiles = scored.map(({ t }) => t);
  return { handled: true, buildable: { canBuild: 2, canUpgrade: false } };
};
assert.deepEqual(
  await emergencySamFallbackBehavior.structureSpawnTile(UNIT.SAMLauncher, {
    prioritizeStructureCoverage: true,
  }),
  { canBuild: 2, canUpgrade: false },
);
assert.deepEqual(
  emergencyFallbackTiles,
  [2],
  "when every core-covering SAM site is inside an incoming blast, a safe reconstruction SAM site remains eligible",
);
const ownSamClusterPlayer = {
  smallID: () => 1,
  isPlayer: () => true,
  units: () => [{ tile: () => 11 }],
};
const alliedSamClusterPlayer = {
  smallID: () => 2,
  isPlayer: () => true,
  units: () => [{ tile: () => 22 }],
};
const ownSamClusterBehavior = Object.create(sandbox.__StructureBehavior.prototype);
ownSamClusterBehavior.player = ownSamClusterPlayer;
ownSamClusterBehavior.game = { players: () => [ownSamClusterPlayer, alliedSamClusterPlayer] };
assert.deepEqual(
  Array.from(ownSamClusterBehavior.samProtectableStructureTiles()),
  [11],
  "our urgent SAM is centred on our own expensive cluster, not allied buildings",
);
assert.equal(
  sandbox.legendaryMaxEnemySamCapacity([[3, 1], [2, 2, 2], []]),
  6,
  "Parity uses the largest per-enemy sum of SAM levels, not the global sum",
);
assert.equal(
  sandbox.legendaryMaxEnemySamCapacity([[{ level: 4 }, { level: 1 }], [2]]),
  5,
  "Parity accepts level records as well as numeric level snapshots",
);

const makeUnit = (id, level, { underConstruction = false } = {}) => ({
  id: () => id,
  level: () => level,
  tile: () => id,
  isUnderConstruction: () => underConstruction,
  isActive: () => true,
});

const own = {
  smallID: () => 1,
  team: () => "blue",
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  isOnSameTeam: (other) => other?.smallID?.() === 5,
  gold: () => 5_000_000n,
  troops: () => 100_000,
  incomingAttacks: () => [],
  silos: [makeUnit(101, 2)],
  sams: [],
