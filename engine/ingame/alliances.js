// Alliance marker overlay and ally-duration display.

  // Marker membership changes infrequently, but positions are refreshed every
  // frame. Keep the DOM nodes indexed by ally id so the hot path does not run
  // two querySelector calls per ally on every animation frame.
  const allyMarkerElements = new Map();
  const allyLineElements = new Map();
  const allyElementRenderStates = new WeakMap();

  function ensureAllyMarkerStyles() {
    if (document.getElementById(ALLY_MARKER_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = ALLY_MARKER_STYLE_ID;
    style.textContent = `
      #${ALLY_MARKER_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 9000;
        pointer-events: none;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-lines {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-line {
        stroke: rgba(34, 197, 94, 0.58);
        stroke-width: 2.5;
        stroke-linecap: round;
        filter: drop-shadow(0 0 5px rgba(34, 197, 94, 0.72));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot {
        position: fixed;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        width: max-content;
        margin: -7.5px 0 0 -50px;
        color: #dcfce7;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 10px;
        font-weight: 900;
        line-height: 1;
        text-align: center;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92);
        transform: translate(var(--ally-x), var(--ally-y));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot::before {
        content: "";
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: rgba(34, 197, 94, 0.72);
        box-shadow:
          0 0 0 2px rgba(20, 83, 45, 0.38),
          0 0 13px rgba(34, 197, 94, 0.78);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-time {
        display: grid;
        gap: 2px;
        min-width: 100px;
        padding: 4px 6px;
        border: 1px solid rgba(134, 239, 172, 0.34);
        border-radius: 8px;
        background: rgba(5, 46, 22, 0.78);
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-time span {
        white-space: nowrap;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-label {
        color: rgba(220, 252, 231, 0.82);
        font-size: 9px;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-line.openfront-helper-ally-warning {
        stroke: rgba(249, 115, 22, 0.68);
        filter: drop-shadow(0 0 5px rgba(249, 115, 22, 0.76));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning {
        color: #ffedd5;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning::before {
        background: rgba(249, 115, 22, 0.76);
        box-shadow:
          0 0 0 2px rgba(154, 52, 18, 0.4),
          0 0 13px rgba(249, 115, 22, 0.82);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning .openfront-helper-ally-time {
        border-color: rgba(253, 186, 116, 0.42);
        background: rgba(67, 20, 7, 0.82);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning .openfront-helper-ally-label {
        color: rgba(255, 237, 213, 0.84);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-line.openfront-helper-ally-critical {
        stroke: rgba(239, 68, 68, 0.72);
        filter: drop-shadow(0 0 5px rgba(239, 68, 68, 0.82));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical {
        color: #fee2e2;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical::before {
        background: rgba(239, 68, 68, 0.82);
        box-shadow:
          0 0 0 2px rgba(127, 29, 29, 0.44),
          0 0 13px rgba(239, 68, 68, 0.86);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical .openfront-helper-ally-time {
        border-color: rgba(252, 165, 165, 0.46);
        background: rgba(69, 10, 10, 0.84);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical .openfront-helper-ally-label {
        color: rgba(254, 226, 226, 0.86);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAllyMarkerContainer() {
    ensureAllyMarkerStyles();

    let container = document.getElementById(ALLY_MARKER_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = ALLY_MARKER_CONTAINER_ID;
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function ensureAllyLineSvg(container) {
    let svg = container.querySelector(".openfront-helper-ally-lines");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-ally-lines");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function isAlliedPlayer(player, otherPlayer) {
    {
      return player !== otherPlayer && Boolean(player?.isAlliedWith?.(otherPlayer));
    }
  }

  function getAllianceView(player, otherPlayer) {
    {
      return Array.from(player?.alliances?.() || []).find(
        (alliance) => alliance?.other === otherPlayer?.id?.(),
      );
    }
  }

  function formatAllianceDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }

  function getAllianceUrgencyClass(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) {
      return "";
    }
    if (totalSeconds < 30) {
      return "openfront-helper-ally-critical";
    }
    if (totalSeconds <= 60) {
      return "openfront-helper-ally-warning";
    }
    return "";
  }

  function getAllianceTimingText(game, alliance) {
    const currentTick = Number(game?.ticks?.());
    const expiresAt = Number(alliance?.expiresAt);
    if (
      !Number.isFinite(currentTick) ||
      !Number.isFinite(expiresAt)
    ) {
      return {
        remaining: "unknown left",
        urgencyClass: "",
      };
    }

    const remainingSeconds = (expiresAt - currentTick) / 10;
    return {
      remaining: `${formatAllianceDuration(remainingSeconds)} left`,
      urgencyClass: getAllianceUrgencyClass(remainingSeconds),
    };
  }

  function scheduleAllyMarkerSync() {
    runtimeState.allyMarkerAnimationFrame = requestAnimationFrame(syncAllyMarkers);
  }

  function clearAllyMarkerContainer(container, lineSvg) {
    lineSvg?.replaceChildren();
    container.replaceChildren(...(lineSvg ? [lineSvg] : []));
    scheduleAllyMarkerSync();
  }

  function isAllyMarkerPositionVisible(screenPos) {
    return (
      Number.isFinite(screenPos?.x) &&
      Number.isFinite(screenPos?.y) &&
      screenPos.x >= -30 &&
      screenPos.y >= -30 &&
      screenPos.x <= window.innerWidth + 30 &&
      screenPos.y <= window.innerHeight + 30
    );
  }

  function ensureAllyLine(lineSvg, markerId) {
    const cached = allyLineElements.get(markerId);
    if (cached?.isConnected) return cached;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("openfront-helper-ally-line");
    line.dataset.allyId = markerId;
    lineSvg.appendChild(line);
    allyLineElements.set(markerId, line);
    return line;
  }

  function ensureAllyMarker(container, markerId) {
    const cached = allyMarkerElements.get(markerId);
    if (cached?.isConnected) return cached;
    const marker = document.createElement("div");
    marker.className = "openfront-helper-ally-dot";
    marker.dataset.allyId = markerId;
    marker.innerHTML = `
      <span class="openfront-helper-ally-time">
        <span class="openfront-helper-ally-label">Alliance</span>
        <span class="openfront-helper-ally-remaining"></span>
      </span>
    `;
    container.appendChild(marker);
    allyMarkerElements.set(markerId, marker);
    return marker;
  }

  function getAllyElementRenderState(element) {
    let cached = allyElementRenderStates.get(element);
    if (!cached) {
      cached = {};
      allyElementRenderStates.set(element, cached);
    }
    return cached;
  }

  function updateAllyLineCoordinate(line, cached, name, value) {
    if (cached[name] === value) return;
    line.setAttribute(name, String(value));
    cached[name] = value;
  }

  function updateAllyUrgency(element, cached, urgencyClass) {
    if (cached.urgencyClass !== urgencyClass) {
      element.classList.remove(
        "openfront-helper-ally-warning",
        "openfront-helper-ally-critical",
      );
      if (urgencyClass) element.classList.add(urgencyClass);
      cached.urgencyClass = urgencyClass;
    }
  }

  function updateAllyMarker(marker, line, timing, screenPos, hoveredScreenPos) {
    const cachedMarker = getAllyElementRenderState(marker);
    const cachedLine = getAllyElementRenderState(line);
    updateAllyLineCoordinate(line, cachedLine, "x1", hoveredScreenPos.x);
    updateAllyLineCoordinate(line, cachedLine, "y1", hoveredScreenPos.y);
    updateAllyLineCoordinate(line, cachedLine, "x2", screenPos.x);
    updateAllyLineCoordinate(line, cachedLine, "y2", screenPos.y);
    updateAllyUrgency(marker, cachedMarker, timing.urgencyClass);
    updateAllyUrgency(line, cachedLine, timing.urgencyClass);
    if (cachedMarker.remaining !== timing.remaining) {
      const remaining = marker.querySelector(".openfront-helper-ally-remaining");
      if (remaining) remaining.textContent = timing.remaining;
      cachedMarker.remaining = timing.remaining;
    }
    if (cachedMarker.x !== screenPos.x) {
      marker.style.setProperty("--ally-x", `${screenPos.x}px`);
      cachedMarker.x = screenPos.x;
    }
    if (cachedMarker.y !== screenPos.y) {
      marker.style.setProperty("--ally-y", `${screenPos.y}px`);
      cachedMarker.y = screenPos.y;
    }
  }

  function removeInactiveAllyMarkers(activeIds) {
    for (const [markerId, marker] of allyMarkerElements) {
      if (activeIds.has(markerId)) continue;
      marker.remove();
      allyMarkerElements.delete(markerId);
    }
    for (const [markerId, line] of allyLineElements) {
      if (activeIds.has(markerId)) continue;
      line.remove();
      allyLineElements.delete(markerId);
    }
  }

  function updateVisibleAllyMarkers(container, lineSvg, overlay, transform, hoveredScreenPos) {
    const activeIds = new Set();
    const players = getCachedPlayerViews(overlay.game);
    for (const [index, player] of players.entries()) {
      if (!player?.isAlive?.() || !isAlliedPlayer(overlay.player, player)) continue;
      const nameLocation = player.nameLocation?.();
      if (!nameLocation) continue;
      const screenPos = transform.worldToScreenCoordinates(nameLocation);
      if (!isAllyMarkerPositionVisible(screenPos)) continue;
      const markerId = getPlayerMarkerId(player, index);
      activeIds.add(markerId);
      const line = ensureAllyLine(lineSvg, markerId);
      const marker = ensureAllyMarker(container, markerId);
      const alliance = getAllianceView(overlay.player, player);
      const timing = getAllianceTimingText(overlay.game, alliance);
      updateAllyMarker(marker, line, timing, screenPos, hoveredScreenPos);
    }
    return activeIds;
  }

  function syncAllyMarkers() {
    if (!runtimeState.allyMarkersEnabled) {
      document.getElementById(ALLY_MARKER_CONTAINER_ID)?.remove();
      allyMarkerElements.clear();
      allyLineElements.clear();
      runtimeState.allyMarkerAnimationFrame = null;
      return;
    }

    const container = ensureAllyMarkerContainer();
    const lineSvg = ensureAllyLineSvg(container);
    const overlay = getHoveredPlayerInfoOverlay();
    const transform = overlay?.transform;
    if (!overlay?.game || !transform) {
      clearAllyMarkerContainer(container);
      return;
    }

    const hoveredNameLocation = overlay.player?.nameLocation?.();
    if (!hoveredNameLocation) {
      clearAllyMarkerContainer(container, lineSvg);
      return;
    }

    const hoveredScreenPos =
      transform.worldToScreenCoordinates(hoveredNameLocation);
    if (!isAllyMarkerPositionVisible(hoveredScreenPos)) {
      clearAllyMarkerContainer(container, lineSvg);
      return;
    }

    const activeIds = updateVisibleAllyMarkers(
      container,
      lineSvg,
      overlay,
      transform,
      hoveredScreenPos,
    );
    removeInactiveAllyMarkers(activeIds);
    scheduleAllyMarkerSync();
  }

  function setAllyMarkersEnabled(enabled) {
    runtimeState.allyMarkersEnabled = Boolean(enabled);
    if (!runtimeState.allyMarkersEnabled) {
      if (runtimeState.allyMarkerAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.allyMarkerAnimationFrame);
      }
      runtimeState.allyMarkerAnimationFrame = null;
      document.getElementById(ALLY_MARKER_CONTAINER_ID)?.remove();
      allyMarkerElements.clear();
      allyLineElements.clear();
      return;
    }

    if (runtimeState.allyMarkerAnimationFrame === null) {
      syncAllyMarkers();
    }
  }
