import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import {
  placeName,
  placeSpawnName,
} from "../../openfront-engine/src/client/hud/NameBoxCalculator.ts";
import { getSpawnTiles } from "../../openfront-engine/src/core/execution/Util.ts";
import { GameUpdateType } from "../../openfront-engine/src/core/game/GameUpdates.ts";
import { unpackMotionPlans } from "../../openfront-engine/src/core/game/MotionPlans.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH =
  process.env.OFH_BUNDLE_PATH ?? path.resolve(__dirname, "../../openfront-helper.user.js");
const STORAGE_KEY = "openfront-helper-autobot-v1";
// Static simulation-only diagnostic switch.  The shipped userscript never reads
// this environment variable.
const AUTO_BUILD_ENABLED = process.env.OFH_AUTOBUILD !== "0";

export function playersShareSide(player, other) {
  return Boolean(
    player &&
    other?.isPlayer() &&
    (player.smallID() === other.smallID() || player.isOnSameTeam(other)),
  );
}

let loadedHarness = null;
let bundledHarnessSource = null;
let bundledHarnessScript = null;
const opponentProfile = new Map();
const runnerTickCaches = new WeakMap();
const runnerPlayerAdapterCaches = new WeakMap();
const pagePlayerTargets = new WeakMap();
const boundMethodProxyCache = new WeakMap();
const boundMethodCache = new WeakMap();

if (process.env.BLITZBOT_PROFILE_OPPONENT === "1") {
  process.once("exit", () => {
    const rows = Array.from(opponentProfile.entries())
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([name, value]) => `${name}: count=${value.count} ms=${value.ms.toFixed(1)}`)
      .join("\n");
    if (rows) process.stderr.write(`BLITZBOT_PROFILE_OPPONENT\n${rows}\n`);
  });
}

export function createBundledOpponentHarness(options = {}) {
  bundledHarnessSource ??= createBundledHarnessSource();
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://openfront.io/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => undefined;
  if (typeof options.random === "function") {
    window.Math.random = options.random;
  }
  const clock = { now: 0 };
  window.__OFH_realOpponentClock = clock;
  // Profiling needs elapsed wall time, while strategic cooperative slices use
  // the deterministic clock below. Keep the two clocks independent so enabling
  // diagnostics cannot alter which strategy slices fit before their deadline.
  const profileStartedAt = performance.now();
  window.__OFH_profileNow = () => performance.now() - profileStartedAt;
  // Policy comparisons must not let host load decide how many topology/BFS
  // batches finish before a deadline. Advance a synthetic deadline clock by a
  // fixed quantum on every probe: work remains bounded, while identical seeds
  // consume identical slices on fast and slow runs.
  let deterministicDeadlineMs = 0;
  window.__OFH_deadlineNow = () => {
    deterministicDeadlineMs += 0.25;
    return deterministicDeadlineMs;
  };
  window.Date.now = () => clock.now;
  Object.defineProperty(window.performance, "now", {
    configurable: true,
    value: () => clock.now,
  });
  const disabledHardMode = {
    enabled: false,
    difficulty: "Legendary",
    winFixes: true,
    tickMs: 1,
    features: {
      spawn: true,
      expand: true,
      build: AUTO_BUILD_ENABLED,
      boat: true,
      nuke: true,
      warship: true,
      alliance: true,
      donate: true,
      betray: true,
    },
    buildStructures: {
      City: AUTO_BUILD_ENABLED,
      Factory: AUTO_BUILD_ENABLED,
      Port: AUTO_BUILD_ENABLED,
      "Defense Post": AUTO_BUILD_ENABLED,
      "SAM Launcher": AUTO_BUILD_ENABLED,
      "Missile Silo": AUTO_BUILD_ENABLED,
    },
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(disabledHardMode));
  const quietConsole = {
    log() {},
    info() {},
    debug() {},
    warn() {},
    error: (...args) => {
      if (process.env.BLITZBOT_VERBOSE_BUNDLE === "1") console.error(...args);
    },
  };
  window.console = process.env.BLITZBOT_VERBOSE_BUNDLE === "1" ? console : quietConsole;
  window.setInterval = () => 0;
  window.clearInterval = () => undefined;
  const cooperativeTimers = new Set();
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (Number(ms) > 0) return globalThis.setTimeout(fn, ms, ...args);
    // Match the runner's task boundary instead of waiting for a wall-clock
    // millisecond, which lets fast runs advance extra ticks between slices.
    const timer = globalThis.setImmediate(() => {
      cooperativeTimers.delete(timer);
      fn(...args);
    });
    cooperativeTimers.add(timer);
    return timer;
  };
  window.clearTimeout = (id) => {
    if (cooperativeTimers.delete(id)) globalThis.clearImmediate(id);
    else globalThis.clearTimeout(id);
  };

  const current = { buildMenu: null, eventsDisplay: { events: [] } };
  const realQuerySelector = window.document.querySelector.bind(window.document);
  window.document.querySelector = (selector) => {
    if (selector === "build-menu") return current.buildMenu;
    if (selector === "main-radial-menu") {
      return current.buildMenu
        ? { buildMenu: current.buildMenu, eventBus: current.buildMenu.eventBus }
        : null;
    }
    if (selector === "control-panel" || selector === "leader-board") {
      return current.buildMenu ? { eventBus: current.buildMenu.eventBus } : null;
    }
    if (selector === "events-display" || selector === "actionable-events") {
      return current.eventsDisplay;
    }
    return realQuerySelector(selector);
  };

  const context = dom.getInternalVMContext();
  // Bridge sim env flags into the page realm: engine gates read localStorage
  // (available in both browser and JSDOM), never process.env.
  // The lane default is ON in the bot; the env flag remains an explicit
  // harness override so dark A/B baselines stay reproducible.
  if (process.env.OFH_BEACHHEAD_LANE === "1") {
    window.localStorage.setItem("ofh:beachheadLane", "1");
  }
  if (process.env.OFH_BEACHHEAD_LANE === "0") {
    window.localStorage.setItem("ofh:beachheadLane", "0");
  }
  // The harness deliberately executes the locally built userscript inside an
  // isolated JSDOM VM. No network or untrusted source is evaluated here.
  // eslint-disable-next-line sonarjs/code-eval
  bundledHarnessScript ??= new vm.Script(bundledHarnessSource, { filename: BUNDLE_PATH });
  bundledHarnessScript.runInContext(context);
  const internals = window.__OFH_realOpponentHarness;
  if (!internals) {
    throw new Error("Bundled opponent internals were not exposed");
  }
  return { window, current, internals };
}

function createBundledHarnessSource() {
  const rawSource = fs.readFileSync(BUNDLE_PATH, "utf8");
  const exportNeedle = "window.__OFH_autobot=";
  let exportIndex = rawSource.lastIndexOf(exportNeedle);
  if (exportIndex < 0) exportIndex = rawSource.lastIndexOf("window.__OFH_autobot =");
  if (exportIndex < 0) {
    throw new Error("Cannot expose bundled opponent internals: export marker missing");
  }

  const exportHook = `
window.__OFH_realOpponentHarness = {
  NationBot,
  AllianceBehavior,
  StructureBehavior,
  WarshipBehavior,
  createGameApi,
  state,
  DEFAULTS,
  UNIT,
  discoverCtors,
  getEventBus,
  getBuildMenu,
  getIntentRateLimitSnapshot,
  beginAutoBotProfileTick,
  finishAutoBotProfileTick,
  getAutoBotProfileSnapshot
  ,computeSpawnTopSpotsForBot
  ,collectExactSpawnPoints
  ,getTeamSpawnRegion
  ,isPointInsideTeamSpawnRegion
  ,getSpawnCandidateConnectivitySnapshot
};
`;
  return rawSource.slice(0, exportIndex) + exportHook + rawSource.slice(exportIndex);
}

export function loadBundledOpponentHarness() {
  loadedHarness ??= createBundledOpponentHarness();
  return loadedHarness;
}

export function createMaxDifficultyOpponent(options = {}) {
  return new BundledOpponentBot({
    difficulty: "Legendary",
    winFixes: true,
    tickMs: 1,
    responsiveness: "maximum",
    features: {
      spawn: true,
      expand: true,
      build: AUTO_BUILD_ENABLED,
      boat: true,
      nuke: true,
      warship: true,
      alliance: true,
      donate: true,
      betray: true,
    },
    buildStructures: {
      City: AUTO_BUILD_ENABLED,
      Factory: AUTO_BUILD_ENABLED,
      Port: AUTO_BUILD_ENABLED,
      "Defense Post": AUTO_BUILD_ENABLED,
      "SAM Launcher": AUTO_BUILD_ENABLED,
      "Missile Silo": AUTO_BUILD_ENABLED,
    },
    ...options,
  });
}

