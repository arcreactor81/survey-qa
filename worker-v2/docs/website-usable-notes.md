# Making the deployed site usable end to end — working notes

Scope of this pass: the three surfaces a person actually touches — the REPORT, the SUBMIT
form, and the WATCH page. No deploy, no commit. Other agents are live in this tree
(`workflow/stages/verify-observations.ts`, `plan.ts`, `extract/**`, the judge/`run-inputs`
path); nothing here touches those.

## Baselines taken before any edit (2026-08-08)

| suite | command | before |
|---|---|---|
| `pipeline/report` | `node --test "pipeline/report/test/*.test.mjs"` | **128/128 pass** |
| `worker-v2` | `node worker-v2/tools/test.mjs` | **222/222 pass** |
| typecheck | `npx tsc --noEmit -p worker-v2/tsconfig.json` | clean |

The task brief said the worker suite was at 217/217. It is at **222** — three other agents
landed tests (`d23-payload-trust`, and additions inside `d21`/`d22`) between the brief being
written and this pass starting. 222 is the number this pass must not regress.

## 1. The report port

### What was already true, and what was not

The prior agent's note ("the compressor is INJECTED, not imported… Worker-rendered reports
are still full size") is accurate but narrower than it reads. `worker-v2/src/report/render.ts`
already imports `buildReportView` and `renderReportHtml` **verbatim** from
`pipeline/report/lib/`, so the Worker was already emitting the three-view, plain-language
page — `render-summary.mjs`, `plain-language.mjs`, `plain-text.mjs`, `evidence-block.mjs`
are all reached through that one import. What the Worker was NOT doing is supplying the
`defer` compressor, so the auditor's register table shipped inline and the artifact stayed
at full size.

Nothing had ever *proved* the plain-language claim against Worker-rendered bytes, though.
The 22 rendered views in the earlier evidence were all CLI renders. So this pass does two
things: supplies the compressor, and adds a gate that runs the existing checkers against
**bytes the Worker published**, read back through `getReport`.

### The design: build the view once, render twice

`CompressionStream` and `crypto.subtle.digest` are both async in Workers, and `deferBlock`
in `render-html.mjs` calls `defer(html, id)` **synchronously**. Three options were on the
table:

- **A. two-pass render** — pass 1 with a capture-defer that returns falsy (block stays
  inline, exactly the previous behaviour) and records `{id, markup}`; `await` gzip + sha256;
  pass 2 with a lookup-defer that returns the packed entry. Zero changes to
  `pipeline/report/lib/**`.
- **B. one render + splice** — capture, then rebuild the wrapper markup and splice it in.
  Needs a new export from `render-html.mjs` plus a third `meta` argument to `defer`, or the
  Worker grows a second copy of the wrapper markup that can drift from the renderer's.
- **C. sync `fflate.gzipSync`** — `fflate` is already a worker dependency
  (`src/extract/docx-blocks.ts`). Rejected: the sha256 the payload declares still needs
  async `crypto.subtle`, so the API change to async is unavoidable either way, and a
  hand-rolled sync sha256 is more new code than the whole port.

**A was chosen.** The register table is the expensive part of the render, but the *view* is
not: `buildReportView` runs once and both `renderReportHtml` passes read the same view
object. The renderer is pure given a view — the only non-deterministic call anywhere in
`pipeline/report/lib/` is `new Date().toISOString()` in `view-model.mjs:702`, which runs
during `buildReportView`, not during either render — so the two passes are identical by
construction and the sha256 taken over pass-1 markup describes the pass-2 payload exactly.
The doubled render cost is noise against a run that takes ten minutes.

`renderRunReport` becomes `async`. It has exactly one caller (`report/build.ts:189`), already
inside an `async` function inside a `try/catch`; the change is one `await`.

### Base64 in a Worker

`String.fromCharCode(...bytes)` blows the stack on a ~500 KB buffer. The encoder chunks at
0x8000 bytes.

### Proving it

