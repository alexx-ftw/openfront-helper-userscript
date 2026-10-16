  function resetExportPartnerHeatmapSourceCache() {
    runtimeState.exportPartnerHeatmapSourceCacheGame = null;
    runtimeState.exportPartnerHeatmapSourceCachePlayerId = null;
    runtimeState.exportPartnerHeatmapSourceCacheAt = 0;
    runtimeState.exportPartnerHeatmapSourceCache = [];
  }

  function getExportPartnerHeatmapSources(game, player) {
    const now = performance.now();
    const playerId = getPlayerSmallId(player);

    if (
      runtimeState.exportPartnerHeatmapSourceCacheGame !== game ||
      runtimeState.exportPartnerHeatmapSourceCachePlayerId !== playerId ||
      now - runtimeState.exportPartnerHeatmapSourceCacheAt >= EXPORT_PARTNER_HEATMAP_SOURCE_CACHE_MS
    ) {
      runtimeState.exportPartnerHeatmapSourceCache = collectExportPartnerHeatmapSources(game, player);
      runtimeState.exportPartnerHeatmapSourceCacheGame = game;
      runtimeState.exportPartnerHeatmapSourceCachePlayerId = playerId;
      runtimeState.exportPartnerHeatmapSourceCacheAt = now;
    }

    return runtimeState.exportPartnerHeatmapSourceCache;
  }

  function toFiniteNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }

  function canStationTradeWith(player, otherPlayer) {
    if (!player || !otherPlayer) {
      return false;
    }
    if (getPlayerSmallId(player) === getPlayerSmallId(otherPlayer)) {
      return true;
    }
    return canPlayersTrade(player, otherPlayer);
  }

  function getHeatmapTypePriority(type) {
    if (type === "Factory") {
      return 4;
    }
    if (type === "Port") {
      return 3;
    }
    if (type === "City") {
      return 2;
    }
    return 1;
  }

  // addEconomicSource is provided globally by runtime.js with an O(1) tile
  // dedup index. Previously this file shadowed it with a linear sources.find
  // implementation (O(n^2) across late-game collections).

  function getRevenueUnitKey(unit) {
    const unitId = toFiniteNumber(unit?.id?.(), NaN);
    if (Number.isFinite(unitId)) {
      return `unit:${unitId}`;
    }

    const tile = unit?.tile?.();
    const type = String(unit?.type?.() ?? "Industry");
    return tile == null ? null : `tile:${type}:${tile}`;
  }

  function isEconomyRevenueType(type) {
    return type === "City" || type === "Port" || type === "Factory";
  }

  function getEconomyRevenueIdentity(unit) {
    const unitId = toFiniteNumber(unit?.id?.(), NaN);
    const owner = unit?.owner?.();
    return {
      unitId: Number.isFinite(unitId) ? unitId : null,
      ownerId: owner ? getPlayerSmallId(owner) : null,
    };
  }

  function getEconomyRevenueTracker(key, unit, tile, type) {
    const identity = getEconomyRevenueIdentity(unit);
    const entry = economyRevenueSourceTrackers.get(key) ?? {
      ...identity,
      tile,
      type,
      total: 0,
      events: [],
    };
    entry.unitId = identity.unitId ?? entry.unitId;
    entry.ownerId = identity.ownerId ?? entry.ownerId;
    entry.tile = tile;
    entry.type = type;
    return entry;
  }

  function addEconomyRevenueSource(unit, goldAmount) {
    const amount = toFiniteNumber(goldAmount);
    if (!unit || !Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const type = String(unit?.type?.() ?? "Industry");
    if (!isEconomyRevenueType(type)) {
      return;
    }

    const tile = unit?.tile?.();
    if (tile == null) {
      return;
    }

    const key = getRevenueUnitKey(unit);
    if (!key) {
      return;
    }

    const entry = getEconomyRevenueTracker(key, unit, tile, type);
    entry.events.push({
      amount,
      at: Date.now(),
    });
    entry.total += amount;
    economyRevenueSourceTrackers.set(key, entry);
  }

  function getActiveRevenueUnit(game, entry) {
    const unitId = Number(entry?.unitId);
    if (Number.isFinite(unitId)) {
      {
        const unit = game?.unit?.(unitId);
        if (activeRevenueUnitTypeMatches(unit, entry)) return unit;
      }
    }

    {
      return Array.from(game?.units?.(entry.type) || []).find(
        (unit) => activeRevenueUnitTypeMatches(unit, entry) && unit?.tile?.() === entry.tile,
      ) ?? null;
    }
  }

  function activeRevenueUnitTypeMatches(unit, entry) {
    return (
      unit?.isActive?.() &&
      String(unit?.type?.() ?? "") === String(entry.type ?? "")
    );
  }

  function pruneEconomyRevenueSources(game) {
    const cutoff = Date.now() - ECONOMY_HEATMAP_REVENUE_WINDOW_MS;
    for (const [key, entry] of economyRevenueSourceTrackers.entries()) {
      const unit = getActiveRevenueUnit(game, entry);
      if (!unit) {
        economyRevenueSourceTrackers.delete(key);
        continue;
      }

      entry.tile = unit.tile?.() ?? entry.tile;
      entry.type = String(unit?.type?.() ?? entry.type);
      entry.events = entry.events.filter(
        (event) =>
          Number.isFinite(event?.amount) &&
          event.amount > 0 &&
          Number.isFinite(event?.at) &&
          event.at >= cutoff,
      );
      entry.total = entry.events.reduce((total, event) => total + event.amount, 0);

      if (entry.total <= 0) {
        economyRevenueSourceTrackers.delete(key);
      }
    }
  }

