# Legendary Economy Projection - Warm-Budget Optimization Plan

Status: PLANNED (lead-approved lot, sequenced after publication; engine edits HOLD until reopen notice).
Regression gate: test/legendary-economy-projection-budget.mjs check mode (durable golden, bit-exact).

## Baseline evidence (measured 2026-10-16, this checkout)

- warm1 (25 candidates x 102000-tick horizon): 18.7-20.3 s vs 10 s hard guard. cold 44-62 s. warm steady-state 2.5 ms.
- Per candidate ~410 ms; first candidate ~875 ms (rate-cache build). Candidate routeKeys differ (distance 40+i*4), so the per-candidate 'after' projection is a genuine cache miss; candidateKey already excludes gold values, so cross-candidate reuse by gold is impossible without changing dynamics (distance/weight drive arrivals).
- V8 CPU profile (13.2 s total): project loop self 10.9 s (83%), refreshTradeRates 1.35 s, legendaryProjectEconomyFleets setup 416 ms, scheduleTradeShipArrivals 378 ms, refreshTrainRates 46 ms, legendaryEconomyNetGold payout integration 4 ms (NOT the cost).

## Goal

warm1 < 10 s (target < 6 s margin under desktop load), bit-exact outputs vs the recovered pre-optimization goldens. No test weakening; the guard stays at 10000 ms.

## Constraints (bit-identity contract)

- Only invariant hoisting and lookup restructuring. Any change that reorders, removes, or re-associates floating-point arithmetic is FORBIDDEN.
- Integer conversions may be precomputed only when the expression is byte-identical (Number(x)||0, Math.floor chains on integers).
- Map iteration order and Float64Array semantics untouched.
- After every step: run the golden check (must print all PASS + budget PASS), then the six team scenarios + selection/cost-quote/port-delay tests. Re-profile with node --cpu-prof to document the delta.
- Edits confined to engine/ingame/auto-bot/legendary-planner/part-03..09.js hot path; every part stays <=200 lines (chunks are byte-joined, so in-place edits within a part are preferred).

## Steps (each independently testable, ordered by expected yield)

1. Inline the rate-cache lookup in refreshTradeRates (part-06): hoist the byLevel Map per level once per projection; keep has/get/set and the lower/upper interpolation arithmetic identical. Removes 2 closure allocations + nested Map gets per tick per level. Profiled cost today: 1.35 s total.
2. Per-cohort invariant precompute in the project loop (part-06/07): readyAt, level, count, and route tuples (travelTicks, weight) computed once per cohort before the tick loop; the loop uses locals. Removes ~4 Number/Math.floor chains per tick per cohort. Integer-exact.
3. Inline scheduleTradeShipArrivals (part-06 closure, called from part-07): replace the per-port-per-tick closure call with a direct loop over the precomputed route tuples writing tradeShipArrivals[arrivalTick] += births * weight. Same float operations, same order. Profiled cost today: 378 ms.
4. Hoist tradeRatePrefixes.get(level) (part-07): build a level-indexed array of prefix Float64Arrays once; per-tick writes go to the hoisted arrays. Same stores, same values.
5. Re-profile. If warm1 still > 10 s, next candidates (in order): split the tick loop at candidate readyAt boundaries so the per-tick candidate branches (factoryReadyAt/portReadyAt checks) collapse into two simpler loops (branch conditions are tick-invariant within each segment); then repeat step 1 for refreshTrainRates (46 ms today, low priority).

## Explicitly rejected (identity-unsafe)

- Decomposing after = baseline + candidate contributions: rate depends on total stock, nonlinear coupling.
- Incremental rate computation exploiting linearity in count (repeated subtraction changes float results).
- Early loop exit / horizon shortening.
- Cross-candidate sharing by gold signature: gold is not in candidateKey because it does not affect dynamics; distances differ per candidate so dynamics genuinely differ.

## Verification checklist at execution time

- node test/legendary-economy-projection-budget.mjs  -> all PASS + 'hard budget cycle < 10000ms: PASS'
- six legendary-economy-team-scenario-0*.mjs -> exit 0
- legendary-economy-selection, legendary-port-economy-selection, legendary-economy-action-cycle, legendary-economy-cost-quote, legendary-port-construction-delay -> exit 0
- construction-simulator-live-config.mts (tsx) -> exit 0
- node --cpu-prof before/after table appended to this file
- wc -l on every touched part <= 200
