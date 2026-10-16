function targetEvidence(C, profile, tick, gate) {
  const geometry = {
    source: "native-border-centroid-v1",
    targetSmallID: 2,
    tick,
    width: 10,
    height: 10,
    own: { x: 1, y: 1 },
    target: { x: 2, y: 2 },
  };
  if (profile)
    geometry.frontier = {
      source: "native-target-frontier-v1",
      actorSmallID: 1,
      targetSmallID: 2,
      generation: 3,
      tick,
      ownBorderCount: 4,
      sharedFrontierCount: 2,
      ownMaxTroops: 100,
      incomingFromTargetTroops: 20,
    };
  const features = [
    ...gate,
    0.1,
    0.2,
    0.5,
    0.2,
    0.1,
    ...C.geometry(geometry, 2, tick).features,
    ...(profile
      ? C.frontierFeatures(geometry.frontier, {
          actorSmallID: 1,
          targetSmallID: 2,
          tick,
          generation: 3,
        }).features
      : []),
  ];
  return { geometry, features };
}

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  canonical,
  hash,
  campaignIdentity,
  terminalReturns,
  validateTrajectory,
} from "../scripts/headless/hybrid-trajectory-contract.mjs";
import { loadNativeContract } from "../scripts/headless/train-hybrid-returns.mjs";
import * as trajectoryContract from "../scripts/headless/hybrid-trajectory-contract.mjs";
const { verifySupportingFiles, supportingFilesFor } = trajectoryContract;
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
import { createAttackBehaviorSandbox } from "./helpers/attack-behavior-sandbox.mjs";

function warmSnapshot(C) {
  const snapshot = C.create();
  const gate = [1, 0.5, 0.2, 0.1];
  const { features } = targetEvidence(C, undefined, 2, gate);
  for (const role of ["wait", "act", "target"]) {
    const input = role === "target" ? features : gate;
    for (let sample = 0; sample < snapshot.models[role].hidden.length; sample++)
      snapshot.models[role] = C.update(
        snapshot.models[role],
        C.normalize(input, role, snapshot),
        0.2,
        snapshot.normalizer[role === "target" ? "target" : "gate"],
      );
  }
  C.validate(snapshot);
  return snapshot;
}

export async function producerChecks() {
  const input = fixture({ actions: ["wait", "attack"] });
  const events = [];
  const source =
    readRepositoryFile("engine/ingame/auto-bot/hybridModelContract.js") +
    "\n" +
    readRepositoryFile("engine/ingame/auto-bot/hybridCombat.js") +
    "\n({ C: HybridCombatContract, policy: hybridCombatPolicy });";
  const { C, policy } = executeClassicScript(source, {
    window: { localStorage: null },
    state: { settings: { winFixes: true } },
    PlayerType: { Bot: "BOT" },
    roundLogRecord: (_name, entry) =>
      events.push({
        ...JSON.parse(JSON.stringify(entry)),
        runIdentity: input.selection.manifest.runID,
      }),
  });
  policy.importModel(warmSnapshot(C));
  policy.configure({ mode: "learned", learning: false });
  assert.equal(
    policy.ready(),
    true,
    "Readiness comes from native SGD, not manually edited sample counts",
  );
  const target = { smallID: () => 2, type: () => "NATION", isPlayer: () => true };
  const behavior = {
    player: { smallID: () => 1, canAttackPlayer: () => true, sharesBorderWith: () => true },
    currentAttackDecisionTick: () => tick,
  };
  let tick = 2;
  const gate = [1, 0.5, 0.2, 0.1];
  for (const [step, action] of ["wait", "attack"].entries()) {
    const { geometry, features } = targetEvidence(C, undefined, tick, gate);
    const ranked = [{ target, geometry, features, score: 0 }];
    policy.proposal = {
      ...policy.decisionIdentity(behavior),
      step,
      funnel: { dispatchAttempts: 0 },
    };
    policy.scoredProposal(behavior, ranked, {
      wait: action === "wait" ? 1 : 0,
      act: action === "attack" ? 1 : 0,
      utilityMargin: action === "wait" ? -1 : 1,
      gate,
    });
    policy.pendingWait(behavior, gate);
    behavior.sendAttack = async (selected) => {
      const observation = {
        tick,
        gate,
        features,
        geometry,
        share: gate[2],
        actorSmallID: 1,
        targetSmallID: selected.smallID(),
        episodeId: policy.episodeId,
        generation: policy.generation,
        modelIdentity: JSON.stringify(policy.exportModel()),
        attackIds: [],
        ...policy.dispatchMetadata(selected.smallID()),
      };
      policy.recordAcceptedAction(behavior, selected, observation, policy.generation);
      return true;
    };
    assert.equal(await policy.controlProposal(behavior, ranked, action === "wait"), true);
    if (action === "attack")
      policy.confirmReceipt(policy.pending, { id: "native-callback-receipt" }, tick + 1);
    policy.recordOutcome(policy.pending, tick + 2, 0.2, gate, false);
    policy.pending = null;
    tick = 5;
  }
  bindProducerFixture(input, policy, events);
  const trajectory = validateFixture(input);
  assert.deepEqual(
    trajectory.records.map((record) => record.controlledAction),
    ["wait", "attack"],
  );
  assert.equal(
    trajectory.records[0].learned,
    true,
    "Actual controlled WAIT captures learned pending scope",
  );
  assert.ok(
    events.find((event) => event.kind === "hybrid-combat-accepted").sequence <
      events.find(
        (event) => event.kind === "hybrid-combat-decision" && event.controlledAction === "attack",
      ).sequence,
    "Actual acceptance precedes final controller decision",
  );
  assert.ok(trajectory.records.every((record) => record.terminal === false));
  process.stdout.write(
    "hybrid trajectory producer callbacks: passed (actual classic source; offline mocked observations)\n",
  );
}

function bindProducerFixture(input, policy, events) {
  const model = policy.exportModel();
  input.selection.modelIdentity = JSON.stringify(model);
  Object.assign(input.selection, { episodeId: policy.episodeId, generation: policy.generation });
  const manifest = input.selection.manifest;
  Object.assign(manifest, {
    modelHash: hash(canonical(model)),
    normalizerHash: hash(canonical(model.normalizer)),
    featureHash: hash(
      canonical({ schema: model.schema, features: model.features, actions: model.actions }),
    ),
  });
  input.dataset.records = events.map((event) => ({ manifest, event }));
  input.dataset.recordCount = events.length;
  const result = input.nativeRun.result;
  result.hybridCombat.model = model;
  result.hybridCombat.diagnostics = policy.diagnostics();
  Object.assign(result.hybridEvaluation.latestClosure, {
    episodeId: policy.episodeId,
    generation: policy.generation,
  });
  result.hybridEvaluation.ledger.entries = [...events, result.hybridEvaluation.latestClosure];
}

function outcomeFields(snapshot, action, { step, tick, gate, features, geometry, confirmed }) {
  return {
    action,
    controlledAction: action,
    actionTick: tick,
    outcomeTick: tick + 2,
    gate,
    nextGate: gate,
    features: action === "attack" ? features : null,
    geometry: action === "attack" ? geometry : null,
    featureVersion: snapshot.schema,
    normalizer: snapshot.normalizer,
    learned: true,
    confirmed: action === "wait" || confirmed,
    behaviorProbability: null,
    logProbability: null,
    receiptID: action === "attack" && confirmed ? `receipt-${step}` : null,
    reward: 0.2,
    terminal: false,
    truncated: false,
  };
}

function policyEvents(C, snapshot, actions, profile, { emit, events, confirmed }) {
  const gate = [1, 0.5, 0.2, 0.1];
  for (const [step, action] of actions.entries()) {
    const tick = [2, 5, 9][step] ?? step + 10;
    if (action === "declined") {
      emit("decision", {
        step,
        tick,
        actorSmallID: 1,
        controlledAction: null,
        fallback: true,
        reason: "no-native-eligible-target",
        decisionSequence: null,
        decisionReferenceKind: null,
      });
      continue;
    }
    const { geometry, features } = targetEvidence(C, profile, tick, gate);
    const proposal = emit("proposal", {
      step,
      tick,
      actorSmallID: 1,
      action,
      controlledAction: null,
      decisionSequence: events.length,
      decisionReferenceKind: "proposal",
      targetSmallID: action === "attack" ? 2 : null,
      gate,
      candidates: [
        {
          targetSmallID: 2,
          features,
          geometry,
          score: 0,
          legal: true,
          sourceTick: tick,
          legalitySource: "existing-canAttackPlayerNow-filter",
        },
      ],
      candidateCoverage: {
        complete: true,
        truncated: false,
        count: 1,
        scope: "feature-valid-native-eligible-targets",
      },
      behaviorProbability: null,
      logProbability: null,
      behaviorPolicy: "deterministic-wait-act-ranked-target",
    });
    const links = {
      decisionStep: step,
      decisionSequence: proposal.sequence,
      actorSmallID: 1,
      targetSmallID: action === "attack" ? 2 : null,
    };
    let acceptedSequence = null;
    if (action === "attack") {
      acceptedSequence = events.length;
      emit("accepted", {
        ...links,
        tick,
        gate,
        features,
        geometry,
        acceptedSequence,
        controlledAction: "attack",
        learned: true,
        behaviorProbability: null,
        logProbability: null,
      });
    }
    emit("decision", {
      ...proposal,
      kind: "hybrid-combat-decision",
      sequence: events.length,
      controlledAction: action,
    });
    if (action === "attack" && confirmed)
      emit("receipt", { ...links, tick: tick + 1, receiptID: `receipt-${step}`, acceptedSequence });
    emit("outcome", {
      ...links,
      acceptedSequence,
      ...outcomeFields(snapshot, action, { step, tick, gate, features, geometry, confirmed }),
    });
  }
}

