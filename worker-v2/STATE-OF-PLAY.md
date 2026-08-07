# STATE OF PLAY — survey-qa v2, after integration

> ## ⚠️ SUPERSEDED, 2026-08-08. Do not quote §2 as the current state.
>
> This file is a snapshot of **integration day (5 Aug)** and is kept as that record. Its §2
> ("What is stubbed") was still being quoted on the landing page three days later, where it
> hard-disabled the submit button and told the owner a run "would test nothing". That was false
> by then, and it is the reason `DEPLOYED.md` §12 exists.
>
> **Stale here, verified elsewhere:** every stage in §2 is implemented (`grep -rn "TODO(v2)" src/`
> returns nothing); `derive-verdicts` writes the judgement bundle and `assemble-record` writes the
> RunRecord (§5.1, §5.2 done); the caps in §2's last paragraph ARE enforced against counters the
> real stages increment (§5.5 done). **Still true:** the two open owner forks in §5.8, and §7's
> two unease items.
>
> Current state lives in `DEPLOYED.md` (§3 for what a submission does, §10–§12 for what shipped).

Written after wiring the four parallel tracks together and running them against a live
local server. Nothing was deployed. The production Worker `survey-qa` (`src/**`, the root
`wrangler.jsonc`) has no modifications — `git status` on those paths is empty.

The honest summary in one paragraph: **the plumbing is real and end-to-end; the pipeline
that would put anything worth reading into it is not.** You can submit a run, watch six
phases advance through durable checkpoints, and read a report built inside the Worker. But
every extraction, planning, browser-execution and verdict-derivation step is a stub, so a
real submission correctly ends `test: failed / report: failed / empty-contract`. The
2.4 MB register you can open right now is rendered from artifacts a **previous, offline
run** produced, seeded through the Worker's own write path.

---

## 1. What genuinely works, end to end

Verified against `npx wrangler dev` on 127.0.0.1:8799. `node tools/smoke.mjs` — **45 of 45
checks passed, 0 failed.**

**Submission → Workflow → durable state → HTTP.** `POST /api/v2/runs` accepts a survey URL
plus a base64 `.docx`, mints a `v2r_`-namespaced run id, writes the envelope, the input
document, the manifest and the initial checkpoint, and starts `SurveyRunWorkflowV2`. The
Workflow ran to completion locally, advancing the checkpoint 13 revisions through all six
phases. This is a real Workflow instance with real R2 writes, not a simulation.

**The report is rendered IN the Worker by the upgraded renderer.** `src/report/render.ts`
imports `buildReportView` and `renderReportHtml` from `pipeline/report/lib/` — the same
modules the offline CLI renderer uses, not a copy — and `report.css` is bundled as a Text
module. The `report` Workflow step calls `buildAndStoreReport`, which commits the HTML and
the `ReportView` JSON to R2; `GET /report` serves those exact bytes and renders nothing
itself. 2,412,478 bytes of register out of the seeded t1-easy record. Bundle: 948 KiB /
201 KiB gzipped, well inside limits.

**Both register columns, wired.** This was the biggest gap integration found. The Worker
had no path to the judging engine's derived-verdict bundle, so it rendered a register with
**one** column — `as-run`, the agent-authored prose verdicts that the t1-easy debrief
caught writing `MATCHES_DOCUMENT` while citing the artifact that disproved it — with
`executionCases.enumerated: 0` and `certification.known: false`. There is now a durable key
for the bundle (`v2/runs/<id>/judgement.json`), the report builder reads it, and the
register renders `as-run, re-derived` with certification `known: true, blockers: 4`.

**The coverage ledger reconciles, and refuses not to.** Seven buckets summing to 171
against a sealed contract total of 171, with the two denominators reported separately (171
execution cases, 119 document requirements) and never added. A seeded checkpoint whose
buckets do not sum is rejected at the write boundary with `COVERAGE_LEDGER_INCONSISTENT` —
tested, returns 400.

**Evidence round-trips and fails closed.** 103 real artifacts stored content-addressed,
deduped, catalogued. Every one re-hashed to the digest the RunRecord declares. Fetching one
back re-verifies the bytes and returns an `x-content-sha256` the client can check
independently. EXP-049 specifically — the artifact the first run cited against itself — is
served intact at 57,116 bytes. An unknown evidence id is a 404, never a guess.

