# Security & correctness hardening

The tool has been through **two adversarial audit rounds** and a deliberate, verified remediation.
The guiding rule for the second round: apply nothing without evaluating it against the live 10/10
scorecard first — which is exactly how two would-be recall regressions were caught before shipping.

---

## Round 1 — 7-dimension audit → ~20 fixes (shipped)

A whole-codebase adversarial audit across seven dimensions (security, workflow/resilience, model
legs, scoring/consensus, walker/docx, frontend, production-readiness) surfaced ~20 real defects,
each fixed and verified. Highlights:

- **Report:** a false "partial run" banner on every report; case-insensitive consensus grouping.
- **Workflow:** a Workflows 1 MiB per-step state-cap risk on `finalize`; idempotent finalize.
- **Endpoints:** findings-endpoint rate-limiting + reject-on-complete (a completed in-Worker Claude
  run can't be clobbered); bench endpoints gated off by default.
- **Scoring:** an absence-check hallucination gap (a "missing X" with a non-empty site quote could
  slip through); non-negative stat clamping.
- **Walker:** real completion detection, post-fill page signatures, scoped dropdown clicks,
  browser-death re-throw for retry; docx text-box paragraphs preserved.
- **Legs:** Claude gateway auth header; Workers-AI truncation throws instead of silently dropping
  findings; honest lower-bound cost accounting.

This is the version that scored 10/10 and was first published.

---

## Round 2 — deeper audit → deliberate re-application

A second, deeper whole-codebase audit produced **33 findings**. An initial attempt to apply the
backend subset as a *batch* regressed recall (9/10) and raised false positives, so it was **reverted
to the known-good, and each finding re-evaluated one at a time** against the live scorecard.

### Applied — genuinely missing, each verified 10/10

| Fix | What it does |
|---|---|
| **Walker completion-scoping** | Scopes the input + nav-button checks to the survey root, so a real vendor site's header/footer chrome (newsletter/search forms) no longer suppresses a genuine completion page. Confirmed by the blind test's external surveys. |
| **1 MiB step offload** | `extract-spec` / `walk-survey` offload their large payloads (full spec text, page captures) to R2 and return small summaries — a dense/many-page questionnaire's text can exceed the ~1 MiB per-step state cap and would otherwise fail the run. |
| **Awaiting-strand guard** | A keyed-but-failed in-Worker Claude leg now finalizes as a degraded "complete" instead of stranding the run permanently in "awaiting-claude" (no runner is watching on a keyed deploy). |
| **Findings body-size guard** | A pre-parse content-length cap on the findings endpoint. |

### Evaluated as false positives — the code was already correct (two would have *regressed*)

| Finding | Verdict |
|---|---|
| Grok reasoning-token cost | `completion_tokens` already includes reasoning tokens (OpenAI-compat); the "fix" would **double-count** cost. |
| MAX_ITERATIONS truncation | The known-good already flags a truncated walk so it isn't reported as cleanly complete. |
| **Absence-check "all-pages"** | **Would have broken E02.** Page-local `missing-option` is *deliberate* — a dropped option can legitimately appear on another page (e.g. a brand cut from Q1 but still listed in Q3); an all-pages check would fail to verify the real seeded error. |
| Quote normalization | Already applied (whitespace-normalized on both sides). |
| **Scorecard pass-2 tightening** | **The source of the batch's transient 9/10.** The known-good loose second pass legitimately credits a `wrong-option-label` catch the models make; tightening it dropped a real catch. |

### Accepted residuals — real but minor, documented not changed

- **resolveSecret** conflates a Secrets-Store read error with "unset" — but it degrades gracefully
  (a leg drops, the run continues), and the bad case needs all three secret reads to fail at once.
- **Anti-clobber marker** — the in-Worker-Claude anti-clobber identifies the leg by model id, which
  only misfires after a `CLAUDE_MODEL` rotation.
- **Claude `maxRetries: 1`** — a deliberate, documented tradeoff (a quick per-page retry, bounded by
  the workflow step's own retry), not overridden.
- **Known security residuals for a public deploy:** `POST /api/run` is unauthenticated (it triggers
  a browser walk + paid inference; a public production deploy needs auth or a global rate limit), and
  the SSRF blocklist is string-based, so DNS-rebinding (a public hostname resolving to a private IP)
  needs connect-time DoH IP-validation to fully close. Both are documented in the README.

---

## The lesson

The tool was already ~90% hardened after Round 1. The value of Round 2 was **not** the handful of
genuinely-missing fixes — it was catching the two regressions before they shipped, by refusing to
trust an unverified batch and measuring every change against a live benchmark. Slow and deliberate
beat fast and sweeping.
