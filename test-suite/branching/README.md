# Branching test corpus (routing / logic / calculations)

Test corpus for **phases 2 and 3** of the Survey QA roadmap — routing/logic and
calculations/allocation tables — and the **acceptance test-bed for the LLM-led
testing pivot**. Six survey packages of escalating logic complexity, each with:

- a **ground-truth `.docx` questionnaire** written the way real questionnaires
  document programming logic ("IF Q2=2 (NO), SKIP TO Q5.", "TERMINATE IF S1 < 18.",
  "SUM OF ALL ROWS MUST EQUAL 100.", loop / piping / rotation notes);
- a **clean live survey** (`index.html`) that faithfully implements the docx;
- a **flawed live survey** (`flawed.html`) with 2–3 seeded logic deviations.

The key design property: **ground truth is machine-readable**. Every survey is
defined by a JSON manifest (questions, coded option lists, skip/branch rules,
terminate conditions, piping, loops, allocation + derived-calculation rules).
One shared dependency-free engine (`engine.js`) renders and enforces the
manifest in the browser, so:

- the docx is *generated from* the clean manifest (`gen-branching-docx.mjs`
  via `lib/describe.mjs` — document and logic cannot drift apart);
- the flawed variant is *exactly* the clean manifest plus documented JSON
  patches (each seeded error carries `id`, `location`, `description`, `patch`);
- a tool under test (LLM-led or otherwise) can be scored mechanically against
  `manifest.flawed.json` / `corpus.json`.

## Corpus matrix

| id | topic | logic features | Qs | routing paths (clean/flawed) | seeded errors in flawed variant |
|---|---|---|---|---|---|
| **s1-skip** | Plaque psoriasis (HCP) | single-select skip gate, one skip target | 8 | 2 / 2 | wrong-skip-target, missing-option, missing-instruction |
| **s2-screener** | Migraine (consumer) | screener, 4 terminate paths (age, diagnosis, industry, quota-full) | 10 | 5 / 4 | terminate-not-enforced, wrong-threshold (<16 vs <18), boundary-off-by-one (> vs >=) |
| **s3-multiselect-piping** | Type 2 diabetes (GLP-1) | multi-select-driven branch, carry-forward options, piping, count branch, exclusive option | 9 | 3 / 3 | broken-piping ({Q2drug} literal), carry-forward-broken, inverted-branch |
| **s4-nested-rotation** | Metastatic NSCLC (oncology) | nested branching, terminate, rotation + shuffle with anchored option, unconditional skip | 10 | 4 / 4 | wrong-skip-target (nested), rotation-anchor-violation, missing-option |
| **s5-allocation** | Plaque psoriasis (HCP) | constant-sum table (sum=100, per-row cap), derived calculation, calc-driven branch | 9 | 2 / 2 | allocation-sum-not-validated, wrong-branch-threshold (30 vs 50), row-cap-removed |
| **s6-kitchen-sink** | Rheumatoid arthritis (HCP) | 3 terminates, multi-select, **loop per selected brand (max 3)**, carry-forward, piping, allocation, calc-driven branch | 12 | 53 / 12 | loop-truncated (max 1), terminate-not-enforced, wrong-calc-source (r1 vs r5) |

"Routing paths" = distinct visited-question sequences (loop iterations keyed
per brand) counted by `validate.mjs`'s exhaustive branch walk. Full
machine-readable index: [`corpus.json`](corpus.json).

## Package layout

```
s1-skip/
  manifest.json          clean ground truth (the spec of record)
  manifest.flawed.json   clean + documented seeded-error patches (+ answer key)
  questionnaire.docx     generated from manifest.json (never contains errors)
  index.html             clean live survey  (manifest inlined, self-contained)
  flawed.html            flawed live survey (answer key stripped from the page)
```

