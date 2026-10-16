// Auto-Bot — NukeBehavior: a faithful 1:1 port of the in-game Nation nuclear AI
// (src/core/execution/nation/NationNukeBehavior.ts). The most sophisticated
// behavior: target selection (retaliation, FFA crown, high-density, team), per-
// tile nuke scoring (level-weighted structures, SAM penalties, silo-distance
// penalty, recent-nuke memory), parabolic-trajectory SAM-interception checks, and
// the SAM-overwhelm saturation salvo planner. The upstream path is preserved
// apart from its mechanical API substitutions and the explicitly marked
// DIVERGENCEs below.
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
  // Remember a live hostile launch long enough to answer a silo rebuilt after
  // the first counterstrike; refreshed observations extend the same window.
  const COUNTERFORCE_THREAT_TTL_TICKS = 900;
  // Per-tick cap on delayed nuke launches (see processPendingNukeLaunches):
  // spreads same-tick salvo sends across ticks so the shared intent window
  // cannot clip a salvo's tail and stretch its arrival window.
  const PENDING_NUKE_LAUNCHES_PER_TICK = 3;
  // Upstream 34a8fe723: minimum share of a blast that must hit enemy land
  // (not water, fallout or unowned land), and the score bonus for a blast
  // that hits nothing but enemy land.
  const MIN_BLAST_COVERAGE = {
    [UNIT.AtomBomb]: 0.25,
    // Below this, an atom bomb on solid enemy land destroys more tiles per gold
    [UNIT.HydrogenBomb]: 0.4,
  };
  const FULL_BLAST_COVERAGE_VALUE = 50_000;

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

  async function nukeFinalLaunchCheckPasses(check, buildable) {
    return !check || check(buildable);
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

  // NukeExecution destroys every tile at distance squared <= outer².
  function isInsideNukeDestructionRadius(game, center, tile, outerRadius) {
    return game.euclideanDistSquared(center, tile) <= outerRadius * outerRadius;
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

