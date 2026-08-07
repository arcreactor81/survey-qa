# The evaluation boundary — phase 1 of a staggered push

**Status: PHASE 1. The exclusions below are temporary and expire on a stated
trigger. Nothing here is a permanent removal.**

## The ruling

> "just keep the testing material blind for now, and once the test runs are
> complete, publish them alongside the test materials on the repo — staggered
> push."

The blind corpus and everything derived from it stay out of the public
repository **for now**, and are published **later, together with the results**.
That is the whole policy. Phase 1 is the holding pattern; phase 2 is the
publication.

## The trigger

**Once the test runs are complete, the material and the results are published
together.** There is no other condition, and no partial release: publishing the
corpus without the results, or the results without the corpus, is exactly the
asymmetry the staggered push exists to avoid.

## What is excluded, and why

`.gitignore` carries two blocks. The first is unconditional and predates this
decision; the second is headed **PHASE 1 OF A STAGGERED PUSH** and is the one
this file is about.

| Path | Why |
|---|---|
| `test-suite/blind/` | the corpus itself: questionnaires, sites, answer keys, seeded defects |
| `pipeline/runs/t1-easy/` | **derived, and sufficient on its own.** Its captured artifacts reconstruct the corpus and every planted defect without the corpus being present: `artifacts/_textdiff.json` holds a verbatim document-vs-site copy of every screen with per-screen verdicts, `artifacts/_analysis.json` prints the full option inventory with codes, and the session traces carry each mis-route step by step. |
| `pipeline/judge/out/t1-easy/`, `pipeline/judge/replay/` | judgements over that run, item by item |
| `pipeline/judge/VERIFICATION*.md` | verification write-ups that name the seeded defects |
| `pipeline/report/samples/acceptance/`, `pipeline/report/samples/t1-easy-*` | rendered reports over that run |
| `worker-v2/ui/fixtures/16-live-seeded-t1-easy.json` | a UI fixture seeded from it |
| `pipeline/runs/t2-*`, `t3-*`, `t4-*` and their derivatives | tiers 2-4 and anything derived from them (unconditional block) |

**Excluding `test-suite/blind/` alone protects nothing.** That is the single
most important fact in this file: the derived run reconstructs the corpus by
itself. Any future exclusion decision has to cover the derivatives or it is
decoration.

## What replaces it, so the public suites still work

A control experiment established that the corpus has **zero** test dependents —
a clone with `test-suite/blind/` deleted and the pipeline artifacts kept passed
15/15. All of the cost came from removing the **derived run**, which five public
suites used as a substrate.

So the repository now carries a public stand-in:

- **`pipeline/runs/synthetic-demo/`** — a signed, 28-session run over an
  invented houseplant-care questionnaire. Committed on purpose. It shares no
  question, no answer text, no code frame and no defect with any blind tier.
- **`pipeline/runs/make-synthetic-run.mjs`** — builds it. Its header states the
  survey and every planted defect in full, because none of it is blind. Delete
  the directory and re-run the script to rebuild.
- **`pipeline/runs/run-source.mjs`** — the resolver every suite imports:
  - `SUBSTRATE_RUN` — the private run when it is in the checkout, the synthetic
    one when it is not. Suites that need *a real signed run* use this and are
    green either way.
  - `SUBSTRATE_SHAPE` — each run's own `substrate-shape.json`. A few tests must
    name a coordinate of the run they drive (which routing rule diverges, which
    screen is conditional). Written into a public test file, those coordinates
    **are** the planted defects spelled out, so they live beside the run instead
    and the private copy ships in phase 2.
  - `privateOnly(reason)` — a node:test skip **with a stated reason**, for the
    handful of tests that assert t1-easy's own numbers.
  - `announcePrivateRunGate(file, n)` — prints a banner on stderr when anything
    is gated, so absence is loud.

Every file that gates a test also pins **how many** of its tests are gated and
checks that pin against its own source. Adding a silent skip turns a test red.

## Consequences a maintainer should expect

- With the private run present: **15/15 suites pass, 0 skips.**
- Without it: **15/15 suites pass, 13 declared skips** (4 in
  `pipeline/judge/selftest/engine.test.mjs`, 1 in `v2.test.mjs`, 8 in
  `pipeline/report/test/samples.test.mjs`), each printing its reason, plus one
  banner per affected file.
- Regenerating the samples (`node pipeline/report/make-samples.mjs`) and the
  acceptance artifact (`node pipeline/report/make-acceptance-artifact.mjs`)
  still needs the private run; both write into excluded paths.

## Phase 2 — publishing, when the runs are complete

1. **Confirm the trigger.** The test runs are complete and the results are ready
   to publish in the same push. If only one half is ready, do not start.
2. **Delete the PHASE 1 block from `.gitignore`** — the whole block between the
   `PHASE 1 OF A STAGGERED PUSH` banner and the `!pipeline/runs/synthetic-demo/`
   line. Decide separately whether tiers 2-4 and the unconditional answer-key
   rules above it should also expire; they are a different question with a
   different risk, and the safest default is to leave them.
3. **Re-check the unconditional block.** `**/answer-key.json`,
   `**/seeded-defects*.json`, `test-suite/blind/**/truth/` and friends still
   match inside `test-suite/blind/`. Publishing the corpus *with* its answer keys
   means those rules have to go too; publishing it *without* them means they
   stay. This is a deliberate choice, not an oversight to fix in passing.
4. **Sweep for material that is still disclosive outside the excluded paths.**
   As of phase 1 the following public files already describe t1-easy's seeded
   defects in prose, and were left alone because they are owner-facing narrative
   rather than test infrastructure: `README.md` (line 6),
   `docs/ui-report-redesign.md` (several quoted UI strings),
   `pipeline/report/test/register-render.test.mjs` (fixture labels lifted from
   the corpus), `pipeline/judge/lib/route-table.mjs` (a comment). They are
   harmless once phase 2 lands; before then they are a leak, and they are the
   reason phase 1's protection is **partial**. See the publication-safety report.
5. **Publish the results in the same push.** `pipeline/runs/t1-easy/DEBRIEF.md`,
   the judgements under `pipeline/judge/out/`, and the rendered reports are the
   results half of "publish them alongside the test materials".
6. **Keep the synthetic run.** It is not a stopgap: it is the only substrate the
   public suites have that is guaranteed present in every checkout, and it keeps
   the suites runnable by anyone who clones the repo without the corpus. Do not
   delete it when the private run returns — `run-source.mjs` prefers the private
   run automatically.
7. **Re-run the clean-clone check** after editing `.gitignore`: copy the repo to
   scratch, delete everything the new `.gitignore` excludes, and run all 15
   public entrypoints. The count should not move.

## The 15 public entrypoints

```
scorer/test/run-suites.mjs                     pipeline/report/test/denominators.test.mjs
scorer/oracle/selfcheck.mjs                    pipeline/report/test/first-glance.test.mjs
scorer/oracle/validate-oracle-records.mjs      pipeline/report/test/hardening.test.mjs
scorer/integration/verify-integration.mjs      pipeline/report/test/real-artifact.test.mjs
test-suite/branching/validate.mjs              pipeline/report/test/register-render.test.mjs
pipeline/judge/selftest/engine.test.mjs        pipeline/report/test/samples.test.mjs
pipeline/judge/selftest/v2.test.mjs            pipeline/report/test/trust-boundary.test.mjs
                                               worker-v2/tools/test.mjs   (cwd: worker-v2)
```
