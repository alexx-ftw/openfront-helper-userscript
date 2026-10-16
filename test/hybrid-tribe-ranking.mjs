import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createAttackBehaviorSandbox } from "./helpers/attack-behavior-sandbox.mjs";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";
import { ambiguousFixture, fixture, validateFixture } from "./hybrid-trajectory-contract.mjs";

// Only fixed repository classic scripts execute in this isolated fixture realm.
/* eslint-disable sonarjs/code-eval */
const realm = vm.createContext({
  window: {},
  state: { settings: { winFixes: true } },
  PlayerType: { Bot: "BOT", Nation: "NATION" },
});
for (const name of ["hybridModelContract", "hybridCombat"])
  vm.runInContext(
    fs.readFileSync(new URL(`../engine/ingame/auto-bot/${name}.js`, import.meta.url), "utf8"),
    realm,
  );
const C = vm.runInContext("HybridCombatContract", realm);
const Policy = vm.runInContext("HybridCombatPolicy", realm);
const model = C.create({ featureProfile: "frontier-v1", controlProfile: "tribe-ranking-v1" });
assert.equal(model.controlProfile, "tribe-ranking-v1");
assert.equal(model.actions.tribeRanking, "native-land-subset-v1");
assert.equal(model.actions.macroValue, "best-target-vs-wait-v1");
assert.throws(() => C.create({ controlProfile: "tribe-ranking-v1" }), /frontier/);
assert.throws(() => C.validate({ ...model, controlProfile: "target-value-v1" }));
const policy = new Policy({ storage: null });
policy.importModel(model);
policy.configure({ mode: "shadow", learning: true });
assert.equal(policy.tribeRankingEnabled(), true);
const legacy = new Policy({ storage: null });
legacy.importModel(legacy.createCompactModel({ featureProfile: "frontier-v1" }));
legacy.configure({ mode: "shadow", learning: true });
assert.equal(legacy.tribeRankingEnabled(), false);

const trained = C.create({ featureProfile: "frontier-v1", controlProfile: "tribe-ranking-v1" });
for (const [name, dimension] of Object.entries(C.dimensionsFor(trained)))
  for (let sample = 0; sample < dimension; sample++)
    trained.models[name] = C.update(trained.models[name], Array(dimension).fill(1), 0.5);
