# PRE-REGISTRATION — survey-qa architecture ablation

**Status: WRITTEN BEFORE ANY CONDITION HAS PRODUCED A SINGLE RESULT. That is the point.**

**Version:** `survey-qa-eval-prereg/1.0.0`
**Written:** 2 August 2026
**Author:** Claude (Opus 5), on the owner's instruction
**Freeze state:** NOT YET FROZEN. Freezes automatically at the first scored run (§8.2).

---

## 0. Why this document exists, and what it is defending against

A scorer written *after* the outputs exist gets shaped by them. Not by fraud — by a hundred
small, individually reasonable decisions about what "counts", each one made while looking at
a number you already have an opinion about.

This repository has a documented history of exactly that failure, in its *own* checks:

- a test that asserted four coverage counts **sum to a total** rather than asserting the
  property the counts were supposed to witness — it passes for any partition, including a
  wrong one;
- a gate that reported **"zero problems"** over a set it had never evaluated — an empty
  denominator rendered as a clean bill of health;
- an acceptance check with **`passed: true`** written as a literal.

And the repo already knows the general shape of the problem. `docs/STATE-OF-PLAY.md` §3.7
records that the scorer's own suite has a **~45% mutation kill rate, with 16 live gates
individually deletable while all 285 assertions stay green**. `scorer/docs/threat-model.md`
§11 says it in the repo's own words: *"Passing this suite means each listed threat produces
its required output today; it does not mean a regression in these gates would be caught."*

So the standard for this harness is higher than "it computes numbers". It is:

> **Every scoring rule is fixed, written down, and justified before any result exists; and the
> instrument is demonstrated to be capable of returning a bad verdict.**

§7 (adjudication + swing dominance) and §11 (self-tests + mutation) are where that standard
is cashed out. If you read only two sections, read those.

---

## 1. What is being measured — this is an ABLATION, not a contest

**OWNER RULING, 2 Aug 2026:** the hybrid is the destination, not a third contestant. The
owner has accepted the hybrid thesis. Therefore this experiment does **not** ask "which
architecture wins". It asks:

> **How much does each component actually contribute to the hybrid, and where exactly is the
> seam?**

That reframing changes what a "win" means, and therefore changes the decision rule (§6).
Under a contest framing you crown the highest scorer. Under an ablation framing, a condition
scoring highest is *evidence about a component*, not a coronation — and the most valuable
possible outcome is discovering that a component we believe in contributes nothing.

### 1.1 The four conditions

The full system is **C**. Every other condition is C with exactly one thing removed or
degraded. This is a lattice, not a league table.

| ID | Name | What it is | Ablation role — what its gap to C measures |
|---|---|---|---|
| **A** | **model-only** | An LLM navigates the site, decides what to test, reports findings. Coverage is **attested** by the model. The current v2 pipeline. | C − A = **what the graph adds** (principled coverage + traversal) |
| **B** | **graph-only** | Questionnaire compiles to a routing graph; site crawled into a second graph; traversal exhaustive by construction; comparison is edge-set arithmetic. Coverage is **computed**. `graph-spike/`. | C − B = **what the model adds** (node-attribute judgement) |
| **C** | **hybrid** | Graph supplies the coverage floor and traversal plan; the model judges node ATTRIBUTES (wording, option lists and their order, scale labels, randomisation, validation) that a graph cannot express. **The destination.** | — (the reference condition) |
| **C-R** | **hybrid, randomised traversal** | Identical to C in every respect — same graph extraction, same model, same prompts, same budget — except the traversal plan is replaced by a **random subset of valid traversals of equal size**. | C − C-R = **whether principled coverage is doing the work, or whether the benefit is merely browsing more** |

### 1.2 C-R is the condition that could embarrass us, and it is first-class

Requested explicitly by the owner. Its purpose, stated in advance so it cannot be softened
afterwards:

> **If C does not beat C-R by more than the margin in §6.4, the graph's central claim —
> that principled, computed traversal is better than covering the same amount of ground
> arbitrarily — is DECORATIVE. We will write that sentence in the report.**

That sentence is pre-written here on purpose. The rule for a control you might not like is
that you commit to its interpretation while you still don't know the answer.

C-R construction is pinned in §5.6. It is the only condition with a stochastic component, so
it is the only one that is repeated (3 seeds), and it is scored as a mean with the range
always shown.

### 1.3 A recorded prior, so it can't be laundered

The brief that commissioned this harness described the hybrid as "the likely winner". That
expectation is written down **here** so that:

- a C win is read as **confirmation of a prior**, not as a discovery; and
- a C loss cannot be explained away as a harness artefact after the fact.

No condition receives a scoring advantage, a lower bar, or a favourable tie-break on account
of being the expected destination. C is scored by exactly the same rules as A and B. The one
place C is treated specially is §6.6 (`HYBRID_REGRESSION`), and that rule is *hostile* to C,
not friendly: it demands the hybrid dominate its own components.

---

## 2. Shared vocabulary — requirement classes

GPT-5.6-sol is separately analysing where the seam *should* fall. Its analysis and this
instrument must use the same nouns or the two outputs cannot be laid beside each other. The
owner supplied the list; it is canonical here.

### 2.1 The 16 requirement classes (`requirementClass`)

| Token | Covers |
|---|---|
| `routing` | skip/branch fires when it should not, does not fire when it should, or lands on the wrong screen |
| `terminate` | screenout does not trigger, or triggers on the wrong condition |
| `base-filter` | a question asked of the wrong subgroup |
| `question-presence-order` | a documented question absent, an undocumented one present, or questions in the wrong sequence |
| `wording` | question text or instruction differs from the document |
| `option-list` | an option missing, added, or reworded |
| `option-order` | options in the wrong order **where order is specified** |
| `scale-labels` | scale point labels, anchors, or polarity differ |
| `randomisation-anchors` | randomisation not applied where required, applied where forbidden, or an anchored item moving |
| `exclusive-options` | "None of these" selectable alongside other answers |
| `validation` | required question skippable, numeric range unenforced, multi-select limit unenforced |
| `progress-bar` | wrong denominator, or non-monotonic |
| `piping` | wrong answer piped, or raw code shown instead of text |
| `carry-forward` | wrong set carried, or carried in the wrong order |
| `back-navigation-state` | answers retained or cleared incorrectly on re-entry after changing an earlier answer |
| `quotas` | quota cell logic wrong, or misbehaving once a cell fills |

Anything a key or an arm produces that maps to none of these is `TAXONOMY_GAP` — **never
silently forced into the nearest token.** Taxonomy gaps are counted, reported, and excluded
from the class-attribution table; a large count means this vocabulary is wrong and the seam
table is unreliable, which the report must say.

### 2.2 Mapping the corpus key's taxonomy onto the 16 — PINNED

The blind corpus is being generated against a brief whose taxonomy has 13 tokens. That list
and the owner's 16 are not identical, so the map is pinned **now**, before any key is read.
This is precisely the sort of translation that gets quietly adjusted later to make a number
move.

| Corpus-key `class` | → `requirementClass` |
|---|---|
| `routing` | `routing` |
| `terminate` | `terminate` |
| `option list` / `option-list` | `option-list` if the defect is membership or wording of an option; `option-order` if it is order. **Both are admissible** (§5.3 handles the split) |
| `wording` | `wording`, **or** `scale-labels` when the differing text is a scale point label |
| `missing / extra` | `question-presence-order` |
| `randomisation` | `randomisation-anchors` |
| `exclusive options` | `exclusive-options` |
| `validation` | `validation` |
| `base / filter` | `base-filter` |
| `carry-forward` | `carry-forward` |
| `piping` | `piping` |
| `progress bar` | `progress-bar` |
| `state on re-entry` | `back-navigation-state` |
| *(quota rules, which the brief plants under several tokens)* | `quotas` |

