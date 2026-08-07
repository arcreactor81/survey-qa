# Oracle groundwork — internal representation

Ground-truth **obligation sets** for the branching corpus
(`test-suite/branching/`): for every survey × variant, the complete
denominator a perfect testing agent should discover and exercise. Built by
`build-oracle.mjs`, reconciled by `selfcheck.mjs`, emitted to `generated/`.
Taxonomy aligned with `docs/llm-led-architecture-proposal.md` §3.

```
scorer/oracle/
  build-oracle.mjs      derivation entry point (writes generated/)
  selfcheck.mjs         reconciliation checks (re-derives, compares, exits 1 on drift)
  lib/corpus.mjs        the only module that touches the corpus on disk;
                        re-exports the REAL engine.js + lib/describe.mjs + stripAnswerKey
  lib/model.mjs         obligation objects, id scheme, content hashing, diffing
  lib/schema-guard.mjs  strict manifest key/enum vocabulary walker
                        ("zero unmapped constructs" — see scope note below)
  lib/walk.mjs          exhaustive branch walk PORTED from validate.mjs (see below)
  lib/derive.mjs        manifest -> ObligationSet (the internal representation)
  lib/seeded-map.mjs    seeded error -> affected obligations (mechanical, per-patch)
  lib/pipeline.mjs      shared orchestration for builder and selfcheck
  lib/serialize.mjs     THE ADAPTER SEAM (only module that knows the file shape)
```

## Internal representation

`deriveOracle(manifestRaw, {surveyId, variant, ...})` returns an
**ObligationSet** (plain objects, no I/O):

```
{ surveyId, variant, manifestPath, manifestSha256, title, seed, questionCount,
  obligations: [Obligation...],       // sorted: category rank, then id
  obligationMap: Map<id, Obligation>,
  paths: [WitnessPath...],            // every distinct routing path
  walkRuns, notes, problems }

Obligation  = { id, localId, category, type, sourceRef, requirement, payload,
                contentHash, reachable, witnessPathIds }
WitnessPath = { pathId, signature, visited, outcome, answers, edgeLocalIds }
```

Categories (each manifest fact lives in **exactly one** obligation, so
clean/flawed diffs are minimal and attributable):

| category | contents |
|---|---|
| `question` | every question that can appear: id, text, type, presentation lists (options / allocation rows, labels only), loop membership. Constraints do NOT live here. |
| `rule` | non-branch obligations: instructions, numeric ranges, exclusive options, carry-forward lists, piping tokens, randomize order + anchor (with the seed-deterministic expected render order), allocation sum / bounds / per-row caps, loop definitions, computed variables. |
| `branch` | every branch EDGE: per rule the "fired" outcome (`goto`/`terminate` taken), plus one `default` continue edge per ruled question (all conditions false). An unconditional rule always fires, so nothing after it and no default edge is emitted. |
| `terminal` | every distinct terminate state + normal completion. |

`requirement` is the plain-language programmer instruction, rendered with the
**same** `lib/describe.mjs` the docx generator uses, so oracle text and
questionnaire text cannot drift apart.

## Obligation id scheme

Stable and deterministic: derived from survey id + category + **source
location / semantic signature**, never from array indices.

```
full id = <surveyId>/<localId>

question:<qid>
rule:<qid>:instruction | range | exclusive:<code> | carry-forward
   | piping:<token> | randomize-order | randomize-anchor
   | alloc-sum | alloc-bounds | alloc-row:<rowCode>
rule:loop:<loopId>     rule:calc:<computedId>
branch:<qid>:goto:<target>[#n]:taken
branch:<qid>:terminate:<termId>[#n]:taken
branch:<qid>:default
terminal:terminate:<termId>     terminal:complete
```

A rule edge is identified by its **outcome signature** (`goto:Q5`,
`terminate:under-18`), so a re-pointed skip is a *removed + added* obligation
pair, while a re-thresholded condition keeps its id and changes its
`contentHash`. `#n` disambiguates the (currently unused) case of two rules on
one question with the same outcome. `contentHash` covers only semantic
content (category, type, sourceRef, requirement, payload) — never
reachability — so clean/flawed content diffs are isolated from routing side
effects.

## Reachability / witness paths

`lib/walk.mjs` is a **behavior-identical port** of the exhaustive branch walk
in `test-suite/branching/validate.mjs` (which neither exports its functions
nor can be imported without running its whole check suite). The enumeration
code (answer-class analysis, subset/boundary/allocation candidates, replay
recursion, 20 000-run cap) is copied verbatim and runs the real `engine.js`;
selfcheck asserts the distinct-path counts equal `corpus.json` routingPaths,
exactly like validate.mjs. The port only **adds** instrumentation: per
distinct path the visited sequence, a concrete witness answer vector, the
outcome, and which branch edges fired (re-evaluated with the engine's own
`evalCondition`, first-match-wins, answer stored before rules run). If the
walk ever hits an edge the taxonomy did not emit, the build fails.

## Seeded-defect labels

Mechanical, no hand-labels: each seeded error's JSON patch is applied ALONE
to the clean manifest, the set re-derived, and content-diffed against clean.
Selfcheck requires the union of per-error deltas to tile the full
clean-vs-flawed diff **exactly** (no unattributed differences, matching
hashes). `expectedObservable` carries the corpus's documented observable
deviation; each delta also records clean/flawed requirement strings.

## Adapter seam

`lib/serialize.mjs` is the only module that knows the on-disk shape
(`oracle-groundwork/v1` + `oracle-groundwork-index/v1`). Everything upstream
of it is schema-agnostic internal representation. When the converged
OracleRecord schema lands, **reshape `serialize.mjs` only**; `build-oracle.mjs`
writes whatever it returns and `selfcheck.mjs` re-derives through the same
functions, so the determinism check keeps holding automatically. Useful
building blocks already present for the adapter: per-obligation
`contentHash`, per-file manifest sha256 provenance, witness input vectors per
path, and `counts.complexityWeight` (= Q + 2L + 3B from proposal §5).

## Known scope notes

- **What the "zero unmapped constructs" guard actually guarantees.**
  `lib/schema-guard.mjs` walks manifest **keys and enum values** against the
  known `branching-survey/v1` vocabulary; selfcheck C11 asserts that this list
  is empty for all 12 manifests. So the guarantee is: no manifest carries a
  key or enum value the taxonomy has never seen — a *new* construct cannot
  slip in and silently yield an incomplete obligation set. It is **not** an
  obligation-production check: a *recognised* key that emits no obligation at
  all is reported as fully covered. `title` and `intro` are recognised and
  produce no obligation in any of the 12 records (verified); the optional
  `notes` / `terminateHtml` / `completedHtml` keys are likewise recognised
  vocabulary that `lib/derive.mjs` never reads at all. The guard also
  reads only the manifest, so requirements the questionnaire states outside it
  (e.g. the docx generator's hardcoded programming preamble) are structurally
  outside its reach. See `docs/p0-adversarial-audit.md` Finding 10.
- The engine auto-skips a carried-forward question whose resolved option list
  is empty; in this corpus that situation is unreachable (sources are guarded
  by rules), so no display-skip obligations are emitted. If a future manifest
  makes it reachable, the walk/derive cross-check will surface it.
- Global engine behaviors (all answers required, forward-only navigation) are
  engine-level invariants, not per-manifest constructs, and are not obligation
  rows.
- Unresolvable piping tokens (e.g. flawed s3's `{Q2drug}`) render literally by
  engine design; they appear in `derivationNotes` and in the question text
  payload, not as piping obligations.
