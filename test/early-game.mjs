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
const gameApiSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/gameApi.js"),
  "utf8",
);
const nationExecutionSource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/auto-bot/nationExecution.js"),
  "utf8",
);
const buildSource = fs.readFileSync(path.join(repoRoot, "build.mjs"), "utf8");
const coreSource = fs.readFileSync(path.join(repoRoot, "engine/ingame/auto-bot/core.js"), "utf8");

assert.equal(typeof sandbox.createEarlyGameSnapshot, "function");
assert.equal(typeof sandbox.chooseEarlyGameAction, "function");
assert.equal(typeof sandbox.isEarlyGameBoatEta, "function");
assert.equal(typeof sandbox.getAutoDonateExpansionStatus, "function");
assert.equal(typeof sandbox.findWaterRouteTicks, "function");
assert.equal(typeof sandbox.transportRouteTicks, "function");
assert.equal(typeof sandbox.findNearestMaritimeCoastDistance, "function");
assert.equal(typeof sandbox.findNearestOceanCoastDistance, "function");
assert.equal(typeof sandbox.buildMaritimeDistanceIndex, "function");
assert.equal(typeof sandbox.lookupMaritimeDistanceIndex, "function");
assert.equal(typeof sandbox.rankEarlyGameTribeCandidates, "function");
assert.equal(typeof sandbox.calculateEarlyGameTribeUtility, "function");
assert.equal(typeof sandbox.isEarlyGameTribeActionable, "function");
assert.equal(typeof sandbox.calculateEarlyGameContinuationValue, "function");
assert.equal(typeof sandbox.calculateEarlyGameFoodRaceValue, "function");
assert.equal(typeof sandbox.calculateEarlyGameRaceTroops, "function");
assert.match(
  nationExecutionSource,
  /const openingAttackSent = await [\s\S]{0,300}forceSendAttack/,
  "the opening burst must report whether an attack was actually emitted",
);
assert.match(
  nationExecutionSource,
  /this\.openingLandBurstPending = openingWinFix && !openingAttackSent/,
  "a failed opening burst must retain the immediate retry path",
);
assert.match(
  nationExecutionSource,
  /openingCommitFraction = openingWinFix[\s\S]{0,120}EARLY_EXPAND_COMMIT[\s\S]{0,80}0\.5/,
  "the opening attack must use the win-fix commit while faithful mode keeps 50%",
);
assert.match(
  nationExecutionSource,
  /this\.openingExpansionFollowUpPending =\s*openingWinFix && openingAttackSent/,
  "a successful opening burst must schedule a reconciled follow-up",
);
assert.match(
  attackSource,
  /getRadioactiveTerraNulliusCommitFraction\(\)/,
  "radioactive TerraNullius must derive its own commit ratio",
);
assert.match(
  attackSource,
  /radioactiveCommitTroops[\s\S]{0,1400}targetSpendableTroops/,
  "radioactive land attacks must be capped by the derived ratio",
);

