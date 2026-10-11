import { appendFileSync, createReadStream, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { foreignGitEnvironment } from "../git-environment.mjs";

import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  HumansVsNations,
  PlayerType,
  Unit,
  UnitType,
} from "../../openfront-engine/src/core/game/Game.ts";
import { createGameRunner } from "../../openfront-engine/src/core/GameRunner.ts";
import { FactoryExecution } from "../../openfront-engine/src/core/execution/FactoryExecution.ts";
import { NukeExecution } from "../../openfront-engine/src/core/execution/NukeExecution.ts";
import { MissileSiloExecution } from "../../openfront-engine/src/core/execution/MissileSiloExecution.ts";
import { TrainExecution } from "../../openfront-engine/src/core/execution/TrainExecution.ts";
import { TransportShipExecution } from "../../openfront-engine/src/core/execution/TransportShipExecution.ts";
import type { StampedIntent, Turn } from "../../openfront-engine/src/core/Schemas.ts";
import { MapPlaylist } from "../../openfront-engine/src/server/MapPlaylist.ts";
import { NodeGameMapLoader } from "../../openfront-engine/tests/perf/fullgame/NodeGameMapLoader.ts";
import {
  createMaxDifficultyOpponent,
  playersShareSide,
  HybridFifoDispatcher,
} from "./opponent-adapter.js";
import { UnitImpl } from "../../openfront-engine/src/core/game/UnitImpl.ts";
import { PlayerImpl } from "../../openfront-engine/src/core/game/PlayerImpl.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(root, "../../openfront-engine");
const seed = process.env.OFH_MATCH_SEED ?? `ofh-random-team-${Date.now()}`;
const clientID = "ofh-auto-bot";
let ownNukeDetonations = 0;
let ownAtomDetonations = 0;
let ownHydrogenDetonations = 0;
let ownMirvWarheadDetonations = 0;

// ── Per-game goal instrumentation ────────────────────────────────────────────
// Tracks the four in-game achievement requirements for the validation games:
// captured trade vessels, destroyed enemy warships, the gold value of enemy
// structures destroyed by our nukes, and the highest own-warship veterancy.
// Captures and warship kills come from the engine's authoritative stats; the
// nuked value is priced at destruction time (the cost curve counts the
// victim's owned units, so it must be read before the counts change).
const nukeVulnerableStructureTypes = new Set<UnitType>([
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
]);
let nukeDetonatingOwner: import("../../openfront-engine/src/core/game/Game.ts").Player | null =
  null;
let nukeDetonatingDestination: number | null = null;
let nukeDetonatingType: string | null = null;
let nukeDetonatingId: number | null = null;
let nukeDetonatingMissileId: number | null = null;
let nukeDetonationSequence = 0;
let nukedStructureGold = 0n;
let ownStructuresNuked = 0;
let ownTransportBoatsLost = 0;
let firstOwnStructureLostTick: number | null = null;
const goldEarnedById = new Map<string, bigint>();
const originalNukeTick = NukeExecution.prototype.tick;
NukeExecution.prototype.tick = function (
  this: NukeExecution & {
    player: import("../../openfront-engine/src/core/game/Game.ts").Player;
    dst: number;
    src: number | null | undefined;
    nuke: Unit | null;
  },
  ticks: number,
) {
  const unlaunched = this.nuke === null;
  originalNukeTick.call(this, ticks);
  if (logNukes && unlaunched && this.nuke !== null) {
    console.log(
      `[ofh:nuke-launch] tick=${this.mg.ticks()} missileId=${this.nuke.id()} owner=${this.player.name?.() ?? "unknown"} ownerId=${this.player.smallID?.() ?? "?"} source=${this.src ?? "?"} target=${this.dst} type=${this.nuke.type()}`,
    );
  }
};
const originalPlayerBuildUnit = PlayerImpl.prototype.buildUnit;
PlayerImpl.prototype.buildUnit = function (type, spawnTile, params) {
  const unit = originalPlayerBuildUnit.call(this, type, spawnTile, params);
  if (logNukes && type === UnitType.MissileSilo) {
    const game = (this as unknown as { mg: { ticks(): number } }).mg;
    console.log(
      `[ofh:silo-build] tick=${game.ticks()} owner=${this.name()} ownerId=${this.smallID()} siloId=${unit.id()} tile=${spawnTile} level=${unit.level()} underConstruction=${unit.isUnderConstruction()}`,
    );
  }
  return unit;
};
const originalNukeDetonate = NukeExecution.prototype.detonate;
NukeExecution.prototype.detonate = function (
  this: NukeExecution & {
    player: import("../../openfront-engine/src/core/game/Game.ts").Player;
    dst: number;
    nuke: Unit | null;
  },
) {
  const previous = nukeDetonatingOwner;
  const previousDestination = nukeDetonatingDestination;
  const previousType = nukeDetonatingType;
  const previousId = nukeDetonatingId;
  const previousMissileId = nukeDetonatingMissileId;
  const destination = this.dst;
  const detonationId = logNukes ? ++nukeDetonationSequence : null;
  const nukeType = this.nuke?.type() ?? "unknown";
  const missileId = this.nuke?.id() ?? null;
  const isOwnDetonation = this.player?.clientID?.() === clientID && this.nuke !== null;
  nukeDetonatingOwner = this.player;
  nukeDetonatingDestination = destination;
  nukeDetonatingType = String(nukeType);
  nukeDetonatingId = detonationId;
  nukeDetonatingMissileId = missileId;
  try {
    if (logNukes) {
      console.log(
        `[ofh:nuke-detonate] tick=${this.mg.ticks()} id=${detonationId} missileId=${missileId ?? "?"} owner=${this.player?.name?.() ?? "unknown"} ownerId=${this.player?.smallID?.() ?? "?"} source=${this.src ?? "?"} tile=${destination} type=${nukeType}`,
      );
    }
    originalNukeDetonate.call(this);
    if (isOwnDetonation) {
      ownNukeDetonations += 1;
      if (nukeType === UnitType.AtomBomb) ownAtomDetonations += 1;
      else if (nukeType === UnitType.HydrogenBomb) ownHydrogenDetonations += 1;
      else if (nukeType === UnitType.MIRVWarhead) ownMirvWarheadDetonations += 1;
    }
  } finally {
    nukeDetonatingOwner = previous;
    nukeDetonatingDestination = previousDestination;
    nukeDetonatingType = previousType;
    nukeDetonatingId = previousId;
    nukeDetonatingMissileId = previousMissileId;
  }
};
const originalUnitDelete = UnitImpl.prototype.delete;
UnitImpl.prototype.delete = function (
  this: UnitImpl,
  displayMessage?: boolean,
  destroyer?: import("../../openfront-engine/src/core/game/Game.ts").Player,
) {
  let nukedStructureTrace: string | null = null;
  if (nukeDetonatingOwner !== null && nukeVulnerableStructureTypes.has(this.type())) {
    const structureType = this.type();
    const structureTile = this.tile();
    const structureOwner = this.owner();
    if (logNukes) {
      nukedStructureTrace = `[ofh:nuke-structure-destroyed] tick=${this.mg.ticks()} id=${nukeDetonatingId ?? "?"} missileId=${nukeDetonatingMissileId ?? "?"} owner=${nukeDetonatingOwner.name?.() ?? "unknown"} ownerId=${nukeDetonatingOwner.smallID?.() ?? "?"} target=${nukeDetonatingDestination ?? "?"} nukeType=${nukeDetonatingType ?? "unknown"} type=${String(structureType)} tile=${structureTile} structureId=${this.id()} structureOwner=${structureOwner?.name?.() ?? "unknown"} structureOwnerId=${structureOwner?.smallID?.() ?? "?"}`;
    }
    if (destroyer === nukeDetonatingOwner && destroyer?.clientID?.() === clientID) {
      nukedStructureGold += this.mg.unitInfo(this.type()).cost(this.mg, this.owner());
    }
    if (this.owner()?.clientID?.() === clientID) {
      ownStructuresNuked += 1;
      if (logNukes) {
        console.log(
          `[ofh:own-structure-nuked] tick=${this.mg.ticks()} type=${String(this.type())} tile=${this.tile()} x=${this.mg.x(this.tile())} y=${this.mg.y(this.tile())}`,
        );
      }
      if (firstOwnStructureLostTick === null) {
        firstOwnStructureLostTick = this.mg.ticks();
      }
    }
  }
  // Engine stats attribute transport destruction to the DESTROYER
  // (boatDestroyTroops(destroyer, ...)), so our own losses are only visible
  // at the deletion site: an own transport removed by an enemy in any way
  // (warship shell, nuke blast, capture-side delete) is a lost boat.
  if (
    this.type() === UnitType.TransportShip &&
    destroyer !== undefined &&
    this.owner()?.clientID?.() === clientID
  ) {
    ownTransportBoatsLost += 1;
    if (process.env.OFH_LOG_TRANSPORT_DEATHS === "1") {
      console.log(
        `[ofh:transport-death] tick=${this.mg.ticks()} x=${this.mg.x(this.tile())} y=${this.mg.y(this.tile())} destroyer=${destroyer?.name?.() ?? "unknown"}`,
      );
    }
  }
  const deleted = originalUnitDelete.call(this, displayMessage, destroyer);
  if (nukedStructureTrace !== null) console.log(nukedStructureTrace);
  return deleted;
};

