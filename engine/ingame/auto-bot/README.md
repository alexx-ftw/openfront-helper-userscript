# Auto-Bot

Training tool for OpenFront lobbies. Plays the local human
player automatically (auto-spawn, auto-expand / conquer, auto-build, nukes,
warships, alliances) by reading the client-side `GameView`/`PlayerView` and
emitting the same intents the UI emits. Strategy mirrors the in-game "Nation"
bot (see `src/core/execution/NationExecution.ts` and friends in the game repo).

> **Lobby scope:** the `isPublicLobby` gate in `helpers.js` is **disabled**, so
> the engine runs in **public lobbies too** (not just Private / Singleplayer).
> Feature-level public restrictions ported from the src AI Nation have also been
> lifted where they don't apply to a human-played bot — e.g. auto-donate now runs
> in public **Team** lobbies (the server allows troop donation there), gated only
> by the real `config().donateTroops()` rule. To re-lock to private only, restore
> `isPublicLobby` in `helpers.js`.

## Early Game policy

The Early Game snapshot starts after spawn selection while there is still free
territory or an actionable tribe. The policy keeps the existing Nation decision
chain and gives it this priority:

1. claim safe land first, using the existing `EARLY_EXPAND_COMMIT` minimum of 60%
   of current troops;
2. take a reachable bordering bot tribe;
3. use a transport boat only when an exact route ETA is at most 300 game ticks
   (30 seconds at 100 ms per tick).

`bestTransportShipSpawn()` currently reports only whether a boat route exists, not
its path length. `gameApi.js` therefore exposes the optional
`src.transportRouteTicks(tile)` adapter. Until the page supplies that exact route,
Early Game rejects naval launches instead of treating reachability as a 30-second
ETA. `window.__autoBotDiag()` reports `boatRouteAvailable`, `boatGate`, the last
ETA, and rejection counters so this limitation is visible in-game.

## Architecture

These are **classic page-context scripts**, not ES modules — there is no bundler
for `page-bridge/`. Each file is loaded as its own `<script>` (see
`content/auto-join.js` → `bridgeScripts`, and `manifest.json` →
`web_accessible_resources`) and they **share one global lexical scope**, exactly
like every other `page-bridge/*.js` file (`runtime.js`, `alliances.js`, …). A
function or `const` declared at the top of one module is visible to all the
others; cross-module state is shared through object references (`state`,
`_ctors`, `_alliancesActioned`). Each file is `"use strict"`.

**Load order matters** and is fixed in `bridgeScripts` / `web_accessible_resources`:

| # | Module | Responsibility |
|---|--------|----------------|
| 1 | `core.js` | `UNIT`, the shared `state` object, tuning constants, settings load/save. Loaded **first** — its `state` initializer runs `loadSettings()` at load time. |
| 2 | `i18n.js` | `tr(key, params)` translation + `setAutoBotI18n(lang, bundle)`. Loaded right after core so every later module can call `tr()`. |
| 3 | `context.js` | Game/UI handle discovery, intent-constructor discovery, `emitIntent`, `window.__autoBotDiag()`. |
| 4 | `helpers.js` | Lobby gate (`gameType`/`isPublicLobby`) and small shared helpers (`clamp`, `toNum`, game-speed `scaled`, `safeName`, `withTimeout`, …). |
| 5 | `sensing.js` | Reading game state: border tiles, ocean-adjacency, border analysis, bounding boxes. |
| 6 | `spawn.js` | Spawn phase. |
| 7 | `combat.js` | Expand / conquer: land targeting, retaliation, bot attacks, hostility, embargo, donate, boat landings. |
| 8 | `build.js` | Economy/defense building: structure priority, value-scored placement, upgrades, perceived-cost gating. |
| 9 | `nuke.js` | Nuclear strategy: targeting, SAM-saturation launch-sequence sim, MIRV, retaliation. |
| 10 | `warship.js` | Naval: fleet building and warship dispatch (home defense, escort, trade raiding). |
| 11 | `alliance.js` | Accept/renew, proactively court strong players, constructor capture. |
| 12 | `engine.js` | Engine tick orchestration, start/stop, enable, status & action log. |
| 13 | `panel.js` | Floating control panel UI (control/log tabs, sliders, drag). |
| 14 | `lifecycle.js` | Watcher + bootstrap. Loaded **last** — the only module that executes at load time (guarded by `window.__openfrontAutoBotLoaded`). |