`worker-v2/tools/prove-report-render.mjs` — standalone, deliberately **not** registered in
`tools/test.mjs` (that file is git-modified by another agent right now; adding a line to it
would be a collision for no benefit). It bundles the real `src/**` through `tools/testkit.mjs`,
seeds a run from `pipeline/runs/synthetic-demo/` (committed, present in every checkout — the
private `t1-easy` is present in this tree but must not be the substrate for a repeatable
gate), calls the real `buildAndStoreReport`, reads the HTML back through the real
`getReport` endpoint, and runs against those bytes:

- `pipeline/report/jargon-scan.mjs` — zero banned terms in customer copy
- `pipeline/report/prove-customer-copy.mjs` — zero `[object Object]`, zero raw JSON, zero
  engineering artefacts, zero mid-word cuts
- `pipeline/report/expand-deferred.mjs` — the deferred payload inflates to byte-identical
  markup and matches the sha256 the Worker declared. **This is the only check that touches
  the compression at all**; the other two strip `<script>` before scanning, so they would
  pass over a corrupt payload without noticing.
- counts reconcile: the numbers in `rendered.summary` are re-read out of the published
  ReportView JSON and the published manifest, and the register row count is re-counted from
  the inflated markup.
- the honesty asserts (§2).

It renders **two** scenarios, because one render cannot carry both claims:

- **A — the attested run.** Every section of the page is populated, so this is where size,
  copy and counts are asserted.
- **B — the DEPLOYED posture** (`targetBuildId: null`, i.e. `DEFAULT_TARGET_BUILD_ID`
  unset). This is the state **every run a person submits today** lands in, and it is the
  only render where the "not final" copy is reachable. Asserting non-final copy on scenario
  A would have been asserting that a correctly-attested page calls itself unreliable.

### Result — `node worker-v2/tools/prove-report-render.mjs` → **24/24**

| | before the port | after |
|---|---|---|
| Worker-published report | 1.06 MB (everything inline) | **0.39 MB** (63% smaller) |
| deferred block | none | `audit-register`, 729 KB of markup stored in 37 KB |
| round-trip | n/a | inflates byte-identical, sha256 matches |
| jargon in customer copy | unmeasured on Worker bytes | **0** (summary and full check) |
| `[object Object]` / raw JSON / engineering artefacts / mid-word cuts | unmeasured | **0** |
| counts | unmeasured | register rows 36 = view 36 = rows drawn 36; both denominators agree; manifest byte count = published byte count |

Both gates are also run against the **inflated** document. Scanning only the compressed
file would make "clean" a statement about the 3.7% of the artifact the scanners can reach —
they strip `<script>` first, and the audit trail now lives inside a `<script>`.

## 2. Honesty surfaces

### "Could not decide" — already right, now GATED

The Worker's page (via the shared plain-language layer) already handles this well, and the
proof tool now pins it. In the words a reader actually meets — the report deliberately does
not use the engineering word "undecidable", which is the jargon gate doing its job:

- **named** — "still unresolved", split into `Needs your decision`, `Partially checked`,
  `Could not test in the browser`, `Not completed`;
- **counted** — every bucket carries its own number
  (`Passed=7 · Problem found=1 · Needs your decision=1 · Partially checked=23 · Could not
  test in the browser=0 · Not completed=4`);
- **reconciled in the copy itself** — "7 of the 36 requirements passed… the other 29 did
  not", asserted as `7 + 29 = 36`;
- **never rounded into a pass** — the page says "**None of them is a pass.**" in as many
  words, and the gate fails if that sentence goes away;
