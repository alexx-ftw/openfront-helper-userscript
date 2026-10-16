import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
// Only fixed repository classic source is evaluated in isolated test realms.
/* eslint-disable sonarjs/code-eval */

const contractPath = new URL("../engine/ingame/auto-bot/hybridModelContract.js", import.meta.url);
function load(source) {
  const realm = vm.createContext({});
  vm.runInContext(source, realm);
  return vm.runInContext("HybridCombatContract", realm);
}
const C = load(fs.readFileSync(contractPath, "utf8"));
const json = (value) => JSON.parse(JSON.stringify(value));
const original = load(
  execFileSync(
    "/usr/bin/git",
    [
      "show",
      "3e2492953280d6846e9e4a26f234852a2ecb15c1:engine/ingame/auto-bot/hybridModelContract.js",
    ],
    { encoding: "utf8" },
  ),
);
const v2 = original.create();
assert.equal(JSON.stringify(C.create()), JSON.stringify(v2), "default v2 snapshot unchanged");
const identity = JSON.stringify(v2);
C.validate(v2);
assert.equal(JSON.stringify(v2), identity, "import validation preserves original identity");
assert.deepEqual(json(C.dimensionsFor(v2)), { wait: 4, act: 4, target: 13 });
assert.deepEqual(json(C.normalize(Array(13).fill(0), "target", v2.normalizer)), Array(13).fill(0));
const v3 = C.create({ featureProfile: "frontier-v1" });
assert.equal(
  createHash("sha256").update(JSON.stringify(v3)).digest("hex"),
  "fa1a80c213da255337f15cab6950b92f34adc03185316e2f39b38b489f929861",
  "default v3 factory bytes remain unchanged",
);
assert.deepEqual(json(C.dimensionsFor(v3)), { wait: 4, act: 4, target: 17 });
assert.deepEqual(json(C.featuresFor(v3).target.slice(13)), [
  "sharedFrontierRatio",
  "incomingFromTargetRatio",
  "frontierPresent",
  "incomingFromTargetPresent",
]);
assert.notEqual(JSON.stringify(v3), identity);
assert.equal(C.frontierSchema, v3.schema);
assert.equal(C.schema, v2.schema);
assert.equal(C.learningAllowed(v2), true);
assert.equal(C.learningAllowed(v3), true);
assert.throws(() => C.learningAllowed({ ...v3, reward: "unknown" }));
assert.equal(v3.provenance.featureVersion, v3.schema);
assert.equal(v3.normalizer.version, "fixed-normalizer-frontier-v1");
assert.ok(
  Object.values(v3.models).every(
    (head) => head.samples === 0 && head.output.every((value) => value === 0),
  ),
);
assert.deepEqual(json(C.normalize(Array(17).fill(0), "target", v3)), Array(17).fill(0));
assert.throws(() => C.normalize(Array(13).fill(0), "target", v3));
assert.throws(() => C.validate({ ...v3, features: v2.features }));
assert.throws(() => C.validate({ ...v3, normalizer: v2.normalizer }));
assert.throws(() => C.validate({ ...v3, provenance: v2.provenance }));
assert.throws(() => C.create({ featureProfile: "unknown" }));
const expected = { actorSmallID: 1, targetSmallID: 2, tick: 10, generation: 3 };
const controlled = C.create({ featureProfile: "frontier-v1", controlProfile: "target-value-v1" });
assert.equal(controlled.controlProfile, "target-value-v1");
assert.equal(controlled.actions.macroValue, "best-target-vs-wait-v1");
for (const base of [C.create(), v3]) {
  const profiled = C.create({
    featureProfile: base.featureProfile,
    controlProfile: "target-value-v1",
  });
  const defaultShape = json(profiled);
  delete defaultShape.controlProfile;
  delete defaultShape.actions.macroValue;
  assert.equal(JSON.stringify(defaultShape), JSON.stringify(base), "only control identity changes");
  C.validate(profiled);
  assert.throws(() => C.validate({ ...profiled, controlProfile: "unknown" }));
  assert.throws(() => C.validate({ ...profiled, controlProfile: undefined }));
  assert.throws(() => C.validate({ ...profiled, actions: base.actions }));
  assert.throws(() => C.validate({ ...base, actions: profiled.actions }));
}
assert.throws(() => C.create({ controlProfile: "unknown" }));

