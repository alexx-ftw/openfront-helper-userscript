import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "engine/ingame/auto-bot/earlyGame.js");
const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
const sandbox = {};
executeClassicScript(source, sandbox, { filename: sourcePath });
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
const decisionAttackIndex = nationExecutionSource.indexOf(
  'profile, "attack", () => this.attackBehavior.maybeAttack(profile)',
);
const decisionEmbargoIndex = nationExecutionSource.indexOf('profile, "embargo", () =>');
assert.ok(
  decisionAttackIndex >= 0 && decisionAttackIndex < decisionEmbargoIndex,
  "combat must run before low-priority embargo batching",
);
assert.match(
  nationExecutionSource,
  /EMBARGO_INTENTS_PER_DECISION = 2/,
  "a large hostile roster must be drained through a bounded diplomacy quota",
);
assert.match(
  nationExecutionSource,
  /budget\.secondTokens <= 1 \|\| budget\.minuteTokens <= 1/,
  "embargo batching must preserve a strategic intent token without probing a rejected emit",
);
assert.match(
  nationExecutionSource,
  /this\.doSpawn\(topKey\)/,
  "the already-ranked spawn candidate must be handed to the emit path",
);
assert.match(
  nationExecutionSource,
  /computeSpawnTopSpotsForBot\(this\.mg, this\.player, \{ initial: true \}\)/,
  "the first automatic spawn must request the bounded initial ranker",
);
assert.match(
  nationExecutionSource,
  /this\.spawnTopKeyToValidTile\(topKey\) \?\? this\.pickSpawnCenter\(\)/,
  "a reused spawn candidate must be revalidated and retain the full-selector fallback",
);
assert.match(
  nationExecutionSource,
  /if \(!this\.mg\.inSpawnPhase\(\)\) return false;[\s\S]{0,400}if \(this\.player\.hasSpawned\?\.\(\)\) \{[\s\S]{0,160}return true;/,
  "an accepted personal spawn must wait for the global spawn phase to close before initializing attacks",
);
assert.match(
  attackSource,
  /const hasLiveTribe = otherPlayers\.some\(\(player\) =>\s*this\.isLightweightEarlyGameTribe\(player\)\);[\s\S]{0,220}if \(!hasLiveTribe\) \{[\s\S]{0,120}return \[\];[\s\S]{0,140}const competitorProfiles/,
  "a map without edible tribes must bypass expensive competitor and topology work",
);
const tribeClusterOverlaySource = fs.readFileSync(
  path.join(repoRoot, "engine/ingame/tribe-cluster-overlay.js"),
  "utf8",
);
const buildSource = fs.readFileSync(path.join(repoRoot, "build.mjs"), "utf8");
const coreSource = fs.readFileSync(path.join(repoRoot, "engine/ingame/auto-bot/core.js"), "utf8");

assert.doesNotMatch(
  buildSource,
  /@updateURL|@downloadURL/,
  "the CUSTOM build must not auto-update from upstream main and silently replace custom bot behavior",
);
assert.match(
  fs.readFileSync(path.join(repoRoot, "engine/ingame/spawn-heatmap.js"), "utf8"),
  /SPAWN_HEATMAP_INITIAL_BOT_CANDIDATES = 64/,
  "the initial spawn scorer must keep its terrain sample bounded",
);

assert.equal(typeof sandbox.createEarlyGameSnapshot, "function");
assert.equal(typeof sandbox.chooseEarlyGameAction, "function");
assert.equal(typeof sandbox.isEarlyGameBoatEta, "function");
assert.equal(typeof sandbox.isBoatExplorationEta, "function");
assert.equal(typeof sandbox.getAutoDonateExpansionStatus, "function");
assert.equal(typeof sandbox.findWaterRouteTicks, "function");
assert.equal(typeof sandbox.findWaterRouteTicksAsync, "function");
assert.equal(typeof sandbox.transportRouteTicks, "function");
assert.equal(typeof sandbox.findNearestMaritimeCoastDistance, "function");
assert.equal(typeof sandbox.findNearestOceanCoastDistance, "function");
assert.equal(typeof sandbox.buildMaritimeDistanceIndex, "function");
assert.equal(typeof sandbox.lookupMaritimeDistanceIndex, "function");
assert.equal(typeof sandbox.rankEarlyGameTribeCandidates, "function");
assert.equal(typeof sandbox.keepLargestTribeClusterCandidates, "function");
assert.equal(typeof sandbox.calculateEarlyGameTribeUtility, "function");
assert.equal(typeof sandbox.calculateConnectedTribeClusterSizes, "function");
assert.equal(typeof sandbox.calculateTribeAdjacencyClusterSizes, "function");
assert.equal(typeof sandbox.getTribeAdjacencyComponentIds, "function");
assert.equal(typeof sandbox.calculateReachableTribeClusterOpportunities, "function");
assert.equal(typeof sandbox.chooseTribeClusterMarkerCenter, "function");
assert.equal(typeof sandbox.rankEarlyGameTribeSamplingCandidates, "function");
assert.equal(typeof sandbox.isEarlyGameTribeActionable, "function");
assert.equal(typeof sandbox.calculateEarlyGameContinuationValue, "function");
assert.equal(typeof sandbox.calculateEarlyGameFoodRaceValue, "function");
assert.equal(typeof sandbox.calculateEarlyGameRaceTroops, "function");
assert.equal(typeof sandbox.isMuchWeakerAllianceTarget, "function");
assert.equal(sandbox.isBoatExplorationEta(0), true);
assert.equal(sandbox.isBoatExplorationEta(1200), true);
assert.equal(sandbox.isBoatExplorationEta(1201), false);
assert.equal(sandbox.isBoatExplorationEta(null), false);
assert.equal(
  sandbox.isMuchWeakerAllianceTarget({
    ownTroops: 80000,
    ownOutgoingTroops: 20000,
    otherTroops: 20000,
    otherOutgoingTroops: 5000,
  }),
  true,
  "a bordering ally with one quarter of our total force is a conquest target",
);
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
  /if \(livenessAvailable < minimum\) return 0;/,
  "TerraNullius attacks must not emit below the exact first-tile cost",
);
assert.match(
  attackSource,
  /!isParallelTribeAttack[\s\S]{0,120}this\.hasPendingOutboundAttackForTarget\(target\)/,
  "pending attacks must block only duplicate targets, not unrelated expansion",
);
const immediatePriorityStart = attackSource.indexOf("async tryImmediateAttackPriorities(context)");
const reinforcementPriority = attackSource.indexOf(
  "await this.reinforceIncompleteOutboundPlayerAttack()",
  immediatePriorityStart,
);
const terraNulliusPriority = attackSource.indexOf(
  "if (context.hasAccessibleTerraNullius)",
  immediatePriorityStart,
);
assert.ok(
  immediatePriorityStart >= 0 &&
    reinforcementPriority > immediatePriorityStart &&
    terraNulliusPriority > reinforcementPriority,
  "an incomplete conquest must be reinforced before starting TerraNullius expansion",
);

const openingCalls = [];
const openingFractions = [];
let openingFollowUps = 0;
let openingFullPlans = 0;
let openingIncomingAttack = false;
let openingDefenseResponses = 0;
let openingDefenseStructures = 0;
const openingDefenseOrder = [];
const NoopBehavior = class {};
const OpeningStructureBehavior = class {
  handleStructures() {
    openingDefenseStructures += 1;
    openingDefenseOrder.push("structures");
  }
};
const openingSandbox = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  UNIT: { Port: "Port", Warship: "Warship" },
  EARLY_EXPAND_COMMIT: 0.1,
  EARLY_EXPAND_OPENING_LIMIT: 0.4,
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
        build: true,
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
  StructureBehavior: OpeningStructureBehavior,
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

    getPendingTerraNulliusAttackTroops() {
      return this.pending;
    }

    findIncomingAttackPlayer() {
      return openingIncomingAttack ? { smallID: () => 7 } : null;
    }

    respondToIncomingAttack() {
      openingDefenseResponses += 1;
      openingDefenseOrder.push("attack");
      return true;
    }

    continueOpeningExpansion() {
      openingFollowUps += 1;
      this.pending = 1;
      return true;
    }

    maybeAttack() {
      openingFullPlans += 1;
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
executeClassicScript(
  `${nationExecutionSource}\nglobalThis.NationBot = NationBot;`,
  openingSandbox,
  {
    filename: path.join(repoRoot, "engine/ingame/auto-bot/nationExecution.js"),
  },
);
const openingBot = new openingSandbox.NationBot(openingGame, {
  playerId: "opening-player",
  gameId: "opening-game",
});
let delayedOpeningSpawnPhase = true;
const delayedOpeningBot = new openingSandbox.NationBot(
  {
    ...openingGame,
    inSpawnPhase: () => delayedOpeningSpawnPhase,
  },
  {
    playerId: "delayed-opening-player",
    gameId: "delayed-opening-game",
  },
);
const delayedOpeningCallCount = openingCalls.length;
await delayedOpeningBot.tick(0);
assert.equal(
  openingCalls.length,
  delayedOpeningCallCount,
  "an accepted spawn cannot consume the opening Terra Nullius burst while the match is globally frozen",
);
assert.equal(delayedOpeningBot.behaviorsInitialized, false);
delayedOpeningSpawnPhase = false;
await delayedOpeningBot.tick(1);
assert.equal(
  openingCalls.length,
  delayedOpeningCallCount + 1,
  "the first playable tick initializes and emits the protected opening burst immediately",
);
openingCalls.splice(delayedOpeningCallCount);
openingFractions.splice(delayedOpeningCallCount);
const teamSpawnBot = Object.create(openingSandbox.NationBot.prototype);
const teamSpawnPlayer = { smallID: () => 1, team: () => "Red" };
const teamSpawnTeammates = [
  { smallID: () => 2, team: () => "Red" },
  { smallID: () => 3, team: () => "Red" },
  { smallID: () => 4, team: () => "Red" },
];
teamSpawnBot.spawnExecAdded = false;
teamSpawnBot.player = teamSpawnPlayer;
teamSpawnBot.mg = { players: () => [teamSpawnPlayer, ...teamSpawnTeammates] };
let teamSpawnAnchorCount = 0;
openingSandbox.getTeamSpawnAnchorCount = () => teamSpawnAnchorCount;
assert.equal(
  teamSpawnBot.shouldAwaitInitialTeamSpawnGeometry(0),
  true,
  "a team bot must not emit its first spawn before the teammate roster is visible",
);
teamSpawnBot.player = { smallID: () => 1, team: () => null };
assert.equal(
  teamSpawnBot.shouldAwaitInitialTeamSpawnGeometry(0),
  true,
  "the pre-spawn team value can be null, so the discovery window must still prevent a blind spawn",
);
teamSpawnBot.player = teamSpawnPlayer;
assert.equal(
  teamSpawnBot.shouldAwaitInitialTeamSpawnGeometry(6),
  true,
  "a full team must wait until its committed teammate anchors are observable",
);
teamSpawnAnchorCount = 3;
assert.equal(
  teamSpawnBot.shouldAwaitInitialTeamSpawnGeometry(6),
  false,
  "once every teammate anchor exists the normal scored spawn path must proceed",
);
teamSpawnBot.mg = { players: () => [teamSpawnPlayer, ...teamSpawnTeammates.slice(0, 2)] };
teamSpawnAnchorCount = 0;
assert.equal(
  teamSpawnBot.shouldAwaitInitialTeamSpawnGeometry(6),
  true,
  "two teammates must wait for their corridor anchors instead of spawning isolated",
);
teamSpawnAnchorCount = 2;
assert.equal(
  teamSpawnBot.shouldAwaitInitialTeamSpawnGeometry(6),
  false,
  "a two-teammate corridor proceeds once both anchors are observable",
);
const spawnReuseBot = Object.create(openingSandbox.NationBot.prototype);
const spawnConstraints = { marker: "fresh" };
spawnReuseBot.getSpawnConstraints = () => spawnConstraints;
spawnReuseBot.snapToValidSpawn = (x, y, constraints) => {
  assert.equal(
    constraints,
    spawnConstraints,
    "the reused candidate must receive fresh constraints",
  );
  return `${x}:${y}`;
};
assert.equal(
  spawnReuseBot.spawnTopKeyToValidTile("17,29"),
  "17:29",
  "the prior heatmap winner is reused through the legal spawn snap",
);
assert.equal(
  spawnReuseBot.spawnTopKeyToValidTile("17,29,31"),
  null,
  "malformed cached spawn keys must fall back to a complete selector",
);
const tribeOnlyPendingBot = Object.create(openingSandbox.NationBot.prototype);
tribeOnlyPendingBot.attackBehavior = {
  getPendingOutboundAttackTroops: () => 5000,
  getPendingTerraNulliusAttackTroops: () => 0,
};
assert.equal(
  tribeOnlyPendingBot.hasPendingOpeningExpansionIntent(),
  false,
  "a pending tribe attack does not pause opening TerraNullius expansion",
);
tribeOnlyPendingBot.attackBehavior.getPendingTerraNulliusAttackTroops = () => 5000;
assert.equal(
  tribeOnlyPendingBot.hasPendingOpeningExpansionIntent(),
  true,
  "an unreconciled TerraNullius intent still pauses duplicate free-land expansion",
);
await openingBot.tick(0);
assert.equal(
  openingCalls[0],
  1,
  "the first live TerraNullius burst passes its opening commit to AttackBehavior",
);
assert.equal(
  openingFractions[0],
  0.1,
  "the first live TerraNullius burst uses the configured 10% commit",
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
assert.equal(
  openingBot.openingExpansionFollowUpPending,
  true,
  "a successful follow-up keeps the reconciled TerraNullius expansion chain active",
);
await openingBot.tick(3);
assert.equal(
  openingFollowUps,
  1,
  "the chained follow-up still waits for its preceding expansion intent",
);
openingBot.attackBehavior.pending = 0;
await openingBot.tick(4);
assert.equal(
  openingFollowUps,
  2,
  "TerraNullius expansion continues again immediately after reconciliation",
);
assert.equal(
  openingFullPlans,
  0,
  "fast TerraNullius follow-ups never invoke the full strategic planner",
);
const closedFrontBot = Object.create(openingSandbox.NationBot.prototype);
closedFrontBot.openingLandBurstPending = false;
closedFrontBot.openingExpansionFollowUpPending = true;
closedFrontBot.feat = () => true;
closedFrontBot.maybeBuildOpeningCity = async () => true;
closedFrontBot.openingAllocationRemaining = () => 1200;
closedFrontBot.hasPendingOpeningExpansionIntent = () => false;
closedFrontBot.tickIsCurrent = () => true;
closedFrontBot.attackBehavior = {
  continueOpeningExpansion: async () => false,
  hasLandBorderWithTerraNullius: () => false,
};
assert.equal(
  await closedFrontBot.handleOpeningExpansion(5, null, undefined),
  false,
  "an inaccessible free-land frontier yields immediately to the full strategic planner",
);
assert.equal(closedFrontBot.openingExpansionFollowUpPending, false);
const movingFrontBot = Object.create(openingSandbox.NationBot.prototype);
movingFrontBot.openingLandBurstPending = false;
movingFrontBot.openingExpansionFollowUpPending = true;
movingFrontBot.feat = () => true;
movingFrontBot.maybeBuildOpeningCity = async () => true;
movingFrontBot.openingAllocationRemaining = () => 1200;
movingFrontBot.hasPendingOpeningExpansionIntent = () => false;
movingFrontBot.tickIsCurrent = () => true;
movingFrontBot.attackBehavior = {
  continueOpeningExpansion: async () => false,
  hasLandBorderWithTerraNullius: () => false,
  getLiveTerraNulliusAttackTroops: () => 0,
  hasRecentTerraNulliusAttackIntent: () => true,
};
assert.equal(
  await movingFrontBot.handleOpeningExpansion(5, null, undefined),
  true,
  "a recently emitted opening wave keeps the fast lane alive across the acknowledgement gap",
);
assert.equal(movingFrontBot.openingExpansionFollowUpPending, true);
openingIncomingAttack = true;
await openingBot.tick(5);
assert.equal(openingDefenseResponses, 1);
assert.equal(
  openingDefenseStructures,
  1,
  "an incoming opening attack receives an immediate defensive construction slot",
);
assert.deepEqual(
  openingDefenseOrder,
  ["attack", "structures"],
  "the lightweight troop response precedes the full structure planner",
);
openingIncomingAttack = false;
await openingBot.tick(6);
openingSandbox.state.settings.features.expand = false;
openingSandbox.state.settings.features.build = false;
openingIncomingAttack = true;
await openingBot.tick(7);
assert.equal(
  openingDefenseResponses,
  2,
  "a new attack is handled immediately outside opening even when expansion and boats are disabled",
);
await openingBot.tick(8);
await openingBot.tick(9);
assert.equal(
  openingDefenseResponses,
  2,
  "a persistent attack does not spam a defensive intent every game tick",
);
await openingBot.tick(10);
assert.equal(
  openingDefenseResponses,
  3,
  "a persistent or initially rejected defense is retried on the bounded defensive cadence",
);
assert.equal(
  openingBot.openingExpansionFollowUpPending,
  false,
  "an incoming attack terminates the opening expansion chain even while its prior intent is pending",
);
assert.equal(openingFollowUps, 2, "defense does not run another TerraNullius follow-up");

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
  GameMode: { Team: "Team" },
  PlayerType: { Bot: "BOT", Nation: "NATION" },
  Relation: { Hostile: -1, Neutral: 0, Friendly: 1 },
  UNIT: openingSandbox.UNIT,
  EARLY_EXPAND_COMMIT: 0.1,
  EARLY_EXPAND_OPENING_LIMIT: 0.4,
  currentDifficulty: () => "Impossible",
  getIntentRateLimitSnapshot: () => ({ secondTokens: 10, minuteTokens: 150 }),
  isAtLeastHardDifficulty: () => true,
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

    getPendingTerraNulliusAttackTroops() {
      return 0;
    }

    findIncomingAttackPlayer() {
      return null;
    }

    continueOpeningExpansion() {
      return false;
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
executeClassicScript(
  `${nationExecutionSource}\nglobalThis.NationBot = NationBot;`,
  cadenceSandbox,
  {
    filename: path.join(repoRoot, "engine/ingame/auto-bot/nationExecution-cadence.js"),
  },
);
const cadenceBot = new cadenceSandbox.NationBot(cadenceGame, {
  playerId: "cadence-player",
  gameId: "cadence-game",
});
await cadenceBot.tick(0);
await cadenceBot.tick(1);
await cadenceBot.tick(2);
assert.equal(
  cadenceCalls.length,
  0,
  "opening polling must not invoke the full combat chain before its cadence crossing",
);
await cadenceBot.tick(18);
assert.equal(
  cadenceCalls.length,
  1,
  "win-fix combat uses the scaled attackRate cadence instead of every poll",
);

const embargoTargets = Array.from({ length: 12 }, (_, index) => ({
  id: () => `embargo-${index}`,
  type: () => "NATION",
  hasEmbargoAgainst: () => false,
  isOnSameTeam: () => false,
  relation: () => -1,
}));
const embargoPlayer = {
  hasEmbargoAgainst: () => false,
  id: () => "self",
  isOnSameTeam: () => false,
  relation: () => -1,
};
const emittedEmbargoes = [];
cadenceBot.player = embargoPlayer;
cadenceBot.mg = {
  players: () => [embargoPlayer, ...embargoTargets],
  config: () => ({ gameConfig: () => ({ gameMode: "Team" }) }),
};
cadenceBot.addEmbargo = (other) => {
  emittedEmbargoes.push(other.id());
  return true;
};
cadenceBot.handleEmbargoesToHostileNations();
assert.deepEqual(
  emittedEmbargoes,
  ["embargo-0", "embargo-1"],
  "one diplomacy cycle emits only its bounded quota from a large hostile roster",
);
cadenceSandbox.getIntentRateLimitSnapshot = () => ({ secondTokens: 1, minuteTokens: 150 });
cadenceBot.handleEmbargoesToHostileNations();
assert.equal(
  emittedEmbargoes.length,
  2,
  "diplomacy stops before consuming the last shared strategic intent token",
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
assert.match(coreSource, /"pauseDonateDuringExpansion"/, "the pause setting is persisted");

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
  neighbors: (tile) => {
    if (tile === 0) return [1];
    if (tile === 3) return [2];
    return [tile - 1, tile + 1];
  },
  isLand: () => true,
  isMaritimeShore: (tile) => tile === 3,
});
assert.equal(sandbox.lookupMaritimeDistanceIndex(maritimeDistanceIndex, [0]), 3);
assert.equal(
  sandbox.lookupMaritimeDistanceIndex(
    sandbox.buildMaritimeDistanceIndex({
      width: 4,
      height: 1,
      neighbors: (tile) => {
        if (tile === 0) return [1];
        if (tile === 3) return [2];
        return [tile - 1, tile + 1];
      },
      isLand: () => true,
      isMaritimeShore: (tile) => tile === 3,
      maxDistance: 2,
    }),
    [0],
  ),
  Infinity,
  "a distant maritime route must stay outside the local opening radius",
);
const zeroAllocationMaritimeIndex = sandbox.buildMaritimeDistanceIndex({
  width: 4,
  height: 1,
  neighbors: () => {
    throw new Error("the maritime index should use zero-allocation neighbor iteration");
  },
  forEachNeighbor: (tile, visit) => {
    if (tile > 0) visit(tile - 1);
    if (tile < 3) visit(tile + 1);
  },
  isLand: () => true,
  isMaritimeShore: (tile) => tile === 3,
});
assert.deepEqual(
  [...zeroAllocationMaritimeIndex.distances],
  [...maritimeDistanceIndex.distances],
  "zero-allocation maritime traversal preserves the exact distance field",
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

const redundantCoastRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "redundant-coast",
    landBorder: true,
    maritimeDistance: 0,
    hasOpenOceanAccess: true,
    futureFoodAccess: 0.5,
    captureEfficiency: 0.5,
  },
  {
    id: "inland-expansion",
    landBorder: true,
    maritimeDistance: Infinity,
    hasOpenOceanAccess: true,
    futureFoodAccess: 0.5,
    captureEfficiency: 0.5,
  },
]);
assert.equal(
  redundantCoastRank[0].id,
  "inland-expansion",
  "after securing open sea, an equivalent inland tribe outranks a redundant coastal tribe",
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

const alliedCutoffRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "ordinary-chain",
    landBorder: true,
    captureEfficiency: 0.5,
    futureFoodAccess: 1,
  },
  {
    id: "ally-closing-chokepoint",
    landBorder: true,
    captureEfficiency: 0.5,
    futureFoodAccess: 1,
    alliedCutoffPressure: 1,
  },
]);
assert.equal(
  alliedCutoffRank[0].id,
  "ally-closing-chokepoint",
  "an ally closing a neutral chokepoint makes that tribe an urgent target",
);

const oceanGatewayRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "ordinary-inland-chain",
    landBorder: true,
    captureEfficiency: 0.5,
    futureFoodAccess: 1,
  },
  {
    id: "first-open-ocean-gateway",
    landBorder: true,
    captureEfficiency: 0.5,
    futureFoodAccess: 1,
    maritimeDistance: 0,
    oceanGatewayUrgency: 1,
  },
]);
assert.equal(
  oceanGatewayRank[0].id,
  "first-open-ocean-gateway",
  "the tribe preserving first access to open ocean is an urgent target",
);

const largeClusterRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "small-local-chain",
    landBorder: true,
    captureEfficiency: 0.5,
    futureFoodAccess: 0.5,
    tribeClusterAccess: 0.2,
  },
  {
    id: "gateway-to-large-cluster",
    landBorder: true,
    captureEfficiency: 0.5,
    futureFoodAccess: 0.2,
    tribeClusterAccess: 1,
  },
]);
assert.equal(
  largeClusterRank[0].id,
  "gateway-to-large-cluster",
  "the bot expands toward the densest wider tribe cluster",
);

const clusterOverLocalTemptationRank = sandbox.rankEarlyGameTribeCandidates([
  {
    id: "locally-attractive-dead-end",
    landBorder: true,
    captureEfficiency: 1,
    encirclement: 1,
    blockValue: 1,
    futureFoodAccess: 0,
    tribeClusterAccess: 0,
  },
  {
    id: "costly-gateway-to-large-cluster",
    landBorder: true,
    captureEfficiency: 0.1,
    encirclement: 0,
    blockValue: 0,
    futureFoodAccess: 0.1,
    tribeClusterAccess: 1,
  },
]);
assert.equal(
  clusterOverLocalTemptationRank[0].id,
  "costly-gateway-to-large-cluster",
  "a large tribe cluster outranks an attractive local dead end",
);

assert.deepEqual(
  sandbox
    .keepLargestTribeClusterCandidates([
      { id: "largest", tribeClusterAccess: 1 },
      {
        id: "first-ocean-gateway",
        tribeClusterAccess: 0.2,
        oceanGatewayUrgency: 1,
      },
      { id: "ordinary-smaller-cluster", tribeClusterAccess: 0.4 },
    ])
    .map((candidate) => candidate.id),
  ["largest", "first-ocean-gateway"],
  "first-ocean access remains an exception while ordinary smaller clusters are excluded",
);
assert.deepEqual(
  sandbox
    .keepLargestTribeClusterCandidates([
      { id: "largest", tribeClusterAccess: 1 },
      {
        id: "contested-small-cluster",
        tribeClusterAccess: 0.2,
        directAttackers: 1,
        alliedCutoffPressure: 1,
      },
      {
        id: "ocean-option-a",
        tribeClusterAccess: 0.2,
        oceanGatewayUrgency: 1,
      },
      {
        id: "ocean-option-b",
        tribeClusterAccess: 0.3,
        oceanGatewayUrgency: 1,
      },
    ])
    .map((candidate) => candidate.id),
  ["largest"],
  "races, allied cutoffs, and non-unique sea routes do not divert troops from the largest cluster",
);

const transitiveClusterSizes = sandbox.calculateConnectedTribeClusterSizes(
  [
    { id: "a", center: { x: 0, y: 0 } },
    { id: "b", center: { x: 100, y: 0 } },
    { id: "c", center: { x: 200, y: 0 } },
    { id: "d", center: { x: 300, y: 0 } },
    { id: "isolated", center: { x: 1000, y: 0 } },
  ],
  (left, right) => Math.abs(left.center.x - right.center.x),
  120,
);
assert.equal(
  transitiveClusterSizes.get("a"),
  4,
  "a gateway sees the complete transitive tribe cluster beyond its local radius",
);
assert.equal(transitiveClusterSizes.get("isolated"), 1);

const topologyClusterSizes = sandbox.calculateTribeAdjacencyClusterSizes(
  [
    { id: "short-gateway" },
    { id: "short-end" },
    { id: "large-gateway" },
    { id: "large-1" },
    { id: "large-2" },
    { id: "large-3" },
    { id: "large-4" },
  ],
  new Map([
    ["short-gateway", new Set(["short-end"])],
    ["short-end", new Set(["short-gateway"])],
    ["large-gateway", new Set(["large-1"])],
    ["large-1", new Set(["large-gateway", "large-2"])],
    ["large-2", new Set(["large-1", "large-3"])],
    ["large-3", new Set(["large-2", "large-4"])],
    ["large-4", new Set(["large-3"])],
  ]),
);
assert.ok(
  topologyClusterSizes.get("large-gateway") > topologyClusterSizes.get("short-gateway"),
  "the larger reachable tribe chain wins regardless of direction or shape",
);
const timeAwareClusterOpportunities = sandbox.calculateReachableTribeClusterOpportunities(
  [
    { id: "doomed-gateway", captureRisk: 0 },
    { id: "doomed-next", captureRisk: 1 },
    { id: "doomed-tail", captureRisk: 0 },
    { id: "safe-gateway", captureRisk: 0 },
    { id: "safe-next", captureRisk: 0 },
  ],
  new Map([
    ["doomed-gateway", new Set(["doomed-next"])],
    ["doomed-next", new Set(["doomed-gateway", "doomed-tail"])],
    ["doomed-tail", new Set(["doomed-next"])],
    ["safe-gateway", new Set(["safe-next"])],
    ["safe-next", new Set(["safe-gateway"])],
  ]),
);
assert.deepEqual(
  [...timeAwareClusterOpportunities.get("doomed-gateway").memberIds],
  ["doomed-gateway"],
  "a tribe being captured before our next hop cuts off the cluster behind it",
);
assert.ok(
  timeAwareClusterOpportunities.get("safe-gateway").score >
    timeAwareClusterOpportunities.get("doomed-gateway").score,
  "a smaller available cluster outranks a larger component that rivals will consume",
);
const ringMarkerCenter = sandbox.chooseTribeClusterMarkerCenter([
  { x: -10, y: 0 },
  { x: 10, y: 0 },
  { x: 0, y: -10 },
  { x: 0, y: 10 },
]);
assert.ok(
  ringMarkerCenter.x !== 0 || ringMarkerCenter.y !== 0,
  "a cluster wrapping around us places its marker on a real tribe, not the empty centroid over our territory",
);

const boundedClusterSample = sandbox
  .rankEarlyGameTribeSamplingCandidates([
    ...Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      clusterSize: 1,
      opportunity: 100 - index,
    })),
    { id: 99, clusterSize: 6, opportunity: 0.01 },
  ])
  .slice(0, 8);
