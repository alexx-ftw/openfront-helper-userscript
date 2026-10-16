// Policy expectation: an ally stop contributes less than the same teammate
// stop, expiry reduces it further, and allied gold never funds the builder.
import assert from "node:assert/strict";
import {
  createTeamScenarioHarness,
  economyAction,
  finishScenarios,
  makeRailNetwork,
  networkStation,
  railEconomyInputs,
  scenario,
} from "./legendary-economy-team-scenario-helpers.mjs";

import {
  productionFixture,
  productionDecision,
} from "./helpers/legendary-economy-team/production.mjs";
import { waterFixture } from "./helpers/legendary-economy-team/water.mjs";

const h = await createTeamScenarioHarness("legendary-economy-team-scenario-ally.vm.js");
const { UNIT, liveCostOf, liveEconomyConfig, matchHorizonTicks, sandbox } = h;
const cost = liveCostOf(UNIT.Factory);
const project = (partnerIsAlly, allianceTicksRemaining) => {
  const { behavior } = makeRailNetwork(
    h,
    { City: [networkStation(41, 30, 1)] },
    { partnerIsAlly, allianceTicksRemaining },
  );
  const inputs = railEconomyInputs(behavior);
  const value = sandbox.legendaryEconomyNetGold(UNIT.Factory, {
    cost,
    horizonTicks: matchHorizonTicks,
    inputs,
    config: liveEconomyConfig,
  });
  return { inputs, value };
};

scenario("ally: teammate route exceeds permanent and expiring ally routes", () => {
  const teammate = project(false, Infinity);
  const ally = project(true, Infinity);
  const expiringAlly = project(true, Math.floor(matchHorizonTicks / 4));
  assert.ok(teammate.inputs.factoryPaidStops > 0, "the teammate City is a paid rail stop");
  assert.ok(ally.inputs.factoryPaidStops > 0, "the eligible ally City remains tradeable");
  assert.ok(
    ally.value.netTeamGold < teammate.value.netTeamGold,
    `the ally route is discounted (ally=${ally.value.netTeamGold}, team=${teammate.value.netTeamGold})`,
  );
  assert.ok(
    expiringAlly.value.netTeamGold < ally.value.netTeamGold,
    "finite alliance expiry discounts the same ally route further",
  );
});

scenario("ally: teammate treasury cannot clear the builder's cost gate", () => {
  const profitable = project(false, Infinity).value;
  assert.ok(profitable.refused !== true && profitable.netTeamGold > 0, "route has positive value");
  const candidate = economyAction(UNIT.Factory, cost, profitable);
  const ranked = sandbox.rankLegendaryConstructionActions([candidate], {
    gold: BigInt(cost) - 1n,
    reserve: 0n,
    allyGold: 10_000_000_000n,
  });
  assert.ok(
    !ranked.some((action) => action.action === "build"),
    "the builder one gold below live Config cost cannot build despite allyGold",
  );
});

for (const type of [UNIT.Factory, UNIT.Port]) {
  const f =
    type === UNIT.Factory
      ? productionFixture(h, { City: [networkStation(41, 30, 1)] }, { partnerIsAlly: true })
      : waterFixture(h, { Port: [networkStation(41, 20, 1)] }, { partnerIsAlly: true });
  f.partner.gold = () => 10_000_000_000n;
  const price = h.liveConfig.unitInfo(type).cost({}, f.actor);
  f.controls.cash = price;
  const planned = await productionDecision(f, false);
  assert.equal(planned.selected?.type, type, "own cash initially funds the profitable candidate");
  let quotes = 0;
  f.controls.afterQuote = () => {
    quotes++;
    f.controls.cash = price - 1n;
  };
  assert.equal(
    await f.behavior.runLegendaryConstructionGroups(3, planned.candidates, true, false),
    false,
    "post-quote builder affordability vetoes dispatch",
  );
  assert.equal(quotes, 1, "the cash change occurs at the async placement quote boundary");
  assert.equal(f.emissions.length, 0, "an ally's treasury never funds the builder");
  assert.equal(f.behavior.availableGoldAfterReserve(type), price - 1n);
  f.controls.cash = price;
  f.controls.afterQuote = () => {};
  assert.equal(
    await f.behavior.runLegendaryConstructionGroups(3, planned.candidates, true, false),
    true,
    "restoring the builder's own cash permits emission",
  );
  assert.deepEqual(f.emissions, [
    { type, tile: type === UNIT.Factory ? 20 : 10, upgrade: false, cost: price },
  ]);
  process.stdout.write(`PASS affordability ${type}: own post-quote cash gates emission\n`);
}
finishScenarios();
