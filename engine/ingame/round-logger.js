// Round logger — records a timeline of game events (attacks, nuke launches,
// alliance changes, structure builds, combat outcomes) as a JSON array in
// localStorage. Useful for debugging bot behavior, analyzing match flow, and
// reporting issues. Events are keyed per-match (reset when a new game starts).
//
// The logger is intentionally lightweight: it writes to an in-memory array and
// flushes to localStorage every FLUSH_MS (5s). Names are sanitized by default
// (player IDs only) unless roundLogKeepNames is true.

  const ROUND_LOG_STORAGE_KEY = "openfront-helper-round-log";
  const ROUND_LOG_HISTORY_STORAGE_KEY = "openfront-helper-match-history";
  const ROUND_LOG_FLUSH_MS = 5000;
  const ROUND_LOG_MAX_EVENTS = 4000;
  const ROUND_LOG_MAX_MATCHES = 20;

  let _roundLogEvents = [];
  let _roundLogFlushTimer = null;
  let _roundLogGameId = null;

  function roundLogEntry() {
    return {
      gameId: _roundLogGameId,
      events: _roundLogEvents,
      flushedAt: Date.now(),
    };
  }

  function readRoundLogHistory() {
    {
      const history = JSON.parse(localStorage.getItem(ROUND_LOG_HISTORY_STORAGE_KEY) || "[]");
      return Array.isArray(history) ? history : [];
    }
  }

  function archiveStoredRoundLog() {
    {
      const stored = JSON.parse(localStorage.getItem(ROUND_LOG_STORAGE_KEY) || "null");
      if (!stored?.gameId || !Array.isArray(stored.events) || stored.events.length === 0) return;
      const history = readRoundLogHistory().filter((entry) => entry?.gameId !== stored.gameId);
      history.unshift(stored);
      localStorage.setItem(
        ROUND_LOG_HISTORY_STORAGE_KEY,
        JSON.stringify(history.slice(0, ROUND_LOG_MAX_MATCHES)),
      );
    }
  }

  function roundLogRecord(category, data) {
    if (!runtimeState.roundLoggerEnabled) return;
    const event = {
      t: Date.now(),
      cat: category,
      ...data,
    };
    _roundLogEvents.push(event);
    if (_roundLogEvents.length > ROUND_LOG_MAX_EVENTS) {
      _roundLogEvents = _roundLogEvents.slice(-ROUND_LOG_MAX_EVENTS);
    }
  }

  function roundLogFlush() {
    if (_roundLogEvents.length === 0) return;
    {
      localStorage.setItem(ROUND_LOG_STORAGE_KEY, JSON.stringify(roundLogEntry()));
    }
  }

  function roundLogStartMatch(game) {
    archiveStoredRoundLog();
    _roundLogEvents = [];
    {
      const ticks = game.ticks ? game.ticks() : 0;
      _roundLogGameId = `match-${Date.now()}-${ticks}`;
    }
    roundLogRecord("match_start", { gameId: _roundLogGameId });
  }

  // Observe game state each tick and record significant changes.
  let _roundLogLastTick = -1;
  let _roundLogLastPlayerSnapshot = null;

  function roundLogResetForNewMatch(game, ticks) {
    if (ticks >= _roundLogLastTick || ticks >= 10) return;
    roundLogFlush();
    roundLogStartMatch(game);
    _roundLogLastTick = -1;
    _roundLogLastPlayerSnapshot = null;
  }

  function roundLogPlayerSnapshot(player, fallbackId) {
    if (!player?.isAlive?.()) return null;
    const smallId = player.smallID?.() ?? fallbackId;
    return {
      smallId,
      troops: Number(player.troops?.() ?? 0) || 0,
      tiles: Number(player.numTilesOwned?.() ?? 0) || 0,
    };
  }

  function roundLogTroopChange(current) {
    const previous = _roundLogLastPlayerSnapshot?.get(current.smallId);
    if (!previous) return;
    const troopDelta = current.troops - previous.troops;
    if (
      Math.abs(troopDelta) <= previous.troops * 0.2 ||
      Math.abs(troopDelta) <= 1000
    ) {
      return;
    }
    roundLogRecord("troop_change", {
      player: `p${current.smallId}`,
      delta: troopDelta,
      troops: current.troops,
      tiles: current.tiles,
    });
  }

  function roundLogTick(game) {
    if (!runtimeState.roundLoggerEnabled) return;
    const ticks = game.ticks ? game.ticks() : 0;
    // Tick counters reset between matches. Detect that edge before the duplicate
    // tick guard; otherwise every tick in the new match is lower than the prior
    // match's last tick and logging never resumes.
    roundLogResetForNewMatch(game, ticks);
    if (ticks <= _roundLogLastTick) return;
    _roundLogLastTick = ticks;

    const players = getCachedPlayerViews(game);
    const snapshot = new Map();
    for (let i = 0; i < players.length; i += 1) {
      const current = roundLogPlayerSnapshot(players[i], i);
      if (!current) continue;
      snapshot.set(current.smallId, {
        troops: current.troops,
        tiles: current.tiles,
      });
      roundLogTroopChange(current);
    }
    _roundLogLastPlayerSnapshot = snapshot;
  }

  function roundLogHelperTick() {
    {
      const ctx = getOpenFrontGameContext();
      if (ctx?.game) roundLogTick(ctx.game);
    }
  }

  function setRoundLoggerEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    if (runtimeState.roundLoggerEnabled === nextEnabled) return;
    runtimeState.roundLoggerEnabled = nextEnabled;
    if (runtimeState.roundLoggerEnabled) {
      if (_roundLogFlushTimer === null) {
        _roundLogFlushTimer = window.setInterval(roundLogFlush, ROUND_LOG_FLUSH_MS);
      }
      const context = (() => {
        {
          return getOpenFrontGameContext();
        }
      })();
      if (context?.game) roundLogStartMatch(context.game);
      if (typeof registerHelperTickListener === "function") {
        registerHelperTickListener(roundLogHelperTick);
      }
    } else {
      if (typeof unregisterHelperTickListener === "function") {
        unregisterHelperTickListener(roundLogHelperTick);
      }
      roundLogFlush();
      if (_roundLogFlushTimer !== null) {
        window.clearInterval(_roundLogFlushTimer);
        _roundLogFlushTimer = null;
      }
      _roundLogEvents = [];
      _roundLogLastPlayerSnapshot = null;
      _roundLogLastTick = -1;
    }
  }

  function exportRoundLog() {
    roundLogFlush();
    {
      const raw = localStorage.getItem(ROUND_LOG_STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Sanitize: remove player names if keepNames is off.
      if (data.events) {
        for (const ev of data.events) {
          if (ev.player && typeof ev.player === "string" && !ev.player.startsWith("p")) {
            ev.player = "[redacted]";
          }
        }
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openfront-log-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return data;
    }
  }

  function getRoundLogSnapshot(eventLimit = 200, matchLimit = 5) {
    const normalizedEventLimit = Math.max(0, Math.min(1000, Number(eventLimit) || 0));
    const normalizedMatchLimit = Math.max(0, Math.min(ROUND_LOG_MAX_MATCHES, Number(matchLimit) || 0));
    return {
      enabled: runtimeState.roundLoggerEnabled,
      current: {
        gameId: _roundLogGameId,
        eventCount: _roundLogEvents.length,
        events: _roundLogEvents.slice(-normalizedEventLimit),
      },
      history: readRoundLogHistory().slice(0, normalizedMatchLimit),
    };
  }
