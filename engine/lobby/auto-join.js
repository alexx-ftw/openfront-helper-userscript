
// Lobby filtering and auto-join -------------------------------------------
// Lobby filtering, bridge injection, and auto-join lifecycle.

function normalizeComparableText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeMapToken(value) {
  return normalizeComparableText(value).replace(/[^a-z0-9]+/g, "");
}

function isExtensionContextInvalidatedError(error) {
  return String(error?.message || error || "").includes("Extension context invalidated");
}

function isExtensionContextAlive() {
  {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  }
}

const LOBBY_FORECAST_MAX_RATE_SAMPLES = 240;
const LOBBY_FORECAST_MAX_DISTANCE_SAMPLES = 120;
const LOBBY_FORECAST_PERSIST_MS = 4000;
const LOBBY_FORECAST_MODEL_DRAWS = 3500;
let lobbyForecastRandomState = 0x9e3779b9;

function nextLobbyForecastRandom() {
  lobbyForecastRandomState =
    (Math.imul(lobbyForecastRandomState, 1_664_525) + 1_013_904_223) >>> 0;
  return lobbyForecastRandomState / 0x1_0000_0000;
}
const LOBBY_FORECAST_PRIOR_STRENGTH = 36;
const LOBBY_FORECAST_MIN_GROUP_SAMPLES_FOR_WEIGHTING = 12;
const LOBBY_FORECAST_AVERAGE_WINDOW = 100;
const LOBBY_FORECAST_MIN_MATCH_SAMPLES_FOR_ROLLING = 20;

let lobbyForecastSeenIds = new Set();
let lobbyForecastNewLobbyTimestamps = [];
let lobbyForecastDistanceSamples = [];
let lobbyForecastTotalNew = 0;
let lobbyForecastMatchedNew = 0;
let lobbyForecastSinceLastMatch = 0;
let lobbyForecastNewByGroup = {
  special: 0,
  ffa: 0,
  team: 0,
};
let lobbyForecastRecentLobbyIntervalsMs = [];
let lobbyForecastRecentMatchOutcomes = [];
let lobbyForecastLastSeenLobbyAt = null;
let lobbyForecastRecentLobbyCount = 0;
let lobbyForecastFilterSignature = "";
let lobbyForecastLastPersistedAt = 0;
let lobbyForecastLastPersistedPayload = "";
let lobbyForecastModelCache = {
  signature: "",
  values: {
    special: 0,
    ffa: 0,
    team: 0,
  },
};

const FORECAST_MAP_FREQUENCY = Object.freeze({
  africa: 7,
  asia: 6,
  australia: 4,
  achiran: 5,
  baikal: 5,
  betweentwoseas: 5,
  blacksea: 6,
  britannia: 5,
  britanniaclassic: 4,
  deglaciatedantarctica: 4,
  eastasia: 5,
  europe: 7,
  falklandislands: 4,
  faroeislands: 4,
  fourislands: 4,
  gatewaytotheatlantic: 5,
  gulfofstlawrence: 4,
  halkidiki: 4,
  iceland: 4,
  italia: 6,
  japan: 6,
  lisbon: 4,
  manicouagan: 4,
  mars: 3,
  mena: 6,
  montreal: 6,
  newyorkcity: 3,
  northamerica: 5,
  pangaea: 5,
  pluto: 6,
  southamerica: 5,
  straitofgibraltar: 5,
  svalmel: 8,
  world: 20,
  lemnos: 3,
  passage: 4,
  twolakes: 6,
  straitofhormuz: 4,
  surrounded: 4,
  didierfrance: 1,
  didier: 1,
  amazonriver: 3,
  bosphorusstraits: 3,
  beringstrait: 2,
  sierpinski: 10,
  thebox: 3,
  yenisei: 6,
  tradersdream: 4,
  hawaii: 4,
  alps: 4,
  antarctica: 1,
  archipelagosea: 3,
  bajacalifornia: 4,
  beringsea: 5,
  caucasus: 5,
  conakry: 3,
  losangeles: 8,
  luna: 6,
  marenostrum: 6,
  niledelta: 4,
  arctic: 6,
  sanfrancisco: 3,
  aegean: 6,
  milkyway: 8,
  dyslexdria: 8,
  greatlakes: 6,
  straitofmalacca: 4,
  // v0.32 maps. These weights are ESTIMATES of public-lobby rotation frequency
  // (used only by the advisory lobby forecast, not by actual matching) — tune as
  // real rotation data accrues. Larger/requested maps weighted higher than the
  // meme maps (onion / labyrinth / choppingblock / warshipwarship).
  balkans: 5,
  caribbean: 5,
  choppingblock: 2,
  danishstraits: 4,
  giantworldmap: 2,
  hongkong: 4,
  indiansubcontinent: 5,
  juandefucastrait: 3,
  korea: 4,
  labyrinth: 2,
  middleeast: 5,
  mississippiriver: 3,
  northwestpassage: 3,
  onion: 2,
  southeastasia: 5,
  taiwanstrait: 3,
  titan: 3,
  venice: 4,
  warshipwarship: 2,
  worldinverted: 3,
  yellowsea: 4,
});

const FORECAST_ARCADE_MAP_IDS = new Set(["thebox", "didier", "didierfrance", "sierpinski"]);
const FORECAST_SPECIAL_ONLY_MAP_IDS = new Set(["archipelagosea"]);
const FORECAST_WATER_NUKES_BOOSTED_MAPS = new Set([
  "fourislands",
  "baikal",
  "alps",
  "thebox",
  "luna",
  "archipelagosea",
]);
const FORECAST_SPECIAL_COUNT_ROLLS = [1, 1, 1, 2, 2, 2, 2, 2, 3, 3];
const FORECAST_TEAM_WEIGHTS = Object.freeze([
  { config: 2, weight: 10 },
  { config: 3, weight: 10 },
  { config: 4, weight: 10 },
  { config: 5, weight: 10 },
  { config: 6, weight: 10 },
  { config: 7, weight: 10 },
  { config: "duos", weight: 5 },
  { config: "trios", weight: 7.5 },
  { config: "quads", weight: 7.5 },
  { config: "humansVsNations", weight: 20 },
]);

const FORECAST_MUTUALLY_EXCLUSIVE_MODIFIERS = Object.freeze([
  ["startingGold5M", "startingGold25M"],
  ["startingGold5M", "startingGold1M"],
  ["startingGold25M", "startingGold1M"],
  ["isHardNations", "startingGold25M"],
  ["isNukesDisabled", "isSAMsDisabled"],
  ["isNukesDisabled", "isWaterNukes"],
]);

const FORECAST_SPECIAL_MODIFIER_POOL = Object.freeze([
  ...Array(2).fill("isRandomSpawn"),
  ...Array(4).fill("isCompact"),
  ...Array(2).fill("isCrowded"),
  ...Array(1).fill("isHardNations"),
  ...Array(3).fill("startingGold1M"),
  ...Array(5).fill("startingGold5M"),
  ...Array(1).fill("startingGold25M"),
  ...Array(4).fill("goldMultiplier"),
  ...Array(1).fill("isAlliancesDisabled"),
  ...Array(1).fill("isPortsDisabled"),
  ...Array(1).fill("isNukesDisabled"),
  ...Array(1).fill("isSAMsDisabled"),
  ...Array(1).fill("isMirvDisabled"),
  ...Array(1).fill("isPeaceTime"),
  ...Array(3).fill("isWaterNukes"),
]);

