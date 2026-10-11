import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { expectedRailIncomePerTick } from "./helpers/construction-simulator.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

for (const difficulty of ["Easy", "Medium", "Hard", "Impossible", "Legendary"]) {
  const settings = executeClassicScript(
    read("engine/ingame/auto-bot/core.js") + "\nloadSettings();",
    { window: { localStorage: { getItem: () => JSON.stringify({ difficulty }) } } },
  );
  assert.equal(settings.difficulty, "Legendary", "saved tiers migrate to Legendary");
}

const plannerSandbox = {};
executeClassicScript(read("engine/ingame/auto-bot/legendaryPlanner.js"), plannerSandbox, {
  filename: "legendaryPlanner.js",
});

assert.equal(
  typeof plannerSandbox.rankLegendaryConstructionCandidates,
  "function",
  "Legendary planner exposes its candidate ranking function",
);
assert.equal(
  typeof plannerSandbox.rankLegendaryConstructionActions,
  "function",
  "Legendary planner exposes build and wait actions through one portfolio rank",
);
assert.equal(
  typeof plannerSandbox.legendaryAllyPowerScore,
  "function",
  "Legendary exposes the ally-power normalizer used by placement",
);
assert.equal(
  typeof plannerSandbox.legendaryPlacementProximityScore,
  "function",
  "Legendary exposes the distance normalizer used by placement",
);

const weakAllyPower = plannerSandbox.legendaryAllyPowerScore({
  allyTroops: 1_000,
  allyGold: 1_000n,
  allyProduction: 2,
  ownTroops: 10_000,
  ownGold: 10_000n,
  ownProduction: 10,
});
const strongAllyPower = plannerSandbox.legendaryAllyPowerScore({
  allyTroops: 50_000,
  allyGold: 50_000n,
  allyProduction: 30,
  ownTroops: 10_000,
  ownGold: 10_000n,
  ownProduction: 10,
});
assert.ok(
  strongAllyPower > weakAllyPower,
  "Legendary ranks allies by their strongest relative troop, gold, or gold-production axis",
);
assert.ok(
  plannerSandbox.legendaryPlacementProximityScore(2, 10) >
    plannerSandbox.legendaryPlacementProximityScore(20, 10),
  "Legendary gives closer allies more placement support",
);

const ranked = plannerSandbox.rankLegendaryConstructionCandidates(
  [
    {
      type: "City",
      mandatory: 0,
      safety: 0,
      strategic: 0,
      gold: 6,
      troops: 6,
      defense: 0,
      deficit: 2,
      efficiency: 1,
      cost: 500n,
    },
    {
      type: "SAM Launcher",
      mandatory: 1,
      safety: 2,
      gold: 1,
      troops: 1,
      defense: 10,
      strategic: 0,
      deficit: 1,
      efficiency: 1,
      cost: 500n,
    },
    {
      type: "Port",
      mandatory: 0,
      safety: 0,
      gold: 4,
      troops: 2,
      defense: 1,
      strategic: 0,
      deficit: 2,
      efficiency: 1,
      cost: 300n,
    },
    {
      type: "Gold Factory",
      mandatory: 0,
      safety: 0,
      gold: 10,
      troops: 0,
      defense: 0,
      strategic: 0,
      deficit: 2,
      efficiency: 1,
      cost: 300n,
    },
    {
      type: "Factory",
      mandatory: 0,
      safety: 0,
      gold: 2,
      troops: 2,
      defense: 1,
      strategic: 2,
      deficit: 1,
      efficiency: 1,
      cost: 900n,
    },
    { type: "Illegal", legal: false, cost: 1n },
  ],
  { gold: 1_000n, reserve: 200n },
);

assert.deepEqual(
  ranked.map((candidate) => candidate.type),
  ["SAM Launcher", "City", "Port", "Gold Factory"],
  "Legendary balances gold and troops first; missile defense is secondary",
);

const waitForDominatingCity = plannerSandbox.rankLegendaryConstructionActions(
  [
    { type: "Factory", cost: 500n, gold: 1, troops: 1, defense: 1 },
    { type: "City", cost: 1_000n, gold: 3, troops: 5, defense: 1 },
  ],
  { gold: 800n },
);
assert.equal(waitForDominatingCity[0].action, "wait");
assert.equal(waitForDominatingCity[0].targetType, "City");
assert.equal(waitForDominatingCity[0].shortfall, 200n);

const buildWithoutMaterialDelay = plannerSandbox.rankLegendaryConstructionActions(
  [
    { type: "Factory", cost: 100n, gold: 1, troops: 1, defense: 1 },
    { type: "City", cost: 1_000n, gold: 3, troops: 5, defense: 1 },
  ],
  { gold: 800n },
);
assert.equal(
  buildWithoutMaterialDelay[0].type,
  "Factory",
  "an immediate asset remains preferred when its whole cost is smaller than the funding gap",
);

const waitWhenNothingIsAffordable = plannerSandbox.rankLegendaryConstructionActions(
  [{ type: "City", cost: 1_000n, gold: 3, troops: 5, defense: 1 }],
  { gold: 800n },
);
assert.equal(waitWhenNothingIsAffordable[0].action, "wait");
assert.equal(
  plannerSandbox.rankLegendaryConstructionCandidates(
    [{ type: "Factory", cost: 1_000n, gold: 1, troops: 1 }],
    { gold: 999n, allyGold: 10_000_000n },
  ).length,
  0,
  "an ally's treasury never makes a build affordable for the acting player",
);

// Economic net-value policy: a pure-economy candidate may carry netTeamGold,
// the expected team gold it returns over the remaining decision horizon once
// its build delay elapses, minus its build cost.
const economyHorizonTicks = 1_000;
const netTeamGoldAfter = (incomePerTick, completionDelayTicks, cost) =>
  BigInt(Math.round(incomePerTick * Math.max(0, economyHorizonTicks - completionDelayTicks))) -
  cost;
const netValuedCandidate = (incomePerTick, completionDelayTicks, cost) => ({
  type: "Factory",
  cost,
  gold: 3,
  troops: 1,
  defense: 1,
  netTeamGold: netTeamGoldAfter(incomePerTick, completionDelayTicks, cost),
});
const netValuedActions = plannerSandbox.rankLegendaryConstructionActions(
  [netValuedCandidate(4, 100, 5_000n), netValuedCandidate(10, 100, 5_000n)],
  { gold: 10_000n },
);
assert.equal(
  netValuedActions.length,
  1,
  "only actions with positive net team gold are presented as economy decisions",
);
assert.ok(netValuedActions[0]?.netTeamGold > 0n);

const crossTypeEconomyActions = plannerSandbox.rankLegendaryConstructionActions(
  [
    { type: "City", cost: 1_000n, gold: 3, troops: 5, netTeamGold: 6_000n },
    { type: "Factory", cost: 1_000n, gold: 3, troops: 1, netTeamGold: 12_000n },
    { type: "Port", cost: 1_000n, gold: 4, troops: 2, netTeamGold: 9_000n },
  ],
  { gold: 10_000n },
);
assert.deepEqual(
  crossTypeEconomyActions.map(({ type }) => type),
  ["Factory", "Port", "City"],
  "profitable City/Factory/Port choices rank by marginal team gold before generic role vectors",
);

const roiTrainRateCalls = [];
const roiConfig = {
  unitInfo: (type) => ({ constructionDuration: type === "Port" ? 50 : 20 }),
  trainSpawnRate: (factories, trains) => {
    roiTrainRateCalls.push([factories, trains]);
    return 100;
  },
  tradeShipSpawnRate: () => 100,
};
const portfolioConfig = {
  unitInfo: () => ({ constructionDuration: 100 }),
  trainSpawnRate: () => 100,
  tradeShipSpawnRate: () => 10,
};
const portfolioCityInputs = {
  trainCount: 0,
  routeDelayTicks: 0,
  trainSources: [
    {
      factoryCount: 1,
      productiveFactoryLevels: [1],
      paidStopsAfterBuild: 2,
      teamGoldPerStop: 50_000,
      postAllianceTeamGoldPerStop: 50_000,
      eligibleTicks: Infinity,
    },
  ],
};
const portfolioFactoryInputs = {
  factoryPaidStops: 1,
  factoryTeamGoldPerTrain: 50_000,
  ownFactoryCount: 0,
  ownProductiveFactoryLevels: [],
  trainCount: 0,
  routeDelayTicks: 0,
};
const portfolioPortInputs = {
  hasCompletedTradePartner: true,
  tradeShipCount: 0,
  portRoutes: [
    {
      weight: 1,
      distance: 0,
      teamGoldPerArrival: 100_000,
      postAllianceGoldPerArrival: 100_000,
      allianceTicksRemaining: Infinity,
    },
  ],
};
const pricedPortfolioAction = (type, cost, horizonTicks, inputs, action = "build") => {
  const evaluation = plannerSandbox.legendaryEconomyNetGold(type, {
    cost,
    horizonTicks,
    inputs,
    config: portfolioConfig,
  });
  if (!evaluation || evaluation.refused === true) return null;
  return {
    type,
    action,
    cost: BigInt(cost),
    gold: 0,
    troops: 0,
    defense: 0,
    netTeamGold: BigInt(Math.round(evaluation.netTeamGold)),
  };
};
const rankPortfolio = (horizonTicks, includePort = true, factoryInputs = portfolioFactoryInputs) =>
  plannerSandbox.rankLegendaryConstructionActions(
    [
      pricedPortfolioAction("City", 10_000, horizonTicks, portfolioCityInputs),
      pricedPortfolioAction("Factory", 40_000, horizonTicks, factoryInputs),
      ...(includePort
        ? [pricedPortfolioAction("Port", 120_000, horizonTicks, portfolioPortInputs)]
        : []),
    ].filter(Boolean),
    { gold: 1_000_000n },
  );
assert.equal(
  rankPortfolio(150)[0]?.type,
  "City",
  "the same paid network favors the low-cost City when only a short payback window remains",
);
assert.equal(
  rankPortfolio(1_000)[0]?.type,
  "Port",
  "the same live Config and portfolio favor Port over City/Factory on a long horizon",
);
assert.equal(
  rankPortfolio(50).length,
  0,
  "the final selector skips every economic action whose construction delay consumes the horizon",
);
assert.equal(
  rankPortfolio(1_000, false, {
    ...portfolioFactoryInputs,
    factoryPaidStops: 0,
  })[0]?.type,
  "City",
  "removing the eligible teammate paid stop flips the Factory choice back to City",
);
assert.equal(
  rankPortfolio(1_000, false)[0]?.type,
  "Factory",
  "a productive teammate City/Port stop makes the Factory the best short- and long-term team investment",
);
const delayedPortfolioBuild = pricedPortfolioAction("Factory", 40_000, 1_000, {
  ...portfolioFactoryInputs,
  routeDelayTicks: 400,
});
const productivePortfolioUpgrade = pricedPortfolioAction(
  "Factory",
  5_000,
  1_000,
  {
    ...portfolioFactoryInputs,
    upgradeAction: true,
    factoryUpgrade: {
      productiveFactoryLevels: [1],
      upgradeFactoryIndex: 0,
      factoryCount: 1,
      teamGoldPerTrain: 50_000,
    },
  },
  "upgrade",
);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [delayedPortfolioBuild, productivePortfolioUpgrade],
    { gold: 1_000_000n },
  )[0]?.action,
  "upgrade",
  "the final selector chooses a productive ROI-priced upgrade over a route-delayed new Factory",
);
assert.ok(
  Math.abs(
    plannerSandbox.legendaryExpectedTradeShipRatePerTick(1, 0, {
      tradeShipSpawnRate: () => 2,
    }) - 0.05,
  ) < 1e-8,
  "one Port level uses the long-run live pity cadence, not a fixed first-roll odds sample",
);
assert.ok(
  Math.abs(
    plannerSandbox.legendaryExpectedTradeShipRatePerTick(2, 0, {
      tradeShipSpawnRate: () => 2,
    }) - 0.075,
  ) < 1e-8,
  "each Port level contributes an additional live Config roll per ten-tick check",
);
assert.ok(
  plannerSandbox.legendaryExpectedTradeShipRatePerTick(1, 500, {
    tradeShipSpawnRate: (_rejections, ships) => (ships > 0 ? 100 : 20),
  }) <
    plannerSandbox.legendaryExpectedTradeShipRatePerTick(1, 0, {
      tradeShipSpawnRate: (_rejections, ships) => (ships > 0 ? 100 : 20),
    }),
  "global trade-ship saturation lowers marginal Port throughput",
);
const servedFactoryInputs = {
  trainCount: 0,
  ownFactoryCount: 2,
  ownProductiveFactoryLevels: [2],
  factoryPaidStops: 1,
  factoryTeamGoldPerTrain: 50_000,
};
const newFactoryValue = plannerSandbox.legendaryEconomyNetGold("Factory", {
  cost: 250_000,
  horizonTicks: 1_000,
  inputs: servedFactoryInputs,
  config: roiConfig,
});
const trainSaturationConfig = {
  unitInfo: () => ({ constructionDuration: 0 }),
  trainSpawnRate: (factories, trains) => 10 + factories + trains,
};
const factoryValueAtTrainCount = (trainCount) =>
  plannerSandbox.legendaryEconomyNetGold("Factory", {
    cost: 1_000_000,
    horizonTicks: 1_000,
    inputs: {
      ...servedFactoryInputs,
      ownFactoryCount: 1,
      ownProductiveFactoryLevels: [1],
      factoryTeamGoldPerTrain: 1_000_000,
      trainCount,
    },
    config: trainSaturationConfig,
  });
