# LLM-Led Survey Link Testing — Architecture Proposal

**Status:** Draft for team discussion (v1, 1 Aug 2026)
**Context:** Follows the 1 Aug alignment (Aryaman × Sujith): replace the programmatic approach with LLM-led reasoning, vendor- and survey-agnostic, hands-off from submission until the final analysis report, with a comprehensive per-logic / per-branching / per-question report built for auditability. The team's working cost assumption — not yet a commitment — is that standard runs move from the narrower ~$0.20 demo into single- or double-digit dollars; the phase gates below test and bound that assumption.

---

## 1. Recommendation, and the decisions we need from the team

**Recommendation in one paragraph.** Ditch programmatic *decision-making*, keep deterministic *control*. An LLM plans and adapts the testing of any vendor's survey, but it operates on a fixed substrate: a machine-checkable list of test obligations extracted from the questionnaire (the **coverage contract**), constrained browser tooling, hard budgets, and evidence capture on every step. This is the only shape where "LLM-led" and "auditable per question / per branch" can both be true: a free-roaming browsing agent cannot prove what it covered, and a maintained rules engine is what we just agreed to leave behind.

**Decisions needed** (defaults we recommend; everything else in this doc follows from these):

| # | Decision | Recommended default |
|---|---|---|
| 1 | **What "comprehensive" means** (decide this first) | Every question, every programming/validation rule, every branch *outcome*, every terminal state — witnessed via a small set of planned paths. **Not** every combination of answers (a 15-question survey can have millions; no budget survives that, and it adds no audit value). |
| 2 | Document vs. live survey — which is authoritative? | The document defines *expected intent*; the live survey provides *observed behavior*; any disagreement is a **finding**, never silently resolved. |
| 3 | Where the browser runs | Isolated, durable browser/container runner. Cloudflare Workers coordinate, meter, sweep, and report — they don't host hour-long sessions. |
| 4 | Agent topology | Logical **planner → executor → verifier** separation. Deterministic assertions first; independent strong-model review only for ambiguous / failed / high-risk items and evidence-grounded final synthesis. The executor never certifies its own success. No routine three-model consensus as the default: it multiplies verification calls without demonstrated commensurate coverage benefit (it was the right tool for the language-check phase). |
| 5 | Replay standard | Fresh-session re-run from the recorded input/action trace — *rerunability*, not byte-identical replay of dynamic pages. |
| 6 | Completion semantics | **Report complete** = every checklist item carries a status. **Test complete** = every reachable item was exercised and every proven-unreachable claim is evidence-backed. Blocked, not-reached, or budget/time-exhausted items make the *test* partial — but a report is always produced, even at the caps. |
| 7 | Evidence retention | Redacted, private storage; PoC default 30 days raw evidence / 90 days final reports (configurable later). |
| 8 | Anti-bot & human handoff | Never bypass CAPTCHAs/auth/anti-bot; blockers become findings. Human handoff disabled in early phases. |
| 9 | Data & submissions | Synthetic identities only, no real PII, allowlisted domains, no irreversible submission unless explicitly authorized. |
| 10 | Untrusted page content | Survey pages are untrusted input (prompt-injection risk): the navigator gets constrained tools, restricted egress, and **no secrets in its context**. |

## 2. Success definition, scope, non-goals

**Success:** hand the tool a survey link + questionnaire document; come back to a report where *every* question, rule, branch outcome, and terminal state has a status and evidence — at a cost inside an agreed envelope, on vendors we've never written code for.

**Non-goals** (scoped out deliberately):
- Exhaustive testing of every answer combination.
- Pixel-perfect visual, accessibility, performance, or security testing (separately scopable later).
- Bypassing CAPTCHA, authentication, or anti-bot controls.
- Real respondent PII, or irreversible submissions by default.
- Bit-identical replay of dynamic pages or of LLM decisions.
- Silently resolving ambiguous or contradictory questionnaire documentation (ambiguities are surfaced, not guessed away).

## 3. The coverage contract

The center of the design. At run start, an ingestion step reads the questionnaire and produces a **versioned checklist of test obligations** — the run's fixed denominator. Results live in a separate run ledger; live discoveries never silently rewrite the original denominator.

The contract header records the document hash, target URL/environment, locale/device and synthetic-data assumptions, extraction model/prompt versions, and any documented ambiguities. Each item carries: a stable ID and type (question / branch outcome / validation rule / display-skip / piping / calculation / randomization-quota / terminal), the exact document reference and plain-language requirement, preconditions and dependencies, the stimulus needed to exercise it, the expected observable result, required outcome variants, and priority + privacy sensitivity + extraction confidence.

**Miniature example.** Questionnaire says: *"Q3. Have you used Product X? (Yes/No). IF Q3=No SKIP TO Q7. Q4–Q6 usage details. TERMINATE IF Q5=Never."* The contract for just this fragment:

| Item | Type | Exercise by | Expect |
|---|---|---|---|
| Q3 appears, options Yes/No | question | reach Q3 | rendered, both options |
| Q3=No → Q7 | branch outcome | answer No | Q4–Q6 never shown |
| Q3=Yes → Q4 | branch outcome | answer Yes | Q4 shown next |
| Q5=Never terminates | terminal | Yes-path, Q5=Never | terminate page |
| Q4–Q6 each appear | question ×3 | Yes-path | rendered as documented |

Seven obligations, coverable in **three planned paths** — No → Q7; Yes + Q5=Never → terminate; Yes + Q5≠Never → through Q6 — that's the whole idea: the checklist is the *accountability* unit, a planned path is the *execution* unit, and each path satisfies several items.

Two things get scored, separately: **execution coverage** (did we exercise the checklist?) and **extraction accuracy** (did the checklist faithfully capture the document?). Without the second, an incomplete checklist reports a misleading 100%.

## 4. How one run works

1. **Ingest:** document → coverage contract (checklist + hashes + extraction provenance). Ambiguities are recorded as findings-in-waiting, not guessed.
2. **Plan:** the planner produces a small set of economical paths, each declaring: target items, synthetic input vector, expected transitions, and its own step/call limits.
3. **Execute:** the browser agent walks each path from a known starting state with constrained actions, fingerprinting every meaningful page state (loop detection, repeated-state dedup). A path stops on: evidence acquired, confirmed mismatch, external block, repeated state, safety boundary, time limit, or budget cap.
4. **Verify:** in a fresh context, expected vs. observed is compared per item — deterministic assertions first (element present, page reached, sum validated), LLM judgment only for semantic cases. Retries create *new* attempts; failures are never overwritten.
5. **Report:** the coverage ledger renders into the audit report, every item carrying two axes — **coverage status** (exercised / not reached / proven-unreachable / blocked / budget-exhausted / pending) and **verdict** (pass / fail / inconclusive / not-assessed) — with links to its evidence. "Proven unreachable" requires showing that known incoming routes were considered; one failed attempt only means "not reached".

The run rides the existing PoC skeleton: Workers orchestrate, heartbeats + the */5 sweeper recover dead runs, R2 stores artifacts, and the report UX pattern (honest live progress, no fake stages) carries over.

## 5. Evidence, safety, and cost guardrails

**Minimum evidence per attempt or accounted-for disposition** (blocked / proven-unreachable / budget- or time-exhausted items carry a blocker or reachability packet plus the last valid state): manifest linking run → contract → item → attempt (with artifact hashes and timestamps); the planned path + input vector; structured action trace + state fingerprints; redacted before/after screenshots; sanitized DOM/accessibility-tree excerpts; expected-vs-observed verdict with confidence; model/prompt/browser/tool versions; token + cost telemetry. Artifacts are shared across items (a screenshot can witness several obligations); items reference, not duplicate. We store concise structured justifications, not private chain-of-thought, and promise *forensic traceability + rerunability*, not pixel-identical replay. Nice-to-haves deferred: video, HAR, console logs, visual diffs, signing beyond content hashes.

**Safety defaults:** synthetic identities; redact before persistence; no cookies/storage/full-DOM retained by default; page content treated as untrusted (constrained tools, egress allowlist, no secrets reachable from the navigator).

**Cost containment — the #1 lever is a coverage-aware hard budget, not model choice.** Tiering and caching lower *average* cost; only a hard budget bounds the *worst case*, and the worst case is what "spirals". The tiering default is an orchestrator–worker split: a strong "overseer" model plans paths and adjudicates evidence at checkpoints, while a cheap, fast model does the actual clicking and form-filling — escalating to the overseer only on stall, ambiguity, or expected-vs-observed mismatch (management by exception; per-click review by the strong model would re-spend the savings). Which models fill the seats is a bakeoff question for P1, using the phase-1 bakeoff methodology. Proposed starting guardrails (explicit hypotheses, recalibrated after Phase 1):

- Complexity weight: `W = Q + 2L + 3B` — `Q` = question obligations, `L` = non-branch logic/validation obligations, `B` = branch + terminal outcomes; each obligation counted in exactly one category.
- Standard cap: `min($30, max($5, 1.2 × ($2 + $0.15 × W)))` → ≈ $9 for W=36, ≈ $24 for W=120. A scheduling guardrail, not a price quote. Deep mode (opt-in only): $75 cap.
- Within the cap: 15% reserved for verification, 10% for guaranteed report completion. Affordability checked before every model/tool call. An independent wall-clock cap produces `PARTIAL-TIME` exactly as the budget cap produces `PARTIAL-BUDGET`.
- Max two attempts per item; replan after 8 decisions with no new coverage; 3 repeats of the same normalized state ⇒ path is loop-blocked; try breadth before paying for retries.
- Budget exhaustion ⇒ `PARTIAL-BUDGET` report: original denominator preserved, untested items named, remaining work estimated.
- Cost reporting always pairs **spend with achieved coverage**, split complete vs. partial, quoting p50/p90/max (never just the average), and includes model calls, container runtime, retries, and any external services.