function addMapTokensFromValue(value, tokens, depth = 0) {
  if (depth > 4 || value == null) {
    return;
  }

  if (typeof value === "string" || typeof value === "number") {
    const comparable = normalizeComparableText(value);
    const token = normalizeMapToken(value);
    if (comparable) {
      tokens.add(comparable);
    }
    if (token) {
      tokens.add(token);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      addMapTokensFromValue(entry, tokens, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    for (const entry of Object.values(value)) {
      addMapTokensFromValue(entry, tokens, depth + 1);
    }
  }
}

function addMapTokensFromMapFields(value, tokens, depth = 0) {
  if (depth > 4 || value == null || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (normalizeMapToken(key).includes("map")) {
      addMapTokensFromValue(entry, tokens);
    }

    if (entry != null && typeof entry === "object") {
      addMapTokensFromMapFields(entry, tokens, depth + 1);
    }
  }
}

function getLobbyMapTokens(lobby) {
  const config = lobby?.gameConfig || {};
  const tokens = new Set();
  const candidateValues = [
    config.map,
    config.mapId,
    config.mapID,
    config.mapName,
    config.mapInfo,
    config.mapConfig,
    config.mapMetadata,
    config.gameMap,
    config.gameMapId,
    config.gameMapID,
    config.gameMapName,
    config.terrain,
    lobby?.map,
    lobby?.mapId,
    lobby?.mapID,
    lobby?.mapName,
    lobby?.gameMap,
    lobby?.gameMapId,
    lobby?.gameMapID,
    lobby?.gameMapName,
  ];

  for (const value of candidateValues) {
    addMapTokensFromValue(value, tokens);
  }
  addMapTokensFromMapFields(lobby, tokens);

  return tokens;
}

function mapMatchesTokens(map, tokens) {
  const candidates = [
    normalizeComparableText(map.id),
    normalizeComparableText(map.name),
    normalizeMapToken(map.id),
    normalizeMapToken(map.name),
  ];

  return candidates.some((candidate) => candidate && tokens.has(candidate));
}

function lobbyMatchesMapFilters(lobby) {
  const includedMaps = MAPS.filter((map) => lobbyState.settings.mapFilters[map.id]);
  const excludedMaps = MAPS.filter((map) => lobbyState.settings.mapExcludeFilters[map.id]);
  if (includedMaps.length === 0 && excludedMaps.length === 0) {
    return true;
  }

  const lobbyMapTokens = getLobbyMapTokens(lobby);
  if (lobbyMapTokens.size === 0) {
    return includedMaps.length === 0;
  }

  if (excludedMaps.some((map) => mapMatchesTokens(map, lobbyMapTokens))) {
    return false;
  }

  if (includedMaps.length === 0) {
    return true;
  }

  return includedMaps.some((map) => mapMatchesTokens(map, lobbyMapTokens));
}

// (The original extension injected the in-game scripts here via <script src>.
// In the userscript they are bundled inline as their own IIFE, so no injection
// is needed — see build.mjs.)

function pruneCooldowns() {
  const now = Date.now();
  for (const [gameID, expiresAt] of lobbyCooldowns.entries()) {
    if (expiresAt <= now) {
      lobbyCooldowns.delete(gameID);
    }
  }
}

function resetPendingJoinIfExpired() {
  if (!lobbyState.pendingJoin) {
    return;
  }

  if (isOccupied() || Date.now() - lobbyState.pendingJoin.startedAt > JOIN_ATTEMPT_TIMEOUT_MS) {
    lobbyState.pendingJoin = null;
  }
}

function isInActiveGame() {
  if (document.body?.classList.contains("in-game")) {
    return true;
  }

  return /\/game\/[^/]+/.test(window.location.pathname) && window.location.search.includes("live");
}

// In the public-lobby WAITING ROOM? Public joins open <join-lobby-modal> (a
// BaseModal with isModalOpen) without changing the URL, so this is the only
// reliable signal that we've joined a lobby but the game hasn't started.
function isInLobbyWaiting() {
  {
    const modal = document.querySelector("join-lobby-modal");
    return Boolean(modal && modal.isModalOpen === true);
  }
}

// Are we in the game-start LOADING window? When the lobby countdown ends the
// game closes <join-lobby-modal> (isModalOpen→false) and shows the
// <game-starting-modal> splash, but only adds the body.in-game class / live URL
// later once the game finishes loading. That leaves a gap where neither
// isInLobbyWaiting() nor isInActiveGame() is true even though a game is starting
// — and during it the search would wrongly fire a fresh join. The splash's
// isVisible flag spans exactly that gap. NOTE: the game's createClientGame error
// path hides the splash with classList.add("hidden") WITHOUT clearing isVisible,
// so it can stay true at the menu — guard on the `hidden` class too, otherwise a
// failed start would wedge the search "occupied" forever (never resumes).
function isGameStarting() {
  {
    const modal = document.querySelector("game-starting-modal");
    return Boolean(
      modal && modal.isVisible === true && !modal.classList.contains("hidden"),
    );
  }
}

// "Occupied" = can't/shouldn't search: waiting room, game-start loading, or a
// live game. Becoming un-occupied again means we're back at the menu (game ended
// OR the user backed out of the lobby) → safe to resume searching.
function isOccupied() {
  return isInActiveGame() || isInLobbyWaiting() || isGameStarting();
}

// Sample occupancy AND remember the moment we last saw it. Everything that gates
// searching reads occupancy through here so `lobbyState.lastOccupiedAt` stays fresh enough
// for the RESUME_GRACE_MS debounce to measure "how long have we been free".
function noteOccupancy() {
  const inLobbyWaiting = isInLobbyWaiting();
  const occupied = isInActiveGame() || inLobbyWaiting || isGameStarting();
  if (inLobbyWaiting) {
    lobbyState.sawLobbyWaitingBeforeGameStart = true;
  }
  if (occupied) {
    lobbyState.lastOccupiedAt = Date.now();
    if (lobbyState.pendingGameStartNotification) {
      lobbyState.pendingGameStartNotification.sawOccupied = true;
    }
  }
  return occupied;
}

// Were we occupied recently enough that a now-free reading is more likely a
// transient game-start loading blip than a real return to the menu? This is the
// debounce that makes the fix independent of which exact DOM signal momentarily
// misreads during startup.
function recentlyOccupied() {
  return lobbyState.lastOccupiedAt > 0 && Date.now() - lobbyState.lastOccupiedAt < RESUME_GRACE_MS;
}

function armGameStartNotification(gameID) {
  lobbyState.pendingGameStartNotification = {
    gameID,
    startedAt: Date.now(),
    sawOccupied: false,
  };
}

function expirePendingGameStartNotification() {
  const pending = lobbyState.pendingGameStartNotification;
  if (!pending) {
    return;
  }

  if (pending.sawOccupied) {
    if (!isOccupied() && !recentlyOccupied()) {
      lobbyState.pendingGameStartNotification = null;
    }
    return;
  }

  if (Date.now() - pending.startedAt > JOIN_ATTEMPT_TIMEOUT_MS && !isOccupied()) {
    lobbyState.pendingGameStartNotification = null;
  }
}

function handleGameStarted() {
  const pending = lobbyState.pendingGameStartNotification;
  lobbyState.pendingGameStartNotification = null;
  const startedFromLobby = lobbyState.sawLobbyWaitingBeforeGameStart;
  lobbyState.sawLobbyWaitingBeforeGameStart = false;
  if ((!pending && !startedFromLobby) || !lobbyState.settings.joinNotification) {
    return;
  }

  chrome.runtime
    .sendMessage({
      type: "SHOW_GAME_START_NOTIFICATION",
      gameID: pending?.gameID,
      text: t("Game started!"),
    });
}

// One concise line at each auto-join DECISION (the only spot that can produce a
// wrong join), capturing every raw input. Lets a single reproduction settle why
// a spurious join happened — stale build, an un-cleared lobbyState.pendingJoin, or which
// occupancy signal read false — instead of guessing. console.info survives
// minification (string literals are kept), so it works in the shipped build.
function logAutoJoinDecision(context, lobby) {
  {
    const joinModal = document.querySelector("join-lobby-modal");
    const startingModal = document.querySelector("game-starting-modal");
    console.warn("[openfront-helper][autojoin-diag]", context, {
      build: AUTOJOIN_DIAG_BUILD,
      gameID: lobby?.gameID ?? null,
      sinceLastJoinMs: lobbyState.lastJoinRequestedAt ? Date.now() - lobbyState.lastJoinRequestedAt : null,
      sinceOccupiedMs: lobbyState.lastOccupiedAt ? Date.now() - lobbyState.lastOccupiedAt : null,
      recentlyOccupied: recentlyOccupied(),
      pendingJoin: lobbyState.pendingJoin,
      isInActiveGame: isInActiveGame(),
      isInLobbyWaiting: isInLobbyWaiting(),
      isGameStarting: isGameStarting(),
      joinModalExists: Boolean(joinModal),
      joinModalIsModalOpen: joinModal ? joinModal.isModalOpen ?? null : null,
      startingModalExists: Boolean(startingModal),
      startingModalIsVisible: startingModal ? startingModal.isVisible ?? null : null,
      startingModalClass: startingModal ? startingModal.className : null,
      bodyInGame: document.body ? document.body.classList.contains("in-game") : null,
      location: location.pathname + location.search,
    });
  }
}

function objectContainsFreeForAll(value, depth = 0) {
  if (depth > 4 || value == null) {
    return false;
  }

  if (typeof value === "string") {
    const normalized = normalizeComparableText(value);
    return normalized === "free for all" || normalized.includes("free for all");
  }

  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsFreeForAll(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.values(value).some((entry) =>
      objectContainsFreeForAll(entry, depth + 1),
    );
  }

  return false;
}

function objectContainsPhrase(value, phrase, depth = 0) {
  if (depth > 4 || value == null) {
    return false;
  }

  if (typeof value === "string") {
    return normalizeComparableText(value).includes(phrase);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsPhrase(entry, phrase, depth + 1));
  }

  if (typeof value === "object") {
    return Object.values(value).some((entry) =>
      objectContainsPhrase(entry, phrase, depth + 1),
    );
  }

  return false;
}

function isFfaLobby(lobby, groupKey) {
  const gameMode = normalizeComparableText(lobby?.gameConfig?.gameMode);

  if (gameMode === "free for all" || gameMode === "ffa") {
    return true;
  }

  if (gameMode === "team") {
    return false;
  }

  if (objectContainsFreeForAll(lobby)) {
    return true;
  }

  return groupKey === "ffa";
}

function getTeamSizePerLobby(lobby) {
  const config = lobby?.gameConfig || {};
  const gameMode = normalizeComparableText(config.gameMode);
  if (gameMode !== "team") {
    return null;
  }

  const playerTeams = config.playerTeams;
  const normalizedTeams = normalizeComparableText(playerTeams);
  const namedTeamSize = { duos: 2, trios: 3, quads: 4 }[normalizedTeams];
  if (namedTeamSize) return namedTeamSize;

  const maxPlayers = Number(config.maxPlayers);
  if (typeof playerTeams === "number" && Number.isFinite(playerTeams) && playerTeams > 0 && Number.isFinite(maxPlayers) && maxPlayers > 0) {
    return Math.floor(maxPlayers / playerTeams);
  }

  for (const size of [2, 3, 4, 5, 6]) {
    if (objectContainsPhrase(lobby, `teams of ${size}`)) return size;
  }

  return null;
}

function getLobbyTeamSizeForFilter(lobby, groupKey) {
  if (isFfaLobby(lobby, groupKey)) {
    return 1;
  }

  const teamSize = getTeamSizePerLobby(lobby);
  return Number.isFinite(teamSize) ? teamSize : null;
}

function lobbyMatchesTeamSizeRange(lobby, groupKey) {
  if (lobbyState.settings.minTeamSize == null && lobbyState.settings.maxTeamSize == null) {
    return true;
  }

  const teamSize = getLobbyTeamSizeForFilter(lobby, groupKey);
  if (!Number.isFinite(teamSize)) {
    return false;
  }

  if (lobbyState.settings.minTeamSize != null && teamSize < lobbyState.settings.minTeamSize) {
    return false;
  }

  if (lobbyState.settings.maxTeamSize != null && teamSize > lobbyState.settings.maxTeamSize) {
    return false;
  }

  return true;
}

// Replicates the game's getTeamCount (src/client/Utils.ts): a numeric
// playerTeams IS the team count; a named size (Duos/Trios/Quads/…) yields
// floor(maxPlayers / teamSize). Returns null for non-team lobbies.
function getTeamCountPerLobby(lobby) {
  const config = lobby?.gameConfig || {};
  const gameMode = normalizeComparableText(config.gameMode);
  if (gameMode !== "team") {
    return null;
  }

  const playerTeams = config.playerTeams;
  if (
    typeof playerTeams === "number" &&
    Number.isFinite(playerTeams) &&
    playerTeams > 0
  ) {
    return Math.floor(playerTeams);
  }

  const teamSize = getTeamSizePerLobby(lobby);
  const maxPlayers = getLobbyMaxPlayers(lobby);
  if (
    Number.isFinite(teamSize) &&
    teamSize > 0 &&
    Number.isFinite(maxPlayers) &&
    maxPlayers > 0
  ) {
    return Math.floor(maxPlayers / teamSize);
  }

  return null;
}

// "Teams in match" is meaningful only for team lobbies. FFA (and anything we
// cannot classify) returns null so it's rejected while the filter is active.
function getLobbyTeamCountForFilter(lobby, groupKey) {
  if (isFfaLobby(lobby, groupKey)) {
    return null;
  }
  const teamCount = getTeamCountPerLobby(lobby);
  return Number.isFinite(teamCount) ? teamCount : null;
}

function lobbyMatchesTeamCountRange(lobby, groupKey) {
  if (lobbyState.settings.minTeamCount == null && lobbyState.settings.maxTeamCount == null) {
    return true;
  }

  const teamCount = getLobbyTeamCountForFilter(lobby, groupKey);
  if (!Number.isFinite(teamCount)) {
    return false;
  }

  if (lobbyState.settings.minTeamCount != null && teamCount < lobbyState.settings.minTeamCount) {
    return false;
  }

  if (lobbyState.settings.maxTeamCount != null && teamCount > lobbyState.settings.maxTeamCount) {
    return false;
  }

  return true;
}

function getLobbyMaxPlayers(lobby) {
  const config = lobby?.gameConfig || {};
  const candidates = [
    config.maxPlayers,
    config.maxPlayerCount,
    lobby?.maxPlayers,
    lobby?.maxPlayerCount,
  ];
  for (const candidate of candidates) {
    const maxPlayers = Number(candidate);
    if (Number.isFinite(maxPlayers) && maxPlayers > 0) {
      return maxPlayers;
    }
  }
  return null;
}

function readBooleanModifier(publicModifiers, config, publicKey, ...configKeys) {
  const publicValue = publicModifiers?.[publicKey];
  if (publicValue != null) {
    return Boolean(publicValue);
  }

  return configKeys.some((key) => Boolean(config?.[key]));
}

function readPeaceTimeModifier(publicModifiers, config) {
  if (publicModifiers?.isPeaceTime != null) {
    return Boolean(publicModifiers.isPeaceTime);
  }

  const peaceTimeSeconds = Number(
    publicModifiers?.peaceTimeSeconds ??
    publicModifiers?.peaceTime ??
    config?.peaceTimeSeconds ??
    config?.peaceTime,
  );
  if (Number.isFinite(peaceTimeSeconds) && peaceTimeSeconds > 0) {
    return peaceTimeSeconds === 240;
  }

  return Boolean(config?.isPeaceTime || config?.peaceTimeEnabled);
}

function extractTrackedFilters(lobby, groupKey) {
  const config = lobby?.gameConfig || {};
  const publicModifiers = config.publicGameModifiers || {};
  // The game signals Compact either via publicGameModifiers.isCompact or via
  // gameMapSize === "Compact" (JoinLobbyModal checks both); honor either form.
  const gameMapSize = normalizeComparableText(config.gameMapSize ?? lobby?.gameMapSize);
  const startingGoldValue = publicModifiers.startingGold ?? config.startingGold;
  const startingGold = Number(startingGoldValue);
  const normalizedStartingGold = Number.isFinite(startingGold) ? startingGold : 0;
  const goldMultiplier = Number(
    publicModifiers.goldMultiplier ?? config.goldMultiplier ?? 0,
  );
  const nukesDisabled = readBooleanModifier(
    publicModifiers,
    config,
    "isNukesDisabled",
    "disableNukes",
    "nukesDisabled",
    "isNukesDisabled",
  );
  // Scheduled lobbies disable MIRV via the nukes modifier (MapPlaylist adds
  // UnitType.MIRV to disabledUnits); private lobbies list it explicitly.
  const hasDisabledMirv = [
    publicModifiers?.disabledUnits,
    config?.disabledUnits,
  ].some(
    (units) =>
      Array.isArray(units) && units.some((unit) => normalizeComparableText(unit) === "mirv"),
  );

  return {
    startingGold0M: normalizedStartingGold === 0,
    randomSpawn: readBooleanModifier(
      publicModifiers,
      config,
      "isRandomSpawn",
      "randomSpawn",
      "isRandomSpawn",
    ),
    crowded: readBooleanModifier(
      publicModifiers,
      config,
      "isCrowded",
      "crowded",
      "isCrowded",
    ),
    compact:
      readBooleanModifier(
        publicModifiers,
        config,
        "isCompact",
        "compact",
        "isCompact",
      ) || gameMapSize === "compact",
    alliancesDisabled: readBooleanModifier(
      publicModifiers,
      config,
      "isAlliancesDisabled",
      "disableAlliances",
      "alliancesDisabled",
      "isAlliancesDisabled",
    ),
    portsDisabled: readBooleanModifier(
      publicModifiers,
      config,
      "isPortsDisabled",
      "disablePorts",
      "portsDisabled",
      "isPortsDisabled",
    ),
    nukesDisabled,
    samsDisabled: readBooleanModifier(
      publicModifiers,
      config,
      "isSAMsDisabled",
      "disableSAMs",
      "disableSams",
      "samsDisabled",
      "isSAMsDisabled",
      "isSamsDisabled",
    ),
    mirvDisabled: hasDisabledMirv || nukesDisabled,
    waterNukes: readBooleanModifier(
      publicModifiers,
      config,
      "isWaterNukes",
      "waterNukes",
      "isWaterNukes",
    ),
    peaceTime4m: readPeaceTimeModifier(publicModifiers, config),
    startingGold1M: normalizedStartingGold === 1_000_000,
    startingGold5M: normalizedStartingGold === 5_000_000,
    startingGold25M: normalizedStartingGold === 25_000_000,
    goldMultiplier2x: goldMultiplier === 2,
  };
}

function lobbyMatchesFilters(lobby, groupKey) {
  if (lobbyState.settings.minLobbySize != null) {
    const maxPlayers = getLobbyMaxPlayers(lobby);
    if (!Number.isFinite(maxPlayers) || maxPlayers <= lobbyState.settings.minLobbySize) {
      return false;
    }
  }

  if (!lobbyMatchesMapFilters(lobby)) {
    return false;
  }

  if (!lobbyMatchesTeamSizeRange(lobby, groupKey)) {
    return false;
  }

  if (!lobbyMatchesTeamCountRange(lobby, groupKey)) {
    return false;
  }

  const modifiers = extractTrackedFilters(lobby, groupKey);

  const nonStartGoldMatches = FILTER_KEYS.every((key) => {
    if (START_GOLD_FILTER_KEYS.includes(key)) {
      return true;
    }

    if (lobbyState.settings.includeFilters[key] && !modifiers[key]) {
      return false;
    }

    if (lobbyState.settings.excludeFilters[key] && modifiers[key]) {
      return false;
    }

    return true;
  });

  if (!nonStartGoldMatches) {
    return false;
  }

  const selectedStartGoldIncludes = START_GOLD_FILTER_KEYS.filter(
    (key) => lobbyState.settings.includeFilters[key],
  );
  const selectedStartGoldExcludes = START_GOLD_FILTER_KEYS.filter(
    (key) => lobbyState.settings.excludeFilters[key],
  );

  const startGoldExcluded = selectedStartGoldExcludes.some(
    (key) => modifiers[key] === true,
  );

  if (startGoldExcluded) {
    return false;
  }

  if (selectedStartGoldIncludes.length === 0) {
    return true;
  }

  return selectedStartGoldIncludes.some((key) => modifiers[key] === true);
}

function hasSelectedCriteria() {
  return (
    FILTER_KEYS.some(
      (key) => lobbyState.settings.includeFilters[key] || lobbyState.settings.excludeFilters[key],
    ) ||
    lobbyState.settings.minLobbySize != null ||
    lobbyState.settings.minTeamSize != null ||
    lobbyState.settings.maxTeamSize != null ||
    lobbyState.settings.minTeamCount != null ||
    lobbyState.settings.maxTeamCount != null ||
    MAP_IDS.some((id) => lobbyState.settings.mapFilters[id] || lobbyState.settings.mapExcludeFilters[id])
  );
}

function createForecastFilterSignature() {
  return JSON.stringify({
    include: lobbyState.settings.includeFilters,
    exclude: lobbyState.settings.excludeFilters,
    mapFilters: lobbyState.settings.mapFilters,
    mapExcludeFilters: lobbyState.settings.mapExcludeFilters,
    minLobbySize: lobbyState.settings.minLobbySize,
    minTeamSize: lobbyState.settings.minTeamSize,
    maxTeamSize: lobbyState.settings.maxTeamSize,
    minTeamCount: lobbyState.settings.minTeamCount,
    maxTeamCount: lobbyState.settings.maxTeamCount,
  });
}

function resetLobbyForecastTracking(knownIds = []) {
  lobbyForecastSeenIds = new Set(knownIds.filter((id) => id));
  lobbyForecastNewLobbyTimestamps = [];
  lobbyForecastDistanceSamples = [];
  lobbyForecastTotalNew = 0;
  lobbyForecastMatchedNew = 0;
  lobbyForecastSinceLastMatch = 0;
  lobbyForecastNewByGroup = {
    special: 0,
    ffa: 0,
    team: 0,
  };
  lobbyForecastLastPersistedAt = 0;
  lobbyForecastLastPersistedPayload = "";
}

function updateLast100LobbyAverages(now, matchOutcome = null) {
  if (Number.isFinite(lobbyForecastLastSeenLobbyAt)) {
    const intervalMs = Math.max(0, now - lobbyForecastLastSeenLobbyAt);
    if (intervalMs > 0) {
      lobbyForecastRecentLobbyIntervalsMs.push(intervalMs);
      lobbyForecastRecentLobbyIntervalsMs = withForecastWindow(
        lobbyForecastRecentLobbyIntervalsMs,
        LOBBY_FORECAST_AVERAGE_WINDOW,
      );
    }
  }
  lobbyForecastLastSeenLobbyAt = now;
  lobbyForecastRecentLobbyCount = Math.min(
    LOBBY_FORECAST_AVERAGE_WINDOW,
    lobbyForecastRecentLobbyCount + 1,
  );

  if (typeof matchOutcome === "boolean") {
    lobbyForecastRecentMatchOutcomes.push(matchOutcome ? 1 : 0);
    lobbyForecastRecentMatchOutcomes = withForecastWindow(
      lobbyForecastRecentMatchOutcomes,
      LOBBY_FORECAST_AVERAGE_WINDOW,
    );
  }
}

function positiveFiniteOrNull(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function computeLast100LobbyAverages() {
  const sampleSize = lobbyForecastRecentLobbyCount;
  const hitSampleSize = lobbyForecastRecentMatchOutcomes.length;
  const hitCount = lobbyForecastRecentMatchOutcomes.reduce(
    (sum, value) => sum + value,
    0,
  );
  const hitRate = hitSampleSize > 0 ? hitCount / hitSampleSize : null;

  const intervalSampleSize = lobbyForecastRecentLobbyIntervalsMs.length;
  const avgLobbyIntervalMs =
    intervalSampleSize > 0
      ? Math.round(
        lobbyForecastRecentLobbyIntervalsMs.reduce(
          (sum, value) => sum + value,
          0,
        ) / intervalSampleSize,
      )
      : null;
  const avgLobbiesPerMinute =
    Number.isFinite(avgLobbyIntervalMs) && avgLobbyIntervalMs > 0
      ? 60_000 / avgLobbyIntervalMs
      : null;
  const etaLobbies =
    Number.isFinite(hitRate) && hitRate > 0
      ? estimateLobbiesUntilMatch(hitRate, 0.5)
      : null;
  const etaSeconds =
    etaLobbies != null &&
      Number.isFinite(avgLobbyIntervalMs) &&
      avgLobbyIntervalMs > 0
      ? Math.max(1, Math.round((etaLobbies * avgLobbyIntervalMs) / 1000))
      : null;

  return {
    windowSize: LOBBY_FORECAST_AVERAGE_WINDOW,
    sampleSize,
    hitSampleSize,
    hitRate: Number.isFinite(hitRate) ? hitRate : null,
    avgLobbyIntervalMs: positiveFiniteOrNull(avgLobbyIntervalMs),
    avgLobbiesPerMinute: positiveFiniteOrNull(avgLobbiesPerMinute),
    etaSeconds,
    updatedAt: sampleSize > 0 ? Date.now() : null,
  };
}

function getForecastMapsForType(type) {
  const entries = [];
  for (const map of MAPS) {
    let weight = Number(FORECAST_MAP_FREQUENCY[map.id] || 0);
    if (weight <= 0) {
      continue;
    }
    if (
      type !== "special" &&
      (FORECAST_ARCADE_MAP_IDS.has(map.id) ||
        FORECAST_SPECIAL_ONLY_MAP_IDS.has(map.id))
    ) {
      continue;
    }
    if (type === "team" && (map.id === "baikal" || map.id === "fourislands")) {
      weight *= 2;
    }
    entries.push({
      id: map.id,
      weight,
    });
  }
  return entries;
}

function pickWeighted(items, preparedTotal = null) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const total = preparedTotal ?? items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) {
    return null;
  }

  let roll = nextLobbyForecastRandom() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) {
      return item;
    }
  }
  return items[items.length - 1];
}