assert.ok(
  boundedClusterSample.some((candidate) => candidate.id === 99),
  "a gateway into a large tribe cluster survives the bounded eight-target sample",
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
assert.equal(
  await sandbox.findWaterRouteTicksAsync({
    start: 0,
    goal: 5,
    neighbors: (tile) => waterGraph.get(tile) || [],
    isWater: (tile) => tile >= 1 && tile <= 4,
    maxTicks: 300,
    yieldEvery: 1,
  }),
  5,
  "the yielding water route search must preserve shortest-path results",
);

let deadlineProbeCount = 0;
assert.equal(
  await sandbox.findWaterRouteTicksAsync({
    start: 0,
    goal: 100_000,
    neighbors: (tile) => {
      deadlineProbeCount += 1;
      return [tile + 1];
    },
    isWater: () => true,
    maxTicks: 100_000,
    maxVisited: 100_000,
    yieldEvery: 1,
    deadlineMs: 1,
  }),
  null,
  "a route search must stop its own work when its deadline expires",
);
assert.ok(
  deadlineProbeCount < 100_000,
  "the deadline must cancel the BFS instead of merely timing out its caller",
);

const routeSandbox = {
  WORKER_TIMEOUT_MS: 4000,
  withTimeout: async (promise) => promise,
};
let routeTick = 0;
let routeNeighborCalls = 0;
let routeSpawn = 0;
const routeOwnerId = (tile) => {
  if (tile === 5) return 2;
  return tile === 0 ? 1 : 0;
};
const routeSrc = {
  ticks: () => routeTick,
  neighbors: (tile) => {
    routeNeighborCalls++;
    return waterGraph.get(tile) || [];
  },
  isWater: (tile) => tile >= 1 && tile <= 4,
  isLand: (tile) => tile === 0 || tile === 5,
  isShore: (tile) => tile === 0 || tile === 5,
  ownerID: routeOwnerId,
  manhattanDist: (a, b) => Math.abs(a - b),
};
executeClassicScript(`${gameApiSource}\n${source}`, routeSandbox, {
  filename: "gameApi+earlyGame.js",
});
const routeApi = routeSandbox.createGameApi(routeSrc);
const routeCorePlayer = {
  isPlayer: () => true,
  smallID: () => 1,
  id: () => "p1",
  borderTiles: () => Promise.resolve(new Set([0])),
  profile: () => Promise.resolve({ relations: {} }),
  bestTransportShipSpawn: () => Promise.resolve(routeSpawn),
};
const routePlayer = routeApi.wrapPlayer(routeCorePlayer);
assert.equal(await routePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await routeApi.game.estimateTransportRouteTicks(5), 5);
assert.equal(routeApi.game.hasTransportRouteEstimator, true);
const firstRouteNeighborCalls = routeNeighborCalls;
routeTick = 1;
await routeApi.beginTick(routeCorePlayer);
assert.equal(await routePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await routeApi.game.estimateTransportRouteTicks(5), 5);
assert.equal(
  routeNeighborCalls,
  firstRouteNeighborCalls,
  "a stable authoritative spawn reuses the exact local water route across ticks",
);
routeSpawn = 1;
routeTick = 2;
await routeApi.beginTick(routeCorePlayer);
assert.equal(await routePlayer.bestTransportShipSpawn(5), 1);
assert.equal(await routeApi.game.estimateTransportRouteTicks(5), 4);
assert.ok(
  routeNeighborCalls > firstRouteNeighborCalls,
  "a changed authoritative spawn invalidates the local water route",
);

let negativeRouteTick = 0;
let negativeRouteNeighborCalls = 0;
let negativeRouteGoal = 5;
const negativeRouteGraph = new Map([
  [0, [1]],
  [1, [0]],
  [5, [6]],
  [6, [5]],
]);
const negativeRouteSandbox = {
  WORKER_TIMEOUT_MS: 4000,
  withTimeout: async (promise) => promise,
};
executeClassicScript(`${gameApiSource}\n${source}`, negativeRouteSandbox, {
  filename: "gameApi+earlyGame-negative-route.js",
});
const negativeRouteApi = negativeRouteSandbox.createGameApi({
  ticks: () => negativeRouteTick,
  neighbors: (tile) => {
    negativeRouteNeighborCalls++;
    return negativeRouteGraph.get(tile) || [];
  },
  isWater: (tile) => tile === 1,
  isLand: (tile) => tile === 0 || tile === negativeRouteGoal,
  isShore: (tile) => tile === 0 || tile === negativeRouteGoal,
  ownerID: (tile) => {
    if (tile === 0) return 1;
    return tile === negativeRouteGoal ? 2 : 0;
  },
  manhattanDist: (a, b) => Math.abs(a - b),
});
const negativeRoutePlayer = negativeRouteApi.wrapPlayer({
  isPlayer: () => true,
  smallID: () => 1,
  id: () => "p1",
  borderTiles: () => Promise.resolve(new Set([0])),
  profile: () => Promise.resolve({ relations: {} }),
  bestTransportShipSpawn: () => Promise.resolve(0),
});
assert.equal(await negativeRoutePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await negativeRouteApi.game.estimateTransportRouteTicks(5), null);
const firstNegativeRouteNeighborCalls = negativeRouteNeighborCalls;
negativeRouteTick = 1;
await negativeRouteApi.beginTick(negativeRoutePlayer.__src);
assert.equal(await negativeRoutePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await negativeRouteApi.game.estimateTransportRouteTicks(5), null);
assert.equal(
  negativeRouteNeighborCalls - firstNegativeRouteNeighborCalls,
  2,
  "a stable unreachable target rechecks only its target coast instead of rerunning the water BFS",
);
negativeRouteGoal = 6;
negativeRouteTick = 2;
await negativeRouteApi.beginTick(negativeRoutePlayer.__src);
assert.equal(await negativeRoutePlayer.bestTransportShipSpawn(5), 0);
assert.equal(await negativeRouteApi.game.estimateTransportRouteTicks(5), null);
assert.ok(
  negativeRouteNeighborCalls > firstNegativeRouteNeighborCalls,
  "a changed target coast invalidates a negative route result",
);

// The local gameApi pathfinder must evaluate routes longer than the old
// 300-tick Early Game window so the two-minute exploration gate can reject them
// by their real route length instead of treating them as merely unreachable.
const longerWaterGraph = new Map();
for (let tile = 0; tile <= 351; tile++) {
  const neighbors = [];
  if (tile > 0) neighbors.push(tile - 1);
  if (tile < 351) neighbors.push(tile + 1);
  longerWaterGraph.set(tile, neighbors);
}
const longerRouteSandbox = {};
const longerRouteSrc = {
  neighbors: (tile) => longerWaterGraph.get(tile) || [],
  isWater: (tile) => tile >= 1 && tile <= 350,
  isLand: (tile) => tile === 0 || tile === 351,
  isShore: (tile) => tile === 0 || tile === 351,
  ownerID: (tile) => {
    if (tile === 351) return 2;
    if (tile === 0) return 1;
    return 0;
  },
  manhattanDist: (a, b) => Math.abs(a - b),
};
executeClassicScript(`${gameApiSource}\n${source}`, longerRouteSandbox, {
  filename: "gameApi+earlyGame-long-route.js",
});
const longerRouteApi = longerRouteSandbox.createGameApi(longerRouteSrc);
const longerRoutePlayer = longerRouteApi.wrapPlayer({
  isPlayer: () => true,
  smallID: () => 1,
  id: () => "p1",
  bestTransportShipSpawn: () => Promise.resolve(0),
});
assert.equal(await longerRoutePlayer.bestTransportShipSpawn(351), 0);
assert.equal(await longerRouteApi.game.estimateTransportRouteTicks(351), 351);

assert.match(attackSource, /landTarget: hasAccessibleTerraNullius/);
assert.match(attackSource, /hasFreeLand: hasAccessibleFreeLand/);
assert.match(attackSource, /hasMaritimeTerraNullius/);
assert.match(
  attackSource,
  /getEarlyGameProbeTroops\(\s*state\.settings\.boatProbeFrac/,
  "maritime TerraNullius boats use the configured cheap probe payload",
);
assert.match(attackSource, /async allowEarlyGameBoat\(tile\)/);
assert.match(attackSource, /!state\.settings\.winFixes \|\| !early \|\| !early\.active/);
assert.match(attackSource, /EARLY_EXPAND_COMMIT/);
assert.match(attackSource, /attackEarlyGameTribe/);
assert.match(
  attackSource,
  /const defense = await this\.respondToIncomingAttack\(\);[\s\S]*?defense !== null\) return/,
  "active hostile attacks own the decision before any offensive expansion lane",
);
assert.match(
  attackSource,
  /earlyGameSnapshot\.postSpawn[\s\S]*?attackEarlyGameTribe\(profile\)/,
  "the first tribe probe runs after spawn when a higher-priority expansion cannot emit",
);
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
assert.match(gameApiSource, /findWaterRouteTicksAsync/);
assert.match(gameApiSource, /maxTicks: BOAT_EXPLORATION_MAX_ROUTE_TICKS/);
assert.match(attackSource, /allowBoatExplorationRoute/);

assert.match(buildSource, /"auto-bot\/earlyGame\.js"/);
assert.match(buildSource, /"tribe-cluster-overlay\.js"/);

// Integration probe: the real AttackBehavior enrichment must expose the same
// coast/encirclement/blocking signals used by the pure ranker.
let clusterOverlayWakeups = 0;
let topologyYieldCount = 0;
let topologyDeadlineReads = 0;
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
  EARLY_EXPAND_COMMIT: 0.1,
  EARLY_EXPAND_OPENING_LIMIT: 0.4,
  EARLY_EXPAND_FOLLOWUP_COMMIT: 0.1,
  withTimeout: (value) => Promise.resolve(value),
  WORKER_TIMEOUT_MS: 1000,
  requestMapOverlayLoop: () => {
    clusterOverlayWakeups += 1;
  },
  window: {
    __OFH_deadlineNow() {
      topologyDeadlineReads++;
      return 0;
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 0);
      topologyYieldCount++;
      callback();
    },
  },
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
  sharesBorderWith: () => false,
  isFriendly: () => false,
  incomingAttacks: () => [],
  outgoingAttacks: () => [],
});
const targetMe = makeTargetPlayer(1, "Human", [1], 1000, { x: 0, y: 0 });
targetMe.hasSpawned = () => true;
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
let targetTick = 0;
let topologyBorderFetches = 0;
const targetGame = {
  ticks: () => targetTick,
  inSpawnPhase: () => false,
  config: () => ({ isUnitDisabled: () => false }),
  players: () => [targetMe, targetCoastal, targetInland, targetNext, targetContender, targetMover],
  hasTransportRouteEstimator: true,
  estimateTransportRouteTicks: (tile) => (tile === 10 ? 20 : null),
  ensureBorderTiles: (player) => {
    topologyBorderFetches++;
    return player.borderTiles();
  },
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
executeClassicScript(
  `${source}\n${attackSource}\nglobalThis.AttackBehavior = AttackBehavior;`,
  targetSandbox,
  { filename: "earlyGame+attackBehavior.js" },
);
assert.equal(typeof targetSandbox.rankTeamDonationCandidates, "function");
const rankedDonationCandidates = targetSandbox.rankTeamDonationCandidates([
  { id: "same-clan-rear", sameClan: true, frontline: false, troopPercentage: 0.75, distance: 80 },
  { id: "other-frontline", sameClan: false, frontline: true, troopPercentage: 0.1, distance: 10 },
  { id: "same-clan-front", sameClan: true, frontline: true, troopPercentage: 0.5, distance: 100 },
  { id: "other-rear", sameClan: false, frontline: false, troopPercentage: 0.2, distance: 20 },
  {
    id: "attacked-far",
    sameClan: false,
    underAttack: true,
    frontline: true,
    troopPercentage: 0.05,
    distance: 200,
  },
  {
    id: "attacked-near",
    sameClan: false,
    underAttack: true,
    frontline: true,
    troopPercentage: 0.7,
    distance: 30,
  },
]);
assert.deepEqual(
  rankedDonationCandidates.map((candidate) => candidate.id),
  [
    "attacked-near",
    "attacked-far",
    "other-frontline",
    "same-clan-front",
    "other-rear",
    "same-clan-rear",
  ],
  "attacked allies outrank every other tier and closer allies win within each urgency tier",
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

const sharedShoreBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let sharedShoreBorderReads = 0;
sharedShoreBehavior.player = {
  borderTiles: () => {
    sharedShoreBorderReads++;
    return new Set([1, 2, 3]);
  },
};
sharedShoreBehavior.game = { isShore: (tile) => tile !== 2 };
const sharedShoreSnapshots = [];
sharedShoreBehavior.estimateEarlyGameTribeBoatEta = async (_border, _candidate, ownShores) => {
  sharedShoreSnapshots.push(ownShores);
  return 10;
};
const sharedShorePlayers = [{ id: "sea-a" }, { id: "sea-b" }];
const sharedShoreCandidates = sharedShorePlayers.map((player) => ({
  player,
  landBorder: false,
}));
await sharedShoreBehavior.enrichEarlyGameTribeBoatEtas(
  sharedShoreCandidates,
  new Map(sharedShorePlayers.map((player) => [player, new Set()])),
);
assert.equal(sharedShoreBorderReads, 1, "one decision materializes our shores once");
assert.strictEqual(
  sharedShoreSnapshots[1],
  sharedShoreSnapshots[0],
  "all maritime tribe probes share the same authoritative shore snapshot",
);
assert.deepEqual([...sharedShoreSnapshots[0]], [1, 3]);

const cachedShoreBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let cachedShoreReads = 0;
cachedShoreBehavior.player = {
  shoreBorderTiles: () => {
    cachedShoreReads++;
    return [1, 3];
  },
  borderTiles: () => {
    throw new Error("boat ETA enrichment must reuse the cached shore subset");
  },
};
cachedShoreBehavior.estimateEarlyGameTribeBoatEta = async (_border, _candidate, shores) => {
  assert.deepEqual(shores, [1, 3]);
  return 10;
};
await cachedShoreBehavior.enrichEarlyGameTribeBoatEtas(
  sharedShoreCandidates,
  new Map(sharedShorePlayers.map((player) => [player, new Set()])),
);
assert.equal(cachedShoreReads, 1, "tribe boat ETA enrichment reuses the API's cached shore subset");

const tribeEtaCacheBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let tribeEtaCacheTick = 100;
let tribeEtaRouteCalls = 0;
const stableOwnShores = [1];
const stableTargetBorder = new Set([10]);
const stableTargetPlayer = {
  id: "stable-sea-target",
  smallID: () => 44,
  borderTiles: () => stableTargetBorder,
  shoreBorderTiles: () => [10],
};
tribeEtaCacheBehavior.game = { ticks: () => tribeEtaCacheTick };
tribeEtaCacheBehavior.player = { shoreBorderTiles: () => stableOwnShores };
tribeEtaCacheBehavior.estimateEarlyGameTribeBoatEta = async (_border, candidate) => {
  tribeEtaRouteCalls++;
  candidate.boatTargetTile = 10;
  return 12;
};
const makeStableSeaCandidate = () => ({
  id: "stable-sea-target",
  player: stableTargetPlayer,
  landBorder: false,
});
await tribeEtaCacheBehavior.enrichEarlyGameTribeBoatEtas(
  [makeStableSeaCandidate()],
  new Map([[stableTargetPlayer, stableTargetBorder]]),
);
const cachedStableSeaCandidate = makeStableSeaCandidate();
await tribeEtaCacheBehavior.enrichEarlyGameTribeBoatEtas(
  [cachedStableSeaCandidate],
  new Map([[stableTargetPlayer, stableTargetBorder]]),
);
assert.equal(tribeEtaRouteCalls, 1, "unchanged tribe coast reuses its recent route ETA");
assert.equal(cachedStableSeaCandidate.boatEtaTicks, 12);
assert.equal(cachedStableSeaCandidate.boatTargetTile, 10);
const freshSnapshotSeaCandidate = makeStableSeaCandidate();
stableTargetPlayer.borderTiles = () => new Set([10]);
tribeEtaCacheBehavior.player.shoreBorderTiles = () => [1];
await tribeEtaCacheBehavior.enrichEarlyGameTribeBoatEtas(
  [freshSnapshotSeaCandidate],
  new Map([[stableTargetPlayer, new Set([10])]]),
);
assert.equal(
  tribeEtaRouteCalls,
  1,
  "equivalent fresh coast snapshots reuse the route ETA instead of repeating worker pathfinding",
);
tribeEtaCacheBehavior.player.shoreBorderTiles = () => [1, 2];
await tribeEtaCacheBehavior.enrichEarlyGameTribeBoatEtas(
  [makeStableSeaCandidate()],
  new Map([[stableTargetPlayer, new Set([10])]]),
);
assert.equal(tribeEtaRouteCalls, 2, "a changed launch coast invalidates the cached route ETA");
for (let index = 0; index < 4; index++) {
  tribeEtaCacheTick += 30;
  await tribeEtaCacheBehavior.enrichEarlyGameTribeBoatEtas(
    [makeStableSeaCandidate()],
    new Map([[stableTargetPlayer, new Set([10])]]),
  );
}
assert.equal(
  tribeEtaRouteCalls,
  2,
  "a continuously selected tribe keeps its exact route while both coasts remain unchanged",
);
tribeEtaCacheTick += 61;
await tribeEtaCacheBehavior.enrichEarlyGameTribeBoatEtas(
  [makeStableSeaCandidate()],
  new Map([[stableTargetPlayer, stableTargetBorder]]),
);
assert.equal(tribeEtaRouteCalls, 3, "the tribe route ETA is revalidated after its short TTL");

const borderSignatureBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let borderSignatureIterations = 0;
class CountingBorderSet extends Set {
  [Symbol.iterator]() {
    borderSignatureIterations++;
    return super[Symbol.iterator]();
  }
}
const retainedBorderSnapshot = new CountingBorderSet([30, 10, 20]);
assert.equal(
  borderSignatureBehavior.earlyGameBoatBorderSignature(retainedBorderSnapshot),
  "10,20,30",
);
assert.equal(
  borderSignatureBehavior.earlyGameBoatBorderSignature(retainedBorderSnapshot),
  "10,20,30",
  "the retained immutable border snapshot reuses its complete signature",
);
assert.equal(borderSignatureIterations, 1);
assert.equal(
  borderSignatureBehavior.earlyGameBoatBorderSignature(new CountingBorderSet([10, 20, 30])),
  "10,20,30",
  "a replacement snapshot keeps the exact signature comparison",
);
assert.equal(borderSignatureIterations, 2);

const ordinaryBoatBudgetBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const ordinaryBoatProbeCalls = [];
const ordinaryBoatProbeResults = [null, null, 99];
ordinaryBoatBudgetBehavior.findRandomBoatTarget = async (...args) => {
  ordinaryBoatProbeCalls.push(args);
  return ordinaryBoatProbeResults.shift();
};
assert.equal(
  await ordinaryBoatBudgetBehavior.findRandomBoatDestination(1, []),
  null,
  "the first ordinary boat decision keeps the high-interest target class",
);
assert.deepEqual(
  Array.from(ordinaryBoatProbeCalls[0].slice(2, 4)),
  [true, true],
  "ordinary random boats submit exactly one short, ranked worker probe",
);
assert.equal(ordinaryBoatProbeCalls[0][4].maxProbes, 1);
assert.equal(ordinaryBoatProbeCalls[0][4].timeoutMs, 75);
assert.equal(
  await ordinaryBoatBudgetBehavior.findRandomBoatDestination(1, []),
  null,
  "an unsuccessful high-interest pass yields its fallback class to the next decision",
);
assert.deepEqual(
  Array.from(ordinaryBoatProbeCalls[1].slice(2, 4)),
  [false, false],
  "the generic fallback retains its original route policy without sharing the same frame",
);
assert.equal(ordinaryBoatProbeCalls[1][4].maxProbes, 1);
assert.equal(ordinaryBoatProbeCalls[1][4].timeoutMs, 75);
assert.equal(
  await ordinaryBoatBudgetBehavior.findRandomBoatDestination(1, []),
  99,
  "after the fallback misses, the next decision returns to high-interest exploration",
);
assert.equal(
  ordinaryBoatBudgetBehavior.randomBoatFallbackOnly,
  false,
  "a successful ordinary boat resets the preferred target class",
);

const boatEtaRankBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const rankedBoatEtaShores = boatEtaRankBehavior.rankEarlyGameTribeBoatTargetShores(
  [90, 91, 92, 93, 94, 95, 96],
  (tile) => ({ 90: 6, 91: 2, 92: 2, 93: 9, 94: 1, 95: 4, 96: 2 })[tile],
);
assert.deepEqual(
  Array.from(rankedBoatEtaShores, ({ tile, distance }) => [tile, distance]),
  [
    [94, 1],
    [91, 2],
    [92, 2],
    [96, 2],
  ],
  "streaming boat-ETA ranking keeps the stable top four shores from the full sort",
);

const cachedTargetShoreBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const cachedTargetBorder = new Set([30, 31, 32]);
let cachedTargetShoreReads = 0;
cachedTargetShoreBehavior.game = {
  isShore: () => {
    throw new Error("the identical target border must reuse its cached shore subset");
  },
};
assert.deepEqual(
  Array.from(
    cachedTargetShoreBehavior.getEarlyGameTribeBoatTargetShores(cachedTargetBorder, {
      player: {
        borderTiles: () => cachedTargetBorder,
        shoreBorderTiles: () => {
          cachedTargetShoreReads++;
          return [30, 32];
        },
      },
    }),
  ),
  [30, 32],
);
assert.equal(cachedTargetShoreReads, 1);

const fallbackTargetShoreBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let fallbackTargetShoreChecks = 0;
fallbackTargetShoreBehavior.game = {
  isShore: (tile) => {
    fallbackTargetShoreChecks++;
    return tile !== 31;
  },
};
assert.deepEqual(
  Array.from(
    fallbackTargetShoreBehavior.getEarlyGameTribeBoatTargetShores(cachedTargetBorder, {
      player: {
        borderTiles: () => new Set([30, 31, 32]),
        shoreBorderTiles: () => {
          throw new Error("a different target snapshot must not reuse stale shores");
        },
      },
    }),
  ),
  [30, 32],
);
assert.equal(fallbackTargetShoreChecks, 3);

const surgeBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
surgeBehavior.game = { ticks: () => 110 };
surgeBehavior.player = {
  bestTransportShipSpawn: async () => 1,
  troops: () => 1000,
};
surgeBehavior.landingSucceeded = () => true;
surgeBehavior.allowBoatExplorationRoute = async () => true;
surgeBehavior.allowEarlyGameBoat = async () => true;
let surgeEmissions = 0;
surgeBehavior.emitBoat = () => {
  surgeEmissions++;
  return true;
};
const previousBeachhead = targetSandbox.state.beachhead;
const previousLastOppBoatMs = targetSandbox.state.lastOppBoatMs;
const previousLastOppBoatMissMs = targetSandbox.state.lastOppBoatMissMs;
targetSandbox.state.beachhead = { tile: 10, at: 100, surged: false };
const surgeContext = { fill: 1, surplusFill: 0.5, nowMs: 1234 };
assert.equal(await surgeBehavior.tryOpportunisticBoatSurge(surgeContext), true);
assert.equal(surgeEmissions, 1);
assert.equal(
  targetSandbox.state.beachhead.at,
  100,
  "the reinforcement does not extend the original beachhead window",
);
targetSandbox.state.beachhead = { tile: 10, at: 105, surged: false };
assert.equal(await surgeBehavior.tryOpportunisticBoatSurge(surgeContext), false);
assert.equal(
  surgeEmissions,
  1,
  "replacing the beachhead record cannot surge the same destination twice",
);
targetSandbox.state.beachhead = { tile: 11, at: 105, surged: false };
assert.equal(await surgeBehavior.tryOpportunisticBoatSurge(surgeContext), true);
assert.equal(surgeEmissions, 2, "a different beachhead still receives its reinforcement");
targetSandbox.state.beachhead = previousBeachhead;
targetSandbox.state.lastOppBoatMs = previousLastOppBoatMs;
targetSandbox.state.lastOppBoatMissMs = previousLastOppBoatMissMs;

const opportunisticBackoffBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const previousRuntimeDebugLog = targetSandbox.runtimeDebugLog;
targetSandbox.runtimeDebugLog = () => {};
targetSandbox.state.lastOppBoatMs = 200;
targetSandbox.state.lastOppBoatMissMs = 500;
assert.equal(
  opportunisticBackoffBehavior.opportunisticBoatLastAttemptMs(),
  500,
  "the opportunistic boat cadence includes the latest successful or unsuccessful attempt",
);
opportunisticBackoffBehavior.opportunisticBoatContext = () => ({
  nowMs: 800,
  shores: [],
});
opportunisticBackoffBehavior.tryOpportunisticBoatSurge = async () => false;
opportunisticBackoffBehavior.refreshInflightBoatTargets = () => {};
opportunisticBackoffBehavior.findOpportunisticBoatTarget = async () => ({
  dst: null,
  scanCandidates: 0,
});
await opportunisticBackoffBehavior.maybeOpportunisticBoat();
assert.equal(
  targetSandbox.state.lastOppBoatMissMs,
  800,
  "a failed route search starts the configured opportunistic retry cadence",
);
targetSandbox.state.lastOppBoatMs = previousLastOppBoatMs;
targetSandbox.state.lastOppBoatMissMs = previousLastOppBoatMissMs;
targetSandbox.runtimeDebugLog = previousRuntimeDebugLog;

const boatStageBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const boatStageCalls = [];
boatStageBehavior.boatTargetTaken = () => false;
boatStageBehavior.nearbyOpportunisticBoatTarget = async () => {
  boatStageCalls.push("nearby");
  return { dst: null, scanCandidates: 4 };
};
boatStageBehavior.craterOpportunisticBoatTarget = async () => {
  boatStageCalls.push("crater");
  return null;
};
boatStageBehavior.randomOpportunisticBoatTarget = async (_shores, highInterest) => {
  boatStageCalls.push(highInterest ? "random-high" : "random-player");
  return null;
};
boatStageBehavior.findDistantBoatTarget = async (_profile, limit) => {
  boatStageCalls.push(`distant:${limit}`);
  return null;
};
boatStageBehavior.findDisconnectedBoatTarget = async (limit) => {
  boatStageCalls.push(`disconnected:${limit}`);
  return null;
};
for (const expected of [
  "nearby",
  "crater",
  "random-high",
  "random-player",
  "distant:4",
  "disconnected:4",
]) {
  const target = await boatStageBehavior.findOpportunisticBoatTarget([1]);
  assert.equal(target.dst, null);
  boatStageBehavior.opportunisticBoatSearchStageName = target.nextSearchStage;
  assert.equal(boatStageCalls.at(-1), expected);
}
assert.equal(
  boatStageCalls.length,
  6,
  "one opportunistic decision probes exactly one bounded target category",
);

const earlyOceanProbeBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let earlyOceanProbeTick = 100;
const earlyOceanProbeCalls = [];
earlyOceanProbeBehavior.earlyOceanProbeRetryTicks = new Map();
earlyOceanProbeBehavior.game = {
  config: () => ({ isUnitDisabled: () => false, boatMaxNumber: () => 8 }),
  ticks: () => earlyOceanProbeTick,
};
earlyOceanProbeBehavior.player = {
  unitCount: () => 0,
  oceanShoreBorderTiles: () => [1],
  bestTransportShipSpawn: (tile) => {
    earlyOceanProbeCalls.push(tile);
    return Promise.resolve(false);
  },
};
earlyOceanProbeBehavior.scanEarlyOceanTargets = () => [
  { tile: 11, dist: 1 },
  { tile: 12, dist: 2 },
  { tile: 13, dist: 3 },
  { tile: 14, dist: 4 },
];
earlyOceanProbeBehavior.boatTargetTaken = () => false;
earlyOceanProbeBehavior.allowEarlyGameBoat = async () => false;
assert.equal(await earlyOceanProbeBehavior.maybeEarlyOceanBoat(), false);
assert.deepEqual(
  earlyOceanProbeCalls,
  [11],
  "one ocean decision submits only one expensive route probe",
);
earlyOceanProbeTick += 30;
assert.equal(await earlyOceanProbeBehavior.maybeEarlyOceanBoat(), false);
assert.deepEqual(
  earlyOceanProbeCalls,
  [11, 12],
  "a failed nearest coast yields to the next ranked fallback before retrying",
);

const borderFallbackBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
targetSandbox.currentDifficulty = () => "Impossible";
targetSandbox.Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
borderFallbackBehavior.isFFA = () => false;
const rejectedBorderEnemy = { id: () => "rejected", troops: () => 10 };
const actionableBorderEnemy = { id: () => "actionable", troops: () => 20 };
const attemptedBorderEnemies = [];
borderFallbackBehavior.sendAttack = async (enemy) => {
  attemptedBorderEnemies.push(enemy.id());
  return enemy === actionableBorderEnemy;
};
const impossibleStrategies = borderFallbackBehavior.getAttackStrategies(
  [],
  [rejectedBorderEnemy, actionableBorderEnemy],
);
assert.equal(
  await impossibleStrategies[10](),
  true,
  "the weakest fallback continues after the first hostile border is rejected",
);
assert.deepEqual(attemptedBorderEnemies, ["rejected", "actionable"]);

const betrayalTimingBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
betrayalTimingBehavior.game = {
  config: () => ({ disableAlliances: () => false }),
};
betrayalTimingBehavior.allianceBehavior = { maybeBetray: () => true };
let sameTickBetrayalAttacks = 0;
betrayalTimingBehavior.sendAttack = async () => {
  sameTickBetrayalAttacks++;
  return true;
};
assert.equal(await betrayalTimingBehavior.maybeBetrayAndAttack([{}], []), true);
assert.equal(
  sameTickBetrayalAttacks,
  0,
  "the bot waits for the alliance break to become authoritative before attacking",
);

// A live client can know that we share a border before the target's async
// border snapshot is populated. That tribe must remain actionable instead of
// disappearing from the ranked attack pass.
const emptyBorderTribe = {
  ...targetCoastal,
  borderTiles: () => new Set(),
};
const emptyBorderMe = {
  ...targetMe,
  nearby: () => [emptyBorderTribe],
  sharesBorderWith: (target) => target === emptyBorderTribe,
};
const emptyBorderGame = {
  ...targetGame,
  players: () => [emptyBorderMe, emptyBorderTribe],
  ensureBorderTiles: () => new Set(),
};
const emptyBorderBehavior = new targetSandbox.AttackBehavior(
  {},
  emptyBorderGame,
  emptyBorderMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const emptyBorderCandidates = await emptyBorderBehavior.getEarlyGameTribeCandidates();
assert.equal(emptyBorderCandidates.length, 1);
assert.equal(
  emptyBorderCandidates[0].landBorder,
  true,
  "sharesBorderWith keeps a tribe actionable while its border snapshot is empty",
);
assert.equal(
  targetSandbox.rankEarlyGameTribeCandidates(emptyBorderCandidates).length,
  1,
  "the bordering tribe reaches the ranked attack pass",
);

// A hostile player can dominate the live nearby() snapshot. The authoritative
// border predicate must still recover an omitted bordering tribe.
const hostileSnapshotEnemy = makeTargetPlayer(9, "Nation", [], 900, { x: 1, y: 0 });
const hostileSnapshotMe = {
  ...targetMe,
  nearby: () => [hostileSnapshotEnemy],
  sharesBorderWith: (target) => target === targetInland,
};
const hostileSnapshotGame = {
  ...targetGame,
  players: () => [hostileSnapshotMe, hostileSnapshotEnemy, targetInland],
};
const hostileSnapshotBehavior = new targetSandbox.AttackBehavior(
  {},
  hostileSnapshotGame,
  hostileSnapshotMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
const hostileSnapshotCandidates = await hostileSnapshotBehavior.getEarlyGameTribeCandidates();
assert.ok(
  hostileSnapshotCandidates.some((candidate) => candidate.id === 4),
  "a bordering tribe omitted by nearby() remains actionable beside a hostile Nation",
);

const indexedBorderTribe = makeTargetPlayer(7, "Bot", [101], 100, { x: 1, y: 0 });
const indexedRemoteTribe = makeTargetPlayer(8, "Bot", [102], 100, { x: 2, y: 0 });
let indexedBorderScans = 0;
const indexedBorderMe = {
  ...targetMe,
  borderTiles: () => new Set([100]),
  nearby: () => [],
  sharesBorderWith: () => {
    throw new Error("the indexed owner path must avoid pairwise border scans");
  },
};
const indexedBorderBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
indexedBorderBehavior.player = indexedBorderMe;
indexedBorderBehavior.game = {
  neighbors: () => {
    indexedBorderScans++;
    return [101];
  },
  ownerID: (tile) => (tile === 101 ? 7 : null),
};
const indexedBorderOwnerIds = indexedBorderBehavior.getEarlyGameBorderingOwnerIds();
const indexedEligibleTribes = indexedBorderBehavior.getEligibleEarlyGameTribes(
  [indexedBorderMe, indexedBorderTribe, indexedRemoteTribe],
  indexedBorderOwnerIds,
);
assert.equal(
  indexedEligibleTribes.length,
  1,
  "one border-owner scan recovers only the truly adjacent tribe",
);
assert.equal(indexedEligibleTribes[0].smallID(), 7);
assert.equal(
  indexedBorderScans,
  1,
  "the eligible-tribe fast path scans each owned border tile once",
);

let foodRaceComputations = 0;
const cachedFoodRaceBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
cachedFoodRaceBehavior.player = { isFriendly: () => false };
cachedFoodRaceBehavior.getEarlyGameFoodRaceSignals = () => {
  foodRaceComputations++;
  return { foodRaceValue: 0.7 };
};
const cachedFoodRaceById = new Map();
cachedFoodRaceBehavior.getLightweightEarlyGameTribeNodes(
  [indexedBorderTribe],
  [],
  cachedFoodRaceById,
);
const cachedFutureFood = cachedFoodRaceBehavior.getEarlyGameFutureFoodCandidates(
  [indexedBorderTribe],
  [],
  [],
  cachedFoodRaceById,
);
assert.equal(cachedFutureFood.get(7).captureRisk, 0.7);
assert.equal(
  foodRaceComputations,
  1,
  "future-food scoring reuses the coherent per-decision food-race snapshot",
);
const reusedFutureFoodNodes = [
  {
    id: 7,
    player: indexedBorderTribe,
    center: { x: 7, y: 7 },
    captureRisk: 0.7,
  },
];
const reusedFutureFood = cachedFoodRaceBehavior.getEarlyGameFutureFoodCandidates(
  [indexedBorderTribe],
  [],
  [],
  cachedFoodRaceById,
  reusedFutureFoodNodes,
);
assert.strictEqual(
  reusedFutureFood.get(7),
  reusedFutureFoodNodes[0],
  "future-food scoring reuses nodes created by the current sampling pass",
);
assert.equal(
  foodRaceComputations,
  1,
  "reusing current sampling nodes avoids a second tribe food-race calculation",
);
const ambiguousRelationTribe = {
  ...indexedBorderTribe,
  smallID: () => 8,
};
cachedFoodRaceBehavior.player = { isFriendly: () => undefined };
const ambiguousFutureFood = cachedFoodRaceBehavior.getEarlyGameFutureFoodCandidates(
  [ambiguousRelationTribe],
  [],
  [],
  new Map(),
  [],
);
assert.equal(
  ambiguousFutureFood.has(8),
  true,
  "future-food fallback retains tribes whose relationship is not strictly hostile",
);

const indexedDirectFoodRaceBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const indexedDirectContext = {
  records: new Map(),
  directAttackers: new Set(),
};
const indexedDirectTargets = [{ targetSid: 7, troops: 120 }];
const indexedDirectProfile = {
  sid: 4,
  progress: 0.6,
  outgoingTargetsByTarget: new Map([[7, indexedDirectTargets]]),
};
Object.defineProperty(indexedDirectProfile, "outgoingTargets", {
  get() {
    throw new Error("indexed direct signals must not rescan outgoing attacks");
  },
});
assert.equal(
  indexedDirectFoodRaceBehavior.applyDirectFoodRaceSignal(
    indexedDirectProfile,
    7,
    indexedDirectContext,
  ),
  true,
);
assert.equal(indexedDirectContext.records.get(4).troops, 120);
assert.equal(indexedDirectContext.records.get(4).progress, 0.6);
assert.equal(indexedDirectContext.records.get(4).vector, 1);

const spatialFoodRaceBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const spatialFoodRaceProfiles = [
  {
    sid: 11,
    location: { x: 5, y: 5 },
    outgoingTargetsByTarget: new Map(),
  },
  {
    sid: 12,
    location: { x: 1000, y: 1000 },
    outgoingTargetsByTarget: new Map([[7, [{ targetSid: 7, troops: 120 }]]]),
  },
  {
    sid: 13,
    location: { x: 1000, y: 1000 },
    outgoingTargetsByTarget: new Map(),
  },
];
const spatialFoodRaceIndex =
  spatialFoodRaceBehavior.earlyGameFoodRaceProfileIndex(spatialFoodRaceProfiles);
assert.deepEqual(
  Array.from(
    spatialFoodRaceBehavior.earlyGameRelevantFoodRaceProfiles(spatialFoodRaceIndex, 7, {
      x: 10,
      y: 10,
    }),
    (profile) => profile.sid,
  ).sort((left, right) => left - right),
  [11, 12],
  "food-race indexing keeps nearby directional pressure and every direct attacker while excluding only directionally-zero distant profiles",
);
assert.strictEqual(
  spatialFoodRaceBehavior.earlyGameFoodRaceProfileIndex(spatialFoodRaceProfiles),
  spatialFoodRaceIndex,
  "food-race indexing is reused for every tribe in the same competitor snapshot",
);
const nearbyBoatRankBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const nearbyBoatRecords = [
  { tile: 1, dist: 7 },
  { tile: 2, dist: 2 },
  { tile: 3, dist: 4 },
  { tile: 4, dist: 2 },
  { tile: 5, dist: 1 },
  { tile: 6, dist: 9 },
  { tile: 7, dist: 3 },
];
const boundedNearbyBoatTargets = {
  targetLimit: 4,
  targets: [],
  scanCandidates: 0,
};
for (const record of nearbyBoatRecords) {
  nearbyBoatRankBehavior.insertNearbyBoatTarget(boundedNearbyBoatTargets, record);
}
assert.deepEqual(
  boundedNearbyBoatTargets.targets,
  nearbyBoatRecords
    .slice()
    .sort((left, right) => left.dist - right.dist)
    .slice(0, 4),
  "bounded nearby-boat selection preserves the stable full-sort probe order",
);
assert.equal(
  boundedNearbyBoatTargets.scanCandidates,
  nearbyBoatRecords.length,
  "nearby-boat diagnostics retain every scanned candidate after bounded ranking",
);
const nearbyBoatScanBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const previousIslandProbeMax = targetSandbox.state.settings.islandProbeMax;
const previousIslandScanRadius = targetSandbox.state.settings.islandScanRadius;
const previousIslandScanStep = targetSandbox.state.settings.islandScanStep;
const previousIslandScanSamples = targetSandbox.state.settings.islandScanSamples;
targetSandbox.state.settings.islandProbeMax = 4;
targetSandbox.state.settings.islandScanRadius = 8;
targetSandbox.state.settings.islandScanStep = 2;
targetSandbox.state.settings.islandScanSamples = 1;
nearbyBoatScanBehavior.player = { smallID: () => 1, troops: () => 100 };
nearbyBoatScanBehavior.random = { randElement: (items) => items[0] };
nearbyBoatScanBehavior.game = {
  x: () => 0,
  y: () => 0,
  isValidCoord: () => true,
  ref: (x, y) => `${x},${y}`,
};
let nearbyBoatCoordinatesInspected = 0;
nearbyBoatScanBehavior.nearbyBoatTargetRecord = (tile, dx, dy) => {
  nearbyBoatCoordinatesInspected++;
  return { tile, dist: dx * dx + dy * dy, owned: false, fallout: false };
};
const nearbyBoatScan = await nearbyBoatScanBehavior.scanNearbyTargets([0]);
assert.equal(nearbyBoatScan.targets.length, 4);
assert.ok(
  nearbyBoatCoordinatesInspected < 81,
  "nearby-boat scanning stops after the closest complete ring once the bounded target set is full",
);
assert.ok(
  nearbyBoatCoordinatesInspected <= 5,
  "a fully grabbable shore scans only the centre and its first equal-distance ring",
);
targetSandbox.state.settings.islandProbeMax = previousIslandProbeMax;
targetSandbox.state.settings.islandScanRadius = previousIslandScanRadius;
targetSandbox.state.settings.islandScanStep = previousIslandScanStep;
targetSandbox.state.settings.islandScanSamples = previousIslandScanSamples;
const foodRaceTribe = {
  troops: () => 100,
  incomingAttacks: () => [],
};
const foodRaceProfiles = spatialFoodRaceProfiles.map((profile) => ({
  ...profile,
  dx: 1,
  dy: 0,
  progress: 0.5,
  troops: 200,
  outgoingTargets: [],
}));
const indexedFoodRaceBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
indexedFoodRaceBehavior.player = { smallID: () => 1 };
let indexedDirectionalCalls = 0;
const originalIndexedDirectional = indexedFoodRaceBehavior.applyDirectionalFoodRaceSignal;
indexedFoodRaceBehavior.applyDirectionalFoodRaceSignal = function (...args) {
  indexedDirectionalCalls++;
  return originalIndexedDirectional.apply(this, args);
};
const indexedFoodRace = indexedFoodRaceBehavior.getEarlyGameFoodRaceSignals({
  tribe: foodRaceTribe,
  tribeSid: 7,
  tribeCenter: { x: 10, y: 10 },
  competitorProfiles: foodRaceProfiles,
});
const exhaustiveFoodRaceBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
exhaustiveFoodRaceBehavior.player = { smallID: () => 1 };
exhaustiveFoodRaceBehavior.earlyGameFoodRaceProfileIndex = () => null;
exhaustiveFoodRaceBehavior.earlyGameRelevantFoodRaceProfiles = () => new Set(foodRaceProfiles);
let exhaustiveDirectionalCalls = 0;
const originalExhaustiveDirectional = exhaustiveFoodRaceBehavior.applyDirectionalFoodRaceSignal;
exhaustiveFoodRaceBehavior.applyDirectionalFoodRaceSignal = function (...args) {
  exhaustiveDirectionalCalls++;
  return originalExhaustiveDirectional.apply(this, args);
};
assert.deepEqual(
  indexedFoodRace,
  exhaustiveFoodRaceBehavior.getEarlyGameFoodRaceSignals({
    tribe: foodRaceTribe,
    tribeSid: 7,
    tribeCenter: { x: 10, y: 10 },
    competitorProfiles: foodRaceProfiles,
  }),
  "the food-race spatial index is exactly equivalent to the full competitor scan",
);
assert.equal(indexedDirectionalCalls, 1);
assert.equal(exhaustiveDirectionalCalls, 2);

const incrementalFoodRaceBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
incrementalFoodRaceBehavior.player = { isFriendly: () => false };
incrementalFoodRaceBehavior.getEarlyGameFoodRaceSignals = ({ tribeSid }) => ({
  foodRaceValue: tribeSid / 10,
});
const incrementalFoodRaceById = new Map();
const incrementalTribeNodes = await incrementalFoodRaceBehavior.getIncrementalEarlyGameTribeNodes(
  [indexedBorderTribe, indexedRemoteTribe],
  [],
  incrementalFoodRaceById,
);
assert.deepEqual(
  Array.from(incrementalTribeNodes, (node) => [node.id, node.captureRisk]),
  [
    [7, 0.7],
    [8, 0.8],
  ],
  "incremental tribe-node preparation preserves every strategic node and food-race score",
);
assert.equal(incrementalFoodRaceById.size, 2);
assert.match(attackSource, /await profileAttackAsync\([\s\S]*tribes-sampling-nodes/);
assert.match(
  attackSource,
  /await profileAttackAsync\([\s\S]*tribes-competitor-profiles/,
  "competitor profiling yields before the full tribe topology pass",
);
assert.match(attackSource, /shouldYieldEarlyGameTribeNodes/);

let contesterLocationReads = 0;
const indexedContester = makeTargetPlayer(31, "Human", [], 100, { x: 5, y: 0 });
indexedContester.nameLocation = () => {
  contesterLocationReads++;
  return { x: 5, y: 0 };
};
const indexedTargetTribe = makeTargetPlayer(32, "Bot", [], 100, { x: 10, y: 0 });
indexedTargetTribe.nameLocation = () => {
  contesterLocationReads++;
  return { x: 10, y: 0 };
};
const indexedContesterBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
indexedContesterBehavior.player = targetMe;
indexedContesterBehavior.game = {
  isValidCoord: () => true,
  ref: (x) => x,
  manhattanDist: (left, right) => Math.abs(left - right),
};
const indexedContesterTiles = indexedContesterBehavior.getEarlyGameContesterTiles(
  [targetMe, indexedContester, indexedTargetTribe],
  targetMe.smallID(),
);
assert.equal(
  indexedContesterBehavior.countEarlyGameNearbyContesters(
    [],
    indexedTargetTribe.smallID(),
    targetMe.smallID(),
    { x: 10, y: 0 },
    indexedContesterTiles,
  ),
  1,
);
assert.equal(
  indexedContesterBehavior.countEarlyGameNearbyContesters(
    [],
    indexedTargetTribe.smallID(),
    targetMe.smallID(),
    { x: 10, y: 0 },
    indexedContesterTiles,
  ),
  1,
);
assert.equal(
  contesterLocationReads,
  2,
  "candidate scoring reads each contester location once per decision",
);
const cachedContesterBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let cachedContesterRefReads = 0;
cachedContesterBehavior.game = {
  isValidCoord: () => true,
  ref: (x, y) => {
    cachedContesterRefReads++;
    return `${x}:${y}`;
  },
};
const stableContesterProfiles = [{ sid: 51, location: { x: 5, y: 6 }, troops: 100 }];
const cachedContesterTiles = cachedContesterBehavior.getEarlyGameContesterTiles(
  [],
  1,
  stableContesterProfiles,
);
assert.strictEqual(
  cachedContesterBehavior.getEarlyGameContesterTiles([], 1, [
    { sid: 51, location: { x: 5, y: 6 }, troops: 200 },
  ]),
  cachedContesterTiles,
  "troop-only competitor refreshes reuse the contester tile index",
);
assert.equal(cachedContesterRefReads, 1);
assert.deepEqual(
  Array.from(
    cachedContesterBehavior.getEarlyGameContesterTiles([], 1, [
      { sid: 51, location: { x: 7, y: 6 }, troops: 200 },
    ]),
    ({ sid, tile }) => [sid, tile],
  ),
  [[51, "7:6"]],
  "a moved competitor invalidates the contester tile cache",
);
assert.equal(cachedContesterRefReads, 2);

const explorationRouteBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let explorationEta = 1200;
explorationRouteBehavior.game = {
  hasTransportRouteEstimator: true,
  estimateTransportRouteTicks: () => explorationEta,
};
assert.equal(
  await explorationRouteBehavior.allowBoatExplorationRoute(1),
  true,
  "a two-minute exploration route is allowed",
);
explorationEta = 1201;
assert.equal(
  await explorationRouteBehavior.allowBoatExplorationRoute(1),
  false,
  "an exploration route over two minutes is rejected",
);
explorationEta = null;
assert.equal(
  await explorationRouteBehavior.allowBoatExplorationRoute(1),
  false,
  "an unknown exploration route is rejected",
);

const cachedExplorationRouteBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let cachedExplorationRouteCalls = 0;
cachedExplorationRouteBehavior.game = {
  ticks: () => 42,
  hasTransportRouteEstimator: true,
  estimateTransportRouteTicks: () => {
    cachedExplorationRouteCalls++;
    return 120;
  },
};
assert.equal(
  await cachedExplorationRouteBehavior.allowBoatExplorationRoute(1),
  true,
  "the initial current-tick exploration route remains valid",
);
const previousEarlyGameRouteState = targetSandbox.state.earlyGame;
targetSandbox.state.earlyGame = { active: true, boatRouteAvailable: true };
assert.equal(
  await cachedExplorationRouteBehavior.allowEarlyGameBoat(1),
  true,
  "early-game emission reuses the selection route from the same tick",
);
assert.equal(
  cachedExplorationRouteCalls,
  1,
  "one boat destination runs one authoritative route estimate per game tick",
);
targetSandbox.state.earlyGame = previousEarlyGameRouteState;

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
  10000,
  "generic TerraNullius land attacks use at least 10% of the current army",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(minimumTerraNulliusTarget, 2),
  10000,
  "generic expansion still uses 10% when a preferred frontier tile is known",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(minimumTerraNulliusTarget, null, 99000),
  24,
  "a normal TerraNullius land burst stays at the one-tile cost",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(minimumTerraNulliusTarget, 3, 20),
  0,
  "TerraNullius attacks wait when the exact first-tile loss is not affordable",
);
assert.equal(
  minimumTerraNulliusBehavior.getTerraNulliusAttackTroops(
    minimumTerraNulliusTarget,
    null,
    99000,
    0.6,
  ),
  10000,
  "the opening TerraNullius payload keeps the 10% liveness minimum while 60% remains only its ceiling",
);

const radioactiveBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let radioactiveTiles = 0;
radioactiveBehavior.player = { troops: () => 100000 };
radioactiveBehavior.game = {
  config: () => ({ maxTroops: () => 200000 }),
  numLandTiles: () => 100000,
  numTilesWithFallout: () => radioactiveTiles,
};
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusReserveTroops(),
  84000,
  "radioactive TerraNullius expansion may spend down to 42% of maximum troops",
);
let radioactiveBoatReserve = null;
radioactiveBehavior.getEarlyGameProbeTroops = (_fraction, reserve) => {
  radioactiveBoatReserve = reserve;
  return 1;
};
radioactiveBehavior.nearbyTerraNulliusBoatTroops(true);
assert.equal(
  radioactiveBoatReserve,
  84000,
  "radioactive coastal expansion uses the same 42% reserve",
);
radioactiveBehavior.getEnemyDefensePostAttackProfile = () => null;
radioactiveBehavior.effectiveReserveRatio = () => 0.6;
radioactiveBehavior.getEarlyGameTargetReserveTroops = () => 99000;
radioactiveBehavior.getEarlyGameSpendableTroops = (reserve) => 100000 - reserve;
radioactiveBehavior.getTerraNulliusLivenessReserveTroops = () => 99000;
const radioactiveLandContext = radioactiveBehavior.createLandAttackContext(
  { isPlayer: () => false },
  { radioactiveTerraNullius: true },
);
assert.equal(
  radioactiveLandContext.targetTroops,
  84000,
  "radioactive land attacks replace the ordinary TerraNullius reserve with 42%",
);
assert.equal(
  radioactiveLandContext.finalSpendableTroops,
  16000,
  "radioactive land attacks can spend every troop above the 42% floor",
);
radioactiveBehavior.getRemainingTerraNulliusOpeningCommitment = () => 0;
radioactiveBehavior.getTerraNulliusMinimumTroops = () => 10;
assert.equal(
  radioactiveBehavior.getTerraNulliusAttackTroops(
    { isPlayer: () => false },
    null,
    16000,
    0.05,
    false,
  ),
  0,
  "ordinary TerraNullius remains capped after its opening commitment is exhausted",
);
assert.ok(
  radioactiveBehavior.getTerraNulliusAttackTroops(
    { isPlayer: () => false },
    null,
    16000,
    0.05,
    true,
  ) > 0,
  "Fallout expansion remains live after the ordinary opening commitment is exhausted",
);
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusFalloutDefenseMultiplier(),
  5,
  "low fallout coverage uses the engine's maximum radioactive defense multiplier",
);
radioactiveTiles = 50000;
assert.equal(
  radioactiveBehavior.getRadioactiveTerraNulliusFalloutDefenseMultiplier(),
  4,
  "the live fallout ratio updates the defense multiplier",
);

// A directly adjacent free tile is attempted before tribe and enemy food
// attacks, but its independent intent must not suppress a parallel tribe capture.
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
let priorityIncomingAttacks = [];
const priorityPlayer = {
  smallID: () => 1,
  type: () => targetSandbox.PlayerType.Human,
  hasSpawned: () => true,
  borderTiles: () => new Set([1]),
  nearby: () => [priorityTribe, priorityEnemy],
  isFriendly: () => false,
  incomingAttacks: () => priorityIncomingAttacks,
  sharesBorderWith: (target) => target === priorityTribe || target === priorityEnemy,
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
priorityBehavior.random = { chance: () => false };
priorityBehavior.player = priorityPlayer;
priorityBehavior.attackBestTarget = async () => {};
priorityBehavior.game = priorityGame;
priorityBehavior.allianceBehavior = {};
priorityBehavior.reconcileOutboundAttackIntentCommitments = () => {};
priorityBehavior.cacheEnemyDefensePostFrontTiles = () => {};
priorityBehavior.rankAttackTargets = (players) => players;
priorityBehavior.attackEarlyGameTribe = async () => priorityBehavior.sendAttack(priorityTribe);
const priorityAttackTargets = [];
const priorityAttackCalls = [];
priorityBehavior.sendAttack = async (target, ...args) => {
  priorityAttackTargets.push(target);
  priorityAttackCalls.push({ target, args });
  return true;
};
targetSandbox.state.settings.features = {
  expand: true,
  boat: true,
  alliance: false,
};
targetSandbox.state.earlyGame = {};
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityFreeTarget, priorityTribe],
  "accessible free land and a bordering tribe expand in parallel",
);
assert.equal(targetSandbox.state.earlyGame.action, "tribe");

// A rejected free-land intent must not starve the bordering tribe until some
// other player consumes all surrounding TerraNullius.
priorityAttackTargets.length = 0;
priorityBehavior.sendAttack = async (target, ...args) => {
  priorityAttackTargets.push(target);
  priorityAttackCalls.push({ target, args });
  return target !== priorityFreeTarget;
};
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityFreeTarget, priorityTribe],
  "a rejected free-land expansion falls through to the bordering tribe",
);
assert.equal(targetSandbox.state.earlyGame.action, "tribe");
priorityBehavior.sendAttack = async (target, ...args) => {
  priorityAttackTargets.push(target);
  priorityAttackCalls.push({ target, args });
  return true;
};

