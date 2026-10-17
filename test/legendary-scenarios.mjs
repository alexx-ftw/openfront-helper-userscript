// Scenario suite for the eight documented edge cases of the Legendary
// economic policy (seed pairs, paid-stop networks, saturation, troop cap,
// upgrade vs new build, horizon gates, personal affordability). It exercises
// the live planner functions exactly like test/legendary.mjs and prices the
// saturation scenarios with the live openfront-engine Config.
import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { readLegendaryPlannerSource } from "./helpers/legendary-planner-source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { readNukeBehaviorSource } from "./helpers/nuke-behavior-source.mjs";

const plannerSandbox = {};
executeClassicScript(readLegendaryPlannerSource(), plannerSandbox, {
  filename: "legendaryPlanner.js",
});
assert.equal(
  typeof plannerSandbox.legendaryEconomyNetGold,
  "function",
  "the Legendary planner exposes legendaryEconomyNetGold",
);
assert.equal(
  typeof plannerSandbox.rankLegendaryConstructionActions,
  "function",
  "the Legendary planner exposes rankLegendaryConstructionActions",
);
assert.equal(
  typeof plannerSandbox.legendaryStructureHorizonTicks,
  "function",
  "the Legendary planner exposes legendaryStructureHorizonTicks",
);

// Live engine Config (tsx loader, same pattern as test/construction-simulator.mjs).
const { register: registerTsxLoader } = await import("tsx/esm/api");
const unregisterTsxLoader = registerTsxLoader({
  tsconfig: path.resolve(repoRoot, "openfront-engine/tsconfig.json"),
});
const { Config: LiveEngineConfig } =
  await import("../openfront-engine/src/core/configuration/Config.ts");
const { UnitType: LiveUnitType } = await import("../openfront-engine/src/core/game/Game.ts");
unregisterTsxLoader();
const liveConfig = new LiveEngineConfig({}, null, false);

// Live config wrapper for legendaryEconomyNetGold: durations come from the
// engine's unitInfo table, spawn rates from the live saturation curves.
const liveDurationOf = (type) => {
  const unitInfo = liveConfig.unitInfo(LiveUnitType[type]);
  return Math.max(0, Math.floor(Number(unitInfo?.constructionDuration) || 0));
};
const liveEconomyConfig = {
  unitInfo: (type) => ({ constructionDuration: liveDurationOf(type) }),
  trainSpawnRate: (factories, trains) => liveConfig.trainSpawnRate(factories, trains),
  tradeShipSpawnRate: (rejections, ships) => liveConfig.tradeShipSpawnRate(rejections, ships),
};

const scenarios = [];
const scenario = (name, test) => {
  const result = test();
  if (result && typeof result.then === "function") {
    return result.then(() => {
      scenarios.push(name);
    });
  }
  scenarios.push(name);
};

const structureSource = readStructureBehaviorSource();
const structureSandbox = {
  Difficulty: { Impossible: "Impossible" },
  GameMode: { Team: "Team" },
  UNIT: { City: "City", Factory: "Factory", Port: "Port" },
  currentDifficulty: () => "Impossible",
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
  isAtLeastHardDifficulty: () => true,
  isLegendaryDifficulty: () => false,
  legendaryPlacementProximityScore: (distance, radius) =>
    Math.max(0, 1 - distance / Math.max(1, radius)),
  legendaryExpectedTrainRatePerTick: plannerSandbox.legendaryExpectedTrainRatePerTick,
  legendaryEconomySpawnMultipliers: plannerSandbox.legendaryEconomySpawnMultipliers,
  legendaryStructureHorizonTicks: plannerSandbox.legendaryStructureHorizonTicks,
  legendaryEconomyNetGold: plannerSandbox.legendaryEconomyNetGold,
  legendaryEconomyNetGoldAsync: async (...args) =>
    structureSandbox.legendaryEconomyNetGold(...args),
  legendaryMissileDefenseSchedule: plannerSandbox.legendaryMissileDefenseSchedule,
  UniversalPathFinding: null,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
};
const nukePathSandbox = {
  UNIT: {},
  within: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
  globalThis: null,
};
nukePathSandbox.globalThis = nukePathSandbox;
executeClassicScript(
  readNukeBehaviorSource() + "\nglobalThis.__ScenarioUniversalPathFinding = UniversalPathFinding;",
  nukePathSandbox,
  { filename: "nukeBehavior-pathfinder.js" },
);
structureSandbox.UniversalPathFinding = nukePathSandbox.__ScenarioUniversalPathFinding;
structureSandbox.globalThis = structureSandbox;
executeClassicScript(
  structureSource + "\nglobalThis.ScenarioStructureBehavior = StructureBehavior;",
  structureSandbox,
  { filename: "structureBehavior-scenarios.js" },
);
const ScenarioStructureBehavior = structureSandbox.ScenarioStructureBehavior;

