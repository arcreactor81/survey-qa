# P0 Adversarial Audit — the measuring apparatus

**Scope.** Twelve independent hostile lenses were run against the P0 test bed (corpus, oracle builder, scorer, schemas, fixtures, integration proof, and the design/UI/research docs). Every claim was then put through a second, independent refutation pass. This document reports only what survived refutation, plus the claims that were killed and why.

**Date:** 2026-08-01. **Tree:** `E:\survey-qa`, master. Audit was read-only; all experiments ran in a scratch copy.

**The promise under test.** This apparatus must make it impossible for a tested agent to look good without actually testing the survey, and must not punish an honest agent that tests it well. Both failure directions were attacked.

**Relationship to the fix round already underway.** Twelve defects were already known and are being fixed. Findings below are *additive* to that round unless explicitly marked as an extension of a known item. Where a finding changes the character of a known item — from "tune a number" to "change the contract" — that is called out, because it changes what the in-flight fix has to be.

---

## 1. Verdict

**Push recommendation: safe to push after the listed fixes.**

Nothing here is a security or privacy problem. There is no credential of value in the tree (the committed signing key is correctly labelled test-only), no customer data, no third-party content. The reason to hold is different: **several documents make claims about the apparatus that the apparatus does not deliver**, and publishing them publishes the false claim. Three things should change before the repo is public:

1. **Correct the overclaiming lines** (§6, "Documentation that is not true"). Four specific sentences currently assert guarantees the code does not provide. They are cheap edits and they are the only genuine publish-blockers.
2. **Remove the fail-open default signing key** (Finding 13). A public repo ships a scorer that, invoked exactly as its own integration proof invokes it, trusts a key whose private half is in the same repo.
3. **Pin line endings** (Finding 17a). A fresh Windows clone of the public repo silently invalidates all twelve ground-truth records while git reports a clean tree. Every honest run then scores zero. This is the single worst first-impression bug for an outside reader.

Everything else is a correctness and calibration roadmap that can land after publication. But do **not** ratify the P1 extraction-accuracy threshold on this corpus until Findings 1, 4, and 7 are resolved — that number, measured today, does not mean what the phase gate says it means.

**The one-sentence summary.** The plumbing is genuinely good: attestation, canonicalization, fail-closed ordering, evidence hashing, and the coverage/completion split all held up under direct attack. The *judgement layer* — deciding whether a piece of agent text is the same thing as a piece of ground truth — is doing work that lexical string similarity cannot do, and it fails in both directions at once: fabricated findings get full credit while accurate, specific findings are recorded as fabrications.

---

## 2. Ranked findings

Severity is the corrected severity after refutation, not the original claim.

---

### 1. A tester can get a perfect defect score by paraphrasing the questionnaire, while a tester that actually found the bug is recorded as having made it up

**Severity: critical.** Directions: agent-can-game **and** honest-agent-penalized, simultaneously.
**Where:** `scorer/src/lib/defect-match.mjs:127-131` (scoring), `:177-199,221` (duplicate policy), `:184` (redundancy gate).
**Confidence: confirmed** — demonstrated end-to-end through the real scorer against the real `s1-skip.flawed` ground truth.

**What it does now.** When an agent reports a bug, it writes two sentences: what the document says should happen ("expected") and what the site actually did ("observed"). The scorer decides whether that report matches a real planted bug by measuring **word overlap** against two reference sentences. Nothing checks that the "observed" sentence describes something the agent actually saw, that it is about the right thing, or even that it is not the exact opposite of the truth.

Both reference sentences are derivable from the questionnaire document alone: the "expected" side is the document text verbatim, and the "observed" side follows a predictable template ("X is missing from … on the site"). So an agent that reads the Word document, emits one plausible "bug" per line of it in the corpus's own terse register, and does one shallow walk of the site scores **3/3 defect recall and 1.0 precision**. It never has to observe a single defect.

Worse, the shotgun is free. Extra fabricated reports for a bug that is already credited get reclassified as "redundant" and are **removed from the precision denominator**, so spraying one fake bug per document line costs nothing.

And the honest direction fails at the same time. On the real planted defect S1-E02 (a missing brand option), the specific, correct finding — *"Q3 should offer BIMZELX as the fifth brand option" / "Q3 rendered only four brands; BIMZELX is absent"* — scores **0.226 and is recorded as a false positive**. A content-free finding that says almost nothing — *"Q3: Option 5" / "Q3 option list on the site."* — scores **0.525 and is credited as a true positive**. Generic boilerplate ("Q3 is wrong" / "Q3 is wrong on the site", 0.253) also beats the honest text on both axes.

**Why no threshold fixes it.** The ranking is inverted, not merely miscalibrated. The vacuous text sits *above* the honest text, so there is no cut point that admits the honest finding and excludes the content-free one. This is the finding that upgrades known items #10 and #11 from "tune the numbers" to "change the contract" — the in-flight fix round cannot close this by recalibration, and if it lowers the thresholds to admit honest prose, boilerplate is admitted first and precision collapses.

**Failure scenario.** An agent reads `questionnaire.docx`, emits one fabricated defect per routing rule and option line using document text as "expected" and a template sentence as "observed", attaches them to items it walked once, and submits. It gets a perfect defect score. An agent that actually drove the survey and wrote accurate, specific prose gets 1/3 and is told it fabricated two findings.

**Fix — Tier 1, contract change. Owner decision required.** Stop deriving bug identity from free text. Make the "observed" side a structured, checkable claim: `{kind: "missing-option", question: "Q3", option: "BIMZELX", presentOnSite: false}` rather than a sentence. Score the observed side by typed agreement; keep word similarity only for human-readable reporting. A guard was tested and rejected: requiring the observed side to resemble the observed reference more than the expected reference catches the spec-restatement case but **does not catch an inverted claim** ("BIMZELX is present…" scores 0.616 vs 0.252 — it looks maximally correct). Do not ship a lexical patch here.

**Two immediate mitigations while the contract change lands (code-only):** (a) stop removing "redundant" findings from the precision denominator unless they are near-identical to the credited one — as shipped, four mutually contradictory claims are all treated as honest duplicates of each other; (b) fix the narrower bug at `defect-match.mjs:184` where a correct-but-unmatched finding cannot be reclassified as redundant even when a credited match for the same defect exists — that is precisely what turns the honest report into a scored fabrication.

---

### 2. The check that is supposed to prove the agent knows *where* things are can be passed by an agent that has no idea

**Severity: high.** Direction: agent-can-game.
**Where:** `scorer/src/lib/matcher.mjs:170-190` (verified: takes the maximum over every pairing of labels), `:187` (drops the quote term when either side has none), `MATCHER_PROFILE` at `:53-68`; `scorer/schemas/run-record.schema.json:158` (no limit on the number of alternate names).
**Confidence: confirmed** — demonstrated end-to-end against the real `s1-skip.flawed` ground truth.

Two independent holes, same consequence.

**(a) Unlimited alternate names, scored by best-of.** Each checklist item carries a location label plus an unbounded list of alternate labels. The scorer takes the *best* pairing across the whole cartesian product, so adding more labels can only ever raise the score, never lower it. A junk bag of generic survey vocabulary buys the location credit outright. Demonstrated: a run whose entire location information is content-free (label "Z0", quote "see questionnaire") scores **0 without a bag and 0.944 with one — exactly equal to the honest, correctly-located run** — and per-item it *beats* the honest agent on every obligation whose reference has no quote. No knowledge of the hidden ground truth is needed; a 203-entry bag built from generic survey words, with every exact ground-truth string removed, already reaches 17 of 18.

**(b) Location is never a gate at all.** The requirement text is weighted 0.55 and the eligibility bar is 0.55 — exactly equal (verified in the frozen profile). So reproducing the requirement sentence alone is *unconditionally* sufficient regardless of location, while perfect location information alone caps at 0.45 and can *never* qualify. Two of the derived requirement sentences are fixed templates carrying no survey content beyond an identifier ("AFTER X, IF NO SKIP OR TERMINATE CONDITION APPLIES, CONTINUE TO Y." and "SURVEY REACHES THE NORMAL COMPLETION SCREEN."), so an agent that knows only the question numbering — obtainable from a table of contents — matches **42 of 340 obligations (12.4%) at essentially a perfect score with zero document reading and zero execution.**

**What this does and does not buy.** It does not on its own produce a good-looking scorecard: the coverage and evidence gates still bind, and precision collapses. It does mean the location field has stopped being an identity check. Combined with Finding 1 and with known item #1 (agent-supplied target lists), the pieces compose into a cheap high score.

**Fix — code, plus one schema decision.**
- Code (requires bumping the matcher version and recalibrating fixtures): stop rewarding label *quantity*. Score the declared label as the primary signal and let alternates act only as a small, capped tie-break. State the invariant explicitly: adding labels must never raise a score by more than a fixed cap, and the winning label must be the declared one or a near-synonym.
- Code: set the requirement weight strictly *below* the eligibility bar, or require a non-zero location contribution, so reproducing requirement text alone can never clear it.
- Code: when the reference has no quote (120 of 340 obligations), the whole location weight rides on the inflatable term. Either renormalize the weight down in that case or require a higher requirement match.
- Schema (public contract, so a versioning decision): cap the number and length of alternate labels; ideally require each to actually occur in the questionnaire the agent was given.
- Give the 30 template obligations a real document-derived quote. This is the same lever that known item #9 (GAP-1) needs — one fix, two problems.

---

### 3. Nothing outside the ground-truth pipeline checks the ground truth, and a failed build still leaves usable ground truth on disk