// A live hostile attack owns the decision. Even if other intents look
// affordable, they must not consume the force reserved for defense.
priorityAttackTargets.length = 0;
priorityIncomingAttacks = [
  {
    attacker: () => priorityEnemy,
    troops: () => 100,
  },
];
priorityBehavior.canFundIncomingCounterattack = () => true;
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityEnemy],
  "an incoming attacker blocks both offensive expansion lanes",
);
assert.equal(targetSandbox.state.earlyGame.action, "retaliate");
delete priorityBehavior.canFundIncomingCounterattack;
priorityIncomingAttacks = [];

// A hostile border must not suppress the other expansion lanes. First verify
// that a nearby tribe remains actionable when the border owner is human.
priorityAttackTargets.length = 0;
priorityGame.neighbors = (tile) => (tile === 1 ? [3] : []);
priorityPlayer.nearby = () => [priorityTribe, priorityEnemy];
priorityBehavior.attackEarlyGameTribe = async () => {
  priorityAttackTargets.push(priorityTribe);
  return true;
};
priorityBehavior.attackBots = async () => {
  priorityAttackTargets.push(priorityTribe);
  return true;
};
priorityBehavior.maybeEarlyOceanBoat = async () => false;
priorityBehavior.maybeOpportunisticBoat = async () => {};
priorityBehavior.isBorderingNukedTerritory = () => false;
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityTribe],
  "a human enemy border does not disable tribe expansion",
);

