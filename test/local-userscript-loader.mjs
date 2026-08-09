import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  AUTO_BOT_PATH,
  BUILD_ID_PATH,
  FULL_BUILD_PATH,
  createLocalUserscriptServer,
} from "../scripts/dev-userscript.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderPath = path.join(repoRoot, "openfront-helper-loader.user.js");
const loaderSource = fs.readFileSync(loaderPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

assert.match(loaderSource, /@version\s+3\.0\.0/u);
assert.match(loaderSource, /@match\s+https:\/\/openfront\.io\/\*/u);
assert.match(loaderSource, /@grant\s+GM_xmlhttpRequest/u);
assert.match(loaderSource, /@grant\s+unsafeWindow/u);
assert.match(loaderSource, /@connect\s+127\.0\.0\.1/u);
assert.doesNotMatch(loaderSource, /showDirectoryPicker|file:\/\/|chrome-extension:/u);
assert.equal(packageJson.scripts["dev:userscript"], "node scripts/dev-userscript.mjs");
for (const obsoleteExtensionFile of [
  "manifest.json",
  "openfront-helper-local-main.js",
  "openfront-helper-local-poller.js",
]) {
  assert.equal(fs.existsSync(path.join(repoRoot, obsoleteExtensionFile)), false);
}

const buildIds = ["a".repeat(64), "a".repeat(64), "b".repeat(64)];
const requests = [];
const evaluatedBuilds = [];
const hotReloads = [];
let intervalCallback = null;
const unsafeWindow = {
  eval: (source) => {
    evaluatedBuilds.push(source);
    unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ = async (autoBotSource, buildId) => {
      hotReloads.push({ buildId, source: autoBotSource });
      return true;
    };
  },
};
const sandbox = {
  console: { info() {}, warn() {} },
  GM_xmlhttpRequest: (options) => {
    requests.push(options.url);
    const pathname = new URL(options.url).pathname;
    let responseText = "";
    if (pathname === BUILD_ID_PATH) {
      const buildId = buildIds.shift() || "b".repeat(64);
      responseText = `globalThis.__OFH_LOCAL_BUILD_ID__ = "${buildId}";`;
    } else if (pathname === FULL_BUILD_PATH) {
      responseText = "// full userscript from loopback";
    } else if (pathname === AUTO_BOT_PATH) {
      responseText = "// changed Auto-Bot from loopback";
    }
    queueMicrotask(() => options.onload({ responseText, status: 200 }));
  },
  URL,
  unsafeWindow,
  window: {
    setInterval: (callback) => {
      intervalCallback = callback;
    },
  },
};
vm.createContext(sandbox);
// The test executes the real Tampermonkey loader in a controlled realm.
// eslint-disable-next-line sonarjs/code-eval
new vm.Script(loaderSource, { filename: "openfront-helper-loader.user.js" }).runInContext(sandbox);

async function settlePromises() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

await settlePromises();
assert.equal(typeof intervalCallback, "function");
assert.deepEqual(evaluatedBuilds, [
  "// full userscript from loopback\n//# sourceURL=openfront-helper.user.js",
]);
assert.equal(unsafeWindow.__OFH_LOCAL_BUILD_ID__, "a".repeat(64));

intervalCallback();
await settlePromises();
assert.equal(evaluatedBuilds.length, 1, "an unchanged build is not reinjected");
assert.equal(hotReloads.length, 0);

intervalCallback();
await settlePromises();
assert.deepEqual(hotReloads, [
  { buildId: "b".repeat(64), source: "// changed Auto-Bot from loopback" },
]);
assert.equal(unsafeWindow.__OFH_LOCAL_BUILD_ID__, "b".repeat(64));
assert.ok(requests.every((url) => url.startsWith("http://127.0.0.1:17373/")));

const server = createLocalUserscriptServer({ rootDir: repoRoot });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.equal(typeof address, "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
for (const [route, marker] of [
  [BUILD_ID_PATH, /__OFH_LOCAL_BUILD_ID__/u],
  [FULL_BUILD_PATH, /window\.__OFH_ASSETS/u],
  [AUTO_BOT_PATH, /disposeForHotReload/u],
]) {
  const response = await fetch(`${baseUrl}${route}?time=${Date.now()}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await response.text(), marker);
}
assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
await new Promise((resolve) => {
  server.close(resolve);
});

process.stdout.write("official Tampermonkey loopback hot-reload tests passed\n");
