#!/usr/bin/env node

import CDP from "chrome-remote-interface";

function usage() {
  return `OpenFront helper runtime probe

Usage: npm run probe:runtime -- [options]

Options:
  --host <host>              DevTools host (default: 127.0.0.1)
  --port <port>              DevTools port; repeatable (defaults: 9222, 9223)
  --url <text>               Target URL substring (default: openfront)
  --watch <milliseconds>     Keep printing snapshots (minimum: 250)
  --log-limit <count>        Auto-bot/network/long-task entries (default: 100)
  --event-limit <count>      Current match events (default: 200)
  --match-limit <count>      Archived matches (default: 5)
  --enable-profiling         Enable bounded auto-bot profiling before probing
  --enable-loggers           Enable round and network loggers before probing
  --compact                  Emit one JSON line per snapshot
  --help                     Show this help

Chromium must be running with --remote-debugging-port=9222 (or the selected port).`;
}

function readNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${flag} requires a number`);
  return number;
}

// Flat CLI parsing is clearer here than adding another dependency for eleven flags.
// eslint-disable-next-line sonarjs/cognitive-complexity
function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    ports: [],
    url: "openfront",
    watchMs: 0,
    logLimit: 100,
    eventLimit: 200,
    matchLimit: 5,
    enableProfiling: false,
    enableLoggers: false,
    compact: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { ...options, help: true };
    if (arg === "--enable-profiling") options.enableProfiling = true;
    else if (arg === "--enable-loggers") options.enableLoggers = true;
    else if (arg === "--compact") options.compact = true;
    else if (arg === "--host") options.host = argv[++index];
    else if (arg === "--port") options.ports.push(readNumber(argv[++index], arg));
    else if (arg === "--url") options.url = argv[++index];
    else if (arg === "--watch") options.watchMs = Math.max(250, readNumber(argv[++index], arg));
    else if (arg === "--log-limit") options.logLimit = readNumber(argv[++index], arg);
    else if (arg === "--event-limit") options.eventLimit = readNumber(argv[++index], arg);
    else if (arg === "--match-limit") options.matchLimit = readNumber(argv[++index], arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.ports.length === 0) options.ports = [9222, 9223];
  return options;
}

async function findTarget(options) {
  const failures = [];
  for (const port of options.ports) {
    try {
      const targets = await CDP.List({ host: options.host, port });
      const target = targets.find(
        (candidate) => candidate.type === "page" && candidate.url.includes(options.url),
      );
      if (target) return { port, target };
      failures.push(`${port}: no page URL containing ${JSON.stringify(options.url)}`);
    } catch (error) {
      failures.push(`${port}: ${error.message}`);
    }
  }
  throw new Error(`No matching Chromium target found (${failures.join("; ")})`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { port, target } = await findTarget(options);
  const client = await CDP({ host: options.host, port, target });
  const { Runtime } = client;
  await Runtime.enable();
  const configure = {};
  if (options.enableProfiling) configure.performanceProfiling = true;
  if (options.enableLoggers) {
    configure.roundLogger = true;
    configure.networkLogger = true;
  }
  if (Object.keys(configure).length > 0) {
    await Runtime.evaluate({
      expression: `globalThis.__OFH_RUNTIME_DIAGNOSTICS__?.configure(${JSON.stringify(configure)})`,
      returnByValue: true,
    });
  }
  const capture = async () => {
    const response = await Runtime.evaluate({
      expression: `globalThis.__OFH_RUNTIME_DIAGNOSTICS__?.snapshot(${JSON.stringify({
        logLimit: options.logLimit,
        eventLimit: options.eventLimit,
        matchLimit: options.matchLimit,
      })})`,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "Runtime evaluation failed");
    }
    if (response.result.type === "undefined") {
      throw new Error(
        "OpenFront helper diagnostic API is not loaded; rebuild/install and reload the tab",
      );
    }
    const output = {
      target: { host: options.host, port, id: target.id, title: target.title, url: target.url },
      snapshot: response.result.value,
    };
    process.stdout.write(`${JSON.stringify(output, null, options.compact ? 0 : 2)}\n`);
  };
  try {
    await capture();
    while (options.watchMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, options.watchMs);
      });
      await capture();
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`probe:runtime: ${error.message}`);
  process.exitCode = 1;
});
