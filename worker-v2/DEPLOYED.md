# DEPLOYED — survey-qa-v2

**Status: LIVE.** First deployed 2026-08-02 by the owner's instruction ("deploy worker — push all
work on remote workers — reduce/eliminate dependency on local"). **Redeployed twice on 2026-08-07:**
first to ship the five fix branches in §10, then again to ship Pass-A wave slicing and the
pass-B purchase-ceiling fix in §11.

| | |
|---|---|
| Live URL | **https://survey-qa-v2.wellshit.co.in** |
| Worker | `survey-qa-v2` |
| Version (current) | `823be409-42b3-4c68-baf8-f1c8d59e1418` — deployed 2026-08-08, see §12 |
| Version (rollback to) | `91c3606c-cab3-48b8-82dd-5988a1f294da` — the 2026-08-07 build this replaced, see §11 |
| Version (previous rollback point) | `9aec39cd-34d2-4a30-81b1-62681635ec15` — the earlier 2026-08-07 build |
| Version (2 Aug build) | `3b6bdf57-8d1f-48e8-898b-b817500c9f67` |
| Version (first, hostname-less) | `296dac88-2d6b-47be-bdcc-88a14cf288ff` |
| Workflow | `survey-qa-v2-run` / `SurveyRunWorkflowV2` — **created by the first deploy**, 15:50:47 IST |
| Cron | `*/5 * * * *` (v2 sweeper, `v2/active/` only) |
| Access app | `survey-qa-v2` — app id `<ACCESS_APP_ID>`, AUD `<ACCESS_AUD>` |

> **SANITISED FOR COMMIT.** This file used to record real account identifiers (never secrets).
> They were replaced with `<PLACEHOLDERS>` when the file was first committed, exactly as this
> note asked. The live values are the Access application id, its AUD/`kid`, and the
> `survey-qa-runner` service-token client id; they are still on this machine in
> `worker-v2/DEPLOY-READY.md`, which is gitignored, and are readable any time from
> **Zero Trust → Access**. Do not paste them back in.
>
> Two identifiers were deliberately **left in place**: the live hostname (it is also in
> `wrangler.jsonc`'s routes, which is deployed configuration and must not be edited to make a
> document look tidy) and the owner's email (it is the git committer identity on every commit
> in this repo, so redacting it here buys nothing). Both are owner decisions to revisit, not
> oversights.

---

## 1. How the owner logs in

Open **https://survey-qa-v2.wellshit.co.in/** in a browser. Cloudflare Access intercepts
before the Worker ever sees the request and offers a **one-time PIN to
`arcreactor81@gmail.com`**, or Google. Session lasts 24h. Nothing else to install.

For scripts/runners, use the `survey-qa-runner` service token
(client id `<SERVICE_TOKEN_CLIENT_ID>.access` — sanitised; see the note at the top):

```powershell
$env:CF_ACCESS_CLIENT_ID     = "<SERVICE_TOKEN_CLIENT_ID>.access"
$env:CF_ACCESS_CLIENT_SECRET = "<from a rotate; keep out of git>"
```

> ⚠️ **The token was rotated during this deploy and the new secret was deliberately NOT
> recorded** (it was generated inside an isolated call, used for nothing, and discarded, so
> it could never be written to a transcript or a file). Nothing held the previous secret
> either — `DEPLOY-READY.md` §7 — so nothing broke. To get a usable secret:
> **Zero Trust → Access → Service Auth → Service Tokens → `survey-qa-runner` → Rotate**, and
> copy it once. The token id and both Access policies are unchanged; only the secret moved.

## 2. Verification actually performed (anonymous — no token, no cookie)

Real status codes, 2026-08-02, after the hostname was attached:

```
302  GET  https://survey-qa-v2.wellshit.co.in/api/v2/health
302  GET  https://survey-qa-v2.wellshit.co.in/
302  POST https://survey-qa-v2.wellshit.co.in/api/v2/runs     <- 302, NOT 400/405
404  GET  https://survey-qa-v2.arcreactor81.workers.dev/api/v2/health
404  GET  https://preview-survey-qa-v2.arcreactor81.workers.dev/api/v2/health
302  GET  https://survey-qa.wellshit.co.in/api/health          <- PRODUCTION, UNTOUCHED
302  GET  https://pa-policy-extractor.wellshit.co.in/          <- UNTOUCHED
```

