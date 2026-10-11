import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/repository-fixture.mjs";
const sandbox = {
  window: {},
  state: { settings: { winFixes: true } },
  UNIT: { City: "City", Factory: "Factory", Port: "Port" },
};
executeClassicScript(
  `class StructureBehavior { constructor(random,game,player) { this.game=game; this.player=player; } async handleStructures() { this.calls=(this.calls||0)+1; return false; } legendaryConstructionActionGroups(c) { return [c]; } async legendaryConstructionActionGroupResult() { return "skip"; } async buildableFor(type) { return {type,cost:60n,canBuild:0,canUpgrade:false}; } availableGoldAfterReserve() { return 100n; } tileInsideActiveHostileMissileImpact() { return false; } }`,
  sandbox,
);
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/hybridStrategy.js"), sandbox);
const api = sandbox.window.__OFH_hybridStrategy;
assert.equal(api.version, "ofh-hybrid-strategy-v1");
let tick = 10;
const feeds = new Map();
const attack = {
  id: () => "attack-1",
  attacker: () => leader,
  target: () => enemy,
  retreating: () => false,
};
function player(sid) {
  return {
    smallID: () => sid,
    id: () => `player${sid}x`,
    type: () => "HUMAN",
    isAlive: () => true,
    isFriendly: (p) => p.smallID() !== 3,
    outgoingEmojis: () => feeds.get(sid) || [],
    outgoingAttacks: () => (sid === 1 ? [attack] : []),
    incomingAttacks: () => [],
    gold: () => 100n,
  };
}
const leader = player(1),
  me = player(2),
  enemy = player(3);
const game = {
  ticks: () => tick,
  players: () => [leader, me, enemy],
  config: () => ({ emojiMessageDuration: () => 50 }),
  units: () => [],
};
const ctx = { game, player: me, sessionId: "fixture", generation: 1 };
api.configure({ enabled: true });
api.observeDuo(ctx);
feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 10 }]);
assert.equal(api.observeDuo(ctx).length, 1);
assert.equal(api.getJointPlan(ctx, 1), null, "request alone is not ACK");
tick = 11;
feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 11 }]);
api.observeDuo(ctx);
const plan = api.getJointPlan(ctx, 1);
assert.equal(plan.attackId, "attack-1");
assert.equal(plan.targetSid, 3);
assert.equal(plan.expiresTick, 60);
assert.equal(api.getJointPlan({ ...ctx, crisis: true }, 1), null);
feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: "AllPlayers", createdAt: 11 }]);
assert.equal(api.getJointPlan(ctx, 1), null, "broadcast is not directed ACK");
feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 11 }]);
assert.ok(api.getJointPlan(ctx, 1));
feeds.set(1, []);
assert.equal(api.getJointPlan(ctx, 1), null, "hidden feed fails closed");
feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 10 }]);
assert.equal(
  api.getJointPlan({ ...ctx, generation: 2 }, 1),
  null,
  "generation invalidates consent",
);
api.reset("fixture");
api.observeDuo(ctx);
assert.equal(api.getJointPlan(ctx, 1), null, "old request cannot adopt newly observed attack");
const proposal = api.propose(ctx, "economic", [
  { target: 4, expiresTick: 30, relativeNotBefore: 2 },
])[0];
assert.equal(api.validate(ctx, proposal).valid, true);
assert.equal(api.validate({ ...ctx, generation: 2 }, proposal).valid, false);
const rebased = api.rebase(ctx, proposal, 3);
assert.equal(rebased.expiresTick, 30, "hard expiry cannot shift");
assert.equal(rebased.notBeforeTick, 16);
// Issued authority is checked at the real economic admission caller.
const purchase = (candidate, tile = 4) =>
  api.admitEconomicPurchase({
    ...ctx,
    proposal: candidate,
    tile,
    buildable: { type: "City", cost: 1n },
    reservedGold: 0n,
  });
