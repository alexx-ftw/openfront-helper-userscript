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

  function _sosResolvePlayerBySmallId(game, smallId) {
    const players = getCachedPlayerViews(game);
    for (const p of players) {
      if (getPlayerSmallId(p, Number.NaN) === smallId) return p;
    }
    return null;
  }

  function _sosGetHostileAttackers(game, me) {
    const out = [];
    let attacks;
    try {
      attacks = me.incomingAttacks?.() || [];
    } catch (_e) {
      attacks = [];
    }
    for (const atk of attacks) {
      // Client AttackUpdate is a plain object: { troops, attackerID, targetID, ... }.
      const attackerId = Number(atk?.attackerID);
      if (!Number.isFinite(attackerId)) continue;
      const attacker = _sosResolvePlayerBySmallId(game, attackerId);
      if (!attacker) continue;
      try {
        if (me.isFriendly?.(attacker)) continue; // ignore allied "attacks"
      } catch (_e) {
        /* treat as hostile */
      }
      out.push(attacker);
    }
    return out;
  }

  function _sosGetAllies(game, me) {
    const players = getCachedPlayerViews(game);
    const allies = [];
    const mySid = getPlayerSmallId(me, Number.NaN);
    for (const p of players) {
      const sid = getPlayerSmallId(p, Number.NaN);
      if (!Number.isFinite(sid) || sid === mySid) continue;
      if (!p?.isAlive?.()) continue;
      if (isNationBotPlayer(p)) continue; // a nation bot won't come to help
      try {
        if (me.isFriendly?.(p)) allies.push(p);
      } catch (_e) {
        /* skip */
      }
    }
    return allies;
  }

  function _sosSendAllySalvo(game, me, nowMs) {
    if (nowMs - _sosLastSalvoAt < SOS_RESEND_MS) return;
    _sosLastSalvoAt = nowMs;
    const sosEmojiNum = emojiId(SOS_EMOJI);
    for (const ally of _sosGetAllies(game, me)) {
      enqueueSignal("emoji", ally, [ally, sosEmojiNum]);
    }
  }

  function _sosAttackerTargetId(attacker) {
    try {
      return attacker.id?.();
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/sos-defense.js:_sosAttackerTargetId");
      return undefined;
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

    const hostiles = _sosGetHostileAttackers(game, me);
    if (hostiles.length === 0) return;

    const nowMs = performance.now();
    _sosSendAllySalvo(game, me, nowMs);

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
