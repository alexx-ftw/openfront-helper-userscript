import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js");
const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
const sandbox = {};
vm.runInNewContext(source, sandbox, { filename: sourcePath });
const attackSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/attackBehavior.js"),
  "utf8",
);
const nationSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nationExecution.js"),
  "utf8",
);
const gameApiSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/gameApi.js"),
  "utf8",
);
const buildSource = fs.readFileSync(path.join(repoRoot, "build.mjs"), "utf8");
const coreSource = fs.readFileSync(path.join(repoRoot, "engine/ingame/auto-bot/core.js"), "utf8");
const panelSource = fs.readFileSync(path.join(repoRoot, "engine/ingame/auto-bot/panel.js"), "utf8");

assert.equal(typeof sandbox.createEarlyGameSnapshot, "function");
assert.equal(typeof sandbox.chooseEarlyGameAction, "function");
assert.equal(typeof sandbox.isEarlyGameBoatEta, "function");
assert.equal(typeof sandbox.findWaterRouteTicks, "function");
assert.equal(typeof sandbox.transportRouteTicks, "function");
assert.equal(typeof sandbox.findNearestMaritimeCoastDistance, "function");
assert.equal(typeof sandbox.findNearestOceanCoastDistance, "function");
assert.equal(typeof sandbox.buildMaritimeDistanceIndex, "function");
assert.equal(typeof sandbox.lookupMaritimeDistanceIndex, "function");
assert.equal(typeof sandbox.rankEarlyGameTribeCandidates, "function");
assert.equal(typeof sandbox.calculateEarlyGameContinuationValue, "function");
assert.equal(typeof sandbox.calculateEarlyGameFoodRaceValue, "function");
assert.equal(typeof sandbox.calculateEarlyGameRaceTroops, "function");
assert.equal(typeof sandbox.calculateTroopGenerationRate, "function");
assert.equal(typeof sandbox.findOptimalGenerationRatio, "function");
assert.equal(typeof sandbox.estimateTroopRecoveryTicks, "function");
assert.equal(typeof sandbox.terrainAttackMagnitudeFromMapMagnitude, "function");
assert.equal(typeof sandbox.calculateEarlyGameExpansionPlan, "function");
assert.equal(typeof sandbox.requiredTribeCaptureTiles, "function");
assert.equal(typeof sandbox.estimateTribeCaptureTroops, "function");
assert.equal(typeof sandbox.getAutoDonateExpansionStatus, "function");
assert.equal(sandbox.isEarlyGameBoatEta(300), true);
assert.equal(sandbox.isEarlyGameBoatEta(301), false);
assert.equal(sandbox.isEarlyGameBoatEta(null), false);

const generationAtZero = sandbox.calculateTroopGenerationRate({
  troops: 0,
  maxTroops: 100000,
});
const generationAtPeak = sandbox.calculateTroopGenerationRate({
  troops: 42000,
  maxTroops: 100000,
});
const generationAtMax = sandbox.calculateTroopGenerationRate({
  troops: 100000,
  maxTroops: 100000,
});
assert.ok(generationAtZero > 0);
assert.ok(generationAtPeak > generationAtZero);
assert.equal(generationAtMax, 0);
assert.ok(
  sandbox.findOptimalGenerationRatio() >= 0.38 && sandbox.findOptimalGenerationRatio() <= 0.46,
);
assert.equal(sandbox.terrainAttackMagnitudeFromMapMagnitude(1), 80);
assert.equal(sandbox.terrainAttackMagnitudeFromMapMagnitude(15), 100);
assert.equal(sandbox.terrainAttackMagnitudeFromMapMagnitude(25), 120);
assert.equal(sandbox.requiredTribeCaptureTiles(10), 1);
assert.equal(sandbox.requiredTribeCaptureTiles(150), 51);
assert.equal(
  sandbox.estimateTribeCaptureTroops({
    targetTiles: 10,
    simulateAttack: (attackTroops, tiles) => tiles === 1 && attackTroops >= 500,
    fallbackTroops: 9999,
  }),
  500,
  "capture sizing must use the supplied attack-loss simulation rather than a troop multiplier",
);
assert.equal(
  sandbox.estimateTribeCaptureTroops({
    targetTiles: 10,
    simulateAttack: () => false,
    fallbackTroops: 9999,
  }),
  Infinity,
  "an impossible capture simulation must defer instead of falling back to one troop",
);
assert.ok(
  sandbox.estimateTroopRecoveryTicks({
    troops: 10000,
    maxTroops: 100000,
    targetTroops: 20000,
  }) > 0,
);

const openingExpansionPlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 20000,
  maxTroops: 100000,
  targetType: "land",
  terrainMagnitude: 1,
  expectedTiles: 8,
  baseReserveRatio: 0.3,
});
assert.equal(openingExpansionPlan.shouldAttackNow, true);
assert.ok(openingExpansionPlan.commitTroops > 0);
assert.ok(openingExpansionPlan.commitTroops < openingExpansionPlan.ownTroops);
assert.ok(
  openingExpansionPlan.commitTroops <=
    openingExpansionPlan.ownTroops - openingExpansionPlan.reserveTroops,
);
assert.ok(openingExpansionPlan.generationRate > 0);

const perishableExpansionPlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 12000,
  maxTroops: 100000,
  targetType: "land",
  terrainMagnitude: 25,
  expectedTiles: 8,
  opportunityUrgency: 1,
});
assert.equal(perishableExpansionPlan.irreversibleOpportunity, true);
assert.equal(perishableExpansionPlan.shouldAttackNow, true);
assert.ok(perishableExpansionPlan.commitFraction >= 0.6);

const activeExpansionPlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 60000,
  maxTroops: 100000,
  targetType: "land",
  activeAttackTroops: 10000,
});
assert.equal(activeExpansionPlan.shouldAttackNow, false);

const completeTribePlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 30000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 5000,
  captureTroops: 750,
  targetDefenseMultiplier: 1,
  opportunityUrgency: 1,
});
assert.equal(completeTribePlan.requiredTroops, 750);
assert.ok(completeTribePlan.commitTroops >= completeTribePlan.requiredTroops);
assert.equal(completeTribePlan.shouldAttackNow, true);

const largeFrontierTribePlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 60000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 12000,
  captureTroops: 20000,
  targetDefenseMultiplier: 1,
  opportunityUrgency: 0,
});
assert.equal(
  largeFrontierTribePlan.shouldAttackNow,
  true,
  "an affordable frontier tribe must not inherit the generic 30% reserve gate",
);
assert.equal(largeFrontierTribePlan.reserveTroops, 7200);
assert.equal(largeFrontierTribePlan.commitTroops, 20000);

const underfundedTribePlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 600,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 5000,
  captureTroops: 750,
  targetDefenseMultiplier: 1,
  opportunityUrgency: 1,
});
assert.ok(underfundedTribePlan.commitTroops < underfundedTribePlan.requiredTroops);
assert.equal(
  underfundedTribePlan.shouldAttackNow,
  false,
  "an underfunded tribe attack must wait instead of leaving a remnant",
);

const topUpTribePlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 30000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 5000,
  captureTroops: 750,
  activeAttackTroops: 300,
  opportunityUrgency: 1,
});
assert.equal(topUpTribePlan.remainingRequiredTroops, 450);
assert.equal(topUpTribePlan.commitTroops, 450);
assert.equal(
  topUpTribePlan.shouldAttackNow,
  true,
  "a tribe with an underpowered attack in flight should receive only the missing force",
);

const completeActiveTribePlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 30000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 5000,
  captureTroops: 750,
  activeAttackTroops: 750,
  opportunityUrgency: 1,
});
assert.equal(completeActiveTribePlan.remainingRequiredTroops, 0);
assert.equal(completeActiveTribePlan.commitTroops, 0);
assert.equal(
  completeActiveTribePlan.shouldAttackNow,
  false,
  "a fully funded attack in flight must not be duplicated",
);

const unknownTribePlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 10000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 50000,
  opportunityUrgency: 0,
});
assert.equal(
  unknownTribePlan.shouldAttackNow,
  false,
  "a tribe without an exact capture requirement must not be treated as cheap",
);

const oversizedOpeningBurstPlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 10000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 100,
  captureTroops: 9000,
  initialBurst: true,
});
assert.equal(oversizedOpeningBurstPlan.commitTroops, 6000);
assert.equal(
  oversizedOpeningBurstPlan.shouldAttackNow,
  false,
  "the opening burst must not empty the player when the capture force is unavailable",
);

const duplicateOpeningBurstPlan = sandbox.calculateEarlyGameExpansionPlan({
  ownTroops: 10000,
  maxTroops: 100000,
  targetType: "tribe",
  targetTroops: 100,
  captureTroops: 500,
  activeAttackTroops: 100,
  initialBurst: true,
});
assert.equal(
  duplicateOpeningBurstPlan.shouldAttackNow,
  false,
  "an opening burst must not be repeated while its attack is active",
);

const assertAutoDonateStatus = (actual, expected) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));

