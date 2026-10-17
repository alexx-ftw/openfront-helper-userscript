import assert from "node:assert/strict";
import { readStructureBehaviorSource } from "./helpers/structure-behavior-source.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cooperativeTimers = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig",
    "openfront-engine/tsconfig.json",
    "test/headless-cooperative-timers.mts",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(cooperativeTimers.status, 0, cooperativeTimers.stdout + cooperativeTimers.stderr);
for (const fixture of [
  "test/nuke-territory-race-fixture.mts",
  "test/nuke-salvo-receipt-fixture.mts",
  "test/nuke-salvo-reload-boundary-fixture.mts",
  "test/nuke-salvo-pending-forecast-fixture.mts",
  "test/nuke-salvo-off-approach-intercept-fixture.mts",
  "test/nuke-finisher-friendly-gate-fixture.mts",
]) {
  const native = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      "openfront-engine/tsconfig.json",
      fixture,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(native.status, 0, native.stdout + native.stderr);
}
const nuclearWorkerIpc = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig",
    "openfront-engine/tsconfig.json",
    "test/nuclear-worker-ipc-fixture.mts",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(nuclearWorkerIpc.status, 0, nuclearWorkerIpc.stdout + nuclearWorkerIpc.stderr);
const nativeNuclearBuildMenu = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig",
    "openfront-engine/tsconfig.json",
    "test/native-nuclear-build-menu-fixture.mts",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(
  nativeNuclearBuildMenu.status,
  0,
  nativeNuclearBuildMenu.stdout + nativeNuclearBuildMenu.stderr,
);
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
const structureBehavior = readStructureBehaviorSource();
const nationExecution = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/nationExecution.js"),
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
assert.match(runner, /botDifficulty: "Legendary"/);
assert.match(adapter, /this\.difficulty = "Legendary"/);
assert.match(runner, /nations:\s*configuredNations/);
assert.match(runner, /createMaxDifficultyOpponent/);
assert.match(adapter, /AUTO_BUILD_ENABLED = process\.env\.OFH_AUTOBUILD !== "0"/);
assert.match(adapter, /build: AUTO_BUILD_ENABLED/);
assert.match(adapter, /"SAM Launcher": AUTO_BUILD_ENABLED/);
const warshipPhase = nationExecution.indexOf('profile, "warship-build"');
const ordinaryStructurePhase = nationExecution.indexOf('profile, "structures"');
assert.ok(
  warshipPhase >= 0 && ordinaryStructurePhase > warshipPhase,
  "the affordable first Warship probe must precede ordinary structure spending",
);
assert.match(
  adapter,
  /player\.isPlayer\?\.\(\) \|\| this\.game\.inSpawnPhase\?\.\(\)/,
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

let headlessScenarioIndex = 0;
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
  // Keep optional offline evidence for expensive fixed-seed regression failures.
  if (process.env.OFH_TEST_ARTIFACT_DIR) {
    fs.mkdirSync(process.env.OFH_TEST_ARTIFACT_DIR, { recursive: true });
    const artifact = path.join(
      process.env.OFH_TEST_ARTIFACT_DIR,
      `scenario-${String(++headlessScenarioIndex).padStart(2, "0")}`,
    );
    fs.writeFileSync(
      `${artifact}.json`,
      JSON.stringify({ environment, status: run.status }, null, 2),
    );
    fs.writeFileSync(`${artifact}.jsonl`, output);
  }
  const records = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { run, records };
}

