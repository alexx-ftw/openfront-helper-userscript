// Auto-Bot — Legendary construction planner.
//
// Legendary is intentionally not a 1:1 Nation port. It ranks the available
// construction intents with an equal-weight max-min objective over gold and
// troops. Missile defense is a safety constraint/tie-breaker, not a third
// production axis; during an un-defended missile salvo it becomes a hard
// construction gate. Troop-cap pressure (an army at its maxTroops ceiling)
// contributes a `capacity` priority: the cheapest cap relief — a City build or
// City upgrade — then outranks non-defense intents so idle treasury is
// converted into troop-capacity growth instead of cheaper balanced assets.
// The existing structure behavior still owns buildability, cost formulas,
// upgrades, and rank-then-probe placement.

"use strict";

// Priority fields are compared before any production axis. `mandatory` and
// `safety` remain the defense-critical gates: an urgent interceptor or Defense
// Post always outranks everything else. `capacity` is the troop-cap relief
// priority: while the army sits at its maxTroops ceiling every further
// troop-second of production is lost, so an affordable City build/upgrade —
// the only action that raises the ceiling — outranks non-defense candidates
// (Port/Factory/Silo) that would otherwise win the production balance.
const LEGENDARY_PRIORITY_FIELDS = ["mandatory", "safety", "capacity"];
const LEGENDARY_PRIMARY_FIELDS = ["gold", "troops"];
const LEGENDARY_OBJECTIVE_FIELDS = [...LEGENDARY_PRIMARY_FIELDS, "defense"];
const LEGENDARY_TIE_FIELDS = ["strategic", "deficit", "netTeamGold", "efficiency"];

// The exact fallback covers normal emergency chains. It is bounded by both a
// route count and a node budget: a greedy miss is never presented as a proof
// of impossibility when the exact search is skipped or exhausted.
const LEGENDARY_EXACT_SCHEDULE_ROUTE_LIMIT = 16;
const LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT = 100_000;

// Normalized marginal-role vectors. These are deliberately not combined into a
// hidden weighted sum: rankLegendaryConstructionCandidates maximizes the weakest
// productive axis first. Defense is a guardrail and tie-breaker during normal
// play, but an un-defended missile salvo is a hard safety gate.
const LEGENDARY_BASE_OBJECTIVES = {
  City: { gold: 3, troops: 5, defense: 1 },
  Factory: { gold: 3, troops: 1, defense: 1 },
  Port: { gold: 4, troops: 2, defense: 4 },
  "Missile Silo": { gold: 1, troops: 1, defense: 1 },
  "SAM Launcher": { gold: 1, troops: 1, defense: 5 },
};

function legendaryBigInt(value) {
  if (typeof value === "bigint") return value;
  {
    return BigInt(value ?? 0);
  }
}

function legendaryScoreValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

// The custom missile plan needs one conservative parity target: for each
// hostile player, sum the levels of the relevant unit and keep the largest
// enemy total. This is deliberately a max-per-enemy rather than a global sum;
// several unrelated opponents must not make one nation's target grow without
// bound.
function legendaryMaxEnemyLevelSum(enemyUnitLevels = []) {
  let maximum = 0;
  for (const levels of Array.isArray(enemyUnitLevels) ? enemyUnitLevels : []) {
    if (!Array.isArray(levels)) continue;
    const capacity = levels.reduce((total, level) => {
      let raw = level;
      if (level !== null && typeof level === "object") {
        raw = level.level ?? level.value ?? 0;
      }
      {
        if (typeof raw === "function") raw = raw();
        const number = Number(raw);
        return total +
          (Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0);
      }
    }, 0);
    maximum = Math.max(maximum, capacity);
  }
  return maximum;
}

function legendaryMaxEnemySamCapacity(enemySamLevels = []) {
  return legendaryMaxEnemyLevelSum(enemySamLevels);
}

function legendaryMaxEnemySiloCapacity(enemySiloLevels = []) {
  return legendaryMaxEnemyLevelSum(enemySiloLevels);
}

function legendaryWeaponKey(weapon) {
  return String(weapon ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
}

function legendaryClamp(value, minimum, maximum) {
  return Math.min(Math.max(legendaryScoreValue(value), minimum), maximum);
}

function legendaryLog10Magnitude(value) {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    const digits = value.toString();
    const prefixLength = Math.min(15, digits.length);
    const prefix = Number(digits.slice(0, prefixLength));
    return digits.length - prefixLength + Math.log10(Math.max(1, prefix));
  }
  const number = Math.max(0, legendaryScoreValue(value));
  return number > 0 ? Math.log10(number) : 0;
}

function legendaryRelativeMagnitude(value, baseline) {
  const numerator = legendaryLog10Magnitude(legendaryBigInt(value) + 1n);
  const denominator = legendaryLog10Magnitude(legendaryBigInt(baseline) + 1n);
  return 10 ** legendaryClamp(numerator - denominator, -2, 2);
}

// Ally strength is intentionally a max across the three user-specified power
// signals. A partner can be strategically valuable because it has troops, a
// large treasury, or a high gold-production engine; averaging would hide a
// dominant signal behind two weaker ones.
function legendaryAllyPowerScore({
  allyTroops = 0,
  allyGold = 0n,
  allyProduction = 0,
  ownTroops = 0,
  ownGold = 0n,
  ownProduction = 0,
} = {}) {
  return legendaryClamp(
    Math.max(
      legendaryRelativeMagnitude(allyTroops, ownTroops),
      legendaryRelativeMagnitude(allyGold, ownGold),
      legendaryRelativeMagnitude(allyProduction, ownProduction),
    ),
    0.25,
    4,
  );
}

function legendaryPlacementProximityScore(distance, radius) {
  const d = Math.max(0, legendaryScoreValue(distance));
  const r = Math.max(1, legendaryScoreValue(radius));
  return 1 / (1 + d / r);
}

