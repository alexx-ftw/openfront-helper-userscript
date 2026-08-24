// Bot marker overlay for nation AI players.

  function ensureBotMarkerStyles() {
    if (document.getElementById(BOT_MARKER_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = BOT_MARKER_STYLE_ID;
    style.textContent = `
      #${BOT_MARKER_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 9000;
        pointer-events: none;
      }

      #${BOT_MARKER_CONTAINER_ID} .openfront-helper-bot-dot {
        position: fixed;
        width: 13px;
        height: 13px;
        margin: -6.5px 0 0 -6.5px;
        border-radius: 50%;
        background: rgba(239, 68, 68, 0.68);
        box-shadow:
          0 0 0 2px rgba(127, 29, 29, 0.34),
          0 0 10px rgba(239, 68, 68, 0.72);
        transform: translate(var(--bot-x), var(--bot-y));
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBotMarkerContainer() {
    ensureBotMarkerStyles();

    let container = document.getElementById(BOT_MARKER_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = BOT_MARKER_CONTAINER_ID;
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  // DOM-element cache keyed by player marker id. Eliminates the O(N) per-marker
  // container.querySelector and the O(N) container.querySelectorAll sweep that
  // ran every frame. With 40 bots this was ~1600 DOM lookups per frame at 60Hz.
  const botMarkerEntries = new Map();
  // Cached active-bot list. Refreshed on a slower cadence than per-frame; the
  // expensive proxy calls (playerViews, isAlive, isNationBot, nameLocation,
  // getPlayerMarkerId) only run during a scan.
  let botMarkerScanCache = [];
  let lastBotMarkerScanAt = 0;
  const BOT_MARKER_SCAN_MS = 500;

  function collectBotMarkerScan(game) {
    const players = getCachedPlayerViews(game);
    const result = [];
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (!isNationBotPlayer(player) || !player?.isAlive?.()) {
        continue;
      }
      const markerId = getPlayerMarkerId(player, index);
      result.push({ player, markerId });
    }
    return result;
  }

  function pruneBotMarkerCache() {
    const activeIds = new Set();
    for (const entry of botMarkerScanCache) {
      activeIds.add(entry.markerId);
    }
    for (const [markerId, entry] of botMarkerEntries) {
      if (!activeIds.has(markerId)) {
        entry.marker.remove();
        botMarkerEntries.delete(markerId);
      }
    }
  }

  function ensureBotMarkerEntry(container, markerId) {
    let entry = botMarkerEntries.get(markerId);
    if (entry) {
      return entry;
    }
    const marker = document.createElement("div");
    marker.className = "openfront-helper-bot-dot";
    marker.dataset.botId = markerId;
    container.appendChild(marker);
    entry = { marker, x: NaN, y: NaN, hidden: false };
    botMarkerEntries.set(markerId, entry);
    return entry;
  }

  function hideBotMarkerEntry(entry) {
    if (!entry.hidden) {
      entry.marker.hidden = true;
      entry.hidden = true;
    }
  }

  function resetBotMarkers(removeContainer = false) {
    if (removeContainer) document.getElementById(BOT_MARKER_CONTAINER_ID)?.remove();
    for (const entry of botMarkerEntries.values()) entry.marker.remove();
    botMarkerEntries.clear();
    botMarkerScanCache = [];
    lastBotMarkerScanAt = 0;
  }

  function scheduleBotMarkerFrame() {
    runtimeState.botMarkerAnimationFrame = requestAnimationFrame(syncBotMarkers);
  }

  function botMarkerScreenPosition(context, player) {
    const nameLocation = player.nameLocation?.();
    if (!nameLocation) return null;
    const screenPosition = context.transform.worldToScreenCoordinates(nameLocation);
    if (!Number.isFinite(screenPosition?.x) || !Number.isFinite(screenPosition?.y)) {
      return null;
    }
    const margin = 30;
    if (
      screenPosition.x < -margin ||
      screenPosition.y < -margin ||
      screenPosition.x > window.innerWidth + margin ||
      screenPosition.y > window.innerHeight + margin
    ) {
      return null;
    }
    return screenPosition;
  }

  function renderBotMarkerEntry(context, container, scanEntry) {
    const screenPosition = botMarkerScreenPosition(context, scanEntry.player);
    if (!screenPosition) {
      const existing = botMarkerEntries.get(scanEntry.markerId);
      if (existing) hideBotMarkerEntry(existing);
      return;
    }
    const entry = ensureBotMarkerEntry(container, scanEntry.markerId);
    if (entry.hidden) {
      entry.marker.hidden = false;
      entry.hidden = false;
    }
    if (entry.x !== screenPosition.x) {
      entry.marker.style.setProperty("--bot-x", `${screenPosition.x}px`);
      entry.x = screenPosition.x;
    }
    if (entry.y !== screenPosition.y) {
      entry.marker.style.setProperty("--bot-y", `${screenPosition.y}px`);
      entry.y = screenPosition.y;
    }
  }

  function syncBotMarkers() {
    if (!runtimeState.botMarkersEnabled) {
      resetBotMarkers(true);
      runtimeState.botMarkerAnimationFrame = null;
      return;
    }

    const context = getOpenFrontGameContext();
    const container = ensureBotMarkerContainer();
    if (!context) {
      resetBotMarkers();
      scheduleBotMarkerFrame();
      return;
    }

    const now = performance.now();
    if (now - lastBotMarkerScanAt >= BOT_MARKER_SCAN_MS) {
      botMarkerScanCache = collectBotMarkerScan(context.game);
      pruneBotMarkerCache();
      lastBotMarkerScanAt = now;
    }

    for (const scanEntry of botMarkerScanCache) {
      renderBotMarkerEntry(context, container, scanEntry);
    }

    scheduleBotMarkerFrame();
  }

  function setBotMarkersEnabled(enabled) {
    runtimeState.botMarkersEnabled = Boolean(enabled);
    if (!runtimeState.botMarkersEnabled) {
      if (runtimeState.botMarkerAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.botMarkerAnimationFrame);
      }
      runtimeState.botMarkerAnimationFrame = null;
      resetBotMarkers(true);
      return;
    }

    if (runtimeState.botMarkerAnimationFrame === null) {
      syncBotMarkers();
    }
  }
