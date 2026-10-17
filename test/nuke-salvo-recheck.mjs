// Orchestrator for the split nuke-salvo-recheck test.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PARTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "nuke-salvo-recheck-parts",
);
const EXPECTED_SHA256 = "f99117f2bb4a980c16a1781446c3a7190b89fd8e0b0024fa7d9d31f7c0c63b82";
const partFiles = fs
  .readdirSync(PARTS_DIR)
  .filter((name) => /^part-\d+\.mjs$/.test(name))
  .sort();
const joined = Buffer.concat(partFiles.map((name) => fs.readFileSync(path.join(PARTS_DIR, name))));
const joinedHash = createHash("sha256").update(joined).digest("hex");
if (joinedHash !== EXPECTED_SHA256) {
  console.error("nuke-salvo-recheck parts hash mismatch: " + joinedHash + " != " + EXPECTED_SHA256);
  process.exitCode = 1;
} else {
  const tempPath = path.join(
    path.dirname(PARTS_DIR),
    ".nuke-salvo-recheck.joined." + process.pid + ".mjs",
  );
  try {
    fs.writeFileSync(tempPath, joined);
    await import(pathToFileURL(tempPath).href);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
