import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
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
  supportingFileFixture,
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
    assert.equal(JSON.stringify(trained.model.offline.originModel), input.selection.modelIdentity);
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

function mutateSupportingFile(file, mutation, original) {
  if (mutation === "content") fs.appendFileSync(file, " ");
  else if (mutation === "missing") fs.unlinkSync(file);
  else {
    const replacement = `${file}.replacement`;
    fs.writeFileSync(replacement, original);
    fs.unlinkSync(file);
    fs.symlinkSync(replacement, file);
  }
}

function supportingFitChecks(directory) {
  for (const phase of ["before", "during"]) {
    for (const mutation of ["content", "path", "missing"]) {
      const file = path.join(directory, `direct-${phase}-${mutation}.jsonl`);
      const trajectory = validateFixture(supportingFileFixture(file));
      assert.ok(trajectory.records.some((row) => row.action !== "wait"));
      const original = fs.readFileSync(file);
      let calls = 0;
      const contract = {
        ...C,
        fitEpisodeReturns(...args) {
          calls++;
          const fitted = C.fitEpisodeReturns(...args);
          mutateSupportingFile(file, mutation, original);
          return fitted;
        },
      };
      if (phase === "before") mutateSupportingFile(file, mutation, original);
      assert.throws(() => fitTrajectory(trajectory, contract), /supporting|drift|ENOENT/i);
      assert.equal(calls, phase === "before" ? 0 : 1);
    }
  }
}

function supportingPublicationChecks(directory) {
  for (const phase of ["fit", "model.json", "trained-model.json", "provenance.json"]) {
    for (const mutation of ["content", "path", "missing"]) {
      const prefix = path.join(directory, `${phase}-${mutation}`);
      const file = `${prefix}.admissions.jsonl`;
      const input = supportingFileFixture(file);
      const options = supportingTrainingOptions(prefix, input);
      const original = fs.readFileSync(file);
      const run = vm.runInNewContext;
      const link = fs.linkSync;
      try {
        vm.runInNewContext = function (...args) {
          const native = run.apply(vm, args);
          if (!args[2]?.filename?.endsWith("/hybridModelContract.js")) return native;
          return {
            ...native,
            fitEpisodeReturns(...fitArgs) {
              const fitted = native.fitEpisodeReturns(...fitArgs);
              if (phase === "fit") mutateSupportingFile(file, mutation, original);
              return fitted;
            },
          };
        };
        fs.linkSync = function (temporary, destination) {
          const linked = link.call(fs, temporary, destination);
          if (path.basename(destination) === phase) {
            mutateSupportingFile(file, mutation, original);
            fs.writeFileSync(path.join(options.out, "foreign-sentinel"), "preserve");
          }
          return linked;
        };
        assert.throws(() => trainReturns(options), /supporting|drift|ENOENT/i);
        if (phase === "fit") assert.equal(fs.existsSync(options.out), false);
        else {
          assert.deepEqual(fs.readdirSync(options.out), ["foreign-sentinel"]);
          assert.equal(
            fs.readFileSync(path.join(options.out, "foreign-sentinel"), "utf8"),
            "preserve",
          );
        }
      } finally {
        vm.runInNewContext = run;
        fs.linkSync = link;
      }
    }
  }
}

function supportingTrainingOptions(prefix, input) {
  const options = {
    ledger: `${prefix}.ledger.jsonl`,
    selection: `${prefix}.selection.json`,
    result: `${prefix}.result.json`,
    snapshot: `${prefix}.snapshot.json`,
    gammaTick: input.gammaTick,
    holdoutSeeds: ["reserved-supporting-holdout"],
    out: `${prefix}.trained`,
  };
  fs.writeFileSync(options.ledger, encodeLedger(input.dataset));
  fs.writeFileSync(options.selection, JSON.stringify(input.selection));
  fs.writeFileSync(options.result, JSON.stringify(input.nativeRun));
  fs.writeFileSync(options.snapshot, input.selection.modelIdentity);
  return options;
}

function supportingTrainingChecks(directory) {
  const file = path.join(directory, "valid-admissions.jsonl");
  const input = supportingFileFixture(file);
  const trajectory = validateFixture(input);
  assert.ok(
    trajectory.records.every(
      (row) => row.behaviorPolicy === "deterministic-native-tribe-choice-v1",
    ),
    `Supporting fixture retained ACT behaviorPolicy: ${trajectory.records.map((row) => row.behaviorPolicy)}`,
  );
  const fitted = fitTrajectory(trajectory, C);
  assert.ok(fitted.model.models.target.samples >= 1, "Real native retained ACT target SGD");
  const options = supportingTrainingOptions(path.join(directory, "valid-supporting"), input);
  const trained = trainReturns(options);
  assert.deepEqual(trained.model, fitted.model);
  assert.deepEqual(trained.provenance.supportingFiles, trajectory.supportingFiles);
  const provenance = JSON.parse(fs.readFileSync(path.join(options.out, "provenance.json")));
  assert.deepEqual(provenance.supportingFiles, trajectory.supportingFiles);
  for (const key of ["ledger", "selection", "result", "snapshot"])
    assert.deepEqual(provenance.bindings[key], {
      path: fs.realpathSync(options[key]),
      hash: hash(fs.readFileSync(options[key])),
    });
  supportingFitChecks(directory);
  supportingPublicationChecks(directory);
}

