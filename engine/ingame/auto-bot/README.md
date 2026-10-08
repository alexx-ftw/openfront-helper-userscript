# Auto-Bot

Training tool for OpenFront lobbies. Plays the local human
player automatically (auto-spawn, auto-expand / conquer, auto-build, nukes,
warships, alliances) by reading the client-side `GameView`/`PlayerView` and
emitting the same intents the UI emits. Strategy mirrors the in-game "Nation"
bot (see `src/core/execution/NationExecution.ts` and friends in the game repo).

## Early Game policy

The Early Game snapshot starts after spawn selection while there is still free
territory or an actionable tribe. With `winFixes` enabled, the policy keeps the
existing Nation decision chain but enriches its opening target choice:

1. discard sea-only tribes unless the transport pathfinder verifies a route of
   at most 300 ticks. Rank the remaining tribes by the equal-weight mean of route
   efficiency, territory gained per estimated defending troop, rival-race
   urgency, encirclement/blocking control, access to further tribes, and nearby
   navigable maritime opportunity. This prevents one coastal signal from
   overriding a much better land capture;
2. attack the best-ranked tribe through the existing land/boat actuation. A
   selected maritime tribe receives a reserve-aware conquest force, not the
   cheap probe used for uncertain Terra Nullius. When a rival is racing for the
   same food, the bot raises the commitment while keeping the reserve floor.
   The conquest reserves its destination before any parallel free-land probe,
   and the boat-emission chokepoint permits at most one transport to the same
   beach opportunity, using the configured `boatSpreadRadius`, in a game tick.
   That area remains reserved while the intent is awaiting reconciliation and
   while its non-retreating transport remains active; a failed intent releases
   after the normal reconciliation grace, and a completed or destroyed
   transport releases immediately. Already-owned destinations are rejected
   before emission, since the engine cannot launch a transport to our own tile;
   tracked outbound transports retain their launch-intent target's conquest
   commitments after pending-intent reconciliation, preventing duplicate
   reinforcements while troops are at sea without reserving home troops twice.
   The client exposes no transport target ID, so manual/untracked boats are
   excluded and ownership changes between intent and native spawn remain
   unobservable; later coastal ownership changes do not reassign the target;
3. when we already hold a shore on the largest connected water surface, probe
   the nearest unowned maritime tile before falling back to generic Terra Nullius
   expansion, so the first coastal foothold can support a Port. Smaller closed
   water bodies are deliberately excluded;
4. use a transport boat only when the computed route ETA is at most 300 game
   ticks (30 seconds at 100 ms per tick). A proximity-only `boatCandidate` does
   not activate Early Game or delay a tribe attack.

The local water-path fallback still probes the authoritative transport spawn on
each snapshot. A successful route is reused across snapshots only when that
probe returns the exact same spawn tile for the same destination; a changed
spawn recalculates the route immediately.

Structure planning uses a bounded boolean water-access query. Direct ocean
access is proven from the player's cached border without constructing the
full-map component index; exact full-resolution labeling remains lazy for the
rarer inland-lake case where a trusted allied or team coast must be verified.

Within one tribe-ranking decision, every maritime candidate shares one
authoritative snapshot of our shore tiles. Target shores compute their minimum
distance to that snapshot once before stable ranking, rather than repeatedly
rescanning every owned shore from the sort comparator. Direct ETA calls still
materialize their own current snapshot, so only same-decision work is reused.

Terra Nullius attacks use the greater of 10% of the current army or the
calculated one-tile loss plus a 25% margin. During the first 500 ticks, all
accepted free-land intents share a cumulative ceiling of 60% of the spawning
army; that ceiling is never used as a fixed per-intent payload. After that
window, expansion may use only troops above the calculated production peak or a
higher threat-aware reserve. Transport probes share the same accounting, so
several reconciled intents cannot independently drain the opening army.