// ── (a) Two teammates share water without ports: only the seed pair of two
// owners commits, and neither stream pays out until both Ports complete. ──
scenario("a: seed pair commits as one pair; no payout until both complete", () => {
  const waterPlayer = (smallId, teamId, ports = []) => ({
    id: () => smallId,
    smallID: () => smallId,
    teamId,
    isPlayer: () => true,
    isAlive: () => true,
    hasEmbargoAgainst: () => false,
    isOnSameTeam: (other) => other?.teamId === teamId,
    isAlliedWith: () => false,
    units: (type) => (type === "Port" ? ports : []),
  });
  const noPorts = [];
  const ownerA = waterPlayer(1, 7, noPorts);
  const ownerB = waterPlayer(2, 7);
  const thirdTeammate = waterPlayer(3, 7);
  const seedBehavior = Object.create(ScenarioStructureBehavior.prototype);
  Object.assign(seedBehavior, {
    player: ownerA,
    game: {
      players: () => [ownerA, ownerB, thirdTeammate],
      sharedWaterComponents: () => new Set([-1]),
      forEachNeighbor: (tile, callback) => callback(tile + 1),
      isWater: () => true,
      isOcean: () => true,
    },
  });
  assert.deepEqual(
    Array.from(seedBehavior.legendaryPortSeedOwnerIds(-1)),
    ["1", "2"],
    "seed selection is the first tradeable owner pair, excluding the third teammate",
  );
  assert.equal(seedBehavior.legendaryPortSeedPartner(), ownerB);
  assert.equal(seedBehavior.legendaryPortSeedWindowOpen(), true);
  seedBehavior.player = thirdTeammate;
  assert.equal(
    seedBehavior.legendaryPortSeedWindowOpen(),
    false,
    "a third teammate cannot open a second seed window on the same water",
  );
  // Once a Port is under construction, the seed window for that builder is
  // spent; the committed partner state is what the ROI pricing consumes.
  ownerA.units = (type) =>
    type === "Port"
      ? [
          {
            tile: () => 40,
            isUnderConstruction: () => true,
            isMarkedForDeletion: () => false,
            isActive: () => true,
          },
        ]
      : [];
  assert.equal(
    ownerA.units("Port").length === 1 &&
      seedBehavior.portOwnerStateOnWater(ownerA, -1).inProgress === true,
    true,
    "the acting seed owner's in-progress Port is recognized on the shared water",
  );

  const portTicks = liveDurationOf("Port");
  const partnerReadyTicks = portTicks * 2;
  const seedSources = [
    {
      level: 1,
      portSeedStream: "own",
      routes: [{ weight: 1, distance: 0, teamGoldPerArrival: 500_000 }],
    },
    {
      level: 1,
      portSeedStream: "partner",
      constructionDelayTicks: partnerReadyTicks,
      routes: [{ weight: 1, distance: 0, teamGoldPerArrival: 500_000 }],
    },
  ];
  const seedInputs = {
    hasCompletedTradePartner: false,
    portSeedWindowOpen: true,
    portSeedPartnerCommitted: true,
    tradeShipCount: 0,
    portSeedSources: seedSources,
  };
  const atBoundary = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 10_000,
    horizonTicks: portTicks + 1,
    inputs: seedInputs,
    config: liveEconomyConfig,
  });
  assert.equal(
    atBoundary?.refused,
    true,
    "the first completed seed Port has no payout while its partner is still under construction",
  );
  const atPartnerBoundary = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 10_000,
    horizonTicks: partnerReadyTicks,
    inputs: seedInputs,
    config: liveEconomyConfig,
  });
  assert.equal(
    atPartnerBoundary?.refused,
    true,
    "the seed pair has no income at the tick the slower Port completes",
  );
  const afterBoundary = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 10_000,
    horizonTicks: partnerReadyTicks + 1,
    inputs: seedInputs,
    config: liveEconomyConfig,
  });
  assert.ok(
    afterBoundary?.refused !== true && afterBoundary.netTeamGold > 0,
    "after both Ports complete, both owners' trade-ship streams pay",
  );
  const singleStream = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 10_000,
    horizonTicks: partnerReadyTicks + 1,
    inputs: { ...seedInputs, portSeedSources: [seedSources[0]] },
    config: { ...liveEconomyConfig, unitInfo: () => ({ constructionDuration: partnerReadyTicks }) },
  });
  assert.ok(
    Math.abs(afterBoundary.netTeamGold + 10_000 - 2 * (singleStream.netTeamGold + 10_000)) < 1e-6,
    "the committed pair earns exactly both owners' streams",
  );
  const uncommitted = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 10_000,
    horizonTicks: 5_000,
    inputs: { ...seedInputs, portSeedPartnerCommitted: false },
    config: liveEconomyConfig,
  });
  assert.equal(
    uncommitted,
    null,
    "an uncommitted seed prices zero income and only survives as a strategic seed",
  );
});

