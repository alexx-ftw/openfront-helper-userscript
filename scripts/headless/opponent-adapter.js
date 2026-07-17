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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH =
  process.env.OFH_BUNDLE_PATH ?? path.resolve(__dirname, "../../openfront-helper.user.js");
const STORAGE_KEY = "openfront-helper-autobot-v1";

let loadedHarness = null;
let bundledHarnessSource = null;
let bundledHarnessScript = null;
const opponentProfile = new Map();
const runnerTickCaches = new WeakMap();
const runnerPlayerAdapterCaches = new WeakMap();
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
  const hostDeadlineNow = globalThis.performance.now.bind(globalThis.performance);
  window.__OFH_deadlineNow = hostDeadlineNow;
  window.Date.now = () => clock.now;
  Object.defineProperty(window.performance, "now", {
    configurable: true,
    value: () => clock.now,
  });
  const disabledHardMode = {
    enabled: false,
    difficulty: "Impossible",
    winFixes: true,
    tickMs: 1,
    features: {
      spawn: true,
      expand: true,
      build: true,
      boat: true,
      nuke: true,
      warship: true,
      alliance: true,
      donate: true,
      betray: true,
    },
    buildStructures: {
      City: true,
      Factory: true,
      Port: true,
      "Defense Post": true,
      "SAM Launcher": true,
      "Missile Silo": true,
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
  window.setTimeout = (fn, ms = 0, ...args) => {
    const timer = globalThis.setTimeout(fn, ms, ...args);
    return timer;
  };
  window.clearTimeout = (id) => globalThis.clearTimeout(id);

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
  createGameApi,
  state,
  DEFAULTS,
  UNIT,
  discoverCtors,
  getEventBus,
  getBuildMenu
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
    difficulty: "Impossible",
    winFixes: true,
    tickMs: 1,
    responsiveness: "maximum",
    features: {
      spawn: true,
      expand: true,
      build: true,
      boat: true,
      nuke: true,
      warship: true,
      alliance: true,
      donate: true,
      betray: true,
    },
    buildStructures: {
      City: true,
      Factory: true,
      Port: true,
      "Defense Post": true,
      "SAM Launcher": true,
      "Missile Silo": true,
    },
    ...options,
  });
}

export class BundledOpponentBot {
  constructor(options = {}) {
    this.name = options.name ?? "OpponentToBeat";
    this.id = options.id ?? "Opponent";
    this.clientID = options.clientID ?? "opponent-client";
    this.difficulty = options.difficulty ?? "Impossible";
    this.winFixes = options.winFixes ?? true;
    this.tickMs = options.tickMs ?? 1;
    this.responsiveness = options.responsiveness ?? "maximum";
    this.features = { ...(options.features ?? {}) };
    this.buildStructures = { ...(options.buildStructures ?? {}) };
    this.intentBuffer = [];
    this.api = null;
    this.pageGame = null;
    this.nationBot = null;
    this.harness = options.harness ?? createBundledOpponentHarness();
  }

  attach({ runner, clientID = this.clientID, gameID = "openfront-real-game" }) {
    this.runner = runner;
    this.game = runner.game;
    this.clientID = clientID;
    this.gameID = gameID;
    this.pageGame = createPageGameAdapter(this.game, runner, this.clientID);
    const { internals } = this.harness;
    this.api = internals.createGameApi(this.pageGame);
    this.nationBot = new internals.NationBot(this.api.game, {
      gameId: this.gameID,
      playerId: this.clientID,
    });
  }

  async decide() {
    if (!this.runner || !this.api || !this.nationBot) {
      throw new Error("Bundled opponent must be attached before decide()");
    }
    const harness = this.harness;
    configureHardMode(harness.internals.state, this);
    if (harness.window.__OFH_realOpponentClock) {
      harness.window.__OFH_realOpponentClock.now = this.game.ticks() * 100;
    }
    this.intentBuffer = [];
    harness.current.buildMenu = createBuildMenu(this);

    const player = this.pageGame.myPlayer();
    if (!player?.isPlayer?.()) return [];

    const beginTickStart = profileStart();
    await this.api.beginTick(player);
    profileEnd("api.beginTick", beginTickStart);
    const nationTickStart = profileStart();
    await this.nationBot.tick(this.game.ticks());
    profileEnd("nationBot.tick", nationTickStart);

    harness.current.buildMenu = null;
    return sanitizeIntents(this.applyWinFixes(this.intentBuffer));
  }

  applyWinFixes(intents) {
    if (!this.winFixes) return intents;
    const player = this.game.playerByClientID(this.clientID);
    if (!this.game.inSpawnPhase?.() || player?.hasSpawned?.()) return intents;
    const spawnIntent = intents.find(
      (intent) => intent?.type === "spawn" && Number.isFinite(Number(intent.tile)),
    );
    if (!spawnIntent) {
      if (this.nationBot?.spawnExecAdded) this.nationBot.spawnExecAdded = false;
      return intents;
    }
    const tile = Number(spawnIntent.tile);
    const validSpawn = getSpawnTiles(this.game, tile, true);
    if (validSpawn) return intents;
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
  state.settings.features = { ...state.settings.features, ...bot.features };
  state.settings.buildStructures = {
    ...state.settings.buildStructures,
    ...bot.buildStructures,
  };
}

function createBuildMenu(bot) {
  const eventBus = createEventBus(bot, bot.harness.window);
  return {
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
          rocketDirectionUp: true,
        });
      }
    },
  };
}

function createEventBus(bot, window) {
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

  return {
    listeners: new window.Map([
      [MoveWarshipEvent, []],
      [EmbargoEvent, []],
      [DonateTroopsEvent, []],
      [EmojiEvent, []],
      [AttackEvent, []],
      [BoatEvent, []],
      [SpawnEvent, []],
      [AllianceRequestEvent, []],
    ]),
    emit(event) {
      const intent = eventToIntent(event);
      if (intent) bot.intentBuffer.push(intent);
    },
  };
}

function spawnEventToIntent(event) {
  if (
    event.tile !== undefined &&
    event.targetID === undefined &&
    event.dst === undefined &&
    event.troops === undefined
  ) {
    return { type: "spawn", tile: Number(event.tile) };
  }
  return null;
}

function attackEventToIntent(event) {
  if (event.targetID !== undefined && event.troops !== undefined) {
    return {
      type: "attack",
      targetID: event.targetID,
      troops: Math.max(0, Math.floor(Number(event.troops))),
    };
  }
  return null;
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

function eventToIntent(event) {
  return (
    spawnEventToIntent(event) ??
    attackEventToIntent(event) ??
    boatEventToIntent(event) ??
    warshipEventToIntent(event) ??
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

function createPageGameAdapter(game, runner, clientID) {
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
  return new Proxy(player, {
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
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