// Hull-level veterancy telemetry: the delete site only receives the
// destroyer PLAYER (UnitImpl.delete(displayMessage?, destroyer?: Player)),
// so per-hull vet/progress must be observed where the engine awards it:
// recordKill / recordTradeCapture on the victor hull itself.
// These two methods are the ONLY entry points to veterancy gain (all
// promotions flow through increaseVeterancy from recordKill or
// addVeterancyProgress), so checking veterancy() after the original call
// observes every promotion, including a flagship that dies before the
// end-state scan. The end-state scan is kept as a lower bound only.
let maxWarshipVeterancySeen = 0;
const originalRecordKill = UnitImpl.prototype.recordKill;
UnitImpl.prototype.recordKill = function (this: UnitImpl, targetType: UnitType) {
  const state = (this as unknown as { _warshipState?: { veterancyProgress?: number } })
    ._warshipState;
  const isBotHull = state !== undefined && this.owner()?.clientID?.() === clientID;
  originalRecordKill.call(this, targetType);
  if (isBotHull) {
    maxWarshipVeterancySeen = Math.max(maxWarshipVeterancySeen, this.veterancy());
  }
  if (!isBotHull || process.env.OFH_LOG_WARSHIP_KILLS !== "1") {
    return;
  }
  const vetBefore = this.veterancy();
  const progressAfter = state.veterancyProgress ?? 0;
  const targetLabel =
    targetType === UnitType.Warship
      ? "warship"
      : targetType === UnitType.TransportShip
        ? "transport"
        : String(targetType);
  console.log(
    `[ofh:warship-kill] tick=${this.mg.ticks()} hull=${this.id()} target=${targetLabel} vet=${this.veterancy()} progress=${progressAfter}`,
  );
};
const originalRecordTradeCapture = UnitImpl.prototype.recordTradeCapture;
UnitImpl.prototype.recordTradeCapture = function (this: UnitImpl) {
  const state = (this as unknown as { _warshipState?: { veterancyProgress?: number } })
    ._warshipState;
  const isBotHull = state !== undefined && this.owner()?.clientID?.() === clientID;
  originalRecordTradeCapture.call(this);
  if (isBotHull) {
    maxWarshipVeterancySeen = Math.max(maxWarshipVeterancySeen, this.veterancy());
    if (process.env.OFH_LOG_WARSHIP_KILLS === "1") {
      console.log(
        `[ofh:trade-capture] tick=${this.mg.ticks()} hull=${this.id()} vet=${this.veterancy()} progress=${state.veterancyProgress ?? 0}`,
      );
    }
  }
};

// Cumulative gold earned per player: every income path (base income, trade
// arrivals, conquest transfers) flows through PlayerImpl.addGold, so a
// prototype wrap gives the "best economy" comparison without touching the
// engine's logic.
const originalAddGold = PlayerImpl.prototype.addGold;
PlayerImpl.prototype.addGold = function (
  this: import("../../openfront-engine/src/core/game/Game.ts").Player,
  toAdd: bigint,
  tile?: unknown,
) {
  // Nations and bots carry no clientID, so the accumulator is keyed by the
  // engine player id to keep every economy comparable.
  const playerKey = String(this.id?.() ?? "");
  if (playerKey !== "" && toAdd > 0n) {
    goldEarnedById.set(playerKey, (goldEarnedById.get(playerKey) ?? 0n) + toAdd);
  }
  return originalAddGold.call(this, toAdd as never, tile as never);
};

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
const forceFiveMM = process.env.OFH_5MM === "1";
const forceTwentyFiveMM = process.env.OFH_25MM === "1";
const noModifiers = process.env.OFH_NO_MODIFIERS === "1";
const temporaryPvpImmunity = process.env.OFH_TEMP_PVP_IMMUNITY === "1";
const effectiveStartingGold = forceFiveMM
  ? "5000000"
  : forceTwentyFiveMM
    ? "25000000"
    : requestedStartingGold;
