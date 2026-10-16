// Bounded native collection followed by a disjoint, frozen holdout. Never activates a model.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { evaluate, validateModel, validateSeedIdentities } from "./evaluate-hybrid-combat.mjs";
import {
  assessCandidatePromotion,
  canonical,
  resolveCohorts,
} from "./hybrid-evaluation-contract.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function inspectCheckpoint(file) {
  const bytes = fs.readFileSync(file);
  const saved = JSON.parse(bytes);
  const source = ["hybridModelContract.js", "hybridCombat.js"]
    .map(
      (name) =>
        `// engine/ingame/auto-bot/${name}\n${fs.readFileSync(path.join(root, "engine/ingame/auto-bot", name), "utf8")}`,
    )
    .join("\n");
  assert.equal(saved.modelHash, digest(canonical(saved.model)), "Checkpoint model hash mismatch");
  assert.equal(saved.sourceHash, digest(source), "Checkpoint source mismatch");
  validateModel(saved.model, source, false);
  let ready = true;
  try {
    validateModel(saved.model, source, true);
    // eslint-disable-next-line no-restricted-syntax -- cold is a valid training state; every other validation failure propagates
  } catch (error) {
    if (
      !(error instanceof assert.AssertionError) ||
      error.message !==
        "Cold or unsupported snapshot: native diagnostics must report ready/modelReady=true"
    )
      throw error;
    ready = false;
  }
  return {
    ready,
    hash: digest(bytes),
    modelHash: saved.modelHash,
    trainingSeeds: saved.trainingSeeds,
  };
}

