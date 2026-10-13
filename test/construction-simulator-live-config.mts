import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../openfront-engine/src/core/configuration/Config";
import {
  PlayerType as LivePlayerType,
  UnitType as LiveUnitType,
} from "../openfront-engine/src/core/game/Game";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { expectedRailIncomePerTick } from "./helpers/construction-simulator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = new Config({ maxTimerValue: 120 }, null, false);
const player = { isLobbyCreator: () => false } as Parameters<Config["trainGold"]>[2];
const observedTrainGoldCalls: Array<{
  relation: string;
  citiesVisited: number;
  gold: number;
}> = [];
const liveTrainGold = config.trainGold.bind(config);
config.trainGold = ((relation, citiesVisited, owner) => {
  const gold = liveTrainGold(relation, citiesVisited, owner);
  observedTrainGoldCalls.push({ relation, citiesVisited, gold: Number(gold) });
  return gold;
}) as Config["trainGold"];
const planner = {};
executeClassicScript(
  fs.readFileSync(path.join(ROOT, "engine/ingame/auto-bot/legendaryPlanner.js"), "utf8"),
  planner,
  { filename: "legendaryPlanner.js" },
);
const liveEconomics = {
  trainSpawnRate: (factoryUnits: number, trainUnits: number) =>
    config.trainSpawnRate(factoryUnits, trainUnits),
  goldForTradeStop: (stopIndex: number, relation: Parameters<Config["trainGold"]>[0] = "self") =>
    Number(config.trainGold(relation, stopIndex, player)),
};

const servedFactory = expectedRailIncomePerTick({
  adjacency: new Map([
    ["factory", ["city"]],
    ["city", ["factory"]],
  ]),
  stationTypes: new Map([
    ["factory", "Factory"],
    ["city", "City"],
  ]),
  stationOwners: new Map([["city", "team"]]),
  factoryLevels: new Map([["factory", 1]]),
  trainCount: 0,
  ...liveEconomics,
});
assert.ok(servedFactory.totalIncomePerTick > 0, "a served Factory earns expected team gold");

const idleFactory = expectedRailIncomePerTick({
  adjacency: new Map([
    ["factory", ["other-factory"]],
    ["other-factory", ["factory"]],
    ["disconnected-city", []],
  ]),
  stationTypes: new Map([
    ["factory", "Factory"],
    ["other-factory", "Factory"],
    ["disconnected-city", "City"],
  ]),
  factoryLevels: new Map([
    ["factory", 1],
    ["other-factory", 1],
  ]),
  trainCount: 0,
  ...liveEconomics,
});
assert.equal(
  idleFactory.totalIncomePerTick,
  0,
  "Factories without reachable trade stops earn zero",
);

const railScenario = {
  adjacency: new Map([
    ["factory", ["city"]],
    ["city", ["factory", "candidate-factory"]],
    ["candidate-factory", ["city"]],
  ]),
  stationTypes: new Map([
    ["factory", "Factory"],
    ["city", "City"],
  ]),
  stationOwners: new Map([["city", "team"]]),
  factoryLevels: new Map([["factory", 1]]),
};
const addedFactory = { id: "candidate-factory", type: "Factory" };
const incomeAt = (trainCount: number, addFactory = false) =>
  expectedRailIncomePerTick({
    ...railScenario,
    candidate: addFactory ? addedFactory : null,
    trainCount,
    ...liveEconomics,
  }).totalIncomePerTick;

const lowTrainCount = 0;
const highTrainCount = 1_000;
const lowCountIncome = incomeAt(lowTrainCount);
const lowCountWithFactory = incomeAt(lowTrainCount, true);
const highCountIncome = incomeAt(highTrainCount);
const highCountWithFactory = incomeAt(highTrainCount, true);
assert.ok(
  lowCountWithFactory > lowCountIncome && highCountWithFactory > highCountIncome,
  "adding a served Factory increases expected team gold at both train counts",
);
assert.ok(
  highCountWithFactory < lowCountWithFactory,
  "global train saturation lowers total expected Factory income",
);
assert.ok(
  lowCountWithFactory - lowCountIncome > highCountWithFactory - highCountIncome,
  "global train saturation lowers the marginal income from adding a Factory",
);

