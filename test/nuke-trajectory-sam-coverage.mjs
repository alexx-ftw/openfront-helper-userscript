// Nuke trajectory vs enemy SAM coverage (goal requirement: consider the
// missile trajectory and the enemy SAM coverage area, including the
// "vertical" dimension). Exercises the real untargetable-window math (the
// height-based immunity band) and the interception loop's honoring of it,
// plus the salvo partition's trajectory gate.

import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const sourcePath = repositoryFilePath("engine/ingame/auto-bot/nukeBehavior.js");
const source = readRepositoryFile("engine/ingame/auto-bot/nukeBehavior.js");

const UNIT = {
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
};
const Difficulty = {
  Easy: "Easy",
  Medium: "Medium",
  Hard: "Hard",
  Impossible: "Impossible",
  Legendary: "Legendary",
};
const sandbox = {
  UNIT,
  Difficulty,
  PlayerType: { Bot: "Bot", Human: "Human", Nation: "Nation" },
  GameMode: { FFA: "FFA", Team: "Team" },
  state: { settings: { winFixes: true }, stats: {} },
  currentDifficulty: () => Difficulty.Legendary,
  isAtLeastHardDifficulty: (d) =>
    d === Difficulty.Hard || d === Difficulty.Impossible || d === Difficulty.Legendary,
  isLegendaryDifficulty: (d) => d === Difficulty.Legendary,
  withTimeout: async (p) => p,
  WORKER_TIMEOUT_MS: 100,
  randTerritoryTileArray: () => [],
  performance: { now: () => 0 },
  discoverCtors: () => ({}),
  getEventBus: () => ({}),
  emitIntent: () => true,
  setLastAction: () => {},
  runtimeDebugLog: () => {},
  tr: (v) => v,
  safeName: () => "x",
  within: (value, min, max) => Math.min(max, Math.max(min, value)),
};
executeClassicScript(`${source}\nglobalThis.__NukeBehavior = NukeBehavior;`, sandbox, {
  filename: sourcePath,
});
assert.equal(typeof sandbox.__NukeBehavior, "function");

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const makeGame = ({ targetableRange }) => ({
  ticks: () => 1000,
  config: () => ({
    defaultNukeSpeed: () => 10,
    defaultNukeTargetableRange: () => targetableRange,
    maxSamRange: () => 50,
  }),
  euclideanDistSquared: dist2,
  nearbyUnits: () => [],
  isValidCoord: () => true,
  // Map surface for the real Parabola path finder: tiles are plain {x,y}.
  x: (tile) => tile.x,
  y: (tile) => tile.y,
  ref: (tile) => tile,
  height: () => 0,
  manhattanDist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y),
});

// A straight-line 1-tile-per-step trajectory on y=0 from x=0 to x=99.
const lineTrajectory = (length) => Array.from({ length }, (_, i) => ({ x: i, y: 0 }));

const behavior = Object.create(sandbox.__NukeBehavior.prototype);
behavior.player = { smallID: () => 1, units: () => [] };

// 1. Untargetable window ("vertical" immunity band): a missile is
// interceptable near the spawn and near the target only; the mid-flight
// high-arc band between the two targetable radii is immune.
{
  behavior.game = makeGame({ targetableRange: 10 });
  const spawn = { x: 0, y: 0 };
  const target = { x: 99, y: 0 };
  const trajectory = lineTrajectory(100);
  const { start, end } = behavior.findUntargetableTrajectoryRange(trajectory, spawn, target);
  // Outside spawn radius (>10) at index 11; inside target radius (<10) at 90.
  assert.equal(
    start,
    11,
    "the immunity band opens once the missile leaves the spawn targetable radius",
  );
  assert.equal(end, 90, "the immunity band closes entering the target's targetable radius");
  assert.equal(end - start > 50, true, "the mid-flight high-arc band dominates a long-range shot");
}

