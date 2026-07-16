import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "engine/ingame/spawn-heatmap.js");
const OBJECTIVE_SOURCE = path.join(ROOT, "engine/ingame/spawn-objective.js");
const LAND = 1 << 7;

function loadHarness() {
  let overlayLayer = null;
  let indexCreateCalls = 0;
  let exactIndexMode = false;
  let exactRangeCalls = 0;
  let spawnPhase = true;
  let players = [];
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
    getCachedPlayerViews: () => players,
    isNationBotPlayer: (player) => player.type() === "NATION",
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
        if (exactIndexMode) {
          return {
            ready: true,
            size: 64,
            width: 8,
            height: 8,
            version: 0,
            forEachCandidateRange() {
              exactRangeCalls += 1;
            },
          };
        }
        return { ready: false };
      },
      FRONTIER_VALUE_SCALE: 1000,
    },
  };
  sandbox.globalThis = sandbox;
  // eslint-disable-next-line sonarjs/code-eval -- executes the local classic userscript module in an isolated test realm.
  vm.runInNewContext(fs.readFileSync(OBJECTIVE_SOURCE, "utf8"), sandbox, {
    filename: OBJECTIVE_SOURCE,
  });
  // eslint-disable-next-line sonarjs/code-eval -- executes the local classic userscript module in an isolated test realm.
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
    computeAsyncExactSpawnTopSpotsForBot: sandbox.computeAsyncExactSpawnTopSpotsForBot,
    computeDynamicScores: sandbox.computeDynamicScores,
    game,
    getIndexCreateCalls: () => indexCreateCalls,
    layer: overlayLayer,
    setSpawnPhase: (value) => {
      spawnPhase = value;
    },
    setSpawnMarkersEnabled: sandbox.setSpawnMarkersEnabled,
    setPlayers: (value) => {
      players = value;
    },
    enableExactIndex: () => {
      exactIndexMode = true;
    },
    getExactRangeCalls: () => exactRangeCalls,
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

const makePlayer = (type, x, y, id) => ({
  type: () => type,
  isAlive: () => true,
  hasSpawned: () => type === "HUMAN",
  nameLocation: () => ({ x, y }),
  smallID: () => id,
});
const fallbackMe = makePlayer("HUMAN", 0, 0, 99);
fallbackMe.isOnSameTeam = () => false;
harness.setPlayers([
  fallbackMe,
  makePlayer("HUMAN", 90, 90, 1),
  makePlayer("HUMAN", 110, 90, 2),
  makePlayer("HUMAN", 100, 115, 3),
  makePlayer("BOT", 390, 100, 4),
  makePlayer("BOT", 410, 100, 5),
  makePlayer("BOT", 400, 120, 6),
]);
const fallback = harness.computeDynamicScores(
  { width: () => 600, height: () => 300 },
  [
    { x: 100, y: 100, staticScore: 1, freeLandScore: 1 },
    { x: 400, y: 100, staticScore: 0.3, freeLandScore: 0.9 },
  ],
  fallbackMe,
);
assert.equal(
  fallback.topSpots[0].x,
  400,
  "fallback selection must prefer an uncrowded reachable tribe cluster over richer local terrain",
);
assert.equal(fallback.topSpots[0].y, 100);
assert.equal(fallback.scores[0].tribeReachCount, 3);
assert.equal(fallback.scores[0].objective.safetyScore, 1);
assert.ok(
  fallback.scores[1].score > fallback.scores[0].score,
  "the robust fallback must override the legacy additive score in this regression",
);

// The live exact selector must schedule its first range asynchronously. This
// protects the spawn phase from reintroducing a synchronous full-map pass when
// a ready index is available.
harness.enableExactIndex();
const asyncGame = {
  __src: { _map: { terrain: new Uint8Array(64).fill(LAND) } },
  height: () => 8,
  width: () => 8,
};
assert.equal(
  harness.computeAsyncExactSpawnTopSpotsForBot(asyncGame, null),
  null,
  "async exact selector returns the previous/fallback path while ranking is queued",
);
assert.equal(
  harness.getExactRangeCalls(),
  0,
  "async exact selector must not scan a candidate range synchronously",
);

console.log("spawn-heatmap tests passed");
