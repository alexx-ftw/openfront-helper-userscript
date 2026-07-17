import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(directory, "../..");
const runner = path.join(directory, "run-match.mts");
const tsx = path.join(projectRoot, "node_modules/.bin/tsx");
const logicalProcessors = availableParallelism();
const requestedWorkers = Number(process.env.OFH_SIM_WORKERS ?? logicalProcessors);
const workers = Math.max(1, Math.min(logicalProcessors, Math.floor(requestedWorkers)));
const requestedMatches = Number(process.env.OFH_MATCHES ?? workers);
const matches = Math.max(1, Math.floor(requestedMatches));
const outputDirectory = await mkdtemp(path.join(tmpdir(), "ofh-headless-batch-"));
const batchSeed = process.env.OFH_BATCH_SEED ?? `ofh-batch-${Date.now()}`;
const results = new Array(matches);
let nextMatch = 0;

function parseResultLine(line, state) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{"phase":"result"')) return;
  state.result = JSON.parse(trimmed);
}

function consumeChunk(chunk, state, stream) {
  stream.write(chunk);
  state.pending += chunk.toString();
  const lines = state.pending.split("\n");
  state.pending = lines.pop() ?? "";
  for (const line of lines) parseResultLine(line, state);
}

function runMatch(index) {
  return new Promise((resolve) => {
    const logPath = path.join(outputDirectory, `match-${String(index + 1).padStart(3, "0")}.log`);
    const log = createWriteStream(logPath, { flags: "wx" });
    const state = { pending: "", result: null };
    const child = spawn(
      tsx,
      ["--tsconfig", path.join(projectRoot, "openfront-engine/tsconfig.json"), runner],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          GAME_ENV: "dev",
          OFH_BUNDLE_PATH: path.join(projectRoot, "openfront-helper.user.js"),
          OFH_MATCH_SEED: `${batchSeed}-${index}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => consumeChunk(chunk, state, log));
    child.stderr.on("data", (chunk) => consumeChunk(chunk, state, log));
    child.on("error", (error) => {
      log.end();
      resolve({ index, logPath, error: error.message, result: state.result });
    });
    child.on("close", (code, signal) => {
      if (state.pending) parseResultLine(state.pending, state);
      log.end();
      resolve({ index, logPath, code, signal, result: state.result });
    });
  });
}

async function runWorker() {
  while (nextMatch < matches) {
    const index = nextMatch;
    nextMatch += 1;
    results[index] = await runMatch(index);
    const outcome = results[index].result?.won === true ? "won" : "lost";
    process.stdout.write(
      `${index + 1}/${matches} ${outcome} tick=${results[index].result?.ticks ?? "?"}\n`,
    );
  }
}

process.stdout.write(
  `Running ${matches} matches with ${Math.min(workers, matches)}/${logicalProcessors} workers\n`,
);
process.stdout.write(`Logs: ${outputDirectory}\n`);
await Promise.all(Array.from({ length: Math.min(workers, matches) }, () => runWorker()));

const completed = results.filter((entry) => entry?.result);
const wins = completed.filter((entry) => entry.result.won === true).length;
const runtimeMs = completed.reduce((total, entry) => total + entry.result.runtimeMs, 0);
const summary = {
  matches,
  completed: completed.length,
  wins,
  losses: completed.length - wins,
  winRate: completed.length > 0 ? wins / completed.length : null,
  aggregateRuntimeMs: runtimeMs,
  averageRuntimeMs: completed.length > 0 ? Math.round(runtimeMs / completed.length) : null,
  workers: Math.min(workers, matches),
  logicalProcessors,
  outputDirectory,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = completed.length === matches ? 0 : 1;
