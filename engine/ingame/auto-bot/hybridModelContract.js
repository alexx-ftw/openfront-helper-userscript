// DIVERGENCE: own browser-native model/feature contract; no foreign checkpoints.
"use strict";

const HybridCombatContract = {};
{
  const schema = "ofh-combat-compact-tanh-v2";
  const gate = ["bias", "ownTroopRatio", "ownLandShare", "incomingTroopRatio"];
  const target = [...gate, "targetLandShare", "targetTroopRatio", "relativeArmy",
    "captureBudgetRatio", "committedRatio", "absDeltaX", "absDeltaY", "distance", "geometryPresent"];
  // Each scalar head has d tanh hidden units and one tanh output. Identity hidden
  // weights break symmetry deterministically; zero output weights encode no tactic.
  // SGD starts at 1/d, halves until finite loss does not increase, and abstains
  // below machine epsilon. These optimizer constants are part of the schema.
  const architecture = { version: "identity-tanh-sgd-backtrack-v1", hiddenWidth: "input-dimension",
    hiddenActivation: "tanh", outputActivation: "tanh", initialization: "identity-hidden-zero-output",
    initialStep: "1/input-dimension", backtrackFactor: 0.5, minimumStep: Number.EPSILON,
    acceptance: "finite-nonincreasing-squared-error" };
  const features = { gate, target };
  const dimensions = { wait: gate.length, act: gate.length, target: target.length };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const bounded = (values, dimension) => Array.isArray(values) && values.length === dimension &&
    Array.from(values).every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  const exactID = (value) => Number.isSafeInteger(value) && value >= 0;
  const finiteVector = (values, dimension) => Array.isArray(values) && values.length === dimension &&
    Array.from(values).every(Number.isFinite) && Number.isFinite(values.reduce((sum, value) => sum + Math.abs(value), 0));

  function freezeMetadata(snapshot) {
    function freeze(value) {
      if (value && typeof value === "object") {
        for (const entry of Object.values(value)) freeze(entry);
        Object.freeze(value);
      }
    }
    for (const [key, value] of Object.entries(snapshot)) if (key !== "models") freeze(value);
    return snapshot;
  }

  function head(dimension) {
    return { samples: 0, hidden: Array.from({ length: dimension }, (_, i) =>
      Array.from({ length: dimension }, (_, j) => Number(i === j))),
      hiddenBias: Array(dimension).fill(0), output: Array(dimension).fill(0), outputBias: 0 };
  }

  function normalizer() {
    return { kind: "raw", version: "fixed-normalizer-v1", frozen: true,
      gate: { offset: gate.map(() => 0), scale: gate.map(() => 1) },
      target: { offset: target.map(() => 0), scale: target.map(() => 1) } };
  }

  function validateNormalizer(value) {
    if (!value || !["raw", "fixed-affine"].includes(value.kind) ||
        value.version !== "fixed-normalizer-v1" || value.frozen !== true) throw new Error("Invalid frozen normalizer");
    for (const [role, names] of Object.entries(features)) {
      const entry = value[role];
      if (!finiteVector(entry?.offset, names.length) || !finiteVector(entry?.scale, names.length) ||
          entry.scale.some((scale) => scale <= 0) ||
          entry.offset.some((offset, i) => !Number.isFinite((1 + Math.abs(offset)) / entry.scale[i])) ||
          (value.kind === "raw" && entry.offset.some((offset, i) => offset !== 0 || entry.scale[i] !== 1))) {
        throw new Error("Invalid normalizer parameters");
      }
    }
  }

  function validateHead(model, dimension) {
    if (!model || !Number.isSafeInteger(model.samples) || model.samples < 0 ||
        !Array.isArray(model.hidden) || model.hidden.length !== dimension ||
        Array.from(model.hidden).some((row) => !finiteVector(row, dimension)) ||
        !finiteVector(model.hiddenBias, dimension) || !finiteVector(model.output, dimension) ||
        !Number.isFinite(model.outputBias) ||
        !Number.isFinite(model.output.reduce((sum, value) => sum + Math.abs(value), Math.abs(model.outputBias))) ||
        model.hidden.some((row, i) => !Number.isFinite(row.reduce((sum, value) => sum + Math.abs(value), Math.abs(model.hiddenBias[i]))))) {
      throw new Error("Invalid compact neural head");
    }
  }

  function create({ provenance = { implementation: "ofh", trainer: architecture.version,
    datasetID: "online-own-receipts", featureVersion: schema }, normalizer: supplied = normalizer() } = {}) {
    const result = { schema, features, architecture, normalizer: supplied,
      actions: { macro: ["wait", "act"], micro: "exact-player-id-land-target" },
      reward: "own-land-share-change-at-commitment-end", provenance,
      models: Object.fromEntries(Object.entries(dimensions).map(([name, dimension]) => [name, head(dimension)])) };
    validate(result);
    return clone(result);
  }

  function validate(snapshot) {
    if (!snapshot || snapshot.schema !== schema || JSON.stringify(snapshot.features) !== JSON.stringify(features) ||
        JSON.stringify(snapshot.architecture) !== JSON.stringify(architecture) ||
        JSON.stringify(snapshot.actions) !== JSON.stringify({ macro: ["wait", "act"], micro: "exact-player-id-land-target" }) ||
        !["own-land-share-change-at-commitment-end", "potential-shaped-land-delta-ticks-v2"].includes(snapshot.reward)) throw new Error("Incompatible compact neural contract");
    validateProvenance(snapshot);
    validateNormalizer(snapshot.normalizer);
    if (!snapshot.models || Object.keys(snapshot.models).sort().join(",") !== "act,target,wait") throw new Error("Invalid compact model keys");
    for (const [name, dimension] of Object.entries(dimensions)) {
      validateHead(snapshot.models[name], dimension);
      validateNormalizedHead(snapshot.models[name], snapshot.normalizer[name === "target" ? "target" : "gate"]);
    }
  }

  function validateProvenance(snapshot) {
    if (snapshot.offline) {
      if (snapshot.offline.version !== "offline-fit-ticks-v2") throw new Error("Invalid offline fit provenance");
      validateReplayContext(snapshot, snapshot.offline);
    }
    if (snapshot.reward === "potential-shaped-land-delta-ticks-v2" && snapshot.offline?.ablation?.potentialShaping !== true) throw new Error("Missing offline reward provenance");
    const origin = snapshot.provenance;
    if (origin?.implementation !== "ofh" || origin.trainer !== architecture.version || origin.featureVersion !== schema ||
        typeof origin.datasetID !== "string" || origin.datasetID.trim().length === 0) throw new Error("Invalid model provenance");
  }

  function validateNormalizedHead(model, transform) {
    if (!safeNormalizedHead(model, transform)) throw new Error("Unsafe normalized neural weights");
  }

  function safeNormalizedHead(model, transform) {
    const bound = transform.offset.map((offset, i) => Math.max(Math.abs(offset), Math.abs(1 - offset)) / transform.scale[i]);
    return model.hidden.every((row, i) => Number.isFinite(row.reduce((sum, weight, j) =>
      sum + Math.abs(weight) * bound[j], Math.abs(model.hiddenBias[i]))));
  }

  function normalize(values, name, frozen) {
    const dimension = dimensions[name];
    if (!bounded(values, dimension)) throw new Error("Invalid bounded neural features");
    const role = name === "target" ? "target" : "gate";
    const result = values.map((value, i) => (value - frozen[role].offset[i]) / frozen[role].scale[i]);
    return result.every(Number.isFinite) ? result : null;
  }

  function finiteDot(weights, values, bias) {
    let sum = bias;
    if (!Number.isFinite(sum)) return null;
    for (let i = 0; i < weights.length; i++) {
      const product = weights[i] * values[i];
      if (!Number.isFinite(product)) return null;
      sum += product;
      if (!Number.isFinite(sum)) return null;
    }
    return sum;
  }

  function forward(model, values) {
    if (!values || !values.every(Number.isFinite)) return null;
    const logits = model.hidden.map((row, i) => finiteDot(row, values, model.hiddenBias[i]));
    if (logits.some((value) => value === null)) return null;
    const hidden = logits.map(Math.tanh);
    const output = finiteDot(model.output, hidden, model.outputBias);
    if (output === null) return null;
    const prediction = Math.tanh(output);
    return hidden.every(Number.isFinite) && Number.isFinite(prediction) ? { hidden, prediction } : null;
  }

  function update(model, values, reward, transform = null) {
    const before = forward(model, values);
    if (!before || !Number.isSafeInteger(model.samples + 1)) return null;
    const derivative = (before.prediction - reward) * (1 - before.prediction ** 2);
    const hiddenGradient = before.hidden.map((value, i) => derivative * model.output[i] * (1 - value ** 2));
    const loss = (before.prediction - reward) ** 2;
    if (!Number.isFinite(derivative) || !Number.isFinite(loss) || !hiddenGradient.every(Number.isFinite)) return null;
    for (let step = 1 / values.length; step >= Number.EPSILON; step *= architecture.backtrackFactor) {
      const candidate = { samples: model.samples + 1,
        hidden: model.hidden.map((row, i) => row.map((weight, j) => weight - step * hiddenGradient[i] * values[j])),
        hiddenBias: model.hiddenBias.map((bias, i) => bias - step * hiddenGradient[i]),
        output: model.output.map((weight, i) => weight - step * derivative * before.hidden[i]),
        outputBias: model.outputBias - step * derivative };
      const finite = finiteCandidate(candidate, values.length);
      const safe = finite && (transform === null || safeNormalizedHead(candidate, transform));
      const after = safe && forward(candidate, values);
      if (after && (after.prediction - reward) ** 2 <= loss) return candidate;
    }
    return null;
  }

  function finiteCandidate(candidate, dimension) {
    return candidate.hidden.every((row) => finiteVector(row, dimension)) &&
      finiteVector(candidate.hiddenBias, dimension) && finiteVector(candidate.output, dimension) &&
      Number.isFinite(candidate.outputBias) && candidate.hidden.every((row, i) =>
        Number.isFinite(row.reduce((sum, value) => sum + Math.abs(value), Math.abs(candidate.hiddenBias[i])))) &&
      Number.isFinite(candidate.output.reduce((sum, value) => sum + Math.abs(value), Math.abs(candidate.outputBias)));
  }

  function geometry(value, targetID, tick) {
    if (!exactID(targetID) || value?.targetSmallID !== targetID || value.tick !== tick ||
        !Number.isSafeInteger(tick) || tick < 0 || value.source !== "native-border-centroid-v1") return null;
    if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width <= 0 || value.height <= 0) return null;
    if (![value.own, value.target].every((point) => validPoint(point, value))) return null;
    const dx = Math.abs(value.target.x - value.own.x) / value.width;
    const dy = Math.abs(value.target.y - value.own.y) / value.height;
    return { raw: clone(value), features: [dx, dy, Math.hypot(dx, dy) / Math.SQRT2, 1] };
  }

  function validPoint(point, value) {
    return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      point.x >= 0 && point.y >= 0 && point.x < value.width && point.y < value.height);
  }

  function validateAblation(ablation) {
    if (ablation?.version !== "patient-potential-v1" || typeof ablation.patientAnchors !== "boolean" ||
        typeof ablation.potentialShaping !== "boolean") throw new Error("Invalid offline ablation");
  }

  function validateTransitionScalars({ reward, potential, nextPotential, advantage }) {
    if (![reward, potential, nextPotential, advantage].every(Number.isFinite) ||
        Math.abs(reward) > 1) throw new Error("Invalid offline feature transition");
  }

  function validateTransitionIdentity(action, targetID, terminal) {
    if (typeof terminal !== "boolean" || !["wait", "act"].includes(action) ||
        (action === "wait" ? targetID !== null : !exactID(targetID))) throw new Error("Invalid offline feature transition");
  }

  // Offline only: no live tactical reward replacement or anchor replay.
  // Terminal potential is zero; truncations are censored, never treated as death.
  function temporalDiscount({ gammaTick, actionTick, outcomeTick }) {
    if (!Number.isFinite(gammaTick) || gammaTick < 0 || gammaTick > 1 ||
        ![actionTick, outcomeTick].every(Number.isSafeInteger) || actionTick < 0 || outcomeTick < actionTick) {
      throw new Error("Invalid temporal PBRS timing/discount");
    }
    const deltaTicks = outcomeTick - actionTick;
    const discount = gammaTick ** deltaTicks;
    if (!Number.isFinite(discount)) throw new Error("Nonfinite temporal PBRS discount");
    return { gammaTick, actionTick, outcomeTick, deltaTicks, discount };
  }

  function transitionTiming(ablation, values) {
    if (ablation.potentialShaping) return temporalDiscount(values);
    return { gammaTick: null, actionTick: values.actionTick ?? null, outcomeTick: values.outcomeTick ?? null,
      deltaTicks: null, discount: null };
  }

  function offlineTransition({ raw, nextRaw, reward, gammaTick, actionTick, outcomeTick, potential, nextPotential,
    terminal = false, truncated = false, advantage, action, targetID = null, ablation }) {
    if (typeof truncated !== "boolean") throw new Error("Invalid truncation flag");
    if (truncated) return null;
    validateAblation(ablation);
    validateTransitionScalars({ reward, potential, nextPotential, advantage });
    validateTransitionIdentity(action, targetID, terminal);
    if (!bounded(raw, gate.length) || !bounded(nextRaw, gate.length)) throw new Error("Invalid offline feature transition");
    const absorbingPotential = terminal ? 0 : nextPotential;
    const timing = transitionTiming(ablation, { gammaTick, actionTick, outcomeTick });
    const shaped = reward + (ablation.potentialShaping ? timing.discount * absorbingPotential - potential : 0);
    if (!Number.isFinite(shaped)) throw new Error("Nonfinite potential reward");
    return clone({ version: "offline-combat-transition-ticks-v2", featureVersion: schema, raw, nextRaw,
      reward, shaped, ...timing, potential, nextPotential: absorbingPotential, terminal, advantage,
      action, targetID, ablation, anchor: ablation.patientAnchors && action === "wait" && advantage > 0 });
  }

  // Pure bounded replay used by the offline CLI. Records must belong to one
  // explicitly selected frozen model generation/engine/experiment/normalizer.
  // Anchor advantage is recomputed against that frozen model, never trusted from
  // supplied labels. Additional positive WAIT replay is an explicit ablation.
  function validateReplayContext(snapshot, context) {
    const { engineRevision, experimentID, generation, episodeId, ablation, potentialID } = context;
    validateAblation(ablation);
    if (!/^[0-9a-f]{40}$/.test(engineRevision || "") || typeof experimentID !== "string" || !experimentID.trim() ||
        ![generation, episodeId].every(Number.isSafeInteger) || [generation, episodeId].some((id) => id < 0) ||
        (ablation.potentialShaping && (typeof potentialID !== "string" || !potentialID.trim()))) {
      throw new Error("Incompatible offline replay context");
    }
    validateTemporalProvenance(context);
  }

  function validateTemporalProvenance(context) {
    if (!context.ablation.potentialShaping) return;
    if (!Number.isFinite(context.gammaTick) || context.gammaTick < 0 || context.gammaTick > 1) throw new Error("Invalid offline gammaTick");
    if (context.version && context.discountContract !== "elapsed-action-outcome-ticks-v1") {
      throw new Error("Invalid temporal reward provenance");
    }
  }

  function validateReplayRecord(snapshot, record, context) {
    if (record?.featureVersion !== schema || record.generation !== context.generation || record.episodeId !== context.episodeId ||
        record.engineRevision !== context.engineRevision || record.experimentID !== context.experimentID ||
        JSON.stringify(record.normalizer) !== JSON.stringify(snapshot.normalizer) ||
        record.modelIdentity !== JSON.stringify(snapshot)) throw new Error("Incompatible raw replay record");
    if (typeof record.terminal !== "boolean" || typeof record.truncated !== "boolean") throw new Error("Invalid replay flags");
  }

  function prepareReplay(snapshot, record, context) {
    validateReplayRecord(snapshot, record, context);
    if (record.truncated === true || record.reward === null || record.confirmed !== true) return null;
    if (!["wait", "attack"].includes(record.action)) throw new Error("Invalid replay action");
    if (record.action === "attack") validateAttackEvidence(record);
    const name = record.action === "wait" ? "wait" : "act";
    const values = normalize(record.gate, name, snapshot.normalizer);
    const frozen = forward(snapshot.models[name], values);
    if (!frozen) throw new Error("Invalid frozen replay prediction");
    const { ablation } = context;
    const transition = offlineTransition({ raw: record.gate, nextRaw: record.nextGate, reward: record.reward,
      gammaTick: context.gammaTick, actionTick: record.actionTick, outcomeTick: record.outcomeTick,
      potential: ablation.potentialShaping ? record.potential : 0,
      nextPotential: ablation.potentialShaping ? record.nextPotential : 0, terminal: record.terminal === true,
      advantage: record.reward - frozen.prediction, action: name === "wait" ? "wait" : "act", targetID: record.targetSmallID, ablation });
    const examples = [[name, values]];
    if (name === "act") examples.push(["target", normalize(record.features, "target", snapshot.normalizer)]);
    if (examples.some(([, input]) => input === null)) throw new Error("Invalid normalized replay input");
    return { examples, transition };
  }

  function validateAttackEvidence(record) {
    if (typeof record.receiptID !== "string" || !record.receiptID.trim()) throw new Error("Missing attack receipt evidence");
    const nativeGeometry = geometry(record.geometry, record.targetSmallID, record.actionTick);
    if (!nativeGeometry) throw new Error("Invalid attack target geometry evidence");
    if (!bounded(record.features, target.length) || !bounded(record.gate, gate.length)) throw new Error("Invalid attack raw features");
    if (record.features.slice(0, gate.length).some((value, i) => value !== record.gate[i]) ||
        record.features.slice(9).some((value, i) => value !== nativeGeometry.features[i])) {
      throw new Error("Attack raw geometry/features disagree");
    }
  }

  function fitRecord(output, prepared) {
    const { examples, transition } = prepared;
    for (let pass = 0; pass < (transition.anchor ? 2 : 1); pass++) {
      const candidates = examples.map(([name, input]) => [name, update(output.models[name], input, transition.shaped,
        output.normalizer[name === "target" ? "target" : "gate"])]);
      if (candidates.some(([, candidate]) => candidate === null)) throw new Error("Offline numerical update rejected");
      for (const [name, candidate] of candidates) output.models[name] = candidate;
    }
  }

  function fitOffline(snapshot, records, context = {}) {
    validate(snapshot);
    validateReplayContext(snapshot, context);
    const { maxRecords = 256, engineRevision, experimentID, generation, episodeId, gammaTick, potentialID, ablation } = context;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Array.isArray(records) ||
        JSON.stringify(context.normalizer) !== JSON.stringify(snapshot.normalizer)) throw new Error("Incompatible offline replay context");
    const output = clone(snapshot);
    const selected = records.slice(-maxRecords);
    let fitted = 0;
    let anchors = 0;
    let censored = 0;
    for (const record of selected) {
      const prepared = prepareReplay(snapshot, record, context);
      if (!prepared) { censored++; continue; }
      fitRecord(output, prepared);
      fitted++;
      if (prepared.transition.anchor) anchors++;
    }
    output.offline = { version: "offline-fit-ticks-v2", engineRevision, experimentID, generation, episodeId,
      ablation: clone(ablation), gammaTick: ablation.potentialShaping ? gammaTick : null,
      discountContract: ablation.potentialShaping ? "elapsed-action-outcome-ticks-v1" : null, potentialID: potentialID ?? null };
    if (ablation.potentialShaping) output.reward = "potential-shaped-land-delta-ticks-v2";
    validate(output);
    const { models, ...metadata } = output;
    return { model: { ...metadata, models }, summary: { fitted, anchors, censored, dropped: records.length - selected.length,
      retained: selected.length, complete: records.length === selected.length, performanceClaim: false } };
  }

  Object.assign(HybridCombatContract, { schema, features: clone(features), dimensions: clone(dimensions), create,
    validate, validateHead, normalize, forward, update, geometry, exactID, offlineTransition, fitOffline, freezeMetadata });
  Object.freeze(HybridCombatContract);
}
