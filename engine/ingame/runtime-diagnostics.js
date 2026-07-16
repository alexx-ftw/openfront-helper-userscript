// On-demand runtime diagnostics for terminal/CDP probes. Collection is passive:
// no timer or gameplay scan is added. Expensive state is read only when snapshot()
// is explicitly called.

const RUNTIME_DIAGNOSTIC_LONG_TASK_LIMIT = 120;
const _runtimeDiagnosticLongTasks = [];
let _runtimeDiagnosticLongTaskCount = 0;
let _runtimeDiagnosticLongTaskTotalMs = 0;

function runtimeDiagnosticRecordLongTask(entry) {
  const duration = Math.max(0, Number(entry?.duration) || 0);
  _runtimeDiagnosticLongTaskCount += 1;
  _runtimeDiagnosticLongTaskTotalMs += duration;
  _runtimeDiagnosticLongTasks.push({
    at: Math.round((performance.timeOrigin || 0) + (Number(entry?.startTime) || 0)),
    durationMs: Math.round(duration * 10) / 10,
  });
  if (_runtimeDiagnosticLongTasks.length > RUNTIME_DIAGNOSTIC_LONG_TASK_LIMIT) {
    _runtimeDiagnosticLongTasks.splice(
      0,
      _runtimeDiagnosticLongTasks.length - RUNTIME_DIAGNOSTIC_LONG_TASK_LIMIT,
    );
  }
}

try {
  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) runtimeDiagnosticRecordLongTask(entry);
    });
    observer.observe({ type: "longtask", buffered: true });
  }
} catch (_error) {
  // Long-task observation is optional and unavailable in some browser builds.
}

function runtimeDiagnosticLimit(value, fallback, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.floor(number))) : fallback;
}

// Recursive serialization necessarily branches by JavaScript value type.
// eslint-disable-next-line complexity
function runtimeDiagnosticPlainValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= 6) return "[max-depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 1000).map((entry) => runtimeDiagnosticPlainValue(entry, depth + 1, seen));
  }
  const output = {};
  for (const key of Object.keys(value).slice(0, 200)) {
    try {
      output[key] = runtimeDiagnosticPlainValue(value[key], depth + 1, seen);
    } catch (error) {
      output[key] = `[unavailable: ${error?.message || "error"}]`;
    }
  }
  return output;
}

function runtimeDiagnosticContext() {
  try {
    return getOpenFrontGameContext();
  } catch (_error) {
    return null;
  }
}

function runtimeDiagnosticPlayers(game) {
  try {
    return game ? getCachedPlayerViews(game) : [];
  } catch (_error) {
    return [];
  }
}

// This aggregates independent optional runtime surfaces. Counting each optional
// property as control-flow would obscure rather than improve the snapshot code.
// eslint-disable-next-line complexity
function getRuntimeDiagnosticSnapshot(options = {}) {
  const logLimit = runtimeDiagnosticLimit(options.logLimit, 100, 500);
  const eventLimit = runtimeDiagnosticLimit(options.eventLimit, 200, 1000);
  const matchLimit = runtimeDiagnosticLimit(options.matchLimit, 5, 20);
  const context = runtimeDiagnosticContext();
  const game = context?.game || null;
  const me = context?.myPlayer || game?.myPlayer?.() || null;
  const players = runtimeDiagnosticPlayers(game);
  const recentLongTasks = _runtimeDiagnosticLongTasks.slice(-logLimit);
  const snapshot = {
    capturedAt: Date.now(),
    helper: {
      loaded: true,
      version: window.__OFH_ASSETS?.version ?? null,
      url: window.location?.href ?? null,
      title: document.title || null,
      visibility: document.visibilityState || null,
      uptimeMs: Math.round(performance.now()),
      helperTickListeners: _helperTickListeners?.size ?? null,
    },
    connection: {
      websocketConnected: typeof isSocketConnected === "function" ? isSocketConnected() : null,
      websocketState: typeof _wsConnectionState === "boolean" ? _wsConnectionState : null,
      lastKnownTile: typeof getLastKnownTile === "function" ? getLastKnownTile() : null,
    },
    match: {
      active: Boolean(game),
      gameId: game?.gameID?.() ?? game?.id?.() ?? null,
      tick: game?.ticks?.() ?? null,
      inSpawnPhase: game?.inSpawnPhase?.() ?? null,
      playerCount: players.length,
      alivePlayerCount: players.filter((player) => player?.isAlive?.()).length,
      me: me
        ? {
            id: me.smallID?.() ?? me.id?.() ?? null,
            alive: me.isAlive?.() ?? null,
            spawned: me.hasSpawned?.() ?? null,
            gold: me.gold?.() ?? null,
            troops: me.troops?.() ?? null,
            tiles: me.numTilesOwned?.() ?? null,
          }
        : null,
    },
    autoBot: {
      diagnostic: typeof diagnose === "function" ? diagnose({ silent: true }) : null,
      performance:
        typeof getAutoBotProfileSnapshot === "function" ? getAutoBotProfileSnapshot() : null,
      logs: Array.isArray(state?.log) ? state.log.slice(0, logLimit) : [],
    },
    browserPerformance: {
      longTaskCount: _runtimeDiagnosticLongTaskCount,
      longTaskTotalMs: Math.round(_runtimeDiagnosticLongTaskTotalMs * 10) / 10,
      maxRecentLongTaskMs: recentLongTasks.reduce(
        (maximum, entry) => Math.max(maximum, entry.durationMs),
        0,
      ),
      recentLongTasks,
      memory: performance.memory
        ? {
            usedJsHeapSize: performance.memory.usedJSHeapSize,
            totalJsHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
          }
        : null,
    },
    runtimeExceptions: Array.isArray(globalThis.__OFH_RUNTIME_EXCEPTIONS__)
      ? globalThis.__OFH_RUNTIME_EXCEPTIONS__.slice(-logLimit)
      : [],
    runtimeEvents: Array.isArray(globalThis.__OFH_RUNTIME_EVENTS__)
      ? globalThis.__OFH_RUNTIME_EVENTS__.slice(-logLimit)
      : [],
    roundLog:
      typeof getRoundLogSnapshot === "function"
        ? getRoundLogSnapshot(eventLimit, matchLimit)
        : null,
    networkLog: {
      enabled: runtimeState.networkLoggerEnabled,
      entryCount: Array.isArray(_networkLogEntries) ? _networkLogEntries.length : 0,
      entries: Array.isArray(_networkLogEntries) ? _networkLogEntries.slice(-logLimit) : [],
    },
  };
  return runtimeDiagnosticPlainValue(snapshot);
}

function configureRuntimeDiagnostics(options = {}) {
  if (typeof options.performanceProfiling === "boolean") {
    setAutoBotProfiling(options.performanceProfiling);
  }
  if (typeof options.roundLogger === "boolean") setRoundLoggerEnabled(options.roundLogger);
  if (typeof options.networkLogger === "boolean") setNetworkLoggerEnabled(options.networkLogger);
  return getRuntimeDiagnosticSnapshot({ logLimit: 20, eventLimit: 20, matchLimit: 2 });
}

if (typeof globalThis === "object") {
  globalThis.__OFH_RUNTIME_DIAGNOSTICS__ = {
    snapshot: getRuntimeDiagnosticSnapshot,
    configure: configureRuntimeDiagnostics,
  };
}
