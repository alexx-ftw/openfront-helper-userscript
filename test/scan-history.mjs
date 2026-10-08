import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'ofh-history-test-'));
try {
  const path = join(dir, 'record.json');
  writeFileSync(path, JSON.stringify({
    info: { gameID: 'fixture', num_turns: 1000, config: {}, players: [] },
    turns: [
      { turnNumber: 100, intents: [{ type: 'build_unit', unit: 'Missile Silo', tile: 42 }] },
      { turnNumber: 600, intents: [
        { type: 'build_unit', unit: 'Atom Bomb', tile: 999, amount: 3 },
        { type: 'build_unit', unit: 'MIRV', tile: 777 },
      ] },
    ],
  }));
  const output = execFileSync(process.execPath, ['scripts/headless/scan-history.cjs', path], { encoding: 'utf8' });
  assert.match(output, /requestedNukes=4 A3\/H0\/M1/);
  assert.match(output, /firstNuke=600 \(Q3\) gap=500/);
  assert.match(output, /requested nuclear destination tiles: 999x3, 777x1/);
  assert.doesNotMatch(output, /destination tiles:.*42/);
  console.log('scan-history regression passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
