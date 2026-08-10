# Graph architecture — empirical findings

**Verdict: a COMPONENT, not the architecture. And the self-consistency argument should be dropped.**

Measured against the open `test-suite/branching/` corpus (6 surveys, clean + flawed, 18 documented seeded defects). Run `node run-all.mjs` (~2 min).

Three findings decide it:

1. **The deterministic half works.** Graph-S is recoverable from a live site with **zero model involvement**, and coverage becomes a real fraction with a stated denominator.
2. **"The model proposes, the structure checks" does not hold.** Self-consistency catches **15.7%** of semantic extraction errors and **0 of the 18** seeded defects.
3. **The graph is the skeleton of a minority of the problem.** Only **11%** of requirements are edges; **89%** are node attributes.

---

## 1. Graph-S — recovering the site's graph (works, better than expected)

A blinded headless-Chrome crawler over CDP (no puppeteer/playwright added) recovered all 12 pages: 8–12 nodes, 54–98 labelled `(node, answerClass) → node` edges, 37–167 journeys, **71s total**.

Recovered: question text (post-piping), instruction, input type, option codes/labels/render order, numeric bounds, allocation rows, validation behaviour.

**Blinding is structural, not promised.** The corpus pages inline their own manifest and expose `window.__surveyEngineState`; the crawler deletes both after every load, *before any observation*, and throws if either survives. `verify-blinding.mjs` proves the guard is non-vacuous — pre-blinding, the page really does carry the seeded answer.

**Blind bisection recovered exact numeric gate boundaries never disclosed to it** (clean s2: S1@18, S4@15; flawed s2: 16 and 16). Allocation probing made the site state its own constraints — the required total of 100 was read out of its own error text, and row cap `r5<=20` was recovered on clean and found **absent** on flawed.

Cost scales with Σ(answer classes) × depth, **not** path count — s6 has 53 routing paths but needed only 73 journeys.

**Not recoverable:** randomisation vs fixed order (one deterministic session renders one order); carry-forward under all upstream states (sampled 9/31 and 12/63); 33 recorded `numeric-no-gate-found` **assumptions** — "I sampled 6 values and found nothing", not a proof.

**Biggest untested risk:** the corpus is forward-only, one question per screen, stable ids in the heading, static, free to re-run. A real platform with a back button, server-side session state, quotas consuming real completes, non-idempotent submits, or no question id in the DOM is untested.

## 2. Graph-D — compiled from the manifest, NOT from prose

Compiled from the corpus's own machine-readable manifest, deliberately isolating the graph question from the extraction question. The document-side interpreter is an **independent reimplementation** that does not import the engine — which is what makes the clean-vs-clean control meaningful.

A deterministic docx parser also recovered 703/703 requirements with 0 spurious. **Do not quote that number.** The corpus `.docx` files are *generated* from the manifests, so the parser is inverting a renderer. It is an upper bound on a machine-generated document. The useful signal is negative: **comparison is not the hard part; extraction is.**

## 3. The diff — partly sound, and arithmetic alone is not enough

Three levels: **A** edge-set arithmetic, **B** full-state trace replay, **C** node-attribute comparison.

**Control: D(clean) vs S(clean) = 0 findings on all 6 surveys at all levels**, 471/471 journeys replaying identically.

But only **92.5% of observed site edges are locally decidable** (s6: 73%, 26 of 92 undecidable). A guard reading another question, or a node inside a loop, has no locally predictable target — those are neither "missing" nor "undocumented", and only stateful replay has anything to say.

### The 13 leaks

**Arithmetic says different, human says compliant:**
- Piped question text differs literally from the template (`{Q2}` vs `OZEMPIC`) — fires on every piped question unless piping is resolved first
- A carry-forward question whose list resolves empty is legitimately auto-skipped; arithmetic sees a documented node never visited
- Randomised option order differs from document order **by design** — survivable only because the register knows randomisation is permitted there. *The fix is more requirement metadata, not more graph.*

**Arithmetic says same, human says broken:**
- Loop truncation is invisible unless a journey selects ≥2 loop items
- A quota firing on the 51st respondent produces an identical graph
- Randomisation dropped entirely is **unevaluable** from single-session traversal

**Structural:**
- **Validation masquerades as routing** — on flawed s5, 22 site edges exist for answers the document forbids; to arithmetic they are ordinary edges whose targets then look like mis-routes. Separating them needs an admissibility test *before* the comparison
- **First divergence masks the rest** — stopping at the first divergence found 1 finding on flawed s6; resyncing found **7**. Two defects were entirely hidden behind an upstream terminate defect. Resync is itself a heuristic and failed 10–77 times per survey
- Edge identity is not history-independent (10 edges in s6, 5 in s3 depend on accumulated state)
- Whether a dropped option surfaces as an attribute defect or a routing defect is a **labelling accident** — it depends on whether that option happened to gate a rule
- Where the site is *more* restrictive than the document, the edge simply does not exist in S — indistinguishable from "not probed"
- Numeric edges are probe-relative: `n=17`, not `S1 ∈ [0,17]`

## 4. Self-consistency — the claim fails empirically

**34 document-graph checks (C01–C34) + 6 site-graph checks (S01–S06)** implemented. Mutations of the 6 correct graphs, guarded two ways: each mutation must be **behaviourally observable** (14 of 456 were silent and excluded), and "caught" means a check fires that did *not* fire on the correct graph.

| Class | Caught | Rate |
|---|---|---|
| Referential / structural | 147/149 | **98.7%** |
| Semantic / value | 46/293 | **15.7%** |
| **Overall** | **193/442** | **43.7%** |

