// Offline Monte Carlo ranking/evaluation. No collection, activation or promotion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonical,
  hash,
  readLedger,
  validateTrajectory,
  PRODUCER_CONTRACT,
} from "./hybrid-trajectory-contract.mjs";
import { validateSeedIdentities, format, modelProvenance } from "./evaluate-hybrid-combat.mjs";

const sourcePath = fileURLToPath(
  new URL("../../engine/ingame/auto-bot/hybridModelContract.js", import.meta.url),
);

export function loadNativeContract(source = fs.readFileSync(sourcePath, "utf8")) {
  // Only trusted repository classic source enters this boundary; all CLI inputs remain JSON data.
  // eslint-disable-next-line sonarjs/code-eval
  return vm.runInNewContext(`${source}\nHybridCombatContract;`, {}, { filename: sourcePath });
}

export function fitTrajectory(trajectory, contract = loadNativeContract()) {
  assert.equal(trajectory.trainable, true, "Nonterminal/cap/error trajectory excluded, not a loss");
  assert.equal(typeof contract.fitEpisodeReturns, "function", "Native return SGD API unavailable");
  const frozen = canonical(trajectory);
  const fitted = contract.fitEpisodeReturns(
    trajectory.snapshot,
    trajectory.records,
    trajectory.context,
  );
  assert.equal(canonical(trajectory), frozen, "Native trainer mutated frozen input");
  contract.validate(fitted.model);
  assert.equal(fitted.model.reward, "discounted-terminal-win-return-v1");
  assert.equal(fitted.model.offline?.version, "offline-terminal-return-v1");
  assert.equal(fitted.model.offline.originModelIdentity, trajectory.selection.modelIdentity);
  assert.equal(fitted.summary.complete, true, "Incomplete native training");
  assert.equal(fitted.summary.fitted, trajectory.records.length, "Native fit coverage mismatch");
  assert.equal(fitted.summary.censored, 0, "Native fit silently censored records");
  return JSON.parse(JSON.stringify(fitted));
}

function immutableJSON(file, value) {
  const temporary = `${file}.tmp`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, file);
  } finally {
    fs.unlinkSync(temporary);
  }
}

