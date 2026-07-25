import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  Difficulty,
  GameMode,
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
function headlessSeedState(value: string) {
  let state = 2166136261;
  for (let index = 0; index < value.length; index++) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return state >>> 0;
}

function createHeadlessPlaylistRandom(value: string) {
  let state = headlessSeedState(value) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

async function deterministicTeamPlaylistConfig(matchSeed: string) {
  const originalRandom = Math.random;
  const originalDateNow = Date.now;
  Math.random = createHeadlessPlaylistRandom(`${matchSeed}:playlist`);
  // MapPlaylist internally seeds its shuffle from Date.now().  Seed that
  // constructor input as well as its direct Math.random choices so a matching
  // OFH_MATCH_SEED yields the same generated playlist and team count.
  Date.now = () => headlessSeedState(`${matchSeed}:playlist-clock`);
  try {
    const playlist = new MapPlaylist();
    let playlistConfig = await playlist.gameConfig("team");
    // A Team match with one team fails inside GameImpl before tick zero. Keep
    // the playlist's normal redraw semantics, but make every draw derive from
    // the match seed so reruns are comparable.
    while (
      playlistConfig.playerTeams === HumansVsNations ||
      !Number.isFinite(Number(playlistConfig.playerTeams)) ||
      Number(playlistConfig.playerTeams) < 2
    ) {
      playlistConfig = await playlist.gameConfig("team");
    }
    return playlistConfig;
  } finally {
    Math.random = originalRandom;
    Date.now = originalDateNow;
  }
}

const playlistConfig = await deterministicTeamPlaylistConfig(seed);
const requestedTeams = process.env.OFH_PLAYER_TEAMS;
const numericTeams = Number(requestedTeams);
const requestedGameMode = (process.env.OFH_GAME_MODE ?? "team").trim().toLowerCase();
const requestedStartingGold = process.env.OFH_STARTING_GOLD;
const numericStartingGold = Number(requestedStartingGold);
const requestedNations = process.env.OFH_NATIONS;
const numericNations = Number(requestedNations);
const forceNukesEnabled = process.env.OFH_NUKES === "1";
const nuclearUnitTypes = new Set([
  UnitType.MissileSilo,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.SAMLauncher,
]);
if (requestedGameMode !== "team" && requestedGameMode !== "ffa") {
  throw new Error(`OFH_GAME_MODE must be team or ffa, got ${process.env.OFH_GAME_MODE}`);
}
const fixedGameMode = requestedGameMode === "ffa" ? GameMode.FFA : GameMode.Team;
if (
  requestedStartingGold !== undefined &&
  (!Number.isSafeInteger(numericStartingGold) || numericStartingGold < 0)
) {
  throw new Error(
    `OFH_STARTING_GOLD must be a non-negative safe integer, got ${requestedStartingGold}`,
  );
}
if (
  requestedNations !== undefined &&
  requestedNations !== "default" &&
  requestedNations !== "disabled" &&
  (!Number.isSafeInteger(numericNations) || numericNations < 1 || numericNations > 400)
) {
  throw new Error(
    `OFH_NATIONS must be default, disabled, or an integer from 1 to 400, got ${requestedNations}`,
  );
}
const configuredNations =
  requestedNations === undefined ||
  requestedNations === "default" ||
  requestedNations === "disabled"
    ? (requestedNations ?? "default")
    : numericNations;
const fixedConfig = process.env.OFH_GAME_MAP
  ? {
      gameMap: process.env.OFH_GAME_MAP,
      gameMapSize: process.env.OFH_GAME_MAP_SIZE ?? playlistConfig.gameMapSize,
      gameMode: fixedGameMode,
      ...(fixedGameMode === GameMode.Team
        ? {
            playerTeams:
              requestedTeams === undefined
                ? // Fixed-map smoke matches can have far fewer Nations than the
                  // unrelated random playlist used to supply defaults. Two teams
                  // guarantees the helper has a viable teammate instead of silently
                  // producing an unspawned no-op run; callers can still request an
                  // exact team count explicitly.
                  2
                : Number.isFinite(numericTeams)
                  ? numericTeams
                  : requestedTeams,
          }
        : {}),
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
  nations: configuredNations,
  ...(requestedStartingGold === undefined ? {} : { startingGold: numericStartingGold }),
  ...(forceNukesEnabled
    ? {
        disabledUnits: (playlistConfig.disabledUnits ?? []).filter(
          (unit) => !nuclearUnitTypes.has(unit),
        ),
      }
    : {}),
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
  difficulty: process.env.OFH_BOT_DIFFICULTY,
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
    botDifficulty: process.env.OFH_BOT_DIFFICULTY ?? "Impossible",
    autoBuild: bot.features.build === true,
    startingGold: config.startingGold ?? 0,
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
const spawnFailureGraceTicks = Math.max(
  1,
  Number(process.env.OFH_SPAWN_FAILURE_GRACE_TICKS ?? 700),
);
const logIntents = process.env.OFH_LOG_INTENTS === "1";
const logNaval = process.env.OFH_LOG_NAVAL === "1";
const logStructures = process.env.OFH_LOG_STRUCTURES === "1";
const logSpawn = process.env.OFH_LOG_SPAWN === "1";
// Persisted traces must always retain the lightweight SAM lifecycle. Full
// structure diagnostics remain opt-in because they are much noisier.
const logSamLifecycle = logStructures || traceFile !== undefined;
let turnNumber = 0;
let emittedIntents = 0;
let hasEverBeenAlive = me?.isAlive() === true;
let stopReason: "winner" | "max_ticks" | "bot_dead" | "engine_stop" | "spawn_failed" = "max_ticks";
let peakOwnedTiles = Math.max(0, me?.numTilesOwned() ?? 0);
const MEANINGFUL_TRAJECTORY_TILES = 1_000;
const COMEBACK_DRAWDOWN_RATIO = 0.5;
const COMEBACK_RECOVERY_RATIO = 0.8;
const CLOSEOUT_MIN_TILES = 5_000;
const CLOSEOUT_SHARE = 0.5;
const CLOSEOUT_LEAD_RATIO = 2;
const CLOSEOUT_SUSTAIN_TICKS = 500;
let deepestDrawdownRatio = 1;
let drawdownPeakTiles = peakOwnedTiles;
let drawdownTroughTiles = peakOwnedTiles;
let drawdownTick: number | null = null;
let comebackRecovered = false;
let comebackTick: number | null = null;
let closeoutReached = false;
let closeoutTick: number | null = null;
let closeoutCandidateTick: number | null = null;
let maximumTerritoryShare = 0;
let firstIncomingLandAttackObserved = false;
let firstTerritoryLossObserved = false;
let spawnSnapshotLogged = false;
let spawnMaterializedLogged = false;
const cumulativeIntentTypes = new Map<string, number>();
let intervalIntentTypes = new Map<string, number>();
const cumulativeBuildUnitTypes = new Map<string, number>();
let intervalBuildUnitTypes = new Map<string, number>();
let intervalBuildEvents: Array<{
  tick: number;
  unit: string;
  tile: number | null;
  strategicBorderPressure: ReturnType<typeof strategicBorderPressureSnapshot>;
}> = [];
const cumulativeBuildEvents: Array<{
  tick: number;
  unit: string;
  action: "build" | "upgrade";
  tile: number | null;
  portfolio: ReturnType<typeof constructionPortfolioSnapshot>;
  strategicBorderPressure: ReturnType<typeof strategicBorderPressureSnapshot>;
}> = [];
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
const slowTickEngineSnapshot = () => {
  const players = runner.game.players();
  const unitCount = (types: readonly UnitType[]) =>
    Object.fromEntries(
      types.map((type) => [
        type,
        players.reduce((total, player) => total + player.units(type).length, 0),
      ]),
    );
  return {
    players: players.length,
    alivePlayers: players.filter((player) => player.isAlive()).length,
    activeLandAttacks: players.reduce(
      (total, player) => total + player.outgoingAttacks().length,
      0,
    ),
    structures: unitCount(trackedUnitTypes),
    missiles: unitCount(trackedMissileTypes),
  };
};
const PREEMPTIVE_SAM_SILO_GOLD = 1_000_000n;
const playerField = (player: unknown, field: string) => {
  const value = (player as Record<string, unknown>)[field];
  return typeof value === "function" ? value.call(player) : value;
};
const strategicBorderPressureSnapshot = () => {
  const player = runner.game.playerByClientID(clientID);
  if (!player) return null;
  const ownTroops = Math.max(0, Number(player.troops()) || 0);
  const opponents = new Map<string, { name: string; troops: number }>();
  let frontTiles = 0;
  for (const borderTile of player.borderTiles()) {
    let threatened = false;
    for (const neighbor of runner.game.neighbors(borderTile)) {
      const opponent = runner.game.playerBySmallID(runner.game.ownerID(neighbor));
      if (!opponent) continue;
      const opponentType = playerField(opponent, "type");
      if (
        (opponentType !== PlayerType.Nation && opponentType !== PlayerType.Human) ||
        playerField(opponent, "team") === playerField(player, "team")
      )
        continue;
      opponents.set(String(playerField(opponent, "id")), {
        name: String(playerField(opponent, "name")),
        troops: Math.max(0, Number(playerField(opponent, "troops")) || 0),
      });
      threatened = true;
    }
    if (threatened) frontTiles += 1;
  }
  const hostileTroops = [...opponents.values()].reduce(
    (total, opponent) => total + opponent.troops,
    0,
  );
  const gold = player.gold();
  const defensePostCost = runner.game
    .config()
    .unitInfo(UnitType.DefensePost)
    .cost(runner.game, player);
  return {
    ownTroops,
    hostileTroops,
    hostileRatio: ownTroops > 0 ? hostileTroops / ownTroops : null,
    hostilePlayers: [...opponents.values()],
    frontTiles,
    gold: String(gold),
    defensePostCost: String(defensePostCost),
    canAffordDefensePost: gold >= defensePostCost,
  };
};
const constructionPortfolioSnapshot = () => {
  const player = runner.game.playerByClientID(clientID);
  if (!player) return null;
  return {
    gold: String(player.gold()),
    troops: Math.round(player.troops()),
    maxTroops: Math.round(runner.game.config().maxTroops(player)),
    tiles: player.numTilesOwned(),
    units: Object.fromEntries(
      trackedUnitTypes.map((type) => {
        const units = player.units(type);
        return [
          type,
          {
            count: units.length,
            levels: units.map((unit) => unit.level()),
            underConstruction: units.filter((unit) => unit.isUnderConstruction()).length,
          },
        ];
      }),
    ),
  };
};
const countIntents = (
  intents: readonly { type: string; unit?: unknown; tile?: unknown; unitId?: unknown }[],
  tick: number,
) => {
  const portfolio = constructionPortfolioSnapshot();
  for (const intent of intents) {
    cumulativeIntentTypes.set(intent.type, (cumulativeIntentTypes.get(intent.type) ?? 0) + 1);
    intervalIntentTypes.set(intent.type, (intervalIntentTypes.get(intent.type) ?? 0) + 1);
    if (
      (intent.type !== "build_unit" && intent.type !== "upgrade_structure") ||
      typeof intent.unit !== "string"
    )
      continue;
    cumulativeBuildUnitTypes.set(intent.unit, (cumulativeBuildUnitTypes.get(intent.unit) ?? 0) + 1);
    intervalBuildUnitTypes.set(intent.unit, (intervalBuildUnitTypes.get(intent.unit) ?? 0) + 1);
    const tile = intent.type === "build_unit" ? Number(intent.tile) : Number.NaN;
    const normalizedTile = Number.isFinite(tile) ? tile : null;
    const event = {
      tick,
      unit: intent.unit,
      action: intent.type === "upgrade_structure" ? ("upgrade" as const) : ("build" as const),
      tile: normalizedTile,
      portfolio,
      strategicBorderPressure: strategicBorderPressureSnapshot(),
    };
    cumulativeBuildEvents.push(event);
    intervalBuildEvents.push({
      tick: event.tick,
      unit: event.unit,
      tile: event.tile,
      strategicBorderPressure: event.strategicBorderPressure,
    });
  }
};
const sortedCounts = (counts: ReadonlyMap<string, number>) =>
  Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
const firstOwnedTile = (player: { tiles: () => Iterable<number> }) =>
  player.tiles().values().next().value ?? null;
const updateStrategicTrajectory = () => {
  const player = runner.game.playerByClientID(clientID);
  if (!player?.isAlive()) return;
  const tick = runner.game.ticks();
  const tiles = Math.max(0, player.numTilesOwned());
  if (peakOwnedTiles >= MEANINGFUL_TRAJECTORY_TILES && peakOwnedTiles > 0) {
    const ratio = tiles / peakOwnedTiles;
    if (ratio < deepestDrawdownRatio) {
      deepestDrawdownRatio = ratio;
      drawdownPeakTiles = peakOwnedTiles;
      drawdownTroughTiles = tiles;
      drawdownTick = tick;
    }
  }
  if (
    !comebackRecovered &&
    deepestDrawdownRatio <= COMEBACK_DRAWDOWN_RATIO &&
    drawdownPeakTiles >= MEANINGFUL_TRAJECTORY_TILES &&
    tiles >= Math.ceil(drawdownPeakTiles * COMEBACK_RECOVERY_RATIO)
  ) {
    comebackRecovered = true;
    comebackTick = tick;
  }

  if (tick % 100 !== 0) return;
  const territoryBySide = new Map<unknown, number>();
  for (const other of runner.game.allPlayers()) {
    if (other.type() === PlayerType.Bot || !other.isAlive()) continue;
    const side = config.gameMode === GameMode.Team ? other.team() : other.clientID();
    territoryBySide.set(side, (territoryBySide.get(side) ?? 0) + other.numTilesOwned());
  }
  const ownSide = config.gameMode === GameMode.Team ? player.team() : player.clientID();
  const ownTiles = territoryBySide.get(ownSide) ?? 0;
  const totalTiles = [...territoryBySide.values()].reduce((sum, value) => sum + value, 0);
  const territoryShare = totalTiles > 0 ? ownTiles / totalTiles : 0;
  maximumTerritoryShare = Math.max(maximumTerritoryShare, territoryShare);
  const strongestOpponent = Math.max(
    0,
    ...[...territoryBySide.entries()]
      .filter(([side]) => side !== ownSide)
      .map(([, value]) => value),
  );
  const hasCloseoutControl =
    territoryBySide.size >= 2 &&
    ownTiles >= CLOSEOUT_MIN_TILES &&
    territoryShare >= CLOSEOUT_SHARE &&
    strongestOpponent > 0 &&
    ownTiles / strongestOpponent >= CLOSEOUT_LEAD_RATIO;
  if (!hasCloseoutControl) {
    closeoutCandidateTick = null;
  } else if (closeoutCandidateTick === null) {
    closeoutCandidateTick = tick;
  } else if (!closeoutReached && tick - closeoutCandidateTick >= CLOSEOUT_SUSTAIN_TICKS) {
    closeoutReached = true;
    closeoutTick = tick;
  }
};
while (runner.game.getWinner() === null && runner.game.ticks() < maxTicks && fatalError === null) {
  const decisionStartedAt = performance.now();
  const intents = await bot.decide();
  if (logSpawn) {
    for (const entry of bot.drainSpawnTrace()) {
      console.warn(JSON.stringify({ ...entry, phase: "spawn-selection-trace" }));
    }
  }
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
    const earlyGame = bot.harness.internals.state.earlyGame ?? {};
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
          // The engine represents tribes with PlayerType.Bot.  Preserve the
          // raw type above, but make a Tribe-only scenario unambiguous for
          // offline auditors instead of making them mistake real captures for
          // generic bot combat.
          targetKind:
            target?.type?.() === PlayerType.Bot && config.nations === "disabled"
              ? "Tribe"
              : (snapshot?.type ?? target?.type() ?? "Terra Nullius"),
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
    const buildStrategicBorderPressure = intents.some((intent) => intent.type === "build_unit")
      ? strategicBorderPressureSnapshot()
      : null;
    const donationStrategicBorderPressure = intents.some(
      (intent) => intent.type === "donate_troops",
    )
      ? strategicBorderPressureSnapshot()
      : null;
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
        terraNulliusOpeningCommittedTroops: Number(
          bot.nationBot?.attackBehavior?.terraNulliusOpeningCommittedTroops ?? 0,
        ),
        tribeCluster: {
          plannerRefreshStage: bot.nationBot?.attackBehavior?.earlyGameTribeRefreshStage ?? null,
          plannerRefreshPending:
            bot.nationBot?.attackBehavior?.earlyGameTribeCandidatesRefresh != null,
          plannerRefreshStarts:
            bot.nationBot?.attackBehavior?.earlyGameTribeRefreshStartCount ?? 0,
          plannerEmptyCacheHits:
            bot.nationBot?.attackBehavior?.earlyGameTribeEmptyCacheHitCount ?? 0,
          plannerEmptyRetryAtTick:
            bot.nationBot?.attackBehavior?.earlyGameTribeEmptyRetryAtTick ?? 0,
          plannerCandidateCount: Array.isArray(
            bot.nationBot?.attackBehavior?.earlyGameTribeCandidatesCache,
          )
            ? bot.nationBot.attackBehavior.earlyGameTribeCandidatesCache.length
            : 0,
          plannerScoredCount: Array.isArray(
            bot.nationBot?.attackBehavior?.earlyGameTribeCandidatesCache,
          )
            ? bot.nationBot.attackBehavior.earlyGameTribeCandidatesCache.filter(
                (candidate: Record<string, unknown>) =>
                  Number.isFinite(Number(candidate.tribeClusterSize)) &&
                  Number.isFinite(Number(candidate.tribeClusterAccess)),
              ).length
            : 0,
          preferredSize: Number(earlyGame.preferredClusterSize ?? 0),
          preferredMemberIDs: Array.isArray(earlyGame.preferredClusterMembers)
            ? earlyGame.preferredClusterMembers.map((member: { id?: unknown }) => member.id)
            : [],
          rankedTarget: earlyGame.tribeTarget ?? null,
          rankedCandidates: Array.isArray(earlyGame.actionableTribes)
            ? earlyGame.actionableTribes.slice(0, 8).map((candidate: Record<string, unknown>) => ({
                id: candidate.id ?? null,
                alive: candidate.alive === true,
                friendly: candidate.friendly === true,
                landBorder: candidate.landBorder === true,
                boatCandidate: candidate.boatCandidate === true,
                seaReachableWithin30Ticks: candidate.seaReachableWithin30Ticks === true,
                boatEtaTicks: Number.isFinite(Number(candidate.boatEtaTicks))
                  ? Number(candidate.boatEtaTicks)
                  : null,
                tribeClusterSize: Number.isFinite(Number(candidate.tribeClusterSize))
                  ? Number(candidate.tribeClusterSize)
                  : null,
                tribeClusterAccess: Number.isFinite(Number(candidate.tribeClusterAccess))
                  ? Number(candidate.tribeClusterAccess)
                  : null,
              }))
            : [],
        },
        attackTargets,
        buildStrategicBorderPressure,
        donationStrategicBorderPressure,
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
  // The live client receives each game tick from a worker task, so cooperative
  // `setTimeout(0)` slices run between ticks. A tight async loop otherwise
  // advances only through microtasks and starves those timers until the whole
  // simulation ends, leaving tribe topology and route refreshes permanently
  // pending. Yield one host task per simulated tick while retaining max-speed
  // execution and deterministic game state.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const executionMs = performance.now() - executionStartedAt;
  const currentPlayer = runner.game.playerByClientID(clientID);
  updateStrategicTrajectory();
  if (logSpawn && !spawnMaterializedLogged && currentPlayer?.numTilesOwned() > 0) {
    spawnMaterializedLogged = true;
    const describeSpawn = (player: typeof currentPlayer) => {
      const tile = firstOwnedTile(player);
      return {
        name: player.name(),
        type: player.type(),
        team: player.team(),
        tiles: player.numTilesOwned(),
        x: tile === null ? null : runner.game.x(tile),
        y: tile === null ? null : runner.game.y(tile),
      };
    };
    console.warn(
      JSON.stringify({
        phase: "spawn-materialized",
        tick: runner.game.ticks(),
        self: describeSpawn(currentPlayer),
        players: runner.game
          .players()
          .filter((player) => player.type() !== PlayerType.Bot)
          .map(describeSpawn),
      }),
    );
  }
  if (currentPlayer) {
    const incomingLandAttacks = currentPlayer
      .incomingAttacks()
      .filter((attack) => attack.sourceTile() === null);
    if (!firstIncomingLandAttackObserved && incomingLandAttacks.length > 0) {
      firstIncomingLandAttackObserved = true;
      console.warn(
        JSON.stringify({
          phase: "first-incoming-land-attack",
          tick: runner.game.ticks(),
          tiles: currentPlayer.numTilesOwned(),
          troops: Math.round(currentPlayer.troops()),
          gold: String(currentPlayer.gold()),
          attacks: incomingLandAttacks.map((attack) => ({
            attacker: attack.attacker().name(),
            attackerType: attack.attacker().type(),
            troops: Math.round(attack.troops()),
          })),
          strategicBorderPressure: strategicBorderPressureSnapshot(),
        }),
      );
    }
    const tiles = currentPlayer.numTilesOwned();
    if (!firstTerritoryLossObserved && tiles < peakOwnedTiles) {
      firstTerritoryLossObserved = true;
      console.warn(
        JSON.stringify({
          phase: "first-territory-loss",
          tick: runner.game.ticks(),
          peakTiles: peakOwnedTiles,
          tiles,
          troops: Math.round(currentPlayer.troops()),
          gold: String(currentPlayer.gold()),
          incomingLandAttacks: incomingLandAttacks.map((attack) => ({
            attacker: attack.attacker().name(),
            attackerType: attack.attacker().type(),
            troops: Math.round(attack.troops()),
          })),
          strategicBorderPressure: strategicBorderPressureSnapshot(),
        }),
      );
    }
    peakOwnedTiles = Math.max(peakOwnedTiles, tiles);
  }
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
        engineState: slowTickEngineSnapshot(),
        phases: profileBot ? bot.getPerformanceProfile().lastPhases : undefined,
        spawnLifecycle: profileBot ? bot.getSpawnLifecycleSnapshot() : undefined,
      }),
    );
  }
  if (stopWhenBotDies && hasEverBeenAlive && currentPlayer?.isAlive() !== true) {
    stopReason = "bot_dead";
    break;
  }
  const spawnLifecycle = bot.getSpawnLifecycleSnapshot();
  if (
    !hasEverBeenAlive &&
    runner.game.ticks() >= spawnFailureGraceTicks &&
    spawnLifecycle.inSpawnPhase === false
  ) {
    stopReason = "spawn_failed";
    break;
  }
  if (runner.game.ticks() >= progressFromTick && runner.game.ticks() % progressEveryTicks === 0) {
    const player = runner.game.playerByClientID(clientID);
    if (logSpawn && !spawnSnapshotLogged && player?.numTilesOwned() > 0) {
      spawnSnapshotLogged = true;
      console.warn(
        JSON.stringify({
          phase: "spawn-team-snapshot",
          tick: runner.game.ticks(),
          self: (() => {
            const tile = firstOwnedTile(player);
            return {
              name: player.name(),
              team: player.team(),
              tiles: player.numTilesOwned(),
              x: tile === null ? null : runner.game.x(tile),
              y: tile === null ? null : runner.game.y(tile),
            };
          })(),
          players: runner.game
            .players()
            .filter((other) => other.type() === PlayerType.Nation)
            .map((other) => {
              const tile = firstOwnedTile(other);
              return {
                name: other.name(),
                team: other.team(),
                tiles: other.numTilesOwned(),
                x: tile === null ? null : runner.game.x(tile),
                y: tile === null ? null : runner.game.y(tile),
              };
            }),
        }),
      );
    }
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
const finalBotState =
  finalMe === null || finalMe === undefined
    ? null
    : {
        tiles: finalMe.numTilesOwned(),
        troops: finalMe.troops(),
        maxTroops: runner.game.config().maxTroops(finalMe),
        gold: Number(finalMe.gold()),
        units: Object.fromEntries(
          trackedUnitTypes
            .map((type) => [type, finalMe.units(type).length] as const)
            .filter(([, count]) => count > 0),
        ),
      };
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

const finalResult = {
    phase: "result",
    seed,
    won,
    winner: typeof winner === "string" ? winner : (winner?.name() ?? null),
    myTeam: finalMe?.team() ?? null,
    alive: finalMe?.isAlive() ?? false,
    finalBotState,
    ticks: runner.game.ticks(),
    stopReason,
    spawnLifecycle: bot.getSpawnLifecycleSnapshot(),
    performanceProfile: profileBot ? bot.getPerformanceProfile() : undefined,
    emittedIntents,
    cumulativeIntentTypes: sortedCounts(cumulativeIntentTypes),
    cumulativeBuildUnitTypes: sortedCounts(cumulativeBuildUnitTypes),
    constructionEvents: cumulativeBuildEvents,
    strategicTrajectory: {
      peakTiles: peakOwnedTiles,
      deepestDrawdownRatio: Number(deepestDrawdownRatio.toFixed(4)),
      drawdownPeakTiles,
      drawdownTroughTiles,
      drawdownTick,
      comebackRecovered,
      comebackTick,
      closeoutReached,
      closeoutTick,
      maximumTerritoryShare: Number(maximumTerritoryShare.toFixed(4)),
    },
    runtimeMs: Math.round(performance.now() - startedAt),
  topPlayers: players.slice(0, 10),
};

// The engine may retain timers or sockets after a terminal game result.  The
// batch contract is a completed result line followed by child termination, so
// flush that line before exiting rather than relying on the event loop to
// become idle.
process.stderr.write(`${JSON.stringify(finalResult)}\n`, () => {
  process.exit(won ? 0 : 2);
});