const openingCalls = [];
const openingFractions = [];
let openingFollowUps = 0;
const NoopBehavior = class {};
const openingSandbox = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  UNIT: { Port: "Port", Warship: "Warship" },
  EARLY_EXPAND_COMMIT: 0.6,
  currentDifficulty: () => "Impossible",
  simpleHash: () => 1,
  PseudoRandom: class {
    nextInt(min) {
      return min;
    }
  },
  autoBotProfileAsyncPhase: (_profile, _label, callback) => callback(),
  autoBotProfileSyncPhase: (_profile, _label, callback) => callback(),
  tr: (value) => value,
  console,
  state: {
    settings: {
      winFixes: true,
      features: {
        spawn: false,
        expand: true,
        boat: false,
        warship: false,
        build: false,
        alliance: false,
        nuke: false,
      },
    },
  },
  EmojiBehavior: NoopBehavior,
  MirvBehavior: NoopBehavior,
  AllianceBehavior: NoopBehavior,
  WarshipBehavior: NoopBehavior,
  NukeBehavior: NoopBehavior,
  StructureBehavior: NoopBehavior,
  AttackBehavior: class {
    constructor() {
      this.pending = 0;
    }

    forceSendAttack(_target, fraction) {
      openingCalls.push(arguments.length - 1);
      openingFractions.push(fraction);
      this.pending = 1;
      return true;
    }

    getPendingOutboundAttackTroops() {
      return this.pending;
    }

    maybeAttack() {
      openingFollowUps += 1;
    }
  },
};
const openingPlayer = {
  hasSpawned: () => true,
  isAlive: () => true,
  unitsConstructed: () => false,
};
const openingGame = {
  myPlayer: () => openingPlayer,
  inSpawnPhase: () => false,
  terraNullius: () => ({ id: () => "TerraNullius" }),
  config: () => ({ isUnitDisabled: () => false }),
};
vm.runInNewContext(`${nationExecutionSource}\nglobalThis.NationBot = NationBot;`, openingSandbox, {
  filename: path.join(repoRoot, "engine/ingame/auto-bot/nationExecution.js"),
});
const openingBot = new openingSandbox.NationBot(openingGame, {
  playerId: "opening-player",
  gameId: "opening-game",
});
await openingBot.tick(0);
assert.equal(
  openingCalls[0],
  1,
  "the first live TerraNullius burst passes its opening commit to AttackBehavior",
);
assert.equal(
  openingFractions[0],
  0.6,
  "the first live TerraNullius burst uses the configured 60% commit",
);
assert.equal(
  openingBot.openingExpansionFollowUpPending,
  true,
  "a successful burst schedules a follow-up",
);
await openingBot.tick(1);
assert.equal(
  openingFollowUps,
  0,
  "the follow-up waits for the opening intent without duplicating it",
);
assert.equal(openingCalls.length, 1, "the pending opening intent is not emitted twice");
openingBot.attackBehavior.pending = 0;
await openingBot.tick(2);
assert.equal(
  openingFollowUps,
  1,
  "the follow-up runs on the next reconciled tick instead of attackRate",
);
assert.equal(openingBot.openingExpansionFollowUpPending, false);

// Polling must not rerun the full decision chain. Win-fix keeps the old 0.6
// combat cadence scale, so a 30-tick Impossible attack rate becomes 18 ticks.
const cadenceCalls = [];
const CadenceNoopBehavior = class {
  maybeSendCasualEmoji() {}
  handleAllianceRequestsFromBots() {}
  handleAllianceRequests() {}
  handleAllianceExtensionRequests() {}
};
const cadenceSandbox = {
  Difficulty: openingSandbox.Difficulty,
  UNIT: openingSandbox.UNIT,
  EARLY_EXPAND_COMMIT: 0.6,
  currentDifficulty: () => "Impossible",
  simpleHash: () => 1,
  PseudoRandom: class {
    nextInt(min) {
      return min;
    }
  },
  autoBotProfileAsyncPhase: (_profile, _label, callback) => callback(),
  autoBotProfileSyncPhase: (_profile, _label, callback) => callback(),
  tr: (value) => value,
  console,
  state: {
    settings: {
      winFixes: true,
      combatCadenceScale: 0.6,
      features: {
        spawn: false,
        expand: true,
        boat: false,
        warship: false,
        build: false,
        alliance: false,
        nuke: false,
        embargo: false,
        donate: false,
      },
    },
  },
  EmojiBehavior: CadenceNoopBehavior,
  MirvBehavior: CadenceNoopBehavior,
  AllianceBehavior: CadenceNoopBehavior,
  WarshipBehavior: CadenceNoopBehavior,
  NukeBehavior: CadenceNoopBehavior,
  StructureBehavior: CadenceNoopBehavior,
  AttackBehavior: class {
    forceSendAttack() {
      return false;
    }

    getPendingOutboundAttackTroops() {
      return 0;
    }

    maybeAttack() {
      cadenceCalls.push("attack");
    }
  },
};
const cadencePlayer = {
  hasSpawned: () => true,
  isAlive: () => true,
};
const cadenceGame = {
  myPlayer: () => cadencePlayer,
  inSpawnPhase: () => false,
  players: () => [],
  terraNullius: () => ({ id: () => "TerraNullius" }),
  config: () => ({ isUnitDisabled: () => false }),
};
vm.runInNewContext(`${nationExecutionSource}\nglobalThis.NationBot = NationBot;`, cadenceSandbox, {
  filename: path.join(repoRoot, "engine/ingame/auto-bot/nationExecution-cadence.js"),
});
const cadenceBot = new cadenceSandbox.NationBot(cadenceGame, {
  playerId: "cadence-player",
  gameId: "cadence-game",
});
await cadenceBot.tick(0);
await cadenceBot.tick(1);
await cadenceBot.tick(2);
assert.equal(
  cadenceCalls.length,
  1,
  "win-fix polling must not repeat the full combat chain before its cadence crossing",
);
await cadenceBot.tick(18);
assert.equal(
  cadenceCalls.length,
  2,
  "win-fix combat uses the scaled attackRate cadence instead of every poll",
);

