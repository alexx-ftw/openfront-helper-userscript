// Auto-Bot — WarshipBehavior: a faithful 1:1 port of the in-game Nation warship
// AI (src/core/execution/nation/NationWarshipBehavior.ts). Spawns the nation's
// first warship, retaliates with warships when our transport/trade ships are
// captured or when a hostile transport is inbound, repositions idle warships,
// and counters "warship infestations" (an enemy blanketing the ocean to choke
// all trade/transport). Every branch, constant, probability, strategy order and
// call order is preserved exactly. The ONLY changes are the mechanical API
// substitutions mandated by PORT-CONTRACT.md:
//   - DIFFICULTY: src reads the lobby Nation difficulty; the bot REPLICATES a
//     user-chosen difficulty, so each `this.game.config().gameConfig().difficulty`
//     read becomes `currentDifficulty()`.
//   - UnitType.X → UNIT.X.
//   - PLAYER/OWNER IDENTITY: src compares players with `===`; the client wraps
//     players fresh each tick, so identity compares become `.smallID()` (or, where
//     src already used `.id()`, that string-id compare is kept verbatim).
//   - ASYNC + ACTUATION: the client has no synchronous canBuild/addExecution. A
//     warship is built through the build menu: `await player.buildables(waterTile,
//     [UNIT.Warship])` → find the Warship BuildableUnit (`bu.canBuild !== false`)
//     → `getBuildMenu().sendBuildOrUpgrade(bu, waterTile)` (pass the WATER tile, not
//     bu.canBuild — for a warship bu.canBuild is just the in-range port tile). So
//     maybeSpawnWarship() / counterWarshipInfestation() and the build helpers
//     BECOME async (nationExecution awaits maybeSpawnWarship/counterWarshipInfestation).
//     Worker reads are wrapped in withTimeout(p, WORKER_TIMEOUT_MS, fallback).
//   - MOVE WARSHIP: src `warship.updateWarshipState({patrolTile})` is unsupported on
//     the client UnitView. REPLACE with the MoveWarshipIntentEvent:
//     `emitIntent(ctors.moveWarship, [unit.id()], tile)`.
//   - relation: `this.player.updateRelation(enemy, -7.5/-15)` writes the AI-subjective
//     overlay (no intent), exactly as src.
//
// TRACKING-SET IDENTITY: src keeps Set<Unit>/Map<Unit> keyed by engine Unit object
// identity. The client wraps units fresh on every units() call (gameApi wrapUnit has
// NO cache), so a wrapper object never matches across ticks. Per PORT-CONTRACT
// (identity is by id) we key the tracking collections by `unit.id()` (the stable
// engine id) and re-resolve the unit's current state each tick from a per-tick
// id→unit index built off the GLOBAL units list (which still includes a ship after
// it is captured / owned by an enemy). This is the same id-keyed adaptation the
// sibling behaviors use (emojiBehavior.lastEmojiSent, mirvBehavior.recentMirvTargets)
// — not a strategy change.
//
// Loaded with the other behavior modules (after portutil/gameApi and the emoji
// phase, which provides AllPlayers + EMOJI_WARSHIP_RETALIATION), before nationExecution.

