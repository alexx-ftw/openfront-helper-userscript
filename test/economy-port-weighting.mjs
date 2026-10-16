import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const UNIT = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  TradeShip: "TradeShip",
  SAMLauncher: "SAM Launcher",
  MissileSilo: "Missile Silo",
  DefensePost: "Defense Post",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
  MIRV: "MIRV",
  MIRVWarhead: "MIRV Warhead",
};
const sandbox = {
  Difficulty: {
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
    Legendary: "Legendary",
  },
  GameMode: { Team: "Team" },
  UNIT,
  currentDifficulty: () => "Legendary",
  isLegendaryDifficulty: () => true,
  isAtLeastHardDifficulty: () => true,
  state: { settings: { winFixes: true } },
  withTimeout: async (promise) => promise,
  WORKER_TIMEOUT_MS: 1,
  globalThis: null,
};
sandbox.globalThis = sandbox;
executeClassicScript(
  `${readRepositoryFile("engine/ingame/auto-bot/legendaryPlanner.js")}\n` +
    `${readRepositoryFile("engine/ingame/auto-bot/structureBehavior.js")}\n` +
    "globalThis.StructureBehavior = StructureBehavior;",
  sandbox,
  { filename: "economy-port-weighting.mjs" },
);

const embargoedIds = new Set([900]);
const teamIds = new Set([12]);
const allyIds = new Set([11]);
const oceanTiles = new Set([0]);
for (let tile = 50; tile <= 250; tile += 10) oceanTiles.add(tile);

function makePort(tile, level = 1, { complete = true } = {}) {
  return {
    type: () => UNIT.Port,
    tile: () => tile,
    level: () => level,
    isActive: () => complete,
    isUnderConstruction: () => !complete,
  };
}

function makeOwner(id, ports = []) {
  return {
    id: () => id,
    smallID: () => id,
    isPlayer: () => true,
    isAlive: () => true,
    type: () => "Human",
    hasEmbargoAgainst: (other) => embargoedIds.has(other.id()),
    units: (...types) => (types.includes(UNIT.Port) ? ports : []),
  };
}

const player = makeOwner(1);
player.hasEmbargoAgainst = (other) => embargoedIds.has(other.id());
player.isOnSameTeam = (other) => teamIds.has(other.id());
player.isAlliedWith = (other) => allyIds.has(other.id());
player.isFriendly = (other) => teamIds.has(other.id()) || allyIds.has(other.id());

const specifications = [
  { id: 2, tile: 50, level: 1, relation: "other" },
  { id: 11, tile: 100, level: 2, relation: "ally" },
  { id: 12, tile: 110, level: 1, relation: "team" },
];
for (let index = 0; index < 14; index++) {
  specifications.push({ id: 20 + index, tile: 120 + index * 10, level: 1, relation: "other" });
}
const partnerOwners = specifications.map(({ id, tile, level }) =>
  makeOwner(id, [makePort(tile, level)]),
);
const embargoedOwner = makeOwner(900, [makePort(80)]);
const incompleteOwner = makeOwner(901, [makePort(90, 1, { complete: false })]);
const players = [player, ...partnerOwners, embargoedOwner, incompleteOwner];
const originalPlayers = [...players];
const originalPortLists = partnerOwners.map((owner) => owner.units(UNIT.Port));

const config = {
  tradeShipShortRangeDebuff: () => 100,
  tradeShipSpawnRate: (_rejections, shipCount) => {
    assert.equal(shipCount, 0);
    return 10;
  },
  // Omit proximityBonusPortsNb to exercise the Config.ts fallback formula.
};
const behavior = Object.create(sandbox.StructureBehavior.prototype);
behavior.player = player;
behavior.game = {
  players: () => players,
  manhattanDist: (from, to) => Math.abs(from - to),
  config: () => config,
  cachedUnitCount: (type) => (type === UNIT.TradeShip ? 0 : null),
};
behavior.isOceanPortTile = (tile) => oceanTiles.has(tile);

const sourceTiles = behavior.economicOceanSourceTiles([{ relation: "self", tile: 0 }]);
assert.deepEqual(
  [...sourceTiles],
  [0],
  "Port candidates use the already classified open-ocean source anchor",
);
const snapshot = behavior.economicOceanPartners(sourceTiles, 100, config);
assert.equal(snapshot.sampledSourceCount, 1);
assert.equal(
  snapshot.inspectedPortCount,
  18,
  "embargoed owners are rejected and incomplete Ports are inspected once",
);
assert.equal(snapshot.truncatedPortScan, false);
assert.equal(snapshot.entries.length, 1, "each source anchor yields one weighted source summary");
assert.equal(snapshot.scoredEntries.length, 17);

const byTile = new Map(snapshot.scoredEntries.map((entry) => [entry.tile, entry]));
assert.equal(
  byTile.get(50).weight,
  1,
  "both bonuses are suppressed below the short-range threshold",
);
assert.equal(
  byTile.get(100).weight,
  6,
  "a level-two ally at the threshold gets proximity and friendly bonuses",
);
assert.equal(byTile.get(110).weight, 3, "a teammate receives both bonuses at the threshold");
assert.equal(byTile.get(120).weight, 2, "a nearby rival receives only the proximity bonus");
assert.equal(byTile.get(180).weight, 1, "distant rank entries receive no proximity bonus");
assert.deepEqual(
  players,
  originalPlayers,
  "ranking sorts its own bounded copy without mutating game.players()",
);
assert.deepEqual(
  partnerOwners.map((owner) => owner.units(UNIT.Port)),
  originalPortLists,
  "ranking leaves each owner's Port list intact",
);

const empty = {
  partnerLevels: 0,
  incomePerTick: 0,
  teamIncomePerTick: 0,
  rivalSpilloverPerTick: 0,
};
const summary = behavior.economicPortIncomeSummary(snapshot.entries, config, empty, snapshot);
const expectedGold = (distance) =>
  75_000 / (1 + Math.exp(-0.03 * (distance - 100))) + 50 * distance;
const expectedWeight = 27;
const expectedLevelSum = 18;
const expectedWeightedAverage = (selector) =>
  snapshot.scoredEntries.reduce((sum, entry) => sum + selector(entry) * entry.weight, 0) /
  expectedWeight;
const payoutScale = 0.5 / (10 * 10);
assert.equal(summary.partnerLevels, expectedLevelSum);
assert.equal(summary.partnerWeight, expectedWeight);
assert.equal(summary.partnerPortCount, 17);
assert.equal(summary.sampledSourceCount, 1);
assert.equal(summary.inspectedPortCount, 18);
assert.equal(summary.truncatedPortScan, false);
assert.equal(summary.arrivalTicks, Math.ceil(expectedWeightedAverage((entry) => entry.distance)));
assert.ok(
  Math.abs(
    summary.incomePerTick -
      expectedWeightedAverage((entry) => expectedGold(entry.distance)) * payoutScale,
  ) < 1e-8,
);
assert.ok(
  Math.abs(
    summary.teamIncomePerTick -
      expectedWeightedAverage((entry) =>
        entry.relation === "team" ? expectedGold(entry.distance) : 0,
      ) *
        payoutScale,
  ) < 1e-8,
);
assert.ok(
  Math.abs(
    summary.rivalSpilloverPerTick -
      expectedWeightedAverage((entry) =>
        entry.relation === "other" ? expectedGold(entry.distance) : 0,
      ) *
        payoutScale,
  ) < 1e-8,
);
