# Validation continuation from b4f1889

Continuation baseline: `b4f18890601a2e20ea0f1a6089002ca58a893e33`; unchanged upstream `origin/main` at `62de315a496142b916cba1e37bca7134228ab3e7`. Work remains isolated on `fix/nuclear-coordination-independent`. No Rust edits or publication. Local candidate 1.14.16 deliberately skips the pending offline 1.14.15 label; that offline patch is not integrated.

## Corrected failures

- Intent rate limiting and early-game tests now inspect the authoritative build inventory, including actual rate-limiter load order. The early-game metadata guard checks generated metadata rather than a vacuous entrypoint-source search.
- Hot-reload tests execute the exported bridge and artifact publisher from the split build modules. Their transactional failure and rollback cases remain intact.
- Port economy projection uses a shared denominator at each route-weight expiry. Previously one expiring route switched to the post-alliance denominator while indefinitely active routes retained the original denominator, losing 10% of projected departures in the two-route regression. New staggered-expiry cases compare numeric, callback and optimized prefix integration against an independent reference, including travel and fractional boundaries. Partial intervals now use their true overlap midpoint. The final implementation accumulates shared weight and payout events in O(R log R), rather than scanning all routes at each expiry. Its prefix queries and fractional-edge probes grow linearly with route count. A single-route fast path preserves existing numerical golden semantics.
- The fixed FFA border scenario now checks the native first-land-attack pressure snapshot, native strategic player identities, nonzero shared border, and troop/ratio arithmetic. A valid scenario can die before buying any structure, so construction purchases cannot be a prerequisite for testing border telemetry. The obsolete unconditional FFA founding-City assertion was moved to the existing funded native nuclear fixture. Specific tests still enforce paid-route or binding-capacity eligibility; no production purchasing rule was relaxed. Optional `OFH_TEST_ARTIFACT_DIR` stores explicit scenario inputs, status and full output for offline diagnosis.
- Sixteen static dependency failures came from imports in raw split test fragments being resolved at a different directory from the actual joined ESM module. Private package imports `#test/*` and `#scripts/*` resolve to the same file in both locations. All five fragment hashes were regenerated and independently verified. Dependency rules remain enabled and unchanged.

- Unexpected synchronous motion-plan accessor failures now propagate, while missing optional data still retains the conservative fleet estimate. The optional partner worker probe retains its timeout and unpriced-seed refusal, but quote parsing errors now propagate outside that narrow handler. Sentinel regressions fail on the previous source and pass on the corrected source.
- The memory-gated validation runner uses child status/error results directly, reports failure and stops the chain. An injected failing first step verifies nonzero exit and prevents later execution. The headless failure audit permits only the exact optional worker boundary and still rejects unrelated handlers.

## Review

Independent agents reviewed the build contracts, shared projection correction, border scenario and all sixteen alias resolutions. No patch correctness blockers were found. The structure-radius change in the preceding commit remains a possible equivalent of offline 1.14.15 and must not be counted twice.

## Validation

`npm run quality:global` passes with the existing lint ratchet, type checking, generated-build parity, dead-code, dependency and duplicate checks. The final official `npm test` run passes with exit code 0: 13 pretest plus 107 sequential test commands, including all nine live native headless scenarios. `npm run quality:global` also passes with exit code 0 on the optimized source. Native scenario inputs and outputs are retained. Formatting of changed logical modules passes; historical repository-wide formatter issues in raw fragments and unrelated files are not claimed fixed.

Private aliases and all five byte-integrity hashes were independently checked. The test suite still rejects swallowed unexpected errors; the intentional worker rejection and validation failure cases are verified separately.

## Evidence and limits

Final command results, fixed-seed scenario outputs, the independent 500-case checker (seed 1481, tolerance 1e-8), the isolated performance probe and immutable patch are retained with the handoff. Synthetic regression success does not establish stronger gameplay or improved win rate. Before final validation, isolated dense-route testing exposed a quadratic intermediate correction: 256 distinct expiries required 131,584 prefix queries and about 543 ms. The final event accumulator needs 514 prefix queries and 256 point queries; observed isolated times were 2.6–11.7 ms under varying load. A 256-route operation-count regression enforces the linear work bound, alongside independent mixed-payout, fractional, disappearing-destination and invalid-interval cases. These measurements characterize the isolated calculation, not complete game ticks.

An earlier concurrent run of the separate broad projection benchmark passed its numerical goldens but exceeded its 10-second first-warm-cycle target; its cached repeat took 6 ms. That run preceded the final accumulator optimization, was not a clean serial comparison, and is not claimed as a green final benchmark.

Historical report: `nuclear-coordination-independent-20261017.md` describes the preceding checkpoint and its then-open failures. This continuation supersedes those validation statuses only where the final handoff records a completed check.

## Trello follow-up

- Transfer the reviewed local commits after verifying current remote and publication authority; do not publish from this task.
- Compare strict-radius changes with offline 1.14.15 before combining patches; preserve the independent confirmation-slot regression.
- Keep the seeded border scenario outputs and benchmark provenance with future runtime comparisons. Recheck the broad projection wall-clock budget serially on a controlled host; the concurrent measurement is not a clean performance comparison.
- Keep all Rust parity/cache work in the separate Cloud task.
