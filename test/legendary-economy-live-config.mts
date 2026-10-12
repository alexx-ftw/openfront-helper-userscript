// Focused Config-live regression for the Legendary economy planner: spawn
// multipliers must track the live Config train/trade-ship saturation curves,
// and the live curves must price high global fleets below open ones.
// test/fixtures/game-constants.json inventories Config.ts's top-level
// constants only (the spawn curves are methods), so the curves are read from
// the live Config exactly like test/construction-simulator-live-config.mts.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const constantFixture = JSON.parse(read("test/fixtures/game-constants.json"));
assert.ok(
  constantFixture.some(
    (entry: { file: string }) => entry.file === "openfront-engine/src/core/configuration/Config.ts",
  ),
  "the game-constant fixture still inventories the live Config source",
);

const plannerSandbox: Record<string, unknown> = {};
executeClassicScript(read("engine/ingame/auto-bot/legendaryPlanner.js"), plannerSandbox, {
  filename: "legendaryPlanner.js",
});
const legendaryEconomySpawnMultipliers = plannerSandbox.legendaryEconomySpawnMultipliers as (
  config: unknown,
  factoryCount: number,
  trainCount: number,
  tradeShipCount: number,
) => { trainSpawnMultiplier: number; tradeShipSpawnMultiplier: number };
const legendaryEconomyNetGold = plannerSandbox.legendaryEconomyNetGold as (
  type: string,
  request: {
    cost: number;
    horizonTicks: number;
    inputs: Record<string, unknown>;
    config: Record<string, unknown>;
  },
) => { incomePerTick?: number; netTeamGold?: number; refused?: boolean } | null;
assert.equal(typeof legendaryEconomySpawnMultipliers, "function");
assert.equal(typeof legendaryEconomyNetGold, "function");

const config = new Config({ maxTimerValue: 120 }, null, false);
const player = { isLobbyCreator: () => false } as Parameters<Config["trainGold"]>[2];
const costPlayer = {
  type: () => LivePlayerType.Nation,
  isLobbyCreator: () => false,
  unitsOwned: (type: string) => Number(type === LiveUnitType.Factory || type === LiveUnitType.Port),
  unitsConstructed: (type: string) =>
    Number(type === LiveUnitType.Factory || type === LiveUnitType.Port),
} as Parameters<ReturnType<Config["unitInfo"]>["cost"]>[1];
const horizonTicks = Math.floor((config.gameConfig().maxTimerValue * 60_000) / config.msPerTick());
const liveDurationOf = (type: keyof typeof LiveUnitType) =>
  Math.max(0, Math.floor(Number(config.unitInfo(LiveUnitType[type]).constructionDuration) || 0));
const liveEconomyConfig = {
  unitInfo: (type: LiveUnitType) => config.unitInfo(type),
  trainSpawnRate: (factories: number, trains: number) => config.trainSpawnRate(factories, trains),
  tradeShipSpawnRate: (rejections: number, ships: number) =>
    config.tradeShipSpawnRate(rejections, ships),
};

// Grid of live counts (zero through saturation plateaus): the planner
// multipliers must equal the exact live-Config baseline/current ratios.
for (const factories of [0, 1, 3, 10, 40]) {
  for (const trains of [0, 30, 120, 560, 1_000]) {
    for (const ships of [0, 60, 330, 900, 1_500]) {
      const observed = legendaryEconomySpawnMultipliers(
        liveEconomyConfig,
        factories,
        trains,
        ships,
      );
      const expectedTrain =
        config.trainSpawnRate(factories + 1, 0) / config.trainSpawnRate(factories + 1, trains);
      const expectedShips = config.tradeShipSpawnRate(0, 0) / config.tradeShipSpawnRate(0, ships);
      assert.ok(
        Math.abs(observed.trainSpawnMultiplier - expectedTrain) < 1e-12,
        `train multiplier tracks live Config at factories=${factories}, trains=${trains}`,
      );
      assert.ok(
        Math.abs(observed.tradeShipSpawnMultiplier - expectedShips) < 1e-12,
        `trade-ship multiplier tracks live Config at factories=${factories}, ships=${ships}`,
      );
      if (trains === 0) assert.equal(observed.trainSpawnMultiplier, 1);
      if (ships === 0) assert.equal(observed.tradeShipSpawnMultiplier, 1);
      if (trains >= 560) assert.ok(observed.trainSpawnMultiplier < 1);
      if (ships >= 900) assert.ok(observed.tradeShipSpawnMultiplier < 1);
    }
  }
}