**Severity: high.** Direction: wrong ground truth (honest agents scored badly, silently).
**Where:** `scorer/oracle/selfcheck.mjs`, `scorer/oracle/validate-oracle-records.mjs`, `scorer/oracle/build-oracle.mjs:25-57` (verified: all thirteen files are written at `:31-45`, the failure gates are evaluated at `:48-57`).
**Confidence: confirmed** — both halves demonstrated in a scratch copy.

**(a) The 734 checks verify self-consistency, not correctness.** The headline "532 checks, 0 failures / SELFCHECK PASSED" and "202 checks / ORACLE RECORDS VALID" verify that the ground-truth builder is deterministic, well-shaped, and internally cross-referenced. They do not verify that it is *right*. Any semantic change to the deriver that survives regeneration is silently adopted as the new truth. Demonstrated twice: weakening the pinned requirement text for a whole class of obligations produced **literally zero signal anywhere** — self-check passed, records valid, and the integration proof's pass/fail lines byte-identical to baseline. A second corruption (stripping numeric bounds) did degrade the integration numbers but nothing turned red, because the integration proof exits successfully unconditionally and its headline stayed the same in both builds.

Only one of the six surveys has hand-written, deriver-independent probes. Every obligation class outside it — carry-forward, piping, rotation, loops, computed values, allocation — can have its ground truth silently weakened with no detection.

**(b) A failed build leaves complete, unmarked bad ground truth on disk.** The builder writes all thirteen files *before* it evaluates its own failure gates. A build that prints an error and exits non-zero still leaves thirteen schema-valid records in place, and nothing downstream can tell — the record format has no status field. Demonstrated end-to-end: a failed build produced a record that the scorer accepted as fully valid, all nine gates passed, zero warnings, while dropping the repo's own honest run from 0.944 to 0.85 on two phantom obligations. An honest agent silently penalized by ground truth the builder itself had rejected.

**Failure scenario.** A refactor or a well-meaning fix weakens the derived text for a class of obligations. The maintainer regenerates — the documented workflow — sees two green banners, and ships. Every agent scored afterwards is graded against wrong truth. An honest agent that extracted the full requirement correctly now fails to match it and loses coverage credit, with no signal anywhere.

**Fix — code only, no contract change.**
- Make the build atomic: evaluate the failure gates *before* writing, or write to a temp directory and promote only on success. Never leave a partial or rejected `generated/`.
- Commit a golden text snapshot of every derived requirement across all twelve records and gate on it, so any deriver change produces a reviewable diff that must be explicitly re-approved rather than silently absorbed.
- Stronger and worth doing: cross-check derived text against the questionnaire document the corpus already produces — assert that every load-bearing literal (numeric bounds, option labels, skip targets, carry-forward sources) actually appears in the document a tester reads. That would have caught both corruptions.
- Make the integration proof exit non-zero when its failure set differs from a pinned baseline. It currently exits successfully always, which is why an 0.944→0.778 collapse went unnoticed under a "gaps found (8 failed assertions)" headline that never changed.
- Cosmetic but worth it: 224 of the 532 headline checks are per-row restatements of a single derived boolean. Report distinct properties, not rows.

---

### 4. "Extraction accuracy" counts how many checklist items could be *assigned*, not how many were *right* — a checklist with its meaning inverted scores the same as a correct one

**Severity: high.** Direction: measurement validity (not a gaming vector).
**Where:** `scorer/src/lib/metrics.mjs:98-100`; the matching contract has no fidelity stage at any point.
**Confidence: confirmed** — demonstrated through the real scorer against the real `s1-skip.flawed` ground truth.

A checklist item whose requirement is the *logical negation* of the document requirement, or that misstates a documented numeric bound by an order of magnitude, is still assigned to the correct obligation and earns full extraction, coverage and verified-unit credit with **zero errors and zero warnings**. The matched item is then judged against the agent's own wrong requirement, and the scorer never compares the agent's verdict to what the ground truth says should have been observed.

Demonstrated: inverting the polarity of 8 of 18 requirements ("must"→"must not", "skips"→"does not skip", "displays"→"does not display") leaves all 8 matched to the *same* obligation and extraction recall at **0.944 — identical to the faithful checklist.** On one item the inverted requirement scores *strictly higher* against its own obligation than the correct one does. Corrupting every requirement to boilerplate numbers still yields recall 0.778 and 14 verified coverage units.

**Why this matters more than it looks.** The P1 phase gate is written as "meets the extraction-accuracy threshold ratified in P0". That gate reads as *"did the checklist faithfully capture the document?"* but is computed as *"how many items could be assigned to something?"* Those are different questions and the second one cannot detect wrong content. **Do not ratify a threshold on this metric as currently defined.**

Note what this does *not* contradict: the normalization guarantee (that negation and numbers survive as distinct tokens, and that a requirement and its negation never normalize to the same string) is genuinely delivered — negation does lower the pair score in 24 of 34 measured cases. The contract simply never states a *decision-level* fidelity requirement, and the single 0.55 bar sits far below where semantically inverted pairs land (0.561–0.780).

**Fix — Tier 1, contract change. Owner decision required.**
- Split identity from fidelity. Similarity keeps its job of deciding *which* obligation an item refers to; a matched pair must then pass a separate pinned fidelity check before counting toward accuracy: polarity agreement, exact equality of numeric bounds and comparison operators, agreement of answer codes and branch targets. Report it as its own number with its own per-item diagnostic.
- Rename the current metrics to *identification* recall/precision in the scorecard, and redefine the P1 gate over fidelity.
- Make fidelity mechanically checkable: require checklist items to carry structured comparable fields (numeric min/max, polarity, operator, branch target) alongside the free-text requirement, so they compare against the ground truth's structured preconditions and expected observables instead of prose similarity.
- Independently: compare the agent's verdict against the expected observable for matched obligations, so "passed, with valid evidence, against a wrong requirement" becomes detectable at all.
- Frame this as discrimination, not penalty. No corruption tested scored *above* honest extraction; the apparatus is not being gamed here, it is failing to tell the difference.

---

### 5. An honest tester that numbers its test paths `p001` is convicted of cheating and has its entire evaluation voided

**Severity: high.** Direction: honest-agent-penalized.
**Where:** `scorer/src/lib/integrity.mjs:102-124` (verified: scans the entire raw record text for every private identifier), IDs minted at `scorer/oracle/lib/derive.mjs:395`.
**Confidence: confirmed** — reproduced in four independent variants against the real ground truth; the control passes.

The scorer protects the hidden answer key by scanning the agent's whole submission for any private identifier. Two families of those identifiers are **short and completely guessable**: the hidden test paths are named `p001` through `p053` (verified), and the planted defects are named `S1-E01` through `S6-E03`.

Neither the public schema nor the published contract reserves that naming space. Both the path-ID and finding-ID fields are explicitly agent-supplied with permissive formats. So an honest blind tester that plans two routes and names them `p001` and `p002` — the most obvious numbering convention in existence — or that auto-numbers its findings `S1-E01`, is flagged as having accessed the hidden answer key. The consequence is the maximum penalty in the system: isolation gate failed, integrity invalid, **evaluation voided, all quality scores suppressed.**

The agent cannot avoid this. The reserved namespace is private by construction, so it cannot be published without publishing the answer key it protects.

**Fix — code only, preferred; no burden on the agent.** Make private identifiers unguessable at mint time: qualify each with a per-record discriminator (e.g. `orc:p001@<8 hex chars of the record hash>`). Genuine exfiltration reproduces whatever the identifier happens to be; accidental invention becomes impossible. Complementary hardening: exclude short, low-entropy identifiers from the raw-text scan (keep it for long distinctive ones plus the existing path heuristic), and widen the token boundary so identifier-shaped strings must stand alone.

If the owner instead prefers a contract rule, it must be *published* — a reserved-prefix clause in the public schema and the contract — and violations must surface as a distinct schema-level error, **never** as an access violation, which permanently brands the agent a cheat. Add a regression fixture for the honest-collision case.

---

### 6. A well-formed submission can make the scorer run for hours and never return a verdict

**Severity: high.** Direction: agent-can-game (denial of scoring).
**Where:** `scorer/src/lib/matcher.mjs:372-387` (the duplicate-detection pass compares agent-supplied text on *both* sides of every same-type pair); no limits in the schema or the CLI.
**Confidence: confirmed** — measured end-to-end through the real CLI.

Two independent levers, both fully demonstrated:

- **Number of alternate labels.** Cost grows with the square of both the item count and the label count. Measured: 74 ms with no labels, 14.0 s at 100, 71.7 s at 200 — with the duplicate pass alone accounting for 13.0 s of the 13.3 s at 100.
- **String length**, which needs no labels at all. The edit-distance routine is quadratic over unbounded quote and requirement text. Measured with zero labels: 4,000-character quotes (a 124 KB submission) took 14.9 s; 8,000-character quotes (196 KB) took 61.8 s. That extrapolates to roughly **1.7 hours for a ~1.5 MB submission** — which the schema permits, since nothing caps item count, label count, or any string length.

There is no work budget and no fail-closed path: the scorer simply does not return. And because the label bag also *improves* the score (Finding 2), there is no incentive gradient pushing agents away from it.

**Fix — code first; the scorer must not depend on the contract being polite.**
- Cap compared strings at a pinned length (512 normalized characters) and add the cheap length-difference early exit so obviously dissimilar strings never enter the expensive comparison.
- Cap the label fan-out at a pinned K (16), and hoist the label canonicalization out of the pair loop — it is currently recomputed for every pair, a large constant-factor win on its own.
- Add an explicit work and wall-clock budget around the matching step that emits a hard error and returns an *invalid* scorecard, so an oversized submission fails closed instead of hanging.
- Then tighten the schema with length and count limits (a public-contract version decision — but the code fix must not wait on it), and add an "oversized matching input" adversarial fixture asserting bounded time and a fail-closed error.