**Status and coverage serve exactly what the tracker consumes.** `run-status/2.0.0` with
six phases as a server-authored array (never inferred from enum order), two completion
axes, heartbeat and last-durable-progress as separate fields, ETag revalidating to 304.
`coverage-snapshot/1.0.0` bound to the checkpoint bytes it was projected from, with four
separately named caps. Both projections come from one atomic checkpoint and agree on
revision.

**Assets and the shareable URL.** The landing page, the watch shell, fonts and scripts all
serve from the ASSETS binding. `/runs/<runId>` is rewritten onto `watch.html` server-side,
so the shareable link survives and the first paint is not a 404.

**Namespace isolation holds.** A v1-shaped uuid handed to a v2 endpoint returns
`NOT_A_V2_RUN` without a single bucket read.

### Defects integration found and fixed

1. **Report/record disagreed about the same bytes.** `GET /record` compared only against
   `attestation.recordHash`, so a harness record carrying `payloadHash` over the identical
   scope 409'd as `ATTESTATION_INVALID` while the report header for the same run said
   "verified". Two checkers that can disagree about whether bytes are trustworthy is the
   exact defect class this project exists to delete. Now one function
   (`src/store/record-integrity.ts`), used by both, and the smoke test asserts they agree.
2. **The report's evidence audit matched nothing.** The register cites record-side ids
   (`EV-EXP-049.json`); the storage layer mints `ev_<12>` so an id can never be an R2 path.
   Every cited artifact rendered un-audited — "a citation I cannot check", which is the
   original failure in a new place. `EvidenceCatalogEntry.sourceEvidenceId` now links them.
3. **The report builder claimed "verified" from metadata.** It now actually re-fetches and
   re-hashes each blob at render time (bounded by a byte budget) and records `mismatch` /
   `missing` rather than writing an unchecked "verified".
4. **The workflow marked `report: complete` with no artifact behind it.** The report step
   now marks `failed` with a reasonCode when nothing was rendered, and `finalize` records
   what the checkpoint actually says instead of a hardcoded double success.
5. **An empty contract read as a clean pass.** With both extraction passes stubbed, the run
   sealed a zero-case contract and sailed to `test: complete` over an empty denominator.
   Now `test: failed / empty-contract` with an explicit error string.
6. **The run form threw away every server error.** `app.js` read a flat `body.code`; the
   Worker's contract is `{ error: { code, message } }`. Every rejected submission showed a
   bare "HTTP 400".

---

## 2. What is stubbed

Everything that would make a run mean something. In `src/workflow/run-workflow.ts`, each of
these is a `step.do` with the right name, the right retry policy, the right checkpoint
writes — and a `TODO(v2)` body returning empty:

| Step | State |
|---|---|
| `extract-pass-a-global` | returns `{ requirements: [] }` |
| `extract-pass-b-blocks` | returns `{ requirements: [] }` |
| `source-ledger` | returns `{ unexplainedNormativeBlocks: 0 }` — asserts a clean ledger it never computed |
| `extraction-diff` | returns `{ highRiskDisagreements: 0 }` — same shape of unearned claim |
| `plan` | produces zero case ids |
| `execute-batch-N` | acquires a browser session and completes cases without driving anything |
| `verify-observations` | sets the phase complete, verifies nothing |
| `derive-verdicts` | sets the phase complete, derives nothing, **writes no judgement bundle** |
| `assemble-record` | writes no RunRecord |

Note the two that are worse than empty: `source-ledger` and `extraction-diff` return the
values that mean "the gate passed". A future reader of `contract.extraction.gates` would
find four `true`s that nothing established. They are honest today only because the contract
they gate is empty.

**The judging engine is not called by the Worker.** `pipeline/judge/` is a Node package with
36 passing tests and a real replay bundle, but nothing in the Worker invokes it. The wiring
that now exists is the **storage contract** — `derive-verdicts` must write
`v2/runs/<id>/judgement.json` and the report builder reads it. Whether that engine runs
in-Worker (it is dependency-free ESM, so probably yes) or in a runner is an open decision.

