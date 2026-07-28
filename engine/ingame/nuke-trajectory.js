// Nuke trajectory line (feature #5): the predicted flight path from each in-flight
// nuke to its landing tile, as a dashed parabolic polyline colored by relation.
//
// Additive to nuke-prediction.js (which draws the landing circle + ETA label) — it
// does NOT touch that optimized file. Instead it is a layer on the shared
// map-overlay canvas, gated by the SAME toggle (showNukePrediction), and it reuses
// the exact UniversalPathFinding.Parabola the ETA readout uses, so the drawn line
// matches the game's real arc. Atom/Hydrogen follow the parabola; MIRV warheads
// (flat mid-air flight) fall back to a straight current→target line.

  const NUKE_TRAJ_UNIT_TYPES = ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"];
  const NUKE_TRAJ_PARABOLA_TYPES = new Set(["Atom Bomb", "Hydrogen Bomb"]);
  const NUKE_TRAJ_MAX_POINTS = 48;

  // Scan cache: [{ relation, worldPts: [{x,y}...] }]. World coords resolved in the
  // throttled scan; the per-frame draw only maps them to screen.
  let _nukeTrajScan = [];

  function nukeTrajColor(relation) {
    if (relation === "ally") {
      return "rgba(74, 222, 128, 0.85)";
    }
    if (relation === "self") {
      return "rgba(56, 189, 248, 0.85)"; // cyan — matches nuke-prediction's own-salvo color
    }
    return "rgba(248, 113, 113, 0.85)";
  }

  function computeNukeTrajectoryPath(game, fromTile, toTile, directionUp = true) {
    {
      if (
        typeof UniversalPathFinding === "undefined" ||
        !UniversalPathFinding.Parabola
      ) {
        return null;
      }
      const speed =
        (game.config &&
          game.config().defaultNukeSpeed &&
          game.config().defaultNukeSpeed()) ||
        8;
      const pf = UniversalPathFinding.Parabola(game, {
        increment: speed,
        distanceBasedHeight: true,
        directionUp: directionUp !== false,
      });
      const path = pf.findPath(fromTile, toTile);
      return Array.isArray(path) ? path : null;
    }
  }

  // Cache the FULL flight path per nuke id, anchored the first time we see it.
  // The path is fixed (launch tile → target), so the drawn line never shortens
  // or jitters as the nuke advances — it stays put until the nuke lands. This
  // removes the "laggy" step-by-step redraw of a recomputed current→target line.
  const _nukeTrajById = new Map(); // id -> { relation, worldPts }

  function getNukeTrajectoryUnitData(game, unit) {
    if (!unit?.isActive?.()) return null;
    const relation = getNukePredictionRelation(game, unit);
    if (!relation) return null;
    const targetTile = unit.targetTile?.();
    const fromTile = unit.tile?.();
    if (targetTile == null || fromTile == null) return null;
    return {
      relation,
      targetTile,
      fromTile,
      id: unit.id?.() ?? `${fromTile}:${targetTile}`,
      type: unit.type?.(),
    };
  }

  function buildNukeTrajectoryPoints(game, data) {
    const path = NUKE_TRAJ_PARABOLA_TYPES.has(data.type)
      ? computeNukeTrajectoryPath(game, data.fromTile, data.targetTile)
      : null;
    if (!path || path.length < 2) {
      return [
        { x: game.x(data.fromTile), y: game.y(data.fromTile) },
        { x: game.x(data.targetTile), y: game.y(data.targetTile) },
      ];
    }
    const worldPts = [];
    const step = Math.max(1, Math.ceil(path.length / NUKE_TRAJ_MAX_POINTS));
    for (let index = 0; index < path.length; index += step) {
      worldPts.push({ x: game.x(path[index]), y: game.y(path[index]) });
    }
    const last = path[path.length - 1];
    worldPts.push({ x: game.x(last), y: game.y(last) });
    return worldPts;
  }

  function collectNukeTrajectoryScan(game) {
    let units;
    {
      units =
        typeof getCachedGameUnits === "function"
          ? getCachedGameUnits(game, ...NUKE_TRAJ_UNIT_TYPES)
          : game.units(...NUKE_TRAJ_UNIT_TYPES);
    }
    const out = [];
    const seen = new Set();
    for (const unit of units) {
      const data = getNukeTrajectoryUnitData(game, unit);
      if (!data) continue;
      seen.add(data.id);

      // Reuse the anchored path if we've already computed it for this nuke.
      let cached = _nukeTrajById.get(data.id);
      if (cached) {
        cached.relation = data.relation; // relation may flip (self→ally), keep fresh
        out.push(cached);
        continue;
      }

      cached = { relation: data.relation, worldPts: buildNukeTrajectoryPoints(game, data) };
      _nukeTrajById.set(data.id, cached);
      out.push(cached);
    }
    // Prune paths of nukes that have landed / been intercepted.
    if (_nukeTrajById.size > 0) {
      for (const id of _nukeTrajById.keys()) {
        if (!seen.has(id)) _nukeTrajById.delete(id);
      }
    }
    _nukeTrajScan = out;
  }

  function drawNukeTrajectoryPath(ctx, transform, projector, trajectory, point) {
    if (!trajectory.worldPts || trajectory.worldPts.length < 2) return;
    ctx.beginPath();
    let started = false;
    let anyVisible = false;
    for (const worldPoint of trajectory.worldPts) {
      let screenPoint;
      if (projector) {
        mapProject(projector, worldPoint.x, worldPoint.y, point);
        screenPoint = point;
      } else {
        screenPoint = mapWorldToScreen(transform, worldPoint.x, worldPoint.y);
        if (!screenPoint) {
          started = false;
          continue;
        }
      }
      anyVisible ||= mapPointOnScreen(screenPoint.x, screenPoint.y, 200);
      ctx[started ? "lineTo" : "moveTo"](screenPoint.x, screenPoint.y);
      started = true;
    }
    if (!anyVisible) return;
    ctx.strokeStyle = nukeTrajColor(trajectory.relation);
    ctx.stroke();
  }

  function drawNukeTrajectory(ctx, game, transform) {
    if (_nukeTrajScan.length === 0) {
      return;
    }
    const proj = typeof mapMakeProjector === "function" ? mapMakeProjector(transform) : null;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([5, 6]);
    const pt = { x: 0, y: 0 };
    for (const trajectory of _nukeTrajScan) {
      drawNukeTrajectoryPath(ctx, transform, proj, trajectory, pt);
    }
    ctx.restore();
  }

  registerMapOverlayLayer({
    id: "nuke-trajectory",
    scanIntervalMs: 250,
    isEnabled: function () {
      // Sub-toggle of nuke prediction: only draws when both are on.
      return runtimeState.nukePredictionEnabled && runtimeState.nukeTrajectoryEnabled;
    },
    scan: function (game) {
      collectNukeTrajectoryScan(game);
    },
    draw: function (ctx, game, transform) {
      drawNukeTrajectory(ctx, game, transform);
    },
  });

  function setNukeTrajectoryEnabled(enabled) {
    runtimeState.nukeTrajectoryEnabled = Boolean(enabled);
    if (typeof requestMapOverlayLoop === "function") {
      requestMapOverlayLoop();
    }
  }