---

### 7. The corpus can only express one kind of survey bug, and it is not the kind that dominates real work

**Severity: high.** Direction: wrong ground truth / strategic. **This is the direction lens's headline** — see §8 for the full argument.
**Where:** `test-suite/branching/lib/describe.mjs`, `scorer/schemas/oracle-record.schema.json`, `scorer/src/lib/defect-match.mjs:86`.
**Confidence: confirmed.**

Every one of the 18 planted defects is the same shape: the *site* disagrees with a *correct* document. The questionnaire is machine-generated from the same source that defines the answer, and the corpus validator asserts those exact strings back — so "the document is wrong", "the document is silent", and "the document is genuinely ambiguous" are structurally impossible to plant.

This is deeper than the corpus. The ground-truth format itself cannot represent the missing class: an obligation's requirement is defined as "clean expected intent" even on flawed targets, and a planted defect is defined as expected = document requirement, observed = site behaviour. There is nowhere to put "the spec is wrong." The public schema *does* offer finding kinds for ambiguity and for document-vs-site disagreement — but the scorer only ever considers findings of kind "defect", so those are **inert**: an agent that correctly surfaces an ambiguous spec is neither credited nor penalized. It simply does not count.

Compounding it: the ground-truth requirement text and the questionnaire text are produced by the *same* renderer — 13 of 18 requirement strings for the first survey appear byte-for-byte in the document. So the extraction accuracy that P1 gates on is substantially a verbatim-copy score and a near-upper bound.

**Failure scenario.** P1 ratifies an extraction threshold measured against documents whose every logic statement is a canonical template emitted by the code that defines the answer. The threshold transfers to nothing. Real questionnaires arrive as Word files with grid specs in tables, quotas on another tab, inconsistent "ASK IF"/"BASE:" notation, tracked changes, and genuinely ambiguous routing that a human programmer resolves by asking. The team hits its gates, ships, and discovers on the first real vendor that the dominant finding class is *"the spec is ambiguous or the spec is wrong"* — a class the apparatus was never able to produce, score, or represent.

**Fix — Tier 1, contract first, then corpus. Owner decision required.**
1. **Contract.** Extend the ground-truth record so an obligation carries both *what the document states* and *what was intended*, plus an ambiguity marker with the admissible readings; let a planted defect declare a side (site | document | ambiguity). Then give the ambiguity and document-disagreement finding kinds a real matching and credit path, so surfacing a bad spec is scored rather than ignored.
2. **Corpus.** Add a document-side variant track covering wrong-document, omitted-spec, and genuinely-ambiguous-routing, plus at least one multi-cause defect. De-circularize extraction by rendering the questionnaire through a deliberately messier surface than the ground-truth text — tables for grids, notation variants, a quota block stated elsewhere — so extraction accuracy stops measuring string copying.
3. **Until both land**, do not ratify the P1 extraction threshold on this corpus. Record the current number explicitly as a ceiling measured on machine-canonical text, and state the untested finding classes in the P0 gate write-up.

---

### 8. Every test page ships a complete machine-readable copy of its own logic, so the planted bugs can be found without ever clicking anything

**Severity: medium** (documented as an open caveat; the *new* parts are the leak of clean intent onto the flawed page and the mis-specified negative test).
**Where:** `test-suite/branching/s5-allocation/flawed.html:29` (verified: `<script type="application/json" id="survey-manifest">`), plus published page globals; `test-suite/branching/README.md:55-57`.
**Confidence: confirmed.**

Every delivered page inlines its full logic specification and publishes it on the page's global state. All 18 planted defects are recoverable by parsing that JSON and diffing it against the questionnaire, with **zero interaction**. Two of them are recoverable from the flawed page *alone*, because the answer-key stripper removes the top-level keys but leaves per-object `note` fields that state the clean intent the flawed values contradict (verified: three such fields remain on one flawed page).

The stated defence does not work as written. The negative test scans delivered assets for hidden identifiers and defect labels — which are correctly absent. It is looking for the wrong string: the leak carries no identifiers, only the logic. And the repo's own README claims that stripping the answer-key fields means "the tool under test cannot cheat by reading the answer key out of the DOM." That is true only of the labels, not of defect recoverability.

**What the residual harm actually is.** Not scoring inflation on its own — asserting a defect still requires an attempt and a lineage-valid artifact. The harm is **measurement validity**: the corpus cannot tell a real explorer from a manifest parser, and cost-per-verified-unit is flattered. It becomes a scoring exploit only in combination with known item #1.

**Fix.**
- Cheap and immediate (code): extend the answer-key stripper to drop every per-object `note` and any authoring prose, so the flawed page stops shipping the clean intent it contradicts.
- Spec: restate the negative test to assert absence of the **logic specification** — no parseable manifest-shaped JSON in delivered bytes, no manifest node, no published globals — not just absence of identifiers.
- **Owner decision (Tier 1):** either the future harness serves fixtures through a transform that keeps the logic out of the delivered bytes and hard-bars page-source inspection, or the corpus keeps self-contained static pages and the evaluation explicitly accepts that *logic discovery is not being measured*. Both are defensible; the current state is the one that is not, because the docs claim the first while the corpus does the second.
- Correct `test-suite/branching/README.md:55-57`.

---

### 9. Evidence is never tied to an action or to what the screen looked like afterwards

**Severity: medium.** Direction: agent-can-game / measurement validity. Partly adjacent to known item #1; the pre-action-capture half is additive.
**Where:** `scorer/src/lib/evidence.mjs:200` and the surrounding claim assessment.
**Confidence: confirmed** — verified directly: the phase field (`before-action` / `after-action` / `attempt-end`) is **read nowhere in the entire scorer** (zero occurrences), capture time is never compared to the action it cites, and the captured screen state is never required to be that action's resulting state.

Evidence sufficiency is implemented as *membership*: an artifact counts if it was captured somewhere inside an attempt that targeted the item. So the scorer cannot distinguish a screenshot of the *outcome* from a screenshot of the landing page taken before anything happened.

The agent-reachable half — and the part not covered by known item #1 — is that capture *timing* is agent-chosen. An agent may honestly capture a single landing-page artifact before acting (the harness truthfully stamps it "before-action", landing state, attempt-start time), then do real work, and cite that one pre-action artifact as the outcome evidence for **every** item it claims to have exercised. The scorer credits it in full.

Demonstrated: a baseline run plus four variants — all evidence relabelled pre-action, evidence timestamped before the action it cites, a run with zero actions, and a run with "after-action" evidence on an attempt containing no actions at all — every one scores valid, zero errors, zero warnings, all nine gates passed, with metrics byte-identical to the real 15-action run.

Two flashier variants in the original claim are weaker than they look: re-stamping capture metadata on an existing run mutates harness-attested fields the agent cannot reach, so those demonstrate an *undetectable harness bug* rather than agent gaming; and the zero-action run is the limit case of known item #1.

**Fix — contract first, then code, and it must be co-designed with the known item #1 fix.**
- Contract: define "outcome evidence" instead of leaving it as "captured inside that attempt". An artifact witnesses an exercised item or a defect only when its phase is after-action or attempt-end; when it cites an action, its capture time must not precede that action and its captured state must be that action's resulting state; when it is an attempt-end capture, it must cite the attempt's last valid state. State the corresponding rule for blocker and reachability packets so the change does not silently reclassify them.
- Code: add internal-consistency checks (these are pure harness-bug detectors) — run-level phase implies no attempt, action-scoped phases imply a non-null action, capture time not before the cited action, captured state consistent with the cited action. Then add a phase predicate to the exercised and defect branches so only post-action evidence counts.
- **Sequencing matters:** if the known-item-#1 fix makes target lists action-derived, the two fixes overlap on the zero-action case. Whichever lands first must own that case explicitly rather than both assuming the other covers it. Expect fixture churn.

---

### 10. The questionnaire states four rules that the ground truth does not contain, so a thorough extractor is scored as if it hallucinated them

**Severity: medium.** Direction: honest-agent-penalized.
**Where:** `test-suite/branching/gen-branching-docx.mjs:54-55` (and the twin at `test-suite/lib/build.mjs:203`); `scorer/oracle/lib/schema-guard.mjs:24-28`.
**Confidence: confirmed** — demonstrated on the real clean integration run with the real CLI.

The questionnaire generator injects two lines that are not derived from the survey definition: the landing-page intro text, and "Programming: one question per screen. Respondents may not navigate backwards. All questions require an answer before continuing." All four stated requirements **are genuinely implemented** by the target. None of them produces a single obligation in any of the twelve ground-truth records.

An honest agent that extracts the document faithfully and lists these four requirements keeps identical recall, coverage, completeness, defect and cost numbers but **drops extraction precision from 0.944 to 0.773** — punished purely for being thorough. The four land as unmatched with no ambiguity (best rival score 0.136 against a 0.55 bar). The ceiling is structural: a document-faithful extractor tops out between 0.818 and 0.915 across the six surveys.

Symmetrically, an agent that never opens the landing page and never tries the back button pays nothing — those behaviours are in no coverage denominator, so "exercise every reachable obligation" is achievable without ever testing them.

**A related overclaim.** The build's "zero unmapped constructs" guard is a *key-vocabulary* walker, not an *obligation-production* walker: it recognises landing title, intro and end-screen copy as known keys and reports nothing unmapped, so the self-check's claim is weaker than its own comment states. And the document's hardcoded programming preamble is not a survey-definition key at all, so that guard structurally cannot cover it.