// Maritime-only TerraNullius gets a cheap probe, but the uncertain route must
// not block the tribe race in the same decision.
priorityAttackTargets.length = 0;
priorityPlayer.nearby = () => [priorityFreeTarget, priorityTribe, priorityEnemy];
priorityBehavior.attackEarlyGameTribe = async () => false;
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityFreeTarget, priorityTribe],
  "a maritime TerraNullius probe does not block the bordering tribe",
);
assert.equal(targetSandbox.state.earlyGame.hasFreeLand, false);
assert.equal(targetSandbox.state.earlyGame.maritimeProbeSent, true);
assert.equal(targetSandbox.state.earlyGame.action, "tribe");

// Once there is no TerraNullius neighbour left, the tribe pass must run without
// requiring a manual attack to wake it up.
priorityAttackTargets.length = 0;
priorityPlayer.nearby = () => [priorityTribe, priorityEnemy];
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityTribe],
  "a bordering tribe is attacked after TerraNullius is exhausted",
);

// Directly bordering radioactive TerraNullius is still green free land. It is
// eaten first without suppressing the parallel tribe lane.
priorityAttackTargets.length = 0;
priorityAttackCalls.length = 0;
priorityBehavior.attackEarlyGameTribe = async () => {
  priorityAttackTargets.push(priorityTribe);
  return true;
};
priorityPlayer.nearby = () => [];
priorityGame.neighbors = (tile) => (tile === 1 ? [2] : []);
priorityGame.hasFallout = (tile) => tile === 2;
priorityPlayer.nearby = () => [priorityTribe, priorityEnemy];
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityFreeTarget, priorityTribe],
  "radioactive TerraNullius and a bordering tribe expand in parallel",
);
assert.equal(
  priorityAttackCalls[0].args[3],
  true,
  "the direct land grab uses the radioactive troop-cost policy",
);
assert.equal(
  targetSandbox.state.earlyGame.hasFreeLand,
  false,
  "radioactive land does not reactivate the opening-expansion donation veto",
);
priorityGame.hasFallout = () => false;
priorityBehavior.isBorderingNukedTerritory = () => false;