Where a key class maps to **more than one** requirement class, both are in the eligible set —
the eligibility gate (§5.2) admits either, and the discrimination is done by the observable
predicate, not by the class token. Class agreement is a **gate, never a matcher**.

### 2.3 Continuity with the repo's claim-kind registry

`docs/structured-claim-contract-merged.md` §4 defines 10 observable defect kinds already in
use by the scorer and judge. This harness does **not** replace them; it maps onto them so
that findings scored here remain intelligible to the rest of the system.

`routing` → `routing-mismatch` · `terminate` → `routing-mismatch` · `base-filter` →
`visibility-mismatch` / `condition-mismatch` · `question-presence-order` →
`visibility-mismatch` / `rendered-state-mismatch` · `wording`, `option-list`, `scale-labels`,
`progress-bar` → `rendered-state-mismatch` · `option-order`, `randomisation-anchors` →
`ordering-mismatch` · `exclusive-options`, `validation` → `validation-mismatch` · `piping` →
`piping-mismatch` · `carry-forward` → `carry-forward-mismatch` · `quotas` →
`calculation-mismatch` · `back-navigation-state` → **no existing kind**; recorded as
`rendered-state-mismatch` with an explicit note that the registry lacks a state-persistence
kind. That gap is reported, not papered over.

---

## 3. The normalised finding format

One format. All conditions emit it. **The scorer contains no arm-specific branch** — if it
ever needs one, the format is wrong and the format gets fixed, not the scorer (§8.1).

Machine-readable schema: `evaluation/finding-schema.mjs`. The fields that carry scoring
consequences are pre-registered here.

### 3.1 The arm's output — `evaluation/results/<arm>/<survey-id>.json`

```jsonc
{
  "schemaVersion": "survey-qa-eval-finding/1.0.0",
  "arm": "A" | "B" | "C" | "C-R",
  "armVersion": "<git sha, pinned before the run>",
  "surveyId": "<corpus survey id>",
  "seed": 0,                       // C-R only; null elsewhere
  "findings": [
    {
      "findingId": "F1",
      "claimClass": "defect" | "ambiguity" | "observation" | "blocker",
      "requirementClass": "routing",          // required iff claimClass === "defect"
      "location": { "raw": "Q7", "scope": "question" | "screen" | "route" | "survey" },
      "observable": {                          // required iff claimClass === "defect"
        "predicate": "route-destination-differs",   // CLOSED enum, §3.2
        "subject": "Q7 code 2",
        "expected": "…", "actual": "…"              // free text, ZERO matching weight
      },
      "readings": ["…", "…"],                  // required iff claimClass === "ambiguity", >= 2
      "attribution": "graph" | "model" | "graph-located-model-judged" | "unattributed",
      "evidence": [{ "kind": "dom" | "screenshot" | "trace" | "route" | "graph-edge", "ref": "…" }],
      "prose": "…",                            // human sentence. ZERO matching weight.
      "confidence": 0.0                        // recorded. ZERO matching weight.
    }
  ],
  "coverage": {
    "claimedUnits": [
      { "unitId": "U1", "location": "Q7",
        "status": "exercised" | "not-reached" | "proven-unreachable" | "blocked" | "budget-exhausted" | "pending",
        "verdict": "pass" | "fail" | "inconclusive" | "not-assessed" }
    ]
  },
  "selfReportedCost": { /* recorded, NEVER scored — see §3.4 */ }
}
```

### 3.2 The closed predicate enum

Free text cannot be a matcher. The predicate is the machine-comparable part of a finding and
it is drawn from a closed, versioned list:

`element-absent` · `element-present-unexpected` · `text-differs` · `option-absent` ·
`option-present-unexpected` · `option-order-differs` · `route-destination-differs` ·
`route-fired-unexpectedly` · `route-not-fired` · `terminate-not-triggered` ·
`terminate-triggered-unexpectedly` · `constraint-not-enforced` · `constraint-over-enforced` ·
`exclusivity-not-enforced` · `randomisation-absent` · `randomisation-present-unexpected` ·
`anchor-moved` · `value-differs` · `set-differs` · `set-order-differs` ·
`raw-code-displayed` · `denominator-differs` · `monotonicity-violated` ·
`state-retained-unexpectedly` · `state-cleared-unexpectedly` · `base-population-differs`

Each `requirementClass` admits a pinned subset (`evaluation/lib/class-map.mjs`). A predicate
outside its class's subset is a **schema error**, not a soft signal.

### 3.3 `attribution` — carried from the first run, not retrofitted

The owner is explicit: *"retrofitting it after the first run would mean re-running
everything."* So it is required from `1.0.0`.

| Value | Meaning |
|---|---|
| `graph` | derivable from structure alone — edge-set arithmetic, node inventory, reachability |
| `model` | required attribute judgement — wording, option semantics, label reading |
| `graph-located-model-judged` | **the seam.** The graph put the model in front of the node; the model made the call. If this bucket is empty for C, the hybrid is not hybridising |
| `unattributed` | the arm did not say |

Integrity rules, enforced by the scorer:

- Arm **A** may only emit `model`. Arm **B** may only emit `graph`. A violation is
  `ATTRIBUTION_IMPOSSIBLE` and invalidates the run — not the finding, the run. A condition
  that misreports its own mechanism cannot be trusted about the seam.
- `unattributed` findings **still score for recall** (we do not punish an arm's recall for a
  reporting gap) but are **excluded from the attribution table** and counted. A high
  `unattributed` count means the seam measurement is soft, and §5.5 requires the report to
  say so rather than print a confident table.

### 3.4 The harness's output — `evaluation/results/<arm>/<survey-id>.telemetry.json`

Written by the runner, never by the arm. This mirrors the trust boundary the repo already
operates (`scorer/docs/threat-model.md` §2): *"Agent-reported usage is ignored."*

Contains: the harness-observed **visit log** (every URL/screen the browser actually
rendered, with timestamps), model-call count and token totals as observed at the proxy,
browser sessions and actions, wall clock, budget-cap events, the arm's pinned version, and
the corpus survey's content hash.

**Arm-supplied `selfReportedCost` is recorded and never scored.** It exists only so the
report can show the delta between what an arm believed it spent and what it spent — which is
itself a small honesty signal.

---

## 4. Metrics

Notation: for survey *s*, `K(s)` = the key's planted defects after exclusions (§9.3);
`A(s)` = the key's planted ambiguities; `F(s,x)` = condition *x*'s findings on *s*.

### 4.1 Recall — the primary metric

```
recall(x) = |TP(x)| / |K|            aggregated over the whole corpus,
                                     NOT the mean of per-survey recalls
```

Aggregate over defects, not over surveys. Per-survey means would weight a 1-defect survey
equally with a 5-defect one, and the corpus deliberately varies defect count per survey. The
per-survey table is still reported — as a diagnostic, never as the headline.

`TP(x)` is produced by the matching rule in §5, and by nothing else.

Two variants are always reported together:

- **`recall_strict`** — matches confirmed by the observable predicate (§5.4). **This is the
  headline and the input to the decision rule.**
- **`recall_lenient`** — matches confirmed by location + class only.

