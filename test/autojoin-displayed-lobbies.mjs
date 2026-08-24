import assert from "node:assert/strict";
import {
  createAutoJoinSandbox,
  defaultAutoJoinSettings,
  read,
} from "./helpers/autojoin-sandbox.mjs";

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

const sandbox = createAutoJoinSandbox(DRIVER_SOURCE);
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
  hooks.lobbyState.settings = { ...hooks.lobbyState.settings, ...defaultAutoJoinSettings };
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
