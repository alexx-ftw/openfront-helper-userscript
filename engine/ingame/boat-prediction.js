// Enemy boat prediction: landing markers for transport ships.

  const BOAT_UNIT_TYPES = ["Transport"];
  const BOAT_LANDING_HOVER_RADIUS_PX = 18;
  const BOAT_LANDING_HOVER_RADIUS_SQUARED =
    BOAT_LANDING_HOVER_RADIUS_PX * BOAT_LANDING_HOVER_RADIUS_PX;
  const BOAT_PREDICTION_SCAN_MS = 1000;
  let boatLandingMouseX = -9999;
  let boatLandingMouseY = -9999;
  let boatMouseListenerInstalled = false;
  let lastBoatPredictionScanAt = 0;
  let boatPredictionTransports = [];
  const boatPredictionDomCache = new Map();
  let boatPredictionHoverElements = null;

  function ensureBoatLandingStyles() {
    if (document.getElementById(BOAT_LANDING_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = BOAT_LANDING_STYLE_ID;
    style.textContent = `
      #${BOAT_LANDING_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: none;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker {
        position: fixed;
        left: 0;
        top: 0;
        width: 20px;
        height: 20px;
        border: 2px solid var(--boat-color);
        border-radius: 50%;
        background: var(--boat-bg);
        box-shadow: 0 0 4px var(--boat-color);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::before,
      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        background: var(--boat-color);
        transform: translate(-50%, -50%);
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::before {
        width: 14px;
        height: 2px;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::after {
        width: 2px;
        height: 14px;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-label {
        position: fixed;
        left: 0;
        top: 0;
        padding: 3px 7px;
        border: 1px solid var(--boat-color);
        border-radius: 8px;
        background: rgba(7, 12, 18, 0.86);
        color: var(--boat-color);
        font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-label-ty, 0px), 0) translate(-50%, -100%);
        will-change: transform;
        white-space: nowrap;
      }

      @keyframes openfront-helper-boat-highlight-pulse {
        0%, 100% { box-shadow: 0 0 6px var(--boat-color), 0 0 12px var(--boat-color); }
        50% { box-shadow: 0 0 10px var(--boat-color), 0 0 18px var(--boat-color); opacity: 0.78; }
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-highlight {
        position: fixed;
        left: 0;
        top: 0;
        width: 28px;
        height: 28px;
        border: 2.5px solid var(--boat-color);
        border-radius: 50%;
        background: var(--boat-bg);
        box-shadow: 0 0 6px var(--boat-color);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
        animation: openfront-helper-boat-highlight-pulse 1.1s ease-in-out infinite;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-hover-svg {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
        pointer-events: none;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-route-polyline {
        fill: none;
        stroke-width: 2;
        stroke-dasharray: 4 3;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0.68;
      }

    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBoatLandingContainer() {
    ensureBoatLandingStyles();

    let container = document.getElementById(BOAT_LANDING_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = BOAT_LANDING_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function ensureBoatMouseListener() {
    if (boatMouseListenerInstalled) {
      return;
    }
    boatMouseListenerInstalled = true;
    document.addEventListener(
      "mousemove",
      (e) => {
        boatLandingMouseX = e.clientX;
        boatLandingMouseY = e.clientY;
      },
      { passive: true },
    );
  }

  function ensureBoatHoverLineSvg(container) {
    let svg = container.querySelector(".openfront-helper-boat-hover-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-boat-hover-svg");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function getBoatRouteScreenPoints(game, transform, unit, motionPlanUnitId, boatScreenPos, landingScreenPos) {
    const points = [];

    if (boatScreenPos) {
      points.push({ x: boatScreenPos.x, y: boatScreenPos.y });
    }

    try {
      if (Number.isFinite(motionPlanUnitId)) {
        const plan = game?.motionPlans?.()?.get(motionPlanUnitId);
        if (plan?.path && plan.path.length > 0) {
          const path = plan.path;
          const currentTick = Number(game?.ticks?.());
          const elapsed = Number.isFinite(currentTick) ? currentTick - plan.startTick : 0;
          const currentStep = Math.max(
            0,
            Math.min(
              Math.floor(elapsed / Math.max(1, plan.ticksPerStep)),
              path.length - 1,
            ),
          );
          const remainingLength = path.length - currentStep;
          const maxSamples = 40;
          const sampleStep = Math.max(1, Math.floor(remainingLength / maxSamples));

          for (let i = currentStep; i < path.length; i += sampleStep) {
            const pt = toScreenPoint(game, transform, path[i]);
            if (pt) {
              points.push({ x: pt.x, y: pt.y });
            }
          }
        }
      }
    } catch (_error) {
      // Fall back to direct line if route unavailable.
    }

    if (landingScreenPos) {
      points.push({ x: landingScreenPos.x, y: landingScreenPos.y });
    }

    return points;
  }

  function getBoatPredictionRelation(game, unit) {
    const owner = unit?.owner?.();
    const relation = getPlayerRelationToMyPlayer(game, owner);
    return relation === "enemy" || relation === "ally" ? relation : null;
  }

  function getBoatPredictionColors(relation, targeting) {
    if (relation === "ally") {
      return {
        color: "rgba(74, 222, 128, 0.95)",
        bg: "rgba(20, 83, 45, 0.2)",
      };
    }

    return {
      color: targeting ? "rgba(248, 113, 113, 0.95)" : "rgba(250, 204, 21, 0.95)",
      bg: targeting ? "rgba(127, 29, 29, 0.22)" : "rgba(113, 90, 0, 0.18)",
    };
  }

  function isBoatTargetingMyPlayer(game, targetTile) {
    try {
      const myPlayer = game?.myPlayer?.();
      if (!myPlayer?.isPlayer?.()) {
        return false;
      }
      const ownerId = game.ownerID?.(targetTile);
      return Number(ownerId) === Number(myPlayer.smallID?.());
    } catch (_error) {
      return false;
    }
  }

  function asFiniteTileRef(value) {
    const tile = Number(value);
    return Number.isFinite(tile) ? tile : null;
  }

  function getBoatTargetTile(unit) {
    return asFiniteTileRef(unit?.targetTile?.());
  }

  function getBoatOwnerLabel(unit) {
    const owner = unit?.owner?.();
    if (!owner) {
      return "Unknown";
    }

    let name = "Unknown";
    try {
      name = typeof getPlayerDisplayName === "function"
        ? getPlayerDisplayName(owner)
        : String(owner.displayName?.() ?? owner.name?.() ?? "Unknown");
    } catch (_error) {
      name = "Unknown";
    }

    const compactName = String(name || "Unknown").trim();
    if (compactName.length <= 18) {
      return compactName;
    }
    return `${compactName.slice(0, 17)}...`;
  }

  // Reused screen-point objects. toScreenPoint is called once per visible
  // transport per frame; a fresh allocation each call piled up GC pressure
  // during panning. Three slots cover landing-pos + boat-pos + one-off uses
  // within a single frame; callers must not retain references across yields.
  const _screenPointPool = [
    { x: 0, y: 0, worldX: 0, worldY: 0 },
    { x: 0, y: 0, worldX: 0, worldY: 0 },
    { x: 0, y: 0, worldX: 0, worldY: 0 },
  ];
  let _screenPointPoolIndex = 0;
  const _toScreenPointQueryArg = { x: 0, y: 0 };

  function resetScreenPointPool() {
    _screenPointPoolIndex = 0;
  }

  function toScreenPoint(game, transform, tile) {
    if (tile == null) {
      return null;
    }
    try {
      const worldX = game.x(tile);
      const worldY = game.y(tile);
      return toScreenPointFromWorld(transform, worldX, worldY);
    } catch (_error) {
      return null;
    }
  }

  // Fast-path variant that skips the game.x/game.y proxy calls when callers
  // have pre-resolved world coords (boat scan, nuke scan).
  function toScreenPointFromWorld(transform, worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
      return null;
    }
    try {
      _toScreenPointQueryArg.x = worldX;
      _toScreenPointQueryArg.y = worldY;
      const point = transform.worldToScreenCoordinates(_toScreenPointQueryArg);
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        return null;
      }
      const slot = _screenPointPool[
        _screenPointPoolIndex % _screenPointPool.length
      ];
      _screenPointPoolIndex += 1;
      slot.x = point.x;
      slot.y = point.y;
      slot.worldX = worldX;
      slot.worldY = worldY;
      return slot;
    } catch (_error) {
      return null;
    }
  }

  function isNearViewport(point, padding = 220) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      return false;
    }
    return (
      point.x >= -padding &&
      point.y >= -padding &&
      point.x <= window.innerWidth + padding &&
      point.y <= window.innerHeight + padding
    );
  }

  function collectBoatPredictionTransports(game) {
    const transports = [];

    for (const unit of game.units(...BOAT_UNIT_TYPES)) {
      if (!unit?.isActive?.()) {
        continue;
      }

      const relation = getBoatPredictionRelation(game, unit);
      if (!relation) {
        continue;
      }

      try {
        if (unit.retreating?.()) {
          continue;
        }
      } catch (_error) {
        // ignore
      }

      const targetTile = getBoatTargetTile(unit);
      if (targetTile === null) {
        continue;
      }

      const targeting = isBoatTargetingMyPlayer(game, targetTile);
      const { color, bg } = getBoatPredictionColors(relation, targeting);
      const labelPrefix = relation === "ally" ? tr("Ally landing") : targeting ? tr("Landing!") : tr("Landing");
      const labelText = `${labelPrefix} · ${getBoatOwnerLabel(unit)}`;
      const unitId = String(unit.id?.() ?? `target:${targetTile}`);
      const motionPlanUnitId = Number(unit.id?.());

      transports.push({
        domUnitId: unitId,
        motionPlanUnitId: Number.isFinite(motionPlanUnitId) ? motionPlanUnitId : null,
        unit,
        targetTile,
        // Target world coords are fixed per transport; cache once per scan.
        targetWorldX: game.x(targetTile),
        targetWorldY: game.y(targetTile),
        color,
        bg,
        labelText,
      });
    }

    return transports;
  }

  function clearBoatPredictionDomCache() {
    boatPredictionDomCache.clear();
    boatPredictionHoverElements = null;
  }

  function getBoatPredictionDomEntry(container, transport) {
    let entry = boatPredictionDomCache.get(transport.domUnitId);
    if (!entry) {
      const marker = document.createElement("div");
      marker.className = "openfront-helper-boat-marker";
      marker.dataset.boatId = `${transport.domUnitId}-marker`;
      container.appendChild(marker);

      entry = {
        marker,
        signature: "",
        visible: true,
        markerX: "",
        markerY: "",
      };
      boatPredictionDomCache.set(transport.domUnitId, entry);
    }

    const signature = `${transport.color}|${transport.bg}`;
    if (entry.signature !== signature) {
      entry.marker.style.setProperty("--boat-color", transport.color);
      entry.marker.style.setProperty("--boat-bg", transport.bg);
      entry.signature = signature;
    }

    return entry;
  }

  function setBoatPredictionEntryVisible(entry, visible) {
    if (entry.visible === visible) {
      return;
    }
    entry.marker.hidden = !visible;
    entry.visible = visible;
  }

  function updateBoatPredictionEntryPosition(entry, screenPos) {
    // Positions are baked into translate3d via CSS variables, not left/top.
    // Avoids per-frame paint invalidation of the marker (with its box-shadow)
    // when the camera pans.
    const x = `${screenPos.x}px`;
    const y = `${screenPos.y}px`;

    if (entry.markerX !== x) {
      entry.marker.style.setProperty("--boat-tx", x);
      entry.markerX = x;
    }
    if (entry.markerY !== y) {
      entry.marker.style.setProperty("--boat-ty", y);
      entry.markerY = y;
    }
  }

  function cleanupBoatPredictionDomCache(activeTransportIds) {
    for (const [domUnitId, entry] of boatPredictionDomCache) {
      if (!activeTransportIds.has(domUnitId)) {
        entry.marker.remove();
        boatPredictionDomCache.delete(domUnitId);
      }
    }
  }

  function clearBoatPredictionHoverElements() {
    if (!boatPredictionHoverElements) {
      return;
    }
    boatPredictionHoverElements.highlight?.remove();
    boatPredictionHoverElements.label?.remove();
    boatPredictionHoverElements.routeLine?.remove();
    boatPredictionHoverElements = null;
  }

  function getBoatPredictionHoverElements(container, routeSvg) {
    if (!boatPredictionHoverElements) {
      const highlight = document.createElement("div");
      highlight.className = "openfront-helper-boat-highlight";
      container.appendChild(highlight);

      const label = document.createElement("div");
      label.className = "openfront-helper-boat-label";
      container.appendChild(label);

      const routeLine = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      routeLine.classList.add("openfront-helper-boat-route-polyline");
      routeLine.style.filter = "none";
      routeSvg.appendChild(routeLine);

      boatPredictionHoverElements = {
        highlight,
        label,
        routeLine,
      };
    }

    return boatPredictionHoverElements;
  }

  function syncBoatPrediction() {
    if (!boatPredictionEnabled) {
      document.getElementById(BOAT_LANDING_CONTAINER_ID)?.remove();
      boatLandingAnimationFrame = null;
      lastBoatPredictionScanAt = 0;
      boatPredictionTransports = [];
      clearBoatPredictionDomCache();
      return;
    }

    const container = ensureBoatLandingContainer();
    ensureBoatMouseListener();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      container.replaceChildren();
      lastBoatPredictionScanAt = 0;
      boatPredictionTransports = [];
      clearBoatPredictionDomCache();
      boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
      return;
    }

    const now = Date.now();
    if (!lastBoatPredictionScanAt || now - lastBoatPredictionScanAt >= BOAT_PREDICTION_SCAN_MS) {
      boatPredictionTransports = collectBoatPredictionTransports(context.game);
      const scanIds = new Set();
      for (const transport of boatPredictionTransports) {
        scanIds.add(transport.domUnitId);
      }
      cleanupBoatPredictionDomCache(scanIds);
      lastBoatPredictionScanAt = now;
    }

    resetScreenPointPool();

    const visibleTransportIds = new Set();
    // Track the hovered transport inline (no transportHoverData allocation).
    // Stable landing coordinates are captured here so the pool can be reused.
    let hoveredTransport = null;
    let hoveredLandingX = 0;
    let hoveredLandingY = 0;

    for (let i = 0; i < boatPredictionTransports.length; i += 1) {
      const transport = boatPredictionTransports[i];
      // Use pre-resolved world coords from the scan; avoids two proxy calls
      // (game.x, game.y) per transport per pan frame.
      const screenPos = toScreenPointFromWorld(
        context.transform,
        transport.targetWorldX,
        transport.targetWorldY,
      );
      if (!isNearViewport(screenPos, 200)) {
        continue;
      }

      visibleTransportIds.add(transport.domUnitId);
      const entry = getBoatPredictionDomEntry(container, transport);
      setBoatPredictionEntryVisible(entry, true);
      updateBoatPredictionEntryPosition(entry, screenPos);

      if (!hoveredTransport) {
        const dx = screenPos.x - boatLandingMouseX;
        const dy = screenPos.y - boatLandingMouseY;
        if (dx * dx + dy * dy <= BOAT_LANDING_HOVER_RADIUS_SQUARED) {
          hoveredTransport = transport;
          hoveredLandingX = screenPos.x;
          hoveredLandingY = screenPos.y;
        }
      }
    }

    for (const [domUnitId, entry] of boatPredictionDomCache) {
      if (!visibleTransportIds.has(domUnitId)) {
        setBoatPredictionEntryVisible(entry, false);
      }
    }

    if (hoveredTransport) {
      const routeSvg = ensureBoatHoverLineSvg(container);
      const { motionPlanUnitId, unit, color, bg, labelText } = hoveredTransport;
      const boatScreenPosPooled = toScreenPoint(
        context.game,
        context.transform,
        asFiniteTileRef(unit?.tile?.()),
      );
      // Capture stable copies of pool coords before getBoatRouteScreenPoints
      // can recycle pool slots via its internal toScreenPoint calls.
      const hasBoatScreenPos = boatScreenPosPooled != null;
      const boatX = hasBoatScreenPos ? boatScreenPosPooled.x : 0;
      const boatY = hasBoatScreenPos ? boatScreenPosPooled.y : 0;
      const landingScreenPosLiteral = {
        x: hoveredLandingX,
        y: hoveredLandingY,
      };
      const boatScreenPosLiteral = hasBoatScreenPos
        ? { x: boatX, y: boatY }
        : null;
      const routePoints = getBoatRouteScreenPoints(
        context.game,
        context.transform,
        unit,
        motionPlanUnitId,
        boatScreenPosLiteral,
        landingScreenPosLiteral,
      );

      const hoverElements = getBoatPredictionHoverElements(container, routeSvg);
      hoverElements.label.hidden = false;
      hoverElements.label.style.setProperty("--boat-tx", `${hoveredLandingX}px`);
      hoverElements.label.style.setProperty("--boat-label-ty", `${hoveredLandingY - 16}px`);
      hoverElements.label.style.setProperty("--boat-color", color);
      hoverElements.label.textContent = labelText;

      if (hasBoatScreenPos) {
        hoverElements.highlight.hidden = false;
        hoverElements.highlight.style.setProperty("--boat-tx", `${boatX}px`);
        hoverElements.highlight.style.setProperty("--boat-ty", `${boatY}px`);
        hoverElements.highlight.style.setProperty("--boat-color", color);
        hoverElements.highlight.style.setProperty("--boat-bg", bg);
      } else {
        hoverElements.highlight.hidden = true;
      }

      if (routePoints.length >= 2) {
        hoverElements.routeLine.hidden = false;
        let pointsAttr = "";
        for (let i = 0; i < routePoints.length; i += 1) {
          const p = routePoints[i];
          pointsAttr += i === 0 ? `${p.x},${p.y}` : ` ${p.x},${p.y}`;
        }
        hoverElements.routeLine.setAttribute("points", pointsAttr);
        hoverElements.routeLine.style.stroke = color;
      } else {
        hoverElements.routeLine.hidden = true;
      }
    } else {
      clearBoatPredictionHoverElements();
    }

    boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
  }

  function setBoatPredictionEnabled(enabled) {
    boatPredictionEnabled = Boolean(enabled);
    if (!boatPredictionEnabled) {
      if (boatLandingAnimationFrame !== null) {
        cancelAnimationFrame(boatLandingAnimationFrame);
      }
      boatLandingAnimationFrame = null;
      lastBoatPredictionScanAt = 0;
      boatPredictionTransports = [];
      clearBoatPredictionDomCache();
      document.getElementById(BOAT_LANDING_CONTAINER_ID)?.remove();
      return;
    }

    if (boatLandingAnimationFrame === null) {
      syncBoatPrediction();
    }
  }
