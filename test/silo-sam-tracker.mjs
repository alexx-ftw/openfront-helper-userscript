import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUKE_IMPACT_SOURCE = fs.readFileSync(path.join(ROOT, "engine/ingame/nuke-impact.js"), "utf8");
const TRACKER_SOURCE = fs.readFileSync(
  path.join(ROOT, "engine/ingame/silo-sam-tracker.js"),
  "utf8",
);

const sandbox = {
  console,
  document: {},
  window: {},
};
sandbox.globalThis = sandbox;
executeClassicScript(NUKE_IMPACT_SOURCE, sandbox, {
  filename: "nuke-impact.js",
});
executeClassicScript(
  `${TRACKER_SOURCE}\nglobalThis._autoFireBuiltSamInterceptionCapacity = _autoFireBuiltSamInterceptionCapacity;\nglobalThis._autoFireUncoveredEnemyBuildings = _autoFireUncoveredEnemyBuildings;\nglobalThis._scanNukesToTile = _scanNukesToTile;`,
  sandbox,
  {
    filename: "silo-sam-tracker.js",
  },
);

let trackerTick = 50;
let trackerNukeScans = 0;
const trackerOwner = { smallID: () => 1 };
const trackedNukes = [
  {
    owner: () => trackerOwner,
    targetTile: () => 100,
    tile: () => 90,
  },
];
const trackerPlayer = {
  smallID: () => 1,
  units: (type) => {
    trackerNukeScans += 1;
    return type === "Atom Bomb" ? trackedNukes : [];
  },
};
const trackerGame = { ticks: () => trackerTick };
const trackedAtom = sandbox._scanNukesToTile(trackerGame, trackerPlayer, 100);
assert.equal(trackedAtom?.count, 1, "the tracker indexes an in-flight atom by target tile");
assert.equal(trackedAtom?.etaSec, null, "an unavailable ETA remains explicitly unknown");
for (let tile = 101; tile < 301; tile += 1) {
  assert.equal(sandbox._scanNukesToTile(trackerGame, trackerPlayer, tile), null);
}
assert.equal(
  trackerNukeScans,
  2,
  "hundreds of tracker rows share one Atom/Hydrogen snapshot per game tick",
);
trackerTick += 1;
sandbox._scanNukesToTile(trackerGame, trackerPlayer, 100);
assert.equal(trackerNukeScans, 4, "the shared missile index refreshes when the game advances");

