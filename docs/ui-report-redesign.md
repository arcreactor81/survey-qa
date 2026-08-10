# UI and Report Redesign for the LLM-Led Testing Pipeline

> ## 🔴 AMENDMENT B (2 Aug 2026) — OWNER VERDICT ON THE BUILT PAGE. **This supersedes Amendment A's information architecture and large parts of ui-adaptation-spec.md. Read it first.**
>
> **Owner, on the built v2 report:** *"results page is too complicated and tech heavy - no one cares how the system works, and i feel like we are doing verbose log dumps on the end user more than anything"* … *"there is too much jargon, info is just dumped on user, and the answer is not useful - like the result page is very long - took 20-30 seconds to scroll to end of it"*
> **Owner's structural ruling, asked directly whether v1 works because of length or shape:** *"restructure - findings first with everything else subordinate"* — so this is a RESTRUCTURE, not a trim. Do not shorten the current page by cutting sections; rebuild the IA with findings as the spine.
>
> ### The governing statement
> **The trusted Requirement Register remains the SYSTEM OF RECORD. The customer-facing product is a DECISION SUMMARY over that register, with full coverage and technical provenance available through progressive disclosure.**
>
> ### GPT's pushback, accepted: the default view may NOT be findings-only
> Readers also need a compact, unmistakable answer to *"what was actually checked, and what remains unresolved?"* — otherwise we recreate the same trust failure through OMISSION. One page, one job: **Landing** starts a run · **Tracker** says where it is · **Report** says what needs attention · **Register** proves completeness · **Audit trail** proves the machinery.
>
> ### Three views in ONE self-contained artifact (portability + permalinks preserved)
> **Summary (default)** · **Full check (119)** · **Audit trail**. They must feel like separate pages, not one enormous scroll.
>
> ### First screen — visual order is absolute
> 1 launch blocker → 2 programming defects → 3 decisions needed → 4 passed checks (quietly reassuring, NEVER an equal green tile beside the blocker). Target copy for our real run:
> *"Report ready · Survey not ready" / "**Do not launch this survey yet**" / "The survey does not open in a standard browser. Fix this launch blocker first, then rerun." / "We also found **3 programming problems** and need your decision on **2 questionnaire ambiguities**. **112 requirements passed** the completed checks." / [Review launch blocker] [Review 3 programming problems] [Answer 2 questionnaire questions] [Open full check register — 119 requirements]* then one computed, SCOPED line: *"✓ Evidence was rechecked for every result shown"* — if any displayed result lacks verified evidence this becomes an amber qualification; a generic green "Evidence verified" badge is forbidden.
> REQUIRED for this run's odd shape: *"After recording the launch failure, the remaining checks continued in the controlled test environment. Rerun the complete test after fixing the blocker."* — without it the team will reasonably ask how we tested 119 requirements on a survey that does not open.
>
> ### Finding card (issue-first, v1 proportions, better order)
> *"**Q7 · 'Can't remember' sends respondents to the wrong question**" / "High impact · Routing" / "Respondents who select **'Can't remember'** are shown Q8 instead of Q9. They therefore answer a question the questionnaire says they should skip, which can collect data from the wrong audience and affect later routing." / "**Questionnaire says:** Go to Q9  **Survey did:** Went to Q8" / "**Recommended fix:** Change the Q7 destination for 'Can't remember' from Q8 to Q9, then retest that route." / [Show evidence] [View requirement] [Copy link]*
> `Show evidence` drawer: answer sequence → screenshot/rendered-state excerpt → questionnaire source excerpt → observed destination → reproduction trace → verification conclusion → panel votes ONLY if a panel participated. A second disclosure inside it, `Technical provenance`, holds artifact ids, hashes, locators, predicate outcome, scope digest, versions, timestamps.
> **No decimal confidence, no N-of-3 scoreboard on the card** — `Confirmed` or `Needs review`. Preserve dissent by making the finding inconclusive, not by displaying model votes.
>
> ### Register = the "Full check (119)" tab + CSV/XLSX export, NOT the report body
> Questionnaire order, cross-cutting rules first, grouped by section/question. Auto-expand any group with a problem/partial/decision; collapse all-passing groups but ALWAYS show their counts in the header. Filters: Needs attention · Problems · Needs decision · Incomplete · All 119 — `All 119` always visibly available so attention-only filtering can never look like the complete denominator. Plain states only: `Passed` · `Problem found` · `Needs your decision` · `Partially checked` · `Could not test in browser` · `Not completed`. Mixed renders as *"**Inconsistent — passed on 4 routes and failed on 1**"*, auto-expanded, failing route first. Summary carries only attention rows plus *"Full check: 119 requirements · 118 exercised · 1 partially observed [Open Requirement Register]"*. "Other issues found" stays a separate lane for defects with no existing row.
>
> ### Tracker — calm and immediate, not an operations console
> Default: *"# Testing your survey" / "**Testing questionnaire paths**" / "**84 of 119 requirements checked**" / "Now checking: Q7 routing from 'Can't remember'"* + six translated phase names (✓ Reading questionnaire · ✓ Preparing checks · ● Testing survey · ○ Reviewing evidence · ○ Resolving findings · ○ Preparing report) + *"Elapsed: 12m 14s · Last activity: 18s ago"*. Never expose `extracting`/`adjudicating`/internal path ids. KEEP: artifact-derived progress only, no projected ETA, no interpolated percentage, real elapsed time, `k of N` only after the denominator is sealed, heartbeat freshness, recovery/stale handling, durable permalink, auto-transition to report, bug game clearly labelled entertainment, reduced-motion. MOVE to `Run details`: browser-session count, attempts/retries, budget % and cap, token/model calls, checkpoint revision, recovery history, path ids. Surface limits only when they change the outcome (*"Testing stopped at the approved run limit. 14 requirements remain incomplete."*). A completed phase gets a NEUTRAL checkmark — "execution completed" ≠ "survey passed". Human review gets an explicit terminal waiting state (*"**Your review is needed** — We found 119 questionnaire requirements. Confirm the list before testing begins."*) with no animation implying work.
>
> ### Vocabulary allowed in the default view — everything else is jargon
> Requirement · Check · Passed · Problem found · Needs your decision · Could not test in the browser · Not completed · Evidence · Report ready · Survey ready/not ready.
> BANNED from customer views: obligation, facet/facet instance, assertion status, certification blocker/facet, derived verdict, publication gate, coverage axis, attestation, sealed revision, contract revision id, matcher/registry/compiler version, not-browser-observable, adjudication, tripwire, scope digest.
>
> ### Layer map — NOTHING IS DELETED
> **Stays on Summary:** survey/document identity + run date · report-ready vs survey-ready · launch blocker · actionable findings · ambiguities needing a human answer · respondent consequence · recommended fix · requirement denominator + incomplete count · one scoped evidence sentence · partial/budget/time qualifications.
> **One click:** full register · screenshots and rendered-state excerpts · questionnaire source quote · answer sequence and repro · path-specific behaviour · plain-language trust explanation · panel votes/dissent when relevant · cost and run limits.
> **Audit trail:** the four raw trust statements · certification facets · contract/run/revision ids · schema/registry/matcher/compiler/predicate versions · hashes and signatures · scope digests, membership roots, witness locators · raw DOM and full action traces · evidence catalogue · as-run vs re-derived comparison · publication-gate and tripwire reason codes · model params/prompts/tokens/resources · attestation records and raw JSON export.
> Default report shows ONLY current re-derived results; as-run is an audit artifact. An overturned result gets a short revision banner, detail in Audit trail.
>
> ### Two further defects GPT caught unprompted
> 1. **The v2 landing page advertises stubbed capability.** It describes extraction, planning and execution as working and offers "Start capped run" while those stages are stubs. Until they exist: disable real submission and show a local-development banner. (This is the same overclaim pattern we spent the week deleting from our own artifacts.)
> 2. **The 2.4 MB report has no print story.** Needs summary-only print styling plus a separate "Print/export full register" action, or the next user experience is an unusable PDF.
>
> ### Explicitly overturned in `docs/ui-adaptation-spec.md`
> That the current renderer's skeleton is right · that the register is the primary report body · that hashes/registries/versions belong in the visible trust header. Its fail-closed DATA semantics remain correct; its information architecture does not.


