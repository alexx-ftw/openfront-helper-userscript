import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = fs.readFileSync(path.join(root, "scripts/headless/run-match.mts"), "utf8");
const batch = fs.readFileSync(path.join(root, "scripts/headless/run-batch.mjs"), "utf8");
const matrix = fs.readFileSync(
  path.join(root, "scripts/headless/run-construction-matrix.mjs"),
  "utf8",
);
const comparison = fs.readFileSync(
  path.join(root, "scripts/headless/run-construction-comparison.mjs"),
  "utf8",
);
const constructionScenarios = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/headless/construction-scenarios.json"), "utf8"),
);
const adapter = fs.readFileSync(path.join(root, "scripts/headless/opponent-adapter.js"), "utf8");
const headlessModuleScope = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/headless/package.json"), "utf8"),
);
const structureBehavior = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/structureBehavior.js"),
  "utf8",
);

assert.match(
  structureBehavior,
  /const activeThreat = this\.defensePostThreat\(difficulty\);[\s\S]*if \(activeThreat === null\) return null;/,
  "quiet borders cannot authorize preventive Defense Posts",
);

assert.match(runner, /playlist\.gameConfig\("team"\)/);
assert.match(runner, /Number\(playlistConfig\.playerTeams\) < 2/);
assert.match(
  runner,
  /OFH_GAME_MAP[\s\S]*playerTeams:[\s\S]*\? 2/,
  "a fixed-map Team simulation defaults to two teams so the helper is not assigned to an impossible solo team",
);
assert.match(runner, /difficulty:\s*Difficulty\.Impossible/);
assert.match(runner, /nations:\s*configuredNations/);
assert.match(runner, /createMaxDifficultyOpponent/);
assert.match(adapter, /AUTO_BUILD_ENABLED = process\.env\.OFH_AUTOBUILD !== "0"/);
assert.match(adapter, /build: AUTO_BUILD_ENABLED/);
assert.match(adapter, /"SAM Launcher": AUTO_BUILD_ENABLED/);
assert.match(
  adapter,
  /!player\.isPlayer\?\.\(\) && !this\.game\.inSpawnPhase\?\.\(\)/,
  "the headless adapter must run the bot during spawn even before its territory materializes",
);
assert.equal(
  headlessModuleScope.type,
  "module",
  "The runner's JavaScript adapter must load as ESM under tsx",
);

const constructionTickBudgets = constructionScenarios.scenarios.map((scenario) =>
  Number(scenario.environment.OFH_MAX_TICKS),
);
assert.ok(
  constructionTickBudgets.every((budget) => Number.isInteger(budget) && budget > 0),
  "every construction scenario must cap simulation work with a positive tick budget",
);
assert.equal(
  new Set(constructionTickBudgets).size,
  1,
  "paired construction scenarios must use one shared tick horizon",
);