const raw = {
  source: "native-target-frontier-v1",
  ...expected,
  ownBorderCount: 4,
  sharedFrontierCount: 2,
  ownMaxTroops: 100,
  incomingFromTargetTroops: 20,
};
const extract = (value = raw, context = expected) => C.frontierFeatures(value, context);
assert.deepEqual(json(extract().features), [0.5, 0.2, 1, 1]);
assert.notDeepEqual(
  json(extract().features),
  json(extract({ ...raw, sharedFrontierCount: 1 }).features),
  "equal centroid/army with different exact frontiers differs",
);
assert.deepEqual(
  json(extract({ ...raw, sharedFrontierCount: 0, incomingFromTargetTroops: 0 }).features),
  [0, 0, 1, 1],
);
assert.deepEqual(
  json(
    extract({
      ...raw,
      ownBorderCount: null,
      sharedFrontierCount: null,
      ownMaxTroops: null,
      incomingFromTargetTroops: null,
    }).features,
  ),
  [0, 0, 0, 0],
);
assert.deepEqual(json(extract({ ...raw, incomingFromTargetTroops: 200 }).features), [0.5, 1, 1, 1]);
for (const key of ["actorSmallID", "targetSmallID", "tick", "generation"]) {
  assert.equal(extract(raw, { ...expected, [key]: expected[key] + 1 }), null, key);
  assert.equal(extract({ ...raw, [key]: NaN }), null, key);
}
for (const patch of [
  { source: "centroid" },
  { actorSmallID: 2 },
  { ownBorderCount: 0 },
  { sharedFrontierCount: 5 },
  { sharedFrontierCount: -1 },
  { sharedFrontierCount: 1.5 },
  { sharedFrontierCount: null },
  { ownBorderCount: undefined },
  { ownMaxTroops: 0 },
  { ownMaxTroops: Infinity },
  { incomingFromTargetTroops: -1 },
  { incomingFromTargetTroops: NaN },
  { incomingFromTargetTroops: null },
]) {
  assert.equal(extract({ ...raw, ...patch }), null, JSON.stringify(patch));
}
const geometry = {
  source: "native-border-centroid-v1",
  targetSmallID: 2,
  tick: 10,
  width: 10,
  height: 10,
  own: { x: 1, y: 1 },
  target: { x: 2, y: 2 },
  frontier: raw,
};
const gate = [1, 0.5, 0.2, 0.2];
const features = [
  ...gate,
  0.1,
  0.2,
  0.5,
  0.2,
  0.1,
  ...C.geometry(geometry, 2, 10).features,
  ...extract().features,
];
const context = {
  engineRevision: "a".repeat(40),
  experimentID: "frontier-test",
  generation: 3,
  episodeId: 1,
  actorSmallID: 1,
  normalizer: v3.normalizer,
  ablation: { version: "patient-potential-v1", patientAnchors: false, potentialShaping: false },
};
const record = {
  ...context,
  featureVersion: v3.schema,
  modelIdentity: JSON.stringify(v3),
  action: "attack",
  actorSmallID: 1,
  targetSmallID: 2,
  actionTick: 10,
  outcomeTick: 12,
  terminal: false,
  truncated: false,
  confirmed: true,
  reward: 0.5,
  receiptID: "native-receipt",
  gate,
  nextGate: gate,
  features,
  geometry,
};
const before = JSON.stringify(v3);
const fit = C.fitOffline(v3, [record], context);
assert.equal(JSON.stringify(v3), before, "fit never mutates original snapshot");
assert.equal(fit.model.models.act.samples, 1);
assert.equal(fit.model.models.target.samples, 1);
assert.equal(fit.model.models.wait.samples, 0);
C.validate(fit.model);
const controlledFit = C.fitOffline(
  controlled,
  [{ ...record, modelIdentity: JSON.stringify(controlled) }],
  context,
);
assert.equal(controlledFit.model.controlProfile, controlled.controlProfile);
assert.deepEqual(json(controlledFit.model.actions), json(controlled.actions));
C.validate(controlledFit.model);
const shapedContext = {
  ...context,
  gammaTick: 0.9,
  potentialID: "land-share",
  ablation: { ...context.ablation, potentialShaping: true },
};
const shaped = C.fitOffline(v3, [{ ...record, potential: 0.2, nextPotential: 0.3 }], shapedContext);
assert.equal(shaped.model.reward, "potential-shaped-land-delta-ticks-v2");
C.validate(shaped.model);
assert.throws(() => C.fitOffline(v3, [record], { ...context, actorSmallID: 8 }));
assert.throws(() => C.fitOffline(v3, [record], { ...context, actorSmallID: undefined }));
for (const patch of [
  { modelIdentity: identity },
  { featureVersion: v2.schema },
  { receiptID: "" },
  { actorSmallID: 7 },
  { geometry: { ...geometry, tick: 9 } },
  { geometry: { ...geometry, frontier: { ...raw, generation: 2 } } },
  { geometry: { ...geometry, frontier: { ...raw, sharedFrontierCount: 1 } } },
  { geometry: { ...geometry, frontier: { ...raw, ownMaxTroops: 0 } } },
]) {
  assert.throws(() => C.fitOffline(v3, [{ ...record, ...patch }], context));
  assert.equal(JSON.stringify(v3), before);
}
const replayV2 = {
  ...record,
  featureVersion: v2.schema,
  modelIdentity: identity,
  normalizer: v2.normalizer,
  features: features.slice(0, 13),
};
assert.equal(
  C.fitOffline(v2, [replayV2], { ...context, normalizer: v2.normalizer }).summary.fitted,
  1,
);