function foreignPublicationChecks(directory) {
  for (const name of [
    "model.json",
    "model.json.tmp",
    "trained-model.json",
    "trained-model.json.tmp",
    "provenance.json",
    "provenance.json.tmp",
  ]) {
    const options = supportingTrainingOptions(path.join(directory, `foreign-${name}`), fixture());
    const mkdir = fs.mkdirSync;
    try {
      fs.mkdirSync = function (target, ...args) {
        const created = mkdir.call(fs, target, ...args);
        if (target === options.out) fs.writeFileSync(path.join(target, name), "foreign");
        return created;
      };
      assert.throws(() => trainReturns(options), /EEXIST/);
      assert.deepEqual(fs.readdirSync(options.out), [name]);
      assert.equal(fs.readFileSync(path.join(options.out, name), "utf8"), "foreign");
    } finally {
      fs.mkdirSync = mkdir;
    }
  }
}

function evaluationContractDriftChecks(directory) {
  const utility = fs.realpathSync("scripts/headless/hybrid-evaluation-contract.mjs");
  const original = fs.readFileSync(utility);
  const read = fs.readFileSync;
  const options = supportingTrainingOptions(
    path.join(directory, "evaluation-contract-drift"),
    fixture(),
  );
  let reads = 0;
  try {
    fs.readFileSync = function (file, ...args) {
      const bytes = read.call(fs, file, ...args);
      if (file === utility && ++reads > 1) return Buffer.concat([bytes, Buffer.from("\n")]);
      return bytes;
    };
    assert.throws(() => trainReturns(options), /evaluationContract input drift/);
    assert.equal(fs.existsSync(options.out), false);
  } finally {
    fs.readFileSync = read;
  }
  assert.deepEqual(fs.readFileSync(utility), original, "Utility source stays unchanged");
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-return-tests-"));
try {
  evaluationContractDriftChecks(directory);
  const directProof = path.join(directory, "direct-proof.jsonl");
  fs.writeFileSync(directProof, "synthetic supporting bytes\n");
  const directTrajectory = validateFixture(fixture());
  directTrajectory.supportingFiles = [
    {
      declaredPath: directProof,
      path: fs.realpathSync(directProof),
      hash: hash(fs.readFileSync(directProof)),
    },
  ];
  fs.appendFileSync(directProof, "drift");
  assert.throws(() => fitTrajectory(directTrajectory, C), /supporting|drift/i);
  fs.writeFileSync(directProof, "synthetic supporting bytes\n");
  assert.throws(
    () =>
      fitTrajectory(directTrajectory, {
        ...C,
        fitEpisodeReturns(...args) {
          const fitted = C.fitEpisodeReturns(...args);
          fs.appendFileSync(directProof, "drift during real native SGD");
          return fitted;
        },
      }),
    /supporting|drift/i,
  );
  foreignPublicationChecks(directory);
  supportingTrainingChecks(directory);
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
  const envelope = JSON.parse(fs.readFileSync(path.join(options.out, "trained-model.json")));
  const evaluationContract = fs.realpathSync("scripts/headless/hybrid-evaluation-contract.mjs");
  assert.deepEqual(provenance.bindings.evaluationContract, {
    path: evaluationContract,
    hash: hash(fs.readFileSync(evaluationContract)),
  });
  assert.equal(envelope.evaluationContractHash, input.selection.manifest.evaluationContractHash);
  assert.equal(envelope.format, "ofh-hybrid-combat-evaluation-v2");
  assert.equal(envelope.modelHash, hash(canonical(nativeModel)));
  assert.deepEqual(envelope.model, nativeModel);
  assert.equal(envelope.configurationHash, input.selection.manifest.configurationHash);
  assert.equal(envelope.sourceHash, input.selection.manifest.sourceHash);
  assert.equal(
    envelope.rewardHash,
    hash(canonical({ reward: nativeModel.reward, offline: nativeModel.offline })),
  );
  assert.deepEqual(envelope.returnTraining, provenance);
  assert.deepEqual(envelope.trainingSeeds, provenance.trainingSeeds);
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