Only three things run at load time: `state`'s initializer (core), the
`window.__autoBotDiag` assignment (context), and the guarded bootstrap
(lifecycle). Everything else is a declaration called later at runtime, so module
order between `core` and `lifecycle` is otherwise free.

## Internationalization

All user-visible strings go through `tr(key, params)` (in `i18n.js`), where the
key is the **English source text** (with `{placeholders}`) — the same
convention the rest of the extension uses. English source lives in
`shared/i18n.js` `DEFAULT_TRANSLATIONS`; translations live in
`locales/<lang>/common.json`. The bot runs in the page context and can't fetch
locale bundles, so `content/core.js` posts the bundle for the active language
(`SET_AUTO_BOT_I18N`) and the bot follows the extension's language setting. A
missing translation falls back to the readable English key. The function is
named `tr` (not `t`) because `t` is used everywhere as a `TileRef` variable.

## Smoke test

After reloading the extension, run `window.__autoBotDiag()` in the page console.
It touches `state`, the lobby gate, constructor discovery and many helpers across
modules — if it returns a full object, the wiring is intact.

## Legendary construction mode

The `Legendary` difficulty is an adaptive construction mode, not a copy of the
vanilla priority list. It treats gold production and troop generation as the two
equally weighted primary objectives and ranks candidates lexicographically by:

1. mandatory/safety constraints;
2. the weaker of the gold and troop marginal scores (max-min balance);
3. the sum of those two productive scores;
4. defensive safety and strategic tie-breakers.

Cities receive diminishing gold credit as connected cities accumulate. Factories
are valued by rail demand, ports by trade demand and survivability, and silos by
current offensive target pressure. Defense Posts are excluded unless an incoming
land assault exceeds the exceptional threat threshold.

Productive sites are placed using the engine's rail connectivity score and an
additional team-position score: nearby powerful allies are ranked by the maximum
relative signal among troops, treasury, and gold production, with extra value for
nearby/high-level friendly SAMs. The own border segment closest to the geometric
center of the team is preferred when other constraints are comparable.

SAM placement and upgrades are trajectory-aware. The planner reads enemy silo
levels and available slots, enemy gold (Atom versus Hydrogen affordability),
`nukeMagnitudes`, `defaultNukeSpeed`, `UniversalPathFinding.Parabola`, active
missiles, `missileTimerQueue`, `SAMCooldown`, and `SiloCooldown`. Cheap chained Atom bombs are
scheduled individually against each friendly SAM's ready slots and reload
times before the Hydrogen finisher; enemy silo slots that are currently queued
are projected into the future instead of being discarded. All simultaneous
threat routes consume one shared friendly-SAM schedule. The five-tick margin (0.5 seconds at the
engine's 10 ticks/second) means `firstImpactTick - actionCompletionTick`: a new
SAM uses the real construction duration (normally 300 ticks), while an upgrade
is instant for range purposes, but each newly added upgrade slot starts with a
full `SAMCooldown` reload and is not immediately available. Legendary spends on
an emergency SAM only when it completes with at least five ticks before the
first impact and the resulting schedule defends the whole salvo; otherwise it
does not invest in the threatened construction path.
The emergency path bypasses the ordinary structure cooldown and team save-up
block so a viable defense action is not delayed. Short assignment conflicts use
bounded exact backtracking; if the search budget is exhausted, Legendary treats
the result as inconclusive/unsafe rather than assuming a greedy miss proves
impossibility.
