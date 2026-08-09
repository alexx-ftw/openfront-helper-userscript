// ==UserScript==
// @name         OpenFront Helper (local build loader)
// @namespace    openfront-helper-local
// @version      1.4.1
// @description  Runs and hot-reloads this checkout's current OpenFront Helper bot directly from disk.
// @author       nguyenvancaokyfpt (https://github.com/nguyenvancaokyfpt)
// @homepageURL  https://github.com/nguyenvancaokyfpt/openfront-helper-userscript
// @supportURL   https://github.com/nguyenvancaokyfpt/openfront-helper-userscript/issues
// @match        https://openfront.io/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

/* global unsafeWindow */

const OFH_BUILD_ID_FILE = "openfront-helper.build-id.js";
const OFH_BUILD_FILE = "openfront-helper.user.js";
const OFH_AUTO_BOT_FILE = "openfront-helper.autobot.js";
const OFH_BUILD_ID_PATTERN = /__OFH_LOCAL_BUILD_ID__\s*=\s*["']([a-f0-9]{64})["']/u;
const OFH_POLL_INTERVAL_MS = 1000;
const OFH_DATABASE_NAME = "openfront-helper-local-loader";
const OFH_DATABASE_STORE = "handles";
const OFH_DIRECTORY_KEY = "build-directory";
const OFH_NOTICE_ID = "openfront-helper-local-loader-notice";
const OFH_CONNECT_ID = "openfront-helper-local-loader-connect";
let ofhDirectoryHandle = null;
let ofhRequestInFlight = false;
let ofhPausedForPermission = false;
let ofhActiveBuildId = String(unsafeWindow.__OFH_LOCAL_BUILD_ID__ || "");

function ofhFailureDetail(error) {
  const detail = error?.message || error?.name || error?.error;
  return typeof detail === "string" && detail.trim() ? detail.trim() : "error desconocido";
}

function ofhWithDocumentRoot(callback) {
  if (typeof document === "undefined") return;
  const root = document.documentElement || document.body;
  if (root) {
    callback(root);
    return;
  }
  window.setTimeout(() => ofhWithDocumentRoot(callback), 50);
}

function ofhNotice() {
  let notice = document.getElementById(OFH_NOTICE_ID);
  if (notice) return notice;
  notice = document.createElement("div");
  notice.id = OFH_NOTICE_ID;
  Object.assign(notice.style, {
    position: "fixed",
    zIndex: "2147483647",
    right: "12px",
    bottom: "12px",
    maxWidth: "440px",
    padding: "12px 14px",
    border: "1px solid #3b82f6",
    borderRadius: "8px",
    background: "#1f2937",
    color: "#fff",
    font: "13px/1.4 system-ui, sans-serif",
  });
  return notice;
}

function ofhClearNotice() {
  if (typeof document === "undefined") return;
  document.getElementById(OFH_NOTICE_ID)?.remove();
}

function ofhShowError(stage, error) {
  const detail = ofhFailureDetail(error);
  console.error(`[OpenFront Helper] ${stage}: ${detail}`);
  ofhWithDocumentRoot((root) => {
    const notice = ofhNotice();
    notice.style.borderColor = "#ef4444";
    notice.textContent = `OpenFront Helper — fallo en ${stage}: ${detail}. El loader seguirá reintentándolo.`;
    if (!notice.parentNode) root.append(notice);
  });
}

function ofhConnectButton() {
  const button = document.createElement("button");
  button.id = OFH_CONNECT_ID;
  button.type = "button";
  button.textContent = "Conectar build local";
  Object.assign(button.style, {
    display: "block",
    marginTop: "10px",
    padding: "8px 12px",
    border: "0",
    borderRadius: "6px",
    background: "#2563eb",
    color: "#fff",
    cursor: "pointer",
    font: "600 13px system-ui, sans-serif",
  });
  button.addEventListener("click", ofhChooseOrAuthorizeDirectory);
  return button;
}

function ofhShowConnectionPrompt(detail) {
  ofhPausedForPermission = true;
  ofhWithDocumentRoot((root) => {
    const notice = ofhNotice();
    notice.style.borderColor = "#3b82f6";
    notice.replaceChildren(
      document.createTextNode(
        `OpenFront Helper — ${detail} Selecciona la carpeta openfront-helper-userscript; Brave recordará el acceso.`,
      ),
      ofhConnectButton(),
    );
    if (!notice.parentNode) root.append(notice);
  });
}

function ofhOpenDatabase() {
  return new Promise((resolve, reject) => {
    const indexedDatabase = unsafeWindow.indexedDB;
    if (!indexedDatabase?.open) {
      reject(new Error("IndexedDB no está disponible"));
      return;
    }
    const request = indexedDatabase.open(OFH_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OFH_DATABASE_STORE)) {
        database.createObjectStore(OFH_DATABASE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("no se pudo abrir IndexedDB"));
  });
}

function ofhDatabaseRequest(mode, operation) {
  return ofhOpenDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(OFH_DATABASE_STORE, mode);
        const request = operation(transaction.objectStore(OFH_DATABASE_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("falló IndexedDB"));
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB abortado"));
      }),
  );
}

function ofhLoadStoredDirectory() {
  return ofhDatabaseRequest("readonly", (store) => store.get(OFH_DIRECTORY_KEY));
}

function ofhSaveDirectory(handle) {
  return ofhDatabaseRequest("readwrite", (store) => store.put(handle, OFH_DIRECTORY_KEY));
}