const portPlayer = {
  type: () => LivePlayerType.Nation,
  isLobbyCreator: () => false,
  unitsOwned: (type: string) => Number(type === LiveUnitType.Port || type === LiveUnitType.Factory),
  unitsConstructed: (type: string) =>
    Number(type === LiveUnitType.Port || type === LiveUnitType.Factory),
} as Parameters<ReturnType<Config["unitInfo"]>["cost"]>[1];
const livePortCost = Number(config.unitInfo(LiveUnitType.Port).cost({} as never, portPlayer));
const liveCityCost = Number(config.unitInfo(LiveUnitType.City).cost({} as never, portPlayer));
const tradeGoldPerArrival = Number(config.tradeShipGold(100, player)) * 2;
const livePortConfig = {
  unitInfo: (type: LiveUnitType) => config.unitInfo(type),
  tradeShipSpawnRate: (rejections: number, ships: number) =>
    config.tradeShipSpawnRate(rejections, ships),
};
const portValueAt = (tradeShipCount: number) =>
  planner.legendaryEconomyNetGold("Port", {
    cost: livePortCost,
    horizonTicks: Math.floor((config.gameConfig().maxTimerValue * 60_000) / config.msPerTick()),
    inputs: {
      hasCompletedTradePartner: true,
      tradeShipCount,
      portRoutes: [
        {
          weight: 1,
          distance: 100,
          teamGoldPerArrival: tradeGoldPerArrival,
          postAllianceGoldPerArrival: tradeGoldPerArrival,
          allianceTicksRemaining: Infinity,
        },
      ],
    },
    config: livePortConfig,
  });
const openFleetPortValue = portValueAt(0);
const saturatedFleetPortValue = portValueAt(1_000);
const horizonTicks = Math.floor((config.gameConfig().maxTimerValue * 60_000) / config.msPerTick());
const teamTrainStopGold = Number(config.trainGold("team", 1, player)) * 2;
const cityValue = planner.legendaryEconomyNetGold("City", {
  cost: liveCityCost,
  horizonTicks,
  inputs: {
    trainCount: 0,
    trainSources: Array.from({ length: 1 }, () => ({
      factoryCount: 1,
      productiveFactoryLevels: [1],
      pendingFactoryLevels: [],
      paidStopsAfterBuild: 5,
      teamGoldPerStop: teamTrainStopGold,
      postAllianceTeamGoldPerStop: teamTrainStopGold,
      eligibleTicks: Infinity,
    })),
  },
  config: {
    unitInfo: (type: LiveUnitType) => config.unitInfo(type),
    trainSpawnRate: liveEconomics.trainSpawnRate,
  },
});
const rankLiveEconomy = (portValue: { netTeamGold: number } | null) =>
  planner.rankLegendaryConstructionActions(
    [
      {
        type: "Port",
        cost: BigInt(Math.round(livePortCost)),
        netTeamGold: BigInt(Math.round(portValue?.netTeamGold ?? 0)),
        gold: 0,
        troops: 0,
        defense: 0,
        capacity: 0,
      },
      {
        type: "City",
        cost: BigInt(Math.round(liveCityCost)),
        netTeamGold: BigInt(Math.round(cityValue?.netTeamGold ?? 0)),
        gold: 0,
        troops: 0,
        defense: 0,
        capacity: 0,
      },
    ],
    { gold: BigInt(Math.ceil(livePortCost + liveCityCost)) },
  );
