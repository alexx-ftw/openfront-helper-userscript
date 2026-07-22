// Silo Tracker + SAM Tracker — ported from Project Blon Openfront.js.
// Silo: notification bar + popout panel listing silos under construction / placed.
// SAM:  popout panel listing hostile building SAMs with vulnerability analysis
//       (which of our silos can nuke them before they finish) + ☢ nuke button.
//
// Style uses CSS custom properties (slate-glass) like every other panel.
// Settings are read from the Quick Panel settings cache (_quickPanelSettingsCache).

  var SILO_PANEL_ID = "openfront-helper-silo-panel";
  var SAM_PANEL_ID = "openfront-helper-sam-panel";
  var SILO_STYLE_ID = "openfront-helper-silo-styles";
  var _knownSiloIds = {};
  var _lastGameObj = null;
  var _lastAudioAlertMs = 0;
  // Auto-fire-building state: firedIds unitId -> true (fired) | "pending" (awaiting
  // recommendQty); plannedImpacts keeps a just-requested impact visible before the
  // server exposes the missile through game.units(). Both maps reset per game.
  var _samAutoFireState = { firedIds: {}, plannedImpacts: {}, lastGameObj: null };
  var _siloAutoFireState = { firedIds: {}, plannedImpacts: {}, lastGameObj: null };
  var _autoFireBuildingPlannedImpacts = [];
  var _autoFireBuildingLastGameObj = null;
  var _autoFirePendingSamFirstSeen = {};
  var AUTO_FIRE_PENDING_PLAN_GRACE_MS = 3000;
  var SAM_AUTO_FIRE_SAFETY_MARGIN_TICKS = 10; // ~1s buffer so the nuke lands well before completion

  // ---- Settings bridge (reads from Quick Panel cache, loaded before us) ----

  function _cfg(key, fallback) {
    {
      if (typeof _quickPanelSettingsCache === "object" && _quickPanelSettingsCache && key in _quickPanelSettingsCache)
        return _quickPanelSettingsCache[key];
    }{
      var defs = window.OpenFrontHelperSettings && window.OpenFrontHelperSettings.DEFAULT_SETTINGS;
      if (defs && key in defs) return defs[key];
    }
    return fallback;
  }

  // ---- Helpers (NOTE: _esc() and _tr() are defined in quick-panel.js, shared scope) ----

  function _unitOwnerId(unit) {
    if (typeof unit.state?.ownerID === "number") return unit.state.ownerID;
    if (typeof unit.ownerID === "number") return unit.ownerID;
    return typeof unit.ownerID === "function" ? unit.ownerID() : null;
  }

  function _ownerIdIsRegistered(game, ownerID) {
    return Boolean(game.smallIDToID?.has?.(ownerID) || game._playerStates?.has?.(ownerID));
  }

  function _safeOwner(unit, game) {
    if (!unit || !game) return null;
    {
      var ownerID = _unitOwnerId(unit);
      if (ownerID === null || ownerID === void 0) return null;
      if (ownerID !== 0 && !_ownerIdIsRegistered(game, ownerID)) return null;
      return typeof unit.owner === "function" ? unit.owner() : null;
    }
  }

  function _isAlly(unit, myPlayer, game) {
    if (!myPlayer || !unit) return false;
    var owner = _safeOwner(unit, game);
    if (!owner) return false;
    {
      return myPlayer.isAlliedWith ? myPlayer.isAlliedWith(owner) : false;
    }
  }

  function _getTileCoords(game, unit) {
    {
      var tile = typeof unit.tile === "function" ? unit.tile() : unit.tile;
      if (tile === null || tile === void 0) return null;
      if (typeof game.x !== "function" || typeof game.y !== "function") return null;
      return { x: game.x(tile), y: game.y(tile) };
    }
  }

  function _playerLabel(player, myPlayer) {
    if (!player) return "Unknown";
    {
      if (myPlayer && typeof player.smallID === "function" && typeof myPlayer.smallID === "function") {
        if (player.smallID() === myPlayer.smallID()) return _tr("You");
      }
    }
    if (typeof getPlayerDisplayName === "function") return getPlayerDisplayName(player);
    var smallID = typeof player.smallID === "function" ? player.smallID() : "?";
    return "Player " + smallID;
  }

  function _playerColor(player, game) {
    {
      return typeof getPlayerColor === "function" ? getPlayerColor(player, game) || "" : "";
    }
  }

  // ---- Silo unit collection ----

  function _unitStatesOfType(game, unitType, includeState) {
    var units = [];
    if (typeof game.unitStates !== "function" || typeof game.unit !== "function") return units;
    var states = game.unitStates();
    if (!states || typeof states.values !== "function") return units;
    for (const state of states.values()) {
      if (!state || state.unitType !== unitType || (includeState && !includeState(state))) continue;
      var unit = game.unit(state.id);
      if (unit) units.push(unit);
    }
    return units;
  }

  function _directUnitsOfType(game, unitType) {
    return typeof game.units === "function" ? game.units(unitType) || [] : [];
  }

  function _appendUniqueUnits(target, units, seen) {
    for (const unit of units) {
      if (!unit) continue;
      const id = typeof unit.id === "function" ? unit.id() : unit.id ?? unit.state?.id;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      if (!target.includes(unit)) target.push(unit);
    }
  }

  function _getSiloConstructionInfo(game) {
    {
      var stateUnit = _unitStatesOfType(
        game, "Missile Silo", (state) => state.underConstruction === true,
      )[0];
      if (stateUnit) return stateUnit;
      return _directUnitsOfType(game, "Missile Silo").find(
        (silo) => silo.isUnderConstruction?.(),
      ) || null;
    }
  }

  function _getAllSilos(game) {
    var list = [];
    {
      var seen = new Set();
      _appendUniqueUnits(list, _directUnitsOfType(game, "Missile Silo"), seen);
      _appendUniqueUnits(list, _unitStatesOfType(game, "Missile Silo"), seen);
    }
    return list;
  }

  // ---- SAM unit collection ----

  function _getSAMTrackerUnits(game) {
    var units = [];
    var seen = new Set();
    {
      _appendUniqueUnits(units, _unitStatesOfType(
        game, "SAM Launcher",
        (state) => state.markedForDeletion !== true,
      ), seen);
    }{
      if (typeof game.units === "function") {
        _appendUniqueUnits(units, game.units("SAM Launcher") || [], seen);
      }
    }
    return units;
  }

  // ---- Distance & trajectory ----

  function _euclideanDistSq(game, tileA, tileB) {
    {
      if (typeof game.euclideanDistSquared === "function") return game.euclideanDistSquared(tileA, tileB);
      var ax = game.x(tileA), ay = game.y(tileA);
      var bx = game.x(tileB), by = game.y(tileB);
      if (ax === void 0 || ay === void 0 || bx === void 0 || by === void 0) return Infinity;
      var dx = ax - bx, dy = ay - by;
      return dx * dx + dy * dy;
    }
  }

  function _nukeTrajectorySpec(game, fromTile, toTile, directionUp) {
    if (fromTile == null || toTile == null || typeof game.x !== "function" || typeof game.y !== "function") return null;
    var start = { x: game.x(fromTile), y: game.y(fromTile) };
    var end = { x: game.x(toTile), y: game.y(toTile) };
    if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var distance = Math.hypot(dx, dy);
    if (distance === 0) return { stationary: true, fromTile };
    var width = typeof game.width === "function" ? game.width() : 512;
    var height = typeof game.height === "function" ? game.height() : 512;
    if (typeof game.ref !== "function") return { direct: true, fromTile, toTile };
    var arc = (directionUp === false ? 1 : -1) * Math.max(distance / 3, 50);
    var clampX = (x) => Math.max(0, Math.min(width - 1, x));
    var clampY = (y) => Math.max(0, Math.min(height - 1, y));
    return {
      game, start, end, width, height,
      control1: { x: clampX(start.x + dx / 4), y: clampY(start.y + dy / 4 + arc) },
      control2: { x: clampX(start.x + dx * 3 / 4), y: clampY(start.y + dy * 3 / 4 + arc) },
    };
  }

  function _nukeBezierPoint(spec, t) {
    var inverse = 1 - t;
    var inverse2 = inverse * inverse;
    var t2 = t * t;
    return {
      x: inverse2 * inverse * spec.start.x + 3 * inverse2 * t * spec.control1.x +
        3 * inverse * t2 * spec.control2.x + t2 * t * spec.end.x,
      y: inverse2 * inverse * spec.start.y + 3 * inverse2 * t * spec.control1.y +
        3 * inverse * t2 * spec.control2.y + t2 * t * spec.end.y,
    };
  }

  function _sampleNukeBezier(spec) {
    var config = typeof spec.game.config === "function" ? spec.game.config() : null;
    var speed = config?.defaultNukeSpeed ? Number(config.defaultNukeSpeed()) : 8;
    var increment = Number.isFinite(speed) && speed > 0 ? speed : 8;
    var points = [spec.start];
    var previous = spec.start;
    var cumulative = 0;
    for (let t = 0.002; t <= 1.000001; t += 0.002) {
      var point = _nukeBezierPoint(spec, Math.min(t, 1));
      cumulative += Math.hypot(point.x - previous.x, point.y - previous.y);
      if (cumulative >= increment) {
        points.push(point);
        cumulative = 0;
      }
      previous = point;
    }
    points.push(spec.end);
    return points.map((point) => spec.game.ref(
      Math.max(0, Math.min(spec.width - 1, Math.floor(point.x))),
      Math.max(0, Math.min(spec.height - 1, Math.floor(point.y))),
    ));
  }

  function _linearNukeTrajectory(game, fromTile, toTile) {
    {
      var x0 = game.x(fromTile), y0 = game.y(fromTile);
      var x1 = game.x(toTile), y1 = game.y(toTile);
      return Array.from({ length: 51 }, (_value, index) => {
        var ratio = index / 50;
        return game.ref(Math.floor(x0 + (x1 - x0) * ratio), Math.floor(y0 + (y1 - y0) * ratio));
      });
    }
  }

  function _getNukeTrajectory(game, fromTile, toTile, directionUp) {
    {
      var spec = _nukeTrajectorySpec(game, fromTile, toTile, directionUp);
      if (!spec) return [];
      if (spec.stationary) return [fromTile];
      if (spec.direct) return [fromTile, toTile];
      return _sampleNukeBezier(spec);
    }
  }

  function _getSamRange(game, sam) {
    {
      var level = typeof sam.level === "function" ? sam.level() : 1;
      if (typeof game.config === "function" && typeof game.config().samRange === "function") {
        return game.config().samRange(level);
      }
      return 150 - 480 / (level + 5);
    }
  }

  // ---- Silo notification (shown inside Quick Panel) ----

  function updateSiloNotification() {
    var panelEnabled = _cfg("combatSiloPanel", false);
    if (!panelEnabled) return;

    var ctx;
    { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); }
    if (!ctx || !ctx.game) return;

    var silo = _getSiloConstructionInfo(ctx.game);
    if (!silo) {
      // No building silo found — still update the panel
      updateSiloPanel();
      return;
    }
    var owner = _safeOwner(silo, ctx.game);
    var me = ctx.game.myPlayer ? ctx.game.myPlayer() : null;
    var ownerLabel = _playerLabel(owner, me);
    var msg = ownerLabel === _tr("You") ? _tr("You are placing a silo") : (ownerLabel + " " + _tr("is placing a silo"));
    // Store notification text for Quick Panel to render
    window.__OFH_siloNotification = msg;
  }

  // ---- Styles ----

  function _ensureStyles() {
    if (document.getElementById(SILO_STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = SILO_STYLE_ID;
    s.textContent = [
      // Shared popout panel base
      "#" + SILO_PANEL_ID + ", #" + SAM_PANEL_ID + " {",
      "  position:fixed; z-index:9000; width:250px; min-height:140px; display:none; flex-direction:column;",
      "  resize:vertical; overflow:hidden;",
      "}",
      "  border:1px solid var(--oh-panel-border, rgba(148,163,184,0.34)); border-radius:8px;",
      "  background:var(--oh-panel-bg, rgba(12,18,20,0.92)); color:var(--oh-panel-text, #e2e8f0);",
      "  font:700 11px/1.15 'Aptos','Trebuchet MS','Segoe UI',sans-serif;",
      "  box-shadow:0 10px 26px rgba(0,0,0,0.4),0 0 16px var(--oh-accent-soft, rgba(0,255,102,0.15));",
      "  pointer-events:auto; user-select:none; overflow:hidden; flex-direction:column;",
      "}",
      "#" + SILO_PANEL_ID + "[data-visible='true'], #" + SAM_PANEL_ID + "[data-visible='true'] { display:flex; }",
      ".ohss-header {",
      "  display:flex; align-items:center; gap:6px; padding:6px 8px;",
      "  border-bottom:1px solid var(--oh-panel-header-border, rgba(148,163,184,0.18));",
      "  cursor:grab; touch-action:none; flex-shrink:0;",
      "}",
      ".ohss-header:active { cursor:grabbing; }",
      ".ohss-title {",
      "  flex:1; font-size:10px; font-weight:900; text-transform:uppercase;",
      "  letter-spacing:0.4px; color:var(--oh-panel-text-dim, rgba(148,163,184,0.85));",
      "}",
      ".ohss-x {",
      "  display:inline-flex; align-items:center; justify-content:center;",
      "  width:20px; height:20px; border:1px solid var(--oh-panel-border, rgba(148,163,184,0.25));",
      "  border-radius:6px; background:rgba(15,23,42,0.5); color:var(--oh-panel-text, #e2e8f0);",
      "  font-size:12px; font-weight:800; cursor:pointer;",
      "}",
      ".ohss-x:hover { background:var(--oh-accent-soft, rgba(0,255,102,0.15)); }",
      ".ohss-min-btn {",
      "  display:inline-flex; align-items:center; justify-content:center;",
      "  width:20px; height:20px; border:1px solid var(--oh-panel-border, rgba(148,163,184,0.25));",
      "  border-radius:6px; background:rgba(15,23,42,0.5); color:var(--oh-panel-text, #e2e8f0);",
      "  font-size:12px; font-weight:800; cursor:pointer; margin-right:2px;",
      "}",
      ".ohss-min-btn:hover { background:var(--oh-accent-soft, rgba(0,255,102,0.15)); }",
      ".ohss-quick-btn {",
      "  display:inline-flex; align-items:center; justify-content:center;",
      "  width:20px; height:20px; border:1px solid var(--oh-panel-border, rgba(148,163,184,0.25));",
      "  border-radius:6px; background:rgba(15,23,42,0.5); color:var(--oh-panel-text-dim, rgba(148,163,184,0.85));",
      "  font-size:11px; cursor:pointer; margin-right:2px; opacity:0.6;",
      "}",
      ".ohss-quick-btn:hover { opacity:1; background:var(--oh-accent-soft, rgba(0,255,102,0.15)); }",
      ".ohss-quick-btn.on {",
      "  opacity:1; color:#fff; background:var(--oh-accent-muted, rgba(0,255,102,0.35));",
      "  border-color:var(--oh-accent, #00ff66);",
      "}",
      "#" + SILO_PANEL_ID + "[data-minimized='true'] .ohss-body,",
      "#" + SAM_PANEL_ID + "[data-minimized='true'] .ohss-body { display:none; }",
      ".ohss-body {",
      "  flex:1; overflow-y:auto; overflow-x:hidden; padding:4px 0 4px 6px;",
      "  scrollbar-gutter:stable;",
      "}",
      ".ohss-row {",
      "  padding:5px 6px; border-bottom:1px solid rgba(255,255,255,0.08);",
      "  cursor:pointer; position:relative; transition:background 0.12s;",
      "}",
      ".ohss-row:hover { background:rgba(255,255,255,0.06); }",
      ".ohss-row-inner { padding-right:32px; pointer-events:none; }",
      ".ohss-row-top { display:flex; justify-content:space-between; gap:6px; align-items:center; }",
      ".ohss-row-name { color:var(--oh-panel-text, #e2e8f0); font-size:11px; font-weight:700; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
      ".ohss-row-status { font-size:10px; font-weight:700; padding:1px 4px; border-radius:3px; }",
      ".ohss-row-status.building { color:#00ccff; background:rgba(0,204,255,0.12); }",
      ".ohss-row-status.placed { color:#ffcc66; background:rgba(255,204,102,0.12); }",
      ".ohss-row-meta { display:flex; gap:8px; align-items:center; margin-top:2px; font-size:9px; color:var(--oh-panel-text-dim, rgba(148,163,184,0.85)); }",
      ".ohss-row-meta .ohss-tag { padding:0 3px; border-radius:2px; background:rgba(148,163,184,0.1); }",
      ".ohss-row-meta .ohss-time { color:#00ccff; }",
      ".ohss-nuke-btn {",
      "  position:absolute; right:6px; top:50%; transform:translateY(-50%);",
      "  background:#1a0000; border:1px solid #cc2200; color:#ff4400;",
      "  font-size:16px; width:28px; height:28px; border-radius:4px;",
      "  cursor:pointer; display:flex; align-items:center; justify-content:center;",
      "  padding:0; line-height:1; z-index:10;",
      "  transition:background 0.15s,color 0.15s,border-color 0.15s;",
      "}",
      ".ohss-nuke-btn:hover { background:#cc2200; color:#fff; border-color:#ff4400; }",
      ".ohss-nuke-track {",
      "  font-size:9px; color:#ff6644; margin:3px 0 0 0; padding:2px 4px;",
      "  background:rgba(255,50,0,0.08); border-radius:3px;",
      "  border-left:2px solid rgba(255,100,50,0.5);",
      "  line-height:1.3; pointer-events:none; white-space:nowrap;",
      "}",
      ".ohss-empty { color:rgba(148,163,184,0.72); font-size:10px; text-align:center; padding:5px 0; }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- Silo panel ----

  function _buildSiloRow(item) {
    var row = document.createElement("div");
    row.className = "ohss-row";
    row.setAttribute("data-unit-key", item.unitKey);

    var inner = document.createElement("div");
    inner.className = "ohss-row-inner";

    // Line 1: Name | Status badge
    var topRow = document.createElement("div");
    topRow.className = "ohss-row-top";

    var nameEl = document.createElement("span");
    nameEl.className = "ohss-row-name";
    nameEl.setAttribute("data-ss-name", "1");
    nameEl.style.color = item.ownerColor || "#e2e8f0";
    nameEl.textContent = item.ownerName;

    var statusEl = document.createElement("span");
    statusEl.className = "ohss-row-status " + (item.isBuilding ? "building" : "placed");
    statusEl.setAttribute("data-ss-status", "1");
    statusEl.textContent = item.isBuilding ? _tr("Building") : _tr("Placed");

    topRow.appendChild(nameEl);
    topRow.appendChild(statusEl);

    // Line 2: Coord | Level | Time
    var metaRow = document.createElement("div");
    metaRow.className = "ohss-row-meta";

    var coordEl = document.createElement("span");
    coordEl.setAttribute("data-ss-coord", "1");
    coordEl.textContent = item.posLabel;

    var levelEl = document.createElement("span");
    levelEl.className = "ohss-tag";
    levelEl.setAttribute("data-ss-level", "1");
    levelEl.textContent = "Lv." + item.level;

    metaRow.appendChild(coordEl);
    metaRow.appendChild(levelEl);

    if (item.isBuilding && item.timeLabel) {
      var timeEl = document.createElement("span");
      timeEl.className = "ohss-time";
      timeEl.setAttribute("data-ss-time", "1");
      timeEl.textContent = item.timeLabel;
      metaRow.appendChild(timeEl);
    }

    inner.appendChild(topRow);
    inner.appendChild(metaRow);
    row.appendChild(inner);

    // Nuke button — one-click fire (if enabled) or opens atom batch-fire dialog
    // with the enemy silo's tile pre-filled
    var nukeBtn = document.createElement("button");
    nukeBtn.className = "ohss-nuke-btn";
    nukeBtn.textContent = "☢";
    nukeBtn.title = _tr("Atom batch-fire to Silo");
    nukeBtn.onclick = function(e) {
      e.stopPropagation();
      if (row._blonTile == null) return;
      if (_cfg("combatSiloOneClickFire", false)) {
        if (!window.__OFH_atomBatch || typeof window.__OFH_atomBatch.fireRecommended !== "function") return;
        window.__OFH_atomBatch.fireRecommended(row._blonTile).then(function(res) {
          if (res && res.ok) {
            _toast("🚀 " + _tr("Fired") + " " + res.fired + "/" + res.qty + " " + _tr("atom bomb(s)"), "rgba(0,150,80,0.92)");
          } else {
            _toast(_atomFireFailureMessage(res), "rgba(220,40,40,0.92)");
          }
        });
        return;
      }
      {
        if (window.__OFH_atomBatch && typeof window.__OFH_atomBatch.openDialog === "function") {
          window.__OFH_atomBatch.openDialog(row._blonTile);
        } else if (typeof sendGamePacket === "function") {
          // Fallback: direct fire
          sendGamePacket({ type: "build_unit", unit: "Atom Bomb", tile: row._blonTile });
        }
      }
    };
    row.appendChild(nukeBtn);

    row._blonCoords = item.coords;
    row._blonTile = item.tile;

    row.addEventListener("click", function() {
      if (item.coords) _centerCameraOnTile(item.coords.x, item.coords.y);
    });

    return row;
  }

  function _updateSiloRow(row, item) {
    var nameEl = row.querySelector("[data-ss-name]");
    var statusEl = row.querySelector("[data-ss-status]");
    var coordEl = row.querySelector("[data-ss-coord]");
    var levelEl = row.querySelector("[data-ss-level]");
    var timeEl = row.querySelector("[data-ss-time]");
    if (nameEl && nameEl.textContent !== item.ownerName) nameEl.textContent = item.ownerName;
    if (nameEl && nameEl.style.color !== (item.ownerColor || "#e2e8f0")) nameEl.style.color = item.ownerColor || "#e2e8f0";
    if (statusEl) {
      var txt = item.isBuilding ? _tr("Building") : _tr("Placed");
      if (statusEl.textContent !== txt) statusEl.textContent = txt;
      statusEl.className = "ohss-row-status " + (item.isBuilding ? "building" : "placed");
    }
    if (coordEl && coordEl.textContent !== item.posLabel) coordEl.textContent = item.posLabel;
    if (levelEl) levelEl.textContent = "Lv." + item.level;
    _updateSiloTimeElement(row, timeEl, item);
    row._blonCoords = item.coords;
    row._blonUnit = item.unit;
    row._blonTile = item.tile;
  }

  function _updateSiloTimeElement(row, timeEl, item) {
    if (!item.isBuilding || !item.timeLabel) {
      if (timeEl) timeEl.remove();
      return;
    }
    var element = timeEl;
    if (!element) {
      element = document.createElement("span");
      element.className = "ohss-time";
      element.setAttribute("data-ss-time", "1");
      row.querySelector(".ohss-row-meta")?.appendChild(element);
    }
    element.textContent = item.timeLabel;
  }

  function _siloVisibleToTracker(silo, game, me, showAll, buildingOnly) {
    if (buildingOnly && !silo.isUnderConstruction?.()) return false;
    if (!me) return true;
    {
      var owner = _safeOwner(silo, game);
      if (_sameTrackerPlayer(me, owner)) return false;
      if (showAll) return true;
      return !_isAlly(silo, me, game) && !_sameTrackerTeam(me, owner);
    }
  }

  function _sameTrackerPlayer(left, right) {
    var leftId = left?.smallID?.();
    return leftId != null && right?.smallID?.() === leftId;
  }

  function _sameTrackerTeam(left, right) {
    var leftTeam = left?.team?.();
    var rightTeam = right?.team?.();
    return leftTeam != null && rightTeam != null && leftTeam === rightTeam;
  }

  function _siloConstructionTimeLabel(game, unit, currentTick, isBuilding) {
    if (!isBuilding) return "";
    var buildTicks = 100;
    {
      var duration = game.unitInfo?.("Missile Silo")?.constructionDuration;
      if (duration != null) buildTicks = duration;
    }
    var startTick = unit.state?.constructionStartTick;
    return startTick == null ? "" : (Math.max(0, buildTicks - (currentTick - startTick)) / 10).toFixed(1) + "s";
  }

  function _siloPanelItem(game, me, unit, currentTick) {
    var owner = _safeOwner(unit, game);
    var coords = _getTileCoords(game, unit);
    const tile = typeof unit.tile === "function" ? unit.tile() : unit.tile;
    var isBuilding = Boolean(unit.isUnderConstruction?.());
    return {
      unit, unitKey: String(typeof unit.id === "function" ? unit.id() : unit),
      ownerName: _playerLabel(owner, me), ownerColor: _playerColor(owner, game),
      coords, tile, isBuilding, level: typeof unit.level === "function" ? unit.level() : 1,
      posLabel: coords ? "@" + coords.x + "," + coords.y : "@unknown",
      timeLabel: _siloConstructionTimeLabel(game, unit, currentTick, isBuilding),
    };
  }

  function _syncSiloPanelRows(content, items, game, me) {
    content.querySelector(".ohss-empty")?.remove();
    var existing = Object.fromEntries(
      Array.from(content.querySelectorAll("[data-unit-key]")).map(
        (row) => [row.getAttribute("data-unit-key"), row],
      ),
    );
    var wanted = new Set(items.map((item) => item.unitKey));
    for (const [key, row] of Object.entries(existing)) if (!wanted.has(key)) row.remove();
    items.forEach((item, index) => {
      var row = existing[item.unitKey];
      if (!row) {
        row = _buildSiloRow(item);
        content.appendChild(row);
      } else _updateSiloRow(row, item);
      if (content.children[index] !== row) content.insertBefore(row, content.children[index] || null);
      _renderNukeTrack(row, _scanNukesToTile(game, me, item.tile));
    });
  }

  function updateSiloPanel() {
    var panelEnabled = _cfg("combatSiloPanel", false);
    runtimeDebugLog("[SiloSAM] updateSiloPanel:", panelEnabled);
    if (!panelEnabled) {
      _removePanel(SILO_PANEL_ID);
      return;
    }
    _ensureStyles();
    var panel = _ensurePanel(SILO_PANEL_ID, "Silo Tracker", "combatSiloPanel");
    _syncTrackerQuickButtons(panel);
    var content = panel.querySelector(".ohss-body");
    if (!content) return;

    var ctx;
    { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); }
    if (!ctx || !ctx.game) {
      _setEmpty(content, _tr("No game state available"));
      return;
    }

    var me = ctx.game.myPlayer ? ctx.game.myPlayer() : null;
    var buildingOnly = _cfg("combatSiloBuildingOnly", false);
    var showAll = _cfg("combatSiloShowAll", false);
    var filtered = _getAllSilos(ctx.game).filter(
      (silo) => _siloVisibleToTracker(silo, ctx.game, me, showAll, buildingOnly),
    );

    if (filtered.length === 0) {
      _setEmpty(content, _tr("No matching missile silos found"));
      return;
    }

    filtered.sort((a, b) => Number(!a.isUnderConstruction?.()) - Number(!b.isUnderConstruction?.()));

    var currentTick = typeof ctx.game.ticks === "function" ? ctx.game.ticks() : 0;
    var items = filtered.map((unit) => _siloPanelItem(ctx.game, me, unit, currentTick));
    _syncSiloPanelRows(content, items, ctx.game, me);
  }

  function _setEmpty(content, msg) {
    if (content.children.length !== 1 || !content.querySelector(".ohss-empty")) {
      content.innerHTML = '<div class="ohss-empty">' + _esc(msg) + '</div>';
    }
  }

  // ---- Nuke-flight tracker (ETA + count per target) ----

  // Index our in-flight nukes once per authoritative game tick. The tracker used
  // to rescan both unit families for every visible Silo and SAM row, causing a
  // one-second O(rows * missiles) main-thread spike in large late-game panels.
  let _nukeTrackIndexGame = null;
  let _nukeTrackIndexPlayer = null;
  let _nukeTrackIndexTick = null;
  let _nukeTrackIndex = new Map();

  function _addNukeTrackUnit(game, mySid, byTarget, unit) {
    {
      var owner = unit.owner?.();
      if (owner?.smallID && owner.smallID() !== mySid) return;
      var targetTile = unit.targetTile?.();
      if (targetTile == null) return;
      var entry = byTarget.get(targetTile);
      if (!entry) {
        entry = { count: 0, minEta: Infinity };
        byTarget.set(targetTile, entry);
      }
      entry.count++;
      if (typeof computeNukeRemainingTicks !== "function") return;
      var nukeTile = unit.tile?.();
      if (nukeTile == null) return;
      var eta = computeNukeRemainingTicks(game, nukeTile, targetTile);
      if (eta != null) entry.minEta = Math.min(entry.minEta, eta);
    }
  }

  function _buildNukeTrackIndex(game, myPlayer) {
    var byTarget = new Map();
    var mySid = myPlayer.smallID ? myPlayer.smallID() : -1;
    for (const type of ["Atom Bomb", "Hydrogen Bomb"]) {
      for (const unit of myPlayer.units(type) || []) {
        _addNukeTrackUnit(game, mySid, byTarget, unit);
      }
    }
    return byTarget;
  }

  function _getNukeTrackIndex(game, myPlayer) {
    var tick = typeof game.ticks === "function" ? game.ticks() : null;
    if (
      game !== _nukeTrackIndexGame ||
      myPlayer !== _nukeTrackIndexPlayer ||
      tick !== _nukeTrackIndexTick
    ) {
      _nukeTrackIndexGame = game;
      _nukeTrackIndexPlayer = myPlayer;
      _nukeTrackIndexTick = tick;
      _nukeTrackIndex = _buildNukeTrackIndex(game, myPlayer);
    }
    return _nukeTrackIndex;
  }

  function _scanNukesToTile(game, myPlayer, tile) {
    if (!game || !myPlayer || tile == null) return null;
    {
      var entry = _getNukeTrackIndex(game, myPlayer).get(tile);
      if (!entry) return null;
      return {
        count: entry.count,
        etaSec: entry.minEta === Infinity ? null : entry.minEta / 10,
      };
    }
  }

  // Create or update a compact inline badge on a row showing nuke-flight status.
  // Removes it when info is null (no nukes in flight).
  function _renderNukeTrack(row, info) {
    var el = row.querySelector(".ohss-nuke-track");
    if (!info) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = "ohss-nuke-track";
      // Append after .ohss-row-inner, before the absolutely-positioned nuke button
      var inner = row.querySelector(".ohss-row-inner");
      if (inner && inner.nextSibling) {
        row.insertBefore(el, inner.nextSibling);
      } else {
        row.appendChild(el);
      }
    }
    var etaStr = info.etaSec != null ? " · ⏱" + info.etaSec.toFixed(1) + "s" : "";
    el.textContent = "🚀×" + info.count + etaStr;
  }

  // Failure reasons come from lifecycle.js's recommendQty (path-coverage math,
  // not target-type-specific), so this one message set is shared by both trackers.
  function _atomFireFailureMessage(res) {
    var reason = res && res.reason;
    if (reason === "no-silo") return _tr("Cannot build atom here (no silo / disabled / unreachable).");
    if (reason === "too-slow") return _tr("Too slow — SAMs reload before impact. Lower the Delay in the Atom settings tab.");
    if (reason === "too-strong") return _tr("Too many SAM levels here — atoms can't overwhelm them even at full speed. Use MIRV.");
    if (reason === "gold") return _tr("Not enough gold to fire the recommended salvo.");
    if (reason === "silo") return _tr("Not enough silos ready to fire the recommended salvo.");
    return _tr("Cannot fire right now.");
  }

  var _AUTO_FIRE_BUILDING_TYPES = [
    "City",
    "Defense Post",
    "SAM Launcher",
    "Missile Silo",
    "Port",
    "Factory",
  ];
  var _AUTO_FIRE_NUKE_TYPES = ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"];

  function _autoFireUnitTile(unit) {
    {
      return typeof unit.tile === "function" ? unit.tile() : unit.tile;
    }
  }

  function _autoFireUnitKey(unit) {
    {
      var id = typeof unit.id === "function" ? unit.id() : unit.id;
      if (id !== null && id !== void 0) return String(id);
      if (unit.state && unit.state.id !== null && unit.state.id !== void 0) return String(unit.state.id);
    }
    return null;
  }

  function _autoFireUnitOwner(unit, game) {
    {
      if (unit && typeof unit.owner === "function") {
        var direct = unit.owner();
        if (direct) return direct;
      }
    }
    return _safeOwner(unit, game);
  }

  function _autoFireOwnerIsHostile(owner, me) {
    if (!owner || !me) return false;
    return !_autoFireSafeRelation(() => owner.smallID?.() === me.smallID?.()) &&
      !_autoFireSafeRelation(() => me.isAlliedWith?.(owner)) &&
      !_autoFireSafeRelation(() => me.isFriendly?.(owner)) &&
      !_autoFireSafeRelation(() => me.isOnSameTeam?.(owner)) &&
      !_autoFireSafeRelation(() => owner.isFriendly?.(me));
  }

  function _autoFireSafeRelation(read) {
    {
      return Boolean(read());
    }
  }

  function _autoFireNukeRadius(game, type) {
    var fallback = type === "Hydrogen Bomb" ? 100 : 30;
    {
      var cfg = game && typeof game.config === "function" ? game.config() : null;
      var magnitude = cfg && typeof cfg.nukeMagnitudes === "function" ? cfg.nukeMagnitudes(type) : null;
      var radius = Number(magnitude && (magnitude.outer !== void 0 ? magnitude.outer : magnitude.inner));
      if (Number.isFinite(radius) && radius > 0) return radius;
    }
    return fallback;
  }

  function _autoFireGetUnits(game, types) {
    {
      if (!game || typeof game.units !== "function") return [];
      return game.units.apply(game, types) || [];
    }
  }

  function _autoFireNearestSiloTile(game, me, targetTile) {
    const silos = me && typeof me.units === "function" ? me.units("Missile Silo") || [] : [];

    var bestTile = null;
    var bestDistance = Infinity;
    for (let i = 0; i < silos.length; i++) {
      var silo = silos[i];
      if (!_autoFireSiloIsUsable(silo)) continue;
      var siloTile = _autoFireUnitTile(silo);
      if (siloTile === null || siloTile === void 0) continue;
      var distance = _autoFireSiloDistance(game, siloTile, targetTile);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestTile = siloTile;
      }
    }
    return bestTile;
  }

  function _autoFireSiloIsUsable(silo) {
    if (!silo) return false;
    {
      return !silo.isUnderConstruction?.() && silo.isActive?.() !== false;
    }
  }

  function _autoFireSiloDistance(game, siloTile, targetTile) {
    {
      return typeof game.manhattanDist === "function"
        ? game.manhattanDist(siloTile, targetTile)
        : _euclideanDistSq(game, siloTile, targetTile);
    }
  }

  function _autoFireNukePath(game, fromTile, targetTile, directionUp) {
    {
      if (
        typeof UniversalPathFinding !== "undefined" &&
        UniversalPathFinding.Parabola
      ) {
        var cfg = typeof game.config === "function" ? game.config() : null;
        var speed =
          cfg && typeof cfg.defaultNukeSpeed === "function"
            ? Number(cfg.defaultNukeSpeed())
            : 8;
        var path = UniversalPathFinding.Parabola(game, {
          increment: Number.isFinite(speed) && speed > 0 ? speed : 8,
          distanceBasedHeight: true,
          directionUp: directionUp !== false,
        }).findPath(fromTile, targetTile);
        if (Array.isArray(path) && path.length > 0) return path;
      }
    }
    return _getNukeTrajectory(game, fromTile, targetTile, directionUp);
  }

  function _autoFireCurrentTick(game) {
    {
      var tick = typeof game.ticks === "function" ? Number(game.ticks()) : 0;
      return Number.isFinite(tick) ? tick : 0;
    }
  }

  function _autoFireSamConstructionStartTick(sam) {
    var raw = sam && sam.__src ? sam.__src : sam;
    var state = raw && raw.state;
    var candidates = [
      state && state.constructionStartTick,
      raw && raw.constructionStartTick,
      raw && raw.data && raw.data.constructionStartTick,
    ];
    {
      if (raw && typeof raw.getConstructionStartTick === "function") {
        candidates.push(raw.getConstructionStartTick());
      }
    }
    var found = candidates
      .filter((value) => value !== null && value !== void 0 && value !== "")
      .map(Number).find(Number.isFinite);
    return found === void 0 ? null : found;
  }

  function _autoFireSamConstructionTicks(game) {
    var infos = [];
    {
      if (game && typeof game.unitInfo === "function") infos.push(game.unitInfo("SAM Launcher"));
    }{
      var cfg = game && typeof game.config === "function" ? game.config() : null;
      if (cfg && typeof cfg.unitInfo === "function") infos.push(cfg.unitInfo("SAM Launcher"));
    }
    for (const info of infos) {
      var duration = _autoFireConstructionDuration(info);
      if (duration !== null) return duration;
    }
    return 300;
  }

  function _autoFireConstructionDuration(info) {
    if (!info) return null;
    {
      var raw = typeof info.constructionDuration === "function"
        ? info.constructionDuration() : info.constructionDuration;
      var duration = Number(raw);
      return Number.isFinite(duration) && duration > 0 ? duration : null;
    }
  }

  function _autoFireSamReadyAtTick(game, sam, currentTick, constructionTicks) {
    if (!Number.isFinite(constructionTicks) || constructionTicks <= 0) {
      constructionTicks = _autoFireSamConstructionTicks(game);
    }
    var startTick = _autoFireSamConstructionStartTick(sam);
    if (Number.isFinite(startTick)) return startTick + constructionTicks;

    // If the server view does not expose constructionStartTick, assume the SAM
    // started when it was first observed. This is conservative: it can only make
    // auto-fire wait longer, never turn a potentially interceptable shot into a
    // gold-losing shot.
    var key = _autoFireUnitKey(sam);
    if (!key) return currentTick + constructionTicks;
    var firstSeen = _autoFirePendingSamFirstSeen[key];
    if (!Number.isFinite(firstSeen)) {
      firstSeen = currentTick;
      _autoFirePendingSamFirstSeen[key] = firstSeen;
    }
    return firstSeen + constructionTicks;
  }

  function _autoFirePathArrivalTicks(game, trajectory, speed) {
    var arrivals = [];
    var cumulativeDistance = 0;
    for (let i = 0; i < trajectory.length; i++) {
      if (i > 0) {
        var segment = _euclideanDistSq(game, trajectory[i - 1], trajectory[i]);
        if (!Number.isFinite(segment) || segment < 0) return null;
        cumulativeDistance += Math.sqrt(segment);
      }
      arrivals.push(Math.max(0, Math.ceil(cumulativeDistance / speed)));
    }
    if (arrivals.length === 1) arrivals[0] = 1;
    return arrivals;
  }

  function _autoFireSamTravelTicks(game, samTile, pathTile, speed) {
    const distance = typeof game.manhattanDist === "function"
      ? Number(game.manhattanDist(samTile, pathTile))
      : (() => {
          const distanceSquared = _euclideanDistSq(game, samTile, pathTile);
          return Number.isFinite(distanceSquared) ? Math.sqrt(distanceSquared) : Infinity;
        })();
    if (!Number.isFinite(distance) || distance < 0) return Infinity;
    return Math.max(0, Math.ceil(distance / speed));
  }

  // Return the total level capacity of hostile SAMs that can intercept an atom
  // along the actual approach corridor. A pending SAM counts when its expected
  // ready tick is early enough to launch an interceptor before the nuke reaches
  // a targetable point inside its range. This is a local safety backstop for
  // auto-fire-building: recommendQty normally performs the same check, but a
  // partial/stale game view must never turn a known interceptable shot into a
  // guaranteed gold loss.
  function _autoFireInterceptionContext(game, me, targetTile, directionUp) {
    var sourceTile = _autoFireNearestSiloTile(game, me, targetTile);
    if (sourceTile == null) return null;
    var trajectory = _autoFireNukePath(game, sourceTile, targetTile, directionUp);
    if (!Array.isArray(trajectory) || trajectory.length === 0) return null;
    var config = typeof game.config === "function" ? game.config() : null;
    var nukeSpeed = _autoFirePositiveConfig(config, "defaultNukeSpeed", 8);
    var samSpeed = _autoFirePositiveConfig(config, "defaultSamMissileSpeed", 12);
    var targetableRange = _autoFirePositiveConfig(config, "defaultNukeTargetableRange", Infinity);
    var targetableRangeSquared = Number.isFinite(targetableRange) && targetableRange > 0
      ? targetableRange * targetableRange : Infinity;
    var arrivalTicks = _autoFirePathArrivalTicks(game, trajectory, nukeSpeed);
    if (!arrivalTicks?.length) return null;
    return {
      game, me, targetTile, sourceTile, trajectory, arrivalTicks, samSpeed,
      targetableRangeSquared, currentTick: _autoFireCurrentTick(game),
      constructionTicks: _autoFireSamConstructionTicks(game),
      targetArrivalTick: arrivalTicks.at(-1) ?? 0,
    };
  }

  function _autoFirePositiveConfig(config, method, fallback) {
    {
      var value = Number(config?.[method]?.());
      return Number.isFinite(value) && value > 0 ? value : fallback;
    }
  }

  function _autoFireSamCanInterceptPoint(context, samTile, rangeSquared, readyOffset, index) {
    var pathTile = context.trajectory[index];
    var targetable = _euclideanDistSq(context.game, pathTile, context.sourceTile) <= context.targetableRangeSquared ||
      _euclideanDistSq(context.game, pathTile, context.targetTile) <= context.targetableRangeSquared;
    if (!targetable || _euclideanDistSq(context.game, pathTile, samTile) > rangeSquared) return false;
    var travelTicks = _autoFireSamTravelTicks(context.game, samTile, pathTile, context.samSpeed);
    if (!Number.isFinite(travelTicks)) return false;
    var shootOffset = context.arrivalTicks[index] - travelTicks;
    return shootOffset >= readyOffset && shootOffset >= 0 &&
      shootOffset + travelTicks < context.targetArrivalTick;
  }

  function _autoFireSamInterceptionLevel(context, sam) {
    var underConstruction;
    {
      underConstruction = Boolean(sam.isUnderConstruction?.());
      if (!underConstruction && sam.isActive?.() === false) return 0;
    }
    if (!_autoFireOwnerIsHostile(_autoFireUnitOwner(sam, context.game), context.me)) return 0;
    var samTile = _autoFireUnitTile(sam);
    var range = _getSamRange(context.game, sam);
    if (samTile == null || !Number.isFinite(range) || range <= 0) return 0;
    var readyAt = underConstruction
      ? _autoFireSamReadyAtTick(context.game, sam, context.currentTick, context.constructionTicks)
      : context.currentTick;
    var readyOffset = Math.max(0, Math.ceil(readyAt - context.currentTick));
    for (let index = 0; index < context.trajectory.length; index++) {
      if (_autoFireSamCanInterceptPoint(context, samTile, range * range, readyOffset, index)) {
        return typeof sam.level === "function" ? Number(sam.level()) || 1 : 1;
      }
    }
    return 0;
  }

  function _autoFireBuiltSamInterceptionCapacity(game, me, targetTile, directionUp) {
    var context = _autoFireInterceptionContext(game, me, targetTile, directionUp);
    if (!context) return 0;
    var sams = _getSAMTrackerUnits(game);
    var capacity = 0;
    var seen = new Set();

    for (let i = 0; i < sams.length; i++) {
      var sam = sams[i];
      if (!sam) continue;
      var samId = _autoFireUnitKey(sam) || "sam:" + i;
      if (seen.has(samId)) continue;
      seen.add(samId);
      capacity += _autoFireSamInterceptionLevel(context, sam);
    }
    return capacity;
  }

  function _autoFireCollectEnemyBuildings(game, me) {
    var out = [];
    var seen = {};
    for (let t = 0; t < _AUTO_FIRE_BUILDING_TYPES.length; t++) {
      var units = _autoFireGetUnits(game, [_AUTO_FIRE_BUILDING_TYPES[t]]);
      for (let i = 0; i < units.length; i++) {
        var unit = units[i];
        var record = _autoFireEnemyBuildingRecord(game, me, unit);
        if (!record) continue;
        var key = record.key;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(record);
      }
    }
    return out;
  }

  function _autoFireEnemyBuildingRecord(game, me, unit) {
    if (!unit || unit.state?.markedForDeletion === true) return null;
    var tile = _autoFireUnitTile(unit);
    if (tile == null || !_autoFireOwnerIsHostile(_autoFireUnitOwner(unit, game), me)) return null;
    return { unit, tile, key: _autoFireUnitKey(unit) || "tile:" + String(tile) };
  }

  // Pick a legal impact tile that still hits the primary SAM/Silo and maximizes
  // enemy buildings inside the atom blast. Candidates are existing hostile building
  // tiles, so this never invents a coordinate that could be water or unreachable.
  function _chooseAutoFireImpactTile(game, primaryTile, me, buildings) {
    if (primaryTile === null || primaryTile === void 0) return primaryTile;
    var radius = _autoFireNukeRadius(game, "Atom Bomb");
    var enemyBuildings = Array.isArray(buildings)
      ? buildings
      : _autoFireCollectEnemyBuildings(game, me);
    return chooseMaxNukeBuildingImpactTile(
      game,
      primaryTile,
      enemyBuildings,
      radius,
      true,
    );
  }

  function _autoFireUncoveredEnemyBuildings(
    game,
    buildings,
    impacts,
    ownFlightTicks = Infinity,
  ) {
    var enemyBuildings = Array.isArray(buildings) ? buildings : [];
    var knownImpacts = Array.isArray(impacts) ? impacts : [];
    if (knownImpacts.length === 0) return enemyBuildings;
    return enemyBuildings.filter(function(building) {
      return !_isAutoFireTargetCovered(
        game,
        building?.tile,
        null,
        null,
        { impacts: knownImpacts, ownFlightTicks },
      );
    });
  }

  function _autoFireNukeImpacts(game, state) {
    var impacts = [];
    var units = _autoFireGetUnits(game, _AUTO_FIRE_NUKE_TYPES);
    for (let i = 0; i < units.length; i++) {
      var impact = _autoFireActiveNukeImpact(game, units[i]);
      if (impact) impacts.push(impact);
    }

    // A just-fired salvo can take a few frames to enter game.units(). Treat its
    // planned impact as occupied immediately, otherwise neighboring constructions
    // can each trigger a duplicate salvo during that registration gap.
    _appendAutoFirePlannedImpacts(impacts, game, state);
    for (let p = 0; p < _autoFireBuildingPlannedImpacts.length; p++) {
      var sharedPlan = _autoFireBuildingPlannedImpacts[p];
      if (!sharedPlan || sharedPlan.state === state) continue;
      impacts.push({ targetTile: sharedPlan.tile, radius: _autoFireNukeRadius(game, "Atom Bomb") });
    }
    return impacts;
  }

  function _autoFireActiveNukeImpact(game, unit) {
    if (!unit) return null;
    {
      if (typeof unit.isActive !== "function" || !unit.isActive()) return null;
      var targetTile = typeof unit.targetTile === "function" ? unit.targetTile() : unit.targetTile;
      if (targetTile == null) return null;
      var type = typeof unit.type === "function" ? unit.type() : unit.type;
      var unitTile = typeof unit.tile === "function" ? unit.tile() : unit.tile;
      var remainingTicks = null;
      if (
        unitTile != null &&
        typeof computeNukeRemainingTicks === "function"
      ) {
        remainingTicks = computeNukeRemainingTicks(
          game,
          unitTile,
          targetTile,
        );
      }
      return {
        targetTile,
        radius: _autoFireNukeRadius(game, type),
        remainingTicks,
      };
    }
  }

  function _appendAutoFirePlannedImpacts(impacts, game, state) {
    var planned = state?.plannedImpacts;
    if (!planned || typeof planned !== "object") return;
    for (const [key, tile] of Object.entries(planned)) {
      if (!Object.hasOwn(planned, key) || tile == null) continue;
      impacts.push({ targetTile: tile, radius: _autoFireNukeRadius(game, "Atom Bomb") });
    }
  }

  // Return true when any active missile — or a just-requested auto-fire salvo —
  // already puts the target inside its blast radius. Ownership is intentionally
  // not filtered: an incoming missile still destroys the enemy building, and the
  // auto-fire should not spend another salvo on a demolition already guaranteed.
  function _autoFireImpactArrivesNoLater(impact, ownFlightTicks) {
    if (!Number.isFinite(ownFlightTicks)) return true;
    var remainingTicks = Number(impact?.remainingTicks);
    return !Number.isFinite(remainingTicks) || remainingTicks <= ownFlightTicks;
  }

  function _isAutoFireTargetCovered(
    game,
    primaryTile,
    me,
    state,
    impactContext,
  ) {
    if (primaryTile === null || primaryTile === void 0) return false;
    var knownImpacts;
    if (Array.isArray(impactContext)) {
      knownImpacts = impactContext;
    } else if (Array.isArray(impactContext?.impacts)) {
      knownImpacts = impactContext.impacts;
    } else {
      knownImpacts = _autoFireNukeImpacts(game, state);
    }
    var ownFlightTicks = Array.isArray(impactContext)
      ? Infinity
      : impactContext?.ownFlightTicks ?? Infinity;
    for (let i = 0; i < knownImpacts.length; i++) {
      if (!_autoFireImpactArrivesNoLater(knownImpacts[i], ownFlightTicks)) {
        continue;
      }
      var radius = knownImpacts[i].radius;
      if (
        _euclideanDistSq(game, primaryTile, knownImpacts[i].targetTile) <
        radius * radius
      ) {
        return true;
      }
    }
    return false;
  }

  // Fire-and-forget one auto-fire shot at `tile`, tracked via `state.firedIds[id]`
  // so it is never re-attempted (pending while recommendQty/fireNow are in flight,
  // true once fired, deleted again on failure so a later tick can retry).
  function _autoFireAttempt(...args) {
    var options = _normalizeAutoFireAttemptArgs(args);
    var { state, id, impactTile, owner, me, maxQty, targetLabel, minimumQty } = options;
    if (!state.plannedImpacts || typeof state.plannedImpacts !== "object") state.plannedImpacts = {};
    state.firedIds[id] = "pending";
    state.plannedImpacts[id] = impactTile;
    var sharedPlan = { state: state, id: id, tile: impactTile };
    _autoFireBuildingPlannedImpacts.push(sharedPlan);
    var releasePlan = function() {
      delete state.plannedImpacts[id];
      for (let i = _autoFireBuildingPlannedImpacts.length - 1; i >= 0; i--) {
        if (_autoFireBuildingPlannedImpacts[i] === sharedPlan) _autoFireBuildingPlannedImpacts.splice(i, 1);
      }
    };
    var clearPlan = function() {
      releasePlan();
      delete state.firedIds[id];
    };
    window.__OFH_atomBatch.recommendQty(impactTile).then(function(rec) {
      var recommendedQty = rec ? Number(rec.recommended) : NaN;
      if (
        !rec ||
        !rec.ok ||
        !Number.isFinite(recommendedQty) ||
        recommendedQty > maxQty ||
        (minimumQty && recommendedQty < minimumQty)
      ) {
        clearPlan();
        return;
      }
      return window.__OFH_atomBatch.fireNow(impactTile, recommendedQty).then(function(res) {
        if (!res || Number(res.fired) <= 0) {
          clearPlan();
          return;
        }
        state.firedIds[id] = true;
        // Keep the impact reserved briefly while the server registers the nuke.
        // Once active, the real game.units() scan takes over; if registration fails
        // or the missile is intercepted, a neighboring target may be reconsidered.
        if (window && typeof window.setTimeout === "function") {
          window.setTimeout(releasePlan, AUTO_FIRE_PENDING_PLAN_GRACE_MS);
        }
        var label = _playerLabel(owner, me);
        _toast("🚀 " + _tr("Auto-fired") + " " + res.fired + " " + _tr("atom bomb(s)") + " → " + label + "'s " + targetLabel, "rgba(0,150,80,0.92)");
      });
    });
  }

  function _normalizeAutoFireAttemptArgs(args) {
    if (args.length === 1 && args[0] && typeof args[0] === "object") return args[0];
    const [state, id, tile, impactTile, owner, me, maxQty, targetLabel, minimumQty] = args;
    return { state, id, tile, impactTile, owner, me, maxQty, targetLabel, minimumQty };
  }

  // Shared "auto-nuke hostile structures still under construction" sweep — used by
  // both the SAM Tracker and the Silo Tracker. Both only ever target structures
  // still under construction (denying the enemy's investment before it's useful).
  //
  // opts.raceConstruction (SAM only) additionally requires the nuke to land BEFORE
  // construction completes — a SAM Launcher, once active, can intercept, so firing
  // late risks the shot getting shot down by the very target it was aimed at (or by
  // this SAM once it can help defend elsewhere). A Missile Silo has no interception
  // ability of its own, so that race serves no purpose there: whether our nuke lands
  // before or after the silo finishes building doesn't change whether it survives —
  // only fireNow's own gold/silos-ready/SAM-coverage-along-the-path check (the same
  // one one-click fire uses) decides that.
  function _resetAutoFireBuildingState(game, state) {
    state.lastGameObj = game;
    state.firedIds = {};
    state.plannedImpacts = {};
    if (game === _autoFireBuildingLastGameObj) return;
    _autoFireBuildingLastGameObj = game;
    _autoFireBuildingPlannedImpacts = [];
    _autoFirePendingSamFirstSeen = {};
  }

  function _autoFireBuildingReady(ctx, opts) {
    if (!_autoFireOptionsEnabled(ctx, opts) || !_autoFireBridgeReady(opts)) return null;
    var { game } = ctx;
    if (game !== opts.state.lastGameObj) {
      _resetAutoFireBuildingState(game, opts.state);
      return null;
    }
    opts.state.plannedImpacts ??= {};
    var me = game.myPlayer?.();
    if (!me) return null;
    const rocketDirectionUp = ctx.buildMenu?.uiState?.rocketDirectionUp !== false;
    return {
      ctx, opts, game, state: opts.state, me, rocketDirectionUp,
      maxQty: Math.max(1, Math.floor(Number(_cfg(opts.maxQtyKey, 1))) || 1),
      currentTick: typeof game.ticks === "function" ? game.ticks() : 0,
      enemyBuildings: null, impacts: null, samInterceptions: Object.create(null),
    };
  }

  function _autoFireOptionsEnabled(ctx, opts) {
    return Boolean(_cfg(opts.trackerKey, false) && _cfg(opts.autoFireKey, false) && ctx?.game);
  }

  function _autoFireBridgeReady(opts) {
    if (typeof window.__OFH_atomBatch?.recommendQty !== "function") return false;
    return !opts.raceConstruction || typeof window.__OFH_atomBatch.estimateFlightTicks === "function";
  }

  function _autoFireRaceAllows(context, unit, tile) {
    if (!context.opts.raceConstruction) return true;
    var buildTicks = context.opts.defaultBuildTicks;
    {
      var duration = context.game.unitInfo?.(context.opts.unitInfoName)?.constructionDuration;
      if (duration != null) buildTicks = duration;
    }
    var startTick = unit.state?.constructionStartTick;
    if (startTick == null) return false;
    var remaining = Math.max(0, buildTicks - (context.currentTick - startTick));
    var flightTicks = window.__OFH_atomBatch.estimateFlightTicks(tile);
    return flightTicks != null && flightTicks < remaining - SAM_AUTO_FIRE_SAFETY_MARGIN_TICKS;
  }

  function _autoFireBuildingCandidate(context, unit) {
    if (!unit?.isUnderConstruction?.()) return null;
    var id = _autoFireUnitKey(unit);
    if (id == null || Object.hasOwn(context.state.firedIds, id)) return null;
    var owner = _safeOwner(unit, context.game);
    if (!_autoFireOwnerIsHostile(owner, context.me)) return null;
    var tile = _autoFireUnitTile(unit);
    if (tile == null || !_autoFireRaceAllows(context, unit, tile)) return null;
    return { id, owner, tile };
  }

  function _autoFireCandidateImpact(context, candidate) {
    context.impacts ??= _autoFireNukeImpacts(context.game, context.state);
    var ownFlightEstimate =
      window.__OFH_atomBatch.estimateFlightTicks?.(candidate.tile);
    var ownFlightTicks = ownFlightEstimate == null
      ? Infinity
      : Number(ownFlightEstimate);
    if (!Number.isFinite(ownFlightTicks)) ownFlightTicks = Infinity;
    if (_isAutoFireTargetCovered(
      context.game,
      candidate.tile,
      context.me,
      context.state,
      { impacts: context.impacts, ownFlightTicks },
    )) return null;
    context.enemyBuildings ??= _autoFireCollectEnemyBuildings(context.game, context.me);
    var uncoveredBuildings = _autoFireUncoveredEnemyBuildings(
      context.game,
      context.enemyBuildings,
      context.impacts,
      ownFlightTicks,
    );
    var impactTile = _chooseAutoFireImpactTile(
      context.game, candidate.tile, context.me, uncoveredBuildings,
    );
    var key = String(impactTile);
    if (!Object.hasOwn(context.samInterceptions, key)) {
      context.samInterceptions[key] = _autoFireBuiltSamInterceptionCapacity(
        context.game, context.me, impactTile, context.rocketDirectionUp,
      );
    }
    return { impactTile, minimumQty: context.samInterceptions[key] + 1 };
  }

  function _runAutoFireBuilding(ctx, opts) {
    var context = _autoFireBuildingReady(ctx, opts);
    if (!context) return;
    for (const unit of opts.getUnits(context.game)) {
      var candidate = _autoFireBuildingCandidate(context, unit);
      if (!candidate) continue;
      var impact = _autoFireCandidateImpact(context, candidate);
      if (!impact || impact.minimumQty > context.maxQty) continue;
      _autoFireAttempt({
        state: context.state, id: candidate.id,
        impactTile: impact.impactTile, owner: candidate.owner, me: context.me,
        maxQty: context.maxQty, targetLabel: opts.targetLabel,
        minimumQty: impact.minimumQty,
      });
    }
  }

  function _runSamAutoFireBuilding(ctx) {
    _runAutoFireBuilding(ctx, {
      trackerKey: "combatSamTracker",
      autoFireKey: "combatSamAutoFireBuilding",
      maxQtyKey: "combatSamAutoFireMaxQty",
      getUnits: _getSAMTrackerUnits,
      unitInfoName: "SAM Launcher",
      defaultBuildTicks: 300,
      state: _samAutoFireState,
      targetLabel: "SAM",
      raceConstruction: true, // must land before it can intercept
    });
  }

  function _runSiloAutoFireBuilding(ctx) {
    _runAutoFireBuilding(ctx, {
      trackerKey: "combatSiloPanel",
      autoFireKey: "combatSiloAutoFireBuilding",
      maxQtyKey: "combatSiloAutoFireMaxQty",
      getUnits: _getAllSilos,
      unitInfoName: "Missile Silo",
      defaultBuildTicks: 100,
      state: _siloAutoFireState,
      targetLabel: "Silo",
      raceConstruction: false, // a Silo can't intercept — fire whenever fireNow allows it
    });
  }

  // ---- SAM panel ----

  function _samVisibleToTracker(sam, game, me, showAll, buildingOnly) {
    if (buildingOnly && !sam.isUnderConstruction?.()) return false;
    var owner = _safeOwner(sam, game);
    if (!owner) return false;
    if (!me) return true;
    if (_sameTrackerPlayer(me, owner)) return false;
    return showAll || (!_autoFireSafeRelation(() => me.isAlliedWith?.(owner)) &&
      !_sameTrackerTeam(me, owner));
  }

  function _samPanelItem(game, me, sam, currentTick) {
    var tile = _autoFireUnitTile(sam);
    if (tile == null) return null;
    var coords;
    {
      coords = { x: game.x(tile), y: game.y(tile) };
    }
    var owner = _safeOwner(sam, game);
    var isBuilding = Boolean(sam.isUnderConstruction?.());
    return {
      sam, tile, coords, ownerName: _playerLabel(owner, me),
      ownerColor: _playerColor(owner, game),
      level: typeof sam.level === "function" ? sam.level() : 1, isBuilding,
      posLabel: "@" + coords.x + "," + coords.y,
      timeLabel: _samConstructionTimeLabel(game, sam, currentTick, isBuilding),
    };
  }

  function _samConstructionTimeLabel(game, sam, currentTick, isBuilding) {
    if (!isBuilding) return "";
    var ticks = _autoFireConstructionDuration(game.unitInfo?.("SAM Launcher")) ?? 300;
    var startTick = sam.state?.constructionStartTick;
    return startTick == null ? "" : (Math.max(0, ticks - (currentTick - startTick)) / 10).toFixed(1) + "s";
  }

  function _handleSamNukeClick(event, item) {
    event.stopPropagation();
    if (item.tile == null) return;
    if (!_cfg("combatSamOneClickFire", false)) {
      _openSamAtomDialog(item.tile);
      return;
    }
    if (typeof window.__OFH_atomBatch?.fireRecommended !== "function") return;
    window.__OFH_atomBatch.fireRecommended(item.tile).then((result) => {
      if (result?.ok) {
        _toast("🚀 " + _tr("Fired") + " " + result.fired + "/" + result.qty + " " + _tr("atom bomb(s)"), "rgba(0,150,80,0.92)");
      } else _toast(_atomFireFailureMessage(result), "rgba(220,40,40,0.92)");
    });
  }

  function _openSamAtomDialog(tile) {
    {
      if (typeof window.__OFH_atomBatch?.openDialog === "function") {
        window.__OFH_atomBatch.openDialog(tile);
      } else if (typeof sendGamePacket === "function") {
        sendGamePacket({ type: "build_unit", unit: "Atom Bomb", tile });
      }
    }
  }

  function _buildSamTrackerRow(item, game, me) {
    var row = document.createElement("div");
    row.className = "ohss-row";
    var inner = document.createElement("div");
    inner.className = "ohss-row-inner";
    var top = document.createElement("div");
    top.className = "ohss-row-top";
    var name = document.createElement("span");
    name.className = "ohss-row-name";
    name.style.color = item.ownerColor || "#e2e8f0";
    name.textContent = item.ownerName;
    var status = document.createElement("span");
    status.className = "ohss-row-status " + (item.isBuilding ? "building" : "placed");
    status.textContent = item.isBuilding ? _tr("Building") : _tr("Placed");
    top.append(name, status);
    var meta = document.createElement("div");
    meta.className = "ohss-row-meta";
    var coordinate = document.createElement("span");
    coordinate.textContent = item.posLabel;
    var level = document.createElement("span");
    level.className = "ohss-tag";
    level.textContent = "Lv." + item.level;
    meta.append(coordinate, level);
    if (item.isBuilding && item.timeLabel) {
      var time = document.createElement("span");
      time.className = "ohss-time";
      time.textContent = "⏱" + item.timeLabel;
      meta.appendChild(time);
    }
    inner.append(top, meta);
    row.appendChild(inner);
    var nuke = document.createElement("button");
    nuke.className = "ohss-nuke-btn";
    nuke.textContent = "☢";
    nuke.title = _tr("Atom batch-fire to SAM");
    nuke.onclick = (event) => _handleSamNukeClick(event, item);
    row.appendChild(nuke);
    row.addEventListener("click", () => _centerCameraOnTile(item.coords.x, item.coords.y));
    _renderNukeTrack(row, _scanNukesToTile(game, me, item.tile));
    return row;
  }

  function updateSAMTrackerPanel() {
    var enabled = _cfg("combatSamTracker", false);
    if (!enabled) {
      _removePanel(SAM_PANEL_ID);
      return;
    }
    _ensureStyles();
    var panel = _ensurePanel(SAM_PANEL_ID, "SAM Tracker", "combatSamTracker");
    _syncTrackerQuickButtons(panel);
    var content = panel.querySelector(".ohss-body");
    if (!content) return;

    var ctx;
    { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); }
    if (!ctx || !ctx.game) {
      content.innerHTML = '<div class="ohss-empty">' + _tr("No game state available.") + '</div>';
      return;
    }

    var me = ctx.game.myPlayer ? ctx.game.myPlayer() : null;
    var buildingOnly = _cfg("combatSamBuildingOnly", false);
    var showAll = _cfg("combatSamShowAll", false);
    var filteredSams = _getSAMTrackerUnits(ctx.game).filter(
      (sam) => _samVisibleToTracker(sam, ctx.game, me, showAll, buildingOnly),
    );

    if (filteredSams.length === 0) {
      content.innerHTML = '<div class="ohss-empty">' + _tr("No matching SAMs found.") + '</div>';
      return;
    }

    var currentTick = typeof ctx.game.ticks === "function" ? ctx.game.ticks() : 0;
    var items = filteredSams.map(
      (sam) => _samPanelItem(ctx.game, me, sam, currentTick),
    ).filter(Boolean);

    items.sort(function(a, b) {
      if (a.isBuilding && !b.isBuilding) return -1;
      if (!a.isBuilding && b.isBuilding) return 1;
      return a.coords.x - b.coords.x || a.coords.y - b.coords.y;
    });

    content.innerHTML = "";
    if (items.length === 0) {
      content.innerHTML = '<div class="ohss-empty">' + _tr("No matching SAMs found.") + '</div>';
      return;
    }

    for (const item of items) content.appendChild(_buildSamTrackerRow(item, ctx.game, me));
  }

  // ---- Panel header quick-toggles (One-click Fire / Auto Fire Building) ----
  // Shared by both the SAM Tracker and Silo Tracker panels.

  // Compact header button bound to a Quick Panel boolean setting. Reuses
  // quick-panel.js's _getSetting/_setAndNotify (shared engine scope) so the
  // toggle stays in sync with the Quick Panel's own switches and persists
  // the same way (storage + lobby sync).
  function _makeTrackerQuickBtn(key, icon, label) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ohss-quick-btn";
    btn.setAttribute("data-qp-key", key);
    btn.textContent = icon;
    btn.title = label;
    btn.classList.toggle("on", Boolean(_cfg(key, false)));
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var cur = Boolean(_cfg(key, false));
      if (typeof _setAndNotify === "function") _setAndNotify(key, !cur);
      btn.classList.toggle("on", !cur);
      {
        var qpPanel = document.getElementById("openfront-helper-quick-panel");
        if (qpPanel && qpPanel.dataset.visible === "true" && typeof _renderActiveTab === "function") {
          _renderActiveTab();
        }
      }
    });
    return btn;
  }

  // Called each tick from updateSiloPanel/updateSAMTrackerPanel so the buttons
  // reflect changes made elsewhere (e.g. the Quick Panel's own toggle switches).
  function _syncTrackerQuickButtons(panel) {
    var btns = panel.querySelectorAll(".ohss-quick-btn[data-qp-key]");
    for (let i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute("data-qp-key");
      btns[i].classList.toggle("on", Boolean(_cfg(key, false)));
    }
  }

  // ---- Panel management ----

  // Default positions: bottom row, right-aligned.
  // Layout (right to left): [Auto-bot 244px] [gap 8] [Silo 250px] [gap 8] [SAM 250px]
  // Auto-bot is at right:16px in CSS.
  function _getDefaultPos(id) {
    var w = window.innerWidth || 1920;
    var h = window.innerHeight || 1080;
    if (id === SILO_PANEL_ID) {
      // Immediately LEFT of auto-bot: right edge = 16 + 244 + 8 = 268
      return { left: w - 268 - 250, top: h - 16 - 380 };
    }
    if (id === SAM_PANEL_ID) {
      // Immediately LEFT of silo
      return { left: w - 268 - 250 - 8 - 250, top: h - 16 - 380 };
    }
    return { left: 300, top: 120 };
  }

  function _showExistingPanel(panel, id) {
    panel.dataset.visible = "true";
    panel.style.setProperty("display", "flex", "important");
    if (typeof applyStoredGoldStatPanelPosition === "function") {
      applyStoredGoldStatPanelPosition(panel, id + "-pos");
    }
    return panel;
  }

  function _positionNewPanel(panel, id) {
    var autoBot = document.getElementById("openfront-helper-autobot-panel");
    var autoTop = autoBot ? autoBot.getBoundingClientRect().top + 16 : 500;
    if (id !== SILO_PANEL_ID && id !== SAM_PANEL_ID) return;
    panel.style.left = id === SILO_PANEL_ID ? "268px" : "526px";
    panel.style.top = autoTop + "px";
    panel.style.bottom = "auto";
  }

  function _syncClosedTrackerSetting(settingKey) {
    if (!settingKey) return;
    {
      if (typeof _quickPanelSettingsCache === "object" && _quickPanelSettingsCache) {
        _quickPanelSettingsCache[settingKey] = false;
      }
    }{
      window.dispatchEvent(new CustomEvent("ofh-quick-panel-setting", {
        detail: { key: settingKey, value: false },
      }));
    }
  }

  function _refreshQuickPanelAfterTrackerClose() {
    {
      var panel = document.getElementById("openfront-helper-quick-panel");
      if (panel?.dataset.visible === "true" && typeof _renderActiveTab === "function") _renderActiveTab();
    }
  }

  function _trackerPanelHeader(panel, id, title, settingKey) {
    var header = document.createElement("div");
    header.className = "ohss-header";
    var titleEl = document.createElement("div");
    titleEl.className = "ohss-title";
    titleEl.textContent = "⚙ " + title;
    var minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "ohss-min-btn";
    minBtn.textContent = "▾";
    minBtn.title = "Minimize / Restore";
    minBtn.addEventListener("click", function() {
      var isMin = panel.dataset.minimized === "true";
      panel.dataset.minimized = isMin ? "false" : "true";
      minBtn.textContent = isMin ? "▾" : "▴";
    });
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ohss-x";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function() {
      panel.dataset.visible = "false";
      if (settingKey) {
        _syncClosedTrackerSetting(settingKey);
        _removePanel(id);
        _refreshQuickPanelAfterTrackerClose();
      }
    });
    header.appendChild(titleEl);
    if (id === SAM_PANEL_ID) {
      header.appendChild(_makeTrackerQuickBtn("combatSamOneClickFire", "⚡", _tr("One-click Fire")));
      header.appendChild(_makeTrackerQuickBtn("combatSamAutoFireBuilding", "🎯", _tr("Auto Fire Building")));
    } else if (id === SILO_PANEL_ID) {
      header.appendChild(_makeTrackerQuickBtn("combatSiloOneClickFire", "⚡", _tr("One-click Fire")));
      header.appendChild(_makeTrackerQuickBtn("combatSiloAutoFireBuilding", "🎯", _tr("Auto Fire Building")));
    }
    header.appendChild(minBtn);
    header.appendChild(closeBtn);
    return header;
  }

  function _ensurePanel(id, title, settingKey) {
    var panel = document.getElementById(id);
    if (panel) return _showExistingPanel(panel, id);
    runtimeDebugLog("[SiloSAM] creating panel:", id);
    _ensureStyles();
    panel = document.createElement("div");
    panel.id = id;
    panel.dataset.visible = "true";
    panel.style.setProperty("display", "flex", "important");
    panel.dataset.minimized = "false";
    _positionNewPanel(panel, id);
    var hdr = _trackerPanelHeader(panel, id, title, settingKey);

    var body = document.createElement("div");
    body.className = "ohss-body";

    panel.appendChild(hdr);
    panel.appendChild(body);

    (document.body || document.documentElement).appendChild(panel);

    // Debug: log final position
    const rect = panel.getBoundingClientRect();
    runtimeDebugLog("[SiloSAM] panel appended:", id, {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      visible: panel.dataset.visible, display: getComputedStyle(panel).display
    });

    if (typeof makeGoldStatPanelDraggable === "function") {
      makeGoldStatPanelDraggable(panel, hdr, id + "-pos");
      // NOTE: do NOT apply stored position here — default position is set above.
      // Stored position is applied only when re-opening an existing panel (top of function).
    }

    _applyStoredPanelSize(panel, id);
    if (window.ResizeObserver) {
      new ResizeObserver(function() { _savePanelSize(panel, id); }).observe(panel);
    }

    return panel;
  }

  function _removePanel(id) {
    var panel = document.getElementById(id);
    if (panel) {
      panel.dataset.visible = "false";
      panel.style.setProperty("display", "none", "important");
      runtimeDebugLog("[SiloSAM] _removePanel:", id, "display:", panel.style.display);
    } else {
      runtimeDebugLog("[SiloSAM] _removePanel: not found", id);
    }
  }

  function _applyStoredPanelSize(panel, id) {
    {
      var s = JSON.parse(window.localStorage.getItem(id + "-size") || "null");
      if (s && Number.isFinite(s.h)) { panel.style.height = s.h + "px"; return; }
    }
    // No stored size yet — same default height the old max-height:380px gave,
    // but as a real height (not a cap) so the resize handle can go taller too.
    panel.style.height = "380px";
  }
  function _savePanelSize(panel, id) {
    var h = parseInt(panel.style.height, 10);
    if (!Number.isFinite(h)) return;
    {
      window.localStorage.setItem(id + "-size", JSON.stringify({ h: h }));
    }
  }

  // ---- New silo placement detection (audio alert) ----

  function _siloId(silo) {
    return typeof silo?.id === "function" ? silo.id() : null;
  }

  function _rememberExistingSilos(game) {
    _knownSiloIds = {};
    for (const silo of _getAllSilos(game)) {
      var id = _siloId(silo);
      if (id !== null) _knownSiloIds[id] = true;
    }
  }

  function _isNewHostileBuildingSilo(silo, me, game) {
    var id = _siloId(silo);
    if (id === null || _knownSiloIds[id]) return false;
    _knownSiloIds[id] = true;
    var isBuilding = typeof silo.isUnderConstruction === "function" ? silo.isUnderConstruction() : true;
    return isBuilding && !_isAlly(silo, me, game);
  }

  function _playSiloAlertIfReady(foundNew, audioEnabled) {
    if (!foundNew || !audioEnabled) return;
    var now = Date.now();
    if (now - _lastAudioAlertMs <= 5000) return;
    _lastAudioAlertMs = now;
    _playPing();
  }

  function checkSiloPlacements(state) {
    if (!state?.game) return;
    var game = state.game;

    if (game !== _lastGameObj) {
      _lastGameObj = game;
      _rememberExistingSilos(game);
      return;
    }

    var audioEnabled = _cfg("combatSiloAudioAlert", false);
    var me = game.myPlayer?.();
    var foundNew = false;
    for (const silo of _getAllSilos(game)) {
      if (_isNewHostileBuildingSilo(silo, me, game)) foundNew = true;
    }
    _playSiloAlertIfReady(foundNew, audioEnabled);
  }

  function _playPing() {
    {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    }
  }

  // ---- Camera jump (ported from Blon centerCameraOnTile) ----

  function _cameraCallbackMatches(callback) {
    if (typeof callback !== "function") return false;
    var source = callback.toString();
    return source.includes("onGoToPosition") || source.includes("GoToPositionEvent");
  }

  function _cameraEventMatches(ctor, callbacks) {
    if (!ctor) return false;
    if (ctor.name === "GoToPositionEvent") return true;
    return Array.isArray(callbacks) && callbacks.some(_cameraCallbackMatches);
  }

  function _emitCameraEvent(bus, ctor, x, y) {
    {
      bus.emit(new ctor(x, y));
    }
  }

  function _centerCameraOnTile(x, y) {
    {
      var overlay = document.querySelector("player-info-overlay");
      if (!overlay?.eventBus) return;
      var bus = overlay.eventBus;
      if (typeof bus.listeners?.entries !== "function") return;
      for (const [ctor, callbacks] of bus.listeners.entries()) {
        if (!_cameraEventMatches(ctor, callbacks)) continue;
        _emitCameraEvent(bus, ctor, x, y);
        return;
      }
    }
  }

  // ---- Global tick entry point (called from bootstrap game loop) ----

  window.__OFH_updateSiloSamTracker = function() {
    {
      var siloPanel = _cfg("combatSiloPanel", false);
      var samTracker = _cfg("combatSamTracker", false);
      runtimeDebugLog("[SiloSAM] tick:", { siloPanel: siloPanel, samTracker: samTracker, cache: Boolean(_quickPanelSettingsCache) });
      if (!siloPanel && !samTracker) return;

      var ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null);
      if (!ctx || !ctx.game) {
        runtimeDebugLog("[SiloSAM] no game context", { siloPanel: siloPanel, samTracker: samTracker });
        return;
      }

      if (siloPanel) {
        updateSiloNotification();
        updateSiloPanel();
        checkSiloPlacements(ctx);
        _runSiloAutoFireBuilding(ctx);
      }
      if (samTracker) {
        updateSAMTrackerPanel();
        _runSamAutoFireBuilding(ctx);
      }
    }
  };