function shuffleInPlace(values) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextLobbyForecastRandom() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

function randomTeamConfigForMap(mapId) {
  if (mapId === "baikal" && nextLobbyForecastRandom() < 0.75) {
    return 2;
  }
  if (mapId === "fourislands" && nextLobbyForecastRandom() < 0.75) {
    return 4;
  }
  if (mapId === "luna" && nextLobbyForecastRandom() < 0.75) {
    return 2;
  }

  const entry = pickWeighted(FORECAST_TEAM_WEIGHTS);
  return entry ? entry.config : 2;
}

function teamConfigToTeamSize(teamConfig) {
  if (teamConfig === "duos") {
    return 2;
  }
  if (teamConfig === "trios") {
    return 3;
  }
  if (teamConfig === "quads") {
    return 4;
  }
  return typeof teamConfig === "number" ? teamConfig : null;
}

function getRandomSpecialModifiers(excluded, countReduction = 0) {
  const excludedSet = new Set(excluded);
  const rolledCount =
    FORECAST_SPECIAL_COUNT_ROLLS[
    Math.floor(nextLobbyForecastRandom() * FORECAST_SPECIAL_COUNT_ROLLS.length)
    ];
  const wantedCount = Math.max(0, rolledCount - countReduction);

  const pool = FORECAST_SPECIAL_MODIFIER_POOL.filter(
    (key) => !excludedSet.has(key),
  );
  shuffleInPlace(pool);

  const selected = new Set();
  for (const key of pool) {
    if (selected.size >= wantedCount) {
      break;
    }

    const blocked = FORECAST_MUTUALLY_EXCLUSIVE_MODIFIERS.some(
      ([left, right]) =>
        (key === left && selected.has(right)) ||
        (key === right && selected.has(left)),
    );

    if (!blocked) {
      selected.add(key);
    }
  }

  let startingGold = 0;
  if (selected.has("startingGold25M")) startingGold = 25_000_000;
  else if (selected.has("startingGold5M")) startingGold = 5_000_000;
  else if (selected.has("startingGold1M")) startingGold = 1_000_000;

  return {
    isRandomSpawn: selected.has("isRandomSpawn"),
    isCompact: selected.has("isCompact"),
    isCrowded: selected.has("isCrowded"),
    startingGold,
    goldMultiplier: selected.has("goldMultiplier") ? 2 : 1,
    isAlliancesDisabled: selected.has("isAlliancesDisabled"),
    isPortsDisabled: selected.has("isPortsDisabled"),
    isNukesDisabled: selected.has("isNukesDisabled"),
    isSAMsDisabled: selected.has("isSAMsDisabled"),
    isMirvDisabled: selected.has("isMirvDisabled"),
    isWaterNukes: selected.has("isWaterNukes"),
    isPeaceTime: selected.has("isPeaceTime"),
  };
}