The `POST` returning **302 rather than a 4xx** is the load-bearing check: a 400/405 would
have meant the request reached the Worker. It did not.

The redirect target proves the *correct* application is in front:

```
https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/login/survey-qa-v2.wellshit.co.in
  ?kid=<ACCESS_AUD>
```

That `kid` is the `survey-qa-v2` app's AUD. The decoded `meta` JWT carries
`auth_status: "NONE"` and `service_token_status: false`, i.e. a genuinely unauthenticated
caller. Ordering held throughout: Access was armed **before** the hostname ever resolved, so
there was no window in which the name served an unprotected Worker.

## 3. What a submission does TODAY

`POST /api/v2/runs` (multipart `docx` + `surveyUrl`, or JSON + base64) is fully implemented
and **entirely in-Worker**. **A full run was executed on the deployed Worker and it COMPLETED**
— proven live, not inferred. Run `v2r_01kz10c43q3ezy67q76mr2tpn5`, `spec/questionnaire.docx`
(10 KB), instance status `✅ Completed`. Every stage ran:

```
claim-ownership ✅  resume-durable-state ✅  phase-extracting ✅
extract-pass-a-global ✅   grok-4.3        2 863 in / 123 out   $0.003886
extract-pass-b-blocks ✅   deepseek-v4-pro 5 chunks, HTTP 200 each
source-ledger ✅  extraction-diff ✅  seal-contract-revision ✅
plan ✅  execute-batch-0 ✅  execute-batch-1 ✅   (real Browser Rendering)
verify-observations ✅  derive-verdicts ✅  assemble-record ✅
mint-judgement ✅  close-test-axis ✅  report ✅  finalize ✅
```

> Step names above are **as they were on 2 Aug** and are kept because this is a record of that
> run. `extract-pass-a-global` and `extract-pass-b-blocks` no longer exist: both single steps
> were split into `extract-pass-a-wave-N` / `extract-pass-b-wave-N` (§10.3, §11.1).

Final checkpoint:

```
contract      sealed  cr_4314d523…  39 requirements, 40 execution cases, 0 ambiguous, 0 disputed
completion    { test: "partial-blocked", report: "complete", reasonCode: "walks-blocked-by-site" }
reportAvailable  true
phases        extracting:complete | planning:complete | executing:stopped(walks-blocked-by-site)
              | verifying:complete | adjudicating:complete | reporting:complete
```

`walks-blocked-by-site` is **the honest and correct outcome for this test**, not a defect: the
run was pointed at the placeholder `https://example.com/survey`, which is not a survey. A real
survey URL exercises the same path. Both model legs went **through the AI Gateway
`firstgateway`** (200s in its logs), which is what makes cost and logging observable at all.
Artifacts landed in R2 under `v2/runs/<id>/`: `extraction/merged.json` (119 KB),
`pass-b/chunk-01..05`, `plan/`, `evidence/` (8 entries), `record.json`, `judgement.json`.

**So the pipeline runs end to end remotely. What it does not yet produce is a *final,
trustworthy* result** — and that is by design. The live run's judgement came back
`status: "diagnostic-only"`, `publishable: false`, `attested: false`,
`authority.findings: [KEY_REGISTRY_MISSING]`, verdicts `pass: 0 / not-assessed: 39`. Four
things were unset, three of them configuration — **item 4 was code and is fixed as of the
2026-08-07 deploy; items 1-3 are still open**:

1. `DEFAULT_TARGET_BUILD_ID` is unset → every run is born `targetBuildId: null`, and the
   judgement binding refuses to resolve without a coherent target identity.
2. `RECORD_SIGNING_KEY` is unset → the RunRecord is unsigned → `authority.verified = false`
   → the JudgementRecord is `publishable: false`, and an unpublishable record is never signed.
3. `JUDGEMENT_SIGNING_KEY` is unset, and `JUDGEMENT_KEY_REGISTRY` pins only the **fixture**
   key, which is inert on a deployed build. See `DEPLOY.md` §9.
4. ~~**A code gap, not config:** `workflow/stages/verify-observations.ts` has no branch that
   returns `verified`, and the execution path writes observations into the evidence catalogue
   rather than `observations.json`.~~ **FIXED (deploy 2026-08-07).** `verify-observations.ts`
   now promotes to `verified` through a closed predicate over a sealed typed expectation and a
   hash-located artifact, and writes the result to `observations.json` (`observationsKey`); a
   `project-observations` step is the projection the judging stages read. The route/boundary
   predicate binding fix in the same deploy is what closes the fabrication path here — a case
   whose screen presents two sealed ids is `insufficient`, never a pass.