`index.html` / `flawed.html` are fully self-contained static pages (inline
manifest + `../engine.js`, zero network/CDN): **just open them from disk** in
any browser, or serve the directory (`npx http-server test-suite/branching`).
The flawed page shares the clean page's title and never embeds
`seededErrors`/`variant`, so the **seeded-defect labels and the scorer-only
oracle are never delivered to the browser**. That is the whole of what is
protected, and it is narrower than "cannot cheat": every page inlines its own
complete logic specification (`<script type="application/json"
id="survey-manifest">`) and the engine publishes live state on
`window.__surveyEngineState` (exposed for debugging/walker use, same as the
demo's `window.survey`). A tester that reads page source can therefore diff
that manifest against the docx and infer every planted deviation **without
interacting with the survey at all** — and some flawed manifests still ship
per-object `note` fields stating the clean intent their patched values
contradict. So a real evaluation harness must bar page-source inspection, or
serve compiled fixtures that do not carry their own logic; otherwise logic
*discovery* is not being measured. (See `docs/p0-adversarial-audit.md`
Finding 8.)

The engine renders one question per screen, forward-only (no back button), all
answers required — matching the docx programming note. Randomization/rotation
is deterministic per `(manifest.seed, question.id)` so renders are reproducible
and rotation errors are assertable.

## Regenerate / verify

```
node test-suite/branching/gen-branching-docx.mjs   # manifests -> questionnaire.docx
node test-suite/branching/gen-pages.mjs            # manifests -> index.html / flawed.html
node test-suite/branching/validate.mjs             # full corpus verification (must pass)
node test-suite/branching/smoke-dom.mjs            # browser-code-path smoke only
```

`validate.mjs` (no dependencies beyond the repo's own `docx`/`fflate`):

1. **Static integrity** — every skip target exists / is forward / never lands
   inside a loop block; loop, carry-forward, computed-variable, randomize and
   allocation definitions are well-formed; piping tokens resolve (clean).
2. **Exhaustive branch walk** using the *same* `engine.js` the browser runs —
   answer classes cover every option of condition-referenced questions, every
   valid subset of condition/loop multi-selects, boundary values (t-1, t, t+1)
   of every numeric gate, and targeted allocation distributions for each
   derived-calculation threshold. Asserts every terminate path is reachable,
   every question is reachable, and path counts match `corpus.json`.
3. **Flawed = clean + documented deltas, exactly** — applies each seeded
   error's JSON patch to the clean manifest and requires deep equality with
   the flawed manifest; plus behavioural probes proving each seeded flaw is
   *observable* (wrong skip lands wrong, terminates don't fire, sums accepted,
   loop truncated, anchor violated, literal piping token rendered).
4. **Docx fidelity** — unzips each `questionnaire.docx` and asserts every
   question, option, and programmer-logic instruction string is present.
5. **Page wiring + smoke** — inline JSON equals the manifest file (answer key
   stripped), `node --check` on all scripts, then `smoke-dom.mjs`: executes
   the real `engine.js` browser code path in a `node:vm` DOM shim and
   click-drives all 12 pages + one terminate path end-to-end (112 screens),
   cross-checking DOM-driven visit sequences against pure engine runs.
   *Limit: this is a purpose-built shim, not a real browser — no CSS/layout,
   no native event semantics.*

## Manifest schema (v1) — quick reference

See the header comment in [`engine.js`](engine.js) for the full contract.
Conditions: `{q|var, op, value}` with `eq ne lt lte gt gte includes
notIncludes countLt/Lte/Gt/Gte/Eq`, plus `and`/`or`. Rules run in order after
a question is answered; first match wins (`goto` forward skip or `terminate`).
Loops repeat a block per selected option of a source multi-select (`{LOOP}`
piping token). `computed` variables sum allocation cells and can drive later
branch conditions.

## Role in the LLM-led testing pivot

This corpus is the **acceptance bed** for the pivot: an LLM-led tester is
pointed at a live page plus the `.docx` (never the manifests) and must recover
the seeded logic deviations. Scoring = match reported findings against
`manifest.flawed.json` `seededErrors` (id/location/category), exactly like the
phase-1 held-out testbench in `test-suite/README.md`. Clean pages measure the
false-positive rate; `s6-kitchen-sink` is deliberately at the hard end
(loops + allocation-derived branching) to leave headroom above phase-1's
239/240 saturation.
