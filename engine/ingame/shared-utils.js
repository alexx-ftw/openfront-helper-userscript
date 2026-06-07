// Shared player, team, overlay, and formatting helpers used across bridge features.

function normalizeEconomyHeatmapIntensity(value) {
  const intensity = Number(value);
  if (!Number.isFinite(intensity)) {
    return 1;
  }
  return Math.max(0, Math.min(2, Math.round(intensity)));
}

function escapeCssIdentifier(value) {
  if (globalThis.CSS?.escape) {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function getPlayerSmallId(player, fallbackIndex = 0) {
  try {
    return Number(player?.smallID?.() ?? player?.data?.smallID ?? fallbackIndex);
  } catch (_error) {
    return Number(fallbackIndex);
  }
}

function getPlayerDisplayName(player) {
  try {
    return String(
      player?.displayName?.() ??
        player?.name?.() ??
        player?.data?.displayName ??
        player?.data?.name ??
        "Unknown",
    );
  } catch (_error) {
    return "Unknown";
  }
}

function getPlayerRelationToMyPlayer(game, player) {
  let myPlayer = null;
  try {
    myPlayer = game?.myPlayer?.();
    if (!player?.isPlayer?.() || !myPlayer?.isPlayer?.()) {
      return null;
    }
  } catch (_error) {
    return null;
  }

  const playerId = getPlayerSmallId(player, NaN);
  const myPlayerId = getPlayerSmallId(myPlayer, NaN);
  if (Number.isFinite(playerId) && playerId === myPlayerId) {
    return "self";
  }

  try {
    if (player.isFriendly?.(myPlayer) || myPlayer.isFriendly?.(player)) {
      return "ally";
    }
  } catch (_error) {
    return "enemy";
  }

  return "enemy";
}

function getPlayerTeamName(player) {
  try {
    const team = player?.team?.();
    return team == null ? null : String(team);
  } catch (_error) {
    return null;
  }
}

// Per-game cache for team color resolution. Object.entries(TEAM_COLORS).find
// otherwise runs for every player row on every render frame.
let _cachedTeamColorGame = null;
const _cachedTeamColors = new Map();
let _teamColorsLowerCaseIndex = null;

function _getTeamColorsLowerCaseIndex() {
  if (_teamColorsLowerCaseIndex !== null) {
    return _teamColorsLowerCaseIndex;
  }
  _teamColorsLowerCaseIndex = new Map();
  for (const [name, color] of Object.entries(TEAM_COLORS)) {
    _teamColorsLowerCaseIndex.set(name.toLowerCase(), color);
  }
  return _teamColorsLowerCaseIndex;
}

function _computeTeamColor(team, game) {
  if (team != null && game?.config?.().theme?.().teamColor) {
    try {
      const color = game.config().theme().teamColor(String(team));
      const hex = color?.toHex?.();
      if (hex) {
        return hex;
      }
    } catch (_error) {
      // Fall back to the local palette when the game theme is unavailable.
    }
  }

  const teamKey = String(team ?? "");
  const normalizedKey = teamKey.trim().toLowerCase();
  const directMatch = _getTeamColorsLowerCaseIndex().get(normalizedKey);
  if (directMatch) {
    return directMatch;
  }

  return TEAM_COLORS[teamKey] || "#4ade80";
}

function getTeamColor(team, game = null) {
  if (game !== _cachedTeamColorGame) {
    _cachedTeamColorGame = game;
    _cachedTeamColors.clear();
  }
  const cacheKey = String(team ?? "");
  const cached = _cachedTeamColors.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const color = _computeTeamColor(team, game);
  _cachedTeamColors.set(cacheKey, color);
  return color;
}

function getTeamColorBackground(team, game = null) {
  const color = getTeamColor(team, game);
  return `${color}2b`;
}

function isNationBotPlayer(player) {
  try {
    const playerType = player?.type?.() ?? player?.data?.playerType;
    return playerType === "NATION";
  } catch (_error) {
    return false;
  }
}

function getPlayerMarkerId(player, fallbackIndex) {
  try {
    return String(
      player?.id?.() ??
        player?.smallID?.() ??
        player?.data?.id ??
        player?.displayName?.() ??
        fallbackIndex,
    );
  } catch (_error) {
    return String(fallbackIndex);
  }
}

function getPlayerGoldNumber(player) {
  try {
    const gold = player?.gold?.();
    if (typeof gold === "bigint") {
      return Number(gold);
    }
    return Number(gold);
  } catch (_error) {
    return NaN;
  }
}

let _cachedInfoOverlayEl = null;

function getHoveredPlayerInfoOverlay() {
  if (!_cachedInfoOverlayEl?.isConnected) {
    _cachedInfoOverlayEl = document.querySelector("player-info-overlay") ?? null;
  }
  const overlay = _cachedInfoOverlayEl;
  if (!overlay?.player) {
    return null;
  }

  const visible = overlay._isInfoVisible ?? overlay.isInfoVisible;
  if (visible === false) {
    return null;
  }

  return overlay;
}

function getPlayerInfoPanelRect(overlay) {
  const panel =
    overlay.querySelector('[class*="bg-gray-800"]') ??
    overlay.querySelector('[class*="backdrop-blur"]') ??
    overlay;
  const rect = panel.getBoundingClientRect?.();
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return rect;
  }

  return null;
}

function normalizeTradeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findPlayerByTradeName(players, name) {
  const normalizedName = normalizeTradeName(name);
  if (!normalizedName) {
    return null;
  }

  return (
    players.find(
      (player) => normalizeTradeName(getPlayerDisplayName(player)) === normalizedName,
    ) ?? players.find((player) => normalizeTradeName(player?.name?.()) === normalizedName) ?? null
  );
}

// Shared per-tick cache for game.playerViews(). Avoids spawning a new
// Array.from(...) snapshot on every helper render across multiple features.
let _cachedPlayerViewsGame = null;
let _cachedPlayerViewsTick = -1;
let _cachedPlayerViewsArray = [];

function getCachedPlayerViews(game) {
  if (!game) {
    return [];
  }

  let currentTick = Number.NaN;
  try {
    currentTick = Number(game.ticks?.());
  } catch (_error) {
    currentTick = Number.NaN;
  }

  if (
    game === _cachedPlayerViewsGame &&
    Number.isFinite(currentTick) &&
    currentTick === _cachedPlayerViewsTick &&
    _cachedPlayerViewsArray.length > 0
  ) {
    return _cachedPlayerViewsArray;
  }

  _cachedPlayerViewsGame = game;
  _cachedPlayerViewsTick = Number.isFinite(currentTick) ? currentTick : -1;
  try {
    _cachedPlayerViewsArray = Array.from(game.playerViews?.() || []);
  } catch (_error) {
    _cachedPlayerViewsArray = [];
  }
  return _cachedPlayerViewsArray;
}

// FNV-1a-ish 32-bit numeric hash. Used to replace JSON.stringify-based
// render-signature comparison in trade-balances.
function mixHashNumber(hash, value) {
  let h = hash >>> 0;
  let n = value | 0;
  if (n < 0) {
    n = (n + 0x100000000) >>> 0;
  }
  h = (h ^ (n & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  h = (h ^ ((n >>> 8) & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  h = (h ^ ((n >>> 16) & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  h = (h ^ ((n >>> 24) & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  return h;
}

function mixHashString(hash, value) {
  const str = String(value ?? "");
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
