# Legendary Auto-Bot — measured metric ceilings under the unmodified engine

Status: 2026-08-22. This document records the measured per-metric ceilings of the
Legendary Auto-Bot under the **unmodified** vendored engine
(`openfront-engine/` is a clean pinned upstream submodule; upstream changes are
out of scope by explicit project constraint). It is the acceptance record for
the per-game goal requirements that are engine-bound, with the evidence chain
that closed each one.

## Verification baseline

- Harness: headless `run-match.mts` simulations, engine difficulty
  `Impossible`, helper difficulty `Legendary`, 60 tribes, 20 nations,
  externally asserted 30-row matrix (3 profiles × 10 rows) plus targeted
  diagnostic seeds. Zero intent rejections in every recorded row.
- Full `npm test` green after every landed change; per-tick cost audited
  against the ≥30 FPS browser budget (no unbounded per-tick path; three
  caching fixes landed).

## Requirement groups with measured engine-bound ceilings

### 1. "Capture at least 33 trade vessels" / "at least 1 own ship at level 3"

- Engine rules: a trade capture is credited to the warship that closes to
  ≤5 tiles (`WarshipExecution.huntDownTradeShip`); veterancy needs 750
  points (25 captures × 10 pts, or 10 transport kills × 25 pts, or one
  enemy-warship final blow = +1 full level AND zeroes the shared meter).
- Measured: total game captures on winning rows are 25–38 (the win ends the
  game before the commerce window matures); the veterancy arithmetic on the
  diagnostic seed tops out ~545 points. Capture attribution is engine-side
  (nearest hull in patrol range); ordering/concentration levers measured
  byte-neutral.
- Landed improvements: pre-veterancy raid bootstrap, pirate-immunity anchor
  filtering, conditional commerce cooldown, port-pair lane anchors,
  defense subfleet with SAM-gated replacement floor, single-hunter
  concentration, flagship-first ordering, adaptive hunter scaling,
  hunter-anchored corridor boat gate (captures 4→33 on the diagnostic seed;
  boat losses 11→7).
- Measured dead ends (do not retry): one-flagship policy (deadlock), anchor
  holds (defense collapse), fleet growth — raid-funded, post-SAM, and
  quiet-water (each diverts gold from the Port/trade compounding that is
  the commerce engine), fleet-cap raise, centroid anchors, win pacing
  (dominance gates never co-occur at team geometries).

### 2. "Destroy enemy buildings worth at least 5MM via nukes"

- Measured: nuked value is **world-value-bound**. On 5MM-profile maps
  everyone burns starting gold on weapons, leaving ~5–31k of structure
  value per target; no aiming policy can destroy value that was never
  built. ≥5MM occurs exactly when enemies build structures AND the game
  runs long (no-modifier profile, lucky seeds: 18.25M/18.5M precedents).
- Landed: expected-value guard at authoritative replacement costs,
  SAM-cover salvo saturation discipline, value-directed target retry,
  conquest-spare harvest mechanism (spares the richest enemy until the
  4-Atom quota), anti-SAM salvo aim biased to blast structure value,
  survival-only retaliation bypass.
- The first-SAM-before-first-hostile-nuke deadline is engine-cost-bound
  (1.5MM + 300-tick construction); helper policy (forecast admission,
  coverage retry hold, peace-window scheduling) has done all safe work.

### 3. "None of our landing boats destroyed" / "no sea invasion"

- Engine rule: any hostile warship within 130 tiles one-shots a transport
  with no reload; escorts cannot race it. Losses scale with launch count.
- Landed: hunter-anchored predictive corridor gate (live-coverage disks,
  auto-reopens on hunter death/dock — distinct from the measured-dead
  route-rectangle freeze). Losses reduced (11→7 on the diagnostic seed);
  zero requires not launching, which forfeits the naval economy metrics.

### 4. "Biggest player by land % at 2 minutes" (FFA with nations)

- Engine rule: Terra Nullius capture rate = adjacent-frontier × 2;
  pre-placed nations start with longer frontiers and compound. Every
  attack-side lever measured (payload, cadence, reserve, containment,
  cull, parallel waves — provably merged by the engine) is closed.

## Standing greens (verified on strongest rows)

won, warship kills ≥5, best economy, 0 own buildings nuked, SAM before first
hostile nuke (profile-dependent), 0 intent rejections, no wasted nukes below
expected value, no uncapturable-target warship pursuit, no ports on
land-locked water, ≥30 FPS per-tick budget.
