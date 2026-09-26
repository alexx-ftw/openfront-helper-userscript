// WebSocket hook — intercept game packets for direct actions (kill shot, embargo,
// donate, chat) and skin unlocker. Modeled after Project Blon's NativeWS technique.
// Runs early in the INGAME_FILES order so it captures the game's WebSocket before
// the first connect.

// ---- WebSocket capture (Blon technique) ----

const _NativeWS = window.WebSocket;
const _NativeSend = _NativeWS.prototype.send;
var _activeSocket = null;
var _lastKnownTile = null;
var _wsConnectionState = false;

// Replace the WebSocket constructor so we can track the active game socket.
window.WebSocket = function(url, protocols) {
  var sock = protocols !== void 0 ? new _NativeWS(url, protocols) : new _NativeWS(url);
  roundLogRecord("websocket_opening", { url: String(url), protocols: protocols || null });
  sock.addEventListener("open", function() {
    roundLogRecord("websocket_open", { url: String(url), protocol: sock.protocol });
  });
  sock.addEventListener("message", async function(event) {
    const data = event.data;
    if (typeof data === "string") {
      roundLogRecord("websocket_received", { raw: data });
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      roundLogRecord("websocket_received", {
        data: { kind: "Blob", type: data.type, size: data.size, base64: roundLogEncodeBytes(buffer) },
      });
    } else {
      roundLogRecord("websocket_received", { data: roundLogClone(data) });
    }
  });
  sock.addEventListener("error", function() {
    roundLogRecord("websocket_error", { url: String(url), readyState: sock.readyState });
  });
  sock.addEventListener("close", function() {
    roundLogRecord("websocket_close", { url: String(url), readyState: sock.readyState });
    if (_activeSocket === sock) {
      roundLogFinishMatch("websocket_close");
      _activeSocket = null;
      { if (window.top) window.top.__ohActiveSocket = null; }
      _setWsConnectionState(false);
      { _uninstallParseHook(); }
      _resolvedSkin = null;
      _desiredCosmetics = null;
    }
  });
  return sock;
};
window.WebSocket.prototype = _NativeWS.prototype;
Object.getOwnPropertyNames(_NativeWS).forEach(function(k) {
  { window.WebSocket[k] = _NativeWS[k]; }
});

function _captureActiveGameSocket(socket, message) {
  const isGameMessage = (message.type === "intent" && message.intent) ||
    message.type === "quick_chat" || message.type === "ping";
  if (!isGameMessage || _activeSocket === socket) return;
  _activeSocket = socket;
  { if (window.top) window.top.__ohActiveSocket = socket; }
  _setWsConnectionState(true);
}

function _trackIntentTiles(message) {
  const intent = message.intent || message;
  for (const key of ["tile", "dst", "src"]) {
    if (typeof intent[key] === "number") _setLastKnownTile(intent[key]);
  }
}

function _rewriteJoinMessage(message) {
  if (message.type !== "join") return null;
  _myUsername = message.username;
  if (!_skinUnlockerEnabled) return null;
  _desiredCosmetics = message.cosmetics || {};
  if (_cosmeticsData) _resolvedSkin = _resolveSkin(_desiredCosmetics);
  message.cosmetics = {};
  _installParseHook();
  return JSON.stringify(message);
}

function _processOutgoingSocketData(socket, data) {
  if (typeof data !== "string") return data;
  {
    const message = JSON.parse(data);
    if (!message) return data;
    _captureActiveGameSocket(socket, message);
    _trackIntentTiles(message);
    return _rewriteJoinMessage(message) || data;
  }
}

_NativeWS.prototype.send = function(data) {
  const processed = _processOutgoingSocketData(this, data);
  if (typeof processed === "string") {
    roundLogRecord("websocket_sent", { raw: processed });
  } else {
    roundLogRecord("websocket_sent", { data: roundLogClone(processed) });
  }
  return _NativeSend.call(this, processed);
};

function _setWsConnectionState(state) {
  _wsConnectionState = state;
  {
    var el = document.getElementById("ohqp-connection");
    if (el) el.dataset.status = state ? "connected" : "disconnected";
  }
}

function _setLastKnownTile(tile) {
  _lastKnownTile = tile;
  { if (window.top) window.top.__ohLastKnownTile = tile; }
}

