#!/usr/bin/env node
// scan-history.cjs — read-only nuclear-activity triage for public OF history records.
// Usage: node scripts/headless/scan-history.cjs <record.json> [more.json...]
// Per record prints: config, nuke build counts (Atom/Hydrogen/MIRV), first silo/nuke turns,
// silo->nuke gap (the silo-maturation law stat), nuker breakdown, top attack targets.
// Nuclear build intents carry requested destination tiles; acceptance/impact requires replay.
const fs = require('fs');
const nuc = ['Atom Bomb', 'Hydrogen Bomb', 'MIRV'];
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const cfg = j.info.config || {};
  const N = j.info.num_turns || j.turns[j.turns.length - 1].turnNumber + 1;
  const q = N / 4;
  let a = 0, h = 0, m = 0, firstNuke = null, firstSilo = null, q1 = 0, maxT = 0;
  const byPlayer = {}; const builds = {}; const targets = {}; const nuclearTargets = {};
  for (const t of j.turns) {
    maxT = Math.max(maxT, t.turnNumber);
    for (const i of (t.intents || [])) {
      if (i.type === 'build_unit') {
        builds[i.unit] = (builds[i.unit] || 0) + 1;
        if (nuc.includes(i.unit)) {
          const count = i.unit === 'MIRV' ? 1 : (i.amount ?? 1);
          if (i.unit === 'Atom Bomb') a += count;
          if (i.unit === 'Hydrogen Bomb') h += count;
          if (i.unit === 'MIRV') m += count;
          if (firstNuke === null) firstNuke = t.turnNumber;
          if (t.turnNumber <= q) q1 += count;
          byPlayer[i.clientID] = byPlayer[i.clientID] || { A: 0, H: 0, M: 0 };
          byPlayer[i.clientID][i.unit === 'Atom Bomb' ? 'A' : i.unit === 'Hydrogen Bomb' ? 'H' : 'M'] += count;
          nuclearTargets[i.tile] = (nuclearTargets[i.tile] || 0) + count;
        }
        if (i.unit === 'Missile Silo' && firstSilo === null) firstSilo = t.turnNumber;
      }
      if (i.type === 'attack' && i.targetID) targets[i.targetID] = (targets[i.targetID] || 0) + 1;
    }
  }
  const phase = x => x === null ? 'none' : (x <= q ? 'Q1' : x <= 2 * q ? 'Q2' : x <= 3 * q ? 'Q3' : 'Q4');
  const gap = firstSilo !== null && firstNuke !== null ? firstNuke - firstSilo : null;
  console.log('=== ' + j.info.gameID + ' | ' + cfg.gameMap + ' ' + cfg.gameMode + ' diff=' + cfg.difficulty +
    ' | N=' + N + ' maxT=' + maxT + ' players=' + (j.info.players || []).length);
  console.log('requestedNukes=' + (a + h + m) + ' A' + a + '/H' + h + '/M' + m + ' | firstSilo=' + firstSilo + ' (' + phase(firstSilo) + ')' +
    ' firstNuke=' + firstNuke + ' (' + phase(firstNuke) + ') gap=' + gap + ' | Q1nukes=' + q1);
  console.log('silos=' + (builds['Missile Silo'] || 0) + ' ports=' + (builds['Port'] || 0) +
    ' defensePosts=' + (builds['Defense Post'] || 0) + ' sam=' + (builds['SAM Launcher'] || 0) +
    ' | nukers=' + Object.keys(byPlayer).length);
  const top = Object.entries(targets).sort((x, y) => y[1] - x[1]).slice(0, 6);
  console.log('attack targets: ' + top.map(x => x[0] + 'x' + x[1]).join(', '));
  console.log('requested nuclear destination tiles: ' + Object.entries(nuclearTargets).sort((x, y) => y[1] - x[1]).slice(0, 6).map(x => x[0] + 'x' + x[1]).join(', '));
}
