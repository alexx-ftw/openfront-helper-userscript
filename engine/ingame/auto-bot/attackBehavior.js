// Auto-Bot — AttackBehavior: a faithful 1:1 port of the in-game Nation attack AI
// (src/core/execution/utils/AiAttackBehavior.ts). This is the HEART of the AI:
// it expands into TerraNullius, launches random boats, and runs the
// DIFFICULTY-ORDERED strategy pipeline (the four arrays in getAttackStrategies)
// to pick a target every attack tick. Every branch, constant, probability,
// strategy ORDER and call order is preserved EXACTLY. The ONLY changes are the
// mechanical API substitutions mandated by PORT-CONTRACT.md:
//
//   - DIFFICULTY: src reads `this.game.config().gameConfig().difficulty`; the bot
//     REPLICATES a user-chosen difficulty, so every such read → `currentDifficulty()`.
//     EXCEPTION: `config().maxTroops(player|enemy)` keeps the real lobby difficulty
//     (it reads true stats) — left as-is, exactly like the sibling behaviors.
//   - UnitType.X → UNIT.X.
//   - PLAYER/OWNER IDENTITY: src compares players with `===`; the client wraps
//     players fresh each tick, so `a === b` → `a.smallID() === b.smallID()`, and
//     `owner === player` → smallID compare; TerraNullius via `!x.isPlayer()`. Where
//     src already used `.id()` (string id), that compare is kept verbatim.
//   - relation: `player.relation(o)` / `player.allRelationsSorted()` (reconstructed
//     sync overlay) and `player.updateRelation(o, delta)` (overlay write, no intent)
//     are used exactly where src does.
//   - ACTUATION: the client has no synchronous `game.addExecution`. Replace:
//       * land attack  `new AttackExecution(troops, attacker, targetID)`
//           → `emitIntent(ctors.attack, target.id()|null, troops)`
//         (targetID = `target.id()` for a player, `null` for TerraNullius).
//       * boat        `new TransportShipExecution(player, dstTile, troops)`
//           → `emitIntent(ctors.boat, dstTile, troops)`.
//       * donate      `new DonateTroopsExecution(player, recipient.id(), troops)`
//           → `emitIntent(ctors.donateTroops, recipient.__src ?? recipient, troops)`.
//   - ASYNC BOUNDARIES (the ONLY control-flow change): the src calls
//     `canBuildTransportShip(g, player, tile)` SYNCHRONOUSLY inside RNG/scan loops.
//     On the client this is the ASYNC `await player.bestTransportShipSpawn(tile)`
//     (→ spawn TileRef, or `false` == cannot boat). We apply the PORT-CONTRACT
//     RANK/COLLECT-THEN-PROBE pattern: run the cheap SYNC src criteria to COLLECT up
//     to K (≈4) candidate target tiles IN THE SRC SELECTION ORDER, then `await
//     bestTransportShipSpawn(candidate)` DOWN the list and take the FIRST that
//     returns `!== false`. Each await is wrapped in withTimeout(p, …, false). The
//     boat probe is a GATE only — the dst passed to the boat intent is still the
//     src target tile (closest.y / randTile / tile), never the spawn source.
//     Methods that touch these probes BECOME `async` (nationExecution awaits
//     maybeAttack and forceSendAttack). See the per-method DIVERGENCE notes.
//
// Loaded with the other behavior modules (after portutil/gameApi and the emoji
// phase, which provides EMOJI_ASSIST_* + sendEmoji), before nationExecution.

