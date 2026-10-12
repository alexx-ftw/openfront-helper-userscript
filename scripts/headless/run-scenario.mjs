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
  {
    name: "hostile-silo-readiness",
    description:
      "injected hostile first-strike silo left cooling — records which tiles the bot nukes back",
    env: {
      OFH_MATCH_SEED: "scenario-silo-readiness",
      OFH_MAX_TICKS: "25000",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_INJECT_HOSTILE_ATOM_GOLD: "2000000",
      OFH_LOG_NUKES: "1",
      OFH_25MM: "1",
    },
    assert: (r, log) =>
      log.includes("hostile-missile-injected") && /\[ofh:nuke-detonate\]/.test(log),
    expect: "hostile silo injected and at least one nuke detonation recorded",
  },
  {
    name: "silo-counter-battery-regime",
    description:
      "artificial silo-saturated regime: hostile silo network (3 L1) clustered at its city plus a retaliatory first-strike — pins that the bot nukes into the silo-dense victim (regime bed for the counter-battery floor probe)",
    env: {
      OFH_MATCH_SEED: "scenario-silo-counter-battery",
      OFH_MAX_TICKS: "20000",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_INJECT_HOSTILE_ATOM_GOLD: "2000000",
      OFH_INJECT_HOSTILE_SILO_NETWORK: "1",
      OFH_INJECT_HOSTILE_SILO_COUNT: "3",
      OFH_LOG_NUKES: "1",
      OFH_25MM: "1",
    },
    assert: (r, log) =>
      log.includes("hostile-silo-network-injected") &&
      r.stopReason !== "engine_stop" &&
      r.stopReason !== "spawn_failed" &&
      Number(r.goalRequirements?.nukedStructureGold ?? 0) >= 500_000,
    expect:
      "hostile silo network injected and the bot lands nuclear structure damage on the silo-saturated hostile",
  },
  {
    name: "baikal-silo-regime",
    description:
      "destabilization probe on the winning baikal seed: the hostile silo network fixture (3 L1 + 10M gold) FLIPS the landed winning game into a bot loss (ally Ballistic Cyclops Missile wins instead) — pins how balance-of-power fragile the nuclear win is",
    env: {
      OFH_MATCH_SEED: "scenario-baikal-nuke-wars",
      OFH_GAME_MAP: "Baikal Nuke Wars",
      OFH_GAME_MAP_SIZE: "Small",
      OFH_MAX_TICKS: "25000",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_LOG_NUKES: "1",
      OFH_INJECT_HOSTILE_SILO_NETWORK: "1",
      OFH_INJECT_HOSTILE_SILO_COUNT: "3",
    },
    assert: (r, log) =>
      log.includes("hostile-silo-network-injected") &&
      r.stopReason !== "engine_stop" &&
      r.stopReason !== "spawn_failed",
    expect:
      "silo network injected and the match completes through the engine (won=false expected and recorded as the fragility finding)",
  },
  {
    name: "sam-salvo-overwhelm",
    description:
      "SAM-covered hostile cluster vs pre-leveled own silo network — exercises the anti-SAM salvo response",
    env: {
      OFH_MATCH_SEED: "scenario-sam-salvo",
      OFH_MAX_TICKS: "25000",
      OFH_25MM: "1",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_INJECT_HOSTILE_ATOM_GOLD: "2000000",
      OFH_INJECT_HOSTILE_SAM_COVER: "1",
      OFH_INJECT_OWN_SILO_NETWORK: "1",
      OFH_INJECT_OWN_SILO_LEVEL: "3",
      OFH_LOG_NUKES: "1",
      OFH_LOG_STRUCTURES: "1",
    },
    assert: (r) => Number(r.nuclearStrategy?.atomBombsLaunched ?? 0) >= 3,
    expect: "bot launches a salvo-scale response (>= 3 atoms)",
  },
  {
    name: "sam-salvo-overwhelm-b",
    description:
      "Robustness twin of sam-salvo-overwhelm on a fresh seed — the slot-pressure new-silo branch must break the SAM-cover deadlock off seed A too",
    env: {
      OFH_MATCH_SEED: "scenario-sam-salvo-b",
      OFH_MAX_TICKS: "25000",
      OFH_25MM: "1",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_INJECT_HOSTILE_ATOM_GOLD: "2000000",
      OFH_INJECT_HOSTILE_SAM_COVER: "1",
      OFH_INJECT_OWN_SILO_NETWORK: "1",
      OFH_INJECT_OWN_SILO_LEVEL: "3",
      OFH_LOG_NUKES: "1",
      OFH_LOG_STRUCTURES: "1",
    },
    assert: (r, logText) =>
      Number(r.nuclearStrategy?.atomBombsLaunched ?? 0) >= 3 &&
      logText
        .split("\n")
        .filter((line) => line.includes('"kind":"nuke-aim"'))
        .map((line) => JSON.parse(line))
        .some(
          (aim) =>
            aim.sourceName === "OFH Auto Bot" &&
            aim.targetName === "Isle of Margins" &&
            aim.tick < 2183 &&
            aim.fired === true,
        ),
    expect:
      ">= 3 atoms and a successful pre-invasion counterforce aim at Isle of Margins; won observed honestly",
  },
  {
    name: "baikal-nuke-wars",
    description:
      "Baikal Nuke Wars map (user-nominated best nuke-logic testbed) — silo network + hostile SAM cover exercise nuke targeting on the dedicated nuclear map",
    env: {
      OFH_MATCH_SEED: "scenario-baikal-nuke-wars",
      OFH_GAME_MAP: "Baikal Nuke Wars",
      OFH_GAME_MAP_SIZE: "Small",
      OFH_MAX_TICKS: "25000",
      OFH_25MM: "1",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_INJECT_HOSTILE_ATOM_GOLD: "2000000",
      OFH_INJECT_HOSTILE_SAM_COVER: "1",
      OFH_INJECT_OWN_SILO_NETWORK: "1",
      OFH_INJECT_OWN_SILO_LEVEL: "3",
    },
    assert: (r) =>
      r.stopReason !== "engine_stop" &&
      r.stopReason !== "spawn_failed" &&
      r.won === true &&
      r.alive === true &&
      Number(r.nuclearStrategy?.atomBombsLaunched ?? 0) >= 3 &&
      Number(r.nuclearStrategy?.hydrogenBombsLaunched ?? 0) >= 1 &&
      Number(r.ownAtomDetonations ?? 0) + Number(r.ownHydrogenDetonations ?? 0) >= 1,
    expect:
      "nuclear layer fully live on this map: bot wins, salvo-scale atoms (>=3), hydrogen fires (>=1), and an Atom/Hydrogen detonates",
  },
  {
    name: "baikal-nuke-organic",
    description:
      "Baikal Nuke Wars WITHOUT injected silos or gold boosts — pins the organic silo build on the nuclear map (measured open gap: at parity gold the bot built its silo but died t=4291 before any launch, 12 own structures nuked — docs/legendary-metric-ceilings.md)",
    env: {
      OFH_MATCH_SEED: "scenario-baikal-organic",
      OFH_GAME_MAP: "Baikal Nuke Wars",
      OFH_GAME_MAP_SIZE: "Small",
      OFH_MAX_TICKS: "25000",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
    },
    assert: (r) =>
      r.stopReason !== "engine_stop" &&
      r.stopReason !== "spawn_failed" &&
      r.won === true &&
      r.alive === true &&
      r.constructionEvents?.some(
        (event) =>
          event.unit === "Missile Silo" &&
          event.action === "build" &&
          Number(event.portfolio?.units?.["Missile Silo"]?.count ?? -1) === 0,
      ) &&
      Number(r.nuclearStrategy?.atomBombsLaunched ?? 0) +
        Number(r.nuclearStrategy?.hydrogenBombsLaunched ?? 0) >=
        1 &&
      Number(r.ownAtomDetonations ?? 0) + Number(r.ownHydrogenDetonations ?? 0) >= 1,
    expect:
      "the bot wins, builds its first organic silo, and launches and detonates one of its own Atom/Hydrogen bombs",
  },
  {
    name: "luna-nuke-wars",
    description:
      "Luna map (user-nominated second testbed) — silo network + hostile SAM cover exercise nuke targeting, matching the Baikal mechanism test (measured open gap 2026-10-12: nuclear layer fires 40 atoms + 4 hydrogen but the game ends max_ticks with bot 721k tiles vs Luna 21 793k — conquest-finishing is a recorded strategic gap, not a nuclear-lane failure)",
    env: {
      OFH_MATCH_SEED: "scenario-luna-nuke-wars",
      OFH_GAME_MAP: "Luna",
      OFH_GAME_MAP_SIZE: "Small",
      OFH_MAX_TICKS: "25000",
      OFH_25MM: "1",
      OFH_INJECT_HOSTILE_ATOM: "1",
      OFH_INJECT_HOSTILE_ATOM_AT_TICK: "1200",
      OFH_INJECT_HOSTILE_ATOM_GOLD: "2000000",
      OFH_INJECT_HOSTILE_SAM_COVER: "1",
      OFH_INJECT_OWN_SILO_NETWORK: "1",
      OFH_INJECT_OWN_SILO_LEVEL: "3",
    },
    assert: (r) =>
      r.stopReason !== "engine_stop" &&
      r.stopReason !== "spawn_failed" &&
      r.alive === true &&
      Number(r.nuclearStrategy?.atomBombsLaunched ?? 0) >= 3 &&
      Number(r.nuclearStrategy?.hydrogenBombsLaunched ?? 0) >= 1 &&
      Number(r.ownAtomDetonations ?? 0) + Number(r.ownHydrogenDetonations ?? 0) >= 1,
    expect:
      "nuclear layer fully live on Luna: bot survives, >=3 atoms, >=1 hydrogen, and an Atom/Hydrogen detonates; the final conquest is recorded honestly via won",
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
    const gameMode = String(cfg.gameMode).toLowerCase().includes("team") ? "team" : "ffa";
    return {
      name: `history-${rec.gameId}`,
      description: `record ${rec.gameId}: ${cfg.gameMap} ${cfg.gameMode} (${rec.players}p, ${rec.turns} turns, bots ${cfg.bots}, teams ${cfg.playerTeams})`,
      env: {
        OFH_MATCH_SEED: `history-${rec.gameId}`,
        OFH_GAME_MAP: cfg.gameMap,
        OFH_GAME_MAP_SIZE: cfg.gameMapSize,
        OFH_GAME_MODE: gameMode,
        ...(gameMode === "team" ? { OFH_PLAYER_TEAMS: String(cfg.playerTeams ?? 2) } : {}),
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
    const timeoutMs =
      Number.parseInt(process.env.OFH_RUNNER_TIMEOUT_MS ?? "", 10) || 15 * 60 * 1000;
    const timer = setTimeout(() => {
      log.write(`\n[run-scenario] timeout after ${Math.round(timeoutMs / 60000)} min, killing\n`);
      child.kill("SIGKILL");
    }, timeoutMs);
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
process.stdout.write(`[run-scenario] ${selected.length} scenario(s) -> ${outDir}\n`);

let failures = 0;
for (const scenario of selected) {
  const logPath = path.join(outDir, `${scenario.name}.log`);
  process.stdout.write(`[run-scenario] start ${scenario.name} ... `);
  await runSim(scenario, logPath);
  const { result, text: logText } = parseResult(logPath);
  if (result === null) {
    failures += 1;
    process.stdout.write("FAIL (no result line)\n");
    continue;
  }
  const ok = scenario.assert(result.result ?? result, logText);
  if (!ok) failures += 1;
  process.stdout.write(ok ? "PASS\n" : `FAIL (expected: ${scenario.expect})\n`);
}

process.stdout.write(`[run-scenario] ${selected.length - failures}/${selected.length} passed\n`);
process.exit(failures > 0 ? 1 : 0);
