# Ablation report — survey-qa architecture

**Template committed before the first condition ran.** Numbers are dropped into these tables;
they are not narrated into a story. If a slot cannot be filled, write **"not measured"** —
never leave it blank and never delete the row, because a deleted row is the most effective
way to hide an inconvenient result.

**Do not add a section.** If something important has no slot here, that is itself worth
saying: add it under §11 *Unanticipated*, flagged as post-hoc, and say plainly that it was
not pre-registered.

---

## 0. Provenance

| | |
|---|---|
| Scorecard | _scorecardVersion_ · matcher _matcherVersion_ · vocab _vocabVersion_ |
| Corpus | _corpusId_ · _n_ surveys · _n_ defects · _n_ ambiguities · _n_ clean controls |
| Condition pins | A _sha_ · B _sha_ · C _sha_ · C-R _sha_ |
| Harness frozen at | _FREEZE.json frozenAt_ |
| Amendments after freeze | _none / every one, with its written reason_ |
| Self-tests | _n_ / _n_ passed |
| Mutation kill rate | _n_ / _n_ = _x_% · **surviving mutants:** _names, or none_ |
| Key annotations | _n_ of _n_ defects (_x_%) · hash _annotationsHash_ · any authored after first result: _yes/no_ |
| Pilot data included | **must be No.** _Yes → this is not a result (§9.4)_ |

---

## 1. READ THIS BEFORE THE NUMBERS

### 1.1 Is this a result at all?

| Gate | Status |
|---|---|
| All conditions cleared comparable maturity (§9.3) | _yes / **no → this is a PILOT and nothing below is comparable**_ |
| Shared document ingestion across conditions (§8.1) | _yes / **no → primary comparison restricted to body-sourced defects, see §9.1**_ |
| Any run invalidated (attribution / leak / schema) | _none / list_ |
| Inconclusive conditions triggered (§6.8) | _none / list codes_ |

### 1.2 Adjudication queue — how soft are these numbers

| | |
|---|---|
| Queue size | _n_ |
| Adjudication rate | _x_% of all findings |
| Verdict | _small → the matching rule held / **LARGE → the matching rule is weak here and every number below is soft**_ |
| By code | LOCATION_WAIVED _n_ · LOCATOR_UNRESOLVED _n_ · MULTI_CANDIDATE _n_ · UNDER_SPLIT _n_ · PREDICATE_UNANNOTATED _n_ · TAXONOMY_GAP _n_ · SUSPECTED_CORPUS_DEFECT _n_ |
| Resolved with a written reason **before** aggregates were computed | _n_ / _n_ |

### 1.3 recall_strict vs recall_lenient

| Condition | strict | lenient | delta (defects) | matching-sensitive? |
|---|---|---|---|---|
| A | | | | |
| B | | | | |
| C | | | | |
| C-R (mean) | | | | |

If the delta reaches the decision margin for any condition, the strict/lenient choice is
deciding the outcome and the affected comparisons are `INCONCLUSIVE — MATCHING-SENSITIVE`
(§4.1). _state it_

---

## 2. THE FOUR PRE-COMMITTED COMPARISONS

Primary metric `recall_strict`. Paired exact McNemar, Holm-adjusted across all four. A
difference requires **adjusted p ≤ 0.05 AND b − c ≥ 5** (§6.4). Thresholds in Appendix A.

| ID | Comparison | Question | b | c | p | p (Holm) | margin met | swing: favour X / favour Y | **DECISION** |
|---|---|---|---|---|---|---|---|---|---|
| **H1** | C vs A | what does the **graph** add | | | | | | / | |
| **H2** | C vs B | what does the **model** add | | | | | | / | |
| **H3** | C vs best single | is the **hybrid** better than its best half | | | | | | / | |
| **H4** | C vs C-R | is **principled traversal** doing the work | | | | | | / | |

**Any comparison whose swing bounds disagree is `INCONCLUSIVE — QUEUE-DOMINATED`, and its
point estimate is NOT the result** (§7.3). Point estimates for such rows, labelled as
not-the-finding: _list_

### 2.1 H4 in full — the control that could embarrass us

| | C | C-R seed 1 | seed 2 | seed 3 | C-R mean | C-R range |
|---|---|---|---|---|---|---|
| recall_strict | | | | | | |
| node-visits | | | | | | — |
| visit-ratio to C (must be 0.9–1.1) | 1.00 | | | | — | — |
| surveys excluded for ratio drift | _none / list_ | | | | | |

Does C's score fall **inside** C-R's observed range? _yes → no conclusion is reported / no_

