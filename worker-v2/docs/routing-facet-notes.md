# Routing facet vs. compiler gate — closing §7a of `judge-evidence-gap-notes.md`

Working notes. Written as the work went, so a lost session does not lose the ground truth.

## 1. THE GROUND TRUTH (established by reading, 8 Aug)

### What the judge's compiler recognises

`pipeline/judge/lib/compile.mjs`, rule `R-ROUTE-1`:

    if (o.category !== 'branch-outcome') return null;

`o.category` is NOT the local checklist's category. It is the bound projection field
`contract-binding.mjs` maps from the signed contract item:

    category  <-  contract.items[].type          (SIGNED_CARRIER, contract-binding.mjs:88)

`branch-outcome` is a **v1 checklist category**. Its only other appearances in the judge are
comments and the v1 selftest fixtures (`pipeline/judge/selftest/fixtures/make-v2-fixtures.mjs`
uses `category: 'branch-outcome'` — that fixture writes a v1-shaped checklist directly, which
is why the selftests pass while every real v2 run does not).

`R-ROUTE-2` does **not** gate on category at all; it keys on a very specific sentence form.
So exactly one rule is affected.

### What v2 revisions actually emit

    contract.items[].type  <-  r.facet           (worker-v2/shared/v2-record.mjs:202,
                                                  contractItemFromRequirement)
    ScopedRequirement.facet <- primary.construct (worker-v2/src/extract/merge.ts:168)
    RawRequirement.construct <- str(raw["construct"]).toLowerCase() || "other"
                                                 (worker-v2/src/extract/coerce.ts:62)

So the facet is the extraction's **construct class**, lowercased free text, drawn by the
model from two prompt vocabularies:

* pass B, per-chunk obligations — `CONSTRUCT_CLASSES` (`worker-v2/src/extract/types.ts:62`):
  `question, option-list, skip-rule, terminate, validation, piping, carry-forward,
  calculation, randomization, loop, instruction`
* pass A, global rules — `worker-v2/src/extract/prompts.ts:112`:
  `instruction|validation|navigation|order|terminate|randomization|piping|carry-forward|
  calculation|loop|option-list|question`

Neither list contains `branch-outcome`. **Routing is spelled `skip-rule` (pass B),
`navigation` (pass A), `terminate` (both), and `routing` in the fixtures**
(`worker-v2/tools/fixtures/v2-fixture.mjs:101`, `d24-screen-identity.test.mjs`,
`d19-route-binding.test.mjs`).

### The producer already owns a facet→route equivalence class

`worker-v2/src/extract/expand.ts:95` — `FACET_TO_CASE_KIND`:

    "skip-rule": "route",
    "branch-outcome": "route",
    routing: "route",
    terminate: "route",
    "option-list": "option-set",
    "option-set": "option-set",
    copy: "copy",
    question: "rendered-state",
    instruction: "rendered-state",
    validation: "boundary",

This is what decides a sealed `FacetInstance`'s `case.kind`, i.e. which requirements get a
route execution case at all. It already lists `branch-outcome` **and** `routing` as members
of the same class — the producer considers them synonyms. `navigation` and `order` are NOT
in it, so a pass-A `navigation` requirement is expanded as `rendered-state` today. That is a
separate producer-side gap; widening the judge past the producer would make the judge compile
a route expectation for a requirement whose sealed case is not a route, so this work does not
do it. Noted, not closed.

## 2. IS THE FACET SIGNED?

Yes — and this is what decides the fix.

* `semanticContractBody` (`worker-v2/shared/v2-record.mjs:85`) hashes the whole revision body
  minus `sealedAt` / `contractRevisionId` / `extraction.reviewedAt`. `requirements[].facet` is
  inside that digest. The revision id **is** the digest.
* `pipeline/judge/lib/authority.mjs` recomputes id + hash from the stored bytes and only then
  calls `projectV2ToLegacy` (line ~522).

So `r.facet` is signed content and **must not be changed**: rewriting the producer to emit
`branch-outcome` changes every revision id and hash, and re-signing a past run changes what
that run meant.

`contract.items[].type`, by contrast, is produced by `contractItemFromRequirement` — a
**read-time projection** applied AFTER integrity verification. Nothing hashes it.

## 3. THE DECISION

**The v2 facet vocabulary is canonical. The judge's gate learns it, via an explicit,
documented, tested mapping on the judge side.**

Why:

1. The facet is signed; the gate is not. Prefer the change that does not alter what gets
   signed.