policy.importModel(trained);
policy.configure({ mode: "learned", learning: false });
assert.equal(policy.ready(), true, "synthetic examples use actual native SGD and readiness");
let tick = 10;
let attacks = [];
const target = (sid, tiles) => ({
  smallID: () => sid,
  type: () => "BOT",
  isPlayer: () => true,
  isAlive: () => true,
  troops: () => 20,
  numTilesOwned: () => tiles,
});
const small = { player: target(2, 1), landBorder: true, marker: "native-small" };
const large = { player: target(3, 90), landBorder: true, marker: "native-large" };
const boat = { player: target(4, 95), landBorder: false, marker: "native-boat" };
const behavior = {
  player: {
    smallID: () => 1,
    troops: () => 100,
    numTilesOwned: () => 20,
    sharesBorderWith: () => true,
    isFriendly: () => false,
    canAttackPlayer: () => true,
  },
  game: { config: () => ({ maxTroops: () => 200 }), numLandTiles: () => 100 },
  currentAttackDecisionTick: () => tick,
  incomingHostileAttackPressure: () => 0,
  getEarlyGameLiveReserveTroops: () => 50,
  getPlayerAttackPreferredTroopFloor: () => 20,
  getOutboundAttackSnapshot: () => attacks,
  getOutboundTransportSnapshot: () => [],
  getOutboundAttackTargetKey: (enemy) => String(enemy.smallID()),
  canAttackPlayerNow: () => true,
  inspectLandAttackFunding: (_enemy, options) => {
    assert.equal(options.parallelTribeAttack, true);
    return { allowed: true };
  },
  hybridCombatGeometry: (enemy) => ({
    targetSmallID: enemy.smallID(),
    tick,
    source: "native-border-centroid-v1",
    own: { x: 1, y: 1 },
    target: { x: 2, y: 2 },
    width: 10,
    height: 10,
    frontier: {
      source: "native-target-frontier-v1",
      actorSmallID: 1,
      targetSmallID: enemy.smallID(),
      tick,
      generation: policy.generation,
      ownBorderCount: 4,
      sharedFrontierCount: 2,
      ownMaxTroops: 200,
      incomingFromTargetTroops: 0,
    },
  }),
};
const optionsFor = () => ({ parallelTribeAttack: true, reinforcementPlan: null });
const nativeOrder = [small, large, boat];
const plan = policy.rankTribeChoice(behavior, nativeOrder, optionsFor);
assert.deepEqual(Array.from(plan.candidates), [large, small, boat]);
assert.deepEqual(nativeOrder, [small, large, boat], "native array and metadata are preserved");
assert.equal(
  policy.candidateRejection(behavior, small.player),
  "tribe-target",
  "tribes cannot enter the strategic WAIT pipeline",
);
policy.configure({ mode: "shadow", learning: true });
assert.equal(policy.rankTribeChoice(behavior, nativeOrder, optionsFor).candidates, nativeOrder);
policy.configure({ mode: "learned", learning: false });
assert.equal(policy.rankTribeChoice(behavior, [boat, small, large], optionsFor).chosen, null);
assert.equal(
  policy.rankTribeChoice(
    { ...behavior, inspectLandAttackFunding: (enemy) => ({ allowed: enemy.smallID() !== 2 }) },
    nativeOrder,
    optionsFor,
  ).chosen,
  null,
);
const rejectedFirstFundingProbes = [];
const rejectedFirst = policy.rankTribeChoice(
  {
    ...behavior,
    inspectLandAttackFunding: (enemy) => {
      rejectedFirstFundingProbes.push(enemy.smallID());
      return { allowed: enemy.smallID() !== 2 };
    },
  },
  nativeOrder,
  optionsFor,
);
assert.equal(rejectedFirst.candidates, nativeOrder);
assert.deepEqual(
  rejectedFirstFundingProbes,
  [2],
  "a blocked leading native candidate prevents reordering without probing later candidates",
);
assert.equal(
  policy.rankTribeChoice({ ...behavior, canAttackPlayerNow: () => false }, nativeOrder, optionsFor)
    .chosen,
  null,
);
assert.equal(
  policy.rankTribeChoice({ ...behavior, hybridCombatGeometry: () => null }, nativeOrder, optionsFor)
    .chosen,
  null,
);
const before = JSON.stringify(policy.exportModel());
let nativeSends = 0;
const currentPlan = policy.rankTribeChoice(behavior, nativeOrder, optionsFor);
await policy.sendTribeChoice(behavior, large, currentPlan, () => {
  nativeSends++;
  const observation = policy.actionObservation(behavior, large.player);
  policy.recordAcceptedAction(behavior, large.player, observation, policy.generation);
  return true;
});
assert.equal(nativeSends, 1);
assert.equal(policy.diagnostics().control.acceptedLearnedAttacks, 1);
assert.equal(
  policy.diagnostics().control.confirmedLearnedAttacks,
  0,
  "acceptance is not a receipt",
);
tick++;
attacks = [{ id: "actual-fixture-receipt", target: large.player, targetKey: "3", troops: 20 }];
policy.observe(behavior);
assert.equal(policy.diagnostics().control.confirmedLearnedAttacks, 1);
assert.equal(JSON.stringify(policy.exportModel()), before, "frozen holdout never learns");

