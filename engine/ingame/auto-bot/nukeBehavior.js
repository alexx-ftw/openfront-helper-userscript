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

  // Structures group — src/core/game/Game.ts:374 (Structures.types). Defined
  // module-local under a unique name (no `Structures` global exists in the bundle)
  // so `nukeTarget.units(...NUKE_STRUCTURES_TYPES)` mirrors `units(...Structures.types)`.
  const NUKE_STRUCTURES_TYPES = [
    UNIT.City,
    UNIT.DefensePost,
    UNIT.SAMLauncher,
    UNIT.MissileSilo,
    UNIT.Port,
    UNIT.Factory,
  ];

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
    }

    canConsiderNukes(silos) {
      const config = this.game.config();
      if (silos.length === 0 || config.isUnitDisabled(UNIT.MissileSilo)) return false;
      return !config.isUnitDisabled(UNIT.AtomBomb) ||
        !config.isUnitDisabled(UNIT.HydrogenBomb);
    }

    isValidNukeTarget(target) {
      if (target === null || target.type() === PlayerType.Bot) return false;
      if (this.player.isOnSameTeam(target)) return false;
      return this.attackBehavior.shouldAttack(target) !== false;
    }

    async selectAffordableNuke() {
      const hydroCost = await this.getPerceivedNukeCost(UNIT.HydrogenBomb);
      const atomCost = await this.getPerceivedNukeCost(UNIT.AtomBomb);
      const config = this.game.config();
      if (!config.isUnitDisabled(UNIT.HydrogenBomb) && this.player.gold() >= hydroCost) {
        return { type: UNIT.HydrogenBomb, cost: hydroCost };
      }
      const atomAllowed = !config.isUnitDisabled(UNIT.AtomBomb) &&
        (!this.isHydroNation || this.isUnderHeavyAttack());
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
      return !isAtLeastHardDifficulty(difficulty) ||
        !this.isTrajectoryInterceptableBySam(spawnTile, tile);
    }

    async collectNukeCandidates(target, type, silos, difficulty) {
      await withTimeout(
        this.game.ensureBorderTiles(target), WORKER_TIMEOUT_MS, null,
      );
      const structures = target.units(...NUKE_STRUCTURES_TYPES);
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
      const silos = this.player.units(UNIT.MissileSilo);
      if (!this.canConsiderNukes(silos)) return;
      const target = this.findBestNukeTarget();
      if (!this.isValidNukeTarget(target)) return;
      const selectedNuke = await this.selectAffordableNuke();
      if (!selectedNuke) return;
      if (this.shouldDeferNukeForEconomy(target, selectedNuke.cost)) return;
      const difficulty = currentDifficulty();
      const candidates = await this.collectNukeCandidates(
        target, selectedNuke.type, silos, difficulty,
      );
      const best = await this.selectBuildableNukeCandidate(candidates, selectedNuke.type);

      if (best && (best.value > 0 || !isAtLeastHardDifficulty(difficulty))) {
        await this.sendNuke(best.tile, selectedNuke.type, target);
      } else if (isAtLeastHardDifficulty(difficulty)) {
        await this.maybeDestroyEnemySam(target);
      }
    }

    /**
     * Offensive nukes yield to the shared economy/defense reserve. A heavy
     * assault or direct retaliation keeps the emergency path responsive;
     * ordinary target selection follows the surplus policy.
     */
    shouldDeferNukeForEconomy(nukeTarget, nukeCost) {
      if (this.hasActiveMaritimeInvasion()) return true;
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
      if (this.player.isFriendly(crown)) return null;
      return crown.numTilesOwned() / availableTiles > 0.5 ? crown : null;
    }

    findAllyNukeTarget() {
      // Player.allies() contains only explicit, breakable alliances and omits
      // permanent teammates. Nuclear coordination must use the engine's
      // canonical friendly relation so team pings receive the same support.
      for (const ally of this.game.players()) {
        if (ally.smallID() === this.player.smallID()) continue;
        if (ally.isAlive?.() === false) continue;
        if (this.player.isFriendly(ally) !== true) continue;
        const target = ally.targets().find((candidate) =>
          candidate.smallID() !== this.player.smallID() &&
          !this.player.isFriendly(candidate));
        if (target) return target;
      }
      return null;
    }

    findHostileNukeTarget() {
      const myMaxTroops = this.game.config().maxTroops(this.player);
      for (const relation of this.player.allRelationsSorted()) {
        if (relation.relation !== Relation.Hostile) continue;
        const other = relation.player;
        if (this.player.isFriendly(other)) continue;
        if (myMaxTroops >= this.game.config().maxTroops(other) * 2) continue;
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

      return null;
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
        if (this.player.isFriendly(other)) continue;
        const tilesOwned = other.numTilesOwned();
        if (tilesOwned === 0) continue;
        const structures = other.units(...NUKE_STRUCTURES_TYPES);
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
        if (!this.player.isFriendly(secondPlace)) {
          return secondPlace;
        }
      }

      // Don't target ourselves or allies
      if (
        firstPlace.smallID() === this.player.smallID() ||
        this.player.isFriendly(firstPlace)
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
        (p) => !this.player.isFriendly(p),
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
          !this.player.isFriendly(nukeOwner)
        ) {
          continue;
        }

        // Get the target tile of the teammate's nuke
        const targetTile = nuke.targetTile();
        if (!targetTile) continue;

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
      if (ownSam || this.player.isFriendly(owner)) return false;
      if (excludedSamIds?.has(sam.unit.id())) return false;
      const rangeSquared = this.game.config().samRange(sam.unit.level()) ** 2;
      return sam.distSquared <= rangeSquared;
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

      for (let i = 0; i < trajectory.length; i++) {
        const inUntargetableRange = untargetable.start !== -1 &&
          untargetable.end !== -1 && i >= untargetable.start && i < untargetable.end;
        if (inUntargetableRange) continue;
        const tile = trajectory[i];
        const nearbySams = this.game.nearbyUnits(
          tile,
          this.game.config().maxSamRange(),
          UNIT.SAMLauncher,
        );
        for (const sam of nearbySams) {
          if (this.isHostileSamIntercept(sam, excludedSamIds)) return true;
        }
      }

      return false;
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
            !this.player.isFriendly(owner)))
      ) {
        return true;
      }
      // On Easy & Medium, only allow tiles owned by the target player (=> nuke away from the border) to reduce nuke usage
      return false;
    }

    // ── nukeTileScore — NationNukeBehavior.ts:650 ─────────────────────────────
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
              return 50_000 * level;
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
      tileValue -= this.recentlySentNukes
        .filter(([_tick, recentTile, recentNukeType]) => {
          const recentInnerRadius = this.game
            .config()
            .nukeMagnitudes(recentNukeType).inner;
          const distSquared = this.game.euclideanDistSquared(tile, recentTile);
          return distSquared <= recentInnerRadius * recentInnerRadius;
        })
        .map((_) => 1_000_000)
        .reduce((prev, cur) => prev + cur, 0);

      return tileValue;
    }

    // ── sendNuke — NationNukeBehavior.ts:750 (now async; addExecution → build menu)
    // DIVERGENCE G1: the src NukeExecution accepts a `waitTicks` stagger so the
    // saturation salvo's bombs arrive spread across the SAM cooldown window. That
    // stagger is NOT expressible through the client build-menu intent (it fires the
    // nuke immediately, no per-bomb delay), so we DROP waitTicks — all salvo bombs
    // are fired with no stagger. The salvo SIZE / target / silo-pick order is still
    // faithful; only the arrival spread is lost. We keep the `waitTicks` parameter
    // for signature parity but never act on it.
    async sendNuke(tile, nukeType, targetPlayer, waitTicks = 0) {
      const tick = this.game.ticks();

      // Affordability + actuation via the buildables probe + build menu. Probe the
      // nuke BuildableUnit at the target tile, confirm canBuild and gold (BigInt),
      // then fire through the build menu aimed at the target tile.
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
      if (bu === null || bu === undefined) return;
      if (!(bu.canBuild !== false && this.player.gold() >= bu.cost)) return;

      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") return;
      if (!sendAutoBotBuildOrUpgrade(buildMenu, bu, tile, this.game, this.player)) return;

      // Mirror src state updates only AFTER a successful fire (src does these
      // unconditionally because addExecution can't "fail"; on the client the build
      // can be rejected, so we gate them on the successful probe+emit above).
      this.recentlySentNukes.push([tick, tile, nukeType]);
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

      // LOGGING (light) — on a nuke fire.
      state.stats.nukes++;
      setLastAction(tr("☢️ Launch") + " " + nukeType, "nuke");

      this.emojiBehavior.maybeSendEmoji(targetPlayer, EMOJI_NUKE);
    }

    /**
     * On Impossible difficulty, when no good nuke target is available (score <= 0),
     * attempt to destroy enemy SAMs by overwhelming them with atom bombs.
     * A SAM of level N can intercept N nukes before going on cooldown,
     * so we need N+1 bombs to destroy it (accounting for all covering SAMs).
     */
    // ── maybeDestroyEnemySam — NationNukeBehavior.ts:780 (now async) ──────────
    getAvailableSiloEntries(silos, targetTile, coveringSamIds) {
      const speed = this.game.config().defaultNukeSpeed();
      const entries = silos.map((silo) => {
        const slots = silo.level() - silo.missileTimerQueue().length;
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
      const targetTile = targetSam.tile();
      const coveringSams = this.findEnemySamsCoveringTile(targetTile);
      const coveringSamIds = new Set(coveringSams.map((sam) => sam.id()));
      const bombsNeeded = coveringSams.reduce((sum, sam) => sum + sam.level(), 0) + 1;
      const totalBombs = bombsNeeded + Math.floor(bombsNeeded / 5);
      const siloEntries = this.getAvailableSiloEntries(silos, targetTile, coveringSamIds);
      const launchSequence = this.createSamLaunchSequence(siloEntries);
      const unblocked = launchSequence
        .map((bomb, index) => ({ ...bomb, index }))
        .filter((bomb) => !bomb.interceptable);
      const maxSpread = Math.floor(this.game.config().SAMCooldown() / 2);
      const window = this.findSamArrivalWindow(unblocked, maxSpread);
      return {
        targetTile, coveringSamIds, totalBombs, siloEntries,
        launchSequence, maxSpread, window,
        capacityMissing: unblocked.length < totalBombs || window.length < totalBombs,
      };
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
      const waits = Array.from({ length: bombsToFire }, (_, index) => {
        if (!selectedIndexes.has(index)) return 0;
        const arrival = firstArrival + selectedIndex++ * stagger;
        return Math.max(0, arrival - plan.launchSequence[index].flightTicks);
      });
      return { bombsToFire, waits };
    }

    async fireSamSalvo(plan, nukeTarget, atomCost) {
      const salvo = this.getSamSalvo(plan);
      if (this.player.gold() < atomCost * BigInt(salvo.bombsToFire)) return false;
      for (let i = 0; i < salvo.bombsToFire; i++) {
        await this.sendNuke(plan.targetTile, UNIT.AtomBomb, nukeTarget, salvo.waits[i]);
      }
      state.nukeWantSlots = null;
      return true;
    }

    async maybeDestroyEnemySam(nukeTarget) {
      if (this.game.config().isUnitDisabled(UNIT.AtomBomb)) return;
      if (this.player.units(UNIT.AtomBomb).length > 0) return;
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
          failedTarget ??= this.rememberFailedSamTarget(plan);
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
          this.player.isFriendly(owner)
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
      return this.player.units(UNIT.MissileSilo)
        .filter((silo) => !silo.isUnderConstruction())
        .filter((silo) => !this.isTrajectoryInterceptableBySam(
          silo.tile(), failedTarget.targetTile, failedTarget.coveringSamIds,
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
    // The unit wrapper exposes `ticksLeftInCooldown()` (proxy for `!isInCooldown()`:
    // not in cooldown ⇔ ticksLeftInCooldown() === 0) but not `isInCooldown()` itself.
    nukeSpawn(nukeType, targetTile) {
      const silos = this.player.units(UNIT.MissileSilo);
      let best = false;
      let bestDist = Infinity;
      for (const silo of silos) {
        if (silo.isActive && silo.isActive() === false) continue;
        if (silo.isUnderConstruction()) continue;
        // !isInCooldown() — proxy via ticksLeftInCooldown() === 0 when available.
        if (
          typeof silo.ticksLeftInCooldown === "function" &&
          silo.ticksLeftInCooldown() > 0
        ) {
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
