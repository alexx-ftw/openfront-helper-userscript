# Runtime performance measurement — 2026-10-14

Estate is approximately **36–43% faster by median execution time in these local synthetic fixtures**. Heatmap timings are inconsistent: its supported improvement is the deterministic reduction in transform-input allocations, with no consistent speedup claim.

## Receipt and protocol

[Complete two-run receipt](runtime-performance-20261014.json) contains complete raw samples from the two relocated runs, source hashes, counters, environment and recomputed summaries. Both sequential processes exited 0 with frozen sources/artifacts. The complete original receipt is preserved under `historicalReceipt` with its original command, benchmark hash and timestamps; those samples were not relabeled.

Current command: `node test/benchmark-runtime-performance.mjs`.
Historical original command: `node scripts/benchmark-runtime-performance.mjs`. The file was moved with native `apply_patch`; only the helper import changed to `./helpers/classic-script.mjs`. Repository-root resolution, inputs, assertions and balanced AB/BA order are byte-for-byte preserved.
Baseline commit: `7703aa95f3c58a0903cf7ef6aa9c471f4b5defbf`.
Run starts (UTC): 2026-10-14T02:42:36.457Z and 2026-10-14T02:42:48.849Z.
Runtime: v26.11.1, V8 14.6.202.34-node.37, Linux.
CPU: 11th Gen Intel(R) Core(TM) i7-11700K @ 3.60GHz.
One-minute host load at starts: 16.38 and 16.08.

Each fixture uses actual baseline Git sources and frozen working-tree sources in separate classic-script VM sandboxes. The same fixtures and independent expected outputs are used for both variants. All four exact-output assertions passed in both runs. Separate tracked invocations count allocations; timing invocations have no instrumentation wrappers. Each variant receives 10 warmup calls, followed by 12 pairs (six AB and six BA), with 10 calls per timed sample.

## Timings

Milliseconds per call. Each raw sample is a batch mean over 10 calls. Median averages the two middle sorted samples. P95 uses nearest rank; with 12 samples it equals the maximum. These are tails of batch averages, not individual-call latency percentiles. Negative change means lower candidate time.

| Run | Fixture       | Baseline median | Candidate median | Baseline P95/max | Candidate P95/max | Median change |
| --- | ------------- | --------------: | ---------------: | ---------------: | ----------------: | ------------: |
| 1   | estate-64     |          1.8901 |           1.1702 |           2.1067 |            1.2460 |       -38.09% |
| 1   | estate-128    |          8.4785 |           4.8211 |           9.1296 |            5.0845 |       -43.14% |
| 1   | heatmap-1000  |          0.4514 |           0.4208 |           0.4941 |            0.4551 |        -6.77% |
| 1   | heatmap-10000 |          4.5534 |           4.5803 |           4.6167 |            4.7565 |         0.59% |
| 2   | estate-64     |          1.8942 |           1.1604 |           2.0371 |            1.2018 |       -38.74% |
| 2   | estate-128    |          7.4643 |           4.7995 |           8.2639 |            4.8647 |       -35.70% |
| 2   | heatmap-1000  |          0.4051 |           0.4244 |           0.4667 |            0.4527 |         4.75% |
| 2   | heatmap-10000 |          4.5455 |           4.5152 |           4.8098 |            5.3188 |        -0.67% |

## Deterministic allocation metrics

Counts below were identical in both relocated processes and both historical original processes.

| Fixture       | Counted allocation        | Baseline | Candidate | Preserved work                            |
| ------------- | ------------------------- | -------: | --------: | ----------------------------------------- |
| estate-64     | neighbor arrays           |     4096 |         0 | 4096 cardinal probes; one scratch buffer  |
| estate-128    | neighbor arrays           |    16384 |         0 | 16384 cardinal probes; one scratch buffer |
| heatmap-1000  | distinct transform inputs |      941 |         1 | 941 projections in both variants          |
| heatmap-10000 | distinct transform inputs |     9411 |         1 | 9411 projections in both variants         |

Heatmap fixtures contain 1,000/10,000 source records; every seventeenth has a null tile, leaving 941/9,411 transform calls. Accepted point records remain independently allocated; viewport and nonfinite-coordinate filtering are included. Estate fixtures are uniform owned grids of 64×64 and 128×128; output includes exact tile totals and centroids.

## Frozen hashes

Source hashes matched across runs. Complete baseline and candidate hashes are in the receipt.

```text
benchmark: 6fa5620c36c0b7052bba1658eecae55cc7325be13bedf20bea5c84417fc0eaf8
estate candidate: 1b4c20582ee11218159402b5b574164db3a6827cbe681e5d1d9ca1912a45ca81
heatmap candidate: 13e767bbeb2b591f129fe9a9b24e7629b939dbcef534cb7cbf860befa598a852
```

Relocated benchmark syntax, scoped ESLint with zero warnings, Prettier, shell TypeScript check and `npm run quality:dependencies` passed (exit 0). Dependency RED reproduced exactly one `no-test-imports-in-production` violation; GREEN reports zero violations across 265 modules and 929 dependencies. The script remains 200 physical lines; comparison to the original confirms only the import-line change.

## Evidence boundaries and gates

- This is local synthetic source-level evidence. Browser FPS, rendering, live matches and end-to-end performance were not measured.
- No concurrent test/stress process was observed before measurement; ordinary desktop processes remained active and load was high. This is isolated-process evidence, not an idle-host guarantee. Scheduling, JIT and GC noise affect timings and tails. Heatmap 10,000 is slower in run 1 and faster in run 2; heatmap 1,000 also changes direction.
- Allocation counters measure observed neighbor arrays and input identities, not all allocations or allocated bytes.
- Each process verifies candidate source hashes and HEAD after measuring. These checks detect persistent edits, not transient edit-and-restore.
- No full-suite rerun, build, engine/package/artifact mutation, Git mutation or nested delegation occurred. The isolated unchanged structure-performance regression passed; the prior timing failure and broader failures remain recorded in the validation report.
- Named eLicit: RegressionAnalysis. Original-versus-relocated script comparison finds exactly one import change; 200 lines, root resolution, exact-output assertions, identical counters, balanced order, frozen hashes and receipt median/P95 recomputation were checked. No unresolved relocation finding; acceptance remains lead-owned.
- Independent lead challenger/sniper gates and build integration remain lead-owned. Status: ready for review, not final acceptance.

## Sources

Reused the completed lead Analyze trio and 2026-10-14 research: [W3C High Resolution Time](https://www.w3.org/TR/hr-time-3/), [TC39 indexed collections](https://tc39.es/ecma262/multipage/indexed-collections.html), and [WebKit JetStream 3](https://webkit.org/blog/17899/introducing-the-jetstream-3-benchmark-suite/). [Official Node perf_hooks documentation](https://nodejs.org/api/perf_hooks.html#performancenow) was freshly opened during implementation; timing uses `performance.now()` in milliseconds. Fresh lead official [Node URL](https://nodejs.org/api/url.html#new-urlinput-base) and [Node fs](https://nodejs.org/api/fs.html#fspromisescpsrc-dest-options) web records were reused for this relocation mandate. Research-expert `01a13848-c7a3-7603-8de8-002542db2595` is parent-owned. Fuse-browser was unavailable; Context7 was not connected; no new API was introduced.

Benchmark and documentation writers are explicitly frozen after saving and verifying these artifacts.
