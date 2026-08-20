# The live-link iteration loop — runbook for any session

This document lets a fresh Claude Code session (or a human) continue the fix-and-rerun loop
against the team's real survey link without re-learning anything. It records the standing
rules, the exact commands, the current state, and every trap already paid for.

Written 19 Aug 2026, after the v84 deploy. Update the STATE section whenever you ship.

---

## Standing rules (owner instructions, binding)

1. **Never edit the survey link.** Byte-for-byte, always:
   `https://survey.us.confirmit.com/wix/p463787269998.aspx?cn=1033&test=1&jump=2&resp_id=test4`
   The backend handles resp_id. Do not touch `jump=`, do not add parameters.
2. **North star (CLAUDE.md):** every fix must be a CLASS fix that would work on a
   questionnaire and survey nobody here has seen. No survey-specific logic in the core.
   Conventions used must be stated in code, validated against sealed data, and degrade to a
   named limitation — never a guess.
3. **Money:** extraction reruns are FREE (cross-run unit cache) as long as you do not touch
   models, rates, prompts, or parser versions (`EXTRACTION_POLICY_KEYS`). Any change there
   invalidates the cache and the next run buys everything at full price — flag it and get an
   owner go-ahead first. DeepSeek peak pricing 06:30–09:30 & 11:30–15:30 IST: never launch
   anything that BUYS extraction in those windows. Walks cost ~$0 marginal.
4. **Report only from per-walk evidence.** Never say a fix "works" from the fix itself; say
   what the run's own receipts show. Distinguish "the fix's logic is verified by gates"
   from "the wall fell on the live site" — only a run proves the second.
5. **Blind corpus** `test-suite/blind/**`: never read answer keys.

## Current state (as of v96, 21 Aug 2026)

- Prod worker: `survey-qa-v2.wellshit.co.in`, pending v96 deploy.
  Suite green; tsc clean.
- Sealed contract for this survey: `cr_7100eecf32196b4b156f3cf96f88087ed162e8eb` — typed
  route destinations (expander 1.11.0). Re-derives free every run via unit adoption.
- Walk record: **81 screens (END OF SURVEY REACHED)** on v90-relaunch run
  `v2r_01m0f1zccejfmq8fd02r7xq8kv`. Completion page: "End of survey / End of test link."
- **v93 reverted D65 (composite binding) and D58 (binding retry).**
  - D65 was mis-binding decisions to wrong screens on surveys with repeated question shapes.
    0 binding refusals was WORSE than 62 refusals — the navigator defaults correctly handle
    unbound screens. D65 eliminated refusals by confidently binding to the wrong screen.
  - v93 walk reached 82 screens (END). v93b batch 1 stuck for 5 hours (zombie browser).
- **v94 ships phase-timeline fix** — monitoring page now shows phase timing strip, depth
  indicators, and walk timeline. Backend timing fields (startedAt/endedAt) were already wired.
- **v95 ships hard batch abort timer** — defense against zombie browser sessions. Timer calls
  `browser.close()` after `batchMaxMs + 2 min`. But the timer DOES NOT FIRE when Puppeteer's
  WebSocket is in a half-alive state (v93b, v94, v95: 5+ hours stuck each).
- **v96 ships reduced-timeout defense** — the framework step timeout DID fire at shorter
  durations (v53-v63 died at exactly ~67:01). The fix reduces all execution budgets:
  - `EXEC_PER_CASE_TIMEOUT_MS`: 30 min → 15 min (deep walk ~9 min, 67% headroom)
  - `EXEC_BATCH_MAX_MS`: 65 min → 18 min (1 walk/batch via residual guard)
  - `BATCH_POLICY.timeout`: 80 min → 22 min
  - `BATCH_POLICY.retries`: 1 → 3 (4 total attempts per batch step)
  - Worst-case stuck: 22 min × 4 attempts = 88 min/batch, not 5+ hours
- Wall history (all fixed, all general-class): consent race (2), S40 label-registration (7),
  screener steering lottery (S10), S150 input mask (48), doorstep plumbing (59), B10
  allocation grid (68: keyboard-only → staged validation → specify-pairing), C20 dwell gate
  (42: hidden forward control → adaptive patience), best/worst distinct-column (43),
  D10 oscillation (54: monotonic demand accumulation), D-section invisible advance (54:
  prose-progress signal), dwell gate second shape (26%: silent-refusal re-press), completion
  lexicon (81: optional article).
- **Open reliability issue (MITIGATED by v96):** browser sessions can zombie (Puppeteer
  WebSocket keeps alive without completing CDP calls). The reduced step timeout (22 min)
  bounds the damage; the hard abort timer is retained as a secondary defense.
- Run about to launch: v96 fresh run.

## The loop

Classify the newest wall from run evidence → fix the CLASS in `worker-v2/` → gates → commit
→ deploy → launch → watch → repeat. One iteration ≈ 45 min build + ~35 min walk-to-wall.

### 1. Gates (all from `E:\survey-qa\worker-v2`)

