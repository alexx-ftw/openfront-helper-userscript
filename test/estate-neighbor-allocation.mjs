import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const filenames = [
  "engine/ingame/estate/constants.js",
  "engine/ingame/estate/styles.js",
  "engine/ingame/estate/panel.js",
  "engine/ingame/estate/compute.js",
  "engine/ingame/estate/lifecycle.js",
];
const sandbox = {};
executeClassicScript(
  filenames.map((filename) => readRepositoryFile(filename)).join("\n"),
  sandbox,
  { filename: filenames.join(",") },
);
const nativeSource = readRepositoryFile("openfront-engine/src/core/game/GameMap.ts");
const native = {};
for (const [name, signature] of [
  ["neighbors", "neighbors\\(ref: TileRef\\): TileRef\\[\\]"],
  ["neighbors4", "neighbors4\\(ref: TileRef, out: TileRef\\[\\]\\): number"],
]) {
  const body = nativeSource.match(new RegExp(`  ${signature} \\{([\\s\\S]*?)\\n  \\}`))?.[1];
  assert.ok(body, `native ${name} contract must remain inspectable`);
  executeClassicScript(
    `globalThis.${name} = function(ref, out) {${body.replace("const neighbors: TileRef[]", "const neighbors")}};`,
    native,
    { filename: `native-${name}.js` },
  );
}

function fixture(width, height, owned, buffered = true) {
  const counts = { arrays: 0, calls: 0, buffers: new Set(), visits: [], owners: [] };
  const game = {
    width_: width,
    height_: height,
    x(tile) {
      counts.visits.push(tile);
      return tile % width;
    },
    y: (tile) => Math.floor(tile / width),
    ownerID(tile) {
      counts.owners.push(tile);
      assert.ok(tile >= 0 && tile < width * height, "stale slots cannot escape the map");
      return owned === null || owned.has(tile) ? 7 : 8;
    },
    neighbors(tile) {
      counts.arrays++;
      return native.neighbors.call(this, tile);
    },
  };
  if (buffered) {
    game.neighbors4 = function (tile, out) {
      counts.calls++;
      counts.buffers.add(out);
      // Poison unused slots; the native method intentionally does not clear them.
      out.fill(width * height + 100);
      return native.neighbors4.call(this, tile, out);
    };
  }
  return { game, counts };
}

function compute(game, seeds) {
  return JSON.parse(JSON.stringify(sandbox.computeEstateComponents(game, seeds, 7)));
}

const large = fixture(64, 64, null);
assert.deepEqual(compute(large.game, [0, 0, 4095]), [
  { key: "0", tiles: 4096, cx: 31.5, cy: 31.5 },
]);
assert.equal(
  large.counts.arrays,
  0,
  "buffered traversal must allocate no neighbor arrays per tile",
);
assert.equal(large.counts.calls, 4096, "each owned tile probes neighbors exactly once");
assert.equal(large.counts.buffers.size, 1, "one component reuses one local buffer");

const cases = [
  {
    width: 1,
    height: 1,
    owned: null,
    seeds: [0, 0],
    expected: [{ key: "0", tiles: 1, cx: 0, cy: 0 }],
  },
  {
    width: 3,
    height: 3,
    owned: null,
    seeds: [4, 0, 8],
    expected: [{ key: "0", tiles: 9, cx: 1, cy: 1 }],
  },
  {
    width: 4,
    height: 3,
    owned: new Set([0, 1, 4, 7, 11]),
    seeds: [11, 0, 7, 1, 11],
    expected: [
      { key: "7", tiles: 2, cx: 3, cy: 1.5 },
      { key: "0", tiles: 3, cx: 1 / 3, cy: 1 / 3 },
    ],
  },
  {
    width: 3,
    height: 1,
    owned: new Set([0, 2]),
    seeds: [2, 0, 2],
    expected: [
      { key: "2", tiles: 1, cx: 2, cy: 0 },
      { key: "0", tiles: 1, cx: 0, cy: 0 },
    ],
  },
  {
    width: 1,
    height: 3,
    owned: null,
    seeds: [2],
    expected: [{ key: "0", tiles: 3, cx: 0, cy: 1 }],
  },
  {
    width: 3,
    height: 1,
    owned: new Set([0, 2]),
    seeds: [1],
    expected: [{ key: "0", tiles: 3, cx: 1, cy: 0 }],
  },
  { width: 3, height: 3, owned: null, seeds: [], expected: [] },
];
for (const { width, height, owned, seeds, expected } of cases) {
  const fast = fixture(width, height, owned);
  const legacy = fixture(width, height, owned, false);
  assert.deepEqual(compute(fast.game, seeds), expected);
  assert.deepEqual(
    compute(legacy.game, seeds),
    expected,
    "legacy fallback retains exact components",
  );
  assert.deepEqual(fast.counts.visits, legacy.counts.visits, "DFS visit order is unchanged");
  assert.deepEqual(fast.counts.owners, legacy.counts.owners, "ownership probe order is unchanged");
  assert.equal(fast.counts.arrays, 0);
  assert.equal(legacy.counts.arrays, legacy.counts.visits.length);
  assert.equal(fast.counts.calls, fast.counts.visits.length);
  assert.equal(fast.counts.buffers.size, expected.length, "buffers are local to each component");
  if (seeds.length > 0) {
    legacy.game.neighbors4 = null;
    assert.deepEqual(compute(legacy.game, seeds), expected, "nonfunction neighbors4 uses fallback");
  }
}
assert.equal(native.neighbors4.call({ width_: 3, height_: 3 }, 4, []), 4);
const cornerBuffer = [99, 99, 99, 99];
assert.equal(native.neighbors4.call({ width_: 3, height_: 3 }, 0, cornerBuffer), 2);
assert.deepEqual(cornerBuffer, [3, 1, 99, 99], "native count excludes retained stale slots");
console.warn(
  "estate neighbor allocation: 4096 tiles, zero per-tile neighbor arrays; exact legacy parity passed",
);
