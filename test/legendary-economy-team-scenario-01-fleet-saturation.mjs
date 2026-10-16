// Native-price crossover driven by live Config rates and production decisions.
import assert from "node:assert/strict";
import {
  createTeamScenarioHarness,
  networkStation,
} from "./legendary-economy-team-scenario-helpers.mjs";
import {
  productionFixture,
  productionDecision,
} from "./helpers/legendary-economy-team/production.mjs";
import { waterFixture } from "./helpers/legendary-economy-team/water.mjs";

const h = await createTeamScenarioHarness("team-fleet-production.vm.js");
const { UNIT, sandbox, liveConfig } = h;
for (const type of [UNIT.Factory, UNIT.Port]) {
  const factory = type === UNIT.Factory;
  const fixture = factory
    ? productionFixture(h, { City: [networkStation(33, 30, 1)] })
    : waterFixture(h, { Port: [networkStation(34, 20, 1)] });
  const fleetKey = factory ? "trains" : "ships";
  const plateau = factory ? h.saturatedTrainCount(1) : h.saturatedTradeShipCount();
  const rate = factory
    ? (count) => liveConfig.trainSpawnRate(1, count)
    : (count) => liveConfig.tradeShipSpawnRate(0, count);
  assert.ok(
    plateau > 0 && rate(plateau) >= rate(0) * 2,
    `${type}: live Config supplies the doubled-denominator count`,
  );
  // Locate the first profitable *remaining match time*, keeping the native price.
  // This avoids the trade pity timer's positive full-match payout floor.
  let low = 1;
  let high = h.matchHorizonTicks;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    fixture.controls.tick = h.matchHorizonTicks - middle;
    if ((await productionDecision(fixture, false)).selected?.type === type) high = middle;
    else low = middle;
  }
  fixture.controls.tick = h.matchHorizonTicks - high;
  const open = await productionDecision(fixture);
  assert.equal(open.selected?.type, type, `${type}: production selects the open-fleet build`);
  assert.equal(open.built, true, `${type}: production dispatch emits the selected build`);
  assert.deepEqual(fixture.emissions, [
    { type, tile: factory ? 20 : 10, upgrade: false, cost: BigInt(h.liveCostOf(type)) },
  ]);
  assert.ok(open.selected.netTeamGold > 0n, "open fleet pays the native current price");
  assert.equal(open.selected.cost, liveConfig.unitInfo(type).cost({}, fixture.actor));

  let count = plateau;
  let saturated;
  do {
    assert.ok(Number.isSafeInteger(count), "live-rate crossover must be representable");
    fixture.controls[fleetKey] = count;
    saturated = await productionDecision(fixture, false);
    if (!saturated.selected) break;
    count *= 2;
  } while (saturated.selected);
  const state = fixture.behavior.legendaryConstructionState();
  const evaluation = sandbox.legendaryEconomyNetGold(type, {
    cost: Number(open.selected.cost),
    horizonTicks: state.economyHorizonTicks,
    inputs: state.economyInputs,
    config: liveConfig,
  });
  assert.ok(
    evaluation.refused === true || evaluation.netTeamGold <= 0,
    `${type}: saturation makes the same native-price investment nonpositive`,
  );
  assert.equal(saturated.groups.flat().length, 0, `${type}: production ranking skips saturation`);
  assert.equal(
    await fixture.behavior.runLegendaryConstructionGroups(3, saturated.candidates, true, false),
    false,
    "no saturated build is dispatched",
  );
  assert.equal(fixture.emissions.length, 1, "saturation cannot emit another build");
  process.stdout.write(
    `PASS saturation ${type}: cost=${open.selected.cost}, fleet=${count}, remaining=${high}, net=${evaluation.netTeamGold}\n`,
  );
}
