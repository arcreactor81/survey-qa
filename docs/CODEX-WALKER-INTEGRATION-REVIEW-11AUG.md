# Codex peer review — walker integration proposal

**Reviewed:** `docs/WALKER-INTEGRATION-PROPOSAL.md` as present on 11 August 2026  
**Disposition:** architectural direction accepted; Stage 2 is blocked pending the four contract
repairs below. This review does not modify the proposal or authorize implementation.

## What is sound

The proposed reframe is the right one: there is one mutation-capable actuator, while DOM/AX and
vision are perception sources behind a common navigator contract. Vision does not need a second
walker. It should produce provenance-bound observations and candidate actions; only the actuator
may change the page. Interface extraction can therefore precede behavior changes, and a
vision-only evaluation arm can mean vision-only perception feeding the same action policy.

## Four blocking corrections before seeded paths can earn coverage

### 1. `plan.model` is not seed authority

`contractFromRevision` projects every sealed requirement status into the planner model. The
planner then mines option labels with prose regular expressions, chunk-local fallback, and—when
no stronger source exists—stimulus paraphrases. Consequently, “the label exists in `plan.model`”
would prove only that the planner previously inferred it; it would not prove that the document
asserted a selectable value.

A seed must cite an exact positive sealed payload: the typed case/option-set assertion, owning
question, requirement version, expansion certificate, and contract revision hash. Never grant
seed authority from `siblings`, heuristic-only labels, ambiguous or disputed requirements,
explicit negatives, document-silent values, or untyped prose. Withheld candidates and their
reasons must be counted.

### 2. Current path closure is not a per-case witness receipt

`assessExercised` requires a completed walk and, when the plan is constraining, only one matched
constraining decision. The executor then closes every case assigned to that path. That was a
reasonable tightening over attempt-based closure, but it cannot prove that a particular seeded
case was exercised.

Before seed walks can close cases, add an exact `CaseWitnessReceipt` relation:

`caseId -> seed certificate -> performed action -> before/after occurrence -> expected occurrence`

The join must be recomputed from retained evidence and deduplicate by `caseId`. Until this exists,
seeded walks are exploration only and close zero mandatory cases.

### 3. Multiple alternatives do not fit the current sealed program

The execution program enforces that assignments plus unassigned cases are an exact permutation
of sealed cases. Duplicating one case across several seed variants would either violate that seal
or inflate the denominator.

Choose one explicit representation:

- deterministically select one path per case after bounded set-cover scoring; or
- represent several paths as alternatives for one unchanged case and allow only the first valid
  `CaseWitnessReceipt` to close that case.

In either design, candidate count, selected count, dropped count, and residual obligations remain
visible.

### 4. Repeated occurrences are not distinguishable enough

The driver consumes a planned decision after its first question match, and the exercised join is
keyed by question. A loop that presents the same question under a different history can therefore
consume or satisfy the wrong obligation. `epochId` is a unique capture identifier because it
includes `screen.at`; it is not a stable history identity.

Keep three separate concepts:

- `occurrenceId`: stable identity of this question/control occurrence within a path history;
- `presentationHash`: what was visibly/semantically presented;
- `historyDigest`: the ordered, provenance-bound decisions/transitions that reached it.

Same-question visits under different histories must not satisfy each other.

## Safe generic seed policy

Generate candidates only from certified finite positive payloads. Start with a baseline,
one-factor variants, and bounded pairwise covering variants; never enumerate a Cartesian product
or every subset. Rank deterministically by marginal uncovered sealed obligations per estimated
action, using contract-derived identity rather than corpus order or question IDs.

Reasonable initial operational ceilings, to be validated rather than treated as specification:

- 256 generated candidates per run;
- 8 selected variants per question;
- 6 selected variants per base path;
- 32 added seed attempts per run;
- added estimated steps capped at `min(640, 2 * baseline floor steps)`.

All counters must persist before action. Exhaustion reports `seed-budget-exhausted` plus the full
candidate/selected/dropped census and residual obligations; it never produces a smaller green
denominator.

Certified multiselect widths are eligible once the authority and receipt fixes exist. Allocation
corners derived from the live site remain `navigator-exploration` because they are not sealed
document payloads and cannot prove a missing/incorrect option. Numeric thresholds should follow
as a typed extraction feature with exact source-span provenance, ambiguity refusal, and bounded
threshold-adjacent cases.

## Answers to the proposal's open questions

1. Interface extraction before lease machinery is acceptable while exactly one component can
   propose executable actions. Add fencing before a second proposer can affect action selection.
2. `PerformedAction` plus before/after evidence is useful raw material, but Stage 2 needs a typed,
   content-addressed transition receipt and the explicit case-witness join above. It can inherit
   authenticity from the signed run record; it need not become a separate signature oracle.
3. Require an explicit history digest and occurrence identity. The present epoch identifier is a
   unique observation id, not the required stable history key.
4. Accept “vision-only perception feeding the same action policy” as the vision-only arm.
5. Seeds are minted at plan time only from sealed positive payloads. Runtime engines may propose
   exploration targets, never authority or coverage.
6. Implement certified multiselect widths first. Keep allocation corners exploration-only, then
   add typed numeric-threshold extraction separately.
7. Score primarily against the sealed obligation/case ledger. Never repair an expected count from
   what a later walker happened to discover. An independent fixture manifest may define a public
   development denominator only when its provenance is explicit; otherwise report the old count
   as an observed lower bound and the total as unknown.

## Required fail-capable evidence

At minimum, negatives must cover: a rogue `plan.model` label; ambiguous/negative/untyped payloads;
seed-certificate tampering; same-question/different-history substitution; one action incorrectly
closing sibling cases; duplicate alternative closure; huge option sets; Cartesian-product
generation; invalid allocation bounds; and visible budget exhaustion. Acceptance should compare
equal-budget runs on preregistered unfamiliar surveys using exact case-receipt coverage, residual
pending/blocked/unreadable obligations, false-positive and ambiguity-guess deltas, and added
actions/time/evidence/cost—not exact target numbers from the tuning fleet.
