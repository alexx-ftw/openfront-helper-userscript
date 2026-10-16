import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

let yields = 0;
let tileVisits = 0;
let maxSliceVisits = 0;
let visitsAtYield = 0;
let onYield = () => {};
const sandbox = {
  window: {
    setTimeout(callback, delay) {
      assert.equal(delay, 0);
      maxSliceVisits = Math.max(maxSliceVisits, tileVisits - visitsAtYield);
      visitsAtYield = tileVisits;
      yields += 1;
      onYield();
      callback();
    },
  },
};
executeClassicScript(
  `${readRepositoryFile("engine/ingame/estate-panel.js")}
  globalThis.estateTestState = {
    open() { estatePanelOpen = true; },
    close() { estatePanelOpen = false; estateRefreshGeneration += 1; },
    data() { return estateData; },
    computing() { return estateComputing; },
  };`,
  sandbox,
);

const width = 128;
const height = 96;
const owner = (tile) => {
  const x = tile % width;
  const y = Math.floor(tile / width);
  // Two large components, plus two isolated tiles and an unowned border seed.
  return x < 50 || x >= 80 || (y === 2 && (x === 60 || x === 70)) ? 7 : 0;
};
const neighbors = (tile) => {
  const result = [];
  const x = tile % width;
  const y = Math.floor(tile / width);
  if (x > 0) result.push(tile - 1);
  if (x < width - 1) result.push(tile + 1);
  if (y > 0) result.push(tile - width);
  if (y < height - 1) result.push(tile + width);
  return result;
};
const game = {
  x: (tile) => tile % width,
  y: (tile) => Math.floor(tile / width),
  ownerID: owner,
  forEachNeighbor(tile, visit) {
    tileVisits += 1;
    for (const neighbor of neighbors(tile)) visit(neighbor);
  },
};
const seeds = [0, 80, 2 * width + 60, 2 * width + 70, 55];
const expected = [
  { key: "0", tiles: 50 * height, cx: 24.5, cy: 47.5 },
  { key: "80", tiles: 48 * height, cx: 103.5, cy: 47.5 },
  { key: String(2 * width + 60), tiles: 1, cx: 60, cy: 2 },
  { key: String(2 * width + 70), tiles: 1, cx: 70, cy: 2 },
];
const plain = (value) => JSON.parse(JSON.stringify(value));
assert.deepEqual(
  plain(await sandbox.computeEstateComponents(game, seeds, 7, () => true)),
  expected,
  "slicing preserves component sizes, stable keys, and centroids",
);
maxSliceVisits = Math.max(maxSliceVisits, tileVisits - visitsAtYield);
assert.equal(tileVisits, 9408 + 2, "each owned tile is expanded once");
assert.ok(yields >= 18, "large territories yield repeatedly to the event loop");
assert.ok(maxSliceVisits <= 512, "no slice expands more than 512 tiles");

// Older game interfaces still work without forEachNeighbor.
const fallbackGame = { ...game, forEachNeighbor: undefined, neighbors };
assert.deepEqual(
  plain(await sandbox.computeEstateComponents(fallbackGame, new Set(seeds), 7, () => true)),
  expected,
);

// Repeated border seeds must count toward the work budget too.
const repeatedSeeds = new Array(4096).fill(2 * width + 60);
const beforeRepeated = yields;
assert.equal((await sandbox.computeEstateComponents(game, repeatedSeeds, 7, () => true)).length, 1);
assert.ok(yields - beforeRepeated >= 8, "already-visited seed loops must also yield");

let current = true;
onYield = () => {
  current = false;
};
const beforeCancelled = tileVisits;
assert.equal(await sandbox.computeEstateComponents(game, seeds, 7, () => current), null);
assert.ok(tileVisits - beforeCancelled <= 512, "cancelled scans stop at the next slice");
const beforeStale = tileVisits;
assert.equal(await sandbox.computeEstateComponents(game, seeds, 7, () => false), null);
assert.equal(tileVisits, beforeStale, "stale scans perform no tile traversal");

let contextGame = game;
let renders = 0;
game.myPlayer = () => ({
  isPlayer: () => true,
  smallID: () => 7,
  borderTiles: async () => ({ borderTiles: seeds }),
});
Object.assign(sandbox, {
  getOpenFrontGameContext: () => ({ game: contextGame }),
  renderEstatePanel: () => {
    renders += 1;
  },
});
sandbox.estateTestState.open();
onYield = () => {
  contextGame = {};
};
await sandbox.refreshEstates();
assert.equal(renders, 0, "a scan from the previous game must not publish results");
assert.equal(sandbox.estateTestState.computing(), false, "cancellation releases the scan lock");

contextGame = game;
onYield = () => {
  sandbox.estateTestState.close();
  sandbox.estateTestState.open();
};
await sandbox.refreshEstates();
assert.equal(renders, 0, "closing and reopening must invalidate the old scan");
assert.deepEqual(plain(sandbox.estateTestState.data()), []);
onYield = () => {};
await sandbox.refreshEstates();
assert.equal(renders, 1, "a fresh scan can publish after cancellation");
assert.deepEqual(plain(sandbox.estateTestState.data()), expected);

process.stdout.write("estate performance regression tests passed\n");
