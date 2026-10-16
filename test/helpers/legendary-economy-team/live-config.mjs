// Shared live-Config and VM fixtures for Legendary team-economy scenarios.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLegendaryStructureSandbox } from "../legendary-structure-fixture.mjs";

import { installScenarioMutation } from "./mutations.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Load the vendored Config and the production classic-script sandbox. */
export async function createLiveScenarioHarness(vmFilename) {
  const { register: registerTsxLoader } = await import("tsx/esm/api");
  const unregisterTsxLoader = registerTsxLoader({
    tsconfig: path.resolve(repoRoot, "openfront-engine/tsconfig.json"),
  });
  const { Config: LiveEngineConfig } =
    await import("../../../openfront-engine/src/core/configuration/Config.ts");
  const { PlayerType: LivePlayerType, UnitType: LiveUnitType } =
    await import("../../../openfront-engine/src/core/game/Game.ts");
  unregisterTsxLoader();
  const liveConfig = new LiveEngineConfig({ maxTimerValue: 120 }, null, false);
  const sandbox = createLegendaryStructureSandbox({ vmFilename });
  installScenarioMutation(sandbox);
  const goldPlayer = { isLobbyCreator: () => false };
  const liveDurationOf = (type) =>
    Math.max(
      0,
      Math.floor(Number(liveConfig.unitInfo(LiveUnitType[type]).constructionDuration) || 0),
    );
  const liveCostOf = (type, existingLevels = 0) => {
    const costPlayer = {
      type: () => LivePlayerType.Nation,
      isLobbyCreator: () => false,
      unitsOwned: (unit) => Number(unit === LiveUnitType[type]) * existingLevels,
      unitsConstructed: (unit) => Number(unit === LiveUnitType[type]) * existingLevels,
    };
    return Number(liveConfig.unitInfo(LiveUnitType[type]).cost({}, costPlayer));
  };
  const liveTrainGold = (relation, citiesVisited = 10) =>
    Number(liveConfig.trainGold(relation, citiesVisited, goldPlayer));
  const liveTradeShipGold = (distance) => Number(liveConfig.tradeShipGold(distance, goldPlayer));
  const liveEconomyConfig = {
    unitInfo: (type) => liveConfig.unitInfo(type),
    trainSpawnRate: (factories, trains) => liveConfig.trainSpawnRate(factories, trains),
    tradeShipSpawnRate: (rejections, ships) => liveConfig.tradeShipSpawnRate(rejections, ships),
  };
  const countWhereLiveRateDoubles = (rateAtCount) => {
    const baseline = rateAtCount(0);
    if (!Number.isFinite(baseline) || baseline <= 0) {
      throw new Error("live Config returned an invalid open-fleet spawn denominator");
    }
    let low = 0;
    let high = 1;
    while (rateAtCount(high) < baseline * 2) {
      low = high;
      high *= 2;
      if (!Number.isSafeInteger(high)) {
        throw new Error("live Config did not expose a doubled saturation denominator");
      }
    }
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (rateAtCount(middle) >= baseline * 2) high = middle;
      else low = middle;
    }
    return high;
  };
  // Find the count where each live Config denominator doubles.
  const saturatedTrainCount = (factories = 1) =>
    countWhereLiveRateDoubles((trains) => liveConfig.trainSpawnRate(factories, trains));
  const saturatedTradeShipCount = () =>
    countWhereLiveRateDoubles((ships) => liveConfig.tradeShipSpawnRate(0, ships));
  const matchHorizonTicks = Math.floor(
    (liveConfig.gameConfig().maxTimerValue * 60_000) / liveConfig.msPerTick(),
  );
  return {
    sandbox,
    UNIT: sandbox.UNIT,
    liveConfig,
    LivePlayerType,
    liveEconomyConfig,
    liveDurationOf,
    liveCostOf,
    liveTradeShipGold,
    liveTrainGold,
    matchHorizonTicks,
    saturatedTrainCount,
    saturatedTradeShipCount,
  };
}
