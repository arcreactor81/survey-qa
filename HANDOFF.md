# HANDOFF — survey-qa build state

_Last updated: 2026-07-02 02:25 local. Purpose: resume point for the automated continuation._

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
