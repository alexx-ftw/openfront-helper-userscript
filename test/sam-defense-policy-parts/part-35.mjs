    false,
    "the peace-scoped warship defer never fires under short default immunity",
  );

  // The speculative first silo is pure consumption during a long peace
  // window: nothing needs striking before immunity expires. Reset the
  // big-start memo: earlier fixtures may have decided it for this sandbox.
  delete state.bigStartGold;
  let siloSpawnAttempts = 0;
  const siloBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  siloBehavior.legendarySamBaselineChestActive = () => false;
  siloBehavior.game = makePeaceBehavior({ duration: 2400, tick: 800 }).game;
  siloBehavior.safeConstructionCost = () => 1_000_000n;
  // Ordinary-game treasury: >= 4M unspent at <= 1 city would read as the
  // 5MM/25MM big-start signature and (correctly) defer the silo.
  siloBehavior.spendableConstructionGold = () => 2_000_000n;
  siloBehavior.maybeSpawnStructure = () => {
    siloSpawnAttempts++;
    return true;
  };
  assert.equal(
    siloBehavior.maybeOpenLegendaryFirstSilo(),
    false,
    "the first offensive silo is deferred during long guaranteed peace",
  );
  assert.equal(siloSpawnAttempts, 0, "no silo build is even attempted");
  siloBehavior.game = makePeaceBehavior({ duration: 50, tick: 800 }).game;
  assert.equal(
    siloBehavior.maybeOpenLegendaryFirstSilo(),
    true,
    "short default immunity keeps the ordinary first-silo path",
  );
  assert.equal(siloSpawnAttempts, 1, "exactly one silo build attempted");
  sandbox.isLegendaryDifficulty = originalIsLegendary;
}

// ── Big-start opening (5MM/25MM): port burst + first-silo deferral ─────────
{
  const makeBigStartBehavior = ({ tick, gold, ports = [] }) => {
    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    behavior.game = { ticks: () => tick };
    behavior.player = {
      gold: () => gold,
      units: (type) => (type === UNIT.Port ? ports : []),
    };
    return behavior;
  };
  // Detection: 5M at tick 6 decides true once; 0 gold decides false; a
  // first look after tick 150 decides false (late looks are meaningless).
  delete state.bigStartGold;
  assert.equal(
    makeBigStartBehavior({ tick: 6, gold: 5_000_000n }).legendaryBigStartGame(),
    true,
    "a 5M opening treasury marks the game as big-start",
  );
  delete state.bigStartGold;
  assert.equal(
    makeBigStartBehavior({ tick: 6, gold: 0n }).legendaryBigStartGame(),
    false,
    "an ordinary opening treasury is not big-start",
  );
  delete state.bigStartGold;
  assert.equal(
    makeBigStartBehavior({ tick: 6, gold: 25_000_000n }).legendaryBigStartGame(),
    true,
    "25MM is big-start too",
  );
  assert.equal(
    state.bigStartGold?.decided,
    true,
    "the decision is memoized for the rest of the game",
  );
  assert.equal(state.bigStartGold?.value, true, "…and remembers big-start");
  delete state.bigStartGold;
  assert.equal(
    makeBigStartBehavior({ tick: 800, gold: 5_000_000n }).legendaryBigStartGame(),
    true,
    "an unspent big treasury still counts after the first City (treasury signature, not tick)",
  );
  delete state.bigStartGold;
  assert.equal(
    makeBigStartBehavior({ tick: 1_600, gold: 5_000_000n }).legendaryBigStartGame(),
    false,
    "detection stops trusting the treasury after the opening window",
  );

  // First silo deferral: big-start with <5 ports defers the speculative
  // silo; the 3000-tick backstop restores the ordinary path.
  delete state.bigStartGold;
  const deferBehavior = makeBigStartBehavior({
    tick: 6,
    gold: 5_000_000n,
    ports: [{}, {}],
  });
  deferBehavior.legendarySamBaselineChestActive = () => false;
  deferBehavior.safeConstructionCost = () => 1_000_000n;
  deferBehavior.spendableConstructionGold = () => 4_000_000n;
  let siloAttempts = 0;
  deferBehavior.maybeSpawnStructure = async () => {
    siloAttempts += 1;
    return true;
  };
  assert.equal(
    await deferBehavior.maybeOpenLegendaryFirstSilo(true),
    false,
    "the speculative silo waits for the port burst",
  );
  assert.equal(siloAttempts, 0, "no silo build is attempted mid-burst");
  const backstopBehavior = makeBigStartBehavior({
    tick: 3_100,
    gold: 5_000_000n,
    ports: [{}, {}],
  });
  backstopBehavior.legendarySamBaselineChestActive = () => false;
  backstopBehavior.safeConstructionCost = () => 1_000_000n;
  backstopBehavior.spendableConstructionGold = () => 4_000_000n;
  backstopBehavior.maybeSpawnStructure = async () => true;
  assert.equal(
    await backstopBehavior.maybeOpenLegendaryFirstSilo(true),
    true,
    "the 3000-tick backstop restores the silo lane",
  );
  delete state.bigStartGold;
}

