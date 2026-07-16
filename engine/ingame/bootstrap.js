// Final message routing and bridge startup.

  function joinPublicLobbyFromMessage(data) {
    if (data.payload?.gameID) {
      document.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: {
            gameID: data.payload.gameID,
            source: "public",
            publicLobbyInfo: data.payload.publicLobbyInfo,
          },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  function showSelfGpmHistory(data) {
      if (typeof setSelfGpmHistoryPanelPosition === "function") {
        setSelfGpmHistoryPanelPosition(data.payload?.panelPosition);
      }
      if (typeof setSelfGpmHistoryEnabled === "function") {
        setSelfGpmHistoryEnabled(data.payload?.enabled);
      } else {
        console.error(
          "OpenFront helper: self-gpm-history bridge not loaded (check manifest web_accessible_resources)",
        );
      }
  }

  function showNukePrediction(data) {
    setNukePredictionEnabled(data.payload?.enabled);
    setNukeTrajectoryEnabled(data.payload?.trajectory);
    requestMapOverlayLoop();
  }

  function showBoatPrediction(data) {
    setBoatPredictionEnabled(data.payload?.enabled, {
      alwaysOwnRoutes: data.payload?.alwaysOwnRoutes,
      alwaysTeamRoutes: data.payload?.alwaysTeamRoutes,
      alwaysAllyRoutes: data.payload?.alwaysAllyRoutes,
      alwaysEnemyRoutes: data.payload?.alwaysEnemyRoutes,
    });
  }

  function showWarshipRoutes(data) {
    setWarshipRoutesEnabled(data.payload?.enabled, {
      own: data.payload?.own,
      team: data.payload?.team,
      ally: data.payload?.ally,
      enemy: data.payload?.enemy,
    });
  }

  function showEconomyHeatmap(data) {
      setEconomyHeatmapIntensity(data.payload?.intensity);
      setEconomyHeatmapEnabled(data.payload?.enabled);
  }

  function applySelectiveTradePolicyFromMessage(data) {
    const requestedAt = Number(data.payload?.requestedAt);
    if (Number.isFinite(requestedAt) && requestedAt !== runtimeState.lastSelectiveTradePolicyRequestAt) {
      runtimeState.lastSelectiveTradePolicyRequestAt = requestedAt;
      applySelectiveTradePolicy();
    }
  }

  function setAutoBotI18nFromMessage(data) {
    if (typeof setAutoBotI18n === "function") {
      setAutoBotI18n(data.payload?.language, data.payload?.bundle);
    }
  }

  function showQuickPanelFromMessage(data) {
    if (typeof setQuickPanelEnabled === "function") {
      setQuickPanelEnabled(data.payload?.enabled);
    }
  }

  function syncQuickPanelSettingsFromMessage(data) {
    if (typeof setQuickPanelSettings === "function") {
      setQuickPanelSettings(data.payload?.settings);
    }
  }

  const INGAME_MESSAGE_HANDLERS = {
    JOIN_PUBLIC_LOBBY: joinPublicLobbyFromMessage,
    MARK_BOT_NATIONS_RED: (data) => setBotMarkersEnabled(data.payload?.enabled),
    SHOW_GOLD_PER_MINUTE: (data) => setGoldPerMinuteEnabled(data.payload?.enabled),
    SHOW_TOP_GOLD_PER_MINUTE: (data) => setTopGoldPerMinuteEnabled(data.payload?.enabled),
    SHOW_TEAM_BUILD_STATS: (data) => setTeamBuildStatsEnabled(data.payload?.enabled),
    MARK_HOVERED_ALLIES_GREEN: (data) => setAllyMarkersEnabled(data.payload?.enabled),
    SHOW_ALLIANCE_REQUESTS_PANEL: (data) => setAllianceRequestsPanelEnabled(data.payload?.enabled),
    SHOW_TRADE_BALANCES: (data) => setTradeBalancesEnabled(data.payload?.enabled),
    SHOW_HELPER_USERS: (data) => setHelperUsersEnabled(data.payload?.enabled),
    SET_SOS_DEFENSE: (data) => setSosDefenseEnabled(data.payload?.enabled),
    SHOW_GAME_TIME_ALERT: (data) => setGameTimeAlertEnabled(data.payload?.enabled, data.payload?.thresholdSec),
    SHOW_PLAYER_MAP_OVERLAYS: (data) => setPlayerMapOverlaysEnabled(data.payload?.enabled),
    SHOW_MAP_TROOP_COUNTS: (data) => setMapTroopCountsEnabled(data.payload?.enabled),
    SHOW_THREAT_INDICATORS: (data) => setThreatIndicatorsEnabled(data.payload?.enabled),
    SHOW_MAP_MONEY: (data) => setMapMoneyEnabled(data.payload?.enabled),
    SHOW_ATTACK_HIGHLIGHT: (data) => setAttackHighlightEnabled(data.payload?.enabled),
    SHOW_ADVISOR_PANEL: (data) => setAdvisorPanelEnabled(data.payload?.enabled),
    SHOW_RETALIATION_HUD: (data) => setRetaliationEnabled(data.payload?.enabled),
    SET_HIDE_ADS: (data) => setHideAdsEnabled(data.payload?.enabled),
    SET_ANTI_AFK: (data) => setAntiAfkEnabled(data.payload?.enabled),
    SET_ATTACK_RATIO_HOTKEY: (data) => setAttackRatioHotkeyEnabled(data.payload?.enabled),
    SET_RIGHT_CLICK_CONQUEST: (data) => setRightClickMenuEnabled(data.payload?.enabled),
    SET_ROUND_LOGGER: (data) => setRoundLoggerEnabled(data.payload?.enabled),
    SET_NETWORK_LOGGER: (data) => setNetworkLoggerEnabled(data.payload?.enabled),
    SHOW_BUILD_TIMERS: (data) => setBuildTimerEnabled(data.payload?.enabled),
    SHOW_ENEMY_INTENT: (data) => setEnemyIntentEnabled(data.payload?.enabled),
    SHOW_SPAWN_HEATMAP: (data) => setSpawnHeatmapEnabled(data.payload?.enabled),
    SHOW_SPAWN_MARKERS: (data) => setSpawnMarkersEnabled(data.payload?.enabled),
    SHOW_MY_GPM_HISTORY: showSelfGpmHistory,
    SHOW_NUKE_PREDICTION: showNukePrediction,
    SHOW_BOAT_PREDICTION: showBoatPrediction,
    SHOW_WARSHIP_ROUTES: showWarshipRoutes,
    SHOW_BOAT_PANEL: (data) => setBoatPanelEnabled(data.payload?.enabled),
    SET_BOAT_INCOMING_WARNING: (data) => setBoatIncomingWarningEnabled(data.payload?.enabled),
    SHOW_ESTATE_PANEL: (data) => setEstatePanelEnabled(data.payload?.enabled),
    SET_AUTO_LEAVE_ON_TEAM_WIN: (data) => setAutoLeaveOnTeamWinEnabled(data.payload?.enabled),
    SHOW_NUKE_SUGGESTIONS: (data) => setNukeSuggestionsEnabled(data.payload?.enabled),
    SET_AUTO_NUKE: (data) => setAutoNukeEnabled(data.payload?.enabled, data.payload?.includeAllies),
    SET_SEND_1_PERCENT_BOAT: (data) => setSend1PercentBoatEnabled(data.payload?.enabled, data.payload?.contextMenu !== false),
    SHOW_ECONOMY_HEATMAP: showEconomyHeatmap,
    SHOW_EXPORT_PARTNER_HEATMAP: (data) => setExportPartnerHeatmapEnabled(data.payload?.enabled),
    APPLY_SELECTIVE_TRADE_POLICY: applySelectiveTradePolicyFromMessage,
    SET_SELECTIVE_TRADE_POLICY: (data) => setSelectiveTradePolicyEnabled(Boolean(data.payload?.enabled)),
    SET_AUTO_BOT_I18N: setAutoBotI18nFromMessage,
    SET_COMPANION: (data) => {
      if (typeof setCompanionPanelVisible === "function") {
        setCompanionPanelVisible(Boolean(data.payload?.panel));
      }
      if (typeof setCompanionEnabled === "function") {
        setCompanionEnabled(Boolean(data.payload?.enabled));
      }
    },
    SHOW_QUICK_PANEL: showQuickPanelFromMessage,
    SYNC_QUICK_PANEL_SETTINGS: syncQuickPanelSettingsFromMessage,
    RELOCALIZE_PANELS: () => _relocalizeAllPanels(),
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== EXTENSION_SOURCE) return;
    INGAME_MESSAGE_HANDLERS[data.type]?.(data);
  });

  window.setInterval(() => {
    refreshSelectiveTradePolicyAvailability();
    refreshCheatsAvailability();
    { if (typeof window.__OFH_updateSiloSamTracker === "function") window.__OFH_updateSiloSamTracker(); }{ if (typeof window.__OFH_tickAutoDonate === "function") window.__OFH_tickAutoDonate(); }
  }, 1000);
  refreshSelectiveTradePolicyAvailability();
  refreshCheatsAvailability();

  // Rebuild all visible panels so static text (set once during creation) picks
  // up the new tr() translations after a language change. Each panel setter
  // must remove-and-recreate when called with true while already enabled.
  function _relocalizeAllPanels() {
    // For each panel: disable first (remove), then re-enable (recreate).
    // Auto-bot is handled by setAutoBotI18n already.
    var panels = [
      { enabled: function() { return typeof runtimeState.advisorPanelEnabled !== "undefined" && runtimeState.advisorPanelEnabled; }, set: function(v) { if (typeof setAdvisorPanelEnabled === "function") setAdvisorPanelEnabled(v); } },
      { enabled: function() { return typeof runtimeState.goldPerMinuteEnabled !== "undefined" && runtimeState.goldPerMinuteEnabled; }, set: function(v) { if (typeof setGoldPerMinuteEnabled === "function") setGoldPerMinuteEnabled(v); } },
      { enabled: function() { return typeof runtimeState.topGoldPerMinuteEnabled !== "undefined" && runtimeState.topGoldPerMinuteEnabled; }, set: function(v) { if (typeof setTopGoldPerMinuteEnabled === "function") setTopGoldPerMinuteEnabled(v); } },
      { enabled: function() { return typeof runtimeState.teamGoldPerMinuteEnabled !== "undefined" && runtimeState.teamGoldPerMinuteEnabled; }, set: function(v) { if (typeof setTeamBuildStatsEnabled === "function") setTeamBuildStatsEnabled(v); } },
      { enabled: function() { return typeof runtimeState.tradeBalancesEnabled !== "undefined" && runtimeState.tradeBalancesEnabled; }, set: function(v) { if (typeof setTradeBalancesEnabled === "function") setTradeBalancesEnabled(v); } },
      { enabled: function() { return typeof runtimeState.boatPanelOpen !== "undefined" && runtimeState.boatPanelOpen; }, set: function(v) { if (typeof setBoatPanelEnabled === "function") setBoatPanelEnabled(v); } },
      { enabled: function() { return typeof runtimeState.allianceRequestsPanelEnabled !== "undefined" && runtimeState.allianceRequestsPanelEnabled; }, set: function(v) { if (typeof setAllianceRequestsPanelEnabled === "function") setAllianceRequestsPanelEnabled(v); } },
      { enabled: function() { return typeof runtimeState.allyMarkersEnabled !== "undefined" && runtimeState.allyMarkersEnabled; }, set: function(v) { if (typeof setAllyMarkersEnabled === "function") setAllyMarkersEnabled(v); } },
      { enabled: function() { return typeof runtimeState.buildTimerEnabled !== "undefined" && runtimeState.buildTimerEnabled; }, set: function(v) { if (typeof setBuildTimerEnabled === "function") setBuildTimerEnabled(v); } },
      { enabled: function() { return typeof runtimeState.retaliationEnabled !== "undefined" && runtimeState.retaliationEnabled; }, set: function(v) { if (typeof setRetaliationEnabled === "function") setRetaliationEnabled(v); } },
    ];
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      if (p.enabled()) {
        p.set(false);
        p.set(true);
      }
    }
  }

  window.__openfrontAutoJoinBridgeReady = true;
