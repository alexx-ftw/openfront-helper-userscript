import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trainAndEvaluate, parseTrainingArgs } from "../scripts/headless/train-hybrid-combat.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-training-workflow-"));
const options = {
  policy: "compact-neural",
  trainingSeeds: ["workflow-train-1", "workflow-train-2", "workflow-train-3"],
  holdoutSeeds: ["workflow-holdout"],
  batchSize: 1,
  timeoutMs: 100,
  out: path.join(directory, "ready"),
  cohorts: { version: 1, cells: [{ name: "onion", seeds: ["workflow-holdout"], expected: {} }] },
};

try {
  const calls = [];
  const fake = async (request) => {
    calls.push(structuredClone(request));
    fs.mkdirSync(request.out);
    return {
      outDir: request.out,
      report: { counts: { success: 1 }, runner: "injected-runner-fixture-or-unverified" },
    };
  };
  const inspect = () => ({
    ready: calls.length >= 2,
    hash: "fixed",
    trainingSeeds: [],
    modelHash: "fixture",
  });
  const result = await trainAndEvaluate(options, {}, { evaluate: fake, inspect });
  assert.equal(
    calls.length,
    3,
    "Stop collection at native-ready coverage, then run frozen holdout",
  );
  assert.deepEqual(
    calls.slice(0, 2).map((row) => row.seeds),
    [["workflow-train-1"], ["workflow-train-2"]],
  );
  assert.equal(calls[1].model, path.join(calls[0].out, "trained-model.json"));
  assert.equal(calls[2].collect, false);
  assert.deepEqual(calls[2].seeds, options.holdoutSeeds);
  assert.equal(calls[0].cohorts.cells[0].name, calls[2].cohorts.cells[0].name);
  assert.deepEqual(result.unusedTrainingSeeds, ["workflow-train-3"]);
  assert.equal(result.automaticActivation, false);
  assert.equal(result.batches[0].officialEvidence, false);
  assert.equal(result.status, "evaluated");

  const boundedStart = calls.length;
  const bounded = await trainAndEvaluate(
    { ...options, collectionStop: "seed-bound", out: path.join(directory, "seed-bound") },
    {},
    { evaluate: fake, inspect },
  );
  const boundedCalls = calls.slice(boundedStart);
  assert.deepEqual(
    boundedCalls.filter((request) => request.collect).flatMap((request) => request.seeds),
    options.trainingSeeds,
    "Declared seed-bound collection must continue beyond readiness without repeating seeds",
  );
  assert.equal(boundedCalls.at(-1).collect, false);
  assert.equal(
    boundedCalls.at(-1).model,
    path.join(boundedCalls.at(-2).out, "trained-model.json"),
    "Holdout uses the final declared checkpoint, not the first ready checkpoint",
  );
  assert.deepEqual(boundedCalls.at(-1).seeds, options.holdoutSeeds);
  assert.deepEqual(bounded.unusedTrainingSeeds, []);
  assert.equal(bounded.automaticActivation, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, "seed-bound", "plan.json"))).settings
      .collectionStop,
    "seed-bound",
  );
  assert.equal(
    parseTrainingArgs(["--out", "bounded", "--collection-stop", "seed-bound"]).collectionStop,
    "seed-bound",
  );
  await assert.rejects(
    trainAndEvaluate(
      { ...options, collectionStop: "unbounded", out: path.join(directory, "invalid-stop") },
      {},
      { evaluate: fake, inspect },
    ),
    /Invalid collection stop/,
  );
  assert.equal(fs.existsSync(path.join(directory, "invalid-stop")), false);

  let attempts = 0;
  const cold = await trainAndEvaluate(
    { ...options, collectionStop: "seed-bound", out: path.join(directory, "cold") },
    {},
    {
      evaluate: async (request) => {
        attempts++;
        return fake(request);
      },
      inspect: () => ({ ready: false, hash: "cold", trainingSeeds: [] }),
    },
  );
  assert.equal(attempts, 3);
  assert.equal(cold.status, "cold");
  assert.equal(cold.holdout, null, "Never launch cold holdout or fabricate readiness");

  const readiness = [true, true, false];
  const coolingStart = calls.length;
  const cooling = await trainAndEvaluate(
    { ...options, collectionStop: "seed-bound", out: path.join(directory, "ready-then-cold") },
    {},
    {
      evaluate: fake,
      inspect: () => ({ ready: readiness.shift(), hash: "fixed", trainingSeeds: [] }),
    },
  );
  assert.equal(calls.length - coolingStart, 3, "Cold final checkpoint must not launch holdout");
  assert.equal(cooling.status, "cold");
  assert.equal(cooling.holdout, null);
  assert.deepEqual(cooling.unusedTrainingSeeds, []);

  assert.equal(
    parseTrainingArgs(["--out", "profile", "--control-profile", "target-value-v1"]).controlProfile,
    "target-value-v1",
  );
  const profiledStart = calls.length;
  await trainAndEvaluate(
    { ...options, controlProfile: "target-value-v1", out: path.join(directory, "profile") },
    {},
    { evaluate: fake, inspect },
  );
  assert.ok(calls.length - profiledStart >= 2);
  assert.ok(
    calls.slice(profiledStart).every((request) => request["control-profile"] === "target-value-v1"),
    "The declared control profile must reach both collection and frozen holdout",
  );
  await assert.rejects(
    trainAndEvaluate(
      {
        ...options,
        policy: "ridge",
        controlProfile: "target-value-v1",
        out: path.join(directory, "ridge-profile"),
      },
      {},
      { evaluate: fake, inspect },
    ),
    /Control profile requires compact-neural/,
  );
  assert.equal(fs.existsSync(path.join(directory, "ridge-profile")), false);
  const fundedStart = calls.length;
  await trainAndEvaluate(
    {
      ...options,
      featureProfile: "frontier-v1",
      controlProfile: "funded-tribe-terminal-v1",
      out: path.join(directory, "funded-profile"),
    },
    {},
    { evaluate: fake, inspect },
  );
  assert.ok(calls.length - fundedStart >= 2);
  assert.ok(
    calls
      .slice(fundedStart)
      .every(
        (request) =>
          request["control-profile"] === "funded-tribe-terminal-v1" &&
          request["feature-profile"] === "frontier-v1",
      ),
    "Funded profile reaches collection and frozen holdout without changing its feature contract",
  );

  await assert.rejects(
    trainAndEvaluate(
      { ...options, trainingSeeds: ["workflow-holdout"], out: path.join(directory, "overlap") },
      {},
      { evaluate: () => assert.fail("No launch for overlapping cohorts"), inspect },
    ),
    /unique/,
  );
  assert.equal(fs.existsSync(path.join(directory, "overlap")), false);

  await assert.rejects(
    trainAndEvaluate(
      { ...options, requirements: {}, out: path.join(directory, "invalid-requirements") },
      {},
      { evaluate: () => assert.fail("Invalid requirements must fail before collection"), inspect },
    ),
    /requirements version/,
  );
  assert.equal(fs.existsSync(path.join(directory, "invalid-requirements")), false);
  const acceptance = {
    version: 1,
    cells: ["onion"],
    minimumPairsPerCell: 1,
    minimumControlledDecisions: 1,
    minimumReserveChecks: 1,
    minimumLegalityChecks: 1,
    maximumReserveViolations: 0,
    maximumIllegalEmissions: 0,
    minimumLatencySamples: 1,
    maximumBudgetRejections: 0,
    minimumWinDifference: 0,
    maximumLatencyMs: 1,
    noCellRegression: true,
    requireKnownSafetyCoverage: true,
    safetyScope: "learned-attack-gate",
    uncertainty: { method: "bootstrap", confidence: 0.8, resamples: 10, seed: "fixture" },
    minimumConfidenceLowerBound: 0,
  };
  await assert.rejects(
    trainAndEvaluate(
      { ...options, requirements: acceptance, out: path.join(directory, "uncertainty-mismatch") },
      {},
      {
        evaluate: () => assert.fail("Mismatched uncertainty must fail before collection"),
        inspect,
      },
    ),
    /uncertainty must match/,
  );
  assert.equal(fs.existsSync(path.join(directory, "uncertainty-mismatch")), false);
  await assert.rejects(
    trainAndEvaluate(
      {
        ...options,
        requirements: {
          ...acceptance,
          cells: ["other"],
          uncertainty: undefined,
          maximumSignTestP: 0.1,
        },
        out: path.join(directory, "requirements-cell-mismatch"),
      },
      {},
      { evaluate: () => assert.fail("Wrong acceptance cell must fail before collection"), inspect },
    ),
    /cover the declared/,
  );
  assert.equal(fs.existsSync(path.join(directory, "requirements-cell-mismatch")), false);

  await assert.rejects(
    trainAndEvaluate(
      { ...options, out: path.join(directory, "drift") },
      {},
      {
        evaluate: async (request) => {
          fs.appendFileSync(path.join(directory, "drift/plan.json"), " ");
          return fake(request);
        },
        inspect,
      },
    ),
    /plan drift/,
  );
  await assert.rejects(
    trainAndEvaluate(
      { ...options, out: path.join(directory, "model-drift") },
      {},
      {
        evaluate: fake,
        inspect: (() => {
          let times = 0;
          return () => ({
            ready: true,
            hash: ++times === 1 ? "initial" : "changed",
            trainingSeeds: [],
          });
        })(),
      },
    ),
    /mutated/,
  );

  assert.throws(() => parseTrainingArgs(["--out", "a", "--out", "b"]), /Duplicate/);
  assert.throws(() => parseTrainingArgs(["--automatic-activation", "1"]), /Invalid/);
  assert.throws(() => parseTrainingArgs(["--out"]), /Invalid/);
  process.stdout.write(
    "hybrid bounded training workflow passed (injected fixtures; no strength claim)\n",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
