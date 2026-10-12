import assert from "node:assert/strict";
import { createLegendaryStructureSandbox } from "./helpers/legendary-structure-fixture.mjs";

const sandbox = createLegendaryStructureSandbox({
  randTerritoryTiles: [30],
  vmFilename: "legendary-port-economy-selection.vm.js",
});
const { UNIT } = sandbox;

const PORT_CONSTRUCTION_TICKS = 50;
const PORT_COST_LADDER = 125_000;
const PORT_COST_CAP = 1_000_000;
const OCEAN = -1;

// Live trade economy formulas (openfront-engine Config.ts):
// tradeShipGold = 75k/(1+exp(-0.03*(dist-300))) + 50*dist,
// saturation and spawn-rate (pity timer included) follow the same source.
const SHORT_RANGE_DEBUFF = 300;
const MATCH_HORIZON_TICKS = (170 * 60 * 1_000) / 100;
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const tradeShipGold = (distance) =>
  75_000 * sigmoid(0.03 * (Number(distance) - SHORT_RANGE_DEBUFF)) + 50 * Number(distance);
const tradeShipSaturation = (ships) => {
  const boost = 1 + 0.45 * Math.exp(-ships / 120);
  const damping = 1 - sigmoid((Math.LN2 / 50) * (ships - 330));
  const plateau = 0.25 * (1 - sigmoid((Math.LN2 / 100) * (ships - 800)));
  return boost * Math.max(damping, plateau);
};
const tradeShipSpawnRate = (rejections, ships) =>
  Math.max(1, Math.floor(100 / (rejections + 1) / tradeShipSaturation(ships)));
const portCost = (ownedCount) =>
  BigInt(Math.min(PORT_COST_CAP, PORT_COST_LADDER * 2 ** ownedCount));