// ── (f) Payback beyond the deterministic match horizon or an active doomsday
// deadline: no investment. Long horizon with the reserve intact: a positive-payback
// investment can win. ──
scenario("f: horizon gates refuse short-horizon builds; long horizon invests", () => {
  const behavior = makePaidStopNetwork({ City: [networkStation(33, 30, 1)] });
  const inputs = railEconomyInputs(behavior);
  const factoryCost = 40_000;
  const payback = (horizonTicks) =>
    plannerSandbox.legendaryEconomyNetGold("Factory", {
      cost: factoryCost,
      horizonTicks,
      inputs,
      config: liveEconomyConfig,
    });
  const positiveValue = payback(50_000);
  assert.ok(
    positiveValue.refused !== true && positiveValue.netTeamGold > 0,
    "a long horizon leaves room for a positive-payback Factory",
  );
  assert.ok(
    Number.isFinite(positiveValue.paybackTicks) && positiveValue.paybackTicks > 0,
    "the priced Factory exposes a finite positive payback",
  );
  const paybackAt = (horizonTicks) => {
    const value = payback(horizonTicks);
    return value.refused === true ? -Infinity : value.netTeamGold;
  };
  let low = liveDurationOf("Factory") + Number(inputs.routeDelayTicks ?? 0) + 1;
  let high = 50_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (paybackAt(middle) >= 0) high = middle;
    else low = middle + 1;
  }
  const breakEvenTicks = low;
  const belowBreakEven = paybackAt(breakEvenTicks - 1);
  const atBreakEven = paybackAt(breakEvenTicks);
  assert.ok(
    belowBreakEven < 0 && atBreakEven >= 0,
    "net gold crosses zero at the first positive cumulative-value horizon",
  );
  assert.equal(
    plannerSandbox.rankLegendaryConstructionActions(
      [economyAction("Factory", factoryCost, payback(breakEvenTicks - 1))].filter(Boolean),
      { gold: 200_000n },
    ).length,
    0,
    "the action selector does not invest when payback exceeds the horizon",
  );
  assert.equal(
    plannerSandbox.legendaryStructureHorizonTicks(
      { config: () => ({ msPerTick: () => 100, gameConfig: () => ({ maxTimerValue: 200 }) }) },
      0,
    ),
    170 * 60 * 10,
    "the match horizon cannot extend past the 170-minute hard end",
  );
  const doomsdayGame = (rotDeathSeconds) => ({
    config: () => ({
      msPerTick: () => 100,
      gameConfig: () => ({ maxTimerValue: 200, rotDeathSeconds }),
    }),
  });
  const clockPlayer = (ticks) => ({
    inDoomsdayClock: () => true,
    doomsdayClockTicks: () => ticks,
  });
  assert.equal(
    plannerSandbox.legendaryStructureHorizonTicks(doomsdayGame(150), 0, clockPlayer(100)),
    1_400,
    "an active doomsday clock caps the horizon at the elimination deadline",
  );
  assert.equal(
    plannerSandbox.legendaryStructureHorizonTicks(doomsdayGame(150), 0, clockPlayer(1_500)),
    0,
    "an expired doomsday deadline leaves no horizon at all",
  );
  const imminentHorizon = plannerSandbox.legendaryStructureHorizonTicks(
    doomsdayGame(150),
    0,
    clockPlayer(1_499),
  );
  assert.equal(imminentHorizon, 1, "one live tick remains before elimination");
  assert.equal(
    payback(imminentHorizon)?.refused,
    true,
    "an imminent elimination deadline consumes the investment horizon",
  );
  const almostFinishedGame = {
    ...doomsdayGame(0),
    ticksSinceStart: () => 170 * 60 * 10 - 1,
  };
  const remainingMatchTicks = plannerSandbox.legendaryStructureHorizonTicks(almostFinishedGame, 0);
  assert.equal(remainingMatchTicks, 1, "elapsed match time leaves one live match tick");
  assert.equal(
    payback(remainingMatchTicks)?.refused,
    true,
    "a long investment is refused near the normal match end too",
  );
  // Reserve intact: the paid-stop Factory wins a treasury that clears both
  // cost and reserve, and the identical candidate at gold 999n below cost is
  // dropped from the portfolio (the reserve never pays for anything).
  const cityValue = plannerSandbox.legendaryEconomyNetGold("City", {
    cost: 10_000,
    horizonTicks: 10_000,
    inputs,
    config: liveEconomyConfig,
  });
  const richPortfolio = plannerSandbox.rankLegendaryConstructionActions(
    [
      economyAction("Factory", factoryCost, positiveValue),
      economyAction("City", 10_000, cityValue),
    ].filter(Boolean),
    { gold: 200_000n, reserve: 50_000n },
  )[0]?.type;
  assert.equal(
    richPortfolio,
    "Factory",
    "with the reserve intact, the positive-payback Factory wins the portfolio",
  );
  const poorPortfolio = plannerSandbox.rankLegendaryConstructionActions(
    [{ type: "Factory", cost: 1_000n, gold: 1, troops: 1, defense: 1, netTeamGold: 50_000n }],
    { gold: 999n, reserve: 0n },
  );
  assert.equal(
    poorPortfolio[0]?.action,
    "wait",
    "a builder below cost is told to wait even with a positive net price",
  );
});

