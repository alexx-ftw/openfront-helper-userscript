import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/shared-utils.js");
const WARSHIP_BEHAVIOR_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/warshipBehavior.js");
const ATTACK_BEHAVIOR_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/attackBehavior.js");

const warshipBehaviorSource = fs.readFileSync(WARSHIP_BEHAVIOR_SOURCE, "utf8");
const safeWaypointSource = warshipBehaviorSource.match(
  /findSafeWaypoint\(start, baseTarget, enemies\) \{([\s\S]*?)\n {4}\}/,
)?.[1];
assert.ok(safeWaypointSource, "safe-waypoint traversal must remain inspectable");
assert.doesNotMatch(
  safeWaypointSource,
  /\.shift\s*\(/,
  "safe-waypoint BFS must not repeatedly shift its traversal queue",
);
assert.match(
  safeWaypointSource,
  /queueHead\s*<\s*queue\.length/,
  "safe-waypoint BFS must consume its queue through a constant-time cursor",
);

const attackBehaviorSource = fs.readFileSync(ATTACK_BEHAVIOR_SOURCE, "utf8");
const clusterPublisherSource = attackBehaviorSource.match(
  /publishPreferredEarlyGameCluster\(candidates, futureFoodById\) \{([\s\S]*?)\n {4}\}/,
)?.[1];
assert.ok(clusterPublisherSource, "early-game cluster publication must remain inspectable");
assert.doesNotMatch(
  clusterPublisherSource,
  /\.sort\s*\(/,
  "publishing one preferred tribe cluster must not sort every candidate",
);
assert.match(
  clusterPublisherSource,
  /for \(const candidate of candidates\)/,
  "preferred tribe cluster selection must remain a single linear scan",
);

const sandbox = {
  Array,
  Map,
  Math,
  Number,
  String,
  document: {},
  CSS: { escape: (value) => String(value) },
  globalThis: null,
};
sandbox.globalThis = sandbox;
executeClassicScript(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });

let tick = 10;
let unitsCalls = 0;
const game = {
  ticks: () => tick,
  units: (...types) => {
    unitsCalls += 1;
    return [{ types }];
  },
};

const first = sandbox.getCachedGameUnits(game, "Warship");
const second = sandbox.getCachedGameUnits(game, "Warship");
assert.strictEqual(second, first, "same unit family should reuse the per-tick snapshot");
assert.equal(unitsCalls, 1, "same unit family should call GameView.units once per tick");

sandbox.getCachedGameUnits(game, "Missile Silo", "SAM Launcher");
assert.equal(unitsCalls, 2, "different unit families keep independent cached snapshots");

tick += 1;
const nextTick = sandbox.getCachedGameUnits(game, "Warship");
assert.notStrictEqual(nextTick, first, "a new game tick must invalidate unit snapshots");
assert.equal(unitsCalls, 3, "a new game tick should refresh the requested family once");

const GAME_API_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/gameApi.js");
const gameApiSandbox = {
  PlayerType: { Bot: "BOT" },
  UNIT: {},
  WORKER_TIMEOUT_MS: 4000,
  withTimeout: (promise) => Promise.resolve(promise),
  globalThis: null,
};
gameApiSandbox.globalThis = gameApiSandbox;
executeClassicScript(
  `${fs.readFileSync(GAME_API_SOURCE, "utf8")}\nglobalThis.__createGameApi = createGameApi;`,
  gameApiSandbox,
  { filename: GAME_API_SOURCE },
);

let gameApiTick = 1;
let playerUnitCalls = 0;
let globalUnitCalls = 0;
let playerListCalls = 0;
let borderNeighborCalls = 0;
let oceanShoreCalls = 0;
const rawUnit = {
  id: () => 1,
  type: () => "Warship",
  owner: () => playerCore,
  targetUnitId: () => 2,
};
const rawTargetUnit = {
  id: () => 2,
  type: () => "Transport",
  owner: () => playerCore,
};
const playerCore = {
  isPlayer: () => true,
  smallID: () => 7,
  id: () => "player-7",
  isFriendly: (other) => other === playerCore,
  borderTiles: async () => ({ borderTiles: new Set([1]) }),
  profile: async () => ({ relations: {} }),
  units: () => {
    playerUnitCalls += 1;
    return [rawUnit];
  },
};
const gameApiSource = {
  ticks: () => gameApiTick,
  players: () => {
    playerListCalls += 1;
    return [playerCore];
  },
  units: () => {
    globalUnitCalls += 1;
    return [rawUnit];
  },
  unit: (id) => (id === 2 ? rawTargetUnit : undefined),
  width: () => 1,
  height: () => 1,
  neighbors: () => {
    borderNeighborCalls += 1;
    return [2, 3];
  },
  isWater: () => false,
  isLand: () => true,
  isShore: () => false,
  isOcean: () => false,
  isOceanShore: (tile) => {
    oceanShoreCalls += 1;
    return tile === 1;
  },
  ownerID: () => 7,
  hasOwner: () => true,
  playerBySmallID: () => playerCore,
};
const wrappedApi = gameApiSandbox.__createGameApi(gameApiSource);
const gameApi = wrappedApi.game;
const playerView = gameApi._wrapPlayer(playerCore);
await wrappedApi.beginTick(playerCore);
assert.deepEqual([...playerView.borderTiles()], [1]);
const firstOceanShores = playerView.oceanShoreBorderTiles();
const secondOceanShores = playerView.oceanShoreBorderTiles();
assert.deepEqual([...firstOceanShores], [1], "ocean shore cache must preserve the exact predicate");
assert.strictEqual(
  secondOceanShores,
  firstOceanShores,
  "repeated ocean-shore reads should reuse the current border snapshot",
);
assert.equal(oceanShoreCalls, 1, "the exact ocean-shore predicate runs once per border snapshot");
delete gameApiSource.isOceanShore;
gameApiTick += 1;
await wrappedApi.beginTick(playerCore);
assert.equal(
  playerView.oceanShoreBorderTiles(),
  null,
  "an unavailable exact ocean predicate is distinguishable from a coastless border",
);
assert.equal(playerView.sharesBorderWith(playerView), true);
const callsAfterFirstBorderCheck = borderNeighborCalls;
assert.equal(playerView.sharesBorderWith(playerView), true);
assert.equal(
  borderNeighborCalls,
  callsAfterFirstBorderCheck,
  "repeated border relations should reuse the exact result within one game tick",
);
const firstPlayerUnits = playerView.units("Warship");
const secondPlayerUnits = playerView.units("Warship");
assert.strictEqual(
  secondPlayerUnits,
  firstPlayerUnits,
  "gameApi player units should reuse the same snapshot within a game tick",
);
assert.equal(playerUnitCalls, 1, "player units should be read once per family and tick");
assert.equal(
  gameApi.cachedUnitCount("Warship"),
  null,
  "a player-only cached family is not exposed as a global unit count",
);
assert.equal(globalUnitCalls, 0, "a cache miss must not materialize global units");
assert.equal(
  firstPlayerUnits[0].isFriendly(playerView),
  true,
  "wrapped units should inherit friendliness from their owner",
);
const visitedNeighbors = [];
gameApi.forEachNeighbor(1, (neighbor) => visitedNeighbors.push(neighbor));
assert.deepEqual(
  visitedNeighbors,
  [2, 3],
  "gameApi should synthesize the core forEachNeighbor contract from client neighbors",
);
const mixedGlobalUnits = gameApi.units("Warship", "Transport");
assert.equal(mixedGlobalUnits.length, 1);
assert.equal(
  gameApi.cachedUnitCount("Warship"),
  null,
  "a mixed-family snapshot does not satisfy a single-type count lookup",
);
assert.equal(globalUnitCalls, 1, "the mixed-family snapshot is materialized once");
const firstGlobalUnits = gameApi.units("Warship");
const secondGlobalUnits = gameApi.units("Warship");
assert.equal(
  firstGlobalUnits[0].targetUnit()?.id(),
  2,
  "UnitView targetUnitId resolves through GameView.unit for live naval reconciliation",
);
assert.strictEqual(
  secondGlobalUnits,
  firstGlobalUnits,
  "gameApi global units should reuse the same snapshot within a game tick",
);
assert.equal(globalUnitCalls, 2, "global units should be read once per family and tick");
assert.equal(
  gameApi.cachedUnitCount("Warship"),
  1,
  "cachedUnitCount reads the exact global family already wrapped this tick",
);
assert.equal(
  gameApi.cachedUnitCount("Transport"),
  null,
  "cachedUnitCount does not substitute another unit family's global snapshot",
);
assert.equal(globalUnitCalls, 2, "cachedUnitCount performs no extra global unit request");
const firstPlayers = gameApi.players();
const secondPlayers = gameApi.players();
assert.strictEqual(
  secondPlayers,
  firstPlayers,
  "gameApi player views should reuse the same snapshot within a game tick",
);
assert.equal(playerListCalls, 1, "players should be read once per game tick");
gameApiTick += 1;
const replacementPlayerCore = {
  ...playerCore,
  troops: () => 999,
};
await wrappedApi.beginTick(replacementPlayerCore);
assert.equal(
  gameApi.cachedUnitCount("Warship"),
  null,
  "cachedUnitCount hides a snapshot as soon as the authoritative tick advances",
);
assert.equal(globalUnitCalls, 2, "the stale-count check does not refresh global units");
const refreshedGlobalUnits = gameApi.units("Warship");
assert.notStrictEqual(
  refreshedGlobalUnits,
  firstGlobalUnits,
  "the global family is materialized again only after the caller requests it",
);
assert.equal(gameApi.cachedUnitCount("Warship"), 1);
assert.equal(globalUnitCalls, 3, "the explicit new-tick request populates one new snapshot");
assert.notStrictEqual(
  gameApi.myPlayer(),
  playerView,
  "a new game tick must replace stale wrapped PlayerView snapshots",
);
assert.equal(
  gameApi.myPlayer().troops(),
  999,
  "the refreshed player wrapper must read the current snapshot state",
);
const receiverSensitiveAttack = {
  _id: "receiver-sensitive-attack",
  _retreating: true,
  _troops: 17,
  id() {
    return this._id;
  },
  retreating() {
    return this._retreating;
  },
  troops() {
    return this._troops;
  },
};
replacementPlayerCore.outgoingAttacks = () => [receiverSensitiveAttack];
const wrappedReceiverSensitiveAttack = gameApi.myPlayer().outgoingAttacks()[0];
assert.equal(
  wrappedReceiverSensitiveAttack.retreating(),
  true,
  "wrapped attacks must preserve the source receiver for retreating()",
);
assert.equal(
  wrappedReceiverSensitiveAttack.troops(),
  17,
  "wrapped attacks must preserve the source receiver for troops()",
);
assert.equal(
  wrappedReceiverSensitiveAttack.id(),
  "receiver-sensitive-attack",
  "wrapped attacks must preserve the source receiver for id()",
);
assert.equal(playerView.sharesBorderWith(playerView), true);
assert.ok(
  borderNeighborCalls > callsAfterFirstBorderCheck,
  "advancing the game tick invalidates cached border relations",
);
assert.notStrictEqual(
  playerView.units("Warship"),
  firstPlayerUnits,
  "a new game tick must invalidate gameApi player snapshots",
);
assert.notStrictEqual(
  gameApi.players(),
  firstPlayers,
  "a new game tick must refresh the player snapshot",
);
assert.equal(playerListCalls, 2, "players should refresh after the game advances");

const HELPERS_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/helpers.js");
let helperTimerCallback = null;
const helperTimerEvents = [];
const helperSandbox = {
  window: {
    setTimeout: (callback, delay) => {
      helperTimerCallback = callback;
      helperTimerEvents.push({ type: "set", delay });
      return 1;
    },
    clearTimeout: (id) => helperTimerEvents.push({ type: "clear", id }),
  },
  globalThis: null,
};
helperSandbox.globalThis = helperSandbox;
executeClassicScript(
  `${fs.readFileSync(HELPERS_SOURCE, "utf8")}\nglobalThis.__helpers = { withTimeout };`,
  helperSandbox,
  { filename: HELPERS_SOURCE },
);
let resolveFastWorker;
const fastWorker = new Promise((resolve) => {
  resolveFastWorker = resolve;
});
const fastResult = helperSandbox.__helpers.withTimeout(fastWorker, 2500, "fallback");
resolveFastWorker("ok");
assert.equal(await fastResult, "ok", "a worker result should win the timeout race");
assert.deepEqual(
  helperTimerEvents,
  [
    { type: "set", delay: 2500 },
    { type: "clear", id: 1 },
  ],
  "a completed worker query must clear its pending timeout",
);
helperTimerEvents.length = 0;
const slowResult = helperSandbox.__helpers.withTimeout(new Promise(() => {}), 750, "fallback");
helperTimerCallback();
assert.equal(await slowResult, "fallback", "a timeout should return its fallback");
assert.deepEqual(
  helperTimerEvents,
  [
    { type: "set", delay: 750 },
    { type: "clear", id: 1 },
  ],
  "a fired timeout should also release its timer handle",
);

const NATION_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/nationExecution.js");
assert.match(
  fs.readFileSync(NATION_SOURCE, "utf8"),
  /lastProcessedGameTick/,
  "NationBot must guard duplicate real-time polls for one game tick",
);

const PROFILE_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/performance.js");
let profileNow = 0;
const profileSandbox = {
  state: {
    settings: { performanceProfiling: false, tickMs: 200 },
    tickIntervalMs: 200,
  },
  performance: {
    now: () => {
      profileNow += 5;
      return profileNow;
    },
  },
  saveSettings: () => {},
  renderStatus: () => {},
  console: { table: () => {} },
  globalThis: null,
};
profileSandbox.globalThis = profileSandbox;
executeClassicScript(
  `${fs.readFileSync(PROFILE_SOURCE, "utf8")}
globalThis.__profile = { beginAutoBotProfileTick, finishAutoBotProfileTick, autoBotProfileStartPhase, autoBotProfileEndPhase, getAutoBotProfileSnapshot };`,
  profileSandbox,
  { filename: PROFILE_SOURCE },
);
assert.equal(
  profileSandbox.__profile.beginAutoBotProfileTick(),
  null,
  "disabled profiling must not create a tick context",
);
assert.equal(profileNow, 0, "disabled profiling must not call performance.now()");
profileSandbox.state.settings.performanceProfiling = true;
const profile = profileSandbox.__profile.beginAutoBotProfileTick();
const phaseStart = profileSandbox.__profile.autoBotProfileStartPhase(profile);
profileSandbox.__profile.autoBotProfileEndPhase(profile, "structures", phaseStart);
profileSandbox.__profile.finishAutoBotProfileTick(profile);
const profileSnapshot = profileSandbox.__profile.getAutoBotProfileSnapshot();
assert.equal(profileSnapshot.sampledTicks, 1, "enabled profiling must record a tick");
assert.equal(profileSnapshot.phases[0].name, "structures");
assert.ok(profileSnapshot.p95TickMs > 0, "profiling must expose a tick percentile");

const RUNTIME_SOURCE = path.join(ROOT, "engine/ingame/runtime.js");
const runtimeSource = fs.readFileSync(RUNTIME_SOURCE, "utf8");
const schedulerStart = runtimeSource.indexOf("const HELPER_TICK_INTERVAL_MS");
const schedulerEnd = runtimeSource.indexOf("// Sync a panel's visibility state", schedulerStart);
assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, "helper scheduler source exists");
let schedulerNow = 0;
let schedulerCallback = null;
const schedulerSandbox = {
  window: {
    setInterval: (callback, delay) => {
      assert.equal(delay, 250, "the scheduler keeps one responsive base timer");
      schedulerCallback = callback;
      return 1;
    },
    clearInterval: () => {},
  },
  performance: { now: () => schedulerNow },
  Date,
  Number,
  Map,
  console,
  globalThis: null,
};
schedulerSandbox.globalThis = schedulerSandbox;
executeClassicScript(
  `${runtimeSource.slice(schedulerStart, schedulerEnd)}\nglobalThis.__scheduler = { registerHelperTickListener, unregisterHelperTickListener };`,
  schedulerSandbox,
  { filename: RUNTIME_SOURCE },
);
let fastTicks = 0;
let slowTicks = 0;
const fastListener = () => {
  fastTicks += 1;
};
const slowListener = () => {
  slowTicks += 1;
};
schedulerSandbox.__scheduler.registerHelperTickListener(fastListener);
schedulerSandbox.__scheduler.registerHelperTickListener(slowListener, 1000);
assert.deepEqual([fastTicks, slowTicks], [1, 1], "listeners run once when registered");
schedulerSandbox.__scheduler.registerHelperTickListener(slowListener, 1000);
assert.equal(slowTicks, 1, "duplicate registration must not repeat initial work");
for (schedulerNow = 250; schedulerNow <= 750; schedulerNow += 250) {
  schedulerCallback();
}
assert.deepEqual([fastTicks, slowTicks], [4, 1], "slow listeners skip unnecessary base ticks");
schedulerNow = 1000;
schedulerCallback();
assert.deepEqual([fastTicks, slowTicks], [5, 2], "slow listeners run when their cadence is due");

