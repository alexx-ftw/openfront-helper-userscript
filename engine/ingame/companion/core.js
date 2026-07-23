// Companion Bot — core: constants, pure math helpers, settings blob, boss
// resolution and the public bridge.
//
// Classic-script shared-global scope (no IIFE), exactly like the auto-bot
// modules: every top-level name here is visible to the sibling companion files
// AND to the rest of the in-game bundle, so all of them carry a `companion` /
// `COMPANION_` prefix to stay unique.
//
// NOTHING in this file may run at load time. Settings are initialised lazily via
// companionSettings(), so integration failures surface when the feature is used
// instead of aborting concatenation, and test/companion.mjs can load it in Node.

"use strict";

  const COMPANION_STORAGE_KEY = "openfront-helper-companion-v1";
  const COMPANION_PANEL_ID = "openfront-helper-companion-panel";
  const COMPANION_BANNER_ID = "openfront-helper-companion-banner";
  const COMPANION_STYLE_ID = "openfront-helper-companion-styles";
  const COMPANION_PANEL_POS_KEY = "openfront-helper-companion-pos";

  // ---------------------------------------------------------------------------
  // Pure math
  // ---------------------------------------------------------------------------

  // TileRef → map coordinates. The game stores tiles row-major, so this is plain
  // arithmetic. (The multitab original split the tile id's DIGIT STRING in half,
  // which only lands on the right tile when the map width happens to be a power
  // of ten — on every other map it aims somewhere unrelated.)
  function companionTileToXY(ref, width) {
    const w = Number(width) || 1;
    const r = Number(ref) || 0;
    return { x: r % w, y: Math.floor(r / w) };
  }

  function companionTileFromXY(x, y, width) {
    const w = Number(width) || 1;
    return Math.floor(y) * w + Math.floor(x);
  }

  // A percentage of a gold/troop amount, as a plain Number. Gold is a bigint and
  // the wire schema wants z.number(), so bigints are divided in bigint space
  // first (keeping precision past 2^53) and only then converted.
  function companionPercentAmount(value, percent) {
    let pct = Number(percent);
    if (!Number.isFinite(pct)) pct = 0;
    // Round ONCE, before either branch, so a fractional percent cannot make the
    // bigint path and the number path disagree (the panel's number inputs do not
    // constrain step, so 33.6 is reachable).
    pct = Math.round(Math.max(1, Math.min(100, pct)));
    if (typeof value === "bigint") {
      if (value <= 0n) return 0;
      const out = (value * BigInt(pct)) / 100n;
      return Number(out > 0n ? out : 1n);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(1, Math.floor((n * pct) / 100));
  }

  // Every integer offset whose distance falls inside the [minR, maxR] annulus,
  // sorted nearest-first so a caller can take the first valid tile and stay as
  // close to the boss as the terrain allows.
  //
  // Memoised on (lo, hi): the caller runs this once per tick through the whole
  // spawn phase while the radii almost never change, and at the top of the legal
  // range (maxR = 200) the array is ~125k entries costing tens of milliseconds to
  // rebuild — a real bite out of a 250ms tick. The cached array is treated as
  // read-only by every caller.
  let _companionRingCache = null;

  function companionRingOffsets(minR, maxR) {
    const lo = Number(minR) || 0;
    const hi = Number(maxR) || 0;
    if (hi < lo || hi <= 0) return [];
    if (_companionRingCache && _companionRingCache.lo === lo && _companionRingCache.hi === hi) {
      return _companionRingCache.out;
    }
    const out = [];
    const r = Math.ceil(hi);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d < lo || d > hi) continue;
        out.push({ dx: dx, dy: dy, d: d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    const offsets = out.map((o) => ({ dx: o.dx, dy: o.dy }));
    _companionRingCache = { lo: lo, hi: hi, out: offsets };
    return offsets;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  const COMPANION_DEFAULTS = {
    bossName: "",
    mode: "passive",            // "passive" | "active"
    autoSpawn: true,
    spawnMinRadius: 12,
    spawnMaxRadius: 24,
    autoAlliance: true,
    autoTroops: true,
    troopNeedPct: 60,           // donate once the boss drops to/below this % of max
    troopSendPct: 40,           // how much of OUR troops to send
    autoGold: false,
    goldBuildingPct: 40,        // % of the gold GAINED since last donate, while building
    goldIdlePct: 100,           // % of total gold once maxFactoryLevel is reached
    autoFactory: true,
    maxFactoryLevel: 20,
    emojiControl: true,
    emojiBindings: null,        // null → COMPANION_DEFAULT_BINDINGS (commands.js)
    tickMs: 2000,
    hidden: false,
    activeTab: "control",
    spawnStrategy: "boss",      // Active mode only: "boss" (hug boss) | "auto" (auto-bot decides)
    collapsedSections: { support: false, economy: true, advanced: true },
    pos: null,
  };

  // Only these keys survive a reload. Anything else in an old blob is dropped, so
  // a stale saved value can never mask a new default.
  const COMPANION_PERSISTED_KEYS = Object.keys(COMPANION_DEFAULTS);

  // Per-key validation. The panel, the loader and the public
  // window.__OFH_companion.set() bridge all funnel through
  // companionCoerceSetting, so this is the single place a bad value is stopped.
  // An unusable value KEEPS the previous one rather than overwriting it: the
  // panel's number inputs yield NaN when emptied, and a NaN maxFactoryLevel would
  // switch auto-factory off silently with nothing on screen to explain it.
  const COMPANION_NUMBER_RANGES = {
    spawnMinRadius: [1, 200],
    spawnMaxRadius: [1, 200],
    troopNeedPct: [1, 100],
    troopSendPct: [1, 100],
    goldBuildingPct: [1, 100],
    goldIdlePct: [1, 100],
    maxFactoryLevel: [1, 100],
    tickMs: [250, 60000],
  };

  const COMPANION_ENUMS = {
    mode: ["passive", "active"],
    activeTab: ["control", "emoji", "log"],
    spawnStrategy: ["boss", "auto"],
  };

  function companionCoerceCollapsedSections(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const out = {};
    for (const sec of ["support", "economy", "advanced"]) {
      if (sec in value) out[sec] = Boolean(value[sec]);
    }
    return out;
  }

  function companionCoerceObjectSetting(value) {
    if (value === null) return null;
    return value && typeof value === "object" ? value : undefined;
  }

  // Sanitised value, or undefined when the input is unusable.
  function companionCoerceSetting(key, value) {
    const range = COMPANION_NUMBER_RANGES[key];
    if (range) {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return undefined;
      return Math.max(range[0], Math.min(range[1], n));
    }
    const allowed = COMPANION_ENUMS[key];
    if (allowed) return allowed.indexOf(value) === -1 ? undefined : value;
    if (key === "bossName") return typeof value === "string" ? value.trim() : undefined;
    if (key === "collapsedSections") return companionCoerceCollapsedSections(value);
    if (key === "emojiBindings" || key === "pos") return companionCoerceObjectSetting(value);
    // Every remaining key in COMPANION_DEFAULTS is a boolean flag.
    return Boolean(value);
  }

  const companionState = {
    settings: null,
    bossSmallID: null,
    bossStatus: "idle",   // "idle" | "found" | "missing" | "self"
    paused: false,
    log: [],
    queue: [],
    lastSendAt: 0,
    lastSendFailedAt: 0,
    cooldowns: {},
    seenEmoji: [],
    factoryLevel: 0,
    lastGoldSnapshot: 0,
    goldAtFactoryLevel: 0,
    enabled: false,
    tickRegistered: false,
    lastTickAt: 0,
    lastSpawnTile: null,
    lastBossSpawnTile: null,
    lastGameRef: null,
    autobotWasEnabled: false,
    autobotSuppressed: false,
    uiSignature: null,
    // null means the optional actions() permission query has not replied yet.
    // Only false is an authoritative server denial.
    bossCanDonateGold: null,
    bossCanDonateTroops: null,
    actionsInFlight: false,
    lastActionsAt: 0,
    bossDonateConfirmed: true,
    donateUnconfirmedSince: 0,
  };

  function companionApplyStoredSetting(settings, key, value) {
    if (key === "collapsedSections") {
      settings.collapsedSections = Object.assign({}, settings.collapsedSections, value);
      return;
    }
    settings[key] = value;
  }

  function companionApplyStoredSettings(settings, parsed) {
    if (!parsed || typeof parsed !== "object") return;
    for (const key of COMPANION_PERSISTED_KEYS) {
      if (parsed[key] === undefined) continue;
      const value = companionCoerceSetting(key, parsed[key]);
      if (value === undefined) continue;
      companionApplyStoredSetting(settings, key, value);
    }
  }

  function companionLoadSettings() {
    const s = JSON.parse(JSON.stringify(COMPANION_DEFAULTS));
    const raw = window.localStorage.getItem(COMPANION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      companionApplyStoredSettings(s, parsed);
    }
    return s;
  }

  // Lazy accessor — see the file header for why nothing runs at load time.
  function companionSettings() {
    if (companionState.settings === null) {
      companionState.settings = companionLoadSettings();
    }
    return companionState.settings;
  }

  function companionSaveSettings() {
    window.localStorage.setItem(
      COMPANION_STORAGE_KEY,
      JSON.stringify(companionSettings()),
    );
  }

  function companionPatchSettings(patch) {
    if (!patch || typeof patch !== "object") return;
    const s = companionSettings();
    for (const k of COMPANION_PERSISTED_KEYS) {
      if (patch[k] === undefined) continue;
      const v = companionCoerceSetting(k, patch[k]);
      if (v === undefined) continue; // unusable — keep the previous value
      // collapsedSections merges (toggle one accordion, keep the others).
      if (k === "collapsedSections") {
        s.collapsedSections = Object.assign({}, s.collapsedSections, v);
      } else {
        s[k] = v;
      }
    }
    companionSaveSettings();
  }

  // ---------------------------------------------------------------------------
  // Boss resolution
  // ---------------------------------------------------------------------------

  function companionPlayerType(p) {
    return String(p.type ? p.type() : "");
  }

  // Live human players, for the panel's boss picker.
  function companionHumanPlayers(game) {
    if (!game || typeof game.players !== "function") return [];
    return game.players().filter(function (p) {
      if (!p || typeof p.name !== "function") return false;
      if (companionPlayerType(p) !== "HUMAN") return false;
      return p.isAlive ? p.isAlive() !== false : true;
    });
  }

  // Resolve the configured boss name against the live game.
  //   idle    — no name configured yet
  //   self    — the name is THIS tab; the companion must stay out of the way
  //   found   — a live human with that name exists
  //   missing — configured but not present (typo, not joined, or dead)
  //
  // The multitab original called targetPlayer.id() BEFORE its null check, so a
  // mistyped boss name threw a TypeError on every single tick. Order matters.
  function companionResolveBoss(game, bossName) {
    const wanted = String(bossName == null ? "" : bossName).trim().toLowerCase();
    if (wanted === "") return { status: "idle", boss: null };
    if (!game || typeof game.players !== "function") {
      return { status: "missing", boss: null };
    }

    const me = game.myPlayer ? game.myPlayer() : null;
    if (me && typeof me.name === "function") {
      if (String(me.name()).trim().toLowerCase() === wanted) {
        return { status: "self", boss: null };
      }
    }

    const candidates = companionHumanPlayers(game);
    for (const p of candidates) {
      if (String(p.name()).trim().toLowerCase() === wanted) {
        return { status: "found", boss: p };
      }
    }
    return { status: "missing", boss: null };
  }
