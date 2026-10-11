import assert from "node:assert/strict";
import { createAttackBehaviorSandbox } from "./helpers/attack-behavior-sandbox.mjs";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";

// Production callers, not a second policy implementation. Removing the native
// geometry bridge or final purchase veto must fail these assertions.
const sandbox = createAttackBehaviorSandbox();
sandbox.window = {};
sandbox.withTimeout = async (promise) => promise;
sandbox.WORKER_TIMEOUT_MS = 100;
const attack = Object.create(sandbox.AttackBehavior.prototype);
let tick = 10;
const own = { smallID: () => 1, borderTiles: () => new Set([0, 1]) };
const target = { smallID: () => 2, borderTiles: () => new Set([8, 9]) };
attack.player = own;
attack.game = {
  ticks: () => tick,
  width: () => 10,
  height: () => 10,
  x: (tile) => tile % 10,
  y: (tile) => Math.floor(tile / 10),
};
assert.equal(
  typeof attack.prepareHybridCombatGeometry,
  "function",
  "native geometry preparation exists",
);
assert.equal(attack.hybridCombatGeometry(target), null, "no unstamped cached geometry");
await attack.prepareHybridCombatGeometry([target]);
const geometry = attack.hybridCombatGeometry(target);
assert.equal(geometry.tick, tick);
assert.equal(geometry.targetSmallID, 2);
assert.equal(geometry.own.x, 0.5);
assert.equal(geometry.target.x, 8.5);
tick++;
assert.equal(attack.hybridCombatGeometry(target), null, "geometry never crosses ticks");
const drifting = {
  ...target,
  borderTiles: async () => {
    tick++;
    return new Set([8]);
  },
};
await attack.prepareHybridCombatGeometry([drifting]);
assert.equal(attack.hybridCombatGeometry(target), null, "async drift abstains");

let tokens = 0;
let sends = 0;
let vetoInput;
const player = { smallID: () => 1, gold: () => 100n, isAlive: () => true };
const game = { ticks: () => 1 };
const context = {
  window: {
    __OFH_hybridStrategy: {
      admitEconomicPurchase: (input) => {
        vetoInput = input;
        return { blocked: true, notBeforeTick: 2 };
      },
    },
  },
  hasIntentRateLimitCapacity: () => true,
  tryAcquireIntentRateLimit: () => {
    tokens++;
    return true;
  },
};
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/context.js"), context);
context.discoverCtors = () => ({ buildUnit: class BuildUnit {} });
const menu = {
  eventBus: {
    emit: () => {
      sends++;
    },
  },
  sendBuildOrUpgrade: () => {
    sends++;
  },
};
assert.equal(
  context.sendAutoBotBuildOrUpgrade(
    menu,
    { type: "City", cost: 1n, canBuild: 0, canUpgrade: false },
    0,
    game,
    player,
  ),
  false,
);
assert.equal(tokens, 0, "veto runs before acquiring the sole token");
assert.equal(sends, 0);
assert.equal(vetoInput.tile, 0);
assert.equal(vetoInput.reservedGold, 0n);
context.window.__OFH_hybridStrategy.admitEconomicPurchase = () => ({ blocked: false });
assert.equal(
  context.sendAutoBotBuildOrUpgrade(
    menu,
    { type: "City", cost: 1n, canBuild: 4, canUpgrade: false },
    4,
    game,
    player,
  ),
  true,
);
assert.equal(tokens, 1);
assert.equal(sends, 1);
const safetyRows = [];
sandbox.window.__OFH_hybridSafety = (row) => safetyRows.push(row);
sandbox.hybridCombatPolicy = {
  mode: "learned",
  generation: 4,
  episodeId: 2,
  dispatch: { id: 7, generation: 4, targetSmallID: 2 },
  proposal: { step: 3, tick },
  allowsAttack: () => true,
};
let legalityCalls = 0;
attack.player = {
  ...own,
  canAttackPlayer: () => {
    legalityCalls++;
    return false;
  },
};
target.isPlayer = () => true;
target.id = () => "target";
assert.equal(await attack.sendAttack(target), false);
assert.equal(legalityCalls, 1, "capture the existing native check without repeating it");
assert.equal(safetyRows.length, 1, "rejected learned attempts remain visible");
assert.equal(safetyRows[0].legalityPassed, false);
assert.equal(safetyRows[0].emitted, false);
assert.equal(safetyRows[0].reservePassed, null);
assert.equal(safetyRows[0].step, 3);
attack.hybridSafetyAttempt = {};
attack.player.troops = () => 200;
attack.getLiveOutboundAttackTroopsForTarget = () => 0;
attack.shouldBlockInitialPlayerAttack = () => true;
const deniedReserve = {
  target: { isPlayer: () => true, troops: () => 10 },
  targetTroops: 10,
  targetSpendableTroops: 2,
  finalSpendableTroops: 2,
  defenseProfile: null,
  force: false,
};
assert.equal(attack.calculateRegularLandAttackTroops(deniedReserve), 0);
assert.equal(
  attack.hybridSafetyAttempt.reservePassed,
  false,
  "actual native insufficient-reserve branch is reported while blocked",
);
attack.hybridSafetyAttempt = null;

