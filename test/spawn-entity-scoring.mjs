import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
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
  const metricValue = (candidateRef, key, fallback) => metrics[candidateRef]?.[key] ?? fallback;
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
    runtimeState: {
      spawnHeatmapEnabled: false,
      spawnMarkersEnabled: false,
    },
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
                metricValue(candidate.ref, "spawnGain", 100),
                metricValue(candidate.ref, "invalidCount", 0),
                metricValue(candidate.ref, "plainsGain", 100),
                metricValue(candidate.ref, "frontierGain", 10),
                metricValue(candidate.ref, "frontierPlainsGain", 10),
                metricValue(candidate.ref, "frontierValueGain", 10000),
                metricValue(candidate.ref, "frontierSlots", 10),
              );
            }
          },
        };
      },
    },
  };
  sandbox.globalThis = sandbox;
  executeClassicScript(fs.readFileSync(OBJECTIVE_SOURCE, "utf8"), sandbox, {
    filename: OBJECTIVE_SOURCE,
  });
  executeClassicScript(fs.readFileSync(HEATMAP_SOURCE, "utf8"), sandbox, {
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

const teamOpportunityWidth = 600;
const teamOpportunityHeight = 300;
const teamClusterRef = 150 * teamOpportunityWidth + 150;
const openTargetsRef = 150 * teamOpportunityWidth + 450;
const teamOpportunityMe = makePlayer("HUMAN", 300, 150, 20);
teamOpportunityMe.isOnSameTeam = (player) => player.smallID() === 21;
const teamOpportunity = loadScorer({
  width: teamOpportunityWidth,
  height: teamOpportunityHeight,
  candidates: [
    { ref: teamClusterRef, x: 150, y: 150 },
    { ref: openTargetsRef, x: 450, y: 150 },
  ],
  players: [
    teamOpportunityMe,
    makePlayer("HUMAN", 150, 110, 21, { spawned: true }),
    makePlayer("BOT", 450, 150, 22),
    makePlayer("BOT", 470, 150, 23),
  ],
  me: teamOpportunityMe,
});
assert.equal(
  teamOpportunity[0].x,
  150,
  "a reachable allied position must outrank an isolated tribe-rich frontier",
);
assert.equal(teamOpportunity[0].teamPolyhedronScore, 0);

const enclosedMe = makePlayer("HUMAN", 300, 150, 30);
enclosedMe.isOnSameTeam = (player) => [31, 32, 33].includes(player.smallID());
const enclosedWidth = 600;
const enclosed = loadScorer({
  width: enclosedWidth,
  height: 300,
  candidates: [
    { ref: 150 * enclosedWidth + 300, x: 300, y: 150 },
    { ref: 150 * enclosedWidth + 500, x: 500, y: 150 },
  ],
  metrics: {
    [150 * enclosedWidth + 300]: { frontierGain: 30, frontierSlots: 30, frontierValueGain: 30000 },
    [150 * enclosedWidth + 500]: {
      frontierGain: 100,
      frontierSlots: 100,
      frontierValueGain: 100000,
    },
  },
  players: [
    enclosedMe,
    makePlayer("HUMAN", 200, 80, 31, { spawned: true }),
    makePlayer("HUMAN", 400, 80, 32, { spawned: true }),
    makePlayer("HUMAN", 300, 240, 33, { spawned: true }),
    makePlayer("BOT", 300, 150, 34),
    makePlayer("BOT", 500, 150, 35),
    makePlayer("BOT", 520, 150, 36),
  ],
  me: enclosedMe,
});
assert.equal(enclosed[0].x, 300, "spawn candidates outside the team polyhedron must be rejected");
assert.equal(enclosed[0].teamPolyhedronScore, 1);

const nationTeamMe = makePlayer("HUMAN", 300, 150, 40);
nationTeamMe.isOnSameTeam = (player) => [41, 42, 43].includes(player.smallID());
const nationTeamGeometry = loadScorer({
  width: enclosedWidth,
  height: 300,
  candidates: [
    { ref: 150 * enclosedWidth + 300, x: 300, y: 150 },
    { ref: 150 * enclosedWidth + 500, x: 500, y: 150 },
  ],
  players: [
    nationTeamMe,
    makePlayer("NATION", 200, 80, 41, { spawned: true }),
    makePlayer("NATION", 400, 80, 42, { spawned: true }),
    makePlayer("NATION", 300, 240, 43, { spawned: true }),
  ],
  me: nationTeamMe,
});
assert.equal(
  nationTeamGeometry[0].x,
  300,
  "spawn geometry includes already-spawned Nation teammates instead of placing us outside their hull",
);
assert.equal(nationTeamGeometry[0].teamPolyhedronScore, 1);

const diverseWidth = 600;
const diverse = loadScorer({
  width: diverseWidth,
  height: 300,
  candidates: [100, 110, 120, 200, 300, 400].map((x) => ({
    ref: 150 * diverseWidth + x,
    x,
    y: 150,
  })),
  players: [],
});
assert.equal(diverse[0].x, 300, "diversity filtering must preserve the best exact tile");
for (let left = 0; left < diverse.length; left += 1) {
  for (let right = left + 1; right < diverse.length; right += 1) {
    const distance =
      Math.abs(diverse[left].x - diverse[right].x) + Math.abs(diverse[left].y - diverse[right].y);
    assert.ok(distance >= 60, "exact fallback spots must represent distinct map areas");
  }
}

process.stdout.write("spawn entity scoring tests passed\n");
