#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-scenario-log-drain-"));
const runnerPath = path.resolve("scripts/headless/run-scenario.mjs");
const preloadPath = path.join(tempDir, "delayed-log-preload.cjs");

fs.writeFileSync(
  preloadPath,
  `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const moduleApi = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");

const appendFile = fs.appendFile;
fs.createWriteStream = (filePath) => {
  fs.writeFileSync(filePath, "");
  const stream = new Writable({
    write(chunk, encoding, callback) {
      setTimeout(() => {
        if (process.env.OFH_FIXTURE_LOG_ERROR === "async") {
          callback(new Error("injected delayed log error"));
        } else {
          appendFile(filePath, chunk, callback);
        }
      }, 100);
    },
  });
  if (process.env.OFH_FIXTURE_LOG_ERROR === "sync") {
    stream.end = () => {
      throw new Error("injected synchronous log.end error");
    };
  }
  return stream;
};

childProcess.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let ended = 0;
  const onEnd = () => {
    ended += 1;
    if (ended === 2) child.emit("close", 0, null);
  };
  child.stdout.once("end", onEnd);
  child.stderr.once("end", onEnd);
  queueMicrotask(() => {
    child.stdout.end(Buffer.from(JSON.stringify({ phase: "result", result: { stopReason: "winner" } }) + "\\n"));
    child.stderr.end();
  });
  return child;
};
moduleApi.syncBuiltinESMExports();
`,
);

function runFixture(name, logError = "none") {
  const outDir = path.join(tempDir, name);
  const child = spawnSync(
    process.execPath,
    ["--require", preloadPath, runnerPath, "--only", "control-ffa", "--out", outDir],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        OFH_FIXTURE_LOG_ERROR: logError,
        OFH_RUNNER_TIMEOUT_MS: "3000",
      },
    },
  );
  return { ...child, outDir };
}

try {
  const delayedWrite = runFixture("delayed-write");
  assert.equal(delayedWrite.error, undefined, "delayed write probe must not hang");
  assert.equal(
    delayedWrite.status,
    0,
    `wait for queued log bytes before parsing the result:\n${delayedWrite.stdout}\n${delayedWrite.stderr}`,
  );
  assert.match(delayedWrite.stdout, /1\/1 passed/);
  assert.match(
    fs.readFileSync(path.join(delayedWrite.outDir, "control-ffa.log"), "utf8"),
    /"phase":"result"/,
  );

  const logError = runFixture("log-error", "async");
  assert.equal(logError.error, undefined, "log error probe must settle instead of hanging");
  assert.equal(logError.status, 1, "a failed log write must fail the runner");
  assert.match(logError.stdout, /FAIL \(log write error/);

  const syncEndError = runFixture("sync-end-error", "sync");
  assert.equal(syncEndError.error, undefined, "synchronous log.end throw must not hang");
  assert.equal(syncEndError.status, 1, "a synchronous log.end throw must fail the runner");
  assert.match(syncEndError.stderr, /injected synchronous log\.end error/);

  process.stdout.write("headless scenario delayed-log drain tests passed\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
