import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({
  vmFilename: "legendary-economy-cost-quote.vm.js",
});
const { UNIT, Difficulty } = sandbox;

const behavior = Object.create(sandbox.__StructureBehavior.prototype);
const availableGold = 200_000n;
const quoteCalls = [];
behavior.player = {
  gold: () => availableGold,
  buildables: async (tile, types) => {
    quoteCalls.push({ tile, types: Array.from(types) });
    return Array.from(types, (type) => ({
      type,
      // Captured Cities raise ownedLevels without raising core's constructed count.
      cost: type === UNIT.City ? 125_000n : 250_000n,
      canBuild: false,
      canUpgrade: false,
    }));
  },
};
behavior.game = { config: () => ({}) };
behavior.ownedLevels = (type) => (type === UNIT.City ? 2 : 0);
behavior.legendaryCostFactor = () => 1;
behavior.availableGoldAfterReserve = () => availableGold;
behavior.legendaryConstructionState = () => ({
  missileThreat: { critical: false, score: 0 },
  samLevelParityGap: 0,
  defenseGap: 0,
  targetPressure: 0,
  siloParityGap: 0,
  railNeed: 1,
  tradeNeed: 1,
  economyInputs: {},
});
behavior.probeLegendaryThroughputUpgradeCandidates = async () => [];
behavior.computeTroopCapPressure = () => false;
behavior.legendaryConstructionCandidateBlocked = () => false;
behavior.legendaryBigStartSiloCandidateBlocked = () => false;
behavior.addLegendaryCityCandidates = function (context) {
  this.addLegendaryConstructionCandidate(context, UNIT.City, {
    deficit: 1,
    efficiency: 1,
    netTeamGold: 1n,
  });
};
behavior.addLegendaryCityRouteCandidates = () => {};
behavior.addLegendaryPortRouteCandidates = () => {};
behavior.addLegendaryFactoryRouteCandidates = () => {};
behavior.addLegendaryRatioCandidate = () => {};

const localEstimate = behavior.cost(UNIT.City);
assert.equal(localEstimate, 500_000n, "the owned-level estimate includes the two captured Cities");

const candidates = await behavior.legendaryConstructionCandidates({
  config: {},
  citiesDisabled: false,
  cityCount: 2,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});

assert.equal(quoteCalls.length, 1, "all productive structure prices use one batched quote request");
assert.equal(
  quoteCalls[0].tile,
  undefined,
  "the price-only request does not claim placement legality",
);
assert.deepEqual(quoteCalls[0].types, [UNIT.Factory, UNIT.Port, UNIT.City]);
assert.equal(candidates[0].cost, 125_000n, "candidate pricing uses the live BuildableUnit quote");
assert.equal(
  behavior.constructionCostForOptions(UNIT.City, {
    useActualCost: true,
    legendaryEconomyCostQuote: candidates[0].cost,
  }),
  125_000n,
  "the selected quote also clears the pre-probe affordability gate",
);

const ranked = behavior.legendaryConstructionActionGroups(candidates, true)[0];
assert.equal(
  ranked[0].type,
  UNIT.City,
  "the quoted price makes the City affordable and rankable now",
);
assert.notEqual(ranked[0].action, "wait");

const estimatedCandidate = {
  ...candidates[0],
  cost: localEstimate,
  affordable: localEstimate <= availableGold,
};
assert.deepEqual(
  Array.from(
    behavior.legendaryConstructionActionGroups([estimatedCandidate], true)[0],
    (candidate) => candidate.type,
  ),
  ["Wait"],
  "the stale owned-level estimate would defer the same City build",
);

const quoteFailure = new Error("worker unavailable");
behavior.player.buildables = async () => {
  throw quoteFailure;
};
await assert.rejects(
  behavior.legendaryConstructionCandidates({
    config: {},
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  }),
  (error) => error === quoteFailure,
  "unexpected worker failure must propagate unchanged",
);
behavior.player.buildables = async () => null;
const fallbackCandidates = await behavior.legendaryConstructionCandidates({
  config: {},
  citiesDisabled: false,
  cityCount: 2,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: false,
});
assert.equal(
  fallbackCandidates.some((candidate) => candidate.type === UNIT.City),
  false,
  "a missing live price omits the economic build candidate",
);
assert.equal(
  behavior
    .legendaryConstructionActionGroups(fallbackCandidates, true)
    .flat()
    .some((candidate) => candidate.type === UNIT.City),
  false,
  "the planner emits no economic action when the live build price is unavailable",
);