**Fix.**
- Cheapest correct fix for P0, and it restores the generator's own stated invariant: **delete the two hardcoded spec lines**, so the delivered document states only requirements the ground truth models.
- If those behaviours should be tested — they are real, testable target behaviour — promote them into the survey definition as declared survey-level constructs and emit matching obligations. That needs a new obligation type in the public schema plus a mapping in the contract, i.e. a contract change. Note the contract already *promises* to map required-answer constraints to a validation obligation, but none is emitted today.
- **Owner decision (Tier 1):** does the coverage contract cover non-logic documented requirements at all? If no, say so explicitly in the contract *and* in the brief the tested agent is given, and stop counting document-faithful out-of-taxonomy items as precision misses.
- Upgrade the guard from key coverage to obligation-production coverage: every recognised key must either contribute to an obligation or sit on an explicit exempt list with a written rationale. Correct the guard's and the self-check's wording.

---

### 11. The 285-check test suite cannot detect the loss of most of the guarantees it is cited as proving

**Severity: medium**, but high priority. Direction: assurance.
**Where:** `scorer/test/selftest.mjs`; `scorer/fixtures/` (25 fixtures).
**Confidence: confirmed** — measured by deleting live gates one at a time and re-running.

**45% kill rate.** At least 16 of 29 single-line deletions of live checks leave the suite fully green. The untested set includes: the binding between the agent's checklist and its signed hash; the path-traversal guard on evidence references; the per-call pricing reconciliation (the fixture *named* "falsified cost" reaches its error through the totals instead, so the per-call check is free to delete); four of seven spending and time caps; detection of hidden identifiers inside URLs (the code comment specifically promises this case, and no fixture tests it); the requirement that a blocked item cite a last valid state; the rule that actions fall inside their attempt window; and two dead clauses in the completion calculation.

**Two fixtures pass for the wrong reason.** The tampered-evidence fixture never exercises the content-hash comparison, because both of its tampered artifacts also change file length — the cheaper length check decides it. And no fixture anywhere makes the capture-time-window check the deciding term. Deleting either check keeps the entire apparatus green, including a byte-identical integration report.

**Every calibration constant is untested.** The five thresholds that decide credit are asserted by no test; only the version *string* is pinned. Threshold mutants are invisible across a wide band, and inside that invisible band they materially change real scores: two small upward moves pass 285/285 while dropping the real integration run's extraction recall from 0.944 to 0.778 and its defect recall from 0.333 to 0; one downward move passes 285/285 while lifting recall to 1.0 by crediting the known GAP-1 pair. **These are precisely the constants the in-flight fix round is about to revise** — a "revert-verified" fix here is indistinguishable from a no-op, because reverting it changes no test either.

**Important qualifier:** every gate probed is *correct today*. This is an assurance defect, not a live hole — no agent can exploit it against the current tree. It is high priority only because the twelve known fixes touch exactly the four files whose gates the suite cannot detect the loss of, and because "285 assertions over 25 adversarial fixtures" is currently the assurance argument for the whole apparatus.

**Fix — test-only, no contract change.**
- Pin the *frozen profile objects* (deep-equal or hashed), not just the version strings, with a comment that changing any number requires bumping the version in the same commit. That one assertion kills every threshold mutant.
- Add boundary fixtures either side of each threshold so the numbers have behavioural meaning.
- Add one negative case per currently-unkilled gate. Each is a re-signed variant of the known-good fixture plus an expected result; the generator already holds the test key.
- Add the two mutation-killing evidence fixtures: an artifact substituted at *identical* length, and a fully self-consistent lineage whose capture time falls outside its attempt window.
- Check in the mutation harness itself as a test, so a gate added without a killing test fails CI.
- Drop the fixture assertion that merely echoes an input back.

---

### 12. Where a harness stores its evidence is an unwritten rule, and breaking it is reported as cheating

**Severity: medium.** Direction: contract incoherence / measurement.
**Where:** `scorer/src/lib/evidence.mjs:51-61` (verified: hard-requires the literal prefix `runs/<runId>/artifacts/`).
**Confidence: confirmed.**

The evidence reference is published as an "opaque run-scoped reference" with no format constraint. The scorer hard-requires one specific layout that appears nowhere in the contract, either schema, the docs, or the README — only in a source comment and the two in-repo generators.

Any conforming-but-differently-keyed harness — a bucket-relative key, a vendor-prefixed key, exactly what "opaque" invites — has **100% of its artifacts rejected before their bytes are even hashed**. Coverage, evidence completeness and verified units all collapse to zero for a perfect run, and cost-per-unit becomes undefined. Worse, the same code path returns *evidence reuse from a prior run* for a correctly-scoped reference with a malformed tail, so the emitted message ("is not scoped to run X") can be flatly untrue and points an investigator at relabelling fraud instead of a prefix mismatch.

Scope correction: this field is harness-attested, so it is a harness/scorer contract defect that breaks absolute measurement uniformly — not an agent-exploitable fairness defect — and it fails loudly rather than silently.

**Fix.** Pick one and publish it: either give the field a pattern and a sentence defining how a reference resolves to bytes, or keep it opaque and have the scorer resolve by a documented rule so the harness's storage prefix is free. The current state — published as opaque, enforced as rigid — is the only unacceptable option. Separately, split the diagnostic: reserve the reuse code for a reference that genuinely resolves to a *different* run, and emit a distinct malformed-reference code naming the expected form. Add a fixture for each.

---

### 13. The scorer's default trust anchor is a test key whose private half is committed next to it, and scorecards record no key provenance

**Severity: medium.** Direction: agent-can-game (given file access) / auditability. **A publish-blocker in the narrow sense that it ships this way.**
**Where:** `scorer/src/score-run.mjs:48` (verified: defaults to `scorer/fixtures/keys/registry.json`); `scorer/fixtures/keys/TEST-ONLY-fixture-harness.private.pem` sits beside it; `scorer/integration/verify-integration.mjs:63` invokes the CLI without specifying a key.
**Confidence: confirmed.**

The scorer silently falls back to the fixture trust anchor when no key registry is given — which is how the shipped integration proof itself invokes it. The scorecard records no key identifier, no registry path, and no payload hash, so a card validated under the *public test key* is indistinguishable from one validated under a real harness key. Nothing in the scorer mentions or rejects the test key.

Consequence: anyone able to write the file the scorer consumes can mint arbitrary self-consistent telemetry — fabricated attempts, target lists, limits, resource totals, capture lineage — and it scores clean under the documented default invocation.

**Correction to the original claim:** an operator who simply *forgets* the flag does not thereby mint acceptance. A record signed by a real harness key whose identifier is absent from the fixture registry still fails closed. The silent-pass path exists **only** for records signed with the committed test key. Also, the independent recomputation of telemetry still catches *internally inconsistent* forgeries; the signature is the only barrier against *self-consistent* ones.

**Fix — three cheap independent changes.** (a) Remove the fail-open default: require the key flag, or keep the default only behind an explicit test-mode flag. (b) Mark the fixture registry as test-only in its own data and have the scorer refuse it (or emit a loud non-suppressible warning) unless that flag is passed. (c) Record key provenance in every scorecard unconditionally — key identifier, registry hash, payload hash, and a test-anchor boolean — so any scorecard is auditable after the fact as to which anchor validated it. Update the integration proof to pass the flag explicitly.

---

### 14. About a third of the reported cost is never checked against anything, and the browser-time field cannot be reported honestly

**Severity: medium.** Direction: contract incoherence + honest-agent-penalized. Merges three separately-found defects with one root.
**Where:** `scorer/src/lib/resources.mjs:73` and `:95-98` (verified).
**Confidence: confirmed.**

**(a) Two of three cost components are unpriced.** Model cost is genuinely re-derived from attested tokens against a pinned rate table. Browser cost and "other" cost are accepted as pass-throughs, checked only by the self-satisfying identity *total = model + browser + other*. The already-recomputed browser *milliseconds* are never priced against the browser *cost*. So the contract's claim that "total cost agrees with the pinned pricing version" is true of roughly 70% of the figure, while the cost-known flag stays true and the cost gate passes. Demonstrated: browser cost set to 0 gives 0.0277 per unit, set to 18 gives 1.0877 — both with zero errors, zero warnings, cost gate passed. A run can look ~30% cheaper per verified unit than an honest one of identical quality. Not agent-reachable (these fields are signed), but it makes the headline cost number cross-run incomparable, which is exactly what P1's bakeoff rests on.

**(b) Browser time is forced to equal a sum a real browser cannot produce.** The scorer recomputes browser milliseconds as the sum of attempt windows and demands *exact integer equality*. No document states this — the contract and schema both call it harness-attested telemetry, never a derived quantity. But the intended architecture puts the browser in a metered runner whose billed time necessarily includes session acquisition, page load before the first attempt, and teardown; and nothing forbids overlapping attempts, so a parallel harness double-counts. Either way the honest harness reports its real metered number, gets a mismatch, and the mismatch **sets cost-unknown, fails the cost gate, and nulls the cost-per-unit metric** — on a run whose telemetry was entirely authentic. The only way to pass is to stop reporting measured time and echo the arithmetic instead, which defeats the point of attesting it.

