# Auto-Bot Port Contract — how to faithfully translate a src Nation behavior into a page-bridge JS module

This is the single source of truth for porting `src/core/execution/.../Nation*Behavior.ts`
(and `utils/AiAttackBehavior.ts`) into the extension auto-bot. The goal is a
**1:1 faithful translation** — preserve every branch, constant, probability,
strategy order, and call order. Do NOT summarize, simplify, "improve", or add
heuristics. The ONLY changes allowed are the mechanical API substitutions below.

## File shape

- Plain classic script, no `import`/`export`. Start with a top comment then
  `"use strict";`. Top-level `class XxxBehavior { ... }` (shared global lexical
  scope — the class name is visible to `nationExecution.js`). 2-space body indent
  to match sibling modules.
- Class names + constructor signatures are FIXED (nationExecution.js constructs them):
  - `class EmojiBehavior { constructor(random, game, player) }`
  - `class MirvBehavior { constructor(random, game, player, emojiBehavior) }`
  - `class AllianceBehavior { constructor(random, game, player, emojiBehavior) }`
  - `class WarshipBehavior { constructor(random, game, player, emojiBehavior) }`
  - `class StructureBehavior { constructor(random, game, player) }`
  - `class AttackBehavior { constructor(random, game, player, triggerRatio, reserveRatio, expandRatio, allianceBehavior, emojiBehavior) }`
  - `class NukeBehavior { constructor(random, game, player, attackBehavior, emojiBehavior) }`
- `random` is a `PseudoRandom` (portutil) — use `random.nextInt/chance/randElement/randFromSet/shuffleArray/next` exactly as src does.
- `game` is the gameApi core-shaped object; `player` is the gameApi wrapped "me".

## Difficulty (IMPORTANT)

src reads `this.mg.config().gameConfig().difficulty`. REPLACE every such read with
`currentDifficulty()` (portutil) — the user-selected difficulty the bot replicates.
Compare against `Difficulty.Easy|Medium|Hard|Impossible|Legendary` (portutil constants).
EXCEPTION: `config().maxTroops(player)` internally uses the real lobby difficulty —
leave those calls as-is (they read true enemy/our stats).

`Legendary` is the intentional adaptive exception to the 1:1 Nation construction
order: `StructureBehavior` ranks City/Factory/Port/Silo/SAM candidates with an
equal-weight max-min objective over gold production and troop generation. Missile
defense is a safety constraint/tie-breaker, and a Defense Post is only allowed for
an exceptional land assault. The Legendary placement scorer also uses engine rail
connectivity, friendly ally power/proximity, the own border nearest the team's
geometric center, and trajectory-aware SAM coverage.

## Enums & unit constants (portutil.js / gameApi.js / core.js — already global)

- `UNIT.City|Port|Factory|SAMLauncher|MissileSilo|DefensePost|TransportShip|TradeShip|Warship|AtomBomb|HydrogenBomb|MIRV|MIRVWarhead` (string UnitType values). Replace `UnitType.City` → `UNIT.City`, etc.
- `Difficulty`, `GameMode` (`.FFA`/`.Team`), `GameType`, `PlayerType` (`.Bot`/`.Human`/`.Nation`), `TerrainType` (portutil).
- `Relation` (`.Hostile`=0/`.Distrustful`=1/`.Neutral`=2/`.Friendly`=3) (gameApi).

## gameApi surface (what `game` and `player` expose)

### game (sync, core-shaped)
`ticks()`, `inSpawnPhase()`, `isSpawnImmunityActive()`, `config()` (passthrough to
the real Config — has maxTroops/isUnitDisabled/unitInfo/nukeMagnitudes/samRange/
defaultSamRange/maxSamRange/SAMCooldown/defaultNukeSpeed/defaultNukeTargetableRange/
boatMaxNumber/donateTroops/numSpawnPhaseTurns/startingGold/trainGold/
trainStationMinRange/trainStationMaxRange/minDistanceBetweenPlayers/gameConfig()…),
`myPlayer()`, `players()`, `playerViews()`, `playerBySmallID(sid)`, `nations()`,
`terraNullius()`, `owner(t)`, `ownerID(t)` (null if unowned), `hasOwner(t)`,
`numLandTiles()`, `numTilesWithFallout()`, `getWinner()`, `units(...types)`,
`unitCount(type)`, and GameMap routes: `ref(x,y)`, `x(t)`, `y(t)`, `cell`,
`width()`, `height()`, `isValidCoord(x,y)`, `isOnMap(cell)`, `isLand/isWater/
isOcean/isShore/isOceanShore/magnitude/hasFallout/terrainType(t)`, `neighbors(t)`,
`manhattanDist(a,b)`, `euclideanDistSquared(a,b)`, `nearbyUnits(tile,range,types[,…])`,
`hasUnitNearby(...)`.

