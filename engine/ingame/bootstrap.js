// Final message routing and bridge startup.

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== EXTENSION_SOURCE) {
      return;
    }

    if (data.type === "JOIN_PUBLIC_LOBBY" && data.payload?.gameID) {
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

    if (data.type === "MARK_BOT_NATIONS_RED") {
      setBotMarkersEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_GOLD_PER_MINUTE") {
      setGoldPerMinuteEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_TOP_GOLD_PER_MINUTE") {
      setTopGoldPerMinuteEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_TEAM_BUILD_STATS") {
      setTeamBuildStatsEnabled(data.payload?.enabled);
    }

    if (data.type === "MARK_HOVERED_ALLIES_GREEN") {
      setAllyMarkersEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_ALLIANCE_REQUESTS_PANEL") {
      setAllianceRequestsPanelEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_TRADE_BALANCES") {
      setTradeBalancesEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_HELPER_USERS") {
      setHelperUsersEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_SOS_DEFENSE") {
      setSosDefenseEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_GAME_TIME_ALERT") {
      setGameTimeAlertEnabled(data.payload?.enabled, data.payload?.thresholdSec);
    }

    if (data.type === "SHOW_PLAYER_MAP_OVERLAYS") {
      setPlayerMapOverlaysEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_MAP_TROOP_COUNTS") {
      setMapTroopCountsEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_THREAT_INDICATORS") {
      setThreatIndicatorsEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_MAP_MONEY") {
      setMapMoneyEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_ATTACK_HIGHLIGHT") {
      setAttackHighlightEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_ADVISOR_PANEL") {
      setAdvisorPanelEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_RETALIATION_HUD") {
      setRetaliationEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_HIDE_ADS") {
      setHideAdsEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_ATTACK_RATIO_HOTKEY") {
      setAttackRatioHotkeyEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_RIGHT_CLICK_CONQUEST") {
      setRightClickMenuEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_ROUND_LOGGER") {
      setRoundLoggerEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_NETWORK_LOGGER") {
      setNetworkLoggerEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_BUILD_TIMERS") {
      setBuildTimerEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_ENEMY_INTENT") {
      setEnemyIntentEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_SPAWN_HEATMAP") {
      setSpawnHeatmapEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_SPAWN_MARKERS") {
      setSpawnMarkersEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_MY_GPM_HISTORY") {
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

    if (data.type === "SHOW_NUKE_PREDICTION") {
      setNukePredictionEnabled(data.payload?.enabled);
      // The trajectory line is a sub-toggle on the shared map-overlay scheduler.
      setNukeTrajectoryEnabled(data.payload?.trajectory);
      requestMapOverlayLoop();
    }

    if (data.type === "SHOW_BOAT_PREDICTION") {
      setBoatPredictionEnabled(data.payload?.enabled, {
        alwaysOwnRoutes: data.payload?.alwaysOwnRoutes,
        alwaysTeamRoutes: data.payload?.alwaysTeamRoutes,
        alwaysAllyRoutes: data.payload?.alwaysAllyRoutes,
        alwaysEnemyRoutes: data.payload?.alwaysEnemyRoutes,
      });
    }

    if (data.type === "SHOW_WARSHIP_ROUTES") {
      setWarshipRoutesEnabled(data.payload?.enabled, {
        own: data.payload?.own,
        team: data.payload?.team,
        ally: data.payload?.ally,
        enemy: data.payload?.enemy,
      });
    }

    if (data.type === "SHOW_BOAT_PANEL") {
      setBoatPanelEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_BOAT_INCOMING_WARNING") {
      setBoatIncomingWarningEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_ESTATE_PANEL") {
      setEstatePanelEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_AUTO_LEAVE_ON_TEAM_WIN") {
      setAutoLeaveOnTeamWinEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_NUKE_SUGGESTIONS") {
      setNukeSuggestionsEnabled(data.payload?.enabled);
    }

    if (data.type === "SET_AUTO_NUKE") {
      setAutoNukeEnabled(data.payload?.enabled, data.payload?.includeAllies);
    }

    if (data.type === "SET_SEND_1_PERCENT_BOAT") {
      setSend1PercentBoatEnabled(data.payload?.enabled, data.payload?.contextMenu !== false);
    }

    if (data.type === "SHOW_ECONOMY_HEATMAP") {
      setEconomyHeatmapIntensity(data.payload?.intensity);
      setEconomyHeatmapEnabled(data.payload?.enabled);
    }

    if (data.type === "SHOW_EXPORT_PARTNER_HEATMAP") {
      setExportPartnerHeatmapEnabled(data.payload?.enabled);
    }


    if (data.type === "APPLY_SELECTIVE_TRADE_POLICY") {
      const requestedAt = Number(data.payload?.requestedAt);
      if (Number.isFinite(requestedAt) && requestedAt !== lastSelectiveTradePolicyRequestAt) {
        lastSelectiveTradePolicyRequestAt = requestedAt;
        applySelectiveTradePolicy();
      }
    }

    if (data.type === "SET_SELECTIVE_TRADE_POLICY") {
      setSelectiveTradePolicyEnabled(Boolean(data.payload?.enabled));
    }

    if (data.type === "SET_AUTO_BOT_I18N") {
      if (typeof setAutoBotI18n === "function") {
        setAutoBotI18n(data.payload?.language, data.payload?.bundle);
      }
    }
  });

  window.setInterval(() => {
    refreshSelectiveTradePolicyAvailability();
    refreshCheatsAvailability();
  }, 1000);
  refreshSelectiveTradePolicyAvailability();
  refreshCheatsAvailability();

  window.__openfrontAutoJoinBridgeReady = true;
