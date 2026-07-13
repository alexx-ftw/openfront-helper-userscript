import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/spawn-heatmap.js");
const LAND = 1 << 7;

function loadHarness() {
  let overlayLayer = null;
  let indexCreateCalls = 0;
  let spawnPhase = true;
  const terrain = new Uint8Array(64).fill(LAND);
  const sandbox = {
    Array,
    JSON,
    Math,
    Number,
    Set,
    Uint8Array,
    console: { error() {}, log() {}, warn() {} },
    document: {},
    getCachedPlayerViews: () => [],
    isNationBotPlayer: () => false,
    localStorage: { getItem: () => null },
    performance: { now: () => 0 },
    registerMapOverlayLayer: (layer) => {
      overlayLayer = layer;
    },
    requestMapOverlayLoop() {},
    spawnHeatmapEnabled: false,
    spawnMarkersEnabled: false,
    setTimeout: () => 0,
    window: { innerHeight: 600, innerWidth: 800 },
    __OFHSpawnIndex: {
      create() {
        indexCreateCalls += 1;
        return { ready: false };
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), sandbox, {
    filename: SOURCE,
  });

  const game = {
    __src: { _map: { terrain } },
    height: () => 8,
    inSpawnPhase: () => spawnPhase,
    myPlayer: () => null,
    width: () => 8,
  };
  return {
    computeExactSpawnTopSpotsForBot: sandbox.computeExactSpawnTopSpotsForBot,
    game,
    getIndexCreateCalls: () => indexCreateCalls,
    layer: overlayLayer,
    setSpawnPhase: (value) => {
      spawnPhase = value;
    },
    setSpawnMarkersEnabled: sandbox.setSpawnMarkersEnabled,
  };
}

const harness = loadHarness();
assert.ok(harness.layer, "spawn overlay must register a layer");
harness.setSpawnMarkersEnabled(true);
assert.equal(harness.layer.isEnabled(), true);

// Markers only need the lightweight player-position scan. They must not start
// the map-wide exact candidate index, which is reserved for the bot selector.
harness.layer.scan(harness.game);
assert.equal(
  harness.getIndexCreateCalls(),
  0,
  "spawn markers must not allocate the exact map-wide candidate index",
);

harness.setSpawnPhase(false);
harness.layer.scan(harness.game);
harness.setSpawnPhase(true);
harness.layer.scan(harness.game);
assert.equal(
  harness.getIndexCreateCalls(),
  0,
  "leaving and re-entering spawn must not reintroduce exact-index allocation",
);

const largeTerrain = { length: 1308 * 1754 };
const largeGame = {
  __src: { _map: { terrain: largeTerrain } },
  height: () => 1754,
  width: () => 1308,
};
assert.equal(
  harness.computeExactSpawnTopSpotsForBot(largeGame, null),
  null,
  "large maps must fall back from the exact selector",
);
assert.equal(
  harness.getIndexCreateCalls(),
  0,
  "large maps must not allocate the exact map-wide candidate index",
);

console.log("spawn-heatmap tests passed");
