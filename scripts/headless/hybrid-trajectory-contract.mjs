// Offline only: complete native decisions and terminal results, never tactical terminal inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

export const canonical = (value) =>
  JSON.stringify(value, function (key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((name) => [name, item[name]]),
        )
      : item;
  });
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const exact = (a, b, message) => assert.equal(canonical(a), canonical(b), message);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const kind = (event) => event.kind.replace(/^hybrid-combat-/, "");

export const PRODUCER_CONTRACT = Object.freeze({
  version: "euler-mcclintock-policy-ledger-v1",
  header: ["version", "eventScope", "manifests", "coverage", "recordCount"],
  row: ["manifest", "event"],
  eventScope: "policy-events-only",
  kinds: [
    "proposal",
    "decision",
    "dispatch-attempt",
    "accepted",
    "receipt",
    "outcome",
    "observation-omitted",
  ],
  incrementalPrefix: "hybrid-combat-",
  decisionReferenceKind: "proposal",
  references: ["decisionStep", "decisionSequence", "acceptedSequence", "receiptID"],
  deterministicLikelihood: { behaviorProbability: null, logProbability: null },
  candidate: [
    "targetSmallID",
    "features",
    "geometry",
    "score",
    "sourceTick",
    "legal",
    "legalitySource",
  ],
  candidateCoverage: "feature-valid-native-eligible-targets",
  control: "final decision.controlledAction plus matched pending outcome.controlledAction/learned",
  nativeResult: [
    "phase",
    "seed",
    "won",
    "winner",
    "ticks",
    "stopReason",
    "hybridCombat",
    "hybridEvaluation",
  ],
  terminalAuthority:
    "actual per-run result winner plus original hybrid-episode-close; never tactical outcome.terminal",
});

export function readLedger(file) {
  return parseLedger(fs.readFileSync(file));
}

export function parseLedger(ledgerBytes) {
  assert.ok(
    Buffer.isBuffer(ledgerBytes),
    "Original full-file bytes required; caller hashes are not evidence",
  );
  const lines = ledgerBytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const [header, ...records] = lines;
  assert.ok(header?.metadata, "Missing authoritative full-file ledger header");
  return { ...header.metadata, records, ledgerBytes };
}

export function terminalReturns(records, { gammaTick, terminalTick, terminalWin }) {
  assert.ok(
    Number.isFinite(gammaTick) && gammaTick >= 0 && gammaTick <= 1,
    "Explicit finite gammaTick in [0,1] required",
  );
  assert.ok(integer(terminalTick) && typeof terminalWin === "boolean", "Unknown native terminal");
  return records.map((record) => {
    assert.ok(
      integer(record.actionTick) &&
        integer(record.outcomeTick) &&
        record.actionTick <= record.outcomeTick &&
        record.outcomeTick <= terminalTick &&
        record.truncated === false &&
        record.envError !== true &&
        record.error == null,
      "Invalid terminal-return timing/flags",
    );
    const elapsedTicks = terminalTick - record.actionTick;
    const value = (terminalWin ? 1 : -1) * gammaTick ** elapsedTicks;
    assert.ok(Number.isFinite(value) && value >= -1 && value <= 1, "Unbounded terminal return");
    return { decisionStep: record.decisionStep, elapsedTicks, return: value };
  });
}

export function campaignIdentity({ runID, episodeId, actorSmallID, targetSmallID, action }) {
  assert.ok(
    text(runID) &&
      [episodeId, actorSmallID].every(integer) &&
      ["wait", "attack"].includes(action) &&
      (action === "wait" ? targetSmallID === null : integer(targetSmallID)),
    "Invalid semantic campaign identity",
  );
  return canonical([runID, episodeId, actorSmallID, targetSmallID, action]);
}

function validateDataset(dataset, selection) {
  const declared = { ...dataset };
  delete declared.ledgerBytes;
  const actual = parseLedger(dataset.ledgerBytes);
  delete actual.ledgerBytes;
  exact(declared, actual, "Dataset differs from bound original full-file bytes");
  assert.equal(dataset?.version, "ofh-hybrid-ledger-v1", "Invalid authoritative ledger");
  assert.equal(dataset.eventScope, "policy-events-only", "Missing full-file policy-event scope");
  assert.ok(
    Array.isArray(dataset.records) &&
      Array.isArray(dataset.manifests) &&
      dataset.recordCount === dataset.records.length,
    "Missing/dropped full-file records",
  );
  const manifest = selection?.manifest;
  validateManifest(manifest);
  assert.equal(
    dataset.manifests.filter((entry) => canonical(entry) === canonical(manifest)).length,
    1,
    "Selected manifest absent/duplicated",
  );
  assert.equal(
    new Set(dataset.manifests.map((entry) => entry.runID)).size,
    dataset.manifests.length,
    "Duplicate run manifests",
  );
  assert.ok(
    integer(selection.episodeId) && integer(selection.generation) && text(selection.modelIdentity),
    "Missing original group identity",
  );
  const snapshot = JSON.parse(selection.modelIdentity);
  validateSnapshotHashes(snapshot, manifest);
  const coverage = dataset.coverage?.filter((entry) => entry.runID === manifest.runID);
  assert.ok(
    coverage?.length === 1 &&
      coverage[0].available === true &&
      coverage[0].fullDataset === true &&
      coverage[0].dropped === 0 &&
      coverage[0].frozenVerified === true,
    "Incomplete fullDataset/freeze coverage",
  );
  return { manifest, snapshot };
}

