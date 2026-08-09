// Shared page-context runtime, constants, and low-level helpers.

const PAGE_SOURCE = "openfront-autojoin-page";
const EXTENSION_SOURCE = "openfront-autojoin-extension";
const BOT_MARKER_CONTAINER_ID = "openfront-helper-bot-marker-layer";
const BOT_MARKER_STYLE_ID = "openfront-helper-bot-marker-styles";
const ALLY_MARKER_CONTAINER_ID = "openfront-helper-ally-marker-layer";
const ALLY_MARKER_STYLE_ID = "openfront-helper-ally-marker-styles";
const ALLIANCE_REQUEST_PANEL_ID = "openfront-helper-alliance-request-panel";
const ALLIANCE_REQUEST_PANEL_STYLE_ID =
  "openfront-helper-alliance-request-panel-styles";
const ALLIANCE_FOCUS_FLASH_CONTAINER_ID =
  "openfront-helper-alliance-focus-flash-layer";
const ALLIANCE_FOCUS_FLASH_STYLE_ID =
  "openfront-helper-alliance-focus-flash-styles";
const ALLIANCE_FOCUS_FLASH_CANVAS_CLASS =
  "openfront-helper-alliance-focus-flash-canvas";
const ECONOMY_HEATMAP_CONTAINER_ID = "openfront-helper-economy-heatmap-layer";
const ECONOMY_HEATMAP_STYLE_ID = "openfront-helper-economy-heatmap-styles";
const ECONOMY_HEATMAP_CANVAS_CLASS = "openfront-helper-economy-heatmap-canvas";
const EXPORT_PARTNER_HEATMAP_CONTAINER_ID =
  "openfront-helper-export-partner-heatmap-layer";
const EXPORT_PARTNER_HEATMAP_STYLE_ID =
  "openfront-helper-export-partner-heatmap-styles";
const EXPORT_PARTNER_HEATMAP_CANVAS_CLASS =
  "openfront-helper-export-partner-heatmap-canvas";
const HELPER_STATS_CONTAINER_ID = "openfront-helper-stats-container";
const HELPER_STATS_STYLE_ID = "openfront-helper-stats-container-styles";
const GOLD_PER_MINUTE_BADGE_ID = "openfront-helper-gpm-badge";
const GOLD_PER_MINUTE_STYLE_ID = "openfront-helper-gpm-styles";
const TEAM_GOLD_PER_MINUTE_BADGE_ID = "openfront-helper-team-gpm-badge";
const TEAM_GOLD_PER_MINUTE_STYLE_ID = "openfront-helper-team-gpm-styles";
const TOP_GOLD_PER_MINUTE_BADGE_ID = "openfront-helper-top-gpm-badge";
const TOP_GOLD_PER_MINUTE_STYLE_ID = "openfront-helper-top-gpm-styles";
// localStorage keys for user-dragged positions of the gold readouts.
const HELPER_STATS_POS_KEY = "openfront-helper-stats-container-pos";
const TOP_GOLD_PER_MINUTE_POS_KEY = "openfront-helper-top-gpm-pos";
const TRADE_BALANCE_BADGE_ID = "openfront-helper-trade-balance-badge";
const TRADE_BALANCE_STYLE_ID = "openfront-helper-trade-balance-styles";
const NUKE_LANDING_CONTAINER_ID = "openfront-helper-nuke-landing-layer";
const NUKE_LANDING_STYLE_ID = "openfront-helper-nuke-landing-styles";
const BOAT_LANDING_CONTAINER_ID = "openfront-helper-boat-landing-layer";
const BOAT_LANDING_STYLE_ID = "openfront-helper-boat-landing-styles";
const BOAT_PANEL_ID = "openfront-helper-boat-panel";
const BOAT_PANEL_STYLE_ID = "openfront-helper-boat-panel-styles";
const BOAT_ALERT_CONTAINER_ID = "openfront-helper-boat-alert-layer";
const BOAT_ALERT_STYLE_ID = "openfront-helper-boat-alert-styles";
const NUKE_SUGGESTION_CONTAINER_ID = "openfront-helper-nuke-suggestion-layer";
const NUKE_SUGGESTION_STYLE_ID = "openfront-helper-nuke-suggestion-styles";
const NUKE_SUGGESTION_REFRESH_MS = 1800;
const GOLD_PER_MINUTE_SAMPLE_MS = 1000;
const GOLD_PER_MINUTE_RENDER_MS = 250;
const GOLD_PER_MINUTE_WINDOW_MS = 60000;
// Heatmap layers must keep pace with the game canvas while panning, otherwise
// the helper layer visibly lags behind. Capped at ~60 Hz (matches the typical
// rAF cadence); per-frame work is throttled by the cached data path instead.
const ECONOMY_HEATMAP_DRAW_MS = 16;
const EXPORT_PARTNER_HEATMAP_DRAW_MS = 16;
const EXPORT_PARTNER_HEATMAP_SOURCE_CACHE_MS = 500;
const ECONOMY_HEATMAP_DATA_REFRESH_MS = 1000;
const TRADE_BALANCE_RENDER_MS = 250;
const ECONOMY_HEATMAP_VIEWPORT_PADDING = 120;
const ECONOMY_HEATMAP_REVENUE_WINDOW_MS = 180000;
const HEATMAP_REFERENCE_ZOOM = 1.8;
// Team base colors, kept in sync with the game's default theme palette
// (src/client/render/gl/default-theme.json `teamColors` as of v0.32.3). Used as
// a fallback when the live per-player color is unreachable (see getTeamColor /
// getPlayerColor in shared-utils.js). For 8+ teams the game names teams
// "Team 1".."Team N" — not in this map — so getTeamColor derives those from a
// living member's color, or generates a distinct deterministic one.
const TEAM_COLORS = {
  Red: "#eb3333",
  Blue: "#2962ff",
  Teal: "#2bd4bd",
  Purple: "#9234ea",
  Yellow: "#e7b008",
  Orange: "#f97415",
  Green: "#41be52",
  Bot: "#d1cdc7",
  Humans: "#2962ff",
  Nations: "#eb3333",
};

