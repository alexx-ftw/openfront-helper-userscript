  null,
  "An upgrade inside an imminent hostile impact is not probed or purchased",
);
assert.equal(impactUpgradeResults[1]?.canUpgrade, true);
assert.equal(impactProbeCalls, 1, "Only the missile-safe upgrade candidate is probed");
const boundedProbe = Object.create(sandbox.__StructureBehavior.prototype);
const boundedProbeUnits = Array.from({ length: 30 }, (_, index) => makeUnit(1_000 + index, 1));
let boundedProbeCalls = 0;
boundedProbe.tileInsideActiveHostileMissileImpact = () => false;
boundedProbe.buildableFor = async (_type, tile) => {
  boundedProbeCalls++;
  return { canUpgrade: true, tile };
};
const boundedProbeResults = await boundedProbe.buildableForUnits(
  boundedProbeUnits,
  UNIT.SAMLauncher,
);
assert.equal(
  boundedProbeResults.length,
  boundedProbeUnits.length,
  "bounded probes retain one result slot for every input unit",
);
assert.equal(
  boundedProbeResults.slice(25).every((result) => result === null),
  true,
  "units beyond the probe budget remain aligned as null results",
);
assert.equal(
  boundedProbeCalls,
  25,
  "the aligned result does not expand the bounded worker probe budget",
);
placementMissileActive = false;
impactTick++;
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  false,
  "Missile impact safety invalidates with the game tick after the threat ends",
);
placementMissileActive = true;
missileImpactOwner = ownMissileOwner;
impactTick++;
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  true,
  "Our own in-flight missile suppresses construction inside its ownership-agnostic blast",
);
missileImpactOwner = alliedMissileOwner;
impactTick++;
assert.equal(
  missileImpactProbe.isDangerousStructureTile(105, UNIT.Factory),
  true,
  "An allied in-flight missile suppresses construction inside its ownership-agnostic blast",
);
assert.equal(
  missileImpactProbe.isDangerousStructureTile(110, UNIT.Factory),
  true,
  "A structure exactly on the inclusive outer blast radius is unsafe like NukeExecution",
);
missileImpactOwner = missileOwner;
impactProbeCalls = 0;
sentBuilds.length = 0;
missileImpactProbe.player.borderTiles = () => [90];
missileImpactProbe.game.manhattanDist = (a, b) => Math.abs(a - b);
missileImpactProbe.spacingConstants = () => ({ borderSpacing: 30 });
missileImpactProbe.buildableFor = async (_type, tile) => {
  impactProbeCalls++;
  return { canBuild: tile, canUpgrade: false, tile };
};
impactTick++;
assert.equal(
  await missileImpactProbe.buildFirstDefensePost([105, 120]),
  true,
  "The direct Defense Post path skips an unsafe raw tile and builds the safe candidate",
);
assert.equal(sentBuilds.at(-1)?.tile, 120);
assert.equal(impactProbeCalls, 1, "The unsafe Defense Post tile is never probed");
missileImpactProbe.buildableFor = async () => ({ canBuild: 105, canUpgrade: false });
sentBuilds.length = 0;
impactTick++;
assert.equal(
  await missileImpactProbe.buildFirstDefensePost([120]),
  false,
  "The direct Defense Post path rejects an authoritative snap into the blast",
);
assert.equal(sentBuilds.length, 0);

// A worker snap must preserve the depth checked before the async probe.
const postDepthProbe = Object.create(missileImpactProbe);
postDepthProbe.player = { ...missileImpactProbe.player, borderTiles: () => [100] };
postDepthProbe.game = {
  ...missileImpactProbe.game,
  manhattanDist: (a, b) => Math.abs(a - b),
};
postDepthProbe.spacingConstants = () => ({ borderSpacing: 30 });
for (const [snappedTile, expected] of [
  [112, false],
  [123, true],
  [145, true],
  [146, false],
]) {
  sentBuilds.length = 0;
  postDepthProbe.buildableFor = async () => ({ canBuild: snappedTile, canUpgrade: false });
  assert.equal(
    await postDepthProbe.buildFirstDefensePost([123]),
    expected,
    `resolved Defense Post depth must remain within the sampled range: ${snappedTile}`,
  );
  assert.equal(sentBuilds.length, expected ? 1 : 0);
}
sentBuilds.length = 0;
postDepthProbe.buildableFor = async (_type, tile) => ({
  canBuild: tile === 123 ? 112 : tile,
  canUpgrade: false,
});
assert.equal(await postDepthProbe.buildFirstDefensePost([123, 124]), true);
assert.equal(
  sentBuilds.at(-1)?.canBuild,
  124,
  "an unsafe snap does not discard the next depth-valid candidate",
);

