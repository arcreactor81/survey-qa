# Environment — how to actually run things

Shell examples are bash (Git Bash on Windows). Working dir is `E:/survey-qa/worker-v2` unless stated.

## Credentials — never print them

`worker-v2/.dev.vars` (gitignored) holds `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` and the signing keys.

```bash
cd E:/survey-qa/worker-v2 && set -a && . ./.dev.vars && set +a
AUTH=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
```

**Never dump full response headers** — an agent leaked a live session JWT into its transcript that way. Filter.

## Test and typecheck

```bash
node tools/test.mjs            # 621/621 at handoff
npx tsc --noEmit               # clean
node tools/mutate-runner.mjs   # baseline-aware mutation engine
```

`tools/mutate-*.mjs` are per-area mutation harnesses (option-set 20, verifier 14, fabrication-paths 11,
verifier-identity 8, plan 14, …). **Re-run the ones touching code you change.**

## Deploy

```bash
cd E:/survey-qa/worker-v2
find src public tools -newermt "-3 minutes" -type f    # MUST be empty — never deploy a moving tree
npx tsc --noEmit && node tools/test.mjs
npx wrangler deploy
```

**Then verify within 30 seconds** — the status endpoint stays silent on a crash before step 1:

```bash
npx wrangler workflows instances describe survey-qa-v2-run <RUNID> | head -12
```

A run that errors at 0 seconds with 0 steps means the deployed bundle is broken. That happened: a `.bind()` on
a JSRPC stub killed every run instantly while the test suite was 100% green.

Worker: `survey-qa-v2` · domain `survey-qa-v2.wellshit.co.in` · workflow name `survey-qa-v2-run`
(NOT `survey-qa-run`, which is v1). Deployed at handoff: **`d72990f8-26ed-4d7b-8084-e88723faed2e`**.

## Submit a run

```bash
curl -s -X POST "${AUTH[@]}" \
  -F "docx=@../test-suite/branching/s1-skip/questionnaire.docx" \
  -F "surveyUrl=https://survey-qa-target-s1-skip.arcreactor81.workers.dev/survey/" \
  "https://survey-qa-v2.wellshit.co.in/api/v2/runs"
```

Field names are **`docx`** (or `document`/`file`) and **`surveyUrl`**. Anything else 400s.

```bash
curl -s "${AUTH[@]}" ".../api/v2/runs/<RUNID>/status"    # progress + heartbeat
curl -s "${AUTH[@]}" ".../api/v2/runs/<RUNID>/record"    # the signed record — the real result
```

**Submit paired runs SEQUENTIALLY.** Concurrently, both extractions start before either seals and the pair is
judged against two different contracts — measured: the same document sealed 55 vs 42 requirements.

## Batch runner

`<scratchpad>/fleet-run.mjs` — reads the manifest, sequences pairs clean-first, scores against
`expected_clean`/`seeded_defects`, and **separates "did not reach" from "could not decide"**.

```bash
node fleet-run.mjs --group branching --concurrency 6
node fleet-run.mjs --all --dry            # print the plan, submit nothing
```

It writes `fleet-results.json` incrementally, so a killed run resumes rather than restarts. Run it **detached**
(`nohup … &`) — a foreground shell will time out mid-wave. Detached means no completion notification; poll the
log.

## Local browser driving — free, no quota

`chrome-headless-shell` is installed; **puppeteer is NOT**. Raw-CDP harness: `E:\survey-qa\bakeoff\cdp.mjs`.
`worker-v2/tools/live-walk.mjs` drives the **production** `walkPath` against a live URL locally.

**Never use the Cloudflare browser binding for exploration** — that quota is shared with real runs.

## R2 artifacts

```bash
npx wrangler r2 object get survey-qa-artifacts/v2/runs/<RUNID>/checkpoint.json --remote --pipe
npx wrangler r2 object get survey-qa-artifacts/v2/runs/<RUNID>/execution/progress.json --remote --pipe
npx wrangler r2 object get survey-qa-artifacts/v2/contracts/<CONTRACT_ID>.json --remote --pipe
```

**Read a real sealed contract before designing the frozen format.**

## Cost

~$0.025–0.045 per run (extraction dominates); $0.0000 when contract reuse fires. Full 46-target fleet ≈ $2.
Unattended spend to date ≈ $2.30. **Stop and ask before crossing single-digit dollars.**

## Git

Branch `master`. **Origin is PUBLIC — never push.** Local commits fine; restore point `f848cf3`.
`test-suite/blind/**/truth/**` and `v2-acceptance-*/` are gitignored publication hazards — check what an `add`
stages.
