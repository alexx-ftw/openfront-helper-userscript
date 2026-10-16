import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SPLIT_GROUPS,
  read,
  readEngineFile,
  readEngineFilesGrouped,
  splitGroupFiles,
} from "../scripts/build/sources.mjs";

for (const group of SPLIT_GROUPS) {
  const source = splitGroupFiles(group).map(read).join("");
  const banner = `\n// ===== ${group.bannerFile} =====\n`;
  const actual = readEngineFilesGrouped([`${group.prefix}SPLIT_GROUP`]);
  assert.equal(actual.split(banner).length - 1, 1, `${group.marker}: one legacy banner`);
  assert.ok(
    Buffer.from(actual).equals(Buffer.from(`${banner}${source}\n`)),
    `${group.marker}: preserve raw chunk bytes without inserted separators`,
  );
}
const ordinaryFile = "engine/ingame/auto-bot/earlyGame.js";
assert.equal(readEngineFilesGrouped([ordinaryFile]), readEngineFile(ordinaryFile));

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "openfront-build-parity-test-"));
const fixturePaths = [
  "build.mjs",
  "tsconfig.json",
  "package.json",
  "package-lock.json",
  "openfront-helper.user.js",
  "openfront-helper.autobot.js",
  "openfront-helper.build-id.js",
];

try {
  for (const relativePath of fixturePaths) {
    await cp(path.join(repoRoot, relativePath), path.join(scratchRoot, relativePath));
  }
  for (const directory of ["src", "engine", "locales", "scripts/build"]) {
    await cp(path.join(repoRoot, directory), path.join(scratchRoot, directory), {
      recursive: true,
    });
  }
  await symlink(path.join(repoRoot, "node_modules"), path.join(scratchRoot, "node_modules"), "dir");
  await execFileAsync(process.execPath, ["build.mjs"], {
    cwd: scratchRoot,
    maxBuffer: 16 * 1024 * 1024,
  });

  const { checkBuildParity } = await import("../scripts/check-build-parity.mjs");
  assert.deepEqual(await checkBuildParity({ rootDir: scratchRoot }), []);

  const autobotPath = path.join(scratchRoot, "openfront-helper.autobot.js");
  await writeFile(autobotPath, `${await readFile(autobotPath, "utf8")}\n// stale fixture\n`);
  const diagnostics = await checkBuildParity({ rootDir: scratchRoot });
  assert.match(
    diagnostics.join("\n"),
    /openfront-helper\.autobot\.js.*stale|inconsistent/iu,
    "a stale Auto-Bot artifact must fail the parity check",
  );
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}

process.stdout.write("build parity regression checks passed\n");
