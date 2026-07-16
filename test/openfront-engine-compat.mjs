import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const engineDirectory = resolve(repositoryRoot, "openfront-engine");

function git(arguments_) {
  return execFileSync("/usr/bin/git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

const modules = readFileSync(resolve(repositoryRoot, ".gitmodules"), "utf8");
assert.match(modules, /path = openfront-engine/u);
assert.match(modules, /url = https:\/\/github\.com\/openfrontio\/openfrontio/u);
assert.match(modules, /branch = main/u);

const gitlink = git(["ls-files", "--stage", "--", "openfront-engine"]);
assert.match(gitlink, /^160000 [0-9a-f]{40} 0\s+openfront-engine$/u);
assert.equal(
  git(["-C", engineDirectory, "remote", "get-url", "origin"]),
  "https://github.com/openfrontio/openfrontio",
);
assert.equal(
  git(["-C", engineDirectory, "rev-parse", "HEAD"]),
  git(["-C", engineDirectory, "rev-parse", "refs/remotes/origin/main"]),
);
assert.equal(git(["-C", engineDirectory, "status", "--porcelain"]), "");

const enginePackage = JSON.parse(readFileSync(resolve(engineDirectory, "package.json"), "utf8"));
assert.equal(enginePackage.name, "openfront-client");

const gameRunner = readFileSync(resolve(engineDirectory, "src/core/GameRunner.ts"), "utf8");
assert.match(gameRunner, /export async function createGameRunner/u);
assert.match(gameRunner, /export class GameRunner/u);

console.warn(`OpenFront engine compatibility passed at ${gitlink.split(" ")[1]}`);