const originalOwnedLevels = behavior.ownedLevels;
for (const [type, placementKey] of [
  [UNIT.Factory, "factoryPlacementTile"],
  [UNIT.Port, "portPlacementTile"],
]) {
  const liveQuote = 125_000n;
  const upgradeCost = 150_000n;
  const placementTile = 4;
  behavior.ownedLevels = (ownedType) =>
    originalOwnedLevels(ownedType) + (ownedType === type ? 1 : 0);
  const estimate = behavior.cost(type);
  assert.ok(estimate > availableGold, `${type} estimate is unaffordable`);
  behavior.player.buildables = async (tile, types) => {
    return Array.from(types, (quotedType) => ({
      type: quotedType,
      cost: quotedType === type ? liveQuote : 250_000n,
      canBuild: false,
      canUpgrade: false,
    }));
  };
  behavior.probeLegendaryThroughputUpgradeCandidates = async () => [
    {
      type,
      action: "upgrade",
      upgradeStructureId: `${type}-productive-upgrade`,
      upgradeCost,
      netTeamGold: 100_000n,
      mandatory: 0,
      safety: 0,
      capacity: 0,
    },
  ];
  behavior.addLegendaryCityCandidates = () => {};
  behavior.addLegendaryCityRouteCandidates = () => {};
  behavior.addLegendaryPortRouteCandidates = function (context) {
    if (type === UNIT.Port) {
      this.addLegendaryConstructionCandidate(context, type, {
        [placementKey]: placementTile,
        netTeamGold: 120_000n,
      });
    }
  };
  behavior.addLegendaryFactoryRouteCandidates = function (context) {
    if (type === UNIT.Factory) {
      this.addLegendaryConstructionCandidate(context, type, {
        [placementKey]: placementTile,
        netTeamGold: 120_000n,
      });
    }
  };
  behavior.addLegendaryRatioCandidate = () => {};

  const candidates = await behavior.legendaryConstructionCandidates({
    config: { isUnitDisabled: () => false },
    citiesDisabled: false,
    cityCount: 2,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  const routeCandidate = candidates.find(
    (candidate) => candidate.type === type && candidate.action !== "upgrade",
  );
  assert.equal(routeCandidate.cost, liveQuote, `${type} ranking uses the live quote`);
  const actions = behavior.legendaryConstructionActionGroups(candidates, true)[0];
  assert.equal(actions[0].type, type, `${type} outranks its lower-value upgrade at the live price`);
  assert.equal(actions[0].action, undefined);

  let emitted;
  behavior.maybeSpawnStructure = async (buildType, options) => {
    emitted = { buildType, options };
    return true;
  };
  assert.equal(
    await behavior.legendaryConstructionActionGroupResult(actions, [actions], 0),
    "built",
  );
  assert.equal(emitted.buildType, type);
  assert.equal(emitted.options.legendaryEconomyCostQuote, liveQuote);
  assert.equal(
    behavior.constructionCostForOptions(type, emitted.options),
    liveQuote,
    `${type} actuation affordability reuses the quote that won ranking`,
  );

  const staleActions = behavior.legendaryConstructionActionGroups(
    candidates.map((candidate) =>
      candidate === routeCandidate
        ? { ...candidate, cost: estimate, affordable: false }
        : candidate,
    ),
    true,
  )[0];
  assert.ok(
    staleActions[0]?.action,
    `${type} fallback estimate would retain the upgrade or wait instead of building`,
  );
}
behavior.ownedLevels = originalOwnedLevels;

const mandatoryCityWithoutReturn = {
  type: UNIT.City,
  cost: 100_000n,
  netTeamGold: 0n,
  mandatory: 1,
  capacity: 0,
};
assert.equal(
  behavior.legendaryConstructionActionGroups([mandatoryCityWithoutReturn], true)[0].length,
  0,
  "the inherited first-two-City flag does not bypass the positive-value gate",
);
assert.equal(
  behavior.legendaryConstructionActionGroups(
    [
      { ...mandatoryCityWithoutReturn, netTeamGold: 50_000n },
      { type: UNIT.Factory, cost: 100_000n, netTeamGold: 200_000n, capacity: 0 },
    ],
    true,
  )[0][0].type,
  UNIT.Factory,
  "a lower-profit mandatory City does not displace the best positive economy action",
);

const landlockedDispatch = Object.create(sandbox.__StructureBehavior.prototype);
let rankedLandlockedCalls = 0;
let faithfulLandlockedCalls = 0;
landlockedDispatch.legendaryBigStartGame = () => false;
landlockedDispatch.structureBuildContext = () => ({
  difficulty: Difficulty.Legendary,
  economyGrowthPriority: false,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
});
landlockedDispatch.handleOpeningStructurePriorities = async () => false;
landlockedDispatch.maybeOpenLandlockedLegendaryArsenal = async () => false;
landlockedDispatch.hasAnyShoreBorderTile = () => false;
landlockedDispatch.doHandleLegendaryStructures = async (context) => {
  rankedLandlockedCalls++;
  assert.equal(context.hasOceanPortTiles, false);
  assert.equal(context.hasCoastalTiles, false);
  return true;
};
landlockedDispatch.handleMissileSiloParity = async () => false;
landlockedDispatch.handleOrdinaryStructurePriorities = async () => {
  faithfulLandlockedCalls++;
  return false;
};
assert.equal(await landlockedDispatch.doHandleStructures(), true);
assert.equal(rankedLandlockedCalls, 1, "landlocked Legendary uses the ranked planner");
assert.equal(faithfulLandlockedCalls, 0, "landlocked Legendary skips the fixed economy order");

let buildAllowed = true;
sandbox.autoBotBuildAllowed = () => buildAllowed;
sandbox.sendAutoBotBuildOrUpgrade = () => true;
const finalBuildCheck = Object.create(sandbox.__StructureBehavior.prototype);
finalBuildCheck.shouldReserveEconomicGrowthForOffense = () => false;
finalBuildCheck.isUsableStructureBuildable = () => true;
const buildable = { type: UNIT.Factory, canBuild: 17 };
assert.equal(
  finalBuildCheck.emitStructureBuildable(UNIT.Factory, buildable),
  true,
  "the final legality gate allows a currently enabled structure build",
);
buildAllowed = false;
assert.equal(
  finalBuildCheck.emitStructureBuildable(UNIT.Factory, buildable),
  false,
  "the final legality gate rechecks a toggle changed during the placement probe",
);
assert.equal(sandbox.state.stats.builds, 1, "a newly disabled build is not emitted");

process.stdout.write("legendary economy live-cost quote test passed\n");