assert.equal(purchase(rebased).reason, "proposal-not-before");
for (const change of [
  { channel: "attack" },
  { notBeforeTick: 0 },
  { notBeforeTick: NaN },
  { notBeforeTick: undefined },
  { expiresTick: 100 },
  { sourceTick: NaN },
  { channel: undefined },
  { createdTick: undefined },
  { extraAuthority: true },
  { evidence: { status: "invented" } },
  { pendingNativeKeys: ["fake"] },
]) {
  assert.equal(purchase({ ...rebased, ...change }).reason, "stale-proposal");
}
assert.equal(purchase({ ...rebased, channel: "attack" }, 99).blocked, true);
assert.equal(api.rebase(ctx, proposal, 1), null, "previous admitted timing cannot be reused");
const delayedAgain = api.rebase(ctx, rebased, 2);
assert.equal(delayedAgain.notBeforeTick, 18);
assert.equal(delayedAgain.expiresTick, 30);
assert.equal(api.validate(ctx, rebased).valid, false);
assert.equal(
  api.admitEconomicPurchase({
    ...ctx,
    proposalId: delayedAgain.proposalId,
    tile: 4,
    buildable: { type: "City", cost: 1n },
    reservedGold: 0n,
  }).reason,
  "proposal-not-before",
);
assert.equal(
  api.propose(ctx, "economic", [{ target: 4, expiresTick: 30, relativeNotBefore: -1 }]).length,
  0,
);
assert.equal(api.rebase(ctx, delayedAgain, Number.MAX_SAFE_INTEGER), null);
const mutableEvidence = { status: "unknown", native: { ids: [1] } };
const aliasProposal = api.propose(ctx, "economic", [
  { target: 4, expiresTick: 30, evidence: mutableEvidence },
])[0];
mutableEvidence.native.ids.push(2);
assert.equal(
  purchase(aliasProposal).reason,
  "stale-proposal",
  "nested aliases cannot mutate issued authority",
);
assert.equal(
  api.admitEconomicPurchase({
    ...ctx,
    proposalId: aliasProposal.proposalId,
    tile: 4,
    buildable: { type: "City", cost: 1n },
    reservedGold: 0n,
  }).blocked,
  false,
);
const structure = api.createStructureBehavior({}, game, me);
assert.equal(
  await structure.handleStructures(),
  false,
  "never purchase after inherited defense hold",
);
assert.equal(structure.calls, 1);
assert.equal(
  api.admitEconomicPurchase({
    ...ctx,
    buildable: { type: "City", cost: 101n },
    tile: 4,
    reservedGold: 0n,
  }).blocked,
  true,
);
assert.equal(
  api.admitEconomicPurchase({
    ...ctx,
    buildable: { type: "SAM Launcher", cost: 101n },
    tile: 4,
    reservedGold: 0n,
  }).scope,
  "unmanaged",
);
let target = 9;
const boat = {
  id: () => 7,
  owner: () => me,
  tile: () => 4,
  targetTile: () => target,
  isActive: () => true,
};
api.observeNaval(
  ctx,
  [boat],
  new Map([[7, { unitId: 7, planId: 1, path: [4, 5, 9], startTick: 11, ticksPerStep: 2 }]]),
);
assert.equal(api.transportCommitment(ctx, 7).arrivalTick, 15);
target = 4;
api.observeNaval(ctx, [boat], new Map());
assert.equal(api.transportCommitment(ctx, 7).status, "redirected");
api.observeNaval(ctx, [], new Map());
assert.equal(api.transportCommitment(ctx, 7).status, "unconfirmed", "disappearance is not sinking");
tick = 60;
assert.equal(api.getJointPlan(ctx, 1), null);

const spawnSandbox = {};
executeClassicScript(readRepositoryFile("engine/ingame/spawn-index.js"), spawnSandbox);
const index = spawnSandbox.__OFHSpawnIndex.create({
  width: 12,
  height: 12,
  terrain: new Uint8Array(144).fill(128),
  spawnRadius: 2,
});
index.buildAll();
assert.equal(
  index.reserveFootprint({ actorSid: 1, sessionId: "s", ref: 65, tick: 1, expiresTick: 4 }),
  true,
);
assert.equal(
  index.getCandidate(66, { tick: 2, actorSid: 2, sessionId: "s" }),
  null,
  "full discs cannot overlap pending reserves",
);
assert.ok(
  index.getCandidate(66, { tick: 4, actorSid: 2, sessionId: "s" }),
  "expiry equality releases reservation",
);

