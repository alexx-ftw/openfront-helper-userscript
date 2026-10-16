  );
  assert.equal(
    upgradeProbeCount,
    0,
    `Legendary legal new ${type} placement performs no upgrade probe`,
  );
  assert.equal(sentBuilds.at(-1), legalBuildable);
}
sandbox.isLegendaryDifficulty = originalLegalBuildLegendaryCheck;

const resumedEconomicScanBehavior = Object.create(sandbox.__StructureBehavior.prototype);
resumedEconomicScanBehavior.isLegendaryDifficulty = () => true;
const resumedEconomicBuildable = { canBuild: 901, canUpgrade: false };
let resumedRandomProbeCalls = 0;
let resumedScanCalls = 0;
resumedEconomicScanBehavior.structureSpawnEligible = () => true;
resumedEconomicScanBehavior.getConstructionCost = () => 1n;
resumedEconomicScanBehavior.availableGoldAfterReserve = () => 10n;
resumedEconomicScanBehavior.player = { units: () => [], numTilesOwned: () => 1 };
resumedEconomicScanBehavior.hasStructureUnderConstruction = () => false;
resumedEconomicScanBehavior._economicPlacementScans = new Map([
  [String(UNIT.City), { context: { fingerprint: "unchanged" } }],
]);
resumedEconomicScanBehavior.economicPlacementFingerprint = () => "unchanged";
resumedEconomicScanBehavior.structureSpawnTile = async () => {
  resumedRandomProbeCalls++;
  return null;
};
resumedEconomicScanBehavior.findEconomicPlacementOrExhaustion = async () => {
  resumedScanCalls++;
  return { status: "buildable", buildable: resumedEconomicBuildable };
};
assert.equal(
  await resumedEconomicScanBehavior.maybeSpawnStructure(UNIT.City),
  true,
  "A pending unchanged economic scan resumes directly instead of repeating random worker probes",
);
assert.equal(resumedRandomProbeCalls, 0);
assert.equal(resumedScanCalls, 1);
assert.equal(sentBuilds.at(-1), resumedEconomicBuildable);

resumedEconomicScanBehavior._economicPlacementScans.set(String(UNIT.City), {
  context: { fingerprint: "stale" },
});
resumedEconomicScanBehavior.structureSpawnTile = async () => {
  resumedRandomProbeCalls++;
  return resumedEconomicBuildable;
};
assert.equal(
  await resumedEconomicScanBehavior.maybeSpawnStructure(UNIT.City),
  true,
  "A changed economic snapshot discards the stale scan and samples current placement geometry",
);
assert.equal(resumedRandomProbeCalls, 1);
assert.equal(
  resumedEconomicScanBehavior._economicPlacementScans.has(String(UNIT.City)),
  false,
  "A stale scan cannot suppress placement after territory or structures changed",
);

const hybridCityBuildable = { canBuild: 789, canUpgrade: 1234 };
assert.equal(
  economicBuildFirstBehavior.isUsableStructureBuildable(hybridCityBuildable, 789, UNIT.City),
  false,
  "A build probe that also targets an existing City cannot be used for a new City",
);
const hybridBuildCount = sentBuilds.length;
economicBuildFirstBehavior.structureSpawnTile = async () => hybridCityBuildable;
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.City),
  false,
  "A hybrid City descriptor cannot silently emit an upgrade through the new-build path",
);
assert.equal(
  sentBuilds.length,
  hybridBuildCount,
  "The construction actuation boundary emits no event for a hybrid descriptor",
);

economicBuildFirstBehavior.structureSpawnTile = async () => null;
economicBuildFirstBehavior.findEconomicPlacementOrExhaustion = async () => ({
  status: "indeterminate",
});
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.Factory),
  false,
  "An indeterminate bounded placement miss cannot authorize an economic upgrade",
);
assert.equal(economicUpgradeCalls, 0);
economicBuildFirstBehavior.findEconomicPlacementOrExhaustion = async () => ({
  status: "no-space",
});
assert.equal(
  await economicBuildFirstBehavior.maybeSpawnStructure(UNIT.Port),
  true,
  "A complete no-space result upgrades the requested economic structure",
);
assert.equal(economicUpgradeCalls, 1);

testDifficulty = Difficulty.Legendary;
sandbox.isLegendaryDifficulty = () => true;
const directEconomicUpgradeGuard = Object.create(sandbox.__StructureBehavior.prototype);
const guardedEconomicStructure = { type: () => UNIT.City };
let directEconomicUpgradeProbeCalls = 0;
directEconomicUpgradeGuard.getTotalStructureDensity = () => 1;
directEconomicUpgradeGuard.findBestStructureToUpgrade = async () => {
  directEconomicUpgradeProbeCalls++;
  return null;
};
assert.equal(
  await directEconomicUpgradeGuard.maybeUpgradeStructure([guardedEconomicStructure]),
  false,
  "A direct economic upgrade request is rejected without a completed no-space proof",
);
assert.equal(
  directEconomicUpgradeProbeCalls,
  0,
  "The economic no-space guard runs before any upgrade selection work",
);
testDifficulty = originalEconomicBuildDifficulty;
sandbox.isLegendaryDifficulty = originalEconomicBuildLegendaryCheck;

const foundationalCityBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const foundationalCityAttempts = [];
foundationalCityBehavior.maybeSpawnStructure = async (type) => {
  foundationalCityAttempts.push(type);
  return type === UNIT.City;
};
assert.equal(
  await foundationalCityBehavior.handleOrdinaryStructurePriorities({
    citiesDisabled: false,
    cityCount: 0,
    config: { isUnitDisabled: () => false },
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
  }),
  true,
  "A foundational ordinary economic action builds a City before any coastal Port",
);
assert.deepEqual(
  foundationalCityAttempts,
  [UNIT.City],
  "A zero-City opening never reaches Port/Factory priority before its City attempt",
);
foundationalCityAttempts.length = 0;
assert.equal(
  await foundationalCityBehavior.handleOrdinaryStructurePriorities({
    citiesDisabled: false,
    cityCount: 1,
    config: { isUnitDisabled: () => false },
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
  }),
  true,
  "The second foundational City also precedes ordinary Port and Factory demand",
);
assert.deepEqual(
  foundationalCityAttempts,
  [UNIT.City],
  "A one-City opening completes its two-City floor before testing other ordinary structures",
);

const exhaustiveEconomyBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const exhaustiveStructures = [{ tile: () => 0 }];
exhaustiveEconomyBehavior.player = {
  smallID: () => 1,
  numTilesOwned: () => 4,
  borderTiles: () => new Set([0, 3]),
};
exhaustiveEconomyBehavior.structureTileValueFunction = () => (tile) => tile;
exhaustiveEconomyBehavior.structureProbeOptions = () => ({ probeTimeoutMs: 2500 });
exhaustiveEconomyBehavior.isDangerousStructureTile = () => false;
exhaustiveEconomyBehavior.buildableFor = async (type, tile) => ({
  type,
  canBuild: tile,
});
exhaustiveEconomyBehavior.isUsableStructureBuildable = (buildable) => buildable !== null;
exhaustiveEconomyBehavior.game = {
  width: () => 4,
  height: () => 1,
  ref: (x) => x,
  x: (tile) => tile,
  y: () => 0,
  isValidCoord: (x, y) => x >= 0 && x < 4 && y === 0,
  ownerID: () => 1,
  units: () => exhaustiveStructures,
  nearbyUnits: () => exhaustiveStructures,
  euclideanDistSquared: (left, right) => (left - right) ** 2,
  config: () => ({ structureMinDist: () => 2 }),
};
