# Runtime performance recheck — 2026-10-15

Status: the 2026-10-14 estate/heatmap performance changes were re-verified green on the current dirty worktree. No source changes were made in this recheck; this receipt adds fresh evidence only.

Raw benchmark output: [runtime-performance-recheck-20261015.json](runtime-performance-recheck-20261015.json).

## Commands executed (all exit 0)

| Command | Result |
| --- | --- |
| `node test/estate-neighbor-allocation.mjs` | 4096 tiles, zero per-tile neighbor arrays; exact legacy parity |
| `node test/heatmap-projection-allocation.mjs` | 1000 calls, one transform input; exact outputs and reentrancy |
| `node test/performance-regressions.mjs` | passed |
| `node test/smoke.mjs` | passed |
| `npm run check:build-parity` | passed; committed artifact matches current sources |
| `node test/benchmark-runtime-performance.mjs` | all exact-output assertions passed; counts below |

## Fresh benchmark (single run, 2026-10-15)

Node v26.12.0, baseline commit 7703aa95 (same as the original receipt). Host was heavily loaded at run time (1-minute load 138.6), so per-sample timings are noisier than the original two-run receipt.

| Fixture | Baseline median ms/call | Candidate median ms/call | Median change | Deterministic counts |
| --- | ---: | ---: | ---: | --- |
| estate-64 | 5.9508 | 3.6937 | -37.93% | neighbor arrays 4096 -> 0; one scratch buffer |
| estate-128 | 46.4576 | 30.7761 | -33.75% | neighbor arrays 16384 -> 0; one scratch buffer |
| heatmap-1000 | 1.1360 | 1.3971 | +22.99% | transform inputs 941 -> 1 |
| heatmap-10000 | 10.4896 | 10.8387 | +3.33% | transform inputs 9411 -> 1 |

## Interpretation

- Estate medians remain 34-38% faster under high host load, consistent with the original two-run receipt (35.70-43.14%).
- Heatmap timing direction remains noise-dominated on this host, as documented in the original receipt; its supported improvement is the deterministic reduction of transform-input allocations (941/9411 -> 1 per invocation), with exact output parity.
- All exact-output assertions and allocation counters matched expectations in the fresh run.

## Boundaries and out-of-scope items (unchanged)

- Local synthetic source-level evidence only; no browser FPS, rendering, or live-match measurement.
- Broad foreign-WIP gates remain untouched per owner scope: `npm test` pretest failure in `test/construction-simulator-live-config.mts:371` (reproduced against the original package on 2026-10-14) and the global lint ratchet (156 errors in unrelated files).
- SOLID file-size guard: `engine/ingame/heatmaps.js` (1016 lines) and `engine/ingame/estate-panel.js` (354 lines) exceeded the 200-line limit before this work; splitting them is outside this performance task and is reported to the owner instead.