Tiles are opaque numeric TileRefs. Owner/player identity: compare by `.smallID()`
(NOT `===` — src uses `===` on player identity; REPLACE `a === b` player/owner
comparisons with `a.smallID() === b.smallID()`, and `owner === player` with a
`.smallID()` compare; for TerraNullius check `!x.isPlayer()`).

### player / other players (sync unless noted)
- sync: `isPlayer()`, `isAlive()`, `hasSpawned()`, `smallID()`, `id()`, `type()`,
  `name()`, `displayName()`, `troops()`, `gold()` (BigInt — keep bigint math for
  costs: `BigInt`, compare with `>=`, etc.), `numTilesOwned()`, `team()`,
  `maxTroops()` (= config().maxTroops(self)), `units(...types)`, `unitCount(type)`,
  `unitsOwned(type)` (built count), `unitsConstructed(type)` (bool, has a built one),
  `totalUnitLevels(type)`, `incomingAttacks()`, `outgoingAttacks()`, `targets()`,
  `allies()`, `transitiveTargets()`, `alliances()`, `isFriendly(o)`, `isAlliedWith(o)`,
  `isOnSameTeam(o)`, `isRequestingAllianceWith(o)`, `hasEmbargoAgainst(o)`,
  `isTraitor()`, `isDisconnected()`, `betrayals()`, `getTraitorRemainingTicks()`,
  `nameLocation()` (→ {x,y}).
- `borderTiles()` → returns a SYNC `Set<TileRef>` snapshot. For `player` (me) it is
  pre-fetched each tick. For OTHER players it is EMPTY unless you first
  `await game.__ensureBorderTiles(otherPlayer)` (see Async). (calculateTerritoryCenter
  and randTerritoryTileArray call borderTiles() synchronously — ensure the target's
  border was fetched first.)
- relation (reconstructed, SYNC): `relation(other)` → Relation bucket;
  `allRelationsSorted()` → `[{player, relation}]` asc; `updateRelation(other, delta)`
  → writes the AI-subjective overlay (no intent). Use these exactly where src does.
- `nearby()` → SYNC array of nearby players AND TerraNullius (exact src reconstruction).
- `sharesBorderWith(other)` → SYNC bool.

### Attack objects (from incomingAttacks()/outgoingAttacks())
Each has `troops()`, `attacker()` (wrapped player), `target()` (wrapped player),
`retreating()`, `id()`, `sourceTile()` (TileRef or null). (src AttackUpdate uses the
same accessors.)

### Unit objects (from units()/game.units())
`type()`, `tile()`, `level()`, `id()`, `owner()` (wrapped), `isActive()`,
`isUnderConstruction()`, `isInCombat()`, `hasTrainStation()`, `missileTimerQueue()`,
`targetTile()`, `patrolTile()`, `warshipState()`, `transportShipState()`, `health()`.

## Async boundaries (the ONLY place control flow differs from src)

These client reads are async worker calls. The methods that use them BECOME `async`
(and nationExecution awaits them — already wired for handleStructures/maybeAttack/
considerMIRV/maybeSpawnWarship/counterWarshipInfestation/maybeSendNuke). Wrap each in
`withTimeout(promise, WORKER_TIMEOUT_MS, fallback)` (helpers.js).

1. **buildables / canBuild** — `await player.buildables(tile, [UNIT.X])` → `BuildableUnit[]`
   each `{type, canBuild: TileRef|false, canUpgrade: unitId|false, cost: bigint}`.
   src calls `player.canBuild(type, tile)` SYNCHRONOUSLY inside value loops. REPLACE
   with the **rank-then-probe** pattern: score ALL candidate tiles synchronously by
   the src value function, sort desc, then `await buildables(tile,[type])` DOWN the
   ranked list and take the first whose `canBuild !== false`. To actually build:
   `getBuildMenu().sendBuildOrUpgrade(buildableUnit, tile)` (structures pass the
   snapped `bu.canBuild` tile; WARSHIPS pass the queried WATER tile; nukes/MIRV pass
   the target tile). To UPGRADE: `sendBuildOrUpgrade(bu)` where `bu.canUpgrade !== false`.