// ── (g) Builder just below the cost while an ally has a huge treasury: no
// build until the builder can pay personally. ──
scenario("g: an ally treasury never funds the builder's purchase", () => {
  const belowCost = plannerSandbox.rankLegendaryConstructionCandidates(
    [{ type: "Factory", cost: 1_000n, gold: 1, troops: 1 }],
    { gold: 999n, allyGold: 10_000_000n },
  );
  assert.equal(
    belowCost.length,
    0,
    "rankLegendaryConstructionCandidates drops the below-cost candidate despite the ally treasury",
  );
  const actions = plannerSandbox.rankLegendaryConstructionActions(
    [{ type: "Factory", cost: 1_000n, gold: 1, troops: 1, defense: 1 }],
    { gold: 999n, reserve: 0n },
  );
  assert.equal(
    actions[0]?.action,
    "wait",
    "the action rank answers wait with the exact personal shortfall",
  );
  assert.equal(actions[0]?.shortfall, 1n, "the shortfall is the builder's own missing gold");
  const oneGoldLater = plannerSandbox.rankLegendaryConstructionActions(
    [{ type: "Factory", cost: 1_000n, gold: 1, troops: 1, defense: 1 }],
    { gold: 1_000n, reserve: 0n },
  );
  assert.equal(
    oneGoldLater[0]?.type,
    "Factory",
    "once the builder can pay personally the build is presented",
  );
  const reservedAway = plannerSandbox.rankLegendaryConstructionActions(
    [{ type: "Factory", cost: 1_000n, gold: 1, troops: 1, defense: 1 }],
    { gold: 1_000n, reserve: 1n },
  );
  assert.equal(
    reservedAway[0]?.action,
    "wait",
    "a protected reserve is not spendable personal gold either",
  );
});

// ── (e) A productive Factory (and Port) with no new connections: the upgrade
// wins; adding an unused route/cluster of higher value flips back to a new build. ──
const priceFactory = (inputs, upgradeTarget) => {
  const price = (action, cost, extraInputs) =>
    plannerSandbox.legendaryEconomyNetGold("Factory", {
      cost,
      horizonTicks: 10_000,
      inputs: extraInputs,
      config: liveEconomyConfig,
    });
  const upgradeValue = price("upgrade", 20_000, {
    ...inputs,
    upgradeAction: true,
    factoryUpgrade: upgradeTarget,
  });
  const rankActions = (newBuildValue, newBuildCost = 40_000n) =>
    plannerSandbox.rankLegendaryConstructionActions(
      [
        {
          type: "Factory",
          action: "upgrade",
          cost: 20_000n,
          gold: 0,
          troops: 0,
          defense: 0,
          netTeamGold: BigInt(Math.round(upgradeValue.netTeamGold)),
        },
        {
          type: "Factory",
          action: "build",
          cost: newBuildCost,
          gold: 0,
          troops: 0,
          defense: 0,
          netTeamGold: BigInt(Math.round(newBuildValue.netTeamGold)),
        },
      ],
      { gold: 200_000n },
    )[0]?.action;
  return { price, upgradeValue, rankActions };
};

const expectPortUpgradeVersusNovelBuild = () => {
  const portRoute = (goldPerArrival) => ({
    weight: 1,
    distance: 0,
    teamGoldPerArrival: goldPerArrival,
    postAllianceGoldPerArrival: goldPerArrival,
    allianceTicksRemaining: Infinity,
  });
  const inboundSources = [
    {
      level: 1,
      constructionDelayTicks: 0,
      beforeProfile: { routes: [portRoute(0)] },
      afterProfile: { routes: [portRoute(250_000)] },
    },
  ];
  const portUpgradeInputs = {
    hasCompletedTradePartner: true,
    tradeShipCount: 0,
    portUpgradeProfile: { routes: [portRoute(250_000)] },
    portUpgradeLevel: 2,
    portCandidateProfiles: [
      {
        routes: [portRoute(250_000)],
        inboundSources,
        placementTile: 10,
      },
    ],
  };
  const portUpgradeValue = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 60_000,
    horizonTicks: 10_000,
    inputs: { ...portUpgradeInputs, upgradeAction: true },
    config: liveEconomyConfig,
  });
  assert.ok(
    portUpgradeValue.refused !== true && portUpgradeValue.netTeamGold > 0,
    "the productive Port upgrade pays back under live trade cadence",
  );
  const portUpgradeAction = {
    type: "Port",
    action: "upgrade",
    cost: 60_000n,
    gold: 0,
    troops: 0,
    defense: 0,
    netTeamGold: BigInt(Math.round(portUpgradeValue.netTeamGold)),
  };
  const rankPortBuild = (netTeamGold) =>
    plannerSandbox.rankLegendaryConstructionActions(
      [
        portUpgradeAction,
        {
          type: "Port",
          action: "build",
          cost: 120_000n,
          gold: 0,
          troops: 0,
          defense: 0,
          netTeamGold: BigInt(Math.round(netTeamGold)),
        },
      ],
      { gold: 400_000n },
    )[0]?.action;
  assert.equal(
    rankPortBuild(portUpgradeValue.netTeamGold),
    "upgrade",
    "the upgrade wins against an equal-value duplicate-route construction",
  );
  const fatRoutePort = plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 120_000,
    horizonTicks: 10_000,
    inputs: {
      ...portUpgradeInputs,
      portCandidateProfiles: [{ routes: [portRoute(2_000_000)], placementTile: 12 }],
    },
    config: liveEconomyConfig,
  });
  assert.ok(
    fatRoutePort.netTeamGold > portUpgradeValue.netTeamGold,
    "a substantially more valuable unused water route beats the upgrade",
  );
  assert.equal(
    rankPortBuild(fatRoutePort.netTeamGold),
    "build",
    "the more valuable unused water route flips the Port choice to construction",
  );
};

