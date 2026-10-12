# Genuine WAIT coverage and complete offline evaluation

The `coverage-wait-v1` headless collector corrected the observed absence of WAIT training examples without changing attack safety or native model readiness. The selected completed-batch checkpoint became ready after 56 full training games: 44 WAIT, 18 ACT and 18 target samples. Independent replay reproduced all 62 updates and all 56 per-game model exports byte-for-byte. First readiness occurred at game 53; selection used the declared completed-batch boundary at game 56, not evaluation wins.

## Complete held-out comparison

Local Linux and native Windows Porty each evaluated four new paired seeds, using the same frozen model and baseline/shadow/learned modes with learning disabled. No WSL was used. All 24 games terminated with a native winner; there were zero errors, horizon exclusions or unverified runs. Strict aggregation and independent review verified the eight complete groups and frozen source/model/configuration/launch bindings.

| Mode               | Wins | Games |
| ------------------ | ---: | ----: |
| Legendary baseline |    1 |     8 |
| Shadow             |    1 |     8 |
| Neural             |    1 |     8 |

Winner, terminal tick, final bot state and intent totals were identical within every seed. This is a small descriptive sample, not evidence of general equivalence. Neural had 10 accepted attacks, five confirmed attacks, zero controlled WAITs and 5,275 fallbacks. Four seeds had no funded Neural target. The ten exercised learned-attack reserve/legality checks recorded zero violations/illegal emissions; unexercised seeds do not certify safety.

## Diagnosis and configuration

The former shadow teacher attacked on qualified opportunities and produced no completed WAIT samples. The collector supplies real, separately labelled safe WAIT outcomes; it does not relabel fallbacks, alter sample counts or credit learned control. Unknown threat information rejects collection, zero-duration outcomes are censored, and actual competing forced/land/boat emissions cancel collector WAIT observations. Funding, capture reserves, Defense Post, pending commitments, legality and rate checks remain intact. The collector is explicitly headless, shadow-learning-only and inactive in frozen evaluation and ordinary browser defaults.

Readiness now passes, but learned control remains rare. The model controls only funded strategic land combat; forced actions, tribes, naval and economic behavior remain inherited. Its tactical contextual regression uses different WAIT and ACT outcome windows. Reward-window bias is an unproven hypothesis for a future separately declared ablation, not a reason to weaken reserves or claim PPO behavior.

Keep Legendary as the playing default. Shadow is useful for observation; Learn belongs to explicit recorded training runs. This checkpoint has no demonstrated strength benefit and must not be promoted or automatically activated.

Declared environment: Onion/Normal, FFA, two Impossible Nations, 32 tribes, no modifiers, maximum 103000 ticks, progress every 2000 ticks, no stop-on-death, `OFH_HYBRID_COLLECTION_POLICY=coverage-wait-v1`. Frozen bot source is commit `f200e4739765c9ff92fe7159e077e8e65cac1bad`, version 1.12.243 plus task-owned changes; concurrent newer Legendary/nuclear/construction edits were excluded. Direct official GameImpl/BundledHarness admission does not prove browser or online server/FIFO parity.

## Durable evidence

Evidence root: `/home/eros/.local/state/ofh-evaluation/20261012-coverage-training`.

- `plan.json`, `coordination-plan.json`, `driver-binding.json`, `selected.json`: declared configuration, disjoint seeds, selection and exact orchestration pins. Driver binding predates selection/holdout but was recorded after training started; historical prelaunch binding is not invented.
- `arm-0/collection-13/trained-model.json` and byte-identical `selected-model.json`: model hash `e0f4eb657d7a717b3e40684223a354fd1208e78a3c0ab6d4fa328f77fa349dde`.
- `holdout-local/`, `holdout-porty/`, both shard results and `aggregate-holdout-result.json`: complete raw logs, native manifests/results and policy/attack histories. Porty output was copied unchanged.
- All 24 attack-admission files have validated runIDs and contiguous sequences: 60,180 attempts, 9,579 emissions, 50,601 explicitly explained rejections, zero exception records. Main causes: capture reserve 22,729, no spendable troops 14,514, reinforcement reserve 3,852, boat authorization 3,579, target authorization 2,910, pending duplicate 1,512. These are all-bot dispatch attempts across all modes, not Neural-only candidates.
- `/tmp/ofh-coverage-local56-audit.md` and `/tmp/ofh-coverage-holdout-independent-review.md`: independent bounded lineage and complete paired-result reviews.

Root integration is separate from these frozen scientific results. The project owner coordinated and preserved the concurrent economic and nuclear changes in version 1.12.248. Integrated `quality:global` and the complete `quality:logic` suite passed; original failure logs remain intact. Construction quotes now use the correct fixture tile, unexpected construction-probe and rail-cluster errors propagate, and the admission source audit permits only the four exact diagnostic handlers that rethrow. Mutation checks reject swallowed errors. The lint ratchet decreases from 95 to 94 historical findings, without relaxing rules.

A subsequent independent caller review found that incoming land defense could bypass hostile-nuke observation. Initialization now observes immediately after creating the behaviors; subsequent live ticks observe before pending salvos and defense returns. This scheduling correction is separate from the frozen benchmark and does not establish a strength gain. Final regenerated artifacts and the normal commit hook must validate the complete integrated source, including this correction; no model is activated.
