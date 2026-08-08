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
//     directly as BigInt, with `numUnits = ownedLevels(type)` (see DIVERGENCE on
//     ownedLevels below). Config scalar reads (samRange/defaultSamRange/
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
    return {
      [UNIT.Port]: { ratioPerCity: 0.75, perceivedCostIncreasePerOwned: 1 },
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

  /** OpenFront's SAM upgrade ladder currently tops out at level five. */
  const HYDROGEN_SAM_MAX_UPGRADE_LEVEL = 5;

  /** MirvExecution scatters candidate destinations across this map radius. */
  const MIRV_CARRIER_TARGET_RADIUS = 1500;

  /** Ratio per city used for the first missile silo so nations start nuking earlier */
  const FIRST_MISSILE_SILO_RATIO = 0.2;

  /** If we have more than this many structures per tiles, prefer upgrading over building */
  const UPGRADE_DENSITY_THRESHOLD = 1 / 1500;

  /**
   * Maximum raw tiles sampled and ranked for one structure, matching upstream.
   * Coverage-priority SAM placement resolves legality locally so this remains
   * a bounded CPU search rather than 25 worker requests.
   */
  const STRUCTURE_PLACEMENT_CANDIDATE_LIMIT = 25;

  // Economy construction used to spend the entire 25-probe budget on a random
  // sample before the resumable exhaustive scan could run.  A healthy worker
  // response therefore still caused a visible 150ms+ stall.  Keep the rest of
  // the tick's budget for the existing deterministic scan, which resumes on
  // later decisions and is the only path allowed to prove exhaustion.
  const ECONOMIC_INITIAL_PLACEMENT_CANDIDATE_LIMIT = 12;

  /**
   * The mandatory hostile-silo SAM path can wake up as soon as an enemy reaches
   * the 1.5M-gold trigger. Preserve upstream's 25-candidate search, reconstruct
   * its structure legality locally, then use one authoritative worker request.
   * A small sequential fallback covers the rare case where the public snapshot
   * changes between local selection and worker validation.
   */
  const HOSTILE_SILO_SAM_AUTHORITATIVE_FALLBACK_LIMIT = 3;
  const HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS =
    typeof WORKER_TIMEOUT_MS === "number" ? WORKER_TIMEOUT_MS : 2500;

  /** Mirrors PlayerImpl.validStructureSpawnTiles(). */
  const LOCAL_STRUCTURE_SEARCH_RADIUS = 15;

  /** Keep defensive SAM upgrade probes from serially blocking on the worker. */
  const DEFENSIVE_SAM_PROBE_CONCURRENCY = 6;

  /**
   * Keep generic structure probes bounded while allowing normal worker latency.
   * The timeout is the normal worker grace period; bounded batches remove the
   * old serial stall without discarding a healthy-but-slow probe too early.
   */
  const STRUCTURE_PROBE_CONCURRENCY = 4;
  const STRUCTURE_PROBE_TIMEOUT_MS =
    typeof WORKER_TIMEOUT_MS === "number" ? WORKER_TIMEOUT_MS : 2500;

  /** Estimated number of tiles per city equivalent, used when cities are disabled */
  const TILES_PER_CITY_EQUIVALENT = 2000;

  /**
   * When map-wide nation density (nations per land tile) is above this threshold,
   * a nation's very first structure is a port (or factory if no water access)
   */
  const HIGH_NATION_DENSITY_THRESHOLD = 1 / 7500;

  /**
   * Starting-gold threshold above which nations enter the "high-gold" early game:
   * they build a SAM first and wait between structure placements.
   */
  const HIGH_STARTING_GOLD_THRESHOLD = 3_000_000n;

  /** Gold at which a hostile player can afford the first missile silo. */
  const HOSTILE_SILO_GOLD_THRESHOLD = 1_000_000n;

  /**
   * A Silo completes in 100 ticks while a SAM takes 300.  Waiting until an
   * opponent has the full 1M Silo cost starts both constructions together and
   * leaves their Silo ready 200 ticks first.  Reserve and start our interceptor
   * at half the Silo cost so it can finish while they accumulate the remainder.
   */
  const HOSTILE_SAM_TRIGGER_GOLD_THRESHOLD = HOSTILE_SILO_GOLD_THRESHOLD / 2n;

  /** Structures that directly grow the nation's economy. */
  // A City is the first paying destination; once it exists, build the train
  // source before adding another destination Port. This starts a profitable
  // loop sooner and avoids spending the first productive slot on a station
  // that cannot generate train gold by itself.
  const ECONOMIC_STRUCTURE_TYPES = [UNIT.Factory, UNIT.Port, UNIT.City];

  /** Border troop-capacity pressure puts the City before the other economy sites. */
  const CITY_FIRST_ECONOMIC_STRUCTURE_TYPES = [
    UNIT.City,
    UNIT.Factory,
    UNIT.Port,
  ];

  /** Length in ticks of each on/off phase after the team-mode save-up target is first reached */
  const TEAM_POST_SAVE_UP_PHASE_TICKS = 150; // 15s

  /**
   * Incoming land-attack troop count as a fraction of own troops below which the
   * nation does not build defensive structures.
   */
  const UNDER_ATTACK_THREAT_RATIO = 0.35;

  /**
   * A real Nation/Human land push becomes worth saving the next Defense Post
   * for before it reaches the active-post threshold. This is intentionally
   * lower than UNDER_ATTACK_THREAT_RATIO: construction needs time to finish,
   * while a Tribe probe must never freeze the opening economy.
   */
  const PREEMPTIVE_DEFENSE_POST_THREAT_RATIO = 0.1;
  // The Nation execution loop asks for defensive structure work between the
  // main attack decisions as well as on the main decision itself.  Those
  // interstitial calls must keep missile/SAM/land-defense reactions live, but
  // retrying a full ordinary economy placement (and its async buildables
  // probes) every ~16 ticks creates visible Auto-build stalls without gaining
  // a new construction opportunity.  A short, tick-based cooldown keeps the
  // expensive ordinary lane bounded while never delaying the emergency lanes.
  const ORDINARY_STRUCTURE_DECISION_INTERVAL_TICKS = 20;

  /**
   * Do not repeat a failed hostile-Silo SAM placement probe more than once per
   * second of game time. The placement path can otherwise perform 25 sequential
   * async worker probes on every structure decision.
   */
  const HOSTILE_SILO_SAM_RETRY_TICKS = 10;

  /**
   * Minimum time from emergency SAM completion/upgrade to the first incoming
   * missile impact: 0.5 seconds at the engine's 10 ticks per second.
   */
  const LEGENDARY_SAM_IMPACT_MARGIN_TICKS = 5;

  /**
   * Safety guard for pathological gold reserves. A forecast that reaches this
   * cap is marked incomplete and therefore cannot be accepted as defended.
   */
  const LEGENDARY_MAX_FORECAST_MISSILES = 96;

  /**
   * A missile planner only needs representative high-value/clustered targets.
   * The full structure list remains in the context for exposure and placement
   * scoring, while this cap prevents rebuilding a long salvo for every remote
   * low-value structure on large maps.
   */
  const LEGENDARY_MAX_MISSILE_TARGETS = 16;

  /** Non-active forecasts can safely reuse a conservative snapshot briefly. */
  const LEGENDARY_MISSILE_DEFENSE_CONTEXT_BUCKET_TICKS = 3;

  /**
   * Hard / Impossible: one additional defense post is allowed per this fraction
   * of the incoming-to-own-troop ratio.
   */
  const DEFENSE_POST_RATIO_PER_POST = 0.4;
  // Once a strategic invasion already matches our entire field army, releasing
  // an affordable failed Post budget into an unrelated structure can decide the
  // battle before the next placement retry.
  const DEFENSE_POST_HARD_RESERVE_THREAT_RATIO = 1;
  const DEFENSE_POST_FAILED_RETRY_TICKS = 10;

  // NOTE: the OCEAN sentinel (-1) used by sharedWaterComponents now lives in
  // gameApi's water reconstruction (SHARED_OCEAN_SENTINEL); structureBehavior only
  // consumes the resulting Set<number>|null via shimSharedWaterComponents.

  // The set of unit types treated as "structures" — src Structures.types
  // (Game.ts:374): City, DefensePost, SAMLauncher, MissileSilo, Port, Factory.
  const STRUCTURES_TYPES = [
    UNIT.City,
    UNIT.DefensePost,
    UNIT.SAMLauncher,
    UNIT.MissileSilo,
    UNIT.Port,
    UNIT.Factory,
  ];

  // USER GATE (not in src): the popup lets the user disallow auto-building
  // specific structure types. A type is allowed unless explicitly set false.
  function autoBotBuildAllowed(type) {
    const allow = state.settings && state.settings.buildStructures;
    return !allow || allow[type] !== false;
  }

  function profileStructureAsync(profile, name, action) {
    if (typeof autoBotProfileAsyncPhase === "function") {
      return autoBotProfileAsyncPhase(profile, name, action);
    }
    return action();
  }

  function profileStructureSync(profile, name, action) {
    if (typeof autoBotProfileSyncPhase === "function") {
      return autoBotProfileSyncPhase(profile, name, action);
    }
    return action();
  }

  // ===========================================================================
  // §SHIMS — the two genuinely-missing datasets, reconstructed client-side.
  // These are the ONLY approximations; they affect placement SCORING only.
  // ===========================================================================

  // canTrade(a, b) — src PlayerImpl.ts:887. No mutual embargo and different id.
  // (gameApi player exposes hasEmbargoAgainst + id(), so this is exact.)
  function shimCanTrade(a, b) {
    if (a == null || b == null) return false;
    if (a.id() === b.id()) return false;
    return !a.hasEmbargoAgainst(b) && !b.hasEmbargoAgainst(a);
  }

  // sharedWaterComponents(game, player) — src SharedWaterCache + GameImpl.
  // SHAPE returned by src: `Set<number> | null` where null = no coastal/shared
  // water; a present set contains OCEAN_SENTINEL(-1) when touching ocean and lake
  // component-ids that are shared with a tradeable other player.
  //
  // RECONSTRUCTION (gameApi §SHIM-DATA): this now returns a REAL `Set<number>|null`
  // backed by a full-resolution water union-find that gameApi builds ONCE per game
  // (cached — terrain is static). gameApi.sharedWaterComponents reproduces core's
  // SharedWaterCache predicate exactly: ocean is always shared (sentinel -1); a
  // lake component is shared iff another non-bot player on that component's coast
  // can trade with us (no mutual embargo). The component ids remain available
  // to the coastal trade/factory planning logic. Port placement is stricter:
  // randCoastalTileArray only accepts a border tile adjacent to the canonical
  // open-ocean component.
  //
  // EXACT vs APPROXIMATE: the "shared" PREDICATE is exact (same ocean handling,
  // same bot-skip, same canTrade). The only divergence is GRANULARITY: core labels
  // components on a DOWNSAMPLED MINIMAP graph (x/y÷2) that the client does not
  // expose; we union-find at FULL resolution, so a narrow channel the minimap
  // merges (or a strait it splits) can land in a different component. This is
  // strictly better than the old bounded 400-tile BFS.
  function shimSharedWaterComponents(game, player) {
    {
      if (typeof game.sharedWaterComponents === "function") {
        return game.sharedWaterComponents(player);
      }
    }
    return null;
  }

  function shimHasSharedWater(game, player) {
    if (typeof game.hasSharedWater === "function") {
      return game.hasSharedWater(player);
    }
    return shimSharedWaterComponents(game, player) !== null;
  }

  // railNetwork connectivity — src builds a global station→cluster graph
  // (TrainStation/Railroad), then factory/cityValue score a candidate by the
  // distinct rail clusters reachable within [trainStationMinRange,
  // trainStationMaxRange], weighted by trade gold.
  //
  // TWO PATHS (see buildReachableStations):
  //   - EXTENSION (EXACT clusters): the real rail tiles come from
  //     game.railroadState() (GameView.frameData().railroadState — a per-tile
  //     Uint8Array: 0=no rail, nonzero=rail). We flood-fill the actual rail tiles
  //     into connected components, then map each train-station-bearing unit
  //     (hasTrainStation()===true) to the rail component touching its tile. The
  //     rail-component id IS the cluster key → clusters reflect the ACTUAL laid
  //     track, exactly like core (a station with no adjacent rail is isolated /
  //     null-cluster, matching core's singleton-for-scoring).
  //   - HARNESS (proximity APPROXIMATION): when railroadState() is null (the
  //     coreAdapter has no frameData), we fall back to the StationUnionFind below:
  //     union stationed City/Port/Factory units within trainStationMaxRange
  //     euclidean PROXIMITY. This approximates rail connectivity by geometric
  //     reachability; it is outcome-neutral (placement scoring only) and only
  //     runs in the headless harness.
  //
  // The trade-gold WEIGHTS, the [min,max] range gating, and computeConnectivityScore
  // are reproduced VERBATIM in both paths — only HOW clusters are determined changes.
  class StationUnionFind {
    constructor() {
      this.parent = new Map(); // key -> key
    }
    add(key) {
      if (!this.parent.has(key)) this.parent.set(key, key);
    }
    find(key) {
      let root = key;
      while (this.parent.get(root) !== root) root = this.parent.get(root);
      // path-compress
      let cur = key;
      while (this.parent.get(cur) !== root) {
        const next = this.parent.get(cur);
        this.parent.set(cur, root);
        cur = next;
      }
      return root;
    }
    union(a, b) {
      const ra = this.find(a);
      const rb = this.find(b);
      if (ra !== rb) this.parent.set(ra, rb);
    }
  }

  function maritimePortConstructionStatus(ports) {
    const status = { completed: false, underConstruction: false };
    for (const port of ports) {
      {
        if (typeof port?.isUnderConstruction !== "function") {
          status.completed = true;
        } else if (port.isUnderConstruction()) {
          status.underConstruction = true;
        } else {
          status.completed = true;
        }
      }
    }
    return status;
  }

  function safeStructureGameTick(game) {
    {
      return Number(game?.ticks?.());
    }
  }

  function isHostileActiveMissile(player, missile, mySid) {
    if (!missile || missile.isActive?.() === false) return false;
    const owner = missile.owner?.();
    if (!owner || owner.smallID?.() === mySid) return false;
    return !(player.isFriendly(owner) || player.isOnSameTeam(owner));
  }

  function isActiveStructureMissileThreat(missile) {
    return Boolean(missile && missile.isActive?.() !== false);
  }

  class StructureBehavior {
    constructor(random, game, player) {
      this.random = random;
      this.game = game;
      this.player = player;

      // src private fields (NationStructureBehavior.ts:126-135).
      this.reachableStationsCache = null;
      this._sharedWaterComponents = null;
      this.placementsCount = 0;
      this._hasHighStartingGold = null;
      this._postSaveUpStartTick = null;
      this._hostileSiloSamAttemptTick = null;
      this._hostileSiloSamRetryNotBeforeTick = null;
      this._hostilePlayersSnapshotTick = null;
      this._hostilePlayersSnapshot = null;
      this._borderingHostileMaxTroopAdvantageTick = null;
      this._borderingHostileMaxTroopAdvantage = null;
      this._hostileThreatSnapshotTick = null;
      this._hostileThreatSnapshot = null;
      this._hostileSiloCapacitySnapshotTick = null;
      this._hostileSiloCapacitySnapshot = null;
      this._hasCoastalTiles = null;
      this._hasOceanPortTiles = null;
      this._economicExposureBorderTick = null;
      this._economicExposureBorderTiles = null;
      this._missileDefenseSignalTick = null;
      this._missileDefenseSignalCache = null;
      this._activeHostileMissileTick = null;
      this._activeHostileMissileCache = null;
      this._hostileMissileImpactZonesTick = null;
      this._hostileMissileImpactZonesCache = null;
      this._friendlySamUnitsTick = null;
      this._friendlySamUnitsPlayerSid = null;
      this._friendlySamUnitsCache = null;
      this._ownedSamUnitsTick = null;
      this._ownedSamUnitsCache = null;
      // SAM spending stays locked until this nation has observed an actual
      // hostile missile in flight. Once opened, the gate remains open for the
      // rest of the match even after that first missile resolves.
      this._hostileMissileLaunchObserved = false;
      // Full SAM-versus-structure coverage checks are expensive on mature
      // boards. Cache them by their exact geometry, not merely by game tick.
      this._hydrogenStructureCoveragePlanKey = null;
      this._hydrogenStructureCoveragePlanCache = null;
      // Missile placement forecasts are shared by several Legendary and
      // win-fix construction gates. Keep one snapshot per game tick so a
      // single decision cannot rebuild the same trajectory model repeatedly.
      this._missileDefenseContextTick = null;
      this._missileDefenseContextKey = null;
      this._missileDefenseContextCache = null;
      this._missileDefenseEvaluationTick = null;
      this._missileDefenseEvaluationContext = null;
      this._missileDefenseEvaluationCache = null;
      // An authoritative BuildableUnit gives the exact next-upgrade price for
      // a particular SAM level. Reuse that fact only to avoid re-probing while
      // we remain below the known price; once affordable we always ask the
      // worker again before acting.
      this._plannedSamUpgradeCostCache = new Map();
    }

    // The auto-donate module owns the live transport/ownership scan because it
    // also has to protect manual donation paths. Reuse that shared result here
    // so construction, nuke spending, and donations respond to the same
    // invasion snapshot instead of maintaining subtly different detectors.
    incomingMaritimeInvasionSignal() {
      {
        let host = null;
        if (typeof globalThis !== "undefined") host = globalThis;
        if (typeof window !== "undefined") host = window;
        if (
          host &&
          typeof host.__OFH_getIncomingMaritimeTransport === "function"
        ) {
          return host.__OFH_getIncomingMaritimeTransport(this.game, this.player);
        }
        // Compatibility with older page-context bundles that only expose the
        // original detector; current auto-donate.js always provides the
        // transport-only signal above.
        if (
          host &&
          typeof host.__OFH_getIncomingMaritimeInvasion === "function"
        ) {
          return host.__OFH_getIncomingMaritimeInvasion(this.game, this.player);
        }
      }
      return null;
    }

    hasActiveMaritimeInvasion() {
      return this.incomingMaritimeInvasionSignal()?.active === true;
    }

    // WIN-FIX: while an enemy transport is committed to our territory, spend
    // the construction decision on the naval defense chain only: Port first,
    // then Warship in nationExecution. A Port already under construction is
    // treated as the active investment; no second structure is started.
    async prioritizeMaritimeInvasionDefense() {
      const signal = this.incomingMaritimeInvasionSignal();
      if (!signal || signal.active !== true) return false;

      let config;
      {
        config = this.game.config();
      }
      if (!this.maritimeDefenseConstructionEnabled(config)) return false;
      if (!autoBotBuildAllowed(UNIT.Port)) return false;

      let ports;
      {
        ports = this.player.units(UNIT.Port) || [];
      }

      const portStatus = maritimePortConstructionStatus(ports);
      const warships = this.player.units(UNIT.Warship) || [];
      if (warships.length > 0) return false;

      // Keep the economic slot reserved until the Port is ready. Once a
      // Warship exists (including one under construction), ordinary structures
      // must resume even while the transport signal remains active.
      if (portStatus.underConstruction) return true;
      if (portStatus.completed) return true;

      // A Port cannot be produced on a landlocked/closed-water map. Preserve
      // the normal policy in that impossible case rather than freezing every
      // other construction forever.
      if (!this.hasOceanPortTiles()) return false;

      const availableGold = this.spendableConstructionGold();
      const portCost = this.getConstructionCost(UNIT.Port);
      if (availableGold < portCost) return true;

      // If an affordable Port still cannot be emitted (no legal tile, a failed
      // probe, or a missing build surface), do not claim success and starve all
      // other construction indefinitely.
      return this.maybeSpawnStructure(UNIT.Port, { forceNewStructure: true });
    }

    maritimeDefenseConstructionEnabled(config) {
      if (state.settings.features?.warship !== true) return false;
      if (state.settings.warshipAutoSpawn === false) return false;
      if (typeof config.isUnitDisabled !== "function") return true;
      return (
        !config.isUnitDisabled(UNIT.Port) &&
        !config.isUnitDisabled(UNIT.Warship)
      );
    }

    // ── core-semantics owned count (used wherever src uses unitsOwned) ──────────
    // DIVERGENCE: src core `unitsOwned(type)` (PlayerImpl.ts:322) sums LEVELS —
    // each built unit contributes its level, each under-construction unit +1. The
    // gameApi wrapper's unitsOwned is a plain built-count (no level sum) and
    // unitsConstructed is a boolean, so neither reproduces core semantics. We
    // reproduce the core level-sum here and use it for cityCount, the first-
    // structure `=== 0` checks, shouldBuildStructure's owned, getPerceivedCost's
    // owned, and the cost-formula numUnits. (The exact core
    // min(unitsOwned, unitsConstructed) with its cumulative numUnitsConstructed
    // counter is not client-reproducible — that counter persists across deletions;
    // the level-sum is the faithful client approximation, and for a single un-
    // upgraded unit both give the same number.)
    ownedLevels(type) {
      let total = 0;
      for (const u of this.player.units(type)) {
        if (u.isUnderConstruction()) {
          total += 1;
        } else {
          total += u.level();
        }
      }
      return total;
    }

    // handleStructures — NationStructureBehavior.ts:143 (now async).
    async handleStructures(profile = null) {
      this._economicPlacementDecisionBudget = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const legendaryDifficulty = isLegendaryDifficulty();
      const activeMissileSamDecision = await profileStructureAsync(
        profile,
        "structures-active-missile-sam",
        () => this.handleActiveMissileSamMaximumPriority(),
      );
      if (activeMissileSamDecision !== null) return activeMissileSamDecision;

      const hostileSiloSamDecision = await profileStructureAsync(
        profile,
        "structures-hostile-silo-sam",
        () => this.handleHostileSiloSamMaximumPriority(),
      );
      if (hostileSiloSamDecision !== null) return hostileSiloSamDecision;

      if (
        await profileStructureAsync(profile, "structures-immediate-defense", () =>
          this.handleImmediateStructureDefense(legendaryDifficulty))
      ) {
        return true;
      }

      const {
        missileEmergency: legendaryMissileEmergency,
        defenseEmergency: legendaryDefenseEmergency,
      } = this.legendaryDefenseEmergencies(legendaryDifficulty);

      const defensePostDecision = await profileStructureAsync(
        profile,
        "structures-defense-post",
        () => this.handleDefensePostPriority(legendaryMissileEmergency),
      );
      if (defensePostDecision !== null) return defensePostDecision;

      if (
        await profileStructureAsync(profile, "structures-winfix-priorities", () =>
          this.handleWinFixStructurePriorities(legendaryDifficulty))
      ) {
        return true;
      }

      if (await this.handleInitialSiloPriority(profile, legendaryDifficulty)) {
        return true;
      }

      if (this.shouldDeferOrdinaryStructureDecision()) {
        return false;
      }

      // Legendary missile defense is an emergency exception to the ordinary
      // save-up phase so an interceptor upgrade/build can still matter.
      if (!legendaryDefenseEmergency && this.isInPostSaveUpBlockedPhase()) {
        return false;
      }
      const built = await profileStructureAsync(
        profile,
        "structures-ordinary",
        () => this.doHandleStructures(profile),
      );
      if (built) {
        this.placementsCount++;
      }
      return built;
    }

    shouldDeferOrdinaryStructureDecision() {
      const tick = Number(this.game?.ticks?.());
      if (!Number.isFinite(tick)) return false;
      const previous = Number(this._lastOrdinaryStructureDecisionTick);
      if (
        Number.isFinite(previous) &&
        tick >= previous &&
        tick - previous < ORDINARY_STRUCTURE_DECISION_INTERVAL_TICKS
      ) {
        return true;
      }
      this._lastOrdinaryStructureDecisionTick = tick;
      return false;
    }

    async handleActiveMissileSamMaximumPriority() {
      if (!state.settings.winFixes) return null;
      if (!autoBotBuildAllowed(UNIT.SAMLauncher)) return null;
      if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return null;
      const signal = this.missileDefenseSignalSnapshot();
      if (signal?.hasActiveHostileMissile !== true) return null;

      const context = this.activeMissileDefenseContext();
      const evaluation = this.legendaryDefenseEvaluation(context);
      const uncoveredMirvDemands = this.uncoveredActiveMirvDemands(context);
      if (
        (!evaluation.hasThreats || evaluation.fullyDefended) &&
        uncoveredMirvDemands.length === 0
      ) return null;

      // Consolidate first, but only when an upgrade measurably improves the
      // actual trajectory schedule. A distant SAM must not consume gold merely
      // because a missile exists somewhere on the map.
      if (
        evaluation.hasThreats &&
        !evaluation.fullyDefended &&
        (await this.maybeUpgradeMissileDefenseSam(context))
      ) return true;
      if (
        this.activeMissilePendingSamImproves(
          context,
          evaluation,
          uncoveredMirvDemands,
        )
      ) return false;

      // The missile has a fixed deadline. Reserve the whole construction slot
      // until a geometrically useful SAM can be afforded and placed; spending
      // it on a Port/Warship/economy action can make the interception impossible.
      return this.resolveActiveMissileSamFallback(context);
    }

    async resolveActiveMissileSamFallback(context) {
      if (await this.maybeSpawnStructure(UNIT.SAMLauncher, {
        allowPreemptiveSam: true,
        useActualCost: true,
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        missileDefenseContext: context,
        activeMissileDefense: true,
        probeLimit: STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
        probeTimeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        parallelProbeCount: DEFENSIVE_SAM_PROBE_CONCURRENCY,
      })) {
        return true;
      }

      // A trajectory-local placement failure must not hide the broader Silo
      // capacity response. In particular, an already-built level-one SAM may
      // be unable to improve this missile's geometry but still needs to reach
      // the external-Silo target before the next launch. Previously this path
      // returned false here, which starved the level-five upgrade behind every
      // active missile that could not be solved by a new launcher.
      const capacityPlan = this.hydrogenSamProtectionPlan?.();
      if (
        capacityPlan !== null &&
        capacityPlan !== undefined &&
        capacityPlan.targetLevel > capacityPlan.currentLevel &&
        (await this.maybeUpgradePlannedSam(capacityPlan))
      ) {
        return true;
      }
      return false;
    }

    activeMissilePendingSamImproves(
      context,
      currentEvaluation,
      uncoveredMirvDemands = [],
    ) {
      const pendingSams = (this.player.units(UNIT.SAMLauncher) || []).filter(
        (sam) => sam?.isUnderConstruction?.() === true,
      );
      if (pendingSams.length === 0) return false;
      for (const sam of pendingSams) {
        const completionTick = this.pendingSamRemainingConstructionTicks(sam);
        if (
          uncoveredMirvDemands.some((demand) =>
            this.samTileCoversMirvDemand(
              sam.tile?.(),
              demand,
              completionTick,
            ),
          )
        ) return true;
        const nextEvaluation = this.legendaryDefenseEvaluation(context, {
          extraSam: {
            id: `pending:${String(sam.id?.() ?? "sam")}`,
            tile: sam.tile?.(),
            level: Math.max(1, Number(sam.level?.() ?? 1)),
            completionTick,
          },
          completionTick,
        });
        if (
          legendaryDefenseActionImproves(
            currentEvaluation,
            nextEvaluation,
            0,
            0,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    pendingSamRemainingConstructionTicks(sam) {
      const duration = this.legendaryConstructionDuration(UNIT.SAMLauncher);
      const raw = sam?.__src || sam;
      const startTick = Number(
        raw?.state?.constructionStartTick ?? raw?.constructionStartTick,
      );
      const now = Number(this.game.ticks?.());
      if (!Number.isFinite(startTick) || !Number.isFinite(now)) return duration;
      return Math.max(0, duration - Math.max(0, now - startTick));
    }

    activeMissileDefenseContext() {
      // An incoming missile has a fixed trajectory and deadline.  Do not first
      // build the full prospective-silo forecast and then discard it: on a
      // mature board that evaluates every hostile silo/target pair every tick
      // while an active missile needs only its observed trajectory.
      const context = this.legendaryActiveMissileDefenseContext();
      return {
        ...context,
        mirvDemands: this.activeMirvDefenseDemands(),
      };
    }

    async handleHostileSiloSamMaximumPriority() {
      if (!state.settings.winFixes) return null;
      if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return null;
      // A Silo becomes a strategic threat as soon as its construction starts:
      // waiting for it to finish wastes the only reliable SAM construction
      // window.  The placement count intentionally includes structures under
      // construction, while the later capacity/coverage planner still uses
      // completed structures where their actual level matters.
      // A hostile player with the silo trigger gold can place a launcher and
      // fire before a newly-started SAM finishes. The first interceptor must
      // therefore start during that funding window, not only after a Silo is
      // visible on the board. A placed allied/enemy Silo remains the immediate
      // global trigger below.
      const placedSilo = this.hasPlacedSiloOnMap();
      const preemptiveHostileSiloRisk = this.shouldBuildHostileSiloSam();
      if (!placedSilo && !preemptiveHostileSiloRisk) return null;

      if (this.shouldBuildSiloTriggeredSam() || preemptiveHostileSiloRisk) {
        return this.handleTriggeredHostileSiloSam(placedSilo);
      }
      return this.handleBuiltHostileSiloSamUpgrade();
    }

    async handleTriggeredHostileSiloSam(placedSilo) {
      // Try to preempt a soon-affordable hostile launcher, but only a Silo
      // already placed on the board may reserve every construction slot. A
      // forecast alone cannot freeze a poor one-City economy below the first
      // SAM price; it still gets the normal economy action after the failed
      // preemptive SAM attempt.
      if (await this.maybeSpawnHostileSiloSam()) return true;
        // A first launcher may already be built while this trigger remains
        // true.  Do not reserve the entire construction turn for another
        // placement attempt before considering its required interceptor level:
        // that made a completed external Silo strand our only SAM at level 1
        // indefinitely.  An unaffordable upgrade still falls through to the
        // same reserve below, so missile defense keeps its priority.
      if (await this.maybeUpgradeHostileSiloSam()) return true;
        // Preserve the one-income-site bootstrap, then reserve every partial
        // fund for the first SAM. Spending repeatedly on cheaper structures
        // after a Silo appears resets the launcher runway indefinitely.
      return this.shouldReserveTriggeredHostileSiloSamBudget(placedSilo)
        ? false
        : null;
    }

    async handleBuiltHostileSiloSamUpgrade() {
      // Building the first SAM is not enough once a hostile Silo is live: a
      // level-one launcher must immediately be upgraded to the minimum H-bomb
      // ready level. A failed/temporarily unaffordable upgrade reserves this
      // same top-priority slot rather than funding an unrelated structure.
      const hydrogenPlan = this.hydrogenSamProtectionPlan?.();
      if (hydrogenPlan === null || hydrogenPlan === undefined) return null;
      if (hydrogenPlan.targetLevel <= hydrogenPlan.currentLevel) return null;
      return (await this.maybeUpgradePlannedSam(hydrogenPlan, {
        maximumNuclearPriority: true,
      })) ? true : false;
    }

    async maybeUpgradeHostileSiloSam() {
      const hydrogenPlan = this.hydrogenSamProtectionPlan?.();
      if (hydrogenPlan === null || hydrogenPlan === undefined) return false;
      if (hydrogenPlan.targetLevel <= hydrogenPlan.currentLevel) return false;
      return this.maybeUpgradePlannedSam(hydrogenPlan, {
        maximumNuclearPriority: true,
      });
    }

    shouldReserveTriggeredHostileSiloSamBudget(placedSilo) {
      return (
        placedSilo &&
        this.shouldReserveHostileSiloSamBudget()
      );
    }

    async handleImmediateStructureDefense(legendaryDifficulty) {
      if (!state.settings.winFixes) return false;
      if (await this.prioritizeMaritimeInvasionDefense()) return true;
      // Before ordinary pacing, upgrade an existing SAM when one level is
      // enough to intercept an incoming missile. Legendary retains its own
      // adaptive defense phase.
      return (
        !legendaryDifficulty && (await this.maybeUpgradeMissileDefenseSam())
      );
    }

    async handleDefensePostPriority(legendaryMissileEmergency) {
      // Active land defense comes before routine SAM coverage/parity and
      // offensive silo work. A concrete missile emergency still wins.
      if (legendaryMissileEmergency) return null;
      // Border proximity and an opponent's total army are not an attack. Spending
      // economic gold on that proxy produced preventive Posts while the frontier
      // was quiet. Authorize a Post only from live incoming land attacks; the
      // active threat object is reused for placement and coverage demand.
      const difficulty = currentDifficulty();
      const activeThreat = this.defensePostThreat(difficulty);
      if (activeThreat === null) return null;
      if (this.game.config().isUnitDisabled(UNIT.DefensePost)) return null;
      const hardReserve = this.shouldHardReserveFailedDefensePost(activeThreat);
      if (hardReserve && this.shouldDeferHardDefensePostRetry()) return false;
      if (await this.tryBuildDefensePost(activeThreat)) return true;

      // Save the slot only while gold is the missing requirement. If the post
      // is affordable but no legal tile was found, a mild attack may continue
      // into productive construction. An army-sized Nation/Human invasion keeps
      // the hard reserve so a Port or other unrelated build cannot consume the
      // next bounded placement retry.
      if (
        !this.canAffordDefensePost() || hardReserve
      ) return false;
      return null;
    }

    shouldHardReserveFailedDefensePost(threat) {
      return (
        Number(threat?.ratio) >= DEFENSE_POST_HARD_RESERVE_THREAT_RATIO &&
        threat.landAttacks.some((attack) => this.isStrategicLandAttack(attack))
      );
    }

    shouldDeferHardDefensePostRetry() {
      const tick = Number(this.game.ticks?.());
      if (!Number.isFinite(tick)) return false;
      const lastFailure = Number(this._lastHardDefensePostPlacementFailureTick);
      if (
        Number.isFinite(lastFailure) &&
        tick >= lastFailure &&
        tick - lastFailure < DEFENSE_POST_FAILED_RETRY_TICKS
      ) return true;
      this._lastHardDefensePostPlacementFailureTick = tick;
      return false;
    }

    async handleWinFixStructurePriorities(legendaryDifficulty) {
      if (!state.settings.winFixes) return false;
      // The coverage plan upgrades an existing useful SAM whenever increased
      // range can cover the structure set. It asks for another physical site
      // only when geometry proves that leveling cannot close the gap.
      if (await this.maybeEnsureHydrogenStructureCoverage()) return true;
      if (await this.maybeUpgradeHydrogenProtectionSam()) return true;
      if (await this.maybeUpgradeSiloForNukeDemand()) return true;
      if (legendaryDifficulty) return false;
      if (await this.maybeSpawnHostileSiloSam()) return true;
      if (await this.maybeUpgradeSamForSiloParity()) return true;
      if (!this.shouldSpawnSamForParity()) return false;
      return this.maybeSpawnStructure(
        UNIT.SAMLauncher,
        this.shouldBuildHostileSiloSam()
          ? this.hostileSiloSamPlacementOptions()
          : {},
      );
    }

    shouldSpawnSamForParity() {
      if (this.samLevelParityGap() <= 0) return false;
      if (!this.shouldBuildHostileSiloSam()) return true;
      return (
        !this.hostileSiloSamAttemptedThisTick() &&
        !this.hostileSiloSamActionBlocked()
      );
    }

    hasPriorStructureForDefensePost() {
      if (this.placementsCount > 0) return true;
      {
        return STRUCTURES_TYPES.some(
          (type) =>
            type !== UNIT.DefensePost &&
            (this.player.units(type) || []).length > 0,
        );
      }
    }

    // tryBuildDefensePost — NationStructureBehavior.ts:181 (now async).
    async tryBuildDefensePost(precomputedThreat = null) {
      if (!autoBotBuildAllowed(UNIT.DefensePost)) return false; // user disallowed
      // src reads gameConfig().difficulty → REPLICATED difficulty.
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy) return false;
      if (difficulty === Difficulty.Medium && !this.random.chance(2)) {
        return false;
      }
      const threat = precomputedThreat || this.defensePostThreat(difficulty);
      if (threat === null) return false;
      const frontTiles = threat.frontTiles ||
        this.getAttackFrontTiles(threat.landAttacks);
      const uncoveredFrontTiles = this.defensePostFrontDemand(threat, frontTiles);
      if (uncoveredFrontTiles === null) return false;
      const cost = this.cost(UNIT.DefensePost);
      if (this.player.gold() < cost) return false;

      // src samples tiles (canBuild checked inside the sampler) and builds the
      // first valid one. Client: sample WITHOUT canBuild (it's async), then probe
      // buildables down the sampled list and build the first canBuild !== false.
      // DIVERGENCE: src filters by sync canBuild during sampling, so it may sample
      // more raw candidates to reach `count` valid ones; we sample `count` raw
      // candidates and probe them, which can yield slightly fewer probes. Same
      // candidate-generation distribution; only the in-sampler canBuild filter
      // moves to the probe phase (rank-then-probe).
      const sampledTiles = this.sampleTilesNearFront(
        uncoveredFrontTiles,
        25,
        UNIT.DefensePost,
      );
      const tiles = this.rankDefensePostTiles(
        sampledTiles,
        uncoveredFrontTiles,
      );
      return this.buildFirstDefensePost(tiles);
    }

    defensePostFrontDemand(threat, frontTiles) {
      if (Array.isArray(threat.landAttacks)) {
        if (
          this.countDefensePostsNearFront(frontTiles, threat.allowed) >=
          threat.allowed
        ) {
          return null;
        }
        const uncovered = this.uncoveredDefensePostFrontTiles(frontTiles);
        return uncovered.length > 0 ? uncovered : null;
      }
      return this.countDefensePostsNearFront(frontTiles, threat.allowed) <
        threat.allowed
        ? frontTiles
        : null;
    }

    defensePostPlacementThreat(difficulty) {
      return this.defensePostThreat(difficulty);
    }

    defensePostThreat(difficulty) {
      // Land attacks only (src: sourceTile() === null). isLandAttack() uses the
      // exact source tile when present and reconstructs it through a shared
      // land border when the extension omits it.
      const landAttacks = (this.player.incomingAttacks?.() ?? []).filter(
        (attack) => this.isActiveIncomingAttack(attack) && this.isLandAttack(attack),
      );
      if (landAttacks.length === 0) return null;
      const ourTroops = this.player.troops();
      if (ourTroops <= 0) return null;
      const incomingTroops = landAttacks.reduce(
        (sum, attack) => sum + attack.troops(),
        0,
      );
      const ratio = incomingTroops / ourTroops;
      const preemptiveStrategicThreat =
        ratio >= PREEMPTIVE_DEFENSE_POST_THREAT_RATIO &&
        landAttacks.some((attack) => this.isStrategicLandAttack(attack));
      if (ratio < UNDER_ATTACK_THREAT_RATIO && !preemptiveStrategicThreat) {
        return null;
      }
      const allowed =
        difficulty === Difficulty.Medium
          ? 1
          : Math.ceil(ratio / DEFENSE_POST_RATIO_PER_POST);
      return { allowed, incomingTroops, landAttacks, ratio };
    }

    async buildFirstDefensePost(tiles) {
      for (
        let offset = 0;
        offset < tiles.length;
        offset += STRUCTURE_PROBE_CONCURRENCY
      ) {
        const batch = tiles.slice(offset, offset + STRUCTURE_PROBE_CONCURRENCY);
        const safeBatch = batch.filter(
          (tile) => !this.isDangerousStructureTile(tile, UNIT.DefensePost),
        );
        const buildables = await Promise.all(
          safeBatch.map((tile) =>
            this.buildableFor(
              UNIT.DefensePost,
              tile,
              STRUCTURE_PROBE_TIMEOUT_MS,
            ),
          ),
        );
        for (let index = 0; index < buildables.length; index++) {
          const bu = buildables[index];
          if (
            !this.isUsableStructureBuildable(
              bu,
              safeBatch[index],
              UNIT.DefensePost,
            )
          ) {
            continue;
          }
          const buildMenu = getBuildMenu();
          if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
            return false;
          }
          // src: addExecution(new ConstructionExecution(player, DefensePost, tile)).
          if (!sendAutoBotBuildOrUpgrade(buildMenu, bu, bu.canBuild, this.game, this.player)) {
            return false;
          }
          state.stats.builds++;
          setLastAction(tr("🛡️ Defense post"), "build");
          return true;
        }
      }
      return false;
    }

    // defensePostNeeded — NationStructureBehavior.ts:229.
    defensePostNeeded() {
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy) return false;
      return this.defensePostThreat(difficulty) !== null;
    }

    isStrategicLandAttack(attack) {
      const type = attack.attacker?.()?.type?.();
      return type === PlayerType.Nation || type === PlayerType.Human;
    }

    isActiveIncomingAttack(attack) {
      if (Number(attack?.troops?.()) <= 0 || attack?.retreating?.()) return false;

      // incomingAttacks() can briefly retain a wire snapshot after its target
      // or attacker has changed state.  A positive troop count alone is not a
      // current hostile attack: stale/dead/friendly/misdirected entries must not
      // authorize an economic Defense Post.
      return this.attackTargetsUs(attack) && this.attackHasLiveHostileAttacker(attack);
    }

    attackTargetsUs(attack) {
      const targetID = attack?.target?.()?.smallID?.();
      const ourID = this.player?.smallID?.();
      if (targetID === null || targetID === undefined) return true;
      if (ourID === null || ourID === undefined) return true;
      return targetID === ourID;
    }

    attackHasLiveHostileAttacker(attack) {
      const attacker = attack?.attacker?.();
      if (attacker?.isAlive?.() === false) return false;
      return !attacker || this.player?.isFriendly?.(attacker) !== true;
    }

    canAffordDefensePost() {
      {
        return (
          BigInt(this.player.gold() || 0) >=
          BigInt(this.cost(UNIT.DefensePost) || 0)
        );
      }
    }

    // isLandAttack — src filters land attacks by `attack.sourceTile() === null`
    // (boat attacks carry the landing tile). The extension wire AttackUpdate has
    // NO sourceTile, so when it's absent we RECONSTRUCT it: a land attack comes
    // from an enemy we share a LAND border with; a boat attack lands from across
    // water (the attacker need not be a land neighbour). When sourceTile IS
    // present (harness / a future client build) we use the exact value.
    // RESIDUAL: a land-bordering neighbour who ALSO boats has that boat attack
    // counted as land (rare); still far better than counting every attack as land.
    isLandAttack(a) {
      if (a.hasSourceTile && a.hasSourceTile()) {
        return a.sourceTile() === null;
      }
      const attacker = a.attacker();
      if (!attacker || !(attacker.isPlayer && attacker.isPlayer())) return true;
      return this.player.sharesBorderWith(attacker);
    }

    // getAttackFrontTiles — NationStructureBehavior.ts:246.
    // src builds a Set of attacker Player objects and tests owner-identity; we
    // build a Set of attacker smallIDs and test the neighbor owner's smallID
    // (guarding null / TerraNullius), per the contract identity rule.
    getAttackFrontTiles(landAttacks) {
      const game = this.game;
      const player = this.player;
      const attackerSet = new Set(
        landAttacks
          .map((a) => {
            const at = a.attacker();
            return at && at.isPlayer && at.isPlayer() ? at.smallID() : null;
          })
          .filter((sid) => sid !== null),
      );
      if (attackerSet.size === 0) return [];

      const frontTiles = [];
      outer: for (const borderTile of player.borderTiles()) {
        for (const neighbor of game.neighbors(borderTile)) {
          const ownerSid = game.hasOwner(neighbor) ? game.ownerID(neighbor) : null;
          if (ownerSid !== null && attackerSet.has(ownerSid)) {
            frontTiles.push(borderTile);
            continue outer;
          }
        }
      }
      return frontTiles;
    }

    // countDefensePostsNearFront — NationStructureBehavior.ts:269.
    countDefensePostsNearFront(frontTiles, cap) {
      if (frontTiles.length === 0) return 0;

      const game = this.game;
      const { borderSpacing } = this.spacingConstants();
      const rangeSquared = (borderSpacing * 1.5) ** 2;

      let count = 0;
      for (const dp of this.player.units(UNIT.DefensePost)) {
        for (const frontTile of frontTiles) {
          if (game.euclideanDistSquared(dp.tile(), frontTile) <= rangeSquared) {
            count++;
            if (cap !== undefined && count >= cap) return count;
            break;
          }
        }
      }
      return count;
    }

    defensePostEffectRangeSquared() {
      const configuredRange = Number(this.game.config().defensePostRange?.());
      if (Number.isFinite(configuredRange) && configuredRange > 0) {
        return configuredRange ** 2;
      }
      const { borderSpacing } = this.spacingConstants();
      return (borderSpacing * 1.5) ** 2;
    }

    uncoveredDefensePostFrontTiles(frontTiles) {
      const posts = typeof this.player.units === "function"
        ? this.player.units(UNIT.DefensePost) || []
        : [];
      if (posts.length === 0) return [...frontTiles];
      const rangeSquared = this.defensePostEffectRangeSquared();
      return frontTiles.filter((frontTile) =>
        posts.every(
          (post) =>
            this.game.euclideanDistSquared(post.tile(), frontTile) > rangeSquared,
        ),
      );
    }

    rankDefensePostTiles(tiles, uncoveredFrontTiles) {
      const rangeSquared = this.defensePostEffectRangeSquared();
      const placementByTile = new Map(
        tiles.map((tile) => {
          let coverage = 0;
          let closestFrontDistanceSquared = Infinity;
          for (const frontTile of uncoveredFrontTiles) {
            const distanceSquared = this.game.euclideanDistSquared(tile, frontTile);
            if (distanceSquared <= rangeSquared) coverage++;
            closestFrontDistanceSquared = Math.min(
              closestFrontDistanceSquared,
              distanceSquared,
            );
          }
          return [tile, { coverage, closestFrontDistanceSquared }];
        }),
      );
      return this.rankStructureTilesBySamProtection(
        tiles,
        UNIT.DefensePost,
      ).sort(
        (left, right) =>
          (placementByTile.get(right)?.coverage ?? 0) -
            (placementByTile.get(left)?.coverage ?? 0) ||
          (placementByTile.get(right)?.closestFrontDistanceSquared ?? 0) -
            (placementByTile.get(left)?.closestFrontDistanceSquared ?? 0),
      );
    }

    // sampleTilesNearFront — NationStructureBehavior.ts:302.
    // DIVERGENCE: src checks `player.canBuild(unitType, t)` inside the sampler
    // (so a tile only counts toward `count` if buildable). The client canBuild is
    // async, so we drop the in-sampler canBuild check and emit the raw sampled
    // tiles; tryBuildDefensePost probes buildability down the returned list
    // (rank-then-probe). Sampling geometry/RNG and the spread-anchor filtering are
    // otherwise identical. `unitType` is retained in the signature for parity.
    sampleTilesNearFront(frontTiles, count, _unitType) {
      if (frontTiles.length === 0) return [];

      const { borderSpacing } = this.spacingConstants();
      const context = {
        anchors: this.defensePostFrontAnchors(frontTiles, borderSpacing),
        borderTiles: this.player.borderTiles(),
        count,
        maxBorderDist: Math.ceil(borderSpacing * 1.5),
        minBorderDist: Math.ceil(borderSpacing * 0.75),
        mySid: this.player.smallID(),
        searchRadius: Math.ceil(borderSpacing * 1.5),
      };
      const result = this.sampleOwnedFrontTiles(context, 6, true);

      // A shallow fallback puts the unfinished Post directly on the collapsing
      // border. If no candidate has the required territorial depth, there is no
      // survivable placement in this decision and ordinary construction stays live.
      return result;
    }

    defensePostFrontAnchors(frontTiles, borderSpacing) {
      const existingTiles = this.player
        .units(UNIT.DefensePost)
        .map((unit) => unit.tile());
      if (existingTiles.length === 0) return frontTiles;
      const spreadRangeSquared = (borderSpacing * 1.5) ** 2;
      const spreadAnchors = frontTiles.filter((frontTile) =>
        existingTiles.every(
          (postTile) =>
            this.game.euclideanDistSquared(frontTile, postTile) >=
            spreadRangeSquared,
        ),
      );
      return spreadAnchors.length > 0 ? spreadAnchors : frontTiles;
    }

    sampleOwnedFrontTiles(context, attemptMultiplier, requireBorderDepth) {
      const result = [];
      for (
        let attempt = 0;
        attempt < context.count * attemptMultiplier &&
        result.length < context.count;
        attempt++
      ) {
        const tile = this.randomOwnedFrontTile(context);
        if (tile === null) continue;
        if (requireBorderDepth && !this.hasDefensePostBorderDepth(tile, context)) {
          continue;
        }
        result.push(tile);
      }
      return result;
    }

    randomOwnedFrontTile(context) {
      const anchor = this.random.randElement(context.anchors);
      const ax = this.game.x(anchor);
      const ay = this.game.y(anchor);
      const radius = context.searchRadius;
      const x = this.random.nextInt(ax - radius, ax + radius + 1);
      const y = this.random.nextInt(ay - radius, ay + radius + 1);
      if (!this.game.isValidCoord(x, y)) return null;
      const tile = this.game.ref(x, y);
      return this.game.ownerID(tile) === context.mySid ? tile : null;
    }

    hasDefensePostBorderDepth(tile, context) {
      const [, borderDist] = closestTile(this.game, context.borderTiles, tile);
      return (
        borderDist >= context.minBorderDist &&
        borderDist <= context.maxBorderDist
      );
    }

    // isInPostSaveUpBlockedPhase — NationStructureBehavior.ts:398.
    isInPostSaveUpBlockedPhase() {
      // winFixes uses explicit offensive/economy reserves instead of the
      // faithful global save-up gate. Never freeze ordinary construction while
      // waiting for a MIRV or HydrogenBomb target.
      if (state.settings.winFixes) return false;
      if (this.game.config().isUnitDisabled(UNIT.MissileSilo)) {
        return false;
      }
      const saveUpTarget = this.getSaveUpTarget();
      if (this._postSaveUpStartTick === null) {
        if (this.player.gold() < saveUpTarget) {
          return false;
        }
        this._postSaveUpStartTick = this.game.ticks();
      }
      const elapsed = this.game.ticks() - this._postSaveUpStartTick;
      return (
        elapsed % (TEAM_POST_SAVE_UP_PHASE_TICKS * 2) >=
        TEAM_POST_SAVE_UP_PHASE_TICKS
      );
    }

    async handleInitialSiloPriority(profile, legendaryDifficulty) {
      if (this.player === null || this.player === undefined) return false;
      return profileStructureAsync(profile, "structures-initial-silo", () =>
        this.handleInitialMissileSilo(legendaryDifficulty));
    }

    legendaryDefenseEmergencies(legendaryDifficulty) {
      const missileEmergency =
        legendaryDifficulty && this.legendaryMissileDefenseUrgent();
      const defenseEmergency =
        missileEmergency ||
        (legendaryDifficulty &&
          state.settings.winFixes &&
          this.hasObservedHostileMissileLaunch() &&
          this.samLevelParityGap() > 0);
      return { missileEmergency, defenseEmergency };
    }

    // doHandleStructures — NationStructureBehavior.ts:416 (now async).
    async doHandleStructures(profile = null) {
      const context = profileStructureSync(
        profile,
        "structures-ordinary-context",
        () => this.structureBuildContext(profile),
      );
      if (
        await profileStructureAsync(profile, "structures-ordinary-opening", () =>
          this.handleOpeningStructurePriorities(context))
      ) {
        return true;
      }
      if (
        context.economyGrowthPriority &&
        (await profileStructureAsync(profile, "structures-ordinary-economy", () =>
          this.maybePrioritizeEconomicGrowth(context, profile)))
      ) {
        return true;
      }
      if (
        await profileStructureAsync(profile, "structures-ordinary-silo-parity", () =>
          this.handleMissileSiloParity(context))
      ) {
        return true;
      }
      if (isLegendaryDifficulty(context.difficulty)) {
        return profileStructureAsync(profile, "structures-ordinary-legendary", () =>
          this.doHandleLegendaryStructures(context));
      }
      return profileStructureAsync(profile, "structures-ordinary-policy", () =>
        this.handleOrdinaryStructurePriorities(context));
    }

    structureBuildContext(profile = null) {
      this.reachableStationsCache = null;
      const config = this.game.config();
      const citiesDisabled = config.isUnitDisabled(UNIT.City);
      const cityCount = citiesDisabled
        ? Math.max(
            1,
            Math.floor(this.player.numTilesOwned() / TILES_PER_CITY_EQUIVALENT),
          )
        : this.ownedLevels(UNIT.City);
      // Ocean access is answered from our cached border. An open-ocean port
      // tile is also, by definition, shared water, so read that cheap cached
      // result first. Calling hasSharedWater before it walks the complete live
      // border a second time on every Auto-build decision. The exact
      // shared-water reconstruction remains the fallback for inland lakes.
      const hasOceanPortTiles = profileStructureSync(
        profile,
        "structures-context-ocean-port",
        () => this.hasOceanPortTiles(),
      );
      const hasCoastalTiles = hasOceanPortTiles || profileStructureSync(
        profile,
        "structures-context-shared-water",
        () => shimHasSharedWater(this.game, this.player),
      );
      this._hasCoastalTiles = hasCoastalTiles;
      this._hasOceanPortTiles = hasOceanPortTiles;
      profileStructureSync(profile, "structures-context-dominance", () =>
        this.updateConstructionDominance());

      const missileSilosEnabled = !config.isUnitDisabled(UNIT.MissileSilo);
      const difficulty = currentDifficulty();
      const prioritizeCityForBorderThreat = profileStructureSync(
        profile,
        "structures-context-border-threat",
        () =>
          state.settings.winFixes &&
          this.hasBorderingHostileMaxTroopAdvantage(),
      );
      const economyGrowthPriority = profileStructureSync(
        profile,
        "structures-context-economy-growth",
        () => this.shouldPrioritizeEconomicGrowth(prioritizeCityForBorderThreat),
      );
      const nukesEnabled =
        !config.isUnitDisabled(UNIT.AtomBomb) ||
        !config.isUnitDisabled(UNIT.HydrogenBomb) ||
        !config.isUnitDisabled(UNIT.MIRV);
      return {
        config,
        citiesDisabled,
        cityCount,
        difficulty,
        economyGrowthPriority,
        hasCoastalTiles,
        hasOceanPortTiles,
        missileSilosEnabled,
        nukesEnabled,
        prioritizeCityForBorderThreat,
      };
    }

    updateConstructionDominance() {
      // Once OUR side is DOMINANT (default >75% of the live map — well BELOW the 95%
      // win line at which the game would END), stop suppressing coastal factories (see
      // shouldBuildStructure) so the bot fills in factories → train stations → rail
      // linking our ports and cities. Computed ONCE per build-tick (it scans all
      // players) and read by shouldBuildStructure. Gated by winFixes.
      this._dominant = false;
      if (state.settings.winFixes) {
        const share = this.dominanceShare();
        const trigger = Number.isFinite(state.settings.factoryRailShare)
          ? state.settings.factoryRailShare
          : 0.75;
        this._dominant = share !== null && share > trigger;
        {
          const t = this.game.ticks();
          if (t - (state._buildDomDiagTick || -999) >= 80) {
            state._buildDomDiagTick = t;
            runtimeDebugLog("[Build] dominance gate", {
              share: share === null ? null : Number(share.toFixed(3)),
              trigger,
              dominant: this._dominant,
            });
          }
        }
      }
      // Publish the dominance flag so OTHER behaviors share one source of truth (e.g.
      // allianceBehavior stops reaching out for far trade-allies once we're dominant,
      // letting betray/conquer close the game). Updated every build-tick.
      state.dominant = this._dominant;
    }

    async handleOpeningStructurePriorities(context) {
      // High-starting-gold Hard/Impossible nations build a SAM first. Legendary
      // lets the adaptive planner decide; defense is a guardrail there, not the
      // default opening investment.
      if (
        this.shouldOpenWithSam(context) &&
        (await this.maybeSpawnStructure(UNIT.SAMLauncher))
      ) {
        return true;
      }

      // On crowded maps the first structure is a port (or factory if landlocked).
      const crowdedOpening = this.crowdedOpeningStructure(context);
      if (crowdedOpening === null) return false;
      return this.maybeSpawnStructure(crowdedOpening);
    }

    shouldOpenWithSam(context) {
      return (
        this.placementsCount === 0 &&
        isAtLeastHardDifficulty(context.difficulty) &&
        !isLegendaryDifficulty(context.difficulty) &&
        !context.config.isUnitDisabled(UNIT.AtomBomb) &&
        context.missileSilosEnabled &&
        !context.config.isUnitDisabled(UNIT.SAMLauncher) &&
        this.hasHighStartingGold() &&
        !context.economyGrowthPriority
      );
    }

    crowdedOpeningStructure(context) {
      if (isLegendaryDifficulty(context.difficulty)) return null;
      if (context.citiesDisabled) return null;
      const cityPriorityAvailable =
        context.prioritizeCityForBorderThreat &&
        !context.config.isUnitDisabled(UNIT.City);
      if (cityPriorityAvailable || this.ownedLevels(UNIT.City) !== 0) return null;
      if (!this.isHighNationDensity()) return null;
      const preferred =
        context.hasOceanPortTiles && !context.config.isUnitDisabled(UNIT.Port)
          ? UNIT.Port
          : UNIT.Factory;
      return context.config.isUnitDisabled(preferred) ? null : preferred;
    }

    async handleMissileSiloParity(context) {
      const {
        difficulty,
        economyGrowthPriority,
        missileSilosEnabled,
        nukesEnabled,
      } = context;
      // WIN-FIX: a hostile SAM network defines the silo capacity we need to
      // saturate it. Prefer a silo build/upgrade until our sum of silo levels
      // reaches the largest hostile player's sum of SAM levels.
      return (
        state.settings.winFixes &&
        !isLegendaryDifficulty(difficulty) &&
        !economyGrowthPriority &&
        missileSilosEnabled &&
        nukesEnabled &&
        this.missileSiloParityGap() > 0 &&
        (await this.maybeSpawnStructure(UNIT.MissileSilo))
      );
    }

    async handleInitialMissileSilo(legendaryDifficulty = isLegendaryDifficulty()) {
      // A first launcher is the prerequisite for every offensive nuclear path.
      // The parity policy below deliberately reacts to an established enemy SAM
      // network, but cannot create that first launcher when no such network is
      // visible. Keep active-missile, hostile-silo and immediate-defense paths
      // above this one, then establish one affordable silo independently of the
      // ongoing economy-growth signal.
      if (
        !state.settings.winFixes ||
        legendaryDifficulty ||
        this.game.config().isUnitDisabled(UNIT.MissileSilo) ||
        this.ownedLevels(UNIT.MissileSilo) > 0
      ) {
        return false;
      }
      const nukesEnabled =
        !this.game.config().isUnitDisabled(UNIT.AtomBomb) ||
        !this.game.config().isUnitDisabled(UNIT.HydrogenBomb) ||
        !this.game.config().isUnitDisabled(UNIT.MIRV);
      if (!nukesEnabled) return false;
      if (
        !this.game.config().isUnitDisabled(UNIT.City) &&
        this.ownedLevels(UNIT.City) === 0
      ) {
        return false;
      }
      // On an open-ocean start, spending the entire opening bank on a peaceful
      // first silo leaves neither the Port nor its first Warship affordable.
      // Nuclear emergencies already returned from higher-priority paths; this
      // applies only to the speculative offensive launcher.
      if (this.shouldDeferInitialSiloForNavalOpening()) return false;
      const siloCost = this.getConstructionCost(UNIT.MissileSilo);
      if (this.spendableConstructionGold() < siloCost) return false;
      // The first silo establishes the offensive capability itself.  The
      // normal reserve gate intentionally defers additional offensive silos
      // behind the next economic/SAM spend, but applying it here makes this
      // policy unreachable whenever the economy has any pending demand.
      return this.maybeSpawnStructure(UNIT.MissileSilo, {
        ignoreEconomicReserve: true,
      });
    }

    shouldDeferInitialSiloForNavalOpening() {
      const config = this.game?.config?.();
      if (!config || !this.maritimeDefenseConstructionEnabled(config)) return false;
      if (this.hasObservedHostileMissileLaunch() || this.hasBuiltHostileSiloThreat()) {
        return false;
      }
      if (!this.hasOceanPortTiles()) return false;
      const ports = this.player?.units?.(UNIT.Port) || [];
      if (!ports.some((port) => port?.isUnderConstruction?.() === false)) return true;
      const warships = this.player?.units?.(UNIT.Warship) || [];
      return warships.length === 0;
    }

    async handleOrdinaryStructurePriorities(context) {
      const {
        citiesDisabled,
        cityCount,
        config,
        hasCoastalTiles,
        hasOceanPortTiles,
      } = context;
      // A coastal opening must not spend its first economic windows on Ports.
      // Without a City, Ports and their Warship follow-up add little durable
      // troop/economic capacity and can starve the foundational growth needed
      // to survive a fast Nation opening. Urgent missile and land-defense
      // paths run before this ordinary phase; here the first two Cities are absolute.
      if (
        !citiesDisabled &&
        cityCount < 2 &&
        (await this.maybeSpawnStructure(UNIT.City))
      ) {
        return true;
      }
      // Build order for non-city structures (priority order)
      const buildOrder = [
        UNIT.Port,
        UNIT.Factory,
        UNIT.SAMLauncher,
        UNIT.MissileSilo,
      ];

      for (const structureType of buildOrder) {
        if (!this.structureTypeAvailable(structureType, context)) continue;
        if (!this.shouldBuildStructure(structureType, cityCount, hasCoastalTiles)) {
          continue;
        }
        if (await this.maybeSpawnStructure(structureType)) return true;
      }

      if (!citiesDisabled && (await this.maybeSpawnStructure(UNIT.City))) {
        return true;
      }

      // All ratio-driven and defensive construction has had first chance. If
      // the economy is still idle, make one affordable economic attempt even
      // when the growth signal is already active but its ratio targets are met.
      if (
        (await this.maybePrioritizeHighGoldEconomicConstruction({
          config,
          hasOceanPortTiles,
        }))
      ) {
        return true;
      }

      return false;
    }

    structureTypeAvailable(structureType, context) {
      if (context.config.isUnitDisabled(structureType)) return false;
      if (structureType === UNIT.Port && !context.hasOceanPortTiles) return false;
      const missileDefenseType =
        structureType === UNIT.MissileSilo || structureType === UNIT.SAMLauncher;
      if (!context.nukesEnabled && missileDefenseType) return false;
      return !(
        !context.missileSilosEnabled && structureType === UNIT.SAMLauncher
      );
    }

    async maybePrioritizeEconomicGrowth({
      config,
      citiesDisabled,
      cityCount,
      hasCoastalTiles,
      hasOceanPortTiles,
      prioritizeCityForBorderThreat = false,
    }, profile = null) {
      const buildOrder = prioritizeCityForBorderThreat
        ? CITY_FIRST_ECONOMIC_STRUCTURE_TYPES
        : ECONOMIC_STRUCTURE_TYPES;
      for (const structureType of buildOrder) {
        if (config.isUnitDisabled(structureType)) continue;
        if (structureType === UNIT.Port && !hasOceanPortTiles) continue;

        // A first city is the baseline economic action even though the normal
        // ratio target is zero until cityCount has been established.
        const firstCity =
          structureType === UNIT.City && !citiesDisabled && cityCount === 0;
        if (
          !firstCity &&
          !this.shouldBuildStructure(structureType, cityCount, hasCoastalTiles)
        ) {
          continue;
        }
        if (
          await profileStructureAsync(profile, `structures-economy-${structureType}`, () =>
            this.maybeSpawnStructure(structureType))
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Economy ratios may say "wait" even though an economic structure is
     * affordable. Keep the normal defensive/offensive priorities, but always
     * reopen economic construction when a concrete affordable action exists.
     */
    async maybePrioritizeHighGoldEconomicConstruction({
      config,
      hasOceanPortTiles,
    }) {
      if (!state.settings.winFixes) return false;

      const availableGold = this.spendableConstructionGold();
      // A generic City → Factory → Port fallback can starve the first Port:
      // every failed economic placement consumes from the one bounded probe
      // budget for this decision, leaving no coastal probe by the time Port is
      // reached.  Once the foundational first City exists, give a viable first
      // ocean Port its probe before generic economy sites.  This redistributes
      // the fixed budget rather than increasing it, so it preserves the
      // anti-stutter bound while enabling the naval economy and warship paths.
      const openingOceanPort =
        hasOceanPortTiles === true &&
        this.ownedLevels(UNIT.City) > 0 &&
        this.ownedLevels(UNIT.Port) === 0 &&
        !config.isUnitDisabled(UNIT.Port);
      const hasFoundationalCity = this.ownedLevels(UNIT.City) > 0;
      let buildOrder;
      if (openingOceanPort) {
        buildOrder = [UNIT.Port, UNIT.Factory, UNIT.City];
      } else if (hasFoundationalCity) {
        buildOrder = [UNIT.Factory, UNIT.Port, UNIT.City];
      } else {
        buildOrder = [UNIT.City, UNIT.Factory, UNIT.Port];
      }
      for (const structureType of buildOrder) {
        if (config.isUnitDisabled(structureType)) continue;
        if (structureType === UNIT.Port && !hasOceanPortTiles) continue;
        if (availableGold < this.getConstructionCost(structureType)) continue;
        if (await this.maybeSpawnStructure(structureType)) return true;
      }
      return false;
    }

    async maybeSpawnHostileSiloSam() {
      if (!this.shouldBuildSiloTriggeredSam()) return false;
      const attemptTick = this.hostileSiloSamCurrentTick();
      if (this.hostileSiloSamRetryActive(attemptTick)) return false;
      if (this.hasOwnSamUnderConstruction()) return false;
      if (
        attemptTick !== null &&
        this._hostileSiloSamAttemptTick === attemptTick
      ) {
        return false;
      }
      if (attemptTick !== null) this._hostileSiloSamAttemptTick = attemptTick;
      const built = await this.maybeSpawnStructure(
        UNIT.SAMLauncher,
        this.hostileSiloSamPlacementOptions(),
      );
      if (built) {
        this._hostileSiloSamRetryNotBeforeTick = null;
      } else if (attemptTick !== null) {
        const completedTick = this.hostileSiloSamCurrentTick();
        const retryBaseTick = completedTick ?? attemptTick;
        this._hostileSiloSamRetryNotBeforeTick =
          retryBaseTick + HOSTILE_SILO_SAM_RETRY_TICKS;
      }
      return built;
    }

    hostileSiloSamPlacementOptions() {
      return {
        allowPreemptiveSam: true,
        useActualCost: true,
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        probeLimit: STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
        probeTimeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        // Used only when an older client lacks the primitives required for the
        // one-request local-legality path below.
        parallelProbeCount: DEFENSIVE_SAM_PROBE_CONCURRENCY,
      };
    }

    hostileSiloSamRetryActive(tick = this.hostileSiloSamCurrentTick()) {
      return (
        tick !== null &&
        this._hostileSiloSamRetryNotBeforeTick !== null &&
        tick < this._hostileSiloSamRetryNotBeforeTick
      );
    }

    hasOwnSamUnderConstruction() {
      {
        return (this.player.units(UNIT.SAMLauncher) || []).some(
          (sam) =>
            sam &&
            typeof sam.isUnderConstruction === "function" &&
            sam.isUnderConstruction(),
        );
      }
    }

    hostileSiloSamActionBlocked() {
      return (
        this.hostileSiloSamRetryActive() || this.hasOwnSamUnderConstruction()
      );
    }

    hostileSiloSamCurrentTick() {
      {
        if (typeof this.game?.ticks !== "function") return null;
        const tick = this.game.ticks();
        return tick === null || tick === undefined ? null : tick;
      }
    }

    hostileSiloSamAttemptedThisTick() {
      const tick = this.hostileSiloSamCurrentTick();
      return tick !== null && this._hostileSiloSamAttemptTick === tick;
    }

    // Legendary deliberately chooses among all currently relevant structures
    // instead of following the faithful Nation priority list. Placement, cost,
    // upgrade, and buildability checks remain in maybeSpawnStructure().
    async doHandleLegendaryStructures({
      config,
      citiesDisabled,
      cityCount,
      hasCoastalTiles,
      hasOceanPortTiles,
      missileSilosEnabled,
      nukesEnabled,
      economyGrowthPriority,
    }) {
      // A missile attack inside the five-tick safety window takes precedence over
      // economic construction: upgrade the SAM that actually covers the most
      // exposed trajectory before spending the same gold on a new structure.
      if (await this.maybeUpgradeLegendarySam()) {
        return true;
      }

      const needsBaselineSam = this.ownSamCapacity() <= 0;
      if (needsBaselineSam && (await this.maybeSpawnHostileSiloSam())) return true;
      // A failed/blocked baseline-SAM placement is retried on its bounded
      // cadence, but it must not reserve every intervening construction slot.
      // If the current per-missile schedule is not fully defensible, only
      // attempt a SAM whose construction can actually finish in time. Do not
      // spend on a City/Factory/Port/Silo in a zone that the model already
      // predicts will be hit before the emergency defense can come online.
      if (this.legendaryMissileDefenseUrgent()) {
        if (await this.maybeSpawnStructure(UNIT.SAMLauncher)) return true;
      }

      const candidates = this.legendaryConstructionCandidates({
        config,
        citiesDisabled,
        cityCount,
        hasCoastalTiles,
        hasOceanPortTiles,
        missileSilosEnabled,
        nukesEnabled,
      });
      const actionGroups = this.legendaryConstructionActionGroups(
        candidates,
        economyGrowthPriority,
      );
      for (const actions of actionGroups) {
        for (const candidate of actions) {
          if (candidate.action === "wait") return false;
          if (await this.maybeSpawnStructure(candidate.type)) {
            return true;
          }
        }
      }
      return false;
    }

    legendaryConstructionActionGroups(candidates, economyGrowthPriority) {
      const candidateGroups = economyGrowthPriority
        ? [
            candidates.filter((candidate) =>
              ECONOMIC_STRUCTURE_TYPES.includes(candidate.type),
            ),
            candidates.filter(
              (candidate) => !ECONOMIC_STRUCTURE_TYPES.includes(candidate.type),
            ),
          ]
        : [candidates];
      return candidateGroups.map((group) =>
        rankLegendaryConstructionActions(group, {
          gold: this.player.gold(),
          // The MIRV war chest is only an offensive goal. Productive and
          // defensive candidates must remain rankable while the bot saves it.
          reserve: 0n,
        }),
      );
    }

    legendaryReserveGold() {
      if (!state.settings.winFixes || !state.nukeReserveGold) return 0n;
      {
        const reserve = BigInt(state.nukeReserveGold || 0);
        return reserve >= 15_000_000n ? reserve : 0n;
      }
    }

    legendaryMissileDefenseUrgent() {
      if (this.hasMissileDefenseSignal() === false) return false;
      const context = this.getMissileDefenseContext();
      if (!context || !Array.isArray(context.threats) || context.threats.length === 0) {
        return false;
      }
      const evaluation = this.getMissileDefenseEvaluation(context);
      if (evaluation.hasThreats && !evaluation.fullyDefended) {
        return true;
      }
      if (context.critical && !evaluation.fullyDefended) return true;
      return false;
    }

    legendaryHostilePlayers() {
      const mySid = this.player.smallID();
      const hostile = [];
      {
        for (const other of this.game.players()) {
          if (
            !other ||
            (typeof other.isPlayer === "function" && !other.isPlayer()) ||
            other.smallID() === mySid
          ) {
            continue;
          }
          const friendly =
            this.player.isFriendly(other) || this.player.isOnSameTeam(other);
          if (friendly) continue;
          hostile.push(other);
        }
      }
      return hostile;
    }

    liveHostilePlayers() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return null;
      }
      const snapshotTick = safeStructureGameTick(this.game);
      if (
        snapshotTick !== null &&
        this._hostilePlayersSnapshotTick === snapshotTick &&
        Array.isArray(this._hostilePlayersSnapshot)
      ) {
        return this._hostilePlayersSnapshot;
      }

      const players = this.structurePlayersSnapshot();
      if (!Array.isArray(players)) return null;
      const mySid = this.readPlayerSmallId(this.player);
      const hostile = players.filter((other) =>
        this.isLiveHostilePlayer(other, mySid),
      );
      if (snapshotTick !== null) {
        this._hostilePlayersSnapshotTick = snapshotTick;
        this._hostilePlayersSnapshot = hostile;
      }
      return hostile;
    }

    structurePlayersSnapshot() {
      {
        return this.game.players();
      }
    }

    readPlayerSmallId(player) {
      {
        return player.smallID();
      }
    }

    isLiveHostilePlayer(other, mySid) {
      if (!other || other === this.player) return false;
      if (typeof other.isPlayer === "function" && !other.isPlayer()) return false;
      const otherSid = this.readPlayerSmallId(other);
      if (mySid !== null && otherSid === mySid) return false;
      {
        if (typeof other.isAlive === "function" && !other.isAlive()) return false;
        return !(
          this.player.isFriendly(other) || this.player.isOnSameTeam(other)
        );
      }
    }

    playerGoldBigInt(player) {
      if (!player || typeof player.gold !== "function") return null;
      {
        return BigInt(player.gold());
      }
    }

    // A silo/SAM level is also the number of missiles it can have in its
    // cooldown queue. Keep the defensive capacity calculation aligned with
    // that engine mechanic: built active units contribute their level and a
    // unit under construction contributes one projected slot.
    playerUnitCapacitySummary(player, type) {
      if (!player || typeof player.units !== "function") return null;
      let units;
      {
        units = player.units(type);
      }
      if (!Array.isArray(units)) return null;

      let count = 0;
      let capacity = 0;
      let builtCount = 0;
      for (const unit of units) {
        const contribution = this.unitCapacityContribution(unit);
        if (contribution === null) continue;
        count += contribution.count;
        capacity += contribution.capacity;
        builtCount += contribution.builtCount;
      }
      return { count, capacity, builtCount };
    }

    unitCapacityContribution(unit) {
      if (!unit) return null;
      {
        const underConstruction =
          typeof unit.isUnderConstruction === "function" &&
          unit.isUnderConstruction();
        if (underConstruction) return { count: 1, capacity: 1, builtCount: 0 };
        if (typeof unit.isActive === "function" && !unit.isActive()) return null;
        const rawLevel = typeof unit.level === "function" ? unit.level() : 1;
        const level = Number(rawLevel ?? 1);
        return {
          count: 1,
          capacity: Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1,
          builtCount: 1,
        };
      }
    }

    ownSamCapacity() {
      return this.playerUnitCapacitySummary(this.player, UNIT.SAMLauncher)
        ?.capacity ?? 0;
    }

    hostileMissileSiloCapacitySummary() {
      const snapshotTick = this.hostileSiloSamCurrentTick();
      if (
        snapshotTick !== null &&
        this._hostileSiloCapacitySnapshotTick === snapshotTick &&
        this._hostileSiloCapacitySnapshot !== null
      ) {
        return this._hostileSiloCapacitySnapshot;
      }

      const hostile = this.liveHostilePlayers();
      if (hostile === null) return null;

      let hostileSiloCount = 0;
      let hostileSiloCapacity = 0;
      let builtHostileSiloCount = 0;
      for (const other of hostile) {
        const metrics = this.playerUnitCapacitySummary(
          other,
          UNIT.MissileSilo,
        );
        if (metrics === null) continue;
        hostileSiloCount += metrics.count;
        hostileSiloCapacity += metrics.capacity;
        builtHostileSiloCount += metrics.builtCount;
      }

      const summary = {
        hostileSiloCount,
        hostileSiloCapacity,
        builtHostileSiloCount,
      };
      if (snapshotTick !== null) {
        this._hostileSiloCapacitySnapshotTick = snapshotTick;
        this._hostileSiloCapacitySnapshot = summary;
      }
      return summary;
    }

    hasBuiltMissileSilo(player) {
      return (
        this.playerUnitCapacitySummary(player, UNIT.MissileSilo)?.builtCount ??
        0
      ) > 0;
    }

    hasBuiltHostileSiloThreat() {
      const summary = this.hostileMissileSiloCapacitySummary();
      return summary !== null && summary.builtHostileSiloCount > 0;
    }

    hasBuiltExternalSiloThreat() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return false;
      }
      const mySid = this.readPlayerSmallId(this.player);
      return this.game.players().some(
        (other) =>
          this.isLiveOtherPlayer(other, mySid) && this.hasBuiltMissileSilo(other),
      );
    }

    hasPlacedHostileSiloThreat() {
      const summary = this.hostileMissileSiloCapacitySummary();
      return summary !== null && summary.hostileSiloCount > 0;
    }

    // A silo placed by either an enemy or an ally is the immediate, global
    // nuclear-defense trigger. Do not cache the result: a build event may
    // arrive between two structure decisions in the same game tick.
    hasPlacedSiloOnMap() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return false;
      }
      const mySid = this.readPlayerSmallId(this.player);
      for (const other of this.game.players()) {
        if (!this.isLiveOtherPlayer(other, mySid)) continue;
        const metrics = this.playerUnitCapacitySummary(other, UNIT.MissileSilo);
        if (metrics !== null && metrics.count > 0) return true;
      }
      return false;
    }

    isLiveOtherPlayer(other, mySid) {
      if (!other || other === this.player) return false;
      if (typeof other.isPlayer === "function" && !other.isPlayer()) return false;
      const otherSid = this.readPlayerSmallId(other);
      if (mySid !== null && otherSid === mySid) return false;
      return !(typeof other.isAlive === "function" && !other.isAlive());
    }

    // Gold alone opens the SAM-building gate, but it does not justify running
    // the full trajectory planner: until a hostile silo or missile exists the
    // forecast has no incoming routes to model. Keep this cheap signal separate
    // from hostileThreatSnapshot(), whose gold thresholds are still used by the
    // construction policy.
    missileDefenseSignalSnapshot() {
      const signalTick =
        typeof this.game?.ticks === "function"
          ? Number(this.game.ticks())
          : null;
      if (
        Number.isFinite(signalTick) &&
        this._missileDefenseSignalTick === signalTick
      ) {
        return this._missileDefenseSignalCache;
      }
      const cacheSignal = (signal) => {
        if (Number.isFinite(signalTick)) {
          this._missileDefenseSignalTick = signalTick;
          this._missileDefenseSignalCache = signal;
        }
        return signal;
      };
      const hostile = this.liveHostilePlayers();
      if (hostile === null) return cacheSignal(null);

      const hasBuiltHostileSilo = hostile.some((other) =>
        this.hasBuiltMissileSilo(other),
      );
      const hasActiveHostileMissile = this.activeHostileMissileSnapshot();
      if (hasActiveHostileMissile === null) {
        return cacheSignal({
          hasBuiltHostileSilo,
          hasActiveHostileMissile: null,
        });
      }
      return cacheSignal({ hasBuiltHostileSilo, hasActiveHostileMissile });
    }

    hasMissileDefenseSignal() {
      const signal = this.missileDefenseSignalSnapshot();
      if (signal === null) return null;
      if (
        signal.hasActiveHostileMissile === null &&
        !signal.hasBuiltHostileSilo
      ) {
        return null;
      }
      return (
        signal.hasBuiltHostileSilo || signal.hasActiveHostileMissile === true
      );
    }

    hasObservedHostileMissileLaunch() {
      if (this._hostileMissileLaunchObserved === true) return true;
      if (this.activeHostileMissileSnapshot() !== true) return false;
      this._hostileMissileLaunchObserved = true;
      return true;
    }

    activeHostileMissileSnapshot() {
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._activeHostileMissileTick === tick
      ) {
        return this._activeHostileMissileCache;
      }
      const cache = (value) => {
        if (Number.isFinite(tick)) {
          this._activeHostileMissileTick = tick;
          this._activeHostileMissileCache = value;
        }
        return value;
      };
      if (typeof this.game?.units !== "function") return cache(null);
      const activeMissiles = this.game.units(
          UNIT.AtomBomb,
          UNIT.HydrogenBomb,
          UNIT.MIRV,
          UNIT.MIRVWarhead,
        );
      if (!Array.isArray(activeMissiles)) return cache(null);
      const mySid = this.player.smallID();
      for (const missile of activeMissiles) {
        if (isHostileActiveMissile(this.player, missile, mySid)) return cache(true);
      }
      return cache(false);
    }

    activeHostileMissileImpactZones() {
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._hostileMissileImpactZonesTick === tick
      ) {
        return this._hostileMissileImpactZonesCache;
      }
      const cache = (zones) => {
        if (Number.isFinite(tick)) {
          this._hostileMissileImpactZonesTick = tick;
          this._hostileMissileImpactZonesCache = zones;
        }
        return zones;
      };
      if (typeof this.game?.units !== "function") return cache([]);
      const config = this.game.config?.();
      if (!config || typeof config.nukeMagnitudes !== "function") {
        return cache([]);
      }
      const missiles = this.game.units(
        UNIT.AtomBomb,
        UNIT.HydrogenBomb,
        UNIT.MIRV,
        UNIT.MIRVWarhead,
      );
      if (!Array.isArray(missiles)) return cache([]);

      const zones = [];
      for (const missile of missiles) {
        const zone = this.hostileMissileImpactZone(missile, config);
        if (zone !== null) zones.push(zone);
      }
      return cache(zones);
    }

    hostileMissileImpactZone(missile, config) {
      // NukeExecution deletes every structure inside the blast regardless of
      // owner or alliance. Own and allied missiles are therefore placement
      // hazards too, even though only hostile missiles drive SAM strategy.
      if (!isActiveStructureMissileThreat(missile)) return null;
      const targetTile = missile.targetTile?.();
      const type = missile.type?.();
      // The MIRV carrier separates into independently targeted warheads and
      // never creates a blast of its own. Warhead units get exact zones once
      // their destinations exist; querying nukeMagnitudes(MIRV) also throws in
      // the authoritative engine because no carrier magnitude is defined.
      if (type === UNIT.MIRV) return null;
      const radius = Number(config.nukeMagnitudes(type)?.outer);
      if (targetTile === null || targetTile === undefined) return null;
      if (!Number.isFinite(radius) || radius <= 0) return null;
      return { targetTile, radiusSquared: radius * radius };
    }

    tileInsideActiveHostileMissileImpact(tile) {
      if (tile === null || tile === undefined) return false;
      if (typeof this.game?.euclideanDistSquared !== "function") return false;
      for (const zone of this.activeHostileMissileImpactZones()) {
        if (
          this.game.euclideanDistSquared(tile, zone.targetTile) <
          zone.radiusSquared
        ) {
          return true;
        }
      }
      return false;
    }

    observeHostileMissileLaunch() {
      return this.hasObservedHostileMissileLaunch();
    }

    hasHostileReachedSiloGoldThreshold() {
      const snapshot = this.hostileThreatSnapshot();
      return snapshot === null ? null : snapshot.reachedSiloGoldThreshold;
    }

    hasHostileSiloThreat() {
      const snapshot = this.hostileThreatSnapshot();
      return snapshot === null ? null : snapshot.siloThreat;
    }

    hostileThreatSnapshot() {
      const snapshotTick = safeStructureGameTick(this.game);
      if (
        snapshotTick !== null &&
        this._hostileThreatSnapshotTick === snapshotTick &&
        this._hostileThreatSnapshot !== null
      ) {
        return this._hostileThreatSnapshot;
      }

      const hostile = this.liveHostilePlayers();
      if (hostile === null) return null;
      const siloSummary = this.hostileMissileSiloCapacitySummary();
      const goldThreat = this.hostileGoldThreat(hostile);
      const snapshot = {
        reachedSiloGoldThreshold: goldThreat.reachedSiloGoldThreshold,
        siloThreat:
          goldThreat.siloThreat ||
          (siloSummary !== null && siloSummary.builtHostileSiloCount > 0),
        hostileSiloCount: siloSummary?.hostileSiloCount ?? 0,
        hostileSiloCapacity: siloSummary?.hostileSiloCapacity ?? 0,
      };
      if (snapshotTick !== null) {
        this._hostileThreatSnapshotTick = snapshotTick;
        this._hostileThreatSnapshot = snapshot;
      }
      return snapshot;
    }

    hostileGoldThreat(hostilePlayers) {
      let reachedSiloGoldThreshold = false;
      let siloThreat = false;
      for (const other of hostilePlayers) {
        const gold = this.playerGoldBigInt(other);
        if (gold === null) continue;
        if (gold >= HOSTILE_SILO_GOLD_THRESHOLD) reachedSiloGoldThreshold = true;
        if (gold >= HOSTILE_SAM_TRIGGER_GOLD_THRESHOLD) siloThreat = true;
      }
      return { reachedSiloGoldThreshold, siloThreat };
    }

    shouldBuildHostileSiloSam() {
      if (!state.settings.winFixes) return false;
      const siloSummary = this.hostileMissileSiloCapacitySummary();
      const threat = this.hostileThreatSnapshot();
      if (siloSummary === null || threat === null) return false;

      const ownSam = this.playerUnitCapacitySummary(
        this.player,
        UNIT.SAMLauncher,
      );
      if (ownSam === null) return false;

      // Hostile Silo count is not a spatial coverage requirement. Establish
      // one defensive site, then let capacity upgrades and the structure-
      // coverage plan prove whether another physical site is actually needed.
      return (
        ownSam.count === 0 &&
        (siloSummary.hostileSiloCount > 0 || threat.siloThreat === true)
      );
    }

    shouldBuildSiloTriggeredSam() {
      if (!state.settings.winFixes) return false;
      const ownSam = this.playerUnitCapacitySummary(
        this.player,
        UNIT.SAMLauncher,
      );
      if (ownSam === null || ownSam.count > 0) return false;
      return this.hasPlacedSiloOnMap() || this.shouldBuildHostileSiloSam();
    }

    /**
     * Return the next economic action that is both strategically eligible and
     * affordable right now. This mirrors the normal construction order without
     * probing tiles, so the nuclear behavior can make the same resource decision
     * without duplicating placement work.
     */
    spendableConstructionGold() {
      let availableGold;
      {
        availableGold = BigInt(this.player.gold() || 0n);
      }

      // This is the budget available to ordinary construction and defensive
      // planning. A MIRV reserve is applied only by the offensive silo paths.
      return availableGold;
    }

    shouldReserveHostileSiloSamBudget() {
      // Once any Silo is visible, the first SAM is the only construction goal.
      // Preserve the opening escape hatch: without a completed income site,
      // saving from zero can never fund the launcher. With any City, Factory,
      // or Port established, do not spend even a small partial SAM fund on an
      // unrelated structure while an external nuclear threat exists.
      return ECONOMIC_STRUCTURE_TYPES.some((type) => this.ownedLevels(type) > 0);
    }

    availableGoldAfterReserve(type) {
      let availableGold;
      {
        availableGold = BigInt(this.player.gold() || 0n);
      }

      if (type !== UNIT.MissileSilo) return availableGold;

      // The nuclear reserve cannot be used until a silo exists. Applying it to
      // the first silo creates a circular dependency: the planner saves for a
      // weapon it has no launcher for and treats the launcher as unaffordable.
      // Once any silo is built, preserve the reserve for subsequent offensive
      // silo construction and upgrades as before.
      if (this.ownedLevels(UNIT.MissileSilo) === 0) return availableGold;

      let reserve;
      {
        reserve = this.legendaryReserveGold();
      }
      return availableGold > reserve ? availableGold - reserve : 0n;
    }

    /**
     * Productive structures use their real next-build price under win-fixes.
     * The old MIRV save-up multiplier made a City increasingly unaffordable
     * while the bot was still trying to grow, even though the same gold was
     * enough to build it. Offensive structures retain the perceived-cost guard.
     */
    getConstructionCost(type) {
      if (
        state.settings.winFixes &&
        ECONOMIC_STRUCTURE_TYPES.includes(type)
      ) {
        return this.cost(type);
      }
      return this.getPerceivedCost(type);
    }

    economicStructurePortfolio() {
      const portfolio = new Map();
      for (const type of ECONOMIC_STRUCTURE_TYPES) {
        portfolio.set(type, this.player.units(type) || []);
      }
      return portfolio;
    }

    economicStructureLevelTotal(units) {
      let total = 0;
      for (const unit of units) {
        total += this.unitUnderConstruction(unit) ? 1 : unit.level();
      }
      return total;
    }

    economicConstructionPressure(portfolio = null) {
      if (!state.settings.winFixes) return null;

      const config = this.game.config();
      const citiesDisabled = config.isUnitDisabled(UNIT.City);
      const cityUnits = portfolio?.get(UNIT.City);
      let cityCount;
      if (citiesDisabled) {
        cityCount = Math.max(
          1,
          Math.floor(this.player.numTilesOwned() / TILES_PER_CITY_EQUIVALENT),
        );
      } else if (cityUnits === undefined) {
        cityCount = this.ownedLevels(UNIT.City);
      } else {
        cityCount = this.economicStructureLevelTotal(cityUnits);
      }
      const hasCoastalTiles = this._hasCoastalTiles === true;
      const hasOceanPortTiles = this._hasOceanPortTiles === true;
      const candidates = [UNIT.Port, UNIT.Factory, UNIT.City];

      for (const type of candidates) {
        if (config.isUnitDisabled(type) || !autoBotBuildAllowed(type)) continue;
        const units = portfolio?.get(type) ?? this.player.units(type) ?? [];
        if (units.some((unit) => this.unitUnderConstruction(unit))) continue;
        if (
          !this.economicCandidateEligible(type, units, {
            cityCount,
            hasCoastalTiles,
            hasOceanPortTiles,
          })
        ) continue;
        const cost = this.safeConstructionCost(type);
        if (cost === null) continue;
        // Saving toward an eligible economic structure is itself productive
        // pressure. Requiring it to be affordable first would let a 3M SAM
        // level consume the exact gold that was accumulating for it.
        return { type, cost };
      }
      return null;
    }

    unitUnderConstruction(unit) {
      return Boolean(
        unit &&
          typeof unit.isUnderConstruction === "function" &&
          unit.isUnderConstruction(),
      );
    }

    economicCandidateEligible(type, units, context) {
      // The normal Nation order always gives City a final build/upgrade chance.
      if (type === UNIT.City) return true;
      if (type === UNIT.Port && !context.hasOceanPortTiles) return false;
      return (
        units.length === 0 ||
        this.shouldBuildStructure(
          type,
          context.cityCount,
          context.hasCoastalTiles,
        )
      );
    }

    safeConstructionCost(type) {
      {
        return this.getConstructionCost(type);
      }
    }

    /**
     * Return whether an offensive structure must leave room for the next
     * productive and defensive actions. This prevents the first silo or a
     * requested silo upgrade from crowding out the economy/SAM response, while
     * still allowing it when the surplus covers all three spends.
     */
    shouldReserveEconomicGrowthForOffense(type) {
      if (type !== UNIT.MissileSilo || !state.settings.winFixes) return false;

      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.defensiveConstructionReserve();
      if (reserve === 0n) return false;

      let offensiveCost;
      {
        offensiveCost = this.getConstructionCost(type);
      }
      return this.spendableConstructionGold() < reserve + offensiveCost;
    }

    /**
     * Return the next SAM spend required by a live missile threat. The
     * trajectory forecast remains in the active-missile path; this cheap
     * pressure signal only reserves the next SAM site/level before a nuke is
     * allowed to consume the same surplus.
     */
    defensiveConstructionPressure() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return null;
      }
      if (!this.hasObservedHostileMissileLaunch()) return null;

      {
        const config = this.game.config();
        if (
          typeof config.isUnitDisabled === "function" &&
          config.isUnitDisabled(UNIT.SAMLauncher)
        ) {
          return null;
        }
      }
      if (!this.hasDefensiveSamPressure()) return null;
      const cost = this.safeConstructionCost(UNIT.SAMLauncher);
      return cost === null ? null : { type: UNIT.SAMLauncher, cost };
    }

    /**
     * Reserve one Defense Post early enough for its construction time, but only
     * against a meaningful land attack by a strategic player. This reserve is
     * consumed exclusively by offensive Silo/nuke budget checks; productive
     * buildings and SAMs retain access to the same gold.
     */
    preemptiveDefensePostPressure() {
      if (
        !state.settings.winFixes ||
        !autoBotBuildAllowed(UNIT.DefensePost) ||
        currentDifficulty() === Difficulty.Easy ||
        !this.hasPriorStructureForDefensePost()
      ) {
        return null;
      }
      if (this.game.config().isUnitDisabled(UNIT.DefensePost)) return null;

      const ourTroops = Number(this.player.troops() || 0);
      if (ourTroops <= 0) return null;
      const strategicLandAttacks = this.player
        .incomingAttacks()
        .filter((attack) => {
          if (!this.isActiveIncomingAttack(attack)) return false;
          if (!this.isLandAttack(attack)) return false;
          return this.isStrategicLandAttack(attack);
        });
      const incomingTroops = strategicLandAttacks.reduce(
        (sum, attack) => sum + Math.max(0, Number(attack.troops?.() || 0)),
        0,
      );
      if (
        incomingTroops / ourTroops < PREEMPTIVE_DEFENSE_POST_THREAT_RATIO
      ) {
        return null;
      }
      const cost = this.safeConstructionCost(UNIT.DefensePost);
      return cost === null ? null : { type: UNIT.DefensePost, cost };
    }

    defensiveConstructionReserve() {
      return (
        (this.defensiveConstructionPressure()?.cost ?? 0n) +
        (this.preemptiveDefensePostPressure()?.cost ?? 0n)
      );
    }

    ownedSamUnits() {
      const tick = safeStructureGameTick(this.game);
      if (Number.isFinite(tick) && this._ownedSamUnitsTick === tick) {
        return this._ownedSamUnitsCache;
      }
      const sams = this.player.units(UNIT.SAMLauncher) || [];
      if (Number.isFinite(tick)) {
        this._ownedSamUnitsTick = tick;
        this._ownedSamUnitsCache = sams;
      }
      return sams;
    }

    singleSamHostileSiloReplacementReserve() {
      if (!state.settings.winFixes || !this.hasPlacedSiloOnMap()) return 0n;
      const sams = this.ownedSamUnits();
      if (sams.length > 1) return 0n;
      return this.safeConstructionCost(UNIT.SAMLauncher) ?? 0n;
    }

    offensiveNukeDefenseReserve() {
      return (
        this.defensiveConstructionReserve() +
        this.singleSamHostileSiloReplacementReserve()
      );
    }

    hasDefensiveSamPressure() {
      if (this.hydrogenCoverageNeedsSam()) return true;
      {
        if (this.shouldBuildHostileSiloSam() || this.samLevelParityGap() > 0) {
          return true;
        }
      }
      return this.activeMissileNeedsFirstSam();
    }

    hydrogenCoverageNeedsSam() {
      {
        const coverage = this.hydrogenStructureCoveragePlan();
        return Boolean(
          coverage &&
            (coverage.needsNewSam || coverage.targetLevel > coverage.currentLevel),
        );
      }
    }

    activeMissileNeedsFirstSam() {
      {
        const signal = this.missileDefenseSignalSnapshot();
        const sams = this.ownedSamUnits();
        return signal?.hasActiveHostileMissile === true && sams.length === 0;
      }
    }

    /**
     * Keep an offensive nuke from consuming the exact surplus needed by the
     * next productive build and the next SAM action. NukeBehavior supplies the
     * actual perceived nuke cost and owns the emergency/retaliation exceptions.
     */
    shouldDeferOffensiveNuke(nukeCost = 0n) {
      if (!state.settings.winFixes) return false;
      if (this.hasActiveMaritimeInvasion()) return true;

      let cost;
      {
        cost = BigInt(nukeCost || 0n);
      }
      if (cost <= 0n) return false;

      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.offensiveNukeDefenseReserve();
      return this.spendableConstructionGold() < cost + reserve;
    }

    shouldDeferOffensiveWarship(warshipCost = 0n) {
      if (!state.settings.winFixes) return false;
      const cost = BigInt(warshipCost || 0n);
      if (cost <= 0n) return false;
      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.offensiveNukeDefenseReserve();
      return this.spendableConstructionGold() < cost + reserve;
    }

    shouldDeferWarshipForFirstSam(warshipCost = 0n) {
      if (!state.settings.winFixes || !this.hasPlacedSiloOnMap()) return false;
      const sams = this.ownedSamUnits();
      // Once the first launcher exists, including while it is being built, the
      // maritime emergency may respond normally. Until then, a visible Silo's
      // hard reserve cannot be bypassed by the emergency Warship path.
      if (sams.length > 0) return false;
      const samCost = this.safeConstructionCost(UNIT.SAMLauncher);
      if (samCost === null) return true;
      const cost = BigInt(warshipCost || 0n);
      return this.spendableConstructionGold() < samCost + cost;
    }

    // WIN-FIX: a hostile border with a larger troop ceiling makes economic
    // growth the safer response; the caller passes the cached snapshot so the
    // high-starting-gold and normal build gates share one border scan.
    shouldPrioritizeEconomicGrowth(borderTroopAdvantage = null) {
      if (!state.settings.winFixes) return false;
      if (
        (borderTroopAdvantage === null &&
          this.hasBorderingHostileMaxTroopAdvantage()) ||
        borderTroopAdvantage === true
      ) {
        return true;
      }
      if (this.hasHostileReachedSiloGoldThreshold() === false) return true;
      return this.economicConstructionPressure() !== null;
    }

    // The capacity comparison deliberately uses maxTroops, not current troops:
    // current armies fluctuate every tick while the construction response is
    // meant to close a structural force-generation gap.
    hasBorderingHostileMaxTroopAdvantage() {
      const rawTick = safeStructureGameTick(this.game);
      const snapshotTick = Number.isFinite(rawTick) ? rawTick : null;

      if (
        snapshotTick !== null &&
        this._borderingHostileMaxTroopAdvantageTick === snapshotTick &&
        typeof this._borderingHostileMaxTroopAdvantage === "boolean"
      ) {
        return this._borderingHostileMaxTroopAdvantage;
      }

      const hasAdvantage = this.computeBorderingHostileTroopAdvantage();

      if (snapshotTick !== null) {
        this._borderingHostileMaxTroopAdvantageTick = snapshotTick;
        this._borderingHostileMaxTroopAdvantage = hasAdvantage;
      }
      return hasAdvantage;
    }

    computeBorderingHostileTroopAdvantage() {
      let config;
      {
        config = this.game.config();
      }
      if (!config || typeof config.maxTroops !== "function") return false;
      const ownMaxTroops = this.safeMaxTroops(config, this.player);
      if (ownMaxTroops <= 0) return false;
      const hostilePlayers = this.liveHostilePlayers();
      if (!Array.isArray(hostilePlayers)) return false;
      const borderingOwnerIds = this.borderingLandOwnerIds();
      if (borderingOwnerIds !== null) {
        return hostilePlayers.some(
          (enemy) =>
            borderingOwnerIds.has(enemy.smallID()) &&
            this.safeMaxTroops(config, enemy) > ownMaxTroops,
        );
      }
      if (typeof this.player?.sharesBorderWith !== "function") return false;
      return hostilePlayers.some(
        (enemy) =>
          this.safeSharesBorder(enemy) &&
          this.safeMaxTroops(config, enemy) > ownMaxTroops,
      );
    }

    borderingLandOwnerIds() {
      if (typeof this.player?.borderTiles !== "function") return null;
      if (typeof this.game?.neighbors !== "function") return null;
      if (typeof this.game?.isLand !== "function") return null;
      if (typeof this.game?.ownerID !== "function") return null;

      const ownSid = this.player.smallID();
      const ownerIds = new Set();
      for (const borderTile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(borderTile)) {
          if (!this.game.isLand(neighbor)) continue;
          const ownerSid = this.game.ownerID(neighbor);
          if (ownerSid == null || ownerSid === ownSid) continue;
          ownerIds.add(ownerSid);
        }
      }
      return ownerIds;
    }

    safeMaxTroops(config, player) {
      {
        const troops = Number(config.maxTroops(player));
        return Number.isFinite(troops) ? troops : 0;
      }
    }

    safeSharesBorder(enemy) {
      {
        return this.player.sharesBorderWith(enemy) === true;
      }
    }

    legendaryFriendlyPlayers() {
      const mySid = this.player.smallID();
      const friendly = [];
      {
        for (const other of this.game.players()) {
          if (
            !other ||
            (typeof other.isPlayer === "function" && !other.isPlayer()) ||
            other.smallID() === mySid
          ) {
            continue;
          }
          const isFriendly =
            this.player.isFriendly(other) || this.player.isOnSameTeam(other);
          if (isFriendly && other.isAlive() !== false) friendly.push(other);
        }
      }
      return friendly;
    }

    legendaryProductionMetrics(player) {
      const troops = Math.max(0, Number(player.troops() || 0));
      const gold = BigInt(player.gold() || 0n);
      let goldProduction = 0;
      const tiles = [];
      const samUnits = [];
      {
        for (const unit of player.units(UNIT.City, UNIT.Factory, UNIT.Port)) {
          const metrics = this.legendaryProductiveUnitMetrics(unit);
          if (metrics.tile !== null) tiles.push(metrics.tile);
          goldProduction += metrics.goldProduction;
        }
        for (const sam of player.units(UNIT.SAMLauncher)) {
          if (sam.isUnderConstruction()) continue;
          samUnits.push(sam);
          const tile = sam.tile();
          if (tile !== null && tile !== undefined) tiles.push(tile);
        }
      }
      return { troops, gold, goldProduction, tiles, samUnits };
    }

    legendaryProductiveUnitMetrics(unit) {
      const rawTile = unit.tile();
      const tile = rawTile === null || rawTile === undefined ? null : rawTile;
      const connected =
        typeof unit.hasTrainStation === "function" && unit.hasTrainStation();
      if (!connected) return { tile, goldProduction: 0 };
      const cityMultiplier = unit.type() === UNIT.City ? 1 : 0.25;
      return {
        tile,
        goldProduction: this.trainGoldBase("ally", 1) * cityMultiplier,
      };
    }

    legendaryAllyPlacementContext() {
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._legendaryAllyPlacementContextTick === tick
      ) {
        return this._legendaryAllyPlacementContextCache;
      }
      const own = this.legendaryProductionMetrics(this.player);
      const config = this.safeGameConfig();
      const supportRadius = Math.max(
        1,
        Number(config.trainStationMaxRange()),
      );

      const allies = [];
      for (const ally of this.legendaryFriendlyPlayers()) {
        const metrics = this.legendaryProductionMetrics(ally);
        let location;
        {
          location = ally.nameLocation();
        }
        allies.push({
          player: ally,
          ...metrics,
          samProfiles: this.legendaryAllySupportSamProfiles(
            metrics.samUnits,
            config,
          ),
          location,
          power: legendaryAllyPowerScore({
            allyTroops: metrics.troops,
            allyGold: metrics.gold,
            allyProduction: metrics.goldProduction,
            ownTroops: own.troops,
            ownGold: own.gold,
            ownProduction: own.goldProduction,
          }),
        });
      }
      const context = { own, allies, supportRadius, samConfig: config };
      if (Number.isFinite(tick)) {
        this._legendaryAllyPlacementContextTick = tick;
        this._legendaryAllyPlacementContextCache = context;
      }
      return context;
    }

    legendaryTeamCenterPlacementContext() {
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._legendaryTeamCenterPlacementContextTick === tick
      ) {
        return this._legendaryTeamCenterPlacementContextCache;
      }
      const participants = [this.player, ...this.legendaryFriendlyPlayers()];
      const points = [];
      for (const participant of participants) {
        points.push(...this.legendaryParticipantCenterPoints(participant));
      }

      if (points.length === 0) {
        if (Number.isFinite(tick)) {
          this._legendaryTeamCenterPlacementContextTick = tick;
          this._legendaryTeamCenterPlacementContextCache = null;
        }
        return null;
      }
      const center = points.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 },
      );
      center.x /= points.length;
      center.y /= points.length;

      const centerTile = this.legendaryCenterTile(center);
      const nearest = this.nearestOwnBorderToPoint(center);

      const context = {
        x: center.x,
        y: center.y,
        tile: centerTile,
        nearestBorder: nearest.tile,
        nearestBorderDistanceSquared: nearest.distanceSquared,
      };
      if (Number.isFinite(tick)) {
        this._legendaryTeamCenterPlacementContextTick = tick;
        this._legendaryTeamCenterPlacementContextCache = context;
      }
      return context;
    }

    legendaryParticipantCenterPoints(participant) {
      const border = this.safeParticipantBorder(participant);
      if (border?.size > 0) return this.sampleBorderPoints(border);
      const points = this.participantStructurePoints(participant);
      const location = this.safeParticipantLocation(participant);
      if (location !== null) points.push(location);
      return points;
    }

    safeParticipantBorder(participant) {
      {
        return participant.borderTiles();
      }
    }

    sampleBorderPoints(border) {
      const points = [];
      const stride = Math.max(1, Math.ceil(border.size / 2000));
      let index = 0;
      for (const tile of border) {
        if (index++ % stride !== 0) continue;
        points.push({ x: this.game.x(tile), y: this.game.y(tile) });
      }
      return points;
    }

    participantStructurePoints(participant) {
      {
        return participant
          .units(UNIT.City, UNIT.Factory, UNIT.Port, UNIT.SAMLauncher)
          .map((unit) => unit.tile())
          .filter((tile) => tile !== null && tile !== undefined)
          .map((tile) => ({ x: this.game.x(tile), y: this.game.y(tile) }));
      }
    }

    safeParticipantLocation(participant) {
      {
        const location = participant.nameLocation();
        if (!location) return null;
        if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) return null;
        return { x: Number(location.x), y: Number(location.y) };
      }
    }

    legendaryCenterTile(center) {
      {
        const x = Math.round(center.x);
        const y = Math.round(center.y);
        return this.game.isValidCoord(x, y) ? this.game.ref(x, y) : null;
      }
    }

    nearestOwnBorderToPoint(point) {
      let nearest = { tile: null, distanceSquared: Infinity };
      {
        for (const tile of this.player.borderTiles()) {
          const dx = this.game.x(tile) - point.x;
          const dy = this.game.y(tile) - point.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= nearest.distanceSquared) continue;
          nearest = { tile, distanceSquared };
        }
      }
      return nearest;
    }

    legendaryAllySupportPlacementScore(tile, type, context = null) {
      if (!ECONOMIC_STRUCTURE_TYPES.includes(type)) return 0;
      const placement = context || this.legendaryAllyPlacementContext();
      if (!placement || placement.allies.length === 0) return 0;
      const spacing = this.spacingConstants().structureSpacing;
      const samConfig = placement.samConfig || this.safeGameConfig();
      let strongest = 0;
      let secondStrongest = 0;
      for (const ally of placement.allies) {
        const supportScore = this.legendarySingleAllySupportScore(
          tile,
          ally,
          placement,
          samConfig,
        );
        if (supportScore > strongest) {
          secondStrongest = strongest;
          strongest = supportScore;
        } else if (supportScore > secondStrongest) {
          secondStrongest = supportScore;
        }
      }
      const combined = Math.min(
        5,
        strongest + 0.35 * secondStrongest,
      );
      return spacing * combined;
    }

    safeGameConfig() {
      {
        return this.game.config();
      }
    }

    legendarySingleAllySupportScore(tile, ally, placement, samConfig) {
      const distance = this.legendaryAllyDistance(tile, ally);
      const proximity = Number.isFinite(distance)
        ? legendaryPlacementProximityScore(distance, placement.supportRadius)
        : 0;
      const samSupport = this.legendaryAllySamSupport(tile, ally, samConfig);
      return ally.power * proximity + samSupport;
    }

    legendaryAllySupportSamProfiles(samUnits, config) {
      if (!config || typeof config.samRange !== "function") return [];
      return (samUnits || []).map((sam) => {
        const level = Math.max(1, Number(sam.level?.() || 1));
        return {
          tile: sam.tile?.(),
          level,
          range: Number(config.samRange(level)),
        };
      });
    }

    legendaryAllyDistance(tile, ally) {
      let nearestSquared = Infinity;
      for (const allyTile of ally.tiles) {
        nearestSquared = Math.min(
          nearestSquared,
          this.game.euclideanDistSquared(tile, allyTile),
        );
      }
      if (Number.isFinite(nearestSquared)) return Math.sqrt(nearestSquared);
      if (!ally.location) return Infinity;
      const x = Number(ally.location.x);
      const y = Number(ally.location.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
      const dx = this.game.x(tile) - x;
      const dy = this.game.y(tile) - y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    legendaryAllySamSupport(tile, ally, config) {
      if (!config) return 0;
      let support = 0;
      const samProfiles = Array.isArray(ally.samProfiles)
        ? ally.samProfiles
        : this.legendaryAllySupportSamProfiles(ally.samUnits, config);
      for (const sam of samProfiles) {
        const level = Math.max(1, Number(sam.level || 1));
        const range = Number(sam.range);
        if (range <= 0) continue;
        const distance = Math.sqrt(
          this.game.euclideanDistSquared(tile, sam.tile),
        );
        if (distance > range) continue;
        support = Math.max(
          support,
          level * legendaryPlacementProximityScore(distance, range),
        );
      }
      return support;
    }

    legendaryTeamCenterPlacementScore(tile, context = null) {
      const center = context || this.legendaryTeamCenterPlacementContext();
      if (!center) return 0;
      const spacing = this.spacingConstants().structureSpacing;
      let centerDistance;
      {
        const dx = this.game.x(tile) - center.x;
        const dy = this.game.y(tile) - center.y;
        centerDistance = Math.sqrt(dx * dx + dy * dy);
      }

      let borderDistance = Infinity;
      if (center.nearestBorder !== null) {
        borderDistance = Math.sqrt(
          this.game.euclideanDistSquared(tile, center.nearestBorder),
        );
      }
      let radius = spacing;
      {
        radius = Math.max(radius, Number(this.game.config().trainStationMaxRange()));
      }
      const centerScore = legendaryPlacementProximityScore(centerDistance, radius);
      const borderScore = Number.isFinite(borderDistance)
        ? legendaryPlacementProximityScore(borderDistance, radius)
        : 0;
      // The border term is dominant: this explicitly selects the own border
      // segment closest to the team's geometric center, then favors tiles near
      // the center itself as the tie-break.
      return spacing * (1.5 * borderScore + 0.5 * centerScore);
    }

    enemyMissileSiloPressure() {
      return this.enemyMissileSiloCapacityTarget();
    }

    // Custom missile parity target: count the projected level sum of each
    // hostile player's relevant unit and choose the strongest single opponent.
    // An under-construction unit counts as one future level so the target does
    // not lag behind a unit that is about to complete.
    enemyUnitCapacityParityTarget(type, maxCapacity) {
      const enemyUnitLevels = [];
      for (const enemy of this.legendaryHostilePlayers()) {
        const levels = this.enemyProjectedUnitLevels(enemy, type);
        if (levels.length > 0) enemyUnitLevels.push(levels);
      }
      return maxCapacity(enemyUnitLevels);
    }

    enemyProjectedUnitLevels(enemy, type) {
      {
        if (enemy.isAlive && enemy.isAlive() === false) return [];
        return (enemy.units(type) || [])
          .map((unit) => this.projectedUnitLevel(unit))
          .filter((level) => level !== null);
      }
    }

    projectedUnitLevel(unit) {
      if (unit.isUnderConstruction && unit.isUnderConstruction()) return 1;
      if (unit.isActive && unit.isActive() === false) return null;
      const level = Number(unit.level?.() ?? 1);
      return Number.isFinite(level) ? Math.max(1, Math.floor(level)) : null;
    }

    enemySamCapacityParityTarget() {
      return this.enemyUnitCapacityParityTarget(
        UNIT.SAMLauncher,
        legendaryMaxEnemySamCapacity,
      );
    }

    enemyMissileSiloCapacityParityTarget() {
      return this.enemyUnitCapacityParityTarget(
        UNIT.MissileSilo,
        legendaryMaxEnemySiloCapacity,
      );
    }

    enemyUnitCapacityTarget(type) {
      if (type === UNIT.MissileSilo) {
        return this.hostileMissileSiloCapacitySummary()?.hostileSiloCapacity ?? 0;
      }
      const hostile = this.liveHostilePlayers();
      if (hostile === null) return 0;
      let capacity = 0;
      for (const enemy of hostile) {
        const metrics = this.playerUnitCapacitySummary(enemy, type);
        if (metrics !== null) capacity += metrics.capacity;
      }
      return capacity;
    }

    enemyMissileSiloCapacityTarget() {
      // Unlike offensive target selection, defensive capacity must include
      // every live hostile silo: all of them can contribute to one salvo.
      return this.enemyUnitCapacityTarget(UNIT.MissileSilo);
    }

    missileSiloParityTarget() {
      return state.settings.winFixes ? this.enemySamCapacityParityTarget() : 0;
    }

    missileSiloParityGap() {
      return Math.max(
        0,
        this.missileSiloParityTarget() - this.ownedLevels(UNIT.MissileSilo),
      );
    }

    ownMaximumSamLevel() {
      let maximum = 0;
      for (const sam of this.player.units(UNIT.SAMLauncher) || []) {
        {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) continue;
          if (sam.isActive && sam.isActive() === false) continue;
          const level = Number(sam.level?.() ?? 1);
          if (Number.isFinite(level)) {
            maximum = Math.max(maximum, Math.max(1, Math.floor(level)));
          }
        }
      }
      return maximum;
    }

    samLevelParityTarget() {
      return state.settings.winFixes
        // Match the documented parity rule: compare against the strongest
        // hostile player's Silo network, not the sum of unrelated enemies.
        ? this.enemyMissileSiloCapacityParityTarget()
        : 0;
    }

    samLevelParityGap() {
      return Math.max(0, this.samLevelParityTarget() - this.ownSamCapacity());
    }

    /**
     * Returns the greatest built-silo level sum belonging to one live hostile
     * player. A level-1 Silo contributes one; under-construction Silos are not
     * included because this is the current threat, not a future projection.
     */
    hostileSiloLevelSumTarget() {
      const hostilePlayers = this.liveHostilePlayers();
      if (!Array.isArray(hostilePlayers)) return 0;

      let maximum = 0;
      for (const enemy of hostilePlayers) {
        maximum = Math.max(maximum, this.hostileBuiltSiloLevelSum(enemy));
      }
      return maximum;
    }

    // A placed silo network belonging to any *other* live player changes our
    // defensive requirement immediately, without waiting for construction to
    // finish. A Silo completes faster than a SAM, so treating only operational
    // launchers as the upgrade trigger forfeits the preventive window. Allies
    // can become enemies as well. Keep the target per player: unrelated
    // level-one silos must not be added into a fictitious single salvo.
    externalSiloLevelSumTarget() {
      if (!this.player || !this.game || typeof this.game.players !== "function") {
        return this.hostileSiloLevelSumTarget();
      }
      const mySid = this.readPlayerSmallId(this.player);
      let maximum = 0;
      for (const other of this.game.players()) {
        if (!this.isLiveOtherPlayer(other, mySid)) continue;
        const capacity = this.playerUnitCapacitySummary(
          other,
          UNIT.MissileSilo,
        )?.capacity ?? 0;
        maximum = Math.max(maximum, capacity);
      }
      return maximum;
    }

    hostileBuiltSiloLevelSum(enemy) {
      {
        if (enemy.isAlive && enemy.isAlive() === false) return 0;
        let sum = 0;
        for (const silo of enemy.units(UNIT.MissileSilo) || []) {
          if (silo.isUnderConstruction && silo.isUnderConstruction()) continue;
          if (silo.isActive && silo.isActive() === false) continue;
          const level = Number(silo.level?.() ?? 1);
          if (Number.isFinite(level)) sum += Math.max(1, Math.floor(level));
        }
        return sum;
      }
    }

    hostileSiloLevelSumAtLeast(
      threshold = HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD,
    ) {
      return this.hostileSiloLevelSumTarget() >= threshold;
    }

    shouldPrioritizeHydrogenSamProtection(
      externalSiloLevelSum = this.externalSiloLevelSumTarget(),
    ) {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return false;
      }
      {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
        if (this.game.config().isUnitDisabled(UNIT.HydrogenBomb)) return false;
      }
      return externalSiloLevelSum >= HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD;
    }

    /**
     * A completed hostile Silo can launch an H-bomb at level one, so establish
     * level two on our first built SAM immediately. Higher enemy Silo capacity
     * may still raise the target afterwards. This remains a cheap capacity rule
     * and avoids scanning every structure during each construction tick.
     */
    hydrogenSamProtectionPlan() {
      const externalSiloLevelSum = this.externalSiloLevelSumTarget();
      if (!this.shouldPrioritizeHydrogenSamProtection(externalSiloLevelSum)) {
        return null;
      }

      const targetLevel = Math.min(
        HYDROGEN_SAM_MAX_UPGRADE_LEVEL,
        Math.max(
          HYDROGEN_SAM_MINIMUM_READY_LEVEL,
          externalSiloLevelSum >= 2
            ? HYDROGEN_SAM_MAX_UPGRADE_LEVEL
            : externalSiloLevelSum,
        ),
      );
      const sams = (this.player.units(UNIT.SAMLauncher) || []).filter((sam) => {
        {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) return false;
          return !sam.isActive || sam.isActive() !== false;
        }
      });
      if (targetLevel < HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD || sams.length === 0) {
        return null;
      }

      const criticalEntries = this.samCriticalStructureEntries();
      const targetRangeSquared = this.samRangeSquared(this.game.config(), targetLevel);
      const candidates = [];
      for (const sam of sams) {
        const currentLevel = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
        if (
          Number.isFinite(currentLevel) &&
          currentLevel < HYDROGEN_SAM_MAX_UPGRADE_LEVEL
        ) {
          candidates.push({
            sam,
            currentLevel,
            protectionScore: this.samCriticalCoverageScoreForEntries(
              sam.tile(),
              targetRangeSquared,
              criticalEntries,
            ),
          });
        }
      }
      if (candidates.length === 0) return null;

      // A defensive upgrade is only as valuable as the buildings that remain
      // inside its eventual level-five envelope.  When more than one launcher
      // exists, prefer the one centred on the most expensive connected clump;
      // choosing the numerically highest level could otherwise keep improving
      // an isolated coastal SAM while the economic core stays at level one.
      candidates.sort((left, right) => {
        const protectionDifference = right.protectionScore - left.protectionScore;
        if (protectionDifference !== 0) return protectionDifference;
        return right.currentLevel - left.currentLevel;
      });
      const selected = candidates[0];
      return {
        sam: selected.sam,
        currentLevel: selected.currentLevel,
        targetLevel,
      };
    }

    hydrogenStructureCoveragePlan() {
      const input = this.hydrogenStructureCoverageInputs();
      if (input === null) return null;
      if (this._hydrogenStructureCoveragePlanKey === input.key) {
        return this._hydrogenStructureCoveragePlanCache;
      }
      const plan = this.computeHydrogenStructureCoveragePlan(input);
      this._hydrogenStructureCoveragePlanKey = input.key;
      this._hydrogenStructureCoveragePlanCache = plan;
      return plan;
    }

    hydrogenStructureCoverageInputs() {
      if (
        !state.settings.winFixes ||
        !autoBotBuildAllowed(UNIT.SAMLauncher)
      ) {
        return null;
      }
      const hostileSiloLevelSum = this.hostileSiloLevelSumTarget();
      if (hostileSiloLevelSum < HOSTILE_SILO_SAM_COVERAGE_LEVEL_SUM_THRESHOLD) {
        return null;
      }
      const config = this.hydrogenCoverageConfig();
      if (config === null) return null;
      const structures = this.ownedStructureTiles();
      if (structures.length === 0) return null;
      const sams = [];
      for (const sam of this.player.units(UNIT.SAMLauncher) || []) {
        if (!this.isBuiltActiveSam(sam)) continue;
        const tile = sam.tile();
        const level = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
        if (tile === null || tile === undefined || !Number.isFinite(level)) continue;
        sams.push({ sam, tile, level });
      }
      return {
        config,
        structures,
        sams,
        key: [
          hostileSiloLevelSum,
          structures.join(","),
          sams
            .map(({ sam, tile, level }, index) =>
              [sam.id?.() ?? index, tile, level].join(":"),
            )
            .join(","),
        ].join("|"),
      };
    }

    computeHydrogenStructureCoveragePlan(input = null) {
      const coverage = input || this.hydrogenStructureCoverageInputs();
      if (coverage === null) return null;
      const { config, structures, sams } = coverage;
      if (sams.length === 0) return { needsNewSam: true };
      if (
        this.hydrogenCoveredStructureCount(sams, structures, config) ===
        structures.length
      ) return null;
      return (
        this.bestHydrogenCoverageUpgrade(sams, structures, config) || {
          needsNewSam: true,
        }
      );
    }

    hydrogenCoverageConfig() {
      {
        const config = this.game.config();
        if (config.isUnitDisabled(UNIT.SAMLauncher)) return null;
        if (config.isUnitDisabled(UNIT.HydrogenBomb)) return null;
        return typeof config.samRange === "function" ? config : null;
      }
    }

    ownedStructureTiles() {
      const tiles = [];
      for (const type of STRUCTURES_TYPES) {
        {
          for (const structure of this.player.units(type) || []) {
            const tile = structure.tile();
            if (tile !== null && tile !== undefined) tiles.push(tile);
          }
        }
      }
      return tiles;
    }

    isBuiltActiveSam(sam) {
      {
        if (sam.isUnderConstruction && sam.isUnderConstruction()) return false;
        return !sam.isActive || sam.isActive() !== false;
      }
    }

    samCriticalCoverageScore(sam, level) {
      const tile = sam?.tile?.();
      const config = this.game?.config?.();
      if (tile === null || tile === undefined || !config) return 0;
      const rangeSquared = this.samRangeSquared(config, level);
      if (rangeSquared <= 0) return 0;
      return this.samCriticalCoverageScoreForEntries(
        tile,
        rangeSquared,
        this.samCriticalStructureEntries(),
      );
    }

    samCriticalStructureEntries() {
      const entries = [];
      for (const type of SAM_PROTECTABLE_STRUCTURE_TYPES) {
        for (const structure of this.player.units(type) || []) {
          const tile = structure?.tile?.();
          if (tile === null || tile === undefined) continue;
          entries.push({ tile, weight: this.samCriticalStructureWeight(structure) });
        }
      }
      return entries;
    }

    samCriticalCoverageScoreForEntries(tile, rangeSquared, entries) {
      let score = 0;
      for (const structure of entries) {
        const distanceSquared = this.game.euclideanDistSquared(tile, structure.tile);
        if (distanceSquared > rangeSquared) continue;
        // Weight plus centred closeness keeps the upgrade on the heart of
        // the valuable group, not merely its outer edge.
        score += structure.weight * (2 - distanceSquared / rangeSquared);
      }
      return score;
    }

    samRangeSquared(config, level) {
      {
        const range = Number(config.samRange(level));
        return Number.isFinite(range) && range > 0 ? range * range : 0;
      }
    }

    samCoveredStructureCount(sam, level, structures, config) {
      let samTile;
      {
        samTile = sam.tile();
      }
      const rangeSquared = this.samRangeSquared(config, level);
      return structures.filter((structureTile) => {
        {
          return (
            this.game.euclideanDistSquared(samTile, structureTile) <= rangeSquared
          );
        }
      }).length;
    }

    hydrogenCoveredStructureCount(
      sams,
      structures,
      config,
      upgradedSam = null,
      upgradedLevel = null,
    ) {
      let covered = 0;
      for (const structureTile of structures) {
        const protectedByAny = sams.some((sam) => {
          const level =
            sam === upgradedSam
              ? upgradedLevel
              : sam.level;
          return (
            this.game.euclideanDistSquared(sam.tile, structureTile) <=
            this.samRangeSquared(config, level)
          );
        });
        if (protectedByAny) covered++;
      }
      return covered;
    }

    bestHydrogenCoverageUpgrade(sams, structures, config) {
      const currentCovered = this.hydrogenCoveredStructureCount(
        sams,
        structures,
        config,
      );
      let bestPlan = null;
      for (const sam of sams) {
        const currentLevel = sam.level;
        if (
          !Number.isFinite(currentLevel) ||
          currentLevel >= HYDROGEN_SAM_MAX_UPGRADE_LEVEL
        ) {
          continue;
        }
        for (
          let targetLevel = currentLevel + 1;
          targetLevel <= HYDROGEN_SAM_MAX_UPGRADE_LEVEL;
          targetLevel++
        ) {
          const covered = this.hydrogenCoveredStructureCount(
            sams,
            structures,
            config,
            sam,
            targetLevel,
          );
          if (covered <= currentCovered) continue;
          const candidate = {
            sam: sam.sam,
            currentLevel,
            targetLevel,
            coveredPoints: covered,
            totalPoints: structures.length,
            complete: covered === structures.length,
          };
          if (this.isBetterHydrogenCoveragePlan(candidate, bestPlan)) {
            bestPlan = candidate;
          }
          if (candidate.complete) break;
        }
      }
      return bestPlan;
    }

    isBetterHydrogenCoveragePlan(candidate, current) {
      if (current === null) return true;
      if (candidate.complete !== current.complete) return candidate.complete;
      if (candidate.coveredPoints !== current.coveredPoints) {
        return candidate.coveredPoints > current.coveredPoints;
      }
      return candidate.targetLevel < current.targetLevel;
    }

    legendaryRailMetrics(cities, ports, factories) {
      let reachableStations = [];
      {
        reachableStations = this.getOrBuildReachableStations();
      }

      let connectedCities;
      let connectedPorts;
      {
        const config = this.game.config();
        const minRangeSquared = config.trainStationMinRange() ** 2;
        const maxRangeSquared = config.trainStationMaxRange() ** 2;
        const isConnected = (unit) =>
          typeof unit.hasTrainStation === "function" &&
          unit.hasTrainStation() &&
          this.computeConnectivityScore(
            unit.tile(),
            reachableStations,
            minRangeSquared,
            maxRangeSquared,
          ) > 0;
        connectedCities = cities.filter(isConnected).length;
        connectedPorts = ports.filter(isConnected).length;
      }

      const stationDemand = cities.length + ports.length;
      const railNeed = Math.min(
        2.5,
        Math.max(0.25, (stationDemand + 1) / (factories.length + 1)),
      );
      const connectedStations = connectedCities + connectedPorts;
      let cityRailConnection = 0.25;
      if (factories.length > 0) cityRailConnection = 0.75;
      if (connectedStations > 0) cityRailConnection = 1;
      const tradeNeed = Math.min(
        2.5,
        Math.max(0.25, (reachableStations.length + 1) / (ports.length + 1)),
      );

      return {
        connectedCities,
        cityRailConnection,
        railNeed,
        tradeNeed,
      };
    }

    legendaryDefenseGap(protectableStructures, enemySilos) {
      if (protectableStructures.length === 0) {
        return enemySilos > 0 ? 1 : 0.25;
      }

      const sams = this.legendaryFriendlySamUnits();

      let uncovered = 0;
      let samRange;
      {
        samRange = (sam) => this.game.config().samRange(sam.level());
      }

      for (const structure of protectableStructures) {
        const covered = sams.some((sam) => {
          const range = Number(samRange(sam));
          return (
            range > 0 &&
            this.game.euclideanDistSquared(structure.tile(), sam.tile()) <=
              range * range
          );
        });
        if (!covered) uncovered++;
      }

      return Math.min(
        2.5,
        Math.max(
          0.25,
          0.5 + uncovered / protectableStructures.length + enemySilos / Math.max(1, protectableStructures.length),
        ),
      );
    }

    legendaryEnemyTargetPressure() {
      const enemies = this.legendaryHostilePlayers();
      if (enemies.length === 0) return 0.25;

      const ownGold = Number(this.player.gold());
      const ownMaxTroops = Math.max(1, this.game.config().maxTroops(this.player));
      let strongestTarget = 0.25;

      for (const enemy of enemies) {
        const unitCounts = this.legendaryEnemyTargetUnitCounts(enemy);
        const targetValue = (() => {
          const goldRatio = Number(enemy.gold()) / Math.max(1, ownGold);
          const troopRatio =
            this.game.config().maxTroops(enemy) / ownMaxTroops;
          const attackCapacity =
            unitCounts[UNIT.MissileSilo] + unitCounts[UNIT.Warship] / 2;
          const defenseCapacity =
            unitCounts[UNIT.SAMLauncher] + unitCounts[UNIT.Warship] / 2;
          const structureCapacity =
            unitCounts[UNIT.City] + unitCounts[UNIT.Factory] + unitCounts[UNIT.Port];
          return Math.max(
            goldRatio,
            troopRatio,
            attackCapacity / 3,
            defenseCapacity / 3,
            structureCapacity / 5,
          );
        })();
        strongestTarget = Math.max(
          strongestTarget,
          Math.min(2.5, 0.75 + targetValue),
        );
      }
      return strongestTarget;
    }

    legendaryEnemyTargetUnitCounts(enemy) {
      const types = [
        UNIT.MissileSilo,
        UNIT.Warship,
        UNIT.SAMLauncher,
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
      ];
      const counts = Object.fromEntries(types.map((type) => [type, 0]));
      for (const unit of enemy.units(...types) || []) {
        const type = unit.type?.();
        if (Object.hasOwn(counts, type)) counts[type]++;
      }
      return counts;
    }

    legendaryPortSurvivability(ports, enemyWarships) {
      if (ports.length === 0) return 1;
      let covered = 0;
      const sams = this.legendaryFriendlySamUnits();
      for (const port of ports) {
        const safe = sams.some((sam) => {
          const range = Number(this.game.config().samRange(sam.level()));
          return (
            range > 0 &&
            this.game.euclideanDistSquared(port.tile(), sam.tile()) <=
              range * range
          );
        });
        if (safe) covered++;
      }
      const coverage = covered / ports.length;
      const ownWarships = this.player.units(UNIT.Warship).length;
      const shipRisk = Math.min(
        0.25,
        enemyWarships / Math.max(4, enemyWarships + ownWarships + 4),
      );
      return Math.min(1, Math.max(0.35, 0.55 + coverage * 0.45 - shipRisk));
    }

    legendaryCriticalStructureValue(unit) {
      const baseValue = {
        [UNIT.City]: 5,
        [UNIT.Factory]: 4,
        [UNIT.Port]: 4,
        [UNIT.MissileSilo]: 3,
      }[unit.type()];
      return (baseValue ?? 1) * Math.max(1, Number(unit.level() || 1));
    }

    legendaryNukeFlightPath(fromTile, targetTile) {
      const speed = Math.max(1, Number(this.game.config().defaultNukeSpeed()));

      // The map and nuke speed are stable for the lifetime of a game, while a
      // single defense forecast asks for the same source/target parabola from
      // several planner branches. Keep one trajectory per pair so a large
      // salvo does not turn every SAM candidate into another pathfinding pass.
      if (!this._missileFlightPathCache) {
        this._missileFlightPathCache = new Map();
      }
      const cacheKey = `${String(fromTile)}:${String(targetTile)}:${String(speed)}`;
      const cachedPath = this._missileFlightPathCache.get(cacheKey);
      if (cachedPath) return cachedPath;

      let path = [];

      {
        if (
          typeof UniversalPathFinding !== "undefined" &&
          UniversalPathFinding.Parabola
        ) {
          const pathFinder = UniversalPathFinding.Parabola(this.game, {
            increment: speed,
            distanceBasedHeight: true,
            directionUp: true,
          });
          path = pathFinder.findPath(fromTile, targetTile) ?? [];
        }
      }

      if (path.length > 0) {
        this._missileFlightPathCache.set(cacheKey, path);
        return path;
      }

      const distance = Math.sqrt(
        this.game.euclideanDistSquared(fromTile, targetTile),
      );
      const steps = Math.max(1, Math.ceil(distance / speed));
      path = [fromTile];
      {
        const fromX = this.game.x(fromTile);
        const fromY = this.game.y(fromTile);
        const targetX = this.game.x(targetTile);
        const targetY = this.game.y(targetTile);
        for (let step = 1; step <= steps; step++) {
          const x = Math.round(fromX + ((targetX - fromX) * step) / steps);
          const y = Math.round(fromY + ((targetY - fromY) * step) / steps);
          if (!this.game.isValidCoord(x, y)) continue;
          const tile = this.game.ref(x, y);
          if (path[path.length - 1] !== tile) path.push(tile);
        }
      }
      if (path[path.length - 1] !== targetTile) path.push(targetTile);
      this._missileFlightPathCache.set(cacheKey, path);
      return path;
    }

    legendaryNukeFlightTime(fromTile, targetTile) {
      const path = this.legendaryNukeFlightPath(fromTile, targetTile);
      if (path.length > 2) return path.length;
      const speed = Math.max(1, Number(this.game.config().defaultNukeSpeed()));
      return Math.max(
        1,
        Math.ceil(
          Math.sqrt(this.game.euclideanDistSquared(fromTile, targetTile)) /
            speed,
        ),
      );
    }

    legendaryFriendlySamUnits() {
      const mySid = this.player.smallID();
      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._friendlySamUnitsTick === tick &&
        this._friendlySamUnitsPlayerSid === mySid
      ) {
        return this._friendlySamUnitsCache;
      }
      const sams = [];
      const seen = new Set();
      const add = (sam) => {
        if (!sam || sam.isUnderConstruction()) return;
        const id = sam.id();
        if (id !== null && id !== undefined && seen.has(id)) return;
        const owner = sam.owner();
        if (!owner) return;
        let friendly = owner.smallID() === mySid;
        if (!friendly) {
          {
            friendly =
              this.player.isFriendly(owner) || this.player.isOnSameTeam(owner);
          }
        }
        if (!friendly) return;
        if (id !== null && id !== undefined) seen.add(id);
        sams.push(sam);
      };

      if (typeof this.game.units === "function") {
        for (const sam of this.game.units(UNIT.SAMLauncher)) add(sam);
      }
      if (sams.length === 0) {
        const friendlyPlayers =
          typeof this.game.players === "function"
            ? this.legendaryFriendlyPlayers()
            : [];
        for (const participant of [this.player, ...friendlyPlayers]) {
          {
            for (const sam of participant.units(UNIT.SAMLauncher)) add(sam);
          }
        }
      }
      if (Number.isFinite(tick)) {
        this._friendlySamUnitsTick = tick;
        this._friendlySamUnitsPlayerSid = mySid;
        this._friendlySamUnitsCache = sams;
      }
      return sams;
    }

    legendarySamReadySlots(sam, levelOverride = null) {
      if (!sam || sam.isUnderConstruction()) return 0;
      return this.legendarySamSlotAvailability(sam, levelOverride).filter(
        (tick) => tick <= 0,
      ).length;
    }

    legendarySamCooldownTicks() {
      const config = this.game.config();
      if (
        config === this._legendarySamCooldownConfig &&
        Number.isFinite(this._legendarySamCooldownCache)
      ) {
        return this._legendarySamCooldownCache;
      }
      const cooldown = Number(config.SAMCooldown());
      const normalizedCooldown =
        Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 90;
      this._legendarySamCooldownConfig = config;
      this._legendarySamCooldownCache = normalizedCooldown;
      return normalizedCooldown;
    }

    legendarySiloCooldownTicks() {
      const config = this.game.config();
      if (
        config === this._legendarySiloCooldownConfig &&
        Number.isFinite(this._legendarySiloCooldownCache)
      ) {
        return this._legendarySiloCooldownCache;
      }
      const cooldown = Number(config.SiloCooldown());
      const normalizedCooldown =
        Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 90;
      this._legendarySiloCooldownConfig = config;
      this._legendarySiloCooldownCache = normalizedCooldown;
      return normalizedCooldown;
    }

    legendarySamRange(level) {
      const config = this.game.config();
      const normalizedLevel = Math.max(1, Number(level) || 1);
      if (config !== this._legendarySamRangeConfig) {
        this._legendarySamRangeConfig = config;
        this._legendarySamRangeCache = new Map();
      }
      if (this._legendarySamRangeCache.has(normalizedLevel)) {
        return this._legendarySamRangeCache.get(normalizedLevel);
      }
      const range = Number(config.samRange(normalizedLevel));
      this._legendarySamRangeCache.set(normalizedLevel, range);
      return range;
    }

    // Returns the relative tick at which each enemy silo slot can launch.
    // The engine reloads only the queue front once per execution tick, so
    // already-expired entries are spaced by one tick instead of all becoming
    // available at the same instant.
    legendarySiloSlotAvailability(silo) {
      if (!silo || silo.isUnderConstruction?.()) return [];
      const level = this.normalizedStructureLevel(silo.level?.());
      const queue = this.structureMissileQueue(silo, level).map(Number);
      const now = Number(this.game.ticks?.() ?? 0);
      const cooldown = this.legendarySiloCooldownTicks();
      const slots = Array(Math.max(0, level - queue.length)).fill(0);
      let previousReloadTick = -1;
      for (const firedAt of queue) {
        const nominalTick = Number.isFinite(firedAt)
          ? Math.max(0, cooldown - (now - firedAt))
          : Infinity;
        const reloadTick = Number.isFinite(nominalTick)
          ? Math.max(nominalTick, previousReloadTick + 1)
          : Infinity;
        slots.push(reloadTick);
        if (Number.isFinite(reloadTick)) previousReloadTick = reloadTick;
      }
      return slots.sort((left, right) => left - right);
    }

    normalizedStructureLevel(rawLevel, minimum = 1) {
      const level = Number(rawLevel ?? minimum);
      return Number.isFinite(level)
        ? Math.max(minimum, Math.floor(level))
        : minimum;
    }

    structureMissileQueue(unit, limit) {
      {
        const queue = unit.missileTimerQueue?.();
        return Array.isArray(queue) ? queue.slice(0, limit) : [];
      }
    }

    // Mirrors PlayerImpl.nukeSpawn's repeated closest-eligible-silo selection
    // over a future launch sequence. It consumes current ready slots first,
    // waits for the real SiloCooldown when every slot is queued, and then
    // continues one launch per simulation tick so chained enemy intents remain
    // difficult for the SAM scheduler rather than being collapsed into one
    // aggregate capacity number.
    legendaryEnemyMissileLaunchPlan(
      enemySilos,
      targetTile,
      shotCount,
      { siloMetadataCache = null } = {},
    ) {
      const entries = (Array.isArray(enemySilos) ? enemySilos : [])
        .filter((silo) => {
        {
          return (
            silo &&
            !silo.isUnderConstruction?.() &&
            (!silo.isActive || silo.isActive() !== false)
          );
        }
        })
        .map((silo) => {
          const cached = siloMetadataCache?.get(silo);
          const tile = cached?.tile ?? silo.tile();
          const id = cached?.id ?? Number(silo.id?.() ?? 0);
          const slots = cached?.slots?.slice() ?? this.legendarySiloSlotAvailability(silo);
          if (siloMetadataCache && !cached) {
            siloMetadataCache.set(silo, {
              tile,
              id,
              slots: slots.slice(),
            });
          }
          return {
            silo,
            id,
            distance: this.game.manhattanDist(tile, targetTile),
            flightTicks: this.legendaryNukeFlightTime(tile, targetTile),
            slots,
          };
        });
      const launches = [];
      const cooldown = this.legendarySiloCooldownTicks();
      let nextLaunchTick = 0;
      const total = Math.max(0, Math.floor(Number(shotCount) || 0));

      const closestAvailableEntry = (launchTick) => {
        let selected = null;
        for (const entry of entries) {
          // Slots stay sorted after every assignment, so the first slot is
          // enough to decide whether this silo can launch at this tick.
          if (entry.slots.length === 0 || entry.slots[0] > launchTick) continue;
          if (
            selected === null ||
            entry.distance < selected.distance ||
            (entry.distance === selected.distance && entry.id < selected.id)
          ) {
            selected = entry;
          }
        }
        return selected;
      };

      for (let index = 0; index < total; index++) {
        let launchTick = nextLaunchTick;
        let selected = closestAvailableEntry(launchTick);
        if (selected === null) {
          let nextReadyTick = Infinity;
          for (const entry of entries) {
            nextReadyTick = Math.min(nextReadyTick, entry.slots[0] ?? Infinity);
          }
          if (!Number.isFinite(nextReadyTick)) break;
          launchTick = Math.max(launchTick, nextReadyTick);
          selected = closestAvailableEntry(launchTick);
        }
        if (selected === null) break;
        selected.slots[0] = launchTick + cooldown;
        selected.slots.sort((left, right) => left - right);
        launches.push({
          silo: selected.silo,
          launchTick,
          flightTicks: selected.flightTicks,
          impactTick: launchTick + selected.flightTicks,
        });
        nextLaunchTick = launchTick + 1;
      }
      return launches;
    }

    // Returns the relative tick at which every missile slot can fire. Empty
    // slots are ready now (0); queue entries are fire timestamps, so they are
    // converted to a conservative remaining cooldown. This is more accurate
    // than treating `queue.length` as an all-or-nothing capacity number.
    // A hypothetical upgrade changes the SAM range immediately, but
    // UnitImpl.increaseLevel() also appends the current tick to the missile
    // queue for the newly added slot. Therefore only the old level's empty
    // slots are ready at completion; every newly added slot starts with one
    // full SAMCooldown reload.
    legendarySamSlotAvailability(sam, levelOverride = null) {
      if (!sam || sam.isUnderConstruction()) return [];
      const currentLevel = this.normalizedStructureLevel(sam.level());
      const targetLevel = this.normalizedStructureLevel(
        levelOverride,
        currentLevel,
      );
      // The live queue cannot contain more than the current level's slots.
      const queue = this.structureMissileQueue(sam, currentLevel);
      const now = Number(this.game.ticks?.() ?? 0);
      const cooldown = this.legendarySamCooldownTicks();
      const slots = [];
      for (let index = 0; index < currentLevel; index++) {
        if (index >= queue.length) {
          slots.push(0);
          continue;
        }
        const firedAt = Number(queue[index]);
        const ticksLeft = Number.isFinite(firedAt)
          ? cooldown - (now - firedAt)
          : Infinity;
        // SAMLauncherExecution reloads one expired queue entry during its
        // tick. Keep one conservative tick when the snapshot is at the edge.
        slots.push(
          Number.isFinite(ticksLeft)
            ? Math.max(1, Math.ceil(ticksLeft) + 1)
            : Infinity,
        );
      }
      for (let index = currentLevel; index < targetLevel; index++) {
        // increaseLevel() pushes the upgrade tick into the queue. The SAM
        // execution reloads it when this cooldown expires and can then fire
        // in that same tick, so the relative availability is `cooldown`.
        slots.push(cooldown);
      }
      return slots.sort((left, right) => left - right);
    }

    legendaryConstructionDuration(type) {
      {
        const duration = Number(
          this.game.config().unitInfo(type).constructionDuration,
        );
        if (Number.isFinite(duration) && duration >= 0) return duration;
      }
      if (type === UNIT.SAMLauncher) return 300;
      if (type === UNIT.MissileSilo) return 100;
      if (type === UNIT.City || type === UNIT.Factory || type === UNIT.Port) {
        return 20;
      }
      return 0;
    }

    legendaryFriendlySamProfiles(levelOverrides = null, extraSam = null) {
      const profiles = [];
      for (const sam of this.legendaryFriendlySamUnits()) {
        const id = sam.id();
        const override =
          levelOverrides && levelOverrides.has(id)
            ? levelOverrides.get(id)
            : null;
        // The override is deliberately passed to both sides of the model:
        // profile.level expands the trajectory range immediately, while
        // slot availability keeps the newly added missile in SAMCooldown.
        const level = Math.max(1, Number(override ?? sam.level() ?? 1));
        profiles.push({
          id,
          tile: sam.tile(),
          level,
          range: this.legendarySamRange(level),
          availableTicks: this.legendarySamSlotAvailability(sam, override),
          cooldownTicks: this.legendarySamCooldownTicks(),
        });
      }
      if (extraSam && extraSam.tile !== null && extraSam.tile !== undefined) {
        const level = Math.max(1, Number(extraSam.level ?? 1));
        const availableTicks = Array.isArray(extraSam.availableTicks)
          ? extraSam.availableTicks.slice()
          : Array(level).fill(
              Math.max(0, Number(extraSam.completionTick ?? 0)),
            );
        profiles.push({
          id: extraSam.id ?? "legendary-candidate-sam",
          tile: extraSam.tile,
          level,
          range: this.legendarySamRange(level),
          availableTicks,
          cooldownTicks: this.legendarySamCooldownTicks(),
        });
      }
      return profiles;
    }

    legendaryTrajectoryTileTargetable(pathTile, fromTile, targetTile) {
      {
        const targetableRange = Number(
          this.game.config().defaultNukeTargetableRange(),
        );
        if (targetableRange <= 0) return true;
        const rangeSquared = targetableRange * targetableRange;
        return (
          this.game.euclideanDistSquared(pathTile, fromTile) <= rangeSquared ||
          this.game.euclideanDistSquared(pathTile, targetTile) <= rangeSquared
        );
      }
    }

    legendaryTrajectoryTargetableIndexes(path, fromTile, targetTile) {
      const indexes = [];
      for (let index = 0; index < path.length; index++) {
        if (this.legendaryTrajectoryTileTargetable(path[index], fromTile, targetTile)) {
          indexes.push(index);
        }
      }
      return indexes;
    }

    legendaryTrajectoryTargetableBounds(path, targetableIndexes) {
      if (
        !Array.isArray(targetableIndexes) ||
        targetableIndexes.length === 0 ||
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return null;
      }
      const bounds = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      };
      for (const index of targetableIndexes) {
        const tile = path[index];
        const x = Number(this.game.x(tile));
        const y = Number(this.game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
      return bounds;
    }

    legendarySamPathCoverageIndex(
      samOrTile,
      path,
      fromTile,
      targetTile,
      levelOverride = null,
    ) {
      if (
        samOrTile === null ||
        samOrTile === undefined ||
        !Array.isArray(path) ||
        path.length === 0
      ) {
        return -1;
      }
      const samTile =
        typeof samOrTile.tile === "function" ? samOrTile.tile() : samOrTile;
      if (samTile === null || samTile === undefined) return -1;
      const level = Math.max(
        1,
        Number(
          levelOverride ??
            (typeof samOrTile.level === "function" ? samOrTile.level() : 1),
        ),
      );
      let readySlots = level;
      if (typeof samOrTile.tile === "function") {
        readySlots = this.legendarySamReadySlots(samOrTile, levelOverride);
      }
      if (readySlots <= 0) return -1;
      return (
        this.legendarySamPathCoverageIndices(
          samOrTile,
          path,
          fromTile,
          targetTile,
          levelOverride,
        )[0] ?? -1
      );
    }

    // Geometry-only coverage. Unlike legendarySamPathCoverageIndex this keeps
    // a SAM whose missiles are reloading in the route, because the schedule
    // must decide whether it becomes ready before a later incoming missile.
    legendarySamPathCoverageIndices(
      samOrTile,
      path,
      fromTile,
      targetTile,
      levelOverride = null,
    ) {
      if (!Array.isArray(path) || path.length === 0) return [];
      const profile = this.legendarySamCoverageProfile(
        samOrTile,
        levelOverride,
      );
      if (profile === null) return [];
      const { samTile, range } = profile;
      if (range <= 0) return [];
      const rangeSquared = range * range;
      const indexes = [];
      for (let index = 0; index < path.length; index++) {
        const pathTile = path[index];
        if (!this.legendaryTrajectoryTileTargetable(pathTile, fromTile, targetTile)) {
          continue;
        }
        if (
          this.game.euclideanDistSquared(pathTile, samTile) <= rangeSquared
        ) {
          indexes.push(index);
        }
      }
      return indexes;
    }

    legendarySamCoverageProfile(samOrTile, levelOverride, rangeOverride = null) {
      if (samOrTile === null || samOrTile === undefined) return null;
      const samTile =
        typeof samOrTile.tile === "function"
          ? samOrTile.tile()
          : samOrTile.tile ?? samOrTile;
      if (samTile === null || samTile === undefined) return null;
      let rawLevel = samOrTile.level ?? 1;
      if (typeof samOrTile.level === "function") rawLevel = samOrTile.level();
      const level = Math.max(1, Number(levelOverride ?? rawLevel));
      {
        const range = this.legendarySamProfileRange(
          samOrTile,
          rawLevel,
          level,
          rangeOverride,
        );
        return range > 0 ? { samTile, range } : null;
      }
    }

    legendarySamProfileRange(samOrTile, rawLevel, level, rangeOverride) {
      if (rangeOverride !== null) return Number(rangeOverride);
      const cachedRange = Number(samOrTile.range);
      if (
        typeof samOrTile.level !== "function" &&
        Number.isFinite(cachedRange) &&
        level === Math.max(1, Number(rawLevel))
      ) {
        return cachedRange;
      }
      return this.legendarySamRange(level);
    }

    legendarySamPathInterceptTicks(samOrTile, route, levelOverride = null) {
      return this.legendarySamPathCoverageIndices(
        samOrTile,
        route.path,
        route.fromTile,
        route.targetTile,
        levelOverride,
      ).map(
        (index) => Math.max(0, Number(route.launchOffset) || 0) + index,
      );
    }

    legendarySamPathCoverageIndicesForRoute(
      samOrTile,
      route,
      levelOverride = null,
      coverageProfile = null,
    ) {
      if (!Array.isArray(route?.targetableIndexes)) {
        return this.legendarySamPathCoverageIndices(
          samOrTile,
          route?.path,
          route?.fromTile,
          route?.targetTile,
          levelOverride,
        );
      }
      const profile =
        coverageProfile ??
        this.legendarySamCoverageProfile(samOrTile, levelOverride);
      if (profile === null) return [];
      const { samTile, range } = profile;
      if (range <= 0) return [];
      const rangeSquared = range * range;
      const indexes = [];
      for (const index of route.targetableIndexes) {
        if (
          this.game.euclideanDistSquared(route.path[index], samTile) <=
          rangeSquared
        ) {
          indexes.push(index);
        }
      }
      return indexes;
    }

    legendarySamPathInterceptTicksForRoute(
      samOrTile,
      route,
      levelOverride = null,
      coverageProfile = null,
    ) {
      return this.legendarySamPathCoverageIndicesForRoute(
        samOrTile,
        route,
        levelOverride,
        coverageProfile,
      ).map(
        (index) => Math.max(0, Number(route.launchOffset) || 0) + index,
      );
    }

    legendarySamRouteHasTemporalOverlap(route, completionTick) {
      const targetableIndexes = route?.targetableIndexes;
      if (!Array.isArray(targetableIndexes) || targetableIndexes.length === 0) {
        return false;
      }
      const launchOffset = Math.max(0, Number(route.launchOffset) || 0);
      return (
        launchOffset + targetableIndexes.at(-1) >= completionTick &&
        launchOffset + targetableIndexes[0] <= route.impactTick
      );
    }

    legendarySamRouteOutsideTargetableBounds(route, samTile, range) {
      const bounds = route?.targetableBounds;
      if (
        !bounds ||
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return false;
      }
      const samX = Number(this.game.x(samTile));
      const samY = Number(this.game.y(samTile));
      if (!Number.isFinite(samX) || !Number.isFinite(samY)) return false;
      return (
        samX < bounds.minX - range ||
        samX > bounds.maxX + range ||
        samY < bounds.minY - range ||
        samY > bounds.maxY + range
      );
    }

    legendarySamRouteHasIntercept(
      samOrTile,
      levelOverride,
      route,
      completionTick,
      coverageProfile = null,
    ) {
      if (!Array.isArray(route?.targetableIndexes)) {
        return this.legendarySamPathInterceptTicksForRoute(
          samOrTile,
          route,
          levelOverride,
          coverageProfile,
        ).some((tick) => tick >= completionTick && tick <= route.impactTick);
      }
      const targetableIndexes = route.targetableIndexes;
      if (!this.legendarySamRouteHasTemporalOverlap(route, completionTick)) {
        return false;
      }
      const launchOffset = Math.max(0, Number(route.launchOffset) || 0);
      const profile =
        coverageProfile ??
        this.legendarySamCoverageProfile(samOrTile, levelOverride);
      if (profile === null) return false;
      const { samTile, range } = profile;
      if (range <= 0) return false;
      if (this.legendarySamRouteOutsideTargetableBounds(route, samTile, range)) {
        return false;
      }
      const rangeSquared = range * range;
      for (const index of targetableIndexes) {
        const tick = launchOffset + index;
        if (tick < completionTick) continue;
        if (tick > route.impactTick) break;
        if (
          this.game.euclideanDistSquared(route.path[index], samTile) <=
          rangeSquared
        ) {
          return true;
        }
      }
      return false;
    }

    legendaryBuildMissileRoute(route, samProfiles, coverageIndexCache = null) {
      const {
        fromTile,
        targetTile,
        impactTick,
        launchOffset = 0,
        weapon = null,
        id = null,
        path: pathOverride = null,
      } = route;
      const path =
        Array.isArray(pathOverride) && pathOverride.length > 0
          ? pathOverride
          : this.legendaryNukeFlightPath(fromTile, targetTile);
      const samOptions = [];
      for (let samIndex = 0; samIndex < samProfiles.length; samIndex++) {
        const profile = samProfiles[samIndex];
        let coverageIndexes = coverageIndexCache?.get(samIndex);
        if (!coverageIndexes) {
          coverageIndexes = this.legendarySamPathCoverageIndices(
            profile,
            path,
            fromTile,
            targetTile,
            profile.level,
          );
          coverageIndexCache?.set(samIndex, coverageIndexes);
        }
        const interceptTicks = coverageIndexes.map(
          (index) => Math.max(0, Number(launchOffset) || 0) + index,
        );
        if (interceptTicks.length > 0) {
          samOptions.push({ samIndex, interceptTicks });
        }
      }
      return {
        id: id ?? `${String(weapon ?? "missile")}:${String(impactTick)}`,
        weapon,
        fromTile,
        targetTile,
        impactTick: Number(impactTick),
        launchOffset,
        // Keep the already computed trajectory with the route. SAM upgrade
        // evaluations change only interceptor profiles; they must not run the
        // parabola pathfinder again for every candidate SAM.
        path,
        samOptions,
      };
    }

    legendaryRebuildMissileRoutes(routes, samProfiles) {
      if (!Array.isArray(routes)) return null;
      const rebuilt = [];
      const coverageCacheByPath = new Map();
      for (const route of routes) {
        if (!route || !Array.isArray(route.path) || route.path.length === 0) {
          return null;
        }
        let coverageIndexCache = coverageCacheByPath.get(route.path);
        if (!coverageIndexCache) {
          coverageIndexCache = new Map();
          coverageCacheByPath.set(route.path, coverageIndexCache);
        }
        rebuilt.push(
          this.legendaryBuildMissileRoute(route, samProfiles, coverageIndexCache),
        );
      }
      return rebuilt;
    }

    // The client keeps exact server motion plans for active nukes. Prefer that
    // path over rebuilding a new parabola from the nuke's current tile: the
    // latter loses the original launch arc and can move a near-impact window
    // across the five-tick safety boundary.
    legendaryActiveMissileMotion(nuke, fromTile) {
      {
        const plan = this.legendaryActiveMotionPlan(nuke);
        if (!plan || !plan.path || plan.path.length === 0) return null;
        const now = Number(this.game.ticks?.() ?? 0);
        const startTick = Number(plan.startTick ?? now);
        const ticksPerStep = Math.max(1, Number(plan.ticksPerStep ?? 1));
        const rawIndex =
          now <= startTick
            ? 0
            : Math.floor((now - startTick) / ticksPerStep);
        const index = Math.max(
          0,
          Math.min(plan.path.length - 1, rawIndex),
        );
        const path = Array.from(plan.path.slice(index));
        if (path.length === 0) return null;
        return {
          fromTile: plan.path[0] ?? fromTile,
          path,
          impactTick: Math.max(1, path.length),
        };
      }
    }

    legendaryActiveMotionPlan(nuke) {
      const id = typeof nuke?.id === "function" ? nuke.id() : null;
      if (id === null) return null;
      const plans = this.game.motionPlans?.();
      return plans ? plans.get(id) : null;
    }

    legendaryThreatDefensePlan(
      threat,
      {
        levelOverrides = null,
        extraSam = null,
        completionTick = 0,
        samProfilesOverride = null,
      } = {},
    ) {
      if (!threat) return null;
      const samProfiles =
        samProfilesOverride ||
        this.legendaryFriendlySamProfiles(levelOverrides, extraSam);
      if (threat.inFlight) {
        return this.legendaryInFlightDefensePlan(threat, samProfiles);
      }
      return this.legendaryProspectiveDefensePlan(threat, samProfiles, {
        levelOverrides,
        extraSam,
        completionTick,
      });
    }

    legendaryInFlightDefensePlan(threat, samProfiles) {
      const fromTile =
        threat.nuke && typeof threat.nuke.tile === "function"
          ? threat.nuke.tile()
          : null;
      const targetTile = threat.targetTile;
      if (fromTile === null || targetTile === null || targetTile === undefined) {
        return null;
      }
      const motion = this.legendaryActiveMissileMotion(threat.nuke, fromTile);
      const impactTick =
        motion?.impactTick ?? this.legendaryNukeFlightTime(fromTile, targetTile);
      const route = this.legendaryBuildMissileRoute(
        {
          fromTile: motion?.fromTile ?? fromTile,
          targetTile,
          impactTick,
          launchOffset: 0,
          weapon: threat.weapon,
          id: `active:${String(threat.weapon)}:${String(impactTick)}`,
          path: motion?.path ?? null,
        },
        samProfiles,
      );
      return {
        routes: route ? [route] : [],
        samProfiles,
        forecastComplete: true,
      };
    }

    legendaryProspectiveDefensePlan(threat, samProfiles, options) {
      const rebuiltRoutes = this.legendaryRebuildMissileRoutes(
        threat.salvoPlan?.routes,
        samProfiles,
      );
      if (rebuiltRoutes !== null) {
        return {
          routes: rebuiltRoutes,
          samProfiles,
          forecastComplete: threat.salvoPlan.forecastComplete !== false,
        };
      }
      const plan = this.legendaryMissileSalvoPlan(
        {
          enemySilos: threat.enemySilos || [],
          enemyGold: threat.enemyGold ?? 0n,
          targetTile: threat.targetTile,
          atomCost: threat.atomCost ?? this.cost(UNIT.AtomBomb),
          hydrogenCost:
            threat.hydrogenCost ?? this.cost(UNIT.HydrogenBomb),
        },
        {
          levelOverrides: options.levelOverrides,
          extraSam: options.extraSam,
          actionCompletionTick: options.completionTick,
          samProfilesOverride: samProfiles,
        },
      );
      return {
        routes: plan.routes || [],
        samProfiles: plan.samProfiles || samProfiles,
        forecastComplete: plan.forecastComplete !== false,
      };
    }

    legendaryThreatDefenseSchedule(
      threat,
      {
        levelOverrides = null,
        extraSam = null,
        completionTick = 0,
      } = {},
    ) {
      if (!threat) return null;
      const hasLevelOverrides = this.hasLegendaryLevelOverrides(levelOverrides);
      if (
        !hasLevelOverrides &&
        !extraSam &&
        Number(completionTick) === 0 &&
        threat.salvoPlan &&
        threat.salvoPlan.schedule &&
        Array.isArray(threat.salvoPlan.schedule.missiles)
      ) {
        return threat.salvoPlan.schedule;
      }
      const plan = this.legendaryThreatDefensePlan(threat, {
        levelOverrides,
        extraSam,
        completionTick,
      });
      if (!plan) return null;

      const schedule = legendaryMissileDefenseSchedule({
        routes: plan.routes,
        samProfiles: plan.samProfiles,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        completionTick,
      });
      if (!plan.forecastComplete) {
        schedule.fullyDefended = false;
        schedule.inconclusive = true;
      }
      return schedule;
    }

    hasLegendaryLevelOverrides(levelOverrides) {
      if (!levelOverrides) return false;
      if (typeof levelOverrides.size === "number") return levelOverrides.size > 0;
      return true;
    }

    getMissileDefenseEvaluation(context) {
      if (
        context &&
        this._missileDefenseEvaluationContext === context &&
        this._missileDefenseEvaluationCache !== null
      ) {
        return this._missileDefenseEvaluationCache;
      }

      const evaluation = this.legendaryDefenseEvaluation(context);
      this._missileDefenseEvaluationTick =
        typeof this.game?.ticks === "function"
          ? Number(this.game.ticks())
          : null;
      this._missileDefenseEvaluationContext = context;
      this._missileDefenseEvaluationCache = evaluation;
      return evaluation;
    }

    legendaryDefenseEvaluation(context, options = {}) {
      if (!context || !Array.isArray(context.threats)) {
        return this.emptyLegendaryDefenseEvaluation();
      }
      const cacheable =
        !this.hasLegendaryLevelOverrides(options.levelOverrides) &&
        !options.extraSam &&
        Number(options.completionTick ?? 0) === 0;
      if (cacheable && context._legendaryDefenseEvaluationCache) {
        return context._legendaryDefenseEvaluationCache;
      }
      const samProfiles = this.legendaryDefenseSamProfiles(context, options);
      const { routes, groups } = this.legendaryDefenseRouteGroups(
        context.threats,
        options,
        samProfiles,
      );
      const globalSchedule = legendaryMissileDefenseSchedule({
        routes,
        samProfiles,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        completionTick: options.completionTick ?? 0,
      });
      if (groups.some((group) => !group.forecastComplete)) {
        globalSchedule.fullyDefended = false;
        globalSchedule.inconclusive = true;
      }
      const schedules = groups.map((group) =>
        this.legendaryGroupDefenseSchedule(group, globalSchedule),
      );
      if (schedules.length === 0) {
        const evaluation = {
          hasThreats: false,
          fullyDefended: true,
          completionMarginTicks: Infinity,
          minimumInterceptMarginTicks: Infinity,
          firstImpactTick: Infinity,
          uninterceptedCount: 0,
          schedules,
          globalSchedule,
        };
        if (cacheable) context._legendaryDefenseEvaluationCache = evaluation;
        return evaluation;
      }
      const evaluation = {
        hasThreats: true,
        fullyDefended: globalSchedule.fullyDefended,
        completionMarginTicks: globalSchedule.completionMarginTicks,
        minimumInterceptMarginTicks:
          globalSchedule.minimumInterceptMarginTicks,
        firstImpactTick: globalSchedule.firstImpactTick,
        uninterceptedCount: globalSchedule.uninterceptedCount,
        schedules,
        globalSchedule,
      };
      if (cacheable) context._legendaryDefenseEvaluationCache = evaluation;
      return evaluation;
    }

    legendaryDefenseSamProfiles(context, options = {}) {
      if (
        this.hasLegendaryLevelOverrides(options.levelOverrides) ||
        options.extraSam
      ) {
        return this.legendaryFriendlySamProfiles(
          options.levelOverrides ?? null,
          options.extraSam ?? null,
        );
      }
      return context.samProfiles || this.legendaryFriendlySamProfiles();
    }

    emptyLegendaryDefenseEvaluation() {
      return {
        hasThreats: false,
        fullyDefended: true,
        completionMarginTicks: Infinity,
        minimumInterceptMarginTicks: Infinity,
        firstImpactTick: Infinity,
        uninterceptedCount: 0,
        schedules: [],
      };
    }

    legendaryDefenseRouteGroups(threats, options, samProfiles) {
      const routes = [];
      const groups = [];
      for (let threatIndex = 0; threatIndex < threats.length; threatIndex++) {
        const threat = threats[threatIndex];
        const plan = this.legendaryReusableOrRebuiltDefensePlan(
          threat,
          options,
          samProfiles,
        );
        if (!plan || !Array.isArray(plan.routes) || plan.routes.length === 0) {
          continue;
        }
        const routeIds = new Set();
        for (let routeIndex = 0; routeIndex < plan.routes.length; routeIndex++) {
          const route = plan.routes[routeIndex];
          const id = `${String(threatIndex)}:${String(route.id ?? routeIndex)}`;
          routeIds.add(id);
          routes.push({ ...route, id, threatIndex });
        }
        groups.push({
          threat,
          threatIndex,
          routeIds,
          forecastComplete: plan.forecastComplete !== false,
        });
      }
      return { routes, groups };
    }

    legendaryReusableOrRebuiltDefensePlan(threat, options, samProfiles) {
      const canReuseRoutes =
        !this.hasLegendaryLevelOverrides(options.levelOverrides) &&
        !options.extraSam &&
        Number(options.completionTick ?? 0) === 0 &&
        Array.isArray(threat?.salvoPlan?.routes);
      if (canReuseRoutes) {
        return {
          routes: threat.salvoPlan.routes,
          samProfiles,
          forecastComplete: threat.salvoPlan.forecastComplete !== false,
        };
      }
      return this.legendaryThreatDefensePlan(threat, {
        ...options,
        samProfilesOverride: samProfiles,
      });
    }

    legendaryGroupDefenseSchedule(group, globalSchedule) {
      const missiles = globalSchedule.missiles.filter((missile) =>
        group.routeIds.has(String(missile.id)),
      );
      const firstImpactTick = missiles.length
        ? Math.min(...missiles.map((missile) => missile.impactTick))
        : Infinity;
      const completionTick = globalSchedule.completionTick;
      const completionMarginTicks = Number.isFinite(firstImpactTick)
        ? Math.max(0, firstImpactTick - completionTick)
        : Infinity;
      return {
        ...globalSchedule,
        missiles,
        firstImpactTick,
        completionMarginTicks,
        completionMarginSatisfied:
          Number.isFinite(firstImpactTick) &&
          completionMarginTicks >= LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        fullyDefended:
          group.forecastComplete &&
          missiles.every((missile) => missile.intercepted),
        interceptedCount: missiles.filter((missile) => missile.intercepted)
          .length,
        uninterceptedCount: missiles.filter((missile) => !missile.intercepted)
          .length,
        minimumInterceptMarginTicks: missiles.length
          ? Math.min(...missiles.map((missile) => missile.marginTicks))
          : Infinity,
        threat: group.threat,
      };
    }

    legendaryMissileDefenseNeedsAction(context) {
      const evaluation = this.getMissileDefenseEvaluation(context);
      return Boolean(
        evaluation.hasThreats &&
          !evaluation.fullyDefended,
      );
    }

    legendarySamConstructionSafeForTile(tile, context, level = 1) {
      if (tile === null || tile === undefined) return false;
      const completionTick = this.legendaryConstructionDuration(
        UNIT.SAMLauncher,
      );
      const evaluation = this.legendaryDefenseEvaluation(context, {
        extraSam: {
          id: "legendary-candidate-sam",
          tile,
          level,
          completionTick,
          availableTicks: Array(Math.max(1, Number(level))).fill(
            completionTick,
          ),
        },
        completionTick,
      });
      return Boolean(
        evaluation.hasThreats &&
          evaluation.fullyDefended &&
          evaluation.completionMarginTicks >=
            LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
      );
    }

    activeMissileSamConstructionImproves(tile, context, currentEvaluation) {
      if (tile === null || tile === undefined) return false;
      const completionTick = this.legendaryConstructionDuration(
        UNIT.SAMLauncher,
      );
      if (
        this.uncoveredActiveMirvDemands(context).some((demand) =>
          this.samTileCoversMirvDemand(tile, demand, completionTick),
        )
      ) return true;
      if (!currentEvaluation?.hasThreats) return false;
      const nextEvaluation = this.legendaryDefenseEvaluation(context, {
        extraSam: {
          id: "active-missile-candidate-sam",
          tile,
          level: 1,
          completionTick,
          availableTicks: [completionTick],
        },
        completionTick,
      });
      return legendaryDefenseActionImproves(
        currentEvaluation,
        nextEvaluation,
        0,
        0,
      );
    }

    legendaryTileInsideUninterceptedBlast(
      tile,
      context,
      evaluationOverride = null,
    ) {
      if (tile === null || tile === undefined || !context) return false;
      // Use the global evaluation so two enemy salvos cannot each reuse the
      // same SAM slot while this placement filter decides whether a productive
      // tile is still inside an actually un-interceptable blast.
      const evaluation =
        evaluationOverride || this.getMissileDefenseEvaluation(context);
      for (const schedule of evaluation.schedules || []) {
        if (this.legendaryScheduleBlastContainsTile(schedule, tile, context)) {
          return true;
        }
      }
      return false;
    }

    legendaryScheduleBlastContainsTile(schedule, tile, context) {
      if (!schedule || schedule.fullyDefended || !schedule.threat) return false;
      const targetTile = schedule.threat.targetTile;
      if (targetTile === null || targetTile === undefined) return false;
      const radius =
        schedule.threat.weapon === UNIT.HydrogenBomb
          ? Number(context.hydrogenRadius || 0)
          : Number(context.atomRadius || 0);
      return (
        radius > 0 &&
        this.game.euclideanDistSquared(tile, targetTile) <= radius * radius
      );
    }

    legendarySamInterceptionCapacity(
      fromTile,
      targetTile,
      levelOverrides = null,
      samProfilesOverride = null,
    ) {
      const path = this.legendaryNukeFlightPath(fromTile, targetTile);
      const targetableIndexes = this.legendaryTrajectoryTargetableIndexes(
        path,
        fromTile,
        targetTile,
      );
      const route = { path, targetableIndexes };
      const preparedProfiles =
        levelOverrides === null && Array.isArray(samProfilesOverride)
          ? samProfilesOverride
          : null;
      const sams = preparedProfiles || this.legendaryFriendlySamUnits();
      let capacity = 0;
      for (const sam of sams) {
        const override =
          !preparedProfiles && levelOverrides && levelOverrides.has(sam.id())
            ? levelOverrides.get(sam.id())
            : null;
        const readySlots = preparedProfiles
          ? (sam.availableTicks || []).filter((tick) => tick <= 0).length
          : this.legendarySamReadySlots(sam, override);
        if (readySlots <= 0) continue;
        const coverageIndexes = this.legendarySamPathCoverageIndicesForRoute(
          sam,
          route,
          override,
        );
        if (coverageIndexes.length > 0) capacity += readySlots;
      }
      return capacity;
    }

    legendaryMinimumSamImpactMargin(context, levelOverrides = null) {
      const evaluation = this.legendaryDefenseEvaluation(context, {
        levelOverrides,
      });
      // A schedule with even one missile that cannot be assigned to a ready or
      // reloaded SAM has no usable safety margin. The returned value therefore
      // means “ticks from the action completion to the first landing, but only
      // when every incoming missile is actually defendable.”
      return evaluation.hasThreats && evaluation.fullyDefended
        ? evaluation.completionMarginTicks
        : 0;
    }

    legendaryMinimumSamInterceptionCapacity(context, levelOverrides = null) {
      if (!context || !Array.isArray(context.threats)) return 0;
      const samProfilesOverride = this.legendarySamCapacityProfiles(
        context,
        levelOverrides,
      );
      let minimum = Infinity;
      let routeCount = 0;
      for (const threat of context.threats) {
        const targetTile = threat.targetTile;
        if (targetTile === null || targetTile === undefined) continue;
        const sources = this.legendaryThreatSources(threat);
        for (const source of sources) {
          const fromTile =
            typeof source.tile === "function" ? source.tile() : source;
          if (fromTile === null || fromTile === undefined) continue;
          routeCount++;
          minimum = Math.min(
            minimum,
            this.legendarySamInterceptionCapacity(
              fromTile,
              targetTile,
              levelOverrides,
              samProfilesOverride,
            ),
          );
        }
      }
      return routeCount > 0 && Number.isFinite(minimum) ? minimum : 0;
    }

    legendarySamCapacityProfiles(context, levelOverrides) {
      if (this.hasLegendaryLevelOverrides(levelOverrides)) return null;
      return Array.isArray(context?.samProfiles) ? context.samProfiles : null;
    }

    legendaryThreatSources(threat) {
      if (!threat.inFlight) return threat.enemySilos || [];
      if (!threat.nuke || typeof threat.nuke.tile !== "function") return [];
      return [threat.nuke.tile()];
    }

    legendarySamImpactMarginScore(
      tile,
      context,
      level = 1,
      rangeOverride = null,
    ) {
      if (!context || !Array.isArray(context.threats)) return 0;
      const structures = Array.isArray(context.structures)
        ? context.priorityStructures || context.structures
        : [];
      if (structures.length === 0) return 0;
      let protectedValue = 0;
      const totalValue = Math.max(1, Number(context.totalValue || 0));
      const structureValues = context.structureValues;
      const impactContext = this.legendarySamImpactMarginContext(context);
      const coverageProfile = this.legendarySamCoverageProfile(
        tile,
        level,
        rangeOverride,
      );
      if (coverageProfile === null) return 0;
      const candidateImpactContext = {
        ...impactContext,
        coverageProfile,
      };
      for (const structure of structures) {
        if (
          this.legendaryCandidateProtectsStructure(
            tile,
            level,
            structure,
            context.threats,
            candidateImpactContext,
          )
        ) {
          protectedValue +=
            structureValues?.get(structure) ??
            this.legendaryCriticalStructureValue(structure);
        }
      }
      const spacing = this.spacingConstants().structureSpacing;
      return spacing * Math.min(4, (protectedValue / totalValue) * 4);
    }

    legendarySamImpactMarginContext(context) {
      if (context.samImpactMarginContext) {
        return context.samImpactMarginContext;
      }
      const structures = Array.isArray(context.structures)
        ? context.priorityStructures || context.structures
        : [];
      const structureTiles = context.structureTiles;
      const completionTick = this.legendaryConstructionDuration(
        UNIT.SAMLauncher,
      );
      const routesByThreat = new Map();
      for (const threat of context.threats || []) {
        routesByThreat.set(
          threat,
          this.legendarySamImpactRoutesForThreat(
            threat,
            structures,
            structureTiles,
            completionTick,
          ),
        );
      }
      const impactContext = { completionTick, routesByThreat };
      context.samImpactMarginContext = impactContext;
      return impactContext;
    }

    legendarySamImpactRoutesForThreat(
      threat,
      structures,
      structureTiles,
      completionTick,
    ) {
      const routesByStructure = new Map();
      if (threat.targetTile === null || threat.targetTile === undefined) {
        return routesByStructure;
      }
      const sources = this.legendaryThreatSources(threat);
      for (const structure of structures) {
        const structureTile =
          structureTiles?.get(structure) ?? structure.tile();
        if (structureTile === null || structureTile === undefined) {
          routesByStructure.set(structure, []);
          continue;
        }
        routesByStructure.set(
          structure,
          this.legendarySamImpactRoutesForStructure(
            sources,
            structureTile,
            completionTick,
          ),
        );
      }
      return routesByStructure;
    }

    legendarySamImpactRoutesForStructure(sources, structureTile, completionTick) {
      const routes = [];
      for (const source of sources) {
        const fromTile =
          typeof source.tile === "function" ? source.tile() : source;
        if (fromTile === null || fromTile === undefined) continue;
        const impactTick = this.legendaryNukeFlightTime(
          fromTile,
          structureTile,
        );
        if (
          impactTick - completionTick < LEGENDARY_SAM_IMPACT_MARGIN_TICKS
        ) {
          continue;
        }
        const path = this.legendaryNukeFlightPath(fromTile, structureTile);
        const targetableIndexes = this.legendaryTrajectoryTargetableIndexes(
          path,
          fromTile,
          structureTile,
        );
        routes.push({
          path,
          targetableIndexes,
          targetableBounds: this.legendaryTrajectoryTargetableBounds(
            path,
            targetableIndexes,
          ),
          fromTile,
          targetTile: structureTile,
          launchOffset: 0,
          impactTick,
        });
      }
      return routes;
    }

    legendaryCandidateProtectsStructure(
      tile,
      level,
      structure,
      threats,
      impactContext = null,
    ) {
      return threats.some((threat) =>
        this.legendaryCandidateProtectsStructureFromThreat(
          tile,
          level,
          structure,
          threat,
          impactContext,
        ),
      );
    }

    legendaryCandidateProtectsStructureFromThreat(
      tile,
      level,
      structure,
      threat,
      impactContext = null,
    ) {
      if (threat.targetTile === null || threat.targetTile === undefined) return false;
      const preparedRoutes = impactContext?.routesByThreat
        ?.get(threat)
        ?.get(structure);
      if (preparedRoutes) {
        return preparedRoutes.some((route) =>
          this.legendarySamRouteProtectsTile(
            tile,
            level,
            route,
            impactContext.completionTick,
            impactContext.coverageProfile,
          ),
        );
      }
      const structureTile = structure.tile();
      const completionTick = this.legendaryConstructionDuration(UNIT.SAMLauncher);
      for (const source of this.legendaryThreatSources(threat)) {
        const fromTile = typeof source.tile === "function" ? source.tile() : source;
        if (fromTile === null || fromTile === undefined) continue;
        const impactTick = this.legendaryNukeFlightTime(fromTile, structureTile);
        if (impactTick - completionTick < LEGENDARY_SAM_IMPACT_MARGIN_TICKS) {
          continue;
        }
        const interceptTicks = this.legendarySamPathInterceptTicks(
          tile,
          {
            path: this.legendaryNukeFlightPath(fromTile, structureTile),
            fromTile,
            targetTile: structureTile,
            launchOffset: 0,
          },
          level,
        );
        if (interceptTicks.some((tick) => tick >= completionTick && tick <= impactTick)) {
          return true;
        }
      }
      return false;
    }

    legendarySamRouteProtectsTile(
      tile,
      level,
      route,
      completionTick,
      coverageProfile = null,
    ) {
      return this.legendarySamRouteHasIntercept(
        tile,
        level,
        route,
        completionTick,
        coverageProfile,
      );
    }

    legendaryMissileSalvoPlan(
      { enemySilos, enemyGold, targetTile, atomCost, hydrogenCost },
      {
        levelOverrides = null,
        extraSam = null,
        actionCompletionTick = 0,
        samProfilesOverride = null,
      } = {},
    ) {
      if (
        targetTile === null ||
        targetTile === undefined ||
        enemySilos.length === 0
      ) {
        return this.emptyLegendaryMissileSalvoPlan(
          actionCompletionTick,
          samProfilesOverride,
        );
      }

      const samProfiles =
        samProfilesOverride ||
        this.legendaryFriendlySamProfiles(levelOverrides, extraSam);
      const budget = this.legendaryMissileSalvoBudget(
        enemyGold,
        atomCost,
        hydrogenCost,
      );
      const { canHydrogen, atomCount, forecastComplete } = budget;
      const desiredShotCount = atomCount + (canHydrogen ? 1 : 0);
      const launches = this.legendaryEnemyMissileLaunchPlan(
        enemySilos,
        targetTile,
        desiredShotCount,
      );
      const readyShots = enemySilos.reduce(
        (total, silo) =>
          total +
          this.legendarySiloSlotAvailability(silo).filter(
            (tick) => tick <= 0,
          ).length,
        0,
      );
      const routePlan = this.legendarySalvoRoutes({
        launches,
        targetTile,
        canHydrogen,
        atomCount,
        samProfiles,
      });
      const { atomArrivalTicks, hydrogenArrivalTick, routes } = routePlan;
      const launchFlightTimes = new Map();
      for (const launch of launches) {
        if (!launchFlightTimes.has(launch.silo)) {
          launchFlightTimes.set(launch.silo, launch.flightTicks);
        }
      }
      const sourceMetrics = this.legendarySalvoSourceMetrics(
        enemySilos,
        targetTile,
        launchFlightTimes,
        routes,
        samProfiles,
      );
      const interceptionCapacity = sourceMetrics.reduce(
        (total, source) => total + source.interceptionCapacity,
        0,
      );
      const samCooldownTicks = this.legendarySamCooldownTicks();
      const schedule = legendaryMissileDefenseSchedule({
        routes,
        samProfiles,
        samCooldownTicks,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        completionTick: actionCompletionTick,
      });
      schedule.forecastComplete =
        forecastComplete && launches.length >= desiredShotCount;
      const risk = this.finalizeLegendarySalvoRisk(schedule, {
        atomArrivalTicks,
        hydrogenArrivalTick,
        interceptionCapacity,
        samCooldownTicks,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        routes,
        samProfiles,
        scheduleOverride: schedule,
        completionTick: actionCompletionTick,
      });
      return {
        atomArrivalTicks,
        hydrogenArrivalTick,
        interceptionCapacity,
        readyShots,
        forecastComplete: schedule.forecastComplete,
        risk,
        schedule,
        routes,
        sourceMetrics,
        samProfiles,
      };
    }

    finalizeLegendarySalvoRisk(schedule, riskInput) {
      if (schedule.forecastComplete) return legendaryMissileSalvoRisk(riskInput);
      // An incomplete explicit forecast cannot claim a complete defense.
      schedule.fullyDefended = false;
      schedule.inconclusive = true;
      const risk = legendaryMissileSalvoRisk(riskInput);
      Object.assign(risk, {
        fullyDefended: false,
        inconclusive: true,
        forecastComplete: false,
        risk: 1,
        critical: true,
      });
      return risk;
    }

    emptyLegendaryMissileSalvoPlan(completionTick, samProfiles) {
      return {
        atomArrivalTicks: [],
        hydrogenArrivalTick: null,
        interceptionCapacity: 0,
        readyShots: 0,
        forecastComplete: true,
        risk: legendaryMissileSalvoRisk(),
        schedule: legendaryMissileDefenseSchedule({
          routes: [],
          samProfiles: [],
          marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
          completionTick,
        }),
        routes: [],
        sourceMetrics: [],
        samProfiles: samProfiles || [],
      };
    }

    legendaryMissileSalvoBudget(enemyGold, atomCost, hydrogenCost) {
      const canHydrogen = hydrogenCost > 0n && enemyGold >= hydrogenCost;
      const atomBudgetGold = canHydrogen ? enemyGold - hydrogenCost : enemyGold;
      const affordable = Number(atomCost > 0n ? atomBudgetGold / atomCost : 0n);
      const forecastComplete =
        Number.isSafeInteger(affordable) &&
        affordable <= LEGENDARY_MAX_FORECAST_MISSILES;
      const safeAffordable = Number.isSafeInteger(affordable)
        ? affordable
        : LEGENDARY_MAX_FORECAST_MISSILES;
      const atomCount = Math.max(
        0,
        Math.min(LEGENDARY_MAX_FORECAST_MISSILES, safeAffordable),
      );
      return { canHydrogen, atomCount, forecastComplete };
    }

    legendarySalvoRoutes({
      launches,
      targetTile,
      canHydrogen,
      atomCount,
      samProfiles,
    }) {
      const atomArrivalTicks = [];
      const routes = [];
      const pathBySilo = new Map();
      const coverageCacheBySilo = new Map();
      let hydrogenArrivalTick = null;
      for (let index = 0; index < launches.length; index++) {
        const launch = launches[index];
        const isHydrogen = canHydrogen && index >= atomCount;
        if (isHydrogen) hydrogenArrivalTick = launch.impactTick;
        else atomArrivalTicks.push(launch.impactTick);
        routes.push(
          this.legendarySalvoRoute({
            launch,
            index,
            targetTile,
            isHydrogen,
            samProfiles,
            pathBySilo,
            coverageCacheBySilo,
          }),
        );
      }
      return { atomArrivalTicks, hydrogenArrivalTick, routes };
    }

    legendarySalvoRoute({
      launch,
      index,
      targetTile,
      isHydrogen,
      samProfiles,
      pathBySilo,
      coverageCacheBySilo,
    }) {
      let path = pathBySilo.get(launch.silo);
      if (!path) {
        path = this.legendaryNukeFlightPath(launch.silo.tile(), targetTile);
        pathBySilo.set(launch.silo, path);
      }
      let coverageIndexCache = coverageCacheBySilo.get(launch.silo);
      if (!coverageIndexCache) {
        coverageIndexCache = new Map();
        coverageCacheBySilo.set(launch.silo, coverageIndexCache);
      }
      const weapon = isHydrogen ? UNIT.HydrogenBomb : UNIT.AtomBomb;
      const route = this.legendaryBuildMissileRoute(
        {
          fromTile: launch.silo.tile(),
          targetTile,
          impactTick: launch.impactTick,
          launchOffset: launch.launchTick,
          weapon,
          id: `${isHydrogen ? "hydrogen" : "atom"}:${String(
            launch.silo.id?.() ?? index,
          )}:${String(index)}`,
          path,
        },
        samProfiles,
        coverageIndexCache,
      );
      route.silo = launch.silo;
      return route;
    }

    legendarySalvoRouteInterceptionCapacity(route, samProfiles) {
      if (
        !route ||
        !Array.isArray(route.samOptions) ||
        !Array.isArray(samProfiles) ||
        samProfiles.length === 0
      ) {
        return null;
      }
      let capacity = 0;
      for (const option of route.samOptions) {
        const availableTicks = samProfiles[option.samIndex]?.availableTicks;
        if (!Array.isArray(availableTicks)) continue;
        capacity += availableTicks.filter((tick) => tick <= 0).length;
      }
      return capacity;
    }

    legendarySalvoSourceMetrics(
      enemySilos,
      targetTile,
      launchFlightTimes,
      routes = null,
      samProfiles = null,
    ) {
      const routesBySilo = new Map();
      if (Array.isArray(routes)) {
        for (const route of routes) {
          const silo = route?.silo;
          if (silo && !routesBySilo.has(silo)) {
            routesBySilo.set(silo, route);
          }
        }
      }
      return enemySilos.map((silo) => {
        const fromTile = silo.tile();
        const routeCapacity = this.legendarySalvoRouteInterceptionCapacity(
          routesBySilo.get(silo),
          samProfiles,
        );
        return {
          silo,
          fromTile,
          flightTimeTicks:
            launchFlightTimes.get(silo) ??
            this.legendaryNukeFlightTime(fromTile, targetTile),
          interceptionCapacity:
            routeCapacity ??
            this.legendarySamInterceptionCapacity(
              fromTile,
              targetTile,
              null,
              samProfiles,
            ),
        };
      });
    }

    legendaryActiveMissileThreats(context) {
      const threats = [];
      let activeNukes;
      {
        activeNukes = this.game.units(
          UNIT.AtomBomb,
          UNIT.HydrogenBomb,
        );
      }
      const mySid = this.player.smallID();
      const samProfiles =
        context.samProfiles || this.legendaryFriendlySamProfiles();
      for (const nuke of activeNukes) {
        {
          const threat = this.legendaryActiveMissileThreat(
            nuke,
            mySid,
            context,
            samProfiles,
          );
          if (threat !== null) threats.push(threat);
        }
      }
      return threats;
    }

    activeMirvDefenseDemands() {
      const demands = [];
      const mySid = this.player.smallID();
      for (const missile of this.game.units(UNIT.MIRV, UNIT.MIRVWarhead) || []) {
        if (!isHostileActiveMissile(this.player, missile, mySid)) continue;
        const targetTile = missile.targetTile?.();
        if (targetTile === null || targetTile === undefined) continue;
        const fromTile = missile.tile?.();
        if (fromTile === null || fromTile === undefined) continue;
        const deadlineTick = this.activeMirvDeadlineTick(
          missile,
          fromTile,
          targetTile,
        );
        if (missile.type?.() === UNIT.MIRV) {
          this.appendMirvCarrierSiteDemands(
            demands,
            missile,
            targetTile,
            deadlineTick,
          );
          continue;
        }
        if (
          typeof this.game.ownerID !== "function" ||
          this.game.ownerID(targetTile) === mySid
        ) {
          demands.push({
            missile,
            type: UNIT.MIRVWarhead,
            targetTile,
            deadlineTick,
            exactDestination: true,
          });
        }
      }
      return demands;
    }

    activeMirvDeadlineTick(missile, fromTile, targetTile) {
      const motion = this.legendaryActiveMissileMotion(missile, fromTile);
      return Math.max(
        0,
        Number(
          motion?.impactTick ??
            this.legendaryNukeFlightTime(fromTile, targetTile),
        ),
      );
    }

    appendMirvCarrierSiteDemands(
      demands,
      missile,
      carrierTargetTile,
      deadlineTick,
    ) {
      const radiusSquared = MIRV_CARRIER_TARGET_RADIUS ** 2;
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      for (const structure of structures || []) {
        const structureTile = structure.tile?.();
        if (structureTile === null || structureTile === undefined) continue;
        if (
          this.game.euclideanDistSquared(carrierTargetTile, structureTile) >
          radiusSquared
        ) continue;
        demands.push({
          missile,
          type: UNIT.MIRV,
          targetTile: structureTile,
          deadlineTick,
          carrierPreparation: true,
          protectedStructureId: structure.id?.(),
        });
      }
    }

    uncoveredActiveMirvDemands(context) {
      return (context?.mirvDemands || []).filter(
        (demand) => !this.activeMirvDemandCovered(demand),
      );
    }

    activeMirvDemandCovered(demand) {
      return this.legendaryFriendlySamUnits().some(
        (sam) =>
          this.legendarySamSlotAvailability(sam).some(
            (tick) =>
              this.samTileCoversMirvDemand(
                sam.tile(),
                demand,
                tick,
              ),
          ),
      );
    }

    samTileCoversMirvDemand(tile, demand, completionTick = 0) {
      if (tile === null || tile === undefined) return false;
      if (completionTick + LEGENDARY_SAM_IMPACT_MARGIN_TICKS > demand.deadlineTick) {
        return false;
      }
      return this.game.manhattanDist(tile, demand.targetTile) < 50;
    }

    legendaryActiveMissileThreat(nuke, mySid, context, samProfiles) {
      if (nuke.isActive && nuke.isActive() === false) return null;
      const owner = nuke.owner();
      if (!owner || owner.smallID() === mySid || this.player.isFriendly(owner)) {
        return null;
      }
      const targetTile = nuke.targetTile();
      const fromTile = nuke.tile();
      if (targetTile === null || targetTile === undefined) return null;
      if (fromTile === null || fromTile === undefined) return null;
      const type = nuke.type();
      if (!this.isNuclearMissileType(type)) return null;
      const radius = this.activeMissileBlastRadius(type, context);
      const exposure = this.legendaryActiveMissileExposure(
        targetTile,
        radius,
        context.structures,
        {
          structureValues: context.structureValues,
          structureTiles: context.structureTiles,
        },
      );
      const targetsOwnedTerritory = this.activeMissileTargetsOwnedTerritory(
        targetTile,
        mySid,
      );
      // Nuclear strikes can sever the only territorial bridge and trigger
      // cluster cleanup even when no City/Factory/Port/Silo is inside the
      // blast. Owned land is therefore a first-class defensive asset.
      if (exposure.count === 0 && !targetsOwnedTerritory) return null;
      this.addActiveMissileTerritoryExposure(
        exposure,
        targetsOwnedTerritory,
        context.totalValue,
      );
      return this.legendaryScoredActiveMissileThreat({
        nuke,
        fromTile,
        targetTile,
        type,
        radius,
        exposure,
        context,
        samProfiles,
      });
    }

    isNuclearMissileType(type) {
      return (
        type === UNIT.AtomBomb ||
        type === UNIT.HydrogenBomb
      );
    }

    activeMissileBlastRadius(type, context) {
      if (type === UNIT.HydrogenBomb) return context.hydrogenRadius;
      const configured = Number(this.game.config().nukeMagnitudes?.(type)?.outer);
      return Number.isFinite(configured) && configured > 0
        ? configured
        : context.atomRadius;
    }

    activeMissileTargetsOwnedTerritory(targetTile, mySid) {
      return (
        typeof this.game.ownerID === "function" &&
        this.game.ownerID(targetTile) === mySid
      );
    }

    addActiveMissileTerritoryExposure(exposure, targetsOwnedTerritory, totalValue) {
      if (!targetsOwnedTerritory || exposure.value !== 0) return;
      exposure.value = Math.max(1, Number(totalValue || 0));
      exposure.targetsOwnedTerritory = true;
    }

    legendaryActiveMissileExposure(
      targetTile,
      radius,
      structures,
      { structureValues = null, structureTiles = null } = {},
    ) {
      const radiusSquared = radius * radius;
      let value = 0;
      let count = 0;
      for (const structure of structures) {
        const structureTile = structureTiles?.has(structure)
          ? structureTiles.get(structure)
          : structure.tile();
        if (
          this.game.euclideanDistSquared(targetTile, structureTile) > radiusSquared
        ) continue;
        value +=
          structureValues?.get(structure) ??
          this.legendaryCriticalStructureValue(structure);
        count++;
      }
      return { value, count, radiusSquared };
    }

    legendaryScoredActiveMissileThreat(input) {
      const motion = this.legendaryActiveMissileMotion(input.nuke, input.fromTile);
      const flightTimeTicks =
        motion?.impactTick ??
        this.legendaryNukeFlightTime(input.fromTile, input.targetTile);
      const interceptionCapacity = this.legendarySamInterceptionCapacity(
        input.fromTile,
        input.targetTile,
        null,
        input.samProfiles,
      );
      const nukeId =
        typeof input.nuke.id === "function" ? input.nuke.id() : "active-missile";
      const route = this.legendaryBuildMissileRoute(
        {
          fromTile: motion?.fromTile ?? input.fromTile,
          targetTile: input.targetTile,
          impactTick: flightTimeTicks,
          launchOffset: 0,
          weapon: input.type,
          id: `active:${String(nukeId)}`,
          path: motion?.path ?? null,
        },
        input.samProfiles,
      );
      const salvoRisk = legendaryMissileSalvoRisk({
        atomArrivalTicks:
          input.type === UNIT.HydrogenBomb ? [] : [flightTimeTicks],
        hydrogenArrivalTick:
          input.type === UNIT.HydrogenBomb ? flightTimeTicks : null,
        interceptionCapacity,
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        routes: [route],
        samProfiles: input.samProfiles,
        completionTick: 0,
      });
      return this.legendaryActiveMissileThreatResult({
        input,
        flightTimeTicks,
        interceptionCapacity,
        route,
        salvoRisk,
      });
    }

    legendaryActiveMissileThreatResult({
      input,
      flightTimeTicks,
      interceptionCapacity,
      route,
      salvoRisk,
    }) {
      const { atomCost, hydrogenCost, totalValue, atomRadius, hydrogenRadius } =
        input.context;
      const score = legendaryMissileThreatScore({
        enemySilos: [{ level: 1 }],
        enemyGold: this.legendaryMissileThreatGold(
          input.type,
          atomCost,
          hydrogenCost,
        ),
        atomCost: atomCost > 0n ? atomCost : 1n,
        hydrogenCost: hydrogenCost > 0n ? hydrogenCost : 1n,
        flightTimeTicks,
        vulnerableExposure:
          totalValue > 0 ? Math.min(1, input.exposure.value / totalValue) : 0,
        vulnerableStructures: input.exposure.count,
        vulnerableBlastArea: Math.max(1, input.exposure.radiusSquared),
        atomBlastArea: Math.max(1, atomRadius * atomRadius),
        hydrogenBlastArea: Math.max(1, hydrogenRadius * hydrogenRadius),
        interceptionCapacity,
        readyShots: 1,
        salvoRisk,
      });
      return {
        ...score,
        score: Math.max(
          score.score,
          flightTimeTicks < LEGENDARY_SAM_IMPACT_MARGIN_TICKS ? 2 : 0,
        ),
        critical: !salvoRisk.fullyDefended,
        inFlight: true,
        nuke: input.nuke,
        targetTile: input.targetTile,
        weapon: input.type,
        enemySilos: [],
        enemyGold:
          input.type === UNIT.HydrogenBomb ? hydrogenCost : atomCost,
        salvoPlan: {
          risk: salvoRisk,
          readyShots: 1,
          schedule: salvoRisk,
          routes: [route],
          samProfiles: input.samProfiles,
        },
        flightTimeTicks,
      };
    }

    legendaryMissileThreatGold(type, atomCost, hydrogenCost) {
      const preferred = type === UNIT.HydrogenBomb ? hydrogenCost : atomCost;
      return preferred > 0n ? preferred : 1n;
    }

    missileDefenseStateFingerprint() {
      const parts = [];
      const read = (fn, fallback = "") => {
        {
          const value = fn();
          return value === null || value === undefined ? fallback : value;
        }
      };
      const unitFingerprint = (unit) => {
        const id = read(() => unit.id?.(), "");
        const tile = read(() => unit.tile?.(), "");
        const level = read(() => unit.level?.(), "");
        const underConstruction = read(
          () => (unit.isUnderConstruction?.() ? 1 : 0),
          0,
        );
        const active = read(() => unit.isActive?.(), "");
        const queue = read(
          () => {
            const raw = unit.missileTimerQueue?.();
            return Array.isArray(raw) ? raw.map(String).join(",") : "";
          },
          "",
        );
        return [id, tile, level, underConstruction, active, queue]
          .map(String)
          .join(":");
      };
      const collectUnits = (label, owner, types) => {
        const fingerprints = [];
        for (const type of types) {
          const units = typeof owner?.units === "function" ? owner.units(type) : [];
          if (!Array.isArray(units)) continue;
          for (const unit of units) {
            if (unit) fingerprints.push(`${String(type)}=${unitFingerprint(unit)}`);
          }
        }
        fingerprints.sort();
        parts.push(`${label}[${fingerprints.join(",")}]`);
      };

      let atomCost = 0n;
      let hydrogenCost = 0n;
      {
        atomCost = BigInt(this.cost(UNIT.AtomBomb));
      }{
        hydrogenCost = BigInt(this.cost(UNIT.HydrogenBomb));
      }

      // The trajectory planner only changes its threat model when an enemy can
      // afford a different shot sequence. Including the exact gold balance here
      // made the three-tick context bucket ineffective because gold changes on
      // every simulation tick. Keep the hydrogen reservation and affordable atom
      // count, which are the two values used by legendaryMissileSalvoPlan().
      const enemyGoldCapacityFingerprint = (enemy) => {
        const rawGold = read(() => enemy.gold(), "");
        {
          const gold = BigInt(rawGold);
          if (atomCost <= 0n && hydrogenCost <= 0n) {
            return `raw=${String(rawGold)}`;
          }
          const canHydrogen = hydrogenCost > 0n && gold >= hydrogenCost;
          const atomBudget = canHydrogen ? gold - hydrogenCost : gold;
          const affordableAtoms =
            atomCost > 0n ? atomBudget / atomCost : 0n;
          return `${canHydrogen ? 1 : 0}:${affordableAtoms.toString()}`;
        }
      };

      const mySid = read(() => this.player.smallID(), "");
      collectUnits("own-structures", this.player, [
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      ]);
      collectUnits("own-sams", this.player, [UNIT.SAMLauncher]);

      const { hostilePlayers, friendlyPlayers } = this.partitionFingerprintPlayers(
        read(() => this.game.players(), []),
        mySid,
        read,
      );
      friendlyPlayers.sort((left, right) =>
        String(read(() => left.smallID(), "")).localeCompare(
          String(read(() => right.smallID(), "")),
        ),
      );
      for (const ally of friendlyPlayers) {
        const sid = read(() => ally.smallID(), "");
        collectUnits(`friendly-${String(sid)}-sams`, ally, [UNIT.SAMLauncher]);
      }
      hostilePlayers.sort((left, right) =>
        String(read(() => left.smallID(), "")).localeCompare(
          String(read(() => right.smallID(), "")),
        ),
      );
      for (const enemy of hostilePlayers) {
        const sid = read(() => enemy.smallID(), "");
        parts.push(
          `enemy=${String(sid)}:capacity=${enemyGoldCapacityFingerprint(enemy)}`,
        );
        collectUnits(`enemy-${String(sid)}-silos`, enemy, [UNIT.MissileSilo]);
      }

      const activeMissiles = typeof this.game?.units === "function"
        ? this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb)
        : [];
      const missileFingerprints = [];
      if (Array.isArray(activeMissiles)) {
        for (const missile of activeMissiles) {
          if (!missile) continue;
          missileFingerprints.push(
            [
              read(() => missile.id?.(), ""),
              read(() => missile.type?.(), ""),
              read(() => missile.owner?.()?.smallID?.(), ""),
              read(() => missile.tile?.(), ""),
              read(() => missile.targetTile?.(), ""),
              read(() => missile.isActive?.(), ""),
            ]
              .map(String)
              .join(":"),
          );
        }
      }
      missileFingerprints.sort();
      parts.push(`active-missiles[${missileFingerprints.join(",")}]`);
      return parts.join("|");
    }

    partitionFingerprintPlayers(players, mySid, read) {
      const hostilePlayers = [];
      const friendlyPlayers = [];
      for (const other of players) {
        if (!other) continue;
        const sid = read(() => other.smallID(), "");
        if (String(sid) === String(mySid)) continue;
        const friendly =
          this.player.isFriendly(other) || this.player.isOnSameTeam(other);
        (friendly ? friendlyPlayers : hostilePlayers).push(other);
      }
      return { hostilePlayers, friendlyPlayers };
    }

    missileDefenseSnapshotIsCurrent(expectedTick, expectedStateKey) {
      const currentTick = Number(this.game?.ticks?.());
      if (
        Number.isFinite(expectedTick) &&
        Number.isFinite(currentTick) &&
        currentTick !== expectedTick
      ) {
        return false;
      }
      return (
        expectedStateKey === null ||
        expectedStateKey === undefined ||
        this.missileDefenseStateFingerprint() === expectedStateKey
      );
    }

    legendaryEmptyMissileDefenseContext() {
      let config = {};
      {
        config = this.game.config() || {};
      }
      const isDisabled = (type) => {
        {
          return typeof config.isUnitDisabled === "function"
            ? config.isUnitDisabled(type)
            : false;
        }
      };
      const readRadius = (type, fallback) => {
        {
          const radius = Number(config.nukeMagnitudes?.(type)?.outer);
          return Number.isFinite(radius) && radius > 0 ? radius : fallback;
        }
      };
      const readCost = (type) => {
        {
          return BigInt(this.cost(type));
        }
      };
      const atomCost = isDisabled(UNIT.AtomBomb)
        ? 0n
        : readCost(UNIT.AtomBomb);
      const hydrogenCost = isDisabled(UNIT.HydrogenBomb)
        ? 0n
        : readCost(UNIT.HydrogenBomb);
      const atomRadius = readRadius(UNIT.AtomBomb, 70);
      const hydrogenRadius = readRadius(UNIT.HydrogenBomb, 160);
      let structures;
      {
        structures = this.player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.Port,
          UNIT.MissileSilo,
        );
      }
      if (!Array.isArray(structures)) structures = [];
      const totalValue = structures.reduce(
        (total, unit) => total + this.legendaryCriticalStructureValue(unit),
        0,
      );
      return {
        score: 0,
        critical: false,
        threats: [],
        structures,
        totalValue,
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        activeMissiles: [],
      };
    }

    getMissileDefenseContext() {
      const tick = safeStructureGameTick(this.game);
      const signal = this.missileDefenseSignalSnapshot();
      const identity = this.missileDefenseContextIdentity(tick, signal);
      const { cacheKey, missileSignal } = identity;
      if (
        cacheKey !== null &&
        this._missileDefenseContextKey === cacheKey &&
        this._missileDefenseContextCache !== null
      ) {
        return this._missileDefenseContextCache;
      }

      const context = missileSignal === false
        ? this.legendaryEmptyMissileDefenseContext()
        : this.legendaryMissilePlacementContext();
      if (Number.isFinite(tick)) {
        this._missileDefenseContextTick = tick;
        this._missileDefenseContextKey = cacheKey;
        this._missileDefenseContextCache = context;
      }
      return context;
    }

    missileDefenseContextIdentity(tick, signal) {
      const activeMissile = signal?.hasActiveHostileMissile === true;
      const missileSignal =
        signal === null
          ? null
          : signal.hasBuiltHostileSilo ||
            signal.hasActiveHostileMissile === null ||
            activeMissile;
      let cacheTick = null;
      if (Number.isFinite(tick)) {
        cacheTick = activeMissile
          ? tick
          : Math.floor(tick / LEGENDARY_MISSILE_DEFENSE_CONTEXT_BUCKET_TICKS);
      }
      let stateKey = "unknown-missile-signal";
      if (missileSignal === false) stateKey = "no-missile-signal";
      else if (signal !== null) stateKey = this.missileDefenseStateFingerprint();
      return {
        missileSignal,
        cacheKey: Number.isFinite(cacheTick) ? `${cacheTick}|${stateKey}` : null,
      };
    }

    legendaryMissileTargetCandidates(
      structures,
      enemySilos,
      radius,
      totalValue,
      {
        structureValues = null,
        structureTiles = null,
        entryCache = null,
        orderingCache = null,
      } = {},
    ) {
      const radiusSquared = Math.max(0, Number(radius) || 0) ** 2;
      const valueOf = (unit) =>
        structureValues?.get(unit) ?? this.legendaryCriticalStructureValue(unit);
      let entries = entryCache?.get(radiusSquared);
      if (entries === undefined) {
        entries = (structures || [])
          .map((target) =>
            this.legendaryMissileTargetEntry(
              target,
              structures,
              radiusSquared,
              totalValue,
              { valueOf, structureTiles },
            ),
          )
          .filter((entry) => entry !== null);
        entryCache?.set(radiusSquared, entries);
      }

      const limit = Math.min(LEGENDARY_MAX_MISSILE_TARGETS, entries.length);
      if (entries.length <= limit) return entries;

      let orderings = orderingCache?.get(radiusSquared);
      if (orderings === undefined) {
        const byExposure = entries
          .slice()
          .sort(
            (left, right) =>
              right.exposedValue - left.exposedValue ||
              right.exposedStructures - left.exposedStructures,
          );
        const byValue = entries
          .slice()
          .sort(
            (left, right) =>
              valueOf(right.target) - valueOf(left.target) ||
              right.exposedValue - left.exposedValue,
          );
        orderings = { byExposure, byValue };
        orderingCache?.set(radiusSquared, orderings);
      }
      return this.legendarySelectMissileTargets(
        entries,
        orderings.byExposure,
        orderings.byValue,
        enemySilos,
        limit,
      );
    }

    legendaryMissileTargetEntry(
      target,
      structures,
      radiusSquared,
      totalValue,
      {
        valueOf = (unit) => this.legendaryCriticalStructureValue(unit),
        structureTiles = null,
      } = {},
    ) {
      const tileOf = (unit) => structureTiles?.get(unit) ?? unit?.tile?.();
      const targetTile = tileOf(target);
      if (targetTile === null || targetTile === undefined) return null;
      let exposedValue = valueOf(target);
      let exposedStructures = 1;
      for (const other of structures || []) {
        if (other === target) continue;
        {
          const otherTile = tileOf(other);
          if (
            this.game.euclideanDistSquared(targetTile, otherTile) <=
            radiusSquared
          ) {
            exposedValue += valueOf(other);
            exposedStructures++;
          }
        }
      }
      return {
        target,
        tile: targetTile,
        exposedValue,
        exposedStructures,
        exposure: totalValue > 0 ? Math.min(1, exposedValue / totalValue) : 0,
      };
    }

    legendarySelectMissileTargets(
      entries,
      byExposure,
      byValue,
      enemySilos,
      limit,
    ) {
      const selected = [];
      const selectedEntries = new Set();
      const exposureCount = Math.max(8, Math.ceil(limit * 0.6));
      const valueCount = Math.max(4, Math.floor(limit * 0.25));
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        byExposure.slice(0, exposureCount),
        limit,
      );
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        byValue.slice(0, valueCount),
        limit,
      );
      const nearest = (enemySilos || [])
        .map((silo) => this.nearestLegendaryMissileTarget(silo, entries))
        .filter((entry) => entry !== null);
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        nearest,
        limit,
      );
      this.appendUniqueMissileTargets(
        selected,
        selectedEntries,
        byExposure,
        limit,
      );
      return selected;
    }

    appendUniqueMissileTargets(selected, seen, candidates, limit) {
      for (const entry of candidates) {
        if (selected.length >= limit) return;
        if (seen.has(entry)) continue;
        seen.add(entry);
        selected.push(entry);
      }
    }

    nearestLegendaryMissileTarget(silo, entries) {
      let nearest = null;
      let nearestDistance = Infinity;
      for (const entry of entries) {
        {
          const distance = this.game.manhattanDist(silo.tile(), entry.tile);
          if (distance >= nearestDistance) continue;
          nearest = entry;
          nearestDistance = distance;
        }
      }
      return nearest;
    }

    legendaryMissilePlacementContext() {
      const base = this.legendaryMissilePlacementBaseContext();
      const {
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        structures,
        structureValues,
        structureTiles,
        launchMetadataCache,
        totalValue,
        priorityStructures,
      } = base;
      const enemies = this.legendaryHostilePlayers();
      const samProfiles = this.legendaryFriendlySamProfiles();
      const threats = [];

      for (const enemy of enemies) {
        const bestTarget = this.legendaryEnemyMissileThreat(
          enemy,
          base,
          samProfiles,
        );
        if (bestTarget !== null) threats.push(bestTarget);
      }

      const activeMissiles = this.legendaryActiveMissileThreats(
        {
          structures,
          totalValue,
          atomCost,
          hydrogenCost,
          atomRadius,
          hydrogenRadius,
          samProfiles,
          structureValues,
          structureTiles,
          launchMetadataCache,
        },
      );
      threats.push(...activeMissiles);

      threats.sort((a, b) => b.score - a.score);
      const strongest = threats[0] ?? {
        score: 0,
        critical: false,
        weapon: null,
        flightTimeTicks: Infinity,
        targetTile: null,
        atomRadius,
        hydrogenRadius,
        activeMissiles,
      };
      return {
        ...strongest,
        threats,
        samProfiles,
        structures,
        structureValues,
        structureTiles,
        launchMetadataCache,
        priorityStructures,
        totalValue,
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        activeMissiles,
      };
    }

    legendaryActiveMissileDefenseContext() {
      const base = this.legendaryMissilePlacementBaseContext();
      const samProfiles = this.legendaryFriendlySamProfiles();
      const activeMissiles = this.legendaryActiveMissileThreats({
        ...base,
        samProfiles,
      });
      const strongest = activeMissiles[0] ?? {
        score: 0,
        critical: false,
        weapon: null,
        flightTimeTicks: Infinity,
        targetTile: null,
      };
      return {
        ...strongest,
        threats: activeMissiles,
        samProfiles,
        ...base,
        activeMissiles,
      };
    }

    legendaryMissilePlacementBaseContext() {
      const config = this.game.config();
      const atomCost = config.isUnitDisabled(UNIT.AtomBomb)
        ? 0n
        : this.cost(UNIT.AtomBomb);
      const hydrogenCost = config.isUnitDisabled(UNIT.HydrogenBomb)
        ? 0n
        : this.cost(UNIT.HydrogenBomb);
      const atomRadius = Number(config.nukeMagnitudes(UNIT.AtomBomb).outer);
      const hydrogenRadius = Number(
        config.nukeMagnitudes(UNIT.HydrogenBomb).outer,
      );
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      const valuedStructures = structures.map((unit) => ({
        unit,
        value: this.legendaryCriticalStructureValue(unit),
      }));
      const totalValue = valuedStructures.reduce(
        (total, entry) => total + entry.value,
        0,
      );
      const priorityStructures = valuedStructures
        .slice()
        .sort((left, right) => right.value - left.value)
        .slice(0, LEGENDARY_MAX_MISSILE_TARGETS);
      const priorityUnits = priorityStructures.map((entry) => entry.unit);
      const structureValues = new Map(
        valuedStructures.map(({ unit, value }) => [unit, value]),
      );
      const structureTiles = new Map(
        structures.map((unit) => [unit, unit?.tile?.()]),
      );
      const missileTargetEntriesCache = new Map();
      const missileTargetOrderingCache = new Map();
      const launchMetadataCache = new Map();
      const candidateShotPlanCache = new Map();
      const interceptionCapacityCache = new Map();
      return {
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        structures,
        structureValues,
        structureTiles,
        missileTargetEntriesCache,
        missileTargetOrderingCache,
        launchMetadataCache,
        candidateShotPlanCache,
        interceptionCapacityCache,
        totalValue,
        priorityStructures: priorityUnits,
      };
    }

    legendaryEnemyMissileThreat(enemy, base, samProfiles) {
      const resources = this.legendaryEnemyMissileResources(enemy);
      if (resources === null || resources.enemySilos.length === 0) return null;
      const { enemyGold, enemySilos } = resources;
      const canHydrogen =
        base.hydrogenCost > 0n && enemyGold >= base.hydrogenCost;
      const canAtom = base.atomCost > 0n && enemyGold >= base.atomCost;
      if (!canHydrogen && !canAtom) return null;
      const weapon = canHydrogen ? UNIT.HydrogenBomb : UNIT.AtomBomb;
      const radius = canHydrogen ? base.hydrogenRadius : base.atomRadius;
      const targets = this.legendaryMissileTargetCandidates(
        base.structures,
        enemySilos,
        radius,
        base.totalValue,
        {
          structureValues: base.structureValues,
          structureTiles: base.structureTiles,
          entryCache: base.missileTargetEntriesCache,
          orderingCache: base.missileTargetOrderingCache,
        },
      );
      let bestTarget = null;
      for (const target of targets) {
        const candidate = this.legendaryScoredEnemyMissileTarget({
          enemy,
          enemyGold,
          enemySilos,
          weapon,
          target,
          base,
          samProfiles,
        });
        if (candidate && (!bestTarget || candidate.score > bestTarget.score)) {
          bestTarget = candidate;
        }
      }
      return bestTarget;
    }

    legendaryEnemyMissileResources(enemy) {
      {
        const enemyGold = BigInt(enemy.gold());
        const enemySilos = enemy
          .units(UNIT.MissileSilo)
          .filter(
            (silo) =>
              !silo.isUnderConstruction() &&
              (!silo.isActive || silo.isActive() !== false),
          );
        return { enemyGold, enemySilos };
      }
    }

    legendaryScoredEnemyMissileTarget(input) {
      const { enemy, enemyGold, enemySilos, weapon, target, base, samProfiles } =
        input;
      const salvoPlan = this.legendaryMissileSalvoPlan(
        {
          enemySilos,
          enemyGold,
          targetTile: target.tile,
          atomCost: base.atomCost,
          hydrogenCost: base.hydrogenCost,
        },
        { samProfilesOverride: samProfiles },
      );
      const sourceMetrics = new Map(
        (salvoPlan.sourceMetrics || []).map((source) => [source.silo, source]),
      );
      const enemySiloLevels = enemySilos.map((unit) => ({ level: unit.level() }));
      let best = null;
      for (const silo of enemySilos) {
        const source = sourceMetrics.get(silo);
        const flightTimeTicks =
          source?.flightTimeTicks ??
          this.legendaryNukeFlightTime(silo.tile(), target.tile);
        const interceptionCapacity =
          source?.interceptionCapacity ??
          this.legendarySamInterceptionCapacity(silo.tile(), target.tile);
        const threat = legendaryMissileThreatScore({
          enemySilos: enemySiloLevels,
          enemyGold,
          atomCost: base.atomCost,
          hydrogenCost: base.hydrogenCost,
          flightTimeTicks,
          vulnerableExposure: target.exposure,
          vulnerableStructures: target.exposedStructures,
          vulnerableBlastArea: target.exposure,
          atomBlastArea: Math.max(1, base.atomRadius * base.atomRadius),
          hydrogenBlastArea: Math.max(
            1,
            base.hydrogenRadius * base.hydrogenRadius,
          ),
          interceptionCapacity,
          readyShots: salvoPlan.readyShots,
          salvoRisk: salvoPlan.risk,
        });
        if (!best || threat.score > best.score) best = threat;
      }
      if (best === null) return null;
      return {
        ...best,
        weapon,
        critical:
          Boolean(best.critical) && !salvoPlan.schedule?.fullyDefended,
        enemy,
        enemySilos,
        enemySiloLevels,
        enemyGold,
        targetTile: target.tile,
        salvoPlan,
      };
    }

    legendaryMissilePlacementRisk(tile, type, context) {
      if (!context || !Array.isArray(context.threats)) return 0;
      let candidateValue = 1;
      if (type === UNIT.MissileSilo) candidateValue = 3;
      if (type === UNIT.Factory || type === UNIT.Port) candidateValue = 4;
      if (type === UNIT.City) candidateValue = 5;
      let worstRisk = this.legendaryActivePlacementRisk(tile, context);
      for (const threat of context.threats) {
        if (threat.inFlight) continue;
        worstRisk = Math.max(
          worstRisk,
          this.legendaryProspectivePlacementRisk(
            tile,
            candidateValue,
            threat,
            context,
          ),
        );
      }
      return worstRisk;
    }

    legendaryActivePlacementRisk(tile, context) {
      let risk = 0;
      for (const active of context.activeMissiles || []) {
        const radius =
          active.weapon === UNIT.HydrogenBomb
            ? context.hydrogenRadius
            : context.atomRadius;
        if (active.targetTile === null || active.targetTile === undefined) continue;
        if (
          this.game.euclideanDistSquared(tile, active.targetTile) <= radius * radius
        ) {
          risk = Math.max(risk, Number(active.score || 0));
        }
      }
      return risk;
    }

    legendaryProspectivePlacementRisk(tile, candidateValue, threat, context) {
      const exposure = this.legendaryCandidateMissileExposure(
        tile,
        candidateValue,
        threat,
        context,
      );
      const shotPlan = this.legendaryCandidateShotPlan(tile, threat, context);
      if (shotPlan === null) return 0;
      const interceptionCapacity = (threat.enemySilos || []).reduce(
        (total, silo) =>
          total +
          this.legendaryCachedSamInterceptionCapacity(
            silo,
            tile,
            context,
          ),
        0,
      );
      const salvoRisk = legendaryMissileSalvoRisk({
        atomArrivalTicks: shotPlan.atomArrivalTicks,
        hydrogenArrivalTick: shotPlan.hydrogenArrivalTick,
        interceptionCapacity,
        samCooldownTicks: this.legendarySamCooldownTicks(),
        marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
        readyShots: shotPlan.sourcePlan.readyShots ?? 0,
        routes: null,
        samProfiles: [],
        completionTick: 0,
      });
      const risk = legendaryMissileThreatScore({
        enemySilos:
          threat.enemySiloLevels ||
          (threat.enemySilos || []).map((unit) => ({ level: unit.level() })),
        enemyGold: threat.enemyGold,
        atomCost: context.atomCost,
        hydrogenCost: context.hydrogenCost,
        flightTimeTicks: shotPlan.nearestFlightTime,
        vulnerableExposure: exposure.ratio,
        vulnerableStructures: exposure.count,
        vulnerableBlastArea: exposure.ratio,
        atomBlastArea: Math.max(1, context.atomRadius * context.atomRadius),
        hydrogenBlastArea: Math.max(
          1,
          context.hydrogenRadius * context.hydrogenRadius,
        ),
        interceptionCapacity,
        readyShots: shotPlan.sourcePlan.readyShots ?? 0,
        salvoRisk,
      });
      return risk.score;
    }

    legendaryCachedSamInterceptionCapacity(silo, targetTile, context = null) {
      const cache = context?.interceptionCapacityCache;
      if (
        !cache ||
        typeof cache.get !== "function" ||
        typeof cache.set !== "function"
      ) {
        return this.legendarySamInterceptionCapacity(silo.tile(), targetTile);
      }
      let byTarget = cache.get(silo);
      if (!byTarget) {
        byTarget = new Map();
        cache.set(silo, byTarget);
      }
      if (byTarget.has(targetTile)) return byTarget.get(targetTile);
      const capacity = this.legendarySamInterceptionCapacity(
        silo.tile(),
        targetTile,
        null,
        context?.samProfiles,
      );
      byTarget.set(targetTile, capacity);
      return capacity;
    }

    legendaryCandidateMissileExposure(tile, candidateValue, threat, context) {
      const radius =
        threat.weapon === UNIT.HydrogenBomb
          ? context.hydrogenRadius
          : context.atomRadius;
      const radiusSquared = radius * radius;
      let value = candidateValue;
      let count = 1;
      const structureValues = context.structureValues;
      const structureTiles = context.structureTiles;
      for (const structure of
        context.priorityStructures || context.structures || []) {
        const structureTile = structureTiles?.has(structure)
          ? structureTiles.get(structure)
          : structure.tile();
        if (
          this.game.euclideanDistSquared(tile, structureTile) > radiusSquared
        ) continue;
        value +=
          structureValues?.get(structure) ??
          this.legendaryCriticalStructureValue(structure);
        count++;
      }
      const totalValue = context.totalValue + candidateValue;
      return { value, count, ratio: Math.min(1, value / Math.max(1, totalValue)) };
    }

    legendaryCachedCandidateShotPlan(tile, threat, context) {
      const cache = context?.candidateShotPlanCache;
      if (!cache || typeof cache.get !== "function") {
        return { hit: false, plan: null };
      }
      const byTarget = cache.get(threat);
      if (!byTarget || !byTarget.has(tile)) {
        return { hit: false, plan: null };
      }
      return { hit: true, plan: byTarget.get(tile) };
    }

    rememberLegendaryCandidateShotPlan(tile, threat, context, plan) {
      const cache = context?.candidateShotPlanCache;
      if (
        !cache ||
        typeof cache.get !== "function" ||
        typeof cache.set !== "function"
      ) {
        return;
      }
      let byTarget = cache.get(threat);
      if (!byTarget) {
        byTarget = new Map();
        cache.set(threat, byTarget);
      }
      byTarget.set(tile, plan);
    }

    legendaryCandidateShotPlan(tile, threat, context = null) {
      const cached = this.legendaryCachedCandidateShotPlan(
        tile,
        threat,
        context,
      );
      if (cached.hit) return cached.plan;
      const sourcePlan = threat.salvoPlan || {};
      const atomCount = Array.isArray(sourcePlan.atomArrivalTicks)
        ? sourcePlan.atomArrivalTicks.length
        : 0;
      const hydrogenCount =
        sourcePlan.hydrogenArrivalTick === null ||
        sourcePlan.hydrogenArrivalTick === undefined
          ? 0
          : 1;
      const routeCount = Array.isArray(sourcePlan.routes)
        ? sourcePlan.routes.length
        : 0;
      const launches = this.legendaryEnemyMissileLaunchPlan(
        threat.enemySilos || [],
        tile,
        Math.max(1, atomCount + hydrogenCount, routeCount),
        {
          siloMetadataCache: context?.launchMetadataCache || null,
        },
      );
      if (launches.length === 0) {
        this.rememberLegendaryCandidateShotPlan(tile, threat, context, null);
        return null;
      }
      const hasHydrogen =
        threat.weapon === UNIT.HydrogenBomb || hydrogenCount > 0;
      const atomArrivalTicks = launches
        .slice(0, hasHydrogen ? -1 : launches.length)
        .map((launch) => launch.impactTick);
      const hydrogenArrivalTick = hasHydrogen
        ? launches.at(-1).impactTick
        : null;
      const shotPlan = {
        sourcePlan,
        atomArrivalTicks,
        hydrogenArrivalTick,
        nearestFlightTime: Math.min(
          ...launches.map((launch) => launch.flightTicks ?? launch.impactTick),
        ),
      };
      this.rememberLegendaryCandidateShotPlan(tile, threat, context, shotPlan);
      return shotPlan;
    }

    legendaryConstructionState({ cityCount, hasCoastalTiles }) {
      const cities = this.player.units(UNIT.City);
      const ports = this.player.units(UNIT.Port);
      const factories = this.player.units(UNIT.Factory);
      const enemySilos = this.enemyMissileSiloPressure();
      const missileThreat = this.getMissileDefenseContext();
      const rail = this.legendaryRailMetrics(cities, ports, factories);
      const hostile = this.legendaryHostilePlayers();
      const ownSiloLevels = this.ownedLevels(UNIT.MissileSilo);
      const siloParityTarget = this.missileSiloParityTarget();
      const siloParityGap = Math.max(0, siloParityTarget - ownSiloLevels);
      const samLevelParityTarget = this.samLevelParityTarget();
      const samLevelParityGap = this.samLevelParityGap();
      let enemyWarships = 0;
      for (const enemy of hostile) {
        {
          enemyWarships += enemy.units(UNIT.Warship).length;
        }
      }

      const protectableStructures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      return {
        cityCount: Math.max(0, Number(cityCount || cities.length)),
        connectedCities: rail.connectedCities,
        cityRailConnection: rail.cityRailConnection,
        railNeed: rail.railNeed,
        tradeNeed: hasCoastalTiles ? rail.tradeNeed : 0.25,
        destroyerNeed: Math.min(
          2.5,
          Math.max(0.25, 1 + (enemyWarships - this.player.units(UNIT.Warship).length) / 5),
        ),
        targetPressure: this.legendaryEnemyTargetPressure(),
        defenseGap: Math.max(
          this.legendaryDefenseGap(protectableStructures, enemySilos),
          missileThreat.critical ? 1.5 : 0.25,
        ),
        missileThreat,
        portSurvivability: this.legendaryPortSurvivability(ports, enemyWarships),
        enemySilos,
        ownSams: this.ownSamCapacity(),
        ownSilos: ownSiloLevels,
        siloParityTarget,
        siloParityGap,
        samLevelParityTarget,
        samLevelParityGap,
      };
    }

    legendaryCostFactor(cost) {
      const gold = this.player.gold();
      if (gold <= 0n || cost <= 0n) return 1;
      const costShare = Number(cost) / Math.max(1, Number(gold));
      return Math.max(0.25, 1 - Math.min(0.75, costShare * 0.75));
    }

    legendaryConstructionCandidates({
      config,
      citiesDisabled,
      cityCount,
      hasCoastalTiles,
      hasOceanPortTiles,
      missileSilosEnabled,
      nukesEnabled,
    }) {
      const strategicState = this.legendaryConstructionState({
        cityCount,
        hasCoastalTiles,
      });
      const typeOrder = {
        [UNIT.City]: 0,
        [UNIT.Port]: 1,
        [UNIT.Factory]: 2,
        [UNIT.SAMLauncher]: 3,
        [UNIT.MissileSilo]: 4,
      };
      const candidates = [];
      const candidateContext = {
        candidates,
        config,
        hasOceanPortTiles,
        missileSilosEnabled,
        nukesEnabled,
        strategicState,
        typeOrder,
      };

      if (!citiesDisabled) {
        this.addLegendaryConstructionCandidate(candidateContext, UNIT.City, {
          mandatory: cityCount < 2 ? 1 : 0,
          safety: 0,
          strategic: strategicState.railNeed > 1.25 ? 1 : 0,
          deficit: Math.max(0, Math.ceil(strategicState.railNeed - 1)),
          efficiency: 1,
        });
      }

      const ratios = getStructureRatios(Difficulty.Legendary);
      const ratioContext = {
        ...candidateContext,
        cityCount,
        hasCoastalTiles,
        ratios,
      };

      this.addLegendaryRatioCandidate(ratioContext, UNIT.Port, {
        strategic: strategicState.tradeNeed > 1.25 ? 1 : 0,
      });
      this.addLegendaryRatioCandidate(ratioContext, UNIT.Factory, {
        strategic: strategicState.railNeed > 1.25 ? 1 : 0,
      });
      this.addLegendaryRatioCandidate(ratioContext, UNIT.SAMLauncher, {
        mandatory:
          (strategicState.missileThreat.critical ? 1 : 0) +
          (strategicState.samLevelParityGap > 0 ? 1 : 0),
        safety: Math.max(
          strategicState.samLevelParityGap,
          strategicState.missileThreat.critical
            ? Math.max(
                strategicState.defenseGap,
                strategicState.missileThreat.score,
              )
            : strategicState.missileThreat.score,
        ),
        strategic: strategicState.missileThreat.score > 0 ? 2 : 0,
      });
      this.addLegendaryRatioCandidate(ratioContext, UNIT.MissileSilo, {
        strategic: strategicState.targetPressure > 0.75 ? 1 : 0,
      });

      return candidates;
    }

    addLegendaryConstructionCandidate(context, type, values = {}) {
      if (context.config.isUnitDisabled(type) || !autoBotBuildAllowed(type)) return;
      if (type === UNIT.SAMLauncher && !this.hasObservedHostileMissileLaunch()) {
        return;
      }
      if (type === UNIT.Port && !context.hasOceanPortTiles) return;
      const missileType = type === UNIT.SAMLauncher || type === UNIT.MissileSilo;
      if (!context.nukesEnabled && missileType) return;
      if (type === UNIT.SAMLauncher && !context.missileSilosEnabled) return;
      const cost = this.getPerceivedCost(type);
      const objective = legendaryConstructionObjectiveVector(type, {
        ...context.strategicState,
        costFactor: this.legendaryCostFactor(cost),
      });
      context.candidates.push({
        type,
        cost,
        typeOrder: context.typeOrder[type],
        ...objective,
        ...values,
      });
    }

    addLegendaryRatioCandidate(context, type, values = {}) {
      if (!this.legendaryRatioCandidateNeeded(context, type)) return;
      const ratioConfig = context.ratios[type];
      if (ratioConfig === undefined) return;
      const owned = this.ownedLevels(type);
      const ratio = this.legendaryAdjustedStructureRatio(
        context,
        type,
        owned,
        ratioConfig.ratioPerCity,
      );
      if (ratio === null) return;
      const candidateValues = this.legendaryRatioCandidateValues(
        context,
        type,
        values,
        owned,
        ratio,
      );
      if (candidateValues === null) return;
      this.addLegendaryConstructionCandidate(context, type, candidateValues);
    }

    legendaryRatioCandidateValues(context, type, values, owned, ratio) {
      const ratioTarget = Math.floor(context.cityCount * ratio);
      const state = context.strategicState;
      const target =
        type === UNIT.MissileSilo
          ? Math.max(ratioTarget, state.siloParityTarget)
          : ratioTarget;
      const deficit = Math.max(0, target - owned);
      const parityGap = type === UNIT.MissileSilo ? state.siloParityGap : 0;
      const strategic = Number(values.strategic || 0) + Math.min(3, parityGap);
      const mandatory =
        Number(values.mandatory || 0) + (parityGap > 0 ? 1 : 0);
      const safety = Number(values.safety || 0);
      if (deficit <= 0 && strategic <= 0 && mandatory <= 0 && safety <= 0) {
        return null;
      }
      return {
        mandatory,
        safety,
        strategic,
        deficit,
        efficiency: Number(values.efficiency || 0) || 1,
      };
    }

    legendaryRatioCandidateNeeded(context, type) {
      const state = context.strategicState;
      if (type === UNIT.SAMLauncher) {
        return state.missileThreat.score > 0 || state.samLevelParityGap > 0;
      }
      if (type === UNIT.MissileSilo) {
        return state.targetPressure > 0.75 || state.siloParityGap > 0;
      }
      return true;
    }

    legendaryAdjustedStructureRatio(context, type, owned, baseRatio) {
      let ratio = baseRatio;
      if (
        type === UNIT.Factory &&
        context.hasCoastalTiles &&
        !context.config.isUnitDisabled(UNIT.Port) &&
        !this._dominant
      ) {
        ratio *= FACTORY_COASTAL_RATIO_MULTIPLIER;
      }
      if (
        type === UNIT.MissileSilo &&
        owned >= MAX_MISSILE_SILOS &&
        context.strategicState.siloParityGap <= 0
      ) return null;
      if (type === UNIT.MissileSilo && owned === 0) return FIRST_MISSILE_SILO_RATIO;
      return ratio;
    }

    // hasHighStartingGold — NationStructureBehavior.ts:521.
    // src: config().startingGold(this.player.info()) >= threshold.
    // DIVERGENCE: the client PlayerView has no info() method (it carries only a
    // `static` with playerType/isLobbyCreator). config().startingGold only reads
    // `playerInfo.playerType` (Bot → 0n) and `playerInfo.isLobbyCreator`, so we
    // synthesize a minimal PlayerInfo-shaped object from the client player's
    // type() + isLobbyCreator() (read off __src, which exposes isLobbyCreator()).
    hasHighStartingGold() {
      if (this._hasHighStartingGold === null) {
        const src = this.player.__src ?? this.player;
        const playerInfo = {
          playerType: this.player.type(),
          isLobbyCreator:
            typeof src.isLobbyCreator === "function"
              ? src.isLobbyCreator()
              : false,
        };
        this._hasHighStartingGold =
          this.game.config().startingGold(playerInfo) >=
          HIGH_STARTING_GOLD_THRESHOLD;
      }
      return this._hasHighStartingGold;
    }

    // isHighNationDensity — NationStructureBehavior.ts:528.
    isHighNationDensity() {
      const landTiles = this.game.numLandTiles();
      if (landTiles <= 0) return false;
      return (
        this.game.nations().length / landTiles > HIGH_NATION_DENSITY_THRESHOLD
      );
    }

    // dominanceShare — fraction of the LIVE map (numLandTiles − fallout) held by OUR
    // side: the whole team in Team mode, just us in FFA. Returns a number in [0,1], or
    // null when unknowable (no player, denom ≤ 0, mode read failed). Drives the
    // post-dominance economy switch (build factories→rail instead of suppressing them).
    // NOTE we compare this against factoryRailShare (default 0.75), NOT the 0.95 win
    // line: the game ENDS at 95% team share, so factories built then never run trains.
    dominanceShare() {
      if (this.player === null) return null;
      let isTeam;
      {
        isTeam = String(this.game.config().gameConfig().gameMode) === "Team";
      }
      const fallout =
        typeof this.game.numTilesWithFallout === "function"
          ? this.game.numTilesWithFallout()
          : 0;
      const denom = (this.game.numLandTiles() || 0) - fallout;
      if (denom <= 0) return null;

      let ownedTiles = 0;
      if (isTeam) {
        for (const p of this.game.players()) {
          {
            if (p.isPlayer() && this.player.isOnSameTeam(p)) {
              ownedTiles += p.numTilesOwned();
            }
          }
        }
      } else {
        ownedTiles = this.player.numTilesOwned();
      }
      return ownedTiles / denom;
    }

    // shouldBuildStructure — NationStructureBehavior.ts:540.
    shouldBuildStructure(type, cityCount, hasCoastalTiles) {
      if (this.shouldReserveEconomicGrowthForOffense(type)) {
        return false;
      }
      const gameConfig = this.game.config();
      const difficulty = currentDifficulty();
      const ratios = getStructureRatios(difficulty);
      const config = ratios[type];
      if (config === undefined) {
        return false;
      }

      let ratio = config.ratioPerCity;

      // Heavily reduce factory spawning if we have coastal tiles — EXCEPT once we're
      // DOMINANT: then we WANT factories (for rail linking ports↔cities), so the
      // coastal suppression (which keeps a coastal nation at ~0-2 factories) is lifted
      // and the factory target rises to its full ratioPerCity. (winFixes-gated via
      // this._dominant, set in doHandleStructures.)
      if (
        type === UNIT.Factory &&
        hasCoastalTiles &&
        !gameConfig.isUnitDisabled(UNIT.Port) &&
        !this._dominant
      ) {
        ratio *= FACTORY_COASTAL_RATIO_MULTIPLIER;
      }

      const owned = this.ownedLevels(type);
      const siloParityTarget =
        type === UNIT.MissileSilo && state.settings.winFixes
          ? this.missileSiloParityTarget()
          : 0;

      // Hard cap on missile silos, except while the custom SAM-parity target
      // requires additional silo levels.
      if (
        type === UNIT.MissileSilo &&
        owned >= MAX_MISSILE_SILOS &&
        owned >= siloParityTarget
      ) {
        return false;
      }

      // First missile silo uses a higher ratio so nations can start nuking earlier
      if (type === UNIT.MissileSilo && owned === 0) {
        ratio = FIRST_MISSILE_SILO_RATIO;
      }

      const ratioTarget = Math.floor(cityCount * ratio);
      const targetCount =
        type === UNIT.MissileSilo
          ? Math.max(ratioTarget, siloParityTarget)
          : ratioTarget;

      return owned < targetCount;
    }

    // cost — NationStructureBehavior.ts:581.
    // src: this.game.unitInfo(type).cost(this.game, this.player).
    // DIVERGENCE: reproduced from the Config.ts cost formulas as BigInt (the
    // passthrough cost fn would mis-compute numUnits from the client's
    // count/boolean unitsOwned/unitsConstructed — see ownedLevels). numUnits is
    // the core-faithful level-sum; Port/Factory combine BOTH types per the
    // costWrapper arglist (Config.ts:309-401). MIRV uses the base price only
    // (numMirvsLaunched is core-only) — see getSaveUpTarget DIVERGENCE.
    cost(type) {
      switch (type) {
        case UNIT.Port: {
          const n = this.ownedLevels(UNIT.Port) + this.ownedLevels(UNIT.Factory);
          return BigInt(Math.min(1_000_000, Math.pow(2, n) * 125_000));
        }
        case UNIT.Factory: {
          const n = this.ownedLevels(UNIT.Factory) + this.ownedLevels(UNIT.Port);
          return BigInt(Math.min(1_000_000, Math.pow(2, n) * 125_000));
        }
        case UNIT.City: {
          const n = this.ownedLevels(UNIT.City);
          return BigInt(Math.min(1_000_000, Math.pow(2, n) * 125_000));
        }
        case UNIT.SAMLauncher: {
          const n = this.ownedLevels(UNIT.SAMLauncher);
          return BigInt(Math.min(3_000_000, (n + 1) * 1_500_000));
        }
        case UNIT.MissileSilo:
          return 1_000_000n;
        case UNIT.DefensePost: {
          const n = this.ownedLevels(UNIT.DefensePost);
          return BigInt(Math.min(250_000, (n + 1) * 50_000));
        }
        case UNIT.AtomBomb:
          return 750_000n;
        case UNIT.HydrogenBomb:
          return 5_000_000n;
        case UNIT.MIRV:
          // DIVERGENCE: src = 25M + numMirvsLaunched()*15M; numMirvsLaunched is
          // core-only (game.stats() is not on the client GameView). We use the
          // base 25M (no MIRVs launched assumed) — same approach as
          // mirvBehavior.js, but synchronous here (getSaveUpTarget is sync), so
          // we can't probe buildables for the live value.
          return 25_000_000n;
        case UNIT.Warship: {
          const n = this.ownedLevels(UNIT.Warship);
          return BigInt(Math.min(1_000_000, (n + 1) * 250_000));
        }
        default:
          return 0n;
      }
    }

    // maybeSpawnStructure — NationStructureBehavior.ts:585 (now async).
    async maybeSpawnStructure(type, options = {}) {
      if (!this.structureSpawnEligible(type, options)) return false;
      const perceivedCost = this.constructionCostForOptions(type, options);
      // Keep the MIRV war chest scoped to offensive silo construction. Cities,
      // factories, ports and SAMs must still spend normal available gold.
      const availableGold = this.availableGoldAfterReserve(type);
      if (availableGold < perceivedCost) {
        return false;
      }

      const structures = this.player.units(type);
      const economicType = ECONOMIC_STRUCTURE_TYPES.includes(type);
      // Productive structures are expansion first. A failed bounded placement
      // probe is not proof that the map has no room: it can also mean a worker
      // timeout, an unavailable descriptor, or an unlucky candidate sample.
      // Therefore it must never be converted into an upgrade. The planner may
      // upgrade an economic structure only when a future exhaustive placement
      // result explicitly supplies economicSpaceExhausted=true.
      if (economicType && this.hasStructureUnderConstruction(structures)) {
        return false;
      }

      if (!economicType) {
        const upgradeDecision = await this.structureUpgradeBeforeSpawn(
          type,
          structures,
          options,
        );
        if (upgradeDecision !== null) return upgradeDecision;
      }

      const buildable = await this.structureSpawnBuildable(
        type,
        structures,
        economicType,
        options,
      );
      if (buildable === null) return false;
      if (typeof buildable === "boolean") return buildable;
      return this.emitStructureBuildable(type, buildable);
    }

    async structureSpawnBuildable(type, structures, economicType, options) {
      // RANK-THEN-PROBE: structureSpawnTile now returns the snapped BuildableUnit
      // (the first build-only descriptor down the value-ranked list) instead of
      // a bare TileRef, folding the src `player.canBuild(type, tile)` check into
      // the probe. src: tile = structureSpawnTile(type); if null → return;
      // canBuild = player.canBuild(type, tile); if false → return;
      // addExecution(ConstructionExecution).
      // A prior bounded sample may have missed a legal economic site.  In that
      // case findEconomicPlacementOrExhaustion keeps an incremental exhaustive
      // scan specifically so the bot can resume it later.  Re-running another
      // 25 random worker probes first on every tick both delays that proof and
      // creates visible Auto-build stalls.  Resume the unchanged scan directly;
      // its fingerprint is invalidated below as soon as territory or structure
      // geometry changes.
      let buildable = null;
      if (!economicType || !this.hasPendingEconomicPlacementScan(type)) {
        buildable = await this.structureSpawnTile(type, options);
      }
      if (buildable === null) {
        if (!economicType) return null;
        const placement = await this.findEconomicPlacementOrExhaustion(
          type,
          options,
        );
        if (placement.status === "buildable") {
          buildable = placement.buildable;
        } else if (placement.status === "no-space") {
          return this.maybeUpgradeStructure(structures, {
            economicSpaceExhausted: true,
          });
        } else {
          return false;
        }
      }
      return buildable;
    }

    emitStructureBuildable(type, buildable) {
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      return this.emitStructureBuild(
        buildMenu,
        buildable,
        buildable.canBuild,
        tr("🏗️ Build {type}", { type }),
      );
    }

    constructionCostForOptions(type, options = {}) {
      if (options.useActualCost === true) return this.cost(type);
      return this.getConstructionCost(type);
    }

    emitStructureBuild(buildMenu, buildable, tile, action) {
      // BuildMenu intentionally prioritizes canUpgrade whenever a descriptor
      // exposes both operations. A placement probe can legally expose that
      // hybrid state when its requested tile is an existing structure while a
      // nearby snapped construction tile also exists. This method is the final
      // construction-only boundary: never let such a descriptor turn a planned
      // new City/Factory/Port/SAM into an upgrade.
      if (!this.isUsableStructureBuildable(buildable, tile, buildable?.type)) {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, tile, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(action, "build");
      return true;
    }

    structureSpawnEligible(type, options = {}) {
      if (!autoBotBuildAllowed(type)) return false;
      if (
        type === UNIT.SAMLauncher &&
        options.allowPreemptiveSam !== true &&
        !this.hasObservedHostileMissileLaunch()
      ) {
        return false;
      }
      return (
        options.ignoreEconomicReserve === true ||
        !this.shouldReserveEconomicGrowthForOffense(type)
      );
    }

    async structureUpgradeBeforeSpawn(type, structures, options) {
      if (options.forceNewStructure) return null;
      const legendaryEmergency =
        isLegendaryDifficulty() &&
        this.legendaryMissileDefenseNeedsAction(
          this.getMissileDefenseContext(),
        );
      if (legendaryEmergency) return null;
      if (this.getTotalStructureDensity() <= UPGRADE_DENSITY_THRESHOLD) {
        return null;
      }
      if (!this.game.config().unitInfo(type).upgradable) return null;
      if (await this.maybeUpgradeStructure(structures)) return true;
      // Only an in-flight structure should block a new ratio-needed placement.
      return this.hasStructureUnderConstruction(structures) ? false : null;
    }

    hasStructureUnderConstruction(structures) {
      if (!Array.isArray(structures)) return false;
      return structures.some((structure) => {
        {
          return structure?.isUnderConstruction?.() === true;
        }
      });
    }

    // getPerceivedCost — NationStructureBehavior.ts:627.
    getPerceivedCost(type) {
      const realCost = this.cost(type);

      // Productive structures use their real next-build cost. Keep the
      // perceived-cost multiplier for offensive/defensive structures because
      // the explicit silo reserve below still needs to protect the next
      // economic and SAM actions without freezing the whole build planner.
      if (
        state.settings.winFixes &&
        ECONOMIC_STRUCTURE_TYPES.includes(type)
      ) {
        return realCost;
      }

      const saveUpTarget = this.getSaveUpTarget();
      if (saveUpTarget === 0n || this.player.gold() >= saveUpTarget) {
        return realCost;
      }

      const owned = this.ownedLevels(type);

      let increasePerOwned;
      if (type === UNIT.City) {
        increasePerOwned = CITY_PERCEIVED_COST_INCREASE_PER_OWNED;
      } else {
        const difficulty = currentDifficulty();
        const ratios = getStructureRatios(difficulty);
        const config = ratios[type];
        increasePerOwned =
          config && config.perceivedCostIncreasePerOwned !== undefined
            ? config.perceivedCostIncreasePerOwned
            : 0.1;
      }

      // realCost * (1 + increasePerOwned * owned)
      const multiplier = 1 + increasePerOwned * owned;
      return BigInt(Math.ceil(Number(realCost) * multiplier));
    }

    // getSaveUpTarget — NationStructureBehavior.ts:657.
    getSaveUpTarget() {
      const config = this.game.config();

      // Just save up for SAMs if missile silos are disabled
      if (config.isUnitDisabled(UNIT.MissileSilo)) {
        return this.cost(UNIT.SAMLauncher);
      }

      // Save up a limited amount in team games (src reads gameConfig().gameMode).
      if (this.game.config().gameConfig().gameMode === GameMode.Team) {
        return this.cost(UNIT.HydrogenBomb);
      }

      const mirvEnabled = !config.isUnitDisabled(UNIT.MIRV);
      const hydroEnabled = !config.isUnitDisabled(UNIT.HydrogenBomb);
      const atomEnabled = !config.isUnitDisabled(UNIT.AtomBomb);

      if (mirvEnabled) {
        // Save up for MIRV + Hydrogen Bomb
        return this.cost(UNIT.MIRV) + this.cost(UNIT.HydrogenBomb);
      }
      if (hydroEnabled) {
        // Save up for 5 hydrogen bombs
        return this.cost(UNIT.HydrogenBomb) * 5n;
      }
      if (atomEnabled) {
        // Save up for 20 atom bombs
        return this.cost(UNIT.AtomBomb) * 20n;
      }
      // No nukes enabled, just save up for SAMs
      return this.cost(UNIT.SAMLauncher);
    }

    // maybeUpgradeStructure — NationStructureBehavior.ts:696 (now async).
    async maybeUpgradeStructure(structures, options = {}) {
      const type = structures?.[0]?.type?.();
      // Economic upgrades are strictly an exhaustion fallback. Keep that
      // proof at the actuation boundary as well as in maybeSpawnStructure so
      // no direct or future caller can trade a legal new City/Factory/Port
      // site for an upgrade.
      if (
        ECONOMIC_STRUCTURE_TYPES.includes(type) &&
        options.economicSpaceExhausted !== true
      ) {
        return false;
      }
      if (this.getTotalStructureDensity() <= UPGRADE_DENSITY_THRESHOLD) {
        return false;
      }
      if (structures.length === 0) {
        return false;
      }
      const result = await this.findBestStructureToUpgrade(structures);
      if (result !== null) {
        if (type === UNIT.SAMLauncher) {
          const cost = this.buildableCostOrFallback(
            result.bu,
            this.safeStructureCost(UNIT.SAMLauncher),
          );
          if (!this.samUpgradeEconomyCanAbsorb(cost)) return false;
        }
        // src: addExecution(new UpgradeStructureExecution(player, unit.id())).
        // Client: sendBuildOrUpgrade(bu) where bu.canUpgrade !== false. We already
        // probed the BuildableUnit in findBestStructureToUpgrade, so reuse it.
        const buildMenu = getBuildMenu();
        if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
          return false;
        }
        if (!sendAutoBotBuildOrUpgrade(buildMenu, result.bu, undefined, this.game, this.player)) {
          return false;
        }
        state.stats.builds++;
        setLastAction(
          tr("⬆️ Upgrade {type}", { type: result.structure.type() }),
          "build",
        );
        return true;
      }
      return false;
    }

    async maybeUpgradePlannedSam(plan, options = {}) {
      // A built hostile Silo is enough evidence to complete a proven coverage
      // or capacity upgrade before its first missile consumes that window.
      if (!this.plannedSamUpgradeEligible(plan)) return false;

      const availableGold = this.spendableConstructionGold();
      const cacheKey = this.plannedSamUpgradeCostCacheKey(plan);
      const cachedCost = this._plannedSamUpgradeCostCache?.get(cacheKey);
      if (cachedCost !== undefined && cachedCost > availableGold) return false;

      const bu = await this.plannedSamUpgradeBuildable(plan);
      if (bu === null) return false;
      const cost = this.plannedSamUpgradeCost(bu, cacheKey);
      if (cost > availableGold) return false;
      if (
        options.maximumNuclearPriority !== true &&
        !this.samUpgradeEconomyCanAbsorb(cost)
      ) return false;

      return this.emitPlannedSamUpgrade(bu);
    }

    /**
     * A speculative SAM level must be paid from true surplus, after the next
     * currently useful economic action. This makes "the economy is strong
     * enough" an opportunity-cost test instead of a fixed gold, City, or tick
     * threshold. Threat urgency decides which useful SAM receives the level;
     * it does not redefine 3M of economic principal as surplus.
     */
    samUpgradeEconomyCanAbsorb(cost) {
      if (!state.settings.winFixes) return true;
      const upgradeCost = BigInt(cost ?? 0n);
      if (upgradeCost <= 0n) return true;
      const economic = this.economicConstructionPressureForSamUpgrade();
      const economicCost = economic?.cost ?? 0n;
      return this.spendableConstructionGold() >= upgradeCost + economicCost;
    }

    economicConstructionPressureForSamUpgrade() {
      const portfolio = this.economicStructurePortfolio();
      const hasCompleteUnitRecords = ECONOMIC_STRUCTURE_TYPES.every((type) =>
        portfolio.get(type).every(
          (unit) =>
            typeof unit?.isUnderConstruction === "function" &&
            typeof unit?.level === "function",
        ),
      );
      // Older clients and reduced adapters can omit the construction-state
      // methods needed by the portfolio snapshot. Preserve legacy behavior
      // when that evidence is absent.
      return hasCompleteUnitRecords ? this.economicConstructionPressure(portfolio) : null;
    }

    plannedSamUpgradeEligible(plan) {
      return (
        plan !== null &&
        plan !== undefined &&
        plan.targetLevel > plan.currentLevel &&
        this.plannedSamUpgradeHasThreat()
      );
    }

    plannedSamUpgradeHasThreat() {
      return (
        this.hasObservedHostileMissileLaunch() ||
        this.hasBuiltHostileSiloThreat() ||
        this.hasBuiltExternalSiloThreat() ||
        this.hasPlacedSiloOnMap()
      );
    }

    async plannedSamUpgradeBuildable(plan) {
      const buildables = await this.buildableForUnits(
        [plan.sam],
        UNIT.SAMLauncher,
        {
          concurrency: 1,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const buildable = buildables[0];
      return buildable?.canUpgrade === false ? null : buildable ?? null;
    }

    plannedSamUpgradeCost(buildable, cacheKey) {
      if (buildable.cost === undefined || buildable.cost === null) {
        return this.cost(UNIT.SAMLauncher);
      }
      const cost = BigInt(buildable.cost);
      this.rememberPlannedSamUpgradeCost(cacheKey, cost);
      return cost;
    }

    emitPlannedSamUpgrade(buildable) {
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, buildable, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(
        tr("⬆️ Upgrade {type}", { type: UNIT.SAMLauncher }),
        "build",
      );
      return true;
    }

    plannedSamUpgradeCostCacheKey(plan) {
      const samID = plan?.sam?.id?.() ?? "unknown";
      return `${samID}:${Number(plan?.currentLevel ?? 0)}:${this.ownedLevels(UNIT.SAMLauncher)}`;
    }

    rememberPlannedSamUpgradeCost(cacheKey, cost) {
      if (!(this._plannedSamUpgradeCostCache instanceof Map)) {
        this._plannedSamUpgradeCostCache = new Map();
      }
      // A nation owns very few SAMs. Bound the cache anyway so a long match
      // with repeatedly destroyed/rebuilt launchers never accumulates history.
      if (this._plannedSamUpgradeCostCache.size >= 32) {
        this._plannedSamUpgradeCostCache.clear();
      }
      this._plannedSamUpgradeCostCache.set(cacheKey, cost);
    }

    /**
     * Highest priority: keep at least one built SAM's range over every own
     * structure so a Hydrogen Bomb aimed at any of them has an interceptor.
     */
    async maybeEnsureHydrogenStructureCoverage() {
      // Coverage is recomputed from completed geometry. Wait for an already
      // committed SAM to finish before proving that another physical launcher
      // is necessary; otherwise adjacent construction ticks can buy duplicate
      // level-one launchers for the same post-impact structure cluster.
      if (this.hasOwnSamUnderConstruction()) return false;
      const plan = this.hydrogenStructureCoveragePlan();
      if (!plan) return false;
      if (plan.needsNewSam) {
        return this.maybeSpawnStructure(
          UNIT.SAMLauncher,
          this.hostileSiloSamPlacementOptions(),
        );
      }
      return this.maybeUpgradePlannedSam(plan);
    }

    /**
     * Second SAM priority: our highest SAM level must reach the largest
     * hostile built-Silo level sum. The action is one upgrade at a time and
     * repeats until the numeric target is met.
     */
    async maybeUpgradeHydrogenProtectionSam() {
      return this.maybeUpgradePlannedSam(this.hydrogenSamProtectionPlan());
    }

    /**
     * Service the nuke planner's target-specific silo-capacity request. This
     * sits below both H-bomb SAM priorities and above generic hostile-SAM
     * parity, so a required launch capacity is completed before ordinary
     * construction.
     */
    async maybeUpgradeSiloForNukeDemand() {
      const request = this.validNukeSiloUpgradeRequest();
      if (request === null) return false;
      const scopedSilos = this.nukeDemandScopedSilos(request);
      const currentCapacity = scopedSilos.reduce(
        (sum, silo) => sum + Math.max(1, Number(silo.level?.() ?? 1)),
        0,
      );
      if (currentCapacity >= request.requiredCapacity) {
        state.nukeWantSlots = null;
        return false;
      }
      const candidates = scopedSilos.filter((silo) =>
        this.structureBelowUpgradeLimit(silo),
      );
      if (candidates.length === 0) return false;
      const availableGold = this.availableGoldAfterReserve(UNIT.MissileSilo);
      const minimumCost = this.safeStructureCost(UNIT.MissileSilo);
      if (!this.nukeSiloUpgradeBudgetAvailable(availableGold, minimumCost)) {
        return false;
      }
      const buildables = await this.buildableForUnits(
        candidates,
        UNIT.MissileSilo,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const ranked = this.rankNukeDemandSiloUpgrades({
        candidates,
        buildables,
        availableGold,
        minimumCost,
      });
      return this.executeStructureUpgradeCandidate(ranked[0], UNIT.MissileSilo);
    }

    validNukeSiloUpgradeRequest() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.MissileSilo)) {
        return null;
      }
      const request = state.nukeWantSlots;
      const requiredCapacity = Number(request?.need);
      if (!Number.isFinite(requiredCapacity) || requiredCapacity <= 0) return null;
      {
        if (this.game.config().isUnitDisabled(UNIT.MissileSilo)) return null;
      }
      return { ...request, requiredCapacity };
    }

    nukeDemandScopedSilos(request) {
      const builtSilos = (this.player.units(UNIT.MissileSilo) || []).filter(
        (silo) => this.isBuiltStructure(silo),
      );
      const preferredIds = new Set(
        Array.isArray(request.unblockedSiloIds)
          ? request.unblockedSiloIds.map(String)
          : [],
      );
      if (preferredIds.size === 0) return builtSilos;
      const preferred = builtSilos.filter((silo) =>
        preferredIds.has(String(silo.id())),
      );
      return preferred.length > 0 ? preferred : builtSilos;
    }

    isBuiltStructure(structure) {
      {
        return !structure.isUnderConstruction();
      }
    }

    structureBelowUpgradeLimit(structure) {
      const level = Number(structure.level?.() ?? 1);
      return Number.isFinite(level) && level < HYDROGEN_SAM_MAX_UPGRADE_LEVEL;
    }

    safeStructureCost(type) {
      {
        return this.cost(type);
      }
    }

    nukeSiloUpgradeBudgetAvailable(availableGold, minimumCost) {
      if (availableGold < minimumCost) return false;
      const economic = this.economicConstructionPressure();
      const reserve =
        (economic?.cost ?? 0n) + this.defensiveConstructionReserve();
      return availableGold >= minimumCost + reserve;
    }

    rankNukeDemandSiloUpgrades(input) {
      const ownSams = this.player.units(UNIT.SAMLauncher) || [];
      const ranked = [];
      for (let index = 0; index < input.candidates.length; index++) {
        const silo = input.candidates[index];
        const bu = input.buildables[index];
        if (!bu || bu.canUpgrade === false) continue;
        const cost = this.buildableCostOrFallback(bu, input.minimumCost);
        if (cost > input.availableGold) continue;
        ranked.push({
          silo,
          bu,
          cost,
          level: Number(silo.level?.() ?? 1),
          protection: this.siloSamProtectionScore(silo, ownSams),
        });
      }
      ranked.sort((left, right) => this.compareNukeDemandSiloUpgrades(left, right));
      return ranked;
    }

    buildableCostOrFallback(buildable, fallback) {
      {
        return buildable.cost === undefined || buildable.cost === null
          ? fallback
          : BigInt(buildable.cost);
      }
    }

    siloSamProtectionScore(silo, sams) {
      let protection = 0;
      for (const sam of sams) {
        {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) continue;
          const range = Number(this.game.config().samRange(sam.level()));
          const distance = this.game.euclideanDistSquared(silo.tile(), sam.tile());
          if (distance <= range * range) protection += Number(sam.level());
        }
      }
      return protection;
    }

    compareNukeDemandSiloUpgrades(left, right) {
      if (right.protection !== left.protection) {
        return right.protection - left.protection;
      }
      if (left.cost !== right.cost) return left.cost < right.cost ? -1 : 1;
      return left.level - right.level;
    }

    async maybeUpgradeSamForSiloParity() {
      if (!this.samParityUpgradeEnabled()) return false;
      const targetCapacity = this.samLevelParityTarget();
      if (targetCapacity <= 0 || this.ownSamCapacity() >= targetCapacity) {
        return false;
      }
      const samUnits = (this.player.units(UNIT.SAMLauncher) || []).filter(
        (sam) => this.isBuiltActiveSam(sam),
      );
      const buildables = await this.buildableForUnits(
        samUnits,
        UNIT.SAMLauncher,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const candidates = this.samParityUpgradeCandidates(
        samUnits,
        buildables,
        this.spendableConstructionGold(),
      );
      const economicallySafeCandidates = candidates.filter((candidate) =>
        this.samUpgradeEconomyCanAbsorb(candidate.cost),
      );
      economicallySafeCandidates.sort((left, right) =>
        this.compareSamParityUpgrades(left, right));
      return this.executeStructureUpgradeCandidate(
        economicallySafeCandidates[0],
        UNIT.SAMLauncher,
      );
    }

    samParityUpgradeEnabled() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return false;
      }
      if (!this.hasObservedHostileMissileLaunch()) return false;
      {
        return !this.game.config().isUnitDisabled(UNIT.SAMLauncher);
      }
    }

    samParityUpgradeCandidates(samUnits, buildables, availableGold) {
      const candidates = [];
      for (let index = 0; index < samUnits.length; index++) {
        const sam = samUnits[index];
        const bu = buildables[index];
        if (bu === null || bu.canUpgrade === false) continue;
        let cost = this.cost(UNIT.SAMLauncher);
        {
          if (bu.cost !== undefined && bu.cost !== null) cost = BigInt(bu.cost);
        }
        if (cost > availableGold) continue;
        const level = Math.max(1, Number(sam.level() || 1));
        candidates.push({ sam, bu, cost, level });
      }
      return candidates;
    }

    compareSamParityUpgrades(left, right) {
      if (right.level !== left.level) return right.level - left.level;
      if (left.cost !== right.cost) return left.cost < right.cost ? -1 : 1;
      return String(left.sam.id?.() ?? "").localeCompare(
        String(right.sam.id?.() ?? ""),
      );
    }

    executeStructureUpgradeCandidate(selected, type) {
      if (!selected) return false;
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      if (!sendAutoBotBuildOrUpgrade(buildMenu, selected.bu, undefined, this.game, this.player)) {
        return false;
      }
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type }), "build");
      return true;
    }

    async maybeUpgradeMissileDefenseSam(contextOverride = null) {
      if (!this.missileDefenseSamUpgradeEnabled()) return false;
      this._hostileMissileLaunchObserved = true;
      const upgradeableSamUnits = (
        this.player.units(UNIT.SAMLauncher) || []
      ).filter((sam) => this.isBuiltActiveSam(sam));
      if (upgradeableSamUnits.length === 0) return false;
      const buildables = await this.buildableForUnits(
        upgradeableSamUnits,
        UNIT.SAMLauncher,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const upgradeCandidates = this.missileDefenseSamUpgradeCandidates(
        upgradeableSamUnits,
        buildables,
        this.spendableConstructionGold(),
      );
      if (upgradeCandidates.length === 0) return false;
      const context = contextOverride || this.getMissileDefenseContext();
      if (!context || !Array.isArray(context.threats) || context.threats.length === 0) return false;
      const currentEvaluation = contextOverride
        ? this.legendaryDefenseEvaluation(context)
        : this.getMissileDefenseEvaluation(context);
      if (!currentEvaluation.hasThreats || currentEvaluation.fullyDefended) return false;
      const candidates = this.rankMissileDefenseSamUpgrades(
        upgradeCandidates,
        context,
        currentEvaluation,
      );
      return this.executeStructureUpgradeCandidate(candidates[0], UNIT.SAMLauncher);
    }

    missileDefenseSamUpgradeEnabled() {
      if (!autoBotBuildAllowed(UNIT.SAMLauncher)) return false;
      {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
      }
      const signal = this.missileDefenseSignalSnapshot();
      return signal !== null && signal.hasActiveHostileMissile === true;
    }

    missileDefenseSamUpgradeCandidates(sams, buildables, availableGold) {
      const candidates = [];
      const fallbackCost = this.safeStructureCost(UNIT.SAMLauncher);
      for (let index = 0; index < sams.length; index++) {
        const sam = sams[index];
        const bu = buildables[index];
        if (bu === null || bu.canUpgrade === false) continue;
        const cost = this.buildableCostOrFallback(bu, fallbackCost);
        if (cost > availableGold) continue;
        const nextLevel = Math.max(1, Number(sam.level() || 1) + 1);
        candidates.push({
          sam,
          bu,
          cost,
          nextLevel,
          overrides: new Map([[sam.id(), nextLevel]]),
        });
      }
      return candidates;
    }

    rankMissileDefenseSamUpgrades(upgradeCandidates, context, currentEvaluation) {
      const current = {
        evaluation: currentEvaluation,
        margin: currentEvaluation.fullyDefended
          ? currentEvaluation.completionMarginTicks
          : 0,
        capacity: this.legendaryMinimumSamInterceptionCapacity(context),
        unintercepted: currentEvaluation.uninterceptedCount,
      };
      const ranked = upgradeCandidates
        .map((candidate) =>
          this.scoreMissileDefenseSamUpgrade(candidate, context, current),
        )
        .filter((candidate) => candidate !== null);
      ranked.sort((left, right) => this.compareMissileDefenseSamUpgrades(left, right));
      return ranked;
    }

    scoreMissileDefenseSamUpgrade(candidate, context, current) {
      const nextEvaluation = this.legendaryDefenseEvaluation(context, {
        levelOverrides: candidate.overrides,
        completionTick: 0,
      });
      if (
        nextEvaluation.completionMarginTicks <
        LEGENDARY_SAM_IMPACT_MARGIN_TICKS
      ) return null;
      const nextCapacity = this.legendaryMinimumSamInterceptionCapacity(
        context,
        candidate.overrides,
      );
      if (
        !legendaryDefenseActionImproves(
          current.evaluation,
          nextEvaluation,
          current.capacity,
          nextCapacity,
        )
      ) return null;
      const marginGain = Math.max(
        0,
        nextEvaluation.completionMarginTicks - current.margin,
      );
      const capacityGain = Math.max(0, nextCapacity - current.capacity);
      const interceptedGain = Math.max(
        0,
        current.unintercepted - nextEvaluation.uninterceptedCount,
      );
      const reachesFullDefense = nextEvaluation.fullyDefended ? 100 : 0;
      const costFactor = Math.max(1, Number(candidate.cost) / 1_500_000);
      return {
        ...candidate,
        score:
          (reachesFullDefense +
            interceptedGain * 100 +
            marginGain * 10 +
            capacityGain * 2) /
          costFactor,
        marginGain,
        capacityGain,
        interceptedGain,
      };
    }

    compareMissileDefenseSamUpgrades(left, right) {
      if (right.score !== left.score) return right.score - left.score;
      if (right.marginGain !== left.marginGain) {
        return right.marginGain - left.marginGain;
      }
      if (right.capacityGain !== left.capacityGain) {
        return right.capacityGain - left.capacityGain;
      }
      if (right.interceptedGain !== left.interceptedGain) {
        return right.interceptedGain - left.interceptedGain;
      }
      if (left.cost < right.cost) return -1;
      if (left.cost > right.cost) return 1;
      return 0;
    }

    // Kept as a compatibility name for the Legendary adaptive flow and its
    // existing test surface; the same trajectory-aware action is now also
    // available to the custom win-fix path for the other difficulties.
    async maybeUpgradeLegendarySam() {
      return this.maybeUpgradeMissileDefenseSam();
    }

    // getTotalStructureDensity — NationStructureBehavior.ts:717.
    // src uses unit COUNT (not levels) here — kept on .length.
    getTotalStructureDensity() {
      const tilesOwned = this.player.numTilesOwned();
      return tilesOwned > 0
        ? this.player.units(...STRUCTURES_TYPES).length / tilesOwned
        : 0; // ignoring levels for structures
    }

    // findBestStructureToUpgrade — NationStructureBehavior.ts:728 (now async).
    // src filters `upgradable = structures.filter(s => player.canUpgradeUnit(s))`
    // synchronously (pre-RNG). The client has no sync canUpgradeUnit, so we PROBE
    // buildables(unit.tile(),[type]) for each candidate FIRST (keeping the
    // BuildableUnit when canUpgrade !== false) BEFORE any RNG draw, preserving the
    // exact src RNG sequence and scoring. Probe candidates in bounded batches;
    // the first 25 preserve the normal structure candidate budget. Returns
    // {structure, bu} | null.
    async findBestStructureToUpgrade(structures) {
      if (structures.length === 0) return null;
      const { upgradable, buByUnitId } =
        await this.probeUpgradableStructures(structures);
      if (upgradable.length === 0) return null;
      const mkResult = (structure) => ({
        structure,
        bu: buByUnitId.get(structure.id()),
      });
      const randomChance = this.structureUpgradeRandomChance();
      if (this.random.nextInt(0, 100) < randomChance) {
        return mkResult(this.random.randElement(upgradable));
      }
      const samLaunchers = this.player.units(UNIT.SAMLauncher);
      const scored = upgradable.map((structure) => ({
        structure,
        score:
          this.structureSamProtectionScore(structure, samLaunchers) +
          this.random.nextInt(0, 5),
      }));
      scored.sort((a, b) => b.score - a.score);
      const selected = this.selectScoredStructureUpgrade(scored);
      return selected ? mkResult(selected) : null;
    }

    async probeUpgradableStructures(structures) {
      const upgradable = [];
      const buByUnitId = new Map();
      const candidates = structures.slice(0, STRUCTURE_PLACEMENT_CANDIDATE_LIMIT);
      for (
        let offset = 0;
        offset < candidates.length;
        offset += STRUCTURE_PROBE_CONCURRENCY
      ) {
        const batch = candidates.slice(
          offset,
          offset + STRUCTURE_PROBE_CONCURRENCY,
        );
        const buildables = await Promise.all(
          batch.map((structure) => {
            const tile = structure.tile();
            if (this.tileInsideActiveHostileMissileImpact(tile)) return null;
            return this.buildableFor(
              structure.type(),
              tile,
              STRUCTURE_PROBE_TIMEOUT_MS,
            );
          }),
        );
        for (let index = 0; index < batch.length; index++) {
          const structure = batch[index];
          const bu = buildables[index];
          if (bu !== null && bu.canUpgrade !== false) {
            upgradable.push(structure);
            buByUnitId.set(structure.id(), bu);
          }
        }
      }
      return { upgradable, buByUnitId };
    }

    structureUpgradeRandomChance() {
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return 70;
        case Difficulty.Medium:
          return 40;
        case Difficulty.Hard:
          return 25;
        case Difficulty.Impossible:
          return 10;
        case Difficulty.Legendary:
          return 0;
        default:
          return 10;
      }
    }

    structureSamProtectionScore(structure, samLaunchers) {
      let score = 0;
      for (const sam of samLaunchers) {
          const samRange = this.game.config().samRange(sam.level());
          const samRangeSquared = samRange * samRange;
          const distSquared = this.game.euclideanDistSquared(
            structure.tile(),
            sam.tile(),
          );
          if (distSquared <= samRangeSquared) {
            // Protected by this SAM, add score based on SAM level.
            score += 10;
            if (sam.level() > 1) {
              score += (sam.level() - 1) * 7.5;
            }
          }
      }
      return score;
    }

    selectScoredStructureUpgrade(scored) {
      if (scored.length === 0) return null;
      // Legendary has already paid to probe and score every legal upgrade.
      // Choosing a lower-ranked structure for variety is strictly dominated:
      // the type, price and added level are identical, while the sorted winner
      // has at least as much SAM protection. Preserve Nation randomness only
      // for the faithful Easy–Impossible modes.
      if (isLegendaryDifficulty(currentDifficulty())) return scored[0].structure;
      // 50% of the time, pick the second or third best for variety.
      if (scored.length >= 2 && this.random.chance(2)) {
        const pickIndex =
          scored.length >= 3
            ? this.random.nextInt(1, 3) // pick index 1 or 2
            : 1; // only index 1 available
        return scored[pickIndex].structure;
      }
      return scored[0].structure;
    }

    // structureSpawnTile — NationStructureBehavior.ts:814 (now async).
    // RANK-THEN-PROBE: score ALL candidate tiles SYNC by the src value function,
    // sort DESC, then await buildables down the ranked list and take the FIRST
    // whose BuildableUnit describes construction only. Returns that BuildableUnit | null.
    // (src interleaves the value fn with a SYNC canBuild and short-circuits on the
    // first valid best-value tile; probing in descending value order and taking
    // the first buildable yields the SAME tile src's loop picks — the highest-
    // value buildable in the candidate set.)
    async structureSpawnTile(type, options = {}) {
      const probe = this.structureProbeOptions(options);
      const economicType = ECONOMIC_STRUCTURE_TYPES.includes(type);
      const candidateLimit = economicType
        ? Math.min(
            this.economicPlacementBudgetLimit(probe.candidateLimit),
            ECONOMIC_INITIAL_PLACEMENT_CANDIDATE_LIMIT,
          )
        : probe.candidateLimit;
      if (candidateLimit < 1) return null;
      const tiles = this.structureCandidateTiles(type, options, candidateLimit);
      if (economicType) this.consumeEconomicPlacementBudget(tiles.length);
      if (tiles.length === 0) return null;
      const valueFunction = this.structureTileValueFunction(type, options);
      if (valueFunction === null) return null;
      const compactness = this.structurePlacementCompactnessRanker(type);
      const emergency = this.structureMissileEmergency(type, options);
      const { scored, safeScored } = this.rankStructureSpawnTiles(
        type,
        options,
        tiles,
        valueFunction,
        compactness,
      );
      // Do not spend gold on a Factory that can only duplicate routes an
      // existing Factory already serves.  Returning null lets the normal
      // construction order consider City/Port instead, which can create the
      // next paying endpoint.  Keep the fallback when no Factory or no paid
      // endpoint exists yet: those are the cases where a first Factory still
      // has to be allowed.
      if (
        type === UNIT.Factory &&
        safeScored.length > 0 &&
        this.onlyDuplicateFactoryTradeCandidates(safeScored)
      ) {
        return null;
      }
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        return this.probePriorityStructureCoverageSpawn(
          type,
          scored,
          safeScored,
          probe,
          emergency,
        );
      }
      return this.probeRankedStructureTiles(scored, type, probe, emergency);
    }

    rankStructureSpawnTiles(type, options, tiles, valueFunction, compactness) {
      const protectedSamTiles =
        type === UNIT.SAMLauncher && options.activeMissileDefense !== true
          ? this.samProtectableStructureTiles()
          : null;
      let safeScored = tiles
        .map((t) => ({
          t,
          v: valueFunction(t),
          compactness: compactness?.(t) ?? null,
        }))
        .filter(({ t }) => !this.isDangerousStructureTile(t, type));
      // A Factory only earns when it can send trains to a City or Port.  When
      // at least one safe candidate reaches a paid destination that every
      // existing Factory misses, suppress the candidates that merely duplicate
      // an already-served commercial pocket.  This keeps ordinary spacing as
      // the tie-breaker, but prevents a nearby duplicate Factory from beating
      // an expansion that actually opens a new route.
      if (type === UNIT.Factory && safeScored.length > 1) {
        const novel = this.novelFactoryTradeCandidates(safeScored);
        if (novel.length > 0) safeScored = novel;
      }
      let scored = safeScored.filter(
        ({ t }) =>
          protectedSamTiles === null ||
          this.samPlacementProtectsStructure(t, protectedSamTiles),
      );
      // A live hostile impact can leave every tile that still covers the
      // current economic core unsafe. Do not place the SAM in that blast, but
      // also do not let a doomed core suppress every safe defensive foothold:
      // the launcher is needed to protect the reconstruction immediately
      // after impact. Outside this explicit emergency we retain the strict
      // central-cluster requirement.
      if (this.shouldUseSafeSamReconstructionFallback(type, options, scored)) {
        scored = safeScored;
      }
      scored.sort((a, b) => this.compareStructurePlacementScores(a, b));
      return { scored, safeScored };
    }

    async probePriorityStructureCoverageSpawn(
      type,
      scored,
      safeScored,
      probe,
      emergency,
    ) {
      const localResult = await this.probeCoveragePrioritySamTiles(
        scored,
        type,
        probe.probeTimeoutMs,
        emergency,
      );
      if (localResult.handled) return localResult.buildable;
      const remaining = this.unattemptedPriorityStructureTiles(scored, localResult);
      const strictBuildable = await this.probeRankedStructureTiles(
        remaining,
        type,
        probe,
        emergency,
      );
      if (strictBuildable !== null) return strictBuildable;
      // Prefer the expensive core, but never turn a verified failure of every
      // core-covering site into permanent missile helplessness. This only
      // applies while replacing a missing first SAM; normal SAM placement
      // remains strictly centred on protectable structures.
      if (!this.shouldRetryFirstSamWithSafeCandidates(type, emergency, scored, safeScored)) {
        return null;
      }
      return this.probeRankedStructureTiles(safeScored, type, probe, emergency);
    }

    unattemptedPriorityStructureTiles(scored, localResult) {
      const attemptedTiles = localResult.attemptedTiles;
      if (!(attemptedTiles instanceof Set) || attemptedTiles.size === 0) {
        return scored;
      }
      return scored.filter(({ t }) => !attemptedTiles.has(t));
    }

    shouldRetryFirstSamWithSafeCandidates(type, emergency, scored, safeScored) {
      return (
        type === UNIT.SAMLauncher &&
        emergency?.recoverySam === true &&
        safeScored.length > scored.length
      );
    }

    shouldUseSafeSamReconstructionFallback(type, options, scored) {
      return (
        type === UNIT.SAMLauncher &&
        options.prioritizeStructureCoverage === true &&
        scored.length === 0 &&
        this.activeHostileMissileImpactZones().length > 0
      );
    }

    samProtectableStructureTiles() {
      // Use the same player snapshot as samCriticalStructureEntries and the
      // placement probes.  `game.players()` can expose a different wrapper
      // generation from `this.player` during a client update; mixing them made
      // the coverage filter demand a stale clump that candidate anchoring could
      // not see, rejecting every otherwise-safe tile. Friendly SAMs still
      // influence economic placement elsewhere, but our launcher protects our
      // own expensive core.
      if (typeof this.player?.units !== "function") return null;
      return new Set(this.samPlayerProtectableStructureTiles(this.player));
    }

    samPlayerProtectableStructureTiles(owner) {
      const protectedTiles = [];
      for (const type of SAM_PROTECTABLE_STRUCTURE_TYPES) {
        for (const structure of owner.units(type) || []) {
          const tile = structure?.tile?.();
          if (tile !== null && tile !== undefined) protectedTiles.push(tile);
        }
      }
      return protectedTiles;
    }

    samPlacementProtectsStructure(tile, protectedTiles) {
      if (protectedTiles === null) return true;
      // A first SAM must still be placeable after an economy has been wiped
      // out.  There is no expensive clump to centre on in that state, but an
      // external Silo is still an immediate strategic threat; let the normal
      // ranked legal-tile probe establish the defensive foothold instead of
      // filtering every candidate out.
      if (protectedTiles.size === 0) return true;
      const config = this.game.config();
      const range = Math.max(
        0,
        Number(config.samRange?.(1) ?? config.defaultSamRange?.() ?? 0),
      );
      if (range <= 0) return false;
      const rangeSquared = range * range;
      for (const structureTile of protectedTiles) {
        if (this.game.euclideanDistSquared(tile, structureTile) <= rangeSquared) {
          return true;
        }
      }
      return false;
    }

    /**
     * A bounded random placement miss cannot authorize an economic upgrade.
     * Enumerate the complete map incrementally and inspect every owned tile
     * with the same local spacing primitives used by the authoritative
     * placement reconstruction. One planner decision performs at most the
     * upstream 25-candidate placement budget; later decisions resume the same
     * snapshot. Only zero geometrically legal sites across a completed,
     * unchanged scan proves that space is exhausted. Any missing API,
     * unsafe-only site, or failed authoritative probe remains indeterminate.
     */
    async findEconomicPlacementOrExhaustion(type, options = {}) {
      const scan = this.economicPlacementScanState(type, options);
      if (scan === null) return { status: "indeterminate" };
      const scanLimit = this.economicPlacementBudgetLimit(
        STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
      );
      if (scanLimit < 1) return { status: "indeterminate" };

      const scanResult =
        type === UNIT.Port
          ? this.scanAllEconomicPortSpace(type, scan, scanLimit)
          : this.scanAllLandEconomicSpace(type, scan, scanLimit);
      this.consumeEconomicPlacementBudget(scanResult.visited || 0);
      if (scanResult.status === "pending") return { status: "indeterminate" };
      if (scanResult.status !== "candidate") {
        this.clearEconomicPlacementScan(type);
        if (
          scanResult.status === "no-space" &&
          this.economicPlacementFingerprint(type) === scan.context.fingerprint
        ) {
          return scanResult;
        }
        return { status: "indeterminate" };
      }
      const buildable = await this.buildableFor(
        type,
        scanResult.tile,
        this.structureProbeOptions(options).probeTimeoutMs,
      );
      if (!this.isUsableStructureBuildable(buildable, scanResult.tile, type)) {
        return { status: "indeterminate" };
      }
      this.clearEconomicPlacementScan(type);
      return { status: "buildable", buildable };
    }

  scanAllLandEconomicSpace(
    type,
    scan,
    limit = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
  ) {
      const { context } = scan;
      let visited = 0;
      let bestTile = null;
      let bestValue = -Infinity;
      while (
        scan.y <= context.bounds.maxY &&
        visited < limit
      ) {
        const x = scan.x;
        const y = scan.y;
        this.advanceEconomicLandScan(scan);
        visited++;
        const candidate = this.economicLandTileCandidate(type, context, x, y);
        if (candidate === null) continue;
        scan.hasGeometricSpace = true;
        if (candidate.value <= bestValue) continue;
        bestValue = candidate.value;
        bestTile = candidate.tile;
      }

      if (bestTile !== null) return { status: "candidate", tile: bestTile, visited };
      if (scan.y <= context.bounds.maxY) return { status: "pending", visited };
      return scan.hasGeometricSpace
        ? { status: "indeterminate", visited }
        : { status: "no-space", visited };
    }

    advanceEconomicLandScan(scan) {
      scan.x++;
      if (scan.x <= scan.context.bounds.maxX) return;
      scan.x = scan.context.bounds.minX;
      scan.y++;
    }

    economicLandTileCandidate(type, context, x, y) {
      if (!context.game.isValidCoord(x, y)) return null;
      const tile = context.game.ref(x, y);
      if (context.game.ownerID(tile) !== context.mySid) return null;
      if (
        !this.isLocallyStructureSpaced(
          context.game,
          tile,
          context.structures,
          context.minDistSquared,
        )
      ) {
        return null;
      }
      if (this.isDangerousStructureTile(tile, type)) {
        return { tile, value: -Infinity };
      }
      const value = Number(context.valueFunction(tile));
      return { tile, value: Number.isFinite(value) ? value : -Infinity };
    }

  scanAllEconomicPortSpace(
    type,
    scan,
    limit = STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
  ) {
      const { context } = scan;
      let visited = 0;
      let bestAnchor = null;
      let bestValue = -Infinity;
      while (
        scan.index < context.borderTiles.length &&
        visited < limit
      ) {
        const anchor = context.borderTiles[scan.index++];
        visited++;
        const candidate = this.economicPortAnchorCandidate(
          type,
          context,
          anchor,
          scan.snappedSites,
        );
        if (candidate.status === "indeterminate") return { ...candidate, visited };
        if (candidate.status !== "candidate") continue;
        scan.hasGeometricSpace = true;
        if (candidate.value <= bestValue) continue;
        bestValue = candidate.value;
        bestAnchor = anchor;
      }
      if (bestAnchor !== null) return { status: "candidate", tile: bestAnchor, visited };
      if (scan.index < context.borderTiles.length) return { status: "pending", visited };
      return scan.hasGeometricSpace
        ? { status: "indeterminate", visited }
        : { status: "no-space", visited };
    }

    economicPortAnchorCandidate(type, context, anchor, snappedSites) {
      if (!this.isOceanPortTile(anchor)) return { status: "skip" };
      const snapped = this.localLandStructureSpawnTile(anchor);
      if (snapped === null) return { status: "indeterminate" };
      if (snapped === false || snappedSites.has(snapped)) {
        return { status: "skip" };
      }
      snappedSites.add(snapped);
      if (this.isDangerousStructureTile(snapped, type)) {
        return { status: "candidate", value: -Infinity };
      }
      const value = Number(context.valueFunction(anchor));
      return {
        status: "candidate",
        value: Number.isFinite(value) ? value : -Infinity,
      };
    }

    economicPlacementScanContext(type, options) {
      const game = this.game;
      if (!this.hasEconomicPlacementScanApi(type, game)) return null;
      const width = Number(game.width());
      const height = Number(game.height());
      const mySid = this.player?.smallID?.();
      const valueFunction = this.structureTileValueFunction(type, options);
      const config = game.config?.();
      const structureMinDist = Number(config?.structureMinDist?.());
      const borderTiles = Array.from(this.player.borderTiles());
      const structures = game.units(...STRUCTURES_TYPES);
      const bounds = this.economicPlacementBounds(game, borderTiles, width, height);
      const fingerprint = this.economicPlacementFingerprint(type);
      if (!this.economicPlacementContextIsValid({
        width, height, mySid, valueFunction, structureMinDist,
        structures, bounds, fingerprint,
      })) return null;
      return {
        game,
        width,
        height,
        mySid,
        valueFunction,
        borderTiles,
        structures,
        bounds,
        fingerprint,
        minDistSquared: structureMinDist * structureMinDist,
      };
    }

    economicPlacementScanState(type, options) {
      if (!(this._economicPlacementScans instanceof Map)) {
        this._economicPlacementScans = new Map();
      }
      const key = String(type);
      const existing = this._economicPlacementScans.get(key);
      if (existing) return existing;
      const context = this.economicPlacementScanContext(type, options);
      if (context === null) return null;
      const scan = {
        context,
        x: context.bounds.minX,
        y: context.bounds.minY,
        index: 0,
        hasGeometricSpace: false,
        snappedSites: new Set(),
      };
      this._economicPlacementScans.set(key, scan);
      return scan;
    }

    hasPendingEconomicPlacementScan(type) {
      const scan = this._economicPlacementScans?.get(String(type));
      if (scan === undefined) return false;
      if (this.economicPlacementFingerprint(type) === scan.context.fingerprint) {
        return true;
      }
      this.clearEconomicPlacementScan(type);
      return false;
    }

    clearEconomicPlacementScan(type) {
      this._economicPlacementScans?.delete(String(type));
    }

    hasEconomicPlacementScanApi(type, game) {
      if (!ECONOMIC_STRUCTURE_TYPES.includes(type) || !game) return false;
      const methods = [
        "width", "height", "ref", "ownerID", "isValidCoord",
        "x", "y", "units", "euclideanDistSquared",
      ];
      return (
        methods.every((method) => typeof game[method] === "function") &&
        typeof this.player?.borderTiles === "function"
      );
    }

    economicPlacementContextIsValid(values) {
      return Boolean(
        Number.isInteger(values.width) &&
          values.width > 0 &&
          Number.isInteger(values.height) &&
          values.height > 0 &&
          values.mySid !== null &&
          values.mySid !== undefined &&
          typeof values.valueFunction === "function" &&
          Number.isFinite(values.structureMinDist) &&
          values.structureMinDist >= 0 &&
          Array.isArray(values.structures) &&
          values.bounds !== null &&
          values.fingerprint !== null,
      );
    }

    economicPlacementBounds(game, borderTiles, width, height) {
      if (!Array.isArray(borderTiles) || borderTiles.length === 0) return null;
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      for (const tile of borderTiles) {
        const x = Number(game.x(tile));
        const y = Number(game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      return {
        minX: Math.max(0, Math.floor(minX)),
        maxX: Math.min(width - 1, Math.ceil(maxX)),
        minY: Math.max(0, Math.floor(minY)),
        maxY: Math.min(height - 1, Math.ceil(maxY)),
      };
    }

    economicPlacementFingerprint(type) {
      const game = this.game;
      if (
        !game ||
        typeof game.units !== "function" ||
        typeof game.config !== "function" ||
        typeof this.player?.borderTiles !== "function"
      ) {
        return null;
      }
      const borderTiles = Array.from(this.player.borderTiles(), String).sort();
      const structures = game.units(...STRUCTURES_TYPES);
      if (!Array.isArray(structures)) return null;
      const structureRecords = structures
        .map((structure) => this.economicStructureFingerprintRecord(structure))
        .sort();
      return JSON.stringify({
        type,
        sid: this.player?.smallID?.(),
        tiles: Number(this.player?.numTilesOwned?.()),
        minDist: Number(game.config()?.structureMinDist?.()),
        borderTiles,
        structureRecords,
      });
    }

    economicStructureFingerprintRecord(structure) {
      const read = (key, fallback) => {
        const value = structure?.[key];
        return typeof value === "function" ? value.call(structure) : value ?? fallback;
      };
      return JSON.stringify([
        String(read("type", "")),
        String(read("id", "")),
        String(read("tile", "")),
        Number(read("level", 1)),
        Boolean(read("isUnderConstruction", false)),
      ]);
    }

    compareStructurePlacementScores(left, right) {
      if (left.compactness !== null && right.compactness !== null) {
        const samProtectionDifference = this.compareSamProtectionScores(
          left.compactness,
          right.compactness,
        );
        if (samProtectionDifference !== 0) return samProtectionDifference;
        const sharedCoverageDifference =
          right.compactness.sharedSamCoverage -
          left.compactness.sharedSamCoverage;
        if (sharedCoverageDifference !== 0) return sharedCoverageDifference;
      }
      return right.v - left.v;
    }

    compareSamProtectionScores(left, right) {
      const coverageDifference =
        right.existingSamCoverage - left.existingSamCoverage;
      if (coverageDifference !== 0) return coverageDifference;
      if (left.existingSamCoverage > 0 && right.existingSamCoverage > 0) {
        const currentDistanceDifference =
          left.currentSamDistanceSquared - right.currentSamDistanceSquared;
        if (currentDistanceDifference !== 0) return currentDistanceDifference;
      }
      const upgradeCoverageDifference =
        right.upgradeSamCoverage - left.upgradeSamCoverage;
      if (upgradeCoverageDifference !== 0) return upgradeCoverageDifference;
      if (left.upgradeSamCoverage <= 0 || right.upgradeSamCoverage <= 0) return 0;
      return left.samDistanceSquared - right.samDistanceSquared;
    }

    rankStructureTilesBySamProtection(tiles, type) {
      const compactness = this.structurePlacementCompactnessRanker(type);
      if (compactness === null) return tiles;
      return tiles
        .map((tile) => ({ tile, compactness: compactness(tile) }))
        .sort((left, right) =>
          this.compareStructurePlacementScores(
            { v: 0, compactness: left.compactness },
            { v: 0, compactness: right.compactness },
          ),
        )
        .map((entry) => entry.tile);
    }

    nearestTileDistanceScorer(refs, excludeCandidate = false) {
      const coordinates = [];
      for (const ref of refs) {
        const x = Number(this.game.x(ref));
        const y = Number(this.game.y(ref));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        coordinates.push({ ref, x, y });
      }
      return (tile) => {
        const x = Number(this.game.x(tile));
        const y = Number(this.game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
        let nearest = Infinity;
        for (const coordinate of coordinates) {
          if (excludeCandidate && coordinate.ref === tile) continue;
          const distance = Math.abs(coordinate.x - x) + Math.abs(coordinate.y - y);
          if (distance < nearest) nearest = distance;
        }
        return nearest;
      };
    }

    structurePlacementCompactnessRanker(type) {
      if (!state.settings.winFixes || type === UNIT.SAMLauncher) return null;
      let range;
      {
        range = Number(this.game.config().defaultSamRange());
      }
      if (!Number.isFinite(range) || range <= 0) return null;
      const rangeSquared = range * range;
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      // Placement ranks up to 25 candidates.  Snapshot the immutable geometry
      // once, rather than repeatedly crossing the GameView wrapper for every
      // candidate × SAM/structure pair.  A structure decision is synchronous,
      // so this is the same snapshot the old per-candidate reads observed.
      const structureTiles = structures.map((structure) => structure.tile());
      const config = this.game.config();
      const sams = this.legendaryFriendlySamUnits().map((sam) => ({
        tile: sam.tile(),
        range: Number(config.samRange(sam.level())),
      }));
      const maxRange = Number(this.game.config().maxSamRange?.());
      return (tile) => {
        let existingSamCoverage = 0;
        let upgradeSamCoverage = 0;
        let currentSamDistanceSquared = Number.POSITIVE_INFINITY;
        let samDistanceSquared = Number.POSITIVE_INFINITY;
        for (const sam of sams) {
          const distanceSquared = this.game.euclideanDistSquared(tile, sam.tile);
          const samRange = sam.range;
          if (
            Number.isFinite(samRange) &&
            distanceSquared <= samRange * samRange
          ) {
            existingSamCoverage = 1;
            currentSamDistanceSquared = Math.min(
              currentSamDistanceSquared,
              distanceSquared,
            );
          }
          const eventualRange = Number.isFinite(maxRange) && maxRange > 0
            ? maxRange
            : samRange;
          if (
            Number.isFinite(eventualRange) &&
            distanceSquared <= eventualRange * eventualRange
          ) {
            upgradeSamCoverage = 1;
            samDistanceSquared = Math.min(samDistanceSquared, distanceSquared);
          }
        }
        return {
          existingSamCoverage,
          upgradeSamCoverage,
          currentSamDistanceSquared,
          samDistanceSquared,
          sharedSamCoverage: structureTiles.reduce(
            (count, structureTile) =>
              count +
              (this.game.euclideanDistSquared(tile, structureTile) <= rangeSquared
                ? 1
                : 0),
            0,
          ),
        };
      };
    }

    economicPlacementBudgetLimit(requested) {
      const remaining = Number(this._economicPlacementDecisionBudget);
      if (!Number.isFinite(remaining)) return requested;
      return Math.max(0, Math.min(requested, remaining));
    }

    consumeEconomicPlacementBudget(count) {
      if (!Number.isFinite(Number(this._economicPlacementDecisionBudget))) return;
      this._economicPlacementDecisionBudget = Math.max(
        0,
        this._economicPlacementDecisionBudget - Math.max(0, Number(count) || 0),
      );
    }

    structureProbeOptions(options) {
      const requestedCandidateLimit = Number(options.candidateLimit);
      const candidateLimit = Number.isInteger(requestedCandidateLimit)
        ? Math.max(
            1,
            Math.min(STRUCTURE_PLACEMENT_CANDIDATE_LIMIT, requestedCandidateLimit),
          )
        : STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const requestedProbeLimit = Number(options.probeLimit);
      const probeLimit = Number.isInteger(requestedProbeLimit)
        ? Math.max(1, Math.min(candidateLimit, requestedProbeLimit))
        : candidateLimit;
      const requestedProbeTimeout = Number(options.probeTimeoutMs);
      const probeTimeoutMs = Number.isFinite(requestedProbeTimeout)
        ? Math.max(1, requestedProbeTimeout)
        : STRUCTURE_PROBE_TIMEOUT_MS;
      const requestedParallel = Number(options.parallelProbeCount);
      const parallelProbeCount = Number.isInteger(requestedParallel)
        ? Math.max(1, Math.min(probeLimit, requestedParallel))
        : STRUCTURE_PROBE_CONCURRENCY;
      return { candidateLimit, probeLimit, probeTimeoutMs, parallelProbeCount };
    }

    structureCandidateTiles(type, options, candidateLimit) {
      let tiles =
        type === UNIT.Port
          ? this.randCoastalTileArray(candidateLimit)
          : randTerritoryTileArray(
              this.random,
              this.game,
              this.player,
              candidateLimit,
            );
      if (type === UNIT.City) {
        tiles = this.prependCommercialRailCityTiles(tiles, candidateLimit);
      }
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        if (options.activeMissileDefense === true) {
          tiles = this.prependActiveMissileRouteTiles(
            tiles,
            candidateLimit,
            options.missileDefenseContext,
          );
        }
        // The ordinary sampler is intentionally random for varied economy
        // placement, but a first anti-missile site has one clear strategic
        // purpose: sit in the heart of the most valuable compact group. Seed
        // the actual structure-centre anchors before the random fallback: a
        // random 25-tile sample can otherwise entirely miss that compact core.
        tiles = this.prependCriticalSamClusterAnchors(tiles, candidateLimit);
        tiles = this.prependCriticalSamClusterTiles(tiles, candidateLimit);
        tiles = this.uniqueOwnedStructureTiles(tiles);
      }
      if (
        state.settings.winFixes &&
        type !== UNIT.SAMLauncher &&
        type !== UNIT.Port
      ) {
        tiles = this.prependSamCoveredTiles(tiles, candidateLimit);
      }
      return tiles;
    }

    // A City placed within three tiles of a live railway becomes a station and
    // splits that route. Random territory samples can miss every such site on
    // a large nation, even when the map visibly contains several rail hubs.
    // Visit junctions first, then endpoints, direct routes, and turns. This
    // gives the strongest commercial links first while still rotating through
    // every owned rail tile so long direct routes receive stations too.
    // Buildability remains the final authority over the exact tile. Keep the
    // original random draw before this enrichment so its deterministic stream
    // is unchanged.
    prependCommercialRailCityTiles(tiles, candidateLimit) {
      const railState = this.readRailroadState(this.game);
      const mySid = this.player?.smallID?.();
      if (
        !railState ||
        railState.length === 0 ||
        !Number.isFinite(Number(mySid)) ||
        typeof this.game?.ownerID !== "function"
      ) {
        return tiles;
      }
      const railTiles = [];
      for (let tile = 0; tile < railState.length; tile++) {
        if (railState[tile] === 0 || this.game.ownerID(tile) !== mySid) continue;
        railTiles.push(tile);
      }
      if (railTiles.length === 0) return tiles;

      const prioritizedRailTiles = this.commercialRailCityAnchorTiles(railTiles, railState);

      // Do not let a generic territory sample compete with a known railway
      // anchor. The City scorer may legitimately choose between *rail* sites,
      // but when enough anchors exist every evaluated candidate must be one.
      const seedCount = Math.min(candidateLimit, prioritizedRailTiles.length);
      const offset =
        Number(this._commercialRailCityAnchorOffset ?? 0) % prioritizedRailTiles.length;
      const stride = Math.max(1, Math.floor(prioritizedRailTiles.length / seedCount));
      const railAnchors = [];
      for (let index = 0; index < seedCount; index++) {
        railAnchors.push(
          prioritizedRailTiles[(offset + index * stride) % prioritizedRailTiles.length],
        );
      }
      this._commercialRailCityAnchorOffset = (offset + 1) % prioritizedRailTiles.length;
      return Array.from(new Set(railAnchors.concat(tiles))).slice(0, candidateLimit);
    }

    commercialRailCityAnchorTiles(railTiles, railState) {
      const game = this.game;
      if (
        typeof game?.width !== "function" ||
        typeof game?.height !== "function" ||
        typeof game?.x !== "function" ||
        typeof game?.y !== "function" ||
        typeof game?.ref !== "function" ||
        typeof game?.isValidCoord !== "function"
      ) {
        return railTiles;
      }
      const prioritizedRailTiles = [];
      for (const tile of railTiles) {
        const shape = this.commercialRailTileConnectionShape(tile, railState);
        prioritizedRailTiles.push({
          tile,
          priority: this.commercialRailCityAnchorPriority(shape),
        });
      }
      prioritizedRailTiles.sort(
        (left, right) => left.priority - right.priority || left.tile - right.tile,
      );
      return prioritizedRailTiles.map(({ tile }) => tile);
    }

    commercialRailTileConnectionShape(tile, railState) {
      const game = this.game;
      const x = game.x(tile);
      const y = game.y(tile);
      const shape = { degree: 0, horizontal: 0, vertical: 0 };
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const neighborX = x + dx;
        const neighborY = y + dy;
        if (!game.isValidCoord(neighborX, neighborY)) continue;
        const neighbor = game.ref(neighborX, neighborY);
        if (railState[neighbor] === 0) continue;
        shape.degree += 1;
        if (dx !== 0) shape.horizontal += 1;
        else shape.vertical += 1;
      }
      return shape;
    }

    commercialRailCityAnchorPriority({ degree, horizontal, vertical }) {
      if (degree >= 3) return 0;
      if (degree === 1) return 1;
      if (degree === 2 && (horizontal === 2 || vertical === 2)) return 2;
      if (degree === 2 && horizontal === 1 && vertical === 1) return 3;
      return 4;
    }

    prependCriticalSamClusterTiles(tiles, candidateLimit) {
      const config = this.game?.config?.();
      const range = Number(config?.defaultSamRange?.());
      if (!Number.isFinite(range) || range <= 0) return tiles;
      const entries = this.samCriticalStructureEntries();
      if (entries.length === 0) return tiles;
      const rangeSquared = range * range;
      // Building tiles are useful geometric anchors but are normally occupied,
      // so they cannot themselves be a SAM site. Rank the legal placement
      // candidates by the same weighted core score instead. This puts the
      // first actual build probe in the centre of the costly clump rather than
      // repeatedly probing an occupied City/Factory and falling back to a
      // random peripheral tile.
      return tiles
        .map((tile, index) => ({
          tile,
          index,
          score: this.samCriticalCoverageScoreForEntries(
            tile,
            rangeSquared,
            entries,
          ),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, candidateLimit)
        .map((entry) => entry.tile);
    }

    prependCriticalSamClusterAnchors(tiles, candidateLimit) {
      const config = this.game?.config?.();
      const range = Number(config?.defaultSamRange?.());
      if (!Number.isFinite(range) || range <= 0) return tiles;
      const entries = this.samCriticalStructureEntries();
      if (entries.length === 0) return tiles;
      const rangeSquared = range * range;
      const anchorLimit = Math.min(3, candidateLimit);
      const anchors = entries
        .map((entry, index) => ({
          tile: entry.tile,
          index,
          score: this.samCriticalCoverageScoreForEntries(
            entry.tile,
            rangeSquared,
            entries,
          ),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, anchorLimit)
        .map((entry) => entry.tile);
      const seen = new Set();
      return anchors.concat(tiles).filter((tile) => {
        if (seen.has(tile)) return false;
        seen.add(tile);
        return true;
      }).slice(0, candidateLimit);
    }

    prependActiveMissileRouteTiles(tiles, candidateLimit, context) {
      const routeLimit = Math.max(1, Math.floor(candidateLimit / 2));
      const routeTiles = this.activeMirvCandidateTiles(context).slice(
        0,
        routeLimit,
      );
      const seen = new Set();
      for (const tile of routeTiles) seen.add(tile);
      for (const path of this.activeMissileRoutePaths(context)) {
        this.appendActiveMissilePathTiles(
          routeTiles,
          seen,
          path,
          routeLimit,
        );
        if (routeTiles.length >= routeLimit) break;
      }
      return routeTiles.concat(tiles).slice(0, candidateLimit);
    }

    activeMirvCandidateTiles(context) {
      if (
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function" ||
        typeof this.game.ref !== "function" ||
        typeof this.game.isValidCoord !== "function"
      ) return [];
      const candidates = [];
      const offsets = [
        [40, 0],
        [-40, 0],
        [0, 40],
        [0, -40],
        [28, 20],
        [-28, 20],
        [28, -20],
        [-28, -20],
      ];
      for (const demand of this.uncoveredActiveMirvDemands(context)) {
        const x = this.game.x(demand.targetTile);
        const y = this.game.y(demand.targetTile);
        for (const [dx, dy] of offsets) {
          if (!this.game.isValidCoord(x + dx, y + dy)) continue;
          const tile = this.game.ref(x + dx, y + dy);
          if (this.activeMissileRouteTileUsable(tile)) candidates.push(tile);
        }
      }
      return candidates;
    }

    activeMissileRoutePaths(context) {
      return (context?.threats || [])
        .filter((threat) => threat?.inFlight === true)
        .flatMap((threat) => threat.salvoPlan?.routes || [])
        .map((route) => route?.path)
        .filter(Array.isArray);
    }

    appendActiveMissilePathTiles(routeTiles, seen, path, candidateLimit) {
      for (let index = path.length - 1; index >= 0; index--) {
        const tile = path[index];
        if (tile === null || tile === undefined || seen.has(tile)) continue;
        if (!this.activeMissileRouteTileUsable(tile)) continue;
        seen.add(tile);
        routeTiles.push(tile);
        if (routeTiles.length >= candidateLimit) return;
      }
    }

    activeMissileRouteTileUsable(tile) {
      const mySid = this.readPlayerSmallId(this.player);
      if (
        mySid !== null &&
        typeof this.game.ownerID === "function" &&
        this.game.ownerID(tile) !== mySid
      ) {
        return false;
      }
      return !this.isDangerousStructureTile(tile, UNIT.SAMLauncher);
    }

    uniqueOwnedStructureTiles(tiles) {
      const mySid = this.readPlayerSmallId(this.player);
      const seen = new Set();
      return tiles.filter((tile) => {
        if (tile === null || tile === undefined || seen.has(tile)) return false;
        if (mySid !== null && typeof this.game.ownerID === "function") {
          {
            if (this.game.ownerID(tile) !== mySid) return false;
          }
        }
        seen.add(tile);
        return true;
      });
    }

    prependSamCoveredTiles(tiles, candidateLimit) {
      {
        const samTiles = this.tilesNearFriendlySams(candidateLimit);
        if (samTiles.length === 0) return tiles;
        const merged = [];
        const seen = new Set();
        for (const tile of samTiles.concat(tiles)) {
          if (merged.length >= candidateLimit) break;
          if (seen.has(tile)) continue;
          seen.add(tile);
          merged.push(tile);
        }
        return merged;
      }
    }

    structureTileValueFunction(type, options) {
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        return this.threatSamLauncherValue();
      }
      return isLegendaryDifficulty()
        ? this.legendaryStructureSpawnTileValue(type)
        : this.structureSpawnTileValue(type);
    }

    structureMissileEmergency(type, options = {}) {
      if (!this.shouldInspectStructureMissileEmergency(options)) {
        return { active: false };
      }
      const tick = Number(this.game.ticks?.());
      const { context, evaluation, active } = this.structureMissileEmergencyState(options);
      return {
        active,
        samDefense: type === UNIT.SAMLauncher && active,
        // A missing baseline SAM is still valuable after the current salvo is
        // already impossible to stop.  Keep its construction safe from the
        // actual blast, but do not require one level-one launcher to fully
        // defend every in-flight missile before allowing reconstruction.
        recoverySam:
          type === UNIT.SAMLauncher &&
          options.allowPreemptiveSam === true &&
          this.ownSamCapacity() <= 0,
        incrementalSamDefense:
          type === UNIT.SAMLauncher && options.activeMissileDefense === true,
        tick,
        context,
        evaluation,
        stateKey: active ? this.missileDefenseStateFingerprint() : null,
      };
    }

    shouldInspectStructureMissileEmergency(options) {
      return (
        isLegendaryDifficulty() ||
        options.activeMissileDefense === true ||
        this.missileDefenseSignalSnapshot()?.hasActiveHostileMissile === true
      );
    }

    structureMissileEmergencyState(options) {
      const context = options.missileDefenseContext || this.getMissileDefenseContext();
      const evaluation = options.missileDefenseContext
        ? this.legendaryDefenseEvaluation(context)
        : this.getMissileDefenseEvaluation(context);
      const active =
        (evaluation.hasThreats && !evaluation.fullyDefended) ||
        this.uncoveredActiveMirvDemands(context).length > 0;
      return { context, evaluation, active };
    }

    async probeCoveragePrioritySamTiles(scored, type, timeoutMs, emergency) {
      const snappedTiles = new Set();
      const attemptedTiles = new Set();
      let attempts = 0;
      for (const { t } of scored) {
        const snappedTile = this.localLandStructureSpawnTile(t);
        if (snappedTile === null) return { handled: false, buildable: null };
        if (snappedTile === false || snappedTiles.has(snappedTile)) continue;
        snappedTiles.add(snappedTile);
        if (!this.structureEmergencyTileAllowed(snappedTile, type, emergency)) {
          continue;
        }
        attempts++;
        attemptedTiles.add(t);
        const bu = await this.buildableFor(type, t, timeoutMs);
        if (this.isUsableStructureBuildable(bu, t, type)) {
          return { handled: true, buildable: bu };
        }
        if (attempts >= HOSTILE_SILO_SAM_AUTHORITATIVE_FALLBACK_LIMIT) break;
      }
      // The local reconstruction is only an optimisation for the expensive
      // cluster anchors.  It is not authoritative: an incomplete public
      // snapshot, an occupied anchor, or three unlucky probes must not turn a
      // mandatory first SAM into a permanent no-op.  Fall through to the
      // normal bounded worker probes, which decide actual buildability.
      return { handled: false, buildable: null, attemptedTiles };
    }

    async probeRankedStructureTiles(scored, type, probe, emergency) {
      const ranked = scored.slice(0, probe.probeLimit);
      for (
        let offset = 0;
        offset < ranked.length;
        offset += probe.parallelProbeCount
      ) {
        if (!this.structureEmergencySnapshotCurrent(emergency)) return null;
        const tiles = ranked
          .slice(offset, offset + probe.parallelProbeCount)
          .map(({ t }) => t)
          .filter((tile) => this.structureEmergencyTileAllowed(tile, type, emergency));
        if (tiles.length === 0) continue;
        const buildables = await Promise.all(
          tiles.map((tile) => this.buildableFor(type, tile, probe.probeTimeoutMs)),
        );
        if (!this.structureEmergencySnapshotCurrent(emergency)) return null;
        for (let index = 0; index < buildables.length; index++) {
          if (this.isUsableStructureBuildable(buildables[index], tiles[index], type)) {
            return buildables[index];
          }
        }
      }
      return null;
    }

    structureEmergencySnapshotCurrent(emergency) {
      // Missile objects legitimately advance while worker probes are in
      // flight. A replacement first SAM is checked against the current blast
      // at every candidate/final-build boundary, so it must not be discarded
      // merely because an unrelated salvo changed the global fingerprint.
      if (emergency.recoverySam === true) return true;
      return (
        !emergency.active ||
        this.missileDefenseSnapshotIsCurrent(emergency.tick, emergency.stateKey)
      );
    }

    structureEmergencyTileAllowed(tile, type, emergency) {
      if (
        emergency.samDefense &&
        !this.structureEmergencySamTileAllowed(tile, emergency)
      ) return false;
      return !(
        emergency.active &&
        type !== UNIT.SAMLauncher &&
        this.legendaryTileInsideUninterceptedBlast(
          tile,
          emergency.context,
          emergency.evaluation,
        )
      );
    }

    structureEmergencySamTileAllowed(tile, emergency) {
      if (emergency.recoverySam === true) {
        return !this.tileInsideActiveHostileMissileImpact(tile);
      }
      if (emergency.incrementalSamDefense !== true) {
        return this.legendarySamConstructionSafeForTile(tile, emergency.context);
      }
      // Candidate scoring and coverage probing may revisit the same snapped
      // tile during one immutable missile-defense snapshot. A full trajectory
      // evaluation is expensive, so memoize only within that snapshot; a new
      // tick/fingerprint gets a fresh emergency object and recalculates it.
      const cache =
        emergency.activeSamTileAllowedCache ||
        (emergency.activeSamTileAllowedCache = new Map());
      if (cache.has(tile)) return cache.get(tile);
      const allowed = this.activeMissileSamConstructionImproves(
        tile,
        emergency.context,
        emergency.evaluation,
      );
      cache.set(tile, allowed);
      return allowed;
    }

    isUsableStructureBuildable(buildable, tile, type) {
      return Boolean(
        buildable !== null &&
          buildable !== undefined &&
          buildable.canBuild !== false &&
          buildable.canBuild !== null &&
          buildable.canBuild !== undefined &&
          // The client BuildMenu sends an upgrade before it considers canBuild.
          // A fresh construction must therefore reject a hybrid descriptor even
          // if the worker also found a snapped construction tile nearby.
          buildable.canUpgrade === false &&
          this.isSafeBuildablePlacement(buildable, tile, type),
      );
    }

    /**
     * Keep ordinary structures off an active hostile frontier. Defense posts
     * are deliberately exempt: their purpose is to fortify that exact front.
     * Unknown ownership data fails open so older clients retain their existing
     * placement behavior instead of disabling construction entirely.
     */
    isDangerousStructureTile(tile, type) {
      if (tile === null || tile === undefined) return false;
      // Never spend on a structure that an already in-flight hostile missile
      // will destroy. This applies to every difficulty and to Defense Posts;
      // their frontier exemption is unrelated to blast safety.
      if (this.tileInsideActiveHostileMissileImpact(tile)) return true;
      if (type === UNIT.DefensePost) return false;
      const game = this.game;
      if (
        !game ||
        typeof game.neighbors !== "function" ||
        typeof game.ownerID !== "function" ||
        typeof game.playerBySmallID !== "function"
      ) {
        return false;
      }
      const mySid = this.player.smallID();
      {
        for (const neighbor of game.neighbors(tile) || []) {
          if (this.isHostileStructureNeighbor(neighbor, mySid)) return true;
        }
      }
      return false;
    }

    isHostileStructureNeighbor(tile, mySid) {
      const ownerSid = this.game.ownerID(tile);
      if (ownerSid === mySid || ownerSid === null || ownerSid === undefined) {
        return false;
      }
      const owner = this.game.playerBySmallID(ownerSid);
      if (!owner || owner.isPlayer?.() === false) return false;
      return !(
        this.player.isFriendly?.(owner) === true ||
        this.player.isOnSameTeam?.(owner) === true
      );
    }

    isSafeBuildablePlacement(buildable, requestedTile, type) {
      const resolvedTile =
        buildable &&
        buildable.canBuild !== true &&
        buildable.canBuild !== false &&
        buildable.canBuild !== null &&
        buildable.canBuild !== undefined
          ? buildable.canBuild
          : requestedTile;
      return !this.isDangerousStructureTile(resolvedTile, type);
    }

    /**
     * Client-side reconstruction of PlayerImpl.validStructureSpawnTiles().
     * Returns the nearest legal snapped tile, false when none exists, and null
     * only when the public snapshot lacks a primitive needed for exact parity.
     */
    localLandStructureSpawnTile(tile) {
      const game = this.game;
      if (!this.hasLocalStructurePlacementApi(game, tile)) return null;

      const setup = this.localStructurePlacementSetup(game, tile);
      if (setup === null || setup === false) return setup;

      const nearbyUnits = this.localNearbyStructures(game, tile);
      if (!Array.isArray(nearbyUnits)) return null;

      const ownedNearbyTiles = this.localOwnedStructureTiles(
        game,
        tile,
        setup.mySid,
      );
      if (ownedNearbyTiles === null) return null;

      const validTiles = ownedNearbyTiles.filter((candidate) =>
        this.isLocallyStructureSpaced(
          game,
          candidate,
          nearbyUnits,
          setup.structureMinDist ** 2,
        ),
      );
      validTiles.sort(
        (left, right) =>
          game.euclideanDistSquared(left, tile) -
          game.euclideanDistSquared(right, tile),
      );
      return validTiles[0] ?? false;
    }

    hasLocalStructurePlacementApi(game, tile) {
      return (
        tile !== null &&
        tile !== undefined &&
        game &&
        typeof game.ownerID === "function" &&
        typeof game.neighbors === "function" &&
        typeof game.euclideanDistSquared === "function" &&
        typeof game.nearbyUnits === "function" &&
        typeof game.config === "function"
      );
    }

    localStructurePlacementSetup(game, tile) {
      {
        const mySid = this.player.smallID();
        const config = game.config();
        if (typeof config?.structureMinDist !== "function") return null;
        const structureMinDist = Number(config.structureMinDist());
        if (!Number.isFinite(structureMinDist) || structureMinDist < 0) return null;
        if (game.ownerID(tile) !== mySid) return false;
        return { mySid, structureMinDist };
      }
    }

    localNearbyStructures(game, tile) {
      {
        return game.nearbyUnits(
          tile,
          LOCAL_STRUCTURE_SEARCH_RADIUS * 2,
          STRUCTURES_TYPES,
          undefined,
          true,
        );
      }
    }

    localOwnedStructureTiles(game, tile, mySid) {
      const radiusSquared = LOCAL_STRUCTURE_SEARCH_RADIUS ** 2;
      const queue = [tile];
      const seen = new Set([tile]);
      const ownedNearbyTiles = [];
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        let insideRadius;
        {
          insideRadius =
            game.euclideanDistSquared(tile, current) < radiusSquared &&
            game.ownerID(current) === mySid;
        }
        if (!insideRadius) continue;
        ownedNearbyTiles.push(current);
        let neighbors;
        {
          neighbors = game.neighbors(current) || [];
        }
        for (const neighbor of neighbors) {
          if (seen.has(neighbor)) continue;
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
      return ownedNearbyTiles;
    }

    isLocallyStructureSpaced(game, candidate, nearbyUnits, minDistSquared) {
      for (const entry of nearbyUnits) {
        const unitTile = (entry?.unit ?? entry)?.tile?.();
        if (unitTile === null || unitTile === undefined) continue;
        {
          if (game.euclideanDistSquared(unitTile, candidate) < minDistSquared) {
            return false;
          }
        }
      }
      return true;
    }

    // Probe a stable unit list with bounded concurrency. Defensive upgrade
    // paths can have many SAMs once hostile silos appear; awaiting every worker
    // request serially turns a slow buildables worker into a visible game hang.
    // Results retain the input order so the caller's selection/ranking logic is
    // unchanged.
    async buildableForUnits(units, type, options = {}) {
      const rawCandidates = Array.isArray(units) ? units : [];
      const requestedMaxProbes = Number(options.maxProbes);
      const maxProbes = Number.isInteger(requestedMaxProbes)
        ? Math.max(
            1,
            Math.min(STRUCTURE_PLACEMENT_CANDIDATE_LIMIT, requestedMaxProbes),
          )
        : STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const candidates = rawCandidates.slice(0, maxProbes);
      if (candidates.length === 0) return [];
      const requestedConcurrency = Number(options.concurrency);
      const concurrency = Number.isInteger(requestedConcurrency)
        ? Math.max(1, Math.min(candidates.length, requestedConcurrency))
        : 1;
      const results = new Array(candidates.length).fill(null);
      let nextIndex = 0;
      const probe = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= candidates.length) return;
          const unit = candidates[index];
          {
            const tile = unit?.tile?.();
            if (tile === null || tile === undefined) continue;
            if (this.tileInsideActiveHostileMissileImpact(tile)) continue;
            results[index] = await this.buildableFor(
              type,
              tile,
              options.timeoutMs,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: concurrency }, () => probe()),
      );
      return results;
    }

    // buildableFor — probe a single tile for one unit type. Returns the matching
    // BuildableUnit ({type, canBuild, canUpgrade, cost}) or null. Worker call is
    // wrapped in withTimeout. (Shared by build + upgrade + defense-post probes.)
    async buildableFor(type, tile, timeoutMs = null) {
      let buildables;
      const defaultWorkerTimeoutMs = STRUCTURE_PROBE_TIMEOUT_MS;
      const timeout = Number.isFinite(Number(timeoutMs))
        ? Math.max(1, Number(timeoutMs))
        : defaultWorkerTimeoutMs;
      {
        buildables = await withTimeout(
          this.player.buildables(tile, [type]),
          timeout,
          null,
        );
      }
      return Array.isArray(buildables)
        ? buildables.find((b) => b.type === type) ?? null
        : null;
    }

    // Port policy: unlike the broader shared-water predicate used by economic
    // planning, a port may only be placed on a shore bordering the canonical
    // open-ocean component. game.isOcean is supplied by the game and identifies
    // the largest connected navigable water surface; isolated lakes and smaller
    // closed seas therefore cannot produce port candidates.
    isOceanPortTile(tile) {
      const game = this.game;
      if (
        game == null ||
        typeof game.isShore !== "function" ||
        typeof game.isWater !== "function" ||
        typeof game.isOcean !== "function" ||
        typeof game.neighbors !== "function"
      ) {
        return false;
      }
      {
        if (!game.isShore(tile)) return false;
        for (const neighbor of game.neighbors(tile) || []) {
          if (game.isWater(neighbor) && game.isOcean(neighbor)) return true;
        }
      }
      return false;
    }

    oceanPortBorderTiles() {
      // gameApi derives this exact open-ocean subset once per cached border
      // snapshot and shares it with the naval planner. Reclassifying every
      // border tile here repeats terrain/neighbor reads whenever Auto-build
      // runs, which becomes expensive on mature frontiers. Keep the local
      // fallback for older page bundles that do not expose the cached adapter.
      if (typeof this.player.oceanShoreBorderTiles === "function") {
        const oceanPortTiles = this.player.oceanShoreBorderTiles();
        if (Array.isArray(oceanPortTiles)) return oceanPortTiles;
      }
      const borderTiles = this.player.borderTiles();
      if (this._oceanPortBorderSnapshot === borderTiles) {
        return this._oceanPortBorderTiles || [];
      }
      const oceanPortTiles = [];
      for (const tile of borderTiles) {
        if (this.isOceanPortTile(tile)) oceanPortTiles.push(tile);
      }
      this._oceanPortBorderSnapshot = borderTiles;
      this._oceanPortBorderTiles = oceanPortTiles;
      return oceanPortTiles;
    }

    hasOceanPortTiles() {
      return this.oceanPortBorderTiles().length > 0;
    }

    randCoastalTileArray(numTiles) {
      return Array.from(this.arraySampler(this.oceanPortBorderTiles(), numTiles));
    }

    // arraySampler — NationStructureBehavior.ts:854 (generator).
    *arraySampler(a, sampleSize) {
      if (a.length <= sampleSize) {
        // Return all elements
        yield* a;
      } else {
        // Sample uniformly without replacement.  The previous Set-based port
        // path copied every ocean-border tile, then randFromSet walked that
        // whole Set for each of the 25 picks. Mature coastlines consequently
        // made a Port decision synchronously O(border × candidates). A lazy
        // partial Fisher-Yates permutation is the same distribution while it
        // stores only the sampled indices: O(candidates) time and memory.
        const moved = new Map();
        for (let index = 0; index < sampleSize; index++) {
          const selectedIndex = this.random.nextInt(index, a.length);
          const selected = moved.get(selectedIndex) ?? selectedIndex;
          const replacement = moved.get(index) ?? index;
          moved.set(selectedIndex, replacement);
          yield a[selected];
        }
      }
    }

    // structureSpawnTileValue — NationStructureBehavior.ts:869.
    structureSpawnTileValue(type) {
      switch (type) {
        case UNIT.City:
          return this.cityValue();
        case UNIT.MissileSilo:
          return this.missileSiloValue();
        case UNIT.Factory:
          return this.factoryValue();
        case UNIT.Port:
          return this.portValue();
        case UNIT.SAMLauncher:
          return this.samLauncherValue();
        default:
          throw new Error(`Value function not implemented for ${type}`);
      }
    }

    legendaryStructureSpawnTileValue(type) {
      const baseValue = this.structureSpawnTileValue(type);
      const missileContext = this.getMissileDefenseContext();
      const spacing = this.spacingConstants().structureSpacing;
      const allyPlacementContext = this.legendaryAllyPlacementContext();
      const teamCenterContext = this.legendaryTeamCenterPlacementContext();
      const samCoverageContext =
        type === UNIT.SAMLauncher
          ? this.legendarySamCoveragePlacementContext()
          : null;

      return (tile) => {
        const base = baseValue(tile);
        const missileRisk = Math.min(
          1,
          this.legendaryMissilePlacementRisk(tile, type, missileContext),
        );
        let value = base;

        // A City/Factory/Port/Silo is productive only while it survives. Keep
        // the engine's exact placement value, then discount tiles that let one
        // feasible enemy blast remove a large fraction of our production.
        if (type !== UNIT.SAMLauncher) {
          value -= missileRisk * Math.max(spacing, Math.abs(base) * 0.8);
        }

        if (type === UNIT.Port) {
          value += this.legendaryRailConnectivityPlacementScore(tile);
        }

        if (
          type === UNIT.City ||
          type === UNIT.Factory ||
          type === UNIT.Port
        ) {
          value += this.legendaryAllySupportPlacementScore(
            tile,
            type,
            allyPlacementContext,
          );
          value += this.legendaryTeamCenterPlacementScore(
            tile,
            teamCenterContext,
          );
        }

        if (type === UNIT.SAMLauncher) {
          // SAMs are not a production axis. Their placement is judged by how
          // much uncovered production they protect and by whether they sit on
          // feasible enemy missile trajectories.
          value += this.legendarySamCoveragePlacementScore(
            tile,
            missileContext,
            samCoverageContext,
          );
          if (missileContext.critical) value += spacing * 2;
        }

        return value;
      };
    }

    legendaryRailConnectivityPlacementScore(tile) {
      {
        const config = this.game.config();
        const stations = this.getOrBuildReachableStations();
        const score = this.computeConnectivityScore(
          tile,
          stations,
          config.trainStationMinRange() ** 2,
          config.trainStationMaxRange() ** 2,
        );
        return score * this.spacingConstants().structureSpacing;
      }
    }

    legendarySamCoveragePlacementContext() {
      const config = this.game.config();
      const range = Number(config.defaultSamRange());
      if (range <= 0) return null;
      const existingSams = this.legendaryFriendlySamUnits();
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      const existingSamCoverage = existingSams.map((sam) => {
        const samRange = Number(config.samRange(sam.level()));
        return {
          tile: sam.tile(),
          rangeSquared: samRange * samRange,
        };
      });
      // Existing SAM coverage does not depend on the candidate tile. Resolve
      // it once per placement decision so every candidate is evaluated only
      // against structures that still need defensive coverage.
      const uncoveredStructures = structures
        .map((structure) => ({ structure, tile: structure.tile() }))
        .filter(
          ({ tile: structureTile }) =>
            !existingSamCoverage.some(
              ({ tile: samTile, rangeSquared: samRangeSquared }) =>
                this.game.euclideanDistSquared(structureTile, samTile) <=
                samRangeSquared,
            ),
        );
      const criticalValueCache = new Map();
      return {
        rangeSquared: range * range,
        candidateSamRange: Number(config.samRange(1)),
        uncoveredStructures,
        criticalValueCache,
        spacing: this.spacingConstants().structureSpacing,
      };
    }

    legendarySamCoveragePlacementScore(
      tile,
      missileContext = null,
      coverageContext = null,
    ) {
      const coverage =
        coverageContext || this.legendarySamCoveragePlacementContext();
      if (coverage === null) return 0;
      let score = 0;
      const {
        rangeSquared,
        candidateSamRange,
        uncoveredStructures,
        criticalValueCache,
        spacing,
      } = coverage;
      for (const { structure, tile: structureTile } of uncoveredStructures) {
        if (
          this.game.euclideanDistSquared(tile, structureTile) > rangeSquared
        ) {
          continue;
        }
        let criticalValue = criticalValueCache.get(structure);
        if (criticalValue === undefined) {
          criticalValue = this.legendaryCriticalStructureValue(structure);
          criticalValueCache.set(structure, criticalValue);
        }
        score += spacing * criticalValue;
      }
      return (
        score +
        this.legendarySamImpactMarginScore(
          tile,
          missileContext || this.getMissileDefenseContext(),
          1,
          candidateSamRange,
        )
      );
    }

    // missileSiloValue — NationStructureBehavior.ts:892.
    missileSiloValue() {
      const game = this.game;
      const borderTiles = this.player.borderTiles();
      const otherUnits = this.player.units(UNIT.MissileSilo);
      const { borderSpacing, structureSpacing } = this.spacingConstants();

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        const closest = closestTile(game, borderTiles, tile);
        const closestBorderDist = closest[1];
        w += Math.min(closestBorderDist, borderSpacing);

        // Prefer to be away from other structures of the same type
        const otherTiles = new Set(otherUnits.map((u) => u.tile()));
        otherTiles.delete(tile);
        const closestOther = closestTwoTiles(game, otherTiles, [tile]);
        if (closestOther !== null) {
          const d = game.manhattanDist(closestOther.x, tile);
          w += Math.min(d, structureSpacing);
        }

        // WIN-FIX (NOT in src): build the silo INSIDE a SAM's protection so it's defended
        // against enemy nukes — our OWN SAM first, an ALLY's SAM as a fallback if we have
        // none, closest-to-SAM best. The huge base makes coverage dominate the elevation/
        // spacing terms while those still break ties WITHIN the covered tiles.
        if (state.settings.winFixes) {
          w += this.samCoverageBonus(tile);
        }

        return w;
      };
    }

    // samCoverageBonus — large score if `tile` sits inside a SAM's range. OWN SAMs win
    // (≥100000) over ALLY SAMs (≥50000), and being CLOSER to the covering SAM scores a
    // little higher; 0 when no friendly SAM covers it. Used to steer silo placement.
    samCoverageBonus(tile) {
      const game = this.game;
      if (typeof game.nearbyUnits !== "function") return 0;
      let cfg;
      {
        cfg = game.config();
      }
      const maxRange = cfg && cfg.maxSamRange ? Number(cfg.maxSamRange()) : 200;
      let nearby;
      {
        nearby = game.nearbyUnits(tile, maxRange, UNIT.SAMLauncher);
      }
      const mySid = this.player.smallID();
      let bestOwn = -1;
      let bestAlly = -1;
      for (const entry of nearby || []) {
        const coverage = this.friendlySamCoverage(entry, tile, cfg, mySid);
        if (coverage === null) continue;
        if (coverage.isOwn) bestOwn = Math.max(bestOwn, coverage.closeness);
        else bestAlly = Math.max(bestAlly, coverage.closeness);
      }
      if (bestOwn >= 0) return 100000 + bestOwn;
      if (bestAlly >= 0) return 50000 + bestAlly;
      return 0;
    }

    friendlySamCoverage(entry, tile, cfg, mySid) {
      const unit = entry.unit || entry;
      const owner = unit.owner?.();
      if (!owner || unit.isUnderConstruction?.()) return null;
      const isOwn = owner.smallID?.() === mySid;
      if (!this.isOwnOrFriendlySamOwner(owner, isOwn)) return null;
      const range = Number(cfg?.samRange?.(Number(unit.level?.()) || 1)) || 0;
      if (range <= 0) return null;
      const distSquared = this.samEntryDistanceSquared(entry, unit, tile);
      if (!this.isWithinSamRange(distSquared, range)) return null;
      return { isOwn, closeness: range - Math.sqrt(distSquared) };
    }

    isWithinSamRange(distanceSquared, range) {
      return distanceSquared != null && distanceSquared <= range * range;
    }

    isOwnOrFriendlySamOwner(owner, isOwn) {
      return isOwn || this.player.isFriendly(owner) === true;
    }

    samEntryDistanceSquared(entry, unit, tile) {
      if (entry.distSquared != null) return entry.distSquared;
      if (!this.game.euclideanDistSquared || !unit.tile) return null;
      return this.game.euclideanDistSquared(tile, unit.tile());
    }

    // Candidate tiles inside the eventual range of an existing own or allied
    // SAM. Sampling is shared fairly across launchers and begins at each SAM's
    // center, so the bounded probe set can actually express "as close as
    // possible" instead of filling itself from one launcher's range edge.
    tilesNearFriendlySams(maxTiles) {
      const game = this.game;
      if (typeof game.units !== "function") return [];
      const mySid = this.player.smallID();
      let allSams;
      {
        allSams = game.units(UNIT.SAMLauncher) || [];
      }
      const { own, ally } = this.partitionFriendlySams(allSams, mySid);
      const useSams = own.concat(ally);
      if (useSams.length === 0) return [];
      let cfg;
      {
        cfg = game.config();
      }
      const out = [];
      const seen = new Set();
      const perSamLimit = Math.max(1, Math.ceil(maxTiles / useSams.length));
      for (const unit of useSams) {
        const local = [];
        this.appendTilesNearSam({
          unit,
          cfg,
          mySid,
          seen,
          out: local,
          maxTiles: perSamLimit,
        });
        out.push(...local);
        if (out.length >= maxTiles) return out;
      }
      return out.slice(0, maxTiles);
    }

    partitionFriendlySams(allSams, mySid) {
      const own = [];
      const ally = [];
      for (const unit of allSams) {
        {
          if (unit.isUnderConstruction?.()) continue;
          const owner = unit.owner?.();
          if (!owner) continue;
          if (owner.smallID?.() === mySid) own.push(unit);
          else if (
            this.player.isFriendly(owner) === true ||
            this.player.isOnSameTeam(owner) === true
          ) {
            ally.push(unit);
          }
        }
      }
      return { own, ally };
    }

    appendTilesNearSam(context) {
      const { unit, cfg, mySid, seen, out, maxTiles } = context;
      const game = this.game;
      const samTile = unit.tile();
      const cx = game.x(samTile);
      const cy = game.y(samTile);
      const range = Number(cfg?.maxSamRange?.()) ||
        Number(cfg?.samRange?.(Number(unit.level?.()) || 1)) || 0;
      const radius = Math.floor(range);
      if (radius <= 0) return;
      const step = Math.max(2, Math.floor(radius / 6));
      const offsets = [{ dx: 0, dy: 0, distanceSquared: 0 }];
      for (let dx = -radius; dx <= radius; dx += step) {
        for (let dy = -radius; dy <= radius; dy += step) {
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared <= range * range) {
            offsets.push({ dx, dy, distanceSquared });
          }
        }
      }
      offsets.sort((left, right) => left.distanceSquared - right.distanceSquared);
      for (const offset of offsets) {
        if (out.length >= maxTiles) break;
        this.appendSamCandidateTile({
          cx,
          cy,
          dx: offset.dx,
          dy: offset.dy,
          mySid,
          seen,
          out,
        });
      }
    }

    appendSamCandidateTile(context) {
      const { cx, cy, dx, dy, mySid, seen, out } = context;
      const game = this.game;
      const nx = cx + dx;
      const ny = cy + dy;
      if (!game.isValidCoord(nx, ny)) return;
      const tile = game.ref(nx, ny);
      if (seen.has(tile) || !game.isLand(tile) || game.ownerID(tile) !== mySid) return;
      seen.add(tile);
      out.push(tile);
    }

    // portValue — NationStructureBehavior.ts:925, enriched so productive
    // stations extend an existing commercial rail line whenever that is legal.
    // A Port placed within the engine's station snap radius splits the real
    // railroad and immediately joins its cluster, which is strictly more useful
    // than an otherwise equivalent isolated coastal Port.
    portValue() {
      const otherTiles = new Set(this.player.units(UNIT.Port).map((u) => u.tile()));
      const nearestOther = this.nearestTileDistanceScorer(otherTiles, true);
      const { structureSpacing } = this.spacingConstants();
      const config = this.game.config();
      const reachableStations = this.getOrBuildReachableStations();
      const railState = this.readRailroadState(this.game);
      const minRangeSquared = config.trainStationMinRange() ** 2;
      const stationRangeSquared = config.trainStationMaxRange() ** 2;

      return (tile) => {
        let w = 0;

        // Prefer to be as far as possible from other ports
        const closestOtherDist = nearestOther(tile);
        w += closestOtherDist;

        w += this.commercialRailPlacementScore(
          tile,
          reachableStations,
          minRangeSquared,
          stationRangeSquared,
          { structureSpacing, railState },
        );

        return w;
      };
    }

    // factoryValue — NationStructureBehavior.ts:951.
    factoryValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = this.economicExposureBorderTiles();
      const otherTiles = new Set(player.units(UNIT.Factory).map((u) => u.tile()));
      const { borderSpacing, structureSpacing } = this.spacingConstants();
      const nearestBorder = this.nearestTileDistanceScorer(borderTiles);
      const nearestOther = this.nearestTileDistanceScorer(otherTiles, true);
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      // Preserve the legacy random draw so existing seed streams do not shift
      // on tiers that already use connectivity. Its result is intentionally
      // ignored: a Factory must always score reachable trade destinations.
      this.shouldUseConnectivityScore(currentDifficulty());
      const railState = this.readRailroadState(game);

      // Factories are the train source. Unlike a cosmetic placement preference,
      // knowing whether one can reach a City or Port directly determines whether
      // its trains can generate trade gold at all, so this must apply on every
      // difficulty rather than being randomized for the easier tiers.
      const reachableStations = this.getOrBuildFactoryTradeDestinations();
      const minRangeSquared = game.config().trainStationMinRange() ** 2;

      // Cross-type spacing: prefer to be away from cities.
      const cityTiles = new Set(player.units(UNIT.City).map((u) => u.tile()));
      const nearestCity = this.nearestTileDistanceScorer(cityTiles);

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        const closestBorderDist = nearestBorder(tile);
        w += Math.min(closestBorderDist, borderSpacing);

        // Prefer to be away from other factories
        const closestOtherDist = nearestOther(tile);
        if (Number.isFinite(closestOtherDist)) {
          w += Math.min(closestOtherDist, stationRange);
        }

        // Prefer to be away from cities (cross-type spacing)
        const closestCityDist = nearestCity(tile);
        if (Number.isFinite(closestCityDist)) {
          w += Math.min(closestCityDist, structureSpacing);
        }

        w += this.commercialRailPlacementScore(
          tile,
          reachableStations,
          minRangeSquared,
          stationRangeSquared,
          { structureSpacing, railState },
        );

        return w;
      };
    }

    /**
     * Return only the part of our border that exposes an economic structure to
     * unowned terrain or a non-friendly player. A seam shared exclusively with
     * teammates/allies is part of the team's economic interior: penalizing it
     * can push Cities and Factories away from the strongest commercial rail
     * connection for no corresponding safety benefit.
     *
     * Mixed seams remain exposed. If a tile touches both an ally and an enemy,
     * the hostile/unowned neighbor wins, so this cannot pull production onto a
     * contested frontier. When the client cannot classify ownership reliably,
     * preserve the conservative upstream behavior and keep the full border.
     */
    economicExposureBorderTiles() {
      const borderTiles = this.player.borderTiles();
      if (!state.settings.winFixes) return borderTiles;
      if (!this.canClassifyEconomicBorder()) return borderTiles;

      const tick = safeStructureGameTick(this.game);
      if (
        Number.isFinite(tick) &&
        this._economicExposureBorderTick === tick &&
        this._economicExposureBorderTiles !== null
      ) {
        return this._economicExposureBorderTiles;
      }

      const ownSid = this.player.smallID();
      const exposed = Array.from(borderTiles).filter((tile) =>
        this.economicBorderTileIsExposed(tile, ownSid),
      );

      if (Number.isFinite(tick)) {
        this._economicExposureBorderTick = tick;
        this._economicExposureBorderTiles = exposed;
      }
      return exposed;
    }

    canClassifyEconomicBorder() {
      return (
        typeof this.game.neighbors === "function" &&
        typeof this.game.hasOwner === "function" &&
        typeof this.game.ownerID === "function" &&
        typeof this.game.playerBySmallID === "function" &&
        typeof this.player.smallID === "function"
      );
    }

    economicBorderTileIsExposed(tile, ownSid) {
      const externalOwners = (this.game.neighbors(tile) || [])
        .map((neighbor) =>
          this.game.hasOwner(neighbor) ? this.game.ownerID(neighbor) : null,
        )
        .filter((ownerSid) => ownerSid !== ownSid);
      return (
        externalOwners.length === 0 ||
        externalOwners.some((ownerSid) => !this.economicBorderOwnerIsFriendly(ownerSid))
      );
    }

    economicBorderOwnerIsFriendly(ownerSid) {
      if (ownerSid === null) return false;
      const owner = this.game.playerBySmallID(ownerSid);
      return Boolean(
        owner &&
          (this.player.isFriendly?.(owner) === true ||
            this.player.isOnSameTeam?.(owner) === true),
      );
    }

    // Prefer a City or Port that connects to the existing trade network, and
    // strongly prefer the engine's exact "snap to railroad" placement.  The
    // latter is intentionally read from GameView's live railroadState rather
    // than inferred from map direction or station geometry: RailNetworkImpl
    // splits a real rail when a station is built within its fixed radius of 3.
    // The local 7×7 search is bounded (49 reads per scored candidate) and runs
    // only for the existing 25-candidate placement budget.
    commercialRailPlacementScore(
      tile,
      reachableStations,
      minRangeSquared,
      stationRangeSquared,
      options,
    ) {
      const structureSpacing = Number(options?.structureSpacing ?? options);
      const railState = options?.railState ?? this.readRailroadState(this.game);
      const connectivity = this.computeConnectivityScore(
        tile,
        reachableStations,
        minRangeSquared,
        stationRangeSquared,
      );
      const snapDistance = this.existingRailSnapDistance(tile, railState);
      if (snapDistance === null) return connectivity * structureSpacing;

      // Retain the connectivity contribution, then make a legal direct snap
      // decisive over generic spacing.  The bounded closeness term only breaks
      // ties between candidates that can all join the same active railway.
      return (
        connectivity * structureSpacing +
        structureSpacing * (2 + Math.max(0, 3 - snapDistance) / 3)
      );
    }

    existingRailSnapDistance(
      tile,
      railState = this.readRailroadState(this.game),
    ) {
      if (!railState || railState.length === 0) return null;
      const x = Number(this.game.x(tile));
      const y = Number(this.game.y(tile));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      let nearestSquared = Infinity;
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > 9 || distanceSquared >= nearestSquared) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.game.isValidCoord(nx, ny)) continue;
          const railTile = this.game.ref(nx, ny);
          if (railState[railTile] !== 0) nearestSquared = distanceSquared;
        }
      }
      return Number.isFinite(nearestSquared) ? Math.sqrt(nearestSquared) : null;
    }

    // shouldUseConnectivityScore — NationStructureBehavior.ts:1018.
    shouldUseConnectivityScore(difficulty) {
      let randomChance;
      switch (difficulty) {
        case Difficulty.Easy:
          randomChance = 0;
          break;
        case Difficulty.Medium:
          randomChance = 60;
          break;
        case Difficulty.Hard:
          randomChance = 75;
          break;
        case Difficulty.Impossible:
          randomChance = 100;
          break;
        case Difficulty.Legendary:
          randomChance = 100;
          break;
        default:
          randomChance = 100;
      }

      return this.random.nextInt(0, 100) < randomChance;
    }

    // getOrBuildReachableStations — NationStructureBehavior.ts:1040.
    getOrBuildReachableStations() {
      if (this.reachableStationsCache === null) {
        this.reachableStationsCache = this.buildReachableStations();
      }
      return this.reachableStationsCache;
    }

    // A Factory supplies trains; only a City or Port can be the paying end of
    // that train. Keep other factories in the spacing penalty, but never let a
    // nearby factory masquerade as a new commercial destination.
    getOrBuildFactoryTradeDestinations() {
      return this.buildReachableStations([UNIT.City, UNIT.Port]);
    }

    novelFactoryTradeCandidates(candidates) {
      if (typeof this.player?.units !== "function") return candidates;
      const destinations = this.getOrBuildFactoryTradeDestinations();
      const factories = this.player.units(UNIT.Factory);
      if (destinations.length === 0 || factories.length === 0) return candidates;
      const minRangeSquared = this.game.config().trainStationMinRange() ** 2;
      const stationRangeSquared = this.game.config().trainStationMaxRange() ** 2;
      return candidates.filter(({ t }) =>
        destinations.some(({ tile }) => {
          const candidateDistance = this.game.euclideanDistSquared(t, tile);
          if (
            candidateDistance < minRangeSquared ||
            candidateDistance > stationRangeSquared
          ) {
            return false;
          }
          return !factories.some((factory) => {
            const distance = this.game.euclideanDistSquared(factory.tile(), tile);
            return distance >= minRangeSquared && distance <= stationRangeSquared;
          });
        }),
      );
    }

    onlyDuplicateFactoryTradeCandidates(candidates) {
      if (candidates.length === 0 || typeof this.player?.units !== "function") {
        return false;
      }
      const destinations = this.getOrBuildFactoryTradeDestinations();
      const factories = this.player.units(UNIT.Factory);
      return (
        destinations.length > 0 &&
        factories.length > 0 &&
        this.novelFactoryTradeCandidates(candidates).length === 0
      );
    }

    // trainGoldBase — the game's Config.trainGold value WITHOUT its final
    // goldMultiplierFor(player) factor. We deliberately drop that factor:
    //   1) it is IDENTICAL for every relation, so it CANCELS OUT in the normalized
    //      station weights below (everything is divided by the "ally" gold), and
    //   2) on hosts that enable the `goldMultiplier` host-cheat (common on private /
    //      self-hosted servers), the game's goldMultiplierFor() calls
    //      player.isLobbyCreator() — which our wrapped player object does NOT expose →
    //      a TypeError that was crashing the ENTIRE bot tick. Replicating the base here
    //      avoids passing our player into the game's gold path at all.
    //   Mirrors Config.ts:trainGold exactly: baseGold by relation, −5k per city past
    //   the first 10, floored at 5k.
    trainGoldBase(rel, citiesVisited) {
      const visited = Math.max(0, (citiesVisited || 0) - 9);
      let baseGold;
      switch (rel) {
        case "ally":
          baseGold = 35000;
          break;
        case "self":
          baseGold = 10000;
          break;
        case "team":
        case "other":
        default:
          baseGold = 25000;
      }
      return Math.max(5000, baseGold - visited * 5000);
    }

    // buildReachableStations — NationStructureBehavior.ts:1055.
    // src reads railNetwork().stationManager().getAll() to map each stationed unit
    // to its rail Cluster. We reproduce the SAME entry shape src does
    // ({ tile, cluster (stable cluster-key | null), weight }) and the SAME trade-gold
    // WEIGHTS — via trainGoldBase (the trainGold base SANS the host-cheat multiplier,
    // which cancels in normalization, so the weights are still exact); only HOW clusters
    // are determined differs by environment (see the StationUnionFind header):
    //   - EXTENSION: real rail tiles from game.railroadState() → flood-filled rail
    //     components; each station's cluster is the rail component at/adjacent to
    //     its tile (null when no rail touches it → isolated). EXACT.
    //   - HARNESS: railroadState() null → proximity union-find. APPROXIMATE.
    buildReachableStations(types = [UNIT.City, UNIT.Port, UNIT.Factory]) {
      const game = this.game;
      const stationed = this.collectReachableStations(types);

      if (stationed.length === 0) return [];

      const railState = this.readRailroadState(game);
      if (railState) {
        const railComp = this.assignRailClusters(stationed, railState);
        if (railComp !== null) return this.stationClusterEntries(stationed, railComp);
      }
      return this.proximityStationClusters(game, stationed);
    }

    collectReachableStations(types = [UNIT.City, UNIT.Port, UNIT.Factory]) {
      const player = this.player;
      const maxTradeGold = Math.max(Number(this.trainGoldBase("ally", 0)), 1);
      const stationed = [];
      const append = (owner, weight) => {
        for (const unit of owner.units(...types)) {
          if (unit.hasTrainStation()) {
            stationed.push({ tile: unit.tile(), weight, key: unit.id() });
          }
        }
      };
      append(player, Number(this.trainGoldBase("self", 0)) / maxTradeGold);
      for (const neighbor of player.nearby()) {
        if (!this.isTradeableStationNeighbor(neighbor)) continue;
        let relation = "other";
        if (player.isAlliedWith(neighbor)) relation = "ally";
        if (player.isOnSameTeam(neighbor)) relation = "team";
        append(neighbor, Number(this.trainGoldBase(relation, 0)) / maxTradeGold);
      }
      return stationed;
    }

    isTradeableStationNeighbor(neighbor) {
      return (
        neighbor.isPlayer?.() === true &&
        neighbor.type() !== PlayerType.Bot &&
        shimCanTrade(this.player, neighbor)
      );
    }

    readRailroadState(game) {
      {
        return typeof game.railroadState === "function"
          ? game.railroadState()
          : null;
      }
    }

    stationClusterEntries(stationed, clusters) {
      return stationed.map((station, index) => ({
        tile: station.tile,
        cluster: clusters[index],
        weight: station.weight,
      }));
    }

    proximityStationClusters(game, stationed) {
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      const uf = new StationUnionFind();
      for (const s of stationed) uf.add(s.key);
      for (let i = 0; i < stationed.length; i++) {
        for (let j = i + 1; j < stationed.length; j++) {
          const d = game.euclideanDistSquared(stationed[i].tile, stationed[j].tile);
          if (d <= stationRangeSquared) {
            uf.union(stationed[i].key, stationed[j].key);
          }
        }
      }
      return stationed.map((station) => ({
        tile: station.tile,
        cluster: uf.find(station.key),
        weight: station.weight,
      }));
    }

    // assignRailClusters — EXTENSION-only. Flood-fill the REAL rail tiles
    // (railState[tile] !== 0) into connected components, then map each stationed
    // unit to the rail component that touches its tile (the station tile itself or
    // any cardinal/diagonal neighbor — a station's rail may begin one tile away).
    // Returns a parallel array of cluster keys (a "rail#<id>" string per station,
    // or null if no rail touches the station → isolated, matching core's singleton
    // for scoring). Returns null only on an unexpected failure so the caller can
    // fall back to proximity. Bounded: flood-fill visits each rail tile once.
    assignRailClusters(stationed, railState) {
      {
        const game = this.game;
        const width = game.width();
        const height = game.height();
        const total = width * height;
        // Lazily flood-fill only rail components touched by reachable stations.
        // A full-map Int32Array fill here ran on every construction decision and
        // produced visible pauses on large maps even when the railway itself was
        // tiny. Sparse labels keep the same O(visited rail tiles) traversal while
        // removing the O(map tiles) allocation/fill from Auto-build's hot path.
        const railLabel = new Map();
        let nextRailId = 0;

        const labelFrom = (seed) => {
          // seed is a rail tile with no label yet; BFS its component.
          const id = nextRailId++;
          const queue = [seed];
          railLabel.set(seed, id);
          let head = 0;
          while (head < queue.length) {
            const cur = queue[head++];
            for (const n of game.neighbors(cur)) {
              if (
                n >= 0 &&
                n < total &&
                railState[n] !== 0 &&
                !railLabel.has(n)
              ) {
                railLabel.set(n, id);
                queue.push(n);
              }
            }
          }
          return id;
        };

        // Resolve the rail component id touching a station tile: the tile itself
        // if it is a rail tile, else any neighbor that is a rail tile.
        const railIdAt = (tile) => {
          if (tile < 0 || tile >= total) return null;
          if (railState[tile] !== 0) {
            if (!railLabel.has(tile)) labelFrom(tile);
            return railLabel.get(tile);
          }
          for (const n of game.neighbors(tile)) {
            if (n >= 0 && n < total && railState[n] !== 0) {
              if (!railLabel.has(n)) labelFrom(n);
              return railLabel.get(n);
            }
          }
          return null;
        };

        const out = new Array(stationed.length);
        for (let i = 0; i < stationed.length; i++) {
          const id = railIdAt(stationed[i].tile);
          // null cluster = isolated station (no rail) — core treats a singleton
          // station's cluster as effectively its own; using null routes it through
          // computeConnectivityScore's isolatedWeight path (individual weight).
          out[i] = id === null ? null : "rail#" + id;
        }
        return out;
      }
    }

    // computeConnectivityScore — NationStructureBehavior.ts:1133. Reproduced
    // verbatim: per cluster the MAX weight of any in-range station is taken;
    // isolated (null-cluster) stations contribute their individual weights.
    computeConnectivityScore(
      tile,
      reachableStations,
      minRangeSquared,
      stationRangeSquared,
    ) {
      const clustersInRange = new Map();
      let isolatedWeight = 0;
      for (const { tile: stationTile, cluster, weight } of reachableStations) {
        const dist = this.game.euclideanDistSquared(tile, stationTile);
        if (dist < minRangeSquared || dist > stationRangeSquared) continue;
        if (cluster !== null) {
          clustersInRange.set(
            cluster,
            Math.max(clustersInRange.get(cluster) ?? 0, weight),
          );
        } else {
          isolatedWeight += weight;
        }
      }
      let score = isolatedWeight;
      for (const cw of clustersInRange.values()) score += cw;
      return score;
    }

    // cityValue — NationStructureBehavior.ts:1168.
    cityValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = this.economicExposureBorderTiles();
      const otherTiles = new Set(player.units(UNIT.City).map((u) => u.tile()));
      const { borderSpacing, structureSpacing } = this.spacingConstants();
      const nearestBorder = this.nearestTileDistanceScorer(borderTiles);
      const nearestOther = this.nearestTileDistanceScorer(otherTiles);
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      // City placement is an economic decision, not a difficulty-dependent
      // coin flip. Always value the commercial routes the new station can
      // join; the normal placement and safety gates still decide legality.
      const reachableStations = this.getOrBuildReachableStations();
      const railState = this.readRailroadState(game);
      const minRangeSquared = game.config().trainStationMinRange() ** 2;

      // Cross-type spacing: prefer to be away from factories.
      const factoryTiles = new Set(
        player.units(UNIT.Factory).map((u) => u.tile()),
      );
      const nearestFactory = this.nearestTileDistanceScorer(factoryTiles);

      return (tile) => {
        let w = 0;

        w += game.magnitude(tile);

        const closestBorderDist = nearestBorder(tile);
        w += Math.min(closestBorderDist, borderSpacing);

        const closestOtherDist = nearestOther(tile);
        if (Number.isFinite(closestOtherDist)) {
          w += Math.min(closestOtherDist, structureSpacing);
        }

        // Prefer to be away from factories (cross-type spacing)
        const closestFactoryDist = nearestFactory(tile);
        if (Number.isFinite(closestFactoryDist)) {
          w += Math.min(closestFactoryDist, structureSpacing);
        }

        w += this.commercialRailPlacementScore(
          tile,
          reachableStations,
          minRangeSquared,
          stationRangeSquared,
          { structureSpacing, railState },
        );

        return w;
      };
    }

    samCriticalStructureWeight(structure) {
      const type = structure?.type?.();
      const level = Math.max(1, Math.floor(Number(structure?.level?.() ?? 1)));
      if (!type || !Number.isFinite(level)) return 1;
      const cost = this.safeStructureCost(type);
      const costWeight = typeof cost === "bigint"
        ? Number(cost / 250_000n)
        : Math.floor(Number(cost) / 250_000);
      return level * Math.max(1, Math.min(20, Number.isFinite(costWeight) ? costWeight : 1));
    }

    // Mandatory hostile-silo response: protect the highest-value *cluster*,
    // not merely the largest count of cheap buildings. Weighted coverage is
    // dominant; weighted closeness breaks ties toward the cluster's center so
    // the same SAM retains useful coverage as its range rises through level 5.
    threatSamLauncherValue() {
      const game = this.game;
      const player = this.player;
      let structures;
      let existingSams;
      let config;
      let range;
      {
        structures = player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.MissileSilo,
          UNIT.Port,
        );
        existingSams = player.units(UNIT.SAMLauncher);
        config = game.config();
        range = Number(config.defaultSamRange());
      }
      if (!Array.isArray(structures) || !Number.isFinite(range) || range <= 0) {
        return () => 0;
      }

      const rangeSquared = range * range;
      const structureEntries = [];
      for (const structure of structures) {
        if (!structure || typeof structure.tile !== "function") continue;
        {
          const tile = structure.tile();
          if (tile !== null && tile !== undefined) {
            structureEntries.push({
              tile,
              weight: this.samCriticalStructureWeight(structure),
            });
          }
        }
      }
      const totalWeight = structureEntries.reduce((sum, entry) => sum + entry.weight, 0);
      const existingSamProfiles = (existingSams || [])
        .filter((sam) => {
        {
          return !(
            typeof sam.isUnderConstruction === "function" &&
            sam.isUnderConstruction()
          );
        }
      })
        .map((sam) => {
        {
          const samRange = Number(config.samRange(sam.level()));
          return {
            tile: sam.tile(),
            rangeSquared: samRange * samRange,
          };
        }
      })
        .filter((sam) => sam !== null && Number.isFinite(sam.rangeSquared));
      return (tile) => {
        let totalCoverage = 0;
        let newCoverage = 0;
        let centeredCoverage = 0;
        for (const entry of structureEntries) {
          const structureTile = entry.tile;
          let distanceSquared;
          {
            distanceSquared = game.euclideanDistSquared(tile, structureTile);
          }
          if (distanceSquared > rangeSquared) continue;
          totalCoverage += entry.weight;
          centeredCoverage += entry.weight * Math.max(0, 1 - distanceSquared / rangeSquared);

          const alreadyCovered = existingSamProfiles.some((sam) => {
            {
              return (
                game.euclideanDistSquared(structureTile, sam.tile) <=
                sam.rangeSquared
              );
            }
          });
          if (!alreadyCovered) newCoverage += entry.weight;
        }

        return totalCoverage * (totalWeight + 1) + newCoverage + centeredCoverage;
      };
    }

    // samLauncherValue — NationStructureBehavior.ts:1233.
    samLauncherValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = player.borderTiles();
      const otherUnits = player.units(UNIT.SAMLauncher);
      const { borderSpacing, structureSpacing } = this.spacingConstants();

      const difficulty = currentDifficulty();
      const weightByLevel = isAtLeastHardDifficulty(difficulty);

      const protectEntries = [];
      for (const unit of player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.MissileSilo,
        UNIT.Port,
      )) {
        switch (unit.type()) {
          case UNIT.City:
          case UNIT.Factory:
          case UNIT.MissileSilo:
          case UNIT.Port:
            protectEntries.push({
              tile: unit.tile(),
              weight: weightByLevel ? unit.level() : 1,
            });
        }
      }
      const range = game.config().defaultSamRange();
      const rangeSquared = range * range;
      const friendlySamNetworkScore = this.friendlyUsefulSamPlacementScore(
        this.samProtectableStructureTiles(),
        structureSpacing,
      );
      const otherTiles = new Set(otherUnits.map((unit) => unit.tile()));
      const nearestBorder = this.nearestTileDistanceScorer(borderTiles);
      const nearestOther = this.nearestTileDistanceScorer(otherTiles, true);

      const useCoverageWeighting = isLegendaryDifficulty(difficulty)
        ? true
        : difficulty !== Difficulty.Easy && this.random.nextInt(0, 100) < 25;

      // Pre-compute existing SAM coverage for each protectable structure.
      let structureCoverage = null;
      if (useCoverageWeighting) {
        structureCoverage = this.existingSamStructureCoverage(protectEntries);
      }

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        w += Math.min(nearestBorder(tile), borderSpacing);

        // Prefer to be away from other structures of the same type
        const closestOtherDist = nearestOther(tile);
        if (Number.isFinite(closestOtherDist)) {
          w += Math.min(closestOtherDist, structureSpacing);
        }

        // Prefer to be in range of other structures (skip on easy difficulty)
        if (difficulty !== Difficulty.Easy) {
          for (const entry of protectEntries) {
            const distanceSquared = game.euclideanDistSquared(tile, entry.tile);
            if (distanceSquared > rangeSquared) continue;
            if (useCoverageWeighting && structureCoverage !== null) {
              const coverage = structureCoverage.get(entry.tile) ?? 0;
              const coverageWeight = 1 / (1 + coverage);
              w += structureSpacing * entry.weight * coverageWeight;
            } else {
              w += structureSpacing * entry.weight;
            }
          }
        }

        // Extend a useful friendly SAM umbrella only when this site protects an
        // additional asset. This favors coherent own/allied coverage without
        // stacking a redundant launcher inside an already complete umbrella.
        w += friendlySamNetworkScore(tile);

        return w;
      };
    }

    friendlyUsefulSamPlacementScore(protectedTiles, structureSpacing) {
      if (protectedTiles === null || protectedTiles.size === 0) {
        return () => 0;
      }
      const config = this.game.config();
      const candidateRange = Math.max(
        0,
        Number(config.samRange?.(1) ?? config.defaultSamRange?.() ?? 0),
      );
      if (candidateRange <= 0) return () => 0;
      const anchors = this.legendaryFriendlySamUnits()
        .map((sam) => {
          const level = Math.max(1, Number(sam.level()));
          const currentRange = Math.max(0, Number(config.samRange(level)));
          const upgradedRange = Math.max(
            currentRange,
            Number(config.samRange(level + 1)),
          );
          return { tile: sam.tile(), currentRange, upgradedRange };
        })
        .filter((anchor) => anchor.currentRange > 0 && anchor.upgradedRange > 0);
      if (anchors.length === 0) return () => 0;
      const candidateRangeSquared = candidateRange * candidateRange;

      return (tile) => {
        let best = 0;
        for (const anchor of anchors) {
          const anchorRangeSquared = anchor.currentRange * anchor.currentRange;
          const upgradedRangeSquared = anchor.upgradedRange * anchor.upgradedRange;
          const anchorDistanceSquared = this.game.euclideanDistSquared(
            tile,
            anchor.tile,
          );
          if (anchorDistanceSquared > upgradedRangeSquared) continue;

          let anchorProtectsAsset = false;
          let candidateAddsCoverage = false;
          for (const structureTile of protectedTiles) {
            const anchorDistance = this.game.euclideanDistSquared(
              anchor.tile,
              structureTile,
            );
            if (anchorDistance <= upgradedRangeSquared) {
              anchorProtectsAsset = true;
            }
            if (
              this.game.euclideanDistSquared(tile, structureTile) <=
                candidateRangeSquared &&
              anchorDistance > anchorRangeSquared
            ) {
              candidateAddsCoverage = true;
            }
          }
          if (!anchorProtectsAsset || !candidateAddsCoverage) continue;
          const proximity = Math.max(
            0,
            1 - Math.sqrt(anchorDistanceSquared) / anchor.upgradedRange,
          );
          best = Math.max(best, structureSpacing * proximity);
        }
        return best;
      };
    }

    existingSamStructureCoverage(protectEntries) {
      const game = this.game;
      const coverageByTile = new Map();
      const existingSams = this.player.units(UNIT.SAMLauncher);
      for (const entry of protectEntries) {
        let coverageScore = 0;
        for (const sam of existingSams) {
          const samRange = game.config().samRange(sam.level());
          const distanceSquared = game.euclideanDistSquared(
            entry.tile,
            sam.tile(),
          );
          if (distanceSquared <= samRange * samRange) coverageScore += sam.level();
        }
        coverageByTile.set(entry.tile, coverageScore);
      }
      return coverageByTile;
    }

    // spacingConstants — NationStructureBehavior.ts:1323.
    spacingConstants() {
      const borderSpacing = this.game
        .config()
        .nukeMagnitudes(UNIT.AtomBomb).outer;
      return { borderSpacing, structureSpacing: borderSpacing * 2 };
    }
  }
