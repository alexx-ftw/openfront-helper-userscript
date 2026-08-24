import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBJECTIVE_SOURCE = path.join(ROOT, "engine/ingame/spawn-objective.js");
const HEATMAP_SOURCE = path.join(ROOT, "engine/ingame/spawn-heatmap.js");
const LAND = 1 << 7;
function makePlayer(type, x, y, id, { displayName = null, spawned = false, team = null } = {}) {
  return {
    __src: displayName ? { static: { displayName } } : {},
    type: () => type,
    isAlive: () => true,
    nameLocation: () => ({ x, y }),
    smallID: () => id,
    clientID: () => `client-${id}`,
    hasSpawned: () => spawned,
    displayName: () => displayName,
    team: () => team,
  };
}

function loadScorer({
  players,
  width,
  height,
  candidates,
  metrics = {},
  me = null,
  landComponents = null,
  landComponentsReady = true,
  terrain = null,
}) {
  const mapTerrain = terrain ?? new Uint8Array(width * height).fill(LAND);
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
          landComponentsReady,
          ready: true,
          version: 0,
          landComponentAt(candidateRef) {
            return landComponents?.[candidateRef] ?? (landComponentsReady ? 1 : 0);
          },
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
    __src: { _map: { terrain: mapTerrain } },
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

const connectedWidth = 100;
const connectedCandidate = { ref: 10 * connectedWidth + 10, x: 10, y: 10 };
const connectedTribe = makePlayer("BOT", 15, 10, 91);
const crossWaterTribe = makePlayer("BOT", 20, 10, 92);
const connectedComponents = {
  [connectedCandidate.ref]: 1,
  [10 * connectedWidth + 15]: 1,
  [10 * connectedWidth + 20]: 2,
};
const componentFiltered = loadScorer({
  width: connectedWidth,
  height: 30,
  candidates: [connectedCandidate],
  players: [connectedTribe, crossWaterTribe],
  landComponents: connectedComponents,
  landComponentsReady: true,
});
assert.equal(componentFiltered[0].tribeReachCount, 1);
assert.equal(
  componentFiltered[0].tribeGeometricReachCount,
  2,
  "diagnostics retain the nearby tribe excluded by land connectivity",
);
assert.equal(componentFiltered[0].landConnectivityReady, true);

const geometricFallback = loadScorer({
  width: connectedWidth,
  height: 30,
  candidates: [connectedCandidate],
  players: [connectedTribe, crossWaterTribe],
  landComponents: connectedComponents,
  landComponentsReady: false,
});
assert.equal(
  geometricFallback[0].tribeReachCount,
  0,
  "pending connectivity must not reward tribes that may be separated by water",
);
assert.equal(geometricFallback[0].tribeGeometricReachCount, 2);
assert.equal(geometricFallback[0].tribeReachScore, 0);
assert.equal(geometricFallback[0].landConnectivityReady, false);
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
const clanOpenLandNearRef = 150 * clanOpenLandWidth + 240;
const clanOpenLandFarRef = 150 * clanOpenLandWidth + 360;
const me = makePlayer("HUMAN", 300, 150, 10, {
  displayName: "[FOX] Me",
});
me.isOnSameTeam = (player) => player.smallID() === 11 || player.smallID() === 12;
const clanOpenLand = loadScorer({
  width: clanOpenLandWidth,
  height: clanOpenLandHeight,
  candidates: [
    { ref: clanOpenLandNearRef, x: 240, y: 150 },
    { ref: clanOpenLandFarRef, x: 360, y: 150 },
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
  360,
  "open free land must outrank same-clan proximity within the team corridor",
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

const relationLagMe = makePlayer("HUMAN", 300, 150, 50, { team: "Green" });
// The spawn-phase relation view is temporarily stale even though the lobby's
// team ids are already authoritative.
relationLagMe.isOnSameTeam = () => false;
const relationLagGeometry = loadScorer({
  width: enclosedWidth,
  height: 300,
  candidates: [
    { ref: 150 * enclosedWidth + 300, x: 300, y: 150 },
    { ref: 150 * enclosedWidth + 500, x: 500, y: 150 },
  ],
  metrics: {
    [150 * enclosedWidth + 300]: { frontierGain: 20, frontierSlots: 20, frontierValueGain: 20000 },
    [150 * enclosedWidth + 500]: {
      frontierGain: 100,
      frontierSlots: 100,
      frontierValueGain: 100000,
    },
  },
  players: [
    relationLagMe,
    makePlayer("HUMAN", 200, 80, 51, { spawned: true, team: "Green" }),
    makePlayer("HUMAN", 400, 80, 52, { spawned: true, team: "Green" }),
    makePlayer("HUMAN", 300, 240, 53, { spawned: true, team: "Green" }),
  ],
  me: relationLagMe,
});
assert.equal(
  relationLagGeometry[0].x,
  300,
  "stable team ids keep the spawn inside the own-team hull while relations are delayed",
);
assert.equal(relationLagGeometry[0].teamPolyhedronScore, 1);

const pairedTeamMe = makePlayer("HUMAN", 300, 150, 36);
pairedTeamMe.isOnSameTeam = (player) => [37, 38].includes(player.smallID());
const pairedTeamGeometry = loadScorer({
  width: enclosedWidth,
  height: 300,
  candidates: [
    { ref: 180 * enclosedWidth + 300, x: 300, y: 180 },
    { ref: 150 * enclosedWidth + 520, x: 520, y: 150 },
  ],
  metrics: {
    [180 * enclosedWidth + 300]: { frontierGain: 1, frontierSlots: 1, frontierValueGain: 1000 },
    [150 * enclosedWidth + 520]: {
      frontierGain: 100,
      frontierSlots: 100,
      frontierValueGain: 100000,
    },
  },
  players: [
    pairedTeamMe,
    makePlayer("HUMAN", 160, 150, 37, { spawned: true }),
    makePlayer("HUMAN", 440, 150, 38, { spawned: true }),
  ],
  me: pairedTeamMe,
});
assert.equal(
  pairedTeamGeometry[0].x,
  300,
  "two teammate anchors must constrain spawning to their map-independent corridor",
);

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

const nationEnemySafetyMe = makePlayer("HUMAN", 300, 150, 44);
nationEnemySafetyMe.isOnSameTeam = (player) => [45, 46, 47].includes(player.smallID());
const nationEnemySafety = loadScorer({
  width: enclosedWidth,
  height: 300,
  candidates: [
    { ref: 150 * enclosedWidth + 260, x: 260, y: 150 },
    { ref: 150 * enclosedWidth + 340, x: 340, y: 150 },
  ],
  metrics: {
    [150 * enclosedWidth + 260]: { frontierGain: 50, frontierSlots: 50, frontierValueGain: 50000 },
    [150 * enclosedWidth + 340]: { frontierGain: 50, frontierSlots: 50, frontierValueGain: 50000 },
  },
  players: [
    nationEnemySafetyMe,
    makePlayer("NATION", 180, 70, 45, { spawned: true }),
    makePlayer("NATION", 420, 70, 46, { spawned: true }),
    makePlayer("NATION", 300, 240, 47, { spawned: true }),
    makePlayer("NATION", 260, 145, 48, { spawned: true }),
  ],
  me: nationEnemySafetyMe,
});
assert.equal(
  nationEnemySafety[0].x,
  340,
  "an enemy Nation near an otherwise team-safe candidate must penalize its spawn safety",
);

// Terra nullius must substitute for tribes in the resource floor: the tribe
// sits inside the crowded, surrounded candidate, yet the empty expansible
// region has to win the exact ranking.
const terraNulliusWidth = 600;
const terraNulliusMe = makePlayer("HUMAN", 300, 150, 60);
terraNulliusMe.isOnSameTeam = () => false;
const crowdedRef = 150 * terraNulliusWidth + 150;
const emptyRef = 150 * terraNulliusWidth + 450;
const terraNullius = loadScorer({
  width: terraNulliusWidth,
  height: 300,
  candidates: [
    { ref: crowdedRef, x: 150, y: 150 },
    { ref: emptyRef, x: 450, y: 150 },
  ],
  metrics: {
    [crowdedRef]: {
      spawnGain: 100,
      invalidCount: 900,
      frontierGain: 0,
      frontierSlots: 0,
      frontierValueGain: 0,
    },
  },
  players: [terraNulliusMe, makePlayer("BOT", 150, 150, 61)],
  me: terraNulliusMe,
});
assert.equal(
  terraNullius[0].x,
  450,
  "an empty expansible region must outrank a tribe-rich surrounded interior",
);
assert.equal(
  terraNullius[0].objective.resourceScore,
  0.45,
  "free land remains a fallback resource floor below reachable tribe richness",
);

// Nation avoidance holds a 30% share of the combined entity score. The two
// candidates share identical tribal opportunity (one equidistant tribe), so
// only the nation blend separates their resource scores.
const nationBlendWidth = 600;
const nationBlendMe = makePlayer("HUMAN", 300, 150, 70);
nationBlendMe.isOnSameTeam = () => false;
const nearNationRef = 150 * nationBlendWidth + 150;
const farNationRef = 150 * nationBlendWidth + 450;
const nationBlend = loadScorer({
  width: nationBlendWidth,
  height: 300,
  candidates: [
    { ref: nearNationRef, x: 150, y: 150 },
    { ref: farNationRef, x: 450, y: 150 },
  ],
  players: [nationBlendMe, makePlayer("BOT", 300, 150, 71), makePlayer("NATION", 150, 180, 72)],
  me: nationBlendMe,
});
const nearNation = nationBlend.find((candidate) => candidate.x === 150);
const farNation = nationBlend.find((candidate) => candidate.x === 450);
assert.equal(
  nearNation.resourceScore,
  0.85 * 0.7 + 0.75 * 0.3,
  "nation proximity contributes a full 30% of the tribe-target blend",
);
assert.equal(
  farNation.resourceScore,
  0.85 * 0.7,
  "an identical tribal opportunity far from the nation capital keeps only the 70% tribe share",
);

// Coastal access: candidates share identical metrics and map-edge symmetry,
// so their exact scores differ only by the SPAWN_W-scaled coastal term. The
// water columns put the second candidate's bounded radius-10 sample at ~32%
// water, while the open-ocean disk past 45% earns nothing.
const coastalWidth = 600;
const coastalTerrain = new Uint8Array(coastalWidth * 300).fill(LAND);
for (let y = 0; y < 300; y += 1) {
  for (let x = 353; x <= 359; x += 1) coastalTerrain[y * coastalWidth + x] = 0;
}
for (let y = 140; y <= 160; y += 1) {
  for (let x = 440; x <= 460; x += 1) {
    if (x !== 450 || y !== 150) coastalTerrain[y * coastalWidth + x] = 0;
  }
}
const coastal = loadScorer({
  width: coastalWidth,
  height: 300,
  candidates: [
    { ref: 150 * coastalWidth + 250, x: 250, y: 150 },
    { ref: 150 * coastalWidth + 349, x: 349, y: 150 },
    { ref: 150 * coastalWidth + 450, x: 450, y: 150 },
  ],
  terrain: coastalTerrain,
  players: [],
});
const landlocked = coastal.find((candidate) => candidate.x === 250);
const sheltered = coastal.find((candidate) => candidate.x === 349);
const openOcean = coastal.find((candidate) => candidate.x === 450);
assert.equal(landlocked.coastalScore, 0, "a purely landlocked candidate earns no coastal bonus");
assert.ok(sheltered.coastalScore > 0.8, "a ~30% water share earns close to the full coastal bonus");
assert.equal(
  openOcean.coastalScore,
  0,
  "an open-ocean water share beyond the 45% band edge earns no coastal bonus",
);
assert.ok(
  Math.abs(sheltered.score - landlocked.score - sheltered.coastalScore * 0.1) < 1e-9,
  "the coastal term adds exactly its SPAWN_W-scaled weight to the exact score",
);

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