function validateManifest(manifest) {
  for (const key of ["runID", "seed", "experimentID"])
    assert.ok(text(manifest?.[key]), `Missing manifest ${key}`);
  assert.match(manifest.engineRevision ?? "", /^[a-f0-9]{40}$/, "Missing engine revision");
  for (const key of [
    "engineDiffHash",
    "sourceHash",
    "harnessHash",
    "bundleHash",
    "configurationHash",
    "featureHash",
    "normalizerHash",
    "modelHash",
  ])
    assert.ok(hex(manifest[key]), `Invalid frozen manifest ${key}`);
  assert.ok(
    manifest.learning === false && ["shadow", "learned"].includes(manifest.mode),
    "Unfrozen selected manifest",
  );
  assert.equal(
    manifest.runID,
    hash(canonical([manifest.experimentID, manifest.seed, manifest.mode])),
    "Actual launch runID mismatch",
  );
}

function validateSnapshotHashes(snapshot, manifest) {
  assert.equal(hash(canonical(snapshot)), manifest.modelHash, "Original model hash mismatch");
  assert.equal(
    hash(
      canonical({
        schema: snapshot.schema,
        features: snapshot.features,
        actions: snapshot.actions,
      }),
    ),
    manifest.featureHash,
    "Frozen feature hash mismatch",
  );
  assert.equal(
    hash(canonical(snapshot.normalizer)),
    manifest.normalizerHash,
    "Frozen normalizer hash mismatch",
  );
}

function bindNativeCompletion(nativeRun, manifest, result) {
  assert.equal(nativeRun.interrupted, false, "Native process interruption unverified");
  assert.equal(nativeRun.provenanceMatches, true, "Native provenance unverified");
  assert.ok(
    nativeRun.start?.phase === "start" && String(nativeRun.start.seed) === manifest.seed,
    "Missing native process start identity",
  );
  exact(
    nativeRun.start.engineFingerprint,
    { revision: manifest.engineRevision, diffHash: manifest.engineDiffHash },
    "Native start engine fingerprint mismatch",
  );
  if (manifest.mapFingerprint != null)
    assert.equal(
      nativeRun.start.mapFingerprint,
      manifest.mapFingerprint,
      "Native map fingerprint mismatch",
    );
  assert.notEqual(result?.intentBudgetViolated, true, "Native intent budget violated");
  assert.ok(
    nativeRun.code === 0 ||
      (nativeRun.code === 2 &&
        nativeWinner(result ?? {}) &&
        result.won === false &&
        result.intentBudgetViolated === false),
    "Native process completion failed or unverified",
  );
}

function bindNativeModel(nativeRun, manifest, snapshot) {
  exact(nativeRun?.launch, manifest, "Actual result launch manifest mismatch");
  assert.equal(nativeRun.frozenVerified, true, "Native result freeze unverified");
  const result = nativeRun.result;
  bindNativeCompletion(nativeRun, manifest, result);
  assert.ok(!nativeRun.error && !nativeRun.signal && !nativeRun.timedOut, "Failed native run");
  assert.ok(
    result?.phase === "result" && String(result.seed) === manifest.seed && integer(result.ticks),
    "Missing full native result/seed/tick",
  );
  assert.equal(result.hybridCombat?.learning, false, "Native model learning was enabled");
  assert.equal(result.hybridCombat?.mode, manifest.mode, "Native policy mode mismatch");
  assert.equal(
    result.hybridCombat?.diagnostics?.learning,
    false,
    "Native diagnostic learning mismatch",
  );
  assert.equal(
    result.hybridCombat?.diagnostics?.mode,
    manifest.mode,
    "Native diagnostic mode mismatch",
  );
  exact(
    result.hybridCombat?.model,
    snapshot,
    "Actual final native model differs from original frozen model",
  );
  return result;
}

