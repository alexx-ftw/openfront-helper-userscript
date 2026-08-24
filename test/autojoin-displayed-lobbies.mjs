import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeClassicScript } from "./helpers/classic-script.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

// The userscript concatenates engine files into one sloppy-mode scope; mirror
// that here so auto-join.js sees core.js's top-level bindings (lobbyState,
// lobbyCooldowns, PREFERRED_GROUP_ORDER, ...).
const ENGINE_SOURCE = [read("engine/lobby/core.js"), read("engine/lobby/auto-join.js")].join("\n");
const DRIVER_SOURCE = `
globalThis.__ofhAutoJoinTest = {
  lobbyState,
  getDisplayedLobbies,
  findMatchingLobby,
  updateLobbyForecast,
  buildLobbyForecastPayload,
  syncForecastSignature() {
    lobbyForecastFilterSignature = createForecastFilterSignature();
  },
};
`;

const defaultSettings = {
  enabled: false,
  keepAutoJoinAfterMatch: false,
  joinNotification: false,
  language: "en",
  mapFilters: {},
  mapExcludeFilters: {},
  includeFilters: {},
  excludeFilters: {},
  minLobbySize: null,
  minTeamSize: null,
  maxTeamSize: null,
  minTeamCount: null,
  maxTeamCount: null,
};

const sandbox = {
  console,
  // Declared in floating-autojoin.js, which this two-file concatenation omits.
  syncFloatingHelpersPanel() {},
  syncFloatingAutoJoinPanel() {},
  Audio: class {
    constructor(src) {
      this.src = src;
      this.preload = "";
    }
  },
  window: {
    addEventListener() {},
    postMessage() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  },
  document: {
    addEventListener() {},
    querySelector() {
      return null;
    },
    getElementById() {
      return null;
    },
    body: { classList: { contains: () => false } },
  },
  chrome: {
    runtime: {
      id: "ofh-test",
      onMessage: { addListener() {} },
      sendMessage: async () => {},
      getURL: (path) => path,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      onChanged: { addListener() {} },
    },
  },
  OpenFrontHelperSettings: {
    STORAGE_KEY: "ofh-test-settings",
    FILTER_KEYS: [],
    START_GOLD_FILTER_KEYS: [],
    MAPS: [
      { id: "world", name: "World" },
      { id: "europe", name: "Europe" },
    ],
    MAP_IDS: ["world", "europe"],
    createDefaultMapFilters: () => ({}),
    normalizeSettings: (value) => ({ ...defaultSettings, ...(value || {}) }),
  },
};
sandbox.globalThis = sandbox;
executeClassicScript(ENGINE_SOURCE + "\n" + DRIVER_SOURCE, sandbox, {
  filename: path.join(ROOT, "engine/lobby/auto-join.js"),
});

const hooks = sandbox.__ofhAutoJoinTest;
assert.equal(
  typeof hooks.findMatchingLobby,
  "function",
  "auto-join scope exposes the join selector",
);

const lobby = (gameID, map) => ({
  gameID,
  numClients: 5,
  gameConfig: { gameMode: "Free For All", map },
});

// Queue shape the master broadcasts: [0] is the active card the main menu
// renders; deeper entries are queued and hosted lobbies are a separate bucket.
const QUEUED_SNAPSHOT = {
  games: {
    special: [lobby("sp-active", "europe"), lobby("sp-queued", "world")],
    ffa: [lobby("ffa-active", "europe"), lobby("ffa-queued", "world")],
    team: [lobby("team-active", "europe"), lobby("team-queued", "world")],
    hosted: [lobby("hosted-matching", "world")],
  },
};

// The world queue advances: ffa-queued rotated up to the displayed slot.
const ROTATED_SNAPSHOT = {
  games: {
    special: [lobby("sp-active", "europe"), lobby("sp-queued", "world")],
    ffa: [lobby("ffa-queued", "world"), lobby("ffa-next", "europe")],
    team: [lobby("team-active", "europe"), lobby("team-queued", "world")],
    hosted: [lobby("hosted-matching", "world")],
  },
};

function test(name, fn) {
  fn();
  process.stdout.write(`ok - ${name}\n`);
}

test("displayed candidates are exactly the first lobby of each scheduled group", () => {
  // Spread into host-realm arrays first: cross-realm prototypes fail deepEqual.
  const displayed = [...hooks.getDisplayedLobbies(QUEUED_SNAPSHOT)];
  assert.deepEqual(
    displayed.map(({ groupKey, lobby }) => [groupKey, lobby.gameID]),
    [
      ["special", "sp-active"],
      ["ffa", "ffa-active"],
      ["team", "team-active"],
    ],
    "queued and hosted entries must never be join candidates",
  );
});

test("auto-join does not join a matching lobby that is still queued", () => {
  hooks.lobbyState.settings.mapFilters = { world: true };
  hooks.syncForecastSignature();

  assert.equal(
    hooks.findMatchingLobby(QUEUED_SNAPSHOT),
    null,
    "only displayed cards may be joined, even when a queued lobby matches",
  );
});

test("the matching lobby is joined once it rotates up to the displayed slot", () => {
  assert.equal(
    hooks.findMatchingLobby(ROTATED_SNAPSHOT)?.gameID,
    "ffa-queued",
    "a surfaced match must be joined",
  );
});

test("the forecast tracks displayed-card arrivals, not queue arrivals", () => {
  hooks.lobbyState.settings = { ...hooks.lobbyState.settings, ...defaultSettings };
  hooks.lobbyState.settings.mapFilters = { world: true };
  hooks.syncForecastSignature();

  hooks.updateLobbyForecast(QUEUED_SNAPSHOT);
  hooks.updateLobbyForecast(ROTATED_SNAPSHOT);

  const payload = hooks.buildLobbyForecastPayload();
  assert.equal(payload.available, true, "filters are selected, so the forecast is available");
  assert.equal(
    payload.sampleSize,
    4,
    "counts the three displayed cards plus the one rotation (queued/hosted arrivals excluded)",
  );
  assert.equal(
    payload.medianLobbiesToMatch,
    4,
    "the surfaced ffa-queued card is the first recorded match",
  );
});

test("the join selector source no longer sweeps the full snapshot", () => {
  const source = read("engine/lobby/auto-join.js");

  assert.doesNotMatch(source, /flattenLobbies/, "the full-snapshot sweep is gone");
  assert.match(
    source,
    /const match = getDisplayedLobbies\(snapshot\)\.find/,
    "the join selector iterates displayed cards only",
  );
});

process.stdout.write("autojoin-displayed-lobbies tests passed\n");