function createStandardForecastScenario(mapId, teamSize, compact = false) {
  return {
      mapId,
      teamSize,
      startingGold0M: true,
      randomSpawn: false,
      crowded: false,
      compact,
      alliancesDisabled: false,
      portsDisabled: false,
      nukesDisabled: false,
      samsDisabled: false,
      mirvDisabled: false,
      waterNukes: false,
      peaceTime4m: false,
      startingGold1M: false,
      startingGold5M: false,
      startingGold25M: false,
      goldMultiplier2x: false,
    };
}

function getSpecialForecastExclusions(mapId, isTeamMode, teamConfig) {
  const excludedModifiers = [];
  if (["duos", "trios", "quads"].includes(teamConfig)) excludedModifiers.push("isRandomSpawn");
  if (mapId === "fourislands" && isTeamMode) excludedModifiers.push("goldMultiplier", "startingGold25M");
  if (isTeamMode) excludedModifiers.push("isHardNations");
  if (teamConfig === "humansVsNations") excludedModifiers.push("startingGold25M", "isPeaceTime");
  return excludedModifiers;
}

function createForecastScenario(type, weightedMaps = null) {
  const map = weightedMaps
    ? pickWeighted(weightedMaps.items, weightedMaps.total)
    : pickWeighted(getForecastMapsForType(type));
  if (!map) return null;
  // Scheduled FFA/Team lobbies roll Compact every 3rd playlist rotation
  // (MapPlaylist.gameConfig: playlists[type].length % 3 === 0).
  if (type === "ffa") {
    return createStandardForecastScenario(map.id, 1, nextLobbyForecastRandom() < 1 / 3);
  }

  if (type === "team") {
    const teamConfig = randomTeamConfigForMap(map.id);
    return createStandardForecastScenario(
      map.id,
      teamConfigToTeamSize(teamConfig),
      nextLobbyForecastRandom() < 1 / 3,
    );
  }

  const isTeamMode = nextLobbyForecastRandom() >= 0.5;
  const teamConfig = isTeamMode ? randomTeamConfigForMap(map.id) : null;
  const excludedModifiers = getSpecialForecastExclusions(map.id, isTeamMode, teamConfig);

  let forcedWaterNukes = false;
  if (FORECAST_WATER_NUKES_BOOSTED_MAPS.has(map.id) && nextLobbyForecastRandom() < 0.5) {
    excludedModifiers.push("isWaterNukes", "isNukesDisabled");
    forcedWaterNukes = true;
  }

  const specialModifiers = getRandomSpecialModifiers(
    excludedModifiers,
    forcedWaterNukes ? 1 : 0,
  );
  const teamSize = teamConfigToTeamSize(teamConfig);
  const startingGold = specialModifiers.startingGold;
  const scenarioTeamSize = isTeamMode ? teamSize : 1;

  return {
    mapId: map.id,
    teamSize: scenarioTeamSize,
    startingGold0M: startingGold === 0,
    randomSpawn: specialModifiers.isRandomSpawn,
    crowded: specialModifiers.isCrowded,
    compact: specialModifiers.isCompact,
    alliancesDisabled: specialModifiers.isAlliancesDisabled,
    portsDisabled: specialModifiers.isPortsDisabled,
    nukesDisabled: specialModifiers.isNukesDisabled,
    samsDisabled: specialModifiers.isSAMsDisabled,
    mirvDisabled: specialModifiers.isMirvDisabled || specialModifiers.isNukesDisabled,
    waterNukes: forcedWaterNukes || specialModifiers.isWaterNukes,
    peaceTime4m: specialModifiers.isPeaceTime,
    startingGold1M: startingGold === 1_000_000,
    startingGold5M: startingGold === 5_000_000,
    startingGold25M: startingGold === 25_000_000,
    goldMultiplier2x: specialModifiers.goldMultiplier === 2,
  };
}

