// Shared content-script state and helper bridge synchronization.

const {
  STORAGE_KEY,
  FILTER_KEYS,
  START_GOLD_FILTER_KEYS,
  MAPS,
  MAP_IDS,
  createDefaultMapFilters,
  normalizeSettings,
  normalizeEconomyHeatmapIntensity,
  getEconomyHeatmapIntensityLabel,
} = globalThis.OpenFrontHelperSettings;
const i18n = globalThis.OpenFrontHelperI18n;

const BRIDGE_SOURCE_PAGE = "openfront-autojoin-page";
const BRIDGE_SOURCE_EXTENSION = "openfront-autojoin-extension";
const FLOATING_HELPERS_PANEL_ID = "openfront-helper-floating-helpers-panel";
const FLOATING_HELPERS_STYLE_ID = "openfront-helper-floating-helpers-styles";
const FLOATING_AUTOJOIN_PANEL_ID = "openfront-helper-floating-autojoin-panel";
const FLOATING_AUTOJOIN_STYLE_ID = "openfront-helper-floating-autojoin-styles";
const JOIN_ATTEMPT_TIMEOUT_MS = 12000;
const LOBBY_RETRY_COOLDOWN_MS = 30000;
// After we stop being "occupied" (public-lobby waiting modal / game-start
// loading / live game), the search stays paused until it has been continuously
// un-occupied for this long. This is a SIGNAL-INDEPENDENT backstop for the brief
// game-start window where none of the DOM "occupied" signals are true yet (the
// waiting modal already closed, in-game class / live URL not set yet): a
// transient false reading can't outlast the grace, so we never fire a spurious
// join into a different lobby while the chosen game is starting. Tune from the
// `[autojoin-diag]` console log's `sinceOccupiedMs` if a real loading screen ever
// exceeds it.
const RESUME_GRACE_MS = 6000;
// Bump on any auto-join logic change. Printed in the `[autojoin-diag]` log so a
// single reproduction proves the running userscript is the freshly-built one —
// rules out "fix still fails" actually being a stale Tampermonkey install.
const AUTOJOIN_DIAG_BUILD = "aj-debounce-v1";
const PREFERRED_GROUP_ORDER = ["special", "ffa", "team"];

const lobbyCooldowns = new Map();

const lobbyState = {
  settings: normalizeSettings(),
  latestLobbySnapshot: null,
  pendingJoin: null,
  pendingGameStartNotification: null,
  sawLobbyWaitingBeforeGameStart: false,
  wasOccupied: false,
  lastOccupiedAt: 0,
  lastJoinRequestedAt: 0,
  joinAlertAudio: null,
  customJoinAlertAudio: null,
  hasCustomNotificationSound: false,
  customNotificationSoundData: null,
  selectiveTradePolicyAvailable: false,
};
// "Keep searching after joining": searching is paused whenever we're "occupied"
// (in the public-lobby waiting modal OR in an active game) and resumes when we
// return to the menu — whether the game ended or the user backed out of the
// lobby. lobbyState.wasOccupied tracks the previous tick to detect that return edge.
// Timestamp (ms) we last OBSERVED an "occupied" state, and when we last fired a
// join request. Drive the resume/join debounce (RESUME_GRACE_MS) and the
// `[autojoin-diag]` log; 0 means "never yet" so cold-start searching isn't
// delayed.
let lastProcessedSelectiveTradePolicyRequestAt = null;
let translations = i18n?.DEFAULT_TRANSLATIONS || {};

// Shared lobbyState.settings, defaults, and filter normalization live in `shared/lobbyState.settings.js`
// so popup and content stay in sync.

function t(key) {
  return i18n?.getMessage(translations, key) || key;
}

async function loadContentTranslations() {
  if (!i18n) {
    return;
  }
  translations = await i18n.loadBundle(lobbyState.settings.language);
}

// Helper bridge sync -------------------------------------------------------
function syncBotNationMarkers() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "MARK_BOT_NATIONS_RED",
      payload: {
        enabled: Boolean(lobbyState.settings.markBotNationsRed),
      },
    },
    "*",
  );
}

function syncGoldPerMinuteHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_GOLD_PER_MINUTE",
      payload: {
        enabled: Boolean(lobbyState.settings.showGoldPerMinute),
      },
    },
    "*",
  );
}

function syncCompanionHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_COMPANION",
      payload: {
        panel: Boolean(lobbyState.settings.showCompanionPanel),
        enabled: Boolean(lobbyState.settings.companionEnabled),
      },
    },
    "*",
  );
}

function syncTopGoldPerMinuteHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_TOP_GOLD_PER_MINUTE",
      payload: {
        enabled: Boolean(lobbyState.settings.showTopGoldPerMinute),
      },
    },
    "*",
  );
}

function syncTeamBuildStatsHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_TEAM_BUILD_STATS",
      payload: {
        enabled: Boolean(lobbyState.settings.showTeamBuildStats),
      },
    },
    "*",
  );
}

function syncHoveredAlliesHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "MARK_HOVERED_ALLIES_GREEN",
      payload: {
        enabled: Boolean(lobbyState.settings.markHoveredAlliesGreen),
      },
    },
    "*",
  );
}

function syncAllianceRequestsPanelHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_ALLIANCE_REQUESTS_PANEL",
      payload: {
        enabled: Boolean(lobbyState.settings.showAllianceRequestsPanel),
      },
    },
    "*",
  );
}

function syncTradeBalancesHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_TRADE_BALANCES",
      payload: {
        enabled: Boolean(lobbyState.settings.showTradeBalances),
      },
    },
    "*",
  );
}


function syncHelperUsersHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_HELPER_USERS",
      payload: {
        enabled: Boolean(lobbyState.settings.showHelperUsers),
      },
    },
    "*",
  );
}

function syncSosDefenseHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_SOS_DEFENSE",
      payload: {
        enabled: Boolean(lobbyState.settings.sosDefense),
      },
    },
    "*",
  );
}

function syncNukePredictionHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_NUKE_PREDICTION",
      payload: {
        enabled: Boolean(lobbyState.settings.showNukePrediction),
        trajectory: Boolean(lobbyState.settings.showNukeTrajectory),
      },
    },
    "*",
  );
}

function syncGameTimeAlertHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_GAME_TIME_ALERT",
      payload: {
        enabled: Boolean(lobbyState.settings.showGameTimeAlert),
        thresholdSec: Number(lobbyState.settings.gameTimeAlertThresholdSec) || 300,
      },
    },
    "*",
  );
}

function syncPlayerMapOverlaysHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_PLAYER_MAP_OVERLAYS",
      payload: {
        enabled: Boolean(lobbyState.settings.showPlayerMapOverlays),
      },
    },
    "*",
  );
}

function syncMapTroopCountsHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_MAP_TROOP_COUNTS",
      payload: {
        enabled: Boolean(lobbyState.settings.showMapTroopCounts),
      },
    },
    "*",
  );
}

function syncThreatIndicatorsHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_THREAT_INDICATORS",
      payload: {
        enabled: Boolean(lobbyState.settings.showThreatIndicators),
      },
    },
    "*",
  );
}

function syncMapMoneyHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_MAP_MONEY",
      payload: {
        enabled: Boolean(lobbyState.settings.showMapMoney),
      },
    },
    "*",
  );
}

function syncAttackHighlightHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_ATTACK_HIGHLIGHT",
      payload: {
        enabled: Boolean(lobbyState.settings.showAttackHighlight),
      },
    },
    "*",
  );
}

function syncAdvisorPanelHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_ADVISOR_PANEL",
      payload: {
        enabled: Boolean(lobbyState.settings.showAdvisorPanel),
      },
    },
    "*",
  );
}

function syncRetaliationHudHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_RETALIATION_HUD",
      payload: {
        enabled: Boolean(lobbyState.settings.showRetaliationHud),
      },
    },
    "*",
  );
}

function syncHideAdsHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_HIDE_ADS",
      payload: {
        enabled: Boolean(lobbyState.settings.hideAds),
      },
    },
    "*",
  );
}

function syncAntiAfkHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_ANTI_AFK",
      payload: {
        enabled: Boolean(lobbyState.settings.antiAfk),
      },
    },
    "*",
  );
}

function syncAttackRatioHotkeyHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_ATTACK_RATIO_HOTKEY",
      payload: {
        enabled: Boolean(lobbyState.settings.attackRatioHotkey),
      },
    },
    "*",
  );
}

function syncRightClickConquestHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_RIGHT_CLICK_CONQUEST",
      payload: {
        enabled: Boolean(lobbyState.settings.rightClickConquest),
      },
    },
    "*",
  );
}

function syncRoundLoggerHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_ROUND_LOGGER",
      payload: {
        enabled: Boolean(lobbyState.settings.roundLogger),
      },
    },
    "*",
  );
}

function syncNetworkLoggerHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_NETWORK_LOGGER",
      payload: {
        enabled: Boolean(lobbyState.settings.networkLogger),
      },
    },
    "*",
  );
}

function syncBuildTimersHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_BUILD_TIMERS",
      payload: {
        enabled: Boolean(lobbyState.settings.showBuildTimers),
      },
    },
    "*",
  );
}

function syncEnemyIntentHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_ENEMY_INTENT",
      payload: {
        enabled: Boolean(lobbyState.settings.showEnemyIntent),
      },
    },
    "*",
  );
}

function syncSpawnHeatmapHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_SPAWN_HEATMAP",
      payload: {
        enabled: Boolean(lobbyState.settings.showSpawnHeatmap),
      },
    },
    "*",
  );
}

function syncSpawnMarkersHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_SPAWN_MARKERS",
      payload: {
        enabled: Boolean(lobbyState.settings.showSpawnMarkers),
      },
    },
    "*",
  );
}

function syncBoatPredictionHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_BOAT_PREDICTION",
      payload: {
        enabled: Boolean(lobbyState.settings.showBoatPrediction),
        alwaysOwnRoutes: Boolean(lobbyState.settings.alwaysShowOwnBoatRoutes),
        alwaysTeamRoutes: Boolean(lobbyState.settings.alwaysShowTeamBoatRoutes),
        alwaysAllyRoutes: Boolean(lobbyState.settings.alwaysShowAllyBoatRoutes),
        alwaysEnemyRoutes: Boolean(lobbyState.settings.alwaysShowEnemyBoatRoutes),
      },
    },
    "*",
  );
}

function syncWarshipRoutesHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_WARSHIP_ROUTES",
      payload: {
        enabled: Boolean(lobbyState.settings.showWarshipRoutes),
        own: Boolean(lobbyState.settings.showWarshipRoutesOwn),
        team: Boolean(lobbyState.settings.showWarshipRoutesTeam),
        ally: Boolean(lobbyState.settings.showWarshipRoutesAlly),
        enemy: Boolean(lobbyState.settings.showWarshipRoutesEnemy),
      },
    },
    "*",
  );
}

function syncBoatPanelHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_BOAT_PANEL",
      payload: {
        enabled: Boolean(lobbyState.settings.showBoatPanel),
      },
    },
    "*",
  );
}

function syncBoatIncomingWarningHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_BOAT_INCOMING_WARNING",
      payload: {
        enabled: Boolean(lobbyState.settings.warnIncomingBoats),
      },
    },
    "*",
  );
}

function syncEstatePanelHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_ESTATE_PANEL",
      payload: {
        enabled: Boolean(lobbyState.settings.showEstatePanel),
      },
    },
    "*",
  );
}

function syncAutoLeaveOnTeamWinHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_AUTO_LEAVE_ON_TEAM_WIN",
      payload: {
        enabled: Boolean(lobbyState.settings.autoLeaveOnTeamWin),
      },
    },
    "*",
  );
}

function syncNukeSuggestionsHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_NUKE_SUGGESTIONS",
      payload: {
        enabled: Boolean(lobbyState.settings.showNukeSuggestions),
      },
    },
    "*",
  );
}

function syncAutoNukeHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_AUTO_NUKE",
      payload: {
        enabled: Boolean(lobbyState.settings.autoNuke),
        includeAllies: Boolean(lobbyState.settings.autoNukeIncludeAllies),
      },
    },
    "*",
  );
}

function syncSend1PercentBoatHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_SEND_1_PERCENT_BOAT",
      payload: {
        enabled: Boolean(lobbyState.settings.send1PercentBoat),
        contextMenu: lobbyState.settings.send1PercentBoatContextMenu !== false,
      },
    },
    "*",
  );
}

function syncEconomyHeatmapHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_ECONOMY_HEATMAP",
      payload: {
        enabled: Boolean(lobbyState.settings.showEconomyHeatmap),
        intensity: lobbyState.settings.economyHeatmapIntensity,
      },
    },
    "*",
  );
}

function syncExportPartnerHeatmapHelper() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_EXPORT_PARTNER_HEATMAP",
      payload: {
        enabled: Boolean(lobbyState.settings.showExportPartnerHeatmap),
      },
    },
    "*",
  );
}

function syncQuickPanelHelper() {
  // Only sync if showQuickPanel is explicitly set — don't auto-hide on first load
  if (lobbyState.settings.showQuickPanel == null) return;
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SHOW_QUICK_PANEL",
      payload: {
        enabled: Boolean(lobbyState.settings.showQuickPanel),
      },
    },
    "*",
  );
}

function syncQuickPanelSettings() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SYNC_QUICK_PANEL_SETTINGS",
      payload: {
        settings: lobbyState.settings,
      },
    },
    "*",
  );
}

// Listen for setting changes from the Quick Panel (page context).
window.addEventListener("ofh-quick-panel-setting", function(e) {
  if (!e.detail || !e.detail.key) return;
  var key = e.detail.key;
  var value = e.detail.value;
  // Guard: skip if value unchanged (prevents feedback loop from panel self-close).
  if (key in lobbyState.settings && lobbyState.settings[key] === value) return;
  if (key.indexOf("collapsedHelperCategories.") === 0) {
    var catKey = key.split(".")[1];
    lobbyState.settings.collapsedHelperCategories = lobbyState.settings.collapsedHelperCategories || {};
    lobbyState.settings.collapsedHelperCategories[catKey] = value;
  } else if (key in lobbyState.settings) {
    lobbyState.settings[key] = value;
  }
  lobbyState.settings = normalizeSettings(lobbyState.settings);

  if (key === "language") {
    var newLang = value;
    chrome.storage.local.set({ [STORAGE_KEY]: lobbyState.settings });
    if (i18n) {
      i18n.loadBundle(newLang).then(function(bundle) {
        translations = bundle;
        window.postMessage({
          source: BRIDGE_SOURCE_EXTENSION,
          type: "SET_AUTO_BOT_I18N",
          payload: { language: newLang, bundle: bundle },
        }, "*");
        window.postMessage({
          source: BRIDGE_SOURCE_EXTENSION,
          type: "RELOCALIZE_PANELS",
          payload: {},
        }, "*");
        syncQuickPanelSettings();
        var ajPanel = document.getElementById(FLOATING_AUTOJOIN_PANEL_ID);
        if (ajPanel) ajPanel.remove();
        syncFloatingAutoJoinPanel();
      });
    }
  } else {
    chrome.storage.local.set({ [STORAGE_KEY]: lobbyState.settings });
    syncHelpers();
    if (key === "showFloatingAutoJoinPanel") {
      syncFloatingAutoJoinPanel();
      syncQuickPanelSettings();
    }
    if (key === "showAutoBotPanel") {
      syncQuickPanelSettings();
    }
    if (key === "showCompanionPanel" || key === "companionEnabled") {
      syncQuickPanelSettings();
    }
  }
});


