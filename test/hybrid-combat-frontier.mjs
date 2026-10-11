import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
// Only repository classic scripts run in an isolated fixture realm.
/* eslint-disable sonarjs/code-eval */

const sandbox = {
  window: {},
  state: { settings: { winFixes: true } },
  PlayerType: { Bot: "BOT" },
  performance: { now: () => 0 },
  WORKER_TIMEOUT_MS: 10,
  withTimeout: async (promise) => promise,
};
vm.createContext(sandbox);
for (const name of ["hybridModelContract", "hybridCombat"])
  vm.runInContext(
    fs.readFileSync(new URL(`../engine/ingame/auto-bot/${name}.js`, import.meta.url), "utf8"),
    sandbox,
  );
const policy = vm.runInContext("hybridCombatPolicy", sandbox);
const source = fs.readFileSync(
  new URL("../engine/ingame/auto-bot/attackBehavior.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("    async prepareHybridCombatGeometry(");
const end = source.indexOf("    resetBoatRouteEtaCache(", start);
const Fixture = vm.runInContext(`(class {${source.slice(start, end)}})`, sandbox);
const fixture = new Fixture();
let tick = 10,
  borderReads = 0,
  neighborReads = 0,
  incomingReads = 0;
const a = {
  smallID: () => 2,
  type: () => "NATION",
  isPlayer: () => true,
  isAlive: () => true,
  troops: () => 20,
  numTilesOwned: () => 10,
  borderTiles: () => [5],
};
const b = { ...a, smallID: () => 3, borderTiles: () => [6] };
const own = {
  smallID: () => 1,
  troops: () => 100,
  numTilesOwned: () => 20,
  sharesBorderWith: () => true,
  isFriendly: () => false,
  borderTiles: () => {
    borderReads++;
    return [0, 0, 1, 2];
  },
  incomingAttacks: () => {
    incomingReads++;
    return [
      { attacker: () => a, target: () => own, troops: () => 40, retreating: () => false },
      { attacker: () => b, target: () => own, troops: () => 10, retreating: () => true },
    ];
  },
};
Object.assign(fixture, {
  player: own,
  game: {
    width: () => 10,
    height: () => 10,
    x: (tile) => tile,
    y: () => 0,
    neighbors: (tile) => {
      neighborReads++;
      return tile === 0 ? [5, 7] : [8];
    },
    ownerID: (tile) => (tile === 5 || tile === 7 ? 2 : 0),
    config: () => ({ maxTroops: () => 200 }),
    numLandTiles: () => 100,
  },
  currentAttackDecisionTick: () => tick,
  incomingHostileAttackPressure: () => 0,
  getEarlyGameLiveReserveTroops: () => 50,
  getPlayerAttackPreferredTroopFloor: () => 20,
  getOutboundAttackSnapshot: () => [],
  getOutboundTransportSnapshot: () => [],
  canAttackPlayerNow: () => true,
});
policy.importModel(policy.createCompactModel({ featureProfile: "frontier-v1" }));
policy.configure({ mode: "shadow", learning: false });
await fixture.prepareHybridCombatGeometry([a, b]);
assert.equal(borderReads, 1, "own border snapshot queried once for all targets");
assert.equal(neighborReads, 3, "unique own border tiles scanned once");
assert.equal(incomingReads, 1, "one current attack snapshot shared by targets");
const gate = policy.gateFeatures(fixture);
const fa = policy.targetFeatures(fixture, a, gate),
  fb = policy.targetFeatures(fixture, b, gate);
assert.equal(fa.length, 17);
assert.deepEqual(Array.from(fa.slice(13)), [1 / 3, 0.2, 1, 1]);
assert.deepEqual(Array.from(fb.slice(13)), [0, 0, 1, 1], "known zero is present, not missing");
const raw = fixture.hybridCombatGeometry(a).frontier;
assert.equal(raw.actorSmallID, 1);
assert.equal(
  raw.sharedFrontierCount,
  1,
  "two adjacent tiles of same enemy count the own tile once",
);
assert.equal(raw.generation, policy.generation);
assert.equal(policy.actionObservation(fixture, a).actorSmallID, 1);
assert.equal(policy.diagnostics().readiness.target.requiredSamples, 17);
assert.ok(Number.isFinite(policy.predict("target", fa)));
await policy.decide(fixture, [a, b]);
const scored = policy.exportLedger().entries.find((row) => row.kind === "proposal");
assert.equal(scored.candidates.length, 2);
assert.equal(scored.actorSmallID, 1);
assert.equal(scored.candidates[0].features.length, 17);
assert.equal(scored.candidates[0].geometry.frontier.actorSmallID, 1);
const savedGeneration = fixture.hybridGeometrySnapshot.generation;
fixture.hybridGeometrySnapshot.frontier.get(2).generation--;
assert.equal(
  policy.targetFeatures(fixture, a, gate),
  null,
  "raw fact identity revalidated independently of snapshot identity",
);
fixture.hybridGeometrySnapshot.frontier.get(2).generation = savedGeneration;

const originalFriendly = own.isFriendly;
own.isFriendly = () => undefined;
await fixture.prepareHybridCombatGeometry([a]);
assert.equal(
  policy.targetFeatures(fixture, a, gate),
  null,
  "unknown hostility is not known zero frontier",
);
own.isFriendly = originalFriendly;

delete own.incomingAttacks;
delete fixture.game.ownerID;
await fixture.prepareHybridCombatGeometry([a]);
assert.deepEqual(Array.from(policy.targetFeatures(fixture, a, gate).slice(13)), [0, 0, 0, 0]);
const missing = fixture.hybridCombatGeometry(a).frontier;
assert.equal(missing.ownMaxTroops, null);
assert.equal(missing.incomingFromTargetTroops, null);
assert.equal(missing.ownBorderCount, null);
assert.equal(missing.sharedFrontierCount, null);
policy.resetEpisode();
assert.equal(
  fixture.hybridCombatGeometry(a),
  null,
  "generation invalidates facts even at the same tick",
);
await fixture.prepareHybridCombatGeometry([a]);
tick++;
assert.equal(fixture.hybridCombatGeometry(a), null, "tick invalidates facts");

own.incomingAttacks = () => [
  { attacker: () => a, target: () => own, troops: () => NaN, retreating: () => false },
];
await fixture.prepareHybridCombatGeometry([a]);
assert.equal(
  policy.targetFeatures(fixture, a, policy.gateFeatures(fixture)),
  null,
  "malformed known attacks deny the feature row",
);
let releaseBorders;
own.borderTiles = () =>
  new Promise((resolve) => {
    releaseBorders = resolve;
  });
const preparing = fixture.prepareHybridCombatGeometry([a]);
policy.resetEpisode();
releaseBorders([0, 1]);
await preparing;
assert.equal(
  fixture.hybridGeometrySnapshot,
  null,
  "in-flight generation switch never publishes a frontier snapshot",
);
own.borderTiles = () => [0, 1];

// v2 retains its old reads and 13-feature vectors; no frontier capability required.
policy.importModel(policy.createCompactModel());
neighborReads = 0;
incomingReads = 0;
own.incomingAttacks = () => {
  incomingReads++;
  throw new Error("v2 must not query frontier attacks");
};
await fixture.prepareHybridCombatGeometry([a]);
assert.equal(neighborReads, 0);
assert.equal(incomingReads, 0);
assert.equal(policy.targetFeatures(fixture, a, policy.gateFeatures(fixture)).length, 13);
// Real client adapter boundary: AttackUpdate fields, not core attack methods.
vm.runInContext(
  fs.readFileSync(new URL("../engine/ingame/auto-bot/gameApi.js", import.meta.url), "utf8"),
  sandbox,
);
const createGameApi = vm.runInContext("createGameApi", sandbox);
const clientOwn = {
  ...own,
  isPlayer: () => true,
  id: () => "actor",
  borderTiles: () => [0],
  incomingAttacks: () => [
    { id: "native-client-update", attackerID: 2, targetID: 1, troops: 40, retreating: false },
  ],
};
const clientTarget = { ...a, id: () => "target" };
const clientPlayers = new Map([
  [1, clientOwn],
  [2, clientTarget],
]);
const clientGame = {
  ...fixture.game,
  ticks: () => tick,
  players: () => [clientOwn, clientTarget],
  playerBySmallID: (sid) => clientPlayers.get(sid) ?? null,
  neighbors: () => [5],
  ownerID: () => 2,
  isLand: () => true,
  hasOwner: () => true,
};
const api = createGameApi(clientGame);
const clientFixture = new Fixture();
Object.assign(clientFixture, fixture, { game: api.game, player: api.wrapPlayer(clientOwn) });
const wrappedTarget = api.wrapPlayer(clientTarget);
assert.notEqual(clientFixture.player, clientOwn, "real client is wrapped by createGameApi");
assert.equal(typeof clientFixture.player.canAttackPlayer, "function");
assert.equal(typeof clientOwn.canAttackPlayer, "undefined");
await api.ensureBorderTiles(clientFixture.player);
const legalityStart = source.indexOf("    canAttackPlayerNow(");
const legalityEnd = source.indexOf("    async sendAttack(", legalityStart);
clientFixture.canAttackPlayerNow = vm.runInContext(
  `({${source.slice(legalityStart, legalityEnd)}}).canAttackPlayerNow`,
  sandbox,
);
policy.importModel(policy.createCompactModel({ featureProfile: "frontier-v1" }));
policy.configure({ mode: "shadow", learning: false });
await clientFixture.prepareHybridCombatGeometry([wrappedTarget]);
assert.equal(
  clientFixture.hybridCombatGeometry(wrappedTarget).frontier.incomingFromTargetTroops,
  40,
  "documented plain client AttackUpdate preserves actual incoming troops",
);
await policy.decide(clientFixture, [wrappedTarget]);
assert.equal(policy.proposal.candidateCount, 1, "actual adapter admits the current target");
assert.equal(
  policy.proposal.candidates[0].legal,
  null,
  "adapter fallback method is not proof of native legality",
);
clientOwn.canAttackPlayer = () => true;
await policy.decide(clientFixture, [wrappedTarget]);
assert.equal(policy.proposal.candidates[0].legal, true);
clientOwn.incomingAttacks = () => [{ attackerID: 99, targetID: 1, troops: 40, retreating: false }];
await clientFixture.prepareHybridCombatGeometry([wrappedTarget]);
assert.equal(
  clientFixture.hybridCombatGeometry(wrappedTarget).frontier,
  null,
  "unresolved client endpoint is malformed, never zero",
);
clientOwn.incomingAttacks = () => [{ attackerID: 2, targetID: 1, retreating: false }];
await clientFixture.prepareHybridCombatGeometry([wrappedTarget]);
assert.equal(
  clientFixture.hybridCombatGeometry(wrappedTarget).frontier,
  null,
  "missing troops never normalize to zero",
);
clientOwn.incomingAttacks = () => [{ attackerID: 2, targetID: 1, troops: 0, retreating: false }];
await clientFixture.prepareHybridCombatGeometry([wrappedTarget]);
assert.equal(
  clientFixture.hybridCombatGeometry(wrappedTarget).frontier.incomingFromTargetTroops,
  0,
);
assert.equal(
  policy.targetFeatures(clientFixture, wrappedTarget, policy.gateFeatures(clientFixture)).at(-1),
  1,
  "known client zero retains its incoming presence bit",
);

const Contract = vm.runInContext("HybridCombatContract", sandbox);
for (const featureProfile of [undefined, "frontier-v1"]) {
  const base = policy.createCompactModel({ featureProfile });
  const context = {
    engineRevision: "a".repeat(40),
    configHash: "b".repeat(64),
    resultHash: "c".repeat(64),
    experimentID: "return-import-fixture",
    runID: "fixture",
    modelIdentity: JSON.stringify(base),
    episodeId: 1,
    generation: 2,
    terminalTick: 1,
    actorSmallID: 1,
    terminalWin: true,
    gammaTick: 1,
    featureProfile,
  };
  const record = {
    ...context,
    featureVersion: base.schema,
    normalizer: base.normalizer,
    learned: true,
    confirmed: true,
    truncated: false,
    terminal: true,
    decisionStep: 0,
    action: "wait",
    controlledAction: "wait",
    actionTick: 0,
    outcomeTick: 1,
    targetSmallID: null,
    gate: [1, 0.5, 0.2, 0],
    features: null,
    geometry: null,
    receiptID: null,
  };
  const fitted = Contract.fitEpisodeReturns(base, [record], context).model;
  policy.configure({ learning: true });
  policy.importModel(fitted);
  assert.equal(policy.learning, false, "terminal return import disables online reward updates");
  assert.throws(() => policy.configure({ learning: true }), /Offline reward/);
  const before = JSON.stringify(policy.exportModel());
  policy.learn("wait", record.gate, 0.5);
  assert.equal(
    JSON.stringify(policy.exportModel()),
    before,
    "live land-delta samples cannot update episode-return heads",
  );
  policy.learning = true;
  assert.throws(() => policy.learnOutcome({ gate: record.gate }, 0.5), /Offline reward/);
  policy.learning = false;
  policy.importModel(base);
}
process.stdout.write("hybrid combat frontier integration tests passed\n");