const profileScenarios = [
  {
    name: "none",
    environment: {
      OFH_NO_MODIFIERS: "1",
      OFH_GAME_MAP: "Alps",
      OFH_GAME_MAP_SIZE: "Normal",
      OFH_GAME_MODE: "team",
      OFH_PLAYER_TEAMS: "2",
      OFH_BOTS: "4",
      OFH_NATIONS: "disabled",
      OFH_MAX_TICKS: "10",
    },
    expected: { profile: "none", startingGold: 0, spawnImmunityDuration: 50 },
  },
  {
    name: "5MM",
    environment: {
      OFH_5MM: "1",
      OFH_GAME_MAP: "Alps",
      OFH_GAME_MAP_SIZE: "Normal",
      OFH_GAME_MODE: "team",
      OFH_PLAYER_TEAMS: "2",
      OFH_BOTS: "4",
      OFH_NATIONS: "disabled",
      OFH_MAX_TICKS: "10",
    },
    expected: { profile: "5MM", startingGold: 5_000_000, spawnImmunityDuration: 450 },
  },
  {
    name: "25MM",
    environment: {
      OFH_25MM: "1",
      OFH_GAME_MAP: "Alps",
      OFH_GAME_MAP_SIZE: "Normal",
      OFH_GAME_MODE: "team",
      OFH_PLAYER_TEAMS: "2",
      OFH_BOTS: "4",
      OFH_NATIONS: "disabled",
      OFH_MAX_TICKS: "10",
    },
    expected: { profile: "25MM", startingGold: 25_000_000, spawnImmunityDuration: 450 },
  },
  {
    name: "temporary-pvp-immunity",
    environment: {
      OFH_TEMP_PVP_IMMUNITY: "1",
      OFH_GAME_MAP: "Alps",
      OFH_GAME_MAP_SIZE: "Normal",
      OFH_GAME_MODE: "team",
      OFH_PLAYER_TEAMS: "2",
      OFH_BOTS: "4",
      OFH_NATIONS: "disabled",
      OFH_MAX_TICKS: "10",
    },
    expected: { profile: "temporary-pvp-immunity", startingGold: 0, spawnImmunityDuration: 2_400 },
  },
];
for (const scenario of profileScenarios) {
  const runtime = runHeadlessScenario(scenario.environment);
  const start = runtime.records.find((record) => record.phase === "start");
  assert.ok(start, `${scenario.name} profile must emit start telemetry`);
  assert.equal(start.profile, scenario.expected.profile);
  assert.equal(start.startingGold, scenario.expected.startingGold);
  assert.equal(start.spawnImmunityDuration, scenario.expected.spawnImmunityDuration);
  let expectedModifiers;
  if (scenario.expected.profile === "none") {
    expectedModifiers = {};
  } else if (scenario.expected.profile === "5MM") {
    expectedModifiers = { startingGold: 5_000_000 };
  } else if (scenario.expected.profile === "25MM") {
    expectedModifiers = { startingGold: 25_000_000 };
  } else {
    expectedModifiers = { isPeaceTime: true };
  }
  assert.deepEqual(start.publicGameModifiers, expectedModifiers);
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
const naturalOpeningGates = naturalRuntime.records.filter(
  (record) => record.kind === "opening-expansion-gate",
);
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
let longestUnchangedActionableOpeningRemainder = 0;
let currentUnchangedActionableOpeningRemainder = 0;
let previousOpeningRemainder = null;
for (const gate of naturalOpeningGates) {
  const remaining = gate.before?.remaining;
  const actionableRemainder =
    gate.before?.attackable === true &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    Number(gate.before?.pending) === 0;
  if (actionableRemainder && remaining === previousOpeningRemainder) {
    currentUnchangedActionableOpeningRemainder += 1;
  } else {
    currentUnchangedActionableOpeningRemainder = actionableRemainder ? 1 : 0;
  }
  previousOpeningRemainder = actionableRemainder ? remaining : null;
  longestUnchangedActionableOpeningRemainder = Math.max(
    longestUnchangedActionableOpeningRemainder,
    currentUnchangedActionableOpeningRemainder,
  );
}
assert.ok(
  longestUnchangedActionableOpeningRemainder <= 8,
  `the real opening must spend an actionable finite tail instead of freezing it for ${longestUnchangedActionableOpeningRemainder} ticks`,
);
const firstExpiredOpeningGate = naturalOpeningGates.findIndex(
  (gate) => gate.before?.remaining === null,
);
assert.ok(firstExpiredOpeningGate >= 0, "the real trace must reach the end of its bounded opening");
let expiredOpeningGateHoldTicks = 0;
for (const gate of naturalOpeningGates.slice(firstExpiredOpeningGate)) {
  if (gate.followUpAfter !== true) break;
  expiredOpeningGateHoldTicks += 1;
}
assert.ok(
  expiredOpeningGateHoldTicks <= 8,
  `an expired opening allowance must return control to the full planner instead of holding it for ${expiredOpeningGateHoldTicks} ticks`,
);

const anchoredTeamRuntime = runHeadlessScenario({
  OFH_MATCH_SEED: "legendary-anchor-a-20260809",
  OFH_GAME_MAP: "Alps",
  OFH_GAME_MAP_SIZE: "Small",
  OFH_GAME_MODE: "team",
  OFH_PLAYER_TEAMS: "2",
  OFH_BOTS: "0",
  OFH_NATIONS: "10",
  OFH_MAX_TICKS: "140",
  OFH_STOP_WHEN_DEAD: "0",
  OFH_LOG_SPAWN: "1",
});
assert.equal(
  anchoredTeamRuntime.run.status,
  2,
  "the bounded team-anchor scenario reaches max ticks",
);
const anchoredTeamRanking = anchoredTeamRuntime.records.find(
  (record) =>
    record.kind === "spawn-ranking" &&
    record.teamAnchors?.length >= 3 &&
    record.teamRegion?.kind === "polygon",
);
assert.ok(anchoredTeamRanking, "the real simulator exposes a polygon-ranked Team spawn");
assert.equal(anchoredTeamRanking.selectedInsideTeamRegion, true);
assert.ok(anchoredTeamRanking.topSpots?.length > 1, "the simulator retains ranked alternatives");
assert.equal(
  anchoredTeamRanking.selectedKey,
  `${anchoredTeamRanking.topSpots[0].x},${anchoredTeamRanking.topSpots[0].y}`,
  "the emitted selection trace uses the robust number-one candidate",
);
assert.ok(
  anchoredTeamRanking.topSpots.every(
    (candidate) =>
      candidate.objective?.teamPolyhedronScore === 1 &&
      Number.isFinite(candidate.objective?.teamInteriorScore),
  ),
  "fallback candidates inside a real Team polygon retain team geometry in their objective",
);

const naturalNuclearRuntime = runHeadlessScenario({
  OFH_MATCH_SEED: "legendary-nuclear-hydro-fallback-20260810",
  OFH_GAME_MAP: "Alps",
  OFH_GAME_MAP_SIZE: "Small",
  OFH_GAME_MODE: "team",
  OFH_PLAYER_TEAMS: "2",
  OFH_BOTS: "0",
  OFH_NATIONS: "10",
  OFH_NUKES: "1",
  OFH_BOT_DIFFICULTY: "Legendary",
  OFH_FORCE_HYDRO_NATION: "1",
  OFH_LOG_NUKES: "1",
  OFH_LOG_STRUCTURES: "1",
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
assert.ok(
  naturalNuclearResult.cumulativeBuildUnitTypes.City > 0,
  "the funded native nuclear scenario develops its City economy alongside silo capacity",
);
assert.ok(
  naturalNuclearRuntime.records.some(
    (record) =>
      record.kind === "nuke-selection" && record.type === "Atom Bomb" && record.gold >= record.cost,
  ),
  "with the winFixes hydro-affordability gates live (2026-10-09 pre-declaration) a hydro specialist takes the affordable Atom fallback while the H-bomb is unaffordable and no heavy attack is underway",
);
assert.equal(naturalNuclearResult.nuclearStrategy?.isHydroNation, true);
assert.equal(
  naturalNuclearResult.nuclearStrategy?.atomBombsLaunched,
  naturalNuclearResult.cumulativeBuildUnitTypes["Atom Bomb"] ?? 0,
);
assert.ok(Array.isArray(naturalNuclearProgress?.activeMissiles));
assert.ok(
  naturalNuclearProgress.units["Missile Silo"] > 0,
  "nuclear-enabled simulation must expose the real Silo state through engine progress",
);

const goalShape = naturalNuclearResult.goalRequirements;
assert.ok(goalShape && typeof goalShape === "object");
for (const field of [
  "tradeCaptured",
  "enemyTransportBoatsDestroyed",
  "ownTransportBoatsLost",
  "warshipsDestroyed",
  "maxWarshipVeterancy",
  "nukedStructureGold",
  "ownStructuresNuked",
  "seaInvasionObserved",
  "goldEarned",
  "tradeGoldEarned",
  "trainGoldEarned",
  "bestRivalGoldEarned",
  "bestEconomy",
  "firstHostileNukeTick",
  "firstReadySamTick",
  "samReadyBeforeFirstHostileNuke",
  "landLeaderAt120Seconds",
]) {
  assert.ok(field in goalShape, `goal telemetry must expose ${field}`);
}
assert.match(goalShape.tradeGoldEarned, /^\d+$/);
assert.match(goalShape.trainGoldEarned, /^\d+$/);

// Legendary FFA survival policy: sieges must not freeze expansion lanes and
// nuclear decisions must stay inside the shared intent budget. Economic builds
// still require paid routes or binding troop-cap relief (PORT-CONTRACT.md).
const legendaryFfaRuntime = runHeadlessScenario({
  OFH_MATCH_SEED: "legendary-ffa-survival-policy-20260817",
  OFH_GAME_MAP: "Alps",
  OFH_GAME_MAP_SIZE: "Small",
  OFH_GAME_MODE: "ffa",
  OFH_BOTS: "25",
  OFH_NATIONS: "8",
  OFH_NUKES: "1",
  OFH_BOT_DIFFICULTY: "Legendary",
  OFH_MAX_TICKS: "2600",
  OFH_LOG_INTENTS: "1",
  OFH_ASSERT_INTENT_BUDGET: "1",
});
const legendaryFfaResult = legendaryFfaRuntime.records.find((record) => record.phase === "result");
assert.ok(legendaryFfaResult, "the Legendary FFA scenario must emit a result");

const ffaBorderRuntime = runHeadlessScenario({
  OFH_MATCH_SEED: "legendary-audit-159-europe",
  OFH_LOG_SPAWN: "1",
  OFH_GAME_MAP: "Europe",
  OFH_GAME_MODE: "ffa",
  OFH_NATIONS: "50",
  OFH_BOTS: "180",
  OFH_NO_MODIFIERS: "1",
  OFH_MAX_TICKS: "4000",
});
const ffaBorderResult = ffaBorderRuntime.records.find((record) => record.phase === "result");
assert.ok(ffaBorderResult);
// Border telemetry must not depend on an unrelated construction purchase. This
// landlocked scenario can die before a legal, funded structure is selected.
const firstBorderAttack = ffaBorderRuntime.records.find(
  (record) => record.phase === "first-incoming-land-attack",
);
assert.ok(firstBorderAttack, "the fixed FFA scenario observes a native land attack");
const borderPressure = firstBorderAttack.strategicBorderPressure;
assert.ok(
  borderPressure?.hostilePlayers.length > 0,
  "neighboring nations appear in border pressure",
);
assert.ok(borderPressure.frontTiles > 0, "hostile nations share an actual land border");
assert.equal(
  borderPressure.hostileTroops,
  borderPressure.hostilePlayers.reduce((sum, player) => sum + player.troops, 0),
  "border pressure accounts for each unique strategic opponent",
);
const borderSpawn = ffaBorderRuntime.records.find(
  (record) => record.phase === "spawn-materialized",
);
assert.ok(borderSpawn, "the border fixture records native player identities");
const strategicNames = new Set(
  borderSpawn.players
    .filter((player) => player.type === "NATION" || player.type === "HUMAN")
    .map((player) => player.name),
);
assert.ok(
  borderPressure.hostilePlayers.every((player) => strategicNames.has(player.name)),
  "border pressure names native strategic players rather than tribes",
);
assert.equal(Math.round(borderPressure.ownTroops), firstBorderAttack.troops);
assert.equal(
  borderPressure.hostileRatio,
  borderPressure.ownTroops > 0 ? borderPressure.hostileTroops / borderPressure.ownTroops : null,
  "the pressure ratio uses the same native troop snapshot",
);
assert.ok(
  BigInt(legendaryFfaResult.goalRequirements.enemyStructureValueAtEnd) > 0n,
  "the established FFA rivals' structures cannot disappear from the goal accounting",
);
assert.equal(
  legendaryFfaResult.intentBudget?.rejected,
  0,
  "the full Legendary decision load must never trip the local intent limiter",
);
const legendaryFfaDecisions = legendaryFfaRuntime.records.filter(
  (record) => record.phase === "decision",
);
const firstSiegeDecision = legendaryFfaDecisions.find(
  (decision) => (decision.incoming ?? []).length > 0,
);
if (firstSiegeDecision) {
  const siegeProgress = legendaryFfaRuntime.records
    .filter((record) => record.phase === "progress")
    .filter(
      (record) =>
        record.tick >= firstSiegeDecision.tick - 100 &&
        record.tick <= firstSiegeDecision.tick + 200,
    )
    .sort((left, right) => left.tick - right.tick);
  const preSiege = siegeProgress.find((record) => record.tick <= firstSiegeDecision.tick);
  const postSiege = [...siegeProgress]
    .reverse()
    .find((record) => record.tick >= firstSiegeDecision.tick + 100);
  assert.ok(
    !preSiege || !postSiege || postSiege.tiles >= preSiege.tiles * 0.8,
    "a mirrorable Legendary siege must be answered without a passive territory collapse",
  );
}

assert.match(runner, /OFH_GAME_MAP/);
assert.match(runner, /OFH_STARTING_GOLD/);
assert.match(runner, /OFH_NATIONS/);
assert.match(
  runner,
  /OFH_NATIONS must be default, disabled, or an integer from 1 to 400/,
  "headless scenarios can independently control Nation pressure and Tribe density",
);
assert.match(runner, /OFH_NUKES === "1"/);
assert.match(adapter, /OFH_FORCE_HYDRO_NATION === "1"/);
// MIRV telemetry: the runner composes the adapter snapshot with the
// harness-side mirvBuildIntents count before emitting it.
assert.match(runner, /nuclearStrategy: nuclearStrategyTelemetry/);
assert.match(runner, /const nuclearStrategySnapshot = bot\.getNuclearStrategySnapshot\(\)/);
assert.match(adapter, /getNuclearStrategySnapshot\(\)/);
assert.match(
  adapter,
  /observedGlobalMirvLaunches/,
  "nuclear telemetry distinguishes MIRV launches (seen in flight) from build intents",
);
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
assert.match(runner, /logSiloQuotes/);
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
  /process\.stderr\.write\(`\$\{JSON\.stringify\(finalResult\)\}\\n`, \(\) => \{[\s\S]*hostileMissileFixtureComplete[\s\S]*intentBudgetClean[\s\S]*process\.exit\(won && hostileMissileFixtureComplete && intentBudgetClean \? 0 : 2\)/,
  "a terminal match result must flush before exiting, a hostile-missile fixture must complete its observable lifecycle, and the intent-budget assertion must gate the exit code",
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
assert.match(adapter, /OFH_LOG_SILO_QUOTES/);
assert.match(adapter, /enableSiloQuoteTrace/);
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
// Alliance telemetry (1835f8cd) inserted the allies block between outgoing
// and units in the progress snapshot; keep pinning the field order.
assert.match(runner, /incoming,\s*outgoing,\s*allies:/);
assert.match(runner, /\n[^\S\n]*units,/);
assert.match(runner, /unitDetails,/);
assert.match(runner, /externalSiloNetworks,/);
assert.match(runner, /siloCapacity/);
assert.match(runner, /siloLevels/);
assert.match(runner, /PREEMPTIVE_SAM_SILO_GOLD/);
assert.match(runner, /mirvBuildIntents/);
assert.match(runner, /incomingAttackPressure/);
assert.match(runner, /outgoingAttackTroops/);
assert.match(runner, /activeMissiles,/);
assert.match(runner, /OFH_INJECT_HOSTILE_ATOM/);
assert.match(runner, /OFH_INJECT_HOSTILE_ATOM_AT_TICK/);
assert.match(runner, /hostile-missile-injected/);
assert.match(runner, /hostile-missile-resolved/);
assert.match(runner, /new NukeExecution\(UnitType\.AtomBomb/);
assert.match(runner, /OFH_INJECT_HOSTILE_ATOM_GOLD/);
assert.match(runner, /hostile\.addGold\(hostileAtomFixtureGold\)/);
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
const seedGuardSource = comparison.match(/function assertMatchingSeeds\([\s\S]*?\n\}/)?.[0];
assert.ok(seedGuardSource, "the comparison validates seeds for every paired match");
const assertMatchingSeeds = vm.runInNewContext(`(${seedGuardSource})`);
assert.doesNotThrow(() =>
  assertMatchingSeeds({ seed: "pair-seed" }, { seed: "pair-seed" }, "scenario", 0),
);
assert.throws(
  () => assertMatchingSeeds({}, { seed: "pair-seed" }, "scenario", 0),
  /Unmatched construction seeds/,
);
assert.throws(
  () => assertMatchingSeeds({ seed: "pair-seed" }, {}, "scenario", 0),
  /Unmatched construction seeds/,
);
assert.throws(
  () => assertMatchingSeeds({ seed: "baseline-seed" }, { seed: "candidate-seed" }, "scenario", 0),
  /Unmatched construction seeds/,
);
assert.match(
  comparison,
  /const baselineGame = baselineGames\[index\];\s*assertMatchingSeeds\(baselineGame, candidateGame, candidateEntry\.scenario\.id, index\);\s*return \{/,
  "the seed guard runs before per-match deltas are computed",
);
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
// The only tolerated catch is the trace-label classifier's own guard: it
// never wraps an engine call, so a classifier failure degrades the trace
// label instead of swallowing simulation failures. Every other catch in the
// runner, batch runner, or adapter remains forbidden.
const catchTokens = (source) => [...source.matchAll(/\bcatch\b/g)];
const adapterCatches = catchTokens(adapter);
const classifierStart = adapter.indexOf("function classifyNukeTileOwner");
const classifierEnd = adapter.indexOf("\n}\n", classifierStart) + 4;
assert.ok(classifierStart !== -1 && classifierEnd > classifierStart);
assert.equal(
  adapterCatches.length,
  1,
  "adapter must not add failure-swallowing catches outside the trace classifier",
);
assert.ok(
  adapterCatches[0].index >= classifierStart && adapterCatches[0].index < classifierEnd,
  "the only adapter catch must be the inert trace classifier guard",
);
const adapterWithoutClassifier = adapter.slice(0, classifierStart) + adapter.slice(classifierEnd);
assert.equal(
  catchTokens(`${runner}\n${batch}\n${adapterWithoutClassifier}`).length,
  0,
  "headless simulation code must let failures propagate",
);
assert.equal(
  catchTokens(fs.readFileSync(path.join(root, "engine/ingame/companion/actions.js"), "utf8"))
    .length,
  0,
  "companion actions must let integration failures propagate",
);
assert.equal(
  catchTokens(fs.readFileSync(path.join(root, "engine/ingame/companion/core.js"), "utf8")).length,
  0,
  "companion core must let storage and game-surface failures propagate",
);
assert.equal(
  catchTokens(fs.readFileSync(path.join(root, "engine/ingame/companion/engine.js"), "utf8")).length,
  0,
  "companion engine must let queued, tick, and UI failures propagate",
);
assert.equal(
  catchTokens(fs.readFileSync(path.join(root, "engine/ingame/companion/panel.js"), "utf8")).length,
  0,
  "companion panel must let translation, event, and rendering failures propagate",
);
assert.equal(
  catchTokens(fs.readFileSync(path.join(root, "engine/ingame/companion/commands.js"), "utf8"))
    .length,
  0,
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

function stripHybridModelBoundaries(source, allowUpdate = false) {
  const startPattern = /\/\/ HYBRID_MODEL_(LOAD|SAVE|IMPORT|UPDATE)_BOUNDARY_START/g;
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(startPattern)) {
    if (match.index < cursor || (match[1] === "UPDATE" && !allowUpdate)) continue;
    const endMarker = `// HYBRID_MODEL_${match[1]}_BOUNDARY_END`;
    const end = source.indexOf(endMarker, match.index + match[0].length);
    if (end === -1) continue;
    if (match[1] === "UPDATE") {
      const boundary = source.slice(match.index, end);
      assert.equal(catchTokens(boundary).length, 1, "only the typed covariance handler is allowed");
      assert.match(
        boundary,
        /catch\s*\(error\)\s*\{\s*if\s*\(!\(error instanceof HybridCombatCovarianceError\)\)\s*throw error;\s*this\.numericalFailure\(error\.message\);\s*return false;\s*\}/,
        "numerical validation must rethrow unexpected errors before visible fallback",
      );
    }
    result += source.slice(cursor, match.index);
    cursor = end + endMarker.length;
  }
  return result + source.slice(cursor);
}

function stripAuditedFunctionBoundary(source, startMarker, endMarker, pattern, message) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, message);
  assert.equal(
    source.indexOf(startMarker, start + startMarker.length),
    -1,
    "audited function must be unique",
  );
  const boundary = source.slice(start, end);
  assert.equal(
    catchTokens(boundary).length,
    1,
    "audited function must contain exactly one handler",
  );
  assert.equal([...boundary.matchAll(pattern)].length, 1, message);
  return source.slice(0, start) + boundary.replace(pattern, "") + source.slice(end);
}

function stripOptionalPartnerQuoteBoundary(source) {
  return stripAuditedFunctionBoundary(
    source,
    "    async legendaryPortSeedPartnerBuildCostQuote(",
    "\n    // maybeSpawnStructure",
    /try\s*\{\s*quotes = await withTimeout\(\s*partner\.buildables\(partnerTile, \[UNIT\.Port\]\),\s*STRUCTURE_PROBE_TIMEOUT_MS,\s*null,\s*\);\s*\} catch \{\s*\/\/ Optional partner worker probes may reject; an unpriced seed is refused\.\s*return null;\s*\}/g,
    "only the optional partner worker probe may refuse an unpriced seed",
  );
}

function stripNativeEvaluationFailureBoundaries(source) {
  const boundaries = [
    [
      "function restoreNativeEvidence(",
      "export function runMatch(",
      /try\s*\{\s*Object\.assign\(evidence, validateNativeEvidence\(run, file, outDir, runID\)\);\s*\/\/ Untrusted native files remain reportable failures, never complete evidence\.\s*\/\/ eslint-disable-next-line no-restricted-syntax\s*\} catch \(error\) \{\s*run\.nativeEventError = error\.message;\s*invalidateNativeEvidence\(evidence\);\s*\}/g,
      "native evidence validation must be recorded and invalidated",
    ],
    [
      "export function runMatch(",
      "function evaluationInputs(",
      /try\s*\{\s*records = readRecords\(fs\.readFileSync\(logPath, "utf8"\)\);\s*\/\/ Preserve malformed child output as a failed run in the report\.\s*\/\/ eslint-disable-next-line no-restricted-syntax\s*\} catch \(failure\) \{\s*error = failure\.message;\s*\}/g,
      "malformed child output must remain a failed run",
    ],
  ];
  let checkedSource = source;
  for (const [start, end, pattern, message] of boundaries) {
    checkedSource = stripAuditedFunctionBoundary(checkedSource, start, end, pattern, message);
  }
  return checkedSource;
}

function stripHybridTrainingColdStartBoundary(source) {
  const pattern =
    /try\s*\{\s*validateModel\(saved\.model, source, true\);\s*\/\/ eslint-disable-next-line no-restricted-syntax -- cold is a valid training state; every other validation failure propagates\s*\}\s*catch \(error\) \{\s*if\s*\(\s*!\(error instanceof assert\.AssertionError\)\s*\|\|\s*error\.message !==\s*"Cold or unsupported snapshot: native diagnostics must report ready\/modelReady=true"\s*\)\s*throw error;\s*ready = false;\s*\}/g;
  return stripAuditedFunctionBoundary(
    source,
    "export function inspectCheckpoint(",
    "function writeResult(",
    pattern,
    "only the native cold-readiness assertion may be treated as a training state",
  );
}

function stripAttackAdmissionFailureBoundaries(source) {
  const dispatchPattern =
    /catch\s*\(error\)\s*\{\s*dispatchError = error;\s*(row|admission)\.reason = "dispatch-exception";\s*\1\.error = String\(error\);\s*throw error;\s*\}/g;
  const boundaries = [
    ["    emitBoat(", "\n    emitAuthorizedBoat(", dispatchPattern],
    ["    async sendAttack(", "\n    finishObservedAttack(", dispatchPattern],
    [
      "    finishObservedAttack(",
      "\n    finishHybridSafetyAttempt(",
      /catch\s*\(error\)\s*\{\s*throw originalError \?\? error;\s*\}/g,
    ],
    ["    async observeAttackAdmission(", "\n    recordAttackEmission(", dispatchPattern],
  ];
  const checked = boundaries.reduce(
    (checked, [start, end, pattern]) =>
      stripAuditedFunctionBoundary(
        checked,
        start,
        end,
        pattern,
        "attack diagnostics must rethrow the original failure",
      ),
    source,
  );
  return stripAuditedFunctionBoundary(
    checked,
    "    async hybridBorderQuery(",
    "\n    hybridGeometryGenerationIsCurrent(",
    /async hybridBorderQuery\(actor, tolerateProbeFailure\) \{\s*const native = actor\.__src \?\? actor;\s*if \(typeof native\.borderTiles !== "function"\) return null;\s*if \(!tolerateProbeFailure\) return native\.borderTiles\(\);\s*try \{ return await native\.borderTiles\(\); \}\s*\/\/ eslint-disable-next-line no-restricted-syntax -- An optional worker query may be unavailable; geometry\/model faults outside it still propagate\.\s*catch \{ return null; \}\s*\}/g,
    "only the explicitly optional border worker query may fail closed to native ordering",
  );
}

const attackAdmissionSource = fs.readFileSync(
  path.join(root, "engine/ingame/auto-bot/attackBehavior.js"),
  "utf8",
);
assert.throws(
  () =>
    stripAttackAdmissionFailureBoundaries(
      attackAdmissionSource.replace(
        "if (!tolerateProbeFailure) return native.borderTiles();",
        "if (!tolerateProbeFailure) return null;",
      ),
    ),
  /only the explicitly optional border worker query/,
);
for (const handler of attackAdmissionSource.matchAll(
  /catch\s*\(error\)\s*\{[^}]*throw (?:originalError \?\? )?error;\s*\}/g,
)) {
  const swallowed =
    attackAdmissionSource.slice(0, handler.index) +
    handler[0].replace(/throw (?:originalError \?\? )?error;/, "return false;") +
    attackAdmissionSource.slice(handler.index + handler[0].length);
  assert.throws(
    () => stripAttackAdmissionFailureBoundaries(swallowed),
    /attack diagnostics must rethrow the original failure/,
  );
}

const productionSources = [
  path.join(root, "build.mjs"),
  ...productionJavaScriptFiles(path.join(root, "engine")),
  ...productionJavaScriptFiles(path.join(root, "scripts")),
];
for (const sourcePath of productionSources) {
  const source = fs.readFileSync(sourcePath, "utf8");
  let checkedSource =
    sourcePath === path.join(root, "scripts/headless/opponent-adapter.js")
      ? source.slice(0, classifierStart) + source.slice(classifierEnd)
      : source;
  // Audited model, diagnostic and optional worker boundaries handle expected failures.
  // hybrid-combat.mjs verifies atomic rejection and propagation of unexpected update errors.
  if (
    ["engine/ingame/auto-bot/hybridCombat.js", "engine/ingame/auto-bot/panel.js"].includes(
      path.relative(root, sourcePath),
    )
  ) {
    checkedSource = stripHybridModelBoundaries(
      checkedSource,
      sourcePath === path.join(root, "engine/ingame/auto-bot/hybridCombat.js"),
    );
  }
  if (sourcePath === path.join(root, "scripts/headless/evaluate-hybrid-combat.mjs")) {
    checkedSource = stripNativeEvaluationFailureBoundaries(checkedSource);
  }
  if (sourcePath === path.join(root, "scripts/headless/train-hybrid-combat.mjs")) {
    checkedSource = stripHybridTrainingColdStartBoundary(checkedSource);
  }
  if (
    sourcePath.startsWith(
      path.join(root, "engine/ingame/auto-bot/structure-behavior") + path.sep,
    ) &&
    checkedSource.includes("    async legendaryPortSeedPartnerBuildCostQuote(")
  ) {
    checkedSource = stripOptionalPartnerQuoteBoundary(checkedSource);
  }
  if (sourcePath === path.join(root, "engine/ingame/auto-bot/attackBehavior.js")) {
    checkedSource = stripAttackAdmissionFailureBoundaries(checkedSource);
  }
  assert.equal(
    catchTokens(checkedSource).length,
    0,
    `${path.relative(root, sourcePath)} must let failures propagate`,
  );
}

process.stdout.write("headless simulation contract tests passed\n");