const port = (tile, level = 1, underConstruction = false) => ({
  id: () => `port-${tile}`,
  tile: () => tile,
  level: () => level,
  isUnderConstruction: () => underConstruction,
  isMarkedForDeletion: () => false,
  isActive: () => true,
});
const waterOwner = (smallId, { teamId = null, ports = [] } = {}) => ({
  __src: { isLobbyCreator: () => false, ownerId: smallId },
  id: () => smallId,
  smallID: () => smallId,
  teamId,
  isPlayer: () => true,
  isAlive: () => true,
  hasEmbargoAgainst: () => false,
  isOnSameTeam: (other) => teamId !== null && other?.teamId === teamId,
  isAlliedWith: () => false,
  isFriendly: (other) => teamId !== null && other?.teamId === teamId,
  gold: () => 10_000_000n,
  units: (type) => (type === UNIT.Port ? ports : []),
  borderTiles: () => [10 * smallId],
  oceanShoreBorderTiles: () => [10 * smallId],
});
const waterGame = (player, others, shared = new Set([OCEAN])) => ({
  players: () => [player, ...others],
  sharedWaterComponents: () => shared,
  config: () => liveConfig,
});
const liveConfig = {
  isUnitDisabled: () => false,
  unitInfo: (type) => ({
    constructionDuration: type === UNIT.Port ? PORT_CONSTRUCTION_TICKS : 20,
  }),
  tradeShipGold,
  tradeShipShortRangeDebuff: () => SHORT_RANGE_DEBUFF,
  tradeShipSpawnRate,
  trainStationMinRange: () => 15,
  trainStationMaxRange: () => 110,
  trainSpawnRate: (_factories, trains) => 100 + trains * 1_000,
};
// Water routing uses tiny tile distances so live trade-ship gold dominates cost.
const wireWater = (behavior, ownTile, foreignTile) => {
  behavior.portWaterComponents = () => new Set([OCEAN]);
  behavior.legendaryWaterDistancesFrom = (_sourceTile) =>
    new Map([
      [ownTile, PORT_CONSTRUCTION_TICKS - 1],
      [foreignTile, 2],
    ]);
  behavior.game.neighbors = (tile) => [tile === foreignTile ? ownTile : foreignTile];
  behavior.game.isWater = () => true;
  behavior.game.manhattanDist = (left, right) => Math.abs(Number(left) - Number(right));
  behavior.isShoreBorderTile = () => true;
  behavior.portTileHasOpenWaterAccess = () => true;
};
// The actor has no rail network in every Port scenario; only water routes price.
const behaviorBase = (player, others, shared) => {
  const behavior = Object.create(sandbox.__StructureBehavior.prototype);
  behavior.game = waterGame(player, others, shared);
  behavior.player = player;
  behavior.buildReachableStations = () => [];
  behavior.trainGoldBase = () => 50_000;
  behavior.legendaryAllianceTicksRemaining = () => Infinity;
  behavior.ownedLevels = (type) =>
    type === UNIT.Port
      ? player
          .units(UNIT.Port)
          .reduce((total, unit) => total + (unit.isUnderConstruction() ? 0 : unit.level()), 0)
      : 0;
  behavior.cost = (type) => portCost(behavior.ownedLevels(type));
  behavior.legendaryCostFactor = () => 1;
  behavior.availableGoldAfterReserve = () => 10_000_000n;
  behavior.probeLegendaryThroughputUpgradeCandidates = async () => [];
  behavior.computeTroopCapPressure = () => false;
  behavior.legendaryConstructionCandidateBlocked = () => false;
  behavior.legendaryBigStartSiloCandidateBlocked = () => false;
  behavior.legendaryPortCapable = () => true;
  behavior.legendaryNavalFrontLoadSuppressed = () => false;
  return behavior;
};
// Fresh per-scenario behavior so caches cannot leak across cases.
const portScenario = ({ ships = 0, ownPorts = [], others = [], shared = new Set([OCEAN]) }) => {
  const player = waterOwner(1, { teamId: 7, ports: ownPorts });
  const behavior = behaviorBase(player, others, shared);
  wireWater(behavior, 10, 20);
  behavior.legendaryConstructionState = ({ cityCount }) => ({
    cityCount,
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 0.25,
    tradeNeed: 1.3,
    missileThreat: { critical: false, score: 0 },
    samLevelParityGap: 0,
    siloParityGap: 0,
    siloParityTarget: 0,
    targetPressure: 0,
    defenseGap: 0,
    destroyerNeed: 1,
    portSurvivability: 1,
    hasTradePartner: others.some((other) => other.units(UNIT.Port).length > 0),
    economyHorizonTicks: MATCH_HORIZON_TICKS,
    economyInputs: behavior.legendaryEconomyInputs({
      trainCount: 0,
      tradeShipCount: ships,
      hasTradePartner: others.some((other) => other.units(UNIT.Port).length > 0),
      hasCompletedTradePartner: others.some((other) =>
        other.units(UNIT.Port).some((unit) => !unit.isUnderConstruction()),
      ),
      connectedStops: 1,
    }),
  });
  return { player, behavior };
};
const portCandidates = async (behavior) =>
  (
    await behavior.legendaryConstructionCandidates({
      config: liveConfig,
      citiesDisabled: false,
      cityCount: 4,
      hasCoastalTiles: true,
      hasOceanPortTiles: true,
      missileSilosEnabled: false,
      nukesEnabled: false,
    })
  ).filter((candidate) => candidate.type === UNIT.Port);

// (1) No eligible shared-water partner: trade-need only, no economic Port.
{
  const foreignLand = waterOwner(2);
  const { behavior } = portScenario({ others: [foreignLand] });
  const candidates = await portCandidates(behavior);
  assert.ok(
    candidates.every((candidate) => candidate.action !== "build" || candidate.netTeamGold <= 0n),
    "without a shared-water partner Port, a new Port carries no positive economic value",
  );
}

// (2) Two-owner seed pair: only the selected pair is the no-route exception,
// and the pair stays a single non-duplicated commitment after one side builds.
{
  const partner = waterOwner(2, { teamId: 7 });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const inputs = behavior.legendaryConstructionState({ cityCount: 4 });
  assert.equal(
    inputs.economyInputs.portSeedWindowOpen,
    true,
    "the deterministic two-owner selection opens the seed window for the actor",
  );
  const seedOwn = inputs.economyInputs.portSeedSources.find(
    (source) => source.portSeedStream === "own",
  );
  assert.ok(
    seedOwn && seedOwn.placementTile === 10,
    "the actor's seed placement tile comes from its own shared-water border",
  );
  const committedPartner = waterOwner(2, {
    teamId: 7,
    ports: [port(20, 1, true)],
  });
  const { behavior: committedBehavior } = portScenario({
    others: [committedPartner],
  });
  wireWater(committedBehavior, 10, 20);
  const committed = await portCandidates(committedBehavior);
  assert.equal(
    committed.length,
    1,
    "after the partner commits its seed Port, the actor still prices exactly one Port",
  );
  assert.equal(
    committed[0].portPlacementTile,
    10,
    "the committed seed candidate keeps the deterministic actor-side tile",
  );
}