`recall_lenient ≥ recall_strict` always. The delta is the volume of "right place, plausible
class, unverified consequence". Pre-committed: **if `recall_lenient − recall_strict` exceeds
the decision margin (§6.4) for any condition, the strict/lenient choice is itself deciding
the outcome, and the comparison is reported as `INCONCLUSIVE — MATCHING-SENSITIVE`.**

### 4.2 Recall decomposition — the most diagnostic number available

For every missed defect, the harness knows from its own visit log whether the arm was ever
*at* the locus:

```
missed(x) = never_visited(x)  ⊎  visited_but_missed(x)
```

- `never_visited` — the arm never rendered the screen the defect lives on. A **coverage**
  failure.
- `visited_but_missed` — the arm was on the screen and did not see it. A **judgement**
  failure.

This is the single most useful output of the whole experiment for the ablation question,
because it separates "the graph would have helped" from "the model would have helped" without
any inference. It is reported per condition **and per requirement class**.

### 4.3 False positives on clean controls — the headline safety number

At least 3 of the ~12 surveys are clean controls with zero planted defects. Which ones is
not disclosed.

**A false positive is:** a finding with `claimClass: "defect"` that, after one-to-one
assignment (§5.5), matches no key defect — on a clean control this is *every* defect
assertion by construction.

**A false positive is NOT:**

- a finding with `claimClass` of `ambiguity`, `observation`, or `blocker`. An arm that says
  *"I noticed X and cannot determine from the document whether it is wrong"* is behaving
  correctly. It earns no recall credit for it either.
- a defect assertion at a locus carrying a **confirmed planted ambiguity** — that is scored
  on the ambiguity track (§4.4) and is deliberately not double-counted.
- a defect assertion quarantined as a suspected corpus defect (§9.4).

Reported per condition, never as one number:

```
clean_control_fp(x)         = defect assertions on clean controls (the headline)
clean_control_clean_rate(x) = (# clean controls with ZERO defect assertions) / (# clean controls)
observation_volume(x)       = ambiguity + observation assertions, per survey
```

**The hedging guard.** The FP definition creates an obvious dodge: reclassify everything as
`observation` and take a perfect safety score with zero recall. Two things close it. First,
observations earn no recall, so the hedger's recall collapses — the self-test in §11.2
proves this. Second, `observation_volume` is reported beside the FP count, and a condition
emitting more than **0.5 × the key's `total_requirements_estimate`** observations on a
survey is flagged `HEDGING` in the report. Flagged, not silently folded in: the reader
decides.

**FP amplification — the ablation-appropriate safety rule.** Under a contest framing we
would disqualify an over-flagger. Under an ablation framing the useful question is *which
component generates the false positives*, so FPs are attributed exactly like TPs (§3.3). And
one hard rule survives:

> **If `clean_control_fp(C) > clean_control_fp(A) + clean_control_fp(B)`, the hybrid is
> amplifying rather than filtering. That is a reportable design failure (`FP_AMPLIFICATION`)
> and it is stated in the report headline regardless of what recall did.**

Also pre-committed, because 3 clean controls is a very small denominator: **1 false positive
across all clean controls is within noise; 2 is a pattern.** Any claim about a difference in
FP behaviour between conditions requires a gap of **≥ 2**. Below that, the report says the
conditions are indistinguishable on safety — which, given the denominator, will be the
honest answer more often than not.

### 4.4 Ambiguity — the counter-intuitive rule, stated so it cannot be softened

On a planted-ambiguity item the document genuinely does not resolve the case. The correct
outcome is **surface it as a question.**

| Outcome | Condition | Score |
|---|---|---|
| **CORRECT** | a finding at the locus with `claimClass: "ambiguity"` and **≥ 2 named readings** | `ambiguity_correct` +1 |
| **GUESSED** | any `defect` assertion, or any determinate `pass`/`verdict`, at the locus that presumes one reading | **FAILURE** — `ambiguity_guessed` +1 |
| **SILENT** | nothing at the locus | **FAILURE** — `ambiguity_missed` +1 |

> ### **GUESSING COUNTS AS A FAILURE EVEN WHEN THE GUESS IS RIGHT.**
>
> A lucky-right guess scores **exactly the same** as a wrong guess: zero credit,
> `ambiguity_guessed` incremented.

The justification, written now so that nobody has to reconstruct it later while staring at a
number they'd rather move:

The ground truth for a planted ambiguity is *"the document does not determine this."* An arm
that emits a determinate verdict has produced **an unsupported claim**. That the claim
happens to align with what the site does is a property of **the site**, not of the arm's
reasoning — the arm had no basis for the answer and got there by coincidence. Scoring it as
correct would reward, and if we ever tune on this metric would actively train, the exact
behaviour this project exists to prevent. The repo has already ruled on this in two places:
the architecture proposal's non-goals include *"silently resolving ambiguous or contradictory
questionnaire documentation"*, and the claim contract defines
`JUDGMENT_WITHHELD_AMBIGUOUS`.

**This is the rule most likely to be quietly softened later.** It is protected by: a
self-test (`lucky-guesser`, §11.2) that fails if a right guess ever earns credit; a mutation
(§11.3) that flips the rule and must turn the suite red; and the freeze hash (§8.2).

