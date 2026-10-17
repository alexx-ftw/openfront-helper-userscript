import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({ vmFilename: "economy-yield-actuation.vm.js" });
for (const type of [sandbox.UNIT.Factory, sandbox.UNIT.Port]) {
  for (const change of ["none", "treasury", "target", "level", "route"]) {
    const behavior = Object.create(sandbox.__StructureBehavior.prototype);
    let gold = 100n;
    let present = true;
    let productive = true;
    let level = 1;
    let emissions = 0;
    const target = {
      id: () => 7,
      level: () => level,
      tile: () => 11,
      isUnderConstruction: () => false,
    };
    behavior.player = { units: (unitType) => (unitType === type && present ? [target] : []) };
    behavior.game = { config: () => ({}) };
    behavior.hasAnyShoreBorderTile = () => true;
    behavior.availableGoldAfterReserve = () => gold;
    behavior.legendaryConstructionState = () => ({
      economyHorizonTicks: 100,
      economyInputs: {
        factoryUpgradeTargets: productive ? [{ structureId: 7 }] : [],
        portUpgradeTargetIds: productive ? [7] : [],
        portUpgradeProfiles: { 7: {} },
      },
    });
    behavior.buildableForUnits = async () => [{ canUpgrade: 7, cost: 100n }];
    behavior.legendaryEconomyEvaluation = async () => {
      // Mutate live state while the CPU calculation is suspended.
      await Promise.resolve();
      if (change === "treasury") gold = 99n;
      if (change === "target") present = false;
      if (change === "level") level++;
      if (change === "route") productive = false;
      return { netTeamGold: 1_000 };
    };
    sandbox.sendAutoBotBuildOrUpgrade = () => {
      emissions++;
      return true;
    };
    const built = await behavior.maybeUpgradeLegendaryThroughput({
      type,
      upgradeStructureId: 7,
      upgradeCost: 100n,
    });
    assert.equal(built, change === "none", `${type}: ${change} after CPU yield`);
    assert.equal(emissions, change === "none" ? 1 : 0, "stale projection cannot emit an upgrade");
  }
}
for (const change of ["none", "cap", "reserve", "eligibility"]) {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  let capPressure = true;
  let reserveGold = 100n;
  let eligible = true;
  let emissions = 0;
  Object.assign(behavior, {
    player: { units: () => [] },
    structureSpawnEligible: () => eligible,
    economicStructureSpawnPending: () => false,
    constructionCostForOptions: () => 100n,
    availableGoldAfterReserve: () => reserveGold,
    computeTroopCapPressure: () => capPressure,
    structureSpawnBuildable: async () => ({ canBuild: 11, cost: 100n }),
    legendaryCityBuildStillWorthIt: async () => {
      await Promise.resolve();
      if (change === "cap") capPressure = false;
      if (change === "reserve") reserveGold = 99n;
      if (change === "eligibility") eligible = false;
      return true;
    },
    emitStructureBuildable: () => {
      emissions++;
      return true;
    },
  });
  const built = await behavior.maybeSpawnStructure(sandbox.UNIT.City, {
    useActualCost: true,
    legendaryEconomyCityCapRelief: true,
  });
  assert.equal(built, change === "none", `cap-only City: ${change} after CPU yield`);
  assert.equal(emissions, change === "none" ? 1 : 0);
}
process.stdout.write("Legendary CPU-yield actuation revalidation passed (14 cases)\n");
