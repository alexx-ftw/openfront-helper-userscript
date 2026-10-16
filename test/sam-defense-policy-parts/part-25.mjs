const exhaustiveCityPlacement = await exhaustiveEconomyBehavior.findEconomicPlacementOrExhaustion(
  UNIT.City,
);
assert.equal(exhaustiveCityPlacement.status, "buildable");
assert.equal(exhaustiveCityPlacement.buildable.type, UNIT.City);
assert.equal(
  exhaustiveCityPlacement.buildable.canBuild,
  3,
  "The exhaustive fallback finds a legal new economic site missed by the bounded sample",
);
exhaustiveEconomyBehavior.game.width = () => 2;
assert.equal(
  (await exhaustiveEconomyBehavior.findEconomicPlacementOrExhaustion(UNIT.Factory)).status,
  "no-space",
  "Only a complete territory scan with no geometrically legal tile authorizes an upgrade",
);

const resumableEconomicBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const resumableEconomicScan = {
  context: {
    bounds: { minX: 0, maxX: 39, minY: 0, maxY: 0 },
    fingerprint: "stable-economic-scan",
  },
  x: 0,
  y: 0,
  index: 0,
  hasGeometricSpace: false,
  snappedSites: new Set(),
};
resumableEconomicBehavior.economicPlacementScanState = () => resumableEconomicScan;
resumableEconomicBehavior.economicPlacementBudgetLimit = () => 25;
resumableEconomicBehavior.consumeEconomicPlacementBudget = () => {};
resumableEconomicBehavior.economicLandTileCandidate = (type, context, x) => {
  if (x === 1) return { tile: 1, value: 1 };
  if (x === 30) return { tile: 30, value: 100 };
  return null;
};
resumableEconomicBehavior.structureProbeOptions = () => ({ probeTimeoutMs: 2500 });
resumableEconomicBehavior.buildableFor = async (type, tile) => ({ type, canBuild: tile });
resumableEconomicBehavior.isUsableStructureBuildable = () => true;
resumableEconomicBehavior.economicPlacementFingerprint = () => "stable-economic-scan";
resumableEconomicBehavior.clearEconomicPlacementScan = () => {};
assert.equal(
  (await resumableEconomicBehavior.findEconomicPlacementOrExhaustion(UNIT.City)).status,
  "indeterminate",
  "a legal site in the first bounded slice does not commit before the ranking is complete",
);
assert.equal(
  (await resumableEconomicBehavior.findEconomicPlacementOrExhaustion(UNIT.City)).buildable.canBuild,
  30,
  "a later higher-value site wins across resumable economic placement slices",
);

const portSpaceBehavior = Object.create(sandbox.__StructureBehavior.prototype);
portSpaceBehavior.isOceanPortTile = (tile) => tile === "ocean-shore";
portSpaceBehavior.localLandStructureSpawnTile = (tile) =>
  tile === "ocean-shore" ? "snapped-port" : false;
portSpaceBehavior.isDangerousStructureTile = () => false;
const portScanContext = {
  borderTiles: ["lake-shore", "ocean-shore"],
  valueFunction: (tile) => (tile === "ocean-shore" ? 10 : 0),
};
const portScanState = () => ({
  context: portScanContext,
  index: 0,
  hasGeometricSpace: false,
  snappedSites: new Set(),
});
const portSpaceResult = portSpaceBehavior.scanAllEconomicPortSpace(UNIT.Port, portScanState());
assert.equal(portSpaceResult.status, "candidate");
assert.equal(
  portSpaceResult.tile,
  "ocean-shore",
  "An open-ocean Port site proves that new-build space remains",
);
portSpaceBehavior.isOceanPortTile = () => false;
assert.equal(
  portSpaceBehavior.scanAllEconomicPortSpace(UNIT.Port, portScanState()).status,
  "no-space",
  "Lake-only shores do not prevent a Port upgrade after open-ocean space is exhausted",
);

const changingSnapshotBehavior = Object.create(sandbox.__StructureBehavior.prototype);
changingSnapshotBehavior.economicPlacementScanState = () => ({
  context: { fingerprint: "before" },
});
changingSnapshotBehavior.scanAllLandEconomicSpace = () => ({
  status: "no-space",
});
changingSnapshotBehavior.clearEconomicPlacementScan = () => {};
changingSnapshotBehavior.economicPlacementFingerprint = () => "after";
assert.equal(
  (await changingSnapshotBehavior.findEconomicPlacementOrExhaustion(UNIT.City)).status,
  "indeterminate",
  "A territory or structure snapshot change invalidates a completed no-space proof",
);