// The auto-bot runs in the page context and can't load locale bundles itself,
// so we forward the bundle for the current language. Posted unconditionally
// (like every other helper sync) so the post-injection syncHelpers() reliably
// delivers it once the bridge is listening; the page side only rebuilds its
// panel when the language actually changes, so repeated posts are cheap no-ops.
function syncAutoBotI18n() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_AUTO_BOT_I18N",
      payload: {
        language: lobbyState.settings.language,
        bundle: translations,
      },
    },
    "*",
  );
}

function syncSelectiveTradePolicyToggle() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "SET_SELECTIVE_TRADE_POLICY",
      payload: {
        enabled: Boolean(lobbyState.settings.selectiveTradePolicyEnabled),
      },
    },
    "*",
  );
}

function updateAutoCancelDeniedTradesAvailability(available) {
  const nextAvailable = Boolean(available);
  const availabilityChanged =
    nextAvailable !== lobbyState.selectiveTradePolicyAvailable ||
    nextAvailable !== Boolean(lobbyState.settings.autoCancelDeniedTradesAvailable);

  lobbyState.selectiveTradePolicyAvailable = nextAvailable;

  if (availabilityChanged) {
    saveSettings({
      ...lobbyState.settings,
      autoCancelDeniedTradesAvailable: nextAvailable,
      selectiveTradePolicyEnabled:
        lobbyState.settings.selectiveTradePolicyEnabled && nextAvailable,
    });
  }

  syncFloatingHelpersPanel();
  syncFloatingAutoJoinPanel();
}

function syncHelpers() {
  syncBotNationMarkers();
  syncGoldPerMinuteHelper();
  syncTopGoldPerMinuteHelper();
  syncTeamBuildStatsHelper();
  syncHoveredAlliesHelper();
  syncAllianceRequestsPanelHelper();
  syncTradeBalancesHelper();
  syncHelperUsersHelper();
  syncSosDefenseHelper();
  syncGameTimeAlertHelper();
  syncPlayerMapOverlaysHelper();
  syncMapTroopCountsHelper();
  syncThreatIndicatorsHelper();
  syncMapMoneyHelper();
  syncAttackHighlightHelper();
  syncAdvisorPanelHelper();
  syncRetaliationHudHelper();
  syncHideAdsHelper();
  syncAntiAfkHelper();
  syncAttackRatioHotkeyHelper();
  syncRightClickConquestHelper();
  syncRoundLoggerHelper();
  syncNetworkLoggerHelper();
  syncBuildTimersHelper();
  syncEnemyIntentHelper();
  syncSpawnHeatmapHelper();
  syncSpawnMarkersHelper();
  syncSelectiveTradePolicyToggle();
  syncAutoBotI18n();
  syncNukePredictionHelper();
  syncBoatPredictionHelper();
  syncWarshipRoutesHelper();
  syncBoatPanelHelper();
  syncBoatIncomingWarningHelper();
  syncEstatePanelHelper();
  syncAutoLeaveOnTeamWinHelper();
  syncNukeSuggestionsHelper();
  syncAutoNukeHelper();
  syncSend1PercentBoatHelper();
  syncEconomyHeatmapHelper();
  syncExportPartnerHeatmapHelper();
  syncQuickPanelHelper();
  syncCompanionHelper();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  lobbyState.settings = normalizeSettings(stored[STORAGE_KEY]);
  await loadContentTranslations();
  lobbyState.selectiveTradePolicyAvailable = Boolean(lobbyState.settings.autoCancelDeniedTradesAvailable);
  lastProcessedSelectiveTradePolicyRequestAt =
    lobbyState.settings.applySelectiveTradePolicyRequestAt;
  syncHelpers();
  syncQuickPanelSettings();
  syncFloatingHelpersPanel();
  syncFloatingAutoJoinPanel();
}

async function saveSettings(nextSettings) {
  lobbyState.settings = normalizeSettings(nextSettings);
  await chrome.storage.local.set({
    [STORAGE_KEY]: lobbyState.settings,
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPENFRONT_HELPER_PING") {
    sendResponse({
      ok: true,
      source: "openfront-helper-content",
    });
  }
});