// The production connectivity snapshot must be observational.
const diagnosticSandbox = {
  window: {},
  document: {},
  runtimeState: {},
  localStorage: { getItem: () => null },
  registerMapOverlayLayer() {},
};
executeClassicScript(
  readRepositoryFile("engine/ingame/spawn-heatmap.js") +
    "\nwindow.setDiagnosticIndex = (index) => { _spawnCandidateIndex = index; };",
  diagnosticSandbox,
);
index.reserveFootprint({ actorSid: 1, sessionId: "s", ref: 65, tick: 5, expiresTick: 10 });
diagnosticSandbox.window.setDiagnosticIndex(index);
const diagnosticVersion = index.version;
assert.equal(diagnosticSandbox.getSpawnCandidateConnectivitySnapshot().supported, true);
assert.equal(index.pendingFootprints.size, 1, "diagnostics preserve pending disc");
assert.equal(index.version, diagnosticVersion);
assert.equal(index.getCandidate(66), null, "unscoped read cannot clear pending disc");
assert.equal(index.getCandidate(66, { tick: 5, actorSid: 2, sessionId: "s" }), null);
const continued = [];
index.continueCandidates({
  cursor: 65,
  budget: 2,
  tick: 5,
  actorSid: 2,
  sessionId: "s",
  onCandidate: (ref) => continued.push(ref),
});
assert.equal(continued.length, 0, "bounded continuation respects same pending disc");
assert.equal(index.confirmFootprint(1, 66), false);
assert.equal(index.confirmFootprint(1, 65), true);
assert.ok(index.getCandidate(66, { tick: 5, actorSid: 2, sessionId: "s" }));
const recalled = true;
boat.transportShipState = () => ({ isRetreating: recalled });
api.observeNaval(ctx, [boat], new Map());
assert.equal(api.transportCommitment(ctx, 7).status, "recalled");
assert.equal(index.continueCandidates({ cursor: 0, budget: 5, onCandidate() {} }).cursor, 5);
assert.equal(index.confirmFootprint(1, 999), false, "proposed spawn is not a receipt");
const objectiveSandbox = {};
executeClassicScript(readRepositoryFile("engine/ingame/spawn-objective.js"), objectiveSandbox);
const ordinary = objectiveSandbox.__OFHSpawnObjective.evaluateModelCandidate({
  startScore: 1,
  expansionScore: 1,
  safetyScore: 1,
  teamScore: 1,
  freeLandScore: 1,
  resourceScore: 1,
});
const congested = objectiveSandbox.__OFHSpawnObjective.evaluateModelCandidate({
  ...ordinary,
  congestionScore: 0.2,
});
assert.equal(congested.robustFloor, 0.2);
// Actual exact rank pipeline: its contextual callback owns adaptive policy.
const rankSandbox = {
  window: { __OFH_hybridStrategy: { diagnostics: () => ({ enabled: true }) } },
  document: {},
  runtimeState: {},
  localStorage: { getItem: () => null },
  registerMapOverlayLayer() {},
  getCachedPlayerViews: () => [],
  isNationBotPlayer: () => false,
  setTimeout() {},
  performance: { now: () => 0 },
};
for (const module of ["spawn-index", "spawn-objective", "spawn-heatmap"]) {
  executeClassicScript(readRepositoryFile(`engine/ingame/${module}.js`), rankSandbox);
}
const rankTerrain = new Uint8Array(400).fill(128);
const rankIndex = rankSandbox.__OFHSpawnIndex.create({
  width: 20,
  height: 20,
  terrain: rankTerrain,
});
rankIndex.buildAll();
const rankPlayer = { smallID: () => 1, team: () => null, spawnTile: () => null };
const rankOther = { ...rankPlayer, smallID: () => 2 };
const rankGame = {
  width: () => 20,
  height: () => 20,
  ticks: () => 1,
  config: () => ({ numSpawnPhaseTurns: () => 100, minDistanceBetweenPlayers: () => 0 }),
  ref: (x, y) => y * 20 + x,
  isValidCoord: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 20,
  isLand: () => true,
  hasOwner: () => false,
  isBorder: () => false,
  __src: { _map: { terrain: rankTerrain } },
};
// Only supply the existing index; ranking, iteration and objective remain real.
rankSandbox.ensureSpawnCandidateIndex = () => rankIndex;
rankSandbox.existingSpawnCandidateIndex = () => rankIndex;
const rankPoints = {
  teamSpawns: [],
  enemySpawns: [],
  clanSpawns: [],
  tribeLocs: [],
  nationLocs: [],
  signature: "reservation-ranker",
};
function rankedPendingCenter(actor) {
  const best = [];
  rankSandbox.computeExactSpawnTopSpotsForBot(rankGame, actor, {
    points: rankPoints,
    best,
    startRef: 210,
    endRef: 211,
  });
  return best.map((candidate) => candidate.ref);
}
assert.equal(rankSandbox.reserveBotSpawnFootprint(rankGame, rankPlayer, 210), true);
const pendingVersion = rankIndex.version;
assert.deepEqual(
  Array.from(rankedPendingCenter(rankPlayer)),
  [210],
  "actual ranker admits own pending footprint",
);
assert.deepEqual(
  Array.from(rankedPendingCenter(rankOther)),
  [],
  "actual ranker rejects another actor overlap while enabled",
);
rankSandbox.window.__OFH_hybridStrategy.diagnostics = () => ({ enabled: false });
assert.deepEqual(Array.from(rankedPendingCenter(rankPlayer)), [210]);
assert.deepEqual(
  Array.from(rankedPendingCenter(rankOther)),
  [210],
  "disabled policy preserves baseline ranker semantics",
);
executeClassicScript(
  "window.connectivityIndex = (index) => { _spawnCandidateIndex = index; };",
  rankSandbox,
);
rankSandbox.window.connectivityIndex(rankIndex);
rankSandbox.getSpawnCandidateConnectivitySnapshot();
assert.equal(rankIndex.pendingFootprints.size, 1);
assert.equal(rankIndex.version, pendingVersion, "ranking and diagnostics preserve pending book");
// Caller integration without replacing the native selector: bounded book exists
// before the map-sized index is ready, and reservations survive that continuation.
const callbacks = [];
const heatmapSandbox = {
  window: sandbox.window,
  document: {},
  runtimeState: {},
  localStorage: { getItem: () => null },
  performance: { now: () => 0 },
  setTimeout: (fn) => callbacks.push(fn),
  registerMapOverlayLayer() {},
  getCachedPlayerViews: () => [],
  isNationBotPlayer: () => false,
};
executeClassicScript(readRepositoryFile("engine/ingame/spawn-index.js"), heatmapSandbox);
executeClassicScript(readRepositoryFile("engine/ingame/spawn-objective.js"), heatmapSandbox);
executeClassicScript(readRepositoryFile("engine/ingame/spawn-heatmap.js"), heatmapSandbox);
const spawnGame = {
  width: () => 20,
  height: () => 20,
  ticks: () => 1,
  config: () => ({ numSpawnPhaseTurns: () => 100 }),
  ref: (x, y) => y * 20 + x,
  isValidCoord: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 20,
  isLand: () => true,
  hasOwner: () => false,
  isBorder: () => false,
};
assert.equal(heatmapSandbox.reserveBotSpawnFootprint(spawnGame, me, 210), true);
const book = heatmapSandbox.spawnReservationBook(spawnGame);
assert.equal(book.reservationAllows(211, { tick: 2, actorSid: 1, sessionId: spawnGame }), false);
assert.equal(book.confirmFootprint(2, 211), false);
assert.equal(book.confirmFootprint(2, 210), true);
// Ordinary economic ordering is retained unless consecutive failed probes have
// actually observed stagnant gold; safety positions are never moved.
structure.hybridLastProbe = { outcome: "skip" };
structure.hybridPreviousGold = "100";
const expensive = { type: "City", action: "build", cost: 90n };
const cheap = { type: "Factory", action: "build", cost: 10n };
const safety = { type: "SAM Launcher", action: "build", mandatory: 1, cost: 99n };
const recovery = structure.legendaryConstructionActionGroups([expensive, safety, cheap], false)[0];
assert.equal(recovery[0], cheap);
assert.equal(recovery[1], safety);
assert.equal(recovery[2], expensive);

