// Orchestrator for the split sam-defense-policy test.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PARTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sam-defense-policy-parts",
);
const EXPECTED_SHA256 = "d46458c44c26e2655f8063b18244a54ebd7f8d4b59145dfd6459446c89471b2e";
const partFiles = fs
  .readdirSync(PARTS_DIR)
  .filter((name) => /^part-\d+\.mjs$/.test(name))
  .sort();
const joined = Buffer.concat(partFiles.map((name) => fs.readFileSync(path.join(PARTS_DIR, name))));
const joinedHash = createHash("sha256").update(joined).digest("hex");
if (joinedHash !== EXPECTED_SHA256) {
  console.error("sam-defense-policy parts hash mismatch: " + joinedHash + " != " + EXPECTED_SHA256);
  process.exitCode = 1;
} else {
  const tempPath = path.join(
    path.dirname(PARTS_DIR),
    ".sam-defense-policy.joined." + process.pid + ".mjs",
  );
  try {
    fs.writeFileSync(tempPath, joined);
    await import(pathToFileURL(tempPath).href);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
