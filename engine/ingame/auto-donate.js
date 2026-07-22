// Auto-donate engine — troops and gold to named players.
// Settings-driven: reads thresholds, percentages, and target player names from
// Quick Panel settings cache. Runs on the shared helper tick (1s interval).
//
// Troop logic:  if currentTroops > maxTroops * (keepPct/100) → donate a
// percentage of current troops, capped so we retain at least 42% of max troops
// and at least half the largest live non-self army sharing our border. Never
// donate while we are being attacked; alliances do not remove a border owner
// from the reserve calculation.
// Gold logic:   if currentGold > maxGoldThreshold → donate (currentGold * donatePct/100)
//
// Target matching: comma-separated player names (case-insensitive, includes clan tags).

  var autoDonateTroopDonationInFlight = false;
  var lastAutoDonationByRecipientMs = new Map();

  function setTroopDonationInFlight(value) {
    autoDonateTroopDonationInFlight = value;
  }

  function autoDonationRecipientIsReady(player, now = Date.now()) {
    const recipient = getAutoDonateRecipientId(player);
    if (recipient == null) return false;
    const lastDonation = lastAutoDonationByRecipientMs.get(recipient);
    return lastDonation === undefined || now - lastDonation >= DONATE_COOLDOWN_MS;
  }

  function markAutoDonationRecipient(player, now = Date.now()) {
    const recipient = getAutoDonateRecipientId(player);
    if (recipient != null) lastAutoDonationByRecipientMs.set(recipient, now);
  }

  // Engine Config.donateCooldown() is 100 ticks at 10 ticks/second.
  var DONATE_COOLDOWN_MS = 10000;

  function autoDonateCfg(key, fallback) {
    {
      if (typeof _quickPanelSettingsCache === "object" && _quickPanelSettingsCache && key in _quickPanelSettingsCache)
        return _quickPanelSettingsCache[key];
    }
    return fallback;
  }

  function parseAutoDonateTargets(raw) {
    if (!raw || typeof raw !== "string") return [];
    var parts = raw.split(",");
    var result = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].trim().toLowerCase();
      if (name) result.push(name);
    }
    return result;
  }

  function matchesAutoDonatePlayer(player, targetNames) {
    if (!player || targetNames.length === 0) return false;
    var displayName;
    {
      displayName = String(
        (typeof player.displayName === "function" ? player.displayName() : null) ??
        (typeof player.name === "function" ? player.name() : null) ??
        (player.data && player.data.displayName) ??
        (player.data && player.data.name) ??
        ""
      ).toLowerCase();
    }
    if (!displayName) return false;
    for (var i = 0; i < targetNames.length; i++) {
      if (displayName.indexOf(targetNames[i]) !== -1) return true;
    }
    return false;
  }

  function isAutoDonateCombatAttackActive(attack) {
    if (!attack) return false;
    if (typeof attack.retreating === "function") return attack.retreating() !== true;
    return attack.retreating !== true;
  }

  function isAutoDonateTargetInCombat(player) {
    var incoming = typeof player.incomingAttacks === "function" ? player.incomingAttacks() : [];
    var outgoing = typeof player.outgoingAttacks === "function" ? player.outgoingAttacks() : [];
    return [incoming, outgoing].some(
      (attacks) => Array.isArray(attacks) && attacks.some(isAutoDonateCombatAttackActive),
    );
  }

  // Return null when the live player view cannot tell us whether an attack is
  // incoming. Troop donation fails closed in that case.
  function isAutoDonatePlayerBeingAttacked(player) {
    if (!player || typeof player.incomingAttacks !== "function") return null;
    var incoming = player.incomingAttacks();
    if (!incoming) return false;
    if (Array.isArray(incoming)) return incoming.some(isAutoDonateCombatAttackActive);
    if (typeof incoming[Symbol.iterator] === "function") {
      return Array.from(incoming).some(isAutoDonateCombatAttackActive);
    }
    return null;
  }

  function getAutoDonatePlayerId(player) {
    if (!player) return null;
    var keys = ["smallID", "id"];
    for (var i = 0; i < keys.length; i++) {
      {
        var raw = typeof player[keys[i]] === "function" ? player[keys[i]]() : player[keys[i]];
        if (raw === null || raw === undefined) continue;
        var id = Number(raw);
        if (Number.isFinite(id)) return id;
      }
    }
    return null;
  }

  function getAutoDonateTileOwnerId(game, tile) {
    if (!game) return { known: false, id: null };

    if (typeof game.ownerID === "function") {
      {
        var ownerId = game.ownerID(tile);
        if (ownerId !== null && ownerId !== undefined) {
          var numericOwnerId = Number(ownerId);
          if (Number.isFinite(numericOwnerId)) {
            return { known: true, id: numericOwnerId };
          }
        }
      }
    }

    if (typeof game.owner === "function") {
      {
        return { known: true, id: getAutoDonatePlayerId(game.owner(tile)) };
      }
    }

    return {
      known: typeof game.ownerID === "function" || typeof game.owner === "function",
      id: null,
    };
  }

  // Return true for an enemy transport, false for our/team/allied transport,
  // and null when the owner relation cannot be established. This is deliberately
  // conservative: an unknown owner must not reopen troop donations during a
  // possible landing.
  function getAutoDonateUnitOwner(unit) {
    {
      return typeof unit.owner === "function" ? unit.owner() : unit.owner;
    }
  }

  function getAutoDonateBoatRelation(game, unit) {
    {
      return typeof getBoatPredictionRelation === "function"
        ? getBoatPredictionRelation(game, unit)
        : null;
    }
  }

  function hasAutoDonateFriendlyRelation(me, owner) {
    const checks = [
      [me, "isOnSameTeam", owner], [me, "isAlliedWith", owner],
      [me, "isFriendly", owner], [owner, "isFriendly", me],
    ];
    for (const [subject, method, other] of checks) {
      {
        if (typeof subject?.[method] === "function" && subject[method](other)) return true;
      }
    }
    return false;
  }

  function isAutoDonateEnemyTransport(game, me, unit) {
    const owner = getAutoDonateUnitOwner(unit);
    if (!owner) return null;
    const myId = getAutoDonatePlayerId(me);
    const ownerId = getAutoDonatePlayerId(owner);
    if (myId !== null && ownerId !== null && myId === ownerId) return false;
    const relation = getAutoDonateBoatRelation(game, unit);
    if (["self", "team", "ally"].includes(relation)) return false;
    if (relation === "enemy") return true;
    return !hasAutoDonateFriendlyRelation(me, owner);
  }

  function getAutoDonateTransportTarget(unit) {
    {
      const raw = typeof unit.targetTile === "function" ? unit.targetTile() : unit.targetTile;
      const tile = Number(raw);
      return Number.isFinite(tile) ? tile : null;
    }
  }

  function getAutoDonateTransportTroops(unit) {
    {
      const raw = typeof unit.troops === "function" ? unit.troops() : unit.troops;
      if (raw === null || raw === undefined) return null;
      const troops = Number(raw);
      return Number.isFinite(troops) ? troops : null;
    }
  }

  function isActiveAutoDonateTransport(unit) {
    {
      if (typeof unit?.isActive === "function" && !unit.isActive()) return false;
      if (unit?.isActive === false) return false;
      // UnitView exposes naval withdrawal through transportShipState(), not
      // AttackUpdate.retreating(). A retreating transport can remain active
      // while sailing home, so isActive() alone would keep a cancelled landing
      // in the maritime reserve and unnecessarily freeze allied donations.
      const transportState =
        typeof unit?.transportShipState === "function"
          ? unit.transportShipState()
          : unit?.transportShipState;
      if (transportState?.isRetreating === true) return false;

      // Retain compatibility with raw/older adapters that surfaced the attack
      // flag directly on the unit.
      const retreating =
        typeof unit?.retreating === "function"
          ? unit.retreating()
          : unit?.retreating;
      return retreating !== true;
    }
  }

  function inspectAutoDonateTransport(game, me, myId, unit) {
    const active = isActiveAutoDonateTransport(unit);
    if (active === null) return { unknown: true };
    if (!active) return { ignored: true };
    const targetTile = getAutoDonateTransportTarget(unit);
    if (targetTile === null) return { ignored: true };
    const targetOwner = getAutoDonateTileOwnerId(game, targetTile);
    if (!targetOwner.known) return { unknown: true };
    if (targetOwner.id !== myId) return { ignored: true };
    const enemy = isAutoDonateEnemyTransport(game, me, unit);
    if (enemy === null) return { unknown: true };
    if (!enemy) return { ignored: true };
    const troops = getAutoDonateTransportTroops(unit);
    return troops === null ? { incoming: true, unknownTroops: true } : { incoming: true, troops };
  }

  // Find active enemy transports whose landing tile is currently ours. The
  // overlay scan is optional and may be disabled, so the donation gate reads
  // the live unit list directly. `troops` is the total force still in flight;
  // multiple incoming transports are summed so the reserve covers the whole
  // maritime invasion. Return null when the inspection is unavailable.
  function getAutoDonateMaritimeInvasion(game, me) {
    if (!game || !me || typeof game.units !== "function") return null;

    var myId = getAutoDonatePlayerId(me);
    if (myId === null) return null;

    var units;
    {
      var rawUnits =
        typeof getCachedGameUnits === "function"
          ? getCachedGameUnits(game, "Transport")
          : game.units("Transport");
      units = Array.from(rawUnits || []);
    }

    const inspections = units.filter(Boolean)
      .map((unit) => inspectAutoDonateTransport(game, me, myId, unit));
    if (inspections.some((result) => result.unknown)) return null;
    const incoming = inspections.filter((result) => result.incoming);
    if (incoming.some((result) => result.unknownTroops)) return { active: true, troops: null };
    const incomingTroops = incoming.reduce((sum, result) => sum + Math.max(0, result.troops), 0);
    return {
      active: incomingTroops > 0,
      troops: incomingTroops,
    };
  }

  function getAutoDonatePlayerViews(game) {
    {
      if (typeof getCachedPlayerViews === "function") return getCachedPlayerViews(game) || [];
      if (game && typeof game.playerViews === "function") return Array.from(game.playerViews() || []);
      // Keep compatibility with older game handles used by the helper tests and
      // older OpenFront builds.
      if (game && typeof game.players === "function") return game.players() || [];
    }
    return null;
  }

  function getAutoDonateTroopPercentage(player, game) {
    {
      var troops = Number(player.troops ? player.troops() : 0);
      var max = 1;
      if (game && typeof game.config === "function" && typeof game.config().maxTroops === "function")
        max = game.config().maxTroops(player);
      if (max <= 0) max = 1;
      return troops / max;
    }
  }

  function canAutoDonateToPlayer(me, player, donationKind) {
    if (!hasAutoDonateFriendlyRelation(me, player)) return false;
    const capability = donationKind === "gold" ? "canDonateGold" : "canDonateTroops";
    return typeof me?.[capability] !== "function" || me[capability](player) === true;
  }

  function isEligibleAutoDonateTarget(player, me, targetNames, combatOnly, donationKind) {
    {
      if (!player?.isAlive?.()) return false;
      const myId = getAutoDonatePlayerId(me);
      const playerId = getAutoDonatePlayerId(player);
      if (myId !== null && playerId !== null && myId === playerId) return false;
      if (!matchesAutoDonatePlayer(player, targetNames)) return false;
      if (!canAutoDonateToPlayer(me, player, donationKind)) return false;
      if (!autoDonationRecipientIsReady(player)) return false;
      return !combatOnly || isAutoDonateTargetInCombat(player);
    }
  }

  function findAutoDonateTargetPlayers(
    game,
    me,
    targetNames,
    combatOnly = false,
    donationKind = "troops",
  ) {
    if (!game || !me || targetNames.length === 0) return [];
    const players = getAutoDonatePlayerViews(game);
    if (!players) return [];
    return players.filter((player) =>
      isEligibleAutoDonateTarget(player, me, targetNames, combatOnly, donationKind));
  }

  async function getAutoDonatePlayerBorderTiles(player) {
    if (!player || typeof player.borderTiles !== "function") return null;
    {
      var result = await player.borderTiles();
      var tiles = result && result.borderTiles ? result.borderTiles : result;
      if (!tiles || typeof tiles[Symbol.iterator] !== "function") return null;
      return Array.from(tiles);
    }
  }

  function hasAutoDonateBorderApi(game, me) {
    return Boolean(game && me && typeof me.borderTiles === "function" &&
      typeof game.neighbors === "function" && typeof game.isLand === "function" &&
      typeof game.hasOwner === "function" &&
      (typeof game.ownerID === "function" || typeof game.owner === "function"));
  }

  function collectAutoDonateBorderingPlayerIds(game, borderTiles, myId) {
    const ids = new Set();
    for (const borderTile of borderTiles) {
      for (const neighbor of game.neighbors(borderTile) || []) {
        if (!game.isLand(neighbor) || !game.hasOwner(neighbor)) continue;
        const owner = getAutoDonateTileOwnerId(game, neighbor);
        if (!owner.known) return null;
        if (owner.id !== null && owner.id !== myId) ids.add(owner.id);
      }
    }
    return ids;
  }

  function getAutoDonateBorderOpponentTroops(players, borderingIds, myId) {
    if (!players.some((player) => getAutoDonatePlayerId(player) === myId)) return null;
    const seen = new Set();
    let strongest = 0;
    for (const player of players) {
      const playerId = getAutoDonatePlayerId(player);
      if (playerId === null || !borderingIds.has(playerId)) continue;
      seen.add(playerId);
      if (typeof player.isAlive !== "function" || typeof player.troops !== "function") return null;
      if (!player.isAlive()) continue;
      const troops = Number(player.troops());
      if (!Number.isFinite(troops)) return null;
      strongest = Math.max(strongest, troops);
    }
    return [...borderingIds].every((id) => seen.has(id)) ? strongest : null;
  }

  // Return null when the live game does not expose enough map/border data to
  // enforce the reserve. The troop donation then fails closed. Alliances do not
  // remove a bordering owner from this reserve calculation.
  async function getAutoDonateStrongestBorderOpponentTroops(game, me) {
    if (!hasAutoDonateBorderApi(game, me)) return null;
    {
      const borderTiles = await getAutoDonatePlayerBorderTiles(me);
      if (!borderTiles) return null;
      const mySid = getAutoDonatePlayerId(me);
      if (mySid === null) return null;
      const borderingPlayerIds = collectAutoDonateBorderingPlayerIds(game, borderTiles, mySid);
      if (!borderingPlayerIds) return null;
      const players = getAutoDonatePlayerViews(game);
      if (!players) return null;
      return getAutoDonateBorderOpponentTroops(players, borderingPlayerIds, mySid);
    }
  }

  function formatAutoDonateGold(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function getAutoDonateGameContext() {
    {
      return typeof getOpenFrontGameContext === "function"
        ? getOpenFrontGameContext()
        : null;
    }
  }

  function getAutoDonateLivingPlayer(game) {
    const player = game?.myPlayer?.();
    return player?.isAlive?.() ? player : null;
  }

  function gameAllowsTroopDonation(game) {
    {
      const config = game?.config?.();
      return typeof config?.donateTroops !== "function" || config.donateTroops() !== false;
    }
  }

  function gameAllowsGoldDonation(game) {
    const config = game?.config?.();
    return typeof config?.donateGold !== "function" || config.donateGold() !== false;
  }

  function getAutoDonateMaxTroops(game, player) {
    {
      const maxTroops = Number(game?.config?.().maxTroops?.(player));
      return Number.isFinite(maxTroops) && maxTroops > 0 ? maxTroops : 1;
    }
  }

  function findNeediestAutoDonateTarget(targets, game) {
    return targets.map((player) => ({
      player,
      percentage: getAutoDonateTroopPercentage(player, game),
    })).sort((a, b) => a.percentage - b.percentage)[0]?.player ?? null;
  }

  function getAutoDonateRecipientId(player) {
    {
      if (typeof player?.id === "function") return player.id();
      if (typeof player?.smallID === "function") return player.smallID();
      return null;
    }
  }

  function getAutoDonatePlayerName(player) {
    return typeof getPlayerDisplayName === "function"
      ? getPlayerDisplayName(player)
      : "ally";
  }

  function hasNoAutoDonateMaritimeThreat(game, player) {
    const maritime = getAutoDonateMaritimeInvasion(game, player);
    return Boolean(maritime && !maritime.active);
  }

  function createTroopDonationPlan() {
    if (!autoDonateCfg("autoDonateEnabled", false)) return null;
    const context = getAutoDonateGameContext();
    if (!context?.game) return null;
    const game = context.game;
    const me = getAutoDonateLivingPlayer(game);
    if (!me || isAutoDonatePlayerBeingAttacked(me) !== false) return null;
    if (!hasNoAutoDonateMaritimeThreat(game, me) || !gameAllowsTroopDonation(game)) return null;
    const targetNames = parseAutoDonateTargets(autoDonateCfg("autoDonateTargets", ""));
    if (targetNames.length === 0) return null;
    const configuredKeep = Number(autoDonateCfg("autoDonateKeepPct", 42));
    const keepPct = Number.isFinite(configuredKeep) ? Math.max(42, configuredKeep) : 42;
    const donatePct = Number(autoDonateCfg("autoDonatePercentage", 25)) || 25;
    const maxTroops = getAutoDonateMaxTroops(game, me);
    const currentTroops = Number(me.troops?.() ?? 0);
    if (currentTroops <= maxTroops * keepPct / 100) return null;
    const targets = findAutoDonateTargetPlayers(game, me, targetNames, true, "troops");
    const recipient = findNeediestAutoDonateTarget(targets, game);
    return recipient ? { game, me, recipient, keepPct, donatePct, maxTroops } : null;
  }

  function getSafeAutoDonateTroops(plan, borderOpponentTroops) {
    const currentTroops = Number(plan.me.troops?.() ?? 0);
    if (!Number.isFinite(currentTroops)) return 0;
    if (isAutoDonatePlayerBeingAttacked(plan.me) !== false) return 0;
    const maritime = getAutoDonateMaritimeInvasion(plan.game, plan.me);
    if (!maritime || maritime.active) return 0;
    const keepAmount = plan.maxTroops * plan.keepPct / 100;
    if (currentTroops <= keepAmount) return 0;
    const requested = Math.floor(currentTroops * plan.donatePct / 100);
    const keepLimit = Math.floor(currentTroops - keepAmount);
    const borderLimit = Math.floor(currentTroops - borderOpponentTroops / 2);
    return Math.max(0, Math.min(requested, keepLimit, borderLimit));
  }

  function sendAutoDonateTroops(plan, amount) {
    const recipient = getAutoDonateRecipientId(plan.recipient);
    if (recipient == null || amount <= 0) return false;
    if (!autoDonationRecipientIsReady(plan.recipient)) return false;
    sendGamePacket({ type: "donate_troops", recipient, troops: amount });
    markAutoDonationRecipient(plan.recipient);
    runtimeDebugLog(
      "[AutoDonate] troops", amount, "→", getAutoDonatePlayerName(plan.recipient),
    );
    return true;
  }

  // ---- Auto-donate troops ----

  async function tickAutoDonateTroops() {
    if (autoDonateTroopDonationInFlight) return;
    const plan = createTroopDonationPlan();
    if (!plan) return;
    setTroopDonationInFlight(true);
    try {
      const borderTroops = await getAutoDonateStrongestBorderOpponentTroops(plan.game, plan.me);
      if (borderTroops !== null) {
        sendAutoDonateTroops(plan, getSafeAutoDonateTroops(plan, borderTroops));
      }
    } finally {
      setTroopDonationInFlight(false);
    }
  }

  // ---- Auto-donate gold ----

  function getAutoDonatePlayerGold(player) {
    {
      return typeof player?.gold === "function" ? Number(player.gold()) : 0;
    }
  }

  function findPoorestAutoDonateTarget(targets) {
    return targets.map((player) => ({ player, gold: getAutoDonatePlayerGold(player) }))
      .sort((a, b) => a.gold - b.gold)[0]?.player ?? null;
  }

  function createGoldDonationPlan() {
    if (!autoDonateCfg("autoDonateGoldEnabled", false)) return null;
    const context = getAutoDonateGameContext();
    if (!context?.game) return null;
    const game = context.game;
    const me = getAutoDonateLivingPlayer(game);
    if (!me) return null;
    if (!gameAllowsGoldDonation(game)) return null;
    if (!hasNoAutoDonateMaritimeThreat(game, me)) return null;
    const targetNames = parseAutoDonateTargets(autoDonateCfg("autoDonateGoldTargets", ""));
    if (targetNames.length === 0) return null;
    const currentGold = getAutoDonatePlayerGold(me);
    const maxGold = Number(autoDonateCfg("autoDonateGoldThreshold", 5000000)) || 5000000;
    if (currentGold <= maxGold) return null;
    const donatePct = Number(autoDonateCfg("autoDonateGoldPercentage", 25)) || 25;
    const amount = Math.floor(currentGold * donatePct / 100);
    if (amount <= 0) return null;
    const targets = findAutoDonateTargetPlayers(game, me, targetNames, false, "gold");
    const recipient = findPoorestAutoDonateTarget(targets);
    return recipient ? { recipient, amount } : null;
  }

  function tickAutoDonateGold() {
    // Troops are the combat-critical transfer. Let their asynchronous border
    // reserve check finish before gold competes for the recipient cooldown.
    if (autoDonateTroopDonationInFlight) return;
    const now = Date.now();
    const plan = createGoldDonationPlan();
    if (!plan) return;
    const recipient = getAutoDonateRecipientId(plan.recipient);
    if (recipient == null) return;
    if (!autoDonationRecipientIsReady(plan.recipient, now)) return;
    {
      sendGamePacket({ type: "donate_gold", recipient, gold: plan.amount });
      markAutoDonationRecipient(plan.recipient, now);
      runtimeDebugLog(
        "[AutoDonate] gold", formatAutoDonateGold(plan.amount),
        "→", getAutoDonatePlayerName(plan.recipient),
      );
    }
  }

  // ---- Global tick entry point ----

  // The broad signal is kept for donation/attack strategy callers: an incoming
  // land attack must also stop troop outflow. Structure/warship/nuke callers
  // use the transport-only signal below so a land attack cannot freeze their
  // maritime construction path.
  window.__OFH_getIncomingMaritimeInvasion = function(game, me) {
    var maritime = getAutoDonateMaritimeInvasion(game, me);
    var incomingAttack = isAutoDonatePlayerBeingAttacked(me);
    if (incomingAttack === false) return maritime;
    return {
      active: true,
      troops: typeof maritime?.troops === "number" ? maritime.troops : null,
      reason: incomingAttack === true ? "incoming-attack" : "incoming-attack-unknown",
    };
  };

  // Construction and warship policy need the actual maritime transport scan,
  // not the broad donation/combat pause above.
  window.__OFH_getIncomingMaritimeTransport = function(game, me) {
    return getAutoDonateMaritimeInvasion(game, me);
  };

  window.__OFH_tickAutoDonate = function() {
    const troopDonation = tickAutoDonateTroops();
    tickAutoDonateGold();
    return troopDonation;
  };
