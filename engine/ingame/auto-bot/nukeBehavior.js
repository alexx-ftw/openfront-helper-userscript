// Auto-Bot — NukeBehavior: a faithful 1:1 port of the in-game Nation nuclear AI
// (src/core/execution/nation/NationNukeBehavior.ts). The most sophisticated
// behavior: target selection (retaliation, FFA crown, high-density, team), per-
// tile nuke scoring (level-weighted structures, SAM penalties, silo-distance
// penalty, recent-nuke memory), parabolic-trajectory SAM-interception checks, and
// the SAM-overwhelm saturation salvo planner. Every branch, constant, probability,
// threshold and call order is preserved exactly. The ONLY changes are the
// mechanical API substitutions mandated by PORT-CONTRACT.md:
//   - difficulty read (this.mg.config().gameConfig().difficulty) → currentDifficulty()
//   - UnitType.X → UNIT.X
//   - player/owner identity `===` → `.smallID()` compares; TerraNullius via !x.isPlayer()
//   - gold is BigInt — costs keep bigint math
//   - addExecution(new NukeExecution(...)) → buildables probe + getBuildMenu()
//     .sendBuildOrUpgrade(bu, targetTile) (see DIVERGENCE G1 for the dropped stagger)
//   - addExecution(new UpgradeStructureExecution(...)) → buildables probe +
//     getBuildMenu().sendBuildOrUpgrade(bu) for the silo upgrade
//   - cost()/getPerceivedNukeCost(): src reads unitInfo(type).cost(game, player),
//     but the nuke cost fn calls game.stats() which the client GameView does NOT
//     expose — we read the live price from a buildables probe (same value, client
//     source — DIVERGENCE C1, mirrors mirvBehavior.cost()).
//   - canUpgradeUnit(silo): not on the gameApi player wrapper — replaced by the
//     buildables probe `bu.canUpgrade !== false` (DIVERGENCE U1).
//
// The parabola path finder (ParabolaUniversalPathFinder) and the Bezier curve
// helpers (CubicBezierCurve / DistanceBasedBezierCurve) are ported VERBATIM as
// module-local helpers so isTrajectoryInterceptableBySam + maybeDestroyEnemySam
// are faithful at Hard/Impossible (the default replicated difficulty). The path
// finder uses the GameMap x/y/ref/height surface — all exposed on `game`.
//
// ASYNC: maybeSendNuke() becomes async (nationExecution awaits it); the only
// worker calls are the buildables probes for the FINAL chosen nuke tile and the
// salvo (candidate tile generation is all sync — random territory tiles + unit
// tiles). Each worker call is wrapped in withTimeout(p, WORKER_TIMEOUT_MS, fallback).
//
// Constructed by nationExecution with (random, game, player, attackBehavior,
// emojiBehavior). The attackBehavior instance exposes shouldAttack(target) and
// findIncomingAttackPlayer() (AttackBehavior port) — called exactly as src.
//
// Loaded with the other behavior modules (after portutil/gameApi and the emoji
// phase which provides EMOJI_NUKE), before nationExecution.
// Classic-script shared-global scope (no IIFE): top-level names (the NUKE_*
// consts, the curve/path-finder helper classes, the NukeBehavior class) are
// visible to the sibling modules and must stay unique across the bundle.

