import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = fs.readFileSync(path.join(root, "scripts/headless/run-match.mts"), "utf8");
const batch = fs.readFileSync(path.join(root, "scripts/headless/run-batch.mjs"), "utf8");
const adapter = fs.readFileSync(path.join(root, "scripts/headless/opponent-adapter.js"), "utf8");
const headlessModuleScope = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/headless/package.json"), "utf8"),
);

assert.match(runner, /playlist\.gameConfig\("team"\)/);
assert.match(runner, /difficulty:\s*Difficulty\.Impossible/);
assert.match(runner, /nations:\s*"default"/);
assert.match(runner, /createMaxDifficultyOpponent/);
assert.equal(
  headlessModuleScope.type,
  "module",
  "The runner's JavaScript adapter must load as ESM under tsx",
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
assert.match(runner, /OFH_GAME_MAP/);
assert.match(runner, /OFH_PROGRESS_TICKS/);
assert.match(runner, /OFH_PROGRESS_FROM_TICK/);
assert.match(runner, /OFH_SLOW_TICK_MS/);
assert.match(runner, /OFH_STOP_WHEN_DEAD/);
assert.match(runner, /OFH_PROFILE_BOT/);
assert.match(runner, /OFH_LOG_INTENTS/);
assert.match(runner, /OFH_LOG_NAVAL/);
assert.match(runner, /OFH_LOG_STRUCTURES/);
assert.match(runner, /phase:\s*"decision"/);
assert.match(runner, /attackTargets/);
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
assert.match(runner, /decisionMs/);
assert.match(runner, /executionMs/);
assert.match(runner, /stopReason/);
assert.match(runner, /performanceProfile/);
assert.match(runner, /intervalIntentTypes/);
assert.match(runner, /cumulativeIntentTypes/);
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
assert.match(runner, /phase:\s*"conquered"/);
assert.match(runner, /productionReserve/);
assert.match(runner, /liveReserve/);
assert.match(runner, /pendingTroops/);
assert.match(batch, /availableParallelism\(\)/);
assert.match(batch, /spawn\(/);
assert.match(batch, /OFH_SIM_WORKERS/);
assert.match(adapter, /window\.__OFH_deadlineNow = hostDeadlineNow/);
assert.match(adapter, /beginAutoBotProfileTick/);
assert.match(adapter, /drainStructureTrace/);
assert.match(adapter, /getPerformanceProfile/);
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

process.stdout.write("headless simulation contract tests passed\n");
