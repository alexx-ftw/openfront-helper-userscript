// Quick Panel — a compact tabbed floating control panel (slate-glass style) for
// fast settings toggles and WS-injected actions. Mirrors the Helpers popup sections
// plus adds Combat/Theme/Config tabs from Project Blon.
//
// Style is consistent with the existing in-game panel system (advisor-panel.js,
// gold-per-minute.js). Uses the shared makeGoldStatPanelDraggable pattern for drag.
// Fully themeable via CSS custom properties on :root.
//
// Constants (QUICK_PANEL_ID, QUICK_PANEL_STYLE_ID, QUICK_PANEL_POS_KEY,
// quickPanelEnabled) are defined in runtime.js (loaded first).

  var quickPanelActiveTab = "actions";
  var _quickPanelSettingsCache = null;
  var _langDropdownCloseBound = false;

  // Popover — uses unique class (.qp-feat-tip) to avoid being removed by
  // auto-bot panel's rebuild cycle (which cleans up .ab-feat-tip elements).
  var _qpPopoverEl = null;
  var _qpPopoverTimer = null;
  var _QP_POPOVER_DELAY = 100; // ms before popover appears
  function _showQpPopover(el, html, delay) {
    if (delay === undefined) delay = _QP_POPOVER_DELAY;
    _hideQpPopover(); // cancel any pending timer
    var timer = setTimeout(function() {
      // Guard: if the element was removed from DOM (e.g. by auto-bot cleanup),
      // recreate it.
      if (_qpPopoverEl && !_qpPopoverEl.parentNode) {
        _qpPopoverEl = null;
      }
      if (!_qpPopoverEl) {
        _qpPopoverEl = document.createElement("div");
        _qpPopoverEl.className = "qp-feat-tip";
        document.body.appendChild(_qpPopoverEl);
      }
      _qpPopoverEl.innerHTML = html;
      var r = el.getBoundingClientRect();
      _qpPopoverEl.style.left = (r.left + r.width / 2) + "px";
      _qpPopoverEl.style.top = (r.top - 6) + "px";
      _qpPopoverEl.classList.add("show");
    }, delay);
    _qpPopoverTimer = timer;
  }
  function _hideQpPopover() {
    if (_qpPopoverTimer) { clearTimeout(_qpPopoverTimer); _qpPopoverTimer = null; }
    if (_qpPopoverEl) _qpPopoverEl.classList.remove("show");
  }

  // Feature tips — [label, detailed description] for hover tooltips.
  // Descriptions based on actual code implementation.
  var QP_FEATURE_TIPS = {
    // === Actions Tab - Section Headers ===
    "Kill Shot": ["Kill Shot", "One-click attack on the tile under your cursor. Auto-calculates the exact troop amount needed (110% of enemy) to guarantee a kill. If tile is empty, sends 10% to conquer."],
    "Embargo": ["Embargo", "Block or allow trade with all non-allied human players. 'Embargo All' stops exports to enemies; 'Trade All' lifts all embargoes."],
    "Silo Tracker": ["Silo Tracker", "Scans all Missile Silos on the map and lists hostile silos with owner, coordinates, level, and build status. Plays audio ping when new enemy silo detected."],
    "SAM Tracker": ["SAM Tracker", "Scans all SAM Launchers and lists hostile SAMs. Each row has a nuke button to fire at that SAM's location. Helps identify SAM coverage gaps."],
    "Auto Donate Troops": ["Auto Donate Troops", "Automatically donate troops to the neediest teammate in combat. Runs every 3s when your troops exceed the keep threshold. Finds ally with lowest troop percentage."],
    "Auto Donate Gold": ["Auto Donate Gold", "Automatically donate gold to the poorest ally when your gold exceeds the threshold. Runs every 3s. Finds ally with lowest gold amount (can donate to allies, not just teammates)."],
    "Atom batch-fire": ["Atom Batch-fire", "Fire a sequence of nukes at a target. Configure atoms-per-burst and delay between shots. Can overwhelm SAM defenses with decoy nukes."],

    // === Actions Tab - Toggle Keys ===
    killShotInstantSend: ["Instant Send", "Bypass the attack ratio slider and fire troops immediately when the kill shot hotkey is pressed. No confirmation dialog — sends 110% of enemy troops directly."],
    combatSiloPanel: ["Silo Tracker Panel", "Show/hide the floating silo tracker panel listing all hostile Missile Silos."],
    combatSiloShowAll: ["Show All Silos", "Show silos from all players including allies and teammates (spectator mode)."],
    combatSiloBuildingOnly: ["Building Only", "Only show silos that are currently under construction, not placed ones."],
    combatSiloAudioAlert: ["Audio Ping", "Play a sound when a new enemy silo is first detected being placed."],
    combatSiloOneClickFire: ["One-click Fire", "When enabled, the nuke button fires the recommended atom salvo immediately instead of opening the batch-fire dialog. Shows a toast with the reason when firing isn't possible right now."],
    combatSiloAutoFireBuilding: ["Auto Fire Building", "Automatically nukes enemy Missile Silos that are still under construction, denying them before they ever fire a nuke. The impact is moved onto a nearby enemy building cluster when that still hits the Silo, and no salvo is fired when another missile's blast already covers it. A Silo can't intercept, so — unlike the SAM version — it fires as soon as it's affordable/achievable (same check as one-click fire), with no race against construction time. Capped by \"Max nuke auto fire\"."],
    combatSamTracker: ["SAM Tracker Panel", "Show/hide the floating SAM tracker panel listing all hostile SAM Launchers."],
    combatSamShowAll: ["Show All SAMs", "Show SAMs from all players including allies and teammates (spectator mode)."],
    combatSamBuildingOnly: ["Building Only SAMs", "Only show SAMs that are currently under construction, not placed ones."],
    combatSamOneClickFire: ["One-click Fire", "When enabled, the nuke button fires the recommended atom salvo immediately instead of opening the batch-fire dialog. Shows a toast with the reason when firing isn't possible right now."],
    combatSamAutoFireBuilding: ["Auto Fire Building", "Automatically nukes enemy SAM Launchers that are still under construction, undefended, and not covered by another SAM's range — only when a shot is guaranteed to land before construction finishes. The impact is moved onto a nearby enemy building cluster when that still hits the SAM, and no salvo is fired when another missile's blast already covers it. Capped by \"Max nuke auto fire\"."],
    autoDonateEnabled: ["Enable Troop Donation", "Automatically donate troops to specifically named players (from the recipient list) who are in combat, picking the one with lowest troop percentage."],
    autoDonateGoldEnabled: ["Enable Gold Donation", "Automatically donate gold to specifically named players (from the recipient list) when your gold exceeds threshold, picking the poorest."],
    lastHydrogen: ["Final Shot → Hydrogen", "Convert the last nuke in a batch to a Hydrogen Bomb for maximum damage."],

    // === Helpers Tab - Section Keys ===
    panels: ["Panels", "Toggle floating panels: stats, trade, advisor, boat, estate, alliance, script users, auto-bot, auto-join."],
    map: ["Map Overlays", "Toggle visual overlays on the map: troop bars, money, threats, nuke prediction, heatmaps, spawn markers."],
    combat: ["Combat & Automation", "Toggle combat features: retaliation HUD, nuke suggestions, SOS defense, attack hotkey, right-click conquest, enemy intent."],
    alerts: ["Alerts", "Toggle alert notifications: game-time alert, incoming boat warning."],
    tools: ["Tools", "Toggle utility tools: hide ads, round logger, network logger, mark bot nations red."],
    companion: ["Companion", "Toggle the Companion Bot: a slave tab that serves a named \"boss\" account via emoji commands (donate, ally, spawn nearby, follow-attack)."],

    // === Helpers Tab - Toggle Keys (Panels) ===
    showTopGoldPerMinute: ["Player Stats Panel", "Sortable table of all players — rank, name, owned tiles, gold, gold/min, and max troops. Click the + button to also show per-player structure counts (City, Port, Factory, Defense Post, SAM Launcher, Missile Silo). Click a column header to sort; hovering a player's row on the map pins it at the bottom. Draggable."],
    showGoldPerMinute: ["Highlight Hovered Player", "Shows a gold-per-minute badge for the player currently under your cursor. Also highlights the hovered player's row in the Player Stats panel with a pinned footer."],
    showTeamBuildStats: ["Team Build Stats", "Lists each team's structure counts (City, Port, Factory, SAM, Silo) with economy stats. Alerts when enemy builds first Missile Silo."],
    showTradeBalances: ["Trade Balances", "Shows trade data when hovering a player: imports, exports, ROI, break-even time, and top 5 trade partners."],
    showAdvisorPanel: ["Advisor Panel", "Strategic summary: economy state, troops vs max, growth efficiency, safe-to-spend, and top 6 enemy threats ranked by danger."],
    showBoatPanel: ["Boat Panel", "Lists all transport boats (sent and incoming) with live ETA. Click to pan camera; hover to highlight route on map."],
    showEstatePanel: ["Estates Panel", "Lists each separate connected parcel of land you own with tile count. Click to pan camera to that parcel."],
    showAllianceRequestsPanel: ["Alliance Requests", "Shows pending alliance requests with accept/reject buttons and countdown timers. Includes auto-renew toggle for expiring alliances."],
    showHelperUsers: ["Script Users", "Detects other players running the same script via emoji broadcast handshake. Shows detected users with name, color, and relation."],
    showAutoBotPanel: ["Auto-Bot Panel", "Floating control panel with master on/off, auto-toggles (spawn, expand, nuke, etc.), config, and action log."],
    showFloatingAutoJoinPanel: ["Auto-Join Panel", "On-page auto-join toggle with game-found notifications and lobby forecast display."],

    // === Helpers Tab - Toggle Keys (Map Overlays) ===
    showPlayerMapOverlays: ["Player Overlays (Master)", "Master toggle for all player name overlays. Individual sub-overlays only render when this is enabled."],
    showMapTroopCounts: ["Troop Bar", "Horizontal bar above each player's name showing troops/max ratio. Green = home troops, orange = troops in combat."],
    showMapMoney: ["Money Overlay", "Gold pill above each player's name showing current gold ($K/$M format). Combines with troop bar when both enabled."],
    showThreatIndicators: ["Threat Indicators", "Colored marks near enemies: nuke icon if nuke-capable, red dot if stronger (>=1.35x), amber dot if weak (<=10% max)."],
    markHoveredAlliesGreen: ["Ally Markers", "When hovering a nation, allied players get a green highlight to distinguish them from enemies on the map."],
    showAttackHighlight: ["Attack Highlight", "Pulsing red rings around attackers with dashed lines to your territory. Shows total incoming troop count. Skips teammates."],
    showNukePrediction: ["Nuke Prediction", "Landing zone markers for in-flight nukes with crosshairs, nuke type, count, and time-to-impact ETA. Colored by relation."],
    showNukeTrajectory: ["Trajectory Line", "Dashed parabolic flight path from each nuke to its landing tile. Uses exact game physics for accurate arc rendering."],
    showBoatPrediction: ["Boat Prediction", "Landing markers for incoming transport ships with owner name and ETA. Click to pan camera to the boat."],
    alwaysShowOwnBoatRoutes: ["Own Boat Routes", "Draws your own boat routes without hovering."],
    alwaysShowTeamBoatRoutes: ["Team Boat Routes", "Draws teammates' boat routes without hovering."],
    alwaysShowAllyBoatRoutes: ["Ally Boat Routes", "Draws allies' (alliance) boat routes without hovering."],
    alwaysShowEnemyBoatRoutes: ["Enemy Boat Routes", "Draws enemy boat routes without hovering."],
    showWarshipRoutes: ["Warship Routes", "Draws warship destinations & routes (blue = you, teal = team, green = allies, red = enemies)."],
    showWarshipRoutesOwn: ["Own Warships", "Show routes for your own warships."],
    showWarshipRoutesTeam: ["Team Warships", "Show routes for teammates' warships."],
    showWarshipRoutesAlly: ["Ally Warships", "Show routes for allies' (alliance) warships."],
    showWarshipRoutesEnemy: ["Enemy Warships", "Show routes for enemy warships."],
    showEconomyHeatmap: ["Economy Heatmap", "Radial gradient heatmap of economic activity. Intensity based on gold revenue from City, Port, and Factory structures."],
    showExportPartnerHeatmap: ["Export Partner Heatmap", "Shows where your trade exports originate from when hovering a player. Teal-yellow-blue gradient. Mutually exclusive with economy heatmap."],
    showSpawnHeatmap: ["Spawn Heatmap", "Full-screen heatmap scoring every grid cell by spawn quality. Considers land density, player proximity, and spawn intents."],
    showSpawnMarkers: ["Spawn Markers", "Colored markers on the map at each player's chosen spawn location during the spawn phase."],
    showBuildTimers: ["Build Timers", "Construction countdown timers above Missile Silos and SAM Launchers. Shows remaining build time and missile cooldown."],

    // === Helpers Tab - Toggle Keys (Combat & Automation) ===
    showRetaliationHud: ["Retaliation HUD", "Center-screen alert when enemy nuke targets your territory. Shows attacker name with 'Focus' button to pan camera to launch source."],
    showNukeSuggestions: ["Nuke Suggestions", "Hover-target nuke strike suggestions for optimal targets. Includes economic nuke suggestions and SAM burn logic."],
    autoNuke: ["Auto Nuke", "Automatically fires nukes at suggested targets."],
    autoNukeIncludeAllies: ["Include Allies", "Allow auto nuke to target allies."],
    sosDefense: ["SOS Defense", "Auto-sends distress emoji (🆘) to allies/teammates when under attack and marks attackers in allied HUDs. SOS emoji rate-limited to 12s; attacker targeting every 16s."],
    attackRatioHotkey: ["Attack Ratio Hotkey", "Shift+1 through Shift+0 to set attack ratio slider to 10%-100%. Finds the slider in shadow DOM and updates it."],
    rightClickConquest: ["Right-click Conquest", "Right-click context menu near enemy shows capture assessment (easy/moderate/risky), one-click attack, and alliance policy buttons."],
    showEnemyIntent: ["Enemy Intent Warning", "Polls incomingAttacks() to maintain 15-second TTL warnings for enemy attacks. Shared data layer consumed by attack-highlight overlay and advisor panel. Does NOT detect boats."],

    // === Helpers Tab - Toggle Keys (Alerts) ===
    showGameTimeAlert: ["Game-time Alert", "One-shot center-screen notice when match reaches configurable time (default 5 minutes). Blue info-toned design."],
    warnIncomingBoats: ["Incoming Boat Warning", "Alert when new enemy transport detected heading for your territory. Shows attacker name with 'Focus' button. Auto-dismisses after 9s."],

    // === Helpers Tab - Toggle Keys (Tools) ===
    hideAds: ["Hide Ads", "Injects a style tag to hide game ad containers (Google Ads, iframes, ad wrappers) using multiple CSS techniques: display:none, visibility:hidden, zero-sizing, and pointer-events:none."],
    antiAfk: ["Anti-AFK", "Prevents AFK detection when tab is in background. Uses Web Worker to send periodic WebSocket pings."],
    roundLogger: ["Round Logger", "Records complete per-match traffic, bot decisions, actions, metadata, and failures in memory, then exports one JSONL file per match. Match data is never stored in localStorage."],
    networkLogger: ["Network Logger", "Hooks XMLHttpRequest to record network metadata (URL, method, status, timing). Max 500 entries. Does NOT capture response bodies."],
    markBotNationsRed: ["Mark Bot Nations Red", "Draws red glowing dots on the map above AI-controlled nations to distinguish them from human players."],

    // === Helpers Tab - Toggle Keys (Companion) ===
    showCompanionPanel: ["Companion Panel", "Floating panel for a slave tab: set the boss account name, watch its emoji command queue and action log."],
    companionEnabled: ["Companion Mode", "When active, this tab automatically executes the boss's commands (donate gold/troops, alliance requests, spawn near boss, follow-attack) with an always-on warning banner."],

    // === Config Tab - Section Headers ===
    "Theme": ["Theme Settings", "Customize panel colors with presets (green, blue, red, etc.) or custom hex/HSL. Adjusts accent color, opacity, and rainbow mode."],
    "Language": ["Language", "Change the script's display language. Supports multiple languages via i18n system. Triggers full panel re-render."],
    "Skin Unlocker (all skins)": ["Skin Unlocker", "Unlocks all available skins. May require page reload. Can cause slight lag in-game on weaker devices."],
    "Low lag mode": ["Low Lag Mode", "Throttles overlays to ~20fps for weaker devices. Reduces scan frequencies and disables non-essential animations."],
    "Reset all settings": ["Reset All Settings", "Resets all settings to defaults. Reloads the page to apply changes."],

    // === Config Tab - Toggle Keys ===
    rainbowMode: ["Rainbow Mode", "Cycles through all accent colors automatically for a rainbow effect on all panels and overlays."],
    skinUnlocker: ["Skin Unlocker", "Unlocks all available skins. May require page reload. Can cause slight lag in-game on weaker devices."],
    lowLagMode: ["Low Lag Mode", "Throttles overlays to ~20fps for weaker devices. Reduces scan frequencies and disables non-essential animations."],
  };

  // ---- Theme engine ----

  var _themePresets = {
    green:  "#00ff66",
    blue:   "#2962ff",
    red:    "#ff3333",
    yellow: "#ffcc00",
    purple: "#cc44ff",
    cyan:   "#44ddff",
    orange: "#ff6600",
    gray:   "#aaaaaa",
  };

  function _hexToRgb(hex) {
    var s = String(hex || "").trim();
    // Handle HSL: hsl(h,s%,l%)
    var hsl = s.match(/^hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)$/i);
    if (hsl) {
      var h = Number(hsl[1]) / 360;
      var sl = Number(hsl[2]) / 100;
      var l = Number(hsl[3]) / 100;
      var r, g, b;
      if (sl === 0) { r = g = b = l; } else {
        var q = l < 0.5 ? l * (1 + sl) : l + sl - l * sl;
        var p = 2 * l - q;
        r = _hue2rgb(p, q, h + 1/3);
        g = _hue2rgb(p, q, h);
        b = _hue2rgb(p, q, h - 1/3);
      }
      return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    }
    // Handle hex
    var c = s.replace(/^#/, "");
    if (!/^[0-9a-f]{3,6}$/i.test(c)) return null;
    if (c.length === 3) c = c.split("").map(function(ch){return ch+ch;}).join("");
    return {
      r: parseInt(c.substring(0,2), 16),
      g: parseInt(c.substring(2,4), 16),
      b: parseInt(c.substring(4,6), 16),
    };
  }

  function _hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }

  function _applyTheme(accentHex) {
    var rgb = _hexToRgb(accentHex);
    if (!rgb) return;
    var root = document.documentElement;
    root.style.setProperty("--oh-accent", accentHex);
    root.style.setProperty("--oh-accent-r", rgb.r);
    root.style.setProperty("--oh-accent-g", rgb.g);
    root.style.setProperty("--oh-accent-b", rgb.b);
    // Derive a muted accent for switch backgrounds
    root.style.setProperty("--oh-accent-muted", "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",0.6)");
    root.style.setProperty("--oh-accent-soft", "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",0.15)");
    _ensureThemeOverrides();
  }

  function _ensureThemeOverrides() {
    var id = "openfront-helper-theme-overrides";
    if (document.getElementById(id)) return;
    var s = document.createElement("style");
    s.id = id;
    // Override key colors on all floating panels using CSS vars. The !important
    // is needed because panel-specific styles use IDs (high specificity).
    s.textContent = [
      // All floating panels, badges, containers, stats, dialogs, menus + popup.
      '[id^="openfront-helper-"][id$="-panel"],',
      '[id^="openfront-helper-"][id$="-badge"],',
      '[id^="openfront-helper-"][id$="-container"],',
      '[id^="openfront-helper-"][id$="-stats"],',
      '[id^="openfront-helper-"][id$="-menu"],',
      '[id^="openfront-helper-"][id$="-dialog"],',
      '[id="openfront-helper-popup"] {',
      "  border-color: var(--oh-panel-border, rgba(148,163,184,0.34)) !important;",
      "  background: var(--oh-panel-bg, rgba(12,18,20,0.92)) !important;",
      "}",
      // Popup switch/accent elements — use blue slate fallbacks.
      '[id="openfront-helper-popup"] .ofh-switch.on {',
      "  background: var(--oh-accent-muted, rgba(96,165,250,0.6)) !important;",
      "}",
      '[id="openfront-helper-popup"] .ofh-tab.active {',
      "  color: var(--oh-panel-text, #e2e8f0) !important;",
      "  background: var(--oh-accent-soft, rgba(96,165,250,0.14)) !important;",
      "  border-color: var(--oh-accent-muted, rgba(96,165,250,0.28)) !important;",
      "}",
      '[id="openfront-helper-popup"] .ofh-btn {',
      "  border-color: var(--oh-accent-muted, rgba(96,165,250,0.3)) !important;",
      "  background: var(--oh-accent-soft, rgba(96,165,250,0.16)) !important;",
      "}",
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  function _themeFromSettings() {
    var accent = _getSetting("guiAccentColor", "#00ff66") || "#00ff66";
    var opacity = Number(_getSetting("guiOpacity", 1) || 1);
    var ovOpacity = Number(_getSetting("overlayOpacity", 1) || 1);
    var root = document.documentElement;
    _applyTheme(accent);
    root.style.setProperty("--oh-panel-opacity", String(opacity));
    root.style.setProperty("--oh-overlay-opacity", String(ovOpacity));
    root.style.setProperty("--oh-panel-bg", "rgba(12,18,20," + (0.92 * opacity).toFixed(2) + ")");
    root.style.setProperty("--oh-panel-border", "rgba(148,163,184," + (0.34 * opacity).toFixed(2) + ")");
    root.style.setProperty("--oh-panel-text", "rgba(226,232,240," + String(opacity) + ")");
    root.style.setProperty("--oh-panel-text-dim", "rgba(148,163,184," + (0.85 * opacity).toFixed(2) + ")");
    root.style.setProperty("--oh-panel-header-border", "rgba(148,163,184," + (0.18 * opacity).toFixed(2) + ")");
    _applyThemeToAllPanels();
  }

  // Apply the current theme to every openfront-helper DOM element via inline
  // !important styles. This is the most reliable way to override hardcoded panel
  // colors regardless of specificity, loading order, or CSS architecture.
  var _lastPanelTheme = "";
  var _panelThemeTimer = null;
  function _applyThemeToAllPanels() {
    var bg = "var(--oh-panel-bg, rgba(12,18,20,0.92))";
    var border = "var(--oh-panel-border, rgba(148,163,184,0.34))";
    var els = document.querySelectorAll('[id^="openfront-helper-"]');
    for (let i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.tagName === "STYLE" || el.tagName === "CANVAS" || el.tagName === "SVG") continue;
      if (el.id.indexOf("-layer") !== -1 || el.id.indexOf("-styles") !== -1) continue;
      // Transparent, pointer-events:none full-viewport overlays (aiming rings,
      // range previews) are not themed panels — forcing an opaque panel
      // background onto a position:fixed;inset:0 element blankets the whole
      // screen. Excluded by id, same as -layer/-styles above.
      if (el.id.indexOf("-range") !== -1) continue;
      el.style.setProperty("background", bg, "important");
      el.style.setProperty("border-color", border, "important");
    }
    // Keep running periodically to catch newly created panels (lazy init).
    if (!_panelThemeTimer) {
      _panelThemeTimer = setInterval(function() {
        _applyThemeToAllPanels();
      }, 2000);
    }
  }

  // ---- Styles (CSS-var-driven, slate-glass base) ----

  const QUICK_PANEL_CSS = [
      "#" + QUICK_PANEL_ID + " {",
      "  position:fixed; z-index:8000;",
      "  width:270px; max-height:520px; display:none;",
      "  border:1px solid var(--oh-panel-border); border-radius:8px;",
      "  background:var(--oh-panel-bg); color:var(--oh-panel-text);",
      "  font:700 11px/1.15 'Aptos','Trebuchet MS','Segoe UI',sans-serif;",
      "  box-shadow:0 10px 26px rgba(0,0,0,0.4),0 0 16px var(--oh-accent-soft);",
      "  pointer-events:auto; user-select:none; overflow:hidden; flex-direction:column;",
      "}",
      "#" + QUICK_PANEL_ID + "[data-visible='true'] { display:flex; }",
      "#" + QUICK_PANEL_ID + "[data-minimized='true'] .ohqp-tabs,",
      "#" + QUICK_PANEL_ID + "[data-minimized='true'] .ohqp-body { display:none; }",
      ".ohqp-header {",
      "  display:flex; align-items:center; gap:6px; padding:6px 8px;",
      "  border-bottom:1px solid var(--oh-panel-header-border); cursor:grab;",
      "  touch-action:none; flex-shrink:0;",
      "}",
      ".ohqp-header:active { cursor:grabbing; }",
      ".ohqp-title {",
      "  flex:1; font-size:10px; font-weight:900; text-transform:uppercase;",
      "  letter-spacing:0.4px; color:var(--oh-panel-text-dim);",
      "}",
      ".ohqp-conn { font-size:8px; margin-right:2px; }",
      ".ohqp-conn[data-status='connected'] { color:#4ade80; }",
      ".ohqp-conn[data-status='disconnected'] { color:#f87171; }",
      ".ohqp-min-btn {",
      "  display:inline-flex; align-items:center; justify-content:center;",
      "  width:20px; height:20px; border:1px solid var(--oh-panel-border);",
      "  border-radius:6px; background:rgba(15,23,42,0.5); color:var(--oh-panel-text);",
      "  font-size:12px; font-weight:800; cursor:pointer;",
      "}",
      ".ohqp-min-btn:hover { background:var(--oh-accent-soft); }",
      ".ohqp-tabs {",
      "  display:flex; background:rgba(0,0,0,0.25);",
      "  border-bottom:1px solid var(--oh-panel-header-border); flex-shrink:0;",
      "}",
      ".ohqp-tabs button {",
      "  flex:1; padding:5px 0; text-align:center; font-size:12px; cursor:pointer;",
      "  background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.15);",
      "  border-radius:8px; color:var(--oh-panel-text-dim);",
      "  transition:background 0.14s, border-color 0.14s;",
      "}",
      ".ohqp-tabs button:hover { background:rgba(148,163,184,0.15); border-color:var(--oh-accent-muted); }",
      ".ohqp-tabs button.active {",
      "  background:var(--oh-accent-soft); border-color:var(--oh-accent-muted);",
      "  color:var(--oh-panel-text);",
      "}",
      ".ohqp-body {",
      "  flex:1; overflow-y:auto; overflow-x:hidden; padding:8px 10px;",
      "}",
      ".ohqp-body > div { display:none; }",
      ".ohqp-body > div.active { display:block; }",
      ".ohqp-sec { margin-bottom:6px; }",
      ".ohqp-sec-h {",
      "  display:flex; align-items:center; gap:4px; padding:4px 6px;",
      "  background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.15);",
      "  border-radius:8px; cursor:pointer; font-size:10px; font-weight:900;",
      "  text-transform:uppercase; letter-spacing:0.3px; color:var(--oh-panel-text-dim);",
      "  transition:opacity 0.14s, background 0.14s, border-color 0.14s;",
      "}",
      ".ohqp-sec-h:hover { background:rgba(148,163,184,0.15); border-color:var(--oh-accent-muted); }",
      ".ohqp-sec-h.open {",
      "  background:var(--oh-accent-soft); border-color:var(--oh-accent-muted);",
      "}",
      ".ohqp-sec-h .ohqp-chevron { font-size:9px; transition:transform 0.15s; }",
      ".ohqp-sec-h.open .ohqp-chevron { transform:rotate(90deg); }",
      ".ohqp-sec-b { display:none; padding:3px 0 3px 2px; }",
      ".ohqp-sec-b.open { display:block; }",
      ".ohqp-row {",
      "  display:flex; align-items:center; justify-content:space-between;",
      "  padding:2px 4px; gap:8px;",
      "}",
      ".ohqp-row.ohqp-sub { padding-left:16px; }",
      ".ohqp-row.ohqp-sub .ohqp-label { font-size:9px; color:var(--oh-panel-text-dim); }",
      ".ohqp-sw.disabled { opacity:0.35; pointer-events:none; }",
      ".ohqp-row .ohqp-label {",
      "  font-size:10px; color:var(--oh-panel-text); flex:1; overflow:hidden;",
      "  text-overflow:ellipsis; white-space:nowrap;",
      "}",
      ".ohqp-tip-icon {",
      "  display:inline-flex; align-items:center; justify-content:center;",
      "  width:14px; height:14px; border-radius:50%;",
      "  border:1px solid rgba(148,163,184,0.35);",
      "  font-size:9px; font-weight:700; cursor:help;",
      "  color:var(--oh-panel-text-dim); flex-shrink:0; margin-right:4px;",
      "  transition:background 0.14s, border-color 0.14s, color 0.14s;",
      "}",
      ".ohqp-tip-icon:hover {",
      "  background:var(--oh-accent-soft); border-color:var(--oh-accent-muted);",
      "  color:var(--oh-accent);",
      "}",
      ".ohqp-sec-h .ohqp-tip-icon {",
      "  margin-left:auto; margin-right:0;",
      "}",
      ".ohqp-sw {",
      "  width:26px; height:14px; border-radius:7px; flex-shrink:0; cursor:pointer;",
      "  background:rgba(148,163,184,0.25); position:relative;",
      "}",
      ".ohqp-sw.on { background:var(--oh-accent-muted); }",
      ".ohqp-sw::after {",
      "  content:''; position:absolute; width:10px; height:10px; border-radius:50%;",
      "  background:#e2e8f0; top:2px; left:2px; transition:left 0.15s;",
      "}",
      ".ohqp-sw.on::after { left:14px; }",
      ".ohqp-btn {",
      "  padding:4px 8px; background:rgba(15,23,42,0.5);",
      "  border:1px solid var(--oh-panel-border); border-radius:4px;",
      "  color:var(--oh-panel-text); font:700 10px/1.15 'Aptos','Trebuchet MS','Segoe UI',sans-serif;",
      "  cursor:pointer;",
      "}",
      ".ohqp-btn:hover { background:var(--oh-accent-soft); }",
      ".ohqp-btn.danger { border-color:rgba(248,113,113,0.4); color:#fca5a5; }",
      ".ohqp-btn.danger:hover { background:rgba(248,113,113,0.15); }",
      ".ohqp-input {",
      "  width:100%; background:rgba(0,0,0,0.3); border:1px solid var(--oh-panel-border);",
      "  border-radius:3px; color:var(--oh-panel-text); padding:2px 4px;",
      "  font:10px monospace; box-sizing:border-box;",
      "}",
      ".ohqp-select {",
      "  width:100%; background:rgba(0,0,0,0.3); border:1px solid var(--oh-panel-border);",
      "  border-radius:3px; color:var(--oh-panel-text); padding:2px 4px;",
      "  font:10px monospace; box-sizing:border-box;",
      "}",
      ".ohqp-range { flex:1; min-width:40px; height:4px; accent-color:var(--oh-accent); }",
      ".ohqp-presets { display:grid; grid-template-columns:repeat(4,1fr); gap:3px; margin-bottom:8px; }",
      ".ohqp-presets button {",
      "  padding:4px 2px; border-radius:3px; font:700 9px monospace; cursor:pointer;",
      "  border:1px solid var(--oh-panel-border); background:rgba(0,0,0,0.3);",
      "  color:var(--oh-panel-text);",
      "}",
      ".ohqp-divider { margin:6px -10px; border-top:1px solid var(--oh-panel-header-border); }",
      ".ohqp-label-sm { font-size:9px; color:var(--oh-panel-text-dim); margin-bottom:2px; display:block; }",
      ".ohqp-lang-btn {",
      "  width:100%; padding:5px 8px; border-radius:5px; cursor:pointer; text-align:left;",
      "  font:700 10px/1.15 'Aptos','Trebuchet MS','Segoe UI',sans-serif;",
      "  border:1px solid var(--oh-panel-border); background:transparent; color:var(--oh-panel-text);",
      "  transition:all 0.15s; display:flex; justify-content:space-between; align-items:center;",
      "}",
      ".ohqp-lang-btn:hover { border-color:var(--oh-accent-muted); }",
      ".ohqp-lang-wrap { position:relative; }",
      ".ohqp-lang-menu {",
      "  position:absolute; top:100%; left:0; right:0; z-index:10;",
      "  max-height:140px; overflow-y:auto; margin-top:2px;",
      "  border:1px solid var(--oh-panel-border); border-radius:5px;",
      "  background:var(--oh-panel-bg); box-shadow:0 8px 20px rgba(0,0,0,0.5);",
      "}",
      ".ohqp-lang-item {",
      "  padding:5px 8px; cursor:pointer; font-size:10px; color:var(--oh-panel-text-dim);",
      "  transition:background 0.1s;",
      "}",
      ".ohqp-lang-item:hover { background:var(--oh-accent-soft); color:var(--oh-panel-text); }",
      ".ohqp-lang-item.active { background:var(--oh-accent-muted); color:var(--oh-panel-text); font-weight:900; }",
      // Popover tooltip — same style as auto-bot's .ab-feat-tip but with unique
      // class so auto-bot's rebuild cleanup doesn't remove it.
      ".qp-feat-tip {",
      "  position:fixed; z-index:9000;",
      "  transform:translate(-50%,-100%);",
      "  padding:7px 10px; border-radius:8px;",
      "  pointer-events:none;",
      "  background:var(--oh-panel-bg,rgba(12,18,20,0.98));",
      "  border:1px solid var(--oh-accent-muted,rgba(96,165,250,0.35));",
      "  color:var(--oh-panel-text,#e2e8f0);",
      "  font:500 11px/1.4 'Aptos',system-ui,sans-serif;",
      "  white-space:normal; max-width:220px; text-align:center;",
      "  box-shadow:0 8px 22px rgba(0,0,0,0.5);",
      "  opacity:0; transition:opacity 0.12s;",
      "}",
      ".qp-feat-tip b { color:var(--oh-accent,#60a5fa); font-weight:800; }",
      ".qp-feat-tip.show { opacity:1; }",
    ].join("\n");

  function ensureQuickPanelStyles() {
    if (document.getElementById(QUICK_PANEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = QUICK_PANEL_STYLE_ID;
    style.textContent = QUICK_PANEL_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- Settings bridge ----

  // Generic panel animation (scale from Quick Panel center)
  var _panelAnimTimers = {};
  function _animatePanelToggle(panelId, show) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    if (show) {
      // Animate in: scale 0.3 → 1
      panel.dataset.visible = "true";
      panel.style.opacity = "0";
      panel.style.transform = "scale(0.3)";
      // Set origin to Quick Panel center
      const qp = document.getElementById(QUICK_PANEL_ID);
      if (qp) {
        const qr = qp.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        const cx = qr.left + qr.width / 2;
        const cy = qr.top + qr.height / 2;
        panel.style.transformOrigin = (cx - pr.left) + "px " + (cy - pr.top) + "px";
      }
      if (_panelAnimTimers[panelId]) clearTimeout(_panelAnimTimers[panelId]);
      // Small delay to let the panel render dimensions
      setTimeout(function() {
        var anim = panel.animate(
          [{ transform: "scale(0.3)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
          { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
        );
        anim.onfinish = function() {
          { anim.cancel(); }
          panel.style.transform = "";
          panel.style.opacity = "";
        };
      }, 16);
    } else {
      // Animate out: scale 1 → 0.3
      const qp = document.getElementById(QUICK_PANEL_ID);
      if (qp) {
        const qr = qp.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        const cx = qr.left + qr.width / 2;
        const cy = qr.top + qr.height / 2;
        panel.style.transformOrigin = (cx - pr.left) + "px " + (cy - pr.top) + "px";
      }
      var anim = panel.animate(
        [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.3)", opacity: 0 }],
        { duration: 180, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" }
      );
      anim.onfinish = function() {
        panel.dataset.visible = "false";
        { anim.cancel(); }
        panel.style.transform = "";
        panel.style.opacity = "";
      };
    }
  }

  // Panel ID mapping for animation
  var _PANEL_IDS = {
    showAdvisorPanel: "openfront-helper-advisor-panel",
    showGoldPerMinute: "openfront-helper-gold-per-minute-container",
    showTopGoldPerMinute: "openfront-helper-top-gold-per-minute",
    showTeamBuildStats: "openfront-helper-team-build-stats",
    showTradeBalances: "openfront-helper-trade-balances",
    showBoatPanel: "openfront-helper-boat-panel",
    showEstatePanel: "openfront-helper-estate-panel",
    showAllianceRequestsPanel: "openfront-helper-alliance-requests-panel",
    showHelperUsers: "openfront-helper-users-container",
    showAutoBotPanel: "openfront-helper-autobot-panel",
    showFloatingAutoJoinPanel: "openfront-helper-floating-autojoin",
    showRetaliationHud: "openfront-helper-retaliation-container",
    showGameTimeAlert: "openfront-helper-game-time-alert",
  };

  // Rainbow mode — cycle accent hue every 100ms
  var _rainbowTimer = null;
  var _rainbowHue = 0;
  var _savedAccentColor = null;

  function _toggleRainbowMode(on) {
    if (_rainbowTimer) { clearInterval(_rainbowTimer); _rainbowTimer = null; }
    if (on) {
      _savedAccentColor = _getSetting("guiAccentColor", "#00ff66");
      _rainbowHue = Number(_getSetting("guiAccentHue", 150)) || 0;
      _rainbowTimer = setInterval(function() {
        _rainbowHue = (_rainbowHue + 2) % 360;
        var hex = "hsl(" + _rainbowHue + ",100%,55%)";
        _applyTheme(hex);
      }, 80);
    } else {
      // Restore saved color
      if (_savedAccentColor) {
        _applyTheme(_savedAccentColor);
      } else {
        _themeFromSettings();
      }
    }
  }

  function _notifySettingChanged(key, value) {
    {
      window.dispatchEvent(new CustomEvent("ofh-quick-panel-setting", {
        detail: { key: key, value: value }
      }));
    }
  }

  function _getSetting(key, fallback) {
    if (_quickPanelSettingsCache && key in _quickPanelSettingsCache)
      return _quickPanelSettingsCache[key];
    {
      var defs = window.OpenFrontHelperSettings && window.OpenFrontHelperSettings.DEFAULT_SETTINGS;
      if (defs && key in defs) return defs[key];
    }
    return fallback;
  }

  function _setAndNotify(key, value) {
    if (_quickPanelSettingsCache) _quickPanelSettingsCache[key] = value;
    _notifySettingChanged(key, value);
    _applySettingLocally(key, value);
  }

  // Setter resolver: key → setter FUNCTION. Setters are top-level functions in
  // the engine IIFE's SHARED SCOPE — NOT on window (the build wraps each layer
  // in an IIFE). window[fnName] returns undefined for all of them, so we must
  // reference the bare names directly with typeof guards.
  const QUICK_PANEL_SETTER_RESOLVERS = {
    showAdvisorPanel: () => typeof setAdvisorPanelEnabled === "function" ? setAdvisorPanelEnabled : null,
    showGoldPerMinute: () => typeof setGoldPerMinuteEnabled === "function" ? setGoldPerMinuteEnabled : null,
    showTopGoldPerMinute: () => typeof setTopGoldPerMinuteEnabled === "function" ? setTopGoldPerMinuteEnabled : null,
    showTeamBuildStats: () => typeof setTeamBuildStatsEnabled === "function" ? setTeamBuildStatsEnabled : null,
    showTradeBalances: () => typeof setTradeBalancesEnabled === "function" ? setTradeBalancesEnabled : null,
    showBoatPanel: () => typeof setBoatPanelEnabled === "function" ? setBoatPanelEnabled : null,
    showEstatePanel: () => typeof setEstatePanelEnabled === "function" ? setEstatePanelEnabled : null,
    showAllianceRequestsPanel: () => typeof setAllianceRequestsPanelEnabled === "function" ? setAllianceRequestsPanelEnabled : null,
    showHelperUsers: () => typeof setHelperUsersEnabled === "function" ? setHelperUsersEnabled : null,
    markBotNationsRed: () => typeof setBotMarkersEnabled === "function" ? setBotMarkersEnabled : null,
    showCompanionPanel: () => typeof setCompanionPanelVisible === "function" ? setCompanionPanelVisible : null,
    companionEnabled: () => typeof setCompanionEnabled === "function" ? setCompanionEnabled : null,
    markHoveredAlliesGreen: () => typeof setAllyMarkersEnabled === "function" ? setAllyMarkersEnabled : null,
    showNukePrediction: () => typeof setNukePredictionEnabled === "function" ? setNukePredictionEnabled : null,
    showNukeTrajectory: () => typeof setNukeTrajectoryEnabled === "function" ? setNukeTrajectoryEnabled : null,
    showBoatPrediction: () => typeof setBoatPredictionEnabled === "function" ? setBoatPredictionEnabled : null,
    showWarshipRoutes: () => typeof setWarshipRoutesEnabled === "function" ? setWarshipRoutesEnabled : null,
    showNukeSuggestions: () => typeof setNukeSuggestionsEnabled === "function" ? setNukeSuggestionsEnabled : null,
    showEconomyHeatmap: () => typeof setEconomyHeatmapEnabled === "function" ? setEconomyHeatmapEnabled : null,
    showExportPartnerHeatmap: () => typeof setExportPartnerHeatmapEnabled === "function" ? setExportPartnerHeatmapEnabled : null,
    showAttackHighlight: () => typeof setAttackHighlightEnabled === "function" ? setAttackHighlightEnabled : null,
    showRetaliationHud: () => typeof setRetaliationEnabled === "function" ? setRetaliationEnabled : null,
    hideAds: () => typeof setHideAdsEnabled === "function" ? setHideAdsEnabled : null,
    attackRatioHotkey: () => typeof setAttackRatioHotkeyEnabled === "function" ? setAttackRatioHotkeyEnabled : null,
    rightClickConquest: () => typeof setRightClickMenuEnabled === "function" ? setRightClickMenuEnabled : null,
    roundLogger: () => typeof setRoundLoggerEnabled === "function" ? setRoundLoggerEnabled : null,
    networkLogger: () => typeof setNetworkLoggerEnabled === "function" ? setNetworkLoggerEnabled : null,
    showBuildTimers: () => typeof setBuildTimerEnabled === "function" ? setBuildTimerEnabled : null,
    showEnemyIntent: () => typeof setEnemyIntentEnabled === "function" ? setEnemyIntentEnabled : null,
    showSpawnHeatmap: () => typeof setSpawnHeatmapEnabled === "function" ? setSpawnHeatmapEnabled : null,
    showSpawnMarkers: () => typeof setSpawnMarkersEnabled === "function" ? setSpawnMarkersEnabled : null,
    sosDefense: () => typeof setSosDefenseEnabled === "function" ? setSosDefenseEnabled : null,
    showGameTimeAlert: () => typeof setGameTimeAlertEnabled === "function" ? setGameTimeAlertEnabled : null,
    showPlayerMapOverlays: () => typeof setPlayerMapOverlaysEnabled === "function" ? setPlayerMapOverlaysEnabled : null,
    showMapTroopCounts: () => typeof setMapTroopCountsEnabled === "function" ? setMapTroopCountsEnabled : null,
    showThreatIndicators: () => typeof setThreatIndicatorsEnabled === "function" ? setThreatIndicatorsEnabled : null,
    showMapMoney: () => typeof setMapMoneyEnabled === "function" ? setMapMoneyEnabled : null,
    skinUnlocker: () => typeof _setSkinUnlockerEnabled === "function" ? _setSkinUnlockerEnabled : null,
    warnIncomingBoats: () => typeof setBoatIncomingWarningEnabled === "function" ? setBoatIncomingWarningEnabled : null,
  };

  function _resolveSetter(key) {
    /* Legacy switch resolver superseded by the declarative resolver table.
    switch (key) {
      case "showAdvisorPanel":       return typeof setAdvisorPanelEnabled === "function" ? setAdvisorPanelEnabled : null;
      case "showGoldPerMinute":      return typeof setGoldPerMinuteEnabled === "function" ? setGoldPerMinuteEnabled : null;
      case "showTopGoldPerMinute":   return typeof setTopGoldPerMinuteEnabled === "function" ? setTopGoldPerMinuteEnabled : null;
      case "showTeamBuildStats":     return typeof setTeamBuildStatsEnabled === "function" ? setTeamBuildStatsEnabled : null;
      case "showTradeBalances":      return typeof setTradeBalancesEnabled === "function" ? setTradeBalancesEnabled : null;
      case "showBoatPanel":          return typeof setBoatPanelEnabled === "function" ? setBoatPanelEnabled : null;
      case "showEstatePanel":        return typeof setEstatePanelEnabled === "function" ? setEstatePanelEnabled : null;
      case "showAllianceRequestsPanel": return typeof setAllianceRequestsPanelEnabled === "function" ? setAllianceRequestsPanelEnabled : null;
      case "showHelperUsers":        return typeof setHelperUsersEnabled === "function" ? setHelperUsersEnabled : null;
      case "markBotNationsRed":      return typeof setBotMarkersEnabled === "function" ? setBotMarkersEnabled : null;
      case "markHoveredAlliesGreen": return typeof setAllyMarkersEnabled === "function" ? setAllyMarkersEnabled : null;
      case "showNukePrediction":     return typeof setNukePredictionEnabled === "function" ? setNukePredictionEnabled : null;
      case "showNukeTrajectory":     return typeof setNukeTrajectoryEnabled === "function" ? setNukeTrajectoryEnabled : null;
      case "showBoatPrediction":     return typeof setBoatPredictionEnabled === "function" ? setBoatPredictionEnabled : null;
      case "showWarshipRoutes":      return typeof setWarshipRoutesEnabled === "function" ? setWarshipRoutesEnabled : null;
      case "showNukeSuggestions":    return typeof setNukeSuggestionsEnabled === "function" ? setNukeSuggestionsEnabled : null;
      // Sub-toggles that need to re-send the parent setter with all current
      // values (boat prediction, warship routes, auto nuke).
      case "alwaysShowOwnBoatRoutes":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setBoatPredictionEnabled === "function") setBoatPredictionEnabled(s.showBoatPrediction !== false, { alwaysOwnRoutes: v, alwaysTeamRoutes: s.alwaysShowTeamBoatRoutes, alwaysAllyRoutes: s.alwaysShowAllyBoatRoutes, alwaysEnemyRoutes: s.alwaysShowEnemyBoatRoutes }); };
      case "alwaysShowTeamBoatRoutes":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setBoatPredictionEnabled === "function") setBoatPredictionEnabled(s.showBoatPrediction !== false, { alwaysOwnRoutes: s.alwaysShowOwnBoatRoutes, alwaysTeamRoutes: v, alwaysAllyRoutes: s.alwaysShowAllyBoatRoutes, alwaysEnemyRoutes: s.alwaysShowEnemyBoatRoutes }); };
      case "alwaysShowAllyBoatRoutes":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setBoatPredictionEnabled === "function") setBoatPredictionEnabled(s.showBoatPrediction !== false, { alwaysOwnRoutes: s.alwaysShowOwnBoatRoutes, alwaysTeamRoutes: s.alwaysShowTeamBoatRoutes, alwaysAllyRoutes: v, alwaysEnemyRoutes: s.alwaysShowEnemyBoatRoutes }); };
      case "alwaysShowEnemyBoatRoutes":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setBoatPredictionEnabled === "function") setBoatPredictionEnabled(s.showBoatPrediction !== false, { alwaysOwnRoutes: s.alwaysShowOwnBoatRoutes, alwaysTeamRoutes: s.alwaysShowTeamBoatRoutes, alwaysAllyRoutes: s.alwaysShowAllyBoatRoutes, alwaysEnemyRoutes: v }); };
      case "showWarshipRoutesOwn":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setWarshipRoutesEnabled === "function") setWarshipRoutesEnabled(s.showWarshipRoutes !== false, { own: v, team: s.showWarshipRoutesTeam, ally: s.showWarshipRoutesAlly, enemy: s.showWarshipRoutesEnemy }); };
      case "showWarshipRoutesTeam":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setWarshipRoutesEnabled === "function") setWarshipRoutesEnabled(s.showWarshipRoutes !== false, { own: s.showWarshipRoutesOwn, team: v, ally: s.showWarshipRoutesAlly, enemy: s.showWarshipRoutesEnemy }); };
      case "showWarshipRoutesAlly":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setWarshipRoutesEnabled === "function") setWarshipRoutesEnabled(s.showWarshipRoutes !== false, { own: s.showWarshipRoutesOwn, team: s.showWarshipRoutesTeam, ally: v, enemy: s.showWarshipRoutesEnemy }); };
      case "showWarshipRoutesEnemy":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setWarshipRoutesEnabled === "function") setWarshipRoutesEnabled(s.showWarshipRoutes !== false, { own: s.showWarshipRoutesOwn, team: s.showWarshipRoutesTeam, ally: s.showWarshipRoutesAlly, enemy: v }); };
      case "autoNuke":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setAutoNukeEnabled === "function") setAutoNukeEnabled(v, s.autoNukeIncludeAllies !== false); };
      case "autoNukeIncludeAllies":
        return function(v) { var s = _quickPanelSettingsCache || {}; if (typeof setAutoNukeEnabled === "function") setAutoNukeEnabled(s.autoNuke !== false, v); };
      case "showEconomyHeatmap":     return typeof setEconomyHeatmapEnabled === "function" ? setEconomyHeatmapEnabled : null;
      case "showExportPartnerHeatmap": return typeof setExportPartnerHeatmapEnabled === "function" ? setExportPartnerHeatmapEnabled : null;
      case "showAttackHighlight":    return typeof setAttackHighlightEnabled === "function" ? setAttackHighlightEnabled : null;
      case "showRetaliationHud":     return typeof setRetaliationEnabled === "function" ? setRetaliationEnabled : null;
      case "hideAds":                return typeof setHideAdsEnabled === "function" ? setHideAdsEnabled : null;
      case "antiAfk":                return typeof setAntiAfkEnabled === "function" ? setAntiAfkEnabled : null;
      case "attackRatioHotkey":      return typeof setAttackRatioHotkeyEnabled === "function" ? setAttackRatioHotkeyEnabled : null;
      case "rightClickConquest":     return typeof setRightClickMenuEnabled === "function" ? setRightClickMenuEnabled : null;
      case "roundLogger":            return typeof setRoundLoggerEnabled === "function" ? setRoundLoggerEnabled : null;
      case "networkLogger":          return typeof setNetworkLoggerEnabled === "function" ? setNetworkLoggerEnabled : null;
      case "showBuildTimers":        return typeof setBuildTimerEnabled === "function" ? setBuildTimerEnabled : null;
      case "showEnemyIntent":        return typeof setEnemyIntentEnabled === "function" ? setEnemyIntentEnabled : null;
      case "showSpawnHeatmap":       return typeof setSpawnHeatmapEnabled === "function" ? setSpawnHeatmapEnabled : null;
      case "showSpawnMarkers":       return typeof setSpawnMarkersEnabled === "function" ? setSpawnMarkersEnabled : null;
      case "sosDefense":             return typeof setSosDefenseEnabled === "function" ? setSosDefenseEnabled : null;
      case "showGameTimeAlert":      return typeof setGameTimeAlertEnabled === "function" ? setGameTimeAlertEnabled : null;
      case "showPlayerMapOverlays":  return typeof setPlayerMapOverlaysEnabled === "function" ? setPlayerMapOverlaysEnabled : null;
      case "showMapTroopCounts":     return typeof setMapTroopCountsEnabled === "function" ? setMapTroopCountsEnabled : null;
      case "showThreatIndicators":   return typeof setThreatIndicatorsEnabled === "function" ? setThreatIndicatorsEnabled : null;
      case "showMapMoney":           return typeof setMapMoneyEnabled === "function" ? setMapMoneyEnabled : null;
      case "skinUnlocker":           return typeof _setSkinUnlockerEnabled === "function" ? _setSkinUnlockerEnabled : null;
      case "warnIncomingBoats":      return typeof setBoatIncomingWarningEnabled === "function" ? setBoatIncomingWarningEnabled : null;
    */
    return QUICK_PANEL_SETTER_RESOLVERS[key]?.() ?? null;
  }

  function _animateSettingPanel(key, enabled) {
    if (!_PANEL_IDS[key]) return;
    setTimeout(() => _animatePanelToggle(_PANEL_IDS[key], enabled), 30);
  }

  function _applyStandardSetting(key, enabled) {
    const setter = _resolveSetter(key);
    if (!setter) return;
    { setter(enabled); }
    _animateSettingPanel(key, enabled);
  }

  function _refreshSiloSamTracker() {
    {
      if (typeof window.__OFH_updateSiloSamTracker === "function") {
        window.__OFH_updateSiloSamTracker();
      }
    }
  }

  function _applyCombatTrackerSetting(key, enabled) {
    const panelIds = {
      combatSiloPanel: "openfront-helper-silo-panel",
      combatSamTracker: "openfront-helper-sam-panel",
    };
    const panelId = panelIds[key];
    if (panelId) {
      const panel = document.getElementById(panelId);
      if (enabled) _refreshSiloSamTracker();
      else if (panel) {
        panel.dataset.visible = "false";
        panel.style.setProperty("display", "none", "important");
      }
    }
    const refreshKeys = new Set([
      "combatSiloShowAll", "combatSiloBuildingOnly", "combatSiloAudioAlert",
      "combatSiloOneClickFire", "combatSiloAutoFireBuilding",
      "combatSamBuildingOnly", "combatSamShowAll",
      "combatSamOneClickFire", "combatSamAutoFireBuilding",
    ]);
    if (refreshKeys.has(key)) _refreshSiloSamTracker();
  }

  function _applyAutoDonateSetting(key, enabled) {
    if (key !== "autoDonateEnabled" && key !== "autoDonateGoldEnabled") return;
    {
      window.__OFH_autobot?.set?.({ features: { donate: !enabled } });
    }
    const message = enabled
      ? "Auto-donate ON — bot donate OFF"
      : "Auto-donate OFF — bot donate ON";
    _toast(`🎁 ${_tr(message)}`);
  }

  function _applySettingLocally(key, value) {
    const enabled = Boolean(value);
    _applyStandardSetting(key, enabled);
    if (key === "showAutoBotPanel") {
      { window.__OFH_autobot?.set?.({ hidden: !enabled }); }
      _animateSettingPanel(key, enabled);
    }
    _applyCombatTrackerSetting(key, enabled);
    _applyAutoDonateSetting(key, enabled);
    if (["guiAccentColor", "guiAccentHue", "guiOpacity", "overlayOpacity"].includes(key)) {
      _themeFromSettings();
    }
    if (key === "rainbowMode") _toggleRainbowMode(enabled);
  }

  function setQuickPanelSettings(settings) {
    var prevLang = _quickPanelSettingsCache ? _quickPanelSettingsCache.language : null;
    _quickPanelSettingsCache = settings || {};
    _themeFromSettings();
    // Only re-render when language actually changed (not on every setting sync).
    var newLang = _quickPanelSettingsCache.language;
    if (prevLang !== newLang && runtimeState.quickPanelEnabled && document.getElementById(QUICK_PANEL_ID)) {
      _renderActiveTab();
    }
  }

  // ---- Panel shell ----

  const QUICK_PANEL_TABS = [
    { id: "actions", emoji: "⚔️", title: "Actions", tip: "Quick actions: Kill Shot, Embargo, Silo/SAM trackers, Auto Donate, Atom Batch-fire" },
    { id: "helpers", emoji: "⚙️", title: "Helpers", tip: "Toggle panels, map overlays, combat features, alerts, and tools" },
    { id: "config", emoji: "🔧", title: "Config", tip: "Theme, language, skin unlocker, low lag mode, and reset settings" },
  ];

  function createQuickPanelHeader() {
    const header = document.createElement("div");
    header.className = "ohqp-header";
    const connection = document.createElement("span");
    connection.id = "ohqp-connection";
    connection.className = "ohqp-conn";
    connection.dataset.status = "disconnected";
    connection.textContent = "●";
    connection.title = "WebSocket status";
    const title = document.createElement("div");
    title.className = "ohqp-title";
    title.textContent = `⚙ OpenFront Helper (CUSTOM) v${window.__OFH_ASSETS?.version ?? "dev"}`;
    const minimize = document.createElement("button");
    minimize.type = "button";
    minimize.className = "ohqp-min-btn";
    minimize.textContent = "▾";
    minimize.title = "Minimize / Restore";
    minimize.addEventListener("click", () => {
      const panel = document.getElementById(QUICK_PANEL_ID);
      if (!panel) return;
      const restore = panel.dataset.minimized === "true";
      panel.dataset.minimized = restore ? "false" : "true";
      minimize.textContent = restore ? "▾" : "▴";
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ohqp-min-btn";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", () => {
      const panel = document.getElementById(QUICK_PANEL_ID);
      if (panel) _animateClose(panel);
    });
    header.append(connection, title, minimize, close);
    return header;
  }

  function createQuickPanelTabs() {
    const tabs = document.createElement("div");
    tabs.className = "ohqp-tabs";
    for (const definition of QUICK_PANEL_TABS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tab = definition.id;
      button.textContent = definition.emoji;
      button.classList.toggle("active", definition.id === quickPanelActiveTab);
      button.addEventListener("click", _onTabClick);
      button.addEventListener("mouseenter", () => {
        _showQpPopover(button, `<b>${_tr(definition.title)}</b><br>${_tr(definition.tip)}`, 800);
      });
      button.addEventListener("mouseleave", _hideQpPopover);
      tabs.appendChild(button);
    }
    return tabs;
  }

  function createQuickPanelBody() {
    const body = document.createElement("div");
    body.className = "ohqp-body";
    for (const definition of QUICK_PANEL_TABS) {
      const tabPanel = document.createElement("div");
      tabPanel.dataset.panel = definition.id;
      tabPanel.classList.toggle("active", definition.id === quickPanelActiveTab);
      body.appendChild(tabPanel);
    }
    return body;
  }

  function ensureQuickPanel() {
    ensureQuickPanelStyles();
    let panel = document.getElementById(QUICK_PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = QUICK_PANEL_ID;
    const header = createQuickPanelHeader();
    panel.append(header, createQuickPanelTabs(), createQuickPanelBody());

    // Clean up stale popovers from previous builds.
    document.querySelectorAll(".qp-feat-tip").forEach(function(t) { t.remove(); });
    _qpPopoverEl = null;

    (document.body || document.documentElement).appendChild(panel);

    if (typeof makeGoldStatPanelDraggable === "function") {
      makeGoldStatPanelDraggable(panel, header, QUICK_PANEL_POS_KEY);
      applyStoredGoldStatPanelPosition(panel, QUICK_PANEL_POS_KEY);
    }

    _renderActiveTab();
    _themeFromSettings();
    return panel;
  }

  function _onTabClick(e) {
    quickPanelActiveTab = e.currentTarget.dataset.tab;
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (!panel) return;
    var tabBtns = panel.querySelectorAll(".ohqp-tabs button");
    for (let i = 0; i < tabBtns.length; i++) {
      tabBtns[i].classList.toggle("active", tabBtns[i].dataset.tab === quickPanelActiveTab);
    }
    var bodies = panel.querySelectorAll(".ohqp-body > div");
    for (let i = 0; i < bodies.length; i++) {
      bodies[i].classList.toggle("active", bodies[i].dataset.panel === quickPanelActiveTab);
    }
    _renderActiveTab();
  }

  function _renderActiveTab() {
    var saved = _saveAccordionState();
    switch (quickPanelActiveTab) {
      case "actions": _renderActionsTab(); break;
      case "helpers": _renderHelpersTab(); break;
      case "config":  _renderConfigTab(); break;
    }
    _restoreAccordionState(saved);
  }

  // ---- i18n helper (tr() is from auto-bot/i18n.js) ----
  function _tr(key) {
    return (typeof tr === "function") ? tr(key) : key;
  }
  function _esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  // Hotkey code → human-readable label
  function _hotkeyLabel(code) {
    if (!code) return "—";
    var parts = code.split("+");
    var labels = [];
    for (let i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === "Shift") labels.push("⇧");
      else if (p === "Ctrl") labels.push("Ctrl");
      else if (p === "Alt") labels.push("Alt");
      else if (p === "Meta") labels.push("⌘");
      else if (p.startsWith("Key")) labels.push(p.replace("Key", ""));
      else if (p.startsWith("Digit")) labels.push(p.replace("Digit", ""));
      else labels.push(p);
    }
    return labels.join("+");
  }

  // Kill shot hotkey listener
  var _killShotListening = false;
  function _installKillShotHotkey() {
    document.addEventListener("keydown", function(e) {
      if (_killShotListening) return; // don't fire while rebinding
      var code = _getSetting("killShotHotkey", "Shift+KeyK");
      if (!code) return;
      // Build actual code from event
      var parts = [];
      if (e.shiftKey) parts.push("Shift");
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.metaKey) parts.push("Meta");
      parts.push(e.code);
      var pressed = parts.join("+");
      if (pressed === code) {
        e.preventDefault();
        e.stopPropagation();
        _doKillShot();
      }
    });
  }
  _installKillShotHotkey();

  function _resetAllSettings() {
    if (!confirm(_tr("Reset all settings to default? This will reload the page."))) return;
    {
      // Clear all openfront-helper keys from localStorage
      var keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf("openfront-helper") !== -1 || k.indexOf("ofh:") !== -1 || k.indexOf("cext_") !== -1)) {
          keysToRemove.push(k);
        }
      }
      for (let i = 0; i < keysToRemove.length; i++) {
        localStorage.removeItem(keysToRemove[i]);
      }
    }
    // Reload page
    location.reload();
  }

  function _startHotkeyCapture(settingKey) {
    _killShotListening = true;
    // Find the button that triggered this
    var actionName = settingKey === "killShotHotkey" ? "setKillShotHotkey" : "setAtomHotkey";
    var btn = document.querySelector('[data-qp-action="' + actionName + '"]');
    if (btn) {
      btn.textContent = _tr("Press any key...");
      btn.style.color = "var(--oh-accent)";
      btn.style.borderColor = "var(--oh-accent)";
    }
    function onKey(e) {
      // Ignore standalone modifier keys — wait for the actual key
      if (e.code === "ShiftLeft" || e.code === "ShiftRight" ||
          e.code === "ControlLeft" || e.code === "ControlRight" ||
          e.code === "AltLeft" || e.code === "AltRight" ||
          e.code === "MetaLeft" || e.code === "MetaRight") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("keydown", onKey, true);
      _killShotListening = false;
      // Build code string
      var parts = [];
      if (e.shiftKey) parts.push("Shift");
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.metaKey) parts.push("Meta");
      parts.push(e.code);
      var code = parts.join("+");
      _setAndNotify(settingKey, code);
      var icon = settingKey === "killShotHotkey" ? "☄️" : "☢️";
      _toast(icon + " " + _hotkeyLabel(code));
      _renderActiveTab();
    }
    document.addEventListener("keydown", onKey, true);
  }

  // ---- Mini switch helper ----
  function _swHtml(key, checked, disabled, label) {
    return '<label class="ohqp-row"><span class="ohqp-label">' + _esc(_tr(label)) + '</span>' +
           '<span class="ohqp-sw' + (checked ? ' on' : '') + '" data-qp-key="' + key + '"></span></label>';
  }

  // Like _swHtml but includes a small "?" icon that shows a detailed popover on hover.
  // Accepts same (key, checked, disabled, label) signature as _swHtml.
  function _swHtmlWithTip(key, checked, disabled, label) {
    if (label === undefined) { label = disabled; }
    return '<label class="ohqp-row"><span class="ohqp-label">' + _esc(_tr(label)) + '</span>' +
           '<span class="ohqp-tip-icon" data-qp-tip-key="' + key + '">?</span>' +
           '<span class="ohqp-sw' + (checked ? ' on' : '') + '" data-qp-key="' + key + '"></span></label>';
  }

  // ---- Tab: Actions (WS-injected) ----
  function _killShotActionHtml() {
    const label = _hotkeyLabel(_getSetting("killShotHotkey", "Shift+KeyK"));
    return [
      '<div class="ohqp-sec"><div class="ohqp-sec-h open" data-qp-tip-key="Kill Shot">☄️ ' + _tr("Kill Shot") + '<span class="ohqp-tip-icon" data-qp-tip-key="Kill Shot">?</span></div><div class="ohqp-sec-b open">',
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">',
      '<span class="ohqp-label-sm" style="flex:1;">' + _tr("Hotkey") + '</span>',
      '<button class="ohqp-btn" data-qp-action="setKillShotHotkey" style="font-family:monospace;min-width:80px;">' + _esc(label) + '</button></div>',
      _swHtmlWithTip("killShotInstantSend", _getSetting("killShotInstantSend", false), false, "Instant send (no slider)"),
      '</div></div>',
    ].join("");
  }

  function _embargoActionHtml() {
    return '<div class="ohqp-sec"><div class="ohqp-sec-h open" data-qp-tip-key="Embargo">🚫 ' + _tr("Embargo") + '<span class="ohqp-tip-icon" data-qp-tip-key="Embargo">?</span></div><div class="ohqp-sec-b open"><div style="display:flex;gap:4px;margin-bottom:4px;"><button class="ohqp-btn" data-qp-action="embargoAll" style="flex:1;">' + _tr("Embargo All") + '</button><button class="ohqp-btn" data-qp-action="liftEmbargo" style="flex:1;">' + _tr("Trade All") + '</button></div></div></div>';
  }

  function _combatTrackerActionHtml(kind) {
    const silo = kind === "Silo";
    const prefix = silo ? "combatSilo" : "combatSam";
    const settings = silo
      ? [["Panel", "Silo tracker panel"], ["ShowAll", "Show all (spectator)"], ["BuildingOnly", "Building only"], ["AudioAlert", "Audio ping on silo"], ["OneClickFire", "One-click fire"], ["AutoFireBuilding", "Auto fire building"]]
      : [["Tracker", "SAM tracker panel"], ["ShowAll", "Show all (spectator)"], ["BuildingOnly", "Building only"], ["OneClickFire", "One-click fire"], ["AutoFireBuilding", "Auto fire building"]];
    const openClass = silo ? " open" : "";
    const rows = settings.map(([suffix, label]) =>
      _swHtmlWithTip(prefix + suffix, _getSetting(prefix + suffix, false), false, label));
    return [
      `<div class="ohqp-sec"><div class="ohqp-sec-h${openClass}" data-qp-tip-key="${kind} Tracker">${silo ? "🚀" : "🛡️"} ${_tr(kind + " Tracker")}<span class="ohqp-tip-icon" data-qp-tip-key="${kind} Tracker">?</span></div><div class="ohqp-sec-b${openClass}">`,
      ...rows,
      '<div style="display:flex;align-items:center;gap:4px;margin:2px 0;"><span class="ohqp-label-sm" style="width:110px;">' + _tr("Max nuke auto fire") + '</span>',
      `<input class="ohqp-input" type="number" min="1" step="1" data-qp-input="${prefix}AutoFireMaxQty" value="${_getSetting(prefix + "AutoFireMaxQty", 1) || 1}" style="flex:1;"></div></div></div>`,
    ].join("");
  }

  function _autoDonateActionHtml(kind) {
    const gold = kind === "Gold";
    const prefix = gold ? "autoDonateGold" : "autoDonate";
    const threshold = gold
      ? '<div style="display:flex;align-items:center;gap:4px;margin:2px 0;"><span class="ohqp-label-sm" style="width:55px;">' + _tr("Max gold") + '</span><input class="ohqp-input" type="number" data-qp-input="autoDonateGoldThreshold" value="' + (_getSetting("autoDonateGoldThreshold", 5000000) || 5000000) + '" style="flex:1;"></div>'
      : '<div style="display:flex;align-items:center;gap:4px;margin:2px 0;"><span class="ohqp-label-sm" style="width:55px;">' + _tr("Keep") + '</span><input class="ohqp-range" type="range" data-qp-range="autoDonateKeepPct" min="10" max="90" step="5" value="' + (_getSetting("autoDonateKeepPct", 40) || 40) + '" style="flex:1;"><span class="ohqp-label-sm" style="width:30px;text-align:right;">' + (_getSetting("autoDonateKeepPct", 40) || 40) + '%</span></div>';
    const percentageKey = `${prefix}Percentage`;
    const targetsKey = `${prefix}Targets`;
    return [
      `<div class="ohqp-sec"><div class="ohqp-sec-h" data-qp-tip-key="Auto Donate ${kind}">${gold ? "💰" : "💪"} ${_tr("Auto Donate " + kind)}<span class="ohqp-tip-icon" data-qp-tip-key="Auto Donate ${kind}">?</span></div><div class="ohqp-sec-b">`,
      _swHtmlWithTip(`${prefix}Enabled`, _getSetting(`${prefix}Enabled`, false), false, "Enable"),
      threshold,
      '<div style="display:flex;align-items:center;gap:4px;margin:2px 0;"><span class="ohqp-label-sm" style="width:55px;">' + _tr("Donate") + `</span><input class="ohqp-range" type="range" data-qp-range="${percentageKey}" min="1" max="100" step="5" value="${_getSetting(percentageKey, 25) || 25}" style="flex:1;"><span class="ohqp-label-sm" style="width:30px;text-align:right;">${_getSetting(percentageKey, 25) || 25}%</span></div>`,
      '<div style="margin:2px 0;"><span class="ohqp-label-sm">' + _tr("Targets (comma-separated names)") + `</span></div><input class="ohqp-input" type="text" data-qp-input-str="${targetsKey}" value="${_esc(_getSetting(targetsKey, ""))}" placeholder="Player1, Player2, [TAG]" style="width:100%;"></div></div>`,
    ].join("");
  }

  function _atomBatchActionHtml() {
    const config = _atomGetCfg();
    const rate = (1000 / _atomGapMs(config.batchSize, config.delayMs)).toFixed(1);
    const keyLabel = _hotkeyLabel(_getSetting("atomBatchHotkey", "Backslash"));
    return [
      '<div class="ohqp-sec"><div class="ohqp-sec-h" data-qp-tip-key="Atom batch-fire">☢️ ' + _tr("Atom batch-fire") + '<span class="ohqp-tip-icon" data-qp-tip-key="Atom batch-fire">?</span></div><div class="ohqp-sec-b">',
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;"><span class="ohqp-label-sm" style="flex:1;">' + _tr("Hotkey") + '</span><button class="ohqp-btn" data-qp-action="setAtomHotkey" style="font-family:monospace;min-width:80px;">' + _esc(keyLabel) + '</button></div>',
      '<div style="font-size:9px;color:var(--oh-panel-text-dim);margin-bottom:6px;line-height:1.4;">' + _tr("Aim at a target and press the hotkey to open the batch-fire dialog.") + '</div>',
      '<div class="ohqp-row"><span class="ohqp-label">' + _tr("Atoms per burst") + `</span><input class="ohqp-input" type="number" data-qp-atom="batchSize" min="1" step="1" value="${config.batchSize}" style="width:60px;"></div>`,
      '<div class="ohqp-row"><span class="ohqp-label">' + _tr("Delay (ms)") + `</span><input class="ohqp-input" type="number" data-qp-atom="delayMs" min="0" step="10" value="${config.delayMs}" style="width:60px;"></div>`,
      _swHtmlWithTip("lastHydrogen", config.lastHydrogen, false, "Final shot → Hydrogen"),
      '<div class="ohqp-row"><span class="ohqp-label">' + _tr("Effective fire rate") + `</span><span style="font-family:monospace;color:var(--oh-accent);font-size:10px;">≈ ${rate} ${_tr("shots/sec")}</span></div>`,
      '<button class="ohqp-btn" data-qp-action="resetAtom" style="width:100%;margin-top:4px;">' + _tr("Reset to safe defaults") + '</button></div></div>',
    ].join("");
  }

  function _renderActionsTab() {
    const el = document.querySelector("#" + QUICK_PANEL_ID + " [data-panel='actions']");
    if (!el) return;
    el.innerHTML = [
      _killShotActionHtml(), _embargoActionHtml(),
      _combatTrackerActionHtml("Silo"), _combatTrackerActionHtml("SAM"),
      _autoDonateActionHtml("Troops"), _autoDonateActionHtml("Gold"),
      _atomBatchActionHtml(),
    ].join("");
    _bindEvents(el);
    _bindAtomEvents(el);
  }

  // Atom config helpers (bridge to engine's __OFH_atomBatch)
  var _ATOM_DEFAULTS = { batchSize: 10, delayMs: 150, lastHydrogen: false };
  function _atomGetCfg() {
    {
      if (window.__OFH_atomBatch && typeof window.__OFH_atomBatch.get === "function")
        return window.__OFH_atomBatch.get();
    }
    return _ATOM_DEFAULTS;
  }
  function _atomSetCfg(patch) {
    {
      if (window.__OFH_atomBatch && typeof window.__OFH_atomBatch.set === "function")
        window.__OFH_atomBatch.set(patch);
    }
  }
  function _atomGapMs(batchSize, delayMs) {
    {
      if (window.__OFH_atomBatch && typeof window.__OFH_atomBatch.effectiveGapMs === "function")
        return window.__OFH_atomBatch.effectiveGapMs(batchSize, delayMs);
    }
    var perShot = batchSize >= 1 ? (delayMs || 0) / batchSize : delayMs || 0;
    return Math.max(140, perShot); // 140ms = server-safe floor
  }
  function _bindAtomEvents(el) {
    var inputs = el.querySelectorAll("[data-qp-atom]");
    for (let i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener("change", function() {
        var key = this.dataset.qpAtom;
        var v = Math.floor(Number(this.value));
        if (!isFinite(v) || v < 0) v = 0;
        _atomSetCfg({ [key]: v });
        _renderActiveTab();
      });
    }
    var hydroSw = el.querySelector('[data-qp-key="lastHydrogen"]');
    if (hydroSw) {
      hydroSw.addEventListener("click", function(e) {
        e.preventDefault();
        var cfg = _atomGetCfg();
        var next = !cfg.lastHydrogen;
        _atomSetCfg({ lastHydrogen: next });
        this.classList.toggle("on", next);
      });
    }
    var resetBtn = el.querySelector('[data-qp-action="resetAtom"]');
    if (resetBtn) {
      resetBtn.addEventListener("click", function() {
        _atomSetCfg({ batchSize: _ATOM_DEFAULTS.batchSize, delayMs: _ATOM_DEFAULTS.delayMs });
        _renderActiveTab();
      });
    }
  }

  // ---- Tab: Helpers (mirror of popup HELPER_SECTIONS) ----
  function _renderHelpersTab() {
    var el = document.querySelector("#" + QUICK_PANEL_ID + " [data-panel='helpers']");
    if (!el) return;
    var sections = [
      {
        key: "panels", title: _tr("Panels"), toggles: [
          ["showTopGoldPerMinute", _tr("Player stats panel")],
          ["showGoldPerMinute", _tr("Highlight hovered player")],
          ["showTeamBuildStats", _tr("Team build stats")],
          ["showTradeBalances", _tr("Trade balances")],
          ["showAdvisorPanel", _tr("Advisor panel")],
          ["showBoatPanel", _tr("Boat panel")],
          ["showEstatePanel", _tr("Estates panel")],
          ["showAllianceRequestsPanel", _tr("Alliance requests")],
          ["showHelperUsers", _tr("Script users")],
          ["showAutoBotPanel", _tr("Auto-Bot panel")],
          ["showFloatingAutoJoinPanel", _tr("Auto-Join panel")],
        ]
      },
      {
        key: "map", title: _tr("Map overlays"), toggles: [
          ["showPlayerMapOverlays", _tr("Player overlays (master)")],
          ["showMapTroopCounts", _tr("Troop bar"), "showPlayerMapOverlays"],
          ["showMapMoney", _tr("Money"), "showPlayerMapOverlays"],
          ["showThreatIndicators", _tr("Threat indicators"), "showPlayerMapOverlays"],
          ["markHoveredAlliesGreen", _tr("Ally markers on hover")],
          ["showAttackHighlight", _tr("Attack highlight")],
          ["showNukePrediction", _tr("Nuke prediction")],
          ["showNukeTrajectory", _tr("Trajectory line"), "showNukePrediction"],
          ["showBoatPrediction", _tr("Boat prediction")],
          ["alwaysShowOwnBoatRoutes", _tr("Own boat routes"), "showBoatPrediction"],
          ["alwaysShowTeamBoatRoutes", _tr("Team boat routes"), "showBoatPrediction"],
          ["alwaysShowAllyBoatRoutes", _tr("Ally boat routes"), "showBoatPrediction"],
          ["alwaysShowEnemyBoatRoutes", _tr("Enemy boat routes"), "showBoatPrediction"],
          ["showWarshipRoutes", _tr("Warship routes")],
          ["showWarshipRoutesOwn", _tr("Own warships"), "showWarshipRoutes"],
          ["showWarshipRoutesTeam", _tr("Team warships"), "showWarshipRoutes"],
          ["showWarshipRoutesAlly", _tr("Ally warships"), "showWarshipRoutes"],
          ["showWarshipRoutesEnemy", _tr("Enemy warships"), "showWarshipRoutes"],
          ["showEconomyHeatmap", _tr("Economy heatmap")],
          ["showExportPartnerHeatmap", _tr("Export partner heatmap")],
          ["showSpawnHeatmap", _tr("Spawn heatmap")],
          ["showSpawnMarkers", _tr("Spawn markers")],
          ["showBuildTimers", _tr("Build timers")],
        ]
      },
      {
        key: "combat", title: _tr("Combat & Automation"), toggles: [
          ["showRetaliationHud", _tr("Retaliation HUD")],
          ["autoNuke", _tr("Auto nuke")],
          ["autoNukeIncludeAllies", _tr("Include allies"), "autoNuke"],
          ["showNukeSuggestions", _tr("Nuke suggestions")],
          ["sosDefense", _tr("SOS defense")],
          ["attackRatioHotkey", _tr("Attack ratio hotkey")],
          ["rightClickConquest", _tr("Right-click conquest")],
          ["showEnemyIntent", _tr("Enemy intent warning")],
        ]
      },
      {
        key: "alerts", title: _tr("Alerts"), toggles: [
          ["showGameTimeAlert", _tr("Game-time alert")],
          ["warnIncomingBoats", _tr("Incoming boat warning")],
        ]
      },
      {
        key: "tools", title: _tr("Tools"), toggles: [
          ["hideAds", _tr("Hide ads")],
          ["antiAfk", _tr("Anti-AFK")],
          ["roundLogger", _tr("Round logger")],
          ["networkLogger", _tr("Network logger")],
          ["markBotNationsRed", _tr("Mark bot nations red")],
        ]
      },
      {
        key: "companion", title: _tr("Companion"), toggles: [
          ["showCompanionPanel", _tr("Companion bot panel")],
          ["companionEnabled", _tr("Companion mode")],
        ]
      },
    ];

    var h = [];
    for (let i = 0; i < sections.length; i++) {
      var sec = sections[i];
      var open = !_getSetting("collapsedHelperCategories." + sec.key, false);
      h.push('<div class="ohqp-sec"><div class="ohqp-sec-h' + (open ? ' open' : '') + '" data-qp-section="' + sec.key + '">');
      h.push('<span class="ohqp-chevron">▸</span> ' + _esc(sec.title));
      h.push('<span class="ohqp-tip-icon" data-qp-tip-key="' + sec.key + '">?</span>');
      h.push('</div><div class="ohqp-sec-b' + (open ? ' open' : '') + '">');
      for (let j = 0; j < sec.toggles.length; j++) {
        var t = sec.toggles[j];
        var key = t[0], label = t[1], parentKey = t[2] || null;
        var rowHtml = _swHtmlWithTip(key, _getSetting(key, false), label);
        if (parentKey) {
          rowHtml = rowHtml.replace('class="ohqp-row"', 'class="ohqp-row ohqp-sub"');
          rowHtml = rowHtml.replace('data-qp-key="' + key + '"', 'data-qp-key="' + key + '" data-qp-parent="' + parentKey + '"');
        }
        h.push(rowHtml);
      }
      h.push('</div></div>');
    }
    el.innerHTML = h.join("");
    // Disable child switches whose parent is currently off.
    var subSwitches = el.querySelectorAll('.ohqp-sw[data-qp-parent]');
    for (var si = 0; si < subSwitches.length; si++) {
      var pkey = subSwitches[si].dataset.qpParent;
      if (!_getSetting(pkey, false)) subSwitches[si].classList.add('disabled');
    }
    _bindEvents(el);
  }

  // ---- Tab: Theme ----
  function _renderThemeTab() {
    var el = document.querySelector("#" + QUICK_PANEL_ID + " [data-panel='theme']");
    if (!el) return;
    var presets = _themePresets;
    var h = [];
    h.push('<div class="ohqp-label-sm">' + _tr('Presets') + '</div>');
    h.push('<div class="ohqp-presets">');
    var pkeys = Object.keys(presets);
    for (let i = 0; i < pkeys.length; i++) {
      var hex = presets[pkeys[i]];
      var name = pkeys[i].charAt(0).toUpperCase() + pkeys[i].slice(1);
      h.push('<button data-qp-theme="' + hex + '" style="border-color:' + hex + ';color:' + hex + ';">' + name + '</button>');
    }
    h.push('</div>');
    h.push('<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;"><span class="ohqp-label-sm">' + _tr('Accent Hue') + '</span>');
    h.push('<input type="color" data-qp-color="guiAccentColor" value="' + (_getSetting("guiAccentColor", "#00ff66") || "#00ff66") + '" style="width:24px;height:20px;border:none;padding:0;cursor:pointer;">');
    h.push('<input class="ohqp-range" type="range" data-qp-range="guiAccentHue" min="0" max="360" step="1" value="' + (_getSetting("guiAccentHue", 150) || 150) + '">');
    h.push('</div>');
    h.push('<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;"><span class="ohqp-label-sm">' + _tr('GUI Opacity') + '</span>');
    h.push('<input class="ohqp-range" type="range" data-qp-range="guiOpacity" min="0.1" max="1" step="0.01" value="' + (_getSetting("guiOpacity", 1) || 1) + '">');
    h.push('</div>');
    h.push('<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;"><span class="ohqp-label-sm">' + _tr('Overlay Opacity') + '</span>');
    h.push('<input class="ohqp-range" type="range" data-qp-range="overlayOpacity" min="0.1" max="1" step="0.01" value="' + (_getSetting("overlayOpacity", 1) || 1) + '">');
    h.push('</div>');
    h.push(_swHtmlWithTip("rainbowMode", _getSetting("rainbowMode", false), false, "Rainbow mode"));
    h.push('<div class="ohqp-divider"></div>');
    h.push('<div style="display:flex;gap:4px;">');
    h.push('<button class="ohqp-btn" data-qp-action="resetColors" style="flex:1;">' + _tr('Reset Colors') + '</button>');
    h.push('<button class="ohqp-btn" data-qp-action="resetLayout" style="flex:1;">' + _tr('Reset Layout') + '</button>');
    h.push('</div>');

    el.innerHTML = h.join("");
    _bindThemeEvents(el);
  }

  function _bindThemeEvents(el) {
    var presets = el.querySelectorAll("[data-qp-theme]");
    for (let i = 0; i < presets.length; i++) {
      presets[i].addEventListener("click", function() {
        var hex = this.dataset.qpTheme;
        _setAndNotify("guiAccentColor", hex);
        _applyTheme(hex);
        _renderActiveTab();
      });
    }
    // NOTE: switches are handled by _bindEvents (called first) — do NOT rebind here.
    var ranges = el.querySelectorAll("[data-qp-range]");
    for (let i = 0; i < ranges.length; i++) {
      ranges[i].addEventListener("input", function() {
        var val = Number(this.value);
        _setAndNotify(this.dataset.qpRange, val);
        if (this.dataset.qpRange === "guiAccentHue") {
          // Convert hue to hex and apply.
          var h = ((val % 360) + 360) % 360;
          var c = "hsl(" + h + ",100%,55%)";
          _setAndNotify("guiAccentColor", c);
          _applyTheme(c);
        }
        if (this.dataset.qpRange === "guiOpacity" || this.dataset.qpRange === "overlayOpacity") {
          _themeFromSettings();
        }
      });
    }
    var pickers = el.querySelectorAll("[data-qp-color]");
    for (let i = 0; i < pickers.length; i++) {
      pickers[i].addEventListener("input", function() {
        _setAndNotify(this.dataset.qpColor, this.value);
        _applyTheme(this.value);
      });
    }
    var btns = el.querySelectorAll("[data-qp-action]");
    for (let i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function() {
        if (this.dataset.qpAction === "resetColors") _resetColors();
        if (this.dataset.qpAction === "resetLayout") _resetLayout();
      });
    }
  }

  function _resetColors() {
    _setAndNotify("guiAccentColor", "#00ff66");
    _setAndNotify("guiAccentHue", 150);
    _setAndNotify("guiOpacity", 1);
    _setAndNotify("overlayOpacity", 1);
    _setAndNotify("rainbowMode", false);
    _applyTheme("#00ff66");
    _themeFromSettings();
    _renderActiveTab();
  }

  function _resetLayout() {
    { localStorage.removeItem(QUICK_PANEL_POS_KEY); }
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (panel) { panel.style.left = ""; panel.style.top = ""; panel.style.right = "16px"; }
  }

  // ---- Tab: Config ----
  function _themeConfigHtml() {
    const presetButtons = Object.entries(_themePresets).map(([key, hex]) => {
      const name = key.charAt(0).toUpperCase() + key.slice(1);
      return `<button data-qp-theme="${hex}" style="border-color:${hex};color:${hex};">${name}</button>`;
    }).join("");
    return [
      '<div class="ohqp-sec"><div class="ohqp-sec-h" data-qp-tip-key="Theme">🎨 ' + _tr("Theme") + '<span class="ohqp-tip-icon" data-qp-tip-key="Theme">?</span></div><div class="ohqp-sec-b"><div class="ohqp-presets">',
      presetButtons,
      '</div><div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;"><span class="ohqp-label-sm" style="width:55px;">' + _tr("Accent") + '</span>',
      '<input type="color" data-qp-color="guiAccentColor" value="' + (_getSetting("guiAccentColor", "#00ff66") || "#00ff66") + '" style="width:22px;height:18px;border:none;padding:0;cursor:pointer;">',
      '<input class="ohqp-range" type="range" data-qp-range="guiAccentHue" min="0" max="360" step="1" value="' + (_getSetting("guiAccentHue", 150) || 150) + '" style="flex:1;"></div>',
      '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;"><span class="ohqp-label-sm" style="width:55px;">' + _tr("Opacity") + '</span>',
      '<input class="ohqp-range" type="range" data-qp-range="guiOpacity" min="0.1" max="1" step="0.01" value="' + (_getSetting("guiOpacity", 1) || 1) + '" style="flex:1;"></div>',
      _swHtmlWithTip("rainbowMode", _getSetting("rainbowMode", false), false, "Rainbow mode"),
      '<div style="display:flex;gap:4px;margin-top:4px;"><button class="ohqp-btn" data-qp-action="resetColors" style="flex:1;font-size:9px;">' + _tr("Reset Colors") + '</button></div></div></div>',
    ].join("");
  }

  function _getAvailableQuickPanelLanguages() {
    {
      const locales = window.__OFH_ASSETS?.locales;
      if (!locales) return [{ code: "en", name: "English" }];
      const languages = Object.keys(locales)
        .filter((key) => key.length === 2)
        .map((key) => ({ code: key, name: locales[key].languageName || key }));
      return languages.length > 0 ? languages : [{ code: "en", name: "English" }];
    }
  }

  function _languageConfigHtml() {
    const current = _getSetting("language", "en") || "en";
    const languages = _getAvailableQuickPanelLanguages();
    const currentName = languages.find(({ code }) => code === current)?.name ?? current.toUpperCase();
    const items = languages.map(({ code, name }) =>
      `<div class="ohqp-lang-item${code === current ? " active" : ""}" data-qp-lang="${code}">${_esc(name)}</div>`).join("");
    return [
      '<div class="ohqp-divider"></div><div class="ohqp-label-sm">' + _tr("Language") + '</div><div class="ohqp-lang-wrap">',
      '<button class="ohqp-lang-btn" id="ohqp-lang-cur">' + _esc(currentName) + ' <span style="font-size:8px;">▾</span></button>',
      '<div class="ohqp-lang-menu" id="ohqp-lang-menu" style="display:none;">', items, '</div></div>',
    ].join("");
  }

  function _renderConfigTab() {
    const el = document.querySelector("#" + QUICK_PANEL_ID + " [data-panel='config']");
    if (!el) return;
    el.innerHTML = [
      _themeConfigHtml(), _languageConfigHtml(),
      '<div class="ohqp-divider"></div>',
      _swHtmlWithTip("skinUnlocker", _getSetting("skinUnlocker", false), false, "🎨 Skin Unlocker (all skins)"),
      _swHtmlWithTip("lowLagMode", _getSetting("lowLagMode", false), false, "⚡ Low lag mode"),
      '<div class="ohqp-divider"></div><button class="ohqp-btn danger" data-qp-action="resetAllSettings" style="width:100%;">🔄 ' + _tr("Reset all settings") + '</button>',
      '<div class="ohqp-divider"></div><div style="text-align:center;padding:4px 0;"><a href="https://github.com/nguyenvancaokyfpt/openfront-helper-userscript" target="_blank" rel="noopener" style="color:var(--oh-accent);font-size:9px;text-decoration:none;opacity:0.7;">⭐ GitHub — OpenFront Helper</a></div>',
    ].join("");
    _bindEvents(el);
    _bindThemeEvents(el);
  }

  // ---- Event binding ----

  function _saveAccordionState() {
    var states = {};
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (!panel) return states;
    // Only save sections in the active tab — other tabs' sections are untouched.
    var tabEl = panel.querySelector(".ohqp-body > div.active");
    if (!tabEl) return states;
    var secs = tabEl.querySelectorAll(".ohqp-sec-h");
    for (let i = 0; i < secs.length; i++) {
      var id = secs[i].dataset.qpSection || ("sec_" + quickPanelActiveTab + "_" + i);
      states[id] = secs[i].classList.contains("open");
    }
    return states;
  }

  function _restoreAccordionState(states) {
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (!panel) return;
    var tabEl = panel.querySelector(".ohqp-body > div.active");
    if (!tabEl) return;
    var secs = tabEl.querySelectorAll(".ohqp-sec-h");
    for (let i = 0; i < secs.length; i++) {
      var id = secs[i].dataset.qpSection || ("sec_" + quickPanelActiveTab + "_" + i);
      if (states[id]) {
        secs[i].classList.add("open");
        const body = secs[i].nextElementSibling;
        if (body) body.classList.add("open");
      } else {
        secs[i].classList.remove("open");
        const body = secs[i].nextElementSibling;
        if (body) body.classList.remove("open");
      }
    }
  }

  function _bindEvents(el) {
    var switches = el.querySelectorAll(".ohqp-sw[data-qp-key]");
    for (let i = 0; i < switches.length; i++) {
      switches[i].addEventListener("click", function(e) {
        e.preventDefault();
        var key = this.dataset.qpKey;
        var cur = _getSetting(key, false);
        _setAndNotify(key, !cur);
        this.classList.toggle("on", !cur);
        // When a parent toggle changes, update disabled state of its child
        // switches immediately (no re-render needed).
        var childSwitches = document.querySelectorAll('.ohqp-sw[data-qp-parent="' + key + '"]');
        for (var ci = 0; ci < childSwitches.length; ci++) {
          childSwitches[ci].classList.toggle("disabled", !cur); // !cur = new parent state
        }
        // Only re-render when the toggle controls sub-toggles that need to
        // show/hide (e.g. parent toggles in the Actions or Helpers tabs).
        // For other toggles, the visual change is enough.
        var needsSubRefresh = (
          key === "combatSiloIndicator" ||
          key === "autoDonateEnabled" || key === "autoDonateGoldEnabled"
        );
        if (needsSubRefresh) {
          _renderActiveTab();
        }
      });
      // Popover on hover for toggle switches
      (function(swEl) {
        swEl.addEventListener("mouseenter", function() {
          var tip = QP_FEATURE_TIPS[this.dataset.qpKey];
          if (tip) {
            _showQpPopover(this, "<b>" + _tr(tip[0]) + "</b><br>" + _tr(tip[1]));
          }
        });
        swEl.addEventListener("mouseleave", _hideQpPopover);
      })(switches[i]);
    }
    // Tip icon hover — "?" next to Helpers tab toggles
    var tipIcons = el.querySelectorAll(".ohqp-tip-icon[data-qp-tip-key]");
    for (let i2 = 0; i2 < tipIcons.length; i2++) {
      (function(icon) {
        icon.addEventListener("mouseenter", function() {
          var tip = QP_FEATURE_TIPS[this.dataset.qpTipKey];
          if (tip) {
            _showQpPopover(this, "<b>" + _tr(tip[0]) + "</b><br>" + _tr(tip[1]));
          }
        });
        icon.addEventListener("mouseleave", _hideQpPopover);
      })(tipIcons[i2]);
    }
    var ranges = el.querySelectorAll("[data-qp-range]");
    for (let i = 0; i < ranges.length; i++) {
      ranges[i].addEventListener("input", function() {
        _setAndNotify(this.dataset.qpRange, Number(this.value));
      });
    }
    var inputs = el.querySelectorAll("[data-qp-input]");
    for (let i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener("change", function() {
        _setAndNotify(this.dataset.qpInput, Number(this.value));
      });
    }
    // String inputs (comma-separated names, etc.)
    var strInputs = el.querySelectorAll("[data-qp-input-str]");
    for (let i = 0; i < strInputs.length; i++) {
      strInputs[i].addEventListener("change", function() {
        _setAndNotify(this.dataset.qpInputStr, this.value);
      });
    }
    var selects = el.querySelectorAll("[data-qp-select]");
    for (let i = 0; i < selects.length; i++) {
      selects[i].addEventListener("change", function() {
        _setAndNotify(this.dataset.qpSelect, this.value);
      });
    }
    // Action buttons
    var btns = el.querySelectorAll("[data-qp-action]");
    for (let i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function() {
        _handleAction(this.dataset.qpAction);
      });
      // Popover on hover for action buttons
      (function(btnEl) {
        btnEl.addEventListener("mouseenter", function() {
          var tip = QP_FEATURE_TIPS[this.dataset.qpAction];
          if (tip) {
            _showQpPopover(this, "<b>" + _tr(tip[0]) + "</b><br>" + _tr(tip[1]));
          }
        });
        btnEl.addEventListener("mouseleave", _hideQpPopover);
      })(btns[i]);
    }
    // Section accordions — match ALL section headers, not just Helpers tab.
    var secs = el.querySelectorAll(".ohqp-sec-h");
    for (let i = 0; i < secs.length; i++) {
      secs[i].addEventListener("click", function() {
        this.classList.toggle("open");
        var body = this.nextElementSibling;
        if (body) body.classList.toggle("open");
        if (this.dataset.qpSection) {
          _setAndNotify("collapsedHelperCategories." + this.dataset.qpSection, !this.classList.contains("open"));
        }
      });
    }
    // Language dropdown.
    var langBtn = el.querySelector(".ohqp-lang-btn");
    var langMenu = el.querySelector(".ohqp-lang-menu");
    if (langBtn && langMenu) {
      langBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        var open = langMenu.style.display === "block";
        langMenu.style.display = open ? "none" : "block";
      });
      var langItems = langMenu.querySelectorAll("[data-qp-lang]");
      for (let j = 0; j < langItems.length; j++) {
        langItems[j].addEventListener("click", function(e) {
          e.stopPropagation();
          var lang = this.dataset.qpLang;
          langMenu.style.display = "none";
          // Force re-render Config tab with new language BEFORE notifying
          // (setQuickPanelSettings only re-renders if language changed,
          //  but we need the dropdown text to update immediately)
          _setAndNotify("language", lang);
          // Re-render the active tab now so dropdown shows new language
          setTimeout(function() { _renderActiveTab(); }, 50);
        });
      }
    }
    // Close dropdown on outside click.
    if (!_langDropdownCloseBound) {
      _langDropdownCloseBound = true;
      document.addEventListener("click", function() {
        var menu = document.getElementById("ohqp-lang-menu");
        if (menu) menu.style.display = "none";
      });
    }
  }

  // ---- WS Actions ----

  function _toast(msg, color) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9000;padding:8px 16px;border-radius:6px;font:700 13px/1.3 'Aptos','Trebuchet MS',sans-serif;color:#fff;background:" + (color || "rgba(0,180,80,0.92)") + ";box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;opacity:1;transition:opacity 0.4s;";
    document.body.appendChild(t);
    setTimeout(function() { t.style.opacity = "0"; }, 1200);
    setTimeout(function() { t.remove(); }, 1700);
  }

  function _handleAction(action) {
    switch (action) {
      case "setKillShotHotkey":
        _startHotkeyCapture("killShotHotkey");
        break;
      case "setAtomHotkey":
        _startHotkeyCapture("atomBatchHotkey");
        break;
      case "resetAllSettings":
        _resetAllSettings();
        break;
      case "killShot":
        _doKillShot();
        break;
      case "embargoAll":
        if (typeof sendGamePacket === "function") {
          sendGamePacket({ type: "embargo_all", action: "start" });
          _toast("🚫 " + _tr("Embargo All") + " ✓");
        } else {
          _toast("✗ WS not connected", "rgba(220,40,40,0.92)");
        }
        break;
      case "liftEmbargo":
        if (typeof sendGamePacket === "function") {
          sendGamePacket({ type: "embargo_all", action: "stop" });
          _toast("✅ " + _tr("Trade All") + " ✓");
        } else {
          _toast("✗ WS not connected", "rgba(220,40,40,0.92)");
        }
        break;
    }
  }

  // Track mouse position for kill shot (tile under cursor, not last click)
  var _ksMouseX = 0, _ksMouseY = 0;
  document.addEventListener("mousemove", function(e) { _ksMouseX = e.clientX; _ksMouseY = e.clientY; });

  function _getTileUnderCursor() {
    {
      var ctx = getOpenFrontGameContext();
      if (!ctx || !ctx.transform) return null;
      var w = ctx.transform.screenToWorldCoordinates(_ksMouseX, _ksMouseY);
      if (!w) return null;
      var x = Math.floor(w.x);
      var y = Math.floor(w.y);
      var game = ctx.game;
      if (typeof game.ref === "function") return game.ref(x, y);
    }
    return null;
  }

  function _getPlayerId(player) {
    {
      return typeof player?.id === "function" ? player.id() : null;
    }
  }

  function _getPlayerTroops(player) {
    {
      return Number(typeof player?.troops === "function" ? player.troops() : 0);
    }
  }

  function _discoverAttackConstructor() {
    if (typeof discoverCtors !== "function") return null;
    const eventBus = typeof getEventBus === "function" ? getEventBus() : null;
    return discoverCtors(eventBus)?.attack ?? null;
  }

  function _sendKillShotAttack(targetId, troops) {
    const attackConstructor = _discoverAttackConstructor();
    if (attackConstructor && typeof emitIntent === "function") {
      if (emitIntent(attackConstructor, targetId, troops)) return true;
    }
    if (typeof sendGamePacket !== "function") return false;
    return sendGamePacket({ type: "attack", targetID: String(targetId), troops });
  }

  function _getKillShotTarget(game, tile) {
    {
      return typeof game.owner === "function" ? game.owner(tile) : null;
    }
  }

  function _sendKillShotForTroops(target, myTroops, enemyTroops) {
    const targetId = _getPlayerId(target);
    const troops = enemyTroops <= 0
      ? Math.floor(myTroops * 0.1)
      : Math.max(1, Math.floor(myTroops * Math.min(100,
        Math.max(1, Math.ceil(Math.ceil(enemyTroops * 1.1) / myTroops * 100))) / 100));
    const sent = _sendKillShotAttack(targetId, troops);
    if (!sent) {
      _toast("✗ " + _tr("Failed to send"), "rgba(220,40,40,0.92)");
      return;
    }
    const suffix = enemyTroops <= 0
      ? "conquer"
      : `${Math.max(1, Math.floor(troops / 10)).toLocaleString()} troops`;
    _toast(`☄️ Kill Shot → ${suffix}`);
  }

  function _doKillShot() {
    // Get tile under cursor (realtime), fallback to last known tile
    var tile = _getTileUnderCursor();
    if (tile == null && getLastKnownTile) tile = getLastKnownTile();
    if (tile == null) {
      _toast("✗ " + _tr("No target selected"), "rgba(220,40,40,0.92)");
      return;
    }
    {
      var ctx = getOpenFrontGameContext();
      if (!ctx || !ctx.game) {
        _toast("✗ " + _tr("No game state"), "rgba(220,40,40,0.92)");
        return;
      }
      const game = ctx.game;
      const me = typeof game.myPlayer === "function" ? game.myPlayer() : null;
      if (!me) { _toast("✗ Not in game", "rgba(220,40,40,0.92)"); return; }
      const target = _getKillShotTarget(game, tile);
      if (!target) {
        _toast("✗ " + _tr("No enemy at tile"), "rgba(220,40,40,0.92)");
        return;
      }
      const myId = _getPlayerId(me);
      const targetId = _getPlayerId(target);
      if (myId != null && targetId != null && String(myId) === String(targetId)) {
        _toast("✗ " + _tr("That's your tile"), "rgba(220,40,40,0.92)");
        return;
      }
      const myTroops = _getPlayerTroops(me);
      const enemyTroops = _getPlayerTroops(target);
      if (myTroops <= 0) { _toast("✗ " + _tr("No troops"), "rgba(220,40,40,0.92)"); return; }
      _sendKillShotForTroops(target, myTroops, enemyTroops);
    }
  }

  function _setGameAttackRatio(pct) {
    {
      var sliders = document.querySelectorAll('control-panel input[type="range"]');
      for (let i = 0; i < sliders.length; i++) {
        sliders[i].value = String(pct);
        sliders[i].valueAsNumber = pct;
        sliders[i].dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        sliders[i].dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
    }
  }

  // ---- Lifecycle ----

  // Toggle with animation (inspired by CourseraHelperEx)
  var _qpInTransition = false;

  function _getLauncherRect() {
    var icon = document.getElementById("openfront-helper-launcher");
    if (!icon) return null;
    return icon.getBoundingClientRect();
  }

  function _setOriginToLauncher(panel) {
    var lr = _getLauncherRect();
    if (!lr) return;
    var pr = panel.getBoundingClientRect();
    var cx = lr.left + lr.width / 2;
    var cy = lr.top + lr.height / 2;
    panel.style.transformOrigin = (cx - pr.left) + "px " + (cy - pr.top) + "px";
  }

  // Smart placement — ported from CourseraHelperEx placePanel().
  // Positions panel next to launcher icon, choosing the side with most space.
  // NEVER covers the icon.
  function _placePanel(panel) {
    var lr = _getLauncherRect();
    if (!lr) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 10;
    var gap = 12;
    var pw = panel.offsetWidth || 270;
    var ph = panel.offsetHeight || 400;
    var bcx = lr.left + lr.width / 2;
    var bcy = lr.top + lr.height / 2;
    var fitsBelow = lr.bottom + gap + ph <= vh - margin;
    var fitsAbove = lr.top - gap - ph >= margin;

    var left, top;
    if (fitsBelow || fitsAbove) {
      // Vertical: prefer below if fits & icon in top half, otherwise above
      var openDown = fitsBelow && (!fitsAbove || bcy < vh / 2);
      const openRight = bcx < vw / 2; // icon on left half → align left edge
      left = openRight ? lr.left : lr.right - pw;
      top = openDown ? lr.bottom + gap : lr.top - gap - ph;
    } else {
      // Panel too tall for above/below → place BESIDE icon
      var roomRight = vw - lr.right - gap - margin;
      var roomLeft = lr.left - gap - margin;
      let openRight = roomRight >= roomLeft;
      if (roomRight >= pw) openRight = true;
      else if (roomLeft >= pw) openRight = false;
      left = openRight ? lr.right + gap : lr.left - pw - gap;
      top = bcy - ph / 2;
    }
    // Clamp within viewport
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - pw - margin));
    top = Math.min(Math.max(margin, top), Math.max(margin, vh - ph - margin));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function _animateOpen(panel) {
    if (_qpInTransition) return;
    _qpInTransition = true;
    panel.style.display = "flex";
    panel.style.opacity = "0";
    panel.style.transform = "scale(0.18)";
    panel.dataset.visible = "true";
    // Measure then place (panel needs display:flex to have dimensions)
    _renderActiveTab();
    _themeFromSettings();
    _placePanel(panel);
    _setOriginToLauncher(panel);
    var anim = panel.animate(
      [{ transform: "scale(0.18)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
    );
    anim.onfinish = function() {
      { anim.cancel(); }
      panel.style.transform = "";
      panel.style.opacity = "";
      _qpInTransition = false;
    };
  }

  function _animateClose(panel) {
    if (_qpInTransition) return;
    _qpInTransition = true;
    _setOriginToLauncher(panel);
    var anim = panel.animate(
      [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.18)", opacity: 0 }],
      { duration: 200, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" }
    );
    anim.onfinish = function() {
      panel.style.display = "none";
      panel.dataset.visible = "false";
      runtimeState.quickPanelEnabled = false;
      // Notify lobby so syncQuickPanelHelper won't re-show it
      _notifySettingChanged("showQuickPanel", false);
      { anim.cancel(); }
      panel.style.transform = "";
      panel.style.opacity = "";
      _qpInTransition = false;
    };
  }

  // Listen for toggle event from launcher icon
  window.addEventListener("ofh-toggle-quick-panel", function() {
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (!panel) {
      // First time: create panel then animate open
      runtimeState.quickPanelEnabled = true;
      _notifySettingChanged("showQuickPanel", true);
      ensureQuickPanel();
      var p = document.getElementById(QUICK_PANEL_ID);
      if (p) _animateOpen(p);
      return;
    }
    var isVisible = panel.dataset.visible === "true";
    if (isVisible) {
      _animateClose(panel);
    } else {
      runtimeState.quickPanelEnabled = true;
      _notifySettingChanged("showQuickPanel", true);
      _animateOpen(panel);
    }
  });

  // Reposition panel when launcher icon is dragged
  window.addEventListener("ofh-reposition-quick-panel", function() {
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (!panel || panel.dataset.visible !== "true" || _qpInTransition) return;
    _placePanel(panel);
  });

  function setQuickPanelEnabled(enabled) {
    runtimeState.quickPanelEnabled = Boolean(enabled);
    var panel = document.getElementById(QUICK_PANEL_ID);
    if (!runtimeState.quickPanelEnabled) {
      if (panel && panel.dataset.visible === "true" && !_qpInTransition) _animateClose(panel);
      return;
    }
    ensureQuickPanel();
    panel = document.getElementById(QUICK_PANEL_ID);
    if (panel && panel.dataset.visible !== "true" && !_qpInTransition) {
      _notifySettingChanged("showQuickPanel", true);
      _animateOpen(panel);
    }
  }