// (3) An existing same-water actor Port suppresses a duplicate build; the
// productive upgrade remains rankable and wins.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({
    ownPorts: [port(10)],
    others: [partner],
  });
  wireWater(behavior, 10, 20);
  behavior.player.borderTiles = () => [10, 30];
  behavior.player.oceanShoreBorderTiles = () => [10, 30];
  const inputs = behavior.legendaryConstructionState({ cityCount: 4 });
  assert.deepEqual(
    [...inputs.economyInputs.portCandidateProfiles.map((entry) => entry.placementTile)],
    [10, 30],
    "both shared-water tiles still carry route profiles before the served-water suppression",
  );
  assert.deepEqual(
    Object.keys(inputs.economyInputs.portUpgradeProfiles),
    ["port-10"],
    "the completed same-water Port prices a productive upgrade instead of a duplicate",
  );
  const suppressed = await portCandidates(behavior);
  assert.equal(
    suppressed.length,
    0,
    "the completed same-water Port suppresses every duplicate build on that water",
  );
  const upgradeEvaluation = sandbox.legendaryEconomyNetGold(UNIT.Port, {
    cost: Number(portCost(1)),
    horizonTicks: inputs.economyHorizonTicks,
    inputs: {
      ...inputs.economyInputs,
      upgradeAction: true,
      upgradeStructureId: "port-10",
      portUpgradeLevel: 1,
      portUpgradeProfile: inputs.economyInputs.portUpgradeProfiles["port-10"],
    },
    config: liveConfig,
  });
  assert.ok(
    upgradeEvaluation && upgradeEvaluation.refused !== true && upgradeEvaluation.netTeamGold > 0,
    "the productive same-water upgrade prices positive net value and can win",
  );
}

// (4) A novel eligible shared-water route beats the lower-value City.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const candidates = await behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  const portCandidate = candidates.find((candidate) => candidate.type === UNIT.Port);
  const cityCandidate = candidates.find((candidate) => candidate.type === UNIT.City);
  assert.ok(portCandidate && portCandidate.netTeamGold > 0n);
  assert.ok(cityCandidate && cityCandidate.netTeamGold === 0n);
  assert.equal(
    behavior.legendaryConstructionActionGroups(candidates, true)[0][0].type,
    UNIT.Port,
    "the positive net shared-water Port outranks the nonbinding City",
  );
}

// (5) The exact selected tile reaches the async probe and the build emission.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const { behavior } = portScenario({ others: [partner] });
  wireWater(behavior, 10, 20);
  const [candidate] = await portCandidates(behavior);
  const placementCalls = [];
  sandbox.sendAutoBotBuildOrUpgrade = (_menu, buildable, tile) => {
    placementCalls.push({ buildableTile: buildable.canBuild, tile });
    return true;
  };
  behavior.structureSpawnEligible = () => true;
  behavior.structureTileValueFunction = () => () => 1;
  behavior.structurePlacementCompactnessRanker = () => null;
  behavior.structureMissileEmergency = () => ({ active: false });
  behavior.isDangerousStructureTile = () => false;
  behavior.isSafeBuildablePlacement = () => true;
  behavior.getOrBuildFactoryTradeDestinations = () => [];
  behavior.economicPlacementBudgetLimit = (limit) => limit;
  behavior.consumeEconomicPlacementBudget = () => {};
  behavior.buildableCostOrFallback = (buildable, fallback) => buildable.cost ?? fallback;
  const probedTiles = [];
  behavior.player.buildables = async (tile, types) => {
    probedTiles.push(tile);
    return [
      {
        type: types[0],
        canBuild: tile,
        canUpgrade: false,
        cost: portCost(0),
      },
    ];
  };
  assert.equal(await behavior.legendaryConstructionActionGroupResult([candidate], [], 0), "built");
  assert.deepEqual(
    probedTiles,
    [candidate.portPlacementTile],
    "the selected exact Port tile reaches the real async buildability probe",
  );
  assert.deepEqual(
    placementCalls,
    [{ buildableTile: candidate.portPlacementTile, tile: candidate.portPlacementTile }],
    "the same exact Port tile is emitted after buildability succeeds",
  );
}

