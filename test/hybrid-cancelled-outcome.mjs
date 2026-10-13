import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
import { outcomeTransitionFlags } from "../scripts/headless/hybrid-evaluation-contract.mjs";

// Exercise the actual producer helpers and both callers without launching games.
const source = readRepositoryFile("scripts/headless/opponent-adapter.js");
const evidenceSource = source
  .slice(
    source.indexOf("export class HybridRuntimeEvidence"),
    source.indexOf("export class HybridFifoDispatcher"),
  )
  .replace("export class", "class");
const helpers = source.slice(
  source.indexOf("function installHybridRuntimeEvidence"),
  source.indexOf("function configureHybridCombat"),
);
const finalize = source.slice(
  source.indexOf("  finalizeHybridCombatObservation(stopReason) {"),
  source.indexOf("  recordHybridEpisodeClosure(reason, terminal, policy) {"),
);
const api = executeClassicScript(
  evidenceSource +
    helpers +
    "\nclass Caller {" +
    finalize +
    "}\n({ installHybridRuntimeEvidence, cancelledHybridOutcome, finalize: Caller.prototype.finalizeHybridCombatObservation });",
  { fs, os, path, process, outcomeTransitionFlags },
);
const pending = {
  episodeId: 3,
  generation: 7,
  tick: 20,
  target: true,
  actorSmallID: 4,
  decisionStep: 9,
  decisionSequence: 40,
  acceptedSequence: 41,
  controlledAction: "attack",
  learned: true,
  behaviorPolicy: "compact-neural",
  behaviorProbability: null,
  logProbability: null,
  receiptID: null,
  confirmed: false,
  modelIdentity: JSON.stringify({ schema: "v3", normalizer: "original" }),
};
function check(row, sequence, reason) {
  for (const key of [
    "actorSmallID",
    "decisionStep",
    "decisionSequence",
    "acceptedSequence",
    "controlledAction",
    "learned",
    "behaviorPolicy",
    "behaviorProbability",
    "logProbability",
  ]) {
    assert.equal(row[key], pending[key], key);
  }
  assert.equal(row.sequence, sequence);
  assert.equal(row.reward, null);
  assert.equal(row.receiptID, null);
  assert.equal(row.confirmed, false);
  assert.equal(row.terminal, false);
  assert.equal(row.reason, reason);
  assert.equal(row.truncated, reason !== "env_error");
  assert.equal(row.envError, reason === "env_error");
  assert.equal(row.featureVersion, "v3");
  assert.equal(row.normalizer, "original");
}
check(api.cancelledHybridOutcome(pending, "reset", { tick: 25 }, 42), 42, "reset");
const unknown = api.cancelledHybridOutcome({ tick: 1, target: true }, "env_error", null, 0);
for (const key of [
  "actorSmallID",
  "decisionStep",
  "decisionSequence",
  "acceptedSequence",
  "controlledAction",
  "behaviorProbability",
  "logProbability",
  "receiptID",
])
  assert.equal(unknown[key], null);
assert.equal(unknown.learned, false);
assert.equal(unknown.confirmed, false);
const createPolicy = executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/hybridModelContract.js") +
    readRepositoryFile("engine/ingame/auto-bot/hybridCombat.js") +
    "\n() => new HybridCombatPolicy({ storage: null });",
  { window: {}, state: { settings: { winFixes: true } }, console, performance },
);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-cancel-test-"));
try {
  for (const method of ["configure", "importModel", "resetEpisode"]) {
    const policy = { pending: { ...pending }, sequence: 42, generation: 7, episodeId: 3 };
    for (const name of ["configure", "importModel", "resetEpisode"])
      policy[name] = function () {
        this.pending = null;
        this.generation++;
        if (name === "resetEpisode") {
          this.sequence = 0;
          this.episodeId++;
        }
        return "original-result";
      };
    const evidence = api.installHybridRuntimeEvidence(
      {},
      { hybridCombatPolicy: policy },
      { runIdentity: "fixture", eventFile: path.join(directory, method + ".jsonl") },
    );
    evidence.observation = () => ({ tick: 25, gate: [0, 0, 0] });
    assert.equal(policy[method](), "original-result");
    check(evidence.rows.entries[0], 42, "reset");
    assert.equal(policy.sequence, method === "resetEpisode" ? 0 : 42);
    assert.equal(evidence.rows.entries[1].kind, "hybrid-episode-close");
    policy.pending = null;
    policy[method]();
    assert.equal(
      evidence.rows.entries.filter((row) => row.kind === "hybrid-combat-outcome").length,
      1,
    );
  }
  // Use the real house methods as well: successful compact import advances the
  // generation, whereas rejected imports must leave pending evidence untouched.
  for (const method of ["configure", "importModel", "resetEpisode"]) {
    const policy = createPolicy();
    const model = policy.createCompactModel();
    Object.assign(policy, { pending: { ...pending }, sequence: 42, generation: 7, episodeId: 3 });
    const evidence = api.installHybridRuntimeEvidence(
      {},
      { hybridCombatPolicy: policy },
      {
        runIdentity: "real-house-fixture",
        eventFile: path.join(directory, "house-" + method + ".jsonl"),
      },
    );
    evidence.observation = () => ({ tick: 25, gate: [0, 0, 0] });
    if (method === "importModel") {
      assert.throws(() => policy.importModel({}), /Incompatible/);
      assert.equal(evidence.rows.entries.length, 0);
      assert.equal(policy.sequence, 42);
      assert.equal(policy.pending.decisionSequence, 40);
    }
    policy[method](method === "importModel" ? model : {});
    check(evidence.rows.entries[0], 42, "reset");
    assert.equal(policy.sequence, method === "resetEpisode" ? 0 : 42);
  }
  for (const reason of ["max_ticks", "env_error"]) {
    const rows = [];
    const policy = { pending: { ...pending }, sequence: 42 };
    const caller = {
      pageGame: { myPlayer: () => ({ isAlive: () => true }) },
      game: { getWinner: () => null },
      nationBot: {
        observeHybridCombat: () => assert.fail("Censored stop cannot manufacture a terminal"),
      },
      harness: {
        internals: { hybridCombatPolicy: policy },
        evidence: { record: (row) => rows.push(row) },
      },
      hybridObservation: () => ({ tick: 25 }),
      recordHybridEpisodeClosure: () => {},
    };
    api.finalize.call(caller, reason);
    check(rows[0], 42, reason);
    assert.equal(policy.sequence, 43);
    assert.equal(policy.pending, null);
    api.finalize.call(caller, reason);
    assert.equal(rows.length, 1);
    assert.equal(policy.sequence, 43);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.warn(
  "PASS actual cancellation helpers and reset/finalization callers retain scoped metadata",
);
