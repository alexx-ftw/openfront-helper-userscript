import assert from "node:assert/strict";
import { executeClassicScript } from "../classic-script.mjs";
import { readLegendaryPlannerSource } from "../legendary-planner-source.mjs";
import { enginePath, readEngineSource } from "./context.mjs";

export function setupGameApi() {
  const gameApiPath = enginePath("engine/ingame/auto-bot/gameApi.js");
  const gameApiSandbox = {
    PlayerType: { Bot: "BOT" },
    UNIT: {},
    WORKER_TIMEOUT_MS: 4000,
    withTimeout: (promise) => Promise.resolve(promise),
    globalThis: null,
  };
  gameApiSandbox.globalThis = gameApiSandbox;
  const horizonPlannerSandbox = {};
  executeClassicScript(readLegendaryPlannerSource(), horizonPlannerSandbox, {
    filename: "legendaryPlanner.js",
  });
  executeClassicScript(
    `${readEngineSource("engine/ingame/auto-bot/gameApi.js")}\nglobalThis.__createGameApi = createGameApi;`,
    gameApiSandbox,
    { filename: gameApiPath },
  );

  const state = {
    tick: 50,
    playerUnitCalls: 0,
    globalUnitCalls: 0,
    playerListCalls: 0,
    borderNeighborCalls: 0,
    oceanShoreCalls: 0,
  };
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
      state.playerUnitCalls += 1;
      return [rawUnit];
    },
  };
  const gameApiSource = {
    ticks: () => state.tick,
    ticksSinceStart: () => state.tick - 40,
    players: () => {
      state.playerListCalls += 1;
      return [playerCore];
    },
    units: () => {
      state.globalUnitCalls += 1;
      return [rawUnit];
    },
    unit: (id) => (id === 2 ? rawTargetUnit : undefined),
    width: () => 1,
    height: () => 1,
    neighbors: () => {
      state.borderNeighborCalls += 1;
      return [2, 3];
    },
    isWater: () => false,
    isLand: () => true,
    isShore: () => false,
    isOcean: () => false,
    isOceanShore: (tile) => {
      state.oceanShoreCalls += 1;
      return tile === 1;
    },
    ownerID: () => 7,
    hasOwner: () => true,
    playerBySmallID: () => playerCore,
  };
  const wrappedApi = gameApiSandbox.__createGameApi(gameApiSource);
  const gameApi = wrappedApi.game;
  assert.equal(gameApi.ticksSinceStart(), 10);
  assert.equal(
    horizonPlannerSandbox.legendaryStructureHorizonTicks(
      {
        config: () => ({
          msPerTick: () => 100,
          gameConfig: () => ({ maxTimerValue: 1 }),
        }),
        ticksSinceStart: () => gameApi.ticksSinceStart(),
      },
      gameApi.ticks(),
    ),
    590,
    "the live economy horizon uses the wrapper's spawn-adjusted elapsed ticks",
  );
  const playerView = gameApi._wrapPlayer(playerCore);
  return { state, playerCore, gameApiSource, wrappedApi, gameApi, playerView };
}
