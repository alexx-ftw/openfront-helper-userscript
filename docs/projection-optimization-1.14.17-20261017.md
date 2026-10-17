# First-cycle fleet projection optimization — 1.14.17

This runtime change follows immutable candidate
`7531188cadfbc5626c523fd920efe8340bd9f6c8` and its isolated integration review
`cd028248934aa5d2d5716c75cd03d8be4b87d286`. Neither was amended. Remote main
remained `62de315a496142b916cba1e37bca7134228ab3e7` when this cycle began.
OpenFront engine stays pinned to `f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb`.
No Rust changes, real matches, paid services, access changes or publication.
The parent initially reported that permission control rejected publication
and delegation to publish. At that stage only local work remained authorized;
no alternate publication path or external execution was prepared.
The parent later supplied renewed explicit user authorization to publish
verified versions of this repository to main for autoupdate, subject to the
benchmark, review, full final suite, concurrency checks and permission control.
Any renewed rejection stops the publication action; no alternate route is allowed.

## Measured bottleneck and change

Serial CPU profiles used the unchanged broad benchmark on the same Node
v24.19.0 host, one process at a time. The fixture evaluates 25 candidates over
102,000 ticks; its budget is the first shared-config cycle under 10,000 ms.
That config starts without projection/rate cache entries. Cold mode instead
creates a fresh config for each of the 25 candidates, intentionally preventing
reuse even between neighboring candidates. Repeated warm results are reported
separately and are not the basis of acceptance.

Both remote and candidate profiles spend about 79% of sampled time in `project`.
The two repeated cohort normalization statements account for 79.1% and 78.6%
of that function's attributed line ticks, respectively. Probability/spawn-rate
calculation accounts for less than 1% of total sampled time. This establishes
the cohort loop, rather than the payout accumulator or cache hit path, as the
measured bottleneck.

Planner parts 06/07 now normalize cohort readiness and level once per local
projection. These records are freshly derived local objects; no external
getter or asynchronous mutation is moved across a boundary. Cohort order,
floating-point operations on births, arrivals, fleet-dependent rates and tick
resolution are unchanged. No new persistent cache, truncated horizon, altered
golden, approximation or relaxed wall-clock threshold is used.

| Serial run                | 25 fresh configs | First shared config | Repeated shared config | Original gate |
| ------------------------- | ---------------: | ------------------: | ---------------------: | ------------- |
| Remote, profiled          |      29,354.1 ms |         16,018.9 ms |                 2.7 ms | fail          |
| 1.14.16, profiled         |      32,326.9 ms |         17,636.4 ms |                 4.9 ms | fail          |
| Optimized, profiled       |       9,151.7 ms |          3,840.7 ms |                 4.2 ms | pass          |
| Optimized fresh process 1 |      10,637.2 ms |          4,437.7 ms |                 2.8 ms | pass          |
| Optimized fresh process 2 |      10,238.1 ms |          4,529.4 ms |                 5.8 ms | pass          |
| Optimized fresh process 3 |       9,066.5 ms |          4,062.4 ms |                 7.1 ms | pass          |

Every numerical golden and the independent small-horizon reference pass in
all six runs. The profiled remote and 1.14.16 processes exit 1 solely for the
original 10-second gate; optimized runs exit 0. The optimized profiled first
shared-config cycle is 78.2% shorter than profiled 1.14.16. These are synthetic
host measurements, not a statistical gameplay or browser-frame claim. Fresh
config mode still exceeds ten seconds in two runs; there is no existing gate
for that aggregate, and this report does not call it sub-ten-second. A single
candidate's first execution and a complete 25-candidate uncached cycle both
execute real projection work, unlike the millisecond repeated cache-hit result.

## Numerical and work regressions

`test/legendary-projection-equivalence.mjs` is now in `npm test`. Its 224
reference digests were captured explicitly from the immutable 1.14.16 planner,
whose SHA256 is
`ddc4b118244389ba6482a2d8dd9f5e05bc0c708f1628ab9919d6f34dee1e87b0`.
The tagged key-aware IEEE754 encoding preserves exact numeric bits, including
signed zero. Normal execution needs the checked-in fixture and no Git history;
only the guarded `--capture` mode reads the pinned commit.

Fourteen fixtures cover deterministic seeds, mixed train/Port supply, builds,
upgrades with/without a builder owner, rerouting, initial fleet ages, fractional
readiness/arrival/expiry, 512 producer units, and 4,096-tick projections. Every
fleet sample and Port/Factory net-value digest agrees exactly in cold and
cached calls. An instrumented cohort boundary observes five static field reads
at both 64 and 4,096 ticks. On the immutable old source, numerical goldens still
pass but the work regression fails as intended: 125 reads grow to 8,189.

`npm run test:projection-budget` exposes the unchanged broad benchmark; it
remains separate from the official suite to keep its wall-clock evidence
explicit. The previous 1.14.16 Library bundles retain their identity and bytes.

## Validation and integration

The full official `npm test` finishes with exit 0: 13 pretest commands and 108
sequential suite commands (121 steps), including nine native headless scenarios.
The standalone 224-record regression and bounded-work check pass within that
suite. `npm run quality:global` finishes with exit 0, including typecheck,
generated-build parity, dead-code, dependency and duplication checks. Dependency
analysis finds zero violations across 402 modules and 1,117 dependencies. The
existing ESLint ratchet still accepts 45 historical issues; no new lint issue is
accepted. Three initial issues in the new test were fixed, not added to the
ratchet. Changed logical files pass Prettier and `git diff --check`; repository-
wide historical format debt is not claimed resolved.

Two independent reviewers approve the runtime change and the full test/provenance
scope. They report no functional blocker; timing remains a synthetic host
measurement and does not certify browser smoothness. All final logs are retained
with the handoff.

The first suite attempt in the isolated worktree stopped before tests because
its pinned engine submodule had not been initialized. It was initialized at the
recorded gitlink and the full suite restarted; that setup log is retained as
provenance, not counted as a functional regression or a passing suite.

The conservative gates in `integration-review-1.14.16-20261017.md` still apply,
with the exact new candidate/version replacing 1.14.16 after approval. No
previous approval can authorize silently substituting new runtime. Verify
remote and version collisions again before any publication; preserve concurrent
work and compare actual offline 1.14.15 patches when available. Nothing from
those missing patches, offline silo tests or Rust cache work is declared merged.

Trello follow-up: transfer this independently reviewed optimization only with
its exact final commit, suite logs, benchmark first-cycle measurements and
Library identity. After authorized publication, verify the fetched commit,
generated-byte hashes, version, full suite, quality gates and synthetic scenarios.
Further browser-frame latency work needs its own representative measurements;
passing the broad 10-second planning budget does not certify frame smoothness.