> ## ⚠️ AMENDMENT A (2 Aug 2026) — GPT peer design input on the REPORT. **Read this before §2 and §6.1; it SUPERSEDES the sections listed at the end.**
>
> **Governing call: the Requirement Register is the primary audit body, but it must NEVER be the first thing the reader sees.** Aryaman and Sujith need a one-screen answer before the 119-row proof.
>
> **First-glance order (the current renderer has identity/navigation/"how it was driven" first — REVERSE IT):** 1 critical qualification or launch blocker → 2 overall action state → 3 result-review state → 4 scope/completeness → 5 findings → 6 register → 7 methods, hashes, provenance. **Do NOT lead with `112 pass`, attestation, run ID, cost, or model details.** For the current run the eye should land on: *"ACTION REQUIRED — the survey does not open in an unmodified browser. All subsequent results are conditional on the disclosed compatibility shim. Result review incomplete — as-recorded verdict totals are provisional."*
>
> **THE SINGLE TRUST KILLER — and a hard publication gate.** A green `Pass` whose linked artifact visibly proves failure. The first such click destroys confidence in every other row. Therefore: **no current `Pass` may receive pass styling or enter headline counts until its cited typed observation satisfies the named decision predicate.** If evidence contradicts the verdict, final-report publication FAILS CLOSED or the row becomes `Judgment pending`. Attestation cannot rescue it.
>
> **Four SEPARATE trust statements — never one green "Verified":** `Record signature: valid` (integrity only, not correctness) · `Evidence files: hash-verified` · `Contract review: sealed/reviewed` · `Result review: complete/partial/not run · policy version · N changed`. A generic green badge beside a wrong pass count is actively misleading.
>
> **Two denominators as two equal cards + one explanatory sentence**, never summed: *Document requirements — 118 of 119 fully tested · 1 partially tested* / *Mandatory browser checks — 130 of 137 completed · 7 not completed* / "One document requirement can require several mandatory checks. These totals describe different things and must not be added." **When they disagree, the weaker EXECUTION outcome controls the headline.** A parent requirement is fully tested only when EVERY mandatory child case has a valid terminal observation — touching one application of a global rule does not exercise the parent. **Data issue the build must resolve:** the frozen record calls 119 the denominator while listing 17 out-of-browser mandates separately — either show `136 documented mandates = 119 browser-testable + 17 requiring another method`, or label the 17 as a separate source-ledger population pending migration. Never call 119 complete while also presenting 17 more. Use `NOT_BROWSER_OBSERVABLE` (never `N/A`), each with a reviewed reason and, where possible, the alternative verification method and its owner.
>
> **Register ordering & collapse:** two orderings for two purposes — action summary is RISK-FIRST, register is global/cross-cutting rules pinned first then strict questionnaire order. Auto-expand every group containing a failure, mixed-path result, partial/unexecuted case, ambiguity, revised verdict, contract gap, or non-browser requirement needing action; collapse only wholly clean groups. **A collapsed parent inherits its worst descendant state and can never appear green while hiding a problem.** Filters carry a persistent disclosure (`Showing 4 of 119 requirements · 115 hidden by filters`); headline totals ALWAYS reflect the full register; print/export expands every row. Collapsed parent summary shows: plain question/section label + document location · requirement count AND mandatory-case count separately · pass/fail/partial/not-observed/ambiguous counts · mixed-path count · findings count + highest severity · "N mandatory checks hidden" · change count vs the selected baseline.
>
> **The mixed cell — primary verdict first, qualifying state second:** *"**FAIL — behavior changed by route** · 4 tested routes matched · 1 tested route diverged · Fails when Q7 = 'Can't remember': expected Q9; observed Q8."* Expanded, show a route comparison table (respondent route | document requires | survey did | result). Say **"4 tested routes"**, NEVER "usually works" — test frequency is not respondent incidence. `FAIL` stays the aggregate (fail-if-any); `Mixed across paths` explains why and must propagate to the parent group, the action queue, the baseline comparison, and print/export. Distinguish `Floor: pass · Exploration: fail` (mixed) from `one required route not tested` (INCOMPLETE, not mixed).
>
> **Re-adjudication / overturned verdicts:** support before/after in the DATA CONTRACT, but the full side-by-side is not the normal customer view. Customer default = latest accepted adjudication is current; original signed results remain immutable audit history; changed rows carry a visible revision marker; a run-level notice states how many results changed ("Evidence review revised N of 119 requirement results…"). A changed cell reads *Current: Fail / `Revised: Pass → Fail` / the cited browser trace shows Q8 immediately after 'Can't remember', contradicting the original verdict / [Compare evidence and decision]*. **A withdrawn false positive normally becomes `Inconclusive / document ambiguous`, NOT automatically `Pass`.** Requires a signed, versioned `AdjudicationRecord` binding base RunRecord hash + ContractRevision + result-policy version + scope + superseded adjudication + per-facet original/current verdict + reason code + evidence refs + decision provenance/timestamp. It may revise judgments and finding classifications ONLY; changing evidence, coverage, denominator, target build or observations requires a NEW RunRecord, not an overlay. **The replay directory is not customer authority until hash-bound and attested, and the replay must cover ALL 119 judgments — not only the three already known wrong. Until then suppress success styling and label all verdict totals provisional.**
>
> **What survey researchers need in EVERY finding (promote these):** question number + respondent-facing wording + answer labels/codes · the exact trigger/answer vector · expected destination/state vs actual · **respondent consequence** (wrong screen-out, ineligible follow-up, missing data, biased response, unusable variable, device-specific friction) · a reproduction recipe in SURVEY language · "what needs fixing" and "what to retest" · whether it is universal / route-specific / device-specific / intermittent · a direct evidence link. For routing and termination give a **branch matrix**: answer code+label → expected next screen → observed next screen → tested upstream routes. For ambiguities show BOTH document readings and the decision the owner must make. For non-browser requirements show who or what must verify them.
>
> **DIV-001 gets a permanent top-level lane** — *"Critical operational blocker outside the document-derived denominator"*. It must not be buried because the expert answer key omitted it; it stays outside the score unless promoted through the contract-gap workflow, but it is the most consequential practical finding.
>
> **Demote to Audit/Methods:** Ed25519/RFC details, artifact hashes, schema and matcher versions, prompt hashes and token counts, raw attempt IDs and state fingerprints, the full evidence catalogue, model-by-model votes unless a material dissent exists. They need to know evidence was verified; they do not need the cryptography before learning that Q7 routes incorrectly.
>
> **SUPERSEDED BY THIS AMENDMENT:** §2.2 (generic attestation "Verified" → the four trust axes) · §2.3 (single extracted-contract denominator → document requirements + mandatory execution cases + explicit alternative-method accounting) · §2.4 (`document-live-disagreement` RETIRED — under document-is-truth a supported divergence is a site defect; genuine ambiguity remains separate) · §2.5 (a renderer-chosen confidence threshold cannot determine scope integrity → use sealed review states, source-ledger gaps, adjudicated ambiguities) · §2.6 and §6.1 (flat obligation table → requirement → facet → mandatory-case hierarchy with mixed-cell aggregation) · §2.9 (lexical `matcherVersion` is no longer a useful customer audit field → ContractRevision, claim-registry, observation-policy, result-policy versions) · §7.1–§7.2 (RunRecord v1 as sole final-result authority and "no schema change required" are OBSOLETE → sealed ContractRevision + RunRecord v2 observations + a result-adjudication chain). "Testing complete against the extracted contract" becomes **"Testing complete against sealed Requirement Register revision X."**
>
> **STILL VALID from the original document:** findings-first action summary · questionnaire-order audit · separate coverage/verdict axes · report-complete vs test-complete · partial-run honesty · evidence drill-down · lazy hash-checked artifacts · the rendered report remaining a non-authoritative view.


