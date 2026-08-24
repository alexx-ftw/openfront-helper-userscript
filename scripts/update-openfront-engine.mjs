import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const engineDirectory = resolve(repositoryRoot, "openfront-engine");

function git(arguments_, options = {}) {
  const output = execFileSync("/usr/bin/git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

if (!existsSync(resolve(engineDirectory, ".git"))) {
  git(["submodule", "update", "--init", "--", "openfront-engine"], { stdio: "inherit" });
}

const dirtyState = git(["-C", engineDirectory, "status", "--porcelain"]);
if (dirtyState !== "") {
  throw new Error("openfront-engine has local changes; refusing to replace them");
}

const previousRevision = git(["-C", engineDirectory, "rev-parse", "HEAD"]);
git([
  "-C",
  engineDirectory,
  "fetch",
  "--prune",
  "origin",
  "+refs/heads/main:refs/remotes/origin/main",
]);
git(["-C", engineDirectory, "checkout", "--detach", "refs/remotes/origin/main"], {
  stdio: "inherit",
});
git(["add", "--", "openfront-engine"]);

const currentRevision = git(["-C", engineDirectory, "rev-parse", "HEAD"]);
console.warn(`OpenFront engine: ${previousRevision} -> ${currentRevision}`);
