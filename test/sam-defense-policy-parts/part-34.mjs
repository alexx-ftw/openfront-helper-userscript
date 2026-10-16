);
assert.equal(ownedSamReads, 2);

const economicPortfolioBehavior = Object.create(sandbox.__StructureBehavior.prototype);
const economicRosterReads = new Map();
const economicUnit = {
  isUnderConstruction: () => false,
  level: () => 1,
};
economicPortfolioBehavior.player = {
  units: (type) => {
    economicRosterReads.set(type, (economicRosterReads.get(type) || 0) + 1);
    return [economicUnit];
  },
};
economicPortfolioBehavior.game = {
  config: () => ({ isUnitDisabled: () => false }),
};
economicPortfolioBehavior.economicCandidateEligible = (type) => type === UNIT.Factory;
economicPortfolioBehavior.safeConstructionCost = () => 10n;
const economicReserve = economicPortfolioBehavior.economicConstructionPressureForSamUpgrade();
assert.equal(
  economicReserve?.type,
  UNIT.Factory,
  "SAM upgrade economy reserve preserves the same next productive structure",
);
assert.equal(economicReserve?.cost, 10n);
assert.deepEqual(
  [...economicRosterReads.entries()].sort(),
  [
    [UNIT.City, 1],
    [UNIT.Factory, 1],
    [UNIT.Port, 1],
  ].sort(),
  "SAM upgrade economy reserve reads each economic roster once instead of rescanning it",
);

