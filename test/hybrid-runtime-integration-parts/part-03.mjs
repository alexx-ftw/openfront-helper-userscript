assert.equal(links.enabled, true);
adaptive = false;
nation.initializeBehaviors();
assert.equal(links.enabled, false, "faithful controls deactivate optional strategy");
{
  nationRealm.autoBotProfileSyncPhase = (_profile, _phase, operation) => operation();
  nationRealm.autoBotProfileAsyncPhase = async (_profile, _phase, operation) => operation();
  nationRealm.EARLY_EXPAND_COMMIT = 0.5;
  for (const earlyReturn of ["initialize", "pending", "defense", "eliminated"]) {
    const calls = [];
    const scheduled = Object.create(nationRealm.NationBot.prototype);
    Object.assign(scheduled, {
      mg: { myPlayer: () => player, terraNullius: () => ({}) },
      behaviorsInitialized: earlyReturn !== "initialize",
      tickIsCurrent: () => true,
      configureHybridStrategy() {},
      refreshBehaviorPlayerReferences() {},
      prepareInitializedTickState() {},
      runNavalTickPhases: async () => true,
      handleSpawnTick: () => false,
      observeHybridCombat() {},
      handleEliminatedPlayer: () => earlyReturn === "eliminated",
      nukeBehavior: { observeHostileNukeThreats: () => calls.push("observe") },
      initializeTick: async () => {
        calls.push("initialize");
        return nationRealm.NationBot.prototype.initializeTick.call(scheduled, 100, null, 1);
      },
      initializeBehaviors() {
        assert.equal(this.nukeBehavior, undefined, "startup has no preexisting nuke behavior");
        calls.push("create");
        this.nukeBehavior = { observeHostileNukeThreats: () => calls.push("observe") };
        this.structureBehavior = {};
        this.behaviorsInitialized = true;
      },
      feat: (feature) => feature === "expand",
      processPendingNukeSalvo: async () => {
        calls.push("pending");
        return earlyReturn !== "pending";
      },
      attackBehavior: {
        maybeRetakeBeachheads() {},
        forceSendAttack: async () => {
          assert.equal(calls.at(-1), "observe", "startup threat latch precedes opening attack");
          calls.push("opening");
          return true;
        },
      },
      handleIncomingDefense: async () => {
        calls.push("defense");
        return true;
      },
      shouldBuildInitialDefenseWarship: () => false,
      runContainmentGrowth: async () => calls.push("containment"),
      handleOpeningExpansion: () => assert.fail("early return must stop the decision chain"),
    });
    if (earlyReturn === "initialize") delete scheduled.nukeBehavior;
    await scheduled.tick(100, null, 1);
    const expected = {
      initialize: ["initialize", "create", "observe", "opening"],
      pending: ["initialize", "observe", "pending"],
      defense: ["initialize", "observe", "pending", "defense", "containment"],
      eliminated: [],
    }[earlyReturn];
    assert.deepEqual(calls, expected, `native tick observes threats before ${earlyReturn}`);
    await scheduled.tick(100, null, 1);
    assert.deepEqual(calls, expected, "duplicate game tick never repeats threat observation");
  }
}
let spawnSends = 0;
let footprintCalls = 0;
Object.assign(nationRealm, {
  discoverCtors: () => ({ spawn: class Spawn {} }),
  getEventBus: () => ({}),
  reserveBotSpawnFootprint: () => {
    footprintCalls++;
    return false;
  },
  emitIntent: () => {
    spawnSends++;
    return true;
  },
  tr: (key) => key,
  setLastAction() {},
});
nationRealm.window.__OFH_hybridStrategy.diagnostics = () => ({ enabled: true });
nation.spawnTopKeyToValidTile = () => 0;
nation.doSpawn("0,0");
assert.equal(footprintCalls, 1, "native footprint admission occurs at final spawn dispatch");
assert.equal(spawnSends, 0);
nationRealm.window.__OFH_hybridStrategy.diagnostics = () => ({ enabled: false });
nationRealm.state.stats = { spawns: 0 };
nation.doSpawn("0,0");
assert.equal(spawnSends, 1, "faithful disabled strategy preserves the original emitter");

const panelRealm = {
  window: {},
  PANEL_ID: "test",
  tr: (key) => key,
  UNIT: { MissileSilo: "Missile Silo", SAMLauncher: "SAM Launcher" },
};
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/panel.js"), panelRealm);
assert.equal(
  typeof panelRealm.hybridNativeKnowledgeMarkup,
  "function",
  "panel consumes native knowledge",
);
assert.equal(
  typeof panelRealm.restoreHybridCombatSelection,
  "function",
  "saved v2 selection has an explicit restore seam",
);
const saved = {
  model: { schema: "ofh-combat-compact-tanh-v2" },
  config: { mode: "learned", learning: false },
};
let selectedModel;
let restoredConfig;
panelRealm.window.localStorage = {
  getItem: (key) => (key.endsWith("backend") ? "compact-tanh-v1" : JSON.stringify(saved)),
};
panelRealm.window.__OFH_hybridCombat = {
  importModel: (model) => {
    selectedModel = model;
  },
  configure: (config) => {
    restoredConfig = config;
  },
};
panelRealm.restoreHybridCombatSelection();
assert.equal(selectedModel.schema, saved.model.schema);
assert.equal(restoredConfig.mode, "learned");
saved.config.mode = "invalid";
selectedModel = null;
panelRealm.restoreHybridCombatSelection();
assert.equal(selectedModel, null, "invalid saved mode cannot partly import a backend");
assert.match(panelRealm.window.__OFH_hybridStorageError, /Invalid saved configuration/);

// Regression: wrapper replacement must retain the same current Structure safety instance.
function economicRealm() {
  const realm = {
    window: {},
    UNIT: { City: "City", Factory: "Factory", Port: "Port" },
    Difficulty: {
      Easy: "Easy",
      Medium: "Medium",
      Hard: "Hard",
      Impossible: "Impossible",
      Legendary: "Legendary",
    },
    state: { settings: { winFixes: true }, stats: { builds: 0 } },
    withTimeout: async (promise) => promise,
    WORKER_TIMEOUT_MS: 100,
    hasIntentRateLimitCapacity: () => true,
    tryAcquireIntentRateLimit: () => true,
    isLegendaryDifficulty: () => false,
    tr: (value) => value,
    setLastAction() {},
  };
  for (const source of [
    readStructureBehaviorSource(),
    ...["hybridStrategy", "context", "gameApi", "nationExecution"].map(
      (file) =>
        readRepositoryFile(`engine/ingame/auto-bot/${file}.js`) +
        (file === "nationExecution" ? "\nglobalThis.NationBot=NationBot;" : ""),
    ),
  ])
    executeClassicScript(source, realm);
  realm.window.__OFH_hybridStrategy.configure({ enabled: true });
  return realm;
}
{
  const realm = economicRealm();
  let currentTick = 10;
  let impact = true;
  const core = {
    smallID: () => 1,
    isPlayer: () => true,
    isAlive: () => true,
    gold: () => 1000n,
    borderTiles: () => new Set([7]),
    profile: () => ({}),
    units: () => [],
  };
  const adapter = realm.createGameApi({
    ticks: () => currentTick,
    units: () => [],
    config: () => ({}),
  });
  await adapter.beginTick(core);
  const initial = adapter.game.myPlayer();