**Status:** Tier-1 design proposal  
**Scope:** Landing page, live progress, final report, audit interactions, delivery phases, and UI-facing data contracts  
**Out of scope:** Pixel-level layouts, model-routing implementation, scorer algorithms, and evidence-retention policy

## 1. Design decisions

The redesign is governed by six decisions:

1. **The report is findings-first for action, then questionnaire-order for audit.** Severity-only ordering would hide untested obligations; questionnaire-only ordering would bury urgent defects.
2. **The obligation is the primary report unit.** A path explains how obligations were exercised; it is not the denominator. One path may cover several obligations, and one obligation may have several attempts.
3. **Coverage and verdict remain visibly separate.** “Exercised” never means “passed,” and “not assessed” never means “passed.”
4. **Report completeness and test completeness are separate outcomes.** A complete report may honestly describe a partial test.
5. **Progress is a ledger of observed work, not a loading animation.** No global completion percentage, fake timer, projected ETA, or inferred milestone is permitted.
6. **The rendered report is a view, not the authority.** The signed `RunRecord` and scorer output remain the authoritative sources.

## 2. Report-page information architecture

### 2.1 Primary reading order

The report uses the following stable order:

| Section | Purpose |
|---|---|
| Run identity and trust | Establish which document, survey build, configuration, and signed record the report represents |
| Completion banner and executive summary | Make complete/partial/failed state unmissable and summarize findings, coverage, and cost |
| Findings requiring action | Surface defects, blockers, disagreements, and unresolved dissent |
| Scope and extraction review | Show ambiguities, low-confidence extraction, assumptions, and resulting scope risk |
| Coverage audit | Account for every question, programming rule, branch outcome, and terminal behavior in questionnaire order |
| Verification and evidence | Explain how conclusions were checked and provide evidence drill-down |
| Cost, limits, and provenance | Pair achieved coverage with attested resource use and expose the audit trail |