function getActiveSocket() {
  if (_activeSocket && _activeSocket.readyState === (_NativeWS.OPEN || 1)) return _activeSocket;
  {
    if (window.top && window.top.__ohActiveSocket
        && window.top.__ohActiveSocket.readyState === (_NativeWS.OPEN || 1))
      return window.top.__ohActiveSocket;
  }
  return null;
}

function getLastKnownTile() {
  {
    if (window.top && window.top.__ohLastKnownTile != null)
      return window.top.__ohLastKnownTile;
  }
  return _lastKnownTile;
}

function isSocketConnected() {
  var sock = getActiveSocket();
  return Boolean(sock && sock.readyState === (_NativeWS.OPEN || 1));
}

// Send a game intent packet directly through the WebSocket. The object is
// wrapped as {type:"intent", intent:obj}. Returns true on success.
function sendGamePacket(obj) {
  var sock = getActiveSocket();
  if (!sock || sock.readyState !== (_NativeWS.OPEN || 1)) return false;
  {
    var payload = JSON.stringify({ type: "intent", intent: obj });
    // Keep direct fallback packets under the same client-side budget as
    // EventBus intents. Failing closed avoids silently bypassing the server's
    // 10/sec and 150/min limiter if the shared gate is unavailable.
    if (
      typeof tryAcquireIntentRateLimit !== "function" ||
      !tryAcquireIntentRateLimit(obj?.type)
    ) {
      return false;
    }
    _NativeSend.call(sock, payload);
    return true;
  }
}

// Send a raw top-level packet (no intent wrapper). Use for quick_chat, ping,
// and other messages that are NOT game intents.
function sendRawPacket(obj) {
  var sock = getActiveSocket();
  if (!sock || sock.readyState !== (_NativeWS.OPEN || 1)) return false;
  {
    _NativeSend.call(sock, JSON.stringify(obj));
    return true;
  }
}

// ---- Skin unlocker (fetch + JSON.parse hooks) — 1:1 port from Project Blon ----

// Blon reads cfg.features?.skinUnlocker LIVE on every hook call (cfg is loaded
// from localStorage at script start). Mirror that: read the persisted settings
// directly so the hook is armed from page load — the join message fires BEFORE
// any UI toggle could call a setter. The setter below just refreshes the cache.
var _skinUnlockerEnabled = false;
{
  var _rawSettings = localStorage.getItem("ofh:settings");
  if (_rawSettings) {
    var _parsedSettings = JSON.parse(_rawSettings);
    _skinUnlockerEnabled = Boolean(_parsedSettings && _parsedSettings.skinUnlocker);
  }
}

var _cosmeticsData = null;
var _desiredCosmetics = null;
var _resolvedSkin = null;
var _myUsername = null;

var _originalFetch = window.fetch;
var _originalParse = JSON.parse;

// resolveSkin — Blon 1:1: refs = {flag, color, patternName, patternColorPaletteName}
// (the REFS the game's join message carries). flag/color are copied/wrapped
// DIRECTLY; the pattern is looked up BY NAME across cosmeticsData.patterns and
// emitted as result.pattern = {name, patternData, colorPalette}.
function _resolvePatternPalette(refs) {
  const palette = _cosmeticsData.colorPalettes?.[refs.patternColorPaletteName];
  if (palette) return palette;
  if (!refs.patternColorPaletteName) return null;
  return {
    name: refs.patternColorPaletteName || "fallback",
    primaryColor: "#00ff00",
    secondaryColor: "#00aa00",
  };
}

function _resolveSkinPattern(refs) {
  if (!refs.patternName) return null;
  for (const pattern of Object.values(_cosmeticsData.patterns || {})) {
    if (pattern.name !== refs.patternName) continue;
    const result = { name: pattern.name, patternData: pattern.pattern };
    const palette = _resolvePatternPalette(refs);
    if (palette) result.colorPalette = palette;
    return result;
  }
  return null;
}

function _resolveSkin(refs) {
  if (!refs || !_cosmeticsData) return null;
  var result = {};
  if (refs.flag) result.flag = refs.flag;
  if (refs.color && typeof refs.color === "string") result.color = { color: refs.color };
  const pattern = _resolveSkinPattern(refs);
  if (pattern) result.pattern = pattern;
  return Object.keys(result).length > 0 ? result : null;
}

// hookedFetch — Blon 1:1: cache cosmetics.json; mod /users/@me json()/text() to
// inject pattern:* flare + donor role. Gate on the live enabled flag per-call.
function _getFetchUrl(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return input.url || (input instanceof URL ? input.href : "");
}

