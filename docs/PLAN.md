# The plan — from today's state to a finished system

Written 22 Aug 2026, after the Fable evaluation and the first bench replay. This replaces
loop-freestyling: work proceeds phase by phase, each phase closed by a GATE that is a
measurement, not a feeling. Owner-ratified ordering; the owner may reorder Phase D.

## Standing rules (bind every phase)

1. **The bench replay is the integration gate.** No production deploy, no live run, until
   the change passes a replay of the full judging tail against real archived run data on
   the scratch worker (`survey-qa-replay`). Live runs confirm; they do not discover.
2. **No forecasts.** Status is what happened and what is running.
3. **Test links only** — always re-enterable; live links out of bounds entirely.
4. Money: extraction cache guarded (models/rates/prompts/parser untouched or owner
   go-ahead); DeepSeek-heavy paid work off-peak only; OpenAI paid cap $5; Gemini re-bench
   budget $10 (authorized).
5. Builders write (Opus 4.6, sha-pinned worktrees), Fable reviews and integrates;
   comprehensive evaluations run on Fable agents.
6. Every phase's landing gets a log entry at landing time, not after.

## PHASE A — an attestable pipeline, proven on the bench

The five fixes the evaluation specified, validated by replaying the archived v100 run.

| # | Item | Size |
|---|---|---|
| A1 | **Committed-attempt evidence filter** at record-assembly AND the judge's mount (one shared function): only catalogue rows whose attempt is in the committed walk ledger enter the signed record, the manifest, and the mount. Kills the duplicate refusal at its last layer; removes the 1,429 measured orphan rows; replaces v101's arbitrary tie-break. Document-evidence rows (no attempt) exempt by rule. | a day |
| A2 | **Fan-out economies**: `derive-verdicts` stops fetching a catalogue it never reads (one argument); the catalogue listing is fetched once and shared across the tail stages; remaining per-entry fetches get bounded concurrency. | hours |
| A3 | **Memory-safe judging**: the judge processes evidence in bounded batches — never all ~9,300 blobs resident; hash-and-release. | structural |
| A4 | **One bad file must not kill the run**: a missing/corrupt blob demotes that item with a named reason instead of failing the run at its last step. | hours |
| A5 | **Bounded refusal text**: collision/refusal details truncate to counted samples (the 1MiB step-state ceiling). | hours |
| A6 | **Signing key** — DONE 22 Aug: `judgement-ed25519-fd11213761e7` minted (owner-approved), registered in both configs, private half live in bench secrets and staged for prod secrets at the Phase B deploy. Private PEM only in git-ignored `.local-private/keys/`. | done |

**GATE A: the bench replay of the v100 archive produces an ATTESTED judgement and a
results-bearing report, twice consecutively.**

## PHASE B — one deploy, one confirming run

Deploy the Phase A train (plus the staged key registry; prod `secret put` of the key at
the same moment). One live run. **GATE B: the live run's attested report matches what the
bench predicted from recordings.** Then the log, the ledger page, and the runbook are
updated to the new baseline.

## PHASE C — walker economy (rides the next train after Gate B)

| # | Item | Task | Size |
|---|---|---|---|
| C1 | Per-walk **progress watchdog** + partial-recording salvage (walks that advanced 15+ screens must never be recorded as zero). Refit of #30 — the measured dead walks all froze *after* startup. | #30 | a day |
| C2 | Browser death **abandons the batch** instead of burning every remaining path in seconds. | new | hours |
| C3 | Run-completion mislabels + the missing failure page for post-execution deaths. | #21, #29 | a day |
| C4 | **Capture diet** (unparked from stage 3 — it halves the catalogue, directly easing A2/A3 and every future run; ~21s of every ~28s step is capture). | #20 | a day |

Gate: replay + fixture batteries; no dedicated live run — rides the next train.

## PHASE D — make the report say something (the three ceilings)

Proposed order (owner may reorder). Each lands separately, bench-gated, one live run each.

| # | Item | Task | Size |
|---|---|---|---|
| D1 | **Screener answers** mined from the questionnaire for every screening question, so walks stop being turned away at the door. Unlocks everything behind the screener (67 directly-gated checks + all deep coverage). | #28 | a day+ |
| D2 | **Cross-run accumulation**: verified results inherit across runs on the same sealed questionnaire; coverage compounds instead of resetting. Pairs with the site-atlas direction (prior recordings feeding the plan). | new, #31 | structural |
| D3 | **The second checking lane** (model verifier) for the 367 checks that have no typed rule today — the hard cap on what can ever settle. Absorbs the prompt-refinement debt. | new, #12 | structural, biggest |

## PHASE E — throughput and model economics (stage 2)

| # | Item | Task |
|---|---|---|
| E1 | Two-lane bench trial → four lanes → concurrent runs, measured at each step. Starts once Phase D produces publishable runs (no value walking faster toward an unfinished pipeline). | #14 |
| E2 | Gemini re-bench ($10 authorized) and the three-leg extraction design. | #16 |

## PHASE F — hardening and debt (stage 3)

- Overnight full-battery job (all 47 campaigns); judge/report/scorer suites wired into the
  release gate; orphan suites registered. (Evaluation: the fake-env layer cannot test
  time/retries/scale — the bench covers that; the battery covers guard-decay.)
- Evaluation's remaining mediums: observation-ledger size compaction, shim-retry identity,
  orphan representability, report alias clobbering.
- Seed receipt refusals (#18); doc annotations (closed-gaps notes in the audits);
  worktree + stale-branch cleanup (#8).

## PHASE G — later stages (stage 4–5, from the staged plan)

Finalize the system; unknown-widget research loop (#25); document-processing improvements,
contract improvements, OCR exploration.

## Decision log

- 22 Aug: owner approved the shared judgement key (A6 done bench-side) and this plan's
  creation. Phase D order is proposed, not yet ratified.
