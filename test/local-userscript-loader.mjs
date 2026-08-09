import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderPath = path.join(repoRoot, "openfront-helper-loader.user.js");
const buildPath = path.join(repoRoot, "openfront-helper.user.js");
const serverPath = path.join(repoRoot, "scripts", "dev-userscript.mjs");
const loaderSource = fs.readFileSync(loaderPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

assert.match(loaderSource, /@match\s+https:\/\/openfront\.io\/\*/);
assert.match(loaderSource, /@run-at\s+document-start/);
assert.match(loaderSource, /@inject-into\s+page/);
assert.match(loaderSource, /@grant\s+none/);
assert.match(
  loaderSource,
  new RegExp(`@require\\s+${pathToFileURL(buildPath).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  "the installed loader reads this checkout's generated build directly",
);
assert.doesNotMatch(loaderSource, /GM_xmlhttpRequest|https?:\/\/localhost|127\.0\.0\.1/);
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

process.stdout.write("serverless local userscript loader tests passed\n");