const BUILD_TIMER_SOURCE = path.join(ROOT, "engine/ingame/build-timer.js");
assert.match(
  fs.readFileSync(BUILD_TIMER_SOURCE, "utf8"),
  /scanIntervalMs:\s*1000/,
  "build timers should not rescan every structure more than once per second",
);

const ENGINE_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/engine.js");
const intervalEvents = [];
let nextTimerId = 1;
const engineSandbox = {
  state: {
    settings: { enabled: true, tickMs: 200 },
    speed: { factor: 1 },
    tickTimer: null,
    tickIntervalMs: 0,
    tickInFlight: false,
    tickGeneration: 0,
  },
  window: {
    setInterval: (_callback, delay) => {
      const id = nextTimerId++;
      intervalEvents.push({ type: "set", id, delay });
      return id;
    },
    clearInterval: (id) => intervalEvents.push({ type: "clear", id }),
  },
  performance: { now: () => 0 },
  getGame: () => null,
  setStatus: () => {},
  tr: (value) => value,
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  globalThis: null,
};
engineSandbox.globalThis = engineSandbox;
executeClassicScript(
  `${fs.readFileSync(ENGINE_SOURCE, "utf8")}\nglobalThis.__engine = { startEngine, retuneEngine, stopEngine };`,
  engineSandbox,
  { filename: ENGINE_SOURCE },
);

