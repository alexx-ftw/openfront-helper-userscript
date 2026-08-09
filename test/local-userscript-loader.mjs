import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderPath = path.join(repoRoot, "openfront-helper-loader.user.js");
const buildPath = path.join(repoRoot, "openfront-helper.user.js");
const autoBotBuildPath = path.join(repoRoot, "openfront-helper.autobot.js");
const buildIdPath = path.join(repoRoot, "openfront-helper.build-id.js");
const serverPath = path.join(repoRoot, "scripts", "dev-userscript.mjs");
const loaderSource = fs.readFileSync(loaderPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

assert.match(loaderSource, /@match\s+https:\/\/openfront\.io\/\*/);
assert.match(loaderSource, /@run-at\s+document-start/);
assert.match(loaderSource, /@inject-into\s+page/);
assert.match(loaderSource, /@grant\s+GM_xmlhttpRequest/);
assert.match(loaderSource, /@grant\s+unsafeWindow/);
for (const localPath of [buildIdPath, buildPath, autoBotBuildPath]) {
  assert.match(
    loaderSource,
    new RegExp(pathToFileURL(localPath).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `the installed loader reads ${path.basename(localPath)} directly`,
  );
}
assert.doesNotMatch(loaderSource, /@require\s+/);
assert.match(loaderSource, /GM_xmlhttpRequest/);
assert.match(loaderSource, /__OFH_HOT_RELOAD_AUTOBOT__/);
assert.doesNotMatch(loaderSource, /location\.reload\(\)/);
assert.doesNotMatch(loaderSource, /https?:\/\/localhost|127\.0\.0\.1/);
assert.equal(
  fs.existsSync(serverPath),
  false,
  "the local loader must not need a resident HTTP server",
);
assert.equal(
  Object.hasOwn(packageJson.scripts, "dev:userscript"),
  false,
  "package scripts must not expose the removed local server",
);
assert.equal(fs.existsSync(buildPath), true, "the local build target exists");
assert.equal(fs.existsSync(autoBotBuildPath), true, "the build emits a hot-reloadable bot layer");
assert.equal(fs.existsSync(buildIdPath), true, "the build emits a local reload fingerprint");
assert.match(
  fs.readFileSync(buildPath, "utf8"),
  /__OFH_HOT_RELOAD_AUTOBOT__/,
  "the full build exposes its in-context bot hot-reload bridge",
);
assert.match(
  fs.readFileSync(autoBotBuildPath, "utf8"),
  /disposeForHotReload/,
  "the hot bot layer can stop and replace its previous lifecycle",
);
const buildHash = createHash("sha256").update(fs.readFileSync(buildPath)).digest("hex");
assert.match(
  fs.readFileSync(buildIdPath, "utf8"),
  new RegExp(`__OFH_LOCAL_BUILD_ID__\\s*=\\s*["']${buildHash}["']`),
  "the reload fingerprint identifies the exact generated userscript",
);

const requests = [];
let poll = null;
const evaluatedBuilds = [];
const hotReloads = [];
const initialBuildId = "a".repeat(64);
const unsafeWindow = {
  eval: (source) => evaluatedBuilds.push(source),
  __OFH_HOT_RELOAD_AUTOBOT__: (source, buildId) => {
    hotReloads.push({ source, buildId });
    return true;
  },
};
const loaderSandbox = {
  GM_xmlhttpRequest: (request) => requests.push(request),
  unsafeWindow,
  window: {
    setInterval: (callback) => {
      poll = callback;
    },
  },
};
loaderSandbox.globalThis = loaderSandbox;
executeClassicScript(loaderSource, loaderSandbox, { filename: "local-loader.user.js" });
assert.equal(typeof poll, "function", "the loader polls for local builds while OpenFront is open");
assert.equal(requests.length, 1);
requests[0].onload({
  responseText: `globalThis.__OFH_LOCAL_BUILD_ID__ = "${initialBuildId}";`,
});
assert.equal(requests.length, 2, "startup reads the full local userscript after its fingerprint");
await requests[1].onload({ responseText: "// initial full userscript build" });
assert.deepEqual(evaluatedBuilds, ["// initial full userscript build"]);
poll();
assert.equal(requests.length, 3);
requests[2].onload({
  responseText: `globalThis.__OFH_LOCAL_BUILD_ID__ = "${initialBuildId}";`,
});
assert.equal(hotReloads.length, 0, "an unchanged build does not restart the bot");
poll();
requests[3].onload({
  responseText: `globalThis.__OFH_LOCAL_BUILD_ID__ = "${"b".repeat(64)}";`,
});
assert.equal(requests.length, 5, "a changed fingerprint fetches the new bot layer");
await requests[4].onload({ responseText: "// freshly built bot layer" });
assert.deepEqual(
  hotReloads,
  [{ source: "// freshly built bot layer", buildId: "b".repeat(64) }],
  "a new local build hot-restarts the bot without reloading the game",
);

process.stdout.write("serverless auto-reloading userscript loader tests passed\n");
