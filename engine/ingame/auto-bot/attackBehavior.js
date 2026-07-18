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
//         (`null` is the client protocol's explicit TerraNullius target).
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
  const AttackStructureTypes = [
    UNIT.City,
    UNIT.DefensePost,
    UNIT.SAMLauncher,
    UNIT.MissileSilo,
    UNIT.Port,
    UNIT.Factory,
  ];

  // HumansVsNations — src/core/game/Game.ts:81 (`"Humans Vs Nations"`).
  const HumansVsNations = "Humans Vs Nations";

  // Bound on how many target tiles we COLLECT before awaiting the async boat
  // spawn probe (PORT-CONTRACT §Async #2). The src loops are unbounded
  // (findRandomBoatTarget 500 iters, etc.); we cap the worker calls.
  const BOAT_PROBE_CANDIDATES = 4;
  // Nearby boat discovery can inspect every sampled coastal coordinate when
  // no suitable landing exists. Keep its exact ordering, but yield between
  // bounded coordinate batches so an empty coast cannot freeze the main loop.
  const BOAT_NEARBY_SCAN_SLICE_OFFSETS = 256;
  // One opportunistic decision must not serially monopolize the worker with
  // every boat strategy. Each stage retains its normal ranked candidates, but
  // the stage itself advances only after its bounded probe batch is exhausted.
  const OPPORTUNISTIC_BOAT_SEARCH_STAGES = [
    "nearby",
    "crater",
    "random-high",
    "random-player",
    "distant",
    "disconnected",
  ];

  // Early-game tribe scoring may need one border snapshot per candidate. Keep the
  // async enrichment bounded so a crowded tribe map cannot starve the combat tick.
  const EARLY_TRIBE_CANDIDATES = 8;
  const EARLY_TRIBE_BOAT_ETA_TARGETS = BOAT_PROBE_CANDIDATES;
  // A route ETA can fan out into several pathfinder probes.  Evaluate only
  // the highest-priority cold candidates in one strategic decision; after
  // that batch is cached, the next decision naturally advances to the
  // remaining cluster gateways without a multi-batch frame spike.
  const EARLY_TRIBE_BOAT_ETA_CANDIDATE_BUDGET = EARLY_TRIBE_BOAT_ETA_TARGETS;
  // A stable coast does not need sixteen new pathfinder probes every strategic
  // decision. Revalidate promptly, and invalidate immediately on either border
  // snapshot changing so new ports/territory can still alter the route.
  const EARLY_TRIBE_BOAT_ETA_CACHE_TICKS = 60;
  // An ocean probe performs two worker route queries. Spread failed destinations
  // across the strategic cadence instead of chaining four pathfinders in one
  // combat decision; the retry window leaves room to try every ranked fallback.
  const EARLY_OCEAN_ROUTE_PROBE_BUDGET = 1;
  const EARLY_OCEAN_PROBE_RETRY_TICKS = BOAT_PROBE_CANDIDATES * 30;
  // Ordinary random boats are a low-priority fallback, unlike the directed
  // early/oportunistic naval lanes. Never let several slow worker probes turn
  // one combat decision into a visible frame stall.
  const ORDINARY_RANDOM_BOAT_PROBE_TIMEOUT_MS = 75;
  const ORDINARY_RANDOM_BOAT_RETRY_TICKS = 30;
  const EARLY_GAME_TRIBE_CHAIN_RADIUS = 120;
  // The profiled strategic cadence is 19 game ticks. Keep the complete graph
  // through two decisions (rather than rebuilding it every other decision),
  // while a changed live tribe-id signature still invalidates it immediately.
  // Topology changes immediately when a tribe enters/leaves the membership
  // signature. Between those changes, refreshing full border adjacency every
  // four seconds created 250ms+ opening stalls on dense maps, so retain the
  // coherent graph for twelve seconds instead.
  const EARLY_GAME_TRIBE_TOPOLOGY_CACHE_TICKS = 120;
  // Rebuilding every tribe's food-race vector against every visible player is
  // quadratic on crowded maps.  Keep one short snapshot only while an exact
  // live-state signature proves that no owner, movement, troop, or attack
  // signal has changed; any contested tribe therefore invalidates at once.
  const EARLY_GAME_TRIBE_RISK_SNAPSHOT_CACHE_TICKS = 40;
  // Directional food-race pressure is exactly zero once competitors are this
  // far from a tribe centre. Keep the spatial bucket width equal to that
  // radius so checking a tribe's neighbouring buckets preserves every
  // non-zero directional signal.
  const EARLY_GAME_FOOD_RACE_RADIUS = 160;
  const EARLY_GAME_TRIBE_TOPOLOGY_MIN_SLICE_TILES = 128;
  const EARLY_GAME_TRIBE_TOPOLOGY_MAX_SLICE_TILES = 2048;
  const EARLY_GAME_TRIBE_TOPOLOGY_SLICE_MS = 4;
  // Food-race signals compare each visible tribe against all current rivals.
  // Preserve that complete strategic view, but never evaluate a crowded map in
  // one browser task.
  const EARLY_GAME_TRIBE_NODE_SLICE_MS = 4;
  const EARLY_GAME_MARITIME_SLICE_WORK = 20_000;
  const EARLY_GAME_MARITIME_SLICE_MS = 4;
  // The game's troop growth is (10 + troops^0.73 / 4) * (1 - troops / max).
  // Keep the formula constants here so the reserve follows the real production
  // curve instead of relying on its approximate 42% peak ratio.
  const ATTACK_EARLY_GAME_GROWTH_BASE = 10;
  const ATTACK_EARLY_GAME_GROWTH_EXPONENT = 0.73;
  const ATTACK_EARLY_GAME_GROWTH_DIVISOR = 4;
  const ATTACK_EARLY_GAME_PEAK_SEARCH_ITERATIONS = 64;
  const ATTACK_EARLY_GAME_ACCELERATION_SCAN_POINTS = 128;
  // OpenFront's Config.falloutDefenseModifier(falloutRatio) multiplies the
  // direct troop loss on radioactive TerraNullius tiles by 5 - 2 * ratio.
  // Keep the source values here so the radioactive commit is derived from the
  // live map instead of using a second arbitrary percentage.
  const ATTACK_FALLOUT_DEFENSE_BASE = 5;
  const ATTACK_FALLOUT_DEFENSE_RATIO_SLOPE = 2;
  const ATTACK_FALLOUT_RESERVE_RATIO = 0.42;
  // Tribes have no strategic counterplay comparable to Nations. A small capture
  // margin lets the opening spread across many tribes in parallel instead of
  // parking four times their strength in one conquest.
  const TRIBE_CAPTURE_TROOP_MULTIPLIER = 2.5;
  const PLAYER_CAPTURE_TROOP_MULTIPLIER = 4;
  // Once aggregate hostile incoming troops match our whole current army, a
  // counterattack removes the exact troops needed at home while still failing
  // to cover the simultaneous invasion. Keep that projected defense budget
  // home and let the defensive construction lane use its accelerated cadence.
  const OVERWHELMING_INCOMING_ATTACK_RATIO = 1;
  // Reserve the troop level where the production rate has its maximum temporal
  // acceleration. P(N) is troops per tick and N' = P(N), so acceleration is
  // dP/dt = P(N) * P'(N), not just the slope with respect to troop count.
  // Intents are asynchronous on the client: the troop balance and outgoing
  // attack snapshot can lag the emitted command by several game ticks.
  const BOT_OUTBOUND_INTENT_GRACE_TICKS = 6;
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

  function yieldEarlyGameTopologyWork() {
    return new Promise((resolve) => {
      if (
        typeof window !== "undefined" &&
        typeof window.setTimeout === "function"
      ) {
        window.setTimeout(resolve, 0);
      } else if (typeof setTimeout === "function") {
        setTimeout(resolve, 0);
      } else {
        resolve();
      }
    });
  }

  function earlyGameTopologyNow() {
    if (
      typeof window !== "undefined" &&
      typeof window.__OFH_deadlineNow === "function"
    ) {
      return Number(window.__OFH_deadlineNow());
    }
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  function shouldYieldEarlyGameTopology(tiles, startedAt) {
    if (tiles >= EARLY_GAME_TRIBE_TOPOLOGY_MAX_SLICE_TILES) return true;
    if (
      tiles < EARLY_GAME_TRIBE_TOPOLOGY_MIN_SLICE_TILES ||
      tiles % EARLY_GAME_TRIBE_TOPOLOGY_MIN_SLICE_TILES !== 0
    ) {
      return false;
    }
    return earlyGameTopologyNow() - startedAt >= EARLY_GAME_TRIBE_TOPOLOGY_SLICE_MS;
  }

  function shouldYieldEarlyGameTribeNodes(startedAt) {
    return earlyGameTopologyNow() - startedAt >= EARLY_GAME_TRIBE_NODE_SLICE_MS;
  }

  function profileAttackSync(profile, name, action) {
    if (typeof autoBotProfileSyncPhase === "function") {
      return autoBotProfileSyncPhase(profile, name, action);
    }
    return action();
  }

  function profileAttackAsync(profile, name, action) {
    if (typeof autoBotProfileAsyncPhase === "function") {
      return autoBotProfileAsyncPhase(profile, name, action);
    }
    return action();
  }

  // A parallel attack batch must stop before it walks every target after the
  // shared client intent budget is exhausted. Keep the fallback permissive for
  // isolated/unit test loads that do not include the shared rate-limit module;
  // the final emit gate remains authoritative in the full userscript build.
  function hasAttackIntentRateCapacity() {
    return (
      typeof hasIntentRateLimitCapacity !== "function" ||
      hasIntentRateLimitCapacity()
    );
  }

  function earlyGameTroopGrowthRate(troops, maximum) {
    if (maximum <= 0) return 0;

    const boundedTroops = Math.max(0, Math.min(maximum, troops));
    return (
      ATTACK_EARLY_GAME_GROWTH_BASE +
      Math.pow(boundedTroops, ATTACK_EARLY_GAME_GROWTH_EXPONENT) /
        ATTACK_EARLY_GAME_GROWTH_DIVISOR
    ) * (1 - boundedTroops / maximum);
  }

  function earlyGameTroopGrowthDerivative(troops, maximum) {
    if (troops <= 0) return Infinity;
    if (troops >= maximum) return -Infinity;

    const exponent = ATTACK_EARLY_GAME_GROWTH_EXPONENT;
    const power = Math.pow(troops, exponent);
    return (
      (exponent * Math.pow(troops, exponent - 1)) /
        ATTACK_EARLY_GAME_GROWTH_DIVISOR *
        (1 - troops / maximum) -
      (ATTACK_EARLY_GAME_GROWTH_BASE + power / ATTACK_EARLY_GAME_GROWTH_DIVISOR) /
        maximum
    );
  }

  function earlyGameTroopGrowthSecondDerivative(troops, maximum) {
    if (troops <= 0) return -Infinity;

    const exponent = ATTACK_EARLY_GAME_GROWTH_EXPONENT;
    return (
      (exponent * (exponent - 1)) /
        ATTACK_EARLY_GAME_GROWTH_DIVISOR *
        Math.pow(troops, exponent - 2) *
        (1 - troops / maximum) -
      (exponent / (2 * maximum)) * Math.pow(troops, exponent - 1)
    );
  }

  function earlyGameTroopAccelerationSlope(troops, maximum) {
    const production = earlyGameTroopGrowthRate(troops, maximum);
    const productionSlope = earlyGameTroopGrowthDerivative(troops, maximum);
    return (
      productionSlope * productionSlope +
      production * earlyGameTroopGrowthSecondDerivative(troops, maximum)
    );
  }

  function earlyGameTroopAcceleration(troops, maximum) {
    return (
      earlyGameTroopGrowthRate(troops, maximum) *
      earlyGameTroopGrowthDerivative(troops, maximum)
    );
  }

  function findAccelerationSlopeRoot(low, high, maximum) {
    for (
      let iteration = 0;
      iteration < ATTACK_EARLY_GAME_PEAK_SEARCH_ITERATIONS;
      iteration++
    ) {
      const middle = (low + high) / 2;
      if (earlyGameTroopAccelerationSlope(middle, maximum) > 0) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  }

  function findEarlyGameTroopGrowthPeak(maximum) {
    let low = 0;
    let high = maximum;
    for (
      let iteration = 0;
      iteration < ATTACK_EARLY_GAME_PEAK_SEARCH_ITERATIONS;
      iteration++
    ) {
      const middle = (low + high) / 2;
      if (earlyGameTroopGrowthDerivative(middle, maximum) > 0) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return (low + high) / 2;
  }

  function findEarlyGameTroopAccelerationPeak(maximum) {
    const productionPeak = findEarlyGameTroopGrowthPeak(maximum);
    const lowerBound = Math.min(1, productionPeak);
    if (productionPeak <= lowerBound) return productionPeak;

    const logLow = Math.log(lowerBound);
    const logHigh = Math.log(productionPeak);
    let previousTroops = lowerBound;
    let previousSlope = earlyGameTroopAccelerationSlope(
      previousTroops,
      maximum,
    );
    let bestTroops = previousTroops;
    let bestAcceleration = earlyGameTroopAcceleration(
      previousTroops,
      maximum,
    );

    for (
      let sample = 1;
      sample <= ATTACK_EARLY_GAME_ACCELERATION_SCAN_POINTS;
      sample++
    ) {
      const currentTroops = Math.exp(
        logLow + ((logHigh - logLow) * sample) /
          ATTACK_EARLY_GAME_ACCELERATION_SCAN_POINTS,
      );
      const currentSlope = earlyGameTroopAccelerationSlope(
        currentTroops,
        maximum,
      );
      const currentAcceleration = earlyGameTroopAcceleration(
        currentTroops,
        maximum,
      );
      if (currentAcceleration > bestAcceleration) {
        bestTroops = currentTroops;
        bestAcceleration = currentAcceleration;
      }

      // Locate a positive-to-negative slope crossing: that is the local
      // maximum of temporal acceleration, after the initial boundary region.
      if (previousSlope > 0 && currentSlope <= 0) {
        const candidate = findAccelerationSlopeRoot(
          previousTroops,
          currentTroops,
          maximum,
        );
        const candidateAcceleration = earlyGameTroopAcceleration(
          candidate,
          maximum,
        );
        if (candidateAcceleration > bestAcceleration) {
          bestTroops = candidate;
        }
        break;
      }

      previousTroops = currentTroops;
      previousSlope = currentSlope;
    }

    return bestTroops;
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

  function cappedDefensePostInputs(frontTiles, defensePosts) {
    return {
      tiles: Array.from(new Set(frontTiles ?? [])).slice(
        0,
        ENEMY_DEFENSE_POST_MAX_FRONT_TILES,
      ),
      posts: Array.from(defensePosts ?? []).slice(
        0,
        ENEMY_DEFENSE_POST_MAX_SCAN_POSTS,
      ),
    };
  }

  function safeDefensePostBonus(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 1 ? numeric : fallback;
  }

  function defensePostCoversTile(post, frontTile, distanceSquared, rangeSquared) {
    if (post.tile == null || typeof distanceSquared !== "function") return false;
    {
      const distance = Number(distanceSquared(post.tile, frontTile));
      return Number.isFinite(distance) && distance <= rangeSquared;
    }
  }

  function coveredDefensePostFrontTiles(tiles, posts, distanceSquared, rangeSquared) {
    let covered = 0;
    for (const tile of tiles) {
      if (posts.some((post) => defensePostCoversTile(post, tile, distanceSquared, rangeSquared))) {
        covered++;
      }
    }
    return covered;
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
    const { tiles, posts } = cappedDefensePostInputs(frontTiles, defensePosts);
    const operationalPostCount = posts.length;
    if (tiles.length === 0 || posts.length === 0) {
      return {
        ...emptyDefensePostAttackProfile(),
        operationalPostCount,
      };
    }

    const range = Number(defensePostRange);
    const rangeSquared =
      Number.isFinite(range) && range > 0 ? range * range : 0;
    const safeDefenseBonus = safeDefensePostBonus(
      defensePostDefenseBonus,
      ENEMY_DEFENSE_POST_DEFENSE_BONUS,
    );
    const safeSpeedBonus = safeDefensePostBonus(
      defensePostSpeedBonus,
      ENEMY_DEFENSE_POST_SPEED_BONUS,
    );
    const coveredFrontTileCount = coveredDefensePostFrontTiles(
      tiles,
      posts,
      distanceSquared,
      rangeSquared,
    );

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

  function isEarlyGameMaritimeCacheKey(value) {
    return value && (typeof value === "object" || typeof value === "function");
  }

  function playersShareClanTag(left, right) {
    {
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
    }
  }

  function rankTeamDonationCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => {
        const leftUnderAttack = left.candidate.underAttack === true ? 1 : 0;
        const rightUnderAttack = right.candidate.underAttack === true ? 1 : 0;
        if (leftUnderAttack !== rightUnderAttack) {
          return rightUnderAttack - leftUnderAttack;
        }

        const leftFrontline = left.candidate.frontline === true ? 1 : 0;
        const rightFrontline = right.candidate.frontline === true ? 1 : 0;
        if (leftFrontline !== rightFrontline) {
          return rightFrontline - leftFrontline;
        }

        const leftDistance = Number(left.candidate.distance);
        const rightDistance = Number(right.candidate.distance);
        const normalizedLeftDistance = Number.isFinite(leftDistance)
          ? leftDistance
          : Number.POSITIVE_INFINITY;
        const normalizedRightDistance = Number.isFinite(rightDistance)
          ? rightDistance
          : Number.POSITIVE_INFINITY;
        if (normalizedLeftDistance !== normalizedRightDistance) {
          return normalizedLeftDistance - normalizedRightDistance;
        }

        const leftPercentage = Number(left.candidate.troopPercentage);
        const rightPercentage = Number(right.candidate.troopPercentage);
        if (leftPercentage !== rightPercentage) {
          return leftPercentage - rightPercentage;
        }

        const leftClan = left.candidate.sameClan === true ? 1 : 0;
        const rightClan = right.candidate.sameClan === true ? 1 : 0;
        if (leftClan !== rightClan) return rightClan - leftClan;
        return left.index - right.index;
      })
      .map(({ candidate }) => candidate);
  }

  function recordOptionalAttackSnapshotFailure(error) {
    state.optionalAttackSnapshotFailures =
      (Number(state.optionalAttackSnapshotFailures) || 0) + 1;
    if (state.settings.performanceProfiling === true) {
      console.warn("[AutoBot] optional attack snapshot unavailable:", error);
    }
  }

  function normalizeCaptureEfficiency(candidate, maximum) {
    if (!isEarlyGameTribeActionable(candidate)) return 0;
    return maximum > 0
      ? candidate.captureEfficiencyRaw / maximum
      : candidate.cheapCapture;
  }

  function recordTribeBoundaryOwner(result, player, ownerSid, mySid, playersBySid) {
    if (ownerSid === mySid) {
      result.ownEdges += 1;
      return;
    }
    if (ownerSid == null) return;
    result.externalEdges += 1;
    result.externalSids.add(ownerSid);
    const owner = playersBySid.get(ownerSid);
    if (owner && player.isFriendly(owner) === true) result.alliedEdges += 1;
  }

  function analyzeTribeBoundary({ game, player, border, tribeSid, mySid, playersBySid }) {
    const result = {
      boundaryEdges: 0,
      ownEdges: 0,
      externalEdges: 0,
      alliedEdges: 0,
      externalSids: new Set(),
    };
    for (const tile of border) {
      for (const neighbor of game.neighbors(tile)) {
        if (!game.isLand(neighbor)) continue;
        const ownerSid = game.ownerID(neighbor);
        if (ownerSid === tribeSid) continue;
        result.boundaryEdges += 1;
        recordTribeBoundaryOwner(result, player, ownerSid, mySid, playersBySid);
      }
    }
    return result;
  }

  function normalizeAttackBehaviorArgs(args) {
    if (args.length === 1 && args[0] && typeof args[0] === "object") return args[0];
    const [
      random, game, player, triggerRatio, reserveRatio, expandRatio,
      allianceBehavior, emojiBehavior,
    ] = args;
    return {
      random, game, player, triggerRatio, reserveRatio, expandRatio,
      allianceBehavior, emojiBehavior,
    };
  }

  class AttackBehavior {
    constructor(...args) {
      const {
      random, game, player, triggerRatio, reserveRatio, expandRatio,
      allianceBehavior, emojiBehavior,
      } = normalizeAttackBehaviorArgs(args);
      this.random = random;
      this.game = game;
      this.player = player;
      this.triggerRatio = triggerRatio;
      this.reserveRatio = reserveRatio;
      this.expandRatio = expandRatio;
      this.allianceBehavior = allianceBehavior;
      this.emojiBehavior = emojiBehavior;

      this.botAttackTroopsSent = 0;
      this.botAttackPendingIntentCommitments = [];
      this.outboundIntentReconciledTick = null;
      this.botPendingDonationIntentCommitments = [];
      this.outboundDonationIntentReconciledTick = null;
      this.botDonationNextEligibleTickByRecipient = new Map();
      this.earlyGamePeakReserveCacheKey = null;
      this.earlyGamePeakReserveCache = 0;
      this.earlyGameProductionPeakReserveCacheKey = null;
      this.earlyGameProductionPeakReserveCache = 0;
      this.terraNulliusSafetyTroopHighWater = 0;
      this.terraNulliusOpeningStartTick = null;
      this.terraNulliusOpeningTroops = 0;
      this.terraNulliusOpeningCommittedTroops = 0;
      this.strongestBorderOpponentTroopsCacheTick = null;
      this.strongestBorderOpponentTroopsCacheIncludeFriendly = null;
      this.strongestBorderOpponentTroopsCache = null;
      // Small per-player memory used by the early-game food-race policy. It is
      // intentionally local to this persistent behavior instance and bounded to
      // the players visible in the current game snapshot.
      this.earlyFoodMovement = new Map();
      // The shared WeakMap below owns the terrain index; this local reference
      // avoids even the lookup after the first candidate pass.
      this.earlyGameMaritimeIndex = undefined;
      this.earlyGameMaritimeIndexBuilder = undefined;
      this.earlyGameMaritimeWaterCache = new Map();
      this.earlyGameMaritimeWaterState = null;
      this.earlyGameMaritimeWaterQueue = null;
      this.earlyGameMaritimeWaterQueueHead = 0;
      this.earlyGameMaritimeWaterQueueTail = 0;
      this.earlyGameMaritimeWaterTraversalTile = null;
      this.earlyGameMaritimeWaterTraversalFoundOpen = false;
      this.earlyGameMaritimeSliceWorkRemaining = Infinity;
      this.earlyGameMaritimeSliceDeadline = Infinity;
      this.earlyGameMaritimeSliceDeadlineProbe = 0;
      this.opportunisticBoatSurgeTickByTile = new Map();
      this.earlyGamePreferredClusterTargetKeys = new Set();
      this.resetEarlyGameTribeTopologyCache();
      this.earlyGameTribeBoatEtaCache = new Map();
      // Opportunistic boat selection proves a route before returning a target,
      // then emission checks that identical target again. Keep the authoritative
      // ETA only for the current game tick: it eliminates duplicate worker
      // pathfinding in one decision without carrying a route across a changing
      // frontier.
      this.resetBoatRouteEtaCache();
      // A destination that just failed the route gate is unlikely to become
      // reachable before another opening decision. Keep this instance-local so
      // a fresh game never inherits a stale water-path result.
      this.earlyOceanProbeRetryTicks = new Map();
      // Defense-post reads are bounded and reused across all target decisions
      // made in the same game tick. This keeps the extra combat intelligence out
      // of the high-frequency engine poll loop.
      this.enemyDefensePostCacheTick = -1;
      this.enemyDefensePostUnitsCache = new Map();
      this.enemyDefensePostProfileCache = new Map();
      this.enemyDefensePostFrontByTarget = new Map();
      this.enemyDefensePostFrontSeenByTarget = new Map();
    }

    enemyDefensePostPolicyEnabled() {
      return state.settings?.winFixes === true;
    }

    currentAttackDecisionTick() {
      {
        const tick = Number(this.game?.ticks?.());
        return Number.isFinite(tick) ? tick : 0;
      }
    }

    resetBoatRouteEtaCache(tick = null) {
      this.boatRouteEtaCacheTick = tick;
      this.boatRouteEtaCache = new Map();
    }

    resetEarlyGameTribeTopologyCache() {
      this.earlyGameTribeTopologyCache = null;
      this.earlyGamePreferredClusterOverlaySignature = "";
    }

    getOutboundAttackTargetKey(target) {
      if (target?.isPlayer?.() !== true) return null;
      const smallID = target.smallID?.();
      if (smallID != null) return String(smallID);
      const id = target.id?.();
      return id == null ? null : String(id);
    }

    getActiveTribeAttackTargetKeys() {
      this.reconcileOutboundAttackIntentCommitments();
      const targetKeys = new Set();

      for (const entry of this.botAttackPendingIntentCommitments) {
        if (!entry?.targetIsPlayer || entry.targetKey == null) continue;
        targetKeys.add(String(entry.targetKey));
      }

      for (const entry of this.getOutboundAttackSnapshot()) {
        if (!entry.targetIsPlayer || entry.targetKey == null) continue;
        targetKeys.add(String(entry.targetKey));
      }

      return targetKeys;
    }

    getLiveOutboundAttackTroopsForTarget(target) {
      const targetKey = this.getOutboundAttackTargetKey(target);
      if (targetKey == null) return 0;
      return this.getOutboundAttackSnapshot()
        .filter(
          (entry) =>
            entry.targetIsPlayer === true && entry.targetKey === targetKey,
        )
        .reduce((total, entry) => total + entry.troops, 0);
    }

    getPendingOutboundAttackTroopsForTarget(target) {
      // Adequacy checks may run after the live attack snapshot changes within
      // the same tick. Reconcile again here so one payload cannot be counted as
      // both a visible attack and a still-pending intent.
      this.reconcileOutboundAttackIntentCommitments(
        this.currentAttackDecisionTick(),
        true,
      );
      const targetKey = this.getOutboundAttackTargetKey(target);
      if (targetKey == null) return 0;
      return this.botAttackPendingIntentCommitments
        .filter(
          (entry) =>
            entry?.targetIsPlayer === true && entry.targetKey === targetKey,
        )
        .reduce(
          (total, entry) => total + Math.max(0, Number(entry.troops) || 0),
          0,
        );
    }

    getCommittedOutboundAttackTroopsForTarget(target) {
      return (
        this.getLiveOutboundAttackTroopsForTarget(target) +
        this.getPendingOutboundAttackTroopsForTarget(target)
      );
    }

    getActiveOutboundPlayerTargets() {
      const playersByKey = new Map();
      for (const entry of this.getOutboundAttackSnapshot()) {
        const target = entry.target;
        if (target?.isPlayer?.() !== true) continue;
        const key = this.getOutboundAttackTargetKey(target);
        if (key != null) playersByKey.set(key, target);
      }
      return [...playersByKey.values()];
    }

    getActiveOutboundTribeTargets() {
      return this.getActiveOutboundPlayerTargets().filter(
        (target) => target.type?.() === PlayerType.Bot,
      );
    }

    getOutboundAttackSnapshot() {
      let outgoing;
      {
        outgoing = this.player.outgoingAttacks?.() || [];
      }
      return outgoing
        .map((attack) => {
        {
          if (attack.retreating?.()) return null;
          const target = attack.target?.();
          const targetIsPlayer = target?.isPlayer?.() === true;
          return {
            attack,
            id: attack.id?.(),
            target,
            targetIsPlayer,
            targetKey: targetIsPlayer
              ? this.getOutboundAttackTargetKey(target)
              : null,
            troops: Math.max(0, Number(attack.troops?.() || 0)),
          };
        }
      })
        .filter(Boolean);
    }

    getOutboundTransportSnapshot() {
      const transportType =
        typeof UNIT !== "undefined" ? UNIT.TransportShip : null;
      if (transportType == null || typeof this.player.units !== "function") {
        return [];
      }
      let units;
      {
        units = this.player.units(transportType) || [];
      }
      return units
        .map((unit) => {
        {
          if (
            typeof unit?.isActive === "function" &&
            unit.isActive() === false
          ) {
            return null;
          }
          const targetTile = unit.targetTile?.();
          if (targetTile == null) return null;
          const transportState = unit.transportShipState?.();
          if (transportState?.isRetreating === true) return null;
          return {
            unit,
            id: unit.id?.(),
            targetTile,
            troops: Math.max(0, Number(unit.troops?.() || 0)),
          };
        }
      })
        .filter(Boolean);
    }

    recordOutboundAttackIntent(
      target,
      troops,
      { attackType = "land", destination = null } = {},
    ) {
      const amount = Math.max(0, Number(troops) || 0);
      if (amount <= 0) return;

      const targetIsPlayer = target?.isPlayer?.() === true;
      if (!targetIsPlayer) {
        this.terraNulliusOpeningCommittedTroops =
          (Number(this.terraNulliusOpeningCommittedTroops) || 0) + amount;
      }
      const targetKey = targetIsPlayer
        ? this.getOutboundAttackTargetKey(target)
        : null;
      const baselineAttacks = this.getOutboundAttackSnapshot();
      const baselineTransports = this.getOutboundTransportSnapshot();
      const targetAttacks = baselineAttacks.filter((entry) =>
        targetIsPlayer
          ? entry.targetIsPlayer && entry.targetKey === targetKey
          : !entry.targetIsPlayer,
      );
      this.botAttackPendingIntentCommitments.push({
        targetIsPlayer,
        targetKey,
        attackType,
        destination,
        troops: amount,
        createdTick: this.currentAttackDecisionTick(),
        baselineTroops: Math.max(0, Number(this.player?.troops?.() || 0)),
        baselineTargetTroops: targetAttacks.reduce(
          (total, entry) => total + entry.troops,
          0,
        ),
        baselineDestinationTroops: baselineTransports
          .filter((entry) =>
            destination == null ? false : entry.targetTile === destination,
          )
          .reduce((total, entry) => total + entry.troops, 0),
        baselineAttackIDs: new Set(
          targetAttacks.map((entry) => entry.id).filter((id) => id != null),
        ),
        baselineTransportIDs: new Set(
          baselineTransports.map((entry) => entry.id).filter((id) => id != null),
        ),
      });
    }

    outboundTransportCandidateMatches(candidate, entry, context, amount) {
      if (candidate.targetTile !== entry.destination) return false;
      if (context.usedTransportObjects.has(candidate.unit)) return false;
      if (candidate.id != null && context.usedTransportIDs.has(candidate.id)) return false;
      const isNew =
        candidate.id != null &&
        !entry.baselineTransportIDs?.has(candidate.id) &&
        !entry.baselineTransportIDs?.has(String(candidate.id));
      const baseline = Number(entry.baselineDestinationTroops) || 0;
      return isNew || candidate.troops >= Math.max(1, baseline + amount * 0.25);
    }

    reconcileOutboundTransport(entry, context, amount) {
      if (entry.attackType !== "boat" || entry.destination == null) return false;
      const live = context.transports.find((candidate) =>
        this.outboundTransportCandidateMatches(candidate, entry, context, amount),
      );
      if (!live) return false;
      context.usedTransportObjects.add(live.unit);
      if (live.id != null) context.usedTransportIDs.add(live.id);
      return true;
    }

    outboundAttacksForEntry(entry, attacks) {
      return attacks.filter((candidate) => {
        if (!entry.targetIsPlayer) return !candidate.targetIsPlayer;
        return candidate.targetIsPlayer && candidate.targetKey === entry.targetKey;
      });
    }

    outboundAttackCandidateMatches(candidate, entry, context, currentTroops, amount) {
      if (context.usedAttackObjects.has(candidate.attack)) return false;
      if (candidate.id != null && context.usedAttackIDs.has(candidate.id)) return false;
      const isNew =
        candidate.id != null &&
        !entry.baselineAttackIDs?.has(candidate.id) &&
        !entry.baselineAttackIDs?.has(String(candidate.id));
      const baseline = Number(entry.baselineTargetTroops) || 0;
      return isNew || currentTroops >= Math.max(1, baseline + amount * 0.25);
    }

    reconcileOutboundVisibleAttack(entry, context, amount) {
      const matches = this.outboundAttacksForEntry(entry, context.attacks);
      const currentTroops = matches.reduce(
        (total, candidate) => total + candidate.troops,
        0,
      );
      const visible = matches.find((candidate) =>
        this.outboundAttackCandidateMatches(
          candidate,
          entry,
          context,
          currentTroops,
          amount,
        ),
      );
      if (!visible) return false;
      context.usedAttackObjects.add(visible.attack);
      if (visible.id != null) context.usedAttackIDs.add(visible.id);
      return true;
    }

    outboundTroopDropApplies(entry, context, amount) {
      const baseline = Math.max(0, Number(entry.baselineTroops) || 0);
      const drop = Math.max(
        0,
        baseline - context.ownTroops - context.consumedObservedTroopDrop,
      );
      if (drop < Math.max(1, amount * 0.5)) return false;
      context.consumedObservedTroopDrop += amount;
      return true;
    }

    outboundEntryRemainsPending(entry, tick, applied) {
      if (applied) return false;
      const createdTick = Number(entry.createdTick);
      const age = tick - (Number.isFinite(createdTick) ? createdTick : tick);
      return age <= BOT_OUTBOUND_INTENT_GRACE_TICKS;
    }

    reconcileOutboundAttackEntry(entry, context, tick) {
      const amount = Math.max(0, Number(entry.troops) || 0);
      if (amount <= 0) return false;
      let applied = this.reconcileOutboundTransport(entry, context, amount);
      if (!applied) applied = this.reconcileOutboundVisibleAttack(entry, context, amount);
      if (!applied) applied = this.outboundTroopDropApplies(entry, context, amount);
      return this.outboundEntryRemainsPending(entry, tick, applied);
    }

    reconcileOutboundAttackIntentCommitments(
      tick = this.currentAttackDecisionTick(),
      force = false,
    ) {
      if (!force && this.outboundIntentReconciledTick === tick) return;
      this.outboundIntentReconciledTick = tick;
      const pending = this.botAttackPendingIntentCommitments;
      if (!Array.isArray(pending) || pending.length === 0) return;

      const context = {
        attacks: this.getOutboundAttackSnapshot(),
        transports: this.getOutboundTransportSnapshot(),
        usedAttackIDs: new Set(),
        usedAttackObjects: new Set(),
        usedTransportIDs: new Set(),
        usedTransportObjects: new Set(),
        ownTroops: Math.max(0, Number(this.player?.troops?.() || 0)),
        consumedObservedTroopDrop: 0,
      };
      this.botAttackPendingIntentCommitments = pending.filter((entry) =>
        this.reconcileOutboundAttackEntry(entry, context, tick),
      );
    }

    getPendingOutboundAttackTroops() {
      this.reconcileOutboundAttackIntentCommitments();
      return this.botAttackPendingIntentCommitments.reduce(
        (total, entry) => total + Math.max(0, Number(entry.troops) || 0),
        0,
      );
    }

    getPendingTerraNulliusAttackTroops() {
      this.reconcileOutboundAttackIntentCommitments();
      return this.botAttackPendingIntentCommitments
        .filter((entry) => entry?.targetIsPlayer === false)
        .reduce(
          (total, entry) => total + Math.max(0, Number(entry.troops) || 0),
          0,
        );
    }

    recordOutboundDonationIntent(troops) {
      const amount = Math.max(0, Number(troops) || 0);
      if (amount <= 0) return;
      this.botPendingDonationIntentCommitments.push({
        troops: amount,
        createdTick: this.currentAttackDecisionTick(),
      });
    }

    reconcileOutboundDonationIntentCommitments(
      tick = this.currentAttackDecisionTick(),
    ) {
      if (this.outboundDonationIntentReconciledTick === tick) return;
      this.outboundDonationIntentReconciledTick = tick;
      const pending = this.botPendingDonationIntentCommitments;
      if (!Array.isArray(pending) || pending.length === 0) return;

      this.botPendingDonationIntentCommitments = pending.filter((entry) => {
        const createdTick = Number(entry.createdTick);
        const age =
          tick - (Number.isFinite(createdTick) ? createdTick : tick);
        return age <= BOT_OUTBOUND_INTENT_GRACE_TICKS;
      });
    }

    getPendingOutboundDonationTroops() {
      this.reconcileOutboundDonationIntentCommitments();
      return this.botPendingDonationIntentCommitments.reduce(
        (total, entry) => total + Math.max(0, Number(entry.troops) || 0),
        0,
      );
    }

    getPendingOutboundTroopCommitments() {
      return (
        this.getPendingOutboundAttackTroops() +
        this.getPendingOutboundDonationTroops()
      );
    }

    getEarlyGameLiveReserveTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      if (ownTroops <= 0) return 0;

      const maximum = this.getEarlyGameMaximumTroops(ownTroops);

      if (this.earlyGamePeakReserveCacheKey === maximum) {
        return this.earlyGamePeakReserveCache;
      }

      const reserveTroops = findEarlyGameTroopAccelerationPeak(maximum);
      const reserve = Math.max(
        1,
        Math.round(reserveTroops),
      );
      this.earlyGamePeakReserveCacheKey = maximum;
      this.earlyGamePeakReserveCache = reserve;
      return reserve;
    }

    getEarlyGameTerraNulliusReserveTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      if (ownTroops <= 0) return 0;

      this.terraNulliusSafetyTroopHighWater = Math.max(
        this.terraNulliusSafetyTroopHighWater,
        ownTroops,
      );

      const remainingOpeningCommitment =
        this.getRemainingTerraNulliusOpeningCommitment();
      if (Number.isFinite(remainingOpeningCommitment)) {
        const borderThreat = Math.max(
          0,
          Number(this.getStrongestBorderOpponentTroops()) || 0,
        );
        const openingSafetyFloor =
          this.terraNulliusSafetyTroopHighWater * (1 - EARLY_EXPAND_COMMIT);
        return Math.min(
          ownTroops,
          Math.max(
            ownTroops - remainingOpeningCommitment,
            openingSafetyFloor,
            borderThreat,
          ),
        );
      }

      // After the opening budget expires, TerraNullius expansion must never
      // cross the troop-production peak. The live reserve can raise this floor
      // further when border pressure warrants it.
      return Math.max(
        this.getEarlyGameProductionReserveTroops(),
        this.getEarlyGameLiveReserveTroops(),
        this.getStrongestStrategicBorderOpponentTroops(),
      );
    }

    getTerraNulliusOpeningCommitLimit() {
      const tick = this.currentAttackDecisionTick();
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      if (!Number.isFinite(this.terraNulliusOpeningStartTick)) {
        this.terraNulliusOpeningStartTick = tick;
        this.terraNulliusOpeningTroops = ownTroops;
      }

      const elapsed = Math.max(0, tick - this.terraNulliusOpeningStartTick);
      if (elapsed > 500) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.max(0, this.terraNulliusOpeningTroops * EARLY_EXPAND_COMMIT);
    }

    getTerraNulliusLivenessReserveTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      this.terraNulliusSafetyTroopHighWater = Math.max(
        this.terraNulliusSafetyTroopHighWater,
        ownTroops,
      );
      const borderThreat = Math.max(
        0,
        Number(this.getStrongestBorderOpponentTroops()) || 0,
      );
      return Math.max(
        borderThreat,
        this.terraNulliusSafetyTroopHighWater *
          (1 - EARLY_EXPAND_COMMIT) *
          (1 - EARLY_EXPAND_FOLLOWUP_COMMIT),
      );
    }

    getRemainingTerraNulliusOpeningCommitment() {
      return Math.max(
        0,
        this.getTerraNulliusOpeningCommitLimit() -
          (Number(this.terraNulliusOpeningCommittedTroops) || 0),
      );
    }

    getEarlyGameMaximumTroops(ownTroops = this.player?.troops?.() || 0) {
      const observedTroops = Math.max(0, Number(ownTroops) || 0);
      if (observedTroops <= 0) return 0;

      return Math.max(
        observedTroops,
        Number(this.game.config().maxTroops(this.player)) || observedTroops,
      );
    }

    getEarlyGameProductionReserveTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      if (ownTroops <= 0) return 0;

      const maximum = this.getEarlyGameMaximumTroops(ownTroops);
      if (this.earlyGameProductionPeakReserveCacheKey === maximum) {
        return this.earlyGameProductionPeakReserveCache;
      }

      // This is the first-derivative peak of troop production (~42% of max),
      // not the lower acceleration peak used by free-land and tribe actions.
      const reserve = Math.max(
        1,
        Math.round(findEarlyGameTroopGrowthPeak(maximum)),
      );
      this.earlyGameProductionPeakReserveCacheKey = maximum;
      this.earlyGameProductionPeakReserveCache = reserve;
      return reserve;
    }

    getRadioactiveTerraNulliusReserveTroops() {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      if (ownTroops <= 0) return 0;
      return (
        this.getEarlyGameMaximumTroops(ownTroops) *
        ATTACK_FALLOUT_RESERVE_RATIO
      );
    }

    isProductionReserveTarget(target) {
      if (!target?.isPlayer?.()) return false;
      const type = target.type?.();
      return type === PlayerType.Nation || type === PlayerType.Human;
    }

    getEarlyGameTargetReserveTroops(target) {
      const strategicBorderReserve =
        this.getStrongestStrategicBorderOpponentTroops();
      if (this.isProductionReserveTarget(target)) {
        return Math.max(
          this.getEarlyGameProductionReserveTroops(),
          strategicBorderReserve,
        );
      }
      return Math.max(
        target?.isPlayer?.()
          ? this.getEarlyGameLiveReserveTroops()
          : this.getEarlyGameTerraNulliusReserveTroops(),
        strategicBorderReserve,
      );
    }

    getLandAttackTargetReserveTroops(target, radioactiveTerraNullius) {
      if (!target.isPlayer() && radioactiveTerraNullius) {
        return this.getRadioactiveTerraNulliusReserveTroops();
      }
      return this.getEarlyGameTargetReserveTroops(target);
    }

    getEarlyGameSpendableTroops(reserveTroops = null) {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      // This is a hard safety floor for every troop outflow. It remains active
      // even when other winFixes are disabled: an emitted attack or donation must
      // never consume the reserve needed to keep production accelerating.
      const configuredReserve = Number(reserveTroops);
      const reserve =
        reserveTroops === null || !Number.isFinite(configuredReserve)
          ? this.getEarlyGameLiveReserveTroops()
          : Math.max(0, configuredReserve);
      const pending = this.getPendingOutboundTroopCommitments();
      return Math.max(0, ownTroops - reserve - pending);
    }

    hasBorderOpponentApi() {
      const game = this.game;
      const me = this.player;
      return Boolean(
        game &&
          me &&
          typeof me.borderTiles === "function" &&
          typeof me.smallID === "function" &&
          typeof game.neighbors === "function" &&
          typeof game.isLand === "function" &&
          typeof game.hasOwner === "function" &&
          typeof game.ownerID === "function" &&
          typeof game.players === "function",
      );
    }

    getBorderingPlayerIds(mySid) {
      const ids = new Set();
      for (const borderTile of this.player.borderTiles() ?? []) {
        for (const neighbor of this.game.neighbors(borderTile) ?? []) {
          if (!this.game.isLand(neighbor) || !this.game.hasOwner(neighbor)) continue;
          const ownerSid = this.game.ownerID(neighbor);
          if (ownerSid != null && ownerSid !== mySid) ids.add(ownerSid);
        }
      }
      return ids;
    }

    borderOpponentTroops(player, includeFriendly) {
      if (typeof player.isAlive !== "function") {
        throw new Error("border opponent life state is unavailable");
      }
      if (!player.isAlive()) return null;
      if (!includeFriendly) {
        if (typeof this.player.isFriendly !== "function") {
          throw new Error("border relation data is unavailable");
        }
        if (this.player.isFriendly(player) === true) return null;
      }
      if (typeof player.troops !== "function") {
        throw new Error("border opponent troops are unavailable");
      }
      const troops = Number(player.troops());
      if (!Number.isFinite(troops)) {
        throw new Error("border opponent troops are invalid");
      }
      return Math.max(0, troops);
    }

    calculateStrongestBorderOpponentTroops(includeFriendly) {
      if (!this.hasBorderOpponentApi()) {
        throw new Error("border troop data is unavailable");
      }
      const mySid = this.player.smallID();
      if (mySid == null) throw new Error("own player id is unavailable");
      const borderingIds = this.getBorderingPlayerIds(mySid);
      const players = Array.from(this.game.players() ?? []);
      const ownPlayerPresent = players.some(
        (player) => player?.smallID?.() === mySid,
      );
      if (!ownPlayerPresent) {
        throw new Error("own player is missing from the player snapshot");
      }

      let strongest = 0;
      const seen = new Set();
      for (const player of players) {
        const playerSid = player?.smallID?.();
        if (playerSid == null || !borderingIds.has(playerSid)) continue;
        seen.add(playerSid);
        const troops = this.borderOpponentTroops(player, includeFriendly);
        if (troops != null) strongest = Math.max(strongest, troops);
      }
      for (const playerSid of borderingIds) {
        if (!seen.has(playerSid)) {
          throw new Error("border opponent is missing from the player snapshot");
        }
      }
      return strongest;
    }

    getStrongestBorderOpponentTroops(includeFriendly = false) {
      const tick = this.currentAttackDecisionTick();
      if (
        this.strongestBorderOpponentTroopsCacheTick === tick &&
        this.strongestBorderOpponentTroopsCacheIncludeFriendly === includeFriendly
      ) {
        return this.strongestBorderOpponentTroopsCache;
      }

      let strongest;
      {
        strongest = this.calculateStrongestBorderOpponentTroops(includeFriendly);
      }

      this.strongestBorderOpponentTroopsCacheTick = tick;
      this.strongestBorderOpponentTroopsCacheIncludeFriendly = includeFriendly;
      this.strongestBorderOpponentTroopsCache = strongest;
      return strongest;
    }

    // A Nation/Human can assemble a decisive invasion from its border before
    // it becomes an incoming attack. Keep enough troops to meet that known
    // strategic army instead of exporting the defence into tribe captures.
    // Tribes deliberately do not raise this floor: they are the early-game
    // food source and their normal pressure is already handled by the capture
    // and incoming-attack policies.
    isStrategicBorderOpponent(player) {
      const type = player?.type?.();
      return type === PlayerType.Nation || type === PlayerType.Human;
    }

    calculateStrongestStrategicBorderOpponentTroops() {
      if (!this.hasBorderOpponentApi()) {
        throw new Error("strategic border troop data is unavailable");
      }
      const mySid = this.player.smallID();
      if (mySid == null) throw new Error("own player id is unavailable");
      const borderingIds = this.getBorderingPlayerIds(mySid);
      const players = Array.from(this.game.players() ?? []);
      const ownPlayerPresent = players.some(
        (player) => player?.smallID?.() === mySid,
      );
      if (!ownPlayerPresent) {
        throw new Error("own player is missing from the player snapshot");
      }

      let strongest = 0;
      const seen = new Set();
      for (const player of players) {
        const playerSid = player?.smallID?.();
        if (playerSid == null || !borderingIds.has(playerSid)) continue;
        seen.add(playerSid);
        if (!this.isStrategicBorderOpponent(player)) continue;
        const troops = this.borderOpponentTroops(player, false);
        if (troops != null) strongest = Math.max(strongest, troops);
      }
      for (const playerSid of borderingIds) {
        if (!seen.has(playerSid)) {
          throw new Error("border opponent is missing from the player snapshot");
        }
      }
      return strongest;
    }

    getStrongestStrategicBorderOpponentTroops() {
      // Older/client-minimal adapters can lack the complete border snapshot.
      // Without authoritative geometry, do not invent a strategic threat; the
      // ordinary production reserve remains in force.
      if (!this.hasBorderOpponentApi()) return 0;
      const tick = this.currentAttackDecisionTick();
      if (this.strongestStrategicBorderOpponentTroopsCacheTick === tick) {
        return this.strongestStrategicBorderOpponentTroopsCache;
      }
      const strongest = this.calculateStrongestStrategicBorderOpponentTroops();
      this.strongestStrategicBorderOpponentTroopsCacheTick = tick;
      this.strongestStrategicBorderOpponentTroopsCache = strongest;
      return strongest;
    }

    getEarlyGameProbeTroops(fraction = 0.01, reserveTroops = null) {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      const configuredFraction = Number(fraction);
      const probeFraction = Number.isFinite(configuredFraction)
        ? Math.max(0.01, configuredFraction)
        : 0.01;
      return Math.min(
        ownTroops * probeFraction,
        this.getEarlyGameSpendableTroops(reserveTroops),
      );
    }

    terraNulliusTileIsEligible(tile, requireUnowned) {
      if (typeof this.game?.isLand === "function" && !this.game.isLand(tile)) return false;
      if (requireUnowned && this.game.hasOwner(tile)) return false;
      return !(
        typeof this.game?.magnitude === "function" &&
        Number(this.game.magnitude(tile)) >= 31
      );
    }

    appendTerraNulliusFrontierNeighbors(borderTile, seen, frontier) {
      for (const tile of this.game.neighbors(borderTile) ?? []) {
        if (seen.has(tile)) continue;
        seen.add(tile);
        if (this.terraNulliusTileIsEligible(tile, true)) frontier.push(tile);
      }
    }

    getTerraNulliusFrontierTiles(preferredTile = null) {
      if (preferredTile != null) {
        return this.terraNulliusTileIsEligible(preferredTile, false)
          ? [preferredTile]
          : [];
      }
      if (
        typeof this.game?.neighbors !== "function" ||
        typeof this.game?.isLand !== "function" ||
        typeof this.game?.hasOwner !== "function"
      ) {
        return [];
      }

      return this.getTerraNulliusFrontierSnapshot().frontier;
    }

    getTerraNulliusFrontierSnapshot() {
      const border = this.player?.borderTiles?.() ?? [];
      const tick = this.currentAttackDecisionTick();
      const cached = this.terraNulliusFrontierCache;
      if (cached?.tick === tick && cached.border === border) return cached;

      const frontier = [];
      const attackableFrontier = [];
      const seen = new Set();
      for (const borderTile of border) {
        for (const tile of this.game.neighbors(borderTile) ?? []) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          if (this.isAttackableTerraNulliusTile(tile)) attackableFrontier.push(tile);
          if (this.terraNulliusTileIsEligible(tile, true)) frontier.push(tile);
        }
      }
      const snapshot = { tick, border, frontier, attackableFrontier };
      this.terraNulliusFrontierCache = snapshot;
      return snapshot;
    }

    terraNulliusEngineAttackLoss(target, tile, attackTroops) {
      {
        const attackLogic = this.game?.config?.()?.attackLogic;
        if (typeof attackLogic !== "function") return null;
        const result = attackLogic(
          this.game,
          attackTroops,
          this.player,
          target,
          tile,
        );
        const loss = Number(result?.attackerTroopLoss);
        return Number.isFinite(loss) && loss >= 0 ? loss : null;
      }
    }

    terraNulliusTerrainLoss(tile) {
      const magnitude = Number(this.game?.magnitude?.(tile));
      if (!Number.isFinite(magnitude)) return 1;
      let terrainLoss = 120;
      if (magnitude < 10) terrainLoss = 80;
      else if (magnitude < 20) terrainLoss = 100;
      const divisor = this.player?.type?.() === PlayerType.Bot ? 10 : 5;
      const falloutMultiplier = this.game?.hasFallout?.(tile)
        ? this.getRadioactiveTerraNulliusFalloutDefenseMultiplier()
        : 1;
      return (terrainLoss / divisor) * falloutMultiplier;
    }

    getTerraNulliusAttackLoss(target, tile) {
      const attackTroops = Math.max(1, Number(this.player?.troops?.() || 1));
      return (
        this.terraNulliusEngineAttackLoss(target, tile, attackTroops) ??
        this.terraNulliusTerrainLoss(tile)
      );
    }

    getTerraNulliusAvailableTroops(
      spendableTroops,
      bypassOpeningBudget = false,
    ) {
      const configured = Number(spendableTroops);
      const reserveSpendable =
        spendableTroops !== null && Number.isFinite(configured)
          ? Math.max(0, configured)
          : this.getEarlyGameSpendableTroops(
              this.getEarlyGameTerraNulliusReserveTroops(),
            );
      if (!state.settings.winFixes) return reserveSpendable;
      if (bypassOpeningBudget) return reserveSpendable;
      return Math.min(
        reserveSpendable,
        this.getRemainingTerraNulliusOpeningCommitment(),
      );
    }

    getTerraNulliusMinimumTroops(target, preferredTile) {
      const terraNullius = target || this.game?.terraNullius?.();
      let minimum = 1;
      for (const tile of this.getTerraNulliusFrontierTiles(preferredTile)) {
        const loss = this.getTerraNulliusAttackLoss(terraNullius, tile);
        if (Number.isFinite(loss) && loss > 0) {
          minimum = Math.max(minimum, Math.ceil(loss));
        }
      }
      return minimum;
    }

    getTerraNulliusFollowUpBudget(available, minimum, spendableTroops) {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      const followUpFraction =
        typeof EARLY_EXPAND_FOLLOWUP_COMMIT === "number"
          ? EARLY_EXPAND_FOLLOWUP_COMMIT
          : 0.1;
      const followUpTroops = Math.max(minimum, ownTroops * followUpFraction);
      if (available >= followUpTroops) {
        return { available, livenessFollowUp: false };
      }
      if (spendableTroops !== null) return null;
      const livenessAvailable = this.getEarlyGameSpendableTroops(
        this.getTerraNulliusLivenessReserveTroops(),
      );
      if (livenessAvailable < minimum) return 0;
      return {
        available: Math.min(livenessAvailable, followUpTroops),
        livenessFollowUp: true,
      };
    }

    getTerraNulliusCommittedTroops(
      available,
      minimum,
      commitFraction,
      livenessFollowUp,
      adaptivePayload,
    ) {
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      const followUpFraction =
        typeof EARLY_EXPAND_FOLLOWUP_COMMIT === "number"
          ? EARLY_EXPAND_FOLLOWUP_COMMIT
          : 0.1;
      const configured = Number(commitFraction);
      if (commitFraction !== null && Number.isFinite(configured)) {
        const bounded = Math.min(1, Math.max(0, configured));
        const minimumMargin =
          typeof EARLY_EXPAND_MINIMUM_MARGIN === "number"
            ? EARLY_EXPAND_MINIMUM_MARGIN
            : 1.25;
        const adaptiveTroops = Math.ceil(
          Math.max(minimum * minimumMargin, ownTroops * followUpFraction),
        );
        const perIntentCeiling = Math.max(minimum, ownTroops * bounded);
        return Math.min(available, adaptiveTroops, perIntentCeiling);
      }
      if (adaptivePayload) {
        return Math.min(
          available,
          Math.max(minimum, Math.ceil(ownTroops * followUpFraction)),
        );
      }
      return livenessFollowUp
        ? Math.max(minimum, Math.floor(available))
        : Math.min(available, minimum);
    }

    getTerraNulliusAttackTroops(
      target = null,
      preferredTile = null,
      spendableTroops = null,
      commitFraction = null,
      radioactiveTerraNullius = false,
    ) {
      const available = this.getTerraNulliusAvailableTroops(
        spendableTroops,
        radioactiveTerraNullius,
      );
      const minimum = this.getTerraNulliusMinimumTroops(target, preferredTile);
      const budget = this.getTerraNulliusFollowUpBudget(
        available,
        minimum,
        spendableTroops,
      );
      if (!budget) return 0;
      return this.getTerraNulliusCommittedTroops(
        budget.available,
        minimum,
        commitFraction,
        budget.livenessFollowUp,
        spendableTroops === null,
      );
    }

    resetEnemyDefensePostCaches() {
      const tick = this.currentAttackDecisionTick();
      if (this.enemyDefensePostCacheTick === tick) return;
      this.enemyDefensePostCacheTick = tick;
      this.enemyDefensePostUnitsCache.clear();
      this.enemyDefensePostProfileCache.clear();
      this.enemyDefensePostFrontByTarget.clear();
      this.enemyDefensePostFrontSeenByTarget.clear();
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
      const front = this.scanEnemyDefensePostFrontTiles(targetSid);
      this.enemyDefensePostFrontByTarget.set(targetSid, front);
      return front;
    }

    scanEnemyDefensePostFrontTiles(targetSid) {
      const front = [];
      for (const borderTile of this.player.borderTiles?.() ?? []) {
        for (const neighbor of this.game.neighbors(borderTile) ?? []) {
          if (!this.game.isLand(neighbor)) continue;
          if (this.game.ownerID(neighbor) !== targetSid) continue;
          front.push(neighbor);
          if (front.length >= ENEMY_DEFENSE_POST_MAX_FRONT_TILES) break;
        }
        if (front.length >= ENEMY_DEFENSE_POST_MAX_FRONT_TILES) break;
      }
      return front;
    }

    readEnemyDefensePostConfig(method, fallback) {
      {
        const config = this.game.config?.();
        const value =
          typeof config?.[method] === "function"
            ? config[method]()
            : config?.[method];
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
      }
    }

    tileDistanceSquared(left, right) {
      {
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
      {
        for (const unit of target.units?.(UNIT.DefensePost) ?? []) {
          const record = this.operationalEnemyDefensePostRecord(unit);
          if (record) operational.push(record);
        }
      }
      this.enemyDefensePostUnitsCache.set(targetSid, operational);
      return operational;
    }

    operationalEnemyDefensePostRecord(unit) {
      if (typeof unit.isActive === "function" && unit.isActive() === false) return null;
      if (unit.isUnderConstruction?.()) return null;
      const tile = typeof unit.tile === "function" ? unit.tile() : unit.tile;
      if (tile == null) return null;
      return {
        tile,
        x: typeof this.game.x === "function" ? Number(this.game.x(tile)) : NaN,
        y: typeof this.game.y === "function" ? Number(this.game.y(tile)) : NaN,
      };
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
    attackBorderTiles() {
      return Array.from(this.player.borderTiles())
        .flatMap((tile) => this.game.neighbors(tile))
        .filter(
          (tile) =>
            this.game.isLand(tile) &&
            this.game.ownerID(tile) !== this.player?.smallID(),
        );
    }

    borderingPlayersFrom(border, nearby) {
      const players = new Set(
        border
          .map((tile) => this.game.playerBySmallID(this.game.ownerID(tile)))
          .filter((owner) => owner?.isPlayer?.()),
      );
      for (const neighbor of nearby) {
        if (!neighbor.isPlayer() || players.has(neighbor)) continue;
        {
          if (this.player.sharesBorderWith(neighbor) === true) players.add(neighbor);
        }
      }
      return [...players].sort((left, right) => left.troops() - right.troops());
    }

    earlyGameTribeTargets(enemies, border) {
      return enemies
        .filter((enemy) => enemy.isPlayer() && enemy.type() === PlayerType.Bot)
        .map((enemy) => {
          const landBorder = border.some(
            (tile) => this.game.ownerID(tile) === enemy.smallID(),
          );
          return {
            id: enemy.smallID(),
            alive: enemy.isAlive(),
            friendly: this.player.isFriendly(enemy),
            landBorder,
            boatCandidate: !landBorder,
            seaReachableWithin30Ticks: false,
            boatEtaTicks: null,
          };
        });
    }

    publishAttackEarlyGameSnapshot(context) {
      const { hasAccessibleFreeLand, hasAccessibleTerraNullius } = context;
      const snapshot = createEarlyGameSnapshot({
        postSpawn: this.game.inSpawnPhase() === false && this.player.hasSpawned(),
        // Fallout is a late-game expansion target, not part of the opening
        // expansion window. Keep attacking it through the immediate land lane,
        // but do not let an unaffordable radioactive grab suppress troop
        // donations indefinitely.
        hasFreeLand: hasAccessibleFreeLand,
        tribes: this.earlyGameTribeTargets(context.borderingEnemies, context.border),
        boatRouteAvailable: this.game.hasTransportRouteEstimator === true,
      });
      const previous = state.earlyGame || {};
      state.earlyGame = {
        ...previous,
        ...snapshot,
        action: chooseEarlyGameAction({
          landTarget: hasAccessibleTerraNullius,
          tribeTarget: snapshot.hasTribeTarget,
          boatTarget: false,
        }),
        maritimeProbeSent: false,
        tribeTarget: null,
        oceanTarget: null,
        boatGate: null,
        lastBoatEtaTicks: null,
        boatRejectedUnknown: previous.boatRejectedUnknown || 0,
        boatRejectedTooFar: previous.boatRejectedTooFar || 0,
      };
      return snapshot;
    }

    createAttackDecisionContext() {
      const border = this.attackBorderTiles();
      const nearby = this.player.nearby();
      const hasAccessibleFreeLand = border.some(
        (tile) =>
          this.isAttackableTerraNulliusTile(tile) && !this.game.hasFallout(tile),
      );
      const hasAccessibleRadioactiveLand = border.some(
        (tile) =>
          this.isAttackableTerraNulliusTile(tile) && this.game.hasFallout(tile),
      );
      const hasAccessibleTerraNullius =
        hasAccessibleFreeLand || hasAccessibleRadioactiveLand;
      this.cacheEnemyDefensePostFrontTiles(border);
      const borderingPlayers = this.borderingPlayersFrom(border, nearby);
      const borderingFriends = borderingPlayers.filter(
        (player) => this.player?.isFriendly(player) === true,
      );
      const borderingEnemies = this.rankAttackTargets(
        borderingPlayers.filter(
          (player) => this.player?.isFriendly(player) === false,
        ),
      );
      const features = state.settings.features || {};
      const context = {
        border,
        nearby,
        borderingPlayers,
        borderingFriends,
        borderingEnemies,
        hasAccessibleFreeLand,
        hasAccessibleRadioactiveLand,
        hasAccessibleTerraNullius,
        hasNonNukedTerraNullius:
          hasAccessibleFreeLand || nearby.some((player) => !player.isPlayer()),
        hasMaritimeTerraNullius:
          !hasAccessibleTerraNullius &&
          nearby.some((player) => !player.isPlayer()),
        expandOn: Boolean(features.expand),
        boatOn: Boolean(features.boat),
        allianceOn: Boolean(features.alliance),
        maritimeTerraNulliusProbeSent: false,
      };
      context.earlyGameSnapshot = this.publishAttackEarlyGameSnapshot(context);
      return context;
    }

    disconnectedBorderingPlayers(players) {
      return players
        .filter((player) => {
        {
          return player.isPlayer() && player.isDisconnected?.() === true;
        }
      })
        .sort((left, right) => left.troops() - right.troops());
    }

    async tryImmediateAttackPriorities(context) {
      if (!context.expandOn || !state.settings.winFixes) return false;
      // Finish conquests already in flight before opening another front. Free
      // land is persistent; an underfunded tribe attack decays while the tribe
      // keeps producing troops and must not be starved by Terra Nullius.
      if (await this.reinforceIncompleteOutboundPlayerAttack()) return true;
      if (context.hasAccessibleTerraNullius) {
        const expanded = await this.sendAttack(
          this.game.terraNullius(),
          false,
          null,
          null,
          context.hasAccessibleRadioactiveLand,
        );
        if (expanded) return true;
      }
      const sleeping = this.disconnectedBorderingPlayers(context.borderingPlayers);
      if (sleeping.length === 0) return false;
      runtimeDebugLog(
        "[Takeover] disconnected neighbour → grabbing land:",
        sleeping[0].name?.() ?? sleeping[0].smallID?.(),
      );
      return this.sendAttack(sleeping[0]);
    }

    async tryMaritimeTerraNulliusProbe(context) {
      if (
        !context.expandOn ||
        !context.boatOn ||
        !state.settings.winFixes ||
        !context.hasMaritimeTerraNullius
      ) {
        return;
      }
      const sent = await this.sendAttack(
        this.game.terraNullius(),
        false,
        null,
        null,
        this.isBorderingNukedTerritory(),
      );
      this.setMaritimeTerraNulliusProbeSent(context, sent);
      if (!context.maritimeTerraNulliusProbeSent) return;
      state.earlyGame.action = "maritime-probe";
      state.earlyGame.maritimeProbeSent = true;
    }

    setMaritimeTerraNulliusProbeSent(context, sent) {
      context.maritimeTerraNulliusProbeSent = sent;
    }

    async tryEarlyAttackPolicies(context, profile = null) {
      const attackedTribe =
        context.expandOn &&
        state.settings.winFixes &&
        context.earlyGameSnapshot.postSpawn &&
        (await profileAttackAsync(profile, "attack-early-tribes", () =>
          this.attackEarlyGameTribe(profile)));
      if (attackedTribe) {
        state.earlyGame.action = "tribe";
      }
      // Resolve the strategic conquest first. A parallel Terra Nullius probe may
      // still use another coast, but emitBoat must not launch a second transport
      // to the exact destination already reserved by the conquest this tick.
      await profileAttackAsync(profile, "attack-early-maritime", () =>
        this.tryMaritimeTerraNulliusProbe(context));
      if (attackedTribe) return true;
      const canProbeOcean =
        context.expandOn &&
        context.boatOn &&
        state.settings.winFixes &&
        context.earlyGameSnapshot.active &&
        !context.maritimeTerraNulliusProbeSent;
      if (
        !canProbeOcean ||
        !(await profileAttackAsync(profile, "attack-early-ocean", () =>
          this.maybeEarlyOceanBoat()))
      ) {
        return false;
      }
      return !context.earlyGameSnapshot.hasTribeTarget;
    }

    async runAuxiliaryAttackPolicies(context, profile = null) {
      if (state.settings.winFixes) {
        await profileAttackAsync(profile, "attack-auxiliary-boat", () =>
          this.maybeOpportunisticBoat(profile));
      }
      if (state.settings.winFixes && state.settings.features.donate) {
        const now = performance.now();
        const throttle = state.settings.donateThrottleMs || 3000;
        const donated = profileAttackSync(profile, "attack-auxiliary-donate", () =>
          now - (state.lastDonateMs || 0) > throttle && this.donateTroops());
        if (donated) {
          state.lastDonateMs = now;
        }
      }
      if (context.allianceOn && state.settings.winFixes) {
        profileAttackSync(profile, "attack-auxiliary-alliance", () =>
          this.allianceBehavior.reachOutToFarNations());
      }
    }

    async tryAttackFallbacks(context) {
      const radioactive =
        state.settings.winFixes === true &&
        !context.hasAccessibleFreeLand &&
        this.isBorderingNukedTerritory();
      const shouldAttackTerra =
        context.expandOn &&
        ((!state.settings.winFixes && context.hasNonNukedTerraNullius) || radioactive);
      if (
        shouldAttackTerra &&
        (await this.sendAttack(
          this.game.terraNullius(),
          false,
          null,
          null,
          radioactive,
        ))
      ) {
        return true;
      }
      const hasBotEnemy = context.borderingEnemies.some(
        (enemy) => enemy.isPlayer() && enemy.type() === PlayerType.Bot,
      );
      if (
        context.expandOn &&
        state.settings.winFixes &&
        hasBotEnemy &&
        (await this.attackBots(context.nearby))
      ) {
        state.earlyGame.action = "tribe";
        return true;
      }
      return false;
    }

    async runOrdinaryAttackPolicies(context, profile = null) {
      if (context.borderingEnemies.length === 0) {
        if (context.boatOn && this.random.chance(5)) {
          await profileAttackAsync(profile, "attack-ordinary-boat", () =>
            this.attackWithRandomBoat());
        }
      } else {
        if (context.boatOn && this.random.chance(10)) {
          await profileAttackAsync(profile, "attack-ordinary-boat", () =>
            this.attackWithRandomBoat(context.borderingEnemies));
          return;
        }
        if (context.allianceOn) {
          this.allianceBehavior.maybeSendAllianceRequests(context.borderingEnemies);
        }
      }
      if (context.expandOn) {
        await profileAttackAsync(profile, "attack-ordinary-target", () =>
          this.attackBestTarget(
            context.borderingFriends,
            context.borderingEnemies,
            context.nearby,
          ));
      }
    }

    // maybeAttack — AiAttackBehavior.maybeAttack.
    async maybeAttack(profile = null) {
      if (this.player === null || this.allianceBehavior === undefined) {
        throw new Error("not initialized");
      }
      profileAttackSync(profile, "attack-intent-reconcile", () =>
        this.reconcileOutboundAttackIntentCommitments());
      const context = profileAttackSync(profile, "attack-context", () =>
        this.createAttackDecisionContext());
      let acted = false;
      if (state.settings.winFixes) {
        const defense = await profileAttackAsync(
          profile,
          "attack-defense",
          () => this.respondToIncomingAttack(),
        );
        if (defense !== null) return;
      }
      // A successful TerraNullius probe must not suppress the cluster planner.
      // These expansion lanes have independent intent accounting and the shared
      // rate limiter already caps total emissions, so let the tribe pass use any
      // safe surplus. Incoming defense has already returned above.
      if (
        await profileAttackAsync(profile, "attack-immediate", () =>
          this.tryImmediateAttackPriorities(context))
      ) {
        acted = true;
      }
      if (
        await profileAttackAsync(profile, "attack-early", () =>
          this.tryEarlyAttackPolicies(context, profile))
      ) {
        acted = true;
      }
      if (acted) return;
      await profileAttackAsync(profile, "attack-auxiliary", () =>
        this.runAuxiliaryAttackPolicies(context, profile));
      if (
        await profileAttackAsync(profile, "attack-fallbacks", () =>
          this.tryAttackFallbacks(context))
      ) {
        return;
      }
      await profileAttackAsync(profile, "attack-ordinary", () =>
        this.runOrdinaryAttackPolicies(context, profile));
    }

    // Opening Terra Nullius liveness runs more frequently than the strategic
    // attack cadence. Keep this path deliberately small: finish an active
    // conquest first, then emit one adjacent free-land intent without rebuilding
    // tribe topology, race scores, maritime ETAs, or overlay diagnostics.
    async continueOpeningExpansion() {
      this.reconcileOutboundAttackIntentCommitments();
      const defense = await this.respondToIncomingAttack();
      if (defense !== null) return false;
      if (await this.reinforceIncompleteOutboundPlayerAttack()) return true;
      if (!this.hasLandBorderWithTerraNullius()) return false;
      return this.sendLandAttack(this.game.terraNullius());
    }

    // Rank and eat several tribes during Early Game. This is a win-fix policy
    // layer, not a replacement for the faithful attack strategy order below.
    // Each successful capture reserves its own intent budget, so different
    // tribes can be invaded in the same decision without duplicating troops.
    earlyGameTribeDiagnostic(candidate) {
      const captureEfficiency =
        candidate.captureEfficiency == null
          ? candidate.cheapCapture
          : candidate.captureEfficiency;
      const withinSeaWindow =
        candidate.landBorder !== true &&
        Number.isFinite(candidate.boatEtaTicks) &&
        candidate.boatEtaTicks >= 0 &&
        candidate.boatEtaTicks <= getAutoDonateExpansionTickLimit();
      return {
        id: candidate.id,
        utility: Number(calculateEarlyGameTribeUtility(candidate).toFixed(3)),
        routeEfficiency: Number(calculateEarlyGameRouteEfficiency(candidate).toFixed(3)),
        captureEfficiency: Number(finiteEarlyGameSignal(captureEfficiency).toFixed(3)),
        targetTiles: Number(candidate.targetTiles) || 0,
        estimatedCaptureCost: Math.round(Number(candidate.estimatedCaptureCost)) || 0,
        maritimeDistance: Number.isFinite(candidate.maritimeDistance)
          ? candidate.maritimeDistance
          : null,
        oceanDistance: Number.isFinite(candidate.oceanDistance)
          ? candidate.oceanDistance
          : null,
        futureFoodCount: candidate.futureFoodCount,
        futureFoodAccess: Number(candidate.futureFoodAccess.toFixed(3)),
        tribeClusterAccess: Number(
          finiteEarlyGameSignal(candidate.tribeClusterAccess).toFixed(3),
        ),
        foodRaceValue: Number(candidate.foodRaceValue.toFixed(3)),
        alliedCutoffPressure: Number(
          finiteEarlyGameSignal(candidate.alliedCutoffPressure).toFixed(3),
        ),
        oceanGatewayUrgency: Number(
          finiteEarlyGameSignal(candidate.oceanGatewayUrgency).toFixed(3),
        ),
        encirclement: Number(candidate.encirclement.toFixed(3)),
        blockValue: Number(candidate.blockValue.toFixed(3)),
        cheapCapture: Number(candidate.cheapCapture.toFixed(3)),
        landBorder: candidate.landBorder,
        seaReachableWithin30Ticks: withinSeaWindow,
        boatEtaTicks: Number.isFinite(candidate.boatEtaTicks)
          ? candidate.boatEtaTicks
          : null,
        contestingPlayers: candidate.contestingPlayers,
      };
    }

    publishEarlyGameTribeDiagnostics(ranked) {
      if (!state.earlyGame) return;
      const targets = ranked.map((candidate) => this.earlyGameTribeDiagnostic(candidate));
      state.earlyGame.actionableTribes = targets;
      state.earlyGame.tribeTarget = targets[0] || null;
      if (targets.length === 0) return;
      state.earlyGame.active = true;
      state.earlyGame.hasTribeTarget = true;
    }

    prepareExistingTribeAttack(candidate, selectedTargetKeys, targetKey) {
      if (!selectedTargetKeys.has(targetKey)) return true;
      const liveCommitted = this.getLiveOutboundAttackTroopsForTarget(
        candidate.player,
      );
      const committed =
        liveCommitted +
        this.getPendingOutboundAttackTroopsForTarget(candidate.player);
      if (committed < 1) return false;
      candidate.existingCommittedTroops = liveCommitted;
      return true;
    }

    async launchEarlyGameTribeCandidate(candidate, selectedTargetKeys) {
      const targetKey = this.getOutboundAttackTargetKey(candidate.player);
      if (!this.prepareExistingTribeAttack(candidate, selectedTargetKeys, targetKey)) {
        return false;
      }
      {
        const launched = await this.sendAttack(
          candidate.player,
          false,
          null,
          candidate,
          false,
          true,
        );
        if (launched) selectedTargetKeys.add(targetKey);
        return launched;
      }
    }

    async attackEarlyGameTribe(profile = null) {
      const candidates = await profileAttackAsync(
        profile,
        "tribes-candidates",
        () => this.getEarlyGameTribeCandidates(profile),
      );
      if (candidates.length === 0) return false;

      this.botAttackTroopsSent = 0;
      const selectedTargetKeys = this.getActiveTribeAttackTargetKeys();
      const maxParallelAttacks = Math.max(1, this.getBotAttackMaxParallelism());
      let launchedAttacks = 0;
      const ranked = rankEarlyGameTribeCandidates(candidates);
      const strategicRanked = keepLargestTribeClusterCandidates(ranked);
      this.earlyGamePreferredClusterTargetKeys = new Set(
        strategicRanked
          .map((candidate) => this.getOutboundAttackTargetKey(candidate.player))
          .filter((key) => key != null),
      );
      this.publishEarlyGameTribeDiagnostics(ranked);

      for (const candidate of strategicRanked) {
        if (launchedAttacks >= maxParallelAttacks || !hasAttackIntentRateCapacity()) break;
        if (await this.launchEarlyGameTribeCandidate(candidate, selectedTargetKeys)) {
          launchedAttacks++;
        }
      }
      return launchedAttacks > 0;
    }

    // OpenFront marks the largest/open water body with `isOcean`, and that bit
    // propagates through connected water. Smaller rivers can still be a useful
    // maritime corridor when they leave through the map edge, while a closed
    // inland lake must remain excluded from this objective.
    earlyGameWaterIsOpen(tile) {
      {
        return (
          this.game.isOcean?.(tile) === true ||
          this.isEarlyGameMapEdge(tile)
        );
      }
    }

    appendEarlyGameWaterNeighbors(tile, seen, queue) {
      for (const next of this.game.neighbors(tile) ?? []) {
        if (seen.has(next) || !this.game.isWater(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    ensureDenseEarlyGameMaritimeWaterState() {
      if (this.earlyGameMaritimeWaterState) return true;
      const width = Number(this.game.width?.());
      const height = Number(this.game.height?.());
      const total = width * height;
      if (!Number.isSafeInteger(total) || total <= 0) return false;
      this.earlyGameMaritimeWaterState = new Uint8Array(total);
      this.earlyGameMaritimeWaterQueue = new Int32Array(total);
      return true;
    }

    enqueueDenseEarlyGameWaterNeighbor(next) {
      if (!Number.isInteger(next) || next < 0) return;
      const state = this.earlyGameMaritimeWaterState;
      if (next >= state.length) return;
      if (state[next] === 2) {
        this.earlyGameMaritimeWaterTraversalFoundOpen = true;
        return;
      }
      if (state[next] !== 0 || !this.game.isWater(next)) return;
      state[next] = 3;
      this.earlyGameMaritimeWaterQueue[this.earlyGameMaritimeWaterQueueTail++] = next;
    }

    appendDenseEarlyGameWaterNeighbors(tile) {
      if (typeof this.game.forEachNeighbor === "function") {
        this.game.forEachNeighbor(tile, (next) =>
          this.enqueueDenseEarlyGameWaterNeighbor(next));
        return;
      }
      for (const next of this.game.neighbors(tile) || []) {
        this.enqueueDenseEarlyGameWaterNeighbor(next);
      }
    }

    finalizeDenseEarlyGameMaritimeWaterTraversal(maritime) {
      const value = maritime ? 2 : 1;
      for (let index = 0; index < this.earlyGameMaritimeWaterQueueTail; index++) {
        this.earlyGameMaritimeWaterState[this.earlyGameMaritimeWaterQueue[index]] = value;
      }
      this.earlyGameMaritimeWaterQueueHead = 0;
      this.earlyGameMaritimeWaterQueueTail = 0;
      this.earlyGameMaritimeWaterTraversalTile = null;
      this.earlyGameMaritimeWaterTraversalFoundOpen = false;
      return maritime;
    }

    consumeEarlyGameMaritimeSliceWork(amount = 1) {
      if (!Number.isFinite(this.earlyGameMaritimeSliceWorkRemaining)) return false;
      this.earlyGameMaritimeSliceWorkRemaining -= amount;
      if (this.earlyGameMaritimeSliceWorkRemaining <= 0) return true;
      this.earlyGameMaritimeSliceDeadlineProbe += amount;
      if (this.earlyGameMaritimeSliceDeadlineProbe < 256) return false;
      this.earlyGameMaritimeSliceDeadlineProbe = 0;
      return earlyGameTopologyNow() >= this.earlyGameMaritimeSliceDeadline;
    }

    beginDenseEarlyGameMaritimeWaterTraversal(tile) {
      this.earlyGameMaritimeWaterState[tile] = 3;
      this.earlyGameMaritimeWaterQueue[0] = tile;
      this.earlyGameMaritimeWaterQueueHead = 0;
      this.earlyGameMaritimeWaterQueueTail = 1;
      this.earlyGameMaritimeWaterTraversalTile = tile;
      this.earlyGameMaritimeWaterTraversalFoundOpen = false;
    }

    advanceDenseEarlyGameMaritimeWaterTraversal() {
      while (
        this.earlyGameMaritimeWaterQueueHead <
        this.earlyGameMaritimeWaterQueueTail
      ) {
        const current =
          this.earlyGameMaritimeWaterQueue[
            this.earlyGameMaritimeWaterQueueHead++
          ];
        if (this.earlyGameWaterIsOpen(current)) {
          this.earlyGameMaritimeWaterTraversalFoundOpen = true;
          break;
        }
        this.appendDenseEarlyGameWaterNeighbors(current);
        if (this.earlyGameMaritimeWaterTraversalFoundOpen) break;
        if (this.consumeEarlyGameMaritimeSliceWork()) return null;
      }
      return this.finalizeDenseEarlyGameMaritimeWaterTraversal(
        this.earlyGameMaritimeWaterTraversalFoundOpen,
      );
    }

    isDenseEarlyGameMaritimeWater(tile) {
      const state = this.earlyGameMaritimeWaterState;
      if (!Number.isInteger(tile) || tile < 0 || tile >= state.length) return false;
      if (state[tile] === 1 || state[tile] === 2) return state[tile] === 2;
      if (this.earlyGameMaritimeWaterTraversalTile == null) {
        this.beginDenseEarlyGameMaritimeWaterTraversal(tile);
      } else if (state[tile] !== 3) {
        return null;
      }
      return this.advanceDenseEarlyGameMaritimeWaterTraversal();
    }

    isEarlyGameMaritimeWater(tile) {
      if (tile == null || typeof this.game.isWater !== "function") return false;
      if (this.earlyGameWaterIsOpen(tile)) return true;

      if (this.ensureDenseEarlyGameMaritimeWaterState()) {
        return this.isDenseEarlyGameMaritimeWater(tile);
      }

      if (this.earlyGameMaritimeWaterCache.has(tile)) {
        return this.earlyGameMaritimeWaterCache.get(tile) === true;
      }

      const queue = [tile];
      const seen = new Set([tile]);
      let maritime = false;
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        if (this.earlyGameWaterIsOpen(current)) {
          maritime = true;
          break;
        }
        this.appendEarlyGameWaterNeighbors(current, seen, queue);
      }

      for (const waterTile of seen) {
        this.earlyGameMaritimeWaterCache.set(waterTile, maritime);
      }
      return maritime;
    }

    isEarlyGameMapEdge(tile) {
      if (
        typeof this.game.width !== "function" ||
        typeof this.game.height !== "function" ||
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return false;
      }
      const width = Number(this.game.width());
      const height = Number(this.game.height());
      const x = Number(this.game.x(tile));
      const y = Number(this.game.y(tile));
      return (
        Number.isInteger(width) &&
        Number.isInteger(height) &&
        width > 0 &&
        height > 0 &&
        (x === 0 || y === 0 || x === width - 1 || y === height - 1)
      );
    }

    isEarlyGameMaritimeShore(tile) {
      if (tile == null || typeof this.game.isLand !== "function") return false;
      if (!this.game.isLand(tile)) return false;
      {
        if (this.game.isOceanShore?.(tile) === true) return true;
      }
      if (typeof this.game.isShore !== "function") return false;
      if (!this.game.isShore(tile)) return false;
      for (const neighbor of this.game.neighbors(tile) || []) {
        if (this.game.isWater?.(neighbor) !== true) continue;
        const maritime = this.isEarlyGameMaritimeWater(neighbor);
        if (maritime === null) return null;
        if (maritime) return true;
      }
      return false;
    }

    earlyGameMaritimeIndexOptions() {
      return {
        width: this.game.width(),
        height: this.game.height(),
        neighbors: (tile) => this.game.neighbors(tile),
        forEachNeighbor:
          typeof this.game.forEachNeighbor === "function"
            ? (tile, visit) => this.game.forEachNeighbor(tile, visit)
            : undefined,
        isLand: (tile) => this.game.isLand(tile),
        isMaritimeShore: (tile) => this.isEarlyGameMaritimeShore(tile),
      };
    }

    getEarlyGameMaritimeIndexBuilder() {
      if (this.earlyGameMaritimeIndexBuilder !== undefined) {
        return this.earlyGameMaritimeIndexBuilder;
      }
      const builder = createMaritimeDistanceIndexBuilder(
        this.earlyGameMaritimeIndexOptions(),
      );
      this.earlyGameMaritimeIndexBuilder = builder;
      return builder;
    }

    adoptCompletedEarlyGameMaritimeIndex(cacheKey, builder) {
      if (!builder?.done || !builder.index) return null;
      this.earlyGameMaritimeIndex = builder.index;
      if (isEarlyGameMaritimeCacheKey(cacheKey)) {
        EARLY_GAME_MARITIME_INDEX_CACHE.set(cacheKey, builder.index);
      }
      return builder.index;
    }

    prepareEarlyGameMaritimeIndexSlice(profile = null) {
      if (this.earlyGameMaritimeIndex !== undefined) return;
      if (
        typeof this.game.width !== "function" ||
        typeof this.game.height !== "function"
      ) {
        this.earlyGameMaritimeIndex = null;
        return;
      }
      const cacheKey = earlyGameMaritimeCacheKey(this.game);
      const cached = isEarlyGameMaritimeCacheKey(cacheKey)
        ? EARLY_GAME_MARITIME_INDEX_CACHE.get(cacheKey)
        : null;
      if (cached) {
        this.earlyGameMaritimeIndex = cached;
        return;
      }
      const builder = this.getEarlyGameMaritimeIndexBuilder();
      if (!builder) {
        this.earlyGameMaritimeIndex = null;
        return;
      }
      profileAttackSync(profile, "tribes-maritime-index-prep", () => {
        this.earlyGameMaritimeSliceWorkRemaining =
          EARLY_GAME_MARITIME_SLICE_WORK;
        this.earlyGameMaritimeSliceDeadline =
          earlyGameTopologyNow() + EARLY_GAME_MARITIME_SLICE_MS;
        this.earlyGameMaritimeSliceDeadlineProbe = 0;
        try {
          advanceMaritimeDistanceIndexBuilder(builder, {
            maxSteps: EARLY_GAME_MARITIME_SLICE_WORK,
            shouldYield: () =>
              this.consumeEarlyGameMaritimeSliceWork(256) ||
              earlyGameTopologyNow() >= this.earlyGameMaritimeSliceDeadline,
          });
        } finally {
          this.earlyGameMaritimeSliceWorkRemaining = Infinity;
          this.earlyGameMaritimeSliceDeadline = Infinity;
          this.earlyGameMaritimeSliceDeadlineProbe = 0;
        }
      });
      this.adoptCompletedEarlyGameMaritimeIndex(cacheKey, builder);
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
        isEarlyGameMaritimeCacheKey(cacheKey)
      ) {
        const cached = EARLY_GAME_MARITIME_INDEX_CACHE.get(cacheKey);
        if (cached) {
          this.earlyGameMaritimeIndex = cached;
          return cached;
        }
      }
      // This accessor is called while scoring tribe candidates. Finishing a
      // multi-million-tile field here would turn a cooperative preparation into
      // a synchronous frame stall. NationBot advances the builder before every
      // decision tick and publishes it atomically once complete.
      return null;
    }

    getEarlyGameMaritimeDistance(starts) {
      const index = this.getEarlyGameMaritimeIndex();
      if (index) {
        return lookupMaritimeDistanceIndex(index, starts);
      }
      if (this.earlyGameMaritimeIndex === null) {
        return findNearestMaritimeCoastDistance({
          starts,
          neighbors: (tile) => this.game.neighbors(tile),
          isLand: (tile) => this.game.isLand(tile),
          isMaritimeShore: (tile) => this.isEarlyGameMaritimeShore(tile),
        });
      }
      // A missing distance is deliberately treated as not-yet-actionable. The
      // next regular preparation slice will make maritime candidates available
      // without blocking the attack decision or UI on a cold full-map scan.
      return Infinity;
    }

    addEligibleEarlyGameTribe(tribesById, candidate) {
      if (!candidate?.isPlayer?.() || !candidate.isAlive?.()) return;
      if (candidate.type?.() !== PlayerType.Bot) return;
      if (this.player.isFriendly(candidate) !== false) return;
      tribesById.set(candidate.smallID(), candidate);
    }

    getEarlyGameBorderingOwnerIds() {
      if (
        typeof this.player?.borderTiles !== "function" ||
        typeof this.game?.neighbors !== "function" ||
        typeof this.game?.ownerID !== "function"
      ) {
        return null;
      }
      const ownerIds = new Set();
      for (const border of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(border) || []) {
          const ownerId = this.game.ownerID(neighbor);
          if (ownerId != null) ownerIds.add(ownerId);
        }
      }
      return ownerIds;
    }

    getEligibleEarlyGameTribes(otherPlayers, borderingOwnerIds = null) {
      const tribesById = new Map();
      for (const candidate of this.player.nearby()) {
        this.addEligibleEarlyGameTribe(tribesById, candidate);
      }
      if (borderingOwnerIds?.size > 0) {
        for (const candidate of otherPlayers) {
          if (borderingOwnerIds.has(candidate?.smallID?.())) {
            this.addEligibleEarlyGameTribe(tribesById, candidate);
          }
        }
      } else {
        for (const candidate of otherPlayers) {
          if (this.player.sharesBorderWith(candidate) === true) {
            this.addEligibleEarlyGameTribe(tribesById, candidate);
          }
        }
      }
      for (const candidate of this.getActiveOutboundTribeTargets()) {
        this.addEligibleEarlyGameTribe(tribesById, candidate);
      }
      return [...tribesById.values()];
    }

    getLightweightEarlyGameTribeNodes(
      otherPlayers,
      competitorProfiles,
      foodRaceById = null,
    ) {
      const nodes = [];
      for (const tribe of otherPlayers) {
        const node = this.createLightweightEarlyGameTribeNode(
          tribe,
          competitorProfiles,
          foodRaceById,
        );
        if (node) nodes.push(node);
      }
      return nodes;
    }

    createLightweightEarlyGameTribeNode(
      tribe,
      competitorProfiles,
      foodRaceById = null,
      includeFoodRace = true,
    ) {
      if (!this.isLightweightEarlyGameTribe(tribe)) return null;
      const tribeSid = tribe.smallID();
      const center = tribe.nameLocation?.();
      const foodRace = this.lightweightEarlyGameFoodRace(
        tribe,
        tribeSid,
        center,
        competitorProfiles,
        includeFoodRace,
      );
      if (foodRace !== null) foodRaceById?.set(tribeSid, foodRace);
      return {
        id: tribeSid,
        player: tribe,
        center,
        captureRisk: foodRace?.foodRaceValue ?? 0,
      };
    }

    isLightweightEarlyGameTribe(tribe) {
      return (
        tribe?.isPlayer?.() === true &&
        tribe.isAlive?.() === true &&
        tribe.type?.() === PlayerType.Bot &&
        this.player.isFriendly(tribe) === false
      );
    }

    lightweightEarlyGameFoodRace(
      tribe,
      tribeSid,
      tribeCenter,
      competitorProfiles,
      includeFoodRace,
    ) {
      if (includeFoodRace !== true) return null;
      return this.getEarlyGameFoodRaceSignals({
        tribe,
        tribeSid,
        tribeCenter,
        competitorProfiles,
      });
    }

    async getIncrementalEarlyGameTribeNodes(
      otherPlayers,
      competitorProfiles,
      foodRaceById = null,
      includeFoodRace = true,
    ) {
      const tick = this.currentAttackDecisionTick();
      const cached = this.earlyGameTribeNodesCache;
      if (
        cached?.competitorProfiles === competitorProfiles &&
        tick >= cached.tick &&
        tick - cached.tick <= EARLY_GAME_TRIBE_RISK_SNAPSHOT_CACHE_TICKS
      ) {
        if (foodRaceById) {
          for (const [tribeId, race] of cached.foodRaceById) {
            foodRaceById.set(tribeId, race);
          }
        }
        return cached.nodes;
      }
      const nodes = [];
      let sliceStartedAt = earlyGameTopologyNow();
      for (const tribe of otherPlayers) {
        const node = this.createLightweightEarlyGameTribeNode(
          tribe,
          competitorProfiles,
          foodRaceById,
          includeFoodRace,
        );
        if (node) nodes.push(node);
        if (shouldYieldEarlyGameTribeNodes(sliceStartedAt)) {
          await yieldEarlyGameTopologyWork();
          sliceStartedAt = earlyGameTopologyNow();
        }
      }
      this.earlyGameTribeNodesCache = {
        tick,
        competitorProfiles,
        nodes,
        foodRaceById: new Map(foodRaceById),
      };
      return nodes;
    }

    earlyGameReachableTribeIds(startIds, tribeAdjacency) {
      const reachable = new Set(startIds);
      const queue = [...reachable];
      for (let head = 0; head < queue.length; head++) {
        for (const neighborId of tribeAdjacency.get(queue[head]) || []) {
          if (reachable.has(neighborId)) continue;
          reachable.add(neighborId);
          queue.push(neighborId);
        }
      }
      return reachable;
    }

    enrichReachableEarlyGameTribeRisks(
      nodes,
      reachableIds,
      competitorProfiles,
      foodRaceById,
    ) {
      for (const node of nodes) {
        if (!reachableIds.has(node.id)) continue;
        let foodRace = foodRaceById.get(node.id);
        if (!foodRace) {
          foodRace = this.getEarlyGameFoodRaceSignals({
            tribe: node.player,
            tribeSid: node.id,
            tribeCenter: node.center,
            competitorProfiles,
          });
          foodRaceById.set(node.id, foodRace);
        }
        node.captureRisk = foodRace.foodRaceValue;
      }
      if (this.earlyGameTribeNodesCache?.nodes === nodes) {
        this.earlyGameTribeNodesCache.foodRaceById = new Map(foodRaceById);
      }
    }

    async fetchEarlyGameTribeTopologyBorders(nodes, refreshCached = false) {
      const borders = new Map();
      for (let start = 0; start < nodes.length; start += EARLY_TRIBE_CANDIDATES) {
        const batch = nodes.slice(start, start + EARLY_TRIBE_CANDIDATES);
        await Promise.all(
          batch.map(async (tribe) => {
            // fetchEarlyGameTribeBorder returns the Game API's replacement-only
            // snapshot Set. Retaining it is safe: a refresh swaps the cached Set
            // rather than mutating it, and avoids cloning every tribe border on
            // each topology refresh.
            borders.set(
              tribe.id,
              await this.fetchEarlyGameTribeBorder(
                tribe.player,
                refreshCached,
              ),
            );
          }),
        );
      }
      return borders;
    }

    async fetchEarlyGameTribeBorder(tribe, refreshCached = false) {
      let border = new Set();
      {
        // GameView retains each target's last-good border snapshot for roughly
        // 1.5 seconds. Reuse it before asking the worker again: a live tribe-id
        // change invalidates the topology graph, but it does not make every
        // surviving tribe's known border unknown. This keeps a single capture
        // from fanning out into a full worker refresh of the entire map.
        const cached = tribe.borderTiles?.();
        if (!refreshCached && cached?.size > 0) return cached;
        if (typeof this.game.ensureBorderTiles === "function") {
          const fetched = await withTimeout(
            this.game.ensureBorderTiles(tribe),
            WORKER_TIMEOUT_MS,
            null,
          );
          if (fetched?.size > 0) border = fetched;
        }
        if (border.size === 0) border = tribe.borderTiles?.() || new Set();
      }
      return border;
    }

    async connectEarlyGameTribeAdjacency(nodes, borders) {
      const edibleIdFlags = this.createEarlyGameEdibleIdFlags(nodes);
      const adjacency = new Map(nodes.map((tribe) => [tribe.id, new Set()]));
      let tilesSinceYield = 0;
      let sliceStartedAt = earlyGameTopologyNow();
      for (const tribe of nodes) {
        for (const tile of borders.get(tribe.id) || []) {
          this.connectEarlyGameTribeAdjacencyTile(
            tribe.id,
            tile,
            edibleIdFlags,
            adjacency,
          );
          tilesSinceYield++;
          if (shouldYieldEarlyGameTopology(tilesSinceYield, sliceStartedAt)) {
            tilesSinceYield = 0;
            await yieldEarlyGameTopologyWork();
            sliceStartedAt = earlyGameTopologyNow();
          }
        }
      }
      return adjacency;
    }

    createEarlyGameEdibleIdFlags(nodes) {
      let maximumId = 0;
      for (const tribe of nodes) maximumId = Math.max(maximumId, tribe.id);
      const flags = Array(maximumId + 1).fill(false);
      for (const tribe of nodes) flags[tribe.id] = true;
      return flags;
    }

    earlyGameTribeBorderChanged(previous, current) {
      // Border snapshots are immutable replacement values. Identity therefore
      // proves no topology change without re-walking every tile on a TTL refresh.
      if (previous === current) return false;
      if (previous?.size !== current?.size) return true;
      for (const tile of current || []) {
        if (!previous.has(tile)) return true;
      }
      return false;
    }

    getChangedEarlyGameTribeIds(nodes, borders, cachedBorders) {
      const changedIds = new Set();
      for (const tribe of nodes) {
        if (
          this.earlyGameTribeBorderChanged(
            cachedBorders.get(tribe.id),
            borders.get(tribe.id),
          )
        ) {
          changedIds.add(tribe.id);
        }
      }
      return changedIds;
    }

    reuseEarlyGameTribeAdjacency(nodes, cachedAdjacency, edibleIdFlags) {
      return new Map(
        nodes.map((tribe) => [
          tribe.id,
          new Set(
            [...(cachedAdjacency.get(tribe.id) || [])].filter((neighborId) =>
              edibleIdFlags[neighborId] === true),
          ),
        ]),
      );
    }

    resetChangedEarlyGameTribeAdjacency(adjacency, changedIds) {
      for (const changedId of changedIds) adjacency.get(changedId).clear();
      for (const neighbors of adjacency.values()) {
        for (const changedId of changedIds) neighbors.delete(changedId);
      }
    }

    async connectChangedEarlyGameTribeAdjacency(
      changedIds,
      borders,
      edibleIdFlags,
      adjacency,
    ) {
      let tilesSinceYield = 0;
      let sliceStartedAt = earlyGameTopologyNow();
      for (const changedId of changedIds) {
        for (const tile of borders.get(changedId) || []) {
          this.connectEarlyGameTribeAdjacencyTile(
            changedId,
            tile,
            edibleIdFlags,
            adjacency,
          );
          tilesSinceYield++;
          if (shouldYieldEarlyGameTopology(tilesSinceYield, sliceStartedAt)) {
            tilesSinceYield = 0;
            await yieldEarlyGameTopologyWork();
            sliceStartedAt = earlyGameTopologyNow();
          }
        }
      }
    }

    async updateEarlyGameTribeAdjacency(nodes, borders, cached, signature = null) {
      if (!cached?.topologyBordersById || !cached?.tribeAdjacency) {
        return this.connectEarlyGameTribeAdjacency(nodes, borders);
      }
      const currentSignature = signature ?? this.earlyGameTribeTopologySignature(nodes);
      const signatureChanged =
        cached.signature !== currentSignature;
      const changedIds = this.getChangedEarlyGameTribeIds(
        nodes,
        borders,
        cached.topologyBordersById,
      );
      if (!signatureChanged && changedIds.size === 0) {
        return cached.tribeAdjacency;
      }

      const edibleIdFlags = this.createEarlyGameEdibleIdFlags(nodes);
      const adjacency = this.reuseEarlyGameTribeAdjacency(
        nodes,
        cached.tribeAdjacency,
        edibleIdFlags,
      );
      this.resetChangedEarlyGameTribeAdjacency(adjacency, changedIds);
      await this.connectChangedEarlyGameTribeAdjacency(
        changedIds,
        borders,
        edibleIdFlags,
        adjacency,
      );
      return adjacency;
    }

    earlyGameTribeTopologySignature(nodes) {
      return nodes
        .map((tribe) => String(tribe.id))
        .sort()
        .join(",");
    }

    async getEarlyGameTribeTopology(nodes, profile = null) {
      const tick = this.currentAttackDecisionTick();
      const signature = this.earlyGameTribeTopologySignature(nodes);
      const cached = this.earlyGameTribeTopologyCache;
      if (
        cached?.signature === signature &&
        tick >= cached.tick &&
        tick - cached.tick <= EARLY_GAME_TRIBE_TOPOLOGY_CACHE_TICKS
      ) {
        return cached;
      }
      const topologyBordersById = await profileAttackAsync(
        profile,
        "tribes-topology-borders",
        () =>
          this.fetchEarlyGameTribeTopologyBorders(
            nodes,
            cached?.signature === signature,
          ),
      );
      const tribeAdjacency = await profileAttackAsync(
        profile,
        "tribes-topology-adjacency",
        () =>
          this.updateEarlyGameTribeAdjacency(
            nodes,
            topologyBordersById,
            cached,
            signature,
          ),
      );
      const topology = {
        tick,
        signature,
        topologyBordersById,
        tribeAdjacency,
      };
      this.earlyGameTribeTopologyCache = topology;
      return topology;
    }

    connectEarlyGameTribeAdjacencyTile(
      tribeId,
      tile,
      edibleIdFlags,
      adjacency,
    ) {
      const connectNeighbor = (neighbor) => {
        const neighborId = this.game.ownerID(neighbor);
        if (neighborId == null || neighborId === tribeId) return;
        if (edibleIdFlags[neighborId] !== true) return;
        adjacency.get(tribeId).add(neighborId);
        adjacency.get(neighborId).add(tribeId);
      };
      if (typeof this.game.forEachNeighbor === "function") {
        this.game.forEachNeighbor(tile, connectNeighbor);
        return;
      }
      for (const neighbor of this.game.neighbors(tile) || []) {
        connectNeighbor(neighbor);
      }
    }

    rankEarlyGameSamplingTribes(tribes, clusterOpportunities) {
      return rankEarlyGameTribeSamplingCandidates(
        tribes.map((tribe) => ({
          player: tribe,
          id: tribe.smallID(),
          clusterSize:
            clusterOpportunities.get(tribe.smallID())?.score || 1,
          opportunity:
            Math.max(1, Number(tribe.numTilesOwned?.()) || 1) /
            Math.max(1, Number(tribe.troops?.()) || 1),
        })),
      ).map((candidate) => candidate.player);
    }

    splitEarlyGameTribesByLandBorder(tribes, borderingOwnerIds = null) {
      const bordering = [];
      const other = [];
      for (const tribe of tribes) {
        const sharesBorder = borderingOwnerIds
          ? borderingOwnerIds.has(tribe.smallID())
          : this.player.sharesBorderWith(tribe) === true;
        (sharesBorder ? bordering : other).push(tribe);
      }
      return { bordering, other };
    }

    async getEarlyGameTribeSampling(
      otherPlayers,
      competitorProfiles,
      profile = null,
    ) {
      const foodRaceById = new Map();
      const borderingOwnerIds = profileAttackSync(
        profile,
        "tribes-sampling-border-owners",
        () => this.getEarlyGameBorderingOwnerIds(),
      );
      const eligible = profileAttackSync(
        profile,
        "tribes-sampling-eligible",
        () => this.getEligibleEarlyGameTribes(otherPlayers, borderingOwnerIds),
      );
      const nodes = await profileAttackAsync(
        profile,
        "tribes-sampling-nodes",
        () =>
          this.getIncrementalEarlyGameTribeNodes(
            otherPlayers,
            competitorProfiles,
            foodRaceById,
            false,
          ),
      );
      const { topologyBordersById, tribeAdjacency } =
        await profileAttackAsync(
          profile,
          "tribes-sampling-topology",
          () => this.getEarlyGameTribeTopology(nodes, profile),
        );
      const eligibleIds = eligible.map((tribe) => tribe.smallID());
      const reachableIds = profileAttackSync(
        profile,
        "tribes-sampling-reachable",
        () => this.earlyGameReachableTribeIds(eligibleIds, tribeAdjacency),
      );
      profileAttackSync(
        profile,
        "tribes-sampling-reachable-risks",
        () =>
          this.enrichReachableEarlyGameTribeRisks(
            nodes,
            reachableIds,
            competitorProfiles,
            foodRaceById,
          ),
      );
      const clusterOpportunities = profileAttackSync(
        profile,
        "tribes-sampling-clusters",
        () =>
          calculateReachableTribeClusterOpportunities(
            nodes,
            tribeAdjacency,
            eligibleIds,
          ),
      );
      const { bordering, other } = profileAttackSync(
        profile,
        "tribes-sampling-split",
        () =>
          this.splitEarlyGameTribesByLandBorder(
            eligible,
            borderingOwnerIds,
          ),
      );
      const nearbyTribes = profileAttackSync(
        profile,
        "tribes-sampling-rank",
        () =>
          this.rankEarlyGameSamplingTribes(
            bordering,
            clusterOpportunities,
          )
            .concat(
              this.rankEarlyGameSamplingTribes(other, clusterOpportunities),
            )
            .slice(0, EARLY_TRIBE_CANDIDATES),
      );
      return {
        nearbyTribes,
        topologyBordersById,
        tribeAdjacency,
        foodRaceById,
        nodes,
      };
    }

    async getEarlyGameCandidateBorders(tribes, topologyBordersById) {
      const borderByTribe = new Map();
      await Promise.all(
        tribes.map(async (tribe) => {
          let border = topologyBordersById.get(tribe.smallID()) || new Set();
          {
            if (border.size === 0 && typeof this.game.ensureBorderTiles === "function") {
              const fetched = await withTimeout(
                this.game.ensureBorderTiles(tribe),
                WORKER_TIMEOUT_MS,
                null,
              );
              if (fetched?.size > 0) border = fetched;
            }
            if (border.size === 0) {
              const snapshot = tribe.borderTiles();
              if (snapshot?.size > 0) border = snapshot;
            }
          }
          borderByTribe.set(tribe, border);
        }),
      );
      return borderByTribe;
    }

    earlyGameTribeCenterDistance(myCenter, tribeCenter) {
      if (!myCenter || !tribeCenter || myCenter.x == null || tribeCenter.x == null) {
        return Infinity;
      }
      const myTile = this.game.ref(myCenter.x, myCenter.y);
      const tribeTile = this.game.ref(tribeCenter.x, tribeCenter.y);
      return this.game.manhattanDist(myTile, tribeTile);
    }

    earlyGameContesterProfilesSignature(competitorProfiles) {
      return competitorProfiles
        .map((profile) => {
          const location = profile.location;
          const x = Number(location?.x);
          const y = Number(location?.y);
          const valid =
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            this.game.isValidCoord(x, y);
          return [profile.sid, valid ? x : "", valid ? y : ""].join(":");
        })
        .sort()
        .join(";");
    }

    getEarlyGameContesterTiles(otherPlayers, mySid, competitorProfiles = null) {
      if (Array.isArray(competitorProfiles)) {
        const signature = this.earlyGameContesterProfilesSignature(
          competitorProfiles,
        );
        const cached = this.earlyGameContesterTilesCache;
        if (cached?.signature === signature) return cached.tiles;
        const tiles = [];
        for (const profile of competitorProfiles) {
          const location = profile.location;
          if (
            !location ||
            !this.game.isValidCoord(location.x, location.y)
          ) continue;
          tiles.push({
            sid: profile.sid,
            tile: this.game.ref(location.x, location.y),
          });
        }
        this.earlyGameContesterTilesCache = { signature, tiles };
        return tiles;
      }
      const contesters = [];
      for (const other of otherPlayers) {
        const location = this.earlyGameContesterLocation(other, null, mySid);
        if (!location) continue;
        contesters.push({
          sid: other.smallID(),
          tile: this.game.ref(location.x, location.y),
        });
      }
      return contesters;
    }

    countEarlyGameNearbyContesters(
      otherPlayers,
      tribeSid,
      mySid,
      tribeCenter,
      contesterTiles = null,
    ) {
      if (!tribeCenter || tribeCenter.x == null) return 0;
      let count = 0;
      const tribeTile = this.game.ref(tribeCenter.x, tribeCenter.y);
      if (contesterTiles) {
        for (const contester of contesterTiles) {
          if (contester.sid === tribeSid) continue;
          if (this.game.manhattanDist(contester.tile, tribeTile) <= 80) count++;
        }
        return count;
      }
      for (const other of otherPlayers) {
        const location = this.earlyGameContesterLocation(other, tribeSid, mySid);
        if (!location) continue;
        const otherTile = this.game.ref(location.x, location.y);
        if (this.game.manhattanDist(otherTile, tribeTile) <= 80) count++;
      }
      return count;
    }

    earlyGameContesterLocation(other, tribeSid, mySid) {
      if (!other?.isPlayer?.() || !other.isAlive?.()) return null;
      const otherSid = other.smallID();
      if (otherSid === mySid || otherSid === tribeSid) return null;
      const location = other.nameLocation?.();
      if (!location || location.x == null) return null;
      return this.game.isValidCoord(location.x, location.y) ? location : null;
    }

    countEarlyGameIncomingContesters(tribe, tribeSid, mySid) {
      let count = 0;
      {
        for (const attack of tribe.incomingAttacks?.() ?? []) {
          const attacker = attack.attacker?.();
          const sid = attacker?.smallID?.();
          if (attacker?.isPlayer?.() && sid !== mySid && sid !== tribeSid) count++;
        }
      }
      return count;
    }

    earlyGameTribeSharesLandBorder(tribe, ownEdges) {
      if (ownEdges > 0) return true;
      {
        return this.player.sharesBorderWith(tribe) === true;
      }
    }

    createEarlyGameTribeCandidate(tribe, context) {
      const border = context.borderByTribe.get(tribe) || new Set();
      const tribeSid = tribe.smallID();
      const boundary = profileAttackSync(
        context.profile,
        "tribes-candidate-boundary",
        () =>
          analyzeTribeBoundary({
            game: this.game,
            player: this.player,
            border,
            tribeSid,
            mySid: context.mySid,
            playersBySid: context.playersBySid,
          }),
      );
      const ratio = (value) =>
        boundary.boundaryEdges > 0 ? value / boundary.boundaryEdges : 0;
      const tribeCenter = profileAttackSync(
        context.profile,
        "tribes-candidate-center",
        () =>
          border.size > 0
            ? calculateBoundingBoxCenter(this.game, border)
            : tribe.nameLocation?.() || null,
      );
      const nearbyContesters = profileAttackSync(
        context.profile,
        "tribes-candidate-nearby-contesters",
        () =>
          this.countEarlyGameNearbyContesters(
            context.otherPlayers,
            tribeSid,
            context.mySid,
            tribeCenter,
            context.contesterTiles,
          ),
      );
      const incomingContesters = profileAttackSync(
        context.profile,
        "tribes-candidate-incoming-contesters",
        () =>
          this.countEarlyGameIncomingContesters(
            tribe,
            tribeSid,
            context.mySid,
          ),
      );
      const foodRace = profileAttackSync(
        context.profile,
        "tribes-candidate-food-race",
        () =>
          this.getEarlyGameFoodRaceSignals({
            tribe,
            tribeSid,
            tribeCenter,
            competitorProfiles: context.competitorProfiles,
          }),
      );
      const maritimeDistance = profileAttackSync(
        context.profile,
        "tribes-candidate-maritime-distance",
        () => this.getEarlyGameMaritimeDistance(border),
      );
      const defenseProfile = profileAttackSync(
        context.profile,
        "tribes-candidate-defense-profile",
        () => this.getEnemyDefensePostAttackProfile(tribe, border),
      );
      const targetTiles = Math.max(1, Number(tribe.numTilesOwned?.()) || border.size || 1);
      const estimatedCaptureCost =
        Math.max(1, Number(tribe.troops()) || 0) *
        Math.max(1, Number(defenseProfile.attackCostMultiplier) || 1);
      const troopRatio =
        this.player.troops() > 0 ? tribe.troops() / this.player.troops() : 1;
      return {
        player: tribe,
        id: tribeSid,
        maritimeDistance,
        oceanDistance: maritimeDistance,
        encirclement: ratio(boundary.ownEdges),
        blockValue: ratio(boundary.externalEdges),
        alliedCutoffPressure: ratio(boundary.alliedEdges),
        oceanGatewayUrgency:
          !context.hasOpenOceanAccess && maritimeDistance === 0 ? 1 : 0,
        hasOpenOceanAccess: context.hasOpenOceanAccess,
        cheapCapture: Math.max(0, 1 - Math.min(1, troopRatio)),
        targetTiles,
        estimatedCaptureCost,
        captureEfficiencyRaw: targetTiles / estimatedCaptureCost,
        captureEfficiency: 0,
        landBorder: this.earlyGameTribeSharesLandBorder(tribe, boundary.ownEdges),
        distance: this.earlyGameTribeCenterDistance(context.myCenter, tribeCenter),
        center: tribeCenter,
        futureFoodCount: 0,
        futureFoodTotal: 0,
        meanFutureFoodDistance: Infinity,
        futureFoodChainRadius: EARLY_GAME_TRIBE_CHAIN_RADIUS,
        futureFoodAccess: null,
        tribeClusterAccess: 0,
        foodRaceValue: foodRace.foodRaceValue,
        captureRisk: foodRace.foodRaceValue,
        contestPressure: foodRace.contestPressure,
        competitorTroops: foodRace.competitorTroops,
        competitorProgress: foodRace.competitorProgress,
        competitorVector: foodRace.competitorVector,
        directAttackers: foodRace.directAttackers,
        incomingAttackers: foodRace.incomingAttackers,
        contestingPlayers: Math.max(
          boundary.externalSids.size + nearbyContesters + incomingContesters,
          foodRace.contestingPlayers,
        ),
      };
    }

    async enrichEarlyGameTribeBoatEtas(candidates, borderByTribe) {
      const seaCandidates = candidates.filter((candidate) => !candidate.landBorder);
      const tick = this.currentAttackDecisionTick();
      const ownShores = this.getEarlyGameOwnShores();
      // PlayerView deliberately replaces border snapshot containers between
      // decision ticks. A reference comparison therefore misses the useful
      // route cache even when the actual launch coast is unchanged. Preserve
      // exact invalidation by comparing the complete tile membership instead.
      const ownBorderSignature = this.earlyGameBoatBorderSignature(ownShores);
      const uncachedCandidates = [];
      for (const candidate of seaCandidates) {
        const targetBorder = borderByTribe.get(candidate.player) || new Set();
        const targetBorderSignature = this.earlyGameBoatBorderSignature(targetBorder);
        const cached = this.getCachedEarlyGameTribeBoatEta(
          candidate,
          ownBorderSignature,
          targetBorderSignature,
          tick,
        );
        if (cached === null) {
          uncachedCandidates.push({ candidate, targetBorder, targetBorderSignature });
          continue;
        }
        candidate.boatEtaTicks = cached.eta;
        candidate.boatTargetTile = cached.targetTile;
      }
      const batch = uncachedCandidates.slice(
        0,
        EARLY_TRIBE_BOAT_ETA_CANDIDATE_BUDGET,
      );
      // Each candidate can issue its own bounded set of transport-route
      // queries. Starting every candidate together multiplied that set into a
      // sixteen-probe burst, which can make the worker and the main thread
      // stutter on a crowded coast. Preserve every candidate and every target
      // probe, but let one candidate's bounded probe group settle before
      // starting the next.
      const results = [];
      for (const { candidate, targetBorder, targetBorderSignature } of batch) {
        results.push({
          candidate,
          targetBorder,
          targetBorderSignature,
          boatEtaTicks: await this.estimateEarlyGameTribeBoatEta(
            targetBorder,
            candidate,
            ownShores,
          ),
        });
        if (results.length < batch.length) await yieldEarlyGameTopologyWork();
      }
      for (const { candidate, targetBorderSignature, boatEtaTicks } of results) {
        candidate.boatEtaTicks = boatEtaTicks;
        this.cacheEarlyGameTribeBoatEta(
          candidate,
          ownBorderSignature,
          targetBorderSignature,
          tick,
        );
      }
    }

    earlyGameTribeBoatEtaCacheKey(candidate) {
      return candidate?.id ?? candidate?.player?.smallID?.() ?? null;
    }

    earlyGameBoatBorderSignature(border) {
      const cacheable =
        border !== null &&
        border !== undefined &&
        (typeof border === "object" || typeof border === "function");
      let cache = null;
      if (cacheable) {
        cache = this.earlyGameBoatBorderSignatureCache;
        if (cache === undefined) {
          cache = new WeakMap();
          this.earlyGameBoatBorderSignatureCache = cache;
        }
      }
      const cached = cache?.get(border);
      if (cached !== undefined) return cached;
      const signature = Array.from(border || [])
        .map((tile) => Number(tile))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
        .join(",");
      if (cache !== null) cache.set(border, signature);
      return signature;
    }

    getCachedEarlyGameTribeBoatEta(
      candidate,
      ownBorderSignature,
      targetBorderSignature,
      tick,
    ) {
      const key = this.earlyGameTribeBoatEtaCacheKey(candidate);
      if (key === null) return null;
      const cached = this.earlyGameTribeBoatEtaCache?.get(key);
      if (
        cached?.ownBorderSignature !== ownBorderSignature ||
        cached.targetBorderSignature !== targetBorderSignature ||
        tick < cached.tick ||
        tick - cached.tick > EARLY_TRIBE_BOAT_ETA_CACHE_TICKS
      ) {
        return null;
      }
      return cached;
    }

    cacheEarlyGameTribeBoatEta(
      candidate,
      ownBorderSignature,
      targetBorderSignature,
      tick,
    ) {
      const key = this.earlyGameTribeBoatEtaCacheKey(candidate);
      if (key === null) return;
      const cache = this.earlyGameTribeBoatEtaCache || new Map();
      this.earlyGameTribeBoatEtaCache = cache;
      cache.set(key, {
        ownBorderSignature,
        targetBorderSignature,
        tick,
        eta: candidate.boatEtaTicks,
        targetTile: candidate.boatTargetTile ?? null,
      });
      if (cache.size <= EARLY_TRIBE_CANDIDATES * 4) return;
      for (const [cachedKey, cached] of cache) {
        if (tick - cached.tick > EARLY_TRIBE_BOAT_ETA_CACHE_TICKS) {
          cache.delete(cachedKey);
        }
      }
    }

    normalizeEarlyGameCaptureEfficiencies(candidates) {
      const maximum = candidates
        .filter(isEarlyGameTribeActionable)
        .reduce(
          (best, candidate) => Math.max(best, candidate.captureEfficiencyRaw),
          0,
        );
      for (const candidate of candidates) {
        candidate.captureEfficiency = normalizeCaptureEfficiency(candidate, maximum);
      }
    }

    getEarlyGameFutureFoodCandidates(
      otherPlayers,
      candidates,
      competitorProfiles,
      foodRaceById = null,
      lightweightNodes = null,
    ) {
      const byId = this.seedEarlyGameFutureFoodFromNodes(lightweightNodes);
      for (const tribe of otherPlayers) {
        if (byId.has(tribe?.smallID?.())) continue;
        const record = this.earlyGameFutureFoodRecord(
          tribe,
          competitorProfiles,
          foodRaceById,
        );
        if (record) byId.set(record.id, record);
      }
      for (const candidate of candidates) {
        if (
          Number.isFinite(Number(candidate.center?.x)) &&
          Number.isFinite(Number(candidate.center?.y))
        ) {
          byId.set(candidate.id, candidate);
        }
      }
      return byId;
    }

    seedEarlyGameFutureFoodFromNodes(lightweightNodes) {
      const byId = new Map();
      // The sampling pass just built these strict-hostile tribe records. Reuse
      // them for this decision instead of recomputing the same centres and
      // food-race values across every tribe. They are intentionally not kept
      // beyond this pass: liveness and diplomatic relations may change.
      for (const node of lightweightNodes || []) {
        if (!Number.isFinite(Number(node?.center?.x))) continue;
        if (!Number.isFinite(Number(node?.center?.y))) continue;
        byId.set(node.id, node);
      }
      return byId;
    }

    earlyGameFutureFoodRecord(tribe, competitorProfiles, foodRaceById = null) {
      if (!tribe?.isPlayer?.() || !tribe.isAlive?.()) return null;
      if (tribe.type?.() !== PlayerType.Bot) return null;
      if (this.player.isFriendly(tribe) === true) return null;
      const center = tribe.nameLocation?.();
      if (!Number.isFinite(Number(center?.x))) return null;
      if (!Number.isFinite(Number(center?.y))) return null;
      const tribeSid = tribe.smallID();
      return {
        id: tribeSid,
        player: tribe,
        center,
        captureRisk: this.getEarlyGameCachedFoodRace(
          tribe,
          center,
          competitorProfiles,
          foodRaceById,
        ).foodRaceValue,
      };
    }

    getEarlyGameCachedFoodRace(
      tribe,
      tribeCenter,
      competitorProfiles,
      foodRaceById,
    ) {
      const tribeSid = tribe.smallID();
      const cached = foodRaceById ? foodRaceById.get(tribeSid) : null;
      if (cached) return cached;
      return this.getEarlyGameFoodRaceSignals({
        tribe,
        tribeSid,
        tribeCenter,
        competitorProfiles,
      });
    }

    mergeEarlyGameCandidateAdjacency(candidates, borderByTribe, adjacency) {
      for (const candidate of candidates) {
        if (!adjacency.has(candidate.id)) continue;
        for (const tile of borderByTribe.get(candidate.player) || []) {
          this.mergeEarlyGameAdjacencyTile(candidate.id, tile, adjacency);
        }
      }
    }

    mergeEarlyGameAdjacencyTile(candidateId, tile, adjacency) {
      for (const neighbor of this.game.neighbors(tile) || []) {
        if (!this.game.isLand(neighbor)) continue;
        const neighborId = this.game.ownerID(neighbor);
        if (neighborId == null || neighborId === candidateId) continue;
        if (!adjacency.has(neighborId)) continue;
        adjacency.get(candidateId).add(neighborId);
        adjacency.get(neighborId).add(candidateId);
      }
    }

    earlyGameFutureFoodStats(
      candidate,
      futureFoodCandidates,
      memberIds = null,
    ) {
      // This sits in the opening hot path. Avoid allocating three short-lived
      // arrays for every ranked tribe while retaining the exact qualifying
      // distance set and weighting used by the strategy.
      let count = 0;
      let totalDistance = 0;
      let weightedAccess = 0;
      for (const other of futureFoodCandidates) {
        if (
          other.id === candidate.id ||
          (memberIds !== null && !memberIds.has(other.id))
        ) {
          continue;
        }
        const distance = this.earlyGameCenterDistance(candidate.center, other.center);
        if (!Number.isFinite(distance) || distance > EARLY_GAME_TRIBE_CHAIN_RADIUS) {
          continue;
        }
        count++;
        totalDistance += distance;
        weightedAccess += Math.max(0, 1 - distance / EARLY_GAME_TRIBE_CHAIN_RADIUS);
      }
      return { count, totalDistance, weightedAccess };
    }

    enrichEarlyGameFutureFoodScores(
      candidates,
      futureFoodCandidates,
      clusterOpportunities,
    ) {
      let maxClusterSize = 0;
      for (const candidate of candidates) {
        if (!isEarlyGameTribeActionable(candidate)) {
          candidate.futureFoodAccess = 0;
          candidate.tribeClusterAccess = 0;
          continue;
        }
        const opportunity = clusterOpportunities.get(candidate.id);
        candidate.tribeClusterMemberIds = opportunity?.memberIds || new Set();
        const futureFoodTotal = Math.max(
          0,
          candidate.tribeClusterMemberIds.size - 1,
        );
        const futureFood = this.earlyGameFutureFoodStats(
          candidate,
          futureFoodCandidates,
          candidate.tribeClusterMemberIds,
        );
        candidate.futureFoodCount = futureFood.count;
        candidate.futureFoodTotal = futureFoodTotal;
        candidate.meanFutureFoodDistance = futureFood.count
          ? futureFood.totalDistance / futureFood.count
          : Infinity;
        candidate.futureFoodAccess =
          futureFoodTotal > 0 ? futureFood.weightedAccess / futureFoodTotal : 0;
        candidate.tribeClusterSize = Math.max(0, (opportunity?.score || 1) - 1);
        maxClusterSize = Math.max(maxClusterSize, candidate.tribeClusterSize);
      }
      for (const candidate of candidates) {
        candidate.tribeClusterAccess =
          isEarlyGameTribeActionable(candidate) && maxClusterSize > 0
            ? candidate.tribeClusterSize / maxClusterSize
            : 0;
      }
    }

    publishPreferredEarlyGameCluster(candidates, futureFoodById) {
      if (!state.earlyGame) return;
      const preferred = candidates
        .filter(isEarlyGameTribeActionable)
        .sort(
          (left, right) =>
            (Number(right.tribeClusterSize) || 0) -
            (Number(left.tribeClusterSize) || 0),
        )[0];
      const ids = preferred?.tribeClusterMemberIds || new Set();
      const centers = [...ids]
        .map((id) => futureFoodById.get(id)?.center)
        .filter(
          (center) =>
            Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y)),
        );
      state.earlyGame.preferredClusterCenter =
        ids.size > 1 ? chooseTribeClusterMarkerCenter(centers) : null;
      const hasCenter = state.earlyGame.preferredClusterCenter != null;
      state.earlyGame.preferredClusterMembers = hasCenter
        ? [...ids]
            .map((id) => {
              const center = futureFoodById.get(id)?.center;
              if (!Number.isFinite(Number(center?.x))) return null;
              if (!Number.isFinite(Number(center?.y))) return null;
              return { id, x: Number(center.x), y: Number(center.y) };
            })
            .filter(Boolean)
        : [];
      state.earlyGame.preferredClusterSize = hasCenter ? ids.size : 0;
      // This layer is data-driven: it is disabled when registered at page
      // load and only becomes enabled after the first tribe topology pass.
      // Wake the shared scheduler at that transition; otherwise its auto-stop
      // leaves the newly enabled cluster invisible until some unrelated map
      // overlay happens to start it.
      const overlaySignature = hasCenter
        ? [
            Number(state.earlyGame.preferredClusterCenter.x),
            Number(state.earlyGame.preferredClusterCenter.y),
            state.earlyGame.preferredClusterSize,
            ...state.earlyGame.preferredClusterMembers.map(
              (member) => `${member.id}:${member.x}:${member.y}`,
            ),
          ].join("|")
        : "";
      const overlayChanged =
        overlaySignature !== this.earlyGamePreferredClusterOverlaySignature;
      this.earlyGamePreferredClusterOverlaySignature = overlaySignature;
      if (
        overlayChanged &&
        typeof requestMapOverlayLoop === "function"
      ) {
        requestMapOverlayLoop();
      }
    }

    // Build the small, bounded feature vector used by rankEarlyGameTribeCandidates.
    // Border snapshots are fetched in bounded batches. Complete tribe topology
    // is required before the eight expensive attack candidates are selected;
    // otherwise uncached surrounding tribes disappear from the cluster graph.
    // The stages remain together so their bounded maps share one coherent game
    // snapshot; splitting this orchestration would make cross-tick data mixing
    // easier. The expensive worker calls are separately bounded and parallel.
    async getEarlyGameTribeCandidates(profile = null) {
      const otherPlayers = this.game.players();
      const mySid = this.player.smallID();
      const competitorProfiles = await profileAttackAsync(
        profile,
        "tribes-competitor-profiles",
        () => this.getEarlyGameCompetitorProfiles(otherPlayers, mySid),
      );
      const {
        nearbyTribes,
        topologyBordersById,
        tribeAdjacency,
        foodRaceById,
        nodes,
      } =
        await profileAttackAsync(
          profile,
          "tribes-sampling",
          () =>
            this.getEarlyGameTribeSampling(
              otherPlayers,
              competitorProfiles,
              profile,
            ),
        );
      if (nearbyTribes.length === 0) {
        const liveTribeIds = new Set(
          otherPlayers
            .filter(
              (player) =>
                player?.isPlayer?.() === true &&
                player.isAlive?.() === true &&
                player.type?.() === PlayerType.Bot &&
                this.player.isFriendly(player) !== true,
            )
            .map((player) => player.smallID()),
        );
        const publishedMembers = Array.isArray(
          state.earlyGame?.preferredClusterMembers,
        )
          ? state.earlyGame.preferredClusterMembers
          : [];
        const publishedClusterStillLive =
          publishedMembers.length > 1 &&
          publishedMembers.every((member) => liveTribeIds.has(member.id));
        if (!publishedClusterStillLive) {
          this.publishPreferredEarlyGameCluster([], new Map());
        }
        return [];
      }

      const playersBySid = new Map(
        otherPlayers
          .filter((player) => player?.isPlayer?.() === true)
          .map((player) => [player.smallID(), player]),
      );
      const myCenter = this.getPlayerCenter(this.player);
      const contesterTiles = profileAttackSync(
        profile,
        "tribes-contester-index",
        () =>
          this.getEarlyGameContesterTiles(
            otherPlayers,
            mySid,
            competitorProfiles,
          ),
      );
      const hasOpenOceanAccess = Array.from(
        this.player.borderTiles?.() || [],
      ).some((tile) => this.isEarlyGameMaritimeShore(tile));
      const borderByTribe = await profileAttackAsync(
        profile,
        "tribes-candidate-borders",
        () => this.getEarlyGameCandidateBorders(nearbyTribes, topologyBordersById),
      );
      const candidateContext = {
        profile,
        otherPlayers,
        playersBySid,
        myCenter,
        mySid,
        contesterTiles,
        hasOpenOceanAccess,
        competitorProfiles,
        borderByTribe,
      };
      const candidates = profileAttackSync(
        profile,
        "tribes-candidate-create",
        () =>
          nearbyTribes.map((tribe) =>
            this.createEarlyGameTribeCandidate(tribe, candidateContext),
          ),
      );

      await profileAttackAsync(profile, "tribes-boat-etas", () =>
        this.enrichEarlyGameTribeBoatEtas(candidates, borderByTribe));
      this.normalizeEarlyGameCaptureEfficiencies(candidates);
      const futureFoodById = profileAttackSync(
        profile,
        "tribes-future-food",
        () =>
          this.getEarlyGameFutureFoodCandidates(
            otherPlayers,
            candidates,
            competitorProfiles,
            foodRaceById,
            nodes,
          ),
      );
      const futureFoodCandidates = [...futureFoodById.values()];
      profileAttackSync(profile, "tribes-merge-adjacency", () =>
        this.mergeEarlyGameCandidateAdjacency(
          candidates,
          borderByTribe,
          tribeAdjacency,
        ),
      );
      const clusterOpportunities = profileAttackSync(
        profile,
        "tribes-cluster-opportunities",
        () =>
          calculateReachableTribeClusterOpportunities(
            futureFoodCandidates,
            tribeAdjacency,
            candidates.map((candidate) => candidate.id),
          ),
      );
      profileAttackSync(profile, "tribes-future-food-scores", () =>
        this.enrichEarlyGameFutureFoodScores(
          candidates,
          futureFoodCandidates,
          clusterOpportunities,
        ),
      );
      profileAttackSync(profile, "tribes-publish-cluster", () =>
        this.publishPreferredEarlyGameCluster(candidates, futureFoodById),
      );

      return candidates;
    }

    async estimateEarlyGameTribeBoatEta(
      targetBorder,
      candidate = null,
      sharedOwnShores = null,
    ) {
      {
        if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return null;
      }
      if (
        this.game.hasTransportRouteEstimator !== true ||
        typeof this.game.estimateTransportRouteTicks !== "function" ||
        typeof this.game.isShore !== "function" ||
        typeof this.game.manhattanDist !== "function" ||
        typeof this.player.borderTiles !== "function" ||
        typeof this.player.bestTransportShipSpawn !== "function"
      ) {
        return null;
      }

      const ownShores = this.getEarlyGameOwnShores(sharedOwnShores);
      const targetShores = this.getEarlyGameTribeBoatTargetShores(
        targetBorder,
        candidate,
      );
      if (ownShores.length === 0 || targetShores.length === 0) return null;

      const distanceToOwnShore = this.earlyGameOwnShoreDistance(ownShores);
      const rankedTargetShores = this.rankEarlyGameTribeBoatTargetShores(
        targetShores,
        distanceToOwnShore,
      );

      const measuredRoutes = await Promise.all(
        rankedTargetShores
          .slice(0, EARLY_TRIBE_BOAT_ETA_TARGETS)
          .map(async ({ tile: targetShore }) => {
          {
            const spawn = await withTimeout(
              this.player.bestTransportShipSpawn(targetShore),
              WORKER_TIMEOUT_MS,
              false,
            );
            if (spawn === false) return null;
            const eta = await withTimeout(
              this.game.estimateTransportRouteTicks(targetShore),
              WORKER_TIMEOUT_MS,
              null,
            );
            const numericEta = Number(eta);
            return Number.isFinite(numericEta) && numericEta >= 0
              ? { eta: numericEta, tile: targetShore }
              : null;
          }
        }),
      );
      const bestRoute = measuredRoutes
        .filter(Boolean)
        .sort((left, right) => left.eta - right.eta)[0];
      if (!bestRoute) return null;
      if (candidate) candidate.boatTargetTile = bestRoute.tile;
      return bestRoute.eta;
    }

    getEarlyGameTribeBoatTargetShores(targetBorder, candidate = null) {
      const target = candidate?.player;
      const targetSnapshot = target?.borderTiles?.();
      // A candidate border comes from the target's authoritative snapshot in the
      // normal path. Reuse its cached shore subset only when it is that exact
      // snapshot: a newer/different border must retain the direct classification
      // below, rather than using a coast from a different game state.
      if (
        targetSnapshot === targetBorder &&
        typeof target?.shoreBorderTiles === "function"
      ) {
        return target.shoreBorderTiles();
      }
      return Array.from(targetBorder || []).filter((tile) => this.game.isShore(tile));
    }

    // Keep only the same first K shores that a stable full distance sort would
    // select. Tribe borders can contain thousands of shore tiles; materializing
    // and sorting every `{ tile, distance }` record was a measurable main-thread
    // spike even though the next stage probes only K routes. Strictly inserting
    // before larger distances preserves original border iteration order for ties.
    rankEarlyGameTribeBoatTargetShores(targetShores, distanceToOwnShore) {
      const ranked = [];
      for (const tile of targetShores) {
        const distance = distanceToOwnShore(tile);
        let index = 0;
        while (
          index < ranked.length &&
          ranked[index].distance <= distance
        ) {
          index++;
        }
        if (index >= EARLY_TRIBE_BOAT_ETA_TARGETS) continue;
        ranked.splice(index, 0, { tile, distance });
        if (ranked.length > EARLY_TRIBE_BOAT_ETA_TARGETS) ranked.pop();
      }
      return ranked;
    }

    getEarlyGameOwnShores(sharedOwnShores = null) {
      if (Array.isArray(sharedOwnShores)) return sharedOwnShores;
      if (typeof this.player.shoreBorderTiles === "function") {
        return this.player.shoreBorderTiles();
      }
      return Array.from(this.player.borderTiles()).filter((tile) =>
        this.game.isShore(tile),
      );
    }

    earlyGameOwnShoreDistance(ownShores) {
      const cached = this.earlyGameOwnShoreDistanceIndex;
      if (cached?.shores === ownShores) return cached.distance;
      const points = ownShores
        .map((tile) => ({ tile, x: this.game.x(tile), y: this.game.y(tile) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      const index = this.buildEarlyGameOwnShoreDistanceIndex(points);
      const distance = (tile) => {
        const x = this.game.x(tile);
        const y = this.game.y(tile);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
        return this.queryEarlyGameOwnShoreDistanceIndex(index, x, y, Infinity);
      };
      this.earlyGameOwnShoreDistanceIndex = { shores: ownShores, distance };
      return distance;
    }

    buildEarlyGameOwnShoreDistanceIndex(points, depth = 0) {
      if (points.length === 0) return null;
      const { point, leftPoints, rightPoints } =
        this.splitEarlyGameOwnShoreDistanceIndexPoints(points, depth);
      const left = this.buildEarlyGameOwnShoreDistanceIndex(leftPoints, depth + 1);
      const right = this.buildEarlyGameOwnShoreDistanceIndex(rightPoints, depth + 1);
      return this.createEarlyGameOwnShoreDistanceIndexNode(point, left, right);
    }

    splitEarlyGameOwnShoreDistanceIndexPoints(points, depth) {
      const axis = depth % 2 === 0 ? "x" : "y";
      points.sort((left, right) => left[axis] - right[axis]);
      const middle = Math.floor(points.length / 2);
      return {
        point: points[middle],
        leftPoints: points.slice(0, middle),
        rightPoints: points.slice(middle + 1),
      };
    }

    createEarlyGameOwnShoreDistanceIndexNode(point, left, right) {
      return {
        ...point,
        left,
        right,
        ...this.earlyGameOwnShoreDistanceIndexBounds(point, left, right),
      };
    }

    earlyGameOwnShoreDistanceIndexBounds(point, left, right) {
      return {
        minX: this.earlyGameOwnShoreIndexMinimum(point.x, left?.minX, right?.minX),
        maxX: this.earlyGameOwnShoreIndexMaximum(point.x, left?.maxX, right?.maxX),
        minY: this.earlyGameOwnShoreIndexMinimum(point.y, left?.minY, right?.minY),
        maxY: this.earlyGameOwnShoreIndexMaximum(point.y, left?.maxY, right?.maxY),
      };
    }

    earlyGameOwnShoreIndexMinimum(value, left, right) {
      return Math.min(value, left ?? Infinity, right ?? Infinity);
    }

    earlyGameOwnShoreIndexMaximum(value, left, right) {
      return Math.max(value, left ?? -Infinity, right ?? -Infinity);
    }

    queryEarlyGameOwnShoreDistanceIndex(index, x, y, best) {
      if (index === null) return best;
      const distance = Math.abs(index.x - x) + Math.abs(index.y - y);
      let nextBest = Math.min(best, distance);
      const branches = [index.left, index.right].filter(Boolean).sort((left, right) =>
        this.earlyGameOwnShoreIndexLowerBound(left, x, y) -
        this.earlyGameOwnShoreIndexLowerBound(right, x, y),
      );
      for (const branch of branches) {
        if (this.earlyGameOwnShoreIndexLowerBound(branch, x, y) >= nextBest) continue;
        nextBest = this.queryEarlyGameOwnShoreDistanceIndex(branch, x, y, nextBest);
      }
      return nextBest;
    }

    earlyGameOwnShoreIndexLowerBound(index, x, y) {
      const dx = this.earlyGameOwnShoreAxisDistance(x, index.minX, index.maxX);
      const dy = this.earlyGameOwnShoreAxisDistance(y, index.minY, index.maxY);
      return dx + dy;
    }

    earlyGameOwnShoreAxisDistance(value, minimum, maximum) {
      if (value < minimum) return minimum - value;
      if (value > maximum) return value - maximum;
      return 0;
    }

    // Keep a bounded, best-effort profile of how visible rivals are expanding.
    // Territory-centre movement and tile growth are useful leading indicators
    // before an outgoing attack appears in the target's incoming snapshot.
    earlyGameCompetitorTick() {
      {
        return Number(this.game.ticks?.()) || 0;
      }
    }

    earlyGameCompetitorOutgoingTargets(other) {
      // Direct attacks from passive tribes are already read from each selected
      // candidate's incoming attacks. Re-reading every tribe's outgoing list
      // repeats hundreds of player-view traversals on dense maps. Nations and
      // Humans retain their complete topology because they can race a cluster
      // from outside the candidate's immediate incoming snapshot.
      if (!this.earlyGameCompetitorTracksOutgoingAttacks(other)) return [];
      const outgoing = other.outgoingAttacks?.() ?? [];
      const targets = [];
      for (const attack of outgoing) {
        {
          const target = this.earlyGameCompetitorAttackTarget(attack);
          if (target) targets.push(target);
        }
      }
      return targets;
    }

    earlyGameCompetitorTracksOutgoingAttacks(other) {
      return other?.type?.() !== PlayerType.Bot;
    }

    indexEarlyGameCompetitorOutgoingTargets(targets) {
      const byTarget = new Map();
      for (const attack of targets) {
        const direct = byTarget.get(attack.targetSid);
        if (direct) direct.push(attack);
        else byTarget.set(attack.targetSid, [attack]);
      }
      return byTarget;
    }

    earlyGameCompetitorAttackTarget(attack) {
      if (attack.retreating?.() === true) return null;
      const target = attack.target?.();
      const targetSid = target?.smallID?.();
      if (targetSid == null) return null;
      return {
        targetSid,
        target,
        troops: Math.max(0, Number(attack.troops?.()) || 0),
        location: target.nameLocation?.() || null,
      };
    }

    earlyGameCompetitorProgress(previous, tiles, tick) {
      if (!previous) return 0;
      const tickDelta = Math.max(1, tick - previous.tick);
      const tileDelta = Math.max(0, tiles - previous.tiles);
      return Math.min(
        1,
        tileDelta / Math.max(2, previous.tiles * 0.15, tickDelta * 2),
      );
    }

    earlyGameCompetitorMovement(other, sid, tick) {
      const location = other.nameLocation?.() || null;
      const x = Number(location?.x);
      const y = Number(location?.y);
      const tiles = Math.max(0, Number(other.numTilesOwned?.()) || 0);
      const previous = this.earlyFoodMovement.get(sid);
      const hasLocation = Number.isFinite(x) && Number.isFinite(y);
      const previousHasLocation = Boolean(
        previous && Number.isFinite(previous.x) && Number.isFinite(previous.y),
      );
      const dx = hasLocation && previousHasLocation ? x - previous.x : 0;
      const dy = hasLocation && previousHasLocation ? y - previous.y : 0;
      const progress = this.earlyGameCompetitorProgress(previous, tiles, tick);
      this.earlyFoodMovement.set(sid, { tick, x, y, tiles });
      return {
        location: hasLocation ? { x, y } : null,
        dx,
        dy,
        progress,
      };
    }

    earlyGameCompetitorProfile(other, mySid, tick) {
      if (!other?.isPlayer?.() || !other.isAlive?.()) return null;
      const sid = other.smallID?.();
      if (sid == null || sid === mySid) return null;
      const outgoingTargets = this.earlyGameCompetitorOutgoingTargets(other);
      return {
        sid,
        ...this.earlyGameCompetitorMovement(other, sid, tick),
        troops: Math.max(0, Number(other.troops?.()) || 0),
        outgoingTargets,
        outgoingTargetsByTarget: this.indexEarlyGameCompetitorOutgoingTargets(
          outgoingTargets,
        ),
      };
    }

    earlyGameCompetitorAttackSignature(other) {
      if (!this.earlyGameCompetitorTracksOutgoingAttacks(other)) return "";
      const attacks = other?.outgoingAttacks?.() ?? [];
      return attacks
        .map((attack) => [
          attack?.target?.()?.smallID?.(),
          Math.max(0, Number(attack?.troops?.()) || 0),
          attack?.retreating?.() === true ? 1 : 0,
        ].join(":"))
        .sort()
        .join(",");
    }

    earlyGameCompetitorIdentitySignature(other, mySid) {
      const sid = other?.smallID?.();
      const isPlayer = other?.isPlayer?.() === true;
      let friendly = 0;
      if (sid === mySid || (isPlayer && this.player.isFriendly(other) === true)) {
        friendly = 1;
      }
      return [
        sid,
        isPlayer ? 1 : 0,
        other?.isAlive?.() === true ? 1 : 0,
        other?.type?.(),
        friendly,
      ].join("|");
    }

    earlyGameCompetitorLocationSignature(other) {
      const location = other?.nameLocation?.();
      return [Number(location?.x), Number(location?.y)].join("|");
    }

    earlyGameCompetitorResourcesSignature(other) {
      const type = other?.type?.();
      // A tribe's passive production changes on almost every decision and is
      // not evidence that it is racing this cluster. Territory is dynamic too:
      // it is read by earlyGameCompetitorMovement on the resource refresh path
      // to derive live progress, so it must not invalidate the immutable attack
      // topology for every other competitor. Nations/Humans retain troop
      // precision because their mobile reserve is itself a strategic threat.
      const troops = type === PlayerType.Bot
        ? ""
        : Math.max(0, Number(other?.troops?.()) || 0);
      return [
        type === PlayerType.Bot
          ? ""
          : Math.max(0, Number(other?.numTilesOwned?.()) || 0),
        troops,
      ].join("|");
    }

    earlyGameCompetitorSignatureRecord(other, mySid) {
      return [
        this.earlyGameCompetitorStableSignatureRecord(other, mySid),
        this.earlyGameCompetitorResourcesSignature(other),
      ].join("|");
    }

    earlyGameCompetitorStableSignatureRecord(other, mySid) {
      return [
        this.earlyGameCompetitorIdentitySignature(other, mySid),
        this.earlyGameCompetitorLocationSignature(other),
        this.earlyGameCompetitorAttackSignature(other),
      ].join("|");
    }

    earlyGameCompetitorProfilesSignature(players, mySid) {
      return this.earlyGameCompetitorProfilesSignatures(players, mySid).signature;
    }

    earlyGameCompetitorProfilesStableSignature(players, mySid) {
      return this.earlyGameCompetitorProfilesSignatures(players, mySid)
        .stableSignature;
    }

    earlyGameCompetitorProfilesSignatures(players, mySid) {
      const signatures = [];
      const stableSignatures = [];
      const stableSignaturesBySid = new Map();
      for (const other of players ?? []) {
        if (other?.smallID?.() === mySid) continue;
        const stableSignature = this.earlyGameCompetitorStableSignatureRecord(
          other,
          mySid,
        );
        const sid = other?.smallID?.();
        if (sid !== null && sid !== undefined) {
          stableSignaturesBySid.set(sid, stableSignature);
        }
        stableSignatures.push(stableSignature);
        signatures.push(
          [
            stableSignature,
            this.earlyGameCompetitorResourcesSignature(other),
          ].join("|"),
        );
      }
      return {
        signature: signatures.sort().join(";"),
        stableSignature: stableSignatures.sort().join(";"),
        stableSignaturesBySid,
      };
    }

    async refreshEarlyGameCompetitorProfilesFromResources(
      players,
      cachedProfiles,
      tick,
    ) {
      const profilesBySid = new Map(
        cachedProfiles.map((profile) => [profile.sid, profile]),
      );
      const profiles = [];
      let sliceStartedAt = earlyGameTopologyNow();
      for (const other of players ?? []) {
        const sid = other?.smallID?.();
        const cached = sid === null || sid === undefined
          ? null
          : profilesBySid.get(sid);
        if (cached) {
          profiles.push({
            ...cached,
            ...this.earlyGameCompetitorMovement(other, sid, tick),
            troops: Math.max(0, Number(other.troops?.()) || 0),
          });
        }
        if (shouldYieldEarlyGameTribeNodes(sliceStartedAt)) {
          await yieldEarlyGameTopologyWork();
          sliceStartedAt = earlyGameTopologyNow();
        }
      }
      return profiles;
    }

    earlyGameCompetitorProfilesCacheFresh(cached, signature, tick) {
      return (
        cached?.signature === signature &&
        tick >= cached.tick &&
        tick - cached.tick <= EARLY_GAME_TRIBE_RISK_SNAPSHOT_CACHE_TICKS
      );
    }

    earlyGameCompetitorTopologyCacheFresh(cached, stableSignature, tick) {
      return (
        cached?.stableSignature === stableSignature &&
        tick >= cached.tick &&
        tick - cached.tick <= EARLY_GAME_TRIBE_RISK_SNAPSHOT_CACHE_TICKS
      );
    }

    earlyGameCompetitorProfileForSnapshot(other, mySid, tick, stableSignature) {
      const sid = other?.smallID?.();
      const cached = sid === null || sid === undefined
        ? null
        : this.earlyGameCompetitorProfileTopologyCache?.get(sid);
      // A change in one Nation's frontier or outgoing attacks must not make us
      // rebuild every other Nation's attack index. Movement and troops remain
      // live per decision; only the immutable topology portion is reused.
      if (cached?.stableSignature === stableSignature) {
        return {
          ...cached.profile,
          ...this.earlyGameCompetitorMovement(other, sid, tick),
          troops: Math.max(0, Number(other.troops?.()) || 0),
        };
      }
      const profile = this.earlyGameCompetitorProfile(other, mySid, tick);
      if (profile) {
        if (!this.earlyGameCompetitorProfileTopologyCache) {
          this.earlyGameCompetitorProfileTopologyCache = new Map();
        }
        this.earlyGameCompetitorProfileTopologyCache.set(profile.sid, {
          stableSignature,
          profile,
        });
      }
      return profile;
    }

    // Keep a bounded, best-effort profile of how visible rivals are expanding.
    async getEarlyGameCompetitorProfiles(players, mySid) {
      const profiles = [];
      const seen = new Set();
      const tick = this.earlyGameCompetitorTick();
      const { signature, stableSignature, stableSignaturesBySid } =
        this.earlyGameCompetitorProfilesSignatures(
        players,
        mySid,
      );
      const cached = this.earlyGameCompetitorProfilesCache;
      if (this.earlyGameCompetitorProfilesCacheFresh(cached, signature, tick)) {
        return cached.profiles;
      }
      if (
        this.earlyGameCompetitorTopologyCacheFresh(
          cached,
          stableSignature,
          tick,
        )
      ) {
        const refreshed = await this.refreshEarlyGameCompetitorProfilesFromResources(
          players,
          cached.profiles,
          tick,
        );
        this.earlyGameCompetitorProfilesCache = {
          tick,
          signature,
          stableSignature,
          profiles: refreshed,
        };
        return refreshed;
      }
      let sliceStartedAt = earlyGameTopologyNow();
      for (const other of players ?? []) {
        const profile = this.earlyGameCompetitorProfileForSnapshot(
          other,
          mySid,
          tick,
          stableSignaturesBySid.get(other?.smallID?.()) ??
            this.earlyGameCompetitorStableSignatureRecord(other, mySid),
        );
        if (profile) {
          profiles.push(profile);
          seen.add(profile.sid);
        }
        if (shouldYieldEarlyGameTribeNodes(sliceStartedAt)) {
          await yieldEarlyGameTopologyWork();
          sliceStartedAt = earlyGameTopologyNow();
        }
      }
      for (const sid of this.earlyFoodMovement.keys()) {
        if (!seen.has(sid)) this.earlyFoodMovement.delete(sid);
        if (shouldYieldEarlyGameTribeNodes(sliceStartedAt)) {
          await yieldEarlyGameTopologyWork();
          sliceStartedAt = earlyGameTopologyNow();
        }
      }
      this.earlyGameCompetitorProfilesCache = {
        tick,
        signature,
        stableSignature,
        profiles,
      };
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
    earlyFoodRaceRecord(records, sid) {
      let record = records.get(sid);
      if (!record) {
        record = { troops: 0, progress: 0, vector: 0 };
        records.set(sid, record);
      }
      return record;
    }

    appendIncomingFoodRaceSignals(tribe, tribeSid, context) {
      {
        for (const attack of tribe.incomingAttacks?.() ?? []) {
          if (attack.retreating?.() === true) continue;
          const sid = attack.attacker?.()?.smallID?.();
          if (sid == null || sid === this.player.smallID() || sid === tribeSid) continue;
          const record = this.earlyFoodRaceRecord(context.records, sid);
          record.troops = Math.max(
            record.troops,
            Math.max(0, Number(attack.troops?.()) || 0),
          );
          context.incomingAttackers.add(sid);
        }
      }
    }

    applyDirectFoodRaceSignal(profile, tribeSid, context) {
      const direct = profile.outgoingTargetsByTarget?.get(tribeSid) ||
        profile.outgoingTargets.filter((attack) => attack.targetSid === tribeSid);
      if (direct.length === 0) return false;
      const record = this.earlyFoodRaceRecord(context.records, profile.sid);
      context.directAttackers.add(profile.sid);
      record.troops = Math.max(
        record.troops,
        direct.reduce((sum, attack) => sum + attack.troops, 0),
      );
      record.vector = 1;
      record.progress = Math.max(record.progress, profile.progress);
      return true;
    }

    earlyGameFoodRaceCellKey(location) {
      const x = Number(location?.x);
      const y = Number(location?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [
        Math.floor(x / EARLY_GAME_FOOD_RACE_RADIUS),
        Math.floor(y / EARLY_GAME_FOOD_RACE_RADIUS),
      ].join(":");
    }

    earlyGameFoodRaceProfileIndex(competitorProfiles) {
      const cached = this.earlyGameFoodRaceProfileIndexCache;
      if (cached?.competitorProfiles === competitorProfiles) return cached;

      const directionalByCell = new Map();
      const directByTarget = new Map();
      for (const profile of competitorProfiles ?? []) {
        const cell = this.earlyGameFoodRaceCellKey(profile.location);
        if (cell !== null) {
          const directional = directionalByCell.get(cell);
          if (directional) directional.push(profile);
          else directionalByCell.set(cell, [profile]);
        }
        for (const targetSid of profile.outgoingTargetsByTarget?.keys?.() ?? []) {
          const direct = directByTarget.get(targetSid);
          if (direct) direct.push(profile);
          else directByTarget.set(targetSid, [profile]);
        }
      }
      const index = { competitorProfiles, directionalByCell, directByTarget };
      this.earlyGameFoodRaceProfileIndexCache = index;
      return index;
    }

    earlyGameRelevantFoodRaceProfiles(index, tribeSid, tribeCenter) {
      const relevant = new Set(index.directByTarget.get(tribeSid) || []);
      const cell = this.earlyGameFoodRaceCellKey(tribeCenter);
      if (cell === null) return relevant;
      const [cellX, cellY] = cell.split(":").map(Number);
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        for (let y = cellY - 1; y <= cellY + 1; y++) {
          for (const profile of index.directionalByCell.get(`${x}:${y}`) || []) {
            relevant.add(profile);
          }
        }
      }
      return relevant;
    }

    earlyGameProfileTribeAlignment(profile, tribeCenter) {
      let alignment = this.earlyGameVectorAlignment(
        profile.location,
        tribeCenter,
        profile.dx,
        profile.dy,
      );
      for (const attack of profile.outgoingTargets) {
        const target = attack.location;
        alignment = Math.max(
          alignment,
          this.earlyGameVectorAlignment(
            profile.location,
            tribeCenter,
            Number(target?.x) - Number(profile.location.x),
            Number(target?.y) - Number(profile.location.y),
          ) * 0.9,
        );
      }
      const distance = this.earlyGameCenterDistance(profile.location, tribeCenter);
      if (!Number.isFinite(distance)) return 0;
      return alignment * Math.max(
        0,
        Math.min(1, 1 - distance / EARLY_GAME_FOOD_RACE_RADIUS),
      );
    }

    applyDirectionalFoodRaceSignal(profile, tribeCenter, context) {
      if (!profile.location || !tribeCenter) return;
      const alignment = this.earlyGameProfileTribeAlignment(profile, tribeCenter);
      if (alignment <= 0.35 || profile.progress <= 0) return;
      const record = this.earlyFoodRaceRecord(context.records, profile.sid);
      record.vector = Math.max(record.vector, alignment);
      record.progress = Math.max(record.progress, profile.progress);
      record.troops = Math.max(record.troops, profile.troops * 0.1 * alignment);
    }

    foodRaceSignalSummary(tribe, context) {
      const values = [...context.records.values()];
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
        directAttackers: context.directAttackers.size,
        incomingAttackers: context.incomingAttackers.size,
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
        directAttackers: context.directAttackers.size,
        incomingAttackers: context.incomingAttackers.size,
        contestingPlayers: context.records.size,
      };
    }

    getEarlyGameFoodRaceSignals({
      tribe,
      tribeSid,
      tribeCenter,
      competitorProfiles,
    }) {
      const context = {
        records: new Map(),
        incomingAttackers: new Set(),
        directAttackers: new Set(),
      };
      this.appendIncomingFoodRaceSignals(tribe, tribeSid, context);
      const index = this.earlyGameFoodRaceProfileIndex(competitorProfiles);
      for (const profile of this.earlyGameRelevantFoodRaceProfiles(
        index,
        tribeSid,
        tribeCenter,
      )) {
        if (profile.sid === tribeSid) continue;
        const direct = this.applyDirectFoodRaceSignal(profile, tribeSid, context);
        if (!direct) this.applyDirectionalFoodRaceSignal(profile, tribeCenter, context);
      }
      return this.foodRaceSignalSummary(tribe, context);
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

      const shores =
        typeof this.player.oceanShoreBorderTiles === "function"
          ? this.player.oceanShoreBorderTiles() || []
          : Array.from(this.player.borderTiles()).filter((tile) =>
              this.game.isOceanShore(tile),
            );
      if (shores.length === 0) return false;

      const targets = this.scanEarlyOceanTargets(shores);
      const tick = this.currentAttackDecisionTick();
      const target = this.nextEarlyOceanProbeTarget(targets, tick);
      if (target === null) return false;
      const spawn = await withTimeout(
        this.player.bestTransportShipSpawn(target.tile),
        WORKER_TIMEOUT_MS,
        false,
      );
      if (spawn === false || !(await this.allowEarlyGameBoat(target.tile))) {
        this.rememberEarlyOceanProbeFailure(target.tile, tick);
        return false;
      }

      const troops = this.getEarlyGameProbeTroops(
        state.settings.boatProbeFrac,
        this.getEarlyGameTerraNulliusReserveTroops(),
      );
      if (troops < 1) return false;
      if (
        this.emitBoat(
          target.tile,
          troops,
          "⛵ TerraNullius probe",
          this.game.terraNullius(),
        )
      ) {
        this.earlyOceanProbeRetryTicks.delete(target.tile);
        state.beachhead = {
          tile: target.tile,
          at: this.game.ticks(),
          surged: false,
        };
        state.earlyGame.oceanTarget = {
          distance: target.dist,
          oceanShore: true,
        };
        state.earlyGame.action = "maritime-probe";
        return true;
      }
      return false;
    }

    nextEarlyOceanProbeTarget(targets, tick) {
      const ready = [];
      for (const target of targets.slice(0, BOAT_PROBE_CANDIDATES)) {
        if (this.boatTargetTaken(target.tile)) continue;
        if (this.earlyOceanProbeRetryTicks.get(target.tile) > tick) continue;
        ready.push(target);
        if (ready.length >= EARLY_OCEAN_ROUTE_PROBE_BUDGET) break;
      }
      return ready[0] || null;
    }

    rememberEarlyOceanProbeFailure(tile, tick = this.currentAttackDecisionTick()) {
      this.earlyOceanProbeRetryTicks.set(tile, tick + EARLY_OCEAN_PROBE_RETRY_TICKS);
      // The opening window is finite, but prune expired entries so long games
      // cannot retain every rejected coast visited during expansion.
      if (this.earlyOceanProbeRetryTicks.size <= BOAT_PROBE_CANDIDATES * 4) return;
      for (const [candidate, retryTick] of this.earlyOceanProbeRetryTicks) {
        if (retryTick <= tick) this.earlyOceanProbeRetryTicks.delete(candidate);
      }
    }

    scanEarlyOceanTargets(shores) {
      if (typeof this.game.isOceanShore !== "function") return [];
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
      // Adjacent shore samples overlap heavily. Remember only rejected tiles
      // for this scan; the game state cannot change during this synchronous
      // loop, while successful tiles stay governed by `seen` as before.
      const rejected = new Set();
      const targets = [];
      const scan = { seen, rejected, targets };
      for (const shore of samples) {
        this.appendEarlyOceanTargets(shore, radius, step, scan);
      }
      return targets;
    }

    earlyOceanTileIsEligible(tile, seen, rejected = null) {
      if (seen.has(tile) || rejected?.has(tile)) return false;
      if (!this.game.isLand(tile)) {
        rejected?.add(tile);
        return false;
      }
      if (this.game.hasOwner(tile) || this.game.hasFallout(tile)) {
        rejected?.add(tile);
        return false;
      }
      if (!this.game.isOceanShore(tile)) {
        rejected?.add(tile);
        return false;
      }
      const mySid = this.player.smallID();
      const eligible = !this.game
        .neighbors(tile)
        .some((neighbor) => this.game.ownerID(neighbor) === mySid);
      if (!eligible) rejected?.add(tile);
      return eligible;
    }

    appendEarlyOceanTargets(shore, radius, step, scan) {
      const { seen, rejected, targets } = scan;
      const sx = this.game.x(shore);
      const sy = this.game.y(shore);
      for (let dx = -radius; dx <= radius; dx += step) {
        for (let dy = -radius; dy <= radius; dy += step) {
          const x = sx + dx;
          const y = sy + dy;
          if (!this.game.isValidCoord(x, y)) continue;
          const tile = this.game.ref(x, y);
          if (!this.earlyOceanTileIsEligible(tile, seen, rejected)) continue;
          seen.add(tile);
          this.insertEarlyOceanTarget(targets, {
            tile,
            dist: dx * dx + dy * dy,
          });
        }
      }
    }

    // The caller only probes four routes. Keep the same first four entries a
    // stable full distance sort would produce, without retaining or sorting the
    // potentially thousands of other eligible ocean tiles.
    insertEarlyOceanTarget(targets, target) {
      let index = 0;
      while (index < targets.length && targets[index].dist <= target.dist) {
        index++;
      }
      if (index >= BOAT_PROBE_CANDIDATES) return;
      targets.splice(index, 0, target);
      if (targets.length > BOAT_PROBE_CANDIDATES) targets.pop();
    }

    // Read the cached pathfinder result after bestTransportShipSpawn() has proven
    // that a transport can be launched. The gameApi adapter uses the upstream
    // transport route when available and otherwise performs a bounded water-graph
    // search, so a bare "reachable" result is never treated as a short ETA.
    async getBoatRouteEta(tile) {
      if (
        this.game.hasTransportRouteEstimator !== true ||
        typeof this.game.estimateTransportRouteTicks !== "function"
      ) {
        return null;
      }
      // A test/detached behavior may not expose a game clock. In that case do
      // not cache: there is no sound boundary on which to expire the route.
      const hasGameTick = typeof this.game.ticks === "function";
      const tick = hasGameTick ? this.currentAttackDecisionTick() : null;
      if (tick !== null) {
        if (this.boatRouteEtaCacheTick !== tick) {
          this.resetBoatRouteEtaCache(tick);
        }
        if (this.boatRouteEtaCache?.has(tile)) {
          return this.boatRouteEtaCache.get(tile);
        }
      }
      const eta = await withTimeout(
        this.game.estimateTransportRouteTicks(tile),
        WORKER_TIMEOUT_MS,
        null,
      );
      if (tick !== null) this.boatRouteEtaCache.set(tile, eta);
      return eta;
    }

    // Exploratory/probe boats are useful only when they can return quickly
    // enough to affect the current frontier. Fail closed when pathfinding is
    // unavailable: reachability alone must not reopen the old multi-minute
    // fallback.
    async allowBoatExplorationRoute(tile) {
      if (!state.settings.winFixes) return true;
      const eta = await this.getBoatRouteEta(tile);
      return isBoatExplorationEta(eta);
    }

    // Exact ETA remains deliberately fail-closed during Early Game. Its stricter
    // 30-second opening-window policy is independent from the two-minute cap on
    // exploratory boats.
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
      const eta = await this.getBoatRouteEta(tile);
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
    randomBoatLaunchShores() {
      if (!(state.settings.features && state.settings.features.boat)) return [];
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return [];
      if (state.settings.winFixes) {
        const totalLand = this.game.numLandTiles() || 1;
        if (this.player.numTilesOwned() / totalLand > 0.25) return [];
      }
      if (
        this.player.unitCount(UNIT.TransportShip) >=
        this.game.config().boatMaxNumber()
      ) {
        return [];
      }
      return this.getEarlyGameOwnShores();
    }

    async findRandomBoatDestination(source, borderingEnemies) {
      // Probe one ranked candidate per ordinary decision.  The old high-interest
      // plus generic fallback ladder could await several worker timeouts in the
      // same frame. Persist which half is due next so the fallback remains part
      // of the strategy, just in the following eligible decision.
      const highInterestOnly = this.randomBoatFallbackOnly !== true;
      const destination = await this.findRandomBoatTarget(
        source,
        borderingEnemies,
        highInterestOnly,
        highInterestOnly && state.settings.winFixes,
        {
          maxProbes: 1,
          timeoutMs: ORDINARY_RANDOM_BOAT_PROBE_TIMEOUT_MS,
        },
      );
      this.randomBoatFallbackOnly = destination === null
        ? highInterestOnly
        : false;
      return destination;
    }

    randomBoatTargetIsTerraNullius(tile) {
      const owner = this.game.owner?.(tile);
      return owner ? owner.isPlayer?.() !== true : !this.game.hasOwner?.(tile);
    }

    randomBoatTroops(isTerraNullius) {
      if (!state.settings.winFixes) return this.player.troops() / 5;
      if (isTerraNullius) {
        return this.getEarlyGameProbeTroops(
          state.settings.boatProbeFrac,
          this.getEarlyGameTerraNulliusReserveTroops(),
        );
      }
      return this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
    }

    // attackWithRandomBoat — AiAttackBehavior (private, now async via findRandomBoatTarget).
    async attackWithRandomBoat(borderingEnemies = []) {
      if (this.player === null) throw new Error("not initialized");
      const tick = this.currentAttackDecisionTick();
      if (
        this.randomBoatRetryNotBeforeTick !== null &&
        tick < this.randomBoatRetryNotBeforeTick
      ) return;
      const shores = this.randomBoatLaunchShores();
      if (shores.length === 0) return;

      const source = this.random.randElement(shores);
      const destination = await this.findRandomBoatDestination(
        source,
        borderingEnemies,
      );
      if (destination === null) {
        this.randomBoatRetryNotBeforeTick =
          tick + ORDINARY_RANDOM_BOAT_RETRY_TICKS;
        return;
      }

      const isTerraNullius = this.randomBoatTargetIsTerraNullius(destination);
      const troops = this.randomBoatTroops(isTerraNullius);
      if (troops < 1 || !(await this.allowEarlyGameBoat(destination))) {
        this.randomBoatRetryNotBeforeTick =
          tick + ORDINARY_RANDOM_BOAT_RETRY_TICKS;
        return;
      }
      const emitted = this.emitBoat(
        destination,
        troops,
        "⛵ Random boat",
        isTerraNullius ? this.game.terraNullius() : null,
      );
      if (emitted && state.settings.winFixes && isTerraNullius) {
        state.beachhead = {
          tile: destination,
          at: this.game.ticks(),
          surged: false,
        };
      }
    }

    // ── WIN-FIX: opportunistic amphibious landings (NOT in src) ────────────────
    // The user's strategy: send a CHEAP probe boat (boatProbeFrac of troops) at a
    // weak / freshly-MIRV'd overseas nation. If a warship sinks it mid-sea we only
    // lose ~1% of troops; if it LANDS (we own a tile near the drop) we immediately
    // pour a bigger surge force into the beachhead. Throttled so it never spams the
    // worker, and EXEMPT from the dominance guard (it targets specific weak/crater
    // tiles across water, not random soon-conquered land), so a dominating bot keeps
    // expanding overseas instead of stalling. Returns true if a boat was emitted.
    opportunisticBoatDiagnosticReason(capped, throttled, shoreCount) {
      if (capped) return "capped";
      if (throttled) return "throttled";
      return shoreCount === 0 ? "no-shore" : "ok";
    }

    opportunisticBoatLastAttemptMs() {
      return Math.max(
        0,
        Number(state.lastOppBoatMs) || 0,
        Number(state.lastOppBoatMissMs) || 0,
      );
    }

    logOpportunisticBoatDiagnostic(context) {
      {
        if (context.nowMs - (state._boatDiagAt || 0) <= 5000) return;
        state._boatDiagAt = context.nowMs;
        runtimeDebugLog("[Boat] diag:", {
          reason: this.opportunisticBoatDiagnosticReason(
            context.capped,
            context.throttled,
            context.shores.length,
          ),
          ships: context.ships,
          boatCap: context.boatCap,
          shoreTiles: context.shores.length,
          fill: Number(context.fill.toFixed(2)),
          islandFill: state.settings.boatIslandFill || 0.35,
          maxShips: this.game.config().boatMaxNumber(),
        });
      }
    }

    opportunisticBoatContext() {
      if (this.player === null) return null;
      if (!(state.settings.features && state.settings.features.boat)) return null;
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return null;
      const boatCap = Math.min(
        this.game.config().boatMaxNumber(),
        state.settings.maxConcurrentBoats || 3,
      );
      const ships = this.player.unitCount(UNIT.TransportShip);
      const nowMs = performance.now();
      const throttle = state.settings.oppBoatThrottleMs || 1200;
      const maxTroops = this.game.config().maxTroops(this.player);
      const context = {
        boatCap,
        ships,
        nowMs,
        capped: ships >= boatCap,
        // A no-target pass can probe several worker routes. Treat it as one
        // normal opportunistic attempt too, so an unreachable sea does not
        // re-run the same ladder every combat decision before the configured
        // launch cadence has elapsed.
        throttled: nowMs - this.opportunisticBoatLastAttemptMs() < throttle,
        fill: maxTroops > 0 ? this.player.troops() / maxTroops : 1,
        surplusFill: state.settings.boatSurplusFill || 0.75,
        shores: this.getEarlyGameOwnShores(),
      };
      this.logOpportunisticBoatDiagnostic(context);
      if (context.capped || context.throttled || context.shores.length === 0) return null;
      return context;
    }

    recentOpportunisticBoatSurge(tile, currentTick, windowTicks) {
      const surgeHistory =
        this.opportunisticBoatSurgeTickByTile ||
        (this.opportunisticBoatSurgeTickByTile = new Map());
      for (const [historyTile, surgeTick] of surgeHistory) {
        if (currentTick - surgeTick >= windowTicks) {
          surgeHistory.delete(historyTile);
        }
      }
      return surgeHistory.has(tile);
    }

    async tryOpportunisticBoatSurge(context) {
      const beachhead = state.beachhead;
      const windowTicks = state.settings.mirvBoatWindowTicks || 150;
      if (!beachhead || beachhead.tile == null) return false;
      const currentTick = this.game.ticks();
      if (
        this.recentOpportunisticBoatSurge(
          beachhead.tile,
          currentTick,
          windowTicks,
        )
      ) {
        return false;
      }
      if (beachhead.surged === true) return false;
      if (context.fill < context.surplusFill) return false;
      if (currentTick - (beachhead.at || 0) >= windowTicks) return false;
      if (!this.landingSucceeded(beachhead.tile)) return false;
      const spawn = await withTimeout(
        this.player.bestTransportShipSpawn(beachhead.tile),
        WORKER_TIMEOUT_MS,
        false,
      );
      if (spawn === false) return false;
      const troops = this.player.troops() * (state.settings.boatSurgeFrac || 0.25);
      const allowed =
        (await this.allowBoatExplorationRoute(beachhead.tile)) &&
        (await this.allowEarlyGameBoat(beachhead.tile));
      if (!allowed || !this.emitBoat(beachhead.tile, troops, "⚓ Surge landing")) {
        return false;
      }
      state.lastOppBoatMs = context.nowMs;
      beachhead.surged = true;
      this.opportunisticBoatSurgeTickByTile.set(beachhead.tile, currentTick);
      return true;
    }

    refreshInflightBoatTargets() {
      this._inflightBoatTargets = [];
      for (const unit of this.player.units(UNIT.TransportShip)) {
        {
          const tile = unit.targetTile ? unit.targetTile() : null;
          if (tile == null) continue;
          this._inflightBoatTargets.push({
            x: this.game.x(tile),
            y: this.game.y(tile),
          });
        }
      }
    }

    async nearbyOpportunisticBoatTarget(shores) {
      const { targets, scanCandidates } = await this.scanNearbyTargets(shores);
      for (const target of targets) {
        if (this.boatTargetTaken(target.tile)) continue;
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(target.tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn === false) continue;
        if (!(await this.allowBoatExplorationRoute(target.tile))) continue;
        return {
          dst: target.tile,
          dstOwned: target.owned,
          dstFallout: target.fallout,
          lowFillOk: true,
          scanCandidates,
        };
      }
      return { dst: null, scanCandidates };
    }

    async craterOpportunisticBoatTarget() {
      const crater = this.pickMirvCraterTarget();
      if (crater === null || this.boatTargetTaken(crater)) return null;
      const spawn = await withTimeout(
        this.player.bestTransportShipSpawn(crater),
        WORKER_TIMEOUT_MS,
        false,
      );
      if (spawn === false || !(await this.allowBoatExplorationRoute(crater))) {
        return null;
      }
      return { dst: crater, dstOwned: true, dstFallout: false, lowFillOk: false };
    }

    async randomOpportunisticBoatTarget(shores, highInterest) {
      const source = this.random.randElement(shores);
      const tile = await this.findRandomBoatTarget(source, [], highInterest, true);
      if (tile === null || this.boatTargetTaken(tile)) return null;
      return {
        dst: tile,
        dstOwned: this.game.hasOwner(tile),
        dstFallout: false,
        lowFillOk: false,
      };
    }

    opportunisticBoatSearchStage() {
      return OPPORTUNISTIC_BOAT_SEARCH_STAGES.includes(
        this.opportunisticBoatSearchStageName,
      )
        ? this.opportunisticBoatSearchStageName
        : OPPORTUNISTIC_BOAT_SEARCH_STAGES[0];
    }

    nextOpportunisticBoatSearchStage(stage) {
      const index = OPPORTUNISTIC_BOAT_SEARCH_STAGES.indexOf(stage);
      return OPPORTUNISTIC_BOAT_SEARCH_STAGES[
        (index + 1) % OPPORTUNISTIC_BOAT_SEARCH_STAGES.length
      ];
    }

    emptyOpportunisticBoatTarget(stage, scanCandidates = 0) {
      return {
        dst: null,
        scanCandidates,
        nextSearchStage: this.nextOpportunisticBoatSearchStage(stage),
      };
    }

    async findOpportunisticBoatTarget(shores, profile = null) {
      const stage = this.opportunisticBoatSearchStage();
      if (stage === "nearby") {
        const nearby = await profileAttackAsync(profile, "boat-target-nearby", () =>
          this.nearbyOpportunisticBoatTarget(shores),
        );
        return nearby.dst === null
          ? this.emptyOpportunisticBoatTarget(stage, nearby.scanCandidates)
          : nearby;
      }
      if (stage === "crater") {
        const crater = await profileAttackAsync(profile, "boat-target-crater", () =>
          this.craterOpportunisticBoatTarget(),
        );
        return crater || this.emptyOpportunisticBoatTarget(stage);
      }
      if (stage === "random-high" || stage === "random-player") {
        const highInterest = stage === "random-high";
        const target = await profileAttackAsync(
          profile,
          highInterest ? "boat-target-random-high" : "boat-target-random-player",
          () => this.randomOpportunisticBoatTarget(shores, highInterest),
        );
        return target || this.emptyOpportunisticBoatTarget(stage);
      }
      if (stage === "distant") {
        const far = await profileAttackAsync(profile, "boat-target-distant", () =>
          this.findDistantBoatTarget(profile, BOAT_PROBE_CANDIDATES),
        );
        return far === null
          ? this.emptyOpportunisticBoatTarget(stage)
          : { dst: far, dstOwned: true, dstFallout: false, lowFillOk: true };
      }
      const disconnected = await profileAttackAsync(
        profile,
        "boat-target-disconnected",
        () => this.findDisconnectedBoatTarget(BOAT_PROBE_CANDIDATES),
      );
      if (disconnected === null || this.boatTargetTaken(disconnected)) {
        return this.emptyOpportunisticBoatTarget(stage);
      }
      runtimeDebugLog("[Boat] heading to a DISCONNECTED neighbour's land");
      return {
        dst: disconnected,
        dstOwned: true,
        dstFallout: false,
        lowFillOk: true,
        scanCandidates: 0,
      };
    }

    opportunisticBoatLabel(target) {
      if (target.dstFallout) return "☢️ Nuked-coast grab";
      if (!target.lowFillOk) return "🛟 Probe landing";
      return target.dstOwned ? "🏝️ Weak-coast grab" : "🏝️ Island grab";
    }

    opportunisticBoatTroops(target) {
      if (state.settings.winFixes === true && !target.dstOwned) {
        return this.getEarlyGameProbeTroops(
          state.settings.boatProbeFrac,
          this.getEarlyGameTerraNulliusReserveTroops(),
        );
      }
      return this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
    }

    async emitOpportunisticBoatTarget(target, context) {
      const minimumFill = target.lowFillOk
        ? state.settings.boatIslandFill || 0.35
        : context.surplusFill;
      if (context.fill < minimumFill) {
        runtimeDebugLog("[Boat] fill too low to launch", {
          fill: Number(context.fill.toFixed(2)),
          need: minimumFill,
          contested: !target.lowFillOk,
        });
        return false;
      }
      const troops = this.opportunisticBoatTroops(target);
      if (troops < 1) return false;
      const label = this.opportunisticBoatLabel(target);
      const allowed =
        (await this.allowBoatExplorationRoute(target.dst)) &&
        (await this.allowEarlyGameBoat(target.dst));
      if (!allowed) return false;
      const emitted = this.emitBoat(
        target.dst,
        troops,
        label,
        !target.dstOwned ? this.game.terraNullius() : null,
      );
      if (!emitted) {
        runtimeDebugLog("[Boat] emitBoat REFUSED", label, {
          dstX: this.game.x(target.dst),
          dstY: this.game.y(target.dst),
          owner: this.game.hasOwner(target.dst)
            ? this.game.ownerID(target.dst)
            : "TN",
        });
        return false;
      }
      runtimeDebugLog("[Boat] LAUNCHED", label, Math.round(troops), "troops");
      state.lastOppBoatMs = context.nowMs;
      state.lastOppBoatMissMs = 0;
      state.beachhead = {
        tile: target.dst,
        at: this.game.ticks(),
        surged: false,
      };
      return true;
    }

    async maybeOpportunisticBoat(profile = null) {
      const context = profileAttackSync(profile, "boat-opportunistic-context", () =>
        this.opportunisticBoatContext(),
      );
      if (!context) return false;
      if (
        await profileAttackAsync(profile, "boat-opportunistic-surge", () =>
          this.tryOpportunisticBoatSurge(context),
        )
      ) {
        return true;
      }
      profileAttackSync(profile, "boat-opportunistic-inflight", () =>
        this.refreshInflightBoatTargets(),
      );
      const target = await profileAttackAsync(profile, "boat-opportunistic-target", () =>
        this.findOpportunisticBoatTarget(context.shores, profile),
      );
      if (target.dst === null) {
        this.opportunisticBoatSearchStageName = target.nextSearchStage;
        state.lastOppBoatMissMs = context.nowMs;
        runtimeDebugLog("[Boat] no reachable target", {
          scanCandidates: target.scanCandidates,
          shoreSamples: Math.min(
            state.settings.islandScanSamples || 6,
            context.shores.length,
          ),
          distant: state._distantDiag || null,
        });
        return false;
      }
      const emitted = await profileAttackAsync(profile, "boat-opportunistic-emit", () =>
        this.emitOpportunisticBoatTarget(target, context),
      );
      if (emitted) {
        this.opportunisticBoatSearchStageName = OPPORTUNISTIC_BOAT_SEARCH_STAGES[0];
      }
      return emitted;
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
      {
        tx = this.game.x(tile);
        ty = this.game.y(tile);
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
    nearbyBoatOwnerIsGrabbable(ownerId, context) {
      if (context.weakCache.has(ownerId)) return context.weakCache.get(ownerId);
      const owner = this.game.playerBySmallID(ownerId);
      const grabbable = Boolean(
        owner?.isPlayer?.() &&
          this.player.isFriendly(owner) === false &&
          owner.troops() < context.myTroops * context.weakFraction,
      );
      context.weakCache.set(ownerId, grabbable);
      return grabbable;
    }

    nearbyBoatTargetRecord(tile, dx, dy, context) {
      if (context.seen.has(tile) || !this.game.isLand(tile)) return null;
      const fallout = this.game.hasFallout(tile);
      const ownerId = this.game.ownerID(tile);
      if (ownerId === context.mySid) return null;
      const owned = this.game.hasOwner(tile);
      if (owned && !this.nearbyBoatOwnerIsGrabbable(ownerId, context)) return null;
      if (!owned && !fallout) {
        const bordersUs = this.game
          .neighbors(tile)
          .some((neighbor) => this.game.ownerID(neighbor) === context.mySid);
        if (bordersUs) return null;
      }
      context.seen.add(tile);
      return { tile, dist: dx * dx + dy * dy, owned, fallout };
    }

    nearbyBoatScanOffsets(radius, step) {
      const key = `${radius}:${step}`;
      if (this._nearbyBoatScanOffsets?.key === key) {
        return this._nearbyBoatScanOffsets.offsets;
      }
      const offsets = [];
      let index = 0;
      for (let dx = -radius; dx <= radius; dx += step) {
        for (let dy = -radius; dy <= radius; dy += step) {
          offsets.push({ dx, dy, dist: dx * dx + dy * dy, index: index++ });
        }
      }
      // Inspecting closest coordinates first lets the scan stop as soon as
      // every remaining coordinate is farther than the retained top-K. The
      // original nested-loop index breaks equal-distance ties deterministically.
      offsets.sort((left, right) => left.dist - right.dist || left.index - right.index);
      this._nearbyBoatScanOffsets = { key, offsets };
      return offsets;
    }

    insertNearbyBoatTarget(context, record) {
      context.scanCandidates++;
      let index = 0;
      // Insert after ties to match the stable full-sort ordering exactly.
      while (
        index < context.targets.length &&
        context.targets[index].dist <= record.dist
      ) {
        index++;
      }
      if (index >= context.targetLimit) return;
      context.targets.splice(index, 0, record);
      if (context.targets.length > context.targetLimit) context.targets.pop();
    }

    shouldYieldNearbyBoatScan(offsetsSinceYield, offsetIndex, offsetCount) {
      return (
        offsetsSinceYield >= BOAT_NEARBY_SCAN_SLICE_OFFSETS &&
        offsetIndex + 1 < offsetCount
      );
    }

    async scanNearbyTargets(shore) {
      const targetLimit = state.settings.islandProbeMax || 4;
      const context = {
        radius: state.settings.islandScanRadius || 40,
        step: state.settings.islandScanStep || 2,
        weakFraction: state.settings.boatWeakTroopFrac ?? 0.6,
        mySid: this.player.smallID(),
        myTroops: this.player.troops(),
        weakCache: new Map(),
        seen: new Set(),
        targets: [],
        scanCandidates: 0,
        targetLimit,
      };
      const sampleCount = Math.min(
        state.settings.islandScanSamples || 6,
        shore.length,
      );
      const sampledShores = [];
      for (let sample = 0; sample < sampleCount; sample++) {
        sampledShores.push(this.random.randElement(shore));
      }
      const offsets = this.nearbyBoatScanOffsets(context.radius, context.step);
      let offsetsSinceYield = 0;
      for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex++) {
        const offset = offsets[offsetIndex];
        const furthest = context.targets[context.targets.length - 1];
        // Process an entire equal-distance ring before stopping: otherwise a
        // later tie could be the stable preferred target. Every later offset
        // is strictly farther from every sampled shore.
        if (
          context.targets.length >= context.targetLimit &&
          offset.dist > furthest.dist
        ) break;
        for (const sampledShore of sampledShores) {
          const x = this.game.x(sampledShore) + offset.dx;
          const y = this.game.y(sampledShore) + offset.dy;
          if (!this.game.isValidCoord(x, y)) continue;
          const record = this.nearbyBoatTargetRecord(
            this.game.ref(x, y),
            offset.dx,
            offset.dy,
            context,
          );
          if (record) this.insertNearbyBoatTarget(context, record);
        }
        offsetsSinceYield++;
        if (this.shouldYieldNearbyBoatScan(offsetsSinceYield, offsetIndex, offsets.length)) {
          offsetsSinceYield = 0;
          await yieldEarlyGameTopologyWork();
        }
      }
      return {
        targets: context.targets,
        scanCandidates: context.scanCandidates,
      };
    }

    boatPlayerCandidate(player, context) {
      if (!this.boatPlayerIsEligible(player, context)) return null;
      const location = player.nameLocation?.();
      if (!location || location.x == null) return null;
      if (!this.game.isValidCoord(location.x, location.y)) return null;
      const tile = this.game.ref(location.x, location.y);
      if (tile == null) return null;
      let distance = 0;
      if (context.myCenter?.x != null) {
        const dx = location.x - context.myCenter.x;
        const dy = location.y - context.myCenter.y;
        distance = dx * dx + dy * dy;
      }
      return { tile, dist: distance };
    }

    boatPlayerIsEligible(player, context) {
      if (!player?.isPlayer?.() || !player.isAlive?.()) return false;
      if (player.smallID() === context.mySid) return false;
      if (context.disconnectedOnly) return player.isDisconnected?.() === true;
      return this.player.isFriendly(player) !== true;
    }

    boatPlayerCandidates(disconnectedOnly) {
      const context = {
        disconnectedOnly,
        mySid: this.player.smallID(),
        myCenter: this.getPlayerCenter(this.player),
      };
      const candidates = [];
      for (const player of this.game.players()) {
        {
          const candidate = this.boatPlayerCandidate(player, context);
          if (candidate) candidates.push(candidate);
        }
      }
      return candidates.sort((left, right) => left.dist - right.dist);
    }

    // findDisconnectedBoatTarget — like findDistantBoatTarget but ONLY disconnected
    // players (allies or enemies showing the "zzz" icon), nearest first. Their land is
    // undefended, so this can take over a disconnected teammate's territory, but only
    // after the transport pathfinder proves the route is inside the exploration cap.
    async findDisconnectedBoatTarget(probeLimit = null) {
      if (this.player === null) return null;
      const cands = this.boatPlayerCandidates(true);
      const configuredCap = state.settings.distantBoatProbeMax || 12;
      const cap = probeLimit === null ? configuredCap : Math.min(configuredCap, probeLimit);
      for (let i = 0; i < cands.length && i < cap; i++) {
        if (this.boatTargetTaken(cands[i].tile)) continue; // a boat already heads here
        const sp = await withTimeout(
          this.player.bestTransportShipSpawn(cands[i].tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (
          sp !== false &&
          (await this.allowBoatExplorationRoute(cands[i].tile))
        ) {
          return cands[i].tile;
        }
      }
      return null;
    }

    hasPendingOutboundAttackForTarget(target) {
      if (target?.isPlayer?.() !== true) return false;
      const targetKey = this.getOutboundAttackTargetKey(target);
      if (targetKey == null) return false;
      return this.botAttackPendingIntentCommitments.some(
        (entry) =>
          entry?.targetIsPlayer === true && entry.targetKey === targetKey,
      );
    }

    // findDistantBoatTarget — probe alive non-friendly enemy territory (a tile at their
    // name location ≈ centroid), nearest first, and return the first one whose actual
    // transport route is within the two-minute exploration cap. A reachable but long
    // voyage is not a valid fallback.
    async findDistantBoatTarget(profile = null, probeLimit = null) {
      if (this.player === null) return null;
      const cands = this.boatPlayerCandidates(false);
      const configuredCap = state.settings.distantBoatProbeMax || 12;
      const cap = probeLimit === null ? configuredCap : Math.min(configuredCap, probeLimit);
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
        const sp = await profileAttackAsync(
          profile,
          "boat-distant-spawn-probe",
          () =>
            withTimeout(
              this.player.bestTransportShipSpawn(cands[i].tile),
              WORKER_TIMEOUT_MS,
              TIMEOUT,
            ),
        );
        if (sp === TIMEOUT) {
          timedOut++;
          continue;
        }
        if (
          sp !== false &&
          (await profileAttackAsync(profile, "boat-distant-route-gate", () =>
            this.allowBoatExplorationRoute(cands[i].tile)))
        ) {
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

    boatDestinationsOverlap(first, second) {
      if (first === second) return true;
      if (
        first == null ||
        second == null ||
        typeof this.game.x !== "function" ||
        typeof this.game.y !== "function"
      ) {
        return false;
      }
      const firstX = Number(this.game.x(first));
      const firstY = Number(this.game.y(first));
      const secondX = Number(this.game.x(second));
      const secondY = Number(this.game.y(second));
      if (![firstX, firstY, secondX, secondY].every(Number.isFinite)) {
        return false;
      }
      const radius = state.settings.boatSpreadRadius || 30;
      return Math.abs(firstX - secondX) + Math.abs(firstY - secondY) <= radius;
    }

    boatDestinationOverlapsEmissionThisTick(dst) {
      const tick = this.currentAttackDecisionTick();
      if (this.botBoatDestinationIntentTick !== tick) {
        this.botBoatDestinationIntentTick = tick;
        this.botBoatDestinationIntents = new Set();
      }
      for (const reserved of this.botBoatDestinationIntents) {
        if (this.boatDestinationsOverlap(reserved, dst)) return true;
      }
      return false;
    }

    recordBoatDestinationIntent(dst) {
      this.botBoatDestinationIntents.add(dst);
    }

    boatDestinationOverlapsPendingIntent(dst) {
      this.reconcileOutboundAttackIntentCommitments();
      return this.botAttackPendingIntentCommitments.some(
        (entry) =>
          entry?.attackType === "boat" &&
          this.boatDestinationsOverlap(entry.destination, dst),
      );
    }

    boatDestinationOverlapsLiveTransport(dst) {
      return this.getOutboundTransportSnapshot().some(
        (entry) => this.boatDestinationsOverlap(entry.targetTile, dst),
      );
    }

    boatDestinationReserved(dst) {
      return (
        this.boatDestinationOverlapsEmissionThisTick(dst) ||
        this.boatDestinationOverlapsPendingIntent(dst) ||
        this.boatDestinationOverlapsLiveTransport(dst)
      );
    }

    // emitBoat — fire a TransportShipExecution at dst carrying `troops`.
    emitBoat(dst, troops, label, reserveTarget = null) {
      // Final chokepoint for the "boat" feature toggle: never fire when off.
      if (!(state.settings.features && state.settings.features.boat)) {
        return false;
      }
      if (this.boatDestinationReserved(dst)) return false;
      const requestedTroops = Number(troops);
      if (!Number.isFinite(requestedTroops) || requestedTroops < 1) {
        return false;
      }
      // All attack types share the same hard reserve budget, including boats
      // whose caller may have calculated a larger surge from a stale snapshot.
      // A TerraNullius target has its own soft reserve ceiling; do not silently
      // replace it with the live production reserve at this final boundary.
      const targetReserve = reserveTarget
        ? this.getEarlyGameTargetReserveTroops(reserveTarget)
        : this.getEarlyGameLiveReserveTroops();
      const safeTroops = Math.min(
        requestedTroops,
        this.getEarlyGameSpendableTroops(targetReserve),
      );
      if (!Number.isFinite(safeTroops) || safeTroops < 1) {
        return false;
      }
      const ctors = discoverCtors(getEventBus());
      if (
        ctors.boat &&
        hasAttackIntentRateCapacity() &&
        emitIntent(ctors.boat, dst, safeTroops)
      ) {
        state.stats.attacks++;
        setLastAction(tr(label), "naval");
        let target;
        {
          target = this.game.owner?.(dst) || null;
        }
        this.recordOutboundAttackIntent(target, safeTroops, {
          attackType: "boat",
          destination: dst,
        });
        this.recordBoatDestinationIntent(dst);
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
    // a GATE only; the returned value is the original `randTile`. Exploratory callers
    // can additionally require the pathfinder ETA cap before accepting a candidate.
    randomBoatCandidateAt(x, y, context) {
      if (!this.game.isValidCoord(x, y)) return null;
      const tile = this.game.ref(x, y);
      if (!this.game.isLand(tile)) return null;
      const owner = this.game.owner(tile);
      if (!this.randomBoatOwnerIsEligible(owner, context)) return null;
      return { tile, owner };
    }

    randomBoatOwnerIsEligible(owner, context) {
      if (owner.isPlayer() && owner.smallID() === this.player.smallID()) return false;
      if (owner.isPlayer() && context.unreachablePlayers.has(owner.id())) return false;
      if (owner.isPlayer() && context.borderingIds.has(owner.smallID())) return false;
      if (this.isFFA() && owner.isPlayer() && owner.troops() > this.player.troops()) {
        return false;
      }
      const matches = context.highInterestOnly
        ? !owner.isPlayer() || owner.type() === PlayerType.Bot
        : !owner.isPlayer() || !owner.isFriendly(this.player);
      return matches;
    }

    collectRandomBoatCandidates(tile, borderingEnemies, highInterestOnly) {
      const x = this.game.x(tile);
      const y = this.game.y(tile);
      const context = {
        highInterestOnly,
        unreachablePlayers: new Set(),
        borderingIds: new Set(borderingEnemies.map((enemy) => enemy.smallID())),
      };
      const candidates = [];
      for (let iteration = 0; iteration < 500; iteration++) {
        const candidate = this.randomBoatCandidateAt(
          this.random.nextInt(x - 150, x + 150),
          this.random.nextInt(y - 150, y + 150),
          context,
        );
        if (candidate) candidates.push(candidate);
        if (candidates.length >= BOAT_PROBE_CANDIDATES) break;
      }
      return { candidates, unreachablePlayers: context.unreachablePlayers };
    }

    async probeRandomBoatCandidates(
      candidates,
      unreachablePlayers,
      requireRoute,
      options = {},
    ) {
      const maxProbes = Math.max(
        1,
        Math.min(
          candidates.length,
          Number.isInteger(options.maxProbes)
            ? options.maxProbes
            : candidates.length,
        ),
      );
      const timeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.max(1, options.timeoutMs)
        : WORKER_TIMEOUT_MS;
      for (const candidate of candidates.slice(0, maxProbes)) {
        if (candidate.owner.isPlayer() && unreachablePlayers.has(candidate.owner.id())) {
          continue;
        }
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(candidate.tile),
          timeoutMs,
          false,
        );
        if (spawn === false) {
          if (candidate.owner.isPlayer()) unreachablePlayers.add(candidate.owner.id());
          continue;
        }
        if (requireRoute && !(await this.allowBoatExplorationRoute(candidate.tile))) {
          continue;
        }
        return candidate.tile;
      }
      return null;
    }

    async findRandomBoatTarget(
      tile,
      borderingEnemies,
      highInterestOnly = false,
      requireExplorationRoute = false,
      probeOptions = {},
    ) {
      if (this.player === null) throw new Error("not initialized");
      const { candidates, unreachablePlayers } = this.collectRandomBoatCandidates(
        tile,
        borderingEnemies,
        highInterestOnly,
      );
      return this.probeRandomBoatCandidates(
        candidates,
        unreachablePlayers,
        requireExplorationRoute,
        probeOptions,
      );
    }

    // attackBestTarget is called with borderingFriends sorted by troops and
    // borderingEnemies sorted by Defense Post-aware attack difficulty.
    async attackBestTarget(borderingFriends, borderingEnemies, nearby = null) {
      // The ratio checks below are useful descriptive strategy values, but they
      // are not a safe spending limit. maxTroops can jump when the bot builds
      // cities/factories, leaving a large absolute army below both ratios and
      // causing the whole strategy pipeline to sit idle. Every actual outbound
      // action is clamped by getEarlyGameSpendableTroops(), which already
      // subtracts the acceleration reserve and pending intents.
      if (this.getEarlyGameSpendableTroops() < 1) return;

      // Keep the expensive far-island/strategy scan cadence-limited when there
      // is no visible local target. A bordering target or teammate is already
      // an actionable opportunity and must bypass the old ratio gates.
      if (
        borderingFriends.length === 0 &&
        borderingEnemies.length === 0 &&
        !this.hasNeedyTeamDonationTarget() &&
        !this.hasTriggerRatioTroops()
      ) {
        return;
      }

      // In games with high starting gold, nations will quickly build a lot of cities
      // This causes them to expand slowly (cities increase max troops), and bots will steal their structures
      // In this case: Attack bots before the ordinary strategy pipeline.
      if (this.hasNeighboringBotWithStructures(nearby)) {
        if (await this.attackBots(nearby)) return;
      }

      // Get attack strategies in priority order based on difficulty
      const strategies = this.getAttackStrategies(
        borderingFriends,
        borderingEnemies,
        nearby,
      );

      for (const strategy of strategies) {
        if (await strategy()) return;
      }
    }

    hasNeedyTeamDonationTarget() {
      if (
        !state.settings.features.donate ||
        !state.settings.winFixes ||
        this.game.config().gameConfig().gameMode !== GameMode.Team ||
        this.game.config().donateTroops() === false
      ) {
        return false;
      }

      const needThreshold = state.settings.donateNeedThreshold ?? 0.8;
      return this.game.players().some((teammate) => {
        if (
          !this.player.isOnSameTeam(teammate) ||
          !teammate.isAlive() ||
          teammate.smallID() === this.player.smallID()
        ) {
          return false;
        }
        const maximum = this.game.config().maxTroops(teammate);
        return teammate.troops() / Math.max(maximum, 1) < needThreshold;
      });
    }

    // getAttackStrategies — AiAttackBehavior (private). The strategy predicates
    // become async (they reach sendAttack → the async boat probes). The four
    // difficulty-ordered arrays are VERBATIM from src.
    getAttackStrategies(borderingFriends, borderingEnemies, nearby = null) {
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

      const bots = async () => await this.attackBots(nearby);

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
          return await this.sendAttack(
            this.game.terraNullius(),
            false,
            null,
            null,
            true,
          );
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
        // Walk the ranked *confirmed land-border* list. A rejected first target
        // (stale pending state, Defense Post safety, or FFA strength) must not
        // hide another hostile border that is immediately actionable.
        for (const enemy of borderingEnemies) {
          if (this.isFFA() && enemy.troops() >= this.player.troops()) continue;
          if (await this.sendAttack(enemy)) return true;
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

      return order;
    }

    // hasNeighboringBotWithStructures — AiAttackBehavior (private).
    hasNeighboringBotWithStructures(nearby = null) {
      return (nearby || this.player.nearby())
        .some(
          (n) =>
            n.isPlayer() &&
            n.type() === PlayerType.Bot &&
            !this.player.isFriendly(n) &&
            n.units(...AttackStructureTypes).some((u) => AttackStructures.has(u.type())),
        );
    }

    // hasReserveRatioTroops — AiAttackBehavior (private).
    hasReserveRatioTroops() {
      const maxTroops = this.game.config().maxTroops(this.player);
      const ratio = this.player.troops() / maxTroops;
      return ratio >= this.effectiveReserveRatio();
    }

    // WIN-FIX (sizeReserve) — NOT in src. A size-aware reserve FLOOR: as the
    // empire grows, hold back more troops to keep the long borders defensible.
    // This breaks the over-expand → thin-border → get-pushed-back oscillation
    // that caps the pure faithful bot at ~16% (keeps fill high so conquests
    // stick). Gated by settings.winFixes (off → exactly this.reserveRatio = src).
    effectiveReserveRatio() {
      let r = this.reserveRatio;
      {
        if (state.settings.winFixes) {
          const total = this.game.numLandTiles() || 1;
          const share = this.player.numTilesOwned() / total;
          const scale = state.settings.sizeReserveScale ?? 0;
          const cap = state.settings.sizeReserveCap ?? 0.6;
          r = Math.max(r, Math.min(cap, share * scale));
        }
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
    incomingHostileAttacks() {
      if (
        this.player === null ||
        this.player === undefined ||
        typeof this.player.incomingAttacks !== "function" ||
        typeof this.player.isFriendly !== "function"
      ) {
        return [];
      }
      return this.player
        .incomingAttacks()
        .filter((attack) => !this.player.isFriendly(attack.attacker()));
    }

    // Aggregate pressure is deliberately separate from the single strongest
    // attacker used as the counterattack target. Structure policy must see a
    // coordinated attack from several Nations as one siege, rather than wait
    // for any one of them to cross an arbitrary per-attacker threshold.
    incomingHostileAttackPressure() {
      if (this.player === null || this.player === undefined) return 0;
      const ownTroops = Math.max(0, Number(this.player.troops?.()) || 0);
      const incomingTroops = this.incomingHostileAttacks().reduce(
        (total, attack) => total + Math.max(0, Number(attack.troops?.()) || 0),
        0,
      );
      if (incomingTroops === 0 || ownTroops <= 0) return 0;
      return incomingTroops / ownTroops;
    }

    hasOverwhelmingIncomingAttack() {
      return (
        this.incomingHostileAttackPressure() >=
        OVERWHELMING_INCOMING_ATTACK_RATIO
      );
    }

    findIncomingAttackPlayer() {
      let incomingAttacks = this.incomingHostileAttacks();
      // Faithful mode keeps the upstream Nation/Human policy. Win-fix mode must
      // also defend against tribes because their attacks consume the same land
      // and troops as attacks from Nations and Humans.
      if (!state.settings.winFixes && this.player.type() !== PlayerType.Bot) {
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

    // A detected threat owns the attack decision even when the defensive
    // intent cannot be emitted yet. This prevents another expansion from
    // spending the troops that the next defensive attempt needs.
    async respondToIncomingAttack() {
      const attacker = this.findIncomingAttackPlayer();
      if (attacker === null) return null;
      if (this.hasOverwhelmingIncomingAttack()) {
        state.earlyGame.action = "defense-hold";
        return false;
      }
      const emitted = await this.sendAttack(attacker, true);
      state.earlyGame.action = emitted ? "retaliate" : "defense-hold";
      return emitted;
    }

    // Sort neighboring bots by density (troops / tiles) and attack several of
    // them when the configured parallelism allows it. Pending intents already
    // consume the shared troop budget, so each new target gets the remainder.
    // Bots that own structures are prioritized as targets (they might have stolen our structures and they will delete them!).
    // attackBots — AiAttackBehavior (private, now async).
    async attackBots(nearby = null) {
      const botsByKey = new Map();
      for (const candidate of [
        ...(nearby || this.player.nearby()),
        ...this.getActiveOutboundTribeTargets(),
      ]) {
        if (
          candidate.isPlayer() &&
          this.player.isFriendly(candidate) === false &&
          candidate.type() === PlayerType.Bot
        ) {
          botsByKey.set(this.getOutboundAttackTargetKey(candidate), candidate);
        }
      }
      let bots = [...botsByKey.values()];

      const preferredClusterTargets =
        this.earlyGamePreferredClusterTargetKeys;
      if (preferredClusterTargets?.size > 0) {
        bots = bots.filter((bot) =>
          preferredClusterTargets.has(this.getOutboundAttackTargetKey(bot)),
        );
      }

      if (bots.length === 0) {
        return false;
      }

      this.botAttackTroopsSent = 0;

      const density = (p) => p.troops() / p.numTilesOwned();
      const ownsStructures = (p) =>
        p.units(...AttackStructureTypes).some((u) => AttackStructures.has(u.type()));
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
      const reducedBots = sortedBots
        .filter((bot) => this.tribeTargetNeedsMoreTroops(bot))
        .slice(0, this.getBotAttackMaxParallelism());

      let launchedAttacks = 0;
      for (const bot of reducedBots) {
        if (!hasAttackIntentRateCapacity()) break;
        if (await this.sendAttack(bot, false, null, null, false, true)) {
          launchedAttacks++;
        }
      }

      return launchedAttacks > 0;
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
    async assistAllyTarget(ally, target) {
      if (target.isPlayer() && target.smallID() === this.player.smallID()) {
        this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_TARGET_ME);
        return false;
      }
      if (this.player.isFriendly(target)) {
        this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_TARGET_ALLY);
        return false;
      }
      if (!(await this.sendAttack(target))) return false;
      this.player.updateRelation(ally, -20);
      this.emojiBehavior.sendEmoji(ally, EMOJI_ASSIST_ACCEPT);
      return true;
    }

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
          if (await this.assistAllyTarget(ally, target)) return true;
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
            // Breaking an alliance is authoritative only on a later game turn.
            // An immediate same-tick attack is rejected while the target is
            // still friendly. Consume this decision and let the next attack
            // cycle see the former ally in borderingEnemies before conquering.
            return true;
          }
        }
      }
      return false;
    }

    // isBorderingNukedTerritory — AiAttackBehavior (private).
    isBorderingNukedTerritory() {
      for (const tile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(tile)) {
          if (
            this.isAttackableTerraNulliusTile(neighbor) &&
            this.game.hasFallout(neighbor)
          ) {
            return true;
          }
        }
      }
      return false;
    }

    getRadioactiveTerraNulliusFalloutDefenseMultiplier() {
      let falloutRatio = 0;
      {
        const landTiles = Number(this.game.numLandTiles?.() || 0);
        const falloutTiles = Number(this.game.numTilesWithFallout?.() || 0);
        if (Number.isFinite(landTiles) && landTiles > 0) {
          falloutRatio = Math.min(
            1,
            Math.max(
              0,
              (Number.isFinite(falloutTiles) ? falloutTiles : 0) / landTiles,
            ),
          );
        }
      }
      return Math.max(
        1,
        ATTACK_FALLOUT_DEFENSE_BASE -
          ATTACK_FALLOUT_DEFENSE_RATIO_SLOPE * falloutRatio,
      );
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
      const myShores = this.getEarlyGameOwnShores();
      if (myShores.length === 0) return null;

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
      const border = typeof player.borderTiles === "function" ? player.borderTiles() : null;
      if (border && border.size > 0) {
        return calculateBoundingBoxCenter(this.game, border);
      }
      // Border not snapshotted (other player, sort phase) → nameLocation proxy.
      return typeof player.nameLocation === "function" ? player.nameLocation() : null;
    }

    // attackRandomTarget — AiAttackBehavior (now async via sendAttack). Not invoked
    // by maybeAttack, but ported for true 1:1 (some callers/tests use it).
    async attackRandomNeighbor() {
      const neighbors = this.random.shuffleArray(this.player.nearby());
      for (const neighbor of neighbors) {
        if (!neighbor.isPlayer() || this.player.isFriendly(neighbor)) continue;
        const isNationOrHuman =
          neighbor.type() === PlayerType.Nation ||
          neighbor.type() === PlayerType.Human;
        if (isNationOrHuman && this.random.chance(2)) continue;
        if (await this.sendAttack(neighbor)) return true;
      }
      return false;
    }

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
      if (
        toAttack !== null &&
        this.random.chance(3) &&
        (await this.sendAttack(toAttack))
      ) {
        return;
      }
      await this.attackRandomNeighbor();
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
    // awaits it. No worker calls — a land/TN attack at half troops).
    async forceSendAttack(target, fraction = 0.5) {
      // src: game.addExecution(new AttackExecution(troops/2, player,
      //   target.isPlayer() ? target.id() : terraNullius().id())).
      // Client: emitIntent(ctors.attack, target.id()|null, troops). In win-fix
      // mode a TerraNullius opening uses the calculated one-tile loss plus a
      // margin, while the configured opening fraction remains only a ceiling.
      this.reconcileOutboundAttackIntentCommitments();
      const ctors = discoverCtors(getEventBus());
      const isTerraNullius = target?.isPlayer?.() !== true;
      if (!this.canForceAttackTarget(target)) return false;
      const requestedTroops = this.player.troops() * Number(fraction);
      const reserveTroops =
        isTerraNullius && state.settings.winFixes
          ? this.getEarlyGameTerraNulliusReserveTroops()
          : this.getEarlyGameTargetReserveTroops(target);
      const spendableTroops = this.getEarlyGameSpendableTroops(reserveTroops);
      const troops =
        isTerraNullius && state.settings.winFixes
          ? this.getTerraNulliusAttackTroops(
              target,
              null,
              null,
              EARLY_EXPAND_COMMIT,
            )
          : Math.min(requestedTroops, spendableTroops);
      if (!Number.isFinite(troops) || troops < 1) return false;
      const targetId = target.isPlayer() ? target.id() : null;
      if (
        ctors.attack &&
        hasAttackIntentRateCapacity() &&
        emitIntent(ctors.attack, targetId, troops)
      ) {
        state.stats.attacks++;
        setLastAction(tr("⚔️ Attack"), "combat");
        this.recordOutboundAttackIntent(target, troops, { attackType: "land" });
        return true;
      }
      return false;
    }

    canForceAttackTarget(target) {
      return target?.isPlayer?.() === true || this.hasLandBorderWithTerraNullius();
    }

    // sendAttack — AiAttackBehavior (now async via sendBoatAttack/
    // sendBoatAttackToNearbyTerraNullius; sendLandAttack stays sync).
    normalizeSendAttackArgs(args) {
      const [
        target,
        force = false,
        minCommitFraction = null,
        earlyGameCandidate = null,
        radioactiveTerraNullius = false,
        parallelTribeAttack = false,
      ] = args;
      return {
        target,
        force,
        minCommitFraction,
        earlyGameCandidate,
        radioactiveTerraNullius,
        parallelTribeAttack,
      };
    }

    sendAttackIsPendingDuplicate(target, force, isParallelTribeAttack) {
      return Boolean(
        state.settings.winFixes &&
          !force &&
          !isParallelTribeAttack &&
          this.hasPendingOutboundAttackForTarget(target),
      );
    }

    async sendAttackAgainstPlayer(options) {
      const { target, minCommitFraction, earlyGameCandidate } = options;
      if (!this.player.sharesBorderWith(target)) {
        return this.sendBoatAttack(target, earlyGameCandidate);
      }
      return this.sendLandAttack(
        target,
        minCommitFraction,
        earlyGameCandidate,
        options.radioactiveTerraNullius,
        options.isParallelTribeAttack,
      );
    }

    async sendAttackAgainstTerraNullius(options) {
      if (!this.hasLandBorderWithTerraNullius()) {
        return this.sendBoatAttackToNearbyTerraNullius(
          options.radioactiveTerraNullius,
        );
      }
      return this.sendLandAttack(
        options.target,
        options.minCommitFraction,
        null,
        options.radioactiveTerraNullius,
      );
    }

    // sendAttack — AiAttackBehavior (now async via sendBoatAttack/
    // sendBoatAttackToNearbyTerraNullius; sendLandAttack stays sync).
    async sendAttack(...args) {
      const options = this.normalizeSendAttackArgs(args);
      const { target, force } = options;
      if (!force && !this.shouldAttack(target)) return false;
      options.isParallelTribeAttack =
        options.parallelTribeAttack === true &&
        target?.isPlayer?.() === true &&
        target.type?.() === PlayerType.Bot;
      if (this.sendAttackIsPendingDuplicate(target, force, options.isParallelTribeAttack)) {
        return false;
      }
      return target.isPlayer()
        ? this.sendAttackAgainstPlayer(options)
        : this.sendAttackAgainstTerraNullius(options);
    }

    // hasLandBorderWithTerraNullius — AiAttackBehavior (private).
    hasLandBorderWithTerraNullius() {
      return this.getTerraNulliusFrontierSnapshot().attackableFrontier.length > 0;
    }

    // Keep the client-side Terra Nullius gate identical to AttackExecution:
    // impassable land looks like free territory in a simple ownership scan, but
    // the engine skips it and immediately retires the generic TN attack.
    isAttackableTerraNulliusTile(tile) {
      return (
        this.game.isLand(tile) &&
        !this.game.hasOwner(tile) &&
        this.game.isImpassable?.(tile) !== true
      );
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
    canSendNearbyTerraNulliusBoat() {
      if (!(state.settings.features && state.settings.features.boat)) return false;
      if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return false;
      return (
        this.player.unitCount(UNIT.TransportShip) <
        this.game.config().boatMaxNumber()
      );
    }

    nearbyTerraNulliusBoatTile(border, direction, radioactive) {
      const [dx, dy] = direction;
      const bx = this.game.x(border);
      const by = this.game.y(border);
      const adjacentX = bx + dx;
      const adjacentY = by + dy;
      if (!this.game.isValidCoord(adjacentX, adjacentY)) return null;
      if (!this.game.isWater(this.game.ref(adjacentX, adjacentY))) return null;
      const x = bx + dx * 5;
      const y = by + dy * 5;
      if (!this.game.isValidCoord(x, y)) return null;
      const tile = this.game.ref(x, y);
      if (!this.game.isLand(tile) || this.game.hasOwner(tile)) return null;
      if (radioactive && !this.game.hasFallout?.(tile)) return null;
      if (!state.settings.winFixes && this.game.hasFallout(tile)) return null;
      return tile;
    }

    nearbyTerraNulliusBoatCandidates(radioactive) {
      const directions = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ];
      const shores = Array.from(this.player.borderTiles()).filter((tile) =>
        this.game.isShore(tile),
      );
      const candidates = [];
      for (let index = 0; index < shores.length; index += 10) {
        for (const direction of directions) {
          const tile = this.nearbyTerraNulliusBoatTile(
            shores[index],
            direction,
            radioactive,
          );
          if (tile != null) candidates.push(tile);
          if (candidates.length >= BOAT_PROBE_CANDIDATES) return candidates;
        }
      }
      return candidates;
    }

    nearbyTerraNulliusBoatTroops(radioactive = false) {
      if (!state.settings.winFixes) return this.player.troops() / 5;
      return this.getEarlyGameProbeTroops(
        state.settings.boatProbeFrac,
        radioactive
          ? this.getRadioactiveTerraNulliusReserveTroops()
          : this.getEarlyGameTerraNulliusReserveTroops(),
      );
    }

    emitNearbyTerraNulliusBoat(tile, troops, radioactive) {
      const emitted = this.emitBoat(
        tile,
        troops,
        radioactive ? "☢️ Nuked-coast grab" : "⛵ TerraNullius probe",
        this.game.terraNullius(),
      );
      if (emitted && state.settings.winFixes) {
        state.beachhead = {
          tile,
          at: this.game.ticks(),
          surged: false,
        };
      }
      return emitted;
    }

    async sendBoatAttackToNearbyTerraNullius(radioactiveTerraNullius = false) {
      if (!this.canSendNearbyTerraNulliusBoat()) return false;
      const candidates = this.nearbyTerraNulliusBoatCandidates(
        radioactiveTerraNullius,
      );
      for (const tile of candidates) {
        const spawn = await withTimeout(
          this.player.bestTransportShipSpawn(tile),
          WORKER_TIMEOUT_MS,
          false,
        );
        if (spawn === false || !(await this.allowEarlyGameBoat(tile))) continue;
        const troops = this.nearbyTerraNulliusBoatTroops(
          radioactiveTerraNullius,
        );
        if (troops < 1) return false;
        return this.emitNearbyTerraNulliusBoat(
          tile,
          troops,
          radioactiveTerraNullius,
        );
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
    createLandAttackContext(
      target,
      minCommitFraction,
      earlyGameCandidate,
      radioactiveTerraNullius,
      parallelTribeAttack,
    ) {
      const defenseProfile = this.getEnemyDefensePostAttackProfile(target);
      const isTribeTarget =
        target.isPlayer() && target.type() === PlayerType.Bot;
      const botWithStructures =
        isTribeTarget &&
        target.units(...AttackStructureTypes).some((unit) =>
          AttackStructures.has(unit.type()),
        );
      const useReserve = target.isPlayer() && !botWithStructures;
      const reserveRatio = useReserve
        ? this.effectiveReserveRatio()
        : this.expandRatio;
      const isTerraNullius = !target.isPlayer();
      const targetReserveTroops = this.getLandAttackTargetReserveTroops(
        target,
        radioactiveTerraNullius,
      );
      const targetTroops = state.settings.winFixes
        ? targetReserveTroops
        : this.game.config().maxTroops(this.player) * reserveRatio;
      const targetSpendableTroops =
        this.getEarlyGameSpendableTroops(targetReserveTroops);
      const finalSpendableTroops =
        isTerraNullius && state.settings.winFixes && !radioactiveTerraNullius
          ? Math.max(
              targetSpendableTroops,
              this.getEarlyGameSpendableTroops(
                this.getTerraNulliusLivenessReserveTroops(),
              ),
            )
          : targetSpendableTroops;
      let terraNulliusCommitFraction = null;
      if (isTerraNullius && state.settings.winFixes) {
        const requested =
          minCommitFraction === null ? Number.NaN : Number(minCommitFraction);
        terraNulliusCommitFraction = Number.isFinite(requested)
          ? requested
          : EARLY_EXPAND_COMMIT;
      }
      return {
        target,
        earlyGameCandidate,
        defenseProfile,
        isTribeTarget,
        isTerraNullius,
        radioactiveTerraNullius,
        usesPendingIntentBudget:
          parallelTribeAttack === true && isTribeTarget,
        targetTroops,
        targetSpendableTroops,
        finalSpendableTroops,
        terraNulliusCommitFraction,
        botAttackTroopsSentBefore: this.botAttackTroopsSent,
        requiredTribeAttackTroops: null,
        attackBlocked: false,
      };
    }

    calculateTribeLandAttackTroops(context) {
      const localSent = context.usesPendingIntentBudget
        ? 0
        : this.botAttackTroopsSent;
      const available = Math.max(
        0,
        context.targetSpendableTroops - localSent,
      );
      const troops = this.calculateBotAttackTroops(
        context.target,
        available,
        context.defenseProfile,
        context.earlyGameCandidate?.existingCommittedTroops,
      );
      context.requiredTribeAttackTroops = troops;
      return troops;
    }

    calculateRegularLandAttackTroops(context) {
      if (context.isTerraNullius && state.settings.winFixes) {
        return this.getTerraNulliusAttackTroops(
          context.target,
          null,
          context.radioactiveTerraNullius
            ? context.finalSpendableTroops
            : null,
          context.terraNulliusCommitFraction,
          context.radioactiveTerraNullius,
        );
      }
      let troops = this.player.troops() - context.targetTroops;
      const existing = context.target.isPlayer()
        ? this.getLiveOutboundAttackTroopsForTarget(context.target)
        : 0;
      if (existing <= 0) return troops;
      const defenseMultiplier = Math.max(
        1,
        Number(context.defenseProfile?.attackCostMultiplier || 1),
      );
      const minimum =
        Math.max(0, Number(context.target.troops?.()) || 0) *
        2 *
        defenseMultiplier;
      const preferred = minimum * 2;
      if (existing + context.targetSpendableTroops < minimum) {
        context.attackBlocked = true;
        return 0;
      }
      troops = Math.min(
        context.targetSpendableTroops,
        Math.max(0, preferred - existing),
      );
      return troops;
    }

    calculateLandAttackTroops(context) {
      // Target type, not our own controller type, defines the conquest policy.
      // The client exposes auto-controlled Nations as Bot in some modes; letting
      // that representation fall through to the generic retaliation formula
      // emits partial attacks against tribes and strands the expansion.
      if (context.isTribeTarget) {
        return this.calculateTribeLandAttackTroops(context);
      }
      return this.calculateRegularLandAttackTroops(context);
    }

    restoreLandAttackReservation(context) {
      if (context.requiredTribeAttackTroops !== null) {
        this.botAttackTroopsSent = context.botAttackTroopsSentBefore;
      }
    }

    adjustLandAttackTroops(context, troops) {
      // Tribe payloads are already the exact Defense Post-aware capture floor.
      // Do not inflate them afterward and consume another target's budget.
      if (context.requiredTribeAttackTroops !== null) return troops;
      const baseTroops = troops;
      const adjusted = this.applyEarlyGameRaceTroops({
        target: context.target,
        baseTroops,
        reserveTroops:
          context.targetTroops +
          (context.usesPendingIntentBudget
            ? 0
            : context.botAttackTroopsSentBefore),
        earlyGameCandidate: context.earlyGameCandidate,
      });
      if (adjusted > baseTroops && context.target.type?.() === PlayerType.Bot) {
        this.botAttackTroopsSent += adjusted - baseTroops;
      }
      return Math.min(adjusted, context.finalSpendableTroops);
    }

    landAttackTroopsAreSafe(context, troops) {
      if (
        context.requiredTribeAttackTroops !== null &&
        troops < context.requiredTribeAttackTroops
      ) {
        return false;
      }
      if (
        context.target.isPlayer() &&
        this.attackIsTooWeakForDefensePosts(
          context.target,
          troops,
          context.defenseProfile,
        )
      ) {
        return false;
      }
      return troops >= 1;
    }

    emitLandAttackIntent(context, troops) {
      if (
        context.target.isPlayer() &&
        this.player.type() === PlayerType.Nation
      ) {
        if (this.emojiBehavior === undefined) throw new Error("not initialized");
        this.emojiBehavior.maybeSendAttackEmoji(context.target);
      }
      const ctors = discoverCtors(getEventBus());
      const targetId = context.target.isPlayer() ? context.target.id() : null;
      if (
        !ctors.attack ||
        !hasAttackIntentRateCapacity() ||
        !emitIntent(ctors.attack, targetId, troops)
      ) {
        return false;
      }
      state.stats.attacks++;
      setLastAction(tr("⚔️ Attack"), "combat");
      this.recordOutboundAttackIntent(context.target, troops, {
        attackType: "land",
      });
      return true;
    }

    sendLandAttack(
      target,
      minCommitFraction = null,
      earlyGameCandidate = null,
      radioactiveTerraNullius = false,
      parallelTribeAttack = false,
    ) {
      this.reconcileOutboundAttackIntentCommitments();
      const context = this.createLandAttackContext(
        target,
        minCommitFraction,
        earlyGameCandidate,
        radioactiveTerraNullius,
        parallelTribeAttack,
      );
      let troops = this.calculateLandAttackTroops(context);
      if (
        context.attackBlocked ||
        (context.requiredTribeAttackTroops !== null && troops < 1)
      ) {
        this.restoreLandAttackReservation(context);
        return false;
      }
      troops = this.adjustLandAttackTroops(context, troops);
      if (!this.landAttackTroopsAreSafe(context, troops)) {
        this.restoreLandAttackReservation(context);
        return false;
      }
      const emitted = this.emitLandAttackIntent(context, troops);
      if (!emitted) this.restoreLandAttackReservation(context);
      return emitted;
    }

    // sendBoatAttack — AiAttackBehavior (private, now async).
    //
    // DIVERGENCE (boat probe): src computes closestTwoTiles between OUR shore tiles
    // and the TARGET's shore tiles, then `canBuildTransportShip(closest.y)` as a
    // gate and sends to `closest.y`. The client needs the target's borderTiles (an
    // async fetch) before reading them synchronously, and the canBuild check is the
    // async bestTransportShipSpawn probe. We `await game.ensureBorderTiles(target)`
    // first (cached per tick), then probe; the dst sent is still `closest.y`.
    boatAttackTroops(target, earlyGameCandidate) {
      if (state.settings.winFixes && earlyGameCandidate) {
        return this.calculateBotAttackTroops(
          target,
          this.getEarlyGameSpendableTroops(
            this.getEarlyGameTargetReserveTroops(target),
          ),
          this.getEnemyDefensePostAttackProfile(target),
        );
      }
      if (state.settings.winFixes) {
        return this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
      }
      if (target.type() === PlayerType.Bot) {
        return this.calculateBotAttackTroops(target, this.player.troops() / 5);
      }
      return this.player.troops() / 5;
    }

    maybeSendBoatAttackEmoji(target) {
      if (!target.isPlayer() || this.player.type() !== PlayerType.Nation) return;
      if (this.emojiBehavior === undefined) throw new Error("not initialized");
      this.emojiBehavior.maybeSendAttackEmoji(target);
    }

    async sendBoatAttack(target, earlyGameCandidate = null) {
      this.reconcileOutboundAttackIntentCommitments();
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

      const destination =
        earlyGameCandidate?.boatTargetTile == null
          ? closest.y
          : earlyGameCandidate.boatTargetTile;
      const spawn = await withTimeout(
        this.player.bestTransportShipSpawn(destination),
        WORKER_TIMEOUT_MS,
        false,
      );
      if (spawn === false) {
        return false;
      }

      // USER (winFixes): EVERY boat is a cheap 1% probe — never a 20% dump (troops/5),
      // and not the bot-scaled calculateBotAttackTroops either. This means the bot now
      // HARASSES across water instead of conquering it by boat; land expansion and the
      // opportunistic 1% landings are unaffected. (winFixes off → exact faithful troops.)
      let troops = this.boatAttackTroops(target, earlyGameCandidate);

      // A race signal may increase a valid conquest force, but it must never
      // turn an unaffordable zero into a sub-minimum maritime attack.
      if (troops < 1) return false;
      troops = this.applyEarlyGameRaceTroops({
        target,
        baseTroops: troops,
        reserveTroops:
          this.game.config().maxTroops(this.player) *
          this.effectiveReserveRatio(),
        earlyGameCandidate,
      });

      // Race pressure may raise a probe after its initial budget calculation.
      // Reapply the target-specific reserve at the final emission boundary so a
      // human/nation boat cannot spend below the production peak and no boat can
      // bypass pending-intent accounting.
      const boatSpendableTroops = this.getEarlyGameSpendableTroops(
        this.getEarlyGameTargetReserveTroops(target),
      );
      troops = Math.min(troops, boatSpendableTroops);

      if (troops < 1) {
        return false;
      }

      // DIVERGENCE (inert branch — kept VERBATIM): emoji gated on player type Nation;
      // the bot is Human so this never fires. Condition kept exactly.
      this.maybeSendBoatAttackEmoji(target);

      // src: game.addExecution(new TransportShipExecution(player, closest.y, troops)).
      if (!(await this.allowEarlyGameBoat(destination))) return false;
      return this.emitBoat(destination, troops, "⛵ Boat attack", target);
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

    // calculateBotAttackTroops — AiAttackBehavior (private).
    calculateBotAttackTroops(
      target,
      maxTroops,
      defensePostProfile = null,
      existingCommittedTroops = 0,
    ) {
      const minimumAttackTroops = this.getTribeCaptureTroopFloor(
        target,
        defensePostProfile,
      );
      const liveCommitted = this.getLiveOutboundAttackTroopsForTarget(target);
      const pendingCommitted = this.getPendingOutboundAttackTroopsForTarget(target);
      const committed = Math.max(
        liveCommitted,
        Math.max(0, Number(existingCommittedTroops) || 0),
      ) + pendingCommitted;
      // Keep capture all-or-nothing: the target-specific floor includes the
      // tribe's lean opening margin or the higher Nation conquest margin.
      const requiredTroops = Math.max(
        0,
        Math.ceil(minimumAttackTroops - committed),
      );
      const availableTroops = Math.max(0, Math.floor(maxTroops));
      if (availableTroops < requiredTroops) return 0;
      const troops = Math.min(availableTroops, requiredTroops);
      this.botAttackTroopsSent += troops;
      return troops;
    }

    getTribeCaptureTroopFloor(target, defensePostProfile = null) {
      const defenseMultiplier = Math.max(
        1,
        Number(defensePostProfile?.attackCostMultiplier || 1),
      );
      const captureMultiplier =
        target?.type?.() === PlayerType.Bot
          ? TRIBE_CAPTURE_TROOP_MULTIPLIER
          : PLAYER_CAPTURE_TROOP_MULTIPLIER;
      // Attack intents are whole troops. Round the required conquest force up,
      // never down: a fractional tribe/Defense-Post result truncated by the
      // engine can leave a tribe alive by one troop and strand the opening expansion.
      return Math.ceil(
        Math.max(0, Number(target?.troops?.()) || 0) *
          captureMultiplier *
          defenseMultiplier,
      );
    }

    getPlayerAttackPreferredTroopFloor(target, defensePostProfile = null) {
      return this.getTribeCaptureTroopFloor(target, defensePostProfile);
    }

    tribeTargetNeedsMoreTroops(target) {
      const profile = this.getEnemyDefensePostAttackProfile(target);
      return (
        this.getCommittedOutboundAttackTroopsForTarget(target) <
        this.getTribeCaptureTroopFloor(target, profile)
      );
    }

    async reinforceIncompleteOutboundPlayerAttack() {
      for (const target of this.getActiveOutboundPlayerTargets()) {
        if (target.isAlive?.() === false) continue;
        if (this.player.isFriendly(target) === true) continue;
        if (this.player.sharesBorderWith(target) !== true) continue;
        const profile = this.getEnemyDefensePostAttackProfile(target);
        const committed = this.getCommittedOutboundAttackTroopsForTarget(target);
        if (
          committed >=
          this.getPlayerAttackPreferredTroopFloor(target, profile)
        ) {
          continue;
        }
        if (
          await this.sendAttack(
            target,
            false,
            null,
            null,
            false,
            target.type?.() === PlayerType.Bot,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    // donateTroops — AiAttackBehavior (private). No worker calls in src; the only
    // async-shaped read (canDonateTroops) is core-only — see DIVERGENCE below.
    // Kept sync (returns a plain boolean) — the strategy wrapper `donate` awaits it.
    logDonationDiagnostic() {
      {
        const now = performance.now();
        if (now - (state._donDiagAt || 0) <= 5000) return;
        state._donDiagAt = now;
        const config = this.game.config();
        const teammates = this.game.players().filter(
          (player) =>
            this.player.isOnSameTeam(player) &&
            player.smallID() !== this.player.smallID() &&
            player.isAlive(),
        );
        runtimeDebugLog(
          "[Donate] diag: " +
            JSON.stringify({
              featureOn: Boolean(state.settings.features.donate),
              winFixes: Boolean(state.settings.winFixes),
              replicatedDifficulty: String(currentDifficulty()),
              gameType: String(config.gameConfig().gameType),
              gameMode: String(config.gameConfig().gameMode),
              donateAllowedByLobby: config.donateTroops(),
              aliveTeammates: teammates.length,
              myTroops: Math.round(this.player.troops()),
            }),
        );
      }
    }

    donationHasIncomingAttack() {
      {
        if (typeof this.player?.incomingAttacks !== "function") return false;
        return this.player.incomingAttacks().length > 0;
      }
    }

    donationHasMaritimeInvasion() {
      {
        if (
          typeof window === "undefined" ||
          typeof window.__OFH_getIncomingMaritimeInvasion !== "function"
        ) {
          return false;
        }
        const invasion = window.__OFH_getIncomingMaritimeInvasion(
          this.game,
          this.player,
        );
        return !invasion || invasion.active === true;
      }
    }

    donationDifficultyAllows() {
      if (state.settings.winFixes) return true;
      switch (currentDifficulty()) {
        case Difficulty.Easy:
          return false;
        case Difficulty.Medium:
          return this.random.chance(4);
        case Difficulty.Hard:
          return this.random.chance(2);
        case Difficulty.Impossible:
        case Difficulty.Legendary:
          return true;
        default:
          throw new Error("unreachable difficulty: " + currentDifficulty());
      }
    }

    donationBaseGatesAllow() {
      if (!state.settings.features.donate) return false;
      if (this.donationHasIncomingAttack()) return false;
      if (this.donationHasMaritimeInvasion()) return false;
      const expansionStatus =
        typeof getAutoDonateExpansionStatus === "function"
          ? getAutoDonateExpansionStatus(state.earlyGame)
          : { active: false };
      if (
        state.settings.pauseDonateDuringExpansion === true &&
        expansionStatus.active === true
      ) {
        return false;
      }
      const config = this.game.config();
      if (config.gameConfig().gameMode !== GameMode.Team) return false;
      if (config.donateTroops() === false) return false;
      if (this.game.getWinner()) {
        runtimeDebugLog("[Donate] skip: game already has a winner");
        return false;
      }
      return this.donationDifficultyAllows();
    }

    donationTeammates() {
      return this.game
        .players()
        .filter((player) => this.player.isOnSameTeam(player))
        .filter((player) => {
          if (state.settings.winFixes) return true;
          return (
            player.incomingAttacks().length > 0 ||
            player.outgoingAttacks().length > 0
          );
        })
        .map((teammate) => {
          const maxTroops = this.game.config().maxTroops(teammate);
          return {
            teammate,
            troopPercentage: teammate.troops() / Math.max(maxTroops, 1),
          };
        })
        .sort((left, right) => left.troopPercentage - right.troopPercentage);
    }

    donationCandidate(entry, needThreshold) {
      const teammate = entry.teammate;
      if (!teammate.isAlive()) return null;
      if (teammate.smallID() === this.player.smallID()) return null;
      if (entry.troopPercentage >= needThreshold) return null;
      if (this.player.canDonateTroops?.(teammate) === false) return null;
      const recipientKey = this.donationRecipientId(teammate);
      const nextEligibleTick =
        this.botDonationNextEligibleTickByRecipient.get(recipientKey) ?? 0;
      if (this.currentAttackDecisionTick() < nextEligibleTick) return null;
      const underAttack = teammate.incomingAttacks().length > 0;
      const frontline = underAttack || teammate.outgoingAttacks().length > 0;
      return {
        entry,
        frontline,
        underAttack,
        distance: this.teamDonationDistance(teammate),
        sameClan:
          state.settings.winFixes &&
          playersShareClanTag(this.player, teammate),
        troopPercentage: entry.troopPercentage,
      };
    }

    selectDonationTeammate(teammates) {
      const needThreshold = state.settings.winFixes
        ? state.settings.donateNeedThreshold ?? 0.8
        : 1;
      const needy = teammates
        .map((entry) => this.donationCandidate(entry, needThreshold))
        .filter(Boolean);
      const ranked = rankTeamDonationCandidates(needy);
      if (ranked.length === 0) return null;
      const selected = ranked[0];
      let position = "(rear)";
      if (selected.frontline) position = "(FRONTLINE — in combat)";
      if (selected.underAttack) position = "(UNDER ATTACK)";
      runtimeDebugLog(
        "[Donate] picked ally at " +
          Math.round(selected.troopPercentage * 100) +
          "% " +
          (selected.sameClan ? "(same clan) " : "") +
          position,
      );
      return selected.entry.teammate;
    }

    donationAmount() {
      const strongest = this.getStrongestBorderOpponentTroops(true);
      if (strongest === null) {
        runtimeDebugLog("[Donate] skip: border reserve data unavailable");
        return null;
      }
      const maxTroops = this.game.config().maxTroops(this.player);
      const troopsToKeep = state.settings.winFixes
        ? this.getEarlyGameProductionReserveTroops()
        : maxTroops * this.reserveRatio;
      const currentTroops = Math.max(0, Number(this.player.troops()) || 0);
      const maxBorderDonation = Math.floor(currentTroops - strongest / 2);
      if (maxBorderDonation <= 0) {
        runtimeDebugLog("[Donate] skip: strongest border opponent leaves no safe reserve", {
          troops: Math.round(currentTroops),
          strongestBorderOpponent: Math.round(strongest),
        });
        return null;
      }
      const donationTroops = Math.min(
        Math.max(0, currentTroops - troopsToKeep),
        this.getEarlyGameSpendableTroops(troopsToKeep),
        maxBorderDonation,
      );
      const minExcess = state.settings.winFixes
        ? Math.max(
            maxTroops *
              Math.max(
                0.01,
                Number(state.settings.donateMinExcessFrac) || 0.01,
              ),
            this.player.troops() * 0.01,
          )
        : 1;
      if (donationTroops >= minExcess) return donationTroops;
      runtimeDebugLog("[Donate] skip: not enough above the keep line", {
        troops: Math.round(this.player.troops()),
        keep: Math.round(troopsToKeep),
        spendable: Math.round(donationTroops),
        needExcess: Math.round(minExcess),
      });
      return null;
    }

    donationRecipientId(teammate) {
      if (typeof teammate.id === "function") return teammate.id();
      if (typeof teammate.smallID === "function") return teammate.smallID();
      return null;
    }

    emitDonationTroops(teammate, troops) {
      const ctors = discoverCtors(getEventBus());
      let emitted = false;
      if (ctors.donateTroops) {
        emitted = emitIntent(
          ctors.donateTroops,
          teammate.__src ?? teammate,
          troops,
        );
      } else if (typeof sendGamePacket === "function") {
        const recipient = this.donationRecipientId(teammate);
        if (recipient != null) {
          emitted = sendGamePacket({
            type: "donate_troops",
            recipient,
            troops,
          });
        }
      }
      if (!emitted) {
        runtimeDebugLog("[Donate] emit failed", {
          ctor: Boolean(ctors.donateTroops),
          directFallback: typeof sendGamePacket === "function",
        });
        return false;
      }
      const cooldown = Number(this.game.config().donateCooldown?.()) || 0;
      const recipientKey = this.donationRecipientId(teammate);
      this.botDonationNextEligibleTickByRecipient.set(
        recipientKey,
        this.currentAttackDecisionTick() + Math.max(0, cooldown),
      );
      this.recordOutboundDonationIntent(troops);
      runtimeDebugLog(
        "[Donate] SENT",
        Math.round(troops),
        "→",
        teammate.name?.() ?? teammate.smallID?.(),
      );
      setLastAction(tr("🎁 Donate troops"), "combat");
      return true;
    }

    donateTroops() {
      this.logDonationDiagnostic();
      if (!this.donationBaseGatesAllow()) return false;
      const teammates = this.donationTeammates();
      if (teammates.length === 0) {
        runtimeDebugLog("[Donate] skip: no same-team players found");
        return false;
      }
      const selectedTeammate = this.selectDonationTeammate(teammates);
      if (selectedTeammate === null) {
        runtimeDebugLog(
          "[Donate] skip: no teammate below the need threshold (all allies healthy)",
        );
        return false;
      }
      const troops = this.donationAmount();
      if (troops === null) return false;
      return this.emitDonationTroops(selectedTeammate, troops);
    }

    teamDonationDistance(teammate) {
      {
        const ownCenter = this.getPlayerCenter(this.player);
        const teammateCenter = this.getPlayerCenter(teammate);
        if (
          !ownCenter ||
          !teammateCenter ||
          !Number.isFinite(Number(ownCenter.x)) ||
          !Number.isFinite(Number(ownCenter.y)) ||
          !Number.isFinite(Number(teammateCenter.x)) ||
          !Number.isFinite(Number(teammateCenter.y))
        ) {
          return Number.POSITIVE_INFINITY;
        }
        return (
          Math.abs(Number(ownCenter.x) - Number(teammateCenter.x)) +
          Math.abs(Number(ownCenter.y) - Number(teammateCenter.y))
        );
      }
    }
  }
