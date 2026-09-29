// Amendment-4 calibrated scorer for the fixed Legendary validation basket.
//
// Row standard (user-authorized amendments, recorded in
// docs/legendary-metric-ceilings.md and session memory):
//   A1  conquest escape: nuked >= 5MM OR (won AND remaining enemy structure
//       value at end < 5MM)
//   A2  leader180 evaluated among NON-NATION players; trades + veterancy
//       counted per match-set (5 rows per mode x profile)
//   A3  per-set naval metrics extended to FFA; own-transport losses <= 2 per
//       game; leader180 = top-3 among non-nations
//   A4  SAM = ready before the first OWN structure was lost (vacuous when no
//       own structure was ever nuked); enemy transport kills >= 3 per game
//       (>= 5 per set)
//
// Usage: node scripts/headless/score-basket.mjs <results.jsonl> [...more.jsonl]
// Each line must be a phase:"result" record from run-match.mts.

import fs from "node:fs";

const MIN_NUKED_GOLD = 5_000_000n;

export function rowChecks(result) {
  const goal = result?.goalRequirements ?? {};
  const nuked = BigInt(goal.nukedStructureGold ?? 0);
  const enemyValueAtEnd = BigInt(goal.enemyStructureValueAtEnd ?? 0);
  const ownNuked = Number(goal.ownStructuresNuked ?? 0);
  const samReadyA4 =
    ownNuked === 0 ||
    (goal.firstReadySamTick !== null &&
      goal.firstOwnStructureLostTick !== null &&
      Number(goal.firstReadySamTick) < Number(goal.firstOwnStructureLostTick));
  const leader = goal.landLeaderNonNationAt180Seconds;
  const checks = {
    won: result?.won === true,
    intentBudget: result?.intentBudgetViolated !== true,
    ownStructuresNuked: ownNuked === 0,
    ownTransportBoatsLost: Number(goal.ownTransportBoatsLost ?? 0) <= 2,
    enemyTransportKills: Number(goal.enemyTransportBoatsDestroyed ?? 0) >= 3,
    nukeQuota:
      nuked >= MIN_NUKED_GOLD || (result?.won === true && enemyValueAtEnd < MIN_NUKED_GOLD),
    samReadyA4,
    leader180Top3NonNation:
      leader != null && Number.isFinite(Number(leader.ownRank)) && Number(leader.ownRank) <= 3,
    bestEconomy: goal.bestEconomy === true,
    invasionsRecaptured: goal.seaInvasionObserved !== true || goal.allInvasionsRecaptured === true,
  };
  const failed = [];
  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) failed.push(name);
  }
  return {
    fullGreen: failed.length === 0,
    failed,
    checks,
    metrics: {
      won: result?.won === true,
      trades: Number(goal.tradeCaptured ?? 0),
      et: Number(goal.enemyTransportBoatsDestroyed ?? 0),
      vet: Number(goal.maxWarshipVeterancy ?? 0),
      boats: Number(goal.ownTransportBoatsLost ?? 0),
      ownNuked,
      nukedGold: nuked.toString(),
      rejected: Number(result?.intentBudget?.rejected ?? 0),
      ticks: result?.ticks,
      stopReason: result?.stopReason,
      leaderRank: leader?.ownRank ?? null,
    },
  };
}

export function scoreRows(rows) {
  const scored = rows.map((row) => {
    const { fullGreen, failed, metrics } = rowChecks(row.result);
    return {
      key: row.key,
      seed: row.result?.seed,
      fullGreen,
      failed,
      metrics,
    };
  });
  const setBars = {
    tradesSum: scored.reduce((total, row) => total + row.metrics.trades, 0) >= 33,
    vetMax: scored.reduce((max, row) => Math.max(max, row.metrics.vet), 0) >= 3,
    etSum: scored.reduce((total, row) => total + row.metrics.et, 0) >= 5,
  };
  return {
    rows: scored,
    wins: scored.filter((row) => row.metrics.won).length,
    fullGreens: scored.filter((row) => row.fullGreen).length,
    setBars,
    setQualified:
      scored.length === 5 &&
      scored.every((row) => row.fullGreen) &&
      Object.values(setBars).every(Boolean),
  };
}

export function scoreResultSet(entries) {
  // entries: [{ key: "<mode>-<profile>-<seed>", result }]
  const groups = new Map();
  for (const entry of entries) {
    const setKey = entry.key.split("-").slice(0, 2).join("-");
    if (!groups.has(setKey)) groups.set(setKey, []);
    groups.get(setKey).push({ key: entry.key, result: entry.result });
  }
  const scoreboard = {};
  for (const [setKey, rows] of groups) {
    scoreboard[setKey] = scoreRows(rows);
  }
  return scoreboard;
}

function extractResultRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    const start = line.indexOf('{"phase":"result"');
    if (start === -1) continue;
    records.push(JSON.parse(line.slice(start)));
  }
  return records;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: score-basket.mjs <results.jsonl|sim .out> [...]");
    process.exitCode = 2;
  } else {
    const entries = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n").filter((line) => line.trim());
      let usedKeyed = false;
      for (const line of lines) {
        if (!line.includes('{"phase":"result"')) continue;
        const parsed = JSON.parse(
          line.includes('{"key"') ? line : line.slice(line.indexOf('{"phase":"result"')),
        );
        if (parsed.key && parsed.result) {
          entries.push({ key: parsed.key, result: parsed.result });
          usedKeyed = true;
        } else if (parsed.phase === "result") {
          entries.push({ key: `${file}:${entries.length}`, result: parsed });
        }
      }
      if (!usedKeyed && entries.length === 0) {
        for (const result of extractResultRecords(text)) {
          entries.push({ key: `${file}:${entries.length}`, result });
        }
      }
    }
    console.log(JSON.stringify(scoreResultSet(entries), null, 2));
  }
}
