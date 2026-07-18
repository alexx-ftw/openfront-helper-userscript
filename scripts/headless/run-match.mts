import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  Difficulty,
  HumansVsNations,
  PlayerType,
  UnitType,
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
const traceFile = process.env.OFH_TRACE_FILE;
if (traceFile) {
  writeFileSync(traceFile, "");
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    appendFileSync(traceFile, `${args.map(String).join(" ")}\n`);
  };
}
const playlist = new MapPlaylist();
let playlistConfig = await playlist.gameConfig("team");
// A Team match with one team fails inside GameImpl before tick zero. Keep the
// random/default playlist semantics, but redraw incompatible entries so every
// default simulation actually reaches the bot instead of consuming a run.
while (
  playlistConfig.playerTeams === HumansVsNations ||
  !Number.isFinite(Number(playlistConfig.playerTeams)) ||
  Number(playlistConfig.playerTeams) < 2
) {
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
  difficulty: Difficulty.Impossible,
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
const profileBot = process.env.OFH_PROFILE_BOT === "1";
const bot = createMaxDifficultyOpponent({
  clientID,
  name: "OFH Auto Bot",
  performanceProfiling: profileBot,
});
bot.attach({ runner, clientID, gameID: seed });

const initialPlayers = runner.game
  .allPlayers()
  .filter((player) => player.type() !== PlayerType.Bot);
const nations = initialPlayers.filter((player) => player.type() === PlayerType.Nation);
const me = runner.game.playerByClientID(clientID);
const originalConquerPlayer = runner.game.conquerPlayer.bind(runner.game);
runner.game.conquerPlayer = (conqueror, conquered) => {
  if (conquered.clientID() === clientID) {
    console.warn(
      JSON.stringify({
        phase: "conquered",
        tick: runner.game.ticks(),
        conqueror: conqueror.name(),
        conquerorType: conqueror.type(),
        conquered: conquered.name(),
        tiles: conquered.numTilesOwned(),
        troops: conquered.troops(),
        stack: new Error("conquerPlayer trace").stack,
      }),
    );
  }
  originalConquerPlayer(conqueror, conquered);
};

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
const progressEveryTicks = Math.max(1, Number(process.env.OFH_PROGRESS_TICKS ?? 500));
const progressFromTick = Math.max(0, Number(process.env.OFH_PROGRESS_FROM_TICK ?? 0));
const slowTickThresholdMs = Math.max(1, Number(process.env.OFH_SLOW_TICK_MS ?? 250));
const stopWhenBotDies = process.env.OFH_STOP_WHEN_DEAD !== "0";
const logIntents = process.env.OFH_LOG_INTENTS === "1";
const logNaval = process.env.OFH_LOG_NAVAL === "1";
const logStructures = process.env.OFH_LOG_STRUCTURES === "1";
// Persisted traces must always retain the lightweight SAM lifecycle. Full
// structure diagnostics remain opt-in because they are much noisier.
const logSamLifecycle = logStructures || traceFile !== undefined;
let turnNumber = 0;
let emittedIntents = 0;
let hasEverBeenAlive = me?.isAlive() === true;
let stopReason: "winner" | "max_ticks" | "bot_dead" | "engine_stop" = "max_ticks";
const cumulativeIntentTypes = new Map<string, number>();
let intervalIntentTypes = new Map<string, number>();
const cumulativeBuildUnitTypes = new Map<string, number>();
let intervalBuildUnitTypes = new Map<string, number>();
let intervalBuildEvents: Array<{ tick: number; unit: string; tile: number | null }> = [];
let cumulativeTerraNulliusAttacks = 0;
let intervalTerraNulliusAttacks = 0;
const observedSamLevels = new Map<string, number>();
// The engine can remove a just-issued attack from outgoingAttacks before the
// next bot decision, while the bot still correctly treats it as committed when
// it emits a small top-up. Retain that short handoff in telemetry only.
const RECENT_ATTACK_INTENT_COMMITMENT_TICKS = 10;
const recentAttackIntentCommitments = new Map<string, { tick: number; troops: number }>();
const trackedUnitTypes = [
  UnitType.City,
  UnitType.Factory,
  UnitType.Port,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.Warship,
  UnitType.TransportShip,
] as const;
const trackedMissileTypes = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
] as const;
const PREEMPTIVE_SAM_SILO_GOLD = 1_000_000n;
const countIntents = (
  intents: readonly { type: string; unit?: unknown; tile?: unknown }[],
  tick: number,
) => {
  for (const intent of intents) {
    cumulativeIntentTypes.set(intent.type, (cumulativeIntentTypes.get(intent.type) ?? 0) + 1);
    intervalIntentTypes.set(intent.type, (intervalIntentTypes.get(intent.type) ?? 0) + 1);
    if (intent.type !== "build_unit" || typeof intent.unit !== "string") continue;
    cumulativeBuildUnitTypes.set(intent.unit, (cumulativeBuildUnitTypes.get(intent.unit) ?? 0) + 1);
    intervalBuildUnitTypes.set(intent.unit, (intervalBuildUnitTypes.get(intent.unit) ?? 0) + 1);
    const tile = Number(intent.tile);
    intervalBuildEvents.push({
      tick,
      unit: intent.unit,
      tile: Number.isFinite(tile) ? tile : null,
    });
  }
};
const sortedCounts = (counts: ReadonlyMap<string, number>) =>
  Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