scenario("e: an equal-value upgrade wins; a better unused route flips to build", () => {
  const upgradeBehavior = makePaidStopNetwork(
    { City: [networkStation(33, 30, 1)] },
    { actorUnits: { Factory: [networkStation(31, 20, 1)] } },
  );
  const inputs = railEconomyInputs(upgradeBehavior);
  assert.equal(inputs.factoryPaidStops, 1, "the productive cluster keeps its single paid stop");
  const upgradeTarget = inputs.factoryUpgradeTargets[0];
  assert.ok(
    upgradeTarget && upgradeTarget.productiveFactoryLevels.length === 1,
    "the own level-one Factory is an upgrade target",
  );
  const { price, upgradeValue, rankActions } = priceFactory(inputs, upgradeTarget);
  assert.ok(
    upgradeValue.refused !== true && upgradeValue.netTeamGold > 0,
    "raising the only Factory one level pays back under live Config",
  );
  assert.equal(
    rankActions(upgradeValue),
    "upgrade",
    "the productive upgrade wins an equal-value comparison when no new route is added",
  );
  // A second, unused route (new teammate stop on another cluster) makes the
  // new Factory strictly better and flips the portfolio to build.
  const secondRouteValue = price("build", 40_000, {
    ...inputs,
    factoryRouteProfiles: [
      ...(inputs.factoryRouteProfiles ?? []),
      {
        clusterId: "rail-new",
        teamGoldPerSpawn: 100_000,
        postTeamGoldPerSpawn: 100_000,
        teamGoldAfterPendingPerSpawn: 100_000,
        postTeamGoldAfterPendingPerSpawn: 100_000,
        pendingStopDelayTicks: 0,
        eligibleTicks: Infinity,
      },
    ],
  });
  assert.ok(
    secondRouteValue.netTeamGold > upgradeValue.netTeamGold,
    "the unused second route is worth more than the first-cluster upgrade",
  );
  assert.equal(
    rankActions(secondRouteValue),
    "build",
    "the more valuable unused route flips the portfolio to new construction",
  );

  // Port side: upgrading a productive level-one Port beats duplicating the
  // same route, until a fatter unused route makes the new Port win.
  expectPortUpgradeVersusNovelBuild();
});

// ── (d) Same route, City priced at 95% vs 35% of troop cap: the cap-relief
// value only exists under pressure. ──
await scenario("d: City capacity value appears only under troop-cap pressure", async () => {
  const capBehavior = Object.create(ScenarioStructureBehavior.prototype);
  let currentTroops = 95;
  Object.assign(capBehavior, {
    game: { config: () => ({ maxTroops: () => 100 }) },
    player: { troops: () => currentTroops },
    safeMaxTroops: () => 100,
    legendaryThinDensityPressure: () => false,
  });
  assert.equal(capBehavior.computeTroopCapPressure(false), true, "95% of cap presses the builder");
  currentTroops = 35;
  assert.equal(
    capBehavior.computeTroopCapPressure(false),
    false,
    "35% of cap leaves the builder free",
  );

  const behavior = makePaidStopNetwork({ City: [networkStation(33, 30, 1)] });
  const inputs = railEconomyInputs(behavior);
  const factoryValue = plannerSandbox.legendaryEconomyNetGold("Factory", {
    cost: 40_000,
    horizonTicks: 10_000,
    inputs,
    config: liveEconomyConfig,
  });
  const rankWithCityCandidate = (cityCandidate) =>
    plannerSandbox.rankLegendaryConstructionCandidates(
      [
        {
          type: "City",
          cost: 10_000n,
          netTeamGold: 0n,
          gold: 3,
          troops: 5,
          defense: 1,
          ...cityCandidate,
        },
        {
          type: "Factory",
          cost: 40_000n,
          netTeamGold: BigInt(Math.round(factoryValue.netTeamGold)),
          gold: 3,
          troops: 1,
          defense: 1,
        },
      ],
      { gold: 200_000n },
    )[0]?.type;
  const unpressuredCity = await cityCandidateValues(capBehavior.computeTroopCapPressure(false));
  assert.equal(
    unpressuredCity.capacity,
    0,
    "the production City candidate has no cap priority at 35%",
  );
  assert.equal(
    rankWithCityCandidate(unpressuredCity),
    "Factory",
    "no pressure: Factory wins on net gold",
  );
  currentTroops = 95;
  const pressuredCity = await cityCandidateValues(capBehavior.computeTroopCapPressure(false));
  assert.equal(
    pressuredCity.capacity,
    1,
    "the production City candidate carries cap priority at 95%",
  );
  assert.equal(
    rankWithCityCandidate(pressuredCity),
    "City",
    "cap pressure: production candidate priority lets the City win",
  );
});

