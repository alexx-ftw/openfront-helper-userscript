import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
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
    runtimeState: {
      spawnHeatmapEnabled: false,
      spawnMarkersEnabled: false,
    },
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
  executeClassicScript(fs.readFileSync(OBJECTIVE_SOURCE, "utf8"), sandbox, {
    filename: OBJECTIVE_SOURCE,
  });
  executeClassicScript(fs.readFileSync(SOURCE, "utf8"), sandbox, {
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
    computeSpawnTopSpotsForBot: sandbox.computeSpawnTopSpotsForBot,
    computeStaticCandidates: sandbox.computeStaticCandidates,
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

const largeFallbackTerrain = new Uint8Array(1308 * 1754).fill(LAND);
const largeFallbackCandidates = harness.computeStaticCandidates({
  __src: { _map: { terrain: largeFallbackTerrain } },
  height: () => 1754,
  width: () => 1308,
});
assert.ok(
  largeFallbackCandidates.length <= 80,
  "continent-scale fallback sampling stays small enough for the first spawn decision",
);
assert.equal(
  harness.getIndexCreateCalls(),
  0,
  "large maps must not allocate the exact map-wide candidate index",
);

const initialRetryGame = {
  __src: { _map: { terrain: new Uint8Array(128 * 128).fill(LAND) } },
  height: () => 128,
  width: () => 128,
};
const initialRetryFirst = harness.computeSpawnTopSpotsForBot(initialRetryGame, null, {
  initial: true,
});
const initialRetrySecond = harness.computeSpawnTopSpotsForBot(initialRetryGame, null, {
  initial: true,
});
assert.equal(
  initialRetrySecond,
  initialRetryFirst,
  "unchanged initial-spawn retries reuse the exact bounded ranking result",
);

const makePlayer = (type, x, y, id, { spawned = type === "HUMAN" } = {}) => ({
  type: () => type,
  isAlive: () => true,
  hasSpawned: () => spawned,
  nameLocation: () => ({ x, y }),
  smallID: () => id,
});
const fallbackMe = makePlayer("HUMAN", 0, 0, 99);
fallbackMe.isOnSameTeam = () => false;
const initialGeometryGame = {
  __src: { _map: { terrain: new Uint8Array(128 * 128).fill(LAND) } },
  height: () => 128,
  width: () => 128,
};
harness.setPlayers([fallbackMe]);
const initialGeometryFirst = harness.computeSpawnTopSpotsForBot(initialGeometryGame, fallbackMe, {
  initial: true,
});
harness.setPlayers([fallbackMe, makePlayer("HUMAN", 6, 6, 100)]);
const initialGeometryChanged = harness.computeSpawnTopSpotsForBot(initialGeometryGame, fallbackMe, {
  initial: true,
});
assert.notEqual(
  initialGeometryChanged,
  initialGeometryFirst,
  "a changed player geometry invalidates an initial-spawn retry ranking",
);
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

harness.setPlayers([fallbackMe, makePlayer("NATION", 100, 100, 7, { spawned: true })]);
const nationEnemyFallback = harness.computeDynamicScores(
  { width: () => 600, height: () => 300 },
  [
    { x: 100, y: 100, staticScore: 1, freeLandScore: 1 },
    { x: 400, y: 100, staticScore: 0.6, freeLandScore: 1 },
  ],
  fallbackMe,
);
assert.equal(
  nationEnemyFallback.topSpots[0].x,
  400,
  "the fallback must penalize a nearby enemy Nation as a strategic spawn threat",
);

const geometryMe = makePlayer("HUMAN", 0, 0, 98);
geometryMe.isOnSameTeam = (player) => [10, 11, 12].includes(player.smallID());
harness.setPlayers([
  geometryMe,
  makePlayer("NATION", 80, 80, 10, { spawned: true }),
  makePlayer("NATION", 180, 80, 11, { spawned: true }),
  makePlayer("NATION", 130, 180, 12, { spawned: true }),
]);
const geometryFallback = harness.computeDynamicScores(
  { width: () => 600, height: () => 300 },
  [
    { x: 130, y: 120, staticScore: 0.1, freeLandScore: 1 },
    { x: 500, y: 120, staticScore: 100, freeLandScore: 1 },
  ],
  geometryMe,
);
assert.equal(
  geometryFallback.topSpots[0].x,
  130,
  "the fast fallback rejects a richer position outside the Nation-team hull",
);
assert.equal(geometryFallback.scores.length, 1);

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

process.stdout.write("spawn-heatmap tests passed\n");
