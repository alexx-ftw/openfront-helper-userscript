import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { trainReturnBatch } from "../../scripts/headless/train-hybrid-return-batch.mjs";
import { rejected } from "./hybrid-return-batch-fixtures.mjs";

/** Exercise supporting-file drift during real fitting and every publication. */
export function supportingDriftChecks({ episode, options }) {
  for (const boundary of ["fit", "model.json", "trained-model.json", "provenance.json"]) {
    for (const mutation of ["bytes", "path", "missing"]) {
      const e = episode(`support-${boundary}-${mutation}`, true, () => {}, ["attack"], true);
      const file = e.admissionFile;
      const bytes = fs.readFileSync(file);
      const target = `${file}.alternate`;
      const run = vm.runInNewContext;
      const link = fs.linkSync;
      let changed = false;
      const mutate = () => {
        assert.equal(changed, false);
        changed = true;
        if (mutation === "bytes") fs.appendFileSync(file, " ");
        else if (mutation === "missing") fs.unlinkSync(file);
        else {
          fs.writeFileSync(target, bytes);
          fs.unlinkSync(file);
          fs.symlinkSync(target, file);
        }
      };
      vm.runInNewContext = (...args) => {
        // Only the original trusted repository source is executed by the instrumented seam.
        // eslint-disable-next-line sonarjs/code-eval
        const contract = run(...args);
        if (typeof contract.fitEpisodeBatchReturns !== "function") return contract;
        return {
          ...contract,
          fitEpisodeBatchReturns: (...fitArgs) => {
            const fitted = contract.fitEpisodeBatchReturns(...fitArgs);
            if (boundary === "fit") mutate();
            return fitted;
          },
        };
      };
      fs.linkSync = (...args) => {
        const published = link(...args);
        if (path.basename(args[1]) === boundary) {
          fs.writeFileSync(path.join(path.dirname(args[1]), "foreign-marker"), "preserve");
          mutate();
        }
        return published;
      };
      const args = options([e], `drift-${boundary}-${mutation}`);
      try {
        assert.throws(() => trainReturnBatch(args), /drift|ENOENT/);
        assert.equal(changed, true, "Failure must occur after real native fit/publication");
        if (boundary === "fit") assert.equal(fs.existsSync(args.out), false);
        else {
          assert.deepEqual(fs.readdirSync(args.out), ["foreign-marker"]);
          assert.equal(fs.readFileSync(path.join(args.out, "foreign-marker"), "utf8"), "preserve");
        }
      } finally {
        vm.runInNewContext = run;
        fs.linkSync = link;
      }
    }
  }
}

/** Reject all supporting dependencies before any native fit. */
export function supportingPrefitChecks({ episode, options }) {
  const first = episode("support-prefit-first", true, () => {}, ["attack"], true);
  const second = episode("support-prefit-second", true, () => {}, ["attack"], true);
  const read = fs.readFileSync;
  const run = vm.runInNewContext;
  let fits = 0;
  let resultReads = 0;
  vm.runInNewContext = (...args) => {
    // Only trusted repository classic source is executed; fixture data stays JSON.
    // eslint-disable-next-line sonarjs/code-eval
    const contract = run(...args);
    if (typeof contract.fitEpisodeBatchReturns !== "function") return contract;
    return {
      ...contract,
      fitEpisodeBatchReturns: (...fitArgs) => {
        fits += 1;
        return contract.fitEpisodeBatchReturns(...fitArgs);
      },
    };
  };
  fs.readFileSync = (...args) => {
    const bytes = read(...args);
    if (args[0] === second.paths.result && ++resultReads === 2)
      fs.appendFileSync(first.admissionFile, " ");
    return bytes;
  };
  try {
    rejected(options([first, second], "prefit-drift"), /drift/);
    assert.equal(resultReads, 2, "Drift injected after first episode validation");
    assert.equal(fits, 0, "Every supporting proof must pass before any native fit");
  } finally {
    fs.readFileSync = read;
    vm.runInNewContext = run;
  }
  fs.unlinkSync(second.admissionFile);
  rejected(options([second], "prefit-missing"), /ENOENT/);
}

/** Simulate internal-module byte drift without changing repository files. */
export function internalModuleDriftCheck({ episode, options }) {
  for (const [key, name] of [
    ["batchInputs", "hybrid-return-batch-inputs"],
    ["batchFit", "hybrid-return-batch-fit"],
    ["batchPublication", "hybrid-return-batch-publication"],
    ["evaluationContract", "hybrid-evaluation-contract"],
  ]) {
    const internal = fileURLToPath(new URL(`../../scripts/headless/${name}.mjs`, import.meta.url));
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (...args) => {
      const bytes = originalRead(...args);
      if (args[0] === internal && ++reads > 1) return Buffer.concat([bytes, Buffer.from(" ")]);
      return bytes;
    };
    try {
      const baseline = originalRead(internal);
      rejected(
        options([episode(`module-drift-${name}`, true)], `module-drift-${name}`),
        new RegExp(`${key} input drift`),
      );
      assert.equal(reads, 2);
      assert.deepEqual(
        originalRead(internal),
        baseline,
        "Actual repository source remains unchanged",
      );
    } finally {
      fs.readFileSync = originalRead;
    }
  }
}