// Directly accessible free land remains the cheapest first move, while the
// minimum-budget tribe capture follows in the same decision.
priorityAttackTargets.length = 0;
priorityGame.neighbors = (tile) => (tile === 1 ? [2, 3] : []);
priorityPlayer.nearby = () => [priorityFreeTarget, priorityTribe, priorityEnemy];
await priorityBehavior.maybeAttack();
assert.deepEqual(
  priorityAttackTargets,
  [priorityFreeTarget, priorityTribe],
  "direct free land is first without blocking a bordering tribe",
);

const enrichedTargets = await targetBehavior.getEarlyGameTribeCandidates();
const oceanTargetRankBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const rankedOceanTargets = [];
for (const target of [
  { tile: 90, dist: 6 },
  { tile: 91, dist: 2 },
  { tile: 92, dist: 2 },
  { tile: 93, dist: 9 },
  { tile: 94, dist: 1 },
  { tile: 95, dist: 4 },
  { tile: 96, dist: 2 },
]) {
  oceanTargetRankBehavior.insertEarlyOceanTarget(rankedOceanTargets, target);
}
assert.deepEqual(
  Array.from(rankedOceanTargets, ({ tile, dist }) => [tile, dist]),
  [
    [94, 1],
    [91, 2],
    [92, 2],
    [96, 2],
  ],
  "streaming ocean-target ranking preserves the stable four-route probe order",
);
const topologySnapshotBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
const topologySnapshot = new Set([11, 12]);
topologySnapshotBehavior.fetchEarlyGameTribeBorder = async () => topologySnapshot;
const topologySnapshotBorders = await topologySnapshotBehavior.fetchEarlyGameTribeTopologyBorders([
  { id: "snapshot-tribe", player: {} },
]);
assert.strictEqual(
  topologySnapshotBorders.get("snapshot-tribe"),
  topologySnapshot,
  "topology retains the immutable API border snapshot instead of cloning it",
);
assert.equal(
  clusterOverlayWakeups,
  1,
  "publishing a preferred tribe cluster starts the initially dormant overlay scheduler",
);
const firstTopologyBorderFetches = topologyBorderFetches;
const riskSnapshotBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let riskSnapshotTick = 1;
let riskSnapshotTroops = 20;
const riskSnapshotType = targetSandbox.PlayerType.Nation;
let riskProfileBuilds = 0;
let riskNodeBuilds = 0;
const riskSnapshotRival = {
  smallID: () => 91,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => riskSnapshotType,
  nameLocation: () => ({ x: 11, y: 12 }),
  numTilesOwned: () => 4,
  troops: () => riskSnapshotTroops,
  outgoingAttacks: () => [],
};
riskSnapshotBehavior.player = { isFriendly: () => false };
riskSnapshotBehavior.game = { ticks: () => riskSnapshotTick };
riskSnapshotBehavior.earlyFoodMovement = new Map();
riskSnapshotBehavior.earlyGameCompetitorProfile = (player) => {
  riskProfileBuilds++;
  return { sid: player.smallID() };
};
const initialRiskProfiles = await riskSnapshotBehavior.getEarlyGameCompetitorProfiles(
  [riskSnapshotRival],
  1,
);
riskSnapshotTick = 20;
assert.strictEqual(
  await riskSnapshotBehavior.getEarlyGameCompetitorProfiles([riskSnapshotRival], 1),
  initialRiskProfiles,
  "an unchanged live competitor snapshot is reused between early-game decisions",
);
assert.equal(riskProfileBuilds, 1);
riskSnapshotTroops = 21;
riskSnapshotTick = 21;
await riskSnapshotBehavior.getEarlyGameCompetitorProfiles([riskSnapshotRival], 1);
assert.equal(
  riskProfileBuilds,
  1,
  "a troop-only change refreshes contested-cluster resources without rebuilding attack topology",
);
assert.equal(
  riskSnapshotBehavior.earlyGameCompetitorProfilesCache.profiles[0].troops,
  21,
  "a troop-only refresh still exposes the live rival troop total to food-race ranking",
);
const passiveTribeSignatureBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let passiveTribeSignatureTick = 1;
let ownSignatureTiles = 10;
let cachedPassiveTribeTiles = 4;
let passiveTribeLocation = { x: 2, y: 2 };
let passiveTribeProfileBuilds = 0;
let passiveTribeMovementRefreshes = 0;
const ownSignaturePlayer = {
  smallID: () => 700,
  isPlayer: () => true,
  isAlive: () => true,
  isFriendly: () => false,
  type: () => targetSandbox.PlayerType.Human,
  nameLocation: () => ({ x: 1, y: 1 }),
  numTilesOwned: () => ownSignatureTiles,
  troops: () => 100,
  outgoingAttacks: () => [],
};
const passiveTribeSignaturePlayer = {
  smallID: () => 701,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => targetSandbox.PlayerType.Bot,
  nameLocation: () => passiveTribeLocation,
  numTilesOwned: () => cachedPassiveTribeTiles,
  troops: () => 10,
  outgoingAttacks: () => [],
};
passiveTribeSignatureBehavior.player = ownSignaturePlayer;
passiveTribeSignatureBehavior.game = { ticks: () => passiveTribeSignatureTick };
passiveTribeSignatureBehavior.earlyFoodMovement = new Map();
passiveTribeSignatureBehavior.earlyGameCompetitorProfile = (other, mySid) => {
  if (other.smallID() === mySid) return null;
  passiveTribeProfileBuilds++;
  return { sid: other.smallID() };
};
passiveTribeSignatureBehavior.earlyGameCompetitorMovement = (other) => {
  passiveTribeMovementRefreshes++;
  return { tiles: other.numTilesOwned(), location: other.nameLocation() };
};
const passiveTribeSignatureProfiles =
  await passiveTribeSignatureBehavior.getEarlyGameCompetitorProfiles(
    [ownSignaturePlayer, passiveTribeSignaturePlayer],
    700,
  );
