// Scenario 2 (falsifiable): a landlocked builder prices a Factory through the
// only paid stop in its reachable rail cluster. Policy expectation: a paid
// teammate City or Port stop makes the first Factory profitable; removing the
// stop refuses it; binding troop-cap pressure (the live 0.9 ratio) lets the
// capacity-priority City win the portfolio instead.
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

const harness = await createTeamScenarioHarness("legendary-economy-team-scenario-landlocked.vm.js");
const { UNIT, liveCostOf, liveEconomyConfig, sandbox } = harness;
const HORIZON_TICKS = harness.matchHorizonTicks;

scenario("landlocked: paid teammate stop funds a Factory; no stop refuses it", () => {
  const factoryCost = liveCostOf(UNIT.Factory);
  const priceFactory = (partnerUnits) => {
    const { behavior } = makeRailNetwork(harness, partnerUnits);
    const inputs = railEconomyInputs(behavior);
    return {
      inputs,
      value: sandbox.legendaryEconomyNetGold(UNIT.Factory, {
        cost: factoryCost,
        horizonTicks: HORIZON_TICKS,
        inputs,
        config: liveEconomyConfig,
      }),
    };
  };
  const cityStop = priceFactory({ City: [networkStation(33, 30, 1)] });
  assert.equal(
    cityStop.inputs.factoryPaidStops,
    1,
    "the reachable teammate City is exactly one paid Factory stop",
  );
  assert.ok(
    cityStop.value.refused !== true && cityStop.value.netTeamGold > 0,
    "the paid teammate City makes the first Factory profitable under live Config " +
      "(net=" +
      cityStop.value.netTeamGold +
      ")",
  );
  const portStop = priceFactory({ Port: [networkStation(34, 31, 1)] });
  assert.equal(
    portStop.inputs.factoryPaidStops,
    1,
    "a reachable teammate Port is also a paid Factory stop",
  );
  assert.ok(
    portStop.value.refused !== true && portStop.value.netTeamGold > 0,
    "the paid teammate Port also funds the Factory (net=" + portStop.value.netTeamGold + ")",
  );
  const noStop = priceFactory({});
  assert.equal(noStop.inputs.factoryPaidStops, 0, "an empty cluster has no paid stop");
  assert.equal(
    noStop.value.refused,
    true,
    "removing the paid stop refuses the pure-economy Factory",
  );
});

await scenario(
  "landlocked: Factory beats a non-binding City; cap pressure flips to City",
  async () => {
    // The shared sandbox defaults winFixes off; enable the live pressure gate
    // explicitly so this fixture exercises the documented 0.9 cap threshold.
    sandbox.state.settings.winFixes = true;
    const { behavior } = makeRailNetwork(harness, { City: [networkStation(33, 30, 1)] });
    const factoryValue = sandbox.legendaryEconomyNetGold(UNIT.Factory, {
      cost: liveCostOf(UNIT.Factory),
      horizonTicks: HORIZON_TICKS,
      inputs: railEconomyInputs(behavior),
      config: liveEconomyConfig,
    });
    assert.ok(
      factoryValue.refused !== true && factoryValue.netTeamGold > 0,
      "the paid-stop Factory is profitable before ranking",
    );
    const cityCandidate = async (capPressure) => {
      const candidates = [];
      const capBehavior = Object.create(sandbox.__StructureBehavior.prototype);
      capBehavior.cost = () => BigInt(liveCostOf(UNIT.City));
      capBehavior.addLegendaryConstructionCandidate = (_context, type, values) =>
        candidates.push({ type, ...values });
      capBehavior.legendaryCityUpgradeCandidateInfo = () => null;
      await capBehavior.addLegendaryCityCandidates(
        { candidates: [] },
        { citiesDisabled: false, cityCount: 3, capPressure, strategicState: { railNeed: 0 } },
      );
      const city = candidates.find((candidate) => candidate.type === UNIT.City);
      assert.ok(city, "the production City candidate is emitted");
      return city;
    };
    const portfolioWith = (city) =>
      sandbox.rankLegendaryConstructionActions(
        [
          economyAction(UNIT.Factory, liveCostOf(UNIT.Factory), factoryValue),
          {
            type: UNIT.City,
            action: "build",
            cost: BigInt(liveCostOf(UNIT.City)),
            gold: 0,
            troops: 0,
            defense: 0,
            netTeamGold: 0n,
            capacity: city.capacity,
          },
        ],
        { gold: 100_000_000n },
      );
    // Live 0.9 pressure ratio: 35/100 troops is no pressure, 95/100 is.
    const pressureAt = (troops) => {
      const capBehavior = Object.create(sandbox.__StructureBehavior.prototype);
      Object.assign(capBehavior, {
        game: { config: () => ({ maxTroops: () => 100 }) },
        player: { troops: () => troops },
        safeMaxTroops: () => 100,
        legendaryThinDensityPressure: () => false,
      });
      return capBehavior.computeTroopCapPressure(false);
    };
    assert.equal(pressureAt(35), false, "35% of cap leaves the builder unpressured");
    assert.equal(pressureAt(95), true, "95% of cap is binding pressure");
    assert.equal(
      portfolioWith(await cityCandidate(false))[0]?.type,
      UNIT.Factory,
      "without cap pressure the profitable Factory beats the non-binding City",
    );
    assert.equal(
      portfolioWith(await cityCandidate(true))[0]?.type,
      UNIT.City,
      "binding troop-cap pressure lets the capacity City outrank the profitable Factory",
    );
  },
);

// Exercise real station discovery, rail BFS, candidate generation and dispatch.
for (const stopType of [UNIT.City, UNIT.Port]) {
  const f = productionFixture(harness, { [stopType]: [networkStation(33, 30, 1)] });
  const inputs = f.behavior.legendaryConstructionState().economyInputs;
  assert.equal(inputs.factoryPaidStops, 1);
  assert.equal(inputs.factoryStationEntries[0].cluster, "rail#0");
  const low = await productionDecision(f);
  assert.equal(low.selected?.type, UNIT.Factory, "production Factory beats nonbinding City");
  assert.equal(low.built, true);
  assert.deepEqual(f.emissions, [
    { type: UNIT.Factory, tile: 20, upgrade: false, cost: BigInt(liveCostOf(UNIT.Factory)) },
  ]);
  f.controls.troops = harness.liveConfig.maxTroops(f.actor) * 0.95;
  assert.equal(f.behavior.computeTroopCapPressure(false), true);
  const cap = await productionDecision(f);
  assert.equal(cap.selected?.type, UNIT.City, "actual near-cap relief selects City");
  assert.equal(cap.selected.capacity, 1);
  assert.equal(cap.built, true);
  assert.equal(f.emissions[1].type, UNIT.City);
}
const empty = productionFixture(harness);
assert.equal(
  (await productionDecision(empty)).selected,
  undefined,
  "production proposes no pure-economy investment without a paid stop",
);
assert.equal(empty.emissions.length, 0);
finishScenarios();
