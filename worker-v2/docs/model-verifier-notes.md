# The model verifier — working notes

**Status: IN PROGRESS.** Updated as the work lands so a successor can resume from disk alone.
Started 2026-08-02 18:10 IST. Baseline: `node tools/test.mjs` → **140/145** (5 pre-existing reds
in d11-gates), `tsc --noEmit` clean.

## The problem this closes

`stages/verify-observations.ts` can promote an observation to `verified` through exactly two
closed predicates — `route` and `boundary`. Every other sealed case kind returns
`insufficient` with `NO_TYPED_EXPECTATION`, and upstream `extract/expand.ts#gapFor` marks the
case `NO_TYPED_PREDICATE_FOR_KIND` so the run's reported CEILING is honest about it.

On the reference run (`v2r_01kz0z87aghg3tk96c7q7qmqfm`, 226 requirements, **220 execution
cases**) that ceiling is 16 typed / 204 gapped, and **134 of the 204 gaps are
`NO_TYPED_PREDICATE_FOR_KIND`** — i.e. structural, not an extraction defect. No extraction
improvement can move them. A model verifier can.

## The invariant (owner-approved, not negotiable)

1. **The model never emits a verdict.** It emits a typed `ModelAttributeObservation`: a typed
   answer to a NAMED question about NAMED evidence, with verbatim quotes and evidence
   pointers.
2. **Deterministic derivation still owns promotion to `verified`.** run-workflow structural
   commitment #3 (no model call in `derive-verdicts`) stands. Model calls happen in their own
   OBSERVATION stage, before verification; `verify-observations` reads their typed output
   through closed predicates exactly as it reads walk projections.
3. **Provenance is marked** on every model-attested observation: registry provider id,
   transport provider, model id AS THE PROVIDER REPORTED IT, prompt hash, evidence-text hash,
   AI Gateway log id, call id, tokens and cost.
4. **The verbatim guard (the pa-extractor lesson).** Every quote the model returns is checked
   as a substring of THE EXACT BYTES IT WAS SHOWN. A quote that is not found is DROPPED and
   COUNTED, never trusted. A "found" with no surviving quote downgrades to not-found. Never
   raise; degrade to a named, counted failure.

The guard runs TWICE, deliberately:
- once in the observation stage, over the bytes it just sent (drop + count, recorded in the
  payload);
- once again in `verify-observations`, over the walk artifact RE-READ and RE-HASHED from the
  content-addressed store, with the evidence text RE-DERIVED by the same deterministic
  renderer. The payload is a POINTER; the predicate never trusts the producer's copy of the
  quotes. That second pass is what makes "the model asserted matches on evidence that
  contradicts" decidable by the predicate rather than by the model.

## Deliberate limitation, stated

**A model-attested observation can reach `satisfied` or `insufficient`. It can NEVER reach
`violated`.** A divergence claim needs a slot identity ("this screen element corresponds to
that document sentence") which the model cannot establish deterministically, and a fabricated
defect is the worse error by a wide margin. So the model verifier can raise the verified
count and can never manufacture a failure. Absence of evidence ⇒ `insufficient`, never
`contradicted` — the same positive-witness asymmetry the route predicate already obeys.

## Files

| File | What |
|---|---|
| `src/llm/registry.ts` | The provider registry: `deepseek-v4-pro` (DEFAULT), `grok`, `workers-ai`. Closed, no default arm. |
| `src/llm/workers-ai.ts` | The Workers AI binding leg, shaped to the same `ModelClient` interface as the HTTP legs. |
| `src/workflow/stages/model-observations.ts` | The observation stage: sealed requirement + re-read evidence → typed observation. |
| `src/workflow/stages/verify-observations.ts` | `MODEL_PREDICATE_FOR_KIND` — the three closed predicates. |
| `src/extract/expand.ts` | `gapFor()` coordination: a kind stops emitting `NO_TYPED_PREDICATE_FOR_KIND` only when its predicate exists AND is enabled. |
| `tools/tests/d17-model-verifier.test.mjs` | Positive + negative + provenance + disabled-flag tests. |
| `tools/mutate-model-verifier.mjs` | Mutation evidence the negatives can fail. |

## Config

`MODEL_VERIFIER_ENABLED` — **`"true"` in `wrangler.jsonc` (owner ruling, 2 Aug 2026).** The
deploy decision was made by the owner, not deferred. Absent from the environment ⇒ `false` in
code, so a test env or an arm Worker that does not set it behaves byte-identically to before
this change.

`MODEL_VERIFIER_PROVIDER` (default `deepseek-v4-pro`) + per-kind overrides
`MODEL_VERIFIER_PROVIDER_RENDERED_STATE` / `_OPTION_SET` / `_COPY`.

## Progress log

- 18:10 — read the target files; baseline captured; notes started.
