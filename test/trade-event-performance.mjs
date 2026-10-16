import assert from "node:assert/strict";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const sandbox = {};
executeClassicScript(
  `${readRepositoryFile("engine/ingame/shared-utils.js")}\n${readRepositoryFile("engine/ingame/trade-balances.js")}`,
  sandbox,
);
let nameReads = 0;
const players = Array.from({ length: 100 }, (_, id) => ({
  smallID: () => id,
  displayName: () => `Display ${id}`,
  name() {
    nameReads += 1;
    return `Internal ${id}`;
  },
}));
players[0].name = () => "Shared";
players[1].displayName = () => "Shared";
players[2].displayName = () => "Shared";
const names = [" SHARED ", "Display 99", "INTERNAL   98", "missing", "", "   ", undefined];
const events = Array.from({ length: 1000 }, (_, index) => ({
  message: "events_display.received_gold_from_trade",
  playerID: 7,
  goldAmount: 10n,
  params: { name: names[index % names.length] },
}));
const expectedPartners = events.map((event) => {
  const name = String(event.params.name ?? "Unknown");
  const player = sandbox.findPlayerByTradeName(players, name);
  return player ? player.smallID() : `name:${name}`;
});
let normalizations = 0;
let displayReads = 0;
const normalize = sandbox.normalizeTradeName;
const displayName = sandbox.getPlayerDisplayName;
sandbox.normalizeTradeName = (name) => {
  normalizations += 1;
  return normalize(name);
};
sandbox.getPlayerDisplayName = (player) => {
  displayReads += 1;
  return displayName(player);
};
const recorded = [];
sandbox.addTradeBalance = (event) => recorded.push(event);
nameReads = 0;
sandbox.processTradeBalanceEvents(
  { metadata: 42, first: events.slice(0, 500), unrelated: [null, {}], second: events.slice(500) },
  players,
  [],
);
assert.deepEqual(
  recorded.map((event) => event.partnerId),
  expectedPartners,
  "indexed lookup preserves display-name priority, first duplicate, normalization, and unknown partners",
);
assert.equal(
  recorded[0].partnerId,
  1,
  "a display name wins over an earlier player's internal name",
);
assert.equal(displayReads, 100, "1000 events read each player's display name only once");
assert.equal(nameReads, 99, "internal names are read once per player");
assert.equal(normalizations, 1200, "normalization work grows with players plus events");
assert.ok(recorded.every((event) => event.goldAmount === 10 && event.direction === "unknown"));

displayReads = 0;
normalizations = 0;
sandbox.processTradeBalanceEvents({ metadata: 42, unrelated: [null, {}] }, players, []);
assert.equal(displayReads, 0, "batches without trade events never build a name index");
assert.equal(normalizations, 0);

// Each batch gets a fresh index, so renamed players do not retain stale aliases.
players[1].displayName = () => "Renamed";
players[2].displayName = () => "Renamed too";
sandbox.processTradeBalanceEvents({ events: [events[0]] }, players, []);
assert.equal(recorded.at(-1).partnerId, 0, "the next batch sees the new display names");

process.stdout.write("trade event performance tests passed\n");