const RUNTIME_EXCEPTION_LIMIT = 200;
const runtimeExceptions = [];
const RUNTIME_EVENT_LIMIT = 500;
const runtimeEvents = [];

function captureRuntimeException(error, source) {
  runtimeExceptions.push({
    at: Date.now(),
    source,
    name: typeof error?.name === "string" ? error.name : "Error",
    message: typeof error?.message === "string" ? error.message : String(error),
    stack: typeof error?.stack === "string" ? error.stack : null,
  });
  if (runtimeExceptions.length > RUNTIME_EXCEPTION_LIMIT) {
    runtimeExceptions.splice(0, runtimeExceptions.length - RUNTIME_EXCEPTION_LIMIT);
  }
}

globalThis.__OFH_CAPTURE_EXCEPTION__ = captureRuntimeException;
globalThis.__OFH_RUNTIME_EXCEPTIONS__ = runtimeExceptions;

function runtimeDebugLog(...values) {
  runtimeEvents.push({ at: Date.now(), values });
  if (runtimeEvents.length > RUNTIME_EVENT_LIMIT) {
    runtimeEvents.splice(0, runtimeEvents.length - RUNTIME_EVENT_LIMIT);
  }
}

globalThis.__OFH_RUNTIME_EVENTS__ = runtimeEvents;

// Mutable state shared by the concatenated in-game modules. Keeping these
// values behind one explicit object prevents later classic scripts from
// assigning to another file's lexical binding.
const runtimeState = Object.create(null);

// Small compatibility layer for values that belong to the game rather than to
// helper policy. The client and the auto-bot adapter expose the same Config
// object, but older clients used a few different access paths. Keeping the
// compatibility reads here makes every fallback auditable in one place.
function ofhGameConfig(game) {
  return typeof game?.config === "function" ? game.config() : null;
}

