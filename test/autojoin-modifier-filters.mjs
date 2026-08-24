import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createAutoJoinSandbox,
  defaultAutoJoinSettings,
  read,
  ROOT,
} from "./helpers/autojoin-sandbox.mjs";

const DRIVER_SOURCE = `
globalThis.__ofhModifierFilterTest = {
  lobbyState,
  findMatchingLobby,
  getModelHitRates,
};
`;

// The real key lists — lobbyMatchesFilters only consults keys present in
// FILTER_KEYS, so the crowded/compact entries must be here for the
// include/exclude chips to do anything.
const filterKeys = [
  "startingGold0M",
  "randomSpawn",
  "crowded",
  "compact",
  "alliancesDisabled",
  "portsDisabled",
  "nukesDisabled",
  "samsDisabled",
  "waterNukes",
  "peaceTime4m",
  "startingGold5M",
  "startingGold1M",
  "startingGold25M",
  "goldMultiplier2x",
];
const startGoldFilterKeys = [
  "startingGold0M",
  "startingGold1M",
  "startingGold5M",
  "startingGold25M",
];

const sandbox = createAutoJoinSandbox(DRIVER_SOURCE, { filterKeys, startGoldFilterKeys });
const hooks = sandbox.__ofhModifierFilterTest;
assert.equal(
  typeof hooks.findMatchingLobby,
  "function",
  "auto-join scope exposes the join selector",
);

// The game signals the modifiers on the scheduled FFA card exactly like this:
// crowded only ever comes from publicGameModifiers, while compact also reaches
// the card as gameMapSize === "Compact" (JoinLobbyModal honors both forms).
const ffaLobby = (gameID, gameConfigExtra) => ({
  gameID,
  numClients: 5,
  gameConfig: {
    gameMode: "Free For All",
    map: "world",
    maxPlayers: 100,
    ...gameConfigExtra,
  },
});

const snapshotWith = (lobby) => ({ games: { special: [], ffa: [lobby], team: [] } });

const CROWDED = ffaLobby("crowded", { publicGameModifiers: { isCrowded: true } });
const COMPACT_MODIFIERS = ffaLobby("compact-modifiers", {
  publicGameModifiers: { isCompact: true },
});
const COMPACT_MAP_SIZE = ffaLobby("compact-map-size", { gameMapSize: "Compact" });
const CROWDED_AND_COMPACT = ffaLobby("crowded-and-compact", {
  publicGameModifiers: { isCrowded: true, isCompact: true },
});
const PLAIN = ffaLobby("plain");

function resetFilters() {
  hooks.lobbyState.settings = {
    ...hooks.lobbyState.settings,
    ...defaultAutoJoinSettings,
    includeFilters: {},
    excludeFilters: {},
  };
}

function test(name, fn) {
  fn();
  process.stdout.write(`ok - ${name}\n`);
}

test("include Crowded joins only lobbies flagged isCrowded", () => {
  resetFilters();
  hooks.lobbyState.settings.includeFilters.crowded = true;

  assert.equal(hooks.findMatchingLobby(snapshotWith(CROWDED))?.gameID, "crowded");
  assert.equal(hooks.findMatchingLobby(snapshotWith(PLAIN)), null);
  assert.equal(
    hooks.findMatchingLobby(snapshotWith(COMPACT_MODIFIERS)),
    null,
    "compact without crowded must not satisfy the crowded include",
  );
});

test("include Compact matches both modifier and gameMapSize forms", () => {
  resetFilters();
  hooks.lobbyState.settings.includeFilters.compact = true;

  assert.equal(
    hooks.findMatchingLobby(snapshotWith(COMPACT_MODIFIERS))?.gameID,
    "compact-modifiers",
  );
  assert.equal(
    hooks.findMatchingLobby(snapshotWith(COMPACT_MAP_SIZE))?.gameID,
    "compact-map-size",
    "gameMapSize Compact must count as compact, like the game's own JoinLobbyModal",
  );
  assert.equal(hooks.findMatchingLobby(snapshotWith(PLAIN)), null);
});

