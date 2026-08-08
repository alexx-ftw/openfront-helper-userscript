// ==UserScript==
// @name         OpenFront Helper (local build loader)
// @namespace    openfront-helper-local
// @version      1.0.0
// @description  Loads the current OpenFront Helper build from the local development server.
// @author       nguyenvancaokyfpt (https://github.com/nguyenvancaokyfpt)
// @homepageURL  https://github.com/nguyenvancaokyfpt/openfront-helper-userscript
// @supportURL   https://github.com/nguyenvancaokyfpt/openfront-helper-userscript/issues
// @match        https://openfront.io/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// ==/UserScript==

/* global GM_xmlhttpRequest */

(() => {
  const LOCAL_BUILD_URL = "http://127.0.0.1:17373/openfront-helper.user.js";
  const LOADER_STATE_KEY = "__OFH_LOCAL_BUILD_LOADER__";

  if (window[LOADER_STATE_KEY]) return;
  window[LOADER_STATE_KEY] = true;

  const report = (message, detail = "") => {
    console.warn(`[OFH local loader] ${message}`, detail);
  };

  const injectBuild = (source) => {
    if (!source.includes("window.__OFH_ASSETS") || !source.includes("OpenFront Helper")) {
      report("the local response is not an OpenFront Helper build");
      return;
    }

    const script = document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=${LOCAL_BUILD_URL}`;
    const parent = document.head || document.documentElement;
    if (!parent) {
      document.addEventListener("DOMContentLoaded", () => injectBuild(source), { once: true });
      return;
    }
    parent.appendChild(script);
    script.remove();
  };

  GM_xmlhttpRequest({
    method: "GET",
    url: LOCAL_BUILD_URL,
    timeout: 5000,
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    onload(response) {
      if (response.status < 200 || response.status >= 300) {
        report(`local build request returned HTTP ${response.status}`);
        return;
      }
      injectBuild(response.responseText);
    },
    onerror() {
      report(`could not reach ${LOCAL_BUILD_URL}; start npm run dev:userscript`);
    },
    ontimeout() {
      report(`timed out loading ${LOCAL_BUILD_URL}`);
    },
  });
})();
