// ==UserScript==
// @name         OpenFront Helper (local loader migration)
// @namespace    openfront-helper-local
// @version      2.0.0
// @description  Points Brave users to the serverless unpacked-extension local loader.
// @author       nguyenvancaokyfpt (https://github.com/nguyenvancaokyfpt)
// @homepageURL  https://github.com/nguyenvancaokyfpt/openfront-helper-userscript
// @supportURL   https://github.com/nguyenvancaokyfpt/openfront-helper-userscript/issues
// @match        https://openfront.io/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  const NOTICE_ID = "openfront-helper-local-loader-notice";

  function showMigrationNotice() {
    if (window.__OFH_LOCAL_EXTENSION_VERSION__) return;
    const root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(showMigrationNotice, 50);
      return;
    }
    const notice = document.getElementById(NOTICE_ID) || document.createElement("div");
    notice.id = NOTICE_ID;
    notice.textContent =
      "OpenFront Helper — este loader de Tampermonkey ya no puede leer builds locales en Brave. " +
      "Desactívalo y, en brave://extensions, usa Cargar descomprimida con la carpeta " +
      "/home/eros/Desktop/openfront-helper-userscript.";
    Object.assign(notice.style, {
      position: "fixed",
      zIndex: "2147483647",
      right: "12px",
      bottom: "12px",
      maxWidth: "480px",
      padding: "12px 14px",
      border: "1px solid #f59e0b",
      borderRadius: "8px",
      background: "#1f2937",
      color: "#fff",
      font: "13px/1.4 system-ui, sans-serif",
    });
    if (!notice.parentNode) root.append(notice);
  }

  window.setTimeout(showMigrationNotice, 1500);
})();