Ambiguity is scored on its **own track**. It never enters `recall`, defect precision, or the
site verdict — consistent with `scorer/docs/threat-model.md` §6 (*"Ambiguities and blockers
are reported separately and do not become defect false positives merely because no seeded
defect exists"*). Double-counting a guess as both an ambiguity failure and a defect FP would
make the ambiguity track's weight arbitrary.

Two further pre-commitments:

```
ambiguity_precision(x) = confirmed_ambiguity_loci_hit / total_ambiguity_assertions
```

An arm that flags everything ambiguous to dodge the FP metric shows up here.

**`AMBIGUITY_SHIELD`:** an ambiguity assertion at a locus carrying a **planted defect** counts
as a **miss** for that defect. It earns no recall credit and does not rescue the arm from the
miss. Shrugging at a findable defect is not caution.

### 4.5 Coverage honesty — claimed vs actual

An arm that says "checked everything" and did not is committing the exact failure this
project exists to prevent. The runner instruments the browser; **the arm cannot write the
visit log.**

```
claimed_exercised(x,s)  = { u ∈ coverage.claimedUnits : u.status === "exercised" }
witnessed(x,s)          = { u ∈ claimed_exercised : u.location ∈ harness_visit_log(x,s) }
unwitnessed(x,s)        = |claimed_exercised| − |witnessed|

coverage_honesty(x) = 1 − ( Σ_s unwitnessed(x,s) / Σ_s |claimed_exercised(x,s)| )
```

**Fail-closed, matching the repo's posture:** any condition with `coverage_honesty < 1.0` has
its coverage figure printed as `UNWITNESSED-n` and **cannot pass a coverage gate**. There is
no partial credit for a coverage claim that cannot be witnessed.

And the measurable coverage number, using a denominator the key actually pins down:

```
defect_locus_coverage(x) = |{ loci of K ∪ A visited by x }| / |K ∪ A|
```

Not "coverage of all requirements" — the key only carries a
`total_requirements_estimate`, and an estimate makes a dishonest denominator. Defect and
ambiguity loci are exactly enumerated, so that is what gets measured, and the report says so.

By construction B and C compute coverage and A attests it. **This metric is expected to
separate them; the point is to measure by how much, and to catch the case where a
computed-coverage arm's computation is also wrong.**

### 4.6 The seam — per-requirement-class attribution (PRIMARY OUTPUT)

Owner: *"that per-class attribution table is now a primary output, not a nice-to-have — it is
what tells us where to put engineering effort next."*

For every caught defect, credit the component named in `attribution`. Then, for each of the
16 requirement classes:

| Column | Meaning |
|---|---|
| `planted` | defects of this class in the corpus (post-exclusion) |
| `A caught` | model-only recall in this class |
| `B caught` | graph-only recall in this class |
| `C caught` | hybrid recall in this class |
| `C: graph` / `C: model` / `C: seam` | hybrid catches by attribution |
| `Δ graph = C − A` | what computed coverage adds, in this class |
| `Δ model = C − B` | what attribute judgement adds, in this class |
| `never_visited` / `visited_but_missed` | where the residual misses live |

The predicted seam — graph owns `routing`, `terminate`, `base-filter`,
`question-presence-order`, `quotas`; model owns `wording`, `option-list`, `option-order`,
`scale-labels`, `randomisation-anchors`, `exclusive-options`, `validation`, `piping`,
`carry-forward`, `progress-bar`, `back-navigation-state` — **is written here as a prediction
so it can be falsified.** A class where the predicted owner does not outperform the other
component is a finding about the architecture, and is reported as such.

**Statistical caution, pre-committed:** with ~12 surveys, most classes will carry **1–4
planted defects**. Per-class cells are therefore **descriptive, not inferential**. No
per-class difference may be called significant; no per-class comparison enters the decision
rule (§6). The report prints per-class counts as `n/N` with the raw integers visible and
**no percentages on cells where N < 5** — a percentage over 2 items is a lie with a decimal
point.

### 4.7 Cost

All from harness telemetry (§3.4):

```
tokens_in · tokens_out · model_calls · browser_sessions · browser_actions · wall_clock_ms
usd   = Σ (model calls priced against a PINNED price table)
```

If no pinned price table covers a model, `usd` is `null` — **never estimated.** The repo
already learned this (`docs/p0-adversarial-audit.md` Finding 14: ~70% of a reported cost was
price-verified and the gate did not distinguish).

```
cost_per_defect_found(x) = usd(x) / |TP(x)|
```

**Pre-committed:** when `|TP(x)| = 0` this is `null` — **not 0, not ∞.** Whether a
zero-detection arm looks infinitely expensive or perfectly cheap is a silent outcome-decider
and both renderings are wrong.

**Cost is a separate axis and is never blended into a quality score.** B has ~0 model calls
by construction; a blended score would hand it the experiment for free. Cost enters the
decision only at §6.5, as a tie-break, and only when quality is already inseparable.

Every condition runs under the **same hard budget ceiling** (§8.3). A condition that hits a
cap terminates and is scored as-is with `PARTIAL-BUDGET`; complete and partial runs are
reported as **separate cohorts** and never averaged together.

---

## 5. THE MATCHING RULE

This is the hard part, and it is where a sloppy harness silently decides the outcome. The
question is exact: **when does a reported finding count as having found planted defect D1?**

### 5.1 What has zero matching weight — stated first

Prose, severity, confidence, rationale, suspected cause, and **any string-similarity score**
carry **zero** matching weight. There is no fuzzy matcher, no similarity threshold, no
"near match", no margin-based credit, no Hungarian assignment over lexical scores anywhere
in defect credit.

This is not a preference. The repo already ran this experiment and lost: `docs/
structured-claim-contract-merged.md` §1 records the ruling — *"NO lexical fallback, similarity
score, threshold, margin, Hungarian assignment, or 'near match' anywhere in defect credit"* —
and §2 records that the lexical obligation matcher was **dropped** because it imported a
broken matcher into defect scoring.

### 5.2 M1 — the eligibility gate (deterministic, necessary, code-enforced)

A finding *f* is a **candidate** for key defect *D* only if **both** hold:

1. **LOCATION.** `normalise(f.location.raw) === normalise(D.location)`, using
   `pinned-locator-rules/1` — the locator canonicaliser already pinned in
   `scorer/docs/threat-model.md` §5.1, reused verbatim rather than reinvented. It gives
   `Q12 ≡ Question 12 ≡ q 12`, `S3 ≡ Screener 3`, `Loop L1 (Q2-Q3) ≡ L1 Q2-Q3`.
2. **CLASS.** `f.requirementClass ∈ eligibleClasses(D.class)` — the pinned map in §2.2.

Failing M1 is **not a match, full stop.** No prose can rescue it. Class agreement alone is
**never** sufficient: M1 is a gate, and §5.4 is what confirms.

**Non-atomic key locations.** Some defects are inherently cross-screen (a progress-bar
denominator; a rule that holds on five routes and breaks on the sixth). Pre-committed:

- If `D.location` parses to a **set or range** (`Q4-Q9`, `Q3,Q7`), M1 passes when `f`'s
  location is a member.
- If `D.location` is **`global`, `all`, or unparseable**, the location gate is **waived** and
  the pair goes **straight to adjudication (§7)**. It is never auto-credited. A waived gate
  that silently awards credit is how "checked everything" becomes true by fiat.

**Semantically equivalent locators the pinned rules don't cover** (an arm names a screen by
its heading rather than its number) produce `LOCATOR_UNRESOLVED` → **adjudication**, never a
silent miss. A matching rule that turns its own vocabulary gaps into the arm's recall loss is
measuring the rule, not the arm.

### 5.3 A finding correct but described differently from the key

Directly addressed, because it is the case most likely to be fudged.

**It matches.** If a finding passes M1 and §5.4 does not reject it, it is a true positive
**even when its prose shares not one word with the key's.** The key's `document_says` /
`site_does` are *human notes by the corpus author*; they are not the ground truth's identity.
Identity is (location, class, observable consequence). An arm that writes *"Q7 sends
respondents to Q9 instead of Q8"* and a key that reads *"skip lands one screen late"* are the
same defect and are scored as the same defect.

The corollary, which is the price: an arm that describes the **right location** with the
**right class** but the **opposite consequence** would be credited under M1 alone. §5.4
exists to catch that.

### 5.4 M2 — consequence discrimination (what confirms a match)

`recall_strict` requires the observable consequence to agree. The key does **not** carry a
typed predicate — its `site_does` is free prose — so we do not pretend to extract one from
text. Three deterministic tiers:

**Tier 1 — the finding has exactly one candidate defect.** If a finding passes M1 for exactly
one key defect, and `f.observable.predicate ∈ predicateSet(D.class)`, the pair is
**CONFIRMED**. Rationale: the corpus author planted one thing there of that class; the arm
found something of a compatible class there. The residual risk — right place, right class,
opposite direction — is real, is stated in §10.6, and is bounded by Tier 3.

**Tier 2 — the finding has several candidate defects.** Two or more key defects at one
location both admitting the same finding. The question *"which defect did this finding
find?"* has no deterministic answer, so the whole cluster goes to **adjudication (§7)**.
Nothing in a contested cluster is auto-credited to anybody.

> **Not Tier 2: several findings pointing at ONE defect.** That is duplication, not an
> identification ambiguity — every one of them names the same thing, so there is nothing to
> adjudicate. §5.5 rules on it: one true positive, the rest redundant.
>
> *An earlier draft of this section sent that case to adjudication too, contradicting §5.5.
> The `duplicator-cannot-inflate-recall` self-test failed and surfaced it before any arm ran.
> Recorded here rather than quietly corrected, because a pre-registration that hides its own
> revisions is not one — and because it is the clearest evidence available that the
> instrument can detect a fault in its own specification.*