Radioactive Terra Nullius uses the live Fallout defense multiplier and may keep
expanding by land or short coastal transport until the army reaches 42% of its
current maximum capacity. This deeper reserve applies only to Fallout; ordinary
free land and player attacks keep their own safety floors.

The static reverse-maritime distance field used to rank tribe access is warmed
in bounded slices after spawning. If a tribe decision arrives before warming is
complete, it finishes the remaining work and publishes only the complete field,
so target selection remains identical without concentrating the full cold scan
inside one combat decision.

Fallback water-route searches are deterministic by default: they yield between
small BFS batches and stop at a 1,280-node cap, rather than declaring
the same coast reachable or unreachable according to current CPU speed. A wall
clock deadline remains available only to callers that explicitly request one as
an additional safety fuse.

Port construction applies the same largest-surface rule independently: a port
candidate must be a border tile adjacent to the canonical open-ocean component.
Shared closed lakes may still contribute to broader coastal/trade planning, but
they never authorize a port placement.

The target ranking is bounded to nearby tribes and a small number of border
snapshots. `winFixes: false` leaves the faithful Nation bot order untouched. A
generic Terra Nullius land attack still has no tile argument in the client intent,
so the coast-specific direction is expressed through a coastal tribe target or an
explicit open-ocean landing rather than by inventing a new attack API.

The complete tribe-border topology is retained for one profiled 30-tick
strategic cadence and invalidated immediately when the live tribe-id set
changes. This avoids rebuilding the same graph at the next decision while
keeping territorial changes bounded to a three-second snapshot window.
Failed background refreshes release their pending lock and surface the original
error in the next awaited decision; later decisions can retry instead of leaving
tribe selection permanently frozen.
When that ID set changes, retained tribes reuse their cached adjacency and only
new or territorially changed tribes rescan their borders; removed tribes and
their edges are filtered directly. The incremental graph is equivalent to a
full rebuild while avoiding a map-wide border traversal after every capture.
Neighbor-owner membership uses the engine's bounded integer `smallID` space as
a dense lookup table, while the published adjacency remains the same ordered
map of sets. This removes repeated hash lookups from the hottest border loop
without changing graph traversal or target ordering.
The cooperative adjacency scan samples its four-millisecond deadline once per
128 border tiles instead of reading the clock on every tile, while retaining
the unconditional 2,048-tile yield. Graph contents and insertion order remain
unchanged, but large opening maps spend less time inside topology bookkeeping.

## Enemy Defense Post-aware attacks

Alliance betrayal first checks that the ordinary land attack can be funded under
the same reserve, war-commitment and defensive-strength limits. A weak ally alone
is not sufficient: an unfundable attack must not incur the traitor penalty. The
actual attack still waits for the alliance break to become authoritative.

All transport launches preserve the currently observed hostile invasion army as
well as their normal reserve. Pending outbound intents are still deducted; an
unconfirmed counterattack cannot free the same defenders for a boat. Once the
engine removes the incoming wave, the ordinary transport budget resumes.

With `winFixes` enabled, land attacks inspect only the current frontier and apply
the real Defense Post effects: an active completed post within 30 tiles means
5× attacker losses and 3× slower conquest. Overlapping posts do not stack, and
under-construction posts do not count. Covered targets rank as harder, bot attack
thresholds scale with the 5× damage effect, and attacks below the resulting
minimum are deferred instead of wasting troops. The bounded profile is cached
per target and game tick; cheap boat probes keep their existing behavior.
Forced counterattacks wholly consumed by the incoming wave bypass this conquest
floor: the engine cancels opposing troops before Defense Posts apply. Same-tick
responses already committed to that wave are deducted before this exemption.

Defensive construction counts nearby Posts against the front's budget using
the same engine effect radius as its uncovered-front calculation. A Post outside
that radius cannot suppress a replacement for an entirely unprotected front.
The worker-resolved Defense Post tile must also retain the sampled border-depth
limits; a snap toward the frontier is rejected before spending construction gold.

## Combat decision cadence