The findings summary may sort by severity and then questionnaire position. The canonical coverage audit always remains in questionnaire order. Filters may change the view in P2, but never the stable audit/export order.

### 2.2 Run identity and trust header

The header shows:

- Run ID and target URL/environment.
- Questionnaire document identity and hash.
- Target build ID and hash.
- Run profile and configuration hash.
- Generated and signed timestamps.
- `RunRecord` schema version.
- Attestation state: `Verified`, `Verification unavailable`, or `Invalid`.
- Signing key ID and payload hash.
- Scorer and `matcherVersion` when a scorecard exists.

An invalid attestation produces a fail-closed warning above every result:

> **Record integrity check failed. Results below are not authoritative.**

Quality and coverage scores must not receive normal success styling when attestation or run identity is invalid.

### 2.3 Completion and executive summary

The first result block always states both outcomes in words:

- **Report complete / Report incomplete**
- **Testing complete / Testing partial**

For example:

> **Partial report ready — budget cap reached.**  
> The report accounts for all 42 extracted obligations, but only 31 were exercised. Untested items are not passes.

For corpus runs, “testing complete” is scorer-verified against the private oracle. For ordinary survey runs without an oracle, the label must say **“Testing complete against the extracted contract”** so it does not imply that extraction itself was perfect.

The summary contains separately named denominators:

- Exercised obligations out of the extracted contract total.
- Proven-unreachable obligations.
- Unassessed obligations by cause.
- Verdict counts among exercised obligations: pass, fail, and inconclusive.
- Findings by kind and severity.
- Actual attested cost beside the enforced cost cap.
- Wall-clock duration beside its cap.
- Optional scorer-defined weighted coverage and cost per verified coverage unit.

The browser must not invent weighted coverage or cost-per-unit. Those values appear only when supplied by the scorer with a named formula/version.

Do not use cost per defect as a quality indicator. A clean survey can legitimately have zero defects.

### 2.4 Findings requiring action

The summary is no longer an N-of-3 consensus list. It is an index of reported findings whose verification state is shown explicitly.

Order:

1. Critical and high-severity asserted defects.
2. Blockers.
3. Document-versus-live disagreements.
4. Inconclusive or disputed findings.
5. Remaining findings.

Each finding shows:

- Kind and agent-assigned severity.
- Summary.
- Expected versus observed behavior.
- Affected questionnaire items.
- Finding confidence.
- Verification disposition when available: `confirmed`, `rejected`, `inconclusive`, or `not routed for panel review`.
- Evidence and attempt references.
- Link to each affected audit item.

A `RunRecord.findings` entry is an agent-supplied assertion. The UI must not silently relabel it “confirmed” without a verification record or scorer result.

A `document-live-disagreement` is not automatically an implementation defect. It remains a separate finding type so the team can decide whether the document or live behavior is authoritative.

### 2.5 Extraction ambiguities and scope integrity

Extraction quality is a first-class report section because every downstream coverage claim depends on the extracted contract.

Show:

- Explicit ambiguity findings.
- Low-confidence items identified by the report builder or scorer—not by a browser-selected threshold.
- Source anchor and questionnaire excerpt.
- Extracted interpretation.
- Alternative interpretations when present in a verification record.
- Affected obligations and planned paths.
- Panel disposition and preserved dissent.
- Contract assumptions.
- Whether the ambiguity remained unresolved.

An ambiguity is not a confirmed survey defect. Its impact is that the test scope or expected behavior may be uncertain.

The contract denominator becomes final only after required extraction review is complete and `contractHash` is sealed. It must not change after browser execution begins. Before sealing, the UI says:

> Building coverage contract — obligation total not established.

It must never show `0 of 0`.

### 2.6 Questionnaire-order coverage audit