assertAutoDonateStatus(
  sandbox.getAutoDonateExpansionStatus({
    active: true,
    hasFreeLand: true,
  }),
  { active: true, reason: "free-land", maxTicks: 30 },
);
assertAutoDonateStatus(
  sandbox.getAutoDonateExpansionStatus({
    active: true,
    actionableTribes: [{ landBorder: true }],
  }),
  { active: true, reason: "land-tribe", maxTicks: 30 },
);
assertAutoDonateStatus(
  sandbox.getAutoDonateExpansionStatus({
    active: true,
    actionableTribes: [{ landBorder: false, boatEtaTicks: 30 }],
  }),
  { active: true, reason: "sea-tribe", maxTicks: 30 },
);
assertAutoDonateStatus(
  sandbox.getAutoDonateExpansionStatus({
    active: true,
    actionableTribes: [{ landBorder: false, boatEtaTicks: 31 }],
  }),
  { active: false, reason: null, maxTicks: 30 },
);
assertAutoDonateStatus(
  sandbox.getAutoDonateExpansionStatus({
    active: true,
    actionableTribes: [{ landBorder: false, seaReachableWithin30Ticks: true }],
  }),
  { active: false, reason: null, maxTicks: 30 },
);
assertAutoDonateStatus(sandbox.getAutoDonateExpansionStatus({ active: false, hasFreeLand: true }), {
  active: false,
  reason: null,
  maxTicks: 30,
});

const snapshot = sandbox.createEarlyGameSnapshot({
  postSpawn: true,
  hasFreeLand: true,
  tribes: [
    { id: "border-tribe", alive: true, friendly: false, landBorder: true },
    { id: "boat-candidate", alive: true, friendly: false, boatCandidate: true },
    { id: "near-tribe", alive: true, friendly: false, boatEtaTicks: 300 },
    { id: "late-tribe", alive: true, friendly: false, boatEtaTicks: 301 },
    { id: "unknown-tribe", alive: true, friendly: false, boatEtaTicks: null },
    { id: "friendly-tribe", alive: true, friendly: true, boatEtaTicks: 0 },
    { id: "dead-tribe", alive: false, friendly: false, boatEtaTicks: 0 },
  ],
});

assert.equal(snapshot.active, true);
assert.equal(snapshot.hasFreeLand, true);
assert.equal(snapshot.hasTribeTarget, true);
assert.deepEqual(
  snapshot.actionableTribes.map((target) => target.id),
  ["border-tribe", "boat-candidate", "near-tribe"],
);

assert.equal(
  sandbox.createEarlyGameSnapshot({ postSpawn: false, hasFreeLand: true }).active,
  false,
);

assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: true, tribeTarget: true, boatTarget: true }),
  "land",
);
assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: false, tribeTarget: true, boatTarget: true }),
  "tribe",
);
assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: false, tribeTarget: false, boatTarget: true }),
  "boat",
);
assert.equal(
  sandbox.chooseEarlyGameAction({ landTarget: false, tribeTarget: false, boatTarget: false }),
  null,
);

assert.equal(sandbox.transportRouteTicks(["source", "water", "shore"]), 2);
assert.equal(sandbox.transportRouteTicks(["source"]), 0);
assert.equal(sandbox.transportRouteTicks({ fullPath: ["source", "shore"] }), 1);
assert.equal(sandbox.transportRouteTicks([]), null);
assert.equal(sandbox.transportRouteTicks(null), null);

const landGraph = new Map([
  [10, [11]],
  [11, [10, 12]],
  [12, [11, 13]],
  [13, [12]],
]);
assert.equal(
  sandbox.findNearestOceanCoastDistance({
    starts: [10],
    neighbors: (tile) => landGraph.get(tile) || [],
    isLand: (tile) => tile >= 10 && tile <= 13,
    isOceanShore: (tile) => tile === 13,
    maxDistance: 20,
  }),
  3,
);
assert.equal(
  sandbox.findNearestOceanCoastDistance({
    starts: [10],
    neighbors: (tile) => landGraph.get(tile) || [],
    isLand: (tile) => tile >= 10 && tile <= 13,
    isOceanShore: () => false,
    maxDistance: 2,
  }),
  Infinity,
);
assert.equal(
  sandbox.findNearestMaritimeCoastDistance({
    starts: [10],
    neighbors: (tile) => landGraph.get(tile) || [],
    isLand: (tile) => tile >= 10 && tile <= 13,
    isMaritimeShore: (tile) => tile === 13,
    maxDistance: 20,
  }),
  3,
);
assert.equal(
  sandbox.findNearestMaritimeCoastDistance({
    starts: [10],
    neighbors: (tile) => landGraph.get(tile) || [],
    isLand: (tile) => tile >= 10 && tile <= 13,
    isMaritimeShore: () => false,
    maxDistance: 20,
  }),
  Infinity,
  "a closed lake shore must not satisfy the maritime objective",
);