The report still builds and is served; it renders one column, `final: false`, with
`operationalDiagnostics.judgement` naming exactly why. That is the intended fail-closed
posture: "no current results", never "trusted because unchecked".

## 4. What still needs a local machine

**Nothing on the run path.** No shell-out, no container, no external judge runner. The judge
runs *in the isolate* (`stages/judge-runtime.mjs` — workerd + `nodejs_compat` gives a writable
`/tmp` and synchronous Ed25519), and signing is in-Worker. The only `node:*` imports that ship
are `node:fs` (scoped to `/tmp`) and `node:crypto`; there is no `child_process`, `spawn`,
`process.env` or `import.meta.url` anywhere in `src/`.

Two genuine local dependencies remain, neither on the request path:

- **Building** needs the sibling `pipeline/` and `scorer/` trees — the Worker bundles the real
  judge engine from `../../pipeline/judge/lib/` and `../../scorer/src/lib/`. `worker-v2/` alone
  will not build.
- **Deploying** is still `npx wrangler deploy` from a machine with the repo.

`wrangler dev` **cannot** read Secrets Store (internal error in 4.106 and 4.118), so the models
are reachable only from the deployed Worker — which is now the case, and is the main thing this
deploy bought.

## 5. Operating it without the browser

`wrangler` talks to the Workflows and R2 APIs directly and **bypasses Access**, which is how the
live run above was driven:

```bash
npx wrangler workflows list
npx wrangler workflows instances describe survey-qa-v2-run <runId>
npx wrangler workflows instances terminate survey-qa-v2-run <runId>
npx wrangler tail survey-qa-v2 --format pretty
```

A Workflow instance **cannot** be started standalone: `claim-ownership` requires the checkpoint,
envelope and `v2/active/` marker that `POST /api/v2/runs` writes. Triggering the Workflow without
them fails with `claimOwnership: no checkpoint for <runId>` — a guard, not a bug.

## 6. Open risks (flagged, not fixed)

1. **Spend is uncapped at the edge.** `firstgateway` still has no `spend_limits` and
   `rate_limiting_limit: 0`. Access stops strangers, not a runaway loop. `CAP_STANDARD_MAX_USD`
   is in-Worker accounting only. `docs/access-setup.md` §7 has the ready `PUT` body.
2. **Results are non-final until §3's keys are pinned** — and §3 item 4 additionally needs code.
3. ~~**NEW — 12 orphaned `v2/active/` markers, and the cron is now live.**~~ **RESOLVED — none
   remain.** Two separate checks on 2026-08-07: **before** the redeploy, `survey-qa-v2-run` had
   **0 instances in `running`, `queued` or `paused`** (15 instances, all terminal — server-side
   status filter); **immediately after** the redeploy, an R2 listing of the `v2/active/` prefix
   returned **0 objects**. The bounded sweeper recovery described below is the likely cause, but
   only the counts above were observed. Original note, for the record: left over from local
   testing earlier on 2026-08-02 (`v2r_01kz0x…` … `v2r_01kz0ze4…`), these name runs that have
   no Workflow instance. Until the deploy there was no deployed sweeper to notice them; the
   `*/5` cron now enumerates them every five minutes. Recovery is **bounded** — `MAX_ATTEMPTS
   = 1`, `ACTIVE_PER_SWEEP = 25`, a minimum-age gate, a two-strike protocol and an 8-hour floor
   before `instance.not_found` is believed — so this self-resolves rather than looping, but
   expect up to twelve one-shot recovery attempts and then terminal states. Delete the markers
   to skip it: `npx wrangler r2 object delete survey-qa-artifacts/v2/active/<runId> --remote`.
4. **The Worker existed before this deploy.** `created_on` is `2026-08-02T09:18:22Z`, earlier
   than this pass's first deploy (10:20:xx Z) — another agent had published `survey-qa-v2`
   earlier the same day. No exposure resulted: workers.dev returned 404 and the custom hostname
   did not resolve (DNS `000`) when checked immediately before the route was attached, and the
   Access apps had been armed before any hostname existed.

## 7. Evidence run