// (6) Live trade-ship saturation removes the negative route candidate and
// skips the whole economy group.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const saturated = portScenario({ ships: 100_000, others: [partner] });
  wireWater(saturated.behavior, 10, 20);
  const candidates = await saturated.behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: true,
    hasOceanPortTiles: true,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  assert.equal(
    candidates.some((candidate) => candidate.type === UNIT.Port),
    true,
    "the saturated Port lane still surfaces its candidate for ranking",
  );
  assert.ok(
    candidates
      .filter((candidate) => candidate.type === UNIT.Port)
      .every((candidate) => candidate.netTeamGold <= 0n),
    "at saturated live trade cadence no Port candidate carries positive net value",
  );
  const groups = saturated.behavior.legendaryConstructionActionGroups(candidates, true);
  assert.equal(
    groups.flat().length,
    0,
    "with no other economy candidate, saturated trade skips the economy group",
  );
}

// (7) Non-team finite alliance route discount vs permanent teammate route.
{
  const buildPair = (ally, allianceTicks) => {
    const partner = waterOwner(2, {
      teamId: ally ? null : 7,
      ports: [port(20)],
    });
    const { behavior } = portScenario({ others: [partner] });
    if (ally) {
      behavior.player.isAlliedWith = (other) => other === partner;
      partner.isAlliedWith = (other) => other === behavior.player;
      behavior.player.isFriendly = (other) =>
        other === partner || behavior.player.teamId === other?.teamId;
      partner.isFriendly = (other) => other === behavior.player;
      behavior.legendaryAllianceTicksRemaining = () => allianceTicks;
    }
    wireWater(behavior, 10, 20);
    behavior.game.manhattanDist = () => 310;
    const inputs = behavior.legendaryConstructionState({ cityCount: 4 });
    return {
      inputs,
      net: sandbox.legendaryEconomyNetGold(UNIT.Port, {
        cost: Number(portCost(0)),
        horizonTicks: inputs.economyHorizonTicks,
        inputs: {
          ...inputs.economyInputs,
          portCandidateProfiles: inputs.economyInputs.portCandidateProfiles,
        },
        config: behavior.game.config(),
      }),
    };
  };
  const teammate = buildPair(false, Infinity);
  const allied = buildPair(true, 400);
  assert.ok(
    allied.net.netTeamGold < teammate.net.netTeamGold,
    "the finite ally route earns less than the identical permanent teammate route",
  );
  const allyRoute = allied.inputs.economyInputs.portCandidateProfiles[0].routes[0];
  assert.ok(
    Number.isFinite(allyRoute.allianceTicksRemaining) &&
      allyRoute.postAllianceWeight < allyRoute.weight,
    "the ally route drops its friendly bonus weight after expiry",
  );
  const teamRoute = teammate.inputs.economyInputs.portCandidateProfiles[0].routes[0];
  assert.equal(
    teamRoute.postAllianceWeight,
    teamRoute.weight,
    "the permanent teammate route keeps full weight for the whole horizon",
  );
}

// (8) Landlocked Legendary: the real ladder body runs with no water access
// and admits no Port candidate at all.
{
  const partner = waterOwner(2, { teamId: 7, ports: [port(20)] });
  const player = waterOwner(1, { teamId: 7 });
  player.borderTiles = () => [10];
  player.oceanShoreBorderTiles = () => [];
  const behavior = behaviorBase(player, [partner], new Set());
  behavior.isShoreBorderTile = () => false;
  behavior.legendaryConstructionState = ({ cityCount }) => ({
    cityCount,
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 0.25,
    tradeNeed: 1.3,
    missileThreat: { critical: false, score: 0 },
    samLevelParityGap: 0,
    siloParityGap: 0,
    siloParityTarget: 0,
    targetPressure: 0,
    defenseGap: 0,
    destroyerNeed: 1,
    portSurvivability: 1,
    hasTradePartner: true,
    economyHorizonTicks: MATCH_HORIZON_TICKS,
    economyInputs: behavior.legendaryEconomyInputs({
      trainCount: 0,
      tradeShipCount: 0,
      hasTradePartner: true,
      hasCompletedTradePartner: true,
      connectedStops: 1,
    }),
  });
  const candidates = await behavior.legendaryConstructionCandidates({
    config: liveConfig,
    citiesDisabled: false,
    cityCount: 4,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  assert.equal(
    candidates.filter(
      (candidate) =>
        candidate.type === UNIT.Port && candidate.action === "build" && candidate.netTeamGold > 0n,
    ).length,
    0,
    "the landlocked ladder body admits no positive Port build candidate",
  );
  assert.equal(
    behavior
      .legendaryConstructionActionGroups(candidates, true)
      .flat()
      .some((candidate) => candidate.type === UNIT.Port),
    false,
    "the landlocked economy group never selects a Port",
  );
}

process.stdout.write("legendary port economy selection tests passed\n");
