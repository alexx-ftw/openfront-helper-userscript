/* global chrome */

(() => {
  const BUILD_ID_FILE = "openfront-helper.build-id.js";
  const FULL_BUILD_FILE = "openfront-helper.user.js";
  const AUTO_BOT_FILE = "openfront-helper.autobot.js";
  const BUILD_ID_PATTERN = /__OFH_LOCAL_BUILD_ID__\s*=\s*["']([a-f0-9]{64})["']/u;
  const SOURCE_EVENT = "openfront-helper-local-source";
  const RESULT_EVENT = "openfront-helper-local-result";
  const POLL_INTERVAL_MS = 1000;
  const APPLY_TIMEOUT_MS = 15000;
  let activeBuildId = "";
  let requestInFlight = false;

  async function readLocalFile(fileName) {
    const url = new URL(chrome.runtime.getURL(fileName));
    url.searchParams.set("ofh", `${Date.now()}-${crypto.randomUUID()}`);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${fileName}: HTTP ${response.status}`);
    const source = await response.text();
    if (!source.trim()) throw new Error(`${fileName} está vacío`);
    return source;
  }

  function applyInMainWorld(mode, source, buildId) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener(RESULT_EVENT, onResult);
        reject(new Error("el contexto MAIN no respondió"));
      }, APPLY_TIMEOUT_MS);
      function onResult(event) {
        if (event.detail?.requestId !== requestId) return;
        window.clearTimeout(timeout);
        window.removeEventListener(RESULT_EVENT, onResult);
        if (event.detail.ok) resolve();
        else reject(new Error(event.detail.error || "falló la inyección local"));
      }
      window.addEventListener(RESULT_EVENT, onResult);
      window.dispatchEvent(
        new CustomEvent(SOURCE_EVENT, {
          detail: { buildId, mode, requestId, source },
        }),
      );
    });
  }

  async function readAndApplyNewBuild() {
    const fingerprint = await readLocalFile(BUILD_ID_FILE);
    const buildId = BUILD_ID_PATTERN.exec(fingerprint)?.[1];
    if (!buildId) throw new Error(`${BUILD_ID_FILE} no contiene un fingerprint válido`);
    if (buildId === activeBuildId) return;
    const mode = activeBuildId ? "hot" : "initial";
    const fileName = mode === "hot" ? AUTO_BOT_FILE : FULL_BUILD_FILE;
    const source = await readLocalFile(fileName);
    await applyInMainWorld(mode, source, buildId);
    // The in-flight guard serializes this read/compare/apply/update transaction.
    // eslint-disable-next-line require-atomic-updates
    activeBuildId = buildId;
  }

  function checkForNewBuild() {
    if (requestInFlight) return Promise.resolve();
    requestInFlight = true;
    return readAndApplyNewBuild()
      .then(undefined, (error) => {
        console.error(`[OpenFront Helper local loader] ${error?.message || String(error)}`);
      })
      .then(() => {
        requestInFlight = false;
      });
  }

  window.setInterval(checkForNewBuild, POLL_INTERVAL_MS);
  void checkForNewBuild();
})();
