// Policy expectation: a horizon shorter than the live-Config payback window
// refuses investment; a safe full-match horizon can invest while reserve stays intact.
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

const h = await createTeamScenarioHarness("legendary-economy-team-scenario-horizon.vm.js");
const { UNIT, liveCostOf, liveEconomyConfig, matchHorizonTicks, sandbox } = h;
const cost = liveCostOf(UNIT.Factory);
const { behavior } = makeRailNetwork(h, { City: [networkStation(41, 30, 1)] });
const inputs = railEconomyInputs(behavior);
const valueAt = (horizonTicks) =>
  sandbox.legendaryEconomyNetGold(UNIT.Factory, {
    cost,
    horizonTicks,
    inputs,
    config: liveEconomyConfig,
  });

scenario("horizon: break-even cutoff refuses short payback and permits safe investment", () => {
  const fullMatch = valueAt(matchHorizonTicks);
  assert.ok(
    fullMatch.refused !== true && fullMatch.netTeamGold > 0,
    "full live match horizon pays back",
  );
  assert.equal(valueAt(1)?.refused, true, "near-zero horizon refuses the unfinished investment");

  let low = 1;
  let high = matchHorizonTicks;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const quote = valueAt(middle);
    if (quote?.refused !== true && quote?.netTeamGold > 0) high = middle;
    else low = middle;
  }
  const pastPayback = valueAt(high - 1);
  assert.ok(
    pastPayback?.refused === true || pastPayback?.netTeamGold <= 0,
    "one tick before the Config-derived payback horizon is not profitable",
  );
  assert.equal(
    sandbox.rankLegendaryConstructionActions(
      [economyAction(UNIT.Factory, cost, pastPayback)].filter(Boolean),
      { gold: BigInt(cost) * 2n, reserve: BigInt(cost) },
    ).length,
    0,
    "the portfolio refuses an economy build whose payback exceeds the remaining horizon",
  );

  const safeCash = BigInt(cost) * 2n;
  const reserve = BigInt(cost);
  const ranked = sandbox.rankLegendaryConstructionActions(
    [economyAction(UNIT.Factory, cost, fullMatch)].filter(Boolean),
    { gold: safeCash, reserve },
  );
  assert.equal(safeCash - reserve, BigInt(cost), "the reserve remains fully untouched");
  assert.equal(ranked[0]?.type, UNIT.Factory, "positive payback wins with cost and reserve funded");
});

const f = productionFixture(h, { City: [networkStation(41, 30, 1)] });
const full = await productionDecision(f);
assert.equal(f.behavior.legendaryConstructionState().economyHorizonTicks, matchHorizonTicks);
assert.equal(full.selected?.type, UNIT.Factory);
assert.equal(full.built, true);
f.controls.tick = matchHorizonTicks - 1;
assert.equal(
  f.behavior.legendaryConstructionState().economyHorizonTicks,
  1,
  "remaining match timer drives the production horizon",
);
const short = await productionDecision(f);
assert.equal(short.groups.flat().length, 0);
assert.equal(short.built, false, "no unfinished Factory emits near the actual match deadline");
assert.equal(f.emissions.length, 1);

// The first-Atom reserve is calculated by production from a completed Silo,
// a real hostile structure target and the current native Atom price.
const reserved = productionFixture(
  h,
  { City: [networkStation(41, 30, 1)] },
  {
    actorUnits: { MissileSilo: [networkStation(90, 40, 1)] },
  },
);
const hostile = { ...reserved.partner, smallID: () => 99, teamId: 8 };
reserved.behavior.game.players = () => [reserved.actor, reserved.partner, hostile];
sandbox.playersArePermanentTeammates = (left, right) => left.isOnSameTeam(right);
reserved.behavior.ownSamCapacity = () => 1; // Military coverage is outside this fixture.
delete reserved.behavior.legendaryAtomWarChest;
const reserve = reserved.behavior.legendaryAtomWarChest();
assert.equal(reserve, BigInt(h.liveCostOf(UNIT.AtomBomb)));
assert.ok(reserve > 0n);
const nativeCost = h.liveConfig.unitInfo(UNIT.Factory).cost({}, reserved.actor);
reserved.controls.cash = reserve + nativeCost - 1n;
assert.equal(reserved.behavior.availableGoldAfterReserve(UNIT.Factory), nativeCost - 1n);
const held = await productionDecision(reserved);
assert.equal(held.built, false, "production reserve prevents economic spending into the war chest");
assert.equal(reserved.emissions.length, 0);
reserved.controls.cash++;
const funded = await productionDecision(reserved);
assert.equal(funded.selected?.type, UNIT.Factory);
assert.equal(funded.built, true);
assert.equal(
  reserved.controls.cash - funded.selected.cost,
  reserve,
  "emitted cost leaves the entire production-calculated reserve intact",
);
process.stdout.write(
  "PASS horizon/reserve: real match timer and first-Atom reserve gate dispatch\n",
);
finishScenarios();
