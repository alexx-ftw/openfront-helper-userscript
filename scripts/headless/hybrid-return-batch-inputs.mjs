import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, hash, readLedger, validateTrajectory } from "./hybrid-trajectory-contract.mjs";
import { validateSeedIdentities } from "./evaluate-hybrid-combat.mjs";

const domainKeys = [
  "sourceHash",
  "bundleHash",
  "harnessHash",
  "evaluationContractHash",
  "configurationHash",
  "engineRevision",
  "engineDiffHash",
  "modelHash",
  "featureHash",
  "normalizerHash",
  "rewardHash",
];
const inheritedKeys = domainKeys.slice(0, 7);
const inputKeys = ["ledger", "selection", "result", "snapshot"];
const sourcePaths = {
  nativeTrainer: "../../engine/ingame/auto-bot/hybridModelContract.js",
  policyProducer: "../../engine/ingame/auto-bot/hybridCombat.js",
  nativeEvidenceProducer: "./opponent-adapter.js",
  seedHelper: "../../engine/ingame/auto-bot/portutil.js",
  seedValidator: "./evaluate-hybrid-combat.mjs",
  singleTrainer: "./train-hybrid-returns.mjs",
  contract: "./hybrid-trajectory-contract.mjs",
  evaluationContract: "./hybrid-evaluation-contract.mjs",
  batchInputs: "./hybrid-return-batch-inputs.mjs",
  batchFit: "./hybrid-return-batch-fit.mjs",
  batchPublication: "./hybrid-return-batch-publication.mjs",
};

function binding(file) {
  assert.ok(typeof file === "string" && file.length, "Missing input path");
  const resolved = fs.realpathSync(file);
  return {
    declaredPath: path.resolve(file),
    path: resolved,
    hash: hash(fs.readFileSync(resolved)),
  };
}

/** Bind original episode inputs and the complete batch implementation. */
export function bindInputs(episodes, entryURL) {
  const sources = Object.fromEntries(
    Object.entries(sourcePaths).map(([key, relative]) => [
      key,
      binding(fileURLToPath(new URL(relative, import.meta.url))),
    ]),
  );
  sources.batchTrainer = binding(fileURLToPath(entryURL));
  return {
    sources,
    episodes: episodes.map((episode) =>
      Object.fromEntries(inputKeys.map((key) => [key, binding(episode[key])])),
    ),
  };
}

/** Reject persistent source or original-input byte/path drift. */
export function verifyBindings(bindings) {
  for (const group of [bindings.sources, ...bindings.episodes]) {
    for (const [key, entry] of Object.entries(group)) {
      assert.equal(fs.realpathSync(entry.declaredPath), entry.path, `${key} resolved path drift`);
      assert.equal(hash(fs.readFileSync(entry.path)), entry.hash, `${key} input drift`);
    }
  }
}

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Validate an original episode without rebinding its inputs. */
export function readEpisode(files) {
  const selection = json(files.selection.path);
  const saved = json(files.snapshot.path);
  const snapshot = saved.model ?? saved;
  assert.equal(
    canonical(snapshot),
    canonical(JSON.parse(selection.modelIdentity)),
    "Selected original snapshot mismatch",
  );
  if (saved.model) {
    for (const key of inheritedKeys) {
      assert.equal(saved[key], selection.manifest[key], `Original envelope ${key} mismatch`);
    }
    assert.equal(
      saved.modelHash,
      hash(canonical(snapshot)),
      "Original envelope model hash mismatch",
    );
    assert.equal(
      saved.sourceHash,
      selection.manifest.sourceHash,
      "Original envelope source mismatch",
    );
    assert.equal(
      canonical(saved.trainingSeeds),
      canonical(selection.manifest.trainingSeeds ?? []),
      "Original envelope lineage mismatch",
    );
  }
  const trajectory = validateTrajectory(
    readLedger(files.ledger.path),
    selection,
    json(files.result.path),
    { gammaTick: 1, requireStochastic: false },
  );
  assert.equal(
    trajectory.trainable,
    true,
    `Excluded ${trajectory.reason}; no loss label or output`,
  );
  assert.equal(
    trajectory.context.coverage.ledgerHash,
    files.ledger.hash,
    "Original full-file ledger hash mismatch",
  );
  return trajectory;
}

/** Require a common domain and nonoverlapping original seed identities. */
export function validateBatch(trajectories, holdoutSeeds) {
  const first = trajectories[0];
  const identities = new Set();
  const inheritedSeeds = [];
  const episodeSeeds = [];
  for (const trajectory of trajectories) {
    assert.equal(
      canonical(trajectory.snapshot),
      canonical(first.snapshot),
      "Mixed original models",
    );
    assert.equal(
      trajectory.manifest.experimentID,
      first.manifest.experimentID,
      "Mixed original experiment domain",
    );
    for (const key of domainKeys) {
      assert.match(
        trajectory.manifest[key] ?? "",
        key === "engineRevision" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/,
        `Missing original ${key}`,
      );
      assert.equal(trajectory.manifest[key], first.manifest[key], `Mixed original domain ${key}`);
    }
    const context = trajectory.context;
    const compound = canonical([
      context.experimentID,
      context.runID,
      context.episodeId,
      context.generation,
      context.actorSmallID,
    ]);
    assert.ok(!identities.has(compound), "Duplicate original episode identity");
    identities.add(compound);
    inheritedSeeds.push(...(trajectory.manifest.trainingSeeds ?? []));
    episodeSeeds.push(trajectory.manifest.seed);
  }
  const originalTrainingSeeds = [...new Set(inheritedSeeds)];
  validateSeedIdentities(episodeSeeds, originalTrainingSeeds);
  const trainingSeeds = [...originalTrainingSeeds, ...episodeSeeds];
  validateSeedIdentities(holdoutSeeds, trainingSeeds);
  return trainingSeeds;
}

/** Preserve the original inherited envelope fields. */
export function inheritedManifest(manifest) {
  return Object.fromEntries(inheritedKeys.map((key) => [key, manifest[key]]));
}