function _captureCosmeticsResponse(response) {
  response.clone().json().then((data) => { _cosmeticsData = data; });
  return response;
}

function _addUnlockedCosmetics(data) {
  if (!data?.player) return data;
  data.player.flares ||= [];
  if (!data.player.flares.includes("pattern:*")) data.player.flares.push("pattern:*");
  data.player.roles ||= [];
  if (!data.player.roles.includes("donor")) data.player.roles.push("donor");
  return data;
}

function _modifyUserResponse(response) {
  const modified = new Response(response.body, response);
  const readJson = () => response.clone().text().then((text) =>
    _addUnlockedCosmetics(_originalParse(text)));
  modified.json = readJson;
  modified.text = () => readJson().then((data) => JSON.stringify(data));
  return modified;
}

var _hookedFetch = function(input, init) {
  const request = () => _originalFetch.call(window, input, init);
  if (!_skinUnlockerEnabled) return request();
  const url = _getFetchUrl(input);
  if (url.includes("cosmetics.json")) return request().then(_captureCosmeticsResponse);
  if (url.includes("/users/@me")) return request().then(_modifyUserResponse);
  return request();
};
{
  Object.defineProperty(window, "fetch", {
    value: _hookedFetch,
    writable: false,
    configurable: true
  });
}

// hookedParse — Blon 1:1: inject resolved skin into MY player entry inside
// start/lobby_info messages. Prefer clientID match, fallback to username.
// PERF: this hook wraps EVERY JSON.parse the game does (every WS message,
// every asset, the lobby list poll). Fast-path out unless BOTH the unlocker
// is on AND a join already captured cosmetics to re-inject — before a join
// there is nothing to do, so the lobby's heavy parses stay zero-cost.
function _getSkinMessagePlayers(message) {
  if (message.type === "start") return message.gameStartInfo?.players || [];
  if (message.type === "lobby_info") return message.lobby?.clients || message.lobby?.players || [];
  return null;
}

function _findSkinPlayer(players, clientId) {
  if (clientId) {
    const player = players.find((entry) => entry.clientID === clientId);
    if (player) return player;
  }
  return _myUsername
    ? players.find((entry) => entry.username === _myUsername) || null
    : null;
}

function _injectResolvedSkin(message) {
  const players = _getSkinMessagePlayers(message);
  if (!players || (!_resolvedSkin && !_desiredCosmetics)) return;
  if (!_resolvedSkin && _cosmeticsData) _resolvedSkin = _resolveSkin(_desiredCosmetics);
  if (!_resolvedSkin) return;
  const player = _findSkinPlayer(players, message.myClientID || message.clientID);
  if (player) player.cosmetics = _resolvedSkin;
}

var _hookedParse = function(text, reviver) {
  const result = _originalParse.call(this, text, reviver);
  if (!_skinUnlockerEnabled || !result || typeof result !== "object") return result;
  {
    _injectResolvedSkin(result);
  }
  return result;
};

// LAZY INSTALL (perf): replacing JSON.parse with a JS function DEFEATS V8's
// native fast-path for the WHOLE PAGE. The lobby/menu parses large JSON (the
// room list poll, map metadata) every second — with the hook live, dragging
// panels there lags. So the JSON.parse hook is installed ONLY when a join is
// sent (see the send() hook above) and removed when the unlocker is toggled
// off. Before joining, JSON.parse stays native and V8 keeps its fast path.
var _parseHooked = false;
function _installParseHook() {
  if (_parseHooked) return;
  _parseHooked = true;
  {
    Object.defineProperty(JSON, "parse", { value: _hookedParse, writable: false, configurable: true });
  }
}
function _uninstallParseHook() {
  if (!_parseHooked) return;
  _parseHooked = false;
  {
    Object.defineProperty(JSON, "parse", { value: _originalParse, writable: true, configurable: true });
  }
}

function _setSkinUnlockerEnabled(on) {
  _skinUnlockerEnabled = Boolean(on);
  // Turning OFF always restores native parse. Turning ON does NOT install
  // immediately — the join hook installs it right before entering a game, so
  // the lobby stays fast.
  if (!_skinUnlockerEnabled) _uninstallParseHook();
}

// ---- API exported to the rest of the engine ----
// These are set as globals (sloppy-mode shared scope) so any ingame file can
// call sendGamePacket / isSocketConnected / getLastKnownTile directly.
