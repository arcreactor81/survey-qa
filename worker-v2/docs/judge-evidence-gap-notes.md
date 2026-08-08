# The judge could not read v2 evidence — diagnosis and fix

Working notes. Written before the edits, extended as they landed.

## 1. The chain, end to end

    browser/capture.ts          capturePathObservation() writes a PathObservation
                                (kind "v2-path-observation/1.0.0") to R2 under
                                artifactRef  observations/<pathId>/observation.json
              |
    store/evidence.ts           putEvidence() catalogues it: { evidenceId, artifactRef,
                                contentHash, byteLength, ... }
              |
    stages/run-inputs.ts:88     loadArtifactBytes() → { name: basename(artifactRef), bytes }
              |
    stages/derive-verdicts.ts   mintJudgement() → judgeRunInIsolate({ artifacts, ... })
              |
    stages/judge-runtime.mjs    writes each artifact to <mount>/artifacts/<basename>
              |
    pipeline/judge/lib/authority.mjs:309
                                manifest key = basename(evidence[].artifactRef)
              |
    pipeline/judge/lib/evidence-store.mjs
                                classifyArtifact(name) + shape promotion via
                                captureSpineState(data)  ← requires data.evidence[]
              |
    pipeline/judge/lib/sessions.mjs
                                loadSessions() → isSessionArtifact() → normalizeSession()
              |
    pipeline/judge/lib/engine.mjs
                                buildContext() → routeTable / census / walks → predicates
              |
    report/build.ts             loadJudgement() → the "re-derived" (current results) column

## 2. Where v2 data stops being readable — TWO independent stops

### Stop A (fires first, and it is worse than "no rows"): the manifest collides

`authority.mjs:309` keys the signed evidence catalogue by `basename(artifactRef)`.
Every walk's observation is `observations/<pathId>/observation.json`, so **every walk
after the first** produces `MANIFEST_DUPLICATE_ARTIFACT`. Per `authority.mjs:357` that
code clears `manifestComplete`, and `verified = contractBound && manifestComplete &&
checklistBound` (line 380) therefore goes false.

An unverified authority is `diagnostic-only`: **no JudgementRecord is minted at all**,
so `report/build.ts` has nothing to load and the current-results column is absent.

The same collision hits the per-step captures (`step-000-<slot>.json`, `.png`) and the
failure captures (`<label>.json`) — they are catalogued too, and `loadArtifactBytes`
iterates the whole catalogue.

`run-inputs.ts:96` and `judge-runtime.mjs:109` flatten by basename identically, so the
mount silently overwrites as well: N walks land as one file.

### Stop B (the shape): a PathObservation is not a session

`captureSpineState(data)` (evidence-store.mjs:319) requires `data.evidence` to be a
non-empty array of `{ seq, screen_id }`. A `PathObservation` has `steps[]` of
`{ stepIndex, screenBefore, screenAfterAdvance, actions[] }` and no `evidence[]` and no
`trace[]`.

So:
- `classifyArtifact("observation.json")` → not `/^(FLOOR|EXP|TD|T\d)/` → `UNKNOWN`;
- the shape-promotion block (evidence-store.mjs:249-253) gets
  `{ wellFormed: false, looksLikeSession: false }` and leaves the class `UNKNOWN`;
- `isSessionArtifact()` is false, and `loadSessions`'s quarantine branch (sessions.mjs:308)
  *also* tests `Array.isArray(rec.data.evidence)` — so the artifact is **dropped in
  silence, not even quarantined**;
- `buildContext` gets `sessions = []` → empty routeTable / census / walks → every
  predicate returns `no-observation` → `deriveVerdict` → `not-assessed` for every row.

Note the file-name regex is NOT the real gate: classification is by shape first
(evidence-store.mjs:249). Renaming the artifact alone would change nothing.

## 3. The fix, and why this shape of fix

**Adapter, not "trust the workflow's verdicts".** The report's authoritative column
exists to be an *independent re-derivation*. A projection from the signed bytes into the
session view is still independent: the judge re-reads the bytes, re-hashes them against
the signed catalogue, and recomputes everything itself. What it is NOT allowed to do is
import `verify-observations.ts`'s decisions, and it does not.

**Where the adapter must live: inside `EvidenceStore.read()`, after hash verification.**
This is forced, not preferred. The bytes on the mount must hash to the `contentHash` in
the signed catalogue (`authority.mjs:348`, `evidence-store.mjs:217`). Any transform
upstream of the judge changes the bytes and raises `ARTIFACT_HASH_MISMATCH`. And it
cannot live in `sessions.mjs` alone either: `attest()` calls `proof(rec.data, claim)` on a
fresh uncached read, so witness locators (`evidence[i]...`) must resolve against the same
projected view or every witness trips `WITNESS_LOCATOR_UNRESOLVED`.

