import assert from "node:assert/strict";
import { createAttackBehaviorSandbox } from "#test/helpers/attack-behavior-sandbox.mjs";
import { executeClassicScript, readRepositoryFile } from "#test/helpers/repository-fixture.mjs";
import { readStructureBehaviorSource } from "#test/helpers/structure-behavior-source.mjs";
import { outcomeTransitionFlags } from "#scripts/headless/hybrid-evaluation-contract.mjs";

// Production callers, not a second policy implementation. Removing the native
// geometry bridge or final purchase veto must fail these assertions.
const sandbox = createAttackBehaviorSandbox();
sandbox.window = {};
{
  const source = readRepositoryFile("scripts/headless/opponent-adapter.js");
  const start = source.indexOf("function cancelledHybridOutcome(");
  const end = source.indexOf("function hybridCollectionPolicy(", start);
  assert.ok(start >= 0 && end > start);
  const cancel = executeClassicScript(source.slice(start, end) + "\ncancelledHybridOutcome", {});
  const pending = {
    target: null,
    tick: 10,
    episodeId: 1,
    generation: 2,
    collectorControl: true,
    controlledAction: "wait",
    decisionStep: 3,
    decisionSequence: 7,
    learned: false,
    behaviorPolicy: "coverage-driven-safe-wait-collection-v1",
  };
  const outcome = cancel(pending, "env_error", { tick: 11 }, 8);
  assert.equal(outcome.collectorControl, true, "censor preserves actual collector provenance");
  assert.equal(outcome.behaviorPolicy, pending.behaviorPolicy);
  assert.equal(outcome.decisionSequence, 7);
  assert.equal(outcome.learned, false);
  assert.equal(outcome.reward, null);
  assert.equal(outcome.envError, true);
  assert.equal(
    cancel({ ...pending, collectorControl: false }, "reset", null, 9).collectorControl,
    undefined,
  );
}
{
  const source = readRepositoryFile("scripts/headless/opponent-adapter.js");
  const start = source.indexOf("function hybridCollectionPolicy(");
  const end = source.indexOf("function createBundledHarnessSource(", start);
  assert.ok(start >= 0 && end > start);
  const processFixture = { env: {} };
  const configure = executeClassicScript(source.slice(start, end) + "\nconfigureHybridCombat", {
    process: processFixture,
  });
  let configured;
  const window = {
    __OFH_hybridCombat: {
      configure: (value) => {
        configured = value;
      },
      importModel() {},
      exportModel() {},
      diagnostics() {},
    },
  };
  configure(window, "shadow");
  assert.equal(configured.collectionPolicy, null, "default shadow stays observational");
  processFixture.env.OFH_HYBRID_COLLECTION_POLICY = "unknown";
  assert.throws(() => configure(window, "shadow"), /Unsupported hybrid collection policy/);
  processFixture.env.OFH_HYBRID_COLLECTION_POLICY = "coverage-wait-v1";
  configure(window, "shadow", { learning: true });
  assert.equal(configured.collectionPolicy, "coverage-wait-v1");
  assert.equal(configured.learning, true);
  assert.equal(window.__OFH_hybridCombatRun.collectionPolicy, "coverage-wait-v1");
  configure(window, "shadow", { collectionPolicy: null });
  assert.equal(configured.collectionPolicy, null, "explicit clearing overrides environment opt-in");
  delete processFixture.env.OFH_HYBRID_COLLECTION_POLICY;
  configure(window, "shadow");
  assert.equal(
    configured.collectionPolicy,
    null,
    "reconfiguration without opt-in clears collector",
  );
  configure(window, "learned", { learning: true });
  assert.equal(configured.learning, false, "frozen learned mode cannot collect");
  configure(window, "baseline", { learning: true });
  assert.equal(configured.learning, false, "baseline cannot collect");
}
{
  const adapterSource = readRepositoryFile("scripts/headless/opponent-adapter.js");
  const start = adapterSource.indexOf("export class HybridRuntimeEvidence");
  const end = adapterSource.indexOf("// Experimental headless transport only.", start);
  assert.ok(start >= 0 && end > start);
  const Evidence = executeClassicScript(
    adapterSource.slice(start, end).replace("export class", "class") + "\nHybridRuntimeEvidence",
    { structuredClone, outcomeTransitionFlags },
  );
  const evidence = new Evidence({ runIdentity: "attack-admission-test" });
  evidence.admission({
    tick: 10,
    actorSmallID: 1,
    targetSmallID: 2,
    emitted: false,
    reason: "capture-reserve-insufficient",
  });
  evidence.admission({ tick: 11, actorSmallID: 1, targetSmallID: 2, emitted: true, reason: null });
  assert.deepEqual(evidence.snapshot().attackAdmissions, {
    attempts: 2,
    accepted: 1,
    rejected: 1,
    errors: 0,
    reasons: { "capture-reserve-insufficient": 1 },
  });
  assert.equal(
    evidence.snapshot().ledger.entries.length,
    0,
    "dispatch diagnostics do not forge policy events",
  );
}
sandbox.withTimeout = async (promise) => promise;
sandbox.WORKER_TIMEOUT_MS = 100;
const attack = Object.create(sandbox.AttackBehavior.prototype);
let tick = 10;
const own = { smallID: () => 1, borderTiles: () => new Set([0, 1]) };
const target = { smallID: () => 2, borderTiles: () => new Set([8, 9]) };
attack.player = own;
attack.game = {
  ticks: () => tick,
  width: () => 10,
  height: () => 10,
  x: (tile) => tile % 10,
  y: (tile) => Math.floor(tile / 10),
};
assert.equal(
  typeof attack.prepareHybridCombatGeometry,
  "function",
  "native geometry preparation exists",
);
assert.equal(attack.hybridCombatGeometry(target), null, "no unstamped cached geometry");
await attack.prepareHybridCombatGeometry([target]);
const geometry = attack.hybridCombatGeometry(target);
assert.equal(geometry.tick, tick);
assert.equal(geometry.targetSmallID, 2);
assert.equal(geometry.own.x, 0.5);
assert.equal(geometry.target.x, 8.5);
tick++;
assert.equal(attack.hybridCombatGeometry(target), null, "geometry never crosses ticks");
const drifting = {
  ...target,
  borderTiles: async () => {
    tick++;
    return new Set([8]);
  },
};
await attack.prepareHybridCombatGeometry([drifting]);
assert.equal(attack.hybridCombatGeometry(target), null, "async drift abstains");

let tokens = 0;
let sends = 0;
let vetoInput;
const player = { smallID: () => 1, gold: () => 100n, isAlive: () => true };
const game = { ticks: () => 1 };
const context = {
  window: {
    __OFH_hybridStrategy: {
      admitEconomicPurchase: (input) => {
        vetoInput = input;
        return { blocked: true, notBeforeTick: 2 };
      },
    },
  },
  hasIntentRateLimitCapacity: () => true,
  tryAcquireIntentRateLimit: () => {
    tokens++;
    return true;
  },
};
executeClassicScript(readRepositoryFile("engine/ingame/auto-bot/context.js"), context);
context.discoverCtors = () => ({ buildUnit: class BuildUnit {} });
const menu = {
  eventBus: {
    emit: () => {
      sends++;
    },
  },
  sendBuildOrUpgrade: () => {
    sends++;
  },
};
assert.equal(
  context.sendAutoBotBuildOrUpgrade(
    menu,
    { type: "City", cost: 1n, canBuild: 0, canUpgrade: false },
    0,
    game,
