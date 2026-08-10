# The Structured-Claim Contract

**Status:** Tier-1 design draft, 1 Aug 2026. Not implemented. For convergence between the coordinator and a peer model before any code lands.
**Replaces:** lexical expected/observed similarity as the way the scorer decides whether a reported defect is real (`scorer/src/lib/defect-match.mjs`).
**Binding ruling this design obeys:** *the survey document is the source of truth.* Any divergence between document and live survey is a site defect. "The spec is wrong" is not a finding class. Document ambiguity is a reporting category, not a judgement.
**Audit inputs:** `docs/p0-adversarial-audit.md` §1, §2 Findings 1/2/4/7/10, §3 Theme 1, §7, §8.

---

## 0. The one-line summary

A reported defect stops being two sentences and becomes a **typed fact with a document side and a site side**. The document side is free to state — the tester is given the document. The site side must be *earned*: it is drawn from a closed value domain, it must be bound to an integrity-valid artifact, and where that artifact is text the scorer mechanically checks the claim against the artifact's bytes. Matching is a conjunction of exact agreements on identity fields, not a similarity score. Prose survives, unscored, for humans.

> **The principle the whole design hangs on: document-side fields are free; site-side fields must be earned.**
>
> Knowing the questionnaire is not cheating — the tester is handed it. Knowing what the *site did* is the thing the apparatus exists to measure, and it is exactly the thing lexical matching failed to require.

---

## 1. Why nothing lexical can be repaired

The audit and the subsequent real-model run agree, and the real run is the harder evidence because it is observed rather than reasoned.

A real model (`@cf/openai/gpt-oss-120b` on Workers AI at high reasoning effort — **not** DeepSeek V4 Pro, which was unreachable; this substitution is recorded and the caveat is that a *stronger* model writing longer prose scores *worse*, not better) drove the `s1-skip` flawed target, found all three seeded defects, and reported zero false positives. Scored through the real CLI against the real `s1-skip.flawed` oracle:

| Claimant | S1-E02 score | Outcome |
|---|---|---|
| Agent that never opened a browser, restating the spec | **1.000** | credited |
| Inverted, factually false claim ("BIMZELX **is present**…") | **0.808** | credited |
| Content-free boilerplate ("Q3: Option 5" / "Q3 option list on the site.") | **0.525** | credited |
| The real model, accurate and specific, having actually driven the survey | **0.220** | gated out below `minSideSimilarity` |

End to end: `seededDefectRecall 0.0`, `seededDefectPrecision 0.0`, all three correct findings classified `falsePositives`, all three seeded defects `falseNegatives` — on a run with integrity VALID, nine gates passed, evidence completeness 1.0. The honest tester is recorded as a total fabricator.

The ranking is **inverted, not miscalibrated**. Boilerplate sits above honest prose, so no cut point admits one and excludes the other. Lowering the bar admits boilerplate first. Two further facts from the same run make the point structural rather than statistical:

- The inverted claim scores *higher* than the honest one because negation is one token in a twelve-token sentence, and token overlap has no notion of polarity that survives a 0.5/0.5 blend.
- The model's *anchors* were near-perfect (locatorSim 1.000, quoteSim 0.933–0.957) and bought nothing, because anchor weight 0.45 < eligibility bar 0.55 — location can never qualify alone (Finding 2b).

There is no version of "compare two sentences" that fixes this. The contract has to change.

---

## 2. Design principles, and where they come from

Six of these are lifted directly from the owner's own shipped prior art, `pa-policy-extractor` — a system that solved the same shape of problem (a structured profile extracted from a document, cross-checked against a live web page) and shipped.

| # | Principle | Prior art |
|---|---|---|
| P1 | **Enumerate the finding space up front.** A claim is a value in a named slot, not a free description. An extractor could not invent a 13th parameter; a tester cannot invent a 15th defect kind. | `pa_workflow.js` FIELDS — 12 named parameters, closed domains |
| P2 | **Typed verdict always ships beside free prose, and only the typed field is graded.** `step_therapy_text` was 1500 chars of verbatim policy; `steps_brands` was the integer that got scored. | `pa_workflow.js`; README |
| P3 | **Absence has several distinct values and collapsing them is an error.** NA (silent) ≠ No (explicitly none) ≠ Unspecified (exists, no value) ≠ abstain (I may have missed it). | `CLAUDE.md` critical rules; `overrides.py` `ABSTAIN_REASON`; golden test `test_step_absent_data_becomes_na_not_no` |
| P4 | **Provenance is a machine-verified verbatim substring produced by a separate pass; paraphrase = deletion.** `found=true` with no surviving quote is downgraded to `found=false`. | `container/pipeline/explain.py`; `src/web-check.ts` `verifyQuote` |
| P5 | **Ambiguity is a third verdict, tallied separately, never a forced tie-break.** `winner: ['v22','audited','either_convention']`, scored at half weight under its own heading. | `pa_v22review.js`; `synth_v22.py` |
| P6 | **Normalize aggressively upstream so comparison downstream is trivial equality — and pin the normalizer with golden tests.** The comparator was `a.strip().lower() == b.strip().lower()`; all the mess lived in one tested function. | `ref_crosscheck.py`; `test_validate_and_normalize.py` |
| P7 | **Mechanical falsifiers.** A regex sweep over the source refutes a whole class of claims for free, with no model in the loop. | `tb_recheck.txt` → `tb_na_list.json` |

Two further principles are ours, forced by the ruling:

- **P8 — the site is never an authority.** `pa-policy-extractor`'s `web-check.ts` kept a `status: "updated"` value meaning "the live page appears newer than our extraction". Under doc-is-truth that value is incoherent and is deleted. The rest of that enum — `confirmed` / `discrepancy` / `not_found` — survives, with `discrepancy` renamed to what it now is: a site defect.
- **P9 — the pa project's own worst mistake is the one to avoid.** Its single external authority (the FDA label) became its largest identified risk ("TREMFYA age-6 is the dominant gold risk"). The moment scoring depends on a second authority you inherit its versioning and arbitration problems. The owner's ruling deletes that failure mode by fiat. Do not reintroduce it: no "the site is probably right because it's newer", no external survey-design norms, no LLM prior about what a question *should* say.

---

## 3. The claim envelope

Every claim, of every kind, is one object with the same outer shape. Only `claim.locus`, `claim.documentSays` and `claim.siteShows` vary by kind.

