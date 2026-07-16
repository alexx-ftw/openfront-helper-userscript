// Auto-Bot — game/UI handle discovery, intent constructor discovery,
// emitIntent, and the window.__autoBotDiag() console diagnostic.

"use strict";

  // =========================================================================
  // Game / UI handle discovery
  // =========================================================================
  function findSharedGameContext() {
    {
      if (typeof getOpenFrontGameContext === "function") {
        const c = getOpenFrontGameContext();
        if (c?.game?.myPlayer) return c;
      }
    }
    return null;
  }

  function findContext() {
    // Preferred: robust DOM scan shared from selective-trade-policy.js.
    const sharedContext = findSharedGameContext();
    if (sharedContext) return sharedContext;
    {
      if (runtimeState.lastOpenFrontGameContext?.game?.myPlayer) {
        return runtimeState.lastOpenFrontGameContext;
      }
    }
    const selectors = [
      "main-radial-menu",
      "build-menu",
      "control-panel",
      "leader-board",
      "options-menu",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.game?.myPlayer) {
        return {
          game: el.game,
          transform: el.transformHandler || el.transform || null,
        };
      }
    }
    return null;
  }

  function getGame() {
    return findContext()?.game ?? null;
  }

  function getRadialMenu() {
    return document.querySelector("main-radial-menu");
  }

  // `build-menu` is declared in index.html (persistent) and the game wires it
  // with .game/.eventBus/.uiState — the reliable handle for actuation. The
  // radial menu is only mounted while its right-click menu is open, so we must
  // NOT depend on it for the bot loop.
  function getBuildMenu() {
    return (
      document.querySelector("build-menu") || getRadialMenu()?.buildMenu || null
    );
  }

  function getEventBus() {
    const bm = getBuildMenu();
    if (bm?.eventBus) return bm.eventBus;
    const cp = document.querySelector("control-panel");
    if (cp?.eventBus) return cp.eventBus;
    const lb = document.querySelector("leader-board");
    if (lb?.eventBus) return lb.eventBus;
    return getRadialMenu()?.eventBus ?? null;
  }

  // ---- Intent constructor discovery ---------------------------------------
  // We emit the same GameEvents the UI emits. Property names are not mangled in
  // the game's build, so we identify the right constructor by probing the
  // EventBus listener map with sentinel args and matching the resulting
  // own-property shape. Same approach as boat-macro.js.
  const _ctors = {
    bus: null,
    spawn: null,
    attack: null,
    boat: null,
    moveWarship: null,
    embargo: null,
    donateTroops: null,
    emoji: null, // SendEmojiIntentEvent(recipient|AllPlayers, emoji:number)
    target: null, // SendTargetPlayerIntentEvent(targetID:PlayerID string)
    allianceRequest: null, // learned lazily by sniffing an accept (see doAlliance)
  };

  // Alliance request/renewal event objects we've already actioned, so we don't
  // re-accept the same one each tick (and to dedupe across the two sources).
  const _alliancesActioned = new WeakSet();

  function matchesIntentConstructor(Ctor, args, predicate, source) {
    {
      return predicate(new Ctor(...args));
    }
  }

  const INTENT_CTOR_PROBES = [
    {
      key: "moveWarship",
      args: [[7, 8], 99],
      matches: (event) => Array.isArray(event?.unitIds) && event.unitIds[0] === 7 && event.tile === 99,
    },
    {
      key: "embargo",
      args: [{ __probe: 1 }, "start"],
      matches: (event, args) => event?.target === args[0] && event.action === "start",
    },
    {
      key: "donateTroops",
      args: [{ __probe: 1 }, 123],
      matches: (event, args) => event?.recipient === args[0] && event.troops === 123,
    },
    {
      key: "emoji",
      args: [{ __probe: 1 }, 7],
      matches: (event, args) =>
        event?.recipient === args[0] &&
        event.emoji === 7 &&
        event.troops === undefined &&
        event.action === undefined,
    },
    {
      key: "target",
      args: ["§tp", 456],
      matches: (event) =>
        event?.targetID === "§tp" &&
        event.troops === undefined &&
        event.recipient === undefined &&
        event.dst === undefined &&
        event.emoji === undefined,
    },
    {
      key: "attack",
      args: ["§p", 123],
      matches: (event) => event?.targetID === "§p" && event.troops === 123 && event.dst === undefined,
    },
    {
      key: "boat",
      args: [77, 123],
      matches: (event) => event?.dst === 77 && event.troops === 123,
    },
    {
      key: "spawn",
      args: [55],
      matches: (event) =>
        event?.tile === 55 &&
        event.targetID === undefined &&
        event.dst === undefined &&
        event.unit === undefined &&
        event.troops === undefined,
    },
  ];

  function discoverIntentConstructor(Ctor) {
    for (const probe of INTENT_CTOR_PROBES) {
      if (_ctors[probe.key]) continue;
      const matches = matchesIntentConstructor(
        Ctor,
        probe.args,
        (event) => probe.matches(event, probe.args),
        `engine/ingame/auto-bot/context.js:probe-${probe.key}`,
      );
      if (!matches) continue;
      _ctors[probe.key] = Ctor;
      return;
    }
  }

  function getListenersMap(eventBus) {
    if (eventBus?.listeners instanceof Map) return eventBus.listeners;
    for (const key of Object.getOwnPropertyNames(eventBus || {})) {
      {
        if (eventBus[key] instanceof Map) return eventBus[key];
      }
    }
    return null;
  }

  function discoverCtors(eventBus) {
    if (
      _ctors.bus === eventBus &&
      _ctors.attack &&
      _ctors.spawn &&
      _ctors.boat &&
      _ctors.moveWarship &&
      _ctors.embargo &&
      _ctors.donateTroops
    ) {
      return _ctors;
    }
    const map = getListenersMap(eventBus);
    if (!map) return _ctors;
    _ctors.bus = eventBus;
    for (const Ctor of map.keys()) {
      if (typeof Ctor === "function") discoverIntentConstructor(Ctor);
    }
    return _ctors;
  }

  function emitIntent(ctor, ...args) {
    const eventBus = getEventBus();
    if (!eventBus || typeof ctor !== "function") return false;
    {
      const event = new ctor(...args);
      if (
        typeof tryAcquireIntentRateLimit !== "function" ||
        !tryAcquireIntentRateLimit()
      ) {
        return false;
      }
      eventBus.emit(event);
      return true;
    }
  }

  function diagnosticValue(value, fallback) {
    return value ?? fallback;
  }

  function callDiagnosticMethod(target, methodName, fallback = null) {
    {
      const method = target?.[methodName];
      return typeof method === "function" ? method.call(target) : fallback;
    }
  }

  function getBotDiagnosticStatus() {
    {
      return typeof _bot !== "undefined" && _bot ? _bot.status : "no-bot";
    }
  }

  function getEarlyGameDiagnostic(earlyGame) {
    if (!earlyGame) return null;
    return {
      active: Boolean(earlyGame.active),
      action: diagnosticValue(earlyGame.action, null),
      hasFreeLand: Boolean(earlyGame.hasFreeLand),
      hasTribeTarget: Boolean(earlyGame.hasTribeTarget),
      maritimeProbeSent: Boolean(earlyGame.maritimeProbeSent),
      tribeTarget: diagnosticValue(earlyGame.tribeTarget, null),
      oceanTarget: diagnosticValue(earlyGame.oceanTarget, null),
      boatRouteAvailable: Boolean(earlyGame.boatRouteAvailable),
      boatGate: diagnosticValue(earlyGame.boatGate, null),
      lastBoatEtaTicks: diagnosticValue(earlyGame.lastBoatEtaTicks, null),
      boatRejectedUnknown: diagnosticValue(earlyGame.boatRejectedUnknown, 0),
      boatRejectedTooFar: diagnosticValue(earlyGame.boatRejectedTooFar, 0),
      troopGenerationRate: diagnosticValue(earlyGame.troopGenerationRate, 0),
      generationRatio: diagnosticValue(earlyGame.generationRatio, 0),
      optimalGenerationRatio: diagnosticValue(earlyGame.optimalGenerationRatio, 0.42),
      nextExpansionTick: diagnosticValue(earlyGame.nextExpansionTick, 0),
      frontierFreeTiles: diagnosticValue(earlyGame.frontierFreeTiles, 0),
      frontierTerrainMagnitude: diagnosticValue(earlyGame.frontierTerrainMagnitude, 10),
      frontierTerrainScore: diagnosticValue(earlyGame.frontierTerrainScore, 0),
      frontierContestedTileCount: diagnosticValue(earlyGame.frontierContestedTileCount, 0),
      frontierCompetingOwnerCount: diagnosticValue(earlyGame.frontierCompetingOwnerCount, 0),
      frontierCompetitionScore: diagnosticValue(earlyGame.frontierCompetitionScore, 0),
      expansionPlan: diagnosticValue(earlyGame.expansionPlan, null),
    };
  }

  function getEventsDisplayDiagnostic() {
    {
      return diagnosticValue(document.querySelector("events-display")?.events?.length, null);
    }
  }

  function getPlayerDiagnostics(me) {
    if (!me) return { gold: 0, troops: 0, tiles: 0 };
    return {
      gold: Math.round(toNum(callDiagnosticMethod(me, "gold", 0))),
      troops: Math.round(toNum(callDiagnosticMethod(me, "troops", 0))),
      tiles: toNum(callDiagnosticMethod(me, "numTilesOwned", 0)),
    };
  }

  // Console diagnostic — call window.__autoBotDiag() in-game to inspect what
  // the bot can see/use.
  function diagnose(options = {}) {
    const game = getGame();
    const eventBus = getEventBus();
    const ctors = eventBus ? discoverCtors(eventBus) : _ctors;
    const bm = getBuildMenu();
    const me = game?.myPlayer?.();
    const diag = {
      game: Boolean(game),
      gameType: game ? gameType(game) : null,
      inSpawnPhase: callDiagnosticMethod(game, "inSpawnPhase"),
      myPlayer: Boolean(me),
      hasSpawned: callDiagnosticMethod(me, "hasSpawned"),
      buildMenu: Boolean(bm),
      sendBuildOrUpgrade: typeof bm?.sendBuildOrUpgrade,
      eventBus: Boolean(eventBus),
      ctorSpawn: Boolean(ctors.spawn),
      ctorAttack: Boolean(ctors.attack),
      ctorBoat: Boolean(ctors.boat),
      ctorMoveWarship: Boolean(ctors.moveWarship),
      ctorEmbargo: Boolean(ctors.embargo),
      ctorDonateTroops: Boolean(ctors.donateTroops),
      ctorEmoji: Boolean(ctors.emoji),
      ctorAllianceRequest: Boolean(ctors.allianceRequest),
      intentRateLimit: typeof getIntentRateLimitSnapshot === "function"
        ? getIntentRateLimitSnapshot()
        : null,
      speedFactor: Math.round((state.speed?.factor ?? 1) * 100) / 100,
      ...getPlayerDiagnostics(me),
      botStatus: getBotDiagnosticStatus(),
      earlyGame: getEarlyGameDiagnostic(state.earlyGame),
      eventsDisplayEvents: getEventsDisplayDiagnostic(),
    };
    if (options.silent !== true) runtimeDebugLog("[AutoBot] DIAG", diag);
    return diag;
  }
  window.__autoBotDiag = diagnose;
