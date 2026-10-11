import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { foreignGitEnvironment } from "./git-environment.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const engineDirectory = resolve(repositoryRoot, "openfront-engine");
const checkOnly = process.argv.includes("--check");

function git(arguments_, options = {}) {
  const output = execFileSync("/usr/bin/git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

// Hooks export repository-local Git variables; none belong to the nested engine.
const engineEnvironment = foreignGitEnvironment();
const engineGit = (arguments_, options = {}) =>
  git(["-C", engineDirectory, ...arguments_], { ...options, env: engineEnvironment });

if (!existsSync(resolve(engineDirectory, ".git"))) {
  if (checkOnly) throw new Error("openfront-engine is not initialized");
  git(["submodule", "update", "--init", "--", "openfront-engine"], { stdio: "inherit" });
}

const dirtyState = engineGit(["status", "--porcelain"]);
if (dirtyState !== "") {
  throw new Error("openfront-engine has local changes; refusing to replace them");
}

const previousRevision = engineGit(["rev-parse", "HEAD"]);
if (checkOnly) {
  const stagedEngine = git(["ls-files", "--stage", "--", "openfront-engine"]);
  if (stagedEngine !== `160000 ${previousRevision} 0\topenfront-engine`) {
    throw new Error("openfront-engine does not match its staged revision");
  }
  process.stdout.write(`OpenFront engine checked: ${previousRevision}\n`);
  process.exit(0);
}
engineGit(["fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
engineGit(["checkout", "--detach", "refs/remotes/origin/main"], {
  stdio: "inherit",
});
git(["add", "--", "openfront-engine"]);

const currentRevision = engineGit(["rev-parse", "HEAD"]);
process.stdout.write(`OpenFront engine: ${previousRevision} -> ${currentRevision}\n`);