`v2r_01kz10c43q3ezy67q76mr2tpn5` is a real completed run on the deployed Worker and its
artifacts are intentionally left in R2 under `v2/runs/v2r_01kz10c43q3ezy67q76mr2tpn5/` as
proof of the end-to-end path. Its `v2/active/` marker was cleared correctly on completion.
Delete it whenever you like — per key; there is no prefix delete.

## 8. Rollback

Per `DEPLOY-READY.md` §8, in order. Fastest safe step: comment the `routes` line out of
`wrangler.jsonc` and `npx wrangler deploy` — the hostname stops serving immediately; the Worker,
the Workflow and all R2 data survive.

## 9. Known-red tests at the time of deploy — resolved 5 Aug 2026

`npx tsc --noEmit` was **clean** and `wrangler deploy --dry-run` resolved all eight bindings.

At deploy time (2 Aug) `node tools/test.mjs` was **107/112**, with all five failures confined
to `tools/tests/d11-gates.test.mjs` — stale tests encoding the pre-extraction stub contract.
As of 5 Aug the suite was **156/156**; at the FIRST 7 Aug deploy (§10) it was **204/204, 0 failed**,
and at the SECOND (§11) **217/217, 0 failed** — both verified with an explicit exit code, not a
piped one. What changed:

- **D11 gates tests** were updated to the real pipeline: five gate-level tests, two seal-step
  tests, and two workflow-stage tests, plus one test-axis blocker test (10 total) replace the five stale stub-era tests.
- **D17 structure-model tests** were added (8 tests covering the routing-graph compiler, edge coverage, and route diff).
- Additional test files (D15 observation-ledger, D16 typed-cases) were added between deploy
  and now, all passing.

All D11 tests are now green; nothing shipped was broken by the stale tests.

## 10. Deploy 2026-08-07 — what shipped

Version `9aec39cd-34d2-4a30-81b1-62681635ec15`, replacing `3b6bdf57-8d1f-48e8-898b-b817500c9f67`.
The deployed build was from 2 Aug and predated all five of the fix branches below.

1. **Route/boundary predicate binding fix — the fabrication path is closed.** A case is bound
   only through a closed predicate over a sealed typed expectation; a reached screen that
   presents the destination *and* another sealed id is `insufficient`, not a pass, and a step
   whose own screen presents two sealed ids cannot bind the case either (`d19-route-binding`).
2. **Multi-select union restored on the live path** (`d20-multiselect-union`) — the union
   behaviour existed but was not what the deployed path actually ran.
3. **Pass-B wave split with DERIVED step timeouts** (`d21-passb-waves`). The fan-out no longer
   has to fit one Workflow step: it spreads over as many wave steps as the document needs, each
   wave bounded by `EXTRACT_WAVE_BUDGET_MS` for *issuing* only. The step timeout is derived from
   that budget plus a whole PURCHASE, so the step axe can never kill — and force a re-buy of —
   a call already paid for. (This originally read "a whole model call"; that arithmetic was
   short by a factor of `EXTRACT_MAX_ATTEMPTS` and is corrected in §11.)
   Exhausting `EXTRACT_PASS_B_MAX_WAVES` is a **named** failure
   (`extraction-pass-b-waves-exhausted`), never a `partial-*` over work that never happened.
4. **Extraction double-charge fix.** A pass-B unit's purchase count lives in its own R2 artifact,
   so waves, Workflow step retries and recovery instances share ONE budget
   (`EXTRACT_CHUNK_MAX_ISSUES`) instead of each starting fresh. A gateway trace had shown a
   single chunk id billed 21-24 times during a recovery storm.
5. **Restored test suite + baseline-aware mutation harness** — 204/204, and `tools/mutate-*.mjs`
   (plan, verifier, expander, pass-b) score mutants against a baseline rather than raw failure.

**Config:** the three knobs above (`EXTRACT_WAVE_BUDGET_MS` = 600000,
`EXTRACT_PASS_B_MAX_WAVES` = 40, `EXTRACT_CHUNK_MAX_ISSUES` = 2) were declared in
`wrangler.jsonc` **at their existing code defaults**, so declaring them changed no behaviour —
it only makes them tunable without a code edit.

**Known, accepted consequence:** an in-flight run holding an OLD-schema execution program would
throw a generic `workflow-error` rather than a named reason. Confirmed nil **before** deploying:
0 `running`/`queued`/`paused` Workflow instances. (The `v2/active/` marker count — also 0 — was
listed immediately *after* the deploy, so it corroborates rather than gates; see §6.3.)

