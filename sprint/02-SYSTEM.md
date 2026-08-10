# The system — architecture and the files that matter

Root: `E:\survey-qa`. The live product is **`worker-v2/`** (Cloudflare Worker + Workflows). `src/` at the repo
root is **v1 and dead** — a prior review wasted effort reading it. Do not.

## Pipeline stages, in order

| stage | file | what it does |
|---|---|---|
| extract pass A | `src/extract/pass-a.ts` | Grok, whole-document / global rules |
| extract pass B | `src/extract/pass-b.ts` | DeepSeek, chunked block-by-block |
| expand | `src/extract/expand.ts` | requirements → typed **execution cases** with sealed expectation payloads |
| **seal** | `src/store/contract-revision.ts:101` `sealContract()` | content-addressed, Ed25519-signed |
| plan | `src/workflow/stages/plan.ts` | cases → walk paths with typed decisions |
| execute | `src/workflow/stages/execute-batch.ts` | drives the browser, writes the walk ledger |
| project | `src/workflow/stages/project-observations.ts` | walk records → observations |
| **verify** | `src/workflow/stages/verify-observations.ts` | **the predicates. The thing being tested.** |
| derive | `src/workflow/stages/derive-verdicts.ts` | observations → item results |
| assemble | `src/workflow/stages/assemble-record.{ts,mjs}` | the signed record; derives claims |
| report | `src/report/build.ts`, `render.ts` | the human-readable page |

Orchestration: `src/workflow/run-workflow.ts`. **`seal-contract-revision` is a SEPARATE step (line ~751) from
extraction** — that separation is the seam the sprint's build task uses.

Browser layer: `src/browser/driver.ts` (walk logic, decision binding), `page-script.ts` (the in-page reader —
a string evaluated in the browser, so no DOM in the unit suite), `capture.ts`, `types.ts`.

## The invariants — do not violate any of these

1. **NO MODEL IN THE VERDICT PATH.** A model may emit a typed OBSERVATION; code owns promotion to a verdict.
   `rejectModelDerivedVerdicts` re-checks at the write boundary.
2. **Promotion to `verified` only via a typed sealed expectation compared against RE-HASHED artifact bytes.**
3. **The predicate registry is CLOSED** — `PREDICATE_FOR_KIND` = route, boundary, option-set. **No default arm.**
   Adding a fourth during the sprint invalidates the measurement.
4. **Contract revisions are immutable.** A correction is a superseding signed revision, never a mutation.
5. **Refuse rather than guess.** Every refusal is a named, counted reason code.

## Screen identity — the seam everything binds through

`screenIdentity(screen, sealedIds)` returns three witnesses, unioned:
- **markup** — control `name`/`id` matching a sealed question id
- **wording** — the document's question text scored against the screen (F-measure: precision against the
  screen's own heading, recall against full text). **Binds at ≥0.70 with a ≥1.25× margin over the runner-up.**
- **heading token** — a document id printed in the screen's own heading

**More than one sealed id ⇒ REFUSE.** Two walker vetoes also apply: `bindingRefusals` and `unboundDecisions`
(the walker's own record of what it declined) can only *withhold*, never accuse.

**This is what blocked s1-skip** — see `01-THE-EXPERIMENT.md`. The 0.70/1.25 constants are **mirrored in
`driver.ts` and `verify-observations.ts`** with a cross-module test pinning their agreement.

## The option-set predicate (newest, v1.6.0)

Labels and codes are parsed from **`displayQuote` — the document's verbatim span** — then required to be
corroborated by the model's `normativeStatement`. The model only chose which span to point at; the document
supplied the compared bytes.

- **Presence is witnessed by LABEL equality only.** Codes are a match key and a licence, never an accusation —
  a site may number options any way it likes.
- **ORDER is out of scope entirely.** Documents routinely permit rotation.
- **Extra options** are claimable only when the document closes the set ("exactly N … and no others").
- **Withholding dominates**: if any asserted option is uncertain, the whole case is `insufficient`. Reporting
  the confident half while dropping the doubtful half turns a partial reading into a whole accusation.
- All three accusing arms sit behind an attestation gate: `readerLimitations` must be **present AND empty** —
  absence is never treated as "none".

## Versions that gate behaviour

- `VERIFIER_VERSION = "v2-structural-verifier/1.6.0"` (stamped `+no-model` in records)
- `EXPANDER_VERSION = "v2-floor-expander/1.3.0"` — **in the contract-reuse key**; 1.3 makes
  non-constraining assertion statuses preview-only, and the bump correctly invalidates cached contracts
- `EXECUTION_PROGRAM_KIND = "v2-execution-program/2.0.0"` — **do not bump.** Several test files seed the literal
  string; a bump once broke 22 tests that were testing something else.

## Contract reuse

`src/store/contract-reuse.ts`. Keyed on `documentSha256` + prompt/model/expander versions. **Proven live:
$0.0000, 0 model calls, identical requirements.** No lock — concurrent runs of the same document each extract
and diverge, so **submit paired runs sequentially**.