const nativeRealm = createAttackBehaviorSandbox();
const timings = [];
nativeRealm.window = {
  setTimeout,
  clearTimeout,
  __OFH_profileNow: () => performance.now(),
  __OFH_hybridDecisionTiming: (row) => timings.push(row),
};
nativeRealm.hybridCombatPolicy = policy;
const caller = Object.create(nativeRealm.AttackBehavior.prototype);
Object.assign(caller, behavior, {
  prepareHybridCombatGeometry: async () => {
    tick++;
  },
});
const stale = await caller.prepareHybridTribePlan(nativeOrder, optionsFor);
assert.equal(stale.candidates, nativeOrder);
assert.equal(stale.chosen, null, "actual production caller falls back on tick drift");
let restored = false;
const options = { parallelTribeAttack: true, earlyGameCandidate: small, reinforcementPlan: null };
const quote = nativeRealm.AttackBehavior.prototype.inspectLandAttackFunding.call(
  {
    createLandAttackContext: (enemy, actualOptions) => {
      assert.equal(enemy, small.player);
      assert.equal(actualOptions, options);
      return { attackBlocked: false, finalSpendableTroops: 50, targetTroops: 50 };
    },
    calculateLandAttackTroops: () => 20,
    adjustLandAttackTroops: (_context, troops) => troops,
    landAttackTroopsAreSafe: () => true,
    restoreLandAttackReservation: () => {
      restored = true;
    },
  },
  small.player,
  options,
);
assert.equal(quote.allowed, true);
assert.equal(
  restored,
  true,
  "actual quote restores its reservation after using exact caller options",
);

executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/earlyGame.js"), nativeRealm);
nativeRealm.profileAttackAsync = async (_profile, _label, callback) => callback();
nativeRealm.hasAttackIntentRateCapacity = () => true;
const clusterSmall = { ...small, tribeClusterAccess: 2 };
const clusterLarge = { ...large, tribeClusterAccess: 2 };
const excluded = { player: target(5, 99), landBorder: true, tribeClusterAccess: 1 };
const launched = [];
policy.resetEpisode();
Object.assign(caller, {
  prepareHybridCombatGeometry: async () => {},
  legendaryExpansionBrakeActive: () => false,
  getReadyEarlyGameTribeCandidates: async () => [clusterSmall, clusterLarge, excluded],
  getActiveTribeAttackTargetKeys: () => new Set(),
  getBotAttackMaxParallelism: () => 1,
  publishEarlyGameTribeDiagnostics: () => {},
  launchEarlyGameTribeCandidate: async (candidate) => {
    launched.push(candidate);
    return true;
  },
});
assert.equal(await caller.attackEarlyGameTribe(), true);
assert.deepEqual(
  launched,
  [clusterLarge],
  "actual caller chooses inside the native largest-cluster subset",
);
assert.equal(policy.diagnostics().control.acceptedLearnedAttacks, 1);
assert.equal(
  policy.diagnostics().control.confirmedLearnedAttacks,
  0,
  "a sender boolean alone cannot manufacture a native receipt",
);
policy.configure({ mode: "shadow", learning: true });
launched.length = 0;
assert.equal(await caller.attackEarlyGameTribe(), true);
assert.deepEqual(
  launched,
  [clusterSmall],
  "shadow preserves actual native ordering and parallel cap",
);
const reinforcementCalls = [];
Object.assign(caller, {
  hasIncompleteEarlyGameClusterScores: () => false,
  getBotsNeedingAttackReinforcement: () => [small.player, large.player],
  activeTribeReinforcementPlan: () => null,
  sendAttack: async (...args) => {
    reinforcementCalls.push(args);
    return true;
  },
});
policy.configure({ mode: "learned", learning: false });
timings.length = 0;
assert.equal(await caller.attackBots(), true);
assert.equal(timings.length, 1, "one measured latency includes prepare and selected native send");
assert.ok(
  timings[0].phase === "tribe-choice" &&
    Number.isFinite(timings[0].durationMs) &&
    timings[0].durationMs >= 0,
);
assert.deepEqual(
  reinforcementCalls.map((args) => args[0].smallID()),
  [3, 2],
);
assert.ok(
  reinforcementCalls.every((args) => args[1] === false && args[5] === true && args[6] === null),
  "actual reinforcement caller preserves force, parallel and reinforcement arguments",
);
const trajectory = fixture({
  profile: "frontier-v1",
  controlProfile: "tribe-ranking-v1",
  actions: ["attack"],
});
const preparePlan = caller.prepareHybridTribePlan;
caller.prepareHybridTribePlan = async function (...args) {
  const plan = await preparePlan.apply(this, args);
  tick++;
  return plan;
};
reinforcementCalls.length = 0;
await caller.attackBots();
assert.deepEqual(
  reinforcementCalls.map((args) => args[0].smallID()),
  [2, 3],
  "post-preparation stale plan restores actual native iteration order",
);
caller.prepareHybridTribePlan = preparePlan;
const prepareGeometry = caller.prepareHybridCombatGeometry;
const readGeometry = caller.hybridCombatGeometry;
caller.game.width = () => 32;
caller.game.height = () => 16;
caller.hybridCombatGeometry = nativeRealm.AttackBehavior.prototype.hybridCombatGeometry;
executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/helpers.js")}\nglobalThis.WORKER_TIMEOUT_MS = WORKER_TIMEOUT_MS;`,
  nativeRealm,
);
caller.prepareHybridCombatGeometry =
  nativeRealm.AttackBehavior.prototype.prepareHybridCombatGeometry;
