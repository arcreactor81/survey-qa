# Survey QA

Automated QA for vendor-built survey websites: verify that a programmed survey faithfully matches
the Word questionnaire it was built from — before it goes live and starts collecting corrupted data.

A single Cloudflare Worker walks the survey with a headless browser, compares every page against the
questionnaire using **three independent LLMs**, and produces an **issue-first consensus report**: each
discrepancy shown once, with which models agree (N/3), a confidence score, and the verbatim evidence
that proves it.

> Iteration 1 focuses on **language/content fidelity** (typos, missing/renamed options, broken piping,
> scale mislabels, reordered options, wrong numbering, encoding artifacts, missing instructions). Later
> iterations extend the same walker to routing/logic, calculations, and input validation — see [Roadmap](#roadmap).

## How it works

```mermaid
flowchart TD
    DOCX["questionnaire.docx"] --> PARSE["Parse into a spec:<br/>questions, options, scales, piping, programmer notes"]
    URL["survey URL"] --> WALK["Headless browser walks every page:<br/>rendered text + screenshot + PDF"]
    PARSE --> CMP
    WALK --> CMP["Three independent model legs compare each page against the spec<br/>(all in-Worker, routed through a Cloudflare AI Gateway)"]
    CMP --> DS["DeepSeek v4-pro"]
    CMP --> GK["Grok 4.3"]
    CMP --> CS["Claude Sonnet 4.6"]
    DS --> VER
    GK --> VER
    CS --> VER["Verbatim-quote verification:<br/>drop any finding not grounded in BOTH the doc and the rendered page"]
    VER --> REP["Consensus report:<br/>one card per issue — N/3 model agreement, confidence,<br/>spec-vs-site evidence, seeded-error scorecard, per-model cost + latency"]
```

## Validation at a glance

- **Benchmark:** 10/10 recall on the seeded demo — every run, all six languages.
- **Held-out generalization:** **239 / 240** seeded errors caught across **24 unseen surveys** (4 diseases × 6 languages) the tool had never encountered — at ~0.9 false positives per survey.

Full detail: [Validation & Results](docs/RESULTS.md) · [held-out testbench + scoreboard](test-suite/README.md) · [model bakeoff](docs/model-bakeoff.md) · [correctness & security hardening](docs/hardening.md).

**Why three models, and these three?** In a multi-model design, a *missed* error (false negative) is the
expensive failure — it ships to respondents and corrupts data — while a false positive is cheap (a few
seconds of review, and consensus demotes lone flags to low confidence). So the roster optimizes
**ensemble recall**: three independent families (DeepSeek / xAI / Anthropic), each catching what the
others might miss. All three score **10/10** on the seeded benchmark across six languages. The model
selection is data-driven — see [`docs/model-bakeoff.md`](docs/model-bakeoff.md) for the bakeoff record:
the Workers-AI third-pillar round, the six-language Claude-tier matrix, and the Gemini-vs-Grok run that
settled the third leg. gpt-oss and Gemini were evaluated and retired (kept inert-but-re-enablable).

The three legs run automatically inside the Worker (no local step). A zero-cost **local Claude runner**
(`runner/claude-runner.mjs`, uses the `claude` CLI on a Claude subscription) remains as a fallback for
deployments that don't set an Anthropic API key.

## The demo pair

Self-contained, no external survey needed:
- `spec/canon.json` — questionnaire ground truth **and** the seeded-error manifest (single source of truth)
- `spec/questionnaire.docx` — generated from `canon.json` (`npm run gen-docx`)
- `public/survey.html` — a SurveyJS site with **10 deliberately seeded errors**; two questions are
  error-free on purpose so false positives are measurable
- Localized pairs for `en / es / fr / de / zh / ja` (the walker handles localized Next/Complete labels)

## Setup & deploy

Requires Node 22+ and a Cloudflare account (Workers Paid — Browser Rendering + Workflows).

```bash
npm install
npx wrangler deploy
```

**Bindings** (see `wrangler.jsonc`): Browser Rendering, R2 (`ARTIFACTS`), Workflows (`RUN_WORKFLOW`),
static assets, Workers AI (kept for the optional bench endpoints), and an AI Gateway (`CF_AIG_*` vars).

**API keys** live in the account-level **Secrets Store** (never in the repo), read at runtime via
bindings — so updating a key needs no redeploy. The three active legs need:

| Secret | Leg |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek |
| `XAI_API_KEY` | Grok |
| `ANTHROPIC_API_KEY` | Claude Sonnet 4.6 (in-Worker) |

Set them with `set-secrets.ps1`, or directly:
```bash
wrangler secrets-store secret update <STORE_ID> --name XAI_API_KEY --remote
```
Each secret is seeded with `PLACEHOLDER` (treated as unset) so a leg stays **inert until its real key is
set** — the pipeline degrades gracefully to whatever legs are keyed.

### Deploy your own instance

`wrangler.jsonc` ships with the original author's Cloudflare account identifiers — they're identifiers,
not secrets, but a fresh clone won't deploy until you point them at **your** account's resources. Replace:
- **`store_id`** (×3, in `secrets_store_secrets`) → your Secrets Store id (`wrangler secrets-store store list`)
- **`CF_AIG_ACCOUNT_ID`** → your Cloudflare account id
- **`CF_AIG_GATEWAY_ID`** → your AI Gateway name (create one, or delete both `CF_AIG_*` vars to call providers directly)

`bucket_name` and the workflow/binding names are fine as-is (created on first deploy). Then seed the three
secrets to `PLACEHOLDER`, run `npx wrangler deploy`, and set the real keys.

## Run it

- **Web UI:** open the Worker URL → "Run QA" (uses the bundled sample docx + `/survey.html`).
- **API:**
  ```bash
  curl -X POST https://survey-qa.<subdomain>.workers.dev/api/run \
    -F surveyUrl=/survey.html -F useSample=true -F lang=en
  # → { "runId": "..." }
  ```
  Then open `/reports/<runId>` (auto-refreshes while processing).
- **Claude fallback** (only if no `ANTHROPIC_API_KEY` is set — the run parks at `awaiting-claude`):
  ```bash
  node runner/claude-runner.mjs --worker-url <url> --run <runId>   # $0 on your Claude subscription
  ```

## Layout

- `src/` — the Worker: router (`index.ts`), docx parser (`docx.ts`), Browser Rendering walker
  (`walker.ts`), Cloudflare Workflow orchestration (`workflow.ts`), the model legs (`llm/`),
  quote verification + scorecard (`verify.ts`), consensus HTML report (`report.ts`), SSRF guard
  (`net-guard.ts`)
- `public/` — landing page, the seeded SurveyJS survey, bundled sample docx
- `runner/claude-runner.mjs` — optional $0 Claude fallback via the `claude` CLI
- `spec/` + `scripts/gen-*.mjs` — the canonical questionnaire and its generators
- `docs/model-bakeoff.md` — the model-selection decision record

## Design notes

- **Consensus + verbatim verification** is the noise control: a finding is only high-confidence if ≥2
  models agree *and* its quotes are verified against both sources, so individual-model false positives
  are demoted rather than shown as fact.
- **Per-leg resilience:** each leg is best-effort; one leg failing (or a provider brownout) degrades to
  a partial report instead of failing the run. Only *all* enabled legs failing fails the run.
- **SSRF-guarded:** `surveyUrl` must be same-origin or a public http(s) host (private, loopback,
  link-local, NAT64/6to4 are blocked), and the walker re-validates every redirect hop / subresource
  against the same blocklist. *Known limitation:* the blocklist is string/parse-based, so a public
  domain whose DNS resolves to a private/internal address (DNS-rebinding-style) is not caught — closing
  that needs connect-time DoH resolved-IP validation, tracked for when cross-origin QA of arbitrary
  vendor URLs is enabled.
- **Bench tools** (`/api/eval-model`, `/api/health/workersai`) are rate-limited GETs kept for future
  model iteration — never part of an automatic run, and **off by default** unless
  `BENCH_ENDPOINTS_ENABLED="true"` is set (disabled in the shipped `wrangler.jsonc`).

## Roadmap

1. ✅ Language/content fidelity (this iteration).
2. Routing/logic — the walker submits controlled answers and asserts the survey lands where the spec says.
3. Calculations, allocation tables, input validation (ranges, sum-to-100).
4. Word-doc parsing of real internal questionnaires (in-house/legal constraints permitting).
