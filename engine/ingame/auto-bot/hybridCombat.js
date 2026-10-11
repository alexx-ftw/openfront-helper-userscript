// DIVERGENCE: optional learned land-combat ranking; Legendary remains the fallback.
// Ideas: OpenFrontMind's separate wait/act gate and entity targets, AggroBot's
// committed-war coordination, and paired frozen-policy evaluation from RL projects.
"use strict";

const HYBRID_COMBAT_SCHEMA = "ofh-combat-ridge-v1";
const HYBRID_COMBAT_STORAGE = "openfront-helper-hybrid-combat-v1";
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
  constructor({ storage = window.localStorage } = {}) {
    this.storage = storage;
    this.mode = "shadow";
    this.learning = true;
    this.models = { wait: hybridCombatModel(4), act: hybridCombatModel(4), target: hybridCombatModel(9) };
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
    if (config.mode !== undefined) this.mode = config.mode;
    if (config.learning !== undefined) this.learning = config.learning;
    // Switching mode never credits a previous policy's unfinished decision.
    this.pending = null;
    this.generation++;
    this.persist();
    return this.diagnostics();
  }

  exportModel() {
    return JSON.parse(JSON.stringify({ schema: HYBRID_COMBAT_SCHEMA,
      features: HYBRID_COMBAT_FEATURES, reward: "own-land-share-change-at-commitment-end",
      models: this.models }));
  }

  importModel(snapshot) {
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
    this.numericalError = null;
    this.pending = null;
    this.generation++;
    this.persist();
  }

  persist() {
    if (!this.storage) return;
    // HYBRID_MODEL_SAVE_BOUNDARY_START
    // Storage denial/quota errors remain visible without disabling Legendary.
    try {
      this.storage.setItem(HYBRID_COMBAT_STORAGE, JSON.stringify({
        config: { mode: this.mode, learning: this.learning }, model: this.exportModel(),
      }));
      this.error = null;
    // eslint-disable-next-line no-restricted-syntax -- quota/denial affects optional persistence; error remains in diagnostics
    } catch (error) { this.error = String(error.message); }
    // HYBRID_MODEL_SAVE_BOUNDARY_END
  }

  predict(name, features) {
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
    this.models[name] = { samples, weights, inverse };
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
    return Object.values(this.models).every((model) => model.samples >= model.weights.length);
  }

  beginSession() {
    this.pending = null;
    this.proposal = null;
    this.decisions = 0;
    this.unconfirmed = 0;
    this.generation++;
    this.lastOutcome = null;
  }

  gateFeatures(behavior) {
    const player = behavior.player;
    const troops = Number(player.troops());
    const maximum = Number(behavior.game.config().maxTroops(player));
    const land = Number(behavior.game.numLandTiles());
    const incoming = Number(behavior.incomingHostileAttackPressure());
    const features = [1, troops / Math.max(1, maximum), Number(player.numTilesOwned()) / Math.max(1, land),
      Number.isFinite(incoming) ? Math.min(1, incoming) : 1];
    if (!features.every(Number.isFinite)) return null;
    return features.map((value) => Math.max(0, Math.min(1, value)));
  }

  targetFeatures(behavior, target, gate) {
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
    if (!features.every(Number.isFinite)) return null;
    return features.map((value) => Math.max(0, Math.min(1, value)));
  }

  observe(behavior, terminal = false) {
    if (!this.enabled() || !this.pending) return;
    const pending = this.pending;
    const tick = behavior.currentAttackDecisionTick();
    if (pending.target && this.landAttacks(behavior, pending.target).some((attack) =>
      attack.id != null && !pending.attackIds.includes(String(attack.id)))) {
      pending.confirmed = true;
    }
    if (!terminal && this.observationStillPending(behavior, pending, tick)) return;
    const gate = this.gateFeatures(behavior);
    if (!gate) { this.pending = null; return; }
    if (pending.target && !pending.confirmed) {
      this.unconfirmed++;
      this.recordOutcome(pending, tick, null);
      this.pending = null;
      return;
    }
    const reward = gate[2] - pending.share;
    this.learn(pending.target ? "act" : "wait", pending.gate, reward);
    if (pending.target) this.learn("target", pending.features, reward);
    this.recordOutcome(pending, tick, reward);
    this.pending = null;
  }

  recordOutcome(pending, tick, reward) {
    this.lastOutcome = { action: pending.target ? "attack" : "wait", target: pending.target?.smallID() ?? null,
      actionTick: pending.tick, outcomeTick: tick, confirmed: pending.target ? pending.confirmed === true : true,
      reward, gate: pending.gate, features: pending.features ?? null };
    if (typeof roundLogRecord === "function") {
      roundLogRecord("bot_decision", { kind: "hybrid-combat-outcome", ...this.lastOutcome });
    }
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

  actionObservation(behavior, target) {
    if (!this.enabled() || target?.type?.() === PlayerType.Bot || !target?.isPlayer?.() ||
        !behavior.player.sharesBorderWith(target)) return null;
    // Existing land/boat commitments make a new intent's receipt ambiguous.
    if (this.commitmentTroops(behavior, target) > 0) return null;
    const gate = this.gateFeatures(behavior);
    const features = gate && this.targetFeatures(behavior, target, gate);
    return features ? { gate, features, share: gate[2], tick: behavior.currentAttackDecisionTick(),
      generation: this.generation, attackIds: this.landAttacks(behavior, target).map((attack) => String(attack.id)) } : null;
  }

  allowsAttack(behavior, target) {
    if (!this.enabled() || this.numericalError || this.mode !== "learned" || !this.ready() ||
        target?.isPlayer?.() !== true || target.type?.() === PlayerType.Bot) return true;
    const key = String(behavior.getOutboundAttackTargetKey(target));
    const engaged = this.commitments(behavior).filter((entry) =>
      entry.target.type?.() !== PlayerType.Bot && !behavior.player.isFriendly(entry.target));
    return engaged.length === 0 || engaged.some((entry) => String(entry.targetKey) === key);
  }

  recordAction(behavior, target, observation = null) {
    if (!this.enabled() || this.pending?.target || target?.type?.() === PlayerType.Bot ||
        !target?.isPlayer?.() || !behavior.player.sharesBorderWith(target)) return;
    const captured = observation || this.actionObservation(behavior, target);
    if (captured?.generation === this.generation) this.pending = { ...captured, target };
  }

  recordAcceptedAction(behavior, target, observation, generation) {
    if (generation !== this.generation || !this.enabled() || target?.type?.() === PlayerType.Bot ||
        !target?.isPlayer?.() || !behavior.player.sharesBorderWith(target)) return;
    // An accepted but ambiguous reinforcement is still an action, never a wait.
    if (this.pending && !this.pending.target) this.pending = null;
    if (observation) this.recordAction(behavior, target, observation);
  }

  async decide(behavior, enemies) {
    if (!this.enabled()) return false;
    this.observe(behavior);
    const gate = this.gateFeatures(behavior);
    if (!gate || this.numericalError) return false;
    // Target identity is carried by the live player, never by its array slot.
    const candidates = enemies.filter((target) => target.type?.() !== PlayerType.Bot && target.isAlive() &&
      !behavior.player.isFriendly(target) && behavior.player.sharesBorderWith(target) && behavior.canAttackPlayerNow(target))
      .map((target) => ({ target, features: this.targetFeatures(behavior, target, gate) }))
      .filter((candidate) => candidate.features !== null);
    // Forced waiting with no legal strategic choice is not a patience example.
    if (candidates.length === 0) return false;
    this.decisions++;
    const wait = this.predict("wait", gate);
    const act = this.predict("act", gate);
    const ranked = candidates.map((candidate) => ({ ...candidate, score: this.predict("target", candidate.features) }))
      .sort((a, b) => b.score - a.score || a.target.smallID() - b.target.smallID());
    if (this.numericalError) return false;
    this.proposal = { tick: behavior.currentAttackDecisionTick(), ready: this.ready(),
      action: act > wait && ranked.length ? "attack" : "wait",
      target: ranked[0]?.target.smallID() ?? null, wait, act };
    // A pending attack owns its complete observation interval. Wait observations
    // are credited only when no accepted ordinary strategic attack replaces them.
    if (!this.pending) this.pending = { target: null, gate, share: gate[2], tick: behavior.currentAttackDecisionTick() };
    if (this.mode !== "learned" || !this.ready()) return false;
    if (act <= wait) return true;
    return this.sendRankedAttack(behavior, ranked);
  }

  async sendRankedAttack(behavior, ranked) {
    const generation = this.generation;
    for (const candidate of ranked) {
      if (generation !== this.generation || this.mode !== "learned") return false;
      // Coordinated war applies to ordinary strategic attacks; forced defense,
      // tribe conquest and free-land expansion retain Legendary's own policy.
      if (!this.allowsAttack(behavior, candidate.target)) continue;
      if (await behavior.sendAttack(candidate.target)) return true;
    }
    return false;
  }

  diagnostics() {
    return { mode: this.mode, learning: this.learning, ready: this.ready(), decisions: this.decisions,
      samples: Object.fromEntries(Object.entries(this.models).map(([name, model]) => [name, model.samples])),
      proposal: this.proposal, lastOutcome: this.lastOutcome, unconfirmed: this.unconfirmed, error: this.numericalError || this.error };
  }
}

const hybridCombatPolicy = new HybridCombatPolicy();
window.__OFH_hybridCombat = {
  configure: (config) => hybridCombatPolicy.configure(config),
  exportModel: () => hybridCombatPolicy.exportModel(),
  importModel: (model) => hybridCombatPolicy.importModel(model),
  diagnostics: () => hybridCombatPolicy.diagnostics(),
};
