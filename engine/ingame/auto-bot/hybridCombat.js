// DIVERGENCE: optional learned land-combat ranking; Legendary remains the fallback.
// Ideas: OpenFrontMind's separate wait/act gate and entity targets, AggroBot's
// committed-war coordination, and paired frozen-policy evaluation from RL projects.
"use strict";

const HYBRID_COMBAT_SCHEMA = "ofh-combat-ridge-v1";
const HYBRID_COMBAT_STORAGE = "openfront-helper-hybrid-combat-v1";
const HYBRID_COMBAT_REASONS = Object.freeze([
  "gate-features-unavailable", "no-native-eligible-target", "target-features-unavailable",
  "geometry-unavailable", "geometry-stale", "frontier-invalid", "numerical-failure", "model-not-ready", "shadow-only",
  "commitment-veto", "send-rejected-unknown", "native-legality-rejected", "should-attack-rejected",
  "target-authorization-rejected", "pending-duplicate", "cancelled-generation", "stale-geometry-tick",
  "forced-action", "tribe-target", "non-strategic-target", "ambiguous-commitment",
  "observation-identity-invalid", "observation-pending", "observation-stale",
  "controlled-wait", "controlled-attack", "action-accepted", "native-receipt",
]);
const HYBRID_COMBAT_FEATURES = {
  gate: ["bias", "ownTroopRatio", "ownLandShare", "incomingTroopRatio"],
  target: ["bias", "ownTroopRatio", "ownLandShare", "incomingTroopRatio",
    "targetLandShare", "targetTroopRatio", "relativeArmy", "captureBudgetRatio", "committedRatio"],
};

function hybridCombatModel(dimension) {
  return { samples: 0, weights: Array(dimension).fill(0),
    // Unit ridge prior on bounded features; no hand-tuned tactical weights.
    inverse: Array.from({ length: dimension }, (_, row) =>
      Array.from({ length: dimension }, (_, column) => Number(row === column))) };
}

function validateHybridCombatModel(model, dimension) {
  if (!model || !Number.isSafeInteger(model.samples) || model.samples < 0 ||
      !Array.isArray(model.weights) || model.weights.length !== dimension ||
      !model.weights.every(Number.isFinite) || !Array.isArray(model.inverse) ||
      model.inverse.length !== dimension || model.inverse.some((row) =>
        !Array.isArray(row) || row.length !== dimension || !row.every(Number.isFinite))) {
    throw new Error("Invalid hybrid combat model");
  }
  // Features are bounded in [0, 1]; their absolute dot-product bound must be finite.
  if (!Number.isFinite(model.weights.reduce((sum, weight) => sum + Math.abs(weight), 0))) {
    throw new Error("Unsafe hybrid combat weights");
  }
  validateHybridCombatCovariance(model.inverse, dimension);
}

class HybridCombatCovarianceError extends Error {}

function validateHybridCombatCovariance(inverse, dimension) {
  // Imported covariance must be symmetric positive definite, not merely finite.
  if (inverse.some((row, i) => row.some((value, j) =>
    Math.abs(value - inverse[j][i]) > Number.EPSILON * dimension * Math.max(
      Math.abs(value), Math.abs(inverse[j][i]), Math.sqrt(Math.abs(inverse[i][i])) * Math.sqrt(Math.abs(inverse[j][j])))))) {
    throw new HybridCombatCovarianceError("Asymmetric hybrid combat covariance");
  }
  const lower = Array.from({ length: dimension }, () => Array(dimension).fill(0));
  for (let row = 0; row < dimension; row++) {
    for (let column = 0; column <= row; column++) {
      let value = inverse[row][column];
      for (let k = 0; k < column; k++) value -= lower[row][k] * lower[column][k];
      lower[row][column] = hybridCombatCholeskyEntry(value, row === column, lower[column][column]);
    }
  }
}

function hybridCombatCholeskyEntry(value, diagonal, divisor) {
  if (!Number.isFinite(value) || (diagonal && value <= 0)) throw new HybridCombatCovarianceError("Invalid hybrid combat covariance");
  const result = diagonal ? Math.sqrt(value) : value / divisor;
  if (!Number.isFinite(result)) throw new HybridCombatCovarianceError("Invalid hybrid combat covariance");
  return result;
}