```jsonc
{
  "claimId": "F-1",
  "kind": "option-missing",              // closed enum, §4
  "locus": { "questionId": "Q3", "optionCode": 5 },   // typed address, kind-specific
  "documentSays": { "optionCode": 5, "optionLabel": "BIMZELX" },
  "siteShows":    { "presentOnSite": false, "optionCodesShown": [1,2,3,4],
                    "optionLabelsObserved": ["SKYRIZI","TREMFYA","COSENTYX","TALTZ"] },

  "docEvidence":  { "locator": "Q3, option 5", "quote": "5. BIMZELX" },   // verbatim, verified
  "witness": [                                                            // per-FIELD site provenance
    { "field": "siteShows.optionLabelsObserved", "evidenceId": "ev-dom-q3",
      "excerpt": "SKYRIZI … TREMFYA … COSENTYX … TALTZ" }
  ],

  "itemRefs": ["I-07"], "attemptRefs": ["a-3"],   // coverage attribution, NOT match preconditions (§9, fork 1)
  "severity": "high", "confidence": 0.9,          // FREE — no matching weight
  "prose": {                                      // FREE — no matching weight, human report only
    "summary": "Q3 omits the fifth documented biologic.",
    "expected": "Q3 should offer BIMZELX as the fifth brand option.",
    "observed": "Q3 rendered only four brands; BIMZELX is absent."
  }
}
```

Three field roles, and they are the whole grammar:

| Role | Rule | Effect on matching |
|---|---|---|
| **IDENTITY** | Must agree with the oracle **exactly after canonical normalization**. Drawn only from closed domains: booleans, enums, integers, question/option/loop/row identifiers, or strings that must be verbatim substrings of the document. **No identity field may be free text.** | Any disagreement ⇒ **no match**. No partial credit. |
| **REQUIRED-OBSERVED** | Present per the kind's schema, and passes its mechanical predicate against the bound artifact (§6). | Absent or failing ⇒ claim is **`unsupported`**, never matched, and counts against precision. |
| **FREE** | Prose, severity, confidence, remediation. | **Zero weight. Ignored entirely.** |

`siteShows` fields are always either IDENTITY or REQUIRED-OBSERVED. That is what makes the site side unfakeable-by-writing.

### Absence and abstention (P3)

The site-observation vocabulary carries the pa ladder, adapted:

| Value | Meaning |
|---|---|
| `matches` | Site agrees with the document at this locus (a **`checked`** entry, §11, not a defect claim) |
| `differs` | Site shows something else — **a site defect** |
| `absent` | The document specifies it; the site does not show it at all — **a site defect** |
| `not-determinable` | The locus was reached but no value could be read (rendered but unparseable, dynamic, off-screen) — **not a defect, not a miss** |
| `not-reached` | The tester never got there — **apparatus/coverage fact, not a finding** |
| `document-silent` | The document says nothing here, so nothing is checkable — **never a defect** |
| `document-ambiguous` | The document admits two readings — **report both, judge nothing** (§8) |

`not-determinable`, `not-reached` and `document-silent` must be scored as **neither hit nor miss**, or the apparatus punishes honesty and rewards guessing. This is `pa-policy-extractor`'s abstain lesson in its exact form: an empty extraction is not evidence of an empty document.

---

## 4. The closed set of claim kinds

Fifteen defect kinds, one reporting kind, one escape hatch. The registry is **public and versioned**; a kind the corpus needs but the registry lacks is a *corpus-design bug to fix*, not agent error (§13 residual, §14 fork 6).

Notation: **I** = identity, **RO** = required-observed (the execution witness), **C** = corroborating (required present, non-blocking on agreement), **F** = free.

### 4.1 `option-missing` — seeded: S1-E02, S4-E03

| Field | Role | Notes |
|---|---|---|
| `locus.questionId` | I | question id |
| `locus.optionCode` | I | integer (required when the document numbers options) |
| `documentSays.optionLabel` | I | string, must be a verbatim doc substring |
| `siteShows.presentOnSite` | I | `false` |
| `siteShows.optionCodesShown` | RO | integer[] — the codes actually rendered |
| `siteShows.optionLabelsObserved` | RO | string[] — the labels actually rendered |

**Matches when:** kind, `questionId`, `optionCode`, normalized `optionLabel`, and `presentOnSite === false` all agree with the oracle's typed fact, **and** `optionLabelsObserved` is non-empty, does **not** contain the claimed label, and is consistent with the bound text artifact.

### 4.2 `option-extra` — not currently seeded (corpus gap, §14 fork 10)

Mirror of 4.1: `siteShows.presentOnSite = true`, `documentSays.documented = false`. `optionLabelsObserved` must *contain* the claimed label.

### 4.3 `option-label-wrong` — not currently seeded

| Field | Role | Notes |
|---|---|---|
| `locus.questionId`, `locus.optionCode` | I | |
| `documentSays.optionLabel` | I | verbatim doc substring |
| `siteShows.optionLabel` | I | must differ from `documentSays` after normalization |
| `siteShows.optionLabelsObserved` | RO | the labels actually rendered |

### 4.4 `skip-target-wrong` — seeded: S1-E01, S4-E01

| Field | Role | Notes |
|---|---|---|
| `locus.fromQuestionId` | I | `"Q2"` |
| `locus.ruleIndex` | C | integer (document rule ordinal) |
| `documentSays.condition` | I | `{questionId, op, value}` — normalized operator vocabulary |
| `documentSays.gotoQuestionId` | I | `"Q5"` |
| `siteShows.nextQuestionId` | I | `"Q6"` — **the screen actually reached** |
| `siteShows.answerVectorPrefix` | RO | the answers given to get there |
| `siteShows.observedSequence` | RO | `["Q2","Q6"]` |

**Matches when:** kind, `fromQuestionId`, normalized `condition`, `documentSays.gotoQuestionId` **and** `siteShows.nextQuestionId` all agree. Both target IDs are identity — that is what makes a guessed claim fail: you can name the documented target from the docx, but naming the *actual* successor requires having answered Q2 = No and looked.

### 4.5 `terminate-not-enforced` — seeded: S2-E01, S6-E02

| Field | Role | Notes |
|---|---|---|
| `locus.atQuestionId` | I | |
| `documentSays.condition` | I | `{questionId, op, value}` (e.g. `op:"ne"` for TERMINATE IF S3 IS NOT 4) |
| `documentSays.outcome` | I | `"terminate"`, with `terminalId` when the document names one |
| `siteShows.terminated` | I | `false` |
| `siteShows.continuedToQuestionId` | RO | the question actually reached instead |
| `siteShows.answerVectorPrefix` | RO | the answers given to get there |

### 4.6 `condition-boundary-wrong` — seeded: S2-E02 (threshold value), S2-E03 (operator), S5-E02 (threshold value)

One kind covering both threshold-value and comparison-operator errors; `discriminator` is derived, not claimed. *(Recommended; see §14 fork 3 for the two-kind alternative.)*

| Field | Role | Notes |
|---|---|---|
| `locus.atQuestionId`, `locus.ruleIndex` | I | |
| `documentSays.op`, `documentSays.value` | I | normalized operator vocabulary: `eq ne ge le gt lt` |
| `siteShows.op`, `siteShows.value` | I | as the site actually behaves |
| `siteShows.probes` | RO | `[{value, outcome}]` — at least one probe **inside the documented-fail / site-pass gap** |