// Net gold under the live curves: the same Factory/Port priced at a saturated
// global fleet must earn less than at an open fleet (same cost, same routes).
const teamTrainGold = Number(config.trainGold("team", 10, player)) * 2;
const factoryCost = Number(config.unitInfo(LiveUnitType.Factory).cost({} as never, costPlayer));
const factoryValueAt = (trainCount: number) =>
  legendaryEconomyNetGold("Factory", {
    cost: factoryCost,
    horizonTicks,
    inputs: {
      trainCount,
      factoryPaidStops: 1,
      factoryTeamGoldPerTrain: teamTrainGold,
      ownFactoryCount: 1,
      ownProductiveFactoryLevels: [1],
      ownPendingFactoryLevels: [],
      routeDelayTicks: 0,
    },
    config: liveEconomyConfig,
  });
const openTrainValue = factoryValueAt(0);
const saturatedTrainValue = factoryValueAt(1_000);
assert.ok(
  openTrainValue !== null &&
    openTrainValue.refused !== true &&
    typeof openTrainValue.netTeamGold === "number" &&
    openTrainValue.netTeamGold > 0,
  `an open live train pool pays back a Factory: ${JSON.stringify(openTrainValue)}`,
);
assert.ok(
  saturatedTrainValue !== null &&
    saturatedTrainValue.refused !== true &&
    saturatedTrainValue.netTeamGold < openTrainValue.netTeamGold,
  `live train saturation lowers Factory net gold: open=${openTrainValue?.netTeamGold}, saturated=${saturatedTrainValue?.netTeamGold}`,
);

const tradeGoldPerArrival = Number(config.tradeShipGold(100, player)) * 2;
const portCost = Number(config.unitInfo(LiveUnitType.Port).cost({} as never, costPlayer));
const portValueAt = (tradeShipCount: number) =>
  legendaryEconomyNetGold("Port", {
    cost: portCost,
    horizonTicks,
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
    config: liveEconomyConfig,
  });
const openFleetValue = portValueAt(0);
const saturatedFleetValue = portValueAt(1_500);
assert.ok(
  openFleetValue !== null &&
    openFleetValue.refused !== true &&
    typeof openFleetValue.netTeamGold === "number" &&
    openFleetValue.netTeamGold > 0,
  `an open live trade fleet pays back a Port: ${JSON.stringify(openFleetValue)}`,
);
assert.ok(
  saturatedFleetValue !== null &&
    saturatedFleetValue.refused !== true &&
    saturatedFleetValue.netTeamGold < openFleetValue.netTeamGold,
  `live trade-ship saturation lowers Port net gold: open=${openFleetValue?.netTeamGold}, saturated=${saturatedFleetValue?.netTeamGold}`,
);

// Delayed seed pair priced with live Config Port durations: no payout until
// the slower partner Port finishes construction.
const portTicks = liveDurationOf("Port");
assert.ok(portTicks > 0, "live Config gives Port a nonzero construction duration");
const partnerReadyTicks = portTicks * 2;
const seedSources = [
  {
    level: 1,
    portSeedStream: "own",
    routes: [{ weight: 1, distance: 0, teamGoldPerArrival: tradeGoldPerArrival }],
  },
  {
    level: 1,
    portSeedStream: "partner",
    constructionDelayTicks: partnerReadyTicks,
    routes: [{ weight: 1, distance: 0, teamGoldPerArrival: tradeGoldPerArrival }],
  },
];
const seedValueAt = (horizon: number) =>
  legendaryEconomyNetGold("Port", {
    cost: portCost,
    horizonTicks: horizon,
    inputs: {
      hasCompletedTradePartner: false,
      portSeedWindowOpen: true,
      portSeedPartnerCommitted: true,
      tradeShipCount: 0,
      portSeedSources: seedSources,
    },
    config: liveEconomyConfig,
  });
assert.equal(
  seedValueAt(portTicks + 1)?.refused,
  true,
  "the seed pair pays nothing while only the own Port has completed",
);
assert.equal(
  seedValueAt(partnerReadyTicks)?.refused,
  true,
  "the seed pair pays nothing at the tick the partner Port completes",
);
const afterPartner = seedValueAt(partnerReadyTicks + 1);
assert.ok(
  afterPartner !== null &&
    afterPartner.refused !== true &&
    typeof afterPartner.incomePerTick === "number" &&
    afterPartner.incomePerTick > 0,
  "the delayed seed pair earns from both owners' streams once both Ports are complete",
);

process.stdout.write(
  `legendary economy live-config tests passed (spawn grid, train/ship saturation, delayed seed pair)\n`,
);