ownSignatureTiles++;
cachedPassiveTribeTiles++;
passiveTribeSignatureTick = 2;
assert.strictEqual(
  await passiveTribeSignatureBehavior.getEarlyGameCompetitorProfiles(
    [ownSignaturePlayer, passiveTribeSignaturePlayer],
    700,
  ),
  passiveTribeSignatureProfiles,
  "own and passive-tribe territory changes keep the competitor cache hot inside the risk TTL",
);
assert.equal(passiveTribeProfileBuilds, 1);
passiveTribeSignatureTick = 50;
passiveTribeLocation = { x: 9, y: 8 };
const passiveTribeRefreshedProfiles =
  await passiveTribeSignatureBehavior.getEarlyGameCompetitorProfiles(
    [ownSignaturePlayer, passiveTribeSignaturePlayer],
    700,
  );
assert.equal(passiveTribeProfileBuilds, 1, "TTL refresh reuses immutable tribe topology");
assert.equal(passiveTribeMovementRefreshes, 1, "TTL refresh reads live passive tribe progress");
assert.equal(passiveTribeRefreshedProfiles[0].tiles, 5);
assert.deepEqual(
  passiveTribeRefreshedProfiles[0].location,
  { x: 9, y: 8 },
  "a passive tribe movement refreshes its live position without rebuilding attack topology",
);
const perCompetitorTopologyBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let perCompetitorTopologyTick = 1;
let perCompetitorTopologyBuilds = 0;
let perCompetitorStableTroops = 100;
let perCompetitorChangedTarget = 31;
const makePerCompetitor = (sid, troops, target) => ({
  isPlayer: () => true,
  isAlive: () => true,
  smallID: () => sid,
  type: () => targetSandbox.PlayerType.Nation,
  nameLocation: () => ({ x: sid, y: sid }),
  numTilesOwned: () => 10,
  troops: () => troops(),
  outgoingAttacks: () => [
    {
      target: () => ({ smallID: () => target() }),
      troops: () => 10,
      retreating: () => false,
    },
  ],
});
const stableCompetitor = makePerCompetitor(
  20,
  () => perCompetitorStableTroops,
  () => 30,
);
const changedCompetitor = makePerCompetitor(
  21,
  () => 100,
  () => perCompetitorChangedTarget,
);
perCompetitorTopologyBehavior.player = { isFriendly: () => false };
perCompetitorTopologyBehavior.game = { ticks: () => perCompetitorTopologyTick };
perCompetitorTopologyBehavior.earlyFoodMovement = new Map();
let perCompetitorStableSignatureReads = 0;
const originalPerCompetitorStableSignature =
  perCompetitorTopologyBehavior.earlyGameCompetitorStableSignatureRecord;
perCompetitorTopologyBehavior.earlyGameCompetitorStableSignatureRecord = function (...args) {
  perCompetitorStableSignatureReads++;
  return originalPerCompetitorStableSignature.apply(this, args);
};
perCompetitorTopologyBehavior.earlyGameCompetitorProfile = function (...args) {
  perCompetitorTopologyBuilds++;
  return targetSandbox.AttackBehavior.prototype.earlyGameCompetitorProfile.apply(this, args);
};
await perCompetitorTopologyBehavior.getEarlyGameCompetitorProfiles(
  [stableCompetitor, changedCompetitor],
  1,
);
assert.equal(perCompetitorTopologyBuilds, 2);
assert.equal(
  perCompetitorStableSignatureReads,
  2,
  "a full competitor snapshot reuses the cache-key signatures while building profiles",
);
perCompetitorTopologyTick++;
perCompetitorChangedTarget = 32;
perCompetitorStableTroops = 125;
const perCompetitorProfiles = await perCompetitorTopologyBehavior.getEarlyGameCompetitorProfiles(
  [stableCompetitor, changedCompetitor],
  1,
);
assert.equal(
  perCompetitorTopologyBuilds,
  3,
  "a topology change for one competitor rebuilds only that competitor's attack index",
);
assert.equal(
  perCompetitorStableSignatureReads,
  4,
  "each later snapshot computes one stable signature per competitor, not a second profile-loop copy",
);
assert.equal(
  perCompetitorProfiles.find((profile) => profile.sid === 20).troops,
  125,
  "an unchanged competitor still refreshes live troops while its attack topology is reused",
);
riskSnapshotBehavior.createLightweightEarlyGameTribeNode = (tribe, _profiles, races) => {
  riskNodeBuilds++;
  races?.set(tribe.smallID(), { foodRaceValue: 0 });
  return { id: tribe.smallID(), player: tribe, captureRisk: 99 };
};
const currentRiskProfiles = riskSnapshotBehavior.earlyGameCompetitorProfilesCache.profiles;
const firstRiskRaces = new Map();
await riskSnapshotBehavior.getIncrementalEarlyGameTribeNodes(
  [riskSnapshotRival],
  currentRiskProfiles,
  firstRiskRaces,
);
riskSnapshotTick = 30;
const reusedRiskRaces = new Map();
await riskSnapshotBehavior.getIncrementalEarlyGameTribeNodes(
  [riskSnapshotRival],
  currentRiskProfiles,
  reusedRiskRaces,
);
assert.equal(riskNodeBuilds, 1, "unchanged tribe food-race nodes reuse the same short snapshot");
assert.equal(reusedRiskRaces.get(91).foodRaceValue, 0);
riskSnapshotTroops = 22;
riskSnapshotTick = 31;
const refreshedRiskProfiles = await riskSnapshotBehavior.getEarlyGameCompetitorProfiles(
  [riskSnapshotRival],
  1,
);
const refreshedRiskRaces = new Map();
const refreshedRiskNodes = await riskSnapshotBehavior.getIncrementalEarlyGameTribeNodes(
  [riskSnapshotRival],
  refreshedRiskProfiles,
  refreshedRiskRaces,
  false,
);
assert.equal(
  riskNodeBuilds,
  1,
  "a resource-only competitor refresh reuses tribe topology instead of rebuilding every node",
);
assert.equal(refreshedRiskNodes[0].captureRisk, 0);
assert.equal(
  refreshedRiskRaces.size,
  0,
  "the refreshed competitor resources invalidate old food-race values",
);
riskSnapshotTick = 90;
await riskSnapshotBehavior.getIncrementalEarlyGameTribeNodes(
  [riskSnapshotRival],
  refreshedRiskProfiles,
  new Map(),
  false,
);
assert.equal(
  riskNodeBuilds,
  1,
  "topology-only tribe nodes outlive the short food-race snapshot without reusing risk",
);
const liveMembershipBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let liveMembershipTick = 1;
let secondTribeAlive = true;
const liveMembershipTribe = (sid, alive) => ({
  smallID: () => sid,
  isPlayer: () => true,
  isAlive: () => alive(),
  type: () => targetSandbox.PlayerType.Bot,
});
const liveMembershipFirst = liveMembershipTribe(201, () => true);
const liveMembershipSecond = liveMembershipTribe(202, () => secondTribeAlive);
let liveMembershipNodeBuilds = 0;
liveMembershipBehavior.player = { isFriendly: () => false };
liveMembershipBehavior.game = { ticks: () => liveMembershipTick };
liveMembershipBehavior.createLightweightEarlyGameTribeNode = (tribe) => {
  if (!liveMembershipBehavior.isLightweightEarlyGameTribe(tribe)) return null;
  liveMembershipNodeBuilds++;
  return { id: tribe.smallID(), player: tribe, captureRisk: 0 };
};
const liveMembershipProfiles = [];
const liveMembershipFirstNodes = await liveMembershipBehavior.getIncrementalEarlyGameTribeNodes(
  [liveMembershipFirst, liveMembershipSecond],
  liveMembershipProfiles,
  new Map(),
  false,
);
assert.deepEqual(
  Array.from(liveMembershipFirstNodes, (node) => node.id),
  [201, 202],
);
liveMembershipTick = 2;
secondTribeAlive = false;
const liveMembershipRefreshedNodes = await liveMembershipBehavior.getIncrementalEarlyGameTribeNodes(
  [liveMembershipFirst, liveMembershipSecond],
  liveMembershipProfiles,
  new Map(),
  false,
);
assert.deepEqual(
  Array.from(liveMembershipRefreshedNodes, (node) => node.id),
  [201],
  "a tribe capture invalidates the topology node cache before its extended TTL",
);
assert.equal(
  liveMembershipNodeBuilds,
  3,
  "a live tribe-set change rebuilds the topology immediately instead of retaining a captured member",
);
const passiveTribeSnapshotBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let passiveTribeTick = 1;
let passiveTribeTroops = 20;
let passiveTribeTiles = 4;
let passiveTribeProfilesBuilt = 0;
const passiveTribe = {
  smallID: () => 92,
  isPlayer: () => true,
  isAlive: () => true,
  type: () => targetSandbox.PlayerType.Bot,
  nameLocation: () => ({ x: 11, y: 12 }),
  numTilesOwned: () => passiveTribeTiles,
  troops: () => passiveTribeTroops,
  outgoingAttacks: () => [],
};
const passiveTribeOutgoingProfile = Object.create(targetSandbox.AttackBehavior.prototype);
const passiveTribeOutgoing = {
  type: () => targetSandbox.PlayerType.Bot,
  outgoingAttacks: () => {
    throw new Error("passive tribe direct races arrive through candidate incoming attacks");
  },
};
assert.deepEqual(
  Array.from(passiveTribeOutgoingProfile.earlyGameCompetitorOutgoingTargets(passiveTribeOutgoing)),
  [],
  "passive tribe profiling avoids a redundant outgoing-attack traversal",
);
assert.equal(
  passiveTribeOutgoingProfile.earlyGameCompetitorAttackSignature(passiveTribeOutgoing),
  "",
);
passiveTribeSnapshotBehavior.player = { isFriendly: () => false };
passiveTribeSnapshotBehavior.game = { ticks: () => passiveTribeTick };
passiveTribeSnapshotBehavior.earlyFoodMovement = new Map();
passiveTribeSnapshotBehavior.earlyGameCompetitorProfile = () => {
  passiveTribeProfilesBuilt++;
  return { sid: 92 };
};
const passiveTribeProfiles = await passiveTribeSnapshotBehavior.getEarlyGameCompetitorProfiles(
  [passiveTribe],
  1,
);
passiveTribeTroops = 21;
passiveTribeTick = 2;
assert.strictEqual(
  await passiveTribeSnapshotBehavior.getEarlyGameCompetitorProfiles([passiveTribe], 1),
  passiveTribeProfiles,
  "passive tribe production alone does not rebuild every cluster race snapshot",
);
assert.equal(passiveTribeProfilesBuilt, 1);
passiveTribeTiles = 5;
passiveTribeTick = 3;
assert.strictEqual(
  await passiveTribeSnapshotBehavior.getEarlyGameCompetitorProfiles([passiveTribe], 1),
  passiveTribeProfiles,
  "passive tribe territory keeps the shared competitor snapshot hot inside the risk TTL",
);
assert.equal(
  passiveTribeProfilesBuilt,
  1,
  "a territory change does not rebuild the immutable passive-tribe topology",
);
passiveTribeTick = 50;
const expandedPassiveTribeProfiles =
  await passiveTribeSnapshotBehavior.getEarlyGameCompetitorProfiles([passiveTribe], 1);