assert.ok(
  openFleetPortValue?.netTeamGold > 0,
  `live Config values a connected Port in an open fleet: ${JSON.stringify(openFleetPortValue)}`,
);
assert.ok(
  saturatedFleetPortValue !== null &&
    saturatedFleetPortValue.netTeamGold < openFleetPortValue.netTeamGold,
  "live Config trade-ship saturation lowers connected Port marginal value",
);
assert.ok(
  cityValue?.netTeamGold > 0,
  "live Config values a connected City across team Factory routes",
);
assert.equal(
  rankLiveEconomy(openFleetPortValue)[0]?.type,
  "Port",
  `live Config ranks open Port against City (Port ${openFleetPortValue?.netTeamGold}, City ${cityValue?.netTeamGold})`,
);
assert.equal(
  rankLiveEconomy(saturatedFleetPortValue)[0]?.type,
  "City",
  `live Config saturation flips the final choice to City (Port ${saturatedFleetPortValue?.netTeamGold}, City ${cityValue?.netTeamGold})`,
);

const structureSandbox: Record<string, unknown> & {
  __StructureBehavior?: { prototype: object };
} = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  UNIT: LiveUnitType,
  WORKER_TIMEOUT_MS: 1,
  window: { setTimeout, clearTimeout },
  state: { settings: { winFixes: true } },
  globalThis: null as unknown,
};
Object.assign(structureSandbox, planner);
structureSandbox.globalThis = structureSandbox;
executeClassicScript(
  fs.readFileSync(path.join(ROOT, "engine/ingame/auto-bot/helpers.js"), "utf8"),
  structureSandbox,
  { filename: "helpers.js" },
);
executeClassicScript(
  `${fs.readFileSync(path.join(ROOT, "engine/ingame/auto-bot/structureBehavior.js"), "utf8")}\nglobalThis.__StructureBehavior = StructureBehavior;`,
  structureSandbox,
  { filename: "structureBehavior.js" },
);

