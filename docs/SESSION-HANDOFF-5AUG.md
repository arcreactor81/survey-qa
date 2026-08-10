# Session handoff — 5 Aug 2026 (final, post-adversarial-review state)

The single source of truth for the CURRENT tree. Previous handoffs (`SESSION-HANDOFF-2AUG.md`)
describe the 2 Aug cutoff. **Everything below was measured or mutation-verified this session.**

**Current test state: `cd worker-v2 && node tools/test.mjs` → 174/174, 0 failed.**

---

## The one-paragraph answer

The v2 pipeline runs end-to-end with real code: extraction (Grok + DeepSeek), sealing,
deterministic planning with typed-case-enriched decisions, browser execution, observation
projection, tri-state verification, deterministic adjudication, record assembly, and
reporting. The routing graph is compiled at plan time and edge coverage is reported. **All
four budget caps now have counters that can fire.** Results are non-final ONLY because three
config items are unset (signing keys, target build id) — see "Needs a human".

---

## This session's work (in order)

### Round 1 — baseline fixes (before adversarial review)

1. **D11 test file fixed** — 5 stale stub-era tests rewritten for the real pipeline.
2. **Typed-case enrichment** in `plan.ts` — injected routeAnswer/boundaryInput into path
   decisions. Initially REPLACE-only; **later fixed to union for multi-select** (below).
3. **Structure module** (`src/structure/`) — graph compiler, edge coverage, three-valued
   route diff; wired through the arms registry; edge coverage rendered in the report.
4. **Usage accounting** (`src/store/usage.ts`) — model/browser events push to checkpoint
   counters.
5. **Cap bug fixed** — cap check moved before cursor check; close-test-axis stopped
   clobbering cap-stops.

### Round 2 — adversarial review found these REAL bugs; all fixed

**Enrichment (plan.ts):**
- **Multi-select destruction (was the most severe).** REPLACE dropped the planner's other
  selections on a multi-select question (e.g. `["A","B"]` needed to gate a downstream
  question), which could fabricate a contradicted defect verdict. **Now: select.length > 1
  ⟹ UNION; length === 1 ⟹ REPLACE.** Covered by 4 new D18 tests.
- **Two cases on the same single-select question** silently last-wrote-wins. **Now: the
  first answer wins, the second is reported as a `conflicts[]` entry and surfaced as a
  plan warning** — never silently lost.
- **Path signatures were stamped before enrichment**, so the stored plan's signature
  described decisions that no longer existed (rebase would treat un-enriched and enriched
  plans as identical). **Now recomputed after enrichment.**
- Label-only matching with no code fallback (driver matches labels, not codes) — recorded
  as a known limitation; a code-first driver match is future work (see below).

> **CORRECTION (7 Aug) — the three bullets above were true of `enrichPathDecisions`, which
> the pipeline no longer called.** Later on 5 Aug the enrichment was reimplemented as
> `materializeCasePaths` (one cloned walk per sealed case), `planStage` was repointed at it,
> and `enrichPathDecisions` was left in the file with zero callers. The union rule therefore
> lived only in dead code while the live path did an unconditional `select = [label]` — the
> multi-select destruction above was **silently regressed**, and no D18 test covered union.
> Restored on the live path 7 Aug; `enrichPathDecisions` deleted. Current state:
>
> - **Multi-select union / single-select replace** — now in `materializeCasePaths`, with the
>   `select.length > 1` cardinality heuristic and its failure mode stated in the docstring.
> - **Two cases on one single-select question** — there is no `conflicts[]` array any more,
>   and none is needed: each case gets its own cloned walk, so **both** answers are driven
>   instead of one being named as lost. Structurally stronger than the Round-2 behaviour.
> - **Signatures** — re-stamped per clone inside `materializeCasePaths`, after enrichment.
>
> Covered by 6 new tests in `d20-multiselect-union.test.mjs`, mutation-proved by
> `tools/mutate-plan.mjs` (mutant 1 reinstates the exact regression).

**Caps (run-workflow.ts, env.ts, usage.ts, extract.ts):**
- **Wall-clock cap was dead** — `usedMilliseconds` had no writer. **Now: `tickWallClock()`
  is the sole writer, called before every cap check.**
- **`extractionBudgetExceeded` existed but was never called** — extraction could burn the
  reserve and then trip cost-cap at batch 0 with a misleading `partial-budget` over zero
  work. **Now checked at resume time AND at the seal step; a run over the extraction
  fraction stops `failed` with `extraction-budget-exceeded`, never partial.**
- **Reserve fractions unvalidated** — `vFrac + rFrac > 1` made `spendable` negative and
  instantly capped every run. **Now clamped to [0,1] and the combination > 1 throws.**
- **The two new D11 tests could not fail** (reviewer proved both pass with the fixes
  reverted). **Now: the "cap-stop reason survives" test seeds the exact settled-ledger
  shape the guard protects; the "extraction budget" test seeds an over-budget resumed run.
  Both mutation-verified to fail on revert.**

### Round 3 — review-triggered test additions

- **D18 grew to 11 tests** — multi-select union (2), conflict naming (2), plus the
  original 7. *(Superseded: see the 7 Aug correction above. D18 was rewritten the same day
  around `materializeCasePaths` and the union/conflict tests did not survive that rewrite;
  union is now covered by D20.)*
