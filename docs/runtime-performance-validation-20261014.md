# Runtime performance integration validation — 2026-10-14

Status: ready for lead review with failed broad gates; not final acceptance. ALL writes are frozen after this receipt and own PRD.

Registered the estate/heatmap allocation tests exactly once immediately after performance-regressions in scripts.test. The remainder of package.json is byte-for-byte preserved; version stays 1.14.13, with no dependency/lock/source/test/benchmark or Git changes.
Executed npm run build on the actual integrated tree. Generated artifacts necessarily combine foreign WIP. Package/build writes froze immediately afterward.

| Command/check                                                                       | Terminal result                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Registration RED/GREEN                                                              | Expected missing-command failure, then exact adjacency/uniqueness passed |
| npm run build                                                                       | Exit 0; full userscript 2337 KB                                          |
| npm run check                                                                       | Exit 0; shell TS only, engine JS excluded                                |
| npm run check:build-parity; node test/build-parity.mjs                              | Both exit 0                                                              |
| node test/smoke.mjs; node test/ingame-section-bootstrap.mjs                         | Both exit 0                                                              |
| node test/estate-neighbor-allocation.mjs                                            | Exit 0; 4096 tiles, zero per-tile arrays; exact legacy parity            |
| node test/heatmap-projection-allocation.mjs                                         | Exit 0; 1000 calls, one input; exact outputs/reentrancy                  |
| performance-regressions; frame-stall-regressions; structure-performance-regressions | All exit 0                                                               |
| Scoped ESLint: two patched sources and two allocation tests                         | Exit 0, no diagnostics                                                   |
| npm test                                                                            | Exit 1 in pretest; main test script never started                        |
| Original-package isolated construction fixture                                      | Exit 1, identical assertion reproduced                                   |
| npm run test --ignore-scripts                                                       | Exit 1 in headless-simulation.mjs                                        |
| npm run quality:global                                                              | Exit 2 at lint: 156 errors, zero warnings                                |

Actual npm test failed at test/construction-simulator-live-config.mts:371:

```text
live Config ranks an open-rail Factory first at low global train counts
actual: undefined
expected: 'Factory'
```

The isolated baseline uses pre-registration package bytes, copied fixture/helpers, and frozen engine/native dependency symlinks. It reproduces the same line/assertion. This establishes a preexisting foreign-WIP failure relative to this integration, not a clean-HEAD comparison or root cause.

The earlier observed headless process was the separate direct body attempt, npm run test --ignore-scripts (session 46920), after the measured pretest blocker. Engine compatibility and Legendary goal validation passed; it then failed:

```text
AssertionError [ERR_ASSERTION]: the landlocked FFA fixture must report its neighboring nations as border pressure
at test/headless-simulation.mjs:600:8
actual: false
expected: true
```

This second failure was not baseline-compared and is not claimed confirmed preexisting. The allocation commands were not reached by that chain; both passed directly.

Global lint ratchet increases are in inherited unrelated files: legendaryPlanner.js, nukeBehavior.js, run-gated-validation.mjs, legendary-port-economy-selection.mjs, silo-demand-upgrade-preference.mjs. No error is reported in the performance patch sources/tests. Frozen foreign-file hashes matched after checks. No clean-HEAD global comparison or foreign fixes occurred.
The formatter wrote its standard ignored eslint-ratchet-temp.json receipt; no rebaseline/manual edit occurred. Later quality stages were short-circuited; dead-code/dependency/duplicate stages remain unverified. Independent typecheck/parity passed.

Named eLicit: RegressionAnalysis (byte preservation, adjacency, integrated build checks) and FailureModeAnalysis (negative exits, omitted stages and combined WIP explicitly retained). No own registration defect found. All named frozen file hashes and Git index hash matched. All commands are terminal; no interruption counted as a pass, no broad rerun, no final benchmark or browser verification.

Logs: /tmp/ofh-runtime-performance-20261014-integration/{build,focused,npm-test,baseline-construction,quality-global,frozen-hashes}.log.
The quality log has truncated middle tool output but retains terminal/ratchet details; eslint-ratchet-temp.json has full per-file/rule counts. The direct body's exact terminal output is persisted above and in tool session 46920.
Sessions: focused 98810 exit 0; npm test 93276 exit 1; quality 79351 exit 2; body 46920 exit 1; scoped lint 44120 exit 0.

Frozen SHA256:

```text
package.json fafa61f7441649b96027bb0ee110d1d12c9a224c322cfd6734766aa4f3b63c94
user.js 00b094c1408913bc4faa13f4c4cb4c29b8097e205294029fca7b1ec6bbdfdb91
autobot.js 7f20b61c9547a25aab1102dc9e362330b0cec7feb8d3176a056cd55e4815e72c
build-id.js 254f4484b62d9f188f472e19d91cffea73b96898d73aef321f1bce2a0438aca4
```