assert.equal(sandbox.isEarlyGameBoatEta(300), true);
assert.equal(sandbox.isEarlyGameBoatEta(301), false);
assert.equal(sandbox.isEarlyGameBoatEta(null), false);

const assertExpansionStatus = (input, expected, message) => {
  const actual = sandbox.getAutoDonateExpansionStatus(input);
  assert.equal(actual.active, expected.active, message);
  assert.equal(actual.reason, expected.reason, message);
  assert.equal(actual.maxTicks, expected.maxTicks, message);
};

assertExpansionStatus(
  { active: true, hasFreeLand: true, actionableTribes: [] },
  { active: true, reason: "free-land", maxTicks: 30 },
  "free land pauses donations during the opening expansion window",
);
assertExpansionStatus(
  {
    active: true,
    hasFreeLand: false,
    actionableTribes: [{ landBorder: true }],
  },
  { active: true, reason: "land-tribe", maxTicks: 30 },
  "a land-border tribe pauses donations",
);
assertExpansionStatus(
  {
    active: true,
    hasFreeLand: false,
    actionableTribes: [{ landBorder: false, boatEtaTicks: 30 }],
  },
  { active: true, reason: "sea-tribe", maxTicks: 30 },
  "a sea tribe inside the transport-time window pauses donations",
);
assertExpansionStatus(
  {
    active: true,
    hasFreeLand: false,
    actionableTribes: [{ landBorder: false, boatEtaTicks: 31 }],
  },
  { active: false, reason: null, maxTicks: 30 },
  "a sea tribe outside the transport-time window does not pause donations",
);
assertExpansionStatus(
  {
    active: false,
    hasFreeLand: true,
    actionableTribes: [{ landBorder: true }],
  },
  { active: false, reason: null, maxTicks: 30 },
  "pre-spawn snapshots never pause donations",
);

assert.match(
  coreSource,
  /pauseDonateDuringExpansion:\s*true/,
  "the pause setting has a stable default",
);
assert.match(coreSource, /\"pauseDonateDuringExpansion\"/, "the pause setting is persisted");

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
  ["border-tribe", "near-tribe"],
  "a sea tribe needs a measured route; proximity alone is not actionable",
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
    landBorder: true,
    maritimeDistance: Infinity,
    encirclement: 1,
    blockValue: 0.1,
    captureEfficiency: 0.9,
    futureFoodAccess: 0.3,
    distance: 3,
  },
  {
    id: "coastal-open",
    landBorder: false,
    boatEtaTicks: 60,
    maritimeDistance: 0,
    encirclement: 0,
    blockValue: 0,
    captureEfficiency: 0.2,
    distance: 20,
  },
  {
    id: "coastal-contested",
    landBorder: false,
    boatEtaTicks: 40,
    maritimeDistance: 0,
    encirclement: 0.8,
    blockValue: 1,
    captureEfficiency: 0.7,
    futureFoodAccess: 0.4,
    foodRaceValue: 0.8,
    distance: 8,
  },
]);
assert.deepEqual(
  rankedTribes.map((candidate) => candidate.id),
  ["coastal-contested", "encircled-inland", "coastal-open"],
);

const maritimeRouteRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "river-route",
    landBorder: false,
    boatEtaTicks: 120,
    maritimeDistance: 4,
    futureFoodAccess: 0.1,
    captureEfficiency: 0.2,
  },
  {
    id: "interior-shortcut",
    landBorder: true,
    maritimeDistance: Infinity,
    futureFoodAccess: 1,
    captureEfficiency: 1,
  },
]);
assert.equal(
  maritimeRouteRank[0].id,
  "interior-shortcut",
  "maritime access must not automatically beat a much better land capture",
);

const actionableRouteRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "unknown-route",
    landBorder: false,
    boatEtaTicks: null,
    maritimeDistance: 0,
    captureEfficiency: 1,
  },
  {
    id: "slow-route",
    landBorder: false,
    boatEtaTicks: 301,
    maritimeDistance: 0,
    captureEfficiency: 1,
  },
  {
    id: "verified-land",
    landBorder: true,
    maritimeDistance: Infinity,
    captureEfficiency: 0.1,
  },
]);
assert.deepEqual(
  actionableRouteRank.map((candidate) => candidate.id),
  ["verified-land"],
  "unknown and over-30-second sea routes are not actionable tribe targets",
);

const balancedOpportunityRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "ordinary-land",
    landBorder: true,
    captureEfficiency: 0.8,
    futureFoodAccess: 0.1,
    encirclement: 0.1,
    blockValue: 0.1,
    maritimeDistance: Infinity,
  },
  {
    id: "high-value-coast",
    landBorder: false,
    boatEtaTicks: 30,
    maritimeDistance: 0,
    futureFoodAccess: 0.9,
    foodRaceValue: 0.8,
    encirclement: 0.8,
    blockValue: 0.7,
    cheapCapture: 0.8,
    captureEfficiency: 0.8,
  },
]);
assert.equal(
  balancedOpportunityRank[0].id,
  "high-value-coast",
  "a verified maritime target can win when its total strategic value is higher",
);

const captureEfficiencyRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "small-expensive",
    landBorder: true,
    captureEfficiency: 0.2,
  },
  {
    id: "large-efficient",
    landBorder: true,
    captureEfficiency: 1,
  },
]);
assert.equal(
  captureEfficiencyRank[0].id,
  "large-efficient",
  "land gained per defending troop is part of the target utility",
);

const directRaceRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "direct-race",
    landBorder: true,
    directAttackers: 1,
    captureEfficiency: 0.5,
    encirclement: 0.5,
    futureFoodAccess: 0.5,
  },
  {
    id: "uncontested-peer",
    landBorder: true,
    directAttackers: 0,
    captureEfficiency: 0.5,
    encirclement: 0.5,
    futureFoodAccess: 0.5,
  },
]);
assert.equal(
  directRaceRank[0].id,
  "direct-race",
  "a direct rival attack raises urgency without becoming an absolute override",
);

const movementRaceRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "steady-frontier",
    landBorder: true,
    encirclement: 0.4,
    blockValue: 0.4,
    futureFoodAccess: 0.5,
    foodRaceValue: 0,
    captureEfficiency: 0.5,
  },
  {
    id: "moving-rival-frontier",
    landBorder: true,
    encirclement: 0.4,
    blockValue: 0.4,
    futureFoodAccess: 0.5,
    foodRaceValue: 0.8,
    competitorVector: 0.9,
    captureEfficiency: 0.5,
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
  futureFoodChainRadius: 120,
});
const isolatedCandidate = sandbox.calculateEarlyGameContinuationValue({
  futureFoodCount: 0,
  futureFoodTotal: 3,
  meanFutureFoodDistance: Infinity,
  futureFoodChainRadius: 120,
});
assert.equal(chainCandidate, 1);
assert.equal(isolatedCandidate, 0);

assert.equal(
  sandbox.calculateEarlyGameContinuationValue({
    futureFoodCount: 3,
    futureFoodTotal: 3,
    meanFutureFoodDistance: 60,
    futureFoodChainRadius: 120,
  }),
  0.5,
  "continuation value combines count and proximity without arbitrary weights",
);

const chainRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "isolated-coast",
    landBorder: false,
    boatEtaTicks: 60,
    maritimeDistance: 0,
    captureEfficiency: 0.5,
    futureFoodAccess: isolatedCandidate,
    foodRaceValue: 1,
  },
  {
    id: "food-chain",
    landBorder: false,
    boatEtaTicks: 60,
    maritimeDistance: 0,
    captureEfficiency: 0.5,
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
assert.equal(directRace, 1);

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

const routeSandbox = {};
const routeSrc = {
  neighbors: (tile) => waterGraph.get(tile) || [],
  isWater: (tile) => tile >= 1 && tile <= 4,
  isLand: (tile) => tile === 0 || tile === 5,
  isShore: (tile) => tile === 0 || tile === 5,
  ownerID: (tile) => (tile === 5 ? 2 : tile === 0 ? 1 : 0),
  manhattanDist: (a, b) => Math.abs(a - b),
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
assert.equal(await routeApi.game.estimateTransportRouteTicks(5), 5);
assert.equal(routeApi.game.hasTransportRouteEstimator, true);

assert.match(attackSource, /landTarget: hasAccessibleFreeLand/);
assert.match(attackSource, /async allowEarlyGameBoat\(tile\)/);
assert.match(attackSource, /!state\.settings\.winFixes \|\| !early \|\| !early\.active/);
assert.match(attackSource, /EARLY_EXPAND_COMMIT/);
assert.match(attackSource, /attackEarlyGameTribe/);
assert.match(attackSource, /maybeEarlyOceanBoat/);
assert.match(attackSource, /rankTeamDonationCandidates\(needy\)/);
assert.match(attackSource, /playersShareClanTag/);
assert.match(
  attackSource,
  /getAutoDonateExpansionStatus\(state\.earlyGame\)/,
  "the real donation path consults the expansion pause gate",
);
assert.match(
  attackSource,
  /estimateEarlyGameTribeBoatEta/,
  "maritime tribe pause state uses a bounded route estimate",
);
assert.match(
  attackSource,
  /boatEtaTicks/,
  "maritime tribe ETA is retained in the live expansion snapshot",
);
assert.match(gameApiSource, /estimateTransportRouteTicks/);
assert.match(gameApiSource, /hasTransportRouteEstimator/);
assert.match(gameApiSource, /findWaterRouteTicks\(\{/);

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
  EARLY_EXPAND_COMMIT: 0.6,
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
targetMe.bestTransportShipSpawn = () => Promise.resolve(1);
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
  hasTransportRouteEstimator: true,
  estimateTransportRouteTicks: (tile) => (tile === 10 ? 20 : null),
  ensureBorderTiles: (player) => player.borderTiles(),
  neighbors: (tile) => targetNeighbors.get(tile) || [],
  isLand: (tile) => targetLand.has(tile),
  isShore: (tile) => tile === 1 || tile === 10,
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

// TerraNullius expansion must use the engine's real attackLogic loss for the
// first frontier tile. Normal land expansion and targeted transport probes use
// that one-tile cost; only the first live opening may request a larger burst.
const minimumTerraNulliusBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
minimumTerraNulliusBehavior.player = {
  troops: () => 100000,
  type: () => targetSandbox.PlayerType.Human,
  borderTiles: () => new Set([1]),
};
minimumTerraNulliusBehavior.game = {
  neighbors: (tile) => (tile === 1 ? [2, 3] : []),
  isLand: () => true,
  hasOwner: () => false,
  magnitude: (tile) => (tile === 2 ? 8 : 25),
  hasFallout: () => false,
  config: () => ({
    attackLogic: (_game, _troops, _attacker, _defender, tile) => ({
      attackerTroopLoss: tile === 2 ? 16 : 24,
    }),
  }),
};
minimumTerraNulliusBehavior.getEarlyGameTerraNulliusReserveTroops = () => 1000;
minimumTerraNulliusBehavior.getEarlyGameSpendableTroops = () => 99000;
const minimumTerraNulliusTarget = { isPlayer: () => false };
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(minimumTerraNulliusTarget),
  24,
  "TerraNullius land attacks use the worst one-tile attackLogic loss",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(minimumTerraNulliusTarget, 2),
  16,
  "a targeted TerraNullius landing uses only that tile's calculated loss",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(minimumTerraNulliusTarget, null, 99000),
  24,
  "a normal TerraNullius land burst stays at the one-tile cost",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(
    minimumTerraNulliusTarget,
    null,
    99000,
    0.6,
  ),
  60000,
  "the opening TerraNullius burst can commit above the one-tile cost",
);

const radioactiveBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let radioactiveTiles = 0;
radioactiveBehavior.player = { troops: () => 25000 };
radioactiveBehavior.game = {
  numLandTiles: () => 100000,
  numTilesWithFallout: () => radioactiveTiles,
};
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusFalloutDefenseMultiplier(),
  5,
  "low fallout coverage uses the engine's maximum radioactive defense multiplier",
);
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusCommitFraction(),
  0.12,
  "radioactive TerraNullius uses 60% divided by its 5x troop cost",
);
radioactiveTiles = 50000;
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusFalloutDefenseMultiplier(),
  4,
  "the live fallout ratio updates the defense multiplier",
);
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusCommitFraction(),
  0.15,
  "half-map fallout raises the risk-adjusted commit to 15%",
);
targetSandbox.state.settings.winFixes = false;
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusCommitFraction(),
  0.6,
  "faithful mode keeps the normal 60% commit ratio",
);
targetSandbox.state.settings.winFixes = true;

