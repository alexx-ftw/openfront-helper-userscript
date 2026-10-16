import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const sandbox = {
  getPlayerSmallId: (player) => player?.smallID(),
  toFiniteNumber: (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback,
};
executeClassicScript(readRepositoryFile("engine/ingame/trade-balances.js"), sandbox);

let tick = 10;
let unitScans = 0;
let tileReads = 0;
const owner = { smallID: () => 7 };
const otherOwner = { smallID: () => 8 };
function structure(tile, type = "City", player = owner) {
  return {
    tile() {
      tileReads += 1;
      return tile;
    },
    type: () => type,
    owner: () => player,
    isActive: () => true,
    hasTrainStation: () => true,
  };
}
let units = Array.from({ length: 1000 }, (_, tile) => structure(tile));
const game = {
  ticks: () => tick,
  units(...types) {
    unitScans += 1;
    return units.filter((unit) => types.includes(unit.type()));
  },
  nearbyUnits: () => [],
};
for (let tile = 0; tile < 1000; tile += 1) {
  assert.strictEqual(sandbox.findTrainStationAtTile(game, tile), units[tile]);
}
assert.equal(unitScans, 1, "1000 train lookups share one structure snapshot per tick");
assert.equal(tileReads, 2000, "index construction and exact checks use linear tile reads");

// Ownership and station checks still select the first matching structure at a tile.
const wrongOwner = structure(0, "Port", otherOwner);
const noStation = { ...structure(0, "Port"), hasTrainStation: () => false };
const correct = structure(0, "Port");
units = [wrongOwner, noStation, correct];
tick += 1;
assert.strictEqual(sandbox.findTrainStationAtTile(game, 0, ["Port"], owner), correct);
assert.strictEqual(sandbox.findOwnedStructureAtTile(game, 0, ["Port"], owner), noStation);
assert.equal(unitScans, 2, "same type family shares its index across train and ship lookups");
noStation.isActive = () => false;
assert.strictEqual(
  sandbox.findOwnedStructureAtTile(game, 0, ["Port"], owner),
  correct,
  "live activity checks still reject units deactivated after indexing",
);

// A new tick, game, or type family invalidates the appropriate index.
const replacement = structure(0, "Port");
units = [replacement];
tick += 1;
assert.strictEqual(sandbox.findTrainStationAtTile(game, 0, ["Port"]), replacement);
assert.equal(unitScans, 3);
const replacementGame = { ...game, units: () => [correct] };
assert.strictEqual(sandbox.findTrainStationAtTile(replacementGame, 0, ["Port"]), correct);

// No tick means no cache: each call must see the current roster.
tick = undefined;
units = [replacement];
assert.strictEqual(sandbox.findTrainStationAtTile(game, 0, ["Port"]), replacement);
units = [correct];
assert.strictEqual(sandbox.findTrainStationAtTile(game, 0, ["Port"]), correct);

const nearby = structure(12, "Port");
game.nearbyUnits = () => [{ unit: nearby }];
assert.strictEqual(
  sandbox.findTrainStationAtTile(game, 11, ["Port"]),
  nearby,
  "nearby-station fallback is retained when no exact tile matches",
);

// Nearest-factory selection preserves stable ties and rejects invalid candidates.
const firstNearest = structure(12, "Factory");
const equalNearest = structure(8, "Factory");
const factories = [
  structure(50, "Factory"),
  { ...structure(10, "Factory"), isActive: () => false },
  { ...structure(10, "Factory"), hasTrainStation: () => false },
  structure(NaN, "Factory"),
  firstNearest,
  equalNearest,
];
let factoryRange = 100;
const factoryGame = {
  manhattanDist: (start, end) => Math.abs(start - end),
  config: () => ({ trainStationMaxRange: () => factoryRange }),
};
const factoryOwner = { units: () => factories };
assert.strictEqual(sandbox.findNearestOwnedFactory(factoryGame, 10, factoryOwner), firstNearest);
factoryRange = 2;
assert.strictEqual(sandbox.findNearestOwnedFactory(factoryGame, 10, factoryOwner), firstNearest);
factoryRange = 1;
assert.equal(sandbox.findNearestOwnedFactory(factoryGame, 10, factoryOwner), null);
assert.equal(sandbox.findNearestOwnedFactory(factoryGame, null, factoryOwner), null);
assert.equal(sandbox.findNearestOwnedFactory(factoryGame, 10, { units: () => [] }), null);

process.stdout.write("trade lookup performance tests passed\n");