test("exclude Compact skips both compact forms and still joins plain lobbies", () => {
  resetFilters();
  hooks.lobbyState.settings.excludeFilters.compact = true;

  assert.equal(hooks.findMatchingLobby(snapshotWith(PLAIN))?.gameID, "plain");
  assert.equal(hooks.findMatchingLobby(snapshotWith(COMPACT_MODIFIERS)), null);
  assert.equal(hooks.findMatchingLobby(snapshotWith(COMPACT_MAP_SIZE)), null);
});

test("crowded and compact can be required together and excluded independently", () => {
  resetFilters();
  hooks.lobbyState.settings.includeFilters.crowded = true;
  hooks.lobbyState.settings.includeFilters.compact = true;

  assert.equal(
    hooks.findMatchingLobby(snapshotWith(CROWDED_AND_COMPACT))?.gameID,
    "crowded-and-compact",
    "the game allows both modifiers on one lobby",
  );
  assert.equal(hooks.findMatchingLobby(snapshotWith(CROWDED)), null);

  hooks.lobbyState.settings.excludeFilters.compact = true;
  assert.equal(
    hooks.findMatchingLobby(snapshotWith(CROWDED_AND_COMPACT)),
    null,
    "an excluded modifier always rejects, even alongside an include",
  );
});

test("forecast model rates reflect where each modifier actually appears", () => {
  // The model seeds a deterministic PRNG, so these rates are reproducible.
  resetFilters();
  const unfiltered = hooks.getModelHitRates();
  assert.equal(unfiltered.ffa, 1, "no filters → every ffa scenario matches");
  assert.equal(unfiltered.special, 1, "no filters → every special scenario matches");

  hooks.lobbyState.settings.includeFilters.compact = true;
  const compactRates = hooks.getModelHitRates();
  // Scheduled ffa/team lobbies roll Compact every 3rd playlist rotation.
  assert.ok(
    compactRates.ffa > 0.25 && compactRates.ffa < 0.42,
    `ffa compact rate should approximate 1/3 (got ${compactRates.ffa})`,
  );
  assert.ok(compactRates.special > 0, "special lobbies can roll isCompact from the pool");

  hooks.lobbyState.settings.includeFilters.compact = false;
  hooks.lobbyState.settings.includeFilters.crowded = true;
  const crowdedRates = hooks.getModelHitRates();
  assert.equal(
    crowdedRates.ffa,
    0,
    "crowded only exists on special lobbies, never on scheduled ffa cards",
  );
  assert.equal(crowdedRates.team, 0, "crowded only exists on special lobbies, never on team cards");
  assert.ok(crowdedRates.special > 0.02, "special lobbies can roll isCrowded from the pool");
});

test("FILTER_KEYS and the popup ship the crowded and compact filter entries", () => {
  const settingsSource = read("engine/shared/settings.js");
  assert.match(settingsSource, /"crowded",/, "settings list the crowded key");
  assert.match(settingsSource, /"compact",/, "settings list the compact key");
  const popupSource = read("src/shell/popup/panel.ts");
  assert.match(popupSource, /\["crowded", "Crowded"\]/, "popup has the Crowded chip");
  assert.match(popupSource, /\["compact", "Compact"\]/, "popup has the Compact chip");
  // withFileTypes + hidden-entry skip: stray non-locale dirs (e.g. a local
  // .mimosa scan cache) must not break the bundle check.
  const localeEntries = fs.readdirSync(path.join(ROOT, "locales"), { withFileTypes: true });
  for (const entry of localeEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const locale = entry.name;
    const bundle = JSON.parse(read(path.join("locales", locale, "common.json")));
    assert.ok(bundle.Crowded, `${locale} translates Crowded`);
    assert.ok(bundle.Compact, `${locale} translates Compact`);
  }
});

process.stdout.write("autojoin-modifier-filters tests passed\n");