**Tier 3 — the key-annotation file (`evaluation/key-annotations.json`).** An
adjudicator may record, at **scoring time**, the predicate a key defect *actually* implies:
`(surveyId, defectId) → predicate`. Where an annotation exists, Tier 1 additionally requires
`f.observable.predicate === annotation.predicate`, and a mismatch is a **rejection**, not an
adjudication — this is what closes the opposite-direction hole.

Constraints on annotations, pre-committed because this file is a possible cheat surface:

- It is **scorer-side only**, gitignored, and never reachable by any arm.
- It is **hashed into the scorecard**, so a scored result names the annotation set it used.
- It must be authored **without reference to any arm's output**. The scorer records
  `annotationsAuthoredBefore` (an ISO timestamp) and **warns loudly in the report** if any
  annotation postdates the first result file for the survey it covers.
- Absent annotations are **not** an error: those pairs fall back to Tier 1/Tier 2. Coverage of
  the annotation file is reported as a percentage, because low coverage means
  `recall_strict` is leaning on Tier 1 and is softer than it looks.

### 5.5 M3 — assignment, and the two cardinality cases

Candidates confirmed by M2 are resolved by **maximum-cardinality one-to-one bipartite
assignment** between findings and key defects, per survey. Never greedy. (Same discipline as
`scorer/docs/threat-model.md` §5.2, and for the same reason: greedy matching lets processing
order decide credit.)

**Two reports for one defect.** Exactly one is the true positive. Every other is
**`REDUNDANT`**: not a TP, not an FP, and **excluded from the defect-precision denominator.**
Duplicates therefore cannot inflate recall, and are not punished as fabrications. (Reused
verbatim from the repo's existing rule, threat model §6 — deliberately not softened and
deliberately not hardened.)

**One report covering two defects.** The format requires **one observable consequence per
finding**; splitting is the adapter's job. An unsplit finding is credited to **exactly one**
defect by the assignment, the other defect is a **MISS**, and the pair is logged as
**`UNDER_SPLIT`** in the adjudication queue so the reviewer sees the cost rather than the
scorer silently absorbing it. **No partial credit** — half a defect is not a unit anyone can
reason about, and "0.5 TP" propagating into a McNemar table is meaningless.

An arm that habitually under-splits will show a high `UNDER_SPLIT` count next to a low recall,
which is the correct diagnosis (a reporting-granularity problem, not a detection problem) and
is reported as such.

### 5.6 C-R construction — pinned, because it is a control and controls get bent

Let `P(s)` be C's principled traversal plan for survey *s*.

1. **Size unit: distinct node-visits (screens rendered)**, not path count. Paths vary in
   length; equal path-count would hand C-R more or fewer screens than C and the control would
   measure budget, not principle.
2. C-R draws paths uniformly at random from the space of **valid, executable** traversals
   until its node-visit count matches C's within **±10%**. A random *invalid* path is not a
   fair control — it would just measure error handling.
3. **Everything else identical**: same graph extraction, same model, same prompts, same
   attribute-judging step, same budget ceiling. **Only the path set differs.**
4. **Seeds are pinned** per `(surveyId, repeat)` and recorded in the telemetry.
5. **R = 3 seeds per survey.** Random traversal is high-variance; comparing a deterministic
   condition against a single random draw would be indefensible. C-R's score is the **mean
   over seeds**, and the **min–max range is always printed beside it**. A C-vs-C-R conclusion
   is not reported if C's score falls inside C-R's observed range.
6. If the realised node-visit ratio falls outside `[0.9, 1.1]` for a survey, that survey is
   **excluded from the C-vs-C-R comparison only** and listed by ID.
7. Budget consequence: C-R costs ~3× a single condition. Accounted for in §8.3.

---

## 6. THE DECISION RULE — fixed in advance

The owner's ruling replaces "which arm scores highest" with three ablation questions, plus the
control. All four are pre-specified; nothing else may be promoted to a headline afterwards.

### 6.1 The four pre-committed comparisons

| ID | Comparison | Question it answers |
|---|---|---|
| **H1** | **C vs A** | What does the **graph** add — principled coverage and traversal — over model-only? |
| **H2** | **C vs B** | What does the **model** add — node-attribute judgement — over graph-only? |
| **H3** | **C vs max(A, B)** | Is the **hybrid** better than the best single component by more than noise? |
| **H4** | **C vs C-R** | Is **principled traversal** doing the work, or is the benefit merely browsing more? |

Primary metric for all four: **`recall_strict`**, on the shared post-exclusion defect set.

### 6.2 The test — paired, because the conditions see the same defects

Unpaired proportion tests throw away the pairing and are underpowered here. For a comparison
X vs Y over the same defect set, count the **discordant** defects:

```
b = found by X, missed by Y
c = found by Y, missed by X
```

and compute the **two-sided exact McNemar** p-value, `p = 2 · P(Binom(b+c, 0.5) ≥ max(b,c))`,
capped at 1.

### 6.3 Multiplicity

Four pre-specified comparisons. **Holm–Bonferroni adjustment across all four**, applied to the
unadjusted exact p-values. Both unadjusted and adjusted p are reported. **The decision uses the
adjusted p.**

This is deliberately costly. With n≈12 surveys the study is powered only for large effects,
and pretending otherwise by reporting four unadjusted p-values would be the statistical
version of the `passed: true` literal.

### 6.4 The margin — X beats Y iff BOTH hold

1. **Holm-adjusted two-sided exact McNemar p ≤ 0.05**, and
2. **b − c ≥ 5** — an absolute floor, so that a statistically detectable but practically
   trivial gap does not decide an architecture.

Condition 2 exists because significance and importance are different questions, and 12
surveys is a small sample where a two-defect gap is noise. Owner brief: *"a two-defect gap is
noise."* Encoded.

**What the margin costs, tabulated so nobody is surprised later.** Minimum `b` required at the
most stringent Holm step (α = 0.0125), computed exactly — not estimated:

| c (found by Y, missed by X) | minimum b to declare X > Y |
|---|---|
| 0 | **8** |
| 1 | **10** |
| 2 | **13** |
| 3 | **15** |

At the least stringent Holm step (α = 0.05) the thresholds are b ≥ 6 at c = 0, b ≥ 8 at
c = 1, b ≥ 10 at c = 2, b ≥ 12 at c = 3 — with the absolute floor `b − c ≥ 5` binding
underneath. The full table is Appendix A, and a self-test asserts the scorer reproduces it
(`mcnemar-thresholds-match-appendix`), because a decision rule whose published thresholds
disagree with its code is not a pre-registration.

**This is a demanding bar and it may well not be cleared.** That is the correct consequence
of a 12-survey corpus, and it is stated here so that "inconclusive" reads as the pre-registered
outcome it is rather than as a failure of the experiment.

### 6.5 Ties and tie-breaks

If a comparison does not clear §6.4, it is **INCONCLUSIVE on recall**. Only then, in this
fixed order, and only for the *descriptive* narrative — a tie-break never converts an
inconclusive comparison into a declared difference:

1. **clean-control false positives** — lower wins, gap must be **≥ 2** (§4.3);
2. **ambiguity handling** — higher `ambiguity_correct`, gap must be **≥ 2**;
3. **coverage honesty** — a condition below 1.0 cannot win this tie-break;
4. **cost per defect** — lower wins, and only when **≥ 2× cheaper**.

If none separates them, the comparison is **DECLARED INCONCLUSIVE** and written up as such.

### 6.6 `HYBRID_REGRESSION` — the rule that is hostile to the expected winner

C should dominate its own components. Compute:

```
regression_set = ( TP(A) ∪ TP(B) ) \ TP(C)
```

