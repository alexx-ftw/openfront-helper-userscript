// Spawn heatmap overlay — faithful port of Tactical spawn-scoring.js +
// map-heatmap-overlay.js. Scores every grid cell by spawn quality and renders
// a colored heatmap + top-5 diverse spots. Auto-hides after spawn phase.
//
// TWO-PHASE scoring (exactly matching Tactical):
//   Phase 1 — STATIC (computed once per map): land density, plains ratio,
//             edge avoidance.
//   Phase 2 — DYNAMIC (recomputed every 250ms during spawn): adds player
//             distance from spawn intents, enemy pressure, team spawn pull,
//             and proximity to tribe/nation expansion targets.
//
// Player positions come from SPAWN INTENTS (turn.intents with type==="spawn"),
// not from current player positions — this is critical: the Tactical tracks
// where players ARE SPAWNING, not where they currently are.

  const SPAWN_HEATMAP_GRID_STEP = 16;
  const SPAWN_HEATMAP_ANALYSIS_R = 30;
  const SPAWN_HEATMAP_TRIBE_R = 140;
  const SPAWN_HEATMAP_TRIBE_REACH_BASE_R = 80;
  const SPAWN_HEATMAP_TRIBE_REACH_BONUS_R = 160;
  const SPAWN_HEATMAP_NATION_R = 120;
  const SPAWN_HEATMAP_PLAYER_R = 150;
  const SPAWN_HEATMAP_CELL = 14;
  const SPAWN_HEATMAP_MAX_CELLS = 1200;
  // Keep the fallback scorer bounded to the same number of cells that can be
  // drawn. Exact bot ranking is still map-resolution, but large maps use this
  // deterministic visual path while the exact result is built incrementally.
  const SPAWN_HEATMAP_MAX_STATIC_CANDIDATES = SPAWN_HEATMAP_MAX_CELLS;
  const SPAWN_HEATMAP_TOP_N = 5;
  const EXACT_SPAWN_CANDIDATE_POOL_SIZE = SPAWN_HEATMAP_TOP_N * 8;
  const SPAWN_TOP_SPOT_MIN_DISTANCE = 60;
  const SPAWN_HEATMAP_ENEMY_PRESSURE_R = 220;
  const SPAWN_HEATMAP_TEAM_ATTRACT_R = 110;
  const SPAWN_HEATMAP_TEAM_MIN_GAP = 30;
  const SPAWN_HEATMAP_TEAM_IDEAL_MAX = 90;
  const SPAWN_HEATMAP_TEAM_OVERLAP_MAX = 0.4;
  const SPAWN_HEATMAP_TEAM_CENTROID_R = 260;

  // The exact selector keeps ten map-sized typed arrays plus transient terrain
  // and occupancy copies. Keep its optional peak allocation below 32 MiB; larger maps
  // use the already bounded visual scorer instead of risking a tab-wide OOM.
  const SPAWN_INDEX_ESTIMATED_BYTES_PER_CELL = 24;
  const SPAWN_INDEX_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;

  // Weights for the visual/fallback base score. The exact bot selector uses the
  // replay-free robust objective below; clan cohesion is only a late tie-break.
  const SPAWN_W = {
    land: 0.25,
    plains: 0.2,
    tribe: 0.25,
    nation: 0.25,
    player: 0.25,
    edge: 0.05,
    team: 0.2,
    // Retained for the exact selector's diagnostic score; ranking applies clan
    // cohesion only after free-land availability and tribal expansion.
    clan: 0.25,
    teamCentroid: 0.08,
    enemyPressure: 0.12,
  };

  // ── Raw terrain access (THE anti-lag fix) ──────────────────────────────
  // Tactical is smooth because it reads the map's raw Uint8Array terrain buffer
  // (terrain[y*width+x]) instead of calling game.isLand()/magnitude() millions of
  // times through the GameView proxy. We get the SAME buffer straight off the
  // client GameView (gv._map.terrain — TS `private` is not enforced at runtime),
  // so no fetch hook is needed. Byte layout (GameMapImpl): bit 7 = land, low 5
  // bits = magnitude. If the buffer can't be reached (e.g. minified property
  // names), we bulk-read it once via the proxy into a local Uint8Array — a single
  // O(W*H) pass instead of the old ~15M repeated proxy calls.
  const SPAWN_IS_LAND_BIT = 7;
  const SPAWN_MAGNITUDE_MASK = 31;
  function isLandByte(byte) {
    return (byte & (1 << SPAWN_IS_LAND_BIT)) !== 0;
  }
  function isPassableLandByte(byte) {
    return isLandByte(byte) && (byte & SPAWN_MAGNITUDE_MASK) !== 31;
  }
  function isPlainsByte(byte) {
    return isPassableLandByte(byte) && (byte & SPAWN_MAGNITUDE_MASK) < 10;
  }

  let _spawnTerrainCache = null; // { terrain, W, H, raw }
  let _spawnTerrainSrcRef = null;
  function spawnTerrainDimensions(game, fallback = {}) {
    try {
      return {
        W: game.width ? game.width() : fallback.W ?? 0,
        H: game.height ? game.height() : fallback.H ?? 0,
      };
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:spawnTerrainDimensions");
      return { W: fallback.W ?? 0, H: fallback.H ?? 0 };
    }
  }

  function cachedSpawnTerrainIsCurrent(game, src) {
    if (_spawnTerrainSrcRef !== src || !_spawnTerrainCache) return false;
    const dimensions = spawnTerrainDimensions(game, _spawnTerrainCache);
    let currentRaw = null;
    try {
      currentRaw = src?._map?.terrain ?? null;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:cachedSpawnTerrainIsCurrent");
    }
    const sameShape = dimensions.W === _spawnTerrainCache.W &&
      dimensions.H === _spawnTerrainCache.H;
    const sameTerrain = _spawnTerrainCache.raw
      ? !currentRaw || currentRaw === _spawnTerrainCache.terrain : !currentRaw;
    return sameShape && sameTerrain;
  }

  function rememberSpawnTerrain(src, terrain, W, H, raw) {
    _spawnTerrainCache = { terrain, W, H, raw };
    _spawnTerrainSrcRef = src;
    return _spawnTerrainCache;
  }

  function rawSpawnTerrain(src, W, H) {
    try {
      const terrain = src?._map?.terrain;
      return terrain && typeof terrain.length === "number" && terrain.length >= W * H
        ? terrain : null;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:rawSpawnTerrain");
      return null;
    }
  }

  function reconstructSpawnTerrain(game, W, H) {
    const terrain = new Uint8Array(W * H);
    const terrainByte = typeof game.terrainByte === "function"
      ? (ref) => game.terrainByte(ref) : null;
    for (let ref = 0; ref < terrain.length; ref += 1) {
      const byte = terrainByte ? terrainByte(ref) : reconstructedTerrainByte(game, ref);
      if (isLandByte(byte)) {
        terrain[ref] = (1 << SPAWN_IS_LAND_BIT) | (byte & SPAWN_MAGNITUDE_MASK);
      }
    }
    return terrain;
  }

  function reconstructedTerrainByte(game, ref) {
    if (!game.isLand(ref)) return 0;
    const magnitude = game.magnitude ? game.magnitude(ref) & SPAWN_MAGNITUDE_MASK : 0;
    return (1 << SPAWN_IS_LAND_BIT) | magnitude;
  }

  function getSpawnTerrain(game) {
    const src = (game && game.__src) || game;
    if (cachedSpawnTerrainIsCurrent(game, src)) return _spawnTerrainCache;
    const { W, H } = spawnTerrainDimensions(game);
    if (W <= 0 || H <= 0) return null;

    const raw = rawSpawnTerrain(src, W, H);
    if (raw) return rememberSpawnTerrain(src, raw, W, H, true);

    // Fallback: reconstruct the buffer once via the proxy (O(W*H), one-time).
    // Prefer terrainByte() — a single public proxy call per tile that returns the
    // exact game byte (IS_LAND_BIT=7 + MAGNITUDE_MASK=0x1f match our constants),
    // half the calls of isLand()+magnitude() and guaranteed to exist on every
    // build. Only fall back to the two-call form if terrainByte is unavailable.
    try {
      return rememberSpawnTerrain(src, reconstructSpawnTerrain(game, W, H), W, H, false);
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:149");
      return null;
    }
  }

  // ── Exact candidate index ──────────────────────────────────────────────
  // The heatmap remains a cheap visual approximation, but the bot gets an
  // exact, map-resolution candidate set from spawn-index.js. Building is
  // incremental so a large/new map never monopolizes the main thread.
  let _spawnCandidateIndex = null;
  let _spawnCandidateIndexSrcRef = null;
  let _spawnCandidateIndexTerrainRef = null;
  let _spawnCandidateBuildScheduled = false;
  let _spawnIntentVersion = 0;

  function getSpawnIndexApi() {
    try {
      return typeof globalThis === "object" ? globalThis.__OFHSpawnIndex : null;
    } catch (_error) {
      return null;
    }
  }

  function getSpawnObjectiveApi() {
    try {
      return typeof globalThis === "object" ? globalThis.__OFHSpawnObjective : null;
    } catch (_error) {
      return null;
    }
  }

  function rawSpawnMapState(game, size) {
    try {
      const state = (game?.__src ?? game)?._map?.state;
      return state && typeof state.length === "number" && state.length >= size
        ? state : null;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:rawSpawnMapState");
      return null;
    }
  }

  function getSpawnBlockedSnapshot(game, size) {
    const blocked = new Uint8Array(size);
    const state = rawSpawnMapState(game, size);
    if (state) {
      for (let ref = 0; ref < size; ref += 1) blocked[ref] = state[ref] & 0x0fff ? 1 : 0;
      return blocked;
    }

    if (typeof game.hasOwner !== "function") return blocked;
    for (let ref = 0; ref < size; ref += 1) {
      try {
        blocked[ref] = game.hasOwner(ref) ? 1 : 0;
      } catch (_error) {
        captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:getSpawnBlockedSnapshot");
      }
    }
    return blocked;
  }

  function scheduleSpawnCandidateBuild(index) {
    if (!index || index.ready || _spawnCandidateBuildScheduled) return;
    _spawnCandidateBuildScheduled = true;

    const run = (deadline) => {
      _spawnCandidateBuildScheduled = false;
      if (index !== _spawnCandidateIndex) return;
      if (deadline && typeof deadline.timeRemaining === "function") {
        while (!index.ready && deadline.timeRemaining() > 0) index.buildSlice();
      } else {
        index.buildSlice();
      }
      if (!index.ready) scheduleSpawnCandidateBuild(index);
    };

    try {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run);
        return;
      }
    } catch (_error) { /* use timer fallback */ }
    setTimeout(run, 0);
  }

  function cachedAsyncExactSpawnResult(src, indexVersion, signature) {
    const matches = _asyncExactSpawnResultSrcRef === src &&
      _asyncExactSpawnResultIndexVersion === indexVersion &&
      _asyncExactSpawnResultSignature === signature;
    return matches ? _asyncExactSpawnResult : undefined;
  }

  function asyncExactJobMatches(job, src, index, indexVersion) {
    return Boolean(job && !job.done && job.src === src && job.index === index &&
      job.indexVersion === indexVersion);
  }

  function ensureSpawnCandidateIndex(game) {
    const api = getSpawnIndexApi();
    const td = getSpawnTerrain(game);
    if (!api || !td || typeof api.create !== "function") return null;
    const mapSize = td.W * td.H;
    if (
      !Number.isSafeInteger(mapSize) ||
      mapSize <= 0 ||
      mapSize * SPAWN_INDEX_ESTIMATED_BYTES_PER_CELL >
        SPAWN_INDEX_MEMORY_BUDGET_BYTES
    ) {
      return null;
    }
    const src = (game && game.__src) || game;
    if (
      _spawnCandidateIndexSrcRef !== src ||
      _spawnCandidateIndexTerrainRef !== td.terrain ||
      !_spawnCandidateIndex
    ) {
      _spawnCandidateIndex = api.create({
        width: td.W,
        height: td.H,
        terrain: td.terrain,
        blocked: getSpawnBlockedSnapshot(game, td.W * td.H),
      });
      _spawnCandidateIndexSrcRef = src;
      _spawnCandidateIndexTerrainRef = td.terrain;
      scheduleSpawnCandidateBuild(_spawnCandidateIndex);
    }
    return _spawnCandidateIndex;
  }

  function resetSpawnCandidateIndex() {
    _spawnCandidateIndex = null;
    _spawnCandidateIndexSrcRef = null;
    _spawnCandidateIndexTerrainRef = null;
    _spawnCandidateBuildScheduled = false;
    _exactSpawnCacheSrcRef = null;
    _exactSpawnCacheIndexVersion = -1;
    _exactSpawnCacheSignature = "";
    _exactSpawnCacheResult = null;
    _asyncExactSpawnJob = null;
    _asyncExactSpawnResultSrcRef = null;
    _asyncExactSpawnResultIndexVersion = -1;
    _asyncExactSpawnResultSignature = "";
    _asyncExactSpawnResult = null;
  }

  function refreshSpawnCandidateTerrain(game, refs = null) {
    const index = ensureSpawnCandidateIndex(game);
    const td = getSpawnTerrain(game);
    if (!index || !td || typeof index.syncTerrain !== "function") return 0;
    if (td.raw) return index.syncTerrain(td.terrain, refs);

    const readByte = (ref) => {
      try {
        if (typeof game.terrainByte === "function") return game.terrainByte(ref);
        if (!game.isLand(ref)) return 0;
        let byte = 1 << SPAWN_IS_LAND_BIT;
        if (typeof game.magnitude === "function") byte |= game.magnitude(ref) & SPAWN_MAGNITUDE_MASK;
        return byte;
      } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:286");
        return 0;
      }
    };
    return index.syncTerrain(readByte, refs);
  }

  function getSpawnAreaForGame(game, me) {
    try {
      const team = me && typeof me.team === "function" ? me.team() : null;
      const src = (game && game.__src) || game;
      if (team !== null && src && typeof src.teamSpawnArea === "function") {
        return src.teamSpawnArea(team) || null;
      }
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:300"); /* FFA or unavailable team API */ }
    return null;
  }

  // Phase 1 cache: static candidates [{x, y, staticScore}]. Computed once per
  // map (when game context changes). Sorted descending by staticScore.
  let _spawnStaticCandidates = null;
  let _spawnStaticGameRef = null;
  let _spawnStaticTerrainRef = null;
  let _spawnStaticWidth = 0;
  let _spawnStaticHeight = 0;

  // Phase 2 cache: final scores + top spots. Recomputed every 250ms.
  let _spawnHeatmapData = null;
  let _spawnHeatmapWasInSpawnPhase = false;

  // Player spawn positions tracked from WebSocket spawn intents.
  // Map: clientID -> {x, y}. Populated by observeSpawnIntents().
  const _spawnPlayerPositions = new Map();
  // Teammate clientIDs — refreshed each scan from getPlayerRelationToMyPlayer.
  const _spawnTeammateClientIds = new Set();

  // ── Spawn intent tracking (from enemy-intent-intel WebSocket hook) ──────
  // The enemy-intent-intel module already intercepts WS messages. We hook
  // into its processWsMessage to also extract spawn intents.

  function observeSpawnIntentsFromTurn(turn) {
    if (!turn || !Array.isArray(turn.intents)) return;
    for (let i = 0; i < turn.intents.length; i += 1) {
      const intent = turn.intents[i];
      if (!intent || intent.type !== "spawn") continue;
      if (intent.clientID == null) continue;
      const tile = Number(intent.tile);
      if (!Number.isFinite(tile)) continue;
      // We need world coords — but we don't have game.x(tile) here.
      // Store the tile; convert to world coords during scan.
      const previous = _spawnPlayerPositions.get(intent.clientID);
      if (!previous || previous.tile !== tile) _spawnIntentVersion += 1;
      _spawnPlayerPositions.set(intent.clientID, { tile });
    }
  }

  // enemy-intent-intel.js calls this hook after its own processing. Keep this
  // hook one-way: calling processWsMessage() back here would recurse forever.
  function spawnHeatmapProcessWsMessage(data) {
    // Extract spawn intents.
    if (!data || typeof data !== "object") return;
    try {
      if (data.type === "turn" && data.turn) {
        observeSpawnIntentsFromTurn(data.turn);
      } else if (data.type === "start" && Array.isArray(data.turns)) {
        for (let i = 0; i < data.turns.length; i += 1) {
          observeSpawnIntentsFromTurn(data.turns[i]);
        }
      }
    } catch (_error) { /* ignore */ }
  }

  // ── Phase 1: Static scoring (computed once per map) ────────────────────

  // 1:1 port of Tactical precomputeStaticScores — reads the raw terrain buffer
  // directly (terrain[ny*W+nx]), skips water grid centers before the expensive
  // neighbourhood scan, and uses a circular mask. This is what makes it fast.
  function sampleStaticSpawnRow(options, dy) {
    const { terrain, W, H, cx, cy, radius } = options;
    const y = cy + dy;
    if (y < 0 || y >= H) return { land: 0, plains: 0, checked: 0 };
    let land = 0;
    let plains = 0;
    let checked = 0;
    for (let dx = -radius; dx <= radius; dx += 2) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx;
      if (x < 0 || x >= W) continue;
      checked += 1;
      const byte = terrain[y * W + x];
      if (!isPassableLandByte(byte)) continue;
      land += 1;
      if ((byte & SPAWN_MAGNITUDE_MASK) < 10) plains += 1;
    }
    return { land, plains, checked };
  }

  function sampleStaticSpawnTerrain(options) {
    const { radius } = options;
    let landCount = 0;
    let plainsCount = 0;
    let totalChecked = 0;
    for (let dy = -radius; dy <= radius; dy += 2) {
      const row = sampleStaticSpawnRow(options, dy);
      landCount += row.land;
      plainsCount += row.plains;
      totalChecked += row.checked;
    }
    return { landCount, plainsCount, totalChecked };
  }

  function createStaticSpawnCandidate(options) {
    const { W, H, cx: x, cy: y } = options;
    const sample = sampleStaticSpawnTerrain(options);
    const landDensity = sample.totalChecked > 0
      ? sample.landCount / sample.totalChecked : 0;
    const plainsRatio = sample.landCount > 0
      ? sample.plainsCount / sample.landCount : 0;
    const edgeX = Math.min(x, W - x) / (W / 2);
    const edgeY = Math.min(y, H - y) / (H / 2);
    const staticScore = landDensity * SPAWN_W.land + plainsRatio * SPAWN_W.plains +
      Math.min(edgeX, edgeY) * SPAWN_W.edge;
    return { x, y, staticScore, freeLandScore: landDensity };
  }

  function computeStaticCandidates(game) {
    const td = getSpawnTerrain(game);
    if (!td) return [];
    const { terrain, W, H } = td;

    const R = SPAWN_HEATMAP_ANALYSIS_R;
    const spanWidth = Math.max(1, W - 2 * R);
    const spanHeight = Math.max(1, H - 2 * R);
    const boundedStep = Math.ceil(
      Math.sqrt(
        (spanWidth * spanHeight) / SPAWN_HEATMAP_MAX_STATIC_CANDIDATES,
      ),
    );
    const step = Math.max(SPAWN_HEATMAP_GRID_STEP, boundedStep);
    const candidates = [];

    for (let cy = R; cy < H - R; cy += step) {
      for (let cx = R; cx < W - R; cx += step) {
        // Skip water grid centers immediately — avoids the neighbourhood scan
        // for the majority of cells (ocean), the biggest single speedup.
        if (!isPassableLandByte(terrain[cy * W + cx])) continue;

        candidates.push(createStaticSpawnCandidate({ terrain, W, H, cx, cy, radius: R }));
      }
    }

    candidates.sort((a, b) => b.staticScore - a.staticScore);
    return candidates;
  }

  function getSpawnPlayerType(player) {
    try {
      const type = player && typeof player.type === "function" ? player.type() : null;
      if (type) return type;
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:433"); /* use the raw view fallback */ }
    try {
      return player && player.data ? player.data.playerType : null;
    } catch (_error) {
      return null;
    }
  }

  function getSpawnPlayerLocation(player) {
    let location = null;
    try {
      location = player && typeof player.nameLocation === "function"
        ? player.nameLocation()
        : null;
    } catch (_error) { /* use the center fallback */ }
    if (!location) {
      try {
        location = player && typeof player.center === "function" ? player.center() : null;
      } catch (_error) { /* no usable location */ }
    }
    if (!location || !Number.isFinite(Number(location.x)) || !Number.isFinite(Number(location.y))) {
      return null;
    }
    return { x: Number(location.x), y: Number(location.y) };
  }

  function isAliveSpawnPlayer(player) {
    try {
      return Boolean(player && typeof player.isAlive === "function" && player.isAlive());
    } catch (_error) {
      return false;
    }
  }

  // Tribes and nations are persistent map entities during the spawn phase.
  // Keep them separate from human spawn intents so the target signal can be
  // weighted independently and refreshed without inflating enemy-pressure
  // loops with hundreds of nation bots.
  function collectSpawnEntityLocations(game) {
    const tribeLocs = [];
    const nationLocs = [];
    let players = [];
    try {
      players = typeof getCachedPlayerViews === "function"
        ? getCachedPlayerViews(game) || []
        : [];
    } catch (_error) { /* keep empty */ }

    for (let i = 0; i < players.length; i += 1) {
      const player = players[i];
      if (!isAliveSpawnPlayer(player)) continue;
      const type = getSpawnPlayerType(player);
      let nation = type === "NATION";
      try {
        nation = nation || Boolean(
          typeof isNationBotPlayer === "function" && isNationBotPlayer(player),
        );
      } catch (_error) { /* type is sufficient */ }
      if (!nation && type !== "BOT") continue;

      const location = getSpawnPlayerLocation(player);
      if (!location) continue;
      (nation ? nationLocs : tribeLocs).push(location);
    }

    const signature = [
      tribeLocs.map((point) => `${point.x},${point.y}`).sort().join(";"),
      nationLocs.map((point) => `${point.x},${point.y}`).sort().join(";"),
    ].join("|");
    return { tribeLocs, nationLocs, signature };
  }

  // Manhattan-distance proximity/count lookup backed by fixed-size buckets.
  // Exact spawn selection can visit every legal map tile, so scanning every
  // tribe and nation for every tile would recreate the spawn-phase stalls this
  // module is intended to avoid. A point within the maximum radius can only be
  // in one of the surrounding 3x3 buckets.
  function visitNearbySpawnPoints(index, x, y, visitor) {
    const centerColumn = Math.floor(x / index.cellSize);
    const centerRow = Math.floor(y / index.cellSize);
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      const row = centerRow + rowOffset;
      if (row < 0 || row >= index.rows) continue;
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        const column = centerColumn + columnOffset;
        if (column < 0 || column >= index.columns) continue;
        for (const point of index.buckets[row * index.columns + column] ?? []) visitor(point);
      }
    }
  }

  function buildSpawnProximityIndex(points, width, height, maxRadius) {
    if (!Array.isArray(points) || points.length === 0 || maxRadius <= 0) return null;
    const cellSize = Math.max(1, Number(maxRadius));
    const columns = Math.max(1, Math.ceil(Math.max(1, Number(width) || 1) / cellSize));
    const rows = Math.max(1, Math.ceil(Math.max(1, Number(height) || 1) / cellSize));
    const buckets = new Array(columns * rows);

    for (const point of points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const column = Math.max(0, Math.min(columns - 1, Math.floor(point.x / cellSize)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor(point.y / cellSize)));
      const bucketIndex = row * columns + column;
      if (!buckets[bucketIndex]) buckets[bucketIndex] = [];
      buckets[bucketIndex].push(point);
    }

    const index = { cellSize, columns, rows, buckets };
    return {
      nearestDistance(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
        let nearest = maxRadius;
        visitNearbySpawnPoints(index, x, y, (point) => {
          nearest = Math.min(nearest, Math.abs(point.x - x) + Math.abs(point.y - y));
        });
        return nearest;
      },
      score(x, y, radius = maxRadius) {
        const nearest = this.nearestDistance(x, y);
        if (!Number.isFinite(nearest) || nearest >= radius) return 0;
        return Math.max(0, 1 - nearest / radius);
      },
      countWithin(x, y, radius) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || radius <= 0) return 0;
        let count = 0;
        visitNearbySpawnPoints(index, x, y, (point) => {
          const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
          if (distance <= radius) count += 1;
        });
        return count;
      },
    };
  }

  function clampSpawnScore(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(1, number));
  }

  function calculateSpawnFreeLandScore(
    clusterScore,
    frontierGain,
    frontierSlots,
    frontierValueGain,
    frontierValueScale,
  ) {
    const safeCluster = clampSpawnScore(clusterScore);
    const safeSlots = Math.max(0, Number(frontierSlots) || 0);
    if (safeSlots <= 0) return safeCluster * 0.45;
    const frontierShare = clampSpawnScore(Number(frontierGain) / safeSlots);
    const valueShare = clampSpawnScore(
      Number(frontierValueGain) / (safeSlots * Math.max(1, Number(frontierValueScale) || 1)),
    );
    return clampSpawnScore(safeCluster * 0.35 + frontierShare * 0.4 + valueShare * 0.25);
  }

  function tribeReachForCandidate(index, x, y, freeLandScore, tribeCount) {
    if (tribeCount <= 0) {
      return { count: 0, score: 1, radius: SPAWN_HEATMAP_TRIBE_REACH_BASE_R };
    }
    const radius =
      SPAWN_HEATMAP_TRIBE_REACH_BASE_R +
      clampSpawnScore(freeLandScore) * SPAWN_HEATMAP_TRIBE_REACH_BONUS_R;
    const count = index ? index.countWithin(x, y, radius) : 0;
    return {
      count,
      score: count / Math.max(1, tribeCount),
      radius,
    };
  }

  function combineSpawnEntityScore(
    tribeScore,
    nationScore,
    tribeReachScore,
    tribeCount,
    nationCount,
  ) {
    if (tribeCount > 0) {
      // Count of reachable tribes is the primary objective. Nearest-tribe
      // proximity breaks close counts; nation proximity is only secondary.
      const tribeTargetScore = tribeReachScore * 0.85 + tribeScore * 0.15;
      return nationCount > 0
        ? tribeTargetScore * 0.85 + nationScore * 0.15
        : tribeTargetScore;
    }
    if (nationCount > 0) return nationScore;
    return 1;
  }

  // ── Phase 2: Dynamic scoring (recomputed every 250ms) ──────────────────

  function refreshTeammateClientIds(game, me) {
    _spawnTeammateClientIds.clear();
    if (!me) return;
    const players = getCachedPlayerViews(game);
    for (let i = 0; i < players.length; i += 1) {
      const p = players[i];
      if (!p || !p.isAlive || !p.isAlive()) continue;
      try {
        if (me.isOnSameTeam && me.isOnSameTeam(p)) {
          const cid = p.clientID ? p.clientID() : null;
          if (cid != null) _spawnTeammateClientIds.add(cid);
        }
      } catch (_error) { /* ignore */ }
    }
  }

  function teamAttractScore(dist) {
    // Piecewise function matching Tactical exactly.
    if (dist >= SPAWN_HEATMAP_TEAM_ATTRACT_R) return 0;
    if (dist <= SPAWN_HEATMAP_TEAM_MIN_GAP) {
      return (dist / SPAWN_HEATMAP_TEAM_MIN_GAP) * SPAWN_HEATMAP_TEAM_OVERLAP_MAX;
    }
    if (dist <= SPAWN_HEATMAP_TEAM_IDEAL_MAX) return 1.0;
    // 90 < dist < 110
    return (SPAWN_HEATMAP_TEAM_ATTRACT_R - dist) / (SPAWN_HEATMAP_TEAM_ATTRACT_R - SPAWN_HEATMAP_TEAM_IDEAL_MAX);
  }

  // The convex hull is the largest convex polygon enclosed by the team's
  // committed spawn positions. Once at least three non-collinear teammates
  // define a real area, keep our exact spawn inside it; with fewer points there
  // is no polygon to constrain against, so the existing team-area rules apply.
  function normalizedTeamPoint(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function buildLargestTeamPolyhedron(points) {
    const unique = [];
    const seen = new Set();
    for (const point of points || []) {
      const normalized = normalizedTeamPoint(point);
      if (!normalized) continue;
      const key = `${normalized.x},${normalized.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(normalized);
    }
    if (unique.length < 3) return null;
    unique.sort((left, right) => left.x - right.x || left.y - right.y);

    const cross = (origin, left, right) =>
      (left.x - origin.x) * (right.y - origin.y) -
      (left.y - origin.y) * (right.x - origin.x);
    const lower = [];
    for (const point of unique) {
      while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper = [];
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      const point = unique[index];
      while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    const hull = lower.concat(upper);
    return hull.length >= 3 ? hull : null;
  }

  function isPointInsideTeamPolyhedron(x, y, polygon) {
    if (!polygon || polygon.length < 3) return true;
    let sign = 0;
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const cross = (end.x - start.x) * (y - start.y) - (end.y - start.y) * (x - start.x);
      if (cross === 0) continue;
      const edgeSign = cross > 0 ? 1 : -1;
      if (sign !== 0 && sign !== edgeSign) return false;
      sign = edgeSign;
    }
    return true;
  }

  function classifySpawnPlayer(player, context) {
    try {
      const location = eligibleHumanSpawnLocation(player, context.mySid);
      if (!location) return;
      const point = { x: location.x, y: location.y };
      if (spawnPlayersShareClan(player, context)) context.clanSpawns.push(point);
      const teammate = spawnPlayersAreTeammates(context.me, player);
      (teammate ? context.teamSpawns : context.enemySpawns).push(point);
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:classifySpawnPlayer");
    }
  }

  function eligibleHumanSpawnLocation(player, excludedSmallId) {
    if (!player?.isAlive?.() || player.type?.() !== "HUMAN") return null;
    if (excludedSmallId != null && player.smallID?.() === excludedSmallId) return null;
    if (!player.hasSpawned?.()) return null;
    const location = player.nameLocation?.();
    return location && Number.isFinite(location.x) && Number.isFinite(location.y)
      ? location : null;
  }

  function spawnPlayersShareClan(player, context) {
    return Boolean(context.myClanTag && context.sameClanTag && context.getPlayerClanTag &&
      context.sameClanTag(context.myClanTag, context.getPlayerClanTag(player)));
  }

  function spawnPlayersAreTeammates(me, player) {
    try {
      return Boolean(me?.isOnSameTeam?.(player));
    } catch (_error) {
      return false;
    }
  }

  function collectSpawnPlayerGroups(game, me, objectiveApi) {
    const getPlayerClanTag = objectiveApi?.getPlayerClanTag;
    const context = {
      me, mySid: me?.smallID?.() ?? null,
      getPlayerClanTag: typeof getPlayerClanTag === "function" ? getPlayerClanTag : null,
      sameClanTag: typeof objectiveApi?.sameClanTag === "function" ? objectiveApi.sameClanTag : null,
      enemySpawns: [], teamSpawns: [], clanSpawns: [],
    };
    context.myClanTag = context.getPlayerClanTag?.(me) ?? null;
    for (const player of getCachedPlayerViews(game)) classifySpawnPlayer(player, context);
    return context;
  }

  function spawnCentroid(points) {
    if (points.length === 0) return { x: 0, y: 0 };
    const total = points.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 },
    );
    return { x: total.x / points.length, y: total.y / points.length };
  }

  function nearestSpawnDistance(points, x, y) {
    return points.reduce(
      (nearest, point) => Math.min(nearest, Math.abs(point.x - x) + Math.abs(point.y - y)),
      Infinity,
    );
  }

  function spawnEnemyPressure(points, x, y) {
    return points.reduce((pressure, point) => {
      const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
      return distance < SPAWN_HEATMAP_ENEMY_PRESSURE_R
        ? pressure + 1 - distance / SPAWN_HEATMAP_ENEMY_PRESSURE_R : pressure;
    }, 0);
  }

  function dynamicTeamScores(context, x, y) {
    if (context.teamSpawns.length === 0) return { additive: 0, teamScore: 1 };
    const nearest = nearestSpawnDistance(context.teamSpawns, x, y);
    const attract = Number.isFinite(nearest) ? teamAttractScore(nearest) : 0;
    const centroidDistance = Math.abs(context.teamCentroid.x - x) +
      Math.abs(context.teamCentroid.y - y);
    const centroid = Math.max(0, 1 - centroidDistance / SPAWN_HEATMAP_TEAM_CENTROID_R);
    const additive = attract * SPAWN_W.team + centroid * SPAWN_W.teamCentroid *
      Math.min(1, context.teamSpawns.length / 2);
    return { additive, teamScore: Math.min(attract, centroid) };
  }

  function evaluateDynamicSpawnCandidate(candidate, context) {
    const { x, y } = candidate;
    const freeLandScore = clampSpawnScore(candidate.freeLandScore);
    const tribeReach = tribeReachForCandidate(
      context.tribeProximity, x, y, freeLandScore, context.entities.tribeLocs.length,
    );
    const tribeScore = context.tribeProximity
      ? context.tribeProximity.score(x, y, SPAWN_HEATMAP_TRIBE_R) : 0;
    const nationScore = context.nationProximity ? context.nationProximity.score(x, y) : 0;
    const enemyDistance = nearestSpawnDistance(context.enemySpawns, x, y);
    const playerDistScore = Number.isFinite(enemyDistance)
      ? Math.min(1, enemyDistance / SPAWN_HEATMAP_PLAYER_R) : 1;
    const enemyPressureScore = 1 / (1 + Math.max(0, spawnEnemyPressure(context.enemySpawns, x, y)));
    const team = dynamicTeamScores(context, x, y);
    const clanScore = context.clanProximityScore && context.clanSpawns.length > 0
      ? context.clanProximityScore(x, y, context.clanSpawns, SPAWN_HEATMAP_TEAM_ATTRACT_R) : 0;
    const resourceScore = combineSpawnEntityScore(
      tribeScore, nationScore, tribeReach.score,
      context.entities.tribeLocs.length, context.entities.nationLocs.length,
    );
    const score = candidate.staticScore +
      tribeReach.score * SPAWN_W.tribe + tribeScore * SPAWN_W.tribe * 0.15 +
      nationScore * SPAWN_W.nation + playerDistScore * SPAWN_W.player +
      enemyPressureScore * SPAWN_W.enemyPressure + team.additive;
    const objective = evaluateFallbackSpawnObjective(context, {
      freeLandScore, playerDistScore, enemyPressureScore, teamScore: team.teamScore,
      tribeScore, nationScore, tribeReach, resourceScore, clanScore,
    });
    return { x, y, score, freeLandScore, tribeScore, tribeReachCount: tribeReach.count,
      tribeReachScore: tribeReach.score, tribeReachRadius: tribeReach.radius,
      nationScore, resourceScore, clanScore, objective };
  }

  function evaluateFallbackSpawnObjective(context, values) {
    if (typeof context.objectiveApi?.evaluateModelCandidate !== "function") return null;
    return context.objectiveApi.evaluateModelCandidate({
      startScore: values.freeLandScore, expansionScore: values.freeLandScore,
      safetyScore: Math.min(values.playerDistScore, values.enemyPressureScore),
      teamScore: values.teamScore,
      tribeScore: context.entities.tribeLocs.length > 0 ? values.tribeScore : 1,
      nationScore: context.entities.nationLocs.length > 0 ? values.nationScore : 1,
      tribeReachScore: values.tribeReach.score, tribeReachCount: values.tribeReach.count,
      freeLandScore: values.freeLandScore, resourceScore: values.resourceScore,
      clanScore: values.clanScore,
    });
  }

  function compareDynamicSpawnCandidates(left, right, objectiveApi) {
    if (left.objective && right.objective && typeof objectiveApi?.compareModelCandidates === "function") {
      const order = objectiveApi.compareModelCandidates(left, right);
      if (order !== 0) return order;
    }
    if (left.score !== right.score) return right.score - left.score;
    if (left.freeLandScore !== right.freeLandScore) return right.freeLandScore - left.freeLandScore;
    return right.clanScore - left.clanScore;
  }

  function diverseSpawnTopSpots(candidates) {
    const topSpots = [];
    for (const candidate of candidates) {
      if (topSpots.length >= SPAWN_HEATMAP_TOP_N) break;
      const tooClose = topSpots.some((spot) =>
        Math.abs(candidate.x - spot.x) + Math.abs(candidate.y - spot.y) < SPAWN_TOP_SPOT_MIN_DISTANCE,
      );
      if (!tooClose) topSpots.push({ x: candidate.x, y: candidate.y });
    }
    return topSpots;
  }

  function computeDynamicScores(game, staticCandidates, me) {
    const W = game.width ? game.width() : 0;
    const H = game.height ? game.height() : 0;
    const objectiveApi = getSpawnObjectiveApi();
    const groups = collectSpawnPlayerGroups(game, me, objectiveApi);
    const entities = collectSpawnEntityLocations(game);
    const tribeProximity = buildSpawnProximityIndex(
      entities.tribeLocs,
      W,
      H,
      SPAWN_HEATMAP_TRIBE_REACH_BASE_R + SPAWN_HEATMAP_TRIBE_REACH_BONUS_R,
    );
    const nationProximity = buildSpawnProximityIndex(
      entities.nationLocs,
      W,
      H,
      SPAWN_HEATMAP_NATION_R,
    );

    const context = {
      ...groups, entities, tribeProximity, nationProximity, objectiveApi,
      clanProximityScore: typeof objectiveApi?.clanProximityScore === "function"
        ? objectiveApi.clanProximityScore : null,
      teamCentroid: spawnCentroid(groups.teamSpawns),
    };

    const out = staticCandidates.map((candidate) => evaluateDynamicSpawnCandidate(candidate, context));
    const maxScore = out.reduce((maximum, candidate) => Math.max(maximum, candidate.score), 0);

    out.sort((left, right) => compareDynamicSpawnCandidates(left, right, objectiveApi));
    const topSpots = diverseSpawnTopSpots(out);

    return { scores: out, topSpots, maxScore };
  }

  function spawnPointKey(player) {
    try {
      if (player && typeof player.clientID === "function") {
        const clientID = player.clientID();
        if (clientID != null) return `client:${clientID}`;
      }
    } catch (_error) { /* fall through */ }
    try {
      if (player && typeof player.smallID === "function") {
        const smallID = player.smallID();
        if (smallID != null) return `small:${smallID}`;
      }
    } catch (_error) { /* unknown player */ }
    return null;
  }

  function collectExactEntityLocation(player, collections) {
    if (!isAliveSpawnPlayer(player)) return;
    const type = getSpawnPlayerType(player);
    let nation = type === "NATION";
    try {
      nation ||= Boolean(typeof isNationBotPlayer === "function" && isNationBotPlayer(player));
    } catch (_error) {
      /* type is sufficient */
    }
    const location = getSpawnPlayerLocation(player);
    if (!location || (!nation && type !== "BOT")) return;
    (nation ? collections.nationLocs : collections.tribeLocs).push(location);
  }

  function collectExactHumanLocation(player, context) {
    if (getSpawnPlayerType(player) !== "HUMAN") return;
    const key = spawnPointKey(player);
    if (!key || context.ownKeys.has(key) || !player.hasSpawned?.()) return;
    const location = getSpawnPlayerLocation(player);
    if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) return;
    context.liveKeys.add(key);
    const point = { x: location.x, y: location.y };
    if (spawnPlayersShareClan(player, context)) context.clanSpawns.push(point);
    const target = spawnPlayersAreTeammates(context.me, player)
      ? context.teamSpawns : context.enemySpawns;
    target.push(point);
  }

  function pendingSpawnPoint(game, entry) {
    if (!entry || typeof game.x !== "function" || typeof game.y !== "function") return null;
    const tile = Number(entry.tile);
    if (!Number.isFinite(tile)) return null;
    try {
      const x = game.x(tile);
      const y = game.y(tile);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:pendingSpawnPoint");
      return null;
    }
  }

  function collectPendingExactSpawnPoints(game, context) {
    for (const [clientID, entry] of _spawnPlayerPositions) {
      const key = `client:${clientID}`;
      if (context.ownKeys.has(key) || context.liveKeys.has(key)) continue;
      const point = pendingSpawnPoint(game, entry);
      if (!point) continue;
      const player = context.playersByKey.get(key);
      if (player && spawnPlayersShareClan(player, context)) context.clanSpawns.push(point);
      const target = spawnPlayersAreTeammates(context.me, player)
        ? context.teamSpawns : context.enemySpawns;
      target.push(point);
    }
  }

  function exactSpawnSignature(context) {
    return [
      String(_spawnIntentVersion), context.myClanTag || "",
      context.enemySpawns.map((point) => `${point.x},${point.y}`).join(";"),
      context.teamSpawns.map((point) => `${point.x},${point.y}`).join(";"),
      context.clanSpawns.map((point) => `${point.x},${point.y}`).join(";"),
      context.tribeLocs.map((point) => `${point.x},${point.y}`).sort().join(";"),
      context.nationLocs.map((point) => `${point.x},${point.y}`).sort().join(";"),
    ].join("|");
  }

  function collectExactSpawnPoints(game, me) {
    const objectiveApi = getSpawnObjectiveApi();
    const players = getCachedPlayerViews(game) || [];
    const ownKeys = new Set();
    const ownKey = spawnPointKey(me);
    if (ownKey) ownKeys.add(ownKey);
    const getPlayerClanTag = typeof objectiveApi?.getPlayerClanTag === "function"
      ? objectiveApi.getPlayerClanTag : null;
    const context = {
      me, ownKeys, liveKeys: new Set(), playersByKey: new Map(),
      enemySpawns: [], teamSpawns: [], clanSpawns: [], tribeLocs: [], nationLocs: [],
      getPlayerClanTag,
      sameClanTag: typeof objectiveApi?.sameClanTag === "function" ? objectiveApi.sameClanTag : null,
      myClanTag: getPlayerClanTag?.(me) ?? null,
    };
    for (const player of players) {
      const key = spawnPointKey(player);
      if (key) context.playersByKey.set(key, player);
      collectExactEntityLocation(player, context);
      if (isAliveSpawnPlayer(player)) collectExactHumanLocation(player, context);
    }
    collectPendingExactSpawnPoints(game, context);
    const { enemySpawns, teamSpawns, clanSpawns, tribeLocs, nationLocs } = context;
    return {
      enemySpawns, teamSpawns, clanSpawns, tribeLocs, nationLocs,
      signature: exactSpawnSignature(context),
    };
  }

  function insertExactSpawnCandidate(best, candidate) {
    const compare = (left, right) => {
      const objectiveApi = getSpawnObjectiveApi();
      if (
        left.objective &&
        right.objective &&
        typeof objectiveApi?.compareModelCandidates === "function"
      ) {
        const objectiveOrder = objectiveApi.compareModelCandidates(left, right);
        if (objectiveOrder !== 0) return objectiveOrder;
      }
      if (left.score !== right.score) return right.score - left.score;
      return (left.ref ?? Infinity) - (right.ref ?? Infinity);
    };
    let position = 0;
    while (position < best.length && compare(best[position], candidate) <= 0) position += 1;
    if (
      position >= EXACT_SPAWN_CANDIDATE_POOL_SIZE &&
      best.length >= EXACT_SPAWN_CANDIDATE_POOL_SIZE
    ) return;
    best.splice(position, 0, candidate);
    if (best.length > EXACT_SPAWN_CANDIDATE_POOL_SIZE) best.pop();
  }

  function selectDiverseExactSpawnCandidates(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const selected = [];
    for (const candidate of candidates) {
      let isDistinct = true;
      for (const spot of selected) {
        if (
          Math.abs(candidate.x - spot.x) + Math.abs(candidate.y - spot.y) <
          SPAWN_TOP_SPOT_MIN_DISTANCE
        ) {
          isDistinct = false;
          break;
        }
      }
      if (!isDistinct) continue;
      selected.push(candidate);
      if (selected.length >= SPAWN_HEATMAP_TOP_N) break;
    }
    return selected;
  }

  let _exactSpawnCacheSrcRef = null;
  let _exactSpawnCacheIndexVersion = -1;
  let _exactSpawnCacheSignature = "";
  let _exactSpawnCacheResult = null;

  function exactSpawnMinimumDistance(game) {
    try {
      const configured = game.config().minDistanceBetweenPlayers();
      return Number.isFinite(configured) ? configured : 30;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:exactSpawnMinimumDistance");
      return 30;
    }
  }

  function createExactSpawnRankingContext(game, index, points, options, incremental) {
    const W = game.width ? game.width() : index.width;
    const H = game.height ? game.height() : index.height;
    return {
      game, index, points, options, incremental, W, H,
      area: getSpawnAreaForGame(game),
      minDist: exactSpawnMinimumDistance(game),
      tribeProximity: buildSpawnProximityIndex(
        points.tribeLocs, W, H,
        SPAWN_HEATMAP_TRIBE_REACH_BASE_R + SPAWN_HEATMAP_TRIBE_REACH_BONUS_R,
      ),
      nationProximity: buildSpawnProximityIndex(points.nationLocs, W, H, SPAWN_HEATMAP_NATION_R),
      best: Array.isArray(options?.best) ? options.best : [],
      objectiveApi: getSpawnObjectiveApi(),
      frontierValueScale: Number(getSpawnIndexApi()?.FRONTIER_VALUE_SCALE) || 1000,
      teamPolyhedron: buildLargestTeamPolyhedron(points.teamSpawns),
      teamCentroid: spawnCentroid(points.teamSpawns),
    };
  }

  function exactSpawnCenterAllowed(context, tile, x, y) {
    const { area, teamPolyhedron, game, points, minDist } = context;
    if (area && (x < area.x || x >= area.x + area.width || y < area.y || y >= area.y + area.height)) return false;
    if (teamPolyhedron && !isPointInsideTeamPolyhedron(x, y, teamPolyhedron)) return false;
    try {
      if (game.hasOwner?.(tile) || game.isBorder?.(tile)) return false;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:exactSpawnCenterAllowed");
      return false;
    }
    return nearestSpawnDistance(points.enemySpawns, x, y) >= minDist &&
      nearestSpawnDistance(points.teamSpawns, x, y) >= minDist;
  }

  function exactTeamCandidateScores(context, x, y) {
    if (context.points.teamSpawns.length === 0) return { score: 0, robust: 1 };
    const nearest = nearestSpawnDistance(context.points.teamSpawns, x, y);
    const attract = teamAttractScore(nearest);
    const centroidDistance = Math.abs(context.teamCentroid.x - x) +
      Math.abs(context.teamCentroid.y - y);
    const centroid = Math.max(0, 1 - centroidDistance / SPAWN_HEATMAP_TEAM_CENTROID_R);
    return {
      robust: Math.min(attract, Math.max(
        0, 1 - Math.abs(context.teamCentroid.x - x) / SPAWN_HEATMAP_TEAM_CENTROID_R -
          Math.abs(context.teamCentroid.y - y) / SPAWN_HEATMAP_TEAM_CENTROID_R,
      )),
      score: attract * SPAWN_W.team + centroid * SPAWN_W.teamCentroid *
        Math.min(1, context.points.teamSpawns.length / 2),
    };
  }

  function exactFrontierCoverage(frontierSlots, frontierValueGain, scale, freeLand, cluster) {
    if (!Number.isFinite(Number(frontierSlots))) return cluster;
    return frontierSlots > 0 ? frontierValueGain / (frontierSlots * scale) : freeLand;
  }

  function rankExactSpawnCandidate(context, args) {
    const [tile, x, y, spawnGain, invalidCount, plainsGain, frontierGain,
      , frontierValueGain, frontierSlots] = args;
    const clusterScore = spawnGain / Math.max(1, spawnGain + invalidCount);
    const plainsScore = plainsGain / Math.max(1, spawnGain);
    const edgeScore = Math.max(0, Math.min(
      Math.min(x, context.W - 1 - x) / Math.max(1, context.W / 2),
      Math.min(y, context.H - 1 - y) / Math.max(1, context.H / 2),
    ));
    const freeLandScore = calculateSpawnFreeLandScore(
      clusterScore, frontierGain, frontierSlots, frontierValueGain, context.frontierValueScale,
    );
    const tribeReach = tribeReachForCandidate(
      context.tribeProximity, x, y, freeLandScore, context.points.tribeLocs.length,
    );
    const tribeScore = context.tribeProximity
      ? context.tribeProximity.score(x, y, SPAWN_HEATMAP_TRIBE_R) : 0;
    const nationScore = context.nationProximity ? context.nationProximity.score(x, y) : 0;
    const resourceScore = combineSpawnEntityScore(
      tribeScore, nationScore, tribeReach.score,
      context.points.tribeLocs.length, context.points.nationLocs.length,
    );
    const playerScore = Math.min(1,
      nearestSpawnDistance(context.points.enemySpawns, x, y) / SPAWN_HEATMAP_PLAYER_R,
    );
    const pressureScore = 1 / (1 + spawnEnemyPressure(context.points.enemySpawns, x, y));
    const clanDistance = nearestSpawnDistance(context.points.clanSpawns, x, y);
    const clanScore = clanDistance === Infinity
      ? 0 : Math.max(0, 1 - clanDistance / SPAWN_HEATMAP_TEAM_ATTRACT_R);
    const team = exactTeamCandidateScores(context, x, y);
    const score = clusterScore * SPAWN_W.land + plainsScore * SPAWN_W.plains +
      tribeReach.score * SPAWN_W.tribe + tribeScore * SPAWN_W.tribe * 0.15 +
      nationScore * SPAWN_W.nation + playerScore * SPAWN_W.player +
      edgeScore * SPAWN_W.edge + pressureScore * SPAWN_W.enemyPressure +
      team.score + clanScore * SPAWN_W.clan;
    const frontierCoverage = exactFrontierCoverage(
      frontierSlots, frontierValueGain, context.frontierValueScale, freeLandScore, clusterScore,
    );
    const objective = evaluateExactSpawnObjective(context, {
      clusterScore, frontierCoverage, playerScore, pressureScore, edgeScore,
      teamScore: team.robust, tribeScore, nationScore, tribeReach, freeLandScore,
      resourceScore, clanScore,
    });
    insertExactSpawnCandidate(context.best, {
      ref: tile, x, y, score, spawnGain, frontierGain, frontierValueGain, freeLandScore,
      tribeScore, tribeReachCount: tribeReach.count, tribeReachScore: tribeReach.score,
      tribeReachRadius: tribeReach.radius, nationScore, resourceScore, clanScore,
      teamPolyhedronScore: context.teamPolyhedron ? 1 : 0, objective,
    });
  }

  function evaluateExactSpawnObjective(context, values) {
    if (typeof context.objectiveApi?.evaluateModelCandidate !== "function") return null;
    return context.objectiveApi.evaluateModelCandidate({
      startScore: values.clusterScore,
      expansionScore: Math.min(values.clusterScore, values.frontierCoverage),
      safetyScore: Math.min(values.playerScore, values.pressureScore, values.edgeScore),
      teamScore: values.teamScore,
      tribeScore: context.points.tribeLocs.length > 0 ? values.tribeScore : 1,
      nationScore: context.points.nationLocs.length > 0 ? values.nationScore : 1,
      tribeReachScore: values.tribeReach.score, tribeReachCount: values.tribeReach.count,
      freeLandScore: values.freeLandScore, resourceScore: values.resourceScore,
      clanScore: values.clanScore, teamPolyhedronScore: context.teamPolyhedron ? 1 : 0,
    });
  }

  function iterateExactSpawnCandidates(context, candidateOptions) {
    if (context.incremental && typeof context.index.forEachCandidateRange === "function") {
      context.index.forEachCandidateRange(candidateOptions);
      return;
    }
    context.index.forEachCandidate(candidateOptions);
  }

  function cacheExactSpawnResult(game, index, points, result) {
    _exactSpawnCacheSrcRef = (game && game.__src) || game;
    _exactSpawnCacheIndexVersion = index.version;
    _exactSpawnCacheSignature = points.signature;
    _exactSpawnCacheResult = result;
  }

  function isIncrementalExactSpawnOptions(options) {
    return Boolean(options && (options.startRef !== undefined ||
      options.endRef !== undefined || Array.isArray(options.best)));
  }

  function readCachedExactSpawnResult(game, index, points, incremental) {
    if (incremental) return undefined;
    const source = (game && game.__src) || game;
    const matches = _exactSpawnCacheSrcRef === source &&
      _exactSpawnCacheIndexVersion === index.version &&
      _exactSpawnCacheSignature === points.signature;
    return matches ? _exactSpawnCacheResult : undefined;
  }

  function exactCandidateIterationOptions(context) {
    const range = context.incremental
      ? { startRef: context.options.startRef, endRef: context.options.endRef } : {};
    return {
      mode: "explicit", ...range,
      isCenterAllowed: (tile, x, y) => exactSpawnCenterAllowed(context, tile, x, y),
      onCandidate: (...args) => rankExactSpawnCandidate(context, args),
    };
  }

  // Exact map-resolution ranking for the bot. This is deliberately separate
  // from the visual heatmap: the visual layer may stay coarse, while the bot
  // uses a replay-free robust objective over legal start and expansion metrics.
  function computeExactSpawnTopSpotsForBot(game, me, options = null) {
    const incremental = isIncrementalExactSpawnOptions(options);
    const index = ensureSpawnCandidateIndex(game);
    if (!index || !index.ready) return null;

    const points = options?.points || collectExactSpawnPoints(game, me);
    const cached = readCachedExactSpawnResult(game, index, points, incremental);
    if (cached !== undefined) return cached;

    const context = createExactSpawnRankingContext(game, index, points, options, incremental);

    iterateExactSpawnCandidates(context, exactCandidateIterationOptions(context));

    let result = selectDiverseExactSpawnCandidates(context.best);
    if (incremental) result = context.best.length > 0 ? context.best : null;
    if (!incremental) cacheExactSpawnResult(game, index, points, result);
    return result;
  }

  // The exact scorer is intentionally kept synchronous for deterministic test
  // callers, but the live bot must never run that full-map pass on its decision
  // stack. Rank a small ref range during idle time and let the bot use its last
  // completed result (or the bounded visual fallback) while the job progresses.
  const EXACT_SPAWN_RANKING_CHUNK_REFS = 128;
  const EXACT_SPAWN_RANKING_SLICE_MS = 4;
  const EXACT_SPAWN_RANKING_IDLE_TIMEOUT_MS = 500;
  let _asyncExactSpawnJob = null;
  let _asyncExactSpawnScheduled = false;
  let _asyncExactSpawnScheduledJob = null;
  let _asyncExactSpawnResultSrcRef = null;
  let _asyncExactSpawnResultIndexVersion = -1;
  let _asyncExactSpawnResultSignature = "";
  let _asyncExactSpawnResult = null;

  function scheduleAsyncExactSpawnJob(job) {
    if (!job || job.done) return;
    if (_asyncExactSpawnScheduled && _asyncExactSpawnScheduledJob === job) return;
    _asyncExactSpawnScheduled = true;
    _asyncExactSpawnScheduledJob = job;

    const run = (deadline) => {
      if (_asyncExactSpawnScheduledJob === job) {
        _asyncExactSpawnScheduled = false;
        _asyncExactSpawnScheduledJob = null;
      }
      if (job !== _asyncExactSpawnJob || job.done) return;
      if (job.index.version !== job.indexVersion) {
        job.done = true;
        return;
      }

      const startedAt = performance.now();
      let chunks = 0;
      const processChunk = () => {
        const startRef = job.cursor;
        const endRef = Math.min(
          job.index.size,
          startRef + EXACT_SPAWN_RANKING_CHUNK_REFS,
        );
        if (endRef <= startRef) {
          job.cursor = job.index.size;
          return;
        }
        computeExactSpawnTopSpotsForBot(job.game, job.me, {
          points: job.points,
          best: job.best,
          startRef,
          endRef,
        });
        job.cursor = endRef;
        chunks += 1;
      };

      // A timer fallback deliberately processes one chunk only. Native idle
      // callbacks may use the remaining budget, capped at four chunks so a
      // browser that reports an overly generous deadline cannot monopolize a
      // frame.
      processChunk();
      if (job.index.version !== job.indexVersion) {
        job.done = true;
        return;
      }
      const hasIdleBudget = () =>
        job.cursor < job.index.size &&
        job.index.version === job.indexVersion &&
        chunks < 4 &&
        deadline &&
        typeof deadline.timeRemaining === "function" &&
        deadline.timeRemaining() > 0 &&
        performance.now() - startedAt < EXACT_SPAWN_RANKING_SLICE_MS;
      while (hasIdleBudget()) {
        processChunk();
      }

      if (job.index.version !== job.indexVersion) {
        job.done = true;
        return;
      }

      if (job.cursor < job.index.size) {
        scheduleAsyncExactSpawnJob(job);
        return;
      }

      job.done = true;
      _asyncExactSpawnResultSrcRef = job.src;
      _asyncExactSpawnResultIndexVersion = job.indexVersion;
      _asyncExactSpawnResultSignature = job.points.signature;
      _asyncExactSpawnResult = selectDiverseExactSpawnCandidates(job.best);
    };

    try {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: EXACT_SPAWN_RANKING_IDLE_TIMEOUT_MS });
        return;
      }
    } catch (_error) {
      /* use the timer fallback */
    }
    setTimeout(run, 0);
  }

  function computeAsyncExactSpawnTopSpotsForBot(game, me) {
    const index = ensureSpawnCandidateIndex(game);
    if (!index || !index.ready || typeof index.forEachCandidateRange !== "function") {
      return null;
    }

    const src = (game && game.__src) || game;
    const indexVersion = index.version;
    const points = collectExactSpawnPoints(game, me);
    const cached = cachedAsyncExactSpawnResult(src, indexVersion, points.signature);
    if (cached !== undefined) return cached;

    const activeJob = _asyncExactSpawnJob;
    if (asyncExactJobMatches(activeJob, src, index, indexVersion)) return null;

    if (activeJob && !activeJob.done && activeJob.index === index) {
      activeJob.done = true;
    }

    const job = {
      game,
      me,
      src,
      index,
      indexVersion,
      points,
      cursor: 0,
      best: [],
      done: false,
    };
    _asyncExactSpawnJob = job;
    scheduleAsyncExactSpawnJob(job);
    return null;
  }

  try {
    if (typeof globalThis === "object") {
      globalThis.__OFHRefreshSpawnCandidateTerrain = refreshSpawnCandidateTerrain;
    }
  } catch (_error) { /* optional diagnostic surface */ }

  // ── Main scan (called by scheduler every 250ms) ────────────────────────

  function scanSpawnHeatmap(game) {
    const inSpawnPhase = Boolean(game.inSpawnPhase && game.inSpawnPhase());
    if (_spawnHeatmapWasInSpawnPhase && !inSpawnPhase) {
      _spawnHeatmapData = null;
      _spawnStaticCandidates = null;
      _spawnStaticGameRef = null;
      _spawnStaticTerrainRef = null;
      _spawnStaticWidth = 0;
      _spawnStaticHeight = 0;
      _spawnPlayerPositions.clear();
      _spawnIntentVersion += 1;
      resetSpawnCandidateIndex();
      _spawnHeatmapWasInSpawnPhase = false;
      return;
    }
    _spawnHeatmapWasInSpawnPhase = inSpawnPhase;
    if (!inSpawnPhase) {
      _spawnHeatmapData = null;
      return;
    }

    const me = game.myPlayer ? game.myPlayer() : null;

    // Phase 1: static candidates for the visual overlay. The bot's exact
    // selector is intentionally kept out of this path: spawn markers are on by
    // default and must never allocate map-sized index buffers by themselves.
    const candidates = ensureSpawnStaticCandidates(game);
    if (!candidates || candidates.length === 0) {
      _spawnHeatmapData = null;
      return;
    }

    // Phase 2: dynamic scoring using live game-API player positions.
    _spawnHeatmapData = computeDynamicScores(game, candidates, me);
  }

  // ONE static-candidate cache shared by the overlay and the auto-bot, keyed on
  // the unwrapped source GameView (the bot passes a wrapper, the overlay the raw
  // game — both resolve to the same underlying object, so the heavy grid scan
  // runs a single time per map).
  function ensureSpawnStaticCandidates(game) {
    const src = (game && game.__src) || game;
    const td = getSpawnTerrain(game);
    if (
      _spawnStaticGameRef !== src ||
      _spawnStaticTerrainRef !== (td && td.terrain) ||
      _spawnStaticWidth !== (td ? td.W : 0) ||
      _spawnStaticHeight !== (td ? td.H : 0) ||
      _spawnStaticCandidates === null
    ) {
      _spawnStaticCandidates = computeStaticCandidates(game);
      _spawnStaticGameRef = src;
      _spawnStaticTerrainRef = td && td.terrain;
      _spawnStaticWidth = td ? td.W : 0;
      _spawnStaticHeight = td ? td.H : 0;
    }
    return _spawnStaticCandidates;
  }

  // The exact topSpots array currently drawn on the map (or null). The auto-bot
  // reads this first so it spawns at literally the same #1 the player sees.
  function getSpawnHeatmapTopSpots() {
    return _spawnHeatmapData && _spawnHeatmapData.topSpots && _spawnHeatmapData.topSpots.length > 0
      ? _spawnHeatmapData.topSpots
      : null;
  }

  // Shared fallback scorer entry point for the auto-bot. It computes the same
  // bounded visual topSpots the heatmap draws when the exact map-wide index is
  // unavailable or over budget. Reuses the shared static-candidate cache (works
  // even if the heatmap is disabled).
  //
  // Per-tick memo: the bot calls this twice in the same tick (currentSpawnTopKey
  // then pickSpawnCenter) with identical inputs, and if the overlay is on it also
  // ran computeDynamicScores this tick. Cache the result per game-tick so the
  // dynamic scoring pass runs at most once per tick regardless of how many
  // callers ask for it.
  let _botTopSpotsTick = -1;
  let _botTopSpotsGameRef = null;
  let _botTopSpotsTerrainRef = null;
  let _botTopSpotsResult = null;
  function currentSpawnTick(game) {
    try {
      const tick = Number(game.ticks ? game.ticks() : -1);
      return Number.isFinite(tick) ? tick : -1;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:currentSpawnTick");
      return -1;
    }
  }

  function cachedBotSpawnTopSpots(src, terrain, tick) {
    const matches = _botTopSpotsGameRef === src && _botTopSpotsTerrainRef === terrain &&
      tick >= 0 && tick === _botTopSpotsTick;
    return matches ? _botTopSpotsResult : undefined;
  }

  function rememberBotSpawnTopSpots(src, terrain, tick, result) {
    _botTopSpotsGameRef = src;
    _botTopSpotsTerrainRef = terrain;
    _botTopSpotsTick = tick;
    _botTopSpotsResult = result;
    return result;
  }

  function computeSpawnTopSpotsForBot(game, me) {
    try {
      const exact = computeAsyncExactSpawnTopSpotsForBot(game, me);
      if (exact && exact.length > 0) return exact;
      const src = (game && game.__src) || game;
      const td = getSpawnTerrain(game);
      const terrain = td?.terrain ?? null;
      const tick = currentSpawnTick(game);
      const cached = cachedBotSpawnTopSpots(src, terrain, tick);
      if (cached !== undefined) return cached;
      const candidates = ensureSpawnStaticCandidates(game);
      if (!candidates?.length) return null;
      const spots = computeDynamicScores(game, candidates, me)?.topSpots;
      const result = spots?.length > 0 ? spots : null;
      return rememberBotSpawnTopSpots(src, terrain, tick, result);
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/spawn-heatmap.js:1653");
      return null;
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────

  const _spawnCellPt = { x: 0, y: 0 };
  function drawSpawnScoreCells(ctx, scores, maxScore, projector) {
    if (!runtimeState.spawnHeatmapEnabled || maxScore <= 0) return;
    const cell = SPAWN_HEATMAP_CELL;
    const halfCell = cell / 2;
    const invMax = 1 / maxScore;
    let drawn = 0;
    for (const item of scores) {
      if (drawn >= SPAWN_HEATMAP_MAX_CELLS) return;
      mapProject(projector, item.x, item.y, _spawnCellPt);
      const { x, y } = _spawnCellPt;
      if (x < -cell || y < -cell || x > window.innerWidth + cell || y > window.innerHeight + cell) continue;
      const value = item.score * invMax;
      ctx.fillStyle = `rgba(${((1 - value) * 255) | 0},${(value * 255) | 0},42,${(value * 0.45 + 0.12).toFixed(2)})`;
      ctx.fillRect(x - halfCell, y - halfCell, cell, cell);
      drawn++;
    }
  }

  function drawSpawnTopSpotMarkers(ctx, topSpots, projector) {
    const colors = ["#ffd54f", "#9ccc65", "#9ccc65", "#d8dde6", "#d8dde6"];
    for (let index = 0; index < topSpots.length; index += 1) {
      const spot = topSpots[index];
      mapProject(projector, spot.x, spot.y, _spawnCellPt);
      if (!mapPointOnScreen(_spawnCellPt.x, _spawnCellPt.y, 20)) continue;
      const color = colors[index] || "#d8dde6";
      ctx.beginPath();
      ctx.arc(_spawnCellPt.x, _spawnCellPt.y, 11, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
      ctx.fill();
      ctx.fillStyle = color;
      ctx.font = 'bold 10px "Aptos", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1), _spawnCellPt.x, _spawnCellPt.y + 0.5);
    }
  }

  function drawSpawnHeatmap(ctx, game, transform) {
    if (!_spawnHeatmapData) return;
    const { scores, topSpots, maxScore } = _spawnHeatmapData;
    if (maxScore <= 0 && (!topSpots || topSpots.length === 0)) return;
    // Derive the affine projector ONCE (3 transform calls) then project every
    // cell with arithmetic — avoids ~1200 worldToScreenCoordinates per frame.
    const proj = mapMakeProjector(transform);
    if (!proj) return;

    ctx.save();
    drawSpawnScoreCells(ctx, scores, maxScore, proj);

    // Numbered top-spot markers — only when the markers layer is on. Can show
    // WITHOUT the heatmap (clean map, just the best spots).
    if (!runtimeState.spawnMarkersEnabled) {
      ctx.restore();
      return;
    }
    drawSpawnTopSpotMarkers(ctx, topSpots, proj);
    ctx.restore();
  }

  function spawnOverlayEnabled() {
    return runtimeState.spawnHeatmapEnabled || runtimeState.spawnMarkersEnabled;
  }

  registerMapOverlayLayer({
    id: "spawn-heatmap",
    scanIntervalMs: 1000, // match Tactical: heavy dynamic scoring recomputes every 1000ms
    isEnabled: spawnOverlayEnabled,
    scan: function (game) { scanSpawnHeatmap(game); },
    draw: function (ctx, game, transform) { drawSpawnHeatmap(ctx, game, transform); },
  });

  function _resetSpawnHeatmapCaches() {
    if (!spawnOverlayEnabled()) {
      _spawnHeatmapData = null;
      _spawnStaticCandidates = null;
      _spawnStaticGameRef = null;
      _spawnStaticTerrainRef = null;
      _spawnStaticWidth = 0;
      _spawnStaticHeight = 0;
      _spawnPlayerPositions.clear();
      _spawnIntentVersion += 1;
      resetSpawnCandidateIndex();
      _spawnHeatmapWasInSpawnPhase = false;
    }
  }

  function setSpawnHeatmapEnabled(enabled) {
    runtimeState.spawnHeatmapEnabled = Boolean(enabled);
    _resetSpawnHeatmapCaches();
    requestMapOverlayLoop();
  }

  function setSpawnMarkersEnabled(enabled) {
    runtimeState.spawnMarkersEnabled = Boolean(enabled);
    _resetSpawnHeatmapCaches();
    requestMapOverlayLoop();
  }
