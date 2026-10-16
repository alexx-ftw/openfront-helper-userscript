import assert from "node:assert/strict";
import { canonical } from "./hybrid-trajectory-contract.mjs";

/** Fit ordered original records using the actual native batch SGD contract. */
export function fitBatch(trajectories, contract) {
  assert.equal(
    typeof contract.fitEpisodeBatchReturns,
    "function",
    "Native batch SGD API unavailable",
  );
  const before = canonical(trajectories);
  const fitted = contract.fitEpisodeBatchReturns(
    trajectories[0].snapshot,
    trajectories.map(({ records, context }) => ({ records, context })),
  );
  assert.equal(canonical(trajectories), before, "Native batch trainer mutated original input");
  contract.validate(fitted.model);
  assert.equal(fitted.model.reward, "discounted-terminal-win-return-v1");
  assert.equal(fitted.model.offline.version, "offline-terminal-return-batch-v1");
  assert.equal(
    JSON.stringify(fitted.model.offline.originModel),
    trajectories[0].selection.modelIdentity,
    "Batch origin differs from exact first original identity",
  );
  const count = trajectories.reduce((sum, trajectory) => sum + trajectory.records.length, 0);
  const updates = trajectories.reduce(
    (sum, trajectory) =>
      sum +
      trajectory.records.reduce((total, record) => total + (record.action === "attack" ? 2 : 1), 0),
    0,
  );
  assert.equal(fitted.summary.complete, true, "Incomplete native batch fit");
  assert.equal(fitted.summary.fitted, count, "Native batch record coverage mismatch");
  assert.equal(fitted.summary.updates, updates, "Native batch head update mismatch");
  assert.equal(fitted.summary.censored, 0, "Native batch silently censored records");
  assert.equal(
    fitted.summary.episodes,
    trajectories.length,
    "Native batch episode coverage mismatch",
  );
  validateFittedEpisodes(fitted.model, trajectories);
  return JSON.parse(JSON.stringify(fitted));
}

function validateFittedEpisodes(model, trajectories) {
  const expected = trajectories.map(({ context, records }) => {
    const stored = { ...context };
    delete stored.modelIdentity;
    return {
      ...stored,
      fittedRecords: records.length,
      originalDecisionSteps: records.map((record) => record.decisionStep),
    };
  });
  assert.equal(
    canonical(model.offline.episodes),
    canonical(expected),
    "Native batch changed original context, coverage, ordering or steps",
  );
  assert.equal(
    model.offline.fittedRecords,
    expected.reduce((sum, episode) => sum + episode.fittedRecords, 0),
  );
  const updates = {
    wait: 0,
    act: model.offline.fittedRecords,
    target: model.offline.fittedRecords,
  };
  assert.equal(
    canonical(model.offline.headUpdates),
    canonical(updates),
    "Conditional batch head deltas mismatch",
  );
  for (const name of Object.keys(updates)) {
    assert.equal(
      model.models[name].samples,
      trajectories[0].snapshot.models[name].samples + updates[name],
      "Native batch sample delta mismatch",
    );
  }
}
