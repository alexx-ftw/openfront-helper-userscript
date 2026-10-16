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
  const frontierSchema = "ofh-combat-compact-tanh-v3";
  const frontierTarget = [...target, "sharedFrontierRatio", "incomingFromTargetRatio",
    "frontierPresent", "incomingFromTargetPresent"];
  function featuresFor(snapshot) {
    if (snapshot?.schema === schema && snapshot.featureProfile === undefined) return clone(features);
    if (snapshot?.schema === frontierSchema && snapshot.featureProfile === "frontier-v1") {
      return { gate: [...gate], target: [...frontierTarget] };
    }
    throw new Error("Incompatible compact neural profile");
  }
  function dimensionsFor(snapshot) {
    const names = featuresFor(snapshot);
    return { wait: names.gate.length, act: names.gate.length, target: names.target.length };
  }
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

  function normalizer(names = features, version = "fixed-normalizer-v1") {
    return { kind: "raw", version, frozen: true,
      gate: { offset: gate.map(() => 0), scale: gate.map(() => 1) },
      target: { offset: names.target.map(() => 0), scale: names.target.map(() => 1) } };
  }

  function validateNormalizer(value, snapshot) {
    if (!value || !["raw", "fixed-affine"].includes(value.kind) ||
        value.version !== (snapshot.schema === frontierSchema ? "fixed-normalizer-frontier-v1" : "fixed-normalizer-v1") || value.frozen !== true) throw new Error("Invalid frozen normalizer");
    for (const [role, names] of Object.entries(featuresFor(snapshot))) {
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

  function validateControlProfile(controlProfile, featureProfile) {
    if (controlProfile !== undefined && !["target-value-v1", "tribe-ranking-v1", "tribe-only-terminal-v1", "funded-tribe-terminal-v1"].includes(controlProfile)) throw new Error("Invalid control profile");
    if (["tribe-ranking-v1", "tribe-only-terminal-v1", "funded-tribe-terminal-v1"].includes(controlProfile) && featureProfile !== "frontier-v1") throw new Error("Tribe ranking requires frontier features");
  }

  function conditionalTribeProfile(controlProfile) {
    return ["tribe-only-terminal-v1", "funded-tribe-terminal-v1"].includes(controlProfile);
  }

  function actionsFor(controlProfile) {
    if (conditionalTribeProfile(controlProfile)) return {
      macro: [], micro: "exact-player-id-land-target",
      tribeRanking: controlProfile === "funded-tribe-terminal-v1" ? "native-funded-land-subset-v1" : "native-land-subset-v1",
      activeHeads: ["target"], inactiveHeads: ["wait", "act"],
      strategicMacro: "native-legendary-v1", suppressWait: false };
    const actions = { macro: ["wait", "act"], micro: "exact-player-id-land-target" };
    if (controlProfile !== undefined) actions.macroValue = "best-target-vs-wait-v1";
    if (controlProfile === "tribe-ranking-v1") actions.tribeRanking = "native-land-subset-v1";
    return actions;
  }

  function create({ featureProfile, controlProfile, provenance, normalizer: supplied } = {}) {
    if (featureProfile !== undefined && featureProfile !== "frontier-v1") throw new Error("Invalid feature profile");
    validateControlProfile(controlProfile, featureProfile);
    const identity = { schema: featureProfile ? frontierSchema : schema,
      ...(featureProfile ? { featureProfile } : {}) };
    const names = featuresFor(identity);
    const result = { schema: identity.schema, ...(featureProfile ? { featureProfile } : {}),
      ...(controlProfile === undefined ? {} : { controlProfile }),
      features: names, architecture,
      normalizer: supplied ?? normalizer(names,
        featureProfile ? "fixed-normalizer-frontier-v1" : "fixed-normalizer-v1"),
      actions: actionsFor(controlProfile),
      reward: "own-land-share-change-at-commitment-end",
      provenance: provenance ?? { implementation: "ofh", trainer: architecture.version,
        datasetID: "online-own-receipts", featureVersion: identity.schema } };
    result.models = Object.fromEntries(Object.entries(dimensionsFor(result)).map(([name, dimension]) => [name, head(dimension)]));
    validate(result);
    return clone(result);
  }

  function validate(snapshot) {
    validateControlProfile(snapshot?.controlProfile, snapshot?.featureProfile);
    if (!snapshot || JSON.stringify(snapshot.features) !== JSON.stringify(featuresFor(snapshot)) ||
        JSON.stringify(snapshot.architecture) !== JSON.stringify(architecture) ||
        JSON.stringify(snapshot.actions) !== JSON.stringify(actionsFor(snapshot.controlProfile)) ||
        !["own-land-share-change-at-commitment-end", "potential-shaped-land-delta-ticks-v2", "discounted-terminal-win-return-v1"].includes(snapshot.reward)) throw new Error("Incompatible compact neural contract");
    validateProvenance(snapshot);
    validateNormalizer(snapshot.normalizer, snapshot);
    if (!snapshot.models || Object.keys(snapshot.models).sort().join(",") !== "act,target,wait") throw new Error("Invalid compact model keys");
    for (const [name, dimension] of Object.entries(dimensionsFor(snapshot))) {
      validateHead(snapshot.models[name], dimension);
      validateNormalizedHead(snapshot.models[name], snapshot.normalizer[name === "target" ? "target" : "gate"]);
    }
  }

  function validateReturnProvenance(snapshot) {
    if (snapshot.reward !== "discounted-terminal-win-return-v1") throw new Error("Incompatible terminal reward provenance");
    if (snapshot.offline.version !== "offline-terminal-return-batch-v1") validateReturnContext(snapshot, snapshot.offline, snapshot.offline.version === "offline-terminal-return-v1");
    if (snapshot.offline.returnTrainer !== "monte-carlo-tanh-sgd-v1") throw new Error("Invalid return trainer provenance");
    const origin = returnOrigin(snapshot.offline);
    validate(origin);
    if (origin.schema !== snapshot.schema || origin.controlProfile !== snapshot.controlProfile ||
        JSON.stringify(origin.actions) !== JSON.stringify(snapshot.actions) || JSON.stringify(origin.normalizer) !== JSON.stringify(snapshot.normalizer) ||
        JSON.stringify(origin.provenance) !== JSON.stringify(snapshot.provenance)) throw new Error("Incompatible return origin contract");
    if (snapshot.offline.originalDecisionSteps !== undefined || snapshot.offline.coverage !== undefined) {
      validateDecisionCoverage(snapshot.offline.originalDecisionSteps, snapshot.offline.coverage);
      if (snapshot.offline.originalDecisionSteps.length !== snapshot.offline.fittedRecords) throw new Error("Invalid return decision counts");
    }
    if (snapshot.offline.version === "offline-terminal-return-batch-v1") validateBatchProvenance(snapshot, origin);
    validateReturnCounts(snapshot, origin);
  }

  function returnOrigin(offline) {
    if (offline.version === "offline-terminal-return-v1") {
      if (offline.originModelIdentity !== offline.modelIdentity) throw new Error("Invalid return trainer provenance");
      return JSON.parse(offline.originModelIdentity);
    }
    if (!offline.originModel || typeof offline.originModel !== "object" || Array.isArray(offline.originModel) ||
        "modelIdentity" in offline || "originModelIdentity" in offline) throw new Error("Invalid structured return origin");
    return offline.originModel;
  }

  function returnProvenanceVersion(version) {
    return ["offline-terminal-return-v1", "offline-terminal-return-v2", "offline-terminal-return-batch-v1"].includes(version);
  }

  function validateReturnCounts(snapshot, origin) {
    const counts = snapshot.offline.headUpdates;
    if (!counts || Object.keys(counts).sort().join(",") !== "act,target,wait" ||
        !Object.values(counts).every(exactID) || counts.act !== counts.target ||
        !exactID(snapshot.offline.fittedRecords) || counts.wait + counts.act !== snapshot.offline.fittedRecords ||
        !["wait", "act", "target"].every((name) => snapshot.models?.[name]?.samples === origin.models[name].samples + counts[name])) {
      throw new Error("Invalid return update counts");
    }
  }

  function validateProvenance(snapshot) {
    if (snapshot.offline) {
      if (returnProvenanceVersion(snapshot.offline.version)) validateReturnProvenance(snapshot);
      else {
        if (snapshot.offline.version !== "offline-fit-ticks-v2") throw new Error("Invalid offline fit provenance");
        validateReplayContext(snapshot, snapshot.offline);
      }
    }
    if (snapshot.reward === "potential-shaped-land-delta-ticks-v2" && snapshot.offline?.ablation?.potentialShaping !== true) throw new Error("Missing offline reward provenance");
    if (snapshot.reward === "discounted-terminal-win-return-v1" && !returnProvenanceVersion(snapshot.offline?.version)) throw new Error("Missing terminal reward provenance");
    validateModelOrigin(snapshot);
  }

  function validateModelOrigin(snapshot) {
    const origin = snapshot.provenance;
    if (origin?.implementation !== "ofh" || origin.trainer !== architecture.version || origin.featureVersion !== snapshot.schema ||
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
    const snapshot = frozen?.models ? frozen : null;
    const role = name === "target" ? "target" : "gate";
    const dimension = snapshot ? dimensionsFor(snapshot)[name] : frozen?.[role]?.offset?.length;
    if (snapshot) {
      validateNormalizer(snapshot.normalizer, snapshot);
      frozen = snapshot.normalizer;
    }
    if (!["wait", "act", "target"].includes(name) ||
        ![dimensions[name], name === "target" ? frontierTarget.length : gate.length].includes(dimension)) throw new Error("Invalid neural feature dimension");
    if (!bounded(values, dimension)) throw new Error("Invalid bounded neural features");
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

  function frontierFeatures(raw, expected) {
    if (!raw || raw.source !== "native-target-frontier-v1" || !expected ||
        !["actorSmallID", "targetSmallID", "tick", "generation"].every((key) =>
          exactID(expected[key]) && raw[key] === expected[key]) ||
        raw.actorSmallID === raw.targetSmallID) return null;
    const borderKnown = raw.ownBorderCount !== null || raw.sharedFrontierCount !== null;
    const incomingKnown = raw.ownMaxTroops !== null || raw.incomingFromTargetTroops !== null;
    if (borderKnown && !validFrontierCounts(raw)) return null;
    if (incomingKnown && !validIncomingCounts(raw)) return null;
    return { raw: clone(raw), features: [borderKnown ? raw.sharedFrontierCount / raw.ownBorderCount : 0,
      incomingKnown ? Math.min(1, raw.incomingFromTargetTroops / raw.ownMaxTroops) : 0,
      Number(borderKnown), Number(incomingKnown)] };
  }

  function validFrontierCounts(raw) {
    return exactID(raw.ownBorderCount) && raw.ownBorderCount > 0 &&
      exactID(raw.sharedFrontierCount) && raw.sharedFrontierCount <= raw.ownBorderCount;
  }

  function validIncomingCounts(raw) {
    return Number.isFinite(raw.ownMaxTroops) && raw.ownMaxTroops > 0 &&
      Number.isFinite(raw.incomingFromTargetTroops) && raw.incomingFromTargetTroops >= 0;
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
    terminal = false, truncated = false, advantage, action, targetID = null, ablation, featureVersion = schema }) {
    if (![schema, frontierSchema].includes(featureVersion)) throw new Error("Invalid transition feature version");
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
    return clone({ version: "offline-combat-transition-ticks-v2", featureVersion, raw, nextRaw,
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
    if (snapshot.schema === frontierSchema && !exactID(context.actorSmallID)) throw new Error("Missing frontier actor context");
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
    if (record?.featureVersion !== snapshot.schema || record.generation !== context.generation || record.episodeId !== context.episodeId ||
        record.engineRevision !== context.engineRevision || record.experimentID !== context.experimentID ||
        JSON.stringify(record.normalizer) !== JSON.stringify(snapshot.normalizer) ||
        record.modelIdentity !== JSON.stringify(snapshot)) throw new Error("Incompatible raw replay record");
    if (snapshot.schema === frontierSchema && record.actorSmallID !== context.actorSmallID) throw new Error("Incompatible frontier actor context");
    if (typeof record.terminal !== "boolean" || typeof record.truncated !== "boolean") throw new Error("Invalid replay flags");
  }

  function prepareReplay(snapshot, record, context) {
    validateReplayRecord(snapshot, record, context);
    if (record.truncated === true || record.reward === null || record.confirmed !== true) return null;
    if (!["wait", "attack"].includes(record.action)) throw new Error("Invalid replay action");
    if (record.action === "attack") validateAttackEvidence(record, snapshot);
    const name = record.action === "wait" ? "wait" : "act";
    const values = normalize(record.gate, name, snapshot);
    const frozen = forward(snapshot.models[name], values);
    if (!frozen) throw new Error("Invalid frozen replay prediction");
    const { ablation } = context;
    const transition = offlineTransition({ raw: record.gate, nextRaw: record.nextGate, reward: record.reward,
      gammaTick: context.gammaTick, actionTick: record.actionTick, outcomeTick: record.outcomeTick,
      potential: ablation.potentialShaping ? record.potential : 0,
      nextPotential: ablation.potentialShaping ? record.nextPotential : 0, terminal: record.terminal === true,
      featureVersion: snapshot.schema, advantage: record.reward - frozen.prediction, action: name === "wait" ? "wait" : "act", targetID: record.targetSmallID, ablation });
    const examples = [[name, values]];
    if (name === "act") examples.push(["target", normalize(record.features, "target", snapshot)]);
    if (examples.some(([, input]) => input === null)) throw new Error("Invalid normalized replay input");
    return { examples, transition };
  }

  function validateAttackEvidence(record, snapshot) {
    if (typeof record.receiptID !== "string" || !record.receiptID.trim()) throw new Error("Missing attack receipt evidence");
    const nativeGeometry = geometry(record.geometry, record.targetSmallID, record.actionTick);
    if (!nativeGeometry) throw new Error("Invalid attack target geometry evidence");
    if (!bounded(record.features, dimensionsFor(snapshot).target) || !bounded(record.gate, gate.length)) throw new Error("Invalid attack raw features");
    if (record.features.slice(0, gate.length).some((value, i) => value !== record.gate[i]) ||
        record.features.slice(9, 13).some((value, i) => value !== nativeGeometry.features[i])) {
      throw new Error("Attack raw geometry/features disagree");
    }
    if (snapshot.schema === frontierSchema) {
      const frontier = frontierFeatures(record.geometry.frontier, {
        actorSmallID: record.actorSmallID, targetSmallID: record.targetSmallID,
        tick: record.actionTick, generation: record.generation });
      if (!frontier || record.features.slice(13).some((value, i) => value !== frontier.features[i])) {
        throw new Error("Attack raw frontier/features disagree");
      }
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

  function offlineActorContext(snapshot, context) {
    return snapshot.schema === frontierSchema ? { actorSmallID: context.actorSmallID } : {};
  }

  function fitOffline(snapshot, records, context = {}) {
    validate(snapshot);
    if (snapshot.reward === "discounted-terminal-win-return-v1") throw new Error("Terminal return model requires episode fitter");
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
      ...offlineActorContext(snapshot, context),
      ablation: clone(ablation), gammaTick: ablation.potentialShaping ? gammaTick : null,
      discountContract: ablation.potentialShaping ? "elapsed-action-outcome-ticks-v1" : null, potentialID: potentialID ?? null };
    if (ablation.potentialShaping) output.reward = "potential-shaped-land-delta-ticks-v2";
    validate(output);
    const { models, ...metadata } = output;
    return { model: { ...metadata, models }, summary: { fitted, anchors, censored, dropped: records.length - selected.length,
      retained: selected.length, complete: records.length === selected.length, performanceClaim: false } };
  }

  function validateDecisionCoverage(steps, coverage) {
    if (!Array.isArray(steps) || steps.length === 0 || !steps.every((step, i) =>
        exactID(step) && (i === 0 || step > steps[i - 1]))) throw new Error("Invalid original decision steps");
    if (coverage === undefined) {
      if (steps.some((step, i) => i > 0 && step !== steps[i - 1] + 1)) throw new Error("Missing excluded decision coverage");
      return;
    }
    validateCoverageHeader(steps, coverage);
    const seen = new Set(steps);
    for (const excluded of coverage.excluded) {
      if (!exactID(excluded?.decisionStep) || typeof excluded.reason !== "string" || !excluded.reason.trim() ||
          seen.has(excluded.decisionStep)) throw new Error("Invalid declared decision exclusion");
      seen.add(excluded.decisionStep);
    }
    if ([...seen].some((step) => step >= coverage.decisionCount)) throw new Error("Incomplete decision coverage partition");
  }

  function validateCoverageHeader(steps, coverage) {
    if (coverage?.version !== "explicit-exclusions-complete-ledger-v1" ||
        !/^[0-9a-f]{64}$/.test(coverage.ledgerHash || "") || !exactID(coverage.decisionCount) ||
        !Array.isArray(coverage.excluded) || coverage.decisionCount !== steps.length + coverage.excluded.length) {
      throw new Error("Invalid complete decision coverage");
    }
  }

  function validateConditionalTribeReturn(snapshot, context, record) {
    if (!conditionalTribeProfile(snapshot.controlProfile)) return;
    if (context?.gammaTick !== 1) throw new Error("Conditional tribe terminal objective requires gammaTick 1");
    if (record !== undefined && (record?.action !== "attack" || record?.controlledAction !== "attack" ||
        record?.behaviorPolicy !== "deterministic-native-tribe-choice-v1")) throw new Error("Invalid conditional tribe return record");
  }

  function validateReturnContext(snapshot, context, identityRequired) {
    validateConditionalTribeReturn(snapshot, context);
    if (!context || !/^[0-9a-f]{40}$/.test(context.engineRevision || "") ||
        ![context.configHash, context.resultHash].every((hash) => /^[0-9a-f]{64}$/.test(hash || "")) ||
        ![context.experimentID, context.runID, ...(identityRequired !== false ? [context.modelIdentity] : [])].every((value) => typeof value === "string" && value.trim()) ||
        ![context.episodeId, context.generation, context.terminalTick, context.actorSmallID].every(exactID) ||
        typeof context.terminalWin !== "boolean" || !Number.isFinite(context.gammaTick) ||
        context.gammaTick < 0 || context.gammaTick > 1 || context.featureProfile !== snapshot.featureProfile ||
        context.truncated === true || context.error != null) throw new Error("Invalid terminal return context");
  }

  function validateReturnRecord(snapshot, record, context) {
    validateConditionalTribeReturn(snapshot, context, record);
    if (!record || !["engineRevision", "experimentID", "runID", "configHash", "episodeId", "generation", "modelIdentity", "actorSmallID"].every((key) => record[key] === context[key]) ||
        record.featureVersion !== snapshot.schema || JSON.stringify(record.normalizer) !== JSON.stringify(snapshot.normalizer) ||
        record.learned !== true || record.confirmed !== true || record.truncated !== false || record.error != null ||
        typeof record.terminal !== "boolean" || !["wait", "attack"].includes(record.action)) throw new Error("Invalid controlled return record");
  }

  function validateReturnTiming(record, previous, terminalTick) {
    if (!exactID(record.decisionStep) || (previous && record.decisionStep <= previous.decisionStep) ||
        ![record.actionTick, record.outcomeTick].every(exactID) || record.outcomeTick < record.actionTick ||
        record.outcomeTick > terminalTick || (previous && record.actionTick < previous.actionTick)) throw new Error("Invalid controlled return timing");
  }

  function prepareReturnRecords(snapshot, records, context) {
    validateReturnContext(snapshot, context);
    if (context.modelIdentity !== JSON.stringify(snapshot) ||
        !Array.isArray(records) || records.length === 0) throw new Error("Invalid terminal return origin/records");
    const originalDecisionSteps = records.map((record) => record?.decisionStep);
    validateDecisionCoverage(originalDecisionSteps, context.coverage);
    const seenReceipts = new Set();
    const prepared = records.map((record, i) => {
      validateReturnRecord(snapshot, record, context);
      validateReturnTiming(record, records[i - 1], context.terminalTick);
      if (record.action === "wait") {
        if (record.targetSmallID !== null || record.controlledAction !== "wait") throw new Error("Invalid controlled WAIT evidence");
      } else {
        if (record.controlledAction !== "attack" || !exactID(record.targetSmallID) ||
            record.targetSmallID === context.actorSmallID) throw new Error("Invalid controlled ACT evidence");
        validateAttackEvidence(record, snapshot);
        if (seenReceipts.has(record.receiptID)) throw new Error("Duplicate native receipt");
        seenReceipts.add(record.receiptID);
      }
      const name = record.action === "wait" ? "wait" : "act";
      const values = normalize(record.gate, name, snapshot);
      const examples = [[name, values]];
      if (name === "act") examples.push(["target", normalize(record.features, "target", snapshot)]);
      if (examples.some(([, input]) => input === null)) throw new Error("Invalid normalized return input");
      const timing = temporalDiscount({ gammaTick: context.gammaTick, actionTick: record.actionTick, outcomeTick: context.terminalTick });
      const label = (context.terminalWin ? 1 : -1) * timing.discount;
      return { examples, transition: { anchor: false, shaped: label } };
    });
    return { prepared, originalDecisionSteps };
  }

  function batchEpisodeKey(context) {
    return JSON.stringify([context.runID, context.episodeId, context.generation, context.actorSmallID]);
  }

  function validateBatchContexts(snapshot, contexts) {
    if (!conditionalTribeProfile(snapshot.controlProfile) || !Array.isArray(contexts) || !contexts.length) throw new Error("Invalid conditional return batch");
    const seen = new Set();
    for (const context of contexts) {
      validateReturnContext(snapshot, context, false);
      const key = batchEpisodeKey(context);
      if (seen.has(key)) throw new Error("Duplicate batch episode context");
      seen.add(key);
      if (["engineRevision", "experimentID", "configHash", "featureProfile"].some(name => context[name] !== contexts[0][name])) throw new Error("Mixed batch native context");
    }
  }

  function validateBatchProvenance(snapshot, origin) {
    const offline = snapshot.offline;
    validateBatchContexts(snapshot, offline.episodes);
    let total = 0;
    for (const context of offline.episodes) total += validateBatchEpisodeProvenance(context);
    if (offline.fittedRecords !== total || offline.headUpdates?.wait !== 0 || offline.headUpdates?.act !== total || offline.headUpdates?.target !== total ||
        JSON.stringify(snapshot.models.wait) !== JSON.stringify(origin.models.wait)) throw new Error("Invalid batch aggregate counts");
  }

  function validateBatchEpisodeProvenance(context) {
    if ("modelIdentity" in context || "originModelIdentity" in context || "originModel" in context) throw new Error("Repeated batch origin identity");
    validateDecisionCoverage(context.originalDecisionSteps, context.coverage);
    if (!exactID(context.fittedRecords) || context.fittedRecords < 1 || context.originalDecisionSteps.length !== context.fittedRecords) throw new Error("Invalid batch episode counts");
    return context.fittedRecords;
  }

  function validateBatchReceipts(episodes) {
    const seen = new Set();
    for (const episode of episodes) for (const record of episode.records) {
      const key = JSON.stringify([episode.context.runID, record.receiptID]);
      if (seen.has(key)) throw new Error("Duplicate batch native receipt within run");
      seen.add(key);
    }
  }

  function fitEpisodeBatchReturns(snapshot, episodes) {
    validate(snapshot);
    if (!Array.isArray(episodes) || !episodes.length) throw new Error("Empty return batch");
    validateBatchContexts(snapshot, episodes.map(episode => episode.context));
    // Prepare every episode before cloning/updating; input identities stay exact.
    const prepared = episodes.map(episode => prepareReturnRecords(snapshot, episode.records, episode.context));
    validateBatchReceipts(episodes);
    const output = clone(snapshot);
    for (const episode of prepared) for (const example of episode.prepared) fitRecord(output, example);
    const fittedRecords = prepared.reduce((sum, episode) => sum + episode.prepared.length, 0);
    const contexts = episodes.map((episode, index) => {
      const context = episode.context;
      return { engineRevision: context.engineRevision, experimentID: context.experimentID, runID: context.runID,
        configHash: context.configHash, episodeId: context.episodeId, generation: context.generation,
        actorSmallID: context.actorSmallID, featureProfile: context.featureProfile, gammaTick: context.gammaTick,
        terminalTick: context.terminalTick, terminalWin: context.terminalWin, resultHash: context.resultHash,
        fittedRecords: prepared[index].prepared.length, originalDecisionSteps: clone(prepared[index].originalDecisionSteps),
        ...(context.coverage === undefined ? {} : { coverage: clone(context.coverage) }) };
    });
    output.reward = "discounted-terminal-win-return-v1";
    output.offline = { version: "offline-terminal-return-batch-v1", originModel: clone(snapshot),
      returnTrainer: "monte-carlo-tanh-sgd-v1", episodes: contexts, fittedRecords,
      headUpdates: { wait: 0, act: fittedRecords, target: fittedRecords } };
    validate(output);
    return { model: output, summary: { fitted: fittedRecords, updates: fittedRecords * 2,
      episodes: episodes.length, censored: 0, complete: true, performanceClaim: false } };
  }

  // Monte Carlo evaluation of observed controlled actions; native winner and
  // ledger-reference verification belong to the trajectory validator upstream.
  function fitEpisodeReturns(snapshot, records, context = {}) {
    validate(snapshot);
    const { prepared, originalDecisionSteps } = prepareReturnRecords(snapshot, records, context);
    const output = clone(snapshot);
    for (const example of prepared) fitRecord(output, example);
    const headUpdates = Object.fromEntries(Object.keys(output.models).map((name) =>
      [name, output.models[name].samples - snapshot.models[name].samples]));
    output.reward = "discounted-terminal-win-return-v1";
    output.offline = { version: "offline-terminal-return-v2", engineRevision: context.engineRevision,
      experimentID: context.experimentID, runID: context.runID, configHash: context.configHash,
      episodeId: context.episodeId, generation: context.generation, actorSmallID: context.actorSmallID,
      originModel: clone(snapshot),
      featureProfile: snapshot.featureProfile, gammaTick: context.gammaTick,
      terminalTick: context.terminalTick, terminalWin: context.terminalWin, resultHash: context.resultHash,
      returnTrainer: "monte-carlo-tanh-sgd-v1", fittedRecords: prepared.length, headUpdates,
      originalDecisionSteps: clone(originalDecisionSteps),
      ...(context.coverage === undefined ? {} : { coverage: clone(context.coverage) }) };
    validate(output);
    return { model: output, summary: { fitted: prepared.length, updates: prepared.reduce((sum, row) => sum + row.examples.length, 0),
      censored: 0, complete: true, performanceClaim: false } };
  }

  function learningAllowed(snapshot) {
    validate(snapshot);
    return snapshot.reward !== "discounted-terminal-win-return-v1";
  }

  Object.assign(HybridCombatContract, { schema, frontierSchema, learningAllowed, features: clone(features), dimensions: clone(dimensions), create,
    featuresFor, dimensionsFor, frontierFeatures, validate, validateHead, normalize, forward, update, geometry, exactID, offlineTransition, fitOffline, fitEpisodeReturns, fitEpisodeBatchReturns, freezeMetadata });
  Object.freeze(HybridCombatContract);
}