**Fix.**
- Code, cheap, no schema change: refuse to certify a cost total containing an unverifiable component — emit pricing-unknown and set cost-known false when "other" cost is non-zero without itemization, or when browser milliseconds and browser cost disagree in either direction. Surface an unpriced-fraction figure in the scorecard so a reader can see how much of the dollar number is actually reconciled.
- **Owner decision (Tier 1):** add a pinned browser rate and *derive* browser cost from the already-recomputed milliseconds (a pricing-version bump, which is contract-visible); and either require "other" cost to be backed by an attested itemized list, or drop it from the interface entirely.
- **Owner decision (Tier 1):** define what browser time *means*. Either (i) it is the sum of attempt windows — say so in the contract and schema, keep exact equality, and add a separate optional field for the gateway's billed number; or (ii) it is metered session time — relax the check to a bounds test (attempt-window sum ≤ browser time ≤ wall clock) with a warning rather than a hard error. Also decide explicitly whether concurrent attempts are legal; today they are permitted, which makes any attempt-window sum ambiguous as a measure of elapsed time.
- Tighten the contract wording to state *which* components are price-verified. Do not ship the current wording alongside either fix.

---

### 15. Question order is not part of the ground truth for most questions, so a routing change that hides an entire question is invisible

**Severity: medium** (prospective — no current corpus target has one). Direction: agent-can-game / wrong ground truth.
**Where:** `scorer/oracle/lib/derive.mjs:308` (the successor fact is emitted only when a question has conditional rules).
**Confidence: confirmed** — verified in a patched scratch copy.

Question *sequence* is encoded only as a "continue to the next question" fact, and that fact is emitted only for questions that carry conditional rules. **42 of 58 corpus questions (72%) have no rules and therefore contribute no successor fact at all**, and the question obligation itself carries no position.

So a target that transposes two rule-less questions produces a ground-truth record whose obligations are identical in identity, content hash and reachability — with zero recorded defects. And transposition can *drop a whole question from a respondent path*: swapping two questions in the first survey removes the final rating question entirely from the documented skip path. An agent that exercises exactly the denominator scores 100% coverage and "testing complete" on a target with a real routing defect; an agent that *does* notice has no obligation to attach the finding to, so it lands in the known false-positive path.

**Two corrections worth recording.** The record is not byte-identical — the witness-path data does narrow — but no scorer code reads it, so the score is unchanged. And the pipeline is fail-loud if such a defect is *declared*: it throws rather than emitting an unanchored defect. Only an *undeclared* reorder passes silently.

**Fix — owner decision first (Tier 1):** does the coverage contract make presentation sequence a first-class obligation? If yes, the minimal fix is to drop the rules-only guard and emit the successor fact for *every* question lacking an unconditional rule. Verified in scratch: the first survey goes from 18 to 25 obligations, the build stays clean, and the transposition now yields three modified obligations, making the defect anchorable and credit-bearing. No new obligation type is needed. Costs the owner must accept: +42 obligations corpus-wide, complexity weights rise, every record and the corpus path assertions must be rebuilt, and extraction denominators shift for anything already calibrated.

Separately and independently: the flawed records label the *flawed* walk's visit order as the "expected" visit order. That is actively misleading to any future consumer — rename or re-source it.

---

### 16. "100% evidence complete" does not mean the run is auditable — a run with no screenshots and no page excerpts scores a perfect evidence result

**Severity: medium.** Direction: promise-not-real.
**Where:** `docs/llm-led-architecture-proposal.md:71` versus the pinned evidence policy.
**Confidence: confirmed.**

The pinned policy credits an exercised item or an asserted defect on *any one* integrity-valid artifact captured in a targeting attempt, regardless of type. Only two special packet types are type-checked, and the before/after pairing described in the design is never enforced. Demonstrated: relabelling all twelve screenshots and page excerpts in the known-good fixture to type "other" and re-signing yields a **byte-for-byte perfect scorecard** — evidence completeness 1, testing complete, zero warnings — and the scorecard shows no per-type breakdown, so nothing surfaces that the run contains no visual or structural evidence at all.

This is not a scorer bug: the scorer implements its own pinned spec faithfully. It is a mismatch between two documents. The design doc and the UI doc promise an auditable evidence bundle — screenshots with accessible labels, page excerpts rendered as inert text — and the phase gate is written as "100% evidence completeness". But the metric measures *claim support*, not the bundle. Most of the design's list (action traces, state fingerprints, planned paths, hashes, timestamps, lineage, verdicts, telemetry) *is* schema-required and enforced; only the screenshot and excerpt entries and the before/after pairing are not.

**Fix — decide ownership explicitly rather than patching silently.** Either (a) state in the contract that artifact-type minimums are *harness conformance*, not scorer sufficiency, and emit a separate capture-conformance report (per-type breakdown, per-attempt presence of a visual or structural artifact, before/after pairing) alongside and reported separately from evidence completeness; or (b) extend the pinned evidence policy — bumping its version — so an exercised or defect claim needs at least one artifact from a visual/structural class. Whichever is chosen, qualify the gate wording so "100% evidence completeness" is not read as "the run is humanly auditable", and reconcile the two documents' differing minimums.

---

### 17. Residual defects (low severity, worth fixing, not worth blocking on)

**(a) A fresh clone on Windows silently invalidates all ground truth.** *(`scorer/oracle/lib/serialize.mjs:215`; confirmed.)* The corpus bytes that define record identity are not pinned in git — no line-ending configuration anywhere. A default Windows clone yields different content hashes than a Linux one from the same commit (demonstrated: the shared engine file goes from 27,370 bytes to 28,075, moving the build hash and the definition digest). Every generated record is stale while git reports a clean tree, and every scored run then fails identity and produces nothing. **This is the most likely first experience of an outside contributor**, which is why it is called out in the push recommendation. Fix: add a repo-root line-ending configuration with binary markers for documents and images, renormalize once, and make the build refuse to hash a text corpus file containing carriage returns with an actionable error. Do *not* fix it by normalizing inside the hash function — that would open a real gaming seam.

**(b) A dead branch is called reachable and cites a witness on which it cannot fire.** *(`scorer/oracle/lib/serialize.mjs:749`; confirmed, but no shipped record is affected — a path-aware audit of all twelve found zero hits.)* Reachability is decided from static answer-domain membership, never from path feasibility. The real defect is narrower than claimed: the builder is fail-open, writing a record whose "exhaustive walk" basis contradicts its own walk (zero firings) and reporting success, deferring the only guard to a separately-run script. Fix: when the target carries the obligation with an identical content hash but the walk never fired it, that is positive proof — fail closed rather than silently falling back. Keep the fallback for obligations the target modified or dropped, because there the opposite, honest-agent-penalising error appears. Promote the reconciliation check into the build's own problem list.

**(c) An unreadable evidence path crashes the scorer instead of failing closed.** *(`scorer/src/lib/evidence.mjs:89`; confirmed.)* An I/O error on an evidence path — the path is a directory, or is locked — throws out of the scorer, exits with a stack trace, and produces **no scorecard at all**, which contradicts the function's own documented promise. Inconsistent with the two neighbouring tamper cases, which produce clean diagnostics. **The tested agent cannot trigger it** (the reference is inside the signed payload), so this is robustness, not gaming. Fix: require a regular file and wrap the read, mapping any failure to a diagnostic exactly like a missing artifact; and wrap the later scoring steps so an unexpected failure still emits an error-coded card.

**(d) "Quarantined" evidence is credited exactly like cleared evidence.** *(`scorer/src/lib/evidence.mjs:102`; confirmed.)* The schema has three redaction states; the scorer defines semantics for two. Artifacts the redaction pipeline refused to clear support every claim, with no warning that the supporting bytes are unreviewable. Not exploitable (the field is signed) and gives no more credit than the cleared state — it is a contract gap. Fix: decide the semantics in the contract *first*, then replace the terse two-way test with an explicit branch over all three states so a future fourth state fails loudly instead of defaulting to credit. Add one fixture; the catalog currently has none.

**(e) The hidden-identifier scan reads unsigned bytes, so the same signed content can score both ways.** *(`scorer/src/lib/integrity.mjs:117`; confirmed.)* The isolation scan runs over the raw file text rather than the signature-bound parsed content, so two byte-different files with identical signed content score valid versus evaluation-invalid. The scan is also case-sensitive literal-substring only, so the same identifier in lowercase or split across two adjacent fields evades it. Downgraded from the original claim because the scan feeds no metric and a clean run earns the same perfect score either way — it is a soundness gap in a leak tripwire, not a route to inflation. Fix: run the scan over the canonical parsed form, normalize case and punctuation on both sides, add a fixture for this branch (the existing one covers only the sibling path check), and document in the contract that this scan is a careless-leakage tripwire with no anti-cheat guarantee.

**(f) Loop iteration has no accountable coverage unit.** *(`scorer/oracle/lib/derive.mjs:331`; partly confirmed, downgraded to low.)* A loop is credited as exercised by a path that renders the loop block once, so nothing in the denominator demonstrates iteration, ordering, or the three-iteration cap. On the flawed kitchen-sink survey an agent that never multi-selects reaches full coverage and "complete" while the loop defect stays unobserved. This is *not* loop-specific — several sibling rules are credited the same way — and it is the documented P0 split: coverage is decision-point granular, correctness lives in defect recall, which *does* drop for the missed defect. A related witness-path collapse is real but scoring-inert. Fix: treat as an owner-level contract question, decided corpus-wide rather than for loops alone — and note it only bites once the scorer can tell what an attempt actually *did*, which is the deferred harness-isolation item. One cheap, strictly-additive step meanwhile: stop publishing only the first-seen answer vector per visited-path signature, so the clean-versus-flawed witness asymmetry becomes a visible signal rather than being silently normalized away.