function scenarioMatchesTeamSizeRange(scenario, settings = lobbyState.settings) {
  if (settings.minTeamSize == null && settings.maxTeamSize == null) {
    return true;
  }

  const teamSize = scenario?.teamSize;
  if (!Number.isFinite(teamSize)) {
    return false;
  }

  if (settings.minTeamSize != null && teamSize < settings.minTeamSize) {
    return false;
  }

  if (settings.maxTeamSize != null && teamSize > settings.maxTeamSize) {
    return false;
  }

  return true;
}

// Keep this snapshot local to one synchronous model calculation: settings and
// map catalogues may change before the next cache miss.
function createForecastFilterContext() {
  const settings = lobbyState.settings;
  return {
    includedMapIds: new Set(MAP_IDS.filter((id) => settings.mapFilters[id])),
    excludedMapIds: new Set(MAP_IDS.filter((id) => settings.mapExcludeFilters[id])),
    minTeamSize: settings.minTeamSize,
    maxTeamSize: settings.maxTeamSize,
    modifierConstraints: FILTER_KEYS
      .filter((key) => !START_GOLD_FILTER_KEYS.includes(key))
      .map((key) => ({
        key,
        include: settings.includeFilters[key],
        exclude: settings.excludeFilters[key],
      }))
      .filter((entry) => entry.include || entry.exclude),
    startGoldIncludes: START_GOLD_FILTER_KEYS.filter((key) => settings.includeFilters[key]),
    startGoldExcludes: START_GOLD_FILTER_KEYS.filter((key) => settings.excludeFilters[key]),
  };
}

