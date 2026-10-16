import fs from "node:fs";
import path from "node:path";
import { canonical, hash, PRODUCER_CONTRACT } from "./hybrid-trajectory-contract.mjs";
import { modelProvenance, format } from "./evaluate-hybrid-combat.mjs";
import { inheritedManifest } from "./hybrid-return-batch-inputs.mjs";

/** Record supporting proofs separately from original file bindings. */
export function provenanceFor(
  trajectories,
  bindings,
  trainingSeeds,
  holdoutSeeds,
  { fitted, supporting },
) {
  return {
    version: "ofh-hybrid-return-batch-training-provenance-v1",
    producerFieldContract: PRODUCER_CONTRACT,
    bindings,
    supportingFiles: supporting.flat(),
    episodes: trajectories.map(({ manifest, selection, context, returns, excluded }, index) => ({
      manifest,
      selection,
      context,
      returns,
      excluded,
      supportingFiles: supporting[index],
    })),
    trainingSeeds,
    reservedHoldoutSeeds: [...holdoutSeeds],
    summary: fitted.summary,
    modelHash: hash(canonical(fitted.model)),
    objective: "monte-carlo-ranking-evaluation-not-ppo",
    probabilityContract: "deterministic-regression-null-v1",
    ordering: "declared-episodes-original-records-v1",
    gammaTick: 1,
    currentTrainerSourceHash: bindings.sources.nativeTrainer.hash,
    futureHoldout: {
      status: "unverified",
      blocksPromotion: true,
      reason:
        "Requires actual compatible current source/harness/bundle/config binding and completed holdout",
    },
    performanceClaim: false,
    automaticActivation: false,
    automaticPromotion: false,
  };
}

function publishJSON(directory, name, value, owned) {
  const file = path.join(directory, name);
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "wx");
  owned.add(temporary);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.linkSync(temporary, file);
  owned.add(file);
  fs.unlinkSync(temporary);
  owned.delete(temporary);
}

/** Publish exclusively, verify each artifact and clean only owned files on failure. */
export function publish(directory, model, provenance, manifest, verify) {
  fs.mkdirSync(directory); // Exclusive creation: never owns an existing output.
  const owned = new Set();
  let complete = false;
  try {
    publishJSON(directory, "model.json", model, owned);
    verify();
    const inherited = inheritedManifest(manifest);
    publishJSON(
      directory,
      "trained-model.json",
      {
        format,
        policy: "compact-neural",
        ...inherited,
        model,
        ...modelProvenance(model, manifest.sourceHash),
        trainingSeeds: provenance.trainingSeeds,
        returnTraining: provenance,
      },
      owned,
    );
    verify();
    publishJSON(directory, "provenance.json", provenance, owned);
    verify();
    complete = true;
  } finally {
    if (!complete) {
      for (const file of owned) fs.unlinkSync(file);
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }
  }
}