assert.equal(
  book.reserveFootprint({ actorSid: 1, sessionId: "s", ref: 210, tick: 2, expiresTick: 10 }),
  true,
);
assert.equal(
  book.reserveFootprint({ actorSid: 1, sessionId: "s", ref: 210, tick: 3, expiresTick: 100 }),
  true,
);
assert.equal(
  book.pendingFootprints.get(1).expiresTick,
  10,
  "retry cannot extend original native reservation deadline",
);
sandbox.state.settings.winFixes = false;
assert.equal(api.diagnostics().enabled, false, "faithful port cannot activate strategy callers");
sandbox.state.settings.winFixes = true;

api.reset();
feeds.set(1, []);
feeds.set(2, []);
tick = 80;
const wrappedMe = { __src: me, isFriendly: me.isFriendly };
const wrappedContext = { ...ctx, player: wrappedMe };
api.observeDuo(wrappedContext);
feeds.set(1, [{ message: "✋", senderID: 1, recipientID: 2, createdAt: 80 }]);
feeds.set(2, [{ message: "⏳", senderID: 2, recipientID: 1, createdAt: 80 }]);
assert.ok(
  api.getJointPlan(wrappedContext, 1),
  "stable gameApi wrapper reads authoritative native emoji source without a new wrapper hook",
);