The Auto Bot panel's `Tick interval (ms)` controls the engine polling cadence.
Polling is intentionally separate from the strategy cadence: duplicate
snapshots are skipped, while attack and structure decisions run only when the
edge-detected `attackRate` / structure-third crossings are reached. With
`winFixes` enabled, `combatCadenceScale` defaults to `0.6`, so the bot remains
more active than the faithful difficulty-based Nation without rerunning the
full decision chain on every poll. Pending outbound intents continue to reserve
troops until the client reconciles them. Disabling `winFixes` restores the
faithful cadence exactly.

All helper-owned intents share a client-side token budget matching the server:
10 intents per second and 150 intents per minute. When the budget is empty,
`emitIntent()` and the direct WebSocket fallback return `false` without sending;
bot callers can retry on the next decision instead of asking the server to drop
the packet. Parallel attack batches stop before walking more targets once the
budget is empty, so Impossible/Legendary does not attempt 100 rejected sends in
one decision. `window.__autoBotDiag()` exposes the current budget and local
backpressure counters.

Defensive land responses share the uncommitted remainder of an incoming wave
within the same game tick. Accepted same-target counterattacks are deducted
before another defense lane can send; the next tick uses its fresh snapshot
without deducting earlier cancellations again.

## Naval invasion interception

With `winFixes` enabled and a completed Port, the bot identifies hostile
Transport ships targeting our territory, reconstructs their water route, and
dispatches existing Warships to the earliest reachable firing-range point. It
prefers the transport's live motion plan when exposed by the client and falls
back to local water A*. The planner uses the transport and Warship movement
speeds exposed by the client when available, otherwise the current engine
contract of one water-path step per tick, and uses `warshipTargettingRange()`
for the Euclidean firing range. Binary-search probes that cannot possibly enter
range even on an unobstructed straight route are rejected by an exact
direct-distance lower bound before invoking full-resolution water A*.

The emergency economy gate runs before ordinary structure pacing. While an
invasion is active, it reserves the construction decision for a Port: an
existing Port under construction is allowed to finish, otherwise the bot keeps
retrying the Port and does not spend the reserve on City, Factory, SAM, or Silo
construction. Once a completed Port exists, the Warship phase bypasses its
normal random spawn roll and emits the first affordable destroyer. Offensive
nukes and gold donations are also deferred while this reserve is active. If
the map has no valid open-ocean Port site, the normal economy policy remains the
fallback.

Multiple invasions are scheduled as sequential interception opportunities per
Warship. Small groups use bounded exact assignment; larger groups use a
deterministic urgency-first assignment. If any invasion remains uncovered, the
bot probes Warship buildability using candidate water targets and the actual
spawn tile returned by the buildable-unit contract, builds an additional
Warship when affordable, and replans on the next tick. The local full-resolution
A* route is an intentional client-side divergence from the engine's HPA/
smoothing pathfinder; the server still validates the water component when it
receives the move intent.

All Warship construction paths share one pending-intent reservation. The client
may expose an accepted build several ticks after the build menu emits it, so the
initial, retaliation, infestation-counter, and invasion-interceptor paths cannot
issue another Warship build until a new unit appears (including one under
construction) or the six-tick reconciliation grace confirms that the intent did
not materialize.

Once a Warship is dispatched, its assignment is keyed by the stable transport
ID and retained while both units remain active. The moving transport must not
trigger a fresh A* plan or a new patrol destination on every planning interval;
the assignment is released only when the invasion or assigned Warship is no
longer live. A single planning pass emits at most one immediate movement order
per Warship; later sequential opportunities are reconsidered after the active
assignment clears.

## Spawn-phase resource safety

Spawn markers and the visual heatmap stay on the bounded coarse scorer. The
map-wide exact candidate index is created only when the bot's smart-spawn
selector needs it; on large maps its estimated typed-array peak is capped at
32 MiB and the bot falls back to the visual ranking.

### Border-pressure construction priority

