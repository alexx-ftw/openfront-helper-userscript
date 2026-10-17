// Orchestrator for the split hybrid-runtime-integration test.
//
// Ordered raw slices preserve the original test's shared lexical scope,
// static imports and top-level await. Import a temporary sibling module so
// relative imports resolve exactly as before; always remove it afterward.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PARTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "hybrid-runtime-integration-parts",
);
const EXPECTED_SHA256 = "68306c7f5fcfa1db1d7bf2e8b078a1bea233ce0fc8b91bfa868fe8b600dcffe0";
const partFiles = fs
  .readdirSync(PARTS_DIR)
  .filter((name) => /^part-\d+\.mjs$/.test(name))
  .sort();
const joined = Buffer.concat(partFiles.map((name) => fs.readFileSync(path.join(PARTS_DIR, name))));
const joinedHash = createHash("sha256").update(joined).digest("hex");
if (joinedHash !== EXPECTED_SHA256) {
  console.error(
    `hybrid-runtime-integration parts hash mismatch: ${joinedHash} != ${EXPECTED_SHA256}`,
  );
  process.exitCode = 1;
} else {
  const tempPath = path.join(
    path.dirname(PARTS_DIR),
    `.hybrid-runtime-integration.joined.${process.pid}.mjs`,
  );
  try {
    fs.writeFileSync(tempPath, joined);
    await import(pathToFileURL(tempPath).href);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
