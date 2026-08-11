# Walker integration proposal — 11 August 2026

Status: PROPOSAL for the owner's decision. No integration implementation without owner
approval. Goes to Codex for peer review after that decision (post-work-conferral rule).
Synthesizes Codex's "Navigator integration direction" (docs/CODEX-CLAUDE-INTEGRATION-11AUG.md
§Navigator integration direction) with the layered driver-seat design that landed at `bbd5a92`,
against the measured state in the 11 Aug reach re-measure.

## Summary (one page)

**The reframe that dissolves the arbitration problem.** Codex's section opens with "if Claude
and Codex produce different walkers, retain both behind one contract." The measured state says
there are not two walkers: there is one walker (`worker-v2/src/browser/driver.ts` at `bbd5a92`)
and a vision channel that cannot walk at all — it consumes sealed capture epochs after the fact
(`worker-v2/src/vision/epoch-input.ts` re-reads catalogue entries and binds AX artifacts to
exact epoch geometry; it never holds a page). So "retain both" resolves to: put the existing
walker behind the platform-neutral navigator contract, and let vision join later as a second
*perception engine* — not a rival walker. Stage 1 is interface extraction, not arbitration.

**What integrating buys (measured).** After the navigator upgrade, all 12 fleet targets
genuinely complete, zero flake, zero variance across 2 passes. The ONLY remaining reach gap is
single-path branch/loop/piping coverage: s6 pair 13/19 each (6 screens each: the >=40
allocation branch to Q7, the per-brand Q2 loop, piped Q5 variants), s3-clean 10/14 (Q4 needs
>=3 therapies picked), s4 11/12 and 10/12 (branch screens) — ~19 screens across 5 walks. The
fix both halves independently name is the same mechanism: multiple planned walks per target
with varied multiselect widths / allocation splits / branch choices — decisions minted by the
planner, executed through the contract. That is stage 2; it needs no vision and no new engine.

**What it costs.** Stage 1: interface extraction over existing code, zero behavior change,
re-proven by a byte-identical fleet re-walk (cheap: today's walks are already deterministic).
Stage 2: planner seed enumeration + executor scheduling + attempt-unique artifact plumbing
(the retry feature already built the collision-safe multi-walk substrate). Stage 3: the vision
engine's own bake-off — separate eval arms, paid model spend, gated behind the deployment
no-go in docs/CODEX-CLAUDE-INTEGRATION-11AUG.md and docs/CANARY-DEPLOYMENT-INTEGRITY-11AUG.md.

**What it risks.** (1) Benchmark hard-anchoring: seeds hand-tuned to close s6/s3/s4
specifically would tune the walker to the fleet, which CLAUDE.md forbids — seeds must be
minted generically from the sealed model. (2) Evidence fabrication: seeded decisions enter
`select`/`text_entry` and therefore feed `requestedButNotOffered` and the exercised gate —
legitimate ONLY because they are sealed-document-derived (the existing typed-case rule).
(3) Metric collapse: `distinctSignatures` conflates same-presentation-different-history
screens; loop seeding makes that measurable for the first time (D2 below).

## The unified architecture

The two halves are one design at different altitudes:

| Codex's term (his §) | My layer | What exists today at `bbd5a92` |
|---|---|---|
| Observation engines (DOM/AX/graph, vision) | Perception | `RenderedScreen`/`ControlState` reader (browser/types.ts:341-412, :19-101); AX + screenshot paired per `ScreenCaptureEpoch` (:321-339); vision = epoch consumer only |
| One lease-fenced actuator | Action policy (in-driver) | `walkPath`/`applyDecision` — sole mutator; allocation filler (driver.ts:1654), survival hints (:1869-1900), variant fillers (:1379-1380, :2112-2134) |
| Engines propose, never execute | Planner stimulus | `PlannedDecision` channel; `stampSurvivalHints` (plan.ts:735), typed cases via `materializeCasePaths` (plan.ts:1163) |
| Executed-transition receipt | Observation contract | `PerformedAction` (types.ts:532-549) + `StepObservation` before/after screens (:581-646) + epochId binding |
| Coverage ledger from sealed obligations | Computed coverage as goal function | `assessExercised`/`isConstrainingDecision` gates + verdicts re-reading artifact bytes by pointer (execute-batch.ts) |
| Declared platform adapters | PageLike seam | `PageLike`/`ElementHandleLike` (driver.ts:92-111) — note: in driver.ts, NOT browser/types.ts |

The genuine differences, with recommendations:

**D1 — Lease-fenced single actuator vs in-driver action policy.** Real difference: Codex
separates perception from mutation ("engines never receive executable page handles"); today
the DOM reader and the actuator are one module — driver.ts both reads screens and clicks.
While exactly one process drives a session, a lease fence guards against nothing that can
happen; the split becomes load-bearing only when a second engine can propose actions (stage 3).
Recommendation: adopt the *rule* now for free (vision already never holds a page; keep it so),
express the actuator as an interface at stage 1, and implement lease/epoch fencing only at
stage 3. [DECISION] if the owner wants the fencing machinery earlier as doctrine-hardening.

**D2 — Occurrence-first store vs screen signatures.** Less different than it looks: occurrence
records already exist — `epochId` derives from runId/attemptId/pathId/stepIndex/slot/signature,
which IS session/sequence/history-keyed, and `screenSignatureHash` keeps the alias hypothesis
separate (types.ts:321-339). The collapse Codex forbids lives in the *metric*: the reach
table's `distinctSignatures` silently merges identical presentations reached through different
histories. Stage 2's loop iterations (s6 Q2 per brand) make this real — two loop passes with
identical rendering would count once. Recommendation: keep the store as-is; at stage 2 the
acceptance metric becomes obligations-witnessed from the coverage ledger (which both halves
already agree is the real denominator), with `distinctSignatures` retained as a diagnostic.
No graph-store rebuild: the graph spike verdict was "component, not architecture."

**D3 — Who owns retry/variant decisions in an engines-propose world.** Dissolved by naming two
retry classes. Codex's "no unsafe retries after an unknown effect" is an *in-session actuator
guard* (don't re-click when you can't tell what the click did). My pivot is an
*orchestrator-owned whole-walk re-plan*: durable `screenoutPivots` ordinal, fresh attemptId,
deterministic variant (execute-batch.ts:173-227; driver.ts WalkOptions.variant :128-143).
Complementary, not conflicting. Recommendation: both rules, stated at their own layer. Seeds
(stage 2) follow the same ownership: the planner mints them at plan time from the sealed
model; engines may *propose* seed-worthy targets as observations, never mint walks.

**D4 — Coverage ledger vs computed gates.** Same invariant, two idioms. Codex: deterministic
ledger minted from sealed obligations, linked to actuator receipts; engines attach evidence
but cannot mint coverage. Today: obligations are sealed at extraction, walks claim relevance
(`PathObservation.plannedWitnesses` — "a claim of relevance, not a result", types.ts:659-660), and
verdicts re-read artifact bytes. Recommendation: keep computed gates as the implementation and
adopt Codex's *ledger framing* as the stage-2 metric surface (obligations x witnessed-by
receipts). No new authority is created; the ONE RULE header (types.ts:1-17) already forbids
engines writing verdict fields.

