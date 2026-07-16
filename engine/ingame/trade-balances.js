// Trade balance tracking, ROI display, and observed transport accounting.

  function ensureTradeBalanceStyles() {
    if (document.getElementById(TRADE_BALANCE_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = TRADE_BALANCE_STYLE_ID;
    style.textContent = `
      #${TRADE_BALANCE_BADGE_ID} {
        display: none;
        position: fixed;
        z-index: 9000;
        bottom: calc(8px + env(safe-area-inset-bottom, 0px));
        left: 560px;
        width: min(280px, calc(100vw - 16px));
        padding: 7px 9px;
        border: 1px solid var(--oh-panel-border, rgba(148,163,184,0.34));
        border-radius: 8px;
        background: var(--oh-panel-bg, rgba(12,18,20,0.92));
        color: var(--oh-panel-text, #e2e8f0);
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.15;
        cursor: move;
        user-select: none;
        box-shadow:
          0 10px 24px rgba(0, 0, 0, 0.36),
          0 0 16px var(--oh-accent-soft, rgba(96,165,250,0.15));
      }

      #${TRADE_BALANCE_BADGE_ID}[data-visible="true"] {
        display: grid;
        gap: 5px;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-title {
        color: var(--oh-panel-text-dim, rgba(148,163,184,0.85));
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-summary {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        padding: 4px 0 5px;
        border-bottom: 1px solid var(--oh-panel-header-border, rgba(148,163,184,0.18));
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-total {
        display: grid;
        gap: 2px;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-total-label {
        color: var(--oh-panel-text-dim, rgba(148,163,184,0.85));
        font-size: 9px;
        text-transform: uppercase;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-total-value {
        color: var(--oh-accent, #60a5fa);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-roi[data-status="unprofitable"] {
        color: #f87171;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-roi[data-status="profitable"] {
        color: #4ade80;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-roi[data-status="unknown"] {
        color: var(--oh-panel-text-dim, rgba(148,163,184,0.85));
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-rows {
        display: grid;
        gap: 3px;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-name {
        overflow: hidden;
        color: var(--oh-panel-text, #e2e8f0);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-value {
        color: var(--oh-accent, #60a5fa);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-value-wrap {
        display: grid;
        gap: 2px;
        justify-items: end;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-direction {
        color: var(--oh-panel-text-dim, rgba(148,163,184,0.85));
        font-size: 9px;
        text-transform: uppercase;
        white-space: nowrap;
      }

      #${TRADE_BALANCE_BADGE_ID} .openfront-helper-trade-empty {
        color: var(--oh-panel-text-dim, rgba(148,163,184,0.85));
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Hide-grace state: when you stop hovering a nation, keep the trade panel up
  // briefly (and indefinitely while the pointer is over it) so it can be dragged.
  let tradeBadgeHovered = false;
  let tradeBadgeHideAt = 0;
  const TRADE_BADGE_HIDE_GRACE_MS = 2500;

  function hideTradeBadgeSoon(badge) {
    if (badge.dataset.visible === "false") {
      tradeBadgeHideAt = 0;
      return;
    }
    if (tradeBadgeHovered) {
      tradeBadgeHideAt = 0; // pointer is on the panel — keep it open
      return;
    }
    const now = Date.now();
    if (!tradeBadgeHideAt) tradeBadgeHideAt = now + TRADE_BADGE_HIDE_GRACE_MS;
    if (now >= tradeBadgeHideAt) {
      tradeBadgeHideAt = 0;
      badge.dataset.visible = "false";
      runtimeState.tradeBalanceRenderSignature = "";
      syncHelperStatsContainerVisibility();
    }
  }

  function ensureTradeBalanceBadge() {
    ensureTradeBalanceStyles();

    let badge = document.getElementById(TRADE_BALANCE_BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = TRADE_BALANCE_BADGE_ID;
      badge.innerHTML = `
        <span class="openfront-helper-trade-title">${tr("Trade balance")}</span>
        <span class="openfront-helper-trade-summary">
          <span class="openfront-helper-trade-total">
            <span class="openfront-helper-trade-total-label">${tr("Total imports")}</span>
            <span class="openfront-helper-trade-total-value openfront-helper-trade-imports">+0</span>
          </span>
          <span class="openfront-helper-trade-total">
            <span class="openfront-helper-trade-total-label">${tr("Total exports")}</span>
            <span class="openfront-helper-trade-total-value openfront-helper-trade-exports">+0</span>
          </span>
          <span class="openfront-helper-trade-total">
            <span class="openfront-helper-trade-total-label">${tr("Factory/port spent")}</span>
            <span class="openfront-helper-trade-total-value openfront-helper-trade-factory-port-spend">0</span>
          </span>
          <span class="openfront-helper-trade-total">
            <span class="openfront-helper-trade-total-label">${tr("Return on investment")}</span>
            <span class="openfront-helper-trade-total-value openfront-helper-trade-roi">n/a</span>
          </span>
          <span class="openfront-helper-trade-total">
            <span class="openfront-helper-trade-total-label">${tr("Break even")}</span>
            <span class="openfront-helper-trade-total-value openfront-helper-trade-break-even">${tr("tracking")}</span>
          </span>
        </span>
        <span class="openfront-helper-trade-rows"></span>
      `;
    }
    // Standalone draggable panel — separate from the gold-per-minute container.
    if (badge.parentElement !== document.body) {
      (document.body || document.documentElement).appendChild(badge);
      makeGoldStatPanelDraggable(badge, badge, "openfront-helper-trade-balances-pos");
      applyStoredGoldStatPanelPosition(badge, "openfront-helper-trade-balances-pos");
      // Keep the panel up while the pointer is on it so it can be grabbed/dragged
      // even after you stop hovering the nation (see the hide-grace below).
      badge.addEventListener("pointerenter", () => {
        tradeBadgeHovered = true;
      });
      badge.addEventListener("pointerleave", () => {
        tradeBadgeHovered = false;
      });
    }
    return badge;
  }

  function getTradeBalanceTracker(playerId) {
    const key = String(playerId);
    let tracker = tradeBalanceTrackers.get(key);
    if (!tracker) {
      tracker = new Map();
      tradeBalanceTrackers.set(key, tracker);
    }
    return tracker;
  }

  function getExportProfitSource(unit) {
    const tile = unit.tile?.();
    return {
      tile,
      id: unit.id?.() ?? tile,
      type: String(unit.type?.() ?? "Industry"),
    };
  }

  function addExportPartnerProfitSource(exporterId, partnerId, unit, goldAmount) {
    const validIds = Number.isFinite(exporterId) && Number.isFinite(Number(partnerId));
    const validGold = Number.isFinite(goldAmount) && goldAmount > 0;
    if (!validIds || !unit || !validGold) return;

    const exporterKey = String(exporterId);
    let sourceTracker = exportPartnerSourceTrackers.get(exporterKey);
    if (!sourceTracker) {
      sourceTracker = new Map();
      exportPartnerSourceTrackers.set(exporterKey, sourceTracker);
    }

    const source = getExportProfitSource(unit);
    const sourceKey = `${partnerId}:${source.id}`;
    const entry = sourceTracker.get(sourceKey) ?? {
      partnerId: Number(partnerId),
      tile: source.tile,
      type: source.type,
      total: 0,
    };
    entry.tile = source.tile ?? entry.tile;
    entry.type = source.type;
    entry.total += goldAmount;
    sourceTracker.set(sourceKey, entry);
  }

  function addTradeBalance({
    receiverId, partnerId, partnerName, goldAmount,
    direction = "unknown", sourceUnit = null,
  }) {
    if (!Number.isFinite(receiverId) || !Number.isFinite(goldAmount) || goldAmount <= 0) {
      return;
    }

    const tracker = getTradeBalanceTracker(receiverId);
    const key = String(partnerId || partnerName || "unknown");
    const entry = tracker.get(key) ?? {
      partnerId,
      partnerName: partnerName || "Unknown",
      total: 0,
      imports: 0,
      exports: 0,
      unknown: 0,
      firstExportAt: null,
      lastExportAt: null,
    };
    entry.partnerId = partnerId ?? entry.partnerId;
    entry.partnerName = partnerName || entry.partnerName;
    entry.total += goldAmount;
    if (direction === "import") {
      entry.imports += goldAmount;
    } else if (direction === "export") {
      const now = Date.now();
      entry.firstExportAt ??= now;
      entry.lastExportAt = now;
      entry.exports += goldAmount;
      addExportPartnerProfitSource(receiverId, partnerId, sourceUnit, goldAmount);
    } else {
      entry.unknown += goldAmount;
    }
    tracker.set(key, entry);
  }

  function getTradeEventGoldAmount(value) {
    if (typeof value === "bigint") {
      return Number(value);
    }
    return Number(value);
  }

  function matchesOwnedStructure(unit, allowedTypes, owner) {
    {
      if (!unit?.isActive?.() || !allowedTypes.includes(unit?.type?.())) return false;
      if (owner === null) return true;
      return getPlayerSmallId(unit?.owner?.()) === getPlayerSmallId(owner);
    }
  }

  function findExactOwnedStructure(game, tile, allowedTypes, owner) {
    {
      for (const unit of game?.units?.(...allowedTypes) || []) {
        if (matchesOwnedStructure(unit, allowedTypes, owner) && unit.tile?.() === tile) {
          return unit;
        }
      }
    }
    return null;
  }

  function findOwnedStructureAtTile(game, tile, allowedTypes, owner = null, radius = 2) {
    if (tile == null) return null;
    const exact = findExactOwnedStructure(game, tile, allowedTypes, owner);
    if (exact) return exact;

    {
      const nearby = game?.nearbyUnits?.(tile, radius, allowedTypes);
      return nearby?.find((entry) =>
        matchesOwnedStructure(entry?.unit, allowedTypes, owner))?.unit ?? null;
    }
  }

  function getTradeShipSourceUnit(game, shipId) {
    const tracker = tradeShipSourceTrackers.get(String(shipId));
    if (!tracker) {
      return null;
    }

    const sourceUnitId = Number(tracker.sourceUnitId);
    if (Number.isFinite(sourceUnitId)) {
      {
        const unit = game?.unit?.(sourceUnitId);
        if (unit?.isActive?.() && String(unit?.type?.() ?? "") === "Port") {
          return unit;
        }
      }
    }

    return findOwnedStructureAtTile(
      game,
      tracker.sourceTile,
      ["Port"],
      tracker.sourceOwner,
    );
  }

  function getTradeShipSourceTracker(ship, now) {
    const key = String(ship.id());
    return tradeShipSourceTrackers.get(key) ?? {
      sourceUnitId: null,
      sourceTile: null,
      sourceOwner: ship?.owner?.() ?? null,
      targetUnitId: toFiniteNumber(ship?.targetUnitId?.(), NaN),
      lastSeenAt: now,
    };
  }

  function updateTradeShipSourceTracker(game, ship, now) {
      const shipId = String(ship.id());
      const tracker = getTradeShipSourceTracker(ship, now);
      tracker.lastSeenAt = now;
      if (!Number.isFinite(Number(tracker.sourceUnitId))) {
        const sourcePort = findOwnedStructureAtTile(
          game,
          ship?.tile?.(),
          ["Port"],
          ship?.owner?.(),
        );
        if (sourcePort) rememberTradeShipSource(tracker, sourcePort);
      }
      tradeShipSourceTrackers.set(shipId, tracker);
  }

  function rememberTradeShipSource(tracker, sourcePort) {
    const sourceUnitId = toFiniteNumber(sourcePort?.id?.(), NaN);
    if (Number.isFinite(sourceUnitId)) tracker.sourceUnitId = sourceUnitId;
    tracker.sourceTile = sourcePort?.tile?.() ?? tracker.sourceTile;
    tracker.sourceOwner = sourcePort?.owner?.() ?? tracker.sourceOwner;
  }

  function pruneTradeShipSourceTrackers(activeShipIds, now) {
    for (const shipId of tradeShipSourceTrackers.keys()) {
      if (activeShipIds.has(shipId)) continue;
      const tracker = tradeShipSourceTrackers.get(shipId);
      const expired = !Number.isFinite(tracker?.lastSeenAt) || now - tracker.lastSeenAt > 30000;
      if (expired) tradeShipSourceTrackers.delete(shipId);
    }
  }

  function refreshTradeShipSourceTrackers(game) {
    const now = Date.now();
    const activeShips = (game?.units?.("Trade Ship") || []).filter((ship) =>
      Number.isFinite(ship?.id?.()) && ship?.isActive?.());
    const activeShipIds = new Set(activeShips.map((ship) => String(ship.id())));
    for (const ship of activeShips) {
      updateTradeShipSourceTracker(game, ship, now);
    }
    pruneTradeShipSourceTrackers(activeShipIds, now);
  }

  function getTradeDirection(receiverId, partnerId, boatRoutes) {
    const route = getTradeRoute(receiverId, partnerId, boatRoutes);
    if (!route) {
      return "unknown";
    }
    return route.sourceId === receiverId ? "export" : "import";
  }

  function getCompletedBoatTradeRoute(game, event) {
    const completed = event?.unitType === "Trade Ship" &&
      event?.isActive === false && event?.targetUnitId !== undefined;
    if (!completed) return null;
    const targetUnit = game?.unit?.(event.targetUnitId);
    const destinationOwner = targetUnit?.owner?.();
    const destinationId = destinationOwner ? getPlayerSmallId(destinationOwner) : NaN;
    const sourceId = Number(event.ownerID);
    if (!Number.isFinite(sourceId) || !Number.isFinite(destinationId)) return null;
    if (sourceId === destinationId) return null;
    return {
      shipId: String(event.id), sourceId, destinationId,
      sourceUnit: getTradeShipSourceUnit(game, event.id),
      destinationUnit: targetUnit,
    };
  }

  function collectCompletedBoatTradeRoutes(game, updates) {
    return Object.values(updates || {})
      .filter(Array.isArray)
      .flatMap((events) => events.map((event) => getCompletedBoatTradeRoute(game, event)))
      .filter(Boolean);
  }

  function getTradeRoute(receiverId, partnerId, boatRoutes) {
    return boatRoutes.find(
      (entry) =>
        (entry.sourceId === receiverId && entry.destinationId === partnerId) ||
        (entry.destinationId === receiverId && entry.sourceId === partnerId),
    );
  }

  function takeTradeRoute(receiverId, partnerId, boatRoutes) {
    const routeIndex = boatRoutes.findIndex(
      (entry) =>
        (entry.sourceId === receiverId && entry.destinationId === partnerId) ||
        (entry.destinationId === receiverId && entry.sourceId === partnerId),
    );
    if (routeIndex < 0) {
      return null;
    }
    return boatRoutes.splice(routeIndex, 1)[0];
  }

  function isTrainStationUnit(unit, allowedTypes = ["City", "Port"], owner = null) {
    {
      const type = unit?.type?.();
      if (!allowedTypes.includes(type) || !unit?.hasTrainStation?.()) {
        return false;
      }
      if (!owner) {
        return true;
      }
      return getPlayerSmallId(unit?.owner?.()) === getPlayerSmallId(owner);
    }
  }

  function findTrainStationAtTile(game, tile, allowedTypes = ["City", "Port"], owner = null) {
    if (tile == null) return null;
    const exact = (game?.units?.(...allowedTypes) || []).find((unit) =>
      isTrainStationUnit(unit, allowedTypes, owner) && unit.tile?.() === tile);
    if (exact) return exact;
    const nearby = game?.nearbyUnits?.(tile, 2, allowedTypes);
    return nearby?.find((entry) =>
      isTrainStationUnit(entry?.unit, allowedTypes, owner))?.unit ?? null;
  }

  function getActiveTrainFactory(factory) {
    {
      if (!factory?.isActive?.() || !factory?.hasTrainStation?.()) return null;
      const tile = factory.tile?.();
      return tile == null ? null : { factory, tile };
    }
  }

  function findNearestOwnedFactory(game, tile, owner) {
    if (tile == null || !owner) return null;
    let candidates;
    {
      candidates = (owner.units?.("Factory") || [])
        .map(getActiveTrainFactory)
        .filter(Boolean)
        .map(({ factory, tile: factoryTile }) => ({
          factory,
          distance: toFiniteNumber(game?.manhattanDist?.(tile, factoryTile), NaN),
        }))
        .filter(({ distance }) => Number.isFinite(distance))
        .sort((a, b) => a.distance - b.distance);
    }
    const maxRange = Math.max(
      1,
      toFiniteNumber(game?.config?.().trainStationMaxRange?.(), 100),
    );
    return candidates[0]?.distance <= maxRange ? candidates[0].factory : null;
  }

  function isTrackedTrainFactory(unit, trainOwner) {
    return unit?.isActive?.() && String(unit?.type?.() ?? "") === "Factory" &&
      getPlayerSmallId(unit?.owner?.()) === getPlayerSmallId(trainOwner);
  }

  function getTrackedTrainSourceFactory(game, tracker, trainOwner) {
    const sourceUnitId = Number(tracker?.sourceUnitId);
    if (Number.isFinite(sourceUnitId)) {
      {
        const unit = game?.unit?.(sourceUnitId);
        if (isTrackedTrainFactory(unit, trainOwner)) return unit;
      }
    }

    return findNearestOwnedFactory(game, tracker?.sourceTile, trainOwner);
  }

  function rememberTrainSourceFactory(tracker, factory) {
    if (!tracker || !factory) {
      return;
    }

    const unitId = toFiniteNumber(factory?.id?.(), NaN);
    tracker.sourceUnitId = Number.isFinite(unitId) ? unitId : tracker.sourceUnitId;
    tracker.sourceTile = factory?.tile?.() ?? tracker.sourceTile;
  }

  function findTrainSourceFactory(game, engine, tracker = null) {
    const trainOwner = engine?.owner?.();
    if (!trainOwner) {
      return null;
    }

    const trackedFactory = getTrackedTrainSourceFactory(game, tracker, trainOwner);
    if (trackedFactory) {
      return trackedFactory;
    }

    const sourceAtCurrentTile = findTrainStationAtTile(
      game,
      engine?.tile?.(),
      ["Factory"],
      trainOwner,
    );
    if (sourceAtCurrentTile) {
      return sourceAtCurrentTile;
    }

    return findNearestOwnedFactory(game, tracker?.firstTile ?? engine?.tile?.(), trainOwner);
  }

  function getTrainRelation(trainOwner, stationOwner) {
    if (trainOwner === stationOwner || getPlayerSmallId(trainOwner) === getPlayerSmallId(stationOwner)) {
      return "self";
    }
    if (trainOwner?.isOnSameTeam?.(stationOwner)) {
      return "team";
    }
    if (trainOwner?.isAlliedWith?.(stationOwner)) {
      return "ally";
    }
    return "other";
  }

  function canPlayersTrade(player, otherPlayer) {
    {
      return (
        getPlayerSmallId(player) !== getPlayerSmallId(otherPlayer) &&
        !isBlockedBySelectiveTradePolicy(player, otherPlayer) &&
        !player?.hasEmbargo?.(otherPlayer)
      );
    }
  }

  function createTrainTradeTracker(game, engine, station) {
    const tracker = {
      firstTile: engine.tile?.(),
      lastStationKey: station ? String(station.id?.() ?? station.tile?.()) : null,
      stopsVisited: 0,
      sourceUnitId: null,
      sourceTile: null,
    };
    rememberTrainSourceFactory(tracker, findTrainSourceFactory(game, engine));
    return tracker;
  }

  function getNewTrainStation(tracker, station) {
    if (!station) {
      tracker.lastStationKey = null;
      return null;
    }
    const stationKey = String(station.id?.() ?? station.tile?.());
    if (tracker.lastStationKey === stationKey) return null;
    tracker.lastStationKey = stationKey;
    return station;
  }

  function recordTrainTrade(game, engine, station, tracker) {
      const trainOwner = engine.owner?.();
      const stationOwner = station.owner?.();
      if (!trainOwner || !stationOwner) return;
      if (!canStationTradeWith(trainOwner, stationOwner)) return;
      const relation = getTrainRelation(trainOwner, stationOwner);
      // Pass trainOwner as the 3rd arg: the game's trainGold → goldMultiplierFor(player)
      // calls player.isLobbyCreator() whenever the server enables the goldMultiplier
      // host-cheat. Omitting it (player=undefined) threw "Cannot read properties of
      // undefined (reading 'isLobbyCreator')" on cheat-enabled hosts. trainOwner is the
      // real PlayerView (guarded truthy above) and exposes isLobbyCreator().
      const goldAmount = Number(
        game?.config?.().trainGold?.(relation, tracker.stopsVisited, trainOwner),
      );
      tracker.stopsVisited += 1;
      if (!Number.isFinite(goldAmount) || goldAmount <= 0) {
        return;
      }

      addEconomyRevenueSource(station, goldAmount);
      addEconomyRevenueSource(findTrainSourceFactory(game, engine, tracker), goldAmount);

      if (!canPlayersTrade(trainOwner, stationOwner)) {
        return;
      }

      const trainOwnerId = getPlayerSmallId(trainOwner);
      const stationOwnerId = getPlayerSmallId(stationOwner);
      addTradeBalance({
        receiverId: trainOwnerId,
        partnerId: stationOwnerId,
        partnerName: getPlayerDisplayName(stationOwner),
        goldAmount,
        direction: "export",
        sourceUnit: station,
      });
      addTradeBalance({
        receiverId: stationOwnerId,
        partnerId: trainOwnerId,
        partnerName: getPlayerDisplayName(trainOwner),
        goldAmount,
        direction: "import",
      });
  }

  function processTrainEngineStop(game, engine, activeEngineIds) {
      if (engine?.trainType?.() !== "Engine" || !engine?.isActive?.()) return;
      const engineId = engine.id?.();
      if (!Number.isFinite(engineId)) return;
      activeEngineIds.add(engineId);
      const station = findTrainStationAtTile(game, engine.tile?.());
      let tracker = trainTradeTrackers.get(engineId);
      if (!tracker) {
        tracker = createTrainTradeTracker(game, engine, station);
        trainTradeTrackers.set(engineId, tracker);
        return;
      }
      rememberTrainSourceFactory(tracker, findTrainSourceFactory(game, engine, tracker));
      const newStation = getNewTrainStation(tracker, station);
      if (newStation) recordTrainTrade(game, engine, newStation, tracker);
  }

  function processTrainTradeStops(game) {
    const activeEngineIds = new Set();
    for (const engine of game?.units?.("Train") || []) {
      processTrainEngineStop(game, engine, activeEngineIds);
    }

    for (const engineId of trainTradeTrackers.keys()) {
      if (!activeEngineIds.has(engineId)) {
        trainTradeTrackers.delete(engineId);
      }
    }
  }
  function processTradeBalanceUpdates(game) {
    const currentTick = Number(game?.ticks?.());
    if (!Number.isFinite(currentTick) || currentTick === runtimeState.lastProcessedTradeBalanceTick) {
      return;
    }
    runtimeState.lastProcessedTradeBalanceTick = currentTick;

    processFactoryPortSpendUpdates(game);
    refreshTradeShipSourceTrackers(game);
    processTrainTradeStops(game);

    const updates = game?.updatesSinceLastTick?.();
    if (!updates) {
      return;
    }

    const players = getCachedPlayerViews(game);
    const boatRoutes = collectCompletedBoatTradeRoutes(game, updates);
    const events = Object.values(updates).filter(Array.isArray).flat();
    for (const event of events) processTradeBalanceEvent(event, players, boatRoutes);
  }

  function getTradeEventRoute(receiverId, partnerId, boatRoutes) {
    const matched = getTradeRoute(receiverId, partnerId, boatRoutes);
    if (!matched) return { direction: "unknown", route: null };
    if (matched.sourceId !== receiverId) return { direction: "import", route: matched };
    return {
      direction: "export",
      route: takeTradeRoute(receiverId, partnerId, boatRoutes),
    };
  }

  function processTradeBalanceEvent(event, players, boatRoutes) {
    if (event?.message !== "events_display.received_gold_from_trade") return;
    const receiverId = Number(event.playerID);
    const goldAmount = getTradeEventGoldAmount(event.goldAmount);
    const partnerName = String(event.params?.name ?? "Unknown");
    const partner = findPlayerByTradeName(players, partnerName);
    const partnerId = partner ? getPlayerSmallId(partner) : `name:${partnerName}`;
    const { direction, route } = getTradeEventRoute(receiverId, Number(partnerId), boatRoutes);
    const sourceUnit = direction === "export" ? route?.destinationUnit : null;
    if (direction === "export" && route) {
      addEconomyRevenueSource(route.sourceUnit, goldAmount);
      addEconomyRevenueSource(route.destinationUnit, goldAmount);
    }
    addTradeBalance({
      receiverId, partnerId, partnerName, goldAmount, direction, sourceUnit,
    });
  }

  function formatTradeBalanceAmount(value) {
    if (!Number.isFinite(value)) {
      return "+0";
    }

    const absValue = Math.abs(value);
    const sign = value >= 0 ? "+" : "-";
    if (absValue >= 1_000_000_000) {
      return `${sign}${(absValue / 1_000_000_000).toFixed(1)}B`;
    }
    if (absValue >= 1_000_000) {
      return `${sign}${(absValue / 1_000_000).toFixed(1)}M`;
    }
    if (absValue >= 1_000) {
      return `${sign}${(absValue / 1_000).toFixed(1)}K`;
    }
    return `${sign}${Math.round(absValue)}`;
  }

  function formatTradeSpendAmount(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return "0";
    }

    return formatTradeBalanceAmount(value).replace(/^\+/, "");
  }

  function formatTradeRoi(exports, spend) {
    if (
      !Number.isFinite(exports) ||
      !Number.isFinite(spend) ||
      spend <= 0
    ) {
      return "n/a";
    }

    const ratio = exports / spend;
    return `${(ratio * 100).toFixed(ratio >= 1 ? 0 : 1)}%`;
  }

  function formatBreakEvenDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      return "tracking";
    }

    const totalSeconds = Math.ceil(ms / 1000);
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }

    const totalMinutes = Math.ceil(totalSeconds / 60);
    if (totalMinutes < 60) {
      return `${totalMinutes} minutes`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes} minutes` : `${hours}h`;
  }

  function formatBreakEvenEstimate(exports, spend, exportWindowMs) {
    if (!Number.isFinite(spend) || spend <= 0) {
      return "n/a";
    }
    if (exports >= spend) {
      return "now";
    }
    if (
      !Number.isFinite(exports) ||
      exports <= 0 ||
      !Number.isFinite(exportWindowMs) ||
      exportWindowMs <= 0
    ) {
      return "tracking";
    }

    const exportPerMs = exports / exportWindowMs;
    return formatBreakEvenDuration((spend - exports) / exportPerMs);
  }

  function getTradeRoiStatus(exports, spend) {
    if (
      !Number.isFinite(exports) ||
      !Number.isFinite(spend) ||
      spend <= 0
    ) {
      return "unknown";
    }

    return exports >= spend ? "profitable" : "unprofitable";
  }

  function getFactoryPortSpendForLevels(startLevelCount, levelsToAdd) {
    let total = 0;
    const safeStart = Math.max(0, Math.floor(Number(startLevelCount) || 0));
    const safeLevels = Math.max(0, Math.floor(Number(levelsToAdd) || 0));
    for (let offset = 0; offset < safeLevels; offset += 1) {
      const index = safeStart + offset;
      total += Math.min(1_000_000, Math.pow(2, index) * 125_000);
    }
    return total;
  }

  function addFactoryPortSpend(playerId, levels) {
    if (!Number.isFinite(playerId) || !Number.isFinite(levels) || levels <= 0) {
      return;
    }

    const key = String(playerId);
    const tracker = factoryPortSpendTrackers.get(key) ?? {
      levels: 0,
      total: 0,
    };
    tracker.total += getFactoryPortSpendForLevels(tracker.levels, levels);
    tracker.levels += levels;
    factoryPortSpendTrackers.set(key, tracker);
  }

  function processFactoryPortSpendUnit(unit, activeUnitKeys) {
      const unitId = unit?.id?.();
      const owner = unit?.owner?.();
      const ownerId = owner ? getPlayerSmallId(owner) : NaN;
      const level = getUnitLevel(unit);
      if (!Number.isFinite(unitId) || !Number.isFinite(ownerId) || level <= 0) return;

      const key = String(unitId);
      activeUnitKeys.add(key);
      const tracked = factoryPortUnitTrackers.get(key);
      if (!tracked) {
        factoryPortUnitTrackers.set(key, {
          ownerId,
          level,
        });
        addFactoryPortSpend(ownerId, level);
        return;
      }

      if (tracked.ownerId === ownerId && level > tracked.level) {
        addFactoryPortSpend(ownerId, level - tracked.level);
      }
      tracked.ownerId = ownerId;
      tracked.level = level;
  }

  function processFactoryPortSpendUpdates(game) {
    const activeUnitKeys = new Set();
    for (const unit of game?.units?.("Factory", "Port") || []) {
      processFactoryPortSpendUnit(unit, activeUnitKeys);
    }

    for (const key of factoryPortUnitTrackers.keys()) {
      if (!activeUnitKeys.has(key)) {
        factoryPortUnitTrackers.delete(key);
      }
    }
  }

  function getFactoryPortSpendTotal(player) {
    const playerId = getPlayerSmallId(player);
    return factoryPortSpendTrackers.get(String(playerId))?.total ?? 0;
  }

  function getTradeBalanceTotals(player) {
    const playerId = getPlayerSmallId(player);
    const tracker = tradeBalanceTrackers.get(String(playerId));
    const totals = {
      imports: 0,
      exports: 0,
      firstExportAt: null,
      lastExportAt: null,
    };
    if (!tracker) {
      return totals;
    }

    for (const entry of tracker.values()) {
      totals.imports += entry.imports || 0;
      totals.exports += entry.exports || 0;
      if (Number.isFinite(entry.firstExportAt)) {
        totals.firstExportAt =
          totals.firstExportAt === null
            ? entry.firstExportAt
            : Math.min(totals.firstExportAt, entry.firstExportAt);
      }
      if (Number.isFinite(entry.lastExportAt)) {
        totals.lastExportAt =
          totals.lastExportAt === null
            ? entry.lastExportAt
            : Math.max(totals.lastExportAt, entry.lastExportAt);
      }
    }
    return totals;
  }
  function getTradeBalanceDirection(entry) {
    if ((entry.exports || 0) > (entry.imports || 0)) {
      return "Player exports more to them";
    }
    if ((entry.imports || 0) > (entry.exports || 0)) {
      return "Player imports more from them";
    }
    return "Imports and exports are balanced";
  }
  function getTradeBalanceEntries(player) {
    const playerId = getPlayerSmallId(player);
    const tracker = tradeBalanceTrackers.get(String(playerId));
    if (!tracker) {
      return [];
    }

    return Array.from(tracker.values())
      .filter((entry) => Number.isFinite(entry.total) && entry.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  }

  // Numeric (FNV-1a) hash of the trade-balance render inputs. Replaces a
  // JSON.stringify-based signature that allocated a fresh string + entry array
  // on every render tick. breakEvenBucket is intentionally excluded so that
  // ticking-second changes do not invalidate the full row signature; the
  // break-even text node is updated separately on every tick.
  function getTradeBalanceRenderSignature(player, totals, spend, entries) {
    let h = 0x811c9dc5;
    h = mixHashNumber(h, getPlayerSmallId(player));
    h = mixHashNumber(h, Math.round(totals.imports || 0));
    h = mixHashNumber(h, Math.round(totals.exports || 0));
    h = mixHashNumber(h, Number(totals.firstExportAt) || 0);
    h = mixHashNumber(h, Math.round(spend || 0));
    h = mixHashNumber(h, entries.length);
    for (const entry of entries) {
      h = mixHashNumber(h, Number(entry.partnerId) || 0);
      h = mixHashString(h, entry.partnerName);
      h = mixHashNumber(h, Math.round(entry.total || 0));
      h = mixHashNumber(h, Math.round(entry.imports || 0));
      h = mixHashNumber(h, Math.round(entry.exports || 0));
    }
    return h >>> 0;
  }

  function findTradePartnerPlayer(players, entry) {
    const numericPartnerId = Number(entry?.partnerId);
    if (Number.isFinite(numericPartnerId)) {
      const match = players.find((player) => getPlayerSmallId(player) === numericPartnerId);
      if (match) {
        return match;
      }
    }

    return findPlayerByTradeName(players, entry?.partnerName);
  }

  function getExportPartnerEntries(player) {
    const playerId = getPlayerSmallId(player);
    const tracker = tradeBalanceTrackers.get(String(playerId));
    if (!tracker) {
      return [];
    }

    return Array.from(tracker.values())
      .filter((entry) => Number.isFinite(entry.exports) && entry.exports > 0)
      .sort((a, b) => b.exports - a.exports);
  }

  function collectExportPartnerHeatmapSources(game, player) {
    const sources = [];
    const playerId = getPlayerSmallId(player);
    const sourceTracker = exportPartnerSourceTrackers.get(String(playerId));
    if (!sourceTracker) {
      return sources;
    }

    const players = getCachedPlayerViews(game);
    const alivePartnerIds = new Set(
      players
        .filter((entry) => entry?.isAlive?.())
        .map((entry) => getPlayerSmallId(entry)),
    );
    const sourceEntries = Array.from(sourceTracker.values()).filter(
      (entry) =>
        entry.tile != null &&
        Number.isFinite(entry.total) &&
        entry.total > 0 &&
        alivePartnerIds.has(Number(entry.partnerId)),
    );
    const maxSourceTotal = Math.max(1, ...sourceEntries.map((entry) => entry.total || 0));

    for (const entry of sourceEntries) {
      const type = String(entry.type ?? "Industry");
      if (type !== "City" && type !== "Port") {
        continue;
      }

      const sourceWeight = Math.max(0.2, (entry.total || 0) / maxSourceTotal);
      const typeBonus = type === "City" ? 1.25 : 1;
      addEconomicSource(
        sources,
        entry.tile,
        (8 + (type === "City" ? 6 : 8)) * sourceWeight * typeBonus,
        type,
      );
    }

    return sources;
  }

  function createTradeBalanceRow(entry) {
    const row = document.createElement("span");
    row.className = "openfront-helper-trade-row";
    const name = document.createElement("span");
    name.className = "openfront-helper-trade-name";
    name.textContent = entry.partnerName;
    const valueWrap = document.createElement("span");
    valueWrap.className = "openfront-helper-trade-value-wrap";
    const value = document.createElement("span");
    value.className = "openfront-helper-trade-value";
    value.textContent = formatTradeBalanceAmount(entry.total);
    const direction = document.createElement("span");
    direction.className = "openfront-helper-trade-direction";
    direction.textContent = getTradeBalanceDirection(entry);
    valueWrap.append(value, direction);
    row.append(name, valueWrap);
    return row;
  }

  function renderTradeBalanceRows(badge, entries) {
    const rows = badge.querySelector(".openfront-helper-trade-rows");
    if (!rows) return;
    if (entries.length === 0) {
      rows.innerHTML = `<span class="openfront-helper-trade-empty">${tr("No observed trade yet")}</span>`;
      return;
    }
    rows.replaceChildren(...entries.map(createTradeBalanceRow));
  }

  function setTradeBalanceSummary(badge, selector, text) {
    const element = badge.querySelector(selector);
    if (element) element.textContent = text;
    return element;
  }

  function renderTradeBalanceBadge(badge, totals, spend, entries) {
    setTradeBalanceSummary(badge, ".openfront-helper-trade-imports",
      formatTradeBalanceAmount(totals.imports));
    setTradeBalanceSummary(badge, ".openfront-helper-trade-exports",
      formatTradeBalanceAmount(totals.exports));
    setTradeBalanceSummary(badge, ".openfront-helper-trade-factory-port-spend",
      formatTradeSpendAmount(spend));
    const roi = setTradeBalanceSummary(badge, ".openfront-helper-trade-roi",
      formatTradeRoi(totals.exports, spend));
    if (roi) roi.dataset.status = getTradeRoiStatus(totals.exports, spend);
    renderTradeBalanceRows(badge, entries);
    markHelperStatsLayoutDirty();
  }

  function updateTradeBalanceBreakEven(badge, totals, spend, exportWindowMs) {
    const breakEven = badge.querySelector(".openfront-helper-trade-break-even");
    if (!breakEven) return;
    const text = formatBreakEvenEstimate(totals.exports, spend, exportWindowMs);
    if (breakEven.textContent !== text) breakEven.textContent = text;
  }

  function showTradeBalanceBadge(badge) {
    tradeBadgeHideAt = 0;
    if (badge.dataset.visible === "true") return;
    badge.dataset.visible = "true";
    syncHelperStatsContainerVisibility();
    markHelperStatsLayoutDirty();
  }

  function updateTradeBalanceBadge() {
    const badge = ensureTradeBalanceBadge();
    if (!runtimeState.tradeBalancesEnabled) {
      if (badge.dataset.visible !== "false") {
        badge.dataset.visible = "false";
        syncHelperStatsContainerVisibility();
      }
      return;
    }

    const context = getOpenFrontGameContext();
    if (context?.game) {
      processTradeBalanceUpdates(context.game);
    }

    const overlay = getHoveredPlayerInfoOverlay();
    if (!overlay?.game) {
      // Not hovering a nation — hide after a short grace (kept open while the
      // pointer is over the panel) so it stays grabbable.
      hideTradeBadgeSoon(badge);
      return;
    }

    const totals = getTradeBalanceTotals(overlay.player);
    const factoryPortSpendTotal = getFactoryPortSpendTotal(overlay.player);
    const entries = getTradeBalanceEntries(overlay.player);
    const nextRenderSignature = getTradeBalanceRenderSignature(
      overlay.player,
      totals,
      factoryPortSpendTotal,
      entries,
    );

    const exportWindowMs = Number.isFinite(totals.firstExportAt)
      ? Date.now() - totals.firstExportAt
      : NaN;

    if (nextRenderSignature !== runtimeState.tradeBalanceRenderSignature) {
      runtimeState.tradeBalanceRenderSignature = nextRenderSignature;
      renderTradeBalanceBadge(badge, totals, factoryPortSpendTotal, entries);
    }

    // Break-even depends on wall-clock time even when no other data changed;
    // update only its text node (no full re-render).
    updateTradeBalanceBreakEven(badge, totals, factoryPortSpendTotal, exportWindowMs);
    showTradeBalanceBadge(badge);
    syncHelperStatsLayoutIfDirty();
  }

  function setTradeBalancesEnabled(enabled) {
    runtimeState.tradeBalancesEnabled = Boolean(enabled);
    if (!runtimeState.tradeBalancesEnabled) {
      runtimeState.tradeBalanceAnimationFrame = null;
      runtimeState.lastProcessedTradeBalanceTick = null;
      runtimeState.lastTradeBalanceRenderAt = 0;
      runtimeState.tradeBalanceRenderSignature = "";
      unregisterHelperTickListener(updateTradeBalanceBadge);
      if (!runtimeState.exportPartnerHeatmapEnabled && !runtimeState.economyHeatmapEnabled) {
        tradeBalanceTrackers.clear();
        exportPartnerSourceTrackers.clear();
        factoryPortSpendTrackers.clear();
        factoryPortUnitTrackers.clear();
        trainTradeTrackers.clear();
        tradeShipSourceTrackers.clear();
      }
      const badge = document.getElementById(TRADE_BALANCE_BADGE_ID);
      if (badge) {
        badge.dataset.visible = "false";
      }
      syncHelperStatsContainerVisibility();
      return;
    }

    registerHelperTickListener(updateTradeBalanceBadge);
  }