function parseSpawnCoordinates(selectedKey) {
  if (typeof selectedKey !== "string") return null;
  const [xRaw, yRaw] = selectedKey.split(",");
  const x = Number(xRaw);
  const y = Number(yRaw);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function serializeTeamSpawnRegion(teamRegion) {
  if (teamRegion?.polygon) {
    return {
      kind: "polygon",
      polygon: teamRegion.polygon.map(({ x, y }) => ({ x, y })),
      corridor: null,
    };
  }
  if (teamRegion?.corridor) {
    return {
      kind: "corridor",
      polygon: [],
      corridor: {
        start: teamRegion.corridor.start,
        end: teamRegion.corridor.end,
        halfWidth: teamRegion.corridor.halfWidth,
      },
    };
  }
  return { kind: "none", polygon: [], corridor: null };
}

function assignedSpawnArea(pageGame, player) {
  const team = player?.team?.() ?? null;
  const gameSource = pageGame?.__src ?? pageGame;
  if (team === null || typeof gameSource?.teamSpawnArea !== "function") return null;
  return gameSource.teamSpawnArea(team) ?? null;
}

function pointInsideAssignedSpawnArea(point, area) {
  if (!point || !area) return null;
  return (
    point.x >= area.x &&
    point.x < area.x + area.width &&
    point.y >= area.y &&
    point.y < area.y + area.height
  );
}

function serializeAssignedSpawnArea(area) {
  if (!area) return null;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

function createSpawnGeometryCertificate(internals, pageGame, selectedKey) {
  const player = pageGame.myPlayer();
  const spawnPoints = internals.collectExactSpawnPoints?.(pageGame, player);
  const teamRegion = internals.getTeamSpawnRegion?.(pageGame, player);
  const selected = parseSpawnCoordinates(selectedKey);
  const assignedArea = assignedSpawnArea(pageGame, player);
  let selectedInsideTeamRegion = null;
  if (selected && teamRegion) {
    selectedInsideTeamRegion =
      internals.isPointInsideTeamSpawnRegion?.(selected.x, selected.y, teamRegion) === true;
  }
  return {
    teamAnchors: Array.isArray(spawnPoints?.teamSpawns)
      ? spawnPoints.teamSpawns.map(({ x, y }) => ({ x, y }))
      : [],
    teamRegion: serializeTeamSpawnRegion(teamRegion),
    selectedInsideTeamRegion,
    assignedArea: serializeAssignedSpawnArea(assignedArea),
    selectedInsideAssignedArea: pointInsideAssignedSpawnArea(selected, assignedArea),
    connectivity: internals.getSpawnCandidateConnectivitySnapshot?.() ?? null,
  };
}

export class BundledOpponentBot {
  constructor(options = {}) {
    this.name = options.name ?? "OpponentToBeat";
    this.id = options.id ?? "Opponent";
    this.clientID = options.clientID ?? "opponent-client";
    this.difficulty = "Legendary";
    this.winFixes = options.winFixes ?? true;
    this.tickMs = options.tickMs ?? 1;
    this.responsiveness = options.responsiveness ?? "maximum";
    this.performanceProfiling = options.performanceProfiling === true;
    this.features = { ...(options.features ?? {}) };
    this.buildStructures = { ...(options.buildStructures ?? {}) };
    this.intentBuffer = [];
    this.navalTrace = [];
    this.structureTrace = [];
    this.spawnTrace = [];
    this.attackHotspotTrace = [];
    this.api = null;
    this.pageGame = null;
    this.nationBot = null;
    this.motionPlans = new Map();
    this.harness = options.harness ?? createBundledOpponentHarness();
  }

  attach({ runner, clientID = this.clientID, gameID = "openfront-real-game" }) {
    this.buildMenu = null;
    this.runner = runner;
    this.game = runner.game;
    this.clientID = clientID;
    this.gameID = gameID;
    this.pageGame = createPageGameAdapter(this.game, runner, this.clientID, this.motionPlans);
    const { internals } = this.harness;
    this.api = internals.createGameApi(this.pageGame);
    this.nationBot = new internals.NationBot(this.api.game, {
      gameId: this.gameID,
      playerId: this.clientID,
    });
    if (process.env.OFH_LOG_NAVAL === "1") this.enableNavalTrace();
    if (process.env.OFH_CONSTRUCTION_DUMP === "1") this.enableConstructionDump();
    if (process.env.OFH_LOG_STRUCTURES === "1") this.enableStructureTrace();
    if (process.env.OFH_LOG_SPAWN === "1") this.enableSpawnTrace();
    if (process.env.OFH_LOG_ATTACK_HOTSPOTS === "1") this.enableAttackHotspotTrace();
    if (process.env.OFH_LOG_NUKES === "1") this.enableNukeTrace();
  }

  applyGameUpdate(update) {
    const records = update.packedMotionPlans ? unpackMotionPlans(update.packedMotionPlans) : [];
    for (const record of records) {
      if (record.kind !== "grid" || record.ticksPerStep < 1 || record.path.length < 1) continue;
      const existing = this.motionPlans.get(record.unitId);
      if (existing && record.planId <= existing.planId) continue;
      this.motionPlans.set(record.unitId, record);
    }
    for (const unit of update.updates?.[GameUpdateType.Unit] ?? []) {
      if (!unit.isActive) this.motionPlans.delete(unit.id);
    }
    for (const [id, plan] of this.motionPlans) {
      if (update.tick > plan.startTick + (plan.path.length - 1) * plan.ticksPerStep) {
        this.motionPlans.delete(id);
      }
    }
  }

  enableNukeTrace() {
    const behavior = this.nationBot?.nukeBehavior;
    if (!behavior || behavior.__ofhNukeTraceEnabled === true) return;
    behavior.__ofhNukeTraceEnabled = true;
    const originalMaybe = behavior.maybeSendNuke;
    if (typeof originalMaybe !== "function") return;
    let lastTarget = null;
    let lastCandidates = [];
    let lastValueGate = null;
    const originalSendNuke = behavior.sendNuke;
    if (typeof originalSendNuke === "function") {
      behavior.sendNuke = async (tile, type, target, waitTicks = 0, salvo = null) => {
        const owner = behavior.game.owner?.(tile);
        const incoming = behavior.attackBehavior?.findIncomingAttackPlayer?.();
        const fired = await originalSendNuke.call(
          behavior,
          tile,
          type,
          target,
          waitTicks,
          salvo,
        );
        this.structureTrace.push({
          kind: "nuke-aim",
          tick: this.game.ticks(),
          sourceID: behavior.player?.smallID?.() ?? null,
          sourceName: behavior.player?.name?.() ?? null,
          sourceTroops: Number(behavior.player?.troops?.() ?? 0),
          sourceTiles: Number(behavior.player?.numTilesOwned?.() ?? 0),
          incomingID: incoming?.smallID?.() ?? null,
          incomingName: incoming?.name?.() ?? null,
          tile,
          type,
          waitTicks,
          salvoID: salvo?.salvoId ?? null,
          fired,
          targetID: target?.smallID?.() ?? null,
          targetName: target?.name?.() ?? null,
          targetTroops: Number(target?.troops?.() ?? 0),
          targetTiles: Number(target?.numTilesOwned?.() ?? 0),
          tileOwnerID: owner?.smallID?.() ?? null,
          tileOwnerName: owner?.name?.() ?? null,
          tileOwnerTiles: Number(owner?.numTilesOwned?.() ?? 0),
          targetSamLevels: (target?.units?.("SAM Launcher") ?? []).reduce(
            (sum, sam) => sum + Number(sam?.level?.() ?? 0),
            0,
          ),
          candidates: lastCandidates.slice(0, 3).map(({ tile: candidateTile, value }) => ({
            tile: candidateTile,
            value,
          })),
        });
        return fired;
      };
    }
    const originalSelect = behavior.selectAffordableNuke;
    behavior.selectAffordableNuke = async (...args) => {
      const selected = await originalSelect.apply(behavior, args);
      this.structureTrace.push({
        kind: "nuke-selection",
        tick: this.game.ticks(),
        type: selected?.type ?? null,
        gold: Number(behavior.player.gold()),
        cost: selected ? Number(selected.cost) : null,
      });
      return selected;
    };

    const originalFindTarget = behavior.findBestNukeTarget;
    if (typeof originalFindTarget === "function") {
      behavior.findBestNukeTarget = (...args) => {
        const target = originalFindTarget.apply(behavior, args);
        lastTarget = target;
        return target;
      };
    }
    const originalCollect = behavior.collectNukeCandidates;
    if (typeof originalCollect === "function") {
      behavior.collectNukeCandidates = async (...args) => {
        const candidates = await originalCollect.apply(behavior, args);
        lastCandidates = candidates;
        return candidates;
      };
    }
    const originalValueGate = behavior.nukeHasPositiveExpectedValue;
    if (typeof originalValueGate === "function") {
      behavior.nukeHasPositiveExpectedValue = async (...args) => {
        const value = await originalValueGate.apply(behavior, args);
        lastValueGate = value;
        return value;
      };
    }
    behavior.maybeSendNuke = async (...args) => {
      lastTarget = null;
      lastCandidates = [];
      lastValueGate = null;
      const beforeAtoms = Number(behavior.atomBombsLaunched || 0);
      const beforeHydro = Number(behavior.hydrogenBombsLaunched || 0);
      const result = await originalMaybe.apply(behavior, args);
      this.recordNukeDecisionTrace({
        behavior,
        beforeAtoms,
        beforeHydro,
        candidates: lastCandidates,
        target: lastTarget,
        valueGate: lastValueGate,
      });
      return result;
    };
    const originalSamPlan = behavior.createSamOverwhelmPlan;
    if (typeof originalSamPlan === "function") {
      behavior.createSamOverwhelmPlan = (...args) => {
        const plan = originalSamPlan.apply(behavior, args);
        this.structureTrace.push({
          kind: "sam-plan",
          tick: this.game.ticks(),
          targetSamId: plan.targetSamId,
          aimTile: plan.targetTile,
          coveringSamLevels: plan.coveringSamLevels,
          totalBombs: plan.totalBombs,
          capacityMissing: plan.capacityMissing,
          windowBombs: plan.window?.length ?? 0,
        });
        return plan;
      };
    }
    const originalSamSalvo = behavior.fireSamSalvo;
    if (typeof originalSamSalvo === "function") {
      behavior.fireSamSalvo = async (...args) => {
        const fired = await originalSamSalvo.apply(behavior, args);
        this.structureTrace.push({
          kind: "sam-salvo",
          tick: this.game.ticks(),
          fired,
          pending: Number(behavior._pendingNukeLaunches?.length || 0),
        });
        return fired;
      };
    }
  }

  recordNukeDecisionTrace({ behavior, beforeAtoms, beforeHydro, candidates, target, valueGate }) {
    this.structureTrace.push(
      this.nukeDecisionTraceRecord({
        behavior,
        beforeAtoms,
        beforeHydro,
        candidates,
        target,
        valueGate,
      }),
    );
  }

  nukeDecisionTraceRecord({ behavior, beforeAtoms, beforeHydro, candidates, target, valueGate }) {
    return {
      kind: "nuke-decision",
      tick: this.game.ticks(),
      ...this.nukeDecisionLaunchState(behavior, beforeAtoms, beforeHydro),
      gold: Number(behavior.player?.gold?.() || 0n),
      silos: (behavior.player?.units?.("Missile Silo") || []).length,
      targetID: target?.smallID?.() ?? null,
      candidateCount: candidates.length,
      positiveCandidates: candidates.filter((candidate) => candidate.value > 0).length,
      bestCandidateValue: candidates[0]?.value ?? null,
      valueGate,
    };
  }

  nukeDecisionLaunchState(behavior, beforeAtoms, beforeHydro) {
    return {
      atomBombsBefore: beforeAtoms,
      hydrogenBombsBefore: beforeHydro,
      atomBombsAfter: Number(behavior.atomBombsLaunched || 0),
      hydrogenBombsAfter: Number(behavior.hydrogenBombsLaunched || 0),
      pending: Number(behavior._pendingNukeLaunches?.length || 0),
    };
  }

  enableAttackHotspotTrace() {
    const behavior = this.nationBot?.attackBehavior;
    if (!behavior || behavior.__ofhAttackHotspotTraceEnabled === true) return;
    behavior.__ofhAttackHotspotTraceEnabled = true;
    for (const name of [
      "attackBestTarget",
      "attackBots",
      "assistAllies",
      "maybeBetrayAndAttack",
      "findNearestIslandEnemy",
      "sendAttack",
    ]) {
      const original = behavior[name];
      if (typeof original !== "function") continue;
      behavior[name] = async (...args) => {
        const startedAt = performance.now();
        const result = await original.apply(behavior, args);
        const ms = performance.now() - startedAt;
        if (ms >= 15) {
          this.attackHotspotTrace.push({
            kind: "attack-hotspot",
            tick: this.game.ticks(),
            name,
            ms,
          });
        }
        return result;
      };
    }
    for (const name of [
      "findIncomingAttackPlayer",
      "findTraitor",
      "findVictim",
      "findVeryWeakEnemy",
      "isBorderingNukedTerritory",
      "hasNeighboringBotWithStructures",
      "hasNeedyTeamDonationTarget",
    ]) {
      const original = behavior[name];
      if (typeof original !== "function") continue;
      behavior[name] = (...args) => {
        const startedAt = performance.now();
        const result = original.apply(behavior, args);
        const ms = performance.now() - startedAt;
        if (ms >= 5) {
          this.attackHotspotTrace.push({
            kind: "attack-hotspot",
            tick: this.game.ticks(),
            name,
            ms,
          });
        }
        return result;
      };
    }
  }

  drainAttackHotspotTrace() {
    return this.attackHotspotTrace.splice(0);
  }

  enableSpawnTrace() {
    const nationBot = this.nationBot;
    if (!nationBot || nationBot.__ofhSpawnTraceEnabled === true) return;
    nationBot.__ofhSpawnTraceEnabled = true;
    const originalHandleSpawnTick = nationBot.handleSpawnTick;
    if (typeof originalHandleSpawnTick === "function") {
      nationBot.handleSpawnTick = (...args) => {
        const player = this.pageGame.myPlayer();
        const result = originalHandleSpawnTick.apply(nationBot, args);
        this.spawnTrace.push({
          kind: "spawn-gate",
          tick: this.game.ticks(),
          handled: result === true,
          inSpawnPhase: this.game.inSpawnPhase() === true,
          playerIsPlayer: player?.isPlayer?.() === true,
          hasSpawned: player?.hasSpawned?.() === true,
          spawnExecAdded: nationBot.spawnExecAdded === true,
          spawnEnabled: nationBot.feat?.("spawn") === true,
          intentRateLimit: this.harness.internals.getIntentRateLimitSnapshot?.() ?? null,
        });
        return result;
      };
    }
    const originalHandleOpeningExpansion = nationBot.handleOpeningExpansion;
    if (typeof originalHandleOpeningExpansion === "function") {
      nationBot.handleOpeningExpansion = async (...args) => {
        const attackBehavior = nationBot.attackBehavior;
        const before = {
          landBurst: nationBot.openingLandBurstPending === true,
          followUp: nationBot.openingExpansionFollowUpPending === true,
          remaining: attackBehavior?.getRemainingTerraNulliusOpeningCommitment?.() ?? null,
          attackable: attackBehavior?.canForceAttackTarget?.(nationBot.mg.terraNullius()) === true,
          pending: attackBehavior?.getPendingTerraNulliusAttackTroops?.() ?? null,
        };
        const handled = await originalHandleOpeningExpansion.apply(nationBot, args);
        this.spawnTrace.push({
          kind: "opening-expansion-gate",
          tick: this.game.ticks(),
          handled: handled === true,
          before,
          followUpAfter: nationBot.openingExpansionFollowUpPending === true,
        });
        return handled;
      };
    }
    const originalCurrentSpawnTopKey = nationBot.currentSpawnTopKey;
    if (typeof originalCurrentSpawnTopKey === "function") {
      nationBot.currentSpawnTopKey = (...args) => {
        const selectedKey = originalCurrentSpawnTopKey.apply(nationBot, args);
        const geometry = createSpawnGeometryCertificate(
          this.harness.internals,
          this.pageGame,
          selectedKey,
        );
        const topSpots = this.harness.internals.computeSpawnTopSpotsForBot?.(
          this.pageGame,
          this.pageGame.myPlayer(),
          { initial: true },
        );
        this.spawnTrace.push({
          kind: "spawn-ranking",
          tick: this.game.ticks(),
          selectedKey,
          ...geometry,
          topSpots: Array.isArray(topSpots) ? topSpots.slice(0, 5) : [],
        });
        return selectedKey;
      };
    }
    const originalPickSpawnCenter = nationBot.pickSpawnCenter;
    if (typeof originalPickSpawnCenter !== "function") return;
    nationBot.pickSpawnCenter = (...args) => {
      const ownTeam = this.pageGame.myPlayer()?.team?.() ?? null;
      const players = this.pageGame
        .players()
        .filter((player) => {
          const type = player.type?.();
          return type === "HUMAN" || type === "NATION" || player.team?.() === ownTeam;
        })
        .map((player) => {
          const location = player.nameLocation?.() ?? player.center?.();
          return {
            name: player.name?.() ?? null,
            type: player.type?.() ?? null,
            team: player.team?.() ?? null,
            hasSpawned: player.hasSpawned?.() === true,
            x: location?.x ?? null,
            y: location?.y ?? null,
          };
        });
      const tile = originalPickSpawnCenter.apply(nationBot, args);
      this.spawnTrace.push({
        tick: this.game.ticks(),
        tile,
        x: tile == null ? null : this.game.x(tile),
        y: tile == null ? null : this.game.y(tile),
        players,
      });
      return tile;
    };
  }

  drainSpawnTrace() {
    return this.spawnTrace.splice(0);
  }

  // Pre-creates the bot-side ring buffer once per attach. The bot appends
  // records only while this array exists, so the dump is fully inert in
  // normal runs and in the browser bundle.
  enableConstructionDump() {
    const harnessState = this.harness.internals.state;
    if (harnessState?.stats && !harnessState.stats.constructionDump) {
      harnessState.stats.constructionDump = [];
    }
  }

  enableNavalTrace() {
    const adapter = this;
    const prototype = this.harness.internals.WarshipBehavior?.prototype;
    if (!prototype || prototype.__headlessNavalTraceEnabled) return;
    prototype.__headlessNavalTraceEnabled = true;
    const originalMove = prototype.moveWarship;
    prototype.moveWarship = (warship, tile) => {
      this.navalTrace.push({
        phase: "move",
        tick: this.game.ticks(),
        shipId: warship.id(),
        tile,
        caller: new Error().stack?.split("\n")[2]?.trim() ?? "unknown",
      });
      return originalMove.call(this.nationBot.warshipBehavior, warship, tile);
    };
    const originalAssign = prototype.assignNavalInterceptors;
    prototype.assignNavalInterceptors = (plan, warships, state) => {
      this.navalTrace.push({
        phase: "assignment-plan",
        tick: this.game.ticks(),
        assignments: plan.assignments.map((assignment) => ({ ...assignment })),
        retained: Array.from(state.invasionAssignments.entries()),
      });
      return originalAssign.call(this.nationBot.warshipBehavior, plan, warships, state);
    };
    const originalMaybeSpawnWarship = prototype.maybeSpawnWarship;
    if (typeof originalMaybeSpawnWarship === "function") {
      prototype.maybeSpawnWarship = async function () {
        const event = adapter.warshipBuildTraceSnapshot(this);
        this.__ofhHeadlessWarshipTrace = event;
        const originalChance = this.random?.chance;
        if (typeof originalChance === "function") {
          this.random.chance = function (odds) {
            const result = originalChance.call(this, odds);
            if (odds === 2 && event.warshipRoll === undefined) event.warshipRoll = result;
            return result;
          };
        }
        try {
          const emitted = await originalMaybeSpawnWarship.call(this);
          Object.assign(event, { emitted });
          return emitted;
        } finally {
          if (typeof originalChance === "function") this.random.chance = originalChance;
          this.__ofhHeadlessWarshipTrace = null;
          adapter.navalTrace.push(event);
        }
      };
    }
    const originalGetInitialWarshipPort = prototype.getInitialWarshipPort;
    if (typeof originalGetInitialWarshipPort === "function") {
      prototype.getInitialWarshipPort = function () {
        const port = originalGetInitialWarshipPort.call(this);
        if (this.__ofhHeadlessWarshipTrace) {
          this.__ofhHeadlessWarshipTrace.port = port?.tile?.() ?? null;
        }
        return port;
      };
    }
    const originalWarshipSpawnTile = prototype.warshipSpawnTile;
    if (typeof originalWarshipSpawnTile === "function") {
      prototype.warshipSpawnTile = function (...args) {
        const tile = originalWarshipSpawnTile.apply(this, args);
        if (this.__ofhHeadlessWarshipTrace) this.__ofhHeadlessWarshipTrace.tile = tile;
        return tile;
      };
    }
    const originalBuildableWarship = prototype.buildableWarship;
    if (typeof originalBuildableWarship === "function") {
      prototype.buildableWarship = async function (...args) {
        const buildable = await originalBuildableWarship.apply(this, args);
        if (this.__ofhHeadlessWarshipTrace) {
          this.__ofhHeadlessWarshipTrace.buildable = buildable?.canBuild ?? null;
        }
        return buildable;
      };
    }
    const originalTryEmitWarshipBuild = prototype.tryEmitWarshipBuild;
    if (typeof originalTryEmitWarshipBuild === "function") {
      prototype.tryEmitWarshipBuild = async function (...args) {
        const emitted = await originalTryEmitWarshipBuild.apply(this, args);
        if (this.__ofhHeadlessWarshipTrace) {
          this.__ofhHeadlessWarshipTrace.menuEmitted = emitted;
        }
        return emitted;
      };
    }
    this.enableCommerceRaidTrace(prototype);
  }

  enableCommerceRaidTrace(prototype) {
    const adapter = this;
    const originalAnchors = prototype.commerceRaidAnchors;
    const originalStationed = prototype.countRaidStationedShips;
    const originalIdle = prototype.collectIdleRaidShips;
    const originalService = prototype.serviceCommerceRaids;
    if (
      typeof originalAnchors !== "function" ||
      typeof originalStationed !== "function" ||
      typeof originalIdle !== "function" ||
      typeof originalService !== "function"
    )
      return;
    prototype.commerceRaidAnchors = function (...args) {
      const anchors = originalAnchors.apply(this, args);
      this.__ofhCommerceTrace = {
        anchors: Array.isArray(anchors) ? anchors.slice() : [],
      };
      return anchors;
    };
    prototype.countRaidStationedShips = function (...args) {
      const stationed = originalStationed.apply(this, args);
      if (this.__ofhCommerceTrace) {
        this.__ofhCommerceTrace.stationed =
          stationed instanceof Map ? [...stationed.entries()] : [];
      }
      return stationed;
    };
    prototype.collectIdleRaidShips = function (...args) {
      const idle = originalIdle.apply(this, args);
      if (this.__ofhCommerceTrace) {
        this.__ofhCommerceTrace.idle = Array.isArray(idle) ? idle.map((ship) => ship.id()) : [];
      }
      return idle;
    };
    prototype.serviceCommerceRaids = function (...args) {
      const before = adapter.intentBuffer.length;
      this.__ofhCommerceTrace = null;
      const result = originalService.apply(this, args);
      const trace = this.__ofhCommerceTrace ?? {};
      adapter.navalTrace.push({
        phase: "commerce-raid",
        tick: this.game.ticks(),
        anchors: trace.anchors ?? [],
        stationed: trace.stationed ?? [],
        idle: trace.idle ?? [],
        moves: adapter.intentBuffer
          .slice(before)
          .filter((intent) => intent.type === "move_warship")
          .map((intent) => ({ unitIds: intent.unitIds, tile: intent.tile })),
        result: result === true,
      });
      return result;
    };
  }

  warshipBuildTraceSnapshot(behavior) {
    const player = behavior.player;
    const smartState = behavior.ensureSmartState?.();
    const cost = behavior.cost("Warship");
    const maritimeEmergency = behavior.incomingMaritimeInvasionSignal?.()?.active === true;
    return {
      phase: "warship-build",
      tick: behavior.game.ticks(),
      disabled: behavior.game.config().isUnitDisabled("Warship"),
      maritimeEmergency,
      deferFirstSam: behavior.shouldDeferWarshipForFirstSam?.(cost) === true,
      deferOffensive: !maritimeEmergency && behavior.shouldDeferWarshipForDefense?.(cost) === true,
      ...this.warshipBuildTracePlayerSnapshot(player, behavior),
      ...this.warshipBuildTraceStateSnapshot(behavior, smartState),
    };
  }

  warshipBuildTracePlayerSnapshot(player, behavior) {
    if (!player) return { gold: null, cost: null, ports: 0, ships: 0 };
    return {
      gold: player.gold(),
      cost: behavior.cost("Warship"),
      ports: player.units("Port").length,
      ships: player.units("Warship").length,
    };
  }

  warshipBuildTraceStateSnapshot(behavior, smartState) {
    if (!smartState) return { pending: false, sameTick: false };
    return {
      pending: behavior.hasPendingWarshipBuild(smartState) === true,
      sameTick: smartState.lastInvasionBuildTick === behavior.game.ticks(),
    };
  }

  drainNavalTrace() {
    return JSON.parse(
      JSON.stringify(this.navalTrace.splice(0), (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    );
  }

  structureSpawnTraceContext(behavior, type, options) {
    const rawGold = this.pageGame.myPlayer()?.gold?.();
    const eligible = this.structureTraceEligibility(behavior, type, options);
    const structures = behavior.player?.units?.(type) ?? [];
    return {
      gold: rawGold === null || rawGold === undefined ? null : String(rawGold),
      eligible,
      ...this.structureTraceCosts(behavior, type, options, eligible),
      ...this.structureTraceSamContext(behavior, type),
      existing: structures.length,
      underConstruction: structures.some(
        (structure) => structure?.isUnderConstruction?.() === true,
      ),
    };
  }

  structureTraceEligibility(behavior, type, options) {
    if (typeof behavior.structureSpawnEligible !== "function") return null;
    return behavior.structureSpawnEligible(type, options);
  }

  structureTraceCosts(behavior, type, options, eligible) {
    if (eligible !== true) return { perceivedCost: null, availableGold: null };
    const perceivedCost =
      typeof behavior.constructionCostForOptions === "function"
        ? String(behavior.constructionCostForOptions(type, options))
        : null;
    const availableGold =
      typeof behavior.availableGoldAfterReserve === "function"
        ? String(behavior.availableGoldAfterReserve(type))
        : null;
    return { perceivedCost, availableGold };
  }

  structureTraceSamContext(behavior, type) {
    if (type !== "SAM Launcher") {
      return { ownSamCapacity: null, activeMissileZones: null };
    }
    const ownSamCapacity =
      typeof behavior.ownSamCapacity === "function" ? behavior.ownSamCapacity() : null;
    const activeMissileZones =
      typeof behavior.activeHostileMissileImpactZones === "function"
        ? behavior.activeHostileMissileImpactZones().length
        : null;
    return { ownSamCapacity, activeMissileZones };
  }

  traceStructurePlacementProbe(type, buildable) {
    const probe = {
      tick: this.game.ticks(),
      type,
      eligible: buildable !== null && buildable !== undefined,
      tile: buildable?.tile ?? null,
    };
    if (type === "Defense Post") {
      this.structureTrace.push({ kind: "defense-post-probe", ...probe });
    } else {
      this.structureTrace.push({ kind: "placement-probe", ...probe });
    }
  }

  enableStructureTrace() {
    const behavior = this.nationBot?.structureBehavior;
    if (!behavior || behavior.__ofhStructureTraceEnabled === true) return;
    behavior.__ofhStructureTraceEnabled = true;
    this.enableStructureSpawnTrace(behavior);
    this.enableStructurePortTrace(behavior);
    this.enableStructurePlacementTrace(behavior);
    this.enableStructureSamTrace(behavior);
    this.enableStructureUpgradeTrace(behavior);
    this.enableDefensePostTrace(behavior);
    this.enableLandDefenseTrace();
    this.enableLegendaryCandidateTrace(behavior);
  }

  // Candidate-level view of the Legendary planner: logs the generated
  // candidate list and the grouped action order each decision so a missing
  // structure (e.g. a second Port on a lake map) is distinguishable from a
  // present-but-losing one straight from the OFH_LOG_STRUCTURES trace.
  enableLegendaryCandidateTrace(behavior) {
    const originalCandidates = behavior.legendaryConstructionCandidates;
    if (typeof originalCandidates === "function") {
      behavior.legendaryConstructionCandidates = (...args) => {
        const candidates = originalCandidates.apply(behavior, args);
        this.structureTrace.push({
          kind: "legendary-candidates",
          tick: this.game.ticks(),
          candidates: (candidates || []).map((candidate) => ({
            type: candidate?.type ?? null,
            action: candidate?.action ?? "build",
            cost: String(candidate?.cost ?? "0"),
            mandatory: candidate?.mandatory ?? 0,
            safety: candidate?.safety ?? 0,
            strategic: candidate?.strategic ?? 0,
            deficit: candidate?.deficit ?? 0,
          })),
        });
        return candidates;
      };
    }
    const originalGroups = behavior.legendaryConstructionActionGroups;
    if (typeof originalGroups === "function") {
      behavior.legendaryConstructionActionGroups = (...args) => {
        const groups = originalGroups.apply(behavior, args);
        this.structureTrace.push({
          kind: "legendary-action-groups",
          tick: this.game.ticks(),
          groups: (groups || []).map((group) =>
            (group || []).map((candidate) => ({
              type: candidate?.type ?? null,
              shortfall: candidate?.shortfall !== undefined
                ? String(candidate.shortfall)
                : undefined,
            })),
          ),
        });
        return groups;
      };
    }
  }

  enableStructureSpawnTrace(behavior) {
    const originalMaybeSpawnStructure = behavior.maybeSpawnStructure;
    if (typeof originalMaybeSpawnStructure !== "function") return;
    behavior.maybeSpawnStructure = async (type, options) => {
      const tick = this.game.ticks();
      const context = this.structureSpawnTraceContext(behavior, type, options);
      const emitted = await originalMaybeSpawnStructure.call(behavior, type, options);
      this.structureTrace.push({ kind: "spawn", tick, type, emitted, ...context });
      return emitted;
    };
  }

  enableStructurePortTrace(behavior) {
    const originalHasOceanPortTiles = behavior.hasOceanPortTiles;
    if (typeof originalHasOceanPortTiles === "function") {
      behavior.hasOceanPortTiles = (...args) => {
        const available = originalHasOceanPortTiles.apply(behavior, args);
        this.structureTrace.push({
          kind: "ocean-port-availability",
          tick: this.game.ticks(),
          available,
          ports: (behavior.player.units("Port") || []).length,
        });
        return available;
      };
    }
  }

  enableStructurePlacementTrace(behavior) {
    const originalStructureSpawnTile = behavior.structureSpawnTile;
    if (typeof originalStructureSpawnTile === "function") {
      behavior.structureSpawnTile = async (type, options) => {
        const buildable = await originalStructureSpawnTile.call(behavior, type, options);
        if (
          type === "Defense Post" ||
          type === "SAM Launcher" ||
          type === "Missile Silo" ||
          type === "City" ||
          type === "Factory" ||
          type === "Port"
        ) {
          this.traceStructurePlacementProbe(type, buildable);
        }
        return buildable;
      };
    }
  }

  enableStructureSamTrace(behavior) {
    const originalStructureCandidateTiles = behavior.structureCandidateTiles;
    if (typeof originalStructureCandidateTiles === "function") {
      behavior.structureCandidateTiles = (type, options, candidateLimit) => {
        const tiles = originalStructureCandidateTiles.call(behavior, type, options, candidateLimit);
        if (type === "SAM Launcher") {
          this.structureTrace.push({
            kind: "sam-candidates",
            tick: this.game.ticks(),
            total: tiles.length,
            owned: tiles.filter((tile) => behavior.game.ownerID(tile) === behavior.player.smallID())
              .length,
            impacted: tiles.filter((tile) => behavior.tileInsideActiveHostileMissileImpact(tile))
              .length,
            dangerous: tiles.filter((tile) => behavior.isDangerousStructureTile(tile, type)).length,
            protectable: tiles.filter((tile) => {
              const protectedTiles = behavior.samProtectableStructureTiles();
              return behavior.samPlacementProtectsStructure(tile, protectedTiles);
            }).length,
          });
        }
        return tiles;
      };
    }
    const originalBuildableFor = behavior.buildableFor;
    if (typeof originalBuildableFor === "function") {
      behavior.buildableFor = async (type, tile, timeoutMs) => {
        const buildable = await originalBuildableFor.call(behavior, type, tile, timeoutMs);
        if (type === "SAM Launcher") {
          this.structureTrace.push({
            kind: "sam-buildable",
            tick: this.game.ticks(),
            requestedTile: tile,
            returnedTile: buildable?.tile ?? null,
            canBuild: buildable?.canBuild ?? null,
            canUpgrade: buildable?.canUpgrade ?? null,
          });
        }
        return buildable;
      };
    }
    const originalProbeCoveragePrioritySamTiles = behavior.probeCoveragePrioritySamTiles;
    if (typeof originalProbeCoveragePrioritySamTiles === "function") {
      behavior.probeCoveragePrioritySamTiles = async (...args) => {
        const result = await originalProbeCoveragePrioritySamTiles.apply(behavior, args);
        this.structureTrace.push({
          kind: "sam-coverage-probe",
          tick: this.game.ticks(),
          candidates: args[0]?.length ?? null,
          handled: result?.handled ?? null,
          buildable: result?.buildable?.canBuild ?? null,
          attempted: result?.attemptedTiles?.size ?? null,
        });
        return result;
      };
    }
    const originalStructureMissileEmergency = behavior.structureMissileEmergency;
    if (typeof originalStructureMissileEmergency === "function") {
      behavior.structureMissileEmergency = (type, options) => {
        const emergency = originalStructureMissileEmergency.call(behavior, type, options);
        if (type === "SAM Launcher") {
          this.structureTrace.push({
            kind: "sam-emergency",
            tick: this.game.ticks(),
            active: emergency?.active ?? null,
            recovery: emergency?.recoverySam ?? null,
            incremental: emergency?.incrementalSamDefense ?? null,
          });
        }
        return emergency;
      };
    }
    const originalHandleHostileSiloSam = behavior.handleHostileSiloSamMaximumPriority;
    if (typeof originalHandleHostileSiloSam === "function") {
      behavior.handleHostileSiloSamMaximumPriority = async () => {
        const tick = this.game.ticks();
        const silos = behavior.game?.units?.("Missile Silo") ?? [];
        const owners = silos.slice(0, 12).map((silo) => {
          const owner = silo?.owner?.();
          return {
            id: owner?.smallID?.() ?? null,
            name: owner?.name?.() ?? null,
            type: owner?.type?.() ?? null,
            isPlayer: owner?.isPlayer?.() ?? null,
          };
        });
        const placed = behavior.hasPlacedSiloOnMap?.() ?? null;
        const requested = behavior.shouldBuildSiloTriggeredSam?.() ?? null;
        const reserve = behavior.shouldReserveHostileSiloSamBudget?.() ?? null;
        const result = await originalHandleHostileSiloSam.call(behavior);
        this.structureTrace.push({
          kind: "sam-gate",
          tick,
          silos: silos.length,
          owners,
          placed,
          requested,
          reserve,
          result,
        });
        return result;
      };
    }
  }

  enableStructureUpgradeTrace(behavior) {
    const originalMaybeUpgradeStructure = behavior.maybeUpgradeStructure;
    if (typeof originalMaybeUpgradeStructure === "function") {
      behavior.maybeUpgradeStructure = async (structures, options) => {
        const tick = this.game.ticks();
        const rawGold = this.pageGame.myPlayer()?.gold?.();
        const gold = rawGold === null || rawGold === undefined ? null : String(rawGold);
        const type = structures?.[0]?.type?.() ?? null;
        const emitted = await originalMaybeUpgradeStructure.call(behavior, structures, options);
        this.structureTrace.push({
          kind: "upgrade",
          tick,
          type,
          emitted,
          gold,
          economicSpaceExhausted: options?.economicSpaceExhausted === true,
        });
        return emitted;
      };
    }
    const originalMaybeUpgradePlannedSam = behavior.maybeUpgradePlannedSam;
    if (typeof originalMaybeUpgradePlannedSam === "function") {
      behavior.maybeUpgradePlannedSam = async (plan, ...args) => {
        const tick = this.game.ticks();
        const rawGold = this.pageGame.myPlayer()?.gold?.();
        const gold = rawGold === null || rawGold === undefined ? null : String(rawGold);
        const emitted = await originalMaybeUpgradePlannedSam.call(behavior, plan, ...args);
        this.structureTrace.push({
          kind: "sam-upgrade-plan",
          tick,
          emitted,
          gold,
          samID: plan?.sam?.id?.() ?? null,
          currentLevel: plan?.currentLevel ?? null,
          targetLevel: plan?.targetLevel ?? null,
        });
        return emitted;
      };
    }
    const originalBuildableForUnits = behavior.buildableForUnits;
    if (typeof originalBuildableForUnits === "function") {
      behavior.buildableForUnits = async (units, type, options) => {
        const result = await originalBuildableForUnits.call(behavior, units, type, options);
        if (type === "SAM Launcher") {
          this.structureTrace.push({
            kind: "sam-upgrade-probe",
            tick: this.game.ticks(),
            requested: Array.isArray(units) ? units.length : null,
            results: result.map((buildable) => ({
              canBuild: buildable?.canBuild ?? null,
              canUpgrade: buildable?.canUpgrade ?? null,
              cost:
                buildable?.cost === undefined || buildable?.cost === null
                  ? null
                  : String(buildable.cost),
            })),
          });
        }
        return result;
      };
    }
  }

  enableDefensePostTrace(behavior) {
    const originalDefensePostFallbackTiles = behavior.defensePostFallbackTiles;
    if (typeof originalDefensePostFallbackTiles === "function") {
      behavior.defensePostFallbackTiles = (...args) => {
        const tiles = originalDefensePostFallbackTiles.apply(behavior, args);
        this.structureTrace.push({
          kind: "defense-post-fallback",
          tick: this.game.ticks(),
          candidates: tiles.length,
        });
        return tiles;
      };
    }
    const originalTryBuildDefensePost = behavior.tryBuildDefensePost;
    if (typeof originalTryBuildDefensePost === "function") {
      behavior.tryBuildDefensePost = async (...args) => {
        const needed = behavior.defensePostNeeded?.() === true;
        const before = (this.pageGame.myPlayer()?.units?.("Defense Post") ?? []).length;
        const tick = this.game.ticks();
        const rawGold = this.pageGame.myPlayer()?.gold?.();
        const gold = rawGold === null || rawGold === undefined ? null : String(rawGold);
        const emitted = await originalTryBuildDefensePost.apply(behavior, args);
        if (needed || emitted) {
          this.structureTrace.push({
            kind: "defense-post-attempt",
            tick,
            emitted,
            gold,
            before,
            after: (this.pageGame.myPlayer()?.units?.("Defense Post") ?? []).length,
          });
        }
        return emitted;
      };
    }
  }

  // Per-candidate tribe-launch outcomes: the planner scores several tribes
  // yet launches few, and the rejection reason lives inside sendAttack. This
  // surfaces the candidate context alongside the launch result so the
  // binding gate (probe, boat window, troop safety) is readable from the
  // trace. Events ride the structure-trace channel (OFH_LOG_STRUCTURES=1).
  enableTribeLaunchTrace() {
    const attackBehavior = this.nationBot?.attackBehavior;
    if (!attackBehavior || attackBehavior.__ofhTribeLaunchTraceEnabled) return;
    attackBehavior.__ofhTribeLaunchTraceEnabled = true;
    const original = attackBehavior.launchEarlyGameTribeCandidate;
    if (typeof original !== "function") return;
    attackBehavior.launchEarlyGameTribeCandidate = async (...args) => {
      const candidate = args[0] || {};
      const result = await original.apply(attackBehavior, args);
      const targetTroops = Math.max(0, Number(candidate.player?.troops?.()) || 0);
      this.structureTrace.push({
        kind: "tribe-launch",
        tick: this.game.ticks(),
        id: candidate.id,
        landBorder: candidate.landBorder === true,
        boatEtaTicks: Number.isFinite(Number(candidate.boatEtaTicks))
          ? candidate.boatEtaTicks
          : null,
        targetTroops: Math.round(targetTroops),
        ownTroops: Math.round(Math.max(0, Number(attackBehavior.player?.troops?.()) || 0)),
        launched: result === true,
      });
      return result;
    };
  }
  enableLandDefenseTrace() {
    const attackBehavior = this.nationBot?.attackBehavior;
    if (!attackBehavior || attackBehavior.__ofhLandDefenseTraceEnabled === true) return;
    attackBehavior.__ofhLandDefenseTraceEnabled = true;
   let forcedAttackTrace = null;
   const originalSendAttack = attackBehavior.sendAttack;
   if (typeof originalSendAttack === "function") {
     attackBehavior.sendAttack = async (...args) => {
       const [target, force] = args;
       if (force !== true || target?.isPlayer?.() !== true) {
         return originalSendAttack.apply(attackBehavior, args);
       }
       // Distinguish the winFixes bounded defense interdict from the
       // faithful strategy-ladder retaliate: both call sendAttack(target,
       // true), and the collapse diagnosis needs to know which lane spent
       // the troops.
       const callerIsDefense =
         attackBehavior.__ofhInRespondToIncomingAttack === true;
       forcedAttackTrace = {
         attacker: target.name?.() ?? null,
         landBorder: attackBehavior.player?.sharesBorderWith?.(target) === true,
         lane: callerIsDefense ? "defense-interdict" : "strategy-retaliate",
       };
        const result = await originalSendAttack.apply(attackBehavior, args);
        this.structureTrace.push({
          kind: "forced-retaliation-gate",
          tick: this.game.ticks(),
          ...forcedAttackTrace,
          result,
        });
        forcedAttackTrace = null;
        return result;
      };
    }
    const originalCreateLandAttackContext = attackBehavior.createLandAttackContext;
    if (typeof originalCreateLandAttackContext === "function") {
      attackBehavior.createLandAttackContext = (...args) => {
        const context = originalCreateLandAttackContext.apply(attackBehavior, args);
        if (forcedAttackTrace !== null) {
          forcedAttackTrace.context = {
            targetTroops: context.targetTroops,
            targetSpendableTroops: context.targetSpendableTroops,
            finalSpendableTroops: context.finalSpendableTroops,
          };
        }
        return context;
      };
    }
    const originalCalculateLandAttackTroops = attackBehavior.calculateLandAttackTroops;
    if (typeof originalCalculateLandAttackTroops === "function") {
      attackBehavior.calculateLandAttackTroops = (context) => {
        const troops = originalCalculateLandAttackTroops.call(attackBehavior, context);
        if (forcedAttackTrace !== null) {
          forcedAttackTrace.calculated = {
            troops,
            attackBlocked: context.attackBlocked,
            requiredTribeAttackTroops: context.requiredTribeAttackTroops,
          };
        }
        return troops;
      };
    }
    const originalLandAttackTroopsAreSafe = attackBehavior.landAttackTroopsAreSafe;
    if (typeof originalLandAttackTroopsAreSafe === "function") {
      attackBehavior.landAttackTroopsAreSafe = (context, troops) => {
        const safe = originalLandAttackTroopsAreSafe.call(attackBehavior, context, troops);
        if (forcedAttackTrace !== null) forcedAttackTrace.safe = safe;
        return safe;
      };
    }
    const originalEmitLandAttackIntent = attackBehavior.emitLandAttackIntent;
    if (typeof originalEmitLandAttackIntent === "function") {
      attackBehavior.emitLandAttackIntent = (context, troops) => {
        const emitted = originalEmitLandAttackIntent.call(attackBehavior, context, troops);
        if (forcedAttackTrace !== null) forcedAttackTrace.intentEmitted = emitted;
        return emitted;
      };
    }
    const originalRespondToIncomingAttack = attackBehavior?.respondToIncomingAttack;
    if (typeof originalRespondToIncomingAttack === "function") {
      attackBehavior.respondToIncomingAttack = async () => {
        const player = attackBehavior.player;
        const incoming = player?.incomingAttacks?.() ?? [];
        const before = incoming.map((attack) => ({
          attacker: attack?.attacker?.()?.name?.() ?? null,
          troops: attack?.troops?.() ?? null,
          target: attack?.target?.()?.smallID?.() ?? null,
        }));
        attackBehavior.__ofhInRespondToIncomingAttack = true;
        let result;
        try {
          result = await originalRespondToIncomingAttack.call(attackBehavior);
        } finally {
          attackBehavior.__ofhInRespondToIncomingAttack = false;
        }
        if (before.length > 0 || result !== null) {
          this.structureTrace.push({
            kind: "land-defense",
            tick: this.game.ticks(),
            ownTroops: player?.troops?.() ?? null,
            incoming: before,
            result,
          });
        }
        return result;
      };
    }
  }

  drainStructureTrace() {
    return this.structureTrace.splice(0);
  }

  async decide() {
    if (!this.runner || !this.api || !this.nationBot) {
      throw new Error("Bundled opponent must be attached before decide()");
    }
    const harness = this.harness;
    configureHardMode(harness.internals.state, this);
    if (process.env.OFH_LOG_NAVAL === "1") this.enableNavalTrace();
    if (process.env.OFH_LOG_STRUCTURES === "1") this.enableStructureTrace();
    if (process.env.OFH_LOG_SPAWN === "1") this.enableSpawnTrace();
    if (process.env.OFH_LOG_TRIBE_LAUNCH === "1") this.enableTribeLaunchTrace();
    if (process.env.OFH_LOG_NUKES === "1") this.enableNukeTrace();
    if (harness.window.__OFH_realOpponentClock) {
      harness.window.__OFH_realOpponentClock.now = this.game.ticks() * 100;
    }
    if (process.env.OFH_FORCE_HYDRO_NATION === "1" && this.nationBot.nukeBehavior) {
      this.nationBot.nukeBehavior.isHydroNation = true;
    }
    this.intentBuffer = [];
    harness.current.buildMenu = createBuildMenu(this);

    const player = this.pageGame.myPlayer();
    // Before a spawn intent is applied the client view deliberately reports no
    // active player.  The Nation bot owns the spawn decision itself, so
    // suppressing its tick here turns every Team simulation into an inert
    // pre-spawn loop.  Once the spawn phase has closed, retain the normal
    // guard against acting for an eliminated/unmaterialized player.
    if (this.shouldSkipBotTick(player)) return [];

    const beginTickStart = profileStart();
    await this.api.beginTick(player);
    profileEnd("api.beginTick", beginTickStart);
    const nationTickStart = profileStart();
    const botProfile = harness.internals.beginAutoBotProfileTick();
    await this.nationBot.tick(this.game.ticks(), botProfile);
    harness.internals.finishAutoBotProfileTick(botProfile);
    profileEnd("nationBot.tick", nationTickStart);

    harness.current.buildMenu = null;
    return sanitizeIntents(this.applyWinFixes(this.intentBuffer));
  }

  // A silent skip of the bot tick froze every decision lane in matches where
  // the engine player was still alive; surface that state so the stall is
  // diagnosable from the trace instead of looking like a passive loss.
  shouldSkipBotTick(player) {
    if (player && (player.isPlayer?.() || this.game.inSpawnPhase?.())) {
      return false;
    }
    const enginePlayer = this.findEnginePlayer();
    if (enginePlayer?.isAlive?.()) {
      this.warnDecideSkipWhileAlive(player, enginePlayer);
    }
    return true;
  }

  findEnginePlayer() {
    return this.game.players?.()?.find?.((candidate) => candidate.clientID?.() === this.clientID);
  }

  warnDecideSkipWhileAlive(player, enginePlayer) {
    console.warn(
      JSON.stringify({
        kind: "decide-skip-while-alive",
        tick: this.game.ticks(),
        clientPlayerNull: !player,
        clientIsPlayer: player ? player.isPlayer?.() : null,
        engineTiles: enginePlayer.numTilesOwned?.() ?? null,
        engineTroops: enginePlayer.troops?.() ?? null,
      }),
    );
  }

  getPerformanceProfile() {
    return this.harness.internals.getAutoBotProfileSnapshot();
  }

  // The bundle's shared client intent budget (10/s, 150/min). `rejected`
  // counts intents the local limiter refused — i.e. the bot actually tripped
  // its own rate limit and dropped work. Build-menu sends acquire the same
  // tokens, so this covers every bot producer.
  getIntentBudgetSnapshot() {
    const snapshot = this.harness.internals.getIntentRateLimitSnapshot?.();
    if (!snapshot) return null;
    return {
      accepted: Number(snapshot.accepted || 0),
      rejected: Number(snapshot.rejected || 0),
      dropsByType: snapshot.dropsByType ?? {},
    };
  }

  getNuclearStrategySnapshot() {
    const behavior = this.nationBot?.nukeBehavior;
    if (!behavior) return null;
    const structureBehavior = this.nationBot?.structureBehavior;
    const observedGlobalMirvLaunches =
      typeof structureBehavior?.observedGlobalMirvLaunchCount === "function"
        ? Number(structureBehavior.observedGlobalMirvLaunchCount())
        : null;
    return {
      isHydroNation: behavior.isHydroNation === true,
      atomBombsLaunched: Number(behavior.atomBombsLaunched || 0),
      hydrogenBombsLaunched: Number(behavior.hydrogenBombsLaunched || 0),
      pendingLaunches: Number(behavior._pendingNukeLaunches?.length || 0),
      // Market-wide MIRV launches observed in flight (engine numMirvsLaunched
      // proxy) — closes the build-intent-vs-actual-launch telemetry gap.
      observedGlobalMirvLaunches,
    };
  }

  getSpawnLifecycleSnapshot() {
    const player = this.pageGame.myPlayer();
    const nationBot = this.nationBot;
    let awaitingTeamGeometry = false;
    if (typeof nationBot.shouldAwaitInitialTeamSpawnGeometry === "function") {
      awaitingTeamGeometry = nationBot.shouldAwaitInitialTeamSpawnGeometry(this.game.ticks());
    }
    return {
      inSpawnPhase: this.game.inSpawnPhase() === true,
      hasSpawned: player.hasSpawned() === true,
      team: player.team(),
      spawnExecAdded: nationBot.spawnExecAdded === true,
      awaitingTeamGeometry,
    };
  }

  applyWinFixes(intents) {
    if (!this.winFixes) return intents;
    const player = this.game.playerByClientID(this.clientID);
    if (!this.game.inSpawnPhase?.() || player?.hasSpawned?.()) {
      return intents.filter((intent) => intent?.type !== "spawn");
    }
    const spawnIntent = intents.find(
      (intent) => intent?.type === "spawn" && Number.isFinite(Number(intent.tile)),
    );
    if (!spawnIntent) {
      if (this.nationBot?.spawnExecAdded) this.nationBot.spawnExecAdded = false;
      return intents;
    }
    const tile = Number(spawnIntent.tile);
    // SpawnExecution accepts a selected centre when any tile in its local
    // spawn footprint is legal.  Requiring every radius-4 tile to be legal
    // rejects legitimate coastal/irregular terrain spawns and makes the
    // harness silently erase an intent that the real game would execute.
    const validSpawn = getSpawnTiles(this.game, tile, false);
    if (validSpawn.length > 0) return intents;
    if (this.nationBot?.spawnExecAdded) this.nationBot.spawnExecAdded = false;
    return intents.filter((intent) => intent !== spawnIntent);
  }
}

function profileStart() {
  return process.env.BLITZBOT_PROFILE_OPPONENT === "1" ? globalThis.performance.now() : 0;
}

function profileEnd(name, startedAt) {
  if (process.env.BLITZBOT_PROFILE_OPPONENT !== "1") return;
  const entry = opponentProfile.get(name) ?? { count: 0, ms: 0 };
  entry.count += 1;
  entry.ms += globalThis.performance.now() - startedAt;
  opponentProfile.set(name, entry);
}

function configureHardMode(state, bot) {
  state.settings.enabled = true;
  state.settings.difficulty = bot.difficulty;
  state.settings.winFixes = bot.winFixes;
  state.settings.tickMs = bot.tickMs;
  state.settings.performanceProfiling = bot.performanceProfiling;
  state.settings.features = { ...state.settings.features, ...bot.features };
  state.settings.buildStructures = {
    ...state.settings.buildStructures,
    ...bot.buildStructures,
  };
}

export function createBuildMenu(bot) {
  if (bot.buildMenu) return bot.buildMenu;
  const eventBus = createEventBus(bot, bot.harness.window);
  bot.buildMenu = {
    eventBus,
    uiState: { rocketDirectionUp: true },
    sendBuildOrUpgrade(buildable, tile) {
      if (!buildable) return;
      if (buildable.canUpgrade !== false && buildable.canUpgrade !== undefined) {
        bot.intentBuffer.push({
          type: "upgrade_structure",
          unit: buildable.type,
          unitId: Number(buildable.canUpgrade),
        });
        return;
      }
      const buildTile = Number(tile ?? buildable.canBuild);
      if (Number.isFinite(buildTile) && buildTile >= 0) {
        bot.intentBuffer.push({
          type: "build_unit",
          unit: buildable.type,
          tile: buildTile,
          rocketDirectionUp: this.uiState.rocketDirectionUp,
        });
      }
    },
  };
  return bot.buildMenu;
}

function createEventBus(bot, window) {
  class BuildUnitEvent {
    constructor(unit, tile, rocketDirectionUp) {
      this.unit = unit;
      this.tile = tile;
      this.rocketDirectionUp = rocketDirectionUp;
    }
  }
  class SpawnEvent {
    constructor(tile) {
      this.tile = tile;
    }
  }
  class AttackEvent {
    constructor(targetID, troops) {
      this.targetID = targetID;
      this.troops = troops;
    }
  }
  class CancelAttackEvent {
    constructor(attackID) {
      this.attackID = attackID;
    }
  }
  class BoatEvent {
    constructor(dst, troops) {
      this.dst = dst;
      this.troops = troops;
    }
  }
  class MoveWarshipEvent {
    constructor(unitIds, tile) {
      this.unitIds = unitIds;
      this.tile = tile;
    }
  }
  class EmbargoEvent {
    constructor(target, action) {
      this.target = target;
      this.action = action;
    }
  }
  class DonateTroopsEvent {
    constructor(recipient, troops) {
      this.recipient = recipient;
      this.troops = troops;
    }
  }
  class EmojiEvent {
    constructor(recipient, emoji) {
      this.recipient = recipient;
      this.emoji = emoji;
    }
  }
  class AllianceRequestEvent {
    constructor(requestor, recipient) {
      this.requestor = requestor;
      this.recipient = recipient;
    }
  }
  class BreakAllianceEvent {
    constructor(requestor, recipient) {
      this.requestor = requestor;
      this.recipient = recipient;
    }
  }

  return {
    listeners: new window.Map([
      [BuildUnitEvent, []],
      [MoveWarshipEvent, []],
      [EmbargoEvent, []],
      [DonateTroopsEvent, []],
      [EmojiEvent, []],
      [AttackEvent, []],
      [CancelAttackEvent, []],
      [BoatEvent, []],
      [SpawnEvent, []],
      [AllianceRequestEvent, []],
      [BreakAllianceEvent, []],
    ]),
    emit(event) {
      const intent =
        event instanceof BreakAllianceEvent
          ? { type: "breakAlliance", recipient: unwrapID(event.recipient) }
          : eventToIntent(event, bot.game, bot.clientID);
      if (intent) bot.intentBuffer.push(intent);
    },
  };
}

function spawnEventToIntent(event) {
  if (
    event.tile !== undefined &&
    event.unitIds === undefined &&
    event.targetID === undefined &&
    event.dst === undefined &&
    event.troops === undefined
  ) {
    return { type: "spawn", tile: Number(event.tile) };
  }
  return null;
}

function attackEventToIntent(event, game, clientID) {
  if (event.targetID !== undefined && event.troops !== undefined) {
    const targetID = event.targetID === null ? null : unwrapID(event.targetID);
    return {
      type: "attack",
      targetID,
      troops: Math.max(0, Math.floor(Number(event.troops))),
      attackTargetSnapshot: captureAttackTargetSnapshot(game, clientID, targetID),
    };
  }
  return null;
}

function captureAttackTargetSnapshot(game, clientID, targetID) {
  const target = findPlayerByID(game, targetID);
  const attacker = game?.playerByClientID?.(clientID);
  const pendingTroops =
    isAbsentPlayer(target) || attacker === undefined
      ? 0
      : attacker
          .outgoingAttacks()
          .filter((attack) => attack.target()?.id() === target.id())
          .reduce((total, attack) => total + attack.troops(), 0);
  return {
    name: target?.name() ?? "Terra Nullius",
    type: target?.type() ?? "Terra Nullius",
    troops: Number(target?.troops() ?? 0),
    pendingTroops: Number(pendingTroops),
  };
}

function findPlayerByID(game, playerID) {
  if (playerID === null || playerID === undefined) return null;
  return game?.players?.().find((player) => player.id() === playerID);
}

function isAbsentPlayer(player) {
  return player === null || player === undefined;
}

function boatEventToIntent(event) {
  if (event.dst !== undefined && event.troops !== undefined) {
    const dst = unwrapTile(event.dst);
    if (!Number.isFinite(dst)) return null;
    return {
      type: "boat",
      dst,
      troops: Math.max(0, Math.floor(Number(event.troops))),
    };
  }
  return null;
}

function warshipEventToIntent(event) {
  if (Array.isArray(event.unitIds) && event.tile !== undefined) {
    return {
      type: "move_warship",
      unitIds: event.unitIds.map(Number).filter(Number.isFinite),
      tile: Number(event.tile),
    };
  }
  return null;
}

function embargoEventToIntent(event) {
  if (event.target !== undefined && event.action !== undefined) {
    return {
      type: "embargo",
      targetID: unwrapID(event.target),
      action: event.action,
    };
  }
  return null;
}

function donationEventToIntent(event) {
  if (event.recipient !== undefined && event.troops !== undefined) {
    return {
      type: "donate_troops",
      recipient: unwrapID(event.recipient),
      troops: Math.max(0, Math.floor(Number(event.troops))),
    };
  }
  return null;
}

function emojiEventToIntent(event) {
  if (event.recipient !== undefined && event.emoji !== undefined) {
    return {
      type: "emoji",
      recipient: event.recipient === "AllPlayers" ? "AllPlayers" : unwrapID(event.recipient),
      emoji: event.emoji,
    };
  }
  return null;
}

function allianceEventToIntent(event) {
  if (event.requestor !== undefined && event.recipient !== undefined) {
    return {
      type: "allianceRequest",
      recipient: unwrapID(event.recipient),
    };
  }
  return null;
}

function eventToIntent(event, game, clientID) {
  if (event.attackID !== undefined) {
    return { type: "cancel_attack", attackID: event.attackID };
  }
  if (event.unit !== undefined && event.tile !== undefined) {
    return {
      type: "build_unit",
      unit: event.unit,
      tile: Number(event.tile),
      rocketDirectionUp: event.rocketDirectionUp,
    };
  }
  return (
    warshipEventToIntent(event) ??
    spawnEventToIntent(event) ??
    attackEventToIntent(event, game, clientID) ??
    boatEventToIntent(event) ??
    embargoEventToIntent(event) ??
    donationEventToIntent(event) ??
    emojiEventToIntent(event) ??
    allianceEventToIntent(event)
  );
}

function unwrapID(value) {
  const unwrapped = value?.__src ?? value;
  if (typeof unwrapped?.id === "function") return unwrapped.id();
  if (typeof value?.id === "function") return value.id();
  return String(value);
}

function unwrapTile(value) {
  const unwrapped = value?.__src ?? value;
  if (typeof unwrapped === "number") return unwrapped;
  if (typeof unwrapped?.tile === "function") return Number(unwrapped.tile());
  if (typeof unwrapped?.tile === "number") return unwrapped.tile;
  if (typeof value?.tile === "function") return Number(value.tile());
  if (typeof value?.tile === "number") return value.tile;
  return Number(unwrapped);
}

function sanitizeIntents(intents) {
  return intents.filter((intent) => {
    if (!intent || typeof intent.type !== "string") return false;
    if (["join", "rejoin", "auth", "admin", "kick", "pause", "config"].includes(intent.type)) {
      return false;
    }
    if (intent.type === "move_warship" && intent.unitIds.length === 0) return false;
    if (intent.type === "boat" && !Number.isFinite(intent.dst)) return false;
    return true;
  });
}

function bindPublicSurface(target) {
  const adapter = Object.create(null);
  const seen = new Set();
  for (
    let source = target;
    source && source !== Object.prototype;
    source = Object.getPrototypeOf(source)
  ) {
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name === "constructor" || seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (typeof descriptor?.value === "function") {
        adapter[name] = descriptor.value.bind(target);
      } else if (descriptor?.get) {
        Object.defineProperty(adapter, name, {
          enumerable: descriptor.enumerable,
          get: descriptor.get.bind(target),
        });
      }
    }
  }
  return adapter;
}

export function createPageGameAdapter(game, runner, clientID, motionPlans) {
  let playerCache = runnerPlayerAdapterCaches.get(runner);
  if (!playerCache) {
    playerCache = new Map();
    runnerPlayerAdapterCaches.set(runner, playerCache);
  }
  const getPlayer = (player) => {
    if (!player?.isPlayer?.()) return player;
    const id = player.id();
    if (!playerCache.has(id)) {
      playerCache.set(id, createPagePlayerAdapter(game, runner, player));
    }
    return playerCache.get(id);
  };

  const adapter = bindPublicSurface(game);
  adapter.gameID = () => "real-openfront-game";
  adapter.myPlayer = () => {
    const player = game.playerByClientID(clientID);
    return player ? getPlayer(player) : null;
  };
  adapter.players = () => game.players().map(getPlayer);
  adapter.playerViews = adapter.players;
  adapter.playerBySmallID = (smallID) => getPlayer(game.playerBySmallID(Number(smallID)));
  adapter.owner = (tile) => getPlayer(game.owner(tile));
  adapter.units = (...types) => game.units(...types);
  adapter.motionPlans = () => motionPlans;
  return adapter;
}

function currentRunnerTickCache(game, runner) {
  const tick = game.ticks();
  const cached = runnerTickCaches.get(runner);
  if (cached?.tick === tick) return cached;
  const next = {
    tick,
    buildables: new Map(),
    actions: new Map(),
    profiles: new Map(),
    borderTiles: new Map(),
    bestTransportShipSpawns: new Map(),
  };
  runnerTickCaches.set(runner, next);
  return next;
}

function createPagePlayerAdapter(game, runner, player) {
  const adapter = new Proxy(player, {
    get(target, prop) {
      if (prop === "buildables") {
        return (tile = null, units) => {
          const startedAt = profileStart();
          try {
            const cache = currentRunnerTickCache(game, runner).buildables;
            const key = `${target.id()}:${tile ?? ""}:${unitsKey(units)}`;
            if (cache.has(key)) return cache.get(key);
            const result =
              tile === null || tile === undefined
                ? runner.playerBuildables(target.id(), undefined, undefined, units)
                : runner.playerBuildables(target.id(), game.x(tile), game.y(tile), units);
            cache.set(key, result);
            return result;
          } finally {
            profileEnd("player.buildables", startedAt);
          }
        };
      }
      if (prop === "actions") {
        return (tile = null, units = undefined) => {
          const startedAt = profileStart();
          try {
            const cache = currentRunnerTickCache(game, runner).actions;
            const key = `${target.id()}:${tile ?? ""}:${unitsKey(units)}`;
            if (cache.has(key)) return cache.get(key);
            const result =
              tile === null || tile === undefined
                ? runner.playerActions(target.id(), undefined, undefined, units)
                : runner.playerActions(target.id(), game.x(tile), game.y(tile), units);
            cache.set(key, result);
            return result;
          } finally {
            profileEnd("player.actions", startedAt);
          }
        };
      }
      if (prop === "profile")
        return () => {
          const startedAt = profileStart();
          try {
            const cache = currentRunnerTickCache(game, runner).profiles;
            const key = target.smallID();
            if (cache.has(key)) return cache.get(key);
            const result = runner.playerProfile(key);
            cache.set(key, result);
            return result;
          } finally {
            profileEnd("player.profile", startedAt);
          }
        };
      if (prop === "borderTiles") {
        return () => {
          const startedAt = profileStart();
          try {
            const cache = currentRunnerTickCache(game, runner).borderTiles;
            const key = target.id();
            if (cache.has(key)) return cache.get(key);
            const result = target.borderTiles();
            cache.set(key, result);
            return result;
          } finally {
            profileEnd("player.borderTiles", startedAt);
          }
        };
      }
      if (prop === "bestTransportShipSpawn") {
        return (tile) => {
          const startedAt = profileStart();
          try {
            const cache = currentRunnerTickCache(game, runner).bestTransportShipSpawns;
            const key = `${target.id()}:${tile}`;
            if (cache.has(key)) return cache.get(key);
            const result = runner.bestTransportShipSpawn(target.id(), tile);
            cache.set(key, result);
            return result;
          } finally {
            profileEnd("player.bestTransportShipSpawn", startedAt);
          }
        };
      }
      if (prop === "nameLocation") {
        return () => {
          if (!target.hasSpawned?.()) return undefined;
          return game.inSpawnPhase?.() ? placeSpawnName(game, target) : placeName(game, target);
        };
      }
      if (prop === "incomingAttacks") {
        return () => target.incomingAttacks().map(bindMethods);
      }
      if (prop === "outgoingAttacks") {
        return () => target.outgoingAttacks().map(bindMethods);
      }
      if (prop === "units") {
        return (...types) => target.units(...types).map(bindMethods);
      }
      const value = target[prop];
      // Native diplomacy compares Player objects by identity. Never pass a
      // page proxy into pending-request or alliance checks on the engine.
      return typeof value === "function"
        ? (...args) =>
            value.apply(
              target,
              args.map((arg) => pagePlayerTargets.get(arg) ?? arg),
            )
        : value;
    },
  });
  pagePlayerTargets.set(adapter, player);
  return adapter;
}

function unitsKey(units) {
  if (units === undefined || units === null) return "";
  return Array.isArray(units) ? units.join(",") : String(units);
}

function bindMethods(value) {
  if (!value || typeof value !== "object") return value;
  const cached = boundMethodProxyCache.get(value);
  if (cached) return cached;
  const proxy = new Proxy(value, {
    get(target, prop) {
      const member = target[prop];
      if (typeof member !== "function") return member;
      let methods = boundMethodCache.get(target);
      if (!methods) {
        methods = new Map();
        boundMethodCache.set(target, methods);
      }
      if (!methods.has(prop)) {
        methods.set(prop, member.bind(target));
      }
      return methods.get(prop);
    },
  });
  boundMethodProxyCache.set(value, proxy);
  return proxy;
}

export default BundledOpponentBot;