engineSandbox.__engine.startEngine();
assert.deepEqual(
  intervalEvents,
  [{ type: "set", id: 1, delay: 200 }],
  "the configured tick interval is used when the engine starts",
);
engineSandbox.state.settings.tickMs = 250;
engineSandbox.__engine.retuneEngine();
assert.deepEqual(
  intervalEvents,
  [
    { type: "set", id: 1, delay: 200 },
    { type: "clear", id: 1 },
    { type: "set", id: 2, delay: 250 },
  ],
  "a 50 ms setting change must replace the active timer",
);
engineSandbox.__engine.stopEngine();
engineSandbox.state.tickInFlight = true;
engineSandbox.__engine.stopEngine();
assert.equal(
  engineSandbox.state.tickInFlight,
  true,
  "stopping the engine must not release a still-running tick lock",
);

const ROUND_LOGGER_SOURCE = path.join(ROOT, "engine/ingame/round-logger.js");
const roundLoggerListeners = new Set();
const roundLoggerIntervals = [];
const roundLoggerStorage = new Map();
let roundLoggerGameTick = 0;
const roundLoggerSandbox = {
  runtimeState: { roundLoggerEnabled: false },
  window: {
    setInterval: (_callback, delay) => {
      roundLoggerIntervals.push({ type: "set", delay });
      return roundLoggerIntervals.length;
    },
    clearInterval: (id) => roundLoggerIntervals.push({ type: "clear", id }),
  },
  localStorage: {
    setItem: (key, value) => roundLoggerStorage.set(key, value),
    getItem: (key) => roundLoggerStorage.get(key) ?? null,
  },
  getOpenFrontGameContext: () => ({ game: { ticks: () => roundLoggerGameTick } }),
  getCachedPlayerViews: () => [],
  registerHelperTickListener: (listener) => roundLoggerListeners.add(listener),
  unregisterHelperTickListener: (listener) => roundLoggerListeners.delete(listener),
  globalThis: null,
};
roundLoggerSandbox.globalThis = roundLoggerSandbox;
executeClassicScript(
  `${fs.readFileSync(ROUND_LOGGER_SOURCE, "utf8")}\nglobalThis.__roundLogger = { setRoundLoggerEnabled, getRoundLogSnapshot };`,
  roundLoggerSandbox,
  { filename: ROUND_LOGGER_SOURCE },
);
roundLoggerSandbox.__roundLogger.setRoundLoggerEnabled(true);
roundLoggerSandbox.__roundLogger.setRoundLoggerEnabled(true);
assert.equal(
  roundLoggerListeners.size,
  1,
  "re-enabling the round logger must not accumulate helper tick listeners",
);
const roundLoggerListener = [...roundLoggerListeners][0];
roundLoggerGameTick = 100;
roundLoggerListener();
roundLoggerGameTick = 2;
roundLoggerListener();
assert.equal(
  roundLoggerSandbox.__roundLogger.getRoundLogSnapshot(10, 5).history.length,
  1,
  "a game tick reset must archive the prior match and resume logging",
);
roundLoggerSandbox.__roundLogger.setRoundLoggerEnabled(false);
assert.equal(
  roundLoggerListeners.size,
  0,
  "disabling the round logger must unregister its helper tick listener",
);