const coords = new Map([
  [1, { x: 0, y: 0 }],
  [2, { x: 29, y: 0 }],
  [3, { x: 29, y: 10 }],
  [4, { x: 100, y: 0 }],
]);
const distanceSquared = (a, b) => {
  const from = coords.get(a);
  const to = coords.get(b);
  return (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
};

const me = {
  smallID: () => 1,
  isAlliedWith: () => false,
  isFriendly: () => false,
  isOnSameTeam: () => false,
};
const enemy = {
  smallID: () => 2,
  isAlliedWith: () => false,
  isFriendly: () => false,
  isOnSameTeam: () => false,
};

const building = (id, type, tile) => ({
  id: () => id,
  type: () => type,
  owner: () => enemy,
  tile: () => tile,
  isActive: () => true,
  isUnderConstruction: () => id === "sam",
});

const buildings = [
  building("sam", "SAM Launcher", 1),
  building("silo", "Missile Silo", 2),
  building("city", "City", 3),
];

const game = {
  euclideanDistSquared: distanceSquared,
  config: () => ({
    nukeMagnitudes: (type) => ({
      outer: type === "Hydrogen Bomb" ? 100 : 30,
    }),
  }),
  units: (...types) => buildings.filter((unit) => types.includes(unit.type())),
};

assert.equal(
  sandbox._chooseAutoFireImpactTile(game, 1, me),
  2,
  "auto-fire should move the atom impact onto the nearby building cluster",
);

const collateralCoordinates = new Map([
  ["sam", { x: 0, y: 0 }],
  ["old-house", { x: 40, y: 0 }],
  ["old-factory", { x: 42, y: 0 }],
  ["south-city", { x: 0, y: 40 }],
]);
const collateralTile = (x, y) => `${x},${y}`;
const collateralPoint = (tile) => {
  if (collateralCoordinates.has(tile)) return collateralCoordinates.get(tile);
  const [x, y] = String(tile).split(",").map(Number);
  return { x, y };
};
const collateralGame = {
  ...game,
  x: (tile) => collateralPoint(tile).x,
  y: (tile) => collateralPoint(tile).y,
  ref: collateralTile,
  isValidCoord: () => true,
  euclideanDistSquared: (left, right) => {
    const from = collateralPoint(left);
    const to = collateralPoint(right);
    return (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
  },
};
const collateralBuildings = [
  { key: "sam", tile: "sam" },
  { key: "old-house", tile: "old-house" },
  { key: "old-factory", tile: "old-factory" },
  { key: "south-city", tile: "south-city" },
];
const alliedImpact = [{ targetTile: "old-house", radius: 30 }];
const uncoveredCollateral = sandbox._autoFireUncoveredEnemyBuildings(
  collateralGame,
  collateralBuildings,
  alliedImpact,
);
assert.deepEqual(
  uncoveredCollateral.map((entry) => entry.key),
  ["sam", "south-city"],
  "collateral scoring excludes buildings already doomed by an in-flight allied missile",
);
assert.deepEqual(
  sandbox
    ._autoFireUncoveredEnemyBuildings(
      collateralGame,
      collateralBuildings,
      [{ targetTile: "old-house", radius: 30, remainingTicks: 100 }],
      20,
    )
    .map((entry) => entry.key),
  ["sam", "old-house", "old-factory", "south-city"],
  "a slower allied missile does not hide collateral that our atom reaches first",
);
assert.deepEqual(
  sandbox
    ._autoFireUncoveredEnemyBuildings(
      collateralGame,
      collateralBuildings,
      [{ targetTile: "old-house", radius: 30, remainingTicks: 10 }],
      20,
    )
    .map((entry) => entry.key),
  ["sam", "south-city"],
  "an allied missile arriving first still removes its doomed collateral",
);
assert.equal(
  sandbox._isAutoFireTargetCovered(collateralGame, "sam", me, null, {
    impacts: [{ targetTile: "sam", radius: 30, remainingTicks: 100 }],
    ownFlightTicks: 20,
  }),
  false,
  "a late allied impact cannot suppress our faster shot at a newly placed SAM",
);
assert.equal(
  sandbox._isAutoFireTargetCovered(collateralGame, "sam", me, null, {
    impacts: [{ targetTile: "30,0", radius: 30, remainingTicks: 10 }],
    ownFlightTicks: 20,
  }),
  false,
  "a missile exactly on the blast edge does not suppress a shot at a surviving structure",
);
assert.equal(
  sandbox._chooseAutoFireImpactTile(collateralGame, "sam", me, uncoveredCollateral),
  "0,20",
  "auto-fire shifts the impact toward a different surviving city while still hitting the SAM",
);

const incomingAtom = {
  id: () => "incoming-atom",
  type: () => "Atom Bomb",
  owner: () => me,
  tile: () => 4,
  targetTile: () => 2,
  isActive: () => true,
};
const coveredGame = {
  ...game,
  units: (...types) => [...buildings, incomingAtom].filter((unit) => types.includes(unit.type())),
};

assert.equal(
  sandbox._isAutoFireTargetCovered(coveredGame, 1, me),
  true,
  "auto-fire should skip a target already inside an active missile blast",
);

const farGame = {
  ...game,
  units: (...types) =>
    [...buildings, { ...incomingAtom, targetTile: () => 4 }].filter((unit) =>
      types.includes(unit.type()),
    ),
};
assert.equal(
  sandbox._isAutoFireTargetCovered(farGame, 1, me),
  false,
  "auto-fire should remain eligible when the active missile lands outside the blast",
);

assert.equal(
  sandbox._isAutoFireTargetCovered(game, 1, me, {
    plannedImpacts: { existing: 2 },
  }),
  true,
  "a pending auto-fire impact should suppress a duplicate nearby shot",
);

const autoFireCalls = { recommend: [], fire: [] };
sandbox._quickPanelSettingsCache = {
  combatSamTracker: true,
  combatSamAutoFireBuilding: true,
  combatSamAutoFireMaxQty: 1,
};
sandbox._tr = (value) => value;
sandbox._playerLabel = () => "enemy";
sandbox._toast = () => {};
sandbox.window.__OFH_atomBatch = {
  estimateFlightTicks: () => 1,
  recommendQty: async (tile) => {
    autoFireCalls.recommend.push(tile);
    return { ok: true, recommended: 1 };
  },
  fireNow: async (tile, qty) => {
    autoFireCalls.fire.push({ tile, qty });
    return { fired: 1, qty };
  },
};

const targetSam = {
  id: () => "integration-sam",
  state: { id: "integration-sam", ownerID: 2, constructionStartTick: 0 },
  owner: () => enemy,
  tile: () => 1,
  isUnderConstruction: () => true,
};
const integrationGame = {
  ...game,
  ticks: () => 0,
  unitInfo: () => ({ constructionDuration: 300 }),
  smallIDToID: new Set([2]),
  myPlayer: () => me,
  units: (...types) => {
    if (types.includes("SAM Launcher")) return [targetSam];
    return buildings.filter((unit) => types.includes(unit.type()));
  },
};
sandbox._runSamAutoFireBuilding({ game: integrationGame });
sandbox._runSamAutoFireBuilding({ game: integrationGame });
await new Promise((resolve) => {
  setImmediate(resolve);
});
assert.deepEqual(
  autoFireCalls.recommend,
  [2],
  "auto-fire should recommend the adjusted cluster impact tile",
);
assert.deepEqual(
  autoFireCalls.fire,
  [{ tile: 2, qty: 1 }],
  "auto-fire should send the adjusted cluster impact tile to fireNow",
);

const coveredIntegrationGame = {
  ...integrationGame,
  units: (...types) => {
    if (types.includes("Atom Bomb")) return [incomingAtom];
    if (types.includes("SAM Launcher")) return [targetSam];
    return buildings.filter((unit) => types.includes(unit.type()));
  },
};
const callsBeforeCoveredTarget = autoFireCalls.recommend.length;
sandbox._runSamAutoFireBuilding({ game: coveredIntegrationGame });
sandbox._runSamAutoFireBuilding({ game: coveredIntegrationGame });
await new Promise((resolve) => {
  setImmediate(resolve);
});
assert.equal(
  autoFireCalls.recommend.length,
  callsBeforeCoveredTarget,
  "auto-fire should not launch when an active missile already covers the SAM",
);

const pathCoords = new Map([
  [10, { x: 0, y: 0 }],
  [15, { x: 50, y: 0 }],
  [20, { x: 100, y: 0 }],
]);
const pathDistanceSquared = (a, b) => {
  const from = pathCoords.get(a);
  const to = pathCoords.get(b);
  return (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
};
const ownSilo = {
  id: () => "own-silo",
  tile: () => 10,
  isUnderConstruction: () => false,
  isActive: () => true,
};
const builtSam = {
  id: () => "built-sam",
  tile: () => 15,
  level: () => 1,
  owner: () => enemy,
  isUnderConstruction: () => false,
  isActive: () => true,
};
const targetUnderConstructionSam = {
  id: () => "target-under-construction",
  tile: () => 20,
  level: () => 1,
  owner: () => enemy,
  isUnderConstruction: () => true,
  isActive: () => true,
};
const interceptionMe = { ...me, units: () => [ownSilo] };
const interceptionGame = {
  x: (tile) => pathCoords.get(tile).x,
  y: (tile) => pathCoords.get(tile).y,
  ref: (x) => {
    if (x < 25) return 10;
    return x < 75 ? 15 : 20;
  },
  width: () => 200,
  height: () => 200,
  ticks: () => 100,
  unitInfo: () => ({ constructionDuration: 300 }),
  manhattanDist: (a, b) => Math.abs(a - b),
  euclideanDistSquared: pathDistanceSquared,
  config: () => ({
    defaultNukeSpeed: () => 8,
    defaultSamMissileSpeed: () => 12,
    defaultNukeTargetableRange: () => 150,
    maxSamRange: () => 200,
    samRange: () => 70,
  }),
  units: (...types) => {
    if (types.includes("SAM Launcher")) {
      return [targetUnderConstructionSam, builtSam];
    }
    return [];
  },
};
assert.equal(
  sandbox._autoFireBuiltSamInterceptionCapacity(interceptionGame, interceptionMe, 20),
  1,
  "a built SAM along the nuke corridor must count as an interceptor",
);

const noBuiltSamGame = {
  ...interceptionGame,
  units: (...types) => (types.includes("SAM Launcher") ? [targetUnderConstructionSam] : []),
};
assert.equal(
  sandbox._autoFireBuiltSamInterceptionCapacity(noBuiltSamGame, interceptionMe, 20),
  0,
  "a SAM without enough construction time before the shot must not count as an interceptor",
);

const pendingReadySam = {
  ...builtSam,
  id: () => "pending-ready-sam",
  state: { constructionStartTick: -195 },
  isUnderConstruction: () => true,
  isActive: () => false,
};
const pendingReadyGame = {
  ...interceptionGame,
  units: (...types) => (types.includes("SAM Launcher") ? [pendingReadySam] : []),
};
assert.equal(
  sandbox._autoFireBuiltSamInterceptionCapacity(pendingReadyGame, interceptionMe, 20),
  1,
  "a pending SAM ready before the corridor interception must count",
);

const pendingLateSam = {
  ...pendingReadySam,
  id: () => "pending-late-sam",
  state: { constructionStartTick: 0 },
};
const pendingLateGame = {
  ...interceptionGame,
  units: (...types) => (types.includes("SAM Launcher") ? [pendingLateSam] : []),
};
assert.equal(
  sandbox._autoFireBuiltSamInterceptionCapacity(pendingLateGame, interceptionMe, 20),
  0,
  "a pending SAM ready after the missile passes must not count",
);

const interceptionIntegrationTarget = {
  ...targetUnderConstructionSam,
  id: () => "integration-interception-target",
  state: { id: "integration-interception-target", ownerID: 2, constructionStartTick: 0 },
};
const interceptionIntegrationGame = {
  ...interceptionGame,
  myPlayer: () => interceptionMe,
  units: (...types) => {
    if (types.includes("SAM Launcher")) {
      return [interceptionIntegrationTarget, builtSam];
    }
    return [];
  },
};
const callsBeforeBuiltSamGuard = autoFireCalls.recommend.length;
sandbox._quickPanelSettingsCache.combatSamAutoFireMaxQty = 1;
sandbox._runSamAutoFireBuilding({ game: interceptionIntegrationGame });
sandbox._runSamAutoFireBuilding({ game: interceptionIntegrationGame });
await new Promise((resolve) => {
  setImmediate(resolve);
});
assert.equal(
  autoFireCalls.recommend.length,
  callsBeforeBuiltSamGuard,
  "auto-fire must not spend a one-shot salvo into a built SAM's corridor",
);

const callsBeforeMinimumSalvoGuard = autoFireCalls.recommend.length;
sandbox._quickPanelSettingsCache.combatSamAutoFireMaxQty = 2;
const minimumSalvoState = { firedIds: {}, plannedImpacts: {} };
sandbox._autoFireAttempt(
  minimumSalvoState,
  "minimum-salvo-target",
  20,
  20,
  enemy,
  interceptionMe,
  2,
  "SAM",
  2,
);
await new Promise((resolve) => {
  setImmediate(resolve);
});
assert.equal(
  autoFireCalls.recommend.length,
  callsBeforeMinimumSalvoGuard + 1,
  "auto-fire may validate a larger salvo but must not fire an undersized recommendation",
);
assert.equal(autoFireCalls.fire.length, 1, "an undersized recommendation must not call fireNow");

process.stdout.write("silo/SAM auto-fire building tests passed\n");