With `winFixes` enabled, `StructureBehavior` compares the bot's
`config.maxTroops()` with each live hostile player that shares an exact border via
`sharesBorderWith`. If any hostile army is strictly larger, the construction
planner prioritizes economic growth and tries `City` before `Port` or `Factory`.
On high-density maps, the same signal also bypasses the first `Port`/`Factory`
shortcut so that exception cannot override the `City` priority. The pressure
snapshot is cached for the current game tick; allied players, same-team players,
and remote hostiles do not activate this rule.

## Free-land expansion cadence

With `winFixes` enabled, the first live Terra Nullius attack sends 10% of the
current army or the calculated first-tile cost plus a 25% margin, whichever is
larger. The 60% opening value is only a cumulative ceiling across accepted
intents. Directly accessible free land then remains on the same fast adaptive
path. Pending-intent
reconciliation prevents duplicate sends from a stale troop snapshot, and the
shared client limiter (10 intents per second and 150 per minute) remains the
authoritative maximum cadence. Border-threat and opening-army reserves still
block a follow-up that cannot be funded safely.

Unacknowledged construction purchases reserve gold per game instance and player.
Replaying a seed with the same player ID cannot inherit a prior game's reservation,
and another game's clock cannot expire purchases still pending in this one.
Legal builds on tile zero use the native build event directly because BuildMenu
otherwise drops them. They consume the same single intent and purchase budget.

Once a hostile silo is built, an established economy preserves the first SAM's
cost in the shared construction budget, including the early plateau-City lane.
The income bootstrap, defensive structures, and surplus above that fund remain
available; an already ordered SAM releases this first-launcher reserve.

## Team donation policy

When `winFixes` is enabled, automatic troop donations remain restricted to needy
players on our team. Allies under attack rank first, then other frontline allies,
then rear allies. Within each urgency tier, closer recipients rank ahead of farther
ones, followed by lowest troop percentage and matching clan tag. Missing location
or clan data never excludes a teammate and falls back to the remaining signals.

Before emitting a donation, the bot also scans every owned tile on its border and
collects the live non-self players occupying adjacent land. It retains at least
half of the strongest of those bordering armies, including an allied player; a
stronger enemy elsewhere on the map does not affect this specific border reserve.
If the live border data or player snapshot is unavailable, the donation fails
closed for that tick.

If a client build does not expose the donation event constructor, the bot uses
the same rate-limited direct intent packet as the boat macro so a valid donation
is still delivered.

When `pauseDonateDuringExpansion` is enabled (the default), both proactive and
strategy-driven donations pause during the post-spawn expansion window when the
bot has direct non-nuked free land, a land-border tribe, or a sea tribe whose
transport route is estimated at 30 game ticks or less. The setting is persisted
with the other Donate tuning controls, and the panel reports the active reason.

Both donation paths also pause when a live enemy transport targets our territory.
The incoming transport troop payloads are summed, and donations remain paused so
natural troop production can build a defending force at least that large. If the
unit or ownership APIs cannot be inspected, donation fails closed until the
maritime threat can be classified.
Unknown troop counts do not stop the transport scan: the earliest measured
arrival still includes later boats. Any unmeasurable arrival keeps the ETA
unknown, and an unreadable peer cannot erase an already confirmed invasion.

`bestTransportShipSpawn()` reports whether a boat route exists and its spawn tile,
but not its path length. `gameApi.js` now uses that spawn plus a bounded
full-resolution water-graph search to calculate the shortest route in ticks. An
upstream `src.transportRouteTicks(tile)` adapter takes precedence when available.
This local search is a documented `DIVERGENCE` from the engine's HPA/smoothing
implementation and is active only under `winFixes`; Early Game keeps its strict
300-tick gate, while exploratory/probe boats reject unknown or longer-than-1,200-
tick routes (two minutes at 10 ticks/s). `window.__autoBotDiag()` reports
`boatRouteAvailable`, `boatGate`, the last ETA, and rejection counters.

