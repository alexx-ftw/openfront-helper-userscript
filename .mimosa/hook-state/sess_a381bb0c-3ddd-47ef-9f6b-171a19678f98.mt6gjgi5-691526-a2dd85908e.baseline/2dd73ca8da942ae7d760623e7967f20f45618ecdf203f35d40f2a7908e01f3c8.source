// Gold-per-minute overlays, helper stat badges, and team/top income tracking.

  function ensureHelperStatsContainerStyles() {
    if (document.getElementById(HELPER_STATS_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = HELPER_STATS_STYLE_ID;
    style.textContent = `
      #${HELPER_STATS_CONTAINER_ID} {
        position: fixed;
        bottom: var(--helper-stats-bottom, calc(8px + env(safe-area-inset-bottom, 0px)));
        left: var(--helper-stats-x, 260px);
        z-index: 9000;
        display: none;
        width: min(280px, calc(100vw - 16px));
        gap: 6px;
        padding: 7px;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.92);
        color: #e2e8f0;
        box-shadow:
          0 10px 26px rgba(0, 0, 0, 0.4),
          0 0 16px rgba(148, 163, 184, 0.1);
        /* Draggable from anywhere on the panel (same feel as the Top-10 badge).
           Trade-off: the panel captures clicks within its footprint while
           visible — drag it aside if it ever covers game UI. */
        pointer-events: auto;
        cursor: move;
        user-select: none;
      }

      #${HELPER_STATS_CONTAINER_ID}[data-visible="true"] {
        display: grid;
      }

      #${HELPER_STATS_CONTAINER_ID} > * {
        min-width: 0;
      }

    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Layout-dirty flag invalidates cached helper-stats geometry. Cleared lazily
  // by syncHelperLayoutIfNeeded() so we only pay for getBoundingClientRect()
  // and CSS-variable writes when something actually changed (viewport resize,
  // container content change, badge visibility toggle).
  let _helperStatsLayoutDirty = true;
  let _helperStatsResizeObserver = null;
  let _helperStatsLayoutListenersBound = false;

  function markHelperStatsLayoutDirty() {
    _helperStatsLayoutDirty = true;
  }

  function bindHelperStatsLayoutListeners(container) {
    if (_helperStatsLayoutListenersBound) {
      return;
    }
    _helperStatsLayoutListenersBound = true;
    window.addEventListener("resize", markHelperStatsLayoutDirty, {
      passive: true,
    });
    const visualViewport = window.visualViewport;
    if (visualViewport) {
      visualViewport.addEventListener("resize", markHelperStatsLayoutDirty, {
        passive: true,
      });
      visualViewport.addEventListener("scroll", markHelperStatsLayoutDirty, {
        passive: true,
      });
    }
    if (typeof ResizeObserver !== "undefined") {
      _helperStatsResizeObserver = new ResizeObserver(markHelperStatsLayoutDirty);
      _helperStatsResizeObserver.observe(container);
    }
  }

  // Drag-and-persist for the bottom-left gold readouts. Once a panel has been
  // dragged (or has a stored position), it is flagged data-user-positioned and
  // its auto-positioner (positionHelperStatsContainer / positionTopGold...)
  // bows out, so the manual position sticks. Positions are stored as absolute
  // top/left in localStorage; we clear `bottom` so top/left win over the
  // default bottom-anchored CSS.
  function applyStoredGoldStatPanelPosition(el, storageKey) {
    let pos;
    {
      pos = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    }
    if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) {
      return;
    }
    el.dataset.userPositioned = "true";
    el.style.bottom = "auto";
    el.style.left = `${Math.max(0, Math.min(pos.left, window.innerWidth - 60))}px`;
    el.style.top = `${Math.max(0, Math.min(pos.top, window.innerHeight - 30))}px`;
  }

  function makeGoldStatPanelDraggable(panel, handle, storageKey) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;
    let moved = false;

    function onMove(event) {
      if (!dragging) {
        return;
      }
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      // A pure click (no real movement) must not freeze the panel's auto-layout.
      // Only commit to manual positioning once the pointer actually travels.
      if (!moved) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
          return;
        }
        moved = true;
        panel.dataset.userPositioned = "true";
        // Switch from the default bottom/left anchor to absolute top/left so the
        // panel tracks the pointer exactly.
        panel.style.bottom = "auto";
      }
      const left = Math.max(
        0,
        Math.min(originLeft + dx, window.innerWidth - 60),
      );
      const top = Math.max(
        0,
        Math.min(originTop + dy, window.innerHeight - 30),
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }

    function onUp() {
      if (!dragging) {
        return;
      }
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) {
        return;
      }
      {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            left: parseInt(panel.style.left, 10),
            top: parseInt(panel.style.top, 10),
          }),
        );
      }
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      dragging = true;
      moved = false;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = event.clientX;
      startY = event.clientY;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    });
  }

  function ensureHelperStatsContainer() {
    ensureHelperStatsContainerStyles();

    let container = document.getElementById(HELPER_STATS_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = HELPER_STATS_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
      makeGoldStatPanelDraggable(container, container, HELPER_STATS_POS_KEY);
      applyStoredGoldStatPanelPosition(container, HELPER_STATS_POS_KEY);
    }
    bindHelperStatsLayoutListeners(container);
    return container;
  }

  function syncHelperStatsLayoutIfDirty() {
    if (!_helperStatsLayoutDirty) {
      return;
    }
    _helperStatsLayoutDirty = false;
    positionHelperStatsContainer();
    positionTopGoldPerMinuteBadge();
  }

  function positionHelperStatsContainer() {
    const container = ensureHelperStatsContainer();
    // A user-dragged panel keeps its manual position — skip auto-placement.
    if (container.dataset.userPositioned === "true") {
      return container;
    }
    const gap = 8;
    const viewportOffsetLeft = Number(window.visualViewport?.offsetLeft) || 0;
    const viewportOffsetBottom = Number(window.visualViewport?.offsetTop) || 0;

    container.style.setProperty(
      "--helper-stats-x",
      `${Math.round(gap + viewportOffsetLeft)}px`,
    );
    container.style.setProperty(
      "--helper-stats-bottom",
      `${Math.round(gap + viewportOffsetBottom)}px`,
    );
    return container;
  }

  function syncHelperStatsContainerVisibility() {
    const container = ensureHelperStatsContainer();
    const hasVisibleCard = Boolean(
      container.querySelector('[data-visible="true"]'),
    );
    const nextVisible = String(hasVisibleCard);
    if (container.dataset.visible !== nextVisible) {
      markHelperStatsLayoutDirty();
    }
    container.dataset.visible = nextVisible;
    container.setAttribute("aria-hidden", String(!hasVisibleCard));
  }

  function ensureGoldPerMinuteStyles() {
    if (document.getElementById(GOLD_PER_MINUTE_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = GOLD_PER_MINUTE_STYLE_ID;
    style.textContent = `
      #${GOLD_PER_MINUTE_BADGE_ID} {
        display: none;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        width: 100%;
        padding: 3px 2px;
        border: none;
        background: none;
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 12px;
        font-weight: 800;
        line-height: 1;
        box-shadow: none;
      }

      #${GOLD_PER_MINUTE_BADGE_ID}[data-visible="true"] {
        display: flex;
      }

      #${GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-gpm-label {
        color: rgba(226, 232, 240, 0.82);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      #${GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-gpm-value {
        color: var(--team-accent-color, #e2e8f0);
        font-variant-numeric: tabular-nums;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureGoldPerMinuteBadge() {
    ensureGoldPerMinuteStyles();

    let badge = document.getElementById(GOLD_PER_MINUTE_BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = GOLD_PER_MINUTE_BADGE_ID;
      badge.innerHTML = `
        <span class="openfront-helper-gpm-label">${tr("Gold per minute")}</span>
        <span class="openfront-helper-gpm-value">${tr("tracking")}</span>
      `;
    }
    const container = ensureHelperStatsContainer();
    if (badge.parentElement !== container) {
      container.appendChild(badge);
    }
    return badge;
  }

  function ensureTeamGoldPerMinuteStyles() {
    if (document.getElementById(TEAM_GOLD_PER_MINUTE_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = TEAM_GOLD_PER_MINUTE_STYLE_ID;
    style.textContent = `
      #${TEAM_GOLD_PER_MINUTE_BADGE_ID} {
        display: none;
        width: 100%;
        padding: 3px 2px;
        border: none;
        background: none;
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 12px;
        font-weight: 800;
        line-height: 1.15;
        box-shadow: none;
      }

      #${TEAM_GOLD_PER_MINUTE_BADGE_ID}[data-visible="true"] {
        display: grid;
        gap: 5px;
      }

      #${TEAM_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-team-gpm-title {
        color: rgba(226, 232, 240, 0.82);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      #${TEAM_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-team-gpm-rows {
        display: grid;
        gap: 4px;
      }

      #${TEAM_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-team-gpm-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        padding-left: 7px;
        border-left: 3px solid var(--team-accent-color, rgba(148, 163, 184, 0.6));
      }

      #${TEAM_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-team-gpm-name {
        overflow: hidden;
        color: var(--team-accent-color, #cbd5e1);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${TEAM_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-team-gpm-value {
        color: rgba(226, 232, 240, 0.92);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureTeamGoldPerMinuteBadge() {
    ensureTeamGoldPerMinuteStyles();

    let badge = document.getElementById(TEAM_GOLD_PER_MINUTE_BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = TEAM_GOLD_PER_MINUTE_BADGE_ID;
      badge.innerHTML = `
        <span class="openfront-helper-team-gpm-title">${tr("Team gold per minute")}</span>
        <span class="openfront-helper-team-gpm-rows"></span>
      `;
    }
    const container = ensureHelperStatsContainer();
    if (badge.parentElement !== container) {
      container.appendChild(badge);
    }
    return badge;
  }

  function ensureTopGoldPerMinuteStyles() {
    if (document.getElementById(TOP_GOLD_PER_MINUTE_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = TOP_GOLD_PER_MINUTE_STYLE_ID;
    style.textContent = `
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} {
        position: fixed;
        bottom: var(--top-gpm-bottom, calc(8px + env(safe-area-inset-bottom, 0px)));
        left: var(--top-gpm-x, 296px);
        z-index: 9000;
        display: none;
        flex-direction: column;
        width: 340px;
        height: 280px;
        min-width: 240px;
        min-height: 120px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        /* Resizable from the bottom-right corner; the body scrolls. */
        resize: both;
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.95);
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.15;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4), 0 0 16px rgba(148, 163, 184, 0.1);
        pointer-events: auto;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID}[data-visible="true"] { display: flex; }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-header {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-header:active { cursor: grabbing; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-title {
        flex: 1;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: rgba(226, 232, 240, 0.85);
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-expand {
        cursor: pointer;
        border: 1px solid rgba(148, 163, 184, 0.4);
        border-radius: 6px;
        background: rgba(148, 163, 184, 0.14);
        color: #e2e8f0;
        font: 800 12px/1 "Aptos", "Segoe UI", sans-serif;
        padding: 3px 9px;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-expand:hover { background: rgba(148, 163, 184, 0.3); }

      /* One scroll container = one grid → header and rows share columns exactly. */
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-table {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: grid;
        align-content: start;
        /* Fixed row height: rows keep their size regardless of panel height, so
           resizing only changes how many are visible (scroll), never squishes. */
        grid-auto-rows: 26px;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-row { display: contents; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-cell {
        padding: 0 6px;
        line-height: 25px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
        /* Clears the sticky header when scrollIntoView follows a hovered row. */
        scroll-margin-top: 26px;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-num { text-align: right; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-name {
        color: var(--team-accent-color, #cbd5e1);
        font-weight: 700;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-rank { color: rgba(148, 163, 184, 0.72); }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-head {
        position: sticky;
        top: 0;
        z-index: 1;
        background: rgba(16, 22, 24, 0.98);
        color: rgba(226, 232, 240, 0.72);
        font-size: 10px;
        text-transform: uppercase;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-head.aps-sortable { cursor: pointer; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-head.aps-sortable:hover { color: #fff; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-head.aps-sorted { color: #fff; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-sort-arrow { font-size: 8px; margin-left: 2px; }
      /* Icon headers (numeric + building columns) sit centered over the column. */
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-head.aps-num { text-align: center; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-head img {
        width: 14px;
        height: 14px;
        object-fit: contain;
        vertical-align: middle;
      }
      /* Row highlights: applied per-cell (rows are display:contents) so the
         band is continuous across the columns. */
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-row .aps-cell { cursor: pointer; }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-row.is-self .aps-cell { background: rgba(59, 130, 246, 0.2); }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-row.is-hovered .aps-cell { background: rgba(148, 163, 184, 0.24); }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-row.is-disconnected .aps-cell { opacity: 0.5; }
      /* Pinned hovered-nation row at the bottom (after is-* rules → wins ties). */
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-row.aps-footer .aps-cell {
        position: sticky;
        bottom: 0;
        z-index: 1;
        background: rgba(28, 38, 48, 0.98);
        border-top: 1px solid rgba(148, 163, 184, 0.34);
        border-bottom: none;
      }
      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .aps-empty {
        grid-column: 1 / -1;
        padding: 12px;
        text-align: center;
        color: rgba(226, 232, 240, 0.6);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureTopGoldPerMinuteBadge() {
    ensureTopGoldPerMinuteStyles();

    let badge = document.getElementById(TOP_GOLD_PER_MINUTE_BADGE_ID);
    if (!badge) {
      // Restore the saved expand state before building (drives the column set).
      apsExpanded = loadApsExpanded();
      badge = document.createElement("div");
      badge.id = TOP_GOLD_PER_MINUTE_BADGE_ID;

      const header = document.createElement("div");
      header.className = "aps-header";
      const title = document.createElement("span");
      title.className = "aps-title";
      title.textContent = tr("Players");
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "aps-expand";
      expandBtn.textContent = apsExpanded ? "−" : "+";
      expandBtn.title = tr("Show building counts");
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't start a drag
        apsExpanded = !apsExpanded;
        saveApsExpanded();
        expandBtn.textContent = apsExpanded ? "−" : "+";
        apsRenderedOrderSig = ""; // force a structural rebuild
        updateTopGoldPerMinuteBadge();
      });
      header.append(title, expandBtn);

      const table = document.createElement("div");
      table.className = "aps-table";

      badge.append(header, table);
    }
    if (!badge.parentElement) {
      (document.body || document.documentElement).appendChild(badge);
      const header = badge.querySelector(".aps-header");
      // Drag by the header only — the body scrolls and the corner resizes.
      makeGoldStatPanelDraggable(badge, header || badge, TOP_GOLD_PER_MINUTE_POS_KEY);
      applyStoredGoldStatPanelPosition(badge, TOP_GOLD_PER_MINUTE_POS_KEY);
      // Restore the user's last resized size, and persist future resizes.
      applyStoredApsSize(badge);
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => saveApsSize(badge));
        ro.observe(badge);
      }
    }
    return badge;
  }

  function positionTopGoldPerMinuteBadge() {
    const badge = ensureTopGoldPerMinuteBadge();
    // A user-dragged panel keeps its manual position — skip auto-placement.
    if (badge.dataset.userPositioned === "true") {
      return;
    }
    const gap = 8;
    const viewportOffsetLeft = Number(window.visualViewport?.offsetLeft) || 0;
    const viewportOffsetTop = Number(window.visualViewport?.offsetTop) || 0;
    const viewportWidth = Number(window.visualViewport?.width) || window.innerWidth;
    const defaultLeft = Math.round(gap + viewportOffsetLeft);
    const statsContainer = ensureHelperStatsContainer();
    const statsRect =
      statsContainer.dataset.visible === "true"
        ? statsContainer.getBoundingClientRect?.()
        : null;
    const preferredLeft =
      statsRect && statsRect.width > 0
        ? Math.round(statsRect.right + gap + viewportOffsetLeft)
        : defaultLeft;
    const maxLeft = Math.max(
      defaultLeft,
      Math.round(viewportOffsetLeft + viewportWidth - badge.offsetWidth - gap),
    );

    badge.style.setProperty("--top-gpm-x", `${Math.min(preferredLeft, maxLeft)}px`);
    badge.style.setProperty(
      "--top-gpm-bottom",
      `${Math.round(gap + viewportOffsetTop)}px`,
    );
  }

  function addIncomingGoldTransfer(playerSmallId, goldAmount) {
    if (
      !Number.isFinite(playerSmallId) ||
      !Number.isFinite(goldAmount) ||
      goldAmount <= 0
    ) {
      return;
    }

    const key = String(playerSmallId);
    incomingGoldTransfers.set(
      key,
      (incomingGoldTransfers.get(key) || 0) + goldAmount,
    );
  }

  function processIncomingGoldTransferUpdates(game) {
    const currentTick = Number(game?.ticks?.());
    if (
      !Number.isFinite(currentTick) ||
      currentTick === runtimeState.lastProcessedIncomingGoldTransferTick
    ) {
      return;
    }
    runtimeState.lastProcessedIncomingGoldTransferTick = currentTick;

    const updates = game?.updatesSinceLastTick?.();
    if (!updates) {
      return;
    }

    for (const updateGroup of Object.values(updates)) {
      if (!Array.isArray(updateGroup)) {
        continue;
      }

      for (const event of updateGroup) {
        if (event?.message !== "events_display.received_gold_from_player") {
          continue;
        }

        addIncomingGoldTransfer(
          Number(event.playerID),
          getTradeEventGoldAmount(event.goldAmount),
        );
      }
    }
  }

  function formatGoldPerMinute(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "tracking";
    }

    const sign = value < 0 ? "-" : "";
    const absValue = Math.abs(value);
    if (absValue >= 1_000_000_000) {
      return `${sign}${(absValue / 1_000_000_000).toFixed(1)}B/min`;
    }
    if (absValue >= 1_000_000) {
      return `${sign}${(absValue / 1_000_000).toFixed(1)}M/min`;
    }
    if (absValue >= 1_000) {
      return `${sign}${(absValue / 1_000).toFixed(1)}K/min`;
    }
    return `${sign}${Math.round(absValue)}/min`;
  }

  function getGoldTracker(player, fallbackIndex) {
    const playerId = getPlayerMarkerId(player, fallbackIndex);
    let tracker = goldTrackers.get(playerId);
    if (!tracker) {
      tracker = {
        lastGold: null,
        earnedTotal: 0,
        samples: [],
      };
      goldTrackers.set(playerId, tracker);
    }
    return { playerId, tracker };
  }

  function sampleGoldPerMinute() {
    const context = getOpenFrontGameContext();
    if (!context) {
      return;
    }

    processIncomingGoldTransferUpdates(context.game);
    const now = Date.now();
    runtimeState.lastGoldPerMinuteSampleAt = now;
    const activeIds = new Set();
    const players = getCachedPlayerViews(context.game);

    let index = 0;
    for (const player of players) {
      if (!player?.isAlive?.()) {
        index += 1;
        continue;
      }

      const gold = getPlayerGoldNumber(player);
      if (!Number.isFinite(gold)) {
        index += 1;
        continue;
      }

      const { playerId, tracker } = getGoldTracker(player, index);
      activeIds.add(playerId);
      const playerSmallId = getPlayerSmallId(player, index);
      const incomingTransfer =
        incomingGoldTransfers.get(String(playerSmallId)) || 0;

      if (tracker.lastGold !== null && gold > tracker.lastGold) {
        tracker.earnedTotal += Math.max(0, gold - tracker.lastGold - incomingTransfer);
      }
      incomingGoldTransfers.delete(String(playerSmallId));
      tracker.lastGold = gold;
      tracker.samples.push({
        time: now,
        earnedTotal: tracker.earnedTotal,
      });

      const oldestAllowed = now - GOLD_PER_MINUTE_WINDOW_MS;
      while (
        tracker.samples.length > 1 &&
        tracker.samples[0].time < oldestAllowed
      ) {
        tracker.samples.shift();
      }
      index += 1;
    }

    for (const playerId of goldTrackers.keys()) {
      if (!activeIds.has(playerId)) {
        goldTrackers.delete(playerId);
      }
    }
  }

  function sampleGoldPerMinuteIfDue() {
    const context = getOpenFrontGameContext();
    if (context?.game) {
      processIncomingGoldTransferUpdates(context.game);
    }
    if (Date.now() - runtimeState.lastGoldPerMinuteSampleAt >= GOLD_PER_MINUTE_SAMPLE_MS) {
      sampleGoldPerMinute();
    }
  }

  function getGoldPerMinuteForPlayer(player, fallbackIndex) {
    const { tracker } = getGoldTracker(player, fallbackIndex);
    if (tracker.samples.length < 2) {
      return null;
    }

    const first = tracker.samples[0];
    const last = tracker.samples[tracker.samples.length - 1];
    const elapsedMs = last.time - first.time;
    if (elapsedMs <= 0) {
      return null;
    }

    return ((last.earnedTotal - first.earnedTotal) / elapsedMs) * 60000;
  }

  // getPlayerTeamName / getTeamColor / getTeamColorBackground are provided by
  // shared-utils.js. Previously this file shadowed them with identical
  // implementations; the shared versions are now cached per game.

  function getTeamGoldPerMinuteRows(game) {
    const players = getCachedPlayerViews(game);
    const teams = new Map();

    let index = 0;
    for (const player of players) {
      if (!player?.isAlive?.()) {
        index += 1;
        continue;
      }

      const team = getPlayerTeamName(player);
      if (!team || team === "Bot") {
        index += 1;
        continue;
      }

      const gpm = getGoldPerMinuteForPlayer(player, index);
      const entry = teams.get(team) ?? {
        team,
        total: 0,
        trackedPlayers: 0,
        players: 0,
      };
      entry.players += 1;
      if (Number.isFinite(gpm)) {
        entry.total += gpm;
        entry.trackedPlayers += 1;
      }
      teams.set(team, entry);
      index += 1;
    }

    return Array.from(teams.values()).sort((a, b) => b.total - a.total);
  }

  // ── All-players stats panel (replaces the old top-10 GPM list) ────────────
  // Building columns shown when expanded (per-player counts, like Team build).
  // {type, emoji, label} so makeTeamBuildHeadGlyph (team-build-stats.js, shared
  // scope) can render the SAME game SVG icons here, with emoji fallback.
  const APS_STRUCTURES = [
    { type: "City", emoji: "🏙️", label: "City" },
    { type: "Port", emoji: "⚓", label: "Port" },
    { type: "Factory", emoji: "🏭", label: "Factory" },
    { type: "Defense Post", emoji: "🛡️", label: "Defense Post" },
    { type: "SAM Launcher", emoji: "🛰️", label: "SAM Launcher" },
    { type: "Missile Silo", emoji: "🚀", label: "Missile Silo" },
  ];
  // Numeric columns use an icon header (hover shows the full name); same glyphs
  // as the team-build panel for the shared stats.
  const APS_BASE_COLUMNS = [
    { key: "rank", label: "#", cls: "aps-rank", sortable: false },
    { key: "name", label: "Player", cls: "aps-name", sortable: true },
    { key: "owned", label: "Owned", glyph: "🗺️", cls: "aps-num", sortable: true },
    { key: "gold", label: "Gold", glyph: "🪙", cls: "aps-num", sortable: true },
    { key: "gpm", label: "Gold/min", glyph: "💰", cls: "aps-num", sortable: true },
    { key: "maxTroops", label: "Max troops", glyph: "⚔️", cls: "aps-num", sortable: true },
  ];

  const APS_SIZE_KEY = "openfrontHelperPlayerPanelSize";
  const APS_EXPAND_KEY = "openfrontHelperPlayerPanelExpanded";
  let apsSortKey = "owned";
  let apsSortDir = 1; // 1 = descending, -1 = ascending
  let apsExpanded = false;

  function loadApsExpanded() {
    {
      return window.localStorage.getItem(APS_EXPAND_KEY) === "1";
    }
  }
  function saveApsExpanded() {
    {
      window.localStorage.setItem(APS_EXPAND_KEY, apsExpanded ? "1" : "0");
    }
  }
  function applyStoredApsSize(panel) {
    {
      const s = JSON.parse(window.localStorage.getItem(APS_SIZE_KEY) || "null");
      if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
        panel.style.width = `${s.w}px`;
        panel.style.height = `${s.h}px`;
      }
    }
  }
  function saveApsSize(panel) {
    const w = parseInt(panel.style.width, 10);
    const h = parseInt(panel.style.height, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      return; // not resized yet (still CSS default, no inline size)
    }
    {
      window.localStorage.setItem(APS_SIZE_KEY, JSON.stringify({ w, h }));
    }
  }
  let apsRenderedExpanded = null; // last grid/header structure rendered
  let apsRenderedSortSig = ""; // last sort state baked into the header arrows
  let apsRenderedOrderSig = ""; // last keyed row order appended to the grid
  let apsHeaderCells = null;
  let apsFooterEntry = null; // pinned bottom row mirroring the hovered nation
  const apsRowCache = new Map(); // smallId -> { row, cells:{key:el} }

  // Hide/show the game's whole left sidebar (<game-left-sidebar>: leaderboard +
  // team-stats + the 📊/👥 toggle bar + game-id) via an injected stylesheet so
  // it survives the game re-rendering. Tied to the player-stats panel toggle.
  function setGameLeaderboardHidden(hidden) {
    const id = "openfront-helper-hide-game-leaderboard";
    let style = document.getElementById(id);
    if (hidden) {
      if (!style) {
        style = document.createElement("style");
        style.id = id;
        // Hide the whole left sidebar (leaderboard list + the 📊/👥 toggle bar +
        // game-id), not just <leader-board>, so nothing of it is left over.
        style.textContent = "game-left-sidebar{display:none !important;}";
        (document.head || document.documentElement).appendChild(style);
      }
    } else if (style) {
      style.remove();
    }
  }

  function apsFormatNum(value) {
    const n = Number(value) || 0;
    const sign = n < 0 ? "-" : "";
    const a = Math.abs(n);
    if (a >= 1_000_000_000) return `${sign}${(a / 1_000_000_000).toFixed(1)}B`;
    if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1)}M`;
    if (a >= 1_000) return `${sign}${(a / 1_000).toFixed(1)}K`;
    return `${sign}${Math.round(a)}`;
  }

  function apsFormatGpm(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? apsFormatNum(value)
      : "—";
  }

  function apsFormatOwned(owned, game) {
    // Match the game's own stats: denominator = land tiles minus fallout tiles.
    let total;
    {
      total =
        (Number(game?.numLandTiles?.()) || 0) -
        (Number(game?.numTilesWithFallout?.()) || 0);
    }
    if (total <= 0) return "—";
    const pct = ((Number(owned) || 0) / total) * 100;
    return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  }

  // One pass over all structure units → smallId -> { type: count } (only built
  // when the panel is expanded, since it's the costly part).
  function getApsStructureUnitData(unit) {
    {
      const smallId = Number(unit.owner?.()?.smallID?.());
      const type = unit.type?.();
      if (!Number.isFinite(smallId) || !type || unit.isUnderConstruction?.()) return null;
      const rawLevel = Number(unit.level?.());
      const level = Number.isFinite(rawLevel) && rawLevel > 0 ? rawLevel : 1;
      return { smallId, type, level };
    }
  }

  function getApsStructureCounts(game) {
    const counts = new Map();
    let units;
    {
      units = game.units(...APS_STRUCTURES.map((s) => s.type)) || [];
    }
    for (const unit of units) {
      const data = getApsStructureUnitData(unit);
      if (!data) continue;
      let entry = counts.get(data.smallId);
      if (!entry) {
        entry = {};
        counts.set(data.smallId, entry);
      }
      entry[data.type] = (entry[data.type] || 0) + data.level;
    }
    return counts;
  }

  function readApsPlayerNumber(player, methodName) {
    { return Number(player?.[methodName]?.()) || 0; }
  }

  function getApsMaxTroops(config, player) {
    { return config?.maxTroops ? (Number(config.maxTroops(player)) || 0) / 10 : 0; }
  }

  function isApsPlayerDisconnected(player) {
    { return Boolean(player.isDisconnected?.()); }
  }

  function apsRowSortValue(row, key) {
    switch (key) {
      case "name":
        return row.name;
      case "owned":
        return row.owned;
      case "gold":
        return row.gold;
      case "gpm":
        return Number.isFinite(row.gpm) ? row.gpm : -Infinity;
      case "maxTroops":
        return row.maxTroops;
      default:
        return (row.counts && row.counts[key]) || 0; // a structure type
    }
  }

  function getAllPlayerStatsRows(game) {
    const players = getCachedPlayerViews(game);
    const structureCounts = apsExpanded ? getApsStructureCounts(game) : null;
    let config;
    {
      config = game.config?.();
    }
    let myId;
    {
      myId = Number(game.myPlayer?.()?.smallID?.());
    }

    const rows = [];
    let index = 0;
    for (const player of players) {
      if (!player?.isAlive?.()) {
        index += 1;
        continue;
      }
      const smallId = Number(getPlayerSmallId(player, index));
      const gold = readApsPlayerNumber(player, "gold");
      const owned = readApsPlayerNumber(player, "numTilesOwned");
      const maxTroops = getApsMaxTroops(config, player);
      const disconnected = isApsPlayerDisconnected(player);
      rows.push({
        smallId,
        name: getPlayerDisplayName(player),
        team: getPlayerTeamName(player),
        // Each player's exact in-game color (per-player, not just per-team), so
        // rows match what the player sees on the map. null → no accent.
        color: getPlayerColor(player, game),
        owned,
        gold,
        gpm: getGoldPerMinuteForPlayer(player, index),
        maxTroops,
        disconnected,
        isMe: Number.isFinite(myId) && smallId === myId,
        counts: structureCounts ? structureCounts.get(smallId) || {} : null,
      });
      index += 1;
    }

    const key = apsSortKey;
    const dir = apsSortDir;
    rows.sort((a, b) => {
      const av = apsRowSortValue(a, key);
      const bv = apsRowSortValue(b, key);
      if (typeof av === "string") {
        const c = String(av).localeCompare(String(bv));
        return dir === 1 ? c : -c; // dir 1 = A→Z for names
      }
      if (av !== bv) return dir === 1 ? bv - av : av - bv;
      return b.owned - a.owned; // tie-break: bigger territory first
    });
    return rows;
  }

  function getApsColumns() {
    const cols = APS_BASE_COLUMNS.slice();
    if (apsExpanded) {
      for (const s of APS_STRUCTURES) {
        cols.push({
          key: s.type,
          structure: s, // → game SVG icon header (makeTeamBuildHeadGlyph)
          cls: "aps-num",
          sortable: true,
          title: s.label,
        });
      }
    }
    return cols;
  }

  function getApsGridTemplate() {
    // Rank column wide enough for 3-digit ranks (hundreds of players); building
    // columns wide enough for 4-digit counts.
    let tpl = "36px minmax(72px, 1fr) repeat(4, 52px)";
    if (apsExpanded) {
      tpl += ` repeat(${APS_STRUCTURES.length}, 38px)`;
    }
    return tpl;
  }

  function setApsSort(key) {
    if (apsSortKey === key) {
      apsSortDir = apsSortDir === 1 ? -1 : 1;
    } else {
      apsSortKey = key;
      apsSortDir = 1;
    }
    updateTopGoldPerMinuteBadge();
  }

  // Click a row → pan the camera to that player (via the game's events-display
  // "go to player" hook, the same one the HUD uses).
  function focusApsPlayer(smallId) {
    if (!Number.isFinite(smallId)) {
      return;
    }
    {
      const target =
        document.querySelector("actionable-events") ||
        document.querySelector("events-display");
      if (target && typeof target.emitGoToPlayerEvent === "function") {
        target.emitGoToPlayerEvent(Number(smallId));
      }
    }
  }

  function buildApsHeader(table, columns) {
    if (apsHeaderCells) {
      for (const cell of apsHeaderCells) cell.remove();
    }
    const cells = columns.map((col) => {
      const cell = document.createElement("span");
      cell.className = `aps-cell aps-head ${col.cls}`;
      if (col.structure && typeof makeTeamBuildHeadGlyph === "function") {
        // Building columns: same game SVG icon as the team-build panel.
        cell.appendChild(makeTeamBuildHeadGlyph(col.structure));
        cell.title = col.title || col.structure.label;
      } else if (col.glyph) {
        // Numeric stat columns: icon glyph; hover shows the full label.
        cell.appendChild(document.createTextNode(col.glyph));
        cell.title = tr(col.label);
      } else {
        cell.textContent = tr(col.label);
        if (col.title) cell.title = col.title;
      }
      if (col.sortable) {
        cell.classList.add("aps-sortable");
        cell.addEventListener("click", () => setApsSort(col.key));
        if (apsSortKey === col.key) {
          cell.classList.add("aps-sorted");
          const arrow = document.createElement("span");
          arrow.className = "aps-sort-arrow";
          arrow.textContent = apsSortDir === 1 ? "▾" : "▴";
          cell.appendChild(arrow);
        }
      }
      return cell;
    });
    // Header cells go first so the sticky row sits at the top of the grid.
    table.prepend(...cells);
    apsHeaderCells = cells;
  }

  function getApsRowEntry(table, row, columns) {
    let entry = apsRowCache.get(row.smallId);
    if (!entry) {
      const rowEl = document.createElement("div");
      rowEl.className = "aps-row";
      const cells = {};
      for (const col of columns) {
        const cell = document.createElement("span");
        cell.className = `aps-cell ${col.cls}`;
        rowEl.appendChild(cell);
        cells[col.key] = cell;
      }
      entry = { row: rowEl, cells, smallId: row.smallId };
      // Click the row → focus that player on the map. Clicks on cells bubble to
      // the wrapper even though it is display:contents.
      rowEl.addEventListener("click", () => focusApsPlayer(entry.smallId));
      apsRowCache.set(row.smallId, entry);
      table.appendChild(rowEl);
    }
    return entry;
  }

  function setApsCellText(cell, text) {
    if (cell && cell.textContent !== text) cell.textContent = text;
  }

  function updateApsCoreCells(entry, row, rank, game) {
    const c = entry.cells;
    setApsCellText(c.rank, String(rank + 1));
    if (c.name) {
      const name = row.disconnected ? `${row.name} 💤` : row.name;
      setApsCellText(c.name, name);
      const color = row.color || (row.team ? getTeamColor(row.team, game) : "");
      if (color) c.name.style.setProperty("--team-accent-color", color);
      else c.name.style.removeProperty("--team-accent-color");
    }
    setApsCellText(c.owned, apsFormatOwned(row.owned, game));
    setApsCellText(c.gold, apsFormatNum(row.gold));
    setApsCellText(c.gpm, apsFormatGpm(row.gpm));
    setApsCellText(c.maxTroops, apsFormatNum(row.maxTroops));
  }

  function updateApsStructureCells(entry, row) {
    if (!row.counts) return;
    for (const structure of APS_STRUCTURES) {
      setApsCellText(entry.cells[structure.type], String(row.counts[structure.type] || 0));
    }
  }

  function updateApsRow(entry, row, rank, game, hoveredId) {
    updateApsCoreCells(entry, row, rank, game);
    updateApsStructureCells(entry, row);
    entry.row.classList.toggle("is-self", Boolean(row.isMe));
    entry.row.classList.toggle(
      "is-hovered",
      hoveredId !== null && row.smallId === hoveredId,
    );
    entry.row.classList.toggle("is-disconnected", Boolean(row.disconnected));
  }

  function getApsFooter(table, columns) {
    if (!apsFooterEntry) {
      const rowEl = document.createElement("div");
      rowEl.className = "aps-row aps-footer";
      const cells = {};
      for (const col of columns) {
        const cell = document.createElement("span");
        cell.className = `aps-cell aps-foot ${col.cls}`;
        rowEl.appendChild(cell);
        cells[col.key] = cell;
      }
      apsFooterEntry = { row: rowEl, cells, smallId: null };
      rowEl.addEventListener("click", () => focusApsPlayer(apsFooterEntry.smallId));
      table.appendChild(rowEl);
    }
    return apsFooterEntry;
  }

  function updateTeamGoldPerMinuteBadge() {
    const badge = ensureTeamGoldPerMinuteBadge();
    if (!runtimeState.teamGoldPerMinuteEnabled) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      runtimeState.teamGoldPerMinuteRenderSignature = "";
      return;
    }

    const context = getOpenFrontGameContext();
    if (!context?.game) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      runtimeState.teamGoldPerMinuteRenderSignature = "";
      return;
    }

    sampleGoldPerMinuteIfDue();
    const rows = getTeamGoldPerMinuteRows(context.game);
    if (rows.length < 2) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      runtimeState.teamGoldPerMinuteRenderSignature = "";
      return;
    }

    const rowsContainer = badge.querySelector(".openfront-helper-team-gpm-rows");
    if (rowsContainer) {
      const rowData = rows.map((entry) => ({
        team: entry.team,
        color: getTeamColor(entry.team, context.game),
        value: entry.trackedPlayers > 0 ? formatGoldPerMinute(entry.total) : "tracking",
      }));

      const nextSignature = rowData
        .map((entry) => `${entry.team}|${entry.color}|${entry.value}`)
        .join(";");

      if (runtimeState.teamGoldPerMinuteRenderSignature !== nextSignature) {
        rowsContainer.replaceChildren(
          ...rowData.map((entry) => {
            const row = document.createElement("span");
            row.className = "openfront-helper-team-gpm-row";
            row.style.setProperty("--team-accent-color", entry.color);
            const name = document.createElement("span");
            name.className = "openfront-helper-team-gpm-name";
            name.textContent = entry.team;
            const value = document.createElement("span");
            value.className = "openfront-helper-team-gpm-value";
            value.textContent = entry.value;
            row.append(name, value);
            return row;
          }),
        );
        runtimeState.teamGoldPerMinuteRenderSignature = nextSignature;
        markHelperStatsLayoutDirty();
      }
    }

    if (badge.dataset.visible !== "true") {
      badge.dataset.visible = "true";
      syncHelperStatsContainerVisibility();
      markHelperStatsLayoutDirty();
    }
    syncHelperStatsLayoutIfDirty();
  }

  function hideTopGoldPerMinuteBadge(badge) {
    if (badge.dataset.visible !== "false") {
      badge.dataset.visible = "false";
      markHelperStatsLayoutDirty();
    }
    syncHelperStatsLayoutIfDirty();
  }

  function getApsHoveredPlayerId() {
    if (!runtimeState.goldPerMinuteEnabled) return null;
    const overlay = getHoveredPlayerInfoOverlay();
    return overlay?.player ? Number(getPlayerSmallId(overlay.player, 0)) : null;
  }

  function resetApsTableStructure(table) {
    if (apsRenderedExpanded === apsExpanded) return;
    table.style.gridTemplateColumns = getApsGridTemplate();
    for (const entry of apsRowCache.values()) entry.row.remove();
    apsRowCache.clear();
    if (apsHeaderCells) for (const cell of apsHeaderCells) cell.remove();
    apsHeaderCells = null;
    apsFooterEntry?.row.remove();
    apsFooterEntry = null;
    apsRenderedSortSig = "";
    apsRenderedExpanded = apsExpanded;
  }

  function ensureApsHeader(table, columns) {
    const sortSig = `${apsSortKey}:${apsSortDir}`;
    if (apsHeaderCells && apsRenderedSortSig === sortSig) return;
    buildApsHeader(table, columns);
    apsRenderedSortSig = sortSig;
  }

  function reconcileApsRows(table, rows, columns, game, hoveredId) {
    const rowOrderSig = rows.map((row) => row.smallId).join(",");
    const rowOrderChanged = apsRenderedOrderSig !== rowOrderSig;
    apsRenderedOrderSig = rowOrderSig;
    const seen = new Set();
    rows.forEach((row, index) => {
      seen.add(row.smallId);
      const entry = getApsRowEntry(table, row, columns);
      updateApsRow(entry, row, index, game, hoveredId);
      if (rowOrderChanged) table.appendChild(entry.row);
    });
    for (const [smallId, entry] of apsRowCache) {
      if (seen.has(smallId)) continue;
      entry.row.remove();
      apsRowCache.delete(smallId);
    }
  }

  function updateApsFooter(table, rows, columns, game, hoveredId) {
    const footer = getApsFooter(table, columns);
    if (table.lastElementChild !== footer.row) table.appendChild(footer.row);
    const hoveredRow = hoveredId === null ? null : rows.find((row) => row.smallId === hoveredId);
    if (!hoveredRow) {
      footer.smallId = null;
      footer.row.style.display = "none";
      return;
    }
    footer.smallId = hoveredRow.smallId;
    updateApsRow(footer, hoveredRow, rows.indexOf(hoveredRow), game, hoveredId);
    footer.row.style.display = "";
  }

  function updateTopGoldPerMinuteBadge() {
    const badge = ensureTopGoldPerMinuteBadge();
    // The all-players stats panel is gated on the top-gpm toggle.
    if (!runtimeState.topGoldPerMinuteEnabled) {
      hideTopGoldPerMinuteBadge(badge);
      return;
    }
    const context = getOpenFrontGameContext();
    if (!context?.game) {
      hideTopGoldPerMinuteBadge(badge);
      return;
    }
    sampleGoldPerMinuteIfDue();

    const game = context.game;
    const table = badge.querySelector(".aps-table");
    if (!table) {
      return;
    }

    // Hovered player → highlight that row (the showGoldPerMinute feature).
    const hoveredId = getApsHoveredPlayerId();

    const columns = getApsColumns();
    const rows = getAllPlayerStatsRows(game);

    // Structural rebuild when expand state changes (the column set differs).
    resetApsTableStructure(table);

    // (Re)build the sticky header when its structure or sort indicator changes.
    ensureApsHeader(table, columns);
    reconcileApsRows(table, rows, columns, game, hoveredId);

    // Pinned bottom row = the hovered nation's stats, so you can read it without
    // scrolling to find its row. Hidden when nothing is hovered.
    updateApsFooter(table, rows, columns, game, hoveredId);

    if (badge.dataset.visible !== "true") {
      badge.dataset.visible = "true";
      markHelperStatsLayoutDirty();
    }
    syncHelperStatsLayoutIfDirty();
  }

  function updateGoldPerMinuteBadge() {
    const badge = ensureGoldPerMinuteBadge();
    if (!runtimeState.goldPerMinuteEnabled) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      runtimeState.goldPerMinuteRenderSignature = "";
      return;
    }

    const overlay = getHoveredPlayerInfoOverlay();
    if (!overlay) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      runtimeState.goldPerMinuteRenderSignature = "";
      return;
    }

    const gpm = getGoldPerMinuteForPlayer(
      overlay.player,
      getPlayerSmallId(overlay.player, 0),
    );
    const team = getPlayerTeamName(overlay.player);
    const valueText = formatGoldPerMinute(gpm);
    const teamColor = team ? getTeamColor(team, overlay.game) : "";
    const teamBackground = team ? getTeamColorBackground(team, overlay.game) : "";
    const nextSignature = `${teamColor}|${teamBackground}|${valueText}`;

    if (runtimeState.goldPerMinuteRenderSignature !== nextSignature) {
      runtimeState.goldPerMinuteRenderSignature = nextSignature;
      if (team) {
        badge.style.setProperty("--team-accent-color", teamColor);
        badge.style.setProperty("--team-border-color", teamColor);
        badge.style.setProperty("--team-bg-color", teamBackground);
      } else {
        badge.style.removeProperty("--team-accent-color");
        badge.style.removeProperty("--team-border-color");
        badge.style.removeProperty("--team-bg-color");
      }
      const value = badge.querySelector(".openfront-helper-gpm-value");
      if (value) {
        value.textContent = valueText;
      }
      markHelperStatsLayoutDirty();
    }

    if (badge.dataset.visible !== "true") {
      badge.dataset.visible = "true";
      syncHelperStatsContainerVisibility();
      markHelperStatsLayoutDirty();
    }
    syncHelperStatsLayoutIfDirty();
  }

  // The top-10 panel now hosts BOTH the top-10 list (topGoldPerMinuteEnabled)
  // and the hovered player's GPM (goldPerMinuteEnabled), so its tick listener is
  // shared: registered while either feature is on.
  function syncTopGpmTickRegistration() {
    if (runtimeState.goldPerMinuteEnabled || runtimeState.topGoldPerMinuteEnabled) {
      registerHelperTickListener(updateTopGoldPerMinuteBadge, 1000);
    } else {
      unregisterHelperTickListener(updateTopGoldPerMinuteBadge);
    }
  }

  function setGoldPerMinuteEnabled(enabled) {
    runtimeState.goldPerMinuteEnabled = Boolean(enabled);
    if (!runtimeState.goldPerMinuteEnabled) {
      // Stop the sampler + drop trackers only if NO other consumer needs them:
      // the top-10 list, the economy heatmap, or the merged team-build panel.
      if (
        !runtimeState.topGoldPerMinuteEnabled &&
        !runtimeState.economyHeatmapEnabled &&
        !teamBuildStatsEnabled
      ) {
        if (runtimeState.goldPerMinuteInterval !== null) {
          clearInterval(runtimeState.goldPerMinuteInterval);
        }
        runtimeState.goldPerMinuteInterval = null;
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        runtimeState.lastProcessedIncomingGoldTransferTick = null;
      }
      syncTopGpmTickRegistration();
      // Re-render so the hovered-player row drops out of the top-10 panel.
      updateTopGoldPerMinuteBadge();
      return;
    }

    sampleGoldPerMinute();
    if (runtimeState.goldPerMinuteInterval === null) {
      runtimeState.goldPerMinuteInterval = setInterval(
        sampleGoldPerMinute,
        GOLD_PER_MINUTE_SAMPLE_MS,
      );
    }
    syncTopGpmTickRegistration();
  }

  function setTeamGoldPerMinuteEnabled(enabled) {
    runtimeState.teamGoldPerMinuteEnabled = Boolean(enabled);
    if (!runtimeState.teamGoldPerMinuteEnabled) {
      runtimeState.teamGoldPerMinuteAnimationFrame = null;
      runtimeState.lastTeamGoldPerMinuteRenderAt = 0;
      runtimeState.teamGoldPerMinuteRenderSignature = "";
      unregisterHelperTickListener(updateTeamGoldPerMinuteBadge);
      const badge = document.getElementById(TEAM_GOLD_PER_MINUTE_BADGE_ID);
      if (badge) {
        badge.dataset.visible = "false";
      }
      if (!runtimeState.goldPerMinuteEnabled && !runtimeState.topGoldPerMinuteEnabled && !runtimeState.economyHeatmapEnabled) {
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        runtimeState.lastProcessedIncomingGoldTransferTick = null;
      }
      syncHelperStatsContainerVisibility();
      return;
    }

    sampleGoldPerMinute();
    registerHelperTickListener(updateTeamGoldPerMinuteBadge, 1000);
  }

  function setTopGoldPerMinuteEnabled(enabled) {
    runtimeState.topGoldPerMinuteEnabled = Boolean(enabled);
    // The all-players panel replaces the game's own leaderboard while it's on.
    setGameLeaderboardHidden(runtimeState.topGoldPerMinuteEnabled);
    if (!runtimeState.topGoldPerMinuteEnabled) {
      runtimeState.topGoldPerMinuteAnimationFrame = null;
      runtimeState.lastTopGoldPerMinuteRenderAt = 0;
      apsRenderedOrderSig = "";
      if (
        !runtimeState.goldPerMinuteEnabled &&
        !runtimeState.economyHeatmapEnabled &&
        !teamBuildStatsEnabled
      ) {
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        runtimeState.lastProcessedIncomingGoldTransferTick = null;
      }
      syncTopGpmTickRegistration();
      updateTopGoldPerMinuteBadge();
      return;
    }

    sampleGoldPerMinute();
    syncTopGpmTickRegistration();
  }
