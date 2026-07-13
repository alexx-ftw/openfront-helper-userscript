import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBJECTIVE_SOURCE = path.join(ROOT, "engine/ingame/spawn-objective.js");
const HEATMAP_SOURCE = path.join(ROOT, "engine/ingame/spawn-heatmap.js");
const LAND = 1 << 7;
function makePlayer(type, x, y, id, { displayName = null, spawned = false } = {}) {
  return {
    __src: displayName ? { static: { displayName } } : {},
    type: () => type,
    isAlive: () => true,
    nameLocation: () => ({ x, y }),
    smallID: () => id,
    clientID: () => `client-${id}`,
    hasSpawned: () => spawned,
    displayName: () => displayName,
  };
}

function loadScorer({ players, width, height, candidates, metrics = {}, me = null }) {
  const terrain = new Uint8Array(width * height).fill(LAND);
  const sandbox = {
    Array,
    JSON,
    Map,
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
    registerMapOverlayLayer() {},
    requestMapOverlayLoop() {},
    spawnHeatmapEnabled: false,
    spawnMarkersEnabled: false,
    setTimeout: () => 0,
    window: { innerHeight: 600, innerWidth: 800 },
    __OFHSpawnIndex: {
      FRONTIER_VALUE_SCALE: 1000,
      create() {
        return {
          ready: true,
          version: 0,
          forEachCandidate({ isCenterAllowed, onCandidate }) {
            for (const candidate of candidates) {
              if (!isCenterAllowed(candidate.ref, candidate.x, candidate.y)) continue;
              onCandidate(
                candidate.ref,
                candidate.x,
                candidate.y,
                metrics[candidate.ref]?.spawnGain ?? 100,
                metrics[candidate.ref]?.invalidCount ?? 0,
                metrics[candidate.ref]?.plainsGain ?? 100,
                metrics[candidate.ref]?.frontierGain ?? 10,
                metrics[candidate.ref]?.frontierPlainsGain ?? 10,
                metrics[candidate.ref]?.frontierValueGain ?? 10000,
                metrics[candidate.ref]?.frontierSlots ?? 10,
              );
            }
          },
        };
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(OBJECTIVE_SOURCE, "utf8"), sandbox, {
    filename: OBJECTIVE_SOURCE,
  });
  vm.runInNewContext(fs.readFileSync(HEATMAP_SOURCE, "utf8"), sandbox, {
    filename: HEATMAP_SOURCE,
  });

  const game = {
    __src: { _map: { terrain } },
    config: () => ({ minDistanceBetweenPlayers: () => 30 }),
    hasOwner: () => false,
    height: () => height,
    isBorder: () => false,
    width: () => width,
    x: (tile) => tile % width,
    y: (tile) => Math.floor(tile / width),
  };
  return sandbox.computeExactSpawnTopSpotsForBot(game, me);
}

const width = 600;
const height = 300;
const countCandidates = [
  { ref: 50 * width + 100, x: 100, y: 50 },
  { ref: 50 * width + 400, x: 400, y: 50 },
];
const tribeCount = loadScorer({
  width,
  height,
  candidates: countCandidates,
  players: [
    makePlayer("BOT", 100, 50, 1),
    makePlayer("BOT", 120, 50, 2),
    makePlayer("BOT", 140, 50, 3),
    makePlayer("BOT", 400, 50, 4),
  ],
});
assert.equal(tribeCount[0].x, 100, "the best spawn should reach the most tribes");
assert.equal(tribeCount[0].tribeReachCount, 3);
assert.equal(tribeCount[0].tribeReachScore, 0.75);
assert.equal(tribeCount[0].tribeReachRadius, 240);
assert.equal(tribeCount[0].freeLandScore, 1);

const slowRef = 50 * width + 100;
const fastRef = 50 * width + 300;
const speedSensitive = loadScorer({
  width,
  height,
  candidates: [
    { ref: slowRef, x: 100, y: 50 },
    { ref: fastRef, x: 300, y: 50 },
  ],
  metrics: {
    [slowRef]: { frontierGain: 0, frontierSlots: 0, frontierValueGain: 0 },
    [fastRef]: { frontierGain: 10, frontierSlots: 10, frontierValueGain: 10000 },
  },
  players: [makePlayer("BOT", 300, 50, 5)],
});
assert.equal(speedSensitive[0].x, 300, "faster free-land expansion must extend tribe reach");
assert.equal(speedSensitive[0].tribeReachCount, 1);
assert.equal(speedSensitive[0].freeLandScore, 1);

const closedFrontierRef = 50 * width + 100;
const openFrontierRef = 50 * width + 400;
const closedFrontierWithNearbyTribe = loadScorer({
  width,
  height,
  candidates: [
    { ref: closedFrontierRef, x: 100, y: 50 },
    { ref: openFrontierRef, x: 400, y: 50 },
  ],
  metrics: {
    [closedFrontierRef]: {
      frontierGain: 0,
      frontierSlots: 0,
      frontierValueGain: 0,
    },
    [openFrontierRef]: {
      frontierGain: 10,
      frontierSlots: 10,
      frontierValueGain: 10000,
    },
  },
  players: [makePlayer("BOT", 100, 50, 6)],
});
assert.equal(
  closedFrontierWithNearbyTribe[0].x,
  400,
  "nearby tribes must not rescue a spawn with no free continuation frontier",
);
assert.equal(closedFrontierWithNearbyTribe[0].freeLandScore, 1);

const clanOpenLandWidth = 600;
const clanOpenLandHeight = 300;
const clanOpenLandNearRef = 150 * clanOpenLandWidth + 149;
const clanOpenLandFarRef = 150 * clanOpenLandWidth + 450;
const me = makePlayer("HUMAN", 300, 150, 10, {
  displayName: "[FOX] Me",
});
me.isOnSameTeam = (player) => player.smallID() === 11 || player.smallID() === 12;
const clanOpenLand = loadScorer({
  width: clanOpenLandWidth,
  height: clanOpenLandHeight,
  candidates: [
    { ref: clanOpenLandNearRef, x: 149, y: 150 },
    { ref: clanOpenLandFarRef, x: 450, y: 150 },
  ],
  metrics: {
    [clanOpenLandNearRef]: {
      frontierGain: 0,
      frontierSlots: 10,
      frontierValueGain: 10000,
    },
    [clanOpenLandFarRef]: {
      frontierGain: 10,
      frontierSlots: 10,
      frontierValueGain: 10000,
    },
  },
  players: [
    me,
    makePlayer("HUMAN", 189, 150, 11, { displayName: "[FOX] Clan", spawned: true }),
    makePlayer("HUMAN", 410, 150, 12, { displayName: "[WOLF] Team", spawned: true }),
  ],
  me,
});
assert.equal(
  clanOpenLand[0].x,
  450,
  "open free land must outrank same-clan proximity when other spawn dimensions tie",
);
assert.equal(clanOpenLand[0].freeLandScore, 1);

const nationOnly = loadScorer({
  width,
  height,
  candidates: countCandidates,
  players: [makePlayer("NATION", 100, 50, 6)],
});
assert.equal(nationOnly[0].x, 100, "nation positions must affect exact tile scoring");
assert.equal(nationOnly[0].y, 50);
assert.equal(nationOnly[0].nationScore, 1);
assert.equal(nationOnly[0].resourceScore, 1);

console.log("spawn entity scoring tests passed");