export function fixture({
  win = true,
  profile,
  controlProfile,
  actions = ["wait", "attack", "wait"],
  confirmed = true,
} = {}) {
  const C = loadNativeContract();
  const snapshot = C.create({
    ...(profile ? { featureProfile: profile } : {}),
    ...(controlProfile ? { controlProfile } : {}),
  });
  const modelIdentity = JSON.stringify(snapshot);
  const manifest = {
    runID: "native-run-1",
    seed: "terminal-seed",
    engineRevision: "a".repeat(40),
    engineDiffHash: "b".repeat(64),
    experimentID: "terminal-return-fixture",
    sourceHash: "1".repeat(64),
    harnessHash: "2".repeat(64),
    bundleHash: "3".repeat(64),
    configurationHash: "4".repeat(64),
    featureHash: hash(
      canonical({
        schema: snapshot.schema,
        features: snapshot.features,
        actions: snapshot.actions,
      }),
    ),
    normalizerHash: hash(canonical(snapshot.normalizer)),
    modelHash: hash(canonical(snapshot)),
    learning: false,
    mode: "learned",
  };
  manifest.runID = hash(canonical([manifest.experimentID, manifest.seed, manifest.mode]));
  const selection = { manifest, episodeId: 1, generation: 3, modelIdentity };
  const events = [];
  const emit = (kind, values) => {
    const event = {
      kind: `hybrid-combat-${kind}`,
      episodeId: 1,
      generation: 3,
      runIdentity: manifest.runID,
      sequence: events.length,
      modelIdentity,
      ...values,
    };
    if (
      ["tribe-ranking-v1", "tribe-only-terminal-v1", "funded-tribe-terminal-v1"].includes(
        controlProfile,
      )
    ) {
      if (event.behaviorPolicy != null)
        event.behaviorPolicy = "deterministic-native-tribe-choice-v1";
      if (["proposal", "decision"].includes(kind))
        event.candidateSetSource = "native-leading-land-tribe-plan";
    }
    events.push(event);
    return event;
  };
  policyEvents(C, snapshot, actions, profile, { emit, events, confirmed });
  const dataset = {
    version: "ofh-hybrid-ledger-v1",
    eventScope: "policy-events-only",
    manifests: [manifest],
    recordCount: events.length,
    coverage: [
      {
        runID: manifest.runID,
        available: true,
        fullDataset: true,
        dropped: 0,
        frozenVerified: true,
      },
    ],
    records: events.map((event) => ({ manifest, event })),
  };
  const nativeRun = {
    launch: manifest,
    frozenVerified: true,
    code: win ? 0 : 2,
    interrupted: false,
    provenanceMatches: true,
    start: {
      phase: "start",
      seed: manifest.seed,
      engineFingerprint: { revision: manifest.engineRevision, diffHash: manifest.engineDiffHash },
    },
    result: {
      phase: "result",
      seed: manifest.seed,
      ticks: 12,
      stopReason: "winner",
      winner: win ? "our-team" : "opponent",
      won: win,
      intentBudgetViolated: false,
      hybridCombat: {
        model: snapshot,
        learning: false,
        mode: "learned",
        diagnostics: { learning: false, mode: "learned" },
      },
      hybridEvaluation: { ledger: { entries: [...events], fullDataset: true, dropped: 0 } },
    },
  };
  const closure = {
    kind: "hybrid-episode-close",
    runIdentity: manifest.runID,
    episodeId: 1,
    generation: 3,
    tick: 12,
    reason: "winner",
    terminated: true,
    truncated: false,
    envError: false,
  };
  nativeRun.result.hybridEvaluation.ledger.entries.push(closure);
  nativeRun.result.hybridEvaluation.latestClosure = closure;
  return { dataset, selection, nativeRun, gammaTick: 0.5 };
}

export function setStopReason(input, stopReason) {
  const result = input.nativeRun.result;
  Object.assign(result, { stopReason, winner: null, won: false, alive: false });
  const terminated = stopReason === "bot_dead";
  Object.assign(result.hybridEvaluation.latestClosure, {
    reason: stopReason,
    terminated,
    truncated: !terminated && stopReason !== "env_error",
    envError: stopReason === "env_error",
  });
  return input;
}

export function encodeLedger(dataset) {
  const metadata = { ...dataset };
  delete metadata.records;
  delete metadata.ledgerBytes;
  return Buffer.from(
    [JSON.stringify({ metadata }), ...dataset.records.map((row) => JSON.stringify(row))].join(
      "\n",
    ) + "\n",
  );
}

export function validateFixture(input, options = {}) {
  return validateTrajectory(
    { ...input.dataset, ledgerBytes: encodeLedger(input.dataset) },
    input.selection,
    input.nativeRun,
    {
      gammaTick: input.gammaTick,
      ...options,
    },
  );
}

function uncontrolledFixture(confirmed = true) {
  const input = fixture({ actions: ["attack"] });
  const ordinary = fixture({ confirmed });
  const sequenceMap = new Map();
  for (const row of ordinary.dataset.records) {
    if (!["accepted", "receipt", "outcome"].some((type) => row.event.kind.endsWith(type))) continue;
    const event = structuredClone(row.event);
    sequenceMap.set(event.sequence, input.dataset.records.length);
    event.sequence = input.dataset.records.length;
    Object.assign(event, {
      learned: false,
      controlledAction: null,
      decisionStep: null,
      decisionSequence: null,
      behaviorProbability: null,
      logProbability: null,
      behaviorPolicy: "legendary-unknown",
    });
    if (event.acceptedSequence !== null)
      event.acceptedSequence = sequenceMap.get(event.acceptedSequence);
    for (const field of ["tick", "actionTick", "outcomeTick"])
      if (event[field] !== undefined) event[field] += 15;
    if (event.receiptID) event.receiptID = `ordinary-${event.receiptID}`;
    input.dataset.records.push({ manifest: input.selection.manifest, event });
    input.nativeRun.result.hybridEvaluation.ledger.entries.splice(-1, 0, event);
  }
  input.dataset.recordCount = input.dataset.records.length;
  input.nativeRun.result.ticks = 40;
  input.nativeRun.result.hybridEvaluation.latestClosure.tick = 40;
  return input;
}

function uncontrolledChecks() {
  const input = uncontrolledFixture();
  const original = canonical(input);
  const trajectory = validateFixture(input, { gammaTick: 1 });
  assert.equal(trajectory.trainable, true);
  assert.equal(trajectory.records.length, 1, "Only the controlled attack trains");
  assert.equal(trajectory.context.coverage.decisionCount, 1);
  const fitted = loadNativeContract().fitEpisodeReturns(
    trajectory.snapshot,
    trajectory.records,
    trajectory.context,
  );
  assert.equal(fitted.summary.fitted, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fitted.model.offline.originalDecisionSteps)), [0]);
  assert.deepEqual(trajectory.context.coverage.excluded, []);
  assert.equal(trajectory.excluded.length, 5, "Every ordinary event is audited");
  assert.ok(trajectory.excluded.every((entry) => entry.decisionStep === undefined));
  assert.equal(canonical(input), original, "Full original ledger remains untouched");
  assert.equal(validateFixture(uncontrolledFixture(false)).records.length, 1);
  for (const mutate of [
    (events) => {
      events[0].learned = true;
    },
    (events) => {
      delete events[1].learned;
    },
    (events) => {
      events[2].controlledAction = "attack";
    },
    (events) => {
      events[3].decisionStep = 0;
    },
    (events) => {
      events[3].decisionSequence = 0;
    },
    (events) => {
      events[0].actorSmallID = 2;
    },
    (events) => {
      events[0].outcomeTick = 41;
    },
    (events) => {
      events[0].actionTick = 99;
    },
    (events) => {
      events[0].confirmed = false;
    },
    (events) => {
      events[0].receiptID = "fake-wait-receipt";
    },
    (events) => {
      events[1].acceptedSequence++;
    },
    (events) => {
      events[1].tick++;
    },
    (events) => {
      events[1].targetSmallID++;
    },
    (events) => {
      events[2].acceptedSequence++;
    },
    (events) => {
      events[2].actorSmallID++;
    },
    (events) => {
      events[2].tick = 40;
    },
    (events) => {
      events[2].tick = String(events[2].tick);
    },
    (events) => {
      events[2].receiptID = "receipt-0";
      events[3].receiptID = "receipt-0";
    },
    (events) => {
      events[3].acceptedSequence = 1;
    },
    (events) => {
      events[3].confirmed = false;
    },
    (events) => {
      events[3].features[0]++;
    },
    (events) => {
      events[1].kind = "hybrid-combat-observation-omitted";
    },
    (events) => {
      events[2].kind = "hybrid-combat-observation-omitted";
    },
    (events) => {
      events[3].kind = "hybrid-combat-observation-omitted";
    },
  ]) {
    const invalid = uncontrolledFixture();
    mutate(
      invalid.dataset.records.filter((row) => row.event.learned === false).map((row) => row.event),
    );
    assert.throws(() => validateFixture(invalid), /uncontrolled|WAIT|receipt|reference|features/i);
  }
  const missingControlled = uncontrolledFixture();
  missingControlled.dataset.records.find(
    (row) => row.event.kind === "hybrid-combat-outcome" && row.event.learned === true,
  ).event.kind = "hybrid-combat-observation-omitted";
  assert.throws(
    () => validateFixture(missingControlled),
    /Controlled decision missing pending outcome/,
  );
}