function selectGroup(dataset, manifest, selection) {
  const selected = [];
  const excluded = [];
  for (const row of dataset.records) {
    assert.equal(
      dataset.manifests.filter((entry) => canonical(entry) === canonical(row.manifest)).length,
      1,
      "Orphan/unattested record manifest",
    );
    assert.ok(text(row.event?.kind), "Invalid ledger event");
    if (
      canonical(row.manifest) !== canonical(manifest) ||
      row.event.episodeId !== selection.episodeId
    ) {
      excluded.push({
        runID: row.manifest.runID,
        episodeId: row.event.episodeId,
        reason: "outside-selected-group",
      });
      continue;
    }
    assert.equal(row.event.generation, selection.generation, "Mixed selected episode generation");
    assert.equal(row.event.runIdentity, manifest.runID, "Actual event run identity mismatch");
    selected.push(row.event);
  }
  assert.ok(selected.length, "Empty selected trajectory");
  return { selected, excluded };
}

function nativeWinner(result) {
  return result.stopReason === "winner" && result.winner != null && typeof result.won === "boolean";
}

function bindNativeClosure(result, dataset, manifest, selection) {
  const nativeLedger = result.hybridEvaluation?.ledger;
  assert.ok(
    nativeLedger?.fullDataset === true &&
      nativeLedger.dropped === 0 &&
      Array.isArray(nativeLedger.entries),
    "Full native result ledger unavailable; incremental file needs independently verified binding",
  );
  assert.ok(
    nativeLedger.entries.every((event) => event.runIdentity === manifest.runID),
    "Native full-result runID mismatch",
  );
  const closure = nativeLedger.entries.at(-1);
  exact(closure, result.hybridEvaluation.latestClosure, "Native latest closure mismatch");
  assert.ok(
    closure?.kind === "hybrid-episode-close" &&
      closure.episodeId === selection.episodeId &&
      closure.generation === selection.generation &&
      closure.tick === result.ticks &&
      closure.reason === result.stopReason,
    "Missing/mismatched native final closure scope",
  );
  const terminal = nativeWinner(result);
  assert.equal(
    closure.terminated,
    terminal ||
      (result.stopReason === "bot_dead" && result.alive === false && result.won === false),
    "Native closure terminal flags mismatch",
  );
  assert.equal(
    closure.truncated,
    !closure.terminated && result.stopReason !== "env_error",
    "Native closure truncation mismatch",
  );
  assert.equal(
    closure.envError,
    result.stopReason === "env_error",
    "Native closure error mismatch",
  );
  exact(
    dataset.records
      .filter((row) => canonical(row.manifest) === canonical(manifest))
      .map((row) => row.event),
    nativeLedger.entries.filter(
      (event) => event.kind === "outcome" || event.kind.startsWith("hybrid-combat-"),
    ),
    "Exported ledger differs from actual full native result ledger",
  );
  return terminal;
}

function validateSequence(selected, selection) {
  // Policy sequence is the export authority; sorting would hide dropped/reordered rows.
  for (let index = 0; index < selected.length; index++) {
    assert.equal(selected[index].sequence, index, "Missing/reordered/duplicate policy sequence");
    assert.ok(PRODUCER_CONTRACT.kinds.includes(kind(selected[index])), "Unknown policy event kind");
    if (selected[index].modelIdentity != null)
      assert.equal(
        selected[index].modelIdentity,
        selection.modelIdentity,
        "Mixed original model identity",
      );
  }
}

function validateBehavior(proposal, decision, requireStochastic) {
  for (const event of [proposal, decision]) {
    assert.equal(
      event.behaviorProbability,
      null,
      "Deterministic regression must declare null probabilities",
    );
    assert.equal(event.logProbability, null, "Deterministic regression must declare null logp");
    assert.equal(
      event.behaviorPolicy,
      "deterministic-wait-act-ranked-target",
      "Unknown behavior policy",
    );
  }
  assert.equal(requireStochastic, false, "Deterministic regression cannot train policy gradients");
}

function validateCandidates(proposal, decision) {
  assert.ok(Array.isArray(proposal.candidates), "Missing exact candidate set/mask");
  const candidateCoverage = proposal.candidateCoverage;
  assert.ok(
    candidateCoverage?.complete === true &&
      candidateCoverage.truncated === false &&
      candidateCoverage.count === proposal.candidates.length &&
      candidateCoverage.scope === "feature-valid-native-eligible-targets",
    "Incomplete candidate set coverage",
  );
  exact(
    decision.candidates,
    proposal.candidates,
    "Control candidate set/mask differs from proposal",
  );
  const ids = new Set();
  for (const candidate of proposal.candidates) {
    assert.ok(
      integer(candidate.targetSmallID) &&
        !ids.has(candidate.targetSmallID) &&
        candidate.legal === true &&
        candidate.sourceTick === proposal.tick &&
        candidate.legalitySource === "existing-canAttackPlayerNow-filter",
      "Invalid exact candidate mask/tick",
    );
    ids.add(candidate.targetSmallID);
  }
}

