import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonical, hash } from "../scripts/headless/hybrid-trajectory-contract.mjs";
import {
  fitTrajectory,
  loadNativeContract,
  parseOptions,
  trainReturns,
} from "../scripts/headless/train-hybrid-returns.mjs";
import {
  fixture,
  validateFixture,
  setStopReason,
  encodeLedger,
  invalidNativeRuns,
} from "./hybrid-trajectory-contract.mjs";

import { validateSeedIdentities } from "../scripts/headless/evaluate-hybrid-combat.mjs";

const C = loadNativeContract();
const plain = (value) => JSON.parse(JSON.stringify(value));
for (const input of [
  fixture({ actions: ["wait", "declined", "wait"] }),
  fixture({ confirmed: false }),
]) {
  const trajectory = validateFixture(input);
  const fitted = fitTrajectory(trajectory, C);
  assert.deepEqual(fitted.model.offline.originalDecisionSteps, [0, 2]);
  assert.equal(fitted.summary.fitted, 2);
  assert.equal(fitted.model.models.wait.samples, 2);
  assert.equal(fitted.model.models.act.samples, 0);
  assert.deepEqual(fitted.model.offline.coverage, trajectory.context.coverage);
  assert.equal(fitted.model.offline.coverage.ledgerHash, hash(encodeLedger(input.dataset)));
  C.validate(fitted.model);
  assert.throws(
    () =>
      C.fitEpisodeReturns(trajectory.snapshot, trajectory.records, {
        ...trajectory.context,
        coverage: undefined,
      }),
    /step|coverage|record/i,
  );
  assert.throws(
    () =>
      C.fitEpisodeReturns(trajectory.snapshot, trajectory.records, {
        ...trajectory.context,
        coverage: { ...trajectory.context.coverage, excluded: [] },
      }),
    /coverage/i,
  );
}
for (const profile of [undefined, "frontier-v1"]) {
  for (const win of [true, false]) {
    const input = fixture({ profile, win });
    const before = canonical(input);
    const trajectory = validateFixture(input);
    const trained = fitTrajectory(trajectory, C);
    assert.equal(canonical(input), before, "Original files/identity immutable");
    C.validate(trained.model);
    assert.equal(trained.model.reward, "discounted-terminal-win-return-v1");
    assert.deepEqual(trained.summary, {
      fitted: 3,
      updates: 4,
      censored: 0,
      complete: true,
      performanceClaim: false,
    });
    assert.equal(trained.model.offline.originModelIdentity, input.selection.modelIdentity);
    assert.deepEqual(trained.model.offline.headUpdates, { wait: 2, act: 1, target: 1 });
    assert.ok(trained.model.models.wait.outputBias * (win ? 1 : -1) > 0);
    assert.ok(trained.model.models.act.outputBias * (win ? 1 : -1) > 0);
    assert.ok(trained.model.models.target.outputBias * (win ? 1 : -1) > 0);
    const expected = structuredClone(trajectory.snapshot);
    for (const [index, record] of trajectory.records.entries()) {
      const roles = record.action === "wait" ? ["wait"] : ["act", "target"];
      for (const role of roles) {
        const transform = expected.normalizer[role === "target" ? "target" : "gate"];
        const features = C.normalize(
          role === "target" ? record.features : record.gate,
          role,
          trajectory.snapshot,
        );
        expected.models[role] = plain(
          C.update(expected.models[role], features, trajectory.returns[index].return, transform),
        );
      }
    }
    assert.deepEqual(
      trained.model.models,
      expected.models,
      "Actual native SGD equals hand-labelled unequal-tick updates",
    );
    assert.throws(
      () => C.fitOffline(trained.model, trajectory.records, trajectory.context),
      /return|offline|reward/i,
    );
    assert.ok(
      Object.values(trajectory.snapshot.models).every((head) => head.samples === 0),
      "Cold snapshot stays cold",
    );
    const returnsBefore = canonical(trajectory.snapshot);
    for (const patch of [{ reward: "unknown" }, { normalizer: {} }, { models: {} }])
      assert.throws(() =>
        C.fitEpisodeReturns(
          { ...trajectory.snapshot, ...patch },
          trajectory.records,
          trajectory.context,
        ),
      );
    for (const patch of [
      { gammaTick: NaN },
      { gammaTick: undefined },
      { gammaTick: -1 },
      { terminalWin: null },
      { terminalTick: 0 },
      { modelIdentity: "{}" },
      { resultHash: "unverified" },
    ])
      assert.throws(() =>
        C.fitEpisodeReturns(trajectory.snapshot, trajectory.records, {
          ...trajectory.context,
          ...patch,
        }),
      );
    for (const patch of [
      { learned: false },
      { confirmed: false },
      { truncated: true },
      { controlledAction: "attack" },
      { actorSmallID: 9 },
      { modelIdentity: "{}" },
      { error: "env-error" },
    ]) {
      const records = structuredClone(trajectory.records);
      Object.assign(records[0], patch);
      assert.throws(() => C.fitEpisodeReturns(trajectory.snapshot, records, trajectory.context));
    }
    const records = structuredClone(trajectory.records);
    records[1].decisionStep++;
    assert.throws(() => C.fitEpisodeReturns(trajectory.snapshot, records, trajectory.context));
    assert.equal(
      canonical(trajectory.snapshot),
      returnsBefore,
      "Failed fit never replaces original snapshot",
    );
  }
}