function integrityChecks() {
  uncontrolledChecks();
  const original = fixture();
  for (const index of [0, 4, original.dataset.records.length - 1]) {
    const input = structuredClone(original);
    input.dataset.records.splice(index, 1);
    input.dataset.recordCount--;
    input.nativeRun.result.hybridEvaluation.ledger.entries.splice(index, 1);
    assert.throws(
      () => validateFixture(input),
      /sequence|pending outcome/,
      "Dropped beginning/middle/end cannot fit sequentially",
    );
  }
  const duplicate = structuredClone(original);
  const row = structuredClone(duplicate.dataset.records[2]);
  row.event.reward = -0.2;
  duplicate.dataset.records.push(row);
  duplicate.dataset.recordCount++;
  duplicate.nativeRun.result.hybridEvaluation.ledger.entries.splice(-1, 0, row.event);
  assert.throws(() => validateFixture(duplicate), /duplicate policy sequence/);
  const orphan = structuredClone(original);
  const proposal = {
    ...structuredClone(orphan.dataset.records[0].event),
    step: 99,
    sequence: orphan.dataset.records.length,
    decisionSequence: orphan.dataset.records.length,
  };
  orphan.dataset.records.push({ manifest: orphan.selection.manifest, event: proposal });
  orphan.dataset.recordCount++;
  orphan.nativeRun.result.hybridEvaluation.ledger.entries.splice(-1, 0, proposal);
  assert.throws(() => validateFixture(orphan), /Orphan proposal/);
  const missingReceipt = structuredClone(original);
  missingReceipt.dataset.records.find(
    (entry) => entry.event.kind === "hybrid-combat-receipt",
  ).event.kind = "hybrid-combat-observation-omitted";
  assert.throws(() => validateFixture(missingReceipt), /Missing native attack receipt/);
  const unknownLegal = structuredClone(original);
  unknownLegal.dataset.records[0].event.candidates[0].legal = null;
  assert.throws(() => validateFixture(unknownLegal), /mask/);
  const reversedIdentity = structuredClone(original);
  reversedIdentity.selection.modelIdentity = JSON.stringify(
    Object.fromEntries(Object.entries(JSON.parse(original.selection.modelIdentity)).reverse()),
  );
  assert.throws(
    () => validateFixture(reversedIdentity),
    /model identity/,
    "Semantically equivalent JSON cannot rewrite ORIGINAL model identity",
  );
  const bound = { ...original.dataset, ledgerBytes: encodeLedger(original.dataset) };
  bound.recordCount--;
  assert.throws(
    () => validateTrajectory(bound, original.selection, original.nativeRun, { gammaTick: 0.5 }),
    /bound original full-file bytes/,
  );
  mixedRunChecks(original);
}

function mixedRunChecks(original) {
  const second = fixture({ win: false });
  const manifest = second.selection.manifest;
  manifest.seed = "other-native-seed";
  manifest.runID = hash(canonical([manifest.experimentID, manifest.seed, manifest.mode]));
  second.dataset.coverage[0].runID = manifest.runID;
  for (const row of second.dataset.records) row.event.runIdentity = manifest.runID;
  const dataset = {
    ...original.dataset,
    manifests: [...original.dataset.manifests, manifest],
    coverage: [...original.dataset.coverage, ...second.dataset.coverage],
    records: [...original.dataset.records, ...second.dataset.records],
    recordCount: original.dataset.recordCount + second.dataset.recordCount,
  };
  const selected = validateFixture({ ...original, dataset });
  assert.equal(
    selected.records.length,
    3,
    "Coincident local episode IDs across seeds never combine",
  );
  assert.equal(selected.context.terminalWin, true);
  assert.equal(selected.excluded.length, second.dataset.recordCount);
}

export function ambiguousFixture(options = {}) {
  const input = fixture({ ...options, actions: ["attack", "attack"] });
  const events = input.dataset.records.map((row) => row.event);
  const decision = structuredClone(events[2]);
  const scope = { episodeId: 1, generation: 3, runIdentity: input.selection.manifest.runID };
  const replacements = [
    {
      kind: "hybrid-combat-dispatch-attempt",
      sequence: 1,
      dispatchID: 1,
      decisionStep: 0,
      decisionSequence: 0,
      tick: 2,
      targetSmallID: 2,
    },
    {
      kind: "hybrid-combat-observation-omitted",
      sequence: 2,
      reason: "ambiguous-commitment",
      targetSmallID: 2,
    },
    {
      ...decision,
      sequence: 3,
      reason: ["tribe-ranking-v1", "tribe-only-terminal-v1", "funded-tribe-terminal-v1"].includes(
        options.controlProfile,
      )
        ? "controlled-tribe-choice"
        : "controlled-attack",
      fallback: false,
    },
    { kind: "hybrid-combat-observation-omitted", sequence: 4, reason: "forced-action" },
  ];
  replacements.forEach((replacement, index) => {
    for (const key of Object.keys(events[index + 1])) delete events[index + 1][key];
    Object.assign(events[index + 1], scope, replacement);
  });
  const safety = {
    ...scope,
    kind: "hybrid-safety",
    step: 0,
    attemptId: 1,
    tick: 2,
    targetSmallID: 2,
    emitted: true,
    reservePassed: true,
    legalityPassed: true,
    payloadTroops: 10,
    spendableTroops: 10,
  };
  input.nativeRun.result.hybridEvaluation.ledger.entries.splice(3, 0, safety);
  input.nativeRun.result.hybridEvaluation.safetyRows = [{ ...safety }];
  return input;
}

function censoredChecks() {
  const input = ambiguousFixture();
  const original = canonical(input);
  const trajectory = validateFixture(input, { gammaTick: 1 });
  assert.equal(trajectory.trainable, true);
  assert.deepEqual(
    trajectory.records.map((row) => row.decisionStep),
    [1],
  );
  assert.equal(trajectory.excluded[0].reason, "censored-ambiguous-commitment");
  assert.equal(canonical(input), original);
  assert.equal(
    loadNativeContract().fitEpisodeReturns(
      trajectory.snapshot,
      trajectory.records,
      trajectory.context,
    ).summary.fitted,
    1,
  );
  for (const mutate of [
    (safety) => {
      safety.emitted = false;
    },
    (safety) => {
      safety.reservePassed = false;
    },
    (safety) => {
      safety.legalityPassed = false;
    },
    (safety) => {
      safety.attemptId = 7;
    },
    (safety) => {
      safety.tick = 3;
    },
    (safety) => {
      safety.targetSmallID = 3;
    },
    (safety) => {
      delete safety.runIdentity;
    },
    (_safety, copy) => {
      copy.nativeRun.result.hybridEvaluation.ledger.entries.splice(3, 1);
    },
    (safety, copy) => {
      copy.nativeRun.result.hybridEvaluation.ledger.entries.splice(3, 0, { ...safety });
    },
    (_safety, copy) => {
      copy.dataset.records[2].event.reason = "unknown";
    },
    (_safety, copy) => {
      copy.dataset.records[2].event.targetSmallID = 3;
    },
    (_safety, copy) => {
      copy.dataset.records[2].event.tick = 1;
    },
    (_safety, copy) => {
      copy.dataset.records[1].event.decisionSequence = 3;
    },
    (_safety, copy) => {
      delete copy.dataset.records[3].event.actorSmallID;
    },
  ]) {
    const copy = ambiguousFixture();
    mutate(copy.nativeRun.result.hybridEvaluation.ledger.entries[3], copy);
    assert.throws(() => validateFixture(copy));
  }
}