The audit body is the comprehensive answer to the owner’s mandate: every extracted question, programming rule, branch outcome, and terminal behavior remains visible, including unfinished items.

P1 may use a flat table in canonical `contract.items` order. P2 may group items under questionnaire sections and parent questions, but every obligation remains an individually addressable row.

Each item shows:

- Stable tester-local item ID.
- Questionnaire/source location and excerpt.
- Obligation type.
- Requirement, preconditions, stimulus, and expected observable.
- Extraction confidence.
- Coverage status.
- Verdict.
- Result confidence and structured reason.
- Related findings.
- Attempt and evidence counts.
- P2 permalink.

The two statuses render as separate text-and-icon labels:

| Coverage axis | Meaning |
|---|---|
| `exercised` | The target behavior was actually exercised |
| `not-reached` | The intended state was not reached |
| `proven-unreachable` | Supported evidence establishes that the state cannot be reached |
| `blocked` | An external or technical blocker prevented exercise |
| `budget-exhausted` | Testing stopped at the enforced monetary/resource budget |
| `time-exhausted` | Testing stopped at the wall-clock cap |
| `pending` | No terminal disposition was reached |

| Verdict axis | Display meaning |
|---|---|
| `pass` | Matches the questionnaire requirement |
| `fail` | A mismatch was observed |
| `inconclusive` | Evidence or validation did not support a final judgment |
| `not-assessed` | No verdict was made |

`Exercised` uses neutral styling rather than success green. Color is never the only signal. Invalid status/verdict combinations produce a record-integrity warning instead of being normalized by the frontend.

Extraction confidence and result confidence must be labelled separately; they answer different questions.

### 2.7 Evidence and attempt drill-down

The P2 item expansion follows the evidence chain rather than showing a miscellaneous attachment gallery:

1. Requirement and expected observable.
2. Attempt ledger.
3. Browser evidence.
4. Deterministic verification.
5. Single-verifier result.
6. Independent panel votes.
7. Bounded reconciliation and final disposition.

Attempt details include:

- Attempt and path IDs.
- Synthetic input vector.
- Starting state and last valid state.
- Ordered actions.
- Before/after state fingerprints.
- Retry linkage and reason.
- Stop reason.
- Related evidence.

Evidence behavior:

- Metadata and hash render immediately; artifact bytes do not.
- Screenshots and large artifacts load only when expanded.
- The evidence service verifies stored bytes against the signed catalog hash before serving them.
- P2 may additionally verify the downloaded bytes with Web Crypto.
- Screenshots include a factual accessible label such as the item, attempt, and capture step.
- DOM excerpts render as inert escaped text, never executable HTML.
- Action traces render as a keyboard-readable table or timeline.
- Missing, access-restricted, or redacted evidence retains its catalog metadata and displays the reason it is unavailable.
- Failure to load one artifact must not break the item or report.

Panel review displays the original independent votes before the reconciliation result. Each vote shows:

- Provider/model or stable panelist attribution.
- Vote and confidence.
- Concise evidence-based reason.
- Evidence references.

Hidden chain-of-thought is never rendered. Only structured decisions and concise supplied reasons are report data.

Dissent remains visible. If the panel cannot resolve a material disagreement, the affected result remains `inconclusive`. “Panel not invoked by routing policy” is distinct from unanimous agreement.

### 2.8 Partial, failed, and unavailable states

`PARTIAL-BUDGET` and `PARTIAL-TIME` receive a prominent banner in the web report and print/export output.

The banner states:

- The stopping reason.
- Report completeness.
- Test completeness.
- Exercised and unassessed counts.
- Actual spend and cap, or elapsed time and cap.
- The protected verification/report reserve when it explains why execution stopped before total spend reached 100%.

A budget-partial report may therefore say:

> Testing stopped to preserve the verification and reporting reserve. The final report is complete; 11 obligations remain unassessed.

If reporting fails after testing finishes, show a recovery/failure page with the last authoritative coverage snapshot, available attempt/evidence links, error, heartbeat, and recovery state. Do not calculate a final client-side score or call this page a completed report.

If extraction fails before a contract exists, show “Obligation denominator unavailable,” not zero coverage.

If polling or evidence delivery fails, distinguish “Live status unavailable” or “Artifact unavailable” from a failed run.

### 2.9 Audit affordances

P2 adds:

- Stable item permalinks.
- Finding-to-item, item-to-attempt, and attempt-to-evidence links.
- Copyable run, item, finding, attempt, and evidence IDs.
- Visible artifact SHA-256 hashes.
- Server verification state for the RunRecord attestation.
- `matcherVersion`, scorer version, pricing version, model/tool versions, and prompt hashes.
- Download of the canonical signed RunRecord.
- Optional authorized download of the scorer-produced scorecard.
- Print/export treatment that preserves partial-state warnings and the full denominator.

The rendered report remains explicitly labelled as a view generated from the signed source records.

## 3. Honest progress tracker

### 3.1 Phase chips

Replace the stage `0/1/2` lighting with six phase chips:

`Extracting · Planning · Executing · Verifying · Adjudicating · Reporting`

They are activity states, not equal percentages or a promised linear timeline. Verification can overlap execution, adjudication can be skipped, and recovery can revisit earlier work.

Each phase has a server-authored state:

- `pending`
- `active`
- `complete`
- `skipped`
- `stopped`

The frontend never infers phase completion from enum order.

