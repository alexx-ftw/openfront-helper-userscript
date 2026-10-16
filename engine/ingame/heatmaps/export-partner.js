  const _exportPartnerShapeResult = { intensity: 0, radius: 0 };

  function getExportPartnerHeatmapPointShape(point, maxWeight, pixelRatio) {
    const intensity = Math.max(0.3, Math.min(1, point.weight / maxWeight));
    const typeScale = getHeatmapTypeScale(
      point.type,
      { City: 1.35, Factory: 1.15, Port: 1.05 },
      0.95,
    );
    const zoomRadiusScale =
      point.zoomScale < 1
        ? Math.min(1.15, Math.max(0.58, point.zoomScale * 1.55))
        : point.zoomScale;
    _exportPartnerShapeResult.intensity = intensity;
    _exportPartnerShapeResult.radius =
      (20 + intensity * 64) * typeScale * zoomRadiusScale * pixelRatio;
    return _exportPartnerShapeResult;
  }

  function drawExportPartnerHeatmapPoint(ctx, point, maxWeight, pixelRatio) {
    const shape = getExportPartnerHeatmapPointShape(point, maxWeight, pixelRatio);
    const { intensity, radius } = shape;
    const x = point.x * pixelRatio;
    const y = point.y * pixelRatio;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(20, 184, 166, ${0.94 * intensity})`);
    gradient.addColorStop(0.34, `rgba(250, 204, 21, ${0.66 * intensity})`);
    gradient.addColorStop(0.72, `rgba(59, 130, 246, ${0.36 * intensity})`);
    gradient.addColorStop(1, "rgba(59, 130, 246, 0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawExportPartnerHeatmap() {
    if (!runtimeState.exportPartnerHeatmapEnabled) {
      runtimeState.exportPartnerHeatmapAnimationFrame = null;
      return;
    }

    const now = performance.now();
    if (now - runtimeState.lastExportPartnerHeatmapDrawAt < EXPORT_PARTNER_HEATMAP_DRAW_MS) {
      scheduleExportPartnerHeatmapDraw();
      return;
    }
    runtimeState.lastExportPartnerHeatmapDrawAt = now;

    const { canvas, pixelRatio } = ensureExportPartnerHeatmapCanvas();
    const overlay = getHoveredPlayerInfoOverlay();
    if (!overlay?.game || !overlay?.transform || !overlay?.player) {
      clearHeatmapCanvas(canvas);
      canvas.parentElement?.removeAttribute("data-status");
      scheduleExportPartnerHeatmapDraw();
      return;
    }

    processTradeBalanceUpdates(overlay.game);
    const sources = getExportPartnerHeatmapSources(overlay.game, overlay.player);
    const points = projectEconomyHeatmapPoints(sources, overlay.game, overlay.transform);
    if (points.length === 0) {
      clearHeatmapCanvas(canvas);
      canvas.parentElement?.setAttribute("data-status", "Export partner heatmap: no observed exports yet");
      scheduleExportPartnerHeatmapDraw();
      return;
    }

    canvas.parentElement?.removeAttribute("data-status");
    renderHeatmapCanvas({
      canvas,
      points,
      pixelRatio,
      palette: 1,
      getShape: getExportPartnerHeatmapPointShape,
      drawPoint: drawExportPartnerHeatmapPoint,
    });
    scheduleExportPartnerHeatmapDraw();
  }

