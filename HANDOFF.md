# HANDOFF — survey-qa build state

## STATE AS OF 2026-07-03 (active session — most current, read this block first)
LIVE & committed (commit 071e947, deployed version 25ad91ec): Deep Teal Terminal theme (contrast-corrected,
Space Grotesk/JetBrains Mono, smooth 220ms transition), verbose model-aware pipeline stage tracker (replaced
the broken --p fill), accurate 3-way copy (DeepSeek + Workers AI gpt-oss-120b + Claude Opus 4.8), Workers AI
pillar swapped glm-4.7-flash -> gpt-oss-120b (bakeoff: consistent 9/10 vs flaky 7/10), and the 4 review-3
security/resilience HIGHS (verified: 18/18 net-guard SSRF tests, workflow build-error caught & fixed):
removed denial-of-wallet /api/eval-model; SSRF closed (same-origin surveyUrl + NAT64/6to4 IPv6 blocking);
per-leg resilience (a Workers AI brownout degrades to a 2-leg report, not a failed run); page-scaled timeouts.

THREE adversarial reviews done (findings: scratchpad/confirmed-findings.json = review-1's 58; review-3's 51
in scratchpad and its task output). review-3 highs = DONE (above). review-3 mediums/lows = IN PROGRESS.

**ACTIVELY RUNNING NOW:**
- Regression run (poll task) confirming gpt-oss-120b live score + graceful degradation.
- fix-review3-medlow (wf_9d5a4623-ff1): 5 agents on DISJOINT files — walker.ts (Opus), verify+docx+workersai
  (Opus), index+workflow+compare+net-guard+store (Opus), runner+gen-survey+gen-docx (Opus), frontend polish +
  Deep Teal chip retint on report.ts/processing.ts/index.html/survey.js (Fable).

**AFTER med/low lands:** integrate -> full tsc -> commit -> deploy (announce; no deploy while a /api/run is
active) -> regression. **THEN (user-requested FINAL GATE):** launch ONE Fable agent that CROSS-VALIDATES the
entire body of work for COHERENCE — that no fix undid another, the theme/copy/model/security changes are
mutually consistent, and the whole thing hangs together end-to-end. This runs LAST, on the final settled state.

## STATE AS OF 2026-07-02 ~15:30 (active session)
- Hackathon Access Score submission ACCEPTED → advanced to next round.
- Landing crash (syncOverlay undefined) FIXED + deployed (commit 1019ce5); dark mode on all 3 surfaces deployed.
- Adversarial review DONE: 58 confirmed findings (6 high / 24 med / 28 low) — full detail in
  scratchpad/confirmed-findings.json; parsed by scratchpad/parse-review2.mjs.
- Theme redesign: 3 directions in spec/theme-directions.md (Clinical Slate / Deep Teal Terminal /
  Editorial Refined) — awaiting user pick (recommended: Clinical Slate). NOT yet applied (would collide
  with the pipeline-ux agent editing index.html; apply after it lands + user picks).

**TWO WORKFLOWS RUNNING (integrate when done; they touch DISJOINT files):**
1. fix-pipeline-ux (wf_fada0e1a-2fb) → public/index.html: auto-open overlay on submit, make the
   estimated pipeline advance visibly (90s walk-stage dwell + live pulse), remove the "ghost line"
   connector artifact. Smoke-test validated.
2. apply-review-fixes (wf_9ba4eff2-76b) → 6 agents on disjoint backend files (verify/prompt, walker,
   index.ts, llm+compare+workflow, docx+store, runner+scripts+survey.js). Fixes the confirmed findings
   with demo-safe security defaults + preserved signatures.