| Phase | Observable completion |
|---|---|
| Extracting | Schema-valid coverage contract committed after required extraction review |
| Planning | Path-plan revision committed |
| Executing | Scheduler records execution finished; a limit/failure records `stopped` |
| Verifying | Required verification records for the achieved scope are persisted |
| Adjudicating | Reconciliation record committed, or backend explicitly records `skipped` |
| Reporting | Final report manifest and its required source records are resolvable |

A partial run can correctly show `Executing: stopped` and `Reporting: complete`.

### 3.2 Live coverage ledger

Once the contract is sealed, the primary factual headline is:

> **17 of 24 obligations exercised**  
> Contract denominator · Confirmed 14:07:18

The ledger then shows every coverage bucket so the denominator reconciles:

- Exercised
- Not reached
- Proven unreachable
- Blocked
- Budget exhausted
- Time exhausted
- Pending

The counts must sum to the sealed contract total.

The current-work block shows only durable facts:

- Current active attempt and path label.
- Stable path and attempt IDs.
- Committed attempt count.
- Actual attested cost versus cap.
- Protected verification and report reserves.
- Model/tool calls versus enforced caps where useful.
- Wall-clock consumption versus cap.
- Snapshot revision and observed timestamp.

Do not average cost, call, and time percentages into a generic “budget used” number. Each limit retains its own name and denominator.

Budget and wall-clock values are frozen at the last server snapshot. The UI may update heartbeat age locally, but it may not animate usage, coverage, attempt counts, or phase state between snapshots.

### 3.3 Heartbeat and recovery

Carry forward unchanged:

- Real heartbeat timestamp and three-minute age treatment.
- Recovery sub-line when `recoveryMode` is active.
- `*/5` sweeper recovery behavior.
- Refresh-safe run restoration.
- Last confirmed state during temporary polling failure.

Add a distinction between:

- **Last heartbeat:** proof that the process checked in.
- **Last durable progress:** the most recent committed artifact or state change.

A heartbeat is not itself progress.

At three minutes without a heartbeat:

> No confirmed heartbeat for 3m 12s. Recovery monitoring remains active.

Do not declare failure or start a speculative countdown.

Recovery never resets counters. Clients reject older snapshot revisions so a delayed response cannot make progress appear to move backward.

The bug game survives as a separate, optional “Play while you wait” panel. It remains motion-opt-in and reduced-motion safe, and it never advances based on presumed backend progress.

## 4. Landing page and run form

### 4.1 Inputs and modes

Retain the two entry paths with truthful labels:

- **Demo/sample**
- **Test your survey**

For a real run, both remain required:

- **Survey specification (.docx):** the expected-behavior source.
- **Live survey URL:** the system under test.

Do not add vendor selection; the pipeline is intended to be vendor-agnostic.

A demo may be described as using the same pipeline only when it actually launches the new pipeline. Cached output must be labelled **Sample report**, not **Live demo**.

### 4.2 Run policy and cost consent

Before submission, show the server-sourced effective policy:

- Profile name.
- Hard monetary cap.
- Wall-clock cap.
- Model/tool-call limits where material.
- Verification and reporting reserves.
- Whether deep mode is enabled.
- Warning that a limit may produce a valid partial report.

Suggested expectations copy:

> This is a live, evidence-backed test, not the former 3–4 minute demo. It has no promised duration or ETA. Model and browser work incurs real API cost up to the displayed cap. The run stops when testing finishes or an enforced limit is reached; a stopped test may still produce a complete partial report. Progress shows recorded work only.

The primary action may repeat the monetary maximum:

> **Start capped run — up to $5.00**

Do not say the user will personally be billed unless that is actually true.

The submitter acknowledges that they are authorized to test the target URL and accepts the displayed run cap. The run-creation response returns the accepted profile and enforced limits; subsequent pages use those returned values, not the client’s requested values.

### 4.3 Deep mode

Deep mode is:

- Owner-authorized.
- Default off.
- Enforced server-side.
- Defined by a named versioned profile.
- Accompanied by its actual path, retry, verification, and cap differences.

Do not describe it as exhaustive, guaranteed, or complete. If the user lacks permission, hide it or show a non-actionable “Owner approval required” state.

Changing mode must refresh the server-sourced cap summary before submission.

## 5. What survives and what retires

| Survives | Retires |
|---|---|
| Neutral gray-green parchment theme | Stage `0/1/2` and walk/legs/report terminology |
| WCAG AA contrast, keyboard access, focus treatment, and reduced-motion support | Global progress percentages not tied to a named denominator |
| Honest-progress principle | Old 3–4 minute expectation and projected duration copy |
| Heartbeat, recovery sub-line, and sweeper UX | N-of-3 consensus as the report’s primary organizing model |
| URL plus `.docx` run flow | Three independent execution-leg cards |
| Optional bug game | Seeded-error scorecard as the normal customer-report headline |
| Slim status endpoint pattern | One “success” badge that collapses report, testing, coverage, and verdict |
| Refresh-safe run permalink | Full-run/evidence payload polling |
| Existing report artifact pipeline | Eager loading of screenshots and evidence |
| Corpus scorecard in a clearly labelled acceptance/demo appendix | Treating report-file appearance alone as proof that testing completed |

## 6. Delivery phasing

### 6.1 P1 — visibly thin end-to-end slice

P1 reuses the current application shell and proves the new contracts without building the full audit explorer.

Landing page:

- Relabelled URL and `.docx` inputs.
- Server-sourced profile and enforced caps.
- Owner-gated deep-mode control.
- Cost/authorization acknowledgement.
- Updated expectations copy.

