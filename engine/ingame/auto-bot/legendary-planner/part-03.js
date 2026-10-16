      ? Number(game.ticksSinceStart()) || 0
      : Number(tick) || 0,
  );
  // DIVERGENCE: without a configured match timer, WinCheckExecution's
  // 170-minute hard cap is the only deterministic horizon exposed by source.
  const usefulMinutes = Math.min(
    Number.isFinite(timerMinutes) && timerMinutes > 0 ? timerMinutes : 170,
    170,
  );
  const remainingMilliseconds =
    usefulMinutes * 60_000 - currentTick * millisecondsPerTick;
  const matchHorizonTicks = Math.max(
    0,
    Math.floor(remainingMilliseconds / millisecondsPerTick),
  );
  return legendaryDoomsdayHorizonTicks(
    matchHorizonTicks,
    gameConfig,
    millisecondsPerTick,
    player,
  );
}

// Returns null when live inputs are missing (gate opt-out, ranking unchanged)
// and { refused: true } when the policy itself forbids the pure-economy build.
function legendaryExpectedTrainRatePerTick(level, spawnDenominator) {
  const rolls = Math.max(0, Math.floor(Number(level) || 0));
  const denominator = Math.max(1, Number(spawnDenominator) || 1);
  if (rolls === 0) return 0;
  const spawnChance = 1 - (1 - 1 / denominator) ** rolls;
  // TrainStationExecution blocks nine ticks after a successful spawn, then
  // retries on the tenth; expected interval is 9 + the geometric retry time.
  return spawnChance / (1 + 9 * spawnChance);
}

function legendaryExpectedTradeShipRatePerTick(level, tradeShipCount, config) {
  const rolls = Math.max(0, Math.floor(Number(level) || 0));
  if (rolls === 0 || typeof config?.tradeShipSpawnRate !== "function") return 0;
  const ships = Math.max(0, Math.floor(Number(tradeShipCount) || 0));
  let survival = 1;
  let expectedCycles = 0;
  for (let rejected = 0; rejected < 512 && survival > 1e-9; rejected += rolls) {
    expectedCycles += survival;
    for (let roll = 0; roll < rolls; roll++) {
      const denominator = Math.max(
        1,
        Number(config.tradeShipSpawnRate(rejected + roll, ships)) || 1,
      );
      survival *= 1 - 1 / denominator;
    }
  }
  return expectedCycles > 0 ? 1 / (expectedCycles * 10) : 0;
}

const LEGENDARY_ECONOMY_RATE_CACHES = new WeakMap();
const LEGENDARY_TRAIN_UNITS_PER_CONSIST = 7;

function legendaryEconomyRateCaches(supply, config) {
  if (
    supply === null || typeof supply !== "object" ||
    config === null || typeof config !== "object"
  ) {
    return {
      train: new Map(),
      trade: new Map(),
      baseline: new Map(),
      candidates: new Map(),
      tradePrefixes: new WeakMap(),
      tradeDeltaPrefixes: new WeakMap(),
    };
  }
  // Train/trade rates are pure functions of (config, level, integer count), so
  // their maps are hoisted to config scope and shared across supplies. The
  // fractional interpolation stays outside these maps; projection, candidate,
  // and prefix caches keep their per-supply keying.
  let byConfig = LEGENDARY_ECONOMY_RATE_CACHES.get(config);
  if (!byConfig) {
    byConfig = { train: new Map(), trade: new Map(), bySupply: new WeakMap() };
    LEGENDARY_ECONOMY_RATE_CACHES.set(config, byConfig);
  }
  let caches = byConfig.bySupply.get(supply);
  if (!caches) {
    caches = {
      train: byConfig.train,
      trade: byConfig.trade,
      baseline: new Map(),
      candidates: new Map(),
      tradePrefixes: new WeakMap(),
      tradeDeltaPrefixes: new WeakMap(),
    };
    byConfig.bySupply.set(supply, caches);
  }
  return caches;
}

function legendaryExpectedTrainRateAtFleet(
  level,
  factoryCount,
  expectedTrainCount,
  config,
  rateCache,
) {
  const count = Math.max(0, Number(expectedTrainCount) || 0);
  const lower = Math.floor(count);
  const fraction = count - lower;
  const rateAt = (trains) => {
    let byFactoryCount = rateCache?.get(factoryCount);
    if (!byFactoryCount) {
      byFactoryCount = new Map();
      rateCache?.set(factoryCount, byFactoryCount);
    }
    let byLevel = byFactoryCount.get(level);
    if (!byLevel) {
      byLevel = new Map();
      byFactoryCount.set(level, byLevel);
    }
    if (byLevel.has(trains)) return byLevel.get(trains);
    const rate = legendaryExpectedTrainRatePerTick(
      level,
      Math.max(1, Number(config?.trainSpawnRate?.(factoryCount, trains)) || 1),
    );
    byLevel.set(trains, rate);
    return rate;
  };
  const lowerRate = rateAt(lower);
  if (fraction === 0) return lowerRate;
  return lowerRate + fraction * (rateAt(lower + 1) - lowerRate);
}

function legendaryExpectedTradeRateAtFleet(level, expectedTradeShipCount, config, rateCache) {
  const count = Math.max(0, Number(expectedTradeShipCount) || 0);
  const lower = Math.floor(count);
  const fraction = count - lower;
  const rateAt = (ships) => {
    let byLevel = rateCache?.get(level);
    if (!byLevel) {
      byLevel = new Map();
      rateCache?.set(level, byLevel);
    }
    if (byLevel.has(ships)) return byLevel.get(ships);
    const rate = legendaryExpectedTradeShipRatePerTick(level, ships, config);
    byLevel.set(ships, rate);
    return rate;
  };
  const lowerRate = rateAt(lower);
  if (fraction === 0) return lowerRate;
  return lowerRate + fraction * (
    rateAt(lower + 1) - lowerRate
  );
}

function legendaryNormalizedTradeRoutes(routes) {
  const distanceFor = (route) => route?.distance ?? route?.travelTicks;
  const validRoutes = (Array.isArray(routes) ? routes : []).filter((route) =>
    Number(route?.weight) > 0 &&
    Number.isFinite(Number(distanceFor(route))) &&
    Number(distanceFor(route)) >= 0,
  );
  const totalWeight = validRoutes.reduce(
    (total, route) => total + Number(route.weight),
    0,
  );
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return [];
