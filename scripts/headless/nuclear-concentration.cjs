#!/usr/bin/env node
// nuclear-concentration.cjs — read-only aggregate over public OF history records:
// per-launcher nuclear concentration (top-3 target-tile share) split by match
// winners vs losers. Evidence for the targeting doctrine: sustained production
// with adaptive re-targeting beats concentrating a small arsenal.
// Usage: node scripts/headless/nuclear-concentration.cjs <dir-or-file.json...>
const fs = require("fs");
const path = require("path");
const NUC = new Set(["Atom Bomb", "Hydrogen Bomb", "MIRV"]);
const files = [];
for (const arg of process.argv.slice(2)) {
  const st = fs.statSync(arg);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(arg)) {
      if (f.endsWith(".json")) files.push(path.join(arg, f));
    }
  } else files.push(arg);
}
const W = [];
const L = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
  const w = j.info && j.info.winner;
  if (!Array.isArray(w) || w.length < 3) continue;
  const winners = new Set(w.slice(2));
  const per = new Map();
  for (const t of j.turns || []) {
    for (const i of t.intents || []) {
      if (i.type !== "build_unit" || !NUC.has(i.unit)) continue;
      const cnt = i.unit === "MIRV" ? 1 : i.amount || 1;
      const e = per.get(i.clientID) || [0, new Map()];
      e[0] += cnt;
      e[1].set(i.tile, (e[1].get(i.tile) || 0) + cnt);
      per.set(i.clientID, e);
    }
  }
  for (const [cid, entry] of per) {
    const n = entry[0];
    if (n < 10) continue;
    const tiles = [...entry[1].values()].sort((a, b) => b - a);
    const top3 = tiles.slice(0, 3).reduce((s, c) => s + c, 0);
    (winners.has(cid) ? W : L).push([n, tiles.length, top3 / n]);
  }
}
const agg = (rs) => rs.length === 0 ? "none"
  : "launchers=" + rs.length +
    " nukes_avg=" + (rs.reduce((s, x) => s + x[0], 0) / rs.length).toFixed(1) +
    " tiles_avg=" + (rs.reduce((s, x) => s + x[1], 0) / rs.length).toFixed(1) +
    " top3share_avg=" + (rs.reduce((s, x) => s + x[2], 0) / rs.length).toFixed(3);
console.log("WINNERS:", agg(W));
console.log("LOSERS :", agg(L));
