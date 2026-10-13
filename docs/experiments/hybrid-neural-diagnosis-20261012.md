# Why the coverage-trained Neural did not beat Legendary

This diagnosis uses the retained, separately frozen 1.12.243 coverage experiment. Current integration started at HEAD 6f8b71fb (1.13.1), then preserved City-startup commit 83b710d1. Historical results do not certify those newer policies or online behavior.

## Measured evidence

The old holdout completed 24 full native games over eight paired seeds, with each mode winning 1/8. Its ten funded learned proposals each had exactly one candidate; action, target and decision tick matched baseline. Target ranking therefore could not distinguish alternatives in those proposals. There were 4,997 no-funded-native-target and 278 no-native-eligible-target fallbacks. Funding denials are not evidence that reserve checks should be weakened.

The selected 56-game training run produced 44 WAIT outcomes and 18 ACT/target outcomes. ACT appeared in only 18 games; all ACT labels were positive and the macro incoming-pressure feature was always zero. The model reached feature-dimensional sample floors, but this is sparse, narrow teacher data rather than a demonstrated strategy improvement.

WAIT observation lasted one tick. ACT intervals lasted 17–399 ticks, median 129.5. Mean raw ACT/WAIT reward ratio was 245.63; mean per-tick ratio was 1.47. These are observational, unpaired labels and do not estimate causal opportunity cost or counterfactual action value.

An exact native-SGD replay checked all 62 original outcomes, their original pre-action model identities, sequence, features/normalizer and fourteen batch inputs/exports. It reproduced selected canonical model hash `e0f4eb657d7a717b3e40684223a354fd1208e78a3c0ab6d4fa328f77fa349dde`. A separate diagnostic replay from the same native cold factory changed only the scalar update label to reward/actual elapsed ticks. The mean ACT−WAIT margin fell from 0.057612 to 0.000058660, yet all ten reused proposal vectors still chose ACT. Those vectors are diagnostic reuse of the old holdout, not new holdout or model-selection evidence. No alternative candidate envelope was exported, activated or promoted.

## Producer issues to fix before collecting new labels

Independent bounded actual-source probes found two concrete evidence bugs:

- A controlled WAIT while an ACT owns the single pending observation slot can have no corresponding WAIT outcome or explicit exclusion proof.
- A direct accepted forced/land/boat emission can contaminate an ordinary WAIT observation; the existing competing-emission cancellation only protects collector WAITs.

These probes establish source behavior, not occurrence frequency in historical native games. The correction must preserve game actions and sender guards, bind exact decision/observation/emission references, censor interventions only after actual successful emission, and retain dense full decision coverage with explicit exclusions. Missing receipts, unknown legal masks, conflicting identities and unproved gaps must still fail closed. Focused green tests alone will not prove native integration or strength.

## Next bounded experiment

The trainer now has an explicit `--collection-stop seed-bound` path for finishing preregistered training seeds after readiness; its default remains `readiness`. The final checkpoint must still be genuinely ready for frozen holdout. This separates an operational training budget from minimal sample coverage and does not relax import, effective-seed, source/configuration, safety or activation gates.

Before fresh native runs, finish independent review and normal integrated build/hooks. Declare exact immutable sources, configuration, model selection, seeds and budget before launch. Both proposed arms use four Impossible Nations, Onion Normal FFA, 32 tribes and no modifiers: local legacy gate control versus native Windows Porty target-value control, with matching training seeds and independent models. The explicit compact-only `--control-profile target-value-v1` compares the best funded target value with WAIT and excludes retries whose value is below WAIT; the default preserves legacy control. The model/action metadata and model/feature hashes bind these semantics. No reward, optimizer or safety threshold changes. Compare each arm against its own paired current Legendary baseline. Never merge weights, transfer strict configuration provenance, select from old holdout performance, or silently relabel failed/capped runs as losses. No rate reward change is planned on the present evidence.

## Reproduction and evidence boundaries

Original full histories and manifests: `/home/eros/.local/state/ofh-evaluation/20261012-coverage-training`. The committed [coverage report](hybrid-coverage-training-20261012.md) describes that experiment.

Independent diagnostic sidecars: `/tmp/ofh-next-neural-policy-audit.md` and `.json`; `/tmp/ofh-next-neural-source-audit.md` and source probe; `/tmp/ofh-neural-temporal-diagnostic.md`, `.json` and `-probe.mjs`. The temporal probe checks original frozen bytes/order and calls the actual native normalizer and SGD; no manual sample-count or weight changes. Preserve these files with the next immutable experiment manifest before launch.

The active iteration is not complete. New full-game training, untouched paired evaluation, native WAIT exclusion verification, final hook and strength assessment remain pending. Keep Legendary as playing default.
