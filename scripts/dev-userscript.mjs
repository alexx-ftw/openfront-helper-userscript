import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

export const LOCAL_HOST = "127.0.0.1";
export const LOCAL_PORT = 17373;
export const USERSCRIPT_PATH = "/openfront-helper.user.js";

const WATCH_TARGETS = ["build.mjs", "package.json", "src", "engine", "locales"];

const log = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
  };
}

export function createLocalUserscriptServer({ rootDir = PROJECT_ROOT } = {}) {
  const bundlePath = path.resolve(rootDir, "openfront-helper.user.js");

  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...headers,
        "Access-Control-Allow-Headers": "Cache-Control, Content-Type",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      });
      response.end();
      return;
    }

    if (requestUrl.pathname !== USERSCRIPT_PATH) {
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

    if (!fs.existsSync(bundlePath)) {
      response.writeHead(503, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Build not found; run npm run dev:userscript\n");
      return;
    }

    const bundle = fs.readFileSync(bundlePath);
    response.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Content-Length": bundle.byteLength,
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(bundle);
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
  if (!Number.isFinite(interval) || interval < 250) return 500;
  return interval;
}

function startDevServer() {
  const rootDir = PROJECT_ROOT;
  const host = LOCAL_HOST;
  const port = parsePort(process.env.OFH_DEV_PORT);
  const pollInterval = parsePollInterval(process.env.OFH_DEV_POLL_MS);
  const server = createLocalUserscriptServer({ rootDir });
  let building = false;
  let queuedBuild = false;
  let activeBuild = null;
  let shuttingDown = false;

  const finishBuild = (child, code, error) => {
    if (activeBuild !== child) return;
    activeBuild = null;
    building = false;
    if (error) {
      log(`[dev] build process error: ${error.message}`);
    } else if (code !== 0) {
      log(`[dev] build exited with code ${code}`);
    } else {
      log("[dev] local userscript rebuilt");
    }
    if (queuedBuild && !shuttingDown) {
      queuedBuild = false;
      runBuild();
    }
  };

  function runBuild() {
    if (shuttingDown) return;
    if (building) {
      queuedBuild = true;
      return;
    }
    building = true;
    const child = spawn(process.execPath, [path.join(rootDir, "build.mjs")], {
      cwd: rootDir,
      env: { ...process.env, OFH_LOCAL_DEV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeBuild = child;
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("error", (error) => finishBuild(child, 1, error));
    child.once("close", (code) => finishBuild(child, code ?? 1, null));
  }

  let previousSnapshot = snapshotSources(rootDir);
  const watchTimer = setInterval(() => {
    const nextSnapshot = snapshotSources(rootDir);
    if (nextSnapshot === previousSnapshot) return;
    previousSnapshot = nextSnapshot;
    runBuild();
  }, pollInterval);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(watchTimer);
    if (activeBuild) activeBuild.kill("SIGTERM");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(port, host, () => {
    const actualPort = server.address().port;
    log(`[dev] serving ${path.join(rootDir, "openfront-helper.user.js")}`);
    log(`[dev] loader URL: http://${host}:${actualPort}${USERSCRIPT_PATH}`);
    log(`[dev] watching sources every ${pollInterval} ms; press Ctrl+C to stop`);
    runBuild();
  });
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) startDevServer();