const originalTilesNearFriendlySams = coverageProbe.tilesNearFriendlySams;
const originalMissileSiloValue = coverageProbe.missileSiloValue;
coverageProbe.tilesNearFriendlySams = () =>
  Array.from({ length: 25 }, (_, index) => 20_000 + index);
coverageProbe.missileSiloValue = () => () => 0;
coverageProbeCount = 0;
assert.equal(
  await coverageProbe.structureSpawnTile(UNIT.MissileSilo),
  null,
  "SAM-covered silo placement returns null when all merged probes are unavailable",
);
assert.equal(
  coverageProbeCount,
  25,
  "SAM-covered silo placement keeps the merged candidate set bounded to 25 probes",
);
const protectedFactoryCandidates = coverageProbe.structureCandidateTiles(UNIT.Factory, {}, 25);
assert.deepEqual(
  Array.from(protectedFactoryCandidates),
  Array.from({ length: 25 }, (_, index) => 20_000 + index),
  "SAM-protected candidate generation applies to ordinary structures, not only silos",
);
coverageProbe.tilesNearFriendlySams = originalTilesNearFriendlySams;
coverageProbe.missileSiloValue = originalMissileSiloValue;
own.units = originalOwnUnits;
behavior.game.config = originalGameConfig;
behavior.game.euclideanDistSquared = originalEuclideanDistSquared;

const hydrogenProtectionBehavior = Object.create(sandbox.__StructureBehavior.prototype);
hydrogenProtectionBehavior._hostileMissileLaunchObserved = true;
const hydrogenSam = makeUnit(1101, 1);
let hydrogenProtectionGold = 5_000_000n;
let hydrogenThreatPlayers = [enemyTwoLevelOneSilos];
hydrogenProtectionBehavior.player = {
  smallID: () => 1,
  team: () => "blue",
  gold: () => hydrogenProtectionGold,
  borderTiles: () => new Set([0, 10]),
  units: (type) => {
    if (type === UNIT.SAMLauncher) return [hydrogenSam];
    if (type === UNIT.City) return [{ tile: () => 0 }];
    return [];
  },
};
hydrogenProtectionBehavior.game = {
  ticks: () => 1,
  players: () => [hydrogenProtectionBehavior.player, ...hydrogenThreatPlayers],
  euclideanDistSquared: (left, right) => (Number(left) - Number(right)) ** 2,
  config: () => ({
    isUnitDisabled: () => false,
    samRange: (level) => level * 6,
  }),
};
hydrogenProtectionBehavior.liveNuclearHostilePlayers = () => [enemyTwoLevelOneSilos];
hydrogenProtectionBehavior.legendaryReserveGold = () => 0n;
hydrogenProtectionBehavior.cost = () => 1n;
hydrogenProtectionBehavior.buildableForUnits = async () => [
  { type: UNIT.SAMLauncher, canUpgrade: true, cost: 1n },
];
assert.equal(
  hydrogenProtectionBehavior.hydrogenSamProtectionPlan().targetLevel,
  5,
  "Two Silo slots on one hostile player force the maximum SAM level",
);
const originalEnemyTeamUnitsForHydrogenPlan = enemyTeam.units;
enemyTeam.units = (type) => (type === UNIT.MissileSilo ? [makeUnit(504, 2)] : []);
hydrogenThreatPlayers = [enemyTeam];
hydrogenProtectionBehavior.liveNuclearHostilePlayers = () => [];