Projecting in `read()` gives one seam that serves classification, `loadSessions` and
`attest()` at once. `rec.sha256` stays the digest of the true bytes.

**Screen identity comes from the screen, not from the producer.** `screen_id` is derived
with the same rule `verify-observations.ts` uses at D19: the sealed question id printed on
the screen as a whole word, and no other sealed id present. `StepObservation.decisionQuestion`
is deliberately NOT used — it is `driver.ts#matchDecision`'s option-label heuristic, i.e.
a producer claim. A screen that identifies as nothing (or as two ids) gets a stable
`SIG-<hash>` token: it stays in the spine and contributes captures, and binds no
obligation.

**Collision: fix the producer, not the judge's keying.** Legacy v1 artifactRefs are
4-segment (`runs/synthetic-demo/artifacts/EXP-07.json`) and both sides already agree on
`basename()`. Changing that flattening rule would rename every legacy artifact and buy
nothing. Making the v2 basenames unique at capture time keeps one rule everywhere.
Belt and braces: `loadArtifactBytes` now refuses a colliding set rather than overwriting,
and the mount loop in `judge-runtime.mjs` throws instead of `continue`-ing over one.

## 4. Traps handled in the projection

- **Blocked steps author no forward action.** A step where Next was pressed and the screen
  did not change would otherwise become a `screen → itself` edge, and a route predicate
  comparing that to the documented destination would mint a *false fail* — the exact class
  of error this judge exists to prevent.
- **`ok: false` actions are dropped.** An action the driver failed to perform is not a
  click that happened.
- **The terminal screen is kept.** The last step's `screenAfterAdvance` is appended as a
  final spine entry, or the survey's last screen disappears from the census.
- **The spine is consecutive by construction** (`seq` = 1..N over the emitted captures),
  because `captureSpineState` quarantines a gapped spine.

## 5. Screen identity: adopted from D24 rather than re-invented

The first draft of `screenIdOf` read rendered text only, which is what
`verify-observations.ts#tokenOnScreen` used to do. D24 (landed concurrently, in the same tree)
measured that this identifies NO screen on the instrument under test — it renders prose
headings and prints no question numbers — and found the ids sitting unread in every control's
`name` / `id`. A text-only projection would therefore have produced a spine of `SIG-...` tokens
binding nothing: a null run, reached by a different door than the one this change closes.

`v2-observation.mjs` now uses the same union (text ∪ control `name`/`id` prefix), fail-closed on
a screen presenting two sealed ids. It is RE-STATED rather than imported: the judge is
standalone ESM that also runs offline over v1 runs and must not depend on the producer's tree.
The two must stay in agreement — a screen the verifier calls Q7 and the judge calls something
else would put the report's two columns in disagreement for a reason that is neither column's
finding.

## 6. Two things worth knowing that the fix surfaced

**`hasCurrentResults` does not mean anything was assessed.** It is TRUE for an attested,
run-bound JudgementRecord whose every row is `not-assessed`. Measured: with the projection
disabled, the report still publishes `hasCurrentResults: true`, `derivedVerdicts: true` and a
populated `re-derived` column — over two rows that both read `NOT_REACHED`. Any check that the
report "has current results" is therefore not a check that the run produced any. The D25 report
test reads per-row cell states out of the published bytes for that reason.

**The report's `findings` count does not come from the judge.** It is the RunRecord's
`claims[]`, which `assembleRecord` currently builds empty. So a judge-derived FAIL reaches the
reader through the register's `re-derived` column and NOT through the findings total. Not
touched here — it is a separate wire — but a reader who counts findings will under-count
defects.

## 7. NOT FIXED HERE, AND THEY MATTER — two vocabulary gaps between v2 and the judge

Both were found while building the end-to-end proof. Neither is a shape problem, so neither is
in scope for this change, and neither can be fixed by guessing — but a reader who runs this on
a real survey will meet them.

### 7a. NO ROUTING REQUIREMENT CAN COMPILE FROM A v2 REVISION — **CLOSED, 8 Aug**

> **Closed.** The v2 facet vocabulary was taken as canonical (the facet is inside the sealed
> digest; nothing that gets signed changed) and the judge's gate learns it through an explicit
> mapping, `pipeline/judge/lib/facet-vocab.mjs`, pinned set-equal to the producer's own
> `FACET_TO_CASE_KIND` route class. A route obligation now reaches a real verdict end to end,
> both arms, in `worker-v2/tools/tests/d26-routing-facet.test.mjs`. Reasoning and the full
> ground truth: `worker-v2/docs/routing-facet-notes.md`. The description below is kept as the
> record of what the defect WAS.

