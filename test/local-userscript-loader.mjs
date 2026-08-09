import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "manifest.json");
const mainLoaderPath = path.join(repoRoot, "openfront-helper-local-main.js");
const pollerPath = path.join(repoRoot, "openfront-helper-local-poller.js");
const migrationLoaderPath = path.join(repoRoot, "openfront-helper-loader.user.js");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.0");
assert.deepEqual(manifest.host_permissions, ["https://openfront.io/*"]);
assert.equal(manifest.background, undefined, "the local loader needs no resident service worker");
assert.deepEqual(
  manifest.content_scripts.map(({ js, world }) => ({ js, world })),
  [
    { js: ["openfront-helper-local-main.js"], world: "MAIN" },
    { js: ["openfront-helper-local-poller.js"], world: "ISOLATED" },
  ],
);

const mainSource = fs.readFileSync(mainLoaderPath, "utf8");
const pollerSource = fs.readFileSync(pollerPath, "utf8");
const migrationLoaderSource = fs.readFileSync(migrationLoaderPath, "utf8");
for (const source of [mainSource, pollerSource, migrationLoaderSource]) {
  assert.doesNotMatch(source, /file:\/\/|127\.0\.0\.1|localhost|showDirectoryPicker/);
}
assert.match(migrationLoaderSource, /@version\s+2\.0\.0/u);
assert.match(migrationLoaderSource, /Cargar descomprimida/u);

function createEventWindow() {
  const target = new EventTarget();
  target.window = target;
  return target;
}

async function settlePromises() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const mainWindow = createEventWindow();
const mainResults = [];
mainWindow.addEventListener("openfront-helper-local-result", (event) => {
  mainResults.push(event.detail);
});
const mainSandbox = {
  CustomEvent,
  console,
  window: mainWindow,
};
vm.createContext(mainSandbox);
// The test executes the real loader artifact inside a controlled VM realm.
// eslint-disable-next-line sonarjs/code-eval
new vm.Script(mainSource, { filename: "openfront-helper-local-main.js" }).runInContext(mainSandbox);
assert.equal(mainWindow.__OFH_LOCAL_EXTENSION_VERSION__, "1.0.0");

mainWindow.dispatchEvent(
  new CustomEvent("openfront-helper-local-source", {
    detail: {
      buildId: "a".repeat(64),
      mode: "initial",
      requestId: "initial-1",
      source:
        "window.__OFH_TEST_INITIAL__ = 1; window.__OFH_HOT_RELOAD_AUTOBOT__ = async () => true;",
    },
  }),
);
await settlePromises();
assert.equal(mainWindow.__OFH_TEST_INITIAL__, 1, "the initial local build runs in MAIN world");
assert.deepEqual(JSON.parse(JSON.stringify(mainResults.at(-1))), {
  buildId: "a".repeat(64),
  ok: true,
  requestId: "initial-1",
});

let hotReloadCall = null;
mainWindow.__OFH_HOT_RELOAD_AUTOBOT__ = async (source, buildId) => {
  hotReloadCall = { buildId, source };
  return true;
};
mainWindow.dispatchEvent(
  new CustomEvent("openfront-helper-local-source", {
    detail: {
      buildId: "b".repeat(64),
      mode: "hot",
      requestId: "hot-1",
      source: "// changed Auto-Bot layer",
    },
  }),
);
await settlePromises();
assert.deepEqual(hotReloadCall, {
  buildId: "b".repeat(64),
  source: "// changed Auto-Bot layer",
});
assert.deepEqual(JSON.parse(JSON.stringify(mainResults.at(-1))), {
  buildId: "b".repeat(64),
  ok: true,
  requestId: "hot-1",
});

const pollerWindow = createEventWindow();
const sourceRequests = [];
let intervalCallback = null;
let currentBuildId = "c".repeat(64);
pollerWindow.setInterval = (callback) => {
  intervalCallback = callback;
};
pollerWindow.setTimeout = setTimeout;
pollerWindow.clearTimeout = clearTimeout;
pollerWindow.addEventListener("openfront-helper-local-source", (event) => {
  sourceRequests.push(event.detail);
  pollerWindow.dispatchEvent(
    new CustomEvent("openfront-helper-local-result", {
      detail: {
        buildId: event.detail.buildId,
        ok: true,
        requestId: event.detail.requestId,
      },
    }),
  );
});
const fetchCalls = [];
const pollerSandbox = {
  CustomEvent,
  URL,
  crypto,
  console,
  fetch: async (url, options) => {
    fetchCalls.push({ options, url: String(url) });
    const fileName = String(url).split("/").at(-1).split("?")[0];
    let body = "// changed local Auto-Bot";
    if (fileName === "openfront-helper.build-id.js") {
      body = `globalThis.__OFH_LOCAL_BUILD_ID__ = "${currentBuildId}";`;
    } else if (fileName === "openfront-helper.user.js") {
      body = "// full local build";
    }
    return { ok: true, text: async () => body };
  },
  chrome: {
    runtime: {
      getURL: (fileName) => `chrome-extension://test/${fileName}`,
    },
  },
  window: pollerWindow,
};
vm.createContext(pollerSandbox);
// The test executes the real poller artifact inside a controlled VM realm.
// eslint-disable-next-line sonarjs/code-eval
new vm.Script(pollerSource, { filename: "openfront-helper-local-poller.js" }).runInContext(
  pollerSandbox,
);
await settlePromises();
assert.equal(typeof intervalCallback, "function");
assert.equal(sourceRequests.length, 1);
assert.equal(sourceRequests[0].mode, "initial");
assert.equal(sourceRequests[0].source, "// full local build");

await intervalCallback();
await settlePromises();
assert.equal(sourceRequests.length, 1, "an unchanged build is not reinjected");

currentBuildId = "d".repeat(64);
await intervalCallback();
await settlePromises();
assert.equal(sourceRequests.length, 2);
assert.equal(sourceRequests[1].mode, "hot");
assert.equal(sourceRequests[1].source, "// changed local Auto-Bot");
assert.ok(fetchCalls.every(({ options }) => options.cache === "no-store"));

process.stdout.write("serverless Brave extension hot-reload loader tests passed\n");