// Exercise the actual repository adapter with client-shaped native snapshots.
const realm = vm.createContext({});
vm.runInContext(
  fs.readFileSync(new URL("../engine/ingame/auto-bot/gameApi.js", import.meta.url), "utf8"),
  realm,
);
const createGameApi = vm.runInContext("createGameApi", realm);
const players = [1, 2, 3].map((sid) => ({
  isPlayer: () => true,
  smallID: () => sid,
  id: () => String(sid),
  borderTiles: () => new Set([0, 1, 2, 3]),
  incomingAttacks: () =>
    sid === 1
      ? [
          { attackerID: 2, targetID: 1, troops: 20 },
          { attackerID: 3, targetID: 1, troops: 70 },
        ]
      : [],
}));
const src = {
  ticks: () => 10,
  players: () => players,
  playerBySmallID: (sid) => players.find((player) => player.smallID() === sid),
  config: () => ({ maxTroops: () => 100 }),
  neighbors: (tile) => (tile < 2 ? [4, 5] : [6]),
  ownerID: (tile) => (tile < 6 ? 2 : 3),
};
const native = createGameApi(src).game;
const actor = native.playerBySmallID(1);
const border = await actor.__src.borderTiles();
const captureNative = () => ({
  ...raw,
  ownBorderCount: border.size,
  sharedFrontierCount: [...border].filter((tile) =>
    native.neighbors(tile).some((neighbor) => native.ownerID(neighbor) === 2),
  ).length,
  ownMaxTroops: actor.maxTroops(),
  incomingFromTargetTroops: actor
    .incomingAttacks()
    .filter((attack) => attack.attacker().smallID() === 2 && attack.target().smallID() === 1)
    .reduce((sum, attack) => sum + attack.troops(), 0),
});
const nativeRaw = captureNative();
assert.deepEqual(json(extract(nativeRaw).features), [0.5, 0.2, 1, 1]);
players.reverse();
assert.deepEqual(json(extract(captureNative()).features), [0.5, 0.2, 1, 1]);
process.stdout.write(
  "hybrid frontier contract: v2 compatibility, v3 dispatch, exact raw replay, stale context and real gameApi VM passed\n",
);