**Also stubbed or absent:** Workers AI validators (`WORKERSAI_ENABLED: false`, free neurons
exhausted — they must degrade to `insufficient`, never block); cost/token accounting (the
four caps are enforced against usage counters that no step increments, so cap enforcement
has never actually fired); scorecard integration (the report renders without one); human
review gating (`HUMAN_REVIEW_MODE` is read and recorded, never acted on).

---

## 3. Rendered from a fixture vs produced by the pipeline

This distinction is the point of this document.

| Thing you can look at | Provenance |
|---|---|
| The 2.4 MB register report | **Fixture.** Rendered by the Worker, from a RunRecord `pipeline/runs/t1-easy/` produced offline on 1 Aug. |
| Both register columns, certification "blocked by 4" | **Fixture.** The `re-derived` column is the judging engine's replay bundle, computed offline. |
| 103 evidence blobs, hashes, EXP-049 | **Real artifacts, fixture provenance.** Genuine bytes from a genuine browser run; not produced by this Worker. |
| `status.json` / `coverage.json` | **Produced by the Worker** — projected from a durable checkpoint it wrote. The *numbers inside* are seeded. |
| Coverage totals 171 / 119 | **Derived arithmetic over fixture inputs.** From the register's own denominators. The bucket split is `171 − judge.exercised(106) − judge.not-reached(2) = pending(63)`; the derivation is printed on every smoke run and hand-entered nowhere. |
| Six phases advancing, 13 checkpoint revisions | **Produced by the pipeline** — a real Workflow instance, real R2 CAS writes. Over an empty contract. |
| `test: failed / empty-contract` on a live submit | **Produced by the pipeline**, and the truest output in the system today. |
| Tracker previews 01–15 | **Fixture.** Hand-authored states, rendered through the real `tracker.js`. |
| Tracker preview 16 | **Live capture.** The exact `/status` and `/coverage` bytes the Worker served. |
| Landing page policy block | **Produced by the Worker** — `GET /api/v2/policy`, server-decided. |

---

## 4. What needs a deploy to test

Local `wrangler dev` cannot exercise these, and none were run:

1. **Cloudflare Access in front of the hostname.** The Worker contains no auth logic by
   design; the entire security model is the Access application. Untested. `DEPLOY.md`
   sequences the route *after* the Access app for exactly this reason.
2. **Browser Rendering for real.** The keep-alive/reconnect behaviour the whole
   checkpointed batch loop is built on comes from `spikes/runtime-br`; local dev proxies
   the binding but no session was driven here.
3. **The cron sweeper.** Scheduled events do not fire in local dev (wrangler says so).
   Recovery, stale-heartbeat detection and the retention sweep are all untriggered.
   `RETENTION_MODE` defaults to `report-only`; it must stay there through the first live
   runs, because the bucket is shared with production.
4. **Real R2 against the shared bucket.** Local dev uses a Miniflare bucket. The
   `assertV2Key` guard is unit-provable, but no v2 key has ever been written to the real
   `survey-qa-artifacts`.
5. **Workflow durability under real failure** — retries, engine restarts, the recovery
   ladder, and whether a partly-consumed browser session survives a step boundary in
   production.
6. **Bundle cold-start.** 948 KiB uncompressed, mostly the report renderer. Fine for
   limits; unmeasured for startup time.

---

## 5. What to build next, ranked

1. **`derive-verdicts` must call the judging engine and write the bundle.** Everything else
   in the report already reads it, and the register's second column is the entire fix for
   the t1-easy failure. The engine is dependency-free ESM with 36 passing tests; the
   storage contract exists. This is the highest value per unit of work in the repo.
2. **`assemble-record` must write a RunRecord.** Without it the report path — fully wired,
   fully tested — has nothing to render. These two together turn every "fixture" row in §3
   into a "pipeline" row.
3. **Extraction: the two passes, the source ledger, the typed diff.** The largest piece and
   the one the merged contract is most specific about. Until it lands, every run ends
   `empty-contract`. Land the source ledger *with* the passes — a ledger that asserts
   `zeroUnexplainedNormativeBlocks: true` without computing it is worse than no gate.