function legendaryConstructionObjectiveVector(type, context = {}) {
  const base = LEGENDARY_BASE_OBJECTIVES[type] ?? {
    gold: 0,
    troops: 0,
    defense: 0,
  };
  const connectedCities = Math.max(0, legendaryScoreValue(context.connectedCities));
  const cityRailConnection = legendaryClamp(
    context.cityRailConnection ?? 1,
    0,
    1,
  );
  const railNeed = legendaryClamp(context.railNeed ?? 1, 0.25, 2.5);
  const tradeNeed = legendaryClamp(context.tradeNeed ?? 1, 0.25, 2.5);
  const trainSpawnMultiplier = Math.max(
    0,
    legendaryScoreValue(context.trainSpawnMultiplier ?? 1),
  );
  const tradeShipSpawnMultiplier = Math.max(
    0,
    legendaryScoreValue(context.tradeShipSpawnMultiplier ?? 1),
  );
  const destroyerNeed = legendaryClamp(
    context.destroyerNeed ?? 1,
    0.25,
    2.5,
  );
  const defenseGap = legendaryClamp(context.defenseGap ?? 1, 0.25, 2.5);
  const costFactor = legendaryClamp(context.costFactor ?? 1, 0.25, 1);
  const hasTradePartner = context.hasTradePartner !== false;
  const portSurvivability = legendaryClamp(
    context.portSurvivability ?? 1,
    0.35,
    1,
  );

  let vector;

  switch (type) {
    case "City":
      vector = {
        gold: (base.gold * cityRailConnection) / (1 + connectedCities),
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "Factory":
      vector = {
        gold: base.gold * railNeed * trainSpawnMultiplier,
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "Port":
      vector = {
        gold: hasTradePartner
          ? base.gold * tradeNeed * tradeShipSpawnMultiplier
          : 0,
        troops: base.troops * portSurvivability,
        defense: base.defense * destroyerNeed * portSurvivability,
      };
      break;
    case "Missile Silo":
      vector = {
        gold: base.gold,
        troops: base.troops,
        defense: base.defense,
      };
      break;
    case "SAM Launcher":
      vector = {
        gold: base.gold,
        troops: base.troops,
        defense: base.defense * defenseGap,
      };
      break;
    default:
      vector = { ...base };
  }

  return Object.fromEntries(
    LEGENDARY_OBJECTIVE_FIELDS.map((field) => [
      field,
      legendaryScoreValue(vector[field]) * costFactor,
    ]),
  );
}

function legendaryEconomySpawnMultipliers(
  config,
  factoryCount,
  trainCount,
  tradeShipCount,
) {
  // Config returns spawn denominators, so baseline/current is live odds relative
  // to a zero-fleet baseline.
  const ratio = (baseline, current) => {
    const baselineRate = Number(baseline);
    const currentRate = Number(current);
    return Number.isFinite(baselineRate) && baselineRate > 0 &&
        Number.isFinite(currentRate) && currentRate > 0
      ? baselineRate / currentRate
      : 1;
  };
  const factories = Math.max(0, Math.floor(legendaryScoreValue(factoryCount)));
  const trains = Math.max(0, Math.floor(legendaryScoreValue(trainCount)));
  const tradeShips = Math.max(0, Math.floor(legendaryScoreValue(tradeShipCount)));

  return {
    trainSpawnMultiplier:
      typeof config?.trainSpawnRate === "function"
        ? ratio(
            config.trainSpawnRate(factories + 1, 0),
            config.trainSpawnRate(factories + 1, trains),
          )
        : 1,
    // DIVERGENCE: the client cannot read PortExecution's private rejection
    // counter, so compare fresh-attempt odds from the live Config function.
    tradeShipSpawnMultiplier:
      typeof config?.tradeShipSpawnRate === "function"
        ? ratio(
            config.tradeShipSpawnRate(0, 0),
            config.tradeShipSpawnRate(0, tradeShips),
          )
        : 1,
  };
}

// Marginal expected-gold policy inputs. The engine pays trains at City/Port
// stops (Factory stops pay nothing), so an economic candidate is only as
// productive as the paid route it unlocks; saturation and the match timer are
// read live from Config instead of being hardcoded ROI constants.
function legendaryDoomsdayHorizonTicks(
  matchHorizonTicks,
  gameConfig,
  millisecondsPerTick,
  player,
) {
  const rotDeathSeconds = Number(gameConfig?.rotDeathSeconds);
  if (
    player?.inDoomsdayClock?.() !== true ||
    !Number.isFinite(rotDeathSeconds) ||
    rotDeathSeconds <= 0 ||
    typeof player?.doomsdayClockTicks !== "function"
  ) {
    return matchHorizonTicks;
  }
  // DIVERGENCE: the clock is a deterministic loss deadline; no general combat defeat ETA is exposed.
  const remainingDoomsdayTicks = Math.floor(
    (rotDeathSeconds * 1_000) / millisecondsPerTick -
      Math.max(0, Number(player.doomsdayClockTicks()) || 0),
  );
  return Math.min(matchHorizonTicks, Math.max(0, remainingDoomsdayTicks));
}

function legendaryStructureHorizonTicks(game, tick, player) {
  const config = game?.config?.();
  const gameConfig = config?.gameConfig?.();
  const timerMinutes = Number(gameConfig?.maxTimerValue);
  const millisecondsPerTick = Math.max(
    1,
    Number(config?.msPerTick?.() ?? 100),
  );
  // Client GameView exposes ticksSinceStart() (GameView.ts:1171-1177), which
  // already subtracts the spawn-phase startTick the raw tick includes. Fixtures
  // without that method keep the raw tick (equivalent for tick 0 fixtures).
  const currentTick = Math.max(
    0,
    typeof game?.ticksSinceStart === "function"
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

function legendaryPortFallbackRoute(profile, fallbackDistance) {
  const activeGold = profile?.teamGoldPerArrival ?? profile?.portTradeGoldPerArrival ?? 0;
  return {
    weight: 1,
    postAllianceWeight: profile?.postAllianceWeight ?? 1,
    distance:
      profile?.routeDelayTicks ?? profile?.portRouteDelayTicks ?? fallbackDistance,
    teamGoldPerArrival: activeGold,
    postAllianceGoldPerArrival:
      profile?.postAllianceGoldPerArrival ??
      profile?.portPostAllianceGoldPerArrival ??
      activeGold,
    allianceTicksRemaining: profile?.allianceTicksRemaining ?? Infinity,
  };
}

function legendaryPortRoutes(profile, fallbackDistance) {
  const routes = profile?.routes ?? profile?.portRoutes;
  return Array.isArray(routes) && routes.length > 0
    ? routes
    : [legendaryPortFallbackRoute(profile, fallbackDistance)];
}

function legendaryPortRate(level, upgrade, tradeShipCount, config) {
  const currentRate = legendaryExpectedTradeShipRatePerTick(
    level,
    tradeShipCount,
    config,
  );
  return upgrade
    ? Math.max(
        0,
        legendaryExpectedTradeShipRatePerTick(level + 1, tradeShipCount, config) -
          currentRate,
      )
    : currentRate;
}

function legendaryPortRouteGold(
  route,
  rate,
  totalWeight,
  postAllianceTotalWeight,
  startDelayTicks,
  horizon,
) {
  const weight = Math.max(0, Number(route.weight) || 0) / totalWeight;
  const postAllianceWeight = Math.max(
    0,
    Number(route.postAllianceWeight ?? route.weight) || 0,
  ) / postAllianceTotalWeight;
  const delay = Math.max(0, Number(route.distance) || 0);
  const routeTicks = Math.max(0, horizon - startDelayTicks - delay);
  const allianceTicks = Math.max(
    0,
    Number(route.allianceTicksRemaining ?? Infinity) - startDelayTicks - delay,
  );
  const activeTicks = Math.min(routeTicks, allianceTicks);
  const activeGold = Math.max(0, Number(route.teamGoldPerArrival ?? 0));
  const postGold = Math.max(
    0,
    Number(route.postAllianceGoldPerArrival ?? activeGold),
  );
  return rate * (
    weight * activeGold * activeTicks +
      postAllianceWeight * postGold * (routeTicks - activeTicks)
  );
}

function legendaryPortExpectedGold(profile, options) {
  const routes = legendaryPortRoutes(profile, options.fallbackDistance);
  const totalWeight = routes.reduce(
    (total, route) => total + Math.max(0, Number(route.weight) || 0),
    0,
  );
  if (totalWeight <= 0) return 0;
  const postAllianceTotalWeight = routes.reduce(
    (total, route) =>
      total + Math.max(0, Number(route.postAllianceWeight ?? route.weight) || 0),
    0,
  );
  if (postAllianceTotalWeight <= 0) return 0;
  const rate = legendaryPortRate(
    options.level,
    options.upgrade,
    options.tradeShipCount,
    options.config,
  );
  return routes.reduce(
    (total, route) =>
      total + legendaryPortRouteGold(
        route,
        rate,
        totalWeight,
        postAllianceTotalWeight,
        options.startDelayTicks,
        options.horizon,
      ),
    0,
  );
}

function legendaryPayoutTimelineValue(source, key, tick, timeline, fallbackRates) {
  let value;
  for (const point of timeline) {
    if (Math.max(0, Number(point?.atTicks) || 0) > tick) break;
    if (point?.[key] !== undefined) value = Number(point[key]);
  }
  if (Number.isFinite(value)) return Math.max(0, value);
  const expiresAt = Math.max(0, Number(source?.eligibleTicks ?? Infinity));
  const fallbackRate = tick < expiresAt ? fallbackRates.current : fallbackRates.post;
  return Math.max(0, Number(fallbackRate) || 0);
}

function legendaryPayoutTimelineBoundaries(source, start, end, timeline) {
  const boundaries = new Set([start, end]);
  const fallbackExpiry = Number(source?.eligibleTicks ?? Infinity);
  if (Number.isFinite(fallbackExpiry) && fallbackExpiry > start && fallbackExpiry < end) {
    boundaries.add(fallbackExpiry);
  }
  for (const point of timeline) {
    const atTicks = Number(point?.atTicks);
    if (Number.isFinite(atTicks) && atTicks > start && atTicks < end) {
      boundaries.add(atTicks);
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

function legendaryIntegratePayoutTimeline(source, key, startAt, endAt, fallbackRates) {
  const start = Math.max(0, Number(startAt) || 0);
  const end = Math.max(start, Number(endAt) || 0);
  if (end <= start) return 0;
  const timeline = Array.isArray(source?.payoutTimeline)
    ? source.payoutTimeline
    : [];
  const ordered = legendaryPayoutTimelineBoundaries(source, start, end, timeline);
  let total = 0;
  for (let index = 0; index < ordered.length - 1; index++) {
    const segmentStart = ordered[index];
    total +=
      legendaryPayoutTimelineValue(
        source,
        key,
        segmentStart,
        timeline,
        fallbackRates,
      ) *
      (ordered[index + 1] - segmentStart);
  }
  return total;
}

function legendaryEconomyNetGold(
  type,
  { cost = 0, horizonTicks = 0, inputs, config } = {},
) {
  const costNumber = Number(cost);
  const horizon = Number(horizonTicks);
  const live = inputs && typeof inputs === "object";
  if (!live || !Number.isFinite(costNumber) || costNumber <= 0) return null;
  if (!Number.isFinite(horizon) || horizon <= 0) return { refused: true };
  // Construction delay comes from live unit info (instant build reads as 0);
  // the candidate earns nothing until the structure completes.
  const unitInfo = config?.unitInfo?.(type);
  if (inputs.upgradeAction !== true && !Number.isFinite(Number(unitInfo?.constructionDuration))) {
    return null;
  }
  const constructionDelayTicks = inputs.upgradeAction === true
    ? 0
    : Math.max(0, Math.floor(Number(unitInfo.constructionDuration)));
  const portHasRouteProfiles =
    type === "Port" &&
    (Array.isArray(inputs.portRoutes) && inputs.portRoutes.length > 0 ||
      (Array.isArray(inputs.portUpgradeProfile?.routes) &&
        inputs.portUpgradeProfile.routes.length > 0) ||
      Object.values(inputs.portUpgradeProfiles ?? {}).some(
        (profile) => Array.isArray(profile?.routes) && profile.routes.length > 0,
      ));
  const routeDelayTicks = Math.max(
    0,
    Number(type === "Port"
      ? portHasRouteProfiles ? 0 : inputs.portRouteDelayTicks
      : inputs.routeDelayTicks) || 0,
  );
  if (
    type === "Port" &&
    inputs.hasCompletedTradePartner !== true
  ) {
    if (
      inputs.portSeedWindowOpen !== true &&
      !(inputs.hasPendingTradePartner === true && portHasRouteProfiles)
    ) {
      return { refused: true };
    }
    // DIVERGENCE: seed-pair ROI starts only after both selected Ports complete.
  }
  const productiveTicks = type === "Port"
    ? horizon
    : Math.max(
        0,
        horizon - constructionDelayTicks - routeDelayTicks,
      );
  if (productiveTicks <= 0) return { refused: true };

  let incomePerTick;
  let portPlacementTile;
  let factoryPlacementTile;
  if (type === "Factory" || type === "City") {
    if (typeof config?.trainSpawnRate !== "function") return null;
    const trainCount = Math.max(0, Math.floor(Number(inputs.trainCount ?? 0)));
    const sources = Array.isArray(inputs.trainSources) ? inputs.trainSources : [];
    const actionReadyTicks = constructionDelayTicks + routeDelayTicks;
      if (type === "Factory") {
      const destinations = Math.max(
        0,
        Math.floor(Number(inputs.factoryPaidStops ?? 0)),
      );
      const goldPerTrain = Math.max(
        0,
        Number(inputs.factoryTeamGoldPerTrain ?? 0),
      );
      if (destinations <= 0) return { refused: true };
      if (goldPerTrain <= 0) return null;
      const ownerFactoryCount = Math.max(
        0,
        Math.floor(Number(inputs.ownFactoryCount ?? 0)),
      );
      const productiveLevels = Array.isArray(inputs.ownProductiveFactoryLevels)
        ? inputs.ownProductiveFactoryLevels
        : [];
      const ownPendingLevels = Array.isArray(inputs.ownPendingFactoryLevels)
        ? inputs.ownPendingFactoryLevels
        : [];
      const factoryGoldForTicks = (cluster, productionDelta, startAt = 0) => {
        const start = Math.max(0, Number(startAt) || 0);
        const stopsReady = Math.max(
          0,
          Number(cluster.pendingStopDelayTicks ?? 0) || 0,
        );
        const before = Math.max(0, Number(cluster.teamGoldPerSpawn ?? goldPerTrain) || 0);
        const beforePost = Math.max(
          0,
          Number(cluster.postTeamGoldPerSpawn ?? before) || 0,
        );
        const after = Math.max(
          0,
          Number(cluster.teamGoldAfterPendingPerSpawn ?? before) || 0,
        );
        const afterPost = Math.max(
          0,
          Number(
            cluster.postTeamGoldAfterPendingPerSpawn ??
              cluster.postTeamGoldPerSpawn ??
              after,
          ) || 0,
        );
        const beforeStopGold = legendaryIntegratePayoutTimeline(
          cluster,
          "teamGoldPerSpawn",
          start,
          Math.min(horizon, stopsReady),
          { current: before, post: beforePost },
        );
        const afterStopGold = legendaryIntegratePayoutTimeline(
          cluster,
          "teamGoldAfterPendingPerSpawn",
          Math.max(start, stopsReady),
          horizon,
          { current: after, post: afterPost },
        );
        return productionDelta * (beforeStopGold + afterStopGold);
      };
      const denominatorFor = (factoryCount) =>
        Math.max(1, Number(config.trainSpawnRate(factoryCount, trainCount)) || 1);
      const upgrade = inputs.upgradeAction === true ? inputs.factoryUpgrade : null;
      // The engine reads the owner's global Factory count for every spawn
      // roll, so a build/upgrade also slows productive Factories in other
      // rail clusters. Score every cluster's rate change with its own route
      // payout instead of only the target cluster.
      const ownerClusters = Array.isArray(inputs.ownerFactoryClusters) &&
          inputs.ownerFactoryClusters.length > 0
        ? inputs.ownerFactoryClusters
        : [{
          productiveFactoryLevels: upgrade
            ? upgrade.productiveFactoryLevels
            : productiveLevels,
          pendingFactoryLevels: upgrade
            ? upgrade.pendingFactoryLevels
            : ownPendingLevels,
          teamGoldPerSpawn: upgrade ? upgrade.teamGoldPerTrain : goldPerTrain,
          postTeamGoldPerSpawn: upgrade
            ? upgrade.teamGoldPerTrain
            : goldPerTrain,
          teamGoldAfterPendingPerSpawn:
            upgrade?.teamGoldAfterPendingPerTrain ??
              (upgrade ? upgrade.teamGoldPerTrain : goldPerTrain),
          postTeamGoldAfterPendingPerSpawn:
            upgrade?.postTeamGoldAfterPendingPerTrain ??
              (upgrade ? upgrade.teamGoldPerTrain : goldPerTrain),
          factoryConstructionDelayTicks:
            upgrade?.factoryConstructionDelayTicks ??
              inputs.ownPendingFactoryDelayTicks ??
              0,
          pendingStopDelayTicks: upgrade?.pendingStopDelayTicks ?? 0,
          eligibleTicks: Infinity,
          isTarget: true,
        }];
      const beforeDenominator = denominatorFor(ownerFactoryCount);
      const afterDenominator = denominatorFor(ownerFactoryCount + 1);
      if (upgrade) {
        const levels = Array.isArray(upgrade.productiveFactoryLevels)
          ? upgrade.productiveFactoryLevels
          : [];
        const pendingLevels = Array.isArray(upgrade.pendingFactoryLevels)
          ? upgrade.pendingFactoryLevels
          : ownPendingLevels;
        const targetIndex = Math.floor(Number(upgrade.upgradeFactoryIndex));
        if (targetIndex < 0 || targetIndex >= levels.length) return { refused: true };
        const upgradeReadyTicks = actionReadyTicks;
        const targetCluster = upgrade.clusterId === undefined
          ? ownerClusters.find((cluster) => cluster.isTarget) ?? ownerClusters[0]
          : ownerClusters.find(
              (cluster) => String(cluster.clusterId) === String(upgrade.clusterId),
            );
        if (!targetCluster) return { refused: true };
        incomePerTick = ownerClusters.reduce((total, cluster) => {
          const isTarget = cluster === targetCluster;
          const clusterLevels = isTarget
            ? levels
            : Array.isArray(cluster.productiveFactoryLevels)
              ? cluster.productiveFactoryLevels
              : [];
          const clusterPending = isTarget
            ? pendingLevels
            : Array.isArray(cluster.pendingFactoryLevels)
              ? cluster.pendingFactoryLevels
              : [];
          const completedDelta = clusterLevels.reduce(
            (sum, level, index) =>
              sum + legendaryExpectedTrainRatePerTick(
                level + (isTarget && index === targetIndex ? 1 : 0),
                afterDenominator,
              ) - legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const pendingDelta = clusterPending.reduce(
            (sum, level) =>
              sum + legendaryExpectedTrainRatePerTick(level, afterDenominator) -
                legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const rollGold = isTarget
            ? legendaryExpectedTrainRatePerTick(
                Number(levels[targetIndex] ?? 1) + 1,
                afterDenominator,
              ) -
                legendaryExpectedTrainRatePerTick(
                  Number(levels[targetIndex] ?? 1),
                  afterDenominator,
                )
            : 0;
          const pendingStart = Math.max(
            0,
            Number(
              cluster.factoryConstructionDelayTicks ??
                inputs.ownPendingFactoryDelayTicks ??
                0,
            ) || 0,
          );
          return total +
            factoryGoldForTicks(cluster, completedDelta - rollGold) +
            factoryGoldForTicks(cluster, rollGold, upgradeReadyTicks) +
            factoryGoldForTicks(cluster, pendingDelta, pendingStart);
        }, 0) / productiveTicks;
      } else {
        const newFactoryRate = legendaryExpectedTrainRatePerTick(1, afterDenominator);
        const existingFactoryGold = ownerClusters.reduce((total, cluster) => {
          const clusterLevels = Array.isArray(cluster.productiveFactoryLevels)
            ? cluster.productiveFactoryLevels
            : [];
          const clusterPending = Array.isArray(cluster.pendingFactoryLevels)
            ? cluster.pendingFactoryLevels
            : [];
          const completedDelta = clusterLevels.reduce(
            (sum, level) =>
              sum + legendaryExpectedTrainRatePerTick(level, afterDenominator) -
                legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const pendingDelta = clusterPending.reduce(
            (sum, level) =>
              sum + legendaryExpectedTrainRatePerTick(level, afterDenominator) -
                legendaryExpectedTrainRatePerTick(level, beforeDenominator),
            0,
          );
          const pendingStart = Math.max(
            0,
            Number(
              cluster.factoryConstructionDelayTicks ??
                inputs.ownPendingFactoryDelayTicks ??
                0,
            ) || 0,
          );
          return total +
            factoryGoldForTicks(cluster, completedDelta) +
            factoryGoldForTicks(cluster, pendingDelta, pendingStart);
        }, 0);
        const factoryRouteProfiles = Array.isArray(inputs.factoryRouteProfiles)
          ? inputs.factoryRouteProfiles
          : [];
        let newFactoryGold;
        if (factoryRouteProfiles.length > 0) {
          let selectedRoute = null;
          for (const profile of factoryRouteProfiles) {
            const routeGold = factoryGoldForTicks(
              profile,
              newFactoryRate,
              actionReadyTicks,
            );
            if (selectedRoute === null || routeGold > selectedRoute.gold) {
              selectedRoute = { profile, gold: routeGold };
            }
          }
          newFactoryGold = selectedRoute?.gold ?? 0;
          factoryPlacementTile = selectedRoute?.profile?.placementTile;
        } else {
          newFactoryGold = newFactoryRate * goldPerTrain * productiveTicks;
        }
        incomePerTick = (existingFactoryGold + newFactoryGold) / productiveTicks;
      }
      } else {
      if (sources.length === 0) return { refused: true };
        // TrainStationExecution samples the destination uniformly from the
        // cluster's tradeable stops, so a City's marginal value is the change
        // in total team payout (new share minus displaced shares), not the
        // new stop's share alone.
        incomePerTick = sources.reduce((total, source) => {
        const levels = Array.isArray(source.productiveFactoryLevels)
          ? source.productiveFactoryLevels
          : [];
        const pendingLevels = Array.isArray(source.pendingFactoryLevels)
          ? source.pendingFactoryLevels
          : [];
        const factoryCount = Math.max(
          0,
          Math.floor(Number(source.factoryCount ?? 0)),
        );
        const denominator = Math.max(
          1,
          Number(config.trainSpawnRate(factoryCount, trainCount)) || 1,
        );
        const stopShare = (value) => {
          const destinations = Math.max(
            1,
            Math.floor(Number(source.paidStopsAfterBuild ?? 1)),
          );
          return Math.max(0, Number(value) || 0) * (destinations - 1) / destinations;
        };
        const beforePerSpawn = source.beforeTeamGoldPerSpawn === undefined
          ? stopShare(source.teamGoldPerStop)
          : Math.max(0, Number(source.beforeTeamGoldPerSpawn) || 0);
        const afterPerSpawn = Math.max(
          0,
          Number(source.teamGoldPerStop ?? 0),
        );
        const beforePostPerSpawn = source.beforePostAllianceTeamGoldPerSpawn === undefined
          ? stopShare(
              source.postAllianceTeamGoldPerStop ?? source.teamGoldPerStop ?? 0,
            )
          : Math.max(0, Number(source.beforePostAllianceTeamGoldPerSpawn) || 0);
        const afterPostPerSpawn = Math.max(
          0,
          Number(
            source.postAllianceTeamGoldPerStop ?? source.teamGoldPerStop ?? 0,
          ),
        );
        const beforeAfterPending = Math.max(
          0,
          Number(source.beforeTeamGoldAfterPendingPerSpawn ?? beforePerSpawn) || 0,
        );
        const afterAfterPending = Math.max(
          0,
          Number(source.teamGoldAfterPendingPerSpawn ?? afterPerSpawn) || 0,
        );
        const beforePostAfterPending = Math.max(
          0,
          Number(
            source.beforePostAllianceTeamGoldAfterPendingPerSpawn ?? beforePostPerSpawn,
          ) || 0,
        );
        const afterPostAfterPending = Math.max(
          0,
          Number(
            source.postAllianceTeamGoldAfterPendingPerSpawn ?? afterPostPerSpawn,
          ) || 0,
        );
        const pendingStopsReadyTicks = Math.max(
          0,
          Number(source.pendingStopDelayTicks ?? 0),
        );
        const completedProduction = levels.reduce(
          (sum, level) =>
            sum + legendaryExpectedTrainRatePerTick(level, denominator),
          0,
        );
        const pendingProduction = pendingLevels.reduce(
          (sum, level) =>
            sum + legendaryExpectedTrainRatePerTick(level, denominator),
          0,
        );
        const goldFrom = (production, readyAt) => {
          const candidateReady = Math.max(readyAt, actionReadyTicks);
          const pendingReady = Math.max(readyAt, pendingStopsReadyTicks);
          const integrateDelta = (keys, start, end, afterRates, beforeRates) =>
            legendaryIntegratePayoutTimeline(
              source,
              keys.after,
              start,
              end,
              afterRates,
            ) - legendaryIntegratePayoutTimeline(
              source,
              keys.before,
              start,
              end,
              beforeRates,
            );
          const beforePendingStops = integrateDelta(
            { after: "teamGoldPerStop", before: "beforeTeamGoldPerSpawn" },
            candidateReady,
            Math.min(horizon, pendingReady),
            { current: afterPerSpawn, post: afterPostPerSpawn },
            { current: beforePerSpawn, post: beforePostPerSpawn },
          );
          const afterPendingStops = integrateDelta(
            {
              after: "teamGoldAfterPendingPerSpawn",
              before: "beforeTeamGoldAfterPendingPerSpawn",
            },
            Math.max(candidateReady, pendingReady),
            horizon,
            { current: afterAfterPending, post: afterPostAfterPending },
            { current: beforeAfterPending, post: beforePostAfterPending },
          );
          return production * (beforePendingStops + afterPendingStops);
        };
        const sourceReadyTicks = Math.max(
          actionReadyTicks,
          Math.max(0, Number(source.factoryConstructionDelayTicks ?? 0)),
        );
        return total +
          goldFrom(completedProduction, actionReadyTicks) +
          goldFrom(pendingProduction, sourceReadyTicks);
      }, 0);
      incomePerTick /= productiveTicks;
    }
  } else if (type === "Port") {
    if (typeof config?.tradeShipSpawnRate !== "function") return null;
    if (
      inputs.hasCompletedTradePartner !== true &&
      inputs.portSeedWindowOpen !== true &&
      !(inputs.hasPendingTradePartner === true && portHasRouteProfiles)
    ) {
      // A first Port without any tradeable partner Port on the shared water
      // is a seed, not current trade income; the two-owner seed window is the
      // only no-route exception.
      return { refused: true };
    }
    const tradeShipCount = Math.max(
      0,
      Math.floor(Number(inputs.tradeShipCount ?? 0)),
    );
    const routeIncome = (
      profile,
      level,
      upgrade = false,
      startDelayTicks = constructionDelayTicks,
    ) => legendaryPortExpectedGold(profile, {
      level,
      upgrade,
      tradeShipCount,
      config,
      fallbackDistance: inputs.portRouteDelayTicks ?? 0,
      startDelayTicks,
      horizon,
    });
    const incomingRouteIncome = (profile) =>
      (profile?.inboundSources ?? []).reduce((total, source) => {
        // A completed source Port already dispatches to a destination that is
        // still under construction (PortExecution.tradingPorts does not check
        // construction), so inbound value starts at the source's own delay.
        const sourceDelay = Math.max(
          0,
          Math.floor(Number(source.constructionDelayTicks) || 0),
        );
        const level = Math.max(1, Math.floor(Number(source.level) || 1));
        return total +
          routeIncome(source.afterProfile, level, false, sourceDelay) -
          routeIncome(source.beforeProfile, level, false, sourceDelay);
      }, 0);
    const candidatePortIncome = (profile) =>
      routeIncome(profile, 1) + incomingRouteIncome(profile);
    const selectPortCandidate = (profiles) => {
      let profile = null;
      let gold = -Infinity;
      for (const candidate of profiles) {
        const candidateGold = candidatePortIncome(candidate);
        if (profile === null || candidateGold > gold) {
          profile = candidate;
          gold = candidateGold;
        }
      }
      return { profile, gold };
    };
    let totalTeamGold = 0;
    if (inputs.upgradeAction === true) {
      const portUpgradeProfiles = inputs.portUpgradeProfiles ?? {};
      const profile =
        inputs.portUpgradeProfile ??
          portUpgradeProfiles[String(inputs.upgradeStructureId ?? "")] ??
          inputs;
      totalTeamGold = routeIncome(
        profile,
        Math.max(1, Math.floor(Number(inputs.portUpgradeLevel ?? 1))),
        true,
      ) + incomingRouteIncome(profile);
    } else if (inputs.hasCompletedTradePartner === true) {
      const candidateProfiles = inputs.portCandidateProfiles ?? [];
      if (candidateProfiles.length > 0) {
        const selected = selectPortCandidate(candidateProfiles);
        totalTeamGold = selected.gold;
        portPlacementTile = selected.profile?.placementTile;
      } else {
        totalTeamGold = candidatePortIncome(inputs);
      }
    } else {
      const seedSources = Array.isArray(inputs.portSeedSources)
        ? inputs.portSeedSources
        : [];
      if (seedSources.length > 0) {
        portPlacementTile = seedSources.find(
          (source) => source.portSeedStream === "own",
        )?.placementTile;
        // With no committed partner Port on the shared water,
        // PortExecution.tradingPorts() is empty: our port spawns no ships and
        // the candidate can only survive as a marked strategic seed. Once a
        // partner commits, neither stream pays until the slower Port completes.
        if (inputs.portSeedPartnerCommitted === true) {
          const pairReadyTicks = Math.max(
            constructionDelayTicks,
            ...seedSources.map((source) =>
              Math.max(
                0,
                Number(source.constructionDelayTicks ?? constructionDelayTicks) || 0,
              ),
            ),
          );
          totalTeamGold = seedSources.reduce(
            (total, source) => total + routeIncome(
              source,
              Math.max(1, Math.floor(Number(source.level) || 1)),
              false,
              pairReadyTicks,
            ),
            0,
          );
        }
      } else if (inputs.hasPendingTradePartner === true) {
        const candidateProfiles = inputs.portCandidateProfiles ?? [];
        if (candidateProfiles.length > 0) {
          const selected = selectPortCandidate(candidateProfiles);
          totalTeamGold = selected.gold;
          portPlacementTile = selected.profile?.placementTile;
        } else {
          totalTeamGold = candidatePortIncome(inputs);
        }
      } else {
        return { refused: true };
      }
    }
    if (totalTeamGold <= 0) {
      return type === "Port" &&
          inputs.portSeedWindowOpen === true &&
          inputs.portSeedPartnerCommitted !== true
        ? null
        : { refused: true };
    }
    incomePerTick = totalTeamGold / productiveTicks;
  } else {
    return null;
  }

  const eligibleTicks = productiveTicks;
  const teamGold = incomePerTick * eligibleTicks;
  return {
    netTeamGold: teamGold - costNumber,
    paybackTicks:
      incomePerTick > 0 ? costNumber / incomePerTick : Infinity,
    incomePerTick,
    productiveTicks: eligibleTicks,
    ...(factoryPlacementTile === undefined
      ? {}
      : { factoryPlacementTile }),
    ...(portPlacementTile === undefined ? {} : { portPlacementTile }),
  };
}

// Conservative upper-bound threat model used as a construction safety gate.
// It intentionally models what an opponent can do now, not what they are
// statistically likely to do: silo levels, enough gold for Atom/Hydrogen,
// remaining flight time, and the value clustered inside the blast area all
// contribute. A SAM interception capacity reduces, but never erases, risk.
function legendaryMissileWeapon(context, enemyGold) {
  const atomCost = legendaryBigInt(context.atomCost ?? 0n);
  const hydrogenCost = legendaryBigInt(context.hydrogenCost ?? 0n);
  if (hydrogenCost > 0n && enemyGold >= hydrogenCost) return "HydrogenBomb";
  if (atomCost > 0n && enemyGold >= atomCost) return "AtomBomb";
  return null;
}

function legendaryMissileExposure(context, weapon) {
  if (context.vulnerableExposure !== undefined) {
    return legendaryClamp(context.vulnerableExposure, 0, 1);
  }
  const blastValue = weapon === "HydrogenBomb"
    ? context.hydrogenBlastArea ?? context.hydrogenRadius
    : context.atomBlastArea ?? context.atomRadius;
  const blastArea = Math.max(1, legendaryScoreValue(blastValue));
  const vulnerableBlastArea = Math.max(0, legendaryScoreValue(context.vulnerableBlastArea));
  const vulnerableStructures = Math.max(0, legendaryScoreValue(context.vulnerableStructures));
  return Math.min(1, (vulnerableBlastArea + vulnerableStructures) / blastArea);
}

function emptyLegendaryMissileThreat(siloCapacity) {
  return {
    score: 0,
    critical: false,
    weapon: null,
    siloCapacity,
    flightUrgency: 0,
    exposure: 0,
  };
}

function legendaryMissileThreatScore(context = {}) {
  const silos = Array.isArray(context.enemySilos) ? context.enemySilos : [];
  const siloCapacity = silos.reduce(
    (total, silo) => total + Math.max(0, legendaryScoreValue(silo.level ?? silo)),
    0,
  );
  const enemyGold = legendaryBigInt(context.enemyGold ?? 0n);
  const weapon = legendaryMissileWeapon(context, enemyGold);
  if (siloCapacity <= 0 || weapon === null) return emptyLegendaryMissileThreat(siloCapacity);
  const exposure = legendaryMissileExposure(context, weapon);
  const flightTimeTicks = Math.max(
    0,
    legendaryScoreValue(context.flightTimeTicks),
  );
  const flightUrgency = 1 / (1 + flightTimeTicks);
  const interceptionCapacity = Math.max(
    0,
    legendaryScoreValue(context.interceptionCapacity),
  );
  const survivableSalvo = Math.max(0, siloCapacity - interceptionCapacity);
  const interceptionFactor = Math.max(
    0.25,
    (survivableSalvo + 1) / (siloCapacity + 1),
  );
  const weaponFactor = weapon === "HydrogenBomb" ? 1.5 : 1;
  const readyShots = Math.min(
    siloCapacity,
    Math.max(0, legendaryScoreValue(context.readyShots ?? siloCapacity)),
  );
  const readinessFactor =
    0.5 + 0.5 * (readyShots / Math.max(1, siloCapacity));
  const salvoRisk = context.salvoRisk ?? null;
  const salvoFactor = salvoRisk
    ? 1 + 0.75 * legendaryClamp(salvoRisk.risk, 0, 1)
    : 1;
  const score =
    siloCapacity *
    weaponFactor *
    (1 + exposure) *
    flightUrgency *
    interceptionFactor *
    readinessFactor *
    salvoFactor;
  const criticalThreshold = Math.max(
    0,
    legendaryScoreValue(context.criticalThreshold ?? 0.75),
  );

  return {
    score,
    critical: score >= criticalThreshold || Boolean(salvoRisk?.critical),
    weapon,
    siloCapacity,
    flightUrgency,
    exposure,
    interceptionFactor,
    readyShots,
    salvoRisk,
  };
}

// Simulates the short chained-salvo window that experienced opponents use:
// cheap atoms consume the SAM interception slots, then a hydrogen bomb arrives
// before the SAM cooldown can restore them. `marginTicks` is both the minimum
// time-to-impact safety margin and the minimum separation we accept between the
// atom chain and the hydrogen finisher.
function legendaryRouteMissileSalvoRisk(options) {
    const schedule = options.scheduleOverride || legendaryMissileDefenseSchedule({
      routes: options.routes,
      samProfiles: options.samProfiles,
      samCooldownTicks: options.samCooldownTicks,
      marginTicks: options.marginTicks,
      completionTick: options.completionTick,
    });
    const atomResults = schedule.missiles.filter(
      (missile) => legendaryWeaponKey(missile.weapon) === "atombomb",
    );
    const hydrogenResult = schedule.missiles.find(
      (missile) => legendaryWeaponKey(missile.weapon) === "hydrogenbomb",
    );
    const atomGetsThrough = atomResults.filter(
      (missile) => !missile.intercepted,
    ).length;
    const hydrogenGetsThrough = Boolean(
      hydrogenResult && !hydrogenResult.intercepted,
    );
    const marginSatisfied = schedule.completionMarginTicks >= options.marginTicks;
    let risk = 0;
    if (!schedule.fullyDefended) risk = 1;
    else if (!marginSatisfied) risk = 0.75;
    else if (schedule.minimumInterceptMarginTicks < 1) risk = 0.5;
    const lastAtomArrival =
      options.atomArrivalTicks.length > 0
        ? options.atomArrivalTicks[options.atomArrivalTicks.length - 1]
        : 0;
    return {
      ...schedule,
      risk,
      // Completion margin is a gate for a *new action*, not evidence that an
      // already-complete current SAM network is failing. Keep those concepts
      // separate so a fully defended target does not trigger a redundant SAM.
      critical: !schedule.fullyDefended,
      hydrogenGetsThrough,
      hydrogenIntercepted: Boolean(
        hydrogenResult && hydrogenResult.intercepted,
      ),
      atomIntercepted: atomResults.filter((missile) => missile.intercepted)
        .length,
      atomGetsThrough,
      chainSeparation:
        options.hydrogenArrivalTick == null
          ? Infinity
          : options.hydrogenArrivalTick - lastAtomArrival,
      marginSatisfied,
      timeToImpactTicks: schedule.firstImpactTick,
    };
}

function legendaryAggregateMissileSalvoRisk({
  atomArrivalTicks,
  hydrogenArrivalTick,
  interceptionCapacity,
  samCooldownTicks,
  marginTicks,
}) {
  const atoms = atomArrivalTicks
    .map((tick) => legendaryScoreValue(tick))
    .filter((tick) => Number.isFinite(tick) && tick >= 0)
    .sort((a, b) => a - b);
  const capacity = Math.max(0, Math.floor(legendaryScoreValue(interceptionCapacity)));
  const cooldown = Math.max(1, legendaryScoreValue(samCooldownTicks));
  const margin = Math.max(1, legendaryScoreValue(marginTicks));
  const atomState = simulateLegendaryAtomSalvo(atoms, capacity, cooldown);
  const hydrogenArrival = hydrogenArrivalTick == null
    ? null
    : legendaryScoreValue(hydrogenArrivalTick);
  const hydrogenIntercepted = legendaryHydrogenIntercepted(
    hydrogenArrival,
    atomState,
    capacity,
    cooldown,
  );
  const lastAtomArrival = atoms.length > 0 ? atoms[atoms.length - 1] : 0;
  const chainSeparation = hydrogenArrival === null ? Infinity : hydrogenArrival - lastAtomArrival;
  const marginSatisfied =
    hydrogenArrival === null ||
    (hydrogenArrival >= margin && chainSeparation >= margin);
  const hydrogenGetsThrough = hydrogenArrival !== null && !hydrogenIntercepted;
  let risk = 0;
  if (hydrogenGetsThrough) risk = 1;
  else if (atomState.getsThrough > 0) risk = 0.5;
  else if (!marginSatisfied) risk = 0.75;
  return {
    risk,
    critical: hydrogenGetsThrough || !marginSatisfied,
    hydrogenGetsThrough,
    hydrogenIntercepted,
    atomIntercepted: atomState.intercepted,
    atomGetsThrough: atomState.getsThrough,
    chainSeparation,
    marginSatisfied,
    timeToImpactTicks: hydrogenArrival ?? atoms[0] ?? Infinity,
  };
}

function simulateLegendaryAtomSalvo(atoms, capacity, cooldown) {
  let slotsUsed = 0;
  let lastInterceptTick = null;
  let intercepted = 0;
  let getsThrough = 0;
  for (const arrivalTick of atoms) {
    if (
      lastInterceptTick !== null &&
      arrivalTick - lastInterceptTick >= cooldown
    ) {
      slotsUsed = 0;
    }
    if (slotsUsed < capacity) {
      slotsUsed++;
      intercepted++;
      lastInterceptTick = arrivalTick;
    } else {
      getsThrough++;
    }
  }
  return { slotsUsed, lastInterceptTick, intercepted, getsThrough };
}

function legendaryHydrogenIntercepted(arrival, atomState, capacity, cooldown) {
  if (arrival === null) return false;
  const reloaded =
    atomState.lastInterceptTick !== null &&
    arrival - atomState.lastInterceptTick >= cooldown;
  return (reloaded ? 0 : atomState.slotsUsed) < capacity;
}

function legendaryMissileSalvoRisk(options = {}) {
  const normalized = {
    atomArrivalTicks: options.atomArrivalTicks ?? [],
    hydrogenArrivalTick: options.hydrogenArrivalTick ?? null,
    interceptionCapacity: options.interceptionCapacity ?? 0,
    samCooldownTicks: options.samCooldownTicks ?? 90,
    marginTicks: options.marginTicks ?? 5,
    routes: options.routes ?? null,
    samProfiles: options.samProfiles ?? [],
    completionTick: options.completionTick ?? 0,
    scheduleOverride: options.scheduleOverride ?? null,
  };
  return Array.isArray(normalized.routes)
    ? legendaryRouteMissileSalvoRisk(normalized)
    : legendaryAggregateMissileSalvoRisk(normalized);
}

// Defensive scheduling primitive for Legendary. Each route is an
// incoming missile and each `samOption` lists the trajectory ticks at which a
// particular SAM can fire. The option ticks are absolute relative to the
// current bot tick, so a SAM that finishes construction at tick 300 cannot be
// assigned a trajectory opportunity at tick 80.
//
// The 5-tick constant is deliberately applied to `completionMarginTicks`:
// `firstImpactTick - actionCompletionTick`. It is not a vague urgency bonus and
// it is not incorrectly added to every interception. A new SAM is therefore a
// valid emergency investment only when it completes at least five ticks before
// the first landing AND the individual ready/reloading slots can stop every
// missile. Existing SAMs and instant upgrades use actionCompletionTick = 0.
function normalizeLegendarySamProfiles(samProfiles, cooldown) {
  return (Array.isArray(samProfiles) ? samProfiles : []).map((profile, index) => {
    const rawAvailability = Array.isArray(profile?.availableTicks)
      ? profile.availableTicks
      : Array(Math.max(0, Math.floor(legendaryScoreValue(profile?.readyShots)))).fill(0);
    return {
      id: profile?.id ?? index,
      availableTicks: rawAvailability
        .map(Number)
        .filter((tick) => Number.isFinite(tick) && tick >= 0)
        .sort((a, b) => a - b),
      cooldownTicks: Math.max(1, legendaryScoreValue(profile?.cooldownTicks ?? cooldown)),
      fireIntervalTicks: Math.max(0, legendaryScoreValue(profile?.fireIntervalTicks ?? 0)),
    };
  });
}

function normalizeLegendarySamOption(option, impactTick, profileCount) {
  const samIndex = Math.floor(Number(option?.samIndex));
  if (!Number.isFinite(samIndex) || samIndex < 0 || samIndex >= profileCount) return null;
  const rawTicks = Array.isArray(option?.interceptTicks)
    ? option.interceptTicks
    : [option?.interceptTick];
  const rawInterceptionTicks = Array.isArray(option?.interceptionTicks)
    ? option.interceptionTicks
    : rawTicks;
  const opportunities = rawTicks
    .map((tick, index) => ({
      fireTick: legendaryScoreValue(tick),
      interceptTick: legendaryScoreValue(rawInterceptionTicks[index] ?? tick),
    }))
    .filter(
      ({ fireTick, interceptTick }) =>
        Number.isFinite(fireTick) &&
        fireTick >= 0 &&
        Number.isFinite(interceptTick) &&
        interceptTick >= fireTick &&
        interceptTick < impactTick,
    )
    .sort(
      (left, right) =>
        left.fireTick - right.fireTick || left.interceptTick - right.interceptTick,
    );
  return opportunities.length
    ? {
        samIndex,
        interceptTicks: opportunities.map(({ fireTick }) => fireTick),
        interceptionTicks: opportunities.map(({ interceptTick }) => interceptTick),
        claimScore: Number.isFinite(Number(option?.claimScore))
          ? Number(option.claimScore)
          : null,
      }
    : null;
}

function normalizeLegendaryMissileRoute(route, routeIndex, profileCount) {
  const impactTick = Number(route?.impactTick);
  if (!Number.isFinite(impactTick) || impactTick < 0) return null;
  let rawOptions = route?.samOptions;
  if (!Array.isArray(rawOptions)) {
    const candidates = Array.isArray(route?.samCandidates) ? route.samCandidates : [];
    const defaultTick = Number.isFinite(Number(route?.interceptTick))
      ? Number(route.interceptTick)
      : Math.max(0, impactTick);
    rawOptions = candidates.map((samIndex) => ({ samIndex, interceptTicks: [defaultTick] }));
  }
  return {
    ...route,
    id: route?.id ?? routeIndex,
    impactTick,
    samOptions: rawOptions
      .map((option) => normalizeLegendarySamOption(option, impactTick, profileCount))
      .filter(Boolean),
  };
}

function normalizeLegendaryMissileRoutes(routes, profileCount) {
  return (Array.isArray(routes) ? routes : [])
    .map((route, index) => normalizeLegendaryMissileRoute(route, index, profileCount))
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.impactTick - right.impactTick ||
        left.samOptions.length - right.samOptions.length ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function buildLegendaryFutureSamUse(routes, profileCount) {
  const futureUseByRoute = routes.map(() => Array(profileCount).fill(0));
  const counts = Array(profileCount).fill(0);
  for (let index = routes.length - 1; index >= 0; index--) {
    futureUseByRoute[index] = counts.slice();
    const used = new Set(routes[index].samOptions.map((option) => option.samIndex));
    for (const samIndex of used) counts[samIndex]++;
  }
  return futureUseByRoute;
}

function firstLegendaryInterceptOpportunity(option, minimumTick, maximumTick) {
  const interceptTicks = option.interceptTicks;
  let low = 0;
  let high = interceptTicks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (interceptTicks[middle] < minimumTick) low = middle + 1;
    else high = middle;
  }
  const fireTick = interceptTicks[low];
  if (fireTick === undefined || fireTick > maximumTick) return undefined;
  return {
    fireTick,
    interceptTick: option.interceptionTicks[low] ?? fireTick,
  };
}

function collectLegendaryFeasibleAssignments(context, routeIndex, slots, fireTicks) {
  const route = context.routes[routeIndex];
  const feasible = [];
  const equivalentAssignments = new Set();
  for (const option of route.samOptions) {
    const profile = context.profiles[option.samIndex];
    for (let slotIndex = 0; slotIndex < slots[option.samIndex].length; slotIndex++) {
      const availableAt = slots[option.samIndex][slotIndex];
      const launcherAvailableAt = Math.max(availableAt, fireTicks[option.samIndex] ?? 0);
      const opportunity = firstLegendaryInterceptOpportunity(
        option,
        launcherAvailableAt,
        route.impactTick,
      );
      if (opportunity === undefined) continue;
      // Slots with the same availability produce the same next state. Keep
      // one representative so a levelled SAM with several ready slots does
      // not make exact search revisit equivalent branches.
      const equivalentKey = `${option.samIndex}|${availableAt}|${opportunity.fireTick}`;
      if (equivalentAssignments.has(equivalentKey)) continue;
      equivalentAssignments.add(equivalentKey);
      feasible.push({
        samIndex: option.samIndex,
        slotIndex,
        availableAt,
        fireTick: opportunity.fireTick,
        interceptTick: opportunity.interceptTick,
        futureUse: context.futureUse[routeIndex][option.samIndex] ?? 0,
        cooldownTicks: profile.cooldownTicks,
        fireIntervalTicks: profile.fireIntervalTicks,
        claimScore: option.claimScore,
      });
    }
  }
  return feasible.sort(
    (left, right) =>
      left.futureUse - right.futureUse ||
      left.fireTick - right.fireTick ||
      left.interceptTick - right.interceptTick ||
      left.availableAt - right.availableAt ||
      left.samIndex - right.samIndex ||
      left.slotIndex - right.slotIndex,
  );
}

function applyLegendarySamAssignment(slots, fireTicks, assignment) {
  slots[assignment.samIndex][assignment.slotIndex] =
    assignment.fireTick + assignment.cooldownTicks;
  slots[assignment.samIndex].sort((left, right) => left - right);
  fireTicks[assignment.samIndex] = assignment.fireTick + assignment.fireIntervalTicks;
}

function legendaryScheduledMissile(route, assignment) {
  if (!assignment) {
    return { ...route, intercepted: false, interceptTick: null, marginTicks: 0, samIndex: null };
  }
  return {
    ...route,
    intercepted: true,
    interceptTick: assignment.interceptTick,
    samFireTick: assignment.fireTick,
    marginTicks: Math.max(0, route.impactTick - assignment.interceptTick),
    samIndex: assignment.samIndex,
    claimScore: assignment.claimScore,
  };
}

function runLegendaryGreedySchedule(context) {
  const slots = context.profiles.map((profile) => profile.availableTicks.slice());
  const fireTicks = context.profiles.map(() => 0);
  return context.routes.map((route, index) => {
    const assignment = collectLegendaryFeasibleAssignments(context, index, slots, fireTicks)[0];
    if (assignment) applyLegendarySamAssignment(slots, fireTicks, assignment);
    return legendaryScheduledMissile(route, assignment);
  });
}

function legendaryScheduleStateKey(routeIndex, slots, fireTicks) {
  return `${routeIndex}|${slots
    .map((profileSlots) => profileSlots.join(","))
    .join(";")}|${fireTicks.join(",")}`;
}

function searchLegendaryExactSchedule(state, routeIndex, slots, fireTicks) {
  state.nodes++;
  if (state.nodes > LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT) {
    state.exhausted = true;
    return null;
  }
  if (routeIndex >= state.context.routes.length) return state.chosen.slice();
  const key = legendaryScheduleStateKey(routeIndex, slots, fireTicks);
  if (state.memo.has(key)) return null;
  const feasible = collectLegendaryFeasibleAssignments(state.context, routeIndex, slots, fireTicks);
  for (const candidate of feasible) {
    // Only the selected SAM changes. Copying every profile for every branch
    // made the bounded fallback scale with the whole friendly SAM roster.
    const nextSlots = slots.slice();
    nextSlots[candidate.samIndex] = slots[candidate.samIndex].slice();
    const nextFireTicks = fireTicks.slice();
    applyLegendarySamAssignment(nextSlots, nextFireTicks, candidate);
    state.chosen[routeIndex] = candidate;
    const result = searchLegendaryExactSchedule(state, routeIndex + 1, nextSlots, nextFireTicks);
    if (result) return result;
  }
  state.memo.add(key);
  return null;
}

function runLegendaryExactSchedule(context) {
  const state = {
    context,
    nodes: 0,
    exhausted: false,
    memo: new Set(),
    chosen: new Array(context.routes.length),
  };
  const assignments = searchLegendaryExactSchedule(
    state,
    0,
    context.profiles.map((profile) => profile.availableTicks.slice()),
    context.profiles.map(() => 0),
  );
  return { assignments, nodes: state.nodes, exhausted: state.exhausted };
}

function legendaryCompetingClaimDisplacesRoute(
  context,
  missiles,
  routeIndex,
  otherIndex,
) {
  if (otherIndex === routeIndex) return false;
  const assigned = missiles[routeIndex];
  const otherAssigned = missiles[otherIndex];
  if (!otherAssigned.intercepted || otherAssigned.samIndex === assigned.samIndex) return false;
  if (assigned.samIndex >= otherAssigned.samIndex) return false;
  const otherRoute = context.routes[otherIndex];
  const option = otherRoute.samOptions.find(
    (candidate) => candidate.samIndex === assigned.samIndex,
  );
  if (!option || !Number.isFinite(option.claimScore)) return false;
  const opportunity = firstLegendaryInterceptOpportunity(
    option,
    assigned.samFireTick,
    otherRoute.impactTick,
  );
  return Boolean(
    opportunity &&
    opportunity.fireTick <= assigned.samFireTick + 1 &&
    option.claimScore >= assigned.claimScore,
  );
}

function legendaryRouteHasEngineClaimConflict(context, missiles, routeIndex) {
  const assigned = missiles[routeIndex];
  if (!assigned.intercepted || !Number.isFinite(assigned.claimScore)) return false;
  return context.routes.some((_, otherIndex) =>
    legendaryCompetingClaimDisplacesRoute(
      context,
      missiles,
      routeIndex,
      otherIndex,
    ));
}

function legendaryEngineClaimConflictIndex(context, missiles) {
  return missiles.findIndex((_, routeIndex) =>
    legendaryRouteHasEngineClaimConflict(context, missiles, routeIndex));
}

// Mirror the engine's launcher-order claim semantics for an exact matching.
// SAMs do not receive an explicit missile assignment: launchers run in stable
// execution order and each claims its highest-priority still-unclaimed route.
// An exact matching is safe to emit only when replaying that order reproduces
// every selected SAM.  Unknown claim scores remain fail-closed.
function legendaryExactScheduleMatchesEngineOrder(context, assignments) {
  if (!Array.isArray(assignments)) return false;
  const claimed = new Set();
  for (let samIndex = 0; samIndex < context.profiles.length; samIndex++) {
    const owned = assignments
      .map((assignment, routeIndex) => ({ assignment, routeIndex }))
      .filter(({ assignment }) => assignment?.samIndex === samIndex)
      .sort(
        (left, right) =>
          left.assignment.fireTick - right.assignment.fireTick ||
          left.routeIndex - right.routeIndex,
      );
    for (const { assignment, routeIndex } of owned) {
      const route = context.routes[routeIndex];
      const selectedOption = route?.samOptions.find((option) => option.samIndex === samIndex);
      if (!selectedOption || !Number.isFinite(selectedOption.claimScore)) return false;
      const selected = firstLegendaryInterceptOpportunity(
        selectedOption,
        assignment.fireTick,
        route.impactTick,
      );
      if (!selected || selected.fireTick !== assignment.fireTick) return false;
      for (let candidateIndex = 0; candidateIndex < context.routes.length; candidateIndex++) {
        if (claimed.has(candidateIndex) || candidateIndex === routeIndex) continue;
        const candidateRoute = context.routes[candidateIndex];
        const candidateOption = candidateRoute?.samOptions.find(
          (option) => option.samIndex === samIndex,
        );
        if (!candidateOption || !Number.isFinite(candidateOption.claimScore)) continue;
        const opportunity = firstLegendaryInterceptOpportunity(
          candidateOption,
          assignment.fireTick,
          candidateRoute.impactTick,
        );
        if (
          opportunity &&
          (candidateOption.claimScore > selectedOption.claimScore ||
            (candidateOption.claimScore === selectedOption.claimScore &&
              (candidateRoute.impactTick < route.impactTick ||
                (candidateRoute.impactTick === route.impactTick && candidateIndex < routeIndex))))
        ) {
          return false;
        }
      }
      claimed.add(routeIndex);
    }
  }
  return claimed.size === assignments.length;
}

function resolveLegendaryMissileSchedule(context, greedyMissiles) {
  const fullyDefended = greedyMissiles.every((missile) => missile.intercepted);
  if (fullyDefended) {
    const conflictIndex = legendaryEngineClaimConflictIndex(context, greedyMissiles);
    if (conflictIndex >= 0) {
      const missiles = greedyMissiles.slice();
      missiles[conflictIndex] = legendaryScheduledMissile(
        context.routes[conflictIndex],
        null,
      );
      return {
        missiles,
        fullyDefended: false,
        method: "engine-order-conflict",
        nodes: 0,
      };
    }
    return { missiles: greedyMissiles, fullyDefended: true, method: "greedy", nodes: 0 };
  }
  if (context.routes.length === 0 || context.routes.length > LEGENDARY_EXACT_SCHEDULE_ROUTE_LIMIT) {
    return { missiles: greedyMissiles, fullyDefended: false, method: "inconclusive", nodes: 0 };
  }
  const exact = runLegendaryExactSchedule(context);
  if (exact.assignments) {
    if (legendaryExactScheduleMatchesEngineOrder(context, exact.assignments)) {
      return {
        missiles: exact.assignments.map((assignment, routeIndex) =>
          legendaryScheduledMissile(context.routes[routeIndex], assignment),
        ),
        fullyDefended: true,
        method: "engine-order-exact",
        nodes: exact.nodes,
      };
    }
    // A theoretical reassignment that the autonomous launcher order would not
    // reproduce is unsafe. Keep the observable greedy schedule and fail closed.
    return {
      missiles: greedyMissiles,
      fullyDefended: false,
      method: "engine-order-inconclusive",
      nodes: exact.nodes,
    };
  }
  const method = exact.exhausted ? "inconclusive" : "exact-impossible";
  return { missiles: greedyMissiles, fullyDefended: false, method, nodes: exact.nodes };
}

function legendaryMissileDefenseSchedule({
  routes = [],
  samProfiles = [],
  samCooldownTicks = 90,
  marginTicks = 5,
  completionTick = 0,
} = {}) {
  const cooldown = Math.max(1, legendaryScoreValue(samCooldownTicks));
  const margin = Math.max(0, legendaryScoreValue(marginTicks));
  const rawCompletion = Number(completionTick);
  const completion = Number.isFinite(rawCompletion) ? Math.max(0, rawCompletion) : Infinity;
  const profiles = normalizeLegendarySamProfiles(samProfiles, cooldown);
  const normalizedRoutes = normalizeLegendaryMissileRoutes(routes, profiles.length);
  const context = {
    profiles,
    routes: normalizedRoutes,
    futureUse: buildLegendaryFutureSamUse(normalizedRoutes, profiles.length),
  };
  const resolved = resolveLegendaryMissileSchedule(context, runLegendaryGreedySchedule(context));
  const firstImpactTick = normalizedRoutes[0]?.impactTick ?? Infinity;
  const completionMarginTicks = Number.isFinite(firstImpactTick)
    ? Math.max(0, firstImpactTick - completion)
    : Infinity;
  const margins = resolved.missiles.map((missile) => missile.marginTicks);
  return {
    fullyDefended: resolved.fullyDefended,
    completionMarginSatisfied: Number.isFinite(firstImpactTick) && completionMarginTicks >= margin,
    firstImpactTick,
    completionTick: completion,
    completionMarginTicks,
    minimumInterceptMarginTicks: margins.length ? Math.min(...margins) : Infinity,
    interceptedCount: resolved.missiles.filter((missile) => missile.intercepted).length,
    uninterceptedCount: resolved.missiles.filter((missile) => !missile.intercepted).length,
    missiles: resolved.missiles,
    samProfiles: profiles,
    scheduleMethod: resolved.method,
    exactSearchNodes: resolved.nodes,
  };
}

// An emergency defense action is useful before it solves the whole salvo. The
// schedule metrics must still improve, otherwise a capacity increase that does
// not affect any active missile only burns the economy reserve.
function legendaryFiniteValueImproves(currentValue, nextValue) {
  const current = Number(currentValue);
  const next = Number(nextValue);
  return Number.isFinite(next) && (!Number.isFinite(current) || next > current);
}

function legendaryFiniteValueDecreases(currentValue, nextValue) {
  const current = Number(currentValue);
  const next = Number(nextValue);
  return Number.isFinite(current) && Number.isFinite(next) && next < current;
}

function legendaryDefenseActionImproves(
  currentEvaluation = {},
  nextEvaluation = {},
  currentCapacity = 0,
  nextCapacity = 0,
) {
  if (!currentEvaluation || !nextEvaluation) return false;
  if (nextEvaluation.hasThreats === false) return false;
  if (nextEvaluation.fullyDefended && !currentEvaluation.fullyDefended) {
    return true;
  }

  if (legendaryFiniteValueDecreases(
    currentEvaluation.uninterceptedCount,
    nextEvaluation.uninterceptedCount,
  )) {
    return true;
  }

  return legendaryFiniteValueImproves(
    currentEvaluation.minimumInterceptMarginTicks,
    nextEvaluation.minimumInterceptMarginTicks,
  );
}

function legendaryObjectiveBalance(candidate) {
  return Math.min(
    ...LEGENDARY_PRIMARY_FIELDS.map((field) =>
      legendaryScoreValue(candidate[field]),
    ),
  );
}

function legendaryObjectiveTotal(candidate) {
  return LEGENDARY_PRIMARY_FIELDS.reduce(
    (total, field) => total + legendaryScoreValue(candidate[field]),
    0,
  );
}

function compareLegendaryCandidates(left, right) {
  const bothEconomicActions =
    (left.type === "City" || left.type === "Factory" || left.type === "Port") &&
    (right.type === "City" || right.type === "Factory" || right.type === "Port");
  if (bothEconomicActions) {
    const capacityPriority =
      legendaryScoreValue(right.capacity) - legendaryScoreValue(left.capacity);
    if (capacityPriority !== 0) return capacityPriority;
    if (left.netTeamGold !== undefined && right.netTeamGold !== undefined) {
      const leftNetGold = legendaryBigInt(left.netTeamGold);
      const rightNetGold = legendaryBigInt(right.netTeamGold);
      if (leftNetGold !== rightNetGold) return leftNetGold > rightNetGold ? -1 : 1;
    }
  }

  for (const field of LEGENDARY_PRIORITY_FIELDS) {
    const a = legendaryScoreValue(left[field]);
    const b = legendaryScoreValue(right[field]);
    if (a !== b) return b - a;
  }

  if (
    left.netTeamGold !== undefined &&
    right.netTeamGold !== undefined
  ) {
    const leftGold = legendaryBigInt(left.netTeamGold);
    const rightGold = legendaryBigInt(right.netTeamGold);
    if (leftGold !== rightGold) return leftGold > rightGold ? -1 : 1;
  }

  const leftBalance = legendaryObjectiveBalance(left);
  const rightBalance = legendaryObjectiveBalance(right);
  if (leftBalance !== rightBalance) return rightBalance - leftBalance;

  const leftTotal = legendaryObjectiveTotal(left);
  const rightTotal = legendaryObjectiveTotal(right);
  if (leftTotal !== rightTotal) return rightTotal - leftTotal;

  const leftDefense = legendaryScoreValue(left.defense);
  const rightDefense = legendaryScoreValue(right.defense);
  if (leftDefense !== rightDefense) return rightDefense - leftDefense;

  for (const field of LEGENDARY_TIE_FIELDS) {
    const a = legendaryScoreValue(left[field]);
    const b = legendaryScoreValue(right[field]);
    if (a !== b) return b - a;
  }

  const leftCost = legendaryBigInt(left.cost);
  const rightCost = legendaryBigInt(right.cost);
  if (leftCost !== rightCost) return leftCost < rightCost ? -1 : 1;

  const leftOrder = legendaryScoreValue(left.typeOrder);
  const rightOrder = legendaryScoreValue(right.typeOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  return String(left.type ?? "").localeCompare(String(right.type ?? ""));
}

function rankLegendaryConstructionCandidates(candidates, options = {}) {
  const gold = legendaryBigInt(options.gold ?? 0n);
  const reserve = legendaryBigInt(options.reserve ?? 0n);
  const available = gold > reserve ? gold - reserve : 0n;

  return candidates
    .filter((candidate) => {
      if (!candidate || candidate.legal === false || candidate.affordable === false) {
        return false;
      }
      return legendaryBigInt(candidate.cost) <= available;
    })
    .slice()
    .sort(compareLegendaryCandidates);
}

function rankLegendaryConstructionActions(candidates, options = {}) {
  const gold = legendaryBigInt(options.gold ?? 0n);
  const reserve = legendaryBigInt(options.reserve ?? 0n);
  const available = gold > reserve ? gold - reserve : 0n;
  const eligible = candidates
    .filter((candidate) => candidate && candidate.legal !== false)
    .slice()
    .sort(compareLegendaryCandidates);
  // Runtime economy candidates always carry an explicit netTeamGold verdict.
  // Synthetic/non-economic callers without one preserve their legacy ordering.
  const valueRanked = eligible.filter((candidate) => {
    if (candidate.netTeamGold === undefined) return true;
    let netTeamGold;
    if (typeof candidate.netTeamGold === "bigint") {
      netTeamGold = candidate.netTeamGold;
    } else if (
      typeof candidate.netTeamGold === "number" &&
      Number.isFinite(candidate.netTeamGold)
    ) {
      netTeamGold = BigInt(Math.round(candidate.netTeamGold));
    } else {
      return false;
    }
    if (netTeamGold > 0n) return true;
    return (
      !["City", "Factory", "Port"].includes(candidate.type) ||
      Number(candidate.capacity ?? 0) > 0 ||
      candidate.seedPair === true
    );
  });
  const affordable = valueRanked.filter(
    (candidate) =>
      candidate.affordable !== false && legendaryBigInt(candidate.cost) <= available,
  );
  const bestFuture = valueRanked.find(
    (candidate) => legendaryBigInt(candidate.cost) > available,
  );

  if (!bestFuture) return affordable;
  const shortfall = legendaryBigInt(bestFuture.cost) - available;
  const bestNow = affordable[0] ?? null;
  // Waiting is an actual portfolio action.  It wins only when the preferred
  // future asset dominates every affordable one and buying the best immediate
  // alternative would consume at least the entire funding gap.  In that case
  // spending now necessarily delays the dominating action by more gold than is
  // currently missing; no income-rate guess or arbitrary ratio is required.
  if (
    bestNow === null ||
    (compareLegendaryCandidates(bestFuture, bestNow) < 0 &&
      shortfall * 2n <= legendaryBigInt(bestNow.cost))
  ) {
    return [
      {
        action: "wait",
        type: "Wait",
        targetType: bestFuture.type,
        shortfall,
        cost: 0n,
      },
      ...affordable,
    ];
  }
  return affordable;
}

function chooseLegendaryConstructionCandidate(candidates, options = {}) {
  return rankLegendaryConstructionCandidates(candidates, options)[0] ?? null;
}