> **If H4 did not clear the margin, write this sentence and do not soften it:**
>
> *"The graph's central claim — that principled, computed traversal beats covering the same
> amount of ground arbitrarily — is DECORATIVE on this corpus."*
>
> The graph may still earn its place on coverage **accounting** (coverage_honesty,
> never_visited). Those are different claims and are reported separately in §5.

_state it_

---

## 3. SAFETY — false positives on clean controls

The headline safety number, and **the least well-powered number in the study**: measured on
_n_ surveys. A difference between conditions requires a gap of **at least 2** (§4.3).

| Condition | clean-control FPs | clean controls with zero FPs | observation volume | HEDGING | FP by attribution (graph / model / seam) |
|---|---|---|---|---|---|
| A | | | | | |
| B | | | | | |
| C | | | | | |
| C-R | | | | | |

| | |
|---|---|
| FP_AMPLIFICATION — is FP(C) greater than FP(A) + FP(B)? | _no / **YES → the hybrid amplifies rather than filters; reportable design failure**_ |
| Quarantined as SUSPECTED_CORPUS_DEFECT (§10.4) | _n_ of a cap of 3 — _loci_ |
| Is any FP gap at least 2? | _no → the conditions are indistinguishable on safety / yes: which pair_ |

_state it_

---

## 4. AMBIGUITY — guessing is a failure even when the guess is right

| Condition | correct (surfaced) | **guessed** | missed (silent) | ambiguity precision | AMBIGUITY_SHIELD |
|---|---|---|---|---|---|
| A | | | | | |
| B | | | | | |
| C | | | | | |
| C-R | | | | | |

Of the _n_ guesses, _n_ happened to match what the site does. **They are scored as failures**
(§4.4). _state it_

AMBIGUITY_SHIELD counts are ambiguity assertions at loci carrying a real planted defect:
shrugging at a findable defect is not caution, and those defects are scored as missed.

---

## 5. COVERAGE HONESTY — claimed vs actual

| Condition | claimed exercised | witnessed by harness | **unwitnessed** | coverage_honesty | coverage figure | defect-locus coverage |
|---|---|---|---|---|---|---|
| A | | | | | | |
| B | | | | | | |
| C | | | | | | |
| C-R | | | | | | |

Any condition below 1.0 prints as `UNWITNESSED-n` and **cannot pass a coverage gate**.

### 5.1 Miss decomposition — "didn't look" versus "looked and didn't see"

The most diagnostic split available, and the one that says where to put engineering effort.

| Condition | missed total | never visited (coverage failure) | visited but missed (judgement failure) | locus unknown |
|---|---|---|---|---|
| A | | | | |
| B | | | | |
| C | | | | |
| C-R | | | | |

_A graph that helps should show up as fewer never-visited misses; a model that helps as fewer
visited-but-missed. If it does not, say so._

---

## 6. THE SEAM — per-requirement-class attribution (PRIMARY OUTPUT)

**No percentages on rows where `planted` is under 5.** A percentage over two items is a lie
with a decimal point. Rows are printed as raw integers.

| requirement class | planted | predicted owner | A | B | C | C: graph | C: model | C: seam | delta graph (C−A) | delta model (C−B) | never visited | visited but missed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| routing | | graph | | | | | | | | | | |
| terminate | | graph | | | | | | | | | | |
| base-filter | | graph | | | | | | | | | | |
| question-presence-order | | graph | | | | | | | | | | |
| quotas | | graph | | | | | | | | | | |
| wording | | model | | | | | | | | | | |
| option-list | | model | | | | | | | | | | |
| option-order | | model | | | | | | | | | | |
| scale-labels | | model | | | | | | | | | | |
| randomisation-anchors | | model | | | | | | | | | | |
| exclusive-options | | model | | | | | | | | | | |
| validation | | model | | | | | | | | | | |
| progress-bar | | model | | | | | | | | | | |
| piping | | model | | | | | | | | | | |
| carry-forward | | model | | | | | | | | | | |
| back-navigation-state | | model | | | | | | | | | | |

| | |
|---|---|
| Classes where the **predicted owner did not outperform** the other component | _list — each is a finding about the architecture_ |
| graph-located-model-judged total for C | _n_ — _if 0 → **the hybrid is not hybridising**_ |
| unattributed findings | _n_ — _high → the seam measurement is soft and this table is correspondingly weak_ |
| TAXONOMY_GAP findings | _n_ — _at 20% or more → the 16-class vocabulary does not fit this corpus_ |

**Where to put engineering effort next, read off this table:** _state it_

---

## 7. HYBRID REGRESSION — the check that is hostile to the expected winner