- **explained** — each bucket says what it means ("waiting on your answers", "only partly
  checked", "never completed").

### "Diagnostic, not final" — a REAL GAP, found and closed

Scenario B failed on the first run. The non-final page said, honestly, "We cannot tell you
yet whether this survey is ready" and "No result on this run has cleared our own evidence
check" — but both of those sentences are about **this run**, and a reader will fairly hear
them as *my run was unlucky, try again*. It is not: no rerun of this deployment can produce
a different answer until a target identity is configured. That "why" existed only in the
JSON and in the auditor view.

Closed with a new, **absent-by-default** `serviceNote` (`{flag, body}`):

- `pipeline/report/lib/view-model.mjs` — one field, `options.serviceNote ?? null`.
- `pipeline/report/lib/render-summary.mjs` — rendered above the verdict when present, `""`
  when not, so every existing caller produces the bytes it produced before.
- `pipeline/report/report.css` — one new rule, `.service-note`.
- `worker-v2/src/report/build.ts` — supplies it when the run resolves **no target build
  id**, which is exactly the live configuration.

It is rendered **inside** the Summary view on purpose: the customer-copy gates only scan
the `<section class="view">` blocks, so a notice in the page's global-notices strip would
have been ungated copy on the one page whose copy is the product. It passes both gates.

`fixtureNote` was rejected as the carrier — that banner is headed "Synthetic fixture — not
a real run", which would be a false statement about a real run, and a false banner is worse
than a missing one.

The copy: *"**Diagnostic run — not a final answer.** This service has not been told which
version of the survey it is testing, so nothing here can be recorded as a settled result
for a particular build. Read this page as a diagnosis to act on and check by hand, not as a
sign-off. Rerunning will not change that until a version is configured."*

The gate asserts on a **phrase**, never a bare word — `/diagnostic/` alone would be
satisfied by the word turning up anywhere on the page, which is the kind of gate that
passes over a regression.

## 3. Submit flow — field by field

`worker-v2/tools/prove-submit-flow.mjs` — standalone, **35/35**. It does not only read the
two files side by side; it drives the REAL `submitRun` and the REAL policy handler under
the test bundle with a body assembled the way the browser assembles it.

| what app.js sends | what `runs.ts` reads | verdict |
|---|---|---|
| `surveyUrl` (string) | `body.surveyUrl`, required | matches |
| `documentBase64` (base64 of the file) | `body.documentBase64` → `base64ToBytes` | matches, byte-exact round trip |
| `documentName` | `body.documentName`, defaulted | matches |
| `profile` (`standard`/`deep`) | `body.profile`, server re-decides | matches |
| *(not sent)* `locale` | defaults to `en` | fine |
| *(not sent)* `viewports` | defaults to `["desktop","mobile"]` | fine |
| reads `body.runId` | returned | matches |
| reads `body.policy` | returned | matches |
| navigates to `/runs/<id>` | `watchUrl` **and** `Location` are both `/runs/<id>` | matches |
| branches on `res.ok` | responds **202** | 202 is inside `res.ok` |
| unwraps `{error:{code,message}}` | `api/http.ts` `fail()` emits exactly that | matches |

Also verified: all **16** `getElementById` targets in `app.js` exist in `index.html` (one
missing id is a load-time crash no static read of `app.js` catches); every field of
`GET /api/v2/policy` that `renderPolicy`/`updateSubmitState` reads is present and
`limits.maxUsd` is a real number (the submit button's label is that number, and `usd()`
renders `undefined` as "not reported" — a missing cap would ship a button reading "up to
not reported"); the multipart spelling (`docx`) is accepted and stores identical bytes; a
private/metadata target is refused as `URL_TARGET_FORBIDDEN`; `index.ts` rewrites
`/runs/<id>` onto the watch shell and `watch.js` reads the id back out of the path.

**Mismatches found: none.** The submit flow genuinely works — enabled *and* correct.

## 4. Watch view — a ten-minute run must not look hung

The watch page is in much better shape than expected and needed one change, not a rebuild.
It already has: a live elapsed clock, a six-stage rail read from `status.phases[]` (never
inferred), "Now checking: &lt;path label&gt;", a separate check-in line with an age stamp, a
bounded poll that freezes and says so after ~2 minutes of failures, 404 as its own state,
and copy that refuses to show "0 of 0".

**The gap.** During extraction — the long stage — `sealed(view)` is false, so no progress
figure is shown (correctly: the requirement total does not exist yet and would move if it
did). The rail says "Reading questionnaire · Running" and nothing else changes for minutes.
Correct, and it reads as stuck.

**The fix**, in `public/tracker.js` (+ one CSS rule): when `extracting` is active, the rail
carries a second line saying the silence is the design and where the liveness signal is —
"Reading your questionnaire is the longest step, and it is the one step with nothing to
count… No figure is shown here rather than a made-up one. The check-in line below is how
you can tell it is still working." **No duration is stated**; the server promises none, and
a number this page invented would be the same class of guess as an invented progress figure.

**Not done, and outside this pass's ownership.** The workflow writes genuinely granular
heartbeat notes (`"extract pass A wave 3 (whole-document / global rules)"`,
`"merging passes: source ledger, typed diff, floor expansion"` — `run-workflow.ts` calls
`beat()` ~20 times), and `store/checkpoint.ts#readHeartbeat` returns them, but
`projectStatus` in `src/types/contracts.ts` projects only `heartbeatAt` and **drops
`note`**. Surfacing it would turn the quiet stage into a live narration and is the single
highest-value remaining change to this page. It is a status-contract change in
`src/types/contracts.ts` + `src/api/runs.ts`, which this pass does not own.

## How to re-run everything this pass proved

```
node worker-v2/tools/prove-report-render.mjs      # 24/24  (--keep writes the HTML out)
node worker-v2/tools/prove-submit-flow.mjs        # 35/35
node worker-v2/tools/test.mjs                     # 247/247
node --test "pipeline/report/test/*.test.mjs"     # 128/128
node pipeline/report/check-contrast.mjs           # 64 pairs, all pass
npx tsc --noEmit -p worker-v2/tsconfig.json       # clean
cd worker-v2 && npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

The dry-run matters and is not redundant with the suites: everything above runs under
`tools/testkit.mjs`'s esbuild bundle, and **wrangler is the bundler that actually ships**.
It is the one toolchain that had not seen these edits — in particular the `.css` Text-module
rule the renderer depends on. It builds: **Total Upload 1898.25 KiB / gzip 447.85 KiB**, no
errors, no new warnings. Deploy-ready; not deployed (owner action, DEPLOY.md).

Neither proof tool is registered in `tools/test.mjs`. That file is being edited by another
agent in this tree right now, and both tools are standalone — adding a line to a contested
file for no functional gain is a collision bought for nothing. Register them when the tree
settles.

## Suites, before and after

| suite | before | after |
|---|---|---|
| `pipeline/report` | 128/128 | **128/128** |
| `worker-v2` | 222/222 (task brief said 217) | **247/247** |
| `tsc --noEmit` | clean | **clean** |

The worker suite moved 222 → 247 during this pass: other agents landed `d24-screen-identity`,
`d25-v2-judge-evidence` and `runtools` while it was in progress. None of the growth is this
pass's, and none of it broke.

## Files changed

**Worker (owned outright)**
- `worker-v2/src/report/render.ts` — async render, two-pass deferred-block compression,
  `serviceNote` pass-through, `deferred[]` on the result.
- `worker-v2/src/report/build.ts` — `await` the render; one resolution of `targetBuildId`
  shared by the judgement binding and the reader-facing note; supplies `serviceNote`; logs
  what was deferred.
- `worker-v2/public/tracker.js` + `worker-v2/public/styles-v2.css` — the quiet-stage line.
- `worker-v2/tools/prove-report-render.mjs`, `worker-v2/tools/prove-submit-flow.mjs` — new.
- `worker-v2/docs/website-usable-notes.md` — this file.

**Shared, backward-compatible only**
- `pipeline/report/lib/view-model.mjs` — `serviceNote: options.serviceNote ?? null`.
- `pipeline/report/lib/render-summary.mjs` — renders it when present, `""` when not.
- `pipeline/report/report.css` — one `.service-note` rule.

**Collisions: none.** `verify-observations.ts`, `plan.ts`, `src/extract/**`, the judge and
`run-inputs` path were not opened for writing. `tools/test.mjs` and `tools/testkit.mjs` are
modified in the tree by other agents and were left alone.
