# Menu context miss-cache and trade-policy split — 2026-10-16

Status: complete and validated. Menu-page game-context discovery is rate-limited when the game is absent, and the pre-existing `engine/ingame/selective-trade-policy.js` (420 lines) is split into classic-script modules under the 200-line limit. Owner-authorized via the unbounded performance objective and the "handle" annotation on the oversized-file report.

## Result

`getOpenFrontGameContext` (`engine/ingame/trade-policy/context.js`) keeps its existing 1000 ms positive cache and gains a **250 ms non-sliding negative cache**: when DOM discovery finds no usable game/transform pair, the miss timestamp arms and rescans are suppressed for 250 ms. Any active game-start signal bypasses the window and re-arms it: `body.in-game`, a `/live/` route (`/game/`, `/w<n>/game/`, optional `/v/<commit>` prefix), or a visible `game-starting-modal`. In-game the signals bypass entirely; on the menu, the prior behavior re-ran the full `querySelectorAll("*")` scan roughly every 50 ms per consumer.

Companion split (owner-reported pre-existing violation, then owner-authorized):

| Old file (deleted)              | New modules (engine/ingame/trade-policy/)     | Lines each        |
| ------------------------------- | --------------------------------------------- | ----------------- |
| selective-trade-policy.js (420) | context.js, players.js, partners.js, apply.js | 143, 48, 131, 123 |

All four modules are < 200 lines and occupy the former monolith\x27s `INGAME_FILES` slot (`scripts/build/sources.mjs`), loading before `game-start-notification.js`. The order differs from the original file layout (context declarations now come first) but is safe: declarations only, hoisted in the shared sloppy-mode IIFE.

## Fidelity proof

- Canonical reconstruction of the four modules (cache additions stripped) is byte-identical to `git show HEAD:engine/ingame/selective-trade-policy.js`: sha256 `c659cae6ce33655cdbc9eb2a277921aca63a6c2783ee93deab061fd447c52fd6` matches in both directions.
- `test/public-lobby-unrestricted.mjs` loads the four modules explicitly (same pattern as its auto-bot source list); the dangling reference to the deleted file found during sniper review was fixed and re-validated.

## Measurement

15 s headed V8 CPU profile on the openfront.io menu (`diag.game=false`), before vs after in separate sessions:

| Function                                  | Before   | After               |
| ----------------------------------------- | -------- | ------------------- |
| `findOpenFrontGameContextInDom` self time | ~5538 ms | ~761 ms (~86% less) |
| `querySelectorAll`                        | ~879 ms  | ~152 ms             |

Caveats: one profile per side, sampled CPU self time (not wall time), distinct browsing sessions; no in-match FPS measurement was obtained.

## Validation (all exit 0)

`node --test test/helpers/perf-regressions/context-cache.mjs` (initial scan, 250 ms non-sliding window incl. 2249/2250 ms boundary, discovery at expiry, all five bypass signals, negative controls, positive-cache 999/1000 ms A/B); `node test/performance-regressions.mjs`; `node test/smoke.mjs`; `npm run check:build-parity`; `node test/estate-neighbor-allocation.mjs`; `node test/heatmap-projection-allocation.mjs`; `node test/public-lobby-unrestricted.mjs`; scoped `eslint --max-warnings=0` and `prettier --check`; `npm run build` (artifact sha256 `15c144ff06c74bed59a12f87d769725453c467402e9e5b27573a13f046a4ac31`; the on-disk artifact was later rebuilt by the concurrent sibling lane and still passes build parity).

## Review verdicts

- Challenger (Schrodinger): CONFIRMED — 8/8 edge cases: timing 0, exact expiry, bypass + reset, `/v/` regex, hidden modal, byte identity, load order, line counts.
- Sniper (Banach): PASS — found the dangling `public-lobby-unrestricted.mjs` reference (fixed) and a minor eslint-override clone in `eslint.config.mjs` (accepted).
- Sniper (Popper): VALIDATED the test fix — intent preserved, scan not weakened.

## Boundaries and limitations

- No in-match FPS or wall-clock gain is claimed; evidence is sampled CPU profile plus deterministic fixture tests.
- The `unitsOwned` TypeError remains UNCERTAIN and is out of scope.
- Repository-wide `npm run lint` is red from concurrent auto-bot/legendary/hybrid lanes; the performance-regressions aggregator blocker from the sibling lane has since been resolved (the legendary-planner split landed and the aggregator passes).
- No commits, pushes, stashes, or edits to sibling-lane files.

## Addendum — idle-menu discovery backoff (2026-10-16, same session)

A fresh 15 s menu profile of the built artifact showed the remaining discovery cost was the fixed 250 ms rescan cadence on a signal-less menu (~1.6 s sampled per 15 s). `getOpenFrontGameContext` now backs off to 1000 ms — the existing positive-refresh interval — after 4 consecutive signal-less misses (~1 s of idle menu); any start signal or successful discovery resets the fast 250 ms window. In-game behavior is unchanged: active signals bypass and reset, so the backoff only ever bites where `null` was already the correct answer.

- Tests: `checkIdleMenuBackoff` added to `test/helpers/perf-regressions/context-cache.mjs` (RED demonstrated: a scan fired at 2000 ms before the change); sandbox setup extracted to new `context-cache-sandbox.mjs` so every touched file stays <200 lines (context.js 158, context-cache.mjs 162, sandbox 78).
- Gates (all exit 0): direct `checkContextMissCache` run, `node test/performance-regressions.mjs`, `node test/smoke.mjs`, estate/heatmap allocation tests, `node test/public-lobby-unrestricted.mjs`, scoped `eslint --max-warnings=0`, `prettier --check`, `npm run build` (artifact sha256 `0887d45a8d598b6672a537b1b3660b3c2a82ff0a5af9b33193a21115a2fc1bcc`), `npm run check:build-parity`.
- Review: sniper validator CONFIRMED (caller impact over 30+ consumers, expiry boundaries at streak >= 4, bypass/success streak resets, positive-cache interplay, classic-script constraints); docs verifier OK (repo conventions, constant derivation — 250 ms helper-tick base, cap = existing `_OPEN_FRONT_CONTEXT_REFRESH_MS`, step 4 = 1 s idle — no doc contradiction).
- Measurement: 15 s menu V8 CPU profile, same script, before vs after the backoff: discovery-path self time ~1615 ms -> ~650 ms sampled (~60% less; ~88% less than the 5538 ms pre-cache baseline). One run per side, sampled CPU, distinct sessions; pageErrors 0.
- Next-candidate observation (not actioned): the largest remaining sampled entry is `querySelector` ~1.5 s attributed outside the discovery path (modal checks by other consumers or the page itself); it needs caller attribution before any change.