const heatmapSource = fs.readFileSync(path.join(ROOT, "engine/ingame/heatmaps.js"), "utf8");
const heatmapSandbox = {
  Float32Array,
  Map,
  Math,
  Number,
  Set,
  WeakMap,
  globalThis: null,
};
heatmapSandbox.globalThis = heatmapSandbox;
executeClassicScript(
  `${heatmapSource}
globalThis.__heatmapLifecycle = {
  releaseHeatmapWebGlRenderer,
  seed(canvas, renderer) {
    heatmapWebGlRenderers.set(canvas, renderer);
    heatmapVertexBuffers.set(canvas, new Float32Array(16));
  },
  has(canvas) {
    return heatmapWebGlRenderers.has(canvas) || heatmapVertexBuffers.has(canvas);
  },
};`,
  heatmapSandbox,
  { filename: path.join(ROOT, "engine/ingame/heatmaps.js") },
);
let lostHeatmapContexts = 0;
const heatmapCanvas = {};
heatmapSandbox.__heatmapLifecycle.seed(heatmapCanvas, {
  gl: {
    getExtension(name) {
      assert.equal(name, "WEBGL_lose_context");
      return { loseContext: () => (lostHeatmapContexts += 1) };
    },
  },
});
heatmapSandbox.__heatmapLifecycle.releaseHeatmapWebGlRenderer(heatmapCanvas);
assert.equal(
  lostHeatmapContexts,
  1,
  "removing a heatmap must release its WebGL context instead of risking eviction of the game map",
);
assert.equal(
  heatmapSandbox.__heatmapLifecycle.has(heatmapCanvas),
  false,
  "released heatmap canvases must leave no renderer or vertex-buffer cache entry",
);

