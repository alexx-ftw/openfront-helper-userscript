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
  let _boatFrameCounter = 0;
  let boatPredictionTransports = [];

  // Canvas-based rendering (Blon pattern). Set true to replace DOM/SVG completely.
  var _boatUseCanvas = true;
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
        z-index: 8000;
        pointer-events: none;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker {
        position: fixed;
        left: 0;
        top: 0;
        width: 14px;
        height: 14px;
        border: 2px solid var(--boat-color);
        border-radius: 50%;
        background: var(--boat-bg);
        box-shadow: 0 0 3px var(--boat-color);
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
        width: 10px;
        height: 1.5px;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::after {
        width: 1.5px;
        height: 10px;
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
        width: 20px;
        height: 20px;
        border: 2px solid var(--boat-color);
        border-radius: 50%;
        background: var(--boat-bg);
        box-shadow: 0 0 4px var(--boat-color);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
        animation: openfront-helper-boat-highlight-pulse 1.1s ease-in-out infinite;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-highlight.is-strong {
        width: 34px;
        height: 34px;
        border-width: 3.5px;
        box-shadow: 0 0 10px var(--boat-color), 0 0 20px var(--boat-color);
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

  function ensureBoatRouteSvg(container) {
    let svg = container.querySelector(".openfront-helper-boat-hover-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-boat-hover-svg");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function appendBoatMotionPlanPoints(points, game, transform, motionPlanUnitId) {
    if (!Number.isFinite(motionPlanUnitId)) return;
    const plan = game?.motionPlans?.()?.get(motionPlanUnitId);
    if (!plan?.path?.length) return;
    const currentTick = Number(game?.ticks?.());
    const elapsed = Number.isFinite(currentTick) ? currentTick - plan.startTick : 0;
    const currentStep = Math.max(0, Math.min(
      Math.floor(elapsed / Math.max(1, plan.ticksPerStep)), plan.path.length - 1,
    ));
    const sampleStep = Math.max(1, Math.floor((plan.path.length - currentStep) / 40));
    for (let i = currentStep; i < plan.path.length; i += sampleStep) {
      const point = toScreenPoint(game, transform, plan.path[i]);
      if (point) points.push({ x: point.x, y: point.y });
    }
  }

  function getBoatRouteScreenPoints({
    game, transform, motionPlanUnitId, boatScreenPos, landingScreenPos,
  }) {
    const points = [];
    if (boatScreenPos) points.push({ x: boatScreenPos.x, y: boatScreenPos.y });
    {
      appendBoatMotionPlanPoints(points, game, transform, motionPlanUnitId);
    }
    if (landingScreenPos) points.push({ x: landingScreenPos.x, y: landingScreenPos.y });
    return points;
  }

  function isBoatPlayer(player) {
    return typeof player?.isPlayer === "function" && player.isPlayer();
  }

  function getGranularBoatRelation(myPlayer, owner) {
    if (Number(owner.smallID?.()) === Number(myPlayer.smallID?.())) return "self";
    if (myPlayer.isOnSameTeam?.(owner)) return "team";
    if (myPlayer.isAlliedWith?.(owner)) return "ally";
    if (owner.isFriendly?.(myPlayer) || myPlayer.isFriendly?.(owner)) return "ally";
    return "enemy";
  }

  function getBoatPredictionRelation(game, unit) {
    {
      const owner = unit?.owner?.();
      const myPlayer = game?.myPlayer?.();
      return isBoatPlayer(owner) && isBoatPlayer(myPlayer)
        ? getGranularBoatRelation(myPlayer, owner)
        : null;
    }
  }

  // Routes are hover-only by default. Each "always show …" sub-setting opts its
  // relation into a persistent route — but only while the prediction overlay is
  // on. The panel draws focused-boat routes independently of these flags.
  function shouldBoatRouteAlwaysShow(transport) {
    if (!runtimeState.boatPredictionEnabled) {
      return false;
    }
    switch (transport.relation) {
      case "self":
        return runtimeState.boatPredictionAlwaysOwnRoutes;
      case "team":
        return runtimeState.boatPredictionAlwaysTeamRoutes;
      case "ally":
        return runtimeState.boatPredictionAlwaysAllyRoutes;
      case "enemy":
        return runtimeState.boatPredictionAlwaysEnemyRoutes;
      default:
        return false;
    }
  }

  function getBoatPredictionColors(relation, targeting) {
    if (relation === "self") {
      return {
        color: "rgba(96, 165, 250, 0.95)",
        bg: "rgba(30, 58, 138, 0.22)",
      };
    }

    if (relation === "team") {
      return {
        color: "rgba(45, 212, 191, 0.95)",
        bg: "rgba(19, 78, 74, 0.22)",
      };
    }

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

  function isBoatOverlayActive() {
    // The shared scan/render loop runs for any consumer that needs it: the
    // prediction overlay, an open boat panel (focused routes), or the incoming
    // warning (which needs the periodic scan to spot new boats).
    return runtimeState.boatPredictionEnabled || runtimeState.boatPanelOpen || runtimeState.boatWarnIncoming;
  }

  // Remaining travel time for a transport, from the game's own motion plan (the
  // same data it uses to advance the ship). null once the plan is cleared, i.e.
  // the boat has essentially arrived.
  function getBoatMotionPlan(game, transport) {
    const id = transport?.motionPlanUnitId;
    if (!Number.isFinite(id)) return null;
    return game?.motionPlans?.()?.get(id) ?? null;
  }

  function computeBoatEtaMs(game, transport) {
    {
      const plan = getBoatMotionPlan(game, transport);
      if (!plan?.path?.length) return null;
      const endTick = plan.startTick + (plan.path.length - 1) * plan.ticksPerStep;
      const remainingTicks = endTick - Number(game?.ticks?.());
      const msPerTick = Number(game?.config?.()?.msPerTick?.()) || 100;
      return Math.max(0, remainingTicks * msPerTick);
    }
  }

  function formatBoatEta(ms) {
    if (ms == null) {
      return tr("arriving");
    }
    const totalSec = Math.max(0, Math.round(ms / 1000));
    if (totalSec < 60) {
      return `${totalSec}s`;
    }
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}m ${seconds < 10 ? "0" : ""}${seconds}s`;
  }

  function isBoatTargetingMyPlayer(game, targetTile) {
    {
      const myPlayer = game?.myPlayer?.();
      if (!myPlayer?.isPlayer?.()) {
        return false;
      }
      const ownerId = game.ownerID?.(targetTile);
      return Number(ownerId) === Number(myPlayer.smallID?.());
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

    let name;
    {
      name = typeof getPlayerDisplayName === "function"
        ? getPlayerDisplayName(owner)
        : String(owner.displayName?.() ?? owner.name?.() ?? "Unknown");
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
    {
      const worldX = game.x(tile);
      const worldY = game.y(tile);
      return toScreenPointFromWorld(transform, worldX, worldY);
    }
  }

  // Fast-path variant that skips the game.x/game.y proxy calls when callers
  // have pre-resolved world coords (boat scan, nuke scan).
  function toScreenPointFromWorld(transform, worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
      return null;
    }
    {
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

  function isBoatRetreating(unit) {
    const transportState =
      typeof unit?.transportShipState === "function"
        ? unit.transportShipState()
        : unit?.transportShipState;
    if (transportState?.isRetreating === true) return true;

    // Older/raw adapters may still expose the AttackUpdate-shaped flag.
    const retreating =
      typeof unit?.retreating === "function"
        ? unit.retreating()
        : unit?.retreating;
    return retreating === true;
  }

  function getBoatLandingLabel(relation, targeting) {
    const labels = {
      self: "Your landing",
      team: "Team landing",
      ally: "Ally landing",
      enemy: targeting ? "Landing!" : "Landing",
    };
    return tr(labels[relation] ?? labels.enemy);
  }

  function createBoatPredictionTransport(game, unit) {
    if (!unit?.isActive?.() || isBoatRetreating(unit)) return null;
    const relation = getBoatPredictionRelation(game, unit);
    if (!relation) return null;
    const targetTile = getBoatTargetTile(unit);
    if (targetTile === null) return null;
    const targetsMyTerritory = isBoatTargetingMyPlayer(game, targetTile);
    const targeting = relation === "enemy" && targetsMyTerritory;
    const { color, bg } = getBoatPredictionColors(relation, targeting);
    const ownerName = getBoatOwnerLabel(unit);
    const rawUnitId = unit.id?.();
    const motionPlanUnitId = Number(rawUnitId);
    return {
      domUnitId: String(rawUnitId ?? `target:${targetTile}`),
      motionPlanUnitId: Number.isFinite(motionPlanUnitId) ? motionPlanUnitId : null,
      unit, relation, targetTile, targetsMyTerritory, ownerName,
      targetWorldX: game.x(targetTile),
      targetWorldY: game.y(targetTile),
      color, bg,
      labelText: `${getBoatLandingLabel(relation, targeting)} · ${ownerName}`,
    };
  }

  function collectBoatPredictionTransports(game) {
    const units =
      typeof getCachedGameUnits === "function"
        ? getCachedGameUnits(game, ...BOAT_UNIT_TYPES)
        : game.units(...BOAT_UNIT_TYPES);
    return units.map((unit) => createBoatPredictionTransport(game, unit)).filter(Boolean);
  }

  function clearBoatPredictionDomCache() {
    boatPredictionDomCache.clear();
    boatPredictionHoverElements = null;
  }

  function getBoatPredictionDomEntry(container, routeSvg, transport) {
    let entry = boatPredictionDomCache.get(transport.domUnitId);
    if (!entry) {
      // Marker starts hidden: it is gated per-frame on the prediction overlay
      // being on (the panel can run the loop with the overlay off).
      const marker = document.createElement("div");
      marker.className = "openfront-helper-boat-marker";
      marker.dataset.boatId = `${transport.domUnitId}-marker`;
      marker.hidden = true;
      container.appendChild(marker);

      // Each transport owns its route polyline so several routes can show at
      // once (own boats + always-on enemy routes); hidden until a route is set.
      const routeLine = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      routeLine.classList.add("openfront-helper-boat-route-polyline");
      routeLine.style.filter = "none";
      // SVG elements have no `hidden` IDL attribute (it lives on HTMLElement),
      // so `routeLine.hidden = true` is a no-op that leaves stale lines frozen
      // on screen. Hide via CSS `display`, which does apply to SVG.
      routeLine.style.display = "none";
      routeSvg.appendChild(routeLine);

      // Per-entry highlight ring at the boat's CURRENT position, shown whenever
      // the route shows — so an always-on route also marks the boat itself, and
      // hover/focus can make it stronger.
      const highlight = document.createElement("div");
      highlight.className = "openfront-helper-boat-highlight";
      highlight.hidden = true;
      container.appendChild(highlight);

      entry = {
        marker,
        routeLine,
        highlight,
        signature: "",
        markerVisible: false,
        markerX: "",
        markerY: "",
        routeVisible: false,
        routePoints: "",
        highlightVisible: false,
        highlightStrong: false,
        highlightX: "",
        highlightY: "",
      };
      boatPredictionDomCache.set(transport.domUnitId, entry);
    }

    const signature = `${transport.color}|${transport.bg}`;
    if (entry.signature !== signature) {
      entry.marker.style.setProperty("--boat-color", transport.color);
      entry.marker.style.setProperty("--boat-bg", transport.bg);
      entry.routeLine.style.stroke = transport.color;
      entry.highlight.style.setProperty("--boat-color", transport.color);
      entry.highlight.style.setProperty("--boat-bg", transport.bg);
      entry.signature = signature;
    }

    return entry;
  }

  function setBoatRouteVisible(entry, visible) {
    if (entry.routeVisible === visible) {
      return;
    }
    // CSS `display`, not `.hidden` — SVG polyline ignores the `hidden` property.
    entry.routeLine.style.display = visible ? "" : "none";
    entry.routeVisible = visible;
  }

  function setBoatMarkerVisible(entry, visible) {
    if (entry.markerVisible === visible) {
      return;
    }
    entry.marker.hidden = !visible;
    entry.markerVisible = visible;
  }

  function setBoatHighlightVisible(entry, visible) {
    if (entry.highlightVisible === visible) {
      return;
    }
    entry.highlight.hidden = !visible;
    entry.highlightVisible = visible;
  }

  function setBoatHighlightStrong(entry, strong) {
    if (entry.highlightStrong === strong) {
      return;
    }
    entry.highlight.classList.toggle("is-strong", strong);
    entry.highlightStrong = strong;
  }

  // Hide every layer of an entry at once (off-screen cull / teardown).
  function hideBoatEntry(entry) {
    setBoatMarkerVisible(entry, false);
    setBoatRouteVisible(entry, false);
    setBoatHighlightVisible(entry, false);
  }

  function hideCachedBoatEntry(domUnitId) {
    const entry = boatPredictionDomCache.get(domUnitId);
    if (entry) hideBoatEntry(entry);
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

  function updateBoatHighlightPosition(entry, x, y) {
    const tx = `${x}px`;
    const ty = `${y}px`;
    if (entry.highlightX !== tx) {
      entry.highlight.style.setProperty("--boat-tx", tx);
      entry.highlightX = tx;
    }
    if (entry.highlightY !== ty) {
      entry.highlight.style.setProperty("--boat-ty", ty);
      entry.highlightY = ty;
    }
  }

  function cleanupBoatPredictionDomCache(activeTransportIds) {
    for (const [domUnitId, entry] of boatPredictionDomCache) {
      if (!activeTransportIds.has(domUnitId)) {
        entry.marker.remove();
        entry.routeLine.remove();
        entry.highlight.remove();
        boatPredictionDomCache.delete(domUnitId);
      }
    }
  }

  function clearBoatPredictionHoverElements() {
    if (!boatPredictionHoverElements) {
      return;
    }
    boatPredictionHoverElements.label?.remove();
    boatPredictionHoverElements = null;
  }

  // Hover/focus owns only the label now; the highlight ring + route are drawn by
  // the boat's own per-entry elements (see syncBoatPrediction).
  function getBoatPredictionHoverElements(container) {
    if (!boatPredictionHoverElements) {
      const label = document.createElement("div");
      label.className = "openfront-helper-boat-label";
      container.appendChild(label);

      boatPredictionHoverElements = {
        label,
      };
    }

    return boatPredictionHoverElements;
  }

  function queueBoatPredictionFrame() {
    runtimeState.boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
  }

  function resetBoatPredictionForMissingGame(container) {
    container.replaceChildren();
    lastBoatPredictionScanAt = 0;
    boatPredictionTransports = [];
    clearBoatPredictionDomCache();
    resetIncomingBoatWarningBaseline();
  }

  function refreshBoatPredictionScan(game, now) {
    if (lastBoatPredictionScanAt && now - lastBoatPredictionScanAt < BOAT_PREDICTION_SCAN_MS) return;
    boatPredictionTransports = collectBoatPredictionTransports(game);
    cleanupBoatPredictionDomCache(new Set(
      boatPredictionTransports.map((transport) => transport.domUnitId),
    ));
    maybeWarnNewIncomingBoats(boatPredictionTransports);
    lastBoatPredictionScanAt = now;
  }

  function updateBoatMarker(entry, markersOn, position) {
    if (!markersOn || !position.onScreen) {
      setBoatMarkerVisible(entry, false);
      return;
    }
    setBoatMarkerVisible(entry, true);
    updateBoatPredictionEntryPosition(entry, position.screen);
  }

  function isBoatMapHovered(transport, markersOn, position, renderState) {
    if (!markersOn || !position.onScreen || renderState.mapHoveredId !== null) return false;
    const dx = position.x - boatLandingMouseX;
    const dy = position.y - boatLandingMouseY;
    if (dx * dx + dy * dy > BOAT_LANDING_HOVER_RADIUS_SQUARED) return false;
    renderState.mapHoveredId = transport.domUnitId;
    return true;
  }

  function setBoatRoutePoints(entry, routePoints) {
    if (routePoints.length < 2) {
      setBoatRouteVisible(entry, false);
      return;
    }
    const points = routePoints.map((point) => `${point.x},${point.y}`).join(" ");
    if (entry.routePoints !== points) {
      entry.routeLine.setAttribute("points", points);
      entry.routePoints = points;
    }
    setBoatRouteVisible(entry, true);
  }

  function updateBoatRoute(context, entry, transport, position, accented) {
    const boatPosition = toScreenPoint(
      context.game, context.transform, asFiniteTileRef(transport.unit?.tile?.()),
    );
    const boatScreenPos = boatPosition
      ? { x: boatPosition.x, y: boatPosition.y }
      : null;
    setBoatRoutePoints(entry, getBoatRouteScreenPoints({
      game: context.game,
      transform: context.transform,
      motionPlanUnitId: transport.motionPlanUnitId,
      boatScreenPos,
      landingScreenPos: position.onScreen ? { x: position.x, y: position.y } : null,
    }));
    if (!boatScreenPos) {
      setBoatHighlightVisible(entry, false);
      return;
    }
    updateBoatHighlightPosition(entry, boatScreenPos.x, boatScreenPos.y);
    setBoatHighlightStrong(entry, accented);
    setBoatHighlightVisible(entry, true);
  }

  function renderBoatPredictionTransport(context, container, routeSvg, transport, renderState) {
    const focused = transport.domUnitId === runtimeState.boatPanelFocusedId;
    const screen = toScreenPointFromWorld(
      context.transform, transport.targetWorldX, transport.targetWorldY,
    );
    if (!focused && !isNearViewport(screen, 200)) return;
    const position = {
      screen,
      onScreen: screen != null,
      x: screen?.x ?? 0,
      y: screen?.y ?? 0,
    };
    if (!renderState.markersOn && !focused) {
      hideCachedBoatEntry(transport.domUnitId);
      return;
    }
    renderState.visibleIds.add(transport.domUnitId);
    const entry = getBoatPredictionDomEntry(container, routeSvg, transport);
    updateBoatMarker(entry, renderState.markersOn, position);
    const mapHovered = isBoatMapHovered(
      transport, renderState.markersOn, position, renderState,
    );
    const accented = mapHovered || focused;
    if (!shouldBoatRouteAlwaysShow(transport) && !accented) {
      setBoatRouteVisible(entry, false);
      setBoatHighlightVisible(entry, false);
      return;
    }
    updateBoatRoute(context, entry, transport, position, accented);
    if (accented && !renderState.label && position.onScreen) {
      renderState.label = { transport, x: position.x, y: position.y };
    }
  }

  function hideNonVisibleBoatEntries(visibleIds) {
    for (const [domUnitId, entry] of boatPredictionDomCache) {
      if (!visibleIds.has(domUnitId)) hideBoatEntry(entry);
    }
  }

  function renderBoatPredictionLabel(container, game, label) {
    if (!label) {
      clearBoatPredictionHoverElements();
      return;
    }
    const elements = getBoatPredictionHoverElements(container);
    elements.label.hidden = false;
    elements.label.style.setProperty("--boat-tx", `${label.x}px`);
    elements.label.style.setProperty("--boat-label-ty", `${label.y - 16}px`);
    elements.label.style.setProperty("--boat-color", label.transport.color);
    const eta = formatBoatEta(computeBoatEtaMs(game, label.transport));
    elements.label.textContent = `${label.transport.labelText} · ${eta}`;
  }

  let syncBoatPrediction = function syncBoatPredictionDom() {
    // Frame skip: only render every 3rd rAF frame (~20fps). Scan still runs
    // at its own cadence. Blon pattern — smooth enough for boats, ~67% less CPU.
    _boatFrameCounter = (_boatFrameCounter + 1) % 3;
    if (_boatFrameCounter !== 0) {
      queueBoatPredictionFrame();
      return;
    }

    if (!isBoatOverlayActive()) {
      teardownBoatOverlay();
      return;
    }

    const container = ensureBoatLandingContainer();
    ensureBoatMouseListener();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      resetBoatPredictionForMissingGame(container);
      queueBoatPredictionFrame();
      return;
    }
    refreshBoatPredictionScan(context.game, Date.now());
    const routeSvg = ensureBoatRouteSvg(container);
    resetScreenPointPool();
    const renderState = {
      markersOn: runtimeState.boatPredictionEnabled,
      visibleIds: new Set(), mapHoveredId: null, label: null,
    };
    for (const transport of boatPredictionTransports) {
      renderBoatPredictionTransport(context, container, routeSvg, transport, renderState);
    }
    hideNonVisibleBoatEntries(renderState.visibleIds);
    renderBoatPredictionLabel(container, context.game, renderState.label);
    queueBoatPredictionFrame();
  };

  function teardownBoatOverlay() {
    if (runtimeState.boatLandingAnimationFrame !== null) {
      cancelAnimationFrame(runtimeState.boatLandingAnimationFrame);
    }
    runtimeState.boatLandingAnimationFrame = null;
    lastBoatPredictionScanAt = 0;
    boatPredictionTransports = [];
    // Canvas cleanup
    var cvs = document.getElementById(BOAT_LANDING_CONTAINER_ID);
    if (cvs) cvs.remove();
    clearBoatPredictionDomCache();
    document.getElementById(BOAT_LANDING_CONTAINER_ID)?.remove();
  }

  // Start or tear down the shared overlay loop based on whether anything still
  // needs it (prediction overlay OR open panel). Both setters call this so the
  // loop and its container survive as long as either consumer is active.
  function refreshBoatOverlayActivity() {
    if (isBoatOverlayActive()) {
      if (runtimeState.boatLandingAnimationFrame === null) {
        syncBoatPrediction();
      }
    } else {
      teardownBoatOverlay();
    }
  }

  function setBoatPredictionEnabled(enabled, options) {
    const o = options || {};
    const nextAlwaysOwn = Boolean(o.alwaysOwnRoutes);
    const nextAlwaysTeam = Boolean(o.alwaysTeamRoutes);
    const nextAlwaysAlly = Boolean(o.alwaysAllyRoutes);
    const nextAlwaysEnemy = Boolean(o.alwaysEnemyRoutes);
    // A changed sub-option forces a re-scan so stale routes clear on the next
    // frame instead of waiting for the scan tick.
    const optionsChanged =
      nextAlwaysOwn !== runtimeState.boatPredictionAlwaysOwnRoutes ||
      nextAlwaysTeam !== runtimeState.boatPredictionAlwaysTeamRoutes ||
      nextAlwaysAlly !== runtimeState.boatPredictionAlwaysAllyRoutes ||
      nextAlwaysEnemy !== runtimeState.boatPredictionAlwaysEnemyRoutes;
    runtimeState.boatPredictionAlwaysOwnRoutes = nextAlwaysOwn;
    runtimeState.boatPredictionAlwaysTeamRoutes = nextAlwaysTeam;
    runtimeState.boatPredictionAlwaysAllyRoutes = nextAlwaysAlly;
    runtimeState.boatPredictionAlwaysEnemyRoutes = nextAlwaysEnemy;
    runtimeState.boatPredictionEnabled = Boolean(enabled);

    if (optionsChanged) {
      lastBoatPredictionScanAt = 0;
    }
    // Teardown is gated on the COMBINED activity, not just prediction: turning
    // the overlay off must not kill a loop/container the panel still needs.
    refreshBoatOverlayActivity();
  }

  // ── Canvas-based boat render (Blon port — replaces heavy DOM/SVG per-frame) ──
  function ensureBoatPredictionCanvas() {
    let canvas = document.getElementById(BOAT_LANDING_CONTAINER_ID);
    if (canvas?.tagName !== "CANVAS") {
      canvas?.remove();
      canvas = document.createElement("canvas");
      canvas.id = BOAT_LANDING_CONTAINER_ID;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:fixed;inset:0;z-index:8000;pointer-events:none;";
      (document.body || document.documentElement).appendChild(canvas);
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { canvas, context: canvas.getContext("2d"), width, height };
  }

  function findCanvasHoveredBoat(transform, markersOn) {
    if (!markersOn) return -1;
    let hovered = -1;
    let closestDistance = BOAT_LANDING_HOVER_RADIUS_SQUARED;
    for (let index = 0; index < boatPredictionTransports.length; index++) {
      const transport = boatPredictionTransports[index];
      const position = toScreenPointFromWorld(
        transform, transport.targetWorldX, transport.targetWorldY,
      );
      if (!position) continue;
      const dx = position.x - boatLandingMouseX;
      const dy = position.y - boatLandingMouseY;
      const distance = dx * dx + dy * dy;
      if (distance < closestDistance) {
        closestDistance = distance;
        hovered = index;
      }
    }
    return hovered;
  }

  function drawCanvasBoatMarker(context, transport, x, y) {
    context.beginPath();
    context.arc(x, y, 8, 0, Math.PI * 2);
    context.fillStyle = transport.bg;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = transport.color;
    context.stroke();
    context.beginPath();
    context.moveTo(x - 5, y);
    context.lineTo(x + 5, y);
    context.moveTo(x, y - 5);
    context.lineTo(x, y + 5);
    context.lineWidth = 1.5;
    context.stroke();
  }

  function drawCanvasBoatRoute(context, { game, transform, transport, x, y }) {
    const points = getBoatRouteScreenPoints({
      game, transform,
      motionPlanUnitId: transport.motionPlanUnitId,
      boatScreenPos: null,
      landingScreenPos: { x, y },
    });
    if (points.length < 2) return;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.strokeStyle = transport.color;
    context.globalAlpha = 0.35;
    context.lineWidth = 1.5;
    context.setLineDash([4, 4]);
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }

  function drawCanvasBoatLabel(context, game, transport, x, y) {
    const eta = formatBoatEta(computeBoatEtaMs(game, transport));
    const label = `${transport.labelText} · ${eta}`;
    context.font = "bold 10px monospace";
    context.textAlign = "center";
    context.textBaseline = "bottom";
    const width = context.measureText(label).width;
    const labelY = y - 14;
    context.fillStyle = "rgba(0,0,0,0.72)";
    context.fillRect(x - width / 2 - 4, labelY - 12, width + 8, 14);
    context.fillStyle = transport.color;
    context.fillText(label, x, labelY);
  }

  function drawCanvasBoat(context, {
    game, transform, transport, index, hoverIndex, markersOn,
  }) {
    const position = toScreenPointFromWorld(
      transform, transport.targetWorldX, transport.targetWorldY,
    );
    if (!position || !isNearViewport(position, 120)) return;
    const x = position.x;
    const y = position.y;
    const hovered = index === hoverIndex;
    if (markersOn) drawCanvasBoatMarker(context, transport, x, y);
    if (shouldBoatRouteAlwaysShow(transport) || hovered) {
      drawCanvasBoatRoute(context, { game, transform, transport, x, y });
    }
    if (hovered) drawCanvasBoatLabel(context, game, transport, x, y);
  }

  if (typeof _boatUseCanvas !== "undefined" && _boatUseCanvas) {
    syncBoatPrediction = function _canvasBoatRender() {
      // Frame skip: render every 3rd rAF (~20fps)
      _boatFrameCounter = (_boatFrameCounter + 1) % 3;
      if (_boatFrameCounter !== 0) {
        queueBoatPredictionFrame();
        return;
      }
      if (!isBoatOverlayActive()) { teardownBoatOverlay(); return; }
      ensureBoatMouseListener();
      const canvas = ensureBoatPredictionCanvas();
      const context = getOpenFrontGameContext();
      if (!context?.game || !context?.transform) {
        canvas.context.clearRect(0, 0, canvas.width, canvas.height);
        lastBoatPredictionScanAt = 0;
        boatPredictionTransports = [];
        resetIncomingBoatWarningBaseline();
        queueBoatPredictionFrame();
        return;
      }
      refreshBoatPredictionScan(context.game, Date.now());
      const markersOn = runtimeState.boatPredictionEnabled;
      canvas.context.clearRect(0, 0, canvas.width, canvas.height);
      resetScreenPointPool();
      const hoverIndex = findCanvasHoveredBoat(context.transform, markersOn);
      for (let index = 0; index < boatPredictionTransports.length; index++) {
        drawCanvasBoat(canvas.context, {
          game: context.game,
          transform: context.transform,
          transport: boatPredictionTransports[index],
          index, hoverIndex, markersOn,
        });
      }
      queueBoatPredictionFrame();
    };
  }
