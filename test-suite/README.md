# Held-out multilingual generalization testbench

External, held-out generalization suite for the Survey QA tool. Each route is a
walkable multi-page SurveyJS survey whose **rendered** content deviates from its
**localized** ground-truth `questionnaire[.<lang>].docx` in exactly the seeded
errors listed in that case's manifest — nothing more. The tool under test is
scored on whether it recovers those seeded discrepancies (and does **not**
flag the deliberately clean questions).

- **Live base:** https://survey-qa-testbench.arcreactor81.workers.dev
- **Route pattern:** `/<slug>/<lang>` — `lang ∈ {en, es, fr, de, zh, ja}`
- Bare `/<slug>` 302-redirects to `/<slug>/en`.
- **4 cases × 6 languages = 24 live surveys.** Every language of a case shares
  identical `questionId`s and an identical seeded-error signature
  (`id:questionId:category`); only the human-readable strings are translated, so
  a finding scored in one language lines up in all of them. Brand names stay in
  Latin caps in every language.

## Results — blind dry-run (5 Jul 2026)

The live tool (`survey-qa.arcreactor81.workers.dev`) was pointed at all 24 external
surveys, each paired with its matching-language ground-truth `.docx`, and its
findings scored against that case's seeded errors. This is a **held-out
generalization test**: none of these surveys, brands, or error instances appear in
the seeded demo the models + prompt were developed against.

| Case | en | es | fr | de | zh | ja |
|---|---|---|---|---|---|---|
| **oncology** | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| **rheumatoid-arthritis** | 10/10 | 9/10\* | 10/10 | 10/10 | 10/10 | 10/10 |
| **type-2-diabetes** | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| **migraine** | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |

**239 / 240 seeded errors caught** (strict = right `questionId` **and** right
`category`). False positives: **22 total across 24 surveys (~0.9 / survey)** —
low-confidence and consensus-demoted; the dominant type is the benign
`[NUMERIC ENTRY, range …]` doc-generator annotation that a single model reads as a
missing instruction.

\* The one strict miss (RA / es, Q2 `wrong-option-label`) is a category-label
difference, not a real miss: the tool **did** flag Q2 — it caught the discrepancy —
but classified the error *type* differently. On "did it catch the problem?" recall
is effectively **240 / 240**; on "right question AND exact category" it is
**239 / 240**.

Scoring: match `questionId` + `category` against each case's `seededErrors`
(question IDs align across languages, so the English manifest scores every
language); a false positive is a finding on a deliberately-clean question.
Reproduce with the live URLs below + each case's localized `.docx`.

## Live URLs

Index (lists every survey): https://survey-qa-testbench.arcreactor81.workers.dev/

