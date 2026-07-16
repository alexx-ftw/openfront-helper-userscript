// Auto-Bot — engine: thin driver. Builds the per-tick gameApi snapshot and hands
// control to the faithfully-ported NationBot orchestrator (nationExecution.js).
// NO strategy lives here — engine only schedules botTick and manages the gameApi
// + NationBot lifecycle. (Previously this file held the custom tick chain; that
// chain is gone — the strategy is now a 1:1 port of src NationExecution.)

"use strict";

  // gameApi + bot singletons, rebuilt when the underlying game / player changes.
  let _api = null;
  let _apiSrc = null;
  let _bot = null;
  let _botSeedKey = null;

  function ensureGameApi(srcGame) {
    if (_api && _apiSrc === srcGame) return _api;
    _api = createGameApi(srcGame);
    _apiSrc = srcGame;
    _bot = null; // new game context → rebuild the bot (fresh seed/state)
    _botSeedKey = null;
    return _api;
  }

  // gameID for the PseudoRandom seed (src seeds simpleHash(playerId)+simpleHash(gameID)).
  function resolveGameId(srcGame) {
    {
      if (typeof srcGame.gameID === "function") return String(srcGame.gameID());
    }{
      const gc = srcGame.config().gameConfig();
      if (gc && gc.gameID != null) return String(gc.gameID);
    }
    return "openfront";
  }

  // =========================================================================
  // Engine tick — thin driver
  // =========================================================================
  function currentAutoBotTickGeneration(tickGeneration) {
    return state.settings.enabled && state.tickGeneration === tickGeneration;
  }

  async function prepareAutoBotSnapshot(profile, api, meCore) {
    const snapshot = async () => {
      await api.beginTick(meCore);
      const me = api.game.myPlayer();
      updateLive(api.game, me);
    };
    if (profile) {
      await autoBotProfileAsyncPhase(profile, "snapshot", snapshot);
      return;
    }
    await snapshot();
  }

  async function runAutoBotNationTick(profile, api, tickGeneration) {
    if (!_bot) {
      setStatus(tr("Loading bot…"));
      return;
    }
    if (profile) {
      await autoBotProfileAsyncPhase(profile, "nation-tick", () =>
        _bot.tick(api.game.ticks(), profile, tickGeneration),
      );
    } else {
      await _bot.tick(api.game.ticks(), null, tickGeneration);
    }
    if (currentAutoBotTickGeneration(tickGeneration)) {
      setStatus(_bot.status || tr("Thinking…"));
    }
  }

  async function botTick() {
    if (!state.settings.enabled || state.tickInFlight) return;

    const srcGame = getGame();
    if (!srcGame) {
      setStatus(tr("Waiting to enter game…"));
      return;
    }
    if (isPublicLobby(srcGame)) {
      setStatus(tr("⛔ Blocked in a public lobby"));
      refreshGateBanner();
      return;
    }

    const meCore = srcGame.myPlayer?.();
    if (!meCore || !meCore.isPlayer?.()) {
      setStatus(tr("Waiting for player…"));
      return;
    }

    const tickGeneration = state.tickGeneration;
    state.tickInFlight = true;
    state.tickStartedAt = performance.now();
    const profile = beginAutoBotProfileTick();
    try {
      const setupStartedAt = autoBotProfileStartPhase(profile);
      updateSpeedFactor(srcGame);
      const api = ensureGameApi(srcGame);

      // (Re)build the orchestrator when the player identity changes (new game).
      const seedKey = meCore.id?.();
      if ((!_bot || _botSeedKey !== seedKey) && typeof NationBot === "function") {
        _bot = new NationBot(api.game, {
          gameId: resolveGameId(srcGame),
          playerId: String(seedKey),
        });
        _botSeedKey = seedKey;
      }
      autoBotProfileEndPhase(profile, "engine-setup", setupStartedAt);

      // Snapshot async data (me.borderTiles + profile) ONCE up front.
      await prepareAutoBotSnapshot(profile, api, meCore);

      // A stop/restart can invalidate this snapshot while the worker call is
      // pending. Do not hand stale state to the NationBot chain.
      if (!currentAutoBotTickGeneration(tickGeneration)) return;
      await runAutoBotNationTick(profile, api, tickGeneration);
    } finally {
      state.tickInFlight = false;
      finishAutoBotProfileTick(profile);
      renderStatus();
    }
  }

  function updateLive(game, me) {
    {
      const troops = toNum(me.troops?.());
      const maxTroops = safeMaxTroops(game, me);
      state.live = {
        troops,
        gold: toNum(me.gold?.()),
        tiles: toNum(me.numTilesOwned?.()),
        fill: maxTroops > 0 ? troops / maxTroops : 0,
      };
    }
  }

  // How often botTick runs in REAL time. In win-fix mode this is also the combat
  // decision cadence; nationExecution must not add another artificial delay.
  function desiredTickInterval() {
    const configured = state.settings.tickMs || 200;
    const base =
      typeof normalizeTickIntervalMs === "function"
        ? normalizeTickIntervalMs(configured)
        : configured;
    return clamp(base / Math.max(0.25, state.speed.factor || 1), 100, base);
  }

  function startEngine() {
    if (state.tickTimer !== null) return;
    state.tickIntervalMs = desiredTickInterval();
    state.tickTimer = window.setInterval(botTick, state.tickIntervalMs);
    botTick();
  }

  function stopEngine() {
    if (state.tickTimer !== null) {
      window.clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
    // Do not clear tickInFlight here: the async tick may still be inside a
    // worker call. Leaving the lock set prevents an immediate stop/start from
    // launching a second chain before the first one reaches finally.
    state.tickGeneration = (Number(state.tickGeneration) || 0) + 1;
  }

  function retuneEngine() {
    if (state.tickTimer === null) return;
    const want = desiredTickInterval();
    // The panel changes tickMs in 50 ms steps. Do not leave the old timer
    // running for a 50 ms adjustment: every valid setting must affect the
    // actual polling cadence immediately.
    if (want !== state.tickIntervalMs) {
      window.clearInterval(state.tickTimer);
      state.tickIntervalMs = want;
      state.tickTimer = window.setInterval(botTick, want);
    }
  }

  function setEnabled(enabled) {
    state.settings.enabled = Boolean(enabled);
    saveSettings();
    if (state.settings.enabled) {
      setStatus(tr("Starting…"));
      startEngine();
    } else {
      stopEngine();
      setStatus(tr("Disabled"));
    }
    renderHeader();
  }

  function setStatus(text) {
    state.status = text;
  }

  // `text` is already localized by the caller (via t()); `cat` is one of the
  // LOG_CATS keys, passed explicitly at every call site.
  function setLastAction(text, cat) {
    const now = Date.now();
    state.lastAction = text + "  ·  T+" + new Date(now).toLocaleTimeString();
    pushLog(text, cat || "combat", now);
  }

  function pushLog(text, cat, ts) {
    state.log.unshift({ t: ts || Date.now(), cat, text: String(text) });
    if (state.log.length > LOG_CAP) state.log.length = LOG_CAP;
    if (state.activeTab === "log") renderLog();
  }