const lowTrainCountFactory = factoryValueAtTrainCount(0);
const highTrainCountFactory = factoryValueAtTrainCount(1_000);
assert.ok(
  lowTrainCountFactory.netTeamGold > 100_000n && highTrainCountFactory.netTeamGold < 100_000n,
  "global train saturation can flip a profitable Factory below a competing City action",
);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [
      { type: "City", cost: 1_000n, netTeamGold: 100_000n },
      {
        type: "Factory",
        cost: 1_000_000n,
        netTeamGold: BigInt(Math.round(lowTrainCountFactory.netTeamGold)),
      },
    ],
    { gold: 2_000_000n },
  )[0]?.type,
  "Factory",
);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [
      { type: "City", cost: 1_000n, netTeamGold: 100_000n },
      {
        type: "Factory",
        cost: 1_000_000n,
        netTeamGold: BigInt(Math.round(highTrainCountFactory.netTeamGold)),
      },
    ],
    { gold: 2_000_000n },
  )[0]?.type,
  "City",
);
assert.deepEqual(roiTrainRateCalls.splice(0), [
  [2, 0],
  [3, 0],
]);
const upgradeRateCallStart = roiTrainRateCalls.length;
const factoryUpgradeValue = plannerSandbox.legendaryEconomyNetGold("Factory", {
  cost: 40_000,
  horizonTicks: 1_000,
  inputs: {
    ...servedFactoryInputs,
    upgradeAction: true,
    factoryUpgrade: {
      factoryCount: 2,
      productiveFactoryLevels: [2],
      upgradeFactoryIndex: 0,
      teamGoldPerTrain: 50_000,
    },
  },
  config: roiConfig,
});
assert.deepEqual(
  roiTrainRateCalls.slice(upgradeRateCallStart),
  [
    [2, 0],
    [3, 0],
  ],
  "an upgrade adds rolls and raises the level-sum factory denominator that TrainStationExecution reads via unitCount",
);
assert.equal(
  plannerSandbox.legendaryStructureHorizonTicks(
    { config: () => ({ msPerTick: () => 100, gameConfig: () => ({ maxTimerValue: 200 }) }) },
    0,
  ),
  170 * 60 * 10,
  "the construction horizon cannot extend past the engine's 170-minute hard end",
);
const doomsdayGame = (rotDeathSeconds) => ({
  config: () => ({
    msPerTick: () => 100,
    gameConfig: () => ({ maxTimerValue: 200, rotDeathSeconds }),
  }),
});
const activeDoomsdayPlayer = {
  inDoomsdayClock: () => true,
  doomsdayClockTicks: () => 100,
};
assert.equal(
  plannerSandbox.legendaryStructureHorizonTicks(doomsdayGame(150), 0, activeDoomsdayPlayer),
  1_400,
  "an active doomsday clock caps Legendary payback to the live elimination deadline",
);
assert.equal(
  plannerSandbox.legendaryStructureHorizonTicks(doomsdayGame(150), 0, {
    inDoomsdayClock: () => false,
    doomsdayClockTicks: () => 0,
  }),
  170 * 60 * 10,
  "recovering above the clock threshold restores the normal match horizon",
);
assert.equal(
  plannerSandbox.legendaryStructureHorizonTicks(doomsdayGame(0), 0, activeDoomsdayPlayer),
  170 * 60 * 10,
  "a disabled territory-rot deadline does not shorten the economy horizon",
);
assert.equal(
  plannerSandbox.legendaryStructureHorizonTicks(doomsdayGame(150), 0, {
    inDoomsdayClock: () => true,
    doomsdayClockTicks: () => 1_500,
  }),
  0,
  "an expired doomsday deadline leaves no economy payback horizon",
);
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("Factory", {
    cost: 1,
    horizonTicks: 0,
    inputs: servedFactoryInputs,
    config: roiConfig,
  })?.refused,
  true,
  "economy investment is refused after the survival horizon expires",
);
assert.ok(
  factoryUpgradeValue.netTeamGold > newFactoryValue.netTeamGold,
  "a productive Factory upgrade can beat new construction when its exact next-level price is lower",
);
const newPortValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100_000,
  horizonTicks: 1_000,
  inputs: {
    hasCompletedTradePartner: true,
    portTradeGoldPerArrival: 120_000,
    portTeamPayoutFactor: 2,
    tradeShipCount: 0,
  },
  config: roiConfig,
});
const delayedPortValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100_000,
  horizonTicks: 1_000,
  inputs: {
    hasCompletedTradePartner: true,
    portTradeGoldPerArrival: 120_000,
    portRouteDelayTicks: 300,
    tradeShipCount: 0,
  },
  config: roiConfig,
});
assert.ok(
  delayedPortValue.netTeamGold < newPortValue.netTeamGold,
  "an estimated water route travel time reduces the Port payback window",
);
const allianceShiftRate = plannerSandbox.legendaryExpectedTradeShipRatePerTick(1, 0, {
  tradeShipSpawnRate: () => 100,
});
const allianceShiftGold = plannerSandbox.legendaryPortExpectedGold(
  {
    routes: [
      {
        weight: 2,
        postAllianceWeight: 1,
        distance: 0,
        teamGoldPerArrival: 1_000,
        postAllianceGoldPerArrival: 1_000,
        allianceTicksRemaining: 50,
      },
      {
        weight: 1,
        postAllianceWeight: 1,
        distance: 0,
        teamGoldPerArrival: 0,
        postAllianceGoldPerArrival: 0,
        allianceTicksRemaining: Infinity,
      },
    ],
  },
  {
    level: 1,
    upgrade: false,
    tradeShipCount: 0,
    config: { tradeShipSpawnRate: () => 100 },
    startDelayTicks: 0,
    horizon: 1_000,
    fallbackDistance: 0,
  },
);
assert.ok(
  Math.abs(allianceShiftGold - allianceShiftRate * (1_000 * ((50 * 2) / 3 + 950 / 2))) < 1e-6,
  "Port value keeps endpoint payouts after an alliance expires but reweights remaining trade routes",
);
const pendingPartnerPortValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100,
  horizonTicks: 500,
  inputs: {
    hasCompletedTradePartner: false,
    hasPendingTradePartner: true,
    portSeedWindowOpen: false,
    tradeShipCount: 0,
    portRoutes: [
      {
        weight: 1,
        distance: 0,
        destinationConstructionDelayTicks: 800,
        teamGoldPerArrival: 1_000,
        postAllianceGoldPerArrival: 1_000,
        allianceTicksRemaining: Infinity,
      },
    ],
  },
  config: {
    unitInfo: () => ({ constructionDuration: 50 }),
    tradeShipSpawnRate: () => 1,
  },
});
assert.ok(
  pendingPartnerPortValue?.netTeamGold > 0 && pendingPartnerPortValue.productiveTicks === 450,
  "a new source Port earns at an eligible destination still under construction after its own 50-tick build",
);
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 100,
    horizonTicks: 49,
    inputs: {
      hasCompletedTradePartner: false,
      hasPendingTradePartner: true,
      portSeedWindowOpen: false,
      tradeShipCount: 0,
      portRoutes: [
        {
          weight: 1,
          distance: 0,
          teamGoldPerArrival: 1_000,
          postAllianceGoldPerArrival: 1_000,
          allianceTicksRemaining: Infinity,
        },
      ],
    },
    config: {
      unitInfo: () => ({ constructionDuration: 50 }),
      tradeShipSpawnRate: () => 1,
    },
  }).refused,
  true,
  "a new source Port cannot earn before its own construction completes",
);
const portUpgradeValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100_000,
  horizonTicks: 1_000,
  inputs: {
    hasCompletedTradePartner: true,
    portTradeGoldPerArrival: 120_000,
    portTeamPayoutFactor: 2,
    tradeShipCount: 0,
    upgradeAction: true,
  },
  config: roiConfig,
});
assert.ok(
  portUpgradeValue.netTeamGold > newPortValue.netTeamGold,
  "a productive Port upgrade avoids construction delay and uses partner trade payouts",
);
const portInboundSources = [
  {
    level: 1,
    constructionDelayTicks: 20,
    beforeProfile: {
      routes: [
        {
          weight: 1,
          distance: 40,
          teamGoldPerArrival: 0,
          postAllianceGoldPerArrival: 0,
          allianceTicksRemaining: Infinity,
        },
      ],
    },
    afterProfile: {
      routes: [
        {
          weight: 1,
          distance: 40,
          teamGoldPerArrival: 0,
          postAllianceGoldPerArrival: 0,
          allianceTicksRemaining: Infinity,
        },
        {
          weight: 1,
          distance: 60,
          teamGoldPerArrival: 100_000,
          postAllianceGoldPerArrival: 100_000,
          allianceTicksRemaining: Infinity,
        },
      ],
    },
  },
];
const inboundPortValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100_000,
  horizonTicks: 1_000,
  inputs: {
    hasCompletedTradePartner: true,
    tradeShipCount: 0,
    portCandidateProfiles: [
      {
        routes: [
          {
            weight: 1,
            distance: 0,
            teamGoldPerArrival: 120_000,
            postAllianceGoldPerArrival: 120_000,
            allianceTicksRemaining: Infinity,
          },
        ],
        inboundSources: portInboundSources,
      },
    ],
  },
  config: roiConfig,
});
assert.ok(
  inboundPortValue?.netTeamGold > newPortValue.netTeamGold,
  "a new destination values incoming team payouts from existing source Ports",
);
const inboundPortUpgradeValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100_000,
  horizonTicks: 1_000,
  inputs: {
    hasCompletedTradePartner: true,
    tradeShipCount: 0,
    upgradeAction: true,
    portUpgradeLevel: 1,
    portUpgradeProfile: {
      routes: [
        {
          weight: 1,
          distance: 0,
          teamGoldPerArrival: 120_000,
          postAllianceGoldPerArrival: 120_000,
          allianceTicksRemaining: Infinity,
        },
      ],
      inboundSources: portInboundSources,
    },
  },
  config: roiConfig,
});
assert.ok(
  inboundPortUpgradeValue?.netTeamGold > portUpgradeValue.netTeamGold,
  "upgrading a Port values its increased destination weight for incoming traffic",
);
const seedPortInputs = {
  hasCompletedTradePartner: false,
  portSeedWindowOpen: true,
  seedPairDelayTicks: 50,
  tradeShipCount: 0,
  portSeedSources: [
    { level: 1, routes: [{ weight: 1, distance: 0, teamGoldPerArrival: 100 }] },
    { level: 1, routes: [{ weight: 1, distance: 0, teamGoldPerArrival: 100 }] },
  ],
};
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 100,
    horizonTicks: 50,
    inputs: seedPortInputs,
    config: { unitInfo: () => ({ constructionDuration: 50 }), tradeShipSpawnRate: () => 1 },
  }).refused,
  true,
  "a two-owner seed pair earns no trade gold before both Ports are complete",
);
assert.ok(
  plannerSandbox.legendaryEconomyNetGold("Port", {
    cost: 100,
    horizonTicks: 100,
    inputs: seedPortInputs,
    config: { unitInfo: () => ({ constructionDuration: 50 }), tradeShipSpawnRate: () => 1 },
  }).netTeamGold > 0,
  "both owners' live trade-ship streams count after the seed pair completes",
);
const cityAllianceConfig = {
  unitInfo: () => ({ constructionDuration: 0 }),
  trainSpawnRate: () => 1,
};
const pendingFactoryCityInputs = {
  trainCount: 0,
  routeDelayTicks: 0,
  trainSources: [
    {
      factoryCount: 1,
      productiveFactoryLevels: [],
      pendingFactoryLevels: [1],
      factoryConstructionDelayTicks: 600,
      paidStopsAfterBuild: 1,
      teamGoldPerStop: 1_000,
      postAllianceTeamGoldPerStop: 1_000,
      eligibleTicks: Infinity,
    },
  ],
};
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("City", {
    cost: 100,
    horizonTicks: 500,
    inputs: pendingFactoryCityInputs,
    config: {
      unitInfo: () => ({ constructionDuration: 100 }),
      trainSpawnRate: () => 1,
    },
  }).netTeamGold,
  -100,
  "a City cannot claim income from a Factory whose completion is beyond the useful horizon",
);
assert.ok(
  plannerSandbox.legendaryEconomyNetGold("City", {
    cost: 100,
    horizonTicks: 1_000,
    inputs: pendingFactoryCityInputs,
    config: {
      unitInfo: () => ({ constructionDuration: 100 }),
      trainSpawnRate: () => 1,
    },
  }).netTeamGold > 0,
  "a pending Factory contributes after its live construction delay",
);
const cityAllianceInputs = {
  trainCount: 0,
  routeDelayTicks: 0,
  trainSources: [
    {
      factoryCount: 1,
      productiveFactoryLevels: [1],
      paidStopsAfterBuild: 1,
      teamGoldPerStop: 1_000,
      postAllianceTeamGoldPerStop: 500,
      eligibleTicks: 200,
    },
  ],
};
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("City", {
    cost: 1_000,
    horizonTicks: 1_000,
    inputs: cityAllianceInputs,
    config: cityAllianceConfig,
  }).netTeamGold,
  59_000,
  "City ROI switches an allied train network to its post-alliance payout instead of dropping it",
);
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("Factory", {
    cost: 100_000,
    horizonTicks: 1_000,
    inputs: { ...servedFactoryInputs, factoryPaidStops: 0, upgradeAction: true },
    config: roiConfig,
  }).refused,
  true,
  "an unserved Factory upgrade has no economy value",
);
for (const [incomePerTick, completionDelayTicks, cost, paysBack] of [
  [10, 100, 7_000n, true],
  [10, 600, 7_000n, false],
  [10, 1_000, 1_000n, false],
  [10, 400, 7_000n, false],
  [10, 400, 5_000n, true],
]) {
  const [decision] = plannerSandbox.rankLegendaryConstructionActions(
    [netValuedCandidate(incomePerTick, completionDelayTicks, cost)],
    { gold: 10_000n },
  );
  assert.equal(
    decision !== undefined,
    paysBack,
    "a build must pay back its cost within the remaining horizon after its build delay",
  );
}
const capReliefCity = {
  type: "City",
  cost: 4_000n,
  gold: 0,
  troops: 0,
  defense: 0,
  netTeamGold: -2_000n,
  capacity: 1,
};
const tradePort = {
  type: "Port",
  cost: 4_000n,
  gold: 4,
  troops: 2,
  defense: 1,
  netTeamGold: 3_000n,
};
const pressureRanked = plannerSandbox.rankLegendaryConstructionActions([capReliefCity, tradePort], {
  gold: 10_000n,
});
assert.deepEqual(
  pressureRanked.map((candidate) => candidate.type),
  ["City", "Port"],
  "while the army is capped, a City outranks economy even with no production value",
);
assert.deepEqual(
  plannerSandbox
    .rankLegendaryConstructionActions([{ ...capReliefCity, capacity: 0 }, tradePort], {
      gold: 10_000n,
    })
    .map((candidate) => candidate.type),
  ["Port"],
  "a City's cap value is pressure-only: without pressure it never counts as production",
);
const railRoute = {
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
const saturatedFleetRate = (factories, trains) => (trains === 0 ? 200 : 800);
const routeIncome = (trainCount, candidate) =>
  expectedRailIncomePerTick({
    ...railRoute,
    candidate,
    trainCount,
    trainSpawnRate: saturatedFleetRate,
  }).totalIncomePerTick;
const marginalFactoryIncome = (trainCount) =>
  routeIncome(trainCount, { id: "candidate-factory", type: "Factory" }) -
  routeIncome(trainCount, null);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [netValuedCandidate(marginalFactoryIncome(0), 100, 40_000n)],
    { gold: 1_000_000n },
  ).length,
  1,
  "a served Factory has positive net team gold at low global saturation",
);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [netValuedCandidate(marginalFactoryIncome(50), 100, 40_000n)],
    { gold: 1_000_000n },
  ).length,
  0,
  "high global saturation leaves a duplicate Factory with non-positive net team gold",
);
// Unique productive route: the only paying stop is the single City in
// railRoute, so the new Factory's income comes from the simulator while a
// City upgrade carries pressure-only cap value with no route income.
const uniqueRouteFactoryNet = netTeamGoldAfter(
  routeIncome(0, { id: "candidate-factory", type: "Factory" }) - routeIncome(0, null),
  100,
  20_000n,
);
assert.ok(uniqueRouteFactoryNet > 0n);
const routeCityUpgrade = {
  type: "City",
  action: "upgrade",
  upgradeStructureId: 7,
  cost: 25_000n,
  gold: 0,
  troops: 0,
  defense: 0,
  netTeamGold: -25_000n,
};
const routeFactoryBuild = {
  type: "Factory",
  cost: 20_000n,
  gold: 3,
  troops: 1,
  defense: 1,
  netTeamGold: uniqueRouteFactoryNet,
};
assert.deepEqual(
  plannerSandbox
    .rankLegendaryConstructionActions([{ ...routeCityUpgrade, capacity: 1 }, routeFactoryBuild], {
      gold: 1_000_000n,
    })
    .map((candidate) => candidate.action ?? candidate.type),
  ["upgrade", "Factory"],
  "on the unique productive route, cap pressure ranks the City upgrade above new construction",
);
assert.deepEqual(
  plannerSandbox
    .rankLegendaryConstructionActions([{ ...routeCityUpgrade, capacity: 0 }, routeFactoryBuild], {
      gold: 1_000_000n,
    })
    .map((candidate) => candidate.action ?? candidate.type),
  ["Factory"],
  "without cap pressure, only the positive-net new construction on the unique route survives",
);

assert.equal(
  plannerSandbox.chooseLegendaryConstructionCandidate(
    [{ type: "Factory", cost: 900n, mandatory: 1 }],
    { gold: 1_000n, reserve: 200n },
  ),
  null,
  "Legendary holds the strategic reserve instead of spending through it",
);

const connectedCity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 0,
  cityRailConnection: 1,
});
const saturatedCity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 4,
  cityRailConnection: 1,
});
assert.ok(
  connectedCity.gold > saturatedCity.gold,
  "City gold contribution has diminishing returns on a connected rail network",
);
const silo = plannerSandbox.legendaryConstructionObjectiveVector("Missile Silo", {
  targetPressure: 2,
});
const sam = plannerSandbox.legendaryConstructionObjectiveVector("SAM Launcher", {
  defenseGap: 2,
});
const port = plannerSandbox.legendaryConstructionObjectiveVector("Port", {
  tradeNeed: 2,
  destroyerNeed: 2,
});
const factoryAtOpenTrainRate = plannerSandbox.legendaryConstructionObjectiveVector("Factory", {
  railNeed: 1,
  trainSpawnMultiplier: 1,
});
const factoryAtSaturatedTrainRate = plannerSandbox.legendaryConstructionObjectiveVector("Factory", {
  railNeed: 1,
  trainSpawnMultiplier: 0.25,
});
const portAtOpenShipRate = plannerSandbox.legendaryConstructionObjectiveVector("Port", {
  tradeNeed: 0.25,
  tradeShipSpawnMultiplier: 1,
});
const portAtSaturatedShipRate = plannerSandbox.legendaryConstructionObjectiveVector("Port", {
  tradeNeed: 0.25,
  tradeShipSpawnMultiplier: 0.25,
});
const portWithoutPartner = plannerSandbox.legendaryConstructionObjectiveVector("Port", {
  tradeNeed: 2,
  hasTradePartner: false,
});
assert.equal(
  typeof plannerSandbox.legendaryEconomySpawnMultipliers,
  "function",
  "Legendary derives construction value from the live Config spawn-rate functions",
);
const observedTrainRates = [];
const observedShipRates = [];
const liveRateScenario = plannerSandbox.legendaryEconomySpawnMultipliers(
  {
    trainSpawnRate: (factories, trains) => {
      observedTrainRates.push([factories, trains]);
      return trains === 0 ? 200 : 800;
    },
    tradeShipSpawnRate: (rejections, ships) => {
      observedShipRates.push([rejections, ships]);
      return ships === 0 ? 100 : 400;
    },
  },
  3,
  50,
  80,
);
assert.equal(liveRateScenario.trainSpawnMultiplier, 0.25);
assert.equal(liveRateScenario.tradeShipSpawnMultiplier, 0.25);
assert.deepEqual(observedTrainRates, [
  [4, 0],
  [4, 50],
]);
assert.deepEqual(observedShipRates, [
  [0, 0],
  [0, 80],
]);
assert.ok(
  factoryAtOpenTrainRate.gold > factoryAtSaturatedTrainRate.gold,
  "global train saturation reduces a new Factory's marginal economy value",
);
assert.ok(
  portAtOpenShipRate.gold > portAtSaturatedShipRate.gold,
  "global trade-ship saturation reduces a new Port's marginal economy value",
);
const cityAtNetworkCapacity = plannerSandbox.legendaryConstructionObjectiveVector("City", {
  connectedCities: 3,
});
const rankEconomyPair = (factory) =>
  plannerSandbox.rankLegendaryConstructionCandidates(
    [
      { type: "Factory", cost: 100n, ...factory },
      { type: "City", cost: 100n, ...cityAtNetworkCapacity },
    ],
    { gold: 1_000n },
  );
