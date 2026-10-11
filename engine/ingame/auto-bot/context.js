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

  // The game client validates each BuildableUnit against one asynchronous
  // snapshot. Two bot phases can therefore both see the same gold and emit
  // individually-valid purchases whose combined cost the engine later rejects.
  // Keep those not-yet-observed purchases reserved for the short client intent
  // round trip. This is deliberately shared by every auto-bot construction
  // caller, rather than being a separate per-behavior estimate.
  const AUTO_BOT_BUILD_RESERVATION_GRACE_TICKS = 6;
  const autoBotBuildReservations = new WeakMap();

  function autoBotBuildTick(game) {
    const tick = game?.ticks?.();
    return Number.isFinite(tick) ? Number(tick) : 0;
  }

  function autoBotBuildPlayerId(player) {
    const id = player?.id?.() ?? player?.smallID?.();
    return id === null || id === undefined ? "" : String(id);
  }

  function autoBotBuildReservedGold(game, player) {
    const tick = autoBotBuildTick(game);
    const playerId = autoBotBuildPlayerId(player);
    return (autoBotBuildReservations.get(game) ?? []).reduce(
      (total, reservation) => reservation.expiresAt > tick && reservation.playerId === playerId
        ? total + reservation.cost : total,
      0n,
    );
  }

  function autoBotBuildCost(buildable) {
    const cost = buildable?.cost;
    if (typeof cost === "bigint") return cost >= 0n ? cost : null;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      return BigInt(Math.floor(cost));
    }
    return null;
  }

  function autoBotBuildPendingNukes(game, player) {
    const tick = autoBotBuildTick(game);
    const playerId = autoBotBuildPlayerId(player);
    const records = (autoBotBuildReservations.get(game) ?? []).filter(
      (record) => record.expiresAt > tick && record.playerId === playerId && record.nuke,
    );
    const claimed = new Set(records.filter((record) => record.receipt !== undefined)
      .map((record) => record.receipt));
    for (const record of records) {
      if (record.receipt !== undefined) continue;
      const receipt = player.units(record.nuke).find((unit) =>
        unit.targetTile?.() === record.targetTile &&
        unit.id?.() !== undefined && !record.knownIds.has(String(unit.id())) &&
        !claimed.has(String(unit.id())));
      if (receipt) {
        record.receipt = String(receipt.id());
        claimed.add(record.receipt);
        // Keep the claim after this record expires before a later pending one.
        for (const other of records) {
          if (other !== record && other.nuke === record.nuke) other.knownIds.add(record.receipt);
        }
      }
    }
    return records.filter((record) => record.receipt === undefined);
  }

  function autoBotBuildNukeSlots(game, player) {
    const pending = autoBotBuildPendingNukes(game, player);
    if (pending.length === 0) return null;
    const silos = player.units("Missile Silo");
    if (silos.some((silo) => typeof silo.id !== "function" ||
      typeof silo.level !== "function" || typeof silo.missileTimerQueue !== "function")) return null;
    const slots = new Map(silos.map((silo) => [String(silo.id()),
      silo.isActive?.() === false || silo.isUnderConstruction?.() === true
        ? 0 : Math.max(0, silo.level() - silo.missileTimerQueue().length)]));
    // DIVERGENCE: replay unacknowledged intents against today's sources; a new
    // closer silo can change the native source of the entire buffered prefix.
    for (const record of pending) {
      let source = null;
      let distance = Infinity;
      for (const silo of silos) {
        if (slots.get(String(silo.id())) <= 0) continue;
        const candidate = game.manhattanDist(silo.tile(), record.targetTile);
        if (candidate < distance) {
          source = silo;
          distance = candidate;
        }
      }
      if (source) slots.set(String(source.id()), slots.get(String(source.id())) - 1);
    }
    return slots;
  }

  function autoBotBuildDispatch(buildMenu, buildable, tile) {
    if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
      return null;
    }
    if (buildable?.canBuild === false && buildable.canUpgrade === false) return null;
    if (buildable?.canBuild !== 0 || buildable.canUpgrade !== false) {
      return buildMenu.sendBuildOrUpgrade.bind(buildMenu, buildable, tile);
    }
    // BuildMenu tests canBuild by truthiness, silently dropping legal TileRef 0.
    // Emit the same native event for this case, without changing the tile.
    const bus = buildMenu.eventBus;
    if (typeof bus?.emit !== "function") return null;
    const Ctor = discoverCtors(bus).buildUnit;
    if (!Ctor) return null;
    return () => {
      bus.emit(new Ctor(buildable.type, tile, buildMenu.uiState?.rocketDirectionUp));
      buildMenu.hideMenu?.();
    };
  }

  function autoBotEconomicPurchaseAllowed({ game, player, buildable, tile, reserved, tick }) {
    const strategy = window.__OFH_hybridStrategy;
    let observedTile = tile;
    const managedUpgrade = strategy?.diagnostics?.().enabled && ["City", "Factory", "Port"].includes(buildable.type)
      && buildable.canUpgrade != null && buildable.canUpgrade !== false;
    if (managedUpgrade) {
      observedTile = strategy.economicUpgradeTile({ game, player, buildable });
      if (observedTile == null || (tile !== undefined && tile !== observedTile)) return false;
    }
    const admission = strategy?.admitEconomicPurchase({
      game, player, buildable, tile: observedTile, reservedGold: reserved, proposalId: buildable.proposalId,
    });
    return !admission?.blocked && (admission?.notBeforeTick == null || tick >= admission.notBeforeTick);
  }

  function autoBotPrepareBuildReservation({ game, player, buildable, trackNuke, tile }) {
    const cost = autoBotBuildCost(buildable);
    if (cost === null) return null;
    const tick = autoBotBuildTick(game);
    const playerId = autoBotBuildPlayerId(player);
    const reservations = (autoBotBuildReservations.get(game) ?? []).filter(
      (reservation) => reservation.expiresAt > tick,
    );
    autoBotBuildReservations.set(game, reservations);
    const reserved = autoBotBuildReservedGold(game, player);
    const gold = player?.gold?.();
    if (typeof gold !== "bigint" || gold - reserved < cost) return null;
    const nuclear = trackNuke && typeof player?.units === "function";
    if (nuclear) {
      const slots = autoBotBuildNukeSlots(game, player);
      if (slots && ![...slots.values()].some((count) => count > 0)) return null;
    }
    if (!autoBotEconomicPurchaseAllowed({ game, player, buildable, tile, reserved, tick })) return null;
    return { cost, tick, playerId, reservations, nuclear };
  }

  function sendAutoBotBuildOrUpgrade(buildMenu, buildable, tile, ...context) {
    const [game, player, trackNuke = false] = context;
    if (game === null || typeof game !== "object") return false;
    const dispatch = autoBotBuildDispatch(buildMenu, buildable, tile);
    if (!dispatch) return false;
    const reservation = autoBotPrepareBuildReservation({ game, player, buildable, trackNuke, tile });
    if (!reservation) return false;
    const { cost, tick, playerId, reservations, nuclear } = reservation;
    // The build menu emits straight onto the EventBus, bypassing emitIntent's
    // consuming gate — but the server's ClientMsgRateLimiter still counts
    // these. Acquire the shared client token here so construction bursts (a
    // structure pass every few ticks under siege, a staggered
    // SAM-overwhelm salvo coming due) are paced locally and cleanly retried
    // by their callers instead of silently dropped server-side.
    if (typeof hasIntentRateLimitCapacity === "function" && !hasIntentRateLimitCapacity()) {
      return false;
    }
    if (
      typeof tryAcquireIntentRateLimit === "function" &&
      !tryAcquireIntentRateLimit(String(buildable.type))
    ) {
      return false;
    }
    const knownIds = nuclear
      ? new Set(player.units(buildable.type).map((unit) => String(unit.id()))) : null;
    dispatch();
    reservations.push({
      playerId,
      cost,
      expiresAt: tick + AUTO_BOT_BUILD_RESERVATION_GRACE_TICKS,
      ...(nuclear ? { nuke: buildable.type, targetTile: tile, knownIds,
        salvoId: trackNuke?.salvoId ?? null } : {}),
    });
    return true;
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
    buildUnit: null,
    spawn: null,
    attack: null,
    cancelAttack: null,
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
      key: "buildUnit",
      args: ["§unit", 0, true],
      matches: (event) =>
        event?.unit === "§unit" && event.tile === 0 && event.rocketDirectionUp === true,
    },
    {
      key: "cancelAttack",
      args: ["§attack"],
      matches: (event) =>
        event?.attackID === "§attack" &&
        event.targetID === undefined &&
        event.troops === undefined,
    },
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
    // The alliance-request ctor is field-identical to SendBreakAlliance-
    // IntentEvent ({requestor, recipient}) so no shape probe can separate
    // them — but the CLASS NAMES differ. Binding by name works wherever the
    // class name survives (the engine harness registers AllianceRequestEvent;
    // the unminified client registers SendAllianceRequestIntentEvent); in a
    // minified browser the name won't match and the lazy accept-sniff in
    // allianceBehavior remains the capture path. Without this, proactive
    // alliance requests are impossible in the harness (nobody ever sends us
    // one to sniff from).
    if (
      _ctors.allianceRequest == null &&
      typeof Ctor === "function" &&
      (Ctor.name === "AllianceRequestEvent" ||
        Ctor.name === "SendAllianceRequestIntentEvent")
    ) {
      _ctors.allianceRequest = Ctor;
    }
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
    if (_ctors.bus !== eventBus) {
      for (const key of Object.keys(_ctors)) _ctors[key] = null;
      _ctors.bus = eventBus;
    }
    if (
      _ctors.bus === eventBus &&
      _ctors.buildUnit &&
      _ctors.attack &&
      _ctors.cancelAttack &&
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
        typeof hasIntentRateLimitCapacity === "function" &&
        !hasIntentRateLimitCapacity()
      ) {
        return false;
      }
      if (
        typeof tryAcquireIntentRateLimit !== "function" ||
        !tryAcquireIntentRateLimit(event?.constructor?.name)
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
      donationStatus: diagnosticValue(state.donationStatus, "unknown"),
      earlyGame: getEarlyGameDiagnostic(state.earlyGame),
      eventsDisplayEvents: getEventsDisplayDiagnostic(),
    };
    if (options.silent !== true) runtimeDebugLog("[AutoBot] DIAG", diag);
    return diag;
  }
  window.__autoBotDiag = diagnose;