The `probes` requirement is the strongest single anti-boilerplate device in the taxonomy. To claim "the site terminates at <16 but the document says <18" you must submit a probe at 16 or 17 and record that the site continued. That value is not derivable from the document.

### 4.7 `validation-not-enforced` — seeded: S5-E01 (allocation total), S5-E03 (row cap)

| Field | Role | Notes |
|---|---|---|
| `locus.questionId`, `locus.rowId?` | I | `rowId` required for grid/allocation rows |
| `documentSays.constraintType` | I | enum: `range-min` `range-max` `integer` `required` `allocation-total` `allocation-row-max` `format` |
| `documentSays.constraintValue` | I | number or string |
| `siteShows.probeValue` | I | the value actually submitted (must violate the documented constraint — checked arithmetically) |
| `siteShows.outcome` | I | enum: `accepted`, `rejected`, `rejected-with-message` |
| `siteShows.nextStateReached` | RO | the screen reached after the offending submit |

### 4.8 `piping-unresolved` — seeded: S3-E01

| Field | Role | Notes |
|---|---|---|
| `locus.questionId` | I | |
| `documentSays.pipeSourceQuestionId` | I | |
| `siteShows.resolved` | I | `false` |
| `siteShows.renderedToken` | I | the literal unresolved token, e.g. `"{Q2drug}"` |
| `siteShows.renderedQuestionText` | RO | verbatim rendered text, artifact-checked |
| `siteShows.sourceAnswerGiven` | RO | what was actually chosen at the source question |

### 4.9 `carry-forward-wrong` — seeded: S3-E02

| Field | Role | Notes |
|---|---|---|
| `locus.targetQuestionId` | I | |
| `documentSays.sourceQuestionId` | I | |
| `documentSays.exclusions` | C | e.g. `["none-of-the-above"]` |
| `siteShows.sourceAnswerCodes` | RO | what was actually selected at the source |
| `siteShows.optionCodesShown` | RO | what the target actually offered |
| `siteShows.divergence` | I | derived enum: `superset`, `subset`, `disjoint`, `unfiltered` |

The mismatch is **set arithmetic**, recomputed by the scorer from the two RO arrays. The agent cannot assert the divergence without supplying both sets, and the scorer recomputes `divergence` rather than trusting it.

### 4.10 `calculation-wrong` — seeded: S6-E03 (wrong source ref)

| Field | Role | Notes |
|---|---|---|
| `locus.computedId` | I | `"accessWeight"` |
| `documentSays.sourceRefs` | I | `["Q6.r5"]` |
| `documentSays.expression` | C | normalized formula string |
| `siteShows.inputVector` | RO | the answers supplied |
| `siteShows.observedValue` \ | `siteShows.observedRoutingOutcome` | RO (one required) the value read, or the routing decision the value drove |
| `siteShows.predictedValue` | RO | what the documented formula predicts for that input vector — recomputed by the scorer |

**Observability caveat.** S6-E03 changes a computed value's source reference. If that value is never rendered and never drives an observable routing decision, **no honest tester can witness it** and it should not be a scoreable defect. An observability audit of all 18 seeded defects is required before this taxonomy ships (§14 fork 9).

### 4.11 `loop-truncated` — seeded: S6-E01

| Field | Role | Notes |
|---|---|---|
| `locus.loopId` | I | `"L1"` |
| `documentSays.iterationRule` | C | e.g. `"one per option selected at Q1, excluding NOTA"` |
| `siteShows.selectionMade` | RO | the multi-select answer that should drive N iterations |
| `documentSays.expectedIterations` | I | integer, recomputed by the scorer from `selectionMade` |
| `siteShows.observedIterations` | I | integer |
| `siteShows.iterationSubjects` | RO | string[] — what each iteration was about |

Integer inequality. `expectedIterations` is recomputed, so an agent cannot bend it to match.

### 4.12 `randomization-anchor-violation` — seeded: S4-E02

| Field | Role | Notes |
|---|---|---|
| `locus.questionId` | I | |
| `documentSays.anchorRule` | I | enum: `anchor-last`, `anchor-first` |
| `documentSays.anchorOptionCodes` | I | integer[] |
| `siteShows.observedOrders` | RO | `[[code,…], …]` — at least one full observed render order |
| `siteShows.anchorHeld` | I | `false` |

`anchorHeld` is **recomputed** by the scorer from `observedOrders`; a claim whose observed orders actually satisfy the anchor is self-refuting and is rejected as inconsistent, not merely unmatched.

### 4.13 `instruction-missing` — seeded: S1-E03

| Field | Role | Notes |
|---|---|---|
| `locus.questionId` | I | |
| `documentSays.instructionText` | I | verbatim doc substring |
| `siteShows.present` | I | `false` |
| `siteShows.instructionTextsObserved` | RO | string[] (may legitimately be empty) |
| `siteShows.screenTextExcerpt` | RO | normalized rendered screen text from a bound artifact |

Because an empty observation is legitimate here, the anti-boilerplate weight moves entirely onto `screenTextExcerpt`: the scorer verifies that the excerpt came from a bound artifact for that screen **and** that the documented instruction genuinely does not occur in it. This is P7 — a mechanical falsifier that needs no model and cannot be argued with.

### 4.14 `question-not-shown` / 4.15 `question-shown-unexpectedly` — not currently seeded

| Field | Role | Notes |
|---|---|---|
| `locus.questionId` | I | |
| `documentSays.shownWhen` | I | typed condition |
| `siteShows.answerVectorPrefix` | RO | the path taken |
| `siteShows.observedSequence` | RO | string[] of question ids actually rendered |
| `siteShows.wasShown` | I | boolean, **recomputed** from `observedSequence` |

Two kinds, one field set. `question-not-shown` requires `wasShown === false` with a `shownWhen` condition the path satisfied; `question-shown-unexpectedly` requires `wasShown === true` with a `shownWhen` condition the path did **not** satisfy. Because `wasShown` is recomputed from `observedSequence`, a claim whose own observed sequence contradicts its kind is self-refuting and is rejected as `inconsistent-witness`, not merely unmatched.

### 4.16 `order-violation` — not currently seeded; needed if Finding 15 is resolved "yes"

| Field | Role | Notes |
|---|---|---|
| `documentSays.expectedSequence` | I | contiguous question-id pair or full sequence |
| `siteShows.observedSequence` | RO | string[] |
| `siteShows.firstDivergenceIndex` | I | integer, **recomputed** |

### 4.17 `ambiguity` — reporting kind, judges nothing (§8)

| Field | Role | Notes |
|---|---|---|
| `locus` | I | any typed locus |
| `docEvidence.quote` | I | verbatim doc substring — the ambiguous text |
| `readings` | I | ≥2 entries, each `{readingId, interpretation:<typed partial claim in this same vocabulary>}` |
| `siteJudgement` | I | literal `"withheld"` |

