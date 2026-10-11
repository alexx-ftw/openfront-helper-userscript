import assert from "node:assert/strict";
import {
  executeClassicScript,
  readRepositoryFile,
  repositoryFilePath,
} from "./helpers/repository-fixture.mjs";

const sourcePath = repositoryFilePath("engine/ingame/nuke-suggestions.js");
const source = readRepositoryFile("engine/ingame/nuke-suggestions.js");
let now = 0;
const sandbox = {
  Map,
  Set,
  Math,
  Number,
  String,
  Array,
  performance: { now: () => now },
  globalThis: null,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${source}\nglobalThis.__createTileScanBuilder = createTileScanBuilder; globalThis.__advanceTileScan = advanceTileScan;`,
  sandbox,
  { filename: sourcePath },
);

const width = 128;
const height = 64;
const game = {
  ownerID(tile) {
    now += 0.1;
    if (tile % 7 === 0) return 2;
    if (tile % 5 === 0) return 1;
    return 0;
  },
  x: (tile) => tile % width,
  y: (tile) => Math.floor(tile / width),
};
const builder = sandbox.__createTileScanBuilder(game, {
  targetId: 2,
  myPlayerId: 1,
  allySmallIds: new Set(),
  width,
  height,
});

let slices = 0;
let result = null;
while (result === null && builder.nextTile < builder.totalTiles) {
  const sliceStartedAt = now;
  result = sandbox.__advanceTileScan(builder, now + 6);
  assert.ok(now - sliceStartedAt <= 31.6, "scan yields after a bounded tile batch");
  slices += 1;
}

assert.ok(slices > 1, "large ownership scans are split across tasks");
assert.equal(result.tiles.length, Math.ceil((width * height) / 7));
assert.equal(result.selfBuckets.size > 0, true);
console.warn("nuke suggestion scan budget tests passed");
