import assert from "node:assert/strict";
import { houseIntentBudgetOracle } from "../scripts/headless/evaluate-hybrid-combat.mjs";
import {
  validateTransitions,
  transitionDiagnostic,
} from "../scripts/headless/hybrid-evaluation-contract.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HybridRuntimeEvidence,
  HybridFifoDispatcher,
} from "../scripts/headless/opponent-adapter.js";

const dir = mkdtempSync(path.join(tmpdir(), "ofh-runtime-evidence-"));
try {
  const file = path.join(dir, "events.jsonl");
  const evidence = new HybridRuntimeEvidence({ runIdentity: "launch-exact", capacity: 2, file });
  const row = {
    kind: "hybrid-combat-decision",
    episodeId: 1,
    generation: 3,
    step: 0,
    tick: 10,
    eligible: true,
    controlledAction: null,
    fallback: true,
    reserveRatio: 0.5,
    candidateCount: 1,
  };
  evidence.record(row);
  evidence.safety({
    ...row,
    attemptId: 1,
    reservePassed: false,
    legalityPassed: true,
    emitted: false,
  });
  evidence.safety({
    ...row,
    attemptId: 2,
    reservePassed: null,
    legalityPassed: null,
    emitted: true,
  });
  evidence.record({
    ...row,
    kind: "hybrid-combat-outcome",
    action: "wait",
    actionTick: 10,
    outcomeTick: 12,
    gate: [1, 0.5, 0.2, 0],
    nextGate: [1, 0.5, 0.3, 0],
    reward: 0.1,
    terminal: false,
    truncated: false,
    confirmed: true,
  });
  const snapshot = evidence.snapshot();
  assert.equal(snapshot.decisionRows[0].runIdentity, "launch-exact");
  assert.equal(snapshot.safety.reserveChecks, 1);
  assert.equal(
    snapshot.safety.reserveViolations,
    1,
    "failed reserve check remains visible even blocked",
  );
  assert.equal(snapshot.safety.illegalEmissions, 0);
  assert.equal(snapshot.coverage.unknownAttempts, 1);
  assert.equal(snapshot.coverage.emissionsWithoutChecks, 1);
  assert.equal(snapshot.transitions[0].potential, 0.2);
  assert.equal(snapshot.transitions[0].nextPotential, 0.3);
  assert.equal(snapshot.transitions[0].tick, 10);
  assert.equal(snapshot.transitions[0].nextTick, 12);
  assert.equal(snapshot.transitions[0].first, true);
  assert.equal(snapshot.ledger.fullDataset, false, "retention drops cannot claim complete dataset");
  assert.equal(
    snapshot.replay.records,
    undefined,
    "partial retained replay is not a canonical complete group",
  );
  assert.ok(Array.isArray(snapshot.retainedReplayRecords));
  const events = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.kind === "hybrid-combat-outcome"));
  assert.ok(events.every((event) => event.runIdentity === "launch-exact"));
  const eviction = new HybridRuntimeEvidence({ runIdentity: "evicted", capacity: 1 });
  eviction.record(row);
  eviction.record({ ...row, step: 1, tick: 11 });
  assert.equal(
    eviction.snapshot().decisionRows,
    undefined,
    "evicted conditional cohorts are unavailable, never a selected denominator",
  );
  const empty = new HybridRuntimeEvidence({ runIdentity: "launch-empty" }).snapshot();
  assert.equal(empty.safety.reserveChecks, 0, "active but unexercised is zero");
  assert.equal(empty.latencyScope, "hybrid-decision-wall-ms");
  const intervention = new HybridRuntimeEvidence({ runIdentity: "wait-intervention" });
  const cancelledWait = {
    ...row,
    kind: "hybrid-combat-outcome",
    action: "wait",
    actionTick: 10,
    outcomeTick: 12,
    reward: null,
    terminal: false,
    truncated: true,
    cancelled: true,
    reason: "competing-attack-emission",
  };
  intervention.record(cancelledWait);
  intervention.record({
    ...cancelledWait,
    actionTick: 12,
    outcomeTick: 13,
    cancelled: false,
    truncated: false,
    reason: null,
    reward: 0.1,
  });
  const interventionRows = intervention.snapshot().transitions;
  assert.equal(interventionRows[0].truncated, false, "censored WAIT does not end the game episode");
  assert.equal(interventionRows[0].observationTruncated, true);
  validateTransitions(interventionRows);
  assert.equal(
    transitionDiagnostic(interventionRows[0], { gammaTick: 0.9, coefficient: 1 }).usable,
    false,
  );
  assert.equal(cancelledWait.truncated, true, "original censored outcome remains intact");
  const capped = new HybridRuntimeEvidence({ runIdentity: "capped" });
  capped.record({ ...cancelledWait, reason: "max_ticks" });
  capped.record({
    ...cancelledWait,
    actionTick: 12,
    outcomeTick: 13,
    cancelled: false,
    truncated: false,
    reason: null,
  });
  assert.throws(() => validateTransitions(capped.snapshot().transitions), /closed/);
  assert.throws(() => new HybridRuntimeEvidence({ runIdentity: " " }));
  const fifo = new HybridFifoDispatcher({ delayTicks: 10 });
  assert.deepEqual(fifo.dispatch("seat1", 0, [{ type: "attack", troops: 1 }]), []);
  assert.deepEqual(fifo.dispatch("seat1", 1, [{ type: "attack", troops: 2 }]), []);
  const drained = fifo.dispatch("seat1", 20, []);
  assert.deepEqual(
    drained.map((intent) => intent.troops),
    [1, 2],
    "skipped ticks drain without seat overtaking",
  );
  assert.equal(fifo.snapshot().nativeChecks, 2);
  fifo.clear();
  assert.deepEqual(fifo.dispatch("seat1", 30, []), []);
  const clustered = new HybridFifoDispatcher({ delayTicks: 100 });
  for (let t = 0; t < 12; t++) clustered.dispatch("seat1", t, [{ type: "attack", troops: t }]);
  const arrivals = clustered.dispatch("seat1", 200, []);
  assert.ok(arrivals.length < 12, "delayed arrivals cluster against the native limiter");
  assert.ok(clustered.snapshot().rejected > 0);
  const oracle = houseIntentBudgetOracle(
    clustered.snapshot().arrivals.map((row) => ({ atMs: row.atMs, type: "intent" })),
  );
  for (let i = 0; i < oracle.results.length; i++) {
    if (oracle.results[i].accepted)
      assert.equal(
        clustered.snapshot().arrivals[i].result,
        "ok",
        "house-admitted actual arrivals satisfy the native predicate",
      );
  }
  assert.equal(clustered.snapshot().pendingBatches, 0);
} finally {
  rmSync(dir, { recursive: true });
}
process.stdout.write("hybrid runtime evidence tests passed\n");
