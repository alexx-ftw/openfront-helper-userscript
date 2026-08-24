// Auto-Bot — AllianceBehavior: a faithful 1:1 port of the in-game Nation
// alliance AI (src/core/execution/nation/NationAllianceBehavior.ts). This class
// is the CORE of diplomatic difficulty scaling — every branch, constant,
// probability, threshold and call order from the source is preserved EXACTLY.
// No summarizing, no simplifying, no new heuristics.
//
// The ONLY changes are the mechanical API substitutions mandated by
// PORT-CONTRACT.md:
//   - DIFFICULTY: src reads `this.game.config().gameConfig().difficulty`; the bot
//     REPLICATES a user-chosen difficulty, so every such read becomes
//     `currentDifficulty()`. EXCEPTION: `config().maxTroops(player)` reads the true
//     lobby difficulty internally — left as-is (it reads real enemy/our stats).
//   - GAME MODE: `gameConfig().gameMode === GameMode.Team` is a real lobby fact —
//     kept reading `this.game.config().gameConfig().gameMode`.
//   - PLAYER IDENTITY: src compares players with `===`; the client wraps players
//     fresh each tick, so identity compares become `.smallID()` compares.
//   - emoji: `this.emojiBehavior.sendEmoji(other, EMOJI_*)` exactly as src (the
//     EMOJI_* number[] constants are shared globals from the emoji phase).
//
// DATA RECONSTRUCTION (the hard part — the client PlayerView lacks the core
// alliance methods src calls: incomingAllianceRequests(), canSendAllianceRequest(),
// allianceWith()/breakAlliance(), and alliances() returns plain AllianceView
// objects WITHOUT onlyOneAgreedToExtend()/other()). These are reconstructed from
// the <events-display>/<actionable-events> plumbing + gameApi. Every such
// reconstruction carries a `// DIVERGENCE:` note.
//
// !!! TOP-LEVEL DIVERGENCE — ALLIANCE EVENT SOURCE/TYPE SKEW (review this) !!!
//   The shipped helper plumbing (old alliance.js + alliance-requests-panel.js)
//   reads `document.querySelector("events-display").events` and treats
//   MessageType ALLIANCE_REQUEST=15 / RENEW_ALLIANCE=24. The CURRENT upstream
//   source (PR #3913 "Improve Notification Panel", commit 41ef675e) MOVED the
//   alliance prompts into a NEW `<actionable-events>` element AND the MessageType
//   enum now gives ALLIANCE_REQUEST=16 / RENEW_ALLIANCE=22. The deployed game may
//   lag `main`, so EITHER scheme can be live. To be robust against both builds
//   without depending on an unverifiable fact, we:
//     - read events from BOTH <events-display> AND <actionable-events>, PLUS the
//       `allianceRequestsPanelEvents` global (de-duped via a WeakSet);
//     - accept request type ∈ {15, 16} and renewal type ∈ {22, 24};
//     - rely on the buttons-present + className "btn"/"btn-info" guards to screen
//       out status events that collide on a number but carry no buttons (e.g.
//       ALLIANCE_REJECTED=15 in the new enum has no buttons).
//   We only ever read ONE live build at a time, so the guards prevent any
//   cross-build misclassification. See ALLIANCE_REQUEST_TYPES / RENEW_TYPES below.
//
// Loaded with the other behavior modules (after portutil/gameApi/context and the
// emoji phase, which provides the EMOJI_* globals + EmojiBehavior), before
// nationExecution. Classic-script shared-global scope (no IIFE): the class name is
// visible to nationExecution.js and must stay unique across the bundle.
//
// Shared globals referenced bare (provided by sibling modules — do NOT redefine):
//   - currentDifficulty(), Difficulty, GameMode, PlayerType, Relation (portutil/gameApi)
//   - getEventBus(), discoverCtors(), emitIntent(), getListenersMap() (context.js)
//   - _ctors (the lazily-learned intent ctor registry — context.js)
//   - setLastAction(), toNum(), safeName(), tr() (engine/helpers/i18n)
//   - EMOJI_CONFUSED / EMOJI_HANDSHAKE / EMOJI_LOVE / EMOJI_SCARED_OF_THREAT (emoji phase)

