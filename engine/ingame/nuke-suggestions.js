// Hover-target nuke strike suggestions for atom and hydrogen bombs.

  const NUKE_SUGGESTION_TYPES = [
    {
      id: "atom",
      type: "Atom Bomb",
      label: "Atom",
      color: "rgba(250, 204, 21, 0.95)",
      fill: "rgba(250, 204, 21, 0.16)",
      glow: "rgba(250, 204, 21, 0.36)",
      maxRawSeeds: 72,
      maxRefineSeeds: 10,
    },
    {
      id: "hydrogen",
      type: "Hydrogen Bomb",
      label: "Hydrogen",
      color: "rgba(34, 211, 238, 0.95)",
      fill: "rgba(34, 211, 238, 0.13)",
      glow: "rgba(34, 211, 238, 0.36)",
      maxRawSeeds: 58,
      maxRefineSeeds: 8,
    },
  ];
  const NUKE_ECONOMIC_SUGGESTION = {
    id: "economic",
    label: "Economy",
    color: "rgba(74, 222, 128, 0.95)",
    fill: "rgba(74, 222, 128, 0.14)",
    glow: "rgba(74, 222, 128, 0.36)",
    maxRawSeeds: 64,
    maxRefineSeeds: 8,
  };
  const NUKE_ECONOMIC_HYDROGEN_MIN_GAIN = 500000;
  const NUKE_ECONOMIC_HYDROGEN_GAIN_RATIO = 1.2;
  const NUKE_SUGGESTION_FALLBACK_COSTS = {
    "Atom Bomb": 750000,
    "Hydrogen Bomb": 5000000,
  };
  const AUTO_NUKE_ACTION_COOLDOWN_MS = 600;
  const AUTO_NUKE_PATCH_RETRY_MS = 700;
  const AUTO_NUKE_MENU_ITEM_PREFIX = "openfront-helper-auto-nuke";
  const AUTO_NUKE_CONTEXT_MENU_ID = "openfront-helper-auto-nuke-menu";
  const AUTO_NUKE_CONTEXT_MENU_STYLE_ID = "openfront-helper-auto-nuke-menu-styles";
  const AUTO_NUKE_PROCESS_PANEL_ID = "openfront-helper-auto-nuke-process";
  const AUTO_NUKE_PROCESS_PANEL_STYLE_ID = "openfront-helper-auto-nuke-process-styles";
  const AUTO_NUKE_SEQUENCE_DELAY_MS = 60;
  const AUTO_NUKE_FALLBACK_LANDING_MS = 60000;
  const AUTO_NUKE_PROCESS_COMPLETE_HIDE_MS = 3500;
  const AUTO_NUKE_GAME_TICK_MS = 100;
  const AUTO_NUKE_MAX_SAM_BURN_SHOTS_PER_STACK = 160;
  const AUTO_NUKE_SAM_STACK_SAFETY_BURN_PER_EXTRA_LEVEL = 1;
  // Fraction of the stack's total level sum added as safety burns. Scales with stack
  // weight so single-unit high-level stacks (e.g. one level-5 SAM) still get enough
  // overshoot, and heavy multi-stacks (level sum 15+) get proportionally more.
  const AUTO_NUKE_SAM_STACK_SAFETY_BURN_LEVEL_FRACTION = 0.35;
  const AUTO_NUKE_SAM_STACK_SAFETY_BURN_CAP = 10;
  const AUTO_NUKE_SECOND_PASS_POLL_MS = 1000;
  const AUTO_NUKE_SECOND_PASS_MAX_WAIT_MS = 8 * 60 * 1000;
  const AUTO_NUKE_SECOND_PASS_READY_SLOT_FRACTION = 0.6;
  const AUTO_NUKE_SECOND_PASS_SPREAD_MULTIPLIER = 1.65;
  const AUTO_NUKE_THIRD_PASS_READY_SLOT_FRACTION = 0.7;
  const AUTO_NUKE_THIRD_PASS_SPREAD_MULTIPLIER = 2.25;
  const AUTO_NUKE_SECOND_PASS_LAUNCH_SLOT_FRACTION = 0.58;
  const AUTO_NUKE_MAX_SAM_CLEAR_WAVES = 10;
  const AUTO_NUKE_MAX_FOLLOWUP_WAVES = 4;
  const AUTO_NUKE_MAX_DESTRUCTION_WAVES = 60;
  const AUTO_NUKE_FOLLOWUP_SPREAD_MULTIPLIER = 1.5;
  const AUTO_NUKE_BLOCKING_STACK_BASE_CAPACITY = 10;
  const AUTO_NUKE_BLOCKING_STACK_SCORE_FRACTION = 0.55;
  const AUTO_NUKE_MAX_PREEMPTIVE_SAM_WAVES = 4;
  const AUTO_NUKE_MAX_CANDIDATES_PER_SPEC = 28;
  const AUTO_NUKE_MIN_MARGINAL_SCORE = 1;
  const AUTO_NUKE_DESTRUCTION_BUILDING_BONUS = 2500000;
  const AUTO_NUKE_DESTRUCTION_CONFIRMATION_SHOTS = 2;
  const AUTO_NUKE_DESTRUCTION_SAM_BONUS = 3500000;
  // Base number of insurance overshoot shots added AFTER the main SAM-clear shot.
  // Helps ensure the stack is destroyed even if a SAM is upgraded or rebuilt mid-flight.
  const AUTO_NUKE_DESTRUCTION_SAM_OVERSHOOT_SHOTS = 2;
  // Hard cap on overshoot shots per stack (after scaling by stack depth).
  const AUTO_NUKE_MAX_SAM_OVERSHOOT_SHOTS = 5;
  // SAM launcher construction takes ~30 seconds (300 ticks). Upgrades (stacking onto
  // an existing stack) are instant — they just bump the unit's level. We anticipate
  // both cases so planned waves don't get shot down by SAMs that come online mid-attack.
  const AUTO_NUKE_SAM_CONSTRUCTION_TICKS = 300;
  // Safety buffer: assume each already-built enemy stack could gain +1 slot via an
  // instant upgrade during our nuke flight. Used only when estimating blocking stacks.
  const AUTO_NUKE_SAM_UPGRADE_BUFFER = 1;
  const AUTO_NUKE_INTENSITY_TIERS = [
    {
      id: "low",
      label: "Low",
      minShots: 1,
      shotFraction: 0.25,
    },
    {
      id: "medium",
      label: "Medium",
      minShots: 2,
      shotFraction: 0.55,
    },
    {
      id: "high",
      label: "High",
      minShots: 3,
      shotFraction: 1,
    },
  ];
  const AUTO_NUKE_TIER_ORDER = new Map(
    AUTO_NUKE_INTENSITY_TIERS.map((tier, index) => [tier.id, index]),
  );

  const NUKE_SUGGESTION_STRUCTURE_TYPES = [
    "City",
    "Defense Post",
    "SAM Launcher",
    "Missile Silo",
    "Port",
    "Factory",
  ];
  const NUKE_SUGGESTION_BUCKET_SIZE = 16;
  const NUKE_SUGGESTION_SAMPLE_LIMIT = 80;
  const NUKE_SUGGESTION_MAX_FINAL_CANDIDATES = 40;
  // Building-impact placement is a bounded second-stage optimization. Running
  // it for every raw seed made a single refresh multiply the geometry search
  // across dozens of candidates and caused visible main-thread stalls.
  const NUKE_SUGGESTION_MAX_BUILDING_IMPACT_OPTIMIZATIONS = 16;
  const NUKE_SUGGESTION_TILE_INFO_CACHE_MS = 2500;
  // A full ownership scan is O(map area). Keep every slice below a frame so a
  // hover over an enemy never turns a large map into a single long task.
  const NUKE_SUGGESTION_TILE_SCAN_SLICE_MS = 6;
  const NUKE_SUGGESTION_TILE_SCAN_YIELD_INTERVAL = 256;
  const NUKE_SUGGESTION_SIGNATURE_CHECK_MS = 250;
  let nukeSuggestionFrameCounter = 2;
  const nukeSuggestionWorldQueryArg = { x: 0, y: 0 };
  let nukeSuggestionTileInfoCache = null;
  const nukeSuggestionDomCache = new Map();
  let lastAutoNukeActionAt = 0;
  let autoNukeIncludeAllies = false;
  let autoNukeContextMenuInstalled = false;
  let autoNukeContextMenuParams = null;
  let autoNukeContextMenuComputeId = 0;
  let autoNukeProcessHideTimeout = null;
  let autoNukeWaveLog = [];
  let nextNukeSuggestionUnitObjectId = 1;
  const nukeSuggestionUnitObjectIds = new WeakMap();
  // Tracks when each enemy SAM Launcher was first observed under construction, so we
  // can bound the worst-case completion tick monotonically across polls.
  const nukeSuggestionPendingSamFirstSeen = new Map();

  function ensureNukeSuggestionStyles() {
    if (document.getElementById(NUKE_SUGGESTION_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = NUKE_SUGGESTION_STYLE_ID;
    style.textContent = `
      #${NUKE_SUGGESTION_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 8000;
        pointer-events: none;
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-zone {
        position: fixed;
        left: var(--suggestion-x);
        top: var(--suggestion-y);
        width: var(--suggestion-diameter);
        height: var(--suggestion-diameter);
        border: 2px dashed var(--suggestion-color);
        border-radius: 50%;
        background: var(--suggestion-fill);
        box-shadow:
          0 0 18px var(--suggestion-glow),
          inset 0 0 24px var(--suggestion-fill);
        transform: translate(-50%, -50%);
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-zone[data-suggestion-status="blocked"] {
        opacity: 0.62;
        border-style: dotted;
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-zone::before,
      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-zone::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        background: var(--suggestion-color);
        box-shadow: 0 0 10px var(--suggestion-glow);
        transform: translate(-50%, -50%);
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-zone::before {
        width: 28px;
        height: 2px;
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-zone::after {
        width: 2px;
        height: 28px;
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-label {
        position: fixed;
        left: var(--suggestion-x);
        top: calc(var(--suggestion-y) - var(--suggestion-radius) - var(--suggestion-label-gap));
        padding: 4px 8px;
        border: 1px solid var(--suggestion-color);
        border-radius: 8px;
        background: rgba(7, 12, 18, 0.86);
        color: var(--suggestion-color);
        font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92);
        transform: translate(-50%, -100%);
        white-space: nowrap;
      }

      #${NUKE_SUGGESTION_CONTAINER_ID} .openfront-helper-nuke-suggestion-label[data-suggestion-status="blocked"] {
        opacity: 0.72;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureNukeSuggestionContainer() {
    ensureNukeSuggestionStyles();

    let container = document.getElementById(NUKE_SUGGESTION_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = NUKE_SUGGESTION_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function getNukeSuggestionMagnitude(game, unitType) {
    {
      const magnitude = game?.config?.().nukeMagnitudes?.(unitType);
      const inner = Number(magnitude?.inner);
      const outer = Number(magnitude?.outer);
      if (Number.isFinite(inner) && Number.isFinite(outer) && outer > 0) {
        return {
          inner: Math.max(0, inner),
          outer,
        };
      }
    }

    return unitType === "Hydrogen Bomb"
      ? { inner: 80, outer: 100 }
      : { inner: 12, outer: 30 };
  }

  function isNukeSuggestionTypeEnabled(game, unitType) {
    {
      return !game?.config?.().isUnitDisabled?.(unitType);
    }
  }

  function getNukeSuggestionUnitCost(game, player, unitType) {
    const readCost = (unitInfo) => {
      const numericCost = Number(unitInfo?.(unitType)?.cost?.(game, player));
      return Number.isFinite(numericCost) && numericCost >= 0
        ? numericCost
        : null;
    };
    {
      const cost = readCost(game?.unitInfo?.bind(game));
      if (cost !== null) return cost;
    }{
      const config = game?.config?.();
      const cost = readCost(config?.unitInfo?.bind(config));
      if (cost !== null) return cost;
    }

    return NUKE_SUGGESTION_FALLBACK_COSTS[unitType] ?? Infinity;
  }

  function isHydrogenCheaperThanFiveAtomNukes(game, player) {
    const atomCost = getNukeSuggestionUnitCost(game, player, "Atom Bomb");
    const hydrogenCost = getNukeSuggestionUnitCost(game, player, "Hydrogen Bomb");
    return hydrogenCost < atomCost * 5;
  }

  function shouldComputeNukeSuggestionSpec(game, player, spec) {
    if (!spec || !isNukeSuggestionTypeEnabled(game, spec.type)) {
      return false;
    }
    if (spec.type !== "Hydrogen Bomb") {
      return true;
    }
    return isHydrogenCheaperThanFiveAtomNukes(game, player);
  }

  function getNukeSuggestionScreenRadius(transform, screenPos, worldRadius) {
    const scale = Number(transform?.scale);
    if (Number.isFinite(scale) && scale > 0) {
      return worldRadius * scale;
    }

    {
      const reference = transform.worldToScreenCoordinates({
        x: screenPos.worldX + worldRadius,
        y: screenPos.worldY,
      });
      return Math.hypot(reference.x - screenPos.x, reference.y - screenPos.y);
    }
  }

  function getUnitTile(unit) {
    {
      const tile = Number(unit?.tile?.());
      return Number.isFinite(tile) ? tile : null;
    }
  }

  function getUnitType(unit) {
    {
      return String(unit?.type?.() ?? unit?.data?.unitType ?? "");
    }
  }

  function getUnitKey(unit) {
    {
      const id = unit?.id?.();
      if (id !== undefined && id !== null) {
        return String(id);
      }
    }

    if (unit && (typeof unit === "object" || typeof unit === "function")) {
      let objectId = nukeSuggestionUnitObjectIds.get(unit);
      if (!objectId) {
        objectId = nextNukeSuggestionUnitObjectId++;
        nukeSuggestionUnitObjectIds.set(unit, objectId);
      }
      return `object:${objectId}`;
    }

    const tile = getUnitTile(unit);
    return tile === null ? "" : `tile:${tile}`;
  }

  function getMissileTimerQueue(unit) {
    {
      const queue = unit?.missileTimerQueue?.();
      if (Array.isArray(queue)) {
        return queue;
      }
    }

    return Array.isArray(unit?.data?.missileTimerQueue)
      ? unit.data.missileTimerQueue
      : [];
  }

  function isActiveFinishedUnit(unit) {
    {
      return Boolean(unit?.isActive?.()) && !unit?.isUnderConstruction?.();
    }
  }

  function isActiveUnderConstructionUnit(unit) {
    {
      return Boolean(unit?.isActive?.()) && Boolean(unit?.isUnderConstruction?.());
    }
  }

  function getNukeSuggestionSamConstructionTicks(game) {
    const infoSources = [];
    {
      if (typeof game?.unitInfo === "function") {
        infoSources.push(game.unitInfo("SAM Launcher"));
      }
    }{
      const unitInfo = game?.config?.()?.unitInfo;
      if (typeof unitInfo === "function") {
        infoSources.push(unitInfo("SAM Launcher"));
      }
    }

    for (const info of infoSources) {
      const rawDuration =
        typeof info?.constructionDuration === "function"
          ? info.constructionDuration()
          : info?.constructionDuration;
      const duration = Number(rawDuration);
      if (Number.isFinite(duration) && duration > 0) {
        return duration;
      }
    }

    return AUTO_NUKE_SAM_CONSTRUCTION_TICKS;
  }

  function getNukeSuggestionConstructionStartTick(sam) {
    const raw = sam?.__src || sam;
    const state = raw?.state;
    const candidates = [
      state?.constructionStartTick,
      raw?.constructionStartTick,
      typeof raw?.getConstructionStartTick === "function"
        ? raw.getConstructionStartTick()
        : null,
    ];
    for (const candidate of candidates) {
      const tick = Number(candidate);
      if (Number.isFinite(tick)) {
        return tick;
      }
    }
    return null;
  }

  // Estimate the tick at which a currently-under-construction SAM will come online.
  // Prefer the exact construction start exposed by UnitView; otherwise record the
  // earliest tick we spotted it and conservatively allow the full build duration.
  function getPendingSamExpectedReadyTick(game, sam, currentTick) {
    const key = getUnitKey(sam);
    const now = Number.isFinite(currentTick) ? currentTick : getCurrentGameTick(game);
    const constructionStartTick = getNukeSuggestionConstructionStartTick(sam);
    if (Number.isFinite(constructionStartTick)) {
      return constructionStartTick + getNukeSuggestionSamConstructionTicks(game);
    }
    if (!key) {
      return now + AUTO_NUKE_SAM_CONSTRUCTION_TICKS;
    }
    let firstSeen = nukeSuggestionPendingSamFirstSeen.get(key);
    if (!Number.isFinite(firstSeen)) {
      firstSeen = now;
      nukeSuggestionPendingSamFirstSeen.set(key, firstSeen);
    }
    return firstSeen + AUTO_NUKE_SAM_CONSTRUCTION_TICKS;
  }

  function pruneFinishedPendingSamTracker(activeUnitKeys) {
    if (nukeSuggestionPendingSamFirstSeen.size === 0) return;
    for (const key of Array.from(nukeSuggestionPendingSamFirstSeen.keys())) {
      if (!activeUnitKeys.has(key)) {
        nukeSuggestionPendingSamFirstSeen.delete(key);
      }
    }
  }

  function isMissileUnitReady(unit) {
    if (!isActiveFinishedUnit(unit)) {
      return false;
    }

    const level = getUnitLevel(unit);
    return getMissileTimerQueue(unit).length < level;
  }

  function getPlayerUnits(player, ...types) {
    {
      return Array.from(player?.units?.(...types) || []);
    }
  }

  function collectReadyNukeSilos(player) {
    return getPlayerUnits(player, "Missile Silo").filter(isMissileUnitReady);
  }

  function collectActiveNukeSilos(player) {
    return getPlayerUnits(player, "Missile Silo").filter(isActiveFinishedUnit);
  }

  function collectTargetSams(player) {
    return getPlayerUnits(player, "SAM Launcher").filter(isActiveFinishedUnit);
  }

  function isNukeSuggestionSamOwnerHostileToLauncher(myPlayer, player) {
    if (!myPlayer?.isPlayer?.() || !player?.isPlayer?.()) {
      return false;
    }
    if (getPlayerSmallId(myPlayer) === getPlayerSmallId(player)) {
      return false;
    }

    {
      return !myPlayer.isFriendly?.(player) && !player.isFriendly?.(myPlayer);
    }
  }

  function getPlayerBySmallIdSafe(game, smallId) {
    const numericId = Number(smallId);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return null;
    }

    {
      const player = game?.playerBySmallID?.(numericId);
      return player?.isPlayer?.() ? player : null;
    }
  }

  function collectAdjacentHostileSams(game, myPlayer, targetPlayer, tileInfo) {
    // Return cached result if already computed for this tileInfo object.
    if (tileInfo.adjacentHostileSamsCache !== null) {
      return tileInfo.adjacentHostileSamsCache;
    }

    const adjacentPlayerIds = collectAdjacentPlayerIds(
      game,
      tileInfo.tiles,
      getPlayerSmallId(targetPlayer),
    );

    const sams = [];
    const seenSamIds = new Set();
    for (const playerId of adjacentPlayerIds) {
      const player = getPlayerBySmallIdSafe(game, playerId);
      if (!isNukeSuggestionSamOwnerHostileToLauncher(myPlayer, player)) {
        continue;
      }

      for (const sam of collectTargetSams(player)) {
        const samId = getUnitKey(sam);
        if (seenSamIds.has(samId)) {
          continue;
        }
        seenSamIds.add(samId);
        sams.push(sam);
      }
    }

    tileInfo.adjacentHostileSamsCache = sams;
    return sams;
  }

  function collectAdjacentPlayerIds(game, tiles, targetId) {
    const playerIds = new Set();
    for (const point of tiles) {
      const neighbors = game.neighbors?.(point.tile) || [];
      for (const neighborTile of neighbors) {
        {
          const ownerId = game.ownerID(neighborTile);
          if (ownerId > 0 && ownerId !== targetId) playerIds.add(ownerId);
        }
      }
    }
    return playerIds;
  }

  function collectRelevantSams(game, myPlayer, targetPlayer, tileInfo) {
    const sams = [];
    const seenSamIds = new Set();

    for (const sam of [
      ...collectTargetSams(targetPlayer),
      ...collectAdjacentHostileSams(game, myPlayer, targetPlayer, tileInfo),
    ]) {
      const samId = getUnitKey(sam);
      if (seenSamIds.has(samId)) {
        continue;
      }
      seenSamIds.add(samId);
      sams.push(sam);
    }

    return sams;
  }

  function collectAllHostileSams(game, myPlayer) {
    const sams = [];
    const seenSamIds = new Set();

    function addSam(sam) {
      if (!isActiveFinishedUnit(sam)) {
        return;
      }

      let owner;
      {
        owner = sam?.owner?.();
      }
      if (!isNukeSuggestionSamOwnerHostileToLauncher(myPlayer, owner)) {
        return;
      }

      const samId = getUnitKey(sam);
      if (!samId || seenSamIds.has(samId)) {
        return;
      }
      seenSamIds.add(samId);
      sams.push(sam);
    }

    {
      for (const sam of game?.units?.("SAM Launcher") || []) {
        addSam(sam);
      }
    }{
      for (const player of game?.playerViews?.() || []) {
        if (!isNukeSuggestionSamOwnerHostileToLauncher(myPlayer, player)) {
          continue;
        }
        for (const sam of collectTargetSams(player)) {
          addSam(sam);
        }
      }
    }

    return sams;
  }

  function collectPendingHostileSams(game, myPlayer) {
    const sams = [];
    const seenSamIds = new Set();

    function addSam(sam) {
      if (!isActiveUnderConstructionUnit(sam)) {
        return;
      }

      let owner;
      {
        owner = sam?.owner?.();
      }
      if (!isNukeSuggestionSamOwnerHostileToLauncher(myPlayer, owner)) {
        return;
      }

      const samId = getUnitKey(sam);
      if (!samId || seenSamIds.has(samId)) {
        return;
      }
      seenSamIds.add(samId);
      sams.push(sam);
    }

    {
      for (const sam of game?.units?.("SAM Launcher") || []) {
        addSam(sam);
      }
    }{
      for (const player of game?.playerViews?.() || []) {
        if (!isNukeSuggestionSamOwnerHostileToLauncher(myPlayer, player)) {
          continue;
        }
        for (const sam of getPlayerUnits(player, "SAM Launcher")) {
          addSam(sam);
        }
      }
    }

    return sams;
  }

  function getUnitOwner(unit) {
    {
      return unit?.owner?.() || null;
    }
  }

  function isSamOwnedByNukeTarget(baseContext, sam) {
    const owner = getUnitOwner(sam);
    return (
      owner?.isPlayer?.() &&
      getPlayerSmallId(owner) === getPlayerSmallId(baseContext.targetPlayer)
    );
  }

  function getSamStackKey(sam) {
    const tile = getUnitTile(sam);
    if (tile === null) {
      return "";
    }

    const owner = getUnitOwner(sam);
    const ownerId = getPlayerSmallId(owner);
    return `${Number.isFinite(ownerId) ? ownerId : "unknown"}:${tile}`;
  }

  function getStackedSamLevel(sams, sam) {
    const stackKey = getSamStackKey(sam);
    if (!stackKey) {
      return getUnitLevel(sam);
    }

    let stackedLevel = 0;
    for (const otherSam of sams || []) {
      if (getSamStackKey(otherSam) === stackKey) {
        stackedLevel += getUnitLevel(otherSam);
      }
    }

    return Math.max(getUnitLevel(sam), stackedLevel);
  }

  function getSamStackUnitKeys(sams, stackKey) {
    return (sams || [])
      .filter((sam) => getSamStackKey(sam) === stackKey)
      .map(getUnitKey)
      .filter(Boolean);
  }

  function collectTargetStructures(player) {
    return getPlayerUnits(player, ...NUKE_SUGGESTION_STRUCTURE_TYPES)
      .filter((unit) => {
      {
        return Boolean(unit?.isActive?.());
      }
    })
      .map((unit) => ({
        unit,
        tile: getUnitTile(unit),
        type: getUnitType(unit),
      }))
      .filter((entry) => entry.tile !== null);
  }

  function isTeamGame(game) {
    {
      return game?.config?.().gameConfig?.().gameMode === "Team";
    }
  }

  function collectTeamStructures(game, myPlayer) {
    if (!isTeamGame(game)) {
      return [];
    }

    {
      return Array.from(game.units?.(...NUKE_SUGGESTION_STRUCTURE_TYPES) || [])
        .filter((unit) => {
          if (!isActiveFinishedUnit(unit)) {
            return false;
          }
          const owner = unit.owner?.();
          return owner?.isPlayer?.() && myPlayer?.isOnSameTeam?.(owner);
        })
        .map((unit) => ({
          tile: getUnitTile(unit),
        }))
        .filter((entry) => entry.tile !== null);
    }
  }

  function collectAlliedPlayerSmallIds(game, myPlayer) {
    const allyIds = new Set();
    const addAllyId = (ally) => {
      const allyId = getPlayerSmallId(ally);
      if (Number.isFinite(allyId)) allyIds.add(allyId);
    };

    {
      for (const ally of myPlayer?.allies?.() || []) {
        addAllyId(ally);
      }
    }{
      for (const player of game?.playerViews?.() || []) {
        if (isDistinctAlliedPlayer(myPlayer, player)) addAllyId(player);
      }
    }

    return allyIds;
  }

  function isDistinctAlliedPlayer(myPlayer, player) {
    if (!player?.isPlayer?.()) return false;
    if (getPlayerSmallId(player) === getPlayerSmallId(myPlayer)) return false;
    return (
      myPlayer?.isAlliedWith?.(player) || player?.isAlliedWith?.(myPlayer) || false
    );
  }

  function collectAlliedStructures(game, allySmallIds) {
    if (!allySmallIds?.size) {
      return [];
    }

    {
      return Array.from(game.units?.(...NUKE_SUGGESTION_STRUCTURE_TYPES) || [])
        .filter((unit) => {
          if (!isActiveFinishedUnit(unit)) {
            return false;
          }
          const owner = unit.owner?.();
          return owner?.isPlayer?.() && allySmallIds.has(getPlayerSmallId(owner));
        })
        .map((unit) => ({
          tile: getUnitTile(unit),
        }))
        .filter((entry) => entry.tile !== null);
    }
  }

  function getNukeAllianceBreakThreshold(game) {
    {
      const threshold = Number(game?.config?.().nukeAllianceBreakThreshold?.());
      return Number.isFinite(threshold) && threshold >= 0 ? threshold : 100;
    }
  }

  function isEnemyNukeSuggestionTarget(game, targetPlayer) {
    const myPlayer = game?.myPlayer?.();
    if (!isDistinctAlivePlayer(myPlayer, targetPlayer)) return false;

    {
      return !myPlayer.isFriendly?.(targetPlayer) && !targetPlayer.isFriendly?.(myPlayer);
    }
  }

  function isDistinctAlivePlayer(myPlayer, targetPlayer) {
    if (!myPlayer?.isPlayer?.() || !targetPlayer?.isPlayer?.()) return false;
    if (!targetPlayer.isAlive?.()) return false;
    return getPlayerSmallId(myPlayer) !== getPlayerSmallId(targetPlayer);
  }

  function makeNukeSuggestionBucketKey(x, y, bucketSize = NUKE_SUGGESTION_BUCKET_SIZE) {
    return `${Math.floor(x / bucketSize)}:${Math.floor(y / bucketSize)}`;
  }

  function addNukeSuggestionPointToBucket(buckets, point) {
    const key = makeNukeSuggestionBucketKey(point.x, point.y);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(point);
  }

  function getNukeSuggestionPlayerTileCount(player) {
    return Math.max(0, toFiniteNumber(player?.numTilesOwned?.(), 0));
  }

  function getNukeSuggestionTileInfoCacheKey(game, targetPlayer, myPlayer, allySmallIds) {
    const allyKey = Array.from(allySmallIds || [])
      .sort((a, b) => a - b)
      .map((allyId) => {
        const ally = getPlayerBySmallIdSafe(game, allyId);
        return `${allyId}:${getNukeSuggestionPlayerTileCount(ally)}`;
      })
      .join("|");

    return [
      Number(game?.width?.()) || 0,
      Number(game?.height?.()) || 0,
      getPlayerSmallId(targetPlayer),
      getNukeSuggestionPlayerTileCount(targetPlayer),
      getPlayerSmallId(myPlayer),
      getNukeSuggestionPlayerTileCount(myPlayer),
      allyKey,
    ].join(":");
  }

  function createTileScanBuilder(game, scan) {
    const { targetId, myPlayerId, allySmallIds, width, height } = scan;
    return {
      game,
      targetId,
      myPlayerId,
      allySmallIds,
      width,
      height,
      totalTiles: width * height,
      nextTile: 0,
      tiles: [],
      buckets: new Map(),
      selfBuckets: new Map(),
      allyBuckets: new Map(),
      otherPlayerBuckets: new Map(),
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      sumX: 0,
      sumY: 0,
    };
  }

  function finishTileScan(builder) {
    if (builder.tiles.length === 0) return null;
    return {
      tiles: builder.tiles,
      buckets: builder.buckets,
      selfBuckets: builder.selfBuckets,
      allyBuckets: builder.allyBuckets,
      otherPlayerBuckets: builder.otherPlayerBuckets,
      adjacentHostileSamsCache: null,
      bbox: {
        minX: builder.minX,
        minY: builder.minY,
        maxX: builder.maxX,
        maxY: builder.maxY,
      },
      centroid: {
        x: builder.sumX / builder.tiles.length,
        y: builder.sumY / builder.tiles.length,
      },
    };
  }

  function advanceTileScan(builder, deadline = Infinity) {
    const { game, targetId, myPlayerId, allySmallIds } = builder;
    while (builder.nextTile < builder.totalTiles) {
      const tile = builder.nextTile++;
      let ownerId;
      {
        ownerId = game.ownerID(tile);
      }
      const x = game.x(tile);
      const y = game.y(tile);
      const point = { tile, x, y, ownerId };

      if (ownerId === myPlayerId) {
        addNukeSuggestionPointToBucket(builder.selfBuckets, point);
      } else if (allySmallIds?.has(ownerId)) {
        addNukeSuggestionPointToBucket(builder.allyBuckets, point);
      } else if (ownerId !== targetId) {
        if (ownerId > 0) {
          addNukeSuggestionPointToBucket(builder.otherPlayerBuckets, point);
        }
      } else {
        builder.tiles.push(point);
        builder.minX = Math.min(builder.minX, x);
        builder.minY = Math.min(builder.minY, y);
        builder.maxX = Math.max(builder.maxX, x);
        builder.maxY = Math.max(builder.maxY, y);
        builder.sumX += x;
        builder.sumY += y;
        addNukeSuggestionPointToBucket(builder.buckets, point);
      }
      if (
        builder.nextTile < builder.totalTiles &&
        builder.nextTile % NUKE_SUGGESTION_TILE_SCAN_YIELD_INTERVAL === 0 &&
        performance.now() >= deadline
      ) {
        return null;
      }
    }
    return finishTileScan(builder);
  }

  function collectTargetTileInfo(game, targetPlayer, myPlayer, allySmallIds) {
    const targetId = getPlayerSmallId(targetPlayer);
    const myPlayerId = getPlayerSmallId(myPlayer);
    const width = Number(game?.width?.());
    const height = Number(game?.height?.());
    if (!isValidTileScanShape({ targetId, myPlayerId, width, height })) return null;

    const cacheKey = getNukeSuggestionTileInfoCacheKey(
      game,
      targetPlayer,
      myPlayer,
      allySmallIds,
    );
    const now = performance.now();
    if (
      nukeSuggestionTileInfoCache?.key === cacheKey &&
      now - nukeSuggestionTileInfoCache.updatedAt <=
        NUKE_SUGGESTION_TILE_INFO_CACHE_MS
    ) {
      return nukeSuggestionTileInfoCache.value;
    }

    // Defer the expensive tile scan to a setTimeout so it doesn't block
    // the current animation frame. Return stale data (or null) in the meantime.
    if (runtimeState.nukeSuggestionTileComputeKey !== cacheKey) {
      scheduleTargetTileInfoScan(game, cacheKey, {
        targetId,
        myPlayerId,
        allySmallIds,
        width,
        height,
      });
    }

    // Return stale data while recomputing, or null for the very first hover.
    return nukeSuggestionTileInfoCache?.value ?? null;
  }

  function isValidTileScanShape({ targetId, myPlayerId, width, height }) {
    return (
      Number.isFinite(targetId) &&
      Number.isFinite(myPlayerId) &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    );
  }

  function scheduleTargetTileInfoScan(game, cacheKey, scan) {
    runtimeState.nukeSuggestionTileComputeKey = cacheKey;
    const builder = createTileScanBuilder(game, scan);
    const runSlice = () => {
      if (runtimeState.nukeSuggestionTileComputeKey !== cacheKey) return;
      const tileInfo = advanceTileScan(
        builder,
        performance.now() + NUKE_SUGGESTION_TILE_SCAN_SLICE_MS,
      );
      if (tileInfo === null && builder.nextTile < builder.totalTiles) {
        setTimeout(runSlice, 0);
        return;
      }
      if (runtimeState.nukeSuggestionTileComputeKey !== cacheKey) return;
      runtimeState.nukeSuggestionTileComputeKey = null;
      nukeSuggestionTileInfoCache = {
        key: cacheKey,
        updatedAt: performance.now(),
        value: tileInfo,
      };
      runtimeState.lastNukeSuggestionSignatureCheckAt = 0;
      runtimeState.lastNukeSuggestionSignature = "";
    };
    setTimeout(runSlice, 0);
  }

  function getTileFromXY(game, x, y) {
    const tileX = Math.round(x);
    const tileY = Math.round(y);
    {
      if (!game?.isValidCoord?.(tileX, tileY)) {
        return null;
      }
      return game.ref(tileX, tileY);
    }
  }

  function addNukeSuggestionSeed(seeds, game, tile) {
    if (tile == null) {
      return;
    }

    {
      if (!game?.isValidRef?.(tile)) {
        return;
      }
    }

    seeds.set(String(tile), tile);
  }

  function addNukeSuggestionSeedXY(seeds, game, x, y) {
    addNukeSuggestionSeed(seeds, game, getTileFromXY(game, x, y));
  }

  function addDensitySeeds(seeds, game, tileInfo, radius, maxSeeds) {
    const densityBucketSize = Math.max(8, Math.round(radius / 2));
    const densityBuckets = new Map();
    for (const point of tileInfo.tiles) {
      const key = makeNukeSuggestionBucketKey(point.x, point.y, densityBucketSize);
      let bucket = densityBuckets.get(key);
      if (!bucket) {
        bucket = {
          count: 0,
          sumX: 0,
          sumY: 0,
        };
        densityBuckets.set(key, bucket);
      }
      bucket.count++;
      bucket.sumX += point.x;
      bucket.sumY += point.y;
    }

    const sortedBuckets = Array.from(densityBuckets.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, maxSeeds);

    for (const bucket of sortedBuckets) {
      addNukeSuggestionSeedXY(
        seeds,
        game,
        bucket.sumX / bucket.count,
        bucket.sumY / bucket.count,
      );
    }
  }

  function buildNukeSuggestionSeeds(game, request) {
    const { targetPlayer, tileInfo, structures, magnitude, spec } = request;
    const seeds = new Map();
    const nameLocation = targetPlayer?.nameLocation?.();
    if (nameLocation) {
      addNukeSuggestionSeedXY(seeds, game, nameLocation.x, nameLocation.y);
    }
    addNukeSuggestionSeedXY(seeds, game, tileInfo.centroid.x, tileInfo.centroid.y);
    addNukeSuggestionSeedXY(
      seeds,
      game,
      (tileInfo.bbox.minX + tileInfo.bbox.maxX) / 2,
      (tileInfo.bbox.minY + tileInfo.bbox.maxY) / 2,
    );

    const seedStructures = spec.scoreMode === "destruction"
      ? structures.filter(isPopulationOrEconomicNukeObjective)
      : structures;

    for (const structure of seedStructures) {
      addNukeSuggestionSeed(seeds, game, structure.tile);
    }

    addDensitySeeds(
      seeds,
      game,
      tileInfo,
      magnitude.outer,
      Math.max(24, Math.floor(spec.maxRawSeeds / 3)),
    );

    const sampleLimit = Math.min(NUKE_SUGGESTION_SAMPLE_LIMIT, spec.maxRawSeeds);
    const stride = Math.max(1, Math.floor(tileInfo.tiles.length / sampleLimit));
    for (let index = 0; index < tileInfo.tiles.length; index += stride) {
      addNukeSuggestionSeed(seeds, game, tileInfo.tiles[index].tile);
      if (seeds.size >= spec.maxRawSeeds + seedStructures.length + 8) {
        break;
      }
    }

    return Array.from(seeds.values());
  }

  function getCityTroopIncrease(game) {
    {
      const increase = Number(game?.config?.().cityTroopIncrease?.());
      return Number.isFinite(increase) && increase > 0 ? increase : 250000;
    }
  }

  function getPlayerTroopsNumber(player) {
    {
      const troops = Number(player?.troops?.());
      return Number.isFinite(troops) && troops > 0 ? troops : 0;
    }
  }

  function getPlayerMaxTroopsNumber(game, player) {
    {
      const maxTroops = Number(game?.config?.().maxTroops?.(player));
      if (Number.isFinite(maxTroops) && maxTroops > 0) {
        return maxTroops;
      }
    }

    const tilesOwned = Math.max(0, toFiniteNumber(player?.numTilesOwned?.(), 0));
    const cityLevels = getPlayerUnits(player, "City")
      .filter((unit) => !unit?.isUnderConstruction?.())
      .map(getUnitLevel)
      .reduce((sum, level) => sum + level, 0);
    return 2 * (Math.pow(tilesOwned, 0.6) * 1000 + 50000) +
      cityLevels * getCityTroopIncrease(game);
  }

  function estimateNukePopulationLoss(game, nukeType, player, expectedTiles) {
    const troops = getPlayerTroopsNumber(player);
    if (troops <= 0 || expectedTiles <= 0) {
      return 0;
    }

    const tilesBeforeNuke = Math.max(1, toFiniteNumber(player?.numTilesOwned?.(), 1));
    if (nukeType === "MIRV Warhead") {
      {
        return Number(
          game?.config?.().nukeDeathFactor?.(
            nukeType,
            troops,
            tilesBeforeNuke,
            getPlayerMaxTroopsNumber(game, player),
          ),
        ) || 0;
      }
    }

    const cappedTiles = Math.min(expectedTiles, tilesBeforeNuke);
    const wholeTiles = Math.floor(cappedTiles);
    const partialTile = cappedTiles - wholeTiles;
    let remainingRatio = nukeRemainingRatioAfterWholeTiles(
      tilesBeforeNuke,
      wholeTiles,
    );

    if (partialTile > 0) {
      const numTilesLeft = Math.max(1, tilesBeforeNuke - wholeTiles);
      const lossRatio = Math.min(1, (5 / numTilesLeft) * partialTile);
      remainingRatio *= Math.max(0, 1 - lossRatio);
    }

    return troops * (1 - remainingRatio);
  }

  function nukeRemainingRatioAfterWholeTiles(tilesBeforeNuke, wholeTiles) {
    if (wholeTiles <= 0) return 1;
    if (tilesBeforeNuke <= 5 || tilesBeforeNuke - wholeTiles <= 4) return 0;
    const end = tilesBeforeNuke - wholeTiles;
    let ratio = 1;
    for (let offset = 0; offset < 5; offset++) {
      ratio *= (end - offset) / (tilesBeforeNuke - offset);
    }
    return ratio;
  }

  function estimateCityPopulationHit(game, context, cx, cy, outerSquared) {
    const troopRatio = Math.max(
      0,
      Math.min(
        1,
        getPlayerTroopsNumber(context.targetPlayer) /
          Math.max(1, getPlayerMaxTroopsNumber(game, context.targetPlayer)),
      ),
    );
    const cityTroopIncrease = getCityTroopIncrease(game);
    let cityPopulationHit = 0;
    let citiesHit = 0;
    const hitCityPopulationWeights = new Map();

    for (const structure of context.structures) {
      if (structure.type !== "City") {
        continue;
      }

      {
        const sx = game.x(structure.tile);
        const sy = game.y(structure.tile);
        const dx = sx - cx;
        const dy = sy - cy;
        if (dx * dx + dy * dy < outerSquared) {
          const cityHit = getUnitLevel(structure.unit) * cityTroopIncrease * troopRatio;
          cityPopulationHit += cityHit;
          citiesHit++;
          hitCityPopulationWeights.set(getStructureImpactKey(structure), cityHit);
        }
      }
    }

    return {
      cityPopulationHit,
      citiesHit,
      hitCityPopulationWeights,
    };
  }

  function hasNukeSuggestionTrainStation(unit) {
    {
      return Boolean(unit?.hasTrainStation?.());
    }
  }

  function getEconomicStructureWeight(structure) {
    const level = getUnitLevel(structure.unit);
    const trainStationMultiplier = hasNukeSuggestionTrainStation(structure.unit) ? 1.25 : 1;

    switch (structure.type) {
      case "Factory":
        return 1400000 * level * trainStationMultiplier;
      case "Port":
        return 900000 * level * trainStationMultiplier;
      case "City":
        return 650000 * level * trainStationMultiplier;
      default:
        return 0;
    }
  }

  function getStructureImpactKey(structure) {
    const unitKey = getUnitKey(structure.unit);
    return unitKey || `${structure.type}:${structure.tile}`;
  }

  function isPopulationOrEconomicNukeObjective(structure) {
    return structure?.type === "City" || getEconomicStructureWeight(structure) > 0;
  }

  function estimateNukeEconomicImpact(context, cx, cy, outerSquared) {
    let economicImpact = 0;
    let economicStructuresHit = 0;
    const hitEconomicStructureWeights = new Map();

    for (const structure of context.structures) {
      const structureWeight = getEconomicStructureWeight(structure);
      if (structureWeight <= 0) {
        continue;
      }

      {
        const sx = context.game.x(structure.tile);
        const sy = context.game.y(structure.tile);
        const dx = sx - cx;
        const dy = sy - cy;
        if (dx * dx + dy * dy < outerSquared) {
          economicImpact += structureWeight;
          economicStructuresHit++;
          hitEconomicStructureWeights.set(
            getStructureImpactKey(structure),
            structureWeight,
          );
        }
      }
    }

    return {
      economicImpact,
      economicStructuresHit,
      hitEconomicStructureWeights,
    };
  }

  function combineDestructionStructureWeights(
    hitEconomicStructureWeights,
    hitCityPopulationWeights,
  ) {
    const weights = new Map();
    const structureKeys = new Set([
      ...Array.from(hitEconomicStructureWeights?.keys?.() || []),
      ...Array.from(hitCityPopulationWeights?.keys?.() || []),
    ]);

    for (const structureKey of structureKeys) {
      const economicWeight = hitEconomicStructureWeights?.get?.(structureKey) || 0;
      const cityWeight = hitCityPopulationWeights?.get?.(structureKey) || 0;
      weights.set(
        structureKey,
        economicWeight + cityWeight + AUTO_NUKE_DESTRUCTION_BUILDING_BONUS,
      );
    }

    return weights;
  }

  function anyTeamStructureInBlast(game, structures, cx, cy, outerSquared) {
    for (const structure of structures) {
      {
        const sx = game.x(structure.tile);
        const sy = game.y(structure.tile);
        const dx = sx - cx;
        const dy = sy - cy;
        if (dx * dx + dy * dy < outerSquared) {
          return true;
        }
      }
    }
    return false;
  }

  function wouldNukeSuggestionBreakAlliance(game, context, cx, cy, outerSquared) {
    if (!context.allySmallIds?.size) {
      return false;
    }
    if (
      anyStructureWithinBlast(
        game,
        context.alliedStructures,
        cx,
        cy,
        outerSquared,
      )
    ) {
      return true;
    }
    return alliedTileCountsBreakAlliance(context, cx, cy, outerSquared);
  }

  function anyStructureWithinBlast(game, structures, cx, cy, outerSquared) {
    for (const structure of structures) {
      {
        const dx = game.x(structure.tile) - cx;
        const dy = game.y(structure.tile) - cy;
        if (dx * dx + dy * dy <= outerSquared) return true;
      }
    }
    return false;
  }

  function alliedTileCountsBreakAlliance(context, cx, cy, outerSquared) {
    const innerSquared = context.magnitude.inner * context.magnitude.inner;
    const counts = new Map();
    const bounds = getNukeBucketBounds(cx, cy, context.magnitude.outer);
    for (let by = bounds.minY; by <= bounds.maxY; by++) {
      for (let bx = bounds.minX; bx <= bounds.maxX; bx++) {
        const bucket = context.tileInfo.allyBuckets.get(`${bx}:${by}`);
        if (
          alliedBucketBreaksThreshold(bucket, counts, context, {
            cx,
            cy,
            innerSquared,
            outerSquared,
          })
        ) return true;
      }
    }

    return false;
  }

  function alliedBucketBreaksThreshold(bucket, counts, context, blast) {
    for (const point of bucket || []) {
      const dx = point.x - blast.cx;
      const dy = point.y - blast.cy;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > blast.outerSquared) continue;
      const weight = distanceSquared <= blast.innerSquared ? 1 : 0.5;
      const nextCount = (counts.get(point.ownerId) || 0) + weight;
      if (nextCount > context.allianceBreakThreshold) return true;
      counts.set(point.ownerId, nextCount);
    }
    return false;
  }

  function wouldNukeSuggestionAffectLauncher(game, context, cx, cy, outerSquared) {
    const myPlayerId = getPlayerSmallId(context.myPlayer);
    if (!Number.isFinite(myPlayerId)) {
      return true;
    }

    const minBucketX = Math.floor((cx - context.magnitude.outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    const maxBucketX = Math.floor((cx + context.magnitude.outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    const minBucketY = Math.floor((cy - context.magnitude.outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    const maxBucketY = Math.floor((cy + context.magnitude.outer) / NUKE_SUGGESTION_BUCKET_SIZE);

    for (let by = minBucketY; by <= maxBucketY; by++) {
      for (let bx = minBucketX; bx <= maxBucketX; bx++) {
        const bucket = context.tileInfo.selfBuckets.get(`${bx}:${by}`);
        if (!bucket) {
          continue;
        }

        for (const point of bucket) {
          const dx = point.x - cx;
          const dy = point.y - cy;
          if (dx * dx + dy * dy <= outerSquared) {
            return true;
          }
        }
      }
    }

    return false;
  }

  function wouldHydrogenNukeAffectOtherPlayers(context, cx, cy, outerSquared) {
    if (context.spec?.type !== "Hydrogen Bomb") {
      return false;
    }

    const bounds = getNukeBucketBounds(cx, cy, context.magnitude.outer);
    for (let by = bounds.minY; by <= bounds.maxY; by++) {
      for (let bx = bounds.minX; bx <= bounds.maxX; bx++) {
        const bucketKey = `${bx}:${by}`;
        const buckets = [
          context.tileInfo.otherPlayerBuckets?.get(bucketKey),
          context.tileInfo.allyBuckets?.get(bucketKey),
          context.tileInfo.selfBuckets?.get(bucketKey),
        ].filter(Boolean);

        if (anyNukeBucketPointWithin(buckets, cx, cy, outerSquared)) return true;
      }
    }

    return false;
  }

  function getNukeBucketBounds(cx, cy, outer) {
    return {
      minX: Math.floor((cx - outer) / NUKE_SUGGESTION_BUCKET_SIZE),
      maxX: Math.floor((cx + outer) / NUKE_SUGGESTION_BUCKET_SIZE),
      minY: Math.floor((cy - outer) / NUKE_SUGGESTION_BUCKET_SIZE),
      maxY: Math.floor((cy + outer) / NUKE_SUGGESTION_BUCKET_SIZE),
    };
  }

  function anyNukeBucketPointWithin(buckets, cx, cy, outerSquared) {
    for (const bucket of buckets) {
      for (const point of bucket) {
        const dx = point.x - cx;
        const dy = point.y - cy;
        if (dx * dx + dy * dy <= outerSquared) return true;
      }
    }
    return false;
  }

  function getOwnerAtTile(game, tile) {
    {
      return game.owner?.(tile) ?? null;
    }
  }

  function isNukeSuggestionTileAllowed(game, myPlayer, tile, magnitude, teamStructures) {
    if (game?.isSpawnImmunityActive?.()) {
      return false;
    }

    const owner = getOwnerAtTile(game, tile);
    if (owner?.isPlayer?.() && isTeamGame(game) && myPlayer?.isOnSameTeam?.(owner)) {
      return false;
    }

    if (teamStructures.length === 0) {
      return true;
    }

    const cx = game.x(tile);
    const cy = game.y(tile);
    return !anyTeamStructureInBlast(
      game,
      teamStructures,
      cx,
      cy,
      magnitude.outer * magnitude.outer,
    );
  }

  function scoreNukeSuggestionTile(game, context, tile) {
    if (!isNukeScoreTileAllowed(game, context, tile)) return null;
    const coordinates = getNukeTileCoordinates(game, tile);
    if (coordinates === null) return null;
    const { x: cx, y: cy } = coordinates;

    const innerSquared = context.magnitude.inner * context.magnitude.inner;
    const outerSquared = context.magnitude.outer * context.magnitude.outer;
    if (wouldNukeSuggestionAffectLauncher(game, context, cx, cy, outerSquared)) {
      return null;
    }
    if (wouldNukeSuggestionBreakAlliance(game, context, cx, cy, outerSquared)) {
      return null;
    }
    if (wouldHydrogenNukeAffectOtherPlayers(context, cx, cy, outerSquared)) {
      return null;
    }

    const tileHits = countNukeSuggestionTileHits(context, cx, cy, {
      innerSquared,
      outerSquared,
    });
    const impact = scoreNukeSuggestionImpact(game, {
      context,
      cx,
      cy,
      outerSquared,
      tileHits,
    });
    const samHits = collectNukeSuggestionSamHits(game, context, cx, cy, outerSquared);

    const totalScore = getNukeSuggestionTotalScore(context.scoreMode, {
      economicImpact: impact.economicImpact,
      destructionImpact: impact.destructionImpact,
      populationLoss: impact.populationLoss,
      cityPopulationHit: impact.cityPopulationHit,
    });
    if (totalScore <= 0) {
      return null;
    }

    return {
      id: context.spec.id,
      spec: context.spec,
      type: context.spec.type,
      tile,
      x: cx,
      y: cy,
      magnitude: context.magnitude,
      populationLoss: impact.populationLoss,
      cityPopulationHit: impact.cityPopulationHit,
      economicImpact: impact.economicImpact,
      expectedTilesHit: tileHits.expectedTilesHit,
      innerTiles: tileHits.innerTiles,
      outerTiles: tileHits.outerTiles,
      citiesHit: impact.citiesHit,
      economicStructuresHit: impact.economicStructuresHit,
      hitEconomicStructureWeights: impact.hitEconomicStructureWeights,
      hitCityPopulationWeights: impact.hitCityPopulationWeights,
      hitDestructionStructureWeights: impact.hitDestructionStructureWeights,
      hitSamKeys: samHits.hitSamKeys,
      samsHit: samHits.samsHit,
      totalScore,
    };
  }

  function isNukeScoreTileAllowed(game, context, tile) {
    return (
      tile != null &&
      isNukeSuggestionTileAllowed(
        game,
        context.myPlayer,
        tile,
        context.magnitude,
        context.teamStructures,
      )
    );
  }

  function getNukeTileCoordinates(game, tile) {
    {
      return { x: game.x(tile), y: game.y(tile) };
    }
  }

  function countNukeSuggestionTileHits(context, cx, cy, radii) {
    const result = { expectedTilesHit: 0, innerTiles: 0, outerTiles: 0 };
    const outer = context.magnitude.outer;
    const minBucketX = Math.floor((cx - outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    const maxBucketX = Math.floor((cx + outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    const minBucketY = Math.floor((cy - outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    const maxBucketY = Math.floor((cy + outer) / NUKE_SUGGESTION_BUCKET_SIZE);
    for (let by = minBucketY; by <= maxBucketY; by++) {
      for (let bx = minBucketX; bx <= maxBucketX; bx++) {
        countNukeBucketHits(
          context.tileInfo.buckets.get(`${bx}:${by}`),
          cx,
          cy,
          radii,
          result,
        );
      }
    }
    return result;
  }

  function countNukeBucketHits(bucket, cx, cy, radii, result) {
    for (const point of bucket || []) {
      const dx = point.x - cx;
      const dy = point.y - cy;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= radii.innerSquared) {
        result.expectedTilesHit += 1;
        result.innerTiles++;
      } else if (distanceSquared <= radii.outerSquared) {
        result.expectedTilesHit += 0.5;
        result.outerTiles++;
      }
    }
  }

  function scoreNukeSuggestionImpact(game, request) {
    const { context, cx, cy, outerSquared, tileHits } = request;
    const result = {
      populationLoss: 0,
      cityPopulationHit: 0,
      citiesHit: 0,
      economicImpact: 0,
      economicStructuresHit: 0,
      hitEconomicStructureWeights: new Map(),
      hitCityPopulationWeights: new Map(),
      hitDestructionStructureWeights: new Map(),
      destructionImpact: 0,
    };
    if (
      context.scoreMode === "economic" ||
      context.scoreMode === "destruction"
    ) {
      const economic = estimateNukeEconomicImpact(context, cx, cy, outerSquared);
      result.economicImpact = economic.economicImpact;
      result.economicStructuresHit = economic.economicStructuresHit;
      result.hitEconomicStructureWeights =
        economic.hitEconomicStructureWeights || new Map();
    }
    if (context.scoreMode !== "economic") {
      result.populationLoss = estimateNukePopulationLoss(
        game,
        context.spec.type,
        context.targetPlayer,
        tileHits.expectedTilesHit,
      );
      const city = estimateCityPopulationHit(game, context, cx, cy, outerSquared);
      result.cityPopulationHit = city.cityPopulationHit;
      result.citiesHit = city.citiesHit;
      result.hitCityPopulationWeights = city.hitCityPopulationWeights || new Map();
    }
    if (context.scoreMode === "destruction") {
      result.hitDestructionStructureWeights = combineDestructionStructureWeights(
        result.hitEconomicStructureWeights,
        result.hitCityPopulationWeights,
      );
      result.destructionImpact =
        Array.from(result.hitDestructionStructureWeights.values()).reduce(
          (sum, weight) => sum + weight,
          0,
        ) +
        result.populationLoss * 0.15;
    }
    return result;
  }

  function collectNukeSuggestionSamHits(game, context, cx, cy, outerSquared) {
    const hitSamKeys = [];
    for (const sam of context.targetSams || []) {
      {
        const samTile = getUnitTile(sam);
        if (samTile === null) continue;
        const dx = game.x(samTile) - cx;
        const dy = game.y(samTile) - cy;
        if (dx * dx + dy * dy >= outerSquared) continue;
        const samKey = getUnitKey(sam);
        if (samKey) hitSamKeys.push(samKey);
      }
    }
    return { samsHit: hitSamKeys.length, hitSamKeys };
  }

  function getNukeSuggestionTotalScore(scoreMode, impact) {
    if (scoreMode === "economic") return impact.economicImpact;
    if (scoreMode === "destruction") return impact.destructionImpact;
    return impact.populationLoss + impact.cityPopulationHit + impact.economicImpact;
  }

  function refineNukeSuggestionCandidate(game, context, candidate) {
    let best = candidate;
    const steps =
      context.spec.type === "Hydrogen Bomb"
        ? [40, 20, 10, 5, 2, 1]
        : [16, 8, 4, 2, 1];
    const directions = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];

    for (const step of steps) {
      for (const [dx, dy] of directions) {
        const tile = getTileFromXY(game, best.x + dx * step, best.y + dy * step);
        const next = scoreNukeSuggestionTile(game, context, tile);
        if (next && next.totalScore > best.totalScore + 0.25) {
          best = next;
        }
      }
    }

    return best;
  }

  function optimizeNukeSuggestionCandidateForBuildingImpact(game, context, candidate) {
    if (
      !candidate ||
      !context?.magnitude ||
      !Array.isArray(context.structures) ||
      context.scoreMode === "sam-clear" ||
      context.scoreMode === "sam-burn-building"
    ) {
      return candidate;
    }

    const impactTile = chooseMaxNukeBuildingImpactTile(
      game,
      candidate.tile,
      context.structures,
      context.magnitude.outer,
    );
    if (impactTile === candidate.tile) {
      return candidate;
    }

    // Re-score the coordinate that will actually be fired. This preserves all
    // existing ally, launcher, SAM, and territory safety checks for the moved
    // impact instead of only changing the visual/selection coordinate.
    const optimized = scoreNukeSuggestionTile(game, context, impactTile);
    if (!optimized) {
      return candidate;
    }

    // Building-count geometry is only a fast candidate filter. Keep the
    // refined target whenever the real scoring model says the shifted impact
    // is not better for this objective.
    const candidateScore = Number(candidate.totalScore);
    const optimizedScore = Number(optimized.totalScore);
    if (
      Number.isFinite(candidateScore) &&
      Number.isFinite(optimizedScore) &&
      optimizedScore <= candidateScore
    ) {
      return candidate;
    }

    return {
      ...optimized,
      buildingImpactAnchorTile: candidate.tile,
      buildingImpactOptimized: true,
    };
  }

  function findClosestReadySilo(game, targetTile, silos) {
    let bestSilo = null;
    let bestDistance = Infinity;

    for (const silo of silos) {
      const siloTile = getUnitTile(silo);
      if (siloTile === null) {
        continue;
      }

      let distance;
      {
        distance = game.manhattanDist(siloTile, targetTile);
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestSilo = silo;
      }
    }

    return bestSilo;
  }

  function getDefaultNukeSpeed(game) {
    {
      const speed = Number(game?.config?.().defaultNukeSpeed?.());
      return Number.isFinite(speed) && speed > 0 ? speed : 6;
    }
  }

  function getDefaultNukeTargetableRange(game) {
    {
      const range = Number(game?.config?.().defaultNukeTargetableRange?.());
      return Number.isFinite(range) && range > 0 ? range : 150;
    }
  }

  function getDefaultSamMissileSpeed(game) {
    {
      const speed = Number(game?.config?.().defaultSamMissileSpeed?.());
      return Number.isFinite(speed) && speed > 0 ? speed : 12;
    }
  }

  function getSamCooldown(game) {
    {
      const cooldown = Number(game?.config?.().SAMCooldown?.());
      return Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 120;
    }
  }

  function getMissileAvailabilityTick(game, unit, cooldown) {
    const level = getUnitLevel(unit);
    const queue = getMissileTimerQueue(unit);
    if (queue.length < level) {
      return 0;
    }

    const frontTime = Number(queue[0]);
    if (!Number.isFinite(frontTime)) {
      return Infinity;
    }

    const currentTick = toFiniteNumber(game?.ticks?.(), 0);
    const ticksLeft = cooldown - (currentTick - frontTime);
    return Math.max(1, Math.ceil(ticksLeft) + 1);
  }

  function getCurrentGameTick(game) {
    return Math.floor(toFiniteNumber(game?.ticks?.(), 0));
  }

  function getAutoNukeShotLaunchOffsetTicks(shotIndex) {
    return Math.max(
      0,
      Math.ceil(
        Math.max(0, Number(shotIndex) || 0) *
          AUTO_NUKE_SEQUENCE_DELAY_MS /
          AUTO_NUKE_GAME_TICK_MS,
      ),
    );
  }

  function getSamMissileSlotAvailableTicks(game, sam, cooldown) {
    const level = Math.max(1, getUnitLevel(sam));
    const queue = getMissileTimerQueue(sam)
      .map((tick) => Number(tick))
      .filter(Number.isFinite)
      .slice(0, level);
    const currentTick = getCurrentGameTick(game);
    const slots = [];

    for (let index = queue.length; index < level; index++) {
      slots.push(0);
    }

    for (const firedAtTick of queue) {
      const ticksLeft = cooldown - (currentTick - firedAtTick);
      slots.push(Math.max(1, Math.ceil(ticksLeft) + 1));
    }

    return slots.sort((a, b) => a - b);
  }

  function getSamStackMissileSlotAvailableTicks(game, sams) {
    const cooldown = getSamCooldown(game);
    const slots = [];
    for (const sam of sams || []) {
      slots.push(...getSamMissileSlotAvailableTicks(game, sam, cooldown));
    }
    return slots.sort((a, b) => a - b);
  }

  function getSamRange(game, sam, sams = null) {
    {
      const rangeLevel = sams ? getStackedSamLevel(sams, sam) : getUnitLevel(sam);
      const range = Number(game?.config?.().samRange?.(rangeLevel));
      return Number.isFinite(range) && range > 0 ? range : 70;
    }
  }

  function getMaxSamRange(game) {
    {
      const range = Number(game?.config?.().maxSamRange?.());
      return Number.isFinite(range) && range > 0 ? range : 150;
    }
  }

  function clampNukeSuggestionValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getCubicBezierPoint(p0, p1, p2, p3, t) {
    const inverse = 1 - t;
    const inverseSquared = inverse * inverse;
    const inverseCubed = inverseSquared * inverse;
    const squared = t * t;
    const cubed = squared * t;
    return {
      x:
        inverseCubed * p0.x +
        3 * inverseSquared * t * p1.x +
        3 * inverse * squared * p2.x +
        cubed * p3.x,
      y:
        inverseCubed * p0.y +
        3 * inverseSquared * t * p1.y +
        3 * inverse * squared * p2.y +
        cubed * p3.y,
    };
  }

  function createNukeSuggestionTrajectory(
    game,
    sourceTile,
    targetTile,
    rocketDirectionUp = true,
  ) {
    const speed = getDefaultNukeSpeed(game);
    const p0 = { x: game.x(sourceTile), y: game.y(sourceTile) };
    const p3 = { x: game.x(targetTile), y: game.y(targetTile) };
    const dx = p3.x - p0.x;
    const dy = p3.y - p0.y;
    const distance = Math.hypot(dx, dy);
    const maxHeight = Math.max(distance / 3, 50);
    const mapHeight = Number(game?.height?.()) || 1;
    const heightSign = rocketDirectionUp === false ? 1 : -1;
    const p1 = {
      x: p0.x + dx / 4,
      y: clampNukeSuggestionValue(
        p0.y + dy / 4 + heightSign * maxHeight,
        0,
        mapHeight - 1,
      ),
    };
    const p2 = {
      x: p0.x + (dx * 3) / 4,
      y: clampNukeSuggestionValue(
        p0.y + (dy * 3) / 4 + heightSign * maxHeight,
        0,
        mapHeight - 1,
      ),
    };

    const points = [p0];
    let t = 0;
    let previousPoint = p0;
    let cumulativeDistance = 0;
    while (t < 1) {
      t = Math.min(t + 0.002, 1);
      const currentPoint = getCubicBezierPoint(p0, p1, p2, p3, t);
      cumulativeDistance += Math.hypot(
        currentPoint.x - previousPoint.x,
        currentPoint.y - previousPoint.y,
      );
      if (cumulativeDistance >= speed) {
        points.push(currentPoint);
        cumulativeDistance = 0;
      }
      previousPoint = currentPoint;
    }

    const finalPoint = getCubicBezierPoint(p0, p1, p2, p3, 1);
    const lastPoint = points[points.length - 1];
    if (lastPoint.x !== finalPoint.x || lastPoint.y !== finalPoint.y) {
      points.push(finalPoint);
    }

    const trajectory = [];
    for (const point of points) {
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      {
        if (game.isValidCoord?.(x, y)) {
          trajectory.push(game.ref(x, y));
        }
      }
    }

    return trajectory.length > 0 ? trajectory : [sourceTile, targetTile];
  }

  function isNukeSuggestionTrajectoryTargetable(game, sourceTile, targetTile, tile, rangeSquared) {
    {
      return (
        game.euclideanDistSquared(tile, targetTile) < rangeSquared ||
        game.euclideanDistSquared(sourceTile, tile) < rangeSquared
      );
    }
  }

  function findSamInterceptionOpportunity(game, request) {
    const {
      sourceTile,
      targetTile,
      trajectory,
      sam,
      sams,
      rocketDirectionUp = true,
      nukeLaunchOffsetTicks = 0,
      samAvailableAtTick = 0,
    } = request;
    const samTile = getUnitTile(sam);
    if (samTile === null || !Array.isArray(trajectory) || trajectory.length === 0) {
      return null;
    }

    const targetableRange = getDefaultNukeTargetableRange(game);
    const targetableRangeSquared = targetableRange * targetableRange;
    const samMissileSpeed = getDefaultSamMissileSpeed(game);
    const samRange = getSamRange(game, sam, sams);
    const samRangeSquared = samRange * samRange;
    const detectionRange = getMaxSamRange(game) * 2;
    const detectionRangeSquared = detectionRange * detectionRange;
    const launchTick = Math.max(0, Math.floor(Number(nukeLaunchOffsetTicks) || 0));
    const availableTick = Math.max(0, Math.floor(Number(samAvailableAtTick) || 0));
    const earliestShootTick = Math.max(launchTick, availableTick);
    const scan = {
      sourceTile,
      targetTile,
      trajectory,
      sam,
      samTile,
      rocketDirectionUp,
      targetableRangeSquared,
      samMissileSpeed,
      samRangeSquared,
      detectionRangeSquared,
      launchTick,
      earliestShootTick,
    };
    let best = null;

    for (let index = 0; index < trajectory.length; index++) {
      const candidate = getSamTrajectoryInterception(game, scan, index);
      if (candidate && (!best || candidate.shootTick < best.shootTick)) {
        best = candidate;
      }
    }

    return best;
  }

  function getSamTrajectoryInterception(game, scan, index) {
    const tile = scan.trajectory[index];
    if (
      !isNukeSuggestionTrajectoryTargetable(
        game,
        scan.sourceTile,
        scan.targetTile,
        tile,
        scan.targetableRangeSquared,
      )
    ) {
      return null;
    }
    let distanceSquared;
    let samTickToReach;
    {
      distanceSquared = game.euclideanDistSquared(scan.samTile, tile);
      samTickToReach = Math.ceil(
        game.manhattanDist(scan.samTile, tile) / scan.samMissileSpeed,
      );
    }
    const shootTick = scan.launchTick + index - samTickToReach;
    if (distanceSquared > scan.samRangeSquared) return null;
    if (shootTick < scan.earliestShootTick) return null;
    if (shootTick + samTickToReach >= scan.launchTick + scan.trajectory.length) {
      return null;
    }
    if (!isSamDetectionRangeReached(game, scan, shootTick)) return null;
    return {
      sam: scan.sam,
      samTile: scan.samTile,
      rocketDirectionUp: scan.rocketDirectionUp,
      shootTick,
      interceptTile: tile,
      trajectoryIndex: index,
    };
  }

  function isSamDetectionRangeReached(game, scan, shootTick) {
    const nukeIndex = Math.max(
      0,
      Math.min(scan.trajectory.length - 1, shootTick - scan.launchTick),
    );
    {
      return (
        game.euclideanDistSquared(scan.samTile, scan.trajectory[nukeIndex]) <=
        scan.detectionRangeSquared
      );
    }
  }

  function getPendingSamAvailableAtTick(game, sam, pendingSamReadyTicks) {
    const currentTick = getCurrentGameTick(game);
    const readyAt = pendingSamReadyTicks?.get?.(getUnitKey(sam));
    const expectedReadyAt = Number.isFinite(Number(readyAt))
      ? Number(readyAt)
      : getPendingSamExpectedReadyTick(game, sam, currentTick);
    return Number.isFinite(expectedReadyAt)
      ? Math.max(0, Math.ceil(expectedReadyAt - currentTick))
      : Infinity;
  }

  // `pendingSams` carries SAMs that are still building. Their absolute expected
  // completion ticks are converted to a relative availability tick so a SAM only
  // counts when it can launch its interceptor before the missile reaches that path
  // point — completing before impact alone is not sufficient.
  function findInterceptingSams(game, request) {
    const {
      sourceTile,
      targetTile,
      sams,
      rocketDirectionUp = true,
      pendingSams = [],
      pendingSamReadyTicks = null,
    } = request;
    const activeSams = Array.isArray(sams) ? sams : [];
    const buildingSams = Array.isArray(pendingSams) ? pendingSams : [];
    if (activeSams.length === 0 && buildingSams.length === 0) {
      return [];
    }

    const trajectory = createNukeSuggestionTrajectory(
      game,
      sourceTile,
      targetTile,
      rocketDirectionUp,
    );
    const samCooldown = getSamCooldown(game);
    const interceptingSams = [];
    const seenSamKeys = new Set();
    const entries = [
      ...activeSams.map((sam) => ({ sam, pending: false })),
      ...buildingSams.map((sam) => ({ sam, pending: true })),
    ];

    for (const { sam, pending } of entries) {
      if (!markSamEntryUnseen(sam, seenSamKeys)) continue;

      const availableAt = pending
        ? getPendingSamAvailableAtTick(game, sam, pendingSamReadyTicks)
        : getMissileAvailabilityTick(game, sam, samCooldown);
      if (!Number.isFinite(availableAt)) {
        continue;
      }

      // A building SAM can only borrow the stacked range of other pending SAMs
      // that are also ready by the time it comes online. Active SAMs always count.
      const rangeSams = getAvailableSamRangeStack(game, {
        pending,
        availableAt,
        activeSams,
        buildingSams,
        pendingSamReadyTicks,
      });

      const opportunity = findSamInterceptionOpportunity(game, {
        sourceTile,
        targetTile,
        trajectory,
        sam,
        sams: rangeSams,
        rocketDirectionUp,
        samAvailableAtTick: availableAt,
      });
      if (opportunity) {
        interceptingSams.push(sam);
      }
    }

    return interceptingSams;
  }

  function markSamEntryUnseen(sam, seenSamKeys) {
    const samKey = getUnitKey(sam);
    if (samKey && seenSamKeys.has(samKey)) return false;
    if (samKey) seenSamKeys.add(samKey);
    return getUnitTile(sam) !== null;
  }

  function getAvailableSamRangeStack(game, request) {
    if (!request.pending) return request.activeSams;
    return [
      ...request.activeSams,
      ...request.buildingSams.filter(
        (candidate) =>
          getPendingSamAvailableAtTick(
            game,
            candidate,
            request.pendingSamReadyTicks,
          ) <= request.availableAt,
      ),
    ];
  }

  function getInterceptingSamsWeight(sams) {
    const stackWeights = new Map();

    for (const sam of sams || []) {
      const stackKey = getSamStackKey(sam) || getUnitKey(sam);
      if (!stackKey) {
        continue;
      }
      stackWeights.set(stackKey, (stackWeights.get(stackKey) || 0) + getUnitLevel(sam));
    }

    return Array.from(stackWeights.values())
      .reduce((sum, stackWeight) => sum + stackWeight, 0);
  }

  function chooseBestNukeRocketDirection(game, request) {
    const {
      sourceTile,
      targetTile,
      sams,
      pendingSams = [],
      pendingSamReadyTicks = null,
    } = request;
    const interceptionRequest = {
      sourceTile,
      targetTile,
      sams,
      pendingSams,
      pendingSamReadyTicks,
    };
    const upSams = findInterceptingSams(game, {
      ...interceptionRequest,
      rocketDirectionUp: true,
    });
    const downSams = findInterceptingSams(game, {
      ...interceptionRequest,
      rocketDirectionUp: false,
    });
    const upWeight = getInterceptingSamsWeight(upSams);
    const downWeight = getInterceptingSamsWeight(downSams);

    if (downWeight < upWeight) {
      return {
        rocketDirectionUp: false,
        interceptingSams: downSams,
        interceptingSamWeight: downWeight,
      };
    }

    return {
      rocketDirectionUp: true,
      interceptingSams: upSams,
      interceptingSamWeight: upWeight,
    };
  }

  function dedupeNukeSuggestionCandidates(candidates) {
    const byTile = new Map();
    for (const candidate of candidates) {
      const existing = byTile.get(candidate.tile);
      if (!existing || candidate.totalScore > existing.totalScore) {
        byTile.set(candidate.tile, candidate);
      }
    }
    return Array.from(byTile.values()).sort((a, b) => b.totalScore - a.totalScore);
  }

  function computeNukeCandidatesForType(game, baseContext, spec, limit) {
    const magnitude = getNukeSuggestionMagnitude(game, spec.type);
    const context = {
      ...baseContext,
      game,
      magnitude,
      spec,
      scoreMode: spec.scoreMode || "population",
    };
    const seeds = buildNukeSuggestionSeeds(game, {
      targetPlayer: context.targetPlayer,
      tileInfo: context.tileInfo,
      structures: context.structures,
      magnitude,
      spec,
    });

    const rawCandidates = [];
    for (const seed of seeds) {
      const candidate = scoreNukeSuggestionTile(game, context, seed);
      if (candidate) {
        rawCandidates.push(candidate);
      }
    }

    rawCandidates.sort((a, b) => b.totalScore - a.totalScore);
    const refinedCandidates = rawCandidates.slice(0, spec.maxRefineSeeds);
    for (const candidate of refinedCandidates) {
      rawCandidates.push(refineNukeSuggestionCandidate(game, context, candidate));
    }

    rawCandidates.sort((a, b) => b.totalScore - a.totalScore);
    const impactOptimizationCount = Math.min(
      rawCandidates.length,
      NUKE_SUGGESTION_MAX_BUILDING_IMPACT_OPTIMIZATIONS,
    );
    const optimizedCandidates = rawCandidates.map((candidate, index) =>
      index < impactOptimizationCount
        ? optimizeNukeSuggestionCandidateForBuildingImpact(game, context, candidate)
        : candidate,
    );
    const candidates = dedupeNukeSuggestionCandidates(optimizedCandidates).slice(
      0,
      limit || NUKE_SUGGESTION_MAX_FINAL_CANDIDATES,
    );
    const candidatesWithSource = [];

    for (const candidate of candidates) {
      const sourceSilo = findClosestReadySilo(game, candidate.tile, context.readySilos);
      if (!sourceSilo) {
        continue;
      }

      const sourceTile = getUnitTile(sourceSilo);
      if (sourceTile === null) {
        continue;
      }

      const directionPlan = chooseBestNukeRocketDirection(game, {
        sourceTile,
        targetTile: candidate.tile,
        sams: context.targetSams,
        pendingSams: context.pendingTargetSams,
        pendingSamReadyTicks: context.pendingSamReadyTicks,
      });
      const interceptingSam = directionPlan.interceptingSams[0] || null;
      const candidateWithSource = {
        ...candidate,
        sourceTile,
        rocketDirectionUp: directionPlan.rocketDirectionUp,
        interceptingSamTile: getUnitTile(interceptingSam),
        intercepted: Boolean(interceptingSam),
      };
      candidatesWithSource.push(candidateWithSource);
    }

    return candidatesWithSource;
  }

  function computeNukeSuggestionForType(game, baseContext, spec) {
    const candidates = computeNukeCandidatesForType(
      game,
      baseContext,
      spec,
      NUKE_SUGGESTION_MAX_FINAL_CANDIDATES,
    );
    return (
      candidates.find((candidate) => !candidate.intercepted) ||
      candidates[0] ||
      null
    );
  }

  function computeEconomicNukeSuggestion(game, baseContext) {
    const atomSpec = NUKE_SUGGESTION_TYPES.find((spec) => spec.id === "atom");
    const hydrogenSpec = NUKE_SUGGESTION_TYPES.find((spec) => spec.id === "hydrogen");

    function computeForSpec(spec) {
      if (!shouldComputeNukeSuggestionSpec(game, baseContext.myPlayer, spec)) {
        return null;
      }

      return computeNukeSuggestionForType(game, baseContext, {
        ...NUKE_ECONOMIC_SUGGESTION,
        id: `economic-${spec.id}`,
        label: spec.id === "hydrogen" ? "Eco hydrogen" : "Eco atom",
        type: spec.type,
        sourceLabel: spec.label,
        maxRawSeeds: Math.min(
          NUKE_ECONOMIC_SUGGESTION.maxRawSeeds,
          spec.maxRawSeeds,
        ),
        maxRefineSeeds: Math.min(
          NUKE_ECONOMIC_SUGGESTION.maxRefineSeeds,
          spec.maxRefineSeeds,
        ),
        scoreMode: "economic",
      });
    }

    const atomCandidate = computeForSpec(atomSpec);
    const hydrogenCandidate = computeForSpec(hydrogenSpec);
    const suggestions = [];
    if (atomCandidate) {
      suggestions.push(atomCandidate);
    }

    if (!hydrogenCandidate) {
      return suggestions;
    }
    if (!atomCandidate) {
      return [hydrogenCandidate];
    }

    const hydrogenAvoidsInterception =
      atomCandidate.intercepted && !hydrogenCandidate.intercepted;
    const hydrogenExtraScore = hydrogenCandidate.totalScore - atomCandidate.totalScore;
    const hydrogenIsMeaningfullyBetter =
      hydrogenExtraScore >= NUKE_ECONOMIC_HYDROGEN_MIN_GAIN &&
      hydrogenCandidate.totalScore >=
        atomCandidate.totalScore * NUKE_ECONOMIC_HYDROGEN_GAIN_RATIO;

    if (hydrogenAvoidsInterception || hydrogenIsMeaningfullyBetter) {
      suggestions.push(hydrogenCandidate);
    }

    return suggestions;
  }

  function buildNukeSuggestionBaseContext(game, targetPlayer) {
    const myPlayer = game?.myPlayer?.();
    if (!myPlayer?.isPlayer?.() || !isEnemyNukeSuggestionTarget(game, targetPlayer)) {
      return null;
    }

    const readySilos = collectReadyNukeSilos(myPlayer);
    if (readySilos.length === 0) {
      return null;
    }

    const allySmallIds = collectAlliedPlayerSmallIds(game, myPlayer);
    const tileInfo = collectTargetTileInfo(game, targetPlayer, myPlayer, allySmallIds);
    if (!tileInfo) {
      return null;
    }

    const pendingTargetSams = collectPendingHostileSams(game, myPlayer);
    const currentTick = getCurrentGameTick(game);
    const pendingSamReadyTicks = new Map();
    const activePendingKeys = new Set();
    for (const sam of pendingTargetSams) {
      const key = getUnitKey(sam);
      if (!key) continue;
      activePendingKeys.add(key);
      pendingSamReadyTicks.set(
        key,
        getPendingSamExpectedReadyTick(game, sam, currentTick),
      );
    }
    pruneFinishedPendingSamTracker(activePendingKeys);

    return {
      myPlayer,
      targetPlayer,
      tileInfo,
      readySilos,
      targetSams: collectRelevantSams(game, myPlayer, targetPlayer, tileInfo),
      pendingTargetSams,
      pendingSamReadyTicks,
      currentTick,
      structures: collectTargetStructures(targetPlayer),
      teamStructures: collectTeamStructures(game, myPlayer),
      allySmallIds,
      alliedStructures: collectAlliedStructures(game, allySmallIds),
      allianceBreakThreshold: getNukeAllianceBreakThreshold(game),
    };
  }

  function computeNukeSuggestions(game, targetPlayer, options = null) {
    const myPlayer = game?.myPlayer?.();
    const baseContext = buildNukeSuggestionBaseContext(game, targetPlayer);
    if (!baseContext) {
      return [];
    }

    const requestedMode = options?.mode || "all";
    const includePopulation =
      requestedMode === "all" || requestedMode === "population";
    const includeEconomic =
      requestedMode === "all" || requestedMode === "economic";
    const populationSuggestions = includePopulation
      ? NUKE_SUGGESTION_TYPES
        .filter((spec) => shouldComputeNukeSuggestionSpec(game, myPlayer, spec))
        .map((spec) => computeNukeSuggestionForType(game, baseContext, spec))
        .filter(Boolean)
      : [];
    const economicSuggestions = includeEconomic
      ? computeEconomicNukeSuggestion(game, baseContext)
      : [];

    return [...populationSuggestions, ...economicSuggestions];
  }

  function formatNukeSuggestionPopulation(value) {
    const rounded = Math.round(value);
    if (rounded >= 1_000_000) {
      return `${(rounded / 1_000_000).toFixed(1)}M`;
    }
    if (rounded >= 1000) {
      return `${(rounded / 1000).toFixed(1)}k`;
    }
    return String(rounded);
  }

  function formatNukeSuggestionLabel(result) {
    if (result.intercepted) {
      return `${result.spec.label}: SAM covered`;
    }

    if (result.spec.scoreMode === "economic") {
      const parts = [
        `${result.spec.label}: ${formatNukeSuggestionPopulation(result.totalScore)} econ`,
      ];
      if (result.economicStructuresHit > 0) {
        parts.push(`${result.economicStructuresHit} structures`);
      }
      return parts.join(", ");
    }

    const parts = [
      `${result.spec.label}: ${formatNukeSuggestionPopulation(result.totalScore)} pop`,
    ];
    if (result.citiesHit > 0) {
      parts.push(`${result.citiesHit} cities`);
    }
    return parts.join(", ");
  }

  function getNukeSuggestionSignature(game, targetPlayer) {
    const myPlayer = game?.myPlayer?.();
    const targetId = getPlayerSmallId(targetPlayer);
    const myId = getPlayerSmallId(myPlayer);
    const tickBucket = Math.floor(toFiniteNumber(game?.ticks?.(), 0) / 10);
    const siloState = collectReadyNukeSilos(myPlayer)
      .map((unit) => `${unit.id?.()}:${getUnitTile(unit)}:${getUnitLevel(unit)}:${getMissileTimerQueue(unit).join(",")}`)
      .join("|");
    const samState = collectTargetSams(targetPlayer)
      .map((unit) => `${unit.id?.()}:${getUnitTile(unit)}:${getUnitLevel(unit)}:${getMissileTimerQueue(unit).join(",")}`)
      .join("|");
    const tilesOwned = toFiniteNumber(targetPlayer?.numTilesOwned?.(), 0);

    return `${myId}:${targetId}:${tickBucket}:${tilesOwned}:${siloState}:${samState}`;
  }

  function renderNukeSuggestions(container, game, transform, results) {
    const activeIds = new Set();
    for (const result of results) {
      const markerId = renderNukeSuggestionResult(container, transform, result);
      if (markerId !== null) activeIds.add(markerId);
    }

    for (const [id, { zone, label }] of nukeSuggestionDomCache) {
      if (!activeIds.has(id)) {
        zone.remove();
        label.remove();
        nukeSuggestionDomCache.delete(id);
      }
    }
  }

  function renderNukeSuggestionResult(container, transform, result) {
    const screenPos = getNukeSuggestionScreenPosition(transform, result);
    if (screenPos === null) return null;
    const radius = Math.max(
      12,
      getNukeSuggestionScreenRadius(
        transform,
        { ...screenPos, worldX: result.x, worldY: result.y },
        result.magnitude.outer,
      ),
    );
    if (isNukeSuggestionOffscreen(screenPos, radius)) return null;
    let cached = nukeSuggestionDomCache.get(result.id);
    if (!cached) cached = createNukeSuggestionDomEntry(container, result);
    updateNukeSuggestionDomEntry(cached, result, screenPos, radius);
    return result.id;
  }

  function getNukeSuggestionScreenPosition(transform, result) {
    {
      nukeSuggestionWorldQueryArg.x = result.x;
      nukeSuggestionWorldQueryArg.y = result.y;
      const position = transform.worldToScreenCoordinates(nukeSuggestionWorldQueryArg);
      return Number.isFinite(position?.x) && Number.isFinite(position?.y)
        ? position
        : null;
    }
  }

  function isNukeSuggestionOffscreen(position, radius) {
    return (
      position.x < -radius - 220 ||
      position.y < -radius - 220 ||
      position.x > window.innerWidth + radius + 220 ||
      position.y > window.innerHeight + radius + 220
    );
  }

  function createNukeSuggestionDomEntry(container, result) {
    const zone = document.createElement("div");
    zone.className = "openfront-helper-nuke-suggestion-zone";
    const label = document.createElement("div");
    label.className = "openfront-helper-nuke-suggestion-label";
    let labelGap = "10px";
    if (result.id === "hydrogen") labelGap = "16px";
    if (result.id.startsWith("economic")) labelGap = "22px";
    for (const element of [zone, label]) {
      element.dataset.suggestionId = result.id;
      element.style.setProperty("--suggestion-color", result.spec.color);
      element.style.setProperty("--suggestion-fill", result.spec.fill);
      element.style.setProperty("--suggestion-glow", result.spec.glow);
      element.style.setProperty("--suggestion-label-gap", labelGap);
      container.appendChild(element);
    }
    const entry = {
      zone,
      label,
      lastX: Infinity,
      lastY: Infinity,
      lastRadius: Infinity,
      lastStatus: null,
    };
    nukeSuggestionDomCache.set(result.id, entry);
    return entry;
  }

  function updateNukeSuggestionDomEntry(entry, result, position, radius) {
    const { zone, label } = entry;
    const status = result.intercepted ? "blocked" : "active";
    if (entry.lastStatus !== status) {
      entry.lastStatus = status;
      zone.dataset.suggestionStatus = status;
      label.dataset.suggestionStatus = status;
    }
    if (hasNukeSuggestionGeometryChanged(entry, position, radius)) {
      entry.lastX = position.x;
      entry.lastY = position.y;
      entry.lastRadius = radius;
      for (const element of [zone, label]) {
        element.style.setProperty("--suggestion-x", `${position.x}px`);
        element.style.setProperty("--suggestion-y", `${position.y}px`);
        element.style.setProperty("--suggestion-radius", `${radius}px`);
        element.style.setProperty("--suggestion-diameter", `${radius * 2}px`);
      }
    }
    const text = formatNukeSuggestionLabel(result);
    if (label.textContent !== text) label.textContent = text;
  }

  function hasNukeSuggestionGeometryChanged(entry, position, radius) {
    return (
      Math.abs(position.x - entry.lastX) > 0.5 ||
      Math.abs(position.y - entry.lastY) > 0.5 ||
      Math.abs(radius - entry.lastRadius) > 0.5
    );
  }

  function clearNukeSuggestionState(container = null) {
    const hasState =
      runtimeState.currentNukeSuggestionResults.length > 0 ||
      runtimeState.lastNukeSuggestionSignature !== "" ||
      runtimeState.lastNukeSuggestionComputedAt !== 0 ||
      runtimeState.lastNukeSuggestionSignatureCheckAt !== 0 ||
      nukeSuggestionTileInfoCache !== null ||
      runtimeState.nukeSuggestionTileComputeKey !== null ||
      nukeSuggestionDomCache.size > 0;
    if (!hasState) return;
    runtimeState.currentNukeSuggestionResults = [];
    runtimeState.lastNukeSuggestionSignature = "";
    runtimeState.lastNukeSuggestionComputedAt = 0;
    runtimeState.lastNukeSuggestionSignatureCheckAt = 0;
    nukeSuggestionTileInfoCache = null;
    runtimeState.nukeSuggestionTileComputeKey = null;
    nukeSuggestionDomCache.clear();
    if (container?.childElementCount) container.replaceChildren();
  }

  function isAutoNukeRadialTarget(params) {
    if (!hasValidAutoNukeRadialContext(params)) return false;
    if (getPlayerSmallId(params.myPlayer) === getPlayerSmallId(params.selected)) {
      return false;
    }
    if (isEnemyNukeSuggestionTarget(params.game, params.selected)) {
      return true;
    }
    return autoNukeIncludeAllies;
  }

  function hasValidAutoNukeRadialContext(params) {
    if (!runtimeState.autoNukeEnabled || !params?.game) return false;
    if (params.myPlayer?.isPlayer?.() !== true) return false;
    return (
      params.selected?.isPlayer?.() === true && params.selected.isAlive?.() === true
    );
  }

  function hasAutoNukeBuildTypeAvailable(game, player) {
    return NUKE_SUGGESTION_TYPES.some((spec) =>
      shouldComputeNukeSuggestionSpec(game, player, spec),
    );
  }

  function isAutoNukeRadialItemDisabled(params) {
    if (!isAutoNukeRadialTarget(params)) {
      return true;
    }

    if (!hasAutoNukeBuildTypeAvailable(params.game, params.myPlayer)) {
      return true;
    }

    return collectReadyNukeSilos(params.myPlayer).length === 0;
  }

  function selectAutoNukeCandidate(game, targetPlayer, mode) {
    const candidates = computeNukeSuggestions(game, targetPlayer, { mode }).filter(
      (candidate) => !candidate.intercepted,
    );
    const matchingCandidates = candidates.filter((candidate) => {
      const isEconomic = candidate.spec?.scoreMode === "economic";
      return mode === "economic" ? isEconomic : !isEconomic;
    });

    matchingCandidates.sort((a, b) => b.totalScore - a.totalScore);
    return matchingCandidates[0] || null;
  }

  function getReadyNukeSiloSlotCount(player) {
    return collectActiveNukeSilos(player)
      .reduce((sum, silo) => {
        const availableSlots = getUnitLevel(silo) - getMissileTimerQueue(silo).length;
        return sum + Math.max(0, availableSlots);
      }, 0);
  }

  function getTotalNukeSiloSlotCount(player) {
    return collectActiveNukeSilos(player)
      .reduce((sum, silo) => sum + Math.max(0, getUnitLevel(silo)), 0);
  }

  function getAutoNukeMinimumAvailableCost(game, player) {
    const costs = NUKE_SUGGESTION_TYPES
      .filter(
        (spec) =>
          spec.type !== "Hydrogen Bomb" &&
          isNukeSuggestionTypeEnabled(game, spec.type),
      )
      .map((spec) => getNukeSuggestionUnitCost(game, player, spec.type))
      .filter((cost) => Number.isFinite(cost) && cost > 0);
    return costs.length > 0 ? Math.min(...costs) : Infinity;
  }

  function getAutoNukeCandidateSpecs(game, player, mode) {
    const baseSpecs = NUKE_SUGGESTION_TYPES.filter(
      (spec) =>
        spec.type !== "Hydrogen Bomb" &&
        isNukeSuggestionTypeEnabled(game, spec.type),
    );

    if (mode === "population") {
      return baseSpecs;
    }

    if (mode === "destruction" || mode === "sams") {
      return baseSpecs.map((spec) => ({
        ...spec,
        id: `${mode}-${spec.id}`,
        label: mode === "sams" ? `SAM ${spec.label}` : `Destroy ${spec.label}`,
        scoreMode: "destruction",
      }));
    }

    return baseSpecs.map((spec) => ({
      ...NUKE_ECONOMIC_SUGGESTION,
      id: `economic-${spec.id}`,
      label: spec.id === "hydrogen" ? "Eco hydrogen" : "Eco atom",
      type: spec.type,
      sourceLabel: spec.label,
      maxRawSeeds: Math.min(
        NUKE_ECONOMIC_SUGGESTION.maxRawSeeds,
        spec.maxRawSeeds,
      ),
      maxRefineSeeds: Math.min(
        NUKE_ECONOMIC_SUGGESTION.maxRefineSeeds,
        spec.maxRefineSeeds,
      ),
      scoreMode: "economic",
    }));
  }

  function scoreAutoNukeSamClearCandidate(game, baseContext, spec, sam, unlockScore) {
    const samTile = getUnitTile(sam);
    if (samTile === null) {
      return null;
    }

    const magnitude = getNukeSuggestionMagnitude(game, spec.type);
    if (
      !isNukeSuggestionTileAllowed(
        game,
        baseContext.myPlayer,
        samTile,
        magnitude,
        baseContext.teamStructures,
      )
    ) {
      return null;
    }

    let cx;
    let cy;
    {
      cx = game.x(samTile);
      cy = game.y(samTile);
    }

    const outerSquared = magnitude.outer * magnitude.outer;
    const context = {
      ...baseContext,
      game,
      magnitude,
      spec,
      scoreMode: "sam-clear",
    };
    if (wouldNukeSuggestionAffectLauncher(game, context, cx, cy, outerSquared)) {
      return null;
    }
    if (wouldNukeSuggestionBreakAlliance(game, context, cx, cy, outerSquared)) {
      return null;
    }
    if (wouldHydrogenNukeAffectOtherPlayers(context, cx, cy, outerSquared)) {
      return null;
    }

    const combinedSams = [
      ...(baseContext.targetSams || []),
      ...(baseContext.pendingTargetSams || []),
    ];
    const hitSamKeys = collectSamsWithinBlast(
      game,
      combinedSams,
      cx,
      cy,
      outerSquared,
    );

    const samKey = getUnitKey(sam);
    if (!samKey || !hitSamKeys.includes(samKey)) {
      return null;
    }
    const samStackKey = getSamStackKey(sam) || samKey;
    const samClearStackSamKeys = Array.from(new Set([
      ...getSamStackUnitKeys(baseContext.targetSams, samStackKey),
      ...getSamStackUnitKeys(baseContext.pendingTargetSams, samStackKey),
    ]));
    // Compute total level of units in this SAM stack (live + pending). Used to
    // scale insurance overshoot so single weak SAMs don't waste nukes while
    // thick high-level stacks get proper coverage.
    const samClearStackLevelSum = getSamClearStackLevelSum(
      baseContext.targetSams,
      samClearStackSamKeys,
    );

    const sourceSilo = findClosestReadySilo(game, samTile, baseContext.readySilos);
    const sourceTile = getUnitTile(sourceSilo);
    if (sourceTile === null) {
      return null;
    }

    const directionPlan = chooseBestNukeRocketDirection(game, {
      sourceTile,
      targetTile: samTile,
      sams: baseContext.targetSams,
      pendingSams: baseContext.pendingTargetSams,
      pendingSamReadyTicks: baseContext.pendingSamReadyTicks,
    });
    const samClearSpec = {
      ...spec,
      id: `sam-clear-${spec.id}`,
      label: "Clear SAM",
      scoreMode: "sam-clear",
    };
    const interceptingSam = directionPlan.interceptingSams[0] || null;

    const samClearCityInfo = estimateCityPopulationHit(game, context, cx, cy, outerSquared);
    const samClearEconomicInfo = estimateNukeEconomicImpact(context, cx, cy, outerSquared);
    const samClearDestructionWeights = combineDestructionStructureWeights(
      samClearEconomicInfo.hitEconomicStructureWeights,
      samClearCityInfo.hitCityPopulationWeights,
    );

    return {
      id: `sam-clear-${samKey}-${spec.id}`,
      spec: samClearSpec,
      type: spec.type,
      tile: samTile,
      x: cx,
      y: cy,
      magnitude,
      populationLoss: 0,
      cityPopulationHit: 0,
      economicImpact: 0,
      expectedTilesHit: 0,
      innerTiles: 0,
      outerTiles: 0,
      citiesHit: samClearCityInfo.citiesHit,
      economicStructuresHit: samClearEconomicInfo.economicStructuresHit,
      hitEconomicStructureWeights: samClearEconomicInfo.hitEconomicStructureWeights,
      hitCityPopulationWeights: samClearCityInfo.hitCityPopulationWeights,
      hitDestructionStructureWeights: samClearDestructionWeights,
      hitSamKeys,
      samsHit: hitSamKeys.length,
      totalScore: Math.max(1, unlockScore * 0.28),
      sourceTile,
      rocketDirectionUp: directionPlan.rocketDirectionUp,
      interceptingSamTile: getUnitTile(interceptingSam),
      intercepted: Boolean(interceptingSam),
      isSamClear: true,
      samClearStackKey: samStackKey,
      samClearStackSamKeys:
        samClearStackSamKeys.length > 0 ? samClearStackSamKeys : [samKey],
      samClearStackLevelSum,
      samClearOwnedByTarget: isSamOwnedByNukeTarget(baseContext, sam),
    };
  }

  function collectSamsWithinBlast(game, sams, cx, cy, outerSquared) {
    const keys = new Set();
    for (const sam of sams) {
      const tile = getUnitTile(sam);
      if (tile === null) continue;
      {
        const dx = game.x(tile) - cx;
        const dy = game.y(tile) - cy;
        const key = getUnitKey(sam);
        if (dx * dx + dy * dy <= outerSquared && key) keys.add(key);
      }
    }
    return Array.from(keys);
  }

  function getSamClearStackLevelSum(targetSams, stackKeys) {
    let levelSum = 0;
    for (const sam of targetSams || []) {
      if (stackKeys.includes(getUnitKey(sam))) {
        levelSum += Math.max(1, getUnitLevel(sam));
      }
    }
    return levelSum || stackKeys.length || 1;
  }




  function getAutoNukeSamBurnSpec(game, player) {
    const atomSpec = NUKE_SUGGESTION_TYPES.find((spec) => spec.id === "atom");
    if (atomSpec && isNukeSuggestionTypeEnabled(game, atomSpec.type)) {
      return atomSpec;
    }

    return NUKE_SUGGESTION_TYPES.find(
      (spec) =>
        spec.type !== "Hydrogen Bomb" &&
        isNukeSuggestionTypeEnabled(game, spec.type),
    ) || null;
  }

  function recordAutoNukeSamScore(scoreState, sam, score, keepMaximum = false) {
    const samKey = getUnitKey(sam);
    if (!samKey) return null;
    scoreState.samsByKey.set(samKey, sam);
    const previous = scoreState.samUnlockScores.get(samKey) || 0;
    scoreState.samUnlockScores.set(
      samKey,
      keepMaximum ? Math.max(previous, score) : previous + score,
    );
    return samKey;
  }

  function collectAutoNukeInterceptScores(game, baseContext, candidates, scoreState) {
    for (const candidate of candidates) {
      if (candidate.sourceTile == null) continue;
      const sams = findInterceptingSams(game, {
        sourceTile: candidate.sourceTile,
        targetTile: candidate.tile,
        sams: baseContext.targetSams,
        rocketDirectionUp: candidate.rocketDirectionUp,
        pendingSams: baseContext.pendingTargetSams,
        pendingSamReadyTicks: baseContext.pendingSamReadyTicks,
      });
      for (const sam of sams) {
        recordAutoNukeSamScore(scoreState, sam, candidate.totalScore);
      }
    }
  }

  function collectAutoNukeTargetSamScores(game, baseContext, scoreState) {
    const seenStacks = new Set();
    for (const sam of baseContext.targetSams || []) {
      if (!isSamOwnedByNukeTarget(baseContext, sam)) continue;
      const stackKey = getSamStackKey(sam) || getUnitKey(sam);
      if (!stackKey || seenStacks.has(stackKey)) continue;
      seenStacks.add(stackKey);
      const stackSams = (baseContext.targetSams || []).filter(
        (stackSam) => getSamStackKey(stackSam) === stackKey,
      );
      const capacity = getSamStackInterceptionCapacity(
        game,
        stackSams.length > 0 ? stackSams : [sam],
      );
      recordAutoNukeSamScore(
        scoreState,
        sam,
        AUTO_NUKE_DESTRUCTION_SAM_BONUS * Math.max(1, capacity),
        true,
      );
    }
    for (const sam of baseContext.pendingTargetSams || []) {
      if (!isSamOwnedByNukeTarget(baseContext, sam)) continue;
      const stackKey = getSamStackKey(sam) || getUnitKey(sam);
      if (!stackKey || seenStacks.has(stackKey)) continue;
      seenStacks.add(stackKey);
      recordAutoNukeSamScore(
        scoreState,
        sam,
        AUTO_NUKE_DESTRUCTION_SAM_BONUS,
        true,
      );
    }
  }

  function getTypicalAutoNukeFlightTicks(game, candidates) {
    const regularCandidates = candidates.filter((candidate) => !candidate.isSamClear);
    const sample = regularCandidates.slice(0, 5);
    if (sample.length === 0) return 180;
    const total = sample.reduce(
      (sum, candidate) => sum + getAutoNukeCandidateFlightTicks(game, candidate),
      0,
    );
    return Math.round(total / sample.length);
  }

  function recordBlockingAutoNukeSam(request) {
    const { game, baseContext, scoreState, sam, stackSams, pendingSams } = request;
    const effectiveCapacity = estimateSamStackEffectiveCapacity(
      game,
      stackSams,
      request.typicalFlightTicks,
      {
        pendingSamReadyTicks: baseContext.pendingSamReadyTicks,
        currentTick: baseContext.currentTick,
        pendingSams,
        includeUpgradeBuffer: request.includeUpgradeBuffer,
      },
    );
    if (effectiveCapacity < AUTO_NUKE_BLOCKING_STACK_BASE_CAPACITY) return null;
    const bonus = AUTO_NUKE_DESTRUCTION_SAM_BONUS *
      Math.max(1, effectiveCapacity) *
      AUTO_NUKE_BLOCKING_STACK_SCORE_FRACTION;
    return recordAutoNukeSamScore(scoreState, sam, bonus, true);
  }

  function collectBlockingAutoNukeSamKeys(game, baseContext, candidates, scoreState) {
    const blockingKeys = new Set();
    const seenStacks = new Set();
    const typicalFlightTicks = getTypicalAutoNukeFlightTicks(game, candidates);
    for (const sam of baseContext.targetSams || []) {
      const stackKey = getSamStackKey(sam) || getUnitKey(sam);
      if (!stackKey || seenStacks.has(stackKey)) continue;
      seenStacks.add(stackKey);
      const activeSams = (baseContext.targetSams || []).filter(
        (stackSam) => getSamStackKey(stackSam) === stackKey,
      );
      const samKey = recordBlockingAutoNukeSam({
        game,
        baseContext,
        scoreState,
        sam,
        stackSams: activeSams.length > 0 ? activeSams : [sam],
        pendingSams: getAutoNukePendingStackSams(baseContext, stackKey),
        typicalFlightTicks,
        includeUpgradeBuffer: true,
      });
      if (samKey) blockingKeys.add(samKey);
    }
    for (const sam of baseContext.pendingTargetSams || []) {
      const stackKey = getSamStackKey(sam) || getUnitKey(sam);
      if (!stackKey || seenStacks.has(stackKey)) continue;
      seenStacks.add(stackKey);
      const samKey = recordBlockingAutoNukeSam({
        game,
        baseContext,
        scoreState,
        sam,
        stackSams: [],
        pendingSams: getAutoNukePendingStackSams(baseContext, stackKey),
        typicalFlightTicks,
        includeUpgradeBuffer: false,
      });
      if (samKey) blockingKeys.add(samKey);
    }
    return blockingKeys;
  }

  function appendAutoNukeSamClearCandidates(request) {
    const {
      game,
      baseContext,
      burnSpec,
      candidates,
      scoreState,
      blockingSamKeys,
    } = request;
    for (const [samKey, unlockScore] of scoreState.samUnlockScores) {
      const sam = scoreState.samsByKey.get(samKey);
      if (!isSamOwnedByNukeTarget(baseContext, sam)) continue;
      const candidate = scoreAutoNukeSamClearCandidate(
        game,
        baseContext,
        burnSpec,
        sam,
        unlockScore,
      );
      if (!candidate) continue;
      candidate.isBlockingStack = blockingSamKeys.has(samKey);
      candidates.push(candidate);
    }
  }

  function addAutoNukeSamClearCandidates(game, baseContext, specs, candidates, mode) {
    if (specs.length === 0) return;
    const burnSpec = getAutoNukeSamBurnSpec(game, baseContext.myPlayer);
    if (!burnSpec) return;

    const scoreState = {
      samUnlockScores: new Map(),
      samsByKey: new Map(),
    };
    collectAutoNukeInterceptScores(game, baseContext, candidates, scoreState);
    if (mode === "destruction" || mode === "sams") {
      collectAutoNukeTargetSamScores(game, baseContext, scoreState);
    }
    const blockingSamKeys = collectBlockingAutoNukeSamKeys(
      game,
      baseContext,
      candidates,
      scoreState,
    );
    appendAutoNukeSamClearCandidates({
      game,
      baseContext,
      burnSpec,
      candidates,
      scoreState,
      blockingSamKeys,
    });
  }
  function computeAutoNukeCandidatePool(game, targetPlayer, mode, options = null) {
    const baseContext = buildNukeSuggestionBaseContext(game, targetPlayer);
    if (!baseContext) {
      return {
        baseContext: null,
        candidates: [],
      };
    }

    const autoSams = collectAllHostileSams(game, baseContext.myPlayer);
    const pendingSams = baseContext.pendingTargetSams || [];
    const currentTick = baseContext.currentTick ?? getCurrentGameTick(game);
    const pendingSamReadyTicks = baseContext.pendingSamReadyTicks || new Map();
    const activePendingKeys = new Set();
    for (const sam of pendingSams) {
      const key = getUnitKey(sam);
      if (!key) continue;
      activePendingKeys.add(key);
    }
    // Drop tracker entries for SAMs no longer under construction (finished or destroyed).
    pruneFinishedPendingSamTracker(activePendingKeys);

    const autoContext = {
      ...baseContext,
      targetSams: autoSams.length > 0 ? autoSams : baseContext.targetSams,
      pendingTargetSams: pendingSams,
      pendingSamReadyTicks,
      currentTick,
      readySilos: options?.includeCoolingSilos
        ? collectActiveNukeSilos(baseContext.myPlayer)
        : baseContext.readySilos,
    };
    const candidates = [];
    const specs = getAutoNukeCandidateSpecs(game, autoContext.myPlayer, mode);
    for (const spec of specs) {
      candidates.push(
        ...computeNukeCandidatesForType(
          game,
          autoContext,
          spec,
          AUTO_NUKE_MAX_CANDIDATES_PER_SPEC,
        ),
      );
    }
    addAutoNukeSamClearCandidates(game, autoContext, specs, candidates, mode);

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    return {
      baseContext: autoContext,
      candidates,
    };
  }

  function getSamInterceptionCapacity(game, sam) {
    const readySlots = Math.max(0, getUnitLevel(sam) - getMissileTimerQueue(sam).length);
    if (readySlots > 0) {
      return readySlots;
    }

    const availableAt = getMissileAvailabilityTick(game, sam, getSamCooldown(game));
    return Number.isFinite(availableAt) ? 1 : 0;
  }

  function getSamStackInterceptionCapacity(_game, sams) {
    return (sams || []).reduce((sum, sam) => sum + getUnitLevel(sam), 0);
  }

  // Returns the total interception capacity of a SAM stack accounting for cooldown recharge
  // during the nuke flight: a SAM slot that fires early can reload and fire again before landing.
  //
  // Options:
  //   pendingSams                 — array of under-construction SAMs at this stack.
  //   pendingSamReadyTicks        — Map<samKey, expectedReadyTick>.
  //   currentTick                 — current game tick (for pending readiness comparison).
  //   includeUpgradeBuffer        — add AUTO_NUKE_SAM_UPGRADE_BUFFER to account for a
  //                                 possible instant-upgrade (stacking) during flight.
  function estimateSamStackEffectiveCapacity(
    game,
    sams,
    candidateFlightTicks,
    options = null,
  ) {
    let base = getSamStackInterceptionCapacity(game, sams);

    // Include pending SAMs whose construction will complete before our nukes land.
    base += getPendingSamCapacityBeforeArrival(
      game,
      candidateFlightTicks,
      options,
    );

    // Instant-upgrade safety buffer: only meaningful if the stack already has a
    // live SAM the enemy can upgrade.
    if (options?.includeUpgradeBuffer && (sams || []).length > 0) {
      base += AUTO_NUKE_SAM_UPGRADE_BUFFER;
    }

    if (!base || !candidateFlightTicks) return base || 0;
    const cooldown = getSamCooldown(game);
    if (!cooldown) return base;
    return base * Math.max(1, Math.ceil(candidateFlightTicks / cooldown));
  }

  function getPendingSamCapacityBeforeArrival(game, flightTicks, options) {
    const pendingSams = options?.pendingSams || [];
    if (pendingSams.length === 0) return 0;
    const currentTick = Number.isFinite(options?.currentTick)
      ? options.currentTick
      : getCurrentGameTick(game);
    const arrivalTick = currentTick + Math.max(0, Number(flightTicks) || 0);
    let capacity = 0;
    for (const sam of pendingSams) {
      const readyAt = options?.pendingSamReadyTicks?.get?.(getUnitKey(sam));
      if (Number.isFinite(readyAt) && readyAt <= arrivalTick) {
        capacity += getUnitLevel(sam);
      }
    }
    return capacity;
  }

  // Returns pending SAMs at a given stack key (from baseContext.pendingTargetSams).
  function getAutoNukePendingStackSams(baseContext, stackKey) {
    if (!stackKey) return [];
    return (baseContext?.pendingTargetSams || []).filter(
      (sam) => getSamStackKey(sam) === stackKey,
    );
  }

  function getAutoNukeSamStackSams(baseContext, stackKey, fallbackSams = null) {
    const stackSams = (baseContext.targetSams || []).filter(
      (sam) => getSamStackKey(sam) === stackKey,
    );
    return stackSams.length > 0 ? stackSams : fallbackSams || [];
  }

  function getAutoNukeSamStackSlots(game, baseContext, state, stackKey, fallbackSams = null) {
    const existing = state.samSlotAvailableTicks?.get?.(stackKey);
    if (Array.isArray(existing)) {
      return [...existing].sort((a, b) => a - b);
    }

    return getSamStackMissileSlotAvailableTicks(
      game,
      getAutoNukeSamStackSams(baseContext, stackKey, fallbackSams),
    );
  }

  function findAutoNukeSamStackInterceptionSlot(game, request) {
    const {
      stack,
      slotAvailableTicks,
      candidate,
      shotIndexOffset,
      state = null,
    } = request;
    if (!stack?.sams?.length || candidate?.sourceTile == null || candidate?.tile == null) {
      return null;
    }

    const trajectory = createNukeSuggestionTrajectory(
      game,
      candidate.sourceTile,
      candidate.tile,
      candidate.rocketDirectionUp,
    );
    const launchOffsetTicks = getAutoNukeShotLaunchOffsetTicks(shotIndexOffset);
    let best = null;

    for (let slotIndex = 0; slotIndex < slotAvailableTicks.length; slotIndex++) {
      const slotAvailableAt = Math.max(
        0,
        Math.floor(Number(slotAvailableTicks[slotIndex]) || 0),
      );
      const opportunity = findAutoNukeSlotOpportunity(game, {
        stack,
        candidate,
        trajectory,
        launchOffsetTicks,
        state,
        slotIndex,
        slotAvailableAt,
      });
      if (opportunity && (!best || opportunity.shootTick < best.shootTick)) {
        best = opportunity;
      }
    }

    return best;
  }

  function findAutoNukeSlotOpportunity(game, request) {
    let best = null;
    for (const sam of request.stack.sams) {
      const opportunity = findSamInterceptionOpportunity(game, {
        sourceTile: request.candidate.sourceTile,
        targetTile: request.candidate.tile,
        trajectory: request.trajectory,
        sam,
        sams: request.stack.sams,
        rocketDirectionUp: request.candidate.rocketDirectionUp,
        nukeLaunchOffsetTicks: request.launchOffsetTicks,
        samAvailableAtTick: request.slotAvailableAt,
      });
      if (!opportunity) continue;
      if (
        isAutoNukeSamDestroyedBeforeTick(
          request.state,
          getUnitKey(sam),
          opportunity.shootTick,
        )
      ) continue;
      if (!best || opportunity.shootTick < best.shootTick) {
        best = { ...opportunity, slotIndex: request.slotIndex };
      }
    }
    return best;
  }

  function cloneAutoNukeSamSlotUpdates(updates) {
    const cloned = new Map();
    for (const [stackKey, slots] of updates || []) {
      cloned.set(stackKey, [...slots]);
    }
    return cloned;
  }

  function cloneAutoNukeTickMap(map) {
    const cloned = new Map();
    for (const [key, tick] of map || []) {
      const numericTick = Number(tick);
      if (key && Number.isFinite(numericTick)) {
        cloned.set(key, numericTick);
      }
    }
    return cloned;
  }

  function getAutoNukeCandidateFlightTicks(game, candidate) {
    if (candidate?.sourceTile == null || candidate?.tile == null) {
      return 0;
    }

    {
      return createNukeSuggestionTrajectory(
        game,
        candidate.sourceTile,
        candidate.tile,
        candidate.rocketDirectionUp,
      ).length;
    }
  }

  function getAutoNukeCandidateLandingTick(game, candidate, shotIndex) {
    return getAutoNukeShotLaunchOffsetTicks(shotIndex) +
      getAutoNukeCandidateFlightTicks(game, candidate);
  }

  function isAutoNukeSamDestroyedBeforeTick(state, samKey, tick) {
    if (!samKey) {
      return false;
    }

    const destroyedAt = Number(state?.samDestroyedAtTicks?.get?.(samKey));
    return Number.isFinite(destroyedAt) && destroyedAt <= tick;
  }

  function applyAutoNukeInterceptionPlan(state, plan) {
    for (const shotSam of plan.shotSamKeys || []) {
      state.usedSamShots.set(
        shotSam.key,
        (state.usedSamShots.get(shotSam.key) || 0) + 1,
      );
    }

    if (!state.samSlotAvailableTicks) {
      state.samSlotAvailableTicks = new Map();
    }
    for (const [stackKey, slots] of plan.samSlotUpdates || []) {
      state.samSlotAvailableTicks.set(stackKey, [...slots].sort((a, b) => a - b));
    }
  }

  function groupInterceptingSamsByStack(interceptingSams, baseContext) {
    const stacks = new Map();

    for (const sam of interceptingSams) {
      const stackKey = getSamStackKey(sam) || getUnitKey(sam);
      if (!stackKey) {
        continue;
      }

      let stack = stacks.get(stackKey);
      if (!stack) {
        stack = {
          key: stackKey,
          sams: [],
          ownedByTarget: isSamOwnedByNukeTarget(baseContext, sam),
        };
        stacks.set(stackKey, stack);
      }
      stack.sams.push(sam);
    }

    return Array.from(stacks.values()).sort((a, b) => {
      if (a.ownedByTarget === b.ownedByTarget) {
        return 0;
      }
      return a.ownedByTarget ? 1 : -1;
    });
  }

  function getFailedAutoNukeInterceptionPlan() {
    return {
      shotsNeededBeforeLanding: Infinity,
      shotSamKeys: [],
      samSlotUpdates: new Map(),
      burnCost: Infinity,
    };
  }

  function buildAutoNukeSimStacks(baseContext) {
    const stacks = groupInterceptingSamsByStack(
      baseContext.targetSams || [],
      baseContext,
    );
    const byKey = new Map();
    for (const stack of stacks) {
      if (!stack.key) continue;
      const stackSams = getAutoNukeSamStackSams(baseContext, stack.key, stack.sams);
      byKey.set(stack.key, {
        ...stack,
        sams: stackSams.length > 0 ? stackSams : stack.sams,
      });
    }
    return { stacks, byKey };
  }

  function getAutoNukeSimStackSlots(context, stackKey, simStack) {
    if (context.samSlotUpdates.has(stackKey)) {
      return [...context.samSlotUpdates.get(stackKey)];
    }
    return getAutoNukeSamStackSlots(
      context.game,
      context.baseContext,
      context.state,
      stackKey,
      simStack?.sams,
    );
  }

  function isAutoNukeRouteStackDestroyed(context, stackKey) {
    const unitKeys = getSamStackUnitKeys(context.baseContext.targetSams, stackKey);
    return unitKeys.length > 0 &&
      unitKeys.every((key) =>
        isAutoNukeSamDestroyedBeforeTick(context.state, key, context.launchTick),
      );
  }

  function findActualAutoNukeBurnInterceptor(context, request) {
    const currentInterception = findAutoNukeSamStackInterceptionSlot(context.game, {
      stack: request.currentSimStack,
      slotAvailableTicks: request.currentSlots,
      candidate: request.burnCandidate,
      shotIndexOffset: context.shotIndexOffset + context.shotSamKeys.length,
      state: context.state,
    });
    if (!currentInterception) return null;

    let best = {
      key: request.currentStackKey,
      shootTick: currentInterception.shootTick,
      slotIndex: currentInterception.slotIndex,
      ownedByTarget: request.currentSimStack.ownedByTarget,
    };
    for (const [otherKey, otherStack] of context.simStacksByKey) {
      if (
        otherKey === request.currentStackKey ||
        isAutoNukeRouteStackDestroyed(context, otherKey)
      ) {
        continue;
      }
      const interception = findAutoNukeSamStackInterceptionSlot(context.game, {
        stack: otherStack,
        slotAvailableTicks: getAutoNukeSimStackSlots(context, otherKey, otherStack),
        candidate: request.burnCandidate,
        shotIndexOffset: context.shotIndexOffset + context.shotSamKeys.length,
        state: context.state,
      });
      if (interception && interception.shootTick < best.shootTick) {
        best = {
          key: otherKey,
          shootTick: interception.shootTick,
          slotIndex: interception.slotIndex,
          ownedByTarget: otherStack.ownedByTarget,
        };
      }
    }
    return best;
  }

  function applyAutoNukeBurnInterception(context, request) {
    const actualStack = context.simStacksByKey.get(request.result.key);
    const slots = request.result.key === request.currentStackKey
      ? request.currentSlots
      : getAutoNukeSimStackSlots(context, request.result.key, actualStack);
    slots[request.result.slotIndex] =
      request.result.shootTick + getSamCooldown(context.game) + 1;
    slots.sort((left, right) => left - right);
    context.samSlotUpdates.set(request.result.key, [...slots]);
    return request.result.key === request.currentStackKey
      ? [...slots]
      : request.currentSlots;
  }

  function getAutoNukeStackBurnCandidate(context, stack) {
    if (!stack.ownedByTarget) return context.candidate;
    const spec = getAutoNukeSamBurnSpec(
      context.game,
      context.baseContext.myPlayer,
    );
    if (!spec) return null;
    return scoreAutoNukeSamClearCandidate(
      context.game,
      context.baseContext,
      spec,
      stack.sams[0],
      context.candidate.totalScore,
    );
  }

  function appendAutoNukeBurnShot(context, burnCandidate, result, safety = false) {
    context.shotSamKeys.push({
      key: result.key,
      ownedByTarget: result.ownedByTarget,
      candidate: burnCandidate,
      interceptedAtTick: result.shootTick,
      ...(safety ? { safety: true } : {}),
    });
  }

  function burnAutoNukeStackSlots(context, stack, simStack, burnCandidate) {
    for (let guard = 0; guard < AUTO_NUKE_MAX_SAM_BURN_SHOTS_PER_STACK; guard++) {
      const stackSlots = getAutoNukeSimStackSlots(context, stack.key, simStack);
      const mainInterception = findAutoNukeSamStackInterceptionSlot(context.game, {
        stack: simStack,
        slotAvailableTicks: stackSlots,
        candidate: context.candidate,
        shotIndexOffset: context.shotIndexOffset + context.shotSamKeys.length,
        state: context.state,
      });
      if (!mainInterception) return stackSlots;
      const result = findActualAutoNukeBurnInterceptor(context, {
        burnCandidate,
        currentStackKey: stack.key,
        currentSimStack: simStack,
        currentSlots: stackSlots,
      });
      if (!result) return null;
      applyAutoNukeBurnInterception(context, {
        result,
        currentStackKey: stack.key,
        currentSlots: stackSlots,
      });
      appendAutoNukeBurnShot(context, burnCandidate, result);
    }
    const stackSlots = getAutoNukeSimStackSlots(context, stack.key, simStack);
    const stillIntercepts = findAutoNukeSamStackInterceptionSlot(context.game, {
      stack: simStack,
      slotAvailableTicks: stackSlots,
      candidate: context.candidate,
      shotIndexOffset: context.shotIndexOffset + context.shotSamKeys.length,
      state: context.state,
    });
    return stillIntercepts ? null : stackSlots;
  }

  function getAutoNukeStackSafetyBurnCount(context, stackKey, simStack) {
    const stackSams = simStack.sams || [];
    const stackLevelSum = stackSams.reduce(
      (sum, sam) => sum + Math.max(1, getUnitLevel(sam)),
      0,
    );
    const arrivalTick =
      getCurrentGameTick(context.game) +
      getAutoNukeCandidateFlightTicks(context.game, context.candidate);
    let pendingReadyLevels = 0;
    for (const sam of getAutoNukePendingStackSams(context.baseContext, stackKey)) {
      const readyAt = context.baseContext.pendingSamReadyTicks?.get?.(getUnitKey(sam));
      if (Number.isFinite(readyAt) && readyAt <= arrivalTick) {
        pendingReadyLevels += Math.max(1, getUnitLevel(sam));
      }
    }
    const upgradeBuffer = stackSams.length > 0 ? AUTO_NUKE_SAM_UPGRADE_BUFFER : 0;
    const unitSafety =
      Math.max(0, stackSams.length - 1) *
      AUTO_NUKE_SAM_STACK_SAFETY_BURN_PER_EXTRA_LEVEL;
    const levelSafety = Math.ceil(
      stackLevelSum * AUTO_NUKE_SAM_STACK_SAFETY_BURN_LEVEL_FRACTION,
    );
    return Math.min(
      AUTO_NUKE_SAM_STACK_SAFETY_BURN_CAP,
      Math.max(unitSafety, levelSafety) + pendingReadyLevels + upgradeBuffer,
    );
  }

  function appendAutoNukeStackSafetyBurns(
    context,
    stack,
    simStack,
    burnCandidate,
  ) {
    const count = getAutoNukeStackSafetyBurnCount(context, stack.key, simStack);
    for (let index = 0; index < count; index++) {
      const stackSlots = getAutoNukeSimStackSlots(context, stack.key, simStack);
      const result = findActualAutoNukeBurnInterceptor(context, {
        burnCandidate,
        currentStackKey: stack.key,
        currentSimStack: simStack,
        currentSlots: stackSlots,
      });
      if (!result) break;
      applyAutoNukeBurnInterception(context, {
        result,
        currentStackKey: stack.key,
        currentSlots: stackSlots,
      });
      appendAutoNukeBurnShot(context, burnCandidate, result, true);
    }
  }

  function processAutoNukeInterceptionStack(context, stack) {
    if (!stack.key || isAutoNukeRouteStackDestroyed(context, stack.key)) return true;
    const simStack = context.simStacksByKey.get(stack.key);
    if (!simStack) return true;
    const initialSlots = getAutoNukeSimStackSlots(context, stack.key, simStack);
    const firstInterception = findAutoNukeSamStackInterceptionSlot(context.game, {
      stack: simStack,
      slotAvailableTicks: initialSlots,
      candidate: context.candidate,
      shotIndexOffset: context.shotIndexOffset + context.shotSamKeys.length,
      state: context.state,
    });
    if (!firstInterception) return true;

    const burnCandidate = getAutoNukeStackBurnCandidate(context, stack);
    if (!burnCandidate) return false;
    const clearedSlots = burnAutoNukeStackSlots(
      context,
      stack,
      simStack,
      burnCandidate,
    );
    if (!clearedSlots) return false;
    appendAutoNukeStackSafetyBurns(
      context,
      stack,
      simStack,
      burnCandidate,
    );
    return true;
  }

  function getAutoNukeInterceptionBurnCost(context) {
    return context.shotSamKeys.reduce((sum, shot) => {
      const cost = getNukeSuggestionUnitCost(
        context.game,
        context.baseContext.myPlayer,
        shot.candidate.spec.type,
      );
      return sum + (Number.isFinite(cost) && cost > 0 ? cost : Infinity);
    }, 0);
  }

  function getAutoNukeInterceptionPlan(game, request) {
    const { baseContext, candidate, state, shotIndexOffset = 0 } = request;
    if (candidate.sourceTile == null) return getFailedAutoNukeInterceptionPlan();

    const stackState = buildAutoNukeSimStacks(baseContext);
    const context = {
      game,
      baseContext,
      candidate,
      state,
      shotIndexOffset,
      shotSamKeys: [],
      samSlotUpdates: new Map(),
      simStacksByKey: stackState.byKey,
      launchTick: getAutoNukeShotLaunchOffsetTicks(shotIndexOffset),
    };
    for (const stack of stackState.stacks) {
      if (!processAutoNukeInterceptionStack(context, stack)) {
        return getFailedAutoNukeInterceptionPlan();
      }
    }
    return {
      shotsNeededBeforeLanding: context.shotSamKeys.length,
      shotSamKeys: context.shotSamKeys,
      samSlotUpdates: context.samSlotUpdates,
      burnCost: getAutoNukeInterceptionBurnCost(context),
    };
  }
  function getAutoNukeCircleOverlapFactor(
    candidate,
    selectedCandidates,
    spreadMultiplier = 1,
  ) {
    let factor = 1;
    const spread = Math.max(1, Number(spreadMultiplier) || 1);

    for (const selected of selectedCandidates) {
      if (selected.isSamClear) {
        continue;
      }

      const distance = Math.hypot(candidate.x - selected.x, candidate.y - selected.y);
      const smallerRadius = Math.min(
        candidate.magnitude.outer,
        selected.magnitude.outer,
      );
      const largerRadius = Math.max(
        candidate.magnitude.outer,
        selected.magnitude.outer,
      );

      // Heavy overlap: candidate center sits inside most of the already-selected blast zone.
      if (distance < smallerRadius * 0.82 * spread) {
        return 0;
      }
      if (distance < smallerRadius * 1.1 * spread) {
        factor = Math.min(factor, spread > 1 ? 0.08 : 0.15);
      } else if (distance < largerRadius * 1.5 * spread) {
        factor = Math.min(factor, spread > 1 ? 0.28 : 0.45);
      }
    }

    return factor;
  }

  function getAutoNukeRemoteObjectiveFactor(candidate, state) {
    if ((state?.destructionPhase || "") !== "remote") {
      return 1;
    }

    const origin = state.remoteOrigin;
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
      return 1.2;
    }

    const distance = Math.hypot(candidate.x - origin.x, candidate.y - origin.y);
    return 1.1 + Math.min(1.75, distance / 150);
  }

  function isAutoNukeSamClearPhase(mode, state) {
    return mode === "sams" ||
      (mode === "destruction" && state?.destructionPhase === "sams") ||
      Boolean(state?.hasPrioritySamClear);
  }

  function isAutoNukeSamClearStackCleared(state, stackKey) {
    if (!stackKey) {
      return true;
    }

    const stackKeys = state?.samClearStackUnitKeys?.get?.(stackKey) || [];
    if (stackKeys.length === 0) {
      return false;
    }

    return stackKeys.every((samKey) => state.destroyedSamKeys.has(samKey));
  }

  function chooseAutoNukeFocusedSamStackKey(candidates, state) {
    if (
      state.focusedSamStackKey &&
      !isAutoNukeSamClearStackCleared(state, state.focusedSamStackKey)
    ) {
      return state.focusedSamStackKey;
    }

    let best = null;
    for (const candidate of candidates || []) {
      const stackKey = candidate.samClearStackKey;
      if (!candidate.isSamClear || !stackKey) {
        continue;
      }

      const remainingSamCount = registerAutoNukeStackCandidate(
        candidate,
        state,
      );
      if (remainingSamCount <= 0) {
        continue;
      }

      const score = remainingSamCount * AUTO_NUKE_DESTRUCTION_SAM_BONUS +
        (candidate.totalScore || 0);
      if (!best || score > best.score) {
        best = {
          stackKey,
          score,
        };
      }
    }

    state.focusedSamStackKey = best?.stackKey || null;
    if (!state.focusedSamStackKey) {
      state.hasPrioritySamClear = false;
    }
    return state.focusedSamStackKey;
  }

  function registerAutoNukeStackCandidate(candidate, state) {
    const stackKey = candidate.samClearStackKey;
    const stackKeys = candidate.samClearStackSamKeys || [];
    if (stackKeys.length > 0) state.samClearStackUnitKeys.set(stackKey, stackKeys);
    return stackKeys.reduce(
      (sum, samKey) => sum + (state.destroyedSamKeys.has(samKey) ? 0 : 1),
      0,
    );
  }

  function getAutoNukeMarginalScore(candidate, mode, state) {
    if (candidate.isSamClear || candidate.spec?.scoreMode === "sam-clear") {
      return getAutoNukeSamClearMarginalScore(candidate, mode, state);
    }

    if (mode === "economic" && candidate.hitEconomicStructureWeights?.size) {
      return sumUnseenAutoNukeWeights(
        candidate.hitEconomicStructureWeights,
        state.hitEconomicStructureKeys,
      );
    }

    if (mode === "destruction") return getAutoNukeDestructionMarginalScore(candidate, state);

    if (mode === "sams") return 0;
    return getAutoNukePopulationMarginalScore(candidate, state);
  }

  function getAutoNukeSamClearMarginalScore(candidate, mode, state) {
    const relevantMode = mode === "destruction" || mode === "sams";
    if (mode === "destruction" && state.destructionPhase !== "sams") return 0;
    const remaining = (candidate.hitSamKeys || []).reduce(
      (sum, key) => sum + (state.destroyedSamKeys.has(key) ? 0 : 1),
      0,
    );
    if (remaining <= 0) return 0;
    return relevantMode ? candidate.totalScore * 4 : candidate.totalScore;
  }

  function sumUnseenAutoNukeWeights(entries, seen) {
    let total = 0;
    for (const [key, weight] of entries || []) {
      if (!seen.has(key)) total += weight;
    }
    return total;
  }

  function getAutoNukeDestructionMarginalScore(candidate, state) {
    if (state.destructionPhase === "sams" && candidate.intercepted) return 0;
    const buildingImpact = sumUnseenAutoNukeWeights(
      candidate.hitDestructionStructureWeights,
      state.hitDestructionStructureKeys,
    );
    const populationImpact =
      buildingImpact > 0 ? (candidate.populationLoss || 0) * 0.15 : 0;
    return (
      (buildingImpact + populationImpact) *
      getAutoNukeRemoteObjectiveFactor(candidate, state) *
      getAutoNukeCircleOverlapFactor(
        candidate,
        state.selectedCandidates,
        state.spreadMultiplier,
      )
    );
  }

  function getAutoNukePopulationMarginalScore(candidate, state) {

    // Population mode: marginal score — subtract contributions from already-hit
    // cities/structures so overlapping nukes don't over-value the same buildings.
    // Only add raw troop/territory population loss when there are untracked city or
    // economic targets to justify the shot — prevents re-firing at areas where all
    // named objectives are already covered.
    let marginalCityPop = 0;
    let hasUntrackedObjectives = false;
    for (const [cityKey, weight] of candidate.hitCityPopulationWeights || []) {
      if (!state.hitCityPopulationKeys.has(cityKey)) {
        marginalCityPop += Math.max(0, Number(weight) || 0);
        hasUntrackedObjectives = true;
      }
    }
    for (const [structureKey, weight] of candidate.hitEconomicStructureWeights || []) {
      if (!state.hitEconomicStructureKeys.has(structureKey)) {
        marginalCityPop += Math.max(0, Number(weight) || 0);
        hasUntrackedObjectives = true;
      }
    }
    const marginalPopulation = hasUntrackedObjectives
      ? marginalCityPop + Math.max(0, Number(candidate.populationLoss) || 0)
      : marginalCityPop;
    return marginalPopulation *
      getAutoNukeCircleOverlapFactor(
        candidate,
        state.selectedCandidates,
        state.spreadMultiplier,
      );
  }

  function isAutoNukeHydrogenCandidateEfficient(game, request) {
    const {
      baseContext,
      candidate,
      candidates,
      mode,
      state,
      marginalScore,
      totalCost,
      remainingGold,
      remainingSiloSlots,
    } = request;
    if (candidate.spec?.type !== "Hydrogen Bomb") {
      return true;
    }
    if (isHydrogenCheaperThanFiveAtomNukes(game, baseContext.myPlayer)) {
      return true;
    }

    const atomCost = getNukeSuggestionUnitCost(
      game,
      baseContext.myPlayer,
      "Atom Bomb",
    );
    if (!Number.isFinite(atomCost) || atomCost <= 0) {
      return marginalScore > 0;
    }

    const atomAlternatives = collectAutoNukeAtomAlternatives(game, {
      baseContext,
      candidate,
      candidates,
      mode,
      state,
      atomCost,
      remainingGold,
      remainingSiloSlots,
    });
    const atomPlan = selectAutoNukeAtomAlternatives(atomAlternatives);
    if (atomPlan.score <= 0 || atomPlan.cost <= 0) return marginalScore > 0;
    const hydrogenDensity = marginalScore / totalCost;
    const atomDensity = atomPlan.score / atomPlan.cost;
    return marginalScore >= atomPlan.score || hydrogenDensity >= atomDensity * 1.05;
  }

  function collectAutoNukeAtomAlternatives(game, request) {
    const alternatives = [];
    for (const atomCandidate of request.candidates) {
      if (
        atomCandidate === request.candidate ||
        atomCandidate.isSamClear ||
        atomCandidate.spec?.type !== "Atom Bomb"
      ) {
        continue;
      }

      const atomKey = `${atomCandidate.spec.type}:${atomCandidate.tile}`;
      if (request.state.selectedCandidateKeys.has(atomKey)) continue;

      const interception = getAutoNukeInterceptionPlan(game, {
        baseContext: request.baseContext,
        candidate: atomCandidate,
        state: request.state,
      });
      const atomShotsNeeded = interception.shotsNeededBeforeLanding + 1;
      const atomTotalCost = request.atomCost + interception.burnCost;
      if (
        !Number.isFinite(atomTotalCost) ||
        atomShotsNeeded > 5 ||
        atomShotsNeeded > request.remainingSiloSlots ||
        atomTotalCost > request.remainingGold
      ) {
        continue;
      }

      const atomMarginalScore = getAutoNukeMarginalScore(
        atomCandidate,
        request.mode,
        request.state,
      );
      if (atomMarginalScore < AUTO_NUKE_MIN_MARGINAL_SCORE) continue;

      alternatives.push({
        score: atomMarginalScore,
        cost: atomTotalCost,
        shots: atomShotsNeeded,
        density: atomMarginalScore / atomTotalCost,
      });
    }
    return alternatives.sort((a, b) => b.density - a.density || b.score - a.score);
  }

  function selectAutoNukeAtomAlternatives(alternatives) {
    const result = { score: 0, cost: 0, shots: 0 };
    for (const alternative of alternatives) {
      if (result.shots + alternative.shots > 5) continue;
      result.score += alternative.score;
      result.cost += alternative.cost;
      result.shots += alternative.shots;
      if (result.shots >= 5) break;
    }
    return result;
  }

  function markAutoNukeCandidateLanded(candidate, state, landingTick = 0) {
    if (!candidate.isSamClear) {
      state.selectedCandidates.push(candidate);
    }

    markAutoNukeSamsDestroyed(candidate, state, landingTick);
    addMapKeysToSet(candidate.hitEconomicStructureWeights, state.hitEconomicStructureKeys);
    addMapKeysToSet(candidate.hitCityPopulationWeights, state.hitCityPopulationKeys);
    addMapKeysToSet(
      candidate.hitDestructionStructureWeights,
      state.hitDestructionStructureKeys,
    );
  }

  function markAutoNukeSamsDestroyed(candidate, state, landingTick) {
    const destroyedAt = Math.max(0, Math.floor(Number(landingTick) || 0));
    state.samDestroyedAtTicks ||= new Map();
    for (const samKey of candidate.hitSamKeys || []) {
      state.destroyedSamKeys.add(samKey);
      const current = Number(state.samDestroyedAtTicks.get(samKey));
      if (!Number.isFinite(current) || destroyedAt < current) {
        state.samDestroyedAtTicks.set(samKey, destroyedAt);
      }
    }
  }

  function addMapKeysToSet(map, set) {
    for (const key of map?.keys?.() || []) set.add(key);
  }

  function cloneAutoNukePlanState(state = null) {
    const source = withAutoNukeFallback(state, {});
    return {
      selectedCandidates: [...withAutoNukeFallback(source.selectedCandidates, [])],
      selectedCandidateKeys: new Set(withAutoNukeFallback(source.selectedCandidateKeys, [])),
      hitEconomicStructureKeys: new Set(withAutoNukeFallback(source.hitEconomicStructureKeys, [])),
      hitCityPopulationKeys: new Set(withAutoNukeFallback(source.hitCityPopulationKeys, [])),
      hitDestructionStructureKeys: new Set(withAutoNukeFallback(source.hitDestructionStructureKeys, [])),
      destroyedSamKeys: new Set(withAutoNukeFallback(source.destroyedSamKeys, [])),
      samClearStackUnitKeys: new Map(withAutoNukeFallback(source.samClearStackUnitKeys, [])),
      focusedSamStackKey: withAutoNukeFallback(source.focusedSamStackKey, null),
      samDestroyedAtTicks: cloneAutoNukeTickMap(source.samDestroyedAtTicks),
      usedSamShots: new Map(withAutoNukeFallback(source.usedSamShots, [])),
      samSlotAvailableTicks: cloneAutoNukeSamSlotUpdates(
        source.samSlotAvailableTicks,
      ),
      plannedAtTick: Number.isFinite(Number(source.plannedAtTick))
        ? Number(source.plannedAtTick)
        : null,
      spreadMultiplier: Math.max(1, withAutoNukeFallback(Number(source.spreadMultiplier), 1)),
      destructionPhase: withAutoNukeFallback(source.destructionPhase, "buildings"),
      hasPrioritySamClear: Boolean(source.hasPrioritySamClear),
      remoteOrigin: withAutoNukeFallback(source.remoteOrigin, null),
    };
  }

  function withAutoNukeFallback(value, fallback) {
    return value || fallback;
  }

  function normalizeAutoNukePlanStateTiming(game, state) {
    const currentTick = getCurrentGameTick(game);
    if (Number.isFinite(Number(state.plannedAtTick))) {
      const elapsedTicks = Math.max(0, currentTick - Number(state.plannedAtTick));
      if (elapsedTicks > 0) {
        for (const [stackKey, slots] of state.samSlotAvailableTicks || []) {
          state.samSlotAvailableTicks.set(
            stackKey,
            slots.map((tick) => Math.max(0, Number(tick) - elapsedTicks)),
          );
        }
        for (const [samKey, destroyedAtTick] of state.samDestroyedAtTicks || []) {
          state.samDestroyedAtTicks.set(
            samKey,
            Math.max(0, Number(destroyedAtTick) - elapsedTicks),
          );
        }
      }
    }
    state.plannedAtTick = currentTick;
  }

  function orderAutoNukeShots(shots) {
    const thirdPartySamShots = [];
    const remainingShots = [];

    for (const shot of shots) {
      const isThirdPartyInterceptSam =
        shot.reason === "sam-intercept" &&
        shot.interceptingSamOwnedByTarget === false;
      const isThirdPartyClearSam =
        shot.reason === "sam-clear" &&
        shot.targetSamOwnedByTarget === false;

      if (isThirdPartyInterceptSam || isThirdPartyClearSam) {
        thirdPartySamShots.push(shot);
      } else {
        remainingShots.push(shot);
      }
    }

    return [...thirdPartySamShots, ...remainingShots];
  }

  function getAutoNukeDestructionObjectiveScore(candidate) {
    const buildingCount = candidate.hitDestructionStructureWeights?.size || 0;
    return buildingCount * AUTO_NUKE_DESTRUCTION_BUILDING_BONUS +
      (candidate.totalScore || 0);
  }

  function createAutoNukePlanMetrics() {
    return {
      populationDamage: 0,
      economicDamage: 0,
      samsDestroyed: 0,
      hitPopulationCandidateKeys: new Set(),
      hitCityPopulationKeys: new Set(),
      hitEconomicStructureKeys: new Set(),
      hitSamKeys: new Set(),
    };
  }

  function addAutoNukeCandidateMetrics(metrics, candidate) {
    if (!metrics || !candidate) {
      return;
    }

    metrics.populationDamage += addUnseenWeightedMetrics(
      candidate.hitCityPopulationWeights,
      metrics.hitCityPopulationKeys,
    );
    metrics.populationDamage += addAutoNukePopulationLossMetric(
      metrics,
      candidate,
    );
    metrics.economicDamage += addUnseenWeightedMetrics(
      candidate.hitEconomicStructureWeights,
      metrics.hitEconomicStructureKeys,
    );
    metrics.samsDestroyed += addUnseenKeys(
      candidate.hitSamKeys,
      metrics.hitSamKeys,
    );
  }

  function addUnseenWeightedMetrics(entries, seen) {
    let added = 0;
    for (const [key, weight] of entries || []) {
      if (seen.has(key)) continue;
      seen.add(key);
      added += Math.max(0, Number(weight) || 0);
    }
    return added;
  }

  function addUnseenKeys(keys, seen) {
    let added = 0;
    for (const key of keys || []) {
      if (seen.has(key)) continue;
      seen.add(key);
      added++;
    }
    return added;
  }

  function addAutoNukePopulationLossMetric(metrics, candidate) {
    const loss = Math.max(0, Number(candidate.populationLoss) || 0);
    if (loss <= 0) return 0;
    const key = `${candidate.spec?.type || ""}:${candidate.tile}`;
    if (metrics.hitPopulationCandidateKeys.has(key)) return 0;
    metrics.hitPopulationCandidateKeys.add(key);
    return loss;
  }

  function finalizeAutoNukePlanMetrics(metrics, shotCount, cost) {
    return {
      shotCount: Math.max(0, Math.floor(Number(shotCount) || 0)),
      cost: Math.max(0, Number(cost) || 0),
      populationDamage: Math.max(0, Number(metrics?.populationDamage) || 0),
      economicDamage: Math.max(0, Number(metrics?.economicDamage) || 0),
      samsDestroyed: Math.max(0, Math.floor(Number(metrics?.samsDestroyed) || 0)),
    };
  }

  function appendAutoNukeDestructionConfirmationShots(game, request) {
    const {
      baseContext,
      state,
      shots,
      confirmationShotLimit = AUTO_NUKE_DESTRUCTION_CONFIRMATION_SHOTS,
      metrics = null,
    } = request;
    const remainingGold = request.remainingGold;
    const remainingSiloSlots = request.remainingSiloSlots;
    const totalCost = request.totalCost;
    if (
      !canAppendAutoNukeConfirmationShots({
        ...request,
        confirmationShotLimit,
      })
    ) {
      return {
        remainingGold,
        remainingSiloSlots,
        totalCost,
      };
    }

    const mainObjectives = state.selectedCandidates
      .filter((candidate) => !candidate.isSamClear && candidate.tile != null)
      .sort((a, b) =>
        getAutoNukeDestructionObjectiveScore(b) -
          getAutoNukeDestructionObjectiveScore(a),
      );
    if (mainObjectives.length === 0) {
      return {
        remainingGold,
        remainingSiloSlots,
        totalCost,
      };
    }

    let confirmationShots = 0;
    let objectiveIndex = 0;
    const budget = { remainingGold, remainingSiloSlots, totalCost };
    while (
      confirmationShots < confirmationShotLimit &&
      budget.remainingGold > 0 &&
      budget.remainingSiloSlots > 0 &&
      objectiveIndex < mainObjectives.length * confirmationShotLimit
    ) {
      const candidate = mainObjectives[objectiveIndex % mainObjectives.length];
      objectiveIndex++;
      const appended = tryAppendAutoNukeConfirmationShot(game, {
        baseContext,
        candidate,
        state,
        shots,
        metrics,
        budget,
      });
      if (appended) confirmationShots++;
    }

    return budget;
  }

  function canAppendAutoNukeConfirmationShots(request) {
    const supportedMode = request.mode === "destruction" || request.mode === "sams";
    return (
      supportedMode &&
      request.confirmationShotLimit > 0 &&
      request.remainingGold > 0 &&
      request.remainingSiloSlots > 0
    );
  }

  function tryAppendAutoNukeConfirmationShot(game, request) {
    const { baseContext, candidate, state, shots, metrics, budget } = request;
    const nukeCost = getNukeSuggestionUnitCost(
      game,
      baseContext.myPlayer,
      candidate.spec.type,
    );
    if (!Number.isFinite(nukeCost) || nukeCost <= 0) return false;
    const interceptionPlan = getAutoNukeInterceptionPlan(game, {
      baseContext,
      candidate,
      state,
      shotIndexOffset: shots.length,
    });
    const shotsNeeded = interceptionPlan.shotsNeededBeforeLanding + 1;
    const shotCost = nukeCost + (interceptionPlan.burnCost || 0);
    if (!canAffordAutoNukeShot(budget, shotCost, shotsNeeded)) return false;
    appendAutoNukeInterceptionShots(shots, interceptionPlan);
    applyAutoNukeInterceptionPlan(state, interceptionPlan);
    shots.push({
      tile: candidate.tile,
      sourceTile: candidate.sourceTile,
      rocketDirectionUp: candidate.rocketDirectionUp,
      spec: candidate.spec,
      reason: "confirmation",
    });
    addAutoNukeCandidateMetrics(metrics, candidate);
    markAutoNukeCandidateLanded(
      candidate,
      state,
      getAutoNukeCandidateLandingTick(game, candidate, shots.length - 1),
    );
    budget.remainingGold -= shotCost;
    budget.remainingSiloSlots -= shotsNeeded;
    budget.totalCost += shotCost;
    return true;
  }

  function canAffordAutoNukeShot(budget, cost, slots) {
    return (
      Number.isFinite(cost) &&
      Number.isFinite(slots) &&
      slots <= budget.remainingSiloSlots &&
      cost <= budget.remainingGold
    );
  }

  function appendAutoNukeInterceptionShots(shots, plan) {
    for (const shotSam of plan.shotSamKeys) {
      shots.push({
        tile: shotSam.candidate.tile,
        sourceTile: shotSam.candidate.sourceTile,
        rocketDirectionUp: shotSam.candidate.rocketDirectionUp,
        spec: shotSam.candidate.spec,
        reason: "sam-intercept",
        interceptingSamKey: shotSam.key,
        interceptingSamOwnedByTarget: shotSam.ownedByTarget,
      });
    }
  }

  function getEmptyAutoNukePlan(options) {
    return {
      shots: [],
      score: 0,
      cost: 0,
      budgetGold: 0,
      budgetSiloSlots: 0,
      availableGold: 0,
      availableSiloSlots: 0,
      minimumRequiredGold: Infinity,
      minimumRequiredSiloSlots: Infinity,
      metrics: finalizeAutoNukePlanMetrics(null, 0, 0),
      followupState: cloneAutoNukePlanState(),
      destructionPhase: options?.destructionPhase || "buildings",
    };
  }

  function getAutoNukePlanAvailability(baseContext, options) {
    const gold = getPlayerGoldNumber(baseContext.myPlayer);
    const availableGold = Number.isFinite(gold) ? Math.max(0, gold) : 0;
    const overrideSlots = Number(options?.availableSiloSlotsOverride);
    const availableSiloSlots =
      Number.isFinite(overrideSlots) && overrideSlots >= 0
        ? Math.floor(overrideSlots)
        : getReadyNukeSiloSlotCount(baseContext.myPlayer);
    const budgetGold = Math.min(
      availableGold,
      Math.max(0, Number(options?.maxGold ?? availableGold)),
    );
    const budgetSiloSlots = Math.min(
      availableSiloSlots,
      Math.max(0, Math.floor(Number(options?.maxSiloSlots ?? availableSiloSlots))),
    );
    return { availableGold, availableSiloSlots, budgetGold, budgetSiloSlots };
  }

  function createAutoNukePlanningState(game, baseContext, options) {
    const state = cloneAutoNukePlanState(options?.initialState);
    normalizeAutoNukePlanStateTiming(game, state);
    state.spreadMultiplier = Math.max(
      state.spreadMultiplier || 1,
      Number(options?.spreadMultiplier) || 1,
    );
    state.destructionPhase =
      options?.destructionPhase || state.destructionPhase || "buildings";
    if (!state.remoteOrigin && baseContext.tileInfo?.centroid) {
      state.remoteOrigin = {
        x: baseContext.tileInfo.centroid.x,
        y: baseContext.tileInfo.centroid.y,
      };
    }
    return state;
  }

  function getAutoNukeConfirmationShotLimit(mode, options) {
    if (mode !== "destruction") return 0;
    const requested = options?.confirmationShots ??
      AUTO_NUKE_DESTRUCTION_CONFIRMATION_SHOTS;
    return Math.max(0, Math.floor(Number(requested)));
  }

  function createAutoNukePlanContext(game, baseContext, mode, options) {
    const availability = getAutoNukePlanAvailability(baseContext, options);
    const state = createAutoNukePlanningState(game, baseContext, options);
    const confirmationShotLimit = getAutoNukeConfirmationShotLimit(mode, options);
    const { availableGold, availableSiloSlots, budgetGold, budgetSiloSlots } =
      availability;
    return {
      game,
      baseContext,
      mode,
      state,
      shots: [],
      metrics: createAutoNukePlanMetrics(),
      availableGold,
      availableSiloSlots,
      budgetGold,
      budgetSiloSlots,
      remainingGold: budgetGold,
      remainingSiloSlots: budgetSiloSlots,
      totalScore: 0,
      totalCost: 0,
      minimumRequiredGold: Infinity,
      minimumRequiredSiloSlots: Infinity,
      confirmationShotLimit,
      confirmationShotReserve:
        mode === "destruction"
          ? Math.min(confirmationShotLimit, Math.max(0, budgetSiloSlots - 2))
          : 0,
    };
  }

  function getAutoNukeCandidateReservation(context, candidate) {
    const inClearPhase = isAutoNukeSamClearPhase(context.mode, context.state);
    const shouldReserve = candidate.isSamClear &&
      context.mode !== "sams" &&
      !inClearPhase;
    return {
      slots: shouldReserve ? 1 : 0,
      gold: shouldReserve
        ? getAutoNukeMinimumAvailableCost(
          context.game,
          context.baseContext.myPlayer,
        )
        : 0,
    };
  }

  function recordAutoNukeMinimumRequirements(context, evaluation, reservation) {
    context.minimumRequiredSiloSlots = Math.min(
      context.minimumRequiredSiloSlots,
      context.budgetSiloSlots -
        context.remainingSiloSlots +
        evaluation.shotsNeeded +
        reservation.slots +
        context.confirmationShotReserve,
    );
    context.minimumRequiredGold = Math.min(
      context.minimumRequiredGold,
      context.budgetGold -
        context.remainingGold +
        evaluation.totalCost +
        reservation.gold,
    );
  }

  function evaluateAutoNukePlanCandidate(context, candidates, candidate) {
    const candidateKey = `${candidate.spec.type}:${candidate.tile}`;
    if (context.state.selectedCandidateKeys.has(candidateKey)) return null;
    const nukeCost = getNukeSuggestionUnitCost(
      context.game,
      context.baseContext.myPlayer,
      candidate.spec.type,
    );
    if (!Number.isFinite(nukeCost) || nukeCost <= 0) return null;

    const interceptionPlan = getAutoNukeInterceptionPlan(context.game, {
      baseContext: context.baseContext,
      candidate,
      state: context.state,
      shotIndexOffset: context.shots.length,
    });
    const shotsNeeded = interceptionPlan.shotsNeededBeforeLanding + 1;
    const totalCost = nukeCost + interceptionPlan.burnCost;
    if (!Number.isFinite(totalCost) || !Number.isFinite(shotsNeeded)) return null;

    const marginalScore = getAutoNukeMarginalScore(
      candidate,
      context.mode,
      context.state,
    );
    if (marginalScore < AUTO_NUKE_MIN_MARGINAL_SCORE) return null;

    const reservation = getAutoNukeCandidateReservation(context, candidate);
    const exceedsBudget =
      shotsNeeded + reservation.slots + context.confirmationShotReserve >
        context.remainingSiloSlots ||
      totalCost + reservation.gold > context.remainingGold;
    if (exceedsBudget) {
      recordAutoNukeMinimumRequirements(
        context,
        { shotsNeeded, totalCost },
        reservation,
      );
      return null;
    }
    if (
      !isAutoNukeHydrogenCandidateEfficient(context.game, {
        baseContext: context.baseContext,
        candidate,
        candidates,
        mode: context.mode,
        state: context.state,
        marginalScore,
        totalCost,
        remainingGold: context.remainingGold,
        remainingSiloSlots: context.remainingSiloSlots,
      })
    ) {
      return null;
    }
    return {
      candidate,
      candidateKey,
      interceptionPlan,
      marginalScore,
      nukeCost,
      shotsNeeded,
      totalCost,
      valueDensity: marginalScore / totalCost,
    };
  }

  function isBetterAutoNukePlanCandidate(evaluation, best) {
    return (
      !best ||
      evaluation.valueDensity > best.valueDensity ||
      (
        evaluation.valueDensity === best.valueDensity &&
        evaluation.marginalScore > best.marginalScore
      )
    );
  }

  function findBestAutoNukePlanCandidate(context, candidates) {
    let best = null;
    const focusedStackKey = isAutoNukeSamClearPhase(context.mode, context.state)
      ? chooseAutoNukeFocusedSamStackKey(candidates, context.state)
      : null;
    for (const candidate of candidates) {
      if (
        focusedStackKey &&
        candidate.isSamClear &&
        candidate.samClearStackKey !== focusedStackKey
      ) {
        continue;
      }
      const evaluation = evaluateAutoNukePlanCandidate(
        context,
        candidates,
        candidate,
      );
      if (evaluation && isBetterAutoNukePlanCandidate(evaluation, best)) {
        best = evaluation;
      }
    }
    return best;
  }

  function shouldOvershootAutoNukeSamClear(context, candidate) {
    if (!candidate.isSamClear) return false;
    if (context.mode === "sams") return true;
    if (
      context.mode === "destruction" &&
      context.state.destructionPhase === "sams"
    ) return true;
    return context.state.hasPrioritySamClear &&
      candidate.isBlockingStack &&
      candidate.samsHit >= 3;
  }

  function getAutoNukeBaseSamOvershoot(stackSize, levelSum) {
    if (stackSize <= 1) return levelSum >= 2 ? 1 : 0;
    if (stackSize === 2) return 1;
    if (stackSize === 3) return 2;
    return 3;
  }

  function getAutoNukeSamOvershootCount(context, best) {
    if (!shouldOvershootAutoNukeSamClear(context, best.candidate)) return 0;

    const samsHit = Math.max(1, best.candidate.samsHit || 1);
    const liveKeys = (best.candidate.samClearStackSamKeys || []).filter(
      (key) => !context.state.destroyedSamKeys.has(key),
    );
    const stackSize = Math.max(samsHit, liveKeys.length);
    const levelSum = Math.max(
      stackSize,
      Number(best.candidate.samClearStackLevelSum) || stackSize,
    );
    const baseOvershoot = getAutoNukeBaseSamOvershoot(stackSize, levelSum);

    const scaled = Math.min(
      AUTO_NUKE_MAX_SAM_OVERSHOOT_SHOTS,
      baseOvershoot +
        (levelSum >= 10 ? 1 : 0) +
        (best.candidate.isBlockingStack && stackSize >= 3 ? 1 : 0),
    );
    return Math.min(
      scaled,
      Math.max(0, context.remainingSiloSlots - best.shotsNeeded),
      Math.max(
        0,
        Math.floor(
          (context.remainingGold - best.totalCost) / best.nukeCost,
        ),
      ),
    );
  }

  function appendAutoNukePlanSelection(context, best) {
    for (const shotSam of best.interceptionPlan.shotSamKeys) {
      context.shots.push({
        tile: shotSam.candidate.tile,
        sourceTile: shotSam.candidate.sourceTile,
        rocketDirectionUp: shotSam.candidate.rocketDirectionUp,
        spec: shotSam.candidate.spec,
        reason: "sam-intercept",
        interceptingSamKey: shotSam.key,
        interceptingSamOwnedByTarget: shotSam.ownedByTarget,
      });
    }
    applyAutoNukeInterceptionPlan(context.state, best.interceptionPlan);
    const mainShotIndex = context.shots.length;
    context.shots.push({
      tile: best.candidate.tile,
      sourceTile: best.candidate.sourceTile,
      rocketDirectionUp: best.candidate.rocketDirectionUp,
      spec: best.candidate.spec,
      reason: best.candidate.isSamClear ? "sam-clear" : "impact",
      targetSamOwnedByTarget: best.candidate.samClearOwnedByTarget,
    });
    addAutoNukeCandidateMetrics(context.metrics, best.candidate);

    const overshootCount = getAutoNukeSamOvershootCount(context, best);
    for (let index = 0; index < overshootCount; index++) {
      context.shots.push({
        tile: best.candidate.tile,
        sourceTile: best.candidate.sourceTile,
        rocketDirectionUp: best.candidate.rocketDirectionUp,
        spec: best.candidate.spec,
        reason: "sam-clear-overshoot",
        targetSamOwnedByTarget: best.candidate.samClearOwnedByTarget,
      });
    }
    context.state.selectedCandidateKeys.add(best.candidateKey);
    markAutoNukeCandidateLanded(
      best.candidate,
      context.state,
      getAutoNukeCandidateLandingTick(
        context.game,
        best.candidate,
        mainShotIndex,
      ),
    );
    if (
      isAutoNukeSamClearPhase(context.mode, context.state) &&
      isAutoNukeSamClearStackCleared(
        context.state,
        context.state.focusedSamStackKey,
      )
    ) {
      context.state.focusedSamStackKey = null;
    }

    const overshootCost = overshootCount * best.nukeCost;
    context.remainingGold -= best.totalCost + overshootCost;
    context.remainingSiloSlots -= best.shotsNeeded + overshootCount;
    context.totalCost += best.totalCost + overshootCost;
    if (
      !best.candidate.isSamClear ||
      context.mode === "destruction" ||
      context.mode === "sams" ||
      context.state.hasPrioritySamClear
    ) {
      context.totalScore += best.marginalScore;
    }
  }

  function finalizeAutoNukePlan(context) {
    const confirmation = appendAutoNukeDestructionConfirmationShots(
      context.game,
      {
        baseContext: context.baseContext,
        mode: context.mode,
        state: context.state,
        shots: context.shots,
        remainingGold: context.remainingGold,
        remainingSiloSlots: context.remainingSiloSlots,
        totalCost: context.totalCost,
        confirmationShotLimit: context.confirmationShotLimit,
        metrics: context.metrics,
      },
    );
    return {
      shots: context.shots,
      score: context.totalScore,
      cost: confirmation.totalCost,
      budgetGold: context.budgetGold,
      budgetSiloSlots: context.budgetSiloSlots,
      availableGold: context.availableGold,
      availableSiloSlots: context.availableSiloSlots,
      minimumRequiredGold: context.minimumRequiredGold,
      minimumRequiredSiloSlots: context.minimumRequiredSiloSlots,
      metrics: finalizeAutoNukePlanMetrics(
        context.metrics,
        context.shots.length,
        confirmation.totalCost,
      ),
      followupState: cloneAutoNukePlanState(context.state),
      destructionPhase: context.state.destructionPhase,
    };
  }

  function buildAutoNukePlan(
    game,
    targetPlayer,
    mode,
    options = null,
    candidatePool = null,
  ) {
    const pool = candidatePool ||
      computeAutoNukeCandidatePool(game, targetPlayer, mode);
    if (!pool.baseContext || pool.candidates.length === 0) {
      return getEmptyAutoNukePlan(options);
    }
    const context = createAutoNukePlanContext(
      game,
      pool.baseContext,
      mode,
      options,
    );
    if (
      !isAutoNukeSamClearPhase(mode, context.state) &&
      pool.candidates.some(
        (candidate) => candidate.isSamClear && candidate.isBlockingStack,
      )
    ) {
      context.state.hasPrioritySamClear = true;
    }
    while (
      context.remainingSiloSlots > context.confirmationShotReserve &&
      context.remainingGold > 0
    ) {
      const best = findBestAutoNukePlanCandidate(context, pool.candidates);
      if (!best) break;
      appendAutoNukePlanSelection(context, best);
    }
    return finalizeAutoNukePlan(context);
  }
  function buildAutoNukePlanForMode(
    game,
    targetPlayer,
    mode,
    options = null,
    candidatePool = null,
  ) {
    const plan = buildAutoNukePlan(game, targetPlayer, mode, options, candidatePool);
    if (
      mode !== "destruction" ||
      options?.destructionPhase !== "sams" ||
      !options?.allowDestructionPhaseFallback ||
      plan.shots.length > 0 ||
      plan.score > 0 ||
      Number.isFinite(plan.minimumRequiredGold) ||
      Number.isFinite(plan.minimumRequiredSiloSlots)
    ) {
      return plan;
    }

    return buildAutoNukePlan(
      game,
      targetPlayer,
      mode,
      {
        ...options,
        destructionPhase: "buildings",
        confirmationShots: AUTO_NUKE_DESTRUCTION_CONFIRMATION_SHOTS,
        allowDestructionPhaseFallback: false,
      },
      candidatePool,
    );
  }

  function waitForAutoNukeDelay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function queryAutoNukeBuildable(params, candidate, method) {
    const lookup = params?.myPlayer?.[method];
    if (typeof lookup !== "function") return null;
    {
      const result = await lookup.call(
        params.myPlayer,
        candidate.tile,
        [candidate.spec.type],
      );
      const items = method === "actions" ? result?.buildableUnits : result;
      return Array.from(items || []).find(
        (item) => item?.type === candidate.spec.type && item.canBuild,
      ) || null;
    }
  }

  async function getAutoNukeBuildableUnit(params, candidate) {
    if (!candidate?.spec?.type || candidate.tile == null) return null;
    const direct = await queryAutoNukeBuildable(
      params,
      candidate,
      "buildables",
    );
    return direct || queryAutoNukeBuildable(params, candidate, "actions");
  }

  function applyAutoNukeRocketDirection(params, candidate) {
    const type = candidate.spec?.type;
    if (type !== "Atom Bomb" && type !== "Hydrogen Bomb") return;
    if (params?.buildMenu?.uiState) {
      params.buildMenu.uiState.rocketDirectionUp =
        candidate.rocketDirectionUp !== false;
    }
  }

  async function launchAutoNukeCandidate(params, candidate) {
    if (!candidate || candidate.intercepted || candidate.tile == null) {
      return false;
    }

    const buildableUnit = await getAutoNukeBuildableUnit(params, candidate);
    if (!buildableUnit?.canBuild) {
      return false;
    }

    applyAutoNukeRocketDirection(params, candidate);
    params?.buildMenu?.sendBuildOrUpgrade?.(buildableUnit, candidate.tile);
    return true;
  }

  function estimateAutoNukeShotLandingDelayMs(game, shot, shotIndex) {
    const sourceTile = Number(shot?.sourceTile);
    const targetTile = Number(shot?.tile);
    if (
      !Number.isFinite(sourceTile) ||
      !Number.isFinite(targetTile) ||
      sourceTile < 0 ||
      targetTile < 0
    ) {
      return AUTO_NUKE_FALLBACK_LANDING_MS +
        shotIndex * AUTO_NUKE_SEQUENCE_DELAY_MS;
    }

    {
      const trajectoryTicks = createNukeSuggestionTrajectory(
        game,
        sourceTile,
        targetTile,
        shot.rocketDirectionUp,
      ).length;
      return trajectoryTicks * AUTO_NUKE_GAME_TICK_MS +
        shotIndex * AUTO_NUKE_SEQUENCE_DELAY_MS;
    }
  }

  function estimateAutoNukePlanLandingDelayMs(params, plan) {
    const shots = Array.isArray(plan?.shots) ? plan.shots : [];
    if (shots.length === 0) {
      return 0;
    }

    return shots.reduce(
      (maxDelay, shot, index) =>
        Math.max(maxDelay, estimateAutoNukeShotLandingDelayMs(params.game, shot, index)),
      0,
    );
  }

  function getAutoNukeImpactLabel(objective) {
    const labels = {
      "Destroy SAM stacks": "Strike SAM position",
      "Destroy SAMs + unguarded targets": "Strike unguarded target",
      "Destroy main buildings": "Strike key building",
      "Destroy remote buildings": "Remote building strike",
      "Maximize economic damage": "Strike economic target",
      "Maximize population damage": "Strike population center",
    };
    return labels[objective] || "Strike target";
  }

  function getAutoNukeShotLabel(shot, objective) {
    if (shot?.reason === "sam-intercept") {
      return shot.interceptingSamOwnedByTarget
        ? "Burn SAM slot (decoy)"
        : "Bait allied SAM fire";
    }
    if (shot?.reason === "sam-clear") {
      return shot.targetSamOwnedByTarget === false
        ? "Route thru allied SAM"
        : "Destroy SAM stack";
    }
    if (shot?.reason === "sam-clear-overshoot") return "SAM overshoot (insurance)";
    if (shot?.reason === "confirmation") return "Confirm destruction";
    return getAutoNukeImpactLabel(objective);
  }

  function renderAutoNukePlanSteps(plan, progress) {
    const list = ensureAutoNukeProcessPanel().querySelector(
      ".openfront-helper-auto-nuke-process-steps",
    );
    if (!list) return null;
    const objective = progress?.objective || "";
    list.innerHTML = plan.shots
      .map((shot, index) =>
        `<li data-shot-index="${index}">${getAutoNukeShotLabel(shot, objective)}</li>`,
      )
      .join("");
    return list;
  }

  function getAutoNukeNextShotAction(shot) {
    if (!shot) return "All nukes away";
    if (shot.reason === "sam-intercept") return "Burning SAM slot";
    if (shot.reason === "sam-clear" || shot.reason === "sam-clear-overshoot") {
      return "Striking SAM stack";
    }
    if (shot.reason === "confirmation") return "Confirming hit";
    return "Striking target";
  }

  function updateAutoNukeLaunchProgress(progress, plan, launchedCount) {
    if (!progress) return;
    updateAutoNukeProcessPanel({
      ...progress,
      detail: `${getAutoNukeNextShotAction(plan.shots[launchedCount])} — ${launchedCount}/${plan.shots.length}`,
      progress: plan.shots.length > 0 ? launchedCount / plan.shots.length : 1,
    });
  }

  function markAutoNukePlanStepDone(stepsList, launchedCount) {
    const item = stepsList?.querySelector(`[data-shot-index="${launchedCount}"]`);
    if (!item) return;
    item.setAttribute("data-done", "");
    item.scrollIntoView?.({ block: "nearest" });
  }

  async function launchAutoNukePlan(params, plan, progress = null) {
    let launchedCount = 0;
    plan.estimatedLandingDelayMs = estimateAutoNukePlanLandingDelayMs(params, plan);
    plan.estimatedImpactAtMs = performance.now() + plan.estimatedLandingDelayMs;
    const stepsList = renderAutoNukePlanSteps(plan, progress);

    if (progress) {
      updateAutoNukeProcessPanel({
        ...progress,
        detail: `Ready — firing 0/${plan.shots.length}`,
        progress: 0,
      });
    }

    for (const shot of plan.shots) {
      if (launchedCount > 0) {
        await waitForAutoNukeDelay(AUTO_NUKE_SEQUENCE_DELAY_MS);
      }

      const launched = await launchAutoNukeCandidate(params, shot);
      if (!launched) {
        break;
      }

      markAutoNukePlanStepDone(stepsList, launchedCount);
      launchedCount++;
      updateAutoNukeLaunchProgress(progress, plan, launchedCount);
    }

    return launchedCount;
  }

  function hideAutoNukeProcessPanel(delayMs = 0) {
    if (autoNukeProcessHideTimeout !== null) {
      window.clearTimeout(autoNukeProcessHideTimeout);
      autoNukeProcessHideTimeout = null;
    }

    const hide = () => {
      const panel = document.getElementById(AUTO_NUKE_PROCESS_PANEL_ID);
      if (panel) {
        panel.hidden = true;
      }
    };

    const delay = Math.max(0, Number(delayMs) || 0);
    if (delay > 0) {
      autoNukeProcessHideTimeout = window.setTimeout(() => {
        autoNukeProcessHideTimeout = null;
        hide();
      }, delay);
      return;
    }

    hide();
  }

  function getAutoNukePhaseShortLabel(mode, phase) {
    if (phase === "sams") return "SAM clear";
    if (phase === "buildings") return "Building strike";
    if (phase === "remote") return "Cleanup";
    if (phase === "sam-clear") return "SAM burn";
    if (mode === "economic") return "Economy strike";
    if (mode === "population") return "Population strike";
    if (mode === "sams") return "SAM clear";
    return "Strike";
  }

  function renderAutoNukeWaveLog() {
    const panel = document.getElementById(AUTO_NUKE_PROCESS_PANEL_ID);
    if (!panel) return;
    const container = panel.querySelector(".openfront-helper-auto-nuke-process-waves");
    if (!container) return;
    if (autoNukeWaveLog.length === 0) {
      container.innerHTML = "";
      return;
    }
    const doneCount = autoNukeWaveLog.filter((e) => e.status === "done").length;
    const total = autoNukeWaveLog.length;
    const activeIdx = autoNukeWaveLog.findIndex((e) => e.status === "active");
    const currentNum = activeIdx >= 0 ? activeIdx + 1 : doneCount;

    const dots = autoNukeWaveLog.map((entry, i) => {
      let cls = "wave-dot";
      if (entry.status === "done") cls += " wave-dot--done";
      else if (entry.status === "active") cls += " wave-dot--active";
      const dotLabel = entry.status === "done" ? "✓" : i + 1;
      return `<span class="${cls}" title="${entry.label}">${dotLabel}</span>`;
    }).join(`<span class="wave-connector"></span>`);

    const activeEntry = activeIdx >= 0 ? autoNukeWaveLog[activeIdx] : null;
    let activeLabel = "";
    if (activeEntry) activeLabel = activeEntry.label.replace(/^Wave \d+ — /, "");
    else if (doneCount === total) activeLabel = "Done";

    container.innerHTML = `
      <div class="wave-summary">
        <span class="wave-summary-label">${activeLabel}</span>
        <span class="wave-summary-count">${currentNum} / ${total}</span>
      </div>
      <div class="wave-track">${dots}</div>
    `;
  }

  function resetAutoNukeWaveLog() {
    autoNukeWaveLog = [];
    renderAutoNukeWaveLog();
  }

  function pushAutoNukeWaveEntry(label, status = "pending") {
    const idx = autoNukeWaveLog.length;
    autoNukeWaveLog.push({ label, status });
    renderAutoNukeWaveLog();
    return idx;
  }

  function setAutoNukeWaveEntryStatus(idx, status) {
    if (idx >= 0 && autoNukeWaveLog[idx]) {
      autoNukeWaveLog[idx].status = status;
      renderAutoNukeWaveLog();
    }
  }

  function activateAutoNukeWaveEntry(idx) {
    setAutoNukeWaveEntryStatus(idx, "active");
  }

  function completeAutoNukeWaveEntry(idx) {
    setAutoNukeWaveEntryStatus(idx, "done");
  }

  // Hide the process panel only after all launched nukes have had time to land,
  // then wait an additional AUTO_NUKE_PROCESS_COMPLETE_HIDE_MS for the user to read it.
  function hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs) {
    const remainingFlightMs = Math.max(0, (latestImpactAtMs || 0) - performance.now());
    hideAutoNukeProcessPanel(remainingFlightMs + AUTO_NUKE_PROCESS_COMPLETE_HIDE_MS);
  }

  function ensureAutoNukeProcessPanelStyles() {
    if (document.getElementById(AUTO_NUKE_PROCESS_PANEL_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = AUTO_NUKE_PROCESS_PANEL_STYLE_ID;
    style.textContent = AUTO_NUKE_PROCESS_PANEL_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAutoNukeProcessPanel() {
    ensureAutoNukeProcessPanelStyles();

    let panel = document.getElementById(AUTO_NUKE_PROCESS_PANEL_ID);
    if (panel) {
      return panel;
    }

    panel = document.createElement("div");
    panel.id = AUTO_NUKE_PROCESS_PANEL_ID;
    panel.hidden = true;
    panel.innerHTML = `
      <div class="openfront-helper-auto-nuke-process-top">
        <div class="openfront-helper-auto-nuke-process-wave"></div>
        <div class="openfront-helper-auto-nuke-process-target"></div>
      </div>
      <div class="openfront-helper-auto-nuke-process-objective"></div>
      <div class="openfront-helper-auto-nuke-process-waves"></div>
      <div class="openfront-helper-auto-nuke-process-track">
        <div class="openfront-helper-auto-nuke-process-fill"></div>
      </div>
      <div class="openfront-helper-auto-nuke-process-detail"></div>
      <ul class="openfront-helper-auto-nuke-process-steps"></ul>
    `;
    (document.body || document.documentElement).appendChild(panel);
    return panel;
  }

  function updateAutoNukeProcessPanel(status = {}) {
    if (autoNukeProcessHideTimeout !== null) {
      window.clearTimeout(autoNukeProcessHideTimeout);
      autoNukeProcessHideTimeout = null;
    }

    const panel = ensureAutoNukeProcessPanel();
    const wave = panel.querySelector(".openfront-helper-auto-nuke-process-wave");
    const target = panel.querySelector(".openfront-helper-auto-nuke-process-target");
    const objective = panel.querySelector(".openfront-helper-auto-nuke-process-objective");
    const fill = panel.querySelector(".openfront-helper-auto-nuke-process-fill");
    const detail = panel.querySelector(".openfront-helper-auto-nuke-process-detail");
    const progress = Math.max(0, Math.min(1, Number(status.progress) || 0));

    panel.classList.toggle(
      "openfront-helper-auto-nuke-process-waiting",
      Boolean(status.waiting),
    );
    if (wave) {
      wave.textContent = status.waveLabel || "Auto nuke";
    }
    if (target) {
      target.textContent = status.targetName || "";
      target.title = status.targetName || "";
    }
    if (objective) {
      objective.textContent = status.objective || "Preparing strike";
    }
    if (fill && !status.waiting) {
      fill.style.width = `${Math.round(progress * 100)}%`;
    }
    if (detail) {
      detail.textContent = status.detail || "";
    }
    renderAutoNukeWaveLog();
    panel.hidden = false;
  }

  function getAutoNukeProcessObjective(mode, phase = null, plan = null) {
    if (mode === "economic") {
      return "Maximize economic damage";
    }
    if (mode === "population") {
      return "Maximize population damage";
    }
    if (phase === "sams") {
      // If the plan also includes unguarded building shots, reflect that.
      const hasBuildings = plan?.shots?.some(
        (s) => s.reason === "impact" || s.reason === "confirmation",
      );
      return hasBuildings ? "Destroy SAMs + unguarded targets" : "Destroy SAM stacks";
    }
    if (phase === "remote") {
      return "Destroy remote buildings";
    }
    if (phase === "buildings") {
      return "Destroy main buildings";
    }
    if (mode === "destruction") {
      return "Total destruction";
    }
    return "Launch nukes";
  }


  function getAutoNukeProcessWaveStatus(params, request) {
    const {
      mode,
      waveNumber,
      phase,
      detail,
      extra = {},
      plan = null,
    } = request;
    return {
      targetName: getPlayerDisplayName(params.selected),
      waveLabel: `Wave ${waveNumber}`,
      objective: getAutoNukeProcessObjective(mode, phase, plan),
      detail,
      ...extra,
    };
  }

  function canContinueAutoNukeSecondPass(params) {
    return Boolean(
      params?.myPlayer?.isPlayer?.() &&
      params?.selected?.isPlayer?.() &&
      (isEnemyNukeSuggestionTarget(params.game, params.selected) ||
        (autoNukeIncludeAllies && params.selected?.isAlive?.() &&
          getPlayerSmallId(params.myPlayer) !== getPlayerSmallId(params.selected))),
    );
  }

  function buildAutoNukeWavePotentialPlan(params, mode, initialState, waveOptions) {
    const totalSiloSlots = getTotalNukeSiloSlotCount(params.myPlayer);
    const gold = getPlayerGoldNumber(params.myPlayer);
    const availableGold = Number.isFinite(gold) ? Math.max(0, gold) : 0;
    if (totalSiloSlots <= 0 || availableGold <= 0) {
      return null;
    }

    const candidatePool = computeAutoNukeCandidatePool(
      params.game,
      params.selected,
      mode,
      { includeCoolingSilos: true },
    );
    const potentialPlan = buildAutoNukePlan(
      params.game,
      params.selected,
      mode,
      {
        maxGold: availableGold,
        maxSiloSlots: totalSiloSlots,
        availableSiloSlotsOverride: totalSiloSlots,
        initialState,
        spreadMultiplier: waveOptions.spreadMultiplier,
        destructionPhase: waveOptions.destructionPhase,
        confirmationShots: waveOptions.confirmationShots,
      },
      candidatePool,
    );

    return potentialPlan.shots.length > 0 && potentialPlan.score > 0
      ? potentialPlan
      : null;
  }

  function getDesiredAutoNukeReadySlots(player, potentialPlan, waveOptions) {
    const totalSlots = getTotalNukeSiloSlotCount(player);
    const readyFraction = Number(waveOptions.readySlotFraction) || 0.6;
    return Math.min(
      totalSlots,
      Math.max(
        1,
        Math.min(
          potentialPlan.budgetSiloSlots || totalSlots,
          Math.max(2, Math.ceil(totalSlots * readyFraction)),
        ),
      ),
    );
  }

  function updateAutoNukeWaitingStatus(processStatus, detail) {
    if (!processStatus) return;
    updateAutoNukeProcessPanel({ ...processStatus, detail, waiting: true });
  }

  function getAutoNukeWaveResources(player, desiredReadySiloSlots) {
    const readySiloSlots = getReadyNukeSiloSlotCount(player);
    const gold = getPlayerGoldNumber(player);
    const availableGold = Number.isFinite(gold) ? Math.max(0, gold) : 0;
    let waitingDetail = null;
    if (readySiloSlots <= 0) {
      waitingDetail = `Waiting for silos 0/${desiredReadySiloSlots}`;
    } else if (availableGold <= 0) {
      waitingDetail = "Waiting for gold";
    } else if (readySiloSlots < desiredReadySiloSlots) {
      waitingDetail = `Waiting for silos ${readySiloSlots}/${desiredReadySiloSlots}`;
    }
    return { availableGold, readySiloSlots, waitingDetail };
  }

  function getAutoNukeWaveLaunchSlots(readySiloSlots, waveOptions) {
    const fraction = Number(waveOptions.launchSlotFraction);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
      return readySiloSlots;
    }
    return Math.max(1, Math.ceil(readySiloSlots * fraction));
  }

  async function waitForAutoNukeWavePlan(
    params,
    mode,
    initialState,
    waveOptions,
    processStatus = null,
  ) {
    const potentialPlan = buildAutoNukeWavePotentialPlan(
      params,
      mode,
      initialState,
      waveOptions,
    );
    if (!potentialPlan) {
      return null;
    }

    const desiredReadySiloSlots = getDesiredAutoNukeReadySlots(
      params.myPlayer,
      potentialPlan,
      waveOptions,
    );
    const startedAt = performance.now();
    let cachedCandidatePool = null;
    let cachedCandidatePoolAt = -Infinity;
    const CANDIDATE_POOL_TTL_MS = 3500;
    updateAutoNukeWaitingStatus(
      processStatus,
      `Waiting for silos ${getReadyNukeSiloSlotCount(params.myPlayer)}/${desiredReadySiloSlots}`,
    );
    while (performance.now() - startedAt < AUTO_NUKE_SECOND_PASS_MAX_WAIT_MS) {
      if (!canContinueAutoNukeSecondPass(params)) {
        return null;
      }

      const resources = getAutoNukeWaveResources(
        params.myPlayer,
        desiredReadySiloSlots,
      );
      if (resources.waitingDetail) {
        updateAutoNukeWaitingStatus(processStatus, resources.waitingDetail);
        await waitForAutoNukeDelay(AUTO_NUKE_SECOND_PASS_POLL_MS);
        continue;
      }
      const maxSiloSlots = getAutoNukeWaveLaunchSlots(
        resources.readySiloSlots,
        waveOptions,
      );

      const nowMs = performance.now();
      if (
        !cachedCandidatePool ||
        nowMs - cachedCandidatePoolAt > CANDIDATE_POOL_TTL_MS
      ) {
        cachedCandidatePool = computeAutoNukeCandidatePool(
          params.game,
          params.selected,
          mode,
          { includeCoolingSilos: true },
        );
        cachedCandidatePoolAt = nowMs;
      }

      const followupPlan = buildAutoNukePlan(
        params.game,
        params.selected,
        mode,
        {
          maxGold: resources.availableGold,
          maxSiloSlots,
          initialState,
          spreadMultiplier: waveOptions.spreadMultiplier,
          destructionPhase: waveOptions.destructionPhase,
          confirmationShots: waveOptions.confirmationShots,
        },
        cachedCandidatePool,
      );
      if (followupPlan.shots.length > 0 && followupPlan.score > 0) {
        return followupPlan;
      }
      // Force refresh next iteration in case stale pool caused empty plan.
      cachedCandidatePool = null;
      updateAutoNukeWaitingStatus(processStatus, "Scanning targets...");
      await waitForAutoNukeDelay(AUTO_NUKE_SECOND_PASS_POLL_MS);
    }

    return null;
  }

  async function launchAutoNukePreemptiveSamWaves(request) {
    const { params, mode } = request;
    let { followupWaveState, waveNumber, latestImpactAtMs } = request;
    const shouldLaunch = followupWaveState?.hasPrioritySamClear &&
      request.initialPlan.shots.some((shot) => shot.reason === "sam-clear");
    if (!shouldLaunch) return { followupWaveState, waveNumber, latestImpactAtMs };

    for (let wave = 0; wave < AUTO_NUKE_MAX_PREEMPTIVE_SAM_WAVES; wave++) {
      if (!canContinueAutoNukeSecondPass(params)) break;
      waveNumber++;
      const logIndex = pushAutoNukeWaveEntry(`Wave ${waveNumber} — SAM burn`, "active");
      const samClearPlan = await waitForAutoNukeWavePlan(
        params,
        mode,
        followupWaveState,
        {
          spreadMultiplier: 1,
          readySlotFraction: AUTO_NUKE_SECOND_PASS_READY_SLOT_FRACTION,
          launchSlotFraction: 1,
          confirmationShots: 0,
        },
        getAutoNukeProcessWaveStatus(params, {
          mode,
          waveNumber,
          phase: "sam-clear",
          detail: `Burning SAM stacks — wave ${wave + 1}`,
        }),
      );
      if (!samClearPlan?.shots.some((shot) => shot.reason === "sam-clear")) {
        waveNumber--;
        completeAutoNukeWaveEntry(logIndex);
        break;
      }
      const launched = await launchAutoNukePlan(
        params,
        samClearPlan,
        getAutoNukeProcessWaveStatus(params, {
          mode,
          waveNumber,
          phase: "sam-clear",
          detail: `Firing ${samClearPlan.shots.length} SAM-clear nukes`,
        }),
      );
      completeAutoNukeWaveEntry(logIndex);
      if (launched === 0) {
        waveNumber--;
        break;
      }
      latestImpactAtMs = Math.max(
        latestImpactAtMs,
        samClearPlan.estimatedImpactAtMs || 0,
      );
      followupWaveState = samClearPlan.followupState;
    }
    return { followupWaveState, waveNumber, latestImpactAtMs };
  }

  async function launchAutoNukeWithOptionalSecondPass(params, mode, tierId, plan) {
    resetAutoNukeWaveLog();
    const isSamOnlyMode = mode === "sams";
    const isDestructionFlow = mode === "destruction" || isSamOnlyMode;
    const waveNumber = 1;

    // Pre-populate wave 1 entry so user sees what's happening immediately.
    const phase1 = isDestructionFlow ? plan.destructionPhase : mode;
    const phase1Label = getAutoNukePhaseShortLabel(mode, phase1);
    const wave1LogIdx = pushAutoNukeWaveEntry(`Wave 1 — ${phase1Label}`, "active");

    const launchedCount = await launchAutoNukePlan(
      params,
      plan,
      getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: phase1, detail: `Firing ${plan.shots.length} nukes`, extra: {}, plan: plan }),
    );
    const latestImpactAtMs = plan.estimatedImpactAtMs || 0;
    completeAutoNukeWaveEntry(wave1LogIdx);

    if (launchedCount === 0) {
      runtimeDebugLog(`OpenFront Helper: auto ${mode} nukes could not be launched.`);
      updateAutoNukeProcessPanel(
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: isDestructionFlow ? plan.destructionPhase : mode, detail: "Launch failed", extra: { progress: 1 } }),
      );
      hideAutoNukeProcessPanel(AUTO_NUKE_PROCESS_COMPLETE_HIDE_MS);
      return;
    }

    if (!isDestructionFlow) {
      await launchAutoNukeStandardFlow({
        params,
        mode,
        plan,
        launchedCount,
        waveNumber,
        latestImpactAtMs,
      });
      return;
    }
    await launchAutoNukeDestructionFlow({
      params,
      mode,
      plan,
      isSamOnlyMode,
      waveNumber,
      latestImpactAtMs,
    });
  }

  function getAutoNukePlanKey(mode, tierId = "default") {
    return `${mode}:${tierId || "default"}`;
  }

  function getAutoNukeBuildPlanOptions(mode, tierOptions, extraOptions = null) {
    const options = {
      ...(tierOptions?.options || {}),
      ...(extraOptions || {}),
    };

    if (mode === "sams") {
      options.destructionPhase = "sams";
      options.confirmationShots = 0;
      options.allowDestructionPhaseFallback = false;
    } else if (mode === "destruction" && !options.destructionPhase) {
      options.destructionPhase = "sams";
      options.confirmationShots = 0;
      options.allowDestructionPhaseFallback = true;
    }

    return options;
  }

  function executeAutoNuke(params, mode, tierId = null) {
    const now = performance.now();
    if (now - lastAutoNukeActionAt < AUTO_NUKE_ACTION_COOLDOWN_MS) {
      return;
    }
    lastAutoNukeActionAt = now;

    if (isAutoNukeRadialItemDisabled(params)) {
      return;
    }

    const tierOptions = getAutoNukeTierPlanOptions(params, tierId);
    if (tierOptions?.reason) {
      return;
    }
    const planKey = getAutoNukePlanKey(mode, tierId);
    const plan = params.autoNukePlans?.[planKey] ||
      buildAutoNukePlanForMode(
        params.game,
        params.selected,
        mode,
        getAutoNukeBuildPlanOptions(mode, tierOptions),
      );
    if (!plan.shots.length || plan.score <= 0) {
      if (tierId || mode === "destruction" || mode === "sams") {
        return;
      }
      const fallbackCandidate = selectAutoNukeCandidate(
        params.game,
        params.selected,
        mode,
      );
      if (!fallbackCandidate) {
        runtimeDebugLog(`OpenFront Helper: no valid auto ${mode} nuke target found.`);
        return;
      }
      launchAutoNukeCandidate(params, fallbackCandidate).then((launched) => {
        if (!launched) {
          runtimeDebugLog(`OpenFront Helper: auto ${mode} nuke could not be launched.`);
        }
      });
      return;
    }

    launchAutoNukeWithOptionalSecondPass(params, mode, tierId, plan);
  }

  const AUTO_NUKE_CONTEXT_MENU_CSS = `
      #${AUTO_NUKE_CONTEXT_MENU_ID} {
        position: fixed;
        z-index: 9000;
        min-width: 220px;
        padding: 6px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        border-radius: 8px;
        background: rgba(13, 18, 24, 0.96);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
        color: #f8fafc;
        font: 800 12px/1.15 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID}[hidden] {
        display: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-title {
        padding: 5px 7px 7px;
        color: #cbd5e1;
        font-size: 11px;
        font-weight: 800;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
        margin-bottom: 5px;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-loading {
        margin: 5px 4px 7px;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-loading[hidden] {
        display: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-loading-track {
        height: 6px;
        overflow: hidden;
        border-radius: 6px;
        background: rgba(51, 65, 85, 0.92);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-loading-fill {
        width: 0%;
        height: 100%;
        border-radius: 6px;
        background: linear-gradient(90deg, #38bdf8, #facc15);
        transition: width 120ms linear;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-loading-text {
        margin-top: 4px;
        color: #cbd5e1;
        font-size: 10px;
        font-weight: 750;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-steps {
        list-style: none;
        margin: 5px 0 0;
        padding: 0;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-steps li {
        font-size: 10px;
        color: #64748b;
        padding: 1px 0;
        transition: color 100ms;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-steps li::before {
        content: "○ ";
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-steps li[data-done] {
        color: #4ade80;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-steps li[data-done]::before {
        content: "✓ ";
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button {
        display: block;
        width: 100%;
        margin: 0;
        padding: 8px 9px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #f8fafc;
        font: inherit;
        letter-spacing: 0;
        text-align: left;
        cursor: pointer;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button:focus-visible:not(:disabled) {
        outline: none;
        background: rgba(239, 68, 68, 0.24);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="economic"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="economic"]:focus-visible:not(:disabled) {
        background: rgba(34, 197, 94, 0.22);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="destruction"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="destruction"]:focus-visible:not(:disabled) {
        background: rgba(250, 204, 21, 0.2);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="sams"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="sams"]:focus-visible:not(:disabled) {
        background: rgba(56, 189, 248, 0.2);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button:disabled {
        cursor: not-allowed;
        color: rgba(203, 213, 225, 0.48);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-section {
        margin: 7px 4px 3px;
        padding-top: 6px;
        border-top: 1px solid rgba(148, 163, 184, 0.2);
        color: #94a3b8;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-section[hidden] {
        display: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-section[data-auto-nuke-section-label="economic"] {
        color: #86efac;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-section[data-auto-nuke-section-label="population"] {
        color: #fca5a5;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-section[data-auto-nuke-section-label="sams"] {
        color: #bae6fd;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-section[data-auto-nuke-section-label="destruction"] {
        color: #fde68a;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="economic"] {
        border-left: 2px solid rgba(34, 197, 94, 0.42);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="population"] {
        border-left: 2px solid rgba(239, 68, 68, 0.42);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="sams"] {
        border-left: 2px solid rgba(56, 189, 248, 0.5);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-mode="destruction"] {
        border-left: 2px solid rgba(250, 204, 21, 0.5);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-label,
      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-meta {
        display: block;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-label {
        color: inherit;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-meta {
        margin-top: 3px;
        color: #cbd5e1;
        font-size: 10px;
        font-weight: 750;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button:disabled .openfront-helper-auto-nuke-meta {
        color: rgba(203, 213, 225, 0.48);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-back][hidden] {
        display: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-back] {
        color: #94a3b8;
        font-size: 11px;
        font-weight: 750;
        margin-bottom: 3px;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-back]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-back]:focus-visible:not(:disabled) {
        background: rgba(148, 163, 184, 0.12);
        color: #f8fafc;
        outline: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-row {
        display: flex;
        gap: 4px;
        align-items: stretch;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} .openfront-helper-auto-nuke-row > button[data-auto-nuke-expand] {
        flex: 1;
        min-width: 0;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-build-silo] {
        flex-shrink: 0;
        width: auto;
        padding: 6px 10px;
        font-size: 11px;
        font-weight: 850;
        border: 1px solid rgba(16, 185, 129, 0.5);
        border-radius: 6px;
        background: rgba(16, 185, 129, 0.12);
        color: #6ee7b7;
        white-space: nowrap;
        cursor: pointer;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-build-silo]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-build-silo]:focus-visible:not(:disabled) {
        background: rgba(16, 185, 129, 0.28);
        outline: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-build-silo]:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-build-silo][hidden] {
        display: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch][hidden] {
        display: none;
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="economic"] {
        border-left: 2px solid rgba(34, 197, 94, 0.42);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="population"] {
        border-left: 2px solid rgba(239, 68, 68, 0.42);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="sams"] {
        border-left: 2px solid rgba(56, 189, 248, 0.5);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="destruction"] {
        border-left: 2px solid rgba(250, 204, 21, 0.5);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="economic"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="economic"]:focus-visible:not(:disabled) {
        background: rgba(34, 197, 94, 0.22);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="population"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="population"]:focus-visible:not(:disabled) {
        background: rgba(239, 68, 68, 0.24);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="sams"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="sams"]:focus-visible:not(:disabled) {
        background: rgba(56, 189, 248, 0.2);
      }

      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="destruction"]:hover:not(:disabled),
      #${AUTO_NUKE_CONTEXT_MENU_ID} button[data-auto-nuke-branch="destruction"]:focus-visible:not(:disabled) {
        background: rgba(250, 204, 21, 0.2);
      }
    `;

  function ensureAutoNukeContextMenuStyles() {
    if (document.getElementById(AUTO_NUKE_CONTEXT_MENU_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = AUTO_NUKE_CONTEXT_MENU_STYLE_ID;
    style.textContent = AUTO_NUKE_CONTEXT_MENU_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAutoNukeContextMenu() {
    ensureAutoNukeContextMenuStyles();

    let menu = document.getElementById(AUTO_NUKE_CONTEXT_MENU_ID);
    if (menu) {
      return menu;
    }

    menu = document.createElement("div");
    menu.id = AUTO_NUKE_CONTEXT_MENU_ID;
    menu.hidden = true;
    menu.innerHTML = `
      <div class="openfront-helper-auto-nuke-title">Auto nuke</div>
      <div class="openfront-helper-auto-nuke-row">
        <button type="button" data-auto-nuke-expand></button>
        <button type="button" data-auto-nuke-build-silo hidden></button>
      </div>
      <button type="button" data-auto-nuke-back hidden></button>
      <button type="button" data-auto-nuke-branch="economic" hidden></button>
      <button type="button" data-auto-nuke-branch="population" hidden></button>
      <button type="button" data-auto-nuke-branch="sams" hidden></button>
      <button type="button" data-auto-nuke-branch="destruction" hidden></button>
      <div class="openfront-helper-auto-nuke-loading" data-auto-nuke-loading hidden>
        <div class="openfront-helper-auto-nuke-loading-track">
          <div class="openfront-helper-auto-nuke-loading-fill" data-auto-nuke-loading-fill></div>
        </div>
        <div class="openfront-helper-auto-nuke-loading-text" data-auto-nuke-loading-text></div>
        <ul class="openfront-helper-auto-nuke-steps" data-auto-nuke-steps></ul>
      </div>
      <div class="openfront-helper-auto-nuke-section" data-auto-nuke-section-label="economic">Economy</div>
      <button type="button" data-auto-nuke-mode="economic" data-auto-nuke-tier="low"></button>
      <button type="button" data-auto-nuke-mode="economic" data-auto-nuke-tier="medium"></button>
      <button type="button" data-auto-nuke-mode="economic" data-auto-nuke-tier="high"></button>
      <div class="openfront-helper-auto-nuke-section" data-auto-nuke-section-label="population">Population</div>
      <button type="button" data-auto-nuke-mode="population" data-auto-nuke-tier="low"></button>
      <button type="button" data-auto-nuke-mode="population" data-auto-nuke-tier="medium"></button>
      <button type="button" data-auto-nuke-mode="population" data-auto-nuke-tier="high"></button>
      <div class="openfront-helper-auto-nuke-section" data-auto-nuke-section-label="sams">SAMs</div>
      <button type="button" data-auto-nuke-mode="sams"></button>
      <div class="openfront-helper-auto-nuke-section" data-auto-nuke-section-label="destruction">Total destruction</div>
      <button type="button" data-auto-nuke-mode="destruction" data-auto-nuke-tier="high"></button>
    `;
    menu.addEventListener("click", (event) => handleAutoNukeMenuClick(menu, event));
    (document.body || document.documentElement).appendChild(menu);
    return menu;
  }

  function handleAutoNukeMenuClick(menu, event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (handleAutoNukeExpandClick(menu, target)) return;
    if (handleAutoNukeBuildSiloMenuClick(menu, target)) return;
    if (handleAutoNukeBackClick(menu, target)) return;
    if (handleAutoNukeBranchClick(menu, target)) return;
    handleAutoNukeModeClick(target);
  }

  function handleAutoNukeExpandClick(menu, target) {
    const button = target.closest("[data-auto-nuke-expand]");
    if (!(button instanceof HTMLButtonElement)) return false;
    if (!button.disabled) expandAutoNukeContextMenu(menu);
    return true;
  }

  function handleAutoNukeBuildSiloMenuClick(menu, target) {
    const button = target.closest("[data-auto-nuke-build-silo]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    handleAutoNukeBuildSiloClick(menu, autoNukeContextMenuParams, button);
    return true;
  }

  function handleAutoNukeBackClick(menu, target) {
    const button = target.closest("[data-auto-nuke-back]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    goBackToAutoNukeBranchMenu(menu);
    return true;
  }

  function handleAutoNukeBranchClick(menu, target) {
    const button = target.closest("[data-auto-nuke-branch]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    expandAutoNukeModeDetails(menu, button.dataset.autoNukeBranch);
    return true;
  }

  function handleAutoNukeModeClick(target) {
    const button = target.closest("[data-auto-nuke-mode]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const mode = button.dataset.autoNukeMode;
    const tierId = button.dataset.autoNukeTier;
    const params = autoNukeContextMenuParams;
    hideAutoNukeContextMenu();
    if (params && isAutoNukeMode(mode)) executeAutoNuke(params, mode, tierId);
  }

  function isAutoNukeMode(mode) {
    return ["economic", "population", "destruction", "sams"].includes(mode);
  }

  function hideAutoNukeContextMenu() {
    autoNukeContextMenuComputeId++;
    const menu = document.getElementById(AUTO_NUKE_CONTEXT_MENU_ID);
    if (menu) {
      menu.hidden = true;
    }
    autoNukeContextMenuParams = null;
  }

  function getAutoNukeContextMenuDisableReason(params) {
    if (!params?.selected?.isPlayer?.()) {
      return "No player or nation selected.";
    }
    const isEnemy = isEnemyNukeSuggestionTarget(params.game, params.selected);
    if (!isEnemy && !autoNukeIncludeAllies) {
      return "Target is not hostile.";
    }
    if (!hasAutoNukeBuildTypeAvailable(params.game, params.myPlayer)) {
      return "No nuke type is available.";
    }
    const readySlots = getReadyNukeSiloSlotCount(params.myPlayer);
    if (readySlots === 0) {
      const totalSlots = getTotalNukeSiloSlotCount(params.myPlayer);
      if (totalSlots === 0) {
        return "No missile silos built yet.";
      }
      return `0 / ${totalSlots} silo slot${totalSlots !== 1 ? "s" : ""} ready.`;
    }
    const gold = getPlayerGoldNumber(params.myPlayer);
    const minimumCost = getAutoNukeMinimumAvailableCost(params.game, params.myPlayer);
    if (!Number.isFinite(gold) || gold < minimumCost) {
      const missingGold = Number.isFinite(gold) ? minimumCost - gold : minimumCost;
      return `Need ${formatAutoNukeGold(missingGold)} more gold.`;
    }
    return "";
  }

  function getAutoNukeModeLabel(mode) {
    if (mode === "economic") {
      return "Auto econ nukes";
    }
    if (mode === "destruction") {
      return "Total destruction";
    }
    if (mode === "sams") {
      return "Destroy all SAMs";
    }
    return "Auto population nukes";
  }

  function getAutoNukeTierById(tierId) {
    return AUTO_NUKE_INTENSITY_TIERS.find((tier) => tier.id === tierId) ||
      AUTO_NUKE_INTENSITY_TIERS[AUTO_NUKE_INTENSITY_TIERS.length - 1];
  }

  function getAutoNukeTierRank(tierId) {
    return AUTO_NUKE_TIER_ORDER.has(tierId)
      ? AUTO_NUKE_TIER_ORDER.get(tierId)
      : AUTO_NUKE_INTENSITY_TIERS.length;
  }

  function getAutoNukeTierPlanOptions(params, tierId) {
    if (!tierId) {
      return {
        tier: null,
        options: null,
        reason: "",
      };
    }

    const tier = getAutoNukeTierById(tierId);
    const availableSiloSlots = getReadyNukeSiloSlotCount(params.myPlayer);
    const playerGold = getPlayerGoldNumber(params.myPlayer);
    const availableGold = Number.isFinite(playerGold) ? Math.max(0, playerGold) : 0;
    const minimumCost = getAutoNukeMinimumAvailableCost(params.game, params.myPlayer);

    if (availableSiloSlots < tier.minShots) {
      const missingSlots = tier.minShots - availableSiloSlots;
      return {
        tier,
        options: null,
        reason: `Need ${missingSlots} more missile silo ${missingSlots === 1 ? "slot" : "slots"}.`,
      };
    }

    const maxSiloSlots = Math.min(
      availableSiloSlots,
      Math.max(
        tier.minShots,
        Math.ceil(availableSiloSlots * tier.shotFraction),
      ),
    );
    const requiredGold = minimumCost * maxSiloSlots;

    if (!Number.isFinite(availableGold) || availableGold < requiredGold) {
      return {
        tier,
        options: null,
        reason: `Need ${formatAutoNukeGold(requiredGold - availableGold)} more gold.`,
      };
    }

    return {
      tier,
      options: {
        maxGold: availableGold,
        maxSiloSlots,
      },
      reason: "",
    };
  }

  function formatAutoNukeGold(value) {
    return formatNukeSuggestionPopulation(value);
  }

  function formatAutoNukeMetric(value) {
    return formatNukeSuggestionPopulation(Math.max(0, Number(value) || 0));
  }

  function getAutoNukePlanFailureReason(params, plan) {
    const siloReason = getAutoNukeSiloFailureReason(params.myPlayer, plan);
    if (siloReason) return siloReason;

    const minimumCost = getAutoNukeMinimumAvailableCost(params.game, params.myPlayer);
    if (isAutoNukeBelowMinimumCost(plan, minimumCost)) {
      return `Need ${formatAutoNukeGold(minimumCost - (plan?.availableGold || 0))} more gold.`;
    }

    const missingSiloSlots = Number.isFinite(plan?.minimumRequiredSiloSlots)
      ? Math.max(0, Math.ceil(plan.minimumRequiredSiloSlots - plan.budgetSiloSlots))
      : 0;
    const missingGold = Number.isFinite(plan?.minimumRequiredGold)
      ? Math.max(0, plan.minimumRequiredGold - plan.budgetGold)
      : 0;
    if (missingSiloSlots > 0 && missingGold > 0) {
      return `Need ${formatAutoNukeGold(missingGold)} more gold and ${missingSiloSlots} more missile silo ${missingSiloSlots === 1 ? "slot" : "slots"} for this tier.`;
    }
    if (missingSiloSlots > 0) {
      return `Need ${missingSiloSlots} more missile silo ${missingSiloSlots === 1 ? "slot" : "slots"} for this tier.`;
    }
    if (missingGold > 0) {
      return `Need ${formatAutoNukeGold(missingGold)} more gold for this tier.`;
    }

    return "No safe plan.";
  }

  function getAutoNukeSiloFailureReason(player, plan) {
    if (plan?.budgetSiloSlots !== 0 && plan?.availableSiloSlots !== 0) return "";
    const totalSlots = getTotalNukeSiloSlotCount(player);
    if (totalSlots === 0) return "No missile silos built yet.";
    return `0 / ${totalSlots} silo slot${totalSlots !== 1 ? "s" : ""} ready.`;
  }

  function isAutoNukeBelowMinimumCost(plan, minimumCost) {
    if (!Number.isFinite(minimumCost)) return false;
    return plan?.budgetGold < minimumCost || plan?.availableGold < minimumCost;
  }

  function getAutoNukePlanMetrics(plan) {
    return plan?.metrics || finalizeAutoNukePlanMetrics(null, plan?.shots?.length || 0, plan?.cost || 0);
  }

  function formatAutoNukePlanMeta(mode, plan) {
    const metrics = getAutoNukePlanMetrics(plan);
    const shotCount = metrics.shotCount || plan?.shots?.length || 0;
    const nukeLabel = shotCount === 1 ? "nuke" : "nukes";
    const parts = [
      `${shotCount} ${nukeLabel}`,
      `${formatAutoNukeGold(metrics.cost || plan?.cost || 0)} gold`,
    ];

    const sections = getAutoNukeMetaSections(mode, metrics);
    if (sections.population) {
      parts.push(`${formatAutoNukeMetric(metrics.populationDamage)} pop`);
    }
    if (sections.economy) {
      parts.push(`${formatAutoNukeMetric(metrics.economicDamage)} econ`);
    }
    if (sections.sams) {
      parts.push(`${metrics.samsDestroyed || 0} SAMs`);
    }
    if (mode === "destruction") {
      parts.push("multi-wave");
    } else if (mode === "sams") {
      parts.push("SAM waves");
    }

    return parts.join(" | ");
  }

  function getAutoNukeMetaSections(mode, metrics) {
    const byMode = {
      population: { population: true, economy: false, sams: false },
      economic: { population: false, economy: true, sams: false },
      destruction: { population: true, economy: true, sams: true },
      sams: { population: false, economy: false, sams: true },
    };
    const sections = byMode[mode] || byMode.population;
    return { ...sections, sams: sections.sams || metrics.samsDestroyed > 0 };
  }

  function enforceAutoNukeTierPlanOrder(entries) {
    const sortedEntries = entries
      .filter((entry) => entry.tierId)
      .sort((a, b) => getAutoNukeTierRank(a.tierId) - getAutoNukeTierRank(b.tierId));
    let strongestLowerPlan = null;

    for (const entry of sortedEntries) {
      const plan = entry.plan;
      const planShotCount = getAutoNukePlanShotCount(plan);
      const lowerShotCount = getAutoNukePlanShotCount(strongestLowerPlan);

      if (
        isUsableAutoNukeTierEntry(entry) &&
        strongestLowerPlan &&
        planShotCount < lowerShotCount
      ) {
        entry.plan = strongestLowerPlan;
      }

      if (isUsableAutoNukeTierEntry(entry)) {
        const entryShotCount = getAutoNukePlanShotCount(entry.plan);
        const currentBestShotCount = getAutoNukePlanShotCount(strongestLowerPlan);
        if (!strongestLowerPlan || entryShotCount >= currentBestShotCount) {
          strongestLowerPlan = entry.plan;
        }
      }
    }
  }

  function getAutoNukePlanShotCount(plan) {
    return plan?.metrics?.shotCount || plan?.shots?.length || 0;
  }

  function isUsableAutoNukeTierEntry(entry) {
    return !entry.reason && Boolean(entry.plan?.shots?.length);
  }

  function renderAutoNukeButton(button, mode, tierId, plan, reason = "") {
    const tier = getAutoNukeTierById(tierId);
    const label = document.createElement("span");
    label.className = "openfront-helper-auto-nuke-label";
    label.textContent = mode === "sams"
      ? getAutoNukeModeLabel(mode)
      : `${getAutoNukeModeLabel(mode)} - ${tier.label}`;

    const meta = document.createElement("span");
    meta.className = "openfront-helper-auto-nuke-meta";

    if (reason) {
      button.disabled = true;
      button.title = reason;
      meta.textContent = reason;
    } else if (!plan?.shots?.length || plan.score <= 0) {
      const emptyReason = "No valid plan.";
      button.disabled = true;
      button.title = emptyReason;
      meta.textContent = emptyReason;
    } else {
      const metaText = formatAutoNukePlanMeta(mode, plan);
      button.disabled = false;
      button.title = metaText;
      meta.textContent = metaText;
    }

    button.replaceChildren(label, meta);
  }

  function renderAutoNukeLoadingButton(button, mode, tierId) {
    const tier = tierId ? getAutoNukeTierById(tierId) : null;
    const label = document.createElement("span");
    label.className = "openfront-helper-auto-nuke-label";
    label.textContent = mode === "sams"
      ? getAutoNukeModeLabel(mode)
      : `${getAutoNukeModeLabel(mode)} - ${tier?.label || "High"}`;

    const meta = document.createElement("span");
    meta.className = "openfront-helper-auto-nuke-meta";
    meta.textContent = "Calculating...";

    button.disabled = true;
    button.title = "Calculating auto nuke plan";
    button.replaceChildren(label, meta);
  }

  function renderAutoNukeExpandButton(button, reason = "") {
    const label = document.createElement("span");
    label.className = "openfront-helper-auto-nuke-label";
    label.textContent = "Auto nuke";

    const meta = document.createElement("span");
    meta.className = "openfront-helper-auto-nuke-meta";
    meta.textContent = reason || "Show auto nuke options";

    button.disabled = Boolean(reason);
    button.title = reason || "Calculate auto nuke plans";
    button.replaceChildren(label, meta);
  }

  function renderAutoNukeBranchButton(button, mode, disabledReason = "") {
    const modeLabels = {
      economic: "Economy",
      population: "Population",
      sams: "SAMs",
      destruction: "Total destruction",
    };
    const label = document.createElement("span");
    label.className = "openfront-helper-auto-nuke-label";
    label.textContent = modeLabels[mode] || getAutoNukeModeLabel(mode);

    const meta = document.createElement("span");
    meta.className = "openfront-helper-auto-nuke-meta";
    meta.textContent = disabledReason || "Show options →";

    button.disabled = Boolean(disabledReason);
    button.title = disabledReason || modeLabels[mode] || mode;
    button.replaceChildren(label, meta);
  }

  function waitForAutoNukeMenuFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      });
    });
  }

  function isAutoNukeMenuComputeActive(menu, params, computeId) {
    return (
      autoNukeContextMenuComputeId === computeId &&
      autoNukeContextMenuParams === params &&
      !menu.hidden
    );
  }

  function setAutoNukeMenuLoading(menu, visible, progress = 0, text = "") {
    const loading = menu.querySelector("[data-auto-nuke-loading]");
    const fill = menu.querySelector("[data-auto-nuke-loading-fill]");
    const textElement = menu.querySelector("[data-auto-nuke-loading-text]");
    if (loading instanceof HTMLElement) {
      loading.hidden = !visible;
    }
    if (fill instanceof HTMLElement) {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    }
    if (textElement instanceof HTMLElement) {
      textElement.textContent = text;
    }
  }

  function initAutoNukeMenuLoadingSteps(menu, stepLabels) {
    const list = menu.querySelector("[data-auto-nuke-steps]");
    if (!(list instanceof HTMLElement)) return;
    list.innerHTML = stepLabels
      .map((label) => `<li>${label}</li>`)
      .join("");
  }

  function markAutoNukeMenuLoadingStepDone(menu, index) {
    const list = menu.querySelector("[data-auto-nuke-steps]");
    if (!(list instanceof HTMLElement)) return;
    const item = list.children[index];
    if (item instanceof HTMLElement) {
      item.setAttribute("data-done", "");
    }
  }

  function setAutoNukeModeButtonsHidden(menu, hidden) {
    for (const button of menu.querySelectorAll("[data-auto-nuke-mode]")) {
      if (button instanceof HTMLButtonElement) {
        button.hidden = hidden;
      }
    }
  }

  function setAutoNukeSectionLabelsHidden(menu, hidden) {
    for (const section of menu.querySelectorAll("[data-auto-nuke-section-label]")) {
      if (section instanceof HTMLElement) {
        section.hidden = hidden;
      }
    }
  }

  function setAutoNukeBranchButtonsHidden(menu, hidden) {
    for (const button of menu.querySelectorAll("[data-auto-nuke-branch]")) {
      if (button instanceof HTMLButtonElement) {
        button.hidden = hidden;
      }
    }
  }

  function goBackToAutoNukeBranchMenu(menu) {
    autoNukeContextMenuComputeId++;
    const params = autoNukeContextMenuParams;
    if (!params) {
      return;
    }

    const backButton = menu.querySelector("[data-auto-nuke-back]");
    if (backButton instanceof HTMLButtonElement) {
      backButton.hidden = true;
    }
    setAutoNukeMenuLoading(menu, false);
    setAutoNukeSectionLabelsHidden(menu, true);
    setAutoNukeModeButtonsHidden(menu, true);

    const buildSiloButton = menu.querySelector("[data-auto-nuke-build-silo]");
    if (buildSiloButton instanceof HTMLButtonElement) {
      buildSiloButton.hidden = true;
    }

    const reason = getAutoNukeContextMenuDisableReason(params);
    for (const button of menu.querySelectorAll("[data-auto-nuke-branch]")) {
      if (button instanceof HTMLButtonElement) {
        button.hidden = false;
        renderAutoNukeBranchButton(button, button.dataset.autoNukeBranch, reason);
      }
    }

    positionAutoNukeContextMenu(
      menu,
      Number.parseFloat(menu.style.left) || 6,
      Number.parseFloat(menu.style.top) || 6,
    );
  }

  function expandAutoNukeContextMenu(menu) {
    const params = autoNukeContextMenuParams;
    if (!params) {
      return;
    }

    const expandButton = menu.querySelector("[data-auto-nuke-expand]");
    if (expandButton instanceof HTMLButtonElement) {
      expandButton.hidden = true;
    }
    const buildSiloButton = menu.querySelector("[data-auto-nuke-build-silo]");
    if (buildSiloButton instanceof HTMLButtonElement) {
      buildSiloButton.hidden = true;
    }

    const reason = getAutoNukeContextMenuDisableReason(params);
    params.autoNukePlans = {};

    for (const button of menu.querySelectorAll("[data-auto-nuke-branch]")) {
      if (button instanceof HTMLButtonElement) {
        button.hidden = false;
        renderAutoNukeBranchButton(button, button.dataset.autoNukeBranch, reason);
      }
    }

    positionAutoNukeContextMenu(
      menu,
      Number.parseFloat(menu.style.left) || 6,
      Number.parseFloat(menu.style.top) || 6,
    );
  }

  function prepareAutoNukeModeDetails(menu, mode) {
    setAutoNukeBranchButtonsHidden(menu, true);
    setAutoNukeSectionLabelsHidden(menu, true);
    setAutoNukeModeButtonsHidden(menu, true);

    const backButton = menu.querySelector("[data-auto-nuke-back]");
    if (backButton instanceof HTMLButtonElement) {
      backButton.hidden = false;
      backButton.textContent = "← Back";
    }

    const sectionLabel = menu.querySelector(`[data-auto-nuke-section-label="${mode}"]`);
    if (sectionLabel instanceof HTMLElement) sectionLabel.hidden = false;

    const modeButtons = Array.from(
      menu.querySelectorAll(`[data-auto-nuke-mode="${mode}"]`),
    ).filter((button) => button instanceof HTMLButtonElement);
    for (const button of modeButtons) {
      button.hidden = false;
      renderAutoNukeLoadingButton(button, mode, button.dataset.autoNukeTier);
    }
    return modeButtons;
  }

  function startAutoNukeModeLoading(menu, mode, modeButtons) {
    setAutoNukeMenuLoading(menu, true, 0.02, `Calculating ${getAutoNukeModeLabel(mode)}...`);
    initAutoNukeMenuLoadingSteps(menu, [
      "Computing targets",
      ...modeButtons.map((button) => {
        const tier = getAutoNukeTierById(button.dataset.autoNukeTier);
        return tier ? `${tier.label} intensity` : "Calculating plan";
      }),
    ]);
    positionAutoNukeContextMenu(
      menu,
      Number.parseFloat(menu.style.left) || 6,
      Number.parseFloat(menu.style.top) || 6,
    );
  }

  function renderDisabledAutoNukeMode(menu, params, mode, modeButtons, reason) {
    for (const button of modeButtons) {
      renderAutoNukeButton(button, mode, button.dataset.autoNukeTier, null, reason);
    }
    const buildSiloButton = menu.querySelector("[data-auto-nuke-build-silo]");
    if (
      buildSiloButton instanceof HTMLButtonElement &&
      isAutoNukeSiloShortageReason(reason) &&
      params.buildMenu?.sendBuildOrUpgrade
    ) {
      buildSiloButton.hidden = false;
      renderAutoNukeBuildSiloButton(buildSiloButton, params);
    }
    setAutoNukeMenuLoading(menu, false);
    positionAutoNukeContextMenu(
      menu,
      Number.parseFloat(menu.style.left) || 6,
      Number.parseFloat(menu.style.top) || 6,
    );
  }

  async function computeAutoNukeModeEntries(request) {
    const { menu, params, mode, modeButtons, candidatePool, computeId } = request;
    const entries = [];
    let stepIndex = 1;
    for (const button of modeButtons) {
      const tierId = button.dataset.autoNukeTier;
      const tierOptions = getAutoNukeTierPlanOptions(params, tierId);
      const plan = tierOptions.reason
        ? null
        : buildAutoNukePlanForMode(
          params.game,
          params.selected,
          mode,
          getAutoNukeBuildPlanOptions(mode, tierOptions),
          candidatePool,
        );
      entries.push({ button, mode, tierId, plan, reason: tierOptions.reason });
      markAutoNukeMenuLoadingStepDone(menu, stepIndex++);
      await waitForAutoNukeMenuFrame();
      if (!isAutoNukeMenuComputeActive(menu, params, computeId)) return null;
    }
    return entries;
  }

  function renderAutoNukeModeEntries(menu, params, mode, entries, totalSteps) {
    let completedSteps = 1;
    enforceAutoNukeTierPlanOrder(entries);
    for (const entry of entries) {
      const planKey = getAutoNukePlanKey(entry.mode, entry.tierId);
      if (entry.plan) params.autoNukePlans[planKey] = entry.plan;
      const buttonReason = entry.reason ||
        (!entry.plan?.shots?.length || entry.plan.score <= 0
          ? getAutoNukePlanFailureReason(params, entry.plan)
          : "");
      entry.displayReason = buttonReason;
      renderAutoNukeButton(entry.button, entry.mode, entry.tierId, entry.plan, buttonReason);
      completedSteps++;
      setAutoNukeMenuLoading(
        menu,
        true,
        completedSteps / Math.max(1, totalSteps),
        `Calculated ${getAutoNukeModeLabel(mode)}`,
      );
    }
  }

  function updateAutoNukeBuildSiloOffer(menu, params, entries) {
    const button = menu.querySelector("[data-auto-nuke-build-silo]");
    if (!(button instanceof HTMLButtonElement)) return;
    const allSiloBlocked = entries.length > 0 &&
      entries.every((entry) =>
        isAutoNukeSiloShortageReason(entry.displayReason || entry.reason),
      );
    const canOfferBuild = allSiloBlocked && Boolean(params.buildMenu?.sendBuildOrUpgrade);
    button.hidden = !canOfferBuild;
    if (canOfferBuild) renderAutoNukeBuildSiloButton(button, params);
  }

  async function expandAutoNukeModeDetails(menu, mode) {
    const params = autoNukeContextMenuParams;
    if (!params) return;
    const computeId = ++autoNukeContextMenuComputeId;
    const modeButtons = prepareAutoNukeModeDetails(menu, mode);
    const totalSteps = 1 + modeButtons.length;
    startAutoNukeModeLoading(menu, mode, modeButtons);

    await waitForAutoNukeMenuFrame();
    if (!isAutoNukeMenuComputeActive(menu, params, computeId)) return;

    const reason = getAutoNukeContextMenuDisableReason(params);
    if (reason) {
      renderDisabledAutoNukeMode(menu, params, mode, modeButtons, reason);
      return;
    }

    const candidatePool = computeAutoNukeCandidatePool(params.game, params.selected, mode);
    markAutoNukeMenuLoadingStepDone(menu, 0);
    setAutoNukeMenuLoading(
      menu,
      true,
      1 / Math.max(1, totalSteps),
      `Calculating ${getAutoNukeModeLabel(mode)}...`,
    );

    await waitForAutoNukeMenuFrame();
    if (!isAutoNukeMenuComputeActive(menu, params, computeId)) return;

    const entries = await computeAutoNukeModeEntries({
      menu,
      params,
      mode,
      modeButtons,
      candidatePool,
      computeId,
    });
    if (!entries || !isAutoNukeMenuComputeActive(menu, params, computeId)) return;

    renderAutoNukeModeEntries(menu, params, mode, entries, totalSteps);
    if (!isAutoNukeMenuComputeActive(menu, params, computeId)) return;
    updateAutoNukeBuildSiloOffer(menu, params, entries);
    setAutoNukeMenuLoading(menu, false);
    positionAutoNukeContextMenu(
      menu,
      Number.parseFloat(menu.style.left) || 6,
      Number.parseFloat(menu.style.top) || 6,
    );
  }
  function positionAutoNukeContextMenu(menu, x, y) {
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";

    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(6, x), window.innerWidth - rect.width - 6);
    const top = Math.min(Math.max(6, y), window.innerHeight - rect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function showAutoNukeContextMenu(x, y, params) {
    const menu = ensureAutoNukeContextMenu();
    autoNukeContextMenuParams = params;

    const reason = getAutoNukeContextMenuDisableReason(params);
    params.autoNukePlans = {};
    const expandButton = menu.querySelector("[data-auto-nuke-expand]");
    if (expandButton instanceof HTMLButtonElement) {
      expandButton.hidden = false;
      renderAutoNukeExpandButton(expandButton, reason);
    }
    const buildSiloButton = menu.querySelector("[data-auto-nuke-build-silo]");
    if (buildSiloButton instanceof HTMLButtonElement) {
      const canOfferBuild = isAutoNukeSiloShortageReason(reason) &&
        Boolean(params?.buildMenu?.sendBuildOrUpgrade);
      if (canOfferBuild) {
        buildSiloButton.hidden = false;
        renderAutoNukeBuildSiloButton(buildSiloButton, params);
      } else {
        buildSiloButton.hidden = true;
      }
    }
    setAutoNukeModeButtonsHidden(menu, true);
    setAutoNukeSectionLabelsHidden(menu, true);
    setAutoNukeBranchButtonsHidden(menu, true);
    const backBtn = menu.querySelector("[data-auto-nuke-back]");
    if (backBtn instanceof HTMLButtonElement) {
      backBtn.hidden = true;
    }

    positionAutoNukeContextMenu(menu, x, y);
  }

  function isAutoNukeSiloShortageReason(reason) {
    if (!reason) {
      return false;
    }
    return reason === "No missile silos built yet." ||
      /silo slot/i.test(reason) ||
      /missile silo/i.test(reason);
  }

  function renderAutoNukeBuildSiloButton(button, params, statusText = "") {
    button.disabled = false;
    button.title = "Stack missile silos on an existing one";
    button.textContent = statusText || "🏗 Build silos for me";
  }

  async function handleAutoNukeBuildSiloClick(menu, params, button) {
    if (!params?.myPlayer || !params?.buildMenu?.sendBuildOrUpgrade) {
      return;
    }
    button.disabled = true;
    button.textContent = "⏳ Building...";

    const builtCount = await autoBuildMissileSilo(params);

    if (builtCount > 0) {
      button.textContent = `✓ ${builtCount} silo${builtCount !== 1 ? "s" : ""} placed!`;
      setTimeout(() => {
        button.disabled = false;
        // Hide the button if there's no longer a silo shortage.
        const stillNeeded = isAutoNukeSiloShortageReason(
          getAutoNukeContextMenuDisableReason(params),
        );
        if (stillNeeded) {
          renderAutoNukeBuildSiloButton(button, params);
        } else {
          button.hidden = true;
        }
      }, 1500);
      return;
    }

    button.textContent = "✗ No valid tile";
    setTimeout(() => {
      if (autoNukeContextMenuParams === params) {
        button.disabled = false;
        renderAutoNukeBuildSiloButton(button, params);
      }
    }, 1800);
  }

  // Generous target for the "Build silos for me" one-click action: always try to
  // reach at least this many READY silo slots so the user has headroom for a
  // full auto-nuke assault without clicking repeatedly.
  const AUTO_NUKE_BUILD_SILO_TARGET = 12;
  // Absolute upper cap on silos queued in a single click.
  const AUTO_NUKE_BUILD_SILO_MAX_PER_CLICK = 20;

  // Returns how many silos were successfully queued (0 on failure).
  async function autoBuildMissileSilo(params) {
    const myPlayer = params.myPlayer;
    if (!myPlayer) return 0;

    // Determine how many silo slots are actually needed by checking:
    // 1. Plans that were computed but ran out of silo slots.
    // 2. Tier pre-checks that failed due to insufficient slots.
    // 3. A generous floor to give the user a comfortable nuke arsenal in one click.
    const availableSlots = getReadyNukeSiloSlotCount(myPlayer);
    const neededCount = getAutoNukeSilosNeeded(params, availableSlots);

    // Prefer stacking on existing missile silos (upgrade = +1 slot each).
    // Each silo can only receive one upgrade at a time, so iterate all of them.
    const uniqueTiles = getAutoNukeSiloCandidateTiles(myPlayer);
    if (uniqueTiles.length === 0) return 0;

    // If we need more stacks than available tiles, cycle through tiles again —
    // each upgrade on the SAME silo tile bumps the silo's level by 1 (one extra
    // missile slot each), so repeating the same tile is intentional and useful.
    const candidateTiles = cycleAutoNukeSiloCandidateTiles(uniqueTiles, neededCount);
    return buildAutoNukeSilos(params, candidateTiles, neededCount);
  }

  function getAutoNukeSilosNeeded(params, availableSlots) {
    let needed = 1;
    for (const plan of Object.values(params.autoNukePlans || {})) {
      if (!Number.isFinite(plan?.minimumRequiredSiloSlots)) continue;
      if (!Number.isFinite(plan?.budgetSiloSlots)) continue;
      needed = Math.max(
        needed,
        Math.ceil(plan.minimumRequiredSiloSlots - plan.budgetSiloSlots),
      );
    }
    for (const tier of AUTO_NUKE_INTENSITY_TIERS) {
      needed = Math.max(needed, tier.minShots - availableSlots);
    }
    needed = Math.max(needed, AUTO_NUKE_BUILD_SILO_TARGET - availableSlots);
    return Math.max(1, Math.min(needed, AUTO_NUKE_BUILD_SILO_MAX_PER_CLICK));
  }

  function getAutoNukeSiloCandidateTiles(player) {
    const siloTiles = getPlayerUnits(player, "Missile Silo").map(getUnitTile);
    const fallbackTiles = getPlayerUnits(
      player,
      ...NUKE_SUGGESTION_STRUCTURE_TYPES,
    ).map(getUnitTile);
    return Array.from(
      new Set(
        [...siloTiles, ...fallbackTiles].filter(
          (tile) => tile !== null && tile !== undefined,
        ),
      ),
    );
  }

  function cycleAutoNukeSiloCandidateTiles(tiles, neededCount) {
    const candidates = [];
    const maxCycles = Math.max(
      AUTO_NUKE_BUILD_SILO_MAX_PER_CLICK,
      tiles.length * 10,
    );
    for (let index = 0; candidates.length < neededCount && index <= maxCycles; index++) {
      candidates.push(tiles[index % tiles.length]);
    }
    return candidates;
  }

  async function buildAutoNukeSilos(params, tiles, neededCount) {
    let builtCount = 0;
    for (const tile of tiles) {
      if (builtCount >= neededCount) break;
      const buildable = await getBuildableMissileSilo(params.myPlayer, tile);
      if (!isPlaceableAutoNukeSilo(buildable)) continue;
      {
        params.buildMenu.sendBuildOrUpgrade(buildable, tile);
        builtCount++;
      }
    }
    return builtCount;
  }

  function isPlaceableAutoNukeSilo(buildable) {
    if (!buildable) return false;
    const canBuild = buildable.canBuild !== false && buildable.canBuild !== undefined;
    const canUpgrade =
      buildable.canUpgrade !== false && buildable.canUpgrade !== undefined;
    return canBuild || canUpgrade;
  }

  async function getBuildableMissileSilo(player, tile) {
    if (typeof player?.buildables === "function") {
      {
        const buildables = await player.buildables(tile, ["Missile Silo"]);
        const buildable = Array.from(buildables || []).find(
          (item) => item?.type === "Missile Silo",
        );
        if (buildable) return buildable;
      }
    }
    if (typeof player?.actions === "function") {
      {
        const actions = await player.actions(tile, ["Missile Silo"]);
        return Array.from(actions?.buildableUnits || []).find(
          (item) => item?.type === "Missile Silo",
        ) || null;
      }
    }
    return null;
  }

  function getAutoNukeRadialElement() {
    return document.querySelector("main-radial-menu");
  }

  function getAutoNukeBuildMenu(radialMenuElement) {
    return radialMenuElement?.buildMenu || document.querySelector("build-menu");
  }

  function getAutoNukeContextParamsFromEvent(event) {
    const radialMenuElement = getAutoNukeRadialElement();
    const { game, transform } = getAutoNukeRadialGameContext(radialMenuElement);
    const myPlayer = game?.myPlayer?.();
    const buildMenu = getAutoNukeBuildMenu(radialMenuElement);
    if (
      !game ||
      !transform?.screenToWorldCoordinates ||
      !myPlayer?.isPlayer?.() ||
      !buildMenu?.sendBuildOrUpgrade
    ) {
      return null;
    }

    const selection = getAutoNukeEventSelection(game, transform, event);
    if (selection === null) return null;

    return {
      myPlayer,
      selected: selection.selected,
      tile: selection.tile,
      playerActions: { buildableUnits: [] },
      game,
      buildMenu,
      closeMenu: hideAutoNukeContextMenu,
    };
  }

  function getAutoNukeRadialGameContext(radialMenuElement) {
    const fallback = runtimeState.lastOpenFrontGameContext || {};
    return {
      game: radialMenuElement?.game || fallback.game,
      transform:
        radialMenuElement?.transformHandler ||
        radialMenuElement?.transform ||
        fallback.transform,
    };
  }

  function getAutoNukeEventSelection(game, transform, event) {
    {
      const world = transform.screenToWorldCoordinates(event.clientX, event.clientY);
      if (!game.isValidCoord?.(world.x, world.y)) return null;
      const tile = game.ref(world.x, world.y);
      const owner = game.owner(tile);
      return owner?.isPlayer?.() ? { selected: owner, tile } : null;
    }
  }

  function handleAutoNukeContextMenu(event) {
    if (!runtimeState.autoNukeEnabled) {
      return;
    }

    const params = getAutoNukeContextParamsFromEvent(event);
    if (!params) {
      hideAutoNukeContextMenu();
      return;
    }

    // Offset BELOW the cursor so this does not overlap the Send-1%-Boat macro menu,
    // which renders ABOVE the cursor at the same x (both used clientY - 58 → collision).
    showAutoNukeContextMenu(event.clientX + 108, event.clientY + 16, params);
  }

  function handleAutoNukeDocumentPointerDown(event) {
    const menu = document.getElementById(AUTO_NUKE_CONTEXT_MENU_ID);
    if (!menu || menu.hidden || menu.contains(event.target)) {
      return;
    }
    hideAutoNukeContextMenu();
  }

  function handleAutoNukeDocumentKeyDown(event) {
    if (event.key === "Escape") {
      hideAutoNukeContextMenu();
    }
  }

  function installAutoNukeContextMenu() {
    if (autoNukeContextMenuInstalled) {
      return;
    }

    autoNukeContextMenuInstalled = true;
    document.addEventListener("contextmenu", handleAutoNukeContextMenu, true);
    document.addEventListener("pointerdown", handleAutoNukeDocumentPointerDown, true);
    document.addEventListener("keydown", handleAutoNukeDocumentKeyDown, true);
    window.addEventListener("blur", hideAutoNukeContextMenu);
    window.addEventListener("wheel", hideAutoNukeContextMenu, true);
  }

  function uninstallAutoNukeContextMenu() {
    if (!autoNukeContextMenuInstalled) {
      return;
    }

    autoNukeContextMenuInstalled = false;
    document.removeEventListener("contextmenu", handleAutoNukeContextMenu, true);
    document.removeEventListener("pointerdown", handleAutoNukeDocumentPointerDown, true);
    document.removeEventListener("keydown", handleAutoNukeDocumentKeyDown, true);
    window.removeEventListener("blur", hideAutoNukeContextMenu);
    window.removeEventListener("wheel", hideAutoNukeContextMenu, true);
    hideAutoNukeContextMenu();
  }

  function createAutoNukeMenuItem(mode, placement) {
    const isDestruction = mode === "destruction";
    const config = getAutoNukeMenuModeConfig(mode);
    return {
      id: `${AUTO_NUKE_MENU_ITEM_PREFIX}-${placement}-${mode}`,
      name: config.name,
      text: config.text,
      fontSize: "10px",
      color: config.color,
      tooltipItems: [
        {
          text: config.title,
          className: "title",
        },
        {
          text: config.description,
          className: "description",
        },
      ],
      disabled: isAutoNukeRadialItemDisabled,
      action: (params) =>
        executeAutoNuke(params, mode, isDestruction ? "high" : null),
    };
  }

  function getAutoNukeMenuModeConfig(mode) {
    const configs = {
      economic: {
        name: "auto econ nuke",
        text: "Auto Econ",
        color: "#16a34a",
        title: "Auto econ nuke",
        description: "Fires at the best valid economy suggestion.",
      },
      destruction: {
        name: "total destruction nuke",
        text: "Destroy",
        color: "#ca8a04",
        title: "Total destruction nuke",
        description:
          "Fires at combined population and economy damage, then retries once after silo cooldown.",
      },
      sams: {
        name: "destroy all sams",
        text: "SAMs",
        color: "#0284c7",
        title: "Destroy all SAMs",
        description:
          "Fires SAM-clear waves and stops before population or economy targets.",
      },
      population: {
        name: "auto population nuke",
        text: "Auto Pop",
        color: "#dc2626",
        title: "Auto population nuke",
        description: "Fires at the best valid population suggestion.",
      },
    };
    return configs[mode] || configs.population;
  }

  function createAutoNukeMenuItems(params, placement) {
    if (!isAutoNukeRadialTarget(params)) {
      return [];
    }

    return [
      createAutoNukeMenuItem("economic", placement),
      createAutoNukeMenuItem("population", placement),
      createAutoNukeMenuItem("sams", placement),
      createAutoNukeMenuItem("destruction", placement),
    ];
  }

  function menuItemsContainManualNukeActions(menuItems) {
    return menuItems.some((item) => {
      const itemText = String(item?.text || item?.name || item?.id || "");
      return /atom|hydrogen|mirv|nuke/i.test(itemText);
    });
  }

  function patchAutoNukeAttackMenuItem(menuItem) {
    if (
      !menuItem ||
      typeof menuItem.subMenu !== "function" ||
      autoNukeOriginalAttackSubMenus.has(menuItem)
    ) {
      return;
    }

    const originalSubMenu = menuItem.subMenu;
    menuItem.subMenu = function openFrontHelperAutoNukeAttackSubMenu(params) {
      const menuItems = Array.from(originalSubMenu.call(this, params) || []);
      if (!runtimeState.autoNukeEnabled || !menuItemsContainManualNukeActions(menuItems)) {
        return menuItems;
      }

      const existingIds = new Set(menuItems.map((item) => String(item?.id || "")));
      const autoNukeItems = createAutoNukeMenuItems(params, "attack").filter(
        (item) => !existingIds.has(item.id),
      );
      return autoNukeItems.length > 0
        ? [...menuItems, ...autoNukeItems]
        : menuItems;
    };

    autoNukeOriginalAttackSubMenus.set(menuItem, originalSubMenu);
  }

  function patchAutoNukeAttackSubMenus(menuItems) {
    for (const menuItem of menuItems) {
      if (typeof menuItem?.subMenu !== "function") {
        continue;
      }

      const menuText = String(menuItem?.id || menuItem?.name || menuItem?.text || "");
      if (/attack/i.test(menuText)) {
        patchAutoNukeAttackMenuItem(menuItem);
      }
    }
  }

  function getAutoNukeRadialRootMenu() {
    const radialMenuElement = document.querySelector("main-radial-menu");
    return radialMenuElement?.radialMenu?.rootMenu || null;
  }

  function patchAutoNukeRootMenu(rootMenu) {
    if (
      !rootMenu ||
      typeof rootMenu.subMenu !== "function" ||
      autoNukeOriginalRootSubMenus.has(rootMenu)
    ) {
      return false;
    }

    const originalSubMenu = rootMenu.subMenu;
    rootMenu.subMenu = function openFrontHelperAutoNukeRootSubMenu(params) {
      const menuItems = Array.from(originalSubMenu.call(this, params) || []);
      patchAutoNukeAttackSubMenus(menuItems);
      if (!runtimeState.autoNukeEnabled) {
        return menuItems;
      }

      const existingIds = new Set(menuItems.map((item) => String(item?.id || "")));
      const autoNukeItems = createAutoNukeMenuItems(params, "root").filter(
        (item) => !existingIds.has(item.id),
      );
      return autoNukeItems.length > 0
        ? [...menuItems, ...autoNukeItems]
        : menuItems;
    };

    autoNukeOriginalRootSubMenus.set(rootMenu, originalSubMenu);
    return true;
  }

  function restoreAutoNukeRootMenus() {
    for (const [menuItem, originalSubMenu] of autoNukeOriginalAttackSubMenus) {
      if (menuItem?.subMenu) {
        menuItem.subMenu = originalSubMenu;
      }
    }
    autoNukeOriginalAttackSubMenus.clear();

    for (const [rootMenu, originalSubMenu] of autoNukeOriginalRootSubMenus) {
      if (rootMenu?.subMenu) {
        rootMenu.subMenu = originalSubMenu;
      }
    }
    autoNukeOriginalRootSubMenus.clear();
  }

  function scheduleAutoNukePatchRetry() {
    if (!runtimeState.autoNukeEnabled || runtimeState.autoNukePatchTimeout !== null) {
      return;
    }

    runtimeState.autoNukePatchTimeout = window.setTimeout(() => {
      runtimeState.autoNukePatchTimeout = null;
      syncAutoNukeRadialMenuPatch();
    }, AUTO_NUKE_PATCH_RETRY_MS);
  }

  function syncAutoNukeRadialMenuPatch() {
    if (!runtimeState.autoNukeEnabled) {
      restoreAutoNukeRootMenus();
      return;
    }

    const rootMenu = getAutoNukeRadialRootMenu();
    if (!rootMenu) {
      scheduleAutoNukePatchRetry();
      return;
    }

    patchAutoNukeRootMenu(rootMenu);
    scheduleAutoNukePatchRetry();
  }

  function setAutoNukeEnabled(enabled, includeAllies = false) {
    runtimeState.autoNukeEnabled = Boolean(enabled);
    autoNukeIncludeAllies = Boolean(includeAllies);
    if (runtimeState.autoNukePatchTimeout !== null) {
      window.clearTimeout(runtimeState.autoNukePatchTimeout);
      runtimeState.autoNukePatchTimeout = null;
    }

    restoreAutoNukeRootMenus();
    if (!runtimeState.autoNukeEnabled) {
      uninstallAutoNukeContextMenu();
      return;
    }

    installAutoNukeContextMenu();
  }

  function syncNukeSuggestions() {
    if (!runtimeState.nukeSuggestionsEnabled) {
      document.getElementById(NUKE_SUGGESTION_CONTAINER_ID)?.remove();
      runtimeState.nukeSuggestionAnimationFrame = null;
      clearNukeSuggestionState();
      return;
    }

    nukeSuggestionFrameCounter = (nukeSuggestionFrameCounter + 1) % 3;
    if (nukeSuggestionFrameCounter !== 0) {
      runtimeState.nukeSuggestionAnimationFrame = requestAnimationFrame(syncNukeSuggestions);
      return;
    }

    const container = ensureNukeSuggestionContainer();
    const overlay = getHoveredPlayerInfoOverlay();
    const game = overlay?.game;
    const transform = overlay?.transform;
    const targetPlayer = overlay?.player;

    if (!isValidNukeSuggestionOverlay(game, transform, targetPlayer)) {
      clearNukeSuggestionState(container);
      runtimeState.nukeSuggestionAnimationFrame = requestAnimationFrame(syncNukeSuggestions);
      return;
    }

    refreshNukeSuggestionsIfNeeded(game, targetPlayer, performance.now());

    renderNukeSuggestions(container, game, transform, runtimeState.currentNukeSuggestionResults);
    runtimeState.nukeSuggestionAnimationFrame = requestAnimationFrame(syncNukeSuggestions);
  }

  function isValidNukeSuggestionOverlay(game, transform, targetPlayer) {
    if (!game || !transform || targetPlayer?.isPlayer?.() !== true) return false;
    return isEnemyNukeSuggestionTarget(game, targetPlayer);
  }

  function refreshNukeSuggestionsIfNeeded(game, targetPlayer, now) {
    if (
      now - runtimeState.lastNukeSuggestionSignatureCheckAt <
      NUKE_SUGGESTION_SIGNATURE_CHECK_MS
    ) return;
    runtimeState.lastNukeSuggestionSignatureCheckAt = now;
    const signature = getNukeSuggestionSignature(game, targetPlayer);
    const signatureChanged = signature !== runtimeState.lastNukeSuggestionSignature;
    const expired =
      now - runtimeState.lastNukeSuggestionComputedAt >= NUKE_SUGGESTION_REFRESH_MS;
    if (!signatureChanged && !expired) return;
    runtimeState.currentNukeSuggestionResults = computeNukeSuggestions(
      game,
      targetPlayer,
    );
    runtimeState.lastNukeSuggestionSignature = signature;
    runtimeState.lastNukeSuggestionComputedAt = now;
  }

  function setNukeSuggestionsEnabled(enabled) {
    runtimeState.nukeSuggestionsEnabled = Boolean(enabled);
    nukeSuggestionFrameCounter = 2;
    if (!runtimeState.nukeSuggestionsEnabled) {
      if (runtimeState.nukeSuggestionAnimationFrame !== null) {
        cancelAnimationFrame(runtimeState.nukeSuggestionAnimationFrame);
      }
      runtimeState.nukeSuggestionAnimationFrame = null;
      document.getElementById(NUKE_SUGGESTION_CONTAINER_ID)?.remove();
      clearNukeSuggestionState();
      return;
    }

    if (runtimeState.nukeSuggestionAnimationFrame === null) {
      syncNukeSuggestions();
    }
  }
  async function launchAutoNukeStandardFlow(request) {
    const { params, mode, plan, launchedCount } = request;
    let { waveNumber, latestImpactAtMs } = request;
    let followupWaveState = plan.followupState;

    const preemptiveResult = await launchAutoNukePreemptiveSamWaves({
      params,
      mode,
      initialPlan: plan,
      followupWaveState,
      waveNumber,
      latestImpactAtMs,
    });
    ({ followupWaveState, waveNumber, latestImpactAtMs } = preemptiveResult);

    let followupWaveNumber = waveNumber + 1;
    let followupWavesLaunched = 0;
    while (followupWavesLaunched < AUTO_NUKE_MAX_FOLLOWUP_WAVES) {
      if (!canContinueAutoNukeSecondPass(params)) {
        break;
      }
      const followupPhaseLabel = getAutoNukePhaseShortLabel(mode, mode);
      const followupLogIdx = pushAutoNukeWaveEntry(
        `Wave ${followupWaveNumber} — ${followupPhaseLabel}`,
        "active",
      );
      const followupWavePlan = await waitForAutoNukeWavePlan(
        params,
        mode,
        followupWaveState,
        {
          spreadMultiplier: AUTO_NUKE_FOLLOWUP_SPREAD_MULTIPLIER,
          readySlotFraction: AUTO_NUKE_SECOND_PASS_READY_SLOT_FRACTION,
          launchSlotFraction: AUTO_NUKE_SECOND_PASS_LAUNCH_SLOT_FRACTION,
          confirmationShots: 0,
        },
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: followupWaveNumber, phase: mode, detail: `Targeting follow-up — wave ${followupWaveNumber}` }),
      );
      if (!followupWavePlan) {
        completeAutoNukeWaveEntry(followupLogIdx);
        break;
      }
      const followupWaveLaunched = await launchAutoNukePlan(
        params,
        followupWavePlan,
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: followupWaveNumber, phase: mode, detail: `Firing ${followupWavePlan.shots.length} nukes` }),
      );
      completeAutoNukeWaveEntry(followupLogIdx);
      if (followupWaveLaunched === 0) {
        break;
      }
      latestImpactAtMs = Math.max(
        latestImpactAtMs,
        followupWavePlan.estimatedImpactAtMs || 0,
      );
      followupWaveState = followupWavePlan.followupState;
      followupWavesLaunched++;
      followupWaveNumber++;
    }
    const finalWaveNumber = followupWavesLaunched > 0
      ? followupWaveNumber - 1
      : waveNumber;
    updateAutoNukeProcessPanel(
      getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: finalWaveNumber, phase: mode, detail: followupWavesLaunched > 0
          ? `Complete — ${1 + followupWavesLaunched} waves`
          : `Complete — ${launchedCount} nukes`, extra: { progress: 1 } }),
    );
    hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs);
  }
  async function launchAutoNukeDestructionSamWaves(request) {
    const { params, mode, plan } = request;
    let { currentState, waveNumber, latestImpactAtMs } = request;
    let waveCount = plan.destructionPhase === "sams" ? 1 : 0;
    while (waveCount > 0 && waveCount < AUTO_NUKE_MAX_SAM_CLEAR_WAVES) {
      const logIndex = pushAutoNukeWaveEntry(`Wave ${waveNumber} — SAM clear`, "active");
      const wavePlan = await waitForAutoNukeWavePlan(
        params,
        mode,
        currentState,
        {
          destructionPhase: "sams",
          spreadMultiplier: 1,
          readySlotFraction: AUTO_NUKE_SECOND_PASS_READY_SLOT_FRACTION,
          launchSlotFraction: 1,
          confirmationShots: 0,
        },
        getAutoNukeProcessWaveStatus(params, {
          mode,
          waveNumber,
          phase: "sams",
          detail: "Clearing SAM stacks…",
        }),
      );
      if (!wavePlan) {
        completeAutoNukeWaveEntry(logIndex);
        break;
      }
      const launched = await launchAutoNukePlan(
        params,
        wavePlan,
        getAutoNukeProcessWaveStatus(params, {
          mode,
          waveNumber,
          phase: "sams",
          detail: `Firing ${wavePlan.shots.length} SAM-clear nukes`,
        }),
      );
      completeAutoNukeWaveEntry(logIndex);
      if (launched === 0) {
        runtimeDebugLog("OpenFront Helper: total destruction SAM pass could not be launched.");
        updateAutoNukeProcessPanel(
          getAutoNukeProcessWaveStatus(params, {
            mode,
            waveNumber,
            phase: "sams",
            detail: "SAM clear failed",
            extra: { progress: 1 },
          }),
        );
        hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs);
        return { aborted: true, currentState, waveNumber, latestImpactAtMs };
      }
      latestImpactAtMs = Math.max(latestImpactAtMs, wavePlan.estimatedImpactAtMs || 0);
      currentState = wavePlan.followupState;
      waveCount++;
      waveNumber++;
    }
    return { aborted: false, currentState, waveNumber, latestImpactAtMs };
  }

  async function launchAutoNukeDestructionFlow(request) {
    const { params, mode, plan, isSamOnlyMode } = request;
    let { waveNumber, latestImpactAtMs } = request;
    waveNumber++;

    const samResult = await launchAutoNukeDestructionSamWaves({
      params,
      mode,
      plan,
      currentState: plan.followupState,
      waveNumber,
      latestImpactAtMs,
    });
    if (samResult.aborted) return;
    const currentState = samResult.currentState;
    ({ waveNumber, latestImpactAtMs } = samResult);

    if (isSamOnlyMode) {
      updateAutoNukeProcessPanel(
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: Math.max(1, waveNumber - 1), phase: "sams", detail: "All SAMs neutralized", extra: { progress: 1 } }),
      );
      hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs);
      return;
    }

    // Mark "Building strike" pre-populated entry active (or add if missing).
    const bldgLogIdx = pushAutoNukeWaveEntry(`Wave ${waveNumber} — Building strike`, "active");
    const secondWavePlan = await waitForAutoNukeWavePlan(
      params,
      mode,
      currentState,
      {
        destructionPhase: "buildings",
        spreadMultiplier: AUTO_NUKE_SECOND_PASS_SPREAD_MULTIPLIER,
        readySlotFraction: AUTO_NUKE_SECOND_PASS_READY_SLOT_FRACTION,
        launchSlotFraction: AUTO_NUKE_SECOND_PASS_LAUNCH_SLOT_FRACTION,
        confirmationShots: AUTO_NUKE_DESTRUCTION_CONFIRMATION_SHOTS,
      },
      getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: "buildings", detail: "Identifying key buildings…" }),
    );
    if (!secondWavePlan) {
      completeAutoNukeWaveEntry(bldgLogIdx);
      updateAutoNukeProcessPanel(
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: Math.max(1, waveNumber - 1), phase: "sams", detail: "No buildings found", extra: { progress: 1 } }),
      );
      hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs);
      return;
    }

    const secondWaveLaunchedCount = await launchAutoNukePlan(
      params,
      secondWavePlan,
      getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: "buildings", detail: `Firing ${secondWavePlan.shots.length} nukes` }),
    );
    completeAutoNukeWaveEntry(bldgLogIdx);
    if (secondWaveLaunchedCount === 0) {
      runtimeDebugLog("OpenFront Helper: total destruction second pass could not be launched.");
      updateAutoNukeProcessPanel(
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: "buildings", detail: "Building strike failed", extra: { progress: 1 } }),
      );
      hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs);
      return;
    }
    latestImpactAtMs = Math.max(
      latestImpactAtMs,
      secondWavePlan.estimatedImpactAtMs || 0,
    );
    waveNumber++;

    // Continue firing "remote" cleanup waves until no targets remain or wave cap hit.
    let remoteState = secondWavePlan.followupState;
    let remoteWaveCount = 0;
    const maxRemoteWaves = AUTO_NUKE_MAX_DESTRUCTION_WAVES - waveNumber + 1;
    while (remoteWaveCount < maxRemoteWaves) {
      if (!canContinueAutoNukeSecondPass(params)) {
        break;
      }
      const remoteWaveLabel = remoteWaveCount === 0
        ? `Wave ${waveNumber} — Cleanup`
        : `Wave ${waveNumber} — Cleanup ${remoteWaveCount + 1}`;
      const remoteLogIdx = pushAutoNukeWaveEntry(remoteWaveLabel, "active");
      const remoteSpread = AUTO_NUKE_THIRD_PASS_SPREAD_MULTIPLIER +
        remoteWaveCount * 0.4;
      const remoteWavePlan = await waitForAutoNukeWavePlan(
        params,
        mode,
        remoteState,
        {
          destructionPhase: "remote",
          spreadMultiplier: remoteSpread,
          readySlotFraction: 0.45,
          launchSlotFraction: 1,
          confirmationShots: 0,
        },
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: "remote", detail: remoteWaveCount === 0
            ? "Mopping up remaining targets…"
            : `Cleanup wave ${remoteWaveCount + 1}` }),
      );
      if (!remoteWavePlan) {
        completeAutoNukeWaveEntry(remoteLogIdx);
        break;
      }

      const remoteWaveLaunched = await launchAutoNukePlan(
        params,
        remoteWavePlan,
        getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: waveNumber, phase: "remote", detail: `Firing ${remoteWavePlan.shots.length} nukes` }),
      );
      completeAutoNukeWaveEntry(remoteLogIdx);
      if (remoteWaveLaunched === 0) {
        break;
      }
      latestImpactAtMs = Math.max(
        latestImpactAtMs,
        remoteWavePlan.estimatedImpactAtMs || 0,
      );
      remoteState = remoteWavePlan.followupState;
      remoteWaveCount++;
      waveNumber++;
    }

    updateAutoNukeProcessPanel(
      getAutoNukeProcessWaveStatus(params, { mode: mode, waveNumber: Math.max(1, waveNumber - 1), phase: "remote", detail: `Mission complete — ${waveNumber - 1} waves`, extra: { progress: 1 } }),
    );
    hideAutoNukeProcessPanelAfterLanding(latestImpactAtMs);
  }
  const AUTO_NUKE_PROCESS_PANEL_CSS = `
      #${AUTO_NUKE_PROCESS_PANEL_ID} {
        position: fixed;
        right: 14px;
        top: calc(50% + 118px);
        z-index: 9000;
        width: min(320px, calc(100vw - 28px));
        padding: 10px;
        border: 1px solid rgba(56, 189, 248, 0.46);
        border-radius: 8px;
        background: rgba(13, 18, 24, 0.97);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.44);
        color: #f8fafc;
        font: 800 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        transform: translateY(-50%);
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID}[hidden] {
        display: none;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-top {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 5px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-wave {
        color: #bae6fd;
        font-size: 12px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-target {
        color: #94a3b8;
        font-size: 11px;
        max-width: 128px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: right;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-objective {
        color: #e2e8f0;
        font-size: 11px;
        margin-bottom: 7px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-track {
        height: 7px;
        overflow: hidden;
        border-radius: 6px;
        background: rgba(51, 65, 85, 0.92);
        margin-bottom: 7px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-fill {
        width: 0%;
        height: 100%;
        border-radius: 6px;
        background: linear-gradient(90deg, #38bdf8, #facc15);
        transition: width 140ms linear;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID}.openfront-helper-auto-nuke-process-waiting .openfront-helper-auto-nuke-process-fill {
        width: 38%;
        animation: openfront-helper-auto-nuke-process-wait 1.2s ease-in-out infinite alternate;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-detail {
        color: #cbd5e1;
        font-size: 11px;
        font-weight: 750;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-steps {
        list-style: none;
        margin: 6px 0 0;
        padding: 0;
        max-height: 120px;
        overflow-y: auto;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-waves {
        margin: 0 0 8px;
        padding: 0;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-waves:empty {
        display: none;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-summary {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 6px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-summary-label {
        font-size: 11px;
        font-weight: 600;
        color: #e2e8f0;
        letter-spacing: 0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 72%;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-summary-count {
        font-size: 10px;
        font-weight: 500;
        color: #64748b;
        white-space: nowrap;
        flex-shrink: 0;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-track {
        display: flex;
        align-items: center;
        gap: 0;
        flex-wrap: wrap;
        row-gap: 4px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-connector {
        flex: 1;
        min-width: 6px;
        max-width: 18px;
        height: 1px;
        background: #334155;
        border-radius: 1px;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-dot {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        font-size: 8px;
        font-weight: 700;
        background: #1e293b;
        color: #475569;
        border: 1.5px solid #334155;
        flex-shrink: 0;
        transition: background 200ms, border-color 200ms, color 200ms, box-shadow 200ms;
        cursor: default;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-dot--done {
        background: #14532d;
        border-color: #22c55e;
        color: #4ade80;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .wave-dot--active {
        background: #0c4a6e;
        border-color: #38bdf8;
        color: #7dd3fc;
        box-shadow: 0 0 6px 1px rgba(56, 189, 248, 0.35);
        animation: wave-dot-pulse 1.4s ease-in-out infinite;
      }

      @keyframes wave-dot-pulse {
        0%, 100% { box-shadow: 0 0 6px 1px rgba(56, 189, 248, 0.35); }
        50% { box-shadow: 0 0 10px 3px rgba(56, 189, 248, 0.55); }
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-steps:empty {
        display: none;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-steps li {
        font-size: 10px;
        color: #64748b;
        padding: 1px 0;
        transition: color 100ms;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-steps li::before {
        content: "○ ";
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-steps li[data-done] {
        color: #4ade80;
      }

      #${AUTO_NUKE_PROCESS_PANEL_ID} .openfront-helper-auto-nuke-process-steps li[data-done]::before {
        content: "✓ ";
      }

      @keyframes openfront-helper-auto-nuke-process-wait {
        from { transform: translateX(-16%); }
        to { transform: translateX(180%); }
      }
    `;