caller.player.borderTiles = () => Promise.reject(new Error("worker border unavailable"));
reinforcementCalls.length = 0;
await caller.attackBots();
assert.deepEqual(
  reinforcementCalls.map((args) => args[0].smallID()),
  [2, 3],
  "optional border query rejection retains actual native sends",
);
delete caller.player.borderTiles;
caller.prepareHybridCombatGeometry = prepareGeometry;
caller.hybridCombatGeometry = readGeometry;
nativeRealm.hasAttackIntentRateCapacity = () => false;
let geometryProbes = 0;
caller.prepareHybridCombatGeometry = async () => {
  geometryProbes++;
};
await caller.prepareHybridTribePlan(nativeOrder, optionsFor);
assert.equal(geometryProbes, 0, "a full intent budget skips optional worker queries");
nativeRealm.hasAttackIntentRateCapacity = () => true;
caller.prepareHybridCombatGeometry = prepareGeometry;
caller.prepareHybridTribePlan = async function (...args) {
  const plan = await preparePlan.apply(this, args);
  nativeRealm.hasAttackIntentRateCapacity = () => false;
  return plan;
};
timings.length = 0;
reinforcementCalls.length = 0;
assert.equal(await caller.attackBots(), false);
assert.equal(reinforcementCalls.length, 0);
assert.equal(
  timings.length,
  1,
  "capacity depleted during preparation still records one measured timing",
);
nativeRealm.hasAttackIntentRateCapacity = () => true;
caller.prepareHybridTribePlan = preparePlan;
assert.equal(validateFixture(trajectory).trainable, true);
const censoredTribe = ambiguousFixture({
  profile: "frontier-v1",
  controlProfile: "tribe-ranking-v1",
});
assert.equal(validateFixture(censoredTribe).excluded[0].reason, "censored-ambiguous-commitment");
const unknownSource = fixture({
  profile: "frontier-v1",
  controlProfile: "tribe-ranking-v1",
  actions: ["attack"],
});
for (const row of unknownSource.dataset.records)
  if (row.event.kind === "hybrid-combat-proposal") row.event.candidateSetSource = "unverified-pool";