All 6 correct manifests produce **0** findings — no baseline noise.

**Twenty families caught at 0%**, including: terminate-dropped, operator-direction-flip, operator-boundary-flip, condition-code-swapped-valid, instruction-dropped, option-label-wrong, option-order-swapped, option-hallucinated, question-text-wrong, exclusive-flag-dropped, anchor-dropped, randomize-dropped, row-cap-dropped, allocation-total-wrong, computed-ref-wrong-row, loop-max-wrong, and-or-flip.

**The single most important number:** `goto-retargeted` — "SKIP TO Q5" read as "SKIP TO Q6", the most plausible routing extraction error there is — is caught **1/8 = 13%**, and only when the mis-target happens to strand another question.

**Corroboration:** running the same checks over the 6 *flawed* manifests finds **1 of 18** seeded defects.

**This is a property of the idea, not the implementation.** Self-consistency can only detect errors that break a *reference*. An extractor that reads `< 18` as `< 16`, or misses a line entirely, produces a perfectly coherent graph. **Adding more checks does not help — there is nothing internal to check against.**

## 5. Coverage arithmetic — the strongest part

Denominator = the symbolic edge set of Graph-D: finite, computable, **traversal-independent**. All 6 surveys reached **100% edge and 100% node coverage** from 12–19 generated journeys, with minimal covering sets of just **2–5 journeys**.

It also exposed a trap an LLM would fall into: a naive generator answering everything with option 1 covers only **36%** of s2, because screener option 1 terminates — **and would have reported success.** A frontier-based generator was required.

`coverageResidue()` emits 3–7 items per survey, so a report can **state** what it did not cover: state-dependent edges, carry-forward states (2^n upstream), loop iteration counts, continuous allocation domains, sampled numeric domains, and accumulated-state rules (quotas, per-cell counters) which are invisible to single-journey traversal **by construction**.

Path coverage was not attempted — s6 has 53 routing paths for 17 edges in a 12-question survey.

## 6. Attributes — the graph is 11% of the problem

| | Count | Share |
|---|---|---|
| Edge requirements | 78 | **11.1%** |
| Node-attribute requirements | 625 | **88.9%** |
| **Total atomic requirements** | **703** | |

Largest categories: option-label 143, option-present 143, question-text 58, input-type 58, question-exists 58, fall-through 57, option-order 30.

**Does keying the register to the graph fix it? Partly — and the measurement matters more than the claim.** Traversal *evaluated* 699/703 = **99.4%** of register items. But:

- The 0.6% unevaluable is exactly the silent-failure class — 2 randomisation-mode items (need N respondents), 1 exclusive-enforcement never probed, 1 fall-through never traversed. **Each would have passed silently under a "we tested it" report. The graph's genuinely new contribution is that it NAMES them.**
- **"Evaluated" ≠ "verified"** — carry-forward at s3 Q2 counts as evaluated having sampled 9 of 31 upstream states. The checklist ticks; the requirement is sampled.

**Does it merely relocate the problem? YES, in one specific way.** Nothing verifies that the register enumerates every requirement in the source document. If extraction omits a requirement, it is absent from the register, absent from the checklist, and coverage arithmetic still reports 100%.

**What changes:** the unprovable part is now a small, auditable, diffable artefact instead of model behaviour. *You can put a human on a 703-row register; you cannot put a human on "did the model look".*

## 7. Seeded defects — 18/18 detected, 0 false positives

| Detector | Count |
|---|---|
| Graph diff (edge arithmetic) | 10 |
| Node-attribute comparison | 6 |
| Validation-behaviour probe | 2 |
| **Self-consistency** | **0** |
| Not detected | 0 |

Attribution uses an explicit category→detector mapping, **not** location matching — several defects share a question, and location matching lets one defect take credit for another's detection. Two cross-attribution bugs of exactly that kind were found and fixed in the scoring code itself.

**Three caveats on the perfect score:**
- **Zero were caught by self-consistency**, and only 1 of 18 is visible to it at all. The column the proposal most depends on is empty.
- **S6-E01 was initially NOT DETECTED** — masked entirely behind an upstream terminate defect. It required trace resync plus a covering-nodes fix. *A defect behind another defect is the realistic case, and the naive architecture misses it.*
- The corpus is **weighted toward routing** (10/18 seeded defects), which flatters edge arithmetic relative to the measured 11%/89% split.

---

## The recommended shape

- **Graph** = obligation ledger and coverage denominator
- **Requirement register keyed to nodes** = the checklist
- **Deterministic crawl + trace replay** = the comparison
- **The LLM confined to judgement INSIDE a named checklist item on a named node** ("is this rendered wording the same requirement?") — never deciding what to test

## What would kill this

1. **Graph-S recovery failing on a real platform** — the biggest untested assumption
2. **A non-empty clean-vs-clean diff.** It was 0/6 here, but piping, carry-forward auto-skip and randomised option order each *nearly* produced false positives
3. **Treating self-consistency as load-bearing** — it already fails empirically; a v2 designed around it will ship confident wrong graphs
4. **The register being generated by the same model that builds the graph, with no independent completeness check** — then coverage arithmetic reports 100% over whatever the model happened to notice: the original problem with extra ceremony
5. **Attribute comparison proving harder than routing comparison.** 89% of requirements are attributes; this spike compared them by exact string/set equality, which only works because the corpus is machine-generated. Real wording comparison is a judgement call.