function writeResult(file, value) {
  const temporary = `${file}.tmp`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

function validateSettings(settings) {
  settings.collectionStop ??= "readiness";
  assert.ok(
    ["readiness", "seed-bound"].includes(settings.collectionStop),
    "Invalid collection stop",
  );
  assert.ok(["ridge", "compact-neural"].includes(settings.policy), "Declare a supported policy");
  if (settings.controlProfile !== undefined) {
    assert.ok(
      [
        "target-value-v1",
        "tribe-ranking-v1",
        "tribe-only-terminal-v1",
        "funded-tribe-terminal-v1",
      ].includes(settings.controlProfile),
      "Invalid control profile",
    );
    assert.equal(settings.policy, "compact-neural", "Control profile requires compact-neural");
  }
  assert.ok(
    Number.isSafeInteger(settings.batchSize) && settings.batchSize > 0,
    "Invalid batch size",
  );
  assert.ok(Number.isSafeInteger(settings.timeoutMs) && settings.timeoutMs > 0, "Invalid timeout");
  for (const seeds of [settings.trainingSeeds, settings.holdoutSeeds])
    assert.ok(
      Array.isArray(seeds) &&
        seeds.length &&
        seeds.every((seed) => typeof seed === "string" && seed.trim() === seed && seed),
      "Declare nonempty training and holdout seeds",
    );
}

function declaredObject(value) {
  return typeof value === "string" ? JSON.parse(fs.readFileSync(value)) : value;
}

function validateAcceptance(requirements, cohorts) {
  if (!requirements) return;
  assessCandidatePromotion({}, requirements);
  if (requirements.uncertainty)
    assert.equal(
      canonical(cohorts.uncertainty),
      canonical(requirements.uncertainty),
      "Preregistered uncertainty must match declared cohort parameters",
    );
  assert.deepEqual(
    [...requirements.cells].sort(),
    cohorts.cells.map((cell) => cell.name).sort(),
    "Acceptance requirements must cover the declared training/holdout cells",
  );
}

export async function trainAndEvaluate(options, environment = process.env, dependencies = {}) {
  const run = dependencies.evaluate ?? evaluate;
  const inspect = dependencies.inspect ?? inspectCheckpoint;
  const settings = structuredClone(options);
  const env = { ...environment };
  validateSettings(settings);
  const previous = settings.model ? inspect(settings.model) : null;
  validateSeedIdentities(
    [...settings.trainingSeeds, ...settings.holdoutSeeds],
    previous?.trainingSeeds ?? [],
  );
  assert.ok(settings.cohorts, "Declare holdout cohorts before training");
  const cohorts = declaredObject(settings.cohorts);
  const resolvedCohorts = resolveCohorts(cohorts, settings.holdoutSeeds);
  assert.equal(
    cohorts.cells.length,
    1,
    "Use a separate training run for each configuration cohort",
  );
  const requirements = declaredObject(settings.requirements);
  validateAcceptance(requirements, resolvedCohorts);
  const directory = path.resolve(settings.out);
  fs.mkdirSync(directory, { recursive: false });
  const plan = {
    version: "ofh-bounded-training-v1",
    settings: { ...settings, cohorts, requirements },
    environment: Object.fromEntries(
      Object.entries(env).filter(([key]) => key.startsWith("OFH_") || key === "GAME_ENV"),
    ),
    initialCheckpoint: previous,
    automaticActivation: false,
  };
  writeResult(path.join(directory, "plan.json"), plan);
  const planHash = digest(fs.readFileSync(path.join(directory, "plan.json")));
  const verifyPlan = () =>
    assert.equal(
      digest(fs.readFileSync(path.join(directory, "plan.json"))),
      planHash,
      "Training plan drift",
    );
  let model = settings.model;
  const batches = [];
  let checkpoint = null;
  const common = {
    policy: settings.policy,
    timeoutMs: settings.timeoutMs,
    "feature-profile": settings.featureProfile,
    "control-profile": settings.controlProfile,
  };
  for (let start = 0; start < settings.trainingSeeds.length; start += settings.batchSize) {
    verifyPlan();
    const seeds = settings.trainingSeeds.slice(start, start + settings.batchSize);
    const collectionCohorts = { ...cohorts, cells: [{ ...cohorts.cells[0], seeds }] };
    const output = await run(
      {
        ...common,
        collect: true,
        model,
        seeds,
        cohorts: collectionCohorts,
        out: path.join(directory, `collection-${batches.length}`),
      },
      env,
    );
    verifyPlan();
    model = path.join(output.outDir, "trained-model.json");
    checkpoint = inspect(model);
    batches.push({
      seeds,
      path: output.outDir,
      checkpoint,
      counts: output.report.counts,
      officialEvidence: output.report.runner === "official-gameimpl-bundled-harness",
    });
    writeResult(path.join(directory, `batch-${batches.length}.json`), batches.at(-1));
    if (checkpoint.ready && settings.collectionStop === "readiness") break;
  }
  assert.ok(checkpoint, "No checkpoint exported");
  const result = {
    version: plan.version,
    planHash,
    model,
    checkpoint,
    batches,
    unusedTrainingSeeds: settings.trainingSeeds.slice(
      batches.reduce((sum, batch) => sum + batch.seeds.length, 0),
    ),
    status: checkpoint.ready ? "ready-for-holdout" : "cold",
    holdout: null,
    automaticActivation: false,
    performanceClaim: false,
  };
  if (checkpoint.ready) {
    verifyPlan();
    const held = await run(
      {
        ...common,
        collect: false,
        model,
        seeds: settings.holdoutSeeds,
        cohorts,
        requirements,
        out: path.join(directory, "holdout"),
      },
      env,
    );
    verifyPlan();
    assert.equal(inspect(model).hash, checkpoint.hash, "Candidate mutated during holdout");
    result.holdout = { path: held.outDir, report: held.report };
    result.status = "evaluated";
  }
  writeResult(path.join(directory, "result.json"), result);
  return result;
}

export function parseTrainingArgs(argv) {
  const settings = {};
  const names = new Set([
    "--training-seeds",
    "--holdout-seeds",
    "--batch-size",
    "--timeout-ms",
    "--policy",
    "--model",
    "--out",
    "--cohorts",
    "--requirements",
    "--feature-profile",
    "--collection-stop",
    "--control-profile",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    assert.ok(
      names.has(key) && argv[index + 1] && !argv[index + 1].startsWith("--"),
      `Invalid argument ${key}`,
    );
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    assert.ok(!Object.hasOwn(settings, name), `Duplicate argument ${key}`);
    settings[name] = argv[++index];
  }
  for (const name of ["trainingSeeds", "holdoutSeeds"])
    settings[name] = settings[name]?.split(",").map((seed) => seed.trim());
  for (const name of ["batchSize", "timeoutMs"]) settings[name] = Number(settings[name]);
  assert.ok(typeof settings.out === "string" && settings.out, "--out is required");
  return settings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = parseTrainingArgs(process.argv.slice(2));
  const result = await trainAndEvaluate(settings);
  process.stdout.write(
    `${JSON.stringify({ status: result.status, model: result.model, output: path.resolve(settings.out), automaticActivation: false })}\n`,
  );
}
