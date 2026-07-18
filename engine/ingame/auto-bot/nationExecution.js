// Auto-Bot — nationExecution: a faithful 1:1 port of the in-game Nation AI
// orchestrator (src/core/execution/NationExecution.ts). Owns the tick gating,
// behavior construction + ordering, spawn, embargo relation upkeep.
//
// Two faithful adaptations vs the core class:
//  - DIFFICULTY: the src reads the lobby Nation difficulty; the bot REPLICATES a
//    user-chosen difficulty (currentDifficulty()) for its strategy, while enemy
//    stat reads (config().maxTroops(enemy)) still use the real game difficulty.
//  - TICK GATING: the engine may poll faster than the Nation decision cadence.
//    Edge-detect attackTick / structure-third crossings so polling never repeats
//    the full strategy chain or skips a crossing. Win-fix uses the configured
//    combatCadenceScale to stay more active than the faithful Nation cadence.
//
// Feature toggles (state.settings.features.*) gate whole behaviors on/off — a UX
// switch, NOT a strategy change (default all-on == fully faithful).
//
// Loaded after the behavior modules, before engine.

"use strict";

  // A coordinated invasion needs construction retries at the defensive combat
  // cadence. Routine probes still retain the ordinary attack-rate cadence, so
  // they cannot crowd out economy or create a Defense Post for every scout.
  const OVERWHELMING_DEFENSE_STRUCTURE_INTERVAL_TICKS = 3;

  // Once aggregate incoming troops match our current army, the bot already
  // keeps its troops home instead of counterattacking. The construction lane
  // must use that same threshold; otherwise a parity siege waits an ordinary
  // attack cadence before it can reinforce the threatened frontier.
  const SERIOUS_INCOMING_DEFENSE_RATIO = 1;

  class NationBot {
    constructor(game, opts) {
      this.mg = game;
      this.player = game.myPlayer();
      this.active = true;
      this.behaviorsInitialized = false;
      this.openingLandBurstPending = false;
      this.openingExpansionFollowUpPending = false;
      this.spawnExecAdded = false;
      this.lastSpawnTile = null; // last emitted spawn tile (to re-emit on change)
      this.lastSpawnTopKey = null; // "x,y" of the #1 spot we last committed to
      this.lastSpawnPickTick = null; // throttle re-evaluation during spawn phase
      this.status = "";
      this.lastSeenTick = -1;
      this.lastProcessedGameTick = null;
      this.incomingDefenseTargetKey = null;
      this.lastIncomingDefenseAttemptTick = -Infinity;
      this.lastIncomingDefenseStructureTick = -Infinity;
      this.embargoMalusApplied = new Set(); // smallIDs we've applied embargo malus to

      // Seed exactly like src (NationExecution.ts:54): simpleHash(playerId)+gameID.
      this.random = new PseudoRandom(
        simpleHash(String(opts && opts.playerId)) +
          simpleHash(String(opts && opts.gameId)),
      );
      // RNG consumed in src constructor order (NationExecution.ts:57-59).
      this.triggerRatio = this.random.nextInt(50, 60) / 100;
      this.reserveRatio = this.random.nextInt(30, 40) / 100;
      this.expandRatio = this.random.nextInt(10, 20) / 100;
      // …then init() order (NationExecution.ts:64-65).
      this.attackRate = this.getAttackRate();
      this.attackTick = this.random.nextInt(0, this.attackRate);
    }

    // getAttackRate — NationExecution.ts:74. Uses the REPLICATED difficulty.
    getAttackRate() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return this.random.nextInt(65, 100);
        case Difficulty.Medium:
          return this.random.nextInt(55, 70);
        case Difficulty.Hard:
          return this.random.nextInt(45, 60);
        case Difficulty.Impossible:
          return this.random.nextInt(30, 50);
        case Difficulty.Legendary:
          return this.random.nextInt(20, 35);
        default:
          return this.random.nextInt(30, 50);
      }
    }

    feat(name) {
      return Boolean(state.settings.features && state.settings.features[name]);
    }

    hasPendingOpeningExpansionIntent() {
      {
        return (
          typeof this.attackBehavior?.getPendingTerraNulliusAttackTroops ===
            "function" &&
          Number(this.attackBehavior.getPendingTerraNulliusAttackTroops()) > 0
        );
      }
    }

    tickIsCurrent(tickGeneration) {
      return tickGeneration == null ||
        (state.settings.enabled && state.tickGeneration === tickGeneration);
    }

    shouldRunNavalInvasion(me, config) {
      return Boolean(this.behaviorsInitialized && me?.isAlive() && this.feat("warship") &&
        state.settings.winFixes && !config.isUnitDisabled(UNIT.Warship) &&
        !config.isUnitDisabled(UNIT.TransportShip));
    }

    shouldTrackWarships(me, config) {
      return Boolean(this.behaviorsInitialized && me?.isAlive() && this.feat("warship") &&
        currentDifficulty() !== Difficulty.Easy && me.unitsConstructed(UNIT.Port) &&
        !config.isUnitDisabled(UNIT.Warship));
    }

    async runNavalTickPhases(me, profile, tickGeneration) {
      const live = () => this.tickIsCurrent(tickGeneration);
      const config = this.mg.config();
      if (this.shouldRunNavalInvasion(me, config)) {
        {
          await autoBotProfileAsyncPhase(profile, "naval-invasion", () =>
            this.warshipBehavior.protectAgainstNavalInvasions());
          if (!live()) return false;
        }
      }
      if (!this.shouldTrackWarships(me, config)) return true;
      {
        if (state.settings.warshipAutoSpawn !== false) {
          autoBotProfileSyncPhase(profile, "warship-track", () =>
            this.warshipBehavior.trackShipsAndRetaliate());
        }
        if (!state.settings.winFixes) return true;
        if (state.settings.warshipNukeDodge !== false) {
          autoBotProfileSyncPhase(profile, "warship-dodge", () =>
            this.warshipBehavior.dodgeNukes());
        }
        autoBotProfileSyncPhase(profile, "warship-patrol", () =>
          this.warshipBehavior.smartWarshipPatrol());
        autoBotProfileSyncPhase(profile, "warship-combat", () =>
          this.warshipBehavior.smartWarshipCombat());
      }
      return true;
    }

    handleSpawnTick(ticks, profile) {
      if (!this.mg.inSpawnPhase()) return false;
      if (this.feat("spawn") &&
        (this.lastSpawnPickTick == null || ticks - this.lastSpawnPickTick >= 6)) {
        this.lastSpawnPickTick = ticks;
        const topKey = autoBotProfileSyncPhase(profile, "spawn-selection", () =>
          this.currentSpawnTopKey());
        if (!this.spawnExecAdded || (topKey != null && topKey !== this.lastSpawnTopKey)) {
          this.lastSpawnTopKey = topKey;
          autoBotProfileSyncPhase(profile, "spawn-emit", () => this.doSpawn());
        }
      }
      this.status = tr("Spawn phase…");
      return true;
    }

    async initializeTick(ticks, profile, tickGeneration) {
      if (this.behaviorsInitialized) return false;
      this.initializeBehaviors();
      this.structureBehavior.observeHostileMissileLaunch?.();
      if (this.feat("expand")) {
        const openingWinFix = state.settings.winFixes === true;
        const openingCommitFraction = openingWinFix ? EARLY_EXPAND_COMMIT : 0.5;
        const openingAttackSent = await autoBotProfileAsyncPhase(profile, "opening-attack", () =>
          this.attackBehavior.forceSendAttack(this.mg.terraNullius(), openingCommitFraction));
        if (!this.tickIsCurrent(tickGeneration)) return true;
        this.openingLandBurstPending = openingWinFix && !openingAttackSent;
        this.openingExpansionFollowUpPending = openingWinFix && openingAttackSent;
      }
      this.lastSeenTick = ticks;
      return true;
    }

    async handleOpeningExpansion(ticks, profile, tickGeneration) {
      const pending = this.openingLandBurstPending || this.openingExpansionFollowUpPending;
      if (!pending || !state.settings.winFixes || !(this.feat("expand") || this.feat("boat"))) {
        return false;
      }
      if (this.hasPendingOpeningExpansionIntent()) {
        this.lastSeenTick = ticks;
        return true;
      }
      this.openingLandBurstPending = false;
      this.openingExpansionFollowUpPending = false;
      this.status = tr("Thinking…");
      {
        const continued = await autoBotProfileAsyncPhase(
          profile,
          "expansion-follow-up",
          () => this.attackBehavior.continueOpeningExpansion(),
        );
        if (!this.tickIsCurrent(tickGeneration)) return true;
        const followUpPending =
          this.hasPendingOpeningExpansionIntent() || continued === true;
        this.openingExpansionFollowUpPending = followUpPending;
        if (!followUpPending) return false;
      }
      this.lastSeenTick = ticks;
      return true;
    }

    incomingDefenseKey(attacker) {
      const smallID = attacker?.smallID?.();
      if (smallID !== null && smallID !== undefined) return String(smallID);
      return String(attacker?.id?.() ?? "hostile");
    }

    incomingDefenseStructureInterval() {
      if (this.attackBehavior.hasOverwhelmingIncomingAttack?.() === true) {
        return OVERWHELMING_DEFENSE_STRUCTURE_INTERVAL_TICKS;
      }
      const pressure = Number(
        this.attackBehavior.incomingHostileAttackPressure?.(),
      );
      return pressure >= SERIOUS_INCOMING_DEFENSE_RATIO
        ? OVERWHELMING_DEFENSE_STRUCTURE_INTERVAL_TICKS
        : this.attackRate;
    }

    async handleIncomingDefense(ticks, profile, tickGeneration) {
      if (!state.settings.winFixes) return false;
      const attacker = this.attackBehavior.findIncomingAttackPlayer();
      if (attacker === null) {
        this.incomingDefenseTargetKey = null;
        return false;
      }
      const targetKey = this.incomingDefenseKey(attacker);
      const newThreat = targetKey !== this.incomingDefenseTargetKey;
      this.incomingDefenseTargetKey = targetKey;
      this.openingLandBurstPending = false;
      this.openingExpansionFollowUpPending = false;
      const retryDue = newThreat || ticks - this.lastIncomingDefenseAttemptTick >= 3;
      if (retryDue) {
        this.lastIncomingDefenseAttemptTick = ticks;
        await autoBotProfileAsyncPhase(profile, "incoming-defense-attack", () =>
          this.attackBehavior.respondToIncomingAttack());
        if (!this.tickIsCurrent(tickGeneration)) return true;
      }
      const structureDue =
        this.feat("build") &&
        (newThreat ||
          ticks - this.lastIncomingDefenseStructureTick >=
            this.incomingDefenseStructureInterval());
      if (structureDue) {
        this.lastIncomingDefenseStructureTick = ticks;
        await autoBotProfileAsyncPhase(profile, "incoming-defense-structures", () =>
          this.structureBehavior.handleStructures(profile));
        if (!this.tickIsCurrent(tickGeneration)) return true;
      }
      this.lastSeenTick = ticks;
      return true;
    }

    getTickCrossings(ticks) {
      const from = this.lastSeenTick < 0 ? ticks : this.lastSeenTick + 1;
      this.lastSeenTick = ticks;
      let attackRate = this.attackRate;
      const scale = Number(state.settings.combatCadenceScale ?? 0.6);
      if (state.settings.winFixes && Number.isFinite(scale) && scale > 0 && scale !== 1) {
        attackRate = Math.max(1, Math.round(this.attackRate * scale));
      }
      const attackOffset = this.attackTick % attackRate;
      const span = Math.max(0, ticks - from);
      const firstOffset = ((from % attackRate) + attackRate) % attackRate;
      const contains = (target) => (target - firstOffset + attackRate) % attackRate <= span;
      return {
        attack: contains(attackOffset),
        third: contains((attackOffset + Math.floor(attackRate / 3)) % attackRate) ||
          contains((attackOffset + Math.floor((attackRate * 2) / 3)) % attackRate),
      };
    }

    async handleBetweenAttackTicks(thirdCrossed, profile, tickGeneration) {
      if (thirdCrossed && this.feat("build")) {
        await autoBotProfileAsyncPhase(profile, "structures-between", () =>
          this.structureBehavior.handleStructures(profile));
        if (!this.tickIsCurrent(tickGeneration)) return;
      }
      const emergency = state.settings.winFixes && this.feat("warship") &&
        state.settings.warshipAutoSpawn !== false &&
        this.warshipBehavior.incomingMaritimeInvasionSignal?.()?.active === true;
      if (!emergency) return;
      await autoBotProfileAsyncPhase(profile, "warship-emergency-build", () =>
        this.warshipBehavior.maybeSpawnWarship());
    }

    runDiplomacy(profile) {
      autoBotProfileSyncPhase(profile, "diplomacy", () => {
        this.updateRelationsFromEmbargos();
        this.allianceBehavior.handleAllianceRequestsFromBots();
        if (!this.feat("alliance")) return;
        this.allianceBehavior.handleAllianceRequests();
        this.allianceBehavior.handleAllianceExtensionRequests();
      });
    }

    async runOptionalAsyncPhase(enabled, profile, name, action, tickGeneration) {
      if (!enabled) return true;
      await autoBotProfileAsyncPhase(profile, name, action);
      return this.tickIsCurrent(tickGeneration);
    }

    async runDecisionChain(profile, tickGeneration) {
      this.status = tr("Thinking…");
      {
        autoBotProfileSyncPhase(profile, "emoji", () =>
          this.emojiBehavior.maybeSendCasualEmoji());
        this.runDiplomacy(profile);
        if (!(await this.runOptionalAsyncPhase(this.feat("nuke"), profile, "mirv",
          () => this.mirvBehavior.considerMIRV(), tickGeneration))) return;
        if (!(await this.runOptionalAsyncPhase(this.feat("build"), profile, "structures",
          () => this.structureBehavior.handleStructures(profile), tickGeneration))) return;
        const warship = this.feat("warship") && state.settings.warshipAutoSpawn !== false;
        if (!(await this.runOptionalAsyncPhase(warship, profile, "warship-build",
          () => this.warshipBehavior.maybeSpawnWarship(), tickGeneration))) return;
        if (this.feat("embargo")) {
          autoBotProfileSyncPhase(profile, "embargo", () =>
            this.handleEmbargoesToHostileNations());
        }
        if (!(await this.runOptionalAsyncPhase(this.feat("expand") || this.feat("boat"),
          profile, "attack", () => this.attackBehavior.maybeAttack(profile), tickGeneration))) return;
        if (!(await this.runOptionalAsyncPhase(warship, profile, "warship-counter",
          () => this.warshipBehavior.counterWarshipInfestation(), tickGeneration))) return;
        await this.runOptionalAsyncPhase(this.feat("nuke"), profile, "nuke",
          () => this.nukeBehavior.maybeSendNuke(), tickGeneration);
      }
    }

    prepareEarlyGameMaritimeState(profile) {
      if (
        !state.settings.winFixes ||
        !(this.feat("expand") || this.feat("boat"))
      ) {
        return;
      }
      this.attackBehavior.prepareEarlyGameMaritimeIndexSlice?.(profile);
    }

    async tick(ticks, profile, tickGeneration) {
      if (!this.tickIsCurrent(tickGeneration)) return;
      this.player = this.mg.myPlayer();
      this.refreshBehaviorPlayerReferences();
      const me = this.player;
      if (this.isDuplicateGameTick(ticks)) return;
      this.lastProcessedGameTick = ticks;
      if (this.behaviorsInitialized && me?.isAlive()) {
        this.structureBehavior.observeHostileMissileLaunch?.();
        this.prepareEarlyGameMaritimeState(profile);
      }
      if (!(await this.runNavalTickPhases(me, profile, tickGeneration))) return;
      if (me === null || this.handleSpawnTick(ticks, profile)) return;
      if (this.handleEliminatedPlayer(me)) return;
      if (await this.initializeTick(ticks, profile, tickGeneration)) return;
      if (await this.handleIncomingDefense(ticks, profile, tickGeneration)) return;
      if (await this.handleOpeningExpansion(ticks, profile, tickGeneration)) return;
      const crossings = this.getTickCrossings(ticks);
      if (!crossings.attack) {
        await this.handleBetweenAttackTicks(crossings.third, profile, tickGeneration);
        return;
      }
      await this.runDecisionChain(profile, tickGeneration);
    }

    refreshBehaviorPlayerReferences() {
      if (!this.behaviorsInitialized) return;
      for (const behavior of [
        this.emojiBehavior,
        this.mirvBehavior,
        this.allianceBehavior,
        this.warshipBehavior,
        this.attackBehavior,
        this.nukeBehavior,
        this.structureBehavior,
      ]) {
        if (behavior) behavior.player = this.player;
      }
    }

    handleEliminatedPlayer(player) {
      if (player.isAlive()) return false;
      this.active = false;
      this.status = tr("💀 Eliminated");
      return true;
    }

    isDuplicateGameTick(ticks) {
      return ticks != null && this.lastProcessedGameTick === ticks;
    }
    initializeBehaviors() {
      const r = this.random;
      const g = this.mg;
      const p = this.player;
      this.emojiBehavior = new EmojiBehavior(r, g, p);
      this.mirvBehavior = new MirvBehavior(r, g, p, this.emojiBehavior);
      this.allianceBehavior = new AllianceBehavior(r, g, p, this.emojiBehavior);
      this.warshipBehavior = new WarshipBehavior(r, g, p, this.emojiBehavior);
      this.attackBehavior = new AttackBehavior({
        random: r,
        game: g,
        player: p,
        triggerRatio: this.triggerRatio,
        reserveRatio: this.reserveRatio,
        expandRatio: this.expandRatio,
        allianceBehavior: this.allianceBehavior,
        emojiBehavior: this.emojiBehavior,
      });
      this.nukeBehavior = new NukeBehavior(
        r, g, p, this.attackBehavior, this.emojiBehavior,
      );
      this.structureBehavior = new StructureBehavior(r, g, p);
      this.nukeBehavior.structureBehavior = this.structureBehavior;
      this.behaviorsInitialized = true;
    }

    // ── spawn pick — port of SpawnExecution.getSpawn (no-spawnCell branch,
    //    SpawnExecution.ts:105-151): a random whole-map (or team-area) land tile,
    //    unowned, not on a border, not within minDistanceBetweenPlayers of another
    //    player's spawn, with a valid spawn cluster. 1000 tries.
    //    Two unavoidable client DIVERGENCES (data not surfaced client-side):
    //    (a) other players' spawnTile() is not exposed → proximity is checked
    //        against their nameLocation (territory centre), spawned players only;
    //    (b) getSpawnTiles' all-valid 4-radius BFS is not reproducible → `!isBorder`
    //        (which excludes coast/edge tiles) is the faithful client stand-in for
    //        "interior tile with a full land neighbourhood".
    //    Emits the UI spawn intent (the worker re-validates the chosen tile).
    // "x,y" grid key of the current #1 spawn spot, or null. Prefers the exact
    // selector when its map-sized index is affordable, then the live visual
    // heatmap topSpots and its bounded fallback scorer.
    currentSpawnTopKey() {
      if (!state.settings.smartSpawn) return null;
      let ts = null;
      {
        // The live entry point is non-blocking: exact map-resolution ranking is
        // completed in idle slices and the function returns its last result or
        // the bounded fallback while that job is still running.
        if (typeof computeSpawnTopSpotsForBot === "function") {
          ts = computeSpawnTopSpotsForBot(this.mg, this.player);
        }
        if ((!ts || ts.length === 0) && typeof getSpawnHeatmapTopSpots === "function") {
          ts = getSpawnHeatmapTopSpots();
        }
      }
      return ts && ts.length > 0 ? `${ts[0].x},${ts[0].y}` : null;
    }

    doSpawn() {
      const center = this.pickSpawnCenter();
      if (center == null) {
        this.status = tr("Spawn phase…");
        return;
      }
      // Nothing to do if the best tile hasn't moved since the last emit.
      if (this.spawnExecAdded && center === this.lastSpawnTile) {
        return;
      }
      const ctors = discoverCtors(getEventBus());
      if (ctors.spawn) {
        emitIntent(ctors.spawn, center);
        const moved = this.spawnExecAdded;
        this.spawnExecAdded = true;
        this.lastSpawnTile = center;
        if (!moved) {
          state.stats.spawns++;
        }
        setLastAction(tr("🏁 Spawned"), "spawn");
      }
    }

    getSpawnConstraints() {
      const game = this.mg;
      let minDistance = 30;
      {
        const configured = game.config().minDistanceBetweenPlayers();
        if (Number.isFinite(configured)) minDistance = configured;
      }
      let area = null;
      {
        const team = this.player.team();
        if (team !== null && typeof game.__src?.teamSpawnArea === "function") {
          area = game.__src.teamSpawnArea(team) ?? null;
        }
      }
      const others = game.players().filter((player) =>
        player.smallID() !== this.player.smallID() && player.hasSpawned());
      // The heatmap's asynchronous exact ranker and its bounded fallback both
      // select points inside this hull. Keep the final snap/search inside it
      // too: an invalid scored point must not be repaired by moving outside
      // the geometry formed by already-spawned teammates.
      const teamPolyhedron = typeof getTeamSpawnPolyhedron === "function"
        ? getTeamSpawnPolyhedron(game, this.player)
        : null;
      return {
        game, area, others, minDistance, teamPolyhedron,
        width: game.width(), height: game.height(),
      };
    }

    isSpawnTooClose(tile, constraints) {
      const { game, others, minDistance } = constraints;
      return others.some((other) => {
        const location = other.nameLocation();
        return location &&
          game.manhattanDist(game.ref(location.x, location.y), tile) < minDistance;
      });
    }

    isValidSpawnTile(tile, constraints) {
      const { game, area, teamPolyhedron } = constraints;
      if (tile == null || !game.isLand(tile) || game.hasOwner(tile) || game.isBorder(tile)) return false;
      if (game.magnitude && game.magnitude(tile) === 31) return false;
      if (teamPolyhedron && typeof isPointInsideTeamPolyhedron === "function") {
        if (!isPointInsideTeamPolyhedron(game.x(tile), game.y(tile), teamPolyhedron)) return false;
      }
      if (area) {
        const x = game.x(tile);
        const y = game.y(tile);
        if (x < area.x || x >= area.x + area.width || y < area.y || y >= area.y + area.height) {
          return false;
        }
      }
      return !this.isSpawnTooClose(tile, constraints);
    }

    findValidSpawnOnRing(sx, sy, radius, constraints) {
      const game = constraints.game;
      for (let dy = -radius; dy <= radius; dy += 2) {
        for (let dx = -radius; dx <= radius; dx += 2) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (!game.isValidCoord(x, y)) continue;
          const tile = game.ref(x, y);
          if (this.isValidSpawnTile(tile, constraints)) return tile;
        }
      }
      return null;
    }

    snapToValidSpawn(sx, sy, constraints) {
      const game = constraints.game;
      if (game.isValidCoord(sx, sy)) {
        const tile = game.ref(sx, sy);
        if (this.isValidSpawnTile(tile, constraints)) return tile;
      }
      for (let radius = 2; radius <= 24; radius += 2) {
        const tile = this.findValidSpawnOnRing(sx, sy, radius, constraints);
        if (tile != null) return tile;
      }
      return null;
    }

    getRankedSpawnTile(constraints) {
      let topSpots = null;
      {
        if (typeof computeSpawnTopSpotsForBot === "function") {
          topSpots = computeSpawnTopSpotsForBot(this.mg, this.player);
        }
        if ((!topSpots || topSpots.length === 0) &&
          typeof getSpawnHeatmapTopSpots === "function") {
          topSpots = getSpawnHeatmapTopSpots();
        }
      }
      if (!topSpots) return null;
      for (const spot of topSpots) {
        const tile = this.snapToValidSpawn(spot.x, spot.y, constraints);
        if (tile != null) return tile;
      }
      return null;
    }

    getRandomSpawnCoordinate(limit, start = 0) {
      return this.random.nextInt(start, start + limit);
    }

    pickSampledSpawnTile(constraints, useSmart) {
      const { game, area, others, width, height } = constraints;
      let bestTile = null;
      let bestScore = -Infinity;
      for (let tries = 0; tries < 1000; tries += 1) {
        const x = area
          ? this.getRandomSpawnCoordinate(area.width, area.x)
          : this.getRandomSpawnCoordinate(width);
        const y = area
          ? this.getRandomSpawnCoordinate(area.height, area.y)
          : this.getRandomSpawnCoordinate(height);
        if (!game.isValidCoord(x, y)) continue;
        const tile = game.ref(x, y);
        if (!this.isValidSpawnTile(tile, constraints)) continue;
        if (!useSmart) return tile;
        const score = this.scoreSpawnTile(tile, others, width, height, area);
        if (score <= bestScore) continue;
        bestScore = score;
        bestTile = tile;
      }
      return bestTile;
    }

    pickSpawnCenter() {
      // Companion mode pins the spawn next to the configured boss when active.
      if (typeof companionSpawnCenter === "function") {
        const companionTile = companionSpawnCenter(this.mg, this.player);
        if (companionTile != null) return companionTile;
      }
      const constraints = this.getSpawnConstraints();
      const useSmart = state.settings.smartSpawn;
      if (useSmart) {
        const rankedTile = this.getRankedSpawnTile(constraints);
        if (rankedTile != null) return rankedTile;
      }
      return this.pickSampledSpawnTile(constraints, useSmart);
    }

    // DIVERGENCE: spawn scoring (Tactical spawn-scoring port). Scores a candidate
    // tile by: land density in a 12-radius neighbourhood, distance from the
    // nearest enemy nameLocation (farther = better), and edge avoidance (centre
    // of map preferred). Team mode adds a pull toward the team spawn area centre.
    getSpawnLandDensity(tx, ty) {
      const g = this.mg;
      const R = 12;
      let land = 0;
      let total = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (!g.isValidCoord(nx, ny)) continue;
          total++;
          if (g.isLand(g.ref(nx, ny))) land++;
        }
      }
      return total > 0 ? land / total : 0;
    }

    getNearestSpawnEnemyDistance(tx, ty, others) {
      let minEnemyDist = Infinity;
      for (const other of others) {
        const loc = other.nameLocation();
        if (!loc) continue;
        const d = Math.abs(loc.x - tx) + Math.abs(loc.y - ty);
        if (d < minEnemyDist) minEnemyDist = d;
      }
      return minEnemyDist;
    }

    scoreSpawnTile(tile, others, W, H, area = null) {
      const g = this.mg;
      const tx = g.x(tile);
      const ty = g.y(tile);
      let score = this.getSpawnLandDensity(tx, ty) * 40;
      score += Math.min(1, this.getNearestSpawnEnemyDistance(tx, ty, others) / 200) * 30;

      // Edge avoidance: prefer tiles away from map edges.
      const edgeDist = Math.min(tx, ty, W - 1 - tx, H - 1 - ty);
      score += Math.min(1, edgeDist / 30) * 20;

      // Team area pull: bonus for being near the team spawn area centre.
      if (area) {
        const cx = area.x + area.width / 2;
        const cy = area.y + area.height / 2;
        const teamDist = Math.abs(tx - cx) + Math.abs(ty - cy);
        const teamRadius = (area.width + area.height) / 2;
        score += Math.max(0, 1 - teamDist / Math.max(1, teamRadius)) * 10;
      }

      return score;
    }

    updateEmbargoRelation(other, player, embargoMalus) {
      const smallId = other.smallID();
      const embargoed = other.hasEmbargoAgainst(player);
      const applied = this.embargoMalusApplied.has(smallId);
      if (embargoed && !applied) {
        player.updateRelation(other, embargoMalus);
        this.embargoMalusApplied.add(smallId);
      } else if (!embargoed && applied) {
        player.updateRelation(other, -embargoMalus);
        this.embargoMalusApplied.delete(smallId);
      }
    }

    // updateRelationsFromEmbargos — NationExecution.ts:285. AI-subjective ±20
    // (overlay write via player.updateRelation).
    updateRelationsFromEmbargos() {
      const player = this.player;
      if (player === null) return;
      const others = this.mg.players().filter((p) => p.id() !== player.id());
      const embargoMalus = -20;
      others.forEach((other) => this.updateEmbargoRelation(other, player, embargoMalus));
    }

    // handleEmbargoesToHostileNations — NationExecution.ts:308.
    handleEmbargoForPlayer(other, player, difficulty, forceTeamEmbargo) {
      const sameTeam = player.isOnSameTeam(other);
      const embargoed = player.hasEmbargoAgainst(other);
      if (forceTeamEmbargo && other.type() !== PlayerType.Bot && !sameTeam) {
        if (!embargoed) this.addEmbargo(other, false);
        return;
      }
      const relation = player.relation(other);
      if (relation <= Relation.Hostile && !embargoed && !sameTeam) {
        this.addEmbargo(other, false);
      } else if (relation >= Relation.Neutral && embargoed &&
        !isAtLeastHardDifficulty(difficulty)) {
        this.stopEmbargo(other);
      } else if (relation >= Relation.Friendly && embargoed &&
        ![Difficulty.Impossible, Difficulty.Legendary].includes(difficulty)) {
        this.stopEmbargo(other);
      }
    }

    handleEmbargoesToHostileNations() {
      const player = this.player;
      if (player === null) return;
      const others = this.mg.players().filter((p) => p.id() !== player.id());
      const difficulty = currentDifficulty();
      const forceTeamEmbargo = isAtLeastHardDifficulty(difficulty) &&
        this.mg.config().gameConfig().gameMode === GameMode.Team;
      others.forEach((other) =>
        this.handleEmbargoForPlayer(other, player, difficulty, forceTeamEmbargo));
    }

    addEmbargo(other, _temporary) {
      const ctors = discoverCtors(getEventBus());
      if (ctors.embargo) emitIntent(ctors.embargo, other.__src ?? other, "start");
    }
    stopEmbargo(other) {
      const ctors = discoverCtors(getEventBus());
      if (ctors.embargo) emitIntent(ctors.embargo, other.__src ?? other, "stop");
    }
  }
