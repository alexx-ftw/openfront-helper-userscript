// Round logger — records a timeline of game events (attacks, nuke launches,
// alliance changes, structure builds, combat outcomes) as a JSON array in
// memory. Useful for debugging bot behavior, analyzing match flow, and
// reporting issues. Events are keyed per-match and exported directly to files.
//
// The logger is intentionally lightweight: it writes to an in-memory array and
// never writes match data to localStorage. Names are sanitized by default
// (player IDs only) unless roundLogKeepNames is true.

  const ROUND_LOG_MAX_MATCHES = 2;

  let _roundLogEvents = [];
  let _roundLogHistory = [];
  let _roundLogGameId = null;
  let _roundLogStartedAt = null;
  let _roundLogSequence = 0;
  let _roundLogExportedGameId = null;

  function roundLogEncodeBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function roundLogClone(value) {
    if (value === undefined) return null;
    if (typeof value === "bigint") return String(value);
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return { kind: "ArrayBuffer", byteLength: value.byteLength, base64: roundLogEncodeBytes(value) };
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      return { kind: value.constructor?.name || "TypedArray", byteLength: value.byteLength,
        base64: roundLogEncodeBytes(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return { kind: "Blob", type: value.type, size: value.size };
    }
    return JSON.parse(JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? String(nested) : nested));
  }

  function roundLogEntry() {
    return {
      gameId: _roundLogGameId,
      startedAt: _roundLogStartedAt,
      events: _roundLogEvents,
      flushedAt: Date.now(),
    };
  }

  function readRoundLogHistory() {
    return _roundLogHistory;
  }

  function archiveCurrentRoundLog() {
    const entry = roundLogEntry();
    if (!entry.gameId || entry.events.length === 0) return;
    _roundLogHistory = _roundLogHistory.filter((item) => item?.gameId !== entry.gameId);
    _roundLogHistory.unshift(entry);
    _roundLogHistory = _roundLogHistory.slice(0, ROUND_LOG_MAX_MATCHES);
  }

  function roundLogRecord(category, data) {
    if (!runtimeState.roundLoggerEnabled) return;
    const event = {
      t: Date.now(),
      seq: _roundLogSequence,
      cat: category,
      ...roundLogClone(data),
    };
    _roundLogSequence += 1;
    _roundLogEvents.push(event);
  }

  function roundLogFlush() {
    // Deliberately memory-only. Kept as a compatibility hook for diagnostics.
  }

  function roundLogStartMatch(game) {
    archiveCurrentRoundLog();
    _roundLogEvents = [];
    {
      const ticks = game.ticks ? game.ticks() : 0;
      _roundLogGameId = `match-${Date.now()}-${ticks}`;
      _roundLogStartedAt = Date.now();
      _roundLogSequence = 0;
      _roundLogExportedGameId = null;
    }
    roundLogRecord("match_start", {
      gameId: _roundLogGameId,
      page: typeof location === "object" ? {
        href: location.href,
        userAgent: typeof navigator === "object" ? navigator.userAgent : null,
        language: typeof navigator === "object" ? navigator.language : null,
      } : null,
      viewport: typeof innerWidth === "number" ? { width: innerWidth, height: innerHeight,
        devicePixelRatio: typeof globalThis.devicePixelRatio === "number" ? devicePixelRatio : 1 } : null,
      settings: typeof state === "object" ? state.settings : null,
      game: { ticks: game.ticks?.() ?? null, playerCount: game.players?.()?.length ?? null },
    });
  }

  function roundLogDownload(entry, reason = "manual") {
    if (!entry?.gameId || !Array.isArray(entry.events) || entry.events.length === 0) return null;
    if (typeof document !== "object" || typeof Blob === "undefined" || typeof URL === "undefined") {
      return entry;
    }
    const header = { type: "openfront_match_log", version: 1, gameId: entry.gameId,
      startedAt: entry.startedAt, exportedAt: Date.now(), reason };
    const lines = [JSON.stringify(header), ...entry.events.map((event) => JSON.stringify(event))];
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openfront-${entry.gameId}.jsonl`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return entry;
  }

  function roundLogFinishMatch(reason) {
    if (!_roundLogGameId || _roundLogExportedGameId === _roundLogGameId) return;
    roundLogRecord("match_end", { reason, durationMs: Date.now() - _roundLogStartedAt });
    roundLogFlush();
    const entry = roundLogEntry();
    archiveCurrentRoundLog();
    _roundLogExportedGameId = _roundLogGameId;
    roundLogDownload(entry, reason);
  }

  // Observe game state each tick and record significant changes.
  let _roundLogLastTick = -1;
  let _roundLogLastPlayerSnapshot = null;

  function roundLogResetForNewMatch(game, ticks) {
    if (ticks >= _roundLogLastTick || ticks >= 10) return;
    roundLogFinishMatch("tick_reset");
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
    if (!_roundLogGameId) roundLogStartMatch(game);
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
      _roundLogEvents = [];
      _roundLogLastPlayerSnapshot = null;
      _roundLogLastTick = -1;
    }
  }

  function exportRoundLog() {
    {
      const data = roundLogEntry();
      if (!data.gameId || data.events.length === 0) return null;
      // Sanitize: remove player names if keepNames is off.
      if (data.events) {
        for (const ev of data.events) {
          if (ev.player && typeof ev.player === "string" && !ev.player.startsWith("p")) {
            ev.player = "[redacted]";
          }
        }
      }
      return roundLogDownload(data);
    }
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("error", (event) => {
      roundLogRecord("runtime_error", { message: event.message, filename: event.filename,
        lineno: event.lineno, colno: event.colno, error: event.error?.stack || String(event.error || "") });
    });
    window.addEventListener("unhandledrejection", (event) => {
      roundLogRecord("unhandled_rejection", { reason: event.reason?.stack || roundLogClone(event.reason) });
    });
    window.addEventListener("pagehide", () => {
      if (_roundLogGameId) roundLogFinishMatch("pagehide");
    });
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
