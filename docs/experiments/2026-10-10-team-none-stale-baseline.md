# 2026-10-10 — team-none basket is stale after the engine restructure

The fixed-basket anchor rows (docs/legendary-metric-ceilings.md, recorded
2026-08-22 against the pre-packages engine layout) now lose 0/5. An A/B on
the same engine, harness, and seeds isolates the bot diff from the drift:

| seed      | HEAD (1.12.196) | working tree (1.12.208) |
| --------- | --------------- | ----------------------- |
| basket-01 | L @ 7851        | L @ 7851 (identical)    |
| basket-02 | L @ 8671        | L @ 8671 (identical)    |
| basket-03 | L @ 10511       | L @ 10511 (identical)   |
| basket-04 | L @ 14671       | L @ 16191 (+1520 ticks) |
| basket-05 | L @ 9991        | L @ 9991 (identical)    |

Conclusions:

- The Silo/SAM/retarget work in 1.12.205–1.12.208 is game-neutral on this
  basket (4 rows byte-identical; the divergent row survives longer, matching
  the survival-priority goal).
- The 0/5 losses predate the current working tree: the baselines must be
  re-recorded against the packages/ engine checkout before team-none can
  gate changes again. Until then this set is a drift detector, not a
  scoreboard.

## Same-day isolation (second pass)

- Recorded history (ofh-matrix): on 2026-10-05, still one engine update
  earlier, the same seeds were 1/5 — only basket-05 WON @13201. The
  2026-08-22 full-green rows are two engine generations back.
- basket-05 alone, current engine, bot 1.12.190 (before the five behavior
  commits 1.12.191–1.12.196): LOST. The last recorded win is therefore dead
  by the 2026-10-09 engine pull, not by recent bot work.
- Diagnostic shape of that loss: the bot personally thrived (34909 tiles,
  1.3M troops, alive at end) while `finalAllies` was empty — every Red
  teammate was conquered. The current engine punishes solo-scaling; the
  missing piece is team support (defense/donation/rescue), which is where a
  re-baseline lever should aim first.

Harness note: `scripts/headless/run-match.mts` was ported to the packages/
layout this day (GameTypes from engine-api, executions from
packages/engine/src/execution, mapFiles via loadMapFiles + NodeGameMapLoader);
MapPlaylist still resolves from the legacy src/server module. Without that
port every basket row failed with ERR_MODULE_NOT_FOUND before tick 0.
