import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const helpersSource = read("engine/ingame/auto-bot/helpers.js");
const engineSource = read("engine/ingame/auto-bot/engine.js");
const lifecycleSource = read("engine/ingame/auto-bot/lifecycle.js").split(
  "\n  scheduleAutoBotLifecycle();",
)[0];

let currentGame = null;
let clearIntervalCalls = 0;
let persistedWrites = 0;

const sandbox = {
  console,
  performance: { now: () => 0 },
  window: {
    setInterval: () => 1,
    clearInterval: () => {
      clearIntervalCalls += 1;
    },
  },
  document: { body: {}, addEventListener() {}, removeEventListener() {} },
  state: {
    settings: { enabled: true },
    status: "",
    tickInFlight: false,
    tickStartedAt: 0,
    runtimePausedAfterSlowTick: false,
    tickTimer: null,
    tickIntervalMs: 200,
    speed: { factor: 1 },
  },
  getGame: () => currentGame,
  setStatus: () => {},
  tr: (value) => value,
  refreshGateBanner: () => {},
  refreshLiveUiFromGame: () => {},
  renderStatus: () => {},
  buildPanel: () => {},
  retuneEngine: () => {},
  setEnabled: () => {
    persistedWrites += 1;
  },
};

executeClassicScript(helpersSource, sandbox, { filename: "auto-bot-helpers.js" });
executeClassicScript(engineSource, sandbox, { filename: "auto-bot-engine.js" });
executeClassicScript(lifecycleSource, sandbox, { filename: "auto-bot-lifecycle.js" });

function runtimeGame(gameType, gameMode) {
  const player = { isPlayer: () => true };
  return {
    config: () => ({ gameConfig: () => ({ gameType, gameMode }) }),
    myPlayer: () => player,
    inSpawnPhase: () => false,
  };
}

function resetRuntime(gameType, gameMode) {
  currentGame = runtimeGame(gameType, gameMode);
  clearIntervalCalls = 0;
  persistedWrites = 0;
  sandbox.state.settings.enabled = true;
  sandbox.state.status = "";
  sandbox.state.tickInFlight = false;
  sandbox.state.runtimePausedAfterSlowTick = false;
  sandbox.state.tickTimer = 99;
  sandbox.state.tickIntervalMs = 200;
}

for (const gameMode of ["Free For All", "Team"]) {
  resetRuntime("Public", gameMode);
  const context = sandbox.botTickGameContext();
  assert.ok(context, `Public ${gameMode} bot tick reaches the player context`);
  assert.equal(context.srcGame, currentGame, `Public ${gameMode} keeps the runtime game`);
  sandbox.watcher();
  assert.equal(clearIntervalCalls, 0, `Public ${gameMode} watcher keeps the engine running`);
  assert.equal(sandbox.state.tickTimer, 99, `Public ${gameMode} timer remains active`);
  assert.equal(persistedWrites, 0, "public execution does not alter the enabled preference");
}

for (const gameMode of ["Free For All", "Team"]) {
  resetRuntime("Private", gameMode);
  sandbox.state.tickTimer = null;
  const context = sandbox.botTickGameContext();
  assert.ok(context, `Private ${gameMode} bot tick reaches the player context`);
  assert.equal(context.srcGame, currentGame, `Private ${gameMode} keeps the runtime game`);
  assert.equal(
    context.meCore,
    currentGame.myPlayer(),
    `Private ${gameMode} keeps the runtime player`,
  );
}

process.stdout.write("auto-bot lobby scope tests passed\n");
