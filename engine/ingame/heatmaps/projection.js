  function getHeatmapZoomScale(transform) {
    const scale = Number(transform?.scale);
    if (!Number.isFinite(scale) || scale <= 0) {
      return 1;
    }

    return scale / HEATMAP_REFERENCE_ZOOM;
  }

  function projectEconomyHeatmapPoints(sources, game, transform) {
    const points = [];
    const padding = ECONOMY_HEATMAP_VIEWPORT_PADDING;
    const zoomScale = getHeatmapZoomScale(transform);
    const worldPoint = { x: 0, y: 0 };

    for (const source of sources) {
      if (source.tile == null) {
        continue;
      }

      {
        worldPoint.x = game.x(source.tile);
        worldPoint.y = game.y(source.tile);
        const screenPoint = transform.worldToScreenCoordinates(worldPoint);
        if (
          Number.isFinite(screenPoint?.x) &&
          Number.isFinite(screenPoint?.y) &&
          screenPoint.x > -padding &&
          screenPoint.y > -padding &&
          screenPoint.x < window.innerWidth + padding &&
          screenPoint.y < window.innerHeight + padding
        ) {
          points.push({
            x: screenPoint.x,
            y: screenPoint.y,
            weight: source.weight,
            type: source.type,
            zoomScale,
          });
        }
      }
    }

    return points;
  }

  function collectEconomyHeatmapSources(game) {
    const sources = [];
    pruneEconomyRevenueSources(game);

    for (const entry of economyRevenueSourceTrackers.values()) {
      if (
        entry.tile == null ||
        !Number.isFinite(entry.total) ||
        entry.total <= 0 ||
        !isEconomyRevenueType(String(entry.type ?? ""))
      ) {
        continue;
      }

      addEconomicSource(sources, entry.tile, entry.total, entry.type);
    }

    return sources;
  }

  function getEconomyHeatmapSources(game) {
    const now = performance.now();
    if (
      runtimeState.economyHeatmapDataGame !== game ||
      runtimeState.lastEconomyHeatmapDataAt === 0 ||
      now - runtimeState.lastEconomyHeatmapDataAt >= ECONOMY_HEATMAP_DATA_REFRESH_MS
    ) {
      runtimeState.economyHeatmapSources = collectEconomyHeatmapSources(game);
      runtimeState.economyHeatmapDataGame = game;
      runtimeState.lastEconomyHeatmapDataAt = now;
    }

    return runtimeState.economyHeatmapSources;
  }

  function normalizeEconomyHeatmapIntensity(value) {
    const intensity = Number(value);
    if (!Number.isFinite(intensity)) {
      return 1;
    }
    return Math.max(0, Math.min(2, Math.round(intensity)));
  }

  function getEconomyHeatmapIntensitySettings() {
    return _getEconomyHeatmapIntensitySettingsCached();
  }

