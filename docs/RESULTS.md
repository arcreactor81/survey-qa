# Validation & Results

Two kinds of evidence back this tool: a **seeded benchmark** (a survey with known planted
errors, used during development) and a **held-out generalization test** (surveys the tool has
never seen). Both are reproducible from this repo.

---

## 1. Seeded benchmark (the demo)

`spec/canon.json` defines a 10-question plaque-psoriasis HCP survey with **10 deliberately-seeded
discrepancies** (E01–E10) spanning every category, plus 2 error-free questions to measure false
positives. `public/survey.html` renders the *errored* survey; `spec/questionnaire.docx` is the
clean ground truth. The tool walks the survey, compares each page against the doc, and is scored
against the manifest.

**Result: 10/10 recall, every run.** Across the known-good baseline and after each backend change
this session, the ensemble caught all 10 seeded errors:

| Run | Recall | Raw false positives (deepseek / claude / grok) |
|---|---|---|
| Known-good baseline | **10/10** | 1 / 5 / 1 |
| + walker completion-scoping | **10/10** | 3 / 4 / 2 |
| + 1 MiB step offload | **10/10** | 3 / 4 / 1 |
| Final (all fixes together) | **10/10** | 3 / 4 / 1 |

**The ensemble is the point.** In the baseline run no single model was perfect — deepseek
individually caught 7/10, while claude and grok each caught 10/10. The **consensus** (the union of
what any model flags) hits 10/10; false positives raised by only one model are demoted to low
confidence in the report. A *miss* (false negative) is the expensive failure — it ships to
respondents and corrupts data — so the roster is built to make misses rare and treat false
positives as cheap.

Multilingual: the benchmark scores 10/10 across all six languages (en/es/fr/de/zh/ja) — see
[model-bakeoff.md](model-bakeoff.md) for the per-language and per-model matrix.

---

## 2. Held-out generalization test (blind, unseen data)

The benchmark is the survey the models + prompt were developed against. To measure whether the tool
**generalizes** rather than fits the demo, we built a held-out suite: **24 surveys the tool had
never seen** — 4 therapeutic areas × 6 languages — each with 10 fresh seeded errors and a matching
localized ground-truth `.docx`, deployed as a *separate external* Cloudflare Worker. See
[../test-suite/README.md](../test-suite/README.md).

The live tool was pointed at each of the 24 external surveys with its matching-language docx and
scored blind against that case's seeded errors:

| Case | en | es | fr | de | zh | ja |
|---|---|---|---|---|---|---|
| **oncology** | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| **rheumatoid-arthritis** | 10/10 | 9/10\* | 10/10 | 10/10 | 10/10 | 10/10 |
| **type-2-diabetes** | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| **migraine** | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |

**239 / 240 seeded errors caught** — on data it had never encountered: different diseases, different
brands, fresh error instances, in six languages including CJK, over external cross-origin surveys.

- The one strict "miss" (RA / es, Q2 `wrong-option-label`) is a **category-label difference, not a
  real miss**: the tool *did* flag Q2 (it caught the discrepancy) but labeled the error type
  differently. On "did it catch the problem?" recall is effectively **240 / 240**; on "right
  question AND exact category" it is 239 / 240.
- **False positives: 22 total across 24 surveys (~0.9 / survey)** — low-confidence and
  consensus-demoted. The dominant type is a benign `[NUMERIC ENTRY, range …]` doc-generator
  annotation that a single model reads as a missing instruction (a real doc-vs-site difference, just
  not a meaningful one).
- The hard categories held in every language: **missing-question** (a whole question deleted from
  the site but present in the doc), broken piping, CJK mojibake encoding, scale mislabels.

**Bottom line:** ~100% effective / 99.6% strict recall on 240 planted errors in surveys it had never
seen, at under one false positive per survey. This is a defensible generalization result, not just
"10/10 on the demo."

---

## 3. Model selection

The three-model roster (DeepSeek v4-pro + Grok 4.3 + Claude Sonnet 4.6, all in-Worker via a
Cloudflare AI Gateway) was chosen empirically — roughly a dozen models benched across four rounds,
with Workers-AI (gpt-oss) and Gemini evaluated and retired on the numbers. Full decision record:
[model-bakeoff.md](model-bakeoff.md).

---

## 4. Correctness & security hardening

The pipeline survived two adversarial audit rounds and a deliberate, verified remediation (every
finding evaluated one at a time against the live scorecard, so two potential recall regressions were
caught *before* they shipped). Full disposition: [hardening.md](hardening.md).

---

## Reproduce

- **Benchmark:** open the deployed Worker → **Run QA** (uses the bundled demo), or
  `POST /api/run {"surveyUrl":"/survey.html","lang":"en"}`.
- **Generalization:** point the tool at any [testbench URL](../test-suite/README.md) with the
  matching `test-suite/cases/<slug>/questionnaire.<lang>.docx`, then score the findings against that
  case's `seededErrors` (question IDs align across languages).
