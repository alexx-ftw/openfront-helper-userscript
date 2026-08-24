import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

export const LOCAL_HOST = "127.0.0.1";
export const LOCAL_PORT = 17373;
export const BUILD_ID_PATH = "/openfront-helper.build-id.js";
export const FULL_BUILD_PATH = "/openfront-helper.user.js";
export const AUTO_BOT_PATH = "/openfront-helper.autobot.js";

const ROUTES = new Map([
  [BUILD_ID_PATH, "openfront-helper.build-id.js"],
  [FULL_BUILD_PATH, "openfront-helper.user.js"],
  [AUTO_BOT_PATH, "openfront-helper.autobot.js"],
]);
const WATCH_TARGETS = ["build.mjs", "package.json", "src", "engine", "locales"];

const log = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);

function responseHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://openfront.io",
    "Access-Control-Allow-Private-Network": "true",
  };
}

export function createLocalUserscriptServer({ rootDir = PROJECT_ROOT } = {}) {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const headers = responseHeaders();

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...headers,
        "Access-Control-Allow-Headers": "Cache-Control, Content-Type",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      });
      response.end();
      return;
    }

    const relativeFile = ROUTES.get(requestUrl.pathname);
    if (!relativeFile) {
      response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        ...headers,
        Allow: "GET, HEAD, OPTIONS",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Method not allowed\n");
      return;
    }

    const filePath = path.resolve(rootDir, relativeFile);
    if (!fs.existsSync(filePath)) {
      response.writeHead(503, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Build not found; run npm run dev:userscript\n");
      return;
    }
    const source = fs.readFileSync(filePath);
    response.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Content-Length": source.byteLength,
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : source);
  });
}

function snapshotTarget(rootDir, relativePath, entries) {
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolutePath)) {
      snapshotTarget(rootDir, path.join(relativePath, child), entries);
    }
    return;
  }
  entries.push(`${relativePath}:${stat.mtimeMs}:${stat.size}`);
}

function snapshotSources(rootDir) {
  const entries = [];
  for (const target of WATCH_TARGETS) snapshotTarget(rootDir, target, entries);
  return entries.sort().join("\n");
}

function parsePort(rawPort) {
  const port = Number(rawPort ?? LOCAL_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`OFH_DEV_PORT must be an integer from 0 to 65535, got ${rawPort}`);
  }
  return port;
}

function parsePollInterval(rawInterval) {
  const interval = Number(rawInterval ?? 500);
  return Number.isFinite(interval) && interval >= 250 ? interval : 500;
}

function startDevServer() {
  const rootDir = PROJECT_ROOT;
  const port = parsePort(process.env.OFH_DEV_PORT);
  const pollInterval = parsePollInterval(process.env.OFH_DEV_POLL_MS);
  const server = createLocalUserscriptServer({ rootDir });
  let activeBuild = null;
  let queuedBuild = false;
  let shuttingDown = false;

  function finishBuild(child, code, error) {
    if (activeBuild !== child) return;
    activeBuild = null;
    if (error) log(`[dev] build process error: ${error.message}`);
    else if (code !== 0) log(`[dev] build exited with code ${code}`);
    else log("[dev] local userscript rebuilt");
    if (queuedBuild && !shuttingDown) {
      queuedBuild = false;
      runBuild();
    }
  }

  function runBuild() {
    if (shuttingDown) return;
    if (activeBuild) {
      queuedBuild = true;
      return;
    }
    const child = spawn(process.execPath, [path.join(rootDir, "build.mjs")], {
      cwd: rootDir,
      env: { ...process.env, OFH_LOCAL_DEV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeBuild = child;
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("error", (error) => finishBuild(child, 1, error));
    child.once("close", (code) => finishBuild(child, code ?? 1));
  }

  let previousSnapshot = snapshotSources(rootDir);
  const watchTimer = setInterval(() => {
    const nextSnapshot = snapshotSources(rootDir);
    if (nextSnapshot === previousSnapshot) return;
    previousSnapshot = nextSnapshot;
    runBuild();
  }, pollInterval);

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(watchTimer);
    activeBuild?.kill("SIGTERM");
    server.close(() => process.exit(0));
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(port, LOCAL_HOST, () => {
    const actualPort = server.address().port;
    log(`[dev] loader root: http://${LOCAL_HOST}:${actualPort}`);
    log(`[dev] watching local sources every ${pollInterval} ms; press Ctrl+C to stop`);
    runBuild();
  });
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) startDevServer();