// ── (c) Same rail setup with a low vs high global train count: live train
// saturation cuts the Factory's marginal value enough to flip the portfolio to
// City or skip; the same holds for Port/trade-ships under live trade saturation. ──
scenario("c: live saturation flips Factory and Port between low and high global counts", () => {
  const behavior = makePaidStopNetwork({ City: [networkStation(33, 30, 1)] });
  const horizonTicks = 10_000;
  const lowTrainInputs = behavior.legendaryEconomyInputs({
    trainCount: 0,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 1,
  });
  const highTrainInputs = behavior.legendaryEconomyInputs({
    trainCount: 1_000,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 1,
  });
  const factoryAt = (inputs, cost) =>
    plannerSandbox.legendaryEconomyNetGold("Factory", {
      cost,
      horizonTicks,
      inputs,
      config: liveEconomyConfig,
    });
  const grossLow = factoryAt(lowTrainInputs, 1).netTeamGold + 1;
  const grossHigh = factoryAt(highTrainInputs, 1).netTeamGold + 1;
  const factoryCost = Math.floor((grossLow + grossHigh) / 2);
  const lowTrainFactory = factoryAt(lowTrainInputs, factoryCost);
  const highTrainFactory = factoryAt(highTrainInputs, factoryCost);
  assert.ok(
    lowTrainFactory.refused !== true && lowTrainFactory.netTeamGold > 0,
    "the low-count train pool pays back the cost chosen between both gross values",
  );
  assert.ok(
    highTrainFactory.netTeamGold < 0 && highTrainFactory.netTeamGold < lowTrainFactory.netTeamGold,
    "live global train saturation drops the same Factory below payback",
  );
  assert.equal(
    plannerSandbox.rankLegendaryConstructionActions(
      [economyAction("Factory", factoryCost, lowTrainFactory)].filter(Boolean),
      { gold: BigInt(factoryCost + 10_000) },
    )[0]?.type,
    "Factory",
    "the low-count portfolio presents the profitable Factory",
  );
  assert.equal(
    plannerSandbox.rankLegendaryConstructionActions(
      [economyAction("Factory", factoryCost, highTrainFactory)].filter(Boolean),
      { gold: BigInt(factoryCost + 10_000) },
    ).length,
    0,
    "the high-count portfolio skips the unprofitable Factory",
  );

  // Port/trade-ships: the identical saturation flip on the water side.
  const portInputs = (tradeShipCount) => ({
    hasCompletedTradePartner: true,
    tradeShipCount,
    portRoutes: [
      {
        weight: 1,
        distance: 0,
        teamGoldPerArrival: 500_000,
        postAllianceGoldPerArrival: 500_000,
        allianceTicksRemaining: Infinity,
      },
    ],
  });
  const portAt = (tradeShipCount, cost) =>
    plannerSandbox.legendaryEconomyNetGold("Port", {
      cost,
      horizonTicks,
      inputs: portInputs(tradeShipCount),
      config: liveEconomyConfig,
    });
  const portGrossLow = portAt(0, 1).netTeamGold + 1;
  const portGrossHigh = portAt(1_000, 1).netTeamGold + 1;
  const portCost = Math.floor((portGrossLow + portGrossHigh) / 2);
  const emptySeaPort = portAt(0, portCost);
  const saturatedSeaPort = portAt(1_000, portCost);
  assert.ok(
    emptySeaPort.refused !== true && emptySeaPort.netTeamGold > 0,
    "the low-count sea pays back the Port cost chosen between both gross values",
  );
  assert.ok(
    saturatedSeaPort.netTeamGold < 0 && saturatedSeaPort.netTeamGold < emptySeaPort.netTeamGold,
    "live global trade-ship saturation drops the same Port below payback",
  );
  assert.equal(
    plannerSandbox.rankLegendaryConstructionActions(
      [economyAction("Port", portCost, saturatedSeaPort)].filter(Boolean),
      { gold: 200_000_000n },
    ).length,
    0,
    "the saturated-sea portfolio skips the unprofitable Port",
  );
  const rate = (ships) =>
    plannerSandbox.legendaryExpectedTradeShipRatePerTick(1, ships, liveEconomyConfig);
  assert.ok(rate(1_000) < rate(0), "the live pity cadence itself is lower on the saturated sea");
});

