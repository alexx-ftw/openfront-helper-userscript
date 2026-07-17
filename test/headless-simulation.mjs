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
assert.match(batch, /availableParallelism\(\)/);
assert.match(batch, /spawn\(/);
assert.match(batch, /OFH_SIM_WORKERS/);
assert.match(adapter, /window\.__OFH_deadlineNow = hostDeadlineNow/);
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