const overlaySchedulerSource = fs.readFileSync(
  path.join(ROOT, "engine/ingame/map-overlay-scheduler.js"),
  "utf8",
);
let overlayNow = 1001;
let overlayCameraX = 0;
let nextOverlayHandle = 1;
let removedOverlayCanvases = 0;
let overlayDraws = 0;
let overlayScans = 0;
const overlayAnimationFrames = new Map();
const overlayWakeTimers = new Map();
const overlayContext = {
  setTransform() {},
  clearRect() {},
};
const overlayCanvas = {
  id: "",
  isConnected: false,
  style: {},
  setAttribute() {},
  getContext() {
    return overlayContext;
  },
  remove() {
    this.isConnected = false;
    removedOverlayCanvases += 1;
  },
};
const overlayGame = {};
const overlayTransform = {
  scale: 1,
  worldToScreenCoordinates(point) {
    return { x: point.x + overlayCameraX, y: point.y };
  },
};
const overlaySandbox = {
  document: {
    body: {
      appendChild(canvas) {
        canvas.isConnected = true;
      },
    },
    documentElement: null,
    getElementById() {
      return overlayCanvas.isConnected ? overlayCanvas : null;
    },
    createElement() {
      return overlayCanvas;
    },
  },
  localStorage: { getItem: () => null },
  performance: { now: () => overlayNow },
  window: { innerWidth: 1280, innerHeight: 720 },
  requestAnimationFrame(callback) {
    const handle = nextOverlayHandle++;
    overlayAnimationFrames.set(handle, callback);
    return handle;
  },
  setTimeout(callback, delay) {
    const handle = nextOverlayHandle++;
    overlayWakeTimers.set(handle, { callback, delay });
    return handle;
  },
  clearTimeout(handle) {
    overlayWakeTimers.delete(handle);
  },
  getOpenFrontGameContext: () => ({ game: overlayGame, transform: overlayTransform }),
  globalThis: null,
};
overlaySandbox.globalThis = overlaySandbox;
executeClassicScript(
  `${overlaySchedulerSource}
globalThis.__overlayScheduler = {
  registerMapOverlayLayer,
  markMapOverlayDirty,
  requestMapOverlayLoop,
};`,
  overlaySandbox,
  { filename: path.join(ROOT, "engine/ingame/map-overlay-scheduler.js") },
);

