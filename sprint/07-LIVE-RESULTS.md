# LIVE RESULTS — read this before designing anything

**9 Aug 2026. Full branching fleet, deployed `d72990f8`, option-set predicate live.**
These are measured outcomes from the production pipeline, not replay or fixtures.

---

## THE HEADLINE: the checker detected a planted defect it had never seen, and stayed silent on the matched clean twin.

Seeded defect in `s4-nested-rotation-flawed`: **`S4-E03: missing-option @ Q1, option 5`**

What the system reported, with no access to the manifest:

> **`OPTION_MISSING`** — *"the document requires this question to offer 5=LIBTAYO; the screen's complete option
> inventory ("OPDIVO", "TECENTRIQ", …"*

**Right question. Right option. Right defect type.** This clears the STRICT criterion in `00-START-HERE.md`
(§Owner decisions #3) — not "flagged something on a broken survey", but "named the specific thing that broke".

### The negative control held

Both variants judged against **58 identical requirements** (contract reuse fired on both, so the pair is
genuinely controlled — same document, same seal, only the site differs):

| | clean | flawed |
|---|---|---|
| option-set cases passed | **8** | 2 |
| `OPTION_MISSING` | **0** | **1** |
| claims published | **0** | **1** |

Eight option-set cases examined on the clean twin, all silent. Same machinery accused once on the flawed twin,
correctly. **This is the first true positive with a matched negative control the project has produced.**

---

## The full fleet, honestly

```
12 targets · FABRICATIONS: 0 · claims: 1 · seeded missed: 17
coverage gaps: 11 · predicate gaps: 0 · reuse fired: 11 · cost $0.0442
```

**Zero fabrications across six clean variants.** The cardinal-failure gate held.

**17 of 18 seeded defects missed — and the reason is REACH, not judgement.**

| target | screens reached | option-set outcome |
|---|---|---|
| s4-nested-rotation | 10 of 12 | 8 × as-documented |
| **s4-nested-rotation-flawed** | 9,2,10 of 12 | **1 × OPTION_MISSING**, 2 × as-documented |
| s1-skip / -flawed | 9 of 10 | 1 × as-documented; flawed: 6 × `TARGET_QUESTION_NEVER_BOUND_IN_WALK` |
| s2-screener | 4 of 6 | 6 × as-documented |
| s2-screener-flawed | 5 of **13** | 4 × as-documented |
| s3-multiselect / -flawed | 9 of 14 / 10 of 11 | 1 × as-documented each |
| s5-allocation | **0 of 4** | none — constant-sum rule, walker cannot satisfy |
| s6-kitchen-sink / -flawed | 5 of **19** | none |

**`predicate gaps: 0`.** Nowhere did the system reach a defect, examine it, and fail to decide. Every miss is a
screen the walker never arrived at, or a question it could not identify.

---

## WHAT THIS CHANGES FOR THE SPRINT — read carefully

**1. The checker is not the open question any more.** It works on the class it was built for, on a survey nobody
tuned it against, with a silent control. Extraction was already going to be removed as an alibi by the frozen
contract. That leaves reach.

**2. REACH IS NOW THE BINDING CONSTRAINT.** The system reaches roughly half of most surveys. A 16-of-20
detection target measured against a walker that arrives at maybe half the planted defects **measures the walker,
not the checker** — which is the same category error that produced the earlier "0 of 3".

**Recommendation, and it is a change to the plan as written:** treat reach as a *precondition*, not a later
phase. Before a defect counts as planted, prove the walker reaches its screen — locally, free, via
`worker-v2/tools/live-walk.mjs`. Any defect behind an unreachable screen is excluded from the 20 and recorded as
an out-of-scope reach limitation. Otherwise the sprint's number is not about the checker.

**3. Two known reach blockers, both measured, both unfixed:**
- **Radio `first-option` default picks position 1 — an extreme — and extremes are where surveys terminate.**
  On s2's industry question position 1 is the disqualifying answer. This is the single largest cause of a walk
  ending on an answer the harness invented. *Not fixable by choosing another index; the least-restrictive option
  is not positional.* Planner work.
- **Constant-sum allocation questions cannot be satisfied** (s5 = 0 of 4 screens, s6-Q6). A real survey rule,
  deliberately not defeated.

**4. The Q2/Q3 identity tie is real but narrower than feared.** It blocked `s1-skip` specifically
(6 × `TARGET_QUESTION_NEVER_BOUND_IN_WALK`). It did NOT block s4, where the predicate worked. So it is a corpus
constraint — avoid near-identical question wording — not a systemic blocker. See `01-THE-EXPERIMENT.md`.

---

## Correction to the record

An earlier decision memo led with **"the decisive test failed"**, based on `s1-skip-flawed` finding 0 of 3
before the rest of the fleet had landed. **That framing was premature.** s1-skip failed for an identity-tie
reason, and s4 — the very next comparable target — succeeded. Both facts are above; treat this file as
authoritative over any earlier summary.

## Still true, and unchanged by this result

- Extraction is nondeterministic: 15–51% different requirement counts on re-read; only ~1/3 of requirements
  stably identifiable run-to-run. **Coverage remains an unsupportable product claim.** A found defect is real
  regardless of denominator.
- ~90% of checks still return `NO_TYPED_EXPECTATION` — only three predicates exist.
- One claim across twelve targets is not a working product. It is proof the mechanism works, on one class.