Defects that a component found and the hybrid did not. **A non-empty regression set means the
hybrid is losing information one of its halves already had.**

Pre-committed: `|regression_set| ≥ 3` is a **design defect in C**, reported in the headline
with the defects enumerated, **regardless of what recall did.** A hybrid that wins on totals
while dropping three things its graph already knew has a seam bug, and the totals hide it.

### 6.7 What makes each conclusion

| Conclusion | What produces it |
|---|---|
| **The graph contributes** | H1 clears §6.4; and the gain concentrates in structural classes (`routing`, `terminate`, `base-filter`, `question-presence-order`, `quotas`); and C's `never_visited` misses are materially fewer than A's |
| **The model contributes** | H2 clears §6.4; and the gain concentrates in attribute classes (`wording`, `option-list`, `option-order`, `scale-labels`, `randomisation-anchors`, `exclusive-options`, `validation`, `piping`, `carry-forward`); and the `graph-located-model-judged` bucket is non-empty |
| **The hybrid is the right destination** | H3 clears §6.4, `regression_set` is empty or trivial, `coverage_honesty(C) = 1.0`, and `clean_control_fp(C) ≤ min(A, B)` |
| **Principled traversal is real** | H4 clears §6.4, and C's score sits outside C-R's min–max range |
| **THE GRAPH'S TRAVERSAL CLAIM IS DECORATIVE** | H4 does not clear. **We write that sentence.** The graph may still earn its place on coverage *accounting* (`coverage_honesty`, `never_visited`) — those are different claims and are reported separately |
| **The seam is wrong** | a predicted-owner class where the other component outperforms; reported per class, descriptively |

### 6.8 What makes the whole experiment inconclusive — written honestly

This is a real possible outcome, not a hedge. Any one of these makes it so:

- **Queue domination (§7.3)** — the adjudication queue is large enough that resolving it the
  other way flips a comparison. This is code-enforced and overrides every point estimate.
- **Matching sensitivity (§4.1)** — `recall_lenient − recall_strict` exceeds the margin, so
  the strict/lenient choice is deciding the result.
- **No comparison clears §6.4** — the most likely single outcome at n = 12, and it means the
  data cannot separate the architectures.
- **Maturity precondition unmet (§8)** — any condition not at comparable maturity makes the
  entire run a `PILOT`, and pilots produce **no** headline.
- **Exclusions ≥ 20% of planted defects** (§9.3) — too much of the corpus removed for the
  remainder to represent it.
- **Taxonomy gaps ≥ 20% of findings** — the shared vocabulary is wrong and the seam table
  cannot be trusted.
- **`ATTRIBUTION_IMPOSSIBLE` on any run** — a condition misreported its own mechanism.
- **A suspected oracle leak (§8.5)** — blindness compromised; that condition's numbers are
  void.

When the experiment is inconclusive, the report says **"the experiment did not decide"** and
the architecture choice reverts to the owner on non-empirical grounds (maintainability, cost
predictability, auditability). Pre-committed: we do **not** narrate a winner out of a
non-significant gap. That is exactly the failure this document exists to prevent.

---

## 7. The adjudication queue

### 7.1 What goes in it

Findings the rule cannot confidently match go to `evaluation/results/adjudication-queue.json`
rather than being silently scored either way:

| Code | Cause |
|---|---|
| `LOCATION_WAIVED` | key location is `global`/unparseable (§5.2) |
| `LOCATOR_UNRESOLVED` | semantically plausible locator outside `pinned-locator-rules/1` |
| `MULTI_CANDIDATE` | Tier-2 cluster — several defects/findings at one locus (§5.4) |
| `UNDER_SPLIT` | one finding appears to cover several defects (§5.5) |
| `PREDICATE_UNANNOTATED` | strict confirmation needs an annotation that does not exist |
| `TAXONOMY_GAP` | class outside the 16 |
| `SUSPECTED_CORPUS_DEFECT` | a clean-control assertion made independently by ≥ 2 conditions (§9.4) |

Each entry carries: survey, condition, finding ID, candidate key defect IDs, the code, and the
computed facets — so a human can decide from the record without re-reading raw output.

### 7.2 The queue size is a reported headline, not a footnote

> **A large queue means the matching rule is weak and the numbers are soft, and the harness
> must SAY so rather than hiding it in a confident total.**

The scorecard carries `adjudicationQueueSize` and `adjudicationRate = queue / total findings`
at the **top** of the summary, beside recall. The report template (§REPORT-TEMPLATE) puts it
in the first table.

### 7.3 Swing dominance — the strongest anti-fudge rule in this document, CODE-ENFORCED

For each comparison, the scorer computes the result **three times**:

- **(a)** every queued item resolved in X's favour,
- **(b)** every queued item resolved in Y's favour,
- **(c)** every queued item resolved as adjudicated (or, before adjudication, as *not* a
  match — the conservative reading).

> **If the outcome of the comparison differs between (a) and (b), the comparison is
> `INCONCLUSIVE — QUEUE-DOMINATED` and NO point estimate may be reported as the result.**

The point estimate is still printed — labelled, beside the swing bounds, and explicitly
marked as not the finding. This makes it structurally impossible to publish a confident
number that a handful of judgement calls could reverse.

### 7.4 Adjudication discipline

- Every decision is written **with a reason, before the aggregate is computed**. The scorer
  refuses to compute a headline from a queue containing an entry that is resolved but has no
  `reason` string.
- Decisions are appended to `evaluation/results/adjudication-log.json`, append-only, with
  timestamps.
- The adjudicator sees the finding's **facets and the candidate key IDs — not which condition
  produced it.** The scorer emits a blinded queue view (`--blind-queue`) that strips `arm`.
  This is weak blinding (a single owner may infer the source from style) and §9.5 says so.

---

## 8. Fairness controls

### 8.1 Identical everything

- **Identical corpus.** All conditions run every survey in `test-suite/blind/batch-2/`. No
  condition skips a survey it finds hard; a survey it cannot process is a run failure, scored
  as zero findings with a `blocked` disposition, not an exclusion.
- **Identical inputs.** Same `questionnaire.docx` bytes (hash recorded in telemetry), same
  served `site/`, same seed where the site is seeded.
- **THE SHARED-INGESTION CONTROL — this one is load-bearing.** All conditions **must use the
  identical document-ingestion module.** The corpus brief pushes hard on requirements living
  in exotic `.docx` parts (footnotes, headers, comments, `numbering.xml`, image alt text), and
  the repo's production parser is known to read only `word/document.xml`. If conditions use
  different parsers, this experiment measures **docx parsers** and reports the result as an
  **architecture** difference. That would be a wrong answer delivered confidently.
  - If shared ingestion turns out to be impossible, the fallback is pre-committed: the primary
    comparison is restricted to defects with `requirement_source: "body"`, the full-corpus
    numbers are reported as secondary, and the stratification by `requirement_source` is
    printed in full.
- **Identical budget ceiling** (§8.3), enforced by the runner, not by the arm.
- **No condition is tuned on the corpus after seeing any result.** Version pins (§8.4) make a
  violation visible.

### 8.2 THE FREEZE

**The harness is FROZEN once the first condition runs.**

At the first scored run the runner writes `evaluation/FREEZE.json` containing SHA-256 of:
`PRE-REGISTRATION.md` · `score.mjs` · `lib/class-map.mjs` · `finding-schema.mjs` ·
`exclusions.json` · `budget.json`.

The scorer **recomputes these hashes on every scoring run and refuses to score** if any
differs. Override requires `--amend "<written reason>"`, which appends to an append-only
`evaluation/AMENDMENTS.md` **and** causes every amendment to be printed in the final report.