let dangerCalls = 0;
sandbox.window.__OFH_hybridStrategy = {
  transportCommitment: (_context, id) => ({ id, status: "unconfirmed", arrivalTick: null }),
};
sandbox.UNIT.TransportShip = "Transport Ship";
attack.player.units = () => [{ id: () => 9 }];
attack.boatLaunchWarshipDangerGateActive = () => true;
attack.boatWarshipDangerRadius = () => 1;
attack.hostileWarshipNearDestination = () => {
  dangerCalls++;
  return false;
};
attack.hostileHunterCoversCorridor = () => {
  dangerCalls++;
  return true;
};
assert.equal(attack.boatLaunchWarshipDanger(4), true);
assert.equal(dangerCalls, 2, "reuse the existing destination and corridor guard results");
assert.equal(attack.hybridBoatRisk.transports[0].status, "unconfirmed");
assert.equal(
  attack.hybridBoatRisk.transports[0].arrivalTick,
  null,
  "missing native arrival never becomes a predicted landing",
);

let inferenceCalls = 0;
let timingRows = 0;
sandbox.performance = { now: () => 1 };
sandbox.window.__OFH_hybridDecisionTiming = () => {
  timingRows++;
};
sandbox.hybridCombatPolicy.backend = "compact-tanh-v1";
const callerIdentity = {
  generation: sandbox.hybridCombatPolicy.generation,
  episodeId: sandbox.hybridCombatPolicy.episodeId,
  step: 3,
  tick,
  ingressSequence: 0,
  actorSmallID: own.smallID(),
  modelIdentity: "fixture-original-model",
  decisionSequence: null,
  decisionReferenceKind: null,
};
const geometryCancellations = [];
sandbox.hybridCombatPolicy.enabled = () => true;
sandbox.hybridCombatPolicy.decisionIdentity = (behavior) => {
  assert.equal(behavior, attack);
  return callerIdentity;
};
sandbox.hybridCombatPolicy.recordGeometryCancellation = (identity, suppliedTargets, reason) => {
  geometryCancellations.push({ identity, suppliedTargets, reason });
};
sandbox.hybridCombatPolicy.decide = async () => {
  inferenceCalls++;
  return true;
};
attack.prepareHybridCombatGeometry = async () => {
  sandbox.hybridCombatPolicy.generation++;
};
assert.equal(
  await attack.decideHybridCombat([target]),
  false,
  "generation change cancels geometry inference",
);
assert.equal(inferenceCalls, 0);
assert.equal(timingRows, 1, "actual abstained geometry work still has measured latency");
assert.deepEqual(
  geometryCancellations,
  [{ identity: callerIdentity, suppliedTargets: 1, reason: "cancelled-generation" }],
  "enabled caller retains the original identity across geometry cancellation",
);
sandbox.hybridCombatPolicy.enabled = () => false;
sandbox.hybridCombatPolicy.decisionIdentity = () => {
  assert.fail("disabled policy has no decision identity");
};
assert.equal(await attack.decideHybridCombat([target]), false);
assert.equal(
  geometryCancellations.length,
  1,
  "disabled caller creates no policy cancellation observation",
);
assert.equal(inferenceCalls, 0);
assert.equal(timingRows, 2);

