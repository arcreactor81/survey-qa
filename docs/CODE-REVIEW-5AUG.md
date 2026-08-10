# Code review findings — 5 Aug 2026

Defect-first review of `worker-v2` (trust boundary + pipeline stages). Read-only;
nothing in this file has been fixed. Written for the next agent (Claude) to own.

**Scope:** `worker-v2/src/{workflow,store,api,report,extract,browser,structure,arms}`  
**Not in scope:** v1 `src/`, scorer mutation strength, blind corpus keys.

**North-star reminder:** generalizable architecture — any survey + link. Corpus is an
instrument, never a specification. Fail loudly; never silent green over empty work.

---

## Fix order (recommended)

1. Close cases only when the walk selected that case’s answer/input (or mark explicit gap)
2. Require verified/contradicted (or counted expectation-gap) before `completion.test = complete`
3. Reject incomplete gate maps at seal
4. Re-hash report artifacts on serve + write-once version keys
5. Plan enrichment **or** per-answer paths; write checklist sidecars from consolidate
6. Wire usage counters; fix merge expansion union rules
7. Structure graph: drop `[QSD]\d+` hard-anchor; fix fallthrough accounting

---

## P0 — release / truth blockers

### [P0-1] Incomplete approval-gate maps can seal

**Where:** `worker-v2/src/workflow/gates.ts:107-110`, `worker-v2/src/store/contract-revision.ts:108-109` & `:213-220`, `worker-v2/shared/v2-record.mjs:118-136`

`unmetGates` / `contractGateFailures` only iterate keys that are **present**. An empty
`gates: {}`, or a map missing any of the four §0 names, yields zero failures, so
`sealContract` seals and `getContractRevision` / the judge’s authority binder treat the
revision as sealable. Types require four gates; runtime does not.

**Demo:** `sealContract(env, { …, extraction: { …, gates: {} } })` succeeds; same with a
single fabricated `{ state:"pass", proof:{…} }` entry and the other three omitted.
`d11-gates.test.mjs` never covers incomplete maps.

**Fix:** Reject unless all four named gates are present **and** `gatePassed`. Add a
negative test for `{}` and 3-of-4 maps.

---

### [P0-2] Floor walks close every assigned case without exercising that case’s answer

**Where:** `worker-v2/src/workflow/stages/plan.ts:241-252`, `worker-v2/src/workflow/stages/execute-batch.ts:411-417`

Assignment maps **all** `facetInstances` of a requirement onto the one path that
witnesses the obligation. Executor then closes **the whole list** when the walk merely
completes (`walkExercised` + any matched decision).

**Demo:** Requirement with answers code1→Q2, code2→Q3, code3→Q9; one floor path picks
code1; walk completes → all three cases marked exercised and projected. Verify then
yields `ROUTE_ANSWER_NOT_SELECTED` for the unselected answers — after the coverage
ledger already counted them exercised.

**Fix:** Close a case only when the walk selected that case’s `routeAnswer` /
`boundaryInput` (or leave it pending / mark an explicit gap). Do not treat
“path completed” as “every sibling case exercised.”

---

### [P0-3] Test axis can close `complete` with zero verified verdicts

**Where:** `worker-v2/src/workflow/run-workflow.ts:1070-1112` (`testAxisBlockers`)

Treats cursor `exercised` / `pending === 0` as “terminal disposition”. Never reads
verifier decisions or itemResults. D11 encodes that as success (`exercised: 2,
pending: 0` → zero blockers).

Combined with P0-2: every case can be “exercised”, verify all `insufficient`,
aggregator all `pending`/`incomplete`, yet `completion.test = "complete"`. That is the
empty/insufficient-denominator-looking-green failure mode. (`assemble-record.mjs`
claims close-test-axis refuses pending cases — that claim is false.)

**Fix:** Require verified/contradicted (or an explicit counted expectation-gap
disposition) before closing the test axis. Cursor “exercised” ≠ “settled by verifier.”

---

### [P0-4] Typed-case plan enrichment is claimed but absent

**Where:** `docs/SESSION-HANDOFF-5AUG.md:27-49` vs `worker-v2/src/workflow/stages/plan.ts:241-295`