"use strict";

  // Request/renewal MessageType numbers across both client builds (see header).
  const ALLIANCE_REQUEST_TYPES = new Set([15, 16]); // old / new ALLIANCE_REQUEST
  const RENEW_TYPES = new Set([22, 24]); // new RENEW_ALLIANCE / old RENEW_ALLIANCE

  // Alliance request/renewal event objects we've already actioned this game, so we
  // don't re-accept/re-reject the same one each tick (and to dedupe across the
  // multiple event sources). Same approach as the old alliance.js.
  const _allianceBehaviorActioned = new WeakSet();

  // ---------------------------------------------------------------------------
  // Events-display / actionable-events plumbing (REUSED verbatim from the old
  // alliance.js — actuation ONLY; the strategy comes 1:1 from the src class).
  // ---------------------------------------------------------------------------

  // Captures the SendAllianceRequestIntentEvent constructor by sniffing the
  // EventBus during an accept (the accept button emits exactly that event), so we
  // can later SEND alliance requests proactively. Shape-based ctor discovery can't
  // tell it apart from SendBreakAllianceIntentEvent ({requestor,recipient}).
  function runAndCaptureAllianceCtor(action) {
    const eventBus = getEventBus();
    if (!eventBus || typeof eventBus.emit !== "function" || _ctors.allianceRequest) {
      action();
      return;
    }
    const orig = eventBus.emit;
    eventBus.emit = function (ev) {
      {
        if (
          ev &&
          ev.requestor !== undefined &&
          ev.recipient !== undefined &&
          typeof ev.constructor === "function"
        ) {
          _ctors.allianceRequest = ev.constructor;
        }
      }
      return orig.call(this, ev);
    };
    try {
      action();
    } finally {
      eventBus.emit = orig;
    }
  }

  // Finds every {requestor, recipient}-shaped intent ctor (exactly two exist:
  // SendAllianceRequestIntentEvent and SendBreakAllianceIntentEvent).
  function getAllianceShapeCtors(eventBus) {
    if (_ctors.allianceShapeBus === eventBus && _ctors.allianceShape) {
      return _ctors.allianceShape;
    }
    const found = [];
    const map = getListenersMap(eventBus);
    if (map) {
      const s1 = { __probe: 1 };
      const s2 = { __probe: 2 };
      for (const C of map.keys()) {
        if (typeof C !== "function") continue;
        {
          const inst = new C(s1, s2);
          if (inst && inst.requestor === s1 && inst.recipient === s2) {
            found.push(C);
          }
        }
      }
    }
    _ctors.allianceShape = found;
    _ctors.allianceShapeBus = eventBus;
    return found;
  }

  // Reads alliance request/renewal events from EVERY available source (both client
  // builds + the helper panel global). De-duped by reference downstream via the
  // WeakSet. Returns a flat array of raw event objects.
  function collectAllianceEvents() {
    const events = [];
    for (const sel of ["events-display", "actionable-events"]) {
      {
        const el = document.querySelector(sel);
        if (Array.isArray(el?.events)) events.push(...el.events);
      }
    }
    {
      if (
        typeof allianceRequestsPanelEvents !== "undefined" &&
        Array.isArray(allianceRequestsPanelEvents)
      ) {
        events.push(...allianceRequestsPanelEvents);
      }
    }
    return events;
  }

  // Find a button on an event by className, falling back to positional index.
  // Accept = className "btn" (idx 1), Reject/Ignore = "btn-info" (idx 2). Mirrors
  // the human UI (ActionableEvents.ts button layout: [focus, accept/renew, reject/ignore]).
  function pickAllianceButton(buttons, cls, idx) {
    return (
      buttons.find(
        (b) => b?.className === cls && typeof b.action === "function",
      ) || (typeof buttons[idx]?.action === "function" ? buttons[idx] : null)
    );
  }

  function isDominatedAllianceTarget(player, otherPlayer, difficulty) {
    const protectedEasyHuman =
      difficulty === Difficulty.Easy && otherPlayer.type() === PlayerType.Human;
    if (protectedEasyHuman) return false;
    const ownOutgoingTroops = activeAllianceOutgoingTroops(player);
    const otherOutgoingTroops = activeAllianceOutgoingTroops(otherPlayer);
    return isMuchWeakerAllianceTarget({
      ownTroops: player.troops(),
      ownOutgoingTroops,
      otherTroops: otherPlayer.troops(),
      otherOutgoingTroops,
      advantageRatio: 4,
    });
  }

  class AllianceBehavior {
    constructor(random, game, player, emojiBehavior) {
      this.random = random;
      this.game = game;
      this.player = player;
      this.emojiBehavior = emojiBehavior;
    }

    // isRegularBot — checks if player is a regular game bot (not Nation AI, not human).
    // Game has PlayerType.Bot = "BOT", PlayerType.Nation = "NATION", PlayerType.Human = "HUMAN".
    isRegularBot(player) {
      if (!player) return false;
      {
        if (typeof player.type === "function" && player.type() === "BOT") return true;
        if (player.data && player.data.playerType === "BOT") return true;
      }
      return false;
    }

    // handleAllianceRequests — NationAllianceBehavior.ts:29
    handleAllianceRequests() {
      if (this.game.config().disableAlliances()) return;

      for (const req of this.incomingAllianceRequests()) {
        // Reject ALL requests from regular bots — they spam defensively,
        // blocking attacks against them. Only accept from humans and Nation AI.
        const requestor = req.requestor();
        if (requestor && this.isRegularBot(requestor)) {
          req.reject();
          continue;
        }
        // DIVERGENCE: Companion mode only allies with the boss. Vetoes nothing
        // unless companion is enabled, in Active mode, AND a boss was resolved.
        if (typeof companionAllianceVeto === "function" && companionAllianceVeto(requestor)) {
          req.reject();
          continue;
        }
        // Alliance Request intents created during the spawn phase are executed on
        // the first tick post-spawn phase. With the following condition we reject
        // all requests created during the spawn phase.
        // DIVERGENCE: the client event carries the DISPLAY tick (when the prompt
        // was rendered), not the intent's original createdAt(). req.createdAt()
        // returns that display tick when known; when the event was created during
        // the spawn phase we flag it (req.__createdInSpawnPhase) and force the tick
        // to 0 so this gate rejects it exactly as src would. See incomingAllianceRequests().
        if (req.createdAt() <= this.game.config().numSpawnPhaseTurns() + 1) {
          req.reject();
          continue;
        }
        if (this.getAllianceDecision(requestor, true)) {
          req.accept();
        } else {
          req.reject();
        }
      }
    }

    // Always-on rejection of alliance requests from regular bots. Runs even
    // when the alliance feature toggle is off — regular bots spam alliance
    // requests as a defensive tactic, and accepting blocks attacks against them.
    handleAllianceRequestsFromBots() {
      // Always run — even when alliances feature is off.
      // Regular bots spam alliance requests as a defensive tactic.
      // Defense-in-depth: this runs at tick level, while the panel capture filter
      // prevents Vue from ever seeing bot events.
      for (const ev of collectAllianceEvents()) {
        {
          const requestor = this.resolveEventPlayer(ev);
          if (!requestor) continue;
          if (this.isRegularBot(requestor)) {
            // Force-mark as actioned — prevents alliance handler from accepting
            _allianceBehaviorActioned.add(ev);
          }
        }
      }
    }

    // handleAllianceExtensionRequests — NationAllianceBehavior.ts:48
    renewAllianceEvent(event, human, buttons) {
      const renew = pickAllianceButton(buttons, "btn", 1);
      if (!renew) return;
      {
        renew.action();
        _allianceBehaviorActioned.add(event);
        setLastAction(
          tr("🔁 Renew alliance {name}", { name: safeName(human) }),
          "diplo",
        );
      }
    }

    handleAllianceExtensionEvent(event) {
      const type = Number(event?.type);
      if (!RENEW_TYPES.has(type)) return;
      if (_allianceBehaviorActioned.has(event)) return;
      const buttons = Array.isArray(event.buttons) ? event.buttons : [];
      if (buttons.length === 0) return;
      const human = this.resolveEventPlayer(event);
      if (!human?.isPlayer?.()) return;
      if (
        typeof companionAllianceVeto === "function" &&
        companionAllianceVeto(human)
      ) {
        return;
      }
      if (!this.getAllianceDecision(human, true)) return;
      this.renewAllianceEvent(event, human, buttons);
    }

    handleAllianceExtensionRequests() {
      if (this.game.config().disableAlliances()) return;

      // src iterates this.player.alliances() (rich MutableAlliance objects) and
      // accepts the extension on any where onlyOneAgreedToExtend() is true (i.e.
      // the human ally already requested renewal and we haven't agreed yet).
      //
      // DIVERGENCE: the client PlayerView.alliances() returns plain AllianceView
      // objects ({id, other:PlayerID, createdAt, expiresAt, hasExtensionRequest}) —
      // there is NO onlyOneAgreedToExtend() / other() method, and we cannot tell
      // WHICH side agreed. The presence of a RENEW_ALLIANCE prompt (type 22/24) in
      // the events feed IS the client's surfacing of "the ally requested renewal and
      // it's awaiting our decision" — so we use the renewal EVENT as the proxy for
      // onlyOneAgreedToExtend(), and drive the accept via the event's renew button
      // (which emits SendAllianceExtensionIntentEvent, the same intent src's
      // AllianceExtensionExecution produces). We still run the FULL
      // getAllianceDecision(other, true) gate exactly as src does — NOT the old
      // alliance.js renewal heuristic.
      for (const ev of collectAllianceEvents()) {
        // human = alliance.other(this.player): resolve the renewal event's focusID
        // (the other player's smallID) to a wrapped gameApi player.
        // DIVERGENCE: Companion mode only allies with the boss — also vetoes
        // renewing an alliance already held with a non-boss player (formed
        // before companion mode was enabled, or before the boss was resolved).
        // Placed before getAllianceDecision() below (no this.random.* call
        // precedes it in this function), so when the veto fires it skips that
        // call's RNG draws entirely — same placement rationale as the
        // handleAllianceRequests() guard above.
        // src: this.game.addExecution(new AllianceExtensionExecution(this.player,
        //   human.id())). Client equivalent: click the renew button, whose action()
        //   emits SendAllianceExtensionIntentEvent(other) — the same intent.
        this.handleAllianceExtensionEvent(ev);
      }
    }

    // maybeSendAllianceRequests — NationAllianceBehavior.ts:65
    // Proactive alliance REQUESTS are FFA-only: in Team mode real teammates
    // already exist, and measured basket rows regressed when the ctor
    // name-probe made this historically-inert path live (2 of 3 team wins
    // flipped to losses — ally-gated engine rules then also block our own
    // attacks vs the allied rival team). All Team baselines were measured
    // with the send path inert (ctor unbound), so FFA-only restores exactly
    // the measured-good Team behavior while keeping the FFA protector lane.
    proactiveAllianceSendsAllowed() {
      return String(this.game.config().gameConfig().gameMode) !== "Team";
    }

    maybeSendAllianceRequests(borderingEnemies) {
      if (this.game.config().disableAlliances()) return;
      // Suppress the EMISSION only, never the loop: the loop's RNG draws and
      // emoji side-effects feed the shared PseudoRandom stream — early-
      // returning here shifted every downstream random decision and flipped
      // the team Labyrinth anchor from a win at 19921 to death@8121 (measured;
      // the pre-change loop emitted nothing in practice because the request
      // ctor was null until the name-probe landed). Keeping the draws keeps
      // Team byte-identical while FFA keeps its proactive sends.
      const sendsAllowed = this.proactiveAllianceSendsAllowed();

      // NEVER send alliance requests to regular bots — they spam defensively,
      // blocking attacks against them. Only send to humans and Nation AI.
      for (const enemy of borderingEnemies) {
        if (
          this.random.chance(30) &&
          // DIVERGENCE: Companion mode only allies with the boss.
          // When this veto fires, the RNG draws inside getAllianceDecision()
          // below are short-circuited and never made. This random stream is
          // a client-local bot-decision PRNG (not the synced game simulation),
          // so skipping draws here causes no cross-client desync.
          !(typeof companionAllianceVeto === "function" && companionAllianceVeto(enemy)) &&
          !this.isRegularBot(enemy) &&
          this.canSendAllianceRequest(enemy) &&
          this.getAllianceDecision(enemy, false)
        ) {
          // src: this.game.addExecution(new AllianceRequestExecution(this.player,
          //   enemy.id())). Client equivalent: emit the SendAllianceRequestIntentEvent
          //   ctor ({requestor, recipient}) as (me, enemy).
          // DIVERGENCE (gap G2): the request ctor is learned LAZILY — it is null
          // until we've accepted at least one incoming request (which captures it
          // via runAndCaptureAllianceCtor). Until then proactive sends are
          // suppressed. In a populated lobby an accept happens within seconds.
          const ctors = discoverCtors(getEventBus());
          if (ctors.allianceRequest && sendsAllowed) {
            emitIntent(
              ctors.allianceRequest,
              this.player.__src ?? this.player,
              enemy.__src ?? enemy,
            );
            setLastAction(
              tr("🤝➡️ Send alliance {name}", { name: safeName(enemy) }),
              "diplo",
            );
          }
        }
      }
    }

    // isFarNation — true when `other` is NOT one of our land/narrow-water neighbours
    // (not in nearby()), so it can't threaten us by land → a pure trade partner we ally
    // freely (see the winFix in getAllianceDecision). Cheap + synchronous (no boat
    // probe). On any error we answer FALSE (treat as near) so the faithful case-by-case
    // logic runs rather than a blanket accept.
    isFarNation(other) {
      {
        const sid = other.smallID();
        for (const n of this.player.nearby()) {
          if (n && n.isPlayer && n.isPlayer() && n.smallID() === sid) {
            return false; // bordering neighbour → near
          }
        }
        return true; // not adjacent → far
      }
    }

    // isDominantForDiplomacy — are we dominant enough to STOP making/keeping far
    // alliances and let betray/conquer close the win? Prefer the flag structureBehavior
    // publishes each build-tick (state.dominant), but FALL BACK to computing the share
    // HERE when it isn't a boolean yet (structures disabled, or the structure phase
    // hasn't run) — otherwise an unset flag reads as "not dominant" and we'd keep
    // far-allying past the point the user asked us to stop. Mirrors
    // structureBehavior.dominanceShare + the factoryRailShare trigger — keep in sync.
    calculateDiplomacyTeamTiles() {
      let owned = 0;
      for (const player of this.game.players()) {
        {
          if (player.isPlayer() && this.player.isOnSameTeam(player)) {
            owned += player.numTilesOwned();
          }
        }
      }
      return owned;
    }

    isDominantForDiplomacy() {
      if (!state.settings.winFixes) return false;
      if (typeof state.dominant === "boolean") return state.dominant;
      {
        const isTeam =
          String(this.game.config().gameConfig().gameMode) === "Team";
        const fallout =
          typeof this.game.numTilesWithFallout === "function"
            ? this.game.numTilesWithFallout()
            : 0;
        const denom = (this.game.numLandTiles() || 0) - fallout;
        if (denom <= 0) return false;
        const owned = isTeam
          ? this.calculateDiplomacyTeamTiles()
          : this.player.numTilesOwned();
        const trigger = Number.isFinite(state.settings.factoryRailShare)
          ? state.settings.factoryRailShare
          : 0.75;
        return owned / denom > trigger;
      }
    }

    // reachOutToFarNations — proactively offer an alliance to ONE far, alive, non-bot,
    // non-traitor, not-yet-friendly, requestable nation per throttle window (winFix).
    // Suppressed until the alliance-request ctor is learned (lazily, on our first
    // accept), and skipped once we're dominant (self-gated, below).
    isFarAllianceCandidate(player, mySid) {
      {
        return (
          player.isPlayer?.() &&
          player.smallID() !== mySid &&
          player.isAlive?.() &&
          player.type() !== PlayerType.Bot &&
          this.player.isFriendly(player) !== true &&
          !player.isTraitor?.() &&
          this.isFarNation(player) &&
          this.canSendAllianceRequest(player)
        );
      }
    }

    getFarAllianceCandidates() {
      const mySid = this.player.smallID();
      return this.game.players().filter((player) => this.isFarAllianceCandidate(player, mySid));
    }

    reachOutToFarNations() {
      const now = performance.now();
      const throttle = state.settings.farAllyThrottleMs || 4000;
      if (now - (state.lastFarAllyMs || 0) < throttle) return;
      if (!this.proactiveAllianceSendsAllowed()) return;
      // Self-gate on dominance (computed only AFTER the cheap throttle passes, ~every 4s)
      // so we stop courting far nations the moment we're winning — same gate as the
      // far-accept path, so accept and outreach flip together.
      if (this.isDominantForDiplomacy()) return;

      const ctors = discoverCtors(getEventBus());
      if (!ctors.allianceRequest) return; // ctor not learned yet → can't send proactively

      const candidates = this.getFarAllianceCandidates();
      if (candidates.length === 0) return;

      // Spread outreach across the far field rather than always picking the same one.
      const target = this.random.randElement(candidates);
      // DIVERGENCE: Companion mode only allies with the boss.
      if (typeof companionAllianceVeto === "function" && companionAllianceVeto(target)) return;
      emitIntent(
        ctors.allianceRequest,
        this.player.__src ?? this.player,
        target.__src ?? target,
      );
      setLastAction(
        tr("🤝➡️ Trade-ally {name}", { name: safeName(target) }),
        "diplo",
      );
      state.lastFarAllyMs = now;
      runtimeDebugLog("[Diplo] reach out far →", safeName(target));
    }

    // ── Protector appeasement (FFA survival, Legendary win-fix) ────────────────
    // Death-by-snowball in FFA comes from ONE strong bordering nation rolling
    // us with waves we cannot mirror. An ALLIANCE makes that nation's land AND
    // boat attacks engine-rejected outright (AttackExecution/TransportShip-
    // Execution hard-check isFriendly), and renewals keep it for the whole
    // game. The window is real but narrow: the nation's own decision gate
    // (NationAllianceBehavior.getAllianceDecision, Impossible branch) rejects
    // below-Neutral relations — and OUR attacks (−100 relation) followed by
    // our auto-embargo (permanent −20) poison exactly the strong neighbours
    // we need. So appeasement = court the strongest bordering nation with
    // retried requests (engine cooldown 300 ticks, one pending per recipient),
    // never embargo it, and never send ORDINARY attacks its way (retaliation
    // and incoming-defense lanes are untouched — defending does not poison
    // relation, only our attacks do).
    protectorAppeasementActive() {
      if (state.settings.winFixes !== true) return false;
      if (typeof currentDifficulty !== "function" || currentDifficulty() !== "Legendary") {
        return false;
      }
      if (String(this.game.config().gameConfig().gameMode) !== "FFA") return false;
      const config = this.game.config();
      if (typeof config.disableAlliances === "function" && config.disableAlliances()) {
        return false;
      }
      return true;
    }

    appeasementNationStrength(player) {
      const maxTroops = Number(player.maxTroops?.() ?? Number.NaN);
      if (Number.isFinite(maxTroops) && maxTroops > 0) return maxTroops;
      return Number(player.troops?.() || 0);
    }

    appeasementCandidate(other, mySid, myStrength) {
      if (!other?.isPlayer?.() || other.smallID() === mySid) return null;
      if (other.type() !== PlayerType.Nation) return null;
      if (!other.isAlive?.()) return null;
      if (this.player.isFriendly(other) === true) return null;
      // Only appease UP: a protector we already outmuscle is a conquest
      // target, not a shield.
      const strength = this.appeasementNationStrength(other);
      if (strength < myStrength * 1.25) return null;
      return { other, strength };
    }

    // Ranked protector candidates (strongest first). The courtship reads the
    // LIST, not just the top pick: the nation's own acceptance gate has NO
    // accepting branch at Neutral relation outside its ~60s earlygame window
    // (30% per attempt), and every relation-raising tool (donations, emoji)
    // is ally-gated or Easy-only — so a rejection by the single strongest
    // neighbor is final. Courting several strong neighbors inside the window
    // multiplies the acceptance odds.
    appeasementProtectorCandidates() {
      if (!this.protectorAppeasementActive()) return [];
      const mySid = this.player.smallID();
      const myStrength = this.appeasementNationStrength(this.player);
      const candidates = [];
      for (const neighbour of this.player.nearby()) {
        const candidate = this.appeasementCandidate(neighbour, mySid, myStrength);
        if (candidate !== null) candidates.push(candidate);
      }
      candidates.sort((left, right) => right.strength - left.strength);
      return candidates.map(({ other }) => other);
    }

    appeasementProtector() {
      if (!this.protectorAppeasementActive()) return null;
      const tick = typeof this.game.ticks === "function" ? this.game.ticks() : 0;
      if (this._protectorCacheTick === tick && this._protectorCache !== undefined) {
        return this._protectorCache;
      }
      this._protectorCacheTick = tick;
      this._protectorCache = this.appeasementProtectorCandidates()[0] ?? null;
      return this._protectorCache;
    }

    // The nation-side earlygame acceptance window (~60s post-spawn, 30% per
    // attempt): beyond it, only Friendly relation (unreachable pre-alliance),
    // threat, or near-parity can succeed — court widest while it is open.
    protectorCourtEarlyWindowOpen() {
      const duration = Number(
        this.game?.config?.()?.spawnImmunityDuration?.() ?? 0,
      );
      const tick = typeof this.game.ticks === "function" ? this.game.ticks() : 0;
      return tick <= 600 + duration + 300;
    }

    courtProtectorEligible(protector, now, perRecipientMs) {
      if (typeof companionAllianceVeto === "function" && companionAllianceVeto(protector)) {
        return false;
      }
      const sid = protector.smallID();
      const last = state.protectorCourtAtMs.get(sid) ?? 0;
      return now - last >= perRecipientMs;
    }

    maybeCourtProtectors() {
      if (!this.protectorAppeasementActive()) return;
      const now = performance.now();
      const throttle = state.settings.protectorCourtThrottleMs || 3500;
      if (now - (state.lastProtectorCourtMs || 0) < throttle) return;
      if (this.isDominantForDiplomacy()) return;
      const ctors = discoverCtors(getEventBus());
      if (!ctors.allianceRequest) return;
      // Per-recipient spacing: the engine keeps a pending request alive for
      // allianceRequestDuration and hard-rejects duplicates (measured: 49
      // wasted "cannot send alliance request" warnings on one row).
      if (!state.protectorCourtAtMs) state.protectorCourtAtMs = new Map();
      const perRecipientMs = 31_000;
      const candidates = this.appeasementProtectorCandidates();
      // Court up to 2 fresh recipients per pass inside the earlygame window
      // (rotating through the ranked list), else 1 (top pick only).
      const maxPerPass = Math.min(this.protectorCourtEarlyWindowOpen() ? 2 : 1, 3);
      let sent = 0;
      for (const protector of candidates) {
        if (sent >= maxPerPass) break;
        if (!this.courtProtectorEligible(protector, now, perRecipientMs)) continue;
        emitIntent(
          ctors.allianceRequest,
          this.player.__src ?? this.player,
          protector.__src ?? protector,
        );
        // Pin the courted identity: once the alliance forms the protector is
        // isFriendly and drops out of candidate filtering — the
        // donation-renewal loop still needs to find it.
        const sid = protector.smallID();
        state.protectorSid = sid;
        state.protectorCourtAtMs.set(sid, now);
        state.lastProtectorCourtMs = now;
        setLastAction(
          tr("🛡️➡️ Court protector {name}", { name: safeName(protector) }),
          "diplo",
        );
        runtimeDebugLog("[Diplo] court protector →", safeName(protector));
        sent += 1;
      }
    }

    // The allied protector (pinned at courtship), or null.
    pinnedProtectorAlly() {
      const protectorSid = state.protectorSid;
      if (protectorSid === undefined || protectorSid === null) return null;
      const ally = this.game
        .players()
        .find((p) => p?.isPlayer?.() && p.smallID() === protectorSid);
      if (!ally || !ally.isAlive?.()) return null;
      if (this.player.isFriendly(ally) !== true) return null;
      return ally;
    }

    // A donation amount that guarantees the +50 relation update: the
    // Impossible-branch threshold band is [recipientMax/7, recipientMax/5],
    // so the band ceiling qualifies regardless of the engine's RNG. Returns
    // null when the ally has no headroom for a qualifying gift.
    protectorDonationAmount(ally) {
      const recipientMax = Number(ally.maxTroops?.() ?? Number.NaN);
      if (!Number.isFinite(recipientMax) || recipientMax <= 0) return null;
      const qualifying = Math.floor(recipientMax / 5) + 1;
      const headroom = Math.floor(recipientMax - Number(ally.troops?.() || 0));
      return headroom >= qualifying ? qualifying : null;
    }

    // Donation-renewal loop: a qualifying donation (>= recipientMax/5.. /7
    // troops, DonateTroopExecution.getMinTroopsForRelationUpdate) grants +50
    // relation in the ally toward us, which keeps renewals passing for the
    // whole game (alliances expire after 3000 ticks). Donations are
    // ally-gated engine-side, so this only ever runs AFTER an acceptance —
    // and only from real surplus (never donate below half our army).
    maybeDonateToProtector() {
      if (!this.protectorAppeasementActive()) return;
      const now = performance.now();
      const throttle = state.settings.protectorDonationThrottleMs || 60_000;
      if (now - (state.lastProtectorDonationMs || 0) < throttle) return;
      const ally = this.pinnedProtectorAlly();
      if (ally === null) return;
      const ctors = discoverCtors(getEventBus());
      if (!ctors.donateTroops) return;
      const amount = this.protectorDonationAmount(ally);
      if (amount === null) return;
      const ourTroops = Number(this.player.troops?.() || 0);
      if (ourTroops - amount < Math.max(ourTroops * 0.5, 1)) return;
      if (emitIntent(ctors.donateTroops, ally.__src ?? ally, amount) !== true) {
        return;
      }
      state.lastProtectorDonationMs = now;
      setLastAction(
        tr("🤝➡️ Reinforce protector {name}", { name: safeName(ally) }),
        "diplo",
      );
      runtimeDebugLog("[Diplo] donate to protector →", safeName(ally), amount);
    }

    // getAllianceDecision — NationAllianceBehavior.ts:88 (THE decision tree)
    shouldRejectTraitorAlliance(otherPlayer, isResponse) {
      if (!otherPlayer.isTraitor() || this.random.nextInt(0, 100) < 10) return false;
      if (isResponse && this.random.chance(3)) {
        this.emojiBehavior.sendEmoji(otherPlayer, EMOJI_CONFUSED);
      }
      return true;
    }

    getFarNationAllianceDecision(otherPlayer, isResponse) {
      if (!state.settings.winFixes || !this.isFarNation(otherPlayer)) return null;
      if (this.isDominantForDiplomacy()) return false;
      if (isResponse) runtimeDebugLog("[Diplo] far accept →", safeName(otherPlayer));
      return true;
    }

    acceptThreatAlliance(otherPlayer, isResponse) {
      if (!isResponse && this.random.chance(6)) {
        this.emojiBehavior.sendEmoji(otherPlayer, EMOJI_SCARED_OF_THREAT);
      }
      if (isResponse && this.random.chance(6)) {
        this.emojiBehavior.sendEmoji(otherPlayer, EMOJI_LOVE);
      }
      return true;
    }

    rejectBadRelationAlliance(otherPlayer, isResponse) {
      if (isResponse && this.random.chance(3)) {
        this.emojiBehavior.sendEmoji(otherPlayer, EMOJI_CONFUSED);
      }
      return false;
    }

    acceptFriendlyAlliance(otherPlayer) {
      if (this.random.chance(3)) {
        this.emojiBehavior.sendEmoji(otherPlayer, EMOJI_HANDSHAKE);
      }
      return true;
    }

    getAllianceDecision(otherPlayer, isResponse) {
      // HARD GATE: NEVER accept alliances with regular bots (type="BOT").
      // Regular bots spam alliance requests defensively, blocking attacks against them.
      if (this.isRegularBot(otherPlayer)) return false;
      // Easy (dumb) nations sometimes get confused and accept/reject randomly (Just like dumb humans do)
      if (this.isConfused()) {
        return this.random.chance(2);
      }
      // Nearly always reject traitors
      if (this.shouldRejectTraitorAlliance(otherPlayer, isResponse)) return false;
      // SMART DIPLOMACY (winFix): a FAR nation (one we do NOT border — see isFarNation)
      // can't threaten us by land. While we're still expanding we ally it FREELY — pure
      // defence: it keeps a distant nation from turning hostile and raiding our longest,
      // most lucrative trade routes (we already rejected traitors above). Once we're
      // DOMINANT we do the OPPOSITE — REJECT far requests AND far renewals (this gate also
      // runs on the renewal path) so those alliances LAPSE and the boat-conquest / betray
      // logic can take their land to finish the win (user's choice: "stop when dominant").
      // NEAR nations always fall through to the faithful tree below (threats / targets).
      const farDecision = this.getFarNationAllianceDecision(otherPlayer, isResponse);
      if (farDecision !== null) return farDecision;
      // Reject if otherPlayer has allied with a lot of players (Hard and Impossible only)
      // To make sure there are enough non-friendly players in the game to stop the crown with nukes
      if (this.hasTooManyAlliances(otherPlayer)) {
        return false;
      }
      // Before caring about the relation, first check if the otherPlayer is a threat
      // Easy (dumb) nations are blinded by hatred, they don't care about threats, they care about the relation
      // Impossible (smart) nations on the other hand are analyzing the facts
      if (this.isAlliancePartnerThreat(otherPlayer)) {
        return this.acceptThreatAlliance(otherPlayer, isResponse);
      }
      // Maybe reject if we are in a team game (allying makes less sense there)
      if (this.shouldRejectInTeamGame()) {
        return false;
      }
      // Reject if relation is bad
      if (this.player.relation(otherPlayer) < Relation.Neutral) {
        return this.rejectBadRelationAlliance(otherPlayer, isResponse);
      }
      // Maybe accept if relation is friendly
      if (this.isAlliancePartnerFriendly(otherPlayer)) {
        return this.acceptFriendlyAlliance(otherPlayer);
      }
      // Reject if we already have some alliances, we don't want to ally with the entire map
      if (this.checkAlreadyEnoughAlliances(otherPlayer)) {
        return false;
      }
      // Maybe accept if we are in the earlygame
      if (this.isEarlygame()) {
        return true;
      }
      // Accept if we are similarly strong
      return this.isAlliancePartnerSimilarlyStrong(otherPlayer);
    }

    // hasTooManyAlliances — NationAllianceBehavior.ts:150
    hasTooManyAlliances(otherPlayer) {
      const difficulty = currentDifficulty();
      if (!isAtLeastHardDifficulty(difficulty)) {
        return false;
      }

      const totalPlayers = this.game
        .players()
        .filter((p) => p.type() !== PlayerType.Bot).length;
      const otherPlayerAlliances = otherPlayer.alliances().length;

      if (difficulty === Difficulty.Hard) {
        return otherPlayerAlliances >= totalPlayers * 0.5;
      } else {
        return otherPlayerAlliances >= totalPlayers * 0.25;
      }
    }

    // isConfused — NationAllianceBehavior.ts:171
    isConfused() {
      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
          return this.random.chance(10); // 10% chance to be confused on easy
        case Difficulty.Medium:
          return this.random.chance(20); // 5% chance to be confused on medium
        case Difficulty.Hard:
          return this.random.chance(40); // 2.5% chance to be confused on hard
        case Difficulty.Impossible:
        case Difficulty.Legendary:
          return false; // No confusion on impossible
        default:
          return assertNever(difficulty);
      }
    }

    // isEarlygame — NationAllianceBehavior.ts:187
    isEarlygame() {
      const spawnTicks = this.game.config().numSpawnPhaseTurns();
      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
          // On easy, accept 90% in the first 5 minutes
          return (
            this.game.ticks() < 3000 + spawnTicks &&
            this.random.nextInt(0, 100) >= 10
          );
        case Difficulty.Medium:
          // On medium, accept 70% in the first 3 minutes
          return (
            this.game.ticks() < 1800 + spawnTicks &&
            this.random.nextInt(0, 100) >= 30
          );
        case Difficulty.Hard:
          // On hard, accept 50% in the first 3 minutes
          return (
            this.game.ticks() < 1800 + spawnTicks &&
            this.random.nextInt(0, 100) >= 50
          );
        case Difficulty.Impossible:
        case Difficulty.Legendary:
          // On impossible, accept 30% in the first minute
          return (
            this.game.ticks() < 600 + spawnTicks &&
            this.random.nextInt(0, 100) >= 70
          );
        default:
          return assertNever(difficulty);
      }
    }

    // isAlliancePartnerThreat — NationAllianceBehavior.ts:220
    isAlliancePartnerThreat(otherPlayer) {
      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
          // On easy we are very dumb, we don't see anybody as a threat
          return false;
        case Difficulty.Medium:
          // On medium we just see players with much more troops as a threat
          return otherPlayer.troops() > this.player.troops() * 2.5;
        case Difficulty.Hard:
          // On hard we are smarter, we check for maxTroops to see the actual strength
          // NOTE: config().maxTroops reads the REAL lobby difficulty internally
          // (true stats) — left as-is per PORT-CONTRACT.
          return (
            otherPlayer.troops() > this.player.troops() &&
            this.game.config().maxTroops(otherPlayer) >
              this.game.config().maxTroops(this.player) * 2
          );
        case Difficulty.Impossible:
        case Difficulty.Legendary: {
          // On impossible we check for multiple factors and try to not mess with stronger players (we want to steamroll over weaklings)
          const otherHasMoreTroops =
            otherPlayer.troops() > this.player.troops() * 1.5;
          const otherHasMoreMaxTroops =
            otherPlayer.troops() > this.player.troops() &&
            this.game.config().maxTroops(otherPlayer) >
              this.game.config().maxTroops(this.player) * 1.5;
          const otherHasMoreTiles =
            otherPlayer.troops() > this.player.troops() &&
            otherPlayer.numTilesOwned() > this.player.numTilesOwned() * 1.5;
          return otherHasMoreTroops || otherHasMoreMaxTroops || otherHasMoreTiles;
        }
        default:
          return assertNever(difficulty);
      }
    }

    // shouldRejectInTeamGame — NationAllianceBehavior.ts:254
    shouldRejectInTeamGame() {
      // gameMode is a real lobby fact — read it directly (NOT currentDifficulty()).
      if (this.game.config().gameConfig().gameMode !== GameMode.Team) {
        return false;
      }

      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
          return this.random.nextInt(0, 100) < 25; // 25% chance to reject on easy
        case Difficulty.Medium:
          return this.random.nextInt(0, 100) < 50; // 50% chance to reject on medium
        case Difficulty.Hard:
          return this.random.nextInt(0, 100) < 75; // 75% chance to reject on hard
        case Difficulty.Impossible:
        case Difficulty.Legendary:
          return true; // 100% chance to reject on impossible
        default:
          return assertNever(difficulty);
      }
    }

    // checkAlreadyEnoughAlliances — NationAllianceBehavior.ts:274
    checkAlreadyEnoughAlliances(otherPlayer) {
      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
          return false; // On easy we never think we have enough alliances
        case Difficulty.Medium:
          return this.player.alliances().length >= this.random.nextInt(4, 6);
        case Difficulty.Hard:
        case Difficulty.Impossible:
        case Difficulty.Legendary: {
          // On hard and impossible we try to not ally with all our neighbors (If we have 2+ neighbors)
          const borderingPlayers = this.player
            .nearby()
            .filter((n) => n.isPlayer() && n.type() !== PlayerType.Bot);
          const borderingFriends = borderingPlayers.filter(
            (o) => this.player?.isFriendly(o) === true,
          );
          // src: borderingPlayers.includes(otherPlayer) — identity. The wrapped
          // players are fresh objects each tick, so compare by smallID().
          if (
            borderingPlayers.length >= 2 &&
            borderingPlayers.some(
              (p) => p.smallID() === otherPlayer.smallID(),
            )
          ) {
            return borderingPlayers.length <= borderingFriends.length + 1;
          }
          if (difficulty === Difficulty.Hard) {
            return this.player.alliances().length >= this.random.nextInt(3, 5);
          }
          return this.player.alliances().length >= this.random.nextInt(2, 4);
        }
        default:
          return assertNever(difficulty);
      }
    }

    // isAlliancePartnerFriendly — NationAllianceBehavior.ts:308
    isAlliancePartnerFriendly(otherPlayer) {
      const difficulty = currentDifficulty();
      switch (difficulty) {
        case Difficulty.Easy:
        case Difficulty.Medium:
          return this.player.relation(otherPlayer) === Relation.Friendly;
        case Difficulty.Hard:
          return (
            this.player.relation(otherPlayer) === Relation.Friendly &&
            this.random.nextInt(0, 100) >= 17
          );
        case Difficulty.Impossible:
        case Difficulty.Legendary:
          return (
            this.player.relation(otherPlayer) === Relation.Friendly &&
            this.random.nextInt(0, 100) >= 33
          );
        default:
          return assertNever(difficulty);
      }
    }

    // isAlliancePartnerSimilarlyStrong — NationAllianceBehavior.ts:330
    // It would make a lot of sense to use nextFloat here, but "there's a chance floats can cause desyncs"
    isAlliancePartnerSimilarlyStrong(otherPlayer) {
      const difficulty = currentDifficulty();
      const troopPercentRangeByDifficulty = {
        [Difficulty.Easy]: [60, 70],
        [Difficulty.Medium]: [70, 80],
        [Difficulty.Hard]: [75, 85],
        [Difficulty.Impossible]: [80, 90],
        [Difficulty.Legendary]: [85, 95],
      };
      const tilePercentRangeByDifficulty = {
        [Difficulty.Easy]: [70, 80],
        [Difficulty.Medium]: [80, 90],
        [Difficulty.Hard]: [85, 95],
        [Difficulty.Impossible]: [90, 100],
        [Difficulty.Legendary]: [95, 100],
      };

      const troopRange = troopPercentRangeByDifficulty[difficulty];
      const tileRange = tilePercentRangeByDifficulty[difficulty];

      const playerOutgoingTroops = activeAllianceOutgoingTroops(this.player);
      const otherOutgoingTroops = activeAllianceOutgoingTroops(otherPlayer);
      const playerTotalTroops = this.player.troops() + playerOutgoingTroops;
      const otherTotalTroops = otherPlayer.troops() + otherOutgoingTroops;

      const troopThreshold =
        playerTotalTroops *
        (this.random.nextInt(troopRange[0], troopRange[1]) / 100);
      const tileThreshold =
        this.player.numTilesOwned() *
        (this.random.nextInt(tileRange[0], tileRange[1]) / 100);

      const hasComparableTroops = otherTotalTroops > troopThreshold;
      const hasComparableTiles =
        otherPlayer.numTilesOwned() > tileThreshold &&
        otherTotalTroops > playerTotalTroops * 0.5;
      return hasComparableTroops || hasComparableTiles;
    }

    // maybeBetray — NationAllianceBehavior.ts:371
    shouldBetrayWeakHardPlayer(otherPlayer, difficulty) {
      if (difficulty === Difficulty.Easy || difficulty === Difficulty.Medium) return false;
      const maxTroops = this.game.config().maxTroops(otherPlayer);
      const outgoingTroops = activeAllianceOutgoingTroops(otherPlayer);
      return (
        otherPlayer.troops() + outgoingTroops < maxTroops * 0.2 &&
        otherPlayer.troops() < this.player.troops()
      );
    }

    shouldBetrayWeakEasyPlayer(otherPlayer, difficulty) {
      const easyOrMedium = difficulty === Difficulty.Easy || difficulty === Difficulty.Medium;
      const protectedHuman =
        difficulty === Difficulty.Easy && otherPlayer.type() === PlayerType.Human;
      return easyOrMedium && !protectedHuman && this.player.troops() >= otherPlayer.troops() * 10;
    }

    shouldBetrayTraitor(otherPlayer, difficulty) {
      return (
        difficulty !== Difficulty.Easy &&
        otherPlayer.isTraitor() &&
        otherPlayer.troops() < this.player.troops() * 1.2
      );
    }

    shouldBetrayOnlyBorder(otherPlayer, borderingPlayerCount, difficulty) {
      return (
        difficulty !== Difficulty.Easy &&
        borderingPlayerCount === 1 &&
        otherPlayer.troops() * 3 < this.player.troops()
      );
    }

    maybeBetray(otherPlayer, borderingPlayerCount) {
      // USER TOGGLE ("betray" OFF) → the bot stays LOYAL and never INITIATES a betrayal.
      // This is the single chokepoint: the alliance-break (this.betray) AND the follow-up
      // attack (maybeBetrayAndAttack only attacks a friend when this returns true) both
      // pass through here. Defensive retaliation against someone ALREADY attacking us is a
      // separate path (the `retaliate` strategy) and stays enabled.
      if (state.settings.features?.betray === false) {
        return false;
      }
      if (!this.player.isAlliedWith(otherPlayer)) return false;

      const difficulty = currentDifficulty();
      // Relative weakness is the decisive conquest signal. The old policy only
      // compared the ally with its own maxTroops (or required it to be our sole
      // neighbour), which protected allies that were tiny compared with us but
      // still moderately filled relative to their much smaller capacity.
      if (isDominatedAllianceTarget(this.player, otherPlayer, difficulty)) {
        return this.betray(otherPlayer);
      }

      // Betray very weak players (For example MIRVed ones)
      if (this.shouldBetrayWeakHardPlayer(otherPlayer, difficulty)) return this.betray(otherPlayer);

      // Betray very weak players (similar check as above but for the easier difficulties)
      // This doesn't check for maxTroops and isn't really smart. It makes nations vulnerable, but that's intended.
      // On easy, don't betray humans
      if (this.shouldBetrayWeakEasyPlayer(otherPlayer, difficulty)) return this.betray(otherPlayer);

      // Betray traitors who aren't significantly stronger than us
      if (this.shouldBetrayTraitor(otherPlayer, difficulty)) return this.betray(otherPlayer);

      // Betray our only bordering player if we are much stronger than them
      if (this.shouldBetrayOnlyBorder(otherPlayer, borderingPlayerCount, difficulty)) {
        return this.betray(otherPlayer);
      }

      return false;
    }

    // betray — NationAllianceBehavior.ts:430
    betray(target) {
      // src: const alliance = this.player.allianceWith(target); if (!alliance)
      //   return; this.player.breakAlliance(alliance);
      //
      // DIVERGENCE: the client PlayerView exposes neither allianceWith() nor
      // breakAlliance(). The break intent is the {requestor, recipient}-shape ctor
      // that is NOT the (lazily-learned) request ctor — exactly as the old
      // alliance.js distinguishes them via getAllianceShapeCtors(). We first
      // confirm we ARE allied with the target (src's allianceWith() != null
      // precondition) using isAlliedWith(), then emit the break intent as
      // (me, target). Guarded: if we haven't yet learned the request ctor (so we
      // can't disambiguate the two shape ctors) or the break ctor isn't found, this
      // is a no-op — by the time we have an ally to betray we've accepted at least
      // once, so the request ctor is learned.
      if (!this.player.isAlliedWith(target)) return false;

      const eventBus = getEventBus();
      if (!eventBus) return false;
      if (!_ctors.allianceRequest) return false;
      const shape = getAllianceShapeCtors(eventBus);
      const breakCtor = shape.find((c) => c !== _ctors.allianceRequest);
      if (!breakCtor) return false;
      const emitted = emitIntent(
        breakCtor,
        this.player.__src ?? this.player,
        target.__src ?? target,
      );
      if (!emitted) return false;
      setLastAction(
        tr("🗡️ Betray {name}", { name: safeName(target) }),
        "diplo",
      );
      return true;
    }

    // -------------------------------------------------------------------------
    // Reconstructions of core Player methods the client PlayerView lacks.
    // -------------------------------------------------------------------------

    // incomingAllianceRequests — reconstructs src Player.incomingAllianceRequests()
    // (returns AllianceRequest[] with requestor()/createdAt()/accept()/reject()).
    // DIVERGENCE: not available on the client PlayerView. We rebuild each request
    // from the type-15/16 ALLIANCE_REQUEST events in the events feed (BOTH
    // <events-display> and <actionable-events>, plus the helper panel global). Each
    // reconstructed request exposes:
    //   - requestor(): the wrapped gameApi player resolved from event.focusID
    //       (the requestor's smallID, per ActionableEvents.ts:238) via
    //       game.playerBySmallID; falls back to a players() smallID match.
    //   - createdAt(): the event's DISPLAY tick (event.createdAt) when present.
    //       The src value is the intent's original createdAt — the client event does
    //       NOT carry that. When the event has no tick AND we are still in the spawn
    //       phase, we approximate "created during spawn phase" by returning 0 and set
    //       req.__createdInSpawnPhase = true (so the spawn-phase reject gate fires).
    //   - accept(): invokes the event's accept button (className "btn", idx 1) AND
    //       captures the request ctor (runAndCaptureAllianceCtor) like the human UI.
    //   - reject(): invokes the event's reject button (className "btn-info", idx 2).
    // De-dupes already-actioned events via the shared WeakSet so we don't re-action
    // the same prompt each tick.
    incomingAllianceRequests() {
      const out = [];
      const inSpawn = (() => {
        {
          return this.game.inSpawnPhase() === true;
        }
      })();
      for (const ev of collectAllianceEvents()) {
        const t = Number(ev?.type);
        if (!ALLIANCE_REQUEST_TYPES.has(t)) continue;
        if (_allianceBehaviorActioned.has(ev)) continue;
        const buttons = Array.isArray(ev.buttons) ? ev.buttons : [];
        if (buttons.length === 0) continue; // status events (e.g. rejected) carry no buttons

        const requestor = this.resolveEventPlayer(ev);
        if (!requestor || !requestor.isPlayer || !requestor.isPlayer()) continue;

        // createdAt reconstruction (see method comment / DIVERGENCE above).
        let createdInSpawnPhase = false;
        let createdAtTick;
        const rawTick = Number(ev?.createdAt);
        if (Number.isFinite(rawTick)) {
          createdAtTick = rawTick;
        } else if (inSpawn) {
          createdAtTick = 0;
          createdInSpawnPhase = true;
        } else {
          // DIVERGENCE: no tick on the event and not in spawn phase — fall back to
          // the current tick (treat as freshly created post-spawn, so the spawn
          // reject gate does NOT fire). This matches the common case (a live
          // request prompt the human would see now).
          createdAtTick = (() => {
            {
              return this.game.ticks();
            }
          })();
        }

        out.push({
          __ev: ev,
          __createdInSpawnPhase: createdInSpawnPhase,
          requestor: () => requestor,
          createdAt: () => createdAtTick,
          accept: () => {
            const accept = pickAllianceButton(buttons, "btn", 1);
            if (!accept) return;
            {
              runAndCaptureAllianceCtor(() => accept.action());
              _allianceBehaviorActioned.add(ev);
              setLastAction(
                tr("🤝 Alliance {name}", { name: safeName(requestor) }),
                "diplo",
              );
            }
          },
          reject: () => {
            const reject = pickAllianceButton(buttons, "btn-info", 2);
            if (!reject) return;
            {
              reject.action();
              _allianceBehaviorActioned.add(ev);
            }
          },
        });
      }
      return out;
    }

    // canSendAllianceRequest — reconstructs src Player.canSendAllianceRequest(other).
    // DIVERGENCE: not surfaced on the client PlayerView wrapper. The src method
    // returns false when: not alive, already allied, on the same team, already an
    // outgoing request pending, or already requesting from us. We reproduce the
    // checks reproducible client-side (isAlive + isAlliedWith + isOnSameTeam +
    // isRequestingAllianceWith). If the underlying client view exposes the exact
    // method we prefer it.
    canSendAllianceRequest(other) {
      const src = this.player.__src;
      if (src && typeof src.canSendAllianceRequest === "function") {
        {
          return src.canSendAllianceRequest(other.__src ?? other);
        }
      }
      {
        if (other.isAlive && other.isAlive() === false) return false;
        if (this.player.isAlliedWith(other)) return false;
        if (this.player.isOnSameTeam && this.player.isOnSameTeam(other)) {
          return false;
        }
        if (
          this.player.isRequestingAllianceWith &&
          this.player.isRequestingAllianceWith(other)
        ) {
          return false;
        }
      }
      return true;
    }

    // resolveEventPlayer — resolve an alliance event's focusID (the OTHER player's
    // smallID — requestor for type 15/16, ally for type 22/24, per
    // ActionableEvents.ts:179/238) to a wrapped gameApi player. Tries
    // game.playerBySmallID first, then a players() smallID scan as a fallback.
    resolveEventPlayer(ev) {
      const sid = Number(ev?.focusID);
      if (!Number.isFinite(sid)) return null;
      let p;
      {
        p = this.game.playerBySmallID ? this.game.playerBySmallID(sid) : null;
      }
      if (p && p.isPlayer && p.isPlayer()) return p;
      {
        for (const cand of this.game.players()) {
          if (cand.smallID() === sid) return cand;
        }
      }
      return null;
    }
  }

  // assertNever — src/core/Util.ts. Preserves the exhaustive-switch contract; the
  // default branches in the difficulty switches above are unreachable
  // (currentDifficulty() always returns one of the four Difficulty values). No
  // sibling module defines this name, so the top-level declaration is unique in
  // the shared classic-script scope.
  function assertNever(x) {
    throw new Error("Unexpected difficulty: " + String(x));
  }