function controlledProposal(decision, proposals, selection, requireStochastic) {
  assert.ok(["wait", "attack"].includes(decision.controlledAction), "Unknown controlled action");
  assert.equal(
    decision.modelIdentity,
    selection.modelIdentity,
    "Decision missing original frozen identity",
  );
  assert.ok(
    integer(decision.tick) && integer(decision.actorSmallID),
    "Missing decision scope/tick/actor",
  );
  const matchingProposals = proposals.filter((event) => event.step === decision.step);
  assert.equal(matchingProposals.length, 1, "Missing/duplicate authoritative proposal");
  const proposal = matchingProposals[0];
  assert.equal(
    decision.decisionSequence,
    proposal.sequence,
    "Decision proposal reference mismatch",
  );
  assert.equal(proposal.decisionSequence, proposal.sequence, "Proposal reference mismatch");
  assert.equal(proposal.decisionReferenceKind, "proposal", "Unknown decision reference scope");
  assert.ok(
    proposal.sequence < decision.sequence &&
      proposal.tick === decision.tick &&
      proposal.actorSmallID === decision.actorSmallID,
    "Proposal/control timing scope mismatch",
  );
  assert.equal(
    proposal.modelIdentity,
    selection.modelIdentity,
    "Proposal missing original frozen identity",
  );
  assert.equal(proposal.action, decision.controlledAction, "Chosen/controlled action mismatch");
  exact(proposal.gate, decision.gate, "Proposal/control feature mismatch");
  validateBehavior(proposal, decision, requireStochastic);
  validateCandidates(proposal, decision);
  return proposal;
}

function actionReferences(selected, proposal, selection, consumed) {
  const step = proposal.step;
  const linked = selected.filter(
    (event) =>
      ["accepted", "receipt", "outcome"].includes(kind(event)) && event.decisionStep === step,
  );
  for (const event of linked) {
    assert.equal(event.decisionSequence, proposal.sequence, "Conflicting decision reference");
    assert.ok(event.sequence > proposal.sequence, "Reference precedes proposal");
    assert.equal(
      event.modelIdentity,
      selection.modelIdentity,
      "Linked original model identity missing/mixed",
    );
    consumed.add(event);
  }
  const outcomes = linked.filter((event) => kind(event) === "outcome");
  const accepted = linked.filter((event) => kind(event) === "accepted");
  const receipts = linked.filter((event) => kind(event) === "receipt");
  assert.ok(
    outcomes.length <= 1 && accepted.length <= 1 && receipts.length <= 1,
    "Duplicate/conflicting references",
  );
  return { outcomes, accepted, receipts };
}

function validatePending(outcome, decision, result, cancelled) {
  assert.ok(outcome.sequence > decision.sequence, "Pending outcome precedes controlled decision");
  assert.equal(outcome.action, decision.controlledAction, "Chosen/executed action mismatch");
  assert.equal(
    outcome.controlledAction,
    decision.controlledAction,
    "Outcome control identity mismatch",
  );
  assert.equal(outcome.actionTick, decision.tick, "WAIT/action pending record mismatch");
  assert.equal(outcome.actorSmallID, decision.actorSmallID, "Pending actor mismatch");
  assert.equal(
    outcome.targetSmallID,
    decision.controlledAction === "wait" ? null : decision.targetSmallID,
    "Pending target mismatch",
  );
  exact(outcome.gate, decision.gate, "Pending decision raw features mismatch");
  assert.equal(outcome.learned, true, "Pending outcome was not controlled");
  assert.equal(typeof outcome.confirmed, "boolean", "Unknown native confirmation status");
  assert.equal(outcome.behaviorProbability, null, "Outcome probabilities must remain null");
  assert.equal(outcome.logProbability, null, "Outcome log probability must remain null");
  assert.equal(outcome.truncated, cancelled, "Truncated outcome cannot train");
  assert.ok(outcome.envError !== true, "Error outcome cannot train");
  assert.ok(
    outcome.error == null && typeof outcome.terminal === "boolean",
    "Unknown/error outcome flags",
  );
  assert.ok(
    integer(outcome.outcomeTick) &&
      outcome.outcomeTick >= outcome.actionTick &&
      outcome.outcomeTick <= result.ticks,
    "Invalid ordered outcome timing",
  );
}

