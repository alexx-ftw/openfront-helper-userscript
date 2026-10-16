// Economic and export-partner heatmap rendering.

  const heatmapWebGlRenderers = new WeakMap();
  // Reusable per-canvas Float32Array for vertex data. Avoids allocating
  // points.length * 6 * 6 floats every panning frame.
  const heatmapVertexBuffers = new WeakMap();
  // Cached economy heatmap intensity settings. Recomputed only when the
  // intensity setting changes, not per point per frame.
  const _economyHeatmapIntensityVariants = [
    { alpha: 0.7, radius: 0.88 },
    { alpha: 1, radius: 1 },
    { alpha: 1.35, radius: 1.18 },
  ];

  function _getEconomyHeatmapIntensitySettingsCached() {
    return _economyHeatmapIntensityVariants[
      normalizeEconomyHeatmapIntensity(runtimeState.economyHeatmapIntensity)
    ];
  }

  function _ensureHeatmapVertexBuffer(canvas, floatsNeeded) {
    let buffer = heatmapVertexBuffers.get(canvas);
    if (!buffer || buffer.length < floatsNeeded) {
      // Allocate with growth headroom so subsequent frames reuse the buffer.
      const capacity = Math.max(floatsNeeded, buffer ? buffer.length * 2 : 256);
      buffer = new Float32Array(capacity);
      heatmapVertexBuffers.set(canvas, buffer);
    }
    return buffer;
  }

