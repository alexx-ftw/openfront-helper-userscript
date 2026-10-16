// Scenario 3: deterministic two-owner Port seeds require shared water and both
// Ports complete before payout; async quotes must retain current eligibility.
import assert from "node:assert/strict";
import { createPortSeedQuoteFixture } from "./helpers/legendary-structure-fixture.mjs";
import {
  createTeamScenarioHarness,
  finishScenarios,
} from "./legendary-economy-team-scenario-helpers.mjs";

import { checkSeedProjectionAndPolicy } from "./helpers/legendary-economy-team/seed-policy-checks.mjs";
import { productionDecision } from "./helpers/legendary-economy-team/production.mjs";
import { waterFixture } from "./helpers/legendary-economy-team/water.mjs";

const harness = await createTeamScenarioHarness("legendary-economy-team-scenario-seed-pair.vm.js");
const {
  UNIT,
  liveCostOf,
  liveDurationOf,
  liveTradeShipGold,
  liveEconomyConfig,
  matchHorizonTicks,
  sandbox,
} = harness;
const portCost = liveCostOf(UNIT.Port);
const portTicks = liveDurationOf(UNIT.Port);
assert.ok(portTicks > 0, "live Config gives Port a nonzero construction duration");

checkSeedProjectionAndPolicy(harness);

// Actual construction completion, ship spawning and treasury payouts are not
// simulated here. The retained checks above assert only projected payout timing.
for (const id of [40, 41, 42, 43]) {
  const f = waterFixture(harness);
  f.actor.smallID = () => id;
  f.actor.id = () => id;
  const owners = [40, 41, 42, 43].map((otherId) =>
    otherId === id
      ? f.actor
      : {
          ...f.partner,
          id: () => otherId,
          smallID: () => otherId,
        },
  );
  f.behavior.game.players = () => owners;
  const decision = await productionDecision(f);
  assert.deepEqual(Array.from(f.behavior.legendaryPortSeedOwnerIds(-1)), ["40", "41"]);
  assert.equal(
    decision.selected?.type,
    id < 42 ? UNIT.Port : undefined,
    "only the deterministic two-owner seed pair is proposed by production",
  );
  assert.equal(decision.built, id < 42);
  assert.equal(f.emissions.length, Number(id < 42));
  if (id < 42) {
    assert.equal(decision.selected.seedPair, true);
    assert.deepEqual(f.emissions[0], {
      type: UNIT.Port,
      tile: 10,
      upgrade: false,
      cost: BigInt(portCost),
    });
  }
  f.behavior.game.players = () => [...owners].reverse();
  assert.equal(
    (await productionDecision(f, false)).selected?.type,
    id < 42 ? UNIT.Port : undefined,
    "enumeration order cannot change the pair",
  );
}
const noWater = waterFixture(harness);
noWater.controls.water = new Set();
const absent = await productionDecision(noWater);
assert.equal(
  absent.candidates.some((c) => c.type === UNIT.Port),
  false,
);
assert.equal(absent.built, false);
assert.equal(noWater.emissions.length, 0, "no pure-economy Port emits on ineligible water");

for (const routeSurvives of [true, false]) {
  const fixture = createPortSeedQuoteFixture(sandbox, {
    cost: BigInt(portCost),
    config: liveEconomyConfig,
    horizonTicks: matchHorizonTicks,
    arrivalGold: liveTradeShipGold(100) * 2,
    distance: 100,
  });
  const pending = fixture.behavior.maybeSpawnStructure(UNIT.Port, {
    legendaryEconomyPortTile: 10,
  });
  await fixture.quoteStarted;
  if (!routeSurvives) fixture.invalidateRoute();
  fixture.resolveQuote();
  assert.equal(await pending, routeSurvives, "revalidate shared water after the partner quote");
  assert.equal(fixture.emissions.length, Number(routeSurvives), "emit only while eligible");
}
process.stdout.write(
  "PASS seed pair: production pair/build, ineligible water and async revalidation\n",
);
finishScenarios();
