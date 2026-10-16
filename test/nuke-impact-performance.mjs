import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const sandbox = {};
executeClassicScript(readRepositoryFile("engine/ingame/nuke-impact.js"), sandbox);
let distanceCalls = 0;
const game = {
  x: (tile) => tile % 1000,
  y: (tile) => Math.floor(tile / 1000),
  euclideanDistSquared(a, b) {
    distanceCalls++;
    return (this.x(a) - this.x(b)) ** 2 + (this.y(a) - this.y(b)) ** 2;
  },
};
// Reverse order, duplicate distances, zero tile, and invalid coordinates cover
// the stable nearest-neighbor policy independently of runtime speed.
for (const count of [0, 1, 12, 13, 10000]) {
  const entries = Array.from({ length: count }, (_, i) => ({ tile: count - i - 1 }));
  entries.push({ tile: NaN });
  distanceCalls = 0;
  const result = sandbox.getNukeImpactGeometry({ game, entries, primaryTile: 500 });
  assert.equal(distanceCalls, count, "geometry must read distance only once per valid structure");
  const expected = entries
    .filter((entry) => Number.isFinite(entry.tile))
    .sort((a, b) => game.euclideanDistSquared(a.tile, 500) - game.euclideanDistSquared(b.tile, 500))
    .slice(0, 12)
    .map((entry) => entry.tile);
  assert.deepEqual(
    Array.from(result.geometryEntries, (entry) => entry.tile),
    expected,
  );
  assert.equal(result.coordinateEntries.length, count, "hit index retains every valid structure");
}
console.warn("nuke impact performance tests passed (10,000 structures; one distance read each)");

// Use identical candidate generation with a brute-force distance oracle. This
// tests aggregation against exact strict-circle hits, including duplicate tiles.
const source = readRepositoryFile("engine/ingame/nuke-impact.js");
const oracle = {};
executeClassicScript(source, oracle);
oracle.countNukeImpactHits = (context, candidate) =>
  context.entries.reduce(
    (hits, entry) =>
      hits +
      Number(
        oracle.nukeImpactDistanceSquared(context, candidate, entry.tile) < context.radiusSquared,
      ),
    0,
  );
let seed = 123456789;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const map = {
  x: (tile) => tile % 1000,
  y: (tile) => Math.floor(tile / 1000),
  ref: (x, y) => y * 1000 + x,
  isValidCoord: (x, y) => x >= 0 && y >= 0 && x < 1000 && y < 1000,
  euclideanDistSquared(a, b) {
    return (this.x(a) - this.x(b)) ** 2 + (this.y(a) - this.y(b)) ** 2;
  },
};
for (let iteration = 0; iteration < 60; iteration++) {
  const radius = [1, 5, 10, 20, 100][iteration % 5];
  const primary = map.ref(50, 50);
  const buildings = Array.from({ length: 70 + iteration * 3 }, () => ({
    tile: map.ref(30 + Math.floor(random() * 41), 30 + Math.floor(random() * 41)),
  }));
  assert.equal(
    sandbox.chooseMaxNukeBuildingImpactTile(map, primary, buildings, radius, iteration % 2 === 0),
    oracle.chooseMaxNukeBuildingImpactTile(map, primary, buildings, radius, iteration % 2 === 0),
    `strict-circle aggregation must match brute-force ranking for scenario ${iteration}`,
  );
}
// A dense board crossing the circle boundary prevents the trivial all-hit exit.
const denseBuildings = Array.from({ length: 2500 }, (_, i) => ({
  tile: map.ref(25 + (i % 50), 25 + Math.floor(i / 50)),
}));
const { performance } = await import("node:perf_hooks");
let distanceReads = 0;
const denseMap = {
  ...map,
  euclideanDistSquared(a, b) {
    distanceReads++;
    return map.euclideanDistSquared(a, b);
  },
};
let started = performance.now();
const denseExpected = oracle.chooseMaxNukeBuildingImpactTile(
  denseMap,
  map.ref(50, 50),
  denseBuildings,
  18,
);
const bruteMs = performance.now() - started;
const bruteReads = distanceReads;
distanceReads = 0;
started = performance.now();
const denseActual = sandbox.chooseMaxNukeBuildingImpactTile(
  denseMap,
  map.ref(50, 50),
  denseBuildings,
  18,
);
const indexedMs = performance.now() - started;
assert.equal(denseActual, denseExpected);
assert.ok(
  distanceReads < bruteReads / 5,
  `dense index must cut exact-distance reads: ${distanceReads} vs ${bruteReads}`,
);
console.warn(
  `dense impact oracle passed: ${bruteMs.toFixed(1)}ms / ${bruteReads} reads brute; ${indexedMs.toFixed(1)}ms / ${distanceReads} reads indexed`,
);

// The production async caller drains this same generator between browser tasks.
// Assert bounded work, independently of machine speed or scheduling delays.
distanceReads = 0;
const iterator = sandbox.iterateMaxNukeBuildingImpactTile(
  denseMap,
  map.ref(50, 50),
  denseBuildings,
  18,
);
let step;
let yields = 0;
let maxReadsPerStep = 0;
do {
  const previousReads = distanceReads;
  step = iterator.next();
  maxReadsPerStep = Math.max(maxReadsPerStep, distanceReads - previousReads);
  if (!step.done) yields++;
} while (!step.done);
assert.equal(step.value, denseExpected, "cooperative and synchronous ranking must agree");
assert.ok(yields > 1000, "dense candidate scoring must expose cooperative scheduling points");
assert.ok(maxReadsPerStep < 1000, `dense query step used ${maxReadsPerStep} exact-distance reads`);
console.warn(
  `cooperative impact passed: ${yields} yields; max ${maxReadsPerStep} distance reads per step`,
);