2. **bestTransportShipSpawn / canBuildTransportShip** — `await player.bestTransportShipSpawn(tile)`
   → spawn TileRef or `false`. src `canBuildTransportShip(g,p,tile)` == this `!== false`.
   It is called inside RNG loops (findRandomBoatTarget 500 iters, island, TN boat). Apply
   rank-then-probe: COLLECT up to K (≈4) candidate tiles by the cheap sync src criteria,
   then await bestTransportShipSpawn down the list, take the first `!== false`.
   Early Game must not reinterpret reachability alone as an ETA. Under `winFixes`,
   `gameApi` combines the returned spawn tile with a bounded full-resolution water-graph
   search and accepts only routes up to 300 ticks. `src.transportRouteTicks(tile)` takes
   precedence when an upstream exact adapter exists. The local graph search is a marked
   `DIVERGENCE` from the engine's HPA/smoothing path; if it is unavailable or exceeds its
   budget, the Early Game naval gate fails closed. The faithful non-Early path remains
   unchanged.
3. **borderTiles of OTHER players** — `await game.__ensureBorderTiles(player)` before
   reading that player's `borderTiles()` synchronously (e.g. before calculateTerritoryCenter
   or scanning a target's tiles). Cache is per-tick; only fetch targets you actually need
   (bound the count — e.g. island enemy early-exits at ≤2 reachable).
4. **profile** — already snapshotted into the relation overlay each tick; just use
   `player.relation(...)`. Do NOT call profile() yourself.
5. **actions** — `await player.actions(tile, units)` → `PlayerActions` (`{canAttack,
   buildableUnits, interaction:{canSendAllianceRequest, canBreakAlliance, canDonateTroops,
   canDonateGold, sharedBorder, …}}`) — may be null under the harness; guard and fall back
   to local checks (`sharesBorderWith`, relation, etc.).

## Actuation (emit the same intents the UI emits)

`const ctors = discoverCtors(getEventBus());` then `emitIntent(ctors.X, ...args)`:
- `ctors.spawn` → `(tile)`  | `ctors.attack` → `(targetID|null, troops)` (targetID =
  `target.id()` string, or `null` for TerraNullius) | `ctors.boat` → `(dstTile, troops)`
  | `ctors.moveWarship` → `([unitId], tile)` | `ctors.embargo` → `(targetPlayerView, "start"|"stop")`
  (pass `other.__src ?? other`) | `ctors.donateTroops` → `(recipientView, troops)` |
  `ctors.emoji` → `(recipientView|AllPlayers, emojiNumber)`.