function validateWait(outcome, accepted, receipts) {
  assert.ok(
    accepted.length === 0 &&
      receipts.length === 0 &&
      outcome.confirmed === true &&
      outcome.receiptID === null &&
      outcome.acceptedSequence === null,
    "WAIT must match an actual controlled pending record",
  );
}

function validateAcceptance(outcome, decision, proposal, accepted) {
  assert.ok(
    decision.candidates.some(
      (candidate) => candidate.targetSmallID === decision.targetSmallID && candidate.legal,
    ),
    "Selected attack absent from exact legal mask",
  );
  assert.equal(accepted.controlledAction, "attack", "Acceptance was not controlled");
  assert.equal(accepted.acceptedSequence, accepted.sequence, "Acceptance self reference mismatch");
  assert.equal(
    outcome.acceptedSequence,
    accepted.sequence,
    "Outcome acceptance reference mismatch",
  );
  assert.ok(
    accepted.sequence < outcome.sequence &&
      accepted.tick === decision.tick &&
      accepted.targetSmallID === outcome.targetSmallID,
    "Invalid accepted action reference",
  );
  assert.equal(accepted.actorSmallID, decision.actorSmallID, "Acceptance actor mismatch");
  const candidate = proposal.candidates.find(
    (entry) => entry.targetSmallID === outcome.targetSmallID,
  );
  exact(
    outcome.features,
    candidate.features,
    "Executed target raw features differ from scored candidate",
  );
  exact(
    outcome.geometry,
    candidate.geometry,
    "Executed target geometry differs from scored candidate",
  );
  exact(outcome.gate, accepted.gate, "Accepted/pending gate mismatch");
  exact(outcome.features, accepted.features, "Accepted/pending target features mismatch");
  exact(outcome.geometry, accepted.geometry, "Accepted/pending target geometry mismatch");
}

function validateReceipt(outcome, decision, accepted, receipt, seenReceipts) {
  assert.equal(
    receipt.acceptedSequence,
    accepted.sequence,
    "Receipt acceptance reference mismatch",
  );
  assert.equal(receipt.actorSmallID, decision.actorSmallID, "Receipt actor mismatch");
  assert.ok(
    receipt.sequence > accepted.sequence &&
      receipt.sequence < outcome.sequence &&
      text(outcome.receiptID) &&
      receipt.receiptID === outcome.receiptID &&
      receipt.targetSmallID === outcome.targetSmallID &&
      receipt.tick >= decision.tick &&
      receipt.tick <= outcome.outcomeTick,
    "Invalid ordered native receipt reference",
  );
  assert.ok(!seenReceipts.has(outcome.receiptID), "Duplicate native receipt across decisions");
  seenReceipts.add(outcome.receiptID);
}

function excludeAmbiguousDispatch(decision, proposal, linked, state) {
  assert.ok(
    decision.controlledAction === "attack" &&
      decision.reason === "controlled-attack" &&
      decision.fallback === false &&
      linked.accepted.length === 0 &&
      linked.receipts.length === 0,
    "Controlled decision missing pending outcome: no omission proof",
  );
  assert.ok(
    proposal.candidates.some((candidate) => candidate.targetSmallID === decision.targetSmallID),
    "Censored selected target absent from legal mask",
  );
  const attempts = state.selected.filter(
    (event) => kind(event) === "dispatch-attempt" && event.decisionStep === decision.step,
  );
  assert.equal(attempts.length, 1, "Missing/duplicate censored dispatch");
  const attempt = attempts[0];
  assert.ok(
    attempt.dispatchID === attempt.sequence &&
      integer(attempt.dispatchID) &&
      attempt.decisionSequence === proposal.sequence &&
      attempt.tick === decision.tick &&
      attempt.targetSmallID === decision.targetSmallID,
    "Censored dispatch reference mismatch",
  );
  const omissions = state.selected.filter(
    (event) =>
      kind(event) === "observation-omitted" &&
      event.sequence > attempt.sequence &&
      event.sequence < decision.sequence,
  );
  assert.equal(omissions.length, 1, "Missing/duplicate interval omission proof");
  const omission = omissions[0];
  assert.ok(
    omission.reason === "ambiguous-commitment" &&
      omission.targetSmallID === decision.targetSmallID &&
      (omission.tick === undefined || omission.tick === decision.tick),
    "Censored observation omission mismatch",
  );
  validateDispatchSafety(attempt, decision, state);
  state.excluded.push({
    decisionStep: decision.step,
    reason: "censored-ambiguous-commitment",
    dispatchID: attempt.dispatchID,
    omissionSequence: omission.sequence,
  });
  return null;
}