// Episode return fitting uses the actual compact optimizer and original identity.
for (const base of [v2, v3, controlled]) {
  const returnContext = {
    ...context,
    normalizer: base.normalizer,
    modelIdentity: JSON.stringify(base),
    runID: "verified-native-run",
    configHash: "b".repeat(64),
    resultHash: "c".repeat(64),
    gammaTick: 0.5,
    terminalTick: 14,
    terminalWin: true,
    featureProfile: base.featureProfile,
  };
  const rows = [
    {
      ...record,
      ...returnContext,
      featureVersion: base.schema,
      action: "wait",
      controlledAction: "wait",
      learned: true,
      targetSmallID: null,
      decisionStep: 5,
      actionTick: 10,
      outcomeTick: 11,
      features: null,
      geometry: null,
      receiptID: null,
      return: -1,
    },
    {
      ...record,
      ...returnContext,
      featureVersion: base.schema,
      controlledAction: "attack",
      learned: true,
      decisionStep: 6,
      actionTick: 12,
      outcomeTick: 13,
      features: base.schema === v2.schema ? features.slice(0, 13) : features,
      geometry: { ...geometry, tick: 12, frontier: { ...raw, tick: 12 } },
      return: -1,
    },
  ];
  const originalIdentity = JSON.stringify(base);
  const result = C.fitEpisodeReturns(base, rows, returnContext);
  // Synthetic independent episodes exercise provenance growth, not native efficacy.
  let chained = base;
  const chainedSizes = [];
  for (let generation = 0; generation < 4; generation++) {
    const context = {
      ...returnContext,
      runID: `${returnContext.runID}-chain-${generation}`,
      modelIdentity: JSON.stringify(chained),
    };
    const records = rows.map((row) => ({ ...row, ...context }));
    chained = C.fitEpisodeReturns(chained, records, context).model;
    assert.equal(JSON.stringify(chained.offline.originModel), context.modelIdentity);
    chainedSizes.push(Buffer.byteLength(JSON.stringify(chained)));
  }
  assert.ok(
    chainedSizes[3] - chainedSizes[2] <= (chainedSizes[1] - chainedSizes[0]) * 1.5,
    `four return fits must retain one origin chain, not duplicate escaped ancestry: ${chainedSizes}`,
  );
  assert.equal(JSON.stringify(base), originalIdentity);
  assert.equal(result.summary.fitted, 2);
  assert.equal(result.summary.updates, 3);
  assert.equal(result.model.models.wait.samples, base.models.wait.samples + 1);
  assert.equal(result.model.models.act.samples, base.models.act.samples + 1);
  assert.equal(result.model.models.target.samples, base.models.target.samples + 1);
  for (const [name, input, label] of [
    ["wait", gate, 1 / 16],
    ["act", gate, 1 / 4],
    ["target", rows[1].features, 1 / 4],
  ]) {
    const expectedHead = C.update(
      base.models[name],
      C.normalize(input, name, base),
      label,
      base.normalizer[name === "target" ? "target" : "gate"],
    );
    assert.deepEqual(
      json(result.model.models[name]),
      json(expectedHead),
      "actual native SGD receives calculated elapsed return",
    );
  }
  assert.equal(result.model.reward, "discounted-terminal-win-return-v1");
  assert.equal(C.learningAllowed(result.model), false);
  assert.equal(result.model.offline.version, "offline-terminal-return-v2");
  assert.equal(JSON.stringify(result.model.offline.originModel), originalIdentity);
  assert.equal(result.model.offline.returnTrainer, "monte-carlo-tanh-sgd-v1");
  C.validate(json(result.model));
  const legacyReturn = json(result.model);
  delete legacyReturn.offline.originModel;
  Object.assign(legacyReturn.offline, {
    version: "offline-terminal-return-v1",
    modelIdentity: originalIdentity,
    originModelIdentity: originalIdentity,
  });
  C.validate(legacyReturn);
  assert.equal(C.learningAllowed(legacyReturn), false);
  const legacyIdentity = JSON.stringify(legacyReturn);
  const mixedContext = {
    ...returnContext,
    runID: "mixed-legacy-return",
    modelIdentity: legacyIdentity,
  };
  const mixed = C.fitEpisodeReturns(
    legacyReturn,
    rows.map((row) => ({ ...row, ...mixedContext })),
    mixedContext,
  );
  assert.equal(JSON.stringify(legacyReturn), legacyIdentity);
  assert.equal(JSON.stringify(mixed.model.offline.originModel), legacyIdentity);
  C.validate(json(mixed.model));
  for (const originModel of [null, [], "{}", { ...base, schema: "unknown" }]) {
    assert.throws(() =>
      C.validate({ ...result.model, offline: { ...result.model.offline, originModel } }),
    );
  }
  assert.throws(() =>
    C.validate({
      ...result.model,
      offline: { ...result.model.offline, modelIdentity: originalIdentity },
    }),
  );
  const badOriginCounts = json(result.model);
  badOriginCounts.offline.originModel.models.wait.samples++;
  assert.throws(() => C.validate(badOriginCounts));
  assert.throws(() =>
    C.validate({
      ...legacyReturn,
      offline: { ...legacyReturn.offline, modelIdentity: "{}" },
    }),
  );
  assert.equal(result.model.controlProfile, base.controlProfile);
  assert.deepEqual(json(result.model.actions), json(base.actions));
  if (base.controlProfile) {
    const dropped = json(result.model);
    delete dropped.controlProfile;
    delete dropped.actions.macroValue;
    assert.throws(() => C.validate(dropped), /origin contract/);
  }
  assert.throws(() =>
    C.validate({
      ...result.model,
      models: {
        ...result.model.models,
        wait: { ...result.model.models.wait, samples: result.model.models.wait.samples + 1 },
      },
    }),
  );
  const nextContext = { ...returnContext, modelIdentity: JSON.stringify(result.model) };
  const nextRows = rows.map((row) => ({ ...row, modelIdentity: nextContext.modelIdentity }));
  const refit = C.fitEpisodeReturns(result.model, nextRows, nextContext);
  assert.equal(refit.model.models.wait.samples, result.model.models.wait.samples + 1);
  C.validate(json(refit.model));
  assert.throws(() => C.fitOffline(result.model, [], context));
  const loss = C.fitEpisodeReturns(base, rows, { ...returnContext, terminalWin: false });
  assert.ok(
    C.forward(loss.model.models.wait, C.normalize(gate, "wait", loss.model)).prediction < 0,
  );
  for (const patch of [
    { gammaTick: -1 },
    { gammaTick: 1.1 },
    { gammaTick: NaN },
    { terminalWin: null },
    { terminalTick: 9 },
    { resultHash: "unknown" },
    { configHash: "unknown" },
    { modelIdentity: "{}" },
    { truncated: true },
    { error: "cap" },
    { featureProfile: "foreign" },
  ]) {
    assert.throws(() => C.fitEpisodeReturns(base, rows, { ...returnContext, ...patch }));
    assert.equal(JSON.stringify(base), originalIdentity);
  }
  for (const patch of [
    { learned: false },
    { confirmed: false },
    { controlledAction: null },
    { configHash: "d".repeat(64) },
    { runID: "another-run" },
    { generation: 4 },
    { episodeId: 2 },
    { modelIdentity: "{}" },
    { gate: [1, Infinity, 0, 0] },
    { actionTick: 12.5 },
    { outcomeTick: 15 },
    { truncated: true },
    { error: "unknown" },
  ]) {
    assert.throws(() =>
      C.fitEpisodeReturns(base, [{ ...rows[0], ...patch }, rows[1]], returnContext),
    );
    assert.equal(JSON.stringify(base), originalIdentity);
  }
  assert.throws(() =>
    C.fitEpisodeReturns(base, [rows[0], { ...rows[1], decisionStep: 8 }], returnContext),
  );
  assert.throws(() => C.fitEpisodeReturns(base, [rows[1], rows[1]], returnContext));
  assert.throws(() =>
    C.fitEpisodeReturns(base, [rows[0], { ...rows[1], receiptID: "" }], returnContext),
  );
  assert.throws(() =>
    C.validate({
      ...result.model,
      offline: { ...result.model.offline, originModelIdentity: "{}" },
    }),
  );
  assert.throws(() =>
    C.validate({ ...result.model, offline: { ...result.model.offline, returnTrainer: "PPO" } }),
  );
  assert.throws(() => C.validate({ ...base, reward: "discounted-terminal-win-return-v1" }));
}
process.stdout.write(
  "episode return helper: actual v2/v3 SGD, elapsed win/loss, import provenance and atomic rejection passed\n",
);

