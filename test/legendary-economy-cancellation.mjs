import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

function fixture() {
  const sandbox = createLegendaryStructureSandbox({
    vmFilename: "legendary-economy-cancellation.vm.js",
  });
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  const generation = 7;
  Object.assign(sandbox.state, {
    tickGeneration: generation,
    activeTickGeneration: generation,
    tickInFlight: true,
  });
  sandbox.state.settings.enabled = true;
  sandbox.autoBotTickActionAllowed = () =>
    sandbox.state.settings.enabled === true &&
    sandbox.state.activeTickGeneration === sandbox.state.tickGeneration;
  let time = 0;
  sandbox.performance = { now: () => (time += 10) };
  const pending = [];
  sandbox.setTimeout = (resume) => pending.push(resume);
  const config = {
    unitInfo: () => ({ constructionDuration: 2 }),
    tradeShipSpawnRate: (roll, ships) => 20 + roll + Math.floor(ships / 2),
  };
  const options = () => ({
    cost: 10,
    horizonTicks: 256,
    config,
    inputs: {
      tradeShipCount: 2,
      hasCompletedTradePartner: true,
      portRoutes: [{ weight: 1, distance: 3, teamGoldPerArrival: 100 }],
      fleetProducerSupply: {
        portOwners: [
          {
            ownerId: "builder",
            ports: [{ level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 3 }] }],
          },
        ],
      },
    },
  });
  return { sandbox, behavior, pending, options, generation };
}

const run = fixture();
const oldState = run.sandbox.state;
const oldEvaluation = run.behavior.legendaryEconomyEvaluation("Port", run.options());
assert.equal(run.pending.length, 1, "real evaluation reaches its first cooperative timer");
// Match stopEngine: generation advances while the old tick retains its lock and
// active generation until its finally block. Restart only reenables settings.
oldState.settings.enabled = false;
oldState.tickGeneration++;
oldState.settings.enabled = true;
assert.equal(oldState.activeTickGeneration, run.generation);
assert.equal(oldState.tickInFlight, true);
run.pending.shift()();
assert.equal(await oldEvaluation, null, "stop/restart cancels the suspended old evaluation");
assert.equal(
  await run.behavior.legendaryEconomyEvaluation("Port", run.options()),
  null,
  "a second evaluation in the old chain cannot adopt the restarted generation",
);
assert.equal(run.pending.length, 0, "the rejected old chain schedules no more work");
// Match the old finally, then the beginning of the next genuine engine tick.
oldState.activeTickGeneration = null;
oldState.tickInFlight = false;
oldState.tickInFlight = true;
oldState.activeTickGeneration = oldState.tickGeneration;
run.sandbox.setTimeout = (resume) => queueMicrotask(resume);
const freshOptions = run.options();
const expected = run.sandbox.legendaryEconomyNetGold("Port", run.options());
const actual = await run.behavior.legendaryEconomyEvaluation("Port", freshOptions);
assert.ok(actual && actual.refused !== true, "the genuine new generation completes");
assert.deepEqual(actual, expected, "fresh async evaluation exactly matches synchronous arithmetic");

const identity = fixture();
const replacedEvaluation = identity.behavior.legendaryEconomyEvaluation("Port", identity.options());
assert.equal(identity.pending.length, 1);
identity.sandbox.state = {
  ...identity.sandbox.state,
  settings: { ...identity.sandbox.state.settings },
};
identity.pending.shift()();
assert.equal(
  await replacedEvaluation,
  null,
  "replacing global state invalidates the captured identity",
);

const failure = fixture();
const sentinel = new Error("unexpected native spawn-rate failure");
const failureOptions = failure.options();
failureOptions.config.tradeShipSpawnRate = () => {
  throw sentinel;
};
await assert.rejects(
  failure.behavior.legendaryEconomyEvaluation("Port", failureOptions),
  (error) => error === sentinel,
  "unexpected calculation errors propagate through the class facade",
);
process.stdout.write(
  "PASS economy cancellation: old-chain rejection, genuine restart, state identity and errors\n",
);