"use strict";

  // ── Structures group — src/core/game/Game.ts:374 (Structures = unitTypeGroup([
  //    City, DefensePost, SAMLauncher, MissileSilo, Port, Factory])). The src uses
  //    `Structures.has(type)` (== Array.includes); we back it with a Set of the
  //    UNIT string values and call `.has()`. NOT defined elsewhere in the bundle.
  const AttackStructures = new Set([
    UNIT.City,
    UNIT.DefensePost,
    UNIT.SAMLauncher,
    UNIT.MissileSilo,
    UNIT.Port,
    UNIT.Factory,
  ]);

  // HumansVsNations — src/core/game/Game.ts:81 (`"Humans Vs Nations"`).
  const HumansVsNations = "Humans Vs Nations";

  // Bound on how many target tiles we COLLECT before awaiting the async boat
  // spawn probe (PORT-CONTRACT §Async #2). The src loops are unbounded
  // (findRandomBoatTarget 500 iters, etc.); we cap the worker calls.
  const BOAT_PROBE_CANDIDATES = 4;

  // Early-game tribe scoring may need one border snapshot per candidate. Keep the
  // async enrichment bounded so a crowded tribe map cannot starve the combat tick.
  const EARLY_TRIBE_CANDIDATES = 8;
  const EARLY_TRIBE_BORDER_FETCH_CONCURRENCY = 4;
  const EARLY_TRIBE_BOAT_ETA_TARGETS = 4;
  const EARLY_GAME_TRIBE_CHAIN_RADIUS = 120;
  // A planned opening attack must leave a live force even when a stale plan or
  // a pending execution still reports the pre-attack troop total.
  const EARLY_GAME_MIN_LIVE_RESERVE_RATIO = 0.12;
  // A Bot/tribe with more than 99 tiles needs one capture simulation per tile
  // until the engine's conquerPlayer threshold is reached. Keep the expensive
  // exact search bounded; larger targets are deferred instead of guessed.
  const MAX_BOT_CAPTURE_SIMULATION_TILES = 512;
  // OpenFront's Config.attackLogic applies these effects when an operational
  // enemy Defense Post is within defensePostRange() of the tile being taken.
  // Keep fallbacks here because older client views may not expose the newer
  // config accessors, while still using the live values whenever available.
  const ENEMY_DEFENSE_POST_RANGE = 30;
  const ENEMY_DEFENSE_POST_DEFENSE_BONUS = 5;
  const ENEMY_DEFENSE_POST_SPEED_BONUS = 3;
  const ENEMY_DEFENSE_POST_MAX_SCAN_POSTS = 256;
  const ENEMY_DEFENSE_POST_MAX_FRONT_TILES = 512;
  // Terrain is shared by all Nation behaviors for the same game. Keep the
  // reverse maritime field per map instead of rebuilding it for every bot.
  const EARLY_GAME_MARITIME_INDEX_CACHE = new WeakMap();

  function getAutoDonateExpansionTickLimit() {
    return typeof AUTO_DONATE_EXPANSION_MAX_TICKS === "number"
      ? AUTO_DONATE_EXPANSION_MAX_TICKS
      : 30;
  }

  function emptyDefensePostAttackProfile() {
    return {
      hasCoverage: false,
      frontTileCount: 0,
      coveredFrontTileCount: 0,
      coverageRatio: 0,
      operationalPostCount: 0,
      defenseMultiplier: 1,
      speedMultiplier: 1,
      attackCostMultiplier: 1,
    };
  }

  // Mirrors Config.attackLogic's binary coverage rule: several overlapping
  // posts still apply the bonus once, not once per post. This pure helper is
  // intentionally independent of the game/player wrappers so it is cheap to
  // regression-test and cannot accidentally grow a map-wide scan.
  function calculateDefensePostAttackProfile({
    frontTiles = [],
    defensePosts = [],
    distanceSquared,
    defensePostRange = ENEMY_DEFENSE_POST_RANGE,
    defensePostDefenseBonus = ENEMY_DEFENSE_POST_DEFENSE_BONUS,
    defensePostSpeedBonus = ENEMY_DEFENSE_POST_SPEED_BONUS,
  } = {}) {
    const tiles = Array.from(new Set(frontTiles || [])).slice(
      0,
      ENEMY_DEFENSE_POST_MAX_FRONT_TILES,
    );
    const posts = Array.from(defensePosts || []).slice(
      0,
      ENEMY_DEFENSE_POST_MAX_SCAN_POSTS,
    );
    const operationalPostCount = posts.length;
    if (tiles.length === 0 || posts.length === 0) {
      return {
        ...emptyDefensePostAttackProfile(),
        operationalPostCount,
      };
    }

    const range = Number(defensePostRange);
    const defenseBonus = Number(defensePostDefenseBonus);
    const speedBonus = Number(defensePostSpeedBonus);
    const rangeSquared =
      Number.isFinite(range) && range > 0 ? range * range : 0;
    const safeDefenseBonus =
      Number.isFinite(defenseBonus) && defenseBonus >= 1
        ? defenseBonus
        : ENEMY_DEFENSE_POST_DEFENSE_BONUS;
    const safeSpeedBonus =
      Number.isFinite(speedBonus) && speedBonus >= 1
        ? speedBonus
        : ENEMY_DEFENSE_POST_SPEED_BONUS;

    let coveredFrontTileCount = 0;
    for (const frontTile of tiles) {
      for (const post of posts) {
        if (post.tile == null || typeof distanceSquared !== "function") {
          continue;
        }
        let distance;
        try {
          distance = Number(distanceSquared(post.tile, frontTile));
        } catch (_error) {
          distance = NaN;
        }
        if (Number.isFinite(distance) && distance <= rangeSquared) {
          coveredFrontTileCount++;
          break;
        }
      }
    }

    const coverageRatio = coveredFrontTileCount / tiles.length;
    const defenseMultiplier =
      1 + coverageRatio * Math.max(0, safeDefenseBonus - 1);
    const speedMultiplier =
      1 + coverageRatio * Math.max(0, safeSpeedBonus - 1);
    return {
      hasCoverage: coveredFrontTileCount > 0,
      frontTileCount: tiles.length,
      coveredFrontTileCount,
      coverageRatio,
      operationalPostCount,
      defenseMultiplier,
      speedMultiplier,
      // The troop requirement follows the actual attackLogic magnitude
      // multiplier. speedMultiplier is retained separately because it affects
      // how long the attack remains exposed, not the direct troop loss.
      attackCostMultiplier: defenseMultiplier,
    };
  }

  function earlyGameMaritimeCacheKey(game) {
    const source = game && game.__src;
    return source && (typeof source === "object" || typeof source === "function")
      ? source
      : game;
  }

  function playersShareClanTag(left, right) {
    try {
      const objectiveApi =
        typeof globalThis === "object" ? globalThis.__OFHSpawnObjective : null;
      if (
        !objectiveApi ||
        typeof objectiveApi.getPlayerClanTag !== "function" ||
        typeof objectiveApi.sameClanTag !== "function"
      ) {
        return false;
      }
      return objectiveApi.sameClanTag(
        objectiveApi.getPlayerClanTag(left),
        objectiveApi.getPlayerClanTag(right),
      );
    } catch (_error) {
      return false;
    }
  }

  function rankTeamDonationCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => {
        const leftClan = left.candidate.sameClan === true ? 1 : 0;
        const rightClan = right.candidate.sameClan === true ? 1 : 0;
        if (leftClan !== rightClan) return rightClan - leftClan;

        const leftFrontline = left.candidate.frontline === true ? 1 : 0;
        const rightFrontline = right.candidate.frontline === true ? 1 : 0;
        if (leftFrontline !== rightFrontline) {
          return rightFrontline - leftFrontline;
        }

        const leftPercentage = Number(left.candidate.troopPercentage);
        const rightPercentage = Number(right.candidate.troopPercentage);
        if (leftPercentage !== rightPercentage) {
          return leftPercentage - rightPercentage;
        }
        return left.index - right.index;
      })
      .map(({ candidate }) => candidate);
  }

  class AttackBehavior {
    constructor(
      random,
      game,
      player,
      triggerRatio,
      reserveRatio,
      expandRatio,
      allianceBehavior,
      emojiBehavior,
    ) {
      this.random = random;
      this.game = game;
      this.player = player;
      this.triggerRatio = triggerRatio;
      this.reserveRatio = reserveRatio;
      this.expandRatio = expandRatio;
      this.allianceBehavior = allianceBehavior;
      this.emojiBehavior = emojiBehavior;

      this.botAttackTroopsSent = 0;
      this.botAttackTroopsSentTick = -1;
      this.botAttackTroopsSentByTarget = new Map();
      this.botAttackActiveBaselineByTarget = new Map();
      // Small per-player memory used by the early-game food-race policy. It is
      // intentionally local to this persistent behavior instance and bounded to
      // the players visible in the current game snapshot.
      this.earlyFoodMovement = new Map();
      // The shared WeakMap below owns the terrain index; this local reference
      // avoids even the lookup after the first candidate pass.
      this.earlyGameMaritimeIndex = undefined;
      this.earlyGameMaritimeWaterCache = new Map();
      // Defense-post reads are bounded and reused across all target decisions
      // made in the same game tick. This keeps the extra combat intelligence out
      // of the high-frequency engine poll loop.
      this.enemyDefensePostCacheTick = -1;
      this.enemyDefensePostUnitsCache = new Map();
      this.enemyDefensePostProfileCache = new Map();
      this.enemyDefensePostFrontByTarget = new Map();
      this.enemyDefensePostFrontSeenByTarget = new Map();
      this.botCaptureTroopsCacheTick = -1;
      this.botCaptureTroopsCache = new Map();
      this.earlyGameFrontierCacheTick = -1;
      this.earlyGameFrontierCache = null;
    }

    enemyDefensePostPolicyEnabled() {
      return state.settings?.winFixes === true;
    }

    currentAttackDecisionTick() {
      try {
        const tick = Number(this.game?.ticks?.());
        return Number.isFinite(tick) ? tick : 0;
      } catch (_error) {
        return 0;
      }
    }

    ensureBotAttackAccounting() {
      const tick = this.currentAttackDecisionTick();
      if (this.botAttackTroopsSentTick !== tick) {
        this.botAttackTroopsSentTick = tick;
        this.botAttackTroopsSent = 0;
        this.botAttackTroopsSentByTarget.clear();
        this.botAttackActiveBaselineByTarget.clear();
      }
      return tick;
    }

    getBotAttackTargetKey(target) {
      try {
        const smallID = target?.smallID?.();
        if (smallID != null) return `smallID:${smallID}`;
        const id = target?.id?.();
        if (id != null) return `id:${id}`;
      } catch (_error) {
        /* use the object identity as the final fallback */
      }
      return target;
    }

    getBotAttackTroopsSentForTarget(target) {
      return Math.max(
        0,
        Number(this.botAttackTroopsSentByTarget.get(this.getBotAttackTargetKey(target)) || 0),
      );
    }

    recordBotAttackTroopsSent(target, troops) {
      if (!target?.isPlayer?.() || target.type?.() !== PlayerType.Bot) return;
      const amount = Math.max(0, Number(troops) || 0);
      if (amount <= 0) return;
      const key = this.getBotAttackTargetKey(target);
      this.botAttackTroopsSent += amount;
      this.botAttackTroopsSentByTarget.set(
        key,
        this.getBotAttackTroopsSentForTarget(target) + amount,
      );
    }

    resetEnemyDefensePostCaches() {
      const tick = this.currentAttackDecisionTick();
      if (this.enemyDefensePostCacheTick === tick) return tick;
      this.enemyDefensePostCacheTick = tick;
      this.enemyDefensePostUnitsCache.clear();
      this.enemyDefensePostProfileCache.clear();
      this.enemyDefensePostFrontByTarget.clear();
      this.enemyDefensePostFrontSeenByTarget.clear();
      return tick;
    }

    cacheEnemyDefensePostFrontTiles(border) {
      this.resetEnemyDefensePostCaches();
      const meSid = this.player?.smallID?.();
      for (const tile of border || []) {
        const ownerID = this.game.ownerID(tile);
        if (ownerID == null || ownerID === meSid) continue;
        let tiles = this.enemyDefensePostFrontByTarget.get(ownerID);
        if (!tiles) {
          tiles = [];
          this.enemyDefensePostFrontByTarget.set(ownerID, tiles);
        }
        if (tiles.length >= ENEMY_DEFENSE_POST_MAX_FRONT_TILES) continue;
        let seen = this.enemyDefensePostFrontSeenByTarget.get(ownerID);
        if (!seen) {
          seen = new Set();
          this.enemyDefensePostFrontSeenByTarget.set(ownerID, seen);
        }
        if (seen.has(tile)) continue;
        seen.add(tile);
        tiles.push(tile);
      }
    }

    getEnemyDefensePostFrontTiles(target) {
      if (!target?.isPlayer?.()) return [];
      const targetSid = target.smallID?.();
      if (targetSid == null) return [];
      this.resetEnemyDefensePostCaches();
      const cached = this.enemyDefensePostFrontByTarget.get(targetSid);
      if (cached) return cached;

      // Fallback for direct callers/tests that did not go through maybeAttack's
      // already-required border scan. In the normal engine path this branch is
      // not reached, so it does not duplicate the combat-tick work.
      const front = [];
      for (const borderTile of this.player.borderTiles?.() || []) {
        for (const neighbor of this.game.neighbors(borderTile) || []) {
          if (!this.game.isLand(neighbor)) continue;
          if (this.game.ownerID(neighbor) !== targetSid) continue;
          front.push(neighbor);
          if (front.length >= ENEMY_DEFENSE_POST_MAX_FRONT_TILES) break;
        }
        if (front.length >= ENEMY_DEFENSE_POST_MAX_FRONT_TILES) break;
      }
      this.enemyDefensePostFrontByTarget.set(targetSid, front);
      return front;
    }

    readEnemyDefensePostConfig(method, fallback) {
      try {
        const config = this.game.config?.();
        const value =
          typeof config?.[method] === "function"
            ? config[method]()
            : config?.[method];
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
      } catch (_error) {
        return fallback;
      }
    }

    tileDistanceSquared(left, right) {
      try {
        if (typeof this.game.euclideanDistSquared === "function") {
          return Number(this.game.euclideanDistSquared(left, right));
        }
        if (
          typeof this.game.x === "function" &&
          typeof this.game.y === "function"
        ) {
          const dx = Number(this.game.x(left)) - Number(this.game.x(right));
          const dy = Number(this.game.y(left)) - Number(this.game.y(right));
          return dx * dx + dy * dy;
        }
        if (typeof this.game.manhattanDist === "function") {
          const distance = Number(this.game.manhattanDist(left, right));
          return distance * distance;
        }
      } catch (_error) {
        /* malformed/stale tile views are treated as uncovered */
      }
      return Infinity;
    }

    getOperationalEnemyDefensePosts(target) {
      if (!target?.isPlayer?.()) return [];
      const targetSid = target.smallID?.();
      if (targetSid == null) return [];
      this.resetEnemyDefensePostCaches();
      if (this.enemyDefensePostUnitsCache.has(targetSid)) {
        return this.enemyDefensePostUnitsCache.get(targetSid);
      }

      const operational = [];
      try {
        for (const unit of target.units?.(UNIT.DefensePost) || []) {
          if (
            typeof unit.isActive === "function" &&
            unit.isActive() === false
          ) {
            continue;
          }
          if (
            typeof unit.isUnderConstruction === "function" &&
            unit.isUnderConstruction()
          ) {
            continue;
          }
          const tile =
            typeof unit.tile === "function" ? unit.tile() : unit.tile;
          if (tile == null) continue;
          operational.push({
            tile,
            x:
              typeof this.game.x === "function"
                ? Number(this.game.x(tile))
                : NaN,
            y:
              typeof this.game.y === "function"
                ? Number(this.game.y(tile))
                : NaN,
          });
        }
      } catch (_error) {
        // A stale PlayerView must never abort the complete attack decision.
      }
      this.enemyDefensePostUnitsCache.set(targetSid, operational);
      return operational;
    }

    selectEnemyDefensePostCandidates(frontTiles, posts, range) {
      const candidates = Array.from(posts || []);
      if (candidates.length <= ENEMY_DEFENSE_POST_MAX_SCAN_POSTS) {
        return candidates;
      }
      if (
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return candidates.slice(0, ENEMY_DEFENSE_POST_MAX_SCAN_POSTS);
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const tile of Array.from(new Set(frontTiles || [])).slice(
        0,
        ENEMY_DEFENSE_POST_MAX_FRONT_TILES,
      )) {
        const x = Number(this.game.x(tile));
        const y = Number(this.game.y(tile));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
        return candidates.slice(0, ENEMY_DEFENSE_POST_MAX_SCAN_POSTS);
      }

      const margin = Math.max(0, Number(range) || 0);
      const nearby = candidates.filter(
        (post) =>
          !Number.isFinite(post.x) ||
          !Number.isFinite(post.y) ||
          (post.x >= minX - margin &&
            post.x <= maxX + margin &&
            post.y >= minY - margin &&
            post.y <= maxY + margin),
      );
      return nearby.slice(0, ENEMY_DEFENSE_POST_MAX_SCAN_POSTS);
    }

    getEnemyDefensePostAttackProfile(target, frontTiles = null) {
      if (!this.enemyDefensePostPolicyEnabled() || !target?.isPlayer?.()) {
        return emptyDefensePostAttackProfile();
      }

      this.resetEnemyDefensePostCaches();
      const explicitFront = frontTiles != null;
      const targetSid = target.smallID?.();
      if (!explicitFront && targetSid != null) {
        const cached = this.enemyDefensePostProfileCache.get(targetSid);
        if (cached) return cached;
      }

      const attackFront = explicitFront
        ? frontTiles
        : this.getEnemyDefensePostFrontTiles(target);
      const defensePostRange = this.readEnemyDefensePostConfig(
        "defensePostRange",
        ENEMY_DEFENSE_POST_RANGE,
      );
      const profile = calculateDefensePostAttackProfile({
        frontTiles: attackFront,
        defensePosts: this.selectEnemyDefensePostCandidates(
          attackFront,
          this.getOperationalEnemyDefensePosts(target),
          defensePostRange,
        ),
        distanceSquared: (left, right) =>
          this.tileDistanceSquared(left, right),
        defensePostRange,
        defensePostDefenseBonus: this.readEnemyDefensePostConfig(
          "defensePostDefenseBonus",
          ENEMY_DEFENSE_POST_DEFENSE_BONUS,
        ),
        defensePostSpeedBonus: this.readEnemyDefensePostConfig(
          "defensePostSpeedBonus",
          ENEMY_DEFENSE_POST_SPEED_BONUS,
        ),
      });
      if (!explicitFront && targetSid != null) {
        this.enemyDefensePostProfileCache.set(targetSid, profile);
      }
      return profile;
    }

    getDefensePostMinimumAttackTroops(target, profile) {
      if (
        !this.enemyDefensePostPolicyEnabled() ||
        !target?.isPlayer?.() ||
        !profile?.hasCoverage
      ) {
        return 0;
      }
      const targetTroops = Math.max(0, Number(target.troops?.() ?? 0));
      const multiplier = Math.max(
        1,
        Number(profile.attackCostMultiplier || profile.defenseMultiplier || 1),
      );
      // The faithful bot already refuses a player attack below 2× the target's
      // troops. Scale that same safety floor by the actual Defense Post damage
      // multiplier instead of throwing away the reserve on a covered front.
      return targetTroops * 2 * multiplier;
    }

    attackIsTooWeakForDefensePosts(target, troops, profile) {
      const minimum = this.getDefensePostMinimumAttackTroops(target, profile);
      return minimum > 0 && Number(troops) < minimum;
    }

    attackTargetDifficulty(target) {
      const troops = Math.max(0, Number(target?.troops?.() ?? 0));
      if (!this.enemyDefensePostPolicyEnabled()) return troops;
      const profile = this.getEnemyDefensePostAttackProfile(target);
      // Target ranking considers both parts of Config.attackLogic: direct troop
      // loss and the slower exposure window. Use the worse of the two effects so
      // a future balance change cannot make speed invisible to target choice.
      return (
        troops *
        Math.max(
          1,
          Number(profile.attackCostMultiplier || 1),
          Number(profile.speedMultiplier || 1),
        )
      );
    }

    rankAttackTargets(targets) {
      if (!this.enemyDefensePostPolicyEnabled()) return targets;
      return (targets || [])
        .map((target, index) => ({
          target,
          index,
          rawTroops: Number(target?.troops?.() ?? 0),
          difficulty: this.attackTargetDifficulty(target),
        }))
        .sort(
          (left, right) =>
            left.difficulty - right.difficulty ||
            left.rawTroops - right.rawTroops ||
            left.index - right.index,
        )
        .map(({ target }) => target);
    }

    // maybeAttack — AiAttackBehavior.maybeAttack (now async: it awaits sendAttack,
    // attackWithRandomBoat and attackBestTarget, which reach the async boat probes).
    async maybeAttack() {
      if (this.player === null || this.allianceBehavior === undefined) {
        throw new Error("not initialized");
      }

      // Keep successful emissions from this game tick separate from older
      // decisions. Pending executions are read from outgoingAttacks() below.
      this.ensureBotAttackAccounting();

      const border = Array.from(this.player.borderTiles())
        .flatMap((t) => this.game.neighbors(t))
        .filter(
          (t) =>
            this.game.isLand(t) &&
            this.game.ownerID(t) !== this.player?.smallID(),
        );
      this.cacheEnemyDefensePostFrontTiles(border);
      const playerNeighbors = this.player.nearby();
      // DIVERGENCE: src builds the set from playerBySmallID(ownerID(t)) and filters
      // `o.isPlayer()`. On the client playerBySmallID can return null (core never
      // does), so guard `o != null` before `o.isPlayer()`.
      const borderingPlayerSet = new Set(
        border
          .map((t) => this.game.playerBySmallID(this.game.ownerID(t)))
          .filter((o) => o != null && o.isPlayer()),
      );
      for (const n of playerNeighbors) {
        if (n.isPlayer()) borderingPlayerSet.add(n);
      }
      const borderingPlayers = [...borderingPlayerSet].sort(
        (a, b) => a.troops() - b.troops(),
      );
      const borderingFriends = borderingPlayers.filter(
        (o) => this.player?.isFriendly(o) === true,
      );
      const borderingEnemies = this.rankAttackTargets(
        borderingPlayers.filter(
          (o) => this.player?.isFriendly(o) === false,
        ),
      );

      // Attack TerraNullius but not nuked territory (direct border or across a river)
      const hasNonNukedTerraNullius =
        border.some((t) => !this.game.hasOwner(t) && !this.game.hasFallout(t)) ||
        playerNeighbors.some((n) => !n.isPlayer());

      // WIN-FIX (NOT in src): make the opening state explicit without creating a
      // second decision loop. The existing bot/land branches remain responsible for
      // actuation; this snapshot only tells them whether the opening expansion window
      // is still available and records why a naval target was accepted or rejected.
      const tribeTargets = borderingEnemies
        .filter((enemy) => enemy.isPlayer() && enemy.type() === PlayerType.Bot)
        .map((enemy) => {
          const landBorder = border.some(
            (t) => this.game.ownerID(t) === enemy.smallID(),
          );
          return {
            id: enemy.smallID(),
            alive: enemy.isAlive(),
            friendly: this.player.isFriendly(enemy),
            landBorder,
            boatCandidate: !landBorder,
            // This is only a candidate marker. The donation pause is not allowed
            // to infer an ETA from nearby() or from raw water distance; the async
            // tribe enrichment below must supply the pathfinder ETA first.
            seaReachableWithin30Ticks: false,
            boatEtaTicks: null,
          };
        });
      const earlyGameSnapshot = createEarlyGameSnapshot({
        postSpawn: this.game.inSpawnPhase() === false && this.player.hasSpawned(),
        hasFreeLand: hasNonNukedTerraNullius,
        tribes: tribeTargets,
        boatRouteAvailable: this.game.hasTransportRouteEstimator === true,
      });
      const previousEarlyGame = state.earlyGame || {};
      state.earlyGame = {
        ...earlyGameSnapshot,
        action:
          state.settings.winFixes && earlyGameSnapshot.hasTribeTarget
            ? "tribe"
            : chooseEarlyGameAction({
                landTarget:
                  earlyGameSnapshot.hasFreeLand &&
                  this.hasLandBorderWithTerraNullius(),
                tribeTarget: earlyGameSnapshot.hasTribeTarget,
                boatTarget: false,
              }),
        tribeTarget: null,
        oceanTarget: null,
        boatGate: null,
        lastBoatEtaTicks: null,
        boatRejectedUnknown: previousEarlyGame.boatRejectedUnknown || 0,
        boatRejectedTooFar: previousEarlyGame.boatRejectedTooFar || 0,
        openingLandBurst: previousEarlyGame.openingLandBurst === true,
        expansionPlan: previousEarlyGame.expansionPlan || null,
        troopGenerationRate: previousEarlyGame.troopGenerationRate || 0,
        generationRatio: previousEarlyGame.generationRatio || 0,
        optimalGenerationRatio:
          previousEarlyGame.optimalGenerationRatio || 0.42,
        nextExpansionTick: Number(previousEarlyGame.nextExpansionTick) || 0,
        frontierFreeTiles: previousEarlyGame.frontierFreeTiles || 0,
        frontierTerrainMagnitude:
          previousEarlyGame.frontierTerrainMagnitude || 10,
        frontierTerrainScore: previousEarlyGame.frontierTerrainScore || 0,
        frontierContestedTileCount:
          previousEarlyGame.frontierContestedTileCount || 0,
        frontierCompetingOwnerCount:
          previousEarlyGame.frontierCompetingOwnerCount || 0,
        frontierCompetitionScore:
          previousEarlyGame.frontierCompetitionScore || 0,
      };

      // Panel feature toggles. maybeAttack runs under feat("expand")||feat("boat"),
      // so each ACTION inside must enforce its own toggle — otherwise turning one
      // off while its sibling is on would not actually stop it. LAND conquest
      // (attackBots / TN grab / attackBestTarget) → "expand"; the alliance OFFER →
      // "alliance"; boat calls self-gate on "boat" inside their methods. The
      // `toggle && this.random.chance(...)` short-circuits ONLY skip the RNG roll
      // when the toggle is OFF (a non-faithful config), so the default (all on)
      // keeps the exact faithful RNG stream.
      const f = state.settings.features || {};
      const expandOn = !!f.expand;
      const boatOn = !!f.boat;
      const allianceOn = !!f.alliance;

      const earlyLandPlan =
        state.settings.winFixes && expandOn && earlyGameSnapshot.active
          ? this.getEarlyGameExpansionPlan({ targetType: "land" })
          : null;
      if (earlyLandPlan) this.scheduleEarlyGameExpansion(earlyLandPlan);

      // WIN-FIX (NOT in src): the first live poll after spawn must not wait for
      // the expensive tribe-border enrichment or the normal attack cadence before
      // taking adjacent free land. This flag is set by NationBot only once, so a
      // later tick can return to the normal tribe/ocean ranking pipeline.
      if (
        state.settings.winFixes &&
        state.earlyGame.openingLandBurst === true
      ) {
        state.earlyGame.openingLandBurst = false;
        if (
          expandOn &&
          borderingEnemies.length === 0 &&
          hasNonNukedTerraNullius &&
          this.hasLandBorderWithTerraNullius() &&
          earlyLandPlan?.shouldAttackNow
        ) {
          if (
            await this.sendAttack(
              this.game.terraNullius(),
              false,
              null,
              null,
              earlyLandPlan.commitTroops,
            )
          ) {
            this.scheduleEarlyGameExpansion(earlyLandPlan, true);
            return;
          }
        }
      }

      // WIN-FIX (NOT in src): TAKE OVER a DISCONNECTED neighbour's land. A player who
      // left/timed-out shows the "zzz" icon (isDisconnected()), and the game already
      // treats them as NOT friendly even if they are a teammate/ally (PlayerImpl.isFriendly
      // returns false when disconnected) — so we are allowed to attack their undefended
      // territory. Grab it FIRST (before TN/bots/enemies) so an enemy doesn't snatch the
      // free land. Prioritise the weakest disconnected neighbour.
      if (expandOn && state.settings.winFixes) {
        const sleeping = borderingPlayers.filter((p) => {
          try {
            return p.isPlayer() && p.isDisconnected && p.isDisconnected();
          } catch (_e) {
            return false;
          }
        });
        if (sleeping.length > 0) {
          sleeping.sort((a, b) => a.troops() - b.troops());
          console.log(
            "[Takeover] disconnected neighbour → grabbing land:",
            sleeping[0].name?.() ?? sleeping[0].smallID?.(),
          );
          if (await this.sendAttack(sleeping[0])) return;
        }
      }

      // WIN-FIX (NOT in src): during the concrete opening window, rank nearby
      // tribes by open-ocean access, immediate races, and the stronger of their
      // encirclement/blocking opportunities before continuation food. The
      // progressing-vector race signal remains a later tie-breaker. If no ranked
      // target can be actuated, fall back to the existing aggressive bot pass.
      if (
        expandOn &&
        state.settings.winFixes &&
        earlyGameSnapshot.active &&
        earlyGameSnapshot.hasTribeTarget
      ) {
        if (await this.attackEarlyGameTribe()) return;
      }

      // WIN-FIX (NOT in src): if we already hold an ocean shore, take a nearby
      // unowned open-ocean coast before generic empty-land expansion. The landing
      // remains a cheap probe and is still subject to the exact <=30s early-game
      // transport gate. The largest connected water component excludes smaller
      // isolated lakes and seas from this objective.
      if (
        expandOn &&
        boatOn &&
        state.settings.winFixes &&
        earlyGameSnapshot.active
      ) {
        if (await this.maybeEarlyOceanBoat()) return;
      }

      // WIN-FIX (NOT in src): aggressively eat bordering BOTS (the weak Tribe AI
      // that crowds a bot-heavy map) BEFORE grabbing TerraNullius and BEFORE the
      // reserve/trigger gates — so the bot ACTIVELY conquers the bots around it
      // instead of passively expanding into empty land / waiting for fill. The
      // pure faithful AI grabs TN first and only fights bots via the gated pipeline.
      if (
        expandOn &&
        state.settings.winFixes &&
        borderingEnemies.some((e) => e.isPlayer() && e.type() === PlayerType.Bot)
      ) {
        if (await this.attackBots()) return;
      }

      // WIN-FIX (NOT in src): safe empty land gets a planned expansion attempt
      // before any opportunistic boat probe. The planner's commitment is bounded
      // by terrain loss, generation, and competition; once an enemy borders us,
      // the perishable-opportunity signal determines whether to spend more.
      if (
        expandOn &&
        state.settings.winFixes &&
        state.earlyGame.action === "land" &&
        borderingEnemies.length === 0 &&
        earlyLandPlan?.shouldAttackNow
      ) {
        if (
          await this.sendAttack(
            this.game.terraNullius(),
            false,
            null,
            null,
            earlyLandPlan.commitTroops,
          )
        ) {
          this.scheduleEarlyGameExpansion(earlyLandPlan, true);
          return;
        }
      }

      // WIN-FIX (NOT in src): opportunistic amphibious landings — cheap probe boats
      // into weak / freshly-MIRV'd overseas nations, then surge once a beachhead
      // lands. Throttled internally; does NOT return, so land expansion still runs.
      if (state.settings.winFixes) {
        await this.maybeOpportunisticBoat();
      }

      // WIN-FIX (NOT in src): proactively top up a WEAKER same-team ally. The faithful
      // donate is the LAST attack strategy, so on a busy front it never fires; the
      // client also often can't see allies' combat. Throttled; donateTroops keeps our
      // reserve and (in winFix mode) only donates DOWN to a poorer ally.
      if (state.settings.winFixes && state.settings.features.donate) {
        const dNow = performance.now();
        if (dNow - (state.lastDonateMs || 0) > (state.settings.donateThrottleMs || 3000)) {
          if (this.donateTroops()) state.lastDonateMs = dNow;
        }
      }

      // WIN-FIX (NOT in src): SMART DIPLOMACY — proactively court FAR nations (ones we
      // don't border) for DEFENSIVE trade-ally alliances, run unconditionally here so it
      // fires even when we have no bordering enemy (the faithful maybeSendAllianceRequests
      // only runs when borderingEnemies > 0). reachOutToFarNations self-throttles AND
      // self-gates on dominance (stops once we're winning so betray/conquer can close out).
      if (allianceOn && state.settings.winFixes) {
        this.allianceBehavior.reachOutToFarNations();
      }

      const deferSafeEarlyLand =
        state.settings.winFixes &&
        expandOn &&
        earlyGameSnapshot.active &&
        borderingEnemies.length === 0 &&
        earlyLandPlan &&
        !earlyLandPlan.shouldAttackNow;
      if (expandOn && hasNonNukedTerraNullius && !deferSafeEarlyLand) {
        if (await this.sendAttack(this.game.terraNullius())) return;
      }

      if (borderingEnemies.length === 0) {
        if (boatOn && this.random.chance(5)) {
          await this.attackWithRandomBoat();
        }
      } else {
        if (boatOn && this.random.chance(10)) {
          await this.attackWithRandomBoat(borderingEnemies);
          return;
        }

        if (allianceOn) {
          this.allianceBehavior.maybeSendAllianceRequests(borderingEnemies);
        }
      }

      if (expandOn) {
        await this.attackBestTarget(borderingFriends, borderingEnemies);
      }
    }

    // Rank and eat one tribe during Early Game. This is a win-fix policy layer,
    // not a replacement for the faithful attack strategy order below. A failed
    // boat/land actuation simply lets the caller continue with its normal pass.
    async attackEarlyGameTribe() {
      const candidates = await this.getEarlyGameTribeCandidates();
      if (candidates.length === 0) return false;

      for (const candidate of candidates) {
        const urgent =
          Number(candidate.directAttackers || 0) > 0 ||
          Number(candidate.incomingAttackers || 0) > 0 ||
          Math.max(
            finiteEarlyGameSignal(candidate.foodRaceValue),
            finiteEarlyGameSignal(candidate.contestPressure),
          ) >= 0.45;
        candidate.expansionPlan = this.getEarlyGameExpansionPlan({
          targetType: "tribe",
          target: candidate.player,
          candidate,
          urgent,
        });
      }
      const ranked = rankEarlyGameTribeCandidates(candidates);
      const diagnosticTargets = ranked.map((candidate) => {
        const plan = candidate.expansionPlan;
        const boatEtaTicks = Number.isFinite(candidate.boatEtaTicks)
          ? candidate.boatEtaTicks
          : null;
        return {
          id: candidate.id,
          maritimeDistance: Number.isFinite(candidate.maritimeDistance)
            ? candidate.maritimeDistance
            : null,
          oceanDistance: Number.isFinite(candidate.oceanDistance)
            ? candidate.oceanDistance
            : null,
          futureFoodCount: candidate.futureFoodCount,
          futureFoodAccess: Number(
            finiteEarlyGameSignal(candidate.futureFoodAccess).toFixed(3),
          ),
          foodRaceValue: Number(finiteEarlyGameSignal(candidate.foodRaceValue).toFixed(3)),
          encirclement: Number(finiteEarlyGameSignal(candidate.encirclement).toFixed(3)),
          blockValue: Number(finiteEarlyGameSignal(candidate.blockValue).toFixed(3)),
          cheapCapture: Number(finiteEarlyGameSignal(candidate.cheapCapture).toFixed(3)),
          landBorder: candidate.landBorder,
          seaReachableWithin30Ticks:
            candidate.landBorder !== true &&
            boatEtaTicks !== null &&
            boatEtaTicks >= 0 &&
            boatEtaTicks <= getAutoDonateExpansionTickLimit(),
          boatEtaTicks,
          contestingPlayers: candidate.contestingPlayers,
          shouldAttackNow: plan.shouldAttackNow,
          requiredTroops: Math.round(plan.requiredTroops),
          commitTroops: Math.round(plan.commitTroops),
          terrainMagnitude: plan.terrainMagnitude,
          generationRatio: Number(plan.generationRatio.toFixed(3)),
          opportunityUrgency: Number(plan.opportunityUrgency.toFixed(3)),
          irreversibleOpportunity: plan.irreversibleOpportunity === true,
        };
      });
      if (state.earlyGame) {
        state.earlyGame.actionableTribes = diagnosticTargets;
        state.earlyGame.tribeTarget = diagnosticTargets[0] || null;
      }

      for (const candidate of ranked) {
        try {
          const plan = candidate.expansionPlan;
          if (!plan?.shouldAttackNow) continue;
          if (
            await this.sendAttack(
              candidate.player,
              false,
              null,
              candidate,
              plan.commitTroops,
            )
          ) {
            this.scheduleEarlyGameExpansion(plan, true);
            return true;
          }
        } catch (error) {
          console.warn("[EarlyGame] tribe target failed:", candidate.id, error);
        }
      }
      return false;
    }

    // OpenFront's map generator marks only the largest connected water surface
    // with `isOcean`, and `isOceanShore` marks its coast. Do not infer ocean
    // access from map edges: smaller isolated seas/lakes can touch an edge too.
    isEarlyGameMaritimeWater(tile) {
      if (tile == null || typeof this.game.isOcean !== "function") return false;

      if (this.earlyGameMaritimeWaterCache.has(tile)) {
        return this.earlyGameMaritimeWaterCache.get(tile) === true;
      }

      let maritime = false;
      try {
        maritime = this.game.isOcean(tile) === true;
      } catch (_error) {
        maritime = false;
      }
      this.earlyGameMaritimeWaterCache.set(tile, maritime);
      return maritime;
    }

    isEarlyGameMaritimeShore(tile) {
      if (tile == null || typeof this.game.isLand !== "function") return false;
      if (!this.game.isLand(tile)) return false;
      if (typeof this.game.isOceanShore === "function") {
        try {
          return this.game.isOceanShore?.(tile) === true;
        } catch (_error) {
          /* fall through to the component-neighbor fallback */
        }
      }
      if (typeof this.game.isShore !== "function") return false;
      if (!this.game.isShore(tile)) return false;
      return (this.game.neighbors(tile) || []).some(
        (neighbor) =>
          this.game.isWater?.(neighbor) === true &&
          this.isEarlyGameMaritimeWater(neighbor),
      );
    }

    getEarlyGameMaritimeIndex() {
      if (this.earlyGameMaritimeIndex !== undefined) {
        return this.earlyGameMaritimeIndex;
      }
      if (
        typeof this.game.width !== "function" ||
        typeof this.game.height !== "function"
      ) {
        this.earlyGameMaritimeIndex = null;
        return null;
      }
      const cacheKey = earlyGameMaritimeCacheKey(this.game);
      if (
        cacheKey &&
        (typeof cacheKey === "object" || typeof cacheKey === "function")
      ) {
        const cached = EARLY_GAME_MARITIME_INDEX_CACHE.get(cacheKey);
        if (cached) {
          this.earlyGameMaritimeIndex = cached;
          return cached;
        }
      }
      const index = buildMaritimeDistanceIndex({
        width: this.game.width(),
        height: this.game.height(),
        neighbors: (tile) => this.game.neighbors(tile),
        isLand: (tile) => this.game.isLand(tile),
        isMaritimeShore: (tile) => this.isEarlyGameMaritimeShore(tile),
      });
      this.earlyGameMaritimeIndex = index;
      if (
        index &&
        cacheKey &&
        (typeof cacheKey === "object" || typeof cacheKey === "function")
      ) {
        EARLY_GAME_MARITIME_INDEX_CACHE.set(cacheKey, index);
      }
      return index;
    }

    getEarlyGameMaritimeDistance(starts) {
      const index = this.getEarlyGameMaritimeIndex();
      if (index) {
        return lookupMaritimeDistanceIndex(index, starts);
      }
      return findNearestMaritimeCoastDistance({
        starts,
        neighbors: (tile) => this.game.neighbors(tile),
        isLand: (tile) => this.game.isLand(tile),
        isMaritimeShore: (tile) => this.isEarlyGameMaritimeShore(tile),
      });
    }

    // Build the small, bounded feature vector used by rankEarlyGameTribeCandidates.
    // Border snapshots are fetched only for nearby bot tribes, never for every
    // player on the map. That makes this safe at maximum game speed as well as on
    // a tribe-heavy map.
    async getEarlyGameTribeCandidates() {
      const nearbyTribes = this.player
        .nearby()
        .filter(
          (candidate) =>
            candidate &&
            candidate.isPlayer() &&
            candidate.isAlive() &&
            candidate.type() === PlayerType.Bot &&
            this.player.isFriendly(candidate) === false,
        )
        .slice(0, EARLY_TRIBE_CANDIDATES);
      if (nearbyTribes.length === 0) return [];

      const otherPlayers = this.game.players();
      const myCenter = this.getPlayerCenter(this.player);
      const mySid = this.player.smallID();
      const competitorProfiles = this.getEarlyGameCompetitorProfiles(
        otherPlayers,
        mySid,
      );
      const candidates = [];

      // Border snapshots are worker-backed on the client. Fetch them in small
      // batches so eight candidates cannot serialize eight timeout windows, while
      // still keeping the amount of concurrent worker work bounded.
      const borderByTribe = new Map();
      for (
        let start = 0;
        start < nearbyTribes.length;
        start += EARLY_TRIBE_BORDER_FETCH_CONCURRENCY
      ) {
        const batch = nearbyTribes.slice(
          start,
          start + EARLY_TRIBE_BORDER_FETCH_CONCURRENCY,
        );
        await Promise.all(
          batch.map(async (tribe) => {
            let border = new Set();
            try {
              if (typeof this.game.ensureBorderTiles === "function") {
                const fetched = await withTimeout(
                  this.game.ensureBorderTiles(tribe),
                  WORKER_TIMEOUT_MS,
                  null,
                );
                if (fetched && fetched.size > 0) border = fetched;
              }
              if (border.size === 0) {
                const snapshot = tribe.borderTiles();
                if (snapshot && snapshot.size > 0) border = snapshot;
              }
            } catch (_e) {
              /* no border snapshot → keep the candidate with conservative signals */
            }
            borderByTribe.set(tribe, border);
          }),
        );
      }

      for (const tribe of nearbyTribes) {
        const border = borderByTribe.get(tribe) || new Set();

        const tribeSid = tribe.smallID();
        let boundaryEdges = 0;
        let ownEdges = 0;
        let externalEdges = 0;
        let terrainMagnitudeTotal = 0;
        let terrainMagnitudeCount = 0;
        const externalSids = new Set();
        for (const tile of border) {
          try {
            const magnitude = Number(this.game.magnitude?.(tile));
            if (Number.isFinite(magnitude)) {
              terrainMagnitudeTotal += magnitude;
              terrainMagnitudeCount += 1;
            }
          } catch (_error) {
            /* older adapters may not expose terrain magnitude */
          }
          for (const neighbor of this.game.neighbors(tile)) {
            if (!this.game.isLand(neighbor)) continue;
            const ownerSid = this.game.ownerID(neighbor);
            if (ownerSid === tribeSid) continue;
            boundaryEdges++;
            if (ownerSid === mySid) {
              ownEdges++;
            } else if (ownerSid != null) {
              externalEdges++;
              externalSids.add(ownerSid);
            }
          }
        }

        const encirclement =
          boundaryEdges > 0 ? ownEdges / boundaryEdges : 0;
        const directBlock =
          boundaryEdges > 0 ? externalEdges / boundaryEdges : 0;
        const tribeCenter =
          border.size > 0
            ? calculateBoundingBoxCenter(this.game, border)
            : tribe.nameLocation?.() || null;
        let distance = Infinity;
        if (myCenter && tribeCenter && myCenter.x != null && tribeCenter.x != null) {
          const myTile = this.game.ref(myCenter.x, myCenter.y);
          const tribeTile = this.game.ref(tribeCenter.x, tribeCenter.y);
          distance = this.game.manhattanDist(myTile, tribeTile);
        }

        let nearbyContesters = 0;
        for (const other of otherPlayers) {
          if (!other || !other.isPlayer() || !other.isAlive()) continue;
          const otherSid = other.smallID();
          if (otherSid === mySid || otherSid === tribeSid) continue;
          const location = other.nameLocation?.();
          if (!location || location.x == null || !tribeCenter || tribeCenter.x == null) {
            continue;
          }
          if (!this.game.isValidCoord(location.x, location.y)) continue;
          const otherTile = this.game.ref(location.x, location.y);
          const tribeTile = this.game.ref(tribeCenter.x, tribeCenter.y);
          if (this.game.manhattanDist(otherTile, tribeTile) <= 80) {
            nearbyContesters++;
          }
        }

        let incomingContesters = 0;
        try {
          const incoming = tribe.incomingAttacks ? tribe.incomingAttacks() : [];
          for (const attack of incoming || []) {
            const attacker = attack.attacker?.();
            if (
              attacker &&
              attacker.isPlayer?.() &&
              attacker.smallID() !== mySid &&
              attacker.smallID() !== tribeSid
            ) {
              incomingContesters++;
            }
          }
        } catch (_e) {
          /* attack snapshots are optional on older client builds */
        }

        const blockValue = Math.min(
          1,
          directBlock + nearbyContesters * 0.15 + incomingContesters * 0.25,
        );
        const foodRace = this.getEarlyGameFoodRaceSignals({
          tribe,
          tribeSid,
          tribeCenter,
          competitorProfiles,
        });
        const maritimeDistance = this.getEarlyGameMaritimeDistance(border);
        const terrainMagnitude = terrainMagnitudeCount > 0
          ? terrainMagnitudeTotal / terrainMagnitudeCount
          : 10;
        const expectedTiles = border.size > 0
          ? Math.max(3, Math.min(12, Math.round(Math.sqrt(border.size) * 1.75)))
          : 3;
        const troopRatio =
          this.player.troops() > 0
            ? tribe.troops() / this.player.troops()
            : 1;
        candidates.push({
          player: tribe,
          id: tribe.smallID(),
          maritimeDistance,
          // Keep the legacy diagnostic/ranker field populated for adapters that
          // still inspect oceanDistance; the new value is the maritime route
          // distance, not a closed-lake shore distance.
          oceanDistance: maritimeDistance,
          encirclement,
          blockValue,
          cheapCapture: Math.max(0, 1 - Math.min(1, troopRatio)),
          landBorder: ownEdges > 0,
          boatEtaTicks: null,
          distance,
          center: tribeCenter,
          futureFoodCount: 0,
          futureFoodTotal: 0,
          meanFutureFoodDistance: Infinity,
          futureFoodChainRadius: EARLY_GAME_TRIBE_CHAIN_RADIUS,
          futureFoodAccess: null,
          foodRaceValue: foodRace.foodRaceValue,
          contestPressure: foodRace.contestPressure,
          competitorTroops: foodRace.competitorTroops,
          competitorProgress: foodRace.competitorProgress,
          competitorVector: foodRace.competitorVector,
          directAttackers: foodRace.directAttackers,
          incomingAttackers: foodRace.incomingAttackers,
          contestingPlayers:
            Math.max(
              externalSids.size + nearbyContesters + incomingContesters,
              foodRace.contestingPlayers,
            ),
          terrainMagnitude,
          expectedTiles,
        });
      }

      // A maritime tribe qualifies for the donation pause only after the same
      // transport pathfinder used by boat actuation has measured a route. Probe a
      // few nearest target shores, because the geometrically nearest shore can be
      // on a different water component. The result includes the transport
      // movement speed/ticks-per-move conversion from gameApi.
      const seaCandidates = candidates.filter((candidate) => !candidate.landBorder);
      for (
        let start = 0;
        start < seaCandidates.length;
        start += EARLY_TRIBE_BORDER_FETCH_CONCURRENCY
      ) {
        const batch = seaCandidates.slice(
          start,
          start + EARLY_TRIBE_BORDER_FETCH_CONCURRENCY,
        );
        await Promise.all(
          batch.map(async (candidate) => {
            candidate.boatEtaTicks = await this.estimateEarlyGameTribeBoatEta(
              candidate.player,
              borderByTribe.get(candidate.player) || new Set(),
            );
          }),
        );
      }

      // A bounded continuation pass estimates how many other neutral tribes will
      // be reachable from the newly acquired frontier. This is deliberately a
      // geometric opportunity signal, not a second attack loop.
      const futureFoodTotal = Math.max(0, candidates.length - 1);
      for (const candidate of candidates) {
        const distances = candidates
          .filter((other) => other.id !== candidate.id)
          .map((other) =>
            this.earlyGameCenterDistance(candidate.center, other.center),
          )
          .filter(
            (distanceToFood) =>
              Number.isFinite(distanceToFood) &&
              distanceToFood <= EARLY_GAME_TRIBE_CHAIN_RADIUS,
          );
        candidate.futureFoodCount = distances.length;
        candidate.futureFoodTotal = futureFoodTotal;
        candidate.meanFutureFoodDistance =
          distances.length > 0
            ? distances.reduce((sum, value) => sum + value, 0) / distances.length
            : Infinity;
        candidate.futureFoodAccess = calculateEarlyGameContinuationValue(candidate);
      }
      return candidates;
    }

    async estimateEarlyGameTribeBoatEta(target, targetBorder) {
      try {
        if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return null;
      } catch (_e) {
        /* older adapters do not expose unit-disable checks */
      }
      if (
        this.game.hasTransportRouteEstimator !== true ||
        typeof this.game.estimateTransportRouteTicks !== "function"
      ) {
        return null;
      }

      const ownShores = Array.from(this.player.borderTiles()).filter((tile) =>
        this.game.isShore(tile),
      );
      const targetShores = Array.from(targetBorder || []).filter((tile) =>
        this.game.isShore(tile),
      );
      if (ownShores.length === 0 || targetShores.length === 0) return null;

      const distanceToOwnShore = (tile) => {
        let best = Infinity;
        for (const ownShore of ownShores) {
          const distance = this.game.manhattanDist(ownShore, tile);
          if (distance < best) best = distance;
        }
        return best;
      };
      targetShores.sort(
        (a, b) => distanceToOwnShore(a) - distanceToOwnShore(b),
      );

      let bestEta = null;
      for (const targetShore of targetShores.slice(0, EARLY_TRIBE_BOAT_ETA_TARGETS)) {
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(targetShore),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn === false) continue;

        const eta = await withTimeout(
          this.game.estimateTransportRouteTicks(
            targetShore,
            getAutoDonateExpansionTickLimit(),
          ),
          WORKER_TIMEOUT_MS,
          null,
        );
        if (!Number.isFinite(Number(eta)) || Number(eta) < 0) continue;
        const numericEta = Number(eta);
        bestEta = bestEta === null ? numericEta : Math.min(bestEta, numericEta);
        if (bestEta <= getAutoDonateExpansionTickLimit()) return bestEta;
      }
      return bestEta;
    }

    // Keep a bounded, best-effort profile of how visible rivals are expanding.
    // Territory-centre movement and tile growth are useful leading indicators
    // before an outgoing attack appears in the target's incoming snapshot.
    getEarlyGameCompetitorProfiles(players, mySid) {
      const profiles = [];
      const seen = new Set();
      const history = this.earlyFoodMovement;
      let tick = 0;
      try {
        tick = Number(this.game.ticks?.()) || 0;
      } catch (_e) {
        /* older adapters do not expose ticks on the game wrapper */
      }

      for (const other of players || []) {
        try {
          if (!other || !other.isPlayer?.() || !other.isAlive?.()) continue;
          const sid = other.smallID?.();
          if (sid == null || sid === mySid) continue;

          const location = other.nameLocation?.() || null;
          const x = Number(location?.x);
          const y = Number(location?.y);
          const tiles = Math.max(0, Number(other.numTilesOwned?.()) || 0);
          const previous = history.get(sid);
          const hasLocation = Number.isFinite(x) && Number.isFinite(y);
          const previousHasLocation =
            previous &&
            Number.isFinite(previous.x) &&
            Number.isFinite(previous.y);
          const dx = hasLocation && previousHasLocation ? x - previous.x : 0;
          const dy = hasLocation && previousHasLocation ? y - previous.y : 0;
          const tickDelta = previous
            ? Math.max(1, tick - previous.tick)
            : 1;
          const tileDelta = previous
            ? Math.max(0, tiles - previous.tiles)
            : 0;
          const progress = previous
            ? Math.min(
                1,
                tileDelta /
                  Math.max(2, previous.tiles * 0.15, tickDelta * 2),
              )
            : 0;

          const outgoingTargets = [];
          let outgoing = [];
          try {
            outgoing = other.outgoingAttacks?.() || [];
          } catch (_e) {
            /* attack snapshots are optional on older client builds */
          }
          for (const attack of outgoing) {
            try {
              if (attack.retreating?.() === true) continue;
              const target = attack.target?.();
              const targetSid = target?.smallID?.();
              if (targetSid == null) continue;
              outgoingTargets.push({
                targetSid,
                target,
                troops: Math.max(0, Number(attack.troops?.()) || 0),
                location: target.nameLocation?.() || null,
              });
            } catch (_e) {
              /* one malformed attack must not blind the rest of the scan */
            }
          }

          profiles.push({
            sid,
            location: hasLocation ? { x, y } : null,
            dx,
            dy,
            progress,
            troops: Math.max(0, Number(other.troops?.()) || 0),
            outgoingTargets,
          });
          seen.add(sid);
          history.set(sid, { tick, x, y, tiles });
        } catch (_e) {
          /* player wrappers can disappear while a tick is being assembled */
        }
      }

      for (const sid of history.keys()) {
        if (!seen.has(sid)) history.delete(sid);
      }
      return profiles;
    }

    earlyGameCenterDistance(a, b) {
      if (
        !a ||
        !b ||
        !Number.isFinite(Number(a.x)) ||
        !Number.isFinite(Number(a.y)) ||
        !Number.isFinite(Number(b.x)) ||
        !Number.isFinite(Number(b.y))
      ) {
        return Infinity;
      }
      return (
        Math.abs(Number(a.x) - Number(b.x)) +
        Math.abs(Number(a.y) - Number(b.y))
      );
    }

    earlyGameVectorAlignment(origin, target, dx, dy) {
      if (!origin || !target) return 0;
      const targetX = Number(target.x) - Number(origin.x);
      const targetY = Number(target.y) - Number(origin.y);
      const movementX = Number(dx) || 0;
      const movementY = Number(dy) || 0;
      const targetLength = Math.hypot(targetX, targetY);
      const movementLength = Math.hypot(movementX, movementY);
      if (!Number.isFinite(targetLength) || targetLength <= 0) return 0;
      if (!Number.isFinite(movementLength) || movementLength <= 0) return 0;
      return Math.max(
        0,
        Math.min(
          1,
          (targetX * movementX + targetY * movementY) /
            (targetLength * movementLength),
        ),
      );
    }

    // Turn current attacks plus competitor motion into the candidate fields used
    // by the pure early-game ranker. Direct outgoing/incoming attacks are merged
    // by player id so the same attack is not counted twice.
    getEarlyGameFoodRaceSignals({
      tribe,
      tribeSid,
      tribeCenter,
      competitorProfiles,
    }) {
      const records = new Map();
      const incomingAttackers = new Set();
      const directAttackers = new Set();
      const recordFor = (sid) => {
        if (!records.has(sid)) {
          records.set(sid, {
            troops: 0,
            progress: 0,
            vector: 0,
          });
        }
        return records.get(sid);
      };

      try {
        const incoming = tribe.incomingAttacks?.() || [];
        for (const attack of incoming) {
          if (attack.retreating?.() === true) continue;
          const attacker = attack.attacker?.();
          const sid = attacker?.smallID?.();
          if (sid == null || sid === this.player.smallID() || sid === tribeSid) {
            continue;
          }
          const record = recordFor(sid);
          record.troops = Math.max(
            record.troops,
            Math.max(0, Number(attack.troops?.()) || 0),
          );
          incomingAttackers.add(sid);
        }
      } catch (_e) {
        /* attack snapshots are optional on older client builds */
      }

      for (const profile of competitorProfiles || []) {
        if (profile.sid === tribeSid) continue;
        const direct = profile.outgoingTargets.filter(
          (attack) => attack.targetSid === tribeSid,
        );
        const directRecord = direct.length > 0 ? recordFor(profile.sid) : null;
        if (directRecord) {
          directAttackers.add(profile.sid);
          directRecord.troops = Math.max(
            directRecord.troops,
            direct.reduce((sum, attack) => sum + attack.troops, 0),
          );
          directRecord.vector = 1;
          directRecord.progress = Math.max(
            directRecord.progress,
            profile.progress,
          );
        }

        let alignment = directRecord ? 1 : 0;
        if (!directRecord && profile.location && tribeCenter) {
          alignment = this.earlyGameVectorAlignment(
            profile.location,
            tribeCenter,
            profile.dx,
            profile.dy,
          );
          for (const attack of profile.outgoingTargets) {
            const targetLocation = attack.location;
            alignment = Math.max(
              alignment,
              this.earlyGameVectorAlignment(
                profile.location,
                tribeCenter,
                Number(targetLocation?.x) - Number(profile.location.x),
                Number(targetLocation?.y) - Number(profile.location.y),
              ) * 0.9,
            );
          }
          const distance = this.earlyGameCenterDistance(
            profile.location,
            tribeCenter,
          );
          if (Number.isFinite(distance)) {
            alignment *= Math.max(0, Math.min(1, 1 - distance / 160));
          } else {
            alignment = 0;
          }
          if (alignment > 0.35 && profile.progress > 0) {
            const directional = recordFor(profile.sid);
            directional.vector = Math.max(directional.vector, alignment);
            directional.progress = Math.max(
              directional.progress,
              profile.progress,
            );
            directional.troops = Math.max(
              directional.troops,
              profile.troops * 0.1 * alignment,
            );
          }
        }
      }

      const values = [...records.values()];
      const competitorProgress = values.reduce(
        (max, record) => Math.max(max, record.progress),
        0,
      );
      const competitorVector = values.reduce(
        (max, record) => Math.max(max, record.vector),
        0,
      );
      const competitorTroops = values.reduce(
        (sum, record) => sum + record.troops,
        0,
      );
      const foodRaceValue = calculateEarlyGameFoodRaceValue({
        directAttackers: directAttackers.size,
        incomingAttackers: incomingAttackers.size,
        competitorProgress,
        competitorVector,
        competitorTroops,
        targetTroops: tribe.troops?.(),
      });

      return {
        foodRaceValue,
        contestPressure: foodRaceValue,
        competitorTroops,
        competitorProgress,
        competitorVector,
        directAttackers: directAttackers.size,
        incomingAttackers: incomingAttackers.size,
        contestingPlayers: records.size,
      };
    }

    // With an ocean shore already in hand, take the nearest unowned open-ocean
    // coast in the opening window. This is a cheap landing probe whose only goal
    // is to establish a future Port site; normal land expansion remains the
    // fallback when no safe coast is reachable.
    async maybeEarlyOceanBoat() {
      if (!(state.settings.features && state.settings.features.boat)) return false;
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return false;
      if (
        this.player.unitCount(UNIT.TransportShip) >=
        this.game.config().boatMaxNumber()
      ) {
        return false;
      }

      const shores = Array.from(this.player.borderTiles()).filter((tile) =>
        this.isEarlyGameMaritimeShore(tile),
      );
      if (shores.length === 0) return false;

      const targets = this.scanEarlyOceanTargets(shores);
      for (const target of targets.slice(0, BOAT_PROBE_CANDIDATES)) {
        if (this.boatTargetTaken(target.tile)) continue;
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(target.tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn === false || !(await this.allowEarlyGameBoat(target.tile))) {
          continue;
        }

        const troops = this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
        if (troops < 1) return false;
        if (this.emitBoat(target.tile, troops, "🏝️ Ocean coast grab")) {
          state.earlyGame.oceanTarget = {
            distance: target.dist,
            oceanShore: true,
          };
          state.earlyGame.action = "ocean";
          return true;
        }
      }
      return false;
    }

    scanEarlyOceanTargets(shores) {
      if (
        typeof this.game.isShore !== "function" &&
        typeof this.game.isOceanShore !== "function"
      ) {
        return [];
      }
      const radius = state.settings.islandScanRadius || 40;
      const step = state.settings.islandScanStep || 2;
      const sampleCount = Math.min(
        state.settings.islandScanSamples || 6,
        shores.length,
      );
      if (sampleCount === 0) return [];

      const samples = [];
      const stride = Math.max(1, Math.ceil(shores.length / sampleCount));
      for (let i = 0; i < shores.length && samples.length < sampleCount; i += stride) {
        samples.push(shores[i]);
      }

      const seen = new Set();
      const targets = [];
      for (const shore of samples) {
        const sx = this.game.x(shore);
        const sy = this.game.y(shore);
        for (let dx = -radius; dx <= radius; dx += step) {
          for (let dy = -radius; dy <= radius; dy += step) {
            const x = sx + dx;
            const y = sy + dy;
            if (!this.game.isValidCoord(x, y)) continue;
            const tile = this.game.ref(x, y);
            if (seen.has(tile) || !this.game.isLand(tile)) continue;
            if (this.game.hasOwner(tile) || this.game.hasFallout(tile)) continue;
            if (!this.isEarlyGameMaritimeShore(tile)) continue;
            if (
              this.game
                .neighbors(tile)
                .some((neighbor) => this.game.ownerID(neighbor) === this.player.smallID())
            ) {
              continue;
            }
            seen.add(tile);
            targets.push({ tile, dist: dx * dx + dy * dy });
          }
        }
      }
      targets.sort((a, b) => a.dist - b.dist);
      return targets;
    }

    // Exact ETA is deliberately fail-closed during Early Game. The current public
    // GameView exposes only bestTransportShipSpawn(), not the WaterPathFinder path;
    // accepting an unknown route would violate the <=30s policy. A future adapter can
    // provide game.estimateTransportRouteTicks(tile), returning exact movement ticks.
    async allowEarlyGameBoat(tile) {
      const early = state.earlyGame;
      if (!state.settings.winFixes || !early || !early.active) return true;
      if (
        early.boatRouteAvailable !== true ||
        typeof this.game.estimateTransportRouteTicks !== "function"
      ) {
        early.boatGate = "unknown-route";
        early.boatRejectedUnknown = (early.boatRejectedUnknown || 0) + 1;
        return false;
      }
      const eta = await withTimeout(
        this.game.estimateTransportRouteTicks(tile),
        WORKER_TIMEOUT_MS,
        null,
      );
      if (!isEarlyGameBoatEta(eta)) {
        if (eta == null) {
          early.boatGate = "unknown-route";
          early.boatRejectedUnknown = (early.boatRejectedUnknown || 0) + 1;
        } else {
          early.boatGate = "over-30s";
          early.boatRejectedTooFar = (early.boatRejectedTooFar || 0) + 1;
        }
        return false;
      }
      early.boatGate = "within-30s";
      early.lastBoatEtaTicks = eta;
      return true;
    }

    // attackWithRandomBoat — AiAttackBehavior (private, now async via findRandomBoatTarget).
    async attackWithRandomBoat(borderingEnemies = []) {
      if (this.player === null) throw new Error("not initialized");

      // Honour the panel's "boat" feature toggle (the only boat gate — maybeAttack
      // itself runs under expand||boat, so the toggle must be enforced here).
      if (!(state.settings.features && state.settings.features.boat)) {
        return;
      }

      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) {
        return;
      }

      // WIN-FIX (NOT in src; winFixes-gated): once we DOMINATE the map by land,
      // a "random boat" almost always targets land we're about to conquer anyway.
      // At max game speed the boat intent reaches the worker many ticks after the
      // bestTransportShipSpawn probe, by which time we already own the dst tile —
      // so the game rejects it ("cannot find start tile" / sends to ourselves) and
      // floods the console with harmless-but-noisy failures. A dominating bot
      // expands by LAND, not sea, so skip random boats past a high land share.
      // (Early game = small share = boats still fire, preserving island expansion.)
      if (state.settings.winFixes) {
        const totalLand = this.game.numLandTiles() || 1;
        if (this.player.numTilesOwned() / totalLand > 0.25) {
          return;
        }
      }

      // Check if we've already sent out the maximum number of transport ships
      if (
        this.player.unitCount(UNIT.TransportShip) >=
        this.game.config().boatMaxNumber()
      ) {
        return;
      }

      // Check if we have any shore tiles to launch from
      const shore = Array.from(this.player.borderTiles()).filter((t) =>
        this.game.isShore(t),
      );
      if (shore.length === 0) {
        return;
      }

      const src = this.random.randElement(shore);

      // First look for high-interest targets (unowned or bot-owned). Mainly relevant for earlygame
      let dst = await this.findRandomBoatTarget(src, borderingEnemies, true);
      if (dst === null) {
        // None found? Then look for players
        dst = await this.findRandomBoatTarget(src, borderingEnemies, false);
        if (dst === null) {
          return;
        }
      }

      // src: game.addExecution(new TransportShipExecution(player, dst, troops)).
      const ctors = discoverCtors(getEventBus());
      // USER (winFixes): EVERY boat we send is a CHEAP 1% probe, never a big invasion
      // force. The faithful random boat sends troops/5 (20%) — which the user kept
      // seeing as "boats with lots of troops". Cap it at boatProbeFrac (minimum 1%).
      // There is deliberately no absolute troop floor: the interface minimum is a
      // percentage, so a small early army must be allowed to send a small probe.
      // (winFixes off → faithful troops/5.)
      const troops = state.settings.winFixes
        ? this.getEarlyGameProbeTroops(state.settings.boatProbeFrac)
        : this.player.troops() / 5;
      if (troops < 1) return;
      if (!(await this.allowEarlyGameBoat(dst))) return;
      if (ctors.boat && emitIntent(ctors.boat, dst, troops)) {
        state.stats.attacks++;
        setLastAction(tr("⛵ Random boat"), "naval");
      }
      return;
    }

    // ── WIN-FIX: opportunistic amphibious landings (NOT in src) ────────────────
    // The user's strategy: send a CHEAP probe boat (boatProbeFrac of troops) at a
    // weak / freshly-MIRV'd overseas nation. If a warship sinks it mid-sea we only
    // lose ~1% of troops; if it LANDS (we own a tile near the drop) we immediately
    // pour a bigger surge force into the beachhead. Throttled so it never spams the
    // worker, and EXEMPT from the dominance guard (it targets specific weak/crater
    // tiles across water, not random soon-conquered land), so a dominating bot keeps
    // expanding overseas instead of stalling. Returns true if a boat was emitted.
    async maybeOpportunisticBoat() {
      if (this.player === null) return false;
      // Honour the panel's "boat" feature toggle (maybeAttack runs under
      // expand||boat, so without this the toggle would not actually stop boats).
      if (!(state.settings.features && state.settings.features.boat)) return false;
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return false;
      // Keep up to maxConcurrentBoats in flight at all times (capped by the game's own
      // boat limit). Only relaunch when below the cap → continuous pressure, never idle.
      const boatCap = Math.min(
        this.game.config().boatMaxNumber(),
        state.settings.maxConcurrentBoats || 3,
      );
      const ships = this.player.unitCount(UNIT.TransportShip);
      const nowMs = performance.now();
      const throttle = state.settings.oppBoatThrottleMs || 1200;
      const sinceLast = nowMs - (state.lastOppBoatMs || 0);
      const capped = ships >= boatCap;
      const throttled = sinceLast < throttle;

      // Land-army fill. SURGES and CONTESTED landings spend OVERFLOW only (fill ≥
      // boatSurplusFill) so they never bleed the defensive army; grabbing the nearest
      // FREE island or a CLEARLY-WEAKER nation's coast is low-risk, so that path fires
      // at a much lower fill (boatIslandFill) to keep expansion going while we grow.
      const maxT = this.game.config().maxTroops(this.player);
      const fill = maxT > 0 ? this.player.troops() / maxT : 1;
      const surplusFill = state.settings.boatSurplusFill || 0.75;

      const shore = Array.from(this.player.borderTiles()).filter((t) =>
        this.game.isShore(t),
      );
      // DIAG (throttled ~5s): logs the EXACT reason a landing does/doesn't fire,
      // computed BEFORE any early-return so the cap/throttle stalls are visible too.
      // Read `reason` first when the user reports "boat stopped":
      //   capped    → boatCap boats already in flight (long far-voyages tie up the cap)
      //   throttled → just launched, waiting out the per-boat cooldown
      //   no-shore  → we hold no coastal tile to launch from
      //   ok        → no gate blocks; a target search runs this tick (watch for the
      //               follow-up "no reachable target" / "fill too low" / "REFUSED").
      try {
        if (nowMs - (state._boatDiagAt || 0) > 5000) {
          state._boatDiagAt = nowMs;
          console.log("[Boat] diag:", {
            reason: capped
              ? "capped"
              : throttled
                ? "throttled"
                : shore.length === 0
                  ? "no-shore"
                  : "ok",
            ships,
            boatCap,
            shoreTiles: shore.length,
            fill: Number(fill.toFixed(2)),
            islandFill: state.settings.boatIslandFill || 0.35,
            maxShips: this.game.config().boatMaxNumber(),
          });
        }
      } catch (_e) {
        /* ignore */
      }

      if (capped) return false;
      if (throttled) return false;
      if (shore.length === 0) return false;

      // ── SURGE: an active beachhead that has LANDED → pour a bigger force in ──
      const bh = state.beachhead;
      const windowTicks = state.settings.mirvBoatWindowTicks || 150;
      if (
        bh &&
        bh.tile != null &&
        fill >= surplusFill &&
        this.game.ticks() - (bh.at || 0) < windowTicks
      ) {
        if (this.landingSucceeded(bh.tile)) {
          const spawn = await withTimeout(
            this.player.bestTransportShipSpawn(bh.tile),
            WORKER_TIMEOUT_MS,
            false,
          );
          if (spawn !== false) {
            // The INITIAL probe crossed the sea at a SAFE 1% (a warship can only sink 1%).
            // Now it has LANDED and we hold the beachhead → the route is PROVEN, so pour a
            // BIG surge in (boatSurgeFrac = 25% of troops) to CONQUER outward from it. This
            // is the user's "gửi 1% an toàn khi di chuyển, tăng nhiều quân khi đã cập bến".
            // Still gated by fill ≥ surplusFill below, so it never drains home defence.
            const frac = state.settings.boatSurgeFrac || 0.25;
            const troops = this.player.troops() * frac;
            if (
              (await this.allowEarlyGameBoat(bh.tile)) &&
              this.emitBoat(bh.tile, troops, "⚓ Surge landing")
            ) {
              state.lastOppBoatMs = nowMs;
              bh.at = this.game.ticks(); // refresh the surge window
              bh.surged = true;
              return true;
            }
          }
        }
        // still in transit (not landed yet) → let the window expire naturally.
      }

      // ── PROBE target priority ──
      //  (1) NEAREST unowned island OR clearly-weaker nation's coast (closest first)
      //  (2) freshly-MIRV'd crater   (3) faithful random high-interest scan
      // `lowFillOk` = the target came from the strength-filtered nearest sweep, so it
      // is free / weaker → grabbable at the low island fill; the other two paths are
      // not strength-filtered, so they require the conservative surplus fill.
      // SPREAD (user): never pile multiple 1% probes onto ONE spot — with only ~3 boats
      // out at a time, each should hunt a DIFFERENT opportunity. Collect the tiles our
      // in-flight transport ships are already heading to; every probe finder below skips
      // a target within boatSpreadRadius of one of these, so the 3 boats fan out. (The
      // SURGE above is exempt — it deliberately concentrates on the landed beachhead.)
      this._inflightBoatTargets = [];
      for (const u of this.player.units(UNIT.TransportShip)) {
        try {
          const tt = u.targetTile ? u.targetTile() : null;
          if (tt != null) {
            this._inflightBoatTargets.push({
              x: this.game.x(tt),
              y: this.game.y(tt),
            });
          }
        } catch (_e) {
          /* skip */
        }
      }

      let dst = null;
      let lowFillOk = false;
      let dstOwned = false;
      let dstFallout = false;

      // PRIORITY #1 (user): boat over to a DISCONNECTED player's land — including FAR
      // disconnected ALLIES (their "zzz" land is undefended and free to take over). They
      // are non-friendly while disconnected, so the game lets us land on them.
      if (dst === null) {
        const disco = await this.findDisconnectedBoatTarget();
        if (disco !== null && !this.boatTargetTaken(disco)) {
          dst = disco;
          dstOwned = true;
          lowFillOk = true; // cheap 1% grab of free land → low fill gate
          console.log("[Boat] heading to a DISCONNECTED neighbour's land");
        }
      }

      const targets = dst === null ? this.scanNearbyTargets(shore) : [];
      const probeMax = state.settings.islandProbeMax || 4;
      for (let i = 0; i < targets.length && i < probeMax; i++) {
        if (this.boatTargetTaken(targets[i].tile)) continue; // a boat already heads here
        const sp = await withTimeout(
          this.player.bestTransportShipSpawn(targets[i].tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (sp !== false) {
          dst = targets[i].tile;
          dstOwned = targets[i].owned;
          dstFallout = targets[i].fallout;
          lowFillOk = true;
          break;
        }
      }

      if (dst === null) {
        const crater = this.pickMirvCraterTarget();
        if (crater !== null && !this.boatTargetTaken(crater)) {
          const sp = await withTimeout(
            this.player.bestTransportShipSpawn(crater),
            WORKER_TIMEOUT_MS,
            false,
          );
          if (sp !== false) {
            dst = crater;
            dstOwned = true;
          }
        }
      }
      if (dst === null) {
        const src = this.random.randElement(shore);
        const r = await this.findRandomBoatTarget(src, [], true);
        if (r !== null && !this.boatTargetTaken(r)) {
          dst = r;
          dstOwned = this.game.hasOwner(r);
        }
      }
      // Broaden the net so the bot always has SOMETHING to send (keeps 3 boats out):
      // any NON-FRIENDLY player's land reachable across water (harass weak enemies even
      // if they aren't unowned/bot land). findRandomBoatTarget(false) already skips
      // friendlies and (in FFA) stronger players, and probes reachability.
      if (dst === null) {
        const src2 = this.random.randElement(shore);
        const r2 = await this.findRandomBoatTarget(src2, [], false);
        if (r2 !== null && !this.boatTargetTaken(r2)) {
          dst = r2;
          dstOwned = this.game.hasOwner(r2);
        }
      }
      // FINAL FALLBACK (user: "boat must try every way to send 1% — even if surrounded
      // by teammates and the enemy is very far"): probe EVERY non-friendly enemy's
      // territory (nearest first) and boat to the first one reachable across water, even
      // a long voyage. A distant overseas enemy also resists the max-speed boat-to-self
      // staleness (we can't conquer it by land before the boat arrives).
      if (dst === null) {
        const far = await this.findDistantBoatTarget();
        if (far !== null) {
          dst = far;
          dstOwned = true;
          lowFillOk = true; // a cheap 1% probe → fire at the low fill gate
        }
      }
      if (dst === null) {
        // scanCandidates > 0 but none reachable ⇒ targets exist but are LAND-reachable
        // (no water between us and them) → the bot attacks them by foot, not by boat.
        // scanCandidates == 0 ⇒ no non-self land found near any sampled shore tile.
        console.log("[Boat] no reachable target", {
          scanCandidates: targets.length,
          shoreSamples: Math.min(
            state.settings.islandScanSamples || 6,
            shore.length,
          ),
          // From findDistantBoatTarget's last run: enemies seen, how many we probed
          // (probeCap caps it), how many probes timed out. enemies>probed ⇒ cap hit.
          distant: state._distantDiag || null,
        });
        return false;
      }

      const minFill = lowFillOk
        ? state.settings.boatIslandFill || 0.35
        : surplusFill;
      if (fill < minFill) {
        console.log("[Boat] fill too low to launch", {
          fill: Number(fill.toFixed(2)),
          need: minFill,
          contested: !lowFillOk,
        });
        return false;
      }

      const troops = this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
      if (troops < 1) return false;
      const label = dstFallout
        ? "☢️ Nuked-coast grab"
        : lowFillOk
          ? dstOwned
            ? "🏝️ Weak-coast grab"
            : "🏝️ Island grab"
          : "🛟 Probe landing";
      if (!(await this.allowEarlyGameBoat(dst))) return false;
      if (this.emitBoat(dst, troops, label)) {
        console.log("[Boat] LAUNCHED", label, Math.round(troops), "troops");
        state.lastOppBoatMs = nowMs;
        state.beachhead = { tile: dst, at: this.game.ticks(), surged: false };
        return true;
      }
      // Target FOUND but the boat intent was REFUSED (stale / already-conquered /
      // resolves-to-self target — common at MAX game speed when the probe result
      // goes stale before we emit). Silent until now; this is the invisible stall
      // that looks like "bot stopped sending boats even though enemies exist".
      console.log("[Boat] emitBoat REFUSED", label, {
        dstX: this.game.x(dst),
        dstY: this.game.y(dst),
        owner: this.game.hasOwner(dst) ? this.game.ownerID(dst) : "TN",
      });
      return false;
    }

    // boatTargetTaken — true if one of our in-flight transport ships is ALREADY heading
    // to within boatSpreadRadius of `tile`. Lets the probe finders skip a spot another
    // boat already covers, so our (max ~3) boats fan out to DIFFERENT opportunities
    // instead of piling onto one. _inflightBoatTargets is rebuilt each maybeOpportunisticBoat
    // pass; if it's missing (helper called out of context) we answer false (don't block).
    boatTargetTaken(tile) {
      if (tile == null || !Array.isArray(this._inflightBoatTargets)) return false;
      if (this._inflightBoatTargets.length === 0) return false;
      const r = state.settings.boatSpreadRadius || 30;
      let tx;
      let ty;
      try {
        tx = this.game.x(tile);
        ty = this.game.y(tile);
      } catch (_e) {
        return false;
      }
      for (const p of this._inflightBoatTargets) {
        if (Math.abs(p.x - tx) + Math.abs(p.y - ty) <= r) return true;
      }
      return false;
    }

    // scanNearbyTargets — sweep for the NEAREST boat-grabbable tiles, closest first:
    // unowned (TerraNullius) islands, NUKED/FALLOUT coastal land (empty after a blast),
    // AND coastal land owned by a CLEARLY-WEAKER nation (troops < ours × boatWeakTroopFrac).
    // Samples a few shore launch points and scans a bounded box around each; skips our
    // own land, friendlies, stronger nations, and CLEAN unowned TN that already borders
    // us (grabbed overland, not by boat — nuked TN is kept since overland troops die in it).
    // Returns [{tile, owned, fallout}] sorted by squared distance to the launch point.
    scanNearbyTargets(shore) {
      const R = state.settings.islandScanRadius || 40;
      const STEP = state.settings.islandScanStep || 2;
      const SAMPLES = state.settings.islandScanSamples || 6;
      const weakFrac = state.settings.boatWeakTroopFrac ?? 0.6;
      const mySid = this.player.smallID();
      const myTroops = this.player.troops();
      const weakCache = new Map(); // smallID -> grabbable (weaker, non-friendly)
      const seen = new Set();
      const out = [];
      const n = Math.min(SAMPLES, shore.length);
      for (let s = 0; s < n; s++) {
        const st = this.random.randElement(shore);
        const sx = this.game.x(st);
        const sy = this.game.y(st);
        for (let dx = -R; dx <= R; dx += STEP) {
          for (let dy = -R; dy <= R; dy += STEP) {
            const nx = sx + dx;
            const ny = sy + dy;
            if (!this.game.isValidCoord(nx, ny)) continue;
            const t = this.game.ref(nx, ny);
            if (seen.has(t)) continue;
            if (!this.game.isLand(t)) continue;
            // USER WIN-FIX: do NOT skip fallout. A freshly-MIRV'd / nuked coastal zone
            // is prime grab turf — the blast wipes the owner, leaving empty land that a
            // probe boat can claim as the radiation clears (exactly like the MIRV-crater
            // path). We TAG fallout tiles so the launcher can label/prioritise them.
            const fallout = this.game.hasFallout(t);
            const oid = this.game.ownerID(t);
            if (oid === mySid) continue; // already ours
            const owned = this.game.hasOwner(t);
            if (owned) {
              // Owned coast — grab only a clearly-weaker, non-friendly nation.
              let grab = weakCache.get(oid);
              if (grab === undefined) {
                const o = this.game.playerBySmallID(oid);
                grab = !!(
                  o &&
                  o.isPlayer() &&
                  this.player.isFriendly(o) === false &&
                  o.troops() < myTroops * weakFrac
                );
                weakCache.set(oid, grab);
              }
              if (!grab) continue;
            } else if (!fallout) {
              // Clean unowned TN bordering our own land is grabbed overland — skip here.
              // A NUKED unowned tile is KEPT even when it borders us: overland troops
              // would just bleed out in the fallout, so a boat is the right tool for it.
              if (
                this.game
                  .neighbors(t)
                  .some((nb) => this.game.ownerID(nb) === mySid)
              ) {
                continue;
              }
            }
            seen.add(t);
            out.push({ tile: t, dist: dx * dx + dy * dy, owned, fallout });
          }
        }
      }
      out.sort((a, b) => a.dist - b.dist);
      return out;
    }

    // findDisconnectedBoatTarget — like findDistantBoatTarget but ONLY disconnected
    // players (allies or enemies showing the "zzz" icon), nearest first. Their land is
    // undefended, so this lets the bot boat over — even far across water — to take over
    // a disconnected teammate's territory.
    async findDisconnectedBoatTarget() {
      if (this.player === null) return null;
      const mySid = this.player.smallID();
      const myCenter = this.getPlayerCenter(this.player);
      const cands = [];
      for (const e of this.game.players()) {
        try {
          if (!e.isPlayer || !e.isPlayer()) continue;
          if (!e.isAlive()) continue;
          if (e.smallID() === mySid) continue;
          if (!(e.isDisconnected && e.isDisconnected())) continue; // ONLY "zzz" players
          const loc = e.nameLocation ? e.nameLocation() : null;
          if (!loc || loc.x == null) continue;
          if (!this.game.isValidCoord(loc.x, loc.y)) continue;
          const tile = this.game.ref(loc.x, loc.y);
          if (tile == null) continue;
          let dist = 0;
          if (myCenter && myCenter.x != null) {
            const dx = loc.x - myCenter.x;
            const dy = loc.y - myCenter.y;
            dist = dx * dx + dy * dy;
          }
          cands.push({ tile, dist });
        } catch (_e) {
          /* skip this player */
        }
      }
      cands.sort((a, b) => a.dist - b.dist); // nearest disconnected first
      const cap = state.settings.distantBoatProbeMax || 12;
      for (let i = 0; i < cands.length && i < cap; i++) {
        if (this.boatTargetTaken(cands[i].tile)) continue; // a boat already heads here
        const sp = await withTimeout(
          this.player.bestTransportShipSpawn(cands[i].tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (sp !== false) return cands[i].tile;
      }
      return null;
    }

    // findDistantBoatTarget — probe EVERY alive non-friendly enemy's territory (a tile
    // at their name location ≈ centroid), nearest first, and return the first one
    // reachable across water. Lets the bot lead a 1% boat on a long voyage to a far
    // enemy even when it's hemmed in by teammates with no nearby coastal target.
    async findDistantBoatTarget() {
      if (this.player === null) return null;
      const mySid = this.player.smallID();
      const myCenter = this.getPlayerCenter(this.player);
      const cands = [];
      for (const e of this.game.players()) {
        try {
          if (!e.isPlayer || !e.isPlayer()) continue;
          if (!e.isAlive()) continue;
          if (e.smallID() === mySid) continue;
          if (this.player.isFriendly(e) === true) continue;
          const loc = e.nameLocation ? e.nameLocation() : null;
          if (!loc || loc.x == null) continue;
          if (!this.game.isValidCoord(loc.x, loc.y)) continue;
          const tile = this.game.ref(loc.x, loc.y);
          if (tile == null) continue;
          let dist = 0;
          if (myCenter && myCenter.x != null) {
            const dx = loc.x - myCenter.x;
            const dy = loc.y - myCenter.y;
            dist = dx * dx + dy * dy;
          }
          cands.push({ tile, dist });
        } catch (_e) {
          /* skip this player */
        }
      }
      cands.sort((a, b) => a.dist - b.dist); // nearest enemy first = shortest voyage
      const cap = state.settings.distantBoatProbeMax || 12;
      // Sentinel default lets us tell a TIMED-OUT probe (worker saturated at MAX
      // game speed) apart from a genuine `false` (enemy not reachable across water,
      // i.e. land-connected). Without this, both look identical and we can't tell
      // "stopped because of max-speed timeouts" from "stopped because all nearby
      // enemies are land-connected and the far sea-separated ones are past the cap".
      const TIMEOUT = "__probe_timeout__";
      let probed = 0;
      let timedOut = 0;
      for (let i = 0; i < cands.length && i < cap; i++) {
        if (this.boatTargetTaken(cands[i].tile)) continue; // a boat already heads here
        probed++;
        const sp = await withTimeout(
          this.player.bestTransportShipSpawn(cands[i].tile),
          WORKER_TIMEOUT_MS,
          TIMEOUT,
        );
        if (sp === TIMEOUT) {
          timedOut++;
          continue;
        }
        if (sp !== false) {
          state._distantDiag = {
            enemies: cands.length,
            probed,
            probeCap: cap,
            timedOut,
            found: true,
          };
          return cands[i].tile;
        }
      }
      // Exhausted the cap (or all enemies) with no water-reachable target. Stash the
      // counts so the "no reachable target" log can say WHY: enemies>probeCap with
      // found=false ⇒ raise distantBoatProbeMax (far sea enemies past the cap);
      // timedOut>0 ⇒ max-speed worker saturation, not a routing problem.
      state._distantDiag = {
        enemies: cands.length,
        probed,
        probeCap: cap,
        timedOut,
        found: false,
      };
      return null;
    }

    // emitBoat — fire a TransportShipExecution at dst carrying `troops`.
    emitBoat(dst, troops, label) {
      // Final chokepoint for the "boat" feature toggle: never fire when off.
      if (!(state.settings.features && state.settings.features.boat)) {
        return false;
      }
      const requestedTroops = Number(troops);
      if (!Number.isFinite(requestedTroops) || requestedTroops < 1) {
        return false;
      }
      const safeTroops = state.settings.winFixes
        ? Math.min(requestedTroops, this.getEarlyGameSpendableTroops())
        : requestedTroops;
      if (safeTroops < 1) return false;
      const ctors = discoverCtors(getEventBus());
      if (ctors.boat && emitIntent(ctors.boat, dst, safeTroops)) {
        state.stats.attacks++;
        setLastAction(tr(label), "naval");
        return true;
      }
      return false;
    }

    // landingSucceeded — did a probe boat establish a foothold? True if we own any
    // land tile within a small box around the drop point (cheap sync scan, no worker).
    landingSucceeded(tile) {
      const cx = this.game.x(tile);
      const cy = this.game.y(tile);
      const mySid = this.player.smallID();
      const R = 6;
      for (let dx = -R; dx <= R; dx += 2) {
        for (let dy = -R; dy <= R; dy += 2) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.game.isValidCoord(nx, ny)) continue;
          const t = this.game.ref(nx, ny);
          if (this.game.isLand(t) && this.game.ownerID(t) === mySid) return true;
        }
      }
      return false;
    }

    // pickMirvCraterTarget — the freshest MIRV crater we don't already own. Prunes
    // craters older than the boat window. Returns a TileRef or null.
    pickMirvCraterTarget() {
      const hits = Array.isArray(state.recentMirvHits) ? state.recentMirvHits : [];
      const windowTicks = state.settings.mirvBoatWindowTicks || 150;
      const now = this.game.ticks();
      state.recentMirvHits = hits.filter((h) => now - (h.at || 0) < windowTicks);
      const mySid = this.player.smallID();
      for (let i = state.recentMirvHits.length - 1; i >= 0; i--) {
        const h = state.recentMirvHits[i];
        if (h.tile == null) continue;
        // Skip craters we already conquered (no point boating our own land).
        if (this.game.ownerID(h.tile) === mySid) continue;
        return h.tile;
      }
      return null;
    }

    // findRandomBoatTarget — AiAttackBehavior (private, now async).
    //
    // DIVERGENCE (boat rank/collect-then-probe, PORT-CONTRACT §Async #2): src runs
    // up to 500 RNG iterations, and at each candidate that passes the cheap sync
    // criteria it calls the SYNC `canBuildTransportShip(...)` and returns the FIRST
    // that succeeds. The client probe (`bestTransportShipSpawn`) is an async worker
    // call, so we cannot afford 500 of them. We keep the SAME 500-iter RNG scan with
    // the SAME cheap sync criteria (incl. the unreachablePlayers memo) to COLLECT up
    // to BOAT_PROBE_CANDIDATES tiles in the src's selection order, THEN `await
    // bestTransportShipSpawn` down that short list and return the FIRST reachable —
    // the same target src would have chosen, with bounded worker calls. The probe is
    // a GATE only; the returned value is the original `randTile`.
    async findRandomBoatTarget(tile, borderingEnemies, highInterestOnly = false) {
      if (this.player === null) throw new Error("not initialized");
      const x = this.game.x(tile);
      const y = this.game.y(tile);
      const unreachablePlayers = new Set();
      const candidates = [];
      for (let i = 0; i < 500; i++) {
        const randX = this.random.nextInt(x - 150, x + 150);
        const randY = this.random.nextInt(y - 150, y + 150);
        if (!this.game.isValidCoord(randX, randY)) {
          continue;
        }
        const randTile = this.game.ref(randX, randY);
        if (!this.game.isLand(randTile)) {
          continue;
        }
        const owner = this.game.owner(randTile);
        // src: `owner === this.player` (identity) → smallID compare; TN has no smallID-match.
        if (owner.isPlayer() && owner.smallID() === this.player.smallID()) {
          continue;
        }
        // Skip players we already know are unreachable (Performance optimization)
        if (owner.isPlayer() && unreachablePlayers.has(owner.id())) {
          continue;
        }
        // Don't send boats to players with which we share a border, that usually looks stupid
        if (
          owner.isPlayer() &&
          borderingEnemies.some((e) => e.smallID() === owner.smallID())
        ) {
          continue;
        }
        // Don't spam boats into players which are stronger than us (FFA only)
        if (
          this.isFFA() &&
          owner.isPlayer() &&
          owner.troops() > this.player.troops()
        ) {
          continue;
        }

        let matchesCriteria;
        if (highInterestOnly) {
          // High-interest targeting: prioritize unowned tiles or tiles owned by bots
          matchesCriteria = !owner.isPlayer() || owner.type() === PlayerType.Bot;
        } else {
          // Normal targeting: return unowned tiles or tiles owned by non-friendly players
          matchesCriteria = !owner.isPlayer() || !owner.isFriendly(this.player);
        }
        if (!matchesCriteria) {
          continue;
        }

        // DIVERGENCE: src would here call canBuildTransportShip synchronously and
        // return on success (or memo the player unreachable on failure). We instead
        // COLLECT this passing tile (in src order) and defer the async reachability
        // probe to after the scan, so the worker calls are bounded. We cannot do the
        // per-player unreachable memo inside the loop (it depends on the probe), so
        // memoization of unreachable players is best-effort over the probe phase.
        candidates.push({ tile: randTile, owner });
        if (candidates.length >= BOAT_PROBE_CANDIDATES) {
          break;
        }
      }

      // Probe the collected candidates in src selection order; first reachable wins.
      for (const cand of candidates) {
        if (cand.owner.isPlayer() && unreachablePlayers.has(cand.owner.id())) {
          continue;
        }
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(cand.tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn === false) {
          if (cand.owner.isPlayer()) {
            unreachablePlayers.add(cand.owner.id());
          }
          continue;
        }
        return cand.tile;
      }
      return null;
    }

    // attackBestTarget is called with borderingFriends sorted by troops and
    // borderingEnemies sorted by Defense Post-aware attack difficulty.
    async attackBestTarget(borderingFriends, borderingEnemies) {
      // In games with high starting gold, nations will quickly build a lot of cities
      // This causes them to expand slowly (cities increase max troops), and bots will steal their structures
      // In this case: Attack bots before ratio checks
      if (this.hasNeighboringBotWithStructures()) {
        if (await this.attackBots()) return;
      }

      // Save up troops until we reach the reserve ratio
      if (!this.hasReserveRatioTroops()) return;

      // Maybe save up troops until we reach the trigger ratio
      if (!this.hasTriggerRatioTroops() && !this.random.chance(10)) return;

      // Get attack strategies in priority order based on difficulty
      const strategies = this.getAttackStrategies(
        borderingFriends,
        borderingEnemies,
      );

      for (const strategy of strategies) {
        if (await strategy()) return;
      }
    }

    // getAttackStrategies — AiAttackBehavior (private). The strategy predicates
    // become async (they reach sendAttack → the async boat probes). The four
    // difficulty-ordered arrays are VERBATIM from src.
    getAttackStrategies(borderingFriends, borderingEnemies) {
      // src: `const { difficulty } = this.game.config().gameConfig();` → REPLICATED.
      const difficulty = currentDifficulty();

      // Define all strategies as functions that return true if they attacked
      const retaliate = async () => {
        const attacker = this.findIncomingAttackPlayer();
        if (attacker) {
          return await this.sendAttack(attacker, true);
        }
        return false;
      };

      const bots = async () => await this.attackBots();

      const assist = async () => await this.assistAllies();

      const traitor = async () => {
        const traitor = this.findTraitor(borderingEnemies);
        if (traitor) {
          return await this.sendAttack(traitor);
        }
        return false;
      };

      const afk = async () => {
        // borderingEnemies is already sorted by attack difficulty, so first match is weakest afk enemy
        const afk = borderingEnemies.find(
          (enemy) =>
            enemy.isDisconnected() &&
            (!this.isFFA() || enemy.troops() < this.player.troops() * 3),
        );
        if (afk) {
          return await this.sendAttack(afk);
        }
        return false;
      };

      const betray = async () =>
        await this.maybeBetrayAndAttack(borderingFriends, borderingEnemies);

      const nuked = async () => {
        if (this.isBorderingNukedTerritory()) {
          return await this.sendAttack(this.game.terraNullius());
        }
        return false;
      };

      const victim = async () => {
        const victim = this.findVictim(borderingEnemies);
        if (victim) {
          return await this.sendAttack(victim);
        }
        return false;
      };

      const hated = async () => {
        for (const relation of this.player.allRelationsSorted()) {
          if (relation.relation !== Relation.Hostile) continue;
          const other = relation.player;
          if (this.player.isFriendly(other)) continue;
          if (this.isFFA() && other.troops() > this.player.troops() * 3) continue;
          return await this.sendAttack(other);
        }
        return false;
      };

      const veryWeak = async () => {
        const veryWeak = this.findVeryWeakEnemy(borderingEnemies);
        if (veryWeak) {
          return await this.sendAttack(veryWeak);
        }
        return false;
      };

      const weakest = async () => {
        if (borderingEnemies.length > 0) {
          // borderingEnemies is already sorted by attack difficulty, so first match is weakest
          const weakest = borderingEnemies[0];
          // In FFA, don't attack if they have more troops than us
          if (!this.isFFA() || weakest.troops() < this.player.troops()) {
            return await this.sendAttack(weakest);
          }
        }
        return false;
      };

      const island = async () => {
        if (borderingEnemies.length === 0) {
          const enemy = await this.findNearestIslandEnemy();
          if (enemy) {
            return await this.sendAttack(enemy);
          }
        }
        return false;
      };

      const donate = async () => await this.donateTroops();

      // Return strategies in order based on difficulty
      // Easy nations get the dumbest order, impossible nations get the smartest order
      let order;
      switch (difficulty) {
        case Difficulty.Easy:
          // prettier-ignore
          order = [nuked, bots, retaliate, assist, betray, hated, weakest];
          break;
        case Difficulty.Medium:
          // prettier-ignore
          order = [bots, nuked, retaliate, assist, betray, hated, afk, traitor, weakest, island, donate];
          break;
        case Difficulty.Hard:
          // prettier-ignore
          order = [bots, retaliate, assist, betray, nuked, traitor, afk, hated, veryWeak, victim, weakest, island, donate];
          break;
        case Difficulty.Impossible:
          // prettier-ignore
          order = [retaliate, bots, veryWeak, assist, traitor, afk, betray, victim, nuked, hated, weakest, island, donate];
          break;
        case Difficulty.Legendary:
          // Legendary keeps the aggressive Impossible order; construction
          // planning is the only intentionally new adaptive branch.
          // prettier-ignore
          order = [retaliate, bots, veryWeak, assist, traitor, afk, betray, victim, nuked, hated, weakest, island, donate];
          break;
        default:
          // src: assertNever(difficulty). currentDifficulty() defaults to Impossible
          // so this is unreachable; keep an explicit throw for parity.
          throw new Error("unreachable difficulty: " + difficulty);
      }

      // USER WIN-FIX (NOT in src): DEPRIORITISE grabbing radioactive (nuked) TerraNullius.
      // The faithful order runs `nuked` (grab fallout TN bordering us) BEFORE attacking
      // adjacent ENEMIES (hated/weakest). The user wants bordering enemies dealt with
      // FIRST, then mop up the radioactive craters — so move `nuked` to just AFTER
      // `weakest` (the last bordering-enemy strategy). winFixes off → exact faithful order.
      if (state.settings.winFixes) {
        const ni = order.indexOf(nuked);
        if (ni !== -1) {
          order.splice(ni, 1);
          const wi = order.indexOf(weakest);
          if (wi !== -1) order.splice(wi + 1, 0, nuked);
          else order.push(nuked);
        }
      }
      return order;
    }

    // hasNeighboringBotWithStructures — AiAttackBehavior (private).
    hasNeighboringBotWithStructures() {
      return this.player
        .nearby()
        .some(
          (n) =>
            n.isPlayer() &&
            n.type() === PlayerType.Bot &&
            !this.player.isFriendly(n) &&
            n.units().some((u) => AttackStructures.has(u.type())),
        );
    }

    // hasReserveRatioTroops — AiAttackBehavior (private).
    hasReserveRatioTroops() {
      const maxTroops = this.game.config().maxTroops(this.player);
      const ratio = this.player.troops() / maxTroops;
      return ratio >= this.effectiveReserveRatio();
    }

    // WIN-FIX (opening expansion planner) — keep the high-value early-game
    // decisions in one small, observable policy. It deliberately uses the
    // live frontier and troop curve rather than a fixed "send 60% every time"
    // rule: empty land is cheap, a tribe needs a complete capture force, and a
    // second attack must not be launched while the first expansion is still in
    // flight.
    getEarlyGameFrontierProfile() {
      const tick = this.currentAttackDecisionTick();
      if (
        this.earlyGameFrontierCache &&
        this.earlyGameFrontierCacheTick === tick
      ) {
        return this.earlyGameFrontierCache;
      }
      const frontier = new Set();
      const meSid = this.player?.smallID?.();
      const maxTiles = 256;
      try {
        for (const borderTile of this.player.borderTiles?.() || []) {
          for (const tile of this.game.neighbors(borderTile) || []) {
            if (frontier.size >= maxTiles) break;
            if (!this.game.isLand(tile)) continue;
            if (this.game.hasOwner(tile)) continue;
            if (this.game.hasFallout?.(tile)) continue;
            if (this.game.ownerID(tile) === meSid) continue;
            frontier.add(tile);
          }
          if (frontier.size >= maxTiles) break;
        }
      } catch (_error) {
        /* an older adapter may not expose the complete frontier */
      }

      let magnitudeTotal = 0;
      let magnitudeCount = 0;
      let contestedTileCount = 0;
      const competingOwners = new Set();
      for (const tile of frontier) {
        let magnitude = 10;
        try {
          magnitude = Number(this.game.magnitude?.(tile));
        } catch (_error) {
          magnitude = 10;
        }
        if (!Number.isFinite(magnitude)) magnitude = 10;
        magnitudeTotal += magnitude;
        magnitudeCount += 1;
        try {
          let contested = false;
          for (const neighbor of this.game.neighbors(tile) || []) {
            const ownerID = this.game.ownerID(neighbor);
            if (
              ownerID == null ||
              ownerID === 0 ||
              ownerID === meSid
            ) {
              continue;
            }
            contested = true;
            competingOwners.add(ownerID);
          }
          if (contested) contestedTileCount += 1;
        } catch (_error) {
          /* competition is optional; terrain remains usable */
        }
      }
      const averageMagnitude =
        magnitudeCount > 0 ? magnitudeTotal / magnitudeCount : 10;
      const terrainScore = Math.max(
        0,
        Math.min(1, 1 - (averageMagnitude - 1) / 30),
      );
      const competitionScore = frontier.size > 0
        ? Math.max(0, Math.min(1, contestedTileCount / frontier.size))
        : 0;
      const opportunityUrgency = Math.max(
        0,
        Math.min(
          1,
          competitionScore * 0.8 +
            Math.min(1, competingOwners.size / 2) * 0.2,
        ),
      );
      const profile = {
        freeTileCount: frontier.size,
        averageMagnitude,
        terrainScore,
        contestedTileCount,
        competingOwnerCount: competingOwners.size,
        competitionScore,
        opportunityUrgency,
        // A single attack typically opens several adjacent tiles. Keep this
        // bounded because it is only a loss estimate, not a map simulation.
        expectedTiles: frontier.size > 0
          ? Math.max(3, Math.min(12, Math.round(Math.sqrt(frontier.size) * 1.75)))
          : 1,
      };
      this.earlyGameFrontierCacheTick = tick;
      this.earlyGameFrontierCache = profile;
      return profile;
    }

    getActiveExpansionAttackTroops(target = undefined) {
      let attacks = [];
      try {
        attacks = this.player.outgoingAttacks?.() || [];
      } catch (_error) {
        attacks = [];
      }
      let total = 0;
      const filterByTarget = target !== undefined;
      const targetIsPlayer = target?.isPlayer?.() === true;
      const targetSid = targetIsPlayer ? target.smallID?.() : null;
      for (const attack of attacks) {
        try {
          if (attack.retreating?.()) continue;
          const attackTarget = attack.target?.();
          const attackTargetIsPlayer = attackTarget?.isPlayer?.() === true;
          if (filterByTarget) {
            if (targetIsPlayer) {
              if (
                !attackTargetIsPlayer ||
                attackTarget.smallID?.() !== targetSid
              ) {
                continue;
              }
            } else if (attackTargetIsPlayer) {
              continue;
            }
          }
          total += Math.max(0, Number(attack.troops?.() || 0));
        } catch (_error) {
          /* malformed/expired attack snapshots are ignored */
        }
      }
      return total;
    }

    getActiveBotAttackTroops(target = undefined) {
      let attacks = [];
      try {
        attacks = this.player.outgoingAttacks?.() || [];
      } catch (_error) {
        attacks = [];
      }
      let total = 0;
      const filterByTarget = target !== undefined;
      const targetKey = filterByTarget
        ? this.getBotAttackTargetKey(target)
        : null;
      for (const attack of attacks) {
        try {
          if (attack.retreating?.()) continue;
          const attackTarget = attack.target?.();
          if (
            !attackTarget?.isPlayer?.() ||
            attackTarget.type?.() !== PlayerType.Bot
          ) {
            continue;
          }
          if (
            filterByTarget &&
            this.getBotAttackTargetKey(attackTarget) !== targetKey
          ) {
            continue;
          }
          total += Math.max(0, Number(attack.troops?.() || 0));
        } catch (_error) {
          /* malformed/expired attack snapshots are ignored */
        }
      }
      return total;
    }

    getBotAttackRequirement(
      target,
      defensePostProfile = null,
      earlyGameCandidate = null,
    ) {
      const required = this.getBotCaptureTroopsFloor(
        target,
        defensePostProfile,
        earlyGameCandidate,
      );
      const targetKey = this.getBotAttackTargetKey(target);
      const activeNow = this.getActiveBotAttackTroops(target);
      if (!this.botAttackActiveBaselineByTarget.has(targetKey)) {
        this.botAttackActiveBaselineByTarget.set(targetKey, activeNow);
      }
      const activeBaseline = this.botAttackActiveBaselineByTarget.get(targetKey);
      const active = Math.max(
        activeNow,
        activeBaseline + this.getBotAttackTroopsSentForTarget(target),
      );
      return {
        required,
        active,
        remaining: Number.isFinite(required)
          ? Math.max(0, required - active)
          : Number.POSITIVE_INFINITY,
      };
    }

    getEarlyGameGenerationMultiplier() {
      // The custom bot is a Human player, so the formula helper is already
      // exact. If a future adapter exposes the live Config method, use its
      // result to preserve lobby-specific modifiers without making it required.
      try {
        const config = this.game.config?.();
        if (typeof config?.troopIncreaseRate !== "function") return 1;
        const maximum = Math.max(1, Number(config.maxTroops(this.player)) || 0);
        const current = Math.max(0, Number(this.player.troops()) || 0);
        const formulaRate = calculateTroopGenerationRate({
          troops: current,
          maxTroops: maximum,
        });
        const liveRate = Number(config.troopIncreaseRate(this.player));
        if (formulaRate > 0 && Number.isFinite(liveRate) && liveRate >= 0) {
          return Math.max(0, Math.min(4, liveRate / formulaRate));
        }
      } catch (_error) {
        /* use the exact default Human curve */
      }
      return 1;
    }

    getEarlyGameExpansionPlan({
      targetType = "land",
      target = null,
      candidate = null,
      urgent = false,
      opportunityUrgency = null,
      initialBurst = false,
    } = {}) {
      const maximum = Math.max(
        1,
        Number(this.game.config().maxTroops(this.player)) || 0,
      );
      const own = Math.max(0, Number(this.player.troops()) || 0);
      const frontier = this.getEarlyGameFrontierProfile();
      const targetPlayer = target?.isPlayer?.() === true ? target : candidate?.player;
      let defenseMultiplier = 1;
      let defensePostProfile = null;
      if (targetPlayer?.isPlayer?.() === true) {
        defensePostProfile = this.getEnemyDefensePostAttackProfile(targetPlayer);
        defenseMultiplier = Math.max(
          1,
          Number(defensePostProfile?.attackCostMultiplier || 1),
        );
      }
      const targetTroops = targetPlayer?.isPlayer?.()
        ? Math.max(0, Number(targetPlayer.troops?.() || 0))
        : 0;
      const captureTroops =
        targetType === "tribe" && targetPlayer?.type?.() === PlayerType.Bot
          ? this.getBotCaptureTroopsFloor(
              targetPlayer,
              defensePostProfile,
              candidate,
            )
          : null;
      const pressure = Math.max(
        finiteEarlyGameSignal(candidate?.foodRaceValue),
        finiteEarlyGameSignal(candidate?.contestPressure),
      );
      const directRace =
        Number(candidate?.directAttackers || 0) > 0 ||
        Number(candidate?.incomingAttackers || 0) > 0;
      const frontierUrgency =
        opportunityUrgency == null
          ? frontier.opportunityUrgency
          : finiteEarlyGameSignal(opportunityUrgency);
      const plan = calculateEarlyGameExpansionPlan({
        ownTroops: own,
        maxTroops: maximum,
        generationMultiplier: this.getEarlyGameGenerationMultiplier(),
        targetType,
        targetTroops,
        captureTroops,
        targetDefenseMultiplier: defenseMultiplier,
        terrainMagnitude:
          Number(candidate?.terrainMagnitude) || frontier.averageMagnitude,
        expectedTiles:
          Number(candidate?.expectedTiles) || frontier.expectedTiles,
        baseReserveRatio: this.effectiveReserveRatio(),
        activeAttackTroops: this.getActiveExpansionAttackTroops(
          targetType === "tribe" ? targetPlayer : undefined,
        ),
        urgent: Boolean(urgent || directRace),
        opportunityUrgency: Math.max(
          frontierUrgency,
          pressure,
          directRace ? 1 : 0,
        ),
        contestPressure: pressure,
        competitorTroops: Number(candidate?.competitorTroops) || 0,
        initialBurst,
      });
      plan.frontierFreeTiles = frontier.freeTileCount;
      plan.frontierTerrainMagnitude = frontier.averageMagnitude;
      plan.frontierTerrainScore = frontier.terrainScore;
      plan.frontierContestedTileCount = frontier.contestedTileCount;
      plan.frontierCompetingOwnerCount = frontier.competingOwnerCount;
      plan.frontierCompetitionScore = frontier.competitionScore;
      plan.targetID = targetPlayer?.smallID?.() ?? null;
      return plan;
    }

    scheduleEarlyGameExpansion(plan, committed = false) {
      if (!state.earlyGame || !plan) return;
      const now = this.currentAttackDecisionTick();
      const delay = committed
        ? Math.max(
            2,
            Math.min(15, Number(plan.postCommitRecoveryTicks) || plan.nextDecisionTicks || 4),
          )
        : Math.max(2, Number(plan.nextDecisionTicks) || 4);
      state.earlyGame.expansionPlan = plan;
      state.earlyGame.troopGenerationRate = plan.generationRate;
      state.earlyGame.generationRatio = plan.generationRatio;
      state.earlyGame.optimalGenerationRatio = plan.optimalGenerationRatio;
      state.earlyGame.frontierFreeTiles = plan.frontierFreeTiles || 0;
      state.earlyGame.frontierTerrainMagnitude = plan.frontierTerrainMagnitude;
      state.earlyGame.frontierTerrainScore = plan.frontierTerrainScore;
      state.earlyGame.frontierContestedTileCount =
        plan.frontierContestedTileCount || 0;
      state.earlyGame.frontierCompetingOwnerCount =
        plan.frontierCompetingOwnerCount || 0;
      state.earlyGame.frontierCompetitionScore =
        plan.frontierCompetitionScore || 0;
      state.earlyGame.nextExpansionTick = now + delay;
    }

    // WIN-FIX (sizeReserve) — NOT in src. A size-aware reserve FLOOR: as the
    // empire grows, hold back more troops to keep the long borders defensible.
    // This breaks the over-expand → thin-border → get-pushed-back oscillation
    // that caps the pure faithful bot at ~16% (keeps fill high so conquests
    // stick). Gated by settings.winFixes (off → exactly this.reserveRatio = src).
    effectiveReserveRatio() {
      let r = this.reserveRatio;
      try {
        if (state.settings.winFixes) {
          const total = this.game.numLandTiles() || 1;
          const share = this.player.numTilesOwned() / total;
          const scale = state.settings.sizeReserveScale ?? 0;
          const cap = state.settings.sizeReserveCap ?? 0.6;
          r = Math.max(r, Math.min(cap, share * scale));
        }
      } catch (_e) {
        /* default to src reserveRatio */
      }
      return r;
    }

    // hasTriggerRatioTroops — AiAttackBehavior (private).
    hasTriggerRatioTroops() {
      const maxTroops = this.game.config().maxTroops(this.player);
      const ratio = this.player.troops() / maxTroops;
      return ratio >= this.triggerRatio;
    }

    // findIncomingAttackPlayer — AiAttackBehavior.
    findIncomingAttackPlayer() {
      let incomingAttacks = this.player
        .incomingAttacks()
        .filter((attack) => !this.player.isFriendly(attack.attacker()));
      // Ignore bot attacks if we are not a bot.
      if (this.player.type() !== PlayerType.Bot) {
        incomingAttacks = incomingAttacks.filter(
          (attack) => attack.attacker().type() !== PlayerType.Bot,
        );
      }
      let largestAttack = 0;
      let largestAttacker;
      for (const attack of incomingAttacks) {
        if (attack.troops() <= largestAttack) continue;
        largestAttack = attack.troops();
        largestAttacker = attack.attacker();
      }
      if (largestAttacker !== undefined) {
        return largestAttacker;
      }
      return null;
    }

    // Sort neighboring bots by density (troops / tiles) and attempt to attack many of them (Parallel attacks)
    // sendAttack will do nothing if we don't have enough reserve troops left
    // Bots that own structures are prioritized as targets (they might have stolen our structures and they will delete them!)
    // attackBots — AiAttackBehavior (private, now async: awaits sendAttack
    // sequentially so botAttackTroopsSent accumulates before the `> 0` return).
    async attackBots() {
      const bots = this.player
        .nearby()
        .filter(
          (n) =>
            n.isPlayer() &&
            this.player.isFriendly(n) === false &&
            n.type() === PlayerType.Bot,
        );

      if (bots.length === 0) {
        return false;
      }

      this.ensureBotAttackAccounting();

      const density = (p) => p.troops() / p.numTilesOwned();
      const ownsStructures = (p) =>
        p.units().some((u) => AttackStructures.has(u.type()));
      const attackDifficultyDensity = (p) => {
        const profile = this.getEnemyDefensePostAttackProfile(p);
        return (
          density(p) *
          Math.max(
            1,
            Number(profile.attackCostMultiplier || 1),
            Number(profile.speedMultiplier || 1),
          )
        );
      };
      const sortedBots = bots.slice().sort((a, b) => {
        const aHasStructures = ownsStructures(a);
        const bHasStructures = ownsStructures(b);
        if (aHasStructures !== bHasStructures) {
          return aHasStructures ? -1 : 1;
        }
        return attackDifficultyDensity(a) - attackDifficultyDensity(b);
      });
      const reducedBots = sortedBots.slice(0, this.getBotAttackMaxParallelism());

      for (const bot of reducedBots) {
        await this.sendAttack(bot);
      }

      // Only short-circuit the rest of the targeting pipeline if we actually
      // allocated some troops to bot attacks.
      return this.botAttackTroopsSent > 0;
    }

    // getBotAttackMaxParallelism — AiAttackBehavior (private).
    getBotAttackMaxParallelism() {
      // src: `const { difficulty } = this.game.config().gameConfig();` → REPLICATED.
      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
          return 1;
        case Difficulty.Medium:
          return this.random.chance(2) ? 1 : 2;
        case Difficulty.Hard:
          return 3;
        // On impossible difficulty, attack as much bots as possible in parallel
        case Difficulty.Impossible: {
          return 100;
        }
        case Difficulty.Legendary:
          return 100;
        default:
          throw new Error("unreachable difficulty: " + difficulty);
      }
    }

    // assistAllies — AiAttackBehavior (private, now async via sendAttack).
    async assistAllies() {
      if (this.emojiBehavior === undefined) throw new Error("not initialized");

      if (this.game.config().disableAlliances()) return false;

      for (const ally of this.player.allies()) {
        if (ally.targets().length === 0) continue;
        if (this.player.relation(ally) < Relation.Friendly) {
          this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_RELATION_TOO_LOW);
          continue;
        }
        for (const target of ally.targets()) {
          // src: `target === this.player` (identity) → smallID compare.
          if (
            target.isPlayer() &&
            target.smallID() === this.player.smallID()
          ) {
            this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_TARGET_ME);
            continue;
          }
          if (this.player.isFriendly(target)) {
            this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_TARGET_ALLY);
            continue;
          }
          if (!(await this.sendAttack(target))) continue;
          this.player.updateRelation(ally, -20);
          this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_ACCEPT);
          return true;
        }
      }
      return false;
    }

    // Find a traitor who isn't significantly stronger than us
    // findTraitor — AiAttackBehavior (private).
    findTraitor(borderingEnemies) {
      if (this.game.config().disableAlliances()) return null;

      // borderingEnemies is already sorted by attack difficulty, so first match is weakest traitor
      return (
        borderingEnemies.find(
          (enemy) =>
            enemy.isTraitor() &&
            (!this.isFFA() || enemy.troops() < this.player.troops() * 1.2),
        ) ?? null
      );
    }

    // maybeBetrayAndAttack — AiAttackBehavior (private, now async via sendAttack).
    async maybeBetrayAndAttack(borderingFriends, borderingEnemies) {
      if (this.allianceBehavior === undefined) throw new Error("not initialized");

      if (this.game.config().disableAlliances()) return false;

      if (borderingFriends.length > 0) {
        for (const friend of borderingFriends) {
          if (
            this.allianceBehavior.maybeBetray(
              friend,
              borderingFriends.length + borderingEnemies.length,
            )
          ) {
            return await this.sendAttack(friend, true);
          }
        }
      }
      return false;
    }

    // isBorderingNukedTerritory — AiAttackBehavior (private).
    isBorderingNukedTerritory() {
      if (this.game.config().isUnitDisabled(UNIT.MissileSilo)) {
        return false;
      }

      for (const tile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(tile)) {
          if (
            this.game.isLand(neighbor) &&
            !this.game.hasOwner(neighbor) &&
            this.game.hasFallout(neighbor)
          ) {
            return true;
          }
        }
      }
      return false;
    }

    // Find someone who isn't significantly stronger than us and is under big attack from others (50%+ of their troops incoming)
    // findVictim — AiAttackBehavior (private).
    findVictim(borderingEnemies) {
      // borderingEnemies is already sorted by attack difficulty, so first match is weakest victim
      return (
        borderingEnemies.find((enemy) => {
          if (this.isFFA() && enemy.troops() > this.player.troops() * 1.2) {
            return false;
          }

          const totalIncomingTroops = enemy
            .incomingAttacks()
            .reduce((sum, attack) => sum + attack.troops(), 0);

          return totalIncomingTroops > enemy.troops() * 0.5;
        }) ?? null
      );
    }

    // Find very weak (less than 15% of their maxTroops) enemies
    // which also don't have significantly more troops than us (to target MIRVed players)
    // findVeryWeakEnemy — AiAttackBehavior (private).
    findVeryWeakEnemy(borderingEnemies) {
      const veryWeakEnemies = borderingEnemies.filter((enemy) => {
        const enemyMaxTroops = this.game.config().maxTroops(enemy);
        return (
          enemy.troops() < enemyMaxTroops * 0.15 &&
          (!this.isFFA() || enemy.troops() < this.player.troops() * 1.2)
        );
      });

      // borderingEnemies is already sorted by attack difficulty, so first match is weakest very weak enemy
      return veryWeakEnemies.length > 0 ? veryWeakEnemies[0] : null;
    }

    // findNearestIslandEnemy — AiAttackBehavior (private, now async).
    //
    // DIVERGENCE (center proxy + bounded border fetches): src sorts ALL filtered
    // players by manhattan distance between TERRITORY CENTERS computed from
    // borderTiles / largestClusterBoundingBox. On the client, (a)
    // largestClusterBoundingBox does not exist on the PlayerView, and (b) fetching
    // every filtered player's borderTiles for the distance sort would be unbounded
    // async worker calls. So we use `nameLocation()` (sync, available for all
    // players) as the cheap center proxy FOR THE SORT only — a faithful stand-in
    // for the bounding-box center (the player's label sits at its centroid). We
    // keep the SAME ascending-distance order and the SAME reachability loop, but
    // `await game.ensureBorderTiles(candidate)` ONLY for the candidates we actually
    // measure with closestTwoTiles, and we respect the src ≤2-reachable early-exit
    // so the number of border fetches is bounded. The boat reachability probe uses
    // bestTransportShipSpawn (the async equivalent of canBuildTransportShip).
    async findNearestIslandEnemy() {
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) {
        return null;
      }

      // Check if we've already sent out the maximum number of transport ships
      if (
        this.player.unitCount(UNIT.TransportShip) >=
        this.game.config().boatMaxNumber()
      ) {
        return null;
      }

      // Check if we have any shore tiles to launch from
      const hasShore = Array.from(this.player.borderTiles()).some((t) =>
        this.game.isShore(t),
      );
      if (!hasShore) return null;

      const filteredPlayers = this.game.players().filter((p) => {
        // src: `p === this.player` (identity) → smallID compare.
        if (p.smallID() === this.player.smallID()) return false;
        if (this.player.isFriendly(p)) return false;
        // In FFA, don't spam boats into players with more troops
        return !this.isFFA() || p.troops() < this.player.troops();
      });

      if (filteredPlayers.length === 0) return null;

      const playerCenter = this.getPlayerCenter(this.player);

      const sortedPlayers = filteredPlayers
        .map((filteredPlayer) => {
          const filteredPlayerCenter = this.getPlayerCenter(filteredPlayer);

          // getPlayerCenter falls back to nameLocation(), which can be undefined for
          // a player whose name position isn't populated yet (esp. other players on the
          // client). Guard both centers so the distance-sort never throws — such a
          // player just sorts last (Infinity) and is probed later by reachability.
          if (
            !playerCenter ||
            playerCenter.x == null ||
            !filteredPlayerCenter ||
            filteredPlayerCenter.x == null
          ) {
            return { player: filteredPlayer, distance: Infinity };
          }

          const playerCenterTile = this.game.ref(playerCenter.x, playerCenter.y);
          const filteredPlayerCenterTile = this.game.ref(
            filteredPlayerCenter.x,
            filteredPlayerCenter.y,
          );

          const distance = this.game.manhattanDist(
            playerCenterTile,
            filteredPlayerCenterTile,
          );
          return { player: filteredPlayer, distance };
        })
        .sort((a, b) => a.distance - b.distance); // Sort by distance (ascending)

      // Our shore tiles are stable across the loop — compute once.
      const myShores = Array.from(this.player.borderTiles()).filter((t) =>
        this.game.isShore(t),
      );

      // Try players in order of distance until we find reachable candidates
      const reachablePlayers = [];
      for (const entry of sortedPlayers) {
        // Fetch THIS candidate's border tiles (bounded: we early-exit at ≤2 reachable).
        await this.game.ensureBorderTiles(entry.player);
        const closest = closestTwoTiles(
          this.game,
          myShores,
          Array.from(entry.player.borderTiles()).filter((t) =>
            this.game.isShore(t),
          ),
        );
        if (closest === null) continue;

        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(closest.y),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn !== false) {
          reachablePlayers.push(entry.player);
          // We only need up to 2 reachable candidates
          if (reachablePlayers.length >= 2) break;
        }
      }

      if (reachablePlayers.length === 0) return null;

      // 33% chance to pick the second-nearest player if available
      if (reachablePlayers.length >= 2 && this.random.chance(3)) {
        return reachablePlayers[1];
      }

      return reachablePlayers[0];
    }

    // In team games, nations should be willing to attack/boat into stronger
    // enemies - they can rely on teammates to donate. In FFA, going after
    // someone significantly stronger is usually a losing proposition.
    // isFFA — AiAttackBehavior (private).
    isFFA() {
      // src: `this.game.config().gameConfig().gameMode === GameMode.FFA`. gameMode
      // is a real lobby fact — kept reading the real gameConfig (like sibling behaviors).
      return this.game.config().gameConfig().gameMode === GameMode.FFA;
    }

    // getPlayerCenter — AiAttackBehavior (private).
    // DIVERGENCE: src prefers `player.largestClusterBoundingBox` (core-only — not on
    // the client PlayerView; the gameApi wrapper does not expose it). We always fall
    // back to calculateBoundingBoxCenter over the border snapshot (the src fallback
    // branch). For OTHER players this requires their borderTiles to have been
    // ensured first; findNearestIslandEnemy ensures them per-candidate before the
    // closestTwoTiles measurement, but the distance-SORT center uses nameLocation()
    // (see findNearestIslandEnemy header) so an empty fallback here for the sort is
    // avoided. If borderTiles is empty (not yet fetched), this returns a center of
    // {x:-Infinity-ish}; callers in this file only invoke getPlayerCenter for `me`
    // (whose border is always snapshotted) via nameLocation proxy for others.
    getPlayerCenter(player) {
      // src: `if (player.largestClusterBoundingBox) return boundingBoxCenter(...)`.
      // Unavailable client-side → use nameLocation() as the centroid proxy when the
      // border snapshot for this player is not populated, else the bbox center.
      if (player.largestClusterBoundingBox) {
        return boundingBoxCenter(player.largestClusterBoundingBox);
      }
      const border = player.borderTiles();
      if (border && border.size > 0) {
        return calculateBoundingBoxCenter(this.game, border);
      }
      // Border not snapshotted (other player, sort phase) → nameLocation proxy.
      return player.nameLocation();
    }

    // attackRandomTarget — AiAttackBehavior (now async via sendAttack). Not invoked
    // by maybeAttack, but ported for true 1:1 (some callers/tests use it).
    async attackRandomTarget() {
      // Save up troops until we reach the trigger ratio
      if (!this.hasTriggerRatioTroops()) return;

      // Retaliate against incoming attacks
      const incomingAttackPlayer = this.findIncomingAttackPlayer();
      if (incomingAttackPlayer) {
        if (await this.sendAttack(incomingAttackPlayer, true)) return;
      }

      // Select a traitor as an enemy
      const toAttack = this.getNeighborTraitorToAttack();
      if (toAttack !== null) {
        if (this.random.chance(3)) {
          if (await this.sendAttack(toAttack)) return;
        }
      }

      // Choose a new enemy randomly
      const neighbors = this.player.nearby();
      for (const neighbor of this.random.shuffleArray(neighbors)) {
        if (!neighbor.isPlayer()) continue;
        if (this.player.isFriendly(neighbor)) continue;
        if (
          neighbor.type() === PlayerType.Nation ||
          neighbor.type() === PlayerType.Human
        ) {
          if (this.random.chance(2)) {
            continue;
          }
        }
        if (await this.sendAttack(neighbor)) return;
      }
    }

    // getNeighborTraitorToAttack — AiAttackBehavior.
    getNeighborTraitorToAttack() {
      if (this.game.config().disableAlliances()) return null;

      const traitors = this.player
        .nearby()
        .filter(
          (n) =>
            n.isPlayer() && this.player.isFriendly(n) === false && n.isTraitor(),
        );
      return traitors.length > 0 ? this.random.randElement(traitors) : null;
    }

    // forceSendAttack — AiAttackBehavior (now async only by signature; nationExecution
    // awaits it. No worker calls — a land/TN opening burst).
    async forceSendAttack(target, fraction = 0.5) {
      // src: game.addExecution(new AttackExecution(troops/2, player,
      //   target.isPlayer() ? target.id() : terraNullius().id())).
      // Client: emitIntent(ctors.attack, target.id()|null, troops).
      const ctors = discoverCtors(getEventBus());
      const requestedFraction = Number(fraction);
      const commitFraction = Number.isFinite(requestedFraction)
        ? Math.max(0, Math.min(1, requestedFraction))
        : 0.5;
      const troops = this.player.troops() * commitFraction;
      const targetId = target.isPlayer() ? target.id() : null;
      if (ctors.attack && emitIntent(ctors.attack, targetId, troops)) {
        state.stats.attacks++;
        setLastAction(tr("⚔️ Attack"), "combat");
        return true;
      }
      return false;
    }

    // sendAttack — AiAttackBehavior (now async via sendBoatAttack/
    // sendBoatAttackToNearbyTerraNullius; sendLandAttack stays sync).
    async sendAttack(
      target,
      force = false,
      minCommitFraction = null,
      earlyGameCandidate = null,
      plannedTroops = null,
    ) {
      this.ensureBotAttackAccounting();
      if (!force && !this.shouldAttack(target)) return false;

      if (target.isPlayer()) {
        if (this.player.sharesBorderWith(target)) {
          return this.sendLandAttack(
            target,
            minCommitFraction,
            earlyGameCandidate,
            plannedTroops,
          );
        } else {
          return await this.sendBoatAttack(
            target,
            earlyGameCandidate,
            plannedTroops,
          );
        }
      } else {
        // sharesBorderWith(TerraNullius) counts water tiles as TN (ownerID 0 = TN smallID),
        // so use a land-only adjacency check to decide land vs boat attack.
        if (this.hasLandBorderWithTerraNullius()) {
          return this.sendLandAttack(
            target,
            minCommitFraction,
            null,
            plannedTroops,
          );
        } else {
          return await this.sendBoatAttackToNearbyTerraNullius();
        }
      }
    }

    // hasLandBorderWithTerraNullius — AiAttackBehavior (private).
    hasLandBorderWithTerraNullius() {
      for (const border of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(border)) {
          if (this.game.isLand(neighbor) && !this.game.hasOwner(neighbor)) {
            return true;
          }
        }
      }
      return false;
    }

    // Scans shore border tiles (every 10th) for unowned land within 5 water tiles
    // in each cardinal direction, then sends a transport ship to the first match.
    // sendBoatAttackToNearbyTerraNullius — AiAttackBehavior (private, now async).
    //
    // DIVERGENCE (boat collect-then-probe): src calls canBuildTransportShip()
    // SYNCHRONOUSLY inside the shore scan and sends on the first match. We keep the
    // SAME shore scan (every 10th shore tile, 4 cardinal dirs, 5-step jump, same owner
    // filter; the fallout skip is now winFix-gated so we ALSO grab nuked coastal TN)
    // to COLLECT up to BOAT_PROBE_CANDIDATES target tiles IN SCAN ORDER, then `await
    // bestTransportShipSpawn` down that list and send to the FIRST reachable — same
    // target src would have picked, with bounded worker calls.
    async sendBoatAttackToNearbyTerraNullius() {
      // Honour the panel's "boat" feature toggle.
      if (!(state.settings.features && state.settings.features.boat)) return false;
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return false;
      if (
        this.player.unitCount(UNIT.TransportShip) >=
        this.game.config().boatMaxNumber()
      )
        return false;

      const directions = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ];
      const shores = Array.from(this.player.borderTiles()).filter((t) =>
        this.game.isShore(t),
      );

      const candidates = [];
      outer: for (let i = 0; i < shores.length; i += 10) {
        const border = shores[i];

        const bx = this.game.x(border);
        const by = this.game.y(border);

        for (const [dx, dy] of directions) {
          const x1 = bx + dx;
          const y1 = by + dy;
          if (!this.game.isValidCoord(x1, y1)) continue;
          if (!this.game.isWater(this.game.ref(x1, y1))) continue;

          const nx = bx + dx * 5;
          const ny = by + dy * 5;
          if (!this.game.isValidCoord(nx, ny)) continue;
          const tile = this.game.ref(nx, ny);
          if (!this.game.isLand(tile)) continue;
          if (this.game.hasOwner(tile)) continue;
          // USER WIN-FIX: keep nuked (fallout) coastal TN as a boat target — it's empty
          // land ripe for a probe landing. Faithful mode (winFixes off) keeps the src skip.
          if (!state.settings.winFixes && this.game.hasFallout(tile)) continue;
          // DIVERGENCE: src calls canBuildTransportShip(tile) here synchronously and
          // sends on the first pass. We collect the tile (in scan order) and defer
          // the async reachability probe to keep worker calls bounded.
          candidates.push(tile);
          if (candidates.length >= BOAT_PROBE_CANDIDATES) break outer;
        }
      }

      for (const tile of candidates) {
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn === false) continue;

        // USER (winFixes): EVERY boat is a cheap 1% probe — never a 20% dump (troops/5).
        // Even grabbing empty coastal TN goes by a 1% landing. (winFixes off → faithful.)
        const troops = state.settings.winFixes
          ? this.getEarlyGameProbeTroops(state.settings.boatProbeFrac)
          : this.player.troops() / 5;
        if (troops < 1) return false;

        // src: game.addExecution(new TransportShipExecution(player, tile, troops)).
        if (!(await this.allowEarlyGameBoat(tile))) return false;
        const ctors = discoverCtors(getEventBus());
        if (ctors.boat && emitIntent(ctors.boat, tile, troops)) {
          state.stats.attacks++;
          setLastAction(tr("⛵ Boat (land grab)"), "naval");
        }
        return true;
      }
      return false;
    }

    // shouldAttack — AiAttackBehavior.
    shouldAttack(other) {
      if (
        // Always attack Terra Nullius, non-humans and traitors
        other.isPlayer() === false ||
        other.type() !== PlayerType.Human ||
        other.isTraitor() ||
        // Always attack if we are a bot or in an HvN game
        this.player.type() === PlayerType.Bot ||
        this.game.config().gameConfig().playerTeams === HumansVsNations
      ) {
        return true;
      }

      // Prevent attacking of humans on lower difficulties
      // src: `const { difficulty } = this.game.config().gameConfig();` → REPLICATED.
      const difficulty = currentDifficulty();
      if (difficulty === Difficulty.Easy && this.random.nextInt(0, 4) !== 0) {
        return false;
      }
      if (difficulty === Difficulty.Medium && this.random.chance(4)) {
        return false;
      }
      return true;
    }

    // sendLandAttack — AiAttackBehavior (private). SYNC: no worker calls.
    sendLandAttack(
      target,
      minCommitFraction = null,
      earlyGameCandidate = null,
      plannedTroops = null,
    ) {
      this.ensureBotAttackAccounting();
      const maxTroops = this.game.config().maxTroops(this.player);
      const enemyDefensePostProfile = this.getEnemyDefensePostAttackProfile(
        target,
      );
      const botTarget =
        target.isPlayer() && target.type() === PlayerType.Bot;
      const botAttackRequirement = botTarget
        ? this.getBotAttackRequirement(
            target,
            enemyDefensePostProfile,
            earlyGameCandidate,
          )
        : null;
      if (botTarget && botAttackRequirement.remaining <= 0) return false;
      const botWithStructures =
        botTarget &&
        target.units().some((u) => AttackStructures.has(u.type()));
      // Use the expand ratio when attacking a bot that owns structures — we need to
      // recapture those structures ASAP, even before reaching the normal reserve.
      const useReserve = target.isPlayer() && !botWithStructures;
      // WIN-FIX (sizeReserve): the player/TN reserve uses the size-aware floor;
      // bot-with-structures recapture still uses the aggressive expandRatio.
      const reserveRatio = useReserve
        ? this.effectiveReserveRatio()
        : this.expandRatio;
      const targetTroops = maxTroops * reserveRatio;

      let troops;
      const botAttackTroopsSentBefore = this.botAttackTroopsSent;
      if (botTarget && this.player.type() !== PlayerType.Bot) {
        troops = this.calculateBotAttackTroops(
          target,
          this.player.troops() - targetTroops - this.botAttackTroopsSent,
          enemyDefensePostProfile,
          botAttackRequirement.active,
          earlyGameCandidate,
        );
      } else {
        troops = this.player.troops() - targetTroops;
      }

      const baseTroops = troops;
      troops = this.applyEarlyGameRaceTroops({
        target,
        baseTroops,
        reserveTroops: targetTroops + botAttackTroopsSentBefore,
        earlyGameCandidate,
      });

      if (
        minCommitFraction != null &&
        state.settings.winFixes &&
        !target.isPlayer()
      ) {
        troops = Math.max(troops, this.player.troops() * minCommitFraction);
      }

      // The opening planner supplies an explicit bounded commitment. This is
      // allowed to override the maxTroops reserve for TerraNullius and Bot
      // tribes: that reserve is intentionally too large for a newly spawned
      // empire and would otherwise turn the first minute into a wait loop.
      if (plannedTroops != null && state.settings.winFixes) {
        const planned = Number(plannedTroops);
        if (!Number.isFinite(planned) || planned < 1) {
          return false;
        }
        const captureFloor = botAttackRequirement?.required || 0;
        const remainingCaptureTroops = botAttackRequirement?.remaining || 0;
        if (botTarget && !Number.isFinite(captureFloor)) return false;
        if (botTarget && remainingCaptureTroops <= 0) return false;
        const spendableTroops = Math.max(
          0,
          this.getEarlyGameSpendableTroops() -
            (botTarget ? this.botAttackTroopsSent : 0),
        );
        if (botTarget && remainingCaptureTroops > spendableTroops) {
          return false;
        }
        // `planned` is already the additional commitment from the Early Game
        // planner. For a tribe, raise it only to the still-missing capture
        // force; never resend the full requirement when part is in flight.
        troops = Math.min(
          spendableTroops,
          Math.max(planned, botTarget ? remainingCaptureTroops : 0),
        );
      }

      if (botTarget) {
        if (!Number.isFinite(botAttackRequirement.required)) return false;
        if (troops < botAttackRequirement.remaining) return false;
      }

      // A Defense Post multiplies the real per-tile attacker loss by five. Do
      // not spend a sub-2× effective attack into a covered front; the existing
      // reserve remains available for a later, properly sized assault.
      if (
        target.isPlayer() &&
        this.attackIsTooWeakForDefensePosts(
          target,
          troops,
          enemyDefensePostProfile,
        )
      ) {
        return false;
      }

      if (troops < 1) {
        return false;
      }

      // DIVERGENCE (inert branch — kept VERBATIM): this gates the attack emoji on
      // `this.player.type() === PlayerType.Nation`. The bot is myPlayer() with
      // type() === Human, so this never fires (same class as warshipBehavior's
      // isRichPlayer divergence). Condition kept exactly; do not rewrite to fire.
      if (target.isPlayer() && this.player.type() === PlayerType.Nation) {
        if (this.emojiBehavior === undefined) throw new Error("not initialized");
        this.emojiBehavior.maybeSendAttackEmoji(target);
      }

      // src: game.addExecution(new AttackExecution(troops, player,
      //   target.isPlayer() ? target.id() : terraNullius().id())).
      const ctors = discoverCtors(getEventBus());
      const targetId = target.isPlayer() ? target.id() : null;
      if (ctors.attack && emitIntent(ctors.attack, targetId, troops)) {
        state.stats.attacks++;
        setLastAction(tr("⚔️ Attack"), "combat");
        this.recordBotAttackTroopsSent(target, troops);
        return true;
      }
      return false;
    }

    // sendBoatAttack — AiAttackBehavior (private, now async).
    //
    // DIVERGENCE (boat probe): src computes closestTwoTiles between OUR shore tiles
    // and the TARGET's shore tiles, then `canBuildTransportShip(closest.y)` as a
    // gate and sends to `closest.y`. The client needs the target's borderTiles (an
    // async fetch) before reading them synchronously, and the canBuild check is the
    // async bestTransportShipSpawn probe. We `await game.ensureBorderTiles(target)`
    // first (cached per tick), then probe; the dst sent is still `closest.y`.
    async sendBoatAttack(
      target,
      earlyGameCandidate = null,
      plannedTroops = null,
    ) {
      this.ensureBotAttackAccounting();
      // Honour the panel's "boat" feature toggle (faithful boat attacks must obey
      // it too, not just the win-fix landings).
      if (!(state.settings.features && state.settings.features.boat)) {
        return false;
      }
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) {
        return false;
      }

      // Ensure the target's border snapshot before reading it synchronously.
      await this.game.ensureBorderTiles(target);

      const closest = closestTwoTiles(
        this.game,
        Array.from(this.player.borderTiles()).filter((t) => this.game.isShore(t)),
        Array.from(target.borderTiles()).filter((t) => this.game.isShore(t)),
      );
      if (closest === null) {
        return false;
      }

      const spawn = await withTimeout(
        this.player.bestTransportShipSpawn(closest.y),
        WORKER_TIMEOUT_MS,
        false,
      );
      if (spawn === false) {
        return false;
      }

      // USER (winFixes): a boat aimed at a neutral Bot/tribe is a real capture,
      // not a probe. Calculate the force from the live attack-loss formula so the
      // tribe is taken in one crossing when the reserve allows it. Boats aimed at
      // nations, open coast, or TerraNullius keep the cheap 1% probe policy.
      let troops;
      const botTarget =
        target.isPlayer() && target.type() === PlayerType.Bot;
      const botAttackTroopsSentBefore = this.botAttackTroopsSent;
      const botDefensePostProfile = botTarget
        ? this.getEnemyDefensePostAttackProfile(target)
        : null;
      const botAttackRequirement = botTarget
        ? this.getBotAttackRequirement(
            target,
            botDefensePostProfile,
            earlyGameCandidate,
          )
        : null;
      if (botTarget && botAttackRequirement.remaining <= 0) return false;
      let captureReserveTroops =
        this.game.config().maxTroops(this.player) *
        this.effectiveReserveRatio();
      if (state.settings.winFixes && botTarget) {
        const maxTroops = this.game.config().maxTroops(this.player);
        const botWithStructures = target
          .units()
          .some((u) => AttackStructures.has(u.type()));
        const reserveRatio = botWithStructures
          ? this.expandRatio
          : this.effectiveReserveRatio();
        captureReserveTroops = maxTroops * reserveRatio;
        troops = this.calculateBotAttackTroops(
          target,
          this.player.troops() -
            captureReserveTroops -
            this.botAttackTroopsSent,
          botDefensePostProfile,
          botAttackRequirement.active,
          earlyGameCandidate,
        );
      } else if (state.settings.winFixes) {
        troops = this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
      } else if (botTarget) {
        troops = this.calculateBotAttackTroops(target, this.player.troops() / 5);
      } else {
        troops = this.player.troops() / 5;
      }

      const baseTroops = troops;
      troops = this.applyEarlyGameRaceTroops({
        target,
        baseTroops: troops,
        reserveTroops: captureReserveTroops + botAttackTroopsSentBefore,
        earlyGameCandidate,
      });

      // A maritime tribe is still a full capture target during the opening;
      // never downgrade the planner's complete-capture force to the global 1%
      // boat probe rule. Keep the commitment bounded by the plan and reset the
      // bot-accounting counter if the standard reserve calculation was skipped.
      if (plannedTroops != null && state.settings.winFixes) {
        const planned = Number(plannedTroops);
        if (!Number.isFinite(planned) || planned < 1) {
          return false;
        }
        const captureFloor = botAttackRequirement?.required || 0;
        const remainingCaptureTroops = botAttackRequirement?.remaining || 0;
        if (botTarget && !Number.isFinite(captureFloor)) return false;
        if (botTarget && remainingCaptureTroops <= 0) return false;
        const spendableTroops = Math.max(
          0,
          this.getEarlyGameSpendableTroops() -
            (botTarget ? this.botAttackTroopsSent : 0),
        );
        if (botTarget && remainingCaptureTroops > spendableTroops) {
          return false;
        }
        // `planned` is already the additional commitment selected by the
        // planner. Top up only the missing capture amount; never resend the
        // full requirement when another boat is already in flight.
        troops = Math.min(
          spendableTroops,
          Math.max(planned, botTarget ? remainingCaptureTroops : 0),
        );
      }

      if (troops < 1) {
        return false;
      }
      if (botTarget) {
        if (!Number.isFinite(botAttackRequirement.required)) return false;
        if (troops < botAttackRequirement.remaining) return false;
      }

      // DIVERGENCE (inert branch — kept VERBATIM): emoji gated on player type Nation;
      // the bot is Human so this never fires. Condition kept exactly.
      if (target.isPlayer() && this.player.type() === PlayerType.Nation) {
        if (this.emojiBehavior === undefined) throw new Error("not initialized");
        this.emojiBehavior.maybeSendAttackEmoji(target);
      }

      // src: game.addExecution(new TransportShipExecution(player, closest.y, troops)).
      if (!(await this.allowEarlyGameBoat(closest.y))) {
        return false;
      }
      const ctors = discoverCtors(getEventBus());
      if (ctors.boat && emitIntent(ctors.boat, closest.y, troops)) {
        state.stats.attacks++;
        setLastAction(tr("⛵ Boat attack"), "naval");
        this.recordBotAttackTroopsSent(target, troops);
        return true;
      }
      return false;
    }

    applyEarlyGameRaceTroops({
      target,
      baseTroops,
      reserveTroops,
      earlyGameCandidate,
    }) {
      if (
        !earlyGameCandidate ||
        !target?.isPlayer?.() ||
        earlyGameCandidate.id !== target.smallID?.()
      ) {
        return baseTroops;
      }
      return calculateEarlyGameRaceTroops({
        ownTroops: this.player.troops(),
        baseTroops,
        reserveTroops,
        targetTroops: target.troops(),
        competitorTroops: earlyGameCandidate.competitorTroops,
        contestPressure: earlyGameCandidate.foodRaceValue,
      });
    }

    getEarlyGameLiveReserveTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      return ownTroops * EARLY_GAME_MIN_LIVE_RESERVE_RATIO;
    }

    getEarlyGameSpendableTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      const liveReserve = state.settings.winFixes
        ? this.getEarlyGameLiveReserveTroops()
        : 0;
      return Math.max(0, ownTroops - liveReserve);
    }

    getEarlyGameProbeTroops(fraction = 0.01) {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      const configuredFraction = Number(fraction);
      const probeFraction = Number.isFinite(configuredFraction)
        ? Math.max(0.01, configuredFraction)
        : 0.01;
      return Math.min(
        ownTroops * probeFraction,
        this.getEarlyGameSpendableTroops(),
      );
    }

    getBotCaptureSimulationTiles(target) {
      const border = [];
      try {
        for (const tile of target?.borderTiles?.() || []) border.push(tile);
      } catch (_error) {
        /* an older adapter may not expose a synchronous border snapshot */
      }
      if (border.length === 0) {
        const targetID = target?.smallID?.();
        const seen = new Set();
        try {
          for (const ownBorder of this.player?.borderTiles?.() || []) {
            for (const tile of this.game.neighbors(ownBorder) || []) {
              if (seen.has(tile)) continue;
              if (
                this.game.isLand?.(tile) === false ||
                this.game.ownerID(tile) !== targetID
              ) {
                continue;
              }
              seen.add(tile);
              border.push(tile);
              if (border.length >= 64) break;
            }
            if (border.length >= 64) break;
          }
        } catch (_error) {
          /* the current front is optional on older adapters */
        }
      }
      if (border.length <= 1) return border;

      const tileMagnitude = (tile) => {
        try {
          const magnitude = Number(this.game.magnitude?.(tile));
          return Number.isFinite(magnitude) ? magnitude : 0;
        } catch (_error) {
          return 0;
        }
      };

      // Use the most expensive currently exposed front first. This is a small
      // bounded safety margin for the attack heap's terrain-dependent ordering;
      // it is materially tighter than multiplying the whole target army.
      return border
        .sort((left, right) => tileMagnitude(right) - tileMagnitude(left))
        .slice(0, 64);
    }

    estimateBotCaptureTroops(
      target,
      defensePostProfile = null,
      earlyGameCandidate = null,
    ) {
      const targetTroops = Math.max(0, Number(target?.troops?.() || 0));
      const targetTiles = Math.max(0, Number(target?.numTilesOwned?.() || 0));
      const defenseMultiplier = Math.max(
        1,
        Number(defensePostProfile?.attackCostMultiplier || 1),
      );
      const captureTiles =
        typeof requiredTribeCaptureTiles === "function"
          ? requiredTribeCaptureTiles(targetTiles, 1)
          : Math.max(1, Math.ceil(targetTiles) - 99);
      if (captureTiles > MAX_BOT_CAPTURE_SIMULATION_TILES) {
        // There is no safe bounded estimate for a very large Bot. Returning
        // Infinity makes every caller defer the attack until the target is
        // smaller, rather than launching a knowingly incomplete assault.
        return Number.POSITIVE_INFINITY;
      }
      const terrainMagnitude = terrainAttackMagnitudeFromMapMagnitude(
        Number(earlyGameCandidate?.terrainMagnitude),
      );
      const defenderTroopLoss =
        targetTroops / Math.max(1, targetTiles || 100);
      const fallbackLossPerTile =
        0.6 * terrainMagnitude * 0.8 * defenseMultiplier +
        0.4 *
          (1.3 * defenderTroopLoss * (terrainMagnitude / 100)) *
          defenseMultiplier;
      const fallbackTroops = Math.max(
        1,
        fallbackLossPerTile * captureTiles + 1,
      );
      const config = this.game.config?.();
      const attackLogic = config?.attackLogic;
      const simulationTiles = this.getBotCaptureSimulationTiles(target);
      const estimate =
        typeof estimateTribeCaptureTroops === "function"
          ? estimateTribeCaptureTroops
          : ({ fallbackTroops: fallback } = {}) =>
              Math.max(1, Math.ceil(Number(fallback) || 1));

      if (typeof attackLogic !== "function") {
        return estimate({
          targetTiles,
          captureTiles,
          fallbackTroops,
        });
      }
      if (simulationTiles.length === 0) {
        // The live formula exists, but without a target front there is no
        // terrain sequence to prove a complete capture against. Defer rather
        // than use a partial fallback that can consume the whole assault.
        return Number.POSITIVE_INFINITY;
      }

      const simulateAttack = (attackTroops, tilesToCapture) => {
        let attackerTroops = Math.max(0, Number(attackTroops) || 0);
        let defenderTroops = targetTroops;
        let defenderTiles =
          targetTiles > 0 ? targetTiles : Math.max(100, tilesToCapture + 99);

        for (let index = 0; index < tilesToCapture; index += 1) {
          // AttackExecution checks this before each tile. Requiring one
          // surviving troop after the last tile avoids a zero/negative attack
          // becoming a false positive in older engine builds.
          if (attackerTroops < 1) return false;
          const simulatedTarget = Object.create(target);
          simulatedTarget.troops = () => defenderTroops;
          simulatedTarget.numTilesOwned = () => defenderTiles;

          let result;
          try {
            result = attackLogic(
              this.game,
              attackerTroops,
              this.player,
              simulatedTarget,
              simulationTiles[index % simulationTiles.length],
            );
          } catch (_error) {
            return false;
          }

          const attackerLoss = Number(result?.attackerTroopLoss);
          if (!Number.isFinite(attackerLoss) || attackerLoss < 0) return false;
          attackerTroops -= attackerLoss;
          if (attackerTroops < 1) return false;

          const defenderLoss = Number(result?.defenderTroopLoss);
          if (Number.isFinite(defenderLoss) && defenderLoss > 0) {
            defenderTroops = Math.max(0, defenderTroops - defenderLoss);
          }
          defenderTiles = Math.max(1, defenderTiles - 1);
        }
        return attackerTroops >= 1;
      };

      return estimate({
        targetTiles,
        captureTiles,
        simulateAttack,
        fallbackTroops,
      });
    }

    // getBotCaptureTroopsFloor — AiAttackBehavior (private).
    getBotCaptureTroopsFloor(
      target,
      defensePostProfile = null,
      earlyGameCandidate = null,
    ) {
      if (!target?.isPlayer?.() || target.type?.() !== PlayerType.Bot) return 0;

      const tick = this.currentAttackDecisionTick();
      if (this.botCaptureTroopsCacheTick !== tick) {
        this.botCaptureTroopsCacheTick = tick;
        this.botCaptureTroopsCache.clear();
      }
      const targetID = target.smallID?.() ?? target;
      const signature = [
        Number(target.troops?.() || 0),
        Number(target.numTilesOwned?.() || 0),
        Number(earlyGameCandidate?.terrainMagnitude || 0),
        Number(defensePostProfile?.attackCostMultiplier || 1),
      ].join(":");
      const cached = this.botCaptureTroopsCache.get(targetID);
      if (cached?.signature === signature) return cached.troops;

      const troops = this.estimateBotCaptureTroops(
        target,
        defensePostProfile,
        earlyGameCandidate,
      );
      this.botCaptureTroopsCache.set(targetID, { signature, troops });
      return troops;
    }

    // calculateBotAttackTroops — AiAttackBehavior (private).
    calculateBotAttackTroops(
      target,
      maxTroops,
      defensePostProfile = null,
      activeAttackTroops = 0,
      earlyGameCandidate = null,
    ) {
      const captureTroops = this.getBotCaptureTroopsFloor(
        target,
        defensePostProfile,
        earlyGameCandidate,
      );
      const available = Math.max(0, Number(maxTroops) || 0);
      if (captureTroops === Number.POSITIVE_INFINITY) return 0;
      if (captureTroops > 0) {
        const active = Math.max(0, Number(activeAttackTroops) || 0);
        const remaining = Math.max(0, captureTroops - active);
        return available >= remaining ? remaining : 0;
      }
      return available;
    }

    // donateTroops — AiAttackBehavior (private). No worker calls in src; the only
    // async-shaped read (canDonateTroops) is core-only — see DIVERGENCE below.
    // Kept sync (returns a plain boolean) — the strategy wrapper `donate` awaits it.
    donateTroops() {
      // DIAG (throttled ~5s): surface the live gate state so we can see WHY donate
      // does/doesn't fire — the usual blockers are non-Team mode or the lobby having
      // "donate troops" turned OFF (config.donateTroops() === false → game forbids it).
      try {
        const nowD = performance.now();
        if (nowD - (state._donDiagAt || 0) > 5000) {
          state._donDiagAt = nowD;
          const cfg = this.game.config();
          const mates = this.game
            .players()
            .filter(
              (p) =>
                this.player.isOnSameTeam(p) &&
                p.smallID() !== this.player.smallID() &&
                p.isAlive(),
            );
          console.log(
            "[Donate] diag: " +
              JSON.stringify({
                featureOn: !!state.settings.features.donate,
                winFixes: !!state.settings.winFixes,
                replicatedDifficulty: String(currentDifficulty()),
                gameType: String(cfg.gameConfig().gameType),
                gameMode: String(cfg.gameConfig().gameMode),
                donateAllowedByLobby: cfg.donateTroops(),
                aliveTeammates: mates.length,
                myTroops: Math.round(this.player.troops()),
              }),
          );
        }
      } catch (_e) {
        /* ignore */
      }

      // Thin UX gate (PORT-CONTRACT donate strategy note — not a strategy change).
      if (!state.settings.features.donate) return false;

      // Keep the opening force available for expansion. This is deliberately
      // inside donateTroops() so both the proactive win-fix donation and the
      // faithful difficulty strategy obey the same user-controlled pause.
      const expansionStatus =
        typeof getAutoDonateExpansionStatus === "function"
          ? getAutoDonateExpansionStatus(state.earlyGame)
          : { active: false, reason: null };
      if (state.settings.pauseDonateDuringExpansion && expansionStatus.active) {
        return false;
      }

      // Only donate in team games
      if (this.game.config().gameConfig().gameMode !== GameMode.Team) {
        return false;
      }

      // PUBLIC-LOBBY UNLOCK (user request): the src AiAttackBehavior blocks donation
      // in public games "to balance HvN" — but that guard exists to stop the in-game
      // AI *Nations* from buffing the human side. Our bot plays AS the human player,
      // and public TEAM lobbies allow troop donation server-side (MapPlaylist sets
      // donateTroops = (mode === Team)). So we DROP the public block and rely on the
      // real game rule below (config().donateTroops()) plus the Team-mode gate above.
      //   Original src guard (kept for reference):
      //   if (this.game.config().gameConfig().gameType === GameType.Public) return false;

      // Check if donating troops is allowed (the REAL server-side rule — true in
      // public Team lobbies, false where the lobby disabled troop donations).
      if (this.game.config().donateTroops() === false) {
        return false;
      }

      // Don't donate if the game has a winner
      // DIVERGENCE: the client getWinner() returns null (gameApi passthrough), so
      // this guard is effectively inert client-side. Most leader logic in src is
      // tile-based, but donate's winner-guard specifically is a server-decided fact
      // we can't reconstruct faithfully; treated as "no winner yet" (null) so the
      // guard does not block donation. Kept the call for parity.
      // BUG FIX: the client getWinner() returns `undefined` (not null) when there is no
      // winner, and `undefined !== null` is TRUE — which silently blocked EVERY donation
      // (all other gates passed: Impossible/Team/allowed). Only block on a REAL winner.
      if (this.game.getWinner()) {
        console.log("[Donate] skip: game already has a winner");
        return false;
      }

      // Skip donating based on difficulty
      // src: `const { difficulty } = this.game.config().gameConfig();` → REPLICATED.
      // WIN-FIX: the proactive team-donation must fire regardless of the replicated
      // difficulty — in src "Easy nations don't donate" and Medium/Hard only donate
      // 25%/50% of the time, which silently blocked the user's donate (the bot was
      // replicating Easy). When winFixes is on we SKIP this throttle (always try, like
      // Impossible); faithful mode keeps the exact src difficulty gate.
      const difficulty = currentDifficulty();
      if (!state.settings.winFixes) {
        switch (difficulty) {
          case Difficulty.Easy:
            // Easy nations don't donate
            return false;
          case Difficulty.Medium:
            // Medium nations donate 25% of the time
            if (!this.random.chance(4)) {
              return false;
            }
            break;
          case Difficulty.Hard:
            // Hard nations donate 50% of the time
            if (!this.random.chance(2)) {
              return false;
            }
            break;
          case Difficulty.Impossible:
            // Impossible nations always try to donate
            break;
          case Difficulty.Legendary:
            // Legendary nations always try to donate.
            break;
          default:
            throw new Error("unreachable difficulty: " + difficulty);
        }
      }

      // Find teammates who are currently in combat. WIN-FIX: the client often can't
      // see OTHER players' incoming/outgoing attacks (gameApi exposes them reliably
      // only for our own player), so the faithful "in combat" filter yields an empty
      // list and donate never fires. In winFix mode we drop the combat requirement and
      // donate to the weakest same-team ally (the weaker-than-us guard is applied after
      // selection), which is what the user wants for frontline team support.
      const teammates = this.game
        .players()
        .filter((p) => this.player.isOnSameTeam(p))
        .filter((p) =>
          state.settings.winFixes
            ? true
            : p.incomingAttacks().length > 0 || p.outgoingAttacks().length > 0,
        );

      if (teammates.length === 0) {
        console.log("[Donate] skip: no same-team players found");
        return false;
      }

      // Find teammate with lowest troop percentage (troops / maxTroops)
      const teammatesWithTroopPercentage = teammates
        .map((teammate) => {
          const maxTroops = this.game.config().maxTroops(teammate);
          const troopPercentage = teammate.troops() / Math.max(maxTroops, 1);
          return { teammate, troopPercentage };
        })
        .sort((a, b) => a.troopPercentage - b.troopPercentage);

      // Try to donate to teammates in order of lowest troop percentage
      // DIVERGENCE: src calls `this.player.canDonateTroops(teammate)` — a core-only
      // PlayerImpl method (not on the client PlayerView; the gameApi wrapper does not
      // expose it). canDonateTroops checks the recipient is alive, same-team and not
      // self; teammates here are already isOnSameTeam-filtered and are players from
      // game.players(), so we approximate the gate with isAlive() && not-self (the
      // remaining canDonateTroops conditions). This may let a donate through that the
      // engine would reject (the engine then no-ops the intent), but never the
      // reverse — so the strategy ORDER and target choice stay faithful.
      // USER RULE: donate to any teammate who actually NEEDS troops — i.e. is below
      // donateNeedThreshold (80%) of their max. Pick the NEEDIEST (lowest %) alive
      // non-self ally under that line. The keep-line below protects our own economy,
      // so we no longer need the old "only donate down" guard (that was blocking us
      // whenever the bot was poorer than its allies).
      const needThreshold = state.settings.winFixes
        ? (state.settings.donateNeedThreshold ?? 0.8)
        : 1.0; // faithful mode: any in-combat teammate (no threshold)
      // Pool of NEEDY allies (< needThreshold), then prioritise teammates who share
      // our clan tag. Clan matching is deliberately a soft metadata signal: when
      // either tag is unavailable, the candidate falls back to the ordinary team
      // donation order. Within each clan bucket, reinforce the FRONT LINE first and
      // then the neediest (lowest troop%) ally.
      const needy = teammatesWithTroopPercentage
        .filter(
          (e) =>
            e.teammate.isAlive() &&
            e.teammate.smallID() !== this.player.smallID() &&
            e.troopPercentage < needThreshold,
        )
        .map((e) => {
          let frontline = false;
          try {
            frontline =
              e.teammate.incomingAttacks().length > 0 ||
              e.teammate.outgoingAttacks().length > 0;
          } catch (_e) {
            /* client may not expose other players' attacks → treat as rear */
          }
          return {
            entry: e,
            frontline,
            sameClan:
              state.settings.winFixes &&
              playersShareClanTag(this.player, e.teammate),
            troopPercentage: e.troopPercentage,
          };
        });
      const rankedNeedy = rankTeamDonationCandidates(needy);
      let selectedTeammate = null;
      if (rankedNeedy.length > 0) {
        selectedTeammate = rankedNeedy[0].entry.teammate;
        console.log(
          "[Donate] picked ally at " +
            Math.round(rankedNeedy[0].troopPercentage * 100) +
            "% " +
            (rankedNeedy[0].sameClan ? "(same clan) " : "") +
            (rankedNeedy[0].frontline ? "(FRONTLINE — in combat)" : "(rear)"),
        );
      }

      if (selectedTeammate === null) {
        console.log("[Donate] skip: no teammate below the need threshold (all allies healthy)");
        return false;
      }

      // Donate only the EXCESS above a ~peak-regrowth keep line so giving troops to a
      // teammate barely dents our own generation rate. The game's growth peaks near
      // 0.42·maxTroops, so winFix mode keeps ~donateKeepFrac (45%) and donates the rest;
      // faithful mode keeps the plain reserveRatio.
      const maxTroops = this.game.config().maxTroops(this.player);
      const keepFrac = state.settings.winFixes
        ? Math.max(this.reserveRatio, state.settings.donateKeepFrac || 0.45)
        : this.reserveRatio;
      const troopsToKeep = maxTroops * keepFrac;
      const availableTroops = this.player.troops() - troopsToKeep;
      const minExcess = state.settings.winFixes
        ? maxTroops * (state.settings.donateMinExcessFrac || 0.05)
        : 1;

      if (availableTroops < minExcess) {
        console.log("[Donate] skip: not enough above the keep line", {
          troops: Math.round(this.player.troops()),
          keep: Math.round(troopsToKeep),
          needExcess: Math.round(minExcess),
        });
        return false;
      }

      // Minimum donation chunk: only donate when the amount is ≥ donateMinDonatePct ×
      // currentTroops. This batches smaller donations into bigger ones — dồn lực.
      const minDonatePct = state.settings.donateMinDonatePct || 0.2;
      const minDonateAmount = this.player.troops() * minDonatePct;
      if (availableTroops < minDonateAmount) {
        console.log("[Donate] skip: donation too small (minDonatePct)", {
          available: Math.round(availableTroops),
          minChunk: Math.round(minDonateAmount),
          pct: Math.round(minDonatePct * 100) + "%",
        });
        return false;
      }

      // src: game.addExecution(new DonateTroopsExecution(player,
      //   selectedTeammate.id(), availableTroops)).
      // Client: emitIntent(ctors.donateTroops, recipient.__src ?? recipient, troops).
      const ctors = discoverCtors(getEventBus());
      if (
        ctors.donateTroops &&
        emitIntent(
          ctors.donateTroops,
          selectedTeammate.__src ?? selectedTeammate,
          availableTroops,
        )
      ) {
        console.log(
          "[Donate] SENT",
          Math.round(availableTroops),
          "→",
          selectedTeammate.name?.() ?? selectedTeammate.smallID?.(),
        );
        setLastAction(tr("🎁 Donate troops"), "combat");
      } else {
        console.log("[Donate] emit failed", { ctor: !!ctors.donateTroops });
      }

      return true;
    }
  }