Sources: supplied current Analyze and Node perf_hooks evidence reused, frozen executor PRDs and local files read. SOLID/TDD/verification/elicitation/ts-testing/ponytail loaded. No new APIs/research; fuse-browser/Context7 unavailable. update_plan unavailable; local PRD plan used. Blocked Python snapshot write was not retried; recording used apply_patch.

## Benchmark relocation validation

The introduced dependency finding was reproduced locally: `npm run quality:dependencies` exited 1 with exactly one `no-test-imports-in-production` edge from `scripts/benchmark-runtime-performance.mjs` to `test/helpers/classic-script.mjs`. Native `apply_patch` moved the actual file to `test/benchmark-runtime-performance.mjs` and changed only that import to `./helpers/classic-script.mjs`. The original untracked scripts path is absent; no wrapper/helper/config duplicate remains. The benchmark is still 200 lines, with byte-identical body after normalizing this one import. Same-depth `../` root resolution is preserved.

| Relocation command/check                                               | Terminal result                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| npm run quality:dependencies (RED)                                     | Exit 1; exactly the introduced edge                                                                          |
| npm run quality:dependencies (GREEN)                                   | Exit 0; zero violations, 265 modules / 929 dependencies                                                      |
| node --check test/benchmark-runtime-performance.mjs                    | Exit 0                                                                                                       |
| npx eslint test/benchmark-runtime-performance.mjs --max-warnings=0     | Exit 0; no diagnostics                                                                                       |
| npx prettier --check test/benchmark-runtime-performance.mjs            | Exit 0                                                                                                       |
| npm run check                                                          | Exit 0; shell TypeScript only                                                                                |
| node test/benchmark-runtime-performance.mjs (two sequential processes) | Both exit 0; all four exact-output assertions, balanced 6 AB / 6 BA pairs per fixture                        |
| node test/structure-performance-regressions.mjs (one isolated rerun)   | Exit 0; Factory cache 0.1 ms, fingerprints 5.1 ms, SAM coverage 0.3 ms, launches 0.8 ms, ally support 4.8 ms |

The prior sniper timing-only failure was `64 ally-support candidate scores took 50.1ms` (sniper receipt line 24, test line 1880), against the unchanged 50 ms threshold. The single isolated rerun is justified by that near-threshold observation and concurrent-load concern; it supplies bounded fresh evidence only, not a confirmed noise root cause or erased failure. No test, threshold, structure source or bot policy changed. No concurrent test/stress process was observed before the rerun/benchmarks. Ordinary desktop load persisted: benchmark loads 16.38 and 16.08. This host was not fully idle.

Both complete new raw receipts, recomputed median/P95/max and allocation counters are in `runtime-performance-20261014.json`; the complete original receipt remains under `historicalReceipt` with its original command/hash/timestamps. Current benchmark SHA256 is `6fa5620c36c0b7052bba1658eecae55cc7325be13bedf20bea5c84417fc0eaf8`. New process starts: 2026-10-14T02:42:36.457Z and 2026-10-14T02:42:48.849Z. Estate median changes: -38.0865%, -43.1374%, -38.7371%, -35.7008%; heatmap remains inconsistent. All allocation counters match both original processes.

Measured source hashes and the package/build hashes above matched before and after. Additional frozen checks:

```text
structureBehavior.js 5ab8398e30f8f15a9f36eaafb2b8ad2d508a4f89fd601caa1f93aec5cf2d958e
legendaryPlanner.js 564859ae26f619ce84c07cb09da69f5a1c7af1cff0b8015b1977c7dda32b92f1
structure-performance-regressions.mjs 14d1b476593cefd48714bcb09900b14999c933ceed11528c5c6f6d2af00850af
```

Named eLicit RegressionAnalysis found no relocation-specific gap: one-line normalized comparison, root resolution, independent outputs, counters, AB/BA inputs, immutable historical provenance and exact summary arithmetic checked. Existing pretest exit 1, headless exit 1 and global lint exit 2 remain failed; no broad rerun or foreign fix occurred. Build was not rerun because the relocated benchmark is not a build input.

Fresh parent research capture 2026-10-14T02:42:06Z (`01a13848-c7a3-7603-8de8-002542db2595`) is reused: official Node 26.11.1 URL/perf/fs through Exa and parent web fallback, read-only same-depth URL assertion. Context7 was not connected; no new API. A post-edit hook stated: "SNIPER VALIDATION REQUIRED: Code file 'benchmark-runtime-performance.mjs' was modified. You MUST now run the sniper agent (fuse-ai-pilot:sniper) to validate this modification before continuing. This is mandatory per CLAUDE.md rules." Its local source lookup found no matching source in the injected ai-pilot installation; no hook bypass, nested delegation or self-clearance occurred. Independent challenger/sniper remain parent-owned and required before acceptance.

Relocation evidence is terminal and this executor's writers are frozen.

Next step: parent owns independent challenger/sniper gates against the frozen relocation and assessment of the recorded broad failures.