Progress page:

- Six phase chips with explicit states.
- Sealed-contract exercised/total headline.
- All seven aggregate coverage buckets.
- Current path/attempt facts.
- Actual cost and wall clock versus caps.
- Existing heartbeat, stale, recovery, and sweeper behavior.
- Correct complete, partial-budget, partial-time, and failed states.

Static/server-generated report:

- Run identity and attestation state.
- Explicit report-complete versus test-complete sentence.
- Coverage and verdict summaries.
- Findings list.
- First-class ambiguity and document/live-disagreement sections.
- Complete flat item table in canonical contract order.
- Both statuses, result reason, and confidence per item.
- Actual resource totals and caps.
- Plain evidence links with artifact type, size, and hash.
- `matcherVersion` and corpus scorecard summary when applicable.

P1 intentionally excludes:

- Dynamic filtering and search.
- Rich evidence lightbox.
- Item-level live progress.
- Full attempt timeline.
- Per-model vote explorer.
- Client-side hash verification.
- Item permalinks.
- SSE/streaming transport.
- Complex visual analytics.

P1 does not pass only because a happy-path report renders. UI fixtures must cover:

- Denominator not yet established.
- Normal active execution.
- Stale heartbeat.
- Recovery mode.
- `PARTIAL-BUDGET`.
- `PARTIAL-TIME`.
- Report complete with testing partial.
- Testing complete with reporting failed.
- Failure before extraction.
- Failure after some attempts.
- Invalid attestation.
- Keyboard, screen-reader, reduced-motion, and non-color status interpretation.

### 6.2 P2 — full audit experience

P2 adds:

- Grouped questionnaire-order audit navigation.
- Search and filters by status, verdict, type, severity, and confidence.
- Alternate findings/severity views without changing canonical audit order.
- Item-level live ledger.
- Attempt and path drill-down.
- Lazy screenshot, DOM, state, and action-trace viewer.
- Client-side artifact hash verification.
- Independent panel votes, reconciliation, and preserved dissent.
- Stable item permalinks and cross-links.
- Detailed cost breakdown by execution role, model, and panelist.
- Phase visit/revisit history.
- Incremental event delivery with polling fallback.
- Richer owner controls for versioned run profiles.

Blind-questionnaire validation remains post-P1, per the owner’s sequencing decision.

## 7. UI data contracts

### 7.1 Source-of-truth separation

| Source | Purpose | Browser exposure |
|---|---|---|
| Signed `RunRecord` v1.0.0 | Final contract, item results, findings, attempts, evidence catalog, resources, limits, and attestation | Authorized final-report access |
| `RunProgressSnapshot` | Mutable artifact-derived live state | Progress page |
| `ScorecardRecord` | Scorer validation, completeness, matcher version, weighted coverage, and corpus-only oracle metrics | Post-run authorized summary |
| `VerificationRecord` | Structured verification routing, independent votes, reconciliation, and dissent | Post-run report drill-down |
| Evidence objects | Screenshots, DOM excerpts, traces, and state artifacts | Lazy authorized retrieval |
| `ReportView` | Non-authoritative presentation model derived from the above | Report page |

`OracleRecord` is never a direct UI source. Corpus reports receive only an authorized post-run scorecard; raw oracle obligations, witness paths, and seeded labels remain private.

### 7.2 RunRecord v1 implications

No RunRecord schema change is required for the P1 UI.

Two semantic rules must be fixed in the producer contract:

1. `contract.items` array order is canonical questionnaire order for P1.
2. Once execution starts, `contractHash` and the denominator are immutable.

RunRecord v1 records model-call provenance and panelist cost, but it does not record independent votes, reconciliation, or dissent. P2 therefore needs a versioned `VerificationRecord`; the frontend must not reconstruct votes from model-call logs.

The recommended P2 implementation stores `VerificationRecord` as a hashed RunRecord evidence artifact using `type: "other"` and a dedicated media type such as:

`application/vnd.survey-qa.verification-record+json`

Its structured entries reference item IDs, finding IDs, evidence IDs, attempt IDs, and `resources.modelCalls[*].callId`. Original votes are immutable and remain separate from the reconciliation outcome.

A versioned `ScorecardRecord` should bind:

- RunRecord digest.
- OracleRecord digest when applicable.
- Scorer version.
- Matcher version.
- Evidence-policy version.
- Calculated metrics and completeness states.

### 7.3 Slim status endpoint

Keep:

`GET /api/runs/:id/status`

Retain existing `status`, `stage`, `error`, `recoveryMode`, and legacy `progress` fields during migration. New clients stop rendering `stage`.

Add:

```json
{
  "schemaVersion": "run-status/2.0.0",
  "runId": "run-id",
  "phase": "executing",
  "phases": [
    {
      "name": "extracting",
      "state": "complete",
      "observedAt": "2026-08-01T14:00:00Z",
      "reasonCode": null
    }
  ],
  "completion": {
    "test": "running",
    "report": "not-started",
    "reasonCode": null
  },
  "heartbeatAt": "2026-08-01T14:07:18Z",
  "lastProgressAt": "2026-08-01T14:06:51Z",
  "progressRevision": 31,
  "reportAvailable": false
}
```

`completion.test` values:

- `not-started`
- `running`
- `complete`
- `partial-budget`
- `partial-time`
- `partial-blocked`
- `failed`

`completion.report` values:

- `not-started`
- `building`
- `complete`
- `failed`

