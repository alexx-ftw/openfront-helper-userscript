    currentLevel: 1,
    targetLevel: 2,
  }),
  false,
  "a planned SAM upgrade rechecks the active blast at its final actuation boundary",
);
assert.equal(sentBuilds.length, 0);
assert.equal(
  blastUpgradeBehavior.executeStructureUpgradeCandidate(
    { sam: blastSam, bu: { canUpgrade: true } },
    UNIT.SAMLauncher,
  ),
  false,
  "reactive and parity SAM upgrades cannot execute inside the active blast",
);
assert.equal(sentBuilds.length, 0);
assert.equal(
  recoverySamEmergency.shouldRetryFirstSamWithSafeCandidates(
    UNIT.SAMLauncher,
    { recoverySam: true },
    [{ t: 1 }],
    [{ t: 1 }, { t: 2 }],
  ),
  true,
  "a failed first-SAM core probe may fall back to another safe owned tile",
);
assert.equal(
  recoverySamEmergency.shouldRetryFirstSamWithSafeCandidates(
    UNIT.SAMLauncher,
    { recoverySam: false },
    [{ t: 1 }],
    [{ t: 1 }, { t: 2 }],
  ),
  false,
  "ordinary SAM placement retains the strict core-coverage filter",
);
const ordinaryStructurePacing = Object.create(sandbox.__StructureBehavior.prototype);
let ordinaryStructureTick = 100;
ordinaryStructurePacing.game = { ticks: () => ordinaryStructureTick };
assert.equal(
  ordinaryStructurePacing.shouldDeferOrdinaryStructureDecision(),
  false,
  "the first ordinary construction decision is immediately eligible",
);
ordinaryStructureTick = 116;
assert.equal(
  ordinaryStructurePacing.shouldDeferOrdinaryStructureDecision(),
  true,
  "a between-attack retry does not repeat the costly ordinary placement probes",
);
ordinaryStructureTick = 120;
assert.equal(
  ordinaryStructurePacing.shouldDeferOrdinaryStructureDecision(),
  false,
  "ordinary construction resumes after the bounded pacing interval",
);

const economicPlacementBudget = Object.create(sandbox.__StructureBehavior.prototype);
economicPlacementBudget.economicPlacementBudgetLimit = (limit) => limit;
economicPlacementBudget.consumeEconomicPlacementBudget = () => {};
economicPlacementBudget.structureProbeOptions = () => ({
  candidateLimit: 25,
  probeLimit: 25,
  probeTimeoutMs: 1,
  parallelProbeCount: 1,
});
let economicCandidateLimit = 0;
economicPlacementBudget.structureCandidateTiles = (_type, _options, limit) => {
  economicCandidateLimit = limit;
  return [];
};
assert.equal(await economicPlacementBudget.structureSpawnTile(UNIT.Factory), null);
assert.equal(
  economicCandidateLimit,
  12,
  "ordinary City/Factory/Port sampling reserves budget for the resumable exhaustive scan",
);

const enemyPressureBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let enemyUnitSnapshotCalls = 0;
const enemyUnitSnapshotTypes = [];
const pressureUnits = [
  UNIT.MissileSilo,
  UNIT.Warship,
  UNIT.SAMLauncher,
  UNIT.City,
  UNIT.Factory,
  UNIT.Port,
].map((type) => ({ type: () => type }));
const pressureEnemy = {
  gold: () => 1_000,
  units: (type) => {
    enemyUnitSnapshotCalls++;
    enemyUnitSnapshotTypes.push(type);
    return pressureUnits.filter((unit) => unit.type() === type);
  },
};
enemyPressureBehavior.player = { gold: () => 1_000 };
enemyPressureBehavior.game = {
  config: () => ({ maxTroops: () => 10_000 }),
};
enemyPressureBehavior.legendaryHostilePlayers = () => [pressureEnemy];
assert.equal(
  enemyPressureBehavior.legendaryEnemyTargetPressure(),
  1.75,
  "combined unit collection preserves the exact strategic-pressure score",
);
assert.equal(
  enemyUnitSnapshotCalls,
  6,
  "enemy target pressure scans one roster per strategic-unit type (vendored units() caps at three positional types)",
);
assert.deepEqual(
  enemyUnitSnapshotTypes,
  [UNIT.MissileSilo, UNIT.Warship, UNIT.SAMLauncher, UNIT.City, UNIT.Factory, UNIT.Port],
  "the per-type roster scan covers all six strategic-unit types in declaration order",
);

const friendlySamSnapshot = Object.create(sandbox.__StructureBehavior.prototype);
let friendlySamTick = 50;
let globalSamReads = 0;
const ownSamOwner = { smallID: () => 7 };
const ownSam = {
  id: () => "sam-1",
  isUnderConstruction: () => false,
  owner: () => ownSamOwner,
};
friendlySamSnapshot.player = {
  smallID: () => 7,
  isFriendly: () => false,
  isOnSameTeam: () => false,
  units: () => [],
};
friendlySamSnapshot.game = {
  ticks: () => friendlySamTick,
  units: (...types) => {
    globalSamReads++;
    assert.deepEqual(types, [UNIT.SAMLauncher]);
    return [ownSam];
  },
  players: () => [],
};
const firstFriendlySams = friendlySamSnapshot.legendaryFriendlySamUnits();
const repeatedFriendlySams = friendlySamSnapshot.legendaryFriendlySamUnits();
assert.strictEqual(
  repeatedFriendlySams,
  firstFriendlySams,
  "all SAM consumers share one friendly launcher snapshot during a game tick",
);
assert.equal(globalSamReads, 1, "friendly SAM ownership and dedupe run once per tick");
friendlySamTick++;
assert.notStrictEqual(
  friendlySamSnapshot.legendaryFriendlySamUnits(),
  firstFriendlySams,
  "a new game tick invalidates the friendly SAM snapshot",
);
assert.equal(globalSamReads, 2);

const ownedSamSnapshot = Object.create(sandbox.__StructureBehavior.prototype);
let ownedSamTick = 75;
let ownedSamReads = 0;
const pendingOwnedSam = {
  id: () => "sam-pending",
  isUnderConstruction: () => true,
};
ownedSamSnapshot.player = {
  units: (...types) => {
    ownedSamReads++;
    assert.deepEqual(types, [UNIT.SAMLauncher]);
    return [ownSam, pendingOwnedSam];
  },
};
ownedSamSnapshot.game = { ticks: () => ownedSamTick };
const firstOwnedSams = ownedSamSnapshot.ownedSamUnits();
assert.strictEqual(
  ownedSamSnapshot.ownedSamUnits(),
  firstOwnedSams,
  "all own-SAM consumers share one raw launcher snapshot during a game tick",
);
assert.deepEqual(
  firstOwnedSams,
  [ownSam, pendingOwnedSam],
  "the own-SAM snapshot retains pending launchers for first-SAM reserve decisions",
);
assert.equal(ownedSamReads, 1, "own-SAM snapshot avoids duplicate roster scans in one tick");
ownedSamTick++;
assert.notStrictEqual(
  ownedSamSnapshot.ownedSamUnits(),
  firstOwnedSams,
  "a new game tick refreshes the own-SAM roster",
