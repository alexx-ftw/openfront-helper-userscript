#!/usr/bin/env node
// Public OpenFront match-history fetcher (phase 2 of the scenario pipeline).
// Walks the public ranked leaderboard, lists each player's public games, and
// downloads full GameRecords (info.config + recorded turns) for offline
// scenario construction. All endpoints are public, no auth.
//
// Usage:
//   node scripts/headless/fetch-history.mjs [--out DIR] [--limit N]
//     [--min-duration-sec S] [--mode Team|FFA] [--players N]

import fs from "node:fs";
import path from "node:path";

const API = "https://api.openfront.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACING_MS = 3_000;
// The API/CDN rate-limits bursts with 403 (measured: ~6 rapid requests from
// one IP triggered a multi-minute block). Pace every call and back off hard.
const j = async (u) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(30_000 * 2 ** (attempt - 1));
    const res = await fetch(u, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (res.ok) {
      await sleep(PACING_MS);
      return res.json();
    }
    if (res.status !== 403 && res.status !== 429) {
      throw new Error(`${res.status} ${res.statusText} for ${u}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0 && attempt === 0) {
      await sleep(Math.min(retryAfter * 1000, 120_000));
    }
  }
  throw new Error(`rate-limited (403/429) after retries for ${u}`);
};

function parseArgs(argv) {
  const opts = {
    out: "/home/eros/ofh-matrix/history",
    limit: 3,
    minDurationSec: 300,
    mode: null,
    players: 8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") opts.out = path.resolve(argv[++i]);
    else if (argv[i] === "--limit") opts.limit = Number(argv[++i]);
    else if (argv[i] === "--min-duration-sec") opts.minDurationSec = Number(argv[++i]);
    else if (argv[i] === "--mode") opts.mode = argv[++i];
    else if (argv[i] === "--players") opts.players = Number(argv[++i]);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
fs.mkdirSync(opts.out, { recursive: true });

const lb = await j(`${API}/leaderboard/ranked?page=1`);
const players = [...(lb["1v1"] ?? []), ...(lb["2v2"] ?? [])].slice(0, opts.players);
console.log(`[history] ${players.length} leaderboard players scanned`);

let downloaded = 0;
const seen = new Set();
const summary = [];
for (const p of players) {
  if (downloaded >= opts.limit) break;
  const games = await j(`${API}/public/player/${p.public_id}/games`);
  for (const g of games.results ?? []) {
    if (downloaded >= opts.limit) break;
    const dur = g.durationSeconds ?? 0;
    if (dur < opts.minDurationSec) continue;
    if (opts.mode && g.mode !== opts.mode) continue;
    const gid = g.gameId;
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    const file = path.join(opts.out, `${gid}.json`);
    if (fs.existsSync(file)) {
      console.log(`[history] skip ${gid} (already on disk)`);
      continue;
    }
    const record = await j(`${API}/game/${gid}`);
    if (!Array.isArray(record.turns) || record.turns.length === 0) continue;
    fs.writeFileSync(file, JSON.stringify(record));
    downloaded += 1;
    summary.push({
      gameId: gid,
      map: record.info?.config?.gameMap,
      mode: record.info?.config?.gameMode,
      turns: record.turns.length,
      durationSec: dur,
      gitCommit: (record.gitCommit ?? "").slice(0, 8),
      players: record.info?.players?.length ?? record.info?.config?.nations ?? "?",
      file,
    });
    console.log(`[history] saved ${gid} (${summary.at(-1).map}, ${summary.at(-1).mode}, ${record.turns.length} turns)`);
  }
}

fs.writeFileSync(
  path.join(opts.out, "index.json"),
  JSON.stringify({ fetchedAt: new Date().toISOString(), records: summary }, null, 2),
);
console.log(`[history] ${downloaded} record(s) -> ${opts.out}`);
if (downloaded === 0) process.exit(1);