let overlayEnabled = true;
let overlayAnimated = false;
const staticOverlayLayer = {
  id: "observable-static-layer",
  scanIntervalMs: 1000,
  isEnabled: () => overlayEnabled,
  scan() {
    overlayScans += 1;
  },
  draw() {
    overlayDraws += 1;
  },
  animated: () => overlayAnimated,
};
overlaySandbox.__overlayScheduler.registerMapOverlayLayer(staticOverlayLayer);
overlaySandbox.__overlayScheduler.requestMapOverlayLoop();
assert.equal(
  overlayAnimationFrames.size,
  1,
  "an enabled layer must start with one animation frame",
);

const runNextOverlayFrame = () => {
  const [handle, callback] = overlayAnimationFrames.entries().next().value;
  overlayAnimationFrames.delete(handle);
  callback();
};
const runNextOverlayWake = () => {
  const [handle, timer] = overlayWakeTimers.entries().next().value;
  overlayWakeTimers.delete(handle);
  timer.callback();
};

runNextOverlayFrame();
assert.equal(overlayDraws, 1, "the first frame must draw the enabled layer");
assert.equal(overlayScans, 1, "the first frame must perform the layer scan");
assert.equal(
  overlayAnimationFrames.size,
  0,
  "a clean static layer must stop requesting animation frames",
);
assert.equal(
  overlayWakeTimers.size,
  1,
  "a clean static layer must retain a camera/update wake timer",
);