function busyAttackChecks(controlProfile) {
  const input = fixture({
    actions: ["attack", "attack"],
    controlProfile,
    ...(controlProfile ? { profile: "frontier-v1" } : {}),
  });
  const events = input.dataset.records.map((row) => row.event);
  const ownerOutcome = events.find((event) => event.kind === "hybrid-combat-outcome");
  const decision = events.find(
    (event) => event.kind === "hybrid-combat-decision" && event.step === 1,
  );
  const proposal = events.find(
    (event) => event.kind === "hybrid-combat-proposal" && event.step === 1,
  );
  decision.reason = controlProfile ? "controlled-tribe-choice" : "controlled-attack";
  decision.fallback = false;
  const scope = { episodeId: 1, generation: 3, runIdentity: input.selection.manifest.runID };
  const attempt = {
    ...scope,
    kind: "hybrid-combat-dispatch-attempt",
    sequence: 100,
    dispatchID: 100,
    decisionStep: 1,
    decisionSequence: proposal.sequence,
    tick: decision.tick,
    targetSmallID: decision.targetSmallID,
  };
  const omission = {
    ...scope,
    kind: "hybrid-combat-observation-omitted",
    sequence: 101,
    phase: "acceptance",
    reason: "observation-pending",
    tick: decision.tick,
    targetSmallID: decision.targetSmallID,
  };
  ownerOutcome.outcomeTick = decision.tick + 1;
  const ordered = [
    ...events.filter(
      (event) =>
        event.decisionStep !== 1 &&
        event !== ownerOutcome &&
        !(event.kind === "hybrid-combat-proposal" && event.step === 1) &&
        !(event.kind === "hybrid-combat-decision" && event.step === 1),
    ),
    proposal,
    attempt,
    omission,
    decision,
    ownerOutcome,
  ];
  const mapping = new Map(ordered.map((event, index) => [event.sequence, index]));
  for (const event of ordered) {
    for (const field of ["decisionSequence", "acceptedSequence", "dispatchID"])
      if (event[field] != null) event[field] = mapping.get(event[field]);
    event.sequence = mapping.get(event.sequence);
  }
  input.dataset.records = ordered.map((event) => ({ ...input.dataset.records[0], event }));
  input.dataset.recordCount = ordered.length;
  const safety = {
    ...scope,
    kind: "hybrid-safety",
    step: 1,
    attemptId: attempt.dispatchID,
    tick: decision.tick,
    targetSmallID: decision.targetSmallID,
    emitted: true,
    reservePassed: true,
    legalityPassed: true,
    payloadTroops: 10,
    spendableTroops: 10,
  };
  const closure = input.nativeRun.result.hybridEvaluation.latestClosure;
  input.nativeRun.result.hybridEvaluation.ledger.entries = [...ordered];
  input.nativeRun.result.hybridEvaluation.ledger.entries.splice(attempt.sequence + 1, 0, safety);
  input.nativeRun.result.hybridEvaluation.ledger.entries.push(closure);
  input.nativeRun.result.hybridEvaluation.safetyRows = [safety];
  const options = controlProfile ? { gammaTick: 1 } : {};
  const validated = validateFixture(input, options);
  assert.equal(validated.records.length, 1);
  assert.equal(validated.excluded[0].reason, "censored-busy-act");
  assert.deepEqual(
    validated.records.map((record) => record.decisionStep),
    [0],
  );
  assert.equal(validated.context.coverage.excluded[0].decisionStep, 1);
  for (const mutate of [
    (copy) => {
      copy.dataset.records.find((row) => row.event.kind === omission.kind).event.phase = "unknown";
    },
    (copy) => {
      copy.dataset.records.find((row) => row.event.kind === ownerOutcome.kind).event.confirmed =
        false;
    },
    (copy) => {
      copy.dataset.records.find((row) => row.event.kind === omission.kind).event.tick++;
    },
    (copy) => {
      copy.dataset.records.find((row) => row.event.kind === ownerOutcome.kind).event.outcomeTick =
        2;
    },
    (copy) => {
      copy.dataset.records.find((row) => row.event.kind === ownerOutcome.kind).event.actorSmallID =
        99;
    },
    (copy) => {
      copy.nativeRun.result.hybridEvaluation.safetyRows[0].reservePassed = false;
    },
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => validateFixture(copy, options));
  }
  return input;
}

function uncontrolledBusyFixture(admissionFile) {
  const input = busyAttackChecks("tribe-only-terminal-v1");
  const events = input.dataset.records.map((row) => row.event);
  const decision = events.find(
    (event) => event.kind === "hybrid-combat-decision" && event.step === 0,
  );
  Object.assign(decision, { controlledAction: null, fallback: true, reason: "native-fallback" });
  const ownerEvents = events.filter((event) =>
    ["accepted", "receipt", "outcome"].some((kind) => event.kind === `hybrid-combat-${kind}`),
  );
  for (const event of ownerEvents)
    Object.assign(event, {
      learned: false,
      controlledAction: null,
      decisionStep: null,
      decisionSequence: null,
      behaviorPolicy: "legendary-unknown",
      behaviorProbability: null,
      logProbability: null,
    });
  const owner = ownerEvents.find((event) => event.kind === "hybrid-combat-outcome");
  const receipt = ownerEvents.find((event) => event.kind === "hybrid-combat-receipt");
  Object.assign(
    ownerEvents.find((event) => event.kind === "hybrid-combat-accepted"),
    { reason: "action-accepted", attackIds: [] },
  );
  receipt.reason = "native-receipt";
  receipt.tick = owner.actionTick;
  input.nativeRun.result.hybridEvaluation.attackAdmissionFile = admissionFile;
  input.nativeRun.result.hybridEvaluation.attackAdmissions = { attempts: 1 };
  return {
    input,
    owner,
    admission: {
      runIdentity: input.selection.manifest.runID,
      sequence: 0,
      tick: owner.actionTick,
      actorSmallID: owner.actorSmallID,
      targetSmallID: owner.targetSmallID,
      emitted: true,
      forced: false,
      reason: null,
      phase: "dispatch",
      path: "land",
      payloadTroops: 10,
      spendableTroops: 10,
    },
  };
}

/** Synthetic admission dependency with a retained controlled ACT; writes only the supplied file. */
export function supportingFileFixture(admissionFile) {
  const { input, admission } = uncontrolledBusyFixture(admissionFile);
  const retained = fixture({
    profile: "frontier-v1",
    controlProfile: "tribe-only-terminal-v1",
    actions: ["attack", "attack", "attack"],
  }).dataset.records.filter(({ event }) => event.step === 2 || event.decisionStep === 2);
  const offset = input.dataset.records.length - retained[0].event.sequence;
  for (const { event } of retained) {
    if (["accepted", "receipt", "outcome"].some((kind) => event.kind === `hybrid-combat-${kind}`))
      Object.assign(event, {
        behaviorPolicy: "deterministic-native-tribe-choice-v1",
        behaviorProbability: null,
        logProbability: null,
      });
    event.sequence += offset;
    for (const field of ["decisionSequence", "acceptedSequence"])
      if (event[field] != null) event[field] += offset;
  }
  input.dataset.records.push(...retained);
  input.dataset.recordCount = input.dataset.records.length;
  const evaluation = input.nativeRun.result.hybridEvaluation;
  evaluation.ledger.entries.splice(-1, 0, ...retained.map(({ event }) => event));
  input.gammaTick = 1;
  fs.writeFileSync(admissionFile, JSON.stringify(admission) + "\n");
  return input;
}