4. **The executor: drive cases, capture typed observations, store evidence.** The storage
   layer (`putEvidence`, content addressing, catalog, fail-closed retrieval) is finished and
   proven with 103 real blobs. What is missing is the thing that produces them.
5. **Usage accounting.** The four caps are enforced against counters nothing increments, so
   cap enforcement has never fired even in principle. Every model and tool call must
   increment the checkpoint, or `partial-budget` is unreachable and the reserves protect
   nothing.
6. **A test for the empty/degenerate report paths.** The smoke test covers the happy path
   plus a ledger violation; it does not cover a corrupted evidence blob (the fail-closed
   409 path is implemented but unexercised), an unparseable record, or a mid-run report
   build. Corrupting a blob in the local bucket and asserting the 409 is ~20 lines.
7. **Render the tracker in a real browser.** No browser driver is installed, so `tracker.js`
   has never been executed anywhere — only its inputs verified. Fixture 16 proves the live
   payload has the right *shape*; it does not prove the page draws. Given that this
   project's one uniquely valuable finding (the survey does not render at all in an
   unmodified browser) came precisely from driving a real browser rather than trusting a
   shim, this gap should not stay open.
8. **The two open owner forks**, both currently config defaults nothing acts on:
   `HUMAN_REVIEW_MODE: high-risk-only` and `ORACLE_GAP_POLICY: neutral-blocking`.

---

## 6. Files touched during integration

New:

- `src/report/render.ts` — in-Worker bridge to the pipeline renderer
- `src/report/build.ts` — build + evidence re-hash audit + store
- `src/store/record-integrity.ts` — the single record-integrity checker
- `src/api/devseed.ts` — local-dev fixture seeding, dark unless `DEV_SEED=enabled`
- `tools/smoke.mjs` — the 45-check integration smoke test
- `PREVIEW.md`, `STATE-OF-PLAY.md`, `.gitignore`

Edited (all inside `worker-v2/`, all noted above):

- `src/index.ts` — `/runs/<id>` → watch shell rewrite
- `src/api/router.ts` — dev-seed route
- `src/api/report.ts` — shared integrity check; export manifest names the judgement bundle
- `src/api/runs.ts` — untouched
- `src/keys.ts` — `judgementKey`, `flagLanesKey`
- `src/store/evidence.ts`, `src/types/record.ts` — `sourceEvidenceId`
- `src/types/env.ts` — `DEV_SEED`
- `src/workflow/run-workflow.ts` — report step wired; empty-contract guard; honest finalize
- `wrangler.jsonc` — Text rule for `report.css`; `/runs/*` in `run_worker_first`
- `public/app.js` — error-shape fix; redirect to `/runs/<id>`
- `ui/fixtures/16-live-seeded-t1-easy.json` — generated by the smoke test

Outside `worker-v2/`: **nothing was modified.** `pipeline/`, `scorer/`, `src/`,
`test-suite/` and the root `wrangler.jsonc` are as the other tracks left them.

---

## 7. Two things to be uneasy about

**The canonicalisation is not the same code as the one that signed.**
`store/record-integrity.ts` recomputes the digest with sorted-key `JSON.stringify`, while
the harness signed an RFC 8785 (JCS) digest. On the t1-easy record they agree exactly
(`sha256:c8d9490741…` from both), and they *should* agree in general, because JCS for
JSON-safe values is defined as ES `JSON.stringify` string/number formatting with
recursively sorted keys, and `Array.prototype.sort` already orders by UTF-16 code unit.
The residual divergences are lone surrogates and non-finite numbers. So this is not luck —
but nothing anywhere asserts the equivalence, and the Worker calls the result "verified"
in a header and a report banner. Either add a differential test against
`scorer/src/lib/canonical.mjs` over adversarial inputs, or import JCS directly.

**"Verified" in the report header means integrity, not authenticity.** The Worker cannot
check the Ed25519 signature — `scorer/src/lib/attest.mjs` needs a pinned key registry off
disk. The reason string on every response says so explicitly, and the offline CLI renderer
does the real check. But a green header is a green header, and the first thing anyone will
do is read it as "signed". Worth an explicit visual distinction in the report header rather
than only in prose.
