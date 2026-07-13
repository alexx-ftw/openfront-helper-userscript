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
  const SPAWN_HEATMAP_TOP_N = 5;
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
  function getSpawnTerrain(game) {
    const src = (game && game.__src) || game;
    if (_spawnTerrainSrcRef === src && _spawnTerrainCache) {
      let currentW = _spawnTerrainCache.W;
      let currentH = _spawnTerrainCache.H;
      let currentRaw = null;
      try {
        currentW = game.width ? game.width() : currentW;
        currentH = game.height ? game.height() : currentH;
        currentRaw = src && src._map && src._map.terrain;
      } catch (_error) { /* keep the cached shape */ }
      const sameShape = currentW === _spawnTerrainCache.W && currentH === _spawnTerrainCache.H;
      const sameTerrain = _spawnTerrainCache.raw
        ? !currentRaw || currentRaw === _spawnTerrainCache.terrain
        : !currentRaw;
      if (sameShape && sameTerrain) return _spawnTerrainCache;
    }
    const W = game.width ? game.width() : 0;
    const H = game.height ? game.height() : 0;
    if (W <= 0 || H <= 0) return null;

    // Fast path: the real Uint8Array off the GameView's GameMap.
    try {
      const map = src && src._map;
      const raw = map && map.terrain;
      if (raw && typeof raw.length === "number" && raw.length >= W * H) {
        _spawnTerrainCache = { terrain: raw, W, H, raw: true };
        _spawnTerrainSrcRef = src;
        return _spawnTerrainCache;
      }
    } catch (_error) { /* fall through to bulk read */ }

    // Fallback: reconstruct the buffer once via the proxy (O(W*H), one-time).
    // Prefer terrainByte() — a single public proxy call per tile that returns the
    // exact game byte (IS_LAND_BIT=7 + MAGNITUDE_MASK=0x1f match our constants),
    // half the calls of isLand()+magnitude() and guaranteed to exist on every
    // build. Only fall back to the two-call form if terrainByte is unavailable.
    try {
      const buf = new Uint8Array(W * H);
      const n = W * H;
      const byteFn =
        typeof game.terrainByte === "function"
          ? (ref) => game.terrainByte(ref)
          : null;
      if (byteFn) {
        for (let ref = 0; ref < n; ref += 1) {
          const b = byteFn(ref);
          // Keep only the bits our scorer reads (land + magnitude); drop the rest.
          if (b & (1 << SPAWN_IS_LAND_BIT)) {
            buf[ref] = (1 << SPAWN_IS_LAND_BIT) | (b & SPAWN_MAGNITUDE_MASK);
          }
        }
      } else {
        for (let ref = 0; ref < n; ref += 1) {
          if (game.isLand(ref)) {
            let b = 1 << SPAWN_IS_LAND_BIT;
            if (game.magnitude) b |= game.magnitude(ref) & SPAWN_MAGNITUDE_MASK;
            buf[ref] = b;
          }
        }
      }
      _spawnTerrainCache = { terrain: buf, W, H, raw: false };
      _spawnTerrainSrcRef = src;
      return _spawnTerrainCache;
    } catch (_error) {
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

  function getSpawnBlockedSnapshot(game, size) {
    const blocked = new Uint8Array(size);
    const src = (game && game.__src) || game;
    try {
      const state = src && src._map && src._map.state;
      if (state && typeof state.length === "number" && state.length >= size) {
        for (let ref = 0; ref < size; ref += 1) {
          blocked[ref] = state[ref] & 0x0fff ? 1 : 0;
        }
        return blocked;
      }
    } catch (_error) { /* use the public surface below */ }

    if (typeof game.hasOwner === "function") {
      for (let ref = 0; ref < size; ref += 1) {
        try { blocked[ref] = game.hasOwner(ref) ? 1 : 0; } catch (_error) { /* empty */ }
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
    } catch (_error) { /* FFA or unavailable team API */ }
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
  function computeStaticCandidates(game) {
    const td = getSpawnTerrain(game);
    if (!td) return [];
    const { terrain, W, H } = td;

    const R = SPAWN_HEATMAP_ANALYSIS_R;
    const R2 = R * R;
    const step = SPAWN_HEATMAP_GRID_STEP;
    const candidates = [];

    for (let cy = R; cy < H - R; cy += step) {
      for (let cx = R; cx < W - R; cx += step) {
        // Skip water grid centers immediately — avoids the neighbourhood scan
        // for the majority of cells (ocean), the biggest single speedup.
        if (!isPassableLandByte(terrain[cy * W + cx])) continue;

        let landCount = 0, plainsCount = 0, totalChecked = 0;
        for (let dy = -R; dy <= R; dy += 2) {
          const ny = cy + dy;
          if (ny < 0 || ny >= H) continue;
          const rowBase = ny * W;
          const dy2 = dy * dy;
          for (let dx = -R; dx <= R; dx += 2) {
            if (dx * dx + dy2 > R2) continue; // circular mask
            const nx = cx + dx;
            if (nx < 0 || nx >= W) continue;
            totalChecked += 1;
            const byte = terrain[rowBase + nx];
            if (isPassableLandByte(byte)) {
              landCount += 1;
              if ((byte & SPAWN_MAGNITUDE_MASK) < 10) plainsCount += 1;
            }
          }
        }

        const landDensity = totalChecked > 0 ? landCount / totalChecked : 0;
        const plainsRatio = landCount > 0 ? plainsCount / landCount : 0;
        const edgeX = Math.min(cx, W - cx) / (W / 2);
        const edgeY = Math.min(cy, H - cy) / (H / 2);
        const edgeScore = Math.min(edgeX, edgeY);

        const staticScore =
          landDensity * SPAWN_W.land +
          plainsRatio * SPAWN_W.plains +
          edgeScore * SPAWN_W.edge;

        candidates.push({
          x: cx,
          y: cy,
          staticScore,
          freeLandScore: landDensity,
        });
      }
    }

    candidates.sort((a, b) => b.staticScore - a.staticScore);
    return candidates;
  }

  function getSpawnPlayerType(player) {
    try {
      const type = player && typeof player.type === "function" ? player.type() : null;
      if (type) return type;
    } catch (_error) { /* use the raw view fallback */ }
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

    return {
      nearestDistance(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
        const centerColumn = Math.floor(x / cellSize);
        const centerRow = Math.floor(y / cellSize);
        let nearest = maxRadius;
        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          const row = centerRow + rowOffset;
          if (row < 0 || row >= rows) continue;
          for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            const column = centerColumn + columnOffset;
            if (column < 0 || column >= columns) continue;
            const bucket = buckets[row * columns + column];
            if (!bucket) continue;
            for (const point of bucket) {
              const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
              if (distance < nearest) nearest = distance;
            }
          }
        }
        return nearest;
      },
      score(x, y, radius = maxRadius) {
        const nearest = this.nearestDistance(x, y);
        if (!Number.isFinite(nearest) || nearest >= radius) return 0;
        return Math.max(0, 1 - nearest / radius);
      },
      countWithin(x, y, radius) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || radius <= 0) return 0;
        const centerColumn = Math.floor(x / cellSize);
        const centerRow = Math.floor(y / cellSize);
        let count = 0;
        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          const row = centerRow + rowOffset;
          if (row < 0 || row >= rows) continue;
          for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            const column = centerColumn + columnOffset;
            if (column < 0 || column >= columns) continue;
            const bucket = buckets[row * columns + column];
            if (!bucket) continue;
            for (const point of bucket) {
              const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
              if (distance <= radius) count += 1;
            }
          }
        }
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

  function computeDynamicScores(game, staticCandidates, me) {
    const W = game.width ? game.width() : 0;
    const H = game.height ? game.height() : 0;

    // Enemy / team spawn positions from the GAME API (players that have spawned,
    // via nameLocation). The old WebSocket-intent source is gone; this is the
    // same signal the auto-bot's pickSpawnCenter uses, so the heatmap and the bot
    // agree on where players are.
    //
    // CRITICAL PERF: only count HUMAN players in the enemy-pressure loops. A
    // public game can have hundreds of NATION/BOT entities; those are scored by
    // the bounded proximity indexes below instead of being mixed into pressure.
    const enemySpawns = [];
    const teamSpawns = [];
    const clanSpawns = [];
    const mySid = me && me.smallID ? me.smallID() : null;
    const objectiveApi = getSpawnObjectiveApi();
    const getPlayerClanTag = objectiveApi && typeof objectiveApi.getPlayerClanTag === "function"
      ? objectiveApi.getPlayerClanTag
      : null;
    const sameClanTag = objectiveApi && typeof objectiveApi.sameClanTag === "function"
      ? objectiveApi.sameClanTag
      : null;
    const clanProximityScore = objectiveApi && typeof objectiveApi.clanProximityScore === "function"
      ? objectiveApi.clanProximityScore
      : null;
    const myClanTag = getPlayerClanTag ? getPlayerClanTag(me) : null;
    const players = getCachedPlayerViews(game);
    for (let i = 0; i < players.length; i += 1) {
      const p = players[i];
      if (!p || !p.isAlive || !p.isAlive()) continue;
      try {
        // Humans only (skip NATION + BOT). PlayerType.Human = "HUMAN".
        if (!p.type || p.type() !== "HUMAN") continue;
        if (mySid != null && p.smallID && p.smallID() === mySid) continue;
        if (!p.hasSpawned || !p.hasSpawned()) continue;
      } catch (_error) { continue; }
      let loc = null;
      try { loc = p.nameLocation ? p.nameLocation() : null; } catch (_error) { loc = null; }
      if (!loc || !Number.isFinite(loc.x) || !Number.isFinite(loc.y)) continue;
      let isTeammate = false;
      try {
        isTeammate = Boolean(me && me.isOnSameTeam && me.isOnSameTeam(p));
      } catch (_error) { isTeammate = false; }
      const sameClan = Boolean(
        myClanTag &&
          sameClanTag &&
          sameClanTag(myClanTag, getPlayerClanTag(p)),
      );
      if (sameClan) clanSpawns.push({ x: loc.x, y: loc.y });
      if (isTeammate) {
        teamSpawns.push({ x: loc.x, y: loc.y });
      } else {
        enemySpawns.push({ x: loc.x, y: loc.y });
      }
    }
    const teamMode = teamSpawns.length > 0;
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

    // Compute team centroid (if team mode).
    let teamCentroidX = 0, teamCentroidY = 0;
    if (teamSpawns.length > 0) {
      for (const s of teamSpawns) {
        teamCentroidX += s.x;
        teamCentroidY += s.y;
      }
      teamCentroidX /= teamSpawns.length;
      teamCentroidY /= teamSpawns.length;
    }

    const out = [];
    let maxScore = 0;

    for (const cand of staticCandidates) {
      const { x, y, staticScore } = cand;
      let score = staticScore;
      const freeLandScore = clampSpawnScore(cand.freeLandScore);
      const tribeReach = tribeReachForCandidate(
        tribeProximity,
        x,
        y,
        freeLandScore,
        entities.tribeLocs.length,
      );
      const tribeScore = tribeProximity ? tribeProximity.score(x, y, SPAWN_HEATMAP_TRIBE_R) : 0;
      const nationScore = nationProximity ? nationProximity.score(x, y) : 0;
      score +=
        tribeReach.score * SPAWN_W.tribe +
        tribeScore * SPAWN_W.tribe * 0.15 +
        nationScore * SPAWN_W.nation;

      // Player distance: distance from nearest enemy spawn (farther = better).
      let minEnemyDist = Infinity;
      for (const es of enemySpawns) {
        const d = Math.abs(es.x - x) + Math.abs(es.y - y);
        if (d < minEnemyDist) minEnemyDist = d;
      }
      const playerDistScore = Number.isFinite(minEnemyDist)
        ? Math.min(1, minEnemyDist / SPAWN_HEATMAP_PLAYER_R)
        : 1;
      score += playerDistScore * SPAWN_W.player;

      // Enemy pressure: density of enemies within 220 tiles.
      let pressure = 0;
      for (const es of enemySpawns) {
        const d = Math.abs(es.x - x) + Math.abs(es.y - y);
        if (d < SPAWN_HEATMAP_ENEMY_PRESSURE_R) {
          pressure += 1 - d / SPAWN_HEATMAP_ENEMY_PRESSURE_R;
        }
      }
      const enemyPressureScore = 1 / (1 + Math.max(0, pressure));
      score += enemyPressureScore * SPAWN_W.enemyPressure;

      // Team terms (team mode only).
      if (teamMode) {
        // Team attract: distance from nearest teammate spawn.
        let minTeamDist = Infinity;
        for (const ts of teamSpawns) {
          const d = Math.abs(ts.x - x) + Math.abs(ts.y - y);
          if (d < minTeamDist) minTeamDist = d;
        }
        const teamAttract = Number.isFinite(minTeamDist) ? teamAttractScore(minTeamDist) : 0;
        score += teamAttract * SPAWN_W.team;

        // Team centroid: distance from team centroid.
        if (teamSpawns.length > 0) {
          const centroidDist = Math.abs(teamCentroidX - x) + Math.abs(teamCentroidY - y);
          const centroidScore = Math.max(0, 1 - centroidDist / SPAWN_HEATMAP_TEAM_CENTROID_R);
          score += centroidScore * SPAWN_W.teamCentroid * Math.min(1, teamSpawns.length / 2);
        }
      }

      // Clan cohesion is a tie-break in the fallback path, not an additive
      // attraction. Adding it here could pull the bot toward a clan member
      // even when another candidate had a better open-land/target score.
      const clanScore =
        clanProximityScore && clanSpawns.length > 0
          ? clanProximityScore(
              x,
              y,
              clanSpawns,
              SPAWN_HEATMAP_TEAM_ATTRACT_R,
            )
          : 0;

      if (score > maxScore) maxScore = score;
      out.push({
        x,
        y,
        score,
        freeLandScore,
        tribeScore,
        tribeReachCount: tribeReach.count,
        tribeReachScore: tribeReach.score,
        tribeReachRadius: tribeReach.radius,
        nationScore,
        clanScore,
      });
    }

    // Pick diverse top spots (greedy, >= 60 tiles apart).
    out.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.freeLandScore !== b.freeLandScore) {
        return b.freeLandScore - a.freeLandScore;
      }
      return b.clanScore - a.clanScore;
    });
    const topSpots = [];
    for (const cand of out) {
      if (topSpots.length >= SPAWN_HEATMAP_TOP_N) break;
      let diverse = true;
      for (const spot of topSpots) {
        if (Math.abs(cand.x - spot.x) + Math.abs(cand.y - spot.y) < 60) {
          diverse = false;
          break;
        }
      }
      if (diverse) topSpots.push({ x: cand.x, y: cand.y });
    }

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

  function collectExactSpawnPoints(game, me) {
    const enemySpawns = [];
    const teamSpawns = [];
    const clanSpawns = [];
    const tribeLocs = [];
    const nationLocs = [];
    const objectiveApi = getSpawnObjectiveApi();
    const getPlayerClanTag = objectiveApi && typeof objectiveApi.getPlayerClanTag === "function"
      ? objectiveApi.getPlayerClanTag
      : null;
    const sameClanTag = objectiveApi && typeof objectiveApi.sameClanTag === "function"
      ? objectiveApi.sameClanTag
      : null;
    const myClanTag = getPlayerClanTag ? getPlayerClanTag(me) : null;
    const players = getCachedPlayerViews(game) || [];
    const playersByClientID = new Map();
    const ownKeys = new Set();
    const ownKey = spawnPointKey(me);
    if (ownKey) ownKeys.add(ownKey);

    for (const player of players) {
      const key = spawnPointKey(player);
      if (key) playersByClientID.set(key, player);
    }

    const liveKeys = new Set();
    for (const player of players) {
      if (!isAliveSpawnPlayer(player)) continue;
      const type = getSpawnPlayerType(player);
      let nation = type === "NATION";
      try {
        nation = nation || Boolean(
          typeof isNationBotPlayer === "function" && isNationBotPlayer(player),
        );
      } catch (_error) { /* type is sufficient */ }
      const entityLocation = getSpawnPlayerLocation(player);
      if (entityLocation && (nation || type === "BOT")) {
        (nation ? nationLocs : tribeLocs).push(entityLocation);
      }
      if (type !== "HUMAN") continue;
      const key = spawnPointKey(player);
      if (!key || ownKeys.has(key)) continue;
      let spawned = false;
      try { spawned = Boolean(player.hasSpawned && player.hasSpawned()); } catch (_error) { /* empty */ }
      if (!spawned) continue;
      const location = entityLocation || getSpawnPlayerLocation(player);
      if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) continue;
      liveKeys.add(key);
      let teammate = false;
      try { teammate = Boolean(me && me.isOnSameTeam && me.isOnSameTeam(player)); } catch (_error) { /* empty */ }
      const sameClan = Boolean(
        myClanTag &&
          sameClanTag &&
          sameClanTag(myClanTag, getPlayerClanTag(player)),
      );
      if (sameClan) clanSpawns.push({ x: location.x, y: location.y });
      (teammate ? teamSpawns : enemySpawns).push({ x: location.x, y: location.y });
    }

    // Pending spawn intents are more accurate than nameLocation during the
    // spawn phase. Unknown clients are treated as enemies, which is the safe
    // choice for a collision-avoidance constraint.
    for (const [clientID, entry] of _spawnPlayerPositions) {
      const key = `client:${clientID}`;
      if (ownKeys.has(key) || liveKeys.has(key) || !entry) continue;
      const tile = Number(entry.tile);
      if (!Number.isFinite(tile) || typeof game.x !== "function" || typeof game.y !== "function") continue;
      let x = 0;
      let y = 0;
      try {
        x = game.x(tile);
        y = game.y(tile);
      } catch (_error) {
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const player = playersByClientID.get(key);
      let teammate = false;
      try { teammate = Boolean(player && me && me.isOnSameTeam && me.isOnSameTeam(player)); } catch (_error) { /* unknown */ }
      const sameClan = Boolean(
        player &&
          myClanTag &&
          sameClanTag &&
          sameClanTag(myClanTag, getPlayerClanTag(player)),
      );
      if (sameClan) clanSpawns.push({ x, y });
      (teammate ? teamSpawns : enemySpawns).push({ x, y });
    }

    const signature = [
      String(_spawnIntentVersion),
      myClanTag || "",
      enemySpawns.map((point) => `${point.x},${point.y}`).join(";"),
      teamSpawns.map((point) => `${point.x},${point.y}`).join(";"),
      clanSpawns.map((point) => `${point.x},${point.y}`).join(";"),
      tribeLocs.map((point) => `${point.x},${point.y}`).sort().join(";"),
      nationLocs.map((point) => `${point.x},${point.y}`).sort().join(";"),
    ].join("|");
    return { enemySpawns, teamSpawns, clanSpawns, tribeLocs, nationLocs, signature };
  }

  function insertExactSpawnCandidate(best, candidate) {
    const compare = (left, right) => {
      if (left.objective && right.objective) {
        const dimensions = [
          "robustFloor",
          "safetyScore",
          "expansionScore",
          "teamScore",
          "tribeReachScore",
          "tribeReachCount",
          "freeLandScore",
          "resourceScore",
          "tribeScore",
          "nationScore",
          "clanScore",
          "startScore",
        ];
        for (const dimension of dimensions) {
          if (left.objective[dimension] !== right.objective[dimension]) {
            return right.objective[dimension] - left.objective[dimension];
          }
        }
      }
      if (left.score !== right.score) return right.score - left.score;
      return (left.ref ?? Infinity) - (right.ref ?? Infinity);
    };
    let position = 0;
    while (position < best.length && compare(best[position], candidate) <= 0) position += 1;
    if (position >= SPAWN_HEATMAP_TOP_N && best.length >= SPAWN_HEATMAP_TOP_N) return;
    best.splice(position, 0, candidate);
    if (best.length > SPAWN_HEATMAP_TOP_N) best.pop();
  }

  let _exactSpawnCacheSrcRef = null;
  let _exactSpawnCacheIndexVersion = -1;
  let _exactSpawnCacheSignature = "";
  let _exactSpawnCacheResult = null;

  // Exact map-resolution ranking for the bot. This is deliberately separate
  // from the visual heatmap: the visual layer may stay coarse, while the bot
  // uses a replay-free robust objective over legal start and expansion metrics.
  function computeExactSpawnTopSpotsForBot(game, me) {
    const index = ensureSpawnCandidateIndex(game);
    if (!index || !index.ready) return null;

    const points = collectExactSpawnPoints(game, me);
    if (
      _exactSpawnCacheSrcRef === ((game && game.__src) || game) &&
      _exactSpawnCacheIndexVersion === index.version &&
      _exactSpawnCacheSignature === points.signature
    ) {
      return _exactSpawnCacheResult;
    }

    const W = game.width ? game.width() : index.width;
    const H = game.height ? game.height() : index.height;
    const area = getSpawnAreaForGame(game, me);
    let minDist = 30;
    try {
      const configured = game.config().minDistanceBetweenPlayers();
      if (Number.isFinite(configured)) minDist = configured;
    } catch (_error) { /* keep a conservative fallback */ }
    const tribeProximity = buildSpawnProximityIndex(
      points.tribeLocs,
      W,
      H,
      SPAWN_HEATMAP_TRIBE_REACH_BASE_R + SPAWN_HEATMAP_TRIBE_REACH_BONUS_R,
    );
    const nationProximity = buildSpawnProximityIndex(
      points.nationLocs,
      W,
      H,
      SPAWN_HEATMAP_NATION_R,
    );
    const best = [];
    const objectiveApi = getSpawnObjectiveApi();
    const frontierValueScale = Number(getSpawnIndexApi()?.FRONTIER_VALUE_SCALE) || 1000;
    const teamMode = points.teamSpawns.length > 0;
    let centroidX = 0;
    let centroidY = 0;
    for (const point of points.teamSpawns) {
      centroidX += point.x;
      centroidY += point.y;
    }
    if (teamMode) {
      centroidX /= points.teamSpawns.length;
      centroidY /= points.teamSpawns.length;
    }

    const tooClose = (x, y) => {
      for (const point of points.enemySpawns) {
        if (Math.abs(point.x - x) + Math.abs(point.y - y) < minDist) return true;
      }
      for (const point of points.teamSpawns) {
        if (Math.abs(point.x - x) + Math.abs(point.y - y) < minDist) return true;
      }
      return false;
    };

    index.forEachCandidate({
      mode: "explicit",
      isCenterAllowed: (tile, x, y) => {
        if (area && (x < area.x || x >= area.x + area.width || y < area.y || y >= area.y + area.height)) {
          return false;
        }
        try {
          if (typeof game.hasOwner === "function" && game.hasOwner(tile)) return false;
          if (typeof game.isBorder === "function" && game.isBorder(tile)) return false;
        } catch (_error) {
          return false;
        }
        return !tooClose(x, y);
      },
      onCandidate: (
        tile,
        x,
        y,
        spawnGain,
        invalidCount,
        plainsGain,
        frontierGain,
        _frontierPlainsGain,
        frontierValueGain,
        frontierSlots,
      ) => {
        const totalSpawnTiles = spawnGain + invalidCount;
        const clusterScore = spawnGain / Math.max(1, totalSpawnTiles);
        const plainsScore = plainsGain / Math.max(1, spawnGain);
        const edgeX = Math.min(x, W - 1 - x) / Math.max(1, W / 2);
        const edgeY = Math.min(y, H - 1 - y) / Math.max(1, H / 2);
        const edgeScore = Math.max(0, Math.min(edgeX, edgeY));
        const freeLandScore = calculateSpawnFreeLandScore(
          clusterScore,
          frontierGain,
          frontierSlots,
          frontierValueGain,
          frontierValueScale,
        );
        const tribeReach = tribeReachForCandidate(
          tribeProximity,
          x,
          y,
          freeLandScore,
          points.tribeLocs.length,
        );
        const tribeScore = tribeProximity ? tribeProximity.score(x, y, SPAWN_HEATMAP_TRIBE_R) : 0;
        const nationScore = nationProximity ? nationProximity.score(x, y) : 0;
        const resourceScore = combineSpawnEntityScore(
          tribeScore,
          nationScore,
          tribeReach.score,
          points.tribeLocs.length,
          points.nationLocs.length,
        );

        let minEnemyDist = Infinity;
        let pressure = 0;
        for (const point of points.enemySpawns) {
          const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
          minEnemyDist = Math.min(minEnemyDist, distance);
          if (distance < SPAWN_HEATMAP_ENEMY_PRESSURE_R) {
            pressure += 1 - distance / SPAWN_HEATMAP_ENEMY_PRESSURE_R;
          }
        }
        const playerScore = Number.isFinite(minEnemyDist)
          ? Math.min(1, minEnemyDist / SPAWN_HEATMAP_PLAYER_R)
          : 1;
        const pressureScore = 1 / (1 + pressure);

        // Keep the exact selector's clan distance inline: this callback runs
        // once per legal map tile, so an extra cross-file function call here is
        // materially more expensive on large maps. `clanSpawns` is normalized
        // by collectExactSpawnPoints above.
        let minClanDist = Infinity;
        for (let index = 0; index < points.clanSpawns.length; index += 1) {
          const point = points.clanSpawns[index];
          const distance = Math.abs(point.x - x) + Math.abs(point.y - y);
          if (distance < minClanDist) minClanDist = distance;
        }

        let score =
          clusterScore * SPAWN_W.land +
          plainsScore * SPAWN_W.plains +
          tribeReach.score * SPAWN_W.tribe +
          tribeScore * SPAWN_W.tribe * 0.15 +
          nationScore * SPAWN_W.nation +
          playerScore * SPAWN_W.player +
          edgeScore * SPAWN_W.edge +
          pressureScore * SPAWN_W.enemyPressure;

        let teamScore = 1;
        if (teamMode) {
          let minTeamDist = Infinity;
          for (const point of points.teamSpawns) {
            minTeamDist = Math.min(minTeamDist, Math.abs(point.x - x) + Math.abs(point.y - y));
          }
          const teamAttract = teamAttractScore(minTeamDist);
          const centroidScore = Math.max(
            0,
            1 - Math.abs(centroidX - x) / SPAWN_HEATMAP_TEAM_CENTROID_R -
              Math.abs(centroidY - y) / SPAWN_HEATMAP_TEAM_CENTROID_R,
          );
          teamScore = Math.min(teamAttract, centroidScore);
          score += teamAttract * SPAWN_W.team;
          const centroidDist = Math.abs(centroidX - x) + Math.abs(centroidY - y);
          score +=
            Math.max(0, 1 - centroidDist / SPAWN_HEATMAP_TEAM_CENTROID_R) *
            SPAWN_W.teamCentroid * Math.min(1, points.teamSpawns.length / 2);
        }

        const clanScore =
          minClanDist === Infinity
            ? 0
            : Math.max(0, 1 - minClanDist / SPAWN_HEATMAP_TEAM_ATTRACT_R);
        score += clanScore * SPAWN_W.clan;

        const frontierCoverage = Number.isFinite(Number(frontierSlots))
          ? frontierSlots > 0
            ? frontierValueGain / (frontierSlots * frontierValueScale)
            : freeLandScore
          : clusterScore;
        const objective = objectiveApi && typeof objectiveApi.evaluateModelCandidate === "function"
          ? objectiveApi.evaluateModelCandidate({
              startScore: clusterScore,
              expansionScore: Math.min(clusterScore, frontierCoverage),
              safetyScore: Math.min(playerScore, pressureScore, edgeScore),
              teamScore,
              tribeScore: points.tribeLocs.length > 0 ? tribeScore : 1,
              nationScore: points.nationLocs.length > 0 ? nationScore : 1,
              tribeReachScore: tribeReach.score,
              tribeReachCount: tribeReach.count,
              freeLandScore,
              resourceScore,
              clanScore,
            })
          : null;

        insertExactSpawnCandidate(best, {
          ref: tile,
          x,
          y,
          score,
          spawnGain,
          frontierGain,
          frontierValueGain,
          freeLandScore,
          tribeScore,
          tribeReachCount: tribeReach.count,
          tribeReachScore: tribeReach.score,
          tribeReachRadius: tribeReach.radius,
          nationScore,
          resourceScore,
          clanScore,
          objective,
        });
      },
    });

    const result = best.length > 0 ? best : null;
    _exactSpawnCacheSrcRef = (game && game.__src) || game;
    _exactSpawnCacheIndexVersion = index.version;
    _exactSpawnCacheSignature = points.signature;
    _exactSpawnCacheResult = result;
    return result;
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
  function computeSpawnTopSpotsForBot(game, me) {
    try {
      const exact = computeExactSpawnTopSpotsForBot(game, me);
      if (exact && exact.length > 0) return exact;
      const src = (game && game.__src) || game;
      const td = getSpawnTerrain(game);
      let tick = -1;
      try { tick = Number(game.ticks ? game.ticks() : -1); } catch (_e) { tick = -1; }
      if (
        _botTopSpotsGameRef === src &&
        _botTopSpotsTerrainRef === (td && td.terrain) &&
        Number.isFinite(tick) &&
        tick === _botTopSpotsTick
      ) {
        return _botTopSpotsResult;
      }
      const _botSpawnStaticCandidates = ensureSpawnStaticCandidates(game);
      if (!_botSpawnStaticCandidates || _botSpawnStaticCandidates.length === 0) {
        return null;
      }
      const data = computeDynamicScores(game, _botSpawnStaticCandidates, me);
      const result =
        data && data.topSpots && data.topSpots.length > 0 ? data.topSpots : null;
      _botTopSpotsGameRef = src;
      _botTopSpotsTerrainRef = td && td.terrain;
      _botTopSpotsTick = Number.isFinite(tick) ? tick : -1;
      _botTopSpotsResult = result;
      return result;
    } catch (_error) {
      return null;
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────

  const _spawnCellPt = { x: 0, y: 0 };
  function drawSpawnHeatmap(ctx, game, transform) {
    if (!_spawnHeatmapData) return;
    const { scores, topSpots, maxScore } = _spawnHeatmapData;
    if (maxScore <= 0 && (!topSpots || topSpots.length === 0)) return;
    const cell = SPAWN_HEATMAP_CELL;
    const halfCell = cell / 2;
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const invMax = maxScore > 0 ? 1 / maxScore : 0;
    let drawn = 0;

    // Derive the affine projector ONCE (3 transform calls) then project every
    // cell with arithmetic — avoids ~1200 worldToScreenCoordinates per frame.
    const proj = mapMakeProjector(transform);
    if (!proj) return;

    ctx.save();
    // Colored heatmap cells — only when the heatmap layer is on.
    if (spawnHeatmapEnabled && maxScore > 0) {
      for (let i = 0; i < scores.length && drawn < SPAWN_HEATMAP_MAX_CELLS; i += 1) {
        const item = scores[i];
        mapProject(proj, item.x, item.y, _spawnCellPt);
        const px = _spawnCellPt.x;
        const py = _spawnCellPt.y;
        if (px < -cell || py < -cell || px > innerW + cell || py > innerH + cell) continue;
        const value = item.score * invMax;
        const r = ((1 - value) * 255) | 0;
        const g = (value * 255) | 0;
        const alpha = value * 0.45 + 0.12;
        ctx.fillStyle = `rgba(${r},${g},42,${alpha.toFixed(2)})`;
        ctx.fillRect(px - halfCell, py - halfCell, cell, cell);
        drawn++;
      }
    }

    // Numbered top-spot markers — only when the markers layer is on. Can show
    // WITHOUT the heatmap (clean map, just the best spots).
    if (!spawnMarkersEnabled) {
      ctx.restore();
      return;
    }
    const spotColors = ["#ffd54f", "#9ccc65", "#9ccc65", "#d8dde6", "#d8dde6"];
    for (let i = 0; i < topSpots.length; i += 1) {
      const spot = topSpots[i];
      mapProject(proj, spot.x, spot.y, _spawnCellPt);
      const p = _spawnCellPt;
      if (!mapPointOnScreen(p.x, p.y, 20)) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = spotColors[i] || "#d8dde6";
      ctx.stroke();
      ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
      ctx.fill();
      ctx.fillStyle = spotColors[i] || "#d8dde6";
      ctx.font = 'bold 10px "Aptos", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    }
    ctx.restore();
  }

  function spawnOverlayEnabled() {
    return spawnHeatmapEnabled || spawnMarkersEnabled;
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
    spawnHeatmapEnabled = Boolean(enabled);
    _resetSpawnHeatmapCaches();
    requestMapOverlayLoop();
  }

  function setSpawnMarkersEnabled(enabled) {
    spawnMarkersEnabled = Boolean(enabled);
    _resetSpawnHeatmapCaches();
    requestMapOverlayLoop();
  }