function scenarioMatchesFilters(scenario, filterContext = null) {
  if (!scenario || !scenario.mapId) {
    return false;
  }

  const context = filterContext || createForecastFilterContext();
  if (context.excludedMapIds.has(scenario.mapId)) {
    return false;
  }
  if (context.includedMapIds.size > 0 && !context.includedMapIds.has(scenario.mapId)) {
    return false;
  }
  if (!scenarioMatchesTeamSizeRange(scenario, context)) {
    return false;
  }

  // Team-count filters remain real-lobby-only: synthetic scenarios do not
  // carry that dimension, so this forecast can slightly over-estimate hits.
  const nonStartGoldMatches = context.modifierConstraints.every((entry) => {
    if (entry.include && !scenario[entry.key]) return false;
    if (entry.exclude && scenario[entry.key]) return false;
    return true;
  });
  if (!nonStartGoldMatches) return false;
  if (context.startGoldExcludes.some((key) => scenario[key] === true)) return false;
  if (context.startGoldIncludes.length === 0) return true;
  return context.startGoldIncludes.some((key) => scenario[key] === true);
}

function estimateModelHitRateByType(type, filterContext = null) {
  const context = filterContext || createForecastFilterContext();
  const items = getForecastMapsForType(type);
  // Sum in the same order as pickWeighted; retain its subtraction and <=
  // boundary rather than changing to cumulative weights or a binary search.
  const weightedMaps = { items, total: items.reduce((sum, item) => sum + item.weight, 0) };
  let matches = 0;
  let total = 0;
  for (let i = 0; i < LOBBY_FORECAST_MODEL_DRAWS; i += 1) {
    const scenario = createForecastScenario(type, weightedMaps);
    if (!scenario) {
      continue;
    }
    total += 1;
    if (scenarioMatchesFilters(scenario, context)) {
      matches += 1;
    }
  }
  if (total === 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, matches / total));
}

function getModelHitRates() {
  const signature = createForecastFilterSignature();
  if (lobbyForecastModelCache.signature === signature) {
    return lobbyForecastModelCache.values;
  }

  const context = createForecastFilterContext();
  const values = {
    special: estimateModelHitRateByType("special", context),
    ffa: estimateModelHitRateByType("ffa", context),
    team: estimateModelHitRateByType("team", context),
  };
  lobbyForecastModelCache = {
    signature,
    values,
  };
  return values;
}

function getForecastGroupWeights() {
  const total =
    lobbyForecastNewByGroup.special +
    lobbyForecastNewByGroup.ffa +
    lobbyForecastNewByGroup.team;

  if (total >= LOBBY_FORECAST_MIN_GROUP_SAMPLES_FOR_WEIGHTING) {
    return {
      special: lobbyForecastNewByGroup.special / total,
      ffa: lobbyForecastNewByGroup.ffa / total,
      team: lobbyForecastNewByGroup.team / total,
    };
  }

  return {
    special: 1 / 3,
    ffa: 1 / 3,
    team: 1 / 3,
  };
}

function getModelHitRate() {
  const modelRates = getModelHitRates();
  const weights = getForecastGroupWeights();
  return (
    modelRates.special * weights.special +
    modelRates.ffa * weights.ffa +
    modelRates.team * weights.team
  );
}

function withForecastWindow(samples, maxCount) {
  if (samples.length <= maxCount) {
    return samples;
  }
  return samples.slice(samples.length - maxCount);
}

function quantile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile)));
  return sorted[index];
}

function estimateLobbiesUntilMatch(p, percentile) {
  if (!(p > 0 && p < 1)) {
    return p >= 1 ? 1 : null;
  }

  const remainingProbability = 1 - percentile;
  if (!(remainingProbability > 0 && remainingProbability < 1)) {
    return null;
  }

  const value = Math.log(remainingProbability) / Math.log(1 - p);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.ceil(value)) : null;
}

function getForecastLobbiesPerSecond(last100Averages) {
  if (lobbyForecastNewLobbyTimestamps.length >= 2) {
    const firstSeen = lobbyForecastNewLobbyTimestamps[0];
    const lastSeen = lobbyForecastNewLobbyTimestamps.at(-1);
    const durationMs = Math.max(1, lastSeen - firstSeen);
    return (lobbyForecastNewLobbyTimestamps.length - 1) / (durationMs / 1000);
  }
  const intervalMs = positiveFiniteOrNull(last100Averages.avgLobbyIntervalMs);
  return intervalMs == null ? null : 1000 / intervalMs;
}

function getForecastEtaSeconds(lobbies, lobbiesPerSecond) {
  if (lobbies == null || lobbiesPerSecond == null || lobbiesPerSecond <= 0) return null;
  return Math.max(1, Math.round(lobbies / lobbiesPerSecond));
}

