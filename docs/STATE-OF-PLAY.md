# State of play — survey-qa

**Last verified: 5 August 2026.** Tree: `E:\survey-qa`, branch `master`.

This is the one document to read before touching anything. It is the only place in the repo
that carries live counts — every other document links here rather than restating them, so
there is one number to update instead of nine to let drift.

> **Read this caveat before trusting any test number below.** The working tree is under
> concurrent edit by several workstreams (`docs/`, `worker-v2/`, `pipeline/`). Numbers I
> measured myself are marked with the command that produced them and the time. Two suites
> were red when I measured them, mid-edit; that is reported as-is rather than smoothed over,
> and both should be re-run before anyone draws a conclusion from either state.

**Vocabulary used deliberately throughout.** *designed* = documented, not coded ·
*implemented* = code exists · *locally verified* = named tests passed · *fixture-rendered* =
worked on constructed data only · *offline-demonstrated* = a real run worked outside the
Worker · *deployed* = reachable · *stubbed* = intentionally returns no substantive result ·
*end-to-end* = a submission reaches a truthful report through the supported runtime with no
manual handoff. **No component's green status is evidence for a cross-component claim.**

---

## 1. The one-paragraph answer

The v1 tool is deployed and behind a login. It is no longer the direction. The v2 system is
being built as a separate Worker: its control plane — storage, evidence integrity, the
judgement trust boundary, the requirement register, the report renderer — is implemented and
passes its tests locally, but **every stage that would put something worth reading into it
is still a stub**. A real submission to v2 today stores the document, never opens it, and
ends honestly with no contract at all. The one thing that has genuinely worked is a browser
run driven by scripts outside the Worker, against one blind survey, on 1 August. That run
proves parts of the architecture. It does not prove a working v2 service, and it does not
prove vendor independence.

---

## 2. What is deployed