/** Supporting proofs must bind the exact validated admission bytes and survive later checks. */
export function supportingFileChecks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-supporting-"));
  const file = path.join(directory, "admissions.jsonl");
  try {
    const input = supportingFileFixture(file);
    const before = canonical(input);
    const result = validateFixture(input);
    assert.equal(result.trainable, true);
    assert.deepEqual(
      result.records.map((record) => record.decisionStep),
      [2],
    );
    supportingFixturePolicyChecks(input);
    assert.equal(canonical(input), before);
    assert.ok(Array.isArray(result.supportingFiles), "Actual admission proof list required");
    const bytes = fs.readFileSync(file);
    const proof = {
      declaredPath: path.resolve(file),
      path: fs.realpathSync(file),
      hash: hash(bytes),
    };
    assert.deepEqual(result.supportingFiles, [proof]);
    assert.deepEqual(supportingFilesFor(result), [proof]);
    assert.deepEqual(verifySupportingFiles([proof, { ...proof }]), [proof]);
    const unchanged = canonical(result);
    const admission = result.excluded.find((entry) => entry.ownerAdmission).ownerAdmission;
    assert.deepEqual(admission, { ...proof, sequence: 0 });
    assert.deepEqual(supportingFilesFor({ excluded: [] }), []);
    assert.deepEqual(verifySupportingFiles(), []);
    for (const list of [
      null,
      {},
      [null],
      [{}],
      [{ ...proof, hash: "invalid" }],
      [{ ...proof, declaredPath: "relative" }],
      [{ ...proof, path: "relative" }],
    ])
      assert.throws(() => verifySupportingFiles(list), /Malformed supporting/);
    for (const conflicting of [
      { ...proof, hash: "0".repeat(64) },
      { ...proof, path: path.join(directory, "different") },
      { ...proof, declaredPath: path.join(directory, "alias"), hash: "0".repeat(64) },
    ])
      assert.throws(() => verifySupportingFiles([proof, conflicting]), /Conflicting supporting/);
    for (const supportingFiles of [
      undefined,
      [],
      [{ ...proof, declaredPath: path.join(directory, "alias") }],
    ]) {
      if (supportingFiles?.length) fs.symlinkSync(file, supportingFiles[0].declaredPath);
      assert.throws(
        () => supportingFilesFor({ ...result, supportingFiles }),
        /supporting admission proof/,
      );
    }
    assert.throws(
      () =>
        supportingFilesFor({
          ...result,
          excluded: [{ ownerAdmission: { ...admission, declaredPath: "foreign" } }],
        }),
      /supporting admission proof/,
    );
    assert.throws(
      () =>
        supportingFilesFor({
          ...result,
          excluded: [],
          supportingFiles: [],
        }),
      /supporting admission proof/,
      "Context admission references also require their proofs",
    );
    fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(" ")]));
    assert.throws(
      () => verifySupportingFiles(result.supportingFiles),
      /Supporting file byte drift/,
    );
    fs.writeFileSync(file, bytes);
    fs.unlinkSync(file);
    assert.throws(() => verifySupportingFiles(result.supportingFiles), /ENOENT/);
    fs.writeFileSync(file, bytes);
    const other = path.join(directory, "identical.jsonl");
    const link = path.join(directory, "declared.jsonl");
    fs.writeFileSync(other, bytes);
    fs.symlinkSync(file, link);
    const aliased = structuredClone(input);
    aliased.nativeRun.result.hybridEvaluation.attackAdmissionFile = link;
    const linked = validateFixture(aliased);
    assert.equal(linked.supportingFiles[0].declaredPath, path.resolve(link));
    fs.unlinkSync(link);
    fs.symlinkSync(other, link);
    assert.throws(
      () => verifySupportingFiles(linked.supportingFiles),
      /Supporting file path drift/,
    );
    assert.equal(canonical(result), unchanged, "Verification must never mutate captured evidence");
    supportingExcludedChecks(file, proof);
    supportingReadDriftChecks(input, file, bytes, other, link);
    process.stdout.write(
      "supporting files: capture, drift, duplicate and completeness checks passed\n",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function supportingFixturePolicyChecks(input) {
  for (const { event } of input.dataset.records.filter(({ event }) =>
    ["accepted", "receipt", "outcome"].some((kind) => event.kind === `hybrid-combat-${kind}`),
  )) {
    assert.equal(
      event.behaviorPolicy,
      event.decisionStep === 2 ? "deterministic-native-tribe-choice-v1" : "legendary-unknown",
    );
    assert.equal(event.behaviorProbability, null);
    assert.equal(event.logProbability, null);
  }
}

function supportingExcludedChecks(file, proof) {
  const { supportingFilesFor } = trajectoryContract;
  const excluded = validateFixture(uncontrolledBusyFixture(file).input, { gammaTick: 1 });
  assert.equal(excluded.trainable, false);
  assert.deepEqual(excluded.supportingFiles, [proof]);
  assert.deepEqual(supportingFilesFor(excluded), [proof]);
  assert.throws(
    () => supportingFilesFor({ ...excluded, supportingFiles: [] }),
    /supporting admission proof/,
  );
}

function supportingReadDriftChecks(input, file, bytes, other, link) {
  const originalRead = fs.readFileSync;
  const aliased = structuredClone(input);
  aliased.nativeRun.result.hybridEvaluation.attackAdmissionFile = link;
  for (const drift of ["bytes", "path"]) {
    fs.unlinkSync(link);
    fs.symlinkSync(file, link);
    let changed = false;
    fs.readFileSync = function (filename, ...options) {
      const consumed = originalRead.call(this, filename, ...options);
      if (filename === file && !changed) {
        changed = true;
        if (drift === "bytes") fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(" ")]));
        else {
          fs.unlinkSync(link);
          fs.symlinkSync(other, link);
        }
      }
      return consumed;
    };
    try {
      assert.throws(() => validateFixture(aliased), /Supporting file (byte|path) drift/);
      assert.equal(changed, true, "Drift must occur after consuming the original admission bytes");
    } finally {
      fs.readFileSync = originalRead;
      fs.writeFileSync(file, bytes);
    }
  }
}