const runnerLoad = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig",
    "openfront-engine/tsconfig.json",
    "scripts/headless/run-match.mts",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      GAME_ENV: "dev",
      OFH_MAX_TICKS: "0",
      OFH_STARTING_GOLD: "5000000",
    },
    encoding: "utf8",
  },
);
assert.equal(
  runnerLoad.status,
  2,
  "A zero-tick runner exits with its documented no-winner status after loading",
);
assert.match(
  `${runnerLoad.stdout}\n${runnerLoad.stderr}`,
  /"phase":"result"/,
  "The headless runner must execute through adapter import before simulations are trusted",
);
assert.match(
  `${runnerLoad.stdout}\n${runnerLoad.stderr}`,
  /"startingGold":5000000/,
  "The runner must pass the requested starting gold through to the engine configuration",
);
const zeroTickResultLine = `${runnerLoad.stdout}\n${runnerLoad.stderr}`
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.startsWith('{"phase":"result"'));
assert.ok(zeroTickResultLine);
const zeroTickResult = JSON.parse(zeroTickResultLine);
assert.deepEqual(
  zeroTickResult.cumulativeBuildUnitTypes,
  {},
  "the final result always exposes the complete per-unit construction count",
);
assert.deepEqual(
  zeroTickResult.constructionEvents,
  [],
  "the final result always exposes the ordered construction portfolio timeline",
);
assert.deepEqual(
  zeroTickResult.strategicTrajectory,
  {
    peakTiles: 0,
    deepestDrawdownRatio: 1,
    drawdownPeakTiles: 0,
    drawdownTroughTiles: 0,
    drawdownTick: null,
    comebackRecovered: false,
    comebackTick: null,
    closeoutReached: false,
    closeoutTick: null,
    maximumTerritoryShare: 0,
  },
  "the final result always exposes explicit comeback and closeout evidence",
);
const deterministicRunnerStart = () => {
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      "openfront-engine/tsconfig.json",
      "scripts/headless/run-match.mts",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GAME_ENV: "dev",
        OFH_MATCH_SEED: "headless-deterministic-playlist",
        OFH_MAX_TICKS: "0",
      },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 2);
  const start = `${run.stdout}\n${run.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{"phase":"start"'));
  assert.ok(start, "the zero-tick run must report its selected match configuration");
  return JSON.parse(start);
};
const deterministicStartA = deterministicRunnerStart();
const deterministicStartB = deterministicRunnerStart();
assert.deepEqual(
  {
    map: deterministicStartA.map,
    mapSize: deterministicStartA.mapSize,
    mode: deterministicStartA.mode,
    teams: deterministicStartA.teams,
    difficulty: deterministicStartA.difficulty,
    nations: deterministicStartA.nations,
    tribes: deterministicStartA.tribes,
    myTeam: deterministicStartA.myTeam,
  },
  {
    map: deterministicStartB.map,
    mapSize: deterministicStartB.mapSize,
    mode: deterministicStartB.mode,
    teams: deterministicStartB.teams,
    difficulty: deterministicStartB.difficulty,
    nations: deterministicStartB.nations,
    tribes: deterministicStartB.tribes,
    myTeam: deterministicStartB.myTeam,
  },
  "the same match seed must select the same headless Team configuration",
);

function runHeadlessScenario(environment) {
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      "openfront-engine/tsconfig.json",
      "scripts/headless/run-match.mts",
    ],
    {
      cwd: root,
      env: { ...process.env, GAME_ENV: "dev", ...environment },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  const records = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { run, records };
}

const naturalRuntime = runHeadlessScenario({
  OFH_MATCH_SEED: "legendary-adapter-natural-20260809",
  OFH_GAME_MAP: "Alps",
  OFH_GAME_MAP_SIZE: "Small",
  OFH_GAME_MODE: "team",
  OFH_PLAYER_TEAMS: "2",
  OFH_BOTS: "10",
  OFH_NATIONS: "disabled",
  OFH_MAX_TICKS: "1800",
  OFH_STOP_WHEN_DEAD: "0",
  OFH_LOG_SPAWN: "1",
  OFH_LOG_INTENTS: "1",
});
assert.equal(naturalRuntime.run.status, 2, "the bounded natural scenario must finish at max ticks");
const naturalResult = naturalRuntime.records.find((record) => record.phase === "result");
const naturalSpawn = naturalRuntime.records.find((record) => record.phase === "spawn-materialized");
const naturalSpawnRanking = naturalRuntime.records.find(
  (record) => record.kind === "spawn-ranking" && record.phase === "spawn-selection-trace",
);
const naturalDecisions = naturalRuntime.records.filter((record) => record.phase === "decision");
assert.ok(naturalResult, "the natural scenario must expose a terminal engine result");
assert.equal(naturalResult.spawnLifecycle.hasSpawned, true);
assert.ok(
  naturalResult.finalBotState.tiles > 0,
  "the real SpawnExecution must materialize territory",
);
assert.ok(naturalSpawn?.self?.tiles > 0, "spawn telemetry must report engine-owned territory");
assert.equal(typeof naturalSpawnRanking?.selectedKey, "string");
assert.ok(
  naturalDecisions.some((decision) =>
    decision.intents?.some((intent) => intent.type === "spawn" && Number.isFinite(intent.tile)),
  ),
  "the real adapter must emit a finite spawn intent before materialization",
);
const naturalAttackDecision = naturalDecisions.find((decision) =>
  decision.intents?.some(
    (intent) => intent.type === "attack" && Number.isFinite(intent.troops) && intent.troops > 0,
  ),
);
assert.ok(naturalAttackDecision, "the real adapter must emit a positive-troop combat intent");
assert.ok(
  naturalAttackDecision.intents?.some(
    (intent) => intent.type === "attack" && intent.attackTargetSnapshot,
  ) && naturalAttackDecision.attackTargets?.some((target) => target.committedTroops > 0),
  "combat telemetry must retain the authoritative target snapshot and committed troops",
);
assert.ok(naturalResult.cumulativeIntentTypes.attack > 0);

const naturalNuclearRuntime = runHeadlessScenario({
  OFH_MATCH_SEED: "legendary-nuclear-natural-20260809",
  OFH_GAME_MAP: "Baikal Nuke Wars",
  OFH_GAME_MAP_SIZE: "Small",
  OFH_GAME_MODE: "team",
  OFH_PLAYER_TEAMS: "2",
  OFH_BOTS: "20",
  OFH_NATIONS: "disabled",
  OFH_NUKES: "1",
  OFH_STARTING_GOLD: "5000000",
  OFH_MAX_TICKS: "3500",
  OFH_STOP_WHEN_DEAD: "0",
  OFH_PROGRESS_TICKS: "3500",
});
assert.equal(
  naturalNuclearRuntime.run.status,
  2,
  "the bounded natural nuclear scenario must finish at max ticks",
);
const naturalNuclearResult = naturalNuclearRuntime.records.find(
  (record) => record.phase === "result",
);
const naturalNuclearProgress = naturalNuclearRuntime.records.find(
  (record) => record.phase === "progress" && record.tick === 3500,
);
assert.ok(naturalNuclearResult);
assert.ok(naturalNuclearResult.cumulativeBuildUnitTypes["Missile Silo"] > 0);
assert.ok(Array.isArray(naturalNuclearProgress?.activeMissiles));
assert.ok(
  naturalNuclearProgress.units["Missile Silo"] > 0,
  "nuclear-enabled simulation must expose the real Silo state through engine progress",
);

assert.match(runner, /OFH_GAME_MAP/);
assert.match(runner, /OFH_STARTING_GOLD/);
assert.match(runner, /OFH_NATIONS/);
assert.match(
  runner,
  /OFH_NATIONS must be default, disabled, or an integer from 1 to 400/,
  "headless scenarios can independently control Nation pressure and Tribe density",
);
assert.match(runner, /OFH_NUKES === "1"/);
assert.match(
  runner,
  /disabledUnits:[\s\S]*nuclearUnitTypes\.has/,
  "a targeted headless match can enable the complete Silo/SAM/nuke path without changing ordinary defaults",
);
assert.match(runner, /non-negative safe integer/);
assert.match(runner, /startingGold: config\.startingGold \?\? 0/);
assert.match(runner, /OFH_PROGRESS_TICKS/);
assert.match(runner, /OFH_PROGRESS_FROM_TICK/);
assert.match(runner, /OFH_SLOW_TICK_MS/);
assert.match(runner, /OFH_STOP_WHEN_DEAD/);
assert.match(runner, /OFH_SPAWN_FAILURE_GRACE_TICKS/);
assert.match(runner, /"spawn_failed"/);
assert.match(
  runner,
  /!hasEverBeenAlive[\s\S]*spawnLifecycle\.inSpawnPhase === false/,
  "a simulation which leaves spawn without territory must be classified as a spawn failure",
);
assert.match(runner, /OFH_PROFILE_BOT/);
assert.match(runner, /autoBuild: bot\.features\.build === true/);
assert.match(runner, /OFH_TRACE_FILE/);
assert.match(runner, /appendFileSync\(traceFile/);
assert.match(runner, /const logSamLifecycle = logStructures \|\| traceFile !== undefined/);
assert.match(runner, /OFH_LOG_INTENTS/);
assert.match(runner, /OFH_LOG_NAVAL/);
assert.match(runner, /OFH_LOG_ATTACK_HOTSPOTS/);
assert.match(runner, /phase: "attack-hotspot-trace"/);
assert.match(runner, /OFH_INJECT_OWN_PORT/);
assert.match(runner, /OFH_INJECT_HOSTILE_TRANSPORT/);
assert.match(runner, /OFH_INJECT_RAIL_ECONOMY/);
assert.match(
  runner,
  /new FactoryExecution\(factory\)[\s\S]*rail-economy-fixture-injected/,
  "the rail-economy fixture must register a real Factory station through the engine",
);
assert.match(
  runner,
  /new TrainExecution\(runner\.game\.railNetwork\(\), me, source, destination, 0\)[\s\S]*paidStops/,
  "the rail-economy fixture must observe an engine TrainExecution and report paid stops",
);
assert.match(
  runner,
  /new TransportShipExecution\(hostile, target, troops\)/,
  "the maritime emergency fixture must use the engine transport execution",
);
assert.match(
  runner,
  /me\.buildUnit\(UnitType\.Port, coastTile, \{\}\)[\s\S]{0,500}own-port-injected/,
  "the naval fixture must materialize an own coastal Port through the engine",
);
assert.match(
  adapter,
  /maritimeEmergency,/,
  "naval traces must expose whether a maritime emergency bypass is active",
);
assert.match(adapter, /deferFirstSam:/, "naval traces must expose the first-SAM reserve decision");
assert.match(
  adapter,
  /deferOffensive:/,
  "naval traces must expose the reserve decisions that precede a warship build",
);
assert.match(
  adapter,
  /warshipRoll[\s\S]{0,500}random\.chance/,
  "naval traces must record the ordinary initial-warship random roll",
);
assert.match(runner, /OFH_LOG_STRUCTURES/);
assert.match(runner, /OFH_LOG_SPAWN/);
assert.match(
  runner,
  /process\.stderr\.write\(`\$\{JSON\.stringify\(finalResult\)\}\\n`, \(\) => \{[\s\S]*hostileMissileFixtureComplete[\s\S]*process\.exit\(won && hostileMissileFixtureComplete \? 0 : 2\)/,
  "a terminal match result must flush before exiting, and a hostile-missile fixture must complete its observable lifecycle",
);
assert.match(runner, /phase:\s*"spawn-selection-trace"/);
assert.match(adapter, /kind:\s*"spawn-ranking"/);
assert.match(adapter, /topSpots:\s*Array\.isArray\(topSpots\)/);
assert.match(adapter, /teamAnchors:\s*Array\.isArray\(spawnPoints\?\.teamSpawns\)/);
assert.match(adapter, /selectedInsideTeamRegion/);
assert.match(adapter, /isPointInsideTeamSpawnRegion/);
assert.match(adapter, /kind: "spawn-gate"/);
assert.match(adapter, /spawnEnabled: nationBot\.feat\?\.\("spawn"\) === true/);
assert.match(adapter, /getIntentRateLimitSnapshot/);
assert.match(
  adapter,
  /getSpawnTiles\(this\.game, tile, false\)[\s\S]*validSpawn\.length > 0/,
  "the headless spawn gate must match SpawnExecution's partial-footprint semantics",
);
assert.match(runner, /phase:\s*"spawn-materialized"/);
assert.match(runner, /phase:\s*"decision"/);
assert.match(runner, /attackTargets/);
assert.match(runner, /targetKind/);
assert.match(
  runner,
  /PlayerType\.Bot && config\.nations === "disabled"/,
  "Tribe-only simulations label captured engine Bots as Tribes for offline analysis",
);
assert.match(runner, /donationStrategicBorderPressure/);
assert.match(runner, /plannerRefreshStarts/);
assert.match(runner, /plannerEmptyCacheHits/);
assert.match(runner, /plannerEmptyRetryAtTick/);
assert.match(runner, /targetTroops/);
assert.match(runner, /pendingTroops/);
assert.match(runner, /committedTroops/);
assert.match(runner, /recentCommittedTroops/);
assert.match(runner, /robustCaptureFloor/);
assert.match(runner, /Math\.ceil\(\(snapshot\?\.troops.*\* 1\.6\)/);
assert.match(
  runner,
  /Math\.max\(\s*Number\(snapshot\?\.pendingTroops\) \|\| 0,\s*liveCommittedTroops,\s*recentCommittedTroops/,
);
assert.match(runner, /RECENT_ATTACK_INTENT_COMMITMENT_TICKS = 10/);
assert.match(runner, /attackTargetSnapshot/);
assert.match(adapter, /attackTargetSnapshot/);
assert.match(adapter, /eventToIntent\(event, bot\.game, bot\.clientID\)/);
assert.match(runner, /phase:\s*"naval-trace"/);
assert.match(runner, /phase:\s*"slow_tick"/);
assert.match(
  runner,
  /spawnLifecycle: profileBot \? bot\.getSpawnLifecycleSnapshot\(\) : undefined/,
);
assert.match(runner, /phase:\s*"first-incoming-land-attack"/);
assert.match(runner, /phase:\s*"first-territory-loss"/);
assert.match(runner, /phase:\s*"sam-lifecycle"/);
assert.match(runner, /event:\s*"removed"/);
assert.match(runner, /decisionMs/);
assert.match(runner, /executionMs/);
assert.match(
  runner,
  /engineState:\s*slowTickEngineSnapshot\(\)/,
  "slow-tick telemetry includes a static engine-state snapshot for causal profiling",
);
assert.match(runner, /activeLandAttacks:/);
assert.match(runner, /missiles:\s*unitCount\(trackedMissileTypes\)/);
assert.match(runner, /stopReason/);
assert.match(runner, /finalBotState/);
assert.match(runner, /maxTroops: runner\.game\.config\(\)\.maxTroops\(finalMe\)/);
assert.match(runner, /spawnLifecycle: bot\.getSpawnLifecycleSnapshot\(\)/);
assert.match(runner, /performanceProfile/);
assert.match(
  runner,
  /cumulativeIntentTypes:[\s\S]*performanceProfile: profileBot \? bot\.getPerformanceProfile\(\) : undefined,[\s\S]*elapsedMs/,
  "persisted progress checkpoints retain the aggregate bot profile even when no later tick crosses the slow threshold",
);
assert.match(runner, /intervalIntentTypes/);
assert.match(runner, /cumulativeIntentTypes/);
assert.match(runner, /intervalBuildUnitTypes/);
assert.match(runner, /cumulativeBuildUnitTypes/);
assert.match(runner, /constructionPortfolioSnapshot/);
assert.match(runner, /constructionEvents:\s*cumulativeBuildEvents/);
assert.match(runner, /strategicTrajectory:\s*\{/);
assert.match(runner, /deepestDrawdownRatio/);
assert.match(runner, /comebackRecovered/);
assert.match(runner, /closeoutReached/);
assert.match(runner, /phase: "result",\s*seed,/);
assert.match(runner, /intent\.type !== "upgrade_structure"/);
assert.match(runner, /action:\s*intent\.type === "upgrade_structure"/);
assert.match(runner, /underConstruction:/);
assert.match(runner, /levels:/);
assert.match(runner, /intent\.type !== "build_unit"/);
assert.match(runner, /intervalBuildEvents/);
assert.match(runner, /strategicBorderPressureSnapshot/);
assert.match(runner, /const playerField = \(player: unknown, field: string\)/);
assert.match(runner, /hostileRatio/);
assert.match(runner, /canAffordDefensePost/);
assert.match(runner, /buildStrategicBorderPressure/);
assert.match(adapter, /kind: "sam-gate"/);
assert.match(adapter, /kind: "ocean-port-availability"/);
assert.match(adapter, /originalHasOceanPortTiles/);
assert.match(adapter, /handleHostileSiloSamMaximumPriority/);
assert.match(adapter, /kind: "defense-post-probe"/);
assert.match(adapter, /kind: "land-defense"/);
assert.match(adapter, /respondToIncomingAttack/);
assert.match(adapter, /kind: "forced-retaliation-gate"/);
assert.match(adapter, /attackBlocked: context\.attackBlocked/);
assert.match(adapter, /phase: "warship-build"/);
assert.match(adapter, /originalMaybeSpawnWarship/);
assert.match(adapter, /typeof value === "bigint" \? String\(value\) : value/);
assert.match(runner, /countIntents\(intents, runner\.game\.ticks\(\)\)/);
assert.match(runner, /intervalTerraNulliusAttacks/);
assert.match(runner, /cumulativeTerraNulliusAttacks/);
assert.match(runner, /intent\.type === "attack" && intent\.targetID === null/);
assert.match(runner, /incoming,\s*outgoing,\s*units,/);
assert.match(runner, /unitDetails,/);
assert.match(runner, /externalSiloNetworks,/);
assert.match(runner, /siloCapacity/);
assert.match(runner, /siloLevels/);
assert.match(runner, /PREEMPTIVE_SAM_SILO_GOLD/);
assert.match(runner, /incomingAttackPressure/);
assert.match(runner, /outgoingAttackTroops/);
assert.match(runner, /activeMissiles,/);
assert.match(runner, /OFH_INJECT_HOSTILE_ATOM/);
assert.match(runner, /OFH_INJECT_HOSTILE_ATOM_AT_TICK/);
assert.match(runner, /hostile-missile-injected/);
assert.match(runner, /hostile-missile-resolved/);
assert.match(runner, /new NukeExecution\(UnitType\.AtomBomb/);
assert.match(runner, /hostile\.addGold\(100_000_000n\)/);
assert.match(runner, /hostileMissileSeen/);
assert.match(runner, /hostileMissileFixtureComplete/);
assert.match(runner, /hostile-missile-injection-missed/);
assert.match(runner, /phase:\s*"conquered"/);
assert.match(runner, /productionReserve/);
assert.match(runner, /liveReserve/);
assert.match(runner, /pendingTroops/);
assert.match(batch, /availableParallelism\(\)/);
assert.match(batch, /spawn\(/);
assert.match(batch, /OFH_SIM_WORKERS/);
assert.match(batch, /OFH_SIM_OUTPUT_DIR/);
assert.match(batch, /results\.json/);
assert.match(batch, /JSON\.stringify\(\{ summary, results \}/);
assert.match(batch, /batchSeed,/);
assert.match(batch, /process\.env\.OFH_BUNDLE_PATH \?\?/);
assert.match(matrix, /OFH_CONSTRUCTION_SCENARIOS/);
assert.match(matrix, /OFH_CAMPAIGN_SEED/);
assert.match(matrix, /OFH_SCENARIOS/);
assert.match(matrix, /Unknown construction scenarios/);
assert.match(matrix, /matrix\.json/);
assert.match(comparison, /OFH_BASELINE_BUNDLE and OFH_CANDIDATE_BUNDLE are required/);
assert.match(comparison, /OFH_COMPARISON_SEED/);
assert.match(comparison, /baselineSeed/);
assert.match(comparison, /candidateSeed/);
assert.match(comparison, /Unpaired result count/);
assert.match(comparison, /comebackRecoveries/);
assert.match(comparison, /closeouts/);
assert.match(comparison, /averageDeepestDrawdownRatio/);
assert.match(comparison, /constructionActionCount/);
assert.match(comparison, /constructionActions/);
assert.match(comparison, /candidateAggregate\.upgrades/);
assert.match(comparison, /comparison\.json/);
assert.deepEqual(
  constructionScenarios.scenarios.map(({ id }) => id),
  [
    "inland-alps",
    "inland-alps-rich-team",
    "mixed-europe",
    "ffa-europe-low-gold",
    "team-four-islands",
    "naval-archipelago",
    "nuclear-baikal",
    "nuclear-europe-rich",
  ],
);
for (const scenario of constructionScenarios.scenarios) {
  assert.equal(typeof scenario.role, "string");
  assert.equal(typeof scenario.environment.OFH_GAME_MAP, "string");
}
assert.equal(
  constructionScenarios.scenarios.find(({ id }) => id === "ffa-europe-low-gold")?.environment
    .OFH_GAME_MODE,
  "ffa",
  "the construction matrix includes a real free-for-all regime",
);
assert.deepEqual(
  constructionScenarios.scenarios.map(({ environment }) => environment.OFH_GAME_MAP),
  [
    "Alps",
    "Alps",
    "Europe",
    "Europe",
    "Four Islands",
    "ArchipelagoSea",
    "Baikal Nuke Wars",
    "Europe",
  ],
  "scenario maps use GameMapType values accepted by the production map loader",
);
assert.deepEqual(
  constructionScenarios.scenarios.map(({ environment }) => environment.OFH_GAME_MAP_SIZE),
  ["Normal", "Normal", "Small", "Small", "Normal", "Normal", "Small", "Small"],
  "fixed-map scenarios retain the map resolution required by their configured Nations and tribe coordinates",
);
assert.match(adapter, /deterministicDeadlineMs \+= 0\.25/);
assert.match(adapter, /window\.__OFH_profileNow = \(\) => performance\.now\(\) - profileStartedAt/);
assert.match(
  adapter,
  /Keep the two clocks independent/,
  "profiling uses an independent clock and cannot consume strategic slice budget",
);
assert.doesNotMatch(
  adapter,
  /window\.__OFH_deadlineNow = hostDeadlineNow/,
  "headless policy decisions cannot depend on host wall-clock load",
);
assert.match(adapter, /sam-upgrade-plan/);
assert.match(adapter, /targetLevel: plan\?\.targetLevel/);
assert.match(adapter, /defense-post-fallback/);
assert.match(adapter, /defense-post-attempt/);
assert.match(adapter, /beginAutoBotProfileTick/);
assert.match(adapter, /drainStructureTrace/);
assert.match(adapter, /enableSpawnTrace/);
assert.match(adapter, /drainSpawnTrace/);
assert.match(adapter, /hasSpawned: player\.hasSpawned\?\.\(\) === true/);
assert.match(adapter, /getPerformanceProfile/);
assert.match(adapter, /attackHotspotTrace/);
assert.match(adapter, /drainAttackHotspotTrace/);
assert.match(adapter, /getSpawnLifecycleSnapshot/);
assert.match(adapter, /awaitingTeamGeometry/);
assert.match(adapter, /caller: new Error\(\)\.stack\?\.split\("\\n"\)\[2\]/);
assert.match(
  adapter,
  /event\.unitIds === undefined/,
  "a warship move must never satisfy the spawn-event shape",
);
assert.ok(
  adapter.indexOf("warshipEventToIntent(event) ??") <
    adapter.indexOf("spawnEventToIntent(event) ??"),
  "warship events must be serialized before the more generic spawn shape",
);
assert.match(
  adapter,
  /return intents\.filter\(\(intent\) => intent\?\.type !== "spawn"\)/,
  "post-opening spawn intents must be rejected before reaching SpawnExecution",
);
assert.match(
  runner,
  /await new Promise<void>\(\(resolve\) => setImmediate\(resolve\)\)/,
  "the max-speed runner must yield a host task so cooperative bot timers can advance",
);
assert.match(
  runner,
  /plannerRefreshStage:/,
  "match telemetry must distinguish a pending tribe refresh from a completed scored cache",
);
assert.match(runner, /plannerRefreshPending:/);
assert.match(runner, /plannerScoredCount:/);
assert.match(
  fs.readFileSync(path.join(root, "engine/ingame/auto-bot/attackBehavior.js"), "utf8"),
  /attack-context/,
);
assert.doesNotMatch(
  adapter,
  /return new Proxy\(game/,
  "the simulation game surface must not pay a Proxy trap on every engine read",
);
assert.doesNotMatch(
  `${runner}\n${batch}\n${adapter}`,
  /\bcatch\b|\.catch\(/,
  "headless simulation code must let failures propagate",
);
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "engine/ingame/companion/actions.js"), "utf8"),
  /\bcatch\b|\.catch\s*\(/,
  "companion actions must let integration failures propagate",
);
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "engine/ingame/companion/core.js"), "utf8"),
  /\bcatch\b|\.catch\s*\(/,
  "companion core must let storage and game-surface failures propagate",
);
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "engine/ingame/companion/engine.js"), "utf8"),
  /\bcatch\b|\.catch\s*\(/,
  "companion engine must let queued, tick, and UI failures propagate",
);
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "engine/ingame/companion/panel.js"), "utf8"),
  /\bcatch\b|\.catch\s*\(/,
  "companion panel must let translation, event, and rendering failures propagate",
);
assert.doesNotMatch(
  fs.readFileSync(path.join(root, "engine/ingame/companion/commands.js"), "utf8"),
  /\bcatch\b|\.catch\s*\(/,
  "companion command collection must not hide identity or message failures",
);

function productionJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionJavaScriptFiles(fullPath));
    else if (/\.(?:js|mjs|mts)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

const productionSources = [
  path.join(root, "build.mjs"),
  ...productionJavaScriptFiles(path.join(root, "engine")),
  ...productionJavaScriptFiles(path.join(root, "scripts")),
];
for (const sourcePath of productionSources) {
  assert.doesNotMatch(
    fs.readFileSync(sourcePath, "utf8"),
    /\bcatch\b|\.catch\s*\(/,
    `${path.relative(root, sourcePath)} must let failures propagate`,
  );
}

process.stdout.write("headless simulation contract tests passed\n");