const topologyFingerprintBehavior = Object.create(sandbox.__StructureBehavior.prototype);
let topologyFingerprintTick = 1;
let landTopologyBorder = new Set([1, 2]);
let portTopologyOceanShore = [1];
const topologyFingerprintStructures = [];
topologyFingerprintBehavior.game = {
  ticks: () => topologyFingerprintTick,
  units: () => topologyFingerprintStructures,
  config: () => ({ structureMinDist: () => 2 }),
};
topologyFingerprintBehavior.player = {
  smallID: () => 1,
  numTilesOwned: () => 2,
  borderTiles: () => landTopologyBorder,
  oceanShoreBorderTiles: () => portTopologyOceanShore,
};
const landTopologyFingerprint = topologyFingerprintBehavior.economicPlacementFingerprint(UNIT.City);
topologyFingerprintBehavior._economicPlacementScans = new Map([
  [String(UNIT.City), { context: { fingerprint: landTopologyFingerprint } }],
]);
landTopologyBorder = new Set([3, 4]);
topologyFingerprintTick++;
assert.equal(
  topologyFingerprintBehavior.hasPendingEconomicPlacementScan(UNIT.City),
  false,
  "Equal-count land topology changes invalidate a resumable City scan",
);

const portTopologyFingerprint = topologyFingerprintBehavior.economicPlacementFingerprint(UNIT.Port);
topologyFingerprintBehavior._economicPlacementScans.set(String(UNIT.Port), {
  context: { fingerprint: portTopologyFingerprint },
});
portTopologyOceanShore = [5];
topologyFingerprintTick++;
assert.equal(
  topologyFingerprintBehavior.hasPendingEconomicPlacementScan(UNIT.Port),
  false,
  "Equal-count open-ocean topology changes invalidate a resumable Port scan",
);

const failedBestCandidateBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const failedCandidateTick = 100;
const failedBestCandidateScan = {
  context: { bounds: { minX: 0, maxX: 1, minY: 0, maxY: 0 }, fingerprint: "two-sites" },
  x: 0,
  y: 0,
  index: 0,
  hasGeometricSpace: false,
  snappedSites: new Set(),
};
const failedCandidateProbes = [];
let failedCandidateUpgradeCalls = 0;
failedBestCandidateBehavior.economicPlacementScanState = () => failedBestCandidateScan;
failedBestCandidateBehavior.game = { ticks: () => failedCandidateTick };
failedBestCandidateBehavior.game.config = () => ({
  unitInfo: () => ({ upgradable: false }),
});
failedBestCandidateBehavior.economicPlacementBudgetLimit = () => 25;
failedBestCandidateBehavior.consumeEconomicPlacementBudget = () => {};
failedBestCandidateBehavior.economicLandTileCandidate = (_type, _context, x) => ({
  tile: x,
  value: x,
});
failedBestCandidateBehavior.structureProbeOptions = () => ({ probeTimeoutMs: 1 });
failedBestCandidateBehavior.buildableFor = async (_type, tile) => {
  failedCandidateProbes.push(tile);
  return null;
};
failedBestCandidateBehavior.isUsableStructureBuildable = () => false;
failedBestCandidateBehavior.economicPlacementFingerprint = () => "two-sites";
failedBestCandidateBehavior.structureSpawnEligible = () => true;
failedBestCandidateBehavior.getConstructionCost = () => 1n;
failedBestCandidateBehavior.availableGoldAfterReserve = () => 10n;
failedBestCandidateBehavior.player = {
  units: () => [existingEconomicStructure],
  numTilesOwned: () => 1,
};
failedBestCandidateBehavior.hasStructureUnderConstruction = () => false;
failedBestCandidateBehavior.structureSpawnTile = async () => null;
failedBestCandidateBehavior.maybeUpgradeStructure = async () => {
  failedCandidateUpgradeCalls++;
  return true;
};
assert.equal(
  await failedBestCandidateBehavior.maybeSpawnStructure(UNIT.City),
  false,
  "A failed authoritative best-site probe remains indeterminate",
);
assert.equal(
  await failedBestCandidateBehavior.maybeSpawnStructure(UNIT.City),
  false,
  "The next decision advances to the next geometric candidate",
);