assert.equal(
  rankEconomyPair(factoryAtOpenTrainRate)[0].type,
  "Factory",
  "an unsaturated rail source can beat a nonbinding City on a served cluster",
);
assert.equal(
  rankEconomyPair(factoryAtSaturatedTrainRate)[0].type,
  "City",
  "global train saturation can flip a marginal Factory choice to City",
);
const rankPortPair = (candidate) =>
  plannerSandbox.rankLegendaryConstructionCandidates(
    [
      { type: "Port", cost: 100n, ...candidate },
      { type: "City", cost: 100n, ...cityAtNetworkCapacity },
    ],
    { gold: 1_000n },
  );
assert.equal(
  rankPortPair(portAtOpenShipRate)[0].type,
  "Port",
  "an unsaturated, low-need Port can beat a City when it adds trade capacity",
);
assert.equal(
  rankPortPair(portAtSaturatedShipRate)[0].type,
  "City",
  "global ship saturation can flip a marginal Port choice to City",
);
assert.equal(portWithoutPartner.gold, 0, "a Port with no tradeable route has no economy value");
assert.equal(
  rankPortPair(portWithoutPartner)[0].type,
  "City",
  "a Port without a tradeable route cannot win as a pure-economy build",
);
const rankedNetTeamGold = plannerSandbox.rankLegendaryConstructionActions(
  [
    {
      type: "City",
      cost: 1n,
      mandatory: 1,
      netTeamGold: 10n,
      gold: 10,
      troops: 10,
      defense: 0,
      capacity: 0,
    },
    {
      type: "Factory",
      cost: 1n,
      netTeamGold: 100n,
      gold: 0,
      troops: 0,
      defense: 0,
      capacity: 0,
    },
  ],
  { gold: 10n },
);
assert.equal(
  rankedNetTeamGold[0]?.type,
  "Factory",
  "actual net team gold outranks nominal production and early-City priorities among economic actions",
);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [
      { type: "City", cost: 1n, netTeamGold: -1n, capacity: 1 },
      { type: "Port", cost: 1n, netTeamGold: 100n, capacity: 0 },
    ],
    { gold: 10n },
  )[0]?.type,
  "City",
  "binding troop-cap pressure remains the only economy-priority exception to net gold",
);
assert.ok("gold" in connectedCity && "troops" in connectedCity, "City exposes a production vector");
assert.ok(silo.gold > 0 && silo.troops > 0, "Silo remains costed in the production model");
assert.ok(sam.defense > sam.gold, "SAM is a defensive guardrail, not a production axis");
assert.ok(
  port.gold > 0 && port.troops > 0 && port.defense > 0,
  "Port contributes to trading while carrying a defensive risk",
);

const safeMissileThreat = plannerSandbox.legendaryMissileThreatScore({
  enemySilos: [{ level: 1 }],
  enemyGold: 500_000n,
  atomCost: 750_000n,
  hydrogenCost: 3_000_000n,
  flightTimeTicks: 120,
  vulnerableStructures: 1,
  vulnerableBlastArea: 1,
  hydrogenBlastArea: 100,
});
const criticalMissileThreat = plannerSandbox.legendaryMissileThreatScore({
  enemySilos: [{ level: 3 }, { level: 5 }],
  enemyGold: 30_000_000n,
  atomCost: 750_000n,
  hydrogenCost: 3_000_000n,
  flightTimeTicks: 5,
  vulnerableStructures: 12,
  vulnerableBlastArea: 100,
  hydrogenBlastArea: 100,
});
assert.ok(
  criticalMissileThreat.score > safeMissileThreat.score && criticalMissileThreat.critical,
  "Missile defense accounts for silo levels, enemy gold, flight time, and blast exposure",
);

const chainedSalvo = plannerSandbox.legendaryMissileSalvoRisk({
  atomArrivalTicks: [20, 21, 22],
  hydrogenArrivalTick: 23,
  interceptionCapacity: 2,
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  chainedSalvo.hydrogenGetsThrough,
  true,
  "Legendary models cheap atom bombs exhausting SAM capacity before hydrogen",
);
assert.equal(
  chainedSalvo.marginSatisfied,
  false,
  "Legendary preserves a five-tick (0.5s) impact margin",
);

const scheduledChain = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 21, samOptions: [{ samIndex: 0, interceptTicks: [11] }] },
    { weapon: "HydrogenBomb", impactTick: 22, samOptions: [{ samIndex: 0, interceptTicks: [12] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0, 0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
  completionTick: 0,
});
assert.equal(
  scheduledChain.uninterceptedCount,
  1,
  "Per-missile scheduling catches the hydrogen finisher after two ready SAM shots",
);
assert.equal(
  scheduledChain.fullyDefended,
  false,
  "A chained salvo is unsafe when any incoming missile has no assigned interceptor",
);

const engineOrderExact = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      weapon: "AtomBomb",
      impactTick: 30,
      samOptions: [
        { samIndex: 0, interceptTicks: [10], claimScore: 20 },
        { samIndex: 1, interceptTicks: [10], claimScore: 10 },
      ],
    },
    {
      weapon: "AtomBomb",
      impactTick: 31,
      samOptions: [{ samIndex: 0, interceptTicks: [11], claimScore: 30 }],
    },
    {
      weapon: "AtomBomb",
      impactTick: 32,
      samOptions: [{ samIndex: 1, interceptTicks: [12], claimScore: 5 }],
    },
  ],
  samProfiles: [
    { id: "sam-first", availableTicks: [0] },
    { id: "sam-second", availableTicks: [0, 0] },
  ],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  engineOrderExact.fullyDefended,
  true,
  "an exact matching is accepted when replaying launcher claim order reproduces it",
);
assert.equal(engineOrderExact.scheduleMethod, "engine-order-exact");

const actualWeaponLabels = plannerSandbox.legendaryMissileSalvoRisk({
  routes: [
    { weapon: "Atom Bomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "Atom Bomb", impactTick: 21, samOptions: [{ samIndex: 0, interceptTicks: [11] }] },
    {
      weapon: "Hydrogen Bomb",
      impactTick: 22,
      samOptions: [{ samIndex: 0, interceptTicks: [12] }],
    },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0, 0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  actualWeaponLabels.atomIntercepted,
  2,
  "Production weapon labels with spaces are normalized as atom bombs",
);
assert.equal(
  actualWeaponLabels.hydrogenGetsThrough,
  true,
  "Production hydrogen label is recognized as the finisher",
);

const sameTickOverload = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0, 0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  sameTickOverload.uninterceptedCount,
  0,
  "A levelled SAM can spend multiple ready missile slots in the same engine tick",
);
assert.equal(sameTickOverload.fullyDefended, true);

const impactTickIsTooLate = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [20] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  impactTickIsTooLate.uninterceptedCount,
  1,
  "an interceptor cannot destroy a nuke on its final impact tick",
);

const flightAwareInterception = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      weapon: "AtomBomb",
      impactTick: 20,
      samOptions: [{ samIndex: 0, interceptTicks: [5], interceptionTicks: [10] }],
    },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [5] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(flightAwareInterception.missiles[0].samFireTick, 5);
assert.equal(
  flightAwareInterception.missiles[0].interceptTick,
  10,
  "the schedule distinguishes SAM launch time from the later missile collision",
);
assert.equal(flightAwareInterception.missiles[0].marginTicks, 10);

const reloadTooSlow = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 100, samOptions: [{ samIndex: 0, interceptTicks: [90] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  reloadTooSlow.uninterceptedCount,
  1,
  "A SAM cannot fire again before its reload completes",
);

const reloadReady = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 110, samOptions: [{ samIndex: 0, interceptTicks: [100] }] },
  ],
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  reloadReady.fullyDefended,
  true,
  "A later missile can be defended once the SAM reload window has elapsed",
);

assert.equal(
  typeof plannerSandbox.legendaryDefenseActionImproves,
  "function",
  "Legendary exposes the incremental defense-action policy",
);
const lowLevelSalvoRoutes = [
  { weapon: "AtomBomb", impactTick: 120, samOptions: [{ samIndex: 0, interceptTicks: [100] }] },
  { weapon: "AtomBomb", impactTick: 121, samOptions: [{ samIndex: 0, interceptTicks: [101] }] },
  { weapon: "HydrogenBomb", impactTick: 122, samOptions: [{ samIndex: 0, interceptTicks: [102] }] },
];
const lowLevelDefense = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: lowLevelSalvoRoutes,
  samProfiles: [{ id: "sam-a", availableTicks: [0] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
const oneLevelHigherDefense = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: lowLevelSalvoRoutes,
  samProfiles: [{ id: "sam-a", availableTicks: [0, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
const twoLevelsHigherDefense = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: lowLevelSalvoRoutes,
  samProfiles: [{ id: "sam-a", availableTicks: [0, 90, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(lowLevelDefense.fullyDefended, false);
assert.equal(oneLevelHigherDefense.fullyDefended, false);
assert.ok(
  oneLevelHigherDefense.uninterceptedCount < lowLevelDefense.uninterceptedCount,
  "a higher SAM level must reduce the unresolved part of a salvo even before full defense is reached",
);
assert.equal(
  twoLevelsHigherDefense.fullyDefended,
  true,
  "the next staged SAM upgrade must eventually cover the atom chain and Hydrogen finisher",
);
assert.equal(
  plannerSandbox.legendaryDefenseActionImproves(lowLevelDefense, oneLevelHigherDefense, 1, 1),
  true,
  "Legendary must accept a SAM upgrade that materially improves an unresolved salvo",
);
assert.equal(
  plannerSandbox.legendaryDefenseActionImproves(oneLevelHigherDefense, oneLevelHigherDefense, 2, 2),
  false,
  "Legendary must not repeat a SAM upgrade that adds no defensive value",
);
const capacityOnlyCurrent = {
  hasThreats: true,
  fullyDefended: false,
  uninterceptedCount: 1,
  minimumInterceptMarginTicks: 0,
};
const capacityOnlyNext = { ...capacityOnlyCurrent };
assert.equal(
  plannerSandbox.legendaryDefenseActionImproves(capacityOnlyCurrent, capacityOnlyNext, 1, 2),
  false,
  "Legendary must not buy capacity that leaves the active missile schedule unchanged",
);

const upgradedSlotStillReloading = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "HydrogenBomb", impactTick: 80, samOptions: [{ samIndex: 0, interceptTicks: [70] }] },
  ],
  // The level-2 range is already available, but the added slot is still
  // reloading after a hypothetical instant upgrade.
  samProfiles: [{ id: "upgraded-sam", availableTicks: [0, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  upgradedSlotStillReloading.uninterceptedCount,
  1,
  "An upgraded SAM's added slot is not available before SAMCooldown elapses",
);

const upgradedSlotReloaded = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    {
      weapon: "HydrogenBomb",
      impactTick: 120,
      samOptions: [{ samIndex: 0, interceptTicks: [100] }],
    },
  ],
  samProfiles: [{ id: "upgraded-sam", availableTicks: [0, 90] }],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  upgradedSlotReloaded.fullyDefended,
  true,
  "An upgraded SAM can use its new range and added slot after its reload",
);

const alternateAssignment = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      weapon: "AtomBomb",
      impactTick: 10,
      samOptions: [
        { samIndex: 0, interceptTicks: [0] },
        { samIndex: 1, interceptTicks: [0] },
      ],
    },
    { weapon: "AtomBomb", impactTick: 20, samOptions: [{ samIndex: 0, interceptTicks: [10] }] },
    { weapon: "AtomBomb", impactTick: 110, samOptions: [{ samIndex: 1, interceptTicks: [100] }] },
  ],
  samProfiles: [
    { id: "sam-a", availableTicks: [0] },
    { id: "sam-b", availableTicks: [0] },
  ],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  alternateAssignment.fullyDefended,
  false,
  "A theoretical alternate SAM matching cannot prove defense under the engine's autonomous claim order",
);
assert.equal(
  alternateAssignment.scheduleMethod,
  "engine-order-inconclusive",
  "The planner exposes when only an unenforceable alternate assignment covers the salvo",
);
assert.equal(
  alternateAssignment.uninterceptedCount,
  1,
  "The observable greedy schedule retains the missile that may penetrate in the real engine",
);

const engineClaimOrderConflict = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      id: "exclusive",
      weapon: "AtomBomb",
      impactTick: 20,
      samOptions: [{ samIndex: 0, interceptTicks: [0], claimScore: 100 }],
    },
    {
      id: "shared-higher-priority",
      weapon: "AtomBomb",
      impactTick: 20,
      samOptions: [
        { samIndex: 0, interceptTicks: [0], claimScore: 200 },
        { samIndex: 1, interceptTicks: [0], claimScore: 150 },
      ],
    },
  ],
  samProfiles: [
    { id: "sam-flexible", availableTicks: [0] },
    { id: "sam-shared-only", availableTicks: [0] },
  ],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  engineClaimOrderConflict.fullyDefended,
  false,
  "a theoretical full matching is unsafe when engine target priority makes the flexible SAM claim the shared missile",
);
assert.equal(engineClaimOrderConflict.scheduleMethod, "engine-order-conflict");
assert.equal(engineClaimOrderConflict.uninterceptedCount, 1);

const safeEngineClaimOrder = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    {
      id: "exclusive-late-sam",
      impactTick: 20,
      samOptions: [{ samIndex: 1, interceptTicks: [0], claimScore: 100 }],
    },
    {
      id: "shared-claimed-first",
      impactTick: 20,
      samOptions: [
        { samIndex: 0, interceptTicks: [0], claimScore: 150 },
        { samIndex: 1, interceptTicks: [0], claimScore: 200 },
      ],
    },
  ],
  samProfiles: [
    { id: "sam-shared-first", availableTicks: [0] },
    { id: "sam-flexible-later", availableTicks: [0] },
  ],
});
assert.equal(
  safeEngineClaimOrder.fullyDefended,
  true,
  "an earlier shared-only SAM claims its target before the later flexible launcher runs",
);

const equivalentReadySlotRoutes = [
  {
    impactTick: 10,
    samOptions: [
      { samIndex: 0, interceptTicks: [0] },
      { samIndex: 1, interceptTicks: [0] },
    ],
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    impactTick: 20 + index * 10,
    samOptions: [{ samIndex: 1, interceptTicks: [10 + index * 10] }],
  })),
];
const equivalentReadySlotSchedule = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: equivalentReadySlotRoutes,
  samProfiles: [
    { id: "sam-a", availableTicks: [0] },
    { id: "sam-b", availableTicks: [0, 0, 0] },
  ],
  samCooldownTicks: 90,
  marginTicks: 5,
});
assert.equal(
  equivalentReadySlotSchedule.scheduleMethod,
  "exact-impossible",
  "Legendary preserves an explicit proof that an overloaded schedule is impossible",
);
assert.ok(
  equivalentReadySlotSchedule.exactSearchNodes < 10,
  "exact search collapses equivalent ready-slot branches instead of revisiting them",
);

const constructionTooLate = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 304, samOptions: [{ samIndex: 0, interceptTicks: [300] }] },
  ],
  samProfiles: [{ id: "new-sam", availableTicks: [300] }],
  samCooldownTicks: 90,
  marginTicks: 5,
  completionTick: 300,
});
assert.equal(
  constructionTooLate.fullyDefended,
  true,
  "A just-completed SAM can technically intercept a missile on its covered path",
);
assert.equal(
  constructionTooLate.completionMarginSatisfied,
  false,
  "A construction that finishes only four ticks before impact is rejected by the five-tick rule",
);

const constructionOnTime = plannerSandbox.legendaryMissileDefenseSchedule({
  routes: [
    { weapon: "AtomBomb", impactTick: 305, samOptions: [{ samIndex: 0, interceptTicks: [300] }] },
  ],
  samProfiles: [{ id: "new-sam", availableTicks: [300] }],
  samCooldownTicks: 90,
  marginTicks: 5,
  completionTick: 300,
});
assert.equal(
  constructionOnTime.completionMarginSatisfied,
  true,
  "A new SAM is eligible only when completion leaves at least five ticks before impact",
);

