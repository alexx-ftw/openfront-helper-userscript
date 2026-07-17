import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  Difficulty,
  HumansVsNations,
  PlayerType,
} from "../../openfront-engine/src/core/game/Game.ts";
import { createGameRunner } from "../../openfront-engine/src/core/GameRunner.ts";
import type { StampedIntent, Turn } from "../../openfront-engine/src/core/Schemas.ts";
import { MapPlaylist } from "../../openfront-engine/src/server/MapPlaylist.ts";
import { NodeGameMapLoader } from "../../openfront-engine/tests/perf/fullgame/NodeGameMapLoader.ts";
import { createMaxDifficultyOpponent } from "./opponent-adapter.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(root, "../../openfront-engine");
const seed = process.env.OFH_MATCH_SEED ?? `ofh-random-team-${Date.now()}`;
const clientID = "ofh-auto-bot";
const playlist = new MapPlaylist();
let playlistConfig = await playlist.gameConfig("team");
while (playlistConfig.playerTeams === HumansVsNations) {
  playlistConfig = await playlist.gameConfig("team");
}
const requestedTeams = process.env.OFH_PLAYER_TEAMS;
const numericTeams = Number(requestedTeams);
const fixedConfig = process.env.OFH_GAME_MAP
  ? {
      gameMap: process.env.OFH_GAME_MAP,
      gameMapSize: process.env.OFH_GAME_MAP_SIZE ?? playlistConfig.gameMapSize,
      gameMode: "Team",
      playerTeams:
        requestedTeams === undefined
          ? playlistConfig.playerTeams
          : Number.isFinite(numericTeams)
            ? numericTeams
            : requestedTeams,
      bots: Number(process.env.OFH_BOTS ?? playlistConfig.bots),
    }
  : {};
const config = {
  ...playlistConfig,
  ...fixedConfig,
  ...(process.env.OFH_FIXED_WARSHIP === "1"
    ? {
        gameMap: "Warship Warship",
        gameMapSize: "Normal",
        gameMode: "Team",
        playerTeams: 4,
        bots: 400,
      }
    : {}),
  difficulty: Difficulty.Easy,
  nations: "default" as const,
};
const gameStart = {
  gameID: seed,
  lobbyCreatedAt: 0,
  config,
  players: [{ clientID, username: "OFH Auto Bot", clanTag: null }],
};

let fatalError: string | null = null;
const runner = await createGameRunner(
  gameStart,
  undefined,
  new NodeGameMapLoader(path.join(engineRoot, "resources/maps")),
  (update) => {
    if ("errMsg" in update) fatalError = `${update.errMsg}\n${update.stack ?? ""}`;
  },
);
const bot = createMaxDifficultyOpponent({ clientID, name: "OFH Auto Bot" });
bot.attach({ runner, clientID, gameID: seed });

const initialPlayers = runner.game
  .allPlayers()
  .filter((player) => player.type() !== PlayerType.Bot);
const nations = initialPlayers.filter((player) => player.type() === PlayerType.Nation);
const me = runner.game.playerByClientID(clientID);

console.warn(
  JSON.stringify({
    phase: "start",
    seed,
    map: config.gameMap,
    mapSize: config.gameMapSize,
    mode: config.gameMode,
    teams: config.playerTeams,
    difficulty: config.difficulty,
    nations: nations.length,
    tribes: config.bots,
    myTeam: me?.team() ?? null,
  }),
);

const startedAt = performance.now();
const maxTicks = Number(process.env.OFH_MAX_TICKS ?? 103_000);
let turnNumber = 0;
let emittedIntents = 0;
while (runner.game.getWinner() === null && runner.game.ticks() < maxTicks && fatalError === null) {
  const intents = await bot.decide();
  emittedIntents += intents.length;
  const turn: Turn = {
    turnNumber: turnNumber++,
    intents: intents.map((intent): StampedIntent => ({ ...intent, clientID })),
  };
  runner.addTurn(turn);
  if (!runner.executeNextTick()) break;
  if (runner.game.ticks() % 500 === 0) {
    const player = runner.game.playerByClientID(clientID);
    console.warn(
      JSON.stringify({
        phase: "progress",
        tick: runner.game.ticks(),
        alive: player?.isAlive() ?? false,
        tiles: player?.numTilesOwned() ?? 0,
        troops: player?.troops() ?? 0,
        gold: Number(player?.gold() ?? 0n),
        incomingAttacks: player?.incomingAttacks().length ?? 0,
        outgoingAttacks: player?.outgoingAttacks().length ?? 0,
        team: player?.team() ?? null,
        intents: emittedIntents,
        elapsedMs: Math.round(performance.now() - startedAt),
      }),
    );
  }
}

if (fatalError !== null) throw new Error(fatalError);
const winner = runner.game.getWinner();
const finalMe = runner.game.playerByClientID(clientID);
const won =
  winner !== null &&
  (winner === finalMe?.team() || (typeof winner !== "string" && winner.clientID() === clientID));
const players = runner.game
  .allPlayers()
  .filter((player) => player.type() !== PlayerType.Bot)
  .map((player) => ({
    name: player.name(),
    type: player.type(),
    team: player.team(),
    alive: player.isAlive(),
    tiles: player.numTilesOwned(),
  }))
  .sort((left, right) => right.tiles - left.tiles);

console.warn(
  JSON.stringify({
    phase: "result",
    won,
    winner: typeof winner === "string" ? winner : (winner?.name() ?? null),
    myTeam: finalMe?.team() ?? null,
    alive: finalMe?.isAlive() ?? false,
    ticks: runner.game.ticks(),
    emittedIntents,
    runtimeMs: Math.round(performance.now() - startedAt),
    topPlayers: players.slice(0, 10),
  }),
);

process.exitCode = won ? 0 : 2;