**AFTER both land:** typecheck → ONE consolidated deploy (announce first; NO deploy while a /api/run is
active — DO reset kills runs, already bit the user twice) → regression: full 3-way run (Claude via
runner) to confirm still 10/10 / no walk regression → commit → then apply chosen theme across all 3
surfaces as final pass. Continuation cron 4005c671 (~17:05) is the limit-cutoff safety net.
Product fully working & deployed. **3-way comparison achieved** (run 19564527):
Claude 10/10 (subscription $0), DeepSeek 9/10 ($0.008/run), Workers AI glm-4.7-flash 7/10 ($0.006/run).
Six-language Claude scorecards all 10/10 (en/es/fr/de/zh/ja). DEEPSEEK_API_KEY set in account
Secrets Store (real value). Landing page: full dark mode + fullscreen takeover DONE & deployed
(commit 2ce9856 — fixed the agent's circular CSS vars and missing toggle click handler).

**TWO BACKGROUND WORKFLOWS RUNNING (check results, integrate):**
1. Adversarial code review (6 lenses + skeptic verify). Script:
   ...\workflows\scripts\adversarial-code-review-wf_99405c67-72e.js — triage confirmed findings,
   fix genuine bugs/security, note demo-acceptable ones. (Known suspects: unauthenticated
   POST /api/runs/:id/findings and /api/run — no auth/rate limit; arbitrary surveyUrl = SSRF surface.)
2. report.ts + processing.ts dark mode. Script:
   ...\workflows\scripts\report-processing-darkmode-wf_57d70c9e-d85.js — after it lands: typecheck,
   deploy (NO active runs), verify report renders, commit.

Continuation cron 4005c671 set for ~17:05 as limit-cutoff insurance.
DEPLOY RULE: never deploy while a /api/run workflow is active (Durable Object reset kills the run).


_Last updated: 2026-07-02 02:55 local. Purpose: resume point for the automated continuation._

## ✅ MILESTONE REACHED (02:50)
E2E demo works: run `9d63ad9c` → **Claude caught 10/10 seeded errors, all quote-verified, 1 false positive**
(the Q5 matrix title renders twice — SurveyJS artifact), $0 subscription cost, 139s.
Report: https://survey-qa.arcreactor81.workers.dev/reports/9d63ad9c
Fix that mattered: runner spawns `claude` with ANTHROPIC_*/CLAUDECODE env vars stripped (else the CLI
prefers the API key over the claude.ai login and exits 1). PDF capture per page added + deployed.

## LIMIT CUTOFF (03:00) — what survived, what to resume
Session limit hit at ~03:00 (resets 5:40am IST); all 7 in-flight agents died, BUT files written before
death were kept, validated, deployed, and committed (13cb320):
- ✅ spec/canon.{es,fr,ja,zh}.json — valid (10 q / 10 err / 10 mutations each). **canon.de.json MISSING.**
- ✅ src/report.ts redesign — typechecked + deployed.
- ❌ public/index.html landing redesign — never written (still the plain version).

**FIRST ACTIONS on wake (5:48): resume the two workflows** (completed agents are cached; only dead ones re-run):
1. Workflow({scriptPath: "C:\\Users\\arcreactor81\\.claude\\projects\\E--Claude-Hackathon\\aaeecb2b-533e-4fce-a43a-8f5f2a6db69f\\workflows\\scripts\\localize-survey-canons-wf_b63a3cbe-b62.js", resumeFromRunId: "wf_b63a3cbe-b62"})
   → but note es/fr/ja/zh canon FILES already exist on disk; if the resumed agents would redo them, it is
   harmless (they write the same files); the only truly missing one is **de**.
2. Workflow({scriptPath: "C:\\Users\\arcreactor81\\.claude\\projects\\E--Claude-Hackathon\\aaeecb2b-533e-4fce-a43a-8f5f2a6db69f\\workflows\\scripts\\frontend-upgrade-wf_4f2beab5-45f.js", resumeFromRunId: "wf_4f2beab5-45f"})
   → report-redesign already done on disk (don't let a re-run clobber it — if the resumed agent rewrites
   src/report.ts equivalently that's fine, but verify typecheck after). The landing-page agent must run.
Then continue with the MULTI-LANGUAGE INTEGRATION section below, then per-language E2E runs, commit, wake-up summary.

## MULTI-LANGUAGE INTEGRATION (next big task — user requirement)
User wants the demo to work across languages (es/fr/de/zh/ja) since non-English link testing is the weak
spot of manual QA. Steps:
1. Write `scripts/gen-survey.mjs`: reads a canon.<lang>.json, builds the CORRECT SurveyJS page model from
   `questions` (same mapping as public/survey.js: titles prefixed "S1. ", showQuestionNumbers off,
   isRequired false, values = display text, Q4 title gets "[PIPE: Q3 selection]" replaced by "{Q3}"),
   then applies the 10 `mutations` ops (replaceInTitle/replaceOption/removeOption/swapOptions/
   replaceColumn/removeInstruction) to seed the errors. Output all languages to `public/survey-models.json`
   ({es: <surveyJSON>, ...}). VALIDATE: every mutation's find/a/b/option matched something — throw if not.
2. Extend `scripts/gen-docx.mjs` to loop `spec/canon*.json` → `spec/questionnaire.<lang>.docx` +
   copy to `public/sample/questionnaire.<lang>.docx` (English keeps existing name).
3. `public/survey.js`: if location.search has lang≠en, fetch /survey-models.json and use models[lang].
4. Worker `src/index.ts` /api/run: accept `lang` field (default en); sample docx path
   `/sample/questionnaire.<lang>.docx` for non-en; scorecard manifest per lang (import all canon files
   statically, pick seededErrors by lang; store lang in the run envelope).
5. Deploy, then E2E per language: POST /api/run with lang=<code> & surveyUrl=/survey.html?lang=<code>,
   poll, then `node runner/claude-runner.mjs --worker-url https://survey-qa.arcreactor81.workers.dev --run <id>`
   for each. Record per-language scorecards; fix walker/prompt issues (CJK innerText should be fine, but
   verify E08 mojibake strings survive innerText capture).
6. Landing page: link per-language reports; commit everything; write wake-up summary.

## Environment gotchas (read first)
- **No system Node.** Portable node lives at
  `C:\Users\ARCREA~1\AppData\Local\Temp\claude\E--Claude-Hackathon\aaeecb2b-533e-4fce-a43a-8f5f2a6db69f\scratchpad\node-v22.17.0-win-x64`
  — prepend to PATH in every shell. npm needs `$env:npm_config_cache` pointed into the scratchpad
  (the machine's npm cache points at a dead G: drive).
- Project-local wrangler: `E:\survey-qa\node_modules\.bin\wrangler.cmd` (4.106.0). Logged in via OAuth (account f0cbb2076e484454e6567789b9be85d8).
- tsc: `E:\survey-qa\node_modules\.bin\tsc.cmd` — `--noEmit` must pass before deploy.

## Deployed
- Worker: **https://survey-qa.arcreactor81.workers.dev** (assets + API). R2 bucket `survey-qa-artifacts` exists.
- Secrets: **DEEPSEEK_API_KEY NOT set** (DeepSeek leg skips gracefully; user runs `set-secrets.ps1` when awake).
  ANTHROPIC_API_KEY intentionally not set — Claude leg = local runner on user's subscription (explicitly authorized).

## Current bug being fixed
`POST /api/run` used `ctx.waitUntil(processRun(...))`; production logs show
`waitUntil() tasks did not complete within the allowed time ... cancelled` — runs stick at status "processing" with 0 pages.
**Fix in progress: refactor to Cloudflare Workflows** (durable steps):
1. `wrangler.jsonc`: add `"workflows": [{"name":"survey-qa-run","binding":"RUN_WORKFLOW","class_name":"RunWorkflow"}]`
2. `src/store.ts`: shared RunEnvelope + R2 get/put helpers (extracted from index.ts)
3. `src/workflow.ts`: RunWorkflow (WorkflowEntrypoint) with steps: extract-spec (docx from R2) → walk-survey (screenshots to R2 inside the step; returns captures) → deepseek-compare (if key) → claude-compare (if key) → finalize (verify + scorecard + putRun status awaiting-claude/complete). Fatal errors → putRun status failed.
4. `src/index.ts`: handleCreateRun stores the docx to R2 (`runs/{id}/questionnaire.docx`) and calls `env.RUN_WORKFLOW.create({id: runId, params})`; must `export { RunWorkflow }`.
5. `src/types.ts`: Env gains `RUN_WORKFLOW: Workflow`.

## Remaining steps after the refactor
1. Typecheck → `wrangler deploy`.
2. E2E: `curl.exe -s -X POST https://survey-qa.arcreactor81.workers.dev/api/run -F "surveyUrl=/survey.html" -F "useSample=true"` → poll `/api/runs/<id>` until status `awaiting-claude` (pages should be ~6 with navOk).
3. Claude leg on subscription: `node runner/claude-runner.mjs --worker-url https://survey-qa.arcreactor81.workers.dev --run <id>` (spawns `claude -p`; authorized by user).
4. Check `/reports/<id>`: scorecard vs the 10 seeded errors (manifest in spec/canon.json), false positives on S2/Q3 should be ~0. Iterate on prompt.ts / walker.ts / verify.ts if recall is poor.
5. `git add -A; git commit` in E:\survey-qa (repo initialized, no commits yet).
6. Update this file + write a wake-up summary for the user.

## Key design decisions (do not undo)
- Claude leg = local runner (`runner/claude-runner.mjs`) on the user's Claude subscription; in-Worker Anthropic path only if ANTHROPIC_API_KEY appears.
- 3rd pillar (future): Workers AI (PoC) → Groq gpt-oss-120b or Gemini 3.1 Flash-Lite at lock-in (research done, results in session).
- `spec/canon.json` is the single source of truth: questionnaire + 10 seeded errors (E01–E10); the docx (`spec/questionnaire.docx`, also bundled at `public/sample/`) is ground truth; the site (`public/survey.js`) carries the errors.