const numericRequestedStartingGold = Number(requestedStartingGold);
const numericStartingGold = Number(effectiveStartingGold);
const requestedNations = process.env.OFH_NATIONS;
const numericNations = Number(requestedNations);
const forceNukesEnabled = process.env.OFH_NUKES === "1";
// Test-only maritime fixture. Materialize a completed own Port once a spawned
// nation owns a coast so Warship policy can be exercised independently of the
// economy's preceding Port timing.
const injectOwnPort = process.env.OFH_INJECT_OWN_PORT === "1";
const injectHostileTransport = process.env.OFH_INJECT_HOSTILE_TRANSPORT === "1";
const hostileTransportNotBeforeTick = Number(process.env.OFH_INJECT_HOSTILE_TRANSPORT_AT_TICK ?? 0);
// Test-only pressure fixture. This never reaches the userscript: it lets
// missile-defense policy face an incoming hostile warhead deterministically.
const injectHostileAtom = process.env.OFH_INJECT_HOSTILE_ATOM === "1";
const hostileAtomNotBeforeTick = Number(process.env.OFH_INJECT_HOSTILE_ATOM_AT_TICK ?? 0);
// Fixture war chest for the injected first strike. Low values (e.g. 2M) make
// the hostile fire its one scripted shot without funding an AI arms race.
const hostileAtomFixtureGold = BigInt(
  Number(process.env.OFH_INJECT_HOSTILE_ATOM_GOLD ?? 100_000_000),
);
// Test-only economy fixture. It creates a completed Factory → City → City
// line through the engine and emits the observed train stops; it never reaches
// the userscript's build policy.
const injectRailEconomy = process.env.OFH_INJECT_RAIL_ECONOMY === "1";
// Test-only arsenal fixture. Gives the bot finished, leveled Missile Silos
// (with reload executions) so the anti-SAM salvo path has real capacity to
// plan with; never reaches the userscript.
const injectOwnSiloNetwork = process.env.OFH_INJECT_OWN_SILO_NETWORK === "1";
const ownSiloLevel = Number(process.env.OFH_INJECT_OWN_SILO_LEVEL ?? 3);
// Gives the hostile nation a SAM right next to its largest city so ordinary
// nuke candidates there are trajectory-covered and the salvo path owns the
// response. Pairs with OFH_INJECT_HOSTILE_ATOM.
const injectHostileSamCover = process.env.OFH_INJECT_HOSTILE_SAM_COVER === "1";
const injectHostileSiloNetwork = process.env.OFH_INJECT_HOSTILE_SILO_NETWORK === "1";
const hostileSiloNetworkCount = Number(process.env.OFH_INJECT_HOSTILE_SILO_COUNT ?? 3);
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
if (
  Number(forceFiveMM) +
    Number(forceTwentyFiveMM) +
    Number(noModifiers) +
    Number(temporaryPvpImmunity) >
  1
) {
  throw new Error(
    "OFH_5MM, OFH_25MM, OFH_NO_MODIFIERS, and OFH_TEMP_PVP_IMMUNITY are mutually exclusive",
  );
}
if (
  (forceFiveMM || forceTwentyFiveMM) &&
  requestedStartingGold !== undefined &&
  numericRequestedStartingGold !== (forceFiveMM ? 5_000_000 : 25_000_000)
) {
  throw new Error("OFH_5MM/OFH_25MM cannot be combined with a different OFH_STARTING_GOLD value");
}
if (injectHostileAtom && !forceNukesEnabled) {
  throw new Error("OFH_INJECT_HOSTILE_ATOM=1 requires OFH_NUKES=1");
}
if (!Number.isSafeInteger(hostileAtomNotBeforeTick) || hostileAtomNotBeforeTick < 0) {
  throw new Error(
    `OFH_INJECT_HOSTILE_ATOM_AT_TICK must be a non-negative safe integer, got ${process.env.OFH_INJECT_HOSTILE_ATOM_AT_TICK}`,
  );
}
if (!Number.isSafeInteger(ownSiloLevel) || ownSiloLevel < 2 || ownSiloLevel > 5) {
  throw new Error(
    `OFH_INJECT_OWN_SILO_LEVEL must be an integer from 2 to 5, got ${process.env.OFH_INJECT_OWN_SILO_LEVEL}`,
  );
}
if (hostileAtomFixtureGold < 0n) {
  throw new Error("OFH_INJECT_HOSTILE_ATOM_GOLD must be non-negative");
}
if (!Number.isSafeInteger(hostileTransportNotBeforeTick) || hostileTransportNotBeforeTick < 0) {
  throw new Error("OFH_INJECT_HOSTILE_TRANSPORT_AT_TICK must be a non-negative safe integer");
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
  requestedNations === undefined
    ? playlistConfig.nations
    : requestedNations === "default" || requestedNations === "disabled"
      ? requestedNations
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
  ...(noModifiers
    ? {
        gameMapSize: GameMapSize.Normal,
        publicGameModifiers: {},
        startingGold: undefined,
        goldMultiplier: undefined,
        randomSpawn: false,
        spawnImmunityDuration: 50,
        bots: Number(process.env.OFH_BOTS ?? 400),
      }
    : {}),
  ...fixedConfig,
  // Keep the explicit mode authoritative even when the random playlist is
  // used (without OFH_GAME_MAP the playlist would otherwise silently restore
  // Team mode and invalidate FFA evidence).
  gameMode: fixedGameMode,
  ...(fixedGameMode === GameMode.Team
    ? {
        playerTeams:
          requestedTeams === undefined
            ? playlistConfig.playerTeams
            : Number.isFinite(numericTeams)
              ? numericTeams
              : requestedTeams,
      }
    : {}),
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
  ...(noModifiers
    ? {
        gameMapSize: GameMapSize.Normal,
        publicGameModifiers: {},
        goldMultiplier: undefined,
        startingGold: undefined,
        randomSpawn: false,
        spawnImmunityDuration: 50,
        bots: Number(process.env.OFH_BOTS ?? 400),
        disabledUnits: [],
      }
    : {}),
  ...(forceFiveMM
    ? {
        gameMapSize: GameMapSize.Normal,
        publicGameModifiers: { startingGold: 5_000_000 },
        startingGold: 5_000_000,
        spawnImmunityDuration: 450,
        bots: Number(process.env.OFH_BOTS ?? 400),
      }
    : {}),
  ...(forceTwentyFiveMM
    ? {
        gameMapSize: GameMapSize.Normal,
        publicGameModifiers: { startingGold: 25_000_000 },
        startingGold: 25_000_000,
        spawnImmunityDuration: 450,
        bots: Number(process.env.OFH_BOTS ?? 400),
      }
    : {}),
  ...(temporaryPvpImmunity
    ? {
        gameMapSize: GameMapSize.Normal,
        publicGameModifiers: { isPeaceTime: true },
        startingGold: undefined,
        goldMultiplier: undefined,
        spawnImmunityDuration: 2_400,
        bots: Number(process.env.OFH_BOTS ?? 400),
      }
    : {}),
  ...(!forceFiveMM && !forceTwentyFiveMM && !noModifiers && requestedStartingGold === undefined
    ? {}
    : !forceFiveMM && !forceTwentyFiveMM && !noModifiers
      ? { startingGold: numericStartingGold }
      : {}),
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
const profileBot = process.env.OFH_PROFILE_BOT === "1";
const bot = createMaxDifficultyOpponent({
  clientID,
  difficulty: process.env.OFH_BOT_DIFFICULTY,
  name: "OFH Auto Bot",
  performanceProfiling: profileBot,
});
const runner = await createGameRunner(
  gameStart,
  undefined,
  new NodeGameMapLoader(path.join(engineRoot, "resources/maps")),
  (update) => {
    if ("errMsg" in update) fatalError = `${update.errMsg}\n${update.stack ?? ""}`;
    else bot.applyGameUpdate(update);
  },
);
bot.attach({ runner, clientID, gameID: seed });

const initialPlayers = runner.game
  .allPlayers()
  .filter((player) => player.type() !== PlayerType.Bot);
const nations = initialPlayers.filter((player) => player.type() === PlayerType.Nation);
const me = runner.game.playerByClientID(clientID);
let seaInvasionObserved = false;
const originalConquerPlayer = runner.game.conquerPlayer.bind(runner.game);
runner.game.conquerPlayer = (conqueror, conquered) => {
  if (
    conquered.clientID() !== clientID &&
    conquered.team() !== null &&
    conquered.team() === me?.team()
  ) {
    console.warn(
      JSON.stringify({
        phase: "ally-conquered",
        tick: runner.game.ticks(),
        conqueror: conqueror.name(),
        conquerorTeam: conqueror.team(),
        conquered: conquered.name(),
        conqueredTiles: conquered.numTilesOwned(),
      }),
    );
  }
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

let evaluationFingerprints:
  { engineFingerprint: { revision: string; diffHash: string }; mapFingerprint: string } | undefined;
if (process.env.OFH_HYBRID_COMBAT_MODE) {
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const mapKey = Object.keys(GameMapType).find(
    (key) => GameMapType[key as keyof typeof GameMapType] === config.gameMap,
  );
  if (!mapKey) throw new Error(`Cannot fingerprint unknown map ${config.gameMap}`);
  const mapHash = createHash("sha256");
  for (const file of ["manifest.json", "map.bin", "map4x.bin", "map16x.bin"]) {
    mapHash.update(file);
    for await (const chunk of createReadStream(
      path.join(engineRoot, "resources/maps", mapKey.toLowerCase(), file),
    )) {
      mapHash.update(chunk);
    }
  }
  evaluationFingerprints = {
    engineFingerprint: {
      revision: execFileSync("git", ["-C", engineRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        env: foreignGitEnvironment(),
      }).trim(),
      diffHash: digest(
        execFileSync("git", ["-C", engineRoot, "diff", "HEAD", "--binary"], {
          env: foreignGitEnvironment(),
        }),
      ),
    },
    mapFingerprint: mapHash.digest("hex"),
  };
}
console.warn(
  JSON.stringify({
    phase: "start",
    ...evaluationFingerprints,
    seed,
    map: config.gameMap,
    mapSize: config.gameMapSize,
    mode: config.gameMode,
    teams: config.playerTeams,
    difficulty: config.difficulty,
    botDifficulty: "Legendary",
    autoBuild: bot.features.build === true,
    startingGold: config.startingGold ?? 0,
    publicGameModifiers: config.publicGameModifiers ?? {},
    spawnImmunityDuration: config.spawnImmunityDuration ?? null,
    profile: forceFiveMM
      ? "5MM"
      : forceTwentyFiveMM
        ? "25MM"
        : temporaryPvpImmunity
          ? "temporary-pvp-immunity"
          : noModifiers
            ? "none"
            : "playlist",
    nations: nations.length,
    tribes: config.bots,
    myTeam: me?.team() ?? null,
  }),
);

const startedAt = performance.now();
const maxTicks = Number(process.env.OFH_MAX_TICKS ?? 103_000);
const progressEveryTicks = Math.max(1, Number(process.env.OFH_PROGRESS_TICKS ?? 500));
const progressFromTick = Math.max(0, Number(process.env.OFH_PROGRESS_FROM_TICK ?? 0));
// Diagnostic-only rival port timeline (OFH_RIVAL_PORT_TIMELINE=1): when the
// winning economies actually buy their ports, sampled every progress tick.
const rivalPortTimelineEnabled = process.env.OFH_RIVAL_PORT_TIMELINE === "1";
const rivalPortTimeline: Array<Record<string, unknown>> = [];
const slowTickThresholdMs = Math.max(1, Number(process.env.OFH_SLOW_TICK_MS ?? 250));
const stopWhenBotDies = process.env.OFH_STOP_WHEN_DEAD !== "0";
const spawnFailureGraceTicks = Math.max(
  1,
  Number(process.env.OFH_SPAWN_FAILURE_GRACE_TICKS ?? 700),
);
const logIntents = process.env.OFH_LOG_INTENTS === "1";
const logNaval = process.env.OFH_LOG_NAVAL === "1";
const logStructures = process.env.OFH_LOG_STRUCTURES === "1";
const logSiloQuotes = process.env.OFH_LOG_SILO_QUOTES === "1";
const logNukes = process.env.OFH_LOG_NUKES === "1";
const logSpawn = process.env.OFH_LOG_SPAWN === "1";
const logAttackHotspots = process.env.OFH_LOG_ATTACK_HOTSPOTS === "1";
// Persisted traces must always retain the lightweight SAM lifecycle. Full
// structure diagnostics remain opt-in because they are much noisier.
const logSamLifecycle = logStructures || traceFile !== undefined;

// targetedBySAM() dereferences _nukeState!, which exists only on in-flight
// warheads; stockpiled or already-detonated atoms would crash the read.
// trajectory() is the safe probe (optional-chained upstream).
const inFlightTargetedBySam = (missile: UnitImpl): boolean =>
  missile.trajectory().length > 0 ? missile.targetedBySAM() === true : false;

let turnNumber = 0;
const hybridFifo =
  process.env.OFH_HYBRID_FIFO_DELAY_TICKS === undefined
    ? null
    : new HybridFifoDispatcher({ delayTicks: Number(process.env.OFH_HYBRID_FIFO_DELAY_TICKS) });
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
let firstHostileNukeTick: number | null = null;
let firstReadySamTick: number | null = null;
const loggedHostileMissileIDs = new Set<string>();
let landLeaderAt120Seconds: {
  name: string;
  type: string;
  tiles: number;
  share: number;
  isOwn: boolean;
} | null = null;
let landLeaderAt180Seconds: {
  name: string;
  type: string;
  tiles: number;
  share: number;
  isOwn: boolean;
} | null = null;
// Amended-standard companion key (non-nation leader at the 3-minute mark).
let landLeaderNonNationAt180Seconds: {
  name: string;
  type: string;
  tiles: number;
  ownTiles: number;
  ownRank: number;
  isOwn: boolean;
} | null = null;
// Beachhead ledger: each enemy landing tile -> tick observed, tick recaptured
// (null while still enemy-held). Feeds the "fruitless invasion" verdict.
const invasionBeachheads = new Map<number, { landedTick: number; recapturedTick: number | null }>();
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
        playersShareSide(player, opponent)
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
let ownPortInjected = false;
let hostileTransportInjected = false;
let railEconomyFixture: {
  factory: ReturnType<NonNullable<typeof me>["buildUnit"]>;
  firstCity: ReturnType<NonNullable<typeof me>["buildUnit"]>;
  lastCity: ReturnType<NonNullable<typeof me>["buildUnit"]>;
  train: TrainExecution | null;
  trainStartedAt: number | null;
} | null = null;
let railEconomyFixtureReported = false;
let railEconomyFixtureNextAttemptTick = 0;
const ownedRailFixtureStations = (player: NonNullable<typeof me>) => {
  const owned = [...player.tiles()];
  const maxSamples = 96;
  const stride = Math.max(1, Math.ceil(owned.length / maxSamples));
  const samples = owned.filter((_tile, index) => index % stride === 0).slice(0, maxSamples);
  const minRangeSquared = 15 ** 2;
  const stationRangeSquared = 110 ** 2;
  for (const factory of samples) {
    for (const lastCity of samples) {
      const endpointsDistance = runner.game.euclideanDistSquared(factory, lastCity);
      if (endpointsDistance <= stationRangeSquared) continue;
      for (const firstCity of samples) {
        const firstDistance = runner.game.euclideanDistSquared(factory, firstCity);
        const lastDistance = runner.game.euclideanDistSquared(firstCity, lastCity);
        if (
          firstDistance >= minRangeSquared &&
          firstDistance <= stationRangeSquared &&
          lastDistance >= minRangeSquared &&
          lastDistance <= stationRangeSquared
        ) {
          return { factory, firstCity, lastCity };
        }
      }
    }
  }
  return null;
};
const injectRailEconomyIfReady = () => {
  if (railEconomyFixture !== null || !injectRailEconomy || !me?.isAlive()) return;
  if (runner.game.ticks() < railEconomyFixtureNextAttemptTick) return;
  railEconomyFixtureNextAttemptTick = runner.game.ticks() + 100;
  const stations = ownedRailFixtureStations(me);
  if (stations === null) return;
  me.addGold(100_000_000n);
  const factory = me.buildUnit(UnitType.Factory, stations.factory, {});
  const firstCity = me.buildUnit(UnitType.City, stations.firstCity, {});
  const lastCity = me.buildUnit(UnitType.City, stations.lastCity, {});
  runner.game.addExecution(new FactoryExecution(factory));
  railEconomyFixture = { factory, firstCity, lastCity, train: null, trainStartedAt: null };
  console.warn(
    JSON.stringify({ phase: "rail-economy-fixture-injected", tick: runner.game.ticks(), stations }),
  );
};
const observeRailEconomyFixture = () => {
  if (railEconomyFixture === null || !me?.isAlive()) return;
  if (railEconomyFixture.train === null) {
    const manager = runner.game.railNetwork().stationManager();
    const source = manager.findStation(railEconomyFixture.factory);
    const destination = manager.findStation(railEconomyFixture.lastCity);
    if (source === null || destination === null) return;
    const train = new TrainExecution(runner.game.railNetwork(), me, source, destination, 0);
    runner.game.addExecution(train);
    railEconomyFixture.train = train;
    railEconomyFixture.trainStartedAt = runner.game.ticks();
    return;
  }
  if (railEconomyFixtureReported || railEconomyFixture.train.isActive()) return;
  railEconomyFixtureReported = true;
  console.warn(
    JSON.stringify({
      phase: "rail-economy-fixture-resolved",
      tick: runner.game.ticks(),
      startedAt: railEconomyFixture.trainStartedAt,
      paidStops: railEconomyFixture.train.tradeStopsVisited(),
      expectedMinimumPaidStops: 2,
    }),
  );
};
const injectOwnPortIfReady = () => {
  if (ownPortInjected || !injectOwnPort || !me?.isAlive()) return;
  const coastTile = [...me.tiles()].find(
    (tile) =>
      runner.game.isLand(tile) &&
      runner.game.neighbors(tile).some((next) => runner.game.isWater(next)),
  );
  if (coastTile === undefined) return;
  me.buildUnit(UnitType.Port, coastTile, {});
  ownPortInjected = true;
  console.warn(
    JSON.stringify({ phase: "own-port-injected", tick: runner.game.ticks(), coastTile }),
  );
};
const injectHostileTransportIfReady = () => {
  if (hostileTransportInjected || !injectHostileTransport || !me?.isAlive()) return;
  if (runner.game.ticks() < hostileTransportNotBeforeTick) return;
  const target = firstOwnedTile(me);
  const hostile = runner.game
    .allPlayers()
    .find(
      (player) =>
        player.isAlive() && !playersShareSide(me, player) && player.type() !== PlayerType.Bot,
    );
  if (target == null || !hostile) return;
  const coastTile = [...hostile.tiles()].find(
    (tile) =>
      runner.game.isLand(tile) &&
      runner.game.neighbors(tile).some((next) => runner.game.isWater(next)),
  );
  if (coastTile === undefined) return;
  hostile.buildUnit(UnitType.Port, coastTile, {});
  const troops = Math.max(1, Math.min(100, hostile.troops()));
  runner.game.addExecution(new TransportShipExecution(hostile, target, troops));
  hostileTransportInjected = true;
  console.warn(
    JSON.stringify({
      phase: "hostile-transport-injected",
      tick: runner.game.ticks(),
      target,
      coastTile,
      troops,
    }),
  );
};
type Unit = import("../../openfront-engine/src/core/game/Game.ts").Unit;

let ownArsenalPhase: "idle" | "upgrading" | "done" = "idle";
const ownArsenalSilos: Unit[] = [];
const injectOwnArsenalIfReady = () => {
  if (ownArsenalPhase === "done" || !injectOwnSiloNetwork || !me?.isAlive()) return;
  if (ownArsenalPhase === "idle") {
    if (runner.game.inSpawnPhase()) return;
    const tiles = [...me.tiles()].filter((tile) => runner.game.isLand(tile)).slice(0, 3);
    if (tiles.length < 3) return;
    me.addGold(500_000_000n);
    for (const tile of tiles) {
      const silo = me.buildUnit(UnitType.MissileSilo, tile, {});
      if (!silo) continue;
      ownArsenalSilos.push(silo);
      runner.game.addExecution(new MissileSiloExecution(silo));
    }
    ownArsenalPhase = ownArsenalSilos.length > 0 ? "upgrading" : "done";
    return;
  }
  let blocked = 0;
  for (const silo of ownArsenalSilos) {
    const currentLevel = Number(silo.level?.() ?? 1);
    if (silo.isUnderConstruction() || currentLevel >= ownSiloLevel) continue;
    if (me.gold() < 100_000_000n) me.addGold(500_000_000n);
    if (!me.upgradeUnit(silo)) {
      blocked += 1;
    }
  }
  if (blocked === 0) {
    ownArsenalPhase = "done";
    console.warn(
      JSON.stringify({
        phase: "own-arsenal-injected",
        tick: runner.game.ticks(),
        levels: ownArsenalSilos.map((silo) => Number(silo.level?.() ?? 0)),
      }),
    );
  }
};

let hostileSamCoverInjected = false;
const injectHostileSamCoverIfReady = () => {
  if (hostileSamCoverInjected || !injectHostileSamCover || !me?.isAlive()) return;
  if (runner.game.isSpawnImmunityActive()) return;
  const hostile = runner.game
    .players()
    .find(
      (player) =>
        player.isAlive() &&
        player.clientID() !== clientID &&
        !playersShareSide(me, player) &&
        player.numTilesOwned() > 0,
    );
  if (!hostile) return;
  const city = hostile
    .units(UnitType.City)
    .find((unit) => unit.isActive() && !unit.isUnderConstruction());
  if (!city) return;
  const cityTile = city.tile();
  const adjacent = [...hostile.tiles()].find(
    (tile) =>
      tile !== cityTile &&
      runner.game.isLand(tile) &&
      runner.game.neighbors(tile).some((next) => next === cityTile),
  );
  if (adjacent === undefined) return;
  hostile.addGold(50_000_000n);
  hostile.buildUnit(UnitType.SAMLauncher, adjacent, {});
  hostileSamCoverInjected = true;
  console.warn(
    JSON.stringify({
      phase: "hostile-sam-cover-injected",
      tick: runner.game.ticks(),
      city: cityTile,
      sam: adjacent,
      owner: hostile.name(),
    }),
  );
};

let hostileSiloNetworkInjected = false;
// Silo-saturated-regime fixture: a ring of hostile L1 silos clustered around
// the hostile's largest city so nuke candidate stacks include silo terms that
// can compete with city stacks. Fixture setup only — launches stay subject to
// the engine's ordinary build/trajectory/SAM rules.
const injectHostileSiloNetworkIfReady = () => {
  if (hostileSiloNetworkInjected || !injectHostileSiloNetwork || !me?.isAlive()) return;
  if (runner.game.isSpawnImmunityActive()) return;
  const hostile = runner.game
    .players()
    .find(
      (player) =>
        player.isAlive() &&
        player.clientID() !== clientID &&
        !playersShareSide(me, player) &&
        player.numTilesOwned() > 0,
    );
  if (!hostile) return;
  const city = hostile
    .units(UnitType.City)
    .find((unit) => unit.isActive() && !unit.isUnderConstruction());
  if (!city) return;
  const cityTile = city.tile();
  const owned = [...hostile.tiles()]
    .filter((tile) => tile !== cityTile && runner.game.isLand(tile))
    .sort(
      (a, b) =>
        runner.game.euclideanDistSquared(a, cityTile) -
        runner.game.euclideanDistSquared(b, cityTile),
    );
  const placed: number[] = [];
  for (const tile of owned) {
    if (placed.length >= hostileSiloNetworkCount) break;
    if (placed.some((p) => runner.game.euclideanDistSquared(p, tile) < 64)) continue;
    placed.push(tile);
  }
  if (placed.length < hostileSiloNetworkCount) return;
  // 3M of silo cost plus headroom — NOT more: oversized fixture gold armed the
  // hostile into a nuke spree that killed the bed's retaliatory-war shape.
  hostile.addGold(10_000_000n);
  for (const tile of placed) {
    const silo = hostile.buildUnit(UnitType.MissileSilo, tile, {});
    runner.game.addExecution(new MissileSiloExecution(silo));
  }
  hostileSiloNetworkInjected = true;
  console.warn(
    JSON.stringify({
      phase: "hostile-silo-network-injected",
      tick: runner.game.ticks(),
      city: cityTile,
      silos: placed,
      owner: hostile.name(),
    }),
  );
};

let hostileMissileInjected = false;
let hostileMissileInjectionTick: number | null = null;
let hostileMissileTargetCityID: number | null = null;
let hostileMissileTargetTile: number | null = null;
let hostileMissileAttacker: string | null = null;
let hostileMissileSource: number | null = null;
let hostileMissileID: number | null = null;
let hostileMissileTargetedBySam = false;
let hostileMissileResolution: "intercepted" | "impact" | null = null;
let hostileMissileResolvedTick: number | null = null;
let hostileMissileSeen = false;
let hostileMissileResolved = false;
const injectHostileAtomIfReady = () => {
  if (hostileMissileInjected || !injectHostileAtom || !me?.isAlive()) return;
  if (runner.game.ticks() < hostileAtomNotBeforeTick) return;
  if (runner.game.isSpawnImmunityActive()) return;
  const targetCity = me
    .units(UnitType.City)
    .find((city) => city.isActive() && !city.isUnderConstruction());
  const target = targetCity?.tile();
  if (target === undefined) return;
  const hostile = runner.game
    .players()
    .find(
      (player) =>
        player.isAlive() &&
        player.clientID() !== clientID &&
        !playersShareSide(me, player) &&
        player.numTilesOwned() > 0,
    );
  if (!hostile) return;
  const source = firstOwnedTile(hostile);
  if (source === null) return;
  // The silo is fixture setup, not an AI shortcut. NukeExecution still
  // performs the engine's ordinary trajectory, launch and SAM rules.
  // Nations do not receive the Human infinite-gold rule. Fund the fixture
  // attacker explicitly or NukeExecution correctly aborts at canBuild() and
  // leaves no threat for the bot's missile-defense policy to observe.
  hostile.addGold(hostileAtomFixtureGold);
  hostile.buildUnit(UnitType.MissileSilo, source, {});
  runner.game.addExecution(new NukeExecution(UnitType.AtomBomb, hostile, target, source));
  hostileMissileInjected = true;
  hostileMissileInjectionTick = runner.game.ticks();
  hostileMissileTargetCityID = targetCity.id();
  hostileMissileTargetTile = target;
  hostileMissileAttacker = hostile.name();
  hostileMissileSource = source;
  console.warn(
    JSON.stringify({
      phase: "hostile-missile-injected",
      tick: hostileMissileInjectionTick,
      attacker: hostile.name(),
      attackerTeam: hostile.team(),
      source,
      target,
      targetOwner: me.name(),
      targetOwnerTeam: me.team(),
    }),
  );
};
const observeHostileMissileFixture = () => {
  if (!hostileMissileInjected || hostileMissileResolved) return;
  const active = runner.game
    .units(UnitType.AtomBomb)
    .find(
      (unit) =>
        unit.owner().name() !== me?.name() && unit.targetTile() === hostileMissileTargetTile,
    );
  if (active) {
    hostileMissileSeen = true;
    hostileMissileID = active.id();
    hostileMissileTargetedBySam ||= inFlightTargetedBySam(active);
    return;
  }
  if (!hostileMissileSeen) return;
  hostileMissileResolved = true;
  hostileMissileResolvedTick = runner.game.ticks();
  const targetSurvived = me
    ?.units(UnitType.City)
    .some((city) => city.id() === hostileMissileTargetCityID);
  hostileMissileResolution = targetSurvived ? "intercepted" : "impact";
  console.warn(
    JSON.stringify({
      phase: "hostile-missile-resolved",
      tick: hostileMissileResolvedTick,
      outcome: hostileMissileResolution,
      missileID: hostileMissileID,
      attacker: hostileMissileAttacker,
      source: hostileMissileSource,
      targetTile: hostileMissileTargetTile,
      targetCityID: hostileMissileTargetCityID,
      targetSurvived,
      targetedBySam: hostileMissileTargetedBySam,
    }),
  );
};
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
  injectOwnPortIfReady();
  injectHostileTransportIfReady();
  injectHostileAtomIfReady();
  injectOwnArsenalIfReady();
  injectHostileSamCoverIfReady();
  injectHostileSiloNetworkIfReady();
  injectRailEconomyIfReady();
  observeRailEconomyFixture();
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
  if (logAttackHotspots) {
    for (const entry of bot.drainAttackHotspotTrace()) {
      console.warn(JSON.stringify({ ...entry, phase: "attack-hotspot-trace" }));
    }
  }
  if (logStructures || logSiloQuotes) {
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
          plannerRefreshStarts: bot.nationBot?.attackBehavior?.earlyGameTribeRefreshStartCount ?? 0,
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
    intents: (hybridFifo
      ? hybridFifo.dispatch(clientID, runner.game.ticks(), intents)
      : intents
    ).map((intent): StampedIntent => ({ ...intent, clientID })),
  };
  runner.addTurn(turn);
  const executionStartedAt = performance.now();
  if (!runner.executeNextTick()) {
    stopReason = "engine_stop";
    break;
  }
  observeHostileMissileFixture();
  // The live client receives each game tick from a worker task, so cooperative
  // `setTimeout(0)` slices run between ticks. A tight async loop otherwise
  // advances only through microtasks and starves those timers until the whole
  // simulation ends, leaving tribe topology and route refreshes permanently
  // pending. Yield one host task per simulated tick while retaining max-speed
  // execution and deterministic game state.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const executionMs = performance.now() - executionStartedAt;
  const currentPlayer = runner.game.playerByClientID(clientID);
  if (currentPlayer && runner.game.ticks() >= 1200 && landLeaderAt120Seconds === null) {
    const landPlayers = runner.game
      .players()
      .filter((player) => player.isAlive() && player.numTilesOwned() > 0)
      .sort((left, right) => right.numTilesOwned() - left.numTilesOwned());
    const leader = landPlayers[0];
    if (leader) {
      const totalLand = Math.max(1, runner.game.numLandTiles() - runner.game.numTilesWithFallout());
      landLeaderAt120Seconds = {
        name: leader.name(),
        type: String(leader.type()),
        tiles: leader.numTilesOwned(),
        share: leader.numTilesOwned() / totalLand,
        isOwn: leader.smallID?.() === currentPlayer.smallID?.(),
      };
    }
  }
  if (currentPlayer && runner.game.ticks() >= 1800 && landLeaderAt180Seconds === null) {
    const landPlayers = runner.game
      .players()
      .filter((player) => player.isAlive() && player.numTilesOwned() > 0)
      .sort((left, right) => right.numTilesOwned() - left.numTilesOwned());
    const leader = landPlayers[0];
    if (leader) {
      const totalLand = Math.max(1, runner.game.numLandTiles() - runner.game.numTilesWithFallout());
      landLeaderAt180Seconds = {
        name: leader.name(),
        type: String(leader.type()),
        tiles: leader.numTilesOwned(),
        share: leader.numTilesOwned() / totalLand,
        isOwn: leader.smallID?.() === currentPlayer.smallID?.(),
        ownTiles: currentPlayer.numTilesOwned(),
        ownRank:
          landPlayers.findIndex((player) => player.smallID?.() === currentPlayer.smallID?.()) + 1,
      };
    }
    // Amended-standard key (user-authorized relaxation 2026-08-22): the
    // 3-minute land-leader requirement is evaluated among NON-NATION players
    // — engine nations are pre-placed with compounding frontier advantage
    // (telemetry-proven geography-bound), while the goal's own naval metrics
    // require those nations to exist. This key reports the best non-nation
    // landholder and our rank among non-nations.
    const nonNationPlayers = landPlayers.filter((player) => player.type?.() !== PlayerType.Nation);
    const nonNationLeader = nonNationPlayers[0];
    if (nonNationLeader) {
      landLeaderNonNationAt180Seconds = {
        name: nonNationLeader.name(),
        type: String(nonNationLeader.type()),
        tiles: nonNationLeader.numTilesOwned(),
        ownTiles: currentPlayer.numTilesOwned(),
        ownRank:
          nonNationPlayers.findIndex((player) => player.smallID?.() === currentPlayer.smallID?.()) +
          1,
        isOwn: nonNationLeader.smallID?.() === currentPlayer.smallID?.(),
      };
    }
  }
  const activeHostileMissile = runner.game
    .units(UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV, UnitType.MIRVWarhead)
    .find((missile) => {
      const owner = missile.owner?.();
      if (!owner || !currentPlayer) return false;
      if (owner.smallID?.() === currentPlayer.smallID?.()) return false;
      return !playersShareSide(currentPlayer, owner);
    });
  if (activeHostileMissile && firstHostileNukeTick === null) {
    firstHostileNukeTick = runner.game.ticks();
  }
  if (logNukes && activeHostileMissile) {
    const missileID = String(activeHostileMissile.id());
    if (!loggedHostileMissileIDs.has(missileID)) {
      loggedHostileMissileIDs.add(missileID);
      let inSamCoverage = false;
      for (const sam of currentPlayer?.units(UnitType.SAMLauncher) ?? []) {
        if (!sam.isActive() || sam.isUnderConstruction()) continue;
        const range = runner.game.config().dynamicSamRange(sam, runner.game.ticks());
        if (
          runner.game.euclideanDistSquared(sam.tile(), activeHostileMissile.targetTile()) <=
          range * range
        ) {
          inSamCoverage = true;
          break;
        }
      }
      console.log(
        JSON.stringify({
          phase: "hostile-nuke-inflight",
          tick: runner.game.ticks(),
          id: missileID,
          type: String(activeHostileMissile.type()),
          owner: activeHostileMissile.owner()?.name?.() ?? "unknown",
          targetTile: activeHostileMissile.targetTile(),
          targetedBySAM: inFlightTargetedBySam(activeHostileMissile),
          inSamCoverage,
        }),
      );
    }
  }
  if (
    currentPlayer &&
    firstReadySamTick === null &&
    currentPlayer
      .units(UnitType.SAMLauncher)
      .some((sam) => sam.isActive() && !sam.isUnderConstruction())
  ) {
    firstReadySamTick = runner.game.ticks();
  }
  // A sea invasion is an enemy boat that actually LANDS: the engine converts
  // a completed transport into an AttackExecution whose source tile is the
  // landing site (core attacks always carry it; land attacks have none).
  // Transports our navy kills mid-crossing never produce that attack, so an
  // interception success is not miscounted as an invasion.
  if (
    currentPlayer &&
    currentPlayer
      .incomingAttacks()
      .some(
        (attack) =>
          !playersShareSide(currentPlayer, attack.attacker()) && attack.sourceTile?.() != null,
      )
  ) {
    seaInvasionObserved = true;
    // Beachhead ledger: record the landing tile; mark it recaptured the tick
    // the invasion source's owner loses it and we (or our team) hold it.
    for (const attack of currentPlayer.incomingAttacks()) {
      if (attack.sourceTile?.() == null) continue;
      if (playersShareSide(currentPlayer, attack.attacker())) continue;
      const landingTile = attack.sourceTile();
      if (!invasionBeachheads.has(landingTile)) {
        invasionBeachheads.set(landingTile, {
          landedTick: runner.game.ticks(),
          recapturedTick: null,
        });
      }
    }
  }
  for (const [tile, record] of invasionBeachheads) {
    if (record.recapturedTick !== null) continue;
    const holder = runner.game.playerBySmallID(runner.game.ownerID(tile));
    if (playersShareSide(currentPlayer, holder)) {
      record.recapturedTick = runner.game.ticks();
    }
  }
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
    const currentSamTiles = new Map(
      (currentPlayer?.units(UnitType.SAMLauncher) ?? []).map((sam) => [
        String(sam.id()),
        sam.tile(),
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
            tile: currentSamTiles.get(samID) ?? null,
            x: currentSamTiles.has(samID) ? runner.game.x(currentSamTiles.get(samID)!) : null,
            y: currentSamTiles.has(samID) ? runner.game.y(currentSamTiles.get(samID)!) : null,
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
    if (rivalPortTimelineEnabled) {
      rivalPortTimeline.push({
        tick: runner.game.ticks(),
        rivals: runner.game
          .allPlayers()
          .filter((rival) => rival.id() !== me?.id())
          .map((rival) => ({
            name: rival.name(),
            gold: Number(rival.gold() ?? 0n),
            portLevels: rival.units(UnitType.Port).map((unit) => unit.level()),
            cityCount: rival.units(UnitType.City).length,
          }))
          .sort((left, right) => right.gold - left.gold)
          .slice(0, 6),
      });
    }
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
        const allSilos = other.units(UnitType.MissileSilo).filter((silo) => silo.isActive());
        const silos = allSilos.filter((silo) => !silo.isUnderConstruction());
        const sams = other
          .units(UnitType.SAMLauncher)
          .filter((sam) => sam.isActive() && !sam.isUnderConstruction());
        return {
          name: other.name(),
          team: other.team(),
          gold: Number(other.gold()),
          siloDetails: allSilos.map((silo) => ({
            id: silo.id(),
            tile: silo.tile(),
            level: silo.level(),
            underConstruction: silo.isUnderConstruction(),
          })),
          siloLevels: silos.map((silo) => silo.level()),
          siloCapacity: silos.reduce((total, silo) => total + Math.max(1, silo.level()), 0),
          samLevels: sams.map((sam) => sam.level()),
        };
      })
      .filter(
        (network) =>
          network.gold >= Number(PREEMPTIVE_SAM_SILO_GOLD) ||
          network.siloDetails.length > 0 ||
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
          // targetedBySAM() dereferences _nukeState!, which only warheads
          // carry — MIRV carriers would throw, so they report null.
          targetedBySam: unit.type() === UnitType.MIRV ? null : unit.targetedBySAM(),
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
        tradeShipsAlive: runner.game.units(UnitType.TradeShip).length,
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
        allies: (player?.allies?.() ?? []).map((ally) =>
          typeof ally.name === "function" ? ally.name() : String(ally),
        ),
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

if (fatalError !== null) {
  bot.finalizeHybridCombatObservation("env_error");
  throw new Error(fatalError);
}
const winner = runner.game.getWinner();
if (winner !== null) stopReason = "winner";
const finalMe = runner.game.playerByClientID(clientID);
const won =
  winner !== null &&
  (winner === finalMe?.team() || (typeof winner !== "string" && winner.clientID() === clientID));
bot.finalizeHybridCombatObservation(stopReason);
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

if (injectHostileAtom && !hostileMissileInjected) {
  console.warn(
    JSON.stringify({
      phase: "hostile-missile-injection-missed",
      tick: runner.game.ticks(),
      reason: "no-active-own-city-or-hostile-territory-after-spawn-immunity",
    }),
  );
}

function goalRequirementsSnapshot() {
  const me = runner.game.playerByClientID(clientID);
  const stats = me ? runner.game.stats().getPlayerStats(me) : null;
  const warshipVeterancy = me
    ? Math.max(
        0,
        ...me
          .units(UnitType.Warship)
          .map((unit) =>
            Number(typeof unit.veterancy === "function" ? unit.veterancy() : (unit.veterancy ?? 0)),
          ),
      )
    : 0;
  const myGoldEarned = me ? (goldEarnedById.get(String(me.id())) ?? 0n) : 0n;
  let bestRivalGoldEarned = 0n;
  let bestRivalName: string | null = null;
  // The legacy bestRival loop includes TEAMMATES — a carried ally can out-earn
  // us on a winning team (the goal's literal text says best among ALL players,
  // so bestEconomy stays teammate-inclusive). Emit the enemy-only view too so
  // rows can be analyzed both ways.
  let bestEnemyRivalGoldEarned = 0n;
  let bestEnemyRivalName: string | null = null;
  for (const player of runner.game.players()) {
    if (player.clientID?.() === clientID) continue;
    const rivalGold = goldEarnedById.get(String(player.id())) ?? 0n;
    if (rivalGold > bestRivalGoldEarned) {
      bestRivalGoldEarned = rivalGold;
      bestRivalName = player.name();
    }
    if (playersShareSide(me, player)) continue;
    if (rivalGold > bestEnemyRivalGoldEarned) {
      bestEnemyRivalGoldEarned = rivalGold;
      bestEnemyRivalName = player.name();
    }
  }
  // Remaining hostile structure value at the end, used by the validator's
  // conquest exception. This is not a historical peak or an opportunity count.
  const enemyStructureValueAtEnd = me
    ? runner.game
        .players()
        .filter((player) => !playersShareSide(me, player) && player.isAlive())
        .reduce(
          (total, player) =>
            total +
            player
              .units(
                UnitType.City,
                UnitType.Port,
                UnitType.Factory,
                UnitType.MissileSilo,
                UnitType.SAMLauncher,
                UnitType.DefensePost,
              )
              .reduce((playerTotal, unit) => {
                const level = Math.max(1, Number(unit.level?.()) || 1);
                switch (unit.type()) {
                  case UnitType.City:
                  case UnitType.Port:
                  case UnitType.Factory:
                    return playerTotal + BigInt(Math.min(1_000_000, 125_000 * 2 ** (level - 1)));
                  case UnitType.MissileSilo:
                    return playerTotal + 1_000_000n;
                  case UnitType.SAMLauncher:
                    return playerTotal + BigInt(Math.min(3_000_000, 1_500_000 * level));
                  default:
                    return playerTotal + BigInt(Math.min(250_000, 50_000 * level));
                }
              }, 0n),
          0n,
        )
    : 0n;
  return {
    // This is a captured-ship count (BOAT_INDEX_CAPTURE), not trade income.
    tradeCaptured: Number(stats?.boats?.trade?.[2] ?? 0n),
    tradeGoldEarned: (me?.tradeGold() ?? 0n).toString(),
    trainGoldEarned: (me?.trainGold() ?? 0n).toString(),
    enemyTransportBoatsDestroyed: Number(stats?.boats?.trans?.[3] ?? 0n),
    ownTransportBoatsLost,
    warshipsDestroyed: Number(stats?.units?.wshp?.[1] ?? 0n),
    maxWarshipVeterancy: Math.max(warshipVeterancy, maxWarshipVeterancySeen),
    nukedStructureGold: nukedStructureGold.toString(),
    enemyStructureValueAtEnd: enemyStructureValueAtEnd.toString(),
    ownStructuresNuked,
    seaInvasionObserved,
    firstHostileNukeTick,
    firstReadySamTick,
    firstOwnStructureLostTick,
    samReadyBeforeFirstHostileNuke:
      firstHostileNukeTick === null ||
      (firstReadySamTick !== null && firstReadySamTick < firstHostileNukeTick),
    landLeaderAt120Seconds,
    landLeaderAt180Seconds,
    landLeaderNonNationAt180Seconds,
    invasionBeachheads: Array.from(invasionBeachheads.entries()).map(([tile, record]) => ({
      tile,
      ...record,
    })),
    allInvasionsRecaptured: invasionBeachholdsAllRecaptured(),
    goldEarned: myGoldEarned.toString(),
    bestRivalGoldEarned: bestRivalGoldEarned.toString(),
    bestRivalName,
    bestEconomy: myGoldEarned > bestRivalGoldEarned,
    bestEnemyRivalGoldEarned: bestEnemyRivalGoldEarned.toString(),
    bestEnemyRivalName,
    bestEconomyAmongEnemies: myGoldEarned > bestEnemyRivalGoldEarned,
  };
}

const invasionBeachholdsAllRecaptured = () =>
  Array.from(invasionBeachheads.values()).every((record) => record.recapturedTick !== null);

// MIRV launches are build intents emitted by structureBehavior; the adapter's
// nuclear snapshot only counts atom/hydrogen (nukeBehavior counters), so the
// harness surfaces the MIRV intent count here — the survey closure recorded
// MIRV as invisible to outcome telemetry (docs/legendary-metric-ceilings.md).
const nuclearStrategySnapshot = bot.getNuclearStrategySnapshot();
const nuclearStrategyTelemetry =
  nuclearStrategySnapshot === null
    ? null
    : {
        ...nuclearStrategySnapshot,
        mirvBuildIntents: cumulativeBuildUnitTypes.get("MIRV") ?? 0,
      };

const finalResult = {
  phase: "result",
  seed,
  won,
  winner: typeof winner === "string" ? winner : (winner?.name() ?? null),
  myTeam: finalMe?.team() ?? null,
  alive: finalMe?.isAlive() ?? false,
  finalAllies: (finalMe?.allies?.() ?? []).map((ally) =>
    typeof ally.name === "function" ? ally.name() : String(ally),
  ),
  finalBotState,
  ticks: runner.game.ticks(),
  stopReason,
  goalRequirements: goalRequirementsSnapshot(),
  spawnLifecycle: bot.getSpawnLifecycleSnapshot(),
  hybridCombat: bot.getHybridCombatSnapshot(),
  hybridEvaluation: bot.getHybridEvaluationSnapshot(),
  hybridTransport: hybridFifo?.snapshot() ?? null,
  nuclearStrategy: nuclearStrategyTelemetry,
  ownNukeDetonations,
  ownAtomDetonations,
  ownHydrogenDetonations,
  ownMirvWarheadDetonations,
  intentBudget: bot.getIntentBudgetSnapshot() ?? undefined,
  intentBudgetViolated:
    process.env.OFH_ASSERT_INTENT_BUDGET === "1" &&
    (bot.getIntentBudgetSnapshot()?.rejected ?? 0) > 0,
  beachheadClearance:
    (bot.harness?.internals?.state as { beachheadClearance?: unknown } | undefined)
      ?.beachheadClearance ?? undefined,
  navalEmergency:
    (bot.harness?.internals?.state as { stats?: { navalEmergency?: unknown } } | undefined)?.stats
      ?.navalEmergency ?? undefined,
  constructionDump:
    process.env.OFH_CONSTRUCTION_DUMP === "1"
      ? ((bot.harness?.internals?.state as { stats?: { constructionDump?: unknown } } | undefined)
          ?.stats?.constructionDump ?? undefined)
      : undefined,
  capStrike: {
    armedHighWater: Number(bot.nationBot?.attackBehavior?.capStrikeArmedHighWater ?? 0),
    attempts: Number(bot.nationBot?.attackBehavior?.capStrikeAttempts ?? 0),
    launches: Number(bot.nationBot?.attackBehavior?.capStrikeLaunches ?? 0),
    lastLaunchTick: Number(bot.nationBot?.attackBehavior?.capStrikeLastLaunchTick ?? 0),
    endgameBypasses: Number(bot.nationBot?.attackBehavior?.capStrikeEndgameBypasses ?? 0),
    noTargetVetoes: Number(bot.nationBot?.attackBehavior?.capStrikeVetoNoTarget ?? 0),
    legalityVetoes: Number(bot.nationBot?.attackBehavior?.capStrikeVetoLegality ?? 0),
  },
  performanceProfile: profileBot ? bot.getPerformanceProfile() : undefined,
  emittedIntents,
  hostileMissileFixture: injectHostileAtom
    ? {
        injected: hostileMissileInjected,
        injectedTick: hostileMissileInjectionTick,
        notBeforeTick: hostileAtomNotBeforeTick,
        missileID: hostileMissileID,
        seen: hostileMissileSeen,
        resolved: hostileMissileResolved,
        resolvedTick: hostileMissileResolvedTick,
        outcome: hostileMissileResolution,
      }
    : undefined,
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
  rivalPortTimeline: rivalPortTimelineEnabled ? rivalPortTimeline : undefined,
};

// Diagnostic-only rival economy snapshot (OFH_RIVAL_DUMP=1). Inert unless
// explicitly requested: income levers should be designed from what rich
// rivals actually build instead of from theory.
if (process.env.OFH_RIVAL_DUMP === "1") {
  const rivalDump = runner.game
    .allPlayers()
    .filter((player) => player.id() !== me?.id())
    .map((player) => ({
      name: player.name(),
      type: String(player.type()),
      alive: player.isAlive(),
      gold: String(player.gold() ?? 0n),
      tiles: player.numTilesOwned(),
      portLevels: player.units(UnitType.Port).map((unit) => unit.level()),
      cityCount: player.units(UnitType.City).length,
      factoryCount: player.units(UnitType.Factory).length,
    }))
    .sort((left, right) => Number(right.gold) - Number(left.gold))
    .slice(0, 8);
  process.stderr.write(
    `${JSON.stringify({
      phase: "rivalDump",
      tick: runner.game.ticks(),
      stopReason,
      rivals: rivalDump,
    })}\n`,
  );
}

// The engine may retain timers or sockets after a terminal game result.  The
// batch contract is a completed result line followed by child termination, so
// flush that line before exiting rather than relying on the event loop to
// become idle.
process.stderr.write(`${JSON.stringify(finalResult)}\n`, () => {
  const hostileMissileFixtureComplete =
    !injectHostileAtom || (hostileMissileInjected && hostileMissileSeen && hostileMissileResolved);
  const intentBudgetClean =
    process.env.OFH_ASSERT_INTENT_BUDGET !== "1" ||
    (bot.getIntentBudgetSnapshot()?.rejected ?? 0) === 0;
  process.exit(won && hostileMissileFixtureComplete && intentBudgetClean ? 0 : 2);
});
