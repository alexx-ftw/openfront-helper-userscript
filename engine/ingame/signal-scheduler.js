// Outgoing intent scheduler — paces emoji/target intents under the server rate
// limit (10/sec, 150/min per ClientMsgRateLimiter) plus per-recipient game
// cooldowns measured in GAME TICKS (emojiMessageCooldown=50, targetCooldown=150).
// Shared by helper-users-panel.js (TN1) and sos-defense.js (TN2). Mirrors the atom
// macro's ATOM_SAFE_GAP_MS / rolling-minute pacing (auto-bot/lifecycle.js). FIFO,
// but skips a cooldown-blocked head so an urgent SOS isn't starved behind TN1's
// signature broadcast. Low volume (TN1: 3 emoji once per match; TN2: a few / 10-15s).

  const SIGNAL_MIN_GAP_MS = 200; // ~5/sec, safely under the 10/sec server cap (wall-clock)
  const SIGNAL_PER_MIN_CAP = 120; // safely under the 150/min server cap (wall-clock)
  const SIGNAL_TICK_MS = 200; // scheduler wake interval
  const SIGNAL_MAX_ATTEMPTS = 400; // drop an item after this many blocked ticks (~80s)
  // Per-recipient cooldowns are measured in GAME TICKS, not wall-clock ms. The
  // game gates emoji/target by ticks (emojiMessageCooldown=50, targetCooldown=150),
  // and the client sim can run slower than real time (network jitter / early game),
  // so a wall-clock 5s can elapse before 50 game ticks do — releasing an emoji the
  // game then silently rejects while we've already dequeued it (lost forever). A
  // Keep a small local safety margin, but read the authoritative base cooldown
  // from Config so a game balance change does not silently drop intents.
  const signalCooldownMarginTicks = { emoji: 5, target: 10 };

  const _signalQueue = [];
  const _signalLastSentByKey = new Map(); // `${kind}:${recipientKey}` -> game tick
  const _signalFireTimes = []; // rolling-minute emit timestamps (ms)
  let _signalLastEmitAt = 0;
  let _signalIntervalId = null;

  function _signalRecipientKey(recipient) {
    if (recipient === AllPlayers) return "ALL";
    {
      const sid = recipient?.smallID?.();
      if (sid !== undefined && sid !== null) return "s" + sid;
      const id = recipient?.id?.();
      if (id !== undefined && id !== null) return "i" + id;
    }
    return "unknown";
  }

  function _signalPerMinuteOk() {
    const now = performance.now();
    while (_signalFireTimes.length && now - _signalFireTimes[0] > 60000) {
      _signalFireTimes.shift();
    }
    return _signalFireTimes.length < SIGNAL_PER_MIN_CAP;
  }

  function _signalCtorFor(kind, ctors) {
    if (kind === "emoji") return ctors.emoji;
    if (kind === "target") return ctors.target;
    return null;
  }

  function _signalCurrentTick() {
    {
      const game = getOpenFrontGameContext()?.game;
      const t = Number(game?.ticks?.());
      return Number.isFinite(t) ? t : null;
    }
  }

  function _signalCooldownTicks(kind) {
    const fallback = kind === "emoji" ? 50 : 150;
    const method = kind === "emoji" ? "emojiMessageCooldown" : "targetCooldown";
    const game = getOpenFrontGameContext()?.game;
    const configured =
      typeof ofhGameConfigNumber === "function"
        ? ofhGameConfigNumber(game, method, fallback)
        : fallback;
    return configured + (signalCooldownMarginTicks[kind] || 0);
  }

  function _signalItemBlocked(item, constructors, currentTick) {
    if (!_signalCtorFor(item.kind, constructors)) return true;
    const key = item.kind + ":" + _signalRecipientKey(item.recipient);
    const cooldownTicks = _signalCooldownTicks(item.kind);
    const lastTick = _signalLastSentByKey.get(key);
    if (lastTick === undefined) return false;
    const elapsedTicks = currentTick - lastTick;
    return elapsedTicks >= 0 && elapsedTicks < cooldownTicks;
  }

  function _findReadySignalIndex(constructors, currentTick) {
    for (let index = 0; index < _signalQueue.length; index += 1) {
      const item = _signalQueue[index];
      if (!_signalItemBlocked(item, constructors, currentTick)) return index;
      item.attempts += 1;
    }
    return -1;
  }

  function _dropExpiredSignals(readyIndex) {
    let adjustedIndex = readyIndex;
    for (let index = _signalQueue.length - 1; index >= 0; index -= 1) {
      if (_signalQueue[index].attempts <= SIGNAL_MAX_ATTEMPTS) continue;
      _signalQueue.splice(index, 1);
      if (index <= adjustedIndex) adjustedIndex -= 1;
    }
    return adjustedIndex;
  }

  function _emitReadySignal(readyIndex, constructors, currentTick, now) {
    const item = _signalQueue.splice(readyIndex, 1)[0];
    const constructor = _signalCtorFor(item.kind, constructors);
    const key = item.kind + ":" + _signalRecipientKey(item.recipient);
    if (emitIntent(constructor, ...item.args)) {
      _signalLastEmitAt = now;
      _signalLastSentByKey.set(key, currentTick);
      _signalFireTimes.push(now);
      return;
    }
    item.attempts += 1;
    if (item.attempts <= SIGNAL_MAX_ATTEMPTS) _signalQueue.unshift(item);
  }

  function _runSignalScheduler() {
    if (_signalQueue.length === 0) return;

    const now = performance.now();
    if (now - _signalLastEmitAt < SIGNAL_MIN_GAP_MS) return; // wall-clock server-rate gate
    if (!_signalPerMinuteOk()) return; // wall-clock server-rate gate

    // Per-recipient cooldown is evaluated in GAME TICKS; without a live tick we
    // cannot know whether the game will accept the intent, so wait rather than
    // release blindly (which is exactly how emojis got silently dropped before).
    const curTick = _signalCurrentTick();
    if (curTick === null) return;

    const ctors = discoverCtors(getEventBus());
    if (!ctors) return;

    // Find the first sendable item (ctor ready + per-recipient game-tick cooldown
    // elapsed). Skipping a cooldown-blocked head keeps a throttled item (TN1's
    // signature broadcast) from starving an urgent one (TN2 SOS).
    let readyIndex = _findReadySignalIndex(ctors, curTick);

    // Drop items blocked past the attempt ceiling (anywhere in the queue).
    readyIndex = _dropExpiredSignals(readyIndex);

    if (readyIndex < 0 || readyIndex >= _signalQueue.length) return;

    _emitReadySignal(readyIndex, ctors, curTick, now);
  }

  function _ensureSignalSchedulerRunning() {
    if (_signalIntervalId !== null) return;
    _signalIntervalId = window.setInterval(_runSignalScheduler, SIGNAL_TICK_MS);
  }

  function enqueueSignal(kind, recipient, args) {
    _signalQueue.push({ kind, recipient, args: args || [], attempts: 0 });
    _ensureSignalSchedulerRunning();
  }