**Post-deploy verification, anonymous, 2026-08-07:**

```
302  GET  https://survey-qa-v2.wellshit.co.in/api/v2/health   <- Access still in front
404  GET  https://survey-qa-v2.arcreactor81.workers.dev/      <- workers.dev still DISABLED
302  GET  https://survey-qa.wellshit.co.in/                   <- v1 PRODUCTION, UNTOUCHED
```

`workers_dev: false` is **declared in `wrangler.jsonc`** (line 34) precisely because a deploy
silently re-enables a route disabled out-of-band; the 404 was re-checked *after* this deploy.
v1 `survey-qa` was not redeployed — its deployment list is byte-identical before and after, still
serving `63fa957e-5e33-49e8-90c3-95be4c71e7fc` from 2026-07-18.

## 11. Deploy 2026-08-07 (second) — what shipped

Version `91c3606c-cab3-48b8-82dd-5988a1f294da`, replacing `9aec39cd-34d2-4a30-81b1-62681635ec15`
(§10), which is the rollback point. Suite **217/217, 0 failed**; `tsc --noEmit` clean; dry-run
resolved every binding.

1. **Pass-A wave slicing, with per-window persistence.** Pass A was the same cliff pass B had, on
   the Grok leg: `extract-pass-a-global` was ONE step (480 s) around a SERIAL window walk at
   `EXTRACT_PASS_A_WINDOW_CHARS` = 90 000 per window, so a ~180 KB document was already two
   serial calls at up to `LLM_TIMEOUT_MS` each (600 s > 480 s) — and nothing was persisted per
   window, so the step axe fell on windows that had already been BILLED and the retry bought
   every one again. It does not bite the small fixture, which is exactly why it was closed
   before a real client questionnaire arrives. Now: as many `extract-pass-a-wave-N` steps as the
   document needs, each window written the moment it returns and reclaimed for free on re-entry,
   cross-references riding the window artifact so a resume cannot silently shorten the diff, and
   a per-window purchase count in R2 (`EXTRACT_PASS_A_WINDOW_MAX_ISSUES`) shared across waves,
   step retries and recovery instances. Exhausting `EXTRACT_PASS_A_MAX_WAVES` is a **named**
   failure (`extraction-pass-a-waves-exhausted`) that says how many windows are still owed —
   never a `partial-*` over a document nobody finished reading.
2. **The pass-B purchase-ceiling fix — the invariant was FALSE in production.** `passBStepTimeoutMs`
   budgeted the wave budget plus ONE model call, but `llm/chat.ts` retries INSIDE a single call
   and bills every attempt, so one purchase can occupy `EXTRACT_MAX_ATTEMPTS × LLM_TIMEOUT_MS`.
   With `EXTRACT_MAX_ATTEMPTS` undeclared, the live value was chat.ts's default of **2** while the
   derived timeout budgeted for **1** — so the step axe could still fall on a call already billed
   twice, which is precisely the duplicate spend the invariant exists to delete. Both passes now
   derive the ceiling from BOTH knobs (`passACallCeilingMs` / `passBCallCeilingMs`).
3. **Outer-catch fix: an uncaught step failure still produces a report.** Commitment 5 says a
   partial run is a reportable outcome. Every *deliberate* stop honoured it; the uncaught path did
   not — `record-failure` rethrew and `reportAndFinalize` was never reached, so the one failure
   mode nobody planned for was also the one that produced no report at all.
4. **D13's re-anchored assertion.** `d13-recovery.test.mjs` asserted a replacement never
   re-extracts by checking `!step.calls.includes("extract-pass-a-global")` — a step name the wave
   work renamed. The assertion therefore passed no matter what the workflow did: a replacement
   could have re-extracted the whole document and the test would still have been green. It is now
   bound to the live `extract-pass-a-wave-` naming and can go red again. This is the
   check-that-cannot-fail class `CLAUDE.md` names as recurring in this repo, introduced by a
   rename — and the reason the stale comments in the wave suite, `run-workflow.ts`, `types/env.ts`
   and `extract/pass-a.ts` were corrected in the same change rather than left to mislead.

**Config — six knobs newly DECLARED, all at their existing code defaults**, so declaring them
changed no behaviour; it only makes the live values visible and tunable without a code edit:

| knob | value | code default at |
|---|---|---|
| `EXTRACT_PASS_A_WAVE_BUDGET_MS` | `600000` | `extract/pass-a.ts` `passAWaveBudgetMs` |
| `EXTRACT_PASS_A_MAX_WAVES` | `10` | `workflow/run-workflow.ts` |
| `EXTRACT_PASS_A_WINDOW_MAX_ISSUES` | `2` | `extract/pass-a.ts` |
| `EXTRACT_MAX_ATTEMPTS` | `2` | `llm/chat.ts` clamp, read by both passes |
| `EXTRACT_SWEEP_MAX_CALLS` | `3` | `extract/pass-b.ts` |
| `EXTRACT_SWEEP_BLOCKS_PER_CALL` | `40` | `extract/pass-b.ts` |

`EXTRACT_MAX_ATTEMPTS` is the load-bearing one: **being undeclared is what made the §11.2
invariant false in production.** Declaring it makes the live value legible in the config rather
than implicit in a transport default. `EXTRACT_PASS_A_WINDOW_MAX_ISSUES` is deliberately NOT the
same knob as `EXTRACT_CHUNK_MAX_ISSUES` — a pass-A window is a 90 KB purchase and a pass-B chunk
is a 5 KB one, so the same number is not the same money.

> **Deviation from the change request, recorded rather than silently applied:** the request
> specified `EXTRACT_PASS_A_MAX_WAVES = "20"`. The verified code default is **10**
> (`run-workflow.ts`, `Math.max(1, num(this.env.EXTRACT_PASS_A_MAX_WAVES, 10))`). Since the
> governing constraint was "values must match the code defaults so behaviour is unchanged",
> **10** was written and the discrepancy reported. Raising it to 20 is a deliberate one-line
> config change if a document ever needs it.

**Pre-flight, before deploying:** 0 `running`/`queued`/`paused` Workflow instances for
`survey-qa-v2-run` (15 total, all Completed/Errored/Terminated), and **0** objects under the
`v2/active/` R2 prefix — the latter positive-controlled against `v2/runs/` and `v2/`, which both
return objects, so the zero is a real zero and not an empty denominator.

**Post-deploy verification, anonymous, 2026-08-07:**

```
302  GET  https://survey-qa-v2.wellshit.co.in/api/v2/health   <- Access still in front
404  GET  https://survey-qa-v2.arcreactor81.workers.dev/      <- workers.dev still DISABLED
302  GET  https://survey-qa.wellshit.co.in/                   <- v1 PRODUCTION, UNTOUCHED
```

The health 302's `Location` is
`https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/login/survey-qa-v2.wellshit.co.in?kid=<ACCESS_AUD>`
— a genuine Access login redirect, not an incidental 302. `workers_dev: false` remains declared in
`wrangler.jsonc` and the 404 was re-checked *after* this deploy. v1 `survey-qa` was not touched and
still serves `63fa957e-5e33-49e8-90c3-95be4c71e7fc`, unchanged before and after.

## 12. Deploy 2026-08-08 — submission re-enabled

Version `823be409-42b3-4c68-baf8-f1c8d59e1418`, replacing `91c3606c-cab3-48b8-82dd-5988a1f294da`
(§11), which is the rollback point. Suite **217/217, 0 failed** (explicit exit code, not piped);
`tsc --noEmit` clean; dry-run resolved every binding. **No pipeline code changed** — this deploy is
the landing page, plus three stale comments.

**What was wrong.** The owner pressed submit and got *"Submitting is switched off"*. The gate was
honest when written and had gone stale. `public/app.js` held `SUBMISSION_ENABLED = false` with a
reason citing `STATE-OF-PLAY.md` §2 (5 Aug): reading the questionnaire, planning, driving the
browser and deriving verdicts were placeholders, so a run would "test nothing". That is no longer
true — §3, §10 and §11 of this file record a full run completing on the deployed Worker — and a
dead button asserting a false thing about the system is the same failure the gate existed to
prevent, pointing the other way.

**Verified before flipping it**, rather than taken from the docs:

- `grep -rn "TODO(v2)" src/` → **no matches**; every stub named in `STATE-OF-PLAY.md` §2 has a real
  implementation (`stages/extract.ts`, `plan.ts`, `execute-batch.ts`, `verify-observations.ts`,
  `derive-verdicts.ts`, `assemble-record.ts`), and `mint-judgement` / `close-test-axis` are live
  `step.do`s — so the page's "step 5: built, not connected" was also stale.