const maritimeDistanceIndex = sandbox.buildMaritimeDistanceIndex({
  width: 4,
  height: 1,
  neighbors: (tile) => (tile === 0 ? [1] : tile === 3 ? [2] : [tile - 1, tile + 1]),
  isLand: () => true,
  isMaritimeShore: (tile) => tile === 3,
});
assert.equal(sandbox.lookupMaritimeDistanceIndex(maritimeDistanceIndex, [0]), 3);
assert.equal(
  sandbox.lookupMaritimeDistanceIndex(
    sandbox.buildMaritimeDistanceIndex({
      width: 4,
      height: 1,
      neighbors: (tile) => (tile === 0 ? [1] : tile === 3 ? [2] : [tile - 1, tile + 1]),
      isLand: () => true,
      isMaritimeShore: (tile) => tile === 3,
      maxDistance: 2,
    }),
    [0],
  ),
  Infinity,
  "a distant maritime route must stay outside the local opening radius",
);

const rankedTribes = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "encircled-inland",
    oceanDistance: Infinity,
    encirclement: 1,
    blockValue: 0.1,
    cheapCapture: 1,
    distance: 3,
  },
  {
    id: "coastal-open",
    oceanDistance: 0,
    encirclement: 0,
    blockValue: 0,
    cheapCapture: 0.2,
    distance: 20,
  },
  {
    id: "coastal-contested",
    oceanDistance: 0,
    encirclement: 0.8,
    blockValue: 1,
    cheapCapture: 0.7,
    distance: 8,
  },
]);
assert.deepEqual(
  rankedTribes.map((candidate) => candidate.id),
  ["coastal-contested", "coastal-open", "encircled-inland"],
);

const maritimeRouteRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "river-route",
    maritimeDistance: 4,
    oceanDistance: Infinity,
    futureFoodAccess: 0.1,
    cheapCapture: 0.2,
  },
  {
    id: "interior-shortcut",
    maritimeDistance: Infinity,
    oceanDistance: Infinity,
    futureFoodAccess: 1,
    cheapCapture: 1,
  },
]);
assert.equal(
  maritimeRouteRank[0].id,
  "river-route",
  "a tribe opening a navigable river route must beat an interior food shortcut",
);
const boundedMaritimeRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "distant-maritime",
    maritimeDistance: 81,
    oceanDistance: 81,
    futureFoodAccess: 1,
  },
  {
    id: "local-inland",
    maritimeDistance: Infinity,
    oceanDistance: Infinity,
    encirclement: 1,
  },
]);
assert.equal(
  boundedMaritimeRank[0].id,
  "local-inland",
  "a distant coast must not outrank a local structural opportunity",
);

const encirclingGateRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "central-food-chain",
    oceanDistance: 0,
    futureFoodAccess: 1,
    foodRaceValue: 0.7,
    competitorVector: 0.9,
    encirclement: 0.2,
    blockValue: 0.1,
    cheapCapture: 0.8,
    distance: 8,
  },
  {
    id: "encircling-gate",
    oceanDistance: 0,
    futureFoodAccess: 0.4,
    foodRaceValue: 0,
    encirclement: 0.85,
    blockValue: 0.8,
    cheapCapture: 0.5,
    distance: 20,
  },
]);
assert.equal(
  encirclingGateRank[0].id,
  "encircling-gate",
  "a strong encircling gate must beat a central food-chain shortcut",
);

const blockingGateRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "partial-encircle",
    oceanDistance: 0,
    futureFoodAccess: 1,
    encirclement: 0.6,
    blockValue: 0.1,
    cheapCapture: 0.5,
  },
  {
    id: "blocking-gate",
    oceanDistance: 0,
    futureFoodAccess: 0.2,
    encirclement: 0.1,
    blockValue: 0.95,
    cheapCapture: 0.5,
  },
]);
assert.equal(
  blockingGateRank[0].id,
  "blocking-gate",
  "a strong blocking gate must beat a partial encirclement shortcut",
);

const directRaceRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "direct-race",
    oceanDistance: 0,
    directAttackers: 1,
    encirclement: 0.1,
    blockValue: 0.1,
    futureFoodAccess: 0.1,
  },
  {
    id: "safe-ring",
    oceanDistance: 0,
    directAttackers: 0,
    encirclement: 0.9,
    blockValue: 0.9,
    futureFoodAccess: 0.1,
  },
]);
assert.equal(
  directRaceRank[0].id,
  "direct-race",
  "a direct attack must stay urgent even without a derived race score",
);

const movementRaceRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "steady-frontier",
    oceanDistance: 0,
    encirclement: 0.4,
    blockValue: 0.4,
    futureFoodAccess: 0.5,
    foodRaceValue: 0,
  },
  {
    id: "moving-rival-frontier",
    oceanDistance: 0,
    encirclement: 0.4,
    blockValue: 0.4,
    futureFoodAccess: 0.5,
    foodRaceValue: 0.8,
    competitorVector: 0.9,
  },
]);
assert.equal(
  movementRaceRank[0].id,
  "moving-rival-frontier",
  "a progressing rival vector must still break an otherwise equal tie",
);

const chainCandidate = sandbox.calculateEarlyGameContinuationValue({
  futureFoodCount: 3,
  futureFoodTotal: 3,
  meanFutureFoodDistance: 0,
});
const isolatedCandidate = sandbox.calculateEarlyGameContinuationValue({
  futureFoodCount: 0,
  futureFoodTotal: 3,
  meanFutureFoodDistance: Infinity,
});
assert.equal(chainCandidate, 1);
assert.equal(isolatedCandidate, 0);

const chainRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "isolated-coast",
    oceanDistance: 0,
    futureFoodAccess: isolatedCandidate,
    foodRaceValue: 1,
  },
  {
    id: "food-chain",
    oceanDistance: 0,
    futureFoodAccess: chainCandidate,
    foodRaceValue: 0,
  },
]);
assert.deepEqual(
  chainRank.map((candidate) => candidate.id),
  ["food-chain", "isolated-coast"],
);

const passiveRace = sandbox.calculateEarlyGameFoodRaceValue({
  competitorProgress: 0.1,
  competitorVector: 0.1,
  competitorTroops: 100,
  targetTroops: 200,
});
const directRace = sandbox.calculateEarlyGameFoodRaceValue({
  directAttackers: 1,
  competitorProgress: 0.8,
  competitorVector: 0.9,
  competitorTroops: 1000,
  targetTroops: 200,
});
assert.ok(directRace > passiveRace);
assert.ok(directRace >= 0.7);

const normalCommit = sandbox.calculateEarlyGameRaceTroops({
  ownTroops: 10000,
  baseTroops: 1000,
  reserveTroops: 2000,
  targetTroops: 200,
  competitorTroops: 0,
  contestPressure: 0,
});
const contestedCommit = sandbox.calculateEarlyGameRaceTroops({
  ownTroops: 10000,
  baseTroops: 1000,
  reserveTroops: 2000,
  targetTroops: 200,
  competitorTroops: 3000,
  contestPressure: directRace,
});
assert.equal(normalCommit, 1000);
assert.ok(contestedCommit > normalCommit);
assert.ok(contestedCommit <= 8000);

const waterGraph = new Map([
  [0, [1]],
  [1, [0, 2]],
  [2, [1, 3]],
  [3, [2, 4]],
  [4, [3, 5]],
  [5, [4]],
]);
assert.equal(
  sandbox.findWaterRouteTicks({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    maxTicks: 300,
  }),
  5,
);
assert.equal(
  sandbox.findWaterRouteTicks({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    maxTicks: 4,
  }),
  null,
);
assert.equal(
  sandbox.findWaterRouteTicks({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    speed: 2,
    maxTicks: 3,
  }),
  3,
);
assert.equal(
  sandbox.findWaterRouteTicks({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    speed: 2,
    maxTicks: 2,
  }),
  null,
);
assert.equal(sandbox.transportRouteTicks([0, 1, 2, 3], { speed: 2 }), 2);
assert.equal(sandbox.transportRouteTicks([0, 1, 2, 3], { ticksPerMove: 2 }), 6);

const routeSandbox = {};
const routeSrc = {
  neighbors: (tile) => waterGraph.get(tile) || [],
  isWater: (tile) => tile >= 1 && tile <= 4,
  isLand: (tile) => tile === 0 || tile === 5,
  isShore: (tile) => tile === 0 || tile === 5,
  ownerID: (tile) => (tile === 5 ? 2 : tile === 0 ? 1 : 0),
  manhattanDist: (a, b) => Math.abs(a - b),
  transportShipSpeed: 2,
};
vm.runInNewContext(`${gameApiSource}\n${source}`, routeSandbox, {
  filename: "gameApi+earlyGame.js",
});
const routeApi = routeSandbox.createGameApi(routeSrc);
const routePlayer = routeApi.wrapPlayer({
  isPlayer: () => true,
  smallID: () => 1,
  id: () => "p1",
  bestTransportShipSpawn: () => Promise.resolve(0),
});
assert.equal(await routePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await routeApi.game.estimateTransportRouteTicks(5), 3);
assert.equal(routeApi.game.hasTransportRouteEstimator, true);

