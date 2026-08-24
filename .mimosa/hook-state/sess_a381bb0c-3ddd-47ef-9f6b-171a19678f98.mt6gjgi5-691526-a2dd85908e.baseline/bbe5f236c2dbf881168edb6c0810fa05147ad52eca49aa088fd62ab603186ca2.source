// Advisor intel — shared, synchronous computations over the client GameView /
// PlayerView, ported from OpenFront Tactical Assistant's advisor modules
// (troop-economy, threat-model, player-metrics). This is a self-contained library
// (functions only, no load-time side effects); overlays (threat icons, weak/danger
// dots) and the advisor panel consume it.
//
// It is deliberately DECOUPLED from the auto-bot: it reads the raw client views
// directly (game.myPlayer(), getCachedPlayerViews, player.troops()/gold()/…), it
// does NOT touch the 1:1 Nation-AI port. Formulas mirror the Tactical spec; places
// that need async border/neighbour data (adjacency, exact per-player gold rate)
// are marked // SIMPLIFIED and noted for later.

  const ADV_ATOM_COST = 750000; // Atom Bomb gold cost (Tactical ATOM_COST)
  const ADV_HYDROGEN_COST = 5000000; // Hydrogen Bomb (Tactical HYDROGEN_COST)
  const ADV_PEAK_RATIO = 0.42; // growth-rate peak troops/max (Tactical PEAK_RATIO)

  // troops/max bands — first band with currentRatio < max wins (Tactical STATES).
  const ADV_ECO_STATES = [
    { state: "CRITICAL", max: 0.18, floor: 0.42 },
    { state: "RECOVER", max: 0.3, floor: 0.36 },
    { state: "GROWTH_PEAK", max: 0.5, floor: 0.34 },
    { state: "READY", max: 0.65, floor: 0.34 },
    { state: "PUSH", max: 0.82, floor: 0.3 },
    { state: "CAP_WASTE", max: 1.01, floor: 0.25 },
  ];

  function advClamp01(v) {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function advGoldNumber(player) {
    {
      if (typeof getPlayerGoldNumber === "function") {
        return getPlayerGoldNumber(player);
      }
      const g = player.gold ? player.gold() : 0;
      return typeof g === "bigint" ? Number(g) : Number(g) || 0;
    }
  }

  // Client attacks are plain objects: {troops, attackerID, targetID,
  // retreating, id}. Keep their defensive parsing in one place.
  function advAttackTroopSum(player, method, attackerSmallId = null) {
    let sum = 0;
    {
      const attacks = typeof player?.[method] === "function" ? player[method]() : [];
      for (const attack of attacks || []) {
        if (!attack || attack.retreating) continue;
        if (attackerSmallId != null && attack.attackerID !== attackerSmallId) continue;
        sum += Number(attack.troops) || 0;
      }
    }
    return sum;
  }

  // Sum of a player's outgoing (non-retreating) attack troops.
  function advTroopsInCombat(player) {
    return advAttackTroopSum(player, "outgoingAttacks");
  }

  function advIncomingTroops(me) {
    return advAttackTroopSum(me, "incomingAttacks");
  }

  function advIncomingFromSmallId(me, attackerSmallId) {
    return advAttackTroopSum(me, "incomingAttacks", attackerSmallId);
  }

  function advMaxTroops(game, player) {
    {
      const c = game.config ? game.config() : null;
      if (c && typeof c.maxTroops === "function") {
        const m = Number(c.maxTroops(player));
        if (Number.isFinite(m) && m > 0) {
          return m;
        }
      }
    }
    return 0;
  }

  function advTroops(player) {
    {
      return Number(player.troops ? player.troops() : 0) || 0;
    }
  }

  function advTiles(player) {
    {
      return Number(player.numTilesOwned ? player.numTilesOwned() : 0) || 0;
    }
  }

  // Owners of Missile Silos still under construction — the "buildingNuke" set
  // (Tactical enemyNukeBuilders). Excludes my own / allied silos at the call site.
  function advNukeBuilderIds(game) {
    const set = new Set();
    {
      const silos = game.units ? game.units("Missile Silo") : [];
      for (const u of silos) {
        if (!u || !u.isUnderConstruction || !u.isUnderConstruction()) {
          continue;
        }
        const owner = u.owner ? u.owner() : null;
        if (owner && owner.smallID) {
          set.add(owner.smallID());
        }
      }
    }
    return set;
  }

  // Tactical growthRate(cur,max): the game's troop-growth model. 0 at/above max.
  function advGrowthRate(cur, max) {
    if (max <= 0 || cur >= max) {
      return 0;
    }
    return (10 + Math.pow(Math.max(0, cur), 0.73) / 4) * (1 - cur / max);
  }

  function advSaturate(v, scale) {
    if (v <= 0) return 0;
    return Math.tanh(v / Math.max(1e-4, scale));
  }

  function advEconomyBand(currentRatio) {
    for (const band of ADV_ECO_STATES) {
      if (currentRatio < band.max) return band;
    }
    return ADV_ECO_STATES[ADV_ECO_STATES.length - 1];
  }

  function advTimeToPush(game, currentTroops, maxTroops) {
    const target = 0.45 * maxTroops;
    if (currentTroops >= target) return null;
    let troops = currentTroops;
    let ticks = 0;
    while (troops < target && ticks < 6000) {
      const growth = advGrowthRate(troops, maxTroops);
      if (growth <= 0) break;
      troops += growth;
      ticks += 1;
    }
    const msPerTick =
      typeof ofhGameMsPerTick === "function"
        ? ofhGameMsPerTick(game, 100)
        : Number(game?.config?.().msPerTick?.()) || 100;
    return troops >= target ? Math.round((ticks * msPerTick) / 1000) : null;
  }

  // ── Self troop-economy (Tactical evaluateTroopEconomy, self-only slice) ──
  // Returns { currentTroops, maxTroops, currentRatio, growthEfficiency,
  //           combatSafety, safePush, safeSpendableTroops, recommendedReserve,
  //           state, stateFloor, timeToPushSec } or null.
  function advEvaluateSelfEconomy(game, me) {
    const maxTroops = advMaxTroops(game, me);
    const currentTroops = advTroops(me);
    if (maxTroops <= 0 || currentTroops < 0) {
      return null;
    }
    const currentRatio = advClamp01(currentTroops / maxTroops);
    const band = advEconomyBand(currentRatio);
    const rate = advGrowthRate(currentTroops, maxTroops);
    const peakRate = advGrowthRate(ADV_PEAK_RATIO * maxTroops, maxTroops);
    const growthEfficiency = peakRate > 0 ? advClamp01(rate / peakRate) : 0;

    const incoming = advIncomingTroops(me);
    // combatSafety: 1 - (incoming + effective hostile-neighbour troops)/maxTroops.
    // SIMPLIFIED: without cheap neighbour detection on the client we use incoming
    // pressure only; enemy standing armies are folded in via per-player threats
    // shown separately. (Tactical also adds hostile-neighbour effective troops.)
    const combatSafety = advClamp01(1 - incoming / Math.max(1, maxTroops));
    const safePush = incoming === 0 && combatSafety >= 0.78;

    // Recommended reserve: state floor, dropped when safe to push.
    const recommendedReserve = safePush
      ? Math.max(0.2, Math.min(band.floor, band.floor - 0.16))
      : band.floor;
    const safeSpendableTroops = Math.max(
      0,
      currentTroops - maxTroops * recommendedReserve,
    );

    // ETA to a 0.45*max push window by summing growthRate per tick (10 ticks/s).
    const timeToPushSec = advTimeToPush(game, currentTroops, maxTroops);

    return {
      currentTroops,
      maxTroops,
      currentRatio,
      growthEfficiency,
      combatSafety,
      safePush,
      recommendedReserve,
      safeSpendableTroops,
      state: band.state,
      stateFloor: band.floor,
      timeToPushSec,
    };
  }

  // ── Per-player threat (Tactical threat-model). classify → Weak/Neutral/
  // Dangerous/Critical. nukeCapable/buildingNuke are exact; adjacency is
  // SIMPLIFIED to false (no cheap client border-adjacency), so scores skew a
  // touch low for far players — the classification thresholds still separate the
  // genuinely strong. Returns { score, level, nukeCapable, buildingNuke,
  //   directAttackTroops }.
  function advEvaluateThreat(game, me, player, nukeBuilders) {
    const myTroops = Math.max(1, advTroops(me));
    const myTiles = Math.max(1, advTiles(me));
    const pTroops = advTroops(player);
    const pTiles = advTiles(player);
    const gold = advGoldNumber(player);

    const troopsRatio = pTroops / myTroops;
    const tilesRatio = pTiles / myTiles;
    const outgoing = advTroopsInCombat(player);
    const activeAttackPressure = outgoing / Math.max(1, pTroops || 1);
    const directAttackTroops = advIncomingFromSmallId(
      me,
      player.smallID ? player.smallID() : -1,
    );
    const directAttackRatio = directAttackTroops / myTroops;

    const atomCost =
      typeof ofhGameUnitCost === "function"
        ? ofhGameUnitCost(game, player, "Atom Bomb", ADV_ATOM_COST)
        : ADV_ATOM_COST;
    const hydrogenCost =
      typeof ofhGameUnitCost === "function"
        ? ofhGameUnitCost(game, player, "Hydrogen Bomb", ADV_HYDROGEN_COST)
        : ADV_HYDROGEN_COST;
    let nukePotential = 0;
    if (gold >= hydrogenCost) nukePotential = 2;
    else if (gold >= atomCost) nukePotential = 1;
    const buildingNuke = Boolean(nukeBuilders &&
      player.smallID &&
      nukeBuilders.has(player.smallID()));

    let score =
      advSaturate(troopsRatio, 2.4) * 0.42 +
      advSaturate(tilesRatio, 3.5) * 0.18 +
      advSaturate(activeAttackPressure, 0.55) * 0.08 +
      advSaturate(directAttackRatio, 1.1) * 0.5 +
      nukePotential * 0.18;
    if (buildingNuke) score += 0.55;
    // SIMPLIFIED: adjacency unknown → use the distant multiplier (0.65) baseline.
    score *= 0.65;

    let level = "Weak";
    if (score >= 1.35) level = "Critical";
    else if (score >= 0.95) level = "Dangerous";
    else if (score >= 0.55) level = "Neutral";

    return {
      score,
      level,
      nukeCapable: nukePotential > 0,
      buildingNuke,
      directAttackTroops,
    };
  }