No `siteShows`. An ambiguity claim asserts nothing about the site and earns no defect credit anywhere.

### 4.18 `other` — the taxonomy escape hatch

`{ locus, docEvidence, prose, taxonomyGapProposal }`. **Scores zero, always.** It is *tallied* as a corpus-health metric: a rising `other` rate means the taxonomy is underspecified and the fix is upstream, exactly as `pa_v22review.js`'s `either_convention` rate diagnosed the rubric rather than the agents (P5). See §14 fork 6 for whether it should also be exempt from the precision denominator.

---

## 5. The scoring rule

Matching is a **boolean conjunction**, not a similarity score:

```
match(claim, seededDefect) :=
      claim.kind == seededDefect.kind
   ∧  ∀ f ∈ IDENTITY(claim.kind):  norm(claim[f]) == norm(seededDefect.typedFact[f])
   ∧  ∀ f ∈ REQUIRED_OBSERVED(claim.kind):  present(claim[f]) ∧ predicate_f(claim, boundArtifacts)
```

Consequences, all of which are improvements on the current machinery:

1. **The identity tuple is a key.** Matching is a hash join, `O(n)`. The Hungarian assignment, the eligibility threshold, the `minSideSimilarity` gate and the ambiguity margin all disappear from the defect path. Every one of those was an untested calibration constant (Finding 11) and one of them (`matcher.mjs:372-387`, quadratic over unbounded agent strings) is the denial-of-scoring vector in Finding 6. The defect half of Finding 6 closes as a side effect.
2. **Duplicates are exact-key duplicates.** Two claims with the same `(kind, identity-tuple)` are a schema error, not a "redundancy" judgement. The current escape — reclassifying near-miss findings as redundant and *removing them from the precision denominator* (`defect-match.mjs:221`) — is deleted. Four mutually contradictory claims can no longer be treated as honest duplicates of each other.
3. **Corroboration is reported, never decisive.** Matched claims carry `corroboration: full | partial | none` over their C-fields. This is a diagnostic, not a threshold. It cannot move a claim across the match line in either direction.
4. **Precision is a real number again.** `precisionDenominator = asserted claims − exact-key duplicates`. Nothing else leaves it.

No score. No threshold. Nothing to tune, and therefore nothing to silently mis-tune.

---

## 6. Closing the inversion — structurally, not statistically

The inverted claim that scored 0.808 was the sentence *"BIMZELX is present in the Q3 option list on the site."* In the typed form that assertion is:

```json
"siteShows": { "presentOnSite": true }
```

The oracle holds `presentOnSite: false`. `true ≠ false`. There is no metric space in which `true` is near `false` — the domain is a two-element set with no topology, no token overlap, no edit distance. The match fails not because the inversion is unlikely to clear a bar; **there is no bar, and the inversion is not representable as a match.**

The generalization is the rule that governs the whole taxonomy:

> **Every observation field whose inversion is the failure mode must be typed into a closed domain — boolean, enum, integer, or an identifier — never into a string that can be negated.**

Where an identity field must carry a string (`optionLabel`, `instructionText`), the domain is closed a second way: the string must be a **verbatim substring of the document** (P4). "BIMZELX" has no negation that is also a document substring. There is no `not-BIMZELX` to write.

Three inversion routes and their closure:

| Inversion route | Closed by |
|---|---|
| Negating the site observation ("is present" / "is absent") | Boolean/enum domain — §6 above |
| Swapping the two sides (claiming the doc says what the site does) | `documentSays` and `siteShows` are separate slots, both identity, both checked against separate oracle sides. Swapping fails both. |
| Inverting only the prose | Prose has zero weight (§7). Inverting it changes nothing, in either direction. |

And the case the audit explicitly tested and rejected as unfixable-by-lexical-patch — requiring the observed side to resemble the observed reference more than the expected reference — is not needed: the two sides are different fields with different domains, so there is nothing to disambiguate.

---

## 7. Closing boilerplate credit — the execution witness

Every kind requires at least one field whose value **could only be produced by executing the survey**. The table in §4 marks these RO. They fall into five families:

| Witness family | Example fields | Why the document cannot supply it |
|---|---|---|
| Observed successor | `nextQuestionId`, `continuedToQuestionId`, `observedSequence` | The document states the *intended* successor; the defect is precisely that the site's differs |
| Observed rendered list | `optionLabelsObserved`, `optionCodesShown`, `instructionTextsObserved`, `observedOrders` | The site's list is the site's |
| Probe-and-outcome | `probes`, `probeValue` + `outcome` | The tester chooses the probe; the document never names it |
| Observed count | `observedIterations`, `observationCount` | An integer produced by driving |
| Observed rendered string | `renderedToken`, `renderedQuestionText`, `screenTextExcerpt` | The unresolved token `{Q2drug}` exists nowhere in the document |

Three enforcement layers, cheapest first (the pa four-layer validation pattern):

1. **Schema.** RO fields are `required` per kind, with `additionalProperties:false` and closed enums enforced in the schema handed to the tester — not merely requested in prose (pa: enums lived in `EXTRACT_SCHEMA`, not the prompt). A claim without its witness is structurally unsubmittable; if it arrives anyway it is `unsupported`, never matched, and counts against precision.
2. **Artifact binding.** Each RO field carries a `witness[]` entry naming an `evidenceId` that is integrity-valid, run-scoped, and captured inside an attempt whose attested `targetItemIds` cover the locus (the existing claim-relevance rule, §7.1 of the threat model).
3. **Artifact-consistency (the mechanical falsifier, P4/P7).** Where the bound artifact is text — DOM excerpt, accessibility tree, page text — the scorer checks the claim against the bytes, with **no model in the loop**:
   - claimed present strings must occur in the normalized artifact text;
   - claimed absent strings must **not** occur in it;
   - claimed sequences must be order-consistent with the artifact set;
   - recomputed fields (`anchorHeld`, `divergence`, `wasShown`, `firstDivergenceIndex`, `expectedIterations`, `predictedValue`) are computed by the scorer and the agent's value is *checked*, not trusted.

   A claim failing artifact-consistency is `inconsistent-witness`: rejected, and counted against precision. This is the exact `explain.py` guard — paraphrase is deletion, and "found=true with no surviving quote" is downgraded to found=false.

**The honest consequence, stated plainly.** An agent that captures the real DOM excerpt for Q3 has, by construction, looked at Q3. If it *also* happens to have guessed the right claim, that is fine — it did the work. The test is not "did you reason your way here"; it is "did you observe". That is the property the apparatus was always supposed to have.

**Named weakness.** For an image-only artifact the consistency check cannot run without OCR. Such claims match but are flagged `witness-unverified`, and whether they count is an owner decision (§14 fork 4). Every seeded defect in the current corpus is witnessable from text, so this is a forward risk, not a current hole.

---

## 8. Prose