**D5 — Eval arms vs the live-walk reach table.** These compose: the reach table (plus
false-positive and fail-loud gates) is the *metric*; Codex's arms (DOM/graph alone, vision
alone, integrated) are the *treatments*. One definitional gap: "vision alone" cannot mean a
vision walker (it cannot actuate); it must mean vision-only perception feeding the same action
policy. Recommendation: accept the three-arm design with that definition; integration accepted
only if the integrated arm improves obligation coverage on unfamiliar surveys without
violating the FP/fail-loud gates — Codex's own acceptance clause, adopted verbatim.

Codex's remaining clauses, accounted for: merge-by-semantic-identity with provenance-retaining
disagreement → stage-3 acceptance requirement (disagreement triggers a bounded probe or a
surfaced limitation, never an unreported guess); platform-shaped selectors as declared
adapters → today's `PageLike` + the `CONTROL_SELECTOR`/`LABEL_SELECTOR` order contracts
(worker-v2/src/browser/page-script.ts).

## The incremental path

**Stage 0 — today (`bbd5a92`).** Already contract-compatible in behavior: one mutator, plan
as the only stimulus channel, observation-only records, deterministic walks. Evidence: the
11 Aug re-measure — 12/12 genuine completions, zero variance across 2 full passes.

**Stage 1 — the navigator contract as interfaces over existing code. No behavior change.**
Name the roles in types: `Perception` (produces `RenderedScreen` + epochs), `Actuator`
(executes `PerformedAction`s, returns the receipt = action + before/after screens + epoch),
`Planner` (mints decisions/seeds/hints). Existing code implements them in place; `PageLike`
stays the platform adapter underneath. Acceptance (specified, run at implementation time —
each gate can fail): (a) full fleet re-walk byte-identical to stage 0 summaries (the
zero-variance result makes this a real diff, not a formality); (b) tsc + dispatcher suite +
all mutation harnesses still green/killed; (c) no new fields in any observation type.

**Stage 2 — multi-path decision seeding through the contract. Closes the measured gap.**
Generalize the existing typed-case machinery — route cases already mint one case per
enumerated answer (extract/expand.ts:884-898) and `materializeCasePaths` already turns cases
into sealed per-path decisions — into planner-minted *seed paths*: varied multiselect widths
over enumerated options, varied allocation splits, varied branch choices; executed as ordinary
paths (the retry work already made multi-walk artifacts collision-safe via attempt-unique
refs). Two seed sources with different readiness: **(a) seedable today** from the sealed
model — multiselect width k=1..n over enumerated options, corner allocation splits
(all-weight-on-one-dimension x N, threshold-blind); **(b) needs extraction** — numeric
branch thresholds, which `mineThresholds` (plan-core.js:960) does not mine (character/
selection/scale bounds only; confirmed by plan.ts:647 and execute-batch.ts:1009). Corner
splits likely hit s6's >=40 branch without knowing 40; mined thresholds would hit it by
construction. [DECISION — owner]: ship (a) first and measure, or fund the extraction work
first. Recommendation: (a) first — it is pure planner work, and the re-measure shows corner
coverage plus loop width addresses most of the 19 residual screens.
Acceptance (pinned, phase-2c style): s3-clean 10/14 → 14/14; s4 → 12/12 both; s6 both
13/19 → >=17/19 with source (a) alone (Q7 counted only if a corner split crosses the
threshold; report actual); no regression anywhere (s1 10/10 both, s2 union 13 both, s5
10 & 11); zero nondeterminism across 2 passes; invariant tests below green; residual
shortfalls REPORTED, not chased.

