// Auto-Bot — reading game state: border tiles, ocean-adjacency,
// border analysis, bounding boxes.

"use strict";

  // =========================================================================
  // Sensing
  // =========================================================================
  async function getBorderTiles(game, me) {
    const now = performance.now();
    if (state.border.tiles && now - state.border.atMs < scaled(BORDER_CACHE_MS)) {
      return state.border.tiles;
    }
    let tiles;
    try {
      const res = await withTimeout(me.borderTiles(), WORKER_TIMEOUT_MS, null);
      const set = res?.borderTiles ?? res;
      tiles = set ? Array.from(set) : [];
    } catch (error) {
      console.warn("[AutoBot] borderTiles failed:", error);
      tiles = [];
    }
    state.border = { tiles, atMs: now };
    return tiles;
  }

  // True when a tile borders the OCEAN (tradeable shared water). The bot only
  // treats a nation as "coastal" when it can trade by sea — lakes/closed seas
  // don't count (mirrors NationStructureBehavior's sharedWaterComponents).
  function isOceanAdjacent(game, t) {
    try {
      if (typeof game.isOceanShore === "function") return game.isOceanShore(t);
    } catch (_e) {
      /* fall through */
    }
    for (const n of game.neighbors(t)) {
      if (game.isOcean?.(n)) return true;
    }
    return false;
  }

  function classifyBorderNeighbor(game, me, mySmallId, tile, scan) {
    if (!game.isLand(tile) || game.ownerID(tile) === mySmallId) return;
    if (!game.hasOwner(tile)) {
      if (game.hasFallout?.(tile)) scan.hasNukedLand = true;
      else scan.hasOpenLand = true;
      return;
    }
    const owner = game.owner(tile);
    if (!owner?.isPlayer?.() || owner.smallID?.() === mySmallId) return;
    const collection = me.isFriendly?.(owner) ? scan.friends : scan.enemies;
    collection.set(owner.smallID(), owner);
  }

  function scanBorderTile(game, me, mySmallId, borderTile, scan) {
    if (!scan.hasShore && game.isShore?.(borderTile)) scan.hasShore = true;
    if (!scan.hasCoastal && isOceanAdjacent(game, borderTile)) {
      scan.hasCoastal = true;
    }
    for (const neighbor of game.neighbors(borderTile)) {
      classifyBorderNeighbor(game, me, mySmallId, neighbor, scan);
    }
  }

  // Scans border-tile land neighbours to classify the frontier: empty (terra
  // nullius) land available, shore presence (for boats), ocean-coast presence
  // (for port/factory ratios), and the set of bordering enemies.
  function analyzeBorder(game, me, border) {
    const mySmallId = me.smallID?.();
    const scan = {
      hasOpenLand: false,
      hasNukedLand: false,
      hasShore: false,
      hasCoastal: false,
      enemies: new Map(),
      friends: new Map(),
    };

    for (const borderTile of border) {
      scanBorderTile(game, me, mySmallId, borderTile, scan);
    }

    return {
      hasOpenLand: scan.hasOpenLand,
      hasNukedLand: scan.hasNukedLand,
      hasShore: scan.hasShore,
      hasCoastal: scan.hasCoastal,
      enemies: Array.from(scan.enemies.values()),
      friends: Array.from(scan.friends.values()),
    };
  }

  function boundingBox(game, border) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of border) {
      const x = game.x(t);
      const y = game.y(t);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }
