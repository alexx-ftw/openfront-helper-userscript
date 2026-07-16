// Warship route overlay: destination markers + travel routes for warships,
// colored by relation (self/team/ally/enemy). Mirrors boat-prediction.js but
// simpler — always-on when enabled, no hover/focus/panel. Reuses boat-prediction
// helpers from the shared in-game scope (toScreenPoint, getBoatRouteScreenPoints,
// getBoatPredictionRelation, getOpenFrontGameContext, …). Destination = the
// warship's patrolTile (its move order), fallback = the end of its motion plan.

  const WARSHIP_ROUTES_CONTAINER_ID = "openfront-helper-warship-routes-layer";
  const WARSHIP_ROUTES_STYLE_ID = "openfront-helper-warship-routes-style";
  const WARSHIP_ROUTES_SCAN_MS = 600;
  // A warship parked AT its patrolTile has start≈end → a degenerate near-zero route
  // + a diamond sitting on the ship. Only draw when it is actually travelling toward
  // an order (manhattan ship→dest above this), so the overlay reads as "where is it
  // headed" rather than a marker on every idle ship.
  const WARSHIP_ROUTE_MIN_DIST = 6;
  let warshipRoutesEnabled = false;
  // Per-faction sub-toggles (default on) — which relations' warship routes draw.
  let warshipShowOwn = true;
  let warshipShowTeam = true;
  let warshipShowAlly = true;
  let warshipShowEnemy = true;
  function warshipFactionEnabled(relation) {
    switch (relation) {
      case "self":
        return warshipShowOwn;
      case "team":
        return warshipShowTeam;
      case "ally":
        return warshipShowAlly;
      default:
        return warshipShowEnemy;
    }
  }
  let warshipRoutesAnimationFrame = null;
  let _warshipFrameCounter = 2;
  let lastWarshipRouteScanAt = 0;
  let warshipRouteScan = []; // [{ id, unit, color, motionPlanUnitId, destWorldX, destWorldY }]
  const warshipRouteDomCache = new Map(); // id -> { routeLine, marker, routePoints, markerX, markerY, signature }

  function warshipRouteColor(relation) {
    switch (relation) {
      case "self":
        return "rgba(96, 165, 250, 0.95)"; // blue
      case "team":
        return "rgba(45, 212, 191, 0.95)"; // teal
      case "ally":
        return "rgba(74, 222, 128, 0.95)"; // green
      default:
        return "rgba(248, 113, 113, 0.95)"; // enemy red
    }
  }

  function ensureWarshipRouteStyles() {
    if (document.getElementById(WARSHIP_ROUTES_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = WARSHIP_ROUTES_STYLE_ID;
    style.textContent = `
      #${WARSHIP_ROUTES_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 7000;
        pointer-events: none;
      }
      #${WARSHIP_ROUTES_CONTAINER_ID} .openfront-helper-warship-route-svg {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
        pointer-events: none;
      }
      #${WARSHIP_ROUTES_CONTAINER_ID} .openfront-helper-warship-route-line {
        fill: none;
        stroke-width: 2;
        stroke-dasharray: 1 4;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0.75;
      }
      #${WARSHIP_ROUTES_CONTAINER_ID} .openfront-helper-warship-dest {
        position: fixed;
        left: 0;
        top: 0;
        width: 14px;
        height: 14px;
        border: 2px solid var(--ws-color);
        border-radius: 3px;
        background: transparent;
        box-shadow: 0 0 5px var(--ws-color);
        transform: translate3d(var(--ws-tx, 0px), var(--ws-ty, 0px), 0) translate(-50%, -50%) rotate(45deg);
        will-change: transform;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureWarshipRouteContainer() {
    ensureWarshipRouteStyles();
    let container = document.getElementById(WARSHIP_ROUTES_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = WARSHIP_ROUTES_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function ensureWarshipRouteSvg(container) {
    let svg = container.querySelector(".openfront-helper-warship-route-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-warship-route-svg");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function getWarshipDestination(game, unit, motionPlanUnitId) {
    try {
      const patrolTile = unit.warshipState?.()?.patrolTile;
      if (patrolTile != null) return asFiniteTileRef(patrolTile);
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/warship-routes.js:patrol-tile");
    }
    if (!Number.isFinite(motionPlanUnitId)) return null;
    try {
      const path = game.motionPlans?.()?.get(motionPlanUnitId)?.path;
      return path?.length ? asFiniteTileRef(path[path.length - 1]) : null;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/warship-routes.js:motion-plan");
      return null;
    }
  }

  function getWarshipDestinationWorld(game, destTile) {
    try {
      return { x: game.x(destTile), y: game.y(destTile) };
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/warship-routes.js:destination-world");
      return null;
    }
  }

  function isWarshipParked(game, unit, destination) {
    try {
      const shipTile = unit.tile?.();
      if (shipTile == null) return false;
      const distance =
        Math.abs(game.x(shipTile) - destination.x) +
        Math.abs(game.y(shipTile) - destination.y);
      return distance < WARSHIP_ROUTE_MIN_DIST;
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/warship-routes.js:parked-check");
      return false;
    }
  }

  function createWarshipRouteItem(game, unit) {
    if (!unit?.isActive?.()) return null;
    const relation = getBoatPredictionRelation(game, unit);
    if (!relation || !warshipFactionEnabled(relation)) return null;
    const motionPlanUnitId = Number(unit.id?.());
    const destTile = getWarshipDestination(game, unit, motionPlanUnitId);
    if (destTile === null) return null;
    const destination = getWarshipDestinationWorld(game, destTile);
    if (!destination || isWarshipParked(game, unit, destination)) return null;
    return {
      id: String(unit.id?.() ?? `dest:${destTile}`),
      unit,
      color: warshipRouteColor(relation),
      motionPlanUnitId: Number.isFinite(motionPlanUnitId) ? motionPlanUnitId : null,
      destWorldX: destination.x,
      destWorldY: destination.y,
    };
  }

  function collectWarshipRoutes(game) {
    const out = [];
    const units =
      typeof getCachedGameUnits === "function"
        ? getCachedGameUnits(game, "Warship")
        : game.units("Warship");
    for (const unit of units) {
      const item = createWarshipRouteItem(game, unit);
      if (item) out.push(item);
    }
    return out;
  }

  function getWarshipRouteEntry(container, svg, item) {
    let entry = warshipRouteDomCache.get(item.id);
    if (!entry) {
      const routeLine = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      routeLine.classList.add("openfront-helper-warship-route-line");
      routeLine.style.display = "none";
      svg.appendChild(routeLine);

      const marker = document.createElement("div");
      marker.className = "openfront-helper-warship-dest";
      marker.hidden = true;
      container.appendChild(marker);

      entry = {
        routeLine,
        marker,
        signature: "",
        routePoints: "",
        markerX: "",
        markerY: "",
      };
      warshipRouteDomCache.set(item.id, entry);
    }
    if (entry.signature !== item.color) {
      entry.routeLine.style.stroke = item.color;
      entry.marker.style.setProperty("--ws-color", item.color);
      entry.signature = item.color;
    }
    return entry;
  }

  function cleanupWarshipRouteDom(activeIds) {
    for (const [id, entry] of warshipRouteDomCache) {
      if (!activeIds.has(id)) {
        entry.routeLine.remove();
        entry.marker.remove();
        warshipRouteDomCache.delete(id);
      }
    }
  }

  function scheduleWarshipRouteSync() {
    warshipRoutesAnimationFrame = requestAnimationFrame(syncWarshipRoutes);
  }

  function refreshWarshipRouteScan(game) {
    const now = Date.now();
    if (lastWarshipRouteScanAt && now - lastWarshipRouteScanAt < WARSHIP_ROUTES_SCAN_MS) return;
    warshipRouteScan = collectWarshipRoutes(game);
    cleanupWarshipRouteDom(new Set(warshipRouteScan.map((item) => item.id)));
    lastWarshipRouteScanAt = now;
  }

  function updateWarshipRoutePolyline(entry, points) {
    if (points.length < 2) {
      entry.routeLine.style.display = "none";
      return;
    }
    const attribute = points.map((point) => `${point.x},${point.y}`).join(" ");
    if (entry.routePoints !== attribute) {
      entry.routeLine.setAttribute("points", attribute);
      entry.routePoints = attribute;
    }
    entry.routeLine.style.display = "";
  }

  function updateWarshipRouteMarker(entry, destination, isNear) {
    if (!destination || !isNear) {
      entry.marker.hidden = true;
      return;
    }
    const x = `${destination.x}px`;
    const y = `${destination.y}px`;
    if (entry.markerX !== x) {
      entry.marker.style.setProperty("--ws-tx", x);
      entry.markerX = x;
    }
    if (entry.markerY !== y) {
      entry.marker.style.setProperty("--ws-ty", y);
      entry.markerY = y;
    }
    entry.marker.hidden = false;
  }

  function renderWarshipRouteItem(container, svg, context, item) {
    const destination = toScreenPointFromWorld(
      context.transform,
      item.destWorldX,
      item.destWorldY,
    );
    const destinationNear = isNearViewport(destination, 240);
    const shipPosition = toScreenPoint(
      context.game,
      context.transform,
      asFiniteTileRef(item.unit?.tile?.()),
    );
    const shipNear = shipPosition && isNearViewport(shipPosition, 240);
    const entry = getWarshipRouteEntry(container, svg, item);
    if (!destinationNear && !shipNear) {
      entry.routeLine.style.display = "none";
      entry.marker.hidden = true;
      return;
    }
    const points = getBoatRouteScreenPoints(
      context.game,
      context.transform,
      item.unit,
      item.motionPlanUnitId,
      shipPosition ? { x: shipPosition.x, y: shipPosition.y } : null,
      destination ? { x: destination.x, y: destination.y } : null,
    );
    updateWarshipRoutePolyline(entry, points);
    updateWarshipRouteMarker(entry, destination, destinationNear);
  }

  function syncWarshipRoutes() {
    if (!warshipRoutesEnabled) {
      teardownWarshipRoutes();
      return;
    }
    _warshipFrameCounter = (_warshipFrameCounter + 1) % 3;
    if (_warshipFrameCounter !== 0) {
      scheduleWarshipRouteSync();
      return;
    }
    const container = ensureWarshipRouteContainer();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      container.replaceChildren();
      warshipRouteDomCache.clear();
      warshipRouteScan = [];
      lastWarshipRouteScanAt = 0;
      scheduleWarshipRouteSync();
      return;
    }

    const svg = ensureWarshipRouteSvg(container);

    refreshWarshipRouteScan(context.game);

    resetScreenPointPool();

    for (const item of warshipRouteScan) {
      renderWarshipRouteItem(container, svg, context, item);
    }

    scheduleWarshipRouteSync();
  }

  function teardownWarshipRoutes() {
    if (warshipRoutesAnimationFrame !== null) {
      cancelAnimationFrame(warshipRoutesAnimationFrame);
    }
    warshipRoutesAnimationFrame = null;
    _warshipFrameCounter = 2;
    lastWarshipRouteScanAt = 0;
    warshipRouteScan = [];
    warshipRouteDomCache.clear();
    document.getElementById(WARSHIP_ROUTES_CONTAINER_ID)?.remove();
  }

  function setWarshipRoutesEnabled(enabled, factions) {
    warshipRoutesEnabled = Boolean(enabled);
    if (factions && typeof factions === "object") {
      if (factions.own !== undefined) warshipShowOwn = Boolean(factions.own);
      if (factions.team !== undefined) warshipShowTeam = Boolean(factions.team);
      if (factions.ally !== undefined) warshipShowAlly = Boolean(factions.ally);
      if (factions.enemy !== undefined) warshipShowEnemy = Boolean(factions.enemy);
    }
    // Full teardown so any now-hidden faction's DOM is removed, then rebuild.
    teardownWarshipRoutes();
    if (warshipRoutesEnabled) {
      syncWarshipRoutes();
    }
  }
