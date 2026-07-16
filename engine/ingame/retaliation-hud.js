// Retaliation HUD — a semi-automatic nuke counter-attack panel. When you are
// hit by a nuke and have enough gold to fire back, a card appears with a "Fire"
// button. Clicking it fires the cheapest available nuke at the attacker. This is
// the manual-play counterpart to auto-nuke: it does NOT auto-fire, it asks.
// Uses the same intent API (discoverCtors / emitIntent) as auto-nuke/boat-macro.

  function ensureRetaliationStyles() {
    if (document.getElementById(RETALIATION_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = RETALIATION_STYLE_ID;
    style.textContent = `
      #${RETALIATION_CONTAINER_ID} {
        position: fixed;
        top: 18%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9000;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: max-content;
        max-width: min(520px, calc(100vw - 24px));
        pointer-events: none;
      }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-card {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 2px solid rgba(248, 113, 113, 0.9);
        border-radius: 12px;
        background: linear-gradient(180deg, rgba(60, 9, 9, 0.96), rgba(30, 6, 6, 0.96));
        color: #fee2e2;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow:
          0 18px 50px rgba(0, 0, 0, 0.55),
          0 0 30px rgba(248, 113, 113, 0.45);
        animation:
          openfront-helper-ret-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2),
          openfront-helper-ret-glow 1.2s ease-in-out infinite;
      }

      @keyframes openfront-helper-ret-in {
        from { opacity: 0; transform: translateY(-14px) scale(0.94); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes openfront-helper-ret-glow {
        0%, 100% { box-shadow: 0 18px 50px rgba(0,0,0,0.55), 0 0 22px rgba(248,113,113,0.3); }
        50% { box-shadow: 0 18px 50px rgba(0,0,0,0.55), 0 0 40px rgba(248,113,113,0.8); }
      }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-icon {
        font-size: 28px; line-height: 1;
        animation: openfront-helper-ret-shake 0.9s ease-in-out infinite;
      }
      @keyframes openfront-helper-ret-shake {
        0%, 100% { transform: rotate(-9deg); }
        50% { transform: rotate(9deg); }
      }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-title {
        font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
        text-transform: uppercase; color: #fca5a5;
      }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-msg { font-size: 15px; font-weight: 800; line-height: 1.2; }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-fire {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 8px 13px; border: 1px solid rgba(248,250,252,0.5);
        border-radius: 8px; background: rgba(248,113,113,0.92);
        color: #450a0a; font-size: 13px; font-weight: 800; cursor: pointer; white-space: nowrap;
      }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-fire:hover { background: #fecaca; }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-dismiss {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border: 1px solid rgba(248,250,252,0.25);
        border-radius: 8px; background: rgba(15,23,42,0.5);
        color: #fecaca; font-size: 14px; font-weight: 800; cursor: pointer;
      }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-dismiss:hover { background: rgba(248,113,113,0.3); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRetaliationContainer() {
    ensureRetaliationStyles();
    let c = document.getElementById(RETALIATION_CONTAINER_ID);
    if (!c) {
      c = document.createElement("div");
      c.id = RETALIATION_CONTAINER_ID;
      c.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(c);
    }
    return c;
  }

  function showRetaliationCard(attackerName, attackerPlayer) {
    const container = ensureRetaliationContainer();
    const card = document.createElement("div");
    card.className = "ofh-ret-card";

    const icon = document.createElement("div");
    icon.className = "ofh-ret-icon";
    icon.textContent = "☢";

    const body = document.createElement("div");
    body.className = "ofh-ret-body";
    const title = document.createElement("div");
    title.className = "ofh-ret-title";
    title.textContent = tr("Nuke incoming");
    const msg = document.createElement("div");
    msg.className = "ofh-ret-msg";
    msg.textContent = tr("Retaliate against {name}?", { name: attackerName });
    body.appendChild(title);
    body.appendChild(msg);

    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "ofh-ret-fire";
    focus.textContent = `🎯 ${tr("Focus")}`;

    let focused = false;
    focus.addEventListener("click", () => {
      if (focused) return;
      focused = true;
      focusOnAttacker(attackerPlayer);
      card.remove();
    });

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ofh-ret-dismiss";
    dismiss.textContent = "✕";
    dismiss.title = tr("Dismiss");
    dismiss.addEventListener("click", () => card.remove());

    // Auto-dismiss after 15s.
    window.setTimeout(() => { if (!focused) card.remove(); }, 15000);

    card.appendChild(icon);
    card.appendChild(body);
    card.appendChild(focus);
    card.appendChild(dismiss);
    container.appendChild(card);
  }

  function focusOnAttacker(attackerPlayer) {
    try {
      if (!attackerPlayer) return;
      const context = getOpenFrontGameContext();
      if (!context?.game) return;
      const game = context.game;
      const targetId = getRetaliationPlayerId(attackerPlayer);
      if (targetId == null) return;
      const nukes = game.units("Atom Bomb", "Hydrogen Bomb");
      for (const unit of nukes) {
        if (!isActiveRetaliationNuke(unit) || getRetaliationPlayerId(getRetaliationOwner(unit)) !== targetId) continue;
        const tile = unit.tile?.();
        if (tile == null || typeof game.x !== "function" || typeof game.y !== "function") continue;
        _centerCameraOnTile(game.x(tile), game.y(tile));
        return;
      }
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/retaliation-hud.js:focusOnAttacker");
    }
  }

  function getRetaliationOwner(unit) {
    try { return unit?.owner?.() || null; } catch (_error) { return null; }
  }

  function getRetaliationPlayerId(player) {
    try { return player?.smallID?.() ?? null; } catch (_error) { return null; }
  }

  function getRetaliationUnitType(unit) {
    try { return unit?.type?.() || ""; } catch (_error) { return ""; }
  }

  function isActiveRetaliationNuke(unit) {
    try {
      return Boolean(unit?.isActive?.()) && getRetaliationUnitType(unit) !== "MIRV Warhead";
    } catch (_error) {
      return false;
    }
  }

  function isGoToPositionListener(ctor, callbacks) {
    if (ctor?.name === "GoToPositionEvent") return true;
    if (!Array.isArray(callbacks)) return false;
    return callbacks.some((callback) => {
      if (typeof callback !== "function") return false;
      const source = callback.toString();
      return source.includes("onGoToPosition") || source.includes("GoToPositionEvent");
    });
  }

  // Camera jump (same as silo-sam-tracker)
  function _centerCameraOnTile(x, y) {
    try {
      var overlay = document.querySelector("player-info-overlay");
      if (!overlay || !overlay.eventBus) return;
      var bus = overlay.eventBus;
      if (!bus.listeners || typeof bus.listeners.entries !== "function") return;
      for (const [ctor, callbacks] of bus.listeners.entries()) {
        if (!ctor || !isGoToPositionListener(ctor, callbacks)) continue;
        try { bus.emit(new ctor(x, y)); } catch (error) {
          captureRuntimeException(error, "engine/ingame/retaliation-hud.js:centerCamera");
        }
        return;
      }
    } catch (e) {
      captureRuntimeException(e, "engine/ingame/retaliation-hud.js:centerCamera");
    }
  }

  // One-shot latch per nuke-hit: fires once per distinct nuke that hits us.
  const _retaliationSeenHits = new Set();

  function getRetaliationGame() {
    try {
      return getOpenFrontGameContext()?.game || null;
    } catch (_error) {
      return null;
    }
  }

  function isHostileNukeTargetingMe(unit, game, me) {
    if (!isActiveRetaliationNuke(unit)) return false;
    const owner = getRetaliationOwner(unit);
    if (!owner) return false;
    try { if (me.isFriendly?.(owner)) return false; } catch (_error) { /* hostile fallback */ }
    const targetTile = unit.targetTile?.();
    if (targetTile === undefined) return false;
    try {
      return !game.ownerID || game.ownerID(targetTile) === me.smallID();
    } catch (_error) { return false; }
  }

  function processIncomingRetaliationNukes(game, me) {
    for (const unit of game.units("Atom Bomb", "Hydrogen Bomb")) {
      if (!isHostileNukeTargetingMe(unit, game, me)) continue;
      const targetTile = unit.targetTile?.();
      const hitKey = `${unit.id?.() ?? targetTile}`;
      if (_retaliationSeenHits.has(hitKey)) continue;
      _retaliationSeenHits.add(hitKey);
      const owner = getRetaliationOwner(unit);
      let attackerName = "?";
      try { attackerName = getPlayerDisplayName?.(owner) || owner?.name?.() || "?"; } catch (_error) { /* fallback */ }
      showRetaliationCard(attackerName, owner);
    }
  }

  function pruneRetaliationHits(game) {
    if (_retaliationSeenHits.size === 0) return;
    const activeIds = new Set(game.units("Atom Bomb", "Hydrogen Bomb", "MIRV Warhead")
      .map((unit) => unit?.id?.()).filter((id) => id != null).map(String));
    for (const id of _retaliationSeenHits) if (!activeIds.has(id)) _retaliationSeenHits.delete(id);
  }

  function checkRetaliation() {
    if (!runtimeState.retaliationEnabled) return;
    const game = getRetaliationGame();
    const me = game?.myPlayer?.();
    if (!game || !me) return;
    try { processIncomingRetaliationNukes(game, me); } catch (error) {
      captureRuntimeException(error, "engine/ingame/retaliation-hud.js:incoming");
    }
    try { pruneRetaliationHits(game); } catch (error) {
      captureRuntimeException(error, "engine/ingame/retaliation-hud.js:prune");
    }
  }

  function setRetaliationEnabled(enabled) {
    runtimeState.retaliationEnabled = Boolean(enabled);
    if (!runtimeState.retaliationEnabled) {
      if (runtimeState.retaliationInterval !== null) {
        window.clearInterval(runtimeState.retaliationInterval);
        runtimeState.retaliationInterval = null;
      }
      _retaliationSeenHits.clear();
      document.getElementById(RETALIATION_CONTAINER_ID)?.remove();
      return;
    }
    if (runtimeState.retaliationInterval === null) {
      runtimeState.retaliationInterval = window.setInterval(checkRetaliation, 800);
    }
  }