function buildLobbyForecastPayload() {
  const last100Averages = computeLast100LobbyAverages();

  if (!hasSelectedCriteria()) {
    return {
      available: false,
      sampleSize: lobbyForecastTotalNew,
      etaMinSeconds: null,
      etaMaxSeconds: null,
      hitChanceNext10: null,
      medianLobbiesToMatch: null,
      last100Averages,
    };
  }

  const modelHitRate = getModelHitRate();
  const rollingHitRate = last100Averages.hitRate;
  const rollingSampleSize =
    Number.isFinite(rollingHitRate) &&
      last100Averages.hitSampleSize >= LOBBY_FORECAST_MIN_MATCH_SAMPLES_FOR_ROLLING
      ? last100Averages.sampleSize
      : 0;
  const rollingHits = Number.isFinite(rollingHitRate)
    ? rollingHitRate * rollingSampleSize
    : 0;
  const sessionSampleSize = rollingSampleSize === 0 ? lobbyForecastTotalNew : 0;
  const sessionHits = rollingSampleSize === 0 ? lobbyForecastMatchedNew : 0;
  const posteriorHitRate =
    (rollingHits + sessionHits + modelHitRate * LOBBY_FORECAST_PRIOR_STRENGTH) /
    (rollingSampleSize + sessionSampleSize + LOBBY_FORECAST_PRIOR_STRENGTH);
  const hitRate = Math.max(0, Math.min(1, posteriorHitRate));
  const etaHitRate = hitRate > 0 ? hitRate : Math.max(modelHitRate, 1 / LOBBY_FORECAST_MODEL_DRAWS);
  const hitChanceNext10 = 1 - (1 - hitRate) ** 10;

  const medianEmpirical = quantile(lobbyForecastDistanceSamples, 0.5);
  const medianModel = estimateLobbiesUntilMatch(etaHitRate, 0.5);
  const medianLobbiesToMatch = medianEmpirical ?? medianModel;
  const minLobbiesEmpirical = quantile(lobbyForecastDistanceSamples, 0.25);
  const maxLobbiesEmpirical = quantile(lobbyForecastDistanceSamples, 0.75);
  const minLobbiesModel = estimateLobbiesUntilMatch(etaHitRate, 0.25);
  const maxLobbiesModel = estimateLobbiesUntilMatch(etaHitRate, 0.75);
  const minLobbies = minLobbiesEmpirical ?? minLobbiesModel;
  const maxLobbies = maxLobbiesEmpirical ?? maxLobbiesModel;

  const lobbiesPerSecond = getForecastLobbiesPerSecond(last100Averages);
  const etaMinSeconds = getForecastEtaSeconds(minLobbies, lobbiesPerSecond);
  const etaMaxSeconds = getForecastEtaSeconds(maxLobbies, lobbiesPerSecond);

  return {
    available: true,
    sampleSize: lobbyForecastTotalNew,
    etaMinSeconds: positiveFiniteOrNull(etaMinSeconds),
    etaMaxSeconds: positiveFiniteOrNull(etaMaxSeconds),
    hitChanceNext10: Number.isFinite(hitChanceNext10) ? hitChanceNext10 : null,
    medianLobbiesToMatch:
      medianLobbiesToMatch != null ? Math.max(1, Math.round(medianLobbiesToMatch)) : null,
    last100Averages,
  };
}

function persistLobbyForecast(force = false) {
  if (!isExtensionContextAlive()) {
    return;
  }

  let payload;
  let serialized;
  {
    payload = buildLobbyForecastPayload();
    serialized = JSON.stringify(payload);
  }

  if (!force && serialized === lobbyForecastLastPersistedPayload) {
    return;
  }

  const now = Date.now();
  if (!force && now - lobbyForecastLastPersistedAt < LOBBY_FORECAST_PERSIST_MS) {
    return;
  }

  lobbyForecastLastPersistedAt = now;
  lobbyForecastLastPersistedPayload = serialized;
  (async () => {
    {
      if (!isExtensionContextAlive()) {
        return;
      }

      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (!isExtensionContextAlive()) {
        return;
      }

      const freshestSettings = normalizeSettings(stored[STORAGE_KEY]);
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          ...freshestSettings,
          lobbyForecast: payload,
        },
      });
    }
  })();
}

function updateLobbyForecast(snapshot) {
  if (!isExtensionContextAlive()) {
    return;
  }

  const currentFilterSignature = createForecastFilterSignature();
  const criteriaSelected = hasSelectedCriteria();
  const lobbies = getDisplayedLobbies(snapshot);
  const currentIds = lobbies
    .map(({ lobby }) => String(lobby?.gameID || ""))
    .filter(Boolean);

  if (lobbyForecastFilterSignature !== currentFilterSignature) {
    lobbyForecastFilterSignature = currentFilterSignature;
    lobbyForecastRecentMatchOutcomes = [];
    resetLobbyForecastTracking(currentIds);
    persistLobbyForecast(true);
    return;
  }

  const now = Date.now();
  for (const { lobby, groupKey } of lobbies) {
    const gameID = String(lobby?.gameID || "");
    if (!gameID || lobbyForecastSeenIds.has(gameID)) {
      continue;
    }

    lobbyForecastSeenIds.add(gameID);
    if (!criteriaSelected) {
      updateLast100LobbyAverages(now, null);
      continue;
    }

    lobbyForecastTotalNew += 1;
    lobbyForecastSinceLastMatch += 1;
    if (groupKey === "special" || groupKey === "ffa" || groupKey === "team") {
      lobbyForecastNewByGroup[groupKey] += 1;
    }
    lobbyForecastNewLobbyTimestamps.push(now);
    lobbyForecastNewLobbyTimestamps = withForecastWindow(
      lobbyForecastNewLobbyTimestamps,
      LOBBY_FORECAST_MAX_RATE_SAMPLES,
    );

    const isMatch = lobbyMatchesFilters(lobby, groupKey);
    updateLast100LobbyAverages(now, isMatch);

    if (isMatch) {
      lobbyForecastMatchedNew += 1;
      lobbyForecastDistanceSamples.push(lobbyForecastSinceLastMatch);
      lobbyForecastDistanceSamples = withForecastWindow(
        lobbyForecastDistanceSamples,
        LOBBY_FORECAST_MAX_DISTANCE_SAMPLES,
      );
      lobbyForecastSinceLastMatch = 0;
    }
  }

  if (!criteriaSelected) {
    lobbyForecastRecentMatchOutcomes = [];
  }

  persistLobbyForecast();
}

// The lobby cards the game's main menu actually renders: the FIRST lobby of
// each scheduled group (GameModeSelector renders games[type][0] only — the
// master keeps [0] active with a countdown while deeper entries sit in the
// queue, unshown until they rotate up). Auto-join and the forecast must act on
// exactly these cards: joining a queued games[type][1..] lobby would enter a
// game the client isn't displaying yet, and "hosted" lobbies never appear as
// main-menu cards at all (they only live in the join-lobby browser).
function getDisplayedLobbies(snapshot) {
  const groups = snapshot?.games;
  if (!groups || typeof groups !== "object") {
    return [];
  }

  const displayed = [];
  for (const groupKey of PREFERRED_GROUP_ORDER) {
    const lobby = groups[groupKey]?.[0];
    if (lobby) {
      displayed.push({ groupKey, lobby });
    }
  }

  return displayed;
}

function findMatchingLobby(snapshot) {
  pruneCooldowns();

  const match = getDisplayedLobbies(snapshot).find(({ lobby, groupKey }) => {
    if (!lobby?.gameID || lobbyCooldowns.has(lobby.gameID)) {
      return false;
    }

    return lobbyMatchesFilters(lobby, groupKey);
  });

  return match?.lobby ?? null;
}

function ensureJoinAlertAudio() {
  if (lobbyState.joinAlertAudio) {
    return lobbyState.joinAlertAudio;
  }

  lobbyState.joinAlertAudio = new Audio(chrome.runtime.getURL("assets/autojoin.mp3"));
  lobbyState.joinAlertAudio.preload = "auto";
  return lobbyState.joinAlertAudio;
}

function ensureCustomJoinAlertAudio() {
  if (!lobbyState.customNotificationSoundData) {
    lobbyState.customJoinAlertAudio = null;
    return null;
  }

  if (lobbyState.customJoinAlertAudio?.src === lobbyState.customNotificationSoundData) {
    return lobbyState.customJoinAlertAudio;
  }

  lobbyState.customJoinAlertAudio = new Audio(lobbyState.customNotificationSoundData);
  lobbyState.customJoinAlertAudio.preload = "auto";
  return lobbyState.customJoinAlertAudio;
}

function tryPlayAudio(audio) {
  if (!audio) {
    return false;
  }

  {
    audio.currentTime = 0;
    void audio.play();
    return true;
  }
}

function playJoinAlert() {
  if (
    lobbyState.hasCustomNotificationSound &&
    tryPlayAudio(ensureCustomJoinAlertAudio())
  ) {
    return;
  }

  {
    tryPlayAudio(ensureJoinAlertAudio());
  }
}

async function disableAutoJoin() {
  lobbyState.settings = {
    ...lobbyState.settings,
    enabled: false,
    searchStartedAt: null,
  };

  await chrome.storage.local.set({
    [STORAGE_KEY]: lobbyState.settings,
  });
}

