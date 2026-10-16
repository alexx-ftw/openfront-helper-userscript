// OpenFront context discovery and selective trade policy.
  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function isUsableOpenFrontGameContext(game, transform) {
    return Boolean(
      game?.playerViews &&
        transform?.worldToScreenCoordinates,
    );
  }

  function rememberOpenFrontGameContext(game, transform) {
    if (!isUsableOpenFrontGameContext(game, transform)) {
      return null;
    }

    runtimeState.lastOpenFrontGameContext = { game, transform };
    if (runtimeState.selectiveTradePolicyEnabled) {
      syncSelectiveTradePolicyPatches(game);
      if (runtimeState.selectiveTradePolicyNeedsEmbargoSync) {
        applySelectiveTradePolicy(game);
      }
    }
    return runtimeState.lastOpenFrontGameContext;
  }

  function findOpenFrontGameContextInDom() {
    const gameSources = [];
    const transformSources = [];

    for (const element of document.querySelectorAll("*")) {
      if (element?.game) {
        gameSources.push(element.game);
      }
      if (element?.g) {
        gameSources.push(element.g);
      }
      if (element?.transformHandler) {
        transformSources.push(element.transformHandler);
      }
      if (element?.transform) {
        transformSources.push(element.transform);
      }
    }

    for (const game of gameSources) {
      for (const transform of transformSources) {
        const context = rememberOpenFrontGameContext(game, transform);
        if (context) {
          return context;
        }
      }
    }

    return null;
  }
  // Context discovery is the hottest per-frame path: every active helper
  // (nuke-prediction, boat-prediction, bot-markers, heatmaps) calls this on
  // every render frame. The old implementation ran 11 document.querySelector
  // calls plus 66 inner iterations every time, even when lastOpenFrontGameContext
  // was perfectly valid. That was ~2640 querySelectors/s with four helpers
  // active at 60 Hz, which is a major contributor to in-game frame drops.
  //
  // Strategy: short-circuit on the cached context. Game/transform references
  // are stable across the lifetime of a single match. Force a periodic full
  // re-discovery so we still notice when a game ends and a new one starts.
  const _OPEN_FRONT_CONTEXT_REFRESH_MS = 1000;
  let _lastOpenFrontContextDiscoveryAt = 0;

  function _discoverOpenFrontGameContext() {
    return findOpenFrontGameContextInDom();
  }

  const _OPEN_FRONT_CONTEXT_MISS_MS = 250;
  // Negative start = window inactive until the first failed discovery arms it.
  let _lastOpenFrontContextMissAt = -_OPEN_FRONT_CONTEXT_MISS_MS;
  // Repeated signal-less misses mean an idle menu: back off to the positive
  // refresh interval (4 misses = 1s idle). Any start signal or discovery
  // resets the fast window.
  const _OPEN_FRONT_CONTEXT_MISS_BACKOFF_MS = _OPEN_FRONT_CONTEXT_REFRESH_MS;
  const _OPEN_FRONT_CONTEXT_MISS_BACKOFF_AFTER = 4;
  let _openFrontContextMissStreak = 0;

  function _openFrontContextMissWindowMs() {
    return _openFrontContextMissStreak >= _OPEN_FRONT_CONTEXT_MISS_BACKOFF_AFTER
      ? _OPEN_FRONT_CONTEXT_MISS_BACKOFF_MS
      : _OPEN_FRONT_CONTEXT_MISS_MS;
  }

  function _isOpenFrontGameStartSignalActive() {
    if (document.body?.classList?.contains("in-game")) return true;
    if (
      /live/.test(window.location.search) &&
        /^\/(?:w\d+\/)?game\//.test(
          window.location.pathname.replace(/^\/v\/[0-9a-f]{7,40}/, ""),
        )
    ) {
      return true;
    }
    const modal = _getOpenFrontGameStartingModal();
    return Boolean(modal && modal.isVisible === true && !modal.classList.contains("hidden"));
  }

  // The modal lookup runs on every suppressed getter call (60 Hz consumers),
  // so it shares the 250 ms miss-window cadence. A connected modal keeps its
  // cached node (live visibility reads); a missing or disconnected node only
  // re-queries at the cadence boundary. A just-mounted modal is therefore
  // honored within one window, never instantaneously.
  function _getOpenFrontGameStartingModal() {
    if (_openFrontStartModalRef?.isConnected) return _openFrontStartModalRef;
    const now = performance.now();
    if (now - _lastOpenFrontStartModalLookupAt >= _OPEN_FRONT_CONTEXT_MISS_MS) {
      _lastOpenFrontStartModalLookupAt = now;
      _openFrontStartModalRef = document.querySelector("game-starting-modal");
    }
    return _openFrontStartModalRef?.isConnected ? _openFrontStartModalRef : null;
  }

  let _openFrontStartModalRef = null;
  let _lastOpenFrontStartModalLookupAt = -_OPEN_FRONT_CONTEXT_MISS_MS;

  function getOpenFrontGameContext() {
    // Fast path: re-use the cached context as long as it still looks usable
    // and the periodic refresh interval has not elapsed.
    const now = performance.now();
    if (
      now - _lastOpenFrontContextDiscoveryAt < _OPEN_FRONT_CONTEXT_REFRESH_MS &&
      isUsableOpenFrontGameContext(
        runtimeState.lastOpenFrontGameContext?.game,
        runtimeState.lastOpenFrontGameContext?.transform,
      )
    ) {
      return runtimeState.lastOpenFrontGameContext;
    }

    if (now - _lastOpenFrontContextMissAt < _openFrontContextMissWindowMs()) {
      if (_isOpenFrontGameStartSignalActive()) {
        _lastOpenFrontContextMissAt = 0;
        _openFrontContextMissStreak = 0;
      } else {
        return null;
      }
    }

    _lastOpenFrontContextDiscoveryAt = now;
    const discovered = _discoverOpenFrontGameContext();
    if (discovered) {
      _lastOpenFrontContextMissAt = 0;
      _openFrontContextMissStreak = 0;
      return discovered;
    }

    // Last resort: even if discovery failed this round, keep the previously
    // cached context if its functions still exist. Prevents a single failed
    // DOM scan from breaking helpers mid-game.
    if (
      isUsableOpenFrontGameContext(
        runtimeState.lastOpenFrontGameContext?.game,
        runtimeState.lastOpenFrontGameContext?.transform,
      )
    ) {
      return runtimeState.lastOpenFrontGameContext;
    }

    // Arm only when no start signal is active: a bypass rescan must not
    // suppress the next menu retry.
    if (!_isOpenFrontGameStartSignalActive()) {
      _lastOpenFrontContextMissAt = now;
      _openFrontContextMissStreak += 1;
    }
    return null;
  }

  function refreshSelectiveTradePolicyAvailability() {
    const context = getOpenFrontGameContext();
    reportSelectiveTradePolicyAvailability(context?.game ?? null);
  }