overlayNow = 1251;
overlayCameraX = 17;
runNextOverlayWake();
assert.equal(overlayAnimationFrames.size, 1, "a camera poll must wake one render frame");
runNextOverlayFrame();
assert.equal(overlayDraws, 2, "a camera change must redraw the static layer");
assert.equal(overlayAnimationFrames.size, 0, "the layer must sleep again after the camera redraw");
assert.equal(overlayWakeTimers.size, 1, "camera redraw must preserve future update detection");

overlayNow = 2251;
runNextOverlayWake();
runNextOverlayFrame();
assert.equal(overlayScans, 2, "a sleeping layer must still receive its throttled data update");
assert.equal(overlayDraws, 3, "a throttled data update must redraw the layer");

overlayNow = 2300;
overlaySandbox.__overlayScheduler.markMapOverlayDirty();
assert.equal(overlayWakeTimers.size, 0, "an update must cancel the sleeping wake timer");
assert.equal(overlayAnimationFrames.size, 1, "an update must wake the scheduler immediately");
runNextOverlayFrame();
assert.equal(overlayDraws, 4, "an update must redraw without waiting for the poll");

overlayAnimated = true;
runNextOverlayWake();
runNextOverlayFrame();
assert.equal(
  overlayAnimationFrames.size,
  1,
  "an animated layer must keep the animation frame loop active",
);
overlayAnimated = false;
runNextOverlayFrame();
assert.equal(
  overlayAnimationFrames.size,
  0,
  "an animation becoming idle must allow the loop to sleep",
);
assert.equal(
  overlayWakeTimers.size,
  1,
  "an idle animation must restore the camera/update wake timer",
);