async function requestJoin(lobby) {
  lobbyState.lastJoinRequestedAt = Date.now();
  lobbyState.pendingJoin = {
    gameID: lobby.gameID,
    startedAt: Date.now(),
  };
  armGameStartNotification(lobby.gameID);

  lobbyCooldowns.set(lobby.gameID, Date.now() + LOBBY_RETRY_COOLDOWN_MS);

  if (lobbyState.settings.joinNotification) {
    {
      await chrome.runtime.sendMessage({
        type: "SHOW_JOIN_NOTIFICATION",
        gameID: lobby.gameID,
        text: t("Lobby found — joining!"),
      });
    }
  }

  // Normally auto-join turns itself off once it joins a match. With "keep
  // searching" on, leave the toggle ENABLED — isOccupied() (waiting modal / live
  // game) pauses searching meanwhile, and it resumes when we return to the menu.
  if (!lobbyState.settings.keepAutoJoinAfterMatch) {
    await disableAutoJoin();
  }
  // The userscript's notification (in-page toast + OS notification) is SILENT — the old
  // extension build had a separate notification window that made its own sound — so we ring
  // the alert here whenever notifications are on. With them off, stay silent: the
  // "Found-game notification" toggle governs BOTH the popup and the chime.
  if (lobbyState.settings.joinNotification) {
    playJoinAlert();
  }

  window.postMessage(
    {
      source: BRIDGE_SOURCE_EXTENSION,
      type: "JOIN_PUBLIC_LOBBY",
      payload: {
        gameID: lobby.gameID,
        publicLobbyInfo: lobby,
      },
    },
    "*",
  );
}

function tryAutoJoin() {
  resetPendingJoinIfExpired();

  // noteOccupancy() refreshes lobbyState.lastOccupiedAt as a side effect; recentlyOccupied()
  // is the grace-window backstop that blocks a join during the game-start gap
  // even if every DOM "occupied" signal momentarily reads false.
  if (
    !lobbyState.settings.enabled ||
    !lobbyState.latestLobbySnapshot ||
    lobbyState.pendingJoin ||
    noteOccupancy() ||
    recentlyOccupied()
  ) {
    return;
  }

  const matchingLobby = findMatchingLobby(lobbyState.latestLobbySnapshot);
  if (!matchingLobby) {
    return;
  }

  logAutoJoinDecision("join", matchingLobby);
  requestJoin(matchingLobby);
}

// Detect the return to the menu (occupied → free): the game ended OR the user
// backed out of the lobby. With "keep searching" on, restart the search with a
// fresh timer. Runs on a timer so it works without a full page reload.
//
// The transition is debounced: we only treat "free" as a genuine return to the
// menu once it has been stable for RESUME_GRACE_MS. During the game-start
// loading gap the occupied signals can briefly drop to false; without the
// debounce that edge looked like "returned to menu" and immediately searched +
// joined a DIFFERENT lobby while the chosen game was still starting.
function pollAutoJoinResume() {
  if (noteOccupancy()) {
    lobbyState.wasOccupied = true;
    return;
  }

  expirePendingGameStartNotification();

  // Un-occupied now — but wait out the grace so a transient startup blip doesn't
  // masquerade as a return to the menu.
  if (lobbyState.wasOccupied && !recentlyOccupied()) {
    lobbyState.wasOccupied = false;
    lobbyState.sawLobbyWaitingBeforeGameStart = false;
    if (lobbyState.settings.enabled && lobbyState.settings.keepAutoJoinAfterMatch) {
      lobbyState.settings = { ...lobbyState.settings, searchStartedAt: Date.now() };
      chrome.storage.local.set({ [STORAGE_KEY]: lobbyState.settings });
      resetLobbyForecastTracking();
    }
    tryAutoJoin();
  }
}

function handleBridgeMessage(event) {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE_PAGE) {
    return;
  }

  if (data.type === "GAME_STARTED") {
    handleGameStarted();
    return;
  }

  if (data.type === "PUBLIC_LOBBIES_UPDATE") {
    // Declared in core.js; both files share one concatenated userscript scope.
    lobbyState.latestLobbySnapshot = data.payload;
    {
      updateLobbyForecast(lobbyState.latestLobbySnapshot);
      tryAutoJoin();
    }
    return;
  }

  if (data.type === "SELECTIVE_TRADE_POLICY_AVAILABILITY") {
    updateAutoCancelDeniedTradesAvailability(data.payload?.available);
  }
}

async function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }

  const previousLanguage = lobbyState.settings.language;
  const previousForecastSignature = createForecastFilterSignature();
  lobbyState.settings = normalizeSettings(changes[STORAGE_KEY].newValue);
  if (lobbyState.settings.language !== previousLanguage) {
    await loadContentTranslations();
    document.getElementById(FLOATING_HELPERS_PANEL_ID)?.remove();
    document.getElementById(FLOATING_AUTOJOIN_PANEL_ID)?.remove();
  }
  lobbyState.selectiveTradePolicyAvailable = Boolean(lobbyState.settings.autoCancelDeniedTradesAvailable);
  syncHelpers();
  syncFloatingHelpersPanel();
  syncFloatingAutoJoinPanel();
  if (!lobbyState.settings.enabled) {
    lobbyState.pendingJoin = null;
  }
  const nextForecastSignature = createForecastFilterSignature();
  if (nextForecastSignature !== previousForecastSignature) {
    lobbyForecastFilterSignature = nextForecastSignature;
    lobbyForecastRecentMatchOutcomes = [];
    resetLobbyForecastTracking(
      lobbyState.latestLobbySnapshot
        ? getDisplayedLobbies(lobbyState.latestLobbySnapshot)
          .map(({ lobby }) => String(lobby?.gameID || ""))
          .filter(Boolean)
        : [],
    );
    persistLobbyForecast(true);
  }
  tryAutoJoin();
}

// Content script bootstrap -------------------------------------------------
async function init() {
  window.addEventListener("message", handleBridgeMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.storage.onChanged.addListener((changes) => {
    if ("joinNotificationSoundData" in changes) {
      lobbyState.customNotificationSoundData =
        typeof changes.joinNotificationSoundData.newValue === "string"
          ? changes.joinNotificationSoundData.newValue
          : null;
      lobbyState.hasCustomNotificationSound = Boolean(lobbyState.customNotificationSoundData);
      if (!lobbyState.hasCustomNotificationSound) {
        lobbyState.customJoinAlertAudio = null;
      }
    }
  });
  await loadSettings();
  // Full reload back to the menu while "keep searching" is on → start a fresh
  // search timer instead of carrying the stale one from before the last game.
  if (lobbyState.settings.enabled && lobbyState.settings.keepAutoJoinAfterMatch) {
    lobbyState.settings = { ...lobbyState.settings, searchStartedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: lobbyState.settings });
  }
  lobbyForecastFilterSignature = createForecastFilterSignature();
  resetLobbyForecastTracking();
  persistLobbyForecast(true);
  const soundStore = await chrome.storage.local.get("joinNotificationSoundData");
  lobbyState.customNotificationSoundData =
    typeof soundStore.joinNotificationSoundData === "string"
      ? soundStore.joinNotificationSoundData
      : null;
  lobbyState.hasCustomNotificationSound = Boolean(lobbyState.customNotificationSoundData);
  window.addEventListener("resize", () => {
    const panel = document.getElementById(FLOATING_HELPERS_PANEL_ID);
    if (panel) {
      positionFloatingHelpersPanel(panel);
    }
    const autoJoinPanel = document.getElementById(FLOATING_AUTOJOIN_PANEL_ID);
    if (autoJoinPanel) {
      positionFloatingAutoJoinPanel(autoJoinPanel);
    }
  });
  ensureJoinAlertAudio();
  ensureCustomJoinAlertAudio();
  tryAutoJoin();
  window.setInterval(resetPendingJoinIfExpired, 1000);
  window.setInterval(pollAutoJoinResume, 1000);
}

init();