// Known exclusions retain original steps; unknown missing ledger rows stay rejected.
for (const base of [v2, v3, controlled]) {
  const ctx = {
    ...context,
    modelIdentity: JSON.stringify(base),
    runID: "coverage-run",
    configHash: "b".repeat(64),
    resultHash: "c".repeat(64),
    gammaTick: 0.9,
    terminalTick: 14,
    terminalWin: true,
    featureProfile: base.featureProfile,
  };
  const row = {
    ...record,
    ...ctx,
    featureVersion: base.schema,
    normalizer: base.normalizer,
    action: "wait",
    controlledAction: "wait",
    targetSmallID: null,
    learned: true,
    features: null,
    geometry: null,
    receiptID: null,
  };
  const rows = [
    { ...row, decisionStep: 0 },
    { ...row, decisionStep: 2, actionTick: 12, outcomeTick: 13 },
  ];
  const coverage = {
    version: "explicit-exclusions-complete-ledger-v1",
    ledgerHash: "d".repeat(64),
    decisionCount: 3,
    excluded: [{ decisionStep: 1, reason: "unconfirmed-attack" }],
  };
  const frozen = JSON.stringify(base);
  const fitted = C.fitEpisodeReturns(base, rows, { ...ctx, coverage });
  assert.deepEqual(json(fitted.model.offline.originalDecisionSteps), [0, 2]);
  assert.deepEqual(json(fitted.model.offline.coverage), coverage);
  assert.equal(fitted.model.models.wait.samples, base.models.wait.samples + 2);
  assert.equal(fitted.model.models.act.samples, base.models.act.samples);
  assert.equal(fitted.summary.updates, 2);
  C.validate(json(fitted.model));
  assert.equal(JSON.stringify(base), frozen);
  assert.throws(() => C.fitEpisodeReturns(base, rows, ctx), /coverage/);
  for (const badCoverage of [
    { ...coverage, ledgerHash: "unknown" },
    { ...coverage, version: "unknown" },
    { ...coverage, decisionCount: 4 },
    { ...coverage, excluded: [] },
    { ...coverage, excluded: [{ decisionStep: 0, reason: "fallback" }] },
    { ...coverage, excluded: [{ decisionStep: 3, reason: "fallback" }] },
    { ...coverage, excluded: [{ decisionStep: 1, reason: " " }] },
    { ...coverage, decisionCount: 4, excluded: [coverage.excluded[0], coverage.excluded[0]] },
  ]) {
    assert.throws(() => C.fitEpisodeReturns(base, rows, { ...ctx, coverage: badCoverage }));
    assert.throws(() =>
      C.validate({ ...fitted.model, offline: { ...fitted.model.offline, coverage: badCoverage } }),
    );
    assert.equal(JSON.stringify(base), frozen);
  }
  for (const badSteps of [[2, 0], [0, 0], [0, 3], [0], null]) {
    assert.throws(() =>
      C.validate({
        ...fitted.model,
        offline: { ...fitted.model.offline, originalDecisionSteps: badSteps },
      }),
    );
  }
  const withoutCoverage = { ...fitted.model.offline };
  delete withoutCoverage.coverage;
  assert.throws(() => C.validate({ ...fitted.model, offline: withoutCoverage }));
  const contiguous = C.fitEpisodeReturns(
    base,
    [
      { ...row, decisionStep: 5 },
      { ...row, decisionStep: 6 },
    ],
    ctx,
  );
  C.validate(contiguous.model);
  const legacyOffline = { ...contiguous.model.offline };
  delete legacyOffline.originalDecisionSteps;
  C.validate({ ...contiguous.model, offline: legacyOffline });
}
process.stdout.write(
  "decision coverage: declared gaps preserved, exact partition/import validation and atomic rejection passed\n",
);

