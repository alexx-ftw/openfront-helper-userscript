import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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
vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });

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
  withTimeout: (promise) => Promise.resolve(promise),
  globalThis: null,
};
gameApiSandbox.globalThis = gameApiSandbox;
vm.runInNewContext(
  `${fs.readFileSync(GAME_API_SOURCE, "utf8")}\nglobalThis.__createGameApi = createGameApi;`,
  gameApiSandbox,
  { filename: GAME_API_SOURCE },
);

let gameApiTick = 1;
let playerUnitCalls = 0;
let globalUnitCalls = 0;
let playerListCalls = 0;
const rawUnit = {
  type: () => "Warship",
  owner: () => playerCore,
};
const playerCore = {
  isPlayer: () => true,
  smallID: () => 7,
  id: () => "player-7",
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
  neighbors: () => [],
  isWater: () => false,
  isLand: () => true,
  isShore: () => false,
  isOcean: () => false,
  isOceanShore: () => false,
  ownerID: () => 7,
  hasOwner: () => true,
  playerBySmallID: () => playerCore,
};
const wrappedApi = gameApiSandbox.__createGameApi(gameApiSource);
const gameApi = wrappedApi.game;
const playerView = gameApi._wrapPlayer(playerCore);
const firstPlayerUnits = playerView.units("Warship");
const secondPlayerUnits = playerView.units("Warship");
assert.strictEqual(
  secondPlayerUnits,
  firstPlayerUnits,
  "gameApi player units should reuse the same snapshot within a game tick",
);
assert.equal(playerUnitCalls, 1, "player units should be read once per family and tick");
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

const NATION_SOURCE = path.join(ROOT, "engine/ingame/auto-bot/nationExecution.js");
assert.match(
  fs.readFileSync(NATION_SOURCE, "utf8"),
  /lastProcessedGameTick/,
  "NationBot must guard duplicate real-time polls for one game tick",
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
vm.runInNewContext(
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

console.log("performance regression tests passed");
