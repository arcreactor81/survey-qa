# The experiment

## Design

**One variable.** Today a miss has three possible causes: the browser never reached the screen, the LLM
extracted the wrong requirements, or the checker looked and got it wrong. A hand-authored contract removes the
middle one, so a miss is unambiguously reach-or-judgement — and the run already separates those two.

```
hand-written requirements  →  seal (UNCHANGED)  →  plan → walk → verify → report  (ALL UNCHANGED)
```

Everything downstream of the seal is production code. That is the point: the experiment must exercise the real
verdict path, not a test harness that resembles it.

## Thresholds — pre-committed

| | threshold |
|---|---|
| Detection | **≥ 16 of 20** planted defects |
| False positives | **0 of 10** matched clean controls |
| Insufficient | **≤ 4 of 20** supported checks |

Miss any → **KILL**. A catch is **strict**: the claim must name the right requirement AND the right defect type.

## Defects go ONLY in the three implemented classes

| class | predicate | what a defect looks like |
|---|---|---|
| **route** | `route-destination/1.0.0` | document says answer X skips to Q9; site goes to Q8 |
| **boundary** | `boundary-outcome/1.0.0` | document says max 500 chars; site accepts 501 |
| **option-set** | `option-set-offered/1.0.0` | document lists 5 options; site offers 4 |

Anything else measures nothing — there is no rule to decide it.

---

# READ THIS BEFORE DESIGNING THE CORPUS — the 0/3 has been decomposed

`s1-skip-flawed` found 0 of 3 planted defects. That was the trigger for this sprint. **We now know why, and it
is not the predicate.**

**The predicate works on the real bytes.** Driving both s1-skip variants locally through the production walker:
clean Q3 offers 5 options including `5=BIMZELX`; flawed offers 4, no BIMZELX. **The seeded defect is plainly
visible in the capture.** Running the real expander and the real verdict function over those captured bytes
minted 5 typed option-set cases correctly, and correctly refused a survey-scoped row.

**What blocked it is the shared screen-identity margin.** On s1-skip, **Q2 and Q3 are worded so similarly** that
the document's wording scores highly for BOTH against the Q3 screen, and the calibrated 1.25× separation margin
does not split them. So the screen resolves to `{Q3, Q2}` — two sealed ids — and the "exactly one sealed id"
rule refuses, correctly, by design.

Measured across four plausible forms of the sealed question wording:

| wording form | Q3 | Q2 | ratio | separates? |
|---|---|---|---|---|
| manifest text | 0.9697 | 0.8276 | 1.172 | no |
| `"Q3. " + text` | 1.0000 | 0.8000 | **1.25 − 2.2e-16** | no, by one ulp |
| `+ instruction` (flawed) | 0.8947 | 0.8000 | 1.118 | no |
| text + instruction (clean) | — | — | 1.172 | no |

Three of four are **genuinely** below the margin; the fourth fails by one floating-point unit. This is not
merely a float bug.

**Consequences you must design around:**

1. **This is a fail-CLOSED refusal, not a wrong answer.** The system declined to decide rather than guessing —
   which is the behaviour the product is built for. But it means s1-skip cannot currently produce ANY verdict on
   Q2/Q3, including its route and boundary cases.
2. **Do not plant defects on questions whose wording closely resembles a neighbour's**, unless you are
   deliberately testing this margin. Otherwise you will measure the identity seam, not the predicate.
3. **Distinct question wording is a corpus requirement.** Note the tension honestly: making wording distinct to
   let the system succeed is one step from teaching to the test. The defensible line is that real questionnaires
   do not usually contain two near-identical questions; s1-skip does because it was generated.
4. **The margin constant is mirrored in two files** (`src/browser/driver.ts`, `verify-observations.ts`) and a
   cross-module test pins their agreement. Changing it is a two-sided change; do not do it unilaterally
   mid-sprint — it would alter the thing being measured.

**Owner's open choice on s1-skip specifically:** (a) a coordinated two-sided tolerance fix restoring the stated
calibration, (b) run it and read the counted refusals as the honest result, or (c) regenerate that survey with
more distinct wording. Not yet decided.

---

## What "insufficient" means, and why the ≤4 threshold is the subtle one

`insufficient` is the system declining to decide. It is CORRECT behaviour and the reason the product has any
value — but a system that returns it everywhere is useless. Every refusal carries a named, counted reason. The
ones you will see most:

| reason | means |
|---|---|
| `NO_TYPED_EXPECTATION` | no predicate for this requirement's kind — expected outside the 3 classes |
| `TARGET_QUESTION_NEVER_BOUND_IN_WALK` | the walker never identified that question's screen (the s1-skip tie) |
| `OPTION_INVENTORY_NOT_CAPTURED` | the screen's option list was not captured |
| `PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE` | the walk did not finish, so "X is absent" is unsupportable |
| `OPTION_LABEL_NEAR_MATCH_ONLY` | labels are similar but not equal — withholds rather than accuses |
| `DESTINATION_AMBIGUOUS` | more than one sealed id on the destination screen |

**A defect that lands on `insufficient` counts against the ≤4 threshold**, and that is deliberate: for the 20
planted defects the system is *supposed* to be able to decide, refusing is a failure of the product's purpose
even though it is not a wrong answer.

## Deliverable

A confusion matrix GPT explicitly noted it could not obtain: **per predicate class**, how many planted defects
were caught, missed-because-unreached, missed-because-undecidable, and missed-while-decided (the worst cell — a
false pass). Plus the false-positive count on the 10 clean controls.
