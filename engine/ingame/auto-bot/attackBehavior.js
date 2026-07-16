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

  // Early-game tribe scoring may need one border snapshot per candidate. Keep the
  // async enrichment bounded so a crowded tribe map cannot starve the combat tick.
  const EARLY_TRIBE_CANDIDATES = 8;
  const EARLY_TRIBE_BOAT_ETA_TARGETS = BOAT_PROBE_CANDIDATES;
  const EARLY_GAME_TRIBE_CHAIN_RADIUS = 120;
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
        let low = previousTroops;
        let high = currentTroops;
        for (
          let iteration = 0;
          iteration < ATTACK_EARLY_GAME_PEAK_SEARCH_ITERATIONS;
          iteration++
        ) {
          const middle = (low + high) / 2;
          if (earlyGameTroopAccelerationSlope(middle, maximum) > 0) {
            low = middle;
          } else {
            high = middle;
          }
        }
        const candidate = (low + high) / 2;
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
    } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:395");
      return false;
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
      this.botAttackPendingIntentCommitments = [];
      this.outboundIntentReconciledTick = null;
      this.botPendingDonationIntentCommitments = [];
      this.outboundDonationIntentReconciledTick = null;
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
      this.earlyGameMaritimeWaterCache = new Map();
      this.earlyGamePreferredClusterTargetKeys = new Set();
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
      try {
        const tick = Number(this.game?.ticks?.());
        return Number.isFinite(tick) ? tick : 0;
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:553");
        return 0;
      }
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

    getOutboundAttackSnapshot() {
      let outgoing = [];
      try {
        outgoing = this.player.outgoingAttacks?.() || [];
      } catch (_error) {
        outgoing = [];
      }
      return outgoing
        .map((attack) => {
          try {
            if (attack.retreating?.()) return null;
            const target = attack.target?.();
            const targetIsPlayer = target?.isPlayer?.() === true;
            return {
              attack,
              id: attack.id?.(),
              targetIsPlayer,
              targetKey: targetIsPlayer
                ? this.getOutboundAttackTargetKey(target)
                : null,
              troops: Math.max(0, Number(attack.troops?.() || 0)),
            };
          } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:616");
            return null;
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
      let units = [];
      try {
        units = this.player.units(transportType) || [];
      } catch (_error) {
        units = [];
      }
      return units
        .map((unit) => {
          try {
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
          } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:654");
            return null;
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

    reconcileOutboundAttackIntentCommitments(
      tick = this.currentAttackDecisionTick(),
    ) {
      if (this.outboundIntentReconciledTick === tick) return;
      this.outboundIntentReconciledTick = tick;
      const pending = this.botAttackPendingIntentCommitments;
      if (!Array.isArray(pending) || pending.length === 0) return;

      const attacks = this.getOutboundAttackSnapshot();
      const transports = this.getOutboundTransportSnapshot();
      const usedAttackIDs = new Set();
      const usedAttackObjects = new Set();
      const usedTransportIDs = new Set();
      const usedTransportObjects = new Set();
      const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
      let consumedObservedTroopDrop = 0;
      const next = [];

      for (const entry of pending) {
        const amount = Math.max(0, Number(entry.troops) || 0);
        if (amount <= 0) continue;
        let applied = false;

        if (entry.attackType === "boat" && entry.destination != null) {
          const liveTransport = transports.find((candidate) => {
            if (candidate.targetTile !== entry.destination) return false;
            if (usedTransportObjects.has(candidate.unit)) return false;
            if (candidate.id != null && usedTransportIDs.has(candidate.id)) {
              return false;
            }
            const isNewTransport =
              candidate.id != null &&
              !entry.baselineTransportIDs?.has(candidate.id) &&
              !entry.baselineTransportIDs?.has(String(candidate.id));
            return (
              isNewTransport ||
              candidate.troops >=
                Math.max(
                  1,
                  (Number(entry.baselineDestinationTroops) || 0) +
                    amount * 0.25,
                )
            );
          });
          if (liveTransport) {
            usedTransportObjects.add(liveTransport.unit);
            if (liveTransport.id != null) {
              usedTransportIDs.add(liveTransport.id);
            }
            applied = true;
          }
        }

        if (!applied) {
          const matchingAttacks = attacks.filter((candidate) =>
            entry.targetIsPlayer
              ? candidate.targetIsPlayer &&
                candidate.targetKey === entry.targetKey
              : !candidate.targetIsPlayer,
          );
          const currentTargetTroops = matchingAttacks.reduce(
            (total, candidate) => total + candidate.troops,
            0,
          );
          const visibleAttack = matchingAttacks.find((candidate) => {
            if (usedAttackObjects.has(candidate.attack)) return false;
            if (candidate.id != null && usedAttackIDs.has(candidate.id)) {
              return false;
            }
            const isNewAttack =
              candidate.id != null &&
              !entry.baselineAttackIDs?.has(candidate.id) &&
              !entry.baselineAttackIDs?.has(String(candidate.id));
            return (
              isNewAttack ||
              currentTargetTroops >=
                Math.max(
                  1,
                  (Number(entry.baselineTargetTroops) || 0) + amount * 0.25,
                )
            );
          });
          if (visibleAttack) {
            usedAttackObjects.add(visibleAttack.attack);
            if (visibleAttack.id != null) usedAttackIDs.add(visibleAttack.id);
            applied = true;
          }
        }

        // A valid execution can reduce the troop balance before its attack
        // snapshot is visible. Consume observed drops oldest-first so one drop
        // cannot incorrectly satisfy every pending intent.
        const baselineTroops = Math.max(
          0,
          Number(entry.baselineTroops) || 0,
        );
        const troopDrop = Math.max(
          0,
          baselineTroops - ownTroops - consumedObservedTroopDrop,
        );
        if (!applied && troopDrop >= Math.max(1, amount * 0.5)) {
          applied = true;
          consumedObservedTroopDrop += amount;
        }

        const createdTick = Number(entry.createdTick);
        const age =
          tick - (Number.isFinite(createdTick) ? createdTick : tick);
        if (!applied && age <= BOT_OUTBOUND_INTENT_GRACE_TICKS) {
          next.push(entry);
        }
      }

      this.botAttackPendingIntentCommitments = next;
    }

    getPendingOutboundAttackTroops() {
      this.reconcileOutboundAttackIntentCommitments();
      return this.botAttackPendingIntentCommitments.reduce(
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
        return Math.min(
          ownTroops,
          Math.max(ownTroops - remainingOpeningCommitment, borderThreat),
        );
      }

      // After the opening budget expires, TerraNullius expansion must never
      // cross the troop-production peak. The live reserve can raise this floor
      // further when border pressure warrants it.
      return Math.max(
        this.getEarlyGameProductionReserveTroops(),
        this.getEarlyGameLiveReserveTroops(),
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
        this.terraNulliusSafetyTroopHighWater * (1 - EARLY_EXPAND_COMMIT),
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

      let maximum = observedTroops;
      try {
        maximum = Math.max(
          observedTroops,
          Number(this.game.config().maxTroops(this.player)) || observedTroops,
        );
      } catch (_error) {
        /* keep the observed troop count as a safe fallback */
      }
      return maximum;
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

    isProductionReserveTarget(target) {
      if (!target?.isPlayer?.()) return false;
      const type = target.type?.();
      return type === PlayerType.Nation || type === PlayerType.Human;
    }

    getEarlyGameTargetReserveTroops(target) {
      if (this.isProductionReserveTarget(target)) {
        return this.getEarlyGameProductionReserveTroops();
      }
      return target?.isPlayer?.()
        ? this.getEarlyGameLiveReserveTroops()
        : this.getEarlyGameTerraNulliusReserveTroops();
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

    getStrongestBorderOpponentTroops(includeFriendly = false) {
      const tick = this.currentAttackDecisionTick();
      if (
        this.strongestBorderOpponentTroopsCacheTick === tick &&
        this.strongestBorderOpponentTroopsCacheIncludeFriendly ===
          includeFriendly
      ) {
        return this.strongestBorderOpponentTroopsCache;
      }

      const game = this.game;
      const me = this.player;
      let strongest = null;

      try {
        if (
          !game ||
          !me ||
          typeof me.borderTiles !== "function" ||
          typeof me.smallID !== "function" ||
          typeof game.neighbors !== "function" ||
          typeof game.isLand !== "function" ||
          typeof game.hasOwner !== "function" ||
          typeof game.ownerID !== "function" ||
          typeof game.players !== "function"
        ) {
          throw new Error("border troop data is unavailable");
        }

        const mySid = me.smallID();
        if (mySid == null) throw new Error("own player id is unavailable");

        const borderingPlayerIds = new Set();
        for (const borderTile of me.borderTiles() || []) {
          for (const neighbor of game.neighbors(borderTile) || []) {
            if (!game.isLand(neighbor) || !game.hasOwner(neighbor)) continue;
            const ownerSid = game.ownerID(neighbor);
            if (ownerSid != null && ownerSid !== mySid) {
              borderingPlayerIds.add(ownerSid);
            }
          }
        }

        const players = Array.from(game.players() || []);
        if (
          !players.some(
            (player) =>
              player &&
              typeof player.smallID === "function" &&
              player.smallID() === mySid,
          )
        ) {
          throw new Error("own player is missing from the player snapshot");
        }

        strongest = 0;
        const seenBorderingPlayerIds = new Set();
        for (const player of players) {
          if (!player || typeof player.smallID !== "function") continue;
          const playerSid = player.smallID();
          if (playerSid == null || !borderingPlayerIds.has(playerSid)) continue;
          seenBorderingPlayerIds.add(playerSid);
          if (typeof player.isAlive !== "function") {
            throw new Error("border opponent life state is unavailable");
          }
          if (!player.isAlive()) continue;

          // Allies are not an immediate combat reserve requirement. Counting a
          // stronger ally here could reserve our entire army and permanently
          // suppress adjacent TerraNullius while that same ally closed the
          // remaining expansion corridor.
          if (!includeFriendly) {
            if (typeof me.isFriendly !== "function") {
              throw new Error("border relation data is unavailable");
            }
            if (me.isFriendly(player) === true) continue;
          }

          if (typeof player.troops !== "function") {
            throw new Error("border opponent troops are unavailable");
          }
          const troops = Number(player.troops());
          if (!Number.isFinite(troops)) {
            throw new Error("border opponent troops are invalid");
          }
          strongest = Math.max(strongest, Math.max(0, troops));
        }
        for (const playerSid of borderingPlayerIds) {
          if (!seenBorderingPlayerIds.has(playerSid)) {
            throw new Error("border opponent is missing from the player snapshot");
          }
        }
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:1121");
        strongest = null;
      }

      this.strongestBorderOpponentTroopsCacheTick = tick;
      this.strongestBorderOpponentTroopsCacheIncludeFriendly = includeFriendly;
      this.strongestBorderOpponentTroopsCache = strongest;
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

    getTerraNulliusFrontierTiles(preferredTile = null) {
      if (preferredTile != null) {
        if (
          typeof this.game?.isLand === "function" &&
          !this.game.isLand(preferredTile)
        ) {
          return [];
        }
        if (
          typeof this.game?.magnitude === "function" &&
          Number(this.game.magnitude(preferredTile)) >= 31
        ) {
          return [];
        }
        return [preferredTile];
      }

      if (
        typeof this.game?.neighbors !== "function" ||
        typeof this.game?.isLand !== "function" ||
        typeof this.game?.hasOwner !== "function"
      ) {
        return [];
      }

      const frontier = [];
      const seen = new Set();
      for (const borderTile of this.player?.borderTiles?.() || []) {
        for (const tile of this.game.neighbors(borderTile) || []) {
          if (seen.has(tile)) continue;
          seen.add(tile);
          if (!this.game.isLand(tile) || this.game.hasOwner(tile)) continue;
          if (
            typeof this.game.magnitude === "function" &&
            Number(this.game.magnitude(tile)) >= 31
          ) {
            continue;
          }
          frontier.push(tile);
        }
      }
      return frontier;
    }

    getTerraNulliusAttackLoss(target, tile) {
      const attackTroops = Math.max(
        1,
        Number(this.player?.troops?.() || 1),
      );
      try {
        const attackLogic = this.game?.config?.()?.attackLogic;
        if (typeof attackLogic === "function") {
          const result = attackLogic(
            this.game,
            attackTroops,
            this.player,
            target,
            tile,
          );
          const loss = Number(result?.attackerTroopLoss);
          if (Number.isFinite(loss) && loss >= 0) return loss;
        }
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:1205");
        // Fall through to the terrain-based client fallback below.
      }

      const magnitude = Number(this.game?.magnitude?.(tile));
      if (!Number.isFinite(magnitude)) return 1;
      const terrainLoss = magnitude < 10 ? 80 : magnitude < 20 ? 100 : 120;
      const attackerLoss =
        this.player?.type?.() === PlayerType.Bot
          ? terrainLoss / 10
          : terrainLoss / 5;
      const falloutMultiplier = this.game?.hasFallout?.(tile)
        ? this.getRadioactiveTerraNulliusFalloutDefenseMultiplier()
        : 1;
      return attackerLoss * falloutMultiplier;
    }

    getTerraNulliusAttackTroops(
      target = null,
      preferredTile = null,
      spendableTroops = null,
      commitFraction = null,
    ) {
      const configuredSpendable = Number(spendableTroops);
      const reserveSpendable =
        spendableTroops !== null && Number.isFinite(configuredSpendable)
          ? Math.max(0, configuredSpendable)
          : this.getEarlyGameSpendableTroops(
              this.getEarlyGameTerraNulliusReserveTroops(),
            );
      let available = reserveSpendable;
      if (state.settings.winFixes) {
        available = Math.min(
          available,
          this.getRemainingTerraNulliusOpeningCommitment(),
        );
      }
      const terraNullius = target || this.game?.terraNullius?.();
      const frontier = this.getTerraNulliusFrontierTiles(preferredTile);
      let minimum = 1;
      let livenessFollowUp = false;
      for (const tile of frontier) {
        const loss = this.getTerraNulliusAttackLoss(terraNullius, tile);
        if (Number.isFinite(loss) && loss > 0) {
          minimum = Math.max(minimum, Math.ceil(loss));
        }
      }

      // An underfunded TerraNullius intent is not partial progress: the engine
      // charges the first-tile loss before ownership changes. Wait until the
      // exact first tile is affordable instead of repeatedly emitting attacks
      // that cannot expand the border.
      const ownTroops = Math.max(
        0,
        Number(this.player?.troops?.() || 0),
      );
      const followUpFraction =
        typeof EARLY_EXPAND_FOLLOWUP_COMMIT === "number"
          ? EARLY_EXPAND_FOLLOWUP_COMMIT
          : 0.01;
      const followUpTroops = Math.max(
        minimum,
        ownTroops * followUpFraction,
      );
      if (available < followUpTroops) {
        // The cumulative opening allowance is a pacing target, not permission
        // to deadlock while free land remains adjacent. Permit exactly one
        // frontier-tile loss when the normal production and border-threat
        // reserve can afford it; pending-intent reconciliation still prevents
        // duplicate emissions against the same stale troop snapshot.
        // An explicit spendable amount is an authoritative caller safety cap.
        // The automatic path may bypass the moving production-peak target, but
        // never the opening-army safety floor or the strongest border threat.
        if (spendableTroops !== null) return 0;
        const livenessAvailable = this.getEarlyGameSpendableTroops(
          this.getTerraNulliusLivenessReserveTroops(),
        );
        if (livenessAvailable < minimum) return 0;
        // After the decisive opening burst, keep free-land expansion moving at
        // 1% per acknowledged intent (or the exact one-tile minimum when that is
        // larger). Pending reconciliation and the shared rate limiter determine
        // the fastest safe emission cadence.
        available = Math.min(
          livenessAvailable,
          followUpTroops,
        );
        livenessFollowUp = true;
      }

      // The engine conquers the first tile before checking whether the attack
      // has enough troops for another tile. Use the calculated one-tile loss as
      // the default payload for land expansion and transport probes. The first
      // live opening may explicitly request a larger safe burst; the spendable
      // budget still caps it against reserves and pending intents.
      const configuredCommitFraction = Number(commitFraction);
      if (
        commitFraction !== null &&
        Number.isFinite(configuredCommitFraction)
      ) {
        const boundedCommitFraction = Math.min(
          1,
          Math.max(0, configuredCommitFraction),
        );
        const ownTroops = Math.max(0, Number(this.player?.troops?.() || 0));
        return Math.min(
          available,
          Math.max(minimum, ownTroops * boundedCommitFraction),
        );
      }
      return livenessFollowUp
        ? Math.max(minimum, Math.floor(available))
        : Math.min(available, minimum);
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
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:1384");
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
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:1406");
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
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:1451");
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

      // The worker can acknowledge an intent several ticks after it is emitted.
      // Reconcile before ranking targets so a visible attack is not treated as
      // fresh capacity while an unacknowledged intent still consumes troops.
      this.reconcileOutboundAttackIntentCommitments();

      const border = Array.from(this.player.borderTiles())
        .flatMap((t) => this.game.neighbors(t))
        .filter(
          (t) =>
            this.game.isLand(t) &&
            this.game.ownerID(t) !== this.player?.smallID(),
        );
      // A directly adjacent, non-radioactive TerraNullius tile is the only
      // genuinely cost-free expansion: no opponent troops and no transport
      // spend. It must be resolved before every tribe/player-food branch.
      const hasAccessibleFreeLand = border.some(
        (tile) => !this.game.hasOwner(tile) && !this.game.hasFallout(tile),
      );
      const hasAccessibleRadioactiveLand = border.some(
        (tile) => !this.game.hasOwner(tile) && this.game.hasFallout(tile),
      );
      const hasAccessibleTerraNullius =
        hasAccessibleFreeLand || hasAccessibleRadioactiveLand;
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
        if (!n.isPlayer() || borderingPlayerSet.has(n)) continue;
        try {
          if (this.player.sharesBorderWith(n) === true) {
            borderingPlayerSet.add(n);
          }
        } catch (_error) {
          // The tile-owner pass above remains authoritative when the optional
          // convenience predicate is unavailable.
        }
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
        hasAccessibleFreeLand ||
        playerNeighbors.some((n) => !n.isPlayer());
      // A maritime-only TerraNullius target is speculative: a transport can be
      // sunk or fail to land, so it must not suppress the tribe food race. We
      // still send one cheap probe when boats are enabled, then fall through to
      // the normal tribe pass in this same decision.
      const hasMaritimeTerraNullius =
        !hasAccessibleTerraNullius &&
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
            // A sea candidate only blocks donations after the async route probe
            // supplies an ETA; nearby() alone is not a transport-time guarantee.
            seaReachableWithin30Ticks: false,
            boatEtaTicks: null,
          };
        });
      const earlyGameSnapshot = createEarlyGameSnapshot({
        postSpawn: this.game.inSpawnPhase() === false && this.player.hasSpawned(),
        // Only directly reachable land is guaranteed. A nearby non-player can
        // represent a sea-only TerraNullius route, which remains uncertain until
        // the probe actually lands.
        hasFreeLand: hasAccessibleTerraNullius,
        tribes: tribeTargets,
        boatRouteAvailable: this.game.hasTransportRouteEstimator === true,
      });
      const previousEarlyGame = state.earlyGame || {};
      state.earlyGame = {
        ...earlyGameSnapshot,
        action: chooseEarlyGameAction({
          landTarget: hasAccessibleTerraNullius,
          tribeTarget: earlyGameSnapshot.hasTribeTarget,
          boatTarget: false,
        }),
        maritimeProbeSent: false,
        tribeTarget: null,
        oceanTarget: null,
        boatGate: null,
        lastBoatEtaTicks: null,
        boatRejectedUnknown: previousEarlyGame.boatRejectedUnknown || 0,
        boatRejectedTooFar: previousEarlyGame.boatRejectedTooFar || 0,
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
      const expandOn = Boolean(f.expand);
      const boatOn = Boolean(f.boat);
      const allianceOn = Boolean(f.alliance);

      // WIN-FIX: an active hostile attack is the first combat priority. Keeping
      // retaliation inside the later difficulty strategy list allowed free-land,
      // tribe, boat, and other expansion branches to return every cycle before
      // that strategy was reached. `force` bypasses target reluctance and stale
      // pending expansion intents; sendLandAttack still enforces the live troop
      // reserve, Defense Post safety, and the shared intent-rate budget.
      if (expandOn && state.settings.winFixes) {
        const incomingAttacker = this.findIncomingAttackPlayer();
        if (incomingAttacker && (await this.sendAttack(incomingAttacker, true))) {
          state.earlyGame.action = "retaliate";
          return;
        }
      }

      // WIN-FIX: adjacent TerraNullius is the first choice, including radioactive
      // green land. Only stop after an expansion intent is actually emitted. A
      // reserve, pending-intent, or rate-limit rejection must not let one visible
      // free tile starve every tribe/player attack until another player claims it.
      if (expandOn && state.settings.winFixes && hasAccessibleTerraNullius) {
        if (
          await this.sendAttack(
            this.game.terraNullius(),
            false,
            null,
            null,
            hasAccessibleRadioactiveLand,
          )
        ) {
          return;
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

      let maritimeTerraNulliusProbeSent = false;
      if (
        expandOn &&
        boatOn &&
        state.settings.winFixes &&
        hasMaritimeTerraNullius
      ) {
        const radioactiveTerraNullius = this.isBorderingNukedTerritory();
        // Deliberately do not return after this sendAttack. The sea route is a
        // wager, not owned land yet; the tribe attack below must proceed without
        // waiting for the transport to prove itself.
        maritimeTerraNulliusProbeSent = await this.sendAttack(
          this.game.terraNullius(),
          false,
          null,
          null,
          radioactiveTerraNullius,
        );
        if (maritimeTerraNulliusProbeSent) {
          state.earlyGame.action = "maritime-probe";
          state.earlyGame.maritimeProbeSent = true;
        }
      }

      // WIN-FIX (NOT in src): after spawning, probe nearby tribes whenever the
      // higher-priority direct free-land attempt did not emit. The preliminary
      // snapshot only knows about current land borders; getEarlyGameTribeCandidates
      // performs the bounded maritime route check needed to discover the first
      // attack without a manual opener.
      // Rank verified tribe routes by balanced capture, race, control, continuation, and
      // maritime-opportunity utility. The
      // progressing-vector race signal remains a later tie-breaker. If no ranked
      // target can be actuated, fall back to the existing aggressive bot pass.
      if (
        expandOn &&
        state.settings.winFixes &&
        earlyGameSnapshot.postSpawn
      ) {
        if (await this.attackEarlyGameTribe()) {
          state.earlyGame.action = "tribe";
          return;
        }
      }

      // WIN-FIX (NOT in src): if we already hold an ocean shore, take a nearby
      // unowned open-ocean coast before generic empty-land expansion. The landing
      // remains a cheap probe and is still subject to the exact <=30s early-game
      // transport gate. `isOceanShore` excludes isolated lakes such as Luna.
      if (
        expandOn &&
        boatOn &&
        state.settings.winFixes &&
        earlyGameSnapshot.active &&
        !maritimeTerraNulliusProbeSent
      ) {
        if (await this.maybeEarlyOceanBoat()) {
          // An ocean probe is also speculative. If a tribe is actionable, keep
          // the decision alive for the tribe pass; with no tribe, the probe is
          // the useful expansion action for this cycle.
          if (!earlyGameSnapshot.hasTribeTarget) return;
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

      // Final TerraNullius fallback. Faithful mode keeps its original clean-land
      // behavior. In win-fix mode, radioactive land is deliberately deferred
      // until the actionable tribe/boat/player lanes above have failed, then it
      // becomes the expansion target instead of leaving the bot permanently idle.
      const radioactiveTerraNullius =
        state.settings.winFixes === true &&
        !hasAccessibleFreeLand &&
        this.isBorderingNukedTerritory();
      if (
        expandOn &&
        ((!state.settings.winFixes && hasNonNukedTerraNullius) ||
          radioactiveTerraNullius)
      ) {
        if (
          await this.sendAttack(
            this.game.terraNullius(),
            false,
            null,
            null,
            radioactiveTerraNullius,
          )
        ) {
          return;
        }
      }

      // If free-land expansion was not actionable, keep the aggressive tribe pass
      // available before the ordinary difficulty strategy pipeline.
      if (
        expandOn &&
        state.settings.winFixes &&
        borderingEnemies.some((e) => e.isPlayer() && e.type() === PlayerType.Bot)
      ) {
        if (await this.attackBots()) {
          state.earlyGame.action = "tribe";
          return;
        }
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

    // Rank and eat several tribes during Early Game. This is a win-fix policy
    // layer, not a replacement for the faithful attack strategy order below.
    // Each successful capture reserves its own intent budget, so different
    // tribes can be invaded in the same decision without duplicating troops.
    async attackEarlyGameTribe() {
      const candidates = await this.getEarlyGameTribeCandidates();
      if (candidates.length === 0) return false;

      this.botAttackTroopsSent = 0;
      const selectedTargetKeys = this.getActiveTribeAttackTargetKeys();
      const maxParallelAttacks = Math.max(1, this.getBotAttackMaxParallelism());
      let launchedAttacks = 0;
      const ranked = rankEarlyGameTribeCandidates(candidates);
      // Concentrate the opening army on the largest reachable tribe component.
      // Ranking the best gateway first was insufficient because the parallel
      // loop then spent its remaining budget on smaller clusters in unrelated
      // directions. Parallel attacks are now allowed only within the same
      // maximum-size component.
      const strategicRanked = keepLargestTribeClusterCandidates(ranked);
      this.earlyGamePreferredClusterTargetKeys = new Set(
        strategicRanked
          .map((candidate) =>
            this.getOutboundAttackTargetKey(candidate.player),
          )
          .filter((key) => key != null),
      );
      const diagnosticTargets = ranked.map((candidate) => ({
        id: candidate.id,
        utility: Number(calculateEarlyGameTribeUtility(candidate).toFixed(3)),
        routeEfficiency: Number(
          calculateEarlyGameRouteEfficiency(candidate).toFixed(3),
        ),
        captureEfficiency: Number(
          finiteEarlyGameSignal(
            candidate.captureEfficiency == null
              ? candidate.cheapCapture
              : candidate.captureEfficiency,
          ).toFixed(3),
        ),
        targetTiles: Number(candidate.targetTiles) || 0,
        estimatedCaptureCost:
          Math.round(Number(candidate.estimatedCaptureCost)) || 0,
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
        seaReachableWithin30Ticks:
          candidate.landBorder !== true &&
          Number.isFinite(candidate.boatEtaTicks) &&
          candidate.boatEtaTicks >= 0 &&
          candidate.boatEtaTicks <= getAutoDonateExpansionTickLimit(),
        boatEtaTicks: Number.isFinite(candidate.boatEtaTicks)
          ? candidate.boatEtaTicks
          : null,
        contestingPlayers: candidate.contestingPlayers,
      }));
      if (state.earlyGame) {
        state.earlyGame.actionableTribes = diagnosticTargets;
        state.earlyGame.tribeTarget = diagnosticTargets[0] || null;
        if (diagnosticTargets.length > 0) {
          state.earlyGame.active = true;
          state.earlyGame.hasTribeTarget = true;
        }
      }

      for (const candidate of strategicRanked) {
        if (
          launchedAttacks >= maxParallelAttacks ||
          !hasAttackIntentRateCapacity()
        )
          break;
        const targetKey = this.getOutboundAttackTargetKey(candidate.player);
        if (selectedTargetKeys.has(targetKey)) {
          // A tribe can keep conquering TerraNullius after our attack starts,
          // raising both its troops and capture cost. Do not abandon that live
          // attack forever. Wait for any prior top-up intent to reconcile, then
          // send only the newly missing strength.
          if (this.hasPendingOutboundAttackForTarget(candidate.player)) continue;
          const committedTroops =
            this.getLiveOutboundAttackTroopsForTarget(candidate.player);
          if (committedTroops < 1) continue;
          candidate.existingCommittedTroops = committedTroops;
        }

        try {
          if (
            await this.sendAttack(
              candidate.player,
              false,
              null,
              candidate,
              false,
              true,
            )
          ) {
            selectedTargetKeys.add(targetKey);
            launchedAttacks++;
          }
        } catch (error) {
          console.warn("[EarlyGame] tribe target failed:", candidate.id, error);
        }
      }
      return launchedAttacks > 0;
    }

    // OpenFront marks the largest/open water body with `isOcean`, and that bit
    // propagates through connected water. Smaller rivers can still be a useful
    // maritime corridor when they leave through the map edge, while a closed
    // inland lake must remain excluded from this objective.
    isEarlyGameMaritimeWater(tile) {
      if (tile == null || typeof this.game.isWater !== "function") return false;
      try {
        if (this.game.isOcean?.(tile) === true) return true;
      } catch (_e) {
        /* fall through to the component scan */
      }

      if (this.earlyGameMaritimeWaterCache.has(tile)) {
        return this.earlyGameMaritimeWaterCache.get(tile) === true;
      }

      const queue = [tile];
      const seen = new Set([tile]);
      let maritime = false;
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        try {
          if (
            this.game.isOcean?.(current) === true ||
            this.isEarlyGameMapEdge(current)
          ) {
            maritime = true;
            break;
          }
        } catch (_e) {
          /* malformed map adapters are handled conservatively */
        }
        for (const next of this.game.neighbors(current) || []) {
          if (seen.has(next)) continue;
          if (!this.game.isWater(next)) continue;
          seen.add(next);
          queue.push(next);
        }
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
      try {
        if (this.game.isOceanShore?.(tile) === true) return true;
      } catch (_e) {
        /* fall through to river-edge detection */
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
    // Border snapshots are fetched in bounded batches. Complete tribe topology
    // is required before the eight expensive attack candidates are selected;
    // otherwise uncached surrounding tribes disappear from the cluster graph.
    // The stages remain together so their bounded maps share one coherent game
    // snapshot; splitting this orchestration would make cross-tick data mixing
    // easier. The expensive worker calls are separately bounded and parallel.
    // eslint-disable-next-line max-lines-per-function
    async getEarlyGameTribeCandidates() {
      const otherPlayers = this.game.players();
      const eligibleTribesById = new Map();
      const addEligibleTribe = (candidate) => {
        if (
          candidate &&
          candidate.isPlayer() &&
          candidate.isAlive() &&
          candidate.type() === PlayerType.Bot &&
          this.player.isFriendly(candidate) === false
        ) {
          eligibleTribesById.set(candidate.smallID(), candidate);
        }
      };
      for (const candidate of this.player.nearby()) addEligibleTribe(candidate);
      // nearby() is an opportunistic client snapshot and can omit a tribe when
      // a hostile human/nation also occupies our frontier. Confirmed land-border
      // tribes from the authoritative player list must remain edible regardless
      // of which neighbour happened to dominate that snapshot.
      for (const candidate of otherPlayers) {
        try {
          if (this.player.sharesBorderWith(candidate) === true) {
            addEligibleTribe(candidate);
          }
        } catch (error) {
          recordOptionalAttackSnapshotFailure(error);
          /* nearby() remains the fallback on older adapters */
        }
      }
      const eligibleNearbyTribes = [...eligibleTribesById.values()];
      // Choose the bounded enrichment sample with the strategic destination in
      // view. Previously cluster value was calculated only after this list had
      // already been truncated, so a cheap/local tribe could hide the gateway
      // into the largest tribe group before the cluster-aware ranker saw it.
      const lightweightTribeNodes = otherPlayers
        .filter(
          (tribe) =>
            tribe?.isPlayer?.() === true &&
            tribe.isAlive?.() === true &&
            tribe.type?.() === PlayerType.Bot &&
            this.player.isFriendly(tribe) === false,
        )
        .map((tribe) => ({
          id: tribe.smallID(),
          player: tribe,
          center: tribe.nameLocation?.(),
        }));
      const edibleTribeIds = new Set(
        lightweightTribeNodes.map((tribe) => tribe.id),
      );
      const tribeAdjacency = new Map(
        lightweightTribeNodes.map((tribe) => [tribe.id, new Set()]),
      );
      const topologyBordersById = new Map();
      for (
        let start = 0;
        start < lightweightTribeNodes.length;
        start += EARLY_TRIBE_CANDIDATES
      ) {
        const batch = lightweightTribeNodes.slice(
          start,
          start + EARLY_TRIBE_CANDIDATES,
        );
        await Promise.all(
          batch.map(async (tribe) => {
            let border = new Set();
            try {
              if (typeof this.game.ensureBorderTiles === "function") {
                const fetched = await withTimeout(
                  this.game.ensureBorderTiles(tribe.player),
                  WORKER_TIMEOUT_MS,
                  null,
                );
                if (fetched && fetched.size > 0) border = fetched;
              }
              if (border.size === 0) {
                border = tribe.player.borderTiles?.() || new Set();
              }
            } catch (error) {
              recordOptionalAttackSnapshotFailure(error);
            }
            topologyBordersById.set(tribe.id, border);
          }),
        );
      }
      for (const tribe of lightweightTribeNodes) {
        const border = topologyBordersById.get(tribe.id) || [];
        for (const tile of border) {
          for (const neighbor of this.game.neighbors(tile) || []) {
            if (!this.game.isLand(neighbor)) continue;
            const neighborId = this.game.ownerID(neighbor);
            if (
              neighborId == null ||
              neighborId === tribe.id ||
              !edibleTribeIds.has(neighborId)
            ) {
              continue;
            }
            tribeAdjacency.get(tribe.id).add(neighborId);
            tribeAdjacency.get(neighborId).add(tribe.id);
          }
        }
      }
      const lightweightClusterSizes = calculateTribeAdjacencyClusterSizes(
        lightweightTribeNodes,
        tribeAdjacency,
      );
      const rankSamplingTribes = (tribes) =>
        rankEarlyGameTribeSamplingCandidates(
          tribes.map((tribe) => ({
            player: tribe,
            id: tribe.smallID(),
            clusterSize: lightweightClusterSizes.get(tribe.smallID()) || 1,
            opportunity:
              Math.max(1, Number(tribe.numTilesOwned?.()) || 1) /
              Math.max(1, Number(tribe.troops?.()) || 1),
          })),
        ).map((candidate) => candidate.player);
      // Do not let speculative sea targets consume the bounded sample before a
      // known bordering tribe. The remaining order stays as nearby() supplies it.
      const borderingTribes = [];
      const otherTribes = [];
      for (const tribe of eligibleNearbyTribes) {
        let bordering = false;
        try {
          bordering = this.player.sharesBorderWith(tribe) === true;
        } catch (_e) {
          /* older adapters may not expose sharesBorderWith */
        }
        (bordering ? borderingTribes : otherTribes).push(tribe);
      }
      const nearbyTribes = rankSamplingTribes(borderingTribes)
        .concat(rankSamplingTribes(otherTribes))
        .slice(0, EARLY_TRIBE_CANDIDATES);
      if (nearbyTribes.length === 0) return [];

      const playersBySid = new Map(
        otherPlayers
          .filter((player) => player?.isPlayer?.() === true)
          .map((player) => [player.smallID(), player]),
      );
      const myCenter = this.getPlayerCenter(this.player);
      const mySid = this.player.smallID();
      const hasOpenOceanAccess = Array.from(
        this.player.borderTiles?.() || [],
      ).some((tile) => this.isEarlyGameMaritimeShore(tile));
      const competitorProfiles = this.getEarlyGameCompetitorProfiles(
        otherPlayers,
        mySid,
      );
      const candidates = [];
      const borderByTribe = new Map();

      // The client worker calls are independent. Await the bounded group in
      // parallel so one slow snapshot costs one timeout window, not eight.
      await Promise.all(
        nearbyTribes.map(async (tribe) => {
          let border =
            topologyBordersById.get(tribe.smallID()) || new Set();
          try {
            if (
              border.size === 0 &&
              typeof this.game.ensureBorderTiles === "function"
            ) {
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
          } catch (error) {
            recordOptionalAttackSnapshotFailure(error);
            /* no border snapshot → keep conservative candidate signals */
          }
          borderByTribe.set(tribe, border);
        }),
      );

      for (const tribe of nearbyTribes) {
        const border = borderByTribe.get(tribe) || new Set();

        const tribeSid = tribe.smallID();
        const {
          boundaryEdges,
          ownEdges,
          externalEdges,
          alliedEdges,
          externalSids,
        } = analyzeTribeBoundary({
          game: this.game,
          player: this.player,
          border,
          tribeSid,
          mySid,
          playersBySid,
        });

        const encirclement =
          boundaryEdges > 0 ? ownEdges / boundaryEdges : 0;
        const directBlock =
          boundaryEdges > 0 ? externalEdges / boundaryEdges : 0;
        // An ally closing around a tribe is more urgent than an ordinary rival:
        // once the ally owns the chokepoint we cannot reopen that expansion path
        // without breaking diplomacy. Race for the neutral tribe, never the ally.
        const alliedCutoffPressure =
          boundaryEdges > 0 ? alliedEdges / boundaryEdges : 0;
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
        } catch (error) {
          recordOptionalAttackSnapshotFailure(error);
          /* attack snapshots are optional on older client builds */
        }

        // Rival proximity belongs to the race signal. Passage blocking itself
        // is the directly observed share of the tribe frontier touching others.
        const blockValue = directBlock;
        const foodRace = this.getEarlyGameFoodRaceSignals({
          tribe,
          tribeSid,
          tribeCenter,
          competitorProfiles,
        });
        const maritimeDistance = this.getEarlyGameMaritimeDistance(border);
        // If we do not own an open-ocean shore yet, a tribe on that shore is a
        // strategic gateway rather than a generic maritime bonus. Claiming it
        // now prevents allies from permanently sealing our naval expansion.
        const oceanGatewayUrgency =
          !hasOpenOceanAccess && maritimeDistance === 0 ? 1 : 0;
        const troopRatio =
          this.player.troops() > 0
            ? tribe.troops() / this.player.troops()
            : 1;
        let sharesLandBorder = ownEdges > 0;
        if (!sharesLandBorder) {
          try {
            sharesLandBorder = this.player.sharesBorderWith(tribe) === true;
          } catch (_e) {
            /* older adapters may not expose an immediate border predicate */
          }
        }
        const defenseProfile = this.getEnemyDefensePostAttackProfile(
          tribe,
          border,
        );
        const targetTiles = Math.max(
          1,
          Number(tribe.numTilesOwned?.()) || border.size || 1,
        );
        const estimatedCaptureCost = Math.max(
          1,
          Number(tribe.troops()) || 0,
        ) * Math.max(1, Number(defenseProfile.attackCostMultiplier) || 1);
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
          alliedCutoffPressure,
          oceanGatewayUrgency,
          hasOpenOceanAccess,
          cheapCapture: Math.max(0, 1 - Math.min(1, troopRatio)),
          targetTiles,
          estimatedCaptureCost,
          captureEfficiencyRaw: targetTiles / estimatedCaptureCost,
          captureEfficiency: 0,
          landBorder: sharesLandBorder,
          distance,
          center: tribeCenter,
          futureFoodCount: 0,
          futureFoodTotal: 0,
          meanFutureFoodDistance: Infinity,
          futureFoodChainRadius: EARLY_GAME_TRIBE_CHAIN_RADIUS,
          futureFoodAccess: null,
          tribeClusterAccess: 0,
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
        });
      }

      // A maritime tribe qualifies for the donation pause only after the same
      // transport pathfinder used by boat actuation has measured a route. Probe
      // bounded shore samples in batches so a crowded map cannot starve the tick.
      const seaCandidates = candidates.filter((candidate) => !candidate.landBorder);
      for (
        let start = 0;
        start < seaCandidates.length;
        start += EARLY_TRIBE_BOAT_ETA_TARGETS
      ) {
        const batch = seaCandidates.slice(
          start,
          start + EARLY_TRIBE_BOAT_ETA_TARGETS,
        );
        await Promise.all(
          batch.map(async (candidate) => {
            candidate.boatEtaTicks = await this.estimateEarlyGameTribeBoatEta(
              borderByTribe.get(candidate.player) || new Set(),
              candidate,
            );
          }),
        );
      }

      const actionableCandidates = candidates.filter(
        isEarlyGameTribeActionable,
      );
      const maxCaptureEfficiency = actionableCandidates.reduce(
        (best, candidate) => Math.max(best, candidate.captureEfficiencyRaw),
        0,
      );
      for (const candidate of candidates) {
        candidate.captureEfficiency = normalizeCaptureEfficiency(
          candidate,
          maxCaptureEfficiency,
        );
      }

      // A bounded continuation pass estimates how many other neutral tribes will
      // be reachable from the newly acquired frontier. This is deliberately a
      // geometric opportunity signal, not a second attack loop.
      // Continuation value must include tribes that are not actionable from our
      // current frontier. Those are precisely the targets that eating this
      // tribe may unlock. Restricting the pool to actionableCandidates only
      // measured redundant access we already had before the conquest.
      // Border/route enrichment remains capped at eight candidates, but cluster
      // direction can use every living tribe's cheap name-location snapshot.
      // This lets a gateway point toward a large cluster that is not yet in our
      // nearby() attack sample without adding map-wide worker calls.
      const futureFoodById = new Map();
      for (const tribe of otherPlayers) {
        if (
          !tribe?.isPlayer?.() ||
          !tribe.isAlive?.() ||
          tribe.type?.() !== PlayerType.Bot ||
          this.player.isFriendly(tribe) === true
        ) {
          continue;
        }
        const center = tribe.nameLocation?.();
        if (
          center &&
          Number.isFinite(Number(center.x)) &&
          Number.isFinite(Number(center.y))
        ) {
          futureFoodById.set(tribe.smallID(), {
            id: tribe.smallID(),
            player: tribe,
            center,
          });
        }
      }
      for (const candidate of candidates) {
        if (
          candidate.center &&
          Number.isFinite(Number(candidate.center.x)) &&
          Number.isFinite(Number(candidate.center.y))
        ) {
          futureFoodById.set(candidate.id, candidate);
        }
      }
      const futureFoodCandidates = [...futureFoodById.values()];
      // Candidate borders were refreshed asynchronously above. Merge those
      // authoritative snapshots into the same topology graph before scoring.
      for (const candidate of candidates) {
        if (!tribeAdjacency.has(candidate.id)) continue;
        for (const tile of borderByTribe.get(candidate.player) || []) {
          for (const neighbor of this.game.neighbors(tile) || []) {
            if (!this.game.isLand(neighbor)) continue;
            const neighborId = this.game.ownerID(neighbor);
            if (
              neighborId == null ||
              neighborId === candidate.id ||
              !tribeAdjacency.has(neighborId)
            ) {
              continue;
            }
            tribeAdjacency.get(candidate.id).add(neighborId);
            tribeAdjacency.get(neighborId).add(candidate.id);
          }
        }
      }
      const clusterSizes = calculateTribeAdjacencyClusterSizes(
        futureFoodCandidates,
        tribeAdjacency,
      );
      let maxClusterSize = 0;
      for (const candidate of candidates) {
        if (!isEarlyGameTribeActionable(candidate)) {
          candidate.futureFoodAccess = 0;
          candidate.tribeClusterAccess = 0;
          continue;
        }
        const futureFoodTotal = Math.max(
          0,
          futureFoodCandidates.length -
            (futureFoodCandidates.includes(candidate) ? 1 : 0),
        );
        const distances = futureFoodCandidates
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
        candidate.futureFoodAccess =
          futureFoodTotal > 0
            ? distances.reduce(
                (sum, value) =>
                  sum +
                  Math.max(
                    0,
                    1 - value / EARLY_GAME_TRIBE_CHAIN_RADIUS,
                  ),
                0,
              ) / futureFoodTotal
            : 0;
        candidate.tribeClusterSize = Math.max(
          0,
          (clusterSizes.get(candidate.id) || 1) - 1,
        );
        maxClusterSize = Math.max(maxClusterSize, candidate.tribeClusterSize);
      }
      for (const candidate of candidates) {
        candidate.tribeClusterAccess =
          isEarlyGameTribeActionable(candidate) && maxClusterSize > 0
            ? candidate.tribeClusterSize / maxClusterSize
            : 0;
      }
      if (state.earlyGame) {
        const preferred = candidates
          .filter(isEarlyGameTribeActionable)
          .sort(
            (left, right) =>
              (Number(right.tribeClusterSize) || 0) -
              (Number(left.tribeClusterSize) || 0),
          )[0];
        const componentIds = preferred
          ? getTribeAdjacencyComponentIds(preferred.id, tribeAdjacency)
          : new Set();
        const componentCenters = [...componentIds]
          .map((id) => futureFoodById.get(id)?.center)
          .filter(
            (center) =>
              Number.isFinite(Number(center?.x)) &&
              Number.isFinite(Number(center?.y)),
          );
        state.earlyGame.preferredClusterCenter =
          componentIds.size > 1
            ? chooseTribeClusterMarkerCenter(componentCenters)
            : null;
        state.earlyGame.preferredClusterMembers =
          state.earlyGame.preferredClusterCenter == null
            ? []
            : [...componentIds]
                .map((id) => {
                  const center = futureFoodById.get(id)?.center;
                  return Number.isFinite(Number(center?.x)) &&
                    Number.isFinite(Number(center?.y))
                    ? { id, x: Number(center.x), y: Number(center.y) }
                    : null;
                })
                .filter(Boolean);
        state.earlyGame.preferredClusterSize =
          state.earlyGame.preferredClusterCenter == null
            ? 0
            : componentIds.size;
      }
      return candidates;
    }

    async estimateEarlyGameTribeBoatEta(targetBorder, candidate = null) {
      try {
        if (this.game.config().isUnitDisabled(UNIT.TransportShip)) return null;
      } catch (_e) {
        /* older adapters do not expose unit-disable checks */
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

      const measuredRoutes = await Promise.all(
        targetShores
          .slice(0, EARLY_TRIBE_BOAT_ETA_TARGETS)
          .map(async (targetShore) => {
            try {
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
            } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:2812");
              return null;
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
            } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:2890");
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
        } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:2906");
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
      } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:2993");
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

        if (!directRecord && profile.location && tribeCenter) {
          let alignment = this.earlyGameVectorAlignment(
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

      const shores = Array.from(this.player.borderTiles()).filter(
        (tile) => this.game.isOceanShore(tile),
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

        const troops = this.getEarlyGameProbeTroops(
          state.settings.boatProbeFrac,
          this.getEarlyGameTerraNulliusReserveTroops(),
        );
        if (troops < 1) continue;
        if (
          this.emitBoat(
            target.tile,
            troops,
            "⛵ TerraNullius probe",
            this.game.terraNullius(),
          )
        ) {
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
      }
      return false;
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
            if (!this.game.isOceanShore(tile)) continue;
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
      try {
        return await withTimeout(
          this.game.estimateTransportRouteTicks(tile),
          WORKER_TIMEOUT_MS,
          null,
        );
      } catch (_e) {
        return null;
      }
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

      // First look for high-interest targets (unowned or bot-owned). When the
      // win-fix probe policy is active, only keep candidates whose pathfinder
      // route is inside the hard exploration-time cap.
      let dst = await this.findRandomBoatTarget(
        src,
        borderingEnemies,
        true,
        state.settings.winFixes,
      );
      if (dst === null) {
        // None found? Then look for players
        dst = await this.findRandomBoatTarget(
          src,
          borderingEnemies,
          false,
          state.settings.winFixes,
        );
        if (dst === null) {
          return;
        }
      }

      // src: game.addExecution(new TransportShipExecution(player, dst, troops)).
      // USER (winFixes): EVERY boat we send is a CHEAP 1% probe, never a big invasion
      // force. The faithful random boat sends troops/5 (20%) — which the user kept
      // seeing as "boats with lots of troops". Cap it at boatProbeFrac (1%) and
      // let the shared spendable-troop gate apply the live reserve. (winFixes off
      // → faithful troops/5.)
      const owner = this.game.owner?.(dst);
      const isTerraNullius = owner
        ? owner.isPlayer?.() !== true
        : !this.game.hasOwner?.(dst);
      const troops =
        state.settings.winFixes && isTerraNullius
          ? this.getEarlyGameProbeTroops(
              state.settings.boatProbeFrac,
              this.getEarlyGameTerraNulliusReserveTroops(),
            )
          : state.settings.winFixes
            ? this.getEarlyGameProbeTroops(state.settings.boatProbeFrac)
            : this.player.troops() / 5;
      if (troops < 1 || !(await this.allowEarlyGameBoat(dst))) return;
      const emitted = this.emitBoat(
        dst,
        troops,
        "⛵ Random boat",
        isTerraNullius ? this.game.terraNullius() : null,
      );
      if (emitted && state.settings.winFixes && isTerraNullius) {
        state.beachhead = { tile: dst, at: this.game.ticks(), surged: false };
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
            (await this.allowBoatExplorationRoute(bh.tile)) &&
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
        } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:3498");
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
        if (
          sp !== false &&
          (await this.allowBoatExplorationRoute(targets[i].tile))
        ) {
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
          if (
            sp !== false &&
            (await this.allowBoatExplorationRoute(crater))
          ) {
            dst = crater;
            dstOwned = true;
          }
        }
      }
      if (dst === null) {
        const src = this.random.randElement(shore);
        const r = await this.findRandomBoatTarget(src, [], true, true);
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
        const r2 = await this.findRandomBoatTarget(src2, [], false, true);
        if (r2 !== null && !this.boatTargetTaken(r2)) {
          dst = r2;
          dstOwned = this.game.hasOwner(r2);
        }
      }
      // FINAL FALLBACK: probe non-friendly enemy territory (nearest first) and boat
      // only to the first one whose pathfinder ETA is inside the two-minute
      // exploration cap. A merely reachable long voyage is intentionally rejected.
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

      const radioactiveTerraNullius =
        state.settings.winFixes === true && dstFallout && !dstOwned;
      const troops =
        state.settings.winFixes === true && !dstOwned
          ? this.getEarlyGameProbeTroops(
              state.settings.boatProbeFrac,
              this.getEarlyGameTerraNulliusReserveTroops(),
            )
          : this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
      if (troops < 1) return false;
      const label = dstFallout
        ? "☢️ Nuked-coast grab"
        : lowFillOk
          ? dstOwned
            ? "🏝️ Weak-coast grab"
            : "🏝️ Island grab"
          : "🛟 Probe landing";
      if (
        !(await this.allowBoatExplorationRoute(dst)) ||
        !(await this.allowEarlyGameBoat(dst))
      ) {
        return false;
      }
      if (
        this.emitBoat(
          dst,
          troops,
          label,
          !dstOwned ? this.game.terraNullius() : null,
        )
      ) {
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
      } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:3681");
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
                grab = Boolean(o &&
                  o.isPlayer() &&
                  this.player.isFriendly(o) === false &&
                  o.troops() < myTroops * weakFrac);
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
    // undefended, so this can take over a disconnected teammate's territory, but only
    // after the transport pathfinder proves the route is inside the exploration cap.
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
        } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:3788");
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
        } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:3848");
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
        if (
          sp !== false &&
          (await this.allowBoatExplorationRoute(cands[i].tile))
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

    // emitBoat — fire a TransportShipExecution at dst carrying `troops`.
    emitBoat(dst, troops, label, reserveTarget = null) {
      // Final chokepoint for the "boat" feature toggle: never fire when off.
      if (!(state.settings.features && state.settings.features.boat)) {
        return false;
      }
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
        let target = null;
        try {
          target = this.game.owner?.(dst) || null;
        } catch (_error) {
          target = null;
        }
        this.recordOutboundAttackIntent(target, safeTroops, {
          attackType: "boat",
          destination: dst,
        });
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
    async findRandomBoatTarget(
      tile,
      borderingEnemies,
      highInterestOnly = false,
      requireExplorationRoute = false,
    ) {
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
        if (
          requireExplorationRoute &&
          !(await this.allowBoatExplorationRoute(cand.tile))
        ) {
          continue;
        }
        return cand.tile;
      }
      return null;
    }

    // attackBestTarget is called with borderingFriends sorted by troops and
    // borderingEnemies sorted by Defense Post-aware attack difficulty.
    async attackBestTarget(borderingFriends, borderingEnemies) {
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
      if (this.hasNeighboringBotWithStructures()) {
        if (await this.attackBots()) return;
      }

      // Get attack strategies in priority order based on difficulty
      const strategies = this.getAttackStrategies(
        borderingFriends,
        borderingEnemies,
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
    hasNeighboringBotWithStructures() {
      return this.player
        .nearby()
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

    // Sort neighboring bots by density (troops / tiles) and attack several of
    // them when the configured parallelism allows it. Pending intents already
    // consume the shared troop budget, so each new target gets the remainder.
    // Bots that own structures are prioritized as targets (they might have stolen our structures and they will delete them!).
    // attackBots — AiAttackBehavior (private, now async).
    async attackBots() {
      let bots = this.player
        .nearby()
        .filter(
          (n) =>
            n.isPlayer() &&
            this.player.isFriendly(n) === false &&
            n.type() === PlayerType.Bot,
        );

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
      const selectedTargetKeys = this.getActiveTribeAttackTargetKeys();
      const reducedBots = sortedBots
        .filter(
          (bot) =>
            !selectedTargetKeys.has(this.getOutboundAttackTargetKey(bot)),
        )
        .slice(0, this.getBotAttackMaxParallelism());

      let launchedAttacks = 0;
      for (const bot of reducedBots) {
        if (!hasAttackIntentRateCapacity()) break;
        if (await this.sendAttack(bot, false, null, null, false, true)) {
          selectedTargetKeys.add(this.getOutboundAttackTargetKey(bot));
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

    getRadioactiveTerraNulliusFalloutDefenseMultiplier() {
      let falloutRatio = 0;
      try {
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
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:4572");
        // Older client views may not expose fallout counters; use the engine's
        // maximum defensive multiplier as the conservative fallback.
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
    // awaits it. No worker calls — a land/TN attack at half troops).
    async forceSendAttack(target, fraction = 0.5) {
      // src: game.addExecution(new AttackExecution(troops/2, player,
      //   target.isPlayer() ? target.id() : terraNullius().id())).
      // Client: emitIntent(ctors.attack, target.id()|null, troops). In win-fix
      // mode a TerraNullius opening uses the calculated one-tile loss as a
      // minimum, then commits the configured opening burst.
      this.reconcileOutboundAttackIntentCommitments();
      const ctors = discoverCtors(getEventBus());
      const isTerraNullius = target?.isPlayer?.() !== true;
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

    // sendAttack — AiAttackBehavior (now async via sendBoatAttack/
    // sendBoatAttackToNearbyTerraNullius; sendLandAttack stays sync).
    async sendAttack(
      target,
      force = false,
      minCommitFraction = null,
      earlyGameCandidate = null,
      radioactiveTerraNullius = false,
      parallelTribeAttack = false,
    ) {
      if (!force && !this.shouldAttack(target)) return false;

      const isParallelTribeAttack =
        parallelTribeAttack === true &&
        target?.isPlayer?.() === true &&
        target.type?.() === PlayerType.Bot;

      // Do not duplicate an attack against the same stale target snapshot.
      // Different targets are safe: every pending intent is already subtracted
      // from the shared spendable-troop budget. A global lock here allowed a
      // continuous tribe batch to starve all hostile land borders indefinitely.
      if (
        state.settings.winFixes &&
        !force &&
        !isParallelTribeAttack &&
        this.hasPendingOutboundAttackForTarget(target)
      ) {
        return false;
      }

      if (target.isPlayer()) {
        if (this.player.sharesBorderWith(target)) {
          return this.sendLandAttack(
            target,
            minCommitFraction,
            earlyGameCandidate,
            radioactiveTerraNullius,
            isParallelTribeAttack,
          );
        } else {
          return await this.sendBoatAttack(target, earlyGameCandidate);
        }
      } else {
        // sharesBorderWith(TerraNullius) counts water tiles as TN (ownerID 0 = TN smallID),
        // so use a land-only adjacency check to decide land vs boat attack.
        if (this.hasLandBorderWithTerraNullius()) {
          return this.sendLandAttack(
            target,
            minCommitFraction,
            null,
            radioactiveTerraNullius,
          );
        } else {
          return await this.sendBoatAttackToNearbyTerraNullius(
            radioactiveTerraNullius,
          );
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
    async sendBoatAttackToNearbyTerraNullius(radioactiveTerraNullius = false) {
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
          if (
            radioactiveTerraNullius &&
            !this.game.hasFallout?.(tile)
          ) {
            continue;
          }
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

        // USER (winFixes): maritime TerraNullius is a cheap probe, not a full
        // land-grab commitment. Fallout is still considered by the target and
        // reserve gates, but the payload stays at boatProbeFrac.
        const troops = state.settings.winFixes
          ? this.getEarlyGameProbeTroops(
              state.settings.boatProbeFrac,
              this.getEarlyGameTerraNulliusReserveTroops(),
            )
          : this.player.troops() / 5;
        if (troops < 1) return false;

        // src: game.addExecution(new TransportShipExecution(player, tile, troops)).
        if (!(await this.allowEarlyGameBoat(tile))) continue;
        const emitted = this.emitBoat(
          tile,
          troops,
          radioactiveTerraNullius
            ? "☢️ Nuked-coast grab"
            : "⛵ TerraNullius probe",
          this.game.terraNullius(),
        );
        if (emitted && state.settings.winFixes) {
          // The existing beachhead watcher checks landingSucceeded() on the next
          // cycle. Once the probe owns a tile, normal land expansion can resume.
          state.beachhead = {
            tile,
            at: this.game.ticks(),
            surged: false,
          };
        }
        return emitted;
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
      radioactiveTerraNullius = false,
      parallelTribeAttack = false,
    ) {
      this.reconcileOutboundAttackIntentCommitments();
      const maxTroops = this.game.config().maxTroops(this.player);
      const enemyDefensePostProfile = this.getEnemyDefensePostAttackProfile(
        target,
      );
      const botWithStructures =
        target.isPlayer() &&
        target.type() === PlayerType.Bot &&
        target.units(...AttackStructureTypes).some((u) => AttackStructures.has(u.type()));
      const isTribeTarget =
        target.isPlayer() && target.type() === PlayerType.Bot;
      const usesPendingIntentBudget =
        parallelTribeAttack === true && isTribeTarget;
      // Use the expand ratio when attacking a bot that owns structures — we need to
      // recapture those structures ASAP, even before reaching the normal reserve.
      const useReserve = target.isPlayer() && !botWithStructures;
      // With winFixes the acceleration peak is the sole minimum reserve. The
      // old 30–60% maxTroops target reserve could grow whenever structures
      // increased capacity and leave the bot hoarding an otherwise usable army.
      const reserveRatio = useReserve
        ? this.effectiveReserveRatio()
        : this.expandRatio;
      const targetReserveTroops = this.getEarlyGameTargetReserveTroops(target);
      const targetTroops = state.settings.winFixes
        ? targetReserveTroops
        : maxTroops * reserveRatio;
      // Fallout already raises the exact per-tile loss returned by
      // getTerraNulliusAttackTroops(). Do not cap that required loss with a
      // percentage of the current army: the cap can be smaller than one
      // radioactive tile's cost, producing an attack intent that cannot conquer
      // anything. The shared reserve and pending-intent budget remain the hard
      // safety boundary.
      const targetSpendableTroops =
        this.getEarlyGameSpendableTroops(targetReserveTroops);
      const isTerraNullius = !target.isPlayer();
      const finalSpendableTroops =
        isTerraNullius && state.settings.winFixes
          ? Math.max(
              targetSpendableTroops,
              this.getEarlyGameSpendableTroops(
                this.getTerraNulliusLivenessReserveTroops(),
              ),
            )
          : targetSpendableTroops;
      let terraNulliusCommitFraction = null;
      if (isTerraNullius && state.settings.winFixes) {
        const requestedCommitFraction =
          minCommitFraction === null ? Number.NaN : Number(minCommitFraction);
        terraNulliusCommitFraction = Number.isFinite(requestedCommitFraction)
          ? requestedCommitFraction
          : EARLY_EXPAND_COMMIT;
      }

      let troops;
      let requiredTribeAttackTroops = null;
      const botAttackTroopsSentBefore = this.botAttackTroopsSent;
      if (isTribeTarget && this.player.type() !== PlayerType.Bot) {
        // A tribe attack is only useful if it can finish the capture. Account for
        // pending outbound intents. Parallel tribal batches already have their
        // previous attacks in that pending budget, so do not subtract the local
        // counter a second time.
        const localTribeTroopsSent = usesPendingIntentBudget
          ? 0
          : this.botAttackTroopsSent;
        const availableForTribe = Math.max(
          0,
          targetSpendableTroops - localTribeTroopsSent,
        );
        troops = this.calculateBotAttackTroops(
          target,
          availableForTribe,
          enemyDefensePostProfile,
          earlyGameCandidate?.existingCommittedTroops,
        );
        requiredTribeAttackTroops = troops;
        if (requiredTribeAttackTroops < 1) {
          this.botAttackTroopsSent = botAttackTroopsSentBefore;
          return false;
        }
      } else {
        if (isTerraNullius && state.settings.winFixes) {
          troops = this.getTerraNulliusAttackTroops(
            target,
            null,
            null,
            terraNulliusCommitFraction,
          );
        } else {
          troops = this.player.troops() - targetTroops;
          // Human and Nation targets can also grow after an attack begins.
          // Once an outgoing attack is visible, reinforce it to the same 2x
          // minimum / 4x preferred live strength used for decisive tribe
          // captures instead of blindly sending the whole reserve again.
          const existingCommittedTroops = target.isPlayer()
            ? this.getLiveOutboundAttackTroopsForTarget(target)
            : 0;
          if (existingCommittedTroops > 0) {
            const defenseMultiplier = Math.max(
              1,
              Number(enemyDefensePostProfile?.attackCostMultiplier || 1),
            );
            const minimumAttackTroops =
              Math.max(0, Number(target.troops?.()) || 0) *
              2 *
              defenseMultiplier;
            const preferredAttackTroops = minimumAttackTroops * 2;
            if (
              existingCommittedTroops + targetSpendableTroops <
              minimumAttackTroops
            ) {
              return false;
            }
            troops = Math.min(
              targetSpendableTroops,
              Math.max(0, preferredAttackTroops - existingCommittedTroops),
            );
          }
        }
      }

      const baseTroops = troops;
      troops = this.applyEarlyGameRaceTroops({
        target,
        baseTroops,
        reserveTroops:
          targetTroops +
          (usesPendingIntentBudget ? 0 : botAttackTroopsSentBefore),
        earlyGameCandidate,
      });
      if (troops > baseTroops && target.type?.() === PlayerType.Bot) {
        this.botAttackTroopsSent += troops - baseTroops;
      }

      // `player.troops()` can still be the pre-attack snapshot. Clamp after
      // every policy adjustment so the reserve and all intents share one final
      // budget, including the opening/free-land burst.
      troops = Math.min(troops, finalSpendableTroops);

      // Never turn a calculated tribal assault into a weakening attack because a
      // stale snapshot or a pending intent reduced the final budget. Roll back the
      // local reservation and wait for the next decision with a larger army.
      if (
        requiredTribeAttackTroops !== null &&
        troops < requiredTribeAttackTroops
      ) {
        this.botAttackTroopsSent = botAttackTroopsSentBefore;
        return false;
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
        if (requiredTribeAttackTroops !== null) {
          this.botAttackTroopsSent = botAttackTroopsSentBefore;
        }
        return false;
      }

      if (troops < 1) {
        if (requiredTribeAttackTroops !== null) {
          this.botAttackTroopsSent = botAttackTroopsSentBefore;
        }
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
      if (requiredTribeAttackTroops !== null) {
        this.botAttackTroopsSent = botAttackTroopsSentBefore;
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
      let troops;
      if (state.settings.winFixes && earlyGameCandidate) {
        const defenseProfile = this.getEnemyDefensePostAttackProfile(target);
        troops = this.calculateBotAttackTroops(
          target,
          this.getEarlyGameSpendableTroops(
            this.getEarlyGameTargetReserveTroops(target),
          ),
          defenseProfile,
        );
      } else if (state.settings.winFixes) {
        troops = this.getEarlyGameProbeTroops(state.settings.boatProbeFrac);
      } else if (target.type() === PlayerType.Bot) {
        troops = this.calculateBotAttackTroops(target, this.player.troops() / 5);
      } else {
        troops = this.player.troops() / 5;
      }

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
      if (target.isPlayer() && this.player.type() === PlayerType.Nation) {
        if (this.emojiBehavior === undefined) throw new Error("not initialized");
        this.emojiBehavior.maybeSendAttackEmoji(target);
      }

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
      // src: `const { difficulty } = this.game.config().gameConfig();` → REPLICATED.
      const difficulty = currentDifficulty();
      const defenseMultiplier = Math.max(
        1,
        Number(defensePostProfile?.attackCostMultiplier || 1),
      );
      const minimumAttackTroops = target.troops() * 2 * defenseMultiplier;
      const committed = Math.max(0, Number(existingCommittedTroops) || 0);
      if (difficulty === Difficulty.Easy) {
        if (maxTroops + committed < minimumAttackTroops) {
          return 0;
        }
        const troops = Math.max(
          0,
          Math.min(maxTroops, minimumAttackTroops - committed),
        );
        this.botAttackTroopsSent += troops;
        return troops;
      }
      const preferredAttackTroops = target.troops() * 4 * defenseMultiplier;
      let troops = Math.max(0, preferredAttackTroops - committed);

      // Don't send more troops than maxTroops (Keep reserve)
      if (troops > maxTroops) {
        // If we haven't enough troops left to do a big enough bot attack, skip it
        if (maxTroops + committed < minimumAttackTroops) {
          troops = 0;
        } else {
          troops = maxTroops;
        }
      }
      this.botAttackTroopsSent += troops;
      return troops;
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
                featureOn: Boolean(state.settings.features.donate),
                winFixes: Boolean(state.settings.winFixes),
                replicatedDifficulty: String(currentDifficulty()),
                gameType: String(cfg.gameConfig().gameType),
                gameMode: String(cfg.gameConfig().gameMode),
                donateAllowedByLobby: cfg.donateTroops(),
                aliveTeammates: mates.length,
                myTroops: Math.round(this.player.troops()),
              }),
          );
        }
      } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:5483");
        /* ignore */
      }

      // Thin UX gate (PORT-CONTRACT donate strategy note — not a strategy change).
      if (!state.settings.features.donate) return false;

      // Being attacked is an absolute donation veto. Check the authoritative
      // player attack list directly before the broader shared invasion scan so
      // neither land pressure nor a helper-data mismatch can release troops.
      try {
        if (
          typeof this.player?.incomingAttacks === "function" &&
          this.player.incomingAttacks().length > 0
        ) {
          return false;
        }
      } catch (_error) {
        return false;
      }

      // A live enemy transport aimed at our territory is an impending maritime
      // invasion. The auto-donate module owns the shared unit/ownership scan and
      // is loaded before any engine tick; keep this strategy-driven donation on
      // the same fail-closed gate so troop production can build up to the full
      // incoming transport force.
      try {
        const maritimeInvasion =
          typeof window !== "undefined" &&
          typeof window.__OFH_getIncomingMaritimeInvasion === "function"
            ? window.__OFH_getIncomingMaritimeInvasion(this.game, this.player)
            : { active: false };
        if (!maritimeInvasion || maritimeInvasion.active === true) return false;
      } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:5516");
        return false;
      }

      // Keep the opening force available for expansion. This lives inside the
      // shared donation method so both proactive and strategy-driven donations
      // obey the same user-controlled pause.
      const expansionStatus =
        typeof getAutoDonateExpansionStatus === "function"
          ? getAutoDonateExpansionStatus(state.earlyGame)
          : { active: false, reason: null };
      if (
        state.settings.pauseDonateDuringExpansion === true &&
        expansionStatus.active === true
      ) {
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
          let underAttack = false;
          try {
            underAttack = e.teammate.incomingAttacks().length > 0;
            frontline = underAttack || e.teammate.outgoingAttacks().length > 0;
          } catch (_e) { globalThis.__OFH_RECORD_EXCEPTION__?.(_e, "engine/ingame/auto-bot/attackBehavior.js:5668");
            /* client may not expose other players' attacks → treat as rear */
          }
          return {
            entry: e,
            frontline,
            underAttack,
            distance: this.teamDonationDistance(e.teammate),
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
            (rankedNeedy[0].underAttack
              ? "(UNDER ATTACK)"
              : rankedNeedy[0].frontline
                ? "(FRONTLINE — in combat)"
                : "(rear)"),
        );
      }

      if (selectedTeammate === null) {
        console.log("[Donate] skip: no teammate below the need threshold (all allies healthy)");
        return false;
      }

      const strongestBorderOpponentTroops =
        this.getStrongestBorderOpponentTroops(true);
      if (strongestBorderOpponentTroops === null) {
        console.log("[Donate] skip: border reserve data unavailable");
        return false;
      }

      // Peaceful donations release only the surplus above the troop-production
      // peak (~42% of current capacity). Border pressure can raise that reserve;
      // active land or maritime attacks are rejected by the gates above.
      const maxTroops = this.game.config().maxTroops(this.player);
      const troopsToKeep = state.settings.winFixes
        ? this.getEarlyGameProductionReserveTroops()
        : maxTroops * this.reserveRatio;
      const currentTroops = Math.max(0, Number(this.player.troops()) || 0);
      const maxBorderDonation = Math.floor(
        currentTroops - strongestBorderOpponentTroops / 2,
      );
      if (maxBorderDonation <= 0) {
        console.log("[Donate] skip: strongest border opponent leaves no safe reserve", {
          troops: Math.round(currentTroops),
          strongestBorderOpponent: Math.round(strongestBorderOpponentTroops),
        });
        return false;
      }

      const availableTroops = currentTroops - troopsToKeep;
      const donationTroops = Math.min(
        Math.max(0, availableTroops),
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

      if (donationTroops < minExcess) {
        console.log("[Donate] skip: not enough above the keep line", {
          troops: Math.round(this.player.troops()),
          keep: Math.round(troopsToKeep),
          spendable: Math.round(donationTroops),
          needExcess: Math.round(minExcess),
        });
        return false;
      }

      // src: game.addExecution(new DonateTroopsExecution(player,
      //   selectedTeammate.id(), availableTroops)).
      // Client: emitIntent(ctors.donateTroops, recipient.__src ?? recipient, troops).
      const ctors = discoverCtors(getEventBus());
      let emitted = false;
      if (ctors.donateTroops) {
        emitted = emitIntent(
          ctors.donateTroops,
          selectedTeammate.__src ?? selectedTeammate,
          donationTroops,
        );
      } else if (typeof sendGamePacket === "function") {
        // Some client builds do not expose the Transport event constructor to
        // the EventBus scanner. Keep the same rate-limited wire path as the
        // boat macro so a valid donation is not silently dropped.
        const recipientId =
          typeof selectedTeammate.id === "function"
            ? selectedTeammate.id()
            : typeof selectedTeammate.smallID === "function"
              ? selectedTeammate.smallID()
              : null;
        if (recipientId !== null && recipientId !== undefined) {
          emitted = sendGamePacket({
            type: "donate_troops",
            recipient: recipientId,
            troops: donationTroops,
          });
        }
      }
      if (emitted) {
        this.recordOutboundDonationIntent(donationTroops);
        console.log(
          "[Donate] SENT",
          Math.round(donationTroops),
          "→",
          selectedTeammate.name?.() ?? selectedTeammate.smallID?.(),
        );
        setLastAction(tr("🎁 Donate troops"), "combat");
      } else {
        console.log("[Donate] emit failed", {
          ctor: Boolean(ctors.donateTroops),
          directFallback: typeof sendGamePacket === "function",
        });
      }

      return Boolean(emitted);
    }

    teamDonationDistance(teammate) {
      try {
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
      } catch (_error) { globalThis.__OFH_RECORD_EXCEPTION__?.(_error, "engine/ingame/auto-bot/attackBehavior.js:5823");
        return Number.POSITIVE_INFINITY;
      }
    }
  }