**(g) The integration proof's headline extraction number is inflated by borrowed labels.** *(`scorer/integration/gen-integration-runs.mjs:153`; partly confirmed.)* 13 of 17 matched pairs are byte-identical on their location label, and for the five obligations with no quote the label is the sole signal. Four plausible faithful relabels a blind agent would write each drop their obligation, taking recall from 0.944 to 0.722. Correction to the original: one cited label *is* published (it is the verbatim example in the public schema); the genuinely unpublished forms are exactly the quote-less ones. Fix: rewrite the fixture's labels to strings derivable purely from the questionnaire and publish whatever recall that yields as the honest baseline; and either publish the label vocabulary normatively in the public contract, or stop letting a convention-dependent label carry 27% of the score when the obligation has no quote.

**(h) The integration proof is narrow, and one of its assertions is dead.** *(`scorer/integration/verify-integration.mjs:261`; partly confirmed, downgraded.)* Its two runs exercise no error path, only one coverage state, and one of six surveys (18 of 340 obligations, 4 of 9 obligation types). The "no false defects on a clean target" assertion runs against a zero-finding record and can never fail. It is *not* test theatre — every named policy is pinned by a dedicated fixture in the green suite — but it is narrower than it reads. Fix: add a third case that scores a run *with* an asserted defect against the clean target so that assertion becomes live, and widen to the kitchen-sink survey so the five never-scored obligation types get end-to-end coverage.

---

## 3. Themes

Five patterns account for almost everything above.

**Theme 1 — Word overlap is doing work that word overlap cannot do.** Findings 1, 2 and 4 are the same root seen three ways: matching agent text to ground truth by lexical similarity cannot distinguish *knowing* from *resembling*. It credits fabrication (1), credits ignorance (2), and credits inversion (4) — and it penalizes the specific, accurate, differently-phrased prose an honest agent actually writes. Known items #9, #10 and #11 are also in this family. **The important consequence for the in-flight fix round: the ranking is inverted, not merely miscalibrated, so no threshold change closes it.** Every fix in this theme is a contract change, not a tuning pass.

**Theme 2 — Self-consistency is being reported as correctness.** Findings 3, 11 and 16. The apparatus verifies extensively that its parts agree with themselves — deterministic rebuilds, schema validity, internal cross-references, 285 green assertions — and this is repeatedly presented as evidence that the parts are *right*. Corrupt the deriver and everything stays green. Delete a gate and everything stays green. Relabel every screenshot as an opaque blob and the evidence score stays perfect. Every fix here is adding one *independent* anchor: a golden text snapshot, a mutation harness, a per-type breakdown.

**Theme 3 — Unwritten rules that the code enforces anyway.** Findings 5, 12, 14b and, in a different key, 10. In each case a field is published as free-form or agent-owned, and the scorer enforces an undocumented convention on it, punishing the conforming party — sometimes with the harshest available verdict (Finding 5 brands an honest tester a cheat for using the obvious numbering scheme). The pattern is dangerous because it is invisible until someone outside the two in-repo generators writes a submission.

**Theme 4 — The trusted side has more surface than the threat model assumes.** Findings 9, 13, 14 and 17c. Several checks that read as anti-cheat controls are really harness-conformance checks; several harness-attested values are accepted unreconciled. This does not break the promise against a *tested agent*, but it does mean the apparatus cannot detect a broken or misconfigured harness — and there is no harness yet, so nothing has ever produced these fields except fixture generators. When one exists, these are the places it will be silently wrong.

**Theme 5 — The corpus measures the half of the problem that was easiest to generate.** Findings 7, 8 and 15. The test bed is machine-generated from a single source of truth, which makes it rigorous and self-verifying — and also makes document-side error, document ambiguity, question ordering, and logic *discovery* structurally impossible to measure. This is the theme with the longest lead time and the one most likely to be discovered late, on a real customer.

---

## 4. What held up under attack

This matters as much as the findings. Twelve hostile lenses spent their budget trying to break these and could not.

**Cryptography and parsing are sound.** The canonicalization implementation was differentially fuzzed against the standard parser on 52 adversarial inputs — split surrogate escapes, lone surrogates, byte-order marks, noncharacters, astral-plane keys and their sort position, duplicate keys under escape aliasing, reserved property names, and eleven malformed number forms. Duplicate-key rejection survives escape aliasing where the standard parser silently keeps the last value. Reserved names are neutralized. Numeric output matches the specification. Lone surrogates cause a controlled failure at both call sites rather than a crash or a pass. The signature covers the right payload and every tampering attempt required re-signing to get past the gate.

**The fail-closed ordering is real.** No path was found that leaks partial credit past an early gate. Failed gates null out every downstream result; gates never reached are correctly marked as such.

**Evidence integrity is real, not nominal.** Artifact bytes are re-hashed and length-checked against the signed values; cross-run reuse, path traversal, absolute paths and backslashes are all blocked; capture lineage to a foreign attempt is rejected. One lens's own experiment was caught unprompted by the cross-run rule.

**Ground truth is honestly per-target, and this was the biggest expected finding that did not materialize.** Multiple lenses independently predicted that the flawed records would be derived from the buggy definitions, silently shrinking the denominator with the defect. They are not: clean and flawed records carry **identical obligation sets and identical content hashes** across all six surveys, with only reachability computed against the target. An honest checklist derived from the document is therefore not systematically punished on flawed variants. This is a genuinely good design decision and it is correctly documented.

**All 18 planted defects reproduce their documented behaviour**, verified by applying each patch alone and driving the real engine. All 220 quoted document excerpts across the twelve records are verbatim. Replaying every published witness path's answers through the engine found zero paths claiming an edge that does not actually fire. Defect attribution genuinely tiles the difference between clean and flawed, with unattributed differences failing the build.

**The economics claim holds on the hardest case.** A greedy set-cover over the kitchen-sink survey's witness paths covers all 43 reachable obligations with **5 of 53 paths**. The cost cap formula and its two worked examples are arithmetically exact, and the real corpus tops out comfortably inside the ceiling.

**Every number in the research docs checks out.** Complexity weights recomputed for all twelve variants — exact. Every cost-per-unit, every ratio, the entire competitor comparison column, the cache discounts, the 61-model task breakdown, the OCR cost extrapolation and the benchmark gap — all correct. (One count is wrong; see §6.)

**Several anti-gaming controls work as designed and resisted direct attack.** Shotgunning near-identical checklist items is caught and self-punishing (duplicates still count against precision). The one-to-one assignment could not be made to claim two obligations with one item. The ambiguity rule is pure downside for an agent — it cannot be weaponized to suppress an inconvenient obligation. Omitting hard items cannot buy a "complete" verdict, because the denominator is the full ground-truth set. Model spend cannot be hidden in the unpriced cost buckets. Under-reporting calls, tokens, tool calls, or elapsed time is reconciled against the attested arrays. Falsely claiming an obligation is unreachable is caught against the ground truth. The agent-supplied confidence figure is deliberately credit-bearing nowhere — a documented posture, not an oversight.

**The two-axis coverage/verdict design is enforced by the schema itself**, including the requirement that an "exercised" claim carry at least one attempt and one evidence reference. The contradictory combination the contract forbids genuinely cannot be submitted.

---

## 5. Refuted claims — and why this matters

Twelve claims were killed in refutation. Recording them is part of the audit's value: it tells the owner which alarms *not* to spend time on, and it is the evidence that the surviving findings were filtered rather than accumulated.

1. **"The rotation instruction is asserted by the document and the ground truth, but the page renders one fixed order — the conformant page violates its own truth."** Refuted. The checked expectation is the seed-pinned render order, which the page satisfies exactly; the requirement field is *source provenance*, not the checkable expectation, and that separation is documented twice. Seed-pinned determinism is deliberate and is what makes rotation assertable at all. The failure scenario's opening step is impossible — the agent never sees the ground truth. The residual path (an agent over-escalating an unverifiable programmer note to a hard defect on a clean fixture) is exactly the documented clean-target policy, complete with a versioned correction escape hatch, and is avoidable at zero cost via the purpose-named finding kinds for document-disagreement and ambiguity — which produce zero false positives on identical text.

2. **"Five obligations tell the tester to expect the raw un-substituted piping token."** Refuted as material. The observation is true and is a cosmetic self-consistency wart, but the agent is never told anything by the ground-truth record, the string carries zero score weight (garbling every observable leaves the scorecard byte-identical), the adjacent requirement field states the correct form, and the only consumer that turns observables into credit-bearing text is provably unreachable for this shape.