A phase changes only from a durable backend checkpoint. The frontend never derives per-phase states from the single `phase` value.

The slim endpoint remains small. It tells the client whether a newer coverage snapshot exists; it does not carry item lists or evidence.

### 7.4 Live coverage endpoint

Add:

`GET /api/runs/:id/coverage`

P1 response shape:

```json
{
  "schemaVersion": "coverage-snapshot/1.0.0",
  "runId": "run-id",
  "revision": 31,
  "observedAt": "2026-08-01T14:07:18Z",
  "sourceCheckpointHash": "sha256:...",
  "contract": {
    "state": "sealed",
    "contractHash": "sha256:...",
    "total": 42
  },
  "counts": {
    "exercised": 18,
    "not-reached": 6,
    "proven-unreachable": 1,
    "blocked": 2,
    "budget-exhausted": 0,
    "time-exhausted": 0,
    "pending": 15
  },
  "currentAttempt": {
    "attemptId": "attempt-id",
    "pathId": "path-id",
    "pathLabel": "Q7 = No → Q12",
    "attemptNumber": 2
  },
  "attempts": {
    "started": 9,
    "completed": 8
  },
  "usage": {
    "cost": {
      "usedUsd": 2.41,
      "maxUsd": 5,
      "verificationReserveUsd": 0.75,
      "reportReserveUsd": 0.5
    },
    "modelCalls": {
      "used": 21,
      "max": 50
    },
    "toolCalls": {
      "used": 84,
      "max": 200
    },
    "wallClock": {
      "usedMilliseconds": 742000,
      "maxMilliseconds": 1800000
    }
  }
}
```

Before extraction completes, `contract.state` is `unavailable`, `contractHash` and `total` are `null`, and coverage counts are not presented as a final denominator.

Rules:

- Snapshot fields come from one atomic durable checkpoint.
- Revisions increase monotonically, including across recovery.
- After sealing, counts sum to `contract.total`.
- Usage is observed/attested telemetry as of `observedAt`; it is not a projection.
- `currentAttempt` is `null` between attempts.
- The client calculates named percentages from `used / max`; it never combines limits.
- Use `ETag`, `If-None-Match`, and `Cache-Control: no-store`.
- P1 polls status and fetches coverage only when `progressRevision` changes.
- P2 may add an event stream that announces revisions; reconnecting clients always refetch the authoritative snapshot.

Live progress state does not belong in the final RunRecord.

### 7.5 Report and evidence endpoints

Retain or add:

- `GET /api/runs/:id/report` — server-generated report HTML.
- `GET /api/runs/:id/report-data` — P2 `ReportView`.
- `GET /api/runs/:id/record` — canonical signed RunRecord.
- `GET /api/runs/:id/scorecard` — optional authorized ScorecardRecord.
- `GET /api/runs/:id/evidence/:evidenceId/content` — lazy authorized artifact content.
- P2: `/runs/:id/report/items/:itemId` — stable item permalink.

The report builder uses these sources:

| Report content | Authoritative source |
|---|---|
| Run/document/build identity | `RunRecord.run` |
| Questionnaire-order obligations | `RunRecord.contract.items` |
| Coverage and verdict axes | `RunRecord.itemResults` |
| Findings and expected/observed mismatch | `RunRecord.findings` |
| Attempts and state lineage | `RunRecord.attempts` |
| Evidence metadata and hashes | `RunRecord.evidence` |
| Cost, calls, model/tool versions, and limits | `RunRecord.resources` |
| Attestation | `RunRecord.attestation` plus server verification result |
| Panel votes and dissent | `VerificationRecord` |
| Matcher version and corpus metrics | `ScorecardRecord` |
| Live failure/recovery summary | Last `RunProgressSnapshot`, clearly labelled non-final |

The evidence content endpoint:

1. Resolves `evidenceId` against the signed catalog.
2. Verifies stored bytes against `contentHash`.
3. Enforces run/report authorization.
4. Returns the declared media type and size.
5. Returns a strong digest header.
6. Fails closed on mismatch rather than rendering corrupted content.

Any thumbnail is a separate hashed derivative. If no derivative-attestation mechanism exists, omit thumbnails and lazy-load the original artifact.

### 7.6 Report endpoint behavior

Recommended behavior:

- `200` with a ready report for complete and partial-test reports.
- `202` while reporting, optionally with `Retry-After` as polling guidance—not an ETA.
- `200` with a clearly labelled failure summary when no final report exists but an operational snapshot is available.
- `409 ATTESTATION_INVALID` when a purported final RunRecord fails verification.
- `404` only when the run is unknown or inaccessible.

A partial run remains a reportable outcome. Missing evidence, missing scorecard, or absent panel detail degrades that section explicitly rather than breaking the entire report.

## 8. Decisions to lock before Tier-2 implementation

1. **Primary report organization:** findings-first summary plus questionnaire-order audit body. Recommended: accept.
2. **P1 ordering invariant:** `contract.items` order is canonical document order. Recommended: accept without reopening RunRecord v1.
3. **Panel detail contract:** add a separately versioned, hash-attested `VerificationRecord` for P2. Recommended: accept.
4. **Demo behavior:** live capped demo versus cached sample report. Recommended: support both, label each truthfully.
5. **Deep-mode policy:** owner defines the named profile, eligibility, and caps; the UI only renders server policy.
6. **Evidence access and retention:** remain an owner/security policy decision; the UI assumes authorized, redacted, lazy access and never public raw R2 links.
