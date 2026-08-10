# `evaluation/` — the ablation harness

**Read `PRE-REGISTRATION.md` first.** It is the contract; this file is just the operating
manual. Nothing here may be changed after the first scored run without an `--amend` and a
written reason (§8.2).

## What this measures

Not "which architecture wins". Per the owner ruling of 2 Aug 2026, the hybrid is the
**destination**, so this is an **ablation**: how much does each component contribute, and
where is the seam.

| Condition | What it is | Its gap to C measures |
|---|---|---|
| **A** model-only | LLM navigates, coverage attested | what the **graph** adds |
| **B** graph-only | compiled graph, coverage computed | what the **model** adds |
| **C** hybrid | graph plans, model judges attributes | — (the reference) |
| **C-R** hybrid, random traversal | same as C, random equal-size path set | whether principled coverage is **doing the work** |

## Layout

```
PRE-REGISTRATION.md   the contract: metrics, matching rule, decision rule, threats
REPORT-TEMPLATE.md    the shape of the final write-up, committed before any result
score.mjs             the scorer — arm-agnostic, deterministic, mutation-tested
run-arm.mjs           serves a survey, invokes an arm, owns the telemetry
finding-schema.mjs    the one normalised format every arm emits
lib/class-map.mjs     pinned vocabulary: 16 requirement classes, predicates, locator rules
lib/serve.mjs         static file server for one survey's site/
adapters/             _template.mjs documents the contract; a.mjs b.mjs c.mjs cr.mjs are stubs
arms/                 per-arm DEPLOYMENT isolation: ARCHITECTURE.md, manifests, build identity,
                      the parity verifier. Read ARCHITECTURE.md §9 for why no arm can run yet.
selftest/             the proof the scorer can fail, plus the mutation harness
budget.json           identical caps for every condition — ALL NULL until the owner ratifies
exclusions.json       bad test items, removed from numerator AND denominator
```

## Running it

```bash
# 0. Build every arm from ONE tree and prove they are the same code. Refuses on mismatch.
node evaluation/arms/build-all.mjs      # PARITY PROVEN, or exit 3
node evaluation/arms/verify.mjs --selftest   # 11/11 — the parity gate can fail

# 1. Prove the instrument works. Both must be green before any scored run.
node evaluation/selftest/run.mjs        # 31/31 cases
node evaluation/selftest/mutate.mjs     # 16/16 mutants killed

# 2. Pilot a condition (no ratified budget needed; cannot produce a headline).
node evaluation/run-arm.mjs --arm C --survey test-suite/blind/batch-2/<id> --pilot \
     --driver graph-spike/cdp.mjs --model-proxy <module>

# 3. Score. This is the ONLY code in the repo that reads an answer key.
node evaluation/score.mjs --corpus test-suite/blind/batch-2 --results evaluation/results \
     --annotations evaluation/key-annotations.json --exclusions evaluation/exclusions.json
```

`score.mjs` exits non-zero when any inconclusive condition fires (§6.8) — including on pilot
data, which cannot produce a headline.

## The five things most likely to be broken later

1. **The ambiguity rule.** Guessing is a failure *even when the guess is right* (§4.4).
   Protected by the `lucky-guesser` self-test and the
   `ambiguity-guess-counts-as-correct` mutant.
2. **Swing dominance.** If resolving the adjudication queue the other way flips a
   comparison, no point estimate is the result (§7.3).
3. **The absolute margin.** `b − c ≥ 5` *and* Holm-adjusted p ≤ 0.05. On a 12-survey corpus
   this is demanding and **inconclusive is the most likely outcome** — that is correct, not
   a failure of the experiment.
4. **Shared document ingestion** (§8.1). If the arms use different `.docx` parsers, this
   measures parsers and reports the answer as architecture.
5. **`attribution` on every finding** (§3.3). Required from v1.0.0 — retrofitting it after
   the first run means re-running everything.
6. **Build parity across arms** (`arms/ARCHITECTURE.md` §5–6). Four separate deployments can
   *introduce* the confound they exist to remove. This already happened once, on 2 Aug, while
   the harness was being built: a concurrent edit to `worker-v2/src/` landed between the third
   and fourth build and the arms came from two different trees. Every arm reported the same
   git SHA. `treeHash` and `bundleHash` are what caught it.

## Blindness

No arm ever receives a `truth/` path; `run-arm.mjs` checks the adapter's declared scope
before invoking it, and `score.mjs` is the only module that opens an answer key. The
self-test suite uses entirely fabricated keys — the blind corpus is untouched by the tests
that prove the scorer works.
