#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-scenario-child-exit-"));
const runnerPath = path.join(repoDir, "scripts/headless/run-scenario.mjs");
const preloadPath = path.join(tempDir, "failed-child.cjs");

fs.writeFileSync(
  preloadPath,
  String.raw`
const childProcess = require("node:child_process");
const moduleApi = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

childProcess.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let ended = 0;
  const onEnd = () => {
    if (++ended === 2) child.emit("close", 2, null);
  };
  child.stdout.once("end", onEnd);
  child.stderr.once("end", onEnd);
  queueMicrotask(() => {
    const result = JSON.parse(process.env.OFH_FIXTURE_RESULT);
    child.stdout.end(
      JSON.stringify({ phase: "result", result }) + "\n",
    );
    child.stderr.end();
  });
  return child;
};
moduleApi.syncBuiltinESMExports();
`,
);

const fixture = {
  won: false,
  intentBudgetViolated: false,
  goalRequirements: { ownStructuresNuked: 1 },
  hostileMissileFixture: { injected: true, seen: true, resolved: true },
};
const runChild = (stopReason) =>
  spawnSync(
    process.execPath,
    [
      "--require",
      preloadPath,
      runnerPath,
      "--only",
      "hostile-atom-defense",
      "--out",
      path.join(tempDir, "out"),
    ],
    {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        OFH_FIXTURE_RESULT: JSON.stringify({ ...fixture, stopReason }),
      },
    },
  );

try {
  const failedEngineStop = runChild("engine_stop");
  assert.equal(failedEngineStop.error, undefined, "synthetic child probe must finish");
  assert.equal(
    failedEngineStop.status,
    1,
    `engine_stop must fail even when its assertion passes:\n${failedEngineStop.stdout}\n${failedEngineStop.stderr}`,
  );
  assert.match(failedEngineStop.stdout, /FAIL \(child exit 2;/);
  assert.match(failedEngineStop.stdout, /0\/1 passed/);

  const completedLoss = runChild("bot_dead");
  assert.equal(completedLoss.error, undefined, "completed-loss probe must finish");
  assert.equal(
    completedLoss.status,
    0,
    `a completed bot loss must remain valid:\n${completedLoss.stdout}\n${completedLoss.stderr}`,
  );
  assert.match(completedLoss.stdout, /PASS/);
  assert.match(completedLoss.stdout, /1\/1 passed/);
  process.stdout.write("run-scenario child-exit regression passed\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