// New conditional profile has no learned strategic macro authority.
const tribeOnly = C.create({
  featureProfile: "frontier-v1",
  controlProfile: "tribe-only-terminal-v1",
});
assert.deepEqual(json(tribeOnly.actions), {
  macro: [],
  micro: "exact-player-id-land-target",
  tribeRanking: "native-land-subset-v1",
  activeHeads: ["target"],
  inactiveHeads: ["wait", "act"],
  strategicMacro: "native-legendary-v1",
  suppressWait: false,
});
assert.throws(() => C.create({ controlProfile: "tribe-only-terminal-v1" }), /frontier/);
for (const actions of [
  { ...tribeOnly.actions, activeHeads: ["act", "target"] },
  { ...tribeOnly.actions, inactiveHeads: ["wait"] },
  { ...tribeOnly.actions, macro: ["wait", "act"] },
  { ...tribeOnly.actions, strategicMacro: "learned" },
  { ...tribeOnly.actions, suppressWait: true },
])
  assert.throws(() => C.validate({ ...tribeOnly, actions }));
assert.throws(() => C.validate({ ...tribeOnly, controlProfile: "tribe-ranking-v1" }));
const tribeOrigin = JSON.stringify(tribeOnly);
const tribeContext = {
  ...context,
  modelIdentity: tribeOrigin,
  runID: "conditional-tribe-return",
  configHash: "b".repeat(64),
  resultHash: "c".repeat(64),
  gammaTick: 1,
  terminalTick: 14,
  terminalWin: true,
  featureProfile: "frontier-v1",
};
const tribeRecord = {
  ...record,
  ...tribeContext,
  controlledAction: "attack",
  learned: true,
  behaviorPolicy: "deterministic-native-tribe-choice-v1",
  decisionStep: 0,
};
const tribeReturn = C.fitEpisodeReturns(tribeOnly, [tribeRecord], tribeContext);
assert.deepEqual(json(tribeReturn.model.offline.headUpdates), { wait: 0, act: 1, target: 1 });
assert.equal(tribeReturn.model.offline.version, "offline-terminal-return-v2");
assert.equal(JSON.stringify(tribeReturn.model.offline.originModel), tribeOrigin);
assert.equal(JSON.stringify(tribeOnly), tribeOrigin);
assert.deepEqual(json(tribeReturn.model.models.wait), json(tribeOnly.models.wait));
C.validate(json(tribeReturn.model));
for (const patch of [
  {
    action: "wait",
    controlledAction: "wait",
    targetSmallID: null,
    features: null,
    geometry: null,
    receiptID: null,
  },
  { behaviorPolicy: "deterministic-wait-act-ranked-target" },
  { behaviorPolicy: "legendary-unknown" },
  { behaviorPolicy: undefined },
]) {
  assert.throws(
    () => C.fitEpisodeReturns(tribeOnly, [{ ...tribeRecord, ...patch }], tribeContext),
    /tribe/,
  );
  assert.equal(JSON.stringify(tribeOnly), tribeOrigin);
}
assert.throws(() =>
  C.fitEpisodeReturns(tribeOnly, [tribeRecord], { ...tribeContext, gammaTick: 0.9 }),
);
const mixedTribeOrigin = json(tribeReturn.model);
mixedTribeOrigin.offline.originModel = C.create({
  featureProfile: "frontier-v1",
  controlProfile: "tribe-ranking-v1",
});
assert.throws(() => C.validate(mixedTribeOrigin), /origin contract/);
const restamped = json(tribeReturn.model);
restamped.controlProfile = "tribe-ranking-v1";
restamped.actions = mixedTribeOrigin.offline.originModel.actions;
assert.throws(() => C.validate(restamped), /origin contract/);
process.stdout.write(
  "conditional tribe terminal contract: metadata, native SGD and provenance rejection passed\n",
);

