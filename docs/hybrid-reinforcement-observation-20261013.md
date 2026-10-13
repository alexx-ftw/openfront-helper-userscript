# Reinforcement observation: next evaluation

Status: unit regressions, native receipt characterization on Linux and native Windows, and the isolated full test chain passed. Fresh cold-model collection is running on both hosts; full holdout evaluation remains pending. No model activation or strength claim.

## Finding

The preceding N4 study completed 224 collection games and 48 holdout games without demonstrating a learned advantage. Its six accepted learned dispatches per arm had zero policy-confirmed receipts. The first recorded omissions were `ambiguous-commitment`: our observer rejected every action with an existing target commitment.

That is an observer restriction, not proof that native reinforcements lack a new ID. At engine revision `f372cdf9451cd8c3dc113aaaf8641e2609e2d3cb`, AttackExecution creates a new attack and, for an ordinary land reinforcement, adds older same-target attacks' troops to it and deletes their old IDs. The client exposes attack IDs and troops. It does not expose sourceTile; the wrapper's null fallback is not proof of a land origin.

## Bounded change

Observe an existing commitment only when visible, unique attack IDs with finite positive troop amounts account for its full troop total. Pending orders, in-flight boats, missing IDs and duplicate IDs remain excluded. Keep all pre-dispatch IDs as the baseline: none can confirm the new order. Acceptance alone still cannot create a receipt, outcome or training sample.

The observation retains `preexistingCommitmentTroops` and `commitmentScope:remaining-target-commitment`. Its reward remains the change in own land share until that target commitment ends. It includes the remaining front and other concurrent activity; it is not the reinforcement's marginal conquest or causal value. No funding, reserve, legality, payload, normalization, reward formula or readiness floor is relaxed.

## Evidence so far

- The new visible-receipt regression failed before the change, with `actionObservation` returning null.
- The combat suite passes the positive replacement-ID case and pending-order, boat, missing-ID, duplicate-ID, old-ID and unconfirmed-outcome negatives. Existing world/observation cancellation and trajectory checks also pass.
- The official GameImpl/GameRunner/Executor native fixture passed: old ID `ayyxm29h`, replacement `xzz4q63d`; original commitment 20,000 troops, 19,672.01926517857 absorbed after the old execution advanced. The old ID did not confirm the new intent. The replacement remained live for 12 observed ticks; outcome tick 65, reward 0.5, one ACT and one target update, no WAIT update.
- That native fixture uses an observer-only Ridge adapter on a declared 32×16 map with fixture troop setup. It is not a full match, compact geometry proof, sender-guard parity check or evidence of improved play.

Final native rerun EXIT0: policy SHA256 `737a4e0e7db2a4f1ea93f693aff7dbac0005a9e173f47d12ea5e07d74a30a2f8`; test SHA256 `9270460d9fb79a6dbe3a305151373deca8137647485d8e781946708ba2f9e2ad`. It ran without preparation environment flags, verified actual ACT and target parameter changes, and preserved the same measured receipts and outcome. Log: `/tmp/ofh-n5-native-final.log`. The full combat unit suite also returned EXIT0 (`/tmp/ofh-n5-unit-recovery.log`); targeted strict lint and formatting returned EXIT0 (`/tmp/ofh-n5-final-style.log`). Independent scoped review accepted this exact policy hash; it did not independently execute native tests. Primitive nonempty string IDs are required; object IDs are explicitly rejected.

## Next experiment boundary

N5 uses an isolated scientific copy of HEAD `d24abfe7c607a3f6e5739d517b4827d35366830a` plus the explicitly hashed Neural delta, excluding concurrent uncommitted nuclear/economy edits. The preregistered manifest is `/home/eros/.local/state/ofh-evaluation/20261013-n5-reinforcement/frozen-plan.json`, SHA256 `d1ca14c6dc6e9da8d91e1d90a5d68dd62986f95924fd35518e66468ece4d134e`. Both hosts measured equal source closures and binary patch hash `35d12bcf22b418afbc9f5ab40e1324616721702be799fdafc1145c1ccd8b8e2d`; bundle hash `d61df40ed4eae93f46e15db6b5051297e91ecac60b0fc2d2bacc73639ee44cbb`. The native supervisor verifies inputs before and after training, rejects unbound Node preloads, preserves failed output and cannot activate a model. House per-launch checks remain active. The study is 112 distinct collection seeds per host and eight shared holdout scenarios, not sixteen independent scenarios.

Windows unexpectedly rebooted after six completed attempts; system events 41 and 6008 confirm the unclean interruption but do not establish its cause. Resume uses the untouched checkpoint containing seeds 001–004 and actual samples 2/2/2, SHA256 `dc4df3ec442dc22eae265f6596b66f300433b65b2518304e1b8d6428e62e533f`. The separate prelaunch resume declaration `/home/eros/.local/state/ofh-evaluation/20261013-n5-reinforcement/porty-resume-1.declaration.v2.json` binds that checkpoint and remaining original seeds 005–112. Earlier attempts 005/006 remain archived and excluded from the resumed primary dataset; incomplete 007 is unverified, not a loss. No provenance or counts are rewritten, and repeated attempts are not additional independent scenarios.

Use new cold models and an immutable combined source/bundle/configuration freeze. Preserve the N4 originals and do not restamp their provenance. Declare fresh training/holdout seeds and bounds before launching either host. Keep Windows native on Porty, paired baseline/shadow/learned modes on identical holdout seeds, complete incremental records and errors/caps distinct from losses.

Inspect whether genuine confirmed outcomes with nonzero prior commitment increase and whether model parameters actually change. The unchanged sample floors only permit inference; they do not establish adequate context coverage or performance. Evaluate each frozen model against its own Legendary baseline in complete games with Impossible Nations. Retain unknown telemetry as unknown and no automatic activation or promotion.
