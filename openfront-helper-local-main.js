(() => {
  window.__OFH_LOCAL_EXTENSION_VERSION__ = "1.0.0";
  const SOURCE_EVENT = "openfront-helper-local-source";
  const RESULT_EVENT = "openfront-helper-local-result";
  const BUILD_ID_PATTERN = /^[a-f0-9]{64}$/u;
  let applyQueue = Promise.resolve();

  function sendResult(requestId, buildId, ok, error = "") {
    const detail = { buildId, ok, requestId };
    if (error) detail.error = error;
    window.dispatchEvent(
      new CustomEvent(RESULT_EVENT, {
        detail,
      }),
    );
  }

  function validateRequest(detail) {
    const requestId = String(detail?.requestId || "");
    const buildId = String(detail?.buildId || "");
    if (!requestId || !BUILD_ID_PATTERN.test(buildId)) throw new Error("solicitud inválida");
    const source = String(detail?.source || "");
    if (!source.trim()) throw new Error("build local vacío");
    return { buildId, mode: detail?.mode, requestId, source };
  }

  function applyInitialSource(source, buildId) {
    // This is the extension's reviewed local build, intentionally executed in MAIN world.
    (0, eval)(source);
    if (typeof window.__OFH_HOT_RELOAD_AUTOBOT__ !== "function") {
      throw new Error("el build inicial no expuso el puente de hot reload");
    }
    window.__OFH_LOCAL_BUILD_ID__ = buildId;
  }

  async function applySource(detail) {
    const request = validateRequest(detail);
    if (request.mode === "initial") {
      applyInitialSource(request.source, request.buildId);
      return request;
    }
    if (request.mode !== "hot") throw new Error("modo de carga inválido");
    const hotReload = window.__OFH_HOT_RELOAD_AUTOBOT__;
    if (typeof hotReload !== "function" || !(await hotReload(request.source, request.buildId))) {
      throw new Error("el Auto-Bot rechazó el hot reload");
    }
    return request;
  }

  window.addEventListener(SOURCE_EVENT, (event) => {
    const detail = event.detail;
    const requestId = String(detail?.requestId || "");
    const buildId = String(detail?.buildId || "");
    applyQueue = applyQueue
      .then(() => applySource(detail))
      .then(
        () => sendResult(requestId, buildId, true),
        (error) => {
          const message = error?.message || String(error);
          console.error(`[OpenFront Helper local loader] ${message}`);
          sendResult(requestId, buildId, false, message);
        },
      );
  });
})();