There is no silent edit path. Changing the scorer after seeing results is permitted — it is
sometimes necessary — but it is permanently visible.

### 8.3 Budget ceiling — ratified before the first run, then frozen

`evaluation/budget.json`, identical for every condition:

```jsonc
{ "maxUsdPerSurvey": null, "maxWallClockSecondsPerSurvey": null,
  "maxModelCalls": null, "maxBrowserActions": null, "maxNodeVisits": null }
```

**Deliberately `null` — these are owner ratifications, not my numbers.** The runner refuses
to start a scored run while any cap is `null`. A condition hitting a cap terminates and is
scored `PARTIAL-BUDGET`; partial and complete runs are separate cohorts (repo's existing
rule). C-R's 3 seeds multiply its total spend, not its per-run cap.

### 8.4 Blindness to the keys

- The runner never passes a `truth/` path to any condition and asserts the arm's declared
  filesystem scope excludes it.
- The scorer reads keys; **no arm ever does.** Only the scorer process touches `truth/`.
- **Oracle-leak check at scoring time.** A finding whose prose contains a key **defect-ID
  token** (`D1`, `A2`), a key-only field value (a `difficulty` enum, a
  `requirement_source` token), or a verbatim ≥ 8-word span from `how_to_observe` is flagged
  `SUSPECTED_ORACLE_LEAK` and that run is **quarantined**. Deliberately scoped to key-only
  strings: `document_says` may legitimately quote the questionnaire, which every arm is
  entitled to read, so it is excluded from the check. `difficulty` values are excluded too —
  they are ordinary English words and would fire on honest prose.
  - **False-alarm risk, stated:** a token like `D1` could in principle appear in a survey's
    own answer codes. The check is therefore **reviewable, not an automatic void**: a
    quarantine is recorded as a queue entry and the owner may clear it with a written reason
    that appears in the report. A quarantine that is never reviewed stands.

### 8.5 Author independence — stated, not solved

The arms, the harness, and this pre-registration were written by the same agent-and-owner
pair. That is a real, unmitigated confound (§9.5). What this document can do is make every
judgement call **visible and dated**, which is what §7.4, §8.2 and §5.4 are for. Blinding the
adjudicator in a single-owner project is not achievable; the audit trail is the substitute and
it is a weaker one.

---

## 9. THE MATURITY PRECONDITION — and it now cuts both ways

### 9.1 The threat

Arm A has weeks of work behind it. Arm B is a days-old spike: `graph-spike/crawl.mjs` is 600
lines of real, thoughtful code — with a genuine page-blinding guard, numeric bisection for
routing breakpoints, and a history-dependence probe — but **it has no entrypoint, it is wired
to nothing, and `graph-spike/out/` is empty.** It recovers a graph; it compares nothing.

**Running the conditions today would produce a false result.** The measurement would be of
build progress, and it would be reported as a measurement of architecture.

### 9.2 It cuts both ways — the owner's point, and it is the sharper one

Under the old contest framing, an underbuilt B would understate B. Under the ablation framing:

> **An underbuilt graph half understates the HYBRID.** C depends on the graph for its coverage
> floor and traversal plan. A weak graph makes C look weak, makes H1 (what the graph adds)
> look like nothing, and would produce the specific wrong conclusion **"the graph contributes
> little"** — about the component the destination architecture is built on.

An immature graph therefore threatens the *destination*, not merely one contestant. That
raises the cost of running early rather than lowering it.

### 9.3 Comparable maturity — an operational checklist, not a judgement call

Every condition must pass **all** of these, evidenced, before any scored run:

| # | Gate | Evidence |
|---|---|---|
| M1 | **Runs unattended end-to-end**, 3 consecutive times, on ≥ 2 non-corpus smoke surveys (`test-suite/branching/`, `pipeline/runs/synthetic-demo/`), zero human intervention | 3 result files per survey |
| M2 | **Emits the normalised format** and passes `validate-findings.mjs` with zero schema errors | validator exit 0 |
| M3 | **Emits reconcilable cost telemetry** the runner can attest | telemetry file with non-null totals |
| M4 | **Frozen version pin** — commit SHA recorded in the run manifest before any corpus survey runs | `armVersion` in every result |
| M5 | **No arm-specific code in `score.mjs`** | grep: zero occurrences of `"A"`/`"B"`/`"C"` as control flow |
| M6 | **Author declares no further changes**, dated, recorded in `evaluation/MATURITY.md` | signed line |
| M7 | **Detection parity floor** — on a *known-defective* smoke survey the condition produces **≥ 1 correctly matched finding**. An arm that cannot find a defect it was shown is not ready to be measured against one it wasn't | scorer output on smoke |
| M8 | **For C and C-R only:** the `graph-located-model-judged` bucket is non-empty on smoke. A "hybrid" whose seam never fires is arm A or arm B wearing a label | attribution counts |

### 9.4 Until then: `PILOT`

Runs before all conditions clear §9.3 are permitted and encouraged — that is how the harness
gets debugged. But:

- pilot output goes to `evaluation/results/pilot/**`;
- **the scorer refuses to emit a headline comparison from pilot data** (code-enforced, not a
  convention);
- pilot numbers may not be cited as a result, in any document.

---

## 10. Honesty statements — the things that are wrong with this experiment

Stated plainly, as required, and *before* any number exists to be defended.

### 10.1 The sample is small

~12 surveys, likely 30–50 planted defects. The decision rule (§6.4) is calibrated to that and
is demanding as a result. **Most plausible outcomes of this experiment are inconclusive.**

### 10.2 The clean-control denominator is the weakest number in the study

The false-positive rate — **the headline safety metric, the one the owner cares most about**
— is measured on **3 surveys.** A single accidental FP moves it by 33%. This is the most
important number here and the least well-powered, and no amount of presentation fixes that.
It is why §4.3 requires a gap of ≥ 2 before any FP difference may be called real.

### 10.3 The corpus was built by one process and carries its bias

A single (non-Claude) process planted every defect. It will find some defects natural to plant
and others not, and the corpus therefore samples the *defect space that process imagines*, not
the defect space real fieldwork produces. Two specific, foreseeable distortions:

- **Over-representation of exotic-`.docx`-part requirements.** The brief pushes hard on
  footnotes, headers, comments and `numbering.xml`. Without the shared-ingestion control
  (§8.1) this experiment would grade **parsers** and label the result **architecture**.
- **Defects planted to be *findable by the method the author imagined*.** A defect the author
  could not think of how to observe probably did not get planted, which systematically favours
  observable-by-crawl defects — plausibly favouring the graph conditions.

Neither is correctable from inside the experiment. Both are reported.

### 10.4 Clean controls may contain accidental defects

The corpus builder was told to flag anything it was unsure about. Three mechanisms:

1. **Exclusions.** Any key item flagged uncertain / arguably-compliant, or listed in
   `evaluation/exclusions.json` with a written reason, is removed from **both numerator and
   denominator**, listed by ID with its reason, and counted as a headline. Exclusions filed
   **after** the first scored run require a dated written justification printed in the report.
   **If exclusions reach 20% of planted defects the experiment is inconclusive (§6.8).**
2. **Cross-condition quarantine.** A clean-control defect assertion made **independently by
   ≥ 2 conditions**, agreeing on location and class, and **evidence-backed on both sides**, is
   quarantined as `SUSPECTED_CORPUS_DEFECT`, removed from every condition's FP count, and
   reported as an open corpus item. Capped at **3 per corpus**; beyond the cap they count as
   FPs for everyone. The cap exists because the conditions are **not independent** — they
   share authors, ingestion, and in C's case both other halves — so agreement is much weaker
   evidence of a corpus defect than it would be between genuinely independent systems.