## 6. What we reuse, and the Phase-0 acceptance corpus

**Reused from the current PoC** (health-checked end-to-end on 1 Aug; individual recovery paths will be revalidated in the new runtime): the recovery machinery (heartbeats, */5 sweeper, claim ladder), R2 evidence + report pipeline, docx ingestion, per-leg cost metering, honest-progress report UX, and the seeded-error methodology — which now grows into the acceptance rig. **Retired:** the deterministic walker as navigation authority, and routine 3-model consensus.

**Phase-0 corpus (in progress now):** six synthetic surveys with escalating complexity — skip logic, screeners with terminate paths, multi-select-driven branching + piping, nested branching + rotation, allocation/constant-sum tables with derived calculations, and a kitchen-sink with loops — each as a questionnaire document + a live manifest-driven survey, in clean and *flawed* variants (seeded routing/logic/calculation defects with documented ground truth). The corpus separates two artifacts: a tester-facing **runtime fixture** (self-contained survey pages with answer keys and seeded-defect labels stripped) and a scorer-only **oracle** (full manifests with expected outcomes, seeded-defect labels, and scoring IDs) that lives outside the tester's reachable storage and egress and is never delivered to the browser — so extraction accuracy and defect recall are measured, not leaked. One caveat to close in P0: the fixture pages inline their executable logic as readable JSON, so the eval harness must bar the tester from reading page source (or the fixture later gains a compile step); real vendor surveys keep logic server-side, so this is a fixture artifact, not a product concern. The scorer itself is self-tested against known-good, known-wrong, and partial fixtures before we trust it about the agent.

## 7. Phases and exit criteria

Gates are ratified before each phase, not adjusted after results, and are cumulative unless explicitly superseded.

- **P0 — Corpus + scoring contract.** Six surveys, clean/flawed, hidden truth; scorer self-tests pass; metrics defined (extraction accuracy, coverage, recall, precision, evidence completeness, repeatability, cost, partial behavior). No agent-quality gate yet — P0 proves the *test bed* is trustworthy.
- **P1 — Thin end-to-end slice.** Link + doc → checklist → browser execution → evidence → report, no intervention, ≥3 survey shapes × clean/flawed × 3 repeats. Gates: meets the extraction-accuracy threshold ratified in P0; 100% of items carry a status; ≥90% of reachable items exercised; ≥85% seeded-defect recall; every asserted finding evidence-linked (zero unsupported critical findings); forced loop / provider error / restart / budget-cap each still yield a usable partial report; p50 cost ≤ $20, no cap breach. Evidence, safety, telemetry, and hard budgets are *in* this phase, not deferred.
- **P2 — Audit readiness + breadth.** Full corpus + a second, materially different vendor. ≥95% reachable coverage, ≥90% recall & precision, 100% critical-defect recall, 100% evidence completeness on asserted verdicts, ≥90% verdict agreement across repeats; doc/live conflicts, unreachable proofs, redaction, retention, forced partials all validated. For standard runs meeting the phase coverage gate: p50 ≤ $20, p90 ≤ $30 (partial runs reported separately).
- **P3 — Multi-vendor hardening.** Three vendors, ≥30 representative runs; ≥98% reachable coverage, ≥95% recall/precision/repeat-agreement, 100% critical recall; p90 runtime ≤ 60 min in the standard envelope; zero hard-cap breaches; every injected termination produces a report; injection/privacy/anti-bot policies pass. Only after P3 do we claim "vendor-agnostic" broadly.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| "Comprehensive" read as "every path" → cost/expectation blowup | Decision #1 + the §3 example; coverage definition ratified before P1 |
| Pathological surveys loop the agent | State fingerprinting, repeated-state cutoffs, replan-on-stall, hard caps, honest partials |
| Checklist extraction silently incomplete → fake 100% coverage | Extraction accuracy scored separately against hidden truth (P0 corpus) |
| Prompt injection via page content | Untrusted-content posture: constrained tools, egress allowlist, no secrets in navigator context, fail-closed on sensitive actions |
| Vendor anti-bot walls | Never bypass; blocker evidence packet + finding; human-handoff policy decided later |
| Cost drift over time | Per-run telemetry paired with coverage, p50/p90 tracked per vendor; caps recalibrated on observed p90 per weighted unit |
| Nondeterminism undermines audit | Two-axis status + immutable attempt bundles + fresh-context verification + repeatability gates (≥90% agreement) |
| LLM verdicts wrong on semantics | Deterministic assertions first; strong-model review reserved for ambiguous/failed/high-risk items and final synthesis; executor never self-certifies |

---

*Drafted jointly by Claude (Fable 5) and GPT-5.6-sol from the 1 Aug team direction; the current system's health and the full-history audit that preceded this proposal are documented in the 1 Aug tri-surface check.*
