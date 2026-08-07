# Re-enabling submission — working notes

Task: the owner hit "Submitting is switched off". Verify what is now true, re-enable, rewrite
the banner accurately, deploy. These are durable notes kept as the work proceeds.

## 1. What the gate claims (the stale text)

`public/index.html` and `public/app.js` both assert:

> "Four of the six steps are placeholders" — reading the questionnaire, planning the checks,
> driving the browser, deciding what passed — "so a run would test nothing."

Six-step build flags on the page: steps 1-4 `Not built yet`, step 5 `Built, not connected`,
step 6 `Built`. `app.js` has `SUBMISSION_ENABLED = false` plus an `OFF_REASON` repeating the
same claim, and refuses submit in the handler as well as in the markup.

## 2. Verification — what is actually true (checked, not read off prose)

| Claim in the banner | Verified state | Evidence |
|---|---|---|
| Extraction is a placeholder | **FALSE — real** | `src/workflow/stages/extract.ts` (23 KB), two-provider pass A (Grok) + pass B (DeepSeek), wave-sliced |
| Planning is a placeholder | **FALSE — real** | `stages/plan.ts` (27 KB) |
| Browser execution is a placeholder | **FALSE — real** | `stages/execute-batch.ts` (23 KB) + `src/browser/*`, real Browser Rendering |
| Verdicts are a placeholder | **FALSE — real** | `stages/derive-verdicts.ts`, `verify-observations.ts` (33 KB), `assemble-record.ts` |
| Step 5 "built, not connected" | **FALSE — connected** | `mint-judgement` / `close-test-axis` are live `step.do`s in `run-workflow.ts` |

- `grep -rn "TODO(v2)" src/` → **no matches**. Every stub named in `STATE-OF-PLAY.md` §2 is gone.
- `STATE-OF-PLAY.md` (5 Aug) is the source of the banner's claim and is **superseded** by
  `DEPLOYED.md` §3/§10/§11 (7 Aug).
- `DEPLOYED.md` §3 records a **real completed run on the deployed Worker**,
  `v2r_01kz10c43q3ezy67q76mr2tpn5`: extraction through report, 39 requirements, 40 execution
  cases, both model legs billed through the AI Gateway, artifacts in R2.

## 3. Config items that gated "results are non-final"

`DEPLOYED.md` §3 lists four blockers. Re-checked all four:

1. `DEFAULT_TARGET_BUILD_ID` — **STILL UNSET.** `grep -c DEFAULT_TARGET_BUILD_ID wrangler.jsonc`
   → `0`; `src/api/runs.ts:179` therefore mints `targetBuildId: null`, and the judgement is
   refused `PRODUCER_DECLARED_UNPUBLISHABLE (unbindable: targetBuildId)`. **This is the one
   real remaining caveat and the banner must say it.**
2. `RECORD_SIGNING_KEY` — **NOW SET.** `wrangler secret list --name survey-qa-v2` returns
   `RECORD_SIGNING_KEY`, `RECORD_SIGNING_KEY_ID`, `JUDGEMENT_SIGNING_KEY`,
   `JUDGEMENT_SIGNING_KEY_ID`. Doc is stale.
3. `JUDGEMENT_KEY_REGISTRY` fixture-only — **NOW STALE.** The registry pins a
   `"trust": "production"` signer (`judgement-ed25519-c66c5185cc1a`) alongside the fixture.
4. `verify-observations` had no `verified` branch — **FIXED** in the 7 Aug deploy.

## 4. The caveat that must NOT be dropped

The one live run pointed at `https://example.com/survey`, which is not a survey, and stopped
`walks-blocked-by-site`. So: browser sessions are acquired and driven for real, but **no real
survey has been walked end to end from inside the service.** Re-enabling submission is correct
(the machinery is real); claiming a proven survey test is not. The new banner has to carry this
without re-acquiring the old overclaim in the opposite direction.

## 5. Status