class HybridCombatPolicy {
  constructor({ storage = window.localStorage, ledgerCapacity = 256 } = {}) {
    if (!Number.isSafeInteger(ledgerCapacity) || ledgerCapacity < 1) throw new Error("Invalid hybrid ledger capacity");
    this.storage = storage;
    this.mode = "shadow";
    this.learning = true;
    this.models = { wait: hybridCombatModel(4), act: hybridCombatModel(4), target: hybridCombatModel(9) };
    this.backend = "ridge-v1";
    this.compactContract = null;
    this.ledgerCapacity = ledgerCapacity;
    this.episodeId = 0;
    this.sequence = 0;
    this.ledger = [];
    this.dropped = 0;
    this.control = this.emptyControl();
    this.funnel = this.emptyFunnel();
    this.observations = { calls: 0, captured: 0, omitted: 0, reasons: {}, acceptanceOmissions: {} };
    this.step = 0;
    this.dispatch = null;
    this.pending = null;
    this.proposal = null;
    this.error = null;
    this.numericalError = null;
    this.decisions = 0;
    this.unconfirmed = 0;
    this.generation = 0;
    this.lastOutcome = null;
    // HYBRID_MODEL_LOAD_BOUNDARY_START
    // Untrusted saved model errors are exposed in diagnostics, not game faults.
    try {
      const raw = storage?.getItem(HYBRID_COMBAT_STORAGE);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.model?.schema !== HYBRID_COMBAT_SCHEMA) throw new Error("Invalid saved Ridge schema");
        this.importModel(saved.model);
        this.configure(saved.config);
      }
    // eslint-disable-next-line no-restricted-syntax -- only untrusted local model storage; error remains in diagnostics
    } catch (error) { this.error = String(error.message); }
    // HYBRID_MODEL_LOAD_BOUNDARY_END
  }

  configure(config) {
    if (!config || (config.mode !== undefined && !["baseline", "shadow", "learned"].includes(config.mode)) ||
        (config.learning !== undefined && typeof config.learning !== "boolean")) {
      throw new Error("Invalid hybrid combat configuration");
    }
    if (config.learning === true && this.offlineReward()) {
      throw new Error("Offline reward model cannot learn live land-delta labels");
    }
    if (config.mode !== undefined) this.mode = config.mode;
    if (config.learning !== undefined) this.learning = config.learning;
    // Switching mode never credits a previous policy's unfinished decision.
    this.pending = null;
    this.proposal = null;
    this.generation++;
    this.persist();
    return this.diagnostics();
  }

  exportModel() {
    if (this.backend === "compact-tanh-v1") {
      const snapshot = { ...this.compactContract, models: this.models };
      HybridCombatContract.validate(snapshot);
      return JSON.parse(JSON.stringify(snapshot));
    }
    return JSON.parse(JSON.stringify({ schema: HYBRID_COMBAT_SCHEMA,
      features: HYBRID_COMBAT_FEATURES, reward: "own-land-share-change-at-commitment-end",
      models: this.models }));
  }

  importModel(snapshot) {
    if (["ofh-combat-compact-tanh-v2", "ofh-combat-compact-tanh-v3"].includes(snapshot?.schema)) {
      if (typeof HybridCombatContract === "undefined") throw new Error("Compact neural helper is not loaded");
      HybridCombatContract.validate(snapshot);
      const candidate = JSON.parse(JSON.stringify(snapshot));
      HybridCombatContract.freezeMetadata(candidate);
      this.backend = "compact-tanh-v1";
      this.models = candidate.models;
      delete candidate.models;
      this.compactContract = Object.freeze(candidate);
      if (this.offlineReward(candidate.reward)) this.learning = false;
      this.numericalError = null;
      this.pending = null;
      this.proposal = null;
      this.generation++;
      this.persist();
      return;
    }
    if (!snapshot || snapshot.schema !== HYBRID_COMBAT_SCHEMA ||
        snapshot.reward !== "own-land-share-change-at-commitment-end" ||
        JSON.stringify(snapshot.features) !== JSON.stringify(HYBRID_COMBAT_FEATURES)) {
      throw new Error("Incompatible hybrid combat feature/action schema");
    }
    if (!snapshot.models || Object.keys(snapshot.models).sort().join(",") !== "act,target,wait") {
      throw new Error("Invalid hybrid combat model keys");
    }
    for (const [name, dimension] of [["wait", 4], ["act", 4], ["target", 9]]) {
      validateHybridCombatModel(snapshot.models?.[name], dimension);
    }
    this.models = JSON.parse(JSON.stringify(snapshot.models));
    this.backend = "ridge-v1";
    this.compactContract = null;
    this.numericalError = null;
    this.pending = null;
    this.proposal = null;
    this.generation++;
    this.persist();
  }

  persist() {
    if (!this.storage) return;
    // Serialization/model bugs are runtime faults, outside the storage boundary.
    const serialized = JSON.stringify({ config: { mode: this.mode, learning: this.learning }, model: this.exportModel() });
    // HYBRID_MODEL_SAVE_BOUNDARY_START
    // Storage denial/quota errors remain visible without disabling Legendary.
    try {
      this.storage.setItem(this.backend === "ridge-v1" ? HYBRID_COMBAT_STORAGE : "openfront-helper-hybrid-combat-v2", serialized);
      this.error = null;
    // eslint-disable-next-line no-restricted-syntax -- quota/denial affects optional persistence; error remains in diagnostics
    } catch (error) { this.error = String(error.message); }
    // HYBRID_MODEL_SAVE_BOUNDARY_END
  }

  predict(name, features) {
    if (this.backend === "compact-tanh-v1") {
      const model = this.models[name];
      if (!model) throw new Error("Invalid hybrid combat features");
      const values = HybridCombatContract.normalize(features, name, this.compactContract.normalizer);
      if (!values) return this.numericalFailure("Nonfinite hybrid combat normalization");
      const prediction = HybridCombatContract.forward(model, values);
      return prediction ? prediction.prediction : this.numericalFailure("Nonfinite hybrid combat prediction");
    }
    const model = this.models[name];
    if (!model || features.length !== model.weights.length || !features.every(Number.isFinite)) {
      throw new Error("Invalid hybrid combat features");
    }
    const prediction = features.reduce((value, feature, index) => value + feature * model.weights[index], 0);
    return Number.isFinite(prediction) ? prediction : this.numericalFailure("Nonfinite hybrid combat prediction");
  }

  learn(name, features, reward) {
    const prediction = this.predict(name, features);
    if (!Number.isFinite(reward) || Math.abs(reward) > 1) throw new Error("Invalid hybrid combat reward");
    if (!this.learning || this.mode === "baseline" || this.numericalError || prediction === null) return;
    if (this.offlineReward()) throw new Error("Offline reward model cannot learn live land-delta labels");
    const candidate = this.updateCandidate(name, features, reward, prediction);
    if (!candidate) return;
    this.models[name] = candidate;
    this.persist();
  }

  updateCandidate(name, features, reward, prediction = this.predict(name, features)) {
    if (this.backend === "compact-tanh-v1") {
      const values = HybridCombatContract.normalize(features, name, this.compactContract.normalizer);
      if (!values) { this.numericalFailure("Nonfinite hybrid combat normalization"); return null; }
      const candidate = HybridCombatContract.update(this.models[name], values, reward,
        this.compactContract.normalizer[name === "target" ? "target" : "gate"]);
      if (!candidate) this.numericalFailure("Nonfinite or nondecreasing hybrid neural update");
      return candidate;
    }
    const model = this.models[name];
    const projected = model.inverse.map((row) => row.reduce((value, entry, index) => value + entry * features[index], 0));
    const denominator = 1 + features.reduce((value, feature, index) => value + feature * projected[index], 0);
    if (!Number.isFinite(denominator) || denominator < 1) {
      this.numericalFailure("Invalid hybrid combat denominator");
      return;
    }
    const gain = projected.map((value) => value / denominator);
    const weights = model.weights.map((weight, index) => weight + gain[index] * (reward - prediction));
    const inverse = model.inverse.map((row, i) => row.map((value, j) => value - gain[i] * projected[j]));
    const samples = model.samples + 1;
    if (!Number.isFinite(weights.reduce((sum, weight) => sum + Math.abs(weight), 0)) ||
        !inverse.every((row) => row.every(Number.isFinite)) || !Number.isSafeInteger(samples)) {
      this.numericalFailure("Nonfinite hybrid combat update");
      return;
    }
    if (!this.acceptsCovariance(inverse)) return;
    return { samples, weights, inverse };
  }

  learnOutcome(pending, reward) {
    if (!this.learning || this.mode === "baseline" || this.numericalError) return;
    if (!Number.isFinite(reward) || Math.abs(reward) > 1) throw new Error("Invalid hybrid combat reward");
    if (this.offlineReward()) throw new Error("Offline reward model cannot learn live land-delta labels");
    const examples = pending.target ? [["act", pending.gate], ["target", pending.features]] : [["wait", pending.gate]];
    const candidates = examples.map(([name, features]) => [name, this.updateCandidate(name, features, reward)]);
    if (this.numericalError || candidates.some(([, candidate]) => !candidate)) return;
    // Both macro and micro heads publish together; no half-trained outcome.
    this.models = { ...this.models, ...Object.fromEntries(candidates) };
    this.persist();
  }

  acceptsCovariance(inverse) {
    // HYBRID_MODEL_UPDATE_BOUNDARY_START
    try {
      validateHybridCombatCovariance(inverse, inverse.length);
      return true;
    // eslint-disable-next-line no-restricted-syntax -- expected numerical rejection only; all other errors propagate
    } catch (error) {
      if (!(error instanceof HybridCombatCovarianceError)) throw error;
      this.numericalFailure(error.message);
      return false;
    }
    // HYBRID_MODEL_UPDATE_BOUNDARY_END
  }

  numericalFailure(message) {
    this.numericalError = message;
    return null;
  }

  enabled() {
    return this.mode !== "baseline" && state.settings.winFixes === true;
  }

  ready() {
    const coverage = Object.entries(this.models).every(([name, model]) => model.samples >=
      (this.backend === "ridge-v1" ? model.weights.length : HybridCombatContract.dimensionsFor(this.compactContract)[name]));
    if (this.backend === "ridge-v1") return coverage;
    return coverage && this.hasLearnedSignal("target") && (this.hasLearnedSignal("wait") || this.hasLearnedSignal("act"));
  }

  hasLearnedSignal(name) {
    const model = this.models[name];
    if (this.backend === "ridge-v1") return model.weights.some((weight) => weight !== 0);
    return model.outputBias !== 0 || model.output.some((weight) => weight !== 0);
  }

  beginSession() {
    this.resetEpisode();
  }

  emptyControl() {
    return { candidateDecisions: 0, controlledWaits: 0, acceptedLearnedAttacks: 0, confirmedLearnedAttacks: 0, fallbacks: 0 };
  }

  offlineReward(reward = this.compactContract?.reward) {
    return ["potential-shaped-land-delta-ticks-v2", "discounted-terminal-win-return-v1"].includes(reward);
  }

  emptyFunnel() {
    return { suppliedTargets: 0, nativeEligibleTargets: 0, featureValidTargets: 0, scoredTargets: 0,
      dispatchAttempts: 0, acceptedDispatches: 0, confirmedDispatches: 0, callerCancellations: 0, featureFailures: {} };
  }

  readiness() {
    return Object.fromEntries(Object.entries(this.models).map(([name, model]) => {
      const requiredSamples = this.backend === "ridge-v1" ? model.weights.length : HybridCombatContract.dimensionsFor(this.compactContract)[name];
      return [name, { samples: model.samples, requiredSamples,
        sampleDeficit: Math.max(0, requiredSamples - model.samples), signalPresent: this.hasLearnedSignal(name) }];
    }));
  }

  resetEpisode() {
    this.pending = null;
    this.proposal = null;
    this.decisions = 0;
    this.unconfirmed = 0;
    this.generation++;
    this.episodeId++;
    this.lastOutcome = null;
    this.dispatch = null;
    this.control = this.emptyControl();
    this.funnel = this.emptyFunnel();
    this.observations = { calls: 0, captured: 0, omitted: 0, reasons: {}, acceptanceOmissions: {} };
    this.ledger = [];
    this.dropped = 0;
    this.sequence = 0;
    this.step = 0;
    return this.diagnostics();
  }

  createCompactModel(options) {
    if (typeof HybridCombatContract === "undefined") throw new Error("Compact neural helper is not loaded");
    return HybridCombatContract.create(options);
  }

  recordLedger(kind, values) {
    if (values.reason != null && !HYBRID_COMBAT_REASONS.includes(values.reason)) throw new Error("Invalid hybrid funnel reason");
    const entry = JSON.parse(JSON.stringify({ kind, episodeId: this.episodeId, generation: this.generation,
      sequence: this.sequence++, ...values }));
    if (this.ledger.length === this.ledgerCapacity) { this.ledger.shift(); this.dropped++; }
    this.ledger.push(entry);
    if (typeof roundLogRecord === "function") roundLogRecord("bot_decision", { ...entry, kind: `hybrid-combat-${kind}` });
    return entry;
  }

  exportLedger() {
    return JSON.parse(JSON.stringify({ version: "raw-hybrid-ledger-v1", capacity: this.ledgerCapacity,
      dropped: this.dropped, complete: this.dropped === 0, coverage: "policy-events-only", fullDataset: false,
      episodeId: this.episodeId, entries: this.ledger }));
  }

  rawReplay() {
    const { entries, ...metadata } = this.exportLedger();
    return { ...metadata, version: "raw-hybrid-replay-v1", requiresHarnessProvenance: true,
      records: entries.filter((entry) => entry.kind === "outcome") };
  }

  replayFit(snapshot, records, context) {
    if (typeof HybridCombatContract === "undefined") throw new Error("Compact neural helper is not loaded");
    return HybridCombatContract.fitOffline(snapshot, records, context);
  }

  eligible() {
    // Readiness is sample coverage, never a promotion or performance claim.
    return this.enabled() && this.mode === "learned" && this.ready() && !this.numericalError;
  }

  fallback(reason) {
    if (this.mode === "learned" && this.enabled()) this.control.fallbacks++;
    if (this.proposal) this.recordDecision(null, true, reason);
    return false;
  }

  recordDecision(controlledAction, fallback = false, reason = null) {
    if (controlledAction !== null) this.control.candidateDecisions++;
    this.proposal = { ...this.proposal, controlledAction, fallback, reason };
    this.recordLedger("decision", this.proposal);
  }

  scoreMacro(gate) {
    return { wait: this.predict("wait", gate), act: this.predict("act", gate) };
  }

  scoreMicro(candidates) {
    return candidates.map((candidate) => ({ ...candidate, score: this.predict("target", candidate.features) }))
      .sort((a, b) => b.score - a.score || a.target.smallID() - b.target.smallID());
  }

  gateFeatures(behavior) {
    const player = behavior.player;
    const troops = Number(player.troops());
    const maximum = Number(behavior.game.config().maxTroops(player));
    const land = Number(behavior.game.numLandTiles());
    const incoming = Number(behavior.incomingHostileAttackPressure());
    if (this.backend === "compact-tanh-v1" &&
        (![troops, maximum, land, incoming, Number(player.numTilesOwned())].every(Number.isFinite) ||
         maximum <= 0 || land <= 0 || troops < 0 || incoming < 0 || Number(player.numTilesOwned()) < 0)) return null;
    const features = [1, troops / Math.max(1, maximum), Number(player.numTilesOwned()) / Math.max(1, land),
      Number.isFinite(incoming) ? Math.min(1, incoming) : 1];
    if (!features.every(Number.isFinite)) return null;
    return features.map((value) => Math.max(0, Math.min(1, value)));
  }

  targetFeatures(behavior, target, gate, capturedGeometry = undefined, { onUnavailable = () => {}, evidence = null } = {}) {
    const troops = Number(target.troops());
    const own = Number(behavior.player.troops());
    // Read the existing ledger without reconciling or pruning it in shadow mode.
    const pending = [...(behavior.botAttackPendingIntentCommitments || []),
      ...(behavior.botPendingDonationIntentCommitments || [])]
      .reduce((total, entry) => total + Math.max(0, Number(entry.troops) || 0), 0);
    const budget = Math.max(0, own - behavior.getEarlyGameLiveReserveTroops() - pending);
    const floor = Number(behavior.getPlayerAttackPreferredTroopFloor(target));
    const maximum = Number(behavior.game.config().maxTroops(target));
    const committed = this.commitmentTroops(behavior, target);
    const features = [...gate, Number(target.numTilesOwned()) / Math.max(1, Number(behavior.game.numLandTiles())),
      troops / Math.max(1, maximum), troops / Math.max(1, troops + own),
      floor / Math.max(1, budget), committed / Math.max(1, own)];
    if (!features.every(Number.isFinite)) { onUnavailable("target-features-unavailable"); return null; }
    const bounded = features.map((value) => Math.max(0, Math.min(1, value)));
    if (this.backend === "ridge-v1") return bounded;
    return this.compactTargetFeatures(behavior, target, bounded, {
      values: [troops, own, floor, maximum, committed], capturedGeometry, onUnavailable, evidence });
  }

  compactTargetFeatures(behavior, target, bounded, { values, capturedGeometry, onUnavailable, evidence }) {
    const [troops, , , maximum] = values;
    if (!values.every(Number.isFinite) || troops < 0 || maximum <= 0 ||
        !HybridCombatContract.exactID(target.smallID())) { onUnavailable("target-features-unavailable"); return null; }
    if (typeof behavior.hybridCombatGeometry !== "function") { onUnavailable("geometry-unavailable"); return null; }
    const raw = capturedGeometry === undefined ? behavior.hybridCombatGeometry(target) : capturedGeometry;
    const tick = behavior.currentAttackDecisionTick();
    const geometry = HybridCombatContract.geometry(raw, target.smallID(), tick);
    if (!geometry) { onUnavailable(raw && raw.tick !== tick ? "geometry-stale" : "geometry-unavailable"); return null; }
    if (evidence) evidence.geometry = geometry.raw;
    if (this.compactContract.featureProfile !== "frontier-v1") return [...bounded, ...geometry.features];
    const frontier = HybridCombatContract.frontierFeatures(raw.frontier, {
      actorSmallID: behavior.player.smallID?.(), targetSmallID: target.smallID(), tick, generation: this.generation });
    if (!frontier) { onUnavailable("frontier-invalid"); return null; }
    return [...bounded, ...geometry.features, ...frontier.features];
  }

  observe(behavior, terminal = false) {
    if (!this.enabled() || !this.pending) return;
    const pending = this.pending;
    const tick = behavior.currentAttackDecisionTick();
    const receipt = pending.target && this.landAttacks(behavior, pending.target).find((attack) =>
      attack.id != null && !pending.attackIds.includes(String(attack.id)));
    if (receipt && !pending.confirmed) {
      this.confirmReceipt(pending, receipt, tick);
    }
    if (!terminal && this.observationStillPending(behavior, pending, tick)) return;
    const gate = this.gateFeatures(behavior);
    if (!gate) { this.recordOutcome(pending, tick, null, null, terminal); this.pending = null; return; }
    if (pending.target && !pending.confirmed) {
      this.unconfirmed++;
      this.recordOutcome(pending, tick, null, gate, terminal);
      this.pending = null;
      return;
    }
    const reward = gate[2] - pending.share;
    this.learnOutcome(pending, reward);
    this.recordOutcome(pending, tick, reward, gate, terminal);
    this.pending = null;
  }

  confirmReceipt(pending, receipt, tick) {
    pending.confirmed = true;
    pending.receiptID = String(receipt.id);
    if (pending.learned === true) { this.control.confirmedLearnedAttacks++; this.funnel.confirmedDispatches++; }
    this.recordLedger("receipt", { targetSmallID: pending.targetSmallID, ...this.actionReferences(pending),
      tick, receiptID: pending.receiptID,
      modelIdentity: pending.modelIdentity ?? null, learned: pending.learned === true, reason: "native-receipt" });
  }

  recordOutcome(pending, tick, reward, nextGate = null, terminal = false) {
    this.lastOutcome = { action: pending.target ? "attack" : "wait", target: pending.target?.smallID() ?? null,
      actionTick: pending.tick, outcomeTick: tick, confirmed: pending.target ? pending.confirmed === true : true,
      targetSmallID: pending.targetSmallID ?? null, ...this.actionReferences(pending),
      episodeId: pending.episodeId ?? this.episodeId,
      generation: pending.generation ?? this.generation, receiptID: pending.receiptID ?? null,
      reward, gate: pending.gate, nextGate, ...this.outcomeFeatures(pending), terminal, truncated: false,
      learned: pending.learned === true };
    this.recordLedger("outcome", this.lastOutcome);
  }

  actionReferences(pending) {
    return { actorSmallID: pending.actorSmallID ?? null, decisionStep: pending.decisionStep ?? null,
      acceptedSequence: pending.acceptedSequence ?? null, decisionSequence: pending.decisionSequence ?? null,
      controlledAction: pending.controlledAction ?? null, behaviorProbability: null, logProbability: null,
      behaviorPolicy: pending.behaviorPolicy ?? "legendary-unknown" };
  }

  outcomeFeatures(pending) {
    return { features: pending.features ?? null, geometry: pending.geometry ?? null,
      featureVersion: this.compactContract?.schema ?? HYBRID_COMBAT_SCHEMA,
      normalizer: this.compactContract?.normalizer ?? null, modelIdentity: pending.modelIdentity ?? null };
  }

  observationStillPending(behavior, pending, tick) {
    if (tick <= pending.tick) return true;
    return Boolean(pending.target && pending.target.isAlive() &&
      this.commitmentTroops(behavior, pending.target) > 0);
  }

  landAttacks(behavior, target) {
    const key = String(target.smallID());
    return behavior.getOutboundAttackSnapshot().filter((entry) => String(entry.targetKey) === key);
  }

  commitments(behavior) {
    const entries = [...behavior.getOutboundAttackSnapshot(), ...(behavior.botAttackPendingIntentCommitments || [])];
    for (const transport of behavior.getOutboundTransportSnapshot()) {
      const target = behavior.outboundTransportTargets?.get(String(transport.id));
      if (target?.isPlayer?.() === true) entries.push({ target, targetKey: String(target.smallID()), troops: transport.troops });
    }
    return entries.filter((entry) => entry.target?.isPlayer?.() && entry.target.isAlive() && entry.troops > 0);
  }

  commitmentTroops(behavior, target) {
    const key = String(target.smallID());
    return this.commitments(behavior).filter((entry) => String(entry.targetKey) === key)
      .reduce((total, entry) => total + entry.troops, 0);
  }

  omitObservation(reason, values = {}) {
    this.observations.omitted++;
    this.observations.reasons[reason] = (this.observations.reasons[reason] || 0) + 1;
    this.recordLedger("observation-omitted", { ...values, reason });
    return null;
  }

  actionObservation(behavior, target, { force = false } = {}) {
    if (!this.enabled()) return null;
    this.observations.calls++;
    if (force) return this.omitObservation("forced-action");
    if (!this.isStrategicTarget(behavior, target)) return this.omitObservation(
      target?.type?.() === PlayerType.Bot ? "tribe-target" : "non-strategic-target");
    // Existing land/boat commitments make a new intent's receipt ambiguous.
    if (this.commitmentTroops(behavior, target) > 0) return this.omitObservation("ambiguous-commitment", { targetSmallID: target.smallID() });
    return this.captureActionObservation(behavior, target);
  }

  captureActionObservation(behavior, target) {
    const gate = this.gateFeatures(behavior);
    const geometry = this.captureGeometry(behavior, target);
    let featureReason = null;
    const features = gate && this.targetFeatures(behavior, target, gate, geometry, { onUnavailable: (reason) => { featureReason = reason; } });
    const tick = behavior.currentAttackDecisionTick();
    const targetSmallID = target.smallID();
    if (!this.validObservationIdentity(targetSmallID, tick)) return this.omitObservation("observation-identity-invalid");
    if (this.backend === "compact-tanh-v1" && !geometry) return this.omitObservation("geometry-unavailable", { targetSmallID, tick });
    if (!features) return this.omitObservation(gate ? featureReason || "target-features-unavailable" : "gate-features-unavailable", { targetSmallID, tick });
    this.observations.captured++;
    return features ? { gate, features, geometry, share: gate[2], tick, targetSmallID,
      actorSmallID: behavior.player.smallID?.() ?? null,
      episodeId: this.episodeId, generation: this.generation,
      modelIdentity: this.backend === "compact-tanh-v1" ? JSON.stringify(this.exportModel()) : null,
      ...this.dispatchMetadata(targetSmallID),
      attackIds: this.landAttacks(behavior, target).map((attack) => String(attack.id)) } : null;
  }

  isStrategicTarget(behavior, target) {
    return target?.type?.() !== PlayerType.Bot && target?.isPlayer?.() === true && behavior.player.sharesBorderWith(target);
  }

  validObservationIdentity(targetSmallID, tick) {
    return Number.isSafeInteger(targetSmallID) && targetSmallID >= 0 && Number.isSafeInteger(tick) && tick >= 0;
  }

  captureGeometry(behavior, target) {
    if (this.backend !== "compact-tanh-v1" || typeof behavior.hybridCombatGeometry !== "function") return null;
    return HybridCombatContract.geometry(behavior.hybridCombatGeometry(target), target.smallID(), behavior.currentAttackDecisionTick())?.raw ?? null;
  }

  dispatchMetadata(targetSmallID) {
    const learned = this.dispatch?.targetSmallID === targetSmallID && this.dispatch?.generation === this.generation;
    return { learned, dispatchID: learned ? this.dispatch.id : null,
      decisionStep: learned ? this.dispatch.decisionStep : null,
      decisionSequence: learned ? this.dispatch.decisionSequence : null,
      controlledAction: learned ? "attack" : null,
      behaviorProbability: null, logProbability: null, behaviorPolicy: learned ? "deterministic-ranked-legal" : "legendary-unknown",
      ...(learned ? { modelIdentity: this.dispatch.modelIdentity } : {}) };
  }

  allowsAttack(behavior, target) {
    if (!this.enabled() || this.numericalError || this.mode !== "learned" || !this.ready() ||
        target?.isPlayer?.() !== true || target.type?.() === PlayerType.Bot) return true;
    if (this.backend === "compact-tanh-v1" && !this.captureGeometry(behavior, target)) return true;
    const key = String(behavior.getOutboundAttackTargetKey(target));
    const engaged = this.commitments(behavior).filter((entry) =>
      entry.target.type?.() !== PlayerType.Bot && !behavior.player.isFriendly(entry.target));
    return engaged.length === 0 || engaged.some((entry) => String(entry.targetKey) === key);
  }

  recordAction(behavior, target, observation = null) {
    if (!this.enabled()) return;
    if (this.pending?.target) {
      if (observation) this.recordOmittedAcceptance(observation, "observation-pending");
      return;
    }
    if (!this.isStrategicTarget(behavior, target)) return;
    const captured = observation || this.actionObservation(behavior, target);
    if (captured?.generation === this.generation && captured.episodeId === this.episodeId && captured.targetSmallID === target.smallID()) {
      this.pending = { ...JSON.parse(JSON.stringify(captured)), target };
      const entry = this.recordLedger("accepted", { ...captured, targetSmallID: target.smallID(),
        acceptedSequence: this.sequence, reason: "action-accepted" });
      this.pending.acceptedSequence = entry.sequence;
    } else if (captured) {
      this.recordOmittedAcceptance(captured, "observation-stale");
    }
  }

  recordOmittedAcceptance(observation, reason) {
    const entry = { episodeId: observation.episodeId, generation: observation.generation,
      targetSmallID: observation.targetSmallID, tick: observation.tick, reason, phase: "acceptance" };
    if (observation.generation !== this.generation || observation.episodeId !== this.episodeId) {
      if (typeof roundLogRecord === "function") roundLogRecord("bot_decision", { ...entry,
        kind: "hybrid-combat-observation-omitted", cancelled: true });
      return;
    }
    this.observations.acceptanceOmissions[reason] = (this.observations.acceptanceOmissions[reason] || 0) + 1;
    this.recordLedger("observation-omitted", entry);
  }

  recordAcceptedAction(behavior, target, observation, generation) {
    if (generation !== this.generation) {
      if (observation) this.recordOmittedAcceptance(observation, "observation-stale");
      return;
    }
    if (!this.enabled()) return;
    if (!this.isStrategicTarget(behavior, target)) { this.recordUnobservedAcceptedAction(generation); return; }
    if (this.dispatch?.generation === generation && this.dispatch.targetSmallID === target.smallID() && !this.dispatch.accepted) {
      this.dispatch.accepted = true;
      this.control.acceptedLearnedAttacks++;
      this.funnel.acceptedDispatches++;
    }
    // An accepted but ambiguous reinforcement is still an action, never a wait.
    if (this.pending && !this.pending.target) this.pending = null;
    if (observation) this.recordAction(behavior, target, observation);
  }

  recordUnobservedAcceptedAction(generation) {
    if (generation === this.generation && this.enabled() && this.pending && !this.pending.target) this.pending = null;
  }

  decisionIdentity(behavior) {
    return { episodeId: this.episodeId, generation: this.generation, step: this.step,
      tick: behavior.currentAttackDecisionTick(), ingressSequence: this.sequence,
      actorSmallID: behavior.player?.smallID?.() ?? null, modelIdentity: JSON.stringify(this.exportModel()),
      decisionSequence: null, decisionReferenceKind: null };
  }

  async decide(behavior, enemies, identity = null) {
    if (!this.enabled()) return false;
    this.proposal = { ...(identity ?? this.decisionIdentity(behavior)), step: this.step++,
      targetSmallID: null, reserveRatio: null,
      candidateCount: 0, controlledAction: null, eligible: null, fallback: true };
    this.proposal.funnel = { suppliedTargets: enemies.length, nativeEligibleTargets: 0, featureValidTargets: 0,
      scoredTargets: 0, dispatchAttempts: 0, featureFailures: {} };
    this.funnel.suppliedTargets += enemies.length;
    this.observe(behavior);
    const gate = this.gateFeatures(behavior);
    if (!gate || this.numericalError) { this.proposal.eligible = false; return this.fallback(
      this.numericalError ? "numerical-failure" : "gate-features-unavailable"); }
    // Target identity is carried by the live player, never by its array slot.
    const candidates = this.legalCandidates(behavior, enemies, gate);
    const own = Number(behavior.player.troops());
    const reserve = Number(behavior.getEarlyGameLiveReserveTroops());
    this.proposal.reserveRatio = this.reserveRatio(own, reserve);
    this.proposal.candidateCount = candidates.length;
    // Forced waiting with no legal strategic choice is not a patience example.
    if (candidates.length === 0) { this.proposal.eligible = false; return this.fallback(
      this.proposal.funnel.nativeEligibleTargets ? "target-features-unavailable" : "no-native-eligible-target"); }
    this.decisions++;
    const { wait, act } = this.scoreMacro(gate);
    const ranked = this.scoreMicro(candidates);
    if (this.numericalError) { this.proposal.eligible = false; return this.fallback("numerical-failure"); }
    this.funnel.scoredTargets += ranked.length;
    this.proposal.funnel.scoredTargets = ranked.length;
    const utilityMargin = act - wait;
    if (!Number.isFinite(utilityMargin)) {
      this.proposal.eligible = false;
      this.numericalFailure("Nonfinite hybrid utility margin");
      return this.fallback("numerical-failure");
    }
    this.scoredProposal(behavior, ranked, { wait, act, utilityMargin, gate });
    // A pending attack owns its complete observation interval.
    this.pendingWait(behavior, gate);
    return this.controlProposal(behavior, ranked, act <= wait);
  }

  legalCandidates(behavior, enemies, gate) {
    const eligible = enemies.filter((target) => target.type?.() !== PlayerType.Bot && target.isAlive() &&
      !behavior.player.isFriendly(target) && behavior.player.sharesBorderWith(target) && behavior.canAttackPlayerNow(target));
    this.funnel.nativeEligibleTargets += eligible.length;
    if (this.proposal) this.proposal.funnel.nativeEligibleTargets = eligible.length;
    const candidates = eligible.map((target) => {
      const evidence = { geometry: null };
      const features = this.targetFeatures(behavior, target, gate, undefined, { evidence, onUnavailable: (reason) => {
        this.funnel.featureFailures[reason] = (this.funnel.featureFailures[reason] || 0) + 1;
        if (this.proposal) this.proposal.funnel.featureFailures[reason] = (this.proposal.funnel.featureFailures[reason] || 0) + 1;
      } });
      return { target, features, geometry: evidence.geometry };
    }).filter((candidate) => candidate.features !== null);
    this.funnel.featureValidTargets += candidates.length;
    if (this.proposal) this.proposal.funnel.featureValidTargets = candidates.length;
    return candidates;
  }

  reserveRatio(own, reserve) {
    if (!Number.isFinite(own) || own <= 0 || !Number.isFinite(reserve) || reserve < 0) return null;
    const ratio = reserve / own;
    return Number.isFinite(ratio) ? ratio : null;
  }

  scoredProposal(behavior, ranked, { wait, act, utilityMargin, gate }) {
    this.proposal = { ...this.proposal, tick: behavior.currentAttackDecisionTick(), ready: this.ready(),
      episodeId: this.episodeId, generation: this.generation,
      action: act > wait && ranked.length ? "attack" : "wait",
      greedyChoice: act > wait ? "attack" : "wait", utilityMargin,
      target: ranked[0]?.target.smallID() ?? null,
      targetSmallID: act > wait ? ranked[0]?.target.smallID() ?? null : null, wait, act, gate,
      behaviorProbability: null, logProbability: null,
      behaviorPolicy: "deterministic-wait-act-ranked-target",
      candidates: ranked.map(({ target, features, geometry, score }) => ({ targetSmallID: target.smallID(), features, geometry, score,
        sourceTick: this.proposal.tick, legal: typeof (behavior.player.__src ?? behavior.player).canAttackPlayer === "function" ? true : null,
        legalitySource: "existing-canAttackPlayerNow-filter" })),
      candidateCoverage: { complete: true, truncated: false, count: ranked.length, scope: "feature-valid-native-eligible-targets" } };
    this.proposal.decisionSequence = this.sequence;
    this.proposal.decisionReferenceKind = "proposal";
    this.recordLedger("proposal", { ...this.proposal, featureVersion: this.compactContract?.schema ?? HYBRID_COMBAT_SCHEMA });
  }

  pendingWait(behavior, gate) {
    if (!this.pending) this.pending = { target: null, targetSmallID: null, gate, share: gate[2],
      tick: behavior.currentAttackDecisionTick(), episodeId: this.episodeId, generation: this.generation,
      modelIdentity: this.proposal.modelIdentity,
      actorSmallID: this.proposal.actorSmallID };
  }

  async controlProposal(behavior, ranked, wait) {
    this.proposal.eligible = this.eligible();
    if (!this.proposal.eligible) {
      let reason = "model-not-ready";
      if (this.mode !== "learned") reason = "shadow-only";
      if (this.numericalError) reason = "numerical-failure";
      return this.fallback(reason);
    }
    if (wait) {
      this.control.controlledWaits++;
      if (this.pending && !this.pending.target && this.pending.tick === behavior.currentAttackDecisionTick()) {
        this.pending.decisionStep = this.proposal.step;
        this.pending.decisionSequence = this.proposal.decisionSequence;
        this.pending.controlledAction = "wait";
        this.pending.learned = true;
        this.pending.modelIdentity = this.proposal.modelIdentity;
        this.pending.behaviorPolicy = "deterministic-wait-act-ranked-target";
      }
      this.recordDecision("wait", false, "controlled-wait");
      return true;
    }
    const generation = this.generation;
    const decision = { ...this.proposal };
    const sent = await this.sendRankedAttack(behavior, ranked);
    if (generation !== this.generation) {
      this.recordCancelledDecision(decision);
      return sent;
    }
    if (!sent) return this.fallback(this.proposal.sendReason || "send-rejected-unknown");
    this.recordDecision("attack", false, "controlled-attack");
    return true;
  }

  recordCancelledDecision(decision) {
    // Publish the old historical identity only to the incremental log; a new
    // episode/configuration must not acquire stale rows or control counters.
    if (typeof roundLogRecord === "function") roundLogRecord("bot_decision", {
      ...decision, sequence: null,
      kind: "hybrid-combat-decision", controlledAction: null, fallback: true, cancelled: true, reason: "cancelled-generation",
    });
  }

  recordGeometryCancellation(identity, suppliedTargets, reason) {
    const decision = { ...identity, suppliedTargets, candidateCount: 0, reserveRatio: null,
      controlledAction: null, eligible: null, fallback: true, cancelled: true, reason };
    if (identity.generation !== this.generation) { this.recordCancelledDecision(decision); return; }
    this.funnel.suppliedTargets += suppliedTargets;
    this.funnel.callerCancellations++;
    decision.step = this.step++;
    this.recordLedger("decision", decision);
  }

  async sendRankedAttack(behavior, ranked) {
    const generation = this.generation;
    for (const candidate of ranked) {
      if (generation !== this.generation || this.mode !== "learned") return false;
      // Coordinated war applies to ordinary strategic attacks; forced defense,
      // tribe conquest and free-land expansion retain Legendary's own policy.
      if (!this.allowsAttack(behavior, candidate.target)) { this.proposal.sendReason = "commitment-veto"; continue; }
      const dispatch = { id: this.sequence, generation, episodeId: this.episodeId,
        targetSmallID: candidate.target.smallID(), accepted: false,
        decisionStep: this.proposal.step, decisionSequence: this.proposal.decisionSequence, modelIdentity: this.proposal.modelIdentity };
      this.dispatch = dispatch;
      this.funnel.dispatchAttempts++;
      this.proposal.funnel.dispatchAttempts++;
      this.recordLedger("dispatch-attempt", { dispatchID: dispatch.id, targetSmallID: dispatch.targetSmallID,
        decisionStep: dispatch.decisionStep, decisionSequence: dispatch.decisionSequence, tick: behavior.currentAttackDecisionTick(),
        reason: null });
      let sent;
      try { sent = await behavior.sendAttack(candidate.target); }
      finally { if (this.dispatch === dispatch) this.dispatch = null; }
      if (generation === this.generation && !sent) this.proposal.sendReason = dispatch.reason || "send-rejected-unknown";
      if (sent) {
        // Some callers expose acceptance solely through their returned boolean.
        // Never turn that boolean into a receipt or training label.
        this.publishAcceptedDispatch(dispatch);
        return true;
      }
    }
    return false;
  }

  publishAcceptedDispatch(dispatch) {
    if (dispatch.generation !== this.generation || dispatch.episodeId !== this.episodeId) return;
    if (!dispatch.accepted) { dispatch.accepted = true; this.control.acceptedLearnedAttacks++; this.funnel.acceptedDispatches++; }
    this.proposal = { ...this.proposal, target: dispatch.targetSmallID, targetSmallID: dispatch.targetSmallID };
  }

  diagnostics() {
    return { mode: this.mode, learning: this.learning, backend: this.backend, episodeId: this.episodeId,
      generation: this.generation, ready: this.ready(), eligible: this.eligible(),
      control: { ...this.control }, ledger: { retained: this.ledger.length, dropped: this.dropped, capacity: this.ledgerCapacity }, decisions: this.decisions,
      funnel: JSON.parse(JSON.stringify(this.funnel)), observations: JSON.parse(JSON.stringify(this.observations)),
      readiness: this.readiness(), reasons: [...HYBRID_COMBAT_REASONS],
      samples: Object.fromEntries(Object.entries(this.models).map(([name, model]) => [name, model.samples])),
      proposal: this.proposal ? JSON.parse(JSON.stringify(this.proposal)) : null,
      lastOutcome: this.lastOutcome ? JSON.parse(JSON.stringify(this.lastOutcome)) : null,
      unconfirmed: this.unconfirmed, error: this.numericalError || this.error };
  }
}

const hybridCombatPolicy = new HybridCombatPolicy();
window.__OFH_hybridCombat = {
  configure: (config) => hybridCombatPolicy.configure(config),
  exportModel: () => hybridCombatPolicy.exportModel(),
  importModel: (model) => hybridCombatPolicy.importModel(model),
  diagnostics: () => hybridCombatPolicy.diagnostics(),
  resetEpisode: () => hybridCombatPolicy.resetEpisode(),
  createCompactModel: (options) => hybridCombatPolicy.createCompactModel(options),
  exportLedger: () => hybridCombatPolicy.exportLedger(),
  rawReplay: () => hybridCombatPolicy.rawReplay(),
  replayFit: (snapshot, records, context) => hybridCombatPolicy.replayFit(snapshot, records, context),
};
