// TN2 — When the local player is under attack, send an SOS emoji to allies /
// teammates and mark each attacker via SendTargetPlayerIntentEvent (rallies allies
// in their HUD; costs -40 relation with the attacker, acceptable since it is
// already attacking us). Standalone module — runs whether or not the auto-bot is
// on. All sends go through the shared signal scheduler (rate-limit-safe).

  const SOS_EMOJI = "🆘";
  const SOS_RESEND_MS = 12000; // resend the SOS salvo at most this often while attacked
  const SOS_TARGET_RESEND_MS = 16000; // re-mark the same attacker at most this often (> game 15s target cooldown)

  let sosDefenseEnabled = false;
  let _sosLastSalvoAt = 0;
  const _sosLastTargetAt = new Map(); // attacker smallID -> ms

  function _sosPlayersBySmallId(players) {
    const bySmallId = new Map();
    for (const p of players) {
      const smallId = getPlayerSmallId(p, Number.NaN);
      if (Number.isFinite(smallId)) bySmallId.set(smallId, p);
    }
    return bySmallId;
  }

  function _sosAttackIsRetreating(attack) {
    const retreating =
      typeof attack?.retreating === "function"
        ? attack.retreating()
        : attack?.retreating;
    return retreating === true;
  }

  function _sosGetHostileAttackers(game, me, players = null) {
    const out = [];
    const seen = new Set();
    let playerViews = players;
    let playersBySmallId = null;
    let attacks;
    {
      attacks = me.incomingAttacks?.() || [];
    }
    for (const atk of attacks) {
      if (_sosAttackIsRetreating(atk)) continue;
      // Client AttackUpdate is a plain object: { troops, attackerID, targetID, ... }.
      const attackerId = Number(atk?.attackerID);
      if (!Number.isFinite(attackerId) || seen.has(attackerId)) continue;
      seen.add(attackerId);
      if (playerViews === null) playerViews = getCachedPlayerViews(game);
      if (playersBySmallId === null) {
        playersBySmallId = _sosPlayersBySmallId(playerViews);
      }
      const attacker = playersBySmallId.get(attackerId) || null;
      if (!attacker) continue;
      {
        if (me.isFriendly?.(attacker)) continue; // ignore allied "attacks"
      }
      out.push(attacker);
    }
    return { hostiles: out, players: playerViews };
  }

  function _sosGetAllies(game, me, players = null) {
    const playerViews = players ?? getCachedPlayerViews(game);
    const allies = [];
    const mySid = getPlayerSmallId(me, Number.NaN);
    for (const p of playerViews) {
      const sid = getPlayerSmallId(p, Number.NaN);
      if (!Number.isFinite(sid) || sid === mySid) continue;
      if (!p?.isAlive?.()) continue;
      if (isNationBotPlayer(p)) continue; // a nation bot won't come to help
      {
        if (me.isFriendly?.(p)) allies.push(p);
      }
    }
    return allies;
  }

  function _sosSendAllySalvo(game, me, nowMs, players = null) {
    if (_sosLastSalvoAt > 0 && nowMs - _sosLastSalvoAt < SOS_RESEND_MS) return;
    const allies = _sosGetAllies(game, me, players);
    if (allies.length === 0) return;
    _sosLastSalvoAt = nowMs;
    const sosEmojiNum = emojiId(SOS_EMOJI);
    for (const ally of allies) {
      enqueueSignal("emoji", ally, [ally, sosEmojiNum]);
    }
  }

  function _sosAttackerTargetId(attacker) {
    {
      return attacker.id?.();
    }
  }

  function _sosMarkAttacker(attacker, nowMs) {
    const smallId = getPlayerSmallId(attacker, Number.NaN);
    if (!Number.isFinite(smallId)) return;
    const lastMarkedAt = _sosLastTargetAt.get(smallId);
    if (
      lastMarkedAt !== undefined &&
      nowMs - lastMarkedAt < SOS_TARGET_RESEND_MS
    ) {
      return;
    }
    _sosLastTargetAt.set(smallId, nowMs);
    const targetId = _sosAttackerTargetId(attacker);
    if (targetId !== undefined) enqueueSignal("target", attacker, [targetId]);
  }

  function updateSosDefense() {
    if (!sosDefenseEnabled) return;
    const context = getOpenFrontGameContext();
    const game = context?.game || null;
    if (!game) return;
    const me = game.myPlayer?.();
    if (!me || !me.isAlive?.()) return;

    const { hostiles, players } = _sosGetHostileAttackers(game, me);
    if (hostiles.length === 0) return;

    const nowMs = performance.now();
    _sosSendAllySalvo(game, me, nowMs, players);

    // 2) Mark each hostile attacker — throttled per-target.
    for (const attacker of hostiles) {
      _sosMarkAttacker(attacker, nowMs);
    }
  }

  function setSosDefenseEnabled(enabled) {
    sosDefenseEnabled = Boolean(enabled);
    if (!sosDefenseEnabled) {
      unregisterHelperTickListener(updateSosDefense);
      _sosLastSalvoAt = 0;
      _sosLastTargetAt.clear();
      return;
    }
    registerHelperTickListener(updateSosDefense);
  }
