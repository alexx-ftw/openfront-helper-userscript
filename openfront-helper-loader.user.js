// ==UserScript==
// @name         OpenFront Helper (local build loader)
// @namespace    openfront-helper-local
// @version      1.3.0
// @description  Runs and hot-reloads this checkout's current OpenFront Helper bot directly from disk.
// @author       nguyenvancaokyfpt (https://github.com/nguyenvancaokyfpt)
// @homepageURL  https://github.com/nguyenvancaokyfpt/openfront-helper-userscript
// @supportURL   https://github.com/nguyenvancaokyfpt/openfront-helper-userscript/issues
// @match        https://openfront.io/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */

(() => {
  const BUILD_ID_URL =
    "file:///home/eros/Desktop/openfront-helper-userscript/openfront-helper.build-id.js";
  const BUILD_URL =
    "file:///home/eros/Desktop/openfront-helper-userscript/openfront-helper.user.js";
  const AUTO_BOT_URL =
    "file:///home/eros/Desktop/openfront-helper-userscript/openfront-helper.autobot.js";
  const BUILD_ID_PATTERN = /__OFH_LOCAL_BUILD_ID__\s*=\s*["']([a-f0-9]{64})["']/u;
  const POLL_INTERVAL_MS = 1000;
  const REQUEST_TIMEOUT_MS = 10000;
  const ERROR_ID = "openfront-helper-local-loader-error";
  let activeBuildId = String(unsafeWindow.__OFH_LOCAL_BUILD_ID__ || "");
  let requestInFlight = false;

  function finishRequest() {
    requestInFlight = false;
  }

  function showLoaderError() {
    if (typeof console?.error === "function") {
      console.error(
        "[OpenFront Helper] Cannot read the local build. In Brave's Tampermonkey extension details, enable 'Allow access to file URLs' and set Site access to 'On all sites'.",
      );
    }
    if (typeof document === "undefined") return;
    const root = document.documentElement || document.body;
    if (!root || typeof document.createElement !== "function") return;
    let notice = document.getElementById(ERROR_ID);
    if (!notice) {
      notice = document.createElement("div");
      notice.id = ERROR_ID;
      Object.assign(notice.style, {
        position: "fixed",
        zIndex: "2147483647",
        right: "12px",
        bottom: "12px",
        maxWidth: "420px",
        padding: "12px 14px",
        border: "1px solid #ef4444",
        borderRadius: "8px",
        background: "#1f2937",
        color: "#fff",
        font: "13px/1.4 system-ui, sans-serif",
      });
      root.append(notice);
    }
    notice.textContent =
      "OpenFront Helper no puede leer el build local. En los detalles de Tampermonkey activa “Permitir acceso a URLs de archivo” y “Acceso al sitio: todos los sitios”. El loader seguirá reintentándolo.";
  }

  function clearLoaderError() {
    if (typeof document === "undefined") return;
    document.getElementById(ERROR_ID)?.remove();
  }

  function failRequest() {
    showLoaderError();
    finishRequest();
  }

  function validLocalResponseText(response) {
    const status = Number(response?.status ?? 0);
    const text = String(response?.responseText || "");
    if (status !== 0 && (status < 200 || status >= 300)) return null;
    return text.trim() ? text : null;
  }

  function handleLocalResponse(response, onload) {
    return new Promise((resolveOnload) => {
      const source = validLocalResponseText(response);
      if (source === null) throw new Error("invalid local build response");
      resolveOnload(onload(source));
    }).then(undefined, failRequest);
  }

  function requestLocalFile(url, onload) {
    new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { "Cache-Control": "no-cache" },
        timeout: REQUEST_TIMEOUT_MS,
        onload: (response) => handleLocalResponse(response, onload),
        onerror: failRequest,
        ontimeout: failRequest,
        onabort: failRequest,
      });
      resolve();
    }).then(undefined, failRequest);
  }

  function loadNewAutoBot(buildId) {
    requestLocalFile(AUTO_BOT_URL, (source) => {
      const hotReload = unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__;
      if (typeof hotReload !== "function") {
        throw new Error("hot-reload bridge unavailable");
      }
      return Promise.resolve(hotReload(source, buildId)).then((reloaded) => {
        if (!reloaded) throw new Error("hot reload rejected");
        activeBuildId = buildId;
        clearLoaderError();
        finishRequest();
      });
    });
  }

  function loadInitialBuild(buildId) {
    requestLocalFile(BUILD_URL, (source) => {
      return Promise.resolve()
        .then(() => unsafeWindow.eval(source))
        .then(() => {
          if (typeof unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ !== "function") {
            throw new Error("local userscript did not expose its hot-reload bridge");
          }
          unsafeWindow.__OFH_LOCAL_BUILD_ID__ = buildId;
          activeBuildId = buildId;
          clearLoaderError();
          finishRequest();
        });
    });
  }

  function checkForNewBuild() {
    if (requestInFlight) return;
    requestInFlight = true;
    requestLocalFile(BUILD_ID_URL, (source) => {
      const buildId = BUILD_ID_PATTERN.exec(source)?.[1];
      if (!buildId) throw new Error("invalid local build fingerprint");
      if (typeof unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ !== "function") {
        loadInitialBuild(buildId);
        return;
      }
      if (!activeBuildId) {
        unsafeWindow.__OFH_LOCAL_BUILD_ID__ = buildId;
        activeBuildId = buildId;
        clearLoaderError();
        finishRequest();
        return;
      }
      if (buildId === activeBuildId) {
        clearLoaderError();
        finishRequest();
        return;
      }
      loadNewAutoBot(buildId);
    });
  }

  function initializeLocalBuild() {
    checkForNewBuild();
  }

  window.setInterval(checkForNewBuild, POLL_INTERVAL_MS);
  initializeLocalBuild();
})();