export function trainReturns(options) {
  assert.ok(
    Number.isFinite(options.gammaTick) && options.gammaTick >= 0 && options.gammaTick <= 1,
    "--gamma-tick is required and must be finite in [0,1]",
  );
  const paths = {
    ledger: options.ledger,
    selection: options.selection,
    result: options.result,
    snapshot: options.snapshot,
    nativeTrainer: sourcePath,
    policyProducer: fileURLToPath(
      new URL("../../engine/ingame/auto-bot/hybridCombat.js", import.meta.url),
    ),
    nativeEvidenceProducer: fileURLToPath(new URL("./opponent-adapter.js", import.meta.url)),
    seedHelper: fileURLToPath(new URL("../../engine/ingame/auto-bot/portutil.js", import.meta.url)),
    seedValidator: fileURLToPath(new URL("./evaluate-hybrid-combat.mjs", import.meta.url)),
    trainer: fileURLToPath(import.meta.url),
    contract: fileURLToPath(new URL("./hybrid-trajectory-contract.mjs", import.meta.url)),
  };
  const bindings = Object.fromEntries(
    Object.entries(paths).map(([key, file]) => {
      assert.ok(typeof file === "string" && file.length, `Missing ${key} file`);
      const realPath = fs.realpathSync(file);
      return [key, { path: realPath, hash: hash(fs.readFileSync(realPath)) }];
    }),
  );
  const verifyFrozen = () => {
    for (const [key, binding] of Object.entries(bindings)) {
      assert.equal(fs.realpathSync(paths[key]), binding.path, `${key} resolved path drift`);
      assert.equal(hash(fs.readFileSync(binding.path)), binding.hash, `${key} input drift`);
    }
  };
  const selection = JSON.parse(fs.readFileSync(bindings.selection.path, "utf8"));
  const saved = JSON.parse(fs.readFileSync(bindings.snapshot.path, "utf8"));
  const snapshot = saved.model ?? saved;
  assert.equal(
    canonical(snapshot),
    canonical(JSON.parse(selection.modelIdentity)),
    "Selected original snapshot mismatch",
  );
  const trainingSeeds = [...(selection.manifest.trainingSeeds ?? []), selection.manifest.seed];
  const uniqueTrainingSeeds = [...new Set(trainingSeeds)];
  assert.ok(
    Array.isArray(options.holdoutSeeds) &&
      options.holdoutSeeds.length > 0 &&
      options.holdoutSeeds.every((seed) => typeof seed === "string" && seed.trim().length > 0),
    "Reserve explicit nonempty holdout seeds",
  );
  validateSeedIdentities(options.holdoutSeeds, uniqueTrainingSeeds);
  const trajectory = validateTrajectory(
    readLedger(bindings.ledger.path),
    selection,
    JSON.parse(fs.readFileSync(bindings.result.path, "utf8")),
    { gammaTick: options.gammaTick, requireStochastic: options.requireStochastic === true },
  );
  verifyFrozen();
  assert.equal(
    trajectory.trainable,
    true,
    `Excluded ${trajectory.reason}; no defeat label or model written`,
  );
  assert.equal(
    trajectory.context.coverage.ledgerHash,
    bindings.ledger.hash,
    "Actual full-file ledger hash mismatch",
  );
  const fitted = fitTrajectory(
    trajectory,
    loadNativeContract(fs.readFileSync(bindings.nativeTrainer.path, "utf8")),
  );
  verifyFrozen();
  const provenance = {
    version: "ofh-hybrid-return-training-provenance-v1",
    producerFieldContract: PRODUCER_CONTRACT,
    originalManifest: trajectory.manifest,
    originalSelection: trajectory.selection,
    bindings,
    trainingSeeds: uniqueTrainingSeeds,
    reservedHoldoutSeeds: options.holdoutSeeds,
    context: trajectory.context,
    returns: trajectory.returns,
    excluded: trajectory.excluded,
    summary: fitted.summary,
    modelHash: hash(canonical(fitted.model)),
    objective: trajectory.objective,
    probabilityContract: trajectory.probabilityContract,
    currentTrainerSourceHash: bindings.nativeTrainer.hash,
    futureHoldout: {
      status: "unverified",
      blocksPromotion: true,
      reason:
        "Requires actual current source, harness, built artifact and configuration binding plus completed holdout",
    },
    performanceClaim: false,
    automaticActivation: false,
  };
  // Files are atomically published without replacement; provenance is the completion marker.
  const directory = path.resolve(options.out);
  fs.mkdirSync(directory);
  let complete = false;
  try {
    immutableJSON(path.join(directory, "model.json"), fitted.model);
    const manifest = trajectory.manifest;
    const inherited = Object.fromEntries(
      [
        "bundleHash",
        "sourceHash",
        "harnessHash",
        "evaluationContractHash",
        "configurationHash",
        "engineRevision",
        "engineDiffHash",
      ].map((key) => [key, manifest[key]]),
    );
    immutableJSON(path.join(directory, "trained-model.json"), {
      format,
      policy: "compact-neural",
      ...inherited,
      model: fitted.model,
      ...modelProvenance(fitted.model, manifest.sourceHash),
      trainingSeeds: uniqueTrainingSeeds,
      returnTraining: provenance,
    });
    verifyFrozen();
    immutableJSON(path.join(directory, "provenance.json"), provenance);
    complete = true;
  } finally {
    if (!complete) {
      for (const name of [
        "model.json",
        "model.json.tmp",
        "trained-model.json",
        "trained-model.json.tmp",
        "provenance.json",
        "provenance.json.tmp",
      ]) {
        const file = path.join(directory, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.rmdirSync(directory);
    }
  }
  return { directory, model: fitted.model, provenance };
}

export function parseOptions(args) {
  const result = {};
  const keys = {
    "--ledger": "ledger",
    "--selection": "selection",
    "--result": "result",
    "--snapshot": "snapshot",
    "--out": "out",
    "--gamma-tick": "gammaTick",
    "--holdout-seeds": "holdoutSeeds",
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--require-stochastic") {
      result.requireStochastic = true;
      continue;
    }
    const key = keys[args[index]];
    assert.ok(
      key && args[index + 1] && !args[index + 1].startsWith("--") && !(key in result),
      "Unknown/duplicate/missing CLI argument",
    );
    result[key] = args[++index];
  }
  for (const key of Object.values(keys)) assert.ok(key in result, `Missing --${key}`);
  assert.ok(result.gammaTick.trim().length > 0, "Explicit numeric --gamma-tick required");
  result.gammaTick = Number(result.gammaTick);
  result.holdoutSeeds = result.holdoutSeeds.split(",");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = trainReturns(parseOptions(process.argv.slice(2)));
  process.stdout.write(
    JSON.stringify({
      directory: output.directory,
      ...output.provenance.summary,
      holdout: "unverified",
      performanceClaim: false,
    }) + "\n",
  );
}
