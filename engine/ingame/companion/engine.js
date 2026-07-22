// Companion Bot — engine: scheduling and policy. Decides WHEN the primitives in
// actions.js run, drains them through a single rate-limited queue, and exposes
// the two guarded hooks the auto-bot calls in Active mode.
//
// Classic-script shared scope; nothing runs at load time except the bridge
// assignment at the bottom, which is a plain property write and cannot throw.

"use strict";

  // Minimum spacing between two outgoing intents. Keeps a burst of emoji commands
  // from looking like a packet flood.
  const COMPANION_MIN_SEND_GAP_MS = 300;
  // Hard ceiling on pending actions. The drain rate (~2/s) outruns the game's own
  // 5s-per-recipient emoji cooldown, so this should never bind — but an unbounded
  // queue would turn any future burst into a growing backlog of minutes-old orders.
  const COMPANION_QUEUE_LIMIT = 32;
  const COMPANION_LOG_LIMIT = 100;
  // Server rejects any donation to a recipient within donateCooldown (100 ticks =
  // 10s) of the previous one, TROOPS AND GOLD SHARE this window (PlayerImpl
  // sentDonations). So both go through one shared "donateAny" gap; 11s = server
  // 10s + 1s margin for tick granularity + latency.
  const COMPANION_DONATE_MIN_GAP_MS = 11000;
  const COMPANION_DONATE_GOLD_COOLDOWN_MS = 30000;
  const COMPANION_FACTORY_COOLDOWN_MS = 5000;
  const COMPANION_RENEW_COOLDOWN_MS = 5000;
  const COMPANION_SPAWN_TICK_MS = 300;
  const COMPANION_ACTIONS_REFRESH_MS = 1000;
  const COMPANION_ACTIONS_TIMEOUT_MS = 1500;
  const COMPANION_DONATE_CONFIRM_TIMEOUT_MS = 12000;

  // ---------------------------------------------------------------------------
  // Log
  // ---------------------------------------------------------------------------

  function companionLog(message) {
    companionState.log.unshift({ at: Date.now(), text: String(message) });
    if (companionState.log.length > COMPANION_LOG_LIMIT) {
      companionState.log.length = COMPANION_LOG_LIMIT;
    }
  }

  // ---------------------------------------------------------------------------
  // Action queue
  // ---------------------------------------------------------------------------

  function companionEnqueue(label, fn) {
    if (companionState.queue.length >= COMPANION_QUEUE_LIMIT) {
      companionState.queue.shift();
      companionLog("⚠ queue full, dropped the oldest action");
    }
    companionState.queue.push({ label: String(label), fn: fn });
  }

  // Run at most one queued action, respecting the minimum gap. Returns how many
  // ran (0 or 1). A throwing action is dropped rather than retried, so one bad
  // action can never wedge the queue.
  function companionDrainQueue(now) {
    if (companionState.queue.length === 0) return 0;
    if (now - companionState.lastSendAt < COMPANION_MIN_SEND_GAP_MS) return 0;
    const item = companionState.queue.shift();
    companionState.lastSendAt = now;
    item.fn();
    return 1;
  }

  // Everything that is only meaningful inside ONE match. A companion left enabled
  // across a game boundary would otherwise carry its gold baseline, cooldowns and
  // seen-emoji keys into the next match — measured effect: gold donations dropped
  // from 10 per 5 minutes to 1, because the stale baseline swallowed the whole new
  // game's income.
  //
  // `paused` and `autobotWasEnabled` are deliberately NOT reset here. Pausing is
  // an explicit instruction from the player, not match state, and auto-join can
  // start the next match on its own — clearing it here would let one feature of
  // this script silently undo the stop button of another.
  function companionResetRunState() {
    companionState.cooldowns = {};
    companionState.seenEmoji.length = 0;
    companionState.queue.length = 0;
    companionState.lastGoldSnapshot = 0;
    companionState.goldAtFactoryLevel = 0;
    companionState.lastSpawnTile = null;
    companionState.lastBossSpawnTile = null;
    companionState.factoryLevel = 0;
    companionState.bossSmallID = null;
    companionState.bossStatus = "idle";
    companionState.lastSendFailedAt = 0;
    companionState.bossCanDonateGold = false;
    companionState.bossCanDonateTroops = false;
    companionState.actionsInFlight = false;
    companionState.lastActionsAt = 0;
    companionState.bossDonateConfirmed = true;
    companionState.donateUnconfirmedSince = 0;
  }

  function companionCooldownReady(key, ms, now) {
    const last = companionState.cooldowns[key];
    if (last == null) return true;
    return now - last >= ms;
  }

  function companionMarkCooldown(key, now) {
    companionState.cooldowns[key] = now;
  }

  // The server is authoritative for the shared gold/troop donation cooldown.
  // Keep an optimistic local hold until the server acknowledges it, preventing
  // two queue entries from spending the same server-side donation window.
  function companionApplyBossActions(serverGold, serverTroops) {
    const gold = Boolean(serverGold);
    const troops = Boolean(serverTroops);
    if (!companionState.bossDonateConfirmed) {
      if (!gold || !troops) {
        companionState.bossDonateConfirmed = true;
      } else if (
        Date.now() - (companionState.donateUnconfirmedSince || 0) >
        COMPANION_DONATE_CONFIRM_TIMEOUT_MS
      ) {
        companionState.bossDonateConfirmed = true;
      } else {
        return;
      }
    }
    companionState.bossCanDonateGold = gold;
    companionState.bossCanDonateTroops = troops;
  }

  function companionMarkDonated() {
    companionState.bossCanDonateGold = false;
    companionState.bossCanDonateTroops = false;
    companionState.bossDonateConfirmed = false;
    companionState.donateUnconfirmedSince = Date.now();
  }

  function companionRefreshBossActions(game, me, boss) {
    const now = Date.now();
    if (companionState.actionsInFlight) return;
    if (now - (companionState.lastActionsAt || 0) < COMPANION_ACTIONS_REFRESH_MS) return;
    if (!me || typeof me.actions !== "function") return;
    if (!boss || typeof boss.nameLocation !== "function") return;
    if (!game || typeof game.ref !== "function") return;
    const location = boss.nameLocation();
    if (!location) return;
    const bossTile = game.ref(location.x, location.y);
    if (bossTile === null || bossTile === undefined) return;
    const result = me.actions(bossTile, null);
    const pending = typeof withTimeout === "function"
      ? withTimeout(result, COMPANION_ACTIONS_TIMEOUT_MS, null)
      : Promise.resolve(result);
    companionState.actionsInFlight = true;
    companionState.lastActionsAt = now;
    Promise.resolve(pending)
      .then(function (actions) {
        if (!actions || !actions.interaction) return;
        companionApplyBossActions(
          actions.interaction.canDonateGold,
          actions.interaction.canDonateTroops,
        );
      })
      .finally(function () {
        companionState.actionsInFlight = false;
      });
  }

  // ---------------------------------------------------------------------------
  // Game access
  // ---------------------------------------------------------------------------

  function companionGame() {
    if (typeof getOpenFrontGameContext === "function") {
      const ctx = getOpenFrontGameContext();
      if (ctx && ctx.game) return ctx.game;
    }
    return null;
  }

  // GameView does not expose isCatchingUp() on every build, so this is a guarded
  // probe rather than a direct call.
  function companionIsCatchingUp(game) {
    return typeof game.isCatchingUp === "function" && game.isCatchingUp() === true;
  }

  // Resolve the boss and cache its smallID for the hooks (which run on the
  // auto-bot's clock, not ours).
  function companionRefreshBoss(game) {
    const res = companionResolveBoss(game, companionSettings().bossName);
    companionState.bossStatus = res.status;
    companionState.bossSmallID = null;
    if (res.boss) companionState.bossSmallID = res.boss.smallID();
    return res.boss;
  }

  // ---------------------------------------------------------------------------
  // Auto-bot policy
  // ---------------------------------------------------------------------------

  // Companion only ever FORCES the auto-bot off; it never switches it on except
  // to hand back exactly the state it took. __OFH_autobot.set() persists to
  // localStorage, so a policy that forced `true` would permanently enable an
  // auto-bot the user had left off.
  //
  //   suppress = companion on AND (passive mode OR paused)
  //     suppress && !suppressed → remember current enabled, set off, mark suppressed
  //    !suppress &&  suppressed → set back to remembered value, clear the mark
  //
  // Called from setCompanionEnabled, the panel's Mode change, and pause/resume.
  function companionSyncAutobot() {
    const bridge = window.__OFH_autobot || null;
    if (!bridge || typeof bridge.set !== "function") return;

    const s = companionSettings();
    const suppress =
      companionState.enabled && (s.mode === "passive" || companionState.paused);

    if (suppress && !companionState.autobotSuppressed) {
      const wasOn = typeof bridge.get === "function" && Boolean(bridge.get().enabled);
      companionState.autobotWasEnabled = wasOn;
      companionState.autobotSuppressed = true;
      bridge.set({ enabled: false });
    } else if (!suppress && companionState.autobotSuppressed) {
      companionState.autobotSuppressed = false;
      bridge.set({ enabled: companionState.autobotWasEnabled });
    }
  }

  // ---------------------------------------------------------------------------
  // Emoji-driven actions
  // ---------------------------------------------------------------------------

  function companionRunAction(actionId, ctx) {
    const s = companionSettings();
    switch (actionId) {
      case "donateAllGold":
        return companionDonateGold(ctx.me, ctx.boss, 100);
      case "donateAllTroops":
        return companionDonateTroops(ctx.me, ctx.boss, 100);
      case "requestAlliance":
        return companionRequestAlliance(ctx.boss);
      case "breakAlliance":
        return companionBreakAlliance(ctx.boss);
      case "attackBossTarget":
        return companionAttackBossTarget(ctx.game, ctx.me, ctx.boss, s.troopSendPct);
      case "buildFactory":
        return companionBuildOrUpgradeFactory(ctx.game, ctx.me);
      case "pause":
        companionState.paused = true;
        companionSyncAutobot();
        return true;
      case "resume":
        companionState.paused = false;
        companionSyncAutobot();
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Hooks called by the auto-bot (Active mode only)
  // ---------------------------------------------------------------------------

  // "We have already taken a spawn." hasSpawned() is the real answer; on a build
  // where PlayerView does not expose it, fall back to "we already picked a tile",
  // which is weaker (a rejected spawn is never retried) but still stops the
  // relinquish/re-conquer loop.
  function companionSpawnSettled(me) {
    if (me && typeof me.hasSpawned === "function") {
      return me.hasSpawned() === true;
    }
    return companionState.lastSpawnTile != null;
  }

  // Ensure the auto-bot's own spawn logic is active, without writing to
  // localStorage on every tick — only set what is not already set.
  function companionForceAutobotSpawn() {
    const bridge = window.__OFH_autobot || null;
    if (!bridge || typeof bridge.set !== "function") return;
    const cur = typeof bridge.get === "function" ? bridge.get() : null;
    const patch = {};
    const spawnOn = cur && cur.features && cur.features.spawn === true;
    if (!spawnOn) patch.features = { spawn: true };
    if (!cur || cur.smartSpawn !== true) patch.smartSpawn = true;
    if (patch.features || "smartSpawn" in patch) {
      bridge.set(patch);
    }
  }

  // Returns a spawn TileRef to force, or null to let the auto-bot decide.
  // Active mode is governed by spawnStrategy, NOT by autoSpawn (that toggle only
  // applies to the passive-mode branch in companionTick).
  function companionSpawnCenter(game, _player) {
    // Paused means "stop interfering", including with the auto-bot's own choices.
    if (!companionState.enabled || companionState.paused) return null;
    const s = companionSettings();
    if (s.mode !== "active") return null;

    // "auto" — hand spawn back to the auto-bot, and make sure its spawn is on.
    if (s.spawnStrategy === "auto") {
      companionForceAutobotSpawn();
      return null;
    }

    const g = game || companionGame();
    if (!g) return null;
    const boss = companionRefreshBoss(g);
    if (!boss) return null;
    const me = g.myPlayer ? g.myPlayer() : null;

    // Same anti-oscillation rule as the passive branch. Our own territory turns
    // the tile we just took into `hasOwner`, so re-picking on every call walks
    // the spawn one tile over, and SpawnExecution relinquishes everything to
    // follow it — freeing the first tile again so the next call walks back.
    // Returning the tile we already chose makes doSpawn() compare it against its
    // own lastSpawnTile and emit nothing.
    const bossSpawn = boss.state ? boss.state.spawnTile : null;
    if (
      companionSpawnSettled(me) &&
      bossSpawn === companionState.lastBossSpawnTile &&
      companionState.lastSpawnTile != null
    ) {
      return companionState.lastSpawnTile;
    }

    const tile = companionPickSpawnTile(g, me, boss, s.spawnMinRadius, s.spawnMaxRadius);
    if (tile != null) {
      companionState.lastBossSpawnTile = bossSpawn;
      companionState.lastSpawnTile = tile;
    }
    return tile;
  }

  // true = block this alliance. Only ever blocks when a boss has actually been
  // resolved, so a mistyped boss name degrades to "auto-bot behaves normally"
  // instead of "auto-bot can never ally with anyone".
  function companionAllianceVeto(other) {
    // While paused the auto-bot gets its diplomacy back — a veto left standing
    // would silently block every alliance it tries.
    if (!companionState.enabled || companionState.paused) return false;
    const s = companionSettings();
    if (s.mode !== "active" || !s.autoAlliance) return false;
    if (companionState.bossSmallID == null) return false;
    if (!other || typeof other.smallID !== "function") return true;
    return other.smallID() !== companionState.bossSmallID;
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  function companionQueueEmojiCommands(settings, me, ctx) {
    if (!settings.emojiControl) return;
    const commands = companionCollectCommands(
      ctx.boss,
      me.smallID(),
      companionBindings(),
      companionState.seenEmoji,
    );
    for (const actionId of commands) {
      companionEnqueue(actionId, function () {
        const ok = companionRunAction(actionId, ctx);
        companionLog((ok ? "✅ " : "❌ ") + actionId);
      });
    }
  }

  function companionQueueAllianceRenewal(me, boss, now) {
    if (!companionIsAlliedWithBoss(me, boss)) return;
    if (!companionCooldownReady("renew", COMPANION_RENEW_COOLDOWN_MS, now)) return;
    if (!companionAllianceNeedsRenew(me, boss)) return;
    companionMarkCooldown("renew", now);
    companionEnqueue("renew", function () {
      if (companionRenewAlliance(boss)) companionLog("🔁 Renew alliance with boss");
    });
  }

  function companionHandleSpawn(game, me, boss, settings) {
    if (typeof game.inSpawnPhase !== "function" || !game.inSpawnPhase()) return false;
    if (settings.mode !== "passive" || !settings.autoSpawn) return true;
    const bossSpawn = boss.state ? boss.state.spawnTile : null;
    if (companionSpawnSettled(me) && bossSpawn === companionState.lastBossSpawnTile) return true;
    companionState.lastBossSpawnTile = bossSpawn;
    const tile = companionPickSpawnTile(
      game,
      me,
      boss,
      settings.spawnMinRadius,
      settings.spawnMaxRadius,
    );
    if (tile == null || tile === companionState.lastSpawnTile) return true;
    companionState.lastSpawnTile = tile;
    companionEnqueue("spawn", function () {
      if (companionSpawnAt(tile)) companionLog("🏁 Spawned near boss");
    });
    return true;
  }

  function companionQueueAllianceRequest(settings, me, boss, now) {
    if (!settings.autoAlliance || companionIsAlliedWithBoss(me, boss)) return;
    const asked = boss.state && boss.state.outgoingAllianceRequests
      ? boss.state.outgoingAllianceRequests : [];
    const myId = me.id();
    if (!myId || asked.indexOf(myId) === -1) return;
    if (!companionCooldownReady("alliance", 5000, now)) return;
    companionMarkCooldown("alliance", now);
    companionEnqueue("alliance", function () {
      if (companionRequestAlliance(boss)) companionLog("🤝 Alliance with boss");
    });
  }

  function companionQueueTroopDonation(settings, ctx, allied, now) {
    if (!settings.autoTroops || !allied) return;
    if (!companionState.bossCanDonateTroops) return;
    if (!companionCooldownReady("donateAny", COMPANION_DONATE_MIN_GAP_MS, now)) return;
    if (!companionBossNeedsTroops(ctx.game, ctx.boss, settings.troopNeedPct)) return;
    companionMarkCooldown("donateAny", now);
    companionMarkDonated();
    companionEnqueue("donateTroops", function () {
      if (companionDonateTroops(ctx.me, ctx.boss, settings.troopSendPct)) {
        companionLog("🎖 Troops → boss");
      }
    });
  }

  function companionQueueFactory(settings, game, me, factoryLevel, now) {
    if (settings.mode !== "passive" || !settings.autoFactory) return;
    if (factoryLevel >= settings.maxFactoryLevel) return;
    if (!companionCooldownReady("factory", COMPANION_FACTORY_COOLDOWN_MS, now)) return;
    companionMarkCooldown("factory", now);
    companionEnqueue("factory", function () {
      if (companionBuildOrUpgradeFactory(game, me)) companionLog("🏭 Factory");
    });
  }

  function companionGoldDonationAmount(settings, me, factoryLevel) {
    const goldNow = Number(me.gold());
    if (factoryLevel >= settings.maxFactoryLevel) {
      return { amount: companionPercentAmount(goldNow, settings.goldIdlePct), goldNow: goldNow };
    }
    const gainedGold = Math.max(0, goldNow - companionState.lastGoldSnapshot);
    return {
      amount: companionPercentAmount(gainedGold, settings.goldBuildingPct),
      goldNow: goldNow,
    };
  }

  function companionQueueGoldDonation(settings, ctx, allied, factoryLevel, now) {
    if (!settings.autoGold || !allied) return;
    if (!companionState.bossCanDonateGold) return;
    const buildsFactory = settings.mode === "passive" && settings.autoFactory;
    const belowCap = factoryLevel < settings.maxFactoryLevel;
    if (buildsFactory && belowCap && factoryLevel <= companionState.goldAtFactoryLevel) return;
    if (!companionCooldownReady("donateAny", COMPANION_DONATE_MIN_GAP_MS, now)) return;
    if (!companionCooldownReady("donateGold", COMPANION_DONATE_GOLD_COOLDOWN_MS, now)) return;
    const donation = companionGoldDonationAmount(settings, ctx.me, factoryLevel);
    if (donation.amount <= 0) return;
    companionMarkCooldown("donateAny", now);
    companionMarkCooldown("donateGold", now);
    companionState.lastGoldSnapshot = belowCap ? donation.goldNow : 0;
    if (buildsFactory && belowCap) companionState.goldAtFactoryLevel = factoryLevel;
    companionMarkDonated();
    companionEnqueue("donateGold", function () {
      const recipient = ctx.boss.id();
      if (!recipient) return;
      if (companionSend({ type: "donate_gold", recipient: recipient, gold: donation.amount })) {
        companionLog("💰 Gold → boss");
      }
    });
  }

  function companionPrepareTickGame() {
    const game = companionGame();
    if (!game || companionIsCatchingUp(game)) return null;
    const gameRef = game.__src || game;
    if (companionState.lastGameRef !== gameRef) {
      companionState.lastGameRef = gameRef;
      companionResetRunState();
      companionLog("▶ new match");
    }
    return game;
  }

  function companionTick() {
    if (!companionState.enabled) return;
    const now = Date.now();
    companionDrainQueue(now);
    const game = companionPrepareTickGame();
    if (!game) return;
    const me = game.myPlayer ? game.myPlayer() : null;
    if (!me) return;
    const boss = companionRefreshBoss(game);
    if (!boss) return;
    const settings = companionSettings();
    const ctx = { game: game, me: me, boss: boss };
    companionQueueEmojiCommands(settings, me, ctx);
    companionQueueAllianceRenewal(me, boss, now);
    if (companionState.paused) return;
    if (companionHandleSpawn(game, me, boss, settings)) return;
    companionQueueAllianceRequest(settings, me, boss, now);
    const allied = companionIsAlliedWithBoss(me, boss);
    if (allied && (settings.autoTroops || settings.autoGold)) {
      companionRefreshBossActions(game, me, boss);
    }
    const factoryLevel = companionFactoryLevel(game, me);
    companionState.factoryLevel = factoryLevel;
    companionQueueGoldDonation(settings, ctx, allied, factoryLevel, now);
    companionQueueTroopDonation(settings, ctx, allied, now);
    companionQueueFactory(settings, game, me, factoryLevel, now);
  }

  // ---------------------------------------------------------------------------
  // Enable / disable + bridge
  // ---------------------------------------------------------------------------

  function setCompanionEnabled(enabled) {
    const on = Boolean(enabled);
    if (companionState.enabled === on) return;
    companionState.enabled = on;
    companionState.uiSignature = null; // force the banner to appear/disappear now
    if (on) {
      companionResetRunState();
      // Switching the feature on IS a fresh start, so here the pause does clear.
      companionState.paused = false;
      companionState.autobotWasEnabled = false;
      if (!companionState.tickRegistered && typeof registerHelperTickListener === "function") {
        companionState.tickRegistered = true;
        registerHelperTickListener(companionTickThrottled);
      }
      companionLog("▶ Companion enabled");
    } else {
      companionState.queue.length = 0;
      companionLog("⏹ Companion disabled");
    }
    companionSyncAutobot();
    if (typeof companionRefreshPanel === "function") companionRefreshPanel();
  }

  // The shared helper tick runs at 250ms; the companion wants its own (slower,
  // user-configurable) cadence on top of it.
  // The panel and the banner are drawn on user actions, but bossStatus, paused and
  // factoryLevel all change on the tick clock. A banner still saying "no boss"
  // after the boss has joined is worse than no banner at all.
  //
  // Gated on a signature so a quiet tick costs one string compare, and skipped
  // entirely while the user is typing into the panel — rebuilding it would drop
  // focus mid-edit.
  function companionSyncUi() {
    const sig = companionState.enabled
      ? [
          companionState.bossStatus,
          companionState.paused,
          companionState.factoryLevel,
          companionSettings().bossName,
        ].join("|")
      : "off";
    if (sig === companionState.uiSignature) return;
    companionState.uiSignature = sig;
    if (typeof companionSyncBanner === "function") companionSyncBanner();
    const panelEl = document.getElementById(COMPANION_PANEL_ID);
    if (panelEl && typeof panelEl.contains === "function"
        && panelEl.contains(document.activeElement)) {
      // Still refresh the fixed chrome (dot colour), just not the body the user
      // may be typing into.
      if (typeof companionUpdateChrome === "function") companionUpdateChrome(panelEl);
      return;
    }
    if (typeof companionBuildPanel === "function") companionBuildPanel();
  }

  function companionTickThrottled() {
    const now = Date.now();
    let period = Number(companionSettings().tickMs) || 2000;
    const game = companionGame();
    if (
      game &&
      typeof game.inSpawnPhase === "function" &&
      game.inSpawnPhase()
    ) {
      period = Math.min(period, COMPANION_SPAWN_TICK_MS);
    }
    if (now - (companionState.lastTickAt || 0) < period) {
      // Still drain the queue at full rate so a burst of commands is not stuck
      // behind the slow decision cadence.
      companionDrainQueue(now);
      companionSyncUi();
      return;
    }
    companionState.lastTickAt = now;
    companionTick();
    companionSyncUi();
  }

  function setCompanionPanelVisible(visible) {
    companionPatchSettings({ hidden: !visible });
    if (typeof companionRefreshPanel === "function") companionRefreshPanel();
  }

  window.__OFH_companion = {
    ACTION_IDS: COMPANION_ACTION_IDS.slice(),
    get: function () {
      return Object.assign({}, companionSettings(), {
        enabled: Boolean(companionState.enabled),
        bossStatus: companionState.bossStatus,
        // "factoryLevel", not "factories" — the number is an upgrade level, and
        // calling it a count is exactly the confusion this feature already had.
        factoryLevel: companionState.factoryLevel,
      });
    },
    set: function (patch) {
      if (!patch || typeof patch !== "object") return;
      companionPatchSettings(patch);
      if ("enabled" in patch) setCompanionEnabled(Boolean(patch.enabled));
      // Changing mode must re-sync the auto-bot policy the same way the panel's
      // Mode dropdown does — otherwise a scripted set({mode}) leaves the auto-bot
      // in the wrong state. setCompanionEnabled already syncs, so skip if enabled
      // was in the patch (it just ran sync).
      else if ("mode" in patch) companionSyncAutobot();
      if (typeof companionRefreshPanel === "function") companionRefreshPanel();
    },
  };

  // Mirrors window.__autoBotDiag(): a full object back means the wiring is intact.
  window.__companionDiag = function () {
    const game = companionGame();
    return {
      enabled: Boolean(companionState.enabled),
      settings: companionSettings(),
      bossStatus: companionState.bossStatus,
      bossSmallID: companionState.bossSmallID,
      paused: companionState.paused,
      queued: companionState.queue.length,
      factoryLevel: companionState.factoryLevel,
      gameFound: Boolean(game),
      humans: companionHumanPlayers(game).map(function (p) { return p.name(); }),
      bindings: companionBindings(),
      lastSendFailedAt: companionState.lastSendFailedAt,
      logLines: companionState.log.length,
    };
  };