`regression_set` = defects found by A or B that C did not find.

| | |
|---|---|
| Size | _n_ |
| Defects | _list_ |
| Verdict | _empty/trivial / **3 or more → a design defect in C, reported regardless of what recall did**_ |

_A hybrid that wins on totals while dropping three things its graph already knew has a seam
bug, and the totals hide it._

---

## 8. COST

Never blended into quality. B has close to zero model calls by construction; a blended score
would hand it the experiment for free.

| Condition | model calls | tokens in / out | browser sessions | node visits | wall clock | USD | **cost per defect** | partial runs |
|---|---|---|---|---|---|---|---|---|
| A | | | | | | | | |
| B | | | | | | | | |
| C | | | | | | | | |
| C-R (3 seeds) | | | | | | | | |

`cost_per_defect` is **null** — not 0 and not infinity — where nothing was found. Cost is
null where no pinned price covers the model; never estimated. Complete and partial cohorts
are reported separately: _state it_

---

## 9. THREATS TO VALIDITY — pre-registered, restated with what actually happened

| Threat | Pre-registered in | What happened |
|---|---|---|
| Small sample (~12 surveys, ~_n_ defects) | §10.1 | |
| Clean-control denominator is 3 surveys | §10.2 | |
| Corpus built by one process — biased toward defects it found natural to plant | §10.3 | |
| Exotic docx-part requirements → measures **parsers**, not architectures | §10.3, §8.1 | _shared ingestion held / **did not** — see §9.1_ |
| Clean controls may contain accidental defects | §10.4 | _exclusions n, quarantines n_ |
| The arms' authors are not independent of the system under test | §10.5 | _unmitigated — audit trail only_ |
| Tier-1 direction risk where annotations are absent | §10.6 | _annotation coverage x%_ |
| attribution is self-reported; the seam table is as honest as the arms are | §10.6 | |
| Maturity mismatch — an underbuilt graph half understates the HYBRID | §9.2 | |

### 9.1 Stratification by requirement source

Required whenever shared ingestion did not hold; informative regardless.

| source | planted | A | B | C | C-R |
|---|---|---|---|---|---|
| body | | | | | |
| footnote | | | | | |
| header | | | | | |
| comment | | | | | |
| auto-numbering | | | | | |
| table | | | | | |
| dropdown | | | | | |
| image-alt | | | | | |

_If the conditions diverge sharply here and not on body-sourced defects, this experiment
measured document parsing._

---

## 10. CONCLUSIONS

Fill exactly one box per question. **If the evidence does not clear the margin, tick
inconclusive** — §6.8 pre-commits that we do not narrate a winner out of a non-significant
gap.

| Question | Yes | No | Inconclusive | Evidence |
|---|---|---|---|---|
| Does the **graph** contribute? | ☐ | ☐ | ☐ | H1, structural-class concentration, never-visited misses |
| Does the **model** contribute? | ☐ | ☐ | ☐ | H2, attribute-class concentration, seam bucket |
| Is the **hybrid** the right destination? | ☐ | ☐ | ☐ | H3, regression set, coverage honesty, clean-control FP |
| Is **principled traversal** real, or decorative? | ☐ | ☐ | ☐ | H4, C versus C-R range |

**If inconclusive:** the experiment did not decide. Per §6.8 the architecture choice reverts
to the owner on non-empirical grounds — maintainability, cost predictability, auditability.
State that plainly and stop: _state it_

**What this document does NOT establish:** _at minimum: nothing about vendors outside this
corpus, nothing about maintainability, and nothing about any component whose condition did
not clear maturity._

---

## 11. Unanticipated

Anything material that had no slot above. Everything here is **post-hoc and was not
pre-registered**; label it so.

_none / list_

---

## Appendix A — decision thresholds actually applied

Minimum `b` to declare a difference, with the absolute floor `b − c ≥ 5` applied:

| c | alpha 0.05 | alpha 0.025 | alpha 0.0167 | alpha 0.0125 |
|---|---|---|---|---|
| 0 | 6 | 7 | 7 | 8 |
| 1 | 8 | 9 | 10 | 10 |
| 2 | 10 | 11 | 12 | 13 |
| 3 | 12 | 13 | 14 | 15 |

Holm step applied to each comparison: H1 _alpha_, H2 _alpha_, H3 _alpha_, H4 _alpha_.

## Appendix B — surviving mutants

Gates the self-test suite does not enforce, named rather than averaged away — the same
disclosure `scorer/docs/threat-model.md` §11 makes about the existing scorer, made here in
advance rather than after an audit.

_none / list_