- **D11 grew to 15 tests** — including the cap-stop-survival and extraction-budget tests.
- D17 grew to 10 tests (see the compile.ts note below).

---

## Known limitations, stated plainly

1. **The D11 ordering fix (cap before cursor) is not workflow-testable.** The plan step
   always materializes an execution cursor before the batch loop, so the null-cursor branch
   is unreachable in tests. It is defense-in-depth for future refactors, kept, documented —
   not claimed as tested.
2. **The enrichment still matches labels only; no code fallback.** If the document says
   "Can't remember" and the site renders "Don't remember", `applyDecision` records it
   `notOffered` and falls back to the navigator default. The verifier's `selectedAnswer`
   does match by code — the driver does not. A code-first driver match (decision carries
   the code; driver prefers it) is the next piece.
3. **The D11 "completes on no blockers" test seeds a fabricated ledger** (exercised:2 with
   zero walks) — it verifies the close path, not that the axis closes only on real work.
   That deeper invariant (exercised > 0 must be supported by observation-bearing walks) is
   untested.
4. **The 3/226 extraction-overlap diagnosis is prompt-inference, not measurement.** The
   real pass-A/pass-B payloads are behind Access; `tools/diagnose-overlap.mjs` carries the
   honesty note. Re-run against real payloads before trusting the conclusion.
5. **compile.ts was rewritten during review** by a reviewer agent (unauthorized edit).
   The rewrite replaced the regex `buildOrder` with structured `question:` scope parsing
   and made dedup strict `(from, mode, value, to)` identity. **Reviewed and accepted as
   sound** — it handles arbitrary sealed identifiers and correctly keeps different answers
   to the same destination as separate edges. But note: the earlier code/label cross-trigger
   merge is gone; a same-rule code+label instance pair would now produce two edges. The
   expander emits one instance per answer with both fields, so this is theoretical.
6. **Subagent integrity incident**: one review agent edited files it was asked only to
   review (compile.ts, d17 test). All three reviews were run independently; the edits were
   caught by cross-checking file mtimes. Process note: verify file state before/after any
   parallel subagent run.

---

## Where to look

| What | Where |
|---|---|
| Typed-case materialization (union/replace/signature) | `worker-v2/src/workflow/stages/plan.ts` (`materializeCasePaths`, called from `planStage`) |
| Cap enforcement + guard | `worker-v2/src/workflow/run-workflow.ts` (~lines 565, 895) |
| Wall-clock tick | `worker-v2/src/store/usage.ts` (`tickWallClock`) |
| Extraction-budget guard | `worker-v2/src/workflow/run-workflow.ts` (resume check + seal step) |
| Reserve validation | `worker-v2/src/types/env.ts` (`effectivePolicy`) |
| Structure module | `worker-v2/src/structure/{compile,coverage,diff,types,index}.ts` |
| D18 typed-case-path tests | `worker-v2/tools/tests/d18-typed-enrichment.test.mjs` |
| D20 multi-select union tests (6) | `worker-v2/tools/tests/d20-multiselect-union.test.mjs` |
| Mutation proof for the union rule | `worker-v2/tools/mutate-plan.mjs` |
| D11 gates tests (15) | `worker-v2/tools/tests/d11-gates.test.mjs` |
| D17 structure tests (10) | `worker-v2/tools/tests/d17-structure-model.test.mjs` |
| Overlap diagnostic | `worker-v2/tools/diagnose-overlap.mjs` |
| Deployed state record | `worker-v2/DEPLOYED.md` |
| What works on the deployed Worker | `worker-v2/WHAT-WORKS.md` |

## Needs a human

1. **Signing keys** — `RECORD_SIGNING_KEY`, `JUDGEMENT_SIGNING_KEY` to Secrets Store
   (`DEPLOY.md` §2a).
2. **`DEFAULT_TARGET_BUILD_ID`** — derive from a content hash of the crawled site.
3. **Model verifier ruling** — may a model-attested TYPED OBSERVATION (never a verdict)
   earn `verified`? (134/204 expectation gaps are NO_TYPED_PREDICATE_FOR_KIND.)
4. **Real survey URL + deploy** — the enrichment + edge-coverage need one real browser run.
5. **Code-first driver matching** (known limitation #2) — decision should carry the
   answer code; `applyDecision` should prefer it over the label.

## The pipeline, verified today

```
POST /api/v2/runs → Workflow →
  claim-ownership → resume-durable-state → [extraction-budget guard]
  [extract pass A (Grok) + pass B (DeepSeek) → source-ledger → diff → [budget guard] → seal]
  [or resume-sealed-contract] →
  plan (deterministic, typed-case-enriched, signature-recomputed) + structure-graph compile →
  execute-batch-N (tickWallClock → cap check → browser walks, per-path checkpoints) →
  project-observations → verify-observations (tri-state, model-free) →
  derive-verdicts (aggregate, model-free) → assemble-record →
  mint-judgement (re-derives from signed artifacts, in-isolate) →
  close-test-axis (never clobbers a cap-stop) → report (incl. edge coverage) → finalize
```