`prose.summary`, `prose.expected`, `prose.observed` are retained, required to be non-empty, and rendered in the human report.

> **They carry zero matching weight. The scorer must never read them. The schema documentation, the scorecard, and the brief given to the tested agent must all say so in those words.**

The reason is not aesthetic. The real-model run showed that an agent's prose *register* — imperative implementation-spec voice, ~2× the oracle's median length, 25/25 items opening with an obligation construction and 0/25 opening with a question id — is what destroyed its score. A sensitivity test proved causation: rewriting only the prose into the oracle's register, changing nothing about what the tester would do, lifted matched obligations from 1/18 to 9/18. Any residual prose weight re-imports that bias. If prose has weight, agents optimize prose.

Same reasoning applies to `severity` and `confidence`: free, echoed, credit-bearing nowhere. (pa: "Confidence = cross-model agreement, not model self-report.")

---

## 9. Doc-is-truth, and the two currently-inert finding kinds

### 9.1 `document-live-disagreement` — **recommendation: REMOVE from the kind enum**

Under the ruling, a document/site divergence *is* a site defect. It is exactly what the fifteen defect kinds encode. Keeping a separate kind creates a **hedge lane**: an agent unsure whether a divergence is a defect files it as `document-live-disagreement`, asserts a divergence without asserting a defect, and can never be scored wrong. That is the finding-kind equivalent of the redundancy escape being deleted in §5.

The residual reading someone will offer — "it means the doc and the site differ but I can't tell which is right" — is precisely the arbitration the ruling abolishes, and precisely the `pa-policy-extractor` `status:"updated"` value that P8 deletes. The other residual reading — "they differ in a way the taxonomy can't express" — is what `other` is for.

*Counter-argument for the record (this is a fork, §14 fork 2):* a future non-corpus target might have a document the client concedes is stale. Under the ruling that is out of scope, but if the owner ever wants it back, it returns as a **run-configuration flag on the document**, not as a per-finding hedge the agent controls.

### 9.2 `ambiguity` — **recommendation: WIRE IT, as its own scored track**

The schema already has the slot and the scorer walks past it. Under the ruling, ambiguity is the one place the system is required to *report and not judge*. Concretely:

- The oracle gains `ambiguityLoci: [{ ambiguityId, locus, quote, admissibleReadings: [typed partial claims] }]`. **Empty in the current corpus** — no ambiguity is seeded and none can be, because the questionnaire is machine-generated from the same source that defines the answer (Finding 7). Seeding them is corpus work (§14 fork 8).
- An `ambiguity` claim is a **hit** when its locus matches an oracle ambiguity locus and its `readings` set covers the oracle's `admissibleReadings` as a set (order-free, ≥ the oracle's set). It is scored on whether the ambiguity is *real*, never on picking a side.
- Reported as its own pair — `ambiguityRecall` / `ambiguityPrecision` — **never folded into defect recall.** Mixing them would let a tester trade one for the other.
- **A confident defect claim at an oracle-ambiguous locus is neither a true positive nor a false positive.** It is `judged-at-ambiguous-locus`, tallied separately. This is `pa_v22review.js`'s `either_convention` at half weight under its own heading, arrived at empirically there and by ruling here. Whether it becomes a soft penalty later is §14 fork 5.
- The **size** of the ambiguity class is a corpus-health metric, not an agent metric. A high rate means the surveys are underspecified and the fix is upstream (P5).

### 9.3 What the ruling *supersedes* in the audit

Audit Finding 7 recommends letting a seeded defect "declare a side (site | document | ambiguity)". Under the ruling, **the `document` side is deleted**: sides reduce to `{site, ambiguity}`. The audit's contract-first recommendation stands; its three-valued side does not. This should be recorded explicitly so the next reader does not re-derive the document-side track from Finding 7 and reintroduce P9's failure mode. `docs/llm-led-architecture-proposal.md` Decision #2 ("the document defines expected intent; the live survey provides observed behavior; any disagreement is a finding, never silently resolved") is *compatible* but weaker than the ruling and should be restated when that doc is next touched — **not by this workstream** (single-file constraint).

---

## 10. What the oracle must carry

### 10.1 Per seeded defect: a `typedFact`, derived mechanically

The corpus already holds everything needed. Each seeded error is a **JSON patch** against the clean manifest (`test-suite/branching/*/manifest.flawed.json`, `seededErrors[*].patch`), and `scorer/oracle/lib/seeded-map.mjs` already applies each patch alone and diffs the re-derived obligation set to attribute defects **mechanically, with no hand-labelling**. The typed fact is the same discipline applied one level down: patch path pattern → kind + fields.

| Patch shape | Kind | Field derivation |
|---|---|---|
| `remove /questions/N/options/K` | `option-missing` | `questionId` ← clean `questions[N].id`; `optionCode`/`optionLabel` ← the removed object; `optionCodesShown` ← flawed option codes |
| `add /questions/N/options/K` | `option-extra` | mirror |
| `replace /questions/N/options/K/label` | `option-label-wrong` | both labels |
| `replace /questions/N/rules/R/goto` | `skip-target-wrong` | `condition` ← clean `rules[R].if`; doc goto ← clean; site next ← patched value |
| `remove /questions/N/rules/R` where rule outcome is terminate | `terminate-not-enforced` | `condition` ← removed rule; `continuedToQuestionId` ← flawed walk successor |
| `replace /questions/N/rules/R/if/value` | `condition-boundary-wrong` | value pair; `op` equal |
| `replace /questions/N/rules/R/if/op` | `condition-boundary-wrong` | op pair; `value` equal |
| `replace /questions/N/allocation/enforceTotal → false` | `validation-not-enforced` | `constraintType: allocation-total`, `constraintValue: 100` |
| `remove /questions/N/rows/K/max` | `validation-not-enforced` | `constraintType: allocation-row-max`, `rowId`, `constraintValue` ← clean max |
| `replace /questions/N/text` introducing an unknown pipe token | `piping-unresolved` | `renderedToken` ← the token; `pipeSourceQuestionId` ← clean pipe ref |
| `remove /questions/N/optionsFrom` (+ static `options` added) | `carry-forward-wrong` | `sourceQuestionId` ← clean `optionsFrom`; `divergence: unfiltered` |
| `replace /computed/K/expr/refs/J` | `calculation-wrong` | `computedId`, doc/site `sourceRefs` |
| `replace /loops/K/max` | `loop-truncated` | `loopId`, `observedIterations` ← patched max |
| `remove /questions/N/randomize/anchorLastCodes` | `randomization-anchor-violation` | `anchorRule: anchor-last`, `anchorOptionCodes` ← clean value |
| `remove /questions/N/instruction` | `instruction-missing` | `instructionText` ← clean value |

**Build gate, fail-closed:** every seeded defect must produce **exactly one** typed fact, or the build fails with `SEEDED_DEFECT_UNTYPED` and writes nothing. This is deliberately the opposite of the current builder, which writes all thirteen records *before* evaluating its failure gates (Finding 3b) — the typed-fact derivation must be inside the atomic write, or a rejected build again leaves usable-looking ground truth on disk.

