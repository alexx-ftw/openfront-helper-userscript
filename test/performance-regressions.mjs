import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/shared-utils.js");

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
  type: () => "Warship",
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
const firstGlobalUnits = gameApi.units("Warship");
const secondGlobalUnits = gameApi.units("Warship");
assert.strictEqual(
  secondGlobalUnits,
  firstGlobalUnits,
  "gameApi global units should reuse the same snapshot within a game tick",
);
assert.equal(globalUnitCalls, 1, "global units should be read once per family and tick");
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

process.stdout.write("performance regression tests passed\n");