assert.match(read("engine/ingame/auto-bot/portutil.js"), /Legendary: "Legendary"/);
assert.match(read("engine/ingame/auto-bot/core.js"), /difficulty: "Legendary"/);
assert.match(read("engine/ingame/auto-bot/core.js"), /Train: "Train"/);
assert.match(read("engine/ingame/auto-bot/panel.js"), /return \["Legendary"\]/);
assert.doesNotMatch(read("engine/ingame/auto-bot/panel.js"), /\["Easy", "Medium", "Hard"/);
assert.match(read("src/shell/popup/panel.ts"), /DIFFICULTIES/);
assert.match(read("locales/en/common.json"), /"Legendary"/);
assert.match(read("build.mjs"), /auto-bot\/legendaryPlanner\.js/);
assert.match(
  read("engine/ingame/auto-bot/legendaryPlanner.js"),
  /LEGENDARY_EXACT_SCHEDULE_NODE_LIMIT/,
);
const structureSource = read("engine/ingame/auto-bot/structureBehavior.js");
assert.match(structureSource, /rankLegendaryConstructionActions/);
assert.match(structureSource, /legendaryAllySupportPlacementScore/);
assert.match(structureSource, /legendaryTeamCenterPlacementScore/);
assert.match(structureSource, /LEGENDARY_SAM_IMPACT_MARGIN_TICKS/);
assert.match(structureSource, /maybeUpgradeLegendarySam/);
assert.match(structureSource, /legendaryMissileDefenseUrgent/);
assert.match(structureSource, /legendaryMinimumSamImpactMargin/);
assert.match(structureSource, /missileTimerQueue/);
assert.match(structureSource, /legendaryMissileDefenseSchedule/);
assert.match(structureSource, /legendaryDefenseActionImproves/);
assert.match(structureSource, /legendarySamConstructionSafeForTile/);
assert.match(structureSource, /legendaryConstructionDuration/);
assert.match(structureSource, /legendaryTileInsideUninterceptedBlast/);
assert.match(structureSource, /legendarySamCoveragePlacementContext/);
assert.match(structureSource, /structureValues/);
assert.match(structureSource, /structureTiles/);
assert.match(structureSource, /launchMetadataCache/);
assert.match(structureSource, /enemySiloLevels/);
assert.match(structureSource, /samImpactMarginContext/);
assert.match(structureSource, /targetableIndexes/);
assert.match(structureSource, /coverageProfile/);
assert.match(structureSource, /legendarySamRouteHasIntercept/);
assert.match(structureSource, /legendarySamRouteHasTemporalOverlap/);
assert.match(structureSource, /targetableBounds/);
assert.match(structureSource, /missileTargetEntriesCache/);
assert.match(structureSource, /missileTargetOrderingCache/);
assert.match(structureSource, /increaseLevel\(\)/);
assert.match(structureSource, /targetLevel/);
assert.match(structureSource, /SiloCooldown/);
assert.match(structureSource, /legendaryEnemyMissileLaunchPlan/);
assert.match(structureSource, /forecastComplete/);
assert.match(structureSource, /legendaryThreatDefensePlan/);
assert.match(read("engine/ingame/auto-bot/gameApi.js"), /motionPlans/);

const structureSandbox = {
  Difficulty: { Impossible: "Impossible" },
  GameMode: { Team: "Team" },
  UNIT: {},
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
  `${read("engine/ingame/auto-bot/nukeBehavior.js")}\nglobalThis.__UniversalPathFinding = UniversalPathFinding;`,
  nukePathSandbox,
  { filename: "nukeBehavior-pathfinder.js" },
);
structureSandbox.UniversalPathFinding = nukePathSandbox.__UniversalPathFinding;
structureSandbox.globalThis = structureSandbox;
executeClassicScript(
  `${structureSource}\nglobalThis.StructureBehavior = StructureBehavior;`,
  structureSandbox,
  { filename: "structureBehavior.js" },
);
assert.equal(
  typeof structureSandbox.StructureBehavior.prototype.maybeOpenLegendaryNavalEconomy,
  "undefined",
  "a forced first-Port action cannot bypass route, horizon, and cross-type ROI ranking",
);
const economyStateBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const economyUnits = {
  Train: Array.from({ length: 50 }),
  "Trade Ship": Array.from({ length: 80 }),
};
const economyFactoryUnits = [
  { level: () => 2, isUnderConstruction: () => false },
  { level: () => 3, isUnderConstruction: () => false },
  { level: () => 1, isUnderConstruction: () => true },
];
const observedStateFactoryCounts = [];
const observedTrainGoldCalls = [];
const sourcePlayerView = { isLobbyCreator: () => false };
let economyForeignPorts = [];
Object.assign(economyStateBehavior, {
  game: {
    config: () => ({
      trainSpawnRate: (factories, trains) => {
        observedStateFactoryCounts.push([factories, trains]);
        return trains === 0 ? 200 : 800;
      },
      tradeShipSpawnRate: (_rejections, ships) => (ships === 0 ? 100 : 400),
      trainGold: (relation, citiesVisited, player) => {
        observedTrainGoldCalls.push([relation, citiesVisited, player]);
        return 42_000n;
      },
    }),
    units: (type) => economyUnits[type] ?? [],
  },
  player: {
    __src: sourcePlayerView,
    units: (type) => (type === "Factory" ? economyFactoryUnits : []),
  },
  enemyMissileSiloPressure: () => 0,
  getMissileDefenseContext: () => ({ critical: false }),
  legendaryRailMetrics: () => ({
    connectedCities: 1,
    cityRailConnection: 1,
    railNeed: 1,
    tradeNeed: 1,
  }),
  legendaryHostilePlayers: () => [],
  ownedLevels: () => 0,
  missileSiloParityTarget: () => 0,
  samLevelParityTarget: () => 0,
  samLevelParityGap: () => 0,
  legendaryEnemyTargetPressure: () => 0,
  legendaryDefenseGap: () => 0.25,
  legendaryPortSurvivability: () => 1,
  foreignOceanPorts: () => economyForeignPorts,
});
assert.equal(economyStateBehavior.trainGoldBase("team", 3), 42_000);
assert.deepEqual(
  observedTrainGoldCalls,
  [["team", 3, sourcePlayerView]],
  "rail payout valuation uses the live Config.trainGold with the underlying PlayerView",
);
structureSandbox.UNIT.Train = "Train";
structureSandbox.UNIT.TradeShip = "Trade Ship";
structureSandbox.UNIT.City = "City";
structureSandbox.UNIT.Port = "Port";
structureSandbox.UNIT.Factory = "Factory";
const networkStation = (id, tile, level, underConstruction = false) => ({
  id: () => id,
  tile: () => tile,
  level: () => level,
  isUnderConstruction: () => underConstruction,
  isMarkedForDeletion: () => false,
  isActive: () => true,
  hasTrainStation: () => true,
});
const networkOwner = (smallId, teamId, unitsByType) => ({
  __src: { isLobbyCreator: () => false },
  id: () => smallId,
  smallID: () => smallId,
  teamId,
  isPlayer: () => true,
  isAlive: () => true,
  hasEmbargoAgainst: () => false,
  isOnSameTeam: (other) => other?.teamId === teamId,
  isAlliedWith: () => false,
  units: (...types) => types.flatMap((type) => unitsByType[type] ?? []),
});
const networkCity = networkStation(30, 10, 1);
const networkCompleteFactory = networkStation(31, 20, 2);
const networkPendingFactory = networkStation(32, 21, 1, true);
const networkActor = networkOwner(30, 7, { City: [networkCity] });
const networkTeammate = networkOwner(31, 7, {
  Factory: [networkCompleteFactory, networkPendingFactory],
});
const networkEconomyBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
Object.assign(networkEconomyBehavior, {
  player: networkActor,
  game: {
    players: () => [networkActor, networkTeammate],
    units: () => [],
    sharedWaterComponents: () => new Set(),
    euclideanDistSquared: (left, right) => (left - right) ** 2,
    config: () => ({
      trainStationMaxRange: () => 10,
      unitInfo: () => ({ constructionDuration: 100 }),
      trainSpawnRate: () => 100,
      tradeShipSpawnRate: () => 100,
      trainGold: () => 50_000n,
    }),
  },
  buildReachableStations: (types, owners) =>
    owners.flatMap((owner) =>
      owner.units(...types).map((unit) => ({ tile: unit.tile(), cluster: "rail" })),
    ),
  portWaterComponents: () => new Set(),
  legendaryPortSeedWindowOpen: () => false,
  legendaryPortCandidateTilesForEconomy: () => [],
  legendaryAllianceTicksRemaining: () => Infinity,
  trainGoldBase: () => 50_000,
});
const inProgressNetworkInputs = networkEconomyBehavior.legendaryEconomyInputs({
  trainCount: 0,
  tradeShipCount: 0,
  hasTradePartner: false,
  hasCompletedTradePartner: false,
  connectedStops: 1,
});
const pendingRailSource = inProgressNetworkInputs.trainSources[0];
assert.equal(
  pendingRailSource.factoryCount,
  2,
  "the spawn denominator counts completed Factory levels only (engine unitCount)",
);
assert.deepEqual(Array.from(pendingRailSource.productiveFactoryLevels), [2]);
assert.deepEqual(Array.from(pendingRailSource.pendingFactoryLevels), [1]);
assert.equal(pendingRailSource.factoryConstructionDelayTicks, 100);
assert.equal(inProgressNetworkInputs.teamFactoryLevels, 3);
assert.equal(pendingRailSource.paidStopsAfterBuild, 2);
const teammatePaidCity = networkStation(33, 30, 1);
const makePaidStopNetwork = (teammateUnits) => {
  const actor = networkOwner(40, 7, {});
  const teammate = networkOwner(41, 7, teammateUnits);
  const config = {
    trainStationMaxRange: () => 10,
    unitInfo: () => ({ constructionDuration: 100 }),
    trainSpawnRate: () => 100,
    tradeShipSpawnRate: () => 100,
    trainGold: () => 50_000n,
  };
  const behavior = Object.create(structureSandbox.StructureBehavior.prototype);
  Object.assign(behavior, {
    player: actor,
    game: {
      players: () => [actor, teammate],
      units: () => [],
      sharedWaterComponents: () => new Set(),
      euclideanDistSquared: (left, right) => (left - right) ** 2,
      config: () => config,
    },
    buildReachableStations: (types, owners) =>
      owners.flatMap((owner) =>
        owner.units(...types).map((unit) => ({ tile: unit.tile(), cluster: "rail" })),
      ),
    portWaterComponents: () => new Set(),
    legendaryPortSeedWindowOpen: () => false,
    legendaryPortCandidateTilesForEconomy: () => [],
    legendaryAllianceTicksRemaining: () => Infinity,
    trainGoldBase: () => 50_000,
    ownedLevels: () => 0,
  });
  return { behavior, config };
};
const paidStopNetwork = makePaidStopNetwork({ City: [teammatePaidCity] });
const paidStopInputs = paidStopNetwork.behavior.legendaryEconomyInputs({
  trainCount: 0,
  tradeShipCount: 0,
  hasTradePartner: false,
  hasCompletedTradePartner: false,
  connectedStops: 1,
});
const paidStopFactoryValue = plannerSandbox.legendaryEconomyNetGold("Factory", {
  cost: 10_000,
  horizonTicks: 10_000,
  inputs: paidStopInputs,
  config: paidStopNetwork.config,
});
assert.equal(paidStopInputs.factoryPaidStops, 1);
assert.ok(paidStopFactoryValue?.netTeamGold > 0);
assert.equal(
  plannerSandbox.rankLegendaryConstructionActions(
    [
      {
        type: "Factory",
        cost: 10_000n,
        netTeamGold: BigInt(Math.round(paidStopFactoryValue.netTeamGold)),
        capacity: 0,
      },
      { type: "City", cost: 10_000n, netTeamGold: 0n, capacity: 0 },
    ],
    { gold: 100_000n },
  )[0]?.type,
  "Factory",
  "a reachable teammate City makes a first Factory beat a nonbinding City",
);
const noPaidStopNetwork = makePaidStopNetwork({});
const noPaidStopInputs = noPaidStopNetwork.behavior.legendaryEconomyInputs({
  trainCount: 0,
  tradeShipCount: 0,
  hasTradePartner: false,
  hasCompletedTradePartner: false,
  connectedStops: 0,
});
assert.equal(noPaidStopInputs.factoryPaidStops, 0);
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("Factory", {
    cost: 10_000,
    horizonTicks: 10_000,
    inputs: noPaidStopInputs,
    config: noPaidStopNetwork.config,
  })?.refused,
  true,
  "removing every reachable paid stop makes the first Factory unprofitable",
);
const factoryRouteBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const factoryRouteCandidate = { t: 10 };
let factoryTradeDestinations = [];
Object.assign(factoryRouteBehavior, {
  game: {
    config: () => ({
      trainStationMinRange: () => 1,
      trainStationMaxRange: () => 10,
    }),
    euclideanDistSquared: (left, right) => (left - right) ** 2,
  },
  player: { units: () => [] },
  getOrBuildFactoryTradeDestinations: () => factoryTradeDestinations,
});
assert.deepEqual(
  Array.from(factoryRouteBehavior.novelFactoryTradeCandidates([factoryRouteCandidate])),
  [],
  "a first Factory is not a candidate without a reachable paid City/Port stop",
);
factoryTradeDestinations = [{ tile: 20, weight: 1 }];
assert.deepEqual(
  Array.from(factoryRouteBehavior.novelFactoryTradeCandidates([factoryRouteCandidate])),
  [factoryRouteCandidate],
  "a first Factory may use a reachable team/ally paid stop",
);
const waterPlayer = (smallId, teamId, ports = []) => ({
  id: () => smallId,
  smallID: () => smallId,
  teamId,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => "Nation",
  isOnSameTeam: (other) => teamId !== null && other.teamId === teamId,
  hasEmbargoAgainst: () => false,
  units: (type) => (type === "Port" ? ports : []),
});
const seedOwnerA = waterPlayer(1, 7);
const seedOwnerB = waterPlayer(2, 7);
const extraTeammate = waterPlayer(3, 7);
const landlockedSeedOwner = waterPlayer(0, 7);
const portNetworkBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
Object.assign(portNetworkBehavior, {
  game: {
    players: () => [seedOwnerA, seedOwnerB, extraTeammate, landlockedSeedOwner],
    sharedWaterComponents: (owner) => (owner?.smallID?.() === 0 ? null : new Set([-1])),
    forEachNeighbor: (tile, callback) => callback(tile + 1),
    isWater: () => true,
    isOcean: () => true,
  },
  player: seedOwnerA,
});
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  true,
  "the first selected teammate may seed a shared-water Port pair",
);
assert.equal(
  portNetworkBehavior.legendaryPortSeedPartner(),
  seedOwnerB,
  "the first seed owner values the deterministic second teammate",
);
assert.equal(
  portNetworkBehavior.legendaryPortSeedWindowOpen(),
  true,
  "a globally selected seed owner can open the initial Port-pair window",
);
{
  const originalSeedPlayerOrder = portNetworkBehavior.game.players;
  portNetworkBehavior.game.players = () => [extraTeammate, seedOwnerB, seedOwnerA];
  assert.equal(
    portNetworkBehavior.legendaryPortSeedPartner(),
    seedOwnerB,
    "the seed pair is chosen by owner identity, not players() enumeration order",
  );
  portNetworkBehavior.game.players = originalSeedPlayerOrder;
}
portNetworkBehavior.player = extraTeammate;
assert.equal(
  portNetworkBehavior.legendaryPortSeedWindowOpen(),
  false,
  "a third teammate cannot open another seed window on the same shared water",
);
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  false,
  "a third teammate cannot create a second initial seed pair on the same shared water",
);
assert.equal(
  portNetworkBehavior.legendaryPortSeedPartner(),
  null,
  "only the globally selected two owners can create the initial seed pair",
);
assert.deepEqual(
  Array.from(portNetworkBehavior.legendaryPortSeedOwnerIds(-1)),
  ["1", "2"],
  "seed owner selection excludes landlocked owners and is stable across builders sharing the water",
);
portNetworkBehavior.game.sharedWaterComponents = () => new Set();
portNetworkBehavior.player = seedOwnerA;
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  false,
  "no eligible shared-water partner means no pure-economy Port",
);
portNetworkBehavior.game.sharedWaterComponents = (owner) =>
  owner?.smallID?.() === 0 ? null : new Set([-1]);
