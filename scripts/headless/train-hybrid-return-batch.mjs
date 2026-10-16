// Offline same-origin Monte Carlo batch fitting. Never collects, activates or promotes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadNativeContract } from "./train-hybrid-returns.mjs";
import { supportingFilesFor, verifySupportingFiles } from "./hybrid-trajectory-contract.mjs";
import {
  bindInputs,
  readEpisode,
  validateBatch,
  verifyBindings,
} from "./hybrid-return-batch-inputs.mjs";
import { fitBatch } from "./hybrid-return-batch-fit.mjs";
import { provenanceFor, publish } from "./hybrid-return-batch-publication.mjs";

/** Fit validated same-origin episodes and publish an evaluation-only model. */
export function trainReturnBatch(options) {
  assert.equal(options.gammaTick, 1, "Explicit native terminal gammaTick 1 required");
  assert.ok(
    Array.isArray(options.episodes) && options.episodes.length > 0,
    "Nonempty original episodes required",
  );
  assert.ok(
    Array.isArray(options.holdoutSeeds) &&
      options.holdoutSeeds.length > 0 &&
      options.holdoutSeeds.every((seed) => typeof seed === "string" && seed.trim()),
    "Reserve nonempty explicit holdout seeds",
  );
  assert.ok(typeof options.out === "string" && options.out.length, "New output path required");
  const directory = path.resolve(options.out);
  assert.equal(fs.existsSync(directory), false, "Never overwrite existing output");
  const bindings = bindInputs(options.episodes, import.meta.url);
  const trajectories = bindings.episodes.map(readEpisode);
  const supporting = trajectories.map(supportingFilesFor);
  const trainingSeeds = validateBatch(trajectories, options.holdoutSeeds);
  const verify = () => {
    verifyBindings(bindings);
    verifySupportingFiles(supporting.flat());
  };
  verify();
  const fitted = fitBatch(
    trajectories,
    loadNativeContract(fs.readFileSync(bindings.sources.nativeTrainer.path, "utf8")),
  );
  verify();
  const provenance = provenanceFor(trajectories, bindings, trainingSeeds, options.holdoutSeeds, {
    fitted,
    supporting,
  });
  publish(directory, fitted.model, provenance, trajectories[0].manifest, verify);
  return { directory, model: fitted.model, provenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "Usage: node train-hybrid-return-batch.mjs MANIFEST.json");
  const result = trainReturnBatch(
    JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8")),
  );
  process.stdout.write(
    JSON.stringify({
      directory: result.directory,
      ...result.provenance.summary,
      holdout: "unverified",
      performanceClaim: false,
    }) + "\n",
  );
}
