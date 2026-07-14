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

(function initAutoDonate() {

  var _lastDonateTroopsMs = 0;
  var _lastDonateGoldMs = 0;
  var _troopDonationInFlight = false;
  var DONATE_COOLDOWN_MS = 3000;

  function _cfg(key, fallback) {
    try {
      if (typeof _quickPanelSettingsCache === "object" && _quickPanelSettingsCache && key in _quickPanelSettingsCache)
        return _quickPanelSettingsCache[key];
    } catch (e) {}
    return fallback;
  }

  function _parseTargets(raw) {
    if (!raw || typeof raw !== "string") return [];
    var parts = raw.split(",");
    var result = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].trim().toLowerCase();
      if (name) result.push(name);
    }
    return result;
  }

  function _matchPlayer(player, targetNames) {
    if (!player || targetNames.length === 0) return false;
    var displayName = "";
    try {
      displayName = String(
        (typeof player.displayName === "function" ? player.displayName() : null) ??
        (typeof player.name === "function" ? player.name() : null) ??
        (player.data && player.data.displayName) ??
        (player.data && player.data.name) ??
        ""
      ).toLowerCase();
    } catch (e) { return false; }
    if (!displayName) return false;
    for (var i = 0; i < targetNames.length; i++) {
      if (displayName.indexOf(targetNames[i]) !== -1) return true;
    }
    return false;
  }

  function _isInCombat(player) {
    try {
      var incoming = typeof player.incomingAttacks === "function" ? player.incomingAttacks() : [];
      var outgoing = typeof player.outgoingAttacks === "function" ? player.outgoingAttacks() : [];
      return (incoming && incoming.length > 0) || (outgoing && outgoing.length > 0);
    } catch (e) { return false; }
  }

  // Return null when the live player view cannot tell us whether an attack is
  // incoming. Troop donation fails closed in that case.
  function _isBeingAttacked(player) {
    if (!player || typeof player.incomingAttacks !== "function") return null;
    try {
      var incoming = player.incomingAttacks();
      if (!incoming) return false;
      if (typeof incoming.length === "number") return incoming.length > 0;
      if (typeof incoming.size === "number") return incoming.size > 0;
      return null;
    } catch (e) {
      return null;
    }
  }

  function _getPlayerId(player) {
    if (!player) return null;
    var keys = ["smallID", "id"];
    for (var i = 0; i < keys.length; i++) {
      try {
        var raw = typeof player[keys[i]] === "function" ? player[keys[i]]() : player[keys[i]];
        if (raw === null || raw === undefined) continue;
        var id = Number(raw);
        if (Number.isFinite(id)) return id;
      } catch (e) {}
    }
    return null;
  }

  function _getTileOwnerId(game, tile) {
    if (!game) return { known: false, id: null };

    if (typeof game.ownerID === "function") {
      try {
        var ownerId = game.ownerID(tile);
        if (ownerId !== null && ownerId !== undefined) {
          var numericOwnerId = Number(ownerId);
          if (Number.isFinite(numericOwnerId)) {
            return { known: true, id: numericOwnerId };
          }
        }
      } catch (e) {}
    }

    if (typeof game.owner === "function") {
      try {
        return { known: true, id: _getPlayerId(game.owner(tile)) };
      } catch (e) {}
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
  function _isEnemyTransport(game, me, unit) {
    var owner;
    try {
      owner = typeof unit.owner === "function" ? unit.owner() : unit.owner;
    } catch (e) {
      return null;
    }
    if (!owner) return null;

    var myId = _getPlayerId(me);
    var ownerId = _getPlayerId(owner);
    if (myId !== null && ownerId !== null && myId === ownerId) return false;

    // Reuse the boat overlay's exact relation classifier when it is available
    // in the bundled page scope. The fallback keeps this module usable on older
    // builds and in isolated tests where that overlay is not loaded.
    try {
      if (typeof getBoatPredictionRelation === "function") {
        var relation = getBoatPredictionRelation(game, unit);
        if (relation === "self" || relation === "team" || relation === "ally") return false;
        if (relation === "enemy") return true;
      }
    } catch (e) {}

    var friendlyChecks = [
      [me, "isOnSameTeam", owner],
      [me, "isAlliedWith", owner],
      [me, "isFriendly", owner],
      [owner, "isFriendly", me],
    ];
    for (var i = 0; i < friendlyChecks.length; i++) {
      try {
        var subject = friendlyChecks[i][0];
        var method = friendlyChecks[i][1];
        if (subject && typeof subject[method] === "function" && subject[method](friendlyChecks[i][2])) {
          return false;
        }
      } catch (e) {}
    }

    return true;
  }

  // Find active enemy transports whose landing tile is currently ours. The
  // overlay scan is optional and may be disabled, so the donation gate reads
  // the live unit list directly. `troops` is the total force still in flight;
  // multiple incoming transports are summed so the reserve covers the whole
  // maritime invasion. Return null when the inspection is unavailable.
  function _getIncomingMaritimeInvasion(game, me) {
    if (!game || !me || typeof game.units !== "function") return null;

    var myId = _getPlayerId(me);
    if (myId === null) return null;

    var units;
    try {
      var rawUnits =
        typeof getCachedGameUnits === "function"
          ? getCachedGameUnits(game, "Transport")
          : game.units("Transport");
      units = Array.from(rawUnits || []);
    } catch (e) {
      return null;
    }

    var incomingTroops = 0;
    var hasIncomingTroops = false;
    var hasUnknownIncomingTroops = false;

    for (var i = 0; i < units.length; i++) {
      var unit = units[i];
      if (!unit) continue;

      try {
        if (typeof unit.isActive === "function" && !unit.isActive()) continue;
        if (unit.isActive === false) continue;
        if (typeof unit.retreating === "function" && unit.retreating()) continue;
      } catch (e) {
        return null;
      }

      var rawTargetTile;
      try {
        rawTargetTile =
          typeof unit.targetTile === "function" ? unit.targetTile() : unit.targetTile;
      } catch (e) {
        return null;
      }
      var targetTile = Number(rawTargetTile);
      if (!Number.isFinite(targetTile)) continue;

      var targetOwner = _getTileOwnerId(game, targetTile);
      if (!targetOwner.known) return null;
      if (targetOwner.id === null || targetOwner.id !== myId) continue;

      var isEnemy = _isEnemyTransport(game, me, unit);
      if (isEnemy === null) return null;
      if (!isEnemy) continue;

      var rawTroops;
      try {
        rawTroops = typeof unit.troops === "function" ? unit.troops() : unit.troops;
      } catch (e) {
        rawTroops = null;
      }
      if (rawTroops === null || rawTroops === undefined) {
        hasUnknownIncomingTroops = true;
        continue;
      }

      var troopCount = Number(rawTroops);
      if (!Number.isFinite(troopCount)) {
        hasUnknownIncomingTroops = true;
      } else if (troopCount > 0) {
        hasIncomingTroops = true;
        incomingTroops += troopCount;
      }
    }

    if (hasUnknownIncomingTroops) {
      return { active: true, troops: null };
    }
    return {
      active: hasIncomingTroops,
      troops: hasIncomingTroops ? incomingTroops : 0,
    };
  }

  function _getPlayerViews(game) {
    try {
      if (typeof getCachedPlayerViews === "function") return getCachedPlayerViews(game) || [];
      if (game && typeof game.playerViews === "function") return Array.from(game.playerViews() || []);
      // Keep compatibility with older game handles used by the helper tests and
      // older OpenFront builds.
      if (game && typeof game.players === "function") return game.players() || [];
    } catch (e) {}
    return null;
  }

  function _troopPercentage(player, game) {
    try {
      var troops = Number(player.troops ? player.troops() : 0);
      var max = 1;
      if (game && typeof game.config === "function" && typeof game.config().maxTroops === "function")
        max = game.config().maxTroops(player);
      if (max <= 0) max = 1;
      return troops / max;
    } catch (e) { return 0; }
  }

  function _findTargetPlayers(game, me, targetNames, combatOnly) {
    var matches = [];
    if (!game || !me || targetNames.length === 0) return matches;
    try {
      var players = _getPlayerViews(game) || [];
      for (var i = 0; i < players.length; i++) {
        var p = players[i];
        if (!p) continue;
        try {
          if (!p.isAlive || !p.isAlive()) continue;
          var mySid = me.smallID ? me.smallID() : null;
          var pSid = p.smallID ? p.smallID() : null;
          if (mySid !== null && pSid !== null && mySid === pSid) continue;
          if (!_matchPlayer(p, targetNames)) continue;
          // If combatOnly: skip players who are at peace
          if (combatOnly && !_isInCombat(p)) continue;
          matches.push(p);
        } catch (e) {}
      }
    } catch (e) {}
    return matches;
  }

  async function _getPlayerBorderTiles(player) {
    if (!player || typeof player.borderTiles !== "function") return null;
    try {
      var result = await player.borderTiles();
      var tiles = result && result.borderTiles ? result.borderTiles : result;
      if (!tiles || typeof tiles[Symbol.iterator] !== "function") return null;
      return Array.from(tiles);
    } catch (e) {
      return null;
    }
  }

  // Return null when the live game does not expose enough map/border data to
  // enforce the reserve. The troop donation then fails closed. Alliances do not
  // remove a bordering owner from this reserve calculation.
  async function _getStrongestBorderOpponentTroops(game, me) {
    if (
      !game ||
      !me ||
      typeof me.borderTiles !== "function" ||
      typeof game.neighbors !== "function" ||
      typeof game.isLand !== "function" ||
      typeof game.hasOwner !== "function" ||
      (typeof game.ownerID !== "function" && typeof game.owner !== "function")
    ) {
      return null;
    }

    try {
      var borderTiles = await _getPlayerBorderTiles(me);
      if (!borderTiles) return null;
      var mySid = typeof me.smallID === "function" ? me.smallID() : null;
      if (mySid === null) return null;

      var borderingPlayerIds = new Set();
      for (var i = 0; i < borderTiles.length; i++) {
        var neighbors = game.neighbors(borderTiles[i]) || [];
        for (var j = 0; j < neighbors.length; j++) {
          var neighbor = neighbors[j];
          if (!game.isLand(neighbor) || !game.hasOwner(neighbor)) continue;
          var ownerSid = null;
          if (typeof game.ownerID === "function") {
            try { ownerSid = game.ownerID(neighbor); } catch (e) {}
          }
          if (ownerSid === null || ownerSid === undefined) {
            var owner = typeof game.owner === "function" ? game.owner(neighbor) : null;
            ownerSid = owner && typeof owner.smallID === "function" ? owner.smallID() : null;
          }
          if (ownerSid !== null && ownerSid !== mySid) borderingPlayerIds.add(ownerSid);
        }
      }

      var players = _getPlayerViews(game);
      if (!players) return null;
      var hasMe = false;
      for (var m = 0; m < players.length; m++) {
        if (players[m] && typeof players[m].smallID === "function" && players[m].smallID() === mySid) {
          hasMe = true;
          break;
        }
      }
      if (!hasMe) return null;
      var strongest = 0;
      var seenBorderingPlayerIds = new Set();
      for (var k = 0; k < players.length; k++) {
        var player = players[k];
        if (!player || player === me) continue;

        var playerSid = typeof player.smallID === "function" ? player.smallID() : null;
        if (playerSid === null || !borderingPlayerIds.has(playerSid)) continue;
        seenBorderingPlayerIds.add(playerSid);
        if (typeof player.isAlive !== "function") return null;
        if (!player.isAlive()) continue;

        if (typeof player.troops !== "function") return null;
        var troops = Number(player.troops());
        if (!Number.isFinite(troops)) return null;
        if (troops > strongest) strongest = troops;
      }
      for (var borderingId of borderingPlayerIds) {
        if (!seenBorderingPlayerIds.has(borderingId)) return null;
      }
      return strongest;
    } catch (e) {
      return null;
    }
  }

  function _formatGold(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  // ---- Auto-donate troops ----

  async function tickDonateTroops() {
    var enabled = _cfg("autoDonateEnabled", false);
    if (!enabled) return;
    if (_troopDonationInFlight) return;

    var now = Date.now();
    if (now - _lastDonateTroopsMs < DONATE_COOLDOWN_MS) return;

    var ctx;
    try { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); } catch (e) {}
    if (!ctx || !ctx.game) return;

    var game = ctx.game;
    var me = game.myPlayer ? game.myPlayer() : null;
    if (!me || !me.isAlive || !me.isAlive()) return;
    if (_isBeingAttacked(me) !== false) return;

    // An enemy transport already aimed at our territory is an invasion warning,
    // not ordinary combat. Keep every troop available and let production build
    // an army at least as large as the incoming transport force. Fail closed if
    // the live unit/ownership APIs cannot be inspected.
    var maritimeInvasion = _getIncomingMaritimeInvasion(game, me);
    if (!maritimeInvasion || maritimeInvasion.active) return;

    // Check if donate is allowed in this game
    try {
      var cfg = typeof game.config === "function" ? game.config() : null;
      if (cfg && typeof cfg.donateTroops === "function" && cfg.donateTroops() === false) return;
    } catch (e) {}

    var configuredKeepPct = Number(_cfg("autoDonateKeepPct", 42));
    var keepPct = Number.isFinite(configuredKeepPct) ? Math.max(42, configuredKeepPct) : 42;
    var donatePct = Number(_cfg("autoDonatePercentage", 25)) || 25;
    var targetRaw = _cfg("autoDonateTargets", "");
    var targetNames = _parseTargets(targetRaw);

    if (targetNames.length === 0) return;

    var currentTroops = Number(me.troops ? me.troops() : 0);
    var maxTroops = 1;
    try { maxTroops = typeof game.config === "function" && typeof game.config().maxTroops === "function" ? game.config().maxTroops(me) : 1; } catch (e) {}
    if (maxTroops <= 0) maxTroops = 1;

    var keepAmount = maxTroops * (keepPct / 100);
    if (currentTroops <= keepAmount) return;

    var donateAmount = Math.floor(currentTroops * (donatePct / 100));
    if (donateAmount <= 0) return;

    // Find matching teammates who are IN COMBAT (attacking or being attacked)
    var targets = _findTargetPlayers(game, me, targetNames, true);
    if (targets.length === 0) return;

    // Pick the neediest (lowest troop %) among combat targets
    var best = null;
    var bestPct = Infinity;
    for (var i = 0; i < targets.length; i++) {
      try {
        var pct = _troopPercentage(targets[i], game);
        if (pct < bestPct) { bestPct = pct; best = targets[i]; }
      } catch (e) {}
    }
    if (!best) return;

    _troopDonationInFlight = true;
    try {
      var strongestBorderOpponentTroops = await _getStrongestBorderOpponentTroops(game, me);
      if (strongestBorderOpponentTroops === null) return;

      // Re-read after the async border lookup so the reserve is based on the
      // troops available at the moment the packet is emitted.
      currentTroops = Number(me.troops ? me.troops() : 0);
      if (!Number.isFinite(currentTroops)) return;
      if (_isBeingAttacked(me) !== false) return;
      maritimeInvasion = _getIncomingMaritimeInvasion(game, me);
      if (!maritimeInvasion || maritimeInvasion.active) return;
      keepAmount = maxTroops * (keepPct / 100);
      if (currentTroops <= keepAmount) return;

      donateAmount = Math.floor(currentTroops * (donatePct / 100));
      if (donateAmount <= 0) return;

      // Keep both the configured reserve (never below 42% of max troops) and
      // at least half of the strongest live enemy army on a shared border.
      // Use fractional reserves before flooring so odd values round safely.
      var maxKeepDonation = Math.floor(currentTroops - keepAmount);
      var maxBorderDonation = Math.floor(currentTroops - strongestBorderOpponentTroops / 2);
      if (maxKeepDonation <= 0 || maxBorderDonation <= 0) return;
      var maxSafeDonation = Math.min(maxKeepDonation, maxBorderDonation);
      donateAmount = Math.min(donateAmount, maxSafeDonation);
      if (donateAmount <= 0) return;

      // Send donate packet
      var recipientId = best.id ? best.id() : (best.smallID ? best.smallID() : null);
      if (recipientId == null) return;
      sendGamePacket({ type: "donate_troops", recipient: recipientId, troops: donateAmount });
      _lastDonateTroopsMs = now;
      var name = (typeof getPlayerDisplayName === "function") ? getPlayerDisplayName(best) : "ally";
      console.log("[AutoDonate] troops", donateAmount, "→", name);
    } catch (e) {}
    finally {
      _troopDonationInFlight = false;
    }
  }

  // ---- Auto-donate gold ----

  function tickDonateGold() {
    var enabled = _cfg("autoDonateGoldEnabled", false);
    if (!enabled) return;

    var now = Date.now();
    if (now - _lastDonateGoldMs < DONATE_COOLDOWN_MS) return;

    var ctx;
    try { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); } catch (e) {}
    if (!ctx || !ctx.game) return;

    var game = ctx.game;
    var me = game.myPlayer ? game.myPlayer() : null;
    if (!me || !me.isAlive || !me.isAlive()) return;

    // Gold is part of the same emergency reserve as troops: while an enemy
    // transport is committed to our territory, keep it available for the
    // Port-first / destroyer response. Fail closed when the live transport
    // ownership scan is unavailable.
    var maritimeInvasion = _getIncomingMaritimeInvasion(game, me);
    if (!maritimeInvasion || maritimeInvasion.active) return;

    var maxGold = Number(_cfg("autoDonateGoldThreshold", 5000000)) || 5000000;
    var donatePct = Number(_cfg("autoDonateGoldPercentage", 25)) || 25;
    var targetRaw = _cfg("autoDonateGoldTargets", "");
    var targetNames = _parseTargets(targetRaw);

    if (targetNames.length === 0) return;

    var currentGold = 0;
    try { currentGold = typeof me.gold === "function" ? Number(me.gold()) : 0; } catch (e) {}
    if (currentGold <= maxGold) return;

    var donateAmount = Math.floor(currentGold * (donatePct / 100));
    if (donateAmount <= 0) return;

    // Find matching players (gold can go to allies, not just teammates)
    var targets = _findTargetPlayers(game, me, targetNames);
    if (targets.length === 0) return;

    // Pick the poorest
    var best = null;
    var bestGold = Infinity;
    for (var i = 0; i < targets.length; i++) {
      try {
        var g = typeof targets[i].gold === "function" ? Number(targets[i].gold()) : 0;
        if (g < bestGold) { bestGold = g; best = targets[i]; }
      } catch (e) {}
    }
    if (!best) return;

    var recipientId = best.id ? best.id() : (best.smallID ? best.smallID() : null);
    if (recipientId == null) return;
    try {
      sendGamePacket({ type: "donate_gold", recipient: recipientId, gold: donateAmount });
      _lastDonateGoldMs = now;
      var name = (typeof getPlayerDisplayName === "function") ? getPlayerDisplayName(best) : "ally";
      console.log("[AutoDonate] gold", _formatGold(donateAmount), "→", name);
    } catch (e) {}
  }

  // ---- Global tick entry point ----

  // AttackBehavior's strategy-driven donation runs in a sibling module loaded
  // before this file. Expose the same detector so both donation paths obey the
  // maritime-defense gate without duplicating the unit scan.
  window.__OFH_getIncomingMaritimeInvasion = function(game, me) {
    return _getIncomingMaritimeInvasion(game, me);
  };

  window.__OFH_tickAutoDonate = function() {
    var troopDonation = null;
    try {
      troopDonation = tickDonateTroops();
      if (troopDonation && typeof troopDonation.catch === "function") {
        troopDonation = troopDonation.catch(function() {});
      }
    } catch (e) {}
    try { tickDonateGold(); } catch (e) {}
    return troopDonation;
  };

})();