export function uncontrolledBusyChecks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ofh-busy-native-"));
  const file = path.join(directory, "admissions.jsonl");
  try {
    const { input, admission } = uncontrolledBusyFixture(file);
    const write = (row) => fs.writeFileSync(file, JSON.stringify(row) + "\n");
    write(admission);
    const before = canonical(input);
    const result = validateFixture(input, { gammaTick: 1 });
    assert.equal(
      result.records.length,
      0,
      "Neither uncontrolled owner nor omitted action is fitted",
    );
    assert.ok(
      result.excluded.some((row) => row.reason === "censored-busy-act" && row.decisionStep === 1),
    );
    assert.ok(
      result.excluded.some((row) => row.reason === "uncontrolled-policy-event" && row.receiptID),
    );
    assert.equal(canonical(input), before);
    for (const mutate of [
      (x) => {
        x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-receipt",
        ).event.receiptID = "orphan";
      },
      (x) => {
        x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-outcome",
        ).event.confirmed = false;
      },
      (x) => {
        x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-outcome",
        ).event.truncated = true;
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-accepted").event.learned =
          true;
      },
      (x) => {
        x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-receipt",
        ).event.actorSmallID = 99;
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-receipt").event.tick =
          100;
      },
      (x) => {
        x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-outcome",
        ).event.modelIdentity = "{}";
      },
      (x) => {
        x.nativeRun.result.hybridEvaluation.ledger.entries.find(
          (row) => row.kind === "hybrid-safety",
        ).legalityPassed = false;
      },
      (x) => {
        x.nativeRun.result.hybridEvaluation.attackAdmissions.attempts = 2;
      },
      (x) => {
        const receipt = x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-receipt",
        ).event;
        x.dataset.records.find(
          (row) => row.event.kind === "hybrid-combat-accepted",
        ).event.attackIds = [receipt.receiptID];
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-outcome").event.reason =
          "competing-attack-emission";
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-outcome").event.terminal =
          true;
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-receipt").event
          .generation++;
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-accepted").event
          .acceptedSequence++;
      },
      (x) => {
        x.dataset.records.find((row) => row.event.kind === "hybrid-combat-receipt").event
          .targetSmallID++;
      },
      (x) => {
        const owner = x.dataset.records.find((row) => row.event.kind === "hybrid-combat-outcome");
        x.dataset.records.push(structuredClone(owner));
        x.dataset.recordCount++;
      },
    ]) {
      const copy = structuredClone(input);
      mutate(copy);
      assert.throws(() => validateFixture(copy, { gammaTick: 1 }));
    }
    for (const patch of [
      { payloadTroops: 11 },
      { forced: true },
      { targetSmallID: 99 },
      { runIdentity: "foreign" },
      { emitted: false },
      { payloadTroops: 0 },
      { spendableTroops: null },
    ]) {
      write({ ...admission, ...patch });
      assert.throws(() => validateFixture(input, { gammaTick: 1 }));
    }
    const duplicate = structuredClone(input);
    duplicate.nativeRun.result.hybridEvaluation.attackAdmissions.attempts = 2;
    fs.writeFileSync(
      file,
      [admission, { ...admission, sequence: 1 }].map((row) => JSON.stringify(row)).join("\n") +
        "\n",
    );
    assert.throws(
      () => validateFixture(duplicate, { gammaTick: 1 }),
      /ambiguous uncontrolled native admission/,
    );
    fs.unlinkSync(file);
    assert.throws(() => validateFixture(input, { gammaTick: 1 }));
    process.stdout.write(
      "uncontrolled busy owner: strict exclusion/receipt/admission negatives passed\n",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function uncontrolledCancellationChecks() {
  const input = uncontrolledFixture();
  const last = input.dataset.records.at(-1).event;
  Object.assign(last, {
    reward: null,
    reason: "winner",
    terminal: false,
    truncated: true,
    envError: false,
    outcomeTick: 40,
  });
  const trajectory = validateFixture(input);
  assert.equal(trajectory.records.length, 1);
  assert.ok(
    trajectory.excluded.some((entry) => entry.reason === "uncontrolled-censored-winner-pending"),
  );
  const attack = input.dataset.records.find(
    (row) =>
      row.event.learned === false &&
      row.event.action === "attack" &&
      row.event.kind.endsWith("outcome"),
  ).event;
  Object.assign(attack, {
    reward: null,
    reason: "winner",
    terminal: false,
    truncated: true,
    envError: false,
    outcomeTick: 40,
  });
  assert.throws(() => validateFixture(input), /uncontrolled/);
}

function cancellationChecks() {
  const wait = fixture({ actions: ["wait", "wait"] });
  Object.assign(wait.dataset.records.at(-1).event, {
    reward: null,
    reason: "winner",
    terminal: false,
    truncated: true,
    envError: false,
    outcomeTick: 12,
  });
  assert.equal(validateFixture(wait).records.length, 1);
  wait.dataset.records.at(-1).event.confirmed = false;
  assert.throws(() => validateFixture(wait), /WAIT/);
  const input = fixture({ actions: ["attack", "attack"] });
  const last = input.dataset.records.at(-1).event;
  Object.assign(last, {
    reward: null,
    reason: "winner",
    terminal: false,
    truncated: true,
    envError: false,
    outcomeTick: 12,
  });
  const trajectory = validateFixture(input);
  assert.deepEqual(
    trajectory.records.map((row) => row.decisionStep),
    [0],
  );
  assert.equal(trajectory.excluded[0].reason, "censored-winner-pending");
  for (const mutate of [
    (copy) => {
      copy.dataset.records.at(-1).event.reason = "unknown";
    },
    (copy) => {
      copy.dataset.records.at(-1).event.outcomeTick = 11;
    },
    (copy) => {
      copy.dataset.records.at(-1).event.decisionSequence = 0;
    },
    (copy) => {
      copy.dataset.records.at(-1).event.actorSmallID = 7;
    },
    (copy) => {
      copy.dataset.records.at(-2).event.kind = "hybrid-combat-observation-omitted";
    },
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => validateFixture(copy));
  }
  const ordinary = uncontrolledFixture(false);
  const outcome = ordinary.dataset.records.find(
    (row) =>
      row.event.action === "attack" &&
      row.event.learned === false &&
      row.event.kind.endsWith("outcome"),
  ).event;
  outcome.reward = null;
  assert.equal(validateFixture(ordinary).records.length, 1);
  outcome.confirmed = true;
  assert.throws(() => validateFixture(ordinary), /uncontrolled/);
}

function coverageChecks() {
  censoredChecks();
  busyAttackChecks();
  busyAttackChecks("tribe-only-terminal-v1");
  cancellationChecks();
  uncontrolledCancellationChecks();
  const gappedInput = fixture({ actions: ["wait", "declined", "wait"] });
  const gapped = validateFixture(gappedInput);
  assert.equal(
    gapped.trainable,
    true,
    "Known fallback does not destroy complete trajectory coverage",
  );
  assert.deepEqual(
    gapped.records.map((record) => record.decisionStep),
    [0, 2],
  );
  assert.deepEqual(gapped.context.coverage, {
    version: "explicit-exclusions-complete-ledger-v1",
    ledgerHash: hash(encodeLedger(gappedInput.dataset)),
    decisionCount: 3,
    excluded: [{ decisionStep: 1, reason: "declined:no-native-eligible-target" }],
  });
  const unconfirmed = validateFixture(fixture({ confirmed: false }));
  assert.equal(unconfirmed.trainable, true);
  assert.deepEqual(
    unconfirmed.records.map((record) => record.decisionStep),
    [0, 2],
  );
  assert.deepEqual(unconfirmed.context.coverage.excluded, [
    { decisionStep: 1, reason: "unconfirmed-attack" },
  ]);
  assert.equal(validateFixture(fixture({ actions: ["declined"] })).trainable, false);
}

export function invalidNativeRuns() {
  return [
    { code: 1 },
    { code: undefined },
    { code: 2 },
    { interrupted: true },
    { interrupted: undefined },
    { provenanceMatches: false },
    { provenanceMatches: undefined },
    { start: undefined },
    { start: { phase: "start", seed: "terminal-seed" } },
    { start: { phase: "start", seed: "wrong" } },
    {
      start: {
        phase: "start",
        seed: "terminal-seed",
        engineFingerprint: { revision: "wrong", diffHash: "b".repeat(64) },
      },
    },
    {
      start: {
        phase: "start",
        seed: "terminal-seed",
        engineFingerprint: { revision: "a".repeat(40), diffHash: "wrong" },
      },
    },
    { signal: "SIGTERM" },
    { timedOut: true },
    { error: "failed" },
  ];
}

export function trajectoryChecks() {
  for (const mutation of invalidNativeRuns()) {
    const invalid = fixture();
    Object.assign(invalid.nativeRun, mutation);
    assert.throws(() => validateFixture(invalid), /native|fingerprint|provenance|process/i);
  }
  const unsafe = fixture({ win: false });
  unsafe.nativeRun.result.intentBudgetViolated = true;
  assert.throws(() => validateFixture(unsafe), /budget/i);

  const input = fixture();
  const trajectory = validateFixture(input);
  assert.deepEqual(
    trajectory.returns.map((row) => row.return),
    [0.5 ** 10, 0.5 ** 7, 0.5 ** 3],
  );
  assert.deepEqual(
    validateFixture(fixture({ win: false })).returns.map((row) => row.return),
    [-(0.5 ** 10), -(0.5 ** 7), -(0.5 ** 3)],
  );
  assert.ok(
    trajectory.records.every((row) => row.terminal === false),
    "Tactical flags never forged terminal",
  );
  assert.throws(() => validateFixture(input, { requireStochastic: true }), /policy gradients/);
  coverageChecks();
  integrityChecks();
  assert.equal(
    campaignIdentity({
      runID: "r",
      episodeId: 1,
      actorSmallID: 1,
      targetSmallID: 2,
      action: "attack",
      quantity: 20,
    }),
    campaignIdentity({
      runID: "r",
      episodeId: 1,
      actorSmallID: 1,
      targetSmallID: 2,
      action: "attack",
      quantity: 80,
    }),
  );
  assert.notEqual(
    campaignIdentity({
      runID: "r",
      episodeId: 1,
      actorSmallID: 1,
      targetSmallID: 2,
      action: "attack",
    }),
    campaignIdentity({
      runID: "r",
      episodeId: 1,
      actorSmallID: 1,
      targetSmallID: 3,
      action: "attack",
    }),
  );
  const rejects = (mutate, pattern) => {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => validateFixture(copy), pattern);
  };
  for (const gammaTick of [undefined, NaN, Infinity, -0.1, 1.1])
    assert.throws(() => validateFixture({ ...input, gammaTick }), /gammaTick/);
  for (const stopReason of ["max_ticks", "env_error", "engine_stop", "bot_dead"]) {
    const copy = structuredClone(input);
    setStopReason(copy, stopReason);
    const excluded = validateFixture(copy);
    assert.equal(excluded.trainable, false);
    assert.deepEqual(excluded.records, []);
  }
  rejects((x) => x.dataset.coverage[0].dropped++, /coverage/);
  rejects((x) => (x.dataset.coverage[0].fullDataset = false), /coverage/);
  rejects((x) => x.dataset.records.pop(), /full-file/);
  rejects((x) => x.dataset.records.reverse(), /native result ledger/);
  rejects((x) => x.dataset.records[0].event.generation++, /generation/);
  rejects(
    (x) => (x.dataset.records[0].event.modelIdentity = "{}"),
    /model identity|native result ledger/,
  );
  rejects((x) => (x.dataset.records[0].event.runIdentity = "other"), /run identity/);
  rejects((x) => (x.nativeRun.result.seed = "other"), /seed/);
  rejects((x) => x.nativeRun.result.hybridCombat.model.models.wait.samples++, /model differs/);
  rejects((x) => (x.dataset.records[0].event.behaviorProbability = 1), /probabilities/);
  rejects((x) => (x.dataset.records[0].event.logProbability = 0), /logp/);
  rejects((x) => x.dataset.records[0].event.candidates[0].sourceTick--, /mask/);
  rejects((x) => {
    x.dataset.records[0].event.candidates.push({ ...x.dataset.records[0].event.candidates[0] });
    x.dataset.records[0].event.candidateCoverage.count++;
  }, /mask/);
  const outcomeIndex = input.dataset.records.findIndex(
    (row) => row.event.kind === "hybrid-combat-outcome" && row.event.action === "attack",
  );
  rejects(
    (x) => (x.dataset.records[outcomeIndex].event.decisionStep = 99),
    /pending outcome|Orphan/,
  );
  rejects((x) => (x.dataset.records[outcomeIndex].event.decisionSequence = 99), /reference/);
  rejects(
    (x) => (x.dataset.records[outcomeIndex].event.controlledAction = "wait"),
    /control identity/,
  );
  rejects((x) => (x.dataset.records[outcomeIndex].event.targetSmallID = 3), /target/);
  rejects((x) => (x.dataset.records[outcomeIndex].event.truncated = true), /Truncated/);
  rejects((x) => x.dataset.records[2].event.actionTick++, /pending record/);
  rejects((x) => (x.dataset.records[2].event.learned = false), /not controlled/);
  rejects((x) => (x.dataset.records[1].event.controlledAction = null), /reason missing/);
  rejects(
    (x) => (x.dataset.records[outcomeIndex - 1].event.receiptID = "other"),
    /receipt reference/,
  );
  assert.throws(
    () =>
      terminalReturns([{ actionTick: 2, outcomeTick: 15, truncated: false, envError: false }], {
        gammaTick: 1,
        terminalTick: 12,
        terminalWin: true,
      }),
    /timing/,
  );
  process.stdout.write(
    "hybrid trajectory contract: passed (offline fixtures; confirmed producer fields)\n",
  );
}

