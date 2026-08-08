import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalUserscriptServer, USERSCRIPT_PATH } from "../scripts/dev-userscript.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderPath = path.join(repoRoot, "openfront-helper-loader.user.js");
const loaderSource = fs.readFileSync(loaderPath, "utf8");

assert.match(loaderSource, /@match\s+https:\/\/openfront\.io\/\*/);
assert.match(loaderSource, /@grant\s+GM_xmlhttpRequest/);
assert.match(loaderSource, /@connect\s+127\.0\.0\.1/);
assert.match(loaderSource, /GM_xmlhttpRequest\(\{/);
assert.match(loaderSource, /openfront-helper\.user\.js/);
assert.match(loaderSource, /source\.includes\("window\.__OFH_ASSETS"\)/);

const server = createLocalUserscriptServer({ rootDir: repoRoot });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

const address = server.address();
assert.equal(typeof address, "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const response = await fetch(`${baseUrl}${USERSCRIPT_PATH}?cacheBust=test`);
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
assert.equal(response.headers.get("access-control-allow-origin"), "*");
const bundle = await response.text();
assert.match(bundle, /^\/\/ ==UserScript==/);
assert.match(bundle, /window\.__OFH_ASSETS/);

const headResponse = await fetch(`${baseUrl}${USERSCRIPT_PATH}`, { method: "HEAD" });
assert.equal(headResponse.status, 200);
assert.equal(await headResponse.text(), "");

const missingResponse = await fetch(`${baseUrl}/missing.js`);
assert.equal(missingResponse.status, 404);

await new Promise((resolve) => {
  server.close(() => {
    resolve();
  });
});
process.stdout.write("local userscript loader/server tests passed\n");
