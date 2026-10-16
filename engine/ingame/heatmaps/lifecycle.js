  function setEconomyHeatmapIntensity(value) {
    runtimeState.economyHeatmapIntensity = normalizeEconomyHeatmapIntensity(value);
  }

  function setEconomyHeatmapEnabled(enabled) {
    runtimeState.economyHeatmapEnabled = Boolean(enabled);
    if (!runtimeState.economyHeatmapEnabled) {
      if (runtimeState.economyHeatmapAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.economyHeatmapAnimationFrame);
      }
      runtimeState.economyHeatmapAnimationFrame = null;
      runtimeState.lastEconomyHeatmapDrawAt = 0;
      runtimeState.lastEconomyHeatmapDataAt = 0;
      runtimeState.economyHeatmapDataGame = null;
      runtimeState.economyHeatmapSources = [];
      economyRevenueSourceTrackers.clear();
      if (!runtimeState.tradeBalancesEnabled && !runtimeState.exportPartnerHeatmapEnabled) {
        trainTradeTrackers.clear();
        tradeShipSourceTrackers.clear();
        runtimeState.lastProcessedTradeBalanceTick = null;
      }
      if (!runtimeState.goldPerMinuteEnabled && !runtimeState.teamGoldPerMinuteEnabled && !runtimeState.topGoldPerMinuteEnabled) {
        goldTrackers.clear();
        incomingGoldTransfers.clear();
        runtimeState.lastProcessedIncomingGoldTransferTick = null;
      }
      removeHeatmapContainer(ECONOMY_HEATMAP_CONTAINER_ID, ECONOMY_HEATMAP_CANVAS_CLASS);
      return;
    }

    setExportPartnerHeatmapEnabled(false);
    if (runtimeState.economyHeatmapAnimationFrame === null) {
      drawEconomyHeatmap();
    }
  }

  function setExportPartnerHeatmapEnabled(enabled) {
    runtimeState.exportPartnerHeatmapEnabled = Boolean(enabled);
    if (!runtimeState.exportPartnerHeatmapEnabled) {
      if (runtimeState.exportPartnerHeatmapAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.exportPartnerHeatmapAnimationFrame);
      }
      runtimeState.exportPartnerHeatmapAnimationFrame = null;
      runtimeState.lastExportPartnerHeatmapDrawAt = 0;
      resetExportPartnerHeatmapSourceCache();
      removeHeatmapContainer(
        EXPORT_PARTNER_HEATMAP_CONTAINER_ID,
        EXPORT_PARTNER_HEATMAP_CANVAS_CLASS,
      );
      if (!runtimeState.tradeBalancesEnabled && !runtimeState.economyHeatmapEnabled) {
        tradeBalanceTrackers.clear();
        exportPartnerSourceTrackers.clear();
        factoryPortSpendTrackers.clear();
        factoryPortUnitTrackers.clear();
        trainTradeTrackers.clear();
        tradeShipSourceTrackers.clear();
      }
      return;
    }

    setEconomyHeatmapEnabled(false);
    if (runtimeState.exportPartnerHeatmapAnimationFrame === null) {
      drawExportPartnerHeatmap();
    }
  }
