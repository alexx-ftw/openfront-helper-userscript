  function ensureEconomyHeatmapStyles() {
    if (document.getElementById(ECONOMY_HEATMAP_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = ECONOMY_HEATMAP_STYLE_ID;
    style.textContent = `
      #${ECONOMY_HEATMAP_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 7000;
        pointer-events: none;
      }

      #${ECONOMY_HEATMAP_CONTAINER_ID} .${ECONOMY_HEATMAP_CANVAS_CLASS} {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        opacity: 0.82;
        mix-blend-mode: normal;
      }

      #${ECONOMY_HEATMAP_CONTAINER_ID}[data-status]::after {
        content: attr(data-status);
        position: fixed;
        left: 18px;
        bottom: 18px;
        padding: 7px 10px;
        border: 1px solid rgba(74, 222, 128, 0.45);
        border-radius: 8px;
        background: rgba(6, 30, 18, 0.78);
        color: rgba(220, 252, 231, 0.95);
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureEconomyHeatmapCanvas() {
    ensureEconomyHeatmapStyles();

    let container = document.getElementById(ECONOMY_HEATMAP_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = ECONOMY_HEATMAP_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }

    let canvas = container.querySelector(`.${ECONOMY_HEATMAP_CANVAS_CLASS}`);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = ECONOMY_HEATMAP_CANVAS_CLASS;
      container.appendChild(canvas);
    }

    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.floor(window.innerWidth * pixelRatio));
    const height = Math.max(1, Math.floor(window.innerHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cssWidth = `${window.innerWidth}px`;
    const cssHeight = `${window.innerHeight}px`;
    if (canvas.style.width !== cssWidth) {
      canvas.style.width = cssWidth;
    }
    if (canvas.style.height !== cssHeight) {
      canvas.style.height = cssHeight;
    }

    return { canvas, pixelRatio };
  }

  function ensureExportPartnerHeatmapStyles() {
    if (document.getElementById(EXPORT_PARTNER_HEATMAP_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = EXPORT_PARTNER_HEATMAP_STYLE_ID;
    style.textContent = `
      #${EXPORT_PARTNER_HEATMAP_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 8000;
        pointer-events: none;
      }

      #${EXPORT_PARTNER_HEATMAP_CONTAINER_ID} .${EXPORT_PARTNER_HEATMAP_CANVAS_CLASS} {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        opacity: 0.84;
        mix-blend-mode: normal;
      }

      #${EXPORT_PARTNER_HEATMAP_CONTAINER_ID}[data-status]::after {
        content: attr(data-status);
        position: fixed;
        left: 18px;
        bottom: 18px;
        padding: 7px 10px;
        border: 1px solid rgba(45, 212, 191, 0.45);
        border-radius: 8px;
        background: rgba(10, 30, 34, 0.78);
        color: rgba(204, 251, 241, 0.95);
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureExportPartnerHeatmapCanvas() {
    ensureExportPartnerHeatmapStyles();

    let container = document.getElementById(EXPORT_PARTNER_HEATMAP_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = EXPORT_PARTNER_HEATMAP_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }

    let canvas = container.querySelector(`.${EXPORT_PARTNER_HEATMAP_CANVAS_CLASS}`);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = EXPORT_PARTNER_HEATMAP_CANVAS_CLASS;
      container.appendChild(canvas);
    }

    const pixelRatio = 1;
    const width = Math.max(1, Math.floor(window.innerWidth * pixelRatio));
    const height = Math.max(1, Math.floor(window.innerHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cssWidth = `${window.innerWidth}px`;
    const cssHeight = `${window.innerHeight}px`;
    if (canvas.style.width !== cssWidth) {
      canvas.style.width = cssWidth;
    }
    if (canvas.style.height !== cssHeight) {
      canvas.style.height = cssHeight;
    }

    return { canvas, pixelRatio };
  }

