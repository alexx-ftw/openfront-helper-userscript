import assert from "node:assert/strict";
import process from "node:process";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

function fixture(onYield = () => {}) {
  let yields = 0;
  const context = {
    performance,
    setTimeout: (resume) =>
      setTimeout(() => {
        onYield(++yields);
        resume();
      }, 0),
  };
  executeClassicScript(readLegendaryPlannerSource(), context, {
    filename: "projection-cooperative.vm.js",
  });
  const inputs = {
    trainCount: 7.25,
    tradeShipCount: 9.5,
    fleetProducerSupply: {
      trainLifetimeTicks: 13,
      trainOwners: [
        { isBuilder: true, factoryCount: 4, factories: [{ level: 2, readyAtTicks: 3.5 }] },
      ],
      portOwners: [
        {
          ownerId: "builder",
          ports: [
            {
              level: 2,
              readyAtTicks: 2,
              routes: [
                { weight: 3, distance: 11.5 },
                { weight: 2, distance: 17 },
              ],
            },
          ],
        },
      ],
      initialTradeShipRemainingTicks: [2, 4.5, 18],
    },
  };
  const config = {
    trainSpawnRate: (factories, trains) => 25 + factories + Math.floor(trains / 3),
    tradeShipSpawnRate: (roll, ships) => 20 + roll + Math.floor(ships / 2),
  };
  const candidate = {
    factoryReadyAt: 4,
    factoryCountReadyAt: 0,
    builderFactoryCount: 4,
    portReadyAt: 6,
    portRoutes: [{ weight: 1, distance: 9 }],
  };
  const steps = () => context.legendaryProjectEconomyFleetsSteps(inputs, config, 256, candidate);
  const caches = context.legendaryEconomyRateCaches(inputs.fleetProducerSupply, config);
  let prefixPublications = 0;
  const originalSet = caches.tradePrefixes.set.bind(caches.tradePrefixes);
  caches.tradePrefixes.set = (...args) => {
    prefixPublications++;
    return originalSet(...args);
  };
  return {
    context,
    inputs,
    config,
    candidate,
    steps,
    caches,
    yields: () => yields,
    prefixPublications: () => prefixPublications,
  };
}
function equalFleet(left, right) {
  for (const phase of ["before", "after"])
    for (const key of ["trainCounts", "tradeShipCounts"]) {
      assert.equal(left[phase][key].length, right[phase][key].length);
      for (let tick = 0; tick < left[phase][key].length; tick++) {
        assert.ok(
          Object.is(left[phase][key][tick], right[phase][key][tick]),
          `${phase}.${key}[${tick}]`,
        );
      }
    }
}
const expectedFixture = fixture();
const expected = expectedFixture.context.legendaryProjectEconomyFleets(
  expectedFixture.inputs,
  expectedFixture.config,
  256,
  expectedFixture.candidate,
);
const asyncFixture = fixture();
const actual = await asyncFixture.context.legendaryRunEconomyStepsAsync(asyncFixture.steps(), {
  sliceMs: 0,
});
equalFleet(actual, expected);
assert.ok(
  asyncFixture.yields() >= 8,
  "both baseline and candidate yield at native-tick checkpoints",
);

const before = fixture();
let started = false;
const neverStart = {
  next: () => {
    started = true;
    throw new Error("must not start");
  },
  return: () => ({ done: true }),
};
assert.equal(
  await before.context.legendaryRunEconomyStepsAsync(neverStart, { isCurrent: () => false }),
  null,
);
assert.equal(started, false);
assert.equal(before.caches.baseline.size, 0);

for (const cancelAt of [1, 5]) {
  let current = true;
  const canceled = fixture((count) => {
    if (count === cancelAt) current = false;
  });
  const iterator = canceled.steps();
  assert.equal(
    await canceled.context.legendaryRunEconomyStepsAsync(iterator, {
      sliceMs: 0,
      isCurrent: () => current,
    }),
    null,
  );
  assert.equal(iterator.next().done, true, "cancellation closes the suspended generator");
  assert.equal(canceled.caches.candidates.size, 0, "partial candidate never publishes");
  assert.equal(
    canceled.caches.baseline.size,
    cancelAt === 1 ? 0 : 1,
    "only a fully completed baseline may be reused",
  );
  assert.equal(
    canceled.prefixPublications(),
    cancelAt === 1 ? 0 : 1,
    "partial arrays never enter the prefix cache",
  );
  // A new generation can reuse only completed work and returns exact fresh output.
  current = true;
  const restarted = await canceled.context.legendaryRunEconomyStepsAsync(canceled.steps(), {
    sliceMs: 0,
    isCurrent: () => current,
  });
  equalFleet(restarted, expected);
}

const completed = fixture();
let current = true;
const original = completed.steps();
const invalidateOnCompletion = {
  next: () => {
    const step = original.next();
    if (step.done) current = false;
    return step;
  },
  return: () => original.return(),
};
assert.equal(
  await completed.context.legendaryRunEconomyStepsAsync(invalidateOnCompletion, {
    sliceMs: 0,
    isCurrent: () => current,
  }),
  null,
  "generation invalidated at completion cannot return stale output",
);

const failure = fixture();
const sentinel = new Error("unexpected live Config failure");
failure.config.tradeShipSpawnRate = () => {
  throw sentinel;
};
const failedIterator = failure.steps();
await assert.rejects(
  failure.context.legendaryRunEconomyStepsAsync(failedIterator, { sliceMs: 0 }),
  (error) => error === sentinel,
);
assert.equal(failedIterator.next().done, true);
assert.equal(failure.caches.baseline.size, 0);
assert.equal(failure.caches.candidates.size, 0);
assert.equal(failure.prefixPublications(), 0);
process.stdout.write(
  "PASS cooperative projection: exact async/sync, cancellation, restart, cache publication and errors\n",
);