const incomingThreat = { isActive: () => true, owner: () => enemy };
game.units = (type) => (type === "Atom Bomb" ? [incomingThreat] : []);
await structure.buildableFor("SAM Launcher", 0);
assert.equal(
  api.admitEconomicPurchase({
    ...ctx,
    buildable: { type: "Port", cost: 50n, canUpgrade: false },
    tile: 4,
    reservedGold: 0n,
  }).reason,
  "urgent-defense-quote",
  "actual defensive quote protects Port even though original reserve intentionally exempts Ports",
);
tick++;
assert.equal(
  api.admitEconomicPurchase({
    ...ctx,
    buildable: { type: "Port", cost: 50n, canUpgrade: false },
    tile: 4,
    reservedGold: 0n,
  }).blocked,
  false,
  "stale defensive quote cannot freeze later ticks",
);

const resetProposal = api.propose(ctx, "economic", [{ target: 4, expiresTick: tick + 5 }])[0];
assert.equal(api.validate(ctx, resetProposal).valid, true);
api.reset();
assert.equal(
  api.validate(ctx, resetProposal).valid,
  false,
  "reset invalidates a still-unexpired proposal even when supplied generation is unchanged",
);
// Exercise the real bot selector caller when its initial shortlist is reserved.
// Spy on the existing asynchronous continuation seam, never create a second scan.
const readyIndex = heatmapSandbox.__OFHSpawnIndex.create({
  width: 20,
  height: 20,
  terrain: new Uint8Array(400).fill(128),
});
readyIndex.buildAll();
heatmapSandbox.existingSpawnCandidateIndex = () => readyIndex;
heatmapSandbox.computeInitialSpawnTopSpotsForBot = () => [{ ref: 210, x: 10, y: 10, score: 1 }];
let continuationCalls = 0;
heatmapSandbox.computeAsyncExactSpawnTopSpotsForBot = () => {
  continuationCalls++;
  return null;
};
assert.equal(heatmapSandbox.reserveBotSpawnFootprint(spawnGame, leader, 210), true);
assert.equal(heatmapSandbox.computeSpawnTopSpotsForBot(spawnGame, me, { initial: true }).length, 0);
assert.equal(
  continuationCalls,
  1,
  "actual selector calls the existing bounded continuation when reservation excludes shortlist",
);
const pendingPurchase = api.propose(ctx, "economic", [
  { target: 4, expiresTick: tick + 5, relativeNotBefore: 2 },
])[0];
const purchaseContext = {
  ...ctx,
  buildable: { type: "City", cost: 1n, canUpgrade: false },
  tile: 4,
  reservedGold: 0n,
  proposalId: pendingPurchase.proposalId,
};
assert.equal(api.admitEconomicPurchase(purchaseContext).reason, "proposal-not-before");
api.reset();
assert.equal(
  api.admitEconomicPurchase(purchaseContext).reason,
  "stale-proposal",
  "proposal ID cannot bypass reset",
);
const deferredQuote = structure.buildableFor("SAM Launcher", 0);
tick++;
await deferredQuote;
assert.notEqual(
  structure.hybridDefensiveQuote?.sourceTick,
  tick,
  "await cannot bless an older native defensive quote with the new tick",
);

process.stdout.write("hybrid strategy focused and caller regressions passed\n");
