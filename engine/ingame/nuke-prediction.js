// Enemy nuke prediction: landing markers and blast radius overlay.

  const NUKE_UNIT_TYPES = ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"];

  // When several nukes of different relations target the same tile, the highest
  // rank decides the marker color: an incoming enemy strike (defensive warning)
  // outranks my own salvo, which outranks an ally's. In practice relations rarely
  // mix on a single tile, so for my own batch the marker is cyan with my count.
  const NUKE_RELATION_RANK = { ally: 1, self: 2, enemy: 3 };

  // Atom/Hydrogen follow a ground-launched parabola we can time for a "time to impact"
  // readout. MIRV Warheads are EXCLUDED: they spawn mid-air at the MIRV split and fly flat
  // (distanceBasedHeight:false) at a different speed, so the silo→target atom parabola would
  // give a garbage time — we keep their count marker but show no ETA.
  const NUKE_ETA_TYPES = new Set(["Atom Bomb", "Hydrogen Bomb"]);

  function ensureNukeLandingStyles() {
    if (document.getElementById(NUKE_LANDING_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = NUKE_LANDING_STYLE_ID;
    style.textContent = `
      #${NUKE_LANDING_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 8000;
        pointer-events: none;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone {
        position: fixed;
        left: 0;
        top: 0;
        width: var(--nuke-diameter);
        height: var(--nuke-diameter);
        border: 2px dashed var(--nuke-color, rgba(248, 113, 113, 0.92));
        border-radius: 50%;
        background: var(--nuke-bg, rgba(127, 29, 29, 0.18));
        box-shadow:
          0 0 18px var(--nuke-glow, rgba(248, 113, 113, 0.36)),
          inset 0 0 24px var(--nuke-inner-glow, rgba(248, 113, 113, 0.18));
        transform: translate3d(var(--nuke-tx, 0px), var(--nuke-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::before,
      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        background: var(--nuke-cross-color, rgba(254, 202, 202, 0.94));
        box-shadow: 0 0 10px var(--nuke-cross-glow, rgba(248, 113, 113, 0.6));
        transform: translate(-50%, -50%);
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::before {
        width: 28px;
        height: 2px;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::after {
        width: 2px;
        height: 28px;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-label {
        position: fixed;
        left: 0;
        top: 0;
        padding: 4px 8px;
        border: 1px solid var(--nuke-label-border, rgba(248, 113, 113, 0.52));
        border-radius: 8px;
        background: rgba(7, 12, 18, 0.86);
        color: var(--nuke-label-color, #fecaca);
        font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92);
        transform: translate3d(var(--nuke-tx, 0px), var(--nuke-label-ty, 0px), 0) translate(-50%, -100%);
        will-change: transform;
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureNukeLandingContainer() {
    ensureNukeLandingStyles();

    let container = document.getElementById(NUKE_LANDING_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = NUKE_LANDING_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function getNukePredictionRelation(game, unit) {
    const owner = unit?.owner?.();
    const relation = getPlayerRelationToMyPlayer(game, owner);
    return relation === "enemy" || relation === "ally" || relation === "self"
      ? relation
      : null;
  }

  function getNukePredictionColors(relation) {
    if (relation === "ally") {
      return {
        color: "rgba(74, 222, 128, 0.92)",
        bg: "rgba(20, 83, 45, 0.18)",
        glow: "rgba(74, 222, 128, 0.36)",
        innerGlow: "rgba(74, 222, 128, 0.18)",
        crossColor: "rgba(187, 247, 208, 0.94)",
        crossGlow: "rgba(74, 222, 128, 0.6)",
        labelBorder: "rgba(74, 222, 128, 0.52)",
        labelColor: "#bbf7d0",
      };
    }

    if (relation === "self") {
      // Cyan/sky — distinct from enemy (red) and ally (green) so my own
      // outgoing salvo is instantly recognizable as mine.
      return {
        color: "rgba(56, 189, 248, 0.92)",
        bg: "rgba(8, 47, 73, 0.20)",
        glow: "rgba(56, 189, 248, 0.38)",
        innerGlow: "rgba(56, 189, 248, 0.18)",
        crossColor: "rgba(186, 230, 253, 0.96)",
        crossGlow: "rgba(56, 189, 248, 0.65)",
        labelBorder: "rgba(56, 189, 248, 0.55)",
        labelColor: "#bae6fd",
      };
    }

    return {
      color: "rgba(248, 113, 113, 0.92)",
      bg: "rgba(127, 29, 29, 0.18)",
      glow: "rgba(248, 113, 113, 0.36)",
      innerGlow: "rgba(248, 113, 113, 0.18)",
      crossColor: "rgba(254, 202, 202, 0.94)",
      crossGlow: "rgba(248, 113, 113, 0.6)",
      labelBorder: "rgba(248, 113, 113, 0.52)",
      labelColor: "#fecaca",
    };
  }

  function getNukeLandingRadius(game, unit) {
    {
      const magnitude = game?.config?.().nukeMagnitudes?.(unit.type());
      const radius = Number(magnitude?.outer ?? magnitude?.inner);
      if (Number.isFinite(radius) && radius > 0) {
        return radius;
      }
    }

    return unit?.type?.() === "Hydrogen Bomb" ? 160 : 70;
  }

  function getNukeLandingScreenRadius(transform, screenPos, worldRadius) {
    const scale = Number(transform?.scale);
    if (Number.isFinite(scale) && scale > 0) {
      return worldRadius * scale;
    }

    {
      const reference = transform.worldToScreenCoordinates({
        x: screenPos.worldX + worldRadius,
        y: screenPos.worldY,
      });
      const dx = reference.x - screenPos.x;
      const dy = reference.y - screenPos.y;
      return Math.hypot(dx, dy);
    }
  }

  // DOM-element cache + scan cache. The active in-flight nuke list rarely
  // changes; the screen position changes every pan frame. Splitting these
  // updates eliminates the per-frame querySelector storm.
  const nukeLandingEntries = new Map();
  let nukeScanCache = []; // [{ unitId, targetTile, worldRadius, relation, count, eta }]
  let lastNukeScanAt = 0;
  const NUKE_SCAN_MS = 250;
  // Pre-allocated reusable objects. Eliminates per-landing per-frame allocs.
  const _nukeWorldQueryArg = { x: 0, y: 0 };
  const _nukeRadiusReusePos = { x: 0, y: 0, worldX: 0, worldY: 0 };
  // Landing markers do not need a 60 Hz DOM pass. Keep the scan cadence at
  // 250ms, but render the cached screen positions at about 20 FPS so the
  // default-on overlay cannot compete with the game's own frame budget.
  let _nukeFrameCounter = 2;
  // id → { firstTick, remainTicks } anchored once at first sight. The nuke advances exactly
  // one trajectory point per tick, so the ETA = remainTicks − (now − firstTick) counts down
  // 1:1 without recomputing the curve each frame. Pruned by id every scan (own map, separate
  // from the tile-keyed nukeLandingEntries).
  const nukeFlightById = new Map();

  // Remaining flight ticks from a point on the arc to the target, via the SAME parabola the
  // game uses (UniversalPathFinding lives in the auto-bot bundle; guarded in case it is not
  // loaded). Flight time is flip-INDEPENDENT — the arc LENGTH is identical whether it bows up
  // or down — so directionUp:true is valid no matter the firer's flip toggle.
  //
  // NOT path.length! A nuke moves `speed` of ARC distance per tick (NukeExecution →
  // curve.increment(speed)) and detonates when the distance flown exceeds the arc length, so
  // the true count is floor(arcLength/speed)+1. The cached path points are spaced slightly
  // MORE than `speed` apart (Bézier t-sampling overshoots the spacing), so counting points
  // under-counts ticks — and the gap grows with range (far shots read ~1–2 s fast). Summing
  // the real segment lengths from the tile coords matches the game to within ~0.2 s at any
  // distance.
  function canComputeNukeRemainingTicks(fromTile, toTile) {
    return (
      typeof UniversalPathFinding !== "undefined" &&
      Boolean(UniversalPathFinding.Parabola) &&
      fromTile != null &&
      toTile != null
    );
  }

  function computeNukeRemainingTicks(game, fromTile, toTile) {
    {
      if (!canComputeNukeRemainingTicks(fromTile, toTile)) return null;
      const speed = game.config?.().defaultNukeSpeed?.() ?? 8;
      const pf = UniversalPathFinding.Parabola(game, {
        increment: speed,
        distanceBasedHeight: true,
        directionUp: true,
      });
      const path = pf.findPath(fromTile, toTile);
      if (!Array.isArray(path) || path.length === 0) {
        return null;
      }
      if (path.length === 1) {
        return 1; // already at target
      }
      let arc = 0;
      for (let i = 1; i < path.length; i++) {
        const ax = game.x(path[i]);
        const ay = game.y(path[i]);
        const bx = game.x(path[i - 1]);
        const by = game.y(path[i - 1]);
        arc += Math.hypot(ax - bx, ay - by);
      }
      return Math.floor(arc / (speed > 0 ? speed : 8)) + 1;
    }
  }

  function getNukeScanEta(game, unit, targetTile, nowTicks, seenIds) {
    const unitType = unit.type?.();
    const id = unit.id?.();
    if (!NUKE_ETA_TYPES.has(unitType) || id === undefined) return null;
    seenIds.add(id);
    let flight = nukeFlightById.get(id);
    if (flight === undefined) {
      const remainTicks = computeNukeRemainingTicks(game, unit.tile?.(), targetTile);
      if (remainTicks !== null) {
        flight = { firstTick: nowTicks, remainTicks };
        nukeFlightById.set(id, flight);
      }
    }
    if (flight === undefined) return null;
    const etaTicks = flight.remainTicks - (nowTicks - flight.firstTick);
    return Math.round(Math.max(0, etaTicks / 10) * 10) / 10;
  }

  function mergeNukeScanLanding(existing, relation, worldRadius, eta) {
    existing.count += 1;
    existing.worldRadius = Math.max(existing.worldRadius, worldRadius);
    const relationRank = NUKE_RELATION_RANK[relation] ?? 0;
    const existingRank = NUKE_RELATION_RANK[existing.relation] ?? 0;
    if (relationRank > existingRank) existing.relation = relation;
    if (eta !== null && (existing.eta === null || eta < existing.eta)) existing.eta = eta;
  }

  function addNukeScanUnit(game, unit, nowTicks, seenIds, groupedByTile) {
    if (!unit?.isActive?.()) return;
    const relation = getNukePredictionRelation(game, unit);
    const targetTile = unit.targetTile?.();
    if (!relation || targetTile === undefined) return;
    const eta = getNukeScanEta(game, unit, targetTile, nowTicks, seenIds);
    const landingId = `tile-${targetTile}`;
    const worldRadius = getNukeLandingRadius(game, unit);
    const existing = groupedByTile.get(landingId);
    if (existing) {
      mergeNukeScanLanding(existing, relation, worldRadius, eta);
      return;
    }
    groupedByTile.set(landingId, {
      landingId,
      targetTile,
      worldX: game.x(targetTile),
      worldY: game.y(targetTile),
      worldRadius,
      relation,
      count: 1,
      eta,
    });
  }

  function collectNukeScan(game) {
    const groupedByTile = new Map();
    const seenIds = new Set();
    const nowTicks = typeof game.ticks === "function" ? game.ticks() : 0;
    const units =
      typeof getCachedGameUnits === "function"
        ? getCachedGameUnits(game, ...NUKE_UNIT_TYPES)
        : game.units(...NUKE_UNIT_TYPES);
    for (const unit of units) {
      addNukeScanUnit(game, unit, nowTicks, seenIds, groupedByTile);
    }
    // Prune flight anchors for nukes no longer in flight (landed/intercepted).
    if (nukeFlightById.size > 0) {
      for (const id of nukeFlightById.keys()) {
        if (!seenIds.has(id)) {
          nukeFlightById.delete(id);
        }
      }
    }
    return Array.from(groupedByTile.values());
  }

  function pruneNukeEntries() {
    const activeIds = new Set();
    for (const landing of nukeScanCache) {
      activeIds.add(landing.landingId);
    }
    for (const [landingId, entry] of nukeLandingEntries) {
      if (!activeIds.has(landingId)) {
        entry.zone.remove();
        entry.label.remove();
        nukeLandingEntries.delete(landingId);
      }
    }
  }

  function ensureNukeLandingEntry(container, landingId) {
    let entry = nukeLandingEntries.get(landingId);
    if (entry) {
      return entry;
    }
    const zone = document.createElement("div");
    zone.className = "openfront-helper-nuke-zone";
    zone.dataset.nukeId = landingId;
    container.appendChild(zone);
    const label = document.createElement("div");
    label.className = "openfront-helper-nuke-label";
    label.dataset.nukeId = landingId;
    container.appendChild(label);
    entry = {
      zone,
      label,
      hidden: false,
      tx: NaN,
      ty: NaN,
      labelTy: NaN,
      radius: NaN,
      relation: "",
      count: -1,
      eta: NaN,
    };
    nukeLandingEntries.set(landingId, entry);
    return entry;
  }

  function hideNukeEntry(entry) {
    if (!entry.hidden) {
      entry.zone.hidden = true;
      entry.label.hidden = true;
      entry.hidden = true;
    }
  }

  function applyNukeColors(zone, label, colors) {
    zone.style.setProperty("--nuke-color", colors.color);
    zone.style.setProperty("--nuke-bg", colors.bg);
    zone.style.setProperty("--nuke-glow", colors.glow);
    zone.style.setProperty("--nuke-inner-glow", colors.innerGlow);
    zone.style.setProperty("--nuke-cross-color", colors.crossColor);
    zone.style.setProperty("--nuke-cross-glow", colors.crossGlow);
    label.style.setProperty("--nuke-label-border", colors.labelBorder);
    label.style.setProperty("--nuke-label-color", colors.labelColor);
  }

  function scheduleNukePredictionSync() {
    runtimeState.nukeLandingAnimationFrame = requestAnimationFrame(syncNukePrediction);
  }

  function resetNukePredictionScan(removeEntries) {
    if (removeEntries) {
      for (const entry of nukeLandingEntries.values()) {
        entry.zone.remove();
        entry.label.remove();
      }
      nukeLandingEntries.clear();
    }
    nukeFlightById.clear();
    nukeScanCache = [];
    lastNukeScanAt = 0;
  }

  function getNukeLandingScreenPosition(transform, landing) {
    _nukeWorldQueryArg.x = landing.worldX;
    _nukeWorldQueryArg.y = landing.worldY;
    {
      return transform.worldToScreenCoordinates(_nukeWorldQueryArg);
    }
  }

  function nukeLandingIsVisible(screenPos) {
    return (
      Number.isFinite(screenPos?.x) &&
      Number.isFinite(screenPos?.y) &&
      screenPos.x >= -300 &&
      screenPos.y >= -300 &&
      screenPos.x <= window.innerWidth + 300 &&
      screenPos.y <= window.innerHeight + 300
    );
  }

  function updateNukeLandingPosition(entry, screenPos, radius) {
    const labelY = screenPos.y - radius - 10;
    if (entry.tx !== screenPos.x) {
      entry.zone.style.setProperty("--nuke-tx", `${screenPos.x}px`);
      entry.label.style.setProperty("--nuke-tx", `${screenPos.x}px`);
      entry.tx = screenPos.x;
    }
    if (entry.ty !== screenPos.y) {
      entry.zone.style.setProperty("--nuke-ty", `${screenPos.y}px`);
      entry.ty = screenPos.y;
    }
    if (entry.labelTy !== labelY) {
      entry.label.style.setProperty("--nuke-label-ty", `${labelY}px`);
      entry.labelTy = labelY;
    }
    if (entry.radius !== radius) {
      entry.zone.style.setProperty("--nuke-diameter", `${radius * 2}px`);
      entry.radius = radius;
    }
  }

  function nukeLandingLabelPrefix(relation) {
    if (relation === "self") return tr("My nuke");
    if (relation === "ally") return tr("Ally nuke");
    return tr("Enemy nuke");
  }

  function updateNukeLandingAppearance(entry, landing) {
    if (entry.relation !== landing.relation) {
      applyNukeColors(entry.zone, entry.label, getNukePredictionColors(landing.relation));
      entry.relation = landing.relation;
      entry.count = -1;
    }
    if (entry.count === landing.count && entry.eta === landing.eta) return;
    const countPart = landing.count > 1 ? ` ${landing.count}x` : "";
    const etaPart = landing.eta != null ? ` · ${landing.eta.toFixed(1)}s` : "";
    entry.label.textContent = `${nukeLandingLabelPrefix(landing.relation)}${countPart}${etaPart}`;
    entry.count = landing.count;
    entry.eta = landing.eta;
  }

  function renderNukePredictionLanding(container, context, landing) {
    const screenPos = getNukeLandingScreenPosition(context.transform, landing);
    if (!nukeLandingIsVisible(screenPos)) {
      const existing = nukeLandingEntries.get(landing.landingId);
      if (existing) hideNukeEntry(existing);
      return;
    }
    _nukeRadiusReusePos.x = screenPos.x;
    _nukeRadiusReusePos.y = screenPos.y;
    _nukeRadiusReusePos.worldX = landing.worldX;
    _nukeRadiusReusePos.worldY = landing.worldY;
    const radius = Math.max(
      12,
      getNukeLandingScreenRadius(context.transform, _nukeRadiusReusePos, landing.worldRadius),
    );
    const entry = ensureNukeLandingEntry(container, landing.landingId);
    if (entry.hidden) {
      entry.zone.hidden = false;
      entry.label.hidden = false;
      entry.hidden = false;
    }
    updateNukeLandingPosition(entry, screenPos, radius);
    updateNukeLandingAppearance(entry, landing);
  }

  function syncNukePrediction() {
    if (!runtimeState.nukePredictionEnabled) {
      document.getElementById(NUKE_LANDING_CONTAINER_ID)?.remove();
      nukeLandingEntries.clear();
      resetNukePredictionScan(false);
      runtimeState.nukeLandingAnimationFrame = null;
      return;
    }

    _nukeFrameCounter = (_nukeFrameCounter + 1) % 3;
    if (_nukeFrameCounter !== 0) {
      scheduleNukePredictionSync();
      return;
    }

    const container = ensureNukeLandingContainer();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      resetNukePredictionScan(true);
      scheduleNukePredictionSync();
      return;
    }

    const now = performance.now();
    if (now - lastNukeScanAt >= NUKE_SCAN_MS) {
      nukeScanCache = collectNukeScan(context.game);
      pruneNukeEntries();
      lastNukeScanAt = now;
    }

    for (const landing of nukeScanCache) {
      renderNukePredictionLanding(container, context, landing);
    }

    // Entries whose landing fell out of the scan cache are removed by
    // pruneNukeEntries on the next scan tick (no per-frame sweep here).

    scheduleNukePredictionSync();
  }

  function setNukePredictionEnabled(enabled) {
    runtimeState.nukePredictionEnabled = Boolean(enabled);
    _nukeFrameCounter = 2;
    if (!runtimeState.nukePredictionEnabled) {
      if (runtimeState.nukeLandingAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.nukeLandingAnimationFrame);
      }
      runtimeState.nukeLandingAnimationFrame = null;
      document.getElementById(NUKE_LANDING_CONTAINER_ID)?.remove();
      nukeLandingEntries.clear();
      nukeFlightById.clear();
      return;
    }

    if (runtimeState.nukeLandingAnimationFrame === null) {
      syncNukePrediction();
    }
  }
