import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const sandbox = {
  window: { innerWidth: 1280, innerHeight: 720 },
  ECONOMY_HEATMAP_VIEWPORT_PADDING: 120,
  HEATMAP_REFERENCE_ZOOM: 1.8,
};
executeClassicScript(
  `${readRepositoryFile("engine/ingame/map-overlay-scheduler.js")}\n${readRepositoryFile("engine/ingame/heatmaps.js")}`,
  sandbox,
);

const sources = Array.from({ length: 2048 }, (_, tile) => ({
  tile,
  weight: tile + 1,
  type: tile % 2 ? "City" : "Port",
}));
sources.push({ tile: null, weight: 10, type: "City" });
const game = {
  x: (tile) => tile % 128,
  y: (tile) => Math.floor(tile / 128),
};
let transformCalls = 0;
let cameraX = 100;
let cameraY = 200;
const transform = {
  scale: 1.8,
  worldToScreenCoordinates(point) {
    transformCalls += 1;
    return { x: point.x * this.scale + cameraX, y: point.y * this.scale + cameraY };
  },
};

// The previous per-source transform path is the reference implementation.
function referencePoints() {
  const result = [];
  for (const source of sources) {
    if (source.tile === null) continue;
    const x = game.x(source.tile) * transform.scale + cameraX;
    const y = game.y(source.tile) * transform.scale + cameraY;
    if (x <= -120 || y <= -120 || x >= 1400 || y >= 840) continue;
    result.push({
      x,
      y,
      weight: source.weight,
      type: source.type,
      zoomScale: transform.scale / 1.8,
    });
  }
  return result;
}

for (const scale of [0.01, 1.8, 4, 12]) {
  transform.scale = scale;
  for (const offset of [-500, 0, 200, 1400]) {
    cameraX = offset;
    cameraY = offset / 2;
    transformCalls = 0;
    const actual = sandbox.projectEconomyHeatmapPoints(sources, game, transform);
    const expected = referencePoints();
    assert.equal(transformCalls, 3, "projection samples the camera three times for 2048 sources");
    assert.equal(actual.length, expected.length, "viewport clipping preserves visible sources");
    for (let index = 0; index < expected.length; index += 1) {
      assert.ok(Math.abs(actual[index].x - expected[index].x) < 1e-8);
      assert.ok(Math.abs(actual[index].y - expected[index].y) < 1e-8);
      assert.equal(actual[index].weight, expected[index].weight);
      assert.equal(actual[index].type, expected[index].type);
      assert.equal(actual[index].zoomScale, expected[index].zoomScale);
    }
  }
}

cameraX = 100;
cameraY = 200;
transform.scale = 1.8;
sandbox.mapMakeProjector = undefined;
transformCalls = 0;
const fallback = sandbox.projectEconomyHeatmapPoints(sources, game, transform);
assert.equal(transformCalls, 2048, "a standalone heatmap retains the original transform fallback");
assert.equal(fallback.length, referencePoints().length);
assert.equal(fallback[0].x, 100);
assert.equal(fallback[0].y, 200);

process.stdout.write("heatmap projection performance tests passed\n");
