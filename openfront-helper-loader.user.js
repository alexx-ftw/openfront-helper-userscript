// ==UserScript==
// @name         OpenFront Helper — cargador local
// @namespace    openfront-helper-local
// @version      3.0.1
// @description  Recarga en caliente el Auto-Bot local sin refrescar OpenFront.
// @author       nguyenvancaokyfpt (https://github.com/nguyenvancaokyfpt)
// @homepageURL  https://github.com/nguyenvancaokyfpt/openfront-helper-userscript
// @supportURL   https://github.com/nguyenvancaokyfpt/openfront-helper-userscript/issues
// @match        https://openfront.io/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */

(() => {
  const SERVER_ROOT = "http://127.0.0.1:17373";
  const BUILD_ID_PATH = "/openfront-helper.build-id.js";
  const FULL_BUILD_PATH = "/openfront-helper.user.js";
  const AUTO_BOT_PATH = "/openfront-helper.autobot.js";
  const BUILD_ID_PATTERN = /__OFH_LOCAL_BUILD_ID__\s*=\s*["']([a-f0-9]{64})["']/u;
  const POLL_INTERVAL_MS = 1000;
  let activeBuildId = String(unsafeWindow.__OFH_LOCAL_BUILD_ID__ || "");
  let requestInFlight = false;
  let warned = false;

  function requestLocalFile(filePath) {
    return new Promise((resolve, reject) => {
      const url = `${SERVER_ROOT}${filePath}?time=${Date.now()}`;
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { "Cache-Control": "no-cache" },
        timeout: 5000,
        onload(response) {
          if (response.status !== 200 || !String(response.responseText || "").trim()) {
            reject(new Error(`${filePath}: HTTP ${response.status}`));
            return;
          }
          resolve(String(response.responseText));
        },
        onerror() {
          reject(new Error("servidor local no disponible"));
        },
        ontimeout() {
          reject(new Error("servidor local no respondió a tiempo"));
        },
        onabort() {
          reject(new Error("lectura local cancelada"));
        },
      });
    });
  }

  async function applyBuild(buildId) {
    const hotReload = unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__;
    if (activeBuildId && typeof hotReload === "function") {
      const previousSettings = unsafeWindow.__OFH_autobot?.get?.();
      const previousEnabled =
        typeof previousSettings?.enabled === "boolean" ? previousSettings.enabled : undefined;
      const source = await requestLocalFile(AUTO_BOT_PATH);
      if (!(await hotReload(source, buildId))) throw new Error("el Auto-Bot rechazó el hot reload");
      // Reapply through the replacement runtime's public API. Besides preserving
      // the toggle, set({ enabled: true }) restarts its engine timer if lifecycle
      // activation inherited the setting but did not leave the engine running.
      if (typeof previousEnabled === "boolean") {
        unsafeWindow.__OFH_autobot?.set?.({ enabled: previousEnabled });
      }
    } else {
      const source = await requestLocalFile(FULL_BUILD_PATH);
      unsafeWindow.eval(`${source}\n//# sourceURL=openfront-helper.user.js`);
      if (typeof unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ !== "function") {
        throw new Error("el build completo no expuso el puente de hot reload");
      }
    }
    // The same in-flight guard also serializes the page-visible fingerprint update.
    // eslint-disable-next-line require-atomic-updates
    unsafeWindow.__OFH_LOCAL_BUILD_ID__ = buildId;
    // The in-flight guard serializes fingerprint reads and build application.
    // eslint-disable-next-line require-atomic-updates
    activeBuildId = buildId;
    warned = false;
  }

  async function checkForNewBuild() {
    const fingerprint = await requestLocalFile(BUILD_ID_PATH);
    const buildId = BUILD_ID_PATTERN.exec(fingerprint)?.[1];
    if (!buildId) throw new Error("fingerprint local inválido");
    if (buildId !== activeBuildId) await applyBuild(buildId);
  }

  function poll() {
    if (requestInFlight) return;
    requestInFlight = true;
    checkForNewBuild()
      .then(undefined, (error) => {
        if (!warned) {
          console.warn(`[OpenFront Helper hot reload] ${error?.message || String(error)}`);
          warned = true;
        }
      })
      .then(() => {
        requestInFlight = false;
      });
  }

  window.setInterval(poll, POLL_INTERVAL_MS);
  poll();
})();
