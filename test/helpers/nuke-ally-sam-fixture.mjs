// Shared sandbox for nuke ally/postgame SAM classification tests.

import {
  executeClassicScript,
  readRepositoryFile,
} from "./repository-fixture.mjs";
import { readNukeBehaviorSource } from "./nuke-behavior-source.mjs";

const UNIT = {
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};

export function createNukeAllySamFixture() {
  const activeAlly = {
    smallID: () => 2,
    team: () => null,
    isFriendly: (other) => other?.smallID?.() === 1,
  };
  const player = {
    smallID: () => 1,
    team: () => "blue",
    isFriendly: (other) => other?.smallID?.() === 2,
    allies: () => [activeAlly],
    isAlliedWith: (other) => other === activeAlly,
  };
  const permanentTeammate = { smallID: () => 3, team: () => "blue" };
  const enemy = { smallID: () => 4, team: () => null };
  const sandbox = {
    UNIT,
    Difficulty,
    PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
    GameMode: { FFA: "FFA", Team: "Team" },
    state: { settings: { winFixes: true }, stats: {} },
    currentDifficulty: () => Difficulty.Legendary,
    isAtLeastHardDifficulty: (difficulty) =>
      difficulty === Difficulty.Hard ||
      difficulty === Difficulty.Impossible ||
      difficulty === Difficulty.Legendary,
    isLegendaryDifficulty: (difficulty) => difficulty === Difficulty.Legendary,
    withTimeout: async (promise) => promise,
    WORKER_TIMEOUT_MS: 100,
    randTerritoryTileArray: () => [],
    performance: { now: () => 0 },
    discoverCtors: () => ({}),
    getEventBus: () => ({}),
    emitIntent: () => true,
    setLastAction: () => {},
    runtimeDebugLog: () => {},
    tr: (value) => value,
    safeName: () => "x",
    within: (value, min, max) => Math.min(max, Math.max(min, value)),
    playersArePermanentTeammates: (first, second) =>
      Boolean(first?.team?.() && first.team() === second?.team?.()),
  };
  executeClassicScript(
    `${readNukeBehaviorSource()}\nglobalThis.__NukeBehavior = NukeBehavior;`,
    sandbox,
    { filename: "engine/ingame/auto-bot/nuke-behavior (split)" },
  );

  const makeSam = (owner, id) => ({
    unit: { id: () => id, owner: () => owner, level: () => 1 },
    distSquared: 1,
  });
  const nearbySams = [
    makeSam(player, "own"),
    makeSam(activeAlly, "active-ally"),
    makeSam(permanentTeammate, "teammate"),
    makeSam(enemy, "enemy"),
  ];

  const adapterSandbox = {};
  executeClassicScript(
    `${readRepositoryFile("engine/ingame/auto-bot/gameApi.js")}\nglobalThis.__createGameApi = createGameApi;`,
    adapterSandbox,
    { filename: "nuke-ally-sam-game-api.vm.js" },
  );

  const winner = { smallID: () => 9 };
  let clientUpdates = { Win: [{ type: "Win", winner: undefined, allPlayersStats: {} }] };
  const adaptedClientGame = adapterSandbox.__createGameApi({
    updatesSinceLastTick: () => clientUpdates,
  }).game;
  const nativeWinnerGame = adapterSandbox.__createGameApi({
    getWinner: () => winner,
  }).game;
  const nativeCancelledGame = adapterSandbox.__createGameApi({
    getWinner: () => null,
    updatesSinceLastTick: () => ({ Win: [{ type: "Win", winner }] }),
  }).game;
  const fallbackGame = adapterSandbox.__createGameApi({}).game;
  // GameView keeps _gameOver true after a real win whose update batch the bot
  // never observed; hasWinner must recover through the gameOver fallback.
  let missedWinnerGameOver = false;
  const missedWinnerGame = adapterSandbox.__createGameApi({
    updatesSinceLastTick: () => ({}),
    gameOver: () => missedWinnerGameOver,
  }).game;
  // A winnerless WinUpdate (allPlayersStats present, winner undefined) is a
  // cancelled game and must stay false even once GameView reports gameOver.
  let cancellationUpdates = {
    Win: [{ type: "Win", winner: undefined, allPlayersStats: {} }],
  };
  const cancellationGame = adapterSandbox.__createGameApi({
    updatesSinceLastTick: () => cancellationUpdates,
    gameOver: () => true,
  }).game;

  let gameType = "Public";
  const behavior = Object.create(sandbox.__NukeBehavior.prototype);
  behavior.player = player;
  behavior.game = {
    hasWinner: () =>
      typeof adaptedClientGame.hasWinner === "function" ? adaptedClientGame.hasWinner() : null,
    // GameView also marks winnerless cancellation updates as game over.
    gameOver: () => true,
    config: () => ({
      maxSamRange: () => 10,
      samRange: () => 5,
      gameConfig: () => ({ gameType }),
    }),
    nearbyUnits: () => nearbySams,
  };
  behavior.coveringSamsForSamFreeTarget = () => [];
  behavior.routeOnlyInterceptingSams = () => [];

  const coveringBehavior = Object.create(sandbox.__NukeBehavior.prototype);
  coveringBehavior.player = player;
  coveringBehavior.game = behavior.game;
  coveringBehavior.coveringSamsForSamFreeTarget = () => [makeSam(enemy, "enemy-covering").unit];

  const directAllySam = {
    id: () => "direct-active-ally",
    owner: () => activeAlly,
    isAlive: () => true,
  };
  const directTarget = { units: () => [directAllySam] };

  return {
    player,
    activeAlly,
    permanentTeammate,
    enemy,
    winner,
    makeSam,
    nearbySams,
    directAllySam,
    directTarget,
    behavior,
    coveringBehavior,
    adaptedClientGame,
    nativeWinnerGame,
    nativeCancelledGame,
    fallbackGame,
    missedWinnerGame,
    cancellationGame,
    setClientUpdates: (value) => {
      clientUpdates = value;
    },
    setCancellationUpdates: (value) => {
      cancellationUpdates = value;
    },
    setMissedWinnerGameOver: (value) => {
      missedWinnerGameOver = value;
    },
    setGameType: (value) => {
      gameType = value;
    },
  };
}
