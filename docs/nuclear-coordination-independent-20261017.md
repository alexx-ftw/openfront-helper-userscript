# Independent nuclear coordination cycle, 2026-10-17

## Provenance and isolation

- Helper baseline / origin/main: `62de315a496142b916cba1e37bca7134228ab3e7`, version 1.14.13; clean tree before edits.
- Work branch: `fix/nuclear-coordination-independent`; local version 1.14.14.
- Helper engine pin: `f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb`.
- RL observed baseline / origin/master: `edd36971ebe58348822f659e062268b60c1c04a1`; no RL source edits. Further RL work belongs to the other Cloud task.
- Both remotes fetched and verified before edits. No local `.agents/skills` directory was present. Read both AGENTS files and Helper PORT-CONTRACT / README.
- No real matches, Pepinillo, Telegram, paid service, publication, or access expansion.
- Prior container tooling and offline 1.14.15 / silo / Rust-cache patches were unavailable and are not integrated here.

## Independent reproducible defect

Optional SAM-clear overshoot ignored the confirmation-slot reserve already enforced by candidate admission and the planner loop. With four available slots, a two-slot reserve, a one-shot SAM candidate and sufficient gold, it selected two optional extra shots, leaving only one confirmation slot.

The real planner regression retains an economic objective from the preceding wave. Before: `sam-clear, overshoot, overshoot, confirmation`. After: `sam-clear, overshoot, confirmation, confirmation`. Both plans use four slots and cost 400 under synthetic 100-per-bomb pricing. Five additional cases cover exact capacity, surplus capacity, gold limitation, and SAM mode with zero reserve. The original source fails both the arithmetic and real-plan regressions; the corrected source passes. This proves preserved capacity and the fixture's confirmations, not better match outcomes.

The fix subtracts `confirmationShotReserve` from optional overshoot headroom. Existing cost and maximum-overshoot limits remain in place.

## Subsequent baseline repairs

The baseline economy-policy suite failed on exact blast boundaries. Structure scoring used an inclusive radius, but pinned native NukeExecution deletes units only at distance squared strictly below outer squared. Aligned structure expected value, friendly replacement loss, SAM-clear value and Hydrogen finisher value with native deletion. Friendly terrain checks retain their conservative inclusive fallout radius.

**Possible overlap:** this strict-radius repair may be equivalent to the pending offline 1.14.15 candidate. It was independently reconstructed from the checked-out remote and native engine; do not count it as a second new finding or claim the offline patch was integrated. Compare patches before transfer.

Restored the native Team-only exception for third-player nuclear destinations on Hard and above. FFA third parties remain ineligible; the existing friendly/AFK protection remains. Corrected three contradictory historical boundary assertions and refreshed the joined-test integrity hash; added an inside-radius positive-value case. The complete economy-policy test passes.

## Review and validation

Two independent agent reviews found no patch correctness blockers. The final reviewer checked the complete source/test diff against the pinned native engine. Patch approval is separate from the global release gate.

The six new confirmation-reserve regressions pass (five budget cases and one real-plan integration). Full nuclear economy and SAM salvo/campaign suites pass. All silo, nuke-map, performance, frame-stall and allocation checks in the package test chain pass. The expanded run attempted all 104 commands after the headless test: initially 99 passed and five failed; the stale inclusive-radius salvo expectation was then corrected and its complete suite passed. The four remaining failures also reproduce on untouched remote source:

- `intent-rate-limit`: source-layout regex expects an entry in the old monolithic build file.
- `legendary-alliance-expiry-policy`: expected expiry 1000, observed 900.
- `early-game`: source-layout regex expects an entry in the old monolithic build file.
- `hot-reload`: old build-bridge extraction fails.

No expanded-run command timed out (180-second per-command cap). Full `npm test` fails earlier at the headless FFA border-pressure assertion. The unchanged remote's exact scenario independently completes at tick 2379, bot dead, with zero construction events and zero nuclear launches, so its event-based border assertion cannot pass. This is a baseline reproduction, not a patched gameplay comparison.

The 16 dependency-cruiser unresolved imports reproduce exactly on the baseline with its own pinned engine worktree. The existing joined-test wrappers run their fragments at the test-directory level, while the static dependency checker resolves their raw fragment-relative imports. No checker was weakened. Final serial lint, type checking, build parity, dead-code and duplicate checks pass. Global quality stops at the 16 dependency errors. Format checking reports the same 72 fragment parsing errors on both baseline and patched trees. Final command logs are in the evidence bundle. A green release gate must not be claimed.

## Trello follow-up

1. Review and transfer the independent confirmation-slot correction and six regressions; compare the strict-radius repair with offline 1.14.15 before combining them.
2. Diagnose the landlocked FFA border-pressure headless assertion on the unchanged remote and patched tree; retain the fixed seed and engine pin.
3. Repair the 16 pre-existing dependency-cruiser unresolved imports for byte-joined test fragments without weakening import checks.
4. Re-run the full suite and global quality checks serially. Verify publication authority and current remote before publishing any release.
5. Keep Rust full-game parity and cache work in the separate Cloud task. No synthetic result here establishes improved win rate.