// A directly adjacent free tile must block both tribe and enemy food attacks.
// The decision is allowed to return without an attack when troop/intent guards
// reject the free-land attempt; it must never fall through to a paid target in
// that same snapshot.
const priorityFreeTarget = { isPlayer: () => false };
const priorityTribe = {
  isPlayer: () => true,
  isAlive: () => true,
  type: () => targetSandbox.PlayerType.Bot,
  smallID: () => 2,
  troops: () => 50,
  isFriendly: () => false,
};
const priorityEnemy = {
  isPlayer: () => true,
  isAlive: () => true,
  type: () => targetSandbox.PlayerType.Human,
  smallID: () => 3,
  troops: () => 100,
  isFriendly: () => false,
};
const priorityPlayer = {
  smallID: () => 1,
  type: () => targetSandbox.PlayerType.Human,
  hasSpawned: () => true,
  borderTiles: () => new Set([1]),
  nearby: () => [priorityTribe, priorityEnemy],
  isFriendly: () => false,
};
const priorityGame = {
  inSpawnPhase: () => false,
  neighbors: (tile) => (tile === 1 ? [2, 3] : []),
  isLand: (tile) => tile === 2 || tile === 3,
  ownerID: (tile) => (tile === 3 ? 3 : 0),
  hasOwner: (tile) => tile === 3,
  hasFallout: () => false,
  playerBySmallID: (sid) => (sid === 3 ? priorityEnemy : null),
  terraNullius: () => priorityFreeTarget,
};
const priorityBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
priorityBehavior.player = priorityPlayer;
priorityBehavior.game = priorityGame;
priorityBehavior.allianceBehavior = {};
priorityBehavior.reconcileOutboundAttackIntentCommitments = () => {};
priorityBehavior.cacheEnemyDefensePostFrontTiles = () => {};
priorityBehavior.rankAttackTargets = (players) => players;
const priorityAttackTargets = [];
priorityBehavior.sendAttack = async (target) => {
  priorityAttackTargets.push(target);
  return true;
};
targetSandbox.state.settings.features = {
  expand: true,
  boat: false,
  alliance: false,
};
targetSandbox.state.earlyGame = {};
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityFreeTarget],
  "accessible free land is selected before tribes or human enemies",
);
assert.equal(targetSandbox.state.earlyGame.action, "land");

const enrichedTargets = await targetBehavior.getEarlyGameTribeCandidates();
const rankedEnrichedTargets = targetSandbox.rankEarlyGameTribeCandidates(enrichedTargets);
assert.equal(
  rankedEnrichedTargets[0].id,
  4,
  "the balanced utility can prefer an immediately actionable inland tribe",
);
const enrichedSea = enrichedTargets.find((target) => target.id === 2);
assert.equal(enrichedSea.boatEtaTicks, 20);
assert.ok(
  enrichedSea.boatTargetTile != null,
  "the verified ETA retains the exact target shore used for actuation",
);
assert.equal(enrichedSea.landBorder, false);
assert.equal(enrichedSea.maritimeDistance, 0);
assert.equal(enrichedSea.oceanDistance, 0);
const enrichedInland = enrichedTargets.find((target) => target.id === 4);
assert.equal(enrichedInland.maritimeDistance, Infinity);
assert.equal(enrichedInland.encirclement, 1 / 3);
assert.ok(enrichedInland.blockValue > 0);
assert.ok(enrichedInland.futureFoodCount >= 0);
assert.ok(enrichedInland.futureFoodAccess >= 0);
assert.ok(enrichedInland.futureFoodAccess <= 1);
assert.ok(enrichedInland.foodRaceValue > 0.5);

const maritimeConquestBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
targetSandbox.state.settings.features = {
  ...targetSandbox.state.settings.features,
  boat: true,
};
targetSandbox.closestTwoTiles = () => ({ x: 1, y: 2 });
let maritimeConquestTroops = null;
maritimeConquestBehavior.player = {
  borderTiles: () => new Set([1]),
  bestTransportShipSpawn: async () => 1,
  troops: () => 10000,
  type: () => targetSandbox.PlayerType.Human,
};
maritimeConquestBehavior.game = {
  config: () => ({
    isUnitDisabled: () => false,
    maxTroops: () => 10000,
  }),
  ensureBorderTiles: async () => new Set([2]),
  isShore: () => true,
};
maritimeConquestBehavior.reconcileOutboundAttackIntentCommitments = () => {};
maritimeConquestBehavior.getEnemyDefensePostAttackProfile = () => ({});
maritimeConquestBehavior.getEarlyGameTargetReserveTroops = () => 2000;
maritimeConquestBehavior.getEarlyGameSpendableTroops = () => 8000;
maritimeConquestBehavior.effectiveReserveRatio = () => 0.2;
maritimeConquestBehavior.calculateBotAttackTroops = (_target, available) => {
  assert.equal(available, 8000);
  return 4000;
};
maritimeConquestBehavior.applyEarlyGameRaceTroops = ({ baseTroops }) => baseTroops;
maritimeConquestBehavior.allowEarlyGameBoat = async () => true;
maritimeConquestBehavior.emitBoat = (_tile, troops) => {
  maritimeConquestTroops = troops;
  return true;
};
maritimeConquestBehavior.getEarlyGameProbeTroops = () => {
  throw new Error("a selected maritime tribe must not receive a cheap probe");
};
const maritimeConquestTarget = {
  borderTiles: () => new Set([2]),
  isPlayer: () => true,
  type: () => targetSandbox.PlayerType.Bot,
};
assert.equal(
  await maritimeConquestBehavior.sendBoatAttack(maritimeConquestTarget, {
    id: 2,
    boatTargetTile: 2,
  }),
  true,
);
assert.equal(
  maritimeConquestTroops,
  4000,
  "a selected sea tribe receives a conquest force, not a 1% probe",
);

// Integration probe: ocean-connected water and a river that exits through the
// map edge count as maritime; an isolated inland lake does not.
const maritimeLand = new Set([8, 9, 14, 15, 16]);
const maritimeWater = new Set([10, 11, 12, 17, 18, 19, 20]);
const maritimeNeighbors = new Map([
  [8, [9]],
  [9, [8, 10]],
  [10, [9, 11]],
  [11, [10, 12]],
  [12, [11]],
  [15, [16]],
  [16, [15, 17]],
  [17, [16, 18]],
  [18, [17, 19]],
  [19, [18, 20]],
  [20, [19]],
]);
const maritimeGame = {
  width: () => 7,
  height: () => 5,
  x: (tile) => tile % 7,
  y: (tile) => Math.floor(tile / 7),
  neighbors: (tile) => maritimeNeighbors.get(tile) || [],
  isLand: (tile) => maritimeLand.has(tile),
  isWater: (tile) => maritimeWater.has(tile),
  isOcean: () => false,
  isOceanShore: () => false,
  isShore: (tile) => tile === 9 || tile === 16,
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
assert.equal(
  maritimeBehavior.getEarlyGameMaritimeDistance(new Set([15])),
  1,
  "a river component that exits through the map edge must count as maritime",
);
assert.equal(
  maritimeBehavior.getEarlyGameMaritimeDistance(new Set([8])),
  Infinity,
  "an isolated inland lake must not count as maritime",
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