// ── Plateau gold-to-City conversion (the FFA freeze) ────────────────────────
{
  const originalIsLegendary = sandbox.isLegendaryDifficulty;
  sandbox.isLegendaryDifficulty = () => true;
  let tick = 5_000;
  const plateauBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  plateauBehavior.game = {
    ticks: () => tick,
    config: () => ({ isUnitDisabled: () => false, gameConfig: () => ({ gameMode: "FFA" }) }),
  };
  const cityUnits = [];
  plateauBehavior.player = {
    numTilesOwned: () => 50_000,
    gold: () => 2_900_000n,
    units: (type) => (type === UNIT.City ? cityUnits : []),
  };
  plateauBehavior.ownedLevels = (type) => (type === UNIT.City ? 3 : 0);
  plateauBehavior.unitUnderConstruction = () => false;
  plateauBehavior.safeConstructionCost = () => 125_000n;
  let citySpawns = 0;
  plateauBehavior.maybeSpawnStructure = async () => {
    citySpawns += 1;
    return true;
  };
  delete sandbox.state.plateauTiles;
  delete sandbox.state.plateauSinceTick;

  // Fresh state: the plateau clock has not elapsed.
  assert.equal(
    plateauBehavior.tilesPlateaued(),
    false,
    "the plateau clock starts at the first observation",
  );
  tick += 500;
  assert.equal(plateauBehavior.tilesPlateaued(), false, "under 900 flat ticks is not a plateau");
  tick += 500;
  assert.equal(plateauBehavior.tilesPlateaued(), true, "900+ flat ticks form a plateau");

  // The freeze conversion fires: 3 Cities on 50k tiles with 2.9M gold.
  await plateauBehavior.maybeSpawnPlateauCity();
  assert.equal(citySpawns, 1, "a hoarded-gold plateau builds a City (raises maxTroops)");

  // Growth resets the plateau clock.
  const grewBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  grewBehavior.game = plateauBehavior.game;
  let tiles = 50_000;
  grewBehavior.player = {
    numTilesOwned: () => tiles,
    gold: () => 2_900_000n,
    units: () => [],
  };
  delete sandbox.state.plateauTiles;
  delete sandbox.state.plateauSinceTick;
  grewBehavior.tilesPlateaued();
  tick += 1_000;
  tiles = 60_000;
  assert.equal(
    grewBehavior.tilesPlateaued(),
    false,
    "actual growth (>2%) resets the plateau clock",
  );

  // Dense-enough empires and thin purses do not convert.
  const denseBehavior = Object.create(sandbox.__StructureBehavior.prototype);
  denseBehavior.game = plateauBehavior.game;
