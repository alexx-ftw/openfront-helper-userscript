// Enemy nuke prediction: landing markers and blast radius overlay.

  const NUKE_UNIT_TYPES = ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"];

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
        left: var(--nuke-x);
        top: var(--nuke-y);
        width: var(--nuke-diameter);
        height: var(--nuke-diameter);
        border: 2px dashed var(--nuke-color, rgba(248, 113, 113, 0.92));
        border-radius: 50%;
        background: var(--nuke-bg, rgba(127, 29, 29, 0.18));
        box-shadow:
          0 0 18px var(--nuke-glow, rgba(248, 113, 113, 0.36)),
          inset 0 0 24px var(--nuke-inner-glow, rgba(248, 113, 113, 0.18));
        transform: translate(-50%, -50%);
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
        left: var(--nuke-x);
        top: calc(var(--nuke-y) - var(--nuke-radius) - 10px);
        padding: 4px 8px;
        border: 1px solid var(--nuke-label-border, rgba(248, 113, 113, 0.52));
        border-radius: 8px;
        background: rgba(7, 12, 18, 0.86);
        color: var(--nuke-label-color, #fecaca);
        font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92);
        transform: translate(-50%, -100%);
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
    return relation === "enemy" || relation === "ally" ? relation : null;
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
    try {
      const magnitude = game?.config?.().nukeMagnitudes?.(unit.type());
      const radius = Number(magnitude?.outer ?? magnitude?.inner);
      if (Number.isFinite(radius) && radius > 0) {
        return radius;
      }
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/nuke-landing-zones.js:127");
      // Fall back to the same radii used by OpenFront's nuke FX layer.
    }

    return unit?.type?.() === "Hydrogen Bomb" ? 160 : 70;
  }

  function getNukeLandingScreenRadius(transform, screenPos, worldRadius) {
    const scale = Number(transform?.scale);
    if (Number.isFinite(scale) && scale > 0) {
      return worldRadius * scale;
    }

    try {
      const reference = transform.worldToScreenCoordinates({
        x: screenPos.worldX + worldRadius,
        y: screenPos.worldY,
      });
      const dx = reference.x - screenPos.x;
      const dy = reference.y - screenPos.y;
      return Math.hypot(dx, dy);
    } catch (_error) {
  captureRuntimeException(_error, "engine/ingame/nuke-landing-zones.js:148");
      return worldRadius;
    }
  }

  function isNukeLandingOutsideViewport(screenPos) {
    return (
      !Number.isFinite(screenPos?.x) ||
      !Number.isFinite(screenPos?.y) ||
      screenPos.x < -300 ||
      screenPos.y < -300 ||
      screenPos.x > window.innerWidth + 300 ||
      screenPos.y > window.innerHeight + 300
    );
  }

  function getNukeLandingEntry(context, unit) {
    if (!unit?.isActive?.()) return null;
    const relation = getNukePredictionRelation(context.game, unit);
    const targetTile = unit.targetTile?.();
    if (!relation || targetTile === undefined) return null;
    const worldX = context.game.x(targetTile);
    const worldY = context.game.y(targetTile);
    let screenPos;
    try {
      screenPos = context.transform.worldToScreenCoordinates({ x: worldX, y: worldY });
    } catch (_error) {
      captureRuntimeException(_error, "engine/ingame/nuke-landing-zones.js:screen-position");
      return null;
    }
    if (isNukeLandingOutsideViewport(screenPos)) return null;
    return {
      landingId: `tile-${targetTile}`,
      relation,
      screenPos,
      radius: Math.max(
        12,
        getNukeLandingScreenRadius(
          context.transform,
          { ...screenPos, worldX, worldY },
          getNukeLandingRadius(context.game, unit),
        ),
      ),
    };
  }

  function collectNukeLandings(context) {
    const landings = new Map();
    for (const unit of context.game.units(...NUKE_UNIT_TYPES)) {
      const entry = getNukeLandingEntry(context, unit);
      if (!entry) continue;
      const landing = landings.get(entry.landingId);
      if (!landing) {
        landings.set(entry.landingId, { ...entry, count: 1 });
        continue;
      }
      landing.count += 1;
      landing.radius = Math.max(landing.radius, entry.radius);
      if (landing.relation !== "enemy") landing.relation = entry.relation;
    }
    return landings;
  }

  function ensureNukeLandingMarker(container, className, landingId) {
    const selector = `.${className}[data-nuke-id="${escapeCssIdentifier(landingId)}"]`;
    let marker = container.querySelector(selector);
    if (marker) return marker;
    marker = document.createElement("div");
    marker.className = className;
    marker.dataset.nukeId = landingId;
    container.appendChild(marker);
    return marker;
  }

  function renderNukeLanding(container, landingId, landing) {
    const zone = ensureNukeLandingMarker(container, "openfront-helper-nuke-zone", landingId);
    const label = ensureNukeLandingMarker(container, "openfront-helper-nuke-label", landingId);
    const colors = getNukePredictionColors(landing.relation);
    const positionProperties = {
      "--nuke-x": `${landing.screenPos.x}px`,
      "--nuke-y": `${landing.screenPos.y}px`,
      "--nuke-radius": `${landing.radius}px`,
    };
    for (const [property, value] of Object.entries(positionProperties)) {
      zone.style.setProperty(property, value);
      label.style.setProperty(property, value);
    }
    const zoneProperties = {
      "--nuke-diameter": `${landing.radius * 2}px`,
      "--nuke-color": colors.color,
      "--nuke-bg": colors.bg,
      "--nuke-glow": colors.glow,
      "--nuke-inner-glow": colors.innerGlow,
      "--nuke-cross-color": colors.crossColor,
      "--nuke-cross-glow": colors.crossGlow,
    };
    for (const [property, value] of Object.entries(zoneProperties)) {
      zone.style.setProperty(property, value);
    }
    label.style.setProperty("--nuke-label-border", colors.labelBorder);
    label.style.setProperty("--nuke-label-color", colors.labelColor);
    const prefix = landing.relation === "ally" ? "Ally nuke" : "Enemy nuke";
    label.textContent = landing.count > 1 ? `${prefix} ${landing.count}x` : prefix;
  }

  function syncNukePrediction() {
    if (!runtimeState.nukePredictionEnabled) {
      document.getElementById(NUKE_LANDING_CONTAINER_ID)?.remove();
      runtimeState.nukeLandingAnimationFrame = null;
      return;
    }

    const container = ensureNukeLandingContainer();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      container.replaceChildren();
      runtimeState.nukeLandingAnimationFrame = requestAnimationFrame(syncNukePrediction);
      return;
    }

    const landings = collectNukeLandings(context);

    const activeIds = new Set();
    for (const [landingId, landing] of landings) {
      activeIds.add(landingId);
      renderNukeLanding(container, landingId, landing);
    }

    for (const marker of container.querySelectorAll("[data-nuke-id]")) {
      if (!activeIds.has(marker.dataset.nukeId || "")) {
        marker.remove();
      }
    }

    runtimeState.nukeLandingAnimationFrame = requestAnimationFrame(syncNukePrediction);
  }

  function setNukePredictionEnabled(enabled) {
    runtimeState.nukePredictionEnabled = Boolean(enabled);
    if (!runtimeState.nukePredictionEnabled) {
      if (runtimeState.nukeLandingAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.nukeLandingAnimationFrame);
      }
      runtimeState.nukeLandingAnimationFrame = null;
      document.getElementById(NUKE_LANDING_CONTAINER_ID)?.remove();
      return;
    }

    if (runtimeState.nukeLandingAnimationFrame === null) {
      syncNukePrediction();
    }
  }
