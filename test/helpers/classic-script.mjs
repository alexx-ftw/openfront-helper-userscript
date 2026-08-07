import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

export function executeClassicScript(source, sandbox, options = {}) {
  if (typeof source !== "string") throw new TypeError("Classic-script source must be text");
  if (sandbox == null || typeof sandbox !== "object") {
    throw new TypeError("Classic-script sandbox must be an object");
  }
  const filename = String(options.filename ?? "trusted-repository-classic-script.js");
  if (filename.includes("\0")) throw new TypeError("Classic-script filename is invalid");
  // This is the single reviewed execution boundary for trusted repository sources
  // used by tests. Each call runs in a fresh, explicitly supplied VM sandbox.
  // eslint-disable-next-line sonarjs/code-eval
  return vm.runInNewContext(source, sandbox, { ...options, filename });
}
