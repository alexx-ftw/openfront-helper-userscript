
  // UniversalPathFinding.Parabola factory — src/core/pathfinding/PathFinder.ts.
  // src calls `UniversalPathFinding.Parabola(this.game, opts)`; mirror it.
  const UniversalPathFinding = {
    Parabola(gameMap, options) {
      return new NukeParabolaUniversalPathFinder(gameMap, options);
    },
  };

  // ===========================================================================
  // NukeBehavior — 1:1 port of NationNukeBehavior
  // ===========================================================================
  class NukeBehavior {
    constructor(random, game, player, attackBehavior, emojiBehavior) {
      this.random = random;
      this.game = game;
      this.player = player;
      this.attackBehavior = attackBehavior;
      this.emojiBehavior = emojiBehavior;
      // Wired by NationBot after both behaviors are constructed. Keeping the
      // policy owner here avoids duplicating economy/structure cost logic in
      // the nuclear planner.
      this.structureBehavior = null;

      // recentlySentNukes: [Tick, TileRef, nukeType][] — NationNukeBehavior.ts:38
      this.recentlySentNukes = [];
      this._hostileNukeThreats = new Map();
      this._activeTradeDestinationTick = null;
      this._activeTradeDestinationIds = new Set();
      this.atomBombsLaunched = 0;
      // DIVERGENCE C1: src seeds the perceived cost from cost(type) synchronously
      // in field initializers. The client cost is async (buildables probe), so we
      // CANNOT seed these from a live price at construction time. We lazily seed
      // them on first use (see getPerceivedNukeCost) from the live atom/hydro cost,
      // then escalate them by 50%/25% per launch exactly as src does. Until seeded
      // they are null (sentinel "not yet observed").
      this.atomBombPerceivedCost = null;
      this.hydrogenBombPerceivedCost = null;
      this.hydrogenBombsLaunched = 0;
      // Make 1/3 of nations "hydro-nations" that only throw hydrogen bombs (to
      // reduce atom bomb spam) — NationNukeBehavior.ts:48. For our single bot we
      // keep the per-instance random designation faithfully.
      this.isHydroNation = this.random.chance(3);

      // Per-tick cost memo (see cost()): keyed by unit type, invalidated per tick.
      this._costCacheTick = -1;
      this._costCache = new Map();
      // Monotonic id for each SAM-overwhelm salvo (see fireSamSalvo): delayed
      // entries carry their salvo's id so processPendingNukeLaunches can
      // re-validate and abort the WHOLE remaining salvo mid-flight.
      this._nextSalvoId = 0;
      this._samDemandRequest = null;
      // Per-decision snapshot of own + permanent-teammate structures for the
      // friendly-fire blast penalty (see nukeTileScore). nukeTileScore runs once
      // per candidate tile; the snapshot is rebuilt once per game tick.
      this._friendlyNukeStructureTick = -1;
      this._friendlyNukeStructures = [];
      this._strategicBorderArmyTargetTick = -1;
      this._strategicBorderArmyTarget = null;
      // The client intent has no NukeExecution.waitTicks field. Preserve the
      // engine salvo timing by emitting delayed build intents on their exact
      // future game ticks instead of collapsing every bomb onto this tick.
      this._pendingNukeLaunches = [];
      // Salvo id whose per-launch revalidation failed (see
      // samSalvoLaunchStillViable); consumed by processPendingNukeLaunches.
      this._salvoLaunchAbort = null;
    }

    canConsiderNukes(silos) {
      const config = this.game.config();
      if (silos.length === 0 || config.isUnitDisabled(UNIT.MissileSilo)) return false;
      return !config.isUnitDisabled(UNIT.AtomBomb) ||
        !config.isUnitDisabled(UNIT.HydrogenBomb);
    }

    isValidNukeTarget(target, checkAttackPolicy = true) {
      if (target === null || target.isAlive?.() === false) return false;
      if (target.smallID?.() === this.player.smallID?.()) return false;
      if (playersArePermanentTeammates(this.player, target)) return false;
      return !checkAttackPolicy || this.attackBehavior.shouldAttack(target) !== false;
    }

    isEligibleNukeTarget(target, checkAttackPolicy = true) {
      // Bot-owned destinations and SAMs remain valid; only the selected recipient is vetoed.
      return target?.type?.() !== PlayerType.Bot &&
        this.isValidNukeTarget(target, checkAttackPolicy);
    }

    isValidNukeDestination(tile, checkAttackPolicy = true, stableTarget = null) {
      const owner = this.game.owner?.(tile);
      const sameTarget = owner?.smallID?.() === stableTarget?.smallID?.();
      return owner?.isPlayer?.() !== true ||
        this.isValidNukeTarget(owner, checkAttackPolicy || (stableTarget !== null && !sameTarget));
    }

    async selectAffordableNuke() {
      const hydroCost = await this.getPerceivedNukeCost(UNIT.HydrogenBomb);
      const atomCost = await this.getPerceivedNukeCost(UNIT.AtomBomb);
      const config = this.game.config();
      if (!config.isUnitDisabled(UNIT.HydrogenBomb) && this.player.gold() >= hydroCost) {
        return { type: UNIT.HydrogenBomb, cost: hydroCost };
      }
      const legendaryAtomFallback = state.settings.winFixes === true &&
        isLegendaryDifficulty(currentDifficulty());
      const atomAllowed = !config.isUnitDisabled(UNIT.AtomBomb) &&
        (!this.isHydroNation || this.isUnderHeavyAttack() || legendaryAtomFallback);
      if (atomAllowed && this.player.gold() >= atomCost) {
        return { type: UNIT.AtomBomb, cost: atomCost };
      }
      return null;
    }

    // Returns the sampled enemy-land blast coverage, or -1 when the tile is
    // not scorable (upstream 34a8fe723 turned the boolean gate into a gate +
    // coverage measurement).
    isScorableNukeTile(tile, context) {
      if (tile === null) return -1;
      const { range, target, type, difficulty } = context;
      const bounds = boundingBoxTiles(this.game, tile, range)
        .concat(boundingBoxTiles(this.game, tile, Math.floor(range / 2)));
      if (!bounds.every((candidate) => this.isValidNukeTile(candidate, target))) return -1;
      const spawnTile = this.nukeSpawn(type, tile);
      if (spawnTile === false) return -1;
      let coverage = 0;
      if (difficulty !== Difficulty.Easy) {
        if (this.isNukeAlreadyLandingNear(tile, type)) return -1;
        coverage = this.enemyLandBlastCoverage(tile, type);
        if (coverage < this.nukeCoverageFloor(context, type)) return -1;
      }
      // Legendary saturation divergence: refusing every SAM-covered
      // trajectory stalls the bombardment once a rival fields launchers —
      // the requirement is destroyed value THROUGH defenses, so an
      // interceptable path stays scorable and the war chest funds the
      // follow-up. The trajectory check still orders candidates below
      // clear ones via the wave cost in maybeDestroyEnemySam territory.
      // Overlap/coverage gates now precede this return (upstream has no
      // Legendary; the !Easy branch applies).
      if (isLegendaryDifficulty(difficulty)) {
        return this.legendarySaturationCoverage(spawnTile, tile, context, coverage);
      }
      return !isAtLeastHardDifficulty(difficulty) ||
        !this.isTrajectoryInterceptableBySam(spawnTile, tile)
        ? coverage
        : -1;
    }

    // Survival divergence: against the pinned invader that is actively
    // consuming our territory, fallout-cratered enemy land keeps the standard
    // floor unsatisfiable and freezes every response shot
    // (scenario-sam-salvo-b: zero launches in the final 3 439 ticks).
    nukeCoverageFloor(context, type) {
      return context.survival === true && type === UNIT.AtomBomb
        ? 0.15
        : MIN_BLAST_COVERAGE[type];
    }

    // Survival-scoped saturation (pre-declared lever): the 2026-10-09 closure
    // kept the tier comparison dead because an unconditional release
    // deterministically lost the baikal no-harm gate. The pinned heavy
    // invasion is the scoped reopening — only that target's tiles may stay
    // scorable through a covered trajectory, and the partition still orders
    // them below clear shots. Raw Legendary never fires in production
    // (currentDifficulty() maps the tier to Impossible); the union gate keeps
    // both spellings equivalent.
    legendarySaturationCoverage(spawnTile, tile, context, coverage) {
      if (context.survival === true) return coverage;
      return this.isTrajectoryInterceptableBySam(spawnTile, tile) ? -1 : coverage;
    }

    async collectNukeCandidates(target, type, silos, difficulty) {
      await withTimeout(
        this.game.ensureBorderTiles(target), WORKER_TIMEOUT_MS, null,
      );
      // Keep retries from retaining every rival's full trajectory set in one tick.
      this._nukeTrajectoryCacheTick = this.game.ticks();
      this._nukeTrajectoryCache = new Map();
      const structures = unitsOfTypes(target);
      const survival = this.isInvasionSurvivalTarget(target);
      const randomCount = isAtLeastHardDifficulty(difficulty) ? 30 : 10;
      const randomTiles = randTerritoryTileArray(this.random, this.game, target, randomCount);
      const tiles = randomTiles.concat(structures.map((unit) => unit.tile()));
      const range = this.game.config().nukeMagnitudes(type).outer;
      const context = { range, target, type, difficulty, survival };
      this.removeOldNukeEvents();
