# START HERE — the falsification sprint

**You (GPT-5.6-sol) proposed this experiment. The owner accepted it. These files exist so you can begin
immediately without rediscovering the system.**

> ## ⚠ READ `07-LIVE-RESULTS.md` FIRST — it changes the plan
>
> The full branching fleet has since run with the option-set predicate live. **The checker detected a planted
> defect it had never seen (`OPTION_MISSING`, naming the exact missing option) and stayed silent on the matched
> clean twin — 8 option-set cases passed on clean, 0 claims; 1 correct accusation on flawed.** Zero fabrications
> across six clean variants.
>
> **17 of 18 seeded defects were still missed — but `predicate gaps: 0`.** Every miss is a screen the walker
> never reached. **REACH, not judgement, is now the binding constraint**, and a 16-of-20 target measured against
> a walker that arrives at half the planted defects measures the walker rather than the checker.
>
> An earlier memo led with "the decisive test failed". That was premature — it predated s4. `07-LIVE-RESULTS.md`
> is authoritative over any earlier summary.

Read in order: **`07-LIVE-RESULTS.md`** → this file → `01-THE-EXPERIMENT.md` → `02-SYSTEM.md` →
`03-BUILD-TASK.md` → `04-CORPUS.md` → `05-ENVIRONMENT.md` → `06-TRAPS.md`.

> ### One deliberate exception to the freeze — the .docx parser patch
>
> `worker-v2/src/extract/docx-blocks.ts` is being changed mid-sprint (merged cells `gridSpan`/`vMerge`,
> `w:tblHeader`, `gridBefore`, `w:sdt` dropdown items, NBSP, hyphens, `w:ruby` — ~90 lines). **This was
> ordered directly by the owner and supersedes the freeze. It is not a violation and the freeze is otherwise
> real.**
>
> **It cannot affect the sprint's measurement**, and that is literal rather than a reassurance: the experiment
> runs against a **hand-authored frozen contract**, so extraction — and therefore the parser — is not in the
> path being measured at all. That is the entire design (§The experiment, `01-THE-EXPERIMENT.md`).
>
> **Two things it DOES touch, so plan around them:**
> 1. **Any run started from a `.docx` will seal a different contract** (new `(list)` lines from dropdowns,
>    corrected merged-cell text). Contract reuse will correctly MISS on re-extraction, so denominators move.
>    Anything compared across the patch boundary is not controlled.
> 2. **The fleet and acceptance runs use extracted contracts even though the core experiment does not** — so a
>    mid-sprint deploy would break comparability of any re-run against earlier fleet numbers.
>
> **Deploy timing is an open owner decision.** Current posture: **land in the tree, hold the deploy until
> post-sprint** unless the owner says otherwise. If you find the deployed parser and the tree disagree, that is
> why.

> ### Second and third owner-ordered exceptions to the freeze — 11 Aug review fixes + navigator upgrade
>
> Same precedent as the parser patch above, same authority: the owner ordered (11 Aug) fixes for the
> 13 review-confirmed defects (local commit `26f9fce` — including changes to `expand.ts`,
> `verify-observations.ts` and the option-set predicate's attribution rules) and a navigator/reach
> upgrade (allocation filler, survival hints, bounded screen-out retry; uncommitted on top).
> **These are not freeze violations.**
>
> What this means for the sprint's measurement:
> 1. The experiment's core design is intact — it runs against a hand-authored frozen contract, so
>    extraction stays out of the measured path.
> 2. **The checker being measured is now the fixed checker** — four confirmed false-accusation
>    paths in the option-set chain are closed, and the sole-group attribution rule changed
>    (VERIFIER 1.8.0). The 0/10 false-positive threshold now tests the repaired predicate.
> 3. **Reach is materially different**: walks that used to die at allocation grids and screeners
>    now pass them. Re-verify every planted defect's reachability with `tools/live-walk.mjs`
>    AFTER these changes — pre-11-Aug reach observations are stale, in the walker's favor.
> 4. Fleet numbers from before this boundary are not comparable to numbers after it.

---

## Your own verdict, restated as the mandate

> *"Allow one 5-day falsification sprint; miss any benchmark threshold and kill it."*
> *"Anything other than a blinded mutation benchmark now is displacement activity."*

**The product:** `survey-qa` takes a market-research questionnaire (`.docx`) plus a live survey URL and reports
every place the site fails to implement the document. Document is source of truth. **A confident WRONG answer is
the cardinal failure** — worse than finding nothing.

**Why this experiment exists.** The system found two genuine defects on one survey. Then its first controlled
test against planted defects — `s1-skip-flawed`, carrying a seeded `missing-option`, the exact class a
just-shipped predicate decides — **found 0 of 3**. And nobody can say why, because three things could have
failed: the browser never reached the screen, the LLM extracted the wrong requirements, or the checker looked
and got it wrong.

**Your insight, which is the whole design:** hand-write the requirements so extraction cannot be the alibi. Then
a failure is unambiguously the checker's.

---

## The thresholds — pre-committed, do not renegotiate them mid-sprint

Against a **frozen, human-authored contract**:

| | threshold |
|---|---|
| Detection | **≥ 16 of 20** planted defects |
| False positives | **0 of 10** matched clean controls |
| Insufficient | **≤ 4 of 20** supported checks |

**Miss any one → the recommendation is KILL.** Pass all three → continue, but only as a narrow high-precision
defect finder, not a coverage auditor.

Defects must sit **only** in the three classes the system actually implements: **route**, **boundary**,
**option-set**. Planting a defect in a class with no predicate measures nothing.

---

## Owner decisions already made (do not re-open)

1. **A separate agent transcribes the requirements from the `.docx`, with NO access to the predicate source.**
   The bias this removes is real: whoever writes the contract while looking at the checker will write
   requirements the checker happens to handle.
2. **The defect manifest stays in a directory nobody opens until results are in.** This is not the elaborate
   blinding apparatus the owner previously killed — it is one file, unread, for the duration.
3. **A catch is STRICT**: a claim naming the *right requirement* with the *right defect type*. A claim on the
   right survey pointing at the wrong thing is not a catch. A system that flags the wrong thing on a broken
   survey is lucky, not working.
4. **The corpus is not rushed.** A badly planted defect produces a meaningless number. Spend the time.

---

## What this experiment is NOT allowed to become

- **No new predicates.** Three exist. Adding a fourth mid-sprint invalidates the measurement.
- **No extraction tuning.** The whole point is that extraction is out of the loop.
- **No dashboards, orchestration, reporting polish.** Your word for it was *displacement activity*.
- **No moving the thresholds after seeing results.**

---

## The honest state of the evidence

**Proven:** two real defects, deterministically, on one survey (a routing mismatch and an unenforced 500-char
limit). Seven pass verdicts audited to markup level. Concurrency works. Contract reuse works.

**Not proven:** every other survey found nothing. ~90% of checks return `insufficient`. Extraction is
nondeterministic — the same document re-read yields **15–51% different requirement counts**, and only ~1/3 of
requirements are stably identifiable run-to-run.

**Premises you already challenged, which the owner accepted:**
- "Completed end-to-end" was misleading — the first record containing real defects was signed with an empty
  claims array.
- Contract reuse is not validation; it freezes one draw from a nondeterministic process.
- The no-fabrication result is weak evidence, because an empty claims array was hardcoded — zero claims can
  mean a disconnected output path rather than precision.
- 47 deployed targets are not evidence of value.

Keep challenging premises. That has been the highest-value thing in this project.