An opportunistic beachhead receives at most one 25% surge during its 150-tick
window. The destination-keyed history survives replacement of the transient
beachhead record, preventing repeated probes of the same tile from reopening the
surge loop. Fresh destinations remain eligible, preserving parallel naval
expansion while keeping the army available for land attacks.

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
| 4 | `helpers.js` | Game metadata and small shared helpers (`clamp`, `toNum`, game-speed `scaled`, `safeName`, `withTimeout`, …). |
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
It touches `state`, runtime readiness, constructor discovery and many helpers across
modules — if it returns a full object, the wiring is intact.

## Legendary construction mode

Legendary is the only selectable helper difficulty. Saved older tiers migrate to
Legendary, retaining the adaptive improvements previously exposed as Impossible.
Headless simulations use Legendary for the helper and native Impossible for the
game's opponents (the upstream engine has no Legendary difficulty).
Simulation hostility and recapture metrics use player identity and the engine's
team relation, not equality of nullable team labels. FFA rivals and neutral ground
are never counted as our side; remaining enemy structures stay in the quota report.
The simulation keeps one build-menu event bus per attached game and supports
alliance breaks separately from alliance requests, plus attack cancellations.
Constructor discovery therefore retains the same identity across decisions.
Structure trace wrappers preserve nuclear-priority options and precomputed land
threats when forwarding a build or upgrade to the bot.
Page-player proxies unwrap peer arguments before native engine calls, preserving
the object identity used to recognize pending alliance requests and allies.
Cooperative tribe planning retains still-live scored targets when global tribe
membership changes mid-refresh, while immediately requesting fresh topology.
Captured, allied, and stale maritime gateways remain excluded at launch time.
Emergency warship construction uses the interception planner and the worker's
actual spawn tile. A legal hull without a pre-landing interception assignment
does not bypass economic reserves merely because an incoming transport exists.
SAM upgrade probes retain the worker's exact price even when `canUpgrade` is
false. Insufficient funds therefore avoid repeated worker requests; reaching
that price triggers a fresh legality check, never an assumed build permission.
First-Port placement treats the absence of another Port as zero spacing value,
so finite rail, ally, and missile-risk preferences remain effective instead of
collapsing every candidate to Infinity.
Version 1.12.161 fixes refresh starvation observed on `legendary-audit-159-europe`:
21 of 32 refreshes after tick 1750 were discarded despite scored live targets.
With the fix, that seed reaches tick 5000 with 43829 tiles; holdout A below
reaches 5000 with 94409 tiles. Holdout B instead dies at 4882 (baseline alive
at 5000), so the correctness fix is not evidence of universally better strategy;
the changed expansion trajectory in B required a tactical investigation.
Version 1.12.162 removes the uncatchable emergency hull purchase in B: the
second City moves from tick 3430 to 1970, and B reaches tick 5000 with 44971
tiles and 2087887 troops. The diagnostic seed and holdout A retain their 1.12.161
final state at that horizon. None of these horizon-limited runs proves a win.
Extending 1.12.162 to 12000 ticks: the diagnostic seed dies at 6776 and B
at 7287, both with zero recorded own structures nuked. A remains alive at
12000 with 91646 tiles and 2494301 troops (not a win). Late-game stagnation
and invasion survival therefore remain open; the 5000-tick results are not
an end-to-end completion claim.

Counterattack audit (2026-09-09, helper 1.12.160, headless identity fix
`e642d35f`): removing only the cumulative attrition cap, while retaining the
per-wave and production-reserve gates, is **not promoted**. Europe Normal FFA,
50 Nations, 180 bots, no modifiers, native Impossible, helper Legendary:

| Seed | Baseline | No cumulative cap |
| --- | --- | --- |
| `legendary-audit-159-europe` | Dead at 3817 | Dead at 4846 |
| `legendary-cap-holdout-a` | Dead at 3735 | Dead at 3761 |
| `legendary-cap-holdout-b` | At 5000: 35175 tiles, 1879604 troops, 1444388 gold, 2 Ports | At 5000: 33463 tiles, 1473701 troops, 727293 gold, 1 Port |