function ofhGameConfigNumber(game, method, fallback, ...args) {
  const config = ofhGameConfig(game);
  const value = Number(config?.[method]?.(...args));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ofhGameUnitInfo(game, type) {
  const sources = [
    game && typeof game.unitInfo === "function" ? game : null,
    ofhGameConfig(game),
  ];
  for (const source of sources) {
    const info = source?.unitInfo?.(type);
    if (info) return info;
  }
  return null;
}

function ofhGameUnitCost(game, player, type, fallback) {
  const value = Number(ofhGameUnitInfo(game, type)?.cost?.(game, player));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ofhGameConstructionDuration(game, type, fallback) {
  const raw = ofhGameUnitInfo(game, type)?.constructionDuration;
  const value = Number(typeof raw === "function" ? raw() : raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ofhGameNukeMagnitude(game, type, fallback) {
  const config = ofhGameConfig(game);
  const magnitude = config?.nukeMagnitudes?.(type);
  const inner = Number(magnitude?.inner);
  const outer = Number(magnitude?.outer);
  if (Number.isFinite(inner) && Number.isFinite(outer) && outer > 0) {
    return { inner, outer };
  }
  return fallback;
}

function ofhGameNukeSpeed(game, type = "Atom Bomb", fallback = 10) {
  const config = ofhGameConfig(game);
  const specific = Number(config?.nukeSpeed?.(type));
  if (Number.isFinite(specific) && specific > 0) return specific;
  const defaultSpeed = Number(config?.defaultNukeSpeed?.());
  return Number.isFinite(defaultSpeed) && defaultSpeed > 0 ? defaultSpeed : fallback;
}

function ofhGameCooldownTicks(game, type, fallback = 90) {
  const method = type === "SAM Launcher" ? "SAMCooldown" : "SiloCooldown";
  return ofhGameConfigNumber(game, method, fallback);
}

function ofhGameDonationCooldownMs(game, fallback = 10000) {
  const ticks = ofhGameConfigNumber(game, "donateCooldown", fallback / 100);
  const msPerTick = ofhGameMsPerTick(game, 100);
  return ticks * msPerTick;
}

function ofhGameMsPerTick(game, fallback = 100) {
  return ofhGameConfigNumber(game, "msPerTick", fallback);
}

function ofhGameNukeTargetableRange(game, fallback = 150) {
  return ofhGameConfigNumber(game, "defaultNukeTargetableRange", fallback);
}

function ofhGameSamMissileSpeed(game, fallback = 12) {
  return ofhGameConfigNumber(game, "defaultSamMissileSpeed", fallback);
}

function ofhGameSamRange(game, level, fallback = 70) {
  const config = ofhGameConfig(game);
  const range = Number(config?.samRange?.(level));
  if (Number.isFinite(range) && range > 0) return range;
  return ofhGameConfigNumber(game, "defaultSamRange", fallback);
}

function ofhGameMaxSamRange(game, fallback = 150) {
  return ofhGameConfigNumber(game, "maxSamRange", fallback);
}

runtimeState.botMarkersEnabled = false;
runtimeState.botMarkerAnimationFrame = null;
runtimeState.allyMarkersEnabled = false;
runtimeState.allyMarkerAnimationFrame = null;
runtimeState.allianceRequestsPanelEnabled = false;
runtimeState.allianceRequestsPanelAnimationFrame = null;
runtimeState.allianceFocusFlashAnimationFrame = null;
runtimeState.goldPerMinuteEnabled = false;
runtimeState.goldPerMinuteInterval = null;
runtimeState.goldPerMinuteAnimationFrame = null;
runtimeState.lastGoldPerMinuteSampleAt = 0;
runtimeState.lastGoldPerMinuteRenderAt = 0;
runtimeState.goldPerMinuteRenderSignature = "";
runtimeState.lastProcessedIncomingGoldTransferTick = null;
runtimeState.teamGoldPerMinuteEnabled = false;
runtimeState.teamGoldPerMinuteAnimationFrame = null;
runtimeState.lastTeamGoldPerMinuteRenderAt = 0;
runtimeState.teamGoldPerMinuteRenderSignature = "";
runtimeState.topGoldPerMinuteEnabled = false;
runtimeState.topGoldPerMinuteAnimationFrame = null;
runtimeState.lastTopGoldPerMinuteRenderAt = 0;
runtimeState.tradeBalancesEnabled = false;
runtimeState.tradeBalanceAnimationFrame = null;
runtimeState.lastProcessedTradeBalanceTick = null;
runtimeState.lastTradeBalanceRenderAt = 0;
runtimeState.tradeBalanceRenderSignature = "";
runtimeState.nukePredictionEnabled = false;
// Sub-toggle of nuke prediction: the flight-path (trajectory) line. Default on.
runtimeState.nukeTrajectoryEnabled = true;
runtimeState.nukeLandingAnimationFrame = null;
runtimeState.boatPredictionEnabled = false;
runtimeState.boatPredictionAlwaysOwnRoutes = false;
runtimeState.boatPredictionAlwaysTeamRoutes = false;
runtimeState.boatPredictionAlwaysAllyRoutes = false;
runtimeState.boatPredictionAlwaysEnemyRoutes = false;
runtimeState.boatLandingAnimationFrame = null;
// Boat list panel: open state + the boat id the user is hovering in the list.
// The map overlay reads these so a focused boat draws its route/highlight even
// when the prediction overlay itself is off.
runtimeState.boatPanelOpen = false;
runtimeState.boatPanelFocusedId = null;
// Incoming-boat warning: when on, a new transport that targets my territory
// raises a center-screen alert (like the Missile Silo warning). Keeps the scan
// loop alive on its own so it works without the overlay or panel.
runtimeState.boatWarnIncoming = false;
runtimeState.nukeSuggestionsEnabled = false;
runtimeState.nukeSuggestionAnimationFrame = null;
runtimeState.autoNukeEnabled = false;
runtimeState.autoNukePatchTimeout = null;
runtimeState.lastNukeSuggestionComputedAt = 0;
runtimeState.lastNukeSuggestionSignature = "";
runtimeState.lastNukeSuggestionSignatureCheckAt = 0;
runtimeState.currentNukeSuggestionResults = [];
runtimeState.nukeSuggestionTileComputeKey = null;
runtimeState.economyHeatmapEnabled = false;
runtimeState.economyHeatmapAnimationFrame = null;
runtimeState.lastEconomyHeatmapDrawAt = 0;
runtimeState.lastEconomyHeatmapDataAt = 0;
runtimeState.economyHeatmapDataGame = null;
runtimeState.economyHeatmapSources = [];
runtimeState.economyHeatmapIntensity = 1;
runtimeState.exportPartnerHeatmapEnabled = false;
runtimeState.exportPartnerHeatmapAnimationFrame = null;
runtimeState.lastExportPartnerHeatmapDrawAt = 0;
runtimeState.exportPartnerHeatmapSourceCacheGame = null;
runtimeState.exportPartnerHeatmapSourceCachePlayerId = null;
runtimeState.exportPartnerHeatmapSourceCacheAt = 0;
runtimeState.exportPartnerHeatmapSourceCache = [];
runtimeState.selectiveTradePolicyEnabled = false;
runtimeState.selectiveTradePolicyNeedsEmbargoSync = false;
runtimeState.selectiveTradePolicyMyPlayerId = null;
runtimeState.lastSelectiveTradePolicyRequestAt = null;
runtimeState.lastReportedSelectiveTradePolicyAvailability = null;
runtimeState.lastReportedCheatsAvailability = null;
runtimeState.lastOpenFrontGameContext = null;

// Game-time alert: one-shot center-screen notice at a configurable match time.
const GAME_TIME_ALERT_CONTAINER_ID = "openfront-helper-game-time-alert-layer";
const GAME_TIME_ALERT_STYLE_ID = "openfront-helper-game-time-alert-styles";
runtimeState.gameTimeAlertEnabled = false;
runtimeState.gameTimeAlertThresholdSec = 300;
runtimeState.gameTimeAlertInterval = null;
runtimeState.gameTimeAlertFired = false;
runtimeState.gameTimeAlertLastGame = null;

// Master gate for all per-player on-map overlays (troop/threat/money). Defaults
// on so overlays enabled via settings show before the first sync arrives.
runtimeState.playerMapOverlaysEnabled = true;
// Per-player on-map overlay (troop counts) — first layer on the shared scheduler.
runtimeState.mapTroopCountsEnabled = false;
// Per-player threat marks (☢ nuke-capable, weak/danger dots) on the same layer.
runtimeState.threatIndicatorsEnabled = false;
// Per-player gold readout on the same layer.
runtimeState.mapMoneyEnabled = false;
// Attack-highlight overlay (who is attacking you) — its own scheduler layer.
runtimeState.attackHighlightEnabled = false;
// Advisor panel (manual-play HUD): economy state, expansion advice, top threats.
const ADVISOR_PANEL_ID = "openfront-helper-advisor-panel";
const ADVISOR_PANEL_STYLE_ID = "openfront-helper-advisor-panel-styles";
const ADVISOR_PANEL_POS_KEY = "openfront-helper-advisor-panel-pos";
runtimeState.advisorPanelEnabled = false;
runtimeState.advisorRenderSignature = "";

// Quick Panel — compact tabbed floating control panel for fast settings + WS actions.
const QUICK_PANEL_ID = "openfront-helper-quick-panel";
const QUICK_PANEL_STYLE_ID = "openfront-helper-quick-panel-styles";
const QUICK_PANEL_POS_KEY = "openfront-helper-quick-panel-pos";
runtimeState.quickPanelEnabled = false;

// Retaliation HUD: semi-auto nuke counter-attack confirmation card.
const RETALIATION_CONTAINER_ID = "openfront-helper-retaliation-layer";
const RETALIATION_STYLE_ID = "openfront-helper-retaliation-styles";
runtimeState.retaliationEnabled = false;
runtimeState.retaliationInterval = null;

// Hide ads: CSS injection.
const HIDE_ADS_STYLE_ID = "openfront-helper-hide-ads-style";
// Attack-ratio hotkey: Shift+1..0 set attack ratio 10%..100%.
runtimeState.attackRatioHotkeyEnabled = false;
// Right-click conquest menu: one-click attack + alliance policy.
const RIGHT_CLICK_MENU_ID = "openfront-helper-right-click-menu";
const RIGHT_CLICK_STYLE_ID = "openfront-helper-right-click-styles";
runtimeState.rightClickMenuEnabled = false;

// Round logger: timeline JSON + combat outcome tracking.
runtimeState.roundLoggerEnabled = false;
// Network logger: hook fetch/XHR metadata.
runtimeState.networkLoggerEnabled = false;

// Build timer overlay: construction countdown + missile cooldown above silos/SAMs.
runtimeState.buildTimerEnabled = false;
// Enemy-intent early warning: WebSocket hook to detect incoming attacks/boats.
runtimeState.enemyIntentEnabled = false;
// Spawn heatmap overlay: colored grid showing spawn quality.
runtimeState.spawnHeatmapEnabled = false;
runtimeState.spawnMarkersEnabled = false;
// Anti-AFK: Web Worker keep-alive for background tabs.
runtimeState.antiAfkEnabled = false;

const goldTrackers = new Map();
const incomingGoldTransfers = new Map();
const tradeBalanceTrackers = new Map();
const exportPartnerSourceTrackers = new Map();
const economyRevenueSourceTrackers = new Map();
const factoryPortSpendTrackers = new Map();
const factoryPortUnitTrackers = new Map();
const trainTradeTrackers = new Map();
const tradeShipSourceTrackers = new Map();
const autoNukeOriginalRootSubMenus = new Map();
const autoNukeOriginalAttackSubMenus = new Map();
const selectiveTradePolicyAllowedPartnerIds = new Set();
const originalPlayerHasEmbargoMethods = new WeakMap();
const allianceRequestsPanelEvents = [];
const capturedAllianceRequestEvents = new WeakSet();
runtimeState.allianceRequestsPanelRenderSignature = "";
// Auto-renew: when on, the alliance requests panel auto-confirms renewal
// prompts (RENEW_ALLIANCE / type 24) so expiring alliances are re-sent without
// a manual click. Persisted in localStorage; the position is saved per drag.
const ALLIANCE_REQUEST_PANEL_POS_KEY =
  "openfront-helper-alliance-request-panel-pos";
const ALLIANCE_REQUEST_PANEL_AUTORENEW_KEY =
  "openfront-helper-alliance-request-autorenew";
runtimeState.allianceRequestsAutoRenewEnabled = (() => {
  {
    return window.localStorage.getItem(ALLIANCE_REQUEST_PANEL_AUTORENEW_KEY) === "1";
  }
})();
const autoRenewedAllianceEvents = new WeakSet();
function postToExtension(type, payload) {
  window.postMessage(
    {
      source: PAGE_SOURCE,
      type,
      payload,
    },
    "*",
  );
}

document.addEventListener("public-lobbies-update", (event) => {
  postToExtension("PUBLIC_LOBBIES_UPDATE", event.detail?.payload ?? null);
});

function toFiniteNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function getUnitLevel(unit) {
  return Math.max(1, toFiniteNumber(unit?.level?.(), 1));
}

function canStationTradeWith(player, otherPlayer) {
  if (!player || !otherPlayer) {
    return false;
  }
  if (getPlayerSmallId(player) === getPlayerSmallId(otherPlayer)) {
    return true;
  }
  return canPlayersTrade(player, otherPlayer);
}

function getHeatmapTypePriority(type) {
  if (type === "Factory") {
    return 4;
  }
  if (type === "Port") {
    return 3;
  }
  if (type === "City") {
    return 2;
  }
  return 1;
}

// Per-array tile index for O(1) merge on repeated insertions.
// Previously this was a linear sources.find(...) per call, which is O(n^2)
// across a full collection and was visible in CPU profiles in late game.
const _economicSourceIndexes = new WeakMap();

function _getEconomicSourceIndex(sources) {
  let byTile = _economicSourceIndexes.get(sources);
  if (byTile) {
    return byTile;
  }
  byTile = new Map();
  for (const source of sources) {
    if (source?.tile != null) {
      byTile.set(String(source.tile), source);
    }
  }
  _economicSourceIndexes.set(sources, byTile);
  return byTile;
}

function addEconomicSource(sources, tile, weight, type = "Industry") {
  if (tile == null || !Number.isFinite(weight) || weight <= 0) {
    return;
  }

  const byTile = _getEconomicSourceIndex(sources);
  const key = String(tile);
  const existing = byTile.get(key);
  if (existing) {
    existing.weight += weight;
    if (getHeatmapTypePriority(type) > getHeatmapTypePriority(existing.type)) {
      existing.type = type;
    }
    return;
  }

  const entry = { tile, weight, type };
  byTile.set(key, entry);
  sources.push(entry);
}

// ---------- Consolidated helper update scheduler ----------
// Replaces 4 self-recursive requestAnimationFrame loops (gold-per-minute,
// team-gpm, top-gpm, trade-balance). Each helper registers a callback and an
// optional cadence. The base timer remains responsive while expensive panels
// can avoid rescanning the full late-game state four times per second.
const HELPER_TICK_INTERVAL_MS = 250;
const _helperTickListeners = new Map();
let _helperTickIntervalId = null;

function _helperTickNow() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function createGameStartNotificationDetector() {
  let currentGame = null;
  let previousSpawnPhase = null;
  let notified = false;

  return {
    observe(game, inSpawnPhase) {
      if (!game || (inSpawnPhase !== true && inSpawnPhase !== false && inSpawnPhase !== null)) {
        return false;
      }

      if (game !== currentGame) {
        currentGame = game;
        previousSpawnPhase = null;
        notified = false;
      }

      const enteredSpawnPhase = inSpawnPhase === true && previousSpawnPhase !== true;
      previousSpawnPhase = inSpawnPhase;

      if (!enteredSpawnPhase || notified) {
        return false;
      }

      notified = true;
      return true;
    },
  };
}

function _runHelperTick() {
  const now = _helperTickNow();
  for (const [listener, registration] of _helperTickListeners) {
    if (now - registration.lastRunAt < registration.intervalMs) {
      continue;
    }
    registration.lastRunAt = now;
    {
      listener();
    }
  }
}

function _ensureHelperTickRunning() {
  if (_helperTickIntervalId !== null) {
    return;
  }
  _helperTickIntervalId = window.setInterval(_runHelperTick, HELPER_TICK_INTERVAL_MS);
}

function registerHelperTickListener(fn, intervalMs = HELPER_TICK_INTERVAL_MS) {
  if (typeof fn !== "function") {
    return;
  }
  const normalizedIntervalMs = Math.max(
    HELPER_TICK_INTERVAL_MS,
    Number.isFinite(Number(intervalMs)) ? Number(intervalMs) : HELPER_TICK_INTERVAL_MS,
  );
  const existing = _helperTickListeners.get(fn);
  if (existing) {
    existing.intervalMs = normalizedIntervalMs;
    return;
  }
  _helperTickListeners.set(fn, {
    intervalMs: normalizedIntervalMs,
    lastRunAt: _helperTickNow(),
  });
  _ensureHelperTickRunning();
  {
    fn();
  }
}

function unregisterHelperTickListener(fn) {
  _helperTickListeners.delete(fn);
  if (_helperTickListeners.size === 0 && _helperTickIntervalId !== null) {
    window.clearInterval(_helperTickIntervalId);
    _helperTickIntervalId = null;
  }
}

// Sync a panel's visibility state back to the Quick Panel. Panel setters call
// this so the Quick Panel toggle reflects the actual state when a panel is
// closed via its own X button (not just the QP toggle).
function _qpSync(settingKey, enabled) {
  {
    window.dispatchEvent(new CustomEvent("ofh-quick-panel-setting", {
      detail: { key: settingKey, value: Boolean(enabled) }
    }));
  }
}
