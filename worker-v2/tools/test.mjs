#!/usr/bin/env node
/**
 * worker-v2 regression suite.
 *
 *   node tools/test.mjs [substring-filter]
 *
 * Every test here corresponds to a defect from the GPT review and FAILS on the code as it
 * was before the fix. It runs the real `src/**` modules (bundled by tools/testkit.mjs)
 * against an in-memory R2 with real etag/onlyIf semantics — no live Worker, no network.
 *
 * `tools/smoke.mjs` remains the integration proof against a live `wrangler dev`; this is
 * the proof that each specific defect is closed and stays closed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXACT_TEST_NAMES_STDIN_FLAG,
  parseTestSelection,
  selectRegistryCases,
} from "./mutate-runner.mjs";
import { cleanupBundle, registry } from "./testkit.mjs";

const FILES = [
  "./tests/d2-judgement.test.mjs",
  "./tests/d11-gates.test.mjs",
  "./tests/d12-renderable.test.mjs",
  "./tests/d13-recovery.test.mjs",
  "./tests/d14-integrity.test.mjs",
  "./tests/advisory.test.mjs",
  "./tests/d4-contract-identity.test.mjs",
  "./tests/d14b-publication.test.mjs",
  // Cross-seam: worker-v2 ↔ pipeline/report, asserted on the bytes that were PUBLISHED
  // rather than on any component's summary of itself. Every other file above tests one
  // component refusing bad input; this one tests the system accepting good input, which
  // is the direction nothing was checking.
  "./tests/seam.test.mjs",
  // THE ROOT DEFECT of round 3. Not a fixture: it assembles a real RunRecordV2 from the
  // real t1-easy run and drives it through the real judge, the real store and the real
  // report path, asserting on the PUBLISHED BYTES.
  "./tests/d1-acceptance.test.mjs",
  // D15 — the executor's walks reaching the observation ledger, and the predicate that is
  // the ONLY route to `verified`. The negative half is the load-bearing half: it proves a
  // hand-written `verified` is overruled by the artifact the observation itself cites.
  "./tests/d15-observation-ledger.test.mjs",
  // D16 — the SUPPLY side of the same chain: the deterministic expander materializing the
  // typed expectations D15's predicate is keyed on, and refusing to fabricate the ones the
  // document does not state. Every NEGATIVE case here is something the expander could have
  // emitted and does not; `tools/mutate-expander.mjs` is the evidence they can fail.
  "./tests/d16-typed-cases.test.mjs",
  // D17 — the routing graph compiled from the SEALED contract revision. The graph-S / graph-D
  // comparison the document-processing-playbook §6 describes; this is the D-side compiler.
  "./tests/d17-structure-model.test.mjs",
  // D18 — the typed-case enrichment MUST deliberately drive documented answers. This is the
  // test that can fail: the enrichment was deleted once and the suite stayed green.
  "./tests/d18-typed-enrichment.test.mjs",
  // D20 — the LIVE materialization path must not DESTROY a multi-select gating selection.
  // The union rule was written once in a helper the pipeline then stopped calling, so the
  // safety property was documented on dead code while the live path overwrote the list.
  // These bind to `materializeCasePaths`, the function `planStage` actually runs.
  // Evidence they can fail: `tools/mutate-plan.mjs`.
  "./tests/d20-multiselect-union.test.mjs",
  // D19 — the verifier must read the step that happened on the CASE'S OWN question. Picking
  // the first step that took the documented answer read an earlier "Yes" and turned a healthy
  // site into a defect claim (and a real defect into a pass) through the trusted lane.
  "./tests/d19-route-binding.test.mjs",
  // D21 — the pass-B fan-out does not fit in ONE Workflow step, so it occupies as many as
  // the document needs. Proves: a fan-out bigger than one step's budget finishes across
  // steps or stops with a NAMED reason (never a silent truncation), a retry re-issues only
  // what never landed, and resume still carries everything it used to.
  // Evidence they can fail: `tools/mutate-passb.mjs`.
  "./tests/d21-passb-waves.test.mjs",
  // Strict, all-or-nothing provider decoding and exact retained-unit authority for Pass B.
  // Evidence they can fail: `tools/mutate-passb.mjs`.
  "./tests/passb-strict-integrity.test.mjs",
  // D22 — the SAME defect class on the Grok leg: pass A splits a large document into SERIAL
  // windows inside one step, with no per-window persistence, so a timeout re-buys every
  // window. It does not bite the small fixture, which is why it needed closing before a real
  // client questionnaire arrived. Evidence they can fail: `tools/mutate-passa.mjs`.
  "./tests/d22-passa-waves.test.mjs",
  "./tests/d22-passa-split-oversized.test.mjs",
  "./tests/passa-cross-window-synthesis.test.mjs",
  "./tests/passa-primary-persistence.test.mjs",
  "./tests/cross-window-coverage-wire.test.mjs",
  "./tests/primary-grounding-coverage-wire.test.mjs",
  "./tests/passa-completion-shape.test.mjs",
  "./tests/passa-final-validity.test.mjs",
  // Item-level grounding degradation and Gemini budget mode.
  "./tests/grounding-degradation.test.mjs",
  // Slice-level terminality derives from durable window terminality.
  // v30 regression: terminal:false on the artifact must produce terminalFailure:false on the slice.
  "./tests/slice-terminality.test.mjs",
  // Reader-writer round-trip: every writer-producible artifact variant (ok, failed-retryable,
  // failed-terminal, degraded, wire-ceiling) must read back without becoming kind:"invalid".
  // v31 regression: Gemini-primary receipt-1 was rejected by the Grok-only coherence validator.
  // Pinned fixture: the real v31 artifact bytes from production R2.
  "./tests/reader-writer-roundtrip.test.mjs",
  // Terminal extraction refusals report durable operational evidence without inventing QA claims.
  // Malformed or missing receipts must leave no report pointer.
  "./tests/terminal-failure-report.test.mjs",
  // Real-link artifacts are permanent even under the former delete/age variables.
  "./tests/permanent-run-retention.test.mjs",
  // D23 — the verifier's structural floor may DEMOTE, but it may not author a VERDICT out of
  // the producer's own `error`/`contradiction` payload keys. Dormant until model-observations
  // land, at which point every failed model call would have become a defect claim about the
  // client's survey. Evidence they can fail: `tools/mutate-payload-trust.mjs`.
  "./tests/d23-payload-trust.test.mjs",
  // D24 — the verifier must be able to BIND A SCREEN TO ITS QUESTION. Screen identity read
  // rendered text alone; the instrument under test prints no question ids, so every route and
  // boundary case exited at binding and the run produced ZERO verdicts — while `page-script.ts`
  // had been capturing the ids in every control's `name`/`id` the whole time. The positive half
  // is the null-run-to-measurable proof; the fail-closed half is what stops the extra reading
  // from buying a guess; the degradation half pins the convention as a NAMED limitation.
  "./tests/d24-screen-identity.test.mjs",
  // D25 — the JUDGE could not read v2 evidence at all, so the report's authoritative column was
  // empty however well a run went. Two stops: every walk's artifactRef flattened to the same
  // basename (duplicate signed manifest -> unverified authority -> NO judgement minted), and a
  // `PathObservation` is not the `evidence[]` capture spine every judge module reads, so it was
  // dropped in silence. The end-to-end half is the bar: a NON-ZERO assessed row count.
  "./tests/d25-v2-judge-evidence.test.mjs",
  // D26 — the last stop between a v2 run and a ROUTING verdict. `R-ROUTE-1` gated on the v1
  // checklist category `branch-outcome`; every v2 revision spells that facet `routing` /
  // `skip-rule` / `terminate`, so no routing requirement ever compiled to a typed expectation
  // and routing defects — much of what this product exists to catch — were structurally
  // invisible in the authoritative column. The facet is SIGNED, so the judge learns the
  // vocabulary rather than the producer being re-spelled; the mapping is pinned set-equal to
  // the producer's own route class. The end-to-end half proves BOTH ARMS on one real run.
  "./tests/d26-routing-facet.test.mjs",
  // D27 — THE FIRST REAL END-TO-END RUN'S FAILURE. A rating grid states one mandate once per
  // row, so two distinct requirements agreed on statement, quote, scope, quantifier and
  // construct — the only five fields identity was derived from — and collapsed onto one
  // `requirementLineageId`/`requirementVersionId`. The expander minted byte-identical facet
  // instances from them and planning refused the sealed revision. Two DISTINCT requirements
  // colliding on a weak id, not one duplicated by a merge, so the fix is a stronger id and
  // the widening is COLLISION-SCOPED: every already-unique id is byte-stable, because a
  // revision id is the hash of a body containing them.
  "./tests/d27-identity-collision.test.mjs",
  // D28 — WHAT A JUDGEMENT BINDS TO. `DEFAULT_TARGET_BUILD_ID` is unset on the deployed
  // service, so `report/build.ts` resolved no target identity, every judgement failed its
  // `target-build` check, and EVERY report was marked diagnostic-only with no rerun able to
  // differ. The identity is now derived from the content of the screens the run actually
  // captured. The two load-bearing halves: a run that captured NOTHING stays unbindable with
  // its existing named reason (hashing the empty set would certify a run that saw nothing),
  // and a judgement bound to the DERIVED id really does become current results — the only
  // test that fails if the resolver is ever disconnected from the binding facts.
  "./tests/d28-target-identity.test.mjs",
  // THE HEARTBEAT NOTE — the run's own words for what it is doing, surviving the projection.
  // `readHeartbeat` returned the note and `projectStatus` took only the timestamp, so the note
  // died at the contract and the tracker had nothing to say through the ~10-minute extraction.
  // The second test is the guard in the other direction: absent → the field is OMITTED, so a
  // run without a note is byte-identical to the shape that shipped before it existed.
  "./tests/heartbeat-note.test.mjs",
  // Durable, closed, privacy-safe questionnaire-reading visibility. Counterexamples
  // deliberately corrupt reconciled counts and add an undeclared field.
  "./tests/document-reading-visibility.test.mjs",
  // D29 — the last two ways a confident defect could be reported about a HEALTHY survey: a
  // lost advance-timeout race read as a rejection (four states, delta witness, control
  // attribution, keyed on `advanced` and not on `blocked`), and a prose back-reference read as
  // the screen's own identity. Half the file is counterweights: every new refusal is paired
  // with the case that must still reach a verdict.
  "./tests/d29-fabrication-paths.test.mjs",
  // THE ITERATION LOOP's two tools (docs/ITERATION-LOOP.md §6): tools/runsum.mjs (scoreboard) and
  // tools/runcheck.mjs (invariants I1–I7). The negative half is the point — every invariant has a
  // corrupted in-memory copy of pipeline/runs/synthetic-demo proving it goes red, including the
  // two failures a naive version could never see: a coverage counter that still sums to the
  // denominator while a row has moved bucket, and a reason vocabulary checked live instead of frozen.
  "./tests/runtools.test.mjs",
  // WHY A FAILED RUN FAILED, reaching a reader. The first real run died with
  // `reasonCode: "workflow-error"` and an empty `error` while Cloudflare's Workflow API had
  // the exact sentence on file; the cause is now recorded inside the step closure — where
  // it still exists, and where the step's name is known — and projected, structured and
  // sanitised, onto both read surfaces. The propagation assertions are the load-bearing
  // ones: recording is additive and the original error still errors the instance.
  "./tests/failure-cause.test.mjs",
  // D30 — THE FURTHEST A RUN HAS EVER GOT, AND WHAT STOPPED IT. `verify-observations` died with
  // `Too many API requests by single Worker invocation` on all three attempts — attempts 2 and 3
  // in 0 seconds each, which is the proof that a Workflow's consecutive steps AND its step
  // retries share one invocation's subrequest budget. The cost was R2, not the browser:
  // `listCatalog` reads one object PER CATALOGUE ENTRY (1,707 in that run) and both
  // `project-observations` and `verify-observations` paid it back to back. Verification now
  // reads the cited artifacts BY KEY. The load-bearing test is an INVARIANCE, not a ceiling:
  // 40x the catalogue must cost identical R2 operations, which no catalogue scan can satisfy.
  // The second suite re-proves the integrity chain on the cheaper path — a repointed or missing
  // entry must still be `insufficient`, never a pass.
  "./tests/d30-subrequest-budget.test.mjs",
  // D31 — the two numbers `v2r_01kzfb6py8pbxznqv022p2qkhb` published. Its exercised gate put
  // the planner's OWN delegated decisions ("select: []", "source: default:navigator-discretion")
  // in the denominator, so walks that drove the survey to its terminal screen were disqualified
  // for not obeying instructions that instructed nothing; and `walks-blocked-by-site` was emitted
  // from "cases are still pending", publishing an accusation against a healthy customer survey
  // that had refused NOTHING. Both halves are replayed over the run's REAL 46 WalkRecords and its
  // REAL plan. The counterweights are the load-bearing half — the hard floor is untouched, an
  // unapplied sealed stimulus still closes nothing, and a survey that genuinely blocks IS still
  // named. Evidence they can fail: `tools/mutate-exercised-gate.mjs`.
  "./tests/d31-exercised-gate.test.mjs",
  // D32 — the OTHER thing `v2r_01kzfb6py8pbxznqv022p2qkhb` published: three of its eight
  // "exercised" cases carry evidence FROM THE WRONG QUESTION. The survey prints no question ids
  // in its text and the planner emitted 275 of 286 decisions with an empty `select`, so binding
  // ran on containment-tolerant option-label overlap alone — a Q7 decision wanting "Can't
  // remember" was spent on an earlier screen offering "Don't know / can't remember", and the
  // real Q7 then took the OPPOSITE branch under `navigator-default` while the case closed as
  // exercised. Tightening the matcher cannot fix it (one mis-binding matched "Yes" to "Yes"
  // exactly), so the plan now stamps the document's WORDING on every decision and the driver
  // binds on identity or REFUSES, counted. Half the file is counterweights: a screen the wording
  // names must still bind when the option it wants is MISSING, or the defect this product
  // exists to report becomes invisible. Evidence they can fail: `tools/mutate-binding.mjs`.
  "./tests/d32-decision-identity.test.mjs",
  // D33 — THE RECORD MUST CARRY THE DEFECTS THE RUN FOUND. Run 5 derived two real fail
  // verdicts and signed `claims: []` and `blockers: []` over them, because the assembler took
  // claims as a PARAMETER and its one caller passed a literal empty array. Claims and blockers
  // are now DERIVED inside the assembler, so there is no wire left to forget. The tests drive
  // the real aggregator -> real stage -> stored bytes, because the .mjs import is `@ts-ignore`d
  // and `tsc` therefore cannot see that seam at all. Half the file is counterweights: a passing
  // run, an insufficient decision, a cursor-blocked case and an empty ledger must each produce
  // NOTHING. Evidence they can fail: `tools/mutate-claims.mjs`.
  "./tests/d33-claims-wire.test.mjs",
  // D34 — THE READER'S HALF OF THE SAME RUN, AND WHAT IT COST TO PUBLISH. Building run 5's
  // report paid the D30 fan-out TWICE (list the catalogue: 1 LIST + 1 GET per entry; then
  // re-hash every entry: 1 more GET each) — ~3,400 storage reads for one page, growing with
  // survey size, covered only by a raised `limits.subrequests` ceiling. The catalogue is now
  // enumerated from the run's own ATTESTED record (re-bound entry by entry, which is a hash
  // and not a fetch) and the blob re-hash is spent only on artifacts the page cites. Proven
  // on BOTH axes the old code grew along — store size and record size — as an EQUALITY across
  // a 40x change, which nothing that still scans can satisfy. Half the file is the discipline
  // that had to survive: repointed bytes, absent bytes and an entry whose citation binding
  // does not recompute must each still fail closed, and nothing un-re-hashed may be handed a
  // link or counted as verified.
  "./tests/d34-report-fanout.test.mjs",
  // D35 — THE DRIVER AND THE VERIFIER MUST ANSWER "WHICH QUESTION IS THIS SCREEN?" THE SAME WAY.
  // The driver was rebuilt around the document's WORDING after option-label binding produced
  // real confident-wrong answers; the verifier went on reading text tokens and markup and never
  // looked at wording, so it could accept a screen the walker had refused and was blind on every
  // survey that prints no ids. Wording is now a third witness on the identity union, and the
  // walker's REFUSALS are read as a veto while its bindings still are not. The load-bearing half
  // is the fail-closed half: a tie refuses, a conflict refuses, and a destination identified by
  // wording alone may not accuse — plus both of run 5's real findings, re-produced.
  // Evidence they can fail: `tools/mutate-verifier-identity.mjs`.
  "./tests/d35-wording-identity.test.mjs",
  // D36 — A PLANNED STIMULUS MUST BE SOMETHING A BROWSER CAN PERFORM, OR BE COUNTED AS MISSING.
  // Three ways a walk carried an instruction it could not execute: a boundary probe whose
  // `text_entry.value` was the LITERAL string "<exactly 500 characters>" (typed verbatim: a
  // 24-character answer to a 500-character question, reported as a pass); a route case naming
  // only an answer CODE, leaving the driver nothing to click while the case still closed; and
  // 48 unassigned cases all warned under one cause when they have four, 21 of them misfiled.
  // Evidence they can fail: `tools/mutate-plan.mjs`.
  "./tests/d36-plan-stimulus.test.mjs",
  // D37 — THE READER'S SIDE OF RUN 5. Two requirements were settled as FAILING — a skip rule
  // landing on the wrong question, a boundary the survey accepted that the document says it
  // must reject — and the published page opened with "there is nothing on this page you
  // should act on", said "Programming problems: none found", and printed six em dashes where
  // its counts go. Three causes, each guarded: every customer number hung off a re-derived
  // column that had not run; the lane's words come from `claims`, signed empty over those
  // fails; and "none found" was printed with no denominator, so 2-of-227 read like 227 clean.
  // THE FIRST SUITE IS THE COUNTERWEIGHT and is the load-bearing half — a lane that always
  // showed would pass every visibility test here and destroy the product. Evidence they can
  // fail: `tools/mutate-report-defects.mjs`.
  "./tests/d37-defect-visibility.test.mjs",
  // D38 — THE BROWSER LAYER ANSWERING CONFIDENTLY AND WRONGLY, both halves measured against a
  // live survey. A grid's columns were read one place to the right (a `<th scope="row">`
  // collected as a column, then a SILENT +1 shift), so a documented "Somewhat agree" clicked
  // "Strongly agree" while a documented "Strongly agree" fell through to `cells[0]` and was
  // accidentally right. And the navigator's `visible && !disabled` default made an eleven-point
  // NPS score STRUCTURALLY unreachable — every 0-10 radio is `opacity:0`, so 2 of 2 walks
  // answered "Don't know" and the coverage report called the screen answered. The reader's own
  // half lives in a string this suite cannot execute and is proved in a real browser; these are
  // the driver's: operable-vs-visible in both directions, the fallback that hid the shift now
  // named, and the reader's limitations reaching the artifact.
  "./tests/d38-answerable-controls.test.mjs",
  // D39 — A PASS IS A CLAIM TOO. 0.2 made the route `violated` arm demand a MARKUP witness
  // because prose back-references other questions, and scoped that to the accusing arm; the
  // `satisfied` arm went on reading the plain union, so a screen that merely printed "as you said
  // in Q9…" minted a pass for a route that had landed somewhere else entirely. A false PASS does
  // not just miss the defect, it CERTIFIES there is none. Plus the terminal destination, which was
  // unverifiable by construction until the walker began typing its ending — decidable here only
  // when that ending is bound to the screen THIS answer reached and this stage's own reading of
  // the same bytes agrees the screen is a dead end.
  "./tests/d39-pass-witness-and-terminal.test.mjs",
  // D40 — TWO WAYS A RUN'S OWN RECORD LIED ABOUT ITSELF, both measured on 8 Aug. The sweeper
  // treated an operator's deliberate TERMINATION as a recoverable fault and resurrected a run a
  // human had just killed; it restarted and re-created instances on indirect evidence, erasing
  // one run's forensic record and re-spending money on another; and when cron returned from a
  // 140-minute silence it acted on every stale observation at once, because the two-strike
  // protocol had a minimum separation and no maximum staleness. Separately, `targetBuildId` was
  // null on every envelope, so `assemble-record.mjs` stamped null into every signed record and
  // no record could state WHAT WAS TESTED — which is why run 4 (5 pass / 0 fail) and run 5
  // (2 pass / 2 fail) on the same document and the same survey could not be told apart.
  "./tests/d40-sweeper-and-target-identity.test.mjs",
  // D41 — THE SIGNED RECORD CERTIFIED THE EMPTIEST POSSIBLE VIEW OF EVERY RUN. It is assembled
  // and Ed25519-signed BEFORE the judgement stage; run 4 was signed at 02:28:03 and
  // `mint-judgement` then failed with EVIDENCE_NAME_COLLISION at 02:29:57, a fact that lived
  // only in stdout. The order is not the bug — `mintJudgement` binds to the record's own
  // payload hash, so a record carrying the judgement's outcome would contain a hash of itself —
  // but nothing was signed AFTERWARDS, so a verified signature certified a document that could
  // not say the second opinion had never been obtained. A second revision now supersedes the
  // first, and the first's bytes stay valid and addressable (supersede, never mutate). Also
  // here: the guard that a record with fail verdicts must carry claims (refused at the write
  // boundary), and the four lists the assembler declared empty while their sources sat in the
  // inputs it already held — attempts, ambiguities, taxonomy gaps and the tested identity.
  // Evidence they can fail: `tools/mutate-closure.mjs`.
  "./tests/d41-signed-closure.test.mjs",
  // D42 — A STALL THAT PRODUCED A LARGE NUMBER AND WAS READ AS SUCCESS. Four medical surveys
  // reported "38 observations"; all four walks were on SCREEN 1 OF 5 and the 38 were 38 captures
  // of the same screen. Cause: the control classifier read only `text` and `label`, and SurveyJS
  // draws navigation as `<input type=button value=Next>` — no text, no <label>, so BOTH inputs
  // were empty on every screen ever read and every button classified `other`. Screen 1 survived
  // by ACCIDENT (one candidate, so the elimination fallback caught it); screen 2 adds Previous,
  // the two tie, and the walk stops. Compounding it: `outcome: "no-advance-control"` was ALSO
  // what a finished survey produced, so "reached the end" and "never got in" were one value; the
  // reader's `counts.textInputs` disagreed with its own control inventory on every screen with a
  // number field; and the walker's filler "QA-PROBE" typed into `<input type=number>` had two of
  // the four surveys reporting `blocked` — a working survey recorded as rejecting an answer.
  // The DOM half is proved in a real browser: `node tools/live-walk.mjs` drives the production
  // `walkPath` against the live fleet and `tools/fixtures/endings/*.html`.
  // Evidence they can fail: `tools/mutate-endings.mjs`.
  "./tests/d42-advance-control-and-endings.test.mjs",
  // D43 — D42 TYPED THE ENDING AND NOTHING CARRIED IT. Deployed `e821ecd7`, run
  // `v2r_01kzggtye653abaa36sxeg23yd`: all 41 observations show `screensAdvanced: 5` (D42's fix
  // working) and all 41 show `outcome: "no-advance-control"` and nothing else — the one value
  // that covers BOTH "the survey ended" and "we never got in". The walker had classified every
  // one of them; `execute-batch.ts#walkRecord` dropped the ending on its way into the walk
  // ledger, and `project-observations.ts` dropped it again — along with `blockedSteps`, the
  // exercised gate's own denominator, the reader's named limitations and what the walk never
  // bound. Both hops now carry them verbatim, optional stays optional, and `unclassified` is
  // never folded into `completed` at either one. The last suite is the counterweight and the
  // load-bearing half: the payload is READABLE, not evidence, so an `ending` that contradicts
  // its artifact must move no verdict in either direction — the verifier re-reads the bytes.
  // Evidence they can fail: `tools/mutate-projection-carry.mjs`.
  "./tests/d43-walk-facts-reach-the-record.test.mjs",
  // D44 — THE WALKER'S FILLER WAS A BOUNDARY PROBE, AND HALF THE INPUT TYPES WERE NEVER FILLED.
  // MEASURED on the six live branching targets: `defaultTextFor` answered a numeric control with
  // the LOWEST legal value (`1`, raised to `min`), which is the one value a screener cuts at.
  // s2-screener terminated the walk on its documented under-18 rule after TWO screens of ten
  // ("What is your age?" -> 1), s6-kitchen-sink on "fewer than 2 years" (-> 1) after three, and
  // the clean/flawed experiment that depended on s2 returned 0 of 3 seeded defects for that
  // reason alone. The filler is now the midpoint of the range THE SITE declares, snapped to its
  // own step grid — and the honest counterexample is asserted with it: s2's S4 is screened out by
  // the midpoint too, because no constant passes every screener. Second half, measured in Chrome:
  // `tel`/`url`/`search` were never filled; `range`/`date`/`time`/`month`/`week`/`datetime-local`/
  // `color` were never filled AND cannot be typed into (inserted text is discarded, a range
  // ignores keystrokes) so they are SET; `email` was filled with "QA-PROBE", which sticks in
  // `.value` and then fails the control's own constraint validation. `<input>` with no type was
  // never a gap — it reflects `type === "text"`. The load-bearing half is the counterweight: a
  // password is REFUSED and a file input CANNOT be satisfied, both with `ok: false`, both named
  // on the step and lifted to the walk, and a stall on one no longer reads as a normal ending.
  // The DOM half is proved in a real browser: `node tools/live-walk.mjs` over the six live
  // branching targets, plus the data:-URL fixtures in `tools/probe-input-types.mjs`.
  // Evidence they can fail: `tools/mutate-input-coverage.mjs`.
  "./tests/d44-input-type-coverage.test.mjs",
  // D45 — THE OPTION-SET PREDICATE, the first new verdict-minting path in months. ~90% of
  // checks returned `insufficient` because only `route` and `boundary` had predicates, and
  // option-set is the largest decidable bucket. The registry opened for exactly one kind and
  // the payload is minted from the DOCUMENT'S OWN QUOTE (`extract/expand.ts#mintOptionSet`),
  // corroborated by the requirement's statement — so a model chose which span to point at and
  // the document supplied the bytes that get compared. The negative half is the larger half:
  // an option list scoped to the SURVEY refuses rather than binding by proximity (a fifth of
  // real rows, three different questions all claiming code 1), and a site that WORDS an option
  // differently ("18 to 24" for "18-24") is never accused of missing it. Evidence they can
  // fail: `tools/mutate-option-set.mjs`.
  "./tests/d45-option-set.test.mjs",
  // D46 — THE FROZEN HUMAN CONTRACT SEAM. Strict JSON and exact DOCX spans feed the same
  // identity mint, floor expander, content-addressed sealer, planner and predicates as model
  // extraction, while the extraction reuse index is unreachable. The final test mutates one
  // valid authored option and proves the real verifier changes its decision over identical
  // captured survey bytes; a hash-only assertion would not prove the requirement was used.
  "./tests/d46-human-contract.test.mjs",
  // D50 â€” parser-labelled open combo-box suggestions and visible ruby readings remain
  // addressable source, but may never be sealed as an answer list. Both model merge and the
  // exact-span human path carry a reserved source role; expansion keeps a counted named gap
  // and excludes those labels from sibling corroboration.
  "./tests/d50-docx-source-roles.test.mjs",
  // D51 — arm configs used to DECLARE isolated R2 prefixes while runtime ignored the
  // declaration and wrote every experiment into production `v2/`. The binding boundary
  // now translates all operations, refuses missing/unknown topology, and is installed on
  // HTTP, core Workflow and visual child Workflow entrypoints. The list/delete half proves
  // an arm cannot even enumerate production keys. Evidence: tools/mutate-keyspace.mjs.
  "./tests/d51-arm-keyspace.test.mjs",
  // D52 — planned back-navigation and repeated sessions are counted unsupported work until
  // the browser adapter can emit receipts for them; one forward walk never means they ran.
  "./tests/d52-probe-execution-truth.test.mjs",
  // D53 — THE CONSTANT-SUM WALL, the #1 reach blocker MEASURED on the branching fleet
  // (reach baseline 2026-08-10/11, 12 targets x 2 passes): 3 of 12 walks hard-blocked at a
  // "must sum to exactly 100" allocation grid (s5-allocation Q1, s6-kitchen-sink Q6 twice),
  // gating ~24 screens. The per-control filler wrote 1 into each of 5 independent number
  // inputs, the site echoed "Values must sum to exactly 100 (current total: 5)", and the
  // recovery re-derived byte-identical values — a deterministic, terminal block. The repair
  // is a group-aware pass in `applyDecision`: detection is structural AND declared (>= 2
  // writable number inputs in one grid or name-prefix family, plus a total read from the
  // site's own instruction/question text, its validation echo, or a shared per-input max
  // corroborated by sum wording — no confident target, no action); the value is an equal
  // split snapped to each input's own step grid, remainder to the first inputs in DOM
  // order, clamped and redistributed, with unreachable totals a NAMED UnfillableControl
  // per member instead of a wrong sum. Every value carries the
  // `navigator-default:allocation-split(...)` prefix so the ending's provenance keeps
  // counting invented answers. The DOM half is proved in a real browser: FIXTURE 4 of
  // `tools/probe-input-types.mjs`, whose Next is enabled only when the engine's own sum
  // check passes. Evidence they can fail: `tools/mutate-allocation.mjs`.
  "./tests/d53-allocation-filler.test.mjs",
  // D54 — PLANNER-DRIVEN SURVIVAL HINTS, the #2 reach blocker MEASURED on the same baseline:
  // the option default's position-1 pick walked s2-clean into its documented S3 screen-out
  // ("Market research" is the disqualifying industry the plan already knew about via
  // `options[].terminates` / `model.terminals`). The plan now stamps additive stimulus —
  // per-decision `avoid_labels` + per-path `survival_hints` (`plan.ts#stampSurvivalHints`,
  // same seam as wording, BEFORE materializeCasePaths so clones inherit) — and the driver's
  // option default prefers the first answerable option matching NO avoid label, falling back
  // to today's position-1 when all are flagged. THE INVARIANT, pinned here and in the d36
  // extension: hints are INPUT, never EVIDENCE — they never enter `select` (the leak vector
  // that feeds requestedButNotOffered and the exercised gate), the steered click keeps its
  // counted `navigator-default:` provenance, and the grid/value fillers are NOT consumers.
  // Evidence they can fail: `tools/mutate-survival-hints.mjs`.
  "./tests/d54-survival-hints.test.mjs",
  // D55 — BOUNDED SCREEN-OUT RETRY, the last navigator feature of phase 2: numeric
  // screeners are STRUCTURALLY unreachable by planner hints (no numeric terminate rules
  // are mined — the pinned counterexample is s2's S4, where d44 asserts the midpoint 16
  // STAYS screened out at >= 15), so a walk with a typed `screened-out` ending reached on
  // navigator-default answers gets up to TWO deterministic re-walks with varied fillers
  // (variant 1: 25% quantile / 2nd eligible option after hint filtering; variant 2: 75% /
  // 3rd, clamped). Eligibility is narrow (never `case_action` sealed stimulus, never a
  // plan-intended `terminated_at`, never a just-triggers adjacency probe, capped at 2,
  // deadline-bounded); the pivot counter is durable BEFORE the re-walk (the hungPaths
  // pattern); every attempt gets a fresh attemptId, its own pivot-linked WalkRecord, and
  // ATTEMPT-UNIQUE artifact refs — the landing gate, because the judge's signed manifest
  // keys the catalogue by basename and a re-walk under attempt 0's refs raises
  // MANIFEST_DUPLICATE_ARTIFACT. Closure is a union across attempts through the cursor's
  // existing dedupe. Evidence they can fail: `tools/mutate-screenout-retry.mjs`.
  "./tests/d55-screenout-retry.test.mjs",
  // AXIS CLOSURE — review-run-workflow.md finding 1. The contract-reuse adopted branch
  // skipped both `phase-extracting` arms (the only writers of `completion.test = "running"`)
  // and finalize's never-closed backstop tested `=== "running"` exactly — so a reuse-adopted
  // run that hit a test-axis blocker ended durably `not-started` / reasonCode null / no
  // active marker: neither terminal nor sweepable, invisible to every resolver. Adoption now
  // marks the axis in flight inside the same durable write, and the backstop promotes ANY
  // non-terminal axis (`!isTerminalTest`) to `failed` / `test-axis-never-closed` — the belt
  // for whatever branch forgets next. The edge tests hold the other direction: a terminal
  // state or a deliberate reasonCode is never clobbered by the promotion.
  // The signed cross-surface ordering gate is mutation-proved by
  // `tools/mutate-axis-closure.mjs`.
  "./tests/axis-closure.test.mjs",
  // D47 — every current screen epoch is captured as four explicitly paired modalities: the legacy
  // screen JSON, a viewport PNG, a bounded PDF and Chrome's full accessibility tree. Exact hashes/media and
  // viewport/scroll/DPR metadata bind them; browser handles are stripped through a closed
  // projection; unavailable APIs and every node/depth/value/byte cap are named and counted.
  // The negative fixture fails all four capture surfaces independently so a silent catch makes
  // the suite red instead of turning absence into an empty tree.
  "./tests/d47-capture-ax.test.mjs",
  // D49 — screenshot pixels own visible option grouping, AX is the independent semantic
  // reader, and the DOM-derived screen projection is pairing provenance only. Fragmented HTML
  // names cannot split one visual group; duplicate visual bindings, explicit visual ambiguity,
  // and visual/AX disagreement all suppress facts with named limitations. The output is positive
  // visible membership only and has no inventory-closure or verdict surface.
  "./tests/d49-vision-reconcile.test.mjs",
  // W6 — direct DOCX formatting is neutral provenance. The explicit, versioned shop profile
  // maps only proven grey run/paragraph/cell backgrounds to programming-logic blocks; option
  // labels exclude only exact cited programming bytes with computed counts, while route and
  // terminate evidence remains intact. Evidence: tools/mutate-grey-programming-logic.mjs.
  "./tests/w6-grey-programming-logic.test.mjs",
  // W5 — sealed positive seed authority, exact alternatives census, occurrence/history
  // identity, selected alternative execution and receipt-only per-case closure.
  // Evidence these can fail: tools/mutate-w5-seeded-traversal.mjs.
  "./tests/w5-seeded-traversal.test.mjs",
  // Same-provider continuity for pass B: Flash primary, separately receipted Pro fallback,
  // exact per-model rates, bounded attempts, and plan-bound artifact/contract reuse.
  // Neither leg can impersonate the independent Grok method.
  // Evidence these can fail: tools/mutate-provider-continuity.mjs.
  "./tests/provider-continuity.test.mjs",
  // Provider cumulative spend ledger: cross-run accounting and spend enforcement.
  // Evidence these can fail: each test documents what mutation makes it fail; the negative
  // fixture proves the enforcement check is structurally capable of failing.
  "./tests/provider-spend-ledger.test.mjs",
  // Exact grok-4.5 owner-console-confirmed tier binding. Production has a flat ledger, so it
  // conservatively charges max(base,long), and every malformed/zero/mixed binding refuses
  // before Secrets Store or network I/O. Evidence: tools/mutate-grok-cost-policy.mjs.
  "./tests/grok-cost-policy.test.mjs",
  // The only authority allowed to attach a price to exact grok-4.5: a fixed, authenticated,
  // no-inference catalogue GET with a closed sanitised receipt.  It is deliberately not a
  // production config writer; operator review is a separate step.
  "./tests/grok-rate-attestation.test.mjs",
  // THE .DOCX READER — the first thing in the pipeline, and until now the only stage with no
  // test at all. `test-suite/docx-robustness/` (20 hostile documents, 99 probes) was a one-off
  // hand-run measurement: v1 = 77, Cloudflare toMarkdown = 78, deployed v2 = 87. A number
  // nothing recomputes stops being true in silence, so the score is a gate now — the TOTAL and
  // the exact IDENTITY SET of the ten probes that still fail, because a total alone lets one
  // failure swap for another. Plus the lesson that governs parser work here: the first `w:sdt`
  // dropdown fix PASSED its extraction probe and, through the real `parseDocumentedOptions`,
  // dropped one option and sealed a label the document never printed. A parser change is
  // correct when the SEAL still reads it, not when the parser test passes.
  // Evidence they can fail: `tools/mutate-docx-blocks.mjs`.
  "./tests/docx-robustness.test.mjs",
  // D56 — merged-cell inheritance, gate strengthening, ambiguity funnel, entailed over-claims.
  // The four fixes the anti-gaslight audit demands, proved on synthetic fixtures.
  "./tests/d56-merged-cell-inheritance.test.mjs",
  "./tests/bounded-source-block-jsonl.test.mjs",
  "./tests/model-input-wire-ceiling.test.mjs",
  // COMMENT REVIEWER IDENTITY IS NOT SOURCE AUTHORITY. The parser currently carries it in
  // `SourceBlock.origin`; this executable fixture proves the operator catalogue keeps the
  // comment block while withholding author/initials and counting that omission. Removing
  // the output projection makes the sentinel appear in stdout and turns this test red.
  "./tests/source-block-output-privacy.test.mjs",
  // The live watch page now exposes committed browser activity without turning transitions
  // into pages or QA coverage. The pinned loop is 44 changes across two stable screens with
  // zero credited walks; privacy sentinels cover URL userinfo/path/query/fragment, raw screen
  // and action text, errors, and W5 receipt content. A corrupt total is the negative fixture.
  "./tests/execution-activity-api.test.mjs",
  // API AUTHORITY: screen discovery comes only from the immutable walk index; every typed
  // modality is exact-bound to its catalog row, raw failure/content text cannot serialize,
  // pagination advances over walk+epoch positions, and the renderer remains network-free.
  "./tests/screens-api.test.mjs",
  // P0 fail-closed browser/progress honesty blockers: disjoint multi-question ownership,
  // occurrence-aware advancement, structural native-choice groups, ambiguous forward controls,
  // and corrupt durable progress that must never reset to empty.
  "./tests/p0-honesty-blockers.test.mjs",
  // Mutation execution is closed over exact declared guard names, and the release runbook
  // accounts for every harness separately from the shared library.
  "./tests/mutation-execution-contract.test.mjs",
  // Pass-B failure ladder: expansion envelope normalization, semantic retry with echo,
  // per-obligation salvage, continuation past terminal chunks (including the 20% rate
  // guardrail), and reason-code deduplication. Each test has a mutation anchor that
  // identifies the line whose removal turns the test red.
  "./tests/pass-b-expansion-envelope.test.mjs",
  "./tests/pass-b-semantic-retry.test.mjs",
  "./tests/pass-b-obligation-salvage.test.mjs",
  "./tests/pass-b-continuation.test.mjs",
  "./tests/pass-b-reason-codes.test.mjs",
  "./tests/pass-b-real-replay.test.mjs",
  "./tests/concurrent-pool.test.mjs",
];

export async function runVerification({
  argv = process.argv.slice(2),
  exactNamesJson,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  for (const file of FILES) await import(file);

  let selected;
  try {
    const stdinJson =
      argv.length === 1 &&
      argv[0] === EXACT_TEST_NAMES_STDIN_FLAG &&
      exactNamesJson === undefined
        ? readFileSync(0, "utf8")
        : exactNamesJson ?? "";
    const selection = parseTestSelection(argv, stdinJson);
    selected = selectRegistryCases(registry, selection);
  } catch (error) {
    cleanupBundle();
    stderr.write(`test selection failed: ${error?.code ?? "UNKNOWN"}: ${error?.message ?? "unknown error"}\n`);
    return 2;
  }

  stdout.write(`worker-v2 regression suite — ${selected.length} case(s)\n\n`);

  let failed = 0;
  let lastSuite = "";
  for (const candidate of selected) {
    if (candidate.suite !== lastSuite) {
      stdout.write(`${candidate.suite}\n`);
      lastSuite = candidate.suite;
    }
    try {
      await candidate.fn();
      stdout.write(`  PASS  ${candidate.name}\n`);
    } catch (error) {
      failed += 1;
      stdout.write(
        `  FAIL  ${candidate.name}\n        ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n        ")}\n`,
      );
    }
  }

  cleanupBundle();
  stdout.write(`\n${selected.length - failed}/${selected.length} passed, ${failed} failed\n`);
  return failed === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isMain =
  invokedPath !== null &&
  (process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath);

if (isMain) process.exit(await runVerification());
