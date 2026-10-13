# N5: reinforcement observations and full-match evaluation

Status: both native hosts completed training and holdout; independent recorded-evidence reviews passed for both. No model activated or promoted.

## Change and boundary

Commit `85bff666f2cc0018d579654e228a8a03fb93c75f` admits observation of a reinforcement only when existing visible land commitments have unique primitive receipt IDs, finite positive troop values and an exact accounted total. Old receipts cannot confirm the new order. Ambiguous commitments remain excluded; funding, reserves, legality, readiness and dispatch payloads are unchanged.

The remaining-war land-share reward is an aggregate proxy, not a causal estimate of a reinforcement's marginal value. The native fixture and full test chain passed, including normal commit hooks. Native Windows and Linux fixture checks passed.

The scientific copy freezes HEAD `d24abfe7c607a3f6e5739d517b4827d35366830a` plus the measured observer delta, excluding concurrent nuclear/economy edits. Bundle SHA256: `d61df40ed4eae93f46e15db6b5051297e91ecac60b0fc2d2bacc73639ee44cbb`. Manifest SHA256: `d1ca14c6dc6e9da8d91e1d90a5d68dd62986f95924fd35518e66468ece4d134e`.

Both hosts use fresh independent compact `frontier-v1` / `target-value-v1` models, 112 ordered training seeds each and the same eight disjoint holdout scenarios. Each holdout runs baseline, shadow and learned with learning disabled and model bytes unchanged. Onion Normal, FFA, four Impossible Nations, 32 tribes, Legendary baseline, auto-build and no modifiers. This is direct-engine offline evidence, without live server admission or browser parity.

## Verified local results

- 112 accepted terminal collection games; zero process errors or horizons. Final model has 55 WAIT / 49 ACT / 49 target samples and native readiness.
- Full collection/holdout audit identifies 16 confirmed finite reinforcement outcomes during collection and two during holdout. The latter are shadow/learned observations of the same holdout05 action, not two independent actions. Each has positive prior commitment and distinct old/new receipt evidence. No missing or invalid prior-commitment fields among the 51 inspected attack outcomes.
- 24 complete holdout games: Legendary, Shadow and Neural each win 0/8. Paired winners, ticks, final state, construction events and intent counts match in every seed.
- Neural controls one of 1,667 decisions: one accepted and confirmed attack, no controlled WAIT, 1,666 fallbacks. Reasons: 1,361 unfunded native targets and 305 missing eligible native targets.
- The sole learned order at tick 2684 targets player 4 with 810,159 troops, exactly matching baseline/shadow; native receipt appears at tick 2685.
- Emitted attack-admission sequences match in all eight seeds. Complete admission logs match in only two: 123 differences concern rejected records (`capture-reserve-insufficient` versus `commitment-veto`). The full logs are not identical.
- Learned-attack safety covers one reserve and one legality check, with zero violations or illegal emissions; this does not certify all bot actions.

The independent review checks 112 collection result files, 28 ordered checkpoints, 24 holdout results and all 13,669 holdout policy events. Native models remain unchanged during holdout; launch bindings verify. Collection changes the native model in 34/112 games. All-tie descriptive uncertainty is not evidence of equivalence or adequate statistical power.

## Interpretation and configuration

During collection the learner genuinely receives outcomes and updates its native parameters; holdout learning is disabled. The observed bottleneck is limited influence: most decisions lack an eligible, funded native target, and the single controlled attack already agrees with Legendary. More samples alone have not demonstrated better play. Preserve the guards; do not interpret blocked orders as proof that those guards should be weakened.

Keep Legendary as the playing default. Shadow is useful for observation and diagnostics. Neural has no demonstrated advantage in this local holdout; readiness is not a promotion criterion. No evidence here justifies enabling the experimental shaping arm or automatic activation.

Promotion requirements were not verified as frozen before launch: `requirementsFrozenBeforeLaunch=false`. The frozen cohort/seed binding is separate from a verified promotion gate.

## Porty recovery and evidence

Porty uses native Windows Node, without WSL. An unexpected reboot interrupted the first attempt; its cause is unknown. Recovery strictly resumes the original immutable four-seed checkpoint, then reruns seeds 005–112. Earlier completed attempts 005/006 remain archived and excluded; interrupted 007 is not counted as a loss. The primary dataset contains 112 unique training seeds, not 114 independent games.

Porty completed 112 accepted terminal training games and 24 terminal holdout games, with zero errors or horizons. Its final model has 43 WAIT / 28 ACT / 28 target samples; envelope SHA256 `06096c5a5c9418939f356331b527fad6869d83af6e32ba80dd1a2bc06e413f2b`, model hash `7556ff91ddf0e89685d0b1436a0650bafe88cc5a3067fa4479bef3b85730a41f`. The final model was unchanged during holdout.

Porty's baseline/shadow/learned each win 0/8, with matching paired terminal state and intent counts. Neural again has one controlled/accepted/confirmed attack, no controlled WAIT and 1,666 fallbacks among 1,667 decisions: 1,361 unfunded and 305 without an eligible native target. Scoped safety again covers one reserve and one legality check, zero violations/illegal emissions. The supervisor exits 0 and verifies the post-run freeze.

The independent Porty review verifies all 13,669 holdout policy events against the full original stream. Emitted attack admissions match in all eight seeds; complete admission logs match in only two, with 123 differences in rejected records. The sole learned order matches baseline/shadow at tick 2684; its native receipt is confirmed at tick 2685.

Direct joins over the four original prefix games, 108 resumed games and 24 holdout games identify eight confirmed finite reinforcement outcomes during Porty collection and two during holdout. Those two are paired shadow/learned observations of the same attack, not independent actions. Among 30 attack outcomes there are no missing/invalid prior-commitment fields. Across hosts, collection has 24 such reinforcement outcomes (16 local + eight Porty); four additional holdout records are paired observations, not extra training samples.

The legacy reinforcement-audit helper failed on Porty because its cold-initialization assertion correctly rejects a resumed two-sample checkpoint; its result is not a PASS. The independent review instead joins original event files directly without weakening that guard.

Across both primary datasets: 224 unique training games and 48 holdout executions. Porty's two archived repeated terminal attempts are excluded; the interrupted attempt remains unverified. The shared eight holdout seeds are eight scenarios, not sixteen independent scenarios. Neither host demonstrates an advantage for Neural.

Porty evidence: `porty-final-native-audit.json`, `porty-final-model.json`, `porty-final-result.json`, `porty-independent-review.md`, `porty-independent-review.json` and `porty-resume-1.supervisor.jsonl`. Result SHA256: `96245ded373ee975019361a0d8a9ca330373bba46a9392ad7d2fe12aed3faf8d`.

Durable evidence directory: `/home/eros/.local/state/ofh-evaluation/20261013-n5-reinforcement/`. Local evidence: `local-final-native-audit.json`, `local-final-reinforcement-audit.json`, `local-independent-review.md`, `local-independent-review.json`, `local-output/result.json`, and `local-output.supervisor.jsonl` (EXIT0, postfreeze verified). Final local model envelope SHA256: `ef8cca135fee62f7ec75cf75a20731b4bc60e6f2063dd5f920a8980fe7b45b00`; model hash: `43c660b117fcf0b726077969aabb8c846586b8d11eea95632a364a70bd1d7541`.