assert.throws(() => validateFixture(unknownSource));
const unsupportedWait = fixture({
  profile: "frontier-v1",
  controlProfile: "tribe-ranking-v1",
  actions: ["wait"],
});
assert.throws(() => validateFixture(unsupportedWait), /WAIT/);
const tribeOnlyModel = C.create({
  featureProfile: "frontier-v1",
  controlProfile: "tribe-only-terminal-v1",
});
const tribeOnly = new Policy({ storage: null });
tribeOnly.importModel(tribeOnlyModel);
tribeOnly.configure({ mode: "learned", learning: false });
assert.equal(tribeOnly.ready(), false, "new authority scope preserves the cold coverage gate");
for (const [name, dimension] of Object.entries(C.dimensionsFor(tribeOnlyModel)))
  for (let sample = 0; sample < dimension; sample++)
    tribeOnlyModel.models[name] = C.update(
      tribeOnlyModel.models[name],
      Array(dimension).fill(1),
      0.5,
    );
tribeOnly.importModel(tribeOnlyModel);
assert.equal(tribeOnly.ready(), true);
assert.equal(tribeOnly.tribeRankingEnabled(), true);
const conditionalBehavior = {
  ...behavior,
  hybridCombatGeometry: (enemy) => {
    const geometry = behavior.hybridCombatGeometry(enemy);
    return { ...geometry, frontier: { ...geometry.frontier, generation: tribeOnly.generation } };
  },
};
const conditionalPredict = tribeOnly.predict.bind(tribeOnly);
tribeOnly.predict = (name, values) => {
  assert.equal(name, "target", "inactive macro heads have no inference authority");
  return conditionalPredict(name, values);
};
const conditional = tribeOnly.rankTribeChoice(conditionalBehavior, nativeOrder, optionsFor);
assert.ok(conditional.chosen, "new profile keeps the funded native tribe choice");
assert.equal(await tribeOnly.decide(behavior, [large.player]), false);
assert.equal(tribeOnly.step, 0, "strategic macro creates no learned decision or WAIT");
const nation = { ...large.player, type: () => "NATION" };
assert.equal(tribeOnly.isStrategicTarget(behavior, nation), false);
assert.equal(tribeOnly.allowsAttack(behavior, nation), true, "no auxiliary commitment veto");
nativeRealm.hybridCombatPolicy = tribeOnly;
let strategicGeometryCalls = 0;
caller.prepareHybridCombatGeometry = async () => {
  strategicGeometryCalls++;
};
assert.equal(await caller.decideHybridCombat([nation]), false);
assert.equal(strategicGeometryCalls, 0, "actual macro caller does no unused geometry work");
tribeOnly.configure({ mode: "shadow", learning: false });
assert.equal(await tribeOnly.decide(behavior, [nation]), false);
assert.equal(await caller.decideHybridCombat([nation]), false);
assert.equal(strategicGeometryCalls, 0, "frozen shadow does not compute inactive macro heads");
const conditionalTrajectory = fixture({
  profile: "frontier-v1",
  controlProfile: "tribe-only-terminal-v1",
  actions: ["attack"],
});
assert.equal(validateFixture(conditionalTrajectory, { gammaTick: 1 }).trainable, true);
assert.throws(() => validateFixture(conditionalTrajectory, { gammaTick: 0.9 }), /gammaTick 1/);
const conditionalMacro = fixture({
  profile: "frontier-v1",
  controlProfile: "tribe-only-terminal-v1",
  actions: ["attack"],
});
for (const row of conditionalMacro.dataset.records)
  if (["hybrid-combat-proposal", "hybrid-combat-decision"].includes(row.event.kind))
    row.event.behaviorPolicy = "deterministic-wait-act-ranked-target";
