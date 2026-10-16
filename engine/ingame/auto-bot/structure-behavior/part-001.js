// Auto-Bot — StructureBehavior: a faithful 1:1 port of the in-game Nation
// economy/structure AI (src/core/execution/nation/NationStructureBehavior.ts).
// For Easy through Impossible it decides which structure to build each build-tick
// (Port → Factory → SAMLauncher → MissileSilo, City as fallback), with the special first-structure
// cases (high-starting-gold SAM, high-nation-density port/factory), the
// high-gold structure-placement cooldown, the team post-save-up on/off phase,
// defense-post placement under land attack, perceived-cost save-up inflation,
// the upgrade-vs-build density gate, and ALL the per-type placement value
// functions (city/factory/missileSilo/port/samLauncher) including the rail
// connectivity scoring. Those four modes preserve every branch, ratio, constant,
// probability, strategy order and call order. Legendary is the explicit adaptive
// construction exception described in legendaryPlanner.js and README.md. The
// mechanical API substitutions are mandated by PORT-CONTRACT.md:
//   - DIFFICULTY: src reads the lobby Nation difficulty
//     (`this.game.config().gameConfig().difficulty`); the bot REPLICATES a
//     user-chosen difficulty, so every such read becomes `currentDifficulty()`.
//   - UnitType.X → UNIT.X.
//   - PLAYER/OWNER IDENTITY: src compares players/owners with `===`; the client
//     wraps players fresh each tick, so identity compares become `.smallID()`
//     compares (and TerraNullius/unowned is guarded via `isPlayer()`/null).
//   - ASYNC + ACTUATION: the client has no synchronous canBuild/addExecution /
//     UpgradeStructureExecution. Builds and upgrades go through the build menu
//     (`getBuildMenu().sendBuildOrUpgrade(...)`) and require an `await
//     player.buildables(tile,[type])` worker probe, so the methods that place a
//     structure (handleStructures / doHandleStructures / maybeSpawnStructure /
//     tryBuildDefensePost / maybeUpgradeStructure / structureSpawnTile) BECOME
//     async (nationExecution awaits handleStructures). Worker reads are wrapped
//     in withTimeout(p, WORKER_TIMEOUT_MS, fallback).
//   - RANK-THEN-PROBE (PORT-CONTRACT §Async #1): src `structureSpawnTile`
//     interleaves the value function with a SYNC `player.canBuild` inside a loop
//     over ~25 candidates, short-circuiting on the first valid best-value tile.
//     The client canBuild is async, so we score ALL candidates SYNC by the src
//     value function, sort DESC, then await buildables down the ranked list and
//     take the FIRST whose returned BuildableUnit has `.canBuild !== false` and
//     `.canUpgrade === false`. The client menu prioritizes upgrades in a hybrid
//     descriptor, so only the latter is a construction candidate. Same candidate
//     set + value fn → same winner (the highest-value build-only tile).
//   - COST: src reads `unitInfo(type).cost(game, player)`. That cost fn is built
//     on `costWrapper`, whose `numUnits = Σ min(unitsOwned(type), unitsConstructed
//     (type))`. The client GameView does NOT expose unitsOwned/unitsConstructed
//     with core semantics (the gameApi wrapper's unitsOwned is a plain built-count
//     and unitsConstructed is a boolean), so calling the passthrough cost fn would
//     compute min(count, 0|1) — wrong, and would also corrupt cityCount/targetCount/
//     owned-multipliers (strategy, not just cost) once anything is upgraded. We
//     therefore reproduce each cost FORMULA from src/core/configuration/Config.ts
//     directly as BigInt, with `numUnits = ownedLevels(type)`. The costWrapper
//     counts min(unitsOwned, unitsConstructed) where recordUnitConstructed
//     fires on EVERY build AND upgrade (PlayerImpl.ts:1414,1496-1501), so for
//     each live unit constructed == 1 + (level - 1) == level and the level sum
//     reproduces the min exactly — except captured units (untrackable client
//     side, cost would be lower; documented DIVERGENCE, conservative). Config
//     scalar reads (samRange/defaultSamRange/
//     trainGold/trainStationMin|MaxRange/nukeMagnitudes/startingGold/isUnitDisabled)
//     go through the `game.config()` passthrough unchanged.
//   - DATA SHIMS (the two genuinely-missing datasets): `game.sharedWaterComponents`
//     and `game.railNetwork()` are not client-available. They are reconstructed as
//     faithfully as the client allows. WATER: gameApi builds a full-resolution
//     water union-find ONCE per game (cached) and applies core's exact
//     SharedWaterCache predicate (ocean always shared, lakes shared iff a tradeable
//     non-bot other player is on the same component); the only divergence is
//     sub-minimap channel granularity (core labels on a downsampled minimap the
//     client does not expose). RAIL: in the EXTENSION the real rail tiles come from
//     frameData().railroadState → EXACT rail-connected clusters; in the headless
//     harness (no frameData) it falls back to a train-station proximity union-find.
//     They affect placement SCORING only — everything else is faithful.
//
// Loaded with the other behavior modules (after portutil/gameApi), before
// nationExecution (which constructs `new StructureBehavior(random, game, player)`).

