import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, resolved from this module (test/helpers/perf-regressions/) so it is cwd-independent.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function enginePath(relativePath) {
  return path.join(ROOT, relativePath);
}

export function readEngineSource(relativePath) {
  return fs.readFileSync(enginePath(relativePath), "utf8");
}