function validateDispatchSafety(attempt, decision, state) {
  const entries = state.result.hybridEvaluation.ledger.entries;
  const rows = entries.filter(
    (event) =>
      event.kind === "hybrid-safety" &&
      event.episodeId === decision.episodeId &&
      event.generation === decision.generation &&
      event.attemptId === attempt.dispatchID,
  );
  assert.equal(rows.length, 1, "Missing/duplicate native dispatch safety proof");
  const safety = rows[0];
  assert.ok(
    safety.runIdentity === state.selection.manifest.runID &&
      safety.step === decision.step &&
      safety.tick === decision.tick &&
      safety.targetSmallID === decision.targetSmallID &&
      safety.emitted === true &&
      safety.reservePassed === true &&
      safety.legalityPassed === true &&
      Number.isFinite(safety.payloadTroops) &&
      safety.payloadTroops > 0 &&
      Number.isFinite(safety.spendableTroops) &&
      safety.payloadTroops <= safety.spendableTroops,
    "Native dispatch safety proof mismatch",
  );
  assert.ok(
    entries.findIndex(
      (event) =>
        event.kind === attempt.kind &&
        event.sequence === attempt.sequence &&
        event.episodeId === attempt.episodeId &&
        event.generation === attempt.generation,
    ) < entries.indexOf(safety) &&
      entries.indexOf(safety) <
        entries.findIndex(
          (event) =>
            event.kind === decision.kind &&
            event.sequence === decision.sequence &&
            event.episodeId === decision.episodeId &&
            event.generation === decision.generation,
        ),
    "Native safety interval mismatch",
  );
}

function winnerCancellation(outcome, state) {
  const closure = state.result.hybridEvaluation.latestClosure;
  return (
    outcome === state.selected.at(-1) &&
    outcome.reward === null &&
    outcome.reason === "winner" &&
    outcome.terminal === false &&
    outcome.truncated === true &&
    outcome.envError === false &&
    outcome.outcomeTick === closure.tick &&
    closure.reason === "winner" &&
    closure.terminated === true &&
    closure.truncated === false &&
    closure.envError === false
  );
}

function controlledRecord(decision, state) {
  const {
    selected,
    proposals,
    selection,
    result,
    consumed,
    excluded,
    seenReceipts,
    requireStochastic,
  } = state;
  if (decision.controlledAction === null) {
    validateDeclined(decision, state);
    excluded.push({ decisionStep: decision.step, reason: `declined:${decision.reason}` });
    return null;
  }
  const proposal = controlledProposal(decision, proposals, selection, requireStochastic);
  const linked = actionReferences(selected, proposal, selection, consumed);
  const { outcomes, accepted, receipts } = linked;
  if (outcomes.length === 0) return excludeAmbiguousDispatch(decision, proposal, linked, state);
  assert.equal(outcomes.length, 1, "Controlled decision missing pending outcome");
  const outcome = outcomes[0];
  const cancelled = winnerCancellation(outcome, state);
  validatePending(outcome, decision, result, cancelled);
  if (decision.controlledAction === "wait") validateWait(outcome, accepted, receipts);
  else {
    assert.equal(accepted.length, 1, "Missing attack acceptance");
    validateAcceptance(outcome, decision, proposal, accepted[0]);
    if (outcome.confirmed !== true) {
      assert.equal(receipts.length, 0, "Unconfirmed action has receipt");
      assert.equal(outcome.receiptID, null, "Unconfirmed action claims native receipt");
      excluded.push({
        decisionStep: decision.step,
        reason: cancelled ? "censored-winner-pending" : "unconfirmed-attack",
      });
      return null;
    }
    assert.equal(receipts.length, 1, "Missing native attack receipt");
    validateReceipt(outcome, decision, accepted[0], receipts[0], seenReceipts);
  }
  if (cancelled) {
    excluded.push({ decisionStep: decision.step, reason: "censored-winner-pending" });
    return null;
  }
  const manifest = selection.manifest;
  return {
    ...outcome,
    runID: manifest.runID,
    configHash: manifest.configurationHash,
    engineRevision: manifest.engineRevision,
    experimentID: manifest.experimentID,
  };
}

function validateUncontrolledScope(event, actorSmallID) {
  assert.ok(
    event.learned === false &&
      event.controlledAction === null &&
      event.decisionStep === null &&
      event.decisionSequence === null &&
      event.actorSmallID === actorSmallID &&
      event.behaviorPolicy === "legendary-unknown" &&
      event.behaviorProbability === null &&
      event.logProbability === null,
    "Orphan action/receipt/outcome reference: uncontrolled scope unproven",
  );
  if (kind(event) !== "outcome")
    assert.ok(
      integer(event.tick) && integer(event.targetSmallID),
      "Invalid uncontrolled event tick/target",
    );
}