"use strict";

  // ===========================================================================
  // Module-level constants — verbatim from NationStructureBehavior.ts.
  // ===========================================================================

  const LEGENDARY_LANDLOCKED_ARSENAL_BACKSTOP_TICK = 3000;

  /** SAM launcher ratio per city, keyed by difficulty */
  const SAM_RATIO_BY_DIFFICULTY = {
    [Difficulty.Easy]: 0,
    [Difficulty.Medium]: 0,
    [Difficulty.Hard]: 0,
    [Difficulty.Impossible]: 0,
    [Difficulty.Legendary]: 0,
  };

  /**
   * Returns structure ratios relative to city count, adjusted by difficulty.
   * Cities are always prioritized and built first.
   */
  function getStructureRatios(difficulty) {
    // Ports print money: one mid-range trade ship returns most of a Port's
    // price, and the nuclear kit (Silo 1M + Atom 750k) is unreachable on the
    // flat 1k/s base income. NOTE: the adaptive construction lane calls this
    // with the hardcoded Difficulty.Legendary (not an engine enum member, so
    // undefined), which self-compares true here — the 1.25 ratio IS the
    // validated baseline for that lane; collapsing it to 0.75 starves the
    // port economy (measured team-basket win -> loss, 2026-09-11).
    const portRatioPerCity =
      difficulty === Difficulty.Legendary ? 1.25 : 0.75;
    return {
      [UNIT.Port]: {
        ratioPerCity: portRatioPerCity,
        perceivedCostIncreasePerOwned: 1,
      },
      [UNIT.Factory]: {
        ratioPerCity: 0.75,
        perceivedCostIncreasePerOwned: 1,
      },
      [UNIT.SAMLauncher]: {
        ratioPerCity: SAM_RATIO_BY_DIFFICULTY[difficulty],
        perceivedCostIncreasePerOwned: 0.3,
      },
      [UNIT.MissileSilo]: {
        ratioPerCity: 0.2,
        perceivedCostIncreasePerOwned: 1,
      },
    };
  }

  /** Perceived cost increase percentage per city owned */
  const CITY_PERCEIVED_COST_INCREASE_PER_OWNED = 1;

  /** Factory ratio multiplier when the nation has coastal tiles */
  const FACTORY_COASTAL_RATIO_MULTIPLIER = 0.33;
  // Two early Ports fund trade income and the warship fleet while the
  // shared Port/Factory price ladder still prices them at 125-250k.
  const LEGENDARY_MIN_OPEN_PORTS = 2;

  /** Maximum number of missile silos a nation will build */
  const MAX_MISSILE_SILOS = 3;
  const SAM_PROTECTABLE_STRUCTURE_TYPES = [
    UNIT.City,
    UNIT.Factory,
    UNIT.Port,
    UNIT.MissileSilo,
  ];

  /**
   * A hostile silo threat becomes an H-bomb/SAM priority once one enemy's
   * built-silo level sum reaches this value. A level-1 silo therefore counts
   * as one, not as two.
   *
   * Hydrogen bombs require only one completed Silo: their 5M-gold cost is the
   * gate, not a Silo level. Two Silo slots on one player (two level-one Silos
   * or one level-two Silo) are an immediate full-SAM emergency. Keep this
   * per-player rather than aggregating all enemies: the user-facing threat is
   * a single opponent's launch capability.
   */
  const HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD = 1;

  // A completed external Silo can turn its first launch into an H-bomb before
  // a low-level launcher has time to reach parity. Once that capability exists,
  // finish the best protective SAM to the top of the current upgrade ladder
  // before discretionary economy or offense spending.
  const HYDROGEN_SAM_MINIMUM_READY_LEVEL = 5;

  /** Any built hostile silo can already launch a missile at our structures. */
  const HOSTILE_SILO_SAM_COVERAGE_LEVEL_SUM_THRESHOLD = 1;

