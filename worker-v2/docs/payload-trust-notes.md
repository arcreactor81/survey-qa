# D23 — the dormant payload-trust hole in `structuralDecision`

Working notes for Phase 0.3 of `docs/DIRECTIONAL-PLAN.md` (fabrication path #5). Kept durable
because agents in this session have died to transient connection errors.

## 1. The hole, confirmed independently (this session)

`src/workflow/stages/verify-observations.ts`, `structuralDecision` (pre-fix, lines 355-364):

```ts
export function structuralDecision(o: Observation): PredicateResult | null {
  const payload = o.payload as { contradiction?: unknown; error?: unknown } | null;
  if (payload && (payload.contradiction || payload.error)) {
    return {
      outcome: "violated",                                   // → decision `contradicted`
      reason: VERIFIER_REASON.STRUCTURAL_CONTRADICTION,
      predicate: "structural",
      detail: "the observation carries its own contradiction or error payload",
    };
  }
```

- `OUTCOME_TO_DECISION` (line 166) maps `violated` → `contradicted`.
- `assemble-record.mjs:51` maps `contradicted` → case status `fail`; line 140 makes ONE such
  case fail the whole requirement. So this branch is a full, confident, client-visible defect
  claim.
- It is derived ONLY from two keys the PRODUCER wrote onto its own payload. No evidence is
  re-read. That contradicts the file's own stated rule (header lines 26-28): *"The payload is a
  POINTER. A verifier that trusted the producer's summary of itself would be certifying the
  producer's word, which is exactly the shape being avoided."*
- It runs FIRST inside `decideObservation` (line 266, `const floor = structuralDecision(o)` →
  `if (floor) return floor;`), so the artifact re-read, the sealed expectation and the predicate
  are all skipped. Nothing downstream can catch it.

## 2. Why it is dormant TODAY (verified, not assumed)

- The only production producer is `project-observations.ts:215-225`, which builds a
  `WalkProjectionPayload` with keys `pathId, attemptId, observationEvidenceId, outcome,
  outcomeDetail, screensAdvanced, steps, exercised, observedAt` — neither `contradiction` nor
  `error`.
- Repo-wide grep for `contradiction`: only the 4 hits inside `verify-observations.ts` itself,
  plus unrelated prose in `extract/merge.ts`, `report/build.ts`, and test names.
- Other observation-shaped producers checked: `tools/assembler/assemble-v2.mjs:475-481`
  (`coverageStatus/reasonCode/reasonSummary/attemptRefs/findingRefs`) and
  `tools/fixtures/v2-fixture.mjs:213,226` (`{screens,...}` / `{from,answer,observedNext}`).
  None sets either key.
- `STRUCTURAL_CONTRADICTION` has exactly two references in the whole repo, both in this file
  (registry line 114 and the branch at line 360). Nothing consumes it.

## 3. Why it must close NOW

Phase 3.3 wires model-observations. A failed model call's payload naturally carries `error`.
Every such failure would become a `contradicted` → `fail` with no predicate behind it — silently
defeating the never-`violated` invariant that is the model verifier's entire owner-approved
safety rationale.

## 4. The fix (as specified by the validator; not improvised)

- **Demote, do not delete.** The branch now yields `insufficient` with a NAMED reason. Evidence-blind
  DEMOTION stays legitimate (the no-evidence-cited arm below is untouched); evidence-blind
  PROMOTION TO A VERDICT does not.
- New closed-registry reason: `PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED`, filed under the
  `// insufficient` heading following the file's convention.
- `STRUCTURAL_CONTRADICTION` is **KEPT** in the registry, marked retired. Removing it was
  considered and rejected: the spec for 0.3 is additive ("add the reason"), and — the operative
  reason — the fidelity mutant reinstates the ORIGINAL `violated` block byte-for-byte, which is
  only the original behaviour while that entry still resolves. With it deleted the reinstated
  code would evaluate to `undefined` and the mutant would no longer be the thing it claims to
  reinstate. It now carries a one-line comment saying nothing emits it and why.
- A comment at the branch states the only acceptable way to reintroduce a producer-flagged-error
  channel: through an evidence-read predicate.
- Header lines 8 and the `structuralDecision` doc-comment updated — they asserted the floor "may
  DEMOTE a structural contradiction to `contradicted`", which is now false.

## 5. Tests / mutation

- `tools/tests/d23-payload-trust.test.mjs` (new file, no collision with d19).
- `tools/mutate-payload-trust.mjs` (new) over `tools/mutate-runner.mjs`.
- Anchors: `verify-observations.ts` is LF-only (verified: 0 CRLF), so both single- and
  multi-line anchors are safe here. Single-line anchors preferred and verified unique.

## 6. Status log

- [x] baseline captured: `node tools/test.mjs` → 217/217, `npx tsc --noEmit` clean
- [x] hole confirmed independently
- [x] fix applied to `verify-observations.ts`
- [x] **in-vivo dormancy proof**: after the src edit ALONE, tsc clean and the suite still
      217/217 — no existing test exercised the old `violated` arm, in either direction. The
      hole was genuinely dormant AND genuinely uncovered.
- [x] `tools/tests/d23-payload-trust.test.mjs` written (5 cases) + registered in `tools/test.mjs`
      (one-line append; `tools/test.mjs` mtime `2026-08-07T13:43:28.128Z` → `2026-08-07T21:42:31.666Z`,
      size 5163 → 5567, i.e. only my 5 lines — no other agent wrote to it in the window)
- [x] all 14 `tools/mutate-verifier.mjs` anchors re-verified byte-identical after the edit
      (checked by count against the edited file, before re-running the harness)
- [x] suite after: **222/222**, `npx tsc --noEmit` clean
- [x] `tools/mutate-payload-trust.mjs` run — **3/3 killed**, baseline 222/222, BOTH runner
      self-checks passed (no-op NOT killed; and the discriminating one — re-applying an
      already-applied mutant over a deliberately RED 3-failure baseline scored NOT killed).
      No BROKEN-ANCHOR, no NO-RUN, no SURVIVED.
      - M1 single-line promotion (`outcome: "insufficient"` → `"violated"`) → killed by the
        3 named never-a-verdict tests
      - M2 the ORIGINAL branch byte-for-byte (`violated` + `STRUCTURAL_CONTRADICTION`) → same 3
      - M3 branch DELETED (`if (payload && …)` → `if (false)`) → killed by 4, including the
        demoted-not-deleted test (the poisoned observation gets CERTIFIED without the branch)
- [x] `tools/mutate-verifier.mjs` re-run (the MANDATED one — its anchors live in the file I
      touched) — **14/14 killed**, no BROKEN-ANCHOR, no SURVIVED, no UNPROVABLE. The three
      arms adjacent to my edit are all still proven: the floor's no-evidence demotion, the
      hand-written-`verified` override, and the re-read.
- [x] `tools/mutate-plan.mjs` spot-check (shares `tools/test.mjs` only) — **3/3 killed**,
      confirming the additive test registration does not disturb an unrelated harness

### Harnesses NOT re-run, and why

`mutate-expander.mjs` (`src/extract/expand.ts`), `mutate-passa.mjs` and `mutate-passb.mjs`
(`pass-a.ts` / `pass-b.ts` / `extract.ts` / `run-workflow.ts`) anchor into files this change does
not touch. The only surface they share with this change is `tools/test.mjs`, whose edit is a
purely additive registration: their baselines gain 5 passing tests, which cannot move a
baseline-aware criterion that kills on NAMED new failures. `mutate-plan.mjs` was run anyway as a
spot check of exactly that reasoning.