function validateUncontrolledOutcome(outcome, result, cancelled) {
  assert.ok(
    ["wait", "attack"].includes(outcome.action) &&
      integer(outcome.actionTick) &&
      integer(outcome.outcomeTick) &&
      outcome.actionTick <= outcome.outcomeTick &&
      outcome.outcomeTick <= result.ticks &&
      typeof outcome.confirmed === "boolean" &&
      typeof outcome.terminal === "boolean" &&
      outcome.truncated === cancelled &&
      outcome.envError !== true &&
      outcome.error == null &&
      (Number.isFinite(outcome.reward) ||
        cancelled ||
        (outcome.reward === null && outcome.action === "attack" && outcome.confirmed === false)),
    "Invalid uncontrolled outcome timing/flags",
  );
}

function uncontrolledExclusionReason(event, state) {
  if (winnerCancellation(event, state)) return "uncontrolled-censored-winner-pending";
  if (kind(event) === "outcome" && event.reward === null) return "uncontrolled-unconfirmed-attack";
  return "uncontrolled-policy-event";
}

function excludeUncontrolledEvents(state, actorSmallID) {
  const { selected, consumed, seenReceipts, result, excluded } = state;
  const events = selected.filter(
    (event) => ["accepted", "receipt", "outcome"].includes(kind(event)) && !consumed.has(event),
  );
  for (const event of events) validateUncontrolledScope(event, actorSmallID);
  for (const outcome of events.filter((event) => kind(event) === "outcome")) {
    validateUncontrolledOutcome(outcome, result, winnerCancellation(outcome, state));
    if (outcome.action === "wait") {
      assert.equal(outcome.targetSmallID, null, "Invalid uncontrolled WAIT target");
      validateWait(outcome, [], []);
    } else {
      assert.ok(integer(outcome.targetSmallID), "Invalid uncontrolled attack target");
      const accepted = events.filter(
        (event) => kind(event) === "accepted" && event.sequence === outcome.acceptedSequence,
      );
      assert.equal(accepted.length, 1, "Missing uncontrolled attack acceptance");
      const acceptance = accepted[0];
      assert.ok(
        !consumed.has(acceptance) &&
          acceptance.acceptedSequence === acceptance.sequence &&
          acceptance.sequence < outcome.sequence &&
          acceptance.tick === outcome.actionTick &&
          acceptance.targetSmallID === outcome.targetSmallID,
        "Invalid uncontrolled acceptance reference",
      );
      for (const field of ["gate", "features", "geometry"])
        exact(outcome[field], acceptance[field], "Uncontrolled accepted/pending features mismatch");
      const receipts = events.filter(
        (event) => kind(event) === "receipt" && event.acceptedSequence === acceptance.sequence,
      );
      if (outcome.confirmed) {
        assert.equal(receipts.length, 1, "Missing uncontrolled native receipt");
        validateReceipt(
          outcome,
          { actorSmallID, tick: outcome.actionTick },
          acceptance,
          receipts[0],
          seenReceipts,
        );
        consumed.add(receipts[0]);
      } else {
        assert.equal(receipts.length, 0, "Unconfirmed uncontrolled action has receipt");
        assert.equal(outcome.receiptID, null, "Unconfirmed uncontrolled receipt claimed");
      }
      consumed.add(acceptance);
    }
    consumed.add(outcome);
  }
  assert.ok(
    events.every((event) => consumed.has(event)),
    "Orphan uncontrolled acceptance/receipt",
  );
  for (const event of events)
    excluded.push({
      eventSequence: event.sequence,
      eventKind: event.kind,
      actorSmallID: event.actorSmallID,
      targetSmallID: event.targetSmallID,
      acceptedSequence: event.acceptedSequence,
      receiptID: event.receiptID ?? null,
      reason: uncontrolledExclusionReason(event, state),
    });
}

function validateDeclined(decision, { selected, proposals }) {
  assert.ok(text(decision.reason), "Declined decision reason missing");
  assert.equal(decision.fallback, true, "Declined decision is not an authoritative fallback");
  const matchingProposals = proposals.filter((proposal) => proposal.step === decision.step);
  assert.ok(matchingProposals.length <= 1, "Duplicate declined proposal");
  if (matchingProposals.length) {
    const proposal = matchingProposals[0];
    assert.equal(
      decision.decisionSequence,
      proposal.sequence,
      "Declined proposal reference mismatch",
    );
    assert.equal(
      proposal.decisionSequence,
      proposal.sequence,
      "Declined proposal self reference mismatch",
    );
    assert.ok(
      proposal.sequence < decision.sequence && proposal.tick === decision.tick,
      "Declined proposal/control order mismatch",
    );
  }
  assert.ok(
    !selected.some(
      (event) =>
        ["accepted", "receipt", "outcome"].includes(kind(event)) &&
        event.decisionStep === decision.step,
    ),
    "Declined decision has unexplained action references",
  );
}