- Build/upgrade/nuke/MIRV/warship: `getBuildMenu().sendBuildOrUpgrade(bu, tile)` (see Async #1).
- Alliance accept/reject/extension: click `<events-display>` event buttons — see the
  AllianceBehavior notes (read the deleted `alliance.js` at git restore for the
  events-display reading pattern, but DO NOT reintroduce its custom strategy; only reuse
  the events-display plumbing). Alliance REQUEST origination: `ctors.allianceRequest`
  (learned lazily). Break alliance: the other `{requestor,recipient}`-shape ctor.
- For args that are players, pass the gameApi wrapper's `.__src` when the real intent
  expects a PlayerView (`emitIntent(ctors.X, p.__src ?? p, …)`); for attack/boat/spawn the
  args are ids/tiles/troops (numbers/strings), pass directly.

## Logging (optional, matches old UX)

`setLastAction(text, cat)` where cat ∈ `"spawn"|"combat"|"naval"|"build"|"nuke"|"diplo"`.
`state.stats.{spawns,attacks,builds,nukes}++`. Keep these light; they are not strategy.

## portutil helpers available

`PseudoRandom`, `simpleHash`, `within(v,min,max)`, `closestTile(gm,refs,tile)`,
`closestTwoTiles(gm,x,y)`, `calculateBoundingBox(gm,set)`, `boundingBoxCenter(box)`,
`calculateBoundingBoxCenter(gm,set)`, `boundingBoxTiles(gm,center,r)`,
`calculateTerritoryCenter(game,target)`, `randTerritoryTileArray(random,gm,player,n)`,
`currentDifficulty()`. (Parabola pathfinder + emoji-id tables are added in nuke/emoji
phases — if your behavior needs `flattenedEmojiTable` or `ParabolaUniversalPathFinder`,
note it and a stub will be provided.)

## Genuine data shims (StructureBehavior only)

`sharedWaterComponents(player)` and `railNetwork()` are NOT client-available. The
StructureBehavior porter must implement the two documented approximations in gameApi
(ocean-shore for coastal; train-station proximity union-find for rail clusters) — these
are the ONLY approximated datasets used by structure placement. Everything else is
faithful.

### Ocean-only port placement rule

The custom userscript deliberately narrows the core `SharedWaterCache` rule for
port placement. A port candidate must be a shore tile adjacent to the canonical
open-ocean component reported by `game.isOcean`, which is the largest connected
navigable water surface. Smaller closed lakes and seas are never valid port sites,
even when `sharedWaterComponents(player)` reports that a living ally or teammate
shares the water. That shared-water result remains available to broader
coastal/trade planning; it is not a port-placement authorization.

### Custom Early Game coastal/tribe targeting

When `state.settings.winFixes` is enabled, `AttackBehavior.maybeAttack()` has a
documented policy seam before the existing bot/Terra Nullius fallback. It may
enrich only nearby non-friendly `PlayerType.Bot` tribes with bounded border
snapshots. A land-border tribe is actionable immediately; a sea-only tribe is
actionable only when the same transport pathfinder used for actuation verifies
an ETA from 0 through 300 ticks. Unknown and slower routes are excluded rather
than merely ranked lower. The verified target shore is retained for boat
actuation, and known land-border tribes enter the bounded sample before
speculative sea candidates. Remaining sea candidates are preselected by the
cheap territory/troop opportunity bound rather than opaque `nearby()` order.

Eligible tribes receive a normalized utility: the equal-weight mean of route
efficiency, territory gained per estimated defending troop (including active
Defense Post cost), food-race urgency, the stronger of encirclement or passage
blocking, future-tribe continuation, and nearby navigable maritime opportunity.
Equal weights are intentional: no one proxy can rigidly override the complete
strategic value. Capture efficiency is normalized within the bounded candidate
set; stable safety fields break exact ties. Only actionable candidates
participate in capture normalization and future-food continuation. A selected
maritime tribe uses the normal reserve-aware bot conquest amount; the one-percent
payload remains a Terra Nullius probe policy. Bounded border snapshots and
shore-route probes are awaited in parallel groups to avoid multiplying worker
timeout latency by every candidate.
The race signal combines outgoing/incoming attacks with a bounded per-player
history of tile growth and `nameLocation()` movement as independent evidence; a
direct attack is fully urgent while a progressing vector toward the candidate
still raises urgency. Continuation is the mean remaining proximity to reachable
tribes, without hand-tuned count/distance weights.

When that race is real, the selected tribe attack may commit more troops than the
normal bot-target amount. The increase is capped by the same reserve floor used by
land attacks; boat attacks use the same bounded reserve-aware helper after their
normal probe amount is calculated. It reuses `sendAttack()`,
`allowEarlyGameBoat()`, and the client attack intent; it does not change the
faithful difficulty strategy arrays. If no ranked target can be actuated, the
original fallback continues.

The same win-fix may probe an unowned `isOceanShore` tile from an existing ocean
shore before generic opening expansion. `isOceanShore` is required so isolated
lakes cannot satisfy the coastal objective. The maritime distance field is
bounded to the same 80-tile opening radius, built once per game map, and reused
across all `AttackBehavior` instances.
The probe remains bounded by the existing rank-then-probe transport boundary
and the Early Game 300-tick ETA gate.
With `winFixes` disabled, these additions are inactive and the faithful Nation
flow remains unchanged.

### Custom TerraNullius land commit

With `winFixes` enabled, direct land attacks against TerraNullius use the live
`Config.attackLogic` loss for the worst available first frontier tile as their
complete payload, capped by the TerraNullius reserve and pending outbound
intents. This keeps a large free-land expansion from draining the home army.
Transport attacks use the same one-tile amount as a cheap probe.

### Custom maritime emergency economy

The live transport detector shared with auto-donate is also consumed by
`StructureBehavior` and `WarshipBehavior`. When an enemy `Transport` targets a
tile owned by the bot, the build decision is reserved for `Port` first. A Port
under construction blocks competing structure spends; without one, the bot
retries a valid open-ocean Port placement even when the ordinary structure
ratios would choose another type. Once a completed Port exists,
`maybeSpawnWarship()` bypasses its normal random roll and uses the first
affordable `Warship` buildable. The route-aware invasion planner is invoked from
`NationExecution` before ordinary ship tracking. If the detector or Port
placement contract is unavailable, the bot fails closed for the emergency path
and preserves the ordinary policy where a Port cannot exist.

### Custom enemy Defense Post-aware attacks

When `state.settings.winFixes` is enabled, land-attack target ranking and troop
commitment include the enemy Defense Post coverage of the current attack front.
The policy mirrors `Config.attackLogic`: one active, completed enemy post within
`defensePostRange()` (30 tiles in the current game) multiplies attacker losses
by `defensePostDefenseBonus()` (5) and slows conquest by
`defensePostSpeedBonus()` (3). Overlapping posts do not stack, and posts under
construction are excluded.

Coverage is measured only on the target tiles adjacent to our own border. The
profile is bounded to 512 front tiles and 256 posts, cached by target and game
tick, and reused by the bot attack pass. Defended targets therefore rank as
harder than equally sized open targets; bot attacks scale their preferred and
minimum troop thresholds by the damage multiplier, while ordinary land attacks
are skipped when the available commitment is below the Defense Post-aware
minimum. Boat probes keep their existing cheap-probe behavior. With `winFixes`
disabled, the faithful attack selection and troop calculation remain unchanged.

### Custom spawn-phase resource safety

The spawn markers and visual heatmap use only their bounded coarse scorer. They
must not initialize the exact map-wide candidate index; that index is reserved
for the bot's smart-spawn selector. The exact path estimates its typed-array
peak and falls back to the visual scorer when the estimate exceeds 32 MiB, so a
large map cannot turn spawn observation into a tab-wide allocation.

### Custom team donation clan priority

With `winFixes` enabled, the existing team-only troop donation keeps its needy
teammate and frontline filters, then prioritizes recipients whose clan tag matches
the bot's. Clan tags are read through the already-loaded `__OFHSpawnObjective`
adapter; missing tags never exclude a teammate and fall back to frontline status
and troop percentage. With `winFixes` disabled, the faithful donation ordering is
unchanged.

Both modes apply the same client-side border reserve before emitting the donation:
scan `player.borderTiles()`, inspect adjacent owned land through `neighbors()` and
`ownerID()`, and retain at least half of the largest live non-self bordering
player's troops. An alliance does not remove that player from the reserve
calculation. Missing border/player-snapshot data blocks the donation for that
tick.

### Border-pressure construction priority

When `winFixes` is enabled, `StructureBehavior` compares the bot's
`config.maxTroops()` with each live hostile player whose exact border is reported
by `sharesBorderWith`. If at least one hostile army is strictly larger, economic
growth is prioritized and `City` is attempted before `Port` or `Factory`. The
high-density first-`Port`/`Factory` shortcut is bypassed under the same signal.
The hostile-border snapshot is cached by game tick; allied players, teammates,
and remote hostiles do not trigger the priority.

### Custom missile-defense upgrade and silo parity

When `winFixes` is enabled, `StructureBehavior` checks the trajectory-aware
missile forecast before ordinary structure pacing for Easy through Impossible.
If upgrading one built friendly SAM improves the shared schedule enough to
intercept an incoming missile while retaining the five-tick impact margin, that
upgrade is emitted immediately. Legendary uses the same action through its
adaptive path. Existing queued SAM slots and the `SAMCooldown` of a newly added
level remain part of the forecast; an upgrade is not treated as an instantly
ready free interceptor.

The custom build policy also keeps missile-launch capacity at least equal to the
strongest hostile SAM network: for each hostile player it sums SAM levels, takes
the maximum of those per-player sums, and requires our missile silo level sum to
reach that target. A SAM under construction counts as one future level. This is
a max-per-enemy target rather than a global sum across unrelated opponents, and
the ordinary three-silo cap is relaxed only while this parity gap exists.

The inverse parity guard is also enforced: when a hostile player's projected
missile-silo level sum exceeds the highest built SAM level on our side, at least
one own SAM is upgraded toward that level before normal construction. If no own
SAM can be upgraded, SAM construction is prioritized until an interceptor
exists. Under-construction own SAMs do not count as immediately available for
this level comparison; the policy is gated by `winFixes` and respects the
user/game SAM-disabled settings.

## What faithfulness means here

Same strategy ORDER (the difficulty-indexed arrays), same constants/probabilities, same
gold/cost thresholds (bigint), same branch conditions. If you cannot reproduce something
client-side, leave a `// DIVERGENCE:` comment explaining exactly what and why — do not
silently approximate.

The decision cadence is an explicit userscript boundary: with `winFixes` enabled,
`engine.js`'s configured `tickMs` poll is the combat cadence and does not add the
source Nation's difficulty-based `attackRate` wait. With `winFixes` disabled, the
faithful `attackRate` / structure-third cadence is retained.