overlayEnabled = false;
overlaySandbox.__overlayScheduler.requestMapOverlayLoop();
assert.equal(overlayWakeTimers.size, 0, "disabling the last layer must cancel its wake timer");
assert.equal(
  removedOverlayCanvases,
  1,
  "disabling the last layer must tear down the canvas while asleep",
);
overlayEnabled = true;
overlaySandbox.__overlayScheduler.requestMapOverlayLoop();
assert.equal(overlayAnimationFrames.size, 1, "re-enabling a layer must restart the scheduler");
runNextOverlayFrame();
assert.equal(overlayDraws, 6, "a restarted layer must draw again");

// Bot positions update on simulation ticks while camera projection stays live.
const markerSandbox = { window: { innerWidth: 1000, innerHeight: 800 } };
executeClassicScript(
  fs.readFileSync(path.join(ROOT, "engine/ingame/bot-markers.js"), "utf8"),
  markerSandbox,
);
let locationReads = 0;
let markerLocation = { x: 20, y: 30 };
let cameraOffset = 0;
const markerScan = {
  player: {
    nameLocation() {
      locationReads += 1;
      return markerLocation;
    },
  },
  locationTick: NaN,
};
const markerContext = {
  transform: {
    worldToScreenCoordinates: (location) => ({
      x: location.x + cameraOffset,
      y: location.y,
    }),
  },
};
for (let frame = 0; frame < 60; frame += 1) {
  markerSandbox.botMarkerScreenPosition(markerContext, markerScan, 1);
}
assert.equal(locationReads, 1, "stationary tick reads each bot location only once");
cameraOffset = 100;
assert.equal(
  markerSandbox.botMarkerScreenPosition(markerContext, markerScan, 1).x,
  120,
  "panning must project cached locations on every frame",
);
markerLocation = { x: 50, y: 60 };
assert.equal(markerSandbox.botMarkerScreenPosition(markerContext, markerScan, 2).x, 150);
assert.equal(locationReads, 2, "the next tick refreshes the location");
markerLocation = undefined;
assert.equal(markerSandbox.botMarkerScreenPosition(markerContext, markerScan, 3), null);
markerLocation = { x: 70, y: 80 };
assert.equal(markerSandbox.botMarkerScreenPosition(markerContext, markerScan, 4).x, 170);
markerSandbox.botMarkerScreenPosition(markerContext, markerScan, NaN);
markerSandbox.botMarkerScreenPosition(markerContext, markerScan, NaN);
assert.equal(locationReads, 6, "missing ticks must read live locations each frame");

let markerGame = { ticks: () => 1 };
let markerScans = 0;
Object.assign(markerSandbox, {
  runtimeState: { botMarkersEnabled: true },
  performance: { now: () => 0 },
  getOpenFrontGameContext: () => ({ game: markerGame }),
  ensureBotMarkerContainer: () => ({}),
  getCachedPlayerViews: () => {
    markerScans += 1;
    return [];
  },
  requestAnimationFrame: () => 1,
});
markerSandbox.syncBotMarkers();
markerSandbox.syncBotMarkers();
assert.equal(markerScans, 1, "initial render scans immediately and reuses the roster");
markerGame = { ticks: () => 1 };
markerSandbox.syncBotMarkers();
assert.equal(markerScans, 2, "switching games refreshes the roster even at the same tick");

process.stdout.write("performance regression tests passed\n");
