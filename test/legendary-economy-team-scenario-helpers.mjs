// Shared fixtures retained for all six economy scenarios.
import { createLiveScenarioHarness } from "./helpers/legendary-economy-team/live-config.mjs";

/** Load native economics and production behavior for one isolated scenario. */
export async function createTeamScenarioHarness(vmFilename) {
  return createLiveScenarioHarness(vmFilename);
}

/** Describe a station in the artificial map. */
export function networkStation(
  id,
  tile,
  level,
  underConstruction = false,
  hasTrainStation = !underConstruction,
) {
  return {
    id: () => id,
    tile: () => tile,
    level: () => level,
    isUnderConstruction: () => underConstruction,
    isMarkedForDeletion: () => false,
    isActive: () => true,
    hasTrainStation: () => hasTrainStation,
  };
}

/** Describe an owner using the public player surface. */
export function networkOwner(smallId, teamId, unitsByType, { allyOf = [] } = {}) {
  return {
    __src: { isLobbyCreator: () => false, ownerId: smallId },
    id: () => smallId,
    smallID: () => smallId,
    teamId,
    isPlayer: () => true,
    isAlive: () => true,
    hasEmbargoAgainst: () => false,
    isOnSameTeam: (other) => other?.teamId === teamId,
    isAlliedWith: (other) => allyOf.includes(String(other?.smallID?.())),
    units: (...types) => types.flatMap((type) => unitsByType[type] ?? []),
  };
}

// A landlocked actor (40) next to one partner (41) whose stations sit in the
// same reachable rail cluster ("rail").
/** Supply a minimal rail pricing fixture; production scenarios replace its map boundary. */
export function makeRailNetwork(
  harness,
  partnerUnits,
  { actorUnits = {}, partnerIsAlly = false, allianceTicksRemaining = Infinity } = {},
) {
  const actor = networkOwner(40, 7, actorUnits, {
    allyOf: partnerIsAlly ? ["41"] : [],
  });
  const partner = networkOwner(41, partnerIsAlly ? 8 : 7, partnerUnits, {
    allyOf: partnerIsAlly ? ["40"] : [],
  });
  const behavior = Object.create(harness.sandbox.__StructureBehavior.prototype);
  Object.assign(behavior, {
    player: actor,
    game: {
      players: () => [actor, partner],
      units: () => [],
      railroadState: () => null,
      sharedWaterComponents: () => new Set(),
      euclideanDistSquared: (left, right) => (left - right) ** 2,
      config: () => ({
        trainStationMaxRange: () => harness.liveConfig.trainStationMaxRange(),
        unitInfo: (type) => harness.liveConfig.unitInfo(type),
        trainSpawnRate: (factories, trains) => harness.liveConfig.trainSpawnRate(factories, trains),
        tradeShipSpawnRate: (r, s) => harness.liveConfig.tradeShipSpawnRate(r, s),
        trainGold: (relation, visited, source) =>
          harness.liveConfig.trainGold(relation, visited, source),
      }),
    },
    buildReachableStations: (types, owners) =>
      owners.flatMap((owner) =>
        owner
          .units(...types)
          .filter((unit) => unit.hasTrainStation())
          .map((unit) => ({ tile: unit.tile(), cluster: "rail" })),
      ),
    portWaterComponents: () => new Set(),
    legendaryPortSeedWindowOpen: () => false,
    legendaryPortCandidateTilesForEconomy: () => [],
    legendaryAllianceTicksRemaining: () => allianceTicksRemaining,
    trainGoldBase: (relation, visited = 10) => harness.liveTrainGold(relation, visited),
    ownedLevels: () => 0,
  });
  return { behavior, actor, partner };
}

/** Read real economy inputs with explicit fleet-count controls. */
export function railEconomyInputs(behavior, overrides = {}) {
  return behavior.legendaryEconomyInputs({
    trainCount: 0,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 1,
    ...overrides,
  });
}

/** Retain arithmetic-only ranking checks alongside production integration assertions. */
export function economyAction(type, cost, evaluation, extra = {}) {
  if (evaluation === null || evaluation.refused === true) return null;
  return {
    type,
    action: "build",
    cost: BigInt(cost),
    gold: 0,
    troops: 0,
    defense: 0,
    netTeamGold: BigInt(Math.round(evaluation.netTeamGold)),
    ...extra,
  };
}

const scenarioNames = [];
/** Register a policy assertion; async callers must await its completion. */
export function scenario(name, test) {
  const result = test();
  if (result && typeof result.then === "function") {
    return result.then(() => {
      scenarioNames.push(name);
    });
  }
  scenarioNames.push(name);
}
/** Print the policy assertions completed in this process. */
export function finishScenarios() {
  for (const name of scenarioNames) process.stdout.write("PASS " + name + "\n");
}
