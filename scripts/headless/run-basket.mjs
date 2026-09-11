// Fixed-basket runner for the Legendary goal validation protocol.
//
// Pre-declared baskets (docs/legendary-metric-ceilings.md):
//   team: Labyrinth, 3 player teams, 60 tribes, 20 nations, Legendary bot,
//         Impossible engine, seeds basket-01..05, profiles none/temp/5mm/25mm
//   ffa:  Labyrinth, 60 tribes, nations n20/n2/n4 (none profile), seeds
//         basket-01..05
//
// Never pre-screen or substitute seeds — the basket is the only scoreboard.
//
// Usage: node scripts/headless/run-basket.mjs [--out DIR] [--sets a,b,c]
//   --sets selects from: team-none, team-temp, team-5mm, team-25mm,
//   ffa-n20, ffa-n2, ffa-n4. Default: all.
// Concurrency via OFH_SIM_PARALLELISM (default 2 — heavy team games OOM
// wider on this box; wall-clock probes are load-sensitive so prefer fewer).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SEEDS = ["basket-01", "basket-02", "basket-03", "basket-04", "basket-05"];
const TEAM_PROFILES = {
  "team-none": ["OFH_NO_MODIFIERS=1"],
  "team-temp": ["OFH_TEMP_PVP_IMMUNITY=1"],
  "team-5mm": ["OFH_5MM=1"],
  "team-25mm": ["OFH_25MM=1"],
};
const FFA_SETS = {
  "ffa-n20": ["OFH_NATIONS=20"],
  "ffa-n2": ["OFH_NATIONS=2"],
  "ffa-n4": ["OFH_NATIONS=4"],
};

function buildSet(name) {
  if (TEAM_PROFILES[name]) {
    return SEEDS.map((seed) => ({
      key: `${name}-${seed}`,
      env: [
        "OFH_GAME_MODE=team",
        "OFH_GAME_MAP=Labyrinth",
        "OFH_PLAYER_TEAMS=3",
        "OFH_BOTS=60",
        "OFH_NATIONS=20",
        ...TEAM_PROFILES[name],
      ],
      seed,
    }));
  }
  if (FFA_SETS[name]) {
    return SEEDS.map((seed) => ({
      key: `${name}-${seed}`,
      env: ["OFH_GAME_MODE=ffa", "OFH_GAME_MAP=Labyrinth", "OFH_BOTS=60", ...FFA_SETS[name]],
      seed,
    }));
  }
  throw new Error(`unknown set ${name}`);
}

function parseArgs(argv) {
  let outDir = path.join("/tmp", "ofh-matrix", `basket-${new Date().toISOString().slice(0, 10)}`);
  let sets = Object.keys(TEAM_PROFILES).concat(Object.keys(FFA_SETS));
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--sets") {
      sets = argv[i + 1].split(",");
      i += 1;
    }
  }
  return { outDir, sets };
}

function runSim(row, logPath) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GAME_ENV: "dev",
      OFH_NUKES: "1",
      OFH_BOT_DIFFICULTY: "Legendary",
      OFH_MATCH_SEED: row.seed,
      OFH_ASSERT_INTENT_BUDGET: "1",
    };
    for (const kv of row.env) {
      const eq = kv.indexOf("=");
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const child = spawn(
      "./node_modules/.bin/tsx",
      ["--tsconfig", "openfront-engine/tsconfig.json", "scripts/headless/run-match.mts"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const log = fs.createWriteStream(logPath);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const timer = setTimeout(() => {
      log.write("\n[run-basket] timeout after 120 min, killing\n");
      child.kill("SIGKILL");
    }, 120 * 60 * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ row, code });
    });
  });
}

async function main() {
  const { outDir, sets } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outDir, { recursive: true });
  const parallelism = Number(process.env.OFH_SIM_PARALLELISM ?? 2);
  const queue = sets.flatMap((set) => buildSet(set));
  console.log(`[run-basket] ${queue.length} rows -> ${outDir} (parallelism ${parallelism})`);
  const resultsPath = path.join(outDir, "results.jsonl");
  const done = new Set();
  if (fs.existsSync(resultsPath)) {
    for (const line of fs.readFileSync(resultsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        done.add(JSON.parse(line).key);
      } catch {
        // ignore truncated resume lines
      }
    }
  }
  let index = 0;
  async function worker() {
    while (index < queue.length) {
      const row = queue[index];
      index += 1;
      if (done.has(row.key)) {
        console.log(`[run-basket] skip ${row.key} (already scored)`);
        continue;
      }
      const logPath = path.join(outDir, `${row.key}.out`);
      process.stdout.write(`[run-basket] start ${row.key}\n`);
      const started = Date.now();
      const { code } = await runSim(row, logPath);
      const text = fs.readFileSync(logPath, "utf8");
      const resultLine = text
        .split("\n")
        .reverse()
        .find((line) => line.includes('{"phase":"result"'));
      if (resultLine) {
        const start = resultLine.indexOf('{"phase":"result"');
        const result = JSON.parse(resultLine.slice(start));
        fs.appendFileSync(resultsPath, `${JSON.stringify({ key: row.key, result })}\n`);
        console.log(
          `[run-basket] done ${row.key} exit=${code} won=${result.won} ticks=${result.ticks} (${Math.round((Date.now() - started) / 60000)} min)`,
        );
      } else {
        console.log(`[run-basket] done ${row.key} exit=${code} NO RESULT RECORD (${Math.round((Date.now() - started) / 60000)} min)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallelism, queue.length) }, worker));
  console.log(`[run-basket] complete; results at ${resultsPath}`);
}

await main();