// 2. The interception loop honors the band: a SAM sitting under the
// mid-flight band cannot intercept; the same geometry near the descent
// can. The Parabola dependency is fixed by stubbing the two geometry
// helpers it feeds (the loop under test is the real code). Indexes are
// POSITION-RELATIVE because the real Parabola steps by nuke speed.
{
  behavior.game = makeGame({ targetableRange: 10 });
  const spawn = { x: 0, y: 0 };
  const target = { x: 99, y: 0 };
  let band = { start: 0, end: 0 };
  behavior.findUntargetableTrajectoryRange = () => band;
  let samRule = (_index) => false;
  let samInterceptIndexes = [];
  behavior.hasReachableSamAtTrajectoryIndex = (tile, _trajectory, index) => {
    samInterceptIndexes.push(index);
    return samRule(index);
  };
  const interceptable = () => behavior.isTrajectoryInterceptableBySam(spawn, target);

  // Establish the real trajectory's length first (mid-band = interior).
  const probeIndexes = [];
  samRule = (index) => {
    probeIndexes.push(index);
    return false;
  };
  band = { start: -1, end: -1 };
  interceptable();
  const len = Math.max(...probeIndexes) + 2; // loop stops at len-2

  // Mid-flight band covering the interior; SAM only under the band. The
  // band is half-open [start, end): with end = len-2, indexes 2..len-3 are
  // immune and only 0,1 and len-2 remain targetable.
  band = { start: 2, end: len - 2 };
  samRule = (index) => index >= 2 && index <= len - 3;
  samInterceptIndexes = [];
  assert.equal(
    interceptable(),
    false,
    "a SAM under the high-arc mid-flight band cannot intercept (vertical immunity)",
  );
  assert.equal(
    samInterceptIndexes.every((i) => i < 2 || i > len - 3),
    true,
    "the loop never probes the mid-flight immunity band",
  );

  // SAM covering the descent instead.
  band = { start: 2, end: len - 2 };
  samRule = (index) => index === len - 2;
  assert.equal(interceptable(), true, "a SAM covering the descent path intercepts the shot");
}

// 3. The salvo partition: coverage REQUIRES an interceptable trajectory —
// the level sum then measures the SAMs actually defending it.
{
  behavior.game = makeGame({ targetableRange: 10 });
  behavior.nukeSpawn = () => ({ x: 0, y: 0 });
  behavior.isTrajectoryInterceptableBySam = (spawn, tile, excluded) =>
    tile.x === 99 && !excluded?.has(12);
  behavior.findEnemySamsCoveringTile = (tile) =>
    tile.x === 99 ? [{ id: () => 12, level: () => 2 }] : [];
  const { clear, covered } = behavior.partitionCandidatesBySamCoverage(
    [
      { tile: { x: 40, y: 0 }, value: 5 },
      { tile: { x: 99, y: 0 }, value: 7 },
    ],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.equal(clear.length, 1, "a trajectory-clear tile stays clear");
  assert.equal(
    covered.length,
    1,
    "an interceptable trajectory with defending SAMs is partitioned as covered",
  );
  assert.equal(
    covered[0].coveringSamLevels,
    2,
    "covering levels sum the defending SAM levels for saturation math",
  );
  // A SAM along the launch/descent route can intercept without covering
  // the destination. It is not a clear shot or a destination-only salvo.
  behavior.isTrajectoryInterceptableBySam = () => true;
  behavior.findEnemySamsCoveringTile = () => [];
  const part2 = behavior.partitionCandidatesBySamCoverage(
    [{ tile: { x: 40, y: 0 }, value: 5 }],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.equal(
    part2.covered.length === 0 && part2.clear.length === 0,
    true,
    "route-only interception must not authorize an unprotected single shot",
  );

  behavior.findEnemySamsCoveringTile = () => [{ id: () => 12, level: () => 2 }];
  const part3 = behavior.partitionCandidatesBySamCoverage(
    [{ tile: { x: 99, y: 0 }, value: 7 }],
    UNIT.AtomBomb,
    Difficulty.Legendary,
  );
  assert.equal(
    part3.covered.length + part3.clear.length,
    0,
    "saturating destination SAMs cannot pay for an additional route interceptor",
  );
}

process.stdout.write("nuke trajectory SAM coverage tests passed\n");
