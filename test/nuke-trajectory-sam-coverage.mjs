// Orchestrator for the split nuke-trajectory-sam-coverage test.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PARTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "nuke-trajectory-sam-coverage-parts",
);
const EXPECTED_SHA256 = "54f2e8d9b47b94dd0f7f773c32dbeca5efe063645e817f35ddd2b51dc6313024";
const partFiles = fs
  .readdirSync(PARTS_DIR)
  .filter((name) => /^part-\d+\.mjs$/.test(name))
  .sort();
const joined = Buffer.concat(partFiles.map((name) => fs.readFileSync(path.join(PARTS_DIR, name))));
const joinedHash = createHash("sha256").update(joined).digest("hex");
if (joinedHash !== EXPECTED_SHA256) {
  console.error(
    "nuke-trajectory-sam-coverage parts hash mismatch: " + joinedHash + " != " + EXPECTED_SHA256,
  );
  process.exitCode = 1;
} else {
  const tempPath = path.join(
    path.dirname(PARTS_DIR),
    ".nuke-trajectory-sam-coverage.joined." + process.pid + ".mjs",
  );
  try {
    fs.writeFileSync(tempPath, joined);
    await import(pathToFileURL(tempPath).href);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