The last pair is horizon-limited, not a victory comparison. A longer survival
on the diagnostic seed does not justify weakening the ledger globally.

The headless adapter schedules zero-delay cooperative work at the runner's task
boundary, not against wall-clock milliseconds. Positive worker timeouts remain
real-time safety limits. Published engine motion plans reach the headless game API
as they do the live client; inactive units and finished paths release their plans.
Nuclear traces distinguish affordable bomb selection
from launch approval; a selected Atom can still fail the expected-value gate.
Queued nuclear launches revalidate their target every decision, including before
their scheduled launch tick. Invalid targets are removed immediately; when the
last queued launch disappears, its silo-slot reservation is released.
An initial salvo launch rejected by a worker probe or the intent budget enters
the existing next-tick retry queue without dropping the rest of the salvo.
Exceptional exits also reconcile the reservation with the surviving queue.
Queued saturation shots retry while their own emitted prefix still awaits native
missile receipts. This prevents revalidation from forgetting valid but not-yet-visible
Atoms. The barrier uses the shared dispatch ledger's existing six-tick grace,
grants no assumed SAM capacity, and does not block ordinary shots or other salvos.
Invalid targets still cancel immediately; after expiry, real SAM accounting decides.
The receipt barrier is captured when a pending pass starts. New shots from that
already validated batch do not block its remaining due shots; the existing
three-shot cap still limits the pass. Their receipts gate the following pass.
The Hydrogen finisher waits for its own salvo's queue to drain. Delayed or retried
launches move its deadline to the actual launch tick plus flight time and the
existing five-tick landing margin; failed sends do not count as launches.
Active own Atoms aimed at the same tile also hold the finisher. Their live motion
plans extend its deadline to actual impact plus five ticks, including native
same-silo departure delays. Unknown motion holds it until those Atoms resolve.
Local salvo delays never decrease in closest-silo slot order. A delayed or failed
head queues its tail, and a queued retry prevents later bombs of that same salvo
from overtaking it. Otherwise the engine can assign a different silo than the
one used to price its trajectory and flight time.
SAM-salvo revalidation counts charges that can reload by the latest remaining
planned arrival, including delayed-launch retries. Unknown flight or reload data
keeps the conservative full-capacity estimate.
Revalidation also forecasts SAM charges consumed by already-launched own Atoms
with exact live paths. It uses the shared interceptor scheduler across hostile
SAMs, excludes missiles already pursued by an interceptor, and gives no credit
to charges that reload before the remaining salvo arrives. Unknown trajectories,
unfinished launchers able to intercept those trajectories, and inconclusive
schedules retain the conservative estimate. Construction outside those routes
does not cancel an otherwise viable finisher.
Bot Atom/Hydrogen intents use the upward arc assumed by their trajectory forecast.
Single shots require a clear flight path. The shared dispatcher rechecks
the live silo and route after worker pricing;
deferred saturation atoms keep their salvo metadata and interception exception.
Both ordinary nuclear decisions and
the freeze-giant fallback delegate SAM-covered targets to the existing anti-SAM
salvo planner, which funds and schedules every required atom. Merely owning enough
silo levels never authorizes a lone interceptable bomb. No destination coverage
does not imply a clear flight path.
Anti-SAM aim points score structure value around each candidate blast center,
so nearby structures can improve the chosen aim. They subtract the same friendly
structure replacement penalty as ordinary shots.
The penalty follows the engine's strict outer destruction circle; the inner
fallout boundary does not reduce a structure's loss.
The SAM must remain strictly inside the circular blast, matching the engine's
structure-destruction rule, including diagonal candidates and outer-boundary tiles.
The manual arc toggle is restored immediately after dispatch, including failures;
manual launches and macros keep the player's selected direction.

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

An army-sized strategic land invasion retains its Defense Post budget even when
the prospective nuclear forecast is urgent. Actual incoming-missile SAM actions
still run first; a forecast alone cannot bypass the land reserve to buy a silo or
economic structure during that invasion.

