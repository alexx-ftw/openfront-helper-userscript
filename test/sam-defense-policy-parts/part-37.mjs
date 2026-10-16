  );

  hostileSilos = 0;
  delete sandbox.state.hostileEconSamples;
  delete sandbox.state.ownEconSamples;
  sandbox.isLegendaryDifficulty = originalIsLegendary;
}

process.stdout.write("SAM DEFENSE POLICY TESTS OK\n");

// ── SAM site-count scaling vs hostile silo mass (5MM/25MM lever) ──────────
{
  const makeSiteScalingBehavior = ({ levelSum, samCount, bigStart = true }) => {
    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    behavior.hostileSiloLevelSumTarget = () => levelSum;
    behavior.legendaryBigStartGame = () => bigStart;
    behavior.playerUnitCapacitySummary = (_player, type) =>
      type === UNIT.SAMLauncher
        ? { count: samCount, capacity: samCount, builtCount: samCount }
        : { count: 0, capacity: 0, builtCount: 0 };
    behavior.hasPlacedSiloOnMap = () => true;
    return behavior;
  };
  // Target ladder: below the mass threshold the single-site doctrine holds;
  // above it the site count scales with the strongest enemy's silo levels —
  // and only on big-start (5MM/25MM) boards; ordinary profiles keep the
  // doctrine even at silo mass (measured: the ungated lever flipped the
  // no-mod anchor from a full-green win to a 6.4k death).
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 9, samCount: 4, bigStart: false }).samSiteCountTarget(),
    1,
    "ordinary-profile boards never scale SAM sites",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 0, samCount: 1 }).samSiteCountTarget(),
    1,
    "no hostile silo mass keeps one site",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 2, samCount: 1 }).samSiteCountTarget(),
    1,
    "two silo levels stay inside the single-site doctrine",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 3, samCount: 1 }).samSiteCountTarget(),
    2,
    "three silo levels demand a second site",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 4, samCount: 1 }).samSiteCountTarget(),
    2,
    "four silo levels still target two sites",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 6, samCount: 2 }).samSiteCountTarget(),
    3,
    "six silo levels target three sites",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 9, samCount: 4 }).samSiteCountTarget(),
    4,
    "heavy silo mass caps at four sites",
  );
  // The relaxed build gate: with silo mass present, an existing single SAM
  // no longer disqualifies the triggered-SAM path when the target says more
  // sites are needed — and still does below the threshold.
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 4, samCount: 1 }).shouldBuildSiloTriggeredSam(),
    true,
    "silo mass opens the site-#2 build path past one existing SAM",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 2, samCount: 1 }).shouldBuildSiloTriggeredSam(),
    false,
    "ordinary silo presence keeps the single-site gate",
  );
  assert.equal(
    makeSiteScalingBehavior({ levelSum: 9, samCount: 4 }).shouldBuildSiloTriggeredSam(),
    false,
    "the build path closes once the site target is met",
  );
}

// ── Rich-board doctrine transfers (D1 ratio, D2 pacing, D3 opening SAM) ────
{
  const originalIsLegendary = sandbox.isLegendaryDifficulty;
  const originalAtLeastHard = sandbox.isAtLeastHardDifficulty;
  sandbox.isLegendaryDifficulty = (d) => d === Difficulty.Legendary;
  sandbox.isAtLeastHardDifficulty = (d) =>
    d === Difficulty.Hard || d === Difficulty.Impossible || d === Difficulty.Legendary;
  const makeDoctrineBehavior = ({ bigStart, pacing, tick = 200 }) => {
    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    behavior.legendaryBigStartGame = () => bigStart;
    behavior.placementsCount = 0;
    behavior.hasHighStartingGold = () => true;
    behavior.game = { ticks: () => tick };
    if (pacing !== undefined) state.bigStartStructurePacing = pacing;
    return behavior;
  };
  const openContext = {
    difficulty: Difficulty.Legendary,
    config: { isUnitDisabled: () => false },
    missileSilosEnabled: true,
    economyGrowthPriority: false,
  };
  assert.equal(
    makeDoctrineBehavior({ bigStart: true }).shouldOpenWithSam(openContext),
    true,
    "D3: big-start Legendary opens with the SAM like engine nations",
  );
  assert.equal(
    makeDoctrineBehavior({ bigStart: false }).shouldOpenWithSam(openContext),
    false,
    "D3: ordinary Legendary keeps the adaptive opening",
  );
  // D2 pacing: the first two placements are free, #3 waits 250 ticks.
  assert.equal(
    makeDoctrineBehavior({
      bigStart: true,
      pacing: { count: 0, lastTick: 100 },
    }).bigStartStructurePacingBlocks(),
    false,
    "D2: early burst placements are unpaced",
  );
  assert.equal(
    makeDoctrineBehavior({
      bigStart: true,
      pacing: { count: 2, lastTick: 100 },
    }).bigStartStructurePacingBlocks(),
    true,
    "D2: placement #3 within 250 ticks of #2 is blocked",
  );
  const paced = makeDoctrineBehavior({
    bigStart: true,
    pacing: { count: 2, lastTick: 100 },
  });
  paced.game = { ticks: () => 351 };
  assert.equal(paced.bigStartStructurePacingBlocks(), false, "D2: the 250-tick gap expires");
  assert.equal(
    makeDoctrineBehavior({
      bigStart: false,
      pacing: { count: 2, lastTick: 100 },
    }).bigStartStructurePacingBlocks(),
    false,
    "D2: ordinary boards are never paced",
  );
  delete state.bigStartStructurePacing;
  sandbox.isLegendaryDifficulty = originalIsLegendary;
  sandbox.isAtLeastHardDifficulty = originalAtLeastHard;
}

{
  const dumpBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  dumpBehavior.game = {
    ticks: () => 1234,
    config: () => ({ isUnitDisabled: () => false }),
  };
  dumpBehavior.player = { gold: () => 249363n };
  dumpBehavior.ownedLevels = (type) => (type === UNIT.Port ? 1 : 0);
  const portCandidate = { type: UNIT.Port, cost: 250000n };
  const cityCandidate = { type: UNIT.City, cost: 119700n };
  dumpBehavior.legendaryConstructionCandidates = () => [portCandidate, cityCandidate];
  dumpBehavior.legendaryConstructionActionGroups = (candidates) => [candidates];
  dumpBehavior.legendaryConstructionActionGroupResult = async () => "built";
  dumpBehavior.maybeOpenLegendaryNavalEconomy = async () => false;
  dumpBehavior.maybeOpenLegendaryArsenal = async () => false;
  dumpBehavior.maybeUpgradeLegendarySam = async () => false;
  dumpBehavior.ownSamCapacity = () => 1;
  dumpBehavior.ownProjectedSamCapacity = () => 1;
  dumpBehavior.maybeSpawnHostileSiloSam = async () => false;
  dumpBehavior.legendaryMissileDefenseUrgent = () => false;
  dumpBehavior.maybeArmFreezeStrikeSilo = async () => false;
  dumpBehavior.troopCapPressure = () => false;
  dumpBehavior.refreshLegendaryCityUpgradeCandidate = async () => {};
  const dumpContext = {
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: true,
    nukesEnabled: true,
    economyGrowthPriority: false,
  };

  const savedConstructionDump = state.stats.constructionDump;
  delete state.stats.constructionDump;
  assert.equal(
    await dumpBehavior.doHandleLegendaryStructures(dumpContext),
    true,
