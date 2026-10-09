// Auto-Bot — gameApi: the data-access shim that lets the faithfully-ported Nation
// behaviors run against the CLIENT view as if they were running in core.
//
// The src behaviors are written against the core Game/Player/Unit (synchronous,
// full data). The client GameView/PlayerView/UnitView mirror most of it but:
//   - some reads are ASYNC worker calls (borderTiles, buildables, profile,
//     bestTransportShipSpawn, actions);
//   - a few core reads are not surfaced at all (relation values, nearby(),
//     sharedWaterComponents, railNetwork).
//
// gameApi presents a CORE-SHAPED, SYNCHRONOUS interface to the behaviors. Async
// data is refreshed in short windows by beginTick() (me's borderTiles + profile)
// and lazily-cached per target; the behaviors then read it synchronously
// so the ported code stays a 1:1 diff against src. The two genuinely-missing
// datasets (sharedWaterComponents, railNetwork) are reconstructed in §SHIMS and
// are the ONLY approximated data (used for structure-placement candidate
// selection and scoring only).
//
// `src` is the client-shape game: the real GameView in the extension, or the
// training coreAdapter `game` in the headless harness — both expose the same
// client surface, so the SAME behaviors validate against core for free.
//
// Loaded after portutil, before the behaviors.

"use strict";

  // Relation enum — src/core/game/Game.ts:464
  const Relation = { Hostile: 0, Distrustful: 1, Neutral: 2, Friendly: 3 };

  // relationFromValue — src/core/game/PlayerImpl.ts:638
  function relationFromValue(v) {
    if (v < -50) return Relation.Hostile;
    if (v < 0) return Relation.Distrustful;
    if (v < 50) return Relation.Neutral;
    return Relation.Friendly;
  }
  // Representative raw midpoint of each bucket (profile() gives the bucket, not
  // the raw int the server keeps; we reconstruct an approximate raw — §8.1).
  function bucketMidpoint(rel) {
    switch (rel) {
      case Relation.Hostile:
        return -75;
      case Relation.Distrustful:
        return -25;
      case Relation.Friendly:
        return 75;
      default:
        return 25; // Neutral
    }
  }

  function makePlayerMethodPassThrough(core, name, fallback) {
    return (...args) =>
      typeof core[name] === "function"
        ? core[name](...args.map((value) => (value?.__src ? value.__src : value)))
        : fallback;
  }

  // The factory deliberately owns all mutable caches in one per-game closure so
  // concurrent headless games cannot leak state. Splitting it into module state
  // would weaken that isolation; its nested helpers are linted individually.
  // eslint-disable-next-line max-lines-per-function, max-statements
  function createGameApi(src) {
    const playerCache = new Map(); // smallID -> wrapped player
    const borderCache = new Map(); // smallID -> { tick, set:Set<TileRef> }
    const shoreBorderCache = new WeakMap(); // border Set -> shore TileRef[]
    const oceanShoreBorderCache = new WeakMap(); // border Set -> ocean-shore TileRef[]
    // Relation overlay: ONLY the AI-subjective deltas WE issue this game
    // (embargo malus ±20, assist −20, warship −7.5/−15). The engine-applied
    // relation changes for our slot are already in profile(); the overlay is an
    // OFFSET added on top of the profile bucket midpoint (§8.1), decayed 0.05/tick.
    const overlay = new Map(); // smallID -> offset
    let profileRelations = new Map(); // smallID -> Relation bucket (from profile())
    let profileLoaded = false;
    let profileFetchedAt = 0;
    let profileInFlight = null;
    const PROFILE_REFRESH_MS = 1500;
    let mePlayer = null; // wrapped me
    let lastSnapshotTick = -1;
    const transportSpawnCache = new Map(); // target TileRef -> spawn TileRef|false
    const transportRouteCache = new Map(); // target TileRef -> ticks|null
    // The fallback water graph is static. Preserve successful routes across
    // snapshots and reuse them only when the authoritative launch probe returns
    // the exact same spawn tile for the same destination.
    const localTransportRouteCache = new Map(); // target -> { spawn, ticks }
    // GameView.units() materializes a fresh snapshot on every call. Several
    // behaviors inspect the same unit families during one bot tick, so keep
    // the wrapped arrays shared until the game advances. This removes repeated
    // worker/view traversal and wrapper allocation without carrying state across
    // authoritative game ticks.
    let unitSnapshotTick = null;
    const unitSnapshotCache = new Map();
    let playerSnapshotTick = null;
    let playerSnapshot = null;
    // Prefer an upstream exact hook when one exists. The current GameView has no
    // route worker message, so the local full-resolution water graph is the fallback.
    // DIVERGENCE: this fallback measures shortest full-resolution water distance;
    // it does not reproduce the engine worker's HPA/smoothing implementation.
    const hasLocalTransportRouteEstimator =
      typeof src.neighbors === "function" &&
      typeof src.isWater === "function" &&
      typeof src.isLand === "function" &&
      typeof src.isShore === "function" &&
      typeof src.ownerID === "function" &&
      typeof src.manhattanDist === "function";
    const hasTransportRouteEstimator =
      typeof src.transportRouteTicks === "function" || hasLocalTransportRouteEstimator;

    const unwrap = (p) => (p && p.__src ? p.__src : p);

    function unitTypeKey(types) {
      return types.map((type) => String(type)).sort().join("\u0001");
    }

    // Vendored units() caps at three positional types; enumerate per type.
    function rawUnitsByType(owner, types) {
      const out = [];
      for (const type of types) out.push(...owner.units(type));
      return out;
    }

    function cachedUnits(owner, ownerKey, types) {
      const tick = typeof src.ticks === "function" ? src.ticks() : null;
      if (tick === null || tick === undefined) {
        return rawUnitsByType(owner, types).map(wrapUnit);
      }

      if (unitSnapshotTick !== tick) {
        unitSnapshotTick = tick;
        unitSnapshotCache.clear();
      }

      const key = `${String(ownerKey)}\u0002${unitTypeKey(types)}`;
      if (unitSnapshotCache.has(key)) {
        return unitSnapshotCache.get(key);
      }

      const units = rawUnitsByType(owner, types).map(wrapUnit);
      unitSnapshotCache.set(key, units);
      return units;
    }

    function normalizeTransportRouteResult(result) {
      if (Number.isFinite(result)) return Math.max(0, Number(result));
      const path = result && (result.fullPath || result.path) ? result.fullPath || result.path : result;
      if (path == null || typeof path.length !== "number" || path.length === 0) {
        return null;
      }
      const length = Number(path.length);
      return Number.isFinite(length) ? Math.max(0, length - 1) : null;
    }

    function closestTargetShore(targetTile) {
      const ownerID = src.ownerID(targetTile);
      const seen = new Set([targetTile]);
      const queue = [targetTile];
      const candidates = [];
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        if (src.manhattanDist(targetTile, current) > 50) continue;
        if (
          src.isLand(current) &&
          src.isShore(current) &&
          src.ownerID(current) === ownerID
        ) {
          candidates.push(current);
        }
        for (const next of src.neighbors(current) || []) {
          if (seen.has(next)) continue;
          if (src.manhattanDist(targetTile, next) > 50) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      candidates.sort(
        (a, b) =>
          src.manhattanDist(targetTile, a) - src.manhattanDist(targetTile, b),
      );
      return candidates[0] ?? null;
    }

    function rememberTransportShipSpawn(core, targetTile) {
      const result = core.bestTransportShipSpawn(targetTile);
      return Promise.resolve(result).then((spawn) => {
        transportSpawnCache.set(targetTile, spawn);
        return spawn;
      });
    }

    async function estimateTransportRouteTicks(targetTile) {
      if (transportRouteCache.has(targetTile)) {
        return transportRouteCache.get(targetTile);
      }
      {
        if (typeof src.transportRouteTicks === "function") {
          const result = normalizeTransportRouteResult(
            await src.transportRouteTicks(targetTile),
          );
          transportRouteCache.set(targetTile, result);
          return result;
        }
        const routeFinder =
          typeof findWaterRouteTicksAsync === "function"
            ? findWaterRouteTicksAsync
            : findWaterRouteTicks;
        if (!hasLocalTransportRouteEstimator || typeof routeFinder !== "function") {
          return null;
        }
        const spawn = transportSpawnCache.get(targetTile);
        if (spawn == null || spawn === false) return null;
        const cachedRoute = localTransportRouteCache.get(targetTile);
        // A successful path stays reusable as long as the authoritative spawn
        // is unchanged. Do not resolve a coast just to validate this hot path.
        if (cachedRoute?.spawn === spawn && cachedRoute.ticks !== null) {
          return cachedRoute.ticks;
        }
        const goal = closestTargetShore(targetTile);
        if (cachedRoute?.spawn === spawn && cachedRoute.goal === goal) {
          return cachedRoute.ticks;
        }
        if (goal == null) {
          // Keep a negative route result too. A distant target that has no
          // reachable coast would otherwise restart the same bounded BFS every
          // game tick. The authoritative launch tile and resolved goal are part
          // of the cache key, so a new port/spawn or changed target coast
          // invalidates this result before it can affect target selection.
          localTransportRouteCache.set(targetTile, { spawn, goal, ticks: null });
          transportRouteCache.set(targetTile, null);
          return null;
        }
        const result = await routeFinder({
          start: spawn,
          goal,
          neighbors: (tile) => src.neighbors(tile),
          isWater: (tile) => src.isWater(tile),
          maxTicks: BOAT_EXPLORATION_MAX_ROUTE_TICKS,
        });
        // A failed bounded search is as stable as a successful route while the
        // authoritative spawn and target shore remain unchanged. Cache both to
        // avoid repeating an expensive negative BFS every auxiliary attack tick.
        localTransportRouteCache.set(targetTile, { spawn, goal, ticks: result });
        transportRouteCache.set(targetTile, result);
        return result;
      }
    }

    function isPlayerObj(o) {
      {
        return Boolean(o && typeof o.isPlayer === "function" && o.isPlayer());
      }
    }

    // ── unit wrapper: delegate to the src unit, wrap owner() ──────────────────
    function wrapUnit(u) {
      if (u == null) return u;
      const m = (name, dflt) => (...a) =>
        typeof u[name] === "function" ? u[name](...a) : dflt;
      return {
        __src: u,
        owner: () => wrapPlayer(u.owner()),
        isFriendly: (other) => wrapPlayer(u.owner())?.isFriendly(other) ?? false,
        type: m("type", null),
        tile: m("tile", null),
        level: m("level", 1),
        id: m("id", null),
        isActive: m("isActive", false),
        isUnderConstruction: m("isUnderConstruction", false),
        isInCombat: m("isInCombat", false),
        hasTrainStation: m("hasTrainStation", false),
        missileTimerQueue: m("missileTimerQueue", []),
        targetTile: m("targetTile", undefined),
        targetUnit: () => {
          if (typeof u.targetUnit === "function") return wrapUnit(u.targetUnit());
          const targetID =
            typeof u.targetUnitId === "function" ? u.targetUnitId() : undefined;
          return wrapUnit(
            targetID === undefined || typeof src.unit !== "function"
              ? undefined
              : src.unit(targetID),
          );
        },
        patrolTile: m("patrolTile", undefined),
        warshipState: m("warshipState", undefined),
        transportShipState: m("transportShipState", undefined),
        health: m("health", undefined),
        ticksLeftInCooldown: m("ticksLeftInCooldown", 0),
        lastSetSafeFromPirates: m("lastSetSafeFromPirates", undefined),
      };
    }

    // Client AttackUpdate (PlayerView.incomingAttacks) is a PLAIN object with
    // FIELDS: { troops:number, attackerID:number, targetID:number,
    // retreating:bool, id:string } (NO attacker()/target() methods, sourceTile
    // is absent on the wire). The coreAdapter wraps core attacks into the same
    // field shape. The ported behaviors call core-style METHOD accessors, so we
    // expose methods over the fields. `val` tolerates either a value or a fn
    // while preserving the source attack as a method receiver.
    function wrapAttack(a) {
      const val = (key) => {
        const value = a[key];
        return typeof value === "function" ? value.call(a) : value;
      };
      return {
        __src: a,
        troops: () => Number(val("troops") ?? 0),
        attacker: () =>
          wrapPlayer(
            typeof a.attacker === "function"
              ? a.attacker()
              : srcPlayerBySmallID(a.attackerID),
          ),
        target: () =>
          wrapPlayer(
            typeof a.target === "function"
              ? a.target()
              : srcPlayerBySmallID(a.targetID),
          ),
        retreating: () => val("retreating") ?? false,
        id: () => val("id"),
        // client AttackUpdate has no sourceTile on the wire → undefined in the
        // extension; the coreAdapter (harness) DOES set it. `hasSourceTile()`
        // lets consumers use the exact value when present and reconstruct it
        // (land = attacker shares a land border) when absent — see structureBehavior.
        hasSourceTile: () => a.sourceTile !== undefined,
        sourceTile: () => (a.sourceTile !== undefined ? val("sourceTile") : null),
      };
    }

    function srcPlayerBySmallID(sid) {
      if (sid == null) return null;
      {
        return src.playerBySmallID(sid);
      }
    }

    // ── relation overlay helpers ──────────────────────────────────────────────
    function relationRawFor(otherSmallID) {
      const bucket = profileRelations.has(otherSmallID)
        ? profileRelations.get(otherSmallID)
        : Relation.Neutral;
      const off = overlay.get(otherSmallID) ?? 0;
      return bucketMidpoint(bucket) + off;
    }

    // ── player wrapper ────────────────────────────────────────────────────────
    function wrapPlayer(core) {
      if (core == null) return null;
      if (!isPlayerObj(core)) {
        // TerraNullius / non-player passthrough (carry isPlayer()===false).
        return core;
      }
      const sid = core.smallID();
      let w = playerCache.get(sid);
      if (w) {
        w.__src = core; // refresh underlying view (it may be a fresh object)
        return w;
      }
      w = makePlayer(core, sid);
      playerCache.set(sid, w);
      return w;
    }

    function cachedPlayers() {
      const tick = typeof src.ticks === "function" ? src.ticks() : null;
      if (tick === null || tick === undefined) {
        return src.players().map(wrapPlayer);
      }
      if (playerSnapshotTick !== tick || playerSnapshot === null) {
        playerSnapshotTick = tick;
        playerSnapshot = src.players().map(wrapPlayer);
      }
      return playerSnapshot;
    }

    function makePlayer(core, sid) {
      const pass = (name, fallback) =>
        makePlayerMethodPassThrough(core, name, fallback);
      const w = {
        __src: core,
        isPlayer: () => true,
        isAlive: pass("isAlive", false),
        hasSpawned: pass("hasSpawned", false),
        smallID: () => core.smallID(),
        id: () => core.id(),
        clientID: pass("clientID", null),
        type: pass("type", null),
        name: pass("name", "?"),
        displayName: pass("displayName", "?"),
        troops: () => Number(core.troops?.() ?? 0),
        gold: () => core.gold?.() ?? 0n,
        numTilesOwned: () => Number(core.numTilesOwned?.() ?? 0),
        team: pass("team", null),
        maxTroops: () => api.config().maxTroops(w),
        isTraitor: pass("isTraitor", false),
        isDisconnected: pass("isDisconnected", false),
        betrayals: pass("betrayals", 0),
        getTraitorRemainingTicks: pass("getTraitorRemainingTicks", 0),

        units: (...types) => cachedUnits(core, `player:${sid}`, types),
        unitCount: (type) => cachedUnits(core, `player:${sid}`, [type]).length,
        // unitsOwned/unitsConstructed — core semantics: built (not under
        // construction) units of a type.
        unitsOwned: (type) =>
          cachedUnits(core, `player:${sid}`, [type]).filter(
            (u) => !(u.isUnderConstruction?.() ?? false),
          ).length,
        unitsConstructed: (type) =>
          cachedUnits(core, `player:${sid}`, [type]).some(
            (u) => !(u.isUnderConstruction?.() ?? false),
          ),
        totalUnitLevels: (type) =>
          cachedUnits(core, `player:${sid}`, [type])
            .filter((u) => !(u.isUnderConstruction?.() ?? false))
            .reduce((acc, u) => acc + (u.level?.() ?? 1), 0),

        incomingAttacks: () => core.incomingAttacks().map(wrapAttack),
        outgoingAttacks: () => core.outgoingAttacks().map(wrapAttack),
        targets: () => (core.targets ? core.targets().map(wrapPlayer) : []),
        allies: () => (core.allies ? core.allies().map(wrapPlayer) : []),
        transitiveTargets: () =>
          core.transitiveTargets ? core.transitiveTargets().map(wrapPlayer) : [],
        alliances: () => (core.alliances ? core.alliances() : []),

        isFriendly: (o) => core.isFriendly(unwrap(o)),
        canAttackPlayer: (o, treatAFKFriendly = true) =>
          core.canAttackPlayer
            ? core.canAttackPlayer(unwrap(o), treatAFKFriendly)
            : !core.isFriendly(unwrap(o)),
        isAlliedWith: (o) => core.isAlliedWith(unwrap(o)),
        isOnSameTeam: (o) => core.isOnSameTeam(unwrap(o)),
        isRequestingAllianceWith: (o) =>
          core.isRequestingAllianceWith
            ? core.isRequestingAllianceWith(unwrap(o))
            : false,
        hasEmbargoAgainst: (o) =>
          core.hasEmbargoAgainst ? core.hasEmbargoAgainst(unwrap(o)) : false,

        nameLocation: () =>
          core.nameLocation ? core.nameLocation() : { x: 0, y: 0 },

        // ── borderTiles: SYNC snapshot Set (core-shape). Populated by beginTick
        //    for me, and by ensureBorderTiles() for targets (lazy, cached/tick).
        borderTiles: () => {
          // Return the latest cached border snapshot (populated by ensureBorderTiles,
          // time-based so it survives MAX-game-speed worker saturation). NOT gated on
          // the exact tick — a ~1.5s-stale border is far better than blinding the bot.
          const c = borderCache.get(core.smallID());
          return c && c.set ? c.set : new Set();
        },
        // Multiple combat policies consume the same coast during one border
        // snapshot. Derive it once because isShore can be much more expensive
        // than walking the already-cached Set.
        shoreBorderTiles: () => shoreBorderTilesFor(core),
        // Open-ocean shores are a stricter subset than generic shores: lakes and
        // closed seas cannot launch the early maritime probe. Cache this exact
        // predicate separately so consumers never trade correctness for reuse.
        oceanShoreBorderTiles: () => oceanShoreBorderTilesFor(core),

        // ── relation (reconstructed via profile() + overlay) ──────────────────
        relation: (o) => {
          const osid = unwrapSmallID(o);
          return relationFromValue(within(relationRawFor(osid), -100, 100));
        },
        allRelationsSorted: () => {
          // Build {player, raw} for every player we have a relation signal for
          // (profile keys ∪ overlay keys), alive only, sort ASC by raw then
          // smallID (stable tie-break — §8.1), bucket.
          const sids = new Set();
          for (const k of profileRelations.keys()) sids.add(k);
          for (const k of overlay.keys()) sids.add(k);
          const out = [];
          for (const sid of sids) {
            if (sid === core.smallID()) continue;
            const p = api.playerBySmallID(sid);
            if (!p || !p.isPlayer || !p.isPlayer() || !p.isAlive()) continue;
            out.push({ player: p, raw: relationRawFor(sid), sid });
          }
          out.sort((a, b) => a.raw - b.raw || a.sid - b.sid);
          return out.map((r) => ({
            player: r.player,
            relation: relationFromValue(within(r.raw, -100, 100)),
          }));
        },
        // updateRelation: AI-subjective → write the OFFSET (no client intent).
        updateRelation: (o, delta) => {
          const osid = unwrapSmallID(o);
          if (osid == null || osid === core.smallID()) return;
          overlay.set(osid, within((overlay.get(osid) ?? 0) + delta, -100, 100));
        },

        // ── nearby(): EXACT reconstruction — src/core/game/PlayerImpl.ts:359 ───
        nearby: () => nearbyOf(w),
        sharesBorderWith: (o) => sharesBorderWith(w, o),

        // ── async probes (worker calls) — used by the rank-then-probe paths ───
        borderTilesAsync: () => core.borderTiles(),
        buildables: (tile, types) => core.buildables(tile, types),
        bestTransportShipSpawn: (tile) => rememberTransportShipSpawn(core, tile),
        profile: () => core.profile(),
        actions: (tile, units) =>
          core.actions ? core.actions(tile, units) : Promise.resolve(null),
      };
      return w;
    }

    function unwrapSmallID(o) {
      if (o == null) return null;
      if (typeof o === "number") return o;
      if (typeof o.smallID === "function") return o.smallID();
      return null;
    }

    function shoreBorderTilesFrom(border) {
      if (!border?.size) return [];
      const cached = shoreBorderCache.get(border);
      if (cached) return cached;
      const shores = [];
      for (const tile of border) {
        if (src.isShore(tile)) shores.push(tile);
      }
      shoreBorderCache.set(border, shores);
      return shores;
    }

    function shoreBorderTilesFor(player) {
      return shoreBorderTilesFrom(borderCache.get(player.smallID())?.set);
    }

    function oceanShoreBorderTilesFrom(border) {
      if (!border?.size) return [];
      // `null` means this client cannot answer the exact ocean predicate. It
      // is distinct from an empty array: structure placement can then use its
      // compatible isShore/isWater/isOcean reconstruction without mistaking an
      // unavailable client capability for a coastless territory.
      if (typeof src.isOceanShore !== "function") return null;
      const cached = oceanShoreBorderCache.get(border);
      if (cached) return cached;
      const shores = [];
      for (const tile of border) {
        if (src.isOceanShore(tile)) shores.push(tile);
      }
      oceanShoreBorderCache.set(border, shores);
      return shores;
    }

    function oceanShoreBorderTilesFor(player) {
      return oceanShoreBorderTilesFrom(borderCache.get(player.smallID())?.set);
    }

    // nearby — union of (a) owners of LAND neighbors of our border tiles whose
    // owner != us (incl. TerraNullius), and (b) shore-reachable neighbors across
    // narrow rivers. Fully synchronous over the border snapshot.
    function addNearbyOwner(neighbors, ownerSid, mySid) {
      if (ownerSid === mySid) return;
      if (ownerSid == null) {
        neighbors.set("TN", api.terraNullius());
        return;
      }
      const player = api.playerBySmallID(ownerSid);
      if (player) neighbors.set(ownerSid, player);
    }

    function addLandBorderNeighbors(neighbors, border, mySid) {
      for (const borderTile of border) {
        for (const neighbor of src.neighbors(borderTile)) {
          if (!src.isLand(neighbor)) continue;
          const ownerSid = src.hasOwner(neighbor) ? src.ownerID(neighbor) : null;
          addNearbyOwner(neighbors, ownerSid, mySid);
        }
      }
    }

    function shoreProbeOwner(borderTile, dx, dy) {
      const x = src.x(borderTile);
      const y = src.y(borderTile);
      const waterX = x + dx;
      const waterY = y + dy;
      if (!src.isValidCoord(waterX, waterY) || !src.isWater(src.ref(waterX, waterY))) return undefined;
      const probeX = x + dx * 5;
      const probeY = y + dy * 5;
      if (!src.isValidCoord(probeX, probeY)) return undefined;
      const tile = src.ref(probeX, probeY);
      if (!src.isLand(tile) || (!src.hasOwner(tile) && src.hasFallout(tile))) return undefined;
      return src.hasOwner(tile) ? src.ownerID(tile) : null;
    }

    function addShoreReachableNeighbors(neighbors, border, mySid) {
      const shores = shoreBorderTilesFrom(border);
      const directions = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      for (let index = 0; index < shores.length; index += 10) {
        for (const [dx, dy] of directions) {
          const ownerSid = shoreProbeOwner(shores[index], dx, dy);
          if (ownerSid !== undefined) addNearbyOwner(neighbors, ownerSid, mySid);
        }
      }
    }

    function nearbyOf(me) {
      const neighbors = new Map();
      const mySid = me.smallID();
      const border = me.borderTiles();
      addLandBorderNeighbors(neighbors, border, mySid);
      addShoreReachableNeighbors(neighbors, border, mySid);
      return Array.from(neighbors.values());
    }

    // sharesBorderWith — does any LAND neighbor of our border tiles belong to other?
    function borderNeighborMatches(neighbor, ownerSid) {
      if (!src.isLand(neighbor)) return false;
      return ownerSid == null
        ? !src.hasOwner(neighbor)
        : src.hasOwner(neighbor) && src.ownerID(neighbor) === ownerSid;
    }

    let borderRelationCacheTick = null;
    const borderRelationCache = new Map();
    function sharesBorderWith(me, other) {
      const ownerSid = unwrapSmallID(other);
      const tick = typeof src.ticks === "function" ? src.ticks() : null;
      if (borderRelationCacheTick !== tick) {
        borderRelationCacheTick = tick;
        borderRelationCache.clear();
      }
      const cacheKey = `${me.smallID()}:${ownerSid ?? "terra-nullius"}`;
      if (borderRelationCache.has(cacheKey)) {
        return borderRelationCache.get(cacheKey);
      }
      for (const borderTile of me.borderTiles()) {
        for (const neighbor of src.neighbors(borderTile)) {
          if (borderNeighborMatches(neighbor, ownerSid)) {
            borderRelationCache.set(cacheKey, true);
            return true;
          }
        }
      }
      borderRelationCache.set(cacheKey, false);
      return false;
    }

    // ── config proxy: forward to src.config(), but UNWRAP gameApi players in
    //    maxTroops (both the real Config and the coreAdapter proxy expect the
    //    underlying player, not our wrapper). Memoized — config() is stable.
    let _srcConfig = null;
    let _configProxy = null;
    function attackTileHasDefensePost(game, defender, tile) {
      if (defender === null) return false;
      return game.nearbyUnits(tile, game.config().defensePostRange(), UNIT.DefensePost)
        .some((entry) => {
          const unit = entry.unit ?? entry;
          return unit.owner().smallID() === defender.smallID() &&
            unit.isActive() && !unit.isUnderConstruction();
        });
    }
    function configProxy() {
      const sc = src.config();
      if (_configProxy && _srcConfig === sc) return _configProxy;
      _srcConfig = sc;
      _configProxy = new Proxy(sc, {
        get(t, prop) {
          if (prop === "maxTroops") return (p) => sc.maxTroops(unwrap(p));
          // Preserve the bot's positional API across OpenFront's AttackLogicInput migration.
          if (prop === "attackLogic" && t.attackLogic?.length === 1) {
            return (game, attackTroops, attacker, target, tile) => {
              const defender = target.isPlayer() ? target : null;
              return t.attackLogic({
                terrain: game.terrainType(tile),
                attackTroops,
                attacker: { type: attacker.type(), numTiles: attacker.numTilesOwned() },
                defender: defender === null ? null : {
                  type: defender.type(),
                  numTiles: defender.numTilesOwned(),
                  troops: defender.troops(),
                  isTraitor: defender.isTraitor(),
                  isDisconnectedTeammate: defender.isDisconnected() && attacker.isOnSameTeam(defender),
                },
                defenderHasDefensePost: attackTileHasDefensePost(game, defender, tile),
                falloutRatio: game.hasFallout(tile)
                  ? game.numTilesWithFallout() / game.numLandTiles() : null,
                // These legacy callers estimate troop losses, not conquest timing.
                borderSize: 1,
              });
            };
          }
          if (prop === "spawnImmunityDuration") {
            return () => sc.spawnImmunityDuration?.() ?? 0;
          }
          // OpenFront renamed the legacy defaultNukeSpeed accessor to the
          // per-warhead nukeSpeed(unitType) API. Keep the port contract stable
          // for the trajectory, SAM, and missile planners while always asking
          // the current engine for the Atom-bomb speed.
          if (
            prop === "defaultNukeSpeed" &&
            typeof t.defaultNukeSpeed !== "function" &&
            typeof t.nukeSpeed === "function"
          ) {
            return () => t.nukeSpeed(UNIT.AtomBomb);
          }
          const v = t[prop];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      return _configProxy;
    }

    // ── §SHIM-DATA: water-component labeling + rail state (structure siting) ──
    // These reconstruct the two datasets the client GameView does NOT surface
    // (core's getWaterComponent / sharedWaterComponents / railNetwork). They feed
    // STRUCTURE PLACEMENT scoring only. The water labeling is built ONCE per game
    // (terrain is static) and cached on THIS gameApi closure (per-game, not a
    // module-global — the harness runs many games per process and two maps with
    // identical dimensions must not share a cache).
    //
    // WATER — EXACT-as-client-allows union-find.
    //   Core (WaterManager.getWaterComponent) labels water components on a
    //   DOWNSAMPLED MINIMAP graph (x/y ÷ 2), which the client does not expose.
    //   We instead flood-fill ALL water tiles at FULL resolution using only
    //   isWater/neighbors/ref/width/height — the closest client-side
    //   reconstruction. It differs from core ONLY at sub-minimap granularity:
    //   narrow channels that the minimap merges (or splits) may land in a
    //   different component here. This is strictly better than the old bounded
    //   400-tile BFS, which could not see large lakes or assign stable ids.
    //
    //   _waterLabels[tile] : component id + 1 for every labeled water tile, 0 for
    //   land/unlabeled. Component ids are dense (0..N-1). OCEAN_SENTINEL (-1) is
    //   reserved for the "touches ocean" marker in shared sets and NEVER used as
    //   a real component id, so shared.has(comp) is collision-free.
    //   _waterCompIsOcean[id] : true if the component contains any ocean tile.
    //   _waterCompCoast[id]   : array of land TileRefs adjacent to that (non-ocean)
    //                           component (the component's coastline). Ocean
    //                           coasts are not recorded — ocean is always shared,
    //                           so its coast is never scanned for trade partners.
    let _waterLabels = null;
    let _waterCompIsOcean = null;
    let _waterCompCoast = null;
    let _waterLabelBuilder = null;
    // This reconstruction can cover a full world map. Advance it only in
    // bounded slices from beginTick so an inland lake never turns an Auto-build
    // decision into a long synchronous frame stall.
    const WATER_LABEL_SLICE_STEPS = 2048;

    function forEachSourceNeighbor(tile, visit) {
      if (typeof src.forEachNeighbor === "function") {
        src.forEachNeighbor(tile, visit);
        return;
      }
      for (const neighbor of src.neighbors(tile)) visit(neighbor);
    }

    function ensureWaterLabelQueueCapacity(builder, requiredLength) {
      if (requiredLength <= builder.queue.length) return;
      let nextLength = Math.max(1, builder.queue.length);
      while (nextLength < requiredLength) {
        nextLength = Math.min(builder.labels.length, nextLength * 2);
      }
      const expanded = new Int32Array(nextLength);
      expanded.set(builder.queue.subarray(0, builder.queueTail));
      builder.queue = expanded;
    }

    function enqueueWaterLabelTile(builder, tile) {
      ensureWaterLabelQueueCapacity(builder, builder.queueTail + 1);
      builder.queue[builder.queueTail++] = tile;
    }

    function visitWaterComponentNeighbor(neighbor, id, builder, coast) {
      const labels = builder.labels;
      if (src.isWater(neighbor)) {
        if (labels[neighbor] !== 0) return;
        labels[neighbor] = id + 1;
        enqueueWaterLabelTile(builder, neighbor);
        return;
      }
      if (coast !== null && src.isLand(neighbor)) coast.add(neighbor);
    }

    function createWaterLabelBuffer(total, maximumEncodedId = 0xff) {
      if (maximumEncodedId <= 0xff) return new Uint8Array(total);
      if (maximumEncodedId <= 0xffff) return new Uint16Array(total);
      return new Uint32Array(total);
    }

    function ensureWaterLabelCapacity(builder, encodedId) {
      const maximumStored = (2 ** (builder.labels.BYTES_PER_ELEMENT * 8)) - 1;
      if (encodedId <= maximumStored) return;
      const expanded = createWaterLabelBuffer(builder.labels.length, encodedId);
      expanded.set(builder.labels);
      builder.labels = expanded;
    }

    function startWaterLabelBuilder() {
      if (_waterLabelBuilder !== null || _waterLabels !== null) return;
      const w = src.width();
      const h = src.height();
      const total = w * h;
      _waterLabelBuilder = {
        // Typed arrays are zero-initialized by the runtime. Encoding component
        // ids as id+1 removes the synchronous full-map fill that previously
        // preceded the cooperative slices and could stall Auto-build.
        labels: createWaterLabelBuffer(total),
        compIsOcean: [],
        compCoast: [],
        nextId: 0,
        scanTile: 0,
        queue: new Int32Array(Math.min(total, 1024)),
        queueHead: 0,
        queueTail: 0,
        componentId: null,
        componentOcean: false,
        componentCoast: null,
      };
    }

    function finishWaterLabelComponent(builder) {
      const id = builder.componentId;
      builder.compIsOcean[id] = builder.componentOcean;
      // Only non-ocean components need their coast recorded (ocean is always
      // treated as shared → its coast is never scanned).
      builder.compCoast[id] = builder.componentOcean
        ? null
        : Array.from(builder.componentCoast);
      builder.queueHead = 0;
      builder.queueTail = 0;
      builder.componentId = null;
      builder.componentCoast = null;
    }

    function publishWaterLabels(builder) {
      _waterLabels = builder.labels;
      _waterCompIsOcean = builder.compIsOcean;
      _waterCompCoast = builder.compCoast;
      _waterLabelBuilder = null;
    }

    function advanceWaterLabelBuilder(maxSteps = WATER_LABEL_SLICE_STEPS) {
      startWaterLabelBuilder();
      const builder = _waterLabelBuilder;
      if (builder === null) return _waterLabels !== null;
      let steps = 0;
      while (steps < maxSteps) {
        if (builder.componentId !== null) {
          if (builder.queueHead >= builder.queueTail) {
            finishWaterLabelComponent(builder);
            continue;
          }
          const current = builder.queue[builder.queueHead++];
          if (!builder.componentOcean && src.isOcean(current)) {
            builder.componentOcean = true;
            builder.componentCoast = null;
          }
          forEachSourceNeighbor(current, (neighbor) =>
            visitWaterComponentNeighbor(
              neighbor,
              builder.componentId,
              builder,
              builder.componentCoast,
            ),
          );
          steps++;
          continue;
        }
        if (builder.scanTile >= builder.labels.length) {
          publishWaterLabels(builder);
          return true;
        }
        const tile = builder.scanTile++;
        steps++;
        if (!src.isWater(tile) || builder.labels[tile] !== 0) continue;
        builder.componentId = builder.nextId++;
        ensureWaterLabelCapacity(builder, builder.componentId + 1);
        builder.componentOcean = false;
        builder.componentCoast = new Set();
        builder.labels[tile] = builder.componentId + 1;
        enqueueWaterLabelTile(builder, tile);
      }
      return false;
    }

    // getWaterComponent(tile) — mirrors core's signature. Returns the component
    // id of a water tile (>= 0), or null for non-water. (In practice only ever
    // called on NON-ocean water — randCoastalTileArray / SharedWaterCache
    // short-circuit on ocean before the lookup.)
    function getWaterComponent(tile) {
      if (_waterLabels === null) {
        startWaterLabelBuilder();
        return null;
      }
      if (tile < 0 || tile >= _waterLabels.length) return null;
      const encoded = _waterLabels[tile];
      return encoded > 0 ? encoded - 1 : null;
    }

    // OCEAN sentinel — core SharedWaterCache.OCEAN_SENTINEL.
    const SHARED_OCEAN_SENTINEL = -1;

    // sharedWaterComponents(player) — faithful reconstruction of core's
    // SharedWaterCache predicate (SharedWaterCache.ts):
    //   - Skip bots as candidate trade partners (core skips bots in Pass 1).
    //   - For the QUERIED player, scan its OWN shore border tiles (available
    //     synchronously — me's border is pre-fetched each tick): ocean neighbor →
    //     mark hasOcean; non-ocean water neighbor → add its component id to
    //     "mine".
    //   - A lake component is SHARED iff some OTHER living, non-bot ally or
    //     teammate on that component's coast can trade with the queried player
    //     (no mutual embargo, different id). This is a CUSTOM placement safety
    //     rule: the core cache treats any non-embargoed player as sufficient,
    //     but isolated inland lakes must not attract ports in the userscript.
    //     We resolve "other player on the component" via the
    //     pre-recorded coast tiles + ownerID (both SYNC) — we do NOT iterate other
    //     players' borderTiles() (those return EMPTY synchronously through the
    //     wrapper; only me's is pre-fetched).
    //   - Ocean is always shared (sentinel -1).
    // Returns Set<number>|null (null = touches no ocean and no shared lake),
    // exactly matching core's `!== null` coastal test.
    function isTrustedWaterPartner(player, other) {
      {
        if (!isEligibleWaterPlayer(player) || !isEligibleWaterPlayer(other)) return false;
        if (player.id() === other.id()) return false;
        if (player.hasEmbargoAgainst(other) || other.hasEmbargoAgainst(player)) return false;
        return areAlliedWaterPlayers(player, other) || areTeamWaterPlayers(player, other);
      }
    }

    function isEligibleWaterPlayer(player) {
      if (!player?.isPlayer?.()) return false;
      if (player.type?.() === PlayerType.Bot) return false;
      return typeof player.isAlive !== "function" || player.isAlive();
    }

    function areAlliedWaterPlayers(player, other) {
      return Boolean(player.isAlliedWith?.(other) || other.isAlliedWith?.(player));
    }

    function areTeamWaterPlayers(player, other) {
      return Boolean(player.isOnSameTeam?.(other) || other.isOnSameTeam?.(player));
    }

    function ownedWaterComponents(player) {
      let hasOcean = false;
      const lakes = new Set();
      for (const tile of player.borderTiles()) {
        if (!src.isShore(tile)) continue;
        forEachSourceNeighbor(tile, (neighbor) => {
          if (!src.isWater(neighbor)) return;
          if (src.isOcean(neighbor)) {
            hasOcean = true;
            return;
          }
          const encoded = _waterLabels[neighbor];
          if (encoded > 0) lakes.add(encoded - 1);
        });
      }
      return { hasOcean, lakes };
    }

    function ownedWaterAccessSummary(player) {
      let hasOcean = false;
      let hasInlandWater = false;
      for (const tile of player.borderTiles()) {
        if (!src.isShore(tile)) continue;
        forEachSourceNeighbor(tile, (neighbor) => {
          if (!src.isWater(neighbor)) return;
          if (src.isOcean(neighbor)) hasOcean = true;
          else hasInlandWater = true;
        });
        if (hasOcean) return { hasOcean, hasInlandWater };
      }
      return { hasOcean, hasInlandWater };
    }

    function lakeHasTrustedPartner(component, player, mySid) {
      const coast = _waterCompCoast[component];
      if (!coast) return false;
      const seen = new Set();
      for (const landTile of coast) {
        if (!src.hasOwner(landTile)) continue;
        const ownerSid = src.ownerID(landTile);
        if (ownerSid == null || ownerSid === mySid || seen.has(ownerSid)) continue;
        seen.add(ownerSid);
        const other = wrapPlayer(src.playerBySmallID(ownerSid));
        if (isTrustedWaterPartner(player, other)) return true;
      }
      return false;
    }

    function sharedWaterComponents(player) {
      if (player == null) return null;
      {
        if (player.type && player.type() === PlayerType.Bot) return null;
      }
      const access = ownedWaterAccessSummary(player);
      if (access.hasOcean) return new Set([SHARED_OCEAN_SENTINEL]);
      if (_waterLabels === null) {
        startWaterLabelBuilder();
        return null;
      }
      const mySid = player.smallID();
      const { hasOcean, lakes } = ownedWaterComponents(player);
      const shared = new Set();
      if (hasOcean) shared.add(SHARED_OCEAN_SENTINEL);
      for (const component of lakes) {
        if (lakeHasTrustedPartner(component, player, mySid)) shared.add(component);
      }

      return shared.size > 0 ? shared : null;
    }

    // Structure policy only needs the SharedWaterCache result as a boolean.
    // Ocean access is locally provable from the player's cached border, so do
    // not synchronously flood-fill the whole map unless an inland component
    // actually needs the trusted-partner test.
    function hasSharedWater(player) {
      if (player == null) return false;
      if (player.type?.() === PlayerType.Bot) return false;
      const access = ownedWaterAccessSummary(player);
      if (access.hasOcean) return true;
      if (!access.hasInlandWater) return false;
      if (_waterLabels === null) {
        startWaterLabelBuilder();
        return false;
      }
      return sharedWaterComponents(player) !== null;
    }

    // RAIL — railroadState buffer (EXTENSION only). Core RailroadCache keeps a
    // Uint8Array(width*height) indexed by TileRef: 0 = no rail, 1..6 = RailType+1
    // (rail present). GameView.frameData().railroadState is that buffer. The
    // harness coreAdapter has no frameData → returns null, and structureBehavior
    // falls back to the station-proximity union-find.
    function railroadState() {
      {
        if (typeof src.frameData !== "function") return null;
        const fd = src.frameData();
        return fd && fd.railroadState ? fd.railroadState : null;
      }
    }

    // ── the core-shaped game object handed to the behaviors ───────────────────
    const mapM = (name) => (...a) => src[name](...a);
    const api = {
      __src: src,
      ticks: () => src.ticks(),
      inSpawnPhase: () => src.inSpawnPhase(),
      isSpawnImmunityActive: (...a) =>
        typeof src.isSpawnImmunityActive === "function"
          ? src.isSpawnImmunityActive(...a)
          : false,
      spawnImmunityDuration: () =>
        typeof src.config === "function" &&
        typeof src.config()?.spawnImmunityDuration === "function"
          ? src.config().spawnImmunityDuration()
          : 0,
      config: () => configProxy(),
      motionPlans: () =>
        typeof src.motionPlans === "function" ? src.motionPlans() : null,
      myPlayer: () => mePlayer,
      players: () => cachedPlayers(),
      playerViews: () => cachedPlayers(),
      playerBySmallID: (sid) => wrapPlayer(src.playerBySmallID(sid)),
      nations: () =>
        (src.nations ? src.nations() : src.players().filter((p) => p.type?.() === "Nation")).map(
          wrapPlayer,
        ),
      terraNullius: () => {
        if (typeof src.terraNullius === "function") return src.terraNullius();
        // synthesize a TN sentinel matching the core contract.
        return { isPlayer: () => false, smallID: () => 0, id: () => "TerraNullius" };
      },
      owner: (t) => wrapPlayer(src.owner(t)),
      ownerID: (t) => src.ownerID(t),
      hasOwner: (t) => src.hasOwner(t),
      numLandTiles: () => src.numLandTiles(),
      numTilesWithFallout: () =>
        typeof src.numTilesWithFallout === "function" ? src.numTilesWithFallout() : 0,
      getWinner: () => (typeof src.getWinner === "function" ? src.getWinner() : null),
      units: (...types) => cachedUnits(src, "game", types),
      unitCount: (type) => cachedUnits(src, "game", [type]).length,
      // GameMap surface (sync passthrough)
      ref: mapM("ref"),
      x: mapM("x"),
      y: mapM("y"),
      cell: mapM("cell"),
      width: mapM("width"),
      height: mapM("height"),
      isValidCoord: mapM("isValidCoord"),
      isOnMap: (cell) =>
        typeof src.isOnMap === "function"
          ? src.isOnMap(cell)
          : src.isValidCoord(cell.x, cell.y),
      isLand: mapM("isLand"),
      isWater: mapM("isWater"),
      isImpassable: (tile) =>
        typeof src.isImpassable === "function" ? src.isImpassable(tile) : false,
      isOcean: mapM("isOcean"),
      isShore: mapM("isShore"),
      isOceanShore: mapM("isOceanShore"),
      isBorder: (t) => (typeof src.isBorder === "function" ? src.isBorder(t) : false),
      magnitude: mapM("magnitude"),
      hasFallout: mapM("hasFallout"),
      neighbors: mapM("neighbors"),
      forEachNeighbor: (tile, callback) => {
        if (typeof src.forEachNeighbor === "function") {
          src.forEachNeighbor(tile, callback);
          return;
        }
        for (const neighbor of src.neighbors(tile)) callback(neighbor);
      },
      manhattanDist: mapM("manhattanDist"),
      euclideanDistSquared: mapM("euclideanDistSquared"),
      terrainType: (t) =>
        typeof src.terrainType === "function" ? src.terrainType(t) : null,
      nearbyUnits: (...a) =>
        typeof src.nearbyUnits === "function" ? src.nearbyUnits(...a) : [],
      hasUnitNearby: (...a) =>
        typeof src.hasUnitNearby === "function" ? src.hasUnitNearby(...a) : false,

      // Prefetch a target player's border tiles into the per-tick cache, so the
      // SYNC `target.borderTiles()` (and portutil.calculateTerritoryCenter /
      // randTerritoryTileArray) work for that target. `await` before use.
      ensureBorderTiles: (p) => ensureBorderTiles(p),
      hasTransportRouteEstimator,
      estimateTransportRouteTicks,

      // ── §SHIM-DATA accessors (structure placement) ────────────────────────
      // Water-component reconstruction (full-resolution union-find, cached once
      // per game). getWaterComponent mirrors core; sharedWaterComponents mirrors
      // core SharedWaterCache. railroadState exposes the real rail-tile buffer in
      // the extension (null under the harness → proximity fallback).
      getWaterComponent: (tile) => getWaterComponent(tile),
      hasSharedWater: (p) => hasSharedWater(p),
      sharedWaterComponents: (p) => sharedWaterComponents(p),
      railroadState: () => railroadState(),

      // expose internals the behaviors/engine need
      _wrapPlayer: wrapPlayer,
      _wrapUnit: wrapUnit,
    };

    // ── per-tick snapshot ─────────────────────────────────────────────────────
    function monotonicNow() {
      return typeof performance !== "undefined" && performance.now
        ? performance.now() : Date.now();
    }

    function reusableBorderSet(cached, now) {
      if (!cached?.set?.size || now - (cached.at || 0) >= 1500) return null;
      return cached.set;
    }

    async function fetchBorderSet(core) {
      {
        const response = await withTimeout(core.borderTiles(), 4000, null);
        const tiles = response?.borderTiles ?? response;
        if (!tiles) return null;
        const result = new Set(tiles);
        return result.size > 0 ? result : null;
      }
    }

    async function ensureBorderTiles(player) {
      const core = unwrap(player);
      const sid = core.smallID();
      const cached = borderCache.get(sid);
      const now = monotonicNow();
      // TIME-BASED reuse (not per-tick): serve a border up to ~1.5s old instead of
      // re-hitting the worker every tick. CRITICAL at MAX game speed, where the
      // worker/client is saturated by GameUpdates and a per-tick borderTiles
      // request times out → empty → BLIND bot. (Mirrors the old 2.2s border cache.)
      const reusable = reusableBorderSet(cached, now);
      if (reusable) return reusable;
      // Don't pile up concurrent requests for the same player (worsens saturation)
      // — if a fetch is already in flight, serve the last-good set immediately.
      if (cached?.inFlight) return cached.set || new Set();
      const entry = cached || { at: 0, set: new Set(), inFlight: false };
      entry.inFlight = true;
      borderCache.set(sid, entry);
      const fetched = await fetchBorderSet(core);
      entry.inFlight = false;
      if (fetched !== null) {
        entry.set = fetched;
        entry.at = monotonicNow();
      }
      // else: keep entry.set (last good) — never blank the bot.
      borderCache.set(sid, entry);
      return entry.set || new Set();
    }

    function decayRelationOverlay(tick) {
      if (lastSnapshotTick < 0 || tick <= lastSnapshotTick) return;
      const steps = Math.min(tick - lastSnapshotTick, 50);
      for (const [key, value] of overlay) {
        let relation = value;
        for (let index = 0; index < steps; index++) {
          relation += -Math.sign(relation) * 0.05;
          if (Math.abs(relation) >= 0.1) continue;
          relation = 0;
          break;
        }
        if (relation === 0) overlay.delete(key);
        else overlay.set(key, relation);
      }
    }

    async function refreshProfile(now) {
      if (profileLoaded && now - profileFetchedAt < PROFILE_REFRESH_MS) return;
      if (!profileInFlight) profileInFlight = loadProfile();
      await profileInFlight;
    }

    async function loadProfile() {
      try {
        const profile = await withTimeout(unwrap(mePlayer).profile(), WORKER_TIMEOUT_MS, null);
        if (profile?.relations) {
          profileRelations = new Map(
            Object.entries(profile.relations).map(([key, value]) => [Number(key), Number(value)]),
          );
        }
      } finally {
        profileLoaded = true;
        profileFetchedAt = monotonicNow();
        profileInFlight = null;
      }
    }

    // Called ONCE at the top of each decision tick, before any behavior runs.
    async function beginTick(meCorePlayer) {
      const tick = src.ticks();
      if (tick !== lastSnapshotTick) {
        // PlayerView instances are snapshots and the client replaces them as the
        // game advances. Retaining a wrapper by smallID across ticks would retain
        // the old view too, which can turn a newly-grown tribe into an underfunded
        // capture even though the troop calculation itself uses a 4x floor.
        playerCache.clear();
        playerSnapshot = null;
        playerSnapshotTick = -1;
        transportSpawnCache.clear();
        transportRouteCache.clear();
      }
      mePlayer = wrapPlayer(meCorePlayer);

      // decay overlay 0.05/tick toward 0 (PlayerImpl.decayRelations) — once per
      // game tick crossed.
      decayRelationOverlay(tick);
      lastSnapshotTick = tick;

      // snapshot me.borderTiles + profile (relation buckets).
      await ensureBorderTiles(mePlayer);
      await refreshProfile(monotonicNow());
      // Open ocean is already answered directly from the cached border. Only
      // an inland shore needs the component reconstruction, and its bounded
      // slice belongs here rather than in a structure decision.
      if (
        typeof src.isShore === "function" &&
        typeof src.isWater === "function" &&
        typeof src.isOcean === "function"
      ) {
        const waterAccess = ownedWaterAccessSummary(mePlayer);
        if (!waterAccess.hasOcean && waterAccess.hasInlandWater) {
          advanceWaterLabelBuilder();
        }
      }
      return mePlayer;
    }

    return {
      game: api,
      beginTick,
      ensureBorderTiles,
      wrapPlayer,
      overlay,
      // SHIMS (§5) for sharedWaterComponents / railNetwork are attached in
      // structureBehavior's phase (Phase 2) to keep this file focused; they read
      // only api primitives (isOcean/isShore/neighbors + unit tiles).
    };
  }
