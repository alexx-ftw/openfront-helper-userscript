# N5: reinforcement observation experiment

Status: design bound to the actual frozen N5 manifest; both hosts completed 112 accepted training games and 24 holdout games each. No demonstrated Neural advantage. See [final results](hybrid-neural-evaluation-20261013-n5.md). Immutable manifest: `/home/eros/.local/state/ofh-evaluation/20261013-n5-reinforcement/frozen-plan.json`, SHA256 `d1ca14c6dc6e9da8d91e1d90a5d68dd62986f95924fd35518e66468ece4d134e`.

## Question

Does admitting fully accounted visible reinforcements produce genuine confirmed outcomes with nonzero existing commitment, change learned parameters, and improve full-match performance against current Legendary with Impossible Nations?

The remaining-front land-share reward is an aggregate proxy, not marginal reinforcement value. Neither sample readiness nor a native fixture establishes playing strength.

## Declared design

- Two native hosts: local Linux and Windows Porty, without WSL.
- Fresh compact `frontier-v1` models using `target-value-v1`; no historical envelope restamping, edited counters or weights.
- Each host collects 112 complete games in declared order, batches of four. Select only its final checkpoint; intermediate readiness never selects a winner. Distinct training seeds between hosts; eight identical fresh holdout seeds per host for paired baseline/shadow/learned comparisons.
- Keep the N4 map/game boundary: Onion Normal, FFA, Legendary, Impossible Nations 4, tribes 32, no modifiers, auto-build enabled, max ticks 103000, progress ticks 2000, no stop-on-death. Timeout 900000 ms. Collection policy `coverage-wait-v1`.
- Before launch, freeze exact combined sources, bundle, harness, engine revision/diff, runtime, configuration, feature/normalizer, seed lists and assessment settings in an immutable manifest. Reuse the house seed validator and reject historical or effective-seed collisions.
- Errors, caps, incomplete logs, drift and failed provenance remain failures, not losses or valid training completions. Preserve full incremental ledgers and exact final native winners.

## Data and safety gates

Report actual reinforced observations separately from confirmed finite reinforced outcomes and fitted samples. Inspect prior commitment, original/new receipt IDs, reward signs, elapsed ticks, exclusion reasons and head-parameter changes. Do not infer confirmed outcomes from accepted orders. Account for a single pending observer and its remaining-front attribution limit.

Preserve reserve/legality guards, readiness floors and unknown telemetry. If reinforced outcome coverage is absent, diagnose admission/observation logs before scheduling more collection. An unready final model cannot enter learned holdout.

## Evaluation

Compare each frozen model to its own current Legendary baseline on the same eight complete holdout games, with learning disabled and models unchanged. Report seat/game configuration, winner, ticks, final state, intent counts, actual control, confirmation, fallbacks and scoped safety coverage. Shared holdout seeds across hosts are eight scenarios, not sixteen independent scenarios. Describe cross-host differences as confounded.

Use paired win differences with descriptive 95% uncertainty, 10000 deterministic bootstrap resamples and a predeclared bootstrap seed. All ties or a degenerate interval do not prove equivalence. No automatic activation, promotion or strength claim without demonstrated improvement.

## Launch dependency

Concurrent nuclear/economy source edits remain outside the immutable scientific copy. The freeze uses HEAD `d24abfe7c607a3f6e5739d517b4827d35366830a` plus the measured Neural delta, not the watcher-mutated main bundle. Both native hosts independently measured equal source, harness, engine, model, feature, normalizer, configuration and bundle identities. The isolated full test chain passed; normal root integration and commit gates remain separate. This document does not authorize bypassing those gates or invent missing hashes.