assert.notStrictEqual(
  expandedPassiveTribeProfiles,
  passiveTribeProfiles,
  "the risk TTL refreshes live passive-tribe progress after bounded reuse",
);
targetTick = 1;
await targetBehavior.getEarlyGameTribeCandidates();
assert.equal(
  topologyBorderFetches,
  firstTopologyBorderFetches,
  "repeated opening decisions reuse the complete tribe topology cache",
);
targetTick = 38;
await targetBehavior.getEarlyGameTribeCandidates();
assert.equal(
  topologyBorderFetches,
  firstTopologyBorderFetches,
  "the complete topology remains reusable through two profiled strategic decisions",
);
targetTick = 241;
await targetBehavior.getEarlyGameTribeCandidates();
assert.ok(
  topologyBorderFetches > firstTopologyBorderFetches,
  "the bounded topology cache refreshes after its twenty-four-second window",
);
targetTick = 1;
assert.equal(
  clusterOverlayWakeups,
  1,
  "publishing an unchanged preferred cluster does not invalidate the shared canvas again",
);
targetBehavior.publishAttackEarlyGameSnapshot({
  hasAccessibleTerraNullius: false,
  borderingEnemies: [],
  border: [],
});
assert.equal(targetSandbox.state.earlyGame.preferredClusterMembers.length, 2);
assert.equal(targetSandbox.state.earlyGame.preferredClusterSize, 2);
assert.ok(targetSandbox.state.earlyGame.preferredClusterCenter);
assert.equal(
  clusterOverlayWakeups,
  1,
  "refreshing the attack snapshot preserves the independently owned cluster overlay state",
);
const temporarilyDistantMe = {
  ...targetMe,
  nearby: () => [],
  sharesBorderWith: () => false,
};
const temporarilyDistantGame = {
  ...targetGame,
  players: () => [temporarilyDistantMe, targetInland, targetNext],
};
const temporarilyDistantBehavior = new targetSandbox.AttackBehavior(
  {},
  temporarilyDistantGame,
  temporarilyDistantMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
temporarilyDistantBehavior.earlyGamePreferredClusterOverlaySignature =
  targetBehavior.earlyGamePreferredClusterOverlaySignature;
assert.equal((await temporarilyDistantBehavior.getEarlyGameTribeCandidates()).length, 0);
assert.equal(targetSandbox.state.earlyGame.preferredClusterMembers.length, 2);
assert.equal(
  clusterOverlayWakeups,
  1,
  "a transient empty nearby selector does not hide a cluster whose tribes remain alive",
);
const noTribeMe = { ...targetMe, nearby: () => [], sharesBorderWith: () => false };
const noTribeGame = { ...targetGame, players: () => [noTribeMe] };
const noTribeBehavior = new targetSandbox.AttackBehavior(
  {},
  noTribeGame,
  noTribeMe,
  0.5,
  0.3,
  0.1,
  {},
  {},
);
noTribeBehavior.earlyGamePreferredClusterOverlaySignature =
  targetBehavior.earlyGamePreferredClusterOverlaySignature;
assert.equal((await noTribeBehavior.getEarlyGameTribeCandidates()).length, 0);
assert.equal(targetSandbox.state.earlyGame.preferredClusterCenter, null);
assert.equal(targetSandbox.state.earlyGame.preferredClusterMembers.length, 0);
assert.equal(targetSandbox.state.earlyGame.preferredClusterSize, 0);
assert.equal(
  clusterOverlayWakeups,
  2,
  "removing the final tribes invalidates the canvas so the stale cluster disappears",
);
assert.doesNotMatch(
  tribeClusterOverlaySource,
  /scan\s*:/,
  "the data-driven tribe overlay must not install a no-op periodic scan",
);
targetTick = 11;
await targetBehavior.getEarlyGameTribeCandidates();
assert.ok(
  topologyBorderFetches > firstTopologyBorderFetches,
  "the tribe topology refreshes after its bounded cache window",
);
const yieldProbeNodes = [{ id: 101 }, { id: 102 }];
const identicalTribeBorder = new Set(Array.from({ length: 1024 }, (_, index) => index));
assert.equal(
  targetBehavior.earlyGameTribeBorderChanged(identicalTribeBorder, identicalTribeBorder),
  false,
  "an identical immutable tribe-border snapshot avoids a full tile comparison",
);
assert.equal(
  targetBehavior.earlyGameTribeBorderChanged(new Set([1, 2]), new Set([1, 2])),
  false,
  "distinct but equal tribe-border snapshots retain the content comparison",
);
const yieldProbeBorders = new Map([
  [101, new Set(Array.from({ length: 4096 }, (_, index) => 10_000 + index))],
  [102, new Set()],
]);
const yieldsBeforeTopologyProbe = topologyYieldCount;
const deadlineReadsBeforeTopologyProbe = topologyDeadlineReads;
await targetBehavior.connectEarlyGameTribeAdjacency(yieldProbeNodes, yieldProbeBorders);
assert.ok(
  topologyYieldCount - yieldsBeforeTopologyProbe >= 2,
  "large tribe-border scans yield before monopolizing a render frame",
);
assert.equal(
  topologyDeadlineReads - deadlineReadsBeforeTopologyProbe,
  33,
  "large tribe-border scans sample the deadline by bounded tile blocks",
);
const ownerOnlyAdjacencyBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
ownerOnlyAdjacencyBehavior.game = {
  forEachNeighbor: (_tile, visit) => visit(20_001),
  neighbors: () => {
    throw new Error("tribe adjacency should use zero-allocation neighbor iteration");
  },
  ownerID: () => 202,
  isLand: () => {
    throw new Error("an edible owner id already proves that the neighbor is land");
  },
};
const ownerOnlyAdjacency = new Map([
  [201, new Set()],
  [202, new Set()],
]);
ownerOnlyAdjacencyBehavior.connectEarlyGameTribeAdjacencyTile(
  201,
  20_000,
  ownerOnlyAdjacencyBehavior.createEarlyGameEdibleIdFlags([{ id: 201 }, { id: 202 }]),
  ownerOnlyAdjacency,
);
assert.equal(ownerOnlyAdjacency.get(201).has(202), true);
assert.equal(ownerOnlyAdjacency.get(202).has(201), true);
const incrementalTopologyBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
let incrementalNeighborCalls = 0;
const topologyOwners = new Map([
  [11, 2],
  [12, 1],
  [21, 1],
  [22, 3],
  [31, 2],
]);
incrementalTopologyBehavior.game = {
  forEachNeighbor: (tile, visit) => {
    incrementalNeighborCalls++;
    visit(tile + 1);
  },
  ownerID: (tile) => topologyOwners.get(tile),
};
const incrementalNodes = [{ id: 1 }, { id: 2 }, { id: 3 }];
const initialIncrementalBorders = new Map([
  [1, new Set([10])],
  [2, new Set([20])],
  [3, new Set([30])],
]);
const initialIncrementalAdjacency =
  await incrementalTopologyBehavior.connectEarlyGameTribeAdjacency(
    incrementalNodes,
    initialIncrementalBorders,
  );
const incrementalCache = {
  signature: incrementalTopologyBehavior.earlyGameTribeTopologySignature(incrementalNodes),
  topologyBordersById: initialIncrementalBorders,
  tribeAdjacency: initialIncrementalAdjacency,
};
incrementalNeighborCalls = 0;
assert.strictEqual(
  await incrementalTopologyBehavior.updateEarlyGameTribeAdjacency(
    incrementalNodes,
    new Map([...initialIncrementalBorders].map(([id, border]) => [id, new Set(border)])),
    incrementalCache,
  ),
  initialIncrementalAdjacency,
  "unchanged tribe borders reuse the exact cached adjacency graph",
);
assert.equal(
  incrementalNeighborCalls,
  0,
  "unchanged tribe borders perform no neighbor topology probes",
);
const originalIncrementalTopologySignature =
  incrementalTopologyBehavior.earlyGameTribeTopologySignature;
incrementalTopologyBehavior.earlyGameTribeTopologySignature = () => {
  throw new Error("a caller-provided topology signature must be reused");
};
assert.strictEqual(
  await incrementalTopologyBehavior.updateEarlyGameTribeAdjacency(
    incrementalNodes,
    new Map([...initialIncrementalBorders].map(([id, border]) => [id, new Set(border)])),
    incrementalCache,
    incrementalCache.signature,
  ),
  initialIncrementalAdjacency,
  "topology refresh reuses the signature already calculated by its caller",
);
incrementalTopologyBehavior.earlyGameTribeTopologySignature = originalIncrementalTopologySignature;
const changedIncrementalBorders = new Map([
  [1, new Set([10])],
  [2, new Set([20, 21])],
  [3, new Set([30])],
]);
incrementalNeighborCalls = 0;
const updatedIncrementalAdjacency = await incrementalTopologyBehavior.updateEarlyGameTribeAdjacency(
  incrementalNodes,
  changedIncrementalBorders,
  incrementalCache,
);
assert.equal(incrementalNeighborCalls, 2, "only a changed tribe border is rescanned");
const fullIncrementalAdjacency = await incrementalTopologyBehavior.connectEarlyGameTribeAdjacency(
  incrementalNodes,
  changedIncrementalBorders,
);
const normalizedAdjacency = (adjacency) =>
  [...adjacency].map(([id, neighbors]) => [id, [...neighbors].sort()]);
assert.deepEqual(
  normalizedAdjacency(updatedIncrementalAdjacency),
  normalizedAdjacency(fullIncrementalAdjacency),
  "incremental tribe adjacency is exactly equivalent to a full rebuild",
);
topologyOwners.set(41, 3);
const addedIncrementalNodes = [...incrementalNodes, { id: 4 }];
const addedIncrementalBorders = new Map([...initialIncrementalBorders, [4, new Set([40])]]);
incrementalNeighborCalls = 0;
const addedIncrementalAdjacency = await incrementalTopologyBehavior.updateEarlyGameTribeAdjacency(
  addedIncrementalNodes,
  addedIncrementalBorders,
  incrementalCache,
);
assert.equal(
  incrementalNeighborCalls,
  1,
  "adding one tribe scans only its new border instead of rebuilding the graph",
);
const fullAddedIncrementalAdjacency =
  await incrementalTopologyBehavior.connectEarlyGameTribeAdjacency(
    addedIncrementalNodes,
    addedIncrementalBorders,
  );
assert.deepEqual(
  normalizedAdjacency(addedIncrementalAdjacency),
  normalizedAdjacency(fullAddedIncrementalAdjacency),
  "adding a tribe incrementally is exactly equivalent to a full rebuild",
);
const addedIncrementalCache = {
  signature: incrementalTopologyBehavior.earlyGameTribeTopologySignature(addedIncrementalNodes),
  topologyBordersById: addedIncrementalBorders,
  tribeAdjacency: addedIncrementalAdjacency,
};
const removedIncrementalNodes = addedIncrementalNodes.filter((tribe) => tribe.id !== 2);
const removedIncrementalBorders = new Map([...addedIncrementalBorders].filter(([id]) => id !== 2));
incrementalNeighborCalls = 0;
const removedIncrementalAdjacency = await incrementalTopologyBehavior.updateEarlyGameTribeAdjacency(
  removedIncrementalNodes,
  removedIncrementalBorders,
  addedIncrementalCache,
);
assert.equal(
  incrementalNeighborCalls,
  0,
  "removing a tribe filters its cached edges without rescanning retained borders",
);
const fullRemovedIncrementalAdjacency =
  await incrementalTopologyBehavior.connectEarlyGameTribeAdjacency(
    removedIncrementalNodes,
    removedIncrementalBorders,
  );
assert.deepEqual(
  normalizedAdjacency(removedIncrementalAdjacency),
  normalizedAdjacency(fullRemovedIncrementalAdjacency),
  "removing a tribe incrementally is exactly equivalent to a full rebuild",
);
const indexedBorderSplitBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
indexedBorderSplitBehavior.player = {
  sharesBorderWith: () => {
    throw new Error("the existing border-owner index should classify candidates");
  },
};
const indexedBorderTribes = [{ smallID: () => 301 }, { smallID: () => 302 }];
const indexedBorderSplit = indexedBorderSplitBehavior.splitEarlyGameTribesByLandBorder(
  indexedBorderTribes,
  new Set([302]),
);
assert.equal(indexedBorderSplit.bordering.length, 1);
assert.strictEqual(indexedBorderSplit.bordering[0], indexedBorderTribes[1]);
assert.equal(indexedBorderSplit.other.length, 1);
assert.strictEqual(indexedBorderSplit.other[0], indexedBorderTribes[0]);
assert.equal(
  targetSandbox.state.earlyGame.preferredClusterMembers
    .map((member) => member.id)
    .sort((left, right) => left - right)
    .join(","),
  "4,5",
  "the overlay receives every tribe in the preferred border-connected component",
);
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
assert.equal(
  enrichedInland.futureFoodCount,
  1,
  "an actionable tribe counts a nearby currently unreachable tribe as continuation food",
);
assert.ok(
  enrichedInland.futureFoodAccess > 0,
  "taking the inland tribe is rewarded for unlocking the adjacent tribe",
);
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

const maritimePolicyOrder = [];
const maritimePolicyBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
maritimePolicyBehavior.attackEarlyGameTribe = async () => {
  maritimePolicyOrder.push("tribe");
  return true;
};
maritimePolicyBehavior.tryMaritimeTerraNulliusProbe = async () => {
  maritimePolicyOrder.push("maritime-probe");
};
assert.equal(
  await maritimePolicyBehavior.tryEarlyAttackPolicies({
    expandOn: true,
    boatOn: true,
    earlyGameSnapshot: { active: true, postSpawn: true, hasTribeTarget: true },
    maritimeTerraNulliusProbeSent: false,
  }),
  true,
);
assert.deepEqual(
  maritimePolicyOrder,
  ["tribe", "maritime-probe"],
  "a maritime tribe conquest reserves its destination before parallel free-land probes",
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
  Infinity,
  "a cold maritime lookup must defer",
);
maritimeBehavior.prepareEarlyGameMaritimeIndexSlice();
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
assert.equal(
  maritimeBehavior.earlyGameMaritimeWaterState[10],
  1,
  "the dense water traversal caches an isolated component as closed",
);
assert.equal(
  maritimeBehavior.earlyGameMaritimeWaterState[17],
  2,
  "the dense water traversal caches an edge-connected component as open",
);
assert.equal(
  maritimeBehavior.earlyGameMaritimeWaterCache.size,
  0,
  "valid map dimensions avoid the allocation-heavy Set fallback",
);
const growingQueueBehavior = new targetSandbox.AttackBehavior(
  {},
  {
    width: () => 2048,
    height: () => 1,
    isWater: () => true,
  },
  {},
  0.5,
  0.3,
  0.1,
  {},
  {},
);
assert.equal(growingQueueBehavior.ensureDenseEarlyGameMaritimeWaterState(), true);
assert.equal(
  growingQueueBehavior.earlyGameMaritimeWaterQueue.length,
  1024,
  "maritime classification must not reserve a map-sized queue before traversal",
);
for (let tile = 0; tile < 1025; tile++) {
  growingQueueBehavior.enqueueDenseEarlyGameWaterNeighbor(tile);
}
assert.equal(growingQueueBehavior.earlyGameMaritimeWaterQueue.length, 2048);
assert.deepEqual(
  [...growingQueueBehavior.earlyGameMaritimeWaterQueue.subarray(0, 1025)],
  Array.from({ length: 1025 }, (_, tile) => tile),
  "growing the dense maritime queue must preserve every pending BFS tile",
);
assert.doesNotMatch(
  attackSource,
  /earlyGameMaritimeWaterQueue\s*=\s*new Int32Array\(total\)/,
  "maritime classification must not synchronously allocate a map-sized queue",
);
const slicedMaritimeBehavior = new targetSandbox.AttackBehavior(
  {},
  maritimeGame,
  {},
  0.5,
  0.3,
  0.1,
  {},
  {},
);
slicedMaritimeBehavior.earlyGameMaritimeSliceWorkRemaining = 1;
assert.equal(slicedMaritimeBehavior.isEarlyGameMaritimeWater(10), null);
slicedMaritimeBehavior.earlyGameMaritimeSliceWorkRemaining = Infinity;
assert.equal(slicedMaritimeBehavior.isEarlyGameMaritimeWater(10), false);
assert.deepEqual(
  [9, 10].map((tile) => slicedMaritimeBehavior.earlyGameMaritimeWaterState[tile]),
  [9, 10].map((tile) => maritimeBehavior.earlyGameMaritimeWaterState[tile]),
  "bounded and synchronous water classification produce the same dense state",
);
const deadlineBoundedMaritimeBehavior = Object.create(targetSandbox.AttackBehavior.prototype);
deadlineBoundedMaritimeBehavior.earlyGameMaritimeSliceWorkRemaining = 1_000_000;
deadlineBoundedMaritimeBehavior.earlyGameMaritimeSliceDeadline = -Infinity;
deadlineBoundedMaritimeBehavior.earlyGameMaritimeSliceDeadlineProbe = 255;
assert.equal(
  deadlineBoundedMaritimeBehavior.consumeEarlyGameMaritimeSliceWork(),
  true,
  "a maritime preparation slice must yield when its time budget expires",
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
targetTick = 50;
const movedEnrichedTargets = await targetBehavior.getEarlyGameTribeCandidates();
const movedInland = movedEnrichedTargets.find((target) => target.id === 4);
assert.ok(movedInland.competitorProgress > 0);
assert.ok(movedInland.competitorVector > 0.5);

process.stdout.write("early-game tests passed\n");
