import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canonical,
  hash,
  validateTrajectory,
  readLedger,
} from "../../scripts/headless/hybrid-trajectory-contract.mjs";
import { trainReturnBatch } from "../../scripts/headless/train-hybrid-return-batch.mjs";
import { modelProvenance } from "../../scripts/headless/evaluate-hybrid-combat.mjs";
import { fixture, encodeLedger, supportingFileFixture } from "../hybrid-trajectory-contract.mjs";

/** Create isolated fixture writers using an explicitly owned temporary directory. */
export function createBatchFixtures(directory) {
  function episode(seed, win, mutate = () => {}, actions = ["attack"], supporting = false) {
    const root = fs.mkdtempSync(path.join(directory, "episode-"));
    const admissionFile = path.join(root, "admissions.jsonl");
    const input = supporting
      ? supportingFileFixture(admissionFile)
      : fixture({
          profile: "frontier-v1",
          controlProfile: "tribe-only-terminal-v1",
          actions,
          win,
        });
    const manifest = input.selection.manifest;
    manifest.seed = seed;
    manifest.runID = hash(canonical([manifest.experimentID, seed, manifest.mode]));
    manifest.trainingSeeds = ["batch-original-bootstrap"];
    manifest.evaluationContractHash = "5".repeat(64);
    manifest.rewardHash = modelProvenance(
      input.nativeRun.result.hybridCombat.model,
      manifest.sourceHash,
    ).rewardHash;
    input.nativeRun.start.seed = seed;
    input.nativeRun.result.seed = seed;
    const entries = input.nativeRun.result.hybridEvaluation.ledger.entries;
    for (const event of entries) {
      event.runIdentity = manifest.runID;
      if (
        event.learned !== false &&
        ["hybrid-combat-accepted", "hybrid-combat-receipt", "hybrid-combat-outcome"].includes(
          event.kind,
        )
      ) {
        // The generic fixture omits this field; actual conditional producer carries it.
        event.behaviorPolicy = "deterministic-native-tribe-choice-v1";
        event.behaviorProbability = null;
        event.logProbability = null;
      }
    }
    input.dataset.coverage[0].runID = manifest.runID;
    if (supporting) for (const row of input.dataset.records) row.manifest = manifest;
    mutate(input);
    if (supporting) {
      const admission = JSON.parse(fs.readFileSync(admissionFile));
      admission.runIdentity = manifest.runID;
      fs.writeFileSync(admissionFile, JSON.stringify(admission) + "\n");
    }
    const paths = Object.fromEntries(
      ["ledger", "selection", "result", "snapshot"].map((key) => [
        key,
        path.join(root, `${key}.json`),
      ]),
    );
    fs.writeFileSync(paths.ledger, encodeLedger(input.dataset));
    fs.writeFileSync(paths.selection, JSON.stringify(input.selection));
    fs.writeFileSync(paths.result, JSON.stringify(input.nativeRun));
    fs.writeFileSync(paths.snapshot, input.selection.modelIdentity);
    return { paths, input, ...(supporting ? { admissionFile } : {}) };
  }

  function options(episodes, name, overrides = {}) {
    return {
      episodes: episodes.map(({ paths }) => paths),
      holdoutSeeds: ["batch-reserved-holdout"],
      gammaTick: 1,
      out: path.join(directory, name),
      ...overrides,
    };
  }

  return { episode, options };
}

/** Require rejection without any owned output. */
export function rejected(args, expected) {
  assert.throws(() => trainReturnBatch(args), expected);
  assert.equal(fs.existsSync(args.out), false, "Rejected batch must create no output");
}

/** Hash only the original four episode files. */
export function inputHashes(episodes) {
  return episodes.map(({ paths }) =>
    Object.fromEntries(
      Object.entries(paths).map(([key, file]) => [key, hash(fs.readFileSync(file))]),
    ),
  );
}

/** Validate original producer fixtures without fitting. */
export function pureTrajectory({ paths }) {
  return validateTrajectory(
    readLedger(paths.ledger),
    JSON.parse(fs.readFileSync(paths.selection)),
    JSON.parse(fs.readFileSync(paths.result)),
    { gammaTick: 1, requireStochastic: false },
  );
}

/** Produce an incompatible original model for domain rejection. */
export function changedModel(input) {
  const model = input.nativeRun.result.hybridCombat.model;
  model.models.target.outputBias = 0.01;
  const identity = JSON.stringify(model);
  input.selection.modelIdentity = identity;
  input.selection.manifest.modelHash = hash(canonical(model));
  for (const event of input.nativeRun.result.hybridEvaluation.ledger.entries)
    if (event.modelIdentity != null) event.modelIdentity = identity;
}
