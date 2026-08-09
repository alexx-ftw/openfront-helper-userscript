import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderPath = path.join(repoRoot, "openfront-helper-loader.user.js");
const buildPath = path.join(repoRoot, "openfront-helper.user.js");
const autoBotBuildPath = path.join(repoRoot, "openfront-helper.autobot.js");
const buildIdPath = path.join(repoRoot, "openfront-helper.build-id.js");
const serverPath = path.join(repoRoot, "scripts", "dev-userscript.mjs");
const loaderSource = fs.readFileSync(loaderPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

assert.match(loaderSource, /@version\s+1\.4\.0/);
assert.match(loaderSource, /@match\s+https:\/\/openfront\.io\/\*/);
assert.match(loaderSource, /@run-at\s+document-start/);
assert.match(loaderSource, /@grant\s+unsafeWindow/);
assert.doesNotMatch(loaderSource, /GM_xmlhttpRequest|file:\/\//);
assert.match(loaderSource, /showDirectoryPicker/);
assert.match(loaderSource, /indexedDB/);
assert.match(loaderSource, /getFileHandle/);
for (const fileName of [
  path.basename(buildIdPath),
  path.basename(buildPath),
  path.basename(autoBotBuildPath),
]) {
  assert.match(loaderSource, new RegExp(fileName.replaceAll(".", "\\.")));
}
assert.doesNotMatch(loaderSource, /location\.reload\(\)/);
assert.doesNotMatch(loaderSource, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
assert.equal(fs.existsSync(serverPath), false, "the local loader needs no resident HTTP server");
assert.equal(Object.hasOwn(packageJson.scripts, "dev:userscript"), false);
assert.equal(fs.existsSync(buildPath), true);
assert.equal(fs.existsSync(autoBotBuildPath), true);
assert.equal(fs.existsSync(buildIdPath), true);
assert.match(fs.readFileSync(buildPath, "utf8"), /__OFH_HOT_RELOAD_AUTOBOT__/);
assert.match(fs.readFileSync(autoBotBuildPath, "utf8"), /disposeForHotReload/);
const buildHash = createHash("sha256").update(fs.readFileSync(autoBotBuildPath)).digest("hex");
assert.match(
  fs.readFileSync(buildIdPath, "utf8"),
  new RegExp(`__OFH_LOCAL_BUILD_ID__\\s*=\\s*["']${buildHash}["']`),
);

async function settlePromises(rounds = 5) {
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function createDocument() {
  const byId = new Map();
  const register = (node) => {
    if (node?.id) byId.set(node.id, node);
    for (const child of node?.children || []) register(child);
  };
  const node = (tagName = "div") => ({
    tagName,
    style: {},
    children: [],
    parentNode: null,
    textContent: "",
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
        register(child);
      }
    },
    replaceChildren(...children) {
      this.children = [];
      this.textContent = children.map((child) => child.textContent || "").join("");
      this.append(...children);
    },
    remove() {
      if (this.id) byId.delete(this.id);
      this.parentNode = null;
    },
    addEventListener(type, callback) {
      if (type === "click") this.click = callback;
    },
  });
  const root = node("html");
  return {
    document: {
      documentElement: root,
      body: null,
      createElement: node,
      createTextNode: (text) => ({ textContent: String(text), children: [], parentNode: null }),
      getElementById: (id) => byId.get(id) || null,
    },
    getById: (id) => byId.get(id) || null,
  };
}

function scheduleIndexedRequest(request, transaction, result) {
  Promise.resolve().then(() => {
    request.result = result;
    request.onsuccess?.();
    Promise.resolve().then(() => transaction.oncomplete?.());
  });
}

function createIndexedDatabase(initialHandle) {
  const state = { storedHandle: initialHandle };
  let storeCreated = false;
  const database = {
    objectStoreNames: { contains: () => storeCreated },
    createObjectStore: () => {
      storeCreated = true;
    },
    close() {},
    transaction: () => {
      const transaction = {
        error: null,
        objectStore: () => ({
          get: () => {
            const request = {};
            scheduleIndexedRequest(request, transaction, state.storedHandle);
            return request;
          },
          put: (handle) => {
            const request = {};
            state.storedHandle = handle;
            scheduleIndexedRequest(request, transaction, handle);
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  return {
    api: {
      open: () => {
        const request = { result: database };
        Promise.resolve().then(() => {
          if (!storeCreated) request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
    storedHandle: () => state.storedHandle,
  };
}

function createDirectory(files, permission = "granted") {
  let currentPermission = permission;
  return {
    queryPermission: () => Promise.resolve(currentPermission),
    requestPermission: () => {
      currentPermission = "granted";
      return Promise.resolve(currentPermission);
    },
    getFileHandle: (fileName) => {
      if (!Object.hasOwn(files, fileName)) {
        const error = new Error(`${fileName} missing`);
        error.name = "NotFoundError";
        return Promise.reject(error);
      }
      return Promise.resolve({
        getFile: () => Promise.resolve({ text: () => Promise.resolve(files[fileName]) }),
      });
    },
  };
}

function createLoaderSandbox({ directory, stored = true }) {
  const rendered = createDocument();
  const database = createIndexedDatabase(stored ? directory : undefined);
  const evaluatedBuilds = [];
  const hotReloads = [];
  const errors = [];
  let poll = null;
  let pickerCalls = 0;
  const unsafeWindow = {
    indexedDB: database.api,
    showDirectoryPicker: () => {
      pickerCalls++;
      return Promise.resolve(directory);
    },
    eval: (source) => {
      evaluatedBuilds.push(source);
      unsafeWindow.__OFH_HOT_RELOAD_AUTOBOT__ = (sourceCode, buildId) => {
        hotReloads.push({ source: sourceCode, buildId });
        return true;
      };
    },
  };
  const sandbox = {
    console: { error: (...parts) => errors.push(parts.join(" ")) },
    document: rendered.document,
    unsafeWindow,
    window: {
      setInterval: (callback) => {
        poll = callback;
      },
      setTimeout: (callback) => callback(),
    },
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(loaderSource, sandbox, { filename: "local-loader.user.js" });
  return {
    database,
    errors,
    evaluatedBuilds,
    getById: rendered.getById,
    hotReloads,
    pickerCalls: () => pickerCalls,
    poll: () => poll,
  };
}

const initialBuildId = "a".repeat(64);
const nextBuildId = "b".repeat(64);
const files = {
  [path.basename(buildIdPath)]: `globalThis.__OFH_LOCAL_BUILD_ID__ = "${initialBuildId}";`,
  [path.basename(buildPath)]: "// initial full userscript build",
  [path.basename(autoBotBuildPath)]: "// freshly built bot layer",
};
const persistedDirectory = createDirectory(files);
const persisted = createLoaderSandbox({ directory: persistedDirectory });
await settlePromises();
assert.deepEqual(
  persisted.evaluatedBuilds,
  ["// initial full userscript build"],
  `errors=${persisted.errors.join(" | ")} connect=${Boolean(
    persisted.getById("openfront-helper-local-loader-connect"),
  )}`,
);
assert.equal(typeof persisted.poll(), "function");
persisted.poll()();
await settlePromises();
assert.equal(persisted.hotReloads.length, 0, "an unchanged build does not restart the bot");
files[path.basename(buildIdPath)] = `globalThis.__OFH_LOCAL_BUILD_ID__ = "${nextBuildId}";`;
persisted.poll()();
await settlePromises();
assert.deepEqual(
  persisted.hotReloads,
  [{ source: "// freshly built bot layer", buildId: nextBuildId }],
  "a new local build hot-restarts the bot without reloading the game",
);

const promptedFiles = {
  ...files,
  [path.basename(buildIdPath)]: `globalThis.__OFH_LOCAL_BUILD_ID__ = "${initialBuildId}";`,
};
const promptedDirectory = createDirectory(promptedFiles);
const prompted = createLoaderSandbox({ directory: promptedDirectory, stored: false });
await settlePromises();
const connectButton = prompted.getById("openfront-helper-local-loader-connect");
assert.equal(typeof connectButton?.click, "function", "a first run offers a directory picker");
connectButton.click();
await settlePromises();
assert.equal(prompted.pickerCalls(), 1);
assert.strictEqual(prompted.database.storedHandle(), promptedDirectory);
assert.deepEqual(prompted.evaluatedBuilds, ["// initial full userscript build"]);

const permissionDirectory = createDirectory(promptedFiles, "prompt");
const permissionPrompt = createLoaderSandbox({ directory: permissionDirectory });
await settlePromises();
const permissionButton = permissionPrompt.getById("openfront-helper-local-loader-connect");
assert.equal(typeof permissionButton?.click, "function", "a restored handle can renew permission");
permissionButton.click();
await settlePromises();
assert.equal(permissionPrompt.pickerCalls(), 0, "permission renewal reuses the stored directory");
assert.deepEqual(permissionPrompt.evaluatedBuilds, ["// initial full userscript build"]);

process.stdout.write("serverless File System Access hot-reload loader tests passed\n");