function validateProposalCoverage(selected, decisions, proposals) {
  assert.ok(
    proposals.every((proposal) => decisions.some((decision) => decision.step === proposal.step)),
    "Orphan proposal without final decision",
  );
  for (const attempt of selected.filter((event) => kind(event) === "dispatch-attempt")) {
    const proposal = proposals.find((event) => event.sequence === attempt.decisionSequence);
    const decision = decisions.find((event) => event.step === attempt.decisionStep);
    assert.ok(
      proposal &&
        decision &&
        proposal.step === decision.step &&
        attempt.sequence > proposal.sequence &&
        attempt.sequence < decision.sequence,
      "Orphan/out-of-order dispatch attempt reference",
    );
  }
}

export function validateTrajectory(
  dataset,
  selection,
  nativeRun,
  { gammaTick, requireStochastic = false } = {},
) {
  const { manifest, snapshot } = validateDataset(dataset, selection);
  const result = bindNativeModel(nativeRun, manifest, snapshot);
  const { selected, excluded } = selectGroup(dataset, manifest, selection);
  const terminal = bindNativeClosure(result, dataset, manifest, selection);
  validateSequence(selected, selection);
  const decisions = selected.filter((event) => kind(event) === "decision");
  const proposals = selected.filter((event) => kind(event) === "proposal");
  assert.ok(decisions.length, "Missing authoritative decisions");
  validateProposalCoverage(selected, decisions, proposals);
  const state = {
    selected,
    proposals,
    selection,
    result,
    excluded,
    requireStochastic,
    consumed: new Set(),
    seenReceipts: new Set(),
  };
  const records = [];
  for (const [step, decision] of decisions.entries()) {
    assert.equal(decision.step, step, "Missing/reordered decision step");
    assert.equal(
      decision.modelIdentity,
      selection.modelIdentity,
      "Decision missing original frozen identity",
    );
    assert.ok(
      integer(decision.tick) && integer(decision.actorSmallID),
      "Missing decision actor/tick",
    );
    assert.ok(step === 0 || decision.tick >= decisions[step - 1].tick, "Reordered decision ticks");
    const record = controlledRecord(decision, state);
    if (record) records.push(record);
  }
  excludeUncontrolledEvents(state, decisions[0].actorSmallID);
  assert.ok(
    selected
      .filter((event) => ["accepted", "receipt", "outcome"].includes(kind(event)))
      .every((event) => state.consumed.has(event)),
    "Orphan action/receipt/outcome reference",
  );
  const reason = terminal
    ? "incomplete-controlled-sequential-coverage"
    : "nonterminal-cap-or-error";
  if (!terminal || records.length === 0)
    return {
      version: "ofh-hybrid-trajectory-v1",
      trainable: false,
      reason,
      records: [],
      excluded,
      manifest,
      snapshot,
      selection,
    };
  const actors = new Set(records.map((record) => record.actorSmallID));
  assert.equal(actors.size, 1, "Mixed actor trajectory");
  const context = {
    engineRevision: manifest.engineRevision,
    experimentID: manifest.experimentID,
    runID: manifest.runID,
    configHash: manifest.configurationHash,
    episodeId: selection.episodeId,
    generation: selection.generation,
    modelIdentity: selection.modelIdentity,
    gammaTick,
    terminalTick: result.ticks,
    terminalWin: result.won,
    resultHash: hash(canonical(result)),
    actorSmallID: records[0].actorSmallID,
    coverage: {
      version: "explicit-exclusions-complete-ledger-v1",
      ledgerHash: hash(dataset.ledgerBytes),
      decisionCount: decisions.length,
      excluded: excluded.filter((entry) => integer(entry.decisionStep)),
    },
    ...(snapshot.featureProfile ? { featureProfile: snapshot.featureProfile } : {}),
  };
  return {
    version: "ofh-hybrid-trajectory-v1",
    trainable: true,
    manifest,
    selection,
    snapshot,
    records,
    excluded,
    context,
    returns: terminalReturns(records, context),
    probabilityContract: "deterministic-regression-null-v1",
    objective: "monte-carlo-ranking-evaluation-not-ppo",
    performanceClaim: false,
  };
}