| Case | en | es | fr | de | zh | ja |
|---|---|---|---|---|---|---|
| **oncology** | [en](https://survey-qa-testbench.arcreactor81.workers.dev/oncology/en) | [es](https://survey-qa-testbench.arcreactor81.workers.dev/oncology/es) | [fr](https://survey-qa-testbench.arcreactor81.workers.dev/oncology/fr) | [de](https://survey-qa-testbench.arcreactor81.workers.dev/oncology/de) | [zh](https://survey-qa-testbench.arcreactor81.workers.dev/oncology/zh) | [ja](https://survey-qa-testbench.arcreactor81.workers.dev/oncology/ja) |
| **rheumatoid-arthritis** | [en](https://survey-qa-testbench.arcreactor81.workers.dev/rheumatoid-arthritis/en) | [es](https://survey-qa-testbench.arcreactor81.workers.dev/rheumatoid-arthritis/es) | [fr](https://survey-qa-testbench.arcreactor81.workers.dev/rheumatoid-arthritis/fr) | [de](https://survey-qa-testbench.arcreactor81.workers.dev/rheumatoid-arthritis/de) | [zh](https://survey-qa-testbench.arcreactor81.workers.dev/rheumatoid-arthritis/zh) | [ja](https://survey-qa-testbench.arcreactor81.workers.dev/rheumatoid-arthritis/ja) |
| **type-2-diabetes** | [en](https://survey-qa-testbench.arcreactor81.workers.dev/type-2-diabetes/en) | [es](https://survey-qa-testbench.arcreactor81.workers.dev/type-2-diabetes/es) | [fr](https://survey-qa-testbench.arcreactor81.workers.dev/type-2-diabetes/fr) | [de](https://survey-qa-testbench.arcreactor81.workers.dev/type-2-diabetes/de) | [zh](https://survey-qa-testbench.arcreactor81.workers.dev/type-2-diabetes/zh) | [ja](https://survey-qa-testbench.arcreactor81.workers.dev/type-2-diabetes/ja) |
| **migraine** | [en](https://survey-qa-testbench.arcreactor81.workers.dev/migraine/en) | [es](https://survey-qa-testbench.arcreactor81.workers.dev/migraine/es) | [fr](https://survey-qa-testbench.arcreactor81.workers.dev/migraine/fr) | [de](https://survey-qa-testbench.arcreactor81.workers.dev/migraine/de) | [zh](https://survey-qa-testbench.arcreactor81.workers.dev/migraine/zh) | [ja](https://survey-qa-testbench.arcreactor81.workers.dev/migraine/ja) |

## Ground-truth questionnaires (.docx)

The clean Word document each survey is scored against — one per case per language (**24 total**).
These are the **correct** spec (not the errored survey): the tool flags where a rendered survey
deviates from its matching-language doc. GitHub opens each in a file view with a **Download** button.

| Case | en | es | fr | de | zh | ja |
|---|---|---|---|---|---|---|
| **oncology** | [.docx](cases/oncology/questionnaire.docx) | [.docx](cases/oncology/questionnaire.es.docx) | [.docx](cases/oncology/questionnaire.fr.docx) | [.docx](cases/oncology/questionnaire.de.docx) | [.docx](cases/oncology/questionnaire.zh.docx) | [.docx](cases/oncology/questionnaire.ja.docx) |
| **rheumatoid-arthritis** | [.docx](cases/rheumatoid-arthritis/questionnaire.docx) | [.docx](cases/rheumatoid-arthritis/questionnaire.es.docx) | [.docx](cases/rheumatoid-arthritis/questionnaire.fr.docx) | [.docx](cases/rheumatoid-arthritis/questionnaire.de.docx) | [.docx](cases/rheumatoid-arthritis/questionnaire.zh.docx) | [.docx](cases/rheumatoid-arthritis/questionnaire.ja.docx) |
| **type-2-diabetes** | [.docx](cases/type-2-diabetes/questionnaire.docx) | [.docx](cases/type-2-diabetes/questionnaire.es.docx) | [.docx](cases/type-2-diabetes/questionnaire.fr.docx) | [.docx](cases/type-2-diabetes/questionnaire.de.docx) | [.docx](cases/type-2-diabetes/questionnaire.zh.docx) | [.docx](cases/type-2-diabetes/questionnaire.ja.docx) |
| **migraine** | [.docx](cases/migraine/questionnaire.docx) | [.docx](cases/migraine/questionnaire.es.docx) | [.docx](cases/migraine/questionnaire.fr.docx) | [.docx](cases/migraine/questionnaire.de.docx) | [.docx](cases/migraine/questionnaire.zh.docx) | [.docx](cases/migraine/questionnaire.ja.docx) |

Each case folder also holds its `manifest[.<lang>].json` (questions + the seeded-error key) and
`errored-model[.<lang>].json` (the SurveyJS model actually served). The demo's own ground-truth doc
lives at `spec/questionnaire.docx` in the repo root.

## Cases

Each case has 10 questions (`S1, S2, Q1–Q8`) across 5 pages and 10 seeded errors.
Localized titles below.

### oncology — Oncology, first-line immunotherapy in metastatic NSCLC
Brands: KEYTRUDA, OPDIVO, TECENTRIQ, IMFINZI, LIBTAYO · Clean (must NOT be flagged): S2, Q3
Categories: typo, missing-option, wrong-option-label, broken-piping, scale-mislabel, reordered-options, wrong-numbering, encoding-artifact, duplicated-word, missing-instruction
- en — Oncologist Perceptions of First-Line Immunotherapy in Metastatic Non-Small Cell Lung Cancer
- es — Percepciones de los oncólogos sobre la inmunoterapia de primera línea en el cáncer de pulmón no microcítico metastásico
- fr — Perceptions des oncologues sur l'immunothérapie de première ligne dans le cancer bronchique non à petites cellules métastatique
- de — Wahrnehmungen von Onkologen zur Erstlinien-Immuntherapie beim metastasierten nicht-kleinzelligen Lungenkarzinom
- zh — 肿瘤科医生对转移性非小细胞肺癌一线免疫治疗的认知
- ja — 転移性非小細胞肺がんの一次免疫療法に対する腫瘍内科医の認識

### rheumatoid-arthritis — Advanced therapy in moderate-to-severe RA
Brands: HUMIRA, ENBREL, RINVOQ, XELJANZ, ORENCIA · Clean: S2, Q3
Categories: typo, missing-option, wrong-option-label, broken-piping, scale-mislabel, reordered-options, wrong-numbering, duplicated-word, missing-instruction, **missing-question** (Q7 removed from site, present in .docx)
- en — Rheumatologist Perceptions of Advanced Therapies in Moderate-to-Severe Rheumatoid Arthritis
- es — Percepciones de los reumatólogos sobre las terapias avanzadas en la artritis reumatoide de moderada a grave
- fr — Perceptions des rhumatologues sur les traitements avancés dans la polyarthrite rhumatoïde modérée à sévère
- de — Wahrnehmungen von Rheumatologen zu fortgeschrittenen Therapien bei mittelschwerer bis schwerer rheumatoider Arthritis
- zh — 风湿科医生对中重度类风湿关节炎先进治疗的认知
- ja — 中等症から重症の関節リウマチにおける先進的治療に対するリウマチ専門医の認識

### type-2-diabetes — GLP-1 / incretin therapy selection
Brands: OZEMPIC, MOUNJARO, JARDIANCE, TRULICITY, RYBELSUS · Clean: Q3, Q6
Categories: typo, missing-option, wrong-option-label, broken-piping, scale-mislabel, reordered-options, encoding-artifact, duplicated-word, missing-instruction, **missing-question** (S2 removed from site)
- en — Clinician Perceptions of Incretin-Based Therapies in Type 2 Diabetes
- es — Percepciones de los médicos sobre las terapias basadas en incretinas en la diabetes tipo 2
- fr — Perceptions des cliniciens sur les traitements à base d'incrétines dans le diabète de type 2
- de — Wahrnehmungen von Ärzten zu inkretinbasierten Therapien beim Typ-2-Diabetes
- zh — 临床医生对2型糖尿病基于肠促胰素治疗的认知
- ja — 2型糖尿病におけるインクレチン関連治療に対する臨床医の認識

### migraine — CGRP-targeted therapy selection
Brands: NURTEC, UBRELVY, AJOVY, EMGALITY, QULIPTA · Clean: Q3, Q8
Categories: typo, missing-option, wrong-option-label, broken-piping, scale-mislabel, reordered-options, wrong-numbering, encoding-artifact, missing-instruction, **missing-question** (S2 removed from site)
- en — Clinician Perceptions of CGRP-Targeted Therapies in Migraine
- es — Percepciones de los médicos sobre las terapias dirigidas al CGRP en la migraña
- fr — Perceptions des cliniciens sur les traitements ciblant le CGRP dans la migraine
- de — Wahrnehmungen von Ärzten zu CGRP-gerichteten Therapien bei Migräne
- zh — 临床医生对偏头痛靶向CGRP治疗的认知
- ja — 片頭痛におけるCGRPを標的とする治療に対する臨床医の認識

## How each discrepancy is localized

Structure-only categories are language-independent: **missing-option** removes a
(Latin) brand, **broken-piping** shows the literal `{Q3brand}` token,
**wrong-numbering** renders `Q6.` as `Q5.`, **missing-instruction** drops the
question's instruction, **missing-question** removes a whole spec question from
the site (kept in the `.docx`), **scale-mislabel** and **reordered-options**
duplicate/swap the translated matrix columns / Q2 options in place.

Language-dependent categories follow native conventions:

| Category | es | fr | de | zh | ja |
|---|---|---|---|---|---|
| **typo** (S1 role) | dropped letter (`Reumatólogo`→`Reumatólgo`) | dropped letter (`-ologue`→`-ologe`) | letter drop/transpose | homophone char (`肿`→`种`) | wrong-kanji IME (`腫`→`種`) |
| **wrong-option-label** (Q2) | clinical-meaning shift, e.g. supervivencia→respuesta | survie→réponse | Überleben→Ansprechen | 生存→缓解 | 生存→奏効 |
| **encoding-artifact** (Q7) | `opinión`→`opiniÃ³n` | `accès`→`accÃ¨s` | `größte`→`grÃ¶ÃŸte` | `患者`→`æ‚£è€…` | `患者`→`æ‚£è€…` |
| **duplicated-word** (Q8) | `usted usted` | `vous vous` | `Sie Sie` | `的的` | `にに` |

The encoding-artifact mojibake is the exact UTF-8-bytes-read-as-CP1252 rendering
(the whole point of that test); the localized completion page also carries the
English marker `Thank you for completing the survey.` that the walker's text
fallback needs.

## Regenerate / verify

Manifests are the source of truth. Per case dir `cases/<slug>/`:
`manifest.json` = English, `manifest.<lang>.json` = localized. Run from the
suite root (`docx` resolves from the repo-root `node_modules`):

```
node scripts/gen-cases.mjs     # (re)builds questionnaire[.<lang>].docx + errored-model[.<lang>].json + testbench/src/models.json
node scripts/verify-cases.mjs  # asserts every seeded error is present per language + cross-language signature match
cd testbench && wrangler deploy
```

`gen-cases.mjs` **throws** on the first mutation whose (translated) target
string is not found — that throw is the per-language proof the seeded error is
actually present in the rendered survey.
