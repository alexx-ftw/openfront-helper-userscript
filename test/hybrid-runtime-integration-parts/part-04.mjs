  const strategy = realm.window.__OFH_hybridStrategy;
  const structure = strategy.createStructureBehavior({}, adapter.game, initial);
  Object.assign(structure, {
    availableGoldAfterReserve: () => 1000n,
    tileInsideActiveHostileMissileImpact: () => impact,
  });
  const purchase = (actor) =>
    strategy.admitEconomicPurchase({
      game: adapter.game,
      player: actor,
      buildable: { type: "City", cost: 10n, canBuild: 7, canUpgrade: false },
      tile: 7,
      reservedGold: 0n,
    });
  assert.equal(purchase(initial).reason, "incoming-impact");
  currentTick++;
  await adapter.beginTick({ ...core });
  const fresh = adapter.game.myPlayer();
  assert.notEqual(initial, fresh);
  const nation = Object.create(realm.NationBot.prototype);
  Object.assign(nation, {
    player: fresh,
    structureBehavior: structure,
    behaviorsInitialized: true,
  });
  nation.refreshBehaviorPlayerReferences();
  assert.equal(
    purchase(fresh).reason,
    "incoming-impact",
    "per-tick wrapper keeps current inherited impact veto",
  );
  assert.equal(nation.structureBehavior, structure);
  assert.equal(structure.player, fresh);
  impact = false;
  structure.availableGoldAfterReserve = () => 0n;
  assert.equal(
    purchase(fresh).reason,
    "defense-budget",
    "same registered instance retains defense budget",
  );
  structure.availableGoldAfterReserve = () => 1000n;
  structure.hybridDefensiveQuote = { sourceTick: currentTick, cost: 995n };
  assert.equal(purchase(fresh).reason, "urgent-defense-quote");
  strategy.configure({ enabled: false });
  assert.equal(purchase(fresh).blocked, false);
}
// Regression: the inherited upgrade sender uses a unit ID, not a placement tile.
{
  const realm = economicRealm();
  let emitted = 0;
  let acquired = 0;
  let unsafe = false;
  realm.getBuildMenu = () => ({
    sendBuildOrUpgrade: (_buildable, dispatchTile) => {
      assert.equal(dispatchTile, undefined, "native upgrade dispatch signature stays unchanged");
      emitted++;
    },
  });
  realm.tryAcquireIntentRateLimit = () => {
    acquired++;
    return true;
  };
  const actor = { smallID: () => 1, isAlive: () => true, gold: () => 1000n };
  let owner = actor;
  let type = "City";
  let site = 7;
  let present = true;
  const unit = { id: () => 42, type: () => type, tile: () => site, owner: () => owner };
  let upgradeTick = 10;
  const raw = {
    ticks: () => upgradeTick,
    units: (requested) => (present && requested === type ? [unit] : []),
    config: () => ({
      trainStationMinRange: () => 10,
      trainStationMaxRange: () => 20,
    }),
  };
  const game = realm.createGameApi(raw).game;
  const strategy = realm.window.__OFH_hybridStrategy;
  const structure = strategy.createStructureBehavior({}, game, actor);
  Object.assign(structure, {
    getTotalStructureDensity: () => 1,
    findBestStructureToUpgrade: async () => ({
      structure: unit,
      bu: { type, cost: 10n, canUpgrade: 42, canBuild: false },
    }),
    genericStructureUpgradeAllowed: () => true,
    availableGoldAfterReserve: () => 1000n,
    tileInsideActiveHostileMissileImpact: () => unsafe,
  });
  for (const kind of ["City", "Factory", "Port"]) {
    type = kind;
    assert.equal(
      await structure.maybeUpgradeStructure([unit], { economicSpaceExhausted: true }),
      true,
      "real inherited upgrade accepts current typed native unit",
    );
  }
  assert.equal(emitted, 3);
  assert.equal(acquired, 3);
  const denied = () =>
    realm.sendAutoBotBuildOrUpgrade(
      realm.getBuildMenu(),
      { type: "City", cost: 10n, canUpgrade: 42, canBuild: false },
      undefined,
      game,
      actor,
    );
  type = "City";
  upgradeTick++;
  owner = { smallID: () => 2 };
  assert.equal(denied(), false);
  upgradeTick++;
  owner = actor;
  type = "Factory";
  assert.equal(denied(), false);
  upgradeTick++;
  type = "City";
  present = false;
  assert.equal(denied(), false);
  upgradeTick++;
  present = true;
  site = NaN;
  assert.equal(denied(), false);
  upgradeTick++;
  site = 7;
  unsafe = true;
  assert.equal(denied(), false);
  assert.equal(acquired, 3, "rejected upgrade evidence never acquires a token");
}
// Regression: raw client views lack native historical nuclear cost counters.
{
  const realm = {
    window: {},
    PANEL_ID: "fixture",
    UNIT: { MissileSilo: "Missile Silo", SAMLauncher: "SAM Launcher" },
    tr: (value) => value,
  };
  const configSource = readRepositoryFile("openfront-engine/src/core/configuration/Config.ts");
  const start = "return (game: Game, player: Player, extraUnits: number = 0) => {";
  const offset = configSource.indexOf(start, configSource.indexOf("private costWrapper("));
  const body = configSource.slice(
    offset + start.length,
    configSource.indexOf("\n    };\n  }", offset),
  );
  executeClassicScript(
    `globalThis.nativeCost = (function(types,costFn){return (game,player,extraUnits=0)=>{${body}}}).call({hasInfiniteGoldFor:()=>false},["Atom Bomb"],()=>750000);`,
    realm,
  );
  const client = { type: () => "HUMAN", units: () => [] };
  const nativeGame = {
    ticks: () => 1,
    myPlayer: () => client,
    config: () => ({ unitInfo: () => ({ cost: realm.nativeCost }) }),
  };
  realm.getGame = () => nativeGame;
  realm.PlayerType = { Human: "HUMAN" };
  for (const file of ["hybridNativeKnowledge", "panel"])
    executeClassicScript(readRepositoryFile(`engine/ingame/auto-bot/${file}.js`), realm);
  assert.doesNotThrow(
    () => realm.hybridNativeKnowledgeMarkup(),
    "client-native missing counters render unknown",
  );
  const knowledge = realm.window.__OFH_hybridNativeKnowledge;
  assert.equal(
    knowledge.quoteNuclearPurchase({ game: nativeGame, player: client }, "Atom Bomb").status,
    "unknown",
  );
  client.unitsOwned = () => NaN;
  client.unitsConstructed = () => 1;
  assert.equal(
    knowledge.quoteNuclearPurchase({ game: nativeGame, player: client }, "Atom Bomb").status,
    "unknown",
    "malformed native counters cannot certify a constant price",
  );
  client.unitsOwned = () => 0;
  client.unitsConstructed = () => 0;
  assert.equal(
    knowledge.quoteNuclearPurchase({ game: nativeGame, player: client }, "Atom Bomb").costDecimal,
    "750000",
  );
}

// Regression: native pending receipts are not a consent-consumption ledger.
{
  const realm = createAttackBehaviorSandbox();
  realm.window = {};
  realm.state.stats = { attacks: 0 };
  executeClassicScript("class StructureBehavior {}", realm);
  executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/hybridStrategy.js"), realm);