scenario("h: candidate saturation charges lost teammate network income", () => {
  const trainConfig = {
    ...liveEconomyConfig,
    trainSpawnRate: (factories, trains) => 100 + 10 * factories + 100 * trains,
  };
  const teammateStream = {
    factoryCount: 1,
    productiveFactoryLevels: [1],
    pendingFactoryLevels: [],
    factoryConstructionDelayTicks: 0,
    routeReadyTicks: 0,
    pendingStopDelayTicks: 0,
    teamGoldPerSpawn: 1_000_000,
    postTeamGoldPerSpawn: 1_000_000,
    teamGoldAfterPendingPerSpawn: 1_000_000,
    postTeamGoldAfterPendingPerSpawn: 1_000_000,
    payoutTimeline: [
      {
        atTicks: 0,
        teamGoldPerSpawn: 1_000_000,
        teamGoldAfterPendingPerSpawn: 1_000_000,
      },
    ],
  };
  const factoryInputs = {
    trainCount: 0,
    ownFactoryCount: 0,
    ownProductiveFactoryLevels: [],
    ownPendingFactoryLevels: [],
    factoryPaidStops: 1,
    factoryTeamGoldPerTrain: 1_000,
    fleetProducerSupply: {
      trainOwners: [
        {
          isBuilder: false,
          factoryCount: 1,
          factories: [{ level: 1, readyAtTicks: 0 }],
        },
      ],
      portOwners: [],
    },
    factoryRouteProfiles: [
      {
        teamGoldPerSpawn: 1_000,
        postTeamGoldPerSpawn: 1_000,
        teamGoldAfterPendingPerSpawn: 1_000,
        postTeamGoldAfterPendingPerSpawn: 1_000,
      },
    ],
  };
  const priceFactory = (inputs) =>
    plannerSandbox.legendaryEconomyNetGold("Factory", {
      cost: 1,
      horizonTicks: 1_000,
      inputs,
      config: trainConfig,
    });
  const withoutTeamStream = priceFactory(factoryInputs);
  const withTeamStream = priceFactory({
    ...factoryInputs,
    otherFactoryStreams: [teammateStream],
  });
  assert.ok(
    withTeamStream.netTeamGold < withoutTeamStream.netTeamGold,
    "a new Factory subtracts the teammate payout lost to its added global train saturation",
  );
  const teammateNetwork = makePaidStopNetwork(
    {
      Factory: [networkStation(50, 20, 1)],
      City: [networkStation(51, 21, 1)],
    },
    { actorUnits: { City: [networkStation(49, 19, 1)] } },
  );
  const liveNetworkInputs = railEconomyInputs(teammateNetwork);
  assert.ok(
    liveNetworkInputs.otherFactoryStreams.some((stream) => stream.teamGoldPerSpawn > 0),
    "the live team-network scan includes a teammate Factory's paid train stream",
  );

  const portConfig = {
    ...liveEconomyConfig,
    tradeShipSpawnRate: (rejections, ships) => 100 + rejections + ships * 10,
  };
  const portRoute = {
    weight: 1,
    postAllianceWeight: 1,
    distance: 10,
    teamGoldPerArrival: 50_000,
    postAllianceGoldPerArrival: 50_000,
    allianceTicksRemaining: Infinity,
  };
  const portInputs = {
    hasCompletedTradePartner: true,
    tradeShipCount: 0,
    portRoutes: [portRoute],
    portCandidateProfiles: [{ routes: [portRoute] }],
    fleetProducerSupply: {
      trainOwners: [],
      portOwners: [
        {
          isBuilder: true,
          ports: [{ level: 1, readyAtTicks: 0, routes: [{ weight: 1, distance: 10 }] }],
        },
      ],
    },
  };
  const pricePort = (inputs) =>
    plannerSandbox.legendaryEconomyNetGold("Port", {
      cost: 1,
      horizonTicks: 500,
      inputs,
      config: portConfig,
    });
  const withoutOwnPort = pricePort(portInputs);
  const withOwnPort = pricePort({
    ...portInputs,
    ownPortProducerSources: [
      {
        structureId: "existing-owner-port",
        level: 1,
        readyAtTicks: 0,
        routes: [portRoute],
      },
    ],
  });
  assert.ok(
    withOwnPort.netTeamGold < withoutOwnPort.netTeamGold,
    "a new Port subtracts saturation loss from the builder's productive Port network",
  );
});