let pendingSeedPortDeleted = false;
let pendingSeedPortInactive = false;
const pendingSeedPort = {
  tile: () => 20,
  isUnderConstruction: () => true,
  isMarkedForDeletion: () => pendingSeedPortDeleted,
  isActive: () => !pendingSeedPortInactive,
};
seedOwnerA.units = (type) => (type === "Port" ? [pendingSeedPort] : []);
const livePendingPortState = portNetworkBehavior.portOwnerStateOnWater(seedOwnerA, -1);
assert.equal(livePendingPortState.completed, false);
assert.equal(
  livePendingPortState.inProgress,
  true,
  "a live pending Port is recognized on its shared water",
);
portNetworkBehavior.player = seedOwnerB;
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  true,
  "the selected second owner may complete the in-progress seed pair",
);
pendingSeedPortDeleted = true;
const deletedPendingPortState = portNetworkBehavior.portOwnerStateOnWater(seedOwnerA, -1);
assert.equal(deletedPendingPortState.completed, false);
assert.equal(
  deletedPendingPortState.inProgress,
  false,
  "a pending Port marked for deletion is not a trade partner",
);
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  true,
  "the selected owner can start a fresh pair after the old pending Port is canceled",
);
pendingSeedPortDeleted = false;
pendingSeedPortInactive = true;
const inactivePendingPortState = portNetworkBehavior.portOwnerStateOnWater(seedOwnerA, -1);
assert.equal(inactivePendingPortState.completed, false);
assert.equal(
  inactivePendingPortState.inProgress,
  false,
  "an inactive pending Port is not a trade partner",
);
pendingSeedPortInactive = false;
Object.assign(portNetworkBehavior, {
  ownedLevels: () => 0,
  buildReachableStations: () => [],
  portWaterComponents: () => new Set([-1]),
  portTileHasOpenWaterAccess: () => true,
  legendaryPortSeedWindowOpen: () => true,
  legendaryPortCandidateTilesForEconomy: () => [10],
  legendaryPortSeedOwnerIds: () => ["1", "2"],
  legendaryPortRouteProfile: (_tile, _owner, destinations) =>
    destinations.length === 0
      ? null
      : {
          routes: [
            {
              weight: 1,
              distance: 2,
              teamGoldPerArrival: 1,
              postAllianceGoldPerArrival: 1,
              allianceTicksRemaining: Infinity,
            },
          ],
          teamGoldPerArrival: 1,
          routeDelayTicks: 2,
        },
  legendaryAllianceTicksRemaining: () => Infinity,
  trainGoldBase: () => 100,
  game: {
    ...portNetworkBehavior.game,
    config: () => ({
      trainStationMaxRange: () => 10,
      unitInfo: () => ({ constructionDuration: 100 }),
      trainSpawnRate: () => 100,
      tradeShipSpawnRate: () => 100,
      trainGold: () => 50_000n,
    }),
  },
});
const seedEconomyInputs = () =>
  portNetworkBehavior.legendaryEconomyInputs({
    trainCount: 0,
    tradeShipCount: 0,
    hasTradePartner: false,
    hasCompletedTradePartner: false,
    connectedStops: 0,
  });
const liveSeedEconomyInputs = seedEconomyInputs();
assert.equal(liveSeedEconomyInputs.portSeedSources.length, 2);
assert.equal(liveSeedEconomyInputs.pendingPartnerConstructionTicks, 100);
pendingSeedPortDeleted = true;
const deletedSeedEconomyInputs = seedEconomyInputs();
assert.equal(
  deletedSeedEconomyInputs.portSeedSources.length,
  0,
  "a Port marked for deletion cannot provide seed-pair income",
);
assert.equal(deletedSeedEconomyInputs.pendingPartnerConstructionTicks, 0);
pendingSeedPortDeleted = false;
pendingSeedPortInactive = true;
const inactiveSeedEconomyInputs = seedEconomyInputs();
assert.equal(
  inactiveSeedEconomyInputs.portSeedSources.length,
  0,
  "an inactive pending Port cannot provide seed-pair income",
);
assert.equal(inactiveSeedEconomyInputs.pendingPartnerConstructionTicks, 0);
pendingSeedPortInactive = false;
const inboundSourcePort = {
  id: () => 41,
  tile: () => 100,
  level: () => 1,
  isUnderConstruction: () => false,
  isMarkedForDeletion: () => false,
  isActive: () => true,
};
const inboundExistingPort = {
  id: () => 42,
  tile: () => 10,
  level: () => 1,
  isUnderConstruction: () => false,
  isMarkedForDeletion: () => false,
  isActive: () => true,
};
const inboundCandidatePort = {
  id: () => 43,
  tile: () => 20,
  level: () => 1,
  isUnderConstruction: () => false,
  isMarkedForDeletion: () => false,
  isActive: () => true,
};
const inboundActor = waterPlayer(10, 7, [inboundCandidatePort]);
const inboundSourceOwner = waterPlayer(11, 7, [inboundSourcePort]);
const inboundExistingOwner = waterPlayer(12, 8, [inboundExistingPort]);
const inboundWater = new Set([1, 2, 3]);
const inboundNeighbors = new Map([
  [100, [1]],
  [1, [100, 2]],
  [2, [1, 3, 10]],
  [10, [2]],
  [3, [2, 20]],
  [20, [3]],
]);
const inboundBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
Object.assign(inboundBehavior, {
  player: inboundActor,
  game: {
    players: () => [inboundSourceOwner, inboundExistingOwner],
    ticks: () => 0,
    neighbors: (tile) => inboundNeighbors.get(tile) ?? [],
    isWater: (tile) => inboundWater.has(tile),
    manhattanDist: (left, right) => Math.abs(left - right),
    config: () => ({
      tradeShipGold: (distance) => BigInt(distance * 10_000),
      tradeShipShortRangeDebuff: () => 0,
      proximityBonusPortsNb: () => 0,
      unitInfo: () => ({ constructionDuration: 100 }),
    }),
  },
  portWaterComponents: () => new Set([-1]),
  legendaryAllianceTicksRemaining: () => Infinity,
});
const inboundBuildSources = inboundBehavior.legendaryPortInboundSources(20);
assert.equal(inboundBuildSources.length, 2);
assert.ok(
  inboundBuildSources[0].afterProfile.teamGoldPerArrival >
    inboundBuildSources[0].beforeProfile.teamGoldPerArrival,
  "a new same-team destination adds its incoming payout and changes the source's route mix",
);
const inboundUpgradeSources = inboundBehavior.legendaryPortInboundSources(
  20,
  inboundCandidatePort,
  2,
);
assert.ok(
  inboundUpgradeSources[0].afterProfile.teamGoldPerArrival >
    inboundUpgradeSources[0].beforeProfile.teamGoldPerArrival,
  "a Port upgrade increases its inbound route weight for existing sources",
);
portNetworkBehavior.player = extraTeammate;
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  false,
  "a third owner cannot create another seed pair while the selected pair is still pending",
);
seedOwnerA.units = (type) =>
  type === "Port" ? [{ tile: () => 20, isUnderConstruction: () => false }] : [];
assert.equal(
  portNetworkBehavior.portCandidateHasTradeRoute(10),
  true,
  "a completed different-owner Port opens the route to additional teammates",
);
const routeAlly = {
  id: () => 22,
  smallID: () => 22,
  isOnSameTeam: () => false,
  isAlliedWith: () => false,
  hasEmbargoAgainst: () => false,
};
const routeActor = {
  id: () => 21,
  smallID: () => 21,
  isOnSameTeam: () => false,
  isAlliedWith: (other) => other === routeAlly,
  isFriendly: (other) => other === routeAlly,
  hasEmbargoAgainst: () => false,
  alliances: () => [{ other: 22, expiresAt: 60 }],
};
const portRouteProfileBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
Object.assign(portRouteProfileBehavior, {
  player: routeActor,
  game: {
    ticks: () => 10,
    config: () => ({
      tradeShipGold: (distance) => BigInt(distance * 100),
      tradeShipShortRangeDebuff: () => 0,
      proximityBonusPortsNb: () => 0,
    }),
    neighbors: (tile) => ({ 0: [1], 1: [0, 2], 2: [1, 3], 3: [2] })[tile] ?? [],
    isWater: (tile) => tile === 1 || tile === 2,
    isOcean: () => false,
    getWaterComponent: () => 7,
    forEachNeighbor: (tile, callback) =>
      (({ 0: [1], 1: [0, 2], 2: [1, 3], 3: [2] })[tile] ?? []).forEach(callback),
    manhattanDist: (left, right) => Math.abs(left - right),
  },
});
const allyPortProfile = portRouteProfileBehavior.legendaryPortRouteProfile(0, routeActor, [
  {
    owner: routeAlly,
    unit: { tile: () => 3, level: () => 2, isUnderConstruction: () => false },
  },
]);
assert.equal(allyPortProfile.routes[0].distance, 3);
assert.equal(allyPortProfile.routes[0].teamGoldPerArrival, 300);
assert.equal(
  allyPortProfile.routes[0].postAllianceGoldPerArrival,
  300,
  "trade keeps paying both endpoint owners after an alliance expires (canTrade is embargo-only)",
);
assert.equal(allyPortProfile.routes[0].weight, 4);
assert.equal(
  allyPortProfile.routes[0].postAllianceWeight,
  2,
  "a non-team alliance stops adding the friendly destination weight after it expires",
);
assert.equal(allyPortProfile.routes[0].allianceTicksRemaining, 50);
portRouteProfileBehavior.game.getWaterComponent = (tile) => (tile === 2 ? 8 : 7);
assert.equal(
  portRouteProfileBehavior.legendaryPortRouteProfile(0, routeActor, [
    {
      owner: routeAlly,
      unit: { tile: () => 3, level: () => 2, isUnderConstruction: () => false },
    },
  ]),
  null,
  "a closer Port on a different water component cannot create trade income",
);
const noRouteEconomyState = economyStateBehavior.legendaryConstructionState({
  cityCount: 4,
  hasCoastalTiles: true,
});
assert.equal(noRouteEconomyState.trainSpawnMultiplier, 0.25);
assert.equal(noRouteEconomyState.tradeShipSpawnMultiplier, 0.25);
assert.equal(noRouteEconomyState.hasTradePartner, false);
assert.equal(noRouteEconomyState.tradeNeed, 0.25);
assert.deepEqual(
  observedStateFactoryCounts,
  [
    [7, 0],
    [7, 50],
  ],
  "train saturation passes the level-sum Factory denominator (unitCount semantics) separately from per-station rolls",
);
economyUnits.Train = [];
economyUnits["Trade Ship"] = [];
economyForeignPorts = [{ tile: {} }];
const connectedEconomyState = economyStateBehavior.legendaryConstructionState({
  cityCount: 4,
  hasCoastalTiles: true,
});
assert.equal(connectedEconomyState.trainSpawnMultiplier, 1);
assert.equal(connectedEconomyState.tradeShipSpawnMultiplier, 1);
assert.equal(connectedEconomyState.hasTradePartner, true);
assert.equal(connectedEconomyState.tradeNeed, 1.3);
assert.deepEqual(observedStateFactoryCounts.slice(2), [
  [7, 0],
  [7, 0],
]);
const capPressureBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let currentTroops = 95;
Object.assign(capPressureBehavior, {
  game: { config: () => ({ maxTroops: () => 100 }) },
  player: { troops: () => currentTroops },
  safeMaxTroops: () => 100,
  legendaryThinDensityPressure: () => false,
});
assert.equal(
  capPressureBehavior.computeTroopCapPressure(),
  true,
  "a builder at 95% of troop capacity gets City cap-relief value",
);
currentTroops = 35;
assert.equal(
  capPressureBehavior.computeTroopCapPressure(),
  false,
  "a builder at 35% of troop capacity gets no City cap-relief value",
);
currentTroops = 89;
assert.equal(
  capPressureBehavior.computeTroopCapPressure(),
  false,
  "89% stays below the 0.9 troop-cap pressure boundary",
);
currentTroops = 90;
assert.equal(
  capPressureBehavior.computeTroopCapPressure(),
  true,
  "exactly 90% crosses the inclusive troop-cap pressure boundary",
);
currentTroops = 35;
capPressureBehavior.legendaryThinDensityPressure = () => true;
assert.equal(
  capPressureBehavior.computeTroopCapPressure(),
  true,
  "the separate Legendary low-density defense signal remains available",
);
assert.equal(
  capPressureBehavior.computeTroopCapPressure(false),
  false,
  "low troop density does not masquerade as troop-cap value",
);
let rankedCityCapacity = null;
const capPressureSelector = Object.create(structureSandbox.StructureBehavior.prototype);
structureSandbox.Difficulty.Legendary = "Legendary";
structureSandbox.isLegendaryDifficulty = () => true;
Object.assign(capPressureSelector, {
  game: { config: () => ({ maxTroops: () => 100 }) },
  player: { troops: () => currentTroops },
  safeMaxTroops: () => 100,
  legendaryThinDensityPressure: () => true,
  legendaryConstructionState: () => ({
    economyInputs: {},
    economyHorizonTicks: 1_000,
    tradeNeed: 0,
    railNeed: 0,
    missileThreat: { critical: false, score: 0 },
    samLevelParityGap: 0,
    defenseGap: 0,
    targetPressure: 0,
    siloParityGap: 0,
  }),
  probeLegendaryThroughputUpgradeCandidates: async () => [],
  addLegendaryCityCandidates: (_context, { capPressure }) => {
    rankedCityCapacity = capPressure ? 1 : 0;
  },
  addLegendaryRatioCandidate: () => {},
  legendarySamCandidateSafety: () => 0,
});
const capPressureContext = {
  config: { isUnitDisabled: () => false },
  citiesDisabled: false,
  cityCount: 4,
  hasCoastalTiles: false,
  hasOceanPortTiles: false,
  missileSilosEnabled: false,
  nukesEnabled: true,
};
await capPressureSelector.legendaryConstructionCandidates(capPressureContext);
assert.equal(rankedCityCapacity, 0, "35% capacity receives no City capacity priority");
currentTroops = 95;
await capPressureSelector.legendaryConstructionCandidates(capPressureContext);
assert.equal(rankedCityCapacity, 1, "95% capacity receives City capacity priority");
structureSandbox.isLegendaryDifficulty = () => false;
const routeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
for (const unavailable of [null, { canUpgrade: false, cost: 125_000n }]) {
  const upgradeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
  const city = { id: () => 17, level: () => 1 };
  let probes = 0;
  upgradeBehavior.player = { units: () => [city] };
  upgradeBehavior._legendaryCityUpgradeCostCache = new Map();
  upgradeBehavior.buildableForUnits = async () => {
    probes++;
    return [probes === 1 ? unavailable : { canUpgrade: 17, cost: 125_000n }];
  };
  assert.equal(await upgradeBehavior.probeLegendaryCityUpgradeCandidate(), null);
  const recovered = await upgradeBehavior.probeLegendaryCityUpgradeCandidate();
  assert.equal(recovered?.structureId, 17, "an unavailable upgrade must be reprobed");
  assert.equal(recovered?.cost, 125_000n);
  await upgradeBehavior.probeLegendaryCityUpgradeCandidate();
  assert.equal(probes, 2, "a confirmed price remains cached at the same city level");
}
const changingPriceBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let priceTick = 100;
changingPriceBehavior.game = { ticks: () => priceTick };
changingPriceBehavior.player = { units: () => [{ id: () => 18, level: () => 1 }] };
changingPriceBehavior._legendaryCityUpgradeCostCache = new Map();
changingPriceBehavior.buildableForUnits = async () => [
  {
    canUpgrade: 18,
    cost: priceTick === 100 ? 250_000n : 500_000n,
  },
];
assert.equal((await changingPriceBehavior.probeLegendaryCityUpgradeCandidate()).cost, 250_000n);
priceTick++;
assert.equal(
  (await changingPriceBehavior.probeLegendaryCityUpgradeCandidate()).cost,
  500_000n,
  "another city build can change the price without changing this city's level",
);
const throughputUpgradeProbe = Object.create(structureSandbox.StructureBehavior.prototype);
const upgradeFactory = { id: () => 77, level: () => 1, isUnderConstruction: () => false };
const upgradePort = { id: () => 88, level: () => 2, isUnderConstruction: () => false };
let throughputBuildableCalls = 0;
Object.assign(throughputUpgradeProbe, {
  game: { ticks: () => 200, config: () => roiConfig },
  player: {
    units: (type) => {
      if (type === "Factory") return [upgradeFactory];
      if (type === "Port") return [upgradePort];
      return [];
    },
  },
  _legendaryThroughputUpgradeProbeTick: null,
  _legendaryThroughputUpgradeProbe: null,
  buildableForUnits: async (units, _type) => {
    throughputBuildableCalls++;
    return units.map((unit) => ({ canUpgrade: unit.id(), cost: 40_000n }));
  },
});
const throughputUpgradeState = {
  economyHorizonTicks: 1_000,
  economyInputs: {
    trainCount: 0,
    ownFactoryCount: 2,
    ownProductiveFactoryLevels: [1],
    factoryPaidStops: 1,
    factoryTeamGoldPerTrain: 50_000,
    factoryUpgradeTargets: [
      {
        structureId: 77,
        factoryCount: 2,
        productiveFactoryLevels: [1],
        upgradeFactoryIndex: 0,
        teamGoldPerTrain: 50_000,
      },
    ],
    hasCompletedTradePartner: true,
    portTradeGoldPerArrival: 120_000,
    portTeamPayoutFactor: 2,
    portEligibleTicks: Infinity,
    tradeShipCount: 0,
    portUpgradeTargetIds: [88],
    portUpgradeProfiles: {
      88: {
        routes: [
          {
            weight: 1,
            distance: 0,
            teamGoldPerArrival: 120_000,
            postAllianceGoldPerArrival: 120_000,
            allianceTicksRemaining: Infinity,
          },
        ],
      },
    },
  },
};
const throughputUpgradeCandidates =
  await throughputUpgradeProbe.probeLegendaryThroughputUpgradeCandidates(throughputUpgradeState);
