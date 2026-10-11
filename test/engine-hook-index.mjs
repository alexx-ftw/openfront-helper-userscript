import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foreignGitEnvironment } from "../scripts/git-environment.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-engine-hook-"));
const engine = path.join(temporary, "openfront-engine");
const script = path.join(temporary, "scripts/update-openfront-engine.mjs");
const fixtureEnvironment = foreignGitEnvironment();
const git = (cwd, args, env = fixtureEnvironment) =>
  execFileSync("/usr/bin/git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  fs.mkdirSync(engine);
  fs.mkdirSync(path.dirname(script));
  fs.copyFileSync(new URL("../scripts/update-openfront-engine.mjs", import.meta.url), script);
  fs.copyFileSync(
    new URL("../scripts/git-environment.mjs", import.meta.url),
    path.join(temporary, "scripts/git-environment.mjs"),
  );
  for (const cwd of [temporary, engine]) {
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.name", "Hook test"]);
    git(cwd, ["config", "user.email", "hook@example.invalid"]);
  }
  fs.writeFileSync(path.join(engine, "tracked"), "original\n");
  git(engine, ["add", "tracked"]);
  git(engine, ["commit", "-qm", "fixture"]);
  git(temporary, ["add", "openfront-engine"]);
  git(temporary, ["commit", "-qm", "fixture"]);
  const alternateIndex = path.join(temporary, "alternate-index");
  fs.copyFileSync(path.join(temporary, ".git/index"), alternateIndex);
  const env = {
    ...fixtureEnvironment,
    GIT_DIR: path.join(temporary, ".git"),
    GIT_INDEX_FILE: alternateIndex,
    GIT_WORK_TREE: temporary,
  };
  const originalIndex = fs.readFileSync(alternateIndex);
  const run = () =>
    spawnSync(process.execPath, [script, "--check"], { cwd: temporary, env, encoding: "utf8" });
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(
    fs.readFileSync(alternateIndex),
    originalIndex,
    "checking must not stage changes",
  );
  assert.equal(git(engine, ["status", "--porcelain"]), "");
  fs.writeFileSync(path.join(engine, "tracked"), "real dirty change\n");
  const dirty = run();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /local changes/);
  fs.writeFileSync(path.join(engine, "tracked"), "original\n");
  git(engine, ["commit", "--allow-empty", "-qm", "different revision"]);
  const mismatch = run();
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /staged revision/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
process.stdout.write("engine hook index isolation tests passed\n");