Handoff §2 says plan injects sealed `routeAnswer` / `boundaryInput` into
`PlannedDecision` after `planFromContract`. The stage only builds path→case assignment
from `witness_map` and embeds the planner’s default decisions unchanged. Planner
defaults remain `default:first-non-terminating` (`plan-core.js:1020`). Documented
answers are never forced into the walk.

**Fix:** Implement enrichment (or per-answer paths), or correct the handoff. Prefer
implementing — without it, verified outcomes only happen by incidental click (P1-1).

---

## P1 — urgent

### [P1-1] Verified outcomes only by incidental click

**Where:** `worker-v2/src/browser/driver.ts:273-290` + `verify-observations.ts` route predicate

Without enrichment, a route case becomes `verified` only if navigator-default /
first-non-terminating happens to equal `routeAnswer`. Structural, not rare. Same walk
fails to verify sibling answers (P0-2).

---

### [P1-2] `matchDecision` can bind the wrong planned screen via shared option labels

**Where:** `worker-v2/src/browser/driver.ts:110-135`

Score += 3 per overlapping label with **no** question-token requirement. A later
decision whose `select` shares “Yes”/“No” can win on an earlier screen, get spliced out
of `remaining`, and leave the real question on `navigator-default`. Mislabelled steps
poison both audit and verify.

**Fix:** Require question-id / question-text agreement (or a strong score floor) before
accepting a label-only match.

---

### [P1-3] Production extraction never writes planner/judge checklist sidecars

**Where:**

- Plan reads `v2/runs/<id>/extraction/checklist.json` (`plan.ts:144-145`) — only
  `dev-drive.ts` writes it.
- Judge reads `v2/runs/<id>/checklist.json` (`checklist-store.ts`) — only `devseed`
  writes it.
- `extract.ts` / consolidate write merged/diff/ledger/preview only.

Every real run plans from thin `contractFromRevision` (no `stimulus`; warned at
`plan.ts:222-226`) and judges with revision projection (`ambiguitiesAvailable: false`).
Thinner floors, more uncovered, weaker withholding.

**Fix:** Write both sidecars from consolidate / seal path in production.

---

### [P1-4] Merge keeps first expansion when answer-sets differ without destination clash

**Where:** `worker-v2/src/extract/merge.ts:203-228`, `expand.ts:310`

Matching is greedy Jaccard. Expansion for cases is
`row.raw.find((x) => x.expansion !== null)?.expansion` — first non-null wins. Pass A
with 2 route answers + Pass B with 5 (same destinations) → no `routeDestinationClash`,
A’s shorter set is sealed. Denominator under-enumerates; missing branches never appear
as gaps.

Also: greedy steal — A₁ weak-matches Bⱼ (`score>=0.55 && sharesBlock`) and blocks A₂’s
better match → false “missed by pass” / wrong primary row.

Fits the measured 3/226 both-pass symptom (diagnose fully before trusting contracts).

**Fix:** Union expansions (or dispute on cardinality mismatch); prefer global matching
over greedy first-hit.

---

### [P1-5] Route destination clashes stay `entailed` on the requirement row

**Where:** `worker-v2/src/extract/merge.ts:244-250`

Clash is appended to `unresolvable` (blocks seal via high-risk gate) but
`assertionStatus` only flips on quantifier/scope conflict. If that gate is ever
weakened/review-bypassed, a clashing row still looks entailed. Status and high-risk
list disagree.

**Fix:** Set `assertionStatus: "disputed"` (or equivalent) when `routeDestinationClash`
fires.

---

### [P1-6] Published report HTML/data served without re-hash; version objects not write-once

**Where:** `worker-v2/src/store/publish.ts:81-86` & `:117-119`, `worker-v2/src/api/report.ts:42-68` & `:115-132`

Publish verifies hashes once, then writes `current.json` naming `artifacts.*.sha256`.
Version keys are overwritten with unconditional `put` (no `onlyIf`), and
`GET …/report` / `report-data` only check presence — never
`sha256Hex(bytes) === pointer.artifacts.*.sha256`. After publication, replacing bytes
under the version key leaves the pointer’s digest claim intact while clients get
different HTML/JSON (including `final: true` / `x-judgement-state`). Evidence content
correctly re-hashes; report serving does not.

**Fix:** Re-hash on serve (fail closed on mismatch); write version objects with
`onlyIf: { etagDoesNotMatch: "*" }` (or content-addressed keys only).