assert.throws(
  () => validateFixture(conditionalMacro, { gammaTick: 1 }),
  /cannot control strategic macro/,
);
const conditionalWait = fixture({
  profile: "frontier-v1",
  controlProfile: "tribe-only-terminal-v1",
  actions: ["wait"],
});
assert.throws(() => validateFixture(conditionalWait, { gammaTick: 1 }), /WAIT/);
async function fundedAlternativesAfterDeniedLeader() {
  const snapshot = C.create({
    featureProfile: "frontier-v1",
    controlProfile: "funded-tribe-terminal-v1",
  });
  for (const [name, dimension] of Object.entries(C.dimensionsFor(snapshot)))
    for (let sample = 0; sample < dimension; sample++)
      snapshot.models[name] = C.update(snapshot.models[name], Array(dimension).fill(1), 0.5);
  const funded = new Policy({ storage: null });
  funded.importModel(snapshot);
  funded.configure({ mode: "learned", learning: false });
  assert.equal(funded.ready(), true);
  const blocked = { ...small, player: target(9, 1), tribeClusterAccess: 2 };
  const alternatives = [blocked, clusterSmall, clusterLarge];
  const quotes = [];
  const fundedRealm = createAttackBehaviorSandbox();
  executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/earlyGame.js"), fundedRealm);
  fundedRealm.profileAttackAsync = async (_profile, _label, callback) => callback();
  fundedRealm.hasAttackIntentRateCapacity = () => true;
  fundedRealm.hybridCombatPolicy = funded;
  const local = Object.create(fundedRealm.AttackBehavior.prototype);
  Object.assign(local, behavior, {
    prepareHybridCombatGeometry: async () => {},
    hybridCombatGeometry: (enemy) => {
      const geometry = behavior.hybridCombatGeometry(enemy);
      geometry.frontier.generation = funded.generation;
      return geometry;
    },
    inspectLandAttackFunding: (enemy) => {
      quotes.push(enemy.smallID());
      return { allowed: enemy.smallID() !== 9 };
    },
    legendaryExpansionBrakeActive: () => false,
    getReadyEarlyGameTribeCandidates: async () => alternatives,
    getActiveTribeAttackTargetKeys: () => new Set(),
    getBotAttackMaxParallelism: () => 1,
    publishEarlyGameTribeDiagnostics: () => {},
  });
  const selected = funded.rankTribeChoice(local, alternatives, optionsFor);
  assert.equal(selected.chosen?.target.smallID(), 3);
  assert.deepEqual(Array.from(selected.candidates), [blocked, clusterLarge, clusterSmall]);
  assert.deepEqual(quotes, [9, 2, 3]);
  const denied = funded.rankTribeChoice(
    { ...local, inspectLandAttackFunding: () => ({ allowed: false }) },
    alternatives,
    optionsFor,
  );
  assert.equal(denied.chosen, null);
  assert.equal(denied.candidates, alternatives);
  assert.equal(
    funded.rankTribeChoice({ ...local, hybridCombatGeometry: () => null }, alternatives, optionsFor)
      .chosen,
    null,
    "unknown geometry cannot manufacture a funded choice",
  );
  assert.equal(
    funded.rankTribeChoice(local, [blocked, boat, clusterLarge], optionsFor).chosen,
    null,
  );
  const cold = new Policy({ storage: null });
  cold.importModel(
    C.create({ featureProfile: "frontier-v1", controlProfile: "funded-tribe-terminal-v1" }),
  );
  cold.configure({ mode: "learned", learning: false });
  assert.equal(cold.ready(), false);
  assert.equal(cold.rankTribeChoice(local, alternatives, optionsFor).chosen, null);
  const attempted = [];
  local.launchEarlyGameTribeCandidate = async (candidate) => {
    attempted.push(candidate.player.smallID());
    return candidate.player.smallID() !== 9;
  };
  assert.equal(await local.attackEarlyGameTribe(), true);
  assert.deepEqual(
    attempted,
    [9, 3],
    "actual caller preserves denial before choosing funded alternative",
  );
  assert.equal(funded.diagnostics().control.acceptedLearnedAttacks, 1);
  assert.equal(funded.diagnostics().control.confirmedLearnedAttacks, 0);
}
await fundedAlternativesAfterDeniedLeader();
console.warn("hybrid tribe ranking contract passed");
