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

  // The first automatic spawn must not run before the game exposes its roster.
  // After that brief discovery window, periodic re-ranking adopts teammate
  // geometry as anchors arrive, without sacrificing the opening to a full
  // team-wide wait.
  const TEAM_SPAWN_DISCOVERY_TICKS = 6;
  const SPAWN_CONNECTIVITY_WAIT_TICKS = 90;
  // Diplomacy is eventually consistent and substantially lower priority than
  // combat. Drain a large hostile roster gradually instead of spending the
  // entire per-second intent bucket (and retrying every rejected target).
  const EMBARGO_INTENTS_PER_DECISION = 2;
  // Early-expansion window for the adaptive tier: engine nations re-send
  // near-full-army waves into free land on every cadence crossing, so the
  // two-minute land-leader race needs a faster decision cadence early. The
  // window is time-boxed; afterwards the historical cadence scale applies.
  const LEGENDARY_OPENING_WINDOW_TICKS = 1200;
  const LEGENDARY_OPENING_CADENCE_SCALE = 0.6;

  class NationBot {
    constructor(game, opts) {
      this.mg = game;
      this.player = game.myPlayer();
      this.active = true;
      this.behaviorsInitialized = false;
      this.openingLandBurstPending = false;
      this.openingExpansionFollowUpPending = false;
      this.lastOpeningCityAttemptTick = -Infinity;
      this.spawnExecAdded = false;
      this.lastSpawnTile = null; // last emitted spawn tile (to re-emit on change)
      this.lastSpawnTopKey = null; // "x,y" of the #1 spot we last committed to
      this.lastSpawnPickTick = null; // throttle re-evaluation during spawn phase
      // Spread simultaneous team bots across a five-tick window without
      // consuming the faithful Nation RNG sequence used by combat behavior.
      this.spawnPickJitterTicks =
        (simpleHash(`${opts?.playerId ?? ""}:${opts?.gameId ?? ""}`) % 5) - 2;
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
        case Difficulty.Legendary:
          // The adaptive tier keeps the proven Impossible attack cadence;
          // the faster 20-35 variant collapsed team-basket wins (2026-09-11).
          return this.random.nextInt(30, 50);
        default:
          return this.random.nextInt(30, 50);
      }
    }

    feat(name) {
      return Boolean(state.settings.features && state.settings.features[name]);
    }

    hasPendingOpeningExpansionIntent() {
      if (
        typeof this.attackBehavior?.getPendingTerraNulliusAttackTroops !== "function" ||
        Number(this.attackBehavior.getPendingTerraNulliusAttackTroops()) <= 0
      ) {
        return false;
      }
      // Free-land has no recipient ID, so its unconfirmed commands remain
      // reserved until the engine acknowledges them.  Keep issuing bounded
      // parallel opening commands while allocation remains, then wait for an
      // acknowledgement before the continuous follow-up lane can spend again.
      if (typeof this.attackBehavior?.getRemainingTerraNulliusOpeningCommitment === "function") {
        return this.attackBehavior.getRemainingTerraNulliusOpeningCommitment() <= 0;
      }
      return true;
    }

    hasActiveOpeningExpansionAttack() {
      return (
        (typeof this.attackBehavior?.getLiveTerraNulliusAttackTroops === "function" &&
          Number(this.attackBehavior.getLiveTerraNulliusAttackTroops()) > 0) ||
        this.attackBehavior?.hasRecentTerraNulliusAttackIntent?.() === true
      );
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
      // An accepted personal spawn does not mean land attacks are executable:
      // the match remains globally frozen until the spawn phase closes. Keep
      // reranking while it is open, though: SpawnExecution accepts a later
      // location, so newly-arrived teammate anchors must still move us toward
      // the team centroid.
      const hasSpawned = this.player.hasSpawned?.() === true;
      const awaitingConnectivity = !hasSpawned && this.shouldAwaitSpawnConnectivity(ticks);
      if (!hasSpawned &&
        (this.shouldAwaitInitialTeamSpawnGeometry(ticks) || awaitingConnectivity)) {
        this.status = tr("Coordinating team spawn…");
        return true;
      }
      if (this.feat("spawn") &&
        (this.lastSpawnPickTick == null ||
          ticks - this.lastSpawnPickTick >= 15 + this.spawnPickJitterTicks)) {
        this.lastSpawnPickTick = ticks;
        const topKey = autoBotProfileSyncPhase(profile, "spawn-selection", () =>
          this.currentSpawnTopKey());
        if (!this.spawnExecAdded || (topKey != null && topKey !== this.lastSpawnTopKey)) {
          this.lastSpawnTopKey = topKey;
          autoBotProfileSyncPhase(profile, "spawn-emit", () => this.doSpawn(topKey));
        }
      }
      this.status = hasSpawned ? tr("Waiting for match start…") : tr("Spawn phase…");
      return true;
    }

    shouldAwaitSpawnConnectivity(ticks) {
      if (!this.feat("spawn") ||
        typeof prepareSpawnCandidateConnectivity !== "function") return false;
      const connectivityReady = prepareSpawnCandidateConnectivity(this.mg);
      return connectivityReady === false && ticks < SPAWN_CONNECTIVITY_WAIT_TICKS;
    }

    shouldAwaitInitialTeamSpawnGeometry(ticks) {
      if (this.spawnExecAdded) return false;
      // The game may populate the roster only after the first decision tick.
      // Our own team can still be null in that same window, so never emit a
      // blind automatic spawn before the roster can be inspected.
      if (ticks < TEAM_SPAWN_DISCOVERY_TICKS) return true;
      if (this.player.team?.() == null) return false;
      // Start with the best presently legal tile once the roster is visible.
      // Spawn intents remain movable during this phase, so each scheduled
      // re-rank can pull us into the team hull/corridor as teammates commit
      // their robust team objective as teammates commit their anchors; waiting
      // for every human would lose too much opening.
      return false;
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

    openingExpansionIsActive() {
      const pending = this.openingLandBurstPending || this.openingExpansionFollowUpPending;
      return pending && state.settings.winFixes && (this.feat("expand") || this.feat("boat"));
    }

    openingAllocationRemaining() {
      const actionable =
        this.attackBehavior.getActionableRemainingTerraNulliusOpeningCommitment;
      const remaining =
        typeof actionable === "function"
          ? actionable.call(this.attackBehavior)
          : this.attackBehavior.getRemainingTerraNulliusOpeningCommitment?.() ?? 0;
      return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    }

    openingAllocationIsBounded() {
      return Number.isFinite(
        this.attackBehavior.getRemainingTerraNulliusOpeningCommitment?.(),
      );
    }

    openingTerraNulliusIsAccessible() {
      const check = this.attackBehavior?.hasLandBorderWithTerraNullius;
      return typeof check !== "function" || check.call(this.attackBehavior) === true;
    }

    async handleOpeningExpansion(ticks, profile, tickGeneration) {
      if (!this.openingExpansionIsActive()) return false;
      // The opening troop chain can remain pending for many engine ticks.
      // Do not make that movement-only period postpone the foundational City
      // until the ordinary cadence finally resumes: one City compounds troop
      // and gold production, whereas Ports, Factories and upgrades can wait.
      if (!(await this.maybeBuildOpeningCity(ticks, profile, tickGeneration))) return true;
      const openingAllocationRemaining = this.openingAllocationRemaining();
      if (this.hasPendingOpeningExpansionIntent() && openingAllocationRemaining <= 0) {
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
        const allocationStillAvailable =
          this.openingAllocationRemaining() > 0 &&
          this.openingTerraNulliusIsAccessible();
        const followUpPending =
          allocationStillAvailable ||
          this.hasPendingOpeningExpansionIntent() ||
          (this.openingAllocationIsBounded() &&
            this.hasActiveOpeningExpansionAttack()) ||
          continued === true;
        this.openingExpansionFollowUpPending = followUpPending;
        if (!followUpPending) return false;
      }
      this.lastSeenTick = ticks;
      return true;
    }

    async maybeBuildOpeningCity(ticks, profile, tickGeneration) {
      if (!this.feat("build")) return true;
      if (ticks - this.lastOpeningCityAttemptTick < 12) return true;
      const config = this.mg.config?.();
      if (config?.isUnitDisabled?.(UNIT.City)) return true;
      const cities = this.player?.units?.(UNIT.City) || [];
      if (cities.length > 0) return true;
      if (typeof this.structureBehavior?.maybeSpawnStructure !== "function") return true;

      this.lastOpeningCityAttemptTick = ticks;
      await autoBotProfileAsyncPhase(profile, "opening-city", () =>
        this.structureBehavior.maybeSpawnStructure(UNIT.City));
      return this.tickIsCurrent(tickGeneration);
    }

    incomingDefenseKey(attacker) {
      const smallID = attacker?.smallID?.();
      if (smallID !== null && smallID !== undefined) return String(smallID);
      return String(attacker?.id?.() ?? "hostile");
    }

    incomingDefenseThreatKey(fallbackAttacker) {
      const attacks = this.attackBehavior.incomingHostileAttacks?.();
      if (!Array.isArray(attacks) || attacks.length === 0) {
        return this.incomingDefenseKey(fallbackAttacker);
      }
      const attackers = new Set();
      for (const attack of attacks) {
        const attacker = attack?.attacker?.();
        if (attacker !== null && attacker !== undefined) {
          attackers.add(this.incomingDefenseKey(attacker));
        }
      }
      return attackers.size > 0
        ? [...attackers].sort().join("|")
        : this.incomingDefenseKey(fallbackAttacker);
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
      // The strongest attacker can alternate every tick in a coordinated
      // siege.  Keep that leader for the counterattack, but only restart the
      // defensive lanes when the hostile set itself changes.
      const threatKey = this.incomingDefenseThreatKey(attacker);
      const newThreat = threatKey !== this.incomingDefenseTargetKey;
      this.incomingDefenseTargetKey = threatKey;
      this.openingLandBurstPending = false;
      this.openingExpansionFollowUpPending = false;
      const retryDue = newThreat || ticks - this.lastIncomingDefenseAttemptTick >= 3;
      if (retryDue) {
        this.lastIncomingDefenseAttemptTick = ticks;
        // A structure probe below is asynchronous and may advance the tick
        // generation.  The old ordering therefore let the first incoming
        // wave make the subsequent warship bridge stale before it ran.  Put
        // the actionable first-hull probe ahead of both retaliation and
        // structure placement: a completed Port plus an affordable hull is
        // a time-sensitive coastal-defense obligation, while the other lanes
        // can retry on the next decision tick without losing state.
        if (this.feat("warship") && state.settings.warshipAutoSpawn !== false &&
          this.warshipBehavior.shouldPrioritizeInitialWarshipBuild?.() === true) {
          await autoBotProfileAsyncPhase(profile, "warship-defense-build", () =>
            this.warshipBehavior.maybeSpawnWarship());
          if (!this.tickIsCurrent(tickGeneration)) return true;
        }
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
      let scale = Number(state.settings.combatCadenceScale ?? 0.6);
      if (
        typeof currentDifficulty === "function" &&
        (currentDifficulty() === Difficulty.Legendary ||
          currentDifficulty() === Difficulty.Impossible) &&
        ticks <= LEGENDARY_OPENING_WINDOW_TICKS
      ) {
        scale *= LEGENDARY_OPENING_CADENCE_SCALE;
      }
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
        // Teammate surplus donation measured as a REGRESSION on 25MM
        // (ownN 0 -> 13 on basket-01): our near-cap army is the defense
        // buffer, and unlike engine nations nobody donates back to us.
        // Do not re-add without a reciprocal-flow mechanism.
        if (!this.feat("alliance")) return;
        this.allianceBehavior.handleAllianceRequests();
        this.allianceBehavior.handleAllianceExtensionRequests();
        this.allianceBehavior.maybeCourtProtectors?.();
        this.allianceBehavior.maybeDonateToProtector?.();
      });
    }

    async runOptionalAsyncPhase(enabled, profile, name, action, tickGeneration) {
      if (!enabled) return true;
      await autoBotProfileAsyncPhase(profile, name, action);
      return this.tickIsCurrent(tickGeneration);
    }

    async processPendingNukeSalvo(profile, tickGeneration) {
      if (
        !this.feat("nuke") ||
        this.nukeBehavior.hasPendingNukeLaunches?.() !== true
      ) {
        return true;
      }
      await autoBotProfileAsyncPhase(profile, "nuke-salvo", () =>
        this.nukeBehavior.processPendingNukeLaunches());
      return this.tickIsCurrent(tickGeneration);
    }

    async runDecisionChain(profile, tickGeneration) {
      this.status = tr("Thinking…");
      {
        autoBotProfileSyncPhase(profile, "emoji", () =>
          this.emojiBehavior.maybeSendCasualEmoji());
        this.runDiplomacy(profile);
        // The plateau gold-to-City conversion runs EARLY in the chain: the
        // full structures phase sits behind slower attack/warship work and
        // gets aborted by tick-advance checks in the late-game frozen empire
        // (measured: maybeSpawnPlateauCity calls stopped entirely after
        // tick ~5800 while the freeze ran to 11383). The lane's own gates
        // are O(1), and the double call from handleWinFixStructurePriorities
        // is idempotent (one City at a time).
        if (!(await this.runOptionalAsyncPhase(this.feat("build"), profile, "plateau-city",
          () => this.structureBehavior.maybeSpawnPlateauCity?.(), tickGeneration))) return;
        if (!(await this.runOptionalAsyncPhase(this.feat("nuke"), profile, "mirv",
          () => this.mirvBehavior.considerMIRV(), tickGeneration))) return;
        const warship = this.feat("warship") && state.settings.warshipAutoSpawn !== false;
        // Probe the first affordable hull before ordinary structures.  Both
        // lanes are asynchronous, and the old structures-first order let a
        // City/Factory/Defense-Post build consume the exact 250k window in
        // which the completed Port could have emitted its first Warship.  The
        // warship policy still yields when SAM/land-defense urgency is active,
        // so this only changes the tie-break when the naval lane is actionable.
        if (!(await this.runOptionalAsyncPhase(warship, profile, "warship-build",
          () => this.warshipBehavior.maybeSpawnWarship(), tickGeneration))) return;
        // Structure placement now probes async buildables.  A tick can advance
        // while that probe is in flight; do not let the stale-generation guard
        // suppress the independent construction lane.  The warship phase above
        // re-reads live state and has its own pending-build/rate guards.
        await this.runOptionalAsyncPhase(this.feat("build"), profile, "structures",
          () => this.structureBehavior.handleStructures(profile), tickGeneration);
        if (!(await this.runOptionalAsyncPhase(this.feat("expand") || this.feat("boat"),
          profile, "attack", () => this.attackBehavior.maybeAttack(profile), tickGeneration))) return;
        if (this.feat("embargo")) {
          autoBotProfileSyncPhase(profile, "embargo", () =>
            this.handleEmbargoesToHostileNations());
        }
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

    prepareInitializedTickState(me, profile) {
      if (!this.behaviorsInitialized || !me?.isAlive()) return;
      this.structureBehavior.observeHostileMissileLaunch?.();
      this.enforceSameClanNukeTerrainSafety();
      this.prepareEarlyGameMaritimeState(profile);
    }

    // A materially superior siege runs capped interdiction instead of a full
    // mirror. Freezing every growth lane behind that defense is how a boxed-in
    // bot donates the map while defending one border, so the attack lane keeps
    // expanding during the war. Structures stay owned by the incoming-defense
    // lane to avoid same-tick double construction.
    async runContainmentGrowth(ticks, profile, tickGeneration) {
      if (this.attackBehavior.incomingDefenseContainmentMode?.() !== true) return;
      if (await this.handleOpeningExpansion(ticks, profile, tickGeneration)) return;
      const crossings = this.getTickCrossings(ticks);
      if (!crossings.attack) return;
      await this.runOptionalAsyncPhase(
        this.feat("expand") || this.feat("boat"),
        profile,
        "containment-attack",
        () => this.attackBehavior.maybeAttack(profile),
        tickGeneration,
      );
    }

    async tick(ticks, profile, tickGeneration) {
      if (!this.tickIsCurrent(tickGeneration)) return;
      this.player = this.mg.myPlayer();
      this.refreshBehaviorPlayerReferences();
      const me = this.player;
      if (this.isDuplicateGameTick(ticks)) return;
      this.lastProcessedGameTick = ticks;
      this.prepareInitializedTickState(me, profile);
      if (!(await this.runNavalTickPhases(me, profile, tickGeneration))) return;
      if (me === null || autoBotProfileSyncPhase(profile, "spawn-gate", () =>
        this.handleSpawnTick(ticks, profile))) return;
      if (this.handleEliminatedPlayer(me)) return;
      if (await this.initializeTick(ticks, profile, tickGeneration)) return;
      if (!(await this.processPendingNukeSalvo(profile, tickGeneration))) return;
      if (await this.handleIncomingDefense(ticks, profile, tickGeneration)) {
        // Incoming land defense intentionally bypasses the ordinary decision
        // chain.  Do one live naval build probe before containment so a Port
        // with a paid-for first hull cannot remain defenseless for the entire
        // siege.  The warship behavior retains all SAM/affordability and
        // pending-intent guards; this is only a scheduling bridge.
        if (this.feat("warship") && state.settings.warshipAutoSpawn !== false &&
          this.warshipBehavior.shouldPrioritizeInitialWarshipBuild?.() === true) {
          await autoBotProfileAsyncPhase(profile, "warship-defense-build", () =>
            this.warshipBehavior.maybeSpawnWarship());
          if (!this.tickIsCurrent(tickGeneration)) return;
        }
        await this.runContainmentGrowth(ticks, profile, tickGeneration);
        return;
      }
      if (await this.handleOpeningExpansion(ticks, profile, tickGeneration)) return;
      const crossings = this.getTickCrossings(ticks);
      if (!crossings.attack) {
        await this.handleBetweenAttackTicks(crossings.third, profile, tickGeneration);
        return;
      }
      await this.runDecisionChain(profile, tickGeneration);
    }

    enforceSameClanNukeTerrainSafety() {
      this.attackBehavior.enforceSameClanNukeTerrainSafety?.();
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
      this.warshipBehavior.structureBehavior = this.structureBehavior;
      this.attackBehavior.nukeBehavior = this.nukeBehavior;
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
          ts = computeSpawnTopSpotsForBot(this.mg, this.player, { initial: true });
        }
        if ((!ts || ts.length === 0) && typeof getSpawnHeatmapTopSpots === "function") {
          ts = getSpawnHeatmapTopSpots();
        }
      }
      return ts && ts.length > 0 ? `${ts[0].x},${ts[0].y}` : null;
    }

    spawnTopKeyToValidTile(topKey) {
      if (typeof topKey !== "string") return null;
      const [xText, yText, extra] = topKey.split(",");
      if (extra !== undefined) return null;
      const x = Number(xText);
      const y = Number(yText);
      if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
      const constraints = this.getSpawnConstraints();
      return this.snapToValidSpawn(x, y, constraints);
    }

    doSpawn(topKey = null) {
      // currentSpawnTopKey() has already paid for the dynamic ranking on this
      // tick. Revalidate that candidate instead of computing the same ranking
      // again; a changed/invalid tile deliberately falls through to the full
      // selector below.
      const center = this.spawnTopKeyToValidTile(topKey) ?? this.pickSpawnCenter();
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
        // A saturated client-side intent budget must not make the bot believe
        // its spawn was accepted. Leaving this false preserves the retry path
        // on the next allowed spawn-selection tick.
        if (!emitIntent(ctors.spawn, center)) return;
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
      // select points in this shared region. Keep the final snap/search inside
      // it too: an invalid scored point must not be repaired away from the
      // geometry formed by teammates.
      let teamRegion = null;
      if (!area && typeof getTeamSpawnRegion === "function") {
        teamRegion = getTeamSpawnRegion(game, this.player);
      }
      return {
        game, area, others, minDistance, teamRegion,
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
      const { game, area, teamRegion } = constraints;
      // SpawnExecution relinquishes this player's existing territory before it
      // validates a moved spawn. Self-owned centers are therefore legal during
      // the global spawn phase; only another player's ownership blocks them.
      if (
        tile == null ||
        !game.isLand(tile) ||
        this.spawnTileOccupiedByOtherPlayer(tile, game) ||
        game.isBorder(tile)
      ) {
        return false;
      }
      if (game.magnitude && game.magnitude(tile) === 31) return false;
      if (teamRegion && typeof isPointInsideTeamSpawnRegion === "function") {
        if (!isPointInsideTeamSpawnRegion(game.x(tile), game.y(tile), teamRegion)) return false;
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

    spawnTileOccupiedByOtherPlayer(tile, game) {
      if (!game.hasOwner(tile)) return false;
      if (typeof game.ownerID !== "function") return true;
      return game.ownerID(tile) !== this.player.smallID?.();
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

    getTeamSpawnCentroidTile(constraints) {
      if (typeof collectExactSpawnPoints !== "function") return null;
      const rawTeamSpawns = collectExactSpawnPoints(this.mg, this.player)?.teamSpawns;
      const teamSpawns = typeof filterTeamSpawnGeometryOutliers === "function"
        ? filterTeamSpawnGeometryOutliers(rawTeamSpawns)
        : rawTeamSpawns;
      if (!Array.isArray(teamSpawns) || teamSpawns.length === 0) return null;
      let sumX = 0;
      let sumY = 0;
      for (const point of teamSpawns) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
        sumX += point.x;
        sumY += point.y;
      }
      return this.snapToValidSpawn(
        Math.round(sumX / teamSpawns.length),
        Math.round(sumY / teamSpawns.length),
        constraints,
      );
    }

    getRandomSpawnCoordinate(limit, start = 0) {
      return this.random.nextInt(start, start + limit);
    }

    getTeamSpawnFallbackBounds(constraints) {
      const { area, teamRegion, width, height } = constraints;
      if (!teamRegion) return null;
      const points = teamRegion.polygon ?? [
        teamRegion.corridor?.start,
        teamRegion.corridor?.end,
      ].filter(Boolean);
      if (points.length === 0) return null;
      const padding = Number(teamRegion.corridor?.halfWidth) || 0;
      let minX = Math.floor(Math.min(...points.map((point) => point.x)) - padding);
      let maxX = Math.ceil(Math.max(...points.map((point) => point.x)) + padding);
      let minY = Math.floor(Math.min(...points.map((point) => point.y)) - padding);
      let maxY = Math.ceil(Math.max(...points.map((point) => point.y)) + padding);
      minX = Math.max(0, minX);
      maxX = Math.min(width - 1, maxX);
      minY = Math.max(0, minY);
      maxY = Math.min(height - 1, maxY);
      if (area) {
        minX = Math.max(minX, area.x);
        maxX = Math.min(maxX, area.x + area.width - 1);
        minY = Math.max(minY, area.y);
        maxY = Math.min(maxY, area.y + area.height - 1);
      }
      return minX <= maxX && minY <= maxY ? { minX, maxX, minY, maxY } : null;
    }

    pickTeamRegionFallbackTile(constraints, useSmart) {
      const { game, area, others, width, height } = constraints;
      const bounds = this.getTeamSpawnFallbackBounds(constraints);
      if (!bounds) return null;
      const spanWidth = bounds.maxX - bounds.minX + 1;
      const spanHeight = bounds.maxY - bounds.minY + 1;
      const step = Math.max(1, Math.ceil(Math.sqrt((spanWidth * spanHeight) / 1000)));
      const columns = Math.floor((bounds.maxX - bounds.minX) / step) + 1;
      const rows = Math.floor((bounds.maxY - bounds.minY) / step) + 1;
      const latticeCount = columns * rows;
      const candidateCount = Math.min(1000, latticeCount);
      let bestTile = null;
      let bestScore = -Infinity;
      for (let probe = 0; probe < candidateCount; probe += 1) {
        const latticeIndex = candidateCount === 1
          ? 0
          : Math.floor((probe * (latticeCount - 1)) / (candidateCount - 1));
        const x = bounds.minX + (latticeIndex % columns) * step;
        const y = bounds.minY + Math.floor(latticeIndex / columns) * step;
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

    pickSampledSpawnTile(constraints, useSmart) {
      const { game, area, others, teamRegion, width, height } = constraints;
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
      if (bestTile != null || !teamRegion) return bestTile;
      return this.pickTeamRegionFallbackTile(constraints, useSmart);
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
        const teamCentroidTile = this.getTeamSpawnCentroidTile(constraints);
        if (teamCentroidTile != null) return teamCentroidTile;
        const rankedTile = this.getRankedSpawnTile(constraints);
        if (rankedTile != null) return rankedTile;
      }
      return this.pickSampledSpawnTile(constraints, useSmart);
    }

    // DIVERGENCE: spawn scoring (Tactical spawn-scoring port). Scores a candidate
    // tile by: land density in a 12-radius neighbourhood, distance from the
    // nearest enemy nameLocation (farther = better), edge avoidance (centre of
    // map preferred), coastal/ocean access (unlocks Ports/trade/warships), and
    // surrounding terrain defensibility (high-magnitude rings are harder to
    // attack across). Team mode adds a pull toward the team spawn area centre.
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

    // Coastal access signal for spawn scoring. A start on or near the coast
    // can build a Port, unlock trade gold, and project warships — a landlocked
    // inland start has none of those. The signal is the fraction of the
    // 12-radius neighbourhood that is water (ocean), so a tile on an open
    // seaboard scores higher than one at the centre of a large continent.
    getSpawnCoastalAccess(tx, ty) {
      const g = this.mg;
      const R = 12;
      let water = 0;
      let total = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (!g.isValidCoord(nx, ny)) continue;
          total++;
          const ref = g.ref(nx, ny);
          if (
            !g.isLand(ref) &&
            (typeof g.isOcean !== "function" || g.isOcean(ref))
          ) {
            water++;
          }
        }
      }
      // A small water fraction rewards a coast; a huge fraction penalizes a
      // tiny island with little land to expand into. Peak around 25-40% water.
      const ratio = total > 0 ? water / total : 0;
      if (ratio <= 0) return 0;
      if (ratio <= 0.35) return ratio / 0.35;
      return Math.max(0, 1 - (ratio - 0.35) / 0.4);
    }

    // Defensibility signal for spawn scoring. A start whose surrounding ring is
    // higher-magnitude terrain (mountains/rough) is naturally harder to attack
    // across and easier to hold. The signal is the average magnitude of the
    // land tiles in the 10-14 radius band, normalized against the map's typical
    // plains baseline. Pure-plains surroundings score ~0; mountainous rings
    // score toward 1.
    getSpawnDefensibility(tx, ty) {
      const g = this.mg;
      if (typeof g.magnitude !== "function") return 0;
      const innerR = 10;
      const outerR = 14;
      let total = 0;
      let count = 0;
      for (let dy = -outerR; dy <= outerR; dy++) {
        for (let dx = -outerR; dx <= outerR; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < innerR || dist > outerR) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (!g.isValidCoord(nx, ny)) continue;
          const tile = g.ref(nx, ny);
          if (!g.isLand(tile)) continue;
          total += Number(g.magnitude(tile) ?? 0);
          count++;
        }
      }
      if (count === 0) return 0;
      const avg = total / count;
      // Magnitude ~10 is plains; ~30+ is mountainous. Normalize so plains
      // contributes ~0 and mountains contribute toward 1.
      return Math.max(0, Math.min(1, (avg - 10) / 20));
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

      // Coastal access: a spawn with ocean nearby unlocks Ports, trade, and
      // warships. Weighted below land density and safety but above the team
      // pull so it breaks ties between otherwise-equivalent inland/coastal
      // starts in favour of the coast.
      // Strongly prefer a reachable maritime start when one exists; otherwise
      // the land-density score can strand the Port/trade lane inland.
      score += this.getSpawnCoastalAccess(tx, ty) * 30;

      // Defensibility: higher-magnitude surrounding terrain makes a start
      // harder to overrun. A modest tie-breaker that never overrides the core
      // land/safety/edge signals.
      score += this.getSpawnDefensibility(tx, ty) * 10;

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
    // Protector appeasement: embargoing the courted protector applies a
    // permanent −20 relation in that nation toward us, locking the alliance
    // gate (relation < Neutral → guaranteed rejection) — never embargo it,
    // and repair any prior embargo.
    protectorEmbargoExemption(other, embargoed) {
      const protectorSid = this.allianceBehavior?.appeasementProtector?.()?.smallID?.();
      if (protectorSid === undefined || other.smallID() !== protectorSid) {
        return false;
      }
      if (embargoed) this.stopEmbargo(other);
      return true;
    }

    handleEmbargoForPlayer(other, player, difficulty, forceTeamEmbargo) {
      const sameTeam = player.isOnSameTeam(other);
      const embargoed = player.hasEmbargoAgainst(other);
      if (this.protectorEmbargoExemption(other, embargoed)) return embargoed;
      if (forceTeamEmbargo && other.type() !== PlayerType.Bot && !sameTeam) {
        return !embargoed && this.addEmbargo(other, false);
      }
      const relation = player.relation(other);
      if (relation <= Relation.Hostile && !embargoed && !sameTeam) {
        return this.addEmbargo(other, false);
      } else if (relation >= Relation.Neutral && embargoed &&
        !isAtLeastHardDifficulty(difficulty)) {
        return this.stopEmbargo(other);
      } else if (relation >= Relation.Friendly && embargoed &&
        ![Difficulty.Impossible, Difficulty.Legendary].includes(difficulty)) {
        return this.stopEmbargo(other);
      }
      return false;
    }

    handleEmbargoesToHostileNations() {
      const player = this.player;
      if (player === null) return;
      const others = this.mg.players().filter((p) => p.id() !== player.id());
      const difficulty = currentDifficulty();
      const forceTeamEmbargo = isAtLeastHardDifficulty(difficulty) &&
        this.mg.config().gameConfig().gameMode === GameMode.Team;
      let emitted = 0;
      for (const other of others) {
        if (emitted >= EMBARGO_INTENTS_PER_DECISION) break;
        const budget = typeof getIntentRateLimitSnapshot === "function"
          ? getIntentRateLimitSnapshot()
          : null;
        // Keep one token available for defense, construction, or another
        // strategic producer later in the same decision chain.
        if (budget && (budget.secondTokens <= 1 || budget.minuteTokens <= 1)) break;
        if (this.handleEmbargoForPlayer(other, player, difficulty, forceTeamEmbargo)) {
          emitted += 1;
        }
      }
    }

    addEmbargo(other, _temporary) {
      const ctors = discoverCtors(getEventBus());
      return Boolean(
        ctors.embargo && emitIntent(ctors.embargo, other.__src ?? other, "start"),
      );
    }
    stopEmbargo(other) {
      const ctors = discoverCtors(getEventBus());
      return Boolean(
        ctors.embargo && emitIntent(ctors.embargo, other.__src ?? other, "stop"),
      );
    }
  }