3. **Symmetry.** The quarantine rule is applied by the scorer identically to every condition,
   from a queue view blinded to `arm`.

### 10.5 The arms' authors are not independent of the system under test

The same agent-and-owner pair wrote the conditions, this pre-registration, and the scorer.
There is no independent evaluator. The mitigations — pre-registration before results, a
code-enforced freeze, an append-only amendment log, dated annotations, a blinded queue view —
reduce the *opportunity* for post-hoc shaping. **They do not make the evaluation independent,
and this document does not claim they do.**

### 10.6 Known residual weaknesses in the matching rule itself

- **Tier-1 direction risk (§5.4).** Where no annotation exists, a finding at the right place
  with a compatible class is credited even if it describes the opposite consequence.
  Annotation coverage is reported; low coverage means `recall_strict` is softer than the name
  suggests.
- **The key's `location` field is prose.** Non-atomic and global locations are handled by
  waiver-to-adjudication, which converts a matching weakness into queue size — visible, but it
  does inflate the queue, and queue size is itself a reported weakness signal.
- **The 16-class vocabulary is the owner's, adopted for interoperability with GPT-5.6-sol's
  seam analysis, and is not derived from the corpus.** Mismatches surface as `TAXONOMY_GAP`.
- **`attribution` is self-reported by the arm.** The scorer enforces only the impossibility
  constraints (§3.3); it cannot verify that a finding C labelled `model` truly required model
  judgement. The seam table is therefore **as honest as the arms are**, and that limitation
  belongs on the table itself.

---

## 11. Proving the instrument can fail

A scorer that cannot return a bad verdict is not a scorer. Three layers, all in
`evaluation/selftest/`, all against **fabricated keys authored for the tests** — no corpus key
is read by any self-test.

### 11.1 The requirement

`node evaluation/selftest/run.mjs` exits non-zero if any assertion fails. It must be run, and
must be green, before the first scored run; its result hash goes in `FREEZE.json`.

### 11.2 The fabricated conditions and what each proves

| Fixture | What it emits | What must be true — the assertion that makes the test real |
|---|---|---|
| `perfect` | one correct finding per defect, one ambiguity per ambiguity, nothing on clean controls | recall = 1.0; FP = 0; `ambiguity_correct` = all; queue small |
| `useless` | nothing at all | recall = 0; **FP = 0** — and `perfect` must still outrank it. *This is what proves FP alone cannot be the ranking* |
| **`overflagger`** | a defect at **every** location, including all clean controls | **must score BADLY.** High `clean_control_fp`; `FP_AMPLIFICATION`-class safety failure; ranks below `useless` on safety. **If an over-flagger does not score badly, the false-positive weighting is broken and this test fails the build** |
| **`lucky-guesser`** | guesses every planted ambiguity as a defect, and **every guess happens to match the site** | `ambiguity_correct` = 0; `ambiguity_guessed` = n. *This is the test that proves the counter-intuitive rule in §4.4 is actually implemented and not merely written down* |
| `hedger` | everything as `observation`/`ambiguity` | FP = 0 **and** recall = 0 **and** `HEDGING` flagged; does not outrank `perfect` |
| `duplicator` | two findings per defect | recall unchanged; `REDUNDANT` counted; precision denominator reduced; **no FP inflation** |
| `under-splitter` | one finding covering two defects at one locus | exactly 1 TP; 1 miss; `UNDER_SPLIT` queued; **no partial credit** |
| `coverage-liar` | claims every unit exercised; telemetry shows 2 screens visited | `coverage_honesty < 1`; `unwitnessed > 0`; **coverage gate fails** |
| `wrong-direction` | right location, right class, opposite predicate, with an annotation present | rejected under `recall_strict`; credited under `recall_lenient`; delta visible |
| `queue-dominated` | a pair of conditions whose comparison flips under swing | `INCONCLUSIVE — QUEUE-DOMINATED`; **no point estimate emitted as the result** |
| `attribution-liar` | Arm B emitting `attribution: "model"` | `ATTRIBUTION_IMPOSSIBLE`; run invalidated |
| `leaker` | prose containing a key defect-ID token | `SUSPECTED_ORACLE_LEAK`; run quarantined |

### 11.3 Mutation — the layer the repo's existing scorer lacks

Breadth over a threat list is not enforcement strength; the repo measured **~45% kill rate**
with 16 gates individually deletable while everything stayed green. So this harness ships a
mutation harness **with** its self-tests rather than after them.

`node evaluation/selftest/mutate.mjs` applies each named mutation to the scorer's logic and
asserts **at least one self-test turns red**. A surviving mutant is a gate nothing tests.

Mutations, one per load-bearing rule:

`ambiguity-guess-counts-as-correct` · `fp-weight-zero` ·
`lenient-matching-as-default` · `queue-items-silently-scored-as-matches` ·
`swing-check-disabled` · `duplicate-findings-inflate-recall` ·
`under-split-awards-partial-credit` · `coverage-claim-trusted-from-arm` ·
`freeze-hash-check-bypassed` · `mcnemar-margin-dropped` ·
`clean-control-fp-ignored` · `attribution-constraint-dropped` ·
`per-survey-mean-instead-of-aggregate-recall` · `cost-per-defect-zero-when-no-tp`

**The kill rate is reported.** A mutation that survives is named in the report as a gate this
suite does not enforce — the same disclosure `scorer/docs/threat-model.md` §11 makes about the
existing suite, made in advance rather than after an audit.

---

## 12. Order of operations

1. Owner ratifies `budget.json` (§8.3) and reviews this document.
2. Self-tests + mutation green (§11).
3. Conditions reach comparable maturity; `MATURITY.md` signed (§9.3).
4. Pilot runs → `results/pilot/` to debug the harness. No headline.
5. **FREEZE** (§8.2) at the first scored run.
6. Scored runs, all conditions, whole corpus; C-R × 3 seeds.
7. Adjudicate the queue with written reasons, before aggregates (§7.4).
8. Score. Swing analysis. Fill `REPORT-TEMPLATE.md`.
9. Publish corpus and results together (`docs/EVALUATION-BOUNDARY.md` phase 2).

---

## Appendix A — the exact McNemar thresholds

`p = 2 · P(Binom(b+c, 0.5) ≥ max(b,c))`, capped at 1. Minimum `b` to declare a difference:

Minimum `b` to declare a difference, at each of the four Holm steps, with the absolute floor
`b − c ≥ 5` already applied:

| c | α = 0.05 | α = 0.025 | α = 0.0167 | α = 0.0125 (most stringent Holm step) |
|---|---|---|---|---|
| 0 | 6 | 7 | 7 | **8** |
| 1 | 8 | 9 | 10 | **10** |
| 2 | 10 | 11 | 12 | **13** |
| 3 | 12 | 13 | 14 | **15** |

The scorer computes the exact p-value; this table exists so the demands of the rule are
legible **before** anyone sees a b and a c they have feelings about.

**These values were computed, not estimated.** A first draft of this table was written by
hand and was wrong in four cells — every error in the direction of making the rule look
*easier* to clear than it is. That is precisely the failure mode this document is about, it
happened while writing the document about it, and the correction is why
`evaluation/selftest/cases.mjs` now asserts the scorer reproduces this table cell by cell.
A published threshold that disagrees with the code is not a pre-registration.
