    player,
  ),
  false,
);
assert.equal(tokens, 0, "veto runs before acquiring the sole token");
assert.equal(sends, 0);
assert.equal(vetoInput.tile, 0);
assert.equal(vetoInput.reservedGold, 0n);
context.window.__OFH_hybridStrategy.admitEconomicPurchase = () => ({ blocked: false });
assert.equal(
  context.sendAutoBotBuildOrUpgrade(
    menu,
    { type: "City", cost: 1n, canBuild: 4, canUpgrade: false },
    4,
    game,
    player,
  ),
  true,
);
assert.equal(tokens, 1);
assert.equal(sends, 1);
const safetyRows = [];
sandbox.window.__OFH_hybridSafety = (row) => safetyRows.push(row);
sandbox.hybridCombatPolicy = {
  mode: "learned",
  generation: 4,
  episodeId: 2,
  dispatch: { id: 7, generation: 4, targetSmallID: 2 },
  proposal: { step: 3, tick },
  allowsAttack: () => true,
};
let legalityCalls = 0;
attack.player = {
  ...own,
  canAttackPlayer: () => {
    legalityCalls++;
    return false;
  },
};
target.isPlayer = () => true;
target.id = () => "target";
assert.equal(await attack.sendAttack(target), false);
assert.equal(legalityCalls, 1, "capture the existing native check without repeating it");
assert.equal(safetyRows.length, 1, "rejected learned attempts remain visible");
assert.equal(safetyRows[0].legalityPassed, false);
assert.equal(safetyRows[0].emitted, false);
assert.equal(safetyRows[0].reservePassed, null);
assert.equal(safetyRows[0].step, 3);
attack.hybridSafetyAttempt = {};
attack.player.troops = () => 200;
attack.getLiveOutboundAttackTroopsForTarget = () => 0;
attack.shouldBlockInitialPlayerAttack = () => true;
const deniedReserve = {
  target: { isPlayer: () => true, troops: () => 10 },
  targetTroops: 10,
  targetSpendableTroops: 2,
  finalSpendableTroops: 2,
  defenseProfile: null,
  force: false,
};
assert.equal(attack.calculateRegularLandAttackTroops(deniedReserve), 0);
assert.equal(
  attack.hybridSafetyAttempt.reservePassed,
  false,
  "actual native insufficient-reserve branch is reported while blocked",
);
attack.hybridSafetyAttempt = null;

let dangerCalls = 0;
sandbox.window.__OFH_hybridStrategy = {
  transportCommitment: (_context, id) => ({ id, status: "unconfirmed", arrivalTick: null }),
};
sandbox.UNIT.TransportShip = "Transport Ship";
attack.player.units = () => [{ id: () => 9 }];
attack.boatLaunchWarshipDangerGateActive = () => true;
attack.boatWarshipDangerRadius = () => 1;
attack.hostileWarshipNearDestination = () => {
  dangerCalls++;
  return false;
};
attack.hostileHunterCoversCorridor = () => {
  dangerCalls++;
  return true;
};
assert.equal(attack.boatLaunchWarshipDanger(4), true);
assert.equal(dangerCalls, 2, "reuse the existing destination and corridor guard results");
assert.equal(attack.hybridBoatRisk.transports[0].status, "unconfirmed");
assert.equal(
  attack.hybridBoatRisk.transports[0].arrivalTick,
  null,
  "missing native arrival never becomes a predicted landing",
);

let inferenceCalls = 0;
let timingRows = 0;
sandbox.performance = { now: () => 1 };
sandbox.window.__OFH_hybridDecisionTiming = () => {
  timingRows++;
};
sandbox.hybridCombatPolicy.backend = "compact-tanh-v1";
const callerIdentity = {
  generation: sandbox.hybridCombatPolicy.generation,
  episodeId: sandbox.hybridCombatPolicy.episodeId,
  step: 3,
  tick,
  ingressSequence: 0,
  actorSmallID: own.smallID(),
  modelIdentity: "fixture-original-model",
  decisionSequence: null,
  decisionReferenceKind: null,
};
const geometryCancellations = [];
sandbox.hybridCombatPolicy.enabled = () => true;
sandbox.hybridCombatPolicy.decisionIdentity = (behavior) => {
  assert.equal(behavior, attack);
  return callerIdentity;
};
sandbox.hybridCombatPolicy.recordGeometryCancellation = (identity, suppliedTargets, reason) => {
  geometryCancellations.push({ identity, suppliedTargets, reason });
};
sandbox.hybridCombatPolicy.decide = async () => {
  inferenceCalls++;
  return true;
};
attack.prepareHybridCombatGeometry = async () => {
  sandbox.hybridCombatPolicy.generation++;
};
assert.equal(
  await attack.decideHybridCombat([target]),
  false,
  "generation change cancels geometry inference",
);
assert.equal(inferenceCalls, 0);
assert.equal(timingRows, 1, "actual abstained geometry work still has measured latency");
assert.deepEqual(
  geometryCancellations,
  [{ identity: callerIdentity, suppliedTargets: 1, reason: "cancelled-generation" }],
  "enabled caller retains the original identity across geometry cancellation",
);
sandbox.hybridCombatPolicy.enabled = () => false;
sandbox.hybridCombatPolicy.decisionIdentity = () => {
  assert.fail("disabled policy has no decision identity");
};
assert.equal(await attack.decideHybridCombat([target]), false);
assert.equal(
  geometryCancellations.length,
  1,
  "disabled caller creates no policy cancellation observation",
);
assert.equal(inferenceCalls, 0);
assert.equal(timingRows, 2);

let factoryCalls = 0;
let adaptive = true;
const links = {};
const Stub = class Behavior {};
const nationRealm = {
  window: {
    __OFH_hybridStrategy: {
      reset() {},
      configure: (config) => {
        links.enabled = config.enabled;
      },
      createStructureBehavior: () => {
        factoryCalls++;
        return links;
      },
    },
  },
  state: { settings: { winFixes: true } },
  isLegendaryDifficulty: () => adaptive,
  EmojiBehavior: Stub,
  MirvBehavior: Stub,
  AllianceBehavior: Stub,
  WarshipBehavior: Stub,
  AttackBehavior: Stub,
  NukeBehavior: Stub,
  StructureBehavior: Stub,
};
executeClassicScript(
  readRepositoryFile("engine/ingame/auto-bot/nationExecution.js") +
    "\nglobalThis.NationBot=NationBot;",
  nationRealm,
);
const nation = Object.create(nationRealm.NationBot.prototype);
Object.assign(nation, { random: {}, mg: game, player });
nation.initializeBehaviors();
assert.equal(factoryCalls, 1, "Nation selects the optional factory");
assert.equal(nation.nukeBehavior.structureBehavior, nation.structureBehavior);
assert.equal(nation.warshipBehavior.structureBehavior, nation.structureBehavior);
