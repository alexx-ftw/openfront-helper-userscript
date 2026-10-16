# Final runtime performance evidence — 2026-10-14

Status: **partial acceptance; overall not complete; pending human scope decision** on repairing existing foreign bot gates or preserving them. The human never answered the repair-scope question; historical baseline steering was lead confirmation.

Read [raw measurement](runtime-performance-20261014.json), [measurement notes](runtime-performance-20261014.md), [validation](runtime-performance-validation-20261014.md) and [border attribution](runtime-performance-border-baseline-20261014.md) before persistence. Existing receipts remain unchanged.

## Current independent gates

Trusted lead-provided final records, not executions by this writer:

- Challenger `01a1384e-6f5b-7a33-ac9b-3bde86159179`: **CONFIRMED limited claim**. Current raw estate medians: 38.0865%, 43.1374%, 38.7371%, 35.7008% lower, local synthetic source-level only.
- Sniper `01a1384e-6dd7-7ff1-aaa4-3b4197b262aa`: **PASS scoped zero introduced errors**. Fresh dependencies: zero violations, 265 modules/929 dependencies; raw scoped ESLint, two targeted tests and shell typecheck exit 0; hashes validated. Old benchmark path absent; normalized difference is the import only.
- Prior full-bundle parity/bootstrap/dead-code/jscpd: fresh hash-matching green per lead. Earlier pending-stage text is historical; global quality remains failed.
- Final diagnostic sniper `01a1386c-3467-7b91-9ef9-084f3bcf0085`: **PASS bounded, zero owned errors**. Syntax exit 0; raw scoped lint exit 0 with zero errors/warnings; five-file formatting exit 0; JSON parse, semantic receipt and exact one-comment byte comparison exit 0. This supersedes the diagnostic lint/format failure below, without establishing full green.

Estate neighbor arrays fall 4,096/16,384 → zero; scratch buffer is **per connected component**. Heatmap transform inputs fall 941/9,411 → one **per invocation**; point records remain independently allocated. Exact outputs/reentrancy pass. No total-byte/heap-retention guarantee.

Two sequential runs retain balanced AB/BA, 10 warmups, 12 pairs and 10 calls/sample; P95/max describe batch means. Host load remained high. Historical samples retain original provenance. Heatmap timing is inconsistent; **no FPS or end-to-end claim**.

## Acceptance proofs

| Criterion                         | Status             | Proof                                                                                                                          |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Identical measurement inputs      | Verified, bounded  | Current JSON runs: two exits 0, four exact-output fixtures, balanced order; final challenger confirms percentages.             |
| Semantics/foreign edits preserved | Partial            | Validation: legacy parity/reentrancy, foreign hashes preserved; paired overlay comparison CONFIRMED, false/false at tick 2379. |
| Targeted coverage                 | Verified, scoped   | Final sniper: estate-neighbor-allocation and heatmap-projection-allocation exit 0.                                             |
| Regenerated/verified artifacts    | Verified locally   | Validation build/parity/bootstrap exit 0; artifacts combine foreign WIP, no publication.                                       |
| Independent gates/verification    | Partial acceptance | Final IDs above; broad failures remain below.                                                                                  |

Unresolved: npm test pretest exit 1, Factory expected/undefined actual; same isolated original-package failure, not clean-HEAD/root-cause proof. Direct headless border pressure line 600 exits 1. The isolated HEAD-overlay baseline and current-overlay candidate both stop bot_dead at tick 2379 with zero construction events and false predicates; exact starts match. This bounded comparison is CONFIRMED by challenger `01a13862-fef0-7dc0-a2f1-7b063d4e2fc3`; the underlying cause remains unproven. Global lint exits 2 with 156 errors elsewhere.

Structure ally support: 50.1 ms failed unchanged 50 ms threshold; one reported 4.8 ms rerun passed. Raw rerun log unavailable: **reported bounded evidence**, not independently proved timing/noise. Browser FPS/live behavior/end-to-end performance: **not verified**.

```text
benchmark 6fa5620c36c0b7052bba1658eecae55cc7325be13bedf20bea5c84417fc0eaf8
estate    1b4c20582ee11218159402b5b574164db3a6827cbe681e5d1d9ca1912a45ca81
heatmap   13e767bbeb2b591f129fe9a9b24e7629b939dbcef534cb7cbf860befa598a852
```

Final sniper validates bindings; artifact hashes remain in validation. Hash checks cannot exclude transient edit-and-restore. Protected main: rebuilt combined WIP, no commit/publish. The original persistence lane changed four receipts. The subsequent border diagnostic built and ran two isolated arms; the earlier quality correction added one temporary diagnostic lint comment. This final persistence pass changes only the three owned Markdown receipts. Original raw results remain unchanged; no games were rerun. Named techniques and individual proofs: `.codex/apex/docs/elicit-runtime-performance-20261014.json` and `verify-runtime-performance-20261014.md`. This lane's writers are frozen after readback.

Pre-existing oversized sources remain 354 lines for estate-panel.js and 1016 for heatmaps.js, reduced from 356 and 1017. The hook permits reporting this inherited condition; splitting those files is outside this performance scope.

The paired receipt guards 919 entries with identical pre/post observations; shared transitive dependency code is not exhaustively bound, and transient mutation is not excluded. Diagnostic sniper `01a13863-0048-7360-bae7-51ad6f55811e` historically failed one catch lint rule and formatting; final sniper above supersedes that failure. The original executed script is 169 lines, SHA256 `f83bd1f7ba8ef86caf1ae65189a1e2e70f806c264a6b475496813bb5c38f74bf`; the reviewed comment-only script is 170 lines, SHA256 `316e6c352551721ade039660c1f7b4c31c61d8d87df88f49e9976b3a7b4256f2`. Removing exactly one lint comment restores every original byte. The reviewed script has not run games. No overall green, underlying-cause, commit or publication claim.

Next step: HUMAN: decide the existing bot-gate repair scope; the lead retains partial acceptance until then.