function waitProducerRealm(mode = "learned") {
  const input = fixture({ actions: [] });
  input.selection.manifest.mode = mode;
  input.selection.manifest.runID = hash(
    canonical([input.selection.manifest.experimentID, input.selection.manifest.seed, mode]),
  );
  input.dataset.coverage[0].runID = input.selection.manifest.runID;
  input.nativeRun.result.hybridCombat.mode = mode;
  input.nativeRun.result.hybridEvaluation.latestClosure.runIdentity =
    input.selection.manifest.runID;
  const events = [];
  const sandbox = createAttackBehaviorSandbox();
  sandbox.window = { localStorage: null };
  sandbox.roundLogRecord = (_name, entry) =>
    events.push({
      ...JSON.parse(JSON.stringify(entry)),
      runIdentity: input.selection.manifest.runID,
    });
  const { C, policy } = executeClassicScript(
    readRepositoryFile("engine/ingame/auto-bot/hybridModelContract.js") +
      "\n" +
      readRepositoryFile("engine/ingame/auto-bot/hybridCombat.js") +
      "\n({ C: HybridCombatContract, policy: hybridCombatPolicy });",
    sandbox,
  );
  policy.importModel(warmSnapshot(C));
  policy.configure({ mode, learning: false });
  let tick = 2;
  let attacks = [];
  const target = {
    smallID: () => 2,
    id: () => "enemy",
    type: () => "NATION",
    isPlayer: () => true,
    isAlive: () => true,
    troops: () => 20,
    numTilesOwned: () => 10,
  };
  const behavior = {
    player: {
      smallID: () => 1,
      canAttackPlayer: () => true,
      sharesBorderWith: () => true,
      isFriendly: () => false,
      troops: () => 50,
      numTilesOwned: () => 20,
    },
    game: { config: () => ({ maxTroops: () => 100 }), numLandTiles: () => 100 },
    currentAttackDecisionTick: () => tick,
    incomingHostileAttackPressure: () => 0,
    getEarlyGameLiveReserveTroops: () => 10,
    getPlayerAttackPreferredTroopFloor: () => 20,
    getOutboundAttackSnapshot: () => attacks,
    getOutboundTransportSnapshot: () => [],
    getOutboundAttackTargetKey: (target) => target.smallID(),
    hybridCombatGeometry: () =>
      targetEvidence(C, undefined, tick, policy.gateFeatures(behavior)).geometry,
  };
  behavior.sendAttack = async (selected) => {
    const observation = policy.actionObservation(behavior, selected);
    policy.recordAcceptedAction(behavior, selected, observation, policy.generation);
    return true;
  };
  const finish = () => {
    bindProducerFixture(input, policy, events);
    return input;
  };
  return {
    input,
    sandbox,
    policy,
    target,
    behavior,
    finish,
    setTick: (value) => {
      tick = value;
    },
    setAttacks: (value) => {
      attacks = value;
    },
  };
}

async function produceControl(f, step, action) {
  const { policy, behavior, target } = f;
  const gate = policy.gateFeatures(behavior);
  const evidence = {};
  const features = policy.targetFeatures(behavior, target, gate, undefined, { evidence });
  const ranked = [{ target, features, geometry: evidence.geometry, score: 0 }];
  policy.proposal = { ...policy.decisionIdentity(behavior), step, funnel: { dispatchAttempts: 0 } };
  policy.scoredProposal(behavior, ranked, {
    gate,
    wait: Number(action === "wait"),
    act: Number(action === "attack"),
    utilityMargin: action === "attack" ? 1 : -1,
  });
  policy.pendingWait(behavior, gate);
  assert.equal(
    await policy.controlProposal(behavior, ranked, action === "wait"),
    policy.mode === "learned",
  );
}

async function busyWaitFixture(ownerAction) {
  const f = waitProducerRealm();
  await produceControl(f, 0, ownerAction);
  if (ownerAction === "attack") {
    f.setAttacks([{ id: "busy-owner-receipt", target: f.target, targetKey: "2", troops: 10 }]);
    f.setTick(3);
    f.policy.observe(f.behavior);
  }
  const owner = f.policy.pending;
  await produceControl(f, 1, "wait");
  assert.equal(f.policy.pending, owner, "busy WAIT preserves the earlier observation owner");
  f.setTick(ownerAction === "attack" ? 3 : 4);
  f.setAttacks([]);
  f.policy.observe(f.behavior);
  return f.finish();
}

function emissionSender(f, emitted) {
  const sender = Object.create(f.sandbox.AttackBehavior.prototype);
  Object.assign(sender, {
    player: f.behavior.player,
    game: { owner: () => f.target },
    currentAttackDecisionTick: f.behavior.currentAttackDecisionTick,
    captureSameClanNukeTerrain: () => {},
    reconcileOutboundAttackIntentCommitments: () => {},
    getForceAttackTroops: () => 30,
    canEmitBoatToDestination: () => true,
    boatLaunchWarshipDanger: () => false,
    boatDestinationReserved: () => false,
    resolveBoatTroops: (troops) => troops,
    recordOutboundAttackIntent: () => {},
    recordBoatDestinationIntent: () => {},
  });
  Object.assign(f.sandbox, {
    discoverCtors: () => ({ attack: () => {}, boat: () => {} }),
    getEventBus: () => ({}),
    hasAttackIntentRateCapacity: () => true,
    emitIntent: emitted,
    setLastAction: () => {},
    tr: (value) => value,
  });
  return sender;
}

async function intervenedWaitFixture(path, mode = "learned") {
  const f = waitProducerRealm(mode);
  await produceControl(f, 0, "wait");
  let emitted = false;
  const sender = emissionSender(f, () => emitted);
  const send = () => {
    if (path === "boat") return sender.emitBoat(7, 30, "fixture");
    if (path === "land")
      return sender.emitObservedAttackOrder(f.sandbox.discoverCtors().attack, 0, 1.5, "land");
    return sender.forceSendAttack(f.target);
  };
  const owner = f.policy.pending;
  assert.equal(await send(), false);
  assert.equal(f.policy.pending, owner, "rejected emission must preserve controlled WAIT");
  emitted = true;
  assert.equal(await send(), true);
  // The real dispatcher must censor at emission, not at a proposed/rejected order.
  f.setTick(5);
  await produceControl(f, 1, "wait");
  f.setTick(6);
  f.policy.observe(f.behavior);
  return f.finish();
}

function rejectsWaitMutation(input, change) {
  const invalid = structuredClone(input);
  change(invalid);
  assert.throws(
    () => validateFixture(invalid),
    /busy|WAIT|emission|owner|reference|receipt|sequence|Orphan|Truncated|ledger/i,
  );
}

