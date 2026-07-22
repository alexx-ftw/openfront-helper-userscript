import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/spawn-index.js");
const source = fs.readFileSync(SOURCE, "utf8");

function loadApi() {
  const sandbox = {
    Array,
    Math,
    Number,
    Set,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(source, sandbox, { filename: SOURCE });
  assert.ok(sandbox.__OFHSpawnIndex, "spawn index API must be exposed for the engine");
  return sandbox.__OFHSpawnIndex;
}

const api = loadApi();
assert.doesNotMatch(
  source,
  /_terrainValid/,
  "spawn index construction must not allocate and synchronously populate a duplicate validity map",
);
assert.doesNotMatch(
  source,
  /Uint8Array\.from\(terrain\.slice/,
  "spawn terrain snapshots must not create an intermediate full-map copy",
);
const LAND = 1 << 7;
const IMPASSABLE_LAND = LAND | 31;

function makeTerrain(width, height, byte = 0) {
  return new Uint8Array(width * height).fill(byte);
}

function ref(width, x, y) {
  return y * width + x;
}

function collect(index, options = {}) {
  const result = [];
  index.forEachCandidate({
    ...options,
    onCandidate: (...candidateArgs) => {
      const [
        refValue,
        x,
        y,
        spawnGain,
        invalidCount,
        plainsGain,
        frontierGain,
        frontierPlainsGain,
        frontierValueGain,
        frontierSlots,
      ] = candidateArgs;
      result.push({
        ref: refValue,
        x,
        y,
        spawnGain,
        invalidCount,
        plainsGain,
        frontierGain,
        frontierPlainsGain,
        frontierValueGain,
        frontierSlots,
      });
    },
  });
  return result;
}

function test(name, fn) {
  {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  }
}

test("explicit mode keeps a valid narrow island while random mode rejects it", () => {
  const width = 9;
  const terrain = makeTerrain(width, 9);
  terrain[ref(width, 4, 4)] = LAND;
  const index = api.create({ width, height: 9, terrain });
  index.buildAll();

  const explicit = collect(index, { mode: "explicit" });
  const random = collect(index, { mode: "random" });

  assert.deepEqual(
    explicit.map((candidate) => candidate.ref),
    [ref(width, 4, 4)],
  );
  assert.equal(explicit[0].spawnGain, 1);
  assert.deepEqual(random, []);
});

test("impassable land is excluded and a local terrain update changes nearby gains", () => {
  const width = 11;
  const height = 11;
  const terrain = makeTerrain(width, height, LAND);
  const index = api.create({ width, height, terrain });
  index.buildAll();
  const center = ref(width, 5, 5);
  const neighbor = ref(width, 6, 5);
  const before = index.getCandidate(center, { mode: "explicit" });
  const neighborBefore = index.getCandidate(neighbor, { mode: "explicit" });

  index.updateTerrain(center, IMPASSABLE_LAND);

  assert.equal(index.getCandidate(center, { mode: "explicit" }), null);
  assert.equal(
    index.getCandidate(neighbor, { mode: "explicit" }).spawnGain,
    neighborBefore.spawnGain - 1,
  );
  assert.equal(index.version > 0, true);

  index.updateTerrain(center, LAND);
  assert.equal(index.getCandidate(center, { mode: "explicit" }).spawnGain, before.spawnGain);
});

test("terrain quality is indexed and updated without changing legal-tile counts", () => {
  const width = 11;
  const height = 11;
  const center = ref(width, 5, 5);
  const index = api.create({ width, height, terrain: makeTerrain(width, height, LAND) });
  index.buildAll();
  const before = index.getCandidate(center, { mode: "explicit" });

  index.updateTerrain(center, LAND | 15);

  const after = index.getCandidate(center, { mode: "explicit" });
  assert.equal(after.spawnGain, before.spawnGain);
  assert.equal(after.plainsGain, before.plainsGain - 1);
});

test("frontier metrics distinguish open land from a dead-end island", () => {
  const width = 15;
  const height = 15;
  const center = ref(width, 7, 7);
  const mainland = api.create({ width, height, terrain: makeTerrain(width, height, LAND) });
  mainland.buildAll();
  const mainlandCandidate = mainland.getCandidate(center, { mode: "explicit" });

  const islandTerrain = makeTerrain(width, height);
  islandTerrain[center] = LAND;
  const island = api.create({ width, height, terrain: islandTerrain });
  island.buildAll();
  const islandCandidate = island.getCandidate(center, { mode: "explicit" });

  assert.equal(mainlandCandidate.frontierGain > 0, true);
  assert.equal(mainlandCandidate.frontierGain, mainlandCandidate.frontierSlots);
  assert.equal(islandCandidate.frontierGain, 0);
});

test("frontier value follows terrain attack cost and updates locally", () => {
  const width = 15;
  const height = 15;
  const center = ref(width, 7, 7);
  const terrain = makeTerrain(width, height, LAND);
  const index = api.create({ width, height, terrain });
  index.buildAll();
  const before = index.getCandidate(center, { mode: "explicit" });
  const frontierOffset = index.frontierOffsets.find((offset) => offset.dx !== 0 || offset.dy !== 0);
  const frontierRef = ref(width, 7 + frontierOffset.dx, 7 + frontierOffset.dy);

  index.updateTerrain(frontierRef, LAND | 15);

  const after = index.getCandidate(center, { mode: "explicit" });
  assert.equal(after.frontierGain, before.frontierGain);
  assert.equal(after.frontierValueGain < before.frontierValueGain, true);
});

test("occupancy updates are incremental and affect explicit and random eligibility", () => {
  const width = 11;
  const height = 11;
  const terrain = makeTerrain(width, height, LAND);
  const index = api.create({ width, height, terrain });
  index.buildAll();
  const center = ref(width, 5, 5);
  const neighbor = ref(width, 6, 5);
  const neighborBefore = index.getCandidate(neighbor, { mode: "explicit" });

  index.updateBlocked(center, true);

  assert.equal(index.getCandidate(center, { mode: "explicit" }), null);
  assert.equal(
    index.getCandidate(neighbor, { mode: "explicit" }).spawnGain,
    neighborBefore.spawnGain - 1,
  );
  assert.equal(index.getCandidate(neighbor, { mode: "random" }), null);

  index.updateBlocked(center, false);
  assert.equal(index.getCandidate(neighbor, { mode: "random" }) !== null, true);
});

test("terrain updates stay correct while the index is still building", () => {
  const width = 11;
  const height = 11;
  const index = api.create({ width, height, terrain: makeTerrain(width, height, LAND) });
  index.buildSlice(1);
  const firstCenterGain = index.spawnGain[0];

  index.updateTerrain(1, 0);
  while (!index.ready) index.buildSlice(1);

  assert.equal(index.getCandidate(0, { mode: "explicit" }).spawnGain, firstCenterGain - 1);
});

test("incremental building covers every tile on arbitrary map dimensions", () => {
  const width = 5;
  const height = 3;
  const index = api.create({ width, height, terrain: makeTerrain(width, height, LAND) });
  while (!index.ready) index.buildSlice(1);

  assert.equal(collect(index, { mode: "explicit" }).length, width * height);
  assert.equal(index.stats().candidateCount, width * height);
});

test("counter storage follows the exact spawn geometry range", () => {
  const compact = api.create({
    width: 5,
    height: 5,
    terrain: makeTerrain(5, 5, LAND),
  });
  for (const field of [
    "spawnGain",
    "plainsGain",
    "invalidCount",
    "frontierGain",
    "frontierPlainsGain",
    "frontierSlots",
  ]) {
    assert.equal(
      compact[field].BYTES_PER_ELEMENT,
      1,
      `${field} should use one byte for the default spawn geometry`,
    );
  }
  assert.equal(
    compact.frontierValueGain.BYTES_PER_ELEMENT,
    2,
    "the default weighted frontier range fits exactly in two bytes",
  );

  const wide = api.create({
    width: 25,
    height: 25,
    terrain: makeTerrain(25, 25, LAND),
    spawnRadius: 10,
  });
  assert.equal(
    wide.spawnGain.BYTES_PER_ELEMENT,
    2,
    "larger custom spawn disks must widen counters instead of overflowing",
  );
  const veryWide = api.create({
    width: 45,
    height: 45,
    terrain: makeTerrain(45, 45, LAND),
    spawnRadius: 20,
  });
  assert.equal(
    veryWide.frontierValueGain.BYTES_PER_ELEMENT,
    4,
    "large weighted frontiers must retain 32-bit storage",
  );
  wide.buildAll();
  assert.ok(wide.getCandidate(ref(25, 12, 12), { mode: "explicit" }).spawnGain > 255);
});

test("enemy pressure is a monotonic safety penalty", () => {
  assert.equal(api.safePressureScore(0), 1);
  assert.equal(api.safePressureScore(2) < api.safePressureScore(1), true);
  assert.equal(api.safePressureScore(10) < api.safePressureScore(2), true);
});

process.stdout.write("spawn-index tests passed\n");