const batchEpisode = (runID, terminalWin = true) => {
  const ctx = { ...tribeContext, runID, terminalWin };
  return { context: ctx, records: [{ ...tribeRecord, ...ctx }] };
};
const batchSingle = C.fitEpisodeBatchReturns(tribeOnly, [batchEpisode(tribeContext.runID)]);
assert.deepEqual(json(batchSingle.model.models), json(tribeReturn.model.models));
assert.equal(batchSingle.model.offline.version, "offline-terminal-return-batch-v1");
assert.equal(JSON.stringify(batchSingle.model.offline.originModel), tribeOrigin);
assert.equal(batchSingle.model.offline.episodes[0].modelIdentity, undefined);
const mixedBatch = C.fitEpisodeBatchReturns(tribeOnly, [
  batchEpisode("batch-win"),
  batchEpisode("batch-loss", false),
]);
assert.deepEqual(json(mixedBatch.model.offline.headUpdates), { wait: 0, act: 2, target: 2 });
C.validate(json(mixedBatch.model));
for (const name of ["act", "target"]) {
  const input = name === "act" ? tribeRecord.gate : tribeRecord.features;
  let head = tribeOnly.models[name];
  for (const label of [1, -1])
    head = C.update(
      head,
      C.normalize(input, name, tribeOnly),
      label,
      tribeOnly.normalizer[name === "target" ? "target" : "gate"],
    );
  assert.deepEqual(json(mixedBatch.model.models[name]), json(head));
}
const losses = C.fitEpisodeBatchReturns(tribeOnly, [
  batchEpisode("loss-a", false),
  batchEpisode("loss-b", false),
]);
assert.ok(losses.model.models.target.outputBias < 0);
for (const patch of [
  (episodes) => episodes.push(json(episodes[0])),
  (episodes) => (episodes[1].context.modelIdentity = "{}"),
  (episodes) => (episodes[1].context.gammaTick = 0.9),
  (episodes) => (episodes[1].context.configHash = "d".repeat(64)),
  (episodes) => (episodes[1].records[0].behaviorPolicy = "legendary-unknown"),
  (episodes) => episodes[1].records.push(json(episodes[1].records[0])),
  (episodes) => (episodes[1].context.coverage = { version: "unknown" }),
]) {
  const episodes = [batchEpisode("valid-a"), batchEpisode("invalid-b")];
  patch(episodes);
  assert.throws(() => C.fitEpisodeBatchReturns(tribeOnly, episodes));
  assert.equal(JSON.stringify(tribeOnly), tribeOrigin);
}
assert.throws(() => C.fitEpisodeBatchReturns(v3, [batchEpisode("wrong-profile")]));
for (const patch of [
  (model) => model.offline.headUpdates.wait++,
  (model) => (model.offline.episodes[0].terminalWin = null),
  (model) => (model.offline.episodes[0].resultHash = "bad"),
  (model) => (model.offline.episodes[0].originalDecisionSteps = [2, 0]),
  (model) => (model.offline.episodes[0].modelIdentity = tribeOrigin),
  (model) => model.offline.episodes.push(json(model.offline.episodes[0])),
  (model) => (model.offline.originModel = v3),
]) {
  const tampered = json(mixedBatch.model);
  patch(tampered);
  assert.throws(() => C.validate(tampered));
}
const sizes = [1, 2, 4].map(
  (count) =>
    JSON.stringify(
      C.fitEpisodeBatchReturns(
        tribeOnly,
        Array.from({ length: count }, (_, i) => batchEpisode(`storage-${i}`)),
      ).model,
    ).length,
);
assert.ok(sizes[2] - sizes[1] <= 2.1 * (sizes[1] - sizes[0]));
assert.equal(JSON.stringify(tribeOnly), tribeOrigin);
process.stdout.write(
  "same-origin batch return contract: native SGD parity, atomic rejection and linear provenance passed\n",
);

