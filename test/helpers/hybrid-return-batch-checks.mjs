import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, hash } from "../../scripts/headless/hybrid-trajectory-contract.mjs";
import { rejected } from "./hybrid-return-batch-fixtures.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
function expectedHeads(trajectories, C) {
  const origin = trajectories[0].snapshot;
  const models = plain(origin.models);
  for (const trajectory of trajectories) {
    for (const [index, record] of trajectory.records.entries()) {
      for (const role of ["act", "target"]) {
        const values = C.normalize(role === "target" ? record.features : record.gate, role, origin);
        models[role] = plain(
          C.update(
            models[role],
            values,
            trajectory.returns[index].return,
            origin.normalizer[role === "target" ? "target" : "gate"],
          ),
        );
      }
    }
  }
  return models;
}

/** Check exact native SGD weights, lineage and published provenance. */
export function verifyFitted(result, episodes, trajectories, C) {
  assert.deepEqual(
    result.model.models,
    expectedHeads(trajectories, C),
    "Exactly the actual native ordered SGD",
  );
  C.validate(result.model);
  assert.equal(C.learningAllowed(result.model), false);
  assert.deepEqual(result.model.offline.originModel, trajectories[0].snapshot);
  assert.equal(
    JSON.stringify(result.model.offline.originModel),
    episodes[0].input.selection.modelIdentity,
  );
  assert.deepEqual(result.model.offline.headUpdates, { wait: 0, act: 2, target: 2 });
  assert.equal(result.provenance.summary.fitted, 2);
  assert.equal(result.provenance.summary.updates, 4);
  assert.equal(result.provenance.summary.complete, true);
  assert.equal(result.provenance.summary.censored, 0);
  assert.equal(result.provenance.episodes[0].returns[0].return, 1);
  assert.equal(result.provenance.episodes[1].returns[0].return, -1);
  assert.deepEqual(
    result.provenance.episodes.map(({ context }) => context.episodeId),
    [1, 1],
  );
  assert.equal(new Set(result.provenance.episodes.map(({ context }) => context.runID)).size, 2);
  assert.deepEqual(result.provenance.trainingSeeds, [
    "batch-original-bootstrap",
    ...episodes.map(({ input }) => input.selection.manifest.seed),
  ]);
  const envelope = JSON.parse(fs.readFileSync(path.join(result.directory, "trained-model.json")));
  assert.equal(envelope.format, "ofh-hybrid-combat-evaluation-v2");
  assert.equal(envelope.modelHash, hash(canonical(result.model)));
  assert.equal(envelope.configurationHash, trajectories[0].manifest.configurationHash);
  assert.equal(envelope.sourceHash, trajectories[0].manifest.sourceHash);
  assert.deepEqual(envelope.returnTraining, result.provenance);
  assert.equal(result.provenance.futureHoldout.status, "unverified");
  assert.equal(result.provenance.futureHoldout.blocksPromotion, true);
  assert.equal(result.provenance.automaticActivation, false);
  assert.equal(result.provenance.automaticPromotion, false);
  assert.equal(result.provenance.performanceClaim, false);
  for (const [key, name] of [
    ["batchTrainer", "train-hybrid-return-batch"],
    ["batchInputs", "hybrid-return-batch-inputs"],
    ["batchFit", "hybrid-return-batch-fit"],
    ["batchPublication", "hybrid-return-batch-publication"],
    ["evaluationContract", "hybrid-evaluation-contract"],
  ]) {
    const file = fileURLToPath(new URL(`../../scripts/headless/${name}.mjs`, import.meta.url));
    assert.deepEqual(result.provenance.bindings.sources[key], {
      declaredPath: file,
      path: fs.realpathSync(file),
      hash: hash(fs.readFileSync(file)),
    });
  }
}

/** Reject drift immediately after the first publication. */
export function driftOnPublish(episodes, options) {
  const args = options(episodes, "drift");
  const originalLink = fs.linkSync;
  const file = episodes[0].paths.snapshot;
  const originalBytes = fs.readFileSync(file);
  let changed = false;
  let publications = 0;
  fs.linkSync = (...args) => {
    publications += 1;
    const result = originalLink(...args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(file, " ");
    }
    return result;
  };
  try {
    rejected(args, /drift/);
    assert.equal(publications, 1, "Verify immediately after each model publication");
  } finally {
    fs.linkSync = originalLink;
    fs.writeFileSync(file, originalBytes);
  }
}
