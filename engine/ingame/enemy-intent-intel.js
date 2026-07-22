// Enemy-intent early warning — intercepts WebSocket messages to detect incoming
// attacks/boats BEFORE they appear in the game state (incomingAttacks()). Hooks
// window.WebSocket to listen for "turn" and "start" messages containing
// turn.intents[] arrays.
//
// This is a DATA LAYER only (no rendering). Warnings are consumed by the
// attack-highlight overlay and the advisor panel via getEnemyIntentWarnings().
//
// The hook is lightweight: it only parses the small intents[] array from each
// turn message, not the full game state.

  const ENEMY_INTENT_TTL_MS = 15000; // warning lifetime
  const ENEMY_INTENT_LOG_COOLDOWN_MS = 3000;

  // Map: attackerKey -> { kind, attackerID, attackerName, troops, dstX, dstY, atMs }
  const _enemyIntentWarnings = new Map();
  const _enemyIntentLogCooldowns = new Map();
  let _enemyIntentHookInstalled = false;

  function enemyIntentRead(label, read, fallback) {
    {
      return read();
    }
  }

  function enemyIntentPlayerName(player, fallback) {
    if (!player) return fallback;
    if (typeof getPlayerDisplayName === "function") {
      const displayName = getPlayerDisplayName(player);
      if (displayName) return displayName;
    }
    const name = typeof player.name === "function" ? player.name() : player.name;
    return name || fallback;
  }

  function resolveAttackerName(attackerID) {
    const context = enemyIntentRead("context", () => getOpenFrontGameContext(), null);
    const fallback = `p${attackerID}`;
    if (!context?.game) return fallback;
    const direct = context.game.playerBySmallID?.(Number(attackerID));
    if (direct) return enemyIntentPlayerName(direct, fallback);
    const players = getCachedPlayerViews(context.game);
    for (let i = 0; i < players.length; i += 1) {
      const p = players[i];
      if (getPlayerSmallId(p, Number.NaN) === Number(attackerID)) {
        return enemyIntentPlayerName(p, fallback);
      }
    }
    return fallback;
  }

  function installEnemyIntentHook() {
    // NOTE: We do NOT patch window.WebSocket — the game uses binary frames and
    // patching breaks the connection ("game is starting" hang). Instead we poll
    // the game's incomingAttacks() API via registerHelperTickListener, which is
    // the same data source attack-highlight uses but we expose it as a reusable
    // data layer with TTL-based warnings.
    if (_enemyIntentHookInstalled) return;
    _enemyIntentHookInstalled = true;
    if (typeof registerHelperTickListener === "function") {
      registerHelperTickListener(enemyIntentPollTick);
    }
  }

  function uninstallEnemyIntentHook() {
    if (typeof unregisterHelperTickListener === "function") {
      unregisterHelperTickListener(enemyIntentPollTick);
    }
    _enemyIntentWarnings.clear();
    _enemyIntentLogCooldowns.clear();
    _enemyIntentHookInstalled = false;
  }

  // Poll incomingAttacks() every 250ms (same cadence as the helper tick) and
  // update warnings. This replaces the fragile WebSocket hook with the same
  // data the game already exposes.
  function isFriendlyIncomingAttacker(game, me, attackerID) {
    return enemyIntentRead("friendly-attacker", () => {
      const attacker = game.playerBySmallID ? game.playerBySmallID(attackerID) : null;
      return Boolean(attacker && me.isFriendly && me.isFriendly(attacker));
    }, false);
  }

  function updateIncomingAttackWarning(attack, now) {
    const attackerID = attack.attackerID;
    const key = `sid:${attackerID}`;
    const existing = _enemyIntentWarnings.get(key);
    const troops = Math.max(0, Number(attack.troops) || 0);
    if (existing) {
      existing.troops = troops;
      existing.atMs = now;
      return;
    }
    _enemyIntentWarnings.set(key, {
      kind: "attack",
      attackerID,
      attackerName: resolveAttackerName(attackerID),
      troops,
      atMs: now,
      dstX: null,
      dstY: null,
    });
  }

  function isRetreatingIncomingAttack(attack) {
    if (!attack) return false;
    const retreating =
      typeof attack.retreating === "function"
        ? attack.retreating()
        : attack.retreating;
    return retreating === true;
  }

  function removeInactiveEnemyIntentWarnings(activeHostileAttackers) {
    for (const [key, warning] of _enemyIntentWarnings) {
      if (!activeHostileAttackers.has(warning.attackerID)) {
        _enemyIntentWarnings.delete(key);
      }
    }
  }

  function enemyIntentPollTick() {
    if (!runtimeState.enemyIntentEnabled) return;
    const context = enemyIntentRead("context", () => getOpenFrontGameContext(), null);
    if (!context?.game) return;
    const me = context.game.myPlayer ? context.game.myPlayer() : null;
    if (!me) return;
    const atks = enemyIntentRead(
      "incoming-attacks",
      () => (me.incomingAttacks ? me.incomingAttacks() : null),
      null,
    );
    if (!atks) return;
    const now = performance.now();
    const activeHostileAttackers = new Map();
    pruneEnemyIntentWarnings(now);
    for (let i = 0; i < atks.length; i += 1) {
      const a = atks[i];
      if (!a || isRetreatingIncomingAttack(a)) continue;
      const attackerID = a.attackerID;
      if (attackerID == null) continue;
      if (isFriendlyIncomingAttacker(context.game, me, attackerID)) continue;
      const troops = Math.max(0, Number(a.troops) || 0);
      activeHostileAttackers.set(
        attackerID,
        (activeHostileAttackers.get(attackerID) || 0) + troops,
      );
    }
    for (const [attackerID, troops] of activeHostileAttackers) {
      updateIncomingAttackWarning({ attackerID, troops }, now);
    }
    // The current poll is authoritative. Resolved, withdrawn, and newly
    // friendly attacks must stop warning immediately rather than after 15s.
    removeInactiveEnemyIntentWarnings(activeHostileAttackers);
  }

  function pruneEnemyIntentWarnings(now = performance.now()) {
    for (const [key, warning] of _enemyIntentWarnings) {
      if (now - warning.atMs > ENEMY_INTENT_TTL_MS) {
        _enemyIntentWarnings.delete(key);
      }
    }
  }

  // Public API: consumed by attack-highlight overlay and advisor panel.
  function getEnemyIntentWarnings() {
    pruneEnemyIntentWarnings();
    const out = [];
    for (const warning of _enemyIntentWarnings.values()) {
      out.push(warning);
    }
    return out.sort((a, b) => b.troops - a.troops);
  }

  function getActiveEnemyIntentWarning() {
    pruneEnemyIntentWarnings();
    let best = null;
    for (const warning of _enemyIntentWarnings.values()) {
      if (!best || warning.troops > best.troops) best = warning;
    }
    return best;
  }

  function setEnemyIntentEnabled(enabled) {
    runtimeState.enemyIntentEnabled = Boolean(enabled);
    if (runtimeState.enemyIntentEnabled) {
      installEnemyIntentHook();
    } else {
      uninstallEnemyIntentHook();
    }
  }