// Receipt IDs may repeat across runs, never within one original run.
const sameRun = [batchEpisode("receipt-scope"), batchEpisode("receipt-scope")];
sameRun[1].context.episodeId = 2;
sameRun[1].records[0].episodeId = 2;
assert.throws(() => C.fitEpisodeBatchReturns(tribeOnly, sameRun), /receipt/);
const gapEpisode = batchEpisode("known-gap");
gapEpisode.records[0].decisionStep = 2;
gapEpisode.context.coverage = {
  version: "explicit-exclusions-complete-ledger-v1",
  ledgerHash: "d".repeat(64),
  decisionCount: 3,
  excluded: [
    { decisionStep: 0, reason: "fallback" },
    { decisionStep: 1, reason: "censored-busy-attack" },
  ],
};
const gapBatch = C.fitEpisodeBatchReturns(tribeOnly, [gapEpisode]);
assert.deepEqual(json(gapBatch.model.offline.episodes[0].originalDecisionSteps), [2]);
C.validate(json(gapBatch.model));
const badGapImport = json(gapBatch.model);
badGapImport.offline.episodes[0].coverage.excluded.pop();
assert.throws(() => C.validate(badGapImport));
const foreignActor = batchEpisode("foreign-actor");
foreignActor.context.actorSmallID = 9;
assert.throws(() => C.fitEpisodeBatchReturns(tribeOnly, [foreignActor]));
const changedOrder = C.fitEpisodeBatchReturns(tribeOnly, [
  batchEpisode("order-loss", false),
  batchEpisode("order-win"),
]);
assert.notDeepEqual(json(changedOrder.model.models.target), json(mixedBatch.model.models.target));
assert.deepEqual(
  json(
    C.fitEpisodeBatchReturns(tribeOnly, [
      batchEpisode("batch-win"),
      batchEpisode("batch-loss", false),
    ]),
  ),
  json(mixedBatch),
);

const funded = C.create({
  featureProfile: "frontier-v1",
  controlProfile: "funded-tribe-terminal-v1",
});
assert.deepEqual(json(funded.actions), {
  ...json(tribeOnly.actions),
  tribeRanking: "native-funded-land-subset-v1",
});
assert.deepEqual(json(funded.models), json(tribeOnly.models));
assert.deepEqual(json(funded.normalizer), json(tribeOnly.normalizer));
assert.throws(() => C.create({ controlProfile: "funded-tribe-terminal-v1" }), /frontier/);
const fundedIdentity = JSON.stringify(funded);
const fundedEpisode = (runID, terminalWin) => {
  const context = { ...tribeContext, modelIdentity: fundedIdentity, runID, terminalWin };
  return { context, records: [{ ...tribeRecord, ...context }] };
};
const fundedWin = fundedEpisode("funded-win", true);
const fundedSingle = C.fitEpisodeReturns(funded, fundedWin.records, fundedWin.context);
const fundedBatch = C.fitEpisodeBatchReturns(funded, [
  fundedWin,
  fundedEpisode("funded-loss", false),
]);
assert.deepEqual(json(fundedSingle.model.models), json(tribeReturn.model.models));
assert.deepEqual(json(fundedBatch.model.offline.headUpdates), { wait: 0, act: 2, target: 2 });
assert.deepEqual(json(fundedBatch.model.models.wait), json(funded.models.wait));
assert.equal(JSON.stringify(fundedBatch.model.offline.originModel), fundedIdentity);
assert.equal(JSON.stringify(funded), fundedIdentity);
C.validate(json(fundedSingle.model));
C.validate(json(fundedBatch.model));
for (const patch of [{ gammaTick: 0.9 }, { modelIdentity: tribeOrigin }])
  assert.throws(() =>
    C.fitEpisodeReturns(funded, fundedWin.records, { ...fundedWin.context, ...patch }),
  );
for (const patch of [
  { action: "wait", controlledAction: "wait" },
  { behaviorPolicy: null },
  { behaviorPolicy: "foreign" },
])
  assert.throws(() =>
    C.fitEpisodeBatchReturns(funded, [
      { ...fundedWin, records: [{ ...fundedWin.records[0], ...patch }] },
    ]),
  );
for (const patch of [
  { tribeRanking: "native-land-subset-v1" },
  { suppressWait: true },
  { activeHeads: ["act", "target"] },
])
  assert.throws(() => C.validate({ ...funded, actions: { ...funded.actions, ...patch } }));
const fundedTamper = json(fundedBatch.model);
fundedTamper.offline.originModel.controlProfile = "tribe-only-terminal-v1";
assert.throws(() => C.validate(fundedTamper));
assert.equal(C.learningAllowed(funded), true);
assert.equal(C.learningAllowed(fundedBatch.model), false);
process.stdout.write(
  "funded tribe terminal contract: metadata, native single/batch SGD and origin guards passed\n",
);