3. **"A single zero-byte file with a lying media type satisfies 18 coverage claims and 3 defect findings."** Refuted on direction and on remedy. Only constructible by a party holding the harness key — the tested agent cannot register evidence or choose its type. The proposed fix is also ineffective against the residual threat (an agent that drives the harness to screenshot a blank page produces a well-formed, correctly-typed image) and self-defeating at P0 (the repo's own fixtures are 38-byte fake images that a real format check would reject). The amplification is verbatim known item #1.

4. **"The cost cohort splits at 100% while cost gates are scoped to a 90/95% coverage gate, so the complete cohort is empty."** Refuted — the middle step is invented. The cost gate is per-run (`costKnown && limitsOk`) with no cohort input; the shipped scorecard shows the cost gate passing next to a "partial" label. The design doc scopes its thresholds to runs meeting the *coverage* gate, not to the completion cohort.

5. **"Cost-per-verified-unit collapses 'spent everything and verified nothing' with 'cost unverifiable' into the same null."** Refuted. The two cases differ on four emitted fields, three of which exist for exactly this purpose, and two are already pinned by an existing fixture. Structurally, zero verified units always forces the partial cohort on every corpus survey, and the contract *requires* partial runs to be reported separately. The mathematically correct value would serialize to null anyway, so any in-band fix would be a scorecard-contract change duplicating fields that already exist.

6. **"Target identity leaks clean-versus-flawed truth, and the clause forbidding that is unsatisfiable."** Refuted. It conflates the string shown to the tester with the signed identity field; only the former is constrained by the clause and only the latter is checked by the identity gate. A configuration satisfying both simultaneously was demonstrated with an identical scorecard. What survives is fixture cosmetics.

7. **"P2/P3 gates require 100% critical-defect recall, but no severity exists in any ground truth."** Refuted. Every observation is true, but the gap is named explicitly in the contract as deliberate, scoped out of P0/P1, and gated on owner approval of a severity rubric *before* any such gate is scored. Flipping every finding to critical or to informational leaves the scorecard byte-identical, so no agent can inflate or be penalized today. Residual: one missing cross-reference between two docs.

8. **"The OCR doc seats the navigator model as judge of its own screenshots, contradicting the 'executor never certifies its own success' decision."** Refuted on all load-bearing legs. The quoted rationale means "perceived the pixels rather than a transcription of them", not "the model that took the screenshot". A screenshot is a deterministic browser artifact, not a model claim — handing panelists raw artifacts instead of executor summaries is the documented *mitigation*, not the risk. A conforming non-navigator, non-shared-lineage vision panelist already exists in the proposed roster, and family diversity is an explicit enforced bakeoff gate. The doc in question carries an owner banner marking it as an archived record of a decision already taken against.

9. **"P0's repeatability exit criterion is contradicted by the code, and later gates depend on ratifications that exist nowhere."** Refuted on two of three legs. The unit and threshold are stated explicitly in the phase gates. Emitting the field as null with a documented reason is what "defined but not computable from one run" correctly looks like for a two-run statistic in a single-run scorer, and it binds at no gate before P2. The claim that it cannot be computed from scorecards at all is false — a ~20-line join over already-published fields produced the full per-obligation agreement map. Residual: one forward-dated deliverable of an in-flight phase is unfilled, which is a to-do.

10. **"Extraction accuracy measures agreement with a private decomposition, not extraction quality."** Refuted. The two obligations alleged to be one document fact are **two separately authored document paragraphs** with two different stimuli and two different expected observables — a merged item cannot report both. The granularity rule *is* documented, in the exact file the claim says is silent, with the stated reason. The alternative variant reverses the design doc it cites, which shows one obligation covering multiple options and provides a schema construct for exactly that. The 20% figure is inflated: 15 of 34 are the already-known GAP-1, and at least 8 of the rest are not semantically redundant at all. Residual: the tester-facing brief should restate the granularity rule in one place.

11. **"Every metric requires a hidden answer key; production has none, and the one transferable trust signal is never scored."** Refuted. Evidence completeness and report completeness are computed with tester-local denominators and consult no ground truth; so are the asserted/redundant finding counts and the whole cost reconciliation. The report contract explicitly requires a different completion label for runs without a hidden key. Repeatability is oracle-free, transfers directly, and *is* in the gate ladder at P2/P3 — it is reserved with a stated reason, not omitted. Worse, the remedy pushed (making agent-reported confidence credit-bearing) is the same class of hole as known item #1, and its exclusion is a documented deliberate posture.

12. **"P0 hardened the half that was never at risk; the caps are unenforced and the one cost datapoint is unrealistic."** Refuted. Field counts describe contract surface, not where the work went — the actual scoring code is roughly 1,150 lines of adjudicating agent claims against 229 of attestation machinery, and the promise under test is precisely about agent claims. The enforcement claim was disproved by execution: caps are recomputed from attested telemetry, breaches fail the cost gate, and a dedicated fixture covers it. A realistic per-step navigator cost model was built and produced bit-identical quality scoring with the cost moving correctly and no code change. What remains — no empirical cost datapoint yet — is stated in the design doc as an untested hypothesis.

---

## 6. Documentation that is not true (the publish-blockers)

Four specific sentences assert guarantees the apparatus does not deliver. These are cheap edits and they are the only genuine reason to hold the push.

1. **`test-suite/branching/README.md:55-57`** — "the tool under test cannot cheat by reading the answer key out of the DOM." True of the answer-key labels only. Every planted defect is recoverable from the delivered bytes (Finding 8).
2. **The "zero unmapped constructs" guard and its self-check claim** — it is a key-vocabulary walker, never an obligation-production walker. It reports nothing unmapped for constructs that produce no obligations at all (Finding 10).
3. **"285 assertions over 25 adversarial fixtures"**, used as the assurance argument for the central promise — 45% mutation kill rate; 16 live gates are individually deletable with the suite fully green (Finding 11).
4. **The contract's "total cost agrees with the pinned pricing version"** — true of roughly 70% of the total (Finding 14).

One additional factual error found with no finding slot: **`docs/workers-ai-research.md`** states three times that "22 models were probed, 20 support schema-enforced output". Its own matrix has 23 model rows — 18 supporting, 2 failing, 1 licence-blocked, 2 not applicable. The true rate is 18 of 21 eligible. "20 of 22" appears nowhere in the evidence, and it is the stated basis for the recommendation to rely on schema-enforced output.

Two smaller cross-doc inconsistencies, below the reporting bar but worth a pass: the design doc's stated reserve percentages (15%/10%) do not match the UI doc's canonical worked example (10%/5%); and the research doc's provisional panel is four legs while the design decision specifies three metered as two extra reviews plus bounded reconciliation.

---

## 7. Owner decisions

These cannot be resolved by an implementer. Each changes what the apparatus *is*, not how well it works.

1. **How is a reported bug identified?** By free-text resemblance (today, broken in both directions) or by structured, typed claims about what was observed? This blocks the fix for Finding 1 and determines whether the in-flight known-item round can close its defect-matching items at all. *Highest priority — everything in Theme 1 waits on it.*

2. **What does "extraction accuracy" mean, and what should P1 gate on?** Assignment count (today) or content fidelity? This determines whether the P1 threshold can be ratified and what it is measured over. (Finding 4.)

3. **Does the coverage contract cover documented non-logic requirements** — landing page copy, one question per screen, no back navigation, required answers? Yes means new obligation types and a contract change; no means saying so publicly and removing document-faithful items from the precision denominator. Either is fine; the current silent middle punishes thoroughness. (Finding 10.)

4. **Is presentation sequence a first-class obligation?** Yes costs +42 obligations, shifted weights, and a full rebuild; no accepts that a routing change hiding a whole question is invisible. (Finding 15.)

5. **Is logic discovery being measured at all?** If yes, the harness must serve fixtures that do not contain their own specification and must bar page-source inspection. If no, say so explicitly and stop claiming otherwise. (Finding 8.)

6. **Can the corpus and the ground-truth format express "the document is wrong" and "the document is ambiguous"?** This is the largest and longest-lead decision in the audit, and the direction lens's central point. (Finding 7 / §8.)

7. **What is "browser time", and are concurrent attempts legal?** The current definition cannot be honestly reported by the architecture the design doc specifies. (Finding 14b.)

8. **Should cost certification fail closed on unpriced components?** Today an unverifiable third of the total passes silently as verified. (Finding 14a.)

9. **What does "quarantined" evidence mean** — creditable but flagged, or not integrity-valid? (Finding 17d.)

10. **Is the reserved-identifier namespace a code fix or a published contract rule?** The code fix is strictly better (no burden on the agent, no loss of detection), but it is the owner's call whether to change how identifiers are minted. (Finding 5.)

---

## 8. Direction lens — is this the right thing to build?

Separated out because it is a different question from correctness, and because two of the three lenses that looked at direction had their claims killed. Only one survived, and it survived cleanly.

### What survived

**The apparatus can only express one direction of the problem it exists to solve.**

The corpus plants exactly one shape of bug: the site disagrees with a correct document. The ground-truth format *cannot represent* the other shape — an obligation's requirement is defined as clean intent even on a broken target, and a planted defect is defined as document-says versus site-does. There is nowhere to put "the spec is wrong" or "the spec is ambiguous."

The public schema already anticipates this. It offers finding kinds for ambiguity and for document-versus-site disagreement. They are **inert**: the scorer considers only findings of kind "defect", so an agent that correctly surfaces an ambiguous spec is neither credited nor penalized. That is the sharpest single fact in this section — the contract has a slot for the most valuable thing a real survey QA process produces, and the scorer walks past it.

And extraction is circular. The questionnaire and the ground-truth requirement text come from the *same renderer*: 13 of 18 requirement strings for the first survey appear byte-for-byte in the document. So the extraction accuracy that P1 gates on is largely a verbatim-copy score and a near-upper bound.

**Why this is a direction finding and not a bug.** Nothing here is broken. Every piece does exactly what it was built to do, and does it rigorously. The issue is that the thing built measures logic conformance, and the dominant class of real finding — on the evidence of how real survey programming works — is spec ambiguity and spec error, which this apparatus was never able to produce, score, or represent. The gates will be met. They will transfer to less than they appear to.

### What was killed, and why it matters that it was

Two other direction claims were refuted, and both refutations are instructive.

- **"Extraction accuracy measures agreement with a private decomposition."** Killed on the facts: the allegedly-merged obligations are two separately authored document paragraphs with different stimuli and different expected observables, the granularity rule *is* documented in the contract, and the alternative reading reverses the design doc it cites. The apparatus is more principled here than it looked.
- **"Every metric requires a hidden answer key, so nothing transfers to production."** Killed: several metrics are oracle-free and transfer directly, repeatability is oracle-free and *is* in the gate ladder, and the report contract already requires a different completion label for runs with no hidden key. Worse, the proposed remedy (make agent-reported confidence trust-bearing) is the same class of hole as a known defect and is excluded by a documented deliberate posture.

The signal in those two refutations: **the trust architecture is thought through further than an outside reader assumes.** The direction risk is not that the design is naive. It is narrower and more specific — one whole class of real-world finding is outside the contract's expressive range, and the extraction metric is partly measuring a copy operation.

### Recommendation

Do not treat this as a P0 defect to fix before shipping P0. Treat it as the **P1 scope decision**, and take it in this order:

1. **Contract first** — no corpus work is scoreable until the ground-truth format can carry both what the document states and what was intended, plus an ambiguity marker with the admissible readings, and until a planted defect can declare its side. Then wire the two inert finding kinds into the matching and credit path.
2. **Corpus second** — a document-side variant track (wrong document, omitted spec, genuinely ambiguous routing, at least one multi-cause defect), and a deliberately messier document surface so extraction stops measuring string copying.
3. **Meanwhile** — record the current extraction number explicitly as *a ceiling measured on machine-canonical text*, and list the untested finding classes in the P0 gate write-up. Do not ratify the P1 threshold on this corpus.

---

## 9. Per-lens coverage and self-declared gaps

Every lens was asked to state what it could not check. These are the known blind spots of this audit.

| Lens | What it did | Its biggest self-declared gap |
|---|---|---|
| **Corpus fidelity** | Independently extracted all six questionnaires and diffed against definitions; applied each of the 18 defect patches alone and drove the real engine; enumerated full path sets and rendered screens per patch; built a zero-interaction black-box attack; ran all four repo verifiers. | Never launched a real browser — everything ran through the logic core, so DOM-layer divergences are only covered by the repo's own shim, unaudited. Did not push the false-positive scenarios through the scorer. |
| **Oracle taxonomy** | Read the engine end to end against the deriver; ran a mutation sweep re-deriving obligations from mutated definitions (question/loop/row reorder, seed, section, title, intro, end screens); executed the real engine clean vs flawed under single- and multi-selection. | Did not build a full synthetic submission to literally print "testing complete" under single-selection only — that step is read from the code, not executed. Mutation sweep was 9 hand-picked mutations, not exhaustive. |
| **Oracle integrity** | Reproduced all records byte-identically in a scratch copy; ran four mutation experiments (dead branch, intro rewrite, whole-tree line-ending conversion, unknown key); wrote three independent auditors (path replay, reachability cross-check, quote verbatim check); scanned the whole pipeline for nondeterminism. | Could not exercise the "unreachable" half at all — zero obligations across all twelve records are unreachable, so that entire scoring path is exercised only by synthetic targets. Did not verify the line-ending claim by actually re-cloning. |
| **Matcher gaming** | Reproduced the shipped scorecard exactly; built four mutated submissions, re-signed and scored through the real CLI; direct probes against all twelve records. | End-to-end scorecards only against one survey. Did **not** test alias bags against a *denser* ground truth (43 obligations with near-synonymous families) — flagged as the most likely place a worse version of Finding 2 is hiding. Did not probe the defect matcher at all. |
| **Crypto / parsing** | Differentially fuzzed the strict parser against the standard one on 52 adversarial inputs; attacked signature *scope*; built three signed records and a tampered artifact tree and ran the real CLI. | Did not exercise the scoring math modules beyond reading call sites. No property-based test against the schemas. Did not attempt a deep-nesting or huge-document resource attack. Could not determine who serializes the record in the eventual live harness. |
| **Evidence farming** | Grepped for every unread field; built four re-signed adversarial variants of the real run and scored each with the real CLI against the real ground truth. | Only one survey's ground truth. No real harness exists, so the zero-action run is a scorer-contract failure demonstrated against the scorer, not proof that a real harness would produce it. Did not quantify overlap with known item #1 in a combined exploit. |
| **Metrics honesty** | Traced every denominator to its producer; checked all zero-denominator branches; built a harness importing the real modules and re-signing mutated copies; six end-to-end experiments. | Did not attempt multi-run repeatability. Could not exercise the unreachable half against the real corpus. Noticed but did not fully demonstrate an asymmetry: a false "exercised" claim on an unreachable obligation earns credit with no diagnostic, while the mirror-image false claim raises an error. |
| **Test theatre** | Copied the tree to scratch; reproduced all four baselines; built a mutation harness and ran 29 semantic mutations across six modules; mutated the deriver and regenerated; built live same-length tamper counter-examples; hand-derived fixture values and the standard conformance vectors. | Did **not** mutation-test the 824 corpus checks at all — that headline number is unaudited, and given the ground-truth result it should be tested next. Four scorer modules and four ground-truth modules got no mutants. 45% is a floor estimate over chosen probes, not a calibrated score. |
| **Contract coherence** | Mapped every contract clause onto both schemas and nine modules; built a scratch harness applying one honest change at a time, re-signing, and scoring against real ground truth and real artifacts. | Did not audit the defect matcher clause-by-clause against its contract section. Read but did not differentially test the reachability model (known item #8 lives there). All demonstrations on one survey. Could not test the real harness — it does not exist. |
| **Integration audit** | Reproduced both scorecards byte-identically; compared all 18 checklist items field by field against ground truth; re-ran matching on perturbed contracts; built and scored signed submissions for every claim; probed the cross-variant swap. | Did not test the gaming attack against the other five surveys. Did not quantify how often a real model lands in the ground truth's terse register — no sample of genuine model output. Verified what the *integration* proof exercises, not what the unit suites cover. |
| **Docs vs reality** | Read all five docs end to end; recomputed every complexity weight, the cap formula, all pricing and neuron arithmetic, the OCR extrapolations; ran a greedy set-cover to test the economics claim; traced every promised mechanism into code; built a mutated fixture to demonstrate the evidence finding. | Did not spend its permitted external checks — the 2026-dated model releases and vendor benchmark claims remain unverified. Verified that reserves are *stated* to be inside the cap but did not confirm the check is implemented (intersects known item #2). |
| **Direction** | Read the full design, UI structure, contract, both schemas, the corpus generator, all planted defects, all twelve records, five scorer modules, the integration proof, and the pre-pivot test bed; built two counterfactual honest submissions at a different but defensible granularity and re-scored. | Encoded *its own* judgement of natural extraction granularity — no real model extractor was run against the documents. Only perturbed one survey; the kitchen-sink survey has far more decomposition ambiguity. Did not assess whether the record schema can actually populate the report UI. |

**Audit-wide gaps.** Five things nobody covered: (1) the 824 corpus checks were never mutation-tested; (2) no real language model was ever run as a tester, so every claim about "what an honest agent would write" is reasoned, not observed — this is the single cheapest next experiment and it would settle Findings 1, 2 and 4 empirically; (3) no real browser was driven, so DOM-layer fidelity rests on the repo's own shim; (4) no harness exists, so every harness-attested field has only ever been produced by fixture generators; (5) end-to-end scoring experiments concentrated on one of six surveys, because it is the only one with shipped runs and artifacts.

---

## 10. What is additive to the fix round already underway

Explicitly, so nothing is double-counted or dropped.

**Fully additive — new ground, not covered by any of the twelve known items:** Findings 1 (defect matcher inversion and content-blindness), 3 (unverified ground truth, write-before-validate), 5 (guessable private identifiers convicting honest testers), 6 (denial of scoring), 10 (documented requirements with no obligations), 11 (mutation kill rate, untested thresholds), 12 (undocumented artifact reference format), 13 (default test signing key), 14 (unpriced cost, unsatisfiable browser time), 15 (question order), 16 (evidence completeness versus auditability), and all of 17.

**Additive but adjacent — extends a known item and changes what its fix must be:**
- **Finding 1 changes known items #10 and #11 from calibration to contract.** The defect matcher's ranking is inverted, so lowering thresholds to admit honest prose admits boilerplate *first*. If the in-flight round tries to close #10/#11 by tuning, it will make precision worse. This is the most important sentence in this section.
- **Finding 2 subsumes and generalizes known item #9 (GAP-1).** The template obligations that GAP-1 identifies as unmatchable are the same obligations that Finding 2 shows are matchable by anyone who knows the question numbering. The fix is the same lever: give them real document-derived quotes.
- **Finding 9 must be co-designed with the fix for known item #1.** If target lists become action-derived, the two fixes overlap on the zero-action case; whichever lands first must own it explicitly.
- **Finding 11 is a prerequisite for trusting the whole round.** The twelve known fixes touch exactly the four files whose gates the suite cannot detect the loss of, and the calibration constants under revision have no regression net. Pin the profiles and add boundary fixtures *before* the round lands, or a reverted fix will be indistinguishable from a working one.

**Partly overlapping, reported for the corrected framing only:** Finding 8's core is already documented as an open caveat — the new parts are the leaked clean-intent notes on the flawed page and the mis-specified negative test. Finding 4 is adjacent to the accepted "matcher is purely lexical" deferral, but the demonstrated direction is the opposite one (false *credit* for inverted content, and wrong content outranking right content), and it contradicts a specific written guarantee rather than a deferred nice-to-have.

**Not a defect, but the largest item on the page:** Finding 7 / §8 is a P1 scope decision, not a P0 fix.

---

*Audit conducted 2026-08-01. Read-only against `E:\survey-qa` at master; all experiments in an isolated scratch copy. Twelve independent adversarial lenses, each survivor independently refuted before inclusion. Twelve claims killed in refutation and recorded in §5.*
