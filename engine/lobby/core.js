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
const PREFERRED_GROUP_ORDER = ["special", "ffa", "team"];

const lobbyCooldowns = new Map();

let settings = normalizeSettings();
let latestLobbySnapshot = null;
let pendingJoin = null;
let joinAlertAudio = null;
let customJoinAlertAudio = null;
let hasCustomNotificationSound = false;
let customNotificationSoundData = null;
let lastProcessedSelectiveTradePolicyRequestAt = null;
let selectiveTradePolicyAvailable = false;
let cheatsAvailable = false;
let translations = i18n?.DEFAULT_TRANSLATIONS || {};

// Shared settings, defaults, and filter normalization live in `shared/settings.js`
// so popup and content stay in sync.

function t(key) {
  return i18n?.getMessage(translations, key) || key;
}

async function loadContentTranslations() {
  if (!i18n) {
    return;
  }
  translations = await i18n.loadBundle(settings.language);
}

// Helper bridge sync -------------------------------------------------------
function syncBotNationMarkers() {
  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "MARK_BOT_NATIONS_RED",
      payload: {
        enabled: Boolean(settings.markBotNationsRed),
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
        enabled: Boolean(settings.showGoldPerMinute),
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
        enabled: Boolean(settings.showTopGoldPerMinute),
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
        enabled: Boolean(settings.showTeamBuildStats),
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
        enabled: Boolean(settings.markHoveredAlliesGreen),
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
        enabled: Boolean(settings.showAllianceRequestsPanel),
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
        enabled: Boolean(settings.showTradeBalances),
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
        enabled: Boolean(settings.showNukePrediction),
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
        enabled: Boolean(settings.showBoatPrediction),
        alwaysOwnRoutes: Boolean(settings.alwaysShowOwnBoatRoutes),
        alwaysTeamRoutes: Boolean(settings.alwaysShowTeamBoatRoutes),
        alwaysAllyRoutes: Boolean(settings.alwaysShowAllyBoatRoutes),
        alwaysEnemyRoutes: Boolean(settings.alwaysShowEnemyBoatRoutes),
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
        enabled: Boolean(settings.showBoatPanel),
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
        enabled: Boolean(settings.warnIncomingBoats),
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
        enabled: Boolean(settings.showNukeSuggestions && cheatsAvailable),
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
        enabled: Boolean(settings.autoNuke && cheatsAvailable),
        includeAllies: Boolean(settings.autoNukeIncludeAllies),
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
        enabled: Boolean(settings.send1PercentBoat),
        contextMenu: settings.send1PercentBoatContextMenu !== false,
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
        enabled: Boolean(settings.showEconomyHeatmap),
        intensity: settings.economyHeatmapIntensity,
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
        enabled: Boolean(settings.showExportPartnerHeatmap),
      },
    },
    "*",
  );
}


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
        language: settings.language,
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
        enabled: Boolean(settings.selectiveTradePolicyEnabled),
      },
    },
    "*",
  );
}

function updateAutoCancelDeniedTradesAvailability(available) {
  const nextAvailable = Boolean(available);
  const availabilityChanged =
    nextAvailable !== selectiveTradePolicyAvailable ||
    nextAvailable !== Boolean(settings.autoCancelDeniedTradesAvailable);

  selectiveTradePolicyAvailable = nextAvailable;

  if (availabilityChanged) {
    saveSettings({
      ...settings,
      autoCancelDeniedTradesAvailable: nextAvailable,
      selectiveTradePolicyEnabled:
        settings.selectiveTradePolicyEnabled && nextAvailable,
    }).catch((error) => {
      console.error("Failed to sync denied trade cancellation availability:", error);
    });
  }

  syncFloatingHelpersPanel();
  syncFloatingAutoJoinPanel();
}

function updateCheatsAvailability(available) {
  // Force-enabled for multiplayer testing — nuke suggestion / auto nuke gate
  // on this flag, and public lobbies report cheats unavailable.
  // Original: const nextAvailable = Boolean(available);
  void available;
  const nextAvailable = true;
  const availabilityChanged =
    nextAvailable !== cheatsAvailable ||
    nextAvailable !== Boolean(settings.cheatsAvailable);

  cheatsAvailable = nextAvailable;

  if (availabilityChanged) {
    saveSettings({
      ...settings,
      cheatsAvailable: nextAvailable,
    }).catch((error) => {
      console.error("Failed to sync cheats availability:", error);
    });
  }

  syncHelpers();
}

function syncHelpers() {
  syncBotNationMarkers();
  syncGoldPerMinuteHelper();
  syncTopGoldPerMinuteHelper();
  syncTeamBuildStatsHelper();
  syncHoveredAlliesHelper();
  syncAllianceRequestsPanelHelper();
  syncTradeBalancesHelper();
  syncSelectiveTradePolicyToggle();
  syncAutoBotI18n();
  syncNukePredictionHelper();
  syncBoatPredictionHelper();
  syncBoatPanelHelper();
  syncBoatIncomingWarningHelper();
  syncNukeSuggestionsHelper();
  syncAutoNukeHelper();
  syncSend1PercentBoatHelper();
  syncEconomyHeatmapHelper();
  syncExportPartnerHeatmapHelper();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  settings = normalizeSettings(stored[STORAGE_KEY]);
  await loadContentTranslations();
  selectiveTradePolicyAvailable = Boolean(settings.autoCancelDeniedTradesAvailable);
  // Match updateCheatsAvailability override so cold-start UI sees cheats on.
  cheatsAvailable = true;
  console.info("[openfront-helper] cheats override active");
  // Persist so the popup-ui (which reads settings.cheatsAvailable from
  // chrome.storage) sees the override even before the page-bridge sends its
  // first CHEATS_AVAILABILITY message.
  if (settings.cheatsAvailable !== true) {
    settings.cheatsAvailable = true;
    chrome.storage.local
      .set({ [STORAGE_KEY]: settings })
      .catch((error) => console.error("Failed to persist cheats override:", error));
  }
  lastProcessedSelectiveTradePolicyRequestAt =
    settings.applySelectiveTradePolicyRequestAt;
  syncHelpers();
  syncFloatingHelpersPanel();
  syncFloatingAutoJoinPanel();
}

async function saveSettings(nextSettings) {
  settings = normalizeSettings(nextSettings);
  await chrome.storage.local.set({
    [STORAGE_KEY]: settings,
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
