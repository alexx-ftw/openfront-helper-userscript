// Separate alliance request and renewal prompts from the main events display.

  // MessageType enum values for alliance prompts have SHIFTED across game versions and
  // the prompts themselves MOVED components (older builds: <events-display>; newer
  // builds since "Improve Notification Panel": a dedicated <actionable-events>). So we
  // never rely on one hardcoded number — we match a historical SET and fall back to a
  // structural check (see isAllianceRequestPanelEvent / isRenewAllianceEvent).
  const ALLIANCE_REQUEST_MESSAGE_TYPES = new Set([15, 16]); // incoming request
  const RENEW_ALLIANCE_MESSAGE_TYPES = new Set([22, 24]); // expiring-alliance renewal
  const ALLIANCE_PROMPT_MESSAGE_TYPES = new Set([
    ...ALLIANCE_REQUEST_MESSAGE_TYPES,
    ...RENEW_ALLIANCE_MESSAGE_TYPES,
  ]);

  const ALLIANCE_REQUEST_PANEL_CSS = `
      #${ALLIANCE_REQUEST_PANEL_ID} {
        position: fixed;
        right: max(14px, env(safe-area-inset-right, 0px));
        top: 1020px;
        z-index: 9000;
        display: none;
        width: min(258px, calc(100vw - 28px));
        max-height: min(46vh, 420px);
        overflow: hidden;
        border: 1px solid var(--oh-panel-border, rgba(148,163,184,0.34));
        border-radius: 8px;
        background: var(--oh-panel-bg, rgba(12,18,20,0.95));
        color: var(--oh-panel-text, #e2e8f0);
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 700;
        box-shadow: 0 10px 26px rgba(0,0,0,0.4), 0 0 16px var(--oh-accent-soft, rgba(96,165,250,0.15));
        pointer-events: auto;
        flex-direction: column;
      }

      #${ALLIANCE_REQUEST_PANEL_ID}[data-visible="true"] {
        display: flex;
        flex-direction: column;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-header {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 8px;
        border-bottom: 1px solid var(--oh-panel-header-border, rgba(148,163,184,0.18));
        cursor: grab;
        touch-action: none;
        flex-shrink: 0;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-header:active {
        cursor: grabbing;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-title {
        margin: 0;
        flex: 1;
        color: var(--oh-panel-text-dim, rgba(226,232,240,0.85));
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-count {
        display: grid;
        place-items: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.26);
        color: #f1f5f9;
        font-size: 10px;
        font-weight: 900;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-autorenew {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        height: 20px;
        padding: 0 7px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.05);
        color: #9ca3af;
        font: inherit;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-autorenew:hover {
        background: rgba(255, 255, 255, 0.09);
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-autorenew[data-on="true"] {
        border-color: rgba(74, 222, 128, 0.5);
        background: rgba(34, 197, 94, 0.2);
        color: #86efac;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-list {
        display: grid;
        gap: 6px;
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 7px;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-card {
        display: grid;
        gap: 6px;
        padding: 7px;
        border: 1px solid rgba(151, 181, 214, 0.18);
        border-radius: 8px;
        background: rgba(8, 31, 28, 0.82);
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-card[data-sender-type="nation"] {
        border-color: rgba(248, 113, 113, 0.34);
        background:
          linear-gradient(135deg, rgba(127, 29, 29, 0.2), transparent 54%),
          rgba(31, 24, 24, 0.84);
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-meta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        min-width: 0;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-sender-type {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 3px 6px;
        border: 1px solid rgba(248, 113, 113, 0.42);
        border-radius: 6px;
        background: rgba(69, 10, 10, 0.48);
        color: #fecaca;
        font-size: 9px;
        font-weight: 900;
        line-height: 1;
        text-transform: uppercase;
        white-space: nowrap;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-time {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 3px 6px;
        border: 1px solid rgba(125, 211, 252, 0.3);
        border-radius: 6px;
        background: rgba(14, 116, 144, 0.2);
        color: #bae6fd;
        font-size: 9px;
        font-weight: 900;
        line-height: 1;
        text-transform: uppercase;
        white-space: nowrap;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-time[data-urgency="soon"] {
        border-color: rgba(251, 191, 36, 0.42);
        background: rgba(146, 64, 14, 0.28);
        color: #fde68a;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-time[data-urgency="critical"] {
        border-color: rgba(248, 113, 113, 0.48);
        background: rgba(127, 29, 29, 0.36);
        color: #fecaca;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-description {
        flex: 1 1 160px;
        min-width: 0;
        border: 0;
        background: transparent;
        color: #f3f4f6;
        padding: 0;
        font: inherit;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.25;
        text-align: left;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} button.openfront-helper-alliance-request-description {
        cursor: pointer;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-actions button {
        border: 0;
        border-radius: 6px;
        color: #ffffff;
        padding: 5px 9px;
        font: inherit;
        font-size: 10px;
        font-weight: 900;
        cursor: pointer;
        transition:
          transform 120ms ease,
          filter 120ms ease;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-actions button:hover {
        filter: brightness(1.08);
        transform: translateY(-1px);
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-actions .btn {
        background: #16a34a;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-actions .btn-info {
        background: #3b82f6;
      }

      #${ALLIANCE_REQUEST_PANEL_ID} .openfront-helper-alliance-request-actions .btn-gray {
        background: #6b7280;
      }
      /* Tabs */
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-tabs {
        display: flex; gap: 3px; padding: 6px 8px 0; flex-shrink: 0;
        border-bottom: 1px solid var(--oh-panel-header-border, rgba(148,163,184,0.18));
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-tab {
        flex: 1; cursor: pointer; padding: 4px 0; text-align: center;
        font-size: 10px; font-weight: 700; color: var(--oh-panel-text-dim, #94a3b8);
        border-radius: 7px 7px 0 0; border: 1px solid transparent;
        border-bottom: none; transition: color 0.14s, background 0.14s;
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-tab:hover { color: var(--oh-panel-text, #e2e8f0); }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-tab.on {
        color: var(--oh-panel-text, #e2e8f0);
        background: var(--oh-accent-soft, rgba(96,165,250,0.14));
        border-color: var(--oh-accent-muted, rgba(96,165,250,0.28));
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-allies-list {
        display: grid; gap: 4px; min-height: 0; overflow: auto; padding: 7px;
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-row {
        display: flex; align-items: center; gap: 6px;
        padding: 6px 8px; border-radius: 7px;
        background: var(--oh-accent-soft, rgba(96,165,250,0.08));
        border: 1px solid transparent;
        overflow: hidden;
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-name {
        flex: 1; min-width: 0; max-width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 11px; color: var(--oh-panel-text, #e2e8f0);
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-btn {
        padding: 3px 8px; border-radius: 5px; cursor: pointer;
        font: 700 9px/1 "Aptos","Segoe UI",sans-serif; border: 1px solid transparent;
        transition: 0.12s; white-space: nowrap;
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-btn.cancel {
        color: #fca5a5; border-color: rgba(248,113,113,0.3); background: transparent;
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-btn.cancel:hover { background: rgba(248,113,113,0.15); }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-btn.auto-renew {
        color: var(--oh-panel-text-dim, #94a3b8); border-color: var(--oh-panel-border, rgba(148,163,184,0.3)); background: transparent;
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-ally-btn.auto-renew.on {
        color: var(--oh-panel-text, #e2e8f0); background: var(--oh-accent-soft, rgba(96,165,250,0.2));
        border-color: var(--oh-accent-muted, rgba(96,165,250,0.4));
      }
      #${ALLIANCE_REQUEST_PANEL_ID} .ofh-ar-empty {
        text-align: center; padding: 12px 0; font-size: 10px;
        color: var(--oh-panel-text-dim, rgba(148,163,184,0.6));
      }
    `;

  function ensureAllianceRequestPanelStyles() {
    if (document.getElementById(ALLIANCE_REQUEST_PANEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = ALLIANCE_REQUEST_PANEL_STYLE_ID;
    style.textContent = ALLIANCE_REQUEST_PANEL_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAllianceRequestPanel() {
    ensureAllianceRequestPanelStyles();

    let panel = document.getElementById(ALLIANCE_REQUEST_PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = ALLIANCE_REQUEST_PANEL_ID;
      panel.dataset.visible = "true"; // always visible when toggled on
      panel.style.display = "flex"; // force override any inherited display:none
      panel.innerHTML = `
        <div class="openfront-helper-alliance-request-header">
          <p class="openfront-helper-alliance-request-title">${tr("Alliances")}</p>
          <span class="openfront-helper-alliance-request-count">0</span>
          <button
            type="button"
            class="openfront-helper-alliance-request-autorenew"
            data-on="${runtimeState.allianceRequestsAutoRenewEnabled ? "true" : "false"}"
            title="Tự động gửi lại liên minh khi sắp hết hạn"
          >🔁 Auto</button>
        </div>
        <div class="ofh-ar-tabs">
          <div class="ofh-ar-tab on" data-tab="requests">${tr("📨 Requests")}</div>
          <div class="ofh-ar-tab" data-tab="allies">${tr("🤝 Allies")}</div>
        </div>
        <div class="openfront-helper-alliance-request-list"></div>
        <div class="ofh-ar-allies-list" style="display:none;"></div>
      `;
      (document.body || document.documentElement).appendChild(panel);

      const header = panel.querySelector(
        ".openfront-helper-alliance-request-header",
      );
      const autoRenewButton = panel.querySelector(
        ".openfront-helper-alliance-request-autorenew",
      );
      if (autoRenewButton) {
        autoRenewButton.addEventListener("click", (event) => {
          event.stopPropagation();
          setAllianceRequestsAutoRenewEnabled(
            !runtimeState.allianceRequestsAutoRenewEnabled,
          );
        });
      }
      if (header) {
        makeAllianceRequestPanelDraggable(panel, header, autoRenewButton);
      }
      // Tab switching
      panel.querySelectorAll(".ofh-ar-tab").forEach(function(tab) {
        tab.addEventListener("click", function() {
          var t = this.dataset.tab;
          panel.querySelectorAll(".ofh-ar-tab").forEach(function(el) { el.classList.toggle("on", el.dataset.tab === t); });
          panel.querySelector(".openfront-helper-alliance-request-list").style.display = t === "requests" ? "" : "none";
          panel.querySelector(".ofh-ar-allies-list").style.display = t === "allies" ? "" : "none";
          if (t === "allies") { _alliesListSignature = ""; renderAlliesList(); }
        });
      });
      applyStoredAllianceRequestPanelPosition(panel);
    }
    return panel;
  }

  function setAllianceRequestsAutoRenewEnabled(enabled) {
    runtimeState.allianceRequestsAutoRenewEnabled = Boolean(enabled);
    try {
      window.localStorage.setItem(
        ALLIANCE_REQUEST_PANEL_AUTORENEW_KEY,
        runtimeState.allianceRequestsAutoRenewEnabled ? "1" : "0",
      );
    } catch (_error) {
      // Persistence is best-effort; the toggle still works for this session.
    }
    const button = document
      .getElementById(ALLIANCE_REQUEST_PANEL_ID)
      ?.querySelector(".openfront-helper-alliance-request-autorenew");
    if (button) {
      button.dataset.on = runtimeState.allianceRequestsAutoRenewEnabled
        ? "true"
        : "false";
    }
  }

  function applyStoredAllianceRequestPanelPosition(panel) {
    let pos;
    try {
      pos = JSON.parse(
        window.localStorage.getItem(ALLIANCE_REQUEST_PANEL_POS_KEY) || "null",
      );
    } catch (_error) {
      pos = null;
    }
    if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) {
      return;
    }
    // A stored position overrides the default right/centered placement; clearing
    // the centering transform is essential or the panel renders ½-height too high.
    panel.style.transform = "none";
    panel.style.right = "auto";
    panel.style.left =
      Math.max(0, Math.min(pos.left, window.innerWidth - 60)) + "px";
    panel.style.top =
      Math.max(0, Math.min(pos.top, window.innerHeight - 30)) + "px";
  }

  function makeAllianceRequestPanelDraggable(panel, handle, ignoreEl) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    function onMove(event) {
      if (!dragging) {
        return;
      }
      const left = Math.max(
        0,
        Math.min(originLeft + (event.clientX - startX), window.innerWidth - 60),
      );
      const top = Math.max(
        0,
        Math.min(originTop + (event.clientY - startY), window.innerHeight - 30),
      );
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }

    function onUp() {
      if (!dragging) {
        return;
      }
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        window.localStorage.setItem(
          ALLIANCE_REQUEST_PANEL_POS_KEY,
          JSON.stringify({
            left: parseInt(panel.style.left, 10),
            top: parseInt(panel.style.top, 10),
          }),
        );
      } catch (_error) {
        // Ignore — the panel stays where dragged for this session regardless.
      }
    }

    handle.addEventListener("pointerdown", (event) => {
      if (ignoreEl && (event.target === ignoreEl || ignoreEl.contains(event.target))) {
        return;
      }
      dragging = true;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = event.clientX;
      startY = event.clientY;
      // Switch from the default right/centered anchor to absolute left/top, and
      // drop the centering transform so the panel tracks the pointer exactly.
      panel.style.transform = "none";
      panel.style.right = "auto";
      panel.style.left = originLeft + "px";
      panel.style.top = originTop + "px";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    });
  }

  function ensureAllianceFocusFlashStyles() {
    if (document.getElementById(ALLIANCE_FOCUS_FLASH_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = ALLIANCE_FOCUS_FLASH_STYLE_ID;
    style.textContent = `
      #${ALLIANCE_FOCUS_FLASH_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 8000;
        pointer-events: none;
      }

      #${ALLIANCE_FOCUS_FLASH_CONTAINER_ID} .${ALLIANCE_FOCUS_FLASH_CANVAS_CLASS} {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAllianceFocusFlashCanvas() {
    ensureAllianceFocusFlashStyles();

    let container = document.getElementById(ALLIANCE_FOCUS_FLASH_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = ALLIANCE_FOCUS_FLASH_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }

    let canvas = container.querySelector(`.${ALLIANCE_FOCUS_FLASH_CANVAS_CLASS}`);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = ALLIANCE_FOCUS_FLASH_CANVAS_CLASS;
      container.appendChild(canvas);
    }

    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.floor(window.innerWidth * pixelRatio));
    const height = Math.max(1, Math.floor(window.innerHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;

    return { canvas, pixelRatio };
  }

  // An event belongs in this panel only if it is an INTERACTIVE alliance prompt: an
  // incoming request (accept/reject) or an expiring-alliance renewal (renew/ignore).
  // Those ALWAYS carry action buttons; informational alliance notices (broken/expired/
  // accepted, and the "alliance request sent" confirmation <events-display> emits with
  // type 16 and no buttons) never do — so requiring buttons is what separates a prompt
  // from a notice and keeps the confirmation out of the panel.
  function isAllianceRequestPanelEvent(event) {
    if (!event || !Array.isArray(event.buttons) || event.buttons.length === 0) {
      return false;
    }
    if (ALLIANCE_PROMPT_MESSAGE_TYPES.has(Number(event.type))) {
      return true;
    }
    // Fallback for a future enum renumber: a buttoned prompt focused on a specific
    // player. Every such prompt in the game to date is an alliance request/renewal, and
    // the source we prefer (<actionable-events>) only ever holds alliance prompts.
    return Number.isFinite(Number(event.focusID));
  }

  // Renewal prompts carry an allianceID (the expiring alliance); incoming requests do
  // not — a version-robust way to tell them apart without depending on the type number.
  function isRenewAllianceEvent(event) {
    if (event && event.allianceID !== undefined && event.allianceID !== null) {
      return true;
    }
    return RENEW_ALLIANCE_MESSAGE_TYPES.has(Number(event?.type));
  }

  function getEventsDisplayElement() {
    // Newer game builds (since the "Improve Notification Panel" change) put the
    // INTERACTIVE alliance request / renewal prompts — the accept/reject/renew cards —
    // into a dedicated <actionable-events> component. Older builds kept them inside
    // <events-display>. Prefer the former and fall back to the latter so the panel
    // works on BOTH; both Lit components expose the same surface this code uses
    // (.events array, .game, .requestUpdate(), .emitGoToPlayerEvent()).
    return (
      document.querySelector("actionable-events") ||
      document.querySelector("events-display")
    );
  }

  function getAllianceFocusFlashContext(eventsDisplay) {
    const bridgeContext =
      typeof getOpenFrontGameContext === "function"
        ? getOpenFrontGameContext()
        : null;
    const game = bridgeContext?.game ?? eventsDisplay?.game ?? null;
    const transform = bridgeContext?.transform ?? null;
    if (!game || !transform?.worldToScreenCoordinates) {
      return null;
    }
    return { game, transform };
  }

  function findAllianceFocusPlayer(eventsDisplay, playerSmallId) {
    const { game } = getAllianceFocusFlashContext(eventsDisplay) ?? {};
    if (!game) {
      return null;
    }

    try {
      const player = game.playerBySmallID?.(Number(playerSmallId));
      return player?.isPlayer?.() ? player : null;
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:589");
      return null;
    }
  }

  function getAllianceFocusTileOwnerId(game, tile) {
    try {
      const ownerId = Number(game.ownerID?.(tile));
      if (Number.isFinite(ownerId)) {
        return ownerId;
      }
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:600");
      // Fall back to owner().smallID() below.
    }

    try {
      return Number(game.owner?.(tile)?.smallID?.());
    } catch (_error) {
      return NaN;
    }
  }

  function createAllianceFocusFlashMask(context, playerSmallId) {
    const { game } = context;
    const targetSmallId = Number(playerSmallId);
    if (!Number.isFinite(targetSmallId)) return null;

    const width = Math.floor(Number(game.width?.()));
    const height = Math.floor(Number(game.height?.()));
    if (!isValidAllianceMaskSize(width, height)) return null;

    const primaryMask = document.createElement("canvas");
    const secondaryMask = document.createElement("canvas");
    primaryMask.width = width;
    primaryMask.height = height;
    secondaryMask.width = width;
    secondaryMask.height = height;
    const primaryMaskContext = primaryMask.getContext("2d", { alpha: true });
    const secondaryMaskContext = secondaryMask.getContext("2d", { alpha: true });
    if (!primaryMaskContext || !secondaryMaskContext) {
      return null;
    }

    const primaryImageData = primaryMaskContext.createImageData(width, height);
    const secondaryImageData = secondaryMaskContext.createImageData(width, height);
    let hasTerritory = false;

    const paintTile = (tile) => {
      if (getAllianceFocusTileOwnerId(game, tile) !== targetSmallId) {
        return;
      }
      let x;
      let y;
      try {
        x = Number(game.x?.(tile));
        y = Number(game.y?.(tile));
      } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:649");
        return;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const offset = (y * width + x) * 4;
      const patternBand = Math.floor((x + y) / 3) % 2;
      const imageData = patternBand === 0 ? primaryImageData : secondaryImageData;
      imageData.data[offset] = patternBand === 0 ? 34 : 45;
      imageData.data[offset + 1] = patternBand === 0 ? 197 : 212;
      imageData.data[offset + 2] = patternBand === 0 ? 94 : 191;
      imageData.data[offset + 3] = 255;
      hasTerritory = true;
    };

    if (typeof game.forEachTile === "function") {
      game.forEachTile(paintTile);
    } else {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let tile;
          try {
            tile = game.ref?.(x, y);
          } catch (_error) {
            continue;
          }
          paintTile(tile);
        }
      }
    }

    if (!hasTerritory) {
      return null;
    }

    primaryMaskContext.putImageData(primaryImageData, 0, 0);
    secondaryMaskContext.putImageData(secondaryImageData, 0, 0);
    return { primaryMask, secondaryMask, transform: context.transform };
  }

  function isValidAllianceMaskSize(width, height) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  }

  function drawAllianceFocusFlashMask(ctx, maskData, pixelRatio, progress) {
    const { primaryMask, secondaryMask, transform } = maskData;
    const easedProgress = 1 - Math.pow(1 - progress, 2.4);
    const pulse = Math.sin(easedProgress * Math.PI);
    const shimmer = 0.5 + Math.sin(progress * Math.PI * 8) * 0.5;
    const fade = Math.pow(1 - progress, 0.5);
    const alpha = (0.12 + pulse * 0.38) * fade;
    const primaryAlpha = alpha * (0.72 + shimmer * 0.45);
    const secondaryAlpha = alpha * (0.72 + (1 - shimmer) * 0.45);

    let origin;
    let xAxis;
    let yAxis;
    try {
      origin = transform.worldToScreenCoordinates({ x: 0, y: 0 });
      xAxis = transform.worldToScreenCoordinates({ x: 1, y: 0 });
      yAxis = transform.worldToScreenCoordinates({ x: 0, y: 1 });
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:707");
      return;
    }

    const scaleX = Number(xAxis?.x) - Number(origin?.x);
    const scaleY = Number(yAxis?.y) - Number(origin?.y);
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
      return;
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    ctx.setTransform(
      scaleX * pixelRatio,
      0,
      0,
      scaleY * pixelRatio,
      Number(origin.x) * pixelRatio,
      Number(origin.y) * pixelRatio,
    );
    ctx.globalAlpha = primaryAlpha;
    ctx.drawImage(primaryMask, 0, 0);
    ctx.globalAlpha = secondaryAlpha;
    ctx.drawImage(secondaryMask, 0, 0);

    if (progress < 0.82) {
      ctx.globalAlpha = (0.12 + pulse * 0.18) * fade;
      ctx.filter = `brightness(${1.45 + pulse * 0.55})`;
      ctx.drawImage(primaryMask, 0, 0);
      ctx.drawImage(secondaryMask, 0, 0);
    }

    ctx.restore();
  }

  function collectAllianceFocusFlashPoints(context, playerSmallId) {
    const points = [];
    const { game, transform } = context;
    const targetSmallId = Number(playerSmallId);
    if (!Number.isFinite(targetSmallId)) {
      return points;
    }

    const bounds = getAllianceFocusBounds(game, transform);
    if (!bounds) return points;

    const { minX, maxX, minY, maxY } = bounds;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const point = getAllianceFocusFlashPoint(game, transform, targetSmallId, x, y);
        if (point) points.push(point);
      }
    }

    return points;
  }

  function getAllianceFocusBounds(game, transform) {
    let corners;
    try {
      corners = transform.screenBoundingRect?.() ?? [];
    } catch (_error) {
      return null;
    }

    const [topLeft, bottomRight] = corners;
    if (!topLeft || !bottomRight) {
      return null;
    }

    const minX = Math.max(0, Math.floor(Math.min(topLeft.x, bottomRight.x)) - 2);
    const maxX = Math.min(
      Math.max(0, game.width?.() ?? 0) - 1,
      Math.ceil(Math.max(topLeft.x, bottomRight.x)) + 2,
    );
    const minY = Math.max(0, Math.floor(Math.min(topLeft.y, bottomRight.y)) - 2);
    const maxY = Math.min(
      Math.max(0, game.height?.() ?? 0) - 1,
      Math.ceil(Math.max(topLeft.y, bottomRight.y)) + 2,
    );

    if (maxX < minX || maxY < minY) {
      return null;
    }
    return { minX, maxX, minY, maxY };
  }

  function getAllianceFocusFlashPoint(game, transform, targetSmallId, x, y) {
    try {
      const tile = game.ref?.(x, y);
      if (getAllianceFocusTileOwnerId(game, tile) !== targetSmallId) return null;
      const point = transform.worldToScreenCoordinates({ x, y });
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
      return { ...point, patternBand: Math.floor((x + y) / 3) % 2 };
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:focusPoint");
      return null;
    }
  }

  function drawAllianceFocusFlashPoints(ctx, points, pixelRatio, progress, transform) {
    const easedProgress = 1 - Math.pow(1 - progress, 2.4);
    const pulse = Math.sin(easedProgress * Math.PI);
    const shimmer = 0.5 + Math.sin(progress * Math.PI * 8) * 0.5;
    const fade = Math.pow(1 - progress, 0.5);
    const alpha = (0.16 + pulse * 0.42) * fade;
    const tileSize = Math.max(1, Number(transform?.scale) || 1) * pixelRatio;
    const size = tileSize + pulse * Math.max(1.5, tileSize * 0.38);
    const halfSize = size / 2;

    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `rgba(187, 247, 208, ${(0.2 + pulse * 0.3) * fade})`;
    ctx.lineWidth = Math.max(1, 1.2 * pixelRatio);

    for (const point of points) {
      const x = point.x * pixelRatio;
      const y = point.y * pixelRatio;
      const patternBand = point.patternBand;
      const bandShimmer = patternBand === 0 ? shimmer : 1 - shimmer;
      const patternedAlpha = alpha * (0.62 + bandShimmer * 0.42);
      ctx.fillStyle =
        patternBand === 0
          ? `rgba(34, 197, 94, ${patternedAlpha})`
          : `rgba(45, 212, 191, ${patternedAlpha})`;
      ctx.fillRect(x - halfSize, y - halfSize, size, size);
      if (progress < 0.82) {
        ctx.strokeRect(x - halfSize, y - halfSize, size, size);
      }
    }

    ctx.globalCompositeOperation = "source-over";
  }

  function flashAllianceFocusTerritory(eventsDisplay, playerSmallId) {
    if (!findAllianceFocusPlayer(eventsDisplay, playerSmallId)) {
      return;
    }

    if (runtimeState.allianceFocusFlashAnimationFrame !== null) {
      cancelAnimationFrame(runtimeState.allianceFocusFlashAnimationFrame);
      runtimeState.allianceFocusFlashAnimationFrame = null;
    }

    const startedAt = performance.now();
    const durationMs = 4200;
    const initialContext = getAllianceFocusFlashContext(eventsDisplay);
    const maskData = initialContext
      ? createAllianceFocusFlashMask(initialContext, playerSmallId)
      : null;
    let points = null;
    let pointsComputedAt = 0;

    function drawFrame(now) {
      const context = getAllianceFocusFlashContext(eventsDisplay);
      const { canvas, pixelRatio } = ensureAllianceFocusFlashCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx || !context) {
        runtimeState.allianceFocusFlashAnimationFrame = null;
        canvas.remove();
        return;
      }

      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (maskData) {
        drawAllianceFocusFlashMask(ctx, maskData, pixelRatio, progress);
      } else {
        if (!points || now - pointsComputedAt > 160) {
          points = collectAllianceFocusFlashPoints(context, playerSmallId);
          pointsComputedAt = now;
        }
        drawAllianceFocusFlashPoints(
          ctx,
          points,
          pixelRatio,
          progress,
          context.transform,
        );
      }

      if (progress < 1) {
        runtimeState.allianceFocusFlashAnimationFrame = requestAnimationFrame(drawFrame);
        return;
      }

      runtimeState.allianceFocusFlashAnimationFrame = null;
      canvas.parentElement?.remove();
    }

    runtimeState.allianceFocusFlashAnimationFrame = requestAnimationFrame(drawFrame);
  }

  function flashAllianceFocusTerritoryAfterCameraMove(eventsDisplay, playerSmallId) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        flashAllianceFocusTerritory(eventsDisplay, playerSmallId);
      });
    });
  }

  function getGameTick(eventsDisplay) {
    const ticks = Number(eventsDisplay?.game?.ticks?.());
    return Number.isFinite(ticks) ? ticks : 0;
  }

  function getAllianceRequestRemainingSeconds(eventsDisplay, event) {
    const currentTick = Number(eventsDisplay?.game?.ticks?.());
    const createdAt = Number(event?.createdAt);
    const duration = Number(event?.duration ?? 600);
    if (
      !Number.isFinite(currentTick) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(duration)
    ) {
      return null;
    }
    return Math.max(0, Math.ceil((duration - (currentTick - createdAt)) / 10));
  }

  function formatAllianceRequestRemainingTime(seconds) {
    if (!Number.isFinite(seconds)) {
      return tr("Expires soon");
    }
    if (seconds <= 0) {
      return "Expired";
    }
    if (seconds < 60) {
      return `Expires in ${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `Expires in ${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function getAllianceRequestTimeUrgency(seconds) {
    if (!Number.isFinite(seconds)) {
      return "normal";
    }
    if (seconds < 30) {
      return "critical";
    }
    if (seconds <= 60) {
      return "soon";
    }
    return "normal";
  }

  function pruneAllianceRequestPanelEvents(eventsDisplay) {
    const currentTick = getGameTick(eventsDisplay);
    let changed = false;
    for (let index = allianceRequestsPanelEvents.length - 1; index >= 0; index -= 1) {
      const event = allianceRequestsPanelEvents[index];
      const duration = Number(event?.duration ?? 600);
      const expired =
        Number.isFinite(currentTick) &&
        Number.isFinite(Number(event?.createdAt)) &&
        currentTick - Number(event.createdAt) >= duration;
      const deleted = Boolean(event?.shouldDelete?.(eventsDisplay?.game));
      if (expired || deleted) {
        event?.onDelete?.();
        allianceRequestsPanelEvents.splice(index, 1);
        changed = true;
      }
    }
    return changed;
  }

  function captureAllianceRequestPanelEvents(eventsDisplay) {
    const events = Array.isArray(eventsDisplay?.events) ? eventsDisplay.events : [];
    let changed = false;

    for (const event of events) {
      if (!isAllianceRequestPanelEvent(event) || capturedAllianceRequestEvents.has(event)) continue;
      capturedAllianceRequestEvents.add(event);
      if (isAllianceRequestFromRegularBot(event, eventsDisplay)) continue;
      allianceRequestsPanelEvents.push(event);
      changed = true;
    }

    const remainingEvents = events.filter((event) => !isAllianceRequestPanelEvent(event));
    if (remainingEvents.length !== events.length) {
      eventsDisplay.events = remainingEvents;
      eventsDisplay.requestUpdate?.();
      changed = true;
    }
    return changed;
  }

  function isAllianceRequestFromRegularBot(event, eventsDisplay) {
    try {
      const smallId = Number(event?.focusID);
      if (!Number.isFinite(smallId)) return false;
      const game = eventsDisplay?.game;
      const player = game?.playerBySmallID?.(smallId);
      return Boolean(player && isRegularBotPlayer(player));
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:regularBot");
      return false;
    }
  }

  function isRegularBotPlayer(player) {
    if (!player) return false;
    try {
      if (typeof player.type === "function" && player.type() === "BOT") return true;
      if (player.data && player.data.playerType === "BOT") return true;
    } catch (_e) {
  captureRuntimeException(_e, "engine/ingame/alliance-requests-panel.js:1019");}
    return false;
  }

  function removeAllianceRequestPanelEvent(event) {
    const index = allianceRequestsPanelEvents.indexOf(event);
    if (index >= 0) {
      allianceRequestsPanelEvents.splice(index, 1);
    }
  }

  // When auto-renew is on, confirm every renewal prompt (RENEW_ALLIANCE / type
  // 24) so expiring alliances are re-sent automatically. Uses the event's own
  // accept/renew button (the green "btn"), mirroring a manual click, then drops
  // the card. A WeakSet guards against re-firing the same event every frame and
  // against the auto-bot's doAlliance (which reads the same array) double-acting.
  // Incoming requests (type 15) are intentionally left alone — that is the
  // auto-bot's job, not this toggle's.
  function autoRenewAllianceRequestPanelEvents() {
    if (!runtimeState.allianceRequestsAutoRenewEnabled) {
      return false;
    }
    let changed = false;
    for (const event of allianceRequestsPanelEvents.slice()) {
      if (!isRenewAllianceEvent(event)) {
        continue;
      }
      if (autoRenewedAllianceEvents.has(event)) {
        continue;
      }
      const renew = getAllianceRenewButton(event);
      if (!renew) {
        continue;
      }
      autoRenewedAllianceEvents.add(event);
      let confirmed = false;
      try {
        renew.action();
        confirmed = true;
      } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:1064");
        // Leave the card in place so it can be confirmed manually; the WeakSet
        // still stops us from retrying this exact event every frame.
      }
      if (confirmed) {
        removeAllianceRequestPanelEvent(event);
        changed = true;
      }
    }
    return changed;
  }

  function getAllianceRenewButton(event) {
    const buttons = Array.isArray(event.buttons) ? event.buttons : [];
    const primary = buttons.find((button) =>
      typeof button?.action === "function" &&
      getAllianceRequestPanelButtonClass(button.className) === "btn");
    return primary || (typeof buttons[1]?.action === "function" ? buttons[1] : null);
  }

  function getAllianceRequestPanelButtonClass(className) {
    if (String(className).includes("btn-info")) {
      return "btn-info";
    }
    if (String(className).includes("btn-gray")) {
      return "btn-gray";
    }
    return "btn";
  }

  function getAllianceRequestSenderInfo(eventsDisplay, event) {
    var focusId = Number(event?.focusID);
    var result = {
      type: "unknown",
      label: "",
      color: "",
    };
    if (!Number.isFinite(focusId)) return result;

    try {
      var player = eventsDisplay?.game?.playerBySmallID?.(focusId);
      if (player?.isPlayer?.()) {
        // Add team color
        try {
          result.color = typeof getPlayerColor === "function"
            ? getPlayerColor(player, eventsDisplay?.game) || ""
            : "";
        } catch (_e) { result.color = ""; }
        if (isNationBotPlayer(player)) {
          result.type = "nation";
          result.label = tr("Nation");
        } else {
          result.type = "player";
        }
      }
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/alliance-requests-panel.js:1111");}

    return result;
  }

  function getAllianceRequestPanelRenderSignature(eventsDisplay) {
    return allianceRequestsPanelEvents
      .map((event) => {
        const remainingSeconds = getAllianceRequestRemainingSeconds(eventsDisplay, event);
        return [
          event.createdAt,
          event.type,
          event.focusID ?? "",
          event.description ?? "",
          Number.isFinite(remainingSeconds) ? remainingSeconds : "",
          Array.isArray(event.buttons) ? event.buttons.length : 0,
        ].join(":");
      })
      .join("|");
  }

  function hasAllianceRequestGame() {
    try { return Boolean(getOpenFrontGameContext()?.game); }
    catch (_error) { return false; }
  }

  function createAllianceRequestAction(buttonConfig, event, eventsDisplay) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = getAllianceRequestPanelButtonClass(buttonConfig.className);
    button.textContent = String(buttonConfig.text ?? "");
    button.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      clickEvent.preventDefault();
      if (typeof buttonConfig.action === "function") {
        try { buttonConfig.action(); } catch (error) {
          console.error("[AlliancePanel] action error:", error);
        }
      }
      if (buttonConfig.preventClose && event.focusID) {
        flashAllianceFocusTerritoryAfterCameraMove(eventsDisplay, event.focusID);
      }
      if (buttonConfig.preventClose) return;
      removeAllianceRequestPanelEvent(event);
      renderAllianceRequestPanel(eventsDisplay);
    });
    return button;
  }

  function createAllianceRequestCard(event, eventsDisplay) {
    const senderInfo = getAllianceRequestSenderInfo(eventsDisplay, event);
    const remainingSeconds = getAllianceRequestRemainingSeconds(eventsDisplay, event);
    const card = document.createElement("div");
    card.className = "openfront-helper-alliance-request-card";
    card.dataset.senderType = senderInfo.type;
    const description = document.createElement(event.focusID ? "button" : "div");
    description.className = "openfront-helper-alliance-request-description";
    description.textContent = String(event.description ?? "");
    if (senderInfo.color) description.style.color = senderInfo.color;
    if (event.focusID) {
      description.type = "button";
      description.addEventListener("click", () => {
        eventsDisplay?.emitGoToPlayerEvent?.(event.focusID);
        flashAllianceFocusTerritoryAfterCameraMove(eventsDisplay, event.focusID);
      });
    }
    const meta = document.createElement("div");
    meta.className = "openfront-helper-alliance-request-meta";
    meta.appendChild(description);
    if (senderInfo.label) {
      const senderType = document.createElement("span");
      senderType.className = "openfront-helper-alliance-request-sender-type";
      senderType.textContent = senderInfo.label;
      meta.appendChild(senderType);
    }
    const timeLeft = document.createElement("span");
    timeLeft.className = "openfront-helper-alliance-request-time";
    timeLeft.dataset.urgency = getAllianceRequestTimeUrgency(remainingSeconds);
    timeLeft.textContent = formatAllianceRequestRemainingTime(remainingSeconds);
    meta.appendChild(timeLeft);
    card.appendChild(meta);
    const buttons = Array.isArray(event.buttons) ? event.buttons : [];
    if (buttons.length > 0) {
      const actions = document.createElement("div");
      actions.className = "openfront-helper-alliance-request-actions";
      actions.append(...buttons.map((config) =>
        createAllianceRequestAction(config, event, eventsDisplay)));
      card.appendChild(actions);
    }
    return card;
  }

  function renderAllianceRequestPanel(eventsDisplay) {
    const panel = ensureAllianceRequestPanel();
    // Only show when the user is actually in a game (not in lobby/menu).
    if (!hasAllianceRequestGame()) {
      panel.dataset.visible = "false";
      panel.style.display = "none";
      return;
    }
    if (!panel.dataset.visible || panel.dataset.visible !== "true") {
      panel.dataset.visible = "true";
      panel.style.display = "flex";
    }

    const count = panel.querySelector(".openfront-helper-alliance-request-count");
    if (count) {
      count.textContent = String(allianceRequestsPanelEvents.length);
    }

    const list = panel.querySelector(".openfront-helper-alliance-request-list");
    if (!list) {
      return;
    }
    list.replaceChildren();

    list.append(...allianceRequestsPanelEvents.map((event) =>
      createAllianceRequestCard(event, eventsDisplay)));
  }

  function syncAllianceRequestPanel() {
    if (!runtimeState.allianceRequestsPanelEnabled) {
      return;
    }

    const eventsDisplay = getEventsDisplayElement();
    if (eventsDisplay) {
      captureAllianceRequestPanelEvents(eventsDisplay);
      pruneAllianceRequestPanelEvents(eventsDisplay);
      autoRenewAllianceRequestPanelEvents();
    }

    // Dirty-check: only rebuild DOM when data actually changes — not every frame.
    // Rebuilding DOM every frame destroys+recreates buttons mid-click.
    var sig = allianceRequestsPanelEvents.length + "|" + _alliesListSignature;
    if (sig !== runtimeState.allianceRequestsPanelRenderSignature) {
      runtimeState.allianceRequestsPanelRenderSignature = sig;
      renderAllianceRequestPanel(eventsDisplay);
    }
    renderAlliesList();
    runtimeState.allianceRequestsPanelAnimationFrame =
      requestAnimationFrame(syncAllianceRequestPanel);
  }

  function setAllianceRequestsPanelEnabled(enabled) {
    runtimeState.allianceRequestsPanelEnabled = Boolean(enabled);
    if (!runtimeState.allianceRequestsPanelEnabled) {
      if (runtimeState.allianceRequestsPanelAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.allianceRequestsPanelAnimationFrame);
        runtimeState.allianceRequestsPanelAnimationFrame = null;
      }
      allianceRequestsPanelEvents.splice(0, allianceRequestsPanelEvents.length);
      runtimeState.allianceRequestsPanelRenderSignature = "";
      document.getElementById(ALLIANCE_REQUEST_PANEL_ID)?.remove();
      return;
    }

    // Force first render on re-enable
    runtimeState.allianceRequestsPanelRenderSignature = "";
    if (runtimeState.allianceRequestsPanelAnimationFrame === null) {
      syncAllianceRequestPanel();
    }
  }

  var _alliesListSignature = "";
  function getAllianceListContext() {
    try {
      const context = getOpenFrontGameContext();
      if (!context?.game) return null;
      const me = context.game.myPlayer?.();
      const allies = typeof me?.allies === "function" ? me.allies() ?? [] : [];
      return { game: context.game, allies };
    } catch (error) {
      captureRuntimeException(error, "engine/ingame/alliance-requests-panel.js:getAllianceListContext");
      return null;
    }
  }

  function getAllianceAllyIdentifier(ally, fallback) {
    try {
      if (typeof ally.smallID === "function") return ally.smallID();
      if (typeof ally.id === "function") return ally.id();
      return ally.id ?? fallback;
    } catch (error) {
      captureRuntimeException(error, "engine/ingame/alliance-requests-panel.js:getAllianceAllyIdentifier");
      return fallback;
    }
  }

  function isAllianceAutoRenewEnabled(key) {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null || stored === "1";
    } catch (error) {
      captureRuntimeException(error, "engine/ingame/alliance-requests-panel.js:isAllianceAutoRenewEnabled");
      return true;
    }
  }

  function createAllianceAllyRow(ally, index, game) {
    const id = String(getAllianceAllyIdentifier(ally, `ally_${index}`));
    const autoKey = `ar-auto-${id}`;
    const row = document.createElement("div");
    row.className = "ofh-ar-ally-row";
    const name = document.createElement("span");
    name.className = "ofh-ar-ally-name";
    name.textContent = typeof getPlayerDisplayName === "function"
      ? getPlayerDisplayName(ally)
      : "?";
    try {
      name.style.color = typeof getPlayerColor === "function"
        ? getPlayerColor(ally, game) || ""
        : "";
    } catch (error) {
      captureRuntimeException(error, "engine/ingame/alliance-requests-panel.js:createAllianceAllyRow");
    }
    const autoRenew = document.createElement("button");
    autoRenew.className = "ofh-ar-ally-btn auto-renew";
    autoRenew.classList.toggle("on", isAllianceAutoRenewEnabled(autoKey));
    autoRenew.dataset.arAuto = autoKey;
    autoRenew.title = tr("Auto-renew");
    autoRenew.textContent = "🔁";
    const cancel = document.createElement("button");
    cancel.className = "ofh-ar-ally-btn cancel";
    cancel.dataset.arCancel = id;
    cancel.title = tr("Cancel alliance");
    cancel.textContent = "✕";
    row.append(name, autoRenew, cancel);
    return row;
  }

  function bindAllianceListActions(list) {
    list.querySelectorAll("[data-ar-auto]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const enabled = !button.classList.contains("on");
        button.classList.toggle("on", enabled);
        try { window.localStorage.setItem(button.dataset.arAuto, enabled ? "1" : "0"); }
        catch (error) {
          captureRuntimeException(error, "engine/ingame/alliance-requests-panel.js:bindAllianceListActions");
        }
      });
    });
    list.querySelectorAll("[data-ar-cancel]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        _cancelAllianceWith(button.dataset.arCancel);
        _alliesListSignature = "";
      });
    });
  }

  function renderAllianceListEmpty(list, signature, message) {
    if (_alliesListSignature === signature) return;
    _alliesListSignature = signature;
    list.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "ofh-ar-empty";
    empty.textContent = tr(message);
    list.appendChild(empty);
  }

  function renderAlliesList() {
    const panel = document.getElementById(ALLIANCE_REQUEST_PANEL_ID);
    const list = panel?.querySelector(".ofh-ar-allies-list");
    if (!list || list.style.display === "none") return;
    const context = getAllianceListContext();
    if (!context) {
      renderAllianceListEmpty(list, "no-game", "Waiting for game…");
      return;
    }
    const signature = context.allies
      .map((ally, index) => String(getAllianceAllyIdentifier(ally, index)))
      .join(",");
    if (signature === _alliesListSignature) return;
    if (context.allies.length === 0) {
      renderAllianceListEmpty(list, signature, "No allies yet");
      return;
    }
    _alliesListSignature = signature;
    list.replaceChildren(...context.allies.map((ally, index) =>
      createAllianceAllyRow(ally, index, context.game)));
    bindAllianceListActions(list);
  }

  // Break alliance via the WS hook — the game wire format (Transport.ts /
  // Schemas.ts BreakAllianceIntentSchema) is exactly:
  //   { type: "intent", intent: { type: "breakAlliance", recipient: <playerId> } }
  // sendGamePacket wraps our object as {type:"intent", intent:obj}, so we pass
  // just the inner intent. This needs no event-bus ctor discovery and always works.
  function _cancelAllianceWith(targetId) {
    try {
      if (typeof sendGamePacket === "function") {
        sendGamePacket({ type: "breakAlliance", recipient: targetId });
      }
    } catch(e) {
  captureRuntimeException(e, "engine/ingame/alliance-requests-panel.js:1378");}
  }