assert.match(
  structureBehaviorSource,
  /const SAM_RATIO_BY_DIFFICULTY = \{\s*\[Difficulty\.Easy\]: 0,\s*\[Difficulty\.Medium\]: 0,\s*\[Difficulty\.Hard\]: 0,\s*\[Difficulty\.Impossible\]: 0,\s*\[Difficulty\.Legendary\]: 0,/,
  "routine difficulty-based SAM quotas stay disabled; threat and capacity paths own SAM demand",
);
assert.match(
  structureBehaviorSource,
  /const FIRST_MISSILE_SILO_RATIO = 0\.2;/,
  "the first Silo uses the same demonstrated City ratio as follow-on offensive Silos",
);

// ── Clanmate structure protection ────────────────────────────────────────────
// The hydrogen-coverage SAM plan seeds same-clan players' structure tiles
// alongside ours (goal rule: protect clanmates' buildings as our own).
{
  const clanApi = {
    getPlayerClanTag: (player) => player?.clanTag ?? null,
    sameClanTag: (left, right) => left !== null && left !== undefined && left === right,
  };
  sandbox.__OFHSpawnObjective = clanApi;
  const mate = {
    clanTag: "ESP",
    isAlive: () => true,
    units: (type) => (type === UNIT.City ? [{ tile: () => 500 }] : []),
  };
  const stranger = {
    clanTag: "XYZ",
    isAlive: () => true,
    units: (type) => (type === UNIT.City ? [{ tile: () => 900 }] : []),
  };
  const clanBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  clanBehavior.player = { clanTag: "ESP", units: () => [] };
  clanBehavior.game = { players: () => [clanBehavior.player, mate, stranger] };
  const mateTiles = clanBehavior.clanmateStructureTiles();
  assert.equal(mateTiles.length, 1, "a same-clan player's structures join the protection set");
  assert.equal(mateTiles[0], 500, "the clanmate tile is the one collected");
  const noTagBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  noTagBehavior.player = { units: () => [] };
  noTagBehavior.game = { players: () => [noTagBehavior.player, mate] };
  assert.equal(
    noTagBehavior.clanmateStructureTiles().length,
    0,
    "a player without a clan tag has no clanmate protection set",
  );
  delete sandbox.__OFHSpawnObjective;
}

// ── Peace-window SAM chest (Temporary PVP Immunity profile) ─────────────────
{
  const makePeaceBehavior = ({ duration, tick, immune = true, cities = 1 }) => {
    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    behavior.game = {
      ticks: () => tick,
      isSpawnImmunityActive: () => immune,
      config: () => ({
        spawnImmunityDuration: () => duration,
        isUnitDisabled: () => false,
      }),
    };
    behavior.ownedLevels = (type) => (type === UNIT.City ? cities : 0);
    return behavior;
  };

  // Hoard deadline: long windows compound until 750 ticks before expiry,
  // short default immunity never hoards.
  assert.equal(
    makePeaceBehavior({ duration: 50, tick: 25 }).legendaryPeaceWindowSamChestDue(),
    false,
    "ordinary 50-tick immunity never opens the peace chest",
  );
  assert.equal(
    makePeaceBehavior({ duration: 2400, tick: 1200 }).legendaryPeaceWindowSamChestDue(),
    false,
    "a long window keeps growing at half-elapsed (old duration/2 rule retired)",
  );
  assert.equal(
    makePeaceBehavior({ duration: 2400, tick: 1649 }).legendaryPeaceWindowSamChestDue(),
    false,
    "the hoard starts at duration-750, not before",
  );
  assert.equal(
    makePeaceBehavior({ duration: 2400, tick: 1650 }).legendaryPeaceWindowSamChestDue(),
    true,
    "750 ticks before expiry the chest opens (SAM needs 300 construction ticks)",
  );
  assert.equal(
    makePeaceBehavior({
      duration: 2400,
      tick: 2200,
      immune: false,
    }).legendaryPeaceWindowSamChestDue(),
    false,
    "expired immunity closes the peace chest",
  );
  assert.equal(
    makePeaceBehavior({ duration: 2400, tick: 2200, cities: 0 }).legendaryPeaceWindowSamChestDue(),
    false,
    "no City means no chest (growth has not even started)",
  );

  // The chest binds the warship lane: with the chest active and no SAM, a
  // warship that would eat the interceptor fund is deferred.
  const originalIsLegendary = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = () => true;
  const chestBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  chestBehavior.game = makePeaceBehavior({ duration: 2400, tick: 2000 }).game;
  chestBehavior.ownedLevels = (type) => (type === UNIT.City ? 1 : 0);
  chestBehavior.playerUnitCapacitySummary = (_player, type) =>
    type === UNIT.SAMLauncher ? { count: 0 } : null;
  assert.equal(
    chestBehavior.legendarySamBaselineChestActive(),
    true,
    "the peace deadline activates the baseline chest with no hostile silo",
  );
  const warshipDeferBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  warshipDeferBehavior.ownedSamUnits = () => [];
  warshipDeferBehavior.legendarySamBaselineChestActive = () => true;
  warshipDeferBehavior.game = makePeaceBehavior({ duration: 2400, tick: 2000 }).game;
  warshipDeferBehavior.safeConstructionCost = () => 1_500_000n;
  warshipDeferBehavior.spendableConstructionGold = () => 2_000_000n;
  assert.equal(
    warshipDeferBehavior.shouldDeferWarshipForFirstSam(1_250_000n),
    true,
    "a warship that would breach the SAM fund is deferred while the chest is active",
  );
  warshipDeferBehavior.spendableConstructionGold = () => 4_000_000n;
  assert.equal(
    warshipDeferBehavior.shouldDeferWarshipForFirstSam(1_250_000n),
    false,
    "ample gold lets the warship proceed even with the chest active",
  );
  warshipDeferBehavior.ownedSamUnits = () => [{ id: () => 1 }];
  assert.equal(
    warshipDeferBehavior.shouldDeferWarshipForFirstSam(1_250_000n),
    false,
    "once a SAM exists the warship lane is released",
  );
  // No-mod regression guard: short immunity keeps the chest closed, so the
  // warship defer falls back to its hostile-silo-only semantics — even when
  // the forecast chest is somehow active, the peace-scoped gate stays shut.
  const noModDeferBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  noModDeferBehavior.ownedSamUnits = () => [];
  noModDeferBehavior.legendarySamBaselineChestActive = () => false;
  noModDeferBehavior.game = makePeaceBehavior({ duration: 50, tick: 2000 }).game;
  noModDeferBehavior.hasBuiltHostileSiloThreat = () => false;
  assert.equal(
    noModDeferBehavior.shouldDeferWarshipForFirstSam(1_250_000n),
    false,
    "no chest and no hostile silo leaves warships untouched",
  );
  noModDeferBehavior.legendarySamBaselineChestActive = () => true;
  assert.equal(
    noModDeferBehavior.shouldDeferWarshipForFirstSam(1_250_000n),
