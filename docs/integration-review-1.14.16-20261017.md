# Integration review for immutable candidate 1.14.16

Candidate: `7531188cadfbc5626c523fd920efe8340bd9f6c8`, preceded by
`b4f18890601a2e20ea0f1a6089002ca58a893e33`. Remote main was independently
checked at `62de315a496142b916cba1e37bca7134228ab3e7` on 2026-10-17.
The candidate checkout remains unchanged. This follow-up lives on isolated
branch `review/projection-benchmark-1.14.16`; no runtime or Rust edits.

## Durable transfer

Library confirmed successful creation of `openfront-helper-continuation-1.14.16.tar.gz`:

- Library ID: `libfile_e4b0afa8a6348191ae1229e4e272cabf`.
- File ID: `file_00000000cdcc81fdb8e5d1159a17e93c`; version 0; 2,161,043 bytes.
- SHA256: `4d39e83b0d3179acb9ac159bb044d84fd133e230cd760bb2e15708fccd37a3a9`.
- Contains the Git bundle, patches, candidate report, logs and scenario evidence.

Consumers must resolve this Library identity and materialize their own copy;
workspace paths in this report are provenance, never cross-container addresses.
Verify SHA256 and `git bundle verify` before importing. The bundle requires the
recorded remote base. Do not claim missing offline patches or tooling integrated.

## Serial benchmark review

Run the unchanged `node test/legendary-economy-projection-budget.mjs` serially
on candidate and recorded remote baseline, each in a separate process. The
102,000-tick, 25-candidate fixture is outside `npm test` and `quality:global`.
No goldens, thresholds or benchmark source were changed.

Candidate: cold 30,900.7 ms; first shared-config cycle 13,477.1 ms; repeated
cycle 5.0 ms. All numerical goldens and the small-horizon reference pass;
the first shared-config cycle exceeds the unchanged 10,000 ms threshold
(process exit 1). Thus the broad benchmark is not green despite the official
suite and quality gates passing. This is a real synthetic synchronous-cost
warning, not proof of a particular browser frame duration or a hang.

Remote baseline: cold 26,119.2 ms; first shared-config cycle 13,298.4 ms;
repeated cycle 6.1 ms. It also exits 1 solely for the same budget check; all
numerical checks pass. This serial pair establishes an inherited budget failure
on this host. It does not establish a statistically meaningful speed regression
or improvement (candidate warm +1.3%, cold +18.3%; one sample each). Cold phases
use 25 fresh configs and deliberately defeat cache reuse. No real-match behavior
or browser latency is inferred. Both logs are retained separately.

The candidate's single-route fast path is exercised by this fixture; its fleet
projection implementation in planner parts 03, 05, 06 and 07 is byte-identical
to remote. A future optimization should profile the uncached fleet loop and
consider moving immutable cohort normalization outside the per-tick loop.
Preserve tick order, floating-point evaluation, construction timing and arrival
accounting; reject approximations or reduced horizons merely to pass the budget.
Keep that work isolated, use the next available semver after checking other work,
and require unchanged goldens, meaningful operation-count regressions,
independent review, the full official suite and `quality:global` before proposing
another candidate. Do not amend 7531188 or silently fold new code into its approval.

## Independent scope review

A separate reviewer checked the candidate against the remote base, verified
remote ancestry and a clean candidate tree, and reran alliance expiry, Port
selection, seed-component tests and `git diff --check`: all pass. No new
functional blocker was found. Economic corrections may alter selected actions;
there is no win-rate claim. Unexpected `motionPlans()` accessor errors now
propagate and abort the affected tick intentionally. The border fixture proves
native pressure telemetry, not survival or successful founding-City economics.

## Conservative integration gates

1. Obtain explicit publication approval for this exact candidate and destination
   from the parent/user. Approval remains pending; this task does not publish.
2. Fetch again and check remote, branch protection, release/version collisions and
   all concurrent work. If main remains the recorded ancestor, preserve the two
   commits as a series. If it moved, integrate in another branch and re-review
   the resulting tree; never force-push or overwrite concurrent changes.
3. When offline 1.14.15 becomes available, inspect its actual patch and compare
   strict blast-radius overlap. Neither its runtime fixes nor its Rust cache or
   unpublished tooling are assumed available. Do not cherry-pick overlapping
   behavior twice. If unavailable, record the missing comparison explicitly.
4. Retain the candidate's successful 120-step `npm test` and `quality:global`
   evidence. Any source/dependency/generated-artifact integration change requires
   rebuilding and rerunning both serially on the exact proposed tree. Include
   targeted nuclear, silo, expiry and border regressions, build parity,
   `git diff --check`, and the broad benchmark with its known failure disclosed.
5. Approval must acknowledge the disclosed broad-budget failure or await a
   separately validated optimization; never describe all performance gates green.

## Gates after any separately authorized publication

1. Fetch main from a fresh checkout and verify exact approved commit/tree,
   ancestry and version 1.14.16 in package metadata and all generated assets.
2. Compare downloaded raw userscript bytes and SHA256 with approved generated
   bytes. Check syntax/smoke, build parity and dependency-lock installation.
3. Run `npm test` and `quality:global` on that exact checkout with retained logs;
   run the separate broad benchmark serially and report its independent status.
4. Retain fixed-seed native synthetic border and funded nuclear/silo outputs;
   inspect diagnostics for propagated errors, intent limits and economy slot
   admission. No real matches, live lobby joining, paid services or access changes.
5. On mismatch, stop distribution work, preserve evidence and prepare a reviewed
   rollback/revert proposal; do not automatically overwrite main. Confirm the
   approved commit and postpublication gate outcomes to the parent/Trello.
