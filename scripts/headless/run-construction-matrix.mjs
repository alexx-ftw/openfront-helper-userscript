import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(directory, "../..");
const batchRunner = path.join(directory, "run-batch.mjs");
const configPath = path.resolve(
  projectRoot,
  process.env.OFH_CONSTRUCTION_SCENARIOS ??
    "scripts/headless/construction-scenarios.json",
);
const campaignSeed = process.env.OFH_CAMPAIGN_SEED ?? "construction-policy-v1";
const outputRoot = path.resolve(
  projectRoot,
  process.env.OFH_MATRIX_OUTPUT_DIR ??
    path.join(".artifacts", "construction-matrix", campaignSeed),
);
const scenarioFilter = new Set(
  (process.env.OFH_SCENARIOS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const config = JSON.parse(await readFile(configPath, "utf8"));
const scenarios = config.scenarios.filter(
  ({ id }) => scenarioFilter.size === 0 || scenarioFilter.has(id),
);
if (scenarios.length === 0) throw new Error("No construction scenarios selected");
const missingScenarios = [...scenarioFilter].filter(
  (id) => !config.scenarios.some((scenario) => scenario.id === id),
);
if (missingScenarios.length > 0) {
  throw new Error(`Unknown construction scenarios: ${missingScenarios.join(", ")}`);
}
await mkdir(outputRoot, { recursive: true });

function runScenario(scenario) {
  return new Promise((resolve) => {
    const outputDirectory = path.join(outputRoot, scenario.id);
    const child = spawn(process.execPath, [batchRunner], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...scenario.environment,
        OFH_BATCH_SEED: `${campaignSeed}-${scenario.id}`,
        OFH_SIM_OUTPUT_DIR: outputDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code, signal) => {
      const resultPath = path.join(outputDirectory, "results.json");
      const result = existsSync(resultPath)
        ? JSON.parse(readFileSync(resultPath, "utf8"))
        : null;
      resolve({
        scenario,
        outputDirectory,
        code,
        signal,
        finalOutput: stdout.trim().split("\n").at(-1) ?? "",
        stderr: stderr.slice(-4000),
        result,
      });
    });
  });
}

const results = [];
for (const scenario of scenarios) results.push(await runScenario(scenario));
const summary = {
  campaignSeed,
  configVersion: config.version,
  scenarios: results.map(({ scenario, code, signal, result }) => ({
    id: scenario.id,
    role: scenario.role,
    code,
    signal,
    batch: result?.summary ?? null,
  })),
};
await writeFile(
  path.join(outputRoot, "matrix.json"),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = results.every(({ code, result }) => code === 0 && result) ? 0 : 1;
