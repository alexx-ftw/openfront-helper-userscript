// Synthetic original-producer JSON fixtures and real helper SGD; no native games.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trainReturnBatch } from "../scripts/headless/train-hybrid-return-batch.mjs";
import { loadNativeContract } from "../scripts/headless/train-hybrid-returns.mjs";
import { canonical, hash } from "../scripts/headless/hybrid-trajectory-contract.mjs";
import {
  createBatchFixtures,
  rejected,
  inputHashes,
  pureTrajectory,
  changedModel,
} from "./helpers/hybrid-return-batch-fixtures.mjs";
import { verifyFitted, driftOnPublish } from "./helpers/hybrid-return-batch-checks.mjs";
import {
  supportingDriftChecks,
  supportingPrefitChecks,
  internalModuleDriftCheck,
} from "./helpers/hybrid-return-batch-guards.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-return-batch-"));
const C = loadNativeContract();
const fixtures = createBatchFixtures(directory);
const { episode, options } = fixtures;

try {
  internalModuleDriftCheck(fixtures);
  const episodes = [episode("batch-native-win", true), episode("batch-native-loss", false)];
  const before = inputHashes(episodes);
  rejected(options(episodes, "bad-gamma", { gammaTick: 0.9 }), /gammaTick/);
  rejected(options(episodes, "no-episodes", { episodes: [] }), /episodes/);
  rejected(options(episodes, "no-holdout", { holdoutSeeds: [] }), /holdout/);
  rejected(options([episodes[0], episodes[0]], "duplicate"), /Duplicate/);
  rejected(
    options(episodes, "holdout-overlap", { holdoutSeeds: ["batch-native-loss"] }),
    /overlap/,
  );
  const alias = [episode("Aa", true), episode("BB", false)];
  rejected(options(alias, "seed-alias"), /PRNG/);
  const foreign = episode("batch-foreign-model", false, changedModel);
  rejected(options([episodes[0], foreign], "mixed-model"), /Mixed original models/);
  const mixed = episode("batch-foreign-config", false, (input) => {
    input.selection.manifest.configurationHash = "6".repeat(64);
  });
  rejected(options([episodes[0], mixed], "mixed-config"), /Mixed original domain/);
  const capped = episode("batch-capped", false, (input) => {
    input.nativeRun.code = 0;
    const r = input.nativeRun.result;
    r.stopReason = "max_ticks";
    r.winner = null;
    Object.assign(r.hybridEvaluation.latestClosure, {
      reason: "max_ticks",
      terminated: false,
      truncated: true,
    });
  });
  rejected(options([episodes[0], capped], "cap-exclusion"), /Excluded/);
  assert.equal(
    typeof C.fitEpisodeBatchReturns,
    "function",
    "RED until real native batch helper is supplied",
  );
  const trajectories = episodes.map(pureTrajectory);
  const frozen = canonical(trajectories);
  const result = trainReturnBatch(options(episodes, "trained"));
  verifyFitted(result, episodes, trajectories, C);
  const manifestFile = path.join(directory, "cli-manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(options(episodes, "cli-trained")));
  const cli = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=384",
      fileURLToPath(new URL("../scripts/headless/train-hybrid-return-batch.mjs", import.meta.url)),
      manifestFile,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), {
    directory: path.join(directory, "cli-trained"),
    ...result.provenance.summary,
    holdout: "unverified",
    performanceClaim: false,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, "cli-trained", "model.json"))),
    result.model,
  );
  assert.equal(canonical(trajectories), frozen);
  assert.deepEqual(inputHashes(episodes), before, "Actual original bytes unchanged");
  const sentinel = fs.readFileSync(path.join(result.directory, "provenance.json"));
  assert.throws(() => trainReturnBatch(options(episodes, "trained")), /overwrite/);
  assert.deepEqual(fs.readFileSync(path.join(result.directory, "provenance.json")), sentinel);
  driftOnPublish(episodes, options);
  const supported = episode("support-proof", true, () => {}, ["attack"], true);
  const proofFit = trainReturnBatch(options([supported], "supported"));
  const expectedProof = [
    {
      declaredPath: supported.admissionFile,
      path: fs.realpathSync(supported.admissionFile),
      hash: hash(fs.readFileSync(supported.admissionFile)),
    },
  ];
  assert.deepEqual(proofFit.provenance.supportingFiles, expectedProof);
  assert.deepEqual(proofFit.provenance.episodes[0].supportingFiles, expectedProof);
  assert.deepEqual(Object.keys(proofFit.provenance.bindings.episodes[0]), [
    "ledger",
    "selection",
    "result",
    "snapshot",
  ]);
  supportingDriftChecks(fixtures);
  supportingPrefitChecks(fixtures);
  assert.deepEqual(inputHashes(episodes), before);
  const excluded = episode("batch-preserved-exclusion", false, () => {}, [
    "attack",
    "declined",
    "attack",
  ]);
  const excludedTrajectory = pureTrajectory(excluded);
  const exclusionFit = trainReturnBatch(options([excluded], "preserved-exclusions"));
  assert.equal(excludedTrajectory.excluded.length, 1);
  assert.deepEqual(exclusionFit.provenance.episodes[0].excluded, excludedTrajectory.excluded);
  assert.equal(exclusionFit.provenance.summary.fitted, 2);
  console.warn(
    "PASS: same-origin batch wrapper uses real native mixed-win/loss SGD, strict domains/seed coverage, immutable bindings and cleanup; no games.",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
