  // Deliberately lowercase (not fixture-tracked): the strongest enemy's
  // built-silo level sum at which SAM SITE count starts scaling (see
  // samSiteCountTarget). 3+ is rich-profile (5MM/25MM) mass; ordinary
  // profiles never field it before their one-site lanes resolve.
  const hostileSamSiteScaleLevelSum = 3;

  /** OpenFront's SAM upgrade ladder currently tops out at level five. */
  const HYDROGEN_SAM_MAX_UPGRADE_LEVEL = 5;
  // Intermediate interceptor readiness for the port-funded adaptive tier:
  // level two SAM range already covers most atom trajectories at a fraction
  // of the level-five climb, so the first earmarked upgrade lands inside the
  // game horizon instead of starving the bombardment.
  const LEGENDARY_PORT_FUNDED_SAM_READY_LEVEL = 2;

  /** MirvExecution scatters candidate destinations across this map radius. */
  const MIRV_CARRIER_TARGET_RADIUS = 1500;

  /** Ratio per city used for the first missile silo so nations start nuking earlier */
  const FIRST_MISSILE_SILO_RATIO = 0.2;

  /** If we have more than this many structures per tiles, prefer upgrading over building */
  const UPGRADE_DENSITY_THRESHOLD = 1 / 1500;

  /**
   * Fraction of maxTroops at or above which troop production has effectively
   * stalled (the engine's growth rate scales with the remaining headroom).
   * Every further troop-second near the ceiling is lost unless the cap itself
   * grows, so this signal makes City build/upgrade spending prioritary.
   */
  const TROOP_CAP_PRESSURE_RATIO = 0.9;
  // Density floor for the adaptive tier: below ~25 troops per tile a wave
  // captures land faster than losses accumulate, so City spending resumes
  // regardless of the cap ratio. Ignored on tiny territories where spawn
  // blobs and probes dominate the ratio.
  const LEGENDARY_DENSITY_FLOOR_TROOPS_PER_TILE = 25;
  const LEGENDARY_DENSITY_FLOOR_MIN_TILES = 4000;

  /** Bound the per-level City upgrade cost history like the SAM upgrade cache. */
  const CITY_UPGRADE_COST_CACHE_LIMIT = 32;

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

  /**
   * A bordering Nation/Human opponent whose standing troop count reaches this
   * fraction of our own troops makes the shared frontier a strategic threat
   * even before any attack is launched: the first dogpile wave would land long
   * before a Post's long construction could finish.
   */
  const STRATEGIC_DEFENSE_POST_TROOP_RATIO = 1;

  /**
   * Concurrent Defense Posts the strategic border rule may authorize without a
   * live attack. Live-attack authorization keeps its own ratio-derived budget
   * and is never clamped by this cap.
   */
  const PREEMPTIVE_DEFENSE_POST_MAX_POSTS = 2;

  // Front-scaled budget on top of that base: a single snowballed neighbor can
  // share a 1300-2000 tile front where two posts are decorative (sam-B
  // receipt: 2 posts all match, 47k -> 22 tile collapse in ~140 ticks). Every
  // extra post still re-clears the Legendary surplus gold gate on each
  // decision tick, so the historical zero-threat Baikal drain stays blocked.
  const PREEMPTIVE_DEFENSE_POST_FRONT_FLOOR = 400;
  const PREEMPTIVE_DEFENSE_POST_FRONT_TILES_PER_POST = 700;
  const PREEMPTIVE_DEFENSE_POST_MAX_POSTS_CEILING = 6;
