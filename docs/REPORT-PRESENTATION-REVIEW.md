# Report presentation review (QA scout, 20 Aug 2026)

Base: `report-path-fixes` @ `ef4a65c`. Preview rendered from REAL run
`v2r_01m0dvfmm162z50msh7pj9b96a` (v86) through production's own chain:
`assembleRunRecordV2` → `projectV2ToLegacy` → `buildReportView` → `renderReportHtml`.
Real inputs read-only from R2 (contract `cr_7100eecf…` 452 requirements / 429 cases,
progress.json with all 4 walks + typed endings, checkpoint, envelope). Overlays labelled
on-page via `--fixture-note` (run was operator-terminated: no signed record exists yet).
Gate-can-fail evidence: injecting a banned term moved the jargon scan 0 → 1.

The preview HTML is deliberately NOT committed: no secrets (survey URL/resp_id absent,
0 hits), but it embeds 452 verbatim requirement statements from the confidential client
questionnaire. Re-render against a synthetic contract if a publishable specimen is wanted.
Kept git-ignored in the QA worktree: `.local-private/report-preview-v2r_01m0dvfmm….html`.

## BLOCKERS (would mislead the owner's team on the deliverable)

### B1 — raw engineering string in the customer summary (worst sentence)
Under "1 thing we could not test in the browser":
> Whole survey — DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE: Cross-window reconciliation
> compared all 110 candidate row(s) emitted by 12 primary window reader(s), using 143 exact
> candidate quote span(s) from 139 of 1131 block(s).

Produced by `pipeline/report/lib/render-summary.mjs:740` — fallback `plainify(f.summary)`;
document-level blocker has empty `itemRefs`, so the requirement branch at `:739` finds
nothing. Text originates in `assemble-record.mjs` (`crossWindowLimitationDetail`). Passes
the jargon gate (no banned words). Present on EVERY run of this contract incl. the first
completion run.
Rewrite: *Whole survey — we cannot promise we read every part of the questionnaire: our
readers quoted 139 of its 1,131 sections, and anything outside those quotes was never
looked at.*

### B2 — "did not reach the survey" after "the survey screened us out"
Same summary page, ~4 paragraphs apart:
> We took this survey 4 times. None of those reached the survey's own final page. Of the
> rest, 3 were screened out…
> Launch blocker — None recorded. This run did not reach the survey in a standard browser
> either, so that is a statement about the record and not about the survey.

`render-summary.mjs:661`, condition `s.everExercised > 0` at `:659` — claims about browser
REACH from a requirement-COVERAGE count. The run drove 43 screens. Fix the condition to
`view.completion.testing.endings.attempts > 0`.
Rewrite: *None recorded. This run did reach the survey in an ordinary browser and took it
4 times; it simply did not settle any requirement, so that is a statement about the record
and not about the survey.*

### B3 — attempt ledger renders "0 actions" for a 43-screen walk
> att_a83vrdqbjgk0 | FLOOR-01 | attempt #1 | not recorded → not recorded | 0 actions |
> 0 states | last valid state none
All 4 rows identical; Stop column empty despite every row carrying `stopReason`.
`render-html.mjs:2269-2298` (`renderAttempts`) reads the v1 shape (`a.timestamps`,
`a.actions`, `a.stateFingerprints`, `a.stop?.reason`, `a.targetItemIds`); v2 attempts carry
flat `startedAt`/`endedAt`, `stopReason`, `ending`, `evidenceIds`, `targetCaseIds`.
`projectV2ToLegacy` passes attempts through untranslated (`v2-record.mjs:536`).
`render-summary.mjs:250` shares the bug. Absent fields must render as absent:
*This record does not carry a step-by-step action list for this attempt — that is a gap in
the record, not a walk that did nothing.*

### B4 — the report never says how far we got
The number 43 appears nowhere; the page's furthest commitment is "None of those reached
the survey's own final page." `deriveAttempts` (`assemble-record.mjs:577-602`) drops both
`screensAdvanced` and `outcomeDetail`; no surface CAN state them. "How far did we get?" is
the team's first question. Carry both into the record (projection version bump per
precedent), then:
*Our deepest attempt got 43 screens into the survey before it stopped; the survey would
not accept the answer we gave, saying: "Please make sure you choose different Profile
Variation for both Best and Worst rows."*

### B5 — machine tokens contradict the plain line beneath them
> Stopping reason: No enforced limit was reached. Recorded attempt stop reasons:
> no-advance-control ×3, blocked ×1.
> Where the attempts ended: …3 were screened out by the survey itself and 1 stopped before
> reaching any ending.
`view-model.mjs:256-270` — `STOP_LABEL` has no entry for `no-advance-control` or
`blocked`; `:579` falls back to the raw token. "blocked ×1" reads as an accusation against
a healthy survey that correctly rejected an invalid answer.
Rewrite: *Stopping reason: Nothing we set as a limit was reached. Three attempts ended
because the survey screened them out, and one stopped when the survey would not accept an
answer we gave.*

## POLISH
1. "Of the rest" when none reached (`plain-language.mjs:534`) → "Instead, 3 were…".
2. "416 were never reached and 36 were never started" (`plain-language.mjs:580-584`);
   Not reached/Pending interleaved unglossed → "we never got to 416 of them, and 36 more
   were never queued up to try."
3. Bare "0 / 0" (Verdicts among exercised) → "No requirement was checked on this run, so
   there is nothing to score here yet."
4. "Report ready · Survey not ready" (`plain-language.mjs:662`) → "Report complete ·
   Survey not yet checked".
5. The jargon gate scans only summary+full (`jargon-scan.mjs:110`); the exempt audit view
   is 2.7 MB of the 2.9 MB page with 660 banned hits and zero technical zones detected.
   Worst three: "obligations remain…" (`view-model.mjs:572`), "harness-attested totals"
   (`render-html.mjs:2290`), "Targeted obligations" header (`render-html.mjs:2297`) →
   "requirements remain that were never tried", "the totals the harness recorded",
   "Requirements aimed at".
6. "No column may report completion" + em-dash for a number (`render-v2-views.mjs:44`) →
   "Mandatory checks completed · Not yet · No results have cleared our evidence check".

All 13 rewrites verified clean under the repo's own `scanText`; the originals still flag
(1 banned term each), so the check is not vacuous.

## What reads well and must not be lost
The screen-out gloss in the hero ("Being screened out means the survey deliberately ended
those attempts early, which is the survey working."), the hero's honesty about not
knowing, the "absence is not silence" framing, and the six-bucket accounting that keeps
400+ not-reached cases counted.

## Honest limits
Rendered from an operator-terminated run; B2's exact wording flips form on a verifying
run but the defect stands. `ef4a65c`'s own full gates were deferred at time of review.
