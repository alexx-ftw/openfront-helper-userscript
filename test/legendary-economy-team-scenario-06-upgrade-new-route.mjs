// Both operations use one owner snapshot and the same native marginal price.
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

const h = await createTeamScenarioHarness("team-upgrade-production.vm.js");
for (const type of [h.UNIT.Factory, h.UNIT.Port]) {
  const factory = type === h.UNIT.Factory;
  const setup = (novel) => {
    const options = { actorUnits: { [type]: [networkStation(40, factory ? 20 : 10, 1)] } };
    const f = factory
      ? productionFixture(
          h,
          { City: [networkStation(33, 30, 1), networkStation(34, 730, 1)] },
          options,
        )
      : waterFixture(h, { Port: [networkStation(33, 20, 1), networkStation(34, 22, 1)] }, options);
    f.input.citiesDisabled = true; // Isolate the throughput-versus-new-route choice.
    const sites = factory ? [20, 720] : [10, 12];
    f.controls.tiles = novel ? sites : sites.slice(0, 1);
    return f;
  };
  const duplicate = setup(false);
  const baseline = await productionDecision(duplicate);
  assert.equal(baseline.selected?.type, type);
  assert.equal(
    baseline.selected?.action,
    "upgrade",
    "productive-network upgrade wins without a novel route",
  );
  assert.equal(
    baseline.selected.upgradeStructureId,
    40,
    "real discovery selects the productive owner unit",
  );
  assert.ok(baseline.selected.netTeamGold > 0n, "upgrade pays its native current price");
  assert.equal(baseline.built, true, "production dispatch emits the discovered upgrade");
  assert.deepEqual(duplicate.emissions, [
    {
      type,
      tile: undefined,
      upgrade: 40,
      cost: h.liveConfig.unitInfo(type).cost({}, duplicate.actor),
    },
  ]);
  assert.equal(
    baseline.candidates.filter((c) => c.type === type && c.action !== "upgrade").length,
    0,
    "a served cluster/water component cannot manufacture a duplicate new-route candidate",
  );

  const novel = setup(true);
  const decision = await productionDecision(novel);
  const upgrade = decision.candidates.find((c) => c.type === type && c.action === "upgrade");
  const build = decision.candidates.find((c) => c.type === type && c.action !== "upgrade");
  assert.ok(upgrade && build, "production independently discovers both candidates");
  const nativeCost = h.liveConfig.unitInfo(type).cost({}, novel.actor);
  assert.equal(upgrade.cost, nativeCost);
  assert.equal(build.cost, nativeCost, "build and upgrade share the same owner marginal cost");
  assert.equal(
    upgrade.cost,
    baseline.selected.cost,
    "opening another site does not change owner pricing",
  );
  assert.ok(novel.quotes.some((q) => q.type === type && q.upgrade && q.cost === nativeCost));
  assert.ok(novel.quotes.some((q) => q.type === type && !q.upgrade && q.cost === nativeCost));
  assert.ok(
    build.netTeamGold > upgrade.netTeamGold,
    "novel productive route adds greater horizon value",
  );
  assert.equal(decision.selected, build, "real group ranking flips to new construction");
  assert.equal(decision.built, true);
  assert.deepEqual(novel.emissions, [
    { type, tile: factory ? 720 : 12, upgrade: false, cost: nativeCost },
  ]);
  process.stdout.write(
    `PASS upgrade/new ${type}: same cost=${nativeCost}, upgrade=${upgrade.netTeamGold}, novel=${build.netTeamGold}\n`,
  );
}