---

### [P1-7] Judgement `targetBuildId` binding can be elevated from the mutable RunRecord

**Where:** `worker-v2/src/report/build.ts:165-166`

Binding facts use `envelope?.input.targetBuildId ?? record.run.targetBuildId`. Because
`??` treats an explicit envelope `null` as missing, a run born with
`DEFAULT_TARGET_BUILD_ID` unset (`api/runs.ts:179` → `null`) can still bind if
`record.json` (not write-once) carries a build id. Same masking pattern already
rejected for contract revision ids in this file (`:93-98`).

**Demo:** envelope `targetBuildId: null`, record `run.targetBuildId: "build-x"`,
judgement bound to `"build-x"` with a registry-valid signature → `loadJudgement` can
reach `attested` though the envelope says there is no coherent target.

**Fix:** Prefer envelope; if envelope is explicitly `null`, do not fall back to record.
Disagreement between non-null values should fail closed.

---

### [P1-8] Tool/browser usage caps never fire

**Where:** `worker-v2/src/workflow/run-workflow.ts:1126-1138`

`toolCalls.used` is checked but nothing in `src/` increments it. Browser sessions don’t
charge usage. Caps are structural dead code for the expensive path. (Extraction does
increment `modelCalls` / cost.)

**Fix:** Increment tool/browser counters on session start / walk; ensure
`partial-budget` can fire for real.

---

### [P1-9] Zero-case seal marks the run failed but does not stop the workflow

**Where:** `worker-v2/src/workflow/run-workflow.ts:370-395`

Unmet gates return `{ sealed:false }` and fall through to `reportAndFinalize`. Zero
execution cases still return `{ sealed:true, executionCases:0 }` after setting
`empty-contract` / `test:failed`, then execution continues into plan/execute/adjudicate.
`testAxisBlockers` later blocks `complete`, but the early-stop intended by the comment
is not applied.

**Fix:** After seal, if `executionCases === 0`, `reportAndFinalize` and return (same as
unmet gates).

---

## P2 — ordinary defects

### [P2-1] Verify only handles `route` / `boundary` — intentional yield ceiling

**Where:** `verify-observations.ts:550-558`

Other kinds → `NO_TYPED_EXPECTATION` → `insufficient`. Documented as design, not a
silent stub. Combined with P0-3, “insufficient everywhere” can still look like a
completed test. Blocked on owner ruling: may a model-attested TYPED OBSERVATION (never
a verdict) earn `verified` through the deterministic derivation path?

---

### [P2-2] Driver/verifier label match asymmetry

**Where:** `driver.ts:92-99` vs `verify-observations.ts:466-473`

Driver: containment (`labelMatches`). Verifier `selectedAnswer`: exact normalized
label (or code). Walk can click the intended option via containment and still get
`ROUTE_ANSWER_NOT_SELECTED`.

---

### [P2-3] `structureEdgeCount` mutated after program put, never re-persisted

**Where:** `plan.ts` (after program `put`)

Program JSON is written, then `program.coverage.structureEdgeCount` is set in memory
only. Durable program lacks the count.

---

### [P2-4] `testComplete` is vacuously true on empty `itemResults`

**Where:** `assemble-record.mjs:222-224`

`[].every(...)` → `true`. Empty live-requirement set marks exploration complete. Axis
gate may still block `total===0`, but the signed record field itself is green.

---

### [P2-5] Fallthrough edges can never count as traversed

**Where:** `structure/compile.ts:260-266`, `structure/coverage.ts:21-24`

Fallthroughs use `sources: []`. `computeEdgeCoverage` only marks traversed when a
source facet id was exercised → fallthroughs always untouched, denominator inflated.
Empty `edges.length` yields `denominator: 0` with no “undefined coverage” guard.

Also: fallthrough can be invented when all answers leave the question (wrong graph).

---

### [P2-6] Structure `buildOrder` hard-anchors on `[QSD]\d+`

**Where:** `structure/compile.ts:151-157`

North-star violation: questions named otherwise are skipped unless already on a facet.
Corpus-shaped ids only. Contrast: `expand.ts` deliberately avoids `/^Q\d+$/`.

---

### [P2-7] Paths with zero planned decisions still close cases