validateSeedIdentities(["holdout"], ["train"]);
assert.throws(() => validateSeedIdentities(["train"], ["train"]), /overlap/);
assert.throws(() => validateSeedIdentities(["BB"], ["Aa"]), /PRNG/);
assert.throws(
  () => validateSeedIdentities(["\u0000"], ["\u0001"]),
  /PRNG/,
  "Use the actual house zero-to-one effective PRNG state",
);
assert.throws(() => parseOptions([]), /Missing/);
assert.throws(() => parseOptions(["--gamma-tick", "0.5", "--gamma-tick", "0.7"]), /duplicate/);
assert.throws(
  () => fitTrajectory(validateFixture(setStopReason(fixture(), "max_ticks"))),
  /excluded/,
);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-return-tests-"));
try {
  const input = fixture();
  const ledger = path.join(directory, "ledger.jsonl");
  const { records, ...metadata } = input.dataset;
  fs.writeFileSync(
    ledger,
    [JSON.stringify({ metadata }), ...records.map((row) => JSON.stringify(row))].join("\n") + "\n",
  );
  const selection = path.join(directory, "selection.json");
  const result = path.join(directory, "result.json");
  const snapshot = path.join(directory, "snapshot.json");
  fs.writeFileSync(selection, JSON.stringify(input.selection));
  fs.writeFileSync(result, JSON.stringify(input.nativeRun));
  fs.writeFileSync(snapshot, input.selection.modelIdentity);
  const options = {
    ledger,
    selection,
    result,
    snapshot,
    gammaTick: 0.5,
    holdoutSeeds: ["reserved-holdout"],
    out: path.join(directory, "trained"),
  };
  for (const [index, mutation] of invalidNativeRuns().entries()) {
    const invalidOutput = path.join(directory, `invalid-native-${index}`);
    fs.writeFileSync(result, JSON.stringify({ ...input.nativeRun, ...mutation }));
    assert.throws(
      () => trainReturns({ ...options, out: invalidOutput }),
      /native|fingerprint|provenance|process/i,
    );
    assert.equal(fs.existsSync(invalidOutput), false);
  }
  const unsafeLoss = fixture({ win: false });
  unsafeLoss.nativeRun.result.intentBudgetViolated = true;
  fs.writeFileSync(result, JSON.stringify(unsafeLoss.nativeRun));
  const unsafeOutput = path.join(directory, "unsafe-loss");
  assert.throws(() => trainReturns({ ...options, out: unsafeOutput }), /budget/i);
  assert.equal(fs.existsSync(unsafeOutput), false);
  fs.writeFileSync(result, JSON.stringify(input.nativeRun));
  const bytesBefore = [ledger, selection, result, snapshot].map((file) =>
    hash(fs.readFileSync(file)),
  );
  const trained = trainReturns(options);
  assert.deepEqual(
    [ledger, selection, result, snapshot].map((file) => hash(fs.readFileSync(file))),
    bytesBefore,
  );
  const nativeModel = JSON.parse(fs.readFileSync(path.join(options.out, "model.json")));
  const provenance = JSON.parse(fs.readFileSync(path.join(options.out, "provenance.json")));
  C.validate(nativeModel);
  assert.equal(nativeModel.schema, "ofh-combat-compact-tanh-v2", "Old snapshot remains importable");
  assert.equal(provenance.futureHoldout.status, "unverified");
  assert.equal(provenance.futureHoldout.blocksPromotion, true);
  assert.deepEqual(
    provenance.originalManifest,
    input.selection.manifest,
    "Never forge original source/harness hashes",
  );
  assert.equal(provenance.currentTrainerSourceHash, provenance.bindings.nativeTrainer.hash);
  assert.equal(provenance.modelHash, hash(canonical(nativeModel)));
  assert.deepEqual(
    trained.provenance.returns.map((row) => row.return),
    [0.5 ** 10, 0.5 ** 7, 0.5 ** 3],
  );
  const completedHash = hash(fs.readFileSync(path.join(options.out, "model.json")));
  assert.throws(() => trainReturns(options), /EEXIST/);
  assert.equal(
    hash(fs.readFileSync(path.join(options.out, "model.json"))),
    completedHash,
    "Immutable output cannot be replaced",
  );
  assert.throws(() => trainReturns({ ...options, gammaTick: undefined }), /gamma-tick/);
  assert.throws(
    () => trainReturns({ ...options, holdoutSeeds: [input.selection.manifest.seed] }),
    /overlap/,
  );
  const cliOut = path.join(directory, "cli-trained");
  const stdout = execFileSync(
    process.execPath,
    [
      "scripts/headless/train-hybrid-returns.mjs",
      "--ledger",
      ledger,
      "--selection",
      selection,
      "--result",
      result,
      "--snapshot",
      snapshot,
      "--out",
      cliOut,
      "--gamma-tick",
      "0.5",
      "--holdout-seeds",
      "cli-holdout",
    ],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(stdout).fitted, 3);
  assert.equal(JSON.parse(stdout).holdout, "unverified");
  const capped = setStopReason(structuredClone(input), "max_ticks").nativeRun;
  fs.writeFileSync(result, JSON.stringify(capped));
  const capOutput = path.join(directory, "cap");
  assert.throws(() => trainReturns({ ...options, out: capOutput }), /Excluded/);
  assert.equal(fs.existsSync(capOutput), false, "Cap writes no defeat-labelled model");
  fs.writeFileSync(result, JSON.stringify(input.nativeRun));
  // Mutation occurs only in this test's temporary input, during the before/after guard.
  const read = fs.readFileSync;
  let selectionReads = 0;
  try {
    fs.readFileSync = function (file, ...args) {
      if (file === selection && ++selectionReads === 3) fs.appendFileSync(selection, " ");
      return read.call(fs, file, ...args);
    };
    const driftOutput = path.join(directory, "drift");
    assert.throws(() => trainReturns({ ...options, out: driftOutput }), /input drift/);
    assert.equal(fs.existsSync(driftOutput), false);
  } finally {
    fs.readFileSync = read;
  }
} finally {
  fs.rmSync(directory, { recursive: true });
}

process.stdout.write(
  "hybrid return training: passed (native SGD; pure offline fixtures, no strength claim)\n",
);
