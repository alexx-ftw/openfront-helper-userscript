# Oversized module split — 2026-10-15

Status: complete and verified. The two engine files flagged by the SOLID hook were split into classic-script modules under the 200-line limit as a pure byte-identical move; no behavior, gameplay, or load-order change. Owner-authorized via response annotation ("Do") on the SOLID report item.

## Result

| Old file (deleted) | New modules (engine/ingame/) | Lines each |
| --- | --- | --- |
| estate-panel.js (354) | estate/constants.js, estate/styles.js, estate/panel.js, estate/compute.js, estate/lifecycle.js | 25, 103, 122, 44, 60 |
| heatmaps.js (1016) | heatmaps/state.js, heatmaps/dom.js, heatmaps/trade-sources.js, heatmaps/projection.js, heatmaps/webgl.js, heatmaps/canvas.js, heatmaps/draw.js, heatmaps/export-partner.js, heatmaps/lifecycle.js | 31, 156, 176, 93, 174, 105, 136, 80, 65 |

All 14 modules < 200 lines. Both blocks occupy the exact INGAME_FILES slots of their monoliths (estate between boat-panel.js and auto-leave.js; heatmaps between boat-macro.js and spawn-index.js). House pattern preserved: shared lexical scope, no IIFE, no imports/exports.

## Fidelity proof

- Ordered concatenation of each module group diffs empty against the pre-split originals; sha256 1b4c2058... (estate) and 13e767bb... (heatmaps) equal the frozen candidate hashes in the 2026-10-14 performance receipts, so the uncommitted performance patches moved verbatim.
- Challenger verdict CONFIRMED (5/5 independent checks, including independent benchmark baseline-hash cross-check against git show HEAD); sniper verdict PASS (7/7).

## Wiring and consumers updated

- build.mjs INGAME_FILES: single entries replaced by the ordered module blocks; AUTO_BOT_FILES unaffected.
- test/estate-neighbor-allocation.mjs, test/heatmap-projection-allocation.mjs, test/performance-regressions.mjs: loaders now join the module groups in order (RED demonstrated during the split, GREEN after).
- test/benchmark-runtime-performance.mjs: source groups map candidate module lists to pre-split baseline paths (git show), preserving A/B semantics across the split; receipt schema unchanged.
- test/fixtures/game-constants.json: regenerated; exactly 4 record swaps (ESTATE_* id/file to estate/constants.js), proven against a pre-write backup.
- eslint.config.mjs: one narrow override for engine/ingame/estate/** (prefer-const, sonarjs/no-implicit-global) with the shared-scope rationale; per-file lint cannot see cross-file let bindings. heatmaps needed no override.
- Artifacts rebuilt (openfront-helper.user.js 2,393,826 B) and verified by check:build-parity.

## Validation (all exit 0)

npm run build; node test/smoke.mjs; node test/ingame-section-bootstrap.mjs; npm run check:build-parity; node test/estate-neighbor-allocation.mjs; node test/heatmap-projection-allocation.mjs; node test/performance-regressions.mjs; npm run check:constants (2024 contracts); node test/benchmark-runtime-performance.mjs (exactOutput true on all four fixtures, counters preserved); scoped eslint --max-warnings=0 over all changed files.

## Boundaries

- No browser FPS or live-match verification (synthetic source-level evidence only, as before).
- Foreign-WIP broad gates untouched and still out of scope: npm test pretest failure (construction-simulator-live-config.mts:371) and the global lint ratchet (pre-existing errors in unrelated files).
- Pre-split originals backed up at /tmp/ofh-split-backup/ (ephemeral); the content itself now lives verbatim in the 14 tracked modules.

## Addendum — tooling files (2026-10-15, owner: "handle")

The SOLID hook then flagged three tooling files; the owner authorized handling all three:

| File | Before | After |
| --- | --- | --- |
| test/benchmark-runtime-performance.mjs | 226 (grew during integration) | 198, layout-only compaction, semantics/schema unchanged |
| build.mjs | 462 | 103-line entry + scripts/build/{sources,assemble,assets,minify}.mjs (146/164/98/29); BUILD_INPUTS gained "scripts/build" in both parity checkers |
| test/performance-regressions.mjs | 824 | 43-line runner + 9 modules in test/helpers/perf-regressions/ (14-186), identical check order/messages/thresholds |

All files <=200 lines. Verification: smoke, performance-regressions, both allocation tests, check:constants (2024), test/build-parity, full check-build-parity, and the benchmark all exit 0; scoped eslint and prettier exit 0 on every touched file; challenger CONFIRMED 7/7 (line counts, single minifySyntax:false, array definitions only in scripts/build/sources.mjs, import resolution, scoped git status) plus the build lot's sniper PASS 6/6. Docs (AGENTS.md, CLAUDE.md) updated to point the load-order arrays at scripts/build/sources.mjs.