| | |
|---|---|
| Worker | `survey-qa` — the v1 system (`src/**`, root `wrangler.jsonc`) |
| URL | `https://survey-qa.<YOUR_ZONE>` (Workers custom domain; the zone is redacted in this repo's docs by convention) |
| Access | Cloudflare Access, status LIVE. One-time PIN or Google; 24h session; an owners policy on a single email plus a `non_identity` service-token policy for automation |
| Old URLs | `https://survey-qa.<YOUR_SUBDOMAIN>.workers.dev` and the preview URLs are **dead** — disabled out-of-band via the Cloudflare API, observed returning HTTP 404 (error 1042) |
| Last observed | **1 Aug 2026** — `/api/health` and `/reports/` both 302'd to the Access login; the workers.dev host 404'd. Recorded in [access-setup.md](access-setup.md) §2 |
| Deployed v2? | **No.** A read-only account listing on 2 Aug 2026 shows `survey-qa`, `survey-qa-spike-runtime` and `survey-qa-testbench`. There is no `survey-qa-v2` |

I have not observed the deployed Worker over any period, so nothing here claims it is
*operational* in the strict sense — only that it was reachable-behind-a-login on the date
above. The 1 Aug observation is the most recent evidence in the repo.

**Security note, stated plainly.** The v1 Worker contains no authentication in code. The
route handler for `POST /api/run` (`src/index.ts:420-425`) applies an in-memory, IP-keyed
rate limit and nothing else. The Access application at the edge is the entire control. That
is intentional and documented — but it means the two facts below matter more than usual.

---

## 3. Known gaps and risks

1. **The root `wrangler.jsonc` can reopen the public route.** It declares neither
   `workers_dev: false` nor `routes`. `workers.dev` was disabled through the API, not in
   config, and a `wrangler deploy` from the repo root can silently re-enable it. Two extra
   Access applications covering the `workers.dev` and preview hostnames exist precisely as
   belt-and-braces for that case. Fixing the config is listed as REQUIRED in
   [access-setup.md](access-setup.md) §5 and is **not done**.
2. **`runner/claude-runner.mjs` cannot reach the deployed Worker.** It carries no Access
   credentials (no `CF-Access-Client-Id` / `-Secret` headers), so every call against the
   live host gets a 302 to the login page. The two-line patch in
   [access-setup.md](access-setup.md) §4 is **not applied**. Its example URLs still name the
   dead `workers.dev` host.
3. **v2 has never touched the real R2 bucket.** Every v2 write so far went to a Miniflare
   bucket in local dev. The bucket is shared with production behind a `v2/` key prefix and a
   compile-level binding-name guard; `RETENTION_MODE` is `report-only` (dry run) and must
   stay there through the first live runs.
4. **The v2 judging engine is not wired into the v2 Worker.** `grep judgeRun worker-v2/src`
   returns nothing. `POST /api/v2/dev/seed` — which 404s unless `DEV_SEED=enabled`, a var
   deliberately absent from `wrangler.jsonc` — is the only HTTP write path a judgement can
   enter through, and its interface cannot carry the `artifactRef` field the judge needs to
   resolve an artifact. See [../pipeline/judge/VERIFICATION-ROUND3.md](../pipeline/judge/VERIFICATION-ROUND3.md) §1a.
5. **Three v2 documents state the wrong failure mode.** `worker-v2/STATE-OF-PLAY.md` and
   `worker-v2/PREVIEW.md` say a real submission ends `empty-contract`. That branch is
   unreachable in the current source — the run stops earlier, at
   `extraction-not-implemented`, because two approval gates are hardcoded `not-evaluated`.
   The repo's own test (`worker-v2/tools/tests/d11-gates.test.mjs`) asserts the code's
   behaviour, not the docs'.
6. **Recorded test counts across `worker-v2/*.md` disagree with each other and with the
   artifacts** (45 vs 49 vs 59 vs 60 vs 61 vs 105). They were written at different moments
   and not resynced. Section 6 below is measured, not quoted.
7. **The scorer's gate coverage is breadth, not strength.** A mutation sweep measured a ~45%
   kill rate with 16 live gates individually deletable while the suite stayed green. Treat
   the scorer suite as coverage over the threat list, not as proof of enforcement.

---

## 4. Capability status

*Nothing in the "in progress" band is finished, and no row's status may be read across into
another row.*

| Capability | Status | Where |
|---|---|---|
| v1 walker + 3-model consensus report | **deployed**, retired as direction | `src/**` |
| Cloudflare Access in front of v1 | **deployed**, last observed 1 Aug 2026 | account state; [access-setup.md](access-setup.md) |
| v2 Worker shell — routing, submission, SSRF host policy, durable checkpoints, status/coverage projections, ownership fencing, cron sweeper | **implemented, locally verified** | `worker-v2/src/{index,api,workflow}` |
| Evidence storage + integrity — content-addressed blobs, write-once catalogue, re-hash on every read, fail-closed retrieval | **implemented, locally verified** | `worker-v2/src/store/evidence.ts` |
| Judgement trust boundary — Ed25519 attestation against a pinned key registry, run-binding recomputed from durable state, demote-only gates | **implemented, locally verified** | `worker-v2/src/store/judgement.ts` |
| Contract sealing + publication — content-addressed revision ids, write-once, read-back-and-re-hash before the pointer commit | **implemented, locally verified** | `worker-v2/src/store/{contract-revision,publish}.ts` |
| Requirement register + report renderer — the same modules the offline CLI renderer uses, called inside the Worker | **implemented, locally verified**; every register it has rendered so far is **fixture-rendered** | `worker-v2/src/report/`, `pipeline/report/lib/` |
| Derived-verdict judge — re-derives every verdict from signed artifacts, ignoring the executor's prose | **implemented, locally verified**, and independently audited three times | `pipeline/judge/` |
| Scorer — fail-closed validation, attestation, defect matching, metrics | **implemented, locally verified** | `scorer/` |
| Two-tier coverage planner (floor + directed exploration) | **implemented** offline; not wired into the Worker | `pipeline/planner/plan-paths.mjs` |
| Blind + branching corpora with machine-readable ground truth | **implemented** | `test-suite/blind/`, `test-suite/branching/` |
| **Document extraction (passes A and B, source ledger, typed diff)** | **implemented** — real Grok + DeepSeek passes, source ledger, diff | `worker-v2/src/extract/`, `worker-v2/src/workflow/run-workflow.ts` |
| **Planning / case generation in the Worker** | **implemented** — deterministic, zero-model, 0.3s | `worker-v2/src/extract/expand.ts`, `worker-v2/src/workflow/run-workflow.ts` |
| **Browser execution in the Worker** | **implemented, untested with real browser** — code complete, project-observations + typed-case enrichment done, verified on deployed Worker with placeholder URL | `worker-v2/src/workflow/stages/project-observations.ts`, `worker-v2/src/workflow/run-workflow.ts` |
| **Verification and verdict derivation in the Worker** | **implemented** — tri-state predicate verifier, model-free aggregation, judge runs in isolate | `worker-v2/src/workflow/stages/verify-observations.ts`, `worker-v2/src/workflow/stages/derive-verdicts.ts` |
| **RunRecord assembly in the Worker** | **implemented** — assembles signed record from derived verdicts | `worker-v2/src/workflow/run-workflow.ts` |
| **Routing-graph compiler (StructureModel)** | **implemented** — 7 tests | `worker-v2/src/structure/`, `worker-v2/tools/tests/d17-structure-model.test.mjs` |
| **Usage accounting** | **implemented** — model calls + browser sessions increment caps | `worker-v2/src/store/usage.ts` |
| Workers AI validators | **not implemented**; `WORKERSAI_ENABLED=false` | — |
| Human-review gating | **not implemented**; `HUMAN_REVIEW_MODE` is read and recorded, never acted on | — |
| Model calls in the v2 Worker | **implemented, live** — both Grok and DeepSeek pass through `firstgateway` AI Gateway, verified on deployed Worker with real billing events | `worker-v2/src/workflow/run-workflow.ts` |

### What a real submission to v2 does today

The pipeline runs end-to-end: extraction (Grok + DeepSeek) → seal (contract revision) →
plan (deterministic case generation) → execute (browser rendering) → verify (tri-state
predicate) → adjudicate (model-free aggregation) → report (HTML + JSON). Results are
**non-final** pending signing keys and `DEFAULT_TARGET_BUILD_ID` — the judgement comes back
`status: "diagnostic-only"`, `publishable: false`, with `authority.findings:
[KEY_REGISTRY_MISSING]`. See `worker-v2/DEPLOYED.md` for the live evidence run
(`v2r_01kz10c43q3ezy67q76mr2tpn5`).

---

## 5. Latest validated evidence

### The one real run — offline-demonstrated, 1 August 2026

A single browser run against **`test-suite/blind/t1-easy`**, a blind-corpus survey whose
answer key was attested unread during extraction, planning and execution.

| | |
|---|---|
| When | 1 Aug 2026, 18:47–20:01 UTC (browser walk itself 19:44:45–19:50:17 UTC) |
| Browser | Puppeteer 25.4.0, bundled headless Chromium `Chrome/151.0.7922.47`, Node v24.18.0 |
| Target | `http://127.0.0.1:8750/index.html`, a local static server |
| Where it ran | Local Node, **outside any Cloudflare Worker** — no wrangler, no Worker binding, `browserCostUsd = 0` |
| Requirements (denominator) | **119** — agreed by five independent files |
| Evidence artifacts | **103** — agreed by four independent files, all byte-hashed into the signed record |
| Attempts | **95**, across **89** distinct paths |
| Browser sessions | **84** by the run record's own `total_browser_sessions`; the judge counts **79** session artifacts. *(These are not 95 — 95 is the attempt count, and the two must not be conflated.)* |
| Viewports | Two: 1280×900 and 390×844 |
| Model calls | **7 in total, all extraction** (`@cf/openai/gpt-oss-120b`, via the Workers AI REST API from local Node). **Zero during navigation and judging** — navigation ran deterministically from `plan.json` and every verdict was a deterministic DOM assertion |

**What it found, scored against the hidden key:** 2 of 3 seeded defects reported · 3 **false
passes** (verdicts recorded as PASS citing the artifact that disproves them) · 1 penalized
false positive · 6 of the key's 7 expected-false-positive traps correctly avoided. Plus one
finding the answer key itself does not contain — `DIV-001`: in an unmodified browser the
survey does not render at all, because `survey.js` assigns to the read-only `window.history`
under strict mode. The run's own debrief says: *"Treat the current pass rate as unmeasured,
not as 94%."*

**Two disclosures that condition everything above.** (a) The site had to be modified to run
at all — one property descriptor made `window.history` writable before `survey.js` loaded;
every verdict except `DIV-001` therefore describes the survey the author *intended* to ship.
(b) **The driver script is not in this repo.** It ran from a scratch directory. The 103
artifacts are its only surviving output, so this run is attested, not reproducible from a
clean clone.

Full account: [../pipeline/runs/t1-easy/DEBRIEF.md](../pipeline/runs/t1-easy/DEBRIEF.md).

### What the derived judge did to that run

Re-deriving every verdict from the signed artifacts alone — ignoring the executor's prose —
removed all three false passes, turned the missed seeded defect into a catch cited to the
artifact that proves it, and turned the penalized false positive into a query naming the
ambiguity that blocks it. **Seeded recall 2/3 → 3/3; penalized false positives 1 → 0.** The
price is a smaller decided set (103 → 90 decided rows). An independent auditor re-resolved
all 673 emitted witnesses against the raw JSON with a from-scratch resolver: zero mismatches.
See [../pipeline/judge/VERIFICATION.md](../pipeline/judge/VERIFICATION.md).

### What crossed into the Worker

An offline-assembled signed record plus an attested judgement **does** reach the v2 Worker
and publish as current results — proven on the published HTTP bytes, 11/11 assertions. Two
caveats that keep this short of end-to-end: it required hand-bridging one field
(`artifactRef`) the Worker's only HTTP write path cannot carry — unbridged, all 103 artifacts
fail evidence authority and the page correctly says there are no current results — and the
assembler substitutes the requirement *statement* for the document *quote*, which changes 9
of 119 verdicts, publishing 3 real passes as FAILs. See
[../pipeline/judge/VERIFICATION-ROUND3.md](../pipeline/judge/VERIFICATION-ROUND3.md).

### v1 evidence (historical)

The v1 numbers — 10/10 on the seeded benchmark and 239/240 across 24 held-out surveys, blind
dry-run of **5 July 2026** — belong to the retired walker + 3-model consensus system. They
are real and reproducible from [RESULTS.md](RESULTS.md) and
[../test-suite/README.md](../test-suite/README.md), and they say nothing about v2.

---

## 6. Test suites — measured, not quoted

Run by me on **2 August 2026, ~09:00–09:15 UTC**, on the tree at HEAD `4e6e8ba` with
uncommitted work present, **while other workstreams were actively editing `pipeline/`**.

| Suite | Command | Result |
|---|---|---|
| Scorer (3 suites) | `node scorer/test/run-suites.mjs` | **PASS** — 25/25 fixtures, 285/285 checks; 40/40 calibration pins; 88/88 gate-coverage |
| v2 Worker regression | `cd worker-v2 && node tools/test.mjs` | **PASS** — 112/112 |
| Judge engine | `node --test pipeline/judge/selftest/engine.test.mjs` | **PASS** — 36/36 |
| Judge v2 contract | `node --test pipeline/judge/selftest/v2.test.mjs` | **RED at time of measurement** — 71 pass / 27 fail of 98. Round 3 recorded 93/93 earlier the same day, so this is very likely a mid-edit tree, not a regression in landed work. Re-run before concluding anything |
| Report renderer | `node --test pipeline/report/test/*.test.mjs` (8 files) | **RED at time of measurement** — 109 pass / 4 fail of 113. Same caveat |

Not run by me, needs a live local server (`npx wrangler dev --port 8799 --var DEV_SEED:enabled`):

| Suite | Command | Last recorded |
|---|---|---|
| v2 integration smoke | `cd worker-v2 && node tools/smoke.mjs` | **60/60 checks, 0 failed**, recorded in `worker-v2/.smoke/smoke-results.json` at 2026-08-02 05:59 UTC. It seeds the real t1-easy artifacts through the Worker's own write path; its own header states it does **not** prove the pipeline — nothing in it extracts, plans, drives a browser or derives a verdict |

Other entry points that exist but have no aggregate runner:
`node scorer/test/mutation/run-mutations.mjs` · `node pipeline/judge/judge.mjs pipeline/runs/t1-easy --out <dir>` ·
`node pipeline/judge/replay/run-replay.mjs` · `node test-suite/scripts/verify-cases.mjs` ·
`cd worker-v2 && npm run typecheck`.

---

## 7. Owner decisions in force

| Date | Decision | Record |
|---|---|---|
| 1 Aug 2026 | Replace programmatic *decision-making* with LLM-led reasoning, but keep deterministic *control*: a sealed coverage contract, constrained browser tooling, hard budgets, evidence on every step | [llm-led-architecture-proposal.md](llm-led-architecture-proposal.md) |
| 1 Aug 2026 | **Retired:** the deterministic walker as navigation authority, and routine 3-model consensus. N-of-3 is not abandoned — it moves to the judgment layer, where it is cheap, instead of the execution layer, where it triples the dominant cost | same, §6 |
| 1 Aug 2026 | The document defines expected intent; the live survey provides observed behaviour; any disagreement is a **finding**, never silently resolved | same, decision 2 |
| 1 Aug 2026 | **No OCR — anywhere.** Direct model ingestion covers all document paths. Re-enters only if direct ingestion measurably drops obligations on a real scanned document | [ocr-evidence-research.md](ocr-evidence-research.md) |
| 2 Aug 2026 | The durable **Requirement Register** is the system of record: the document produces a reviewed table, and runs populate its rows, so a miss is visible immediately | [structured-claim-contract-merged.md](structured-claim-contract-merged.md) §0 |
| 2 Aug 2026 | The customer-facing report is a **findings-first decision summary** over that register — a restructure, not a trim — with coverage and provenance behind progressive disclosure | [ui-report-redesign.md](ui-report-redesign.md) Amendment B |

**Open forks, both currently config defaults that nothing acts on:**
`HUMAN_REVIEW_MODE` — human review for every live run, or high-risk only? (default
`high-risk-only`) · `ORACLE_GAP_POLICY` — is a source-verified unmatched requirement blocking
or a false positive? (default `neutral-blocking`)

---

## 8. Next milestone

**P1 — the thin end-to-end slice** as defined in the architecture proposal §7: link + document
→ checklist → browser execution → evidence → report, with no intervention, across ≥3 survey
shapes × clean/flawed × 3 repeats. Its ratified gates include 100% of items carrying a status,
≥90% of reachable items exercised, ≥85% seeded-defect recall, and every asserted finding
evidence-linked.

Ranked work between here and there:

1. **`derive-verdicts` must call the judging engine and write the bundle.** Everything in the
   report path already reads it, the engine is dependency-free ESM, and the storage contract
   exists. Highest value per unit of work in the repo.
2. **`assemble-record` must write a RunRecord.** Without it the fully-wired report path has
   nothing to render. These two together turn most of the fixture-rendered rows above into
   pipeline output.
3. **Extraction: two passes, the source ledger, the typed diff.** The largest piece. Land the
   ledger *with* the passes — a gate that asserts a clean ledger it never computed is worse
   than no gate.
4. **The executor: drive cases, capture typed observations, store evidence.** The storage side
   is finished and proven against 103 real blobs; what is missing is the thing that produces
   them.
5. **Usage accounting**, so the caps protect something.
6. Then, and only then, the deploy sequence in [../worker-v2/DEPLOY.md](../worker-v2/DEPLOY.md)
   — Access application first, route second.

---

## 9. Repository map

| Path | What it is |
|---|---|
| `src/`, `public/`, `spec/`, `scripts/`, `runner/` | The **v1** system: walker, docx parser, three model legs, consensus report, the seeded demo survey and its generators. Deployed |
| `worker-v2/` | The **v2** Worker: shell, storage, evidence integrity, judgement trust boundary, report bridge. Control plane implemented, pipeline stages stubbed. Not deployed, not committed |
| `pipeline/` | The offline v2 pipeline: `planner/` (two-tier coverage planner), `judge/` (derived-verdict engine), `report/` (audit report renderer, shared verbatim with the Worker), `runs/t1-easy/` (the one real run) |
| `scorer/` | Fail-closed scoring of a run against a hidden oracle, plus its threat model and mutation harness |
| `test-suite/` | `blind/` (four tiers of blind corpus with gitignored ground truth), `branching/` (six routing/logic/calculation packages), `cases/` + `testbench/` (the v1 held-out multilingual suite) |
| `spikes/` | Disposable exploration workers; gitignored |
| `docs/` | See [docs/README.md](README.md) for the index |

---

## 10. Local development

```bash
npm install                                   # from the repo root; Node 22+

# v1 (deployed system)
npm run typecheck
npx wrangler dev

# v2 (where the work is)
cd worker-v2
npm run typecheck
node tools/test.mjs                           # no server needed; in-memory R2 with real etag semantics
npx wrangler dev --port 8799 --var DEV_SEED:enabled
node tools/smoke.mjs                          # in a second shell, against that server

# offline pipeline + scorer
node scorer/test/run-suites.mjs
node --test pipeline/judge/selftest/engine.test.mjs
```

`worker-v2` has **no `deploy` script** on purpose — deploying is an owner action, sequenced in
[../worker-v2/DEPLOY.md](../worker-v2/DEPLOY.md). A fresh clone will not deploy the v1 Worker
either until the account identifiers in `wrangler.jsonc` are replaced; see the README.

---

*When a number in this file changes, change it here. If you find yourself copying one of
these counts into another document, link to this file instead.*