`R-ROUTE-1` (`compile.mjs`) gates on the SIGNED item type:

    if (o.category !== 'branch-outcome') return null;

`o.category` comes from `contract.items[].type`, which `contractItemFromRequirement` sets to
`r.facet`. Every v2 revision spells that facet **`routing`** (`tools/fixtures/v2-fixture.mjs`,
`tests/d24-screen-identity.test.mjs`). `routing !== branch-outcome`, so the rule never fires and
every routing requirement lands `NO_TYPED_EXPECTATION` → `not-assessed` in the authoritative
column.

Consequence, stated plainly: **routing defects — much of what this system exists to catch — are
invisible in the re-derived column on a v2 run**, even now that the judge can read the evidence.
The in-workflow verifier still decides them (it keys on its own `case.kind`), but that is the
column the architecture deliberately does not let drive current results.

This is why D25's end-to-end fixture uses `option-set` obligations: they are what compiled at
the time. The consequence was that the route half of the projection (trace → `route-table.mjs`
→ `route@1` → `ROUTE_EDGE` attestation) was unit-tested but NOT exercised end to end, because
no route obligation could reach it. Closing it meant deciding whether the facet vocabulary or
the compiler's gate is canonical, which is signed-contract binding semantics and wanted its own
tests — not a rename in passing.

**How it was closed.** The facet won, because `requirements[].facet` is inside
`semanticContractBody`'s digest and the revision id IS that digest, whereas
`contract.items[].type` is a read-time projection applied after `authority.mjs` verifies. So
nothing signed moved and `contract.items[].type` still publishes the facet verbatim; the judge
gained `facet-vocab.mjs#isRouteFacet`, whose set (`branch-outcome`, `routing`, `skip-rule`,
`terminate`) is asserted set-EQUAL to the producer's `FACET_TO_CASE_KIND` route class so the
two halves cannot drift. `null` still fails closed, so D3 is untouched. D26 measures the old
gate by reverting the line: 7 of its 10 cases go red, and the route table comes back EMPTY
rather than merely undecided — `documentScreens` derives the capture vocabulary from compiled
expectations, so a closed gate also blinded the projection that feeds it.

### 7b. THE ALIASED SCREENS ARE NOT IN THE PROJECTION'S VOCABULARY

`documentScreens` builds `WHOLE_SCREEN_TOKEN` from the compiler's own `SCREEN_TOKEN`, which
matches the PHRASE forms (`welcome screen`, `closing screen`, `screen-out screen`). But
`resolveScreen` maps those phrases to the RESOLVED aliases `WELCOME` / `CLOSING` / `SCREENOUT`,
and that is what lands on the compiled expectation. The resolved form does not match the phrase
regex, so it never enters the vocabulary. Measured on the synthetic run:

    VOCAB                 ["Q1","Q2","Q3","Q4","Q5","Q6","Q7","S1"]
    EXPECTATION SCREENS   ["Q1","Q2","Q3","Q4","Q5","Q7","WELCOME"]
    MISSED                ["WELCOME"]

So a v2 capture can never identify itself as `WELCOME`, and an obligation about the welcome
screen is permanently `not-assessed` on a v2 run. Conservative (never a wrong verdict, only an
absent one) and deliberately left alone: adding the aliases makes `tokenOnScreen` match the bare
word "welcome", which is common enough in body copy that a question screen saying "welcome back"
would then present two sealed ids and REFUSE — trading a missing row for a lost one. That is a
judgement call about the identity rule, not a plumbing fix.

## 8. Baseline

THE BASELINE MOVED UNDER THIS WORK, so it is quoted as a range rather than a number. At the
start `node worker-v2/tools/test.mjs` reported **222/222** (the task brief said 217). Another
agent landed D24 and the run-tools suite in the same tree while this was in progress. Final
tree: **271/271 passed, 0 failed**, of which **14 are D25's**. `npx tsc --noEmit` clean, and
`node --test pipeline/judge/selftest/engine.test.mjs pipeline/judge/selftest/v2.test.mjs`
136/136.

Evidence the new tests can fail (checked by hand, both reverted):
- projection disabled in `evidence-store.mjs` → the end-to-end verdict counts go to
  `{pass:0, fail:0, inconclusive:0, not-assessed:2}` and the published cells to
  `["NOT_REACHED","NOT_REACHED"]`;
- `capture.ts` naming reverted → both walks mount as `observation.json` and the whole
  end-to-end suite fails.
