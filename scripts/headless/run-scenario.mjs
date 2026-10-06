#!/usr/bin/env node
// Artificial-scenario runner: fast 1v1 matches with engine-level injection
// fixtures and mechanism assertions. Complements the 35-row Labyrinth basket
// (that gate stays the scoreboard; scenarios give fast, targeted evidence).
//
// Usage: node scripts/headless/run-scenario.mjs [--out DIR] [--only name,name]
//        [--from-history [DIR]]  (default DIR: /home/eros/ofh-matrix/history)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_ENV = {
  GAME_ENV: "dev",
  OFH_NUKES: "1",
  OFH_BOT_DIFFICULTY: "Legendary",
  OFH_NATIONS: "2",
  OFH_GAME_MODE: "ffa",
  OFH_ASSERT_INTENT_BUDGET: "1",
};

const SCENARIOS = [
  {
    name: "control-ffa",
    description: "plain 1v1 — harness sanity, match completes",
    env: { OFH_MATCH_SEED: "scenario-control", OFH_MAX_TICKS: "15000" },
    assert: (r) => r.stopReason !== "engine_stop" && r.stopReason !== "spawn_failed",
    expect: "match completes without engine/spawn failure",
  },
  {
    name: "hostile-atom-defense",
    description: "deterministic incoming warhead at t=1200 — defense exposure",
    env: {
      OFH_MATCH_SEED: "scenario-hostile-atom",
      OFH_MAX_TICKS: "15000",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_LOG_NUKES: "1",
    },
    assert: (r) => (r.goalRequirements?.ownStructuresNuked ?? 0) >= 1,
    expect: "warhead lands: ownStructuresNuked >= 1",
  },
  {
    name: "hostile-transport-invasion",
    description: "hostile transport landing at t=1000 — naval-invasion path",
    env: {
      OFH_MATCH_SEED: "scenario-hostile-transport",
      OFH_MAX_TICKS: "15000",
      OFH_INJECT_HOSTILE_TRANSPORT: "1",
      OFH_INJECT_HOSTILE_TRANSPORT_AT_TICK: "1000",
    },
    assert: (r) => r.stopReason !== "engine_stop" && r.stopReason !== "spawn_failed",
    expect: "invasion exercised, match completes",
  },
  {
    name: "rail-economy",
    description: "injected Factory-City-City rail line — train income observed",
    env: {
      OFH_MATCH_SEED: "scenario-rail",
      OFH_MAX_TICKS: "15000",
      OFH_INJECT_RAIL_ECONOMY: "1",
    },
    assert: (r) => Number(r.goalRequirements?.trainGoldEarned ?? 0n) > 0,
    expect: "trainGoldEarned > 0 from the injected rail line",
  },
  {
    name: "max-ticks-cap",
    description: "hard tick cap — runner honors OFH_MAX_TICKS",
    env: { OFH_MATCH_SEED: "scenario-cap", OFH_MAX_TICKS: "2500" },
    assert: (r, log) => r.stopReason === "max_ticks" && r.ticks <= 2500 && log.length > 0,
    expect: "stopReason=max_ticks with ticks <= 2500",
  },
];

function parseArgs(argv) {
  let outDir = path.join(
    os.tmpdir(),
    "ofh-matrix",
    `scenarios-${new Date().toISOString().slice(0, 10)}`,
  );
  let only = null;
  let fromHistory = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--only") only = argv[++i].split(",");
    else if (argv[i] === "--from-history")
      fromHistory =
        argv[i + 1] && !argv[i + 1].startsWith("--")
          ? path.resolve(argv[++i])
          : "/home/eros/ofh-matrix/history";
  }
  return { outDir, only, fromHistory };
}

// One scenario per public GameRecord: reuse its real config (map, size, mode,
// teams, nations, bots) so the Legendary bot is exercised on realistic setups.
// Assertion stays mechanism-level (no crash/spawn failure) — these maps/rosters
// are load-sensitive, so exact wins/ticks prove nothing.
function loadHistoryScenarios(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  return index.records.map((rec) => {
    const cfg = JSON.parse(fs.readFileSync(rec.file, "utf8")).info.config;
    return {
      name: `history-${rec.gameId}`,
      description: `record ${rec.gameId}: ${cfg.gameMap} ${cfg.gameMode} (${rec.players}p, ${rec.turns} turns, bots ${cfg.bots}, teams ${cfg.playerTeams})`,
      env: {
        OFH_MATCH_SEED: `history-${rec.gameId}`,
        OFH_GAME_MAP: cfg.gameMap,
        OFH_GAME_MAP_SIZE: cfg.gameMapSize,
        OFH_GAME_MODE: cfg.gameMode.toLowerCase(),
        ...(cfg.gameMode === "Team" ? { OFH_PLAYER_TEAMS: String(cfg.playerTeams ?? 2) } : {}),
        OFH_NATIONS: cfg.nations === "disabled" ? "disabled" : "default",
        OFH_BOTS: String(cfg.bots ?? 400),
        OFH_MAX_TICKS: "6000",
      },
      assert: (r) => r.stopReason !== "engine_stop" && r.stopReason !== "spawn_failed",
      expect: "match completes without engine/spawn failure",
    };
  });
}

function runSim(scenario, logPath) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...BASE_ENV, ...scenario.env };
    const child = spawn(
      "./node_modules/.bin/tsx",
      ["--tsconfig", "openfront-engine/tsconfig.json", "scripts/headless/run-match.mts"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const log = fs.createWriteStream(logPath);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const timer = setTimeout(
      () => {
        log.write("\n[run-scenario] timeout after 15 min, killing\n");
        child.kill("SIGKILL");
      },
      15 * 60 * 1000,
    );
    child.on("exit", (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ code });
    });
  });
}

function parseResult(logPath) {
  const text = fs.readFileSync(logPath, "utf8");
  let result = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"phase":"result"')) continue;
    const start = line.indexOf("{");
    result = JSON.parse(line.slice(start));
  }
  return { result, text };
}

const { outDir, only, fromHistory } = parseArgs(process.argv.slice(2));
fs.mkdirSync(outDir, { recursive: true });
const pool = fromHistory ? loadHistoryScenarios(fromHistory) : SCENARIOS;
const selected = pool.filter((s) => !only || only.includes(s.name));
if (only && selected.length === 0) {
  console.error(`[run-scenario] no scenario matched --only: ${only.join(",")}`);
  process.exit(2);
}
console.log(`[run-scenario] ${selected.length} scenario(s) -> ${outDir}`);

let failures = 0;
for (const scenario of selected) {
  const logPath = path.join(outDir, `${scenario.name}.log`);
  process.stdout.write(`[run-scenario] start ${scenario.name} ... `);
  await runSim(scenario, logPath);
  const { result, text: logText } = parseResult(logPath);
  if (result === null) {
    failures += 1;
    console.log("FAIL (no result line)");
    continue;
  }
  const ok = scenario.assert(result.result ?? result, logText);
  if (!ok) failures += 1;
  console.log(ok ? "PASS" : `FAIL (expected: ${scenario.expect})`);
}

console.log(`[run-scenario] ${selected.length - failures}/${selected.length} passed`);
process.exit(failures > 0 ? 1 : 0);
