# Verification: runtime-performance-20261014

Verdict: **partial acceptance; overall not complete; pending human scope decision**. Original request and five criteria were reread from the task PRD. The original persistence mandate covered four evidence files. This final pass persists trusted terminal receipts in the three owned Markdown files. The human never answered the existing bot-gate repair-scope question; historical baseline confirmation was lead steering.

## Acceptance evidence

| #   | Criterion                                 | Status                           | One proof                                                                                                                                                                                                                                            |
| --- | ----------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Same-input baseline/candidate measurement | Verified, synthetic source-level | `docs/runtime-performance-20261014.json`: two current raw runs, four exact outputs each and balanced AB/BA samples; challenger confirms estate reductions 38.0865%, 43.1374%, 38.7371%, 35.7008%.                                                    |
| 2   | Semantics and foreign-work preservation   | Partially verified               | `docs/runtime-performance-validation-20261014.md`: exact legacy parity/reentrancy and frozen foreign hashes; paired overlay comparison CONFIRMED: both predicates false, bot_dead at tick 2379, zero construction events; underlying cause unproven. |
| 3   | Targeted regression coverage              | Verified, scoped                 | Final sniper reports both allocation tests exit 0; names and prior outputs are in the integration receipt.                                                                                                                                           |
| 4   | Regenerate/verify userscript artifacts    | Verified locally                 | Integration receipt records build/parity/bootstrap exit 0 and artifact hashes; lead confirms hash-matching full-bundle parity. Combined foreign WIP, no publication.                                                                                 |
| 5   | Independent challenge/Verify/sniper       | Partial acceptance               | Challenger CONFIRMED limited claim and sniper PASS scoped zero introduced errors, IDs below; broad gates remain failed.                                                                                                                              |

## Regression and side-effect review

Existing validation outputs were opened. `npm test` exit 1 at pretest (`undefined` versus `Factory`) also reproduces with original-package isolated inputs; this is not clean-HEAD or root-cause proof. The direct body separately exits 1 at headless border-pressure line 600. Subsequent baseline/candidate arms each emit a complete exit-2 bot_dead result at tick 2379 with zero construction events and false predicates. Exact starts match; the baseline preserves foreign WIP and reverts only the two overlays. Challenger `01a13862-fef0-7dc0-a2f1-7b063d4e2fc3` CONFIRMED this bounded comparison. It does not identify the underlying cause. Global lint exits 2 with 156 errors elsewhere. No broad gate is green by implication.

Final lead-provided sniper records fresh dependency exit 0 (zero violations, 265 modules/929 dependencies), raw scoped ESLint exit 0, targeted tests exit 0, typecheck exit 0 and validated hashes. Typecheck covers shell TypeScript, not engine JavaScript. Prior separately run full-bundle parity/bootstrap/dead-code/jscpd are lead-reported fresh hash-matching green; earlier short-circuit text remains historical.

Structure timing remains bounded reported evidence: 50.1 ms failed the unchanged 50 ms threshold; one reported 4.8 ms rerun passed. Raw rerun log unavailable to this verifier; independent proof of 4.8 ms/noise causation: **not verified**.

Performance conclusions: estate synthetic median execution time is lower; buffers are per connected component. Heatmap input reuse is per invocation with independently allocated point records; timing direction inconsistent. FPS, live rendering, end-to-end matches, total allocated bytes and heap retention: **not verified**.

## Current independent gate record

- Challenger `01a1384e-6f5b-7a33-ac9b-3bde86159179`: CONFIRMED limited claim.
- Sniper `01a1384e-6dd7-7ff1-aaa4-3b4197b262aa`: PASS scoped, zero introduced errors.
- Paired-case challenger `01a13862-fef0-7dc0-a2f1-7b063d4e2fc3`: CONFIRMED exact paired case, both predicates false, bot_dead at tick 2379, zero construction events; underlying cause and full green are not established.
- Final diagnostic sniper `01a1386c-3467-7b91-9ef9-084f3bcf0085`: **PASS bounded, zero owned errors**. Syntax exit 0; raw scoped lint exit 0 with zero errors/warnings; five-file formatting exit 0; JSON parse, semantic receipt and exact one-comment byte comparison exit 0.

These verdicts are trusted lead-provided evidence, not rerun by this writer. None establishes global functional resolution. Source bindings:

```text
benchmark 6fa5620c36c0b7052bba1658eecae55cc7325be13bedf20bea5c84417fc0eaf8
estate    1b4c20582ee11218159402b5b574164db3a6827cbe681e5d1d9ca1912a45ca81
heatmap   13e767bbeb2b591f129fe9a9b24e7629b939dbcef534cb7cbf860befa598a852
```

## Persistence check

Named techniques: RegressionAnalysis, MemoryAnalysis, Profiling and FailureModeAnalysis. Their findings and claim corrections are in `elicit-runtime-performance-20261014.json`. The earlier quality correction preserved the original executed diagnostic and added one catch lint exception to the reviewed temporary script. This final pass corrects attribution and persists the trusted final receipts only; original raw results remain unchanged. No games, tests, lint, research, builds, Git operations or reviewer gates were rerun, and no source/config/package/benchmark/tracking/PRD files were changed. Documentation formatting and factual readback are the only current verification; update_plan is unavailable.

Detailed proof paths: `docs/runtime-performance-review-20261014.md`, `docs/runtime-performance-20261014.json`, `docs/runtime-performance-validation-20261014.md`, `docs/runtime-performance-border-baseline-20261014.md`.

Pre-existing source sizes are 354 estate lines and 1016 heatmap lines, reduced from 356/1017; hook policy permits reporting without an out-of-scope split. The paired receipt guards 919 entries pre/post, with shared transitive dependencies partially bound; no race-free evidence is claimed.

Diagnostic sniper `01a13863-0048-7360-bae7-51ad6f55811e` historically failed one catch lint rule and formatting; final sniper above supersedes that failure. The original executed script is 169 lines, SHA256 f83bd1f7ba8ef86caf1ae65189a1e2e70f806c264a6b475496813bb5c38f74bf; the reviewed comment-only script is 170 lines, SHA256 316e6c352551721ade039660c1f7b4c31c61d8d87df88f49e9976b3a7b4256f2. Removing exactly one lint comment gives exact byte equality. The reviewed script has not run games; the original raw results remain unchanged.

Writers are frozen after final formatting/factual readback. Overall not complete; pending human scope decision. Existing bot-gate edits remain held; existing test/lint gates remain failed. No overall green, underlying-cause, commit or publication declaration.

Next step: HUMAN: decide the existing bot-gate repair scope; the lead retains partial acceptance until then.
