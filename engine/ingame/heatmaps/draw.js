  // Reused shape result. getEconomyHeatmapPointShape is called once per point
  // per frame; returning a fresh object each call caused thousands of object
  // allocations per second during panning.
  const _economyShapeResult = { intensity: 0, radius: 0 };

  function getHeatmapTypeScale(type, scales, fallback) {
    return Object.hasOwn(scales, type) ? scales[type] : fallback;
  }

  function getEconomyHeatmapPointShape(point, maxWeight, pixelRatio) {
    const baseIntensity = Math.max(0.28, Math.min(1, point.weight / maxWeight));
    const intensitySettings = _getEconomyHeatmapIntensitySettingsCached();
    const intensity = Math.max(
      0.14,
      Math.min(1, baseIntensity * intensitySettings.alpha),
    );
    const radiusIntensity = Math.max(
      0.22,
      Math.min(1, baseIntensity * intensitySettings.radius),
    );
    const typeScale = getHeatmapTypeScale(point.type, { Factory: 1.25, Port: 1.05 }, 0.9);
    const zoomRadiusScale =
      point.zoomScale < 1
        ? Math.min(1.35, Math.max(0.68, point.zoomScale * 1.8))
        : point.zoomScale;
    _economyShapeResult.intensity = intensity;
    _economyShapeResult.radius =
      (18 + radiusIntensity * 52) * typeScale * zoomRadiusScale * pixelRatio;
    return _economyShapeResult;
  }

  function drawEconomyHeatmapPoint(ctx, point, maxWeight, pixelRatio) {
    const shape = getEconomyHeatmapPointShape(point, maxWeight, pixelRatio);
    const { intensity, radius } = shape;
    const x = point.x * pixelRatio;
    const y = point.y * pixelRatio;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(239, 68, 68, ${0.9 * intensity})`);
    gradient.addColorStop(0.3, `rgba(250, 204, 21, ${0.68 * intensity})`);
    gradient.addColorStop(0.66, `rgba(34, 197, 94, ${0.38 * intensity})`);
    gradient.addColorStop(1, "rgba(34, 197, 94, 0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function scheduleEconomyHeatmapDraw() {
    runtimeState.economyHeatmapAnimationFrame = requestAnimationFrame(drawEconomyHeatmap);
  }

  function scheduleExportPartnerHeatmapDraw() {
    runtimeState.exportPartnerHeatmapAnimationFrame = requestAnimationFrame(drawExportPartnerHeatmap);
  }

  function maxHeatmapWeight(points) {
    return points.reduce((maximum, point) => Math.max(maximum, point.weight), 1);
  }

  function renderHeatmapCanvas(options) {
    const maxWeight = maxHeatmapWeight(options.points);
    const webGlRendered = renderHeatmapPointsWebGl({
      canvas: options.canvas,
      points: options.points,
      maxWeight,
      pixelRatio: options.pixelRatio,
      palette: options.palette,
      getShape: options.getShape,
    });
    if (webGlRendered) return;
    const context = options.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, options.canvas.width, options.canvas.height);
    context.globalCompositeOperation = "lighter";
    for (const point of options.points) {
      options.drawPoint(context, point, maxWeight, options.pixelRatio);
    }
    context.globalCompositeOperation = "source-over";
  }

  function getEconomyHeatmapPoints(context, canvas) {
    {
      const sources = getEconomyHeatmapSources(context.game);
      return projectEconomyHeatmapPoints(sources, context.game, context.transform);
    }
  }

  function drawEconomyHeatmap() {
    if (!runtimeState.economyHeatmapEnabled) {
      runtimeState.economyHeatmapAnimationFrame = null;
      return;
    }

    const now = performance.now();
    if (now - runtimeState.lastEconomyHeatmapDrawAt < ECONOMY_HEATMAP_DRAW_MS) {
      scheduleEconomyHeatmapDraw();
      return;
    }
    runtimeState.lastEconomyHeatmapDrawAt = now;

    const context = getOpenFrontGameContext();
    const { canvas, pixelRatio } = ensureEconomyHeatmapCanvas();
    if (!context?.game || !context?.transform) {
      clearHeatmapCanvas(canvas);
      canvas.parentElement?.setAttribute("data-status", "Economic heatmap: waiting for game data");
      scheduleEconomyHeatmapDraw();
      return;
    }

    sampleGoldPerMinuteIfDue();
    processTradeBalanceUpdates(context.game);
    const points = getEconomyHeatmapPoints(context, canvas);
    if (points === null) {
      scheduleEconomyHeatmapDraw();
      return;
    }
    if (points.length === 0) {
      clearHeatmapCanvas(canvas);
      canvas.parentElement?.setAttribute("data-status", "Economic heatmap: waiting for observed trade revenue");
      scheduleEconomyHeatmapDraw();
      return;
    }

    canvas.parentElement?.removeAttribute("data-status");
    renderHeatmapCanvas({
      canvas,
      points,
      pixelRatio,
      palette: 0,
      getShape: getEconomyHeatmapPointShape,
      drawPoint: drawEconomyHeatmapPoint,
    });
    scheduleEconomyHeatmapDraw();
  }