- [x] Verified the gate's claim is stale
- [x] Verified signing keys / registry
- [x] Confirmed `DEFAULT_TARGET_BUILD_ID` still unset
- [x] Verified cap enforcement is REAL (advisor's catch): `pushUsage` is called from
      `stages/extract.ts` and `stages/execute-batch.ts`, `tickWallClock` from `run-workflow.ts`,
      and `capExceeded(cp.usage)` gates the execute loop at `run-workflow.ts:812` with the two
      reserves subtracted. STATE-OF-PLAY §2's "counters nothing increments" is stale, so the
      page's cap sentences did NOT need softening.
- [x] Rewrite banner + step flags
- [x] Flip `SUBMISSION_ENABLED`
- [x] Typecheck (`tsc --noEmit` exit 0) + suite (`node tools/test.mjs` → **217/217, exit 0**)
- [x] Deploy + post-deploy verification — **DONE**, version
      `823be409-42b3-4c68-baf8-f1c8d59e1418`, rollback `91c3606c-cab3-48b8-82dd-5988a1f294da`.
      Pre-flight 0 in-flight instances + 0 `v2/active/` markers, both positive-controlled.
      Anonymous post-checks: 302 GET health / 302 GET / / **302 POST /api/v2/runs** (Access still
      in front of the now-live spending route) / 404 workers.dev / v1 untouched at `63fa957e…`.
- [x] Marked the two docs that caused the staleness (`STATE-OF-PLAY.md`, `WHAT-WORKS.md`) and
      appended `DEPLOYED.md` §12.

**Not verified and not verifiable from here:** no authenticated submission was made — the
`survey-qa-runner` service-token secret was deliberately discarded (DEPLOYED.md §1), so the first
real run through the re-enabled button is the owner's.

## 6. Changes made

**`public/index.html`**
- Gate comment (was "HONESTY GATE") → "HONESTY BANNER", records why it was off, what was
  verified, and that it is replaced rather than deleted.
- Main banner rewritten: flag is now "Runs are real · they spend real money · results are not
  final"; body 1 states all six steps run; body 2 states the two live caveats.
- Step flags: 1, 2, 4, 5 → `Built`; **step 3 → `Built · not yet proven on a real survey`**
  (`build-flag--part`) with prose naming the `walks-blocked-by-site` placeholder-URL run.
  Step 5's "nothing calls it yet" corrected — `mint-judgement` is a live step.
- Future tense removed: "How a run will work" → "How a run works" (CTA + h2 + intro);
  "When it works, this will be a real test" → "This is a real test".
- Inline form banner "This form does not submit anything." → "This form submits a real run."
- Run kicker and the custom-mode tab sub no longer say "switched off in this build".
- Submit button: label `Start capped run`, still `disabled` in the MARKUP on purpose (no flash
  of a pressable money-spending button before the server's cap loads); app.js enables it.

**`public/app.js`**
- `SUBMISSION_ENABLED = true`; comment rewritten to date the change, cite the evidence, and
  record the two caveats. **The kill-switch mechanism is kept** — `OFF_REASON` now refuses to
  invent a reason if someone flips it off without writing one.
- **Bug the re-enable would have exposed:** `aria-disabled="true"` is authored in the markup and
  the enabled path only ever wrote `runBtn.disabled`, so an enabled button would keep announcing
  itself as disabled to a screen reader. Added `setDisabled()` as the single writer of both, and
  routed all five call sites through it.

**`public/styles-v2.css`** — banner comment updated (it claimed four placeholders).

**Stale comments corrected** (repo standard from DEPLOYED.md §11.4): `src/api/devrun.ts`
("IT EXISTS BECAUSE THE STAGES IN FRONT OF IT ARE NOT BUILT") and `tools/prove-judging.mjs`
("Execution is not built").

**Deliberately NOT done:** `DEFAULT_TARGET_BUILD_ID` was not set. DEPLOY.md §2c is explicit that
no correct value can be invented in code — a survey URL is not a build id. It is an owner
decision and is surfaced as one.

`ui/previews/*.html` carry a copied stale line of the same CSS comment. They are local preview
fixtures, NOT served (`wrangler.jsonc` assets directory is `public` only), so they were left
alone rather than regenerated.