while (runner.game.getWinner() === null && runner.game.ticks() < maxTicks && fatalError === null) {
  const decisionStartedAt = performance.now();
  const intents = await bot.decide();
  if (logNaval) {
    for (const entry of bot.drainNavalTrace()) {
      console.warn(JSON.stringify({ ...entry, phase: "naval-trace", event: entry.phase }));
    }
  }
  if (logStructures) {
    for (const entry of bot.drainStructureTrace()) {
      console.warn(JSON.stringify({ ...entry, phase: "structure-trace" }));
    }
  }
  const decisionMs = performance.now() - decisionStartedAt;
  emittedIntents += intents.length;
  countIntents(intents, runner.game.ticks());
  const terraNulliusAttacks = intents.filter(
    (intent) => intent.type === "attack" && intent.targetID === null,
  ).length;
  cumulativeTerraNulliusAttacks += terraNulliusAttacks;
  intervalTerraNulliusAttacks += terraNulliusAttacks;
  if (logIntents && intents.length > 0) {
    const decisionPlayer = runner.game.playerByClientID(clientID);
    const decisionTick = runner.game.ticks();
    for (const [targetID, commitment] of recentAttackIntentCommitments) {
      if (decisionTick - commitment.tick > RECENT_ATTACK_INTENT_COMMITMENT_TICKS) {
        recentAttackIntentCommitments.delete(targetID);
      }
    }
    const attackTargets = intents
      .filter((intent) => intent.type === "attack")
      .map((intent) => {
        const snapshot = intent.attackTargetSnapshot;
        const target =
          intent.targetID === null
            ? null
            : runner.game.players().find((player) => player.id() === intent.targetID);
        const liveCommittedTroops =
          target === null || target === undefined || decisionPlayer === undefined
            ? 0
            : decisionPlayer
                .outgoingAttacks()
                .filter((attack) => attack.target()?.id() === target.id())
                .reduce((total, attack) => total + attack.troops(), 0);
        // The adapter snapshot is captured when the intent is emitted, while
        // the runner observes the same game immediately after the full decision.
        // A boat can become a live attack during that gap; retain whichever
        // authoritative view has observed more existing commitment, rather than
        // reporting a partial conquest as underfunded. The engine may also
        // briefly hide a newly-issued attack before it is visible in either
        // snapshot, so bridge the bot's immediately preceding intent briefly.
        const recentCommittedTroops =
          intent.targetID === null
            ? 0
            : recentAttackIntentCommitments.get(String(intent.targetID))?.troops || 0;
        const pendingTroops = Math.max(
          Number(snapshot?.pendingTroops) || 0,
          liveCommittedTroops,
          recentCommittedTroops,
        );
        const committedTroops = pendingTroops + intent.troops;
        if (intent.targetID !== null) {
          recentAttackIntentCommitments.set(String(intent.targetID), {
            tick: decisionTick,
            troops: committedTroops,
          });
        }
        return {
          targetID: intent.targetID,
          targetName: snapshot?.name ?? target?.name() ?? "Terra Nullius",
          targetType: snapshot?.type ?? target?.type() ?? "Terra Nullius",
          targetTroops: Math.round(snapshot?.troops ?? target?.troops() ?? 0),
          pendingTroops: Math.round(pendingTroops),
          recentCommittedTroops: Math.round(recentCommittedTroops),
          committedTroops: Math.round(committedTroops),
          robustCaptureFloor:
            (snapshot?.type ?? target?.type()) === "BOT"
              ? Math.ceil((snapshot?.troops ?? target?.troops() ?? 0) * 1.6)
              : null,
        };
      });
    console.warn(
      JSON.stringify({
        phase: "decision",
        tick: runner.game.ticks(),
        tiles: decisionPlayer?.numTilesOwned() ?? 0,
        troops: decisionPlayer?.troops() ?? 0,
        gold: Number(decisionPlayer?.gold() ?? 0n),
        incoming:
          decisionPlayer?.incomingAttacks().map((attack) => ({
            attacker: attack.attacker().name(),
            attackerType: attack.attacker().type(),
            troops: Math.round(attack.troops()),
          })) ?? [],
        attackTargets,
        intents,
      }),
    );
  }
  const turn: Turn = {
    turnNumber: turnNumber++,
    intents: intents.map((intent): StampedIntent => ({ ...intent, clientID })),
  };
  runner.addTurn(turn);
  const executionStartedAt = performance.now();
  if (!runner.executeNextTick()) {
    stopReason = "engine_stop";
    break;
  }
  const executionMs = performance.now() - executionStartedAt;
  const currentPlayer = runner.game.playerByClientID(clientID);
  if (logSamLifecycle) {
    const currentSamLevels = new Map(
      (currentPlayer?.units(UnitType.SAMLauncher) ?? []).map((sam) => [
        String(sam.id()),
        Number(sam.level()),
      ]),
    );
    for (const [samID, level] of currentSamLevels) {
      const priorLevel = observedSamLevels.get(samID);
      if (priorLevel === undefined || priorLevel !== level) {
        console.warn(
          JSON.stringify({
            phase: "sam-lifecycle",
            event: priorLevel === undefined ? "observed" : "level-changed",
            tick: runner.game.ticks(),
            samID,
            previousLevel: priorLevel ?? null,
            level,
          }),
        );
      }
    }
    for (const [samID, level] of observedSamLevels) {
      if (currentSamLevels.has(samID)) continue;
      console.warn(
        JSON.stringify({
          phase: "sam-lifecycle",
          event: "removed",
          tick: runner.game.ticks(),
          samID,
          previousLevel: level,
        }),
      );
    }
    observedSamLevels.clear();
    for (const [samID, level] of currentSamLevels) observedSamLevels.set(samID, level);
  }
  if (currentPlayer?.isAlive() === true) hasEverBeenAlive = true;
  const tickMs = decisionMs + executionMs;
  if (tickMs >= slowTickThresholdMs) {
    console.warn(
      JSON.stringify({
        phase: "slow_tick",
        tick: runner.game.ticks(),
        decisionMs: Math.round(decisionMs),
        executionMs: Math.round(executionMs),
        totalMs: Math.round(tickMs),
        intents: intents.length,
        alive: currentPlayer?.isAlive() ?? false,
        tiles: currentPlayer?.numTilesOwned() ?? 0,
        phases: profileBot ? bot.getPerformanceProfile().lastPhases : undefined,
      }),
    );
  }
  if (stopWhenBotDies && hasEverBeenAlive && currentPlayer?.isAlive() !== true) {
    stopReason = "bot_dead";
    break;
  }
  if (runner.game.ticks() >= progressFromTick && runner.game.ticks() % progressEveryTicks === 0) {
    const player = runner.game.playerByClientID(clientID);
    const incoming =
      player?.incomingAttacks().map((attack) => ({
        attacker: attack.attacker().name(),
        attackerType: attack.attacker().type(),
        troops: Math.round(attack.troops()),
      })) ?? [];
    const incomingAttackTroops = incoming.reduce((total, attack) => total + attack.troops, 0);
    const outgoing =
      player?.outgoingAttacks().map((attack) => ({
        target: attack.target()?.name?.() ?? "Unknown",
        targetType: attack.target()?.type?.() ?? "Unknown",
        troops: Math.round(attack.troops()),
      })) ?? [];
    const outgoingAttackTroops = outgoing.reduce((total, attack) => total + attack.troops, 0);
    const units = Object.fromEntries(
      trackedUnitTypes
        .map((type) => [type, player?.units(type).length ?? 0] as const)
        .filter(([, count]) => count > 0),
    );
    const unitDetails = Object.fromEntries(
      trackedUnitTypes
        .map(
          (type) =>
            [
              type,
              (player?.units(type) ?? []).map((unit) => ({
                id: unit.id(),
                level: unit.level(),
                tile: unit.tile(),
                active: unit.isActive(),
                underConstruction: unit.isUnderConstruction(),
              })),
            ] as const,
        )
        .filter(([, entries]) => entries.length > 0),
    );
    const externalSiloNetworks = runner.game
      .players()
      .filter((other) => other.clientID() !== clientID && other.isAlive())
      .map((other) => {
        const silos = other
          .units(UnitType.MissileSilo)
          .filter((silo) => silo.isActive() && !silo.isUnderConstruction());
        const sams = other
          .units(UnitType.SAMLauncher)
          .filter((sam) => sam.isActive() && !sam.isUnderConstruction());
        return {
          name: other.name(),
          team: other.team(),
          gold: Number(other.gold()),
          siloLevels: silos.map((silo) => silo.level()),
          siloCapacity: silos.reduce((total, silo) => total + Math.max(1, silo.level()), 0),
          samLevels: sams.map((sam) => sam.level()),
        };
      })
      .filter(
        (network) =>
          network.gold >= Number(PREEMPTIVE_SAM_SILO_GOLD) ||
          network.siloLevels.length > 0 ||
          network.samLevels.length > 0,
      );
    const activeMissiles = runner.game
      .units(...trackedMissileTypes)
      .filter((unit) => unit.isActive())
      .map((unit) => {
        const targetTile = unit.targetTile();
        const targetOwner = targetTile === undefined ? null : runner.game.owner(targetTile);
        const targetOwnerName = typeof targetOwner?.name === "function" ? targetOwner.name() : null;
        const targetOwnerTeam = typeof targetOwner?.team === "function" ? targetOwner.team() : null;
        return {
          id: unit.id(),
          type: unit.type(),
          owner: unit.owner().name(),
          ownerTeam: unit.owner().team(),
          targetTile: targetTile ?? null,
          targetOwner: targetOwnerName,
          targetOwnerTeam,
          trajectoryIndex: unit.trajectoryIndex(),
          trajectoryLength: unit.trajectory().length,
          targetedBySam: unit.targetedBySAM(),
        };
      });
    const attackBehavior = bot.nationBot?.attackBehavior;
    const productionReserve = Math.round(
      Number(attackBehavior?.getEarlyGameProductionReserveTroops?.() ?? 0),
    );
    const liveReserve = Math.round(Number(attackBehavior?.getEarlyGameLiveReserveTroops?.() ?? 0));
    const pendingTroops = Math.round(
      Number(attackBehavior?.getPendingOutboundTroopCommitments?.() ?? 0),
    );
    console.warn(
      JSON.stringify({
        phase: "progress",
        tick: runner.game.ticks(),
        alive: player?.isAlive() ?? false,
        tiles: player?.numTilesOwned() ?? 0,
        troops: player?.troops() ?? 0,
        maxTroops: player ? runner.game.config().maxTroops(player) : 0,
        productionReserve,
        liveReserve,
        pendingTroops,
        gold: Number(player?.gold() ?? 0n),
        incomingAttacks: player?.incomingAttacks().length ?? 0,
        outgoingAttacks: player?.outgoingAttacks().length ?? 0,
        incomingAttackTroops,
        incomingAttackPressure:
          player && player.troops() > 0
            ? Number((incomingAttackTroops / player.troops()).toFixed(3))
            : 0,
        outgoingAttackTroops,
        incoming,
        outgoing,
        units,
        unitDetails,
        externalSiloNetworks,
        activeMissiles,
        team: player?.team() ?? null,
        intents: emittedIntents,
        intervalTerraNulliusAttacks,
        cumulativeTerraNulliusAttacks,
        intervalIntentTypes: sortedCounts(intervalIntentTypes),
        cumulativeIntentTypes: sortedCounts(cumulativeIntentTypes),
        intervalBuildUnitTypes: sortedCounts(intervalBuildUnitTypes),
        cumulativeBuildUnitTypes: sortedCounts(cumulativeBuildUnitTypes),
        intervalBuildEvents,
        // A persisted trace must expose the aggregate profile at normal
        // progress checkpoints as well as at rare slow ticks. Otherwise a
        // match with no individual threshold breach leaves no evidence for the
        // phases that collectively consumed its decision budget.
        performanceProfile: profileBot ? bot.getPerformanceProfile() : undefined,
        elapsedMs: Math.round(performance.now() - startedAt),
      }),
    );
    intervalIntentTypes = new Map<string, number>();
    intervalBuildUnitTypes = new Map<string, number>();
    intervalBuildEvents = [];
    intervalTerraNulliusAttacks = 0;
  }
}

if (fatalError !== null) throw new Error(fatalError);
const winner = runner.game.getWinner();
if (winner !== null) stopReason = "winner";
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
    stopReason,
    performanceProfile: profileBot ? bot.getPerformanceProfile() : undefined,
    emittedIntents,
    cumulativeIntentTypes: sortedCounts(cumulativeIntentTypes),
    runtimeMs: Math.round(performance.now() - startedAt),
    topPlayers: players.slice(0, 10),
  }),
);

process.exitCode = won ? 0 : 2;
