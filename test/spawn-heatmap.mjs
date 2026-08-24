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
  let timeoutCalls = 0;
  let exactCandidates = [];
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
    setTimeout: () => {
      timeoutCalls += 1;
      return timeoutCalls;
    },
    window: { innerHeight: 600, innerWidth: 800 },
    __OFHSpawnIndex: {
      create() {
        indexCreateCalls += 1;
        if (exactIndexMode) {
          const index = {
            landComponentsReady: true,
            ready: true,
            size: 64,
            width: 8,
            height: 8,
            version: 0,
            buildSlice() {
              this.landComponentsReady = true;
              this.version += 1;
              return { done: true, processed: 0, landProcessed: 1 };
            },
            syncTerrain() {
              this.landComponentsReady = false;
              this.version += 1;
              return 1;
            },
            forEachCandidateRange(options = {}) {
              exactRangeCalls += 1;
              for (const candidate of exactCandidates) {
                if (
                  options.isCenterAllowed &&
                  !options.isCenterAllowed(candidate.ref, candidate.x, candidate.y)
                )
                  continue;
                options.onCandidate(
                  candidate.ref,
                  candidate.x,
                  candidate.y,
                  candidate.spawnGain,
                  candidate.invalidCount,
                  candidate.plainsGain,
                  candidate.frontierGain,
                  candidate.frontierPlainsGain,
                  candidate.frontierValueGain,
                  candidate.frontierSlots,
                );
              }
            },
          };
          index.forEachCandidate = (options) => index.forEachCandidateRange(options);
          return index;
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
    computeStaticCandidatesWithBudget: sandbox.computeStaticCandidatesWithBudget,
    computeDynamicScores: sandbox.computeDynamicScores,
    filterTeamSpawnGeometryOutliers: sandbox.filterTeamSpawnGeometryOutliers,
    buildTeamSpawnRegion: sandbox.buildTeamSpawnRegion,
    isPointInsideTeamSpawnRegion: sandbox.isPointInsideTeamSpawnRegion,
    game,
    getIndexCreateCalls: () => indexCreateCalls,
    getTimeoutCalls: () => timeoutCalls,
    getTopSpots: sandbox.getSpawnHeatmapTopSpots,
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
    setExactCandidates: (value) => {
      exactCandidates = value;
    },
    getExactRangeCalls: () => exactRangeCalls,
    getSpawnBlockedSnapshot: sandbox.getSpawnBlockedSnapshot,
    refreshSpawnCandidateTerrain: sandbox.__OFHRefreshSpawnCandidateTerrain,
    resetExactRangeCalls: () => {
      exactRangeCalls = 0;
    },
  };
}

const harness = loadHarness();
assert.equal(
  JSON.stringify(
    harness
      .filterTeamSpawnGeometryOutliers([
        { x: 100, y: 100 },
        { x: 130, y: 100 },
        { x: 115, y: 125 },
        { x: 700, y: 700 },
      ])
      .map((point) => [point.x, point.y]),
  ),
  JSON.stringify([
    [100, 100],
    [130, 100],
    [115, 125],
  ]),
  "a spatially isolated teammate must not distort the team geometry",
);
assert.equal(
  JSON.stringify(
    harness
      .filterTeamSpawnGeometryOutliers([
        { x: 100, y: 100 },
        { x: 500, y: 100 },
      ])
      .map((point) => [point.x, point.y]),
  ),
  JSON.stringify([
    [100, 100],
    [500, 100],
  ]),
  "two anchors remain an ambiguous but valid team corridor",
);
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
let localPlayerHasSpawned = false;
const visibleSpawnGame = {
  __src: { _map: { terrain: new Uint8Array(64 * 64).fill(LAND) } },
  height: () => 64,
  inSpawnPhase: () => true,
  myPlayer: () => ({ hasSpawned: () => localPlayerHasSpawned }),
  width: () => 64,
};
harness.layer.scan(visibleSpawnGame);
assert.ok(harness.getTopSpots()?.length > 0, "spawn markers have visible data before spawning");

localPlayerHasSpawned = true;
harness.layer.scan(visibleSpawnGame);
assert.equal(
  harness.getTopSpots(),
  null,
  "spawn markers disappear once the local player has spawned even while the lobby phase remains open",
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
  "fallback safety ranking remains deterministic while tribe connectivity is pending",
);
assert.equal(fallback.topSpots[0].y, 100);
assert.equal(
  fallback.scores[0].tribeReachCount,
  3,
  "without an exact connectivity index the geometric tribe count carries the resource dimension instead of failing closed",
);
assert.equal(fallback.scores[0].tribeGeometricReachCount, 3);
assert.equal(fallback.scores[0].objective.safetyScore, 1);
const fallbackEmptySide = fallback.scores.find((candidate) => candidate.x === 100);
assert.equal(
  fallbackEmptySide.objective.resourceScore,
  0.45,
  "the fallback objective lets free land substitute for absent tribes in the resource floor",
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
assert.equal(
  geometryFallback.topSpots[0].objective.teamPolyhedronScore,
  1,
  "the fallback objective recognizes candidates inside a real team polyhedron",
);
assert.ok(
  geometryFallback.topSpots[0].objective.teamInteriorScore > 0,
  "the fallback objective retains interior depth for team-position ranking",
);

const regionTerrain = new Uint8Array(600 * 300).fill(LAND);
const regionGame = {
  __src: { _map: { terrain: regionTerrain } },
  height: () => 300,
  width: () => 600,
};
const teamRegion = harness.buildTeamSpawnRegion([
  { x: 80, y: 80 },
  { x: 180, y: 80 },
  { x: 130, y: 180 },
]);
const corridorRegion = harness.buildTeamSpawnRegion([
  { x: 100, y: 100 },
  { x: 500, y: 100 },
]);
assert.equal(
  harness.isPointInsideTeamSpawnRegion(100, 100, corridorRegion),
  false,
  "a two-ally corridor must not treat an ally endpoint as a team-interior spawn",
);
assert.equal(
  harness.isPointInsideTeamSpawnRegion(111, 100, corridorRegion),
  false,
  "a two-ally corridor keeps the same inset from its endpoint as a hull keeps from its edge",
);
assert.equal(
  harness.isPointInsideTeamSpawnRegion(300, 100, corridorRegion),
  true,
  "a two-ally corridor retains its central interior for legal spawns",
);
const globalBudget = harness.computeStaticCandidatesWithBudget(regionGame, 64);
const globalInside = globalBudget.filter((candidate) =>
  harness.isPointInsideTeamSpawnRegion(candidate.x, candidate.y, teamRegion),
);
const regionBudget = harness.computeStaticCandidatesWithBudget(regionGame, 64, teamRegion);
assert.ok(
  regionBudget.length > globalInside.length,
  "the initial budget is spent inside team geometry instead of being discarded by a later filter",
);
assert.ok(
  regionBudget.every((candidate) =>
    harness.isPointInsideTeamSpawnRegion(candidate.x, candidate.y, teamRegion),
  ),
  "geometry-focused sampling never creates an exterior candidate",
);
assert.ok(
  Number.isFinite(geometryFallback.topSpots[0].score),
  "top spawn spots preserve their score breakdown for headless diagnostics",
);

const rectangularTeamArea = { x: 150, y: 150, width: 140, height: 140 };
const exactTeamGame = {
  __src: {
    _map: { terrain: new Uint8Array(400 * 400).fill(LAND) },
    teamSpawnArea: (team) => (team === 7 ? rectangularTeamArea : null),
  },
  config: () => ({ minDistanceBetweenPlayers: () => 30 }),
  height: () => 400,
  width: () => 400,
};
const exactTeamMe = {
  smallID: () => 99,
  team: () => 7,
  type: () => "HUMAN",
};
harness.enableExactIndex();
harness.setExactCandidates([
  { ref: 1, x: 180, y: 180, spawnGain: 1, invalidCount: 900 },
  { ref: 2, x: 260, y: 180, spawnGain: 1, invalidCount: 900 },
  { ref: 3, x: 180, y: 260, spawnGain: 1, invalidCount: 900 },
  { ref: 4, x: 260, y: 260, spawnGain: 1, invalidCount: 900 },
  { ref: 5, x: 80, y: 80, spawnGain: 900, invalidCount: 0 },
  { ref: 6, x: 320, y: 80, spawnGain: 900, invalidCount: 0 },
  { ref: 7, x: 80, y: 320, spawnGain: 900, invalidCount: 0 },
  { ref: 8, x: 320, y: 320, spawnGain: 900, invalidCount: 0 },
]);
const exactTeamAlternatives = harness.computeExactSpawnTopSpotsForBot(exactTeamGame, exactTeamMe);
assert.ok(exactTeamAlternatives.length > 1, "exact ranking returns multiple alternatives");
assert.ok(
  exactTeamAlternatives.every(
    (candidate) =>
      candidate.x >= rectangularTeamArea.x &&
      candidate.x < rectangularTeamArea.x + rectangularTeamArea.width &&
      candidate.y >= rectangularTeamArea.y &&
      candidate.y < rectangularTeamArea.y + rectangularTeamArea.height,
  ),
  "exact-ranked alternatives remain inside the configured rectangular team area",
);
const timersBeforeTopologyRefresh = harness.getTimeoutCalls();
assert.equal(harness.refreshSpawnCandidateTerrain(exactTeamGame, [0]), 1);
assert.equal(
  harness.getTimeoutCalls(),
  timersBeforeTopologyRefresh + 1,
  "terrain invalidation must reschedule cooperative connectivity construction",
);

// Explicit map team areas are authoritative even when teammate anchors form
// a hull in another disconnected spawn box (the More Than Luck 5-team case).
const disjointTeamArea = { x: 150, y: 150, width: 140, height: 140 };
const disjointHull = harness.buildTeamSpawnRegion([
  { x: 20, y: 20 },
  { x: 380, y: 20 },
  { x: 380, y: 380 },
  { x: 20, y: 380 },
]);
const areaOnlyCandidates = harness.computeStaticCandidatesWithBudget(
  exactTeamGame,
  64,
  null,
  disjointTeamArea,
);
assert.ok(
  areaOnlyCandidates.length > 0,
  "an explicit team area still has legal candidates without the unrelated teammate hull",
);
assert.ok(
  areaOnlyCandidates.every(
    (candidate) =>
      candidate.x >= disjointTeamArea.x &&
      candidate.x < disjointTeamArea.x + disjointTeamArea.width &&
      candidate.y >= disjointTeamArea.y &&
      candidate.y < disjointTeamArea.y + disjointTeamArea.height,
  ),
  "explicit-area candidates remain inside the assigned rectangle",
);
assert.ok(
  !harness.isPointInsideTeamSpawnRegion(200, 200, disjointHull) || areaOnlyCandidates.length > 0,
  "a disjoint teammate hull cannot suppress an explicit-area spawn",
);

// Exact-ranking enemy strength weighting: two metrically identical candidates
// sit symmetrically between two spawned enemies. Without a live army on
// either enemy the tie resolves by ref order; once one rival has grown a real
// army, its proximity must press proportionally harder and flip the ranking
// away from it. The weight also participates in the exact-result signature,
// so the grown-rival ranking cannot be served from the stale cache.
{
  const weightingMe = makePlayer("HUMAN", 32, 32, 98);
  weightingMe.isOnSameTeam = () => false;
  const weakEnemyNearLeft = makePlayer("HUMAN", 9, 62, 21);
  const enemyNearRight = makePlayer("HUMAN", 54, 62, 22);
  const weightingGame = {
    __src: { _map: { terrain: new Uint8Array(64 * 64).fill(LAND) } },
    config: () => ({ minDistanceBetweenPlayers: () => 30 }),
    height: () => 64,
    inSpawnPhase: () => true,
    width: () => 64,
  };
  const candidateMetrics = (ref, x, y) => ({
    ref,
    x,
    y,
    spawnGain: 500,
    invalidCount: 0,
    plainsGain: 400,
    frontierGain: 60,
    frontierPlainsGain: 40,
    frontierValueGain: 5000,
    frontierSlots: 10,
  });
  // Left candidate carries the higher ref so the unweighted symmetric tie
  // resolves toward the right one by ref order.
  harness.enableExactIndex();
  harness.setExactCandidates([candidateMetrics(301, 9, 32), candidateMetrics(300, 54, 32)]);
  harness.setPlayers([weightingMe, weakEnemyNearLeft, enemyNearRight]);
  const unweighted = harness.computeExactSpawnTopSpotsForBot(weightingGame, weightingMe);
  assert.equal(
    unweighted?.[0]?.ref,
    300,
    "equal-strength enemies leave the symmetric tie to ref order",
  );
  const strongEnemyNearRight = makePlayer("HUMAN", 54, 62, 22);
  strongEnemyNearRight.troops = () => 40_000;
  harness.setPlayers([weightingMe, weakEnemyNearLeft, strongEnemyNearRight]);
  const weighted = harness.computeExactSpawnTopSpotsForBot(weightingGame, weightingMe);
  assert.equal(
    weighted?.[0]?.ref,
    301,
    "a grown enemy army presses harder on spawn safety and flips the ranking away from it",
  );
  assert.ok(
    weighted?.[0]?.objective?.safetyScore !== undefined,
    "the weighted safety feeds the shared objective contract unchanged",
  );
}

const initialTeamHarness = loadHarness();
const cornerTeamArea = { x: 30, y: 30, width: 90, height: 90 };
const initialTeamGame = {
  __src: {
    _map: { terrain: new Uint8Array(400 * 400).fill(LAND) },
    teamSpawnArea: (team) => (team === 7 ? cornerTeamArea : null),
  },
  config: () => ({ minDistanceBetweenPlayers: () => 30 }),
  height: () => 400,
  width: () => 400,
};
const initialTeamSpots = initialTeamHarness.computeSpawnTopSpotsForBot(
  initialTeamGame,
  exactTeamMe,
  { initial: true },
);
assert.ok(initialTeamSpots?.length > 0, "initial team ranking returns bounded alternatives");
assert.ok(
  initialTeamSpots.every(
    (candidate) =>
      candidate.x >= cornerTeamArea.x &&
      candidate.x < cornerTeamArea.x + cornerTeamArea.width &&
      candidate.y >= cornerTeamArea.y &&
      candidate.y < cornerTeamArea.y + cornerTeamArea.height,
  ),
  "initial bounded ranking spends its candidate budget inside the engine-assigned team area",
);

const relocationHarness = loadHarness();
const relocationMe = { smallID: () => 7 };
const relocationState = new Uint16Array(64);
relocationState[18] = 7;
relocationState[19] = 8;
const relocationGame = {
  __src: { _map: { state: relocationState, terrain: new Uint8Array(64).fill(LAND) } },
  config: () => ({ minDistanceBetweenPlayers: () => 0 }),
  hasOwner: (tile) => relocationState[tile] !== 0,
  height: () => 8,
  myPlayer: () => relocationMe,
  ownerID: (tile) => relocationState[tile],
  width: () => 8,
};
assert.deepEqual(
  Array.from(relocationHarness.getSpawnBlockedSnapshot(relocationGame, 64).slice(18, 20)),
  [0, 1],
  "exact spawn occupancy keeps self-owned relocation tiles available while blocking enemies",
);
relocationHarness.enableExactIndex();
relocationHarness.setExactCandidates([
  {
    ref: 18,
    x: 2,
    y: 2,
    spawnGain: 100,
    invalidCount: 0,
    plainsGain: 100,
    frontierGain: 20,
    frontierPlainsGain: 20,
    frontierValueGain: 20000,
    frontierSlots: 20,
  },
]);
assert.equal(
  relocationHarness.computeExactSpawnTopSpotsForBot(relocationGame, relocationMe)?.[0]?.ref,
  18,
  "exact ranking may select a self-owned center that SpawnExecution can relocate onto",
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
harness.resetExactRangeCalls();
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
