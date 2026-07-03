# Survey QA — Automated Language Checks (PoC)

Iteration 1 of the Automated Survey Website QA initiative: verify that a vendor-programmed
survey website faithfully matches the Word questionnaire it was built from.

## How it works

```
questionnaire.docx ──► Worker parses docx (fflate, in-Worker)
                              │
survey URL ──► Browser Rendering walks every page (text + screenshot + PDF per page)
                              │
              per-page comparison, THREE independent model legs:
                ├── DeepSeek  (deepseek-v4-pro, in-Worker via AI Gateway; metered ~1¢/run)
                ├── Workers AI (gpt-oss-120b, in-Worker native binding; free/bundled)
                └── Claude    (Opus 4.8, local runner → `claude -p` on your subscription; $0)
                              │
              server-side verbatim-quote verification kills hallucinated findings
                              │
              HTML report: findings, seeded-error scorecard (recall + false positives),
              per-model token/cost comparison, page screenshots + PDFs
```

DeepSeek and Workers AI run automatically inside the Worker; Claude runs on-demand from your
machine so it bills to your flat-rate Claude subscription instead of a metered API key ($0).

The demo pair is self-contained: `spec/questionnaire.docx` (ground truth, generated from
`spec/canon.json`) and `/survey.html` (SurveyJS site with **10 deliberately seeded errors** —
typo, missing option, mislabeled option, broken piping, scale mislabel, reordered options,
wrong numbering, encoding artifact, duplicated word, missing instruction). Two questions are
error-free on purpose to measure false positives.

## Run the demo

1. `npm install` and `npx wrangler deploy` (Node 22+; on this machine use the portable node —
   see `set-secrets.ps1` header for the path).
2. `powershell -File .\set-secrets.ps1` — sets `DEEPSEEK_API_KEY` (optional; the run degrades
   gracefully to a Workers AI + Claude report without it) and optionally `ANTHROPIC_API_KEY`
   (not needed when using the subscription runner). Workers AI needs no key (native binding).
3. Open the Worker URL → landing page → "Run QA" (bundled sample docx + /survey.html), or:
   `curl -X POST https://survey-qa.<subdomain>.workers.dev/api/run -F surveyUrl=/survey.html -F useSample=true`
4. When the report shows "Claude comparison pending", run the Claude leg on your subscription:
   `node runner/claude-runner.mjs --worker-url https://survey-qa.<subdomain>.workers.dev --run <runId>`
5. Open `/reports/<runId>`.

## Layout

- `spec/canon.json` — questionnaire ground truth + seeded-error manifest (single source of truth)
- `scripts/gen-docx.mjs` — regenerates `spec/questionnaire.docx` (`npm run gen-docx`)
- `public/` — landing page + the seeded SurveyJS survey + bundled sample docx
- `src/` — Worker: router, docx parser, Browser Rendering walker, LLM compare, quote
  verification, scorecard, HTML report
- `runner/claude-runner.mjs` — local Claude leg via the `claude` CLI (subscription billing)

## Roadmap (later iterations)

2. Routing/logic verification — walker submits controlled answers, asserts the survey lands
   where the spec says (uses this same walker skeleton).
3. Calculations, allocation tables, input validation (ranges, sum-to-100).
4. Word-doc parsing of real internal questionnaires (in-house/legal constraints permitting).
