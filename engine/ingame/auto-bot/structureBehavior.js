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
//     take the FIRST whose returned BuildableUnit `.canBuild !== false`. Same
//     candidate set + value fn → same winner (the highest-value buildable tile).
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
    [Difficulty.Easy]: 0.15,
    [Difficulty.Medium]: 0.2,
    [Difficulty.Hard]: 0.25,
    [Difficulty.Impossible]: 0.3,
    [Difficulty.Legendary]: 0.35,
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

  /**
   * A hostile silo threat becomes an H-bomb/SAM priority once one enemy's
   * built-silo level sum reaches this value. A level-1 silo therefore counts
   * as one, not as two.
   *
   * Keep this per-player rather than aggregating all enemies: the user-facing
   * threat is a single opponent's launch capability, not a lobby-wide count.
   */
  const HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD = 2;

  /** OpenFront's SAM upgrade ladder currently tops out at level five. */
  const HYDROGEN_SAM_MAX_UPGRADE_LEVEL = 5;

  /** Ratio per city used for the first missile silo so nations start nuking earlier */
  const FIRST_MISSILE_SILO_RATIO = 0.4;

  /** If we have more than this many structures per tiles, prefer upgrading over building */
  const UPGRADE_DENSITY_THRESHOLD = 1 / 1500;

  /**
   * Maximum raw tiles ranked and asynchronously probed for one structure.
   * The normal placement sampler already uses this budget; coverage-priority
   * placement must keep the same bound even when the nation owns many
   * structures, because each probe crosses the async worker boundary.
   */
  const STRUCTURE_PLACEMENT_CANDIDATE_LIMIT = 25;

  /**
   * The mandatory hostile-silo SAM path can wake up as soon as an enemy reaches
   * the 1.5M-gold trigger. Keep one failed placement attempt bounded: six
   * concurrent read-only probes with a short timeout are enough to preserve the
   * coverage-ranked choice without serially waiting on all 25 candidates.
   */
  const HOSTILE_SILO_SAM_PROBE_LIMIT = 6;
  const HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS = 750;

  /** Keep defensive SAM upgrade probes from serially blocking on the worker. */
  const DEFENSIVE_SAM_PROBE_CONCURRENCY = 6;

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

  /** Gold at which a hostile player receives the mandatory SAM response. */
  const HOSTILE_SAM_TRIGGER_GOLD_THRESHOLD = 1_500_000n;

  /** Structures that directly grow the nation's economy. */
  const ECONOMIC_STRUCTURE_TYPES = [UNIT.Port, UNIT.Factory, UNIT.City];

  /** Tick gap a high-starting-gold nation must wait before placing its Nth structure */
  const HIGH_GOLD_STRUCTURE_COOLDOWN_TICKS = [
    0, // before #1 (SAM) — no pause
    0, // before #2 — no pause
    250, // before #3 — 25s
    150, // before #4 — 15s
    100, // before #5 — 10s
  ];

  /** Length in ticks of each on/off phase after the team-mode save-up target is first reached */
  const TEAM_POST_SAVE_UP_PHASE_TICKS = 150; // 15s

  /**
   * Incoming land-attack troop count as a fraction of own troops below which the
   * nation does not build defensive structures.
   */
  const UNDER_ATTACK_THREAT_RATIO = 0.35;

  /**
   * Do not repeat a failed hostile-Silo SAM placement probe more than once per
   * second of game time. The placement path can otherwise perform 25 sequential
   * async worker probes on every structure decision.
   */
  const HOSTILE_SILO_SAM_RETRY_TICKS = 10;

  /** Legendary only spends on Defense Posts during an exceptional land assault. */
  const LEGENDARY_DEFENSE_POST_THREAT_RATIO = 1.25;

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
    try {
      if (typeof game.sharedWaterComponents === "function") {
        return game.sharedWaterComponents(player);
      }
    } catch (_e) {
      /* fall through to null — treat as no coastal access */
    }
    return null;
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

  class StructureBehavior {
    constructor(random, game, player) {
      this.random = random;
      this.game = game;
      this.player = player;

      // src private fields (NationStructureBehavior.ts:126-135).
      this.reachableStationsCache = null;
      this._sharedWaterComponents = null;
      this.lastStructureTick = null;
      this.placementsCount = 0;
      this._hasHighStartingGold = null;
      this._postSaveUpStartTick = null;
      this._hostileSiloSamAttemptTick = null;
      this._hostileSiloSamRetryNotBeforeTick = null;
      this._hostilePlayersSnapshotTick = null;
      this._hostilePlayersSnapshot = null;
      this._hostileThreatSnapshotTick = null;
      this._hostileThreatSnapshot = null;
      this._hostileSiloCapacitySnapshotTick = null;
      this._hostileSiloCapacitySnapshot = null;
      this._missileDefenseSignalTick = null;
      this._missileDefenseSignalCache = null;
      // Missile placement forecasts are shared by several Legendary and
      // win-fix construction gates. Keep one snapshot per game tick so a
      // single decision cannot rebuild the same trajectory model repeatedly.
      this._missileDefenseContextTick = null;
      this._missileDefenseContextKey = null;
      this._missileDefenseContextCache = null;
      this._missileDefenseEvaluationTick = null;
      this._missileDefenseEvaluationContext = null;
      this._missileDefenseEvaluationCache = null;
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
    async handleStructures() {
      const legendaryDifficulty = isLegendaryDifficulty();
      // WIN-FIX: before ordinary pacing, use the trajectory forecast to upgrade
      // an existing SAM when one level is enough to intercept an incoming
      // missile. The faithful difficulty branches remain untouched when this
      // custom switch is off; Legendary keeps its dedicated adaptive call below.
      if (
        state.settings.winFixes &&
        !legendaryDifficulty &&
        (await this.maybeUpgradeMissileDefenseSam())
      ) {
        return true;
      }
      if (
        state.settings.winFixes &&
        (await this.maybeEnsureHydrogenStructureCoverage())
      ) {
        return true;
      }
      if (
        state.settings.winFixes &&
        (await this.maybeUpgradeHydrogenProtectionSam())
      ) {
        return true;
      }
      if (
        state.settings.winFixes &&
        (await this.maybeUpgradeSiloForNukeDemand())
      ) {
        return true;
      }
      if (
        state.settings.winFixes &&
        !legendaryDifficulty &&
        (await this.maybeSpawnHostileSiloSam())
      ) {
        return true;
      }
      if (
        state.settings.winFixes &&
        !legendaryDifficulty &&
        (await this.maybeUpgradeSamForSiloParity())
      ) {
        return true;
      }

      const legendaryDefenseEmergency =
        legendaryDifficulty &&
        (this.legendaryMissileDefenseUrgent() ||
          (state.settings.winFixes && this.samLevelParityGap() > 0));

      // If the existing SAM network still lacks capacity after the dedicated
      // site check, establish a launcher before ordinary cooldown/save-up
      // pacing. Legendary keeps its emergency ordering inside
      // doHandleLegendaryStructures().
      if (
        state.settings.winFixes &&
        !legendaryDifficulty &&
        this.samLevelParityGap() > 0 &&
        (!this.shouldBuildHostileSiloSam() ||
          (!this.hostileSiloSamAttemptedThisTick() &&
            !this.hostileSiloSamActionBlocked())) &&
        (await this.maybeSpawnStructure(
          UNIT.SAMLauncher,
          this.shouldBuildHostileSiloSam()
            ? this.hostileSiloSamPlacementOptions()
            : {},
        ))
      ) {
        return true;
      }

      // Defense posts are handled outside the normal pacing/counter system:
      // they don't increment placementsCount or lastStructureTick, and they are
      // never built as the very first structure.
      if (
        !legendaryDefenseEmergency &&
        this.placementsCount > 0 &&
        !this.game.config().isUnitDisabled(UNIT.DefensePost)
      ) {
        if (await this.tryBuildDefensePost()) {
          return true;
        }
        // If the attack threshold is met, block other structures even when
        // placement failed (no tile found / can't afford).
        if (this.defensePostNeeded()) {
          return false;
        }
      }

      // Legendary missile defense is an emergency exception to ordinary pacing:
      // a save-up phase or high-gold cooldown must not consume the five-tick
      // window in which an interceptor upgrade/build can still matter.
      if (!legendaryDefenseEmergency && this.isOnStructureCooldown()) {
        return false;
      }
      if (!legendaryDefenseEmergency && this.isInPostSaveUpBlockedPhase()) {
        return false;
      }
      const built = await this.doHandleStructures();
      if (built) {
        this.lastStructureTick = this.game.ticks();
        this.placementsCount++;
      }
      return built;
    }

    // tryBuildDefensePost — NationStructureBehavior.ts:181 (now async).
    async tryBuildDefensePost() {
      if (!autoBotBuildAllowed(UNIT.DefensePost)) return false; // user disallowed
      // src reads gameConfig().difficulty → REPLICATED difficulty.
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy) return false;
      if (difficulty === Difficulty.Medium && !this.random.chance(2)) {
        return false;
      }

      const player = this.player;
      // Land attacks only (src: sourceTile() === null). isLandAttack() uses the
      // exact sourceTile when present (harness) and reconstructs it via shared
      // land border when the extension omits it.
      const landAttacks = player
        .incomingAttacks()
        .filter((a) => this.isLandAttack(a));
      if (landAttacks.length === 0) return false;

      const ourTroops = player.troops();
      if (ourTroops <= 0) return false;

      const incomingTroops = landAttacks.reduce((sum, a) => sum + a.troops(), 0);
      const ratio = incomingTroops / ourTroops;
      if (ratio < UNDER_ATTACK_THREAT_RATIO) return false;
      if (
        isLegendaryDifficulty(difficulty) &&
        ratio < LEGENDARY_DEFENSE_POST_THREAT_RATIO
      ) {
        return false;
      }

      let allowed;
      if (difficulty === Difficulty.Medium) {
        allowed = 1;
      } else {
        allowed = Math.ceil(ratio / DEFENSE_POST_RATIO_PER_POST);
      }

      const frontTiles = this.getAttackFrontTiles(landAttacks);
      if (this.countDefensePostsNearFront(frontTiles, allowed) >= allowed) {
        return false;
      }

      const cost = this.cost(UNIT.DefensePost);
      if (player.gold() < cost) return false;

      // src samples tiles (canBuild checked inside the sampler) and builds the
      // first valid one. Client: sample WITHOUT canBuild (it's async), then probe
      // buildables down the sampled list and build the first canBuild !== false.
      // DIVERGENCE: src filters by sync canBuild during sampling, so it may sample
      // more raw candidates to reach `count` valid ones; we sample `count` raw
      // candidates and probe them, which can yield slightly fewer probes. Same
      // candidate-generation distribution; only the in-sampler canBuild filter
      // moves to the probe phase (rank-then-probe).
      const tiles = this.sampleTilesNearFront(frontTiles, 25, UNIT.DefensePost);
      for (const tile of tiles) {
        const bu = await this.buildableFor(UNIT.DefensePost, tile);
        if (bu === null || bu.canBuild === false) continue;
        const buildMenu = getBuildMenu();
        if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
          return false;
        }
        // src: addExecution(new ConstructionExecution(player, DefensePost, tile)).
        buildMenu.sendBuildOrUpgrade(bu, bu.canBuild);
        state.stats.builds++;
        setLastAction(tr("🛡️ Defense post"), "build");
        return true;
      }
      return false;
    }

    // defensePostNeeded — NationStructureBehavior.ts:229.
    defensePostNeeded() {
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy) return false;
      const landAttacks = this.player
        .incomingAttacks()
        .filter((a) => this.isLandAttack(a));
      if (landAttacks.length === 0) return false;
      const ourTroops = this.player.troops();
      if (ourTroops <= 0) return false;
      const incomingTroops = landAttacks.reduce((sum, a) => sum + a.troops(), 0);
      const ratio = incomingTroops / ourTroops;
      if (isLegendaryDifficulty(difficulty)) {
        return ratio >= LEGENDARY_DEFENSE_POST_THREAT_RATIO;
      }
      return ratio >= UNDER_ATTACK_THREAT_RATIO;
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

    // sampleTilesNearFront — NationStructureBehavior.ts:302.
    // DIVERGENCE: src checks `player.canBuild(unitType, t)` inside the sampler
    // (so a tile only counts toward `count` if buildable). The client canBuild is
    // async, so we drop the in-sampler canBuild check and emit the raw sampled
    // tiles; tryBuildDefensePost probes buildability down the returned list
    // (rank-then-probe). Sampling geometry/RNG and the spread-anchor filtering are
    // otherwise identical. `unitType` is retained in the signature for parity.
    sampleTilesNearFront(frontTiles, count, _unitType) {
      const game = this.game;
      const player = this.player;

      if (frontTiles.length === 0) {
        return [];
      }

      const { borderSpacing } = this.spacingConstants();
      const searchRadius = Math.ceil(borderSpacing * 1.5);
      const minBorderDist = Math.ceil(borderSpacing * 0.75);
      const maxBorderDist = Math.ceil(borderSpacing * 1.5);
      const borderTiles = player.borderTiles();
      const mySid = player.smallID();

      // Spread: prefer front tiles far from existing defense posts so successive
      // posts don't cluster at the same spot along the attack line.
      const spreadRangeSquared = (borderSpacing * 1.5) ** 2;
      const existingDPTiles = player
        .units(UNIT.DefensePost)
        .map((u) => u.tile());

      let anchors;
      if (existingDPTiles.length > 0) {
        anchors = frontTiles.filter(
          (ft) =>
            !existingDPTiles.some(
              (dp) => game.euclideanDistSquared(ft, dp) < spreadRangeSquared,
            ),
        );
        if (anchors.length === 0) anchors = frontTiles;
      } else {
        anchors = frontTiles;
      }

      const result = [];
      for (
        let attempt = 0;
        attempt < count * 6 && result.length < count;
        attempt++
      ) {
        const anchor = this.random.randElement(anchors);
        const ax = game.x(anchor);
        const ay = game.y(anchor);
        const x = this.random.nextInt(ax - searchRadius, ax + searchRadius + 1);
        const y = this.random.nextInt(ay - searchRadius, ay + searchRadius + 1);
        if (!game.isValidCoord(x, y)) continue;
        const t = game.ref(x, y);
        // src: if (game.owner(t) !== player) continue; → smallID compare.
        if (game.ownerID(t) !== mySid) continue;
        const closest = closestTile(game, borderTiles, t);
        const borderDist = closest[1];
        if (borderDist < minBorderDist || borderDist > maxBorderDist) continue;
        // src: if (!player.canBuild(unitType, t)) continue; → moved to probe phase.
        result.push(t);
      }

      if (result.length > 0) return result;

      // Fallback: relax border-depth constraint (territory too small for depth ring)
      const fallback = [];
      for (
        let attempt = 0;
        attempt < count * 4 && fallback.length < count;
        attempt++
      ) {
        const anchor = this.random.randElement(anchors);
        const ax = game.x(anchor);
        const ay = game.y(anchor);
        const x = this.random.nextInt(ax - searchRadius, ax + searchRadius + 1);
        const y = this.random.nextInt(ay - searchRadius, ay + searchRadius + 1);
        if (!game.isValidCoord(x, y)) continue;
        const t = game.ref(x, y);
        if (game.ownerID(t) !== mySid) continue;
        fallback.push(t);
      }

      return fallback;
    }

    // isOnStructureCooldown — NationStructureBehavior.ts:383.
    isOnStructureCooldown() {
      // Only high-starting-gold nations pause
      if (this.lastStructureTick === null || !this.hasHighStartingGold()) {
        return false;
      }
      const requiredGap =
        HIGH_GOLD_STRUCTURE_COOLDOWN_TICKS[this.placementsCount] ?? 0;
      if (requiredGap === 0) {
        return false;
      }
      return this.game.ticks() - this.lastStructureTick < requiredGap;
    }

    // isInPostSaveUpBlockedPhase — NationStructureBehavior.ts:398.
    isInPostSaveUpBlockedPhase() {
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

    // doHandleStructures — NationStructureBehavior.ts:416 (now async).
    async doHandleStructures() {
      this.reachableStationsCache = null;
      const config = this.game.config();
      const citiesDisabled = config.isUnitDisabled(UNIT.City);
      const cityCount = citiesDisabled
        ? Math.max(
            1,
            Math.floor(this.player.numTilesOwned() / TILES_PER_CITY_EQUIVALENT),
          )
        : this.ownedLevels(UNIT.City);
      // sharedWaterComponents → real Set<number>|null from gameApi's cached
      // full-resolution water union-find (core SharedWaterCache predicate).
      this._sharedWaterComponents = shimSharedWaterComponents(
        this.game,
        this.player,
      );
      const hasCoastalTiles = this._sharedWaterComponents !== null;
      const hasOceanPortTiles = this.hasOceanPortTiles();

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
        // DIAG (throttled ~8s by game-tick): is the dominance gate WHY factories do /
        // don't build? share=our map fraction, trigger=factoryRailShare, dominant=gate.
        // If dominant=false at end-game, lower factoryRailShare in core.js DEFAULTS.
        try {
          const t = this.game.ticks();
          if (t - (state._buildDomDiagTick || -999) >= 80) {
            state._buildDomDiagTick = t;
            console.log("[Build] dominance gate", {
              share: share === null ? null : Number(share.toFixed(3)),
              trigger,
              dominant: this._dominant,
            });
          }
        } catch (_e) {
          /* ignore */
        }
      }
      // Publish the dominance flag so OTHER behaviors share one source of truth (e.g.
      // allianceBehavior stops reaching out for far trade-allies once we're dominant,
      // letting betray/conquer close the game). Updated every build-tick.
      state.dominant = this._dominant;

      const missileSilosEnabled = !config.isUnitDisabled(UNIT.MissileSilo);

      // High-starting-gold Hard/Impossible nations build a SAM first. Legendary
      // lets the adaptive planner decide; defense is a guardrail there, not the
      // default opening investment.
      const difficulty = currentDifficulty();
      if (
        this.placementsCount === 0 &&
        isAtLeastHardDifficulty(difficulty) &&
        !isLegendaryDifficulty(difficulty) &&
        !config.isUnitDisabled(UNIT.AtomBomb) &&
        missileSilosEnabled &&
        !config.isUnitDisabled(UNIT.SAMLauncher) &&
        this.hasHighStartingGold() &&
        !this.shouldPrioritizeEconomicGrowth() &&
        (await this.maybeSpawnStructure(UNIT.SAMLauncher))
      ) {
        return true;
      }

      // On crowded maps the first structure is a port (or factory if landlocked).
      if (
        !isLegendaryDifficulty(difficulty) &&
        !citiesDisabled &&
        this.ownedLevels(UNIT.City) === 0 &&
        this.isHighNationDensity()
      ) {
        const preferredFirst =
          hasOceanPortTiles && !config.isUnitDisabled(UNIT.Port)
            ? UNIT.Port
            : UNIT.Factory;
        if (
          !config.isUnitDisabled(preferredFirst) &&
          (await this.maybeSpawnStructure(preferredFirst))
        ) {
          return true;
        }
      }

      const economyGrowthPriority = this.shouldPrioritizeEconomicGrowth();
      if (
        economyGrowthPriority &&
        (await this.maybePrioritizeEconomicGrowth({
          config,
          citiesDisabled,
          cityCount,
          hasCoastalTiles,
          hasOceanPortTiles,
        }))
      ) {
        return true;
      }

      const nukesEnabled =
        !config.isUnitDisabled(UNIT.AtomBomb) ||
        !config.isUnitDisabled(UNIT.HydrogenBomb) ||
        !config.isUnitDisabled(UNIT.MIRV);

      // WIN-FIX: a hostile SAM network defines the silo capacity we need to
      // saturate it. Prefer a silo build/upgrade until our sum of silo levels
      // reaches the largest hostile player's sum of SAM levels.
      if (
        state.settings.winFixes &&
        !isLegendaryDifficulty(difficulty) &&
        !economyGrowthPriority &&
        missileSilosEnabled &&
        nukesEnabled &&
        this.missileSiloParityGap() > 0 &&
        (await this.maybeSpawnStructure(UNIT.MissileSilo))
      ) {
        return true;
      }

      if (isLegendaryDifficulty(difficulty)) {
        return await this.doHandleLegendaryStructures({
          config,
          citiesDisabled,
          cityCount,
          hasCoastalTiles,
          hasOceanPortTiles,
          missileSilosEnabled,
          nukesEnabled,
          economyGrowthPriority,
        });
      }

      // Build order for non-city structures (priority order)
      const buildOrder = [
        UNIT.Port,
        UNIT.Factory,
        UNIT.SAMLauncher,
        UNIT.MissileSilo,
      ];

      for (const structureType of buildOrder) {
        // Skip disabled structure types
        if (config.isUnitDisabled(structureType)) {
          continue;
        }

        // Ports require the canonical open-ocean component. Shared closed
        // lakes remain useful to the broader coastal/trade planner but never
        // authorize a port site.
        if (structureType === UNIT.Port && !hasOceanPortTiles) {
          continue;
        }

        // Skip missile silos and SAM launchers if all nukes are disabled
        if (
          !nukesEnabled &&
          (structureType === UNIT.MissileSilo ||
            structureType === UNIT.SAMLauncher)
        ) {
          continue;
        }

        // Skip SAM launchers if missile silos are disabled
        if (!missileSilosEnabled && structureType === UNIT.SAMLauncher) {
          continue;
        }

        if (
          this.shouldBuildStructure(structureType, cityCount, hasCoastalTiles)
        ) {
          if (await this.maybeSpawnStructure(structureType)) {
            return true;
          }
        }
      }

      if (!citiesDisabled && (await this.maybeSpawnStructure(UNIT.City))) {
        return true;
      }

      return false;
    }

    async maybePrioritizeEconomicGrowth({
      config,
      citiesDisabled,
      cityCount,
      hasCoastalTiles,
      hasOceanPortTiles,
    }) {
      const buildOrder = [...ECONOMIC_STRUCTURE_TYPES];
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
        if (await this.maybeSpawnStructure(structureType)) return true;
      }
      return false;
    }

    async maybeSpawnHostileSiloSam() {
      if (!this.shouldBuildHostileSiloSam()) return false;
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
        forceNewStructure: true,
        prioritizeStructureCoverage: true,
        probeLimit: HOSTILE_SILO_SAM_PROBE_LIMIT,
        probeTimeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        parallelProbeCount: HOSTILE_SILO_SAM_PROBE_LIMIT,
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
      try {
        return (this.player.units(UNIT.SAMLauncher) || []).some(
          (sam) =>
            sam &&
            typeof sam.isUnderConstruction === "function" &&
            sam.isUnderConstruction(),
        );
      } catch (_error) {
        return false;
      }
    }

    hostileSiloSamActionBlocked() {
      return (
        this.hostileSiloSamRetryActive() || this.hasOwnSamUnderConstruction()
      );
    }

    hostileSiloSamCurrentTick() {
      try {
        if (typeof this.game?.ticks !== "function") return null;
        const tick = this.game.ticks();
        return tick === null || tick === undefined ? null : tick;
      } catch (_error) {
        return null;
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

      if (
        state.settings.winFixes &&
        (await this.maybeUpgradeHydrogenProtectionSam())
      ) {
        return true;
      }

      if (await this.maybeSpawnHostileSiloSam()) return true;
      if (await this.maybeUpgradeSamForSiloParity()) {
        return true;
      }
      if (
        nukesEnabled &&
        !config.isUnitDisabled(UNIT.SAMLauncher) &&
        this.samLevelParityGap() > 0 &&
        (!this.shouldBuildHostileSiloSam() ||
          !this.hostileSiloSamActionBlocked()) &&
        (await this.maybeSpawnStructure(
          UNIT.SAMLauncher,
          this.shouldBuildHostileSiloSam()
            ? this.hostileSiloSamPlacementOptions()
            : {},
        ))
      ) {
        return true;
      }

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
      const ranked = rankLegendaryConstructionCandidates(candidates, {
        gold: this.player.gold(),
        reserve: this.legendaryReserveGold(),
      });

      const rankedGroups = economyGrowthPriority
        ? [
            ranked.filter((candidate) =>
              ECONOMIC_STRUCTURE_TYPES.includes(candidate.type),
            ),
            ranked.filter(
              (candidate) => !ECONOMIC_STRUCTURE_TYPES.includes(candidate.type),
            ),
          ]
        : [ranked];

      for (const group of rankedGroups) {
        for (const candidate of group) {
          if (await this.maybeSpawnStructure(candidate.type)) {
            return true;
          }
        }
      }
      return false;
    }

    legendaryReserveGold() {
      if (!state.settings.winFixes || !state.nukeReserveGold) return 0n;
      try {
        const reserve = BigInt(state.nukeReserveGold || 0);
        return reserve >= 15_000_000n ? reserve : 0n;
      } catch (_error) {
        return 0n;
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
      try {
        for (const other of this.game.players()) {
          if (
            !other ||
            (typeof other.isPlayer === "function" && !other.isPlayer()) ||
            other.smallID() === mySid
          ) {
            continue;
          }
          let friendly = false;
          try {
            friendly =
              this.player.isFriendly(other) ||
              this.player.isOnSameTeam(other);
          } catch (_error) {
            friendly = false;
          }
          if (friendly) continue;
          hostile.push(other);
        }
      } catch (_error) {
        return hostile;
      }
      return hostile;
    }

    liveHostilePlayers() {
      if (
        !this.player ||
        !this.game ||
        typeof this.game.players !== "function"
      ) {
        return null;
      }

      let snapshotTick = null;
      try {
        if (typeof this.game.ticks === "function") {
          snapshotTick = this.game.ticks();
        }
      } catch (_error) {
        snapshotTick = null;
      }
      if (
        snapshotTick !== null &&
        this._hostilePlayersSnapshotTick === snapshotTick &&
        Array.isArray(this._hostilePlayersSnapshot)
      ) {
        return this._hostilePlayersSnapshot;
      }

      let players;
      try {
        players = this.game.players();
      } catch (_error) {
        return null;
      }
      if (!Array.isArray(players)) return null;

      let mySid = null;
      try {
        mySid = this.player.smallID();
      } catch (_error) {
        /* use object identity below when the id is unavailable */
      }

      const hostile = [];
      for (const other of players) {
        if (!other || other === this.player) continue;
        if (
          typeof other.isPlayer === "function" &&
          !other.isPlayer()
        ) {
          continue;
        }
        try {
          if (mySid !== null && other.smallID() === mySid) continue;
        } catch (_error) {
          /* use object identity when the snapshot has no readable id */
        }
        try {
          if (typeof other.isAlive === "function" && !other.isAlive()) {
            continue;
          }
        } catch (_error) {
          continue;
        }

        let friendly;
        try {
          friendly =
            this.player.isFriendly(other) ||
            this.player.isOnSameTeam(other);
        } catch (_error) {
          // Do not spend as if a player were hostile when the relation snapshot
          // is incomplete; wait for the next authoritative player view instead.
          continue;
        }
        if (!friendly) hostile.push(other);
      }
      if (snapshotTick !== null) {
        this._hostilePlayersSnapshotTick = snapshotTick;
        this._hostilePlayersSnapshot = hostile;
      }
      return hostile;
    }

    playerGoldBigInt(player) {
      if (!player || typeof player.gold !== "function") return null;
      try {
        return BigInt(player.gold());
      } catch (_error) {
        return null;
      }
    }

    // A silo/SAM level is also the number of missiles it can have in its
    // cooldown queue. Keep the defensive capacity calculation aligned with
    // that engine mechanic: built active units contribute their level and a
    // unit under construction contributes one projected slot.
    playerUnitCapacitySummary(player, type) {
      if (!player || typeof player.units !== "function") return null;
      let units;
      try {
        units = player.units(type);
      } catch (_error) {
        return null;
      }
      if (!Array.isArray(units)) return null;

      let count = 0;
      let capacity = 0;
      let builtCount = 0;
      for (const unit of units) {
        if (!unit) continue;
        try {
          const underConstruction =
            typeof unit.isUnderConstruction === "function" &&
            unit.isUnderConstruction();
          if (underConstruction) {
            count++;
            capacity++;
            continue;
          }
          if (
            typeof unit.isActive === "function" &&
            unit.isActive() === false
          ) {
            continue;
          }
          const rawLevel =
            typeof unit.level === "function" ? unit.level() : 1;
          const level = Number(rawLevel ?? 1);
          count++;
          builtCount++;
          capacity += Number.isFinite(level)
            ? Math.max(1, Math.floor(level))
            : 1;
        } catch (_error) {
          // Ignore an incomplete unit snapshot; the next game tick will retry.
        }
      }
      return { count, capacity, builtCount };
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
      let hasActiveHostileMissile = false;
      try {
        const activeMissiles = this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb);
        if (!Array.isArray(activeMissiles)) return cacheSignal(null);
        const mySid = this.player.smallID();
        for (const missile of activeMissiles) {
          if (!missile || missile.isActive?.() === false) continue;
          const owner = missile.owner?.();
          if (!owner || owner.smallID?.() === mySid) continue;
          let friendly = false;
          try {
            friendly =
              this.player.isFriendly(owner) || this.player.isOnSameTeam(owner);
          } catch (_error) {
            friendly = false;
          }
          if (!friendly) {
            hasActiveHostileMissile = true;
            break;
          }
        }
      } catch (_error) {
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

    hasHostileReachedSiloGoldThreshold() {
      const snapshot = this.hostileThreatSnapshot();
      return snapshot === null ? null : snapshot.reachedSiloGoldThreshold;
    }

    hasHostileSiloThreat() {
      const snapshot = this.hostileThreatSnapshot();
      return snapshot === null ? null : snapshot.siloThreat;
    }

    hostileThreatSnapshot() {
      let snapshotTick = null;
      try {
        if (typeof this.game?.ticks === "function") {
          snapshotTick = this.game.ticks();
        }
      } catch (_error) {
        snapshotTick = null;
      }
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
      let reachedSiloGoldThreshold = false;
      let siloThreat =
        siloSummary !== null && siloSummary.builtHostileSiloCount > 0;
      for (const other of hostile) {
        const gold = this.playerGoldBigInt(other);
        if (gold !== null && gold >= HOSTILE_SILO_GOLD_THRESHOLD) {
          reachedSiloGoldThreshold = true;
        }
        if (gold !== null && gold >= HOSTILE_SAM_TRIGGER_GOLD_THRESHOLD) {
          siloThreat = true;
        }
      }
      const snapshot = {
        reachedSiloGoldThreshold,
        siloThreat,
        hostileSiloCount: siloSummary?.hostileSiloCount ?? 0,
        hostileSiloCapacity: siloSummary?.hostileSiloCapacity ?? 0,
      };
      if (snapshotTick !== null) {
        this._hostileThreatSnapshotTick = snapshotTick;
        this._hostileThreatSnapshot = snapshot;
      }
      return snapshot;
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

      // Match both dimensions of the hostile network. Each silo is an
      // independent launch origin that may require a separate point-defense
      // site, while each level contributes one missile/interceptor slot.
      if (siloSummary.hostileSiloCount > ownSam.count) {
        return true;
      }

      // Keep the existing anticipatory response when a hostile nation can
      // already afford a silo but has not placed one yet. It is only one SAM
      // until a real silo appears, so it cannot snowball on gold alone.
      return (
        siloSummary.hostileSiloCount === 0 &&
        threat.siloThreat === true &&
        ownSam.count === 0
      );
    }

    shouldPrioritizeEconomicGrowth() {
      if (!state.settings.winFixes) return false;
      return this.hasHostileReachedSiloGoldThreshold() === false;
    }

    legendaryFriendlyPlayers() {
      const mySid = this.player.smallID();
      const friendly = [];
      try {
        for (const other of this.game.players()) {
          if (
            !other ||
            (typeof other.isPlayer === "function" && !other.isPlayer()) ||
            other.smallID() === mySid
          ) {
            continue;
          }
          let isFriendly = false;
          try {
            isFriendly =
              this.player.isFriendly(other) || this.player.isOnSameTeam(other);
          } catch (_error) {
            isFriendly = false;
          }
          if (isFriendly && other.isAlive() !== false) friendly.push(other);
        }
      } catch (_error) {
        return friendly;
      }
      return friendly;
    }

    legendaryProductionMetrics(player) {
      let troops = 0;
      let gold = 0n;
      let goldProduction = 0;
      const tiles = [];
      const samUnits = [];
      try {
        troops = Math.max(0, Number(player.troops() || 0));
        gold = BigInt(player.gold() || 0n);
        for (const unit of player.units(UNIT.City, UNIT.Factory, UNIT.Port)) {
          const tile = unit.tile();
          if (tile !== null && tile !== undefined) tiles.push(tile);
          const connected =
            typeof unit.hasTrainStation === "function" && unit.hasTrainStation();
          if (connected) {
            if (unit.type() === UNIT.City) {
              goldProduction += this.trainGoldBase("ally", 1);
            } else {
              // Factories create rail and ports consume it; both are productive
              // enablers, but neither has the City's direct diminishing-return
              // trade payout.
              goldProduction += this.trainGoldBase("ally", 1) * 0.25;
            }
          }
        }
        for (const sam of player.units(UNIT.SAMLauncher)) {
          if (sam.isUnderConstruction()) continue;
          samUnits.push(sam);
          const tile = sam.tile();
          if (tile !== null && tile !== undefined) tiles.push(tile);
        }
      } catch (_error) {
        /* keep the partial metrics available to the placement scorer */
      }
      return { troops, gold, goldProduction, tiles, samUnits };
    }

    legendaryAllyPlacementContext() {
      const own = this.legendaryProductionMetrics(this.player);
      let supportRadius = 100;
      try {
        supportRadius = Math.max(
          1,
          Number(this.game.config().trainStationMaxRange()),
        );
      } catch (_error) {
        /* keep the geometry fallback */
      }

      const allies = [];
      for (const ally of this.legendaryFriendlyPlayers()) {
        const metrics = this.legendaryProductionMetrics(ally);
        let location = null;
        try {
          location = ally.nameLocation();
        } catch (_error) {
          location = null;
        }
        allies.push({
          player: ally,
          ...metrics,
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
      return { own, allies, supportRadius };
    }

    legendaryTeamCenterPlacementContext() {
      const participants = [this.player, ...this.legendaryFriendlyPlayers()];
      const points = [];
      const addPoint = (tile) => {
        if (tile === null || tile === undefined) return;
        points.push({ x: this.game.x(tile), y: this.game.y(tile) });
      };

      for (const participant of participants) {
        let border = null;
        try {
          border = participant.borderTiles();
        } catch (_error) {
          border = null;
        }
        if (border && border.size > 0) {
          // Keep the geometric territory signal bounded on very large maps. The
          // stride preserves the full perimeter shape while avoiding a full
          // border scan for every candidate tile in a build tick.
          const stride = Math.max(1, Math.ceil(border.size / 2000));
          let index = 0;
          for (const tile of border) {
            if (index++ % stride === 0) addPoint(tile);
          }
        } else {
          try {
            for (const unit of participant.units(
              UNIT.City,
              UNIT.Factory,
              UNIT.Port,
              UNIT.SAMLauncher,
            )) {
              addPoint(unit.tile());
            }
          } catch (_error) {
            /* nameLocation below remains a usable center proxy */
          }
          try {
            const location = participant.nameLocation();
            if (location && Number.isFinite(location.x) && Number.isFinite(location.y)) {
              points.push({ x: Number(location.x), y: Number(location.y) });
            }
          } catch (_error) {
            /* no location in the harness */
          }
        }
      }

      if (points.length === 0) return null;
      const center = points.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 },
      );
      center.x /= points.length;
      center.y /= points.length;

      let centerTile = null;
      try {
        const x = Math.round(center.x);
        const y = Math.round(center.y);
        if (this.game.isValidCoord(x, y)) centerTile = this.game.ref(x, y);
      } catch (_error) {
        centerTile = null;
      }

      let nearestBorder = null;
      let nearestBorderDistanceSquared = Infinity;
      try {
        for (const tile of this.player.borderTiles()) {
          const dx = this.game.x(tile) - center.x;
          const dy = this.game.y(tile) - center.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < nearestBorderDistanceSquared) {
            nearestBorderDistanceSquared = distanceSquared;
            nearestBorder = tile;
          }
        }
      } catch (_error) {
        /* no own border snapshot */
      }

      return {
        x: center.x,
        y: center.y,
        tile: centerTile,
        nearestBorder,
        nearestBorderDistanceSquared,
      };
    }

    legendaryAllySupportPlacementScore(tile, type, context = null) {
      if (type !== UNIT.City && type !== UNIT.Factory && type !== UNIT.Port) {
        return 0;
      }
      const placement = context || this.legendaryAllyPlacementContext();
      if (!placement || placement.allies.length === 0) return 0;
      const spacing = this.spacingConstants().structureSpacing;
      const supportScores = [];
      let samConfig = null;
      try {
        samConfig = this.game.config();
      } catch (_error) {
        samConfig = null;
      }

      for (const ally of placement.allies) {
        let nearestDistanceSquared = Infinity;
        for (const allyTile of ally.tiles) {
          nearestDistanceSquared = Math.min(
            nearestDistanceSquared,
            this.game.euclideanDistSquared(tile, allyTile),
          );
        }
        if (
          !Number.isFinite(nearestDistanceSquared) &&
          ally.location &&
          Number.isFinite(ally.location.x) &&
          Number.isFinite(ally.location.y)
        ) {
          const dx = this.game.x(tile) - Number(ally.location.x);
          const dy = this.game.y(tile) - Number(ally.location.y);
          nearestDistanceSquared = dx * dx + dy * dy;
        }
        const nearestDistance = Number.isFinite(nearestDistanceSquared)
          ? Math.sqrt(nearestDistanceSquared)
          : Infinity;
        const proximity = Number.isFinite(nearestDistance)
          ? legendaryPlacementProximityScore(
              nearestDistance,
              placement.supportRadius,
            )
          : 0;

        let samSupport = 0;
        if (samConfig) {
          for (const sam of ally.samUnits) {
            const level = Math.max(1, Number(sam.level() || 1));
            const range = Number(samConfig.samRange(level));
            if (range <= 0) continue;
            const distance = Math.sqrt(
              this.game.euclideanDistSquared(tile, sam.tile()),
            );
            if (distance > range) continue;
            samSupport = Math.max(
              samSupport,
              level * legendaryPlacementProximityScore(distance, range),
            );
          }
        }

        // A strong nearby ally and a high-level nearby SAM are independent
        // support signals; either one can make a production site valuable.
        supportScores.push(ally.power * proximity + samSupport);
      }

      supportScores.sort((a, b) => b - a);
      const combined = Math.min(
        5,
        (supportScores[0] || 0) + 0.35 * (supportScores[1] || 0),
      );
      return spacing * combined;
    }

    legendaryTeamCenterPlacementScore(tile, context = null) {
      const center = context || this.legendaryTeamCenterPlacementContext();
      if (!center) return 0;
      const spacing = this.spacingConstants().structureSpacing;
      let centerDistance = Infinity;
      try {
        const dx = this.game.x(tile) - center.x;
        const dy = this.game.y(tile) - center.y;
        centerDistance = Math.sqrt(dx * dx + dy * dy);
      } catch (_error) {
        return 0;
      }

      let borderDistance = Infinity;
      if (center.nearestBorder !== null) {
        borderDistance = Math.sqrt(
          this.game.euclideanDistSquared(tile, center.nearestBorder),
        );
      }
      let radius = spacing;
      try {
        radius = Math.max(radius, Number(this.game.config().trainStationMaxRange()));
      } catch (_error) {
        /* keep spacing radius */
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
        try {
          if (enemy.isAlive && enemy.isAlive() === false) continue;
          const levels = [];
          for (const unit of enemy.units(type) || []) {
            if (unit.isUnderConstruction && unit.isUnderConstruction()) {
              levels.push(1);
              continue;
            }
            if (unit.isActive && unit.isActive() === false) continue;
            const level = Number(unit.level?.() ?? 1);
            if (Number.isFinite(level)) {
              levels.push(Math.max(1, Math.floor(level)));
            }
          }
          if (levels.length > 0) enemyUnitLevels.push(levels);
        } catch (_error) {
          /* skip an incomplete enemy snapshot */
        }
      }
      return maxCapacity(enemyUnitLevels);
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
        try {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) continue;
          if (sam.isActive && sam.isActive() === false) continue;
          const level = Number(sam.level?.() ?? 1);
          if (Number.isFinite(level)) {
            maximum = Math.max(maximum, Math.max(1, Math.floor(level)));
          }
        } catch (_error) {
          /* skip an incomplete own SAM snapshot */
        }
      }
      return maximum;
    }

    samLevelParityTarget() {
      return state.settings.winFixes
        ? this.enemyMissileSiloCapacityTarget()
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
        let levelSum = 0;
        try {
          if (enemy.isAlive && enemy.isAlive() === false) continue;
          for (const silo of enemy.units(UNIT.MissileSilo) || []) {
            if (silo.isUnderConstruction && silo.isUnderConstruction()) {
              continue;
            }
            if (silo.isActive && silo.isActive() === false) continue;
            const level = Number(silo.level?.() ?? 1);
            if (!Number.isFinite(level)) continue;
            levelSum += Math.max(1, Math.floor(level));
          }
        } catch (_error) {
          // Ignore an incomplete hostile snapshot and continue with the next
          // player; a malformed player must not disable local SAM protection.
          continue;
        }

        maximum = Math.max(maximum, levelSum);
      }
      return maximum;
    }

    hostileSiloLevelSumAtLeast(
      threshold = HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD,
    ) {
      return this.hostileSiloLevelSumTarget() >= threshold;
    }

    shouldPrioritizeHydrogenSamProtection() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return false;
      }
      try {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
        if (this.game.config().isUnitDisabled(UNIT.HydrogenBomb)) return false;
      } catch (_error) {
        // Keep the threat gate active when an older client lacks one of the
        // optional disabled-unit checks.
      }
      return (
        this.hostileSiloLevelSumTarget() >=
        HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD
      );
    }

    /**
     * Find the SAM upgrade that makes our highest built SAM reach the largest
     * hostile built-silo level sum. This is deliberately a capacity-level
     * rule: it avoids scanning border tiles or buildings on every build tick,
     * and it matches the game's one-SAM-vs-total-hostile-silo requirement.
     */
    hydrogenSamProtectionPlan() {
      if (!this.shouldPrioritizeHydrogenSamProtection()) return null;

      const targetLevel = this.hostileSiloLevelSumTarget();
      const sams = (this.player.units(UNIT.SAMLauncher) || []).filter((sam) => {
        try {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) return false;
          return !sam.isActive || sam.isActive() !== false;
        } catch (_error) {
          return false;
        }
      });
      if (targetLevel < HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD || sams.length === 0) {
        return null;
      }

      const candidates = [];
      for (const sam of sams) {
        const currentLevel = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
        if (
          Number.isFinite(currentLevel) &&
          currentLevel < HYDROGEN_SAM_MAX_UPGRADE_LEVEL
        ) {
          candidates.push({ sam, currentLevel });
        }
      }
      if (candidates.length === 0) return null;

      candidates.sort((left, right) => right.currentLevel - left.currentLevel);
      const selected = candidates[0];
      return {
        sam: selected.sam,
        currentLevel: selected.currentLevel,
        targetLevel,
      };
    }

    hydrogenStructureCoveragePlan() {
      if (
        !state.settings.winFixes ||
        !autoBotBuildAllowed(UNIT.SAMLauncher) ||
        this.hostileSiloLevelSumTarget() <
          HYDROGEN_SAM_SILO_LEVEL_SUM_THRESHOLD
      ) {
        return null;
      }

      let config;
      try {
        config = this.game.config();
        if (config.isUnitDisabled(UNIT.SAMLauncher)) return null;
        if (config.isUnitDisabled(UNIT.HydrogenBomb)) return null;
      } catch (_error) {
        return null;
      }
      if (!config || typeof config.samRange !== "function") return null;

      const structures = [];
      for (const type of STRUCTURES_TYPES) {
        try {
          for (const structure of this.player.units(type) || []) {
            const tile = structure.tile();
            if (tile !== null && tile !== undefined) structures.push(tile);
          }
        } catch (_error) {
          /* skip an incomplete structure snapshot */
        }
      }
      if (structures.length === 0) return null;

      const sams = (this.player.units(UNIT.SAMLauncher) || []).filter((sam) => {
        try {
          if (sam.isUnderConstruction && sam.isUnderConstruction()) return false;
          return !sam.isActive || sam.isActive() !== false;
        } catch (_error) {
          return false;
        }
      });
      if (sams.length === 0) return { needsNewSam: true };

      const rangeSquared = (level) => {
        try {
          const range = Number(config.samRange(level));
          return Number.isFinite(range) && range > 0 ? range * range : 0;
        } catch (_error) {
          return 0;
        }
      };
      const coveredCount = (sam, level) => {
        let count = 0;
        let samTile;
        try {
          samTile = sam.tile();
        } catch (_error) {
          return 0;
        }
        for (const structureTile of structures) {
          try {
            if (
              this.game.euclideanDistSquared(samTile, structureTile) <=
              rangeSquared(level)
            ) {
              count++;
            }
          } catch (_error) {
            /* leave this structure uncovered */
          }
        }
        return count;
      };

      for (const sam of sams) {
        const level = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
        if (Number.isFinite(level) && coveredCount(sam, level) === structures.length) {
          return null;
        }
      }

      let completePlan = null;
      for (const sam of sams) {
        const currentLevel = Math.max(1, Math.floor(Number(sam.level?.() ?? 1)));
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
          const covered = coveredCount(sam, targetLevel);
          const candidate = {
            sam,
            currentLevel,
            targetLevel,
            coveredPoints: covered,
            totalPoints: structures.length,
            complete: covered === structures.length,
          };
          if (candidate.complete) {
            if (
              completePlan === null ||
              targetLevel < completePlan.targetLevel ||
              (targetLevel === completePlan.targetLevel &&
                currentLevel > completePlan.currentLevel)
            ) {
              completePlan = candidate;
            }
            break;
          }
        }
      }
      // If no existing SAM can cover every structure even at the maximum
      // level, the higher-priority action is to place another SAM rather than
      // spend on a partial upgrade that still leaves the requirement unmet.
      return completePlan || { needsNewSam: true };
    }

    legendaryRailMetrics(cities, ports, factories) {
      let reachableStations = [];
      try {
        reachableStations = this.getOrBuildReachableStations();
      } catch (_error) {
        reachableStations = [];
      }

      let connectedCities = 0;
      let connectedPorts = 0;
      try {
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
      } catch (_error) {
        connectedCities = 0;
        connectedPorts = 0;
      }

      const stationDemand = cities.length + ports.length;
      const railNeed = Math.min(
        2.5,
        Math.max(0.25, (stationDemand + 1) / (factories.length + 1)),
      );
      const connectedStations = connectedCities + connectedPorts;
      const cityRailConnection =
        connectedStations > 0
          ? 1
          : factories.length > 0
            ? 0.75
            : 0.25;
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
      try {
        samRange = (sam) => this.game.config().samRange(sam.level());
      } catch (_error) {
        samRange = () => 0;
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
        let targetValue = 0.25;
        try {
          const goldRatio = Number(enemy.gold()) / Math.max(1, ownGold);
          const troopRatio =
            this.game.config().maxTroops(enemy) / ownMaxTroops;
          const attackCapacity =
            enemy.units(UNIT.MissileSilo).length +
            enemy.units(UNIT.Warship).length / 2;
          const defenseCapacity =
            enemy.units(UNIT.SAMLauncher).length +
            enemy.units(UNIT.Warship).length / 2;
          const structureCapacity =
            enemy.units(UNIT.City).length +
            enemy.units(UNIT.Factory).length +
            enemy.units(UNIT.Port).length;
          targetValue = Math.max(
            goldRatio,
            troopRatio,
            attackCapacity / 3,
            defenseCapacity / 3,
            structureCapacity / 5,
          );
        } catch (_error) {
          /* keep the conservative baseline */
        }
        strongestTarget = Math.max(
          strongestTarget,
          Math.min(2.5, 0.75 + targetValue),
        );
      }
      return strongestTarget;
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
      let speed = 1;
      try {
        speed = Math.max(1, Number(this.game.config().defaultNukeSpeed()));
      } catch (_error) {
        /* use the conservative one-tile-per-tick fallback */
      }

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

      try {
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
      } catch (_error) {
        /* fall through to the geometry fallback */
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
      try {
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
      } catch (_error) {
        /* use the endpoints when the map geometry is unavailable */
      }
      if (path[path.length - 1] !== targetTile) path.push(targetTile);
      this._missileFlightPathCache.set(cacheKey, path);
      return path;
    }

    legendaryNukeFlightTime(fromTile, targetTile) {
      const path = this.legendaryNukeFlightPath(fromTile, targetTile);
      if (path.length > 2) return path.length;
      let speed = 1;
      try {
        speed = Math.max(1, Number(this.game.config().defaultNukeSpeed()));
      } catch (_error) {
        /* use the conservative one-tile-per-tick fallback */
      }
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
          try {
            friendly =
              this.player.isFriendly(owner) || this.player.isOnSameTeam(owner);
          } catch (_error) {
            friendly = false;
          }
        }
        if (!friendly) return;
        if (id !== null && id !== undefined) seen.add(id);
        sams.push(sam);
      };

      try {
        for (const sam of this.game.units(UNIT.SAMLauncher)) add(sam);
      } catch (_error) {
        /* fallback below */
      }
      if (sams.length === 0) {
        for (const participant of [
          this.player,
          ...this.legendaryFriendlyPlayers(),
        ]) {
          try {
            for (const sam of participant.units(UNIT.SAMLauncher)) add(sam);
          } catch (_error) {
            /* skip a participant whose unit snapshot is unavailable */
          }
        }
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
      try {
        const cooldown = Number(this.game.config().SAMCooldown());
        return Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 90;
      } catch (_error) {
        return 90;
      }
    }

    legendarySiloCooldownTicks() {
      try {
        const cooldown = Number(this.game.config().SiloCooldown());
        return Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 90;
      } catch (_error) {
        return 90;
      }
    }

    // Returns the relative tick at which each enemy silo slot can launch.
    // The engine reloads only the queue front once per execution tick, so
    // already-expired entries are spaced by one tick instead of all becoming
    // available at the same instant.
    legendarySiloSlotAvailability(silo) {
      if (!silo || silo.isUnderConstruction?.()) return [];
      const rawLevel = Number(silo.level?.() ?? 1);
      const level = Number.isFinite(rawLevel)
        ? Math.max(1, Math.floor(rawLevel))
        : 1;
      let queue = [];
      try {
        const rawQueue = silo.missileTimerQueue?.();
        queue = Array.isArray(rawQueue)
          ? rawQueue.slice(0, level).map(Number)
          : [];
      } catch (_error) {
        queue = [];
      }
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

    // Mirrors PlayerImpl.nukeSpawn's repeated closest-eligible-silo selection
    // over a future launch sequence. It consumes current ready slots first,
    // waits for the real SiloCooldown when every slot is queued, and then
    // continues one launch per simulation tick so chained enemy intents remain
    // difficult for the SAM scheduler rather than being collapsed into one
    // aggregate capacity number.
    legendaryEnemyMissileLaunchPlan(enemySilos, targetTile, shotCount) {
      const entries = (Array.isArray(enemySilos) ? enemySilos : [])
        .filter((silo) => {
          try {
            return (
              silo &&
              !silo.isUnderConstruction?.() &&
              (!silo.isActive || silo.isActive() !== false)
            );
          } catch (_error) {
            return false;
          }
        })
        .map((silo) => ({
          silo,
          distance: this.game.manhattanDist(silo.tile(), targetTile),
          flightTicks: this.legendaryNukeFlightTime(
            silo.tile(),
            targetTile,
          ),
          slots: this.legendarySiloSlotAvailability(silo),
        }));
      const launches = [];
      const cooldown = this.legendarySiloCooldownTicks();
      let nextLaunchTick = 0;
      const total = Math.max(0, Math.floor(Number(shotCount) || 0));

      for (let index = 0; index < total; index++) {
        let launchTick = nextLaunchTick;
        let available = entries.filter((entry) =>
          entry.slots.some((tick) => tick <= launchTick),
        );
        if (available.length === 0) {
          const nextReadyTick = Math.min(
            ...entries.flatMap((entry) => entry.slots),
          );
          if (!Number.isFinite(nextReadyTick)) break;
          launchTick = Math.max(launchTick, nextReadyTick);
          available = entries.filter((entry) =>
            entry.slots.some((tick) => tick <= launchTick),
          );
        }
        if (available.length === 0) break;
        available.sort(
          (left, right) =>
            left.distance - right.distance ||
            Number(left.silo.id?.() ?? 0) - Number(right.silo.id?.() ?? 0),
        );
        const selected = available[0];
        const slotIndex = selected.slots.findIndex(
          (tick) => tick <= launchTick,
        );
        if (slotIndex < 0) break;
        selected.slots[slotIndex] = launchTick + cooldown;
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
      const rawCurrentLevel = Number(sam.level() ?? 1);
      const currentLevel = Number.isFinite(rawCurrentLevel)
        ? Math.max(1, Math.floor(rawCurrentLevel))
        : 1;
      const rawTargetLevel = Number(levelOverride ?? currentLevel);
      const targetLevel = Number.isFinite(rawTargetLevel)
        ? Math.max(currentLevel, Math.floor(rawTargetLevel))
        : currentLevel;
      let queue = [];
      try {
        const rawQueue = sam.missileTimerQueue();
        // The live queue cannot contain more than the current level's slots.
        // An upgrade's extra queue entry is hypothetical here and is added
        // below with its correct initial reload time.
        queue = Array.isArray(rawQueue)
          ? rawQueue.slice(0, currentLevel)
          : [];
      } catch (_error) {
        queue = [];
      }
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
      try {
        const duration = Number(
          this.game.config().unitInfo(type).constructionDuration,
        );
        if (Number.isFinite(duration) && duration >= 0) return duration;
      } catch (_error) {
        /* use the engine defaults below */
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
        profiles.push({
          id,
          tile: sam.tile(),
          level: Math.max(1, Number(override ?? sam.level() ?? 1)),
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
          availableTicks,
          cooldownTicks: this.legendarySamCooldownTicks(),
        });
      }
      return profiles;
    }

    legendaryTrajectoryTileTargetable(pathTile, fromTile, targetTile) {
      try {
        const targetableRange = Number(
          this.game.config().defaultNukeTargetableRange(),
        );
        if (targetableRange <= 0) return true;
        const rangeSquared = targetableRange * targetableRange;
        return (
          this.game.euclideanDistSquared(pathTile, fromTile) <= rangeSquared ||
          this.game.euclideanDistSquared(pathTile, targetTile) <= rangeSquared
        );
      } catch (_error) {
        return true;
      }
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
      let level = Math.max(
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
      if (
        samOrTile === null ||
        samOrTile === undefined ||
        !Array.isArray(path) ||
        path.length === 0
      ) {
        return [];
      }
      const samTile =
        typeof samOrTile.tile === "function"
          ? samOrTile.tile()
          : samOrTile.tile ?? samOrTile;
      if (samTile === null || samTile === undefined) return [];
      const level = Math.max(
        1,
        Number(
          levelOverride ??
            (typeof samOrTile.level === "function"
              ? samOrTile.level()
              : samOrTile.level ?? 1),
        ),
      );
      let range = 0;
      try {
        range = Number(this.game.config().samRange(level));
      } catch (_error) {
        return [];
      }
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

    legendarySamPathInterceptTicks(
      samOrTile,
      path,
      fromTile,
      targetTile,
      levelOverride = null,
      launchOffset = 0,
    ) {
      return this.legendarySamPathCoverageIndices(
        samOrTile,
        path,
        fromTile,
        targetTile,
        levelOverride,
      ).map((index) => Math.max(0, Number(launchOffset) || 0) + index);
    }

    legendaryBuildMissileRoute(
      fromTile,
      targetTile,
      impactTick,
      samProfiles,
      launchOffset = 0,
      weapon = null,
      id = null,
      pathOverride = null,
      coverageIndexCache = null,
    ) {
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
          this.legendaryBuildMissileRoute(
            route.fromTile,
            route.targetTile,
            route.impactTick,
            samProfiles,
            route.launchOffset ?? 0,
            route.weapon ?? null,
            route.id ?? null,
            route.path,
            coverageIndexCache,
          ),
        );
      }
      return rebuilt;
    }

    // The client keeps exact server motion plans for active nukes. Prefer that
    // path over rebuilding a new parabola from the nuke's current tile: the
    // latter loses the original launch arc and can move a near-impact window
    // across the five-tick safety boundary.
    legendaryActiveMissileMotion(nuke, fromTile, targetTile) {
      try {
        const id = typeof nuke?.id === "function" ? nuke.id() : null;
        const plans = this.game.motionPlans?.();
        const plan = id === null || !plans ? null : plans.get(id);
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
      } catch (_error) {
        return null;
      }
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
      let route = null;
      if (threat.inFlight) {
        const fromTile =
          threat.nuke && typeof threat.nuke.tile === "function"
            ? threat.nuke.tile()
            : null;
        const targetTile = threat.targetTile;
        if (fromTile === null || targetTile === null || targetTile === undefined) {
          return null;
        }
        const motion = this.legendaryActiveMissileMotion(
          threat.nuke,
          fromTile,
          targetTile,
        );
        const impactTick =
          motion?.impactTick ?? this.legendaryNukeFlightTime(fromTile, targetTile);
        route = this.legendaryBuildMissileRoute(
          motion?.fromTile ?? fromTile,
          targetTile,
          impactTick,
          samProfiles,
          0,
          threat.weapon,
          `active:${String(threat.weapon)}:${String(impactTick)}`,
          motion?.path ?? null,
        );
        return {
          routes: route ? [route] : [],
          samProfiles,
          forecastComplete: true,
        };
      } else {
        const cachedRoutes = threat.salvoPlan?.routes;
        const rebuiltRoutes = this.legendaryRebuildMissileRoutes(
          cachedRoutes,
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
          threat.enemySilos || [],
          threat.enemyGold ?? 0n,
          threat.targetTile,
          threat.atomCost ?? this.cost(UNIT.AtomBomb),
          threat.hydrogenCost ?? this.cost(UNIT.HydrogenBomb),
          {
            levelOverrides,
            extraSam,
            actionCompletionTick: completionTick,
            samProfilesOverride: samProfiles,
          },
        );
        return {
          routes: plan.routes || [],
          samProfiles: plan.samProfiles || samProfiles,
          forecastComplete: plan.forecastComplete !== false,
        };
      }
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
      const hasLevelOverrides =
        levelOverrides && typeof levelOverrides.size === "number"
          ? levelOverrides.size > 0
          : Boolean(levelOverrides);
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
      const samProfiles = this.legendaryFriendlySamProfiles(
        options.levelOverrides ?? null,
        options.extraSam ?? null,
      );
      const routes = [];
      const groups = [];
      for (let threatIndex = 0; threatIndex < context.threats.length; threatIndex++) {
        const threat = context.threats[threatIndex];
        const hasLevelOverrides =
          options.levelOverrides &&
          typeof options.levelOverrides.size === "number"
            ? options.levelOverrides.size > 0
            : Boolean(options.levelOverrides);
        const canReuseRoutes =
          !hasLevelOverrides &&
          !options.extraSam &&
          Number(options.completionTick ?? 0) === 0 &&
          Array.isArray(threat?.salvoPlan?.routes);
        const plan = canReuseRoutes
          ? {
              routes: threat.salvoPlan.routes,
              samProfiles,
              forecastComplete: threat.salvoPlan.forecastComplete !== false,
            }
          : this.legendaryThreatDefensePlan(threat, {
              ...options,
              samProfilesOverride: samProfiles,
            });
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
      const schedules = groups.map((group) => {
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
        const schedule = {
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
          uninterceptedCount: missiles.filter(
            (missile) => !missile.intercepted,
          ).length,
          minimumInterceptMarginTicks: missiles.length
            ? Math.min(...missiles.map((missile) => missile.marginTicks))
            : Infinity,
          threat: group.threat,
        };
        return schedule;
      });
      if (schedules.length === 0) {
        return {
          hasThreats: false,
          fullyDefended: true,
          completionMarginTicks: Infinity,
          minimumInterceptMarginTicks: Infinity,
          firstImpactTick: Infinity,
          uninterceptedCount: 0,
          schedules,
          globalSchedule,
        };
      }
      return {
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
        const threat = schedule.threat;
        if (!schedule || schedule.fullyDefended) continue;
        if (!threat) continue;
        const targetTile = threat.targetTile;
        if (targetTile === null || targetTile === undefined) continue;
        const radius =
          threat.weapon === UNIT.HydrogenBomb
            ? Number(context.hydrogenRadius || 0)
            : Number(context.atomRadius || 0);
        if (
          radius > 0 &&
          this.game.euclideanDistSquared(tile, targetTile) <= radius * radius
        ) {
          return true;
        }
      }
      return false;
    }

    legendarySamInterceptionCapacity(
      fromTile,
      targetTile,
      levelOverrides = null,
    ) {
      const path = this.legendaryNukeFlightPath(fromTile, targetTile);
      const sams = this.legendaryFriendlySamUnits();
      let capacity = 0;
      for (const sam of sams) {
        const override =
          levelOverrides && levelOverrides.has(sam.id())
            ? levelOverrides.get(sam.id())
            : null;
        if (
          this.legendarySamPathCoverageIndex(
            sam,
            path,
            fromTile,
            targetTile,
            override,
          ) >= 0
        ) {
          capacity += this.legendarySamReadySlots(sam, override);
        }
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
      let minimum = Infinity;
      let routeCount = 0;
      for (const threat of context.threats) {
        const targetTile = threat.targetTile;
        if (targetTile === null || targetTile === undefined) continue;
        const sources = threat.inFlight
          ? threat.nuke && threat.nuke.tile
            ? [threat.nuke.tile()]
            : []
          : threat.enemySilos || [];
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
            ),
          );
        }
      }
      return routeCount > 0 && Number.isFinite(minimum) ? minimum : 0;
    }

    legendarySamImpactMarginScore(tile, context, level = 1) {
      if (!context || !Array.isArray(context.threats)) return 0;
      const structures = Array.isArray(context.structures)
        ? context.priorityStructures || context.structures
        : [];
      if (structures.length === 0) return 0;
      let protectedValue = 0;
      const totalValue = Math.max(1, Number(context.totalValue || 0));
      for (const structure of structures) {
        let protectedByCandidate = false;
        for (const threat of context.threats) {
          const targetTile = threat.targetTile;
          if (targetTile === null || targetTile === undefined) continue;
          const sources = threat.inFlight
            ? threat.nuke && threat.nuke.tile
              ? [threat.nuke.tile()]
              : []
            : threat.enemySilos || [];
          for (const source of sources) {
            const fromTile =
              typeof source.tile === "function" ? source.tile() : source;
            if (fromTile === null || fromTile === undefined) continue;
            const path = this.legendaryNukeFlightPath(
              fromTile,
              structure.tile(),
            );
            const impactTick = this.legendaryNukeFlightTime(
              fromTile,
              structure.tile(),
            );
            const completionTick = this.legendaryConstructionDuration(
              UNIT.SAMLauncher,
            );
            const interceptTicks = this.legendarySamPathInterceptTicks(
              tile,
              path,
              fromTile,
              structure.tile(),
              level,
            );
            if (
              impactTick - completionTick >= LEGENDARY_SAM_IMPACT_MARGIN_TICKS &&
              interceptTicks.some(
                (tick) => tick >= completionTick && tick <= impactTick,
              )
            ) {
              protectedByCandidate = true;
              break;
            }
          }
          if (protectedByCandidate) break;
        }
        if (protectedByCandidate) {
          protectedValue += this.legendaryCriticalStructureValue(structure);
        }
      }
      const spacing = this.spacingConstants().structureSpacing;
      return spacing * Math.min(4, (protectedValue / totalValue) * 4);
    }

    legendaryMissileSalvoPlan(
      enemySilos,
      enemyGold,
      targetTile,
      atomCost,
      hydrogenCost,
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
            completionTick: actionCompletionTick,
          }),
          routes: [],
          sourceMetrics: [],
          samProfiles: samProfilesOverride || [],
        };
      }

      const samProfiles =
        samProfilesOverride ||
        this.legendaryFriendlySamProfiles(levelOverrides, extraSam);
      const canHydrogen = hydrogenCost > 0n && enemyGold >= hydrogenCost;
      const atomBudgetGold = canHydrogen
        ? enemyGold - hydrogenCost
        : enemyGold;
      const affordableAtomsBig =
        atomCost > 0n ? atomBudgetGold / atomCost : 0n;
      const affordableAtoms = Number(affordableAtomsBig);
      const forecastComplete =
        Number.isSafeInteger(affordableAtoms) &&
        affordableAtoms <= LEGENDARY_MAX_FORECAST_MISSILES;
      const atomCount = Math.max(
        0,
        Math.min(
          LEGENDARY_MAX_FORECAST_MISSILES,
          Number.isSafeInteger(affordableAtoms)
            ? affordableAtoms
            : LEGENDARY_MAX_FORECAST_MISSILES,
        ),
      );
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
      const atomArrivalTicks = [];
      const routes = [];
      const pathBySilo = new Map();
      const coverageCacheBySilo = new Map();
      let hydrogenArrivalTick = null;
      for (let index = 0; index < launches.length; index++) {
        const launch = launches[index];
        const isHydrogen = canHydrogen && index >= atomCount;
        const weapon = isHydrogen ? UNIT.HydrogenBomb : UNIT.AtomBomb;
        if (isHydrogen) hydrogenArrivalTick = launch.impactTick;
        else atomArrivalTicks.push(launch.impactTick);
        let path = pathBySilo.get(launch.silo);
        if (!path) {
          path = this.legendaryNukeFlightPath(
            launch.silo.tile(),
            targetTile,
          );
          pathBySilo.set(launch.silo, path);
        }
        let coverageIndexCache = coverageCacheBySilo.get(launch.silo);
        if (!coverageIndexCache) {
          coverageIndexCache = new Map();
          coverageCacheBySilo.set(launch.silo, coverageIndexCache);
        }
        routes.push(
          this.legendaryBuildMissileRoute(
            launch.silo.tile(),
            targetTile,
            launch.impactTick,
            samProfiles,
            launch.launchTick,
            weapon,
            `${isHydrogen ? "hydrogen" : "atom"}:${String(
              launch.silo.id?.() ?? index,
            )}:${String(index)}`,
            path,
            coverageIndexCache,
          ),
        );
      }
      const launchFlightTimes = new Map();
      for (const launch of launches) {
        if (!launchFlightTimes.has(launch.silo)) {
          launchFlightTimes.set(launch.silo, launch.flightTicks);
        }
      }
      const sourceMetrics = enemySilos.map((silo) => {
        const fromTile = silo.tile();
        return {
          silo,
          fromTile,
          flightTimeTicks:
            launchFlightTimes.get(silo) ??
            this.legendaryNukeFlightTime(fromTile, targetTile),
          interceptionCapacity: this.legendarySamInterceptionCapacity(
            fromTile,
            targetTile,
          ),
        };
      });
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
      if (!schedule.forecastComplete) {
        // We cannot claim a complete defense when gold or silo capacity leaves
        // part of the affordable future salvo outside the explicit routes.
        schedule.fullyDefended = false;
        schedule.inconclusive = true;
      }
      const risk = legendaryMissileSalvoRisk({
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
      if (!schedule.forecastComplete) {
        risk.fullyDefended = false;
        risk.inconclusive = true;
        risk.forecastComplete = false;
        risk.risk = 1;
        risk.critical = true;
      }
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

    legendaryActiveMissileThreats(
      structures,
      totalValue,
      atomCost,
      hydrogenCost,
      atomRadius,
      hydrogenRadius,
      samProfilesOverride = null,
    ) {
      const threats = [];
      let activeNukes = [];
      try {
        activeNukes = this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb);
      } catch (_error) {
        return threats;
      }
      const mySid = this.player.smallID();
      const samProfiles =
        samProfilesOverride || this.legendaryFriendlySamProfiles();
      for (const nuke of activeNukes) {
        try {
          if (nuke.isActive && nuke.isActive() === false) continue;
          const owner = nuke.owner();
          if (!owner || owner.smallID() === mySid || this.player.isFriendly(owner)) {
            continue;
          }
          const targetTile = nuke.targetTile();
          const fromTile = nuke.tile();
          if (
            targetTile === null ||
            targetTile === undefined ||
            fromTile === null ||
            fromTile === undefined
          ) {
            continue;
          }
          const type = nuke.type();
          if (type !== UNIT.AtomBomb && type !== UNIT.HydrogenBomb) continue;
          const radius = type === UNIT.HydrogenBomb ? hydrogenRadius : atomRadius;
          const radiusSquared = radius * radius;
          let exposedValue = 0;
          let exposedStructures = 0;
          for (const structure of structures) {
            if (
              this.game.euclideanDistSquared(targetTile, structure.tile()) <=
              radiusSquared
            ) {
              exposedValue += this.legendaryCriticalStructureValue(structure);
              exposedStructures++;
            }
          }
          if (exposedStructures === 0) continue;

          const motion = this.legendaryActiveMissileMotion(
            nuke,
            fromTile,
            targetTile,
          );
          const flightTimeTicks =
            motion?.impactTick ??
            this.legendaryNukeFlightTime(fromTile, targetTile);
          const interceptionCapacity = this.legendarySamInterceptionCapacity(
            fromTile,
            targetTile,
          );
          const nukeId =
            typeof nuke.id === "function" ? nuke.id() : "active-missile";
          const route = this.legendaryBuildMissileRoute(
            motion?.fromTile ?? fromTile,
            targetTile,
            flightTimeTicks,
            samProfiles,
            0,
            type,
            `active:${String(nukeId)}`,
            motion?.path ?? null,
          );
          const salvoRisk = legendaryMissileSalvoRisk({
            atomArrivalTicks: type === UNIT.AtomBomb ? [flightTimeTicks] : [],
            hydrogenArrivalTick:
              type === UNIT.HydrogenBomb ? flightTimeTicks : null,
            interceptionCapacity,
            marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
            routes: [route],
            samProfiles,
            completionTick: 0,
          });
          const score = legendaryMissileThreatScore({
            enemySilos: [{ level: 1 }],
            enemyGold:
              type === UNIT.HydrogenBomb
                ? hydrogenCost > 0n
                  ? hydrogenCost
                  : 1n
                : atomCost > 0n
                  ? atomCost
                  : 1n,
            atomCost: atomCost > 0n ? atomCost : 1n,
            hydrogenCost: hydrogenCost > 0n ? hydrogenCost : 1n,
            flightTimeTicks,
            vulnerableExposure:
              totalValue > 0 ? Math.min(1, exposedValue / totalValue) : 0,
            vulnerableStructures: exposedStructures,
            vulnerableBlastArea: Math.max(1, radiusSquared),
            atomBlastArea: Math.max(1, atomRadius * atomRadius),
            hydrogenBlastArea: Math.max(1, hydrogenRadius * hydrogenRadius),
            interceptionCapacity,
            readyShots: 1,
            salvoRisk,
          });
          threats.push({
            ...score,
            score: Math.max(
              score.score,
              flightTimeTicks < LEGENDARY_SAM_IMPACT_MARGIN_TICKS ? 2 : 0,
            ),
            critical: !salvoRisk.fullyDefended,
            inFlight: true,
            nuke,
            targetTile,
            weapon: type,
            enemySilos: [],
            enemyGold:
              type === UNIT.HydrogenBomb ? hydrogenCost : atomCost,
            salvoPlan: {
              risk: salvoRisk,
              readyShots: 1,
              schedule: salvoRisk,
              routes: [route],
              samProfiles,
            },
            flightTimeTicks,
          });
        } catch (_error) {
          /* a partially decoded in-flight unit must not stop construction */
        }
      }
      return threats;
    }

    missileDefenseStateFingerprint() {
      const parts = [];
      const read = (fn, fallback = "") => {
        try {
          const value = fn();
          return value === null || value === undefined ? fallback : value;
        } catch (_error) {
          return fallback;
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
          const units = read(() => owner.units(type), []);
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
      try {
        atomCost = BigInt(this.cost(UNIT.AtomBomb));
      } catch (_error) {
        /* keep zero so the fingerprint remains fail-closed */
      }
      try {
        hydrogenCost = BigInt(this.cost(UNIT.HydrogenBomb));
      } catch (_error) {
        /* keep zero so the fingerprint remains fail-closed */
      }

      // The trajectory planner only changes its threat model when an enemy can
      // afford a different shot sequence. Including the exact gold balance here
      // made the three-tick context bucket ineffective because gold changes on
      // every simulation tick. Keep the hydrogen reservation and affordable atom
      // count, which are the two values used by legendaryMissileSalvoPlan().
      const enemyGoldCapacityFingerprint = (enemy) => {
        const rawGold = read(() => enemy.gold(), "");
        try {
          const gold = BigInt(rawGold);
          if (atomCost <= 0n && hydrogenCost <= 0n) {
            return `raw=${String(rawGold)}`;
          }
          const canHydrogen = hydrogenCost > 0n && gold >= hydrogenCost;
          const atomBudget = canHydrogen ? gold - hydrogenCost : gold;
          const affordableAtoms =
            atomCost > 0n ? atomBudget / atomCost : 0n;
          return `${canHydrogen ? 1 : 0}:${affordableAtoms.toString()}`;
        } catch (_error) {
          // Preserve fail-closed invalidation when a client exposes a non-integer
          // gold representation or the cost API is unavailable.
          return `raw=${String(rawGold)}`;
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

      const hostilePlayers = [];
      const friendlyPlayers = [];
      for (const other of read(() => this.game.players(), [])) {
        if (!other) continue;
        const sid = read(() => other.smallID(), "");
        if (String(sid) === String(mySid)) continue;
        let friendly = false;
        try {
          friendly =
          this.player.isFriendly(other) || this.player.isOnSameTeam(other);
        } catch (_error) {
          friendly = false;
        }
        if (friendly) {
          friendlyPlayers.push(other);
          continue;
        }
        hostilePlayers.push(other);
      }
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

      const activeMissiles = read(
        () => this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb),
        [],
      );
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
      try {
        config = this.game.config() || {};
      } catch (_error) {
        /* use compatibility fallbacks below */
      }
      const isDisabled = (type) => {
        try {
          return typeof config.isUnitDisabled === "function"
            ? config.isUnitDisabled(type)
            : false;
        } catch (_error) {
          return false;
        }
      };
      const readRadius = (type, fallback) => {
        try {
          const radius = Number(config.nukeMagnitudes?.(type)?.outer);
          return Number.isFinite(radius) && radius > 0 ? radius : fallback;
        } catch (_error) {
          return fallback;
        }
      };
      const readCost = (type) => {
        try {
          return BigInt(this.cost(type));
        } catch (_error) {
          return 0n;
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
      let structures = [];
      try {
        structures = this.player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.Port,
          UNIT.MissileSilo,
        );
      } catch (_error) {
        structures = [];
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
      const tick =
        typeof this.game?.ticks === "function"
          ? Number(this.game.ticks())
          : null;
      const signal = this.missileDefenseSignalSnapshot();
      const activeMissile = signal?.hasActiveHostileMissile === true;
      const missileSignal =
        signal === null
          ? null
          : signal.hasBuiltHostileSilo ||
            signal.hasActiveHostileMissile === null ||
            activeMissile;
      const cacheTick = Number.isFinite(tick)
        ? activeMissile
          ? tick
          : Math.floor(tick / LEGENDARY_MISSILE_DEFENSE_CONTEXT_BUCKET_TICKS)
        : null;
      const stateKey = missileSignal === false
        ? "no-missile-signal"
        : signal !== null
          ? this.missileDefenseStateFingerprint()
          : "unknown-missile-signal";
      const cacheKey = Number.isFinite(cacheTick)
        ? `${cacheTick}|${stateKey}`
        : null;
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

    legendaryMissileTargetCandidates(
      structures,
      enemySilos,
      radius,
      totalValue,
    ) {
      const entries = [];
      const radiusSquared = Math.max(0, Number(radius) || 0) ** 2;
      for (const target of structures || []) {
        const targetTile = target?.tile?.();
        if (targetTile === null || targetTile === undefined) continue;
        let exposedValue = this.legendaryCriticalStructureValue(target);
        let exposedStructures = 1;
        for (const other of structures || []) {
          if (other === target) continue;
          try {
            if (
              this.game.euclideanDistSquared(targetTile, other.tile()) <=
              radiusSquared
            ) {
              exposedValue += this.legendaryCriticalStructureValue(other);
              exposedStructures++;
            }
          } catch (_error) {
            /* skip a stale structure reference */
          }
        }
        entries.push({
          target,
          tile: targetTile,
          exposedValue,
          exposedStructures,
          exposure:
            totalValue > 0 ? Math.min(1, exposedValue / totalValue) : 0,
        });
      }

      const limit = Math.min(LEGENDARY_MAX_MISSILE_TARGETS, entries.length);
      if (entries.length <= limit) return entries;

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
            this.legendaryCriticalStructureValue(right.target) -
              this.legendaryCriticalStructureValue(left.target) ||
            right.exposedValue - left.exposedValue,
        );
      const selected = [];
      const selectedEntries = new Set();
      const add = (entry) => {
        if (selected.length >= limit || selectedEntries.has(entry)) return;
        selectedEntries.add(entry);
        selected.push(entry);
      };

      for (const entry of byExposure.slice(0, Math.max(8, Math.ceil(limit * 0.6)))) {
        add(entry);
      }
      for (const entry of byValue.slice(0, Math.max(4, Math.floor(limit * 0.25)))) {
        add(entry);
      }
      for (const silo of enemySilos || []) {
        let nearest = null;
        let nearestDistance = Infinity;
        for (const entry of entries) {
          try {
            const distance = this.game.manhattanDist(silo.tile(), entry.tile);
            if (distance < nearestDistance) {
              nearest = entry;
              nearestDistance = distance;
            }
          } catch (_error) {
            /* skip a stale silo/target pair */
          }
        }
        if (nearest) add(nearest);
      }
      for (const entry of byExposure) {
        add(entry);
        if (selected.length >= limit) break;
      }
      return selected;
    }

    legendaryMissilePlacementContext() {
      const config = this.game.config();
      const atomCost = config.isUnitDisabled(UNIT.AtomBomb)
        ? 0n
        : this.cost(UNIT.AtomBomb);
      const hydrogenCost = config.isUnitDisabled(UNIT.HydrogenBomb)
        ? 0n
        : this.cost(UNIT.HydrogenBomb);
      const atomRadius = Number(
        config.nukeMagnitudes(UNIT.AtomBomb).outer,
      );
      const hydrogenRadius = Number(
        config.nukeMagnitudes(UNIT.HydrogenBomb).outer,
      );
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      const totalValue = structures.reduce(
        (total, unit) => total + this.legendaryCriticalStructureValue(unit),
        0,
      );
      const priorityStructures = structures
        .slice()
        .sort(
          (left, right) =>
            this.legendaryCriticalStructureValue(right) -
            this.legendaryCriticalStructureValue(left),
        )
        .slice(0, LEGENDARY_MAX_MISSILE_TARGETS);
      const enemies = this.legendaryHostilePlayers();
      const samProfiles = this.legendaryFriendlySamProfiles();
      const threats = [];

      for (const enemy of enemies) {
        let enemyGold = 0n;
        let enemySilos = [];
        try {
          enemyGold = BigInt(enemy.gold());
          enemySilos = enemy
            .units(UNIT.MissileSilo)
            .filter(
              (silo) =>
                !silo.isUnderConstruction() &&
                (!silo.isActive || silo.isActive() !== false),
            );
        } catch (_error) {
          continue;
        }
        if (enemySilos.length === 0) continue;

        const canHydrogen = hydrogenCost > 0n && enemyGold >= hydrogenCost;
        const canAtom = atomCost > 0n && enemyGold >= atomCost;
        if (!canHydrogen && !canAtom) continue;
        const weapon = canHydrogen ? UNIT.HydrogenBomb : UNIT.AtomBomb;
        const radius = canHydrogen ? hydrogenRadius : atomRadius;
        const targetCandidates = this.legendaryMissileTargetCandidates(
          structures,
          enemySilos,
          radius,
          totalValue,
        );
        const enemySiloLevels = enemySilos.map((unit) => ({
          level: unit.level(),
        }));

        let bestTarget = null;
        for (const targetCandidate of targetCandidates) {
          const targetTile = targetCandidate.tile;
          const exposedValue = targetCandidate.exposedValue;
          const exposedStructures = targetCandidate.exposedStructures;
          const exposure = targetCandidate.exposure;
          // The salvo is identical for every source silo at this target; build
          // its shared route/schedule once instead of recomputing every
          // parabola inside the per-silo threat-score loop.
          const salvoPlan = this.legendaryMissileSalvoPlan(
            enemySilos,
            enemyGold,
            targetTile,
            atomCost,
            hydrogenCost,
            { samProfilesOverride: samProfiles },
          );
          const sourceMetrics = new Map(
            (salvoPlan.sourceMetrics || []).map((source) => [source.silo, source]),
          );
          for (const silo of enemySilos) {
            const source = sourceMetrics.get(silo);
            const flightTimeTicks =
              source?.flightTimeTicks ??
              this.legendaryNukeFlightTime(silo.tile(), targetTile);
            const interceptionCapacity =
              source?.interceptionCapacity ??
              this.legendarySamInterceptionCapacity(
                silo.tile(),
                targetTile,
              );
            const threat = legendaryMissileThreatScore({
              enemySilos: enemySiloLevels,
              enemyGold,
              atomCost,
              hydrogenCost,
              flightTimeTicks,
              vulnerableExposure: exposure,
              vulnerableStructures: exposedStructures,
              vulnerableBlastArea: exposure,
              atomBlastArea: Math.max(1, atomRadius * atomRadius),
              hydrogenBlastArea: Math.max(1, hydrogenRadius * hydrogenRadius),
              interceptionCapacity,
              readyShots: salvoPlan.readyShots,
              salvoRisk: salvoPlan.risk,
            });
            if (bestTarget === null || threat.score > bestTarget.score) {
              bestTarget = {
                ...threat,
                weapon,
                critical:
                  Boolean(threat.critical) &&
                  !salvoPlan.schedule?.fullyDefended,
                enemy,
                enemySilos,
                enemyGold,
                targetTile,
                salvoPlan,
              };
            }
          }
        }
        if (bestTarget !== null) threats.push(bestTarget);
      }

      const activeMissiles = this.legendaryActiveMissileThreats(
        structures,
        totalValue,
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        samProfiles,
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
        structures,
        priorityStructures,
        totalValue,
        atomCost,
        hydrogenCost,
        atomRadius,
        hydrogenRadius,
        activeMissiles,
      };
    }

    legendaryMissilePlacementRisk(tile, type, context) {
      if (!context || !Array.isArray(context.threats)) return 0;
      const candidateValue =
        type === UNIT.City
          ? 5
          : type === UNIT.Factory || type === UNIT.Port
            ? 4
            : type === UNIT.MissileSilo
              ? 3
              : 1;
      let worstRisk = 0;

      // Active hostile missiles are already committed and have no silo queue to
      // simulate. Their direct blast zone is therefore evaluated separately from
      // the prospective atom-chain model below.
      for (const active of context.activeMissiles || []) {
        const radius =
          active.weapon === UNIT.HydrogenBomb
            ? context.hydrogenRadius
            : context.atomRadius;
        if (
          active.targetTile !== null &&
          active.targetTile !== undefined &&
          this.game.euclideanDistSquared(tile, active.targetTile) <= radius * radius
        ) {
          worstRisk = Math.max(worstRisk, Number(active.score || 0));
        }
      }

      for (const threat of context.threats) {
        if (threat.inFlight) continue;
        const radius =
          threat.weapon === UNIT.HydrogenBomb
            ? context.hydrogenRadius
            : context.atomRadius;
        const radiusSquared = radius * radius;
        let exposedValue = candidateValue;
        let exposedStructures = 1;
        for (const structure of
          context.priorityStructures || context.structures || []) {
          if (
            this.game.euclideanDistSquared(tile, structure.tile()) <=
            radiusSquared
          ) {
            exposedValue += this.legendaryCriticalStructureValue(structure);
            exposedStructures++;
          }
        }
        const totalValue = context.totalValue + candidateValue;
        const exposure = Math.min(1, exposedValue / Math.max(1, totalValue));
        // This method only ranks candidate placement tiles. The full salvo
        // scheduler is reserved for hard safety gates; rebuilding it for each
        // of 25 sampled tiles caused a large synchronous stall in Legendary.
        // Reuse the existing threat's shot count and compute only the cheap
        // launch/capacity proxy needed by the placement score.
        const sourcePlan = threat.salvoPlan || {};
        const plannedAtomCount = Array.isArray(sourcePlan.atomArrivalTicks)
          ? sourcePlan.atomArrivalTicks.length
          : 0;
        const plannedHydrogenCount =
          sourcePlan.hydrogenArrivalTick === null ||
          sourcePlan.hydrogenArrivalTick === undefined
            ? 0
            : 1;
        const plannedRouteCount = Array.isArray(sourcePlan.routes)
          ? sourcePlan.routes.length
          : 0;
        const shotCount = Math.max(
          1,
          plannedAtomCount + plannedHydrogenCount,
          plannedRouteCount,
        );
        const launches = this.legendaryEnemyMissileLaunchPlan(
          threat.enemySilos || [],
          tile,
          shotCount,
        );
        if (launches.length === 0) continue;
        const hasHydrogen =
          threat.weapon === UNIT.HydrogenBomb || plannedHydrogenCount > 0;
        const atomArrivalTicks = [];
        let hydrogenArrivalTick = null;
        for (let index = 0; index < launches.length; index++) {
          const launch = launches[index];
          if (hasHydrogen && index === launches.length - 1) {
            hydrogenArrivalTick = launch.impactTick;
          } else {
            atomArrivalTicks.push(launch.impactTick);
          }
        }
        let interceptionCapacity = 0;
        for (const silo of threat.enemySilos || []) {
          interceptionCapacity += this.legendarySamInterceptionCapacity(
            silo.tile(),
            tile,
          );
        }
        const salvoRisk = legendaryMissileSalvoRisk({
          atomArrivalTicks,
          hydrogenArrivalTick,
          interceptionCapacity,
          samCooldownTicks: this.legendarySamCooldownTicks(),
          marginTicks: LEGENDARY_SAM_IMPACT_MARGIN_TICKS,
          readyShots: sourcePlan.readyShots ?? 0,
          routes: null,
          samProfiles: [],
          completionTick: 0,
        });
        const nearestFlightTime = Math.min(
          ...launches.map((launch) => launch.flightTicks ?? launch.impactTick),
        );
        const risk = legendaryMissileThreatScore({
          enemySilos: (threat.enemySilos || []).map((unit) => ({
            level: unit.level(),
          })),
          enemyGold: threat.enemyGold,
          atomCost: context.atomCost,
          hydrogenCost: context.hydrogenCost,
          flightTimeTicks: nearestFlightTime,
          vulnerableExposure: exposure,
          vulnerableStructures: exposedStructures,
          vulnerableBlastArea: exposure,
          atomBlastArea: Math.max(1, context.atomRadius * context.atomRadius),
          hydrogenBlastArea: Math.max(
            1,
            context.hydrogenRadius * context.hydrogenRadius,
          ),
          interceptionCapacity,
          readyShots: sourcePlan.readyShots ?? 0,
          salvoRisk,
        });
        worstRisk = Math.max(worstRisk, risk.score);
      }
      return worstRisk;
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
        try {
          enemyWarships += enemy.units(UNIT.Warship).length;
        } catch (_error) {
          /* skip unavailable unit snapshots */
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

      const add = (type, values = {}) => {
        if (config.isUnitDisabled(type) || !autoBotBuildAllowed(type)) return;
        if (type === UNIT.Port && !hasOceanPortTiles) return;
        if (
          !nukesEnabled &&
          (type === UNIT.SAMLauncher || type === UNIT.MissileSilo)
        ) {
          return;
        }
        if (type === UNIT.SAMLauncher && !missileSilosEnabled) return;
        const cost = this.getPerceivedCost(type);
        const objective = legendaryConstructionObjectiveVector(type, {
          ...strategicState,
          costFactor: this.legendaryCostFactor(cost),
        });
        candidates.push({
          type,
          cost,
          typeOrder: typeOrder[type],
          ...objective,
          ...values,
        });
      };

      if (!citiesDisabled) {
        add(UNIT.City, {
          mandatory: cityCount === 0 ? 1 : 0,
          safety: 0,
          strategic: strategicState.railNeed > 1.25 ? 1 : 0,
          deficit: Math.max(0, Math.ceil(strategicState.railNeed - 1)),
          efficiency: 1,
        });
      }

      const ratios = getStructureRatios(Difficulty.Legendary);
      const addRatioCandidate = (type, values = {}) => {
        if (
          type === UNIT.SAMLauncher &&
          strategicState.missileThreat.score <= 0 &&
          strategicState.samLevelParityGap <= 0
        ) {
          return;
        }
        if (
          type === UNIT.MissileSilo &&
          strategicState.targetPressure <= 0.75 &&
          strategicState.siloParityGap <= 0
        ) {
          return;
        }
        const ratioConfig = ratios[type];
        if (ratioConfig === undefined) return;
        const owned = this.ownedLevels(type);
        let ratio = ratioConfig.ratioPerCity;
        if (
          type === UNIT.Factory &&
          hasCoastalTiles &&
          !config.isUnitDisabled(UNIT.Port) &&
          !this._dominant
        ) {
          ratio *= FACTORY_COASTAL_RATIO_MULTIPLIER;
        }
        if (
          type === UNIT.MissileSilo &&
          owned >= MAX_MISSILE_SILOS &&
          strategicState.siloParityGap <= 0
        ) {
          return;
        }
        if (type === UNIT.MissileSilo && owned === 0) {
          ratio = FIRST_MISSILE_SILO_RATIO;
        }
        const ratioTarget = Math.floor(cityCount * ratio);
        const target =
          type === UNIT.MissileSilo
            ? Math.max(ratioTarget, strategicState.siloParityTarget)
            : ratioTarget;
        const deficit = Math.max(0, target - owned);
        const parityGap =
          type === UNIT.MissileSilo ? strategicState.siloParityGap : 0;
        const strategic =
          Number(values.strategic || 0) + Math.min(3, parityGap);
        const mandatory =
          Number(values.mandatory || 0) + (parityGap > 0 ? 1 : 0);
        const safety = Number(values.safety || 0);
        if (deficit <= 0 && strategic <= 0 && mandatory <= 0 && safety <= 0) {
          return;
        }
        add(type, {
          mandatory,
          safety,
          strategic,
          deficit,
          efficiency: Number(values.efficiency || 0) || 1,
        });
      };

      addRatioCandidate(UNIT.Port, {
        strategic: strategicState.tradeNeed > 1.25 ? 1 : 0,
      });
      addRatioCandidate(UNIT.Factory, {
        strategic: strategicState.railNeed > 1.25 ? 1 : 0,
      });
      addRatioCandidate(UNIT.SAMLauncher, {
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
      addRatioCandidate(UNIT.MissileSilo, {
        strategic: strategicState.targetPressure > 0.75 ? 1 : 0,
      });

      return candidates;
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
      let isTeam = false;
      try {
        isTeam = String(this.game.config().gameConfig().gameMode) === "Team";
      } catch (_e) {
        return null;
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
          try {
            if (p.isPlayer() && this.player.isOnSameTeam(p)) {
              ownedTiles += p.numTilesOwned();
            }
          } catch (_e) {
            /* skip */
          }
        }
      } else {
        ownedTiles = this.player.numTilesOwned();
      }
      return ownedTiles / denom;
    }

    // shouldBuildStructure — NationStructureBehavior.ts:540.
    shouldBuildStructure(type, cityCount, hasCoastalTiles) {
      if (
        type === UNIT.MissileSilo &&
        this.shouldPrioritizeEconomicGrowth()
      ) {
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
      if (!autoBotBuildAllowed(type)) return false; // user disallowed this type
      if (
        type === UNIT.MissileSilo &&
        this.shouldPrioritizeEconomicGrowth()
      ) {
        return false;
      }
      const perceivedCost = this.getPerceivedCost(type);
      let availableGold = this.player.gold();
      // WIN-FIX (NOT in src): when mirvBehavior has set a real MIRV war-chest
      // reserve (state.nukeReserveGold ≥ 15M), the economy yields so the bot
      // accumulates the war chest instead of over-building — this is what funds
      // the leader/pre-empt MIRV that closes out a winning game.
      if (state.settings.winFixes && state.nukeReserveGold) {
        let reserve = 0n;
        try {
          reserve = BigInt(state.nukeReserveGold || 0);
        } catch (_e) {
          reserve = 0n;
        }
        if (reserve >= 15000000n) {
          availableGold = availableGold > reserve ? availableGold - reserve : 0n;
        }
      }
      if (availableGold < perceivedCost) {
        return false;
      }

      const legendaryMissileEmergency =
        isLegendaryDifficulty() &&
        this.legendaryMissileDefenseNeedsAction(
          this.getMissileDefenseContext(),
        );

      // Check if we should upgrade instead of building new
      const structures = this.player.units(type);
      if (
        !options.forceNewStructure &&
        !legendaryMissileEmergency &&
        this.getTotalStructureDensity() > UPGRADE_DENSITY_THRESHOLD &&
        this.game.config().unitInfo(type).upgradable
      ) {
        if (await this.maybeUpgradeStructure(structures)) {
          return true;
        }
        // Density too high but couldn't upgrade (e.g. all under construction) —
        // don't build new, wait for construction (most relevant for SAMs).
        if (structures.length > 0) {
          return false;
        }
        // No structures of this type exist yet — fall through to build the first.
      }

      // RANK-THEN-PROBE: structureSpawnTile now returns the snapped BuildableUnit
      // (the first canBuild !== false tile down the value-ranked list) instead of
      // a bare TileRef, folding the src `player.canBuild(type, tile)` check into
      // the probe. src: tile = structureSpawnTile(type); if null → return;
      // canBuild = player.canBuild(type, tile); if false → return;
      // addExecution(ConstructionExecution).
      const bu = await this.structureSpawnTile(type, options);
      if (bu === null) {
        return false;
      }
      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      buildMenu.sendBuildOrUpgrade(bu, bu.canBuild);
      state.stats.builds++;
      setLastAction(tr("🏗️ Build {type}", { type }), "build");
      return true;
    }

    // getPerceivedCost — NationStructureBehavior.ts:627.
    getPerceivedCost(type) {
      const realCost = this.cost(type);

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
    async maybeUpgradeStructure(structures) {
      if (this.getTotalStructureDensity() <= UPGRADE_DENSITY_THRESHOLD) {
        return false;
      }
      if (structures.length === 0) {
        return false;
      }
      const result = await this.findBestStructureToUpgrade(structures);
      if (result !== null) {
        // src: addExecution(new UpgradeStructureExecution(player, unit.id())).
        // Client: sendBuildOrUpgrade(bu) where bu.canUpgrade !== false. We already
        // probed the BuildableUnit in findBestStructureToUpgrade, so reuse it.
        const buildMenu = getBuildMenu();
        if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
          return false;
        }
        buildMenu.sendBuildOrUpgrade(result.bu);
        state.stats.builds++;
        setLastAction(
          tr("⬆️ Upgrade {type}", { type: result.structure.type() }),
          "build",
        );
        return true;
      }
      return false;
    }

    async maybeUpgradePlannedSam(plan) {
      if (!plan || plan.targetLevel <= plan.currentLevel) return false;

      let reserve = 0n;
      try {
        reserve = this.legendaryReserveGold();
      } catch (_error) {
        reserve = 0n;
      }
      const availableGold =
        this.player.gold() > reserve ? this.player.gold() - reserve : 0n;
      let minimumCost = 0n;
      try {
        minimumCost = this.cost(UNIT.SAMLauncher);
      } catch (_error) {
        minimumCost = 0n;
      }
      if (availableGold < minimumCost) return false;

      const buildables = await this.buildableForUnits(
        [plan.sam],
        UNIT.SAMLauncher,
        {
          concurrency: 1,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const bu = buildables[0];
      if (bu === null || bu === undefined || bu.canUpgrade === false) {
        return false;
      }

      let cost = minimumCost;
      try {
        if (bu.cost !== undefined && bu.cost !== null) cost = BigInt(bu.cost);
      } catch (_error) {
        /* use the formula fallback */
      }
      if (cost > availableGold) return false;

      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      buildMenu.sendBuildOrUpgrade(bu);
      state.stats.builds++;
      setLastAction(
        tr("⬆️ Upgrade {type}", { type: UNIT.SAMLauncher }),
        "build",
      );
      return true;
    }

    /**
     * Highest priority: keep at least one built SAM's range over every own
     * structure so a Hydrogen Bomb aimed at any of them has an interceptor.
     */
    async maybeEnsureHydrogenStructureCoverage() {
      const plan = this.hydrogenStructureCoveragePlan();
      if (!plan) return false;
      if (plan.needsNewSam) {
        return this.maybeSpawnStructure(UNIT.SAMLauncher, {
          forceNewStructure: true,
          prioritizeStructureCoverage: true,
        });
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
      if (!state.settings.winFixes) return false;
      const request = state.nukeWantSlots;
      const requiredCapacity = Number(request?.need);
      if (!Number.isFinite(requiredCapacity) || requiredCapacity <= 0) {
        return false;
      }

      try {
        if (this.game.config().isUnitDisabled(UNIT.MissileSilo)) return false;
      } catch (_error) {
        /* use the buildable probe as the compatibility fallback */
      }
      if (!autoBotBuildAllowed(UNIT.MissileSilo)) return false;

      const allSilos = this.player.units(UNIT.MissileSilo) || [];
      const builtSilos = allSilos.filter((silo) => {
        try {
          return !silo.isUnderConstruction();
        } catch (_error) {
          return false;
        }
      });
      const preferredIds = new Set(
        Array.isArray(request.unblockedSiloIds)
          ? request.unblockedSiloIds.map(String)
          : [],
      );
      const preferredSilos = builtSilos.filter((silo) => {
        if (preferredIds.size === 0) return true;
        try {
          return preferredIds.has(String(silo.id()));
        } catch (_error) {
          return false;
        }
      });
      const scopedSilos = preferredSilos.length > 0 ? preferredSilos : builtSilos;
      const currentCapacity = scopedSilos.reduce(
        (sum, silo) => sum + Math.max(1, Number(silo.level?.() ?? 1)),
        0,
      );
      if (currentCapacity >= requiredCapacity) {
        state.nukeWantSlots = null;
        return false;
      }

      const upgradeable = scopedSilos.filter((silo) => {
        const level = Number(silo.level?.() ?? 1);
        if (!Number.isFinite(level) || level >= HYDROGEN_SAM_MAX_UPGRADE_LEVEL) {
          return false;
        }
      });
      const fallbackUpgradeable = scopedSilos.filter((silo) => {
        const level = Number(silo.level?.() ?? 1);
        return Number.isFinite(level) && level < HYDROGEN_SAM_MAX_UPGRADE_LEVEL;
      });
      const candidates = upgradeable.length > 0 ? upgradeable : fallbackUpgradeable;
      if (candidates.length === 0) return false;

      let reserve = 0n;
      try {
        reserve = this.legendaryReserveGold();
      } catch (_error) {
        reserve = 0n;
      }
      const availableGold =
        this.player.gold() > reserve ? this.player.gold() - reserve : 0n;
      let minimumCost = 0n;
      try {
        minimumCost = this.cost(UNIT.MissileSilo);
      } catch (_error) {
        minimumCost = 0n;
      }
      if (availableGold < minimumCost) return false;

      const buildables = await this.buildableForUnits(
        candidates,
        UNIT.MissileSilo,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      const ownSams = this.player.units(UNIT.SAMLauncher) || [];
      const ranked = [];
      for (let index = 0; index < candidates.length; index++) {
        const silo = candidates[index];
        const bu = buildables[index];
        if (!bu || bu.canUpgrade === false) continue;
        let cost = minimumCost;
        try {
          if (bu.cost !== undefined && bu.cost !== null) cost = BigInt(bu.cost);
        } catch (_error) {
          /* use the formula fallback */
        }
        if (cost > availableGold) continue;

        let protection = 0;
        for (const sam of ownSams) {
          try {
            if (sam.isUnderConstruction && sam.isUnderConstruction()) continue;
            const range = Number(this.game.config().samRange(sam.level()));
            const distance = this.game.euclideanDistSquared(
              silo.tile(),
              sam.tile(),
            );
            if (distance <= range * range) protection += Number(sam.level());
          } catch (_error) {
            /* skip an incomplete SAM snapshot */
          }
        }
        ranked.push({
          silo,
          bu,
          cost,
          level: Number(silo.level?.() ?? 1),
          protection,
        });
      }
      ranked.sort((left, right) => {
        if (right.protection !== left.protection) {
          return right.protection - left.protection;
        }
        if (left.cost !== right.cost) {
          return left.cost < right.cost ? -1 : 1;
        }
        return left.level - right.level;
      });
      const selected = ranked[0];
      if (!selected) return false;

      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      buildMenu.sendBuildOrUpgrade(selected.bu);
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type: UNIT.MissileSilo }), "build");
      return true;
    }

    async maybeUpgradeSamForSiloParity() {
      if (!state.settings.winFixes || !autoBotBuildAllowed(UNIT.SAMLauncher)) {
        return false;
      }
      try {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
      } catch (_error) {
        /* keep the buildable probe as the compatibility fallback */
      }

      const targetCapacity = this.samLevelParityTarget();
      if (targetCapacity <= 0 || this.ownSamCapacity() >= targetCapacity) {
        return false;
      }

      let reserve = 0n;
      try {
        reserve = this.legendaryReserveGold();
      } catch (_error) {
        reserve = 0n;
      }
      const availableGold =
        this.player.gold() > reserve ? this.player.gold() - reserve : 0n;
      if (availableGold < this.cost(UNIT.SAMLauncher)) return false;
      const candidates = [];

      const samUnits = (this.player.units(UNIT.SAMLauncher) || []).filter(
        (sam) => {
          if (sam.isUnderConstruction()) return false;
          return !sam.isActive || sam.isActive() !== false;
        },
      );
      const buildables = await this.buildableForUnits(
        samUnits,
        UNIT.SAMLauncher,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );

      for (let index = 0; index < samUnits.length; index++) {
        const sam = samUnits[index];
        const bu = buildables[index];
        if (bu === null || bu.canUpgrade === false) continue;
        let cost = this.cost(UNIT.SAMLauncher);
        try {
          if (bu.cost !== undefined && bu.cost !== null) cost = BigInt(bu.cost);
        } catch (_error) {
          /* use the formula fallback */
        }
        if (cost > availableGold) continue;
        const level = Math.max(1, Number(sam.level() || 1));
        candidates.push({ sam, bu, cost, level });
      }

      candidates.sort((left, right) => {
        if (right.level !== left.level) return right.level - left.level;
        if (left.cost !== right.cost) return left.cost < right.cost ? -1 : 1;
        return String(left.sam.id?.() ?? "").localeCompare(
          String(right.sam.id?.() ?? ""),
        );
      });
      const selected = candidates[0];
      if (!selected) return false;

      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      buildMenu.sendBuildOrUpgrade(selected.bu);
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type: UNIT.SAMLauncher }), "build");
      return true;
    }

    async maybeUpgradeMissileDefenseSam() {
      if (!autoBotBuildAllowed(UNIT.SAMLauncher)) return false;
      try {
        if (this.game.config().isUnitDisabled(UNIT.SAMLauncher)) return false;
      } catch (_error) {
        /* keep the buildable probe as the compatibility fallback */
      }
      // A hostile gold reserve is enough to build a new protective SAM, but
      // without an actual hostile silo or in-flight missile there is no route
      // worth forecasting for an upgrade. This gate avoids waking the expensive
      // planner on every Impossible/Legendary structure tick during the early
      // game.
      const missileSignal = this.missileDefenseSignalSnapshot();
      // A built hostile silo is enough to trigger proactive SAM site/level
      // parity, but it is not an inbound route. Only an active hostile missile
      // should wake the per-SAM buildable probes and trajectory forecast here.
      if (
        missileSignal === null ||
        missileSignal.hasActiveHostileMissile !== true
      ) {
        return false;
      }
      const samUnits = this.player.units(UNIT.SAMLauncher) || [];
      const upgradeableSamUnits = samUnits.filter(
        (sam) =>
          !sam.isUnderConstruction() &&
          (!sam.isActive || sam.isActive() !== false),
      );
      if (upgradeableSamUnits.length === 0) return false;

      let reserve = 0n;
      try {
        reserve = this.legendaryReserveGold();
      } catch (_error) {
        reserve = 0n;
      }
      const availableGold =
        this.player.gold() > reserve ? this.player.gold() - reserve : 0n;
      // The formula is a cheap lower bound. Keep the early exit for clearly
      // unaffordable upgrades, then use BuildableUnit.cost as the final live
      // price before forecasting.
      let minimumUpgradeCost = 0n;
      try {
        minimumUpgradeCost = this.cost(UNIT.SAMLauncher);
      } catch (_error) {
        minimumUpgradeCost = 0n;
      }
      if (availableGold < minimumUpgradeCost) return false;

      // Probe buildability and the real next-upgrade cost before entering the
      // synchronous forecast. This keeps an unaffordable SAM from waking the
      // full enemy-silo/trajectory planner on every structure tick. The
      // forecast is deliberately obtained only after these awaits finish, so
      // it cannot be older than the asynchronous buildable probes.
      const upgradeCandidates = [];

      const buildables = await this.buildableForUnits(
        upgradeableSamUnits,
        UNIT.SAMLauncher,
        {
          concurrency: DEFENSIVE_SAM_PROBE_CONCURRENCY,
          timeoutMs: HOSTILE_SILO_SAM_PROBE_TIMEOUT_MS,
        },
      );
      for (let index = 0; index < upgradeableSamUnits.length; index++) {
        const sam = upgradeableSamUnits[index];
        const bu = buildables[index];
        if (bu === null || bu.canUpgrade === false) continue;
        let cost = this.cost(UNIT.SAMLauncher);
        try {
          if (bu.cost !== undefined && bu.cost !== null) cost = BigInt(bu.cost);
        } catch (_error) {
          /* use the formula fallback */
        }
        if (cost > availableGold) continue;

        const nextLevel = Math.max(1, Number(sam.level() || 1) + 1);
        const overrides = new Map([[sam.id(), nextLevel]]);
        upgradeCandidates.push({ sam, bu, cost, nextLevel, overrides });
      }
      if (upgradeCandidates.length === 0) return false;

      const context = this.getMissileDefenseContext();
      if (
        !context ||
        !Array.isArray(context.threats) ||
        context.threats.length === 0
      ) {
        return false;
      }
      const currentEvaluation = this.getMissileDefenseEvaluation(context);
      const currentMargin = currentEvaluation.fullyDefended
        ? currentEvaluation.completionMarginTicks
        : 0;
      const urgent =
        currentEvaluation.hasThreats &&
        !currentEvaluation.fullyDefended;
      if (!urgent) return false;

      const currentCapacity =
        this.legendaryMinimumSamInterceptionCapacity(context);
      const currentUnintercepted = currentEvaluation.uninterceptedCount;
      const candidates = [];

      for (const candidate of upgradeCandidates) {
        const { sam, bu, cost, overrides } = candidate;
        // Upgrades are instant in the engine. Keep the five-tick safety margin,
        // but accept a material intermediate improvement: a high-level enemy
        // silo salvo can require several upgrades before it is fully covered.
        const nextEvaluation = this.legendaryDefenseEvaluation(context, {
          levelOverrides: overrides,
          completionTick: 0,
        });
        if (
          nextEvaluation.completionMarginTicks <
          LEGENDARY_SAM_IMPACT_MARGIN_TICKS
        ) {
          continue;
        }
        const nextMargin = nextEvaluation.completionMarginTicks;
        const nextCapacity = this.legendaryMinimumSamInterceptionCapacity(
          context,
          overrides,
        );
        const nextUnintercepted = nextEvaluation.uninterceptedCount;
        const interceptedGain = Math.max(
          0,
          currentUnintercepted - nextUnintercepted,
        );
        const marginGain = Math.max(0, nextMargin - currentMargin);
        const capacityGain = Math.max(0, nextCapacity - currentCapacity);
        if (
          !legendaryDefenseActionImproves(
            currentEvaluation,
            nextEvaluation,
            currentCapacity,
            nextCapacity,
          )
        ) {
          continue;
        }
        const reachesFullDefense = nextEvaluation.fullyDefended ? 100 : 0;
        const costFactor = Math.max(1, Number(cost) / 1_500_000);
        const score =
          (reachesFullDefense +
            interceptedGain * 100 +
            marginGain * 10 +
            capacityGain * 2) /
          costFactor;
        candidates.push({
          sam,
          bu,
          cost,
          score,
          marginGain,
          capacityGain,
          interceptedGain,
        });
      }

      candidates.sort((left, right) => {
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
        return left.cost < right.cost ? -1 : left.cost > right.cost ? 1 : 0;
      });
      const selected = candidates[0];
      if (!selected) return false;

      const buildMenu = getBuildMenu();
      if (!buildMenu || typeof buildMenu.sendBuildOrUpgrade !== "function") {
        return false;
      }
      buildMenu.sendBuildOrUpgrade(selected.bu);
      state.stats.builds++;
      setLastAction(tr("⬆️ Upgrade {type}", { type: UNIT.SAMLauncher }), "build");
      return true;
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
    // exact src RNG sequence and scoring. Returns {structure, bu} | null.
    async findBestStructureToUpgrade(structures) {
      const game = this.game;
      if (structures.length === 0) {
        return null;
      }

      // Filter to only upgradable structures (probe before any RNG draw).
      const upgradable = [];
      const buByUnitId = new Map();
      for (const s of structures) {
        const bu = await this.buildableFor(s.type(), s.tile());
        if (bu !== null && bu.canUpgrade !== false) {
          upgradable.push(s);
          buByUnitId.set(s.id(), bu);
        }
      }
      if (upgradable.length === 0) {
        return null;
      }

      const mkResult = (structure) => ({
        structure,
        bu: buByUnitId.get(structure.id()),
      });

      // Based on difficulty, chance to just pick a random structure.
      const difficulty = currentDifficulty();
      let randomChance;
      switch (difficulty) {
        case Difficulty.Easy:
          randomChance = 70;
          break;
        case Difficulty.Medium:
          randomChance = 40;
          break;
        case Difficulty.Hard:
          randomChance = 25;
          break;
        case Difficulty.Impossible:
          randomChance = 10;
          break;
        case Difficulty.Legendary:
          randomChance = 0;
          break;
        default:
          randomChance = 10;
      }

      if (this.random.nextInt(0, 100) < randomChance) {
        return mkResult(this.random.randElement(upgradable));
      }

      const samLaunchers = this.player.units(UNIT.SAMLauncher);

      // Score each structure based on SAM protection.
      const scored = [];

      for (const structure of upgradable) {
        let score = 0;

        // Check if protected by any SAM, using per-SAM level-based range.
        for (const sam of samLaunchers) {
          const samRange = game.config().samRange(sam.level());
          const samRangeSquared = samRange * samRange;
          const distSquared = game.euclideanDistSquared(
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

        // Add small random factor to break ties.
        score += this.random.nextInt(0, 5);

        scored.push({ structure, score });
      }

      if (scored.length === 0) {
        return null;
      }

      // Sort descending by score.
      scored.sort((a, b) => b.score - a.score);

      // 50% of the time, pick the second or third best for variety.
      if (scored.length >= 2 && this.random.chance(2)) {
        const pickIndex =
          scored.length >= 3
            ? this.random.nextInt(1, 3) // pick index 1 or 2
            : 1; // only index 1 available
        return mkResult(scored[pickIndex].structure);
      }

      return mkResult(scored[0].structure);
    }

    // structureSpawnTile — NationStructureBehavior.ts:814 (now async).
    // RANK-THEN-PROBE: score ALL candidate tiles SYNC by the src value function,
    // sort DESC, then await buildables down the ranked list and take the FIRST
    // whose BuildableUnit.canBuild !== false. Returns that BuildableUnit | null.
    // (src interleaves the value fn with a SYNC canBuild and short-circuits on the
    // first valid best-value tile; probing in descending value order and taking
    // the first buildable yields the SAME tile src's loop picks — the highest-
    // value buildable in the candidate set.)
    async structureSpawnTile(type, options = {}) {
      const requestedCandidateLimit = Number(options.candidateLimit);
      const candidateLimit = Number.isInteger(requestedCandidateLimit)
        ? Math.max(
            1,
            Math.min(
              STRUCTURE_PLACEMENT_CANDIDATE_LIMIT,
              requestedCandidateLimit,
            ),
          )
        : STRUCTURE_PLACEMENT_CANDIDATE_LIMIT;
      const requestedProbeLimit = Number(options.probeLimit);
      const probeLimit = Number.isInteger(requestedProbeLimit)
        ? Math.max(1, Math.min(candidateLimit, requestedProbeLimit))
        : candidateLimit;
      const defaultWorkerTimeoutMs =
        typeof WORKER_TIMEOUT_MS === "number" ? WORKER_TIMEOUT_MS : 2500;
      const requestedProbeTimeout = Number(options.probeTimeoutMs);
      const probeTimeoutMs = Number.isFinite(requestedProbeTimeout)
        ? Math.max(1, requestedProbeTimeout)
        : defaultWorkerTimeoutMs;
      const requestedParallelProbeCount = Number(options.parallelProbeCount);
      const parallelProbeCount = Number.isInteger(requestedParallelProbeCount)
        ? Math.max(1, Math.min(probeLimit, requestedParallelProbeCount))
        : 0;
      let tiles =
        type === UNIT.Port
          ? this.randCoastalTileArray(candidateLimit)
          : randTerritoryTileArray(
              this.random,
              this.game,
              this.player,
              candidateLimit,
            );
      if (type === UNIT.SAMLauncher && options.prioritizeStructureCoverage) {
        try {
          const structures = this.player.units(
            UNIT.City,
            UNIT.Factory,
            UNIT.MissileSilo,
            UNIT.Port,
          );
          const coverageTiles = [];
          const coverageTileSet = new Set();
          for (const structure of structures || []) {
            const structureTile = structure.tile();
            if (!coverageTileSet.has(structureTile)) {
              coverageTileSet.add(structureTile);
              coverageTiles.push(structureTile);
            }
            for (const neighbor of this.game.neighbors(structureTile)) {
              if (coverageTiles.length >= candidateLimit) {
                break;
              }
              if (coverageTileSet.has(neighbor)) continue;
              coverageTileSet.add(neighbor);
              coverageTiles.push(neighbor);
            }
            if (coverageTiles.length >= candidateLimit) {
              break;
            }
          }
          if (coverageTiles.length > 0) {
            const remainingCandidateSlots =
              candidateLimit - coverageTiles.length;
            tiles = [
              ...coverageTiles,
              ...tiles
                .filter((tile) => !coverageTileSet.has(tile))
                .slice(0, remainingCandidateSlots),
            ];
          }
        } catch (_error) {
          /* keep the standard territory sample */
        }
      }
      // WIN-FIX: for silos, PREPEND tiles that sit inside friendly SAM coverage (own SAMs
      // first, ally SAMs as fallback) so the ranked probe can actually pick a defended
      // spot — a plain 25-tile random sample often misses the SAM area entirely.
      if (type === UNIT.MissileSilo && state.settings.winFixes) {
        try {
          const samTiles = this.tilesNearFriendlySams(candidateLimit);
          if (samTiles.length > 0) {
            const mergedTiles = [];
            const mergedTileSet = new Set();
            for (const tile of samTiles.concat(tiles)) {
              if (mergedTiles.length >= candidateLimit) {
                break;
              }
              if (mergedTileSet.has(tile)) continue;
              mergedTileSet.add(tile);
              mergedTiles.push(tile);
            }
            tiles = mergedTiles;
          }
        } catch (_e) {
          /* fall back to the random sample */
        }
      }
      if (tiles.length === 0) return null;
      const valueFunction =
        type === UNIT.SAMLauncher && options.prioritizeStructureCoverage
          ? this.threatSamLauncherValue()
          : isLegendaryDifficulty()
            ? this.legendaryStructureSpawnTileValue(type)
            : this.structureSpawnTileValue(type);
      if (valueFunction === null) return null;

      let emergencySamDefense = false;
      let emergencyProductiveDefense = false;
      let emergencyMissileContext = null;
      let emergencyMissileEvaluation = null;
      let emergencyMissileTick = null;
      let emergencyMissileStateKey = null;
      if (isLegendaryDifficulty()) {
        emergencyMissileTick = Number(this.game.ticks?.());
        emergencyMissileContext = this.getMissileDefenseContext();
        emergencyMissileEvaluation = this.getMissileDefenseEvaluation(
          emergencyMissileContext,
        );
        emergencyProductiveDefense =
          emergencyMissileEvaluation.hasThreats &&
          !emergencyMissileEvaluation.fullyDefended;
        emergencySamDefense =
          type === UNIT.SAMLauncher && emergencyProductiveDefense;
        if (emergencyProductiveDefense) {
          emergencyMissileStateKey = this.missileDefenseStateFingerprint();
        }
      }

      // Score all candidates synchronously, then sort DESC by value.
      const scored = tiles.map((t) => ({ t, v: valueFunction(t) }));
      scored.sort((a, b) => b.v - a.v);

      // The hostile-silo response is intentionally bounded more tightly than
      // the faithful generic placement path. Its candidate scorer walks our
      // protected structures and existing SAM network, and each buildability
      // check crosses the worker boundary. Probe the best bounded subset in
      // parallel so a saturated/slow worker cannot stall the structure tick
      // once an enemy reaches the high-gold threat gate.
      if (parallelProbeCount > 0) {
        const probeCandidates = [];
        for (const { t } of scored) {
          if (
            emergencyProductiveDefense &&
            !this.missileDefenseSnapshotIsCurrent(
              emergencyMissileTick,
              emergencyMissileStateKey,
            )
          ) {
            return null;
          }
          if (
            emergencySamDefense &&
            !this.legendarySamConstructionSafeForTile(t, emergencyMissileContext)
          ) {
            continue;
          }
          if (
            emergencyProductiveDefense &&
            type !== UNIT.SAMLauncher &&
            this.legendaryTileInsideUninterceptedBlast(
              t,
              emergencyMissileContext,
              emergencyMissileEvaluation,
            )
          ) {
            continue;
          }
          probeCandidates.push(t);
          if (probeCandidates.length >= parallelProbeCount) break;
        }

        const buildables = await Promise.all(
          probeCandidates.map((tile) =>
            this.buildableFor(type, tile, probeTimeoutMs),
          ),
        );
        if (
          emergencyProductiveDefense &&
          !this.missileDefenseSnapshotIsCurrent(
            emergencyMissileTick,
            emergencyMissileStateKey,
          )
        ) {
          return null;
        }
        for (const bu of buildables) {
          if (bu !== null && bu.canBuild !== false) return bu;
        }
        return null;
      }

      // Probe down the ranked list; first canBuild !== false wins.
      let probes = 0;
      for (const { t } of scored) {
        if (
          emergencyProductiveDefense &&
          !this.missileDefenseSnapshotIsCurrent(
            emergencyMissileTick,
            emergencyMissileStateKey,
          )
        ) {
          // The safety forecast was captured before an async buildable probe.
          // Abort rather than place a structure using an older missile/SAM
          // snapshot; the next bot tick will rank against fresh state.
          return null;
        }
        if (
          emergencySamDefense &&
          !this.legendarySamConstructionSafeForTile(t, emergencyMissileContext)
        ) {
          continue;
        }
        if (
          emergencyProductiveDefense &&
          type !== UNIT.SAMLauncher &&
          this.legendaryTileInsideUninterceptedBlast(
            t,
            emergencyMissileContext,
            emergencyMissileEvaluation,
          )
        ) {
          continue;
        }
        const bu = await this.buildableFor(type, t, probeTimeoutMs);
        probes++;
        if (
          emergencyProductiveDefense &&
          !this.missileDefenseSnapshotIsCurrent(
            emergencyMissileTick,
            emergencyMissileStateKey,
          )
        ) {
          // The probe may have crossed a game tick or changed a friendly SAM.
          // Do not emit a buildable result based on the stale safety snapshot.
          return null;
        }
        if (bu !== null && bu.canBuild !== false) {
          return bu;
        }
        if (probes >= probeLimit) break;
      }
      return null;
    }

    // Probe a stable unit list with bounded concurrency. Defensive upgrade
    // paths can have many SAMs once hostile silos appear; awaiting every worker
    // request serially turns a slow buildables worker into a visible game hang.
    // Results retain the input order so the caller's selection/ranking logic is
    // unchanged.
    async buildableForUnits(units, type, options = {}) {
      const candidates = Array.isArray(units) ? units : [];
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
          try {
            const tile = unit?.tile?.();
            if (tile === null || tile === undefined) continue;
            results[index] = await this.buildableFor(
              type,
              tile,
              options.timeoutMs,
            );
          } catch (_error) {
            results[index] = null;
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
      const defaultWorkerTimeoutMs =
        typeof WORKER_TIMEOUT_MS === "number" ? WORKER_TIMEOUT_MS : 2500;
      const timeout = Number.isFinite(Number(timeoutMs))
        ? Math.max(1, Number(timeoutMs))
        : defaultWorkerTimeoutMs;
      try {
        buildables = await withTimeout(
          this.player.buildables(tile, [type]),
          timeout,
          null,
        );
      } catch (_e) {
        return null;
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
      try {
        if (!game.isShore(tile)) return false;
        for (const neighbor of game.neighbors(tile) || []) {
          if (game.isWater(neighbor) && game.isOcean(neighbor)) return true;
        }
      } catch (_error) {
        // Fail closed: an unavailable ocean predicate must never authorize a
        // port on an unknown or potentially closed water component.
      }
      return false;
    }

    hasOceanPortTiles() {
      try {
        return Array.from(this.player.borderTiles()).some((tile) =>
          this.isOceanPortTile(tile),
        );
      } catch (_error) {
        return false;
      }
    }

    randCoastalTileArray(numTiles) {
      const tiles = Array.from(this.player.borderTiles()).filter((tile) =>
        this.isOceanPortTile(tile),
      );
      return Array.from(this.arraySampler(tiles, numTiles));
    }

    // arraySampler — NationStructureBehavior.ts:854 (generator).
    *arraySampler(a, sampleSize) {
      if (a.length <= sampleSize) {
        // Return all elements
        yield* a;
      } else {
        // Sample `sampleSize` elements
        const remaining = new Set(a);
        while (sampleSize--) {
          const t = this.random.randFromSet(remaining);
          remaining.delete(t);
          yield t;
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
          value += this.legendarySamCoveragePlacementScore(tile, missileContext);
          if (missileContext.critical) value += spacing * 2;
        }

        return value;
      };
    }

    legendaryRailConnectivityPlacementScore(tile) {
      try {
        const config = this.game.config();
        const stations = this.getOrBuildReachableStations();
        const score = this.computeConnectivityScore(
          tile,
          stations,
          config.trainStationMinRange() ** 2,
          config.trainStationMaxRange() ** 2,
        );
        return score * this.spacingConstants().structureSpacing;
      } catch (_error) {
        return 0;
      }
    }

    legendarySamCoveragePlacementScore(tile, missileContext = null) {
      let score = 0;
      let range = 0;
      try {
        range = Number(this.game.config().defaultSamRange());
      } catch (_error) {
        return 0;
      }
      if (range <= 0) return 0;
      const rangeSquared = range * range;
      const existingSams = this.legendaryFriendlySamUnits();
      const structures = this.player.units(
        UNIT.City,
        UNIT.Factory,
        UNIT.Port,
        UNIT.MissileSilo,
      );
      for (const structure of structures) {
        if (
          this.game.euclideanDistSquared(tile, structure.tile()) >
          rangeSquared
        ) {
          continue;
        }
        const alreadyCovered = existingSams.some((sam) => {
          const samRange = Number(this.game.config().samRange(sam.level()));
          return (
            this.game.euclideanDistSquared(tile, sam.tile()) <=
            samRange * samRange
          );
        });
        if (!alreadyCovered) {
          score +=
            this.spacingConstants().structureSpacing *
            this.legendaryCriticalStructureValue(structure);
        }
      }
      return (
        score +
        this.legendarySamImpactMarginScore(
          tile,
          missileContext || this.getMissileDefenseContext(),
          1,
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
      try {
        cfg = game.config();
      } catch (_e) {
        return 0;
      }
      const maxRange = cfg && cfg.maxSamRange ? Number(cfg.maxSamRange()) : 200;
      let nearby;
      try {
        nearby = game.nearbyUnits(tile, maxRange, UNIT.SAMLauncher);
      } catch (_e) {
        return 0;
      }
      const mySid = this.player.smallID();
      let bestOwn = -1;
      let bestAlly = -1;
      for (const s of nearby || []) {
        const unit = s.unit || s;
        const owner = unit.owner && unit.owner();
        if (!owner) continue;
        if (unit.isUnderConstruction && unit.isUnderConstruction()) continue;
        const isOwn = owner.smallID && owner.smallID() === mySid;
        const isAlly = !isOwn && this.player.isFriendly(owner) === true;
        if (!isOwn && !isAlly) continue; // only OUR + ALLY SAMs protect us
        const level = (unit.level && Number(unit.level())) || 1;
        const range = cfg && cfg.samRange ? Number(cfg.samRange(level)) : 0;
        if (range <= 0) continue;
        let distSq = s.distSquared;
        if (distSq == null && game.euclideanDistSquared && unit.tile) {
          distSq = game.euclideanDistSquared(tile, unit.tile());
        }
        if (distSq == null || distSq > range * range) continue; // outside this SAM
        const closeness = range - Math.sqrt(distSq); // bigger = closer to the SAM
        if (isOwn) {
          if (closeness > bestOwn) bestOwn = closeness;
        } else if (closeness > bestAlly) {
          bestAlly = closeness;
        }
      }
      if (bestOwn >= 0) return 100000 + bestOwn;
      if (bestAlly >= 0) return 50000 + bestAlly;
      return 0;
    }

    // tilesNearFriendlySams — OUR-territory tiles that lie inside a friendly SAM's range.
    // Prefers OUR SAMs; only if we have none does it fall back to ALLY SAMs (user rule).
    // Returns up to maxTiles candidate TileRefs to feed silo placement.
    tilesNearFriendlySams(maxTiles) {
      const game = this.game;
      if (typeof game.nearbyUnits !== "function" && typeof game.units !== "function") {
        return [];
      }
      const mySid = this.player.smallID();
      let allSams = [];
      try {
        allSams = game.units(UNIT.SAMLauncher) || [];
      } catch (_e) {
        return [];
      }
      const own = [];
      const ally = [];
      for (const u of allSams) {
        try {
          if (u.isUnderConstruction && u.isUnderConstruction()) continue;
          const owner = u.owner && u.owner();
          if (!owner) continue;
          if (owner.smallID && owner.smallID() === mySid) own.push(u);
          else if (this.player.isFriendly(owner) === true) ally.push(u);
        } catch (_e) {
          /* skip */
        }
      }
      const useSams = own.length > 0 ? own : ally; // OUR SAMs first, else allies
      if (useSams.length === 0) return [];
      let cfg;
      try {
        cfg = game.config();
      } catch (_e) {
        return [];
      }
      const out = [];
      const seen = new Set();
      for (const unit of useSams) {
        const samTile = unit.tile();
        const cx = game.x(samTile);
        const cy = game.y(samTile);
        const level = (unit.level && Number(unit.level())) || 1;
        const range = cfg && cfg.samRange ? Number(cfg.samRange(level)) : 0;
        if (range <= 0) continue;
        const r = Math.floor(range);
        const step = Math.max(2, Math.floor(r / 6));
        for (let dx = -r; dx <= r; dx += step) {
          for (let dy = -r; dy <= r; dy += step) {
            if (dx * dx + dy * dy > range * range) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (!game.isValidCoord(nx, ny)) continue;
            const t = game.ref(nx, ny);
            if (seen.has(t)) continue;
            if (!game.isLand(t)) continue;
            if (game.ownerID(t) !== mySid) continue; // can only build on OUR land
            seen.add(t);
            out.push(t);
            if (out.length >= maxTiles) return out;
          }
        }
      }
      return out;
    }

    // portValue — NationStructureBehavior.ts:925.
    // NOTE: pure port-spacing; does NOT consume the water shim.
    portValue() {
      const game = this.game;
      const otherUnits = this.player.units(UNIT.Port);

      return (tile) => {
        let w = 0;

        // Prefer to be as far as possible from other ports
        const otherTiles = new Set(otherUnits.map((u) => u.tile()));
        otherTiles.delete(tile);
        const closest = closestTile(game, otherTiles, tile);
        const closestOtherDist = closest[1];
        w += closestOtherDist;

        return w;
      };
    }

    // factoryValue — NationStructureBehavior.ts:951.
    factoryValue() {
      const game = this.game;
      const player = this.player;
      const borderTiles = this.player.borderTiles();
      const otherUnits = player.units(UNIT.Factory);
      const { borderSpacing, structureSpacing } = this.spacingConstants();
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      const difficulty = currentDifficulty();
      const useConnectionScore = this.shouldUseConnectivityScore(difficulty);

      const reachableStations = useConnectionScore
        ? this.getOrBuildReachableStations()
        : [];
      const minRangeSquared = game.config().trainStationMinRange() ** 2;

      // Cross-type spacing: prefer to be away from cities.
      const cityTiles = new Set(player.units(UNIT.City).map((u) => u.tile()));

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        const closest = closestTile(game, borderTiles, tile);
        const closestBorderDist = closest[1];
        w += Math.min(closestBorderDist, borderSpacing);

        // Prefer to be away from other factories
        const otherTiles = new Set(otherUnits.map((u) => u.tile()));
        otherTiles.delete(tile);
        const closestOther = closestTwoTiles(game, otherTiles, [tile]);
        if (closestOther !== null) {
          const d = game.manhattanDist(closestOther.x, tile);
          w += Math.min(d, stationRange);
        }

        // Prefer to be away from cities (cross-type spacing)
        const closestCity = closestTwoTiles(game, cityTiles, [tile]);
        if (closestCity !== null) {
          const d = game.manhattanDist(closestCity.x, tile);
          w += Math.min(d, structureSpacing);
        }

        if (!useConnectionScore) {
          return w;
        }

        w +=
          this.computeConnectivityScore(
            tile,
            reachableStations,
            minRangeSquared,
            stationRangeSquared,
          ) * structureSpacing;

        return w;
      };
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
    buildReachableStations() {
      const game = this.game;
      const player = this.player;

      const maxTradeGold = Math.max(
        Number(this.trainGoldBase("ally", 0)),
        1,
      );

      // 1) Collect all stationed structures (own + non-bot tradeable neighbors)
      //    with their normalized trade weights. This logic is IDENTICAL to src
      //    and shared by both cluster-assignment paths.
      const stationed = []; // { tile, weight, key (unit id) }

      const selfWeight =
        Number(this.trainGoldBase("self", 0)) / maxTradeGold;
      for (const unit of player.units(UNIT.City, UNIT.Port, UNIT.Factory)) {
        if (!unit.hasTrainStation()) continue;
        stationed.push({ tile: unit.tile(), weight: selfWeight, key: unit.id() });
      }

      for (const neighbor of player.nearby()) {
        if (!neighbor.isPlayer || !neighbor.isPlayer()) continue;
        if (neighbor.type() === PlayerType.Bot) continue;
        if (!shimCanTrade(player, neighbor)) continue;
        const relType = player.isOnSameTeam(neighbor)
          ? "team"
          : player.isAlliedWith(neighbor)
            ? "ally"
            : "other";
        const weight =
          Number(this.trainGoldBase(relType, 0)) / maxTradeGold;
        for (const unit of neighbor.units(UNIT.City, UNIT.Port, UNIT.Factory)) {
          if (!unit.hasTrainStation()) continue;
          stationed.push({ tile: unit.tile(), weight, key: unit.id() });
        }
      }

      if (stationed.length === 0) return [];

      // 2a) EXTENSION path — real rail clusters from the actual rail tiles.
      let railState = null;
      try {
        railState =
          typeof game.railroadState === "function" ? game.railroadState() : null;
      } catch (_e) {
        railState = null;
      }
      if (railState) {
        const railComp = this.assignRailClusters(stationed, railState);
        if (railComp !== null) {
          const result = [];
          for (let i = 0; i < stationed.length; i++) {
            result.push({
              tile: stationed[i].tile,
              cluster: railComp[i], // rail-component id, or null if isolated
              weight: stationed[i].weight,
            });
          }
          return result;
        }
        // assignRailClusters returned null (unexpected) → fall through to proximity.
      }

      // 2b) HARNESS / fallback path — proximity union-find (APPROXIMATION).
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
      const result = [];
      for (const s of stationed) {
        result.push({
          tile: s.tile,
          cluster: uf.find(s.key),
          weight: s.weight,
        });
      }
      return result;
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
      try {
        const game = this.game;
        const width = game.width();
        const height = game.height();
        const total = width * height;
        // Lazily flood-fill rail tiles into components, on demand from each
        // station seed, memoizing labels so the total work is O(rail tiles).
        const railLabel = new Int32Array(total).fill(-1); // -1 = unlabeled rail/none
        let nextRailId = 0;

        const labelFrom = (seed) => {
          // seed is a rail tile with no label yet; BFS its component.
          const id = nextRailId++;
          const queue = [seed];
          railLabel[seed] = id;
          let head = 0;
          while (head < queue.length) {
            const cur = queue[head++];
            for (const n of game.neighbors(cur)) {
              if (
                n >= 0 &&
                n < total &&
                railState[n] !== 0 &&
                railLabel[n] === -1
              ) {
                railLabel[n] = id;
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
            if (railLabel[tile] === -1) labelFrom(tile);
            return railLabel[tile];
          }
          for (const n of game.neighbors(tile)) {
            if (n >= 0 && n < total && railState[n] !== 0) {
              if (railLabel[n] === -1) labelFrom(n);
              return railLabel[n];
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
      } catch (_e) {
        return null;
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
      const borderTiles = player.borderTiles();
      const otherUnits = player.units(UNIT.City);
      const { borderSpacing, structureSpacing } = this.spacingConstants();
      const stationRange = game.config().trainStationMaxRange();
      const stationRangeSquared = stationRange * stationRange;
      const difficulty = currentDifficulty();
      const useConnectionScore = this.shouldUseConnectivityScore(difficulty);

      const reachableStations = useConnectionScore
        ? this.getOrBuildReachableStations()
        : [];
      const minRangeSquared = game.config().trainStationMinRange() ** 2;

      // Cross-type spacing: prefer to be away from factories.
      const factoryTiles = new Set(
        player.units(UNIT.Factory).map((u) => u.tile()),
      );

      return (tile) => {
        let w = 0;

        w += game.magnitude(tile);

        const closest = closestTile(game, borderTiles, tile);
        const closestBorderDist = closest[1];
        w += Math.min(closestBorderDist, borderSpacing);

        const otherTiles = new Set(otherUnits.map((u) => u.tile()));
        otherTiles.delete(tile);
        const closestOther = closestTwoTiles(game, otherTiles, [tile]);
        if (closestOther !== null) {
          const d = game.manhattanDist(closestOther.x, tile);
          w += Math.min(d, structureSpacing);
        }

        // Prefer to be away from factories (cross-type spacing)
        const closestFactory = closestTwoTiles(game, factoryTiles, [tile]);
        if (closestFactory !== null) {
          const d = game.manhattanDist(closestFactory.x, tile);
          w += Math.min(d, structureSpacing);
        }

        if (!useConnectionScore) {
          return w;
        }

        w +=
          this.computeConnectivityScore(
            tile,
            reachableStations,
            minRangeSquared,
            stationRangeSquared,
          ) * structureSpacing;

        return w;
      };
    }

    // Mandatory hostile-silo response: maximize total structure coverage first,
    // then prefer tiles that add coverage beyond the existing SAM network.
    threatSamLauncherValue() {
      const game = this.game;
      const player = this.player;
      let structures;
      let existingSams;
      let config;
      let range;
      try {
        structures = player.units(
          UNIT.City,
          UNIT.Factory,
          UNIT.MissileSilo,
          UNIT.Port,
        );
        existingSams = player.units(UNIT.SAMLauncher);
        config = game.config();
        range = Number(config.defaultSamRange());
      } catch (_error) {
        return () => 0;
      }
      if (!Array.isArray(structures) || !Number.isFinite(range) || range <= 0) {
        return () => 0;
      }

      const rangeSquared = range * range;
      const structureCount = structures.length;
      const structureTiles = [];
      for (const structure of structures) {
        if (!structure || typeof structure.tile !== "function") continue;
        try {
          const tile = structure.tile();
          if (tile !== null && tile !== undefined) structureTiles.push(tile);
        } catch (_error) {
          /* skip a stale structure reference */
        }
      }
      const existingSamProfiles = (existingSams || [])
        .filter((sam) => {
          try {
            return !(
              typeof sam.isUnderConstruction === "function" &&
              sam.isUnderConstruction()
            );
          } catch (_error) {
            return false;
          }
        })
        .map((sam) => {
          try {
            const samRange = Number(config.samRange(sam.level()));
            return {
              tile: sam.tile(),
              rangeSquared: samRange * samRange,
            };
          } catch (_error) {
            return null;
          }
        })
        .filter((sam) => sam !== null && Number.isFinite(sam.rangeSquared));
      return (tile) => {
        let totalCoverage = 0;
        let newCoverage = 0;
        for (const structureTile of structureTiles) {
          let distanceSquared;
          try {
            distanceSquared = game.euclideanDistSquared(tile, structureTile);
          } catch (_error) {
            continue;
          }
          if (distanceSquared > rangeSquared) continue;
          totalCoverage++;

          const alreadyCovered = existingSamProfiles.some((sam) => {
            try {
              return (
                game.euclideanDistSquared(tile, sam.tile) <=
                sam.rangeSquared
              );
            } catch (_error) {
              return false;
            }
          });
          if (!alreadyCovered) newCoverage++;
        }

        // The first term makes the literal structure count dominant without an
        // arbitrary score constant; the second term breaks ties toward new cover.
        return totalCoverage * (structureCount + 1) + newCoverage;
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
      for (const unit of player.units()) {
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

      const useCoverageWeighting = isLegendaryDifficulty(difficulty)
        ? true
        : difficulty !== Difficulty.Easy && this.random.nextInt(0, 100) < 25;

      // Pre-compute existing SAM coverage for each protectable structure.
      let structureCoverage = null;
      if (useCoverageWeighting) {
        structureCoverage = new Map();
        const existingSams = player.units(UNIT.SAMLauncher);
        for (const entry of protectEntries) {
          let coverageScore = 0;
          for (const sam of existingSams) {
            const samRange = game.config().samRange(sam.level());
            const dist = game.euclideanDistSquared(entry.tile, sam.tile());
            if (dist <= samRange * samRange) {
              coverageScore += sam.level();
            }
          }
          structureCoverage.set(entry.tile, coverageScore);
        }
      }

      return (tile) => {
        let w = 0;

        // Prefer higher elevations
        w += game.magnitude(tile);

        // Prefer to be away from the border
        const closestBorder = closestTwoTiles(game, borderTiles, [tile]);
        if (closestBorder !== null) {
          const d = game.manhattanDist(closestBorder.x, tile);
          w += Math.min(d, borderSpacing);
        }

        // Prefer to be away from other structures of the same type
        const otherTiles = new Set(otherUnits.map((u) => u.tile()));
        otherTiles.delete(tile);
        const closestOther = closestTwoTiles(game, otherTiles, [tile]);
        if (closestOther !== null) {
          const d = game.manhattanDist(closestOther.x, tile);
          w += Math.min(d, structureSpacing);
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

        return w;
      };
    }

    // spacingConstants — NationStructureBehavior.ts:1323.
    spacingConstants() {
      const borderSpacing = this.game
        .config()
        .nukeMagnitudes(UNIT.AtomBomb).outer;
      return { borderSpacing, structureSpacing: borderSpacing * 2 };
    }
  }