function ofhDirectoryPermission(handle) {
  if (typeof handle?.queryPermission !== "function") return Promise.resolve("granted");
  return handle.queryPermission({ mode: "read" });
}

function ofhActivateDirectory(handle) {
  ofhDirectoryHandle = handle;
  ofhPausedForPermission = false;
  ofhClearNotice();
  ofhCheckForNewBuild();
}

function ofhPersistAndActivateDirectory(handle) {
  return ofhSaveDirectory(handle).then(
    () => ofhActivateDirectory(handle),
    () => ofhActivateDirectory(handle),
  );
}

function ofhRequestStoredPermission(handle) {
  if (typeof handle?.requestPermission !== "function") {
    return Promise.resolve("granted");
  }
  return handle.requestPermission({ mode: "read" });
}

function ofhPickDirectory() {
  let pickerWindow = null;
  if (typeof window.showDirectoryPicker === "function") {
    pickerWindow = window;
  } else if (typeof unsafeWindow.showDirectoryPicker === "function") {
    pickerWindow = unsafeWindow;
  }
  if (!pickerWindow) {
    return Promise.reject(new Error("Brave no expone showDirectoryPicker"));
  }
  return pickerWindow.showDirectoryPicker({
    id: "openfront-helper-local-build",
    mode: "read",
    startIn: "desktop",
  });
}

function ofhChooseOrAuthorizeDirectory() {
  const selected = ofhDirectoryHandle
    ? ofhRequestStoredPermission(ofhDirectoryHandle).then((permission) => {
        if (permission !== "granted") throw new Error("permiso de lectura denegado");
        return ofhDirectoryHandle;
      })
    : ofhPickDirectory();
  selected
    .then(ofhPersistAndActivateDirectory)
    .then(undefined, (error) => ofhShowConnectionPrompt(ofhFailureDetail(error)));
}

function ofhReadBuildFile(fileName) {
  return Promise.resolve()
    .then(() => ofhDirectoryHandle.getFileHandle(fileName))
    .then((fileHandle) => fileHandle.getFile())
    .then((file) => file.text())
    .then((source) => {
      if (!String(source).trim()) throw new Error(`${fileName} está vacío`);
      return String(source);
    });
}

function ofhFinishRequest() {
  ofhRequestInFlight = false;
}

function ofhFailRequest(stage, error) {
  ofhShowError(stage, error);
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    ofhShowConnectionPrompt("Brave necesita renovar el permiso de lectura.");
  }
  ofhFinishRequest();
}

function ofhLoadNewAutoBot(buildId) {
  ofhReadBuildFile(OFH_AUTO_BOT_FILE)
    .then((source) => {
      const hotReload = unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__;
      if (typeof hotReload !== "function") throw new Error("hot-reload bridge unavailable");
      return hotReload(source, buildId);
    })
    .then((reloaded) => {
      if (!reloaded) throw new Error("hot reload rejected");
      ofhActiveBuildId = buildId;
      ofhClearNotice();
      ofhFinishRequest();
    })
    .then(undefined, (error) => ofhFailRequest("hot reload del Auto-Bot", error));
}

function ofhLoadInitialBuild(buildId) {
  ofhReadBuildFile(OFH_BUILD_FILE)
    .then((source) => unsafeWindow.eval(source))
    .then(() => {
      if (typeof unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ !== "function") {
        throw new Error("local userscript did not expose its hot-reload bridge");
      }
      unsafeWindow.__OFH_LOCAL_BUILD_ID__ = buildId;
      ofhActiveBuildId = buildId;
      ofhClearNotice();
      ofhFinishRequest();
    })
    .then(undefined, (error) => ofhFailRequest("bundle principal", error));
}

function ofhHandleBuildFingerprint(source) {
  const buildId = OFH_BUILD_ID_PATTERN.exec(source)?.[1];
  if (!buildId) throw new Error("invalid local build fingerprint");
  if (typeof unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ !== "function") {
    ofhLoadInitialBuild(buildId);
    return;
  }
  if (!ofhActiveBuildId) {
    unsafeWindow.__OFH_LOCAL_BUILD_ID__ = buildId;
    ofhActiveBuildId = buildId;
    ofhClearNotice();
    ofhFinishRequest();
    return;
  }
  if (buildId === ofhActiveBuildId) {
    ofhClearNotice();
    ofhFinishRequest();
    return;
  }
  ofhLoadNewAutoBot(buildId);
}

function ofhCheckForNewBuild() {
  if (!ofhDirectoryHandle || ofhPausedForPermission || ofhRequestInFlight) return;
  ofhRequestInFlight = true;
  ofhReadBuildFile(OFH_BUILD_ID_FILE)
    .then(ofhHandleBuildFingerprint)
    .then(undefined, (error) => ofhFailRequest("fingerprint del build", error));
}

function ofhRestoreDirectoryAccess() {
  ofhLoadStoredDirectory()
    .then((handle) => {
      if (!handle) {
        ofhShowConnectionPrompt("necesita acceso de lectura al build local.");
        return;
      }
      ofhDirectoryHandle = handle;
      return ofhDirectoryPermission(handle).then((permission) => {
        if (permission === "granted") {
          ofhActivateDirectory(handle);
          return;
        }
        ofhShowConnectionPrompt("Brave necesita confirmar el acceso al build local.");
      });
    })
    .then(undefined, () => {
      ofhShowConnectionPrompt("necesita seleccionar el build local.");
    });
}

window.setInterval(ofhCheckForNewBuild, OFH_POLL_INTERVAL_MS);
ofhRestoreDirectoryAccess();