"use strict";

  // Client snapshots can lag an accepted build command by several game ticks.
  // Hold one shared reservation across every Warship construction path until a
  // new unit becomes visible or the normal outbound-intent grace expires.
  const WARSHIP_BUILD_INTENT_GRACE_TICKS = 6;
  // A distant fallback transport route can cross most of a large map. Build it
  // incrementally so a single hostile boat cannot freeze the game loop before
  // the naval planner can react.
  const NAVAL_INVASION_ROUTE_SLICE_NODES = 1024;
  // Interception planning probes several future transport positions for every
  // available warship. Each probe must stay small: an unresolved long route can
  // be retried on the next throttled planner pass, whereas one full A* freezes
  // the entire combat tick and prevents every defensive response.
  const NAVAL_INTERCEPTION_ROUTE_MAX_EXPANSIONS = 256;
  // MoveWarship sets only a patrol anchor. Give the engine a short grace after
  // the planned intercept tick to acquire the assigned transport; otherwise
  // release the reservation so planning and ordinary combat can resume.
  const NAVAL_INTERCEPT_CONFIRMATION_GRACE_TICKS = 3;
  const navalInterceptionBuildCandidateLimit = 12;
  // Dense A* needs three Int32 buffers (12 bytes per map tile). On very large
  // maps their first allocation is a visible frame spike; the existing sparse
  // route state is exact and scales with the route search instead of map area.
  const NAVAL_DENSE_ROUTE_MAX_TILES = 262_144;

  // ── Warship move-intent pacing ──────────────────────────────────────────────
  // MoveWarship consumes the SHARED client intent budget (10/s, 150/min — the
  // same tokens as attacks, builds and donations). Unpaced micromanagement
  // starves those producers and trips the limiter, so combat moves are gated
  // three ways: a target must change by more than the hysteresis radius
  // before a ship is re-tasked, each combat pass may emit at most a couple of
  // moves, and a reserve of the token budget is left for non-warship
  // producers at all times.
  const WARSHIP_MOVE_RETARGET_RADIUS = 8;
  const WARSHIP_MOVE_RETARGET_TICKS = 30;
  const WARSHIP_COMBAT_PASS_MOVE_CAP = 2;
  const WARSHIP_MOVE_SECOND_TOKEN_RESERVE = 2;
  const WARSHIP_MOVE_MINUTE_TOKEN_RESERVE = 40;
  // Nuke dodging is survival-critical and gets a shorter leash than ordinary
  // micro: a small cooldown against per-tick escape churn (the best tile
  // drifts with the incoming zones) and a thinner budget reserve.
  const WARSHIP_DODGE_COOLDOWN_TICKS = 10;
  const WARSHIP_DODGE_SECOND_TOKEN_RESERVE = 1;
  const WARSHIP_DODGE_MINUTE_TOKEN_RESERVE = 10;

  function canUseDenseWaterRouteBuffers(total) {
    return (
      Number.isSafeInteger(total) &&
      total > 0 &&
      total <= NAVAL_DENSE_ROUTE_MAX_TILES
    );
  }

  function getWarshipRuntimeHost() {
    if (typeof window !== "undefined") return window;
    if (typeof globalThis !== "undefined") return globalThis;
    return null;
  }

  function readWarshipPositiveValue(object, names) {
    for (const name of names) {
      {
        const value = typeof object?.[name] === "function" ? object[name]() : object?.[name];
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
      }
    }
    return null;
  }

  function isCompletedWarshipPort(port) {
    {
      return typeof port?.isUnderConstruction !== "function" || !port.isUnderConstruction();
    }
  }

  class WarshipRouteHeap {
    constructor() { this.entries = []; }
    get length() { return this.entries.length; }
    push(entry) {
      this.entries.push(entry);
      let index = this.entries.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.entries[parent].priority <= this.entries[index].priority) break;
        [this.entries[parent], this.entries[index]] = [this.entries[index], this.entries[parent]];
        index = parent;
      }
    }
    pop() {
      if (this.entries.length === 0) return null;
      const first = this.entries[0];
      const last = this.entries.pop();
      if (this.entries.length > 0 && last) {
        this.entries[0] = last;
        this.siftDown();
      }
      return first;
    }
    siftDown() {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.entries.length &&
          this.entries[left].priority < this.entries[smallest].priority) smallest = left;
        if (right < this.entries.length &&
          this.entries[right].priority < this.entries[smallest].priority) smallest = right;
        if (smallest === index) return;
        [this.entries[index], this.entries[smallest]] =
          [this.entries[smallest], this.entries[index]];
        index = smallest;
      }
    }
  }

  class WarshipBehavior {
    constructor(random, game, player, emojiBehavior) {
      this.random = random;
      this.game = game;
      this.player = player;
      this.emojiBehavior = emojiBehavior;

      // Track our transport ships we currently own (src: Set<Unit>; we key by id).
      this.trackedTransportShips = new Set(); // unitId
      // Track our trade ships we currently own (src: Set<Unit>; we key by id).
      this.trackedTradeShips = new Set(); // unitId
      // Track incoming transport ships (src: Set<Unit>; we key by id).
      this.trackedIncomingTransportShips = new Set(); // unitId
      // Track incoming transport ships we have dealt with (src: Set<Unit>; we key by id).
      this.dealtWithTransportShip = new Set(); // unitId
    }

    // ── per-tick id→unit index over a GLOBAL units list. A captured/handed-off
    //    ship is no longer in me.units() but IS in game.units(type), so resolving
    //    current owner()/isActive()/targetTile() must go through the global list.
    indexById(units) {
      const m = new Map();
      for (const u of units) m.set(u.id(), u);
      return m;
    }

    incomingMaritimeInvasionSignal() {
      {
        const host = getWarshipRuntimeHost();
        if (
          host &&
          typeof host.__OFH_getIncomingMaritimeTransport === "function"
        ) {
          return host.__OFH_getIncomingMaritimeTransport(this.game, this.player);
        }
        if (
          host &&
          typeof host.__OFH_getIncomingMaritimeInvasion === "function"
        ) {
          return host.__OFH_getIncomingMaritimeInvasion(this.game, this.player);
        }
      }
      return null;
    }

    // maybeSpawnWarship — NationWarshipBehavior.maybeSpawnWarship (now async).
    getInitialWarshipPort() {
      const ports = this.player.units(UNIT.Port).filter(isCompletedWarshipPort);
      if (ports.length === 0 || this.player.units(UNIT.Warship).length > 0) return null;
      if (this.player.gold() < this.cost(UNIT.Warship)) return null;
      return this.random.randElement(ports);
    }

    async maybeSpawnWarship() {
      if (this.player === null) throw new Error("not initialized");
      if (this.game.config().isUnitDisabled(UNIT.Warship)) {
        return false;
      }
      const smartState = this.ensureSmartState();
      if (
        smartState.lastInvasionBuildTick === this.game.ticks() ||
        this.hasPendingWarshipBuild(smartState)
      ) {
        return false;
      }
      const maritimeEmergency =
        this.incomingMaritimeInvasionSignal()?.active === true;
      if (this.shouldDeferWarshipBuild(maritimeEmergency)) {
        return false;
      }
      // A live transport aimed at our territory bypasses the ordinary 50% spawn
      // roll: the Port-first structure policy has already reserved the gold and
      // this phase must get the first available destroyer onto the water.
      if (!maritimeEmergency && !this.random.chance(2)) {
        return false;
      }
      const port = this.getInitialWarshipPort();
      if (port) {
        const targetTile = this.warshipSpawnTile(port.tile(), 250);
        if (targetTile === null) {
          return false;
        }
        // src: canBuild = player.canBuild(Warship, targetTile); if false → return.
        // Client: probe buildables on the WATER targetTile, find the Warship
        // BuildableUnit; canBuild !== false stands in for the sync canBuild check.
        const bu = await this.buildableWarship(targetTile);
        if (bu === null || bu === undefined || bu.canBuild === false) {
          return false;
        }
        // src: game.addExecution(new ConstructionExecution(player, Warship, targetTile)).
        // Client: fire through the build menu, aimed at the WATER targetTile.
        return this.tryEmitWarshipBuild(
          bu,
          targetTile,
          tr("🚢 Deploy warship"),
          "initial",
        );
      }
      return this.maybeSpawnRaidingWarship(smartState);
    }

    // Legendary raiding fleet: with hostile trade traffic on the water and a
    // completed Port, keep building warships toward a bounded fleet. Captures
    // fund the nuclear economy and 25 of them promote a ship to veterancy 3.
    legendaryArsenalReserve() {
      if (!this.raidingTierActive()) return 0n;
      const structures = this.player.units(UNIT.MissileSilo) || [];
      if (structures.length > 0) return 0n;
      const cities = this.player.units(UNIT.City) || [];
      const ports = this.player.units(UNIT.Port) || [];
      if (cities.length < 2 || ports.length === 0) return 0n;
      return 1_000_000n;
    }

    async maybeSpawnRaidingWarship(smartState) {
      if (smartState.lastInvasionBuildTick === this.game.ticks()) return false;
      if (this.hasPendingWarshipBuild(smartState)) return false;
      if (!this.raidingTierActive()) return false;
      const ports = this.player.units(UNIT.Port).filter(isCompletedWarshipPort);
      if (ports.length === 0) return false;
      const fleet = this.player.units(UNIT.Warship).length;
      const traffic = this.game.units(UNIT.TradeShip).length;
      const fleetCap = Math.max(2, Math.min(8, 2 + Math.floor(traffic / 40)));
      if (fleet >= fleetCap) return false;
      const warshipCost = this.cost(UNIT.Warship);
      const arsenalReserve = this.legendaryArsenalReserve();
      if (
        fleet > 0 &&
        this.player.gold() < warshipCost + warshipCost / 2n + arsenalReserve
      ) {
        return false;
      }
      const port = this.random.randElement(ports);
      const targetTile = this.warshipSpawnTile(port.tile(), 250);
      if (targetTile === null) return false;
      const bu = await this.buildableWarship(targetTile);
      if (bu === null || bu === undefined || bu.canBuild === false) {
        return false;
      }
      return this.tryEmitWarshipBuild(
        bu,
        targetTile,
        tr("🏴‍☠️ Raid fleet"),
        "raiding",
      );
    }

    shouldDeferWarshipForDefense(warshipCost) {
      return (
        this.structureBehavior?.shouldDeferOffensiveWarship?.(warshipCost) ===
        true
      );
    }

    shouldDeferWarshipBuild(maritimeEmergency) {
      const cost = this.cost(UNIT.Warship);
      if (this.shouldDeferWarshipForFirstSam(cost)) return true;
      return !maritimeEmergency && this.shouldDeferWarshipForDefense(cost);
    }

    shouldDeferWarshipForFirstSam(warshipCost) {
      return (
        this.structureBehavior?.shouldDeferWarshipForFirstSam?.(warshipCost) ===
        true
      );
    }

    // warshipSpawnTile — NationWarshipBehavior.warshipSpawnTile (private).
    warshipSpawnTile(portTile, radius) {
      for (let attempts = 0; attempts < 50; attempts++) {
        const randX = this.random.nextInt(
          this.game.x(portTile) - radius,
          this.game.x(portTile) + radius,
        );
        const randY = this.random.nextInt(
          this.game.y(portTile) - radius,
          this.game.y(portTile) + radius,
        );
        if (!this.game.isValidCoord(randX, randY)) {
          continue;
        }
        const tile = this.game.ref(randX, randY);
        // Sanity check
        if (!this.game.isWater(tile)) {
          continue;
        }
        return tile;
      }
      return null;
    }

    trackShipsAndRetaliate() {
      this.trackTransportShipsAndRetaliate();
      this.trackTradeShipsAndRetaliate();
      this.trackIncomingTransportsAndRetaliate();
    }

    // Send out a warship if our transport ship got captured
    // trackTransportShipsAndRetaliate — NationWarshipBehavior (private).
    //
    // DIVERGENCE: src distinguishes arrival/retreat from enemy destruction via
    // `ship.wasDestroyedByEnemy()` + `ship.destroyer()`. NEITHER accessor exists on
    // the client UnitView (UnitView.ts:97-280 has no wasDestroyedByEnemy/destroyer,
    // and gameApi wrapUnit does not wrap them — gameApi.js:75-99). UnitState carries
    // `lastOwnerID`, but that is OUR id (the prior owner), not the destroyer, so it
    // cannot identify the `enemy` that maybeRetaliateWithWarship requires. We
    // therefore CANNOT detect a transport-destroyed-by-enemy event client-side: the
    // retaliation branch is ported but guarded so it never fires. (We still maintain
    // the tracking set so the rest of the structure stays a 1:1 diff.)
    trackTransportShipsAndRetaliate() {
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) {
        return;
      }
      // Add any currently owned transport ships to our tracking set (by id).
      this.player
        .units(UNIT.TransportShip)
        .forEach((u) => this.trackedTransportShips.add(u.id()));

      // Resolve current state from the global transport index (a destroyed ship
      // simply drops out of the index → !isActive()).
      const index = this.indexById(this.game.units(UNIT.TransportShip));

      // Iterate tracked transport ships; if it got destroyed by an enemy: retaliate.
      for (const shipId of Array.from(this.trackedTransportShips)) {
        const ship = index.get(shipId);
        const isActive = ship !== undefined && ship.isActive();
        if (!isActive) {
          // Distinguish between arrival/retreat and enemy destruction.
          // DIVERGENCE: wasDestroyedByEnemy()/destroyer() are unavailable on the
          // client UnitView, so this guard is always false and the retaliation
          // cannot fire (see method header). src body, for reference:
          //   if (ship.wasDestroyedByEnemy() && ship.destroyer() !== undefined) {
          //     this.maybeRetaliateWithWarship(ship.tile(), ship.destroyer(), "transport");
          //   }
          if (
            ship !== undefined &&
            typeof ship.wasDestroyedByEnemy === "function" &&
            typeof ship.destroyer === "function" &&
            ship.wasDestroyedByEnemy() &&
            ship.destroyer() !== undefined
          ) {
            this.maybeRetaliateWithWarship(
              ship.tile(),
              ship.destroyer(),
              "transport",
            );
          }
          this.trackedTransportShips.delete(shipId);
        }
      }
    }

    // Send out a warship if our trade ship got captured
    // trackTradeShipsAndRetaliate — NationWarshipBehavior (private).
    // Trade-capture-by-owner-change IS detectable client-side: a captured trade
    // ship leaves me.units() but remains in the GLOBAL trade index owned by its new
    // owner, so `ship.owner().id() !== this.player.id()` is faithfully observable.
    trackTradeShipsAndRetaliate() {
      // Add any currently owned trade ships to our tracking map (by id).
      this.player
        .units(UNIT.TradeShip)
        .forEach((u) => this.trackedTradeShips.add(u.id()));

      // Resolve current state from the global trade index (includes ships now owned
      // by someone else after capture).
      const index = this.indexById(this.game.units(UNIT.TradeShip));

      // Iterate tracked trade ships; if we no longer own it, it was captured: retaliate.
      for (const shipId of Array.from(this.trackedTradeShips)) {
        const ship = index.get(shipId);
        if (ship === undefined || !ship.isActive()) {
          this.trackedTradeShips.delete(shipId);
          continue;
        }
        if (ship.owner().id() !== this.player.id()) {
          // Ship was ours and is now owned by someone else -> captured
          this.maybeRetaliateWithWarship(ship.tile(), ship.owner(), "trade");
          this.trackedTradeShips.delete(shipId);
        }
      }
    }

    // trackIncomingTransportsAndRetaliate — NationWarshipBehavior (private).
    isIncomingHostileTransport(transport) {
      return this.isHostileIncomingTransport(
        transport,
        this.player?.smallID?.(),
      );
    }

    removeTrackedIncomingTransport(id) {
      this.trackedIncomingTransportShips.delete(id);
      this.dealtWithTransportShip.delete(id);
    }

    hasWarshipDefendingTarget(target) {
      if (this.game.hasUnitNearby(target, 90, UNIT.Warship, this.player.id(), true)) {
        return true;
      }
      return this.player.units(UNIT.Warship).some((warship) => {
        const patrolTile = warship.warshipState().patrolTile;
        return patrolTile !== undefined && this.game.manhattanDist(target, patrolTile) < 90;
      });
    }

    processTrackedIncomingTransport(transportId, transport) {
      // Revalidate the complete threat, not merely the unit lifecycle. The
      // landing tile can change owner and diplomacy can change after the ship
      // entered the tracked set; neither transition should retain or actuate a
      // stale interception.
      if (!transport || !this.isIncomingHostileTransport(transport)) {
        this.removeTrackedIncomingTransport(transportId);
        return false;
      }
      const target = transport.targetTile();
      if (this.dealtWithTransportShip.has(transportId)) return false;
      if (this.game.manhattanDist(transport.tile(), target) < 20) {
        this.dealtWithTransportShip.add(transportId);
        return false;
      }
      if (this.hasWarshipDefendingTarget(target)) {
        this.dealtWithTransportShip.add(transportId);
        return false;
      }
      const oceanTile = this.warshipSpawnTile(target, 30);
      if (oceanTile === null) return false;
      this.maybeRetaliateWithWarship(oceanTile, transport.owner(), "transport");
      this.dealtWithTransportShip.add(transportId);
      return true;
    }

    trackIncomingTransportsAndRetaliate() {
      // Add any transports which are targeting us to our tracking map (by id).
      this.game
        .units(UNIT.TransportShip)
        .filter((transport) => this.isIncomingHostileTransport(transport))
        .forEach((p) => this.trackedIncomingTransportShips.add(p.id()));

      // Per-tick global index so we can re-resolve each tracked transport by id.
      const index = this.indexById(this.game.units(UNIT.TransportShip));

      for (const transportId of Array.from(this.trackedIncomingTransportShips)) {
        if (this.processTrackedIncomingTransport(transportId, index.get(transportId))) break;
      }
    }

    // maybeRetaliateWithWarship — NationWarshipBehavior (private).
    // This is invoked from the SYNC tracker chain (trackShipsAndRetaliate, which
    // nationExecution calls UN-awaited), so every src gate and the RNG roll stay
    // synchronous — per-branch probability is exact (one nextInt(0,100) per call).
    // Only the warship BUILD is async on the client (buildables probe + build menu),
    // so it is fire-and-forget (`void this._retaliateBuildAsync(...)`). Cross-behavior
    // RNG *ordering* is explicitly not a faithfulness requirement (portutil
    // PseudoRandom note), so deferring the actuation off the RNG draw is fine.
    maybeRetaliateWithWarship(tile, enemy, reason) {
      // Ownership changes are observed after the capture, so diplomacy may
      // already have changed by the time this tracker processes the ship.
      // Never turn a stale capture observation into an attack on a teammate or
      // ally. isFriendly() is the canonical union of both relationships.
      if (
        enemy.smallID() === this.player.smallID() ||
        this.player.isFriendly?.(enemy) === true
      ) {
        return;
      }

      // Don't send too many warships
      if (this.player.units(UNIT.Warship).length >= 10) {
        this.maybeMoveWarship(tile);
        return;
      }

      const difficulty = currentDifficulty();
      // In Easy never retaliate. In Medium retaliate with 15% chance. Hard with
      // 50%, Impossible with 80%, and Legendary always retaliates: attack is
      // the preferred defense against maritime pressure.
      if (
        (difficulty === Difficulty.Medium && this.random.nextInt(0, 100) < 15) ||
        (difficulty === Difficulty.Hard && this.random.nextInt(0, 100) < 50) ||
        (difficulty === Difficulty.Impossible && this.random.nextInt(0, 100) < 80) ||
        difficulty === Difficulty.Legendary
      ) {
        // src: canBuild(Warship, tile) → addExecution / else maybeMoveWarship; then
        // emoji + relation. The buildables probe is async, so defer it; the canBuild
        // gate, build-vs-move fallback, and emoji+relation-on-success are preserved
        // inside _retaliateBuildAsync exactly as src ordered them.
        void this._retaliateBuildAsync(tile, enemy, reason);
      }
    }

    // The async tail of maybeRetaliateWithWarship: probe Warship buildability on the
    // WATER `tile`, build it through the menu (passing the WATER tile, not bu.canBuild)
    // and then emote + apply the relation malus — mirroring src order:
    //   canBuild === false → maybeMoveWarship(tile); return;
    //   else addExecution(ConstructionExecution); maybeSendEmoji; updateRelation.
    // This promise is deliberately allowed to reject so integration failures remain visible.
    async _retaliateBuildAsync(tile, enemy, reason) {
      {
        if (this.player.isFriendly?.(enemy) === true) return;
        if (this.hasPendingWarshipBuild()) return;
        if (this.shouldDeferWarshipBuild(false)) return;
        const bu = await this.buildableWarship(tile);
        // The buildability probe yields to the client. Revalidate diplomacy at
        // actuation time so an alliance formed while it was pending cannot
        // receive a warship build or a relation penalty from stale evidence.
        if (this.player.isFriendly?.(enemy) === true) return;
        if (bu === null || bu === undefined || bu.canBuild === false) {
          this.maybeMoveWarship(tile);
          return;
        }
        if (
          !this.tryEmitWarshipBuild(
            bu,
            tile,
            tr("🚢 Retaliate warship"),
            "retaliation",
          )
        ) return;
        this.emojiBehavior.maybeSendEmoji(enemy, EMOJI_WARSHIP_RETALIATION);
        this.player.updateRelation(enemy, reason === "trade" ? -7.5 : -15);
      }
    }

    // maybeMoveWarship — NationWarshipBehavior (private).
    maybeMoveWarship(tile) {
      // Make sure we are targeting water
      if (this.game.isWater(tile)) {
        const warship = this.selectClosestIdleWarship(tile, null, 0, 0)?.warship;

        if (warship) {
          // src: warship.updateWarshipState({ patrolTile: tile });
          // Client: MoveWarshipIntentEvent([unitId], tile).
          // A patrol anchor is the lowest-priority intent a warship emits;
          // never let it take a token that attacks, builds or dodges need.
          if (!this.warshipMoveBudgetAvailable()) return;
          const ctors = discoverCtors(getEventBus());
          if (ctors.moveWarship) {
            emitIntent(ctors.moveWarship, [warship.id()], tile);
          }
        }
      }
    }

    // Prevent warship infestations: if current player is one of the 3 richest and an enemy has too many warships, send a counter-warship.
    // What is a warship infestation? A player tries to dominate the entire ocean to block all trade and transport boats.
    // counterWarshipInfestation — NationWarshipBehavior (now async: builds a warship).
    async counterWarshipInfestation() {
      if (!this.shouldCounterWarshipInfestation()) {
        return;
      }

      const isTeamGame = this.player.team() !== null;

      if (!this.isRichPlayer(isTeamGame)) {
        return;
      }

      const target = this.findWarshipInfestationCounterTarget(isTeamGame);
      if (target !== null) {
        await this.buildCounterWarship(target);
      }
    }

    // shouldCounterWarshipInfestation — NationWarshipBehavior (private).
    shouldCounterWarshipInfestation() {
      if (this.game.config().isUnitDisabled(UNIT.Warship)) {
        return false;
      }

      const smartState = this.ensureSmartState();
      if (
        smartState.lastInvasionBuildTick === this.game.ticks() ||
        smartState.pendingInvasionBuilds.size > 0
      ) {
        return false;
      }

      // Only the smart nations can do this
      const difficulty = currentDifficulty();
      if (!isAtLeastHardDifficulty(difficulty)) {
        return false;
      }

      // Quit early if there aren't many warships in the game
      if (this.game.unitCount(UNIT.Warship) <= 10) {
        return false;
      }

      // Quit early if we can't afford a warship
      if (this.cost(UNIT.Warship) > this.player.gold()) {
        return false;
      }

      // Quit early if we don't have a port to send warships from
      if (this.player.units(UNIT.Port).length === 0) {
        return false;
      }

      // Don't send too many warships
      if (this.player.units(UNIT.Warship).length >= 10) {
        return false;
      }

      return true;
    }

    // Check if current player is one of the 3 richest (We don't want poor nations to use their precious gold on this)
    // isRichPlayer — NationWarshipBehavior (private).
    // The browser adapter represents the automated player as Human, while the
    // upstream Nation remains in the candidate pool. Exclude other Humans as
    // upstream does, but retain the current player so the rich-player gate can
    // actually activate the counter-infestation defense.
    isRichPlayer(isTeamGame) {
      const players = this.game.players().filter((p) => {
        if (p.type() === PlayerType.Human && p.id() !== this.player.id()) return false;
        // src: `p.team() === this.player.team()` — team is a team id, keep `===`.
        return isTeamGame ? p.team() === this.player.team() : true;
      });
      const topThree = players
        .sort((a, b) => Number(b.gold() - a.gold()))
        .slice(0, 3);
      // src: `p.id() === this.player.id()` — string id, kept verbatim.
      return topThree.some((p) => p.id() === this.player.id());
    }

    // findWarshipInfestationCounterTarget — NationWarshipBehavior (private).
    findWarshipInfestationCounterTarget(isTeamGame) {
      return isTeamGame
        ? this.findTeamGameWarshipTarget()
        : this.findFreeForAllWarshipTarget();
    }

    collectEnemyTeamWarships() {
      const enemyTeamWarships = new Map();
      for (const p of this.game.players()) {
        // Skip friendly players (our team and allies)
        // src: `p.id() === this.player.id()` — string id, kept verbatim.
        if (this.player.isFriendly(p) || p.id() === this.player.id()) {
          continue;
        }

        const team = p.team();
        if (team === null) continue;

        const teamKey = team.toString();
        const warshipCount = p.units(UNIT.Warship).length;

        if (!enemyTeamWarships.has(teamKey)) {
          enemyTeamWarships.set(teamKey, {
            count: 0,
            team: teamKey,
            players: [],
          });
        }
        const teamData = enemyTeamWarships.get(teamKey);
        teamData.count += warshipCount;
        teamData.players.push(p);
      }
      return enemyTeamWarships;
    }

    getInfestedTeamTarget(teamData) {
      if (teamData.count <= 15) return null;
      const player = teamData.players.reduce((best, candidate) => {
        if (!best) return candidate;
        return candidate.units(UNIT.Warship).length > best.units(UNIT.Warship).length
          ? candidate
          : best;
      }, null);
      const warships = player?.units(UNIT.Warship) ?? [];
      return warships.length > 3
        ? { player, warship: this.random.randElement(warships) }
        : null;
    }

    // findTeamGameWarshipTarget — NationWarshipBehavior (private).
    findTeamGameWarshipTarget() {
      for (const teamData of this.collectEnemyTeamWarships().values()) {
        const target = this.getInfestedTeamTarget(teamData);
        if (target) return target;
      }
      return null;
    }

    // findFreeForAllWarshipTarget — NationWarshipBehavior (private).
    findFreeForAllWarshipTarget() {
      const enemies = this.game
        .players()
        // src: `p.id() === this.player.id()` — string id, kept verbatim.
        .filter((p) => !this.player.isFriendly(p) && p.id() !== this.player.id());

      for (const enemy of enemies) {
        const enemyWarships = enemy.units(UNIT.Warship);
        if (enemyWarships.length > 10) {
          return {
            player: enemy,
            warship: this.random.randElement(enemyWarships),
          };
        }
      }

      return null;
    }

    // buildCounterWarship — NationWarshipBehavior (private, now async).
    async buildCounterWarship(target) {
      if (this.hasPendingWarshipBuild()) return;
      const tile = target.warship.tile();
      // src: canBuild = player.canBuild(Warship, target.warship.tile()); if false →
      // move + return. Client: probe buildables on the enemy warship's WATER tile.
      const bu = await this.buildableWarship(tile);
      if (bu === null || bu === undefined || bu.canBuild === false) {
        this.maybeMoveWarship(tile);
        return;
      }

      // src: game.addExecution(new ConstructionExecution(player, Warship, tile)).
      if (
        !this.tryEmitWarshipBuild(
          bu,
          tile,
          tr("🚢 Counter warship"),
          "counter",
        )
      ) return;
      this.emojiBehavior.sendEmoji(AllPlayers, EMOJI_WARSHIP_RETALIATION);
    }

    // ── build/probe helpers (the client async/build-menu actuation) ────────────

    // Probe buildables for a Warship on a WATER tile. Returns the Warship
    // BuildableUnit ({type, canBuild, canUpgrade, cost}) or null. canBuild !== false
    // is the client stand-in for the src sync canBuild(Warship, tile) check.
    async buildableWarship(waterTile) {
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(waterTile, [UNIT.Warship]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      return Array.isArray(buildables)
        ? buildables.find((b) => b.type === UNIT.Warship) ?? null
        : null;
    }

    // cost — src reads unitInfo(type).cost(game, player). The Warship cost fn
    // (Config.ts:289-296) is a SELF-CONTAINED pure formula with no client-missing
    // dependency: `min(1_000_000, (numWarships + 1) * 250_000)` where numWarships is
    // the player's BUILT warship count (costWrapper, Config.ts:470-489 →
    // min(unitsOwned, unitsConstructed); for the engine these are count+count, for a
    // Nation with N built warships that is just N). We reproduce the formula directly
    // and synchronously (no engine-cost-fn call: it would run on the raw __src view,
    // whose unitsOwned/unitsConstructed may be absent or boolean-typed, breaking the
    // Math.min). gold is BigInt so we return a BigInt. This behavior only ever
    // queries the Warship cost.
    cost(type) {
      if (type === UNIT.Warship) {
        const numUnits = this.player.unitsOwned(UNIT.Warship); // built warship count
        return BigInt(Math.min(1_000_000, (numUnits + 1) * 250_000));
      }
      return 0n;
    }

    // ── SMART WARSHIP PATROL (WIN-FIX — NOT in src) ────────────────────────────
    // The faithful behavior above mostly BUILDS a warship in response to a threat (and
    // only MOVES an existing one when capped at 10 / it can't build). This winFix layer
    // does the opposite — it REPOSITIONS our EXISTING idle warships to the single
    // highest-priority naval threat each pass, so a 1-2 ship pool actually defends:
    //   P1  a fresh TRADE-RAID lane (our trade ship just captured) → kill the lingering
    //       raider so that lane's FUTURE trade ships survive
    //   P2  a persistent open-water BOAT-LOSS zone (a sea lane where our boats keep
    //       dying, FAR from any coast → a lurking raider). Our boats are cheap 1%
    //       probes, so this clears a recurring loss LANE, never chases one lost probe.
    // Tiny-pool-safe: serves ONLY the top threat per pass, throttled, per-warship
    // debounced, and distance-capped (won't drag a ship across the map to a lost cause).
    // Pure movement (no gold spend); the faithful path still grows the pool by building.
    // Shared winFix scratch state for smartWarshipPatrol + dodgeNukes. Created once
    // with the FULL shape so whichever method runs first this tick can't leave a
    // partial object that starves the other (both read smartState.cooldown).
    ensureSmartState() {
      if (this.smartState) return this.smartState;
      this.smartState = {
        transportPos: new Map(), // ourTransportId -> {x,y,tx,ty}
        tradePos: new Map(), // ourTradeId -> {x,y}
        losses: [], // [{x,y,at}] open-water boat losses
        raids: [], // [{x,y,at}] trade-raid tiles
        cooldown: new Map(), // warshipId -> tick last tasked
        serviced: new Map(), // zoneCellKey -> tick a ship was last sent to that zone
        lastPassMs: 0,
        lastInvasionBuildTick: -1,
        lastInvasionPlanMs: 0,
        invasionPlan: null,
        invasionAssignments: new Map(), // warshipId -> { invasionId, landingTick }
        invasionRouteCache: new Map(),
        invasionRouteBuilders: new Map(),
        pendingInvasionBuilds: new Set(),
        invasionBuildAttemptAt: new Map(),
        pendingWarshipBuild: null,
        raidFlagshipId: null,
        raidAnchorSource: null,
      };
      return this.smartState;
    }

    currentWarshipBuildSnapshot() {
      const warships = this.player.units(UNIT.Warship);
      const ids = new Set();
      for (const warship of warships) {
        const id = warship?.id?.();
        if (id !== null && id !== undefined) ids.add(String(id));
      }
      return { ids, count: warships.length };
    }

    hasPendingWarshipBuild(smartState = this.ensureSmartState()) {
      const pending = smartState.pendingWarshipBuild;
      if (pending === null) return false;
      const current = this.currentWarshipBuildSnapshot();
      const accepted =
        current.count > pending.baselineCount ||
        [...current.ids].some((id) => !pending.baselineIds.has(id));
      if (accepted) {
        smartState.pendingWarshipBuild = null;
        return false;
      }
      const age = this.game.ticks() - pending.createdTick;
      if (age <= WARSHIP_BUILD_INTENT_GRACE_TICKS) return true;
      smartState.pendingWarshipBuild = null;
      return false;
    }

    tryEmitWarshipBuild(bu, tile, action, purpose) {
      // Every Warship construction path converges here, including retaliation,
      // infestation counters and emergency interceptors.  Those paths used to
      // bypass maybeSpawnWarship's first-SAM reserve and could repeatedly spend
      // the launcher fund after an external Silo was already visible.
      if (this.shouldDeferWarshipForFirstSam(this.cost(UNIT.Warship))) {
        return false;
      }
      const smartState = this.ensureSmartState();
      if (this.hasPendingWarshipBuild(smartState)) return false;
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") return false;
      const baseline = this.currentWarshipBuildSnapshot();
      if (!sendAutoBotBuildOrUpgrade(buildMenu, bu, tile, this.game, this.player)) {
        return false;
      }
      smartState.pendingWarshipBuild = {
        createdTick: this.game.ticks(),
        baselineIds: baseline.ids,
        baselineCount: baseline.count,
        tile,
        purpose,
      };
      state.stats.builds++;
      setLastAction(action, "naval");
      return true;
    }

    // Read a movement speed when a newer client exposes one. OpenFront's current
    // TransportShipExecution has ticksPerMove=1 and WarshipExecution advances one
    // WaterPathFinder step per tick, so the documented fallback is one tile/tick.
    movementSpeed(unit, type) {
      const config = this.game.config?.();
      const objects = [unit, unit?.__src, config].filter(Boolean);
      const speedNames =
        type === UNIT.TransportShip
          ? ["transportShipSpeed", "boatSpeed", "speed"]
          : ["warshipSpeed", "destroyerSpeed", "speed"];
      const ticksNames =
        type === UNIT.TransportShip
          ? ["transportShipTicksPerMove", "boatTicksPerMove", "ticksPerMove"]
          : ["warshipTicksPerMove", "destroyerTicksPerMove", "ticksPerMove"];
      for (const object of objects) {
        const speed = readWarshipPositiveValue(object, speedNames);
        if (speed !== null) return speed;
        const ticks = readWarshipPositiveValue(object, ticksNames);
        if (ticks !== null) return 1 / ticks;
      }
      return NAVAL_INTERCEPTION_DEFAULT_SPEED;
    }

    warshipAttackRange() {
      const config = this.game.config?.();
      for (const name of ["warshipTargettingRange", "warshipAttackRange", "warshipRange"]) {
        {
          const value = typeof config?.[name] === "function" ? config[name]() : config?.[name];
          if (Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
        }
      }
      return NAVAL_INTERCEPTION_DEFAULT_RANGE;
    }

    waterDistance(a, b) {
      {
        if (typeof this.game.euclideanDistSquared === "function") {
          return Math.sqrt(Math.max(0, Number(this.game.euclideanDistSquared(a, b))));
        }
        return Math.hypot(this.game.x(a) - this.game.x(b), this.game.y(a) - this.game.y(b));
      }
    }

    // A* over the same cardinal water graph used by the client-facing map API.
    // MoveWarshipExecution validates the component server-side; this route keeps
    // the target in that component and gives the interception planner a real ETA.
    warshipRouteHeuristic(tile, goal) {
      { return this.game.manhattanDist(tile, goal); }
    }

    createWaterRouteState(start, goal, persistent = false) {
      if (persistent) return this.createSparseWaterRouteState(start);
      return this.createDenseWaterRouteState(start, goal) ??
        this.createSparseWaterRouteState(start);
    }

    createSparseWaterRouteState(start) {
      return {
        open: new WarshipRouteHeap(),
        dense: false,
        start,
        gScore: new Map([[start, 0]]),
        cameFrom: new Map(),
        closed: new Set(),
      };
    }

    createDenseWaterRouteState(start, goal) {
      const width = Number(this.game.width?.());
      const height = Number(this.game.height?.());
      const total = width * height;
      if (
        Number.isInteger(start) &&
        Number.isInteger(goal) &&
        canUseDenseWaterRouteBuffers(total) &&
        start >= 0 &&
        start < total &&
        goal >= 0 &&
        goal < total
      ) {
        let scratch = this._denseWaterRouteScratch;
        if (scratch?.status?.length !== total) {
          scratch = {
            status: new Int32Array(total),
            gScore: new Int32Array(total),
            cameFrom: new Int32Array(total),
            generation: 0,
          };
          this._denseWaterRouteScratch = scratch;
        }
        let generation = scratch.generation + 1;
        if (generation >= 2_147_483_647) {
          scratch.status.fill(0);
          generation = 1;
        }
        scratch.generation = generation;
        scratch.status[start] = generation;
        scratch.gScore[start] = 0;
        scratch.cameFrom[start] = -1;
        return {
          open: new WarshipRouteHeap(),
          dense: true,
          start,
          generation,
          status: scratch.status,
          gScore: scratch.gScore,
          cameFrom: scratch.cameFrom,
        };
      }
      return null;
    }

    waterRouteNodeClosed(routeState, tile) {
      return routeState.dense
        ? routeState.status[tile] === -routeState.generation
        : routeState.closed.has(tile);
    }

    waterRouteNodeScore(routeState, tile) {
      if (!routeState.dense) return routeState.gScore.get(tile) ?? Infinity;
      return Math.abs(routeState.status[tile]) === routeState.generation
        ? routeState.gScore[tile]
        : Infinity;
    }

    setWaterRouteNode(routeState, tile, parent, score) {
      if (routeState.dense) {
        routeState.status[tile] = routeState.generation;
        routeState.gScore[tile] = score;
        routeState.cameFrom[tile] = parent;
        return;
      }
      routeState.cameFrom.set(tile, parent);
      routeState.gScore.set(tile, score);
    }

    closeWaterRouteNode(routeState, tile) {
      if (routeState.dense) {
        routeState.status[tile] = -routeState.generation;
        return;
      }
      routeState.closed.add(tile);
    }

    reconstructWaterRoute(routeState, goal) {
      const path = [goal];
      let cursor = goal;
      while (cursor !== routeState.start) {
        cursor = routeState.dense
          ? routeState.cameFrom[cursor]
          : routeState.cameFrom.get(cursor);
        path.push(cursor);
      }
      return path.reverse();
    }

    visitWaterRouteNeighbor(neighbor, current, routeState, goal) {
      if (this.waterRouteNodeClosed(routeState, neighbor)) return;
      {
        if (!this.game.isWater(neighbor)) return;
      }
      const nextScore = this.waterRouteNodeScore(routeState, current) + 1;
      if (nextScore >= this.waterRouteNodeScore(routeState, neighbor)) return;
      this.setWaterRouteNode(routeState, neighbor, current, nextScore);
      routeState.open.push({
        tile: neighbor,
        priority: nextScore + this.warshipRouteHeuristic(neighbor, goal),
      });
    }

    forEachWarshipNeighbor(tile, visit) {
      if (typeof this.game.forEachNeighbor === "function") {
        this.game.forEachNeighbor(tile, visit);
        return;
      }
      for (const neighbor of this.game.neighbors?.(tile) || []) visit(neighbor);
    }

    advanceWaterRoute(routeState, goal, maxExpansions = Infinity) {
      let expansions = 0;
      while (routeState.open.length > 0) {
        const current = routeState.open.pop();
        if (!current || this.waterRouteNodeClosed(routeState, current.tile)) continue;
        if (current.tile === goal) {
          return { complete: true, path: this.reconstructWaterRoute(routeState, goal) };
        }
        this.closeWaterRouteNode(routeState, current.tile);
        this.forEachWarshipNeighbor(current.tile, (neighbor) =>
          this.visitWaterRouteNeighbor(neighbor, current.tile, routeState, goal),
        );
        expansions += 1;
        if (expansions >= maxExpansions) return { complete: false, path: null };
      }
      return { complete: true, path: null };
    }

    waterRoute(start, goal) {
      if (start === undefined || start === null || goal === undefined || goal === null) {
        return null;
      }
      {
        if (!this.game.isWater(start) || !this.game.isWater(goal)) return null;
        if (start === goal) return [start];
      }

      const routeState = this.createWaterRouteState(start, goal);
      routeState.open.push({ tile: start, priority: this.warshipRouteHeuristic(start, goal) });
      return this.advanceWaterRoute(routeState, goal).path;
    }

    interceptionRoute(start, goal) {
      if (start === undefined || start === null || goal === undefined || goal === null) {
        return null;
      }
      if (!this.game.isWater(start) || !this.game.isWater(goal)) return null;
      if (start === goal) return [start];
      const routeState = this.createWaterRouteState(start, goal);
      routeState.open.push({ tile: start, priority: this.warshipRouteHeuristic(start, goal) });
      const outcome = this.advanceWaterRoute(
        routeState,
        goal,
        NAVAL_INTERCEPTION_ROUTE_MAX_EXPANSIONS,
      );
      return outcome.complete ? outcome.path : null;
    }

    waterTargetTile(target) {
      if (target === undefined || target === null) return null;
      {
        if (this.game.isWater(target)) return target;
      }
      const neighbors =
        typeof this.game.neighbors === "function" ? this.game.neighbors(target) || [] : [];
      return neighbors.find((tile) => {
        {
          return this.game.isWater(tile);
        }
      }) ?? null;
    }

    // Prefer the live transport execution path when the client exposes it. This
    // is the path the transport is already following, including any engine
    // smoothing; the local A* below remains the fallback for wrappers without a
    // motion-plan entry or when the plan has a different destination.
    getTransportMotionPlan(transport) {
      const plans = this.game.motionPlans?.();
      const id = transport.id?.();
      return plans?.get(id) ?? plans?.get(Number(id)) ?? plans?.get(String(id)) ?? null;
    }

    getRemainingTransportPath(transport, plan) {
      const now = Number(this.game.ticks?.() ?? plan.startTick ?? 0);
      const startTick = Number(plan.startTick ?? now);
      const ticksPerStep = Math.max(1, Number(plan.ticksPerStep ?? 1));
      const elapsedSteps = now <= startTick ? 0 : Math.floor((now - startTick) / ticksPerStep);
      const index = Math.max(0, Math.min(plan.path.length - 1, elapsedSteps));
      const path = Array.from(plan.path.slice(index));
      const current = transport.tile();
      if (path[0] !== current) path.unshift(current);
      return path;
    }

    transportMotionPath(transport, goal) {
      {
        const plan = this.getTransportMotionPlan(transport);
        if (!plan?.path?.length) return null;
        const path = this.getRemainingTransportPath(transport, plan);
        if (path.length === 0 || path[path.length - 1] !== goal) return null;
        return path.length > 1 ? path : null;
      }
    }

    incrementalTransportRoute(transport, current, goal, smartState) {
      const id = transport.id();
      const key = `${id}:${goal}`;
      let builder = smartState.invasionRouteBuilders.get(key);
      if (!builder) {
        const routeState = this.createWaterRouteState(current, goal, true);
        routeState.open.push({
          tile: current,
          priority: this.warshipRouteHeuristic(current, goal),
        });
        builder = { start: current, routeState };
        smartState.invasionRouteBuilders.set(key, builder);
      }
      const outcome = this.advanceWaterRoute(
        builder.routeState,
        goal,
        NAVAL_INVASION_ROUTE_SLICE_NODES,
      );
      if (!outcome.complete) return null;
      smartState.invasionRouteBuilders.delete(key);
      if (!Array.isArray(outcome.path)) return null;
      const currentIndex = outcome.path.indexOf(current);
      return currentIndex >= 0 ? outcome.path.slice(currentIndex) : null;
    }

    createIncomingNavalInvasion(transport, state, nextCache, mySid) {
      if (!this.isHostileIncomingTransport(transport, mySid)) return null;
      const target = transport.targetTile();
      const current = transport.tile();
      if (current == null || target == null) return null;
      // Surface the transported troop count so the interception planner can
      // weight a heavier landing ahead of a lighter one when a lone warship can
      // only cover one of two near-simultaneous invasions. The transport exposes
      // its payload via `troops()`; fall back to the neutral default when the
      // client does not surface it (older builds / replays), so behavior is
      // unchanged when the signal is absent.
      const threat = this.transportThreat(transport);
      const motionPath = this.transportMotionPath(transport, target);
      if (motionPath !== null) {
        return { id: transport.id(), path: motionPath, threat };
      }
      const goal = this.waterTargetTile(target);
      if (goal === null) return null;
      const key = `${transport.id()}:${current}:${goal}`;
      let path = state.invasionRouteCache.get(key);
      if (path === undefined) {
        path = this.incrementalTransportRoute(transport, current, goal, state);
      }
      nextCache.set(key, path);
      return Array.isArray(path) && path.length >= 2
        ? { id: transport.id(), path, threat }
        : null;
    }

    transportThreat(transport) {
      const troops =
        typeof transport.troops === "function" ? transport.troops() : null;
      const number = Number(troops);
      return Number.isFinite(number) && number > 0 ? number : null;
    }

    movementOrderIssuedThisTick(id, smartState, tick) {
      const assignment = smartState.invasionAssignments.get(id);
      if (assignment?.assignedAtTick === tick) return true;
      return smartState.cooldown.get(id) === tick;
    }

    isHostileIncomingTransport(transport, mySid) {
      if (!transport.isActive()) return false;
      const target = transport.targetTile();
      if (target == null || transport.transportShipState?.()?.isRetreating) return false;
      if (this.game.ownerID(target) !== mySid) return false;
      const owner = transport.owner();
      // isAlliedWith() excludes permanent teammates. isFriendly() is the
      // engine's canonical union of same-team and alliance relations, so only
      // its negation may authorize an interception.
      return Boolean(
        owner &&
        owner.smallID() !== mySid &&
        this.player.isFriendly?.(owner) !== true
      );
    }

    incomingNavalTransports() {
      const mySid = this.player.smallID();
      return this.game
        .units(UNIT.TransportShip)
        .filter((transport) => this.isHostileIncomingTransport(transport, mySid));
    }

    isEngineTargetableTransport(transport) {
      if (!transport?.isActive?.() || transport.isUnderConstruction?.()) return false;
      const owner = transport.owner?.();
      if (!owner || owner.smallID?.() === this.player.smallID()) return false;
      if (typeof this.player.canAttackPlayer === "function") {
        return this.player.canAttackPlayer(owner, true);
      }
      return this.player.isFriendly?.(owner) !== true;
    }

    engineTargetableTransports() {
      return this.game
        .units(UNIT.TransportShip)
        .filter((transport) => this.isEngineTargetableTransport(transport));
    }

    engineTargetInvasion(transport) {
      const current = transport.tile?.();
      if (current == null) return null;
      const target = transport.targetTile?.();
      const motionPath = target == null ? null : this.transportMotionPath(transport, target);
      const path =
        Array.isArray(motionPath) && motionPath.length > 0
          ? motionPath.slice()
          : [current];
      if (path.length === 1) path.push(path[0]);
      return { id: transport.id(), path };
    }

    engineTargetInvasions(transports) {
      return transports
        .map((transport) => this.engineTargetInvasion(transport))
        .filter((invasion) => invasion !== null);
    }

    incomingNavalInvasions(s, transports = null) {
      const mySid = this.player.smallID();
      const nextCache = new Map();
      const currentTransports = transports ?? this.game.units(UNIT.TransportShip);
      this.pruneInvasionRouteBuilders(s, currentTransports, mySid);
      const invasions = [];
      for (const transport of currentTransports) {
        {
          const invasion = this.createIncomingNavalInvasion(transport, s, nextCache, mySid);
          if (invasion) invasions.push(invasion);
        }
      }
      s.invasionRouteCache = nextCache;
      return invasions;
    }

    pruneInvasionRouteBuilders(state, transports, mySid) {
      const liveBuilderKeys = new Set();
      for (const transport of transports) {
        if (!this.isHostileIncomingTransport(transport, mySid)) continue;
        const goal = this.waterTargetTile(transport.targetTile());
        if (goal === null) continue;
        liveBuilderKeys.add(`${transport.id()}:${goal}`);
      }
      for (const key of state.invasionRouteBuilders.keys()) {
        if (!liveBuilderKeys.has(key)) state.invasionRouteBuilders.delete(key);
      }
    }

    dispatchInterceptor(warship, tile, s, tick) {
      {
        const warshipState = warship.warshipState?.();
        if (warshipState?.state === "retreating" || warshipState?.state === "docked") return false;
        if (warshipState?.patrolTile === tile) return true;
        if (!this.moveWarship(warship, tile)) return false;
        s.cooldown.set(warship.id(), tick);
        setLastAction(tr("🚢 Intercept invasion"), "naval");
        return true;
      }
    }

    interceptionBuildCandidates(invasion) {
      const path = invasion.path;
      const indexes = new Set([0, Math.max(0, Math.floor((path.length - 2) / 2)), path.length - 2]);
      const candidates = [];
      const seen = new Set();
      const addCandidate = (tile) => {
        if (
          tile === undefined ||
          tile === null ||
          seen.has(tile) ||
          candidates.length >= navalInterceptionBuildCandidateLimit
        ) return;
        seen.add(tile);
        candidates.push(tile);
      };
      for (const index of indexes) {
        addCandidate(path[index]);
      }
      const ports = this.player
        .units(UNIT.Port)
        .map((port, index) => ({
          port,
          index,
          distance: this.game.manhattanDist(port.tile(), path[0]),
        }))
        .sort((left, right) => left.distance - right.distance || left.index - right.index)
        .map(({ port }) => port);
      const portBudget = Math.max(0, navalInterceptionBuildCandidateLimit - candidates.length);
      const selectedPortIndexes = new Set();
      const nearestPortCount = Math.min(3, portBudget, ports.length);
      for (let index = 0; index < nearestPortCount; index++) selectedPortIndexes.add(index);
      const spreadPortCount = Math.min(
        portBudget - nearestPortCount,
        Math.max(0, ports.length - nearestPortCount),
      );
      for (let slot = 0; slot < spreadPortCount; slot++) {
        const index = spreadPortCount === 1
          ? ports.length - 1
          : nearestPortCount + Math.round(
            (slot * (ports.length - nearestPortCount - 1)) / (spreadPortCount - 1),
          );
        selectedPortIndexes.add(index);
      }
      for (const index of selectedPortIndexes) {
        addCandidate(this.warshipSpawnTile(ports[index].tile(), 250));
      }
      if (candidates.length < navalInterceptionBuildCandidateLimit) {
        for (const port of ports) {
          if (candidates.length >= navalInterceptionBuildCandidateLimit) break;
          addCandidate(this.warshipSpawnTile(port.tile(), 250));
        }
      }
      return candidates;
    }

    isBetterInterceptorBuild(candidate, best) {
      if (best === null) return true;
      for (let index = 0; index < candidate.score.length; index++) {
        if (candidate.score[index] !== best.score[index]) {
          return candidate.score[index] > best.score[index];
        }
      }
      return false;
    }

    async evaluateInterceptorBuild(tile, invasion, speeds) {
      const bu = await this.buildableWarship(tile);
      if (!bu || bu.canBuild === false || bu.canBuild == null) return null;
      const spawnTile = bu.canBuild;
      const plan = planNavalInterceptions({
        ships: [{ id: "pending-destroyer", tile: spawnTile }],
        invasions: [invasion],
        route: (from, to) => this.interceptionRoute(from, to),
        distance: (from, to) => this.waterDistance(from, to),
        ...speeds,
      });
      const assignment = plan.assignments[0] ?? null;
      const spawnRoute = this.interceptionRoute(spawnTile, tile);
      const spawnDistance = Array.isArray(spawnRoute) ? spawnRoute.length : Infinity;
      const score = assignment
        ? [1, assignment.marginTicks, -assignment.interceptTick]
        : [0, 0, -spawnDistance];
      return { bu, tile, score };
    }

    async buildInterceptorForInvasion(invasion, boatSpeed, warshipSpeed, attackRange) {
      if (this.hasPendingWarshipBuild()) return false;
      if (this.player.gold() < this.cost(UNIT.Warship)) return false;
      const candidates = this.interceptionBuildCandidates(invasion);
      let best = null;
      for (const tile of candidates) {
        const candidate = await this.evaluateInterceptorBuild(
          tile, invasion, { boatSpeed, warshipSpeed, attackRange },
        );
        if (candidate && this.isBetterInterceptorBuild(candidate, best)) best = candidate;
      }
      if (best === null) return false;
      return this.tryEmitWarshipBuild(
        best.bu,
        best.tile,
        tr("🚢 Intercept invasion"),
        "interception",
      );
    }

    activeWarships() {
      return this.player.units(UNIT.Warship).filter((warship) => {
        {
          return warship.isActive() && !warship.isUnderConstruction();
        }
      });
    }

    navalAssignmentTargetsTransport(warship, invasionId) {
      const actualTarget = warship?.targetUnit?.();
      if (actualTarget?.type?.() !== UNIT.TransportShip) return null;
      return actualTarget.id?.() === invasionId;
    }

    navalAssignmentConfirmationExpired(assignment, tick) {
      if (assignment.confirmed === true) return false;
      const interceptTick = Number(assignment.absoluteInterceptTick);
      return Number.isFinite(interceptTick) &&
        tick > interceptTick + NAVAL_INTERCEPT_CONFIRMATION_GRACE_TICKS;
    }

    shouldReleaseNavalAssignment(warship, assignment, liveInvasionIds, tick) {
      if (!warship || !liveInvasionIds.has(assignment.invasionId)) return true;
      if (this.navalAssignmentTargetsTransport(warship, assignment.invasionId) === false) {
        return true;
      }
      return this.navalAssignmentConfirmationExpired(assignment, tick);
    }

    confirmNavalAssignment(warship, assignment, tick) {
      if (assignment.confirmed === true) return;
      if (this.navalAssignmentTargetsTransport(warship, assignment.invasionId) !== true) return;
      assignment.confirmed = true;
      assignment.confirmedAtTick = tick;
      assignment.absoluteLandingTick = assignment.plannedAbsoluteLandingTick;
    }

    reconcileNavalInterceptorAssignments(warships, liveInvasionIds, state) {
      const warshipsById = new Map(warships.map((warship) => [warship.id(), warship]));
      const assignedInvasionIds = new Set();
      const tick = this.game.ticks();
      for (const [shipId, assignment] of state.invasionAssignments) {
        const warship = warshipsById.get(shipId);
        if (this.shouldReleaseNavalAssignment(warship, assignment, liveInvasionIds, tick)) {
          state.invasionAssignments.delete(shipId);
          continue;
        }
        this.confirmNavalAssignment(warship, assignment, tick);
        assignedInvasionIds.add(assignment.invasionId);
      }
      return assignedInvasionIds;
    }

    assignNavalInterceptors(plan, warships, state) {
      const shipsById = new Map(warships.map((warship) => [warship.id(), warship]));
      const newlyAssignedInvasionIds = new Set();
      for (const assignment of plan.assignments) {
        if (state.invasionAssignments.has(assignment.shipId)) continue;
        const warship = shipsById.get(assignment.shipId);
        if (!warship) continue;
        if (!this.dispatchInterceptor(warship, assignment.interceptTile, state, this.game.ticks())) continue;
        state.invasionAssignments.set(assignment.shipId, {
          ...assignment,
          confirmed: false,
          assignedAtTick: this.game.ticks(),
          absoluteInterceptTick: this.game.ticks() + assignment.interceptTick,
          plannedAbsoluteLandingTick: this.game.ticks() + assignment.landingTick,
        });
        newlyAssignedInvasionIds.add(assignment.invasionId);
      }
      return newlyAssignedInvasionIds;
    }

    selectUncoveredInvasionForBuild(plan, invasions, smartState, timing) {
      const uncovered = new Set(plan.uncoveredIds);
      let target = null;
      for (const invasion of invasions) {
        if (!uncovered.has(invasion.id)) continue;
        if (smartState.pendingInvasionBuilds.has(invasion.id)) continue;
        const lastAttempt =
          smartState.invasionBuildAttemptAt.get(invasion.id) ?? -Infinity;
        if (timing.now - lastAttempt < timing.throttle) continue;
        if (target !== null && target.path.length <= invasion.path.length) continue;
        target = invasion;
      }
      return target;
    }

    async buildUncoveredInterceptor(plan, invasions, smartState, timing) {
      if (plan.uncoveredIds.length === 0 || state.settings.warshipAutoSpawn === false) return;
      const target = this.selectUncoveredInvasionForBuild(
        plan,
        invasions,
        smartState,
        timing,
      );
      if (target === null) return;
      smartState.invasionBuildAttemptAt.set(target.id, timing.now);
      smartState.pendingInvasionBuilds.add(target.id);
      try {
        const built = await this.buildInterceptorForInvasion(
          target, timing.boatSpeed, timing.warshipSpeed, timing.attackRange,
        );
        if (built) this.recordInvasionBuild(smartState);
      } finally {
        smartState.pendingInvasionBuilds.delete(target.id);
      }
    }

    recordInvasionBuild(state) {
      state.lastInvasionBuildTick = this.game.ticks();
    }

    refreshTransportEvents(s, tick, mySid) {
      const transportIndex = this.indexById(this.game.units(UNIT.TransportShip));
      for (const unit of this.player.units(UNIT.TransportShip)) {
        {
          const target = unit.targetTile ? unit.targetTile() : null;
          s.transportPos.set(unit.id(), {
            x: this.game.x(unit.tile()), y: this.game.y(unit.tile()),
            tx: target != null ? this.game.x(target) : null,
            ty: target != null ? this.game.y(target) : null,
          });
        }
      }
      const farFromTarget = state.settings.warshipLossMinDist || 25;
      for (const [id, position] of Array.from(s.transportPos)) {
        const current = transportIndex.get(id);
        const stillOurs = current?.isActive() && current.owner().smallID() === mySid;
        if (stillOurs) continue;
        this.recordTransportLoss(s, position, tick, farFromTarget);
        s.transportPos.delete(id);
      }
    }

    recordTransportLoss(s, position, tick, farFromTarget) {
      if (position.tx == null || position.ty == null) return;
      const distance = Math.abs(position.x - position.tx) + Math.abs(position.y - position.ty);
      if (distance > farFromTarget) s.losses.push({ x: position.x, y: position.y, at: tick });
    }

    refreshTradeEvents(s, tick, myId) {
      const tradeIndex = this.indexById(this.game.units(UNIT.TradeShip));
      for (const unit of this.player.units(UNIT.TradeShip)) {
        {
          s.tradePos.set(unit.id(), { x: this.game.x(unit.tile()), y: this.game.y(unit.tile()) });
        }
      }
      for (const [id] of Array.from(s.tradePos)) this.harvestTradeEvent(s, tradeIndex.get(id), id, tick, myId);
    }

    harvestTradeEvent(s, current, id, tick, myId) {
      if (current === undefined || !current.isActive()) {
        s.tradePos.delete(id);
        return;
      }
      if (current.owner().id() === myId) return;
      {
        s.raids.push({ x: this.game.x(current.tile()), y: this.game.y(current.tile()), at: tick });
      }
      s.tradePos.delete(id);
    }

    patrolThreats(s) {
      const threats = [];
      const raid = s.raids.at(-1);
      if (raid && this.game.isValidCoord(raid.x, raid.y)) {
        const tile = this.game.ref(raid.x, raid.y);
        if (this.game.isWater(tile)) threats.push({ tile, kind: "trade-lane" });
      }
      const zone = this.findLossZone(s.losses);
      if (zone !== null) threats.push({ tile: zone, kind: "loss-zone" });
      return threats;
    }

    servicePatrolThreats(threats, s, tick) {
      const cell = state.settings.warshipServiceCellSize || 40;
      const serviceTicks = state.settings.warshipZoneServiceTicks || 90;
      for (const [key, servicedAt] of Array.from(s.serviced)) {
        if (tick - servicedAt > serviceTicks) s.serviced.delete(key);
      }
      for (const threat of threats) {
        const key = `${Math.floor(this.game.x(threat.tile) / cell)},${Math.floor(this.game.y(threat.tile) / cell)}`;
        const last = s.serviced.get(key);
        if (last !== undefined && tick - last < serviceTicks) continue;
        if (!this.moveBestWarshipTo(threat.tile, threat.kind, s, tick)) continue;
        s.serviced.set(key, tick);
        return;
      }
    }

    async protectAgainstNavalInvasions() {
      if (this.player === null) return;
      if (this.game.config().isUnitDisabled(UNIT.Warship)) return;
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return;
      const s = this.ensureSmartState();
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const throttle = state.settings.warshipPatrolThrottleMs || 1500;
      if (now - s.lastInvasionPlanMs < throttle) return;
      s.lastInvasionPlanMs = now;

      const transports = this.incomingNavalTransports();
      const targetableTransports =
        typeof this.game.units === "function"
          ? this.engineTargetableTransports()
          : transports;
      if (transports.length === 0) {
        s.invasionPlan = null;
        s.invasionAssignments.clear();
        return;
      }
      // The faithful transport tracker runs later in the same decision cycle.
      // Mark these transports handled so it cannot launch a second, competing
      // retaliation while this planner is already assigning/building escorts.
      for (const transport of transports) {
        this.dealtWithTransportShip.add(transport.id());
      }

      const warships = this.activeWarships();
      const liveInvasionIds = new Set(transports.map((transport) => transport.id()));
      const assignedInvasionIds = this.reconcileNavalInterceptorAssignments(
        warships,
        liveInvasionIds,
        s,
      );
      const unassignedTransports = transports.filter(
        (transport) => !assignedInvasionIds.has(transport.id()),
      );
      if (unassignedTransports.length === 0) return;
      const availableWarships = warships.filter(
        (warship) => !s.invasionAssignments.has(warship.id()),
      );
      const incomingInvasions = this.incomingNavalInvasions(s, transports);
      const incomingInvasionsById = new Map(
        incomingInvasions.map((invasion) => [invasion.id, invasion]),
      );
      const targetInvasions = this.engineTargetInvasions(targetableTransports).map(
        (invasion) => incomingInvasionsById.get(invasion.id) ?? invasion,
      );
      const unassignedInvasionIds = new Set(
        unassignedTransports.map((transport) => transport.id()),
      );
      const invasions = incomingInvasions.filter((invasion) =>
        unassignedInvasionIds.has(invasion.id),
      );
      if (invasions.length === 0) return;
      const boatSpeed = this.movementSpeed(null, UNIT.TransportShip);
      const warshipSpeed = this.movementSpeed(null, UNIT.Warship);
      const attackRange = this.warshipAttackRange();
      const plan = planNavalInterceptions({
        ships: availableWarships.map((warship) => ({ id: warship.id(), tile: warship.tile() })),
        invasions,
        targetInvasions,
        route: (from, to) => this.interceptionRoute(from, to),
        distance: (from, to) => this.waterDistance(from, to),
        targetDistanceSquared: (from, to) => this.game.euclideanDistSquared(from, to),
        boatSpeed,
        warshipSpeed,
        attackRange,
      });
      s.invasionPlan = { tick: this.game.ticks(), invasions, plan };
      const newlyAssignedInvasionIds = this.assignNavalInterceptors(
        plan,
        availableWarships,
        s,
      );
      const actionablePlan = {
        ...plan,
        uncoveredIds: invasions
          .filter((invasion) => !newlyAssignedInvasionIds.has(invasion.id))
          .map((invasion) => invasion.id),
      };
      await this.buildUncoveredInterceptor(actionablePlan, invasions, s, {
        now, throttle, boatSpeed, warshipSpeed, attackRange,
      });
    }

    smartWarshipPatrol() {
      if (this.player === null) return;
      if (this.game.config().isUnitDisabled(UNIT.Warship)) return;

      const s = this.ensureSmartState();

      const now = performance.now();
      const throttle = state.settings.warshipPatrolThrottleMs || 1500;
      if (now - s.lastPassMs < throttle) return;
      s.lastPassMs = now;

      const tick = this.game.ticks();
      this.refreshTransportEvents(s, tick, this.player.smallID());
      this.refreshTradeEvents(s, tick, this.player.id());

      // prune stale events
      const lossWindow = state.settings.warshipLossWindowTicks || 900;
      const raidWindow = state.settings.warshipRaidWindowTicks || 400;
      s.losses = s.losses.filter((e) => tick - e.at <= lossWindow);
      s.raids = s.raids.filter((e) => tick - e.at <= raidWindow);

      // 2) build the prioritized secondary threat list. Inbound invasions are
      // handled by protectAgainstNavalInvasions(), which has to preserve the
      // boat's future path and firing-range margin instead of using one point.
      const threats = this.patrolThreats(s);
      if (threats.length > 0) {
        this.servicePatrolThreats(threats, s, tick);
      }
      this.serviceCommerceRaids(s, tick);
    }

    // ── COMMERCE RAIDING (Legendary win-fix) ─────────────────────────────────
    // Trade captures fund the whole naval-nuclear economy and veterancy: a
    // warship parked in deep water between two hostile ports auto-captures
    // every trade ship that passes within its patrol range (the engine's own
    // hunting), and 25 captures alone promote one ship to veterancy level 3.
    // Anchors must stay far enough from shore that transit ships lose their
    // 20-tick pirate immunity before they cross the patrol circle.

    raidingTierActive() {
      return (
        state.settings.winFixes === true &&
        typeof currentDifficulty === "function" &&
        currentDifficulty() === "Legendary"
      );
    }

    hostileRaidPorts() {
      const ports = [];
      for (const unit of this.game.units(UNIT.Port)) {
        if (unit.type() !== UNIT.Port) continue;
        if (unit.isUnderConstruction?.() === true) continue;
        const owner = unit.owner?.();
        if (!owner || !owner.isPlayer?.()) continue;
        if (owner === this.player) continue;
        if (this.player.isFriendly?.(owner) === true) continue;
        ports.push(unit);
        if (ports.length >= 48) break;
      }
      return ports;
    }

    openWaterTileNear(x, y) {
      // Land within ~25 tiles voids the pirate-immunity trick and invites
      // shore-based retaliation; sample rays at three radii in 16 directions.
      const hasNearbyLand = (tx, ty) => {
        for (const radius of [8, 16, 25]) {
          for (let dir = 0; dir < 16; dir += 1) {
            const angle = (dir / 16) * Math.PI * 2;
            const sx = Math.round(tx + Math.cos(angle) * radius);
            const sy = Math.round(ty + Math.sin(angle) * radius);
            if (!this.game.isValidCoord(sx, sy)) return true;
            if (this.game.isLand(this.game.ref(sx, sy))) return true;
          }
        }
        return false;
      };
      for (let ring = 0; ring <= 40; ring += 4) {
        for (let dir = 0; dir < 8; dir += 1) {
          const angle = (dir / 8) * Math.PI * 2;
          const tx = Math.round(x + Math.cos(angle) * ring);
          const ty = Math.round(y + Math.sin(angle) * ring);
          if (!this.game.isValidCoord(tx, ty)) continue;
          const tile = this.game.ref(tx, ty);
          if (!this.game.isWater(tile)) continue;
          if (hasNearbyLand(tx, ty)) continue;
          return tile;
        }
      }
      return null;
    }

    commerceRaidAnchors(s, tick) {
      if (s.raidAnchorsTick === tick) return s.raidAnchors ?? [];
      const refreshDue =
        s.raidAnchors === undefined ||
        tick - (s.raidAnchorsAtTick ?? -Infinity) >= 300;
      if (!refreshDue) return s.raidAnchors ?? [];
      s.raidAnchorsAtTick = tick;
      const anchors = this.raidingTierActive()
        ? this.computeCommerceRaidAnchors()
        : [];
      s.raidAnchors = anchors;
      s.raidAnchorsTick = tick;
      return anchors;
    }

    nearestOpenWaterTile(x, y) {
      for (let radius = 0; radius <= 80; radius += 4) {
        for (let direction = 0; direction < 16; direction += 1) {
          const angle = (direction / 16) * Math.PI * 2;
          const tx = Math.round(x + Math.cos(angle) * radius);
          const ty = Math.round(y + Math.sin(angle) * radius);
          if (!this.game.isValidCoord(tx, ty)) continue;
          const tile = this.game.ref(tx, ty);
          if (this.game.isWater(tile)) return tile;
        }
      }
      return null;
    }

    liveTradeRaidAnchors() {
      const anchors = [];
      for (const tradeShip of this.game.units(UNIT.TradeShip) || []) {
        const tile = tradeShip.tile?.();
        if (tile == null) continue;
        const x = this.game.x(tile);
        const y = this.game.y(tile);
        const anchor = this.openWaterTileNear(x, y) ?? this.nearestOpenWaterTile(x, y);
        if (anchor == null) continue;
        if (anchors.some((existing) => this.game.manhattanDist(existing, anchor) < 35)) {
          continue;
        }
        anchors.push(anchor);
        if (anchors.length >= 3) break;
      }
      return anchors;
    }

    nearestHostileRaidNeighbor(port, ports, used) {
      const px = this.game.x(port.tile());
      const py = this.game.y(port.tile());
      let neighbor = null;
      let neighborDistance = Infinity;
      for (const other of ports) {
        if (other === port || used.has(other)) continue;
        if (other.owner?.() === port.owner?.()) continue;
        const distance =
          Math.abs(this.game.x(other.tile()) - px) +
          Math.abs(this.game.y(other.tile()) - py);
        if (distance < neighborDistance) {
          neighbor = other;
          neighborDistance = distance;
        }
      }
      return neighbor;
    }

    computeCommerceRaidAnchors() {
      const liveTraffic = this.liveTradeRaidAnchors();
      if (liveTraffic.length > 0) return liveTraffic;
      const ports = this.hostileRaidPorts().sort(
        (left, right) => (right.level?.() ?? 1) - (left.level?.() ?? 1),
      );
      const anchors = [];
      const used = new Set();
      for (const port of ports.slice(0, 6)) {
        if (anchors.length >= 3) break;
        const neighbor = this.nearestHostileRaidNeighbor(port, ports, used);
        const midX = neighbor
          ? Math.round((this.game.x(port.tile()) + this.game.x(neighbor.tile())) / 2)
          : this.game.x(port.tile());
        const midY = neighbor
          ? Math.round((this.game.y(port.tile()) + this.game.y(neighbor.tile())) / 2)
          : this.game.y(port.tile());
        const anchor = this.openWaterTileNear(midX, midY);
        if (anchor === null) continue;
        used.add(port);
        if (neighbor) used.add(neighbor);
        anchors.push(anchor);
      }
      return anchors;
    }

    countRaidStationedShips(anchors) {
      const shipsPerAnchor = new Map(anchors.map((tile) => [tile, 0]));
      for (const warship of this.player.units(UNIT.Warship)) {
        const patrolTile = warship.warshipState().patrolTile;
        if (patrolTile === undefined) continue;
        for (const anchor of anchors) {
          if (this.game.manhattanDist(patrolTile, anchor) < 40) {
            shipsPerAnchor.set(anchor, (shipsPerAnchor.get(anchor) ?? 0) + 1);
            break;
          }
        }
      }
      return shipsPerAnchor;
    }

    collectIdleRaidShips(s, tick, shipsPerAnchor) {
      const idleShips = [];
      const flagshipId = this.selectRaidFlagshipId(s);
      for (const warship of this.player.units(UNIT.Warship)) {
        if (s.invasionAssignments?.has(warship.id())) continue;
        // Once a ship reaches veterancy 3 it is the protected flagship. Before
        // that, keep one selected flagship assigned to the busiest raid lane so
        // trade captures and warship kills accumulate on one hull.
        if (flagshipId !== null && String(warship.id()) !== flagshipId) continue;
        const last = s.cooldown?.get(warship.id());
        if (last !== undefined && tick - last < 60) continue;
        const patrolTile = warship.warshipState().patrolTile;
        if (
          patrolTile !== undefined &&
          [...shipsPerAnchor.entries()].some(
            ([anchor, count]) =>
              count > 0 && this.game.manhattanDist(patrolTile, anchor) < 40,
          )
        ) {
          continue;
        }
        idleShips.push(warship);
      }
      return idleShips;
    }

    selectRaidFlagshipId(s) {
      const ships = this.player.units(UNIT.Warship);
      if (ships.length === 0) return null;
      const veteran = ships.find(
        (ship) => Number(ship.veterancy?.() ?? ship.veterancy ?? 0) >= 3,
      );
      if (veteran) {
        s.raidFlagshipId = String(veteran.id());
        return s.raidFlagshipId;
      }
      if (s.raidFlagshipId !== null) {
        const stillOwned = ships.some((ship) => String(ship.id()) === s.raidFlagshipId);
        if (stillOwned) return s.raidFlagshipId;
      }
      const selected = ships
        .slice()
        .sort((left, right) => Number(right.veterancy?.() ?? right.veterancy ?? 0) - Number(left.veterancy?.() ?? left.veterancy ?? 0))[0];
      s.raidFlagshipId = selected ? String(selected.id()) : null;
      return s.raidFlagshipId;
    }

    leastMannedRaidAnchor(shipsPerAnchor) {
      let target = null;
      let targetCount = Infinity;
      for (const [anchor, count] of shipsPerAnchor) {
        if (count < targetCount) {
          target = anchor;
          targetCount = count;
        }
      }
      return { target, targetCount };
    }

    serviceCommerceRaids(s, tick) {
      if (!this.raidingTierActive()) return;
      // Never retask an interceptor into commerce duty while an enemy
      // transport is live. The invasion planner runs first, but a same-tick
      // raid move would overwrite its patrol anchor and let the landing reach
      // our coast.
      if (this.incomingNavalTransports().length > 0) return;
      const anchors = this.commerceRaidAnchors(s, tick);
      if (anchors.length === 0) return;
      const ctors = discoverCtors(getEventBus());
      if (!ctors.moveWarship) return;
      const shipsPerAnchor = this.countRaidStationedShips(anchors);
      const idleShips = this.collectIdleRaidShips(s, tick, shipsPerAnchor);
      if (idleShips.length === 0) return;
      let movesThisPass = 0;
      for (const warship of idleShips) {
        if (movesThisPass >= WARSHIP_COMBAT_PASS_MOVE_CAP) break;
        if (!this.warshipMoveBudgetAvailable()) break;
        const { target, targetCount } = this.leastMannedRaidAnchor(shipsPerAnchor);
        if (target === null || targetCount >= 3) break;
        emitIntent(ctors.moveWarship, [warship.id()], target);
        shipsPerAnchor.set(target, targetCount + 1);
        s.cooldown.set(warship.id(), tick);
        movesThisPass += 1;
        setLastAction(tr("🏴‍☠️ Commerce raid"), "naval");
      }
    }

    // findLossZone — centroid of a CLUSTER of recent open-water losses (≥ min within a
    // radius of each other). One loss is noise; a cluster is a raid lane worth clearing.
    findLossZone(losses) {
      const minCount = state.settings.warshipLossZoneMin || 2;
      const radius = state.settings.warshipLossZoneRadius || 35;
      if (losses.length < minCount) return null;
      let best = null;
      let bestCount = 0;
      for (const a of losses) {
        const candidate = this.lossZoneCandidate(a, losses, radius);
        if (candidate.count < minCount || candidate.count <= bestCount) continue;
        if (!this.game.isValidCoord(candidate.x, candidate.y)) continue;
        const tile = this.game.ref(candidate.x, candidate.y);
        if (!this.game.isWater(tile)) continue;
        bestCount = candidate.count;
        best = tile;
      }
      return best;
    }

    lossZoneCandidate(anchor, losses, radius) {
      const nearby = losses.filter(
        (loss) => Math.abs(anchor.x - loss.x) + Math.abs(anchor.y - loss.y) <= radius,
      );
      const sum = nearby.reduce(
        (total, loss) => ({ x: total.x + loss.x, y: total.y + loss.y }),
        { x: 0, y: 0 },
      );
      return {
        count: nearby.length,
        x: Math.round(sum.x / nearby.length),
        y: Math.round(sum.y / nearby.length),
      };
    }

    // moveBestWarshipTo — move the nearest IDLE, off-cooldown warship to `tile`, but only
    // if it's within the interception distance cap (else leave it; the faithful build
    // path covers threats no existing ship can reach). Sets a per-warship cooldown so a
    // tiny pool doesn't oscillate between threats. Returns true if a ship was tasked.
    selectClosestIdleWarship(tile, s, tick, cooldownTicks) {
      let best = null;
      let bestDistance = Infinity;
      for (const warship of this.player.units(UNIT.Warship)) {
        if (s?.invasionAssignments?.has(warship.id())) continue;
        const patrolTile = warship.warshipState().patrolTile;
        if (patrolTile === undefined) continue;
        if (this.game.manhattanDist(warship.tile(), patrolTile) >= 130) continue;
        const last = s?.cooldown?.get(warship.id());
        if (last !== undefined && tick - last < cooldownTicks) continue;
        const distance = this.game.manhattanDist(warship.tile(), tile);
        // Strict comparison preserves the stable-sort tie: the first eligible
        // ship in the player's unit order wins equal-distance ties.
        if (distance >= bestDistance) continue;
        best = warship;
        bestDistance = distance;
      }
      return best === null ? null : { warship: best, distance: bestDistance };
    }

    moveBestWarshipTo(tile, kind, s, tick) {
      if (!this.game.isWater(tile)) return false;
      const maxDist = state.settings.warshipMoveMaxDist || 160;
      const cooldownTicks = state.settings.warshipMoveCooldownTicks || 60;
      const selected = this.selectClosestIdleWarship(
        tile,
        s,
        tick,
        cooldownTicks,
      );
      if (selected === null || selected.distance > maxDist) return false;
      const w = selected.warship;
      if (!this.warshipMoveBudgetAvailable()) return false;
      const ctors = discoverCtors(getEventBus());
      if (!ctors.moveWarship) return false;
      if (!emitIntent(ctors.moveWarship, [w.id()], tile)) return false;
      s.cooldown.set(w.id(), tick);
      setLastAction(tr("🚢 Patrol → {k}", { k: kind }), "naval");
      runtimeDebugLog(
        "[Warship] patrol →",
        kind,
        "@",
        this.game.x(tile),
        this.game.y(tile),
      );
      return true;
    }

    // ── WARSHIP NUKE AUTO-DODGE (WIN-FIX — NOT in src) ─────────────────────────
    // Detect any in-flight nuke whose blast zone covers one of our warships and
    // move that warship clear of EVERY active blast zone. Owner-agnostic: a nuke
    // kills a warship regardless of who fired it (maybeRetaliateWithWarship even
    // notes "own nuke destroyed own ship"), and the user chose "dodge any nuke that
    // covers the ship" — so we filter by blast coverage, not relation. Pure movement
    // (no gold), runs every tick BEFORE smartWarshipPatrol, gated by winFixes. Locks
    // each dodged ship into the shared smartState.cooldown so patrol skips it.

    // Remaining flight ticks for an atom/hydrogen nuke from its CURRENT tile to its
    // target, via the same parabola the game uses (mirrors nuke-prediction.js).
    // UniversalPathFinding lives in nukeBehavior.js (shared scope) — guarded.
    computeNukeRemainingTicks(fromTile, toTile) {
      {
        if (!this.canComputeNukePath(fromTile, toTile)) return null;
        const speed =
          typeof ofhGameNukeSpeed === "function"
            ? ofhGameNukeSpeed(this.game, "Atom Bomb", 10)
            : 10;
        const pf = UniversalPathFinding.Parabola(this.game, {
          increment: speed,
          distanceBasedHeight: true,
          directionUp: true,
        });
        const path = pf.findPath(fromTile, toTile);
        if (!Array.isArray(path) || path.length === 0) return null;
        if (path.length === 1) return 1;
        let arc = 0;
        for (let i = 1; i < path.length; i++) {
          const ax = this.game.x(path[i]);
          const ay = this.game.y(path[i]);
          const bx = this.game.x(path[i - 1]);
          const by = this.game.y(path[i - 1]);
          arc += Math.hypot(ax - bx, ay - by);
        }
        return Math.floor(arc / (speed > 0 ? speed : 10)) + 1;
      }
    }

    canComputeNukePath(fromTile, toTile) {
      return typeof UniversalPathFinding !== "undefined" &&
        Boolean(UniversalPathFinding.Parabola) && fromTile != null && toTile != null;
    }

    // ETA (ticks) until this nuke detonates. MIRV → 0 (treated as imminent: its
    // mid-air flat arc isn't this parabola). Atom/hydrogen: anchored once at first
    // sight then counted down (nuke advances one trajectory point per tick).
    // Parabola-unavailable fallback: straight-line distance / speed.
    nukeEtaTicks(nuke, nowTick) {
      const type = nuke.type?.();
      if (type === UNIT.MIRVWarhead) return 0;
      const id = nuke.id?.();
      if (id === undefined) return 0;
      if (!this.nukeEtaById) this.nukeEtaById = new Map();
      let anchor = this.nukeEtaById.get(id);
      if (anchor === undefined) {
        let remainTicks = this.computeNukeRemainingTicks(
          nuke.tile?.(),
          nuke.targetTile?.(),
        );
        if (remainTicks === null) {
          {
            const speed =
              typeof ofhGameNukeSpeed === "function"
                ? ofhGameNukeSpeed(this.game, "Atom Bomb", 10)
                : 10;
            const d2 = this.game.euclideanDistSquared(
              nuke.tile(),
              nuke.targetTile(),
            );
            remainTicks = Math.floor(Math.sqrt(d2) / (speed > 0 ? speed : 10)) + 1;
          }
        }
        anchor = { firstTick: nowTick, remainTicks };
        this.nukeEtaById.set(id, anchor);
      }
      return Math.max(0, anchor.remainTicks - (nowTick - anchor.firstTick));
    }

    // Outer blast radius (tile units) of a nuke, with the same fallback the overlay
    // (nuke-prediction.js) uses when nukeMagnitudes is unavailable.
    nukeOuterRadius(nuke) {
      const type = nuke.type?.();
      let fallback;
      if (type === UNIT.HydrogenBomb) {
        fallback = { inner: 80, outer: 100 };
      } else if (type === UNIT.MIRVWarhead) {
        fallback = { inner: 12, outer: 18 };
      } else {
        fallback = { inner: 12, outer: 30 };
      }
      const magnitude =
        typeof ofhGameNukeMagnitude === "function"
          ? ofhGameNukeMagnitude(this.game, type, fallback)
          : fallback;
      return Number(magnitude?.outer ?? magnitude?.inner) || fallback.outer;
    }

    // Find a water tile MAXIMIZING coverEta for a ship at (sx,sy): coverEta = the
    // soonest impact (ticks) among zones covering a tile, +Infinity if clear of all.
    // Radial push away from the nearest center, sampling several angles × rings (to
    // clear wide overlapping coverage). Tie-break: closest to the ship. Returns
    // { tile, eta } (eta may be Infinity = fully safe) or null if no water tile found.
    findNukeEscapeTile(sx, sy, zones, coverEta) {
      const center = this.nearestNukeZone(sx, sy, zones);
      if (center === null) return null;

      const buffer = state.settings.warshipNukeDodgeBuffer || 20;
      const samples = Math.max(1, state.settings.warshipNukeDodgeSamples || 8);
      const rings = Math.max(1, state.settings.warshipNukeDodgeRings || 3);

      // Base angle points from the center out toward the ship (away from impact).
      let baseAngle = Math.atan2(sy - center.ty, sx - center.tx);
      if (!Number.isFinite(baseAngle)) baseAngle = 0; // ship exactly on the center

      let bestTile = null;
      let bestEta = -Infinity;
      let bestDist = Infinity;
      for (let ring = 1; ring <= rings; ring++) {
        const pushDist = center.radius + buffer * ring;
        for (let k = 0; k < samples; k++) {
          const candidate = this.nukeEscapeCandidate({
            center, baseAngle, pushDist, index: k, sx, sy, coverEta,
          });
          if (!candidate) continue;
          if (!this.isBetterNukeEscape(candidate, bestEta, bestDist)) continue;
          ({ tile: bestTile, eta: bestEta, dist: bestDist } = candidate);
        }
      }
      if (bestTile === null) return null;
      return { tile: bestTile, eta: bestEta };
    }

    nearestNukeZone(sx, sy, zones) {
      let nearest = null;
      let nearestDistance = Infinity;
      for (const zone of zones) {
        const dx = sx - zone.tx;
        const dy = sy - zone.ty;
        const distance = dx * dx + dy * dy;
        if (distance >= nearestDistance) continue;
        nearest = zone;
        nearestDistance = distance;
      }
      return nearest;
    }

    isBetterNukeEscape(candidate, bestEta, bestDist) {
      return candidate.eta > bestEta ||
        (candidate.eta === bestEta && candidate.dist < bestDist);
    }

    nukeEscapeCandidate(options) {
      const { center, baseAngle, pushDist, index, sx, sy, coverEta } = options;
      const step = Math.ceil(index / 2);
      const direction = index % 2 === 0 ? 1 : -1;
      const angle = baseAngle + direction * step * (Math.PI / 4);
      const x = Math.round(center.tx + Math.cos(angle) * pushDist);
      const y = Math.round(center.ty + Math.sin(angle) * pushDist);
      if (!this.game.isValidCoord(x, y)) return null;
      const tile = this.game.ref(x, y);
      if (!this.game.isWater(tile)) return null;
      return { tile, eta: coverEta(x, y), dist: Math.abs(x - sx) + Math.abs(y - sy) };
    }

    activeNukeZones(tick) {
      const margin = state.settings.warshipNukeDodgeMargin || 8;
      const zones = [];
      const seen = new Set();
      for (const nuke of this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb, UNIT.MIRVWarhead)) {
        {
          if (!nuke.isActive()) continue;
          const target = nuke.targetTile();
          if (target == null) continue;
          const id = nuke.id?.();
          if (id !== undefined) seen.add(id);
          const radius = this.nukeOuterRadius(nuke) + margin;
          zones.push({
            tx: this.game.x(target), ty: this.game.y(target), radius,
            r2: radius * radius, owner: nuke.owner()?.smallID?.(),
            eta: this.nukeEtaTicks(nuke, tick),
          });
        }
      }
      return { zones, seen };
    }

    pruneNukeEtaAnchors(seen) {
      if (!this.nukeEtaById) return;
      for (const id of this.nukeEtaById.keys()) {
        if (!seen.has(id)) this.nukeEtaById.delete(id);
      }
    }

    nukeCoverEta(zones, x, y) {
      let best = Infinity;
      for (const zone of zones) {
        const dx = x - zone.tx;
        const dy = y - zone.ty;
        if (dx * dx + dy * dy <= zone.r2 && zone.eta < best) best = zone.eta;
      }
      return best;
    }

    dodgeWarshipFromNukes(ship, zones, coverEta, smartState, tick) {
      if (this.movementOrderIssuedThisTick(ship.id(), smartState, tick)) return;
      const tile = ship.tile();
      const x = this.game.x(tile);
      const y = this.game.y(tile);
      const shipEta = coverEta(x, y);
      if (shipEta === Infinity) return;
      const best = this.findNukeEscapeTile(x, y, zones, coverEta);
      if (!best || best.eta <= shipEta) return;
      const patrolTile = ship.warshipState().patrolTile;
      if (patrolTile !== undefined && coverEta(this.game.x(patrolTile), this.game.y(patrolTile)) >= best.eta) return;
      // A trapped ship re-evaluates its escape every game tick and the best
      // tile drifts with the incoming zones; unpaced, one ship under a MIRV
      // spends a move intent per tick and saturates the shared budget.
      // Survival still outranks ordinary micro: the cooldown is short and
      // the budget reserve thinner than the combat gate's, and a genuinely
      // different escape tile bypasses the cooldown entirely.
      const id = ship.id();
      if (this.warshipDodgeRecentlyRetasked(smartState, id, best.tile, tick)) return;
      if (!this.warshipDodgeBudgetAvailable()) return;
      if (!this.warshipDodgeBudgetAvailable()) return;
      const ctors = discoverCtors(getEventBus());
      if (!ctors.moveWarship) return;
      const sent = emitIntent(ctors.moveWarship, [ship.id()], best.tile);
      if (sent) {
        if (!smartState.lastDodgeMoves) smartState.lastDodgeMoves = new Map();
        smartState.lastDodgeMoves.set(id, { tile: best.tile, tick });
      }
      smartState.cooldown.set(id, tick);
      if (sent) setLastAction(tr("🚢 Dodge nuke"), "naval");
    }

    warshipDodgeRecentlyRetasked(smartState, id, tile, tick) {
      const last = smartState.lastDodgeMoves?.get(id);
      if (!last) return false;
      if (tick - last.tick >= WARSHIP_DODGE_COOLDOWN_TICKS) return false;
      return this.game.manhattanDist(tile, last.tile) <= WARSHIP_MOVE_RETARGET_RADIUS;
    }

    // Dodge moves are survival-critical, so they may spend the budget down
    // further than ordinary micromanagement — but not to zero, which would
    // starve attacks and spawns while the ship is already committed to its
    // last escape order.
    warshipDodgeBudgetAvailable() {
      return this.warshipEmitBudgetAvailable(
        WARSHIP_DODGE_SECOND_TOKEN_RESERVE,
        WARSHIP_DODGE_MINUTE_TOKEN_RESERVE,
      );
    }

    dodgeNukes() {
      if (this.player === null) return;
      if (this.game.config().isUnitDisabled(UNIT.Warship)) return;

      const myWarships = this.player.units(UNIT.Warship);
      if (myWarships.length === 0) return;

      const tick = this.game.ticks();

      // 1) collect active blast zones from ALL in-flight nukes (owner-agnostic),
      //    each carrying its ETA (ticks until detonation; MIRV = 0 = imminent).
      const { zones, seen } = this.activeNukeZones(tick);
      this.pruneNukeEtaAnchors(seen);
      if (zones.length === 0) return; // no-op

      // coverEta(x,y) = soonest impact (ticks) among zones covering (x,y); Infinity
      // if the tile is clear of every zone (fully safe).
      const coverEta = (x, y) => this.nukeCoverEta(zones, x, y);

      // DE-RISK (throttled ~1s): confirm the wrapper sees ENEMY nukes via this
      // GameView (not just our own/allies'). Logs owner + mine flag + eta per zone.
      const nowMs = performance.now();
      if (nowMs - (this._dodgeLogAtMs || 0) > 1000) {
        this._dodgeLogAtMs = nowMs;
        const mySid = this.player.smallID();
        runtimeDebugLog(
          "[Warship] nuke-dodge scan:",
          zones.length,
          "zone(s)",
          zones.map((z) => ({ owner: z.owner, mine: z.owner === mySid, eta: z.eta })),
        );
      }

      // 2) for each covered warship, move toward the highest-coverEta reachable tile.
      //    A fully-clear tile (Infinity) wins; if coverage is too wide to escape,
      //    the ship shelters in the LATEST-detonating zone, then re-evaluates each
      //    tick (the early nuke's zone vanishes on detonation → it runs onward).
      const s = this.ensureSmartState();
      for (const ship of myWarships) {
        {
          this.dodgeWarshipFromNukes(ship, zones, coverEta, s, tick);
        }
      }
    }

    // ── BATTLE SIMULATION (ported from Blon — winFix DIVERGENCE) ──────────────
    // Monte Carlo: simulates tick-by-tick combat between friendly and enemy warships.
    // Returns { win: boolean, survivalPct: number }.
    simulateBattle(friendlies, enemies, maxHp, focalTile) {
      if (enemies.length === 0) return { win: true, survivalPct: 100 };
      if (friendlies.length === 0) return { win: false, survivalPct: 0 };
      const { range, damagePerTick, veterancyBonusPercent } = this.warshipBattleConstants();
      const friendlyState = this.createBattleFleet(
        friendlies, focalTile, range, veterancyBonusPercent,
      );
      const enemyState = this.createBattleFleet(
        enemies, focalTile, range, veterancyBonusPercent,
      );

      let ticks = 0;
      while (ticks < 1000) {
        const friendlySummary = this.battleFleetSummary(friendlyState, ticks);
        const enemySummary = this.battleFleetSummary(enemyState, ticks);
        if (!friendlySummary.alive || !enemySummary.alive) break;
        const nextTick = this.resolveBattleTick(
          friendlySummary, enemySummary, ticks, damagePerTick,
        );
        if (nextTick !== null) { ticks = nextTick; continue; }
        ticks++;
      }
      return this.battleOutcome(friendlies, friendlyState, enemyState, maxHp);
    }

    warshipBattleConstants() {
      const config = typeof this.game.config === "function" ? this.game.config() : null;
      const range = typeof config?.warshipTargettingRange === "function"
        ? config.warshipTargettingRange() : 130;
      const shell = typeof config?.unitInfo === "function" ? config.unitInfo("Shell") : null;
      const attackRate = typeof config?.warshipShellAttackRate === "function"
        ? config.warshipShellAttackRate() : 20;
      const veterancyBonusPercent =
        typeof config?.warshipVeterancyShellDamageBonus === "function"
          ? config.warshipVeterancyShellDamageBonus() : 20;
      return {
        range,
        damagePerTick: ((shell?.damage || 250) * 2.625) / Math.max(1, attackRate),
        veterancyBonusPercent,
      };
    }

    // Veteran warships hit harder: the engine scales every shell by the firing
    // hull's veterancy times warshipVeterancyShellDamageBonus (20%/point by
    // default), and maxHealth already carries the veterancy adjustment. A
    // simulation that counts hulls 1:1 reads a small veteran fleet as beatable
    // and sends a green fleet to the bottom.
    battleFleetUnitPower(unit, veterancyBonusPercent) {
      const veterancy = typeof unit.veterancy === "function"
        ? Number(unit.veterancy()) : 0;
      if (!Number.isFinite(veterancy) || veterancy <= 0) return 1;
      const bonus = Number(veterancyBonusPercent);
      const scale = Number.isFinite(bonus) && bonus > 0 ? bonus : 20;
      return 1 + veterancy * (scale / 100);
    }

    createBattleFleet(units, focalTile, range, veterancyBonusPercent) {
      return units.map((unit) => {
        const distance = focalTile ? this.game.manhattanDist(focalTile, unit.tile()) : range;
        return {
          hp: unit.health(),
          power: this.battleFleetUnitPower(unit, veterancyBonusPercent),
          engageTick: Math.max(0, distance - range),
        };
      });
    }

    battleFleetSummary(fleet, tick) {
      const alive = fleet.filter((unit) => unit.hp > 0.01);
      const active = alive.filter((unit) => unit.engageTick <= tick);
      return {
        alive: alive.length,
        active,
        activePower: active.reduce((sum, unit) => sum + unit.power, 0),
        nextEngage: alive.reduce((next, unit) => Math.min(next, unit.engageTick), Infinity),
      };
    }

    applyBattleDamage(fleet, damage) {
      fleet.sort((a, b) => a.hp - b.hp);
      let remaining = damage;
      for (const unit of fleet) {
        if (remaining <= 0) return;
        const taken = Math.min(unit.hp, remaining);
        unit.hp -= taken;
        remaining -= taken;
      }
    }

    resolveBattleTick(friendlies, enemies, tick, damagePerTick) {
      if (friendlies.active.length === 0 && enemies.active.length === 0) {
        const next = Math.min(friendlies.nextEngage, enemies.nextEngage);
        return next > tick && next !== Infinity ? next : null;
      }
      if (friendlies.active.length === 0 || enemies.active.length === 0) return null;
      this.applyBattleDamage(enemies.active, friendlies.activePower * damagePerTick);
      this.applyBattleDamage(friendlies.active, enemies.activePower * damagePerTick);
      return null;
    }

    battleOutcome(friendlies, friendlyState, enemyState, fallbackMaxHp) {
      const survivors = friendlyState.filter((unit) => unit.hp > 0.01);
      if (survivors.length === 0 || enemyState.some((unit) => unit.hp > 0.01)) {
        return { win: false, survivalPct: 0 };
      }
      const remainingHp = survivors.reduce((sum, unit) => sum + Math.max(0, unit.hp), 0);
      const totalMaxHp = friendlies.reduce(
        (sum, unit) => sum + (typeof unit.maxHealth === "function" ? unit.maxHealth() : fallbackMaxHp), 0,
      );
      return { win: true, survivalPct: (remainingHp / totalMaxHp) * 100 };
    }

    // ── SAFE WAYPOINT BFS (ported from Blon — winFix DIVERGENCE) ─────────────
    // BFS over water tiles to find the safest retreat point: maximizes distance from
    // enemies while staying as close as possible to the base target. Penalizes corners.
    findSafeWaypoint(start, baseTarget, enemies) {
      const game = this.game;
      const myComponent = game.getWaterComponent(start);
      const MAX_DEPTH = 30;
      const queue = [{ tile: start, depth: 0 }];
      let queueHead = 0;
      const visited = new Set();
      visited.add(start);
      let bestTile = start;
      let bestScore = -Infinity;

      while (queueHead < queue.length) {
        const { tile, depth } = queue[queueHead++];
        let dEnemy = Infinity;
        for (const ew of enemies) {
          const d = game.manhattanDist(tile, ew.tile());
          if (d < dEnemy) dEnemy = d;
        }
        const dTarget = baseTarget ? game.manhattanDist(tile, baseTarget) : 0;
        const SAFE_DISTANCE = 15;
        const enemyScore = Math.min(dEnemy, SAFE_DISTANCE) * 50;
        const targetScore = -dTarget;
        let waterNeighbors = 0;
        game.forEachNeighbor(tile, (n) => { if (game.isWater(n)) waterNeighbors++; });
        const cornerPenalty = (4 - waterNeighbors) * 15;
        const score = enemyScore + targetScore - cornerPenalty;
        if (score > bestScore) { bestScore = score; bestTile = tile; }

        if (depth >= MAX_DEPTH) continue;
        game.forEachNeighbor(tile, (neighbor) => {
          if (game.isWater(neighbor) && game.getWaterComponent(neighbor) === myComponent && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push({ tile: neighbor, depth: depth + 1 });
          }
        });
      }
      return bestTile;
    }

    // ── SMART WARSHIP COMBAT (Blon-inspired — winFix DIVERGENCE) ─────────────
    // Combines retreat-by-HP, battle simulation, safe waypoint, and trade hunting.
    // Runs AFTER smartWarshipPatrol, gated by winFixes + features.warship.
    canWarshipHuntOwner(owner) {
      if (!owner?.isPlayer?.()) return false;
      if (owner === this.player) return false;
      if (this.player.isFriendly?.(owner) === true) return false;
      if (typeof this.player.canAttackPlayer === "function") {
        return this.player.canAttackPlayer(owner, true) === true;
      }
      return true;
    }

    collectCombatUnits(type, predicate, label) {
      const units = [];
      for (const unit of this.game.units(type) || []) {
        {
          if (predicate(unit)) units.push(unit);
        }
      }
      return units;
    }

    friendlyCombatPorts(me) {
      return this.collectCombatUnits(
        UNIT.Port,
        (unit) => unit.isActive() && !unit.isUnderConstruction() && unit.owner()?.isFriendly(me),
        "friendlyCombatPorts",
      );
    }

    combatBaseTarget(warship, ports) {
      if (ports.length === 0) return null;
      const nearest = ports.reduce((best, port) =>
        this.game.manhattanDist(warship.tile(), port.tile()) <
        this.game.manhattanDist(warship.tile(), best.tile()) ? port : best,
      );
      let target = null;
      this.game.forEachNeighbor(nearest.tile(), (neighbor) => {
        if (target === null && this.game.isWater(neighbor)) target = neighbor;
      });
      return target ?? nearest.tile();
    }

    // Each ship retreats to ITS nearest friendly port. The old fleet-wide
    // anchor (nearest port to myWarships[0]) sent every wounded hull on the
    // map to one dock; and when no port existed the retreat target was null,
    // so wounded ships simply fought to the death. Fall back to a safe
    // waypoint so a portless, wounded fleet still breaks contact.
    combatRetreatTarget(warship, friendlyPorts, nearbyEnemies) {
      const port = this.combatBaseTarget(warship, friendlyPorts);
      if (port !== null) return port;
      if (nearbyEnemies.length === 0) return null;
      return this.findSafeWaypoint(warship.tile(), null, nearbyEnemies);
    }

    nearbyCombatEnemies(warship, enemies) {
      return enemies.filter(
        (enemy) => this.game.manhattanDist(warship.tile(), enemy.tile()) <= 30,
      );
    }

    warshipWantsToEvade(warship, nearbyEnemies, myWarships, maxHp, retreatPct) {
      if (nearbyEnemies.length === 0 || state.settings.warshipEvade === false) return false;
      const activeFriendlies = myWarships.filter((friendly) => {
        const friendlyState = friendly.warshipState();
        if (friendlyState?.state === "retreating" || friendlyState?.state === "docked") return false;
        if (friendly.health() < maxHp * retreatPct) return false;
        return this.game.manhattanDist(warship.tile(), friendly.tile()) <= 15;
      });
      const result = this.simulateBattle(activeFriendlies, nearbyEnemies, maxHp, warship.tile());
      return !result.win || result.survivalPct < 15;
    }

    // A trade hunter sails blindly to the prey tile; evasion only simulates
    // enemies within 30 of the hunter's CURRENT tile, so an anchored escort
    // near the prey baits the hunter into a fleet it never evaluated. Refuse
    // the chase when a hostile warship already shadows the prey.
    tradeHuntTarget(warship, enemyTradeShips, enemyWarships) {
      if (enemyTradeShips.length === 0) return null;
      const prey = enemyTradeShips.reduce((nearest, unit) =>
        this.game.manhattanDist(warship.tile(), unit.tile()) <
        this.game.manhattanDist(warship.tile(), nearest.tile()) ? unit : nearest,
      );
      const defended = enemyWarships.some((enemy) =>
        this.game.manhattanDist(enemy.tile(), prey.tile()) <= 30);
      return defended ? null : prey.tile();
    }

    combatTarget(options) {
      const { warship, nearbyEnemies, enemyTradeShips, enemyWarships, baseTarget,
        wantsToEvade, retreatThreshold, huntTrade, primaryTargetId } = options;
      if (warship.health() < retreatThreshold) {
        return wantsToEvade && nearbyEnemies.length > 0
          ? this.findSafeWaypoint(warship.tile(), baseTarget, nearbyEnemies)
          : baseTarget;
      }
      if (wantsToEvade && nearbyEnemies.length > 0) {
        return this.findSafeWaypoint(warship.tile(), baseTarget, nearbyEnemies);
      }
      if (!wantsToEvade && nearbyEnemies.length > 0) {
        // Fleet focus-fire: when the combat pass nominated a primary target
        // and this ship can reach it, concentrate fire there instead of each
        // ship independently picking its own lowest-HP enemy. N ships that
        // would otherwise split across N enemies now delete one target per
        // pass, which is strictly better when arrivals are staggered.
        if (primaryTargetId !== undefined && primaryTargetId !== null) {
          const focus = nearbyEnemies.find((enemy) =>
            this.unitIdMatches(enemy, primaryTargetId));
          if (focus) return focus.tile();
        }
        return nearbyEnemies.reduce((weakest, enemy) =>
          enemy.health() < weakest.health() ? enemy : weakest,
        ).tile();
      }
      return huntTrade
        ? this.tradeHuntTarget(warship, enemyTradeShips, enemyWarships)
        : null;
    }

    unitIdMatches(unit, id) {
      if (!unit || id === undefined || id === null) return false;
      const unitId = typeof unit.id === "function" ? unit.id() : unit.id;
      return unitId === id;
    }

    // Pick one fleet-wide primary target per combat pass so the fleet
    // concentrates fire. The primary is the enemy warship the largest number
    // of my warships can reach (most "votes"), tie-broken by lowest HP so a
    // near-dead target is finished first. Returns the enemy unit's id or null.
    chooseFleetFocusTarget(myWarships, enemyWarships) {
      if (enemyWarships.length === 0 || myWarships.length === 0) return null;
      const reach = new Map();
      for (const enemy of enemyWarships) {
        const entry = this.fleetFocusEnemyEntry(enemy, myWarships);
        if (entry === null) continue;
        const prior = reach.get(entry.id);
        if (!prior || entry.votes > prior.votes ||
          (entry.votes === prior.votes && entry.hp < prior.hp)) {
          reach.set(entry.id, { votes: entry.votes, hp: entry.hp });
        }
      }
      if (reach.size === 0) return null;
      return this.bestFleetFocusId(reach);
    }

    // One enemy's focus-candidacy: how many of my warships can reach it (votes)
    // and its current HP, normalized to Infinity when unavailable. Returns null
    // when the enemy has no tile or no reachable warship.
    fleetFocusEnemyEntry(enemy, myWarships) {
      const enemyTile = enemy.tile();
      if (enemyTile === null || enemyTile === undefined) return null;
      let votes = 0;
      for (const warship of myWarships) {
        if (this.game.manhattanDist(warship.tile(), enemyTile) <= 30) votes++;
      }
      if (votes === 0) return null;
      const id = typeof enemy.id === "function" ? enemy.id() : enemy.id;
      const hpRaw = Number(enemy.health?.() ?? Infinity);
      return { id, votes, hp: Number.isFinite(hpRaw) ? hpRaw : Infinity };
    }

    // Pick the focus id with the most votes, tie-broken by lowest HP.
    bestFleetFocusId(reach) {
      let bestId = null;
      let best = null;
      for (const [id, info] of reach) {
        if (best === null ||
          info.votes > best.votes ||
          (info.votes === best.votes && info.hp < best.hp)) {
          best = info;
          bestId = id;
        }
      }
      return bestId;
    }

    warshipCombatBlocked(warship, assignment, smartState, friendlyPorts, tick) {
      const id = warship.id();
      if (assignment?.confirmed === true && tick < assignment.absoluteLandingTick) return true;
      if (this.movementOrderIssuedThisTick(id, smartState, tick)) return true;
      const cooldownTick = smartState.cooldown.get(id);
      if (cooldownTick !== undefined && tick - cooldownTick < 3) return true;
      const warshipState = warship.warshipState();
      return (warshipState?.state === "retreating" || warshipState?.state === "docked") &&
        friendlyPorts.length > 0;
    }

    handleWarshipCombat(warship, context) {
      const { smartState, friendlyPorts, enemyWarships, myWarships, enemyTradeShips,
        maxHp, retreatPct, huntTrade, primaryTargetId } = context;
      const id = warship.id();
      const tick = this.game.ticks();
      const assignment = smartState.invasionAssignments.get(id);
      if (this.warshipCombatBlocked(warship, assignment, smartState, friendlyPorts, tick)) return;
      const warshipState = warship.warshipState();
      const shipMaxHp = typeof warship.maxHealth === "function" ? warship.maxHealth() : maxHp;
      const nearbyEnemies = this.nearbyCombatEnemies(warship, enemyWarships);
      const wantsToEvade = this.warshipWantsToEvade(
        warship, nearbyEnemies, myWarships, shipMaxHp, retreatPct,
      );
      const target = this.combatTarget({
        warship, nearbyEnemies, enemyTradeShips, enemyWarships,
        baseTarget: this.combatRetreatTarget(warship, friendlyPorts, nearbyEnemies),
        wantsToEvade,
        retreatThreshold: shipMaxHp * retreatPct, huntTrade, primaryTargetId,
      });
      if (target === null || warshipState?.patrolTile === target) return;
      // Micromanagement pacing (see the WARSHIP_MOVE_* constants): an
      // unchanged-enough target keeps the standing order, the pass move cap
      // spreads retasking across passes, and a slice of the shared intent
      // budget is always reserved for attacks, builds and donations.
      if (this.warshipMoveTargetUnchanged(smartState, id, target, tick)) return;
      if ((context.movesIssued || 0) >= WARSHIP_COMBAT_PASS_MOVE_CAP) return;
      if (!this.warshipMoveBudgetAvailable()) return;
      if (this.moveWarship(warship, target)) {
        this.rememberWarshipMoveTarget(smartState, id, target, tick);
        context.movesIssued = (context.movesIssued || 0) + 1;
      }
      smartState.cooldown.set(id, tick);
    }

    // True while the newly computed target is close enough to the last order
    // we actually emitted for this ship: re-sending a near-identical anchor
    // every combat pass (evade waypoints and prey drift by a few tiles per
    // pass) is what flooded the shared intent budget.
    warshipMoveTargetUnchanged(smartState, id, target, tick) {
      const last = smartState.lastMoveTargets?.get(id);
      if (!last) return false;
      if (tick - last.tick >= WARSHIP_MOVE_RETARGET_TICKS) return false;
      return this.game.manhattanDist(target, last.tile) <= WARSHIP_MOVE_RETARGET_RADIUS;
    }

    rememberWarshipMoveTarget(smartState, id, target, tick) {
      if (!smartState.lastMoveTargets) smartState.lastMoveTargets = new Map();
      smartState.lastMoveTargets.set(id, { tile: target, tick });
    }

    // Non-consuming budget gate for warship moves: keep a reserve of the
    // shared tokens for non-warship producers instead of spending the budget
    // down to the last token. Sandboxes without the limiter allow moves.
    warshipMoveBudgetAvailable() {
      return this.warshipEmitBudgetAvailable(
        WARSHIP_MOVE_SECOND_TOKEN_RESERVE,
        WARSHIP_MOVE_MINUTE_TOKEN_RESERVE,
      );
    }

    // Token counts alone do not predict acceptance: the shared limiter also
    // enforces per-window spend caps (one below the server's per-second cap,
    // ten below its per-minute cap). A burst that passes a tokens-only check
    // still gets rejected once the window saturates — measured as 252 dropped
    // move_warship intents once the raid fleet grew to ten ships.
    warshipEmitBudgetAvailable(secondReserve, minuteReserve) {
      if (typeof getIntentRateLimitSnapshot !== "function") return true;
      const snapshot = getIntentRateLimitSnapshot();
      if (!snapshot || typeof snapshot !== "object") return true;
      const secondSpendCap =
        Number(snapshot.intentsPerSecond) - 1 || 9;
      const minuteSpendCap =
        Number(snapshot.intentsPerMinute) - 10 || 140;
      // Older snapshots (and test stubs) may predate the window-spend axes;
      // a missing field means "nothing spent yet".
      const secondWindowSpent = Number(snapshot.secondWindowSpent) || 0;
      const minuteWindowSpent = Number(snapshot.minuteWindowSpent) || 0;
      return (
        snapshot.secondTokens > secondReserve &&
        snapshot.minuteTokens > minuteReserve &&
        secondWindowSpent < secondSpendCap - secondReserve &&
        minuteWindowSpent < minuteSpendCap - minuteReserve
      );
    }

    canRunSmartWarshipCombat() {
      return this.player !== null && state.settings.winFixes &&
        state.settings.features.warship && !this.game.config().isUnitDisabled(UNIT.Warship);
    }

    smartWarshipCombat() {
      if (!this.canRunSmartWarshipCombat()) return;

      const me = this.player;
      const mySid = me.smallID();
      const s = this.ensureSmartState();
      const now = performance.now();
      const throttle = state.settings.warshipCombatThrottleMs || 800;
      if (now - (s.lastCombatPassMs || 0) < throttle) return;
      s.lastCombatPassMs = now;

      const myWarships = this.collectCombatUnits(
        UNIT.Warship,
        (unit) => unit.owner()?.smallID() === mySid && unit.isActive() && !unit.isUnderConstruction(),
        "myCombatWarships",
      );
      if (myWarships.length === 0) return;

      const unitInfo = typeof this.game.unitInfo === "function" ? this.game.unitInfo("Warship") : null;
      const maxHp = unitInfo ? (unitInfo.maxHealth || 1000) : 1000;
      const retreatPct = (state.settings.warshipRetreatHealthPct || 50) / 100;
      const huntTrade = state.settings.warshipHuntTrade !== false;
      const enemyWarships = this.collectCombatUnits(
        UNIT.Warship,
        (unit) => unit.owner()?.smallID() !== mySid && unit.isActive() &&
          !unit.isUnderConstruction() && !unit.isFriendly(me),
        "enemyCombatWarships",
      );
      const enemyTradeShips = huntTrade ? this.collectCombatUnits(
        UNIT.TradeShip,
        (unit) =>
          unit.owner()?.smallID() !== mySid &&
          unit.isActive() &&
          this.canWarshipHuntOwner(unit.owner()),
        "enemyCombatTradeShips",
      ) : [];
      const friendlyPorts = this.friendlyCombatPorts(me);
      // Nominate one fleet-wide focus target for this pass so the fleet
      // concentrates fire. Recomputed every pass: a destroyed or retreating
      // primary naturally drops out, and the next-most-reachable enemy takes
      // over. (Retreat anchors are per ship — see combatRetreatTarget.)
      const primaryTargetId = this.chooseFleetFocusTarget(myWarships, enemyWarships);
      const context = {
        smartState: s, friendlyPorts, enemyWarships, myWarships, enemyTradeShips,
        maxHp, retreatPct, huntTrade, primaryTargetId,
      };

      for (const warship of myWarships) {
        {
          this.handleWarshipCombat(warship, context);
        }
      }
    }

    // moveWarship helper — send move intent via WS
    moveWarship(warship, tile) {
      {
        const ctors = typeof discoverCtors === "function" ? discoverCtors(getEventBus()) : {};
        if (ctors.moveWarship) {
          return emitIntent(ctors.moveWarship, [warship.id()], tile);
        }
      }
      return false;
    }
  }