- `wrangler secret list --name survey-qa-v2` → all four signing secrets are set. **§3 items 2 and 3
  are stale**, as is `DEPLOY.md` §2/§2a/§2b's "the live Worker has NO secrets at all";
  `JUDGEMENT_KEY_REGISTRY` now pins a `trust: "production"` signer.
- **`DEFAULT_TARGET_BUILD_ID` is still unset** (`grep -c` on `wrangler.jsonc` → 0). §3 item 1 stands.
  It was deliberately NOT invented: `DEPLOY.md` §2c is explicit that no correct value exists in
  code. **This is an open owner decision** and is now stated on the page instead of being implied
  by a dead button.
- Cap enforcement is real, so the page may claim it: `pushUsage` is called from `extract.ts` and
  `execute-batch.ts`, `tickWallClock` from `run-workflow.ts`, and `capExceeded(cp.usage)` gates the
  execute loop (`run-workflow.ts:812`) with both reserves subtracted. `STATE-OF-PLAY.md` §2's
  "caps enforced against counters no step increments" is stale.

**What shipped.**

1. **`SUBMISSION_ENABLED = true`.** The kill-switch mechanism is kept, not deleted; `OFF_REASON`
   now refuses to invent a reason if someone flips it off without writing one.
2. **Both banners REPLACED, not deleted** — the instruction in the old `app.js` comment said to
   delete them, and that was wrong: a silent page implying a finished product is the same overclaim
   inverted. They now carry the two caveats that ARE still true: reports are marked non-final
   ("no current results") until a target build identity exists, and **no real survey has been walked
   end to end from inside the service** — the one completed run targeted `https://example.com/survey`
   and stopped `walks-blocked-by-site`.
3. **Step flags corrected**: 1, 2, 4, 5 → `Built`; **step 3 → `Built · not yet proven on a real
   survey`**, which is the distinction a plain "Built" would have erased. Future tense removed
   throughout ("How a run will work" → "How a run works").
4. **An accessibility bug the re-enable would have shipped.** `aria-disabled="true"` is authored in
   the markup and the enabled path only ever wrote `runBtn.disabled`, so the newly-pressable button
   would have kept announcing itself as disabled to a screen reader. `setDisabled()` is now the
   single writer of both, with all five call sites routed through it.
5. **Three stale comments corrected** (same standard as §11.4): `src/api/devrun.ts` and
   `tools/prove-judging.mjs` both said execution "is not built"; `public/styles-v2.css` described
   the banner as guarding four placeholders.

**Pre-flight:** 0 `running`/`queued`/`paused` instances for `survey-qa-v2-run`, **positive-controlled**
— the same command with `--status complete` returns a full table, so the zeros are real and not a
broken invocation. **0** objects under `v2/active/`, positive-controlled against `v2/runs/` and
`v2/` (20 objects each).

**Post-deploy verification, anonymous, 2026-08-08:**

```
302  GET  https://survey-qa-v2.wellshit.co.in/api/v2/health   <- Access still in front
302  GET  https://survey-qa-v2.wellshit.co.in/
302  POST https://survey-qa-v2.wellshit.co.in/api/v2/runs     <- 302, NOT 4xx: the now-live
                                                                 money-spending route is still
                                                                 behind Access
404  GET  https://survey-qa-v2.arcreactor81.workers.dev/api/v2/health   <- still DISABLED
302  GET  https://survey-qa.wellshit.co.in/api/health         <- v1 PRODUCTION, UNTOUCHED
```

The health 302's `Location` carries `kid=<ACCESS_AUD>` (the `survey-qa-v2` AUD) and a `meta` JWT with
`auth_status: "NONE"`, `service_token_status: false` — a genuinely unauthenticated caller. The
deployments API confirms v2 is serving `823be409…` and v1 `survey-qa` still serves
`63fa957e-5e33-49e8-90c3-95be4c71e7fc` from 2026-07-18, untouched.

> **NOT verified, and it cannot be from here: no authenticated submission was made.** The
> `survey-qa-runner` service-token secret was deliberately discarded (§1), so the first real run
> through the re-enabled button is the owner's. The page is written to stay accurate if that run
> stops early with a named reason, because that is a supported outcome — not a defect.

**Open, unchanged by this deploy:** `DEFAULT_TARGET_BUILD_ID` (§3.1, the reason reports are
non-final), and the uncapped edge spend in §6.1 — now more relevant, because the button that
starts the spending is live.