async function waitExclusionChecks() {
  for (const action of ["attack", "wait"]) {
    const input = await busyWaitFixture(action);
    const trajectory = validateFixture(input);
    assert.deepEqual(
      trajectory.records.map((record) => record.decisionStep),
      [0],
    );
    assert.equal(trajectory.context.coverage.decisionCount, 2);
    assert.equal(trajectory.context.coverage.excluded[0].decisionStep, 1);
    assert.equal(trajectory.context.coverage.excluded[0].reason, "censored-busy-wait");
    assert.equal(
      input.nativeRun.result.hybridCombat.diagnostics.control.controlledWaits,
      action === "wait" ? 2 : 1,
    );
    const omission = (x) =>
      x.dataset.records.find((r) => r.event.phase === "controlled-wait-busy").event;
    rejectsWaitMutation(input, (x) => {
      omission(x).owner.decisionStep = 1;
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).owner.decisionSequence++;
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).owner.actionTick++;
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).owner.actorSmallID = 99;
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).owner.modelIdentity = "{}";
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).owner.targetSmallID = 99;
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).reason = "unknown-cancellation";
    });
    rejectsWaitMutation(input, (x) => {
      omission(x).decisionSequence++;
    });
    if (action === "attack")
      rejectsWaitMutation(input, (x) => {
        const receipt = x.dataset.records.find(
          (r) => r.event.kind === "hybrid-combat-receipt",
        ).event;
        receipt.receiptID = "unmatched";
      });
  }
  for (const path of ["forced-land", "boat", "land"]) {
    const input = await intervenedWaitFixture(path);
    const trajectory = validateFixture(input);
    assert.deepEqual(
      trajectory.records.map((record) => record.decisionStep),
      [1],
    );
    assert.equal(trajectory.context.coverage.decisionCount, 2);
    assert.equal(trajectory.context.coverage.excluded[0].reason, "censored-wait-intervention");
    assert.equal(trajectory.context.coverage.excluded[0].decisionStep, 0);
    const proof = (x) => x.dataset.records.find((r) => r.event.phase === "emission").event;
    const outcome = (x) =>
      x.dataset.records.find(
        (r) =>
          r.event.reason === "competing-attack-emission" &&
          r.event.kind === "hybrid-combat-outcome",
      ).event;
    rejectsWaitMutation(input, (x) => {
      outcome(x).emissionSequence = 99;
    });
    rejectsWaitMutation(input, (x) => {
      const rows = x.dataset.records;
      const proofEvent = proof(x);
      const decision = rows.find(
        (r) => r.event.kind === "hybrid-combat-decision" && r.event.step === 0,
      ).event;
      const proofIndex = rows.findIndex((r) => r.event === proofEvent);
      const decisionIndex = rows.findIndex((r) => r.event === decision);
      [rows[proofIndex], rows[decisionIndex]] = [rows[decisionIndex], rows[proofIndex]];
      [proofEvent.sequence, decision.sequence] = [decision.sequence, proofEvent.sequence];
      outcome(x).emissionSequence = proofEvent.sequence;
      const result = x.nativeRun.result.hybridEvaluation;
      result.ledger.entries = [...rows.map((r) => r.event), result.latestClosure];
    });
    rejectsWaitMutation(input, (x) => {
      proof(x).emission.emitted = false;
    });
    rejectsWaitMutation(input, (x) => {
      proof(x).emission.actorSmallID = 99;
    });
    rejectsWaitMutation(input, (x) => {
      proof(x).emission.tick = 0;
    });
    rejectsWaitMutation(input, (x) => {
      proof(x).emission.payloadTroops = 0;
    });
    rejectsWaitMutation(input, (x) => {
      proof(x).emission.path = "unknown";
    });
    rejectsWaitMutation(input, (x) => {
      outcome(x).reason = "unknown-cancellation";
    });
    rejectsWaitMutation(input, (x) => {
      proof(x).decisionSequence++;
    });
    rejectsWaitMutation(input, (x) => {
      outcome(x).reward = 0.2;
    });
    rejectsWaitMutation(input, (x) => {
      outcome(x).truncated = false;
    });
    rejectsWaitMutation(input, (x) => {
      x.nativeRun.result.hybridEvaluation.ledger.entries =
        x.nativeRun.result.hybridEvaluation.ledger.entries.filter((e) => e.phase !== "emission");
    });
  }
  await uncontrolledWaitExclusionChecks();
  process.stdout.write("WAIT exclusions: actual producer/dispatcher and validator passed\n");
}

async function uncontrolledWaitExclusionChecks() {
  for (const path of ["forced-land", "boat", "land"]) {
    const input = await intervenedWaitFixture(path, "shadow");
    const trajectory = validateFixture(input);
    assert.equal(trajectory.trainable, false);
    assert.equal(trajectory.records.length, 0);
    assert.ok(
      trajectory.excluded.some(
        (entry) => entry.reason === "uncontrolled-censored-wait-intervention",
      ),
    );
    assert.equal(input.nativeRun.result.hybridCombat.diagnostics.control.controlledWaits, 0);
  }
  const unknownOwner = waitProducerRealm();
  const observation = unknownOwner.policy.actionObservation(
    unknownOwner.behavior,
    unknownOwner.target,
  );
  unknownOwner.policy.recordAcceptedAction(
    unknownOwner.behavior,
    unknownOwner.target,
    observation,
    unknownOwner.policy.generation,
  );
  unknownOwner.setAttacks([
    { id: "uncontrolled-owner", target: unknownOwner.target, targetKey: "2", troops: 10 },
  ]);
  unknownOwner.setTick(3);
  unknownOwner.policy.observe(unknownOwner.behavior);
  await produceControl(unknownOwner, 0, "wait");
  unknownOwner.setTick(4);
  unknownOwner.setAttacks([]);
  unknownOwner.policy.observe(unknownOwner.behavior);
  assert.throws(() => validateFixture(unknownOwner.finish()), /Busy WAIT owner scope mismatch/);
}

function fundedEpisode(seed, win) {
  const input = fixture({
    profile: "frontier-v1",
    controlProfile: "funded-tribe-terminal-v1",
    actions: ["attack"],
    win,
  });
  const manifest = input.selection.manifest;
  manifest.seed = seed;
  manifest.runID = hash(canonical([manifest.experimentID, seed, manifest.mode]));
  input.nativeRun.start.seed = seed;
  input.nativeRun.result.seed = seed;
  input.dataset.coverage[0].runID = manifest.runID;
  for (const row of input.dataset.records) row.event.runIdentity = manifest.runID;
  for (const event of input.nativeRun.result.hybridEvaluation.ledger.entries) {
    event.runIdentity = manifest.runID;
    if (["accepted", "receipt", "outcome"].some((kind) => event.kind === `hybrid-combat-${kind}`)) {
      event.behaviorPolicy = "deterministic-native-tribe-choice-v1";
      event.behaviorProbability = null;
      event.logProbability = null;
    }
  }
  return input;
}

export function fundedProfileChecks() {
  const C = loadNativeContract();
  const inputs = [
    fundedEpisode("funded-original-win", true),
    fundedEpisode("funded-original-loss", false),
  ];
  const original = canonical(inputs);
  const trajectories = inputs.map((input) => validateFixture(input, { gammaTick: 1 }));
  const fitted = C.fitEpisodeBatchReturns(
    trajectories[0].snapshot,
    trajectories.map(({ records, context }) => ({ records, context })),
  );
  C.validate(fitted.model);
  assert.equal(C.learningAllowed(fitted.model), false);
  assert.equal(fitted.summary.fitted, 2);
  assert.equal(fitted.summary.updates, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(fitted.model.offline.headUpdates)), {
    wait: 0,
    act: 2,
    target: 2,
  });
  assert.equal(
    canonical(fitted.model.models.wait),
    canonical(trajectories[0].snapshot.models.wait),
  );
  assert.equal(JSON.stringify(fitted.model.offline.originModel), inputs[0].selection.modelIdentity);
  assert.deepEqual(
    trajectories.map((t) => t.returns[0].return),
    [1, -1],
  );
  assert.equal(canonical(inputs), original);
  assert.throws(() => validateFixture(inputs[0], { gammaTick: 0.9 }), /gammaTick/);
  busyAttackChecks("funded-tribe-terminal-v1");
  for (const mutate of [
    (input) => {
      input.dataset.coverage[0].dropped = 1;
    },
    (input) => {
      input.nativeRun.result.intentBudgetViolated = true;
    },
    (input) => {
      input.dataset.records.find(
        (row) => row.event.kind === "hybrid-combat-receipt",
      ).event.receiptID = "foreign";
    },
    (input) => {
      input.nativeRun.result.hybridCombat.model.actions.tribeRanking = "native-land-subset-v1";
    },
  ]) {
    const input = fundedEpisode("funded-native-negative", false);
    mutate(input);
    assert.throws(() => validateFixture(input, { gammaTick: 1 }));
  }
  for (const mutate of [
    (proposal) => {
      proposal.behaviorPolicy = "deterministic-wait-act-ranked-target";
    },
    (proposal) => {
      proposal.behaviorProbability = 1;
    },
    (proposal) => {
      proposal.candidateSetSource = "invented";
    },
  ]) {
    const input = fundedEpisode("funded-negative", false);
    mutate(input.dataset.records.find((row) => row.event.kind === "hybrid-combat-proposal").event);
    assert.throws(() => validateFixture(input, { gammaTick: 1 }));
  }
  process.stdout.write(
    "funded tribe N3: exact original batch SGD and strict policy negatives passed\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  supportingFileChecks();
  uncontrolledBusyChecks();
  fundedProfileChecks();
  trajectoryChecks();
  await producerChecks();
  await waitExclusionChecks();
}