const station = (id: string, tile: number) => ({
  id: () => id,
  tile: () => tile,
  level: () => 1,
  isUnderConstruction: () => false,
  hasTrainStation: () => true,
  isMarkedForDeletion: () => false,
  isActive: () => true,
});
const ownUnits = {
  [LiveUnitType.City]: Array.from({ length: 3 }, (_, index) => station(`city-${index}`, index)),
  [LiveUnitType.Factory]: Array.from({ length: 6 }, (_, index) =>
    station(`factory-${index}`, index + 10),
  ),
};
const teammateUnits = { [LiveUnitType.City]: [station("team-city", 20)] };
const makeOwner = (id: number, units: Record<string, ReturnType<typeof station>[]>) => ({
  id: () => id,
  smallID: () => id,
  teamId: 7,
  type: () => LivePlayerType.Nation,
  isLobbyCreator: () => false,
  isPlayer: () => true,
  isAlive: () => true,
  hasEmbargoAgainst: () => false,
  isFriendly: (other: { teamId?: number }) => other.teamId === 7,
  isOnSameTeam: (other: { teamId?: number }) => other.teamId === 7,
  isAlliedWith: () => false,
  units: (...types: string[]) => types.flatMap((type) => units[type] ?? []),
  // This economics fixture has no worker; use the explicit unavailable-quote fallback.
  buildables: async () => null,
});
const actor = Object.assign(makeOwner(1, ownUnits), { gold: () => 10_000_000n });
const teammate = makeOwner(2, teammateUnits);
let constructionTrainCount = 0;
const constructionGame = {
  config: () => config,
  players: () => [actor, teammate],
  units: (type: string) =>
    type === LiveUnitType.Train ? Array.from({ length: constructionTrainCount }) : [],
  ticks: () => 0,
};
const constructionBehavior = Object.create(structureSandbox.__StructureBehavior!.prototype);
Object.assign(constructionBehavior, {
  game: constructionGame,
  player: actor,
  buildReachableStations: (types: string[], owners: ReturnType<typeof makeOwner>[]) =>
    owners.flatMap((owner) =>
      owner.units(...types).map((unit) => ({
        tile: unit.tile(),
        cluster: unit.tile() === 2 || unit.tile() === 20 ? "rail#1" : "rail#2",
      })),
    ),
  readRailroadState: () => [{ id: "rail#stub" }],
  assignRailClusters: (tiles: Array<{ tile: number }>) => tiles.map(() => "rail#1"),
  structureCandidateTiles: (type: string) => (type === LiveUnitType.Factory ? [30] : []),
  legendaryRailMetrics: () => ({
    connectedCities: 3,
    cityRailConnection: 1,
    railNeed: 2,
    tradeNeed: 0,
  }),
  enemyMissileSiloPressure: () => [],
  getMissileDefenseContext: () => ({ critical: false, score: 0 }),
  legendaryHostilePlayers: () => [],
  hasTradeablePortOnSharedWater: () => false,
  legendaryEnemyTargetPressure: () => 0,
  legendaryConstructionDefenseGap: () => 0.25,
  legendaryPortSurvivability: () => 1,
  ownSamCapacity: () => 0,
  missileSiloParityTarget: () => 0,
  samLevelParityTarget: () => 0,
  samLevelParityGap: () => 0,
  legendaryPortSeedWindowOpen: () => false,
  legendaryPortCandidateTilesForEconomy: () => [],
  portWaterComponents: () => new Set(),
  hasAnyShoreBorderTile: () => false,
  legendarySamChestBlocksType: () => false,
  probeLegendaryThroughputUpgradeCandidates: async () => [],
  computeTroopCapPressure: () => false,
  availableGoldAfterReserve: () => actor.gold(),
});
const rankLiveConstructionAt = async (trainCount: number) => {
  constructionTrainCount = trainCount;
  const candidates = await constructionBehavior.legendaryConstructionCandidates({
    config,
    citiesDisabled: false,
    cityCount: 3,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  return {
    candidates,
    winner: constructionBehavior.legendaryConstructionActionGroups(candidates, true)[0]?.[0],
  };
};
const liveConstructionCostPlayer = {
  type: () => LivePlayerType.Nation,
  unitsOwned: (type: string) =>
    Number(type === LiveUnitType.City ? 3 : type === LiveUnitType.Factory ? 6 : 0),
  unitsConstructed: (type: string) =>
    Number(type === LiveUnitType.City ? 3 : type === LiveUnitType.Factory ? 6 : 0),
} as Parameters<ReturnType<Config["unitInfo"]>["cost"]>[1];
const lowTrainConstruction = await rankLiveConstructionAt(0);
const saturatedConstruction = await rankLiveConstructionAt(300);
const liveConstructionCosts = [
  BigInt(config.unitInfo(LiveUnitType.Factory).cost({} as never, liveConstructionCostPlayer)),
  BigInt(config.unitInfo(LiveUnitType.City).cost({} as never, liveConstructionCostPlayer)),
];
const candidateCosts = (candidates: typeof lowTrainConstruction.candidates) =>
  [LiveUnitType.Factory, LiveUnitType.City].map(
    (type) => candidates.find((candidate) => candidate.type === type)?.cost,
  );
assert.equal(
  lowTrainConstruction.winner?.type,
  "Factory",
  "live Config ranks an open-rail Factory first at low global train counts",
);
assert.notEqual(
  saturatedConstruction.winner?.type,
  "City",
  "an own City cannot be positive when it only dilutes the team stop its own trains pay",
);
assert.ok(
  candidateCosts(lowTrainConstruction.candidates).every((cost) => cost !== undefined) &&
    candidateCosts(saturatedConstruction.candidates).every((cost) => cost !== undefined),
  "Legendary Factory/City candidates keep live Config costs at both train counts",
);

// A City only earns when OTHER owners' trains stop there (both endpoint
// owners are paid), so teammate-owned factories must increase its live ROI.
const teammateFactoryStations = Array.from({ length: 6 }, (_, index) =>
  station(`team-factory-${index}`, index + 10),
);
const cityFlipOwnCities = [station("own-city-0", 0), station("own-city-1", 1)];
const cityFlipOwnOwner = Object.assign(
  makeOwner(1, {
    [LiveUnitType.City]: cityFlipOwnCities,
    [LiveUnitType.Factory]: [],
  }),
  { gold: () => 10_000_000n },
);
const cityFlipTeammate = makeOwner(2, {
  [LiveUnitType.Factory]: teammateFactoryStations,
  [LiveUnitType.City]: [station("team-city", 20)],
});
let cityFlipTrainCount = 0;
let cityFlipRouteActive = true;
const cityFlipBehavior = Object.create(structureSandbox.__StructureBehavior!.prototype);
Object.assign(cityFlipBehavior, {
  game: {
    config: () => config,
    players: () =>
      cityFlipRouteActive ? [cityFlipOwnOwner, cityFlipTeammate] : [cityFlipOwnOwner],
    units: (type: string) =>
      type === LiveUnitType.Train ? Array.from({ length: cityFlipTrainCount }) : [],
    ticks: () => 0,
  },
  player: cityFlipOwnOwner,
  buildReachableStations: (types: string[], owners: ReturnType<typeof makeOwner>[]) =>
    owners.flatMap((owner) =>
      owner.units(...types).map((unit) => ({ tile: unit.tile(), cluster: "rail#team" })),
    ),
  readRailroadState: () => ({}),
  assignRailClusters: (entries: { tile: unknown }[]) => entries.map(() => "rail#team"),
  structureCandidateTiles: (type: string) =>
    type === LiveUnitType.City ? ["city-route-candidate"] : [],
  legendaryRailMetrics: () => ({
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 2,
    tradeNeed: 0,
  }),
  enemyMissileSiloPressure: () => [],
  getMissileDefenseContext: () => ({ critical: false, score: 0 }),
  legendaryHostilePlayers: () => [],
  hasTradeablePortOnSharedWater: () => false,
  legendaryEnemyTargetPressure: () => 0,
  legendaryConstructionDefenseGap: () => 0.25,
  legendaryPortSurvivability: () => 1,
  ownSamCapacity: () => 0,
  missileSiloParityTarget: () => 0,
  samLevelParityTarget: () => 0,
  samLevelParityGap: () => 0,
  legendaryPortSeedWindowOpen: () => false,
  legendaryPortCandidateTilesForEconomy: () => [],
  portWaterComponents: () => new Set(),
  hasAnyShoreBorderTile: () => false,
  legendarySamChestBlocksType: () => false,
  probeLegendaryThroughputUpgradeCandidates: async () => [],
  computeTroopCapPressure: () => false,
  availableGoldAfterReserve: () => cityFlipOwnOwner.gold(),
});
const rankCityFlipAt = async (trainCount: number, routeActive = true) => {
  cityFlipTrainCount = trainCount;
  cityFlipRouteActive = routeActive;
  const candidates = await cityFlipBehavior.legendaryConstructionCandidates({
    config,
    citiesDisabled: false,
    cityCount: cityFlipOwnCities.length,
    hasCoastalTiles: false,
    hasOceanPortTiles: false,
    missileSilosEnabled: false,
    nukesEnabled: false,
  });
  return {
    winner: cityFlipBehavior.legendaryConstructionActionGroups(candidates, true)[0]?.[0],
    city: candidates.find((candidate) => candidate.type === LiveUnitType.City),
  };
};
const saturatedCityWithTeammateRoute = await rankCityFlipAt(300);
const saturatedCityWithoutTeammateRoute = await rankCityFlipAt(300, false);
assert.equal(
  Number(liveTrainGold("team", 9, player)),
  25_000,
  "a known 9-stop train still receives the full live Config payout",
);
assert.equal(
  Number(liveTrainGold("team", 10, player)),
  20_000,
  "live Config supplies the decayed per-stop payout for a mature train",
);
assert.ok(
  observedTrainGoldCalls.some(
    ({ relation, citiesVisited, gold }) =>
      relation === "team" && citiesVisited === 10 && gold === 20_000,
  ),
  "the Legendary economy helper prices an unknown train using Config's 10-stop rate",
);
assert.ok(
  saturatedCityWithTeammateRoute.city?.mandatory === 0 &&
    (saturatedCityWithTeammateRoute.city?.netTeamGold ?? 0n) > 0n &&
    (saturatedCityWithTeammateRoute.city?.netTeamGold ?? 0n) >
      (saturatedCityWithoutTeammateRoute.city?.netTeamGold ?? 0n),
  "a non-mandatory City earns positive live-Config ROI from eligible teammate train stops",
);

process.stdout.write("construction simulator live config tests passed\n");