assert.deepEqual(
  Array.from(throughputUpgradeCandidates, ({ type, action }) => [type, action]),
  [
    ["Factory", "upgrade"],
    ["Port", "upgrade"],
  ],
  "only paid-route Factory and partner-route Port next-level upgrades enter Legendary ranking",
);
const actualLevelPortCandidate = throughputUpgradeCandidates.find(({ type }) => type === "Port");
const expectedLevelTwoPortUpgrade = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 40_000,
  horizonTicks: throughputUpgradeState.economyHorizonTicks,
  inputs: {
    ...throughputUpgradeState.economyInputs,
    upgradeAction: true,
    upgradeStructureId: 88,
    portUpgradeLevel: 2,
    portUpgradeProfile: throughputUpgradeState.economyInputs.portUpgradeProfiles["88"],
  },
  config: roiConfig,
});
assert.equal(
  actualLevelPortCandidate?.netTeamGold,
  BigInt(Math.round(expectedLevelTwoPortUpgrade.netTeamGold)),
  "Port upgrade ranking prices the selected Port's actual level rather than assuming level one",
);
await throughputUpgradeProbe.probeLegendaryThroughputUpgradeCandidates(throughputUpgradeState);
assert.equal(
  throughputBuildableCalls,
  2,
  "throughput upgrade prices are probed once per structure decision tick",
);
let routeDistanceReads = 0;
let capacityUpgradeGold = 1_000_000n;
let capacityUpgradeSends = 0;
const capacitySandbox = {
  ...structureSandbox,
  legendaryBigInt: plannerSandbox.legendaryBigInt,
  UNIT: { City: "City", Port: "Port", Factory: "Factory", MissileSilo: "MissileSilo" },
  state: { settings: { winFixes: true }, stats: { builds: 0 } },
  tr: (key) => key,
  setLastAction: () => {},
  sendAutoBotBuildOrUpgrade: () => {
    capacityUpgradeSends++;
    return true;
  },
};
capacitySandbox.globalThis = capacitySandbox;
executeClassicScript(
  `${structureSource}\nglobalThis.StructureBehavior = StructureBehavior;`,
  capacitySandbox,
);
capacitySandbox.isLegendaryDifficulty = () => true;
const liveReserveBehavior = Object.create(capacitySandbox.StructureBehavior.prototype);
let liveReserveReads = 0;
let liveReserveBuilds = 0;
Object.assign(liveReserveBehavior, {
  structureSpawnEligible: () => true,
  player: { units: () => [] },
  hasStructureUnderConstruction: () => false,
  constructionCostForOptions: () => 300n,
  availableGoldAfterReserve: () => (liveReserveReads++ === 0 ? 500n : 300n),
  structureSpawnBuildable: async () => ({ canBuild: true, cost: 350n }),
  emitStructureBuildable: () => {
    liveReserveBuilds++;
    return true;
  },
});
assert.equal(
  await liveReserveBehavior.maybeSpawnStructure(capacitySandbox.UNIT.City),
  false,
  "the live buildable cost must still fit the builder's reserve after async placement probing",
);
assert.equal(liveReserveBuilds, 0, "a live unaffordable economy build is not emitted");
const capacityUpgrade = Object.create(capacitySandbox.StructureBehavior.prototype);
const capacityCity = { id: () => 19, level: () => 1 };
Object.assign(capacityUpgrade, {
  game: { ticks: () => 100, config: () => ({ maxTroops: () => 100 }) },
  player: {
    units: () => [capacityCity],
    gold: () => capacityUpgradeGold,
    troops: () => 95,
  },
  safeMaxTroops: () => 100,
  legendaryAtomWarChest: () => 750_000n,
  _legendaryCityUpgradeCostCache: new Map(),
  buildableForUnits: async () => [{ canUpgrade: 19, cost: 500_000n }],
});
const capacityCandidate = { upgradeStructureId: 19, cost: 500_000n };
assert.equal(
  await capacityUpgrade.maybeUpgradeLegendaryCityCapacity(capacityCandidate),
  false,
  "a city upgrade must not consume the next Atom's reserved gold",
);
assert.equal(capacityUpgradeSends, 0);
capacityUpgradeGold = 1_250_000n;
assert.equal(await capacityUpgrade.maybeUpgradeLegendaryCityCapacity(capacityCandidate), true);
assert.equal(capacityUpgradeSends, 1, "exactly the unreserved surplus can fund an upgrade");
capacityUpgradeGold = 1_000_000n;
assert.equal(
  capacityUpgrade.genericStructureUpgradeAllowed({ bu: { cost: 500_000n } }, "City"),
  false,
  "the generic city upgrade fallback must preserve the same Atom reserve",
);
assert.equal(
  capacityUpgrade.genericStructureUpgradeAllowed({ bu: { cost: 500_000n } }, "Port"),
  true,
  "the documented Port exemption remains available",
);
let throughputRouteActive = false;
let throughputAvailableGold = 100_000n;
const liveThroughputFactory = {
  id: () => 79,
  level: () => 1,
  isUnderConstruction: () => false,
};
const throughputActuation = Object.create(capacitySandbox.StructureBehavior.prototype);
Object.assign(throughputActuation, {
  game: { ticks: () => 101, config: () => roiConfig },
  player: {
    units: (type) => (type === "Factory" ? [liveThroughputFactory] : []),
    gold: () => throughputAvailableGold,
  },
  hasAnyShoreBorderTile: () => false,
  legendaryConstructionState: () => ({
    economyHorizonTicks: 1_000,
    economyInputs: {
      trainCount: 0,
      ownFactoryCount: 2,
      ownProductiveFactoryLevels: [1],
      factoryPaidStops: 1,
      factoryTeamGoldPerTrain: 50_000,
      factoryUpgradeTargets: throughputRouteActive
        ? [
            {
              structureId: 79,
              factoryCount: 2,
              productiveFactoryLevels: [1],
              upgradeFactoryIndex: 0,
              teamGoldPerTrain: 50_000,
            },
          ]
        : [],
      portUpgradeTargetIds: [],
    },
  }),
  buildableForUnits: async () => [{ canUpgrade: 79, cost: 25_000n }],
  availableGoldAfterReserve: () => throughputAvailableGold,
});
const sendsBeforeThroughputUpgrade = capacityUpgradeSends;
assert.equal(
  await throughputActuation.maybeUpgradeLegendaryThroughput({
    type: "Factory",
    upgradeStructureId: 79,
    upgradeCost: 25_000n,
  }),
  false,
  "the Factory upgrade is canceled if its paid stop disappears before actuation",
);
throughputRouteActive = true;
throughputAvailableGold = 24_999n;
assert.equal(
  await throughputActuation.maybeUpgradeLegendaryThroughput({
    type: "Factory",
    upgradeStructureId: 79,
    upgradeCost: 25_000n,
  }),
  false,
  "a teammate treasury cannot cover a Factory upgrade for the builder",
);
throughputAvailableGold = 25_000n;
const originalEconomyEvaluator = capacitySandbox.legendaryEconomyNetGold;
let factoryUpgradeActuationInputs = null;
capacitySandbox.legendaryEconomyNetGold = (type, options) => {
  if (type === "Factory") factoryUpgradeActuationInputs = options.inputs;
  return originalEconomyEvaluator(type, options);
};
assert.equal(
  await throughputActuation.maybeUpgradeLegendaryThroughput({
    type: "Factory",
    upgradeStructureId: 79,
    upgradeCost: 25_000n,
  }),
  true,
  "a still-productive, live-quoted Factory upgrade is emitted once the builder can afford it",
);
assert.equal(capacityUpgradeSends, sendsBeforeThroughputUpgrade + 1);
assert.equal(
  factoryUpgradeActuationInputs?.factoryUpgrade?.structureId,
  79,
  "Factory upgrade actuation re-evaluates the same paid-route upgrade profile",
);
assert.equal(
  factoryUpgradeActuationInputs?.portUpgradeProfile,
  undefined,
  "Factory upgrade actuation never substitutes a Port profile",
);
capacitySandbox.legendaryEconomyNetGold = originalEconomyEvaluator;
capacitySandbox.isLegendaryDifficulty = () => true;
let legacyEconomicUpgradeAttempts = 0;
const economicSpawnOrder = Object.create(capacitySandbox.StructureBehavior.prototype);
Object.assign(economicSpawnOrder, {
  structureSpawnEligible: () => true,
  player: { units: () => [] },
  economicStructureSpawnPending: () => false,
  structureUpgradeBeforeSpawn: async () => {
    legacyEconomicUpgradeAttempts++;
    return null;
  },
  constructionCostForOptions: () => 1n,
  availableGoldAfterReserve: () => 1n,
  structureSpawnBuildable: async () => false,
});
capacitySandbox.isLegendaryDifficulty = () => false;
assert.equal(
  await economicSpawnOrder.maybeSpawnStructure("Factory"),
  false,
  "the lower-difficulty build falls through after checking its legacy upgrade priority",
);
assert.equal(legacyEconomicUpgradeAttempts, 1);
capacitySandbox.isLegendaryDifficulty = () => true;
assert.equal(
  await economicSpawnOrder.maybeSpawnStructure("Factory"),
  false,
  "Legendary keeps productive economic structures on the adaptive construction path",
);
assert.equal(legacyEconomicUpgradeAttempts, 1);
let genericEconomicUpgradeProbes = 0;
const genericEconomicUpgrade = Object.create(capacitySandbox.StructureBehavior.prototype);
Object.assign(genericEconomicUpgrade, {
  getTotalStructureDensity: () => 1_000_000,
  findBestStructureToUpgrade: async () => {
    genericEconomicUpgradeProbes++;
    return null;
  },
});
const genericFactory = { type: () => "Factory" };
capacitySandbox.isLegendaryDifficulty = () => false;
await genericEconomicUpgrade.maybeUpgradeStructure([genericFactory]);
assert.equal(genericEconomicUpgradeProbes, 1, "lower difficulties retain native upgrade priority");
capacitySandbox.isLegendaryDifficulty = () => true;
await genericEconomicUpgrade.maybeUpgradeStructure([genericFactory]);
assert.equal(
  genericEconomicUpgradeProbes,
  1,
  "Legendary still requires an exhausted placement proof before generic economic upgrades",
);
executeClassicScript(read("engine/ingame/shared-utils.js"), capacitySandbox);
const reserveBehavior = Object.create(capacitySandbox.StructureBehavior.prototype);
let reserveTargets = [];
Object.assign(reserveBehavior, {
  player: {
    smallID: () => 1,
    gold: () => 1_000_000n,
    units: () => [{ isUnderConstruction: () => false }],
    isOnSameTeam: () => false,
  },
  game: {
    config: () => ({ isUnitDisabled: () => false }),
    players: () => reserveTargets,
  },
  ownSamCapacity: () => 1,
  safeConstructionCost: () => 750_000n,
});
for (const launched of [false, true]) {
  capacitySandbox.state.nukeFirstLaunchDone = launched;
  assert.equal(
    reserveBehavior.availableGoldAfterReserve("City"),
    1_000_000n,
    "no target releases the Atom reserve even before the first launch",
  );
}
reserveTargets = [
  {
    isPlayer: () => true,
    isAlive: () => true,
    smallID: () => 2,
    units: (type) => (type === "City" ? [{}] : []),
  },
];
assert.equal(reserveBehavior.availableGoldAfterReserve("City"), 250_000n);

routeBehavior.game = {
  x: (tile) => tile,
  y: () => 0,
  height: () => 1_000,
  ref: (x) => Math.floor(x),
  config: () => ({
    defaultSamMissileSpeed: () => 2,
    defaultNukeTargetableRange: () => 5,
    defaultNukeSpeed: () => 10,
  }),
  manhattanDist: (left, right) => Math.abs(left - right),
  euclideanDistSquared: (left, right) => {
    routeDistanceReads++;
    return (left - right) ** 2;
  },
};
structureSandbox.UNIT.HydrogenBomb = "HydrogenBomb";
const atomClaimScore = routeBehavior.legendarySamTargetClaimScore(
  { tile: 50 },
  { targetTile: 55, weapon: "AtomBomb", impactTick: 20, launchOffset: 0 },
);
assert.equal(atomClaimScore, 203000);
assert.equal(
  routeBehavior.legendarySamTargetClaimScore(
    { tile: 50 },
    { targetTile: 55, weapon: "HydrogenBomb", impactTick: 20, launchOffset: 0 },
  ) - atomClaimScore,
  70001,
  "Legendary reproduces the engine's Hydrogen target-priority bonus",
);
const claimOptionBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
claimOptionBehavior.game = routeBehavior.game;
claimOptionBehavior.legendaryMissileRouteCoverageIndexes = () => [0];
claimOptionBehavior.legendarySamInterceptionOpportunities = () => ({
  fireTicks: [0],
  interceptionTicks: [1],
});
const scoredRouteOptions = claimOptionBehavior.legendaryMissileRouteSamOptions(
  [{ tile: 50, level: 1 }],
  {
    coverageRoute: null,
    targetTile: 55,
    weapon: "AtomBomb",
    impactTick: 20,
    launchOffset: 0,
  },
);
assert.equal(
  scoredRouteOptions.samOptions[0].claimScore,
  atomClaimScore,
  "every live route option carries the same per-SAM target score used by the engine-order validator",
);
const routePath = Array.from({ length: 10 }, (_, index) => index);
const routeTargetableIndexes = routePath.map((_, index) => index);
const routeBounds = routeBehavior.legendaryTrajectoryTargetableBounds(
  routePath,
  routeTargetableIndexes,
);
assert.deepEqual({ ...routeBounds }, { minX: 0, maxX: 9, minY: 0, maxY: 0 });
const route = {
  path: routePath,
  targetableIndexes: routeTargetableIndexes,
  targetableBounds: routeBounds,
  launchOffset: 0,
  impactTick: 9,
};
assert.equal(
  routeBehavior.legendarySamRouteHasIntercept(1000, 1, route, 0, { samTile: 1000, range: 5 }),
  false,
);
assert.equal(routeDistanceReads, 0, "SAM bounding boxes skip distance reads for remote routes");
assert.equal(
  routeBehavior.legendarySamRouteHasIntercept(5, 1, route, 0, { samTile: 5, range: 1 }),
  true,
  "SAM route short-circuit still accepts a reachable intercept",
);
const terminalFallbackRoute = {
  path: [0, 10, 20],
  targetableIndexes: [1, 2],
  launchOffset: 0,
  impactTick: 2,
};
assert.deepEqual(
  Array.from(
    routeBehavior.legendarySamInterceptionOpportunities({ tile: 10 }, [2], terminalFallbackRoute)
      .fireTicks,
  ),
  [1],
  "a SAM in range of a targetable terminal explosion can fire at the penultimate route tile",
);
const flightLimitedPath = [0, 1, 2, 3, 4, 5];
const flightLimitedRoute = {
  path: flightLimitedPath,
  targetableIndexes: [4],
  targetableBounds: routeBehavior.legendaryTrajectoryTargetableBounds(flightLimitedPath, [4]),
  launchOffset: 0,
  impactTick: 5,
};
assert.equal(
  routeBehavior.legendarySamRouteHasIntercept(20, 1, flightLimitedRoute, 0, {
    samTile: 20,
    range: 17,
  }),
  false,
  "route protection rejects geometric coverage when the interceptor cannot arrive in time",
);
let targetEntryBuilds = 0;
routeBehavior.legendaryMissileTargetEntry = (target) => {
  targetEntryBuilds++;
  return {
    target,
    tile: target,
    exposedValue: 1,
    exposedStructures: 1,
    exposure: 1,
  };
};
const targetEntryCache = new Map();
const targetStructures = [1, 2, 3];
const targetStructureMap = targetStructures.map;
let targetStructureMapCalls = 0;
let targetEntryFilterCalls = 0;
targetStructures.map = (...args) => {
  targetStructureMapCalls++;
  const mapped = targetStructureMap.apply(targetStructures, args);
  const originalFilter = mapped.filter;
  mapped.filter = (...filterArgs) => {
    targetEntryFilterCalls++;
    return originalFilter.apply(mapped, filterArgs);
  };
  return mapped;
};
const firstTargetEntries = routeBehavior.legendaryMissileTargetCandidates(
  targetStructures,
  [],
  10,
  3,
  { entryCache: targetEntryCache },
);
const secondTargetEntries = routeBehavior.legendaryMissileTargetCandidates(
  targetStructures,
  [],
  10,
  3,
  { entryCache: targetEntryCache },
);
assert.equal(targetEntryBuilds, targetStructures.length);
assert.equal(
  firstTargetEntries,
  secondTargetEntries,
  "missile target geometry is reused for repeated threats with the same radius",
);
delete targetStructures.map;
assert.equal(targetStructureMapCalls, 0);
assert.equal(targetEntryFilterCalls, 0);
const orderingEntries = Array.from({ length: 20 }, (_, index) => ({
  target: { id: index },
  tile: index,
  exposedValue: index,
  exposedStructures: 1,
  exposure: 1,
}));
const orderingValues = new Map(orderingEntries.map(({ target }, index) => [target, 19 - index]));
const orderingEntrySlice = orderingEntries.slice;
const orderingEntrySort = orderingEntries.sort;
let orderingEntrySliceCalls = 0;
let orderingEntrySortCalls = 0;
orderingEntries.slice = (...args) => {
  orderingEntrySliceCalls++;
  return orderingEntrySlice.apply(orderingEntries, args);
};
orderingEntries.sort = (...args) => {
  orderingEntrySortCalls++;
  return orderingEntrySort.apply(orderingEntries, args);
};
const orderingCache = new Map();
routeBehavior.legendaryMissileTargetCandidates([], [], 10, 1, {
  structureValues: orderingValues,
  entryCache: new Map([[100, orderingEntries]]),
  orderingCache,
});
assert.deepEqual(
  [...orderingCache.get(100).byExposure.map(({ target }) => target.id)],
  Array.from({ length: 16 }, (_, index) => 19 - index),
);
assert.deepEqual(
  [...orderingCache.get(100).byValue.map(({ target }) => target.id)],
  Array.from({ length: 16 }, (_, index) => index),
);
const orderedByExposure = orderingCache.get(100).byExposure;
const orderedByValue = orderingCache.get(100).byValue;
const orderedByExposureSlice = orderedByExposure.slice;
const orderedByValueSlice = orderedByValue.slice;
let orderingSelectionSliceCalls = 0;
orderedByExposure.slice = (...args) => {
  orderingSelectionSliceCalls++;
  return orderedByExposureSlice.apply(orderedByExposure, args);
};
orderedByValue.slice = (...args) => {
  orderingSelectionSliceCalls++;
  return orderedByValueSlice.apply(orderedByValue, args);
};
assert.equal(
  routeBehavior.legendarySelectMissileTargets(
    orderingEntries,
    orderedByExposure,
    orderedByValue,
    [],
    16,
  ).length,
  16,
);
assert.equal(orderingSelectionSliceCalls, 0);
delete orderedByExposure.slice;
delete orderedByValue.slice;
assert.equal(orderingEntrySliceCalls, 0);
assert.equal(orderingEntrySortCalls, 0);
delete orderingEntries.slice;
delete orderingEntries.sort;
let targetableIndexBuilds = 0;
let interceptionCoverageChecks = 0;
routeBehavior.legendaryNukeFlightPath = () => routePath;
routeBehavior.legendaryTrajectoryTargetableIndexes = () => {
  targetableIndexBuilds++;
  return routeTargetableIndexes;
};
routeBehavior.legendaryFriendlySamUnits = () => [{ id: () => "sam" }];
routeBehavior.legendarySamReadySlots = () => 1;
routeBehavior.legendarySamPathHasCoverageForRoute = () => {
  interceptionCoverageChecks++;
  return true;
};
assert.equal(
  routeBehavior.legendarySamInterceptionCapacity(0, 9),
  1,
  "SAM capacity still counts one ready interceptor on a covered route",
);
assert.equal(targetableIndexBuilds, 1);
assert.equal(interceptionCoverageChecks, 1);