2. Both vocabularies are legitimate — `branch-outcome` is the v1 checklist's category name,
   `skip-rule`/`routing`/`terminate` are the v2 extraction's construct names. Neither is
   wrong; they are unaligned. So: an explicit mapping, not a rename.
3. The mapping goes where the judge reads, NOT into `contractItemFromRequirement`. Rewriting
   `type` in the projection would silently change the value the report renders and the value
   the record publishes as the item's type, for the sake of one rule's gate. The projection
   should keep publishing the signed facet verbatim.
4. The equivalence class is not invented here — it is the producer's own
   `FACET_TO_CASE_KIND` route class, and a drift test pins the two together.

New module: `pipeline/judge/lib/facet-vocab.mjs`. `R-ROUTE-1` calls `isRouteFacet(o.category)`
instead of `=== 'branch-outcome'`. `null` (unbound) is still refused, so the D3 fail-closed
property is unchanged.

## 4. STATUS LOG

* [x] ground truth established (§1, §2)
* [x] decision made (§3)
* [x] `pipeline/judge/lib/facet-vocab.mjs` written
* [x] `R-ROUTE-1` gate switched to `isRouteFacet(o.category)`
* [x] `FACET_TO_CASE_KIND` exported from `expand.ts`; drift test asserts SET EQUALITY
* [x] `worker-v2/tools/tests/d26-routing-facet.test.mjs` — 10 cases, both arms end to end
* [x] registered in `worker-v2/tools/test.mjs`
* [x] §7a of `judge-evidence-gap-notes.md` marked closed; D25's header re-pointed at D26
* [x] suite 271/271 → **281/281**; judge selftests **136/136** unchanged; `tsc --noEmit` clean
      at repo root and in worker-v2

## 5. WHAT THE END-TO-END PROOF ACTUALLY RUNS

One sealed revision, two `routing`-facet requirements over the SAME question:

    req_d26route01  code 1 "A watering can"  at Q1 -> Q2   (the survey does this)
    req_d26route02  code 2 "The kitchen tap" at Q1 -> Q3   (the survey goes to Q2 — the defect)

Two walks captured by the REAL `capturePathObservation`, record assembled and signed by the
REAL assembler, judged by the REAL `mintJudgement`, published by the REAL report path. Result:
`byVerdict.pass = 1`, `byVerdict.fail = 1`; the failing row carries
`predicateReason: ROUTE_DESTINATION_MISMATCH`, non-empty `evidenceRefs`, a counter-witness, and
publishes as `FAIL` in the register's `re-derived` column.

The route half of the projection is confirmed on that same real evidence: the published
`routeTable` has 2 admitted sessions, 0 quarantined, one row per distinct answer at Q1, each
destination witness carrying `proofKind: "route-edge"`; the passing row's attestation reports
`allVerified: true` with `hashAuthority: "signed-run-record"`. Label corroboration is exercised
too — `corroboration.level: "confirmed"`, `renderedAtTrigger: ["A watering can"]` — so the
document's wording was checked against the captured inventory at that code while the CODE
stayed the identity.

### Measured against the old gate

The one line was reverted and the file re-run: **7 of 10 cases go red**. Both compiles return
`null`, both predicate reasons are `null`, the register publishes both rows as `PENDING`, and
the route table has ZERO rows — not merely undecided. That last one is the second-order effect
worth recording: `documentScreens` builds the capture vocabulary by walking COMPILED
expectations, so with no route expectation there is no `Q1`/`Q2` in the vocabulary, every
captured screen falls back to a signature token, and not one edge can be built from walks that
projected perfectly well. **A closed gate did not only silence the verdict; it blinded the
evidence projection that feeds it.**

## 6. WHAT REMAINS (not in scope here, named so it is not lost)

1. **`navigation` / `order` are unclassified by the producer.** They are in the pass-A prompt
   vocabulary (`prompts.ts:112`) but absent from `FACET_TO_CASE_KIND`, so a pass-A global
   routing rule is expanded as `rendered-state` and gets no route case sealed. Widening the
   judge alone would be worse than the bug: it would compile a route expectation for a
   requirement the run was never driven to exercise. Fix belongs on the producer, and the drift
   test will force the judge to be updated with it.
2. **§7b (aliased screens) is still open** — `WELCOME`/`CLOSING`/`SCREENOUT` never enter the
   projection's vocabulary. Unrelated to routing, deliberately untouched.
3. `R-ROUTE-2` does not gate on the facet at all; it keys on one sentence form. Left as is.
