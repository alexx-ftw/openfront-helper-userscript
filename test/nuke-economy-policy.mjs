// Run the byte-preserved ESM test as one temporary module.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const partsDirectory = path.join(testDirectory, "nuke-economy-policy-parts");
const expectedHash = "93069d5edb6b40f561efe4babf815bd83971fbe62626f66be3bfa810f09c7802";
const sourceReadPattern = /const source = fs\.readFileSync\(\n\s*path\.join\(repoRoot,[^\n]+\n\s*"utf8",\n\);/g;
const helperImport =
  'import { readNukeBehaviorSource } from "./helpers/nuke-behavior-source.mjs";';
const partFiles = fs
  .readdirSync(partsDirectory)
  .filter((name) => /^part-\d+\.mjs$/.test(name))
  .sort();
const joined = Buffer.concat(
  partFiles.map((name) => fs.readFileSync(path.join(partsDirectory, name))),
);
const joinedHash = createHash("sha256").update(joined).digest("hex");

if (joinedHash !== expectedHash) {
  console.error(`nuke-economy-policy parts hash mismatch: ${joinedHash} != ${expectedHash}`);
  process.exitCode = 1;
} else {
  const sourceText = joined.toString("utf8");
  const sourceReads = sourceText.match(sourceReadPattern) ?? [];
  if (sourceReads.length !== 1) {
    console.error(`expected one behavior-source read, found ${sourceReads.length}`);
    process.exitCode = 1;
  } else {
    const executableSource =
      helperImport +
      "\n" +
      sourceText.replace(sourceReadPattern, "const source = readNukeBehaviorSource();");
    const tempPath = path.join(
      testDirectory,
      `.nuke-economy-policy.joined.${process.pid}.mjs`,
    );
    try {
      fs.writeFileSync(tempPath, executableSource);
      await import(pathToFileURL(tempPath).href);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}
