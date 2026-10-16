import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const ARTIFACTS = [
  "openfront-helper.user.js",
  "openfront-helper.autobot.js",
  "openfront-helper.build-id.js",
];
const BUILD_INPUTS = [
  "build.mjs",
  "scripts/build",
  "tsconfig.json",
  "package.json",
  "src",
  "engine",
  "locales",
];

async function readJson(rootDir, relativePath) {
  return JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
}

async function buildInTemporaryDirectory(rootDir) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "openfront-build-parity-"));
  try {
    for (const relativePath of BUILD_INPUTS) {
      await cp(path.join(rootDir, relativePath), path.join(temporaryRoot, relativePath), {
        recursive: true,
      });
    }
    await symlink(
      path.join(rootDir, "node_modules"),
      path.join(temporaryRoot, "node_modules"),
      "dir",
    );

    await execFileAsync(process.execPath, ["build.mjs"], {
      cwd: temporaryRoot,
      maxBuffer: 16 * 1024 * 1024,
    });

    return Object.fromEntries(
      await Promise.all(
        ARTIFACTS.map(async (relativePath) => [
          relativePath,
          await readFile(path.join(temporaryRoot, relativePath)),
        ]),
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function packageMetadataDiagnostics(packageJson, packageLock) {
  const diagnostics = [];
  const lockRoot = packageLock.packages?.[""];
  if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) {
    diagnostics.push("package-lock.json metadata is stale/inconsistent with package.json");
  }
  if (!lockRoot || lockRoot.name !== packageJson.name || lockRoot.version !== packageJson.version) {
    diagnostics.push(
      "package-lock.json root package metadata is stale/inconsistent with package.json",
    );
  }
  return diagnostics;
}

function buildIdFor(source) {
  return createHash("sha256").update(source).digest("hex");
}

function buildIdFromArtifact(source) {
  return source.match(
    /^globalThis\.__OFH_LOCAL_BUILD_ID__\s*=\s*["']([a-f0-9]{64})["'];?\s*$/mu,
  )?.[1];
}

export async function checkBuildParity({ rootDir = PROJECT_ROOT } = {}) {
  const diagnostics = [];
  const packageJson = await readJson(rootDir, "package.json");
  const packageLock = await readJson(rootDir, "package-lock.json");
  diagnostics.push(...packageMetadataDiagnostics(packageJson, packageLock));

  const expectedArtifacts = await buildInTemporaryDirectory(rootDir);

  const actualArtifacts = Object.fromEntries(
    await Promise.all(
      ARTIFACTS.map(async (relativePath) => [
        relativePath,
        await readFile(path.join(rootDir, relativePath)),
      ]),
    ),
  );

  for (const relativePath of ARTIFACTS) {
    if (!actualArtifacts[relativePath].equals(expectedArtifacts[relativePath])) {
      diagnostics.push(`${relativePath} is stale/inconsistent with the reproducible build`);
    }
  }

  const actualAutobot = actualArtifacts["openfront-helper.autobot.js"];
  const actualBuildId = buildIdFromArtifact(
    actualArtifacts["openfront-helper.build-id.js"].toString("utf8"),
  );
  if (actualBuildId !== buildIdFor(actualAutobot)) {
    diagnostics.push(
      "openfront-helper.build-id.js is inconsistent with openfront-helper.autobot.js",
    );
  }

  return diagnostics;
}

function cliRoot(args) {
  const rootIndex = args.indexOf("--root");
  return rootIndex === -1 ? PROJECT_ROOT : path.resolve(args[rootIndex + 1]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const diagnostics = await checkBuildParity({ rootDir: cliRoot(process.argv.slice(2)) });
  if (diagnostics.length > 0) {
    const report = diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n");
    process.stderr.write(`${report}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("build parity check passed\n");
  }
}