**Where:** `execute-batch.ts:413`

`plannedDecisions === 0 || matchedDecisions > 0` → empty-decision paths that advance
one screen close their full `caseIds` set.

---

### [P2-8] Resume adopts a sealed id with a coerced empty `contractHash` and no re-bind

**Where:** `run-workflow.ts:176-186`

On resume, `contractHash: resumed.contractHash ?? ""` proceeds without calling
`getContractRevision`. A sealed checkpoint with a missing hash is treated as resumable
with `""`, while D4’s hash cross-check is skipped wherever callers pass
`expect.contractHash: null`. Downstream plan re-reads by id only.

---

### [P2-9] CONTINUE-as-destination fabrication — appears fixed (do not re-break)

`bindDestination` refuses relative phrases; unbound destinations get
`ROUTE_DESTINATION_NOT_BOUND`. d16 covers the old false verify via “Continue” button
text. Residual risk only if something else writes `expectedDestination.questionId` to a
UI token.

---

## P3 — low impact / hygiene

### [P3-1] UNBOUND route edges look like real graph commitments

**Where:** `structure/compile.ts:67-71` — edges to `"UNBOUND"` inflate `edgeCount`.

### [P3-2] Handoff doc describes enrichment that is not in the tree

**Where:** `docs/SESSION-HANDOFF-5AUG.md:27-49` — correct or implement (see P0-4).

### [P3-3] Verifying phase marked `complete` with zero observations

**Where:** `run-workflow.ts:649-652` — phase-complete ≠ coverage-complete; easy to
misread next to P0-3.

### [P3-4] Report pointer commit has no CAS / post-verify freeze

**Where:** `publish.ts:81-119` — secondary to P1-6.

---

## Correct fail-closed (do not “fix”)

- `gates.ts`: `not-evaluated` / empty proof cannot `gatePassed`; `deriveGates` maps
  unevaluated stages correctly.
- `loadJudgement`: missing/empty-unusable registry, bad signature, and binding failures
  all demote to `unusable`; only `attested` feeds current results.
- `DEFAULT_TARGET_BUILD_ID` unset → `null`: binding requires non-null target when facts
  are honest; blocks attested current results (by design until a content-hash target id
  is derived — do **not** set a static tag).
- Evidence: catalog write-once + id binding; serve path uses `getBoundCatalogEntry` +
  `getVerifiedEvidence` re-hash.
- Contract revision objects: content-addressed id + `onlyIf` write-once + semantic
  re-bind on read (aside from incomplete gate-set hole P0-1).
- Fixture judgement keys: rejected unless `DEV_SEED=enabled`.
- Unsigned RunRecord: may render; cannot earn trusted second column without pinned
  verified judgement.
- CONTINUE destination / selection-count-as-text fabrication: fixed in expander.

---

## Residual / documented (not new defects)

- `HUMAN_REVIEW_MODE` is recorded and never gates seal — already in STATE-OF-PLAY as
  unimplemented.
- Arm configs may ship empty `JUDGEMENT_KEY_REGISTRY` — still fail-closes on verify
  (unknown `keyId`), not a fail-open.
- Browser execution never succeeded end-to-end from inside the service (config/Access);
  first real proof needs a deployed run against a real survey.
- Extraction 3/226 both-pass overlap and 155-vs-226 run variance: diagnose before
  trusting sealed contracts (related to P1-4).

---

## Test gaps to add with the fixes

- `sealContract` / `getContractRevision` refuse `{}` and 3-of-4 gate maps
- Serve-path re-hash for report artifacts (mutation: overwrite version bytes)
- Envelope `targetBuildId: null` must win over a record-side build id
- Case not closed when walk did not select that case’s answer
- `completion.test` stays incomplete when all verifier decisions are `insufficient`
- Merge expansion cardinality mismatch → dispute or union (negative fixture)

---

## Sources

- Manual review of critical paths, 5 Aug 2026
- Pipeline-stage defect pass: agent `591c50b6-7f28-4958-96d1-317aefe4b6fe`
- Trust/gates defect pass: agent `095ce82f-ee0d-4ca0-a609-7914557b4023`
- Prior context: `docs/SESSION-HANDOFF-5AUG.md`, `docs/STATE-OF-PLAY.md`, `CLAUDE.md`