Preventive structure-coverage SAM placement takes construction deadlines from
missiles already in flight, not hypothetical immediate launches from enemy silos.
The coverage forecast still requests the launcher; live blast and interception
safety checks remain in force while it is placed.

City upgrade prices are reused only within the current game tick. Failed or
temporarily unavailable probes are not cached as prices, and later ticks query
again because another City build or upgrade can change the authoritative cost.
Capacity-relief and generic economic upgrades use the same post-reserve gold
budget as ordinary construction, so City/Factory upgrades cannot consume the
next Atom's reserved treasury. Ports keep their trade-economy exemption.
The Atom reserve is released whenever no live opposing player owns a nuclear
structure target, including before the first launch, and resumes if a target appears.
When Atoms remain queued, the same construction reserve covers all unsent Atoms
and shrinks as the queue drains or is cancelled. Defense and Port exemptions retain
their existing priority.
Construction budgets share the dispatcher's reservation ledger for purchases
already emitted against a balance that has not yet caught up.
Atom, Hydrogen and MIRV dispatches also reserve native silo capacity until their
new missile appears, or the same six-tick dispatch grace expires. Source prediction
and salvo planning replay those unacknowledged intents in emission order against
all current silos, including newly built closer ones; acknowledged missiles are
counted only through the native silo queue. Outside this dispatch round trip,
source prediction retains the validated readiness policy.
The receipt matcher uses new own missile IDs, type and destination. Manual shots
to the same destination during that round trip, and receipts first seen after
their dispatch grace expired, cannot be distinguished from later bot receipts.
A missile missed entirely between snapshots keeps a conservative slot reservation
until grace expiry.
Salvo travel time is refreshed from the currently projected closest source after
the worker quote and committed only when dispatch succeeds. Immediate launches
propagate it into the initial Hydrogen deadline; delayed launches propagate it
when they actually emit. Native departure waits still reconcile from live missile
motion, and previously emitted shots can change source before server execution.
Silo and SAM upgrades recheck live missile impact zones after worker pricing.
A threatened silo defers its purchase while retaining valid nuclear capacity demand,
so that request can resume when the hazard disappears.

Productive sites are placed using the engine's rail connectivity score and an
additional team-position score: nearby powerful allies are ranked by the maximum
relative signal among troops, treasury, and gold production, with extra value for
nearby/high-level friendly SAMs. The own border segment closest to the geometric
center of the team is preferred when other constraints are comparable.

The SAM placement scorer builds the existing-coverage snapshot once for the
candidate set and reuses it across all candidate tiles, so mature boards do
not repeat the same structure-versus-SAM geometry scan for every probe.

SAM placement and upgrades are trajectory-aware. The planner reads missile
motion paths from the client as typed arrays and normalizes active missile paths
before route scoring, preserving their remaining trajectory instead of rebuilding
the original parabola.
Missiles still waiting in a silo retain the motion plan's launch delay in both
the impact deadline and SAM interception windows.
The route appends the detonation tile omitted by the motion plan without moving
the impact deadline, keeping the final in-flight position interceptable.
The planner reads enemy silo
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
full `SAMCooldown` reload and is not immediately available. When a salvo is too
large for one upgrade, Legendary stages upgrades that materially reduce the
unintercepted threat instead of waiting for a single upgrade to solve the whole
salvo. Legendary spends on an emergency SAM only when it completes with at least
five ticks before the first impact and the resulting schedule defends the whole
salvo; otherwise it does not invest in the threatened construction path.
The emergency path bypasses the ordinary structure cooldown and team save-up
block so a viable defense action is not delayed. Short assignment conflicts use
bounded exact backtracking; the search uses binary intercept lookup, copies only
the SAM state changed by a branch, and removes equivalent ready-slot branches.
If the search budget is exhausted, Legendary treats the result as
inconclusive/unsafe rather than assuming a greedy miss proves impossibility.