```sh
# Typecheck — capture the REAL exit code (never pipe tsc through tail):
npx tsc --noEmit > ../.local-private/tsc.log 2>&1; echo "TSC_EXIT:$?"

# Full suite (test names are the selector, not file names):
node tools/test.mjs                     # everything (~1514 tests)
node tools/test.mjs "substring"         # tests whose suite/name contains substring

# Mutation campaigns relevant to walker/plan work:
node tools/mutate-w4-select.mjs         # driver fills/selects/recovery (39 mutants)
node tools/mutate-route-labels.mjs      # route typing + owner joins (12)
node tools/mutate-reading-base.mjs      # document-reading progress guard (3)
```

A change is NOT done until: tsc exit 0, full suite green, and the campaigns that cover the
touched files kill 100% with self-checks passing. New guards ship with NEW mutants proving
the guard can fail. If you add a campaign FILE, register it in `DEPLOY.md`
(`$MutationHarnesses`) and bump the census count in
`tools/tests/mutation-execution-contract.test.mjs` (test name includes the count).

### 2. Ship

```sh
cd /e/survey-qa && git add worker-v2 && git commit -m "fix(v2): <class, not instance>"
cd worker-v2
node /e/survey-qa/node_modules/wrangler/wrangler-dist/cli.js versions upload
# Copy the printed Version ID EXPLICITLY (never grab one from `versions list`):
node /e/survey-qa/node_modules/wrangler/wrangler-dist/cli.js versions deploy <VERSION-ID>@100% --yes
# CONFIRM the SUCCESS line BEFORE launching a run.
```

### 3. Launch a run

If a previous run is still executing, terminate it first, then **wait ~2 minutes** (its
browser session lingers and poisons the next batch — measured: "detached Frame" +
"Connection closed" walks):

```sh
node /e/survey-qa/node_modules/wrangler/wrangler-dist/cli.js workflows instances terminate survey-qa-v2-run <runId>
sleep 120
```

Launch (secrets in `worker-v2/.dev.vars`; document + sha are pinned):

```sh
mkdir -p /e/survey-qa/.local-private/vNN-canary-out
node tools/live-canary.mjs --execute \
  --base-url https://survey-qa-v2.wellshit.co.in \
  --env-file E:/survey-qa/worker-v2/.dev.vars \
  --docx E:/survey-qa/.local-private/team-reference-63a45b98/questionnaire.docx \
  --expected-document-sha256 7a771751f0834bde6bde3c1ecc1e8e9cbd8f09afdc517d783099cc43c82b1a27 \
  --survey-url "https://survey.us.confirmit.com/wix/p463787269998.aspx?cn=1033&test=1&jump=2&resp_id=test4" \
  --output-dir E:/survey-qa/.local-private/vNN-canary-out > /e/survey-qa/.local-private/vNN-canary.log 2>&1 &
```

The run id lands in `vNN-canary-out/submission.json` (`.runId`).

### 4. Watch

Poll every ~2 min from `E:\survey-qa` (no Access token needed for R2 reads):

```sh
node node_modules/wrangler/wrangler-dist/cli.js r2 object get \
  "survey-qa-artifacts/v2/runs/<runId>/checkpoint.json" --file .local-private/ckpt.json --remote
node node_modules/wrangler/wrangler-dist/cli.js r2 object get \
  "survey-qa-artifacts/v2/runs/<runId>/execution/progress.json" --file .local-private/progress.json --remote
```

`checkpoint.json`: `.phase`, `.completion` (terminal when `completion.test` is not
"running"). `progress.json`: `.walks[]` with `screensAdvanced`, `outcome`, `ending.kind`,
`outcomeDetail`, `pivot`, `observationEvidenceId`. A template script:
`.local-private/v84-watch.sh` (change-only output, exits on terminal).

Reading a run:
- 2-screen walks ending `screened-out` on paths named `FLOOR-01--fi_…` are DELIBERATE
  termination probes — success, not failure.
- The deep walk (`FLOOR-01`, no suffix, or exploration paths) is the one that measures the
  wall. `maxScreens` stuck at N across attempts = the wall is screen N.
- Run-level `reasonCode` "step-timeout" / "instance-stalled" after walks stop advancing is
  the expected end of a walled run; the next fix goes out and you relaunch.

### 5. Diagnose a wall (the full receipts)

```sh
# progress.json -> the walk's observationEvidenceId (ev_...):
node node_modules/wrangler/wrangler-dist/cli.js r2 object get \
  "survey-qa-artifacts/v2/runs/<runId>/evidence/<ev_id>.json" --file .local-private/evcat.json --remote
# evcat.json .contentHash (sha256) -> the full observation (sharded by first two byte pairs):
node node_modules/wrangler/wrangler-dist/cli.js r2 object get \
  "survey-qa-artifacts/v2/evidence/sha256/<sha[0:2]>/<sha[2:4]>/<sha>" --file .local-private/obs.json --remote
```