Additional oracle fields:

- `seededDefects[*].typedFact` — as above. **Scoring.**
- `seededDefects[*].expected/observed` prose — **retained, explicitly non-scoring**, marked so in the schema description (P2).
- `seededDefects[*].observability: { witnessFamily, witnessableFromPathIds[], textWitnessable: bool }` — so the scorer can distinguish "the tester missed it" from "no tester could have seen it". Required to settle S6-E03 (§4.10).
- `ambiguityLoci: []` — §9.2. Empty until the corpus seeds them; the field exists so the scorer can be written and fixtured now.
- A **golden snapshot of every typed fact**, gated in CI, so a deriver change produces a reviewable diff that must be explicitly re-approved rather than silently absorbed (Finding 3a; pa's `test_validate_and_normalize.py` pattern).

### 10.2 The shared normalizer (P6)

**One** tested module, imported by the oracle builder, the scorer, and the artifact-consistency checker. Not three. It must handle the cases the real model actually emitted: U+2011 non-breaking hyphen and U+2019 curly apostrophe. The current `normalizeText` maps U+2011 → U+2010 (not to ASCII `-`) and leaves U+2019 intact, so the model's `"single‑choice"` and `"respondent's"` tokenize differently from the document's ASCII forms — a free penalty no hand-written fixture ever incurs. Fold U+2010/U+2011/U+2012/U+2013/U+2014/U+2212 → `-` and U+2018/U+2019 → `'`, and golden-test with the nastiest real strings from the corpus and from the real-model transcript.

**Put no fuzziness in the comparator. Put it in the normalizer, where it is visible, tested, and identical on both sides.**

---

## 11. What the RunRecord must add

```
finding (v2):
  + claim: { kind, locus, documentSays, siteShows }   REQUIRED for kind ∈ {defect, ambiguity}
  + docEvidence: { locator, quote }                   REQUIRED — quote must be a verbatim doc substring
  + witness: [ { field, evidenceId, excerpt } ]       REQUIRED — one per RO field
  ~ expected, observed  → moved under `prose`, documented NON-SCORING
  ~ kind enum: remove "document-live-disagreement"    (§9.1, fork 2)
  = severity, confidence, itemRefs, attemptRefs, evidenceRefs unchanged
```

Plus one strictly-additive record-level array, borrowed from `pa_audit.js`'s `fields_confirmed`:

```
+ checked: [ { locus, kind, outcome: "matches" | "not-determinable" | "not-reached", witness[] } ]
```

This is what turns precision into an honest number and makes coverage visible: it records the loci the tester examined **and found correct**. Without it you only ever see complaints, and a tester that never looked at the survey hides behind an empty findings list. With it, "which seeded-defect loci did the tester never even visit?" becomes computable. *Recommended; §14 fork 7 asks whether it is v2 scope or deferred.*

---

## 12. Worked end to end — the three `s1-skip` defects

Real oracle data, real defect IDs, real obligation IDs. Agent-side prose is kept in the register the real model actually used, to show it costs nothing.

### S1-E01 — wrong skip target

**Oracle** (derived from `replace /questions/3/rules/0/goto → "Q6"`):
```json
{ "defectId": "S1-E01", "kind": "skip-target-wrong",
  "locus": { "fromQuestionId": "Q2", "ruleIndex": 0 },
  "documentSays": { "condition": {"questionId":"Q2","op":"eq","value":2}, "gotoQuestionId": "Q5" },
  "siteShows":    { "nextQuestionId": "Q6" },
  "observability": { "witnessFamily": "observed-successor", "textWitnessable": true,
                     "witnessableFromPathIds": ["p002"] },
  "affectedObligationIds": ["s1-skip/branch:Q2:goto:Q5:taken"],
  "prose": { "expected": "IF Q2=2 (NO), SKIP TO Q5.", "observed": "IF Q2=2 (NO), SKIP TO Q6." } }
```

**Agent claim:**
```json
{ "claimId": "F-1", "kind": "skip-target-wrong",
  "locus": { "fromQuestionId": "Q2", "ruleIndex": 0 },
  "documentSays": { "condition": {"questionId":"Q2","op":"eq","value":2}, "gotoQuestionId": "Q5" },
  "siteShows": { "nextQuestionId": "Q6",
                 "answerVectorPrefix": {"S1":1,"S2":0,"Q1":0,"Q2":2},
                 "observedSequence": ["S1","S2","Q1","Q2","Q6"] },
  "docEvidence": { "locator": "Q2, rule 1", "quote": "IF Q2=2 (NO), SKIP TO Q5." },
  "witness": [ { "field": "siteShows.observedSequence", "evidenceId": "ev-dom-q6",
                 "excerpt": "How likely are you to recommend biologic therapy to a colleague" } ],
  "prose": { "expected": "Survey must route a respondent answering No at Q2 directly to Q5.",
             "observed": "Answering No at Q2 advanced to Q6; Q5 was never presented." } }
```
**Decision: MATCH.** kind ✓, `fromQuestionId` ✓, `condition` ✓, `documentSays.gotoQuestionId` Q5=Q5 ✓, `siteShows.nextQuestionId` Q6=Q6 ✓; RO present; the bound DOM excerpt is Q6's text, consistent with `observedSequence`. *This exact claim scored 0.164 under lexical matching and was gated out as a fabrication.*

### S1-E02 — missing option

**Oracle** (derived from `remove /questions/4/options/4`):
```json
{ "defectId": "S1-E02", "kind": "option-missing",
  "locus": { "questionId": "Q3", "optionCode": 5 },
  "documentSays": { "optionCode": 5, "optionLabel": "BIMZELX" },
  "siteShows": { "presentOnSite": false, "optionCodesShown": [1,2,3,4] },
  "observability": { "witnessFamily": "observed-list", "textWitnessable": true,
                     "witnessableFromPathIds": ["p001"] },
  "affectedObligationIds": ["s1-skip/question:Q3"] }
```
**Agent claim:** as in §3. **Decision: MATCH.** `optionLabelsObserved` is non-empty, does not contain "BIMZELX", and every listed label occurs in the bound DOM excerpt while "BIMZELX" does not.

**The four adversaries, same locus:**

| Claimant | Typed form submitted | Decision |
|---|---|---|
| Spec-restater (never opened a browser) — **scored 1.000 today** | `siteShows` absent | **Schema-invalid** → `unsupported`, counts against precision |
| Inverted claim — **scored 0.808 today** | `siteShows.presentOnSite: true` | **No match** — `true ≠ false`. Additionally self-refuting: a `presentOnSite:true` claim requires `optionLabelsObserved` to *contain* the label, and the bound artifact does not |
| Boilerplate ("Q3: Option 5") — **scored 0.525 today** | no `optionLabelsObserved` | **Schema-invalid** → `unsupported` |
| Fabricated witness | `optionLabelsObserved` invented, cites a real Q3 artifact | **`inconsistent-witness`** — the claimed labels do not occur in the artifact bytes; rejected, counts against precision |
| Honest real model — **scored 0.220 today, logged as fabrication** | full typed claim | **MATCH** |

The ordering is no longer inverted; it is no longer an ordering at all.

### S1-E03 — instruction missing

**Oracle** (derived from `remove /questions/4/instruction`):
```json
{ "defectId": "S1-E03", "kind": "instruction-missing",
  "locus": { "questionId": "Q3" },
  "documentSays": { "instructionText": "Select all that apply." },
  "siteShows": { "present": false },
  "observability": { "witnessFamily": "observed-rendered-string", "textWitnessable": true } }
```
**Agent claim:**
```json
{ "claimId": "F-3", "kind": "instruction-missing",
  "locus": { "questionId": "Q3" },
  "documentSays": { "instructionText": "Select all that apply." },
  "siteShows": { "present": false, "instructionTextsObserved": [],
                 "screenTextExcerpt": "Which of the following biologic therapies do you currently prescribe … SKYRIZI TREMFYA COSENTYX TALTZ" },
  "docEvidence": { "locator": "Q3, instruction", "quote": "Select all that apply." },
  "witness": [ { "field": "siteShows.screenTextExcerpt", "evidenceId": "ev-dom-q3", "excerpt": "…" } ] }
```
**Decision: MATCH.** The mechanical falsifier does the work: `"select all that apply"` does not occur in the normalized bound artifact text, so `present:false` is *verified*, not merely asserted. *This claim scored 0.243 today and was gated out.*

---

## 13. Migration

**No lexical fallback in the match path.** Say it once and hold it: a claim without a typed payload is `unsupported`. It does not fall back to prose similarity. Anything else reopens the hole this document exists to close.

| Step | What moves |
|---|---|
| 1. Registry | New module `scorer/src/lib/claim-kinds.mjs`: the kind registry (kind → identity fields, RO fields, predicates), frozen, hashed. `scorer/test/calibration-pins.mjs` pins the **registry hash**, not thresholds — a taxonomy change without a version bump fails CI (P6; kills the Finding 11 threshold-mutant class for this path) |
| 2. Oracle | `oracle-record.schema.json` **1.0.0 → 2.0.0**: `typedFact`, `observability`, `ambiguityLoci` required; `expected`/`observed` retained and re-described as non-scoring. Typed-fact derivation added to `oracle/lib/seeded-map.mjs`, inside an atomic write |
| 3. Run record | `run-record.schema.json` **1.0.0 → 2.0.0**: `claim`, `docEvidence`, `witness` required on defect/ambiguity findings; `prose` sub-object; `document-live-disagreement` removed from the enum; optional `checked[]` |
| 4. Matcher | `defect-match.mjs` → `claim-match.mjs`, `survey-qa-scorer-defect-matcher/1.1.0` → **`survey-qa-scorer-claim-matcher/2.0.0`**. `matcher.mjs` (obligation matching) is **untouched** by this design — see §14 |
| 5. Dual-report, exactly one release | Scorecard emits `defectRecall.typed` (authoritative) and `defectRecall.lexicalLegacy` (informational, gates nothing, printed with the word *legacy*). The purpose is to make the delta visible on the existing fixtures, not to hedge. Removed in the following release; **the removal date is agreed when the dual-report lands, not later** |
| 6. Fixtures | `scorer/fixtures/build-fixtures.mjs` regenerates and re-signs. Defect-bearing fixtures (fx-01, 02, 03, 06, 18, 19, 23…) gain `claim` objects. fx-07 (ambiguous *obligation* matching) is unaffected. **New fixtures required, one per closed hole:** inverted-claim (must be FP), boilerplate-claim (must be schema-invalid), shotgun-enumeration (must tank precision), inconsistent-witness, witness-unverified (image-only), ambiguity-hit, ambiguity-false-positive, defect-claim-at-ambiguous-locus, exact-key-duplicate |
| 7. Integration proof | `gen-integration-runs.mjs` + `verify-integration.mjs` regenerate against new pinned numbers, **and must exit non-zero when the failure set differs from the pinned baseline** (Finding 3). The current unconditional success exit is why an 0.944→0.778 collapse went unnoticed |
| 8. Real-model fixture | Add the `@cf/openai/gpt-oss-120b` run transcript as a **fixture in its own right** — the audit's own gap #2 was that no real model had ever been run. A hand-written "realistic LLM extractor" fixture is lexically pre-aligned to the oracle and is not how a real model writes |
| 9. Docs | `scorer/docs/threat-model.md` §6 rewritten; §11 fixture table extended. `docs/llm-led-architecture-proposal.md` Decision #2 restated under the ruling — **by whoever owns that file, not this workstream** |

---

## 14. What this does NOT fix, and the new attack surface

### 14.1 Not fixed

1. **Finding 2 — the obligation matcher is untouched.** Checklist item → oracle obligation is still lexical, still best-of over an unbounded alias bag, still has requirement-weight 0.55 = eligibility bar 0.55. This design closes Theme 1 for **findings**, not for **items**. The same typing treatment for contract items is a sibling Tier-1 and it is where Finding 4's fidelity split belongs. Do not read this document as closing Theme 1.
2. **Finding 4 — extraction accuracy** still counts assignability, not correctness. Untouched here. Do not ratify the P1 threshold on it.
3. **Finding 10 — out-of-taxonomy documented requirements.** Typed claims make this *sharper*, not softer: an agent that finds a real defect with no kind in the registry now gets a structural zero rather than a lexical near-miss. Partly mitigated by `other` + the tallied taxonomy-gap rate (§4.18), but the underlying owner decision (does the coverage contract cover non-logic documented requirements at all?) is unchanged and still open.
4. **Findings 3, 5, 9, 12, 13, 14, 15, 16, 17** — orthogonal. Note that Finding 3 (unverified ground truth) becomes *more* load-bearing: typed facts are now the scoring surface, so the golden snapshot in §10.1 is a prerequisite, not a nicety.
5. **Corpus expressiveness.** The corpus still cannot express document-side error — but under the ruling that is closed **by fiat, not by fix**. It still cannot express ambiguity, and that one is a real gap that must be seeded before §9.2 measures anything.
6. **Finding 8 (page ships its own logic manifest).** A manifest-parsing agent can now populate `documentSays` *and* the derived halves of `siteShows` without clicking. The artifact-binding requirement (§7 layer 2) still forces a real capture, but the manifest leak means a shotgunner needs *fewer* observations to aim. This design raises the cost of the leak; it does not close it.

### 14.2 New attack surface

**Attack 1 — shotgun enumeration. This is the primary new risk and the one to argue about.** The typed space is small and enumerable. For `s1-skip`: `option-missing` over 6 questions × ~5 codes ≈ 30 claims; `skip-target-wrong` over each rule × each candidate target ≈ 50. An agent could emit the cross-product and let one land.

Layered mitigation, strongest first:

- **(a) Structural — every claim needs its own execution witness.** N shotgun claims need N artifact-backed observations from attempts targeting N loci. You cannot shotgun without walking. This is the primary defence and it is not a heuristic.
- **(b) Mechanical — fabricated witnesses are refuted for free** against the bound bytes (§7 layer 3), with no model in the loop.
- **(c) Precision is a real denominator.** The redundancy escape is deleted (§5.2); N−1 shotgun claims are false positives. This is the audit's own recommended mitigation (a), now structural rather than a patch.
- **(d) One claim per `(kind, locus)`.** An exact-key duplicate is a schema error, not a redundancy judgement.
- **(e) Budget.** Claims cost artifacts; artifacts cost browser time; browser time is metered and capped.
- **(f) Reported tell.** The scorecard emits `claimsPerTargetedAttempt` and `witnessReuseRate`. A shotgunner has a distinctive shape and it should be visible to a human, not only to a gate.

Honest residual: (a)+(b) are strong for text-witness kinds and weak for image-only kinds. All 18 current seeded defects are text-witnessable, so this is a forward risk tied to fork 4.

**Attack 2 — witness laundering.** Capture one broad DOM excerpt, cite it on many claims. Partly *legitimate* — a screen genuinely witnesses several facts, and the pa project shared evidence across parameters deliberately. Mitigated by the per-field predicate: a Q3 excerpt cannot satisfy a Q5 claim's predicate, and attempt-targeting still applies. Residual: within one screen, one capture supports every claim about that screen. Accepted.

**Attack 3 — taxonomy inference.** Publishing the kind registry tells an agent which defect shapes exist. Unavoidable, and the alternative is worse — an unpublished taxonomy is exactly audit Theme 3 (unwritten rules the code enforces anyway, punishing the conforming party). Mitigation is corpus-side: seed kinds **unevenly**, and include **clean loci for every kind**, so "guess this kind exists here" is a coin flip that costs precision.

**Attack 4 — identity-field selection.** Where a kind accepts `optionCode` *or* `optionLabel`, an agent supplies whichever is cheaper to guess. Mitigation: require **both** whenever the document carries both. But note the framing correction — guessing from the *document* is not cheating (§0), so this attack is only interesting where it lets an agent avoid the site, and the RO fields already prevent that.

**Attack 5 — normalization attacks.** Homoglyphs, non-breaking hyphens, curly quotes, zero-width joiners on either side of an identity comparison. Mitigated by the single shared golden-tested normalizer (§10.2). This is not hypothetical: the real model emitted U+2011 and U+2019 unprompted and was silently penalized for it.

**Attack 6 — ambiguity abuse.** File `ambiguity` everywhere, to farm ambiguity credit or to shield a wrong site call. Mitigated three ways: ambiguity precision is scored; each reading must be a well-formed typed claim with its own verbatim doc quote; and an ambiguity claim *withholds* site judgement, so filing one at a real defect locus **forfeits the defect**. Filing ambiguity is a real trade-off, not a free hedge.

**Attack 7 — the recomputed-field seam.** Fields the scorer recomputes (`anchorHeld`, `divergence`, `wasShown`, `expectedIterations`, `predictedValue`) must be recomputed from RO inputs the agent supplied. An agent that supplies self-consistent but fabricated RO inputs gets a self-consistent recomputation. This is why (b) — artifact-consistency on the RO inputs themselves — is load-bearing and not optional.

---

## 15. Open questions for Tier-1 convergence

Genuine forks. Each is a decision I have a recommendation on but have deliberately not made alone.

1. **Drop `itemRefs → affectedObligationIds` as a match precondition?** Today condition 1 of §6 of the threat model requires a referenced item to map to an affected obligation — which imports the broken lexical obligation matcher into defect scoring. The typed `locus` is a better anchor. **Recommend: drop it as a precondition, keep `itemRefs` required for coverage attribution and reporting.** Against: it decouples the two matchers, so an agent can score defects with a bad checklist.
2. **Remove `document-live-disagreement` from the kind enum?** **Recommend: remove** (§9.1). Against: it is public schema surface, and someone will want the hedge back for stale client documents.
3. **One `condition-boundary-wrong` kind, or separate `threshold-wrong` + `operator-wrong`?** **Recommend: one kind, with both `op` and `value` as identity**, so an agent cannot shotgun two kinds at one locus. Against: the oracle's own categories distinguish `wrong-threshold` from `boundary-off-by-one`, and per-kind recall would be a nicer diagnostic.
4. **Do image-only witnesses count?** A claim whose witness is a screenshot cannot be byte-checked without OCR. **Options:** (i) credit with a `witness-unverified` flag, (ii) require a text witness for credit, (iii) require both. This blocks harness and corpus design and should be decided early.
5. **A confident defect claim at an oracle-ambiguous locus — neutral, or soft penalty?** **Recommend: neutral in P0/P1, tallied**, matching the pa half-weight `either_convention` treatment. Revisit once real ambiguity is seeded.
6. **Does an unmatched, well-formed `other` claim count against precision?** **Recommend: no** — it is the taxonomy-gap signal, and punishing it re-creates Finding 10 in a new key. Against: an easy zero-cost lane invites noise; if it is exempt, cap it.
7. **Is `checked[]` in v2 scope, or deferred?** It is what makes precision honest and coverage visible (§11), and it is strictly additive — but it enlarges the tester's obligation and every fixture.
8. **When does the corpus seed ambiguity loci and per-kind clean loci?** §9.2 measures nothing until it does, and Attack 3's mitigation depends on it. P0 scope or P1?
9. **Is S6-E03 (`calculation-wrong`) observable at all?** If the computed value is neither rendered nor routing-relevant, no honest tester can witness it and it is a corpus defect, not an agent failure. **An observability audit of all 18 seeded defects is a prerequisite** to publishing this taxonomy.
10. **Kinds the corpus does not seed** — `option-extra`, `option-label-wrong`, `question-not-shown`, `question-shown-unexpectedly`, `order-violation`. Ship them unexercised (honest, but zero assurance), or seed them, or omit them until seeded? Note `order-violation` is entangled with audit Finding 15 (is presentation sequence a first-class obligation?), which is a separate open owner decision.

---

*Draft for convergence. Nothing here is implemented; no schema, fixture, oracle record, or scorer module has been modified. Evidence base: `docs/p0-adversarial-audit.md`; the shipped `pa-policy-extractor` prior art; and one real model run (`@cf/openai/gpt-oss-120b`, Workers AI, reasoning effort high — substituted for an unreachable DeepSeek V4 Pro, which is recorded as a caveat that strengthens rather than weakens the finding).*