const sourceSilo = { tile: () => 11 };
const fallbackSilo = { tile: () => 12 };
const sourceProfiles = [{ availableTicks: [0, 90] }, { availableTicks: [0] }];
const sourceRoute = {
  silo: sourceSilo,
  samOptions: [
    { samIndex: 0, interceptTicks: [1] },
    { samIndex: 1, interceptTicks: [2] },
  ],
};
assert.equal(
  routeBehavior.legendarySalvoRouteInterceptionCapacity(sourceRoute, sourceProfiles),
  2,
  "salvo routes reuse ready SAM slots already represented by their options",
);
let sourceFallbackCalls = 0;
let sourceFallbackProfiles;
routeBehavior.legendarySamInterceptionCapacity = (...args) => {
  sourceFallbackCalls++;
  sourceFallbackProfiles = args[3];
  return 99;
};
const sourceMetrics = routeBehavior.legendarySalvoSourceMetrics({
  enemySilos: [sourceSilo, fallbackSilo],
  targetTile: 9,
  launchFlightTimes: new Map([
    [sourceSilo, 10],
    [fallbackSilo, 11],
  ]),
  routes: [sourceRoute],
  samProfiles: sourceProfiles,
});
assert.deepEqual(
  sourceMetrics.map(({ interceptionCapacity }) => interceptionCapacity),
  [2, 99],
  "source metrics reuse route capacity and retain the geometry fallback",
);
assert.equal(sourceFallbackCalls, 1);
assert.equal(
  sourceFallbackProfiles,
  sourceProfiles,
  "source metrics pass prepared SAM profiles to the geometry fallback",
);

let candidatePlanBuilds = 0;
const candidateLaunches = [
  { flightTicks: 10, impactTick: 10 },
  { flightTicks: 20, impactTick: 20 },
];
let candidateLaunchSliceCalls = 0;
let candidateLaunchMapCalls = 0;
const candidateLaunchSlice = candidateLaunches.slice;
const candidateLaunchMap = candidateLaunches.map;
candidateLaunches.map = (...args) => {
  candidateLaunchMapCalls++;
  return candidateLaunchMap.apply(candidateLaunches, args);
};
candidateLaunches.slice = (...args) => {
  candidateLaunchSliceCalls++;
  const sliced = candidateLaunchSlice.apply(candidateLaunches, args);
  const slicedMap = sliced.map;
  sliced.map = (...mapArgs) => {
    candidateLaunchMapCalls++;
    return slicedMap.apply(sliced, mapArgs);
  };
  return sliced;
};
routeBehavior.legendaryEnemyMissileLaunchPlan = () => {
  candidatePlanBuilds++;
  return candidateLaunches;
};
const candidateThreat = {
  enemySilos: [sourceSilo],
  salvoPlan: { atomArrivalTicks: [10], hydrogenArrivalTick: null, routes: [] },
  weapon: "AtomBomb",
};
const candidateContext = {
  launchMetadataCache: new Map(),
  candidateShotPlanCache: new Map(),
  interceptionCapacityCache: new Map(),
};
const firstCandidatePlan = routeBehavior.legendaryCandidateShotPlan(
  7,
  candidateThreat,
  candidateContext,
);
const secondCandidatePlan = routeBehavior.legendaryCandidateShotPlan(
  7,
  candidateThreat,
  candidateContext,
);
assert.equal(firstCandidatePlan, secondCandidatePlan);
assert.deepEqual([...firstCandidatePlan.atomArrivalTicks], [10, 20]);
assert.equal(firstCandidatePlan.nearestFlightTime, 10);
assert.equal(
  candidatePlanBuilds,
  1,
  "candidate launch plans are reused for repeated placement scoring",
);
assert.equal(candidateLaunchSliceCalls, 0);
assert.equal(candidateLaunchMapCalls, 0);
const hydrogenCandidatePlan = routeBehavior.legendaryCandidateShotPlan(
  8,
  {
    enemySilos: [sourceSilo],
    salvoPlan: {
      atomArrivalTicks: [],
      hydrogenArrivalTick: 20,
      routes: [],
    },
    weapon: "HydrogenBomb",
  },
  {
    launchMetadataCache: new Map(),
    candidateShotPlanCache: new Map(),
    interceptionCapacityCache: new Map(),
  },
);
assert.deepEqual([...hydrogenCandidatePlan.atomArrivalTicks], [10]);
assert.equal(hydrogenCandidatePlan.hydrogenArrivalTick, 20);
assert.equal(candidateLaunchSliceCalls, 0);
assert.equal(candidateLaunchMapCalls, 0);
delete candidateLaunches.map;
delete candidateLaunches.slice;
let candidateCapacityBuilds = 0;
routeBehavior.legendarySamInterceptionCapacity = () => {
  candidateCapacityBuilds++;
  return 3;
};
assert.equal(
  routeBehavior.legendaryCachedSamInterceptionCapacity(sourceSilo, 7, candidateContext),
  3,
);
assert.equal(
  routeBehavior.legendaryCachedSamInterceptionCapacity(sourceSilo, 7, candidateContext),
  3,
);
assert.equal(
  candidateCapacityBuilds,
  1,
  "candidate SAM capacity is reused for repeated placement scoring",
);

let allySamRangeReads = 0;
const allySamProfiles = routeBehavior.legendaryAllySupportSamProfiles(
  [
    { level: () => 2, tile: () => 4 },
    { level: () => 2, tile: () => 5 },
  ],
  {
    samRange: () => {
      allySamRangeReads++;
      return 10;
    },
  },
);
assert.equal(allySamRangeReads, 1);
const allySupport = routeBehavior.legendaryAllySamSupport(
  5,
  { samProfiles: allySamProfiles },
  {
    samRange: () => {
      throw new Error("precomputed SAM profiles should be reused");
    },
  },
);
assert.ok(allySupport > 0, "precomputed ally SAM profiles still provide support");
assert.equal(allySamRangeReads, 1);

const defenseGapRangeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let defenseGapRangeReads = 0;
const defenseGapRangeConfig = {
  samRange: () => {
    defenseGapRangeReads++;
    return 10;
  },
};
defenseGapRangeBehavior.game = {
  config: () => defenseGapRangeConfig,
  euclideanDistSquared: () => 0,
};
defenseGapRangeBehavior.legendaryFriendlySamUnits = () => [
  { level: () => 1, tile: () => 1 },
  { level: () => 1, tile: () => 2 },
];
assert.equal(
  defenseGapRangeBehavior.legendaryDefenseGap([{ tile: () => 3 }, { tile: () => 4 }], 0),
  0.5,
);
assert.equal(defenseGapRangeReads, 1, "defense-gap scoring reuses the range for equal SAM levels");
defenseGapRangeBehavior.player = { units: () => [] };
assert.equal(
  defenseGapRangeBehavior.legendaryPortSurvivability([{ tile: () => 5 }, { tile: () => 6 }], 0),
  1,
);
assert.equal(defenseGapRangeReads, 1, "port survivability reuses the range for equal SAM levels");

const repeatedSamRangeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let repeatedSamRangeReads = 0;
const repeatedSamRangeConfig = {
  samRange: () => {
    repeatedSamRangeReads++;
    return 10;
  },
};
const repeatedSamUnits = [
  { level: () => 1, tile: () => 1 },
  { level: () => 1, tile: () => 2 },
];
repeatedSamRangeBehavior.game = {
  config: () => repeatedSamRangeConfig,
  euclideanDistSquared: () => 0,
};
repeatedSamRangeBehavior.player = { units: () => repeatedSamUnits };
const repeatedSamCoverage = repeatedSamRangeBehavior.existingSamStructureCoverage([
  { tile: 3 },
  { tile: 4 },
]);
assert.equal(repeatedSamCoverage.get(3), 2);
assert.equal(
  repeatedSamRangeBehavior.siloSamProtectionScore({ tile: () => 5 }, repeatedSamUnits),
  2,
);
assert.equal(
  repeatedSamRangeBehavior.structureSamProtectionScore({ tile: () => 6 }, repeatedSamUnits),
  20,
);
assert.equal(
  repeatedSamRangeReads,
  1,
  "coverage scoring reuses the range across structure and SAM loops",
);
const flightSpeedBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let flightSpeedReads = 0;
const flightSpeedConfig = {
  defaultNukeSpeed: () => {
    flightSpeedReads++;
    return 10;
  },
};
flightSpeedBehavior.game = {
  config: () => flightSpeedConfig,
  euclideanDistSquared: () => 1,
  x: (tile) => tile,
  y: () => 0,
  height: () => 1_000,
  isValidCoord: () => true,
  ref: (x) => x,
};
flightSpeedBehavior.legendaryNukeFlightPath(0, 1);
flightSpeedBehavior.legendaryNukeFlightPath(0, 1);
flightSpeedBehavior.legendaryNukeFlightTime(0, 1);
assert.equal(flightSpeedReads, 1, "cached missile trajectories reuse the configured nuke speed");
const pinnedFlightPathFinder = structureSandbox.UniversalPathFinding.Parabola(
  flightSpeedBehavior.game,
  { increment: 10, distanceBasedHeight: true, directionUp: true },
);
const pinnedMotionPlan = [];
let pinnedFlightTicks = 0;
while (true) {
  const result = pinnedFlightPathFinder.next(0, 500, 10);
  pinnedFlightTicks++;
  if (result.status === "Complete") break;
  pinnedMotionPlan.push(result.node);
}
const sampledFlightPath = flightSpeedBehavior.legendaryNukeFlightPath(0, 500);
assert.ok(
  pinnedMotionPlan.length > 0 && sampledFlightPath.length > 0,
  "the Legendary regression route has both a sampled trajectory and an authoritative motion plan",
);
assert.ok(
  pinnedFlightTicks > sampledFlightPath.length,
  "the pinned motion plan needs multiple ticks across at least one sampled trajectory segment",
);
assert.equal(
  flightSpeedBehavior.legendaryNukeFlightTime(0, 500),
  pinnedFlightTicks,
  "Legendary prospective flight ticks match the pinned NukeExecution motion plan",
);

const placementContextBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const placementContextConfig = {
  trainStationMaxRange: () => 10,
  samRange: () => 10,
};
let placementMetricReads = 0;
let placementAllyReads = 0;
placementContextBehavior.game = { ticks: () => 12 };
placementContextBehavior.player = {};
placementContextBehavior.safeGameConfig = () => placementContextConfig;
placementContextBehavior.legendaryProductionMetrics = () => {
  placementMetricReads++;
  return { troops: 0, gold: 0n, goldProduction: 0, tiles: [], samUnits: [] };
};
placementContextBehavior.legendaryFriendlyPlayers = () => {
  placementAllyReads++;
  return [];
};
const firstPlacementContext = placementContextBehavior.legendaryAllyPlacementContext();
const secondPlacementContext = placementContextBehavior.legendaryAllyPlacementContext();
assert.equal(firstPlacementContext, secondPlacementContext);
assert.equal(placementMetricReads, 1, "ally placement context is reused within a tick");
assert.equal(placementAllyReads, 1);

const teamContextBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let teamParticipantReads = 0;
teamContextBehavior.game = { ticks: () => 12 };
teamContextBehavior.player = {};
teamContextBehavior.legendaryFriendlyPlayers = () => [];
teamContextBehavior.legendaryParticipantCenterPoints = () => {
  teamParticipantReads++;
  return [];
};
const firstTeamContext = teamContextBehavior.legendaryTeamCenterPlacementContext();
const secondTeamContext = teamContextBehavior.legendaryTeamCenterPlacementContext();
assert.equal(firstTeamContext, secondTeamContext);
assert.equal(teamParticipantReads, 1, "team center context is reused within a tick");

const defenseProfileBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const cachedDefenseProfiles = [{ id: "cached-sam" }];
let defenseProfileBuilds = 0;
defenseProfileBehavior.legendaryFriendlySamProfiles = () => {
  defenseProfileBuilds++;
  return [{ id: "fresh-sam" }];
};
assert.equal(
  defenseProfileBehavior.legendaryDefenseSamProfiles({ samProfiles: cachedDefenseProfiles }, {}),
  cachedDefenseProfiles,
  "normal defense evaluations reuse profiles from the missile snapshot",
);
assert.equal(defenseProfileBuilds, 0);
assert.equal(
  defenseProfileBehavior.legendaryDefenseSamProfiles(
    { samProfiles: cachedDefenseProfiles },
    { levelOverrides: new Map([["sam", 2]]) },
  )[0].id,
  "fresh-sam",
  "hypothetical SAM levels rebuild profiles instead of reusing the snapshot",
);
assert.equal(defenseProfileBuilds, 1);

const defenseEvaluationBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
defenseEvaluationBehavior.game = { config: () => ({ SAMCooldown: () => 90 }) };
const defenseSnapshot = { threats: [], samProfiles: [] };
const firstDefenseEvaluation =
  defenseEvaluationBehavior.legendaryDefenseEvaluation(defenseSnapshot);
const secondDefenseEvaluation =
  defenseEvaluationBehavior.legendaryDefenseEvaluation(defenseSnapshot);
assert.equal(
  secondDefenseEvaluation,
  firstDefenseEvaluation,
  "normal defense evaluations are reused for the same missile snapshot",
);

const samRangeCacheBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let candidateSamRangeReads = 0;
const samRangeCacheConfig = {
  defaultSamRange: () => 10,
  samRange: () => {
    candidateSamRangeReads++;
    return 10;
  },
};
samRangeCacheBehavior.game = {
  config: () => samRangeCacheConfig,
  euclideanDistSquared: () => 0,
};
samRangeCacheBehavior.player = { units: () => [] };
samRangeCacheBehavior.legendaryFriendlySamUnits = () => [];
samRangeCacheBehavior.spacingConstants = () => ({ structureSpacing: 1 });
samRangeCacheBehavior.legendarySamImpactMarginContext = () => ({
  completionTick: 0,
  routesByThreat: new Map(),
});
samRangeCacheBehavior.legendaryCandidateProtectsStructure = () => false;
const samCoverageSnapshot = samRangeCacheBehavior.legendarySamCoveragePlacementContext();
const samMissileSnapshot = {
  threats: [{}],
  structures: [{ tile: () => 1 }],
  totalValue: 1,
  structureValues: new Map(),
};
samRangeCacheBehavior.legendarySamCoveragePlacementScore(
  1,
  samMissileSnapshot,
  samCoverageSnapshot,
);
samRangeCacheBehavior.legendarySamCoveragePlacementScore(
  2,
  samMissileSnapshot,
  samCoverageSnapshot,
);
assert.equal(
  candidateSamRangeReads,
  1,
  "SAM candidate scoring reuses the level-one range from its placement context",
);

const profileRangeBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let profileRangeReads = 0;
profileRangeBehavior.game = {
  config: () => ({
    samRange: () => {
      profileRangeReads++;
      return 99;
    },
  }),
};
const cachedProfileRange = profileRangeBehavior.legendarySamCoverageProfile(
  { tile: 7, level: 2, range: 10 },
  2,
);
assert.equal(cachedProfileRange.samTile, 7);
assert.equal(cachedProfileRange.range, 10, "SAM route profiles retain their precomputed range");
assert.equal(profileRangeReads, 0, "precomputed SAM ranges avoid config reads");

const activeThreatCapacityBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
const activeThreatSamProfiles = [{ id: "active-sam", availableTicks: [0] }];
let activeThreatCapacityArgs;
activeThreatCapacityBehavior.legendaryActiveMissileMotion = () => ({
  impactTick: 12,
  fromTile: 0,
  path: [0, 1],
});
activeThreatCapacityBehavior.legendarySamInterceptionCapacity = (...args) => {
  activeThreatCapacityArgs = args;
  return 1;
};
activeThreatCapacityBehavior.legendaryBuildMissileRoute = (route, profiles) => {
  assert.equal(profiles, activeThreatSamProfiles);
  return route;
};
activeThreatCapacityBehavior.legendaryActiveMissileThreatResult = ({ interceptionCapacity }) => ({
  interceptionCapacity,
});
structureSandbox.legendaryMissileSalvoRisk = () => ({});
activeThreatCapacityBehavior.legendaryScoredActiveMissileThreat({
  nuke: { id: () => "active-nuke" },
  fromTile: 0,
  targetTile: 1,
  type: "AtomBomb",
  exposure: { value: 1, count: 1, radiusSquared: 1 },
  context: {},
  samProfiles: activeThreatSamProfiles,
});
assert.equal(
  activeThreatCapacityArgs[3],
  activeThreatSamProfiles,
  "active missile scoring passes prepared SAM profiles to capacity ranking",
);

const samCooldownBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let samCooldownReads = 0;
let samRangeReads = 0;
const samCooldownConfig = {
  SAMCooldown: () => {
    samCooldownReads++;
    return 90;
  },
  samRange: () => {
    samRangeReads++;
    return 10;
  },
};
samCooldownBehavior.game = { config: () => samCooldownConfig };
samCooldownBehavior.legendaryFriendlySamUnits = () => [
  { id: () => "sam-a", tile: () => 1, level: () => 1 },
  { id: () => "sam-b", tile: () => 2, level: () => 1 },
];
samCooldownBehavior.legendarySamSlotAvailability = () => [0];
const samCooldownProfiles = samCooldownBehavior.legendaryFriendlySamProfiles();
assert.equal(samCooldownProfiles.length, 2);
assert.equal(
  samCooldownReads,
  1,
  "SAM profile construction reuses the cooldown from the same game configuration",
);
assert.equal(samRangeReads, 1, "SAM profile construction reuses the range for equal SAM levels");
const replacementSamConfig = {
  SAMCooldown: () => 90,
  samRange: () => {
    samRangeReads++;
    return 20;
  },
};
samCooldownBehavior.game = { config: () => replacementSamConfig };
assert.equal(samCooldownBehavior.legendarySamRange(1), 20);
assert.equal(samRangeReads, 2, "a new game configuration invalidates the SAM range cache");

const siloCooldownBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let siloCooldownReads = 0;
const siloCooldownConfig = {
  SiloCooldown: () => {
    siloCooldownReads++;
    return 90;
  },
};
siloCooldownBehavior.game = { config: () => siloCooldownConfig };
assert.equal(siloCooldownBehavior.legendarySiloCooldownTicks(), 90);
assert.equal(siloCooldownBehavior.legendarySiloCooldownTicks(), 90);
assert.equal(
  siloCooldownReads,
  1,
  "silo availability reuses the cooldown from the same game configuration",
);
const replacementSiloConfig = {
  SiloCooldown: () => {
    siloCooldownReads++;
    return 45;
  },
};
siloCooldownBehavior.game = { config: () => replacementSiloConfig };
assert.equal(siloCooldownBehavior.legendarySiloCooldownTicks(), 45);
assert.equal(siloCooldownReads, 2, "a new game configuration invalidates the silo cache");

const profileCapacityBehavior = Object.create(structureSandbox.StructureBehavior.prototype);
let rawSamReads = 0;
profileCapacityBehavior.game = { euclideanDistSquared: (left, right) => (left - right) ** 2 };
profileCapacityBehavior.legendaryNukeFlightPath = () => [0, 1, 2];
profileCapacityBehavior.legendaryTrajectoryTargetableIndexes = () => [0, 1, 2];
profileCapacityBehavior.legendaryFriendlySamUnits = () => {
  rawSamReads++;
  return [];
};
profileCapacityBehavior.legendarySamPathCoverageIndicesForRoute = (profile) =>
  profile.range === 10 ? [0] : [];
assert.equal(
  profileCapacityBehavior.legendarySamInterceptionCapacity(0, 2, null, [
    { tile: 0, level: 1, range: 10, availableTicks: [0] },
  ]),
  1,
  "SAM capacity can use the prepared profile snapshot",
);
assert.equal(rawSamReads, 0, "prepared SAM capacity avoids rereading raw units");
let minimumCapacityProfiles;
profileCapacityBehavior.legendarySamInterceptionCapacity = (...args) => {
  minimumCapacityProfiles = args[3];
  return 1;
};
const minimumCapacitySnapshot = {
  threats: [{ targetTile: 2, enemySilos: [0] }],
  samProfiles: [{ tile: 0, level: 1, range: 10, availableTicks: [0] }],
};
assert.equal(
  profileCapacityBehavior.legendaryMinimumSamInterceptionCapacity(minimumCapacitySnapshot),
  1,
  "minimum SAM capacity reuses the missile snapshot profiles",
);
assert.equal(minimumCapacityProfiles, minimumCapacitySnapshot.samProfiles);

const mirvDedupSandbox = {
  UNIT: {
    MissileSilo: "Missile Silo",
    MIRV: "MIRV",
    MIRVWarhead: "MIRV Warhead",
  },
  Difficulty: { Impossible: "Impossible" },
  PlayerType: { Bot: "Bot" },
  AllPlayers: {},
  EMOJI_NUKE: [],
  WORKER_TIMEOUT_MS: 1,
  currentDifficulty: () => "Impossible",
  state: { settings: { winFixes: false }, stats: { nukes: 0 } },
  withTimeout: async (promise) => promise,
  setLastAction() {},
  tr: (value) => value,
  respondToMIRV() {},
  getBuildMenu: () => ({ sendBuildOrUpgrade() {} }),
};
mirvDedupSandbox.globalThis = mirvDedupSandbox;
executeClassicScript(read("engine/ingame/shared-utils.js"), mirvDedupSandbox, {
  filename: "shared-utils-mirv-dedup.js",
});
executeClassicScript(
  `${read("engine/ingame/auto-bot/mirvBehavior.js")}\nglobalThis.__MirvBehavior = MirvBehavior;`,
  mirvDedupSandbox,
  { filename: "mirv-dedup.js" },
);

const mirvDedupUnit = (owner, type, targetTile) => ({
  isActive: () => true,
  owner: () => owner,
  type: () => type,
  targetTile: () => targetTile,
});
const permanentMirvTeammate = {
  smallID: () => 2,
  team: () => "blue",
};
const breakableMirvAlly = {
  smallID: () => 3,
  team: () => null,
};
const mirvTarget = {
  id: () => "mirv-target",
  smallID: () => 4,
  isPlayer: () => true,
  type: () => "Human",
  team: () => null,
};
let activeMirvUnits = [];
let emittedMirvBuilds = 0;
const mirvDedupPlayer = {
  smallID: () => 1,
  team: () => "blue",
  isFriendly: (other) => other === breakableMirvAlly,
  units: (type) =>
    type === mirvDedupSandbox.UNIT.MissileSilo
      ? [
          {
            isActive: () => true,
            isUnderConstruction: () => false,
            level: () => 1,
            missileTimerQueue: () => [],
          },
        ]
      : [],
  buildables: async () => [{ type: mirvDedupSandbox.UNIT.MIRV, cost: 1n, canBuild: true }],
  gold: () => 1n,
};
const mirvDedupGame = {
  ticks: () => 100,
  players: () => [mirvDedupPlayer, permanentMirvTeammate, breakableMirvAlly, mirvTarget],
  units: (...types) => activeMirvUnits.filter((unit) => types.includes(unit.type())),
  config: () => ({ nukeMagnitudes: () => ({ inner: 12 }) }),
  euclideanDistSquared: (left, right) => (left - right) ** 2,
};
mirvDedupSandbox.sendAutoBotBuildOrUpgrade = () => {
  emittedMirvBuilds++;
  return true;
};
const mirvDedupBehavior = new mirvDedupSandbox.__MirvBehavior(
  { chance: () => false },
  mirvDedupGame,
  mirvDedupPlayer,
  { maybeSendAttackEmoji() {}, sendEmoji() {} },
);
mirvDedupBehavior.calculateTerritoryCenter = async () => 100;

for (const activeType of [mirvDedupSandbox.UNIT.MIRV, mirvDedupSandbox.UNIT.MIRVWarhead]) {
  activeMirvUnits = [mirvDedupUnit(permanentMirvTeammate, activeType, 108)];
  emittedMirvBuilds = 0;
  assert.equal(
    await mirvDedupBehavior.maybeSendMIRV(mirvTarget),
    false,
    `a permanent teammate's active ${activeType} suppresses an overlapping MIRV launch`,
  );
  assert.equal(emittedMirvBuilds, 0);
}

activeMirvUnits = [mirvDedupUnit(breakableMirvAlly, mirvDedupSandbox.UNIT.MIRV, 108)];
emittedMirvBuilds = 0;
assert.equal(
  await mirvDedupBehavior.maybeSendMIRV(mirvTarget),
  true,
  "a breakable ally's active MIRV does not suppress an overlapping launch",
);
assert.equal(emittedMirvBuilds, 1);

const oneStructureAction = Object.create(structureSandbox.StructureBehavior.prototype);
const attemptedActions = [];
Object.assign(oneStructureAction, {
  legendaryConstructionActionGroups: () => [
    [{ type: "City" }, { type: "Factory" }, { type: "Port" }],
    [{ type: "Port" }],
  ],
  maybeSpawnStructure: async (type) => {
    attemptedActions.push(type);
    return type === "Factory";
  },
  recordConstructionPlannerSample: () => {},
});
assert.equal(
  await oneStructureAction.runLegendaryConstructionGroups(0, [], false),
  true,
  "the Legendary decision reports a successful build",
);
assert.deepEqual(
  attemptedActions,
  ["City", "Factory"],
  "one decision cycle stops after its first successful structure action",
);

// ---- Marginal-economy decision tests (team displacement / global dilution /
// conditional seeds / inbound timing) ----
const displacementConfig = {
  unitInfo: () => ({ constructionDuration: 0 }),
  trainSpawnRate: () => 1,
};
const zeroDisplacementCityInputs = {
  trainCount: 0,
  routeDelayTicks: 0,
  trainSources: [
    {
      factoryCount: 1,
      productiveFactoryLevels: [1],
      pendingFactoryLevels: [],
      paidStopsAfterBuild: 2,
      beforeTeamGoldPerSpawn: 50_000,
      teamGoldPerStop: 50_000,
      postAllianceTeamGoldPerStop: 50_000,
      eligibleTicks: Infinity,
    },
  ],
};
assert.equal(
  plannerSandbox.legendaryEconomyNetGold("City", {
    cost: 1_000,
    horizonTicks: 1_000,
    inputs: zeroDisplacementCityInputs,
    config: displacementConfig,
  }).netTeamGold,
  -1_000,
  "a second own City into an all-own pool adds zero team gold and keeps only its cost",
);
const dilutionConfig = {
  unitInfo: () => ({ constructionDuration: 0 }),
  trainSpawnRate: (factoryCount) => (factoryCount <= 3 ? 4 : 8),
};
const dilutionCluster = {
  productiveFactoryLevels: [1],
  pendingFactoryLevels: [],
  teamGoldPerSpawn: 100_000,
  postTeamGoldPerSpawn: 100_000,
  eligibleTicks: Infinity,
  isTarget: true,
};
const otherDilutedCluster = {
  productiveFactoryLevels: [1, 1],
  pendingFactoryLevels: [],
  teamGoldPerSpawn: 100_000,
  postTeamGoldPerSpawn: 100_000,
  eligibleTicks: Infinity,
  isTarget: false,
};
const dilutedFactoryInputs = {
  factoryPaidStops: 1,
  factoryTeamGoldPerTrain: 100_000,
  trainCount: 0,
  routeDelayTicks: 0,
  ownFactoryCount: 3,
  ownerFactoryClusters: [dilutionCluster, otherDilutedCluster],
};
const dilutedFactoryValue = plannerSandbox.legendaryEconomyNetGold("Factory", {
  cost: 1_000,
  horizonTicks: 1_000,
  inputs: dilutedFactoryInputs,
  config: dilutionConfig,
});
const naiveFactoryValue = plannerSandbox.legendaryEconomyNetGold("Factory", {
  cost: 1_000,
  horizonTicks: 1_000,
  inputs: { ...dilutedFactoryInputs, ownerFactoryClusters: [dilutionCluster] },
  config: dilutionConfig,
});
assert.ok(
  dilutedFactoryValue.netTeamGold > 0 &&
    dilutedFactoryValue.netTeamGold < naiveFactoryValue.netTeamGold,
  "a new Factory pays the spawn-rate loss of the owner's other rail clusters",
);
const seedStreamConfig = {
  unitInfo: () => ({ constructionDuration: 50 }),
  tradeShipSpawnRate: () => 1,
};
const seedRoute = {
  weight: 1,
  distance: 0,
  teamGoldPerArrival: 1_000,
  postAllianceGoldPerArrival: 1_000,
  allianceTicksRemaining: Infinity,
};
const seedStreams = [
  { ...seedRoute, level: 1, portSeedStream: "own" },
  { ...seedRoute, level: 1, portSeedStream: "partner" },
];
const committedSeedValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100,
  horizonTicks: 500,
  inputs: {
    portSeedSources: seedStreams,
    portSeedPartnerCommitted: true,
    portSeedWindowOpen: true,
  },
  config: seedStreamConfig,
});
const uncommittedSeedValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100,
  horizonTicks: 500,
  inputs: {
    portSeedSources: seedStreams,
    portSeedPartnerCommitted: false,
    portSeedWindowOpen: true,
  },
  config: seedStreamConfig,
});
assert.ok(
  committedSeedValue.netTeamGold > uncommittedSeedValue.netTeamGold &&
    uncommittedSeedValue.netTeamGold > 0 &&
    Math.abs(
      committedSeedValue.netTeamGold -
        uncommittedSeedValue.netTeamGold -
        (uncommittedSeedValue.netTeamGold + 100),
    ) < 1e-6,
  "an uncommitted seed counts only our own trade stream until the partner commits",
);
const portSpawnRate = plannerSandbox.legendaryExpectedTradeShipRatePerTick(1, 0, {
  tradeShipSpawnRate: () => 1,
});
const inboundTimingProfile = (inboundDelay) => ({
  routes: [seedRoute],
  inboundSources: [
    {
      level: 1,
      constructionDelayTicks: inboundDelay,
      beforeProfile: {
        routes: [{ ...seedRoute, teamGoldPerArrival: 0, postAllianceGoldPerArrival: 0 }],
      },
      afterProfile: { routes: [{ ...seedRoute }] },
    },
  ],
});
const readyInboundPortValue = plannerSandbox.legendaryEconomyNetGold("Port", {
  cost: 100,
  horizonTicks: 1_000,
  inputs: {
    hasCompletedTradePartner: true,
    portCandidateProfiles: [inboundTimingProfile(0)],
  },
  config: seedStreamConfig,
});
assert.ok(
  Math.abs(
    readyInboundPortValue.netTeamGold - (portSpawnRate * (950 * 1_000 + 1_000 * 1_000) - 100),
  ) < 1e-6,
  "a completed foreign source Port earns inbound trades while our Port is still building",
);
process.stdout.write("LEGENDARY TESTS OK\n");