"use strict";

  // ===========================================================================
  // Constants — NationNukeBehavior.ts:25-35
  // ===========================================================================

  /** Cap on silo levels reachable via maybeDestroyEnemySam's upgrade fallback. */
  const MAX_NATION_SILO_UPGRADE_LEVEL = 5;

  /**
   * Level-weighted structure density (sum of structure levels per tile owned)
   * above which the richest impossible nation will pre-emptively nuke a player.
   */
  const HIGH_DENSITY_NUKE_THRESHOLD = 1 / 75;

  /** Minimum sum of structure levels a player needs to qualify as a high-density nuke target. */
  const MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE = 5;

  /**
   * Friendly structure replacement penalty: the engine destroys structures
   * strictly inside the OUTER blast circle, regardless of the fallout radius.
   * Per-structure base values live in
   * friendlyFireStructureValue (MissileSilo heaviest).
   */
  const FRIENDLY_FIRE_PENALTY = 3;
  // Counterforce (see mirvCapableSiloPriority): a silo whose owner can afford
  // a MIRV scores as several ordinary silos. The threshold is the engine's
  // base MIRV price (the live quote escalates globally per launch and needs
  // an async probe this sync scorer cannot await).
  const MIRV_CAPABLE_GOLD_THRESHOLD = 25_000_000n;
  const MIRV_CAPABLE_SILO_PRIORITY_MULTIPLIER = 3;
  // Per-tick cap on delayed nuke launches (see processPendingNukeLaunches):
  // spreads same-tick salvo sends across ticks so the shared intent window
  // cannot clip a salvo's tail and stretch its arrival window.
  const PENDING_NUKE_LAUNCHES_PER_TICK = 3;

  // Structures group — src/core/game/Game.ts:374 (Structures.types). Defined
  // module-local under a unique name (no `Structures` global exists in the bundle)
  // so `nukeTarget` structure sweeps mirror `units(...Structures.types)`.
  const NUKE_STRUCTURES_TYPES = [
    UNIT.City,
    UNIT.DefensePost,
    UNIT.SAMLauncher,
    UNIT.MissileSilo,
    UNIT.Port,
    UNIT.Factory,
  ];

  // Per-type enumeration instead of `units(...NUKE_STRUCTURES_TYPES)`: the
  // vendored fixture engine caps `units()` at three positional types and
  // silently drops the rest, so a 6-arg spread only ever saw the first three.
  function unitsOfTypes(player) {
    if (typeof player?.units !== "function") return [];
    const out = [];
    for (const type of NUKE_STRUCTURES_TYPES) out.push(...player.units(type));
    return out;
  }

  // ===========================================================================
  // euclDistFN — src/core/game/GameMap.ts:454. Returns a predicate (gm, tile) =>
  // distance(root, tile) within `dist`. Only the `center=false` branch is used by
  // nukeTileScore; the center branch is ported for completeness.
  // ===========================================================================
  function euclDistFN(root, dist, center) {
    const dist2 = dist * dist;
    if (!center) {
      return (gm, n) => gm.euclideanDistSquared(root, n) <= dist2;
    } else {
      return (gm, n) => {
        // shifts the root tile's coordinates by -0.5 so that its "center"
        // becomes the corner of four pixels rather than the middle of one pixel.
        const dx = gm.x(root) - 0.5 - gm.x(n);
        const dy = gm.y(root) - 0.5 - gm.y(n);
        return dx * dx + dy * dy <= dist2;
      };
    }
  }

  // ===========================================================================
  // Bezier curve helpers — src/core/utilities/Line.ts (ported VERBATIM, only TS
  // types dropped). CubicBezierCurve + DistanceBasedBezierCurve back the parabola
  // path finder. (BezenhamLine is not needed by the nuke behavior and is omitted.)
  // ===========================================================================
  class NukeCubicBezierCurve {
    constructor(p0, p1, p2, p3) {
      this.p0 = p0;
      this.p1 = p1;
      this.p2 = p2;
      this.p3 = p3;
    }
    getPointAt(t) {
      const T = 1 - t;
      const TT = T * T;
      const TTT = TT * T;
      const tt = t * t;
      const ttt = tt * t;

      const x =
        TTT * this.p0.x +
        3 * TT * t * this.p1.x +
        3 * T * tt * this.p2.x +
        ttt * this.p3.x;

      const y =
        TTT * this.p0.y +
        3 * TT * t * this.p1.y +
        3 * T * tt * this.p2.y +
        ttt * this.p3.y;
      return { x, y };
    }
  }

  /**
   *  Use a cumulative distance LUT to approximate the traveled distance
   *  Useful to compute regular steps based on the curve rather than a t
   */
  class NukeDistanceBasedBezierCurve extends NukeCubicBezierCurve {
    constructor(p0, p1, p2, p3, distanceIncrement) {
      super(p0, p1, p2, p3);
      this.totalDistance = 0;
      this.cachedPoints = [];
      this.currentIndex = 0;
      this.computeAllPoints(distanceIncrement, 0.002);
    }

    getAllPoints() {
      return this.cachedPoints;
    }
    /**
     * Move forward along the curve by the given distance.
     * Returns the next cached point, or null if at the end.
     */
    increment(distance) {
      this.totalDistance += distance;

      // Step forward through cached points until we're at the correct distance
      while (
        this.currentIndex < this.cachedPoints.length - 1 &&
        this.getDistanceUpToIndex(this.currentIndex + 1) < this.totalDistance
      ) {
        this.currentIndex++;
      }

      if (this.currentIndex >= this.cachedPoints.length - 1) {
        return null; // End of curve
      }

      return this.cachedPoints[this.currentIndex];
    }

    getCurrentIndex() {
      return this.currentIndex;
    }

    /**
     * Precompute all points spaced @p pixelSpacing apart
     */
    computeAllPoints(pixelSpacing, precision) {
      this.cachedPoints = [];
      this.totalDistance = 0;
      this.currentIndex = 0;

      let t = 0;
      let prevPoint = this.getPointAt(t);
      this.cachedPoints.push(prevPoint);

      let cumulativeDistance = 0;

      while (t < 1) {
        t = Math.min(t + precision, 1);
        const currentPoint = this.getPointAt(t);

        const dx = currentPoint.x - prevPoint.x;
        const dy = currentPoint.y - prevPoint.y;
        const segmentLength = Math.sqrt(dx * dx + dy * dy);
        cumulativeDistance += segmentLength;

        if (cumulativeDistance >= pixelSpacing) {
          this.cachedPoints.push(currentPoint);
          cumulativeDistance = 0;
        }

        prevPoint = currentPoint;
      }

      // Make sure the last point is exactly at t=1
      const finalPoint = this.getPointAt(1);
      if (
        this.cachedPoints.length === 0 ||
        finalPoint.x !== this.cachedPoints[this.cachedPoints.length - 1].x ||
        finalPoint.y !== this.cachedPoints[this.cachedPoints.length - 1].y
      ) {
        this.cachedPoints.push(finalPoint);
      }
    }

    /**
     * Optional helper: get distance along the cached points up to a given index
     */
    getDistanceUpToIndex(index) {
      let dist = 0;
      for (let i = 1; i <= index; i++) {
        const p1 = this.cachedPoints[i - 1];
        const p2 = this.cachedPoints[i];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        dist += Math.sqrt(dx * dx + dy * dy);
      }
      return dist;
    }
  }

  // ===========================================================================
  // ParabolaUniversalPathFinder — src/core/pathfinding/PathFinder.Parabola.ts
  // (ported VERBATIM, only TS types + SteppingPathFinder interface dropped). Only
  // findPath() is used by the nuke behavior, but next()/invalidate()/currentIndex()
  // are ported too for faithfulness. Constructed via the UniversalPathFinding
  // .Parabola(game, opts) factory below (mirroring src's UniversalPathFinding).
  // ===========================================================================
  const PARABOLA_MIN_HEIGHT = 50;

  class NukeParabolaUniversalPathFinder {
    constructor(gameMap, options) {
      this.gameMap = gameMap;
      this.options = options;
      this.curve = null;
      this.lastTo = null;
    }

    createCurve(from, to) {
      const increment = this.options?.increment ?? 3;
      const distanceBasedHeight = this.options?.distanceBasedHeight ?? true;
      const directionUp = this.options?.directionUp ?? true;

      const p0 = { x: this.gameMap.x(from), y: this.gameMap.y(from) };
      const p3 = { x: this.gameMap.x(to), y: this.gameMap.y(to) };
      const dx = p3.x - p0.x;
      const dy = p3.y - p0.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const maxHeight = distanceBasedHeight
        ? Math.max(distance / 3, PARABOLA_MIN_HEIGHT)
        : 0;
      const heightMult = directionUp ? -1 : 1;
      const mapHeight = this.gameMap.height();

      const p1 = {
        x: p0.x + dx / 4,
        y: within(p0.y + dy / 4 + heightMult * maxHeight, 0, mapHeight - 1),
      };
      const p2 = {
        x: p0.x + (dx * 3) / 4,
        y: within(p0.y + (dy * 3) / 4 + heightMult * maxHeight, 0, mapHeight - 1),
      };

      return new NukeDistanceBasedBezierCurve(p0, p1, p2, p3, increment);
    }

    findPath(from, to) {
      if (Array.isArray(from)) {
        throw new Error(
          "ParabolaUniversalPathFinder does not support multiple start points",
        );
      }
      const curve = this.createCurve(from, to);
      return curve
        .getAllPoints()
        .map((p) => this.gameMap.ref(Math.floor(p.x), Math.floor(p.y)));
    }

    next(from, to, speed) {
      if (this.lastTo !== to) {
        this.curve = this.createCurve(from, to);
        this.lastTo = to;
      }

      const nextPoint = this.curve.increment(speed ?? 1);
      if (!nextPoint) {
        // src returns { status: PathStatus.COMPLETE, node: to }
        return { status: "Complete", node: to };
      }
      const tile = this.gameMap.ref(
        Math.floor(nextPoint.x),
        Math.floor(nextPoint.y),
      );
      // src returns { status: PathStatus.NEXT, node: tile }
      return { status: "Next", node: tile };
    }

    invalidate() {
      this.curve = null;
      this.lastTo = null;
    }

    currentIndex() {
      return this.curve?.getCurrentIndex() ?? 0;
    }
  }

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
    }

    canConsiderNukes(silos) {
      const config = this.game.config();
      if (silos.length === 0 || config.isUnitDisabled(UNIT.MissileSilo)) return false;
      return !config.isUnitDisabled(UNIT.AtomBomb) ||
        !config.isUnitDisabled(UNIT.HydrogenBomb);
    }

    isValidNukeTarget(target) {
      if (target === null || target.isAlive?.() === false) return false;
      if (target.smallID?.() === this.player.smallID?.()) return false;
      if (playersArePermanentTeammates(this.player, target)) return false;
      return this.attackBehavior.shouldAttack(target) !== false;
    }

    isValidNukeDestination(tile) {
      const owner = this.game.owner?.(tile);
      return owner?.isPlayer?.() !== true || this.isValidNukeTarget(owner);
    }

    async selectAffordableNuke() {
      const hydroCost = await this.getPerceivedNukeCost(UNIT.HydrogenBomb);
      const atomCost = await this.getPerceivedNukeCost(UNIT.AtomBomb);
      const config = this.game.config();
      if (!config.isUnitDisabled(UNIT.HydrogenBomb) && this.player.gold() >= hydroCost) {
        return { type: UNIT.HydrogenBomb, cost: hydroCost };
      }
      const legendaryAtomFallback = state.settings.winFixes === true &&
        currentDifficulty() === Difficulty.Legendary;
      const atomAllowed = !config.isUnitDisabled(UNIT.AtomBomb) &&
        (!this.isHydroNation || this.isUnderHeavyAttack() || legendaryAtomFallback);
      if (atomAllowed && this.player.gold() >= atomCost) {
        return { type: UNIT.AtomBomb, cost: atomCost };
      }
      return null;
    }

    isScorableNukeTile(tile, context) {
      if (tile === null) return false;
      const { range, target, type, difficulty } = context;
      const bounds = boundingBoxTiles(this.game, tile, range)
        .concat(boundingBoxTiles(this.game, tile, Math.floor(range / 2)));
      if (!bounds.every((candidate) => this.isValidNukeTile(candidate, target))) return false;
      const spawnTile = this.nukeSpawn(type, tile);
      if (spawnTile === false) return false;
      const duplicateTeamNuke = this.game.config().gameConfig().gameMode === GameMode.Team &&
        difficulty !== Difficulty.Easy && this.isTeammateAlreadyNukingThisSpot(tile, type);
      if (duplicateTeamNuke) return false;
      // Legendary saturation divergence: refusing every SAM-covered
      // trajectory stalls the bombardment once a rival fields launchers —
      // the requirement is destroyed value THROUGH defenses, so an
      // interceptable path stays scorable and the war chest funds the
      // follow-up. The trajectory check still orders candidates below
      // clear ones via the wave cost in maybeDestroyEnemySam territory.
      if (difficulty === Difficulty.Legendary) return true;
      return !isAtLeastHardDifficulty(difficulty) ||
        !this.isTrajectoryInterceptableBySam(spawnTile, tile);
    }

    async collectNukeCandidates(target, type, silos, difficulty) {
      await withTimeout(
        this.game.ensureBorderTiles(target), WORKER_TIMEOUT_MS, null,
      );
      const structures = unitsOfTypes(target);
      const randomCount = isAtLeastHardDifficulty(difficulty) ? 30 : 10;
      const randomTiles = randTerritoryTileArray(this.random, this.game, target, randomCount);
      const tiles = randomTiles.concat(structures.map((unit) => unit.tile()));
      const range = this.game.config().nukeMagnitudes(type).outer;
      const context = { range, target, type, difficulty };
      this.removeOldNukeEvents();
      return [...new Set(tiles)]
        .filter((tile) => this.isScorableNukeTile(tile, context))
        .map((tile) => ({ tile, value: this.nukeTileScore(tile, silos, structures, type) }))
        .sort((a, b) => b.value - a.value);
    }

    async selectBuildableNukeCandidate(candidates, type) {
      for (const cand of candidates) {
        if (cand.value <= -1) break;
        if (await this.probeCanBuildNuke(cand.tile, type)) return cand;
      }
      return null;
    }

    // ── maybeSendNuke — NationNukeBehavior.ts:58 (now async) ──────────────────
    async maybeSendNuke() {
      if (this.hasPendingNukeLaunches()) return;
      const silos = this.player.units(UNIT.MissileSilo);
      if (!this.canConsiderNukes(silos)) return;
      const target = this.findBestNukeTarget();
      if (!this.isValidNukeTarget(target)) return;
      const selectedNuke = await this.selectAffordableNuke();
      if (!selectedNuke) return;
      if (this.shouldDeferNukeForEconomy(target, selectedNuke.cost)) return;
      const difficulty = currentDifficulty();
      const candidates = await this.collectCandidatesWithRetry(
        target, selectedNuke, silos, difficulty,
      );
      await this.fireNukeFromCandidates(
        candidates.list, candidates.retargeted ?? target, selectedNuke, silos, difficulty,
      );
      // FFA endgame survival lane — additive-only: reached only when every
      // ordinary lane declined to fire. See maybeFreezeGiantStrike.
      await this.maybeFreezeGiantStrike(silos, difficulty);
    }

    // Clear shots first, then the anti-SAM salvo planner — the firing tail
    // of maybeSendNuke.
    async fireNukeFromCandidates(candidates, target, selectedNuke, silos, difficulty) {
      const { clear } = this.partitionCandidatesBySamCoverage(
        candidates,
        selectedNuke.type,
        difficulty,
      );
      if (!isLegendaryDifficulty(difficulty)) {
        const best = await this.selectBuildableNukeCandidate(clear, selectedNuke.type);
        if (
          best &&
          (best.value > 0 || !isAtLeastHardDifficulty(difficulty)) &&
          await this.nukeHasPositiveExpectedValue(
            best,
            target,
            selectedNuke,
            silos,
          )
        ) {
          await this.sendNuke(best.tile, selectedNuke.type, target);
        }
      } else {
        if (
          await this.fireLegendaryClearFallthrough(clear, target, selectedNuke, silos)
        ) {
          return;
        }
      }
      // Silo capacity is not a salvo: covered shots must use the planner
      // below so every required atom is launched or queued with timing.
      if (isAtLeastHardDifficulty(difficulty)) {
        // Lever CLOSED (2026-10-09): the starvation release (spend held atoms
        // on SAM-overwhelm when clear=[] deterministically lost the baikal
        // no-harm gate in BOTH variants — v1 with failed-plan upgrades and v2
        // without — via the salvo pipeline state, not the salvos themselves:
        // zero sam-salvo events, 87 atoms, bot_dead at 11820; native call
        // restores the standing won@7971 receipt bit-for-bit). The sam regime
        // deadlock stays documented as a native-guard limitation. The
        // allowHeldAtoms parameter and its fixture cases remain for any
        // future lever that pairs the release with its own state scoping.
        await this.maybeDestroyEnemySam(target);
      }
      // Hydrogen finisher runs before the ladder's next ordinary decision so
      // the freshly-cleared cluster is harvested at maximum blast radius.
      if (currentDifficulty() === Difficulty.Legendary) {
        await this.maybeFirePostSalvoHydrogen();
      }
    }

    // LEGENDARY DIVERGENCE (2026-10-04, pre-declared in
    // docs/legendary-metric-ceilings.md): walk the ranked clear list — an
    // EV rejection no longer masks a lower-scored but EV-positive
    // candidate (measured example: five L1 Cities score 125k with EV
    // fail while one L4 City scores 97k with EV pass — the old single
    // pick fired nothing). Every existing gate is retained per candidate.
    async fireLegendaryClearFallthrough(clear, target, selectedNuke, silos) {
      for (const cand of clear) {
        if (cand.value <= -1) break;
        if (!(cand.value > 0 || this.hasScoreZeroReleaseReserve(selectedNuke.cost))) {
          continue;
        }
        if (
          await this.probeCanBuildNuke(cand.tile, selectedNuke.type) &&
          await this.nukeHasPositiveExpectedValue(
            cand,
            target,
            selectedNuke,
            silos,
          )
        ) {
          if (await this.sendNuke(cand.tile, selectedNuke.type, target)) return true;
        }
      }
      return false;
    }

    // Score-zero releases (Legendary divergence) hold a gold buffer above
    // the shot cost, retuned 2026-10-04 from 500k to 100k on measured
    // buffers: the unguarded ffa-n4-04 win fired at a 112,528 buffer while
    // dominant, and the team-temp-05 fork loss fired at 15k. Value>0 shots
    // are untouched. (Docs: legendary-metric-ceilings.md, reserve retune.)
    hasScoreZeroReleaseReserve(nukeCost) {
      const gold = Number(this.player?.gold?.() ?? 0n);
      return gold >= Number(nukeCost ?? 0n) + 100_000;
    }

    // FFA endgame survival strike (2026-08-24): against the last surviving
    // giant both measured death modes are static — mode A freezes at the
    // troop cap with an abundant treasury and zero attacks, mode B grinds at
    // parity-minus with zero outgoing attacks — while engine atom math kills
    // (1-(N/(N+k))^n) of BOTH the victim's pool AND its in-flight waves.
    // Gate helper: every signature read happens here so non-signature games
    // (team profiles among them) exit at the FIRST mode comparison.
    freezeGiantStrikeTarget() {
      if (state.settings.winFixes !== true) return null;
      if (currentDifficulty() !== Difficulty.Legendary) return null;
      const gameMode = String(
        this.game.config()?.gameConfig?.()?.gameMode ?? "",
      );
      if (gameMode !== "Free For All" && gameMode !== "FFA") return null;
      const tiles = Number(this.player.numTilesOwned?.() ?? 0);
      if (tiles < 50_000) return null;
      const ourTroops = Number(this.player.troops?.() ?? 0);
      const ourMax = Number(this.player.maxTroops?.() ?? 0);
      if (!(ourMax > 0) || ourTroops < ourMax * 0.85) return null;
      let giant = null;
      let giantTroops = 0;
      for (const other of this.game.players()) {
        if (other === this.player || !other?.isPlayer?.()) continue;
        if (other.isAlive?.() === false) continue;
        if (this.player.isFriendly?.(other) === true) continue;
        const troops = Number(other.troops?.() ?? 0);
        if (troops > giantTroops) {
          giant = other;
          giantTroops = troops;
        }
      }
      if (giant === null || giantTroops < ourTroops * 1.5) return null;
      return giant;
    }

    // Additive-only tail lane (see fireNukeFromCandidates): reached when
    // EVERY ordinary lane declined to fire. Structure-value economics do not
    // apply — a pool/wave deletion IS the payoff — but SAM-discipline still
    // does: clear trajectories first, saturated salvos second.
    async maybeFreezeGiantStrike(silos, difficulty) {
      const giant = this.freezeGiantStrikeTarget();
      if (giant === null) return;
      if (!this.isValidNukeTarget(giant)) return;
      if (this.hasPendingNukeLaunches()) return;
      const selectedNuke = await this.selectAffordableNuke();
      if (!selectedNuke) return;
      if (
        typeof selectedNuke.cost !== "bigint" ||
        this.player.gold() < selectedNuke.cost * 3n
      ) {
        return;
      }
      const candidates = await this.collectCandidatesWithRetry(
        giant, selectedNuke, silos, difficulty,
      );
      const { clear } = this.partitionCandidatesBySamCoverage(
        candidates.list,
        selectedNuke.type,
        difficulty,
      );
      const best = await this.selectBuildableNukeCandidate(clear, selectedNuke.type);
      if (best) {
        await this.sendNuke(best.tile, selectedNuke.type, giant);
        return;
      }
      await this.maybeDestroyEnemySam(giant);
    }

    // Candidate collection with the Legendary value-directed retry folded
    // in: returns { list, retargeted } where retargeted is the replacement
    // target (or null when the original target stood).
    async collectCandidatesWithRetry(target, selectedNuke, silos, difficulty) {
      const list = await this.collectNukeCandidates(
        target, selectedNuke.type, silos, difficulty,
      );
      if (difficulty !== Difficulty.Legendary) return { list, retargeted: null };
      const retried = await this.retryWithHigherValueTarget(
        target, selectedNuke, silos, difficulty, list,
      );
      if (retried === null) return { list, retargeted: null };
      return { list: retried.candidates, retargeted: retried.target };
    }

    // Legendary value-directed retry: the ordinary target ladder picks by
    // relation/crown, not wealth — measured as targets whose whole candidate
    // set scores ~0 while structure-rich enemies sit untargeted (3 ready
    // silos, 26MM gold, zero launches). When the chosen target cannot pay
    // for the bomb, retry once against the highest absolute structure-value
    // owner before standing down. Returns {target, candidates} or null.
    async retryWithHigherValueTarget(target, selectedNuke, silos, difficulty, candidates) {
      const valueTarget = this.findHighestValueNukeTarget(target);
      if (valueTarget === null) return null;
      if (await this.shouldDeferNukeForEconomy(valueTarget, selectedNuke.cost)) {
        return null;
      }
      // Wealth-directed retarget: engage whenever the ladder target holds
      // less than half the treasure of the value leader — not only when the
      // ladder found nothing at all. Conquest eats structure wealth fast, so
      // waiting for a total miss wastes the window in which a 5MM harvest
      // is still possible.
      const ladderValue = this.playerStructureValue(target);
      const valueTargetValue = this.playerStructureValue(valueTarget);
      if (
        this.bestCandidateValue(candidates) > 0 &&
        valueTargetValue < Math.max(1_500_000, ladderValue * 2)
      ) {
        return null;
      }
      const retryCandidates = await this.collectNukeCandidates(
        valueTarget, selectedNuke.type, silos, difficulty,
      );
      if (this.bestCandidateValue(retryCandidates) <= this.bestCandidateValue(candidates)) {
        return null;
      }
      return { target: valueTarget, candidates: retryCandidates };
    }

    playerStructureValue(player) {
      const structures = unitsOfTypes(player);
      return structures.reduce(
        (total, structure) => total + this.nukeStructureValue(structure),
        0,
      );
    }

    bestCandidateValue(candidates) {
      return candidates.length > 0 ? Number(candidates[0]?.value ?? 0) : 0;
    }

    // Highest ABSOLUTE nuke structure value among alive, attackable,
    // non-teammate players — the density fallback ranks per-tile, which
    // favors compact small owners over big treasure troves. Memoized per
    // (tick, excluded target): the conquest-spare hook calls this for every
    // sendAttack on an attack-crossing tick and the winner cannot change
    // within one tick.
    findHighestValueNukeTarget(exclude) {
      const tick = this.game.ticks();
      const excludeKey = exclude ? String(exclude.smallID()) : "-";
      const cacheKey = `${tick}:${excludeKey}`;
      if (this._highestValueTargetCacheKey === cacheKey) {
        return this._highestValueTargetCache;
      }
      const resolved = this.computeHighestValueNukeTarget(exclude);
      this._highestValueTargetCacheKey = cacheKey;
      this._highestValueTargetCache = resolved;
      return resolved;
    }

    computeHighestValueNukeTarget(exclude) {
      let best = null;
      let bestValue = 0;
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (exclude && other.smallID() === exclude.smallID()) continue;
        if (other.isAlive?.() === false) continue;
        if (playersArePermanentTeammates(this.player, other)) continue;
        if (this.attackBehavior.shouldAttack(other) === false) continue;
        const structures = unitsOfTypes(other);
        const value = structures.reduce(
          (total, structure) => total + this.nukeStructureValue(structure),
          0,
        );
        if (value > bestValue) {
          best = other;
          bestValue = value;
        }
      }
      return best;
    }

    async nukeHasPositiveExpectedValue(candidate, target, selectedNuke, silos) {
      if (currentDifficulty() !== Difficulty.Legendary) return true;
      // Survival bypass only: an existential attack may spend any bomb.
      // The plain retaliation bypass was measured firing 11 sub-value shots
      // (best candidate 5-31k vs a 750k Atom) for 0 destroyed value on the
      // closest matrix row — a direct violation of the expected-value
      // requirement, since deterrence bombs that hit nothing still cost
      // full price and invite counter-retaliation.
      if (this.isUnderHeavyAttack()) return true;
      if (
        this.findStrategicBorderArmyTarget()?.smallID?.() ===
        target?.smallID?.()
      ) return true;
      const structures = unitsOfTypes(target);
      const magnitude = this.game.config().nukeMagnitudes(selectedNuke.type);
      const outerDist = euclDistFN(candidate.tile, magnitude.outer, false);
      const vulnerableValue = structures
        .filter((unit) => outerDist(this.game, unit.tile()))
        .reduce((sum, unit) => sum + this.nukeStructureValue(unit), 0);
      if (vulnerableValue <= 0) return false;
      const coveringSamLevels = Number(candidate.coveringSamLevels || 0);
      const readySiloCapacity = (silos || []).reduce(
        (sum, silo) =>
          sum + (silo?.isUnderConstruction?.() === true ? 0 : Math.max(1, Number(silo.level?.()) || 1)),
        0,
      );
      const requiredShots = Math.max(1, coveringSamLevels + 1);
      const launchCount = coveringSamLevels > 0 ? requiredShots : 1;
      const totalCost = BigInt(launchCount) * BigInt(selectedNuke.cost || 0n);
      return BigInt(Math.round(vulnerableValue)) >= totalCost &&
        (coveringSamLevels <= 0 || readySiloCapacity >= requiredShots);
    }

    nukeStructureValue(unit) {
      // Authoritative replacement values mirroring the engine's build costs
      // (Config.unitInfo): City/Port/Factory double per level from 125k,
      // MissileSilo is flat 1M, SAM steps 1.5M/3M, DefensePost steps 50k
      // capped at 250k. The earlier flat 25k/level City pricing made the
      // positive-EV guard veto every legitimate shot (measured More Than
      // Luck: 23 candidates, 4 positive-scored, best 10k vs a real City-3
      // value of 1M — valueGate false at 720 consecutive decisions).
      const level = Math.max(1, Number(unit?.level?.()) || 1);
      switch (unit?.type?.()) {
        case UNIT.City:
          return Math.min(1_000_000, Math.pow(2, level - 1) * 125_000);
        case UNIT.Port:
        case UNIT.Factory:
          return Math.min(1_000_000, Math.pow(2, level - 1) * 125_000);
        case UNIT.MissileSilo:
          return 1_000_000;
        case UNIT.SAMLauncher:
          return Math.min(3_000_000, level * 1_500_000);
        case UNIT.DefensePost:
          return Math.min(250_000, level * 50_000);
        default:
          return 0;
      }
    }

    partitionCandidatesBySamCoverage(candidates, nukeType, difficulty) {
      const clear = [];
      const covered = [];
      for (const cand of candidates) {
        if (difficulty !== Difficulty.Legendary) {
          clear.push(cand);
          continue;
        }
        const spawnTile = this.nukeSpawn(nukeType, cand.tile);
        const interceptable = spawnTile !== false &&
          this.isTrajectoryInterceptableBySam(spawnTile, cand.tile);
        const coveringSams = interceptable ? this.findEnemySamsCoveringTile(cand.tile) : [];
        // Destination saturation does not account for SAMs elsewhere along
        // the route. Match getRouteEligibleSilos before authorizing a shot.
        if (interceptable && (coveringSams.length === 0 ||
          this.isTrajectoryInterceptableBySam(
            spawnTile, cand.tile, new Set(coveringSams.map((sam) => sam.id())),
          ))) continue;
        const coveringLevel = coveringSams.reduce(
          (sum, sam) => sum + Math.max(0, Number(sam.level?.()) || 0),
          0,
        );
        const entry = { ...cand, coveringSamLevels: coveringLevel };
        if (coveringLevel > 0) covered.push(entry);
        else clear.push(entry);
      }
      return { clear, covered };
    }

    /**
     * Offensive nukes yield to the shared economy/defense reserve. A heavy
     * assault or direct retaliation keeps the emergency path responsive;
     * ordinary target selection follows the surplus policy.
     */
    shouldDeferNukeForEconomy(nukeTarget, nukeCost) {
      if (this.hasActiveMaritimeInvasion()) return true;
      // A Hydro Legendary nation with a live SAM has already paid for the
      // defensive prerequisite. Once an Atom is affordable, withholding it
      // behind the next 1.5M SAM reserve leaves the Silo permanently idle and
      // makes the nuclear economy unreachable; the friendly-fire scorer still
      // protects our own structures below.
      if (
        this.isHydroNation === true &&
        currentDifficulty() === Difficulty.Legendary &&
        this.player.units(UNIT.SAMLauncher).length > 0 &&
        this.player.gold() >= BigInt(nukeCost || 0n)
      ) {
        return false;
      }
      const policy = this.structureBehavior?.shouldDeferOffensiveNuke;
      if (typeof policy !== "function") return false;
      {
        if (this.isUnderHeavyAttack()) return false;
      }
      if (this.isRetaliationNukeTarget(nukeTarget)) return false;
      {
        return policy.call(this.structureBehavior, nukeCost) === true;
      }
    }

    getCrownLeadThreshold(difficulty) {
      switch (difficulty) {
        case Difficulty.Easy: return 0.4;
        case Difficulty.Medium: return 0.3;
        case Difficulty.Hard: return 0.2;
        case Difficulty.Impossible: return 0.1;
        case Difficulty.Legendary: return 0.05;
        default: return 0.1;
      }
    }

    hasActiveMaritimeInvasion() {
      {
        return this.structureBehavior?.hasActiveMaritimeInvasion?.() === true;
      }
    }

    isRetaliationNukeTarget(nukeTarget) {
      {
        const findIncoming = this.attackBehavior?.findIncomingAttackPlayer;
        if (typeof findIncoming !== "function" || !nukeTarget) return false;
        const incoming = findIncoming.call(this.attackBehavior);
        if (typeof incoming?.smallID !== "function") return false;
        if (typeof nukeTarget.smallID !== "function") return false;
        return incoming.smallID() === nukeTarget.smallID();
      }
    }

    findTwoPlayerNukeTarget(difficulty) {
      if (!isAtLeastHardDifficulty(difficulty)) return null;
      const players = this.game.players();
      if (players.length !== 2) return null;
      return players.find((other) => other.smallID() !== this.player.smallID()) ?? null;
    }

    findDominantCrownNukeTarget(difficulty) {
      if (!isAtLeastHardDifficulty(difficulty)) return null;
      if (this.game.config().gameConfig().gameMode !== GameMode.FFA) return null;
      const availableTiles = this.game.numLandTiles() - this.game.numTilesWithFallout();
      if (availableTiles <= 0) return null;
      const crown = this.game.players().slice()
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0];
      if (!crown || crown.smallID() === this.player.smallID()) return null;
      if (playersArePermanentTeammates(this.player, crown)) return null;
      return crown.numTilesOwned() / availableTiles > 0.5 ? crown : null;
    }

    findAllyNukeTarget() {
      // Player.allies() contains only explicit, breakable alliances and omits
      // permanent teammates. Nuclear coordination treats only permanent teams
      // as allied ownership.
      for (const ally of this.game.players()) {
        if (ally.smallID() === this.player.smallID()) continue;
        if (ally.isAlive?.() === false) continue;
        if (!playersArePermanentTeammates(this.player, ally)) continue;
        const target = ally.targets().find((candidate) =>
          candidate.smallID() !== this.player.smallID() &&
          !playersArePermanentTeammates(this.player, candidate));
        if (target) return target;
      }
      return null;
    }

    findHostileNukeTarget() {
      for (const relation of this.player.allRelationsSorted()) {
        if (relation.relation !== Relation.Hostile) continue;
        const other = relation.player;
        if (playersArePermanentTeammates(this.player, other)) continue;
        // A hostile is still a legitimate nuclear target when we have grown
        // larger.  The old 2x-capacity veto made a winning nation unable to
        // auto-nuke any weaker enemy in a multi-player game, even with ready
        // silos and a positive target score.  Resource, trajectory and target
        // scoring gates below still decide whether firing is worthwhile.
        return other;
      }
      return null;
    }

    // ── findBestNukeTarget — NationNukeBehavior.ts:166 ────────────────────────
    findBestNukeTarget() {
      const difficulty = currentDifficulty();
      const twoPlayerTarget = this.findTwoPlayerNukeTarget(difficulty);
      if (twoPlayerTarget) return twoPlayerTarget;

      // Retaliate against incoming attacks (Most important!)
      const incomingAttackPlayer = this.attackBehavior.findIncomingAttackPlayer();
      if (incomingAttackPlayer) {
        return incomingAttackPlayer;
      }

      // DIVERGENCE (Legendary, pre-declared in legendary-metric-ceilings.md):
      // a hostile Nation/Human on our shared border with at least our army can
      // commit a decisive invasion before it appears in incomingAttacks().
      // Reuse StructureBehavior's cached strategic-border scan so nukes and
      // preemptive Defense Posts react to the same threat snapshot.
      if (isLegendaryDifficulty(difficulty)) {
        const counterforceTarget = this.findStrategicBorderArmyTarget();
        if (counterforceTarget !== null) return counterforceTarget;
      }

      // On Impossible/Legendary, the richest nation hunts very high structure density targets
      // Restricting to the richest nation prevents every impossible nation
      // from piling onto the same compact player.
      if (isAtLeastHardDifficulty(difficulty) && this.isRichestNation() && this.random.chance(2)) {
        const denseTarget = this.findHighDensityTarget();
        if (denseTarget !== null) return denseTarget;
      }
      const dominantCrown = this.findDominantCrownNukeTarget(difficulty);
      if (dominantCrown) return dominantCrown;
      const allyTarget = this.findAllyNukeTarget();
      if (allyTarget) return allyTarget;
      const hostileTarget = this.findHostileNukeTarget();
      if (hostileTarget) return hostileTarget;

      // In FFAs, nuke the crown if they're far enough ahead
      const crownTarget = this.findFFACrownTarget();
      if (crownTarget) {
        return crownTarget;
      }

      // In Teams, nuke the strongest team
      const teamTarget = this.findStrongestTeamTarget();
      if (teamTarget) {
        return teamTarget;
      }

      // Legendary fallback: an affordable silo must not remain idle merely
      // because the ordinary relation/crown ladder found no target. Select the
      // densest enemy structure owner, but never a permanent teammate or our
      // own player; nukeTileScore still rejects friendly-fire geometry.
      if (difficulty === Difficulty.Legendary) {
        return this.findLegendaryStructureTarget();
      }
      return null;
    }

    findStrategicBorderArmyTarget() {
      const tick = Number(this.game?.ticks?.());
      if (
        Number.isFinite(tick) &&
        this._strategicBorderArmyTargetTick === tick
      ) {
        return this._strategicBorderArmyTarget;
      }

      let target = null;
      const strongest =
        this.structureBehavior?.strongestQuietStrategicBorderOpponent?.();
      const ownTroops = Number(this.player?.troops?.() ?? 0);
      const hostileTroops = Number(strongest?.troops);
      if (
        strongest !== null &&
        Number.isFinite(ownTroops) &&
        ownTroops > 0 &&
        Number.isFinite(hostileTroops) &&
        hostileTroops >= ownTroops
      ) {
        target = this.game.players().find(
          (other) => other.smallID?.() === strongest.opponentSid,
        ) ?? null;
        if (!this.isValidNukeTarget(target)) target = null;
      }

      if (Number.isFinite(tick)) {
        this._strategicBorderArmyTargetTick = tick;
        this._strategicBorderArmyTarget = target;
      }
      return target;
    }

    findLegendaryStructureTarget() {
      let best = null;
      let bestScore = 0;
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (other.isAlive?.() === false) continue;
        if (playersArePermanentTeammates(this.player, other)) continue;
        if (this.attackBehavior.shouldAttack(other) === false) continue;
        const structures = unitsOfTypes(other);
        const levelSum = structures.reduce(
          (total, structure) => total + Number(structure.level?.() || 1),
          0,
        );
        const density = levelSum / Math.max(1, other.numTilesOwned?.() || 1);
        if (levelSum > 0 && density > bestScore) {
          best = other;
          bestScore = density;
        }
      }
      return best;
    }

    // ── isRichestNation — NationNukeBehavior.ts:262 ───────────────────────────
    isRichestNation() {
      const myGold = this.player.gold();
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (other.type() !== PlayerType.Nation) continue;
        if (other.gold() > myGold) return false;
      }
      return true;
    }

    // ── findHighDensityTarget — NationNukeBehavior.ts:272 ─────────────────────
    findHighDensityTarget() {
      let bestTarget = null;
      let bestDensity = HIGH_DENSITY_NUKE_THRESHOLD;
      for (const other of this.game.players()) {
        if (other.smallID() === this.player.smallID()) continue;
        if (other.type() === PlayerType.Bot) continue;
        if (playersArePermanentTeammates(this.player, other)) continue;
        const tilesOwned = other.numTilesOwned();
        if (tilesOwned === 0) continue;
        const structures = unitsOfTypes(other);
        let levelSum = 0;
        for (const s of structures) levelSum += s.level();
        // Skip players with too few structures regardless of density
        if (levelSum < MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE) continue;
        const density = levelSum / tilesOwned;
        if (density > bestDensity) {
          bestDensity = density;
          bestTarget = other;
        }
      }
      return bestTarget;
    }

    // ── findFFACrownTarget — NationNukeBehavior.ts:295 ────────────────────────
    findFFACrownTarget() {
      const difficulty = currentDifficulty();
      const gameMode = this.game.config().gameConfig().gameMode;
      if (gameMode !== GameMode.FFA) {
        return null;
      }

      if (this.game.players().length <= 1) {
        return null;
      }

      const sortedByTiles = this.game
        .players()
        .slice()
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      const firstPlace = sortedByTiles[0];

      // If we're the crown on Impossible/Legendary difficulty, target 2nd place
      if (
        isAtLeastHardDifficulty(difficulty) &&
        firstPlace.smallID() === this.player.smallID() &&
        sortedByTiles.length >= 2
      ) {
        const secondPlace = sortedByTiles[1];
        if (!playersArePermanentTeammates(this.player, secondPlace)) {
          return secondPlace;
        }
      }

      // Don't target ourselves or allies
      if (
        firstPlace.smallID() === this.player.smallID() ||
        playersArePermanentTeammates(this.player, firstPlace)
      ) {
        return null;
      }

      const numTilesWithoutFallout =
        this.game.numLandTiles() - this.game.numTilesWithFallout();
      if (numTilesWithoutFallout <= 0) {
        return null;
      }

      const firstPlaceShare =
        firstPlace.numTilesOwned() / numTilesWithoutFallout;
      const myShare = this.player.numTilesOwned() / numTilesWithoutFallout;

      // Check if first place has threshold% more tile-percentage of the map than us
      if (firstPlaceShare - myShare > this.getCrownLeadThreshold(difficulty)) {
        return firstPlace;
      }

      return null;
    }

    // ── findStrongestTeamTarget — NationNukeBehavior.ts:363 ───────────────────
    findStrongestTeamTarget() {
      if (this.game.config().gameConfig().gameMode !== GameMode.Team) {
        return null;
      }

      if (this.game.players().length <= 1) {
        return null;
      }

      const teamTiles = new Map();
      const teamPlayers = new Map();

      for (const p of this.game.players()) {
        const team = p.team();
        if (team === null) continue;

        teamTiles.set(team, (teamTiles.get(team) ?? 0) + p.numTilesOwned());
        let players = teamPlayers.get(team);
        if (!players) {
          players = [];
          teamPlayers.set(team, players);
        }
        players.push(p);
      }

      const sortedTeams = Array.from(teamTiles.entries()).sort(
        (a, b) => b[1] - a[1],
      );

      if (sortedTeams.length === 0) {
        return null;
      }

      let strongestTeam = sortedTeams[0][0];
      // team is a team id (string), not a player — keep the `===` compare.
      if (strongestTeam === this.player.team()) {
        if (sortedTeams.length > 1) {
          strongestTeam = sortedTeams[1][0];
        } else {
          return null;
        }
      }

      const targetTeamPlayers = teamPlayers.get(strongestTeam);

      // Filter out friendly players
      const validTargets = targetTeamPlayers.filter(
        (p) => !playersArePermanentTeammates(this.player, p),
      );

      if (validTargets.length === 0) {
        return null;
      }

      if (this.random.chance(2)) {
        // Strongest player
        return validTargets.reduce((prev, current) =>
          this.game.config().maxTroops(prev) >
          this.game.config().maxTroops(current)
            ? prev
            : current,
        );
      } else {
        // Random player
        return this.random.randElement(validTargets);
      }
    }

    // ── getPerceivedNukeCost — NationNukeBehavior.ts:431 (now async; cost() is a
    //    buildables probe). Simulate saving up for a MIRV. ─────────────────────
    async getPerceivedNukeCost(type) {
      // If only 2 players left, use actual cost (no point saving for MIRV)
      if (this.game.players().length === 2) {
        return await this.cost(type);
      }

      // If MIRVs are disabled, return the actual cost
      if (this.game.config().isUnitDisabled(UNIT.MIRV)) {
        return await this.cost(type);
      }

      // Save up a limited amount in team games, synced with NationStructureBehavior
      // Saving up for a MIRV is not relevant
      if (
        this.game.config().gameConfig().gameMode === GameMode.Team &&
        this.player.gold() > (await this.cost(UNIT.HydrogenBomb))
      ) {
        return await this.cost(type);
      }

      // Return the actual cost if we already have enough gold to buy both a MIRV and a hydro
      if (
        this.player.gold() >
        (await this.cost(UNIT.MIRV)) + (await this.cost(UNIT.HydrogenBomb))
      ) {
        return await this.cost(type);
      }

      // On Hard, Impossible, and Legendary, ignore perceived cost when under heavy attack
      // The nation is probably going to get destroyed soon, so go all-in on nukes
      const difficulty = currentDifficulty();
      if (
        isAtLeastHardDifficulty(difficulty) &&
        this.isUnderHeavyAttack()
      ) {
        return await this.cost(type);
      }

      // Legendary divergence: the perceived-cost escalation models "save up
      // for a MIRV" and prices a sustained bombardment out of its own war
      // chest (750k real price escalates past 3.8M after four launches while
      // the treasury peaks near 2.6M — measured on Baikal). The adaptive
      // tier funds repeat strikes from the recurring chest, so affordability
      // tracks the real price and the MIRV discipline stays with the
      // faithful tiers.
      if (
        state.settings.winFixes === true &&
        difficulty === Difficulty.Legendary
      ) {
        return await this.cost(type);
      }

      // DIVERGENCE C1: src seeds atom/hydrogenBombPerceivedCost from cost(type) in
      // field initializers. We seed lazily here on first use (from the live cost),
      // then escalate per launch (in sendNuke). Until seeded, fall back to the live
      // cost — identical to src's initial value (cost(type) before any launch).
      if (type === UNIT.AtomBomb) {
        if (this.atomBombPerceivedCost === null) {
          this.atomBombPerceivedCost = await this.cost(UNIT.AtomBomb);
        }
        return this.atomBombPerceivedCost;
      } else {
        if (this.hydrogenBombPerceivedCost === null) {
          this.hydrogenBombPerceivedCost = await this.cost(UNIT.HydrogenBomb);
        }
        return this.hydrogenBombPerceivedCost;
      }
    }

    // ── isUnderHeavyAttack — NationNukeBehavior.ts:477 ────────────────────────
    isUnderHeavyAttack() {
      // Only live pressure justifies bypassing the normal nuke economy. The
      // client can briefly retain a cancelled wave in incomingAttacks(), and
      // different adapters expose `retreating` as either an accessor or a
      // plain boolean. Counting that stale force makes the bot go all-in on
      // nukes after the danger has already ended.
      const incomingAttacks = this.player.incomingAttacks();
      let totalIncomingTroops = 0;
      for (const attack of incomingAttacks) {
        const retreating =
          typeof attack?.retreating === "function"
            ? attack.retreating()
            : attack?.retreating;
        if (retreating === true) continue;
        totalIncomingTroops += attack.troops();
      }

      const myTroops = this.player.troops();

      return totalIncomingTroops >= myTroops;
    }

    // ── removeOldNukeEvents — NationNukeBehavior.ts:490 ───────────────────────
    removeOldNukeEvents() {
      const maxAge = 600; // 600 ticks = 1 minute
      const tick = this.game.ticks();
      while (
        this.recentlySentNukes.length > 0 &&
        this.recentlySentNukes[0][0] + maxAge < tick
      ) {
        this.recentlySentNukes.shift();
      }
    }

    // ── isTeammateAlreadyNukingThisSpot — NationNukeBehavior.ts:501 ───────────
    isTeammateAlreadyNukingThisSpot(tile, nukeType) {
      // Get the inner radius for our nuke type
      const ourInnerRadius = this.game.config().nukeMagnitudes(nukeType).inner;

      // Get all active nukes in the game
      const activeNukes = this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb);

      // Check if any teammate's nuke blast radius overlaps with ours
      for (const nuke of activeNukes) {
        const nukeOwner = nuke.owner();

        // Skip our own nukes and non-teammate nukes
        if (
          (nukeOwner &&
            nukeOwner.smallID &&
            nukeOwner.smallID() === this.player.smallID()) ||
          !playersArePermanentTeammates(this.player, nukeOwner)
        ) {
          continue;
        }

        // Get the target tile of the teammate's nuke
        const targetTile = nuke.targetTile();
        if (targetTile === null || targetTile === undefined) continue;

        // Get the blast radius of the teammate's nuke
        const teammateInnerRadius = this.game
          .config()
          .nukeMagnitudes(nuke.type()).inner;

        // Check if the blast zones overlap
        // They overlap if distance between targets < sum of the two radii
        const distSquared = this.game.euclideanDistSquared(tile, targetTile);
        const sumRadius = ourInnerRadius + teammateInnerRadius;
        const sumRadiusSquared = sumRadius * sumRadius;

        if (distSquared <= sumRadiusSquared) {
          return true;
        }
      }

      return false;
    }

    findUntargetableTrajectoryRange(trajectory, spawnTile, targetTile) {
      const targetRangeSquared = this.game.config().defaultNukeTargetableRange() ** 2;
      let untargetableStart = -1;
      let untargetableEnd = -1;
      for (let i = 0; i < trajectory.length; i++) {
        const tile = trajectory[i];
        if (untargetableStart === -1) {
          const outsideSpawn = this.game.euclideanDistSquared(tile, spawnTile) > targetRangeSquared;
          if (!outsideSpawn) continue;
          const insideTarget = this.game.euclideanDistSquared(tile, targetTile) < targetRangeSquared;
          if (insideTarget) break;
          untargetableStart = i;
        } else if (this.game.euclideanDistSquared(tile, targetTile) < targetRangeSquared) {
          untargetableEnd = i;
          break;
        }
      }
      return { start: untargetableStart, end: untargetableEnd };
    }

    isHostileSamIntercept(sam, excludedSamIds) {
      const owner = sam.unit.owner();
      const ownSam = owner?.smallID?.() === this.player.smallID();
      if (ownSam || playersArePermanentTeammates(this.player, owner)) return false;
      if (excludedSamIds?.has(sam.unit.id())) return false;
      const rangeSquared = this.game.config().samRange(sam.unit.level()) ** 2;
      return sam.distSquared <= rangeSquared;
    }

    isTrajectoryIndexTargetable(index, untargetable) {
      return !(
        untargetable.start !== -1 &&
        untargetable.end !== -1 &&
        index >= untargetable.start &&
        index < untargetable.end
      );
    }

    canSamReachTrajectoryIndex(sam, trajectory, index) {
      const speed = Number(this.game.config().defaultSamMissileSpeed());
      if (!Number.isFinite(speed) || speed <= 0) return false;
      const distance = Number(
        this.game.manhattanDist(sam.unit.tile(), trajectory[index]),
      );
      if (!Number.isFinite(distance) || distance < 0) return false;
      return Math.ceil(distance / speed) <= index;
    }

    hasReachableSamAtTrajectoryIndex(
      coverageTile,
      trajectory,
      interceptionIndex,
      excludedSamIds,
    ) {
      const nearbySams = this.game.nearbyUnits(
        coverageTile,
        this.game.config().maxSamRange(),
        UNIT.SAMLauncher,
      );
      for (const sam of nearbySams) {
        if (
          this.isHostileSamIntercept(sam, excludedSamIds) &&
          this.canSamReachTrajectoryIndex(sam, trajectory, interceptionIndex)
        ) {
          return true;
        }
      }
      return false;
    }

    hasFinalExplosionSamInterception(trajectory, untargetable, excludedSamIds) {
      const finalIndex = trajectory.length - 1;
      const penultimateIndex = finalIndex - 1;
      if (penultimateIndex < 0) return false;
      if (!this.isTrajectoryIndexTargetable(finalIndex, untargetable)) return false;
      if (!this.isTrajectoryIndexTargetable(penultimateIndex, untargetable)) return false;
      return this.hasReachableSamAtTrajectoryIndex(
        trajectory[finalIndex],
        trajectory,
        penultimateIndex,
        excludedSamIds,
      );
    }

    // ── isTrajectoryInterceptableBySam — NationNukeBehavior.ts:547 ────────────
    // mirroring NukeTrajectoryPreviewLayer.ts logic a bit
    isTrajectoryInterceptableBySam(spawnTile, targetTile, excludedSamIds) {
      const pathFinder = UniversalPathFinding.Parabola(this.game, {
        increment: this.game.config().defaultNukeSpeed(),
        distanceBasedHeight: true,
        directionUp: true,
      });
      const trajectory = pathFinder.findPath(spawnTile, targetTile) ?? [];
      if (trajectory.length === 0) return false;
      const untargetable = this.findUntargetableTrajectoryRange(
        trajectory, spawnTile, targetTile,
      );

      // NukeExecution advances before SAMMissileExecution, so the explosion
      // tick itself cannot be intercepted. Mirror SAMTargetingSystem's
      // flight-time test for every earlier targetable trajectory tile.
      const lastInterceptableIndex = trajectory.length - 2;
      for (let i = 0; i <= lastInterceptableIndex; i++) {
        if (!this.isTrajectoryIndexTargetable(i, untargetable)) continue;
        if (
          this.hasReachableSamAtTrajectoryIndex(
            trajectory[i],
            trajectory,
            i,
            excludedSamIds,
          )
        ) {
          return true;
        }
      }

      // If the detonation tile is covered, the engine makes one final attempt
      // against the preceding in-flight tile, even when that tile lies outside
      // the SAM's geometric range.
      return this.hasFinalExplosionSamInterception(
        trajectory,
        untargetable,
        excludedSamIds,
      );
    }

    // ── isValidNukeTile — NationNukeBehavior.ts:630 ───────────────────────────
    isValidNukeTile(t, nukeTarget) {
      const difficulty = currentDifficulty();

      const owner = this.game.owner(t);
      // src: `if (owner === nukeTarget) return true;` — identity compare. owner is
      // a wrapped player (or TN passthrough). Compare via smallID when both are
      // players; nukeTarget is always a player here.
      if (
        owner &&
        owner.isPlayer &&
        owner.isPlayer() &&
        owner.smallID() === nukeTarget.smallID()
      ) {
        return true;
      }
      // On Hard, Impossible, and Legendary, allow TerraNullius (hit small islands) and in team games other non-friendly players
      if (
        isAtLeastHardDifficulty(difficulty) &&
        (!(owner && owner.isPlayer && owner.isPlayer()) ||
          (this.game.config().gameConfig().gameMode === GameMode.Team &&
            owner.isPlayer() &&
            !playersArePermanentTeammates(this.player, owner)))
      ) {
        return true;
      }
      // On Easy & Medium, only allow tiles owned by the target player (=> nuke away from the border) to reduce nuke usage
      return false;
    }

    // ── nukeTileScore — NationNukeBehavior.ts:650 ─────────────────────────────
    /**
     * Level-weighted value of a friendly (own or permanent-teammate) structure
     * for the friendly-fire blast penalty. MissileSilo is the heaviest (it is
     * our nuclear strike capability and the most expensive to rebuild); SAMs
     * and Cities follow; Ports/Factories mirror their enemy scoring value.
     * DefensePosts are excluded — they are cheap, spammable border screens and
     * penalizing them would veto every legitimate border tile.
     */
    friendlyFireStructureValue(unit) {
      const level = unit.level();
      switch (unit.type()) {
        case UNIT.MissileSilo:
          return 50_000 * level;
        case UNIT.SAMLauncher:
          return 40_000 * level;
        case UNIT.City:
          return 25_000 * level;
        case UNIT.Port:
          return 15_000 * level;
        case UNIT.Factory:
          return 15_000 * level;
        default:
          return 0;
      }
    }

    /**
     * Live enumeration behind the friendly-fire snapshot: our own structures
     * plus those of permanent teammates only — nuclear coordination already
     * treats their land and structures as ours (see findAllyNukeTarget); a
     * breakable diplomatic ally's structures carry no such guarantee.
     */
    collectFriendlyNukeStructureUnits() {
      const units = [];
      if (typeof this.player?.units === "function") {
        units.push(...unitsOfTypes(this.player));
      }
      if (typeof this.game?.players === "function") {
        for (const other of this.game.players()) {
          if (!other || other.smallID?.() === this.player?.smallID?.()) continue;
          if (!playersArePermanentTeammates(this.player, other)) continue;
          units.push(...unitsOfTypes(other));
        }
      }
      return units;
    }

    /**
     * Per-decision snapshot of friendly structure tiles for the friendly-fire
     * penalty. nukeTileScore runs once per candidate tile; without this memo a
     * sweep would re-enumerate own + teammate units for every tile. Memoized by
     * game tick (a candidate sweep never spans ticks — collectNukeCandidates
     * completes within one decision) with both scoring and replacement values
     * pre-resolved so the per-tile penalty stays a pure distance check.
     */
    friendlyNukeStructures() {
      const tick = Number(this.game.ticks());
      if (
        this._friendlyNukeStructureTick !== tick ||
        !Array.isArray(this._friendlyNukeStructures)
      ) {
        this._friendlyNukeStructures = this.collectFriendlyNukeStructureUnits()
          .map((unit) => ({
            tile: unit.tile(),
            value: this.friendlyFireStructureValue(unit),
            replacementValue: this.nukeStructureValue(unit),
          }))
          .filter((entry) => entry.value > 0);
        this._friendlyNukeStructureTick = tick;
      }
      return this._friendlyNukeStructures;
    }

    /**
     * Penalty for a candidate tile whose blast radii would also hit friendly
     * structures: every structure strictly inside the outer circle is destroyed.
     * Uses the existing replacement multiplier for the complete destruction area.
     */
    friendlyFirePenalty(tile, magnitude, replacementValues = false) {
      const friendlyStructures = this.friendlyNukeStructures();
      if (friendlyStructures.length === 0) return 0;
      const outerSquared = magnitude.outer * magnitude.outer;
      let destroyedValue = 0;
      for (const entry of friendlyStructures) {
        if (this.game.euclideanDistSquared(tile, entry.tile) < outerSquared) {
          destroyedValue += replacementValues ? entry.replacementValue : entry.value;
        }
      }
      return destroyedValue * FRIENDLY_FIRE_PENALTY;
    }

    /**
     * Counterforce weighting for enemy MissileSilo tiles: a silo owned by an
     * enemy who can already pay for a MIRV is a loaded gun — destroying it
     * denies a 25M+ saturation strike that would erase our structure core,
     * and (since the engine escalates the MIRV price globally per launch)
     * keeps the market cheaper for us. Gold alone does not prove intent to
     * launch, so the multiplier is bounded; the threshold is the base price
     * because the live escalated quote is only reachable through an async
     * probe while this scorer runs synchronously. Returns 1 for every other
     * owner shape (own silos never reach this scorer; stubs lack owner/gold).
     */
    mirvCapableSiloPriority(unit) {
      const owner = unit?.owner?.();
      if (!owner) return 1;
      const gold = owner.gold?.();
      if (typeof gold !== "bigint" || gold < MIRV_CAPABLE_GOLD_THRESHOLD) {
        return 1;
      }
      return MIRV_CAPABLE_SILO_PRIORITY_MULTIPLIER;
    }

    nukeTileScore(tile, silos, targets, nukeType) {
      const magnitude = this.game.config().nukeMagnitudes(nukeType);
      const dist = euclDistFN(tile, magnitude.outer, false);
      let tileValue = targets
        .filter((unit) => dist(this.game, unit.tile()))
        .map((unit) => {
          const level = unit.level();
          switch (unit.type()) {
            case UNIT.City:
              return 25_000 * level;
            case UNIT.DefensePost:
              return 5_000 * level;
            case UNIT.MissileSilo:
              return 50_000 * level * this.mirvCapableSiloPriority(unit);
            case UNIT.Port:
              return 15_000 * level;
            case UNIT.Factory:
              return 15_000 * level;
            default:
              return 0;
          }
        })
        .reduce((prev, cur) => prev + cur, 0);

      const difficulty = currentDifficulty();
      // On Easy, ignore SAMs entirely.
      // On Medium, apply a simple local SAM penalty.
      // On Hard, Impossible, and Legendary we rely on trajectory-based interception checks instead. See maybeSendNuke().
      if (difficulty === Difficulty.Medium) {
        const dist50 = euclDistFN(tile, 50, false);
        const hasSam = targets.some(
          (unit) =>
            unit.type() === UNIT.SAMLauncher && dist50(this.game, unit.tile()),
        );
        if (hasSam) return -1;
      }

      // On Impossible/Legendary difficulty and a hydrogen bomb, add value for SAMs that can be outranged
      if (
        isAtLeastHardDifficulty(difficulty) &&
        nukeType === UNIT.HydrogenBomb
      ) {
        const hydroMagnitude = this.game
          .config()
          .nukeMagnitudes(UNIT.HydrogenBomb);
        const nearbySams = this.game.nearbyUnits(
          tile,
          hydroMagnitude.outer,
          UNIT.SAMLauncher,
        );

        for (const sam of nearbySams) {
          const samLevel = sam.unit.level();
          if (samLevel >= 5) continue; // Can't outrange level 5+ SAMs

          const samRange = this.game.config().samRange(samLevel);
          const distToSam = Math.sqrt(
            this.game.euclideanDistSquared(tile, sam.unit.tile()),
          );

          // Check if we can outrange this SAM
          if (distToSam > samRange) {
            // Add significant value for destroying a SAM that we can outrange
            tileValue += 100_000 * samLevel;
          }
        }
      }

      // Prefer tiles that are closer to a silo (but preserve structure value)
      const siloTiles = silos.map((u) => u.tile());
      const result = closestTwoTiles(this.game, siloTiles, [tile]);
      if (result === null) throw new Error("Missing result");
      const closestSilo = result.x;
      const distanceSquared = this.game.euclideanDistSquared(tile, closestSilo);
      const distanceToClosestSilo = Math.sqrt(distanceSquared);
      const distancePenalty = distanceToClosestSilo * 30;
      const baseTileValue = tileValue;
      tileValue = Math.max(baseTileValue * 0.2, tileValue - distancePenalty); // Keep at least 20% of structure value

      // Don't target near recent targets
      // Legendary divergence: the adaptive tier's nuclear strategy is a
      // sustained bombardment funded by the recurring war chest. The faithful
      // 1M penalty made one strike poison its own cluster until the 600-tick
      // memory expired, capping throughput at roughly one launch per window;
      // a lighter penalty keeps re-strikes on damaged-but-valuable clusters
      // scorable while still preferring fresh ground.
      const recentPenalty = isLegendaryDifficulty(currentDifficulty())
        ? 250_000
        : 1_000_000;
      tileValue -= this.recentlySentNukes
        .filter(([_tick, recentTile, recentNukeType]) => {
          const recentInnerRadius = this.game
            .config()
            .nukeMagnitudes(recentNukeType).inner;
          const distSquared = this.game.euclideanDistSquared(tile, recentTile);
          return distSquared <= recentInnerRadius * recentInnerRadius;
        })
        .map((_) => recentPenalty)
        .reduce((prev, cur) => prev + cur, 0);

      // Don't blast our own (or a permanent teammate's) structures: the src
      // scorer only rewards enemy value, so without this a border/hydro tile
      // that also erases our silo/SAM/city cluster can win the sweep.
      tileValue -= this.friendlyFirePenalty(tile, magnitude);

      return tileValue;
    }

    // ── sendNuke — NationNukeBehavior.ts:750 (now async; addExecution → build menu)
    // DIVERGENCE G1: the client build intent cannot carry NukeExecution's
    // `waitTicks`. Delayed salvo entries are therefore retained locally and the
    // same intent is emitted on its due game tick by processPendingNukeLaunches.
    // This preserves arrival staggering without blocking the bot or depending
    // on real-time timers, which would drift when game speed changes.
    async sendNuke(tile, nukeType, targetPlayer, waitTicks = 0, salvo = null) {
      const delay = Math.max(0, Math.ceil(Number(waitTicks) || 0));
      if (delay > 0) {
        return this.queueDelayedNukeLaunch(
          tile,
          nukeType,
          targetPlayer,
          delay,
          salvo,
        );
      }
      const buildable = await this.probeNukeBuildable(tile, nukeType);
      if (!this.nukeBuildableCanLaunch(buildable)) return false;
      // The worker probe yields long enough for diplomacy or the target's state
      // to change. Re-run the complete attack policy immediately before
      // actuation so a stale candidate cannot launch after becoming invalid.
      if (!this.isValidNukeTarget(targetPlayer) || !this.isValidNukeDestination(tile)) return false;
      // DIVERGENCE: a worker await can invalidate the previously clear route.
      // Planned saturation atoms retain their intentional interception budget.
      if (isLegendaryDifficulty(currentDifficulty()) && !salvo) {
        const spawnTile = this.nukeSpawn(nukeType, tile);
        if (spawnTile === false || this.isTrajectoryInterceptableBySam(spawnTile, tile)) return false;
      }
      // DIVERGENCE: the source can change while the worker prices this shot.
      const liveFlight = salvo && typeof this.player.units === "function"
        ? this.getAvailableSiloEntries(this.player.units(UNIT.MissileSilo), tile, new Set())[0]?.flightTicks
        : undefined;
      if (!this.emitNukeBuildable(buildable, tile, salvo)) return false;
      if (Number.isFinite(liveFlight)) salvo.flightTicks = liveFlight;
      await this.rememberSuccessfulNukeLaunch(tile, nukeType, targetPlayer);
      return true;
    }

    queueDelayedNukeLaunch(tile, nukeType, targetPlayer, delay, salvo = null) {
      if (!this.isValidNukeTarget(targetPlayer) || !this.isValidNukeDestination(tile)) return false;
      this._pendingNukeLaunches.push({
        dueTick: Number(this.game.ticks()) + delay,
        tile,
        nukeType,
        targetPlayer,
        // Null for ordinary waitTicks launches (behavior unchanged); fireSamSalvo
        // attaches its plan metadata so the salvo can be re-validated before
        // each due bomb fires (see samSalvoStillViable).
        salvo:
          salvo === null || salvo === undefined ? null : { ...salvo },
      });
      return true;
    }

    async probeNukeBuildable(tile, nukeType) {
      const buildables = await withTimeout(
        this.player.buildables(tile, [nukeType]),
        WORKER_TIMEOUT_MS,
        null,
      );
      return Array.isArray(buildables)
        ? buildables.find((buildable) => buildable.type === nukeType) ?? null
        : null;
    }

    nukeBuildableCanLaunch(buildable) {
      return Boolean(
        buildable &&
        buildable.canBuild !== false &&
        this.player.gold() >= buildable.cost,
      );
    }

    emitNukeBuildable(buildable, tile, salvo = null) {
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") return false;
      // The bot's trajectory forecasts use directionUp: true. BuildMenu reads
      // the shared manual toggle synchronously when constructing the intent.
      const uiState = buildMenu.uiState;
      const previousDirection = uiState?.rocketDirectionUp;
      if (uiState) uiState.rocketDirectionUp = true;
      try {
        return sendAutoBotBuildOrUpgrade(
          buildMenu,
          buildable,
          tile,
          this.game,
          this.player,
          salvo ?? true,
        );
      } finally {
        if (uiState) uiState.rocketDirectionUp = previousDirection;
      }
    }

    async rememberSuccessfulNukeLaunch(tile, nukeType, targetPlayer) {
      // Mirror src state updates only AFTER a successful fire (src does these
      // unconditionally because addExecution can't "fail"; on the client the build
      // can be rejected, so we gate them on the successful probe+emit above).
      this.recentlySentNukes.push([this.game.ticks(), tile, nukeType]);
      await this.updateNukePerceivedCost(nukeType);
      // Releases the structure planner's first-Atom war chest: the reserve
      // exists only so the launcher's first shot can actually be funded.
      state.nukeFirstLaunchDone = true;
      state.stats.nukes++;
      setLastAction(tr("☢️ Launch") + " " + nukeType, "nuke");
      this.emojiBehavior.maybeSendEmoji(targetPlayer, EMOJI_NUKE);
    }

    async updateNukePerceivedCost(nukeType) {
      if (nukeType === UNIT.AtomBomb) {
        this.atomBombsLaunched++;
        // Increase perceived cost by 50% each time to simulate saving up for a MIRV
        // (higher than hydro to make atom bombs less attractive for the lategame)
        if (this.atomBombPerceivedCost === null) {
          this.atomBombPerceivedCost = await this.cost(UNIT.AtomBomb);
        }
        this.atomBombPerceivedCost =
          (this.atomBombPerceivedCost * 150n) / 100n;
      } else if (nukeType === UNIT.HydrogenBomb) {
        this.hydrogenBombsLaunched++;
        // Increase perceived cost by 25% each time to simulate saving up for a MIRV
        if (this.hydrogenBombPerceivedCost === null) {
          this.hydrogenBombPerceivedCost = await this.cost(UNIT.HydrogenBomb);
        }
        this.hydrogenBombPerceivedCost =
          (this.hydrogenBombPerceivedCost * 125n) / 100n;
      }
    }

    hasPendingNukeLaunches() {
      return this._pendingNukeLaunches.length > 0;
    }

    salvoAwaitingNativeReceipts(salvo) {
      return salvo?.salvoId != null && typeof autoBotBuildPendingNukes === "function" &&
        autoBotBuildPendingNukes(this.game, this.player).some((record) => record.salvoId === salvo.salvoId);
    }

    async processPendingNukeLaunches() {
      if (!this.hasPendingNukeLaunches()) return false;
      const now = Number(this.game.ticks());
      // DIVERGENCE: only a prior-pass prefix blocks today's validated batch.
      const awaitingSalvoIds = new Set(typeof autoBotBuildPendingNukes === "function"
        ? autoBotBuildPendingNukes(this.game, this.player).map((record) => record.salvoId).filter((id) => id != null)
        : []);
      // Before firing a due SAM-overwhelm bomb, re-validate the whole salvo
      // against the live enemy SAM layout (see samSalvoStillViable): a salvo
      // that can no longer penetrate — or whose target SAM is already rubble —
      // drops its entire remaining chain (due + future entries) instead of
      // wasting gold one intercepted atom at a time.
      const abortedSalvoIds = this.getAbortedSalvoIds(now, awaitingSalvoIds);
      const remaining = [];
      // DIVERGENCE: a queued head still owns the next closest-silo slot.
      const blockedSalvoIds = new Set();
      let launched = false;
      let sendsThisTick = 0;
      for (const pending of this._pendingNukeLaunches) {
        // Target loss/alliance changes cancel future entries immediately too.
        if (!this.isValidNukeTarget(pending.targetPlayer) ||
            !this.isValidNukeDestination(pending.tile)) continue;
        if (pending.salvo && abortedSalvoIds.has(pending.salvo.salvoId)) {
          continue;
        }
        if (pending.dueTick > now || (pending.salvo && blockedSalvoIds.has(pending.salvo.salvoId))) {
          if (pending.dueTick <= now) pending.dueTick = now + 1;
          remaining.push(pending);
          if (pending.salvo) blockedSalvoIds.add(pending.salvo.salvoId);
          continue;
        }
        const outcome = await this.firePendingNukeLaunch(
          pending, sendsThisTick, awaitingSalvoIds.has(pending.salvo?.salvoId),
        );
        if (outcome === "fired") {
          launched = true;
          sendsThisTick += 1;
        } else if (outcome === "retry") {
          pending.dueTick = now + 1;
          remaining.push(pending);
          if (pending.salvo) blockedSalvoIds.add(pending.salvo.salvoId);
        }
      }
      const kept =
        abortedSalvoIds.size > 0
          ? remaining.filter(
              (pending) =>
                !pending.salvo || !abortedSalvoIds.has(pending.salvo.salvoId),
            )
          : remaining;
      this._pendingNukeLaunches = kept;
      if (
        kept.length === 0 &&
        state.nukeWantSlots?.pendingLaunches === true
      ) {
        state.nukeWantSlots = null;
      }
      return launched;
    }

    /**
     * Fires one due delayed launch, subject to the per-tick send budget.
     * Returns "fired", "retry" (re-queued for the next tick), or "drop".
     * Staggered arrivals need several bombs due on the SAME tick (the salvo's
     * filler indexes all wait zero); firing them at once would monopolize the
     * shared intent window and clip the tail launches — stretching the
     * arrival window past the SAM reload and breaking penetration. Spreading
     * the sends across ticks preserves relative arrival order via the
     * next-tick retry, and the salvo's built-in margin absorbs the shift.
     */
    async firePendingNukeLaunch(pending, sendsThisTick,
      awaitingReceipts = this.salvoAwaitingNativeReceipts(pending.salvo)) {
      if (!this.isValidNukeTarget(pending.targetPlayer) ||
          !this.isValidNukeDestination(pending.tile)) return "drop";
      if (sendsThisTick >= PENDING_NUKE_LAUNCHES_PER_TICK) return "retry";
      // DIVERGENCE: unacknowledged prefix shots are not yet visible to SAM accounting.
      if (awaitingReceipts) return "retry";
      const sent = await this.sendNuke(
        pending.tile,
        pending.nukeType,
        pending.targetPlayer,
        0,
        pending.salvo,
      );
      const finisher = state.postSalvoHydrogen;
      if (sent && pending.salvo && finisher?.salvoId === pending.salvo.salvoId &&
          Number.isFinite(pending.salvo.flightTicks)) {
        finisher.dueTick = Math.max(finisher.dueTick,
          Number(this.game.ticks()) + pending.salvo.flightTicks + 5);
      }
      if (sent) return "fired";
      return this.isValidNukeTarget(pending.targetPlayer) &&
        this.isValidNukeDestination(pending.tile) ? "retry" : "drop";
    }

    /**
     * Salvos (by id) that must be aborted before this pass fires anything:
     * only salvos with at least one due entry are re-validated, and each is
     * checked once against its full remaining chain (due + future entries —
     * exactly the bombs the plan can still bring to bear within the window).
     */
    getAbortedSalvoIds(now, awaitingSalvoIds = null) {
      const dueSalvoIds = new Set();
      for (const pending of this._pendingNukeLaunches) {
        if (pending.salvo && pending.dueTick <= now) {
          dueSalvoIds.add(pending.salvo.salvoId);
        }
      }
      if (dueSalvoIds.size === 0) return dueSalvoIds;
      const abortedSalvoIds = new Set();
      for (const salvoId of dueSalvoIds) {
        const entries = this._pendingNukeLaunches.filter(
          (pending) => pending.salvo && pending.salvo.salvoId === salvoId,
        );
        if (awaitingSalvoIds ? awaitingSalvoIds.has(salvoId) : this.salvoAwaitingNativeReceipts(entries[0].salvo)) continue;
        const arrivals = entries.map((entry) => {
          const flight = entry.salvo.flightTicks;
          return Number.isFinite(flight) && flight >= 0
            ? Math.max(now, entry.dueTick) + flight
            : NaN;
        });
        if (!this.samSalvoStillViable(entries[0], entries.length, Math.max(...arrivals))) {
          abortedSalvoIds.add(salvoId);
        }
      }
      return abortedSalvoIds;
    }

    /**
     * Mid-flight re-validation for a SAM-overwhelm salvo (see fireSamSalvo).
     * The salvo was sized against the enemy SAM layout at planning time; before
     * each due bomb fires, re-check that it can still achieve its purpose:
     *   (a) penetration — the enemy SAM levels NOW covering the plan tile must
     *       still be beatable by the bombs the salvo has left (sum of levels +
     *       1), otherwise every further atom is intercepted gold (the enemy may
     *       have built/upgraded a covering SAM after planning);
     *   (b) overkill — if the original target SAM is already destroyed AND no
     *       enemy SAM covers the tile anymore, the remaining bombs would land
     *       on ~zero-value rubble.
     * `remainingInSalvo` is the salvo's pending entry count (due + future).
     * Reuses findEnemySamsCoveringTile, which is already restricted to hostile
     * (non-own, non-permanent-teammate) SAMs.
     */
    samSalvoStillViable(pending, remainingInSalvo, lastArrivalTick = NaN) {
      // Stubs/older call sites may lack the nearby-unit index; without it the
      // salvo cannot be re-validated, so keep the faithful fire-anyway path.
      if (typeof this.game?.nearbyUnits !== "function") return true;
      const salvo = pending.salvo;
      const coveringSams = this.findEnemySamsCoveringTile(salvo.targetTile);
      const coveringLevel = coveringSams.reduce(
        (sum, sam) => sum + sam.level(),
        0,
      );
      const capacity = coveringSams.reduce(
        (sum, sam) => sum + this.samSalvoCapacityAtArrival(sam, lastArrivalTick), 0,
      );
      const liveSpend = capacity + 1 > remainingInSalvo
        ? this.samSalvoLiveCapacitySpend(salvo.targetTile, coveringSams, lastArrivalTick)
        : 0;
      if (capacity - liveSpend + 1 > remainingInSalvo) return false;
      const targetSamId = salvo.targetSamId;
      if (
        (targetSamId !== null && targetSamId !== undefined) &&
        coveringLevel === 0
      ) {
        const targetSams =
          typeof pending.targetPlayer?.units === "function"
            ? pending.targetPlayer.units(UNIT.SAMLauncher)
            : [];
        const targetSamExists =
          coveringSams.some((sam) => String(sam.id()) === String(targetSamId)) ||
          targetSams.some((unit) => String(unit.id()) === String(targetSamId));
        if (!targetSamExists) return false;
      }
      return true;
    }

    samSalvoLiveCapacitySpend(targetTile, coveringSams, lastArrivalTick) {
      const planner = this.structureBehavior;
      const horizon = lastArrivalTick - Number(this.game.ticks());
      const cooldown = Number(this.game.config?.().SAMCooldown?.());
      if (!planner || typeof this.game.units !== "function" ||
          !Number.isFinite(horizon) || horizon < 0 ||
          !Number.isFinite(cooldown) || cooldown <= 0) return 0;
      const sams = this.game.units(UNIT.SAMLauncher).filter((sam) =>
        sam.isActive() &&
        this.isHostileSamIntercept({ unit: sam, distSquared: 0 }));
      const profiles = planner.buildLegendaryFriendlySamProfiles(sams, null, null);
      const routes = this.samSalvoUnclaimedLiveRoutes(targetTile, horizon, profiles);
      if (routes.length === 0) return 0;
      // Unknown completion matters only if the unfinished SAM can intercept
      // these missiles. Remote construction cannot change their assignments.
      const unfinishedIds = new Set(sams.filter((sam) => sam.isUnderConstruction())
        .map((sam) => sam.id()));
      if (routes.some((route) => route.samOptions.some((option) =>
        unfinishedIds.has(profiles[option.samIndex]?.id)))) return 0;
      const schedule = legendaryMissileDefenseSchedule({
        routes, samProfiles: profiles, samCooldownTicks: cooldown, marginTicks: 0,
      });
      // Only credit a complete, engine-order-compatible forecast. An unknown
      // path or ambiguous assignment must not turn a cancelled shot into a bet.
      if (!schedule.fullyDefended) return 0;
      const coveringIds = new Set(coveringSams.map((sam) => sam.id()));
      return schedule.missiles.filter((missile) =>
        coveringIds.has(profiles[missile.samIndex]?.id) &&
        missile.samFireTick + cooldown > horizon).length;
    }

    samSalvoUnclaimedLiveRoutes(targetTile, horizon, profiles) {
      const claimed = new Set(this.game.units(UNIT.SAMMissile)
        .filter((missile) => missile.isActive())
        .map((missile) => missile.targetUnit()?.id()));
      const routes = [];
      for (const missile of this.player.units?.(UNIT.AtomBomb) ?? []) {
        if (!missile.isActive() || missile.targetTile() !== targetTile ||
            claimed.has(missile.id())) continue;
        const motion = this.structureBehavior.legendaryActiveMissileMotion(missile, missile.tile());
        if (!motion || motion.impactTick > horizon) continue;
        routes.push(this.structureBehavior.legendaryBuildMissileRoute({
          ...motion, targetTile, weapon: UNIT.AtomBomb, id: `salvo-live:${missile.id()}`,
        }, profiles));
      }
      return routes;
    }

    samSalvoCapacityAtArrival(sam, lastArrivalTick) {
      const cooldown = Number(this.game.config?.().SAMCooldown?.());
      const queue = sam.missileTimerQueue?.();
      if (!Number.isFinite(lastArrivalTick) || !Number.isFinite(cooldown) || !Array.isArray(queue)) {
        return sam.level();
      }
      // Count a cooling slot as available if it can reload before the latest
      // remaining arrival. Unknown timing retains the full-capacity fallback.
      const unavailable = queue.filter((firedAt) =>
        Number.isFinite(firedAt) && firedAt + cooldown > lastArrivalTick).length;
      return Math.max(0, sam.level() - unavailable);
    }

    /**
     * On Impossible difficulty, when no good nuke target is available (score <= 0),
     * attempt to destroy enemy SAMs by overwhelming them with atom bombs.
     * A SAM of level N can intercept N nukes before going on cooldown,
     * so we need N+1 bombs to destroy it (accounting for all covering SAMs).
     */
    // ── maybeDestroyEnemySam — NationNukeBehavior.ts:780 (now async) ──────────
    getAvailableSiloEntries(silos, targetTile, coveringSamIds) {
      if (silos.length === 0) return [];
      const speed = this.game.config().defaultNukeSpeed();
      const projected = typeof autoBotBuildNukeSlots === "function"
        ? autoBotBuildNukeSlots(this.game, this.player) : null;
      const entries = silos.map((silo) => {
        // DIVERGENCE: retained client views can change during the async price probe.
        if (silo.isActive?.() === false || silo.isUnderConstruction?.() === true) return null;
        const slots = projected
          ? projected.get(String(silo.id())) ?? 0 : silo.level() - silo.missileTimerQueue().length;
        if (slots <= 0) return null;
        const pathFinder = UniversalPathFinding.Parabola(this.game, {
          increment: speed, distanceBasedHeight: true, directionUp: true,
        });
        const trajectory = pathFinder.findPath(silo.tile(), targetTile) ?? [];
        if (trajectory.length === 0) return null;
        return {
          silo, slots, flightTicks: trajectory.length,
          interceptable: this.isTrajectoryInterceptableBySam(
            silo.tile(), targetTile, coveringSamIds,
          ),
        };
      }).filter(Boolean);
      return entries.sort((a, b) =>
        this.game.manhattanDist(a.silo.tile(), targetTile) -
        this.game.manhattanDist(b.silo.tile(), targetTile));
    }

    createSamLaunchSequence(siloEntries) {
      return siloEntries.flatMap((entry) =>
        Array.from({ length: entry.slots }, () => ({
          flightTicks: entry.flightTicks,
          interceptable: entry.interceptable,
        })));
    }

    findSamArrivalWindow(bombs, maxSpread) {
      const sorted = [...bombs].sort((a, b) => a.flightTicks - b.flightTicks);
      let bestStart = 0;
      let bestCount = 0;
      for (let start = 0; start < sorted.length; start++) {
        let end = start;
        while (end < sorted.length &&
          sorted[end].flightTicks - sorted[start].flightTicks <= maxSpread) end++;
        if (end - start > bestCount) {
          bestStart = start;
          bestCount = end - start;
        }
      }
      return sorted.slice(bestStart, bestStart + bestCount);
    }

    createSamOverwhelmPlan(targetSam, silos) {
      const targetTile = this.samSalvoAimTile(targetSam);
      const coveringSams = this.findEnemySamsCoveringTile(targetTile);
      const coveringSamIds = new Set(coveringSams.map((sam) => sam.id()));
      const coveringSamLevels = coveringSams.reduce(
        (sum, sam) => sum + sam.level(),
        0,
      );
      const bombsNeeded = coveringSamLevels + 1;
      const totalBombs = bombsNeeded + Math.floor(bombsNeeded / 5);
      const siloEntries = this.getAvailableSiloEntries(silos, targetTile, coveringSamIds);
      const launchSequence = this.createSamLaunchSequence(siloEntries);
      const unblocked = launchSequence
        .map((bomb, index) => ({ ...bomb, index }))
        .filter((bomb) => !bomb.interceptable);
      const maxSpread = Math.floor(this.game.config().SAMCooldown() / 2);
      const window = this.findSamArrivalWindow(unblocked, maxSpread);
      return {
        targetTile, coveringSamIds, coveringSamLevels, targetSamId: targetSam.id(),
        totalBombs, siloEntries,
        launchSequence, maxSpread, window,
        capacityMissing: unblocked.length < totalBombs || window.length < totalBombs,
      };
    }

    // Aim-point selection for anti-SAM salvos: the bomb must still destroy
    // the SAM (kept inside the outer blast radius), but among the tiles that
    // qualify, prefer the one whose blast also covers the most enemy
    // structure value — measured bombs routinely landed on structure-poor
    // tiles and converted a full salvo into zero destroyed gold.
    samSalvoAimTile(targetSam) {
      const magnitude = this.game.config().nukeMagnitudes(UNIT.AtomBomb);
      const radius = Number(magnitude?.outer) || 0;
      if (radius <= 0) return targetSam.tile();
      const samTile = targetSam.tile();
      const enemy = targetSam.owner?.();
      const structures = unitsOfTypes(enemy);
      if (structures.length === 0) return samTile;
      const samX = this.game.x(samTile);
      const samY = this.game.y(samTile);
      let bestTile = samTile;
      // DIVERGENCE: monetary enemy value needs a monetary friendly-loss penalty.
      let bestValue = this.blastStructureValue(samTile, structures, radius) -
        this.friendlyFirePenalty(samTile, magnitude, true);
      for (const structure of structures) {
        const tile = structure.tile?.();
        if (tile == null) continue;
        const dx = this.game.x(tile) - samX;
        const dy = this.game.y(tile) - samY;
        const candidateX = Math.round(samX + dx * 0.5);
        const candidateY = Math.round(samY + dy * 0.5);
        if (!this.game.isValidCoord(candidateX, candidateY)) continue;
        const candidate = this.game.ref(candidateX, candidateY);
        // The SAM itself must remain inside the blast or the salvo loses
        // its anti-SAM purpose.
        if (this.game.euclideanDistSquared(candidate, samTile) >= radius * radius) continue;
        const value = this.blastStructureValue(candidate, structures, radius) -
          this.friendlyFirePenalty(candidate, magnitude, true);
        if (value > bestValue) {
          bestValue = value;
          bestTile = candidate;
        }
      }
      return bestTile;
    }

    blastStructureValue(tile, structures, radius) {
      // NukeExecution destroys structures strictly inside the circular blast.
      return structures
        .filter((unit) => this.game.euclideanDistSquared(tile, unit.tile()) < radius * radius)
        .reduce((sum, unit) => sum + this.nukeStructureValue(unit), 0);
    }

    getSiloIdOrNull(entry) {
      { return String(entry.silo.id()); }
    }

    rememberFailedSamTarget(plan) {
      const unblockedSiloIds = plan.siloEntries
        .filter((entry) => !entry.interceptable)
        .map((entry) => this.getSiloIdOrNull(entry))
        .filter((id) => id !== null);
      const failedTarget = {
        targetTile: plan.targetTile,
        coveringSamIds: plan.coveringSamIds,
        totalBombs: plan.totalBombs,
        requiredSiloCapacity: plan.totalBombs,
        unblockedSiloIds,
      };
      state.nukeWantSlots = {
        need: plan.totalBombs,
        targetSamId: plan.targetSamId,
        at: this.game.ticks(),
        targetTile: plan.targetTile,
        unblockedSiloIds,
      };
      return failedTarget;
    }

    getSamSalvo(plan) {
      const selected = [...plan.window]
        .sort((a, b) => a.index - b.index)
        .slice(0, plan.totalBombs);
      const bombsToFire = selected[selected.length - 1].index + 1;
      const selectedIndexes = new Set(selected.map((bomb) => bomb.index));
      const firstArrival = Math.min(...selected.map((bomb) => bomb.flightTicks));
      const stagger = Math.max(1, Math.floor(plan.maxSpread / plan.totalBombs));
      let selectedIndex = 0;
      let lastWait = 0;
      const waits = Array.from({ length: bombsToFire }, (_, index) => {
        // DIVERGENCE: local emission delays must preserve closest-silo slot order.
        if (selectedIndexes.has(index)) {
          const arrival = firstArrival + selectedIndex++ * stagger;
          lastWait = Math.max(lastWait, arrival - plan.launchSequence[index].flightTicks);
        }
        return lastWait;
      });
      return { bombsToFire, waits };
    }

    async fireSamSalvo(plan, nukeTarget, atomCost) {
      const salvo = this.getSamSalvo(plan);
      const flightTicks = salvo.waits.map((_, index) => plan.launchSequence?.[index]?.flightTicks);
      if (this.player.gold() < atomCost * BigInt(salvo.bombsToFire)) return false;
      if (state.nukeWantSlots === null || state.nukeWantSlots === undefined) {
        const unblockedSiloIds = (plan.siloEntries || [])
          .filter((entry) => !entry.interceptable)
          .map((entry) => this.getSiloIdOrNull(entry))
          .filter((id) => id !== null);
        state.nukeWantSlots = {
          need: Number(plan.totalBombs ?? salvo.bombsToFire),
          targetSamId: plan.targetSamId,
          at: this.game.ticks(),
          targetTile: plan.targetTile,
          unblockedSiloIds,
          pendingLaunches: false,
        };
      }
      // Plan metadata carried by every delayed entry of this salvo so
      // processPendingNukeLaunches can re-validate the enemy SAM layout
      // mid-flight (see samSalvoStillViable). plannedCoveringLevel records the
      // hostile SAM level sum the bomb count was sized against at planning time.
      this._nextSalvoId = (this._nextSalvoId || 0) + 1;
      const salvoPlan = {
        salvoId: this._nextSalvoId,
        plannedCoveringLevel: Number(plan.coveringSamLevels ?? 0),
        targetTile: plan.targetTile,
        targetSamId: plan.targetSamId ?? null,
      };
      try {
        let queued = false;
        for (let i = 0; i < salvo.bombsToFire; i++) {
          const metadata = { ...salvoPlan, flightTicks: flightTicks[i] };
          const wait = Math.max(salvo.waits[i], queued ? 1 : 0);
          const sent = await this.sendNuke(
            plan.targetTile, UNIT.AtomBomb, nukeTarget, wait, metadata,
          );
          flightTicks[i] = metadata.flightTicks;
          // A stale worker probe or exhausted intent budget is retryable.
          // Retain this bomb and the tail; the queue rechecks target and SAMs.
          if (!sent && !this.queueDelayedNukeLaunch(
            plan.targetTile, UNIT.AtomBomb, nukeTarget,
            Math.max(1, wait), metadata,
          )) return false;
          queued = queued || wait > 0 || !sent;
        }
      } finally {
        if (this.hasPendingNukeLaunches()) {
          state.nukeWantSlots.pendingLaunches = true;
        } else {
          state.nukeWantSlots = null;
        }
      }
      // Hydrogen finisher (goal rule): the saturating atoms exist to strip the
      // covering SAMs; once the last bomb lands the target cluster is bare, so
      // schedule the 5MM follow-up for the next nuclear decision pass.
      const lastArrivalTick = this.game.ticks() +
        Math.max(
          0,
          ...salvo.waits.map((wait, index) => {
            const flight = flightTicks[index] ?? 0;
            return wait + flight;
          }),
        );
      state.postSalvoHydrogen = {
        salvoId: salvoPlan.salvoId,
        targetTile: plan.targetTile,
        dueTick: lastArrivalTick + 5,
        targetSmallID: nukeTarget.smallID?.() ?? null,
      };
      return true;
    }

    // Fire the scheduled Hydrogen finisher once the saturating salvo has
    // landed and the target's covering SAMs are actually gone (a salvaged
    // interception aborts the finisher — it would fly into live coverage,
    // exactly the waste the salvo discipline forbids).
    async maybeFirePostSalvoHydrogen() {
      const pending = state.postSalvoHydrogen;
      if (!pending) return false;
      const target = this.postSalvoHydrogenTarget(pending);
      if (target === null) {
        state.postSalvoHydrogen = null;
        return false;
      }
      // DIVERGENCE: silo staggering or retries can outlive the planned deadline.
      let atomsInFlight = false;
      for (const atom of this.player.units?.(UNIT.AtomBomb) ?? []) {
        if (atom.isActive?.() === false || atom.targetTile?.() !== pending.targetTile) continue;
        atomsInFlight = true;
        const motion = this.structureBehavior?.legendaryActiveMissileMotion?.(atom, atom.tile?.());
        if (Number.isFinite(motion?.impactTick) && motion.impactTick >= 0) {
          pending.dueTick = Math.max(pending.dueTick,
            Number(this.game.ticks()) + motion.impactTick + 5);
        }
      }
      if (atomsInFlight) return false;
      if (this.game.ticks() < pending.dueTick) return false;
      // A delayed/retried atom must land before its finisher is evaluated.
      if (pending.salvoId !== undefined && this._pendingNukeLaunches.some(
        (launch) => launch.salvo?.salvoId === pending.salvoId,
      )) return false;
      const config = this.game.config();
      // LEGENDARY DIVERGENCE (2026-10-04, pre-declared in
      // docs/legendary-metric-ceilings.md): the pending finisher used to be
      // discarded before its probes, so a transient blocker — full silo
      // queues, a temporarily unaffordable treasury, regrown SAM coverage, or
      // a failed buildability dispatch — permanently lost a scheduled
      // follow-up. Retain it through transient failures; only permanent
      // conditions (disabled bombs, invalid target/destination) or a successful
      // dispatch clear it. Every firing gate is unchanged.
      if (config.isUnitDisabled(UNIT.HydrogenBomb)) {
        state.postSalvoHydrogen = null;
        return false;
      }
      const hydroCost = await this.getPerceivedNukeCost(UNIT.HydrogenBomb);
      if (this.postSalvoHydrogenTarget(pending) === null) {
        state.postSalvoHydrogen = null;
        return false;
      }
      if (this.player.gold() < hydroCost) return false;
      const silos = this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction());
      if (silos.length === 0) return false;
      if (this.findEnemySamsCoveringTile(pending.targetTile).length > 0) {
        return false;
      }
      // LEGENDARY DIVERGENCE (2026-10-08, pre-declared in
      // docs/legendary-metric-ceilings.md): the finisher was the one nuclear
      // dispatch path that never priced friendly-fire. Its blast circle is
      // the largest (Hydrogen outer), and offensive-reach silo placement
      // deliberately moves our silos toward hostile centers, so a blind
      // dispatch could erase our own forward structures. Apply the same
      // monetary geometry as the anti-SAM aim selector: fire only when the
      // remaining enemy structure value inside the blast covers the friendly
      // replacement loss (blastStructureValue vs friendlyFirePenalty).
      // Rejection holds the finisher instead of clearing it: the geometry
      // can change (own structures inside the circle are destroyed by the
      // enemy, enemy structures grow), and the integrated Baikal receipt
      // showed a permanently cleared finisher cascading into worse survival.
      // Degenerate magnitudes (config shims without nukeMagnitudes) price
      // every blast as empty, so the finisher safely holds instead of firing
      // unpriced.
      const magnitude = config.nukeMagnitudes?.(UNIT.HydrogenBomb) ?? {
        inner: 0,
        outer: 0,
      };
      // Enemy MissileSilos count through mirvCapableSiloPriority: finishing a
      // silo cluster that can already pay for a MIRV is worth trading own
      // replacement loss for, matching the tile scorer's counterforce logic.
      const enemyValue = unitsOfTypes(target)
        .filter((unit) =>
          this.game.euclideanDistSquared(pending.targetTile, unit.tile()) <
            magnitude.outer * magnitude.outer)
        .reduce((sum, unit) =>
          sum + this.nukeStructureValue(unit) * this.mirvCapableSiloPriority(unit), 0);
      const friendlyPenalty = this.friendlyFirePenalty(
        pending.targetTile,
        magnitude,
        true,
      );
      if (enemyValue - friendlyPenalty <= 0) {
        return false;
      }
      const sent = await this.sendNuke(
        pending.targetTile,
        UNIT.HydrogenBomb,
        target,
      );
      if (sent || this.postSalvoHydrogenTarget(pending) === null) {
        state.postSalvoHydrogen = null;
      }
      return sent;
    }

    postSalvoHydrogenTarget(pending) {
      if (pending.targetSmallID === null) return null;
      const target = this.game.players().find(
        (player) => player.smallID?.() === pending.targetSmallID,
      );
      if (!target || !this.isValidNukeTarget(target) ||
          !this.isValidNukeDestination(pending.targetTile)) return null;
      return target;
    }

    async maybeDestroyEnemySam(nukeTarget, allowHeldAtoms = false) {
      if (this.game.config().isUnitDisabled(UNIT.AtomBomb)) return;
      if (this.player.units(UNIT.AtomBomb).length > 0 && !allowHeldAtoms) return;
      const enemySams = nukeTarget.units(UNIT.SAMLauncher);
      if (enemySams.length === 0) {
        state.nukeWantSlots = null;
        return;
      }
      const silos = this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction());
      if (silos.length === 0) return;
      const atomCost = await this.cost(UNIT.AtomBomb);
      let failedTarget = null;
      for (const targetSam of enemySams.slice().sort((a, b) => a.level() - b.level())) {
        const plan = this.createSamOverwhelmPlan(targetSam, silos);
        if (plan.capacityMissing) {
          // DIVERGENCE (lever v2): the starvation release only spends held
          // atoms on an immediately fireable salvo; when capacity is missing
          // it must not reshape construction (baikal receipt: failed-plan
          // silo upgrades tripled the atom arsenal and lost a winning game).
          if (!allowHeldAtoms) failedTarget ??= this.rememberFailedSamTarget(plan);
          continue;
        }
        if (await this.fireSamSalvo(plan, nukeTarget, atomCost)) return;
      }
      if (failedTarget) await this.maybeUpgradeHelpfulSilo(failedTarget);
    }

    /**
     * Find all enemy SAMs whose range covers a given tile.
     */
    // ── findEnemySamsCoveringTile — NationNukeBehavior.ts:1010 ────────────────
    findEnemySamsCoveringTile(tile) {
      const nearbySams = this.game.nearbyUnits(
        tile,
        this.game.config().maxSamRange(),
        UNIT.SAMLauncher,
      );

      const result = [];
      for (const sam of nearbySams) {
        const owner = sam.unit.owner();
        if (
          (owner && owner.smallID && owner.smallID() === this.player.smallID()) ||
          playersArePermanentTeammates(this.player, owner)
        ) {
          continue;
        }
        const range = this.game.config().samRange(sam.unit.level());
        if (sam.distSquared <= range * range) {
          result.push(sam.unit);
        }
      }
      return result;
    }

    /**
     * Upgrade a missile silo that would actually have helped the failed
     * overwhelm attempt: trajectory to the failed target is not blocked by
     * non-covering enemy SAMs, and the silo is below the upgrade cap. Among
     * those, picks the one best protected by our own SAMs.
     */
    getRouteEligibleSilos(failedTarget) {
      const coveringSamIds = failedTarget.coveringSamIds ?? new Set(
        this.findEnemySamsCoveringTile(failedTarget.targetTile).map((sam) => sam.id()),
      );
      return this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction())
        .filter((silo) => !this.isTrajectoryInterceptableBySam(
          silo.tile(), failedTarget.targetTile, coveringSamIds,
        ));
    }

    hasUsefulSiloUpgradeCapacity(silos, failedTarget) {
      const requiredSiloCapacity = Math.max(
        Number(failedTarget.requiredSiloCapacity ?? failedTarget.totalBombs),
        Number(failedTarget.totalBombs),
      );
      const currentSiloCapacity = silos.reduce(
        (sum, silo) => sum + Math.max(1, Number(silo.level() || 1)),
        0,
      );
      const maxCapacity = silos.length * MAX_NATION_SILO_UPGRADE_LEVEL;
      return currentSiloCapacity < requiredSiloCapacity && maxCapacity >= requiredSiloCapacity;
    }

    getPreferredHelpfulSilos(silos, failedTarget) {
      const preferredIds = new Set(
        Array.isArray(failedTarget.unblockedSiloIds)
          ? failedTarget.unblockedSiloIds.map(String)
          : [],
      );
      const preferredSilos = silos.filter((silo) => {
        if (preferredIds.size === 0) return true;
        { return preferredIds.has(String(silo.id())); }
      });
      return preferredSilos.length > 0 ? preferredSilos : silos;
    }

    getSiloProtection(silo, sams) {
      return sams.reduce((protection, sam) => {
          const range = this.game.config().samRange(sam.level());
          const distance = this.game.euclideanDistSquared(silo.tile(), sam.tile());
          return distance <= range * range ? protection + sam.level() : protection;
      }, 0);
    }

    findBestProtectedSilo(silos) {
      const sams = this.player.units(UNIT.SAMLauncher);
      return silos
        .filter((silo) => silo.level() < MAX_NATION_SILO_UPGRADE_LEVEL)
        .map((silo) => ({ silo, protection: this.getSiloProtection(silo, sams) }))
        .sort((a, b) => b.protection - a.protection)[0]?.silo ?? null;
    }

    async actuateSiloUpgrade(silo) {
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(silo.tile(), [UNIT.MissileSilo]),
          WORKER_TIMEOUT_MS, null,
        );
      }
      const buildable = Array.isArray(buildables)
        ? buildables.find((entry) => entry.type === UNIT.MissileSilo)
        : null;
      if (!buildable || buildable.canUpgrade === false) return false;
      const buildMenu = getBuildMenu();
      if (typeof buildMenu?.sendBuildOrUpgrade !== "function") return false;
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(tr("☢️ Upgrade silo"), "build");
      return true;
    }

    // ── maybeUpgradeHelpfulSilo — NationNukeBehavior.ts:1037 (now async) ──────
    async maybeUpgradeHelpfulSilo(failedTarget) {
      const eligible = this.getRouteEligibleSilos(failedTarget);
      if (eligible.length === 0) return false;
      if (!this.hasUsefulSiloUpgradeCapacity(eligible, failedTarget)) return false;
      // DIVERGENCE: shared construction policy owns reserve and live-demand checks.
      if (state.settings.winFixes === true && this.structureBehavior) {
        return this.structureBehavior.maybeUpgradeSiloForNukeDemand(eligible);
      }
      const preferred = this.getPreferredHelpfulSilos(eligible, failedTarget);
      const bestSilo = this.findBestProtectedSilo(preferred);
      return bestSilo ? this.actuateSiloUpgrade(bestSilo) : false;
    }

    // ── cost — NationNukeBehavior.ts:1100 ─────────────────────────────────────
    // DIVERGENCE C1: src reads `this.game.unitInfo(type).cost(this.game, this.player)`.
    // The gameApi `game` does NOT expose unitInfo, and the nuke cost fn calls
    // game.stats() (numNukesLaunched etc.) which the client GameView does NOT
    // expose. We read the live price from a buildables probe on an owned tile (the
    // nuke price is global, so any owned tile returns it). Mirrors mirvBehavior.cost.
    // Returns a BigInt (gold). Cached per-tick-ish to avoid re-probing repeatedly.
    async cost(type) {
      // Per-tick memo: src cost() is a pure deterministic calc returning the same
      // value within a tick; here it's an async probe, so cache by type+tick to
      // avoid redundant worker round-trips (getPerceivedNukeCost calls cost() up to
      // ~4× per nuke type). The cached VALUE is identical to a fresh probe — this is
      // a behavior-neutral optimization, not a strategy change.
      const tick = this.game.ticks();
      if (this._costCacheTick !== tick) {
        this._costCacheTick = tick;
        this._costCache = new Map();
      }
      if (this._costCache.has(type)) return this._costCache.get(type);

      const border = this.player.borderTiles();
      const tile =
        border && border.size > 0 ? border.values().next().value : null;
      if (tile === null || tile === undefined) return 0n;
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(tile, [type]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      const bu = Array.isArray(buildables)
        ? buildables.find((b) => b.type === type)
        : null;
      const c = bu && bu.cost !== undefined && bu.cost !== null ? bu.cost : 0n;
      this._costCache.set(type, c);
      return c;
    }

    // ── nukeSpawn — mirrors PlayerImpl.nukeSpawn (PlayerImpl.ts:1233), the silo
    //    snap that player.canBuild(nukeType, tile) returns for AtomBomb/HydrogenBomb.
    // DIVERGENCE B1: src calls `this.player.canBuild(nukeType, tile)` to (a) gate
    // buildability and (b) get the launch silo tile for the trajectory check. The
    // client canBuild is async (buildables probe), so we split it: this SYNC helper
    // returns the silo the nuke would fly from — the closest by Manhattan distance
    // among silos that are active, not in cooldown, and not under construction
    // (exactly src nukeSpawn's findClosestBy criteria) — or `false` if none. The
    // async canBuild gate (incl. spawn-immunity / team teammate-structure guards
    // src's nukeSpawn also applies) is enforced separately in probeCanBuildNuke for
    // the FINAL chosen tile. This keeps the trajectory check faithful (same launch
    // silo canBuild would have snapped to) without an await in the inner scoring loop.
    // DIVERGENCE: pending intents use projected native capacity.
    // ponytail: retain readiness outside dispatch until partial-slot policy passes Baikal.
    nukeSpawn(nukeType, targetTile) {
      const silos = this.player.units(UNIT.MissileSilo);
      const projected = typeof autoBotBuildNukeSlots === "function"
        ? autoBotBuildNukeSlots(this.game, this.player) : null;
      let best = false;
      let bestDist = Infinity;
      for (const silo of silos) {
        if (silo.isActive && silo.isActive() === false) continue;
        if (silo.isUnderConstruction()) continue;
        if (projected) {
          if ((projected.get(String(silo.id())) ?? 0) <= 0) continue;
        } else if (typeof silo.ticksLeftInCooldown === "function" && silo.ticksLeftInCooldown() > 0) {
          continue;
        }
        const d = this.game.manhattanDist(silo.tile(), targetTile);
        if (d < bestDist) {
          bestDist = d;
          best = silo.tile();
        }
      }
      return best;
    }

    // probeCanBuildNuke — the deferred async canBuild gate (DIVERGENCE B1). Probes
    // buildables(tile, [nukeType]) and returns whether the nuke can be built there
    // (canBuild !== false). This is the SAME gate src's player.canBuild applies,
    // just async. (Affordability is checked separately in sendNuke.)
    async probeCanBuildNuke(tile, nukeType) {
      let buildables;
      {
        buildables = await withTimeout(
          this.player.buildables(tile, [nukeType]),
          WORKER_TIMEOUT_MS,
          null,
        );
      }
      const bu = Array.isArray(buildables)
        ? buildables.find((b) => b.type === nukeType)
        : null;
      return bu !== null && bu !== undefined && bu.canBuild !== false;
    }
  }