assert.match(attackSource, /getEarlyGameFreeLandCommitTroops\(earlyLandPlan\)/);
assert.match(attackSource, /const expansionPriorityPending/);
assert.match(
  attackSource,
  /const expansionPriorityPending[\s\S]*?if \(expansionPriorityPending\) return;[\s\S]*?maybeOpportunisticBoat/,
);
assert.match(
  attackSource,
  /if \(expansionPriorityPending\) return;[\s\S]*?\[Takeover\] disconnected neighbour/,
);
assert.match(attackSource, /async allowEarlyGameBoat\(tile\)/);
assert.match(attackSource, /!state\.settings\.winFixes \|\| !early \|\| !early\.active/);
assert.match(attackSource, /EARLY_TRIBE_BORDER_FETCH_CONCURRENCY/);
assert.match(attackSource, /openingLandBurst/);
assert.match(attackSource, /state\.settings\.winFixes && botTarget/);
assert.match(attackSource, /calculateBotAttackTroops\(/);
assert.match(attackSource, /attackEarlyGameTribe/);
assert.match(attackSource, /maybeEarlyOceanBoat/);
assert.match(attackSource, /game\.isOcean/);
assert.match(attackSource, /game\.isOceanShore/);
assert.doesNotMatch(attackSource, /isEarlyGameMapEdge/);
assert.match(attackSource, /calculateEarlyGameExpansionPlan/);
assert.match(attackSource, /frontierCompetitionScore/);
assert.match(attackSource, /plannedTroops/);
assert.match(attackSource, /getEarlyGameLiveReserveTroops/);
assert.match(attackSource, /getEarlyGameProbeTroops/);
assert.doesNotMatch(attackSource, /boatProbeMinTroops/);
assert.doesNotMatch(coreSource, /boatProbeMinTroops/);
assert.match(attackSource, /getAutoDonateExpansionStatus/);
assert.match(attackSource, /pauseDonateDuringExpansion/);
assert.match(attackSource, /estimateEarlyGameTribeBoatEta/);
assert.match(attackSource, /boatEtaTicks <= getAutoDonateExpansionTickLimit\(\)/);
assert.match(coreSource, /pauseDonateDuringExpansion: true/);
assert.match(panelSource, /data-cfg="pauseDonateDuringExpansion"/);
assert.match(panelSource, /ab-feat-mini\.paused/);
assert.match(nationSource, /openingLandBurstPending/);
assert.match(nationSource, /openingWinFix \? 0\.6 : 0\.5/);
assert.match(nationSource, /openingAttackSent/);
assert.match(nationSource, /openingWinFix && !openingAttackSent/);
assert.match(nationSource, /nextExpansionTick/);
assert.match(attackSource, /rankTeamDonationCandidates\(needy\)/);
assert.match(attackSource, /playersShareClanTag/);
assert.match(gameApiSource, /estimateTransportRouteTicks/);
assert.match(gameApiSource, /hasTransportRouteEstimator/);
assert.match(gameApiSource, /findWaterRouteTicks\(\{/);
assert.match(gameApiSource, /transportShipSpeed/);
assert.match(source, /transportPathStepsToTicks/);
assert.match(buildSource, /"auto-bot\/earlyGame\.js"/);

// Integration probe: the real AttackBehavior enrichment must expose the same
// coast/encirclement/blocking signals used by the pure ranker.
const targetSandbox = {
  UNIT: {
    City: "City",
    DefensePost: "Defense Post",
    SAMLauncher: "SAM Launcher",
    MissileSilo: "Missile Silo",
    Port: "Port",
    Factory: "Factory",
  },
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  state: { settings: { winFixes: true, features: { boat: true } }, earlyGame: {}, stats: {} },
  withTimeout: (value) => Promise.resolve(value),
  WORKER_TIMEOUT_MS: 1000,
};
const targetCoords = new Map([
  [1, [0, 0]],
  [10, [5, 0]],
  [20, [80, 80]],
  [21, [79, 80]],
  [22, [81, 80]],
  [30, [80, 81]],
]);
const targetLand = new Set([1, 10, 20, 21, 22, 30]);
const targetNeighbors = new Map([
  [1, []],
  [10, []],
  [20, [21, 22, 30]],
  [21, [20]],
  [22, [20]],
  [30, [20]],
]);
const targetOwners = new Map([
  [1, 1],
  [21, 1],
  [22, 3],
  [30, 5],
]);
const makeTargetPlayer = (sid, type, tiles, troops, location) => ({
  isPlayer: () => true,
  isAlive: () => true,
  type: () => type,
  smallID: () => sid,
  id: () => `p${sid}`,
  troops: () => troops,
  numTilesOwned: () => tiles.length,
  borderTiles: () => new Set(tiles),
  nameLocation: () => location,
  nearby: () => [],
  isFriendly: () => false,
  incomingAttacks: () => [],
  outgoingAttacks: () => [],
});
const targetMe = makeTargetPlayer(1, "Human", [1], 1000, { x: 0, y: 0 });
const targetCoastal = makeTargetPlayer(2, "Bot", [10], 100, { x: 5, y: 0 });
const targetInland = makeTargetPlayer(4, "Bot", [20], 100, { x: 80, y: 80 });
const targetNext = makeTargetPlayer(5, "Bot", [30], 80, { x: 80, y: 81 });
const targetContender = makeTargetPlayer(3, "Human", [22], 500, { x: 81, y: 80 });
let moverLocation = { x: 10, y: 10 };
let moverTiles = 5;
const targetMover = makeTargetPlayer(6, "Human", [], 300, moverLocation);
targetMover.nameLocation = () => moverLocation;
targetMover.numTilesOwned = () => moverTiles;
const targetRaceAttack = {
  attacker: () => targetContender,
  target: () => targetInland,
  troops: () => 450,
};
targetContender.outgoingAttacks = () => [targetRaceAttack];
targetInland.incomingAttacks = () => [targetRaceAttack];
targetMe.nearby = () => [targetCoastal, targetInland, targetNext];
const targetGame = {
  players: () => [targetMe, targetCoastal, targetInland, targetNext, targetContender, targetMover],
  ensureBorderTiles: (player) => player.borderTiles(),
  neighbors: (tile) => targetNeighbors.get(tile) || [],
  isLand: (tile) => targetLand.has(tile),
  ownerID: (tile) => targetOwners.get(tile) ?? null,
  isOceanShore: (tile) => tile === 10,
  ref: (x, y) => {
    for (const [tile, point] of targetCoords) {
      if (point[0] === x && point[1] === y) return tile;
    }
    return null;
  },
  x: (tile) => targetCoords.get(tile)?.[0] ?? 0,
  y: (tile) => targetCoords.get(tile)?.[1] ?? 0,
  manhattanDist: (a, b) =>
    Math.abs((targetCoords.get(a)?.[0] ?? 0) - (targetCoords.get(b)?.[0] ?? 0)) +
    Math.abs((targetCoords.get(a)?.[1] ?? 0) - (targetCoords.get(b)?.[1] ?? 0)),
  isValidCoord: () => true,
};
targetSandbox.calculateBoundingBoxCenter = (game, tiles) => {
  const values = Array.from(tiles);
  return {
    x: values.reduce((sum, tile) => sum + game.x(tile), 0) / values.length,
    y: values.reduce((sum, tile) => sum + game.y(tile), 0) / values.length,
  };
};
vm.runInNewContext(
  `${source}\n${attackSource}\nglobalThis.AttackBehavior = AttackBehavior;`,
  targetSandbox,
  { filename: "earlyGame+attackBehavior.js" },
);
assert.equal(typeof targetSandbox.rankTeamDonationCandidates, "function");
const rankedDonationCandidates = targetSandbox.rankTeamDonationCandidates([
  { id: "same-clan-rear", sameClan: true, frontline: false, troopPercentage: 0.75 },
  { id: "other-frontline", sameClan: false, frontline: true, troopPercentage: 0.1 },
  { id: "same-clan-front", sameClan: true, frontline: true, troopPercentage: 0.5 },
  { id: "other-rear", sameClan: false, frontline: false, troopPercentage: 0.2 },
]);
assert.deepEqual(
  rankedDonationCandidates.map((candidate) => candidate.id),
  ["same-clan-front", "same-clan-rear", "other-frontline", "other-rear"],
);
targetSandbox.__OFHSpawnObjective = {
  getPlayerClanTag: (player) => player?.tag ?? null,
  sameClanTag: (left, right) =>
    typeof left === "string" && left.toUpperCase() === String(right).toUpperCase(),
};
assert.equal(targetSandbox.playersShareClanTag({ tag: "FOX" }, { tag: "fox" }), true);
assert.equal(targetSandbox.playersShareClanTag({ tag: "FOX" }, { tag: "WOLF" }), false);
const targetBehavior = new targetSandbox.AttackBehavior(
  {},
  targetGame,
  targetMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const enrichedTargets = await targetBehavior.getEarlyGameTribeCandidates();
const rankedEnrichedTargets = targetSandbox.rankEarlyGameTribeCandidates(enrichedTargets);
assert.equal(rankedEnrichedTargets[0].id, 2);
assert.equal(rankedEnrichedTargets[0].maritimeDistance, 0);
assert.equal(rankedEnrichedTargets[0].oceanDistance, 0);
const enrichedInland = enrichedTargets.find((target) => target.id === 4);
assert.equal(enrichedInland.maritimeDistance, Infinity);
assert.equal(enrichedInland.encirclement, 1 / 3);
assert.ok(enrichedInland.blockValue > 0);
assert.equal(enrichedInland.futureFoodCount, 1);
assert.ok(enrichedInland.futureFoodAccess > 0.6);
assert.ok(enrichedInland.foodRaceValue > 0.5);

// A crowded nearby sample must not hide a direct frontier tribe behind remote
// candidates. The direct target is deliberately placed after nine remote bots;
// the bounded enrichment window must still retain it.
const originalTargetNearby = targetMe.nearby;
targetMe.sharesBorderWith = (target) => target?.smallID?.() === 4;
const remoteTribes = Array.from({ length: 9 }, (_, index) => {
  const sid = 100 + index;
  return {
    ...targetInland,
    smallID: () => sid,
    id: () => `p${sid}`,
    nameLocation: () => ({ x: 200 + index, y: 200 + index }),
    borderTiles: () => new Set([30]),
  };
});
targetMe.nearby = () => [...remoteTribes, targetInland];
const boundedTargets = await targetBehavior.getEarlyGameTribeCandidates();
assert.ok(
  boundedTargets.some((target) => target.id === 4),
  "a direct frontier tribe must survive the nearby candidate cap",
);
targetMe.nearby = originalTargetNearby;

// Integration probe: only the largest connected navigable water surface counts
// as maritime. The smaller component deliberately touches the map edge so the
// old edge-based heuristic would incorrectly select it.
const maritimeLand = new Set([2, 3, 20, 21]);
const maritimeWater = new Set([0, 1, 22, 23, 24, 25]);
const maritimeNeighbors = new Map([
  [0, [1]],
  [1, [0]],
  [2, [1, 3]],
  [3, [2]],
  [20, [21]],
  [21, [20, 22]],
  [22, [21, 23]],
  [23, [22, 24]],
  [24, [23, 25]],
  [25, [24]],
]);
const maritimeGame = {
  width: () => 10,
  height: () => 5,
  x: (tile) => tile % 10,
  y: (tile) => Math.floor(tile / 10),
  neighbors: (tile) => maritimeNeighbors.get(tile) || [],
  isLand: (tile) => maritimeLand.has(tile),
  isWater: (tile) => maritimeWater.has(tile),
  isOcean: (tile) => tile >= 22 && tile <= 25,
  isOceanShore: (tile) => tile === 21,
  isShore: (tile) => tile === 2 || tile === 21,
};
const maritimeBehavior = new targetSandbox.AttackBehavior(
  {},
  maritimeGame,
  {},
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(maritimeBehavior.isEarlyGameMaritimeWater(22), true);
assert.equal(maritimeBehavior.isEarlyGameMaritimeWater(0), false);
assert.equal(
  maritimeBehavior.getEarlyGameMaritimeDistance(new Set([20])),
  1,
  "the largest connected navigable water component must count as maritime",
);
assert.equal(
  maritimeBehavior.getEarlyGameMaritimeDistance(new Set([3])),
  Infinity,
  "a smaller water component must not count as maritime even when it touches the map edge",
);
assert.equal(
  maritimeBehavior.getEarlyGameMaritimeIndex(),
  maritimeBehavior.getEarlyGameMaritimeIndex(),
  "the maritime distance field must be reused after it is built",
);
const sharedMaritimeBehavior = new targetSandbox.AttackBehavior(
  {},
  maritimeGame,
  {},
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(
  sharedMaritimeBehavior.getEarlyGameMaritimeIndex(),
  maritimeBehavior.getEarlyGameMaritimeIndex(),
  "the maritime distance field must be shared across behaviors for one map",
);
assert.ok(
  targetBehavior.applyEarlyGameRaceTroops({
    target: targetInland,
    baseTroops: 100,
    reserveTroops: 200,
    earlyGameCandidate: enrichedInland,
  }) > 100,
);

moverLocation = { x: 60, y: 60 };
moverTiles = 20;
targetGame.ticks = () => 50;
const movedEnrichedTargets = await targetBehavior.getEarlyGameTribeCandidates();
const movedInland = movedEnrichedTargets.find((target) => target.id === 4);
assert.ok(movedInland.competitorProgress > 0);
assert.ok(movedInland.competitorVector > 0.5);

console.log("early-game tests passed");
