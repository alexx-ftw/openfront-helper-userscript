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
        z-index: 2147483647;
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
    let pos = null;
    try {
      pos = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    } catch (_error) {
      pos = null;
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
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            left: parseInt(panel.style.left, 10),
            top: parseInt(panel.style.top, 10),
          }),
        );
      } catch (_error) {
        // Best-effort — the panel stays where dragged for this session regardless.
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
        z-index: 2147483647;
        display: none;
        width: min(280px, calc(100vw - 16px));
        padding: 7px 9px;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.92);
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.15;
        box-shadow:
          0 10px 26px rgba(0, 0, 0, 0.4),
          0 0 16px rgba(148, 163, 184, 0.1);
        /* Interactive so the panel can be dragged; cursor hints draggability. */
        pointer-events: auto;
        cursor: move;
        user-select: none;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID}[data-visible="true"] {
        display: grid;
        gap: 5px;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-title {
        color: rgba(226, 232, 240, 0.82);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-rows {
        display: grid;
        gap: 4px;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-row {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) auto;
        gap: 6px;
        align-items: center;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-rank {
        color: rgba(148, 163, 184, 0.72);
        font-variant-numeric: tabular-nums;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-name {
        overflow: hidden;
        color: var(--team-accent-color, #cbd5e1);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-value {
        color: rgba(226, 232, 240, 0.92);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      #${TOP_GOLD_PER_MINUTE_BADGE_ID} .openfront-helper-top-gpm-empty {
        color: rgba(226, 232, 240, 0.72);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureTopGoldPerMinuteBadge() {
    ensureTopGoldPerMinuteStyles();

    let badge = document.getElementById(TOP_GOLD_PER_MINUTE_BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = TOP_GOLD_PER_MINUTE_BADGE_ID;
      badge.innerHTML = `
        <span class="openfront-helper-top-gpm-title">${tr("Top 10 gold per minute")}</span>
        <span class="openfront-helper-top-gpm-rows"></span>
      `;
    }
    if (!badge.parentElement) {
      (document.body || document.documentElement).appendChild(badge);
      makeGoldStatPanelDraggable(badge, badge, TOP_GOLD_PER_MINUTE_POS_KEY);
      applyStoredGoldStatPanelPosition(badge, TOP_GOLD_PER_MINUTE_POS_KEY);
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
      currentTick === lastProcessedIncomingGoldTransferTick
    ) {
      return;
    }
    lastProcessedIncomingGoldTransferTick = currentTick;

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
    lastGoldPerMinuteSampleAt = now;
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
    if (Date.now() - lastGoldPerMinuteSampleAt >= GOLD_PER_MINUTE_SAMPLE_MS) {
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

  function getTopGoldPerMinuteRows(game) {
    const players = getCachedPlayerViews(game);
    const rows = [];

    let index = 0;
    for (const player of players) {
      if (!player?.isAlive?.()) {
        index += 1;
        continue;
      }

      const gpm = getGoldPerMinuteForPlayer(player, index);
      if (!Number.isFinite(gpm)) {
        index += 1;
        continue;
      }

      rows.push({
        player,
        gpm,
        team: getPlayerTeamName(player),
        name: getPlayerDisplayName(player),
      });
      index += 1;
    }

    return rows
      .sort((a, b) => b.gpm - a.gpm)
      .slice(0, 10);
  }

  function updateTeamGoldPerMinuteBadge() {
    const badge = ensureTeamGoldPerMinuteBadge();
    if (!teamGoldPerMinuteEnabled) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      teamGoldPerMinuteRenderSignature = "";
      return;
    }

    const context = getOpenFrontGameContext();
    if (!context?.game) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      teamGoldPerMinuteRenderSignature = "";
      return;
    }

    sampleGoldPerMinuteIfDue();
    const rows = getTeamGoldPerMinuteRows(context.game);
    if (rows.length < 2) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      teamGoldPerMinuteRenderSignature = "";
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

      if (teamGoldPerMinuteRenderSignature !== nextSignature) {
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
        teamGoldPerMinuteRenderSignature = nextSignature;
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

  function updateTopGoldPerMinuteBadge() {
    const badge = ensureTopGoldPerMinuteBadge();
    if (!topGoldPerMinuteEnabled) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        markHelperStatsLayoutDirty();
      }
      topGoldPerMinuteRenderSignature = "";
      return;
    }

    const context = getOpenFrontGameContext();
    if (!context?.game) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        markHelperStatsLayoutDirty();
      }
      topGoldPerMinuteRenderSignature = "";
      return;
    }

    sampleGoldPerMinuteIfDue();
    const rows = getTopGoldPerMinuteRows(context.game);
    const rowsContainer = badge.querySelector(".openfront-helper-top-gpm-rows");
    if (rowsContainer) {
      const rowData = rows.map((entry, index) => ({
        rank: String(index + 1),
        name: entry.name,
        value: formatGoldPerMinute(entry.gpm),
        color: entry.team ? getTeamColor(entry.team, context.game) : "",
      }));
      const nextSignature =
        rows.length === 0
          ? "empty"
          : rowData
              .map((entry) => `${entry.rank}|${entry.name}|${entry.color}|${entry.value}`)
              .join(";");

      if (rows.length === 0) {
        if (topGoldPerMinuteRenderSignature !== nextSignature) {
          rowsContainer.innerHTML = `<span class="openfront-helper-top-gpm-empty">Tracking player income</span>`;
          topGoldPerMinuteRenderSignature = nextSignature;
          markHelperStatsLayoutDirty();
        }
      } else if (topGoldPerMinuteRenderSignature !== nextSignature) {
        rowsContainer.replaceChildren(
          ...rowData.map((entry) => {
            const row = document.createElement("span");
            row.className = "openfront-helper-top-gpm-row";
            if (entry.color) {
              row.style.setProperty("--team-accent-color", entry.color);
            } else {
              row.style.removeProperty("--team-accent-color");
            }

            const rank = document.createElement("span");
            rank.className = "openfront-helper-top-gpm-rank";
            rank.textContent = entry.rank;
            const name = document.createElement("span");
            name.className = "openfront-helper-top-gpm-name";
            name.textContent = entry.name;
            const value = document.createElement("span");
            value.className = "openfront-helper-top-gpm-value";
            value.textContent = entry.value;
            row.append(rank, name, value);
            return row;
          }),
        );
        topGoldPerMinuteRenderSignature = nextSignature;
        markHelperStatsLayoutDirty();
      }
    }

    if (badge.dataset.visible !== "true") {
      badge.dataset.visible = "true";
      markHelperStatsLayoutDirty();
    }
    syncHelperStatsLayoutIfDirty();
  }

  function updateGoldPerMinuteBadge() {
    const badge = ensureGoldPerMinuteBadge();
    if (!goldPerMinuteEnabled) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      goldPerMinuteRenderSignature = "";
      return;
    }

    const overlay = getHoveredPlayerInfoOverlay();
    if (!overlay) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      goldPerMinuteRenderSignature = "";
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

    if (goldPerMinuteRenderSignature !== nextSignature) {
      goldPerMinuteRenderSignature = nextSignature;
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

  function setGoldPerMinuteEnabled(enabled) {
    goldPerMinuteEnabled = Boolean(enabled);
    if (!goldPerMinuteEnabled) {
      if (goldPerMinuteInterval !== null) {
        clearInterval(goldPerMinuteInterval);
      }
      goldPerMinuteInterval = null;
      goldPerMinuteAnimationFrame = null;
      lastGoldPerMinuteRenderAt = 0;
      goldPerMinuteRenderSignature = "";
      unregisterHelperTickListener(updateGoldPerMinuteBadge);
      if (!teamGoldPerMinuteEnabled && !topGoldPerMinuteEnabled && !economyHeatmapEnabled) {
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        lastProcessedIncomingGoldTransferTick = null;
      }
      const badge = document.getElementById(GOLD_PER_MINUTE_BADGE_ID);
      if (badge) {
        badge.dataset.visible = "false";
      }
      syncHelperStatsContainerVisibility();
      return;
    }

    sampleGoldPerMinute();
    if (goldPerMinuteInterval === null) {
      goldPerMinuteInterval = setInterval(
        sampleGoldPerMinute,
        GOLD_PER_MINUTE_SAMPLE_MS,
      );
    }
    registerHelperTickListener(updateGoldPerMinuteBadge);
  }

  function setTeamGoldPerMinuteEnabled(enabled) {
    teamGoldPerMinuteEnabled = Boolean(enabled);
    if (!teamGoldPerMinuteEnabled) {
      teamGoldPerMinuteAnimationFrame = null;
      lastTeamGoldPerMinuteRenderAt = 0;
      teamGoldPerMinuteRenderSignature = "";
      unregisterHelperTickListener(updateTeamGoldPerMinuteBadge);
      const badge = document.getElementById(TEAM_GOLD_PER_MINUTE_BADGE_ID);
      if (badge) {
        badge.dataset.visible = "false";
      }
      if (!goldPerMinuteEnabled && !topGoldPerMinuteEnabled && !economyHeatmapEnabled) {
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        lastProcessedIncomingGoldTransferTick = null;
      }
      syncHelperStatsContainerVisibility();
      return;
    }

    sampleGoldPerMinute();
    registerHelperTickListener(updateTeamGoldPerMinuteBadge);
  }

  function setTopGoldPerMinuteEnabled(enabled) {
    topGoldPerMinuteEnabled = Boolean(enabled);
    if (!topGoldPerMinuteEnabled) {
      topGoldPerMinuteAnimationFrame = null;
      lastTopGoldPerMinuteRenderAt = 0;
      topGoldPerMinuteRenderSignature = "";
      unregisterHelperTickListener(updateTopGoldPerMinuteBadge);
      const badge = document.getElementById(TOP_GOLD_PER_MINUTE_BADGE_ID);
      if (badge) {
        badge.dataset.visible = "false";
      }
      if (!goldPerMinuteEnabled && !teamGoldPerMinuteEnabled && !economyHeatmapEnabled) {
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        lastProcessedIncomingGoldTransferTick = null;
      }
      syncHelperStatsContainerVisibility();
      return;
    }

    sampleGoldPerMinute();
    registerHelperTickListener(updateTopGoldPerMinuteBadge);
  }
