import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const sandbox = {
  window: { innerWidth: 100, innerHeight: 80 },
  ECONOMY_HEATMAP_VIEWPORT_PADDING: 10,
  HEATMAP_REFERENCE_ZOOM: 2,
};
const heatmapFiles = [
  "engine/ingame/heatmaps/state.js",
  "engine/ingame/heatmaps/dom.js",
  "engine/ingame/heatmaps/trade-sources.js",
  "engine/ingame/heatmaps/projection.js",
  "engine/ingame/heatmaps/webgl.js",
  "engine/ingame/heatmaps/canvas.js",
  "engine/ingame/heatmaps/draw.js",
  "engine/ingame/heatmaps/export-partner.js",
  "engine/ingame/heatmaps/lifecycle.js",
];
executeClassicScript(heatmapFiles.map(readRepositoryFile).join("\n"), sandbox, {
  filename: "engine/ingame/heatmaps (9-file classic-script concat)",
});
const project = sandbox.projectEconomyHeatmapPoints;
const game = { x: (tile) => tile, y: (tile) => tile + 1 };
const source = (tile, weight = 7, type = "Factory") => ({ tile, weight, type });
const record = (x, y, weight = 7, type = "Factory", zoomScale = 1) => ({
  x,
  y,
  weight,
  type,
  zoomScale,
});
const plain = (points) => Array.from(points, (point) => ({ ...point }));

const inputs = new Set();
const calls = [];
const transform = {
  scale: 2,
  worldToScreenCoordinates(point) {
    inputs.add(point);
    calls.push([point.x, point.y]);
    return { x: point.x % 100, y: point.y % 80 };
  },
};
const many = Array.from({ length: 1000 }, (_, tile) => source(tile));
const projected = project(many, game, transform);
assert.equal(calls.length, 1000, "all sources retain one ordered transform call each");
assert.deepEqual(
  calls,
  many.map(({ tile }) => [tile, tile + 1]),
);
assert.equal(inputs.size, 1, "1000 sources must reuse one invocation-local transform input");
assert.equal(new Set(projected).size, 1000, "output records must remain independent");
assert.deepEqual(
  plain(projected),
  many.map(({ tile }) => record(tile % 100, (tile + 1) % 80)),
);

const boundaryCoordinates = [
  [-10, 0],
  [-9, 0],
  [110, 0],
  [109, 0],
  [0, -10],
  [0, -9],
  [0, 90],
  [0, 89],
  [NaN, 0],
  [0, Infinity],
  ["1", 0],
  [0, undefined],
];
const coordinateGame = {
  x: (tile) => boundaryCoordinates[tile][0],
  y: (tile) => boundaryCoordinates[tile][1],
};
let boundaryCalls = 0;
const identity = {
  scale: 4,
  worldToScreenCoordinates(point) {
    boundaryCalls += 1;
    return point;
  },
};
const boundaries = project(
  [
    source(null),
    source(undefined),
    ...boundaryCoordinates.map((_, tile) => source(tile, tile, "Port")),
  ],
  coordinateGame,
  identity,
);
assert.equal(
  boundaryCalls,
  boundaryCoordinates.length,
  "null tiles skip coordinate and transform reads",
);
assert.deepEqual(plain(boundaries), [
  record(-9, 0, 1, "Port", 2),
  record(109, 0, 3, "Port", 2),
  record(0, -9, 5, "Port", 2),
  record(0, 89, 7, "Port", 2),
]);
for (const scale of [undefined, NaN, Infinity, 0, -1]) {
  identity.scale = scale;
  assert.deepEqual(plain(project([source(0)], game, identity)), [record(0, 1)]);
}
assert.deepEqual(plain(project([], game, identity)), []);
assert.deepEqual(plain(project([source(0)], game, { worldToScreenCoordinates: () => null })), []);

const reusableOutput = {};
let cameraX = 10;
const outputInputs = [];
const camera = {
  scale: 2,
  worldToScreenCoordinates(point) {
    outputInputs.push(point);
    reusableOutput.x = point.x + cameraX;
    reusableOutput.y = point.y;
    return reusableOutput;
  },
};
const beforeCamera = project([source(1), source(2, 9, "City")], game, camera);
const savedCamera = plain(beforeCamera);
cameraX = 20;
camera.scale = 4;
assert.deepEqual(plain(project([source(3)], game, camera)), [record(23, 4, 7, "Factory", 2)]);
assert.deepEqual(plain(beforeCamera), [record(11, 2), record(12, 3, 9, "City")]);
assert.deepEqual(
  plain(beforeCamera),
  savedCamera,
  "later projections cannot rewrite earlier output",
);
assert.notEqual(
  outputInputs[0],
  outputInputs[2],
  "separate invocations own separate scratch inputs",
);

const outerInputs = [];
const innerInputs = [];
let nested;
const reentrant = {
  scale: 2,
  worldToScreenCoordinates(point) {
    outerInputs.push(point);
    const snapshot = { ...point };
    nested = project([source(20), source(21)], game, {
      scale: 1,
      worldToScreenCoordinates(inner) {
        innerInputs.push(inner);
        return inner;
      },
    });
    assert.deepEqual({ ...point }, snapshot, "nested projection cannot overwrite outer scratch");
    point.x += 5;
    point.y += 6;
    return point;
  },
};
assert.deepEqual(plain(project([source(1), source(2)], game, reentrant)), [
  record(6, 8),
  record(7, 9),
]);
assert.deepEqual(plain(nested), [
  record(20, 21, 7, "Factory", 0.5),
  record(21, 22, 7, "Factory", 0.5),
]);
assert.equal(new Set(outerInputs).size, 1);
assert.equal(new Set(innerInputs).size, 2, "each nested invocation owns one distinct input");
assert.ok(innerInputs.every((point) => point !== outerInputs[0]));

console.warn(
  "heatmap projection tests passed: 1000 calls, 1 input; exact outputs and reentrancy preserved",
);