**Stage 3 — the vision engine joins behind the same contract, gated on its own bake-off.**
Vision implements `Perception` only: proposes observations (and, at most, candidate actions)
bound to epochs; never holds a `PageLike`; disagreement with DOM perception is recorded with
provenance and triggers a bounded probe, never an overwrite. Run Codex's three arms on
unfamiliar surveys (not this fleet — it is now a tuning set). Acceptance: integrated arm
improves obligation coverage vs DOM-alone with zero new false accusations and every failure
loud; provider-identity and spend controls per docs/CANARY-DEPLOYMENT-INTEGRITY-11AUG.md;
deployment remains blocked by the no-go conditions in docs/CODEX-CLAUDE-INTEGRATION-11AUG.md.

## Evidence invariants, per stage

- **Stimulus is INPUT, never EVIDENCE.** Stage 1: unchanged (interfaces only). Stage 2: seeds
  are *planned* stimulus — unlike hints they DO enter `select`/`text_entry`, feed
  `requestedButNotOffered` and the exercised gate, and that is legitimate iff every seeded
  label/value is minted from the sealed model (the typed-case rule). Enforcement: a seed test
  asserting no seed label exists outside `plan.model`'s enumerated options; hints keep never
  entering `select` (existing d46 proof). Stage 3: vision proposals are observations with
  provenance; a proposal that reaches an actuator becomes a receipt, never evidence by itself.
- **Verdict independence.** All stages: verdict consumers re-read artifact bytes by pointer;
  observation types carry no verdict fields (types.ts:1-17). Stage-3 addition: engine
  agreement may raise confidence but a verdict cites receipts, never engine consensus.
- **No coverage minting by engines.** Coverage moves only when a receipt witnesses a sealed
  obligation through the existing exercised gates. Perception output (DOM or vision) can
  attach evidence to an epoch; it cannot close a case. Test: a mutant that lets a perception
  field trip `isConstrainingDecision` must be killed.
- **Provenance survives.** Navigator-default fillers keep the `navigator-default:` detail
  prefix and `navigatorDefaultAnswerCount`; seeded answers carry plan/case provenance; pivot
  walks link attempts. A screened-out on invented answers stays a fact about the fillers.

## What NOT to do

- Do not pick a "winner" walker by inspection — Codex's opening rule; moot after the reframe,
  binding again at stage 3 (no discarding the vision engine without its arm's evidence).
- Do not hand-tune seeds to this fleet's six missing screens — mint generically from the
  sealed model; the fleet is the benchmark, not the spec (CLAUDE.md hard-anchoring rule).
- Do not retune `navigatorValueFor` constants to dodge screeners — d44 pins the midpoint,
  including the honest counterexample; the mutation suite kills it.
- Do not let hints/variants leak into `select` or any evidence channel (d46 proofs pin this).
- Do not hand vision a page handle, ever — epoch consumption is the contract.
- Do not bump `EXECUTION_PROGRAM_KIND` for additive fields (plan.ts documents the 5 Aug
  breakage); do not reshape epoch/slot/pairing or `observationRef` for existing walks.
- Do not silently collapse same-presentation-different-history occurrences when loops arrive —
  change the metric's denominator to obligations, not the store's identity.
- Do not deploy, and do not spend on vision, while the 11 Aug no-go stands.

## Open questions for Codex's review

1. Lease fencing when there is structurally one driver: is a stage-1 interface plus a stage-3
   fence acceptable, or do you want epoch/lease rejection machinery earlier — and against what
   failure that can actually occur before a second proposer exists?
2. Is `PerformedAction` + before/after screens + `ScreenCaptureEpoch` binding sufficient as
   your "executed-transition receipt", or does the receipt need its own signed shape?
3. Occurrence store: do the epochId derivation inputs meet your occurrence-first keying, or
   do you require an explicit history digest beyond (attemptId, pathId, stepIndex, slot)?
4. "Vision alone" arm: do you accept the definition "vision-only perception feeding the same
   action policy", given vision cannot actuate?
5. Seed minting: do you agree seeds are planner-minted at plan time from sealed obligations
   (engines propose targets as observations only), or do you want a runtime proposal channel?
6. Stage-2 seed source ordering: seedable-today corners/widths first vs numeric-threshold
   extraction first — your call to the owner's [DECISION] above?
7. The s2/s5 expected-number censoring (fleet manifests minted by a screened-out walker
   under-count): fix the denominators in the manifest, or score against the ledger only?
