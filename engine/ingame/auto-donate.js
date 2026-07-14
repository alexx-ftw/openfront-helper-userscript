// Auto-donate engine — troops and gold to named players.
// Settings-driven: reads thresholds, percentages, and target player names from
// Quick Panel settings cache. Runs on the shared helper tick (1s interval).
//
// Troop logic:  if currentTroops > maxTroops * (keepPct/100) → donate a
// percentage of current troops, capped so we retain at least half the largest
// live enemy army sharing our border.
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

  function _isFriendly(me, player) {
    try {
      if (typeof me.isFriendly === "function") return Boolean(me.isFriendly(player));
    } catch (e) {}
    try {
      if (player && typeof player.isFriendly === "function") return Boolean(player.isFriendly(me));
    } catch (e) {}
    return null;
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
  // enforce the reserve. The troop donation then fails closed.
  async function _getStrongestBorderOpponentTroops(game, me) {
    if (
      !game ||
      !me ||
      typeof me.borderTiles !== "function" ||
      typeof game.neighbors !== "function" ||
      typeof game.isLand !== "function" ||
      typeof game.hasOwner !== "function" ||
      typeof game.owner !== "function"
    ) {
      return null;
    }

    try {
      var borderTiles = await _getPlayerBorderTiles(me);
      if (!borderTiles) return null;
      var mySid = typeof me.smallID === "function" ? me.smallID() : null;
      if (mySid === null) return null;

      var borderingOpponentIds = new Set();
      for (var i = 0; i < borderTiles.length; i++) {
        var neighbors = game.neighbors(borderTiles[i]) || [];
        for (var j = 0; j < neighbors.length; j++) {
          var neighbor = neighbors[j];
          if (!game.isLand(neighbor) || !game.hasOwner(neighbor)) continue;
          var owner = game.owner(neighbor);
          var ownerSid = owner && typeof owner.smallID === "function" ? owner.smallID() : null;
          if (ownerSid !== null && ownerSid !== mySid) borderingOpponentIds.add(ownerSid);
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
      for (var k = 0; k < players.length; k++) {
        var player = players[k];
        if (!player || player === me) continue;

        var playerSid = typeof player.smallID === "function" ? player.smallID() : null;
        if (playerSid === null || !borderingOpponentIds.has(playerSid)) continue;
        if (!player.isAlive || !player.isAlive()) continue;

        var friendly = _isFriendly(me, player);
        if (friendly === null) return null;
        if (friendly) continue;

        var troops = Number(typeof player.troops === "function" ? player.troops() : 0);
        if (Number.isFinite(troops) && troops > strongest) strongest = troops;
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

    // Check if donate is allowed in this game
    try {
      var cfg = typeof game.config === "function" ? game.config() : null;
      if (cfg && typeof cfg.donateTroops === "function" && cfg.donateTroops() === false) return;
    } catch (e) {}

    var keepPct = Number(_cfg("autoDonateKeepPct", 40)) || 40;
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
      keepAmount = maxTroops * (keepPct / 100);
      if (currentTroops <= keepAmount) return;

      donateAmount = Math.floor(currentTroops * (donatePct / 100));
      if (donateAmount <= 0) return;

      // Keep at least half of the strongest live enemy army on a shared border.
      // Use the fractional half before flooring so odd troop counts still round
      // toward the safer reserve.
      var maxSafeDonation = Math.floor(currentTroops - strongestBorderOpponentTroops / 2);
      if (maxSafeDonation <= 0) return;
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