let factoryCalls = 0;
let adaptive = true;
const links = {};
const Stub = class Behavior {};
const nationRealm = {
  window: {
    __OFH_hybridStrategy: {
      reset() {},
      configure: (config) => {
        links.enabled = config.enabled;
      },
      createStructureBehavior: () => {
        factoryCalls++;
        return links;
      },
    },
  },
  state: { settings: { winFixes: true } },
  isLegendaryDifficulty: () => adaptive,
  EmojiBehavior: Stub,
  MirvBehavior: Stub,
  AllianceBehavior: Stub,
  WarshipBehavior: Stub,
  AttackBehavior: Stub,
  NukeBehavior: Stub,
  StructureBehavior: Stub,
};
executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/nationExecution.js") +
    "\nglobalThis.NationBot=NationBot;",
  nationRealm,
);
const nation = Object.create(nationRealm.NationBot.prototype);
Object.assign(nation, { random: {}, mg: game, player });
nation.initializeBehaviors();
assert.equal(factoryCalls, 1, "Nation selects the optional factory");
assert.equal(nation.nukeBehavior.structureBehavior, nation.structureBehavior);
assert.equal(nation.warshipBehavior.structureBehavior, nation.structureBehavior);
assert.equal(links.enabled, true);
adaptive = false;
nation.initializeBehaviors();
assert.equal(links.enabled, false, "faithful controls deactivate optional strategy");
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
  for (const file of [
    "structureBehavior",
    "hybridStrategy",
    "context",
    "gameApi",
    "nationExecution",
  ])
    executeClassicScript(
      readRepositoryFile(`engine/ingame/auto-bot/${file}.js`) +
        (file === "nationExecution" ? "\nglobalThis.NationBot=NationBot;" : ""),
      realm,
    );
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
  let currentTick = 10;
  let acceptedEmitter = false;
  let emissions = 0;
  const feeds = new Map();
  const ownAttacks = [];
  const actor = (sid) => ({
    smallID: () => sid,
    id: () => `p${sid}`,
    isPlayer: () => true,
    type: () => "HUMAN",
    isAlive: () => true,
    isFriendly: (peer) => peer.smallID() !== 3,
    sharesBorderWith: () => true,
    canAttackPlayer: () => true,
    troops: () => 1000,
    units: () => [],
    outgoingEmojis: () => feeds.get(sid) ?? [],
    outgoingAttacks: () => (sid === 1 ? [anchor] : ownAttacks),
  });
  const leader = actor(1);
  const me = actor(2);
  const enemy = actor(3);
  const anchor = {
    id: () => "leader-anchor",
    attacker: () => leader,
    target: () => enemy,
    retreating: () => false,
  };
  const world = {
    ticks: () => currentTick,
    players: () => [leader, me, enemy],
    config: () => ({ emojiMessageDuration: () => 50 }),
  };
  const strategy = realm.window.__OFH_hybridStrategy;
  strategy.configure({ enabled: true });
  strategy.observeDuo({ game: world, player: me });
  feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 10 }]);
  strategy.observeDuo({ game: world, player: me });
  currentTick++;
  feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 11 }]);
  realm.companionJointPlan = (nativeGame, player) =>
    strategy.getJointPlan({ game: nativeGame, player }, 1);
  realm.discoverCtors = () => ({ attack: class Attack {} });
  realm.getEventBus = () => ({});
  realm.hasAttackIntentRateCapacity = () => true;
  realm.emitIntent = () => {
    if (acceptedEmitter) emissions++;
    return acceptedEmitter;
  };
  realm.setLastAction = () => {};
  realm.tr = (value) => value;
  const behavior = Object.create(realm.AttackBehavior.prototype);
  Object.assign(behavior, {
    game: world,
    player: me,
    botAttackPendingIntentCommitments: [],
    incomingHostileAttackPressure: () => 0,
    shouldAttack: () => true,
    sendAttackTargetIsAuthorized: () => true,
    captureSameClanNukeTerrain: () => {},
    createLandAttackContext: (target) => ({
      target,
      finalSpendableTroops: 1000,
      force: false,
      requiredTribeAttackTroops: null,
    }),
    calculateLandAttackTroops: () => 100,
    adjustLandAttackTroops: (_context, value) => value,
    landAttackTroopsAreSafe: () => true,
  });
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "failed emitter does not consume consent",
  );
  assert.ok(strategy.getJointPlan({ game: world, player: me }, 1));
  acceptedEmitter = true;
  assert.equal(await behavior.tryHybridJointAttack(), true);
  assert.equal(await behavior.tryHybridJointAttack(), false);
  ownAttacks.push({
    id: () => "own-receipt",
    target: () => enemy,
    troops: () => 100,
    retreating: () => false,
  });
  currentTick++;
  behavior.reconcileOutboundAttackIntentCommitments();
  assert.equal(behavior.botAttackPendingIntentCommitments.length, 0);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "same consumed REQUEST/ACK stays blocked after own receipt",
  );
  assert.equal(emissions, 1);
  currentTick++;
  feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 13 }]);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    false,
    "new request still needs its own native ACK",
  );
  currentTick++;
  feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 14 }]);
  assert.equal(
    await behavior.tryHybridJointAttack(),
    true,
    "legitimate newer exchange remains dispatchable",
  );
  assert.equal(emissions, 2);
}

process.stdout.write("hybrid runtime caller tests passed\n");
