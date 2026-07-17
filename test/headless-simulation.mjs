import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = fs.readFileSync(path.join(root, "scripts/headless/run-match.mts"), "utf8");
const batch = fs.readFileSync(path.join(root, "scripts/headless/run-batch.mjs"), "utf8");
const adapter = fs.readFileSync(path.join(root, "scripts/headless/opponent-adapter.js"), "utf8");

assert.match(runner, /playlist\.gameConfig\("team"\)/);
assert.match(runner, /difficulty:\s*Difficulty\.Easy/);
assert.match(runner, /nations:\s*"default"/);
assert.match(runner, /createMaxDifficultyOpponent/);
assert.match(runner, /OFH_GAME_MAP/);
assert.match(runner, /OFH_PROGRESS_TICKS/);
assert.match(runner, /OFH_PROGRESS_FROM_TICK/);
assert.match(runner, /OFH_SLOW_TICK_MS/);
assert.match(runner, /OFH_STOP_WHEN_DEAD/);
assert.match(runner, /OFH_PROFILE_BOT/);
assert.match(runner, /OFH_LOG_INTENTS/);
assert.match(runner, /OFH_LOG_NAVAL/);
assert.match(runner, /phase:\s*"decision"/);
assert.match(runner, /attackTargets/);
assert.match(runner, /targetTroops/);
assert.match(runner, /pendingTroops/);
assert.match(runner, /committedTroops/);
assert.match(runner, /robustCaptureFloor/);
assert.match(runner, /Math\.ceil\(\(snapshot\?\.troops.*\* 1\.1\)/);
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
assert.match(runner, /incoming,\s*units,/);
assert.match(runner, /unitDetails,/);
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