// ── Rail network harness: a builder without sea access next to one teammate
// City on the same station cluster (the makePaidStopNetwork fixture shape). ──
function networkStation(
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
function networkOwner(smallId, teamId, unitsByType) {
  return {
    __src: { isLobbyCreator: () => false, ownerId: smallId },
    id: () => smallId,
    smallID: () => smallId,
    teamId,
    isPlayer: () => true,
    isAlive: () => true,
    hasEmbargoAgainst: () => false,
    isOnSameTeam: (other) => other?.teamId === teamId,
    isAlliedWith: () => false,
    units: (...types) => types.flatMap((type) => unitsByType[type] ?? []),
  };
}
function makePaidStopNetwork(teammateUnits, { actorUnits = {} } = {}) {
  const actor = networkOwner(40, 7, actorUnits);
  const teammate = networkOwner(41, 7, teammateUnits);
  const behavior = Object.create(ScenarioStructureBehavior.prototype);
  Object.assign(behavior, {
    player: actor,
    game: {
      players: () => [actor, teammate],
      units: () => [],
      railroadState: () => null,
      sharedWaterComponents: () => new Set(),
      euclideanDistSquared: (left, right) => (left - right) ** 2,
      config: () => ({
        trainStationMaxRange: () => 10,
        unitInfo: (type) => ({ constructionDuration: liveDurationOf(type) }),
        trainSpawnRate: (factories, trains) => liveConfig.trainSpawnRate(factories, trains),
        tradeShipSpawnRate: (rejections, ships) => liveConfig.tradeShipSpawnRate(rejections, ships),
        trainGold: () => 25_000n,
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
    legendaryAllianceTicksRemaining: () => Infinity,
    trainGoldBase: () => 25_000,
    ownedLevels: () => 0,
  });
  return behavior;
}
function railEconomyInputs(behavior) {
  return behavior.legendaryEconomyInputs({
    trainCount: 0,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 1,
  });
}
function economyAction(type, cost, evaluation, extra = {}) {
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

async function cityCandidateValues(capPressure) {
  const candidates = [];
  const behavior = Object.create(ScenarioStructureBehavior.prototype);
  behavior.cost = () => 10_000n;
  behavior.addLegendaryConstructionCandidate = (_context, type, values) =>
    candidates.push({ type, ...values });
  behavior.legendaryCityUpgradeCandidateInfo = () => null;
  const strategicState = { railNeed: 0 };
  await behavior.addLegendaryCityCandidates(
    { candidates: [] },
    { citiesDisabled: false, cityCount: 3, capPressure, strategicState },
  );
  return candidates.find((candidate) => candidate.type === "City");
}

// ── (b) Landlocked teammate builds beside a paid teammate City/Port stop:
// Factory beats a non-binding City; removing the paid stop kills the Factory;
// under binding troop-cap pressure the City can win. ──
scenario("b: paid-stop Factory beats City; loses without the stop; City wins under cap", () => {
  const paidStopInputs = railEconomyInputs(
    makePaidStopNetwork({ City: [networkStation(33, 30, 1)] }),
  );
  assert.equal(
    paidStopInputs.factoryPaidStops,
    1,
    "the reachable teammate City is one paid Factory stop",
  );
  const horizonTicks = 10_000;
  const priced = (type, cost, inputs) =>
    plannerSandbox.legendaryEconomyNetGold(type, {
      cost,
      horizonTicks,
      inputs,
      config: liveEconomyConfig,
    });
  const paidFactory = priced("Factory", 40_000, paidStopInputs);
  assert.ok(
    paidFactory?.refused !== true && paidFactory.netTeamGold > 0,
    "the paid teammate stop makes a first Factory profitable under live Config",
  );
  const paidPortInputs = railEconomyInputs(
    makePaidStopNetwork({ Port: [networkStation(34, 31, 1)] }),
  );
  assert.equal(paidPortInputs.factoryPaidStops, 1, "a reachable teammate Port is a paid stop");
  const portFactory = priced("Factory", 40_000, paidPortInputs);
  assert.ok(
    portFactory?.refused !== true && portFactory.netTeamGold > 0,
    "a teammate Port also makes a first Factory profitable under live Config",
  );
  const paidCity = priced("City", 10_000, paidStopInputs);
  assert.equal(
    paidCity?.refused,
    true,
    "a Factory-less rail cluster refuses the City's marginal gold (no train sources)",
  );
  // The live pipeline keeps a refused-economy candidate at netTeamGold 0n:
  // "only active troop-cap relief carries a separate City value"
  // (structureBehavior addLegendaryConstructionCandidate). Mirror that
  // candidate shape instead of dropping the City from the ranking.
  const cityAction = (capacity) => ({
    type: "City",
    action: "build",
    cost: 10_000n,
    gold: 0,
    troops: 0,
    defense: 0,
    netTeamGold: 0n,
    capacity,
  });
  const paidActions = plannerSandbox.rankLegendaryConstructionActions(
    [economyAction("Factory", 40_000, paidFactory), cityAction(0)],
    { gold: 200_000n },
  );
  assert.equal(
    paidActions[0]?.type,
    "Factory",
    "with no troop-cap pressure the paid-stop Factory beats the non-binding City",
  );

  const noStopInputs = railEconomyInputs(makePaidStopNetwork({}));
  assert.equal(noStopInputs.factoryPaidStops, 0);
  assert.equal(
    priced("Factory", 40_000, noStopInputs)?.refused,
    true,
    "removing the paid stop makes the first Factory unprofitable",
  );
  const embargoedNetwork = makePaidStopNetwork({
    City: [networkStation(33, 30, 1)],
  });
  const [embargoedActor, embargoedTeammate] = embargoedNetwork.game.players();
  embargoedActor.hasEmbargoAgainst = (other) => other === embargoedTeammate;
  embargoedTeammate.hasEmbargoAgainst = (other) => other === embargoedActor;
  const embargoedInputs = railEconomyInputs(embargoedNetwork);
  assert.equal(
    embargoedInputs.factoryPaidStops,
    0,
    "an in-range teammate City under mutual embargo is not a paid stop",
  );
  assert.equal(
    priced("Factory", 40_000, embargoedInputs)?.refused,
    true,
    "the embargoed City cannot create a profitable Factory route",
  );

  // Binding cap: the same portfolio, but the City carries the capacity
  // priority (as addLegendaryCityCandidates assigns under cap pressure).
  const capActions = plannerSandbox.rankLegendaryConstructionActions(
    [economyAction("Factory", 40_000, paidFactory), cityAction(1)],
    { gold: 200_000n },
  );
  assert.equal(
    capActions[0]?.type,
    "City",
    "binding troop-cap pressure lets the City outrank the profitable Factory",
  );

  // Behavior-level boundary of the cap signal, at the live TROOP_CAP ratio.
  const capBehavior = Object.create(ScenarioStructureBehavior.prototype);
  let currentTroops = 95;
  Object.assign(capBehavior, {
    game: { config: () => ({ maxTroops: () => 100 }) },
    player: { troops: () => currentTroops },
    safeMaxTroops: () => 100,
    legendaryThinDensityPressure: () => false,
  });
  assert.equal(capBehavior.computeTroopCapPressure(), true, "95% of cap is pressure");
  currentTroops = 35;
  assert.equal(capBehavior.computeTroopCapPressure(), false, "35% of cap is no pressure");
});

for (const name of scenarios) {
  process.stdout.write(`PASS ${name}\n`);
}
assert.equal(scenarios.length, 8, "all eight documented economy scenarios must be registered");
process.stdout.write(`SCENARIOS OK n=${scenarios.length}\n`);
