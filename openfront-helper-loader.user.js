// ==UserScript==
// @name         OpenFront Helper (local build loader)
// @namespace    openfront-helper-local
// @version      1.2.0
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
  let activeBuildId = "";
  let requestInFlight = false;

  function requestLocalFile(url, onload) {
    GM_xmlhttpRequest({
      method: "GET",
      url,
      headers: { "Cache-Control": "no-cache" },
      timeout: POLL_INTERVAL_MS,
      onload,
      onerror: finishRequest,
      ontimeout: finishRequest,
      onabort: finishRequest,
    });
  }

  function finishRequest() {
    requestInFlight = false;
  }

  function loadNewAutoBot(buildId) {
    requestLocalFile(AUTO_BOT_URL, async (response) => {
      const hotReload = unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__;
      if (typeof hotReload === "function" && (await hotReload(response.responseText, buildId))) {
        activeBuildId = buildId;
      }
      finishRequest();
    });
  }

  function loadInitialBuild(buildId) {
    requestLocalFile(BUILD_URL, (response) => {
      unsafeWindow.eval(String(response.responseText || ""));
      unsafeWindow.__OFH_LOCAL_BUILD_ID__ = buildId;
      activeBuildId = buildId;
      finishRequest();
    });
  }

  function checkForNewBuild() {
    if (requestInFlight) return;
    requestInFlight = true;
    requestLocalFile(BUILD_ID_URL, (response) => {
      const buildId = BUILD_ID_PATTERN.exec(String(response.responseText || ""))?.[1];
      if (!buildId || buildId === activeBuildId) {
        finishRequest();
        return;
      }
      loadNewAutoBot(buildId);
    });
  }

  function initializeLocalBuild() {
    requestInFlight = true;
    requestLocalFile(BUILD_ID_URL, (response) => {
      const buildId = BUILD_ID_PATTERN.exec(String(response.responseText || ""))?.[1];
      if (!buildId) {
        finishRequest();
        return;
      }
      loadInitialBuild(buildId);
    });
  }

  window.setInterval(checkForNewBuild, POLL_INTERVAL_MS);
  initializeLocalBuild();
})();