`obs.json` has every step: `screenBefore.visibleText` (what the page said),
`validationMessages` (what the site rejected), `actions[]` (every click/fill with its
mechanism and readback), `blockedReason`, and the recovery rounds. The plan:
`v2/runs/<runId>/plan/<planRevisionId>.json` (survival hints under `survival_hints`).
The sealed contract: `v2/contracts/<cr_...>.json`.

## Lessons already paid for (do not relearn)

- **A control's readback is not the platform's registration.** Confirmit widgets keep
  el.value / checked while the submitted state listens only to real key events (B10) or
  label handlers (S40). The driver now rotates mechanisms under a standing validation:
  set → keyboard for text (bounded 3 recovery rounds re-deriving from the NEWEST
  validation), element-click → label-click for choices. Suspect this class first whenever
  "valid answer, site still complains".
- **Validation messages arrive in stages.** The first rejection can be generic; the real
  demand (numeric, sum, pairing) may only appear after a submit. Never derive from stale
  messages.
- **Specify-style text cells** (label matches /specify/i) are never numeric targets — clear
  them instead (v84).
- **Unbound route rows never steer positively**; typed rows join their owning question via
  option facts, then via validated section-title prefix. Ambiguity → refuse.
- **tsc through a pipe lies** — `| tail` reports tail's exit. Always redirect + `echo $?`.
- **Mutant find-strings break silently when source moves.** Every campaign has self-checks
  (no-op run + anchors); NO-RUN or SURVIVED after a refactor usually means your anchor
  drifted or became a substring of new code — retarget, rerun.
- **assertThrows is async** — un-awaited it passes no matter what. The campaigns exist to
  catch exactly this; run them.
- **Heredocs mangle regex backslashes in .mjs** — write test files via python or the Write
  tool; parse with indexOf in fixtures.
- **Deploy the explicit fresh version id** and confirm SUCCESS before launching.
- **Wait ~2 min between terminating a run and launching the next** (browser session drain).
- **Step ordinals live on a half-step grid** (k, k+0.5). Extra sub-steps get folded into
  the existing half-step record, never a new fractional slot.
- Persisted-progress invariant: a durable denominator never becomes unknown again
  (`preserveDurableReadingBase`).
- **CF Workflow step timeouts don't fire on live WebSockets at long durations.** The
  80-minute step timeout (BATCH_POLICY) did not kill v93b batch 1 or v94 batch 0 — the
  Puppeteer WebSocket kept the step "alive" for 5+ hours. But the framework DID enforce
  shorter timeouts (v53-v63 at ~67:01). v96 reduces the step timeout to 22 minutes, inside
  the range where enforcement was measured. The inner hard abort timer is retained as a
  secondary defense.

## Why "gates green" does not mean "wall falls" (say this honestly)

The gates prove the fix's logic against fixtures built from the measured evidence of the
LAST run. They cannot see the NEXT layer of a wall the site has not shown yet — B10 was
three stacked defects (keyboard-only registration, staged validation, specify pairing) and
each was invisible until the previous one fell. The live run is the only gate for site
behavior, and it costs a ~35-minute walk per answer. Report accordingly: "gates green,
live-unproven" until the run's own receipts show the screen passed.

## Next steps (in order)

1. **Verify v84 at B10** (run `v2r_01m0dcadeay20nhmh5wap22dag` or relaunch): does the deep
   walk pass screen 68? If yes — new territory; classify the next wall from its receipts.
2. **Speed up the loop** (owner priority): (a) a dev-only jump — use the test link's own
   on-page "QUESTION SKIP MENU" select to reach a target question directly for iteration
   runs (the driver already DETECTS it: `isPlatformNavigationWidget`; dev-drive already
   validates `targetQuestionId` but only steers the plan today). Gate it like `DEV_SEED`
   (dark in prod), run it on a scratch/bench worker, never prod. (b) capture diet for
   iteration walks — ~21s of every ~28s step is screenshot/epoch capture (task #20);
   sparse-capture mode with a named limitation.
3. **First complete end-to-end report** once the completion page is reached: full honest
   walk (no jump, full capture), every termination triggered, report published.
4. Deferred polish: anchor-cleaner on route labels; multi-lane flag-on (EXEC_LANES);
   three-leg pass A; seed receipt refusals (#18).

## Where things live

| Path | What |
|---|---|
| `worker-v2/src/browser/driver.ts` | The walker: fills, recovery rounds, mechanisms |
| `worker-v2/src/browser/page-script.ts` | In-page scripts (reader, set/clear/read value) |
| `worker-v2/src/workflow/stages/plan.ts` | Survival hints, route typing, owner joins |
| `worker-v2/src/extract/expand.ts` | Route/terminal binding (terminalOf, EXPANDER_VERSION) |
| `worker-v2/src/workflow/stages/execute-batch.ts` | Walk ledger (progress.json shape) |
| `worker-v2/tools/tests/d56-…`, `d36-…` | The walker/plan fixtures for every wall above |
| `worker-v2/DEPLOY.md` | Release gates incl. the mutation census |
| `.local-private/` (git-ignored) | Canary outputs, watch scripts, fetched artifacts |
| Owner memory (Claude sessions) | `~/.claude/projects/E--survey-qa/memory/` |
